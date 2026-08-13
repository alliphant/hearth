/**
 * mark_show_going — record that Jasper already has tickets to an upcoming
 * show, straight from chat.
 *
 * Before this tool, "I have tickets to the Denver show" dead-ended: Maggie
 * had no way to record it, so the Listening pane kept re-surfacing the show
 * in "Coming to town," and the openers/adjacent-scene research pivot only
 * fired when KATE flagged a calendar concert — never from a direct chat
 * statement in Maggie's own office.
 *
 * This closes both gaps. It stamps `going_marked_at` on the matching
 * upcoming_shows row(s), which (a) filters the show out of the pane's
 * Coming-to-town section, and (b) is the explicit signal the persona keys
 * the adjacent-research follow-up off of (openers, same-scene artists,
 * same-venue calendar).
 *
 * Disambiguation is conservative — it will not blanket-mark. With just an
 * artist that matches more than one future show, it marks NOTHING and
 * returns the candidates so Maggie can ask which (or pass a city/date next
 * call). A provided city / venue / date narrows the match.
 *
 * Capability: `track_show_attendance`. Risk: `write_internal`.
 */

import { z } from 'zod';
import { ulid } from 'ulid';
import type { Database } from 'bun:sqlite';
import type { Tool, ToolContext } from '@core/tool';
import type { ToolDeps } from '@core/tool_deps';

const InputSchema = z.object({
  artist: z
    .string()
    .min(1)
    .max(200)
    .describe('The artist / act Jasper has tickets for. Case-insensitive.'),
  city: z
    .string()
    .max(200)
    .optional()
    .describe('City of the show, when he names one ("the Denver show"). Narrows the match.'),
  venue: z
    .string()
    .max(200)
    .optional()
    .describe('Venue of the show, if known. Narrows the match.'),
  // NOTE: no `.regex()` — a tool input_schema becomes a GBNF grammar on the
  // interactive 9B, and llama.cpp's converter mistranslates a regex `pattern`
  // and SILENTLY disables the whole tool grammar. The YYYY-MM-DD shape is
  // validated in execute() and returned as a typed message.
  show_date: z
    .string()
    .optional()
    .describe('Exact show date (YYYY-MM-DD) when known. The strongest disambiguator.'),
});

const MatchSchema = z.object({
  id: z.string(),
  artist: z.string(),
  venue: z.string(),
  city: z.string().nullable(),
  show_date: z.string(),
});

const OutputSchema = z.object({
  marked_count: z.number().int(),
  marked: z.array(MatchSchema),
  ambiguous: z
    .boolean()
    .describe('True when the filter matched >1 show and nothing was marked — ask which.'),
  candidates: z.array(MatchSchema),
  message: z.string(),
});

type Input = z.infer<typeof InputSchema>;
type Output = z.infer<typeof OutputSchema>;
type Row = {
  id: string;
  artist: string;
  venue: string;
  city: string | null;
  show_date: string;
};

/** Future, not-yet-marked shows for this user matching the filter. */
function find_candidates(
  db: Database,
  user_id: string,
  input: Input,
  today: string,
): Row[] {
  const clauses = [
    'user_id = @uid',
    'going_marked_at IS NULL',
    'show_date >= @today',
    'LOWER(TRIM(artist)) = @artist',
  ];
  const params: Record<string, string> = {
    '@uid': user_id,
    '@today': today,
    '@artist': input.artist.trim().toLowerCase(),
  };
  if (input.city) {
    clauses.push('LOWER(TRIM(city)) = @city');
    params['@city'] = input.city.trim().toLowerCase();
  }
  if (input.venue) {
    clauses.push('LOWER(TRIM(venue)) = @venue');
    params['@venue'] = input.venue.trim().toLowerCase();
  }
  if (input.show_date) {
    clauses.push('show_date = @show_date');
    params['@show_date'] = input.show_date;
  }
  return db
    .prepare(
      `SELECT id, artist, venue, city, show_date
         FROM upcoming_shows
        WHERE ${clauses.join(' AND ')}
        ORDER BY show_date ASC`,
    )
    .all(params) as Row[];
}

export function create(deps: ToolDeps): Tool<Input, Output> {
  return {
    name: 'mark_show_going',
    description:
      "Record that Jasper already has tickets to an upcoming show he names " +
      'in chat ("I have tickets to the Denver show"). Stops the show from ' +
      "re-surfacing in his Listening room and is your cue to research the " +
      "openers + adjacent acts in that scene. Required: artist. Optional: " +
      'city, venue, show_date — pass whatever he gave you to pin the right ' +
      'date. If just the artist matches more than one upcoming show, this ' +
      'marks nothing and hands back the candidates so you can ask which one. ' +
      'After a successful mark, follow up by researching the openers and ' +
      'same-scene artists (check_show_status on anything worth surfacing).',
    risk: 'write_internal',
    required_capabilities: ['track_show_attendance'],
    input_schema: InputSchema,
    output_schema: OutputSchema,

    idempotency_key(input) {
      const parts = [
        input.artist.trim().toLowerCase(),
        input.show_date ?? '',
        input.city?.trim().toLowerCase() ?? '',
      ];
      return `mark_show_going:${parts.join('|')}`;
    },

    async execute(input, ctx: ToolContext): Promise<Output> {
      // Date-shape check moved off the schema (a regex `pattern` silently
      // disables the 9B's tool grammar). Surface a typed recovery message.
      if (input.show_date && !/^\d{4}-\d{2}-\d{2}$/.test(input.show_date)) {
        return {
          marked_count: 0,
          marked: [],
          ambiguous: false,
          candidates: [],
          message:
            `show_date must be ISO YYYY-MM-DD (got "${input.show_date}"). Re-call ` +
            `with that format, or omit it and pass a city/venue to disambiguate.`,
        };
      }
      const now_iso = (ctx.now ?? new Date()).toISOString();
      const today = now_iso.slice(0, 10);
      const user_id = ctx.user?.id ?? 'jasper';

      const candidates = find_candidates(deps.db, user_id, input, today);

      let marked: Row[] = [];
      let ambiguous = false;
      let message: string;

      if (candidates.length === 0) {
        message =
          `No upcoming show found for "${input.artist}"` +
          (input.city ? ` in ${input.city}` : '') +
          ' that isn\'t already marked. It may not be captured yet — ' +
          'capture it with check_show_status if you want it tracked.';
      } else if (candidates.length === 1 || input.show_date) {
        // Single match, or an explicit date was given (narrow + intentional)
        // → mark every row the filter returned.
        const ids = candidates.map((r) => r.id);
        const placeholders = ids.map((_, i) => `@id${i}`).join(', ');
        const params: Record<string, string> = { '@now': now_iso };
        ids.forEach((id, i) => {
          params[`@id${i}`] = id;
        });
        deps.db
          .prepare(
            `UPDATE upcoming_shows SET going_marked_at = @now
              WHERE id IN (${placeholders})`,
          )
          .run(params);
        marked = candidates;
        message =
          `Marked ${marked.length} show${marked.length === 1 ? '' : 's'} as going. ` +
          'Pulled from Coming-to-town. Good moment to research the openers + ' +
          'adjacent acts.';
      } else {
        // Artist matched multiple future shows and no date to pick → ask.
        ambiguous = true;
        message =
          `"${input.artist}" has ${candidates.length} upcoming shows in range — ` +
          'which one? Ask, or pass a city/date. Marked nothing.';
      }

      ctx.memory.log_action({
        intent_id: ctx.intent_id || ulid(),
        agent: ctx.specialist_id ?? 'maggie',
        tool_name: 'mark_show_going',
        tool_input: {
          artist: input.artist,
          city: input.city,
          venue: input.venue,
          show_date: input.show_date,
        },
        execution_result: {
          marked_count: marked.length,
          ambiguous,
          candidate_count: candidates.length,
        },
      });

      return {
        marked_count: marked.length,
        marked,
        ambiguous,
        candidates: ambiguous ? candidates : [],
        message,
      };
    },
  };
}
