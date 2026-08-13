/**
 * add_concert_history.ts — the chat-time intake hook for "I saw X at Y on Z."
 *
 * Writes symmetrically to both watchlists:
 *   - Knowledge/Maggie/artist_watchlist.md (artist row's past_shows)
 *   - Knowledge/Maggie/venue_watchlist.md (venue row's past_shows)
 *
 * If either entity is new, it's auto-created (artist defaults to
 * affinity 7 "Jasper actually went"; venue gets just the name + region).
 *
 * This is Maggie's primary chat-time pattern for capturing concert
 * attendance. Jasper saying "I saw Purity Ring at Mission Ballroom on
 * 2025-10-21" should trigger ONE call to this tool, NOT separate calls
 * to update_artist_watchlist + update_venue_watchlist (those are still
 * available for edge cases — adding without attending, for example).
 *
 * Idempotent: re-calling with the same (artist, venue, date) is a
 * no-op (the show entry already exists in both files).
 */

import { z } from 'zod';
import { createHash } from 'node:crypto';
import { ulid } from 'ulid';
import type { Tool, ToolContext } from '@core/tool';
import type { ToolDeps } from '@core/tool_deps';
import { load_rows, save_rows, add_show_to_artist } from './manage_watchlist';
import { load_venues, save_venues, add_show_to_venue } from './manage_venue_watchlist';

const InputSchema = z.object({
  artist: z.string().min(1).max(200)
    .describe('Artist / band name. Exact spelling; case-insensitive matching against existing watchlist entries.'),
  venue: z.string().min(1).max(200)
    .describe(
      "Venue name. Should match the venue's display name (e.g. 'Mission " +
        "Ballroom', 'Midtown Theater'). Used as the dedup key for venue " +
        'watchlist matching.',
    ),
  // NOTE: no `.regex()` — a tool input_schema becomes a GBNF grammar on the
  // interactive 9B, and llama.cpp's converter mistranslates a regex `pattern`
  // and SILENTLY disables the whole tool grammar. The YYYY-MM-DD shape is
  // validated in execute() instead.
  date: z.string()
    .describe('Concert date in YYYY-MM-DD. Should match Jasper\'s stated date precisely.'),
  city: z.string().max(100).default('')
    .describe('City name, e.g. "Denver", "Pleasantville". Joined into the artist past-shows line as "(city)" if provided.'),
  region: z.string().max(100).default('')
    .describe(
      'Full "City, State" region for the venue row, e.g. "Denver, CO". ' +
        "Only used when adding a NEW venue; ignored if venue already exists. " +
        "If unsure, leave blank — you can update_venue_watchlist later.",
    ),
  venue_calendar_url: z.string().optional()
    .describe(
      "Optional: the venue's calendar/events page URL. Cached on the " +
        'venue row when this is the first time adding the venue (or when ' +
        "the existing row has no URL). Lets the bidirectional sweep " +
        'fetch the venue calendar directly.',
    ),
});

const OutputSchema = z.object({
  artist: z.string(),
  venue: z.string(),
  date: z.string(),
  artist_show_entry: z.string(),
  venue_show_entry: z.string(),
  artist_created: z.boolean(),
  venue_created: z.boolean(),
});

type Input = z.infer<typeof InputSchema>;
type Output = z.infer<typeof OutputSchema>;

export function create(deps: ToolDeps): Tool<Input, Output> {
  return {
    name: 'add_concert_history',
    description:
      "Record that Jasper attended a specific show — writes symmetrically " +
      "to BOTH the artist watchlist (appends to artist's past_shows) AND " +
      "the venue watchlist (appends to venue's past_shows). Auto-creates " +
      'either entity if missing (artist defaults to affinity 7; venue ' +
      "gets the bare name + region). Idempotent on (artist, venue, date). " +
      "Use this for chat-time 'I saw X at Y on Z' captures — it's the " +
      'one-call equivalent of update_artist_watchlist + update_venue_watchlist.',
    risk: 'write_internal',
    required_capabilities: ['write_vault_media'],
    input_schema: InputSchema,
    output_schema: OutputSchema,

    idempotency_key(input) {
      const h = createHash('sha256');
      h.update(input.artist.toLowerCase());
      h.update('\n');
      h.update(input.venue.toLowerCase());
      h.update('\n');
      h.update(input.date);
      return `add_concert_history:${h.digest('hex').slice(0, 16)}`;
    },

    async execute(input, ctx: ToolContext): Promise<Output> {
      // Date-shape check moved off the schema (a regex `pattern` silently
      // disables the 9B's tool grammar).
      if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date)) {
        throw new Error(`date must be YYYY-MM-DD; got "${input.date}".`);
      }
      // Artist-side entry: "DATE VENUE (city)" — city helps disambiguate
      // when an artist has played multiple venues with the same name.
      const venue_label = input.city ? `${input.venue} (${input.city})` : input.venue;
      const artist_show_entry = `${input.date} ${venue_label}`;

      // Venue-side entry: "ARTIST DATE" — artist first for the obvious
      // "who's played here" reading.
      const venue_show_entry = `${input.artist} ${input.date}`;

      const now = ctx.now ?? new Date();

      // Write artist side.
      const artists = load_rows(deps.vault_root);
      const a_result = add_show_to_artist(artists, input.artist, artist_show_entry, now);
      save_rows(deps.vault_root, a_result.rows);

      // Write venue side.
      const venues = load_venues(deps.vault_root);
      const v_result = add_show_to_venue(
        venues,
        input.venue,
        venue_show_entry,
        input.region,
        input.venue_calendar_url ?? '',
      );
      save_venues(deps.vault_root, v_result.rows);

      const out: Output = {
        artist: input.artist,
        venue: input.venue,
        date: input.date,
        artist_show_entry,
        venue_show_entry,
        artist_created: a_result.created,
        venue_created: v_result.created,
      };
      ctx.memory.log_action({
        intent_id: ctx.intent_id || ulid(),
        agent: ctx.specialist_id ?? 'maggie',
        tool_name: 'add_concert_history',
        tool_input: { artist: input.artist, venue: input.venue, date: input.date },
        execution_result: { artist_created: a_result.created, venue_created: v_result.created },
      });
      return out;
    },
  };
}
