/**
 * curate_for_specialist — Cordelia's structured knowledge-curation tool
 * (Slice B — 2026-05-30).
 *
 * The acquisition counterpart to `ingest_to_library`: rather than the
 * caller naming a specific URL, the caller names a *target specialist*
 * + a list of *focus areas* + a per-turn `max_sources` budget, and the
 * tool drives the whole pipeline:
 *
 *   1. Read the target specialist's `trusted_sources` manifest
 *      (Tier 1 = auto-ingest, Tier 2 = ingest-with-attribution) and
 *      their `knowledge_scope` (so curated content lands on the right
 *      shelf).
 *   2. For each focus area: compose a web search query, scoped to
 *      Tier 1 domains via OR-joined `site:` operators. SearXNG
 *      returns candidate URLs.
 *   3. Classify each candidate URL via `resolve_trust_tier`:
 *      - Tier 1 / Tier 2 → `web_fetch_clean` it, then
 *        `save_library_item` with the tier stamped into frontmatter
 *      - Unlisted → judge the result's actual relevance to the focus
 *        area (cheap planner-role LLM verdict on title + snippet —
 *        SearXNG's keyword ranking alone can surface collisions), and
 *        only then file a `trusted_source_addition` proposal for
 *        Jasper's review (the Tier-3 propose-and-approve gate).
 *        One per domain per pass — Cordelia doesn't spam the queue
 *        when SearXNG returns five pages from the same blog. An
 *        unavailable judge proposes nothing: the failure mode the
 *        gate exists to stop is junk proposals, so it fails closed.
 *   4. Append a one-line audit entry to
 *      `Knowledge/<Target>/library/_curation_log.md` so the next
 *      curate pass can read what already shipped.
 *
 * Gated to Cordelia via `write_vault_any_library` (same capability
 * `ingest_to_library` uses) — every other specialist tends their own
 * shelf via the UI; cross-specialist curation routes through her.
 *
 * The tool is callable from chat ("Cordelia, give Astrid better
 * sources on Zone 2") or from her 04:00 deliberation script
 * (sweeping for shelves with weak coverage relative to the user's
 * goals).
 */
import { z } from 'zod';
import type { Tool, ToolContext } from '@core/tool';
import type { ToolDeps } from '@core/tool_deps';
import type { LLMRouter } from '@core/llm';
import type { SpecialistRegistry, LoadedSpecialist } from '@core/specialist';
import { resolve_trust_tier } from '@core/specialist';
import type { ProposalsStore } from '@core/proposals';
import type { UserRegistry } from '@core/users';
import { web_search } from './searxng';
import { fetch_with_browser_fallback } from './fetch_with_browser_fallback';
import { save_library_item, type LibraryRoutesDeps } from '@app/routes/library';
import { denied_domains_for } from '@specialists/cordelia/sources_store';

const InputSchema = z.object({
  target_specialist_id: z.string().min(1).describe(
    "The specialist whose library you're enriching. Lowercase id ('astrid', 'eleanor', 'kristi').",
  ),
  focus_areas: z
    .array(z.string().min(3).max(180))
    .min(1)
    .max(8)
    .describe(
      'Topic prompts you want sources on. Each becomes one search query, ' +
        'scoped to the specialist\'s Tier 1 trusted domains via site: operators. ' +
        'Phrase as the user would ("Zone 2 endurance training for adults", ' +
        '"core stability for sedentary desk workers"), not a search-string ' +
        '("zone-2-training how-to").',
    ),
  max_sources_per_area: z
    .number()
    .int()
    .positive()
    .max(5)
    .default(2)
    .describe(
      'Per focus area, how many top trusted-domain candidates to actually ' +
        'fetch + ingest. Default 2 keeps a curate pass under 16 fetches.',
    ),
  dry_run: z
    .boolean()
    .default(false)
    .describe(
      "When true: classify candidates and report what WOULD happen, but " +
        "don't fetch, don't ingest, don't propose. Useful for previewing " +
        'a curate pass before committing.',
    ),
});

const IngestedRecordSchema = z.object({
  focus_area: z.string(),
  url: z.string(),
  trust_tier: z.union([z.literal(1), z.literal(2)]),
  wrapper_note_path: z.string(),
  title: z.string(),
});

const ProposedRecordSchema = z.object({
  focus_area: z.string(),
  url: z.string(),
  domain: z.string(),
  suggested_tier: z.union([z.literal(1), z.literal(2)]),
  proposal_id: z.string(),
});

const SkippedRecordSchema = z.object({
  focus_area: z.string(),
  url: z.string(),
  reason: z.string(),
});

const OutputSchema = z.object({
  target_specialist_id: z.string(),
  ingested: z.array(IngestedRecordSchema),
  proposed: z.array(ProposedRecordSchema),
  skipped: z.array(SkippedRecordSchema),
  curation_log_path: z.string().nullable(),
  dry_run: z.boolean(),
});

type Input = z.infer<typeof InputSchema>;
type Output = z.infer<typeof OutputSchema>;

export interface CurateForSpecialistDeps {
  specialists: SpecialistRegistry;
  proposals: ProposalsStore;
  library_deps: LibraryRoutesDeps;
  users?: UserRegistry;
  /** Test seam (smoke-curate-relevance) — defaults to the live SearXNG tool. */
  search_fn?: typeof web_search.execute;
  /** Test seam — defaults to the live Firecrawl → browser pipeline. */
  fetch_fn?: typeof fetch_with_browser_fallback;
}

/**
 * Build a SearXNG query string scoped to Tier 1 trusted domains.
 * SearXNG's underlying engines mostly honor the Google-style
 * `(site:a OR site:b OR …)` operator. We OR up to ~10 to keep the
 * query length reasonable.
 */
function build_query(focus_area: string, tier_1: readonly string[]): string {
  if (tier_1.length === 0) return focus_area;
  const sites = tier_1
    .slice(0, 10)
    .map((d) => `site:${d}`)
    .join(' OR ');
  return `${focus_area} (${sites})`;
}

function host_of(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

const RELEVANCE_JUDGE_SYSTEM =
  'You judge whether a single web search result is actually ABOUT a research ' +
  'focus area. The result surfaced via keyword ranking, so it can rank purely ' +
  'on an incidental word collision ("Bleecker Street Media Movies" ranking ' +
  'against "Street Media Group revenue reporting"). Judge the substance: would ' +
  'a person researching the focus area consider this page on-topic? Reply with ' +
  'ONLY a JSON object, nothing else: {"relevant": <bool>, "reason": "<short>"}';

const RelevanceVerdictSchema = z.object({
  relevant: z.boolean(),
  reason: z.string().default(''),
});
type RelevanceVerdict = z.infer<typeof RelevanceVerdictSchema>;

function strip_fence(s: string): string {
  const m = s.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
  return (m ? m[1]! : s).trim();
}

/**
 * Cheap per-result relevance verdict on (focus area, title, snippet) —
 * the gate between "SearXNG returned this off-manifest page" and "file a
 * trusted_source_addition". Planner role (fast tier), same idiom as the
 * scout_sources judge. Returns null when the judge is unavailable or its
 * reply doesn't parse — callers treat null as "do not propose".
 */
async function judge_offmanifest_relevance(
  llm: LLMRouter | undefined,
  target: LoadedSpecialist,
  focus_area: string,
  hit: { url: string; title: string; snippet: string },
): Promise<RelevanceVerdict | null> {
  if (!llm) return null;
  let role;
  try {
    role = llm.for_role('planner');
  } catch {
    return null;
  }
  let resp;
  try {
    resp = await role.provider.complete({
      messages: [
        { role: 'system', content: RELEVANCE_JUDGE_SYSTEM },
        {
          role: 'user',
          content:
            `Focus area: ${focus_area}\n` +
            `Curating for specialist: ${target.name} — ${target.role}\n\n` +
            'Search result:\n' +
            `  title: ${hit.title}\n` +
            `  url: ${hit.url}\n` +
            `  snippet: ${hit.snippet || '(none)'}\n\n` +
            'Reply with ONLY the JSON object.',
        },
      ],
      temperature: 0.1,
      max_tokens: 200,
      ...role.defaults,
      // Forced AFTER the defaults spread — the reply is JSON.parse()d, and a
      // hybrid-thinking checkpoint with think ON exhausts max_tokens into
      // `reasoning_content`, leaving `content` empty (see llm.ts).
      think: false,
    });
  } catch {
    return null;
  }
  try {
    const parsed = RelevanceVerdictSchema.safeParse(
      JSON.parse(strip_fence(resp.content)),
    );
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function make_curate_for_specialist(
  deps: CurateForSpecialistDeps,
): Tool<Input, Output> {
  const search_fn = deps.search_fn ?? web_search.execute.bind(web_search);
  const fetch_fn = deps.fetch_fn ?? fetch_with_browser_fallback;
  return {
    name: 'curate_for_specialist',
    description:
      "Enrich another specialist's library shelf with evidence-backed sources from their `trusted_sources` manifest. Give me a `target_specialist_id` and `focus_areas` (e.g. ['Zone 2 endurance training for adults', 'core stability for sedentary desk workers']) and I'll search for high-quality pages on the target's Tier 1 domains, fetch + ingest the top results with `trust_tier` provenance stamped into frontmatter, and file `trusted_source_addition` proposals for any high-quality candidates from domains not in their manifest yet (each candidate is LLM-judged for actual relevance to the focus area first; if the judge is unavailable nothing is proposed). Use this when chat or deliberation surfaces 'specialist X has weak coverage on Y'; for one-off URL ingest, use `ingest_to_library` instead.",
    risk: 'write_internal',
    required_capabilities: ['write_vault_any_library'],
    input_schema: InputSchema,
    output_schema: OutputSchema,

    idempotency_key(input) {
      const sig = `${input.target_specialist_id}:${input.focus_areas.join('|')}:${input.max_sources_per_area}:${input.dry_run ? 'dry' : 'live'}`;
      return `curate:${sig.slice(0, 200)}`;
    },

    async execute(input, ctx: ToolContext): Promise<Output> {
      const target = deps.specialists.get(input.target_specialist_id);
      if (!target) {
        throw new Error(
          `curate_for_specialist: unknown target_specialist_id "${input.target_specialist_id}"`,
        );
      }
      const ingested: z.infer<typeof IngestedRecordSchema>[] = [];
      const proposed: z.infer<typeof ProposedRecordSchema>[] = [];
      const skipped: z.infer<typeof SkippedRecordSchema>[] = [];

      const tier_1 = target.trusted_sources.tier_1 ?? [];

      // De-dup tracking across focus areas so the same domain doesn't
      // get proposed multiple times in a single pass.
      const proposed_domains = new Set<string>();
      const seen_urls = new Set<string>();
      // Relevance verdicts cached per (focus area, host) — SearXNG often
      // returns several pages from one host for one query, and the
      // proposal is domain-level anyway; one verdict covers them all.
      // `null` (judge unavailable / unparseable) is cached too.
      const relevance_cache = new Map<string, RelevanceVerdict | null>();
      // Domains Jasper already DENIED for this target (the reject path of
      // the trusted_source_addition resolver) — never re-propose them
      // (2026-06-10; the queue's dedup only covers OPEN proposals).
      const denied = denied_domains_for(deps.library_deps.memory, target.id);

      for (const area of input.focus_areas) {
        const query = build_query(area, tier_1);
        const search_resp = await search_fn(
          { query, max_results: 15 },
          ctx,
        );
        if (search_resp.error) {
          skipped.push({
            focus_area: area,
            url: '',
            reason: `web_search failed: ${search_resp.error}`,
          });
          continue;
        }

        // Quality gate: only trust an off-manifest candidate when the
        // search returned at least one IN-manifest (Tier 1/2) hit for
        // this query — that's the evidence SearXNG actually honored the
        // `site:` scope. When the Tier-1 domains have no coverage of the
        // focus area, SearXNG silently drops the site: filter and returns
        // generic open web; auto-proposing those domains is how junk
        // (youtube, reddit, q&a farms) lands in the proposal queue. No
        // in-manifest hit ⇒ the site: scope was not honored ⇒ propose
        // nothing for this area.
        const scope_held = search_resp.results.some(
          (h) => resolve_trust_tier(h.url, target) !== null,
        );

        let consumed_for_area = 0;
        for (const hit of search_resp.results) {
          if (consumed_for_area >= input.max_sources_per_area) break;
          if (seen_urls.has(hit.url)) continue;
          seen_urls.add(hit.url);

          const tier = resolve_trust_tier(hit.url, target);
          const host = host_of(hit.url);

          if (tier === null) {
            // Unlisted candidate. Only propose when the `site:` scope held
            // for this query (see scope_held) — otherwise this is an
            // open-web result SearXNG returned after dropping the filter,
            // not a trusted-domain peer worth whitelisting.
            if (!scope_held) {
              skipped.push({
                focus_area: area,
                url: hit.url,
                reason:
                  'site: scope not honored (no in-manifest hits this query) — ' +
                  'open-web result, not auto-proposed as a trusted source',
              });
              continue;
            }
            // Unlisted candidate — propose at most one per domain per pass.
            if (!host || proposed_domains.has(host)) {
              skipped.push({
                focus_area: area,
                url: hit.url,
                reason: host
                  ? `host ${host} already proposed earlier this pass`
                  : 'unparseable URL',
              });
              continue;
            }
            if (denied.has(host.replace(/^www\./, ''))) {
              skipped.push({
                focus_area: area,
                url: hit.url,
                reason: `domain previously denied for ${target.id} — not re-proposed`,
              });
              continue;
            }
            // Per-result relevance gate (2026-08-10). `scope_held` is
            // per-QUERY — it proves SearXNG honored the site: filter for
            // at least one result, not that THIS result is on-topic.
            // SearXNG's engine ranking is keyword-based (not an LLM): an
            // off-manifest page can surface on an incidental keyword
            // collision (www.ign.com's "Bleecker Street Media Movies"
            // ranked against "Street Media Group the clinic revenue reporting").
            // So judge each candidate's actual relevance to the focus
            // area before proposing. An unavailable judge proposes
            // nothing — the failure mode this gate exists to stop is
            // junk proposals, so it fails closed.
            const cache_key = `${area}\u0000${host}`;
            let verdict = relevance_cache.get(cache_key);
            if (verdict === undefined) {
              verdict = await judge_offmanifest_relevance(
                deps.library_deps.llm,
                target,
                area,
                hit,
              );
              relevance_cache.set(cache_key, verdict);
            }
            if (verdict === null) {
              skipped.push({
                focus_area: area,
                url: hit.url,
                reason:
                  'relevance judge unavailable — off-manifest candidate not auto-proposed',
              });
              continue;
            }
            if (!verdict.relevant) {
              skipped.push({
                focus_area: area,
                url: hit.url,
                reason:
                  `judged not relevant to "${area}"` +
                  (verdict.reason ? ` (${verdict.reason})` : '') +
                  ' — not proposed',
              });
              continue;
            }
            // The site: scope held for the query AND the judge confirmed
            // this result is on-topic for the focus area. Cordelia's
            // judgment: trust the host enough to suggest Tier 2 (the
            // safer default — reviewer can swap to Tier 1).
            if (input.dry_run) {
              skipped.push({
                focus_area: area,
                url: hit.url,
                reason:
                  `dry_run: would propose ${host} for Tier 2` +
                  (verdict.reason ? ` (judge: ${verdict.reason})` : ''),
              });
            } else {
              const proposal_id = deps.proposals.create({
                specialist_id: 'cordelia',
                kind: 'trusted_source_addition',
                rationale:
                  `Found a candidate source on **${host}** that surfaced ` +
                  `against the focus area "${area}" and passed the relevance ` +
                  `check${verdict.reason ? ` (${verdict.reason})` : ''}, but ` +
                  `isn't yet in ${target.name}'s \`trusted_sources\`. Result ` +
                  `title: "${hit.title}". Snippet: ${hit.snippet || '(none)'}.\n\n` +
                  `Proposing Tier 2 (with attribution) as the safer default. ` +
                  `If you trust the source as peer-reviewed / professional-body ` +
                  `grade, use **Add at other tier** to promote to Tier 1.`,
                payload: {
                  target_specialist_id: target.id,
                  domain: host,
                  tier: 2,
                  candidate_url: hit.url,
                  candidate_title: hit.title,
                  justification:
                    `Matched focus area "${area}" via SearXNG; ` +
                    `relevance-judged on title + snippet` +
                    (verdict.reason ? `: ${verdict.reason}` : '.'),
                },
                execution_kind: 'composite', // decide-time resolver patches the YAML + subscribes
                // Anchor on (target specialist + domain) so re-proposing the
                // same source for the same specialist collapses via the
                // existing supersession path instead of stacking duplicates.
                signature: {
                  specialist_id: 'cordelia',
                  kind: 'trusted_source_addition',
                  category: 'knowledge_curation',
                  anchor: `${target.id}:${host}`,
                },
              });
              proposed_domains.add(host);
              proposed.push({
                focus_area: area,
                url: hit.url,
                domain: host,
                suggested_tier: 2,
                proposal_id,
              });
            }
            continue;
          }

          // Tier 1 or 2 — fetch + ingest.
          if (input.dry_run) {
            skipped.push({
              focus_area: area,
              url: hit.url,
              reason: `dry_run: would ingest at Tier ${tier}`,
            });
            consumed_for_area++;
            continue;
          }
          // Firecrawl first; the workstation browse_url on bot-shaped failure
          // (Mayo, Cleveland, Harvard Health, etc.). Plain network
          // errors don't retry — the browser wouldn't help.
          const outcome = await fetch_fn(hit.url, ctx, {
            title_fallback: hit.title,
          });
          if (outcome.kind === 'deferred') {
            skipped.push({
              focus_area: area,
              url: hit.url,
              reason: `browser deferred: ${outcome.reason}`,
            });
            continue;
          }
          if (outcome.kind === 'failed') {
            skipped.push({
              focus_area: area,
              url: hit.url,
              reason: outcome.reason,
            });
            continue;
          }
          const tz = deps.users?.get_timezone(ctx.user?.id ?? null);
          const saved = await save_library_item(
            deps.library_deps,
            outcome.kind === 'firecrawl'
              ? { filename: hit.url, mime_type: 'text/url', url: hit.url }
              : { filename: hit.url, mime_type: 'text/markdown', text: outcome.markdown },
            target,
            {
              source: 'url',
              source_url: hit.url,
              tz,
              trust_tier_override: tier,
              // Curation enriches a specialist's shelf with public
              // reference material — shelf-wide, NOT personal to anyone.
              private_to: null,
            },
          );
          // Quality gate (#2b): a shell (nav-chrome / interstitial /
          // paywall / thin) is rejected before it lands on the shelf.
          // Don't count it against the per-area budget — try the next
          // candidate instead.
          if ('rejected' in saved) {
            skipped.push({
              focus_area: area,
              url: hit.url,
              reason:
                `quality gate (${saved.content_type}): ${saved.reason}` +
                (saved.follow_url ? ` — real file: ${saved.follow_url}` : ''),
            });
            continue;
          }
          ingested.push({
            focus_area: area,
            url: hit.url,
            trust_tier: tier,
            wrapper_note_path: saved.wrapper_note_path,
            title: saved.title,
          });
          consumed_for_area++;
        }
      }

      // Append a curation log entry — one line per ingest + one for the
      // pass summary. Lets the next curate pass see what already
      // shipped and avoid re-ingesting the same URL.
      let curation_log_path: string | null = null;
      if (!input.dry_run && (ingested.length > 0 || proposed.length > 0)) {
        const ns_cap = target.id.charAt(0).toUpperCase() + target.id.slice(1);
        curation_log_path = `Knowledge/${ns_cap}/library/_curation_log.md`;
        const stamp = new Date().toISOString();
        const lines: string[] = [`\n## ${stamp} — curate pass\n`];
        lines.push(
          `Focus areas: ${input.focus_areas.map((a) => `\`${a}\``).join(', ')}`,
        );
        lines.push(`Caller user: \`${ctx.user?.id ?? 'system'}\`\n`);
        for (const r of ingested) {
          lines.push(
            `- **Ingested T${r.trust_tier}** — [${r.title}](${r.url}) → \`${r.wrapper_note_path}\``,
          );
        }
        for (const r of proposed) {
          lines.push(
            `- **Proposed Tier ${r.suggested_tier}** — \`${r.domain}\` (proposal \`${r.proposal_id}\`)`,
          );
        }
        for (const r of skipped.slice(0, 6)) {
          lines.push(`- _skipped_ — ${r.url}: ${r.reason}`);
        }
        if (skipped.length > 6) {
          lines.push(`- _…${skipped.length - 6} more skipped_`);
        }
        deps.library_deps.memory.append_to_note(
          curation_log_path,
          lines.join('\n') + '\n',
        );
      }

      return {
        target_specialist_id: target.id,
        ingested,
        proposed,
        skipped,
        curation_log_path,
        dry_run: input.dry_run,
      };
    },
  };
}

/** ToolLoader entry point. */
export function create(deps: ToolDeps): Tool {
  return make_curate_for_specialist({
    specialists: deps.specialists,
    proposals: deps.proposals,
    library_deps: {
      db: deps.db,
      vault_root: deps.vault_root,
      memory: deps.memory,
      specialists: deps.specialists,
      runtime: deps.runtime,
      conversations: deps.conversations,
      llm: deps.llm,
      // Embed-at-ingest (2026-06-10) — curated shelf items become
      // vector-searchable immediately instead of waiting for backfill.
      embedder: deps.embedder,
      events: deps.events,
    },
    users: deps.users,
  }) as Tool;
}
