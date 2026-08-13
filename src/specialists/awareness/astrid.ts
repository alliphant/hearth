/**
 * Astrid's awareness handler — watches new HealthKit packets for
 * workout completions and (when active calories exceed the per-user
 * threshold) flags Brigid for a recovery snack.
 *
 * The loop driver invokes `run()` every ~60s. State across invocations
 * is the `last_run_at` cursor — we only consider packets received since
 * the last fire to avoid re-flagging the same workout.
 *
 * One observation per tick (the AwarenessHandler interface returns at
 * most one). When multiple workouts crossed threshold in the same tick
 * (rare but possible — backfill replay after iOS reconnect), we flag on
 * the most recent + log the rest for the next pass via the summary text.
 *
 * The persona-side protocol for Brigid is encoded in Brigid's YAML —
 * she reads her inbox via the structural knowledge floor on every chat
 * turn, sees Astrid's flag, and proposes a snack.
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AwarenessHandler, AwarenessHandlerDeps, AwarenessObservation } from '@core/loops';
import { WorkoutValueSchema, type WorkoutValue } from '../../app/routes/sensors';

const DEFAULT_THRESHOLD_KCAL = 400;

interface PacketRow {
  id: string;
  user_id: string;
  captured_at: string;
  received_at: string;
  payload_path: string;
}

interface HealthkitPayloadShape {
  sample_type: string;
  ts_start: string;
  ts_end: string;
  value: unknown;
}

function load_payload(vault_root: string, rel_path: string): HealthkitPayloadShape | null {
  const abs = resolve(vault_root, rel_path);
  if (!existsSync(abs)) return null;
  try {
    return JSON.parse(readFileSync(abs, 'utf8')) as HealthkitPayloadShape;
  } catch {
    return null;
  }
}

function vault_root_from(deps: AwarenessHandlerDeps): string {
  // MemoryClient carries the configured vault root on its cfg field —
  // matches the pattern iris.ts uses (and avoids a separate orchestrator
  // wiring step).
  return (deps.memory as unknown as { cfg: { vault_root: string } }).cfg.vault_root;
}

function threshold_for(user_id: string, deps: AwarenessHandlerDeps): number {
  const cfg = deps.users?.get(user_id);
  const override = cfg?.training?.recovery_snack_threshold_kcal;
  if (override != null && override > 0) return override;
  return DEFAULT_THRESHOLD_KCAL;
}

function format_duration_min(s: number): string {
  const mins = Math.round(s / 60);
  if (mins < 60) return `${mins}-min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m === 0 ? `${h}h` : `${h}h${m}m`;
}

function format_brigid_flag_body(args: {
  user_display: string;
  workout: WorkoutValue;
  ts_end_iso: string;
}): string {
  const { user_display, workout, ts_end_iso } = args;
  const end_local = ts_end_iso.slice(11, 16); // HH:MM UTC — Brigid renders her own local-time view
  const duration = format_duration_min(workout.duration_s);
  const kcal = Math.round(workout.active_kcal);
  // Crude but useful macro guidance — 25-30g carbs + 10-15g protein on a
  // ~250 kcal snack is the standard post-workout recovery shape. Astrid's
  // persona owns the "how aggressive" call; this is the default Brigid
  // sees if she just goes with it.
  const target_kcal = Math.min(300, Math.max(200, Math.round(kcal * 0.3)));
  return (
    `${user_display} just finished a ${duration} ${workout.workout_type} ` +
    `(active: ${kcal} kcal, ended ~${end_local}Z). Recovery snack suggestion: ` +
    `~${target_kcal} kcal, ~25-30g carbs + ~10-15g protein. Pantry-first if you can — ` +
    `propose via your usual chat flow when ${user_display} next talks to you. — Astrid`
  );
}

export const astrid_awareness: AwarenessHandler = {
  specialist_id: 'astrid',
  async run(deps: AwarenessHandlerDeps): Promise<AwarenessObservation | null> {
    try {
      const last_iso = (deps.last_run_at ?? new Date(Date.now() - 5 * 60 * 1000)).toISOString();
      const root = vault_root_from(deps);

      // Pull all healthkit packets received since last_run, scanning for
      // workout-shaped ones. Cursor by `received_at` (not captured_at) so
      // a backfill replay after an iOS reconnect still gets picked up.
      const rows = deps.db
        .prepare(
          `SELECT id, user_id, captured_at, received_at, payload_path
           FROM sensor_packets
           WHERE signal = 'healthkit' AND received_at > @since
           ORDER BY received_at ASC`,
        )
        .all({ '@since': last_iso }) as PacketRow[];

      if (rows.length === 0) return null;

      // Find new workout packets that crossed their user's threshold.
      interface Hit {
        row: PacketRow;
        workout: WorkoutValue;
      }
      const hits: Hit[] = [];
      for (const row of rows) {
        const payload = load_payload(root, row.payload_path);
        if (!payload || payload.sample_type !== 'workout') continue;
        const parsed = WorkoutValueSchema.safeParse(payload.value);
        if (!parsed.success) continue;
        const threshold = threshold_for(row.user_id, deps);
        if (parsed.data.active_kcal >= threshold) {
          hits.push({ row, workout: parsed.data });
        }
      }

      if (hits.length === 0) return null;

      // Flag the most recent crossing-threshold workout to Brigid.
      // Multiple hits in the same tick get a "(plus N earlier today)" tag
      // in the summary so Brigid sees the wave; per-hit fan-out would
      // require either restructuring the return type or queueing — kept
      // simple for v0.5.
      hits.sort((a, b) => (a.row.received_at < b.row.received_at ? 1 : -1));
      const primary = hits[0]!;
      const user_cfg = deps.users?.get(primary.row.user_id);
      const user_display = user_cfg?.display_name ?? primary.row.user_id;

      const payload = load_payload(root, primary.row.payload_path)!;
      const body = format_brigid_flag_body({
        user_display,
        workout: primary.workout,
        ts_end_iso: payload.ts_end,
      });
      const extra = hits.length > 1 ? ` (plus ${hits.length - 1} earlier workout(s) today)` : '';

      return {
        ts: new Date().toISOString(),
        summary: body + extra,
        severity: 'medium',
        suggests_inbox_to: 'brigid',
        details: {
          user_id: primary.row.user_id,
          workout_type: primary.workout.workout_type,
          active_kcal: primary.workout.active_kcal,
          duration_s: primary.workout.duration_s,
          threshold_kcal: threshold_for(primary.row.user_id, deps),
          additional_hits: hits.length - 1,
        },
      };
    } catch (err) {
      return {
        ts: new Date().toISOString(),
        summary: 'astrid awareness handler error',
        severity: 'low',
        details: { error_message: err instanceof Error ? err.message : String(err) },
      };
    }
  },
};
