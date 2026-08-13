/**
 * check_show_status — Maggie's all-in-one "capture an upcoming show +
 * verify ticket availability" tool.
 *
 * This is the structured replacement for the old free-text
 * `update_maggie_memory({kind:'research'})` capture pattern when the
 * research result is a concrete (artist, venue, date) Maggie wants on
 * the user's Listening room. memory.md still receives `taste` and
 * `note` entries; `research` entries that name a concrete show should
 * route here instead so the Listening pane's Coming-to-town section
 * has a structured source.
 *
 * Side effects:
 *   1. UPSERT into `upcoming_shows` keyed by (user_id, artist, venue,
 *      show_date). First-seen rows get a fresh `first_seen_at`;
 *      existing rows keep theirs and refresh `last_seen_at`.
 *   2. If `tickets_url` is provided (or `source_url` as fallback),
 *      fetch the page via web_fetch_clean (the persona-level
 *      Cloudflare-escalation rule still applies — when the caller
 *      knows a venue is Cloudflare-walled they can pass
 *      `force_browse=true` to skip Firecrawl).
 *   3. Parse the fetched markdown for ticket-status signals
 *      (`parse_ticket_status`) and UPDATE ticket_status +
 *      ticket_status_checked_at + ticket_status_signals_json.
 *   4. Audit one row carrying the upsert + parse outcome. The
 *      underlying web fetch leaves its own audit through the
 *      connector's safe_fetch helper.
 *
 * Capability: `track_upcoming_shows` (new in this pass) +
 * `query_web` (for the fetch). Maggie holds both. Risk:
 * `write_internal` — the structured write is the dominant effect; the
 * read-side web fetch is incidental.
 */

import { z } from 'zod';
import { createHash } from 'node:crypto';
import { ulid } from 'ulid';
import type { Database } from 'bun:sqlite';
import type { Tool, ToolContext } from '@core/tool';
import type { ToolDeps } from '@core/tool_deps';
import { web_fetch_clean } from '@connectors/firecrawl';
import { browse_url } from '@connectors/avalanche';

const TicketStatus = z.enum([
  'available',
  'low',
  'sold_out',
  'resale_only',
  'unknown',
]);
type TicketStatusT = z.infer<typeof TicketStatus>;

const InputSchema = z.object({
  artist: z.string().min(1).max(200),
  venue: z.string().min(1).max(200),
  // NOTE: no `.regex()` — a tool input_schema becomes a GBNF grammar on the
  // interactive 9B, and llama.cpp's converter mistranslates a regex `pattern`
  // and SILENTLY disables the whole tool grammar. The YYYY-MM-DD shape is
  // validated in execute() instead.
  show_date: z.string().describe('Show date, ISO YYYY-MM-DD.'),
  city: z.string().max(200).optional(),
  tickets_url: z
    .string()
    .url()
    .optional()
    .describe(
      "Primary ticket-buying page. Preferred fetch target. Use the " +
        'specific show URL when available (axs.com/events/<id>, the ' +
        "venue's per-event page); avoid passing a venue calendar that " +
        'lists many shows — the parser conflates sold-out and ' +
        'available signals across them.',
    ),
  source_url: z
    .string()
    .url()
    .optional()
    .describe(
      'Where Maggie found this show (artist tour page, venue calendar, ' +
        "music-news link). Used as the fetch fallback when no " +
        'tickets_url is known yet, and recorded for provenance.',
    ),
  rationale: z
    .string()
    .min(1)
    .max(500)
    .describe(
      "One short sentence — why this show matches Jasper's taste. " +
        "Surfaced in the Listening pane row's subtitle and in any " +
        'follow-up propose_action body.',
    ),
  affinity_hint: z
    .coerce
    .number()
    .int()
    .min(1)
    .max(10)
    .optional()
    .describe(
      "Maggie's calibration of how aligned this show is with the " +
        "user's current taste (1–10). When omitted, the artist's " +
        'standing affinity in the watchlist is used (if present).',
    ),
  force_browse: z
    .boolean()
    .default(false)
    .describe(
      'Skip web_fetch_clean and go straight to browse_url. Use when ' +
        'the venue is on the known-Cloudflare-walled list ' +
        '(ticketmaster, livenation, seatgeek, stubhub, axs).',
    ),
});

const OutputSchema = z.object({
  id: z.string(),
  was_inserted: z.boolean(),
  ticket_status: TicketStatus,
  ticket_status_checked_at: z.string(),
  signals: z.array(z.string()),
  fetched_url: z.string().nullable(),
  error: z.string().optional(),
});

type Input = z.infer<typeof InputSchema>;
type Output = z.infer<typeof OutputSchema>;

// ── parser ──────────────────────────────────────────────────────────────

interface ParseResult {
  status: TicketStatusT;
  signals: string[];
}

const SOLD_OUT_RES: Array<{ re: RegExp; signal: string }> = [
  { re: /\bsold\s*out\b/i, signal: 'matched "sold out"' },
  { re: /\bno\s+longer\s+available\b/i, signal: 'matched "no longer available"' },
  { re: /\bsale\s+(has\s+)?ended\b/i, signal: 'matched "sale ended"' },
  { re: /\btickets?\s+are\s+gone\b/i, signal: 'matched "tickets are gone"' },
];

const RESALE_ONLY_RES: Array<{ re: RegExp; signal: string }> = [
  { re: /\bresale\s+only\b/i, signal: 'matched "resale only"' },
  { re: /\bsecondary\s+market\b/i, signal: 'matched "secondary market"' },
  { re: /\bstubhub\b.*\bonly\b/i, signal: 'matched "stubhub only"' },
  { re: /\bvivid\s*seats\b.*\bonly\b/i, signal: 'matched "vivid seats only"' },
];

const LOW_RES: Array<{ re: RegExp; signal: string }> = [
  { re: /\blow\s+ticket\s+warning\b/i, signal: 'matched "low ticket warning"' },
  { re: /\bfew(er)?\s+(than|left)\b/i, signal: 'matched "few left"' },
  { re: /\blast\s+\d+\s+tickets?\b/i, signal: 'matched "last N tickets"' },
  { re: /\blimited\s+(availability|tickets)\b/i, signal: 'matched "limited availability"' },
  { re: /\balmost\s+sold\s*out\b/i, signal: 'matched "almost sold out"' },
];

const AVAILABLE_RES: Array<{ re: RegExp; signal: string }> = [
  { re: /\btickets?\s+(are\s+)?available\b/i, signal: 'matched "tickets available"' },
  { re: /\bon\s+sale\s+now\b/i, signal: 'matched "on sale now"' },
  { re: /\bbuy\s+tickets?\b/i, signal: 'matched "buy tickets"' },
  { re: /\bget\s+tickets?\b/i, signal: 'matched "get tickets"' },
  { re: /\badd\s+to\s+cart\b/i, signal: 'matched "add to cart"' },
];

/**
 * Conservative parse: a sold-out signal anywhere on the page wins, even
 * if "buy tickets" copy also appears (that copy frequently survives on
 * sold-out event pages as residual chrome). Resale-only beats low /
 * available. Low beats available. No signals → unknown.
 *
 * The signals[] return is informational — the audit row carries it so
 * a wrong call (Maggie surfacing a sold-out gig as available) is
 * traceable to which regex hit on which body slice.
 */
export function parse_ticket_status(markdown: string): ParseResult {
  const signals: string[] = [];
  let saw_sold_out = false;
  let saw_resale_only = false;
  let saw_low = false;
  let saw_available = false;
  for (const { re, signal } of SOLD_OUT_RES) {
    if (re.test(markdown)) {
      signals.push(signal);
      saw_sold_out = true;
    }
  }
  for (const { re, signal } of RESALE_ONLY_RES) {
    if (re.test(markdown)) {
      signals.push(signal);
      saw_resale_only = true;
    }
  }
  for (const { re, signal } of LOW_RES) {
    if (re.test(markdown)) {
      signals.push(signal);
      saw_low = true;
    }
  }
  for (const { re, signal } of AVAILABLE_RES) {
    if (re.test(markdown)) {
      signals.push(signal);
      saw_available = true;
    }
  }
  let status: TicketStatusT;
  if (saw_sold_out) status = 'sold_out';
  else if (saw_resale_only) status = 'resale_only';
  else if (saw_low) status = 'low';
  else if (saw_available) status = 'available';
  else status = 'unknown';
  return { status, signals };
}

// ── watchlist affinity lookup ───────────────────────────────────────────

import { load_rows as load_watchlist_rows } from './manage_watchlist';

function lookup_watchlist_affinity(
  vault_root: string,
  artist: string,
): number | null {
  try {
    const rows = load_watchlist_rows(vault_root);
    const want = artist.toLowerCase();
    const hit = rows.find((r) => r.artist.toLowerCase() === want);
    return hit?.affinity ?? null;
  } catch {
    return null;
  }
}

// ── upsert ──────────────────────────────────────────────────────────────

interface UpsertResult {
  id: string;
  was_inserted: boolean;
}

function upsert_show(
  db: Database,
  user_id: string,
  input: Input,
  affinity: number | null,
  now_iso: string,
): UpsertResult {
  type ExistingRow = { id: string };
  const existing = db
    .prepare(
      `SELECT id FROM upcoming_shows
        WHERE user_id = @uid
          AND artist = @artist
          AND venue = @venue
          AND show_date = @show_date`,
    )
    .get({
      '@uid': user_id,
      '@artist': input.artist,
      '@venue': input.venue,
      '@show_date': input.show_date,
    }) as ExistingRow | undefined;
  if (existing) {
    db.prepare(
      `UPDATE upcoming_shows
          SET last_seen_at = @last_seen_at,
              city = COALESCE(@city, city),
              tickets_url = COALESCE(@tickets_url, tickets_url),
              source_url = COALESCE(@source_url, source_url),
              rationale = COALESCE(@rationale, rationale),
              affinity_at_capture = COALESCE(@affinity, affinity_at_capture)
        WHERE id = @id`,
    ).run({
      '@id': existing.id,
      '@last_seen_at': now_iso,
      '@city': input.city ?? null,
      '@tickets_url': input.tickets_url ?? null,
      '@source_url': input.source_url ?? null,
      '@rationale': input.rationale,
      '@affinity': affinity,
    });
    return { id: existing.id, was_inserted: false };
  }
  const id = ulid();
  db.prepare(
    `INSERT INTO upcoming_shows (
       id, user_id, artist, venue, city, show_date,
       tickets_url, source_url, rationale, affinity_at_capture,
       first_seen_at, last_seen_at, ticket_status
     ) VALUES (
       @id, @user_id, @artist, @venue, @city, @show_date,
       @tickets_url, @source_url, @rationale, @affinity,
       @first_seen_at, @last_seen_at, 'unknown'
     )`,
  ).run({
    '@id': id,
    '@user_id': user_id,
    '@artist': input.artist,
    '@venue': input.venue,
    '@city': input.city ?? null,
    '@show_date': input.show_date,
    '@tickets_url': input.tickets_url ?? null,
    '@source_url': input.source_url ?? null,
    '@rationale': input.rationale,
    '@affinity': affinity,
    '@first_seen_at': now_iso,
    '@last_seen_at': now_iso,
  });
  return { id, was_inserted: true };
}

// ── fetch ───────────────────────────────────────────────────────────────

interface FetchOutcome {
  url: string | null;
  markdown: string;
  error?: string;
}

async function fetch_for_parse(
  input: Input,
  ctx: ToolContext,
): Promise<FetchOutcome> {
  const target = input.tickets_url ?? input.source_url ?? null;
  if (!target) {
    return { url: null, markdown: '', error: 'no tickets_url or source_url provided' };
  }
  if (!input.force_browse) {
    const fc = await web_fetch_clean.execute({ url: target }, ctx);
    if (!fc.error && fc.markdown && fc.markdown.length > 0) {
      return { url: target, markdown: fc.markdown };
    }
  }
  // Escalate to browse_url for Cloudflare-walled / JS-only pages. We
  // pass wait_ms explicitly because the parsed input type carries it
  // post-default; calling .execute() skips the schema-default fill.
  try {
    const br = await browse_url.execute(
      { url: target, wait_ms: 1500 },
      ctx,
    );
    if (br.error) {
      return { url: target, markdown: '', error: br.error };
    }
    return { url: target, markdown: br.text ?? '' };
  } catch (err) {
    return {
      url: target,
      markdown: '',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ── tool factory ────────────────────────────────────────────────────────

export function create(deps: ToolDeps): Tool<Input, Output> {
  return {
    name: 'check_show_status',
    description:
      "Capture an upcoming show on Jasper's Listening room AND verify " +
      "ticket availability in one call. Required: artist, venue, " +
      "show_date (YYYY-MM-DD), rationale (one sentence — why it matches " +
      "his taste). Optional: city, tickets_url (preferred fetch target; " +
      "pass the per-event page, not a multi-show venue calendar), " +
      "source_url (where you found it), affinity_hint (1–10; falls back " +
      "to the artist watchlist), force_browse (skip Firecrawl for known " +
      "Cloudflare-walled ticketing). Upserts upcoming_shows on " +
      "(artist, venue, date) — re-discovering the same show refreshes " +
      "last_seen_at + ticket status. Use this INSTEAD OF " +
      "update_maggie_memory({kind:'research'}) when the research result " +
      "is a concrete show; the Listening pane's Coming-to-town section " +
      "reads from this table.",
    risk: 'write_internal',
    required_capabilities: ['track_upcoming_shows', 'query_web'],
    input_schema: InputSchema,
    output_schema: OutputSchema,

    idempotency_key(input) {
      const h = createHash('sha256');
      h.update(input.artist.toLowerCase());
      h.update('\n');
      h.update(input.venue.toLowerCase());
      h.update('\n');
      h.update(input.show_date);
      return `check_show_status:${h.digest('hex').slice(0, 16)}`;
    },

    async execute(input, ctx: ToolContext): Promise<Output> {
      // Date-shape check moved off the schema (a regex `pattern` silently
      // disables the 9B's tool grammar).
      if (!/^\d{4}-\d{2}-\d{2}$/.test(input.show_date)) {
        throw new Error(`show_date must be ISO YYYY-MM-DD; got "${input.show_date}".`);
      }
      const now_iso = (ctx.now ?? new Date()).toISOString();
      const user_id = ctx.user?.id ?? 'jasper';
      const affinity =
        input.affinity_hint ??
        lookup_watchlist_affinity(deps.vault_root, input.artist);

      const upserted = upsert_show(deps.db, user_id, input, affinity, now_iso);
      const fetched = await fetch_for_parse(input, ctx);
      const parsed: ParseResult = fetched.markdown
        ? parse_ticket_status(fetched.markdown)
        : { status: 'unknown', signals: [] };

      deps.db.prepare(
        `UPDATE upcoming_shows
            SET ticket_status = @status,
                ticket_status_checked_at = @checked_at,
                ticket_status_signals_json = @signals_json
          WHERE id = @id`,
      ).run({
        '@id': upserted.id,
        '@status': parsed.status,
        '@checked_at': now_iso,
        '@signals_json': JSON.stringify(parsed.signals),
      });

      ctx.memory.log_action({
        intent_id: ctx.intent_id || ulid(),
        agent: ctx.specialist_id ?? 'maggie',
        tool_name: 'check_show_status',
        tool_input: {
          artist: input.artist,
          venue: input.venue,
          show_date: input.show_date,
          city: input.city,
          tickets_url: input.tickets_url,
          source_url: input.source_url,
          force_browse: input.force_browse,
        },
        execution_result: {
          id: upserted.id,
          was_inserted: upserted.was_inserted,
          ticket_status: parsed.status,
          fetched_url: fetched.url,
          signal_count: parsed.signals.length,
          fetch_error: fetched.error ?? null,
        },
      });

      return {
        id: upserted.id,
        was_inserted: upserted.was_inserted,
        ticket_status: parsed.status,
        ticket_status_checked_at: now_iso,
        signals: parsed.signals,
        fetched_url: fetched.url,
        ...(fetched.error ? { error: fetched.error } : {}),
      };
    },
  };
}
