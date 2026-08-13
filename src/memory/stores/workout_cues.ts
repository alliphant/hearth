/**
 * Workout cue-clip ledger (Live Ride Companion Phase 1 —
 * docs/design-astrid-live-companion.md §6.3).
 *
 * One row per synthesized Laur voice clip. The serving route
 * (GET /api/workout/cues/:clip_id) resolves rows here and enforces the
 * per-user cordon: a clip narrates someone's workout, so ONLY that
 * user may fetch it — no owner god-view.
 *
 * Self-creates its table (IF NOT EXISTS, additive — no SCHEMA_VERSION
 * bump). Clips are ephemeral: sweep() deletes rows AND files older
 * than CLIP_TTL_MS; both the live-throttle GC timer and any manual
 * caller go through it.
 */

import { rmSync } from 'node:fs';
import type { Database } from 'bun:sqlite';

export type CueClipFormat = 'opus_caf' | 'aac_m4a';

export interface CueClipRecord {
  clip_id: string;
  session_id: string;
  user_id: string;
  ts: string;
  trigger_id: string;
  text: string;
  format: CueClipFormat;
  duration_s: number | null;
  bytes: number;
  file_path: string;
}

export const CLIP_TTL_MS = 48 * 60 * 60 * 1000;

// Note: the column is trigger_id, not trigger — TRIGGER is an SQL keyword.
const DDL = `
CREATE TABLE IF NOT EXISTS workout_cue_clips (
  clip_id    TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  user_id    TEXT NOT NULL,
  ts         TEXT NOT NULL,
  trigger_id TEXT NOT NULL,
  text       TEXT NOT NULL,
  format     TEXT NOT NULL,
  duration_s REAL,
  bytes      INTEGER NOT NULL,
  file_path  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_workout_cue_clips_ts ON workout_cue_clips(ts);
`;

export function clip_content_type(format: CueClipFormat): string {
  return format === 'opus_caf' ? 'audio/x-caf' : 'audio/mp4';
}

export class WorkoutCueStore {
  constructor(private db: Database) {
    this.db.exec(DDL);
  }

  insert(rec: CueClipRecord): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO workout_cue_clips
           (clip_id, session_id, user_id, ts, trigger_id, text, format, duration_s, bytes, file_path)
         VALUES (@clip_id, @session_id, @user_id, @ts, @trigger_id, @text, @format, @duration_s, @bytes, @file_path)`,
      )
      .run({
        '@clip_id': rec.clip_id,
        '@session_id': rec.session_id,
        '@user_id': rec.user_id,
        '@ts': rec.ts,
        '@trigger_id': rec.trigger_id,
        '@text': rec.text,
        '@format': rec.format,
        '@duration_s': rec.duration_s,
        '@bytes': rec.bytes,
        '@file_path': rec.file_path,
      });
  }

  get(clip_id: string): CueClipRecord | null {
    const row = this.db
      .prepare('SELECT * FROM workout_cue_clips WHERE clip_id = @c')
      .get({ '@c': clip_id }) as CueClipRecord | null;
    return row ?? null;
  }

  /** Delete clips (rows + files) older than max_age_ms. Returns count. */
  sweep(max_age_ms: number = CLIP_TTL_MS): number {
    const cutoff = new Date(Date.now() - max_age_ms).toISOString();
    const rows = this.db
      .prepare('SELECT clip_id, file_path FROM workout_cue_clips WHERE ts < @cut')
      .all({ '@cut': cutoff }) as Array<{ clip_id: string; file_path: string }>;
    for (const r of rows) {
      try {
        rmSync(r.file_path, { force: true });
      } catch {
        // best-effort — the row delete below keeps the ledger honest
      }
    }
    this.db.prepare('DELETE FROM workout_cue_clips WHERE ts < @cut').run({ '@cut': cutoff });
    return rows.length;
  }
}
