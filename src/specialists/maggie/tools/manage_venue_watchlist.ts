/**
 * manage_venue_watchlist.ts — venue side of the Phase 3 v4 graph.
 *
 * The venue watchlist (Knowledge/Maggie/venue_watchlist.md) is the
 * complement to the artist watchlist. Where the artist file drives
 * "for each band Jasper cares about, check their tour page," the venue
 * file drives "for each venue Jasper cares about, check the calendar
 * for any artist matching his tastes."
 *
 * Both are populated by add_concert_history (when Jasper mentions
 * attendance) AND by Maggie's chat-time add tools. A venue with past
 * shows is implicitly high-affinity — no explicit affinity score is
 * needed.
 *
 * File format (markdown table; 5 columns):
 *
 *   | Venue | Region | Calendar URL | Lat/Lon | Past shows |
 *
 * `past_shows` is `;`-separated: "ARTIST YYYY-MM-DD"; pipes escaped.
 *
 * Tools:
 *   - venue_watchlist_list — read the file
 *   - update_venue_watchlist — add / remove / update_url / update_geo /
 *                              add_show
 */

import { z } from 'zod';
import { createHash } from 'node:crypto';
import { ulid } from 'ulid';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import type { Tool, ToolContext } from '@core/tool';
import type { ToolDeps } from '@core/tool_deps';

const REL_PATH = 'Knowledge/Maggie/venue_watchlist.md';

const HEADER_LINE = '| Venue | Region | Calendar URL | Lat/Lon | Past shows |';
const SEPARATOR_LINE = '|---|---|---|---|---|';

const FILE_PREAMBLE = `# Venue watchlist

_Venues Maggie tracks for the bidirectional tour-radar sweep. Calendars
checked via \`web_fetch_clean\`; results cross-referenced against the
artist watchlist (Knowledge/Maggie/artist_watchlist.md). Adds happen
either when Jasper mentions attendance (\`add_concert_history\`) or when
Maggie's deliberation pass discovers a new venue hosting a watchlist
artist._

${HEADER_LINE}
${SEPARATOR_LINE}
`;

// ── parsing ─────────────────────────────────────────────────────────────

const VenueRow = z.object({
  venue: z.string(),
  region: z.string().describe('City, state — e.g. "Denver, CO"'),
  calendar_url: z.string(),
  lat: z.number().nullable(),
  lon: z.number().nullable(),
  past_shows: z.array(z.string()).describe('Past shows: each "ARTIST YYYY-MM-DD". Newest first.'),
});
type VenueRowT = z.infer<typeof VenueRow>;

function unescape_pipe(s: string): string { return s.replace(/\\\|/g, '|'); }
function escape_pipe(s: string): string { return s.replace(/\|/g, '\\|'); }

function parse_latlon(cell: string): { lat: number | null; lon: number | null } {
  const m = cell.match(/^([\d.-]+)\s*,\s*([\d.-]+)$/);
  if (!m) return { lat: null, lon: null };
  const lat = Number(m[1]);
  const lon = Number(m[2]);
  return {
    lat: Number.isFinite(lat) ? lat : null,
    lon: Number.isFinite(lon) ? lon : null,
  };
}

function format_latlon(lat: number | null, lon: number | null): string {
  if (lat == null || lon == null) return '';
  return `${lat.toFixed(4)},${lon.toFixed(4)}`;
}

function split_past_shows(cell: string): string[] {
  return cell.split(';').map((s) => s.trim()).filter(Boolean);
}

function parse_table(content: string): VenueRowT[] {
  const lines = content.split('\n');
  const out: VenueRowT[] = [];
  let in_table = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (line === HEADER_LINE) { in_table = true; continue; }
    if (!in_table) continue;
    if (line === SEPARATOR_LINE) continue;
    if (!line.startsWith('|')) { in_table = false; continue; }
    const cells = line.split('|').slice(1, -1).map((c) => unescape_pipe(c.trim()));
    if (cells.length < 5) continue;
    const { lat, lon } = parse_latlon(cells[3] ?? '');
    out.push({
      venue: cells[0] ?? '',
      region: cells[1] ?? '',
      calendar_url: cells[2] ?? '',
      lat,
      lon,
      past_shows: split_past_shows(cells[4] ?? ''),
    });
  }
  return out;
}

function render_table(rows: VenueRowT[]): string {
  const body = rows
    .slice()
    .sort((a, b) => b.past_shows.length - a.past_shows.length || a.venue.localeCompare(b.venue))
    .map((r) =>
      `| ${escape_pipe(r.venue)} | ${escape_pipe(r.region)} | ${escape_pipe(r.calendar_url)} | ` +
      `${format_latlon(r.lat, r.lon)} | ${escape_pipe(r.past_shows.join('; '))} |`,
    )
    .join('\n');
  return FILE_PREAMBLE + body + '\n';
}

export function load_venues(vault_root: string): VenueRowT[] {
  const abs = resolve(vault_root, REL_PATH);
  if (!existsSync(abs)) return [];
  return parse_table(readFileSync(abs, 'utf8'));
}

export function save_venues(vault_root: string, rows: VenueRowT[]): void {
  const abs = resolve(vault_root, REL_PATH);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, render_table(rows), 'utf8');
}

function find_venue_idx(rows: VenueRowT[], venue: string): number {
  const want = venue.toLowerCase();
  return rows.findIndex((r) => r.venue.toLowerCase() === want);
}

/**
 * Append an "ARTIST YYYY-MM-DD" entry to a venue's past_shows. If the
 * venue doesn't exist yet, add it with empty geo/url. Idempotent on the
 * (venue, artist, date) triple.
 */
export function add_show_to_venue(
  rows: VenueRowT[],
  venue: string,
  show_entry: string,
  region: string = '',
  calendar_url: string = '',
): { rows: VenueRowT[]; created: boolean } {
  const idx = find_venue_idx(rows, venue);
  if (idx < 0) {
    rows.push({
      venue,
      region,
      calendar_url,
      lat: null,
      lon: null,
      past_shows: [show_entry],
    });
    return { rows, created: true };
  }
  const existing = rows[idx]!;
  if (!existing.past_shows.includes(show_entry)) {
    existing.past_shows = [...existing.past_shows, show_entry].sort().reverse();
  }
  // Backfill region / calendar_url if newer call has them.
  if (region && !existing.region) existing.region = region;
  if (calendar_url && !existing.calendar_url) existing.calendar_url = calendar_url;
  return { rows, created: false };
}

// ── venue_watchlist_list ────────────────────────────────────────────────

const ListInput = z.object({
  min_shows: z.coerce.number().int().min(0).max(50).default(0)
    .describe('Return only venues with at least this many past shows. 0 = everything.'),
  has_url: z.coerce.boolean().default(false)
    .describe('When true, return only venues with a non-empty calendar_url (i.e. tour-sweep ready).'),
});

const ListOutput = z.object({
  count: z.number(),
  venues: z.array(VenueRow),
});

type ListInputT = z.infer<typeof ListInput>;
type ListOutputT = z.infer<typeof ListOutput>;

function create_list(deps: ToolDeps): Tool<ListInputT, ListOutputT> {
  return {
    name: 'venue_watchlist_list',
    description:
      "Read Maggie's venue watchlist (Knowledge/Maggie/venue_watchlist.md). " +
      'Returns each venue with region, calendar URL (if discovered), ' +
      'lat/lon (if geocoded), and past_shows attended. Filter by ' +
      "min_shows (frequency proxy for 'venues Jasper loves') or has_url " +
      '(only venues ready for the tour-sweep). Sorted by past_shows ' +
      'count descending.',
    risk: 'read',
    required_capabilities: ['read_vault'],
    input_schema: ListInput,
    output_schema: ListOutput,

    idempotency_key(input) {
      return `venue_watchlist_list:${input.min_shows}:${input.has_url}`;
    },

    async execute(input, _ctx: ToolContext): Promise<ListOutputT> {
      const venues = load_venues(deps.vault_root)
        .filter((v) => v.past_shows.length >= input.min_shows)
        .filter((v) => (input.has_url ? Boolean(v.calendar_url) : true))
        .sort((a, b) => b.past_shows.length - a.past_shows.length || a.venue.localeCompare(b.venue));
      return { count: venues.length, venues };
    },
  };
}

// ── update_venue_watchlist ──────────────────────────────────────────────

const ActionEnum = z.enum(['add', 'remove', 'update_url', 'update_geo']);

const UpdateInput = z.object({
  action: ActionEnum.describe(
    "'add' = create or refresh entry. 'remove' = delete. 'update_url' = " +
      "set calendar_url. 'update_geo' = set lat/lon (use after geocoding). " +
      "For attendance, use add_concert_history instead — it writes to both " +
      'watchlists atomically.',
  ),
  venue: z.string().min(1).max(200).describe('Venue name. Exact spelling for matching.'),
  region: z.string().max(100).default('').describe('"City, State" — e.g. "Denver, CO". Recommended for add.'),
  calendar_url: z.string().optional().describe("Venue's events/calendar URL. For 'add' or 'update_url'."),
  lat: z.coerce.number().optional(),
  lon: z.coerce.number().optional(),
});

const UpdateOutput = z.object({
  action: z.string(),
  venue: z.string(),
  result: z.enum(['added', 'updated', 'removed', 'not_present', 'url_set', 'geo_set']),
  current: VenueRow.nullable(),
});

type UpdateInputT = z.infer<typeof UpdateInput>;
type UpdateOutputT = z.infer<typeof UpdateOutput>;

function create_update(deps: ToolDeps): Tool<UpdateInputT, UpdateOutputT> {
  return {
    name: 'update_venue_watchlist',
    description:
      "Mutate Maggie's venue watchlist. Add (idempotent), remove, cache " +
      "discovered calendar URL, or set lat/lon (after geocoding via " +
      "the maps connector). For appending past shows, use add_concert_history " +
      'which writes to both watchlists symmetrically.',
    risk: 'write_internal',
    required_capabilities: ['write_vault_media'],
    input_schema: UpdateInput,
    output_schema: UpdateOutput,

    idempotency_key(input) {
      const h = createHash('sha256');
      h.update(input.action);
      h.update('\n');
      h.update(input.venue.toLowerCase());
      h.update('\n');
      h.update(input.calendar_url ?? '');
      h.update('\n');
      h.update(`${input.lat ?? ''},${input.lon ?? ''}`);
      return `update_venue_watchlist:${h.digest('hex').slice(0, 16)}`;
    },

    async execute(input, ctx: ToolContext): Promise<UpdateOutputT> {
      const rows = load_venues(deps.vault_root);
      const idx = find_venue_idx(rows, input.venue);
      const audit = (out: UpdateOutputT): UpdateOutputT => {
        ctx.memory.log_action({
          intent_id: ctx.intent_id || ulid(),
          agent: ctx.specialist_id ?? 'maggie',
          tool_name: 'update_venue_watchlist',
          tool_input: { action: input.action, venue: input.venue, region: input.region },
          execution_result: { result: out.result },
        });
        return out;
      };

      if (input.action === 'remove') {
        if (idx < 0) return audit({ action: input.action, venue: input.venue, result: 'not_present', current: null });
        rows.splice(idx, 1);
        save_venues(deps.vault_root, rows);
        return audit({ action: input.action, venue: input.venue, result: 'removed', current: null });
      }

      if (input.action === 'update_url') {
        if (!input.calendar_url) throw new Error('update_url requires `calendar_url`.');
        if (idx < 0) return audit({ action: input.action, venue: input.venue, result: 'not_present', current: null });
        const existing = rows[idx]!;
        const updated: VenueRowT = { ...existing, calendar_url: input.calendar_url };
        rows[idx] = updated;
        save_venues(deps.vault_root, rows);
        return audit({ action: input.action, venue: input.venue, result: 'url_set', current: updated });
      }

      if (input.action === 'update_geo') {
        if (input.lat == null || input.lon == null) throw new Error('update_geo requires `lat` and `lon`.');
        if (idx < 0) return audit({ action: input.action, venue: input.venue, result: 'not_present', current: null });
        const existing = rows[idx]!;
        const updated: VenueRowT = { ...existing, lat: input.lat, lon: input.lon };
        rows[idx] = updated;
        save_venues(deps.vault_root, rows);
        return audit({ action: input.action, venue: input.venue, result: 'geo_set', current: updated });
      }

      // action === 'add'
      if (idx < 0) {
        const fresh: VenueRowT = {
          venue: input.venue,
          region: input.region,
          calendar_url: input.calendar_url ?? '',
          lat: input.lat ?? null,
          lon: input.lon ?? null,
          past_shows: [],
        };
        rows.push(fresh);
        save_venues(deps.vault_root, rows);
        return audit({ action: input.action, venue: input.venue, result: 'added', current: fresh });
      }
      // Refresh existing.
      const existing = rows[idx]!;
      const updated: VenueRowT = {
        ...existing,
        region: input.region || existing.region,
        calendar_url: input.calendar_url ?? existing.calendar_url,
        lat: input.lat ?? existing.lat,
        lon: input.lon ?? existing.lon,
      };
      rows[idx] = updated;
      save_venues(deps.vault_root, rows);
      return audit({ action: input.action, venue: input.venue, result: 'updated', current: updated });
    },
  };
}

// ── factory ─────────────────────────────────────────────────────────────

export function create(deps: ToolDeps): Tool[] {
  return [create_list(deps), create_update(deps)];
}
