/**
 * refresh_subscriptions — Cordelia's nightly source-subscription refresh
 * (knowledge metabolism #2, 2026-06-10).
 *
 * Walks the subscription entries in Knowledge/Cordelia/sources.md (see
 * sources_store.ts), and for each DUE source (cadence elapsed since
 * last_crawled_at, never-crawled first):
 *
 *   1. Fetch via fetch_with_browser_fallback — Firecrawl first,
 *      the workstation browse_url escalation on bot-shaped failure (the
 *      the private dev log "try web_fetch_clean ONCE, escalate on the same URL"
 *      rule, implemented programmatically).
 *   2. Hash-diff (sha256 of normalized markdown) against
 *      last_content_hash — unchanged content costs nothing.
 *   3. Changed/new content shelves onto the OWNING specialist's library
 *      via save_library_item (the only path that chunks into chunks_fts
 *      + embeds — bare upsert_note does NOT index), quality gate 'full',
 *      trust_tier from the subscription record (falling back to the
 *      target's trusted_sources manifest), shelf-wide visibility
 *      (subscriptions are owner-approved public reference material).
 *
 * Designed to run as a background job (config/specialists/cordelia.yaml
 * `nightly_source_refresh`, 03:40 — before her 04:00 deliberation so the
 * pass sees fresh shelves). Caps at ≤10 sources per run; the due-order
 * (most starved first) makes the cap fair across nights. Idempotent: a
 * re-run hash-matches and shelves nothing.
 *
 * Kill switch: HEARTH_SOURCE_REFRESH=0 disables (returns enabled:false,
 * touches nothing). Every per-source outcome is audited
 * (tool_name='source_refresh'); failures carry a `next_action` recovery
 * hint per the connector affordance pattern.
 */
import { z } from 'zod';
import type { Tool, ToolContext } from '@core/tool';
import type { ToolDeps } from '@core/tool_deps';
import type { SpecialistRegistry } from '@core/specialist';
import { resolve_trust_tier } from '@core/specialist';
import type { UserRegistry } from '@core/users';
import { ulid } from 'ulid';
import type { Database } from 'bun:sqlite';
import { fetch_with_browser_fallback } from '@connectors/fetch_with_browser_fallback';
import { save_library_item, type LibraryRoutesDeps } from '@app/routes/library';
import {
  items_digest_markdown,
  items_hash,
  looks_like_feed,
  parse_feed,
  type FeedItem,
} from '@core/feed_parse';
import {
  SOURCES_PATH,
  content_hash,
  is_subscription,
  read_sources,
  subscriptions_due,
  write_sources,
  type TrustedSourceEntry,
} from '../sources_store';

const InputSchema = z.object({
  max_sources: z
    .number()
    .int()
    .min(1)
    .max(10)
    .default(10)
    .describe(
      'Per-run cap on NON-daily sources refreshed. Hard max 10 — the nightly ' +
        'reference budget. Daily-cadence subscriptions draw from max_daily instead.',
    ),
  max_daily: z
    .number()
    .int()
    .min(1)
    .max(40)
    .default(8)
    .describe(
      'Separate per-run cap for DAILY-cadence subscriptions (news feeds). ' +
        'A separate pool so a news rack cannot starve the reference racks.',
    ),
  force: z
    .boolean()
    .default(false)
    .describe(
      'Refresh ALL subscriptions regardless of cadence due-ness (still ' +
        'capped by max_sources/max_daily, still hash-diffed). For catch-up runs.',
    ),
});

const RefreshedSchema = z.object({
  url: z.string(),
  specialist_id: z.string(),
  wrapper_note_path: z.string(),
  title: z.string(),
  trust_tier: z.union([z.literal(1), z.literal(2)]).nullable(),
  /** Set when the source parsed as an RSS/Atom feed: how many NEW
   *  stories landed in news_items this fetch. */
  feed_items_added: z.number().optional(),
});

const UnchangedSchema = z.object({
  url: z.string(),
  specialist_id: z.string(),
});

const FailedSchema = z.object({
  url: z.string(),
  specialist_id: z.string(),
  error: z.string(),
  /** Recovery hint (connector affordance pattern) — the concrete next move. */
  next_action: z.string(),
});

const OutputSchema = z.object({
  enabled: z.boolean(),
  checked: z.number(),
  refreshed: z.array(RefreshedSchema),
  unchanged: z.array(UnchangedSchema),
  failed: z.array(FailedSchema),
  /** Due subscriptions left unserviced by the cap — they lead tomorrow's run. */
  due_remaining: z.number(),
  skipped_reason: z.string().optional(),
});

type Input = z.infer<typeof InputSchema>;
type Output = z.infer<typeof OutputSchema>;

export interface RefreshSubscriptionsDeps {
  specialists: SpecialistRegistry;
  library_deps: LibraryRoutesDeps;
  users?: UserRegistry;
  /** Smoke seam — defaults to the real Firecrawl→browser fetch. */
  fetch_fn?: typeof fetch_with_browser_fallback;
  /** Smoke seam — raw text fetch for the feed-parse fast path.
   *  Defaults to native fetch; null = unreachable/not-text. */
  raw_fetch_fn?: (url: string) => Promise<string | null>;
}

function refresh_enabled(): boolean {
  return process.env.HEARTH_SOURCE_REFRESH !== '0';
}

/**
 * Plain text fetch for the feed fast path. Feeds don't need Firecrawl's
 * extraction (it mangles XML); a direct GET is faster and exact. Null on
 * any failure — the caller falls back to the normal fetch path.
 */
async function default_raw_fetch(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(15_000),
      headers: {
        'user-agent': 'hearth-refresh/1.0 (+household library)',
        accept:
          'application/rss+xml, application/atom+xml, application/xml, text/xml, text/html;q=0.8, */*;q=0.5',
      },
    });
    if (!res.ok) return null;
    const text = await res.text();
    return text.length > 0 && text.length < 3_000_000 ? text : null;
  } catch {
    return null;
  }
}

/** INSERT OR IGNORE each story; returns how many were actually new. */
function insert_news_items(
  db: Database,
  sub: TrustedSourceEntry & { specialist_id: string },
  items: FeedItem[],
  fetched_at_iso: string,
): number {
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO news_items
       (id, link, title, description, source_url, source_domain,
        specialist_id, category, published_at, fetched_at)
     VALUES (@id, @link, @title, @desc, @src, @dom, @spec, @cat, @pub, @fetched)`,
  );
  let added = 0;
  for (const it of items) {
    const r = stmt.run({
      '@id': `n_${ulid().toLowerCase()}`,
      '@link': it.link,
      '@title': it.title,
      '@desc': it.description,
      '@src': sub.url,
      '@dom': sub.domain,
      '@spec': sub.specialist_id,
      '@cat': sub.category ?? null,
      '@pub': it.published_at,
      '@fetched': fetched_at_iso,
    });
    if (r.changes > 0) added++;
  }
  return added;
}

export function make_refresh_subscriptions(
  deps: RefreshSubscriptionsDeps,
): Tool<Input, Output> {
  const fetch_fn = deps.fetch_fn ?? fetch_with_browser_fallback;
  return {
    name: 'refresh_subscriptions',
    description:
      'Refresh the DUE source subscriptions from your curated list: fetch each subscribed URL, hash-diff against the last crawl, and shelve new/changed content onto the owning specialist\'s library with trust_tier provenance. Runs nightly as your background job — call it manually only for a catch-up (e.g. {force: true} after adding several subscriptions). Capped at 10 sources per run; unchanged content shelves nothing.',
    risk: 'write_internal',
    required_capabilities: ['write_vault_any_library'],
    input_schema: InputSchema,
    output_schema: OutputSchema,
    // Result depends on store + remote state the run itself mutates — a
    // repeat call must re-run, not re-serve the per-turn duplicate cache.
    volatile: true,

    idempotency_key(input) {
      return `refresh_subscriptions:${input.max_sources}:${input.force ? 'force' : 'due'}`;
    },

    async execute(input, ctx: ToolContext): Promise<Output> {
      const memory = deps.library_deps.memory;
      const raw_fetch_fn = deps.raw_fetch_fn ?? default_raw_fetch;
      if (!refresh_enabled()) {
        return {
          enabled: false,
          checked: 0,
          refreshed: [],
          unchanged: [],
          failed: [],
          due_remaining: 0,
          skipped_reason: 'HEARTH_SOURCE_REFRESH=0 — refresh disabled by kill switch',
        };
      }

      const now = ctx.now ?? new Date();
      const entries = read_sources(memory);
      const due_now = subscriptions_due(entries, now);
      // force: due subscriptions first (most starved leads), then the rest.
      const due = input.force
        ? due_now.concat(
            entries.filter(is_subscription).filter((e) => !due_now.includes(e)),
          )
        : due_now;

      // Two budget pools: daily-cadence (news feeds) and everything else,
      // so a news rack can't starve the reference racks or vice versa.
      const daily_due = due.filter((e) => e.cadence === 'daily');
      const rest_due = due.filter((e) => e.cadence !== 'daily');
      const batch = [
        ...daily_due.slice(0, input.max_daily),
        ...rest_due.slice(0, input.max_sources),
      ];
      const refreshed: z.infer<typeof RefreshedSchema>[] = [];
      const unchanged: z.infer<typeof UnchangedSchema>[] = [];
      const failed: z.infer<typeof FailedSchema>[] = [];
      const agent = ctx.specialist_id ?? 'cordelia';
      const tz = deps.users?.get_timezone(ctx.user?.id ?? null);

      for (const sub of batch) {
        const audit = (
          execution_result: Record<string, unknown> | undefined,
          error?: string,
        ): void => {
          memory.log_action({
            intent_id: ctx.intent_id,
            agent,
            tool_name: 'source_refresh',
            tool_input: {
              url: sub.url,
              specialist_id: sub.specialist_id,
              cadence: sub.cadence,
            },
            execution_result,
            error,
            user_id: ctx.user?.id,
          });
        };

        const target = deps.specialists.get(sub.specialist_id);
        if (!target) {
          const error = `unknown specialist "${sub.specialist_id}"`;
          failed.push({
            url: sub.url,
            specialist_id: sub.specialist_id,
            error,
            next_action:
              `Fix or remove this subscription entry in ${SOURCES_PATH} — ` +
              `its specialist_id does not match any config/specialists/*.yaml id.`,
          });
          audit(undefined, error);
          continue;
        }

        // Feed fast path (News Desk, 2026-06-10): a direct GET that
        // parses as RSS/Atom skips Firecrawl entirely — discrete stories
        // land in news_items and the shelf gets a clean markdown digest
        // (the parsed items ARE the content verification, so the gate is
        // skipped; an unparseable response falls through to the normal
        // page path below). Browser-first subs never take this path.
        if (sub.fetch_via !== 'browser') {
          const raw = await raw_fetch_fn(sub.url);
          const parsed = raw && looks_like_feed(raw) ? parse_feed(raw) : null;
          if (parsed) {
            const hash = items_hash(parsed.items);
            sub.last_crawled_at = now.toISOString();
            if (hash === sub.last_content_hash) {
              unchanged.push({ url: sub.url, specialist_id: sub.specialist_id });
              audit({ outcome: 'unchanged', feed: true, hash_prefix: hash.slice(0, 12) });
              continue;
            }
            const added = insert_news_items(
              deps.library_deps.db,
              sub,
              parsed.items,
              now.toISOString(),
            );
            const digest = items_digest_markdown(
              parsed.feed_title,
              sub.url,
              parsed.items,
              now.toISOString(),
            );
            const tier = sub.tier ?? resolve_trust_tier(sub.url, target);
            const saved = await save_library_item(
              deps.library_deps,
              { filename: sub.url, mime_type: 'text/markdown', text: digest },
              target,
              {
                source: 'url',
                source_url: sub.url,
                tz,
                trust_tier_override: tier,
                quality_gate: 'off', // parsed items prove real content
                private_to: null,
              },
            );
            sub.last_content_hash = hash;
            if ('rejected' in saved) {
              // 'off' never rejects today; guard for completeness.
              failed.push({
                url: sub.url,
                specialist_id: sub.specialist_id,
                error: `digest shelve rejected: ${saved.reason}`,
                next_action: 'Inspect the feed digest composer — this should be unreachable.',
              });
              audit({ outcome: 'rejected', feed: true }, 'digest shelve rejected');
              continue;
            }
            refreshed.push({
              url: sub.url,
              specialist_id: sub.specialist_id,
              wrapper_note_path: saved.wrapper_note_path,
              title: saved.title,
              trust_tier: tier,
              feed_items_added: added,
            });
            audit({
              outcome: 'shelved',
              feed: true,
              feed_items: parsed.items.length,
              feed_items_added: added,
              wrapper_note_path: saved.wrapper_note_path,
              hash_prefix: hash.slice(0, 12),
            });
            continue;
          }
        }

        const outcome = await fetch_fn(sub.url, ctx, {
          title_fallback: sub.description ?? sub.domain,
          // Login-gated / paywalled subscriptions go straight to the
          // signed-in the workstation profile — Firecrawl would only ever see
          // the logged-out shell.
          browser_first: sub.fetch_via === 'browser',
        });
        if (outcome.kind === 'deferred' || outcome.kind === 'failed') {
          const error = `${outcome.kind}: ${outcome.reason}`;
          failed.push({
            url: sub.url,
            specialist_id: sub.specialist_id,
            error,
            next_action:
              outcome.kind === 'deferred'
                ? 'Browser host unavailable — the source stays due and tomorrow\'s run retries it.'
                : 'Verify the URL still resolves; if the source moved or died, scout_sources can find a replacement and the entry can be removed from ' +
                  SOURCES_PATH + '.',
          });
          audit(undefined, error);
          continue; // last_crawled_at untouched — stays due for the next run
        }

        const hash = content_hash(outcome.markdown);
        sub.last_crawled_at = now.toISOString();
        if (hash === sub.last_content_hash) {
          unchanged.push({ url: sub.url, specialist_id: sub.specialist_id });
          audit({ outcome: 'unchanged', hash_prefix: hash.slice(0, 12) });
          continue;
        }

        const tier = sub.tier ?? resolve_trust_tier(sub.url, target);
        const saved = await save_library_item(
          deps.library_deps,
          { filename: sub.url, mime_type: 'text/markdown', text: outcome.markdown },
          target,
          {
            source: 'url',
            source_url: sub.url,
            tz,
            trust_tier_override: tier,
            quality_gate: 'full',
            // Subscriptions are owner-approved public reference material —
            // shelf-wide, never personal to anyone.
            private_to: null,
          },
        );
        // Record the hash either way: a quality-gate rejection of THIS
        // content shouldn't be re-attempted nightly — the next shelve
        // attempt happens when the content actually changes.
        sub.last_content_hash = hash;
        if ('rejected' in saved) {
          const error = `quality gate (${saved.content_type}): ${saved.reason}`;
          failed.push({
            url: sub.url,
            specialist_id: sub.specialist_id,
            error,
            next_action:
              'The subscribed page is a shell (nav/index/thin) — point the ' +
              'subscription at a content page instead, or remove it from ' +
              SOURCES_PATH + '.',
          });
          audit({ outcome: 'rejected', content_type: saved.content_type }, error);
          continue;
        }
        refreshed.push({
          url: sub.url,
          specialist_id: sub.specialist_id,
          wrapper_note_path: saved.wrapper_note_path,
          title: saved.title,
          trust_tier: tier,
        });
        audit({
          outcome: 'shelved',
          wrapper_note_path: saved.wrapper_note_path,
          trust_tier: tier,
          hash_prefix: hash.slice(0, 12),
        });
      }

      // One frontmatter write for the whole pass — `batch` items are
      // references into `entries`, so their mutated crawl state persists.
      if (batch.length > 0) write_sources(memory, entries);

      return {
        enabled: true,
        checked: batch.length,
        refreshed,
        unchanged,
        failed,
        due_remaining: Math.max(0, due.length - batch.length),
      };
    },
  };
}

export function create(deps: ToolDeps): Tool {
  return make_refresh_subscriptions({
    specialists: deps.specialists,
    library_deps: {
      db: deps.db,
      vault_root: deps.vault_root,
      memory: deps.memory,
      specialists: deps.specialists,
      runtime: deps.runtime,
      conversations: deps.conversations,
      llm: deps.llm,
      embedder: deps.embedder,
      events: deps.events,
    },
    users: deps.users,
  }) as Tool;
}
