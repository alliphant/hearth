/**
 * Ruby — rebuild Jasper's learned location "corridors" from the location
 * sensor stream.
 *
 * Runs as a background job (see ruby.yaml `proactive.background_jobs`).
 * Reads the location sensor_packets for a lookback window, clusters the
 * points into corridors (the places he repeatedly goes), and full-replaces
 * the `location_corridors` table for the user. Civic items that geocode
 * onto a corridor get promoted in Ruby's office — "construction on a road
 * you actually drive" instead of generic city-wide noise.
 *
 * Refines over time: more location history → more corridors clear the
 * min-visit floor and their radii tighten. Early on (sparse history) it
 * may produce nothing, which is correct — a corridor has to be earned.
 *
 * Location is the most privileged data in the system. This tool is gated
 * on the `read_my_location` capability AND re-checks the privacy allowlist
 * (`location_specialist_allowed`) at runtime as defense-in-depth, returning
 * a structured error with a recovery hint rather than reading on denial.
 */

import { z } from 'zod';
import { createHash } from 'node:crypto';
import type { Tool, ToolContext } from '@core/tool';
import { cluster_corridors } from '@core/geo';
import { location_specialist_allowed } from '@core/privacy';
import { reverse_geocode_label } from '@connectors/maps';

const InputSchema = z.object({
  /** How far back to read location history. */
  lookback_days: z.number().int().min(7).max(365).default(60),
  /** Minimum repeat visits for a cluster to become a corridor (noise floor). */
  min_visits: z.number().int().min(2).max(50).default(3),
  /** Points within this many meters of a cluster centroid join it. */
  merge_radius_m: z.number().min(50).max(5_000).default(400),
});

const OutputSchema = z.object({
  ok: z.boolean(),
  corridors: z.number().optional(),
  points: z.number().optional(),
  error: z.string().optional(),
  /** When denied, where the grant lives. */
  recovery_hint: z.string().optional(),
});

type Input = z.infer<typeof InputSchema>;
type Output = z.infer<typeof OutputSchema>;

export const cluster_location_corridors: Tool<Input, Output> = {
  name: 'cluster_location_corridors',
  description:
    "Rebuild Jasper's learned location corridors from his location history so civic traffic/construction items can be matched to routes he actually travels. Background job; safe to run repeatedly.",
  risk: 'write_internal',
  required_capabilities: ['read_my_location'],
  input_schema: InputSchema,
  output_schema: OutputSchema,

  // ARMED. `replace_location_corridors` is DELETE-then-INSERT, so zero
  // corridors does not mean 'no new rows' — it means the table was WIPED.
  // This job also ran broken for its entire life (a UNIQUE collision threw
  // inside the rebuild transaction, rolling it back nightly, fixed
  // 2026-07-26) producing exactly this shape: points in, zero corridors out.
  yield: { produced: ['corridors'], considered: ['points'] },
  idempotency_key(input) {
    const h = createHash('sha256');
    h.update(`${input.lookback_days}:${input.min_visits}:${input.merge_radius_m}`);
    return `cluster_location_corridors:${h.digest('hex').slice(0, 16)}`;
  },

  async execute(input, ctx: ToolContext): Promise<Output> {
    // This rebuild runs as a scheduled background job, whose ToolContext
    // carries no turn-user — so `ctx.user` is undefined and this tool used to
    // bail on EVERY run ("No user in context"), which is why location_corridors
    // never populated despite weeks of location history. Fall back to the
    // configured owner, the same single-owner pattern sensor_calendar / maps /
    // weather already use. Revisit when per-user background jobs land.
    const user_id = ctx.user?.id ?? process.env.HEARTH_OWNER_USER_ID ?? 'jasper';

    const specialist_id = ctx.specialist_id ?? 'ruby';
    if (!location_specialist_allowed(specialist_id)) {
      return {
        ok: false,
        error: `Location access not granted to ${specialist_id}.`,
        recovery_hint:
          'Add the specialist to cross_specialist_sharing.read_my_location_granted_to in config/privacy.yaml.',
      };
    }

    const since_iso = new Date(
      ctx.now.getTime() - input.lookback_days * 24 * 60 * 60 * 1000,
    ).toISOString();
    const points = ctx.memory.list_location_points(user_id, since_iso);
    const corridors = cluster_corridors(points, {
      merge_radius_m: input.merge_radius_m,
      min_visits: input.min_visits,
    });
    // Upgrade machine labels ("Frequent area N" / a raw place_id) to a
    // human street/neighbourhood name via reverse geocoding. Best-effort,
    // sequential — the corridor set is tiny (a handful) so this is gentle
    // on the local Nominatim, and a null just keeps the fallback label.
    //
    // Labels MUST stay unique: location_corridors has UNIQUE(user_id, label),
    // and reverse geocoding is many-to-one — two clusters a few blocks apart
    // resolve to the SAME street/neighbourhood name. That collision threw
    // inside replace_location_corridors' transaction, so the whole rebuild
    // rolled back and the table stayed EMPTY from the day this job was written
    // ("background_job ruby/rebuild_location_corridors failed (execute):
    // UNIQUE constraint failed" nightly). Empty corridors → /api/sensors/places/monitored
    // returned only the home region → iOS had almost nothing to geofence.
    // Disambiguate with a suffix instead of dropping the duplicate: the two
    // clusters are genuinely different places that happen to share a name.
    const used = new Set<string>();
    for (const c of corridors) {
      const label = await reverse_geocode_label(c.center_lat, c.center_lon);
      if (label) c.label = label;
      let candidate = c.label;
      for (let n = 2; used.has(candidate); n += 1) candidate = `${c.label} (${n})`;
      used.add(candidate);
      c.label = candidate;
    }
    ctx.memory.replace_location_corridors(user_id, corridors);

    ctx.memory.log_action({
      intent_id: ctx.intent_id,
      agent: specialist_id,
      tool_name: 'cluster_location_corridors',
      tool_input: { lookback_days: input.lookback_days, min_visits: input.min_visits },
      // Audit redaction: count only, never the coordinates themselves.
      execution_result: { corridors: corridors.length, points: points.length },
      user_id,
    });

    return { ok: true, corridors: corridors.length, points: points.length };
  },
};
