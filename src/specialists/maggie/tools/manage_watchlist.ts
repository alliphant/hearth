/**
 * manage_watchlist.ts — Maggie's artist watchlist tools (Phase 3 v4).
 *
 * The watchlist (Knowledge/Maggie/artist_watchlist.md) is a structured
 * markdown table of artists Jasper cares about — with affinity score,
 * Songkick/official tour-page URL (cached for the bidirectional sweep),
 * past concert history (semicolon-delimited "DATE VENUE" entries that
 * grow as Maggie captures attendance), and a hand-editable notes column.
 *
 * Tools:
 *   - artist_watchlist_list — read the file and project structured rows
 *   - update_artist_watchlist — add / remove / update_affinity /
 *     mark_checked / set_tour_page_url / add_show. Idempotent.
 *
 * File format (8 columns; the parser tolerates the older 6-column
 * format from Phase 3 partial so the existing file migrates forward on
 * the next write):
 *
 *   | Artist | Affinity | Source | Added | Last checked | Tour page | Past shows | Notes |
 *
 * `past_shows` is `;`-separated: each entry is "YYYY-MM-DD <venue>" with
 * an optional " (<city>)" suffix; pipes are escaped.
 *
 * Capability: write_vault_media (already granted to Maggie); path
 * hardcoded under Knowledge/Maggie/ so the grant can't reach past her
 * namespace. The complementary venue watchlist + the add_concert_history
 * tool live in sibling files; together they form the bidirectional
 * artist↔venue graph.
 */

import { z } from 'zod';
import { createHash } from 'node:crypto';
import { ulid } from 'ulid';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { local_iso_date } from '@core/time';
import type { Tool, ToolContext } from '@core/tool';
import type { ToolDeps } from '@core/tool_deps';

const REL_PATH = 'Knowledge/Maggie/artist_watchlist.md';

const HEADER_LINE_V2 = '| Artist | Affinity | Source | Added | Last checked | Tour page | Past shows | Notes |';
const SEPARATOR_LINE_V2 = '|---|---|---|---|---|---|---|---|';
// Legacy header from Phase 3 partial — we read it but always write V2.
const HEADER_LINE_V1 = '| Artist | Affinity | Source | Added | Last checked | Notes |';
const SEPARATOR_LINE_V1 = '|---|---|---|---|---|---|';

const FILE_PREAMBLE = `# Artist watchlist

_Artists Maggie tracks for tour-radar sweeps within 250mi of Fort
Collins. Hand-editable. Affinity scale: 1–10. 10 = "drop everything,
get tickets at on-sale." 5 = "surface if at a great venue." 1–2 =
"low-priority radar."_

_The bidirectional pass uses \`tour_page\` as the cached source for
\`web_fetch_clean\` and \`past_shows\` as the cross-reference signal
against the venue watchlist (Knowledge/Maggie/venue_watchlist.md)._

${HEADER_LINE_V2}
${SEPARATOR_LINE_V2}
`;

// ── parsing ─────────────────────────────────────────────────────────────

const WatchlistRow = z.object({
  artist: z.string(),
  affinity: z.number().int().min(1).max(10),
  source: z.enum(['manual', 'auto', 'mixed']),
  added: z.string().describe('ISO date the entry was first added.'),
  last_checked: z.string().describe("ISO date of the most recent tour_check sweep ('' if never)."),
  tour_page_url: z
    .string()
    .describe(
      "Cached URL of the artist's official tour page (or Songkick page, " +
        "or whatever Maggie found for the bidirectional sweep). Empty " +
        'until discovered.',
    ),
  past_shows: z
    .array(z.string())
    .describe(
      'Past shows attended: each "YYYY-MM-DD <venue>" with optional ' +
        '" (<city>)" suffix. Cross-referenced against the venue watchlist.',
    ),
  notes: z.string(),
});
type WatchlistRowT = z.infer<typeof WatchlistRow>;

function unescape_pipe(s: string): string {
  return s.replace(/\\\|/g, '|');
}
function escape_pipe(s: string): string {
  return s.replace(/\|/g, '\\|');
}

function split_past_shows(cell: string): string[] {
  return cell
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);
}

function parse_table(content: string): WatchlistRowT[] {
  const lines = content.split('\n');
  const out: WatchlistRowT[] = [];
  let in_table = false;
  let format: 'v1' | 'v2' | null = null;
  for (const raw of lines) {
    const line = raw.trim();
    if (line === HEADER_LINE_V2) {
      in_table = true;
      format = 'v2';
      continue;
    }
    if (line === HEADER_LINE_V1) {
      in_table = true;
      format = 'v1';
      continue;
    }
    if (!in_table) continue;
    if (line === SEPARATOR_LINE_V1 || line === SEPARATOR_LINE_V2) continue;
    if (!line.startsWith('|')) {
      in_table = false;
      continue;
    }
    const cells = line.split('|').slice(1, -1).map((c) => unescape_pipe(c.trim()));
    if (format === 'v2') {
      if (cells.length < 8) continue;
      const aff = Number(cells[1]);
      const src = cells[2];
      if (!Number.isFinite(aff) || aff < 1 || aff > 10) continue;
      if (src !== 'manual' && src !== 'auto' && src !== 'mixed') continue;
      out.push({
        artist: cells[0] ?? '',
        affinity: Math.round(aff),
        source: src,
        added: cells[3] ?? '',
        last_checked: cells[4] ?? '',
        tour_page_url: cells[5] ?? '',
        past_shows: split_past_shows(cells[6] ?? ''),
        notes: cells[7] ?? '',
      });
    } else {
      // v1: 6 cols, missing tour_page + past_shows.
      if (cells.length < 6) continue;
      const aff = Number(cells[1]);
      const src = cells[2];
      if (!Number.isFinite(aff) || aff < 1 || aff > 10) continue;
      if (src !== 'manual' && src !== 'auto' && src !== 'mixed') continue;
      out.push({
        artist: cells[0] ?? '',
        affinity: Math.round(aff),
        source: src,
        added: cells[3] ?? '',
        last_checked: cells[4] ?? '',
        tour_page_url: '',
        past_shows: [],
        notes: cells[5] ?? '',
      });
    }
  }
  return out;
}

function render_table(rows: WatchlistRowT[]): string {
  const body = rows
    .slice()
    .sort((a, b) => b.affinity - a.affinity || a.artist.localeCompare(b.artist))
    .map((r) =>
      `| ${escape_pipe(r.artist)} | ${r.affinity} | ${r.source} | ${r.added} | ${r.last_checked} | ` +
      `${escape_pipe(r.tour_page_url)} | ${escape_pipe(r.past_shows.join('; '))} | ${escape_pipe(r.notes)} |`,
    )
    .join('\n');
  return FILE_PREAMBLE + body + '\n';
}

export function load_rows(vault_root: string): WatchlistRowT[] {
  const abs = resolve(vault_root, REL_PATH);
  if (!existsSync(abs)) return [];
  return parse_table(readFileSync(abs, 'utf8'));
}

export function save_rows(vault_root: string, rows: WatchlistRowT[]): void {
  const abs = resolve(vault_root, REL_PATH);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, render_table(rows), 'utf8');
}

function today_iso(now?: Date): string {
  return local_iso_date(now ?? new Date());
}

function normalize_artist(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ');
}

function find_idx(rows: WatchlistRowT[], artist: string): number {
  const want = normalize_artist(artist);
  return rows.findIndex((r) => normalize_artist(r.artist) === want);
}

/**
 * Append a "YYYY-MM-DD <venue>" entry to an artist's past_shows. If the
 * artist doesn't exist yet, add them with a default affinity of 7 (Jasper
 * actually attended → noteworthy) and source='manual'. Returns the
 * mutated rows AND a flag for whether the artist was newly created.
 *
 * Idempotent: a duplicate "date venue" entry isn't added twice.
 */
export function add_show_to_artist(
  rows: WatchlistRowT[],
  artist: string,
  show_entry: string,
  now: Date,
): { rows: WatchlistRowT[]; created: boolean } {
  const idx = find_idx(rows, artist);
  if (idx < 0) {
    rows.push({
      artist,
      affinity: 7,
      source: 'manual',
      added: today_iso(now),
      last_checked: '',
      tour_page_url: '',
      past_shows: [show_entry],
      notes: 'Auto-added when concert attendance recorded.',
    });
    return { rows, created: true };
  }
  const existing = rows[idx]!;
  if (!existing.past_shows.includes(show_entry)) {
    existing.past_shows = [...existing.past_shows, show_entry].sort();
  }
  return { rows, created: false };
}

// ── artist_watchlist_list ───────────────────────────────────────────────

const ListInput = z.object({
  min_affinity: z.coerce.number().int().min(1).max(10).default(1)
    .describe('Return only entries with affinity >= this (1–10). Defaults to 1 (everything).'),
  source_filter: z.enum(['all', 'manual', 'auto', 'mixed']).default('all'),
  needing_check_since: z
    .string()
    .optional()
    .describe(
      'ISO date — return only artists whose last_checked is BEFORE this ' +
        'date (or never checked). Useful for the rotating tour-radar ' +
        "sweep: 'who haven't I checked in the last 7 days?'",
    ),
});

const ListOutput = z.object({
  count: z.number(),
  rows: z.array(WatchlistRow),
});

type ListInputT = z.infer<typeof ListInput>;
type ListOutputT = z.infer<typeof ListOutput>;

function create_list(deps: ToolDeps): Tool<ListInputT, ListOutputT> {
  return {
    name: 'artist_watchlist_list',
    description:
      "Read Maggie's artist watchlist (Knowledge/Maggie/artist_watchlist.md). " +
      'Returns each artist with affinity (1–10), source (manual = Jasper ' +
      "named them; auto = listening-data inferred; mixed = both), date " +
      'added, last_checked date, cached tour page URL (if discovered), ' +
      'past shows attended, and notes. Filter by min_affinity, source, or ' +
      'needing_check_since (rotating tour-radar sweep).',
    risk: 'read',
    required_capabilities: ['read_vault'],
    input_schema: ListInput,
    output_schema: ListOutput,

    idempotency_key(input) {
      return `artist_watchlist_list:${input.min_affinity}:${input.source_filter}:${input.needing_check_since ?? ''}`;
    },

    async execute(input, _ctx: ToolContext): Promise<ListOutputT> {
      const rows = load_rows(deps.vault_root)
        .filter((r) => r.affinity >= input.min_affinity)
        .filter((r) => input.source_filter === 'all' || r.source === input.source_filter)
        .filter((r) => {
          if (!input.needing_check_since) return true;
          if (!r.last_checked) return true;
          return r.last_checked < input.needing_check_since;
        })
        .sort((a, b) => b.affinity - a.affinity || a.artist.localeCompare(b.artist));
      return { count: rows.length, rows };
    },
  };
}

// ── update_artist_watchlist ─────────────────────────────────────────────

const ActionEnum = z.enum([
  'add',
  'remove',
  'update_affinity',
  'mark_checked',
  'set_tour_page_url',
  'add_show',
]);

const UpdateInput = z.object({
  action: ActionEnum.describe(
    "What to do. 'add' = create or refresh entry (re-adding updates " +
      "affinity/notes/source). 'remove' = delete (no-op if absent). " +
      "'update_affinity' = change affinity without touching other fields. " +
      "'mark_checked' = set last_checked=today (after a tour sweep). " +
      "'set_tour_page_url' = cache the discovered tour page URL. " +
      "'add_show' = append a past show (\"YYYY-MM-DD <venue>\") to past_shows.",
  ),
  artist: z.string().min(1).max(200).describe('Artist name. Exact spelling matters for matching.'),
  affinity: z.coerce.number().int().min(1).max(10).optional()
    .describe("Affinity score 1–10. Required for 'add' and 'update_affinity'."),
  source: z.enum(['manual', 'auto']).default('manual')
    .describe(
      "Where the entry came from. 'manual' for chat-driven adds; 'auto' " +
        'for listening-data-inferred adds. Re-adding with a different ' +
        'source promotes to mixed.',
    ),
  notes: z.string().max(500).default('').describe('Free-text note. For add only; ignored for other actions.'),
  tour_page_url: z.string().optional()
    .describe("URL of the artist's tour page. Used by 'set_tour_page_url' (required) and 'add' (optional)."),
  show_entry: z.string().optional()
    .describe(
      "For 'add_show': the past-show line, e.g. '2026-05-20 Midtown Theater (Pleasantville)'. " +
        'Required for that action. Use add_concert_history instead if you want the ' +
        'symmetric write to the venue watchlist too.',
    ),
});

const UpdateOutput = z.object({
  action: z.string(),
  artist: z.string(),
  result: z.enum(['added', 'updated', 'removed', 'not_present', 'marked_checked', 'url_set', 'show_added']),
  current: WatchlistRow.nullable(),
});

type UpdateInputT = z.infer<typeof UpdateInput>;
type UpdateOutputT = z.infer<typeof UpdateOutput>;

function create_update(deps: ToolDeps): Tool<UpdateInputT, UpdateOutputT> {
  return {
    name: 'update_artist_watchlist',
    description:
      "Mutate Maggie's artist watchlist. Add (idempotent — re-adding " +
      'refreshes), remove, update affinity, mark an artist just-checked, ' +
      'cache the discovered tour page URL, or append a past show to ' +
      "past_shows. Use 'add' when Jasper names a band he wants on radar " +
      "('add Purity Ring at affinity 9'). Use 'mark_checked' after the " +
      "tour-radar deliberation sweep. Use 'set_tour_page_url' when " +
      "you've discovered the artist's official tour page via web_search. " +
      "For attendance ('I saw X at Y on Z'), use add_concert_history " +
      'instead — it writes both the artist AND venue watchlists.',
    risk: 'write_internal',
    required_capabilities: ['write_vault_media'],
    input_schema: UpdateInput,
    output_schema: UpdateOutput,

    idempotency_key(input) {
      const h = createHash('sha256');
      h.update(input.action);
      h.update('\n');
      h.update(normalize_artist(input.artist));
      h.update('\n');
      h.update(String(input.affinity ?? ''));
      h.update('\n');
      h.update(input.tour_page_url ?? '');
      h.update('\n');
      h.update(input.show_entry ?? '');
      return `update_artist_watchlist:${h.digest('hex').slice(0, 16)}`;
    },

    async execute(input, ctx: ToolContext): Promise<UpdateOutputT> {
      const rows = load_rows(deps.vault_root);
      const idx = find_idx(rows, input.artist);
      const today = today_iso(ctx.now);
      const audit = (out: UpdateOutputT): UpdateOutputT => {
        ctx.memory.log_action({
          intent_id: ctx.intent_id || ulid(),
          agent: ctx.specialist_id ?? 'maggie',
          tool_name: 'update_artist_watchlist',
          tool_input: {
            action: input.action,
            artist: input.artist,
            affinity: input.affinity,
            source: input.source,
          },
          execution_result: { result: out.result },
        });
        return out;
      };

      if (input.action === 'remove') {
        if (idx < 0) return audit({ action: input.action, artist: input.artist, result: 'not_present', current: null });
        rows.splice(idx, 1);
        save_rows(deps.vault_root, rows);
        return audit({ action: input.action, artist: input.artist, result: 'removed', current: null });
      }

      if (input.action === 'mark_checked') {
        if (idx < 0) return audit({ action: input.action, artist: input.artist, result: 'not_present', current: null });
        const existing = rows[idx]!;
        const updated: WatchlistRowT = { ...existing, last_checked: today };
        rows[idx] = updated;
        save_rows(deps.vault_root, rows);
        return audit({ action: input.action, artist: input.artist, result: 'marked_checked', current: updated });
      }

      if (input.action === 'update_affinity') {
        if (input.affinity == null) throw new Error('update_affinity requires `affinity` (1–10).');
        if (idx < 0) return audit({ action: input.action, artist: input.artist, result: 'not_present', current: null });
        const existing = rows[idx]!;
        const updated: WatchlistRowT = { ...existing, affinity: input.affinity };
        rows[idx] = updated;
        save_rows(deps.vault_root, rows);
        return audit({ action: input.action, artist: input.artist, result: 'updated', current: updated });
      }

      if (input.action === 'set_tour_page_url') {
        if (!input.tour_page_url) throw new Error('set_tour_page_url requires `tour_page_url`.');
        if (idx < 0) return audit({ action: input.action, artist: input.artist, result: 'not_present', current: null });
        const existing = rows[idx]!;
        const updated: WatchlistRowT = { ...existing, tour_page_url: input.tour_page_url };
        rows[idx] = updated;
        save_rows(deps.vault_root, rows);
        return audit({ action: input.action, artist: input.artist, result: 'url_set', current: updated });
      }

      if (input.action === 'add_show') {
        if (!input.show_entry) throw new Error('add_show requires `show_entry` (e.g. "2026-05-20 Midtown Theater").');
        const result = add_show_to_artist(rows, input.artist, input.show_entry, ctx.now ?? new Date());
        save_rows(deps.vault_root, result.rows);
        const cur = find_idx(result.rows, input.artist);
        return audit({
          action: input.action,
          artist: input.artist,
          result: 'show_added',
          current: cur >= 0 ? result.rows[cur]! : null,
        });
      }

      // action === 'add'
      if (input.affinity == null) throw new Error('add requires `affinity` (1–10).');
      if (idx < 0) {
        const fresh: WatchlistRowT = {
          artist: input.artist,
          affinity: input.affinity,
          source: input.source,
          added: today,
          last_checked: '',
          tour_page_url: input.tour_page_url ?? '',
          past_shows: [],
          notes: input.notes,
        };
        rows.push(fresh);
        save_rows(deps.vault_root, rows);
        return audit({ action: input.action, artist: input.artist, result: 'added', current: fresh });
      }
      // Refresh existing.
      const existing = rows[idx]!;
      const promoted_source: WatchlistRowT['source'] =
        existing.source !== input.source ? 'mixed' : existing.source;
      const updated: WatchlistRowT = {
        ...existing,
        affinity: input.affinity,
        source: promoted_source,
        notes: input.notes || existing.notes,
        tour_page_url: input.tour_page_url ?? existing.tour_page_url,
      };
      rows[idx] = updated;
      save_rows(deps.vault_root, rows);
      return audit({ action: input.action, artist: input.artist, result: 'updated', current: updated });
    },
  };
}

// ── factory ─────────────────────────────────────────────────────────────

export function create(deps: ToolDeps): Tool[] {
  return [create_list(deps), create_update(deps)];
}
