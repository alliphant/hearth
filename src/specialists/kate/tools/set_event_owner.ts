/**
 * set_event_owner (Phase 2, retargeted Phase 3 ops 2026-06-20) — the LEARN half
 * of calendar owner attribution, now a PERSISTENT, SUBSTRING-matching,
 * RETROACTIVE rule (not a one-off exact-title record).
 *
 * When the owner tells Kate whose a calendar event is — "the Grant Taylor appt
 * is Sam's", "anything mentioning Dana is mine" — she:
 *   1. records a CONTAINS rule (phrase → owner): any future event whose title
 *      mentions the phrase auto-attributes (the exact-title fingerprint only
 *      fired when the phrasing equalled the calendar title — "Grant Taylor 6/30"
 *      never matched "Appointment w/ Grant Taylor, DO");
 *   2. RE-STAMPS the existing matching life_event note(s) — sets the owner,
 *      clears owner_uncertain, and re-cordons to the owner — so the present
 *      event (and its pending followup) is fixed too, not just the future;
 *   3. still records the exact fingerprint (weekday/hour slots — back-compat).
 *
 * Owner-driven, household-shared knowledge (it answers "who"). The re-stamp
 * re-cordons a member's event to that member (the owner has no god-view).
 */
import { z } from 'zod';
import { createHash } from 'node:crypto';
import type { Tool, ToolContext } from '@core/tool';
import type { ToolDeps } from '@core/tool_deps';
import type { UserRegistry } from '@core/users';
import type { MemoryClient } from '@memory/client';
import { EventAttributions, fingerprint_of } from '@memory/stores/event_attributions';
import { normalize } from '@core/calendar/attribution';

const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;

const InputSchema = z.object({
  title: z.string().min(1).describe('The event title as it appears on the calendar (e.g. "appointment").'),
  owner: z.string().min(1).describe('Whose event it is — a user id or display name (e.g. "sam").'),
  location: z.string().optional().describe('Optional location, for place-based recurrence.'),
  weekday: z.enum(WEEKDAYS).optional().describe('Optional weekday for a recurring time slot.'),
  hour: z.number().int().min(0).max(23).optional().describe('Optional local hour (0-23) for a recurring slot.'),
});
const OutputSchema = z.object({
  recorded: z.boolean(),
  owner_user_id: z.string().optional(),
  fingerprint: z.string().optional(),
  /** How many existing matching life_event notes were re-stamped to the owner. */
  restamped: z.number().optional(),
  note: z.string(),
  candidates: z.array(z.string()).optional(),
});
type Input = z.infer<typeof InputSchema>;
type Output = z.infer<typeof OutputSchema>;

function resolve_owner(users: UserRegistry, raw: string): { id: string } | null {
  const direct = users.get(raw);
  if (direct) return { id: direct.id };
  const want = raw.toLowerCase().trim();
  const byName = users.list().find((u) => u.display_name.toLowerCase().trim() === want);
  return byName ? { id: byName.id } : null;
}

export function make_set_event_owner(deps: {
  db: import('bun:sqlite').Database;
  users: UserRegistry | undefined;
  memory?: MemoryClient;
}): Tool<Input, Output> {
  return {
    name: 'set_event_owner',
    description:
      "Record whose a calendar event is — a PERSISTENT, reusable rule. CALL THIS whenever the owner tells you (or answers your ask) that a calendar event belongs to a household member — e.g. \"the Grant Taylor appt is Sam's\", \"anything mentioning Dana is mine\". It MATCHES BY KEYWORD: pass the distinctive part of the title (\"Grant Taylor\", \"Dana\") — any event whose title MENTIONS it auto-attributes to that person from now on, AND existing matching events are re-stamped immediately. This IS the reusable rule — do NOT just acknowledge, route to Cordelia, or file a proposal. Add weekday+hour or a location only for a generic recurring slot (\"haircut\" Tue 2pm).",
    risk: 'write_internal',
    required_capabilities: ['attribute_events'],
    input_schema: InputSchema,
    output_schema: OutputSchema,

    idempotency_key(input) {
      const h = createHash('sha256');
      h.update([input.title, input.owner, input.location ?? '', input.weekday ?? '', String(input.hour ?? '')].join('\n'));
      return `set_event_owner:${h.digest('hex').slice(0, 16)}`;
    },

    async execute(input, ctx: ToolContext): Promise<Output> {
      if (!deps.users) {
        return { recorded: false, note: 'User registry unavailable; cannot attribute.' };
      }
      const owner = resolve_owner(deps.users, input.owner);
      if (!owner) {
        return {
          recorded: false,
          note: `"${input.owner}" isn't a known user. Use one of these (id or name).`,
          candidates: deps.users.list().map((u) => `${u.id} (${u.display_name})`),
        };
      }
      const components = {
        title_norm: normalize(input.title),
        location_norm: normalize(input.location ?? ''),
        weekday: input.weekday ?? '',
        hour: input.hour ?? 0,
      };
      const store = new EventAttributions(deps.db);
      store.record(components, owner.id); // exact fingerprint (weekday/hour slots)
      const fp = fingerprint_of(components);
      // The CONTAINS rule — the durable, loosely-matching half. No-op if the
      // phrase is too short to be safe (would over-match).
      const phrase = components.title_norm;
      const rule_recorded = store.record_substring(phrase, owner.id);

      // Retroactive: re-stamp existing life_event notes whose title MENTIONS the
      // phrase — set owner, clear owner_uncertain, re-cordon to the owner — so
      // the present event (and its pending followup routing) is fixed, not just
      // the future. Fail-open per note.
      let restamped = 0;
      if (deps.memory && phrase.length >= EventAttributions.MIN_PHRASE) {
        try {
          const rows = deps.db
            .prepare(`SELECT note_path, title FROM life_events`)
            .all() as Array<{ note_path: string; title: string }>;
          for (const r of rows) {
            if (!normalize(r.title).includes(phrase)) continue;
            try {
              const note = deps.memory.read_note(r.note_path);
              if (!note) continue;
              const fm = { ...note.frontmatter, owner: owner.id, owner_uncertain: false, private_to: owner.id };
              deps.memory.upsert_note(r.note_path, fm, note.body);
              restamped++;
            } catch {
              /* fail-open — one bad note never aborts the re-stamp */
            }
          }
        } catch {
          /* fail-open — re-stamp is best-effort; the rule is the durable record */
        }
      }

      ctx.memory.log_action({
        intent_id: ctx.intent_id,
        agent: ctx.specialist_id ?? 'kate',
        tool_name: 'set_event_owner',
        tool_input: { title: input.title, owner: owner.id, weekday: input.weekday, hour: input.hour, location: input.location },
        execution_result: { fingerprint: fp, rule_recorded, restamped },
      });

      const future = rule_recorded
        ? `future events mentioning "${input.title}" will auto-attribute to ${owner.id}`
        : `future exact "${input.title}" events will attribute to ${owner.id}`;
      const past = restamped > 0 ? ` Re-stamped ${restamped} existing event${restamped === 1 ? '' : 's'}.` : '';
      return {
        recorded: true,
        owner_user_id: owner.id,
        fingerprint: fp,
        restamped,
        note: `Got it — ${future}.${past}`,
      };
    },
  };
}

export function create(deps: ToolDeps): Tool {
  return make_set_event_owner({ db: deps.db, users: deps.users, memory: deps.memory }) as Tool;
}
