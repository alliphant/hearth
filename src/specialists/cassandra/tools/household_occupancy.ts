/**
 * household_occupancy — Cassandra's read into the derived "who's home & where"
 * view (Household Awareness Layer P1; design at
 * docs/design-household-awareness-layer.md §8).
 *
 * Assembles signals Hearth already collects: each ENROLLED person's most-recent
 * camera sighting (zone = camera friendly name today; a camera→room map is a P3
 * refinement) with the VL appearance and when, joined by name with their iOS
 * home/away; PLUS currently-active UNRECOGNIZED clusters (recent sighting, no
 * name) with appearance + zone — the concern signal. This is the grounding read
 * for "concerning camera signal vs nothing-burger": a known person at home is
 * routine; an unfamiliar face while every phone is away is the concern.
 *
 * Owner-only + local + derived-not-raw (design §7). The occupancy state never
 * enters RAG/search/cross-specialist sharing; the audit row records counts
 * only, never names/appearance/coordinates. Fail-open: no UserRegistry / no
 * location fix → the sighting-only view (presence 'unknown'), never an error.
 */

import { z } from 'zod';
import { createHash } from 'node:crypto';
import type { Tool, ToolContext } from '@core/tool';
import type { ToolDeps } from '@core/tool_deps';
import { resolve_household_locations, summarize_occupancy } from '@core/household_awareness';

const InputSchema = z.object({
  /** Recency window — how recently a camera sighting counts as "present". */
  window_minutes: z.number().int().min(1).max(720).default(30),
});

const OccupantSchema = z.object({
  name: z.string(),
  relationship: z.string().nullable(),
  zone: z.string().nullable(),
  last_seen_at: z.string().nullable(),
  seconds_ago: z.number().nullable(),
  appearance: z.string().nullable(),
  presence: z.enum(['home', 'away', 'unknown']).nullable(),
  is_household_member: z.boolean(),
});

const UnknownSchema = z.object({
  zone: z.string().nullable(),
  last_seen_at: z.string().nullable(),
  seconds_ago: z.number().nullable(),
  appearance: z.string().nullable(),
  sighting_count: z.number(),
});

const MemberSchema = z.object({
  name: z.string(),
  presence: z.enum(['home', 'away', 'unknown']),
  last_zone: z.string().nullable(),
});

const OutputSchema = z.object({
  ok: z.boolean(),
  summary: z.string().optional(),
  window_minutes: z.number().optional(),
  generated_at: z.string().optional(),
  /** Enrolled people seen on a camera in-window, newest first. */
  occupants: z.array(OccupantSchema).optional(),
  /** Active unrecognized people in-window. */
  unknown_present: z.array(UnknownSchema).optional(),
  /** Every household member + their phone's home/away. */
  household: z.array(MemberSchema).optional(),
  note: z.string().optional(),
  error: z.string().optional(),
  recovery_hint: z.string().optional(),
});

type Input = z.infer<typeof InputSchema>;
type Output = z.infer<typeof OutputSchema>;

export function create(deps: ToolDeps): Tool<Input, Output> {
  return {
    name: 'household_occupancy',
    description:
      'Read the derived "who\'s home & where" view: each enrolled person\'s most-recent camera sighting (room + appearance + when) joined with their phone\'s home/away, plus any active unrecognized people. Call it for "who\'s home?" / "who\'s been in the house?" and to ground the concern-vs-nothing-burger judgment on a camera signal. Owner-only.',
    risk: 'read',
    required_capabilities: ['read_occupancy'],
    input_schema: InputSchema,
    output_schema: OutputSchema,

    idempotency_key(input) {
      return `household_occupancy:${createHash('sha256').update(String(input.window_minutes)).digest('hex').slice(0, 16)}`;
    },

    async execute(input, ctx: ToolContext): Promise<Output> {
      // Absent user = system context (the away-from-home monitor, a
      // deliberation pass) — allowed, keyed to the primary owner; the same
      // convention unifi_camera_view follows. The monitor's known-vs-stranger
      // correlation is exactly the read this view exists for, and it runs
      // with no request user.
      const owner_id = ctx.user?.id ?? deps.users?.primary_owner()?.id;
      if (!owner_id) {
        return { ok: false, error: 'No user in context and no owner-tier user configured — occupancy is owner-scoped.' };
      }
      // Owner-only on top of the capability grant — occupancy is the most
      // private read in the house (where household members physically are).
      if (ctx.user?.tier && ctx.user.tier !== 'owner') {
        return {
          ok: false,
          error: 'Household occupancy is owner-only.',
          recovery_hint: 'Only the owner tier can read the occupancy view.',
        };
      }

      const now_ms = ctx.now.getTime();
      // Resolve each member's home/away (async + needs the home anchor) — the
      // location-join input. Fail-open: no UserRegistry → sighting-only view.
      let locations: Awaited<ReturnType<typeof resolve_household_locations>> = [];
      if (deps.users) {
        try {
          locations = await resolve_household_locations(deps.users, owner_id, { now_ms });
        } catch {
          locations = [];
        }
      }

      const occ = ctx.memory.get_household_occupancy(owner_id, {
        window_minutes: input.window_minutes,
        locations,
        now_ms,
      });

      // Audit redaction: counts only — never names, appearance, or coordinates.
      ctx.memory.log_action({
        intent_id: ctx.intent_id,
        agent: ctx.specialist_id ?? 'cassandra',
        tool_name: 'household_occupancy',
        tool_input: { window_minutes: input.window_minutes },
        execution_result: {
          occupants: occ.occupants.length,
          unknown_present: occ.unknown_present.length,
          members_home: occ.household.filter((h) => h.presence === 'home').length,
          members_away: occ.household.filter((h) => h.presence === 'away').length,
        },
        user_id: owner_id,
      });

      const note =
        locations.length === 0
          ? 'Home/away presence is unavailable (no location source) — showing camera sightings only.'
          : undefined;

      return {
        ok: true,
        summary: summarize_occupancy(occ),
        window_minutes: occ.window_minutes,
        generated_at: occ.generated_at,
        occupants: occ.occupants.map((o) => ({
          name: o.name,
          relationship: o.relationship,
          zone: o.zone,
          last_seen_at: o.last_seen_at,
          seconds_ago: o.seconds_ago,
          appearance: o.appearance,
          presence: o.presence,
          is_household_member: o.household_user_id != null,
        })),
        unknown_present: occ.unknown_present.map((u) => ({
          zone: u.zone,
          last_seen_at: u.last_seen_at,
          seconds_ago: u.seconds_ago,
          appearance: u.appearance,
          sighting_count: u.sighting_count,
        })),
        household: occ.household.map((h) => ({
          name: h.display_name,
          presence: h.presence,
          last_zone: h.last_zone,
        })),
        ...(note ? { note } : {}),
      };
    },
  };
}
