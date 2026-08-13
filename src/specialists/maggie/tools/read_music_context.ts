/**
 * read_music_context — Maggie's read into the iOS-posted music snapshot.
 *
 * Replaces the deprecated server-side MusicKit JWT tools
 * (music_recent_tracks / music_heavy_rotation / music_top_artists from
 * src/connectors/listening.ts). The phone→Hearth music route is iOS's
 * MusicContextSensorFeeder reading on-device `MediaPlayer` /
 * `MPMediaQuery.songs()` and POSTing a daily snapshot to
 * /api/sensors/music_context. This tool reads back that snapshot via
 * `MemoryClient.query_music_context()` — same data the intake_band_poster
 * already uses for affinity scoring, now exposed at chat + deliberation
 * time.
 *
 * Empty-state behavior mirrors get_health_summary: returns
 * `empty: true` with empty arrays / null library_counts when no
 * snapshot has been received yet. Maggie keys "I don't have your
 * listening data yet" responses off `empty` rather than guessing.
 *
 * Capability: read_music_context. Per-user scope — same household
 * model as get_health_summary.
 */

import { z } from 'zod';
import { createHash } from 'node:crypto';
import type { Tool, ToolContext } from '@core/tool';
import type { ToolDeps } from '@core/tool_deps';

const InputSchema = z.object({
  user_id: z
    .string()
    .min(1)
    .describe(
      "The household-member id (e.g. 'jasper') whose music snapshot to read. " +
        "Use the conversation's user_id; do NOT default to 'jasper' when serving another household member.",
    ),
  limit_artists: z.coerce
    .number()
    .int()
    .min(0)
    .max(30)
    .default(15)
    .describe(
      'How many top artists (ranked by total play count across the on-device library) to include. ' +
        'iOS ships at most 30. 0 = omit the section.',
    ),
  limit_recently_played: z.coerce
    .number()
    .int()
    .min(0)
    .max(100)
    .default(25)
    .describe(
      'How many recently-played tracks (newest first, by lastPlayedDate) to include. ' +
        'iOS ships at most 100. 0 = omit the section.',
    ),
});

const TopArtistRow = z.object({
  artist: z.string(),
  play_count: z.number(),
  last_played: z.string().nullable(),
});

const RecentPlayRow = z.object({
  title: z.string(),
  artist: z.string(),
  album: z.string().nullable(),
  played_at: z.string(),
});

const LibraryCounts = z.object({
  songs: z.number(),
  albums: z.number(),
  artists: z.number(),
  playlists: z.number(),
});

const OutputSchema = z.object({
  user_id: z.string(),
  // True when no snapshot has been received yet (iOS app hasn't synced,
  // or this is a household member without an iPhone connected).
  empty: z.boolean(),
  // ISO timestamp the iOS feeder marked the snapshot. Older = staler.
  // iOS posts daily; >7d old means the app hasn't been opened.
  snapshot_taken_at: z.string().nullable(),
  // The window iOS used when aggregating. Currently the trailing 90
  // days (per MusicContextSensorFeeder); fixed by the iOS side.
  window_start: z.string().nullable(),
  window_end: z.string().nullable(),
  top_artists: z.array(TopArtistRow),
  recently_played: z.array(RecentPlayRow),
  library_counts: LibraryCounts.nullable(),
});

type Input = z.infer<typeof InputSchema>;
type Output = z.infer<typeof OutputSchema>;

export function create(deps: ToolDeps): Tool<Input, Output> {
  return {
    name: 'read_music_context',
    description:
      "Read the user's on-device music library snapshot (iOS posts daily from MediaPlayer — purchases + Apple Music library + iTunes Match downloads). Returns top artists by play count, most recently played tracks with timestamps, and library counts. This is THE phone→Hearth music signal and the replacement for the deprecated MusicKit JWT tools. Use for 'what have I been listening to', 'who am I into right now', 'what's in heavy rotation' (top_artists ARE heavy rotation — Apple Music doesn't expose a separate aggregate via this route), and library-size questions. Returns `empty: true` when iOS hasn't synced yet — answer honestly rather than guessing.",
    risk: 'read',
    required_capabilities: ['read_music_context'],
    input_schema: InputSchema,
    output_schema: OutputSchema,
    llm_budget: 'full',

    idempotency_key(input) {
      const h = createHash('sha256');
      h.update(input.user_id);
      h.update('\n');
      h.update(String(input.limit_artists));
      h.update('\n');
      h.update(String(input.limit_recently_played));
      return `read_music_context:${h.digest('hex').slice(0, 16)}`;
    },

    async execute(input, _ctx: ToolContext): Promise<Output> {
      const snap = deps.memory.query_music_context(input.user_id);
      if (!snap) {
        return {
          user_id: input.user_id,
          empty: true,
          snapshot_taken_at: null,
          window_start: null,
          window_end: null,
          top_artists: [],
          recently_played: [],
          library_counts: null,
        };
      }
      const p = snap.payload;
      return {
        user_id: input.user_id,
        empty: false,
        snapshot_taken_at: snap.captured_at,
        window_start: p.window_start,
        window_end: p.window_end,
        top_artists: p.top_artists.slice(0, input.limit_artists).map((r) => ({
          artist: r.artist,
          play_count: r.play_count,
          last_played: r.last_played ?? null,
        })),
        recently_played: p.recently_played
          .slice(0, input.limit_recently_played)
          .map((r) => ({
            title: r.title,
            artist: r.artist,
            album: r.album ?? null,
            played_at: r.played_at,
          })),
        library_counts: p.library_counts ?? null,
      };
    },
  };
}
