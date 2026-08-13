/**
 * plex.ts — Plex + Tautulli connector.
 *
 * Maggie's consumption-signal surface. The *arr stack tells her what's in
 * the library; this connector tells her what was actually watched/played
 * and how often. Two upstream services, one connector — to Maggie's
 * mental model, "Plex" is the surface and Tautulli is implementation:
 *
 *   - Tautulli  (http://your-llm-host.local:8181) — watch history, heavy
 *     rotation, per-user breakdowns. Stores everything in its own SQLite
 *     so the data doesn't get pruned. THE primary source for "what does
 *     Jasper watch."
 *   - Plex direct (http://your-llm-host.local:32400) — library/file metadata,
 *     live sessions, on-deck carousel, user ratings. Used where Tautulli
 *     doesn't expose the shape (codec/quality/rating) or where freshness
 *     matters (currently playing).
 *
 * Auth:
 *   PLEX_URL / PLEX_TOKEN        — X-Plex-Token header
 *   TAUTULLI_URL / TAUTULLI_API_KEY — apikey query param
 *
 * User scoping: PLEX_USER (optional) filters Tautulli queries to Jasper
 * by default; tools accept `user?` to override (per-household-member
 * lookups, "what did Mira watch this week").
 *
 * Capabilities (config/capabilities.yaml extensions):
 *   - read_plex_consumption — Tautulli history / heavy rotation / users
 *   - read_plex_library     — Plex direct library / sessions / ratings
 *
 * Maggie holds both. Cordelia (the Librarian) holds read_plex_consumption
 * so she can reason about acquisition priorities ("the household watched
 * three Villeneuve films this quarter; the new one would land well").
 */

import { z } from 'zod';
import { createHash } from 'node:crypto';
import type { Tool, ToolContext } from '@core/tool';
import type { ToolDeps } from '@core/tool_deps';
import { audit_connector, safe_fetch } from './_audit';
import { require_caller_tier } from '@core/tool_gates';
import { local_iso_date } from '@core/time';
import type { ScreenPlayRow } from '@core/taste_sources';

// ── config ──────────────────────────────────────────────────────────────

interface PlexConfig {
  plex_url: string;
  plex_token: string;
  tautulli_url: string;
  tautulli_key: string;
  /** Default Tautulli user to filter to. Empty = all users. */
  default_user: string;
}

function load_config(): PlexConfig {
  return {
    plex_url: (process.env.PLEX_URL ?? 'http://your-llm-host.local:32400').replace(/\/+$/, ''),
    plex_token: process.env.PLEX_TOKEN ?? '',
    tautulli_url: (process.env.TAUTULLI_URL ?? 'http://your-llm-host.local:8181').replace(/\/+$/, ''),
    tautulli_key: process.env.TAUTULLI_API_KEY ?? '',
    default_user: process.env.PLEX_USER ?? '',
  };
}

// ── HTTP helpers ────────────────────────────────────────────────────────

interface UpstreamResult<T = unknown> {
  ok: boolean;
  status?: number;
  data?: T;
  error?: string;
}

async function plex_fetch<T = unknown>(
  cfg: PlexConfig,
  path: string,
): Promise<UpstreamResult<T>> {
  if (!cfg.plex_token) {
    return {
      ok: false,
      error:
        'Plex is not configured — set PLEX_URL and PLEX_TOKEN in .env and restart the orchestrator.',
    };
  }
  const url = `${cfg.plex_url}${path}`;
  const res = await safe_fetch(
    url,
    {
      headers: {
        'X-Plex-Token': cfg.plex_token,
        Accept: 'application/json',
      },
    },
    15_000,
  );
  if (!res.ok) {
    return {
      ok: false,
      status: res.status,
      error: res.error ?? `Plex HTTP ${res.status}: ${res.body.slice(0, 300)}`,
    };
  }
  try {
    return { ok: true, status: res.status, data: (res.body ? JSON.parse(res.body) : null) as T };
  } catch (err) {
    return { ok: false, error: `Plex: unparseable response — ${(err as Error).message}` };
  }
}

/** Test seam — replaces the live Tautulli HTTP hop (after the key gate) so
 *  smokes can feed fixture payloads without a server. Mirrors the
 *  `_test_set_vl_transport` pattern. */
type TautulliTestTransport = (
  cmd: string,
  params: Record<string, string | number | undefined>,
) => Promise<UpstreamResult<unknown>>;
let _tautulli_test_transport: TautulliTestTransport | null = null;
export function _test_set_tautulli_transport(fn: TautulliTestTransport | null): void {
  _tautulli_test_transport = fn;
}

async function tautulli_fetch<T = unknown>(
  cfg: PlexConfig,
  cmd: string,
  params: Record<string, string | number | undefined> = {},
): Promise<UpstreamResult<T>> {
  if (!cfg.tautulli_key) {
    return {
      ok: false,
      error:
        'Tautulli is not configured — set TAUTULLI_URL and TAUTULLI_API_KEY in .env and restart the orchestrator.',
    };
  }
  if (_tautulli_test_transport) {
    return (await _tautulli_test_transport(cmd, params)) as UpstreamResult<T>;
  }
  const qs = new URLSearchParams({ apikey: cfg.tautulli_key, cmd });
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== '') qs.set(k, String(v));
  }
  const url = `${cfg.tautulli_url}/api/v2?${qs.toString()}`;
  const res = await safe_fetch(url, {}, 20_000);
  if (!res.ok) {
    return {
      ok: false,
      status: res.status,
      error: res.error ?? `Tautulli HTTP ${res.status}: ${res.body.slice(0, 300)}`,
    };
  }
  let parsed: { response?: { result?: string; message?: string; data?: T } };
  try {
    parsed = JSON.parse(res.body);
  } catch (err) {
    return { ok: false, error: `Tautulli: unparseable response — ${(err as Error).message}` };
  }
  const inner = parsed.response;
  if (!inner || inner.result !== 'success') {
    return {
      ok: false,
      error: `Tautulli ${cmd}: ${inner?.message ?? 'unexpected response shape'}`,
    };
  }
  return { ok: true, status: res.status, data: inner.data as T };
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : v == null ? '' : String(v);
}
function num(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return null;
}
function iso_from_unix(s: unknown): string {
  const n = num(s);
  if (n == null || n <= 0) return '';
  return new Date(n * 1000).toISOString();
}

// ── plex_history (Tautulli get_history) ─────────────────────────────────

const MediaTypeEnum = z.enum(['all', 'movie', 'episode', 'track']);

const HistoryInput = z.object({
  days: z.coerce
    .number()
    .int()
    .min(1)
    .max(365)
    .default(30)
    .describe('How many days back to look. Defaults to 30.'),
  media_type: MediaTypeEnum.default('all').describe(
    "Filter by what kind of play: 'movie' (film), 'episode' (TV), 'track' (music), or 'all'.",
  ),
  user: z
    .string()
    .optional()
    .describe(
      "Tautulli username to filter to. Defaults to PLEX_USER env (Jasper). Pass another household member's username to look at theirs; pass '' to see all users.",
    ),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(200)
    .default(50)
    .describe('Max rows to return. Defaults to 50.'),
});

const HistoryRow = z.object({
  watched_at: z.string().describe('ISO timestamp of the play.'),
  title: z.string().describe('Display title — episode / movie / track.'),
  parent_title: z.string().describe('Album / season / show parent, if applicable.'),
  grandparent_title: z.string().describe('Artist / show grandparent, if applicable.'),
  media_type: z.string(),
  user: z.string(),
  watched_fraction: z.number().nullable().describe('0–1 fraction of the item watched.'),
  duration_seconds: z.number().nullable(),
});

const HistoryOutput = z.object({
  count: z.number(),
  total_in_range: z.number(),
  user_filter: z.string(),
  items: z.array(HistoryRow),
  error: z.string().optional(),
});

type HistoryInputT = z.infer<typeof HistoryInput>;
type HistoryOutputT = z.infer<typeof HistoryOutput>;

function project_history_row(o: Record<string, unknown>): z.infer<typeof HistoryRow> {
  const paused = num(o.paused_counter) ?? 0;
  const view_offset = num(o.view_offset);
  const duration = num(o.duration);
  let fraction: number | null = null;
  if (view_offset != null && duration != null && duration > 0) {
    fraction = Math.max(0, Math.min(1, view_offset / duration));
  } else if (o.watched_status === 1 || str(o.watched_status) === 'watched') {
    fraction = 1;
  }
  return {
    watched_at: iso_from_unix(o.stopped ?? o.date),
    title: str(o.title),
    parent_title: str(o.parent_title),
    grandparent_title: str(o.grandparent_title),
    media_type: str(o.media_type),
    user: str(o.friendly_name) || str(o.user),
    watched_fraction: fraction,
    duration_seconds: duration != null ? Math.round(duration / 1000) : null,
    ...(paused > 0 ? {} : {}),
  };
}

function days_ago_iso_date(days: number): string {
  return local_iso_date(new Date(Date.now() - days * 86_400_000));
}

function create_plex_history(cfg: PlexConfig): Tool<HistoryInputT, HistoryOutputT> {
  return {
    name: 'plex_history',
    description:
      "Read Plex watch history from Tautulli. Returns plays in the window: " +
      "what was watched/played, when, by whom, how completely. Defaults to " +
      "Jasper's plays for the last 30 days across movies, TV, and music. Use " +
      "this as Maggie's primary 'what does Jasper actually consume' source — " +
      "the *arr library tells you what's available, this tells you what " +
      "stuck. For top-N aggregates use plex_heavy_rotation instead.",
    risk: 'read',
    required_capabilities: ['read_plex_consumption'],
    input_schema: HistoryInput,
    output_schema: HistoryOutput,

    idempotency_key(input) {
      return `plex_history:${input.user ?? cfg.default_user}:${input.media_type}:${input.days}:${input.limit}`;
    },

    async execute(input, ctx: ToolContext): Promise<HistoryOutputT> {
      // Phase 2b/4 — household tier OK (shared listening signal),
      // friend tier blocked (Jasper's consumption isn't theirs to see).
      require_caller_tier(ctx, ['owner', 'household']);
      const user = input.user !== undefined ? input.user : cfg.default_user;
      // Tautulli range semantics: `after` = plays since this date. (`start_date`
      // filters to that EXACT day — it silently returned ~0 rows here, verified
      // live 2026-07-04.)
      const params: Record<string, string | number | undefined> = {
        length: input.limit,
        order_column: 'date',
        order_dir: 'desc',
        after: days_ago_iso_date(input.days),
      };
      if (user) params.user = user;
      if (input.media_type !== 'all') params.media_type = input.media_type;

      const res = await tautulli_fetch<{ data?: Record<string, unknown>[]; recordsFiltered?: number }>(
        cfg,
        'get_history',
        params,
      );
      const audit = (out: HistoryOutputT): HistoryOutputT => {
        audit_connector(
          { memory: ctx.memory, agent: ctx.specialist_id ?? 'connector', intent_id: ctx.intent_id },
          'plex_history',
          { days: input.days, media_type: input.media_type, user_filter: user || '<all>', limit: input.limit },
          { count: out.count, total_in_range: out.total_in_range },
          out.error,
        );
        return out;
      };
      if (!res.ok) {
        return audit({ count: 0, total_in_range: 0, user_filter: user || '<all>', items: [], error: res.error });
      }
      const rows = Array.isArray(res.data?.data) ? res.data!.data! : [];
      const items = rows.slice(0, input.limit).map((r) => project_history_row(r));
      return audit({
        count: items.length,
        total_in_range: num(res.data?.recordsFiltered) ?? items.length,
        user_filter: user || '<all>',
        items,
      });
    },
  };
}

// ── plex_heavy_rotation (Tautulli get_home_stats) ───────────────────────

const StatTypeEnum = z.enum(['plays', 'duration']);
const StatCardEnum = z.enum([
  'top_movies',
  'popular_movies',
  'top_tv',
  'popular_tv',
  'top_music',
  'popular_music',
  'top_artists',
  'top_users',
]);

const HeavyRotationInput = z.object({
  window_days: z.coerce
    .number()
    .int()
    .min(1)
    .max(365)
    .default(30)
    .describe(
      "Window in days for the 'home stats' aggregation. Tautulli's UI " +
        'uses 7, 30, 90, 365 — same idea here.',
    ),
  stat: StatCardEnum.default('top_artists').describe(
    "Which leaderboard. 'top_artists' is Maggie's go-to for the concert-" +
      "alignment workflow; 'top_tv' / 'top_movies' for screen recs; " +
      "'top_music' for individual tracks; 'top_users' for per-household " +
      "consumption shape.",
  ),
  count: z.coerce.number().int().min(1).max(25).default(10),
  stat_type: StatTypeEnum.default('plays').describe(
    "Rank by 'plays' (count) or 'duration' (total time). Music almost " +
      "always wants plays; long-form TV / movies often want duration so " +
      "a single-finished-series doesn't beat a binge.",
  ),
});

const HeavyRotationRow = z.object({
  title: z.string(),
  parent_title: z.string(),
  grandparent_title: z.string(),
  plays: z.number().nullable(),
  duration_seconds: z.number().nullable(),
  last_played: z.string(),
});

const HeavyRotationOutput = z.object({
  stat: z.string(),
  window_days: z.number(),
  items: z.array(HeavyRotationRow),
  error: z.string().optional(),
});

type HeavyRotationInputT = z.infer<typeof HeavyRotationInput>;
type HeavyRotationOutputT = z.infer<typeof HeavyRotationOutput>;

function project_home_stat_row(o: Record<string, unknown>): z.infer<typeof HeavyRotationRow> {
  const duration = num(o.total_duration);
  return {
    title: str(o.title),
    parent_title: str(o.parent_title),
    grandparent_title: str(o.grandparent_title),
    plays: num(o.total_plays),
    duration_seconds: duration != null ? Math.round(duration) : null,
    last_played: iso_from_unix(o.last_play),
  };
}

function create_plex_heavy_rotation(
  cfg: PlexConfig,
): Tool<HeavyRotationInputT, HeavyRotationOutputT> {
  return {
    name: 'plex_heavy_rotation',
    description:
      "Tautulli's 'Home Stats' leaderboard — the closest thing Plex has to " +
      "Apple Music's Heavy Rotation. Returns the top N items in the window: " +
      "top artists, top tracks, top TV shows, top movies, popular variants, " +
      "or top users. Use this when you want 'what is Jasper most into right " +
      "now' rather than a chronological history. Defaults to top_artists / " +
      '30-day / 10 results, ranked by play count.',
    risk: 'read',
    required_capabilities: ['read_plex_consumption'],
    input_schema: HeavyRotationInput,
    output_schema: HeavyRotationOutput,

    idempotency_key(input) {
      return `plex_heavy_rotation:${input.stat}:${input.window_days}:${input.count}:${input.stat_type}`;
    },

    async execute(input, ctx: ToolContext): Promise<HeavyRotationOutputT> {
      // Phase 2b/4 — household tier OK (shared listening signal),
      // friend tier blocked (Jasper's consumption isn't theirs to see).
      require_caller_tier(ctx, ['owner', 'household']);
      const res = await tautulli_fetch<Array<{ stat_id?: string; rows?: Record<string, unknown>[] }>>(
        cfg,
        'get_home_stats',
        {
          time_range: input.window_days,
          stats_count: input.count,
          stats_type: input.stat_type,
          stats_cards: input.stat,
          grouping: 1,
        },
      );
      const audit = (out: HeavyRotationOutputT): HeavyRotationOutputT => {
        audit_connector(
          { memory: ctx.memory, agent: ctx.specialist_id ?? 'connector', intent_id: ctx.intent_id },
          'plex_heavy_rotation',
          { stat: input.stat, window_days: input.window_days, count: input.count, stat_type: input.stat_type },
          { item_count: out.items.length },
          out.error,
        );
        return out;
      };
      if (!res.ok) {
        return audit({ stat: input.stat, window_days: input.window_days, items: [], error: res.error });
      }
      const cards = Array.isArray(res.data) ? res.data : [];
      const card = cards.find((c) => c.stat_id === input.stat);
      const rows = card?.rows ?? [];
      return audit({
        stat: input.stat,
        window_days: input.window_days,
        items: rows.slice(0, input.count).map(project_home_stat_row),
      });
    },
  };
}

// ── plex_now_playing (Plex direct) ──────────────────────────────────────

const NowPlayingInput = z.object({}).strict();
const NowPlayingSession = z.object({
  user: z.string(),
  title: z.string(),
  parent_title: z.string(),
  grandparent_title: z.string(),
  media_type: z.string(),
  progress_fraction: z.number().nullable(),
  player: z.string().describe('Plex client / device playing it.'),
  state: z.string().describe('playing / paused / buffering.'),
});
const NowPlayingOutput = z.object({
  count: z.number(),
  sessions: z.array(NowPlayingSession),
  error: z.string().optional(),
});

type NowPlayingInputT = z.infer<typeof NowPlayingInput>;
type NowPlayingOutputT = z.infer<typeof NowPlayingOutput>;

function create_plex_now_playing(
  cfg: PlexConfig,
): Tool<NowPlayingInputT, NowPlayingOutputT> {
  return {
    name: 'plex_now_playing',
    description:
      'List currently-playing Plex sessions across the household. Empty if ' +
      'nothing is active. Use when freshness matters (Jasper just asked ' +
      "what's on right now); use plex_history for past plays.",
    risk: 'read',
    required_capabilities: ['read_plex_library'],
    input_schema: NowPlayingInput,
    output_schema: NowPlayingOutput,

    idempotency_key() {
      return 'plex_now_playing';
    },

    async execute(_input, ctx: ToolContext): Promise<NowPlayingOutputT> {
      // Phase 2b/4 — household tier OK (shared listening signal),
      // friend tier blocked (Jasper's consumption isn't theirs to see).
      require_caller_tier(ctx, ['owner', 'household']);
      const res = await plex_fetch<{ MediaContainer?: { Metadata?: Record<string, unknown>[] } }>(
        cfg,
        '/status/sessions',
      );
      const audit = (out: NowPlayingOutputT): NowPlayingOutputT => {
        audit_connector(
          { memory: ctx.memory, agent: ctx.specialist_id ?? 'connector', intent_id: ctx.intent_id },
          'plex_now_playing',
          {},
          { session_count: out.count },
          out.error,
        );
        return out;
      };
      if (!res.ok) return audit({ count: 0, sessions: [], error: res.error });
      const metas = res.data?.MediaContainer?.Metadata ?? [];
      const sessions = metas.map((m) => {
        const user = (m.User as { title?: string } | undefined)?.title ?? '';
        const player = (m.Player as { title?: string; state?: string } | undefined) ?? {};
        const view_offset = num(m.viewOffset);
        const duration = num(m.duration);
        const fraction =
          view_offset != null && duration != null && duration > 0
            ? Math.max(0, Math.min(1, view_offset / duration))
            : null;
        return {
          user: str(user),
          title: str(m.title),
          parent_title: str(m.parentTitle),
          grandparent_title: str(m.grandparentTitle),
          media_type: str(m.type),
          progress_fraction: fraction,
          player: str(player.title),
          state: str(player.state),
        };
      });
      return audit({ count: sessions.length, sessions });
    },
  };
}

// ── plex_library (Plex direct — section listings + metadata) ────────────

const SectionKindEnum = z.enum(['movie', 'show', 'artist', 'all']);

const LibraryInput = z.object({
  kind: SectionKindEnum.default('all').describe(
    "Which section kind to list: 'movie' (films), 'show' (TV), 'artist' " +
      "(music), or 'all'. Returns the section index, not item lists — for " +
      'item enumeration call again with the section id (future param) or ' +
      'use plex_history / plex_heavy_rotation.',
  ),
});

const LibrarySection = z.object({
  id: z.string(),
  title: z.string(),
  kind: z.string(),
  item_count: z.number().nullable(),
  updated_at: z.string(),
});

const LibraryOutput = z.object({
  count: z.number(),
  sections: z.array(LibrarySection),
  error: z.string().optional(),
});

type LibraryInputT = z.infer<typeof LibraryInput>;
type LibraryOutputT = z.infer<typeof LibraryOutput>;

function create_plex_library(cfg: PlexConfig): Tool<LibraryInputT, LibraryOutputT> {
  return {
    name: 'plex_library',
    description:
      'List Plex library sections (movies, shows, music) with item counts ' +
      'and last-updated timestamps. Lightweight catalog overview — use ' +
      'when you need to know what libraries exist and how big they are; ' +
      'for actual item-level metadata reach into the *arr stack with ' +
      "media_library instead (that's where quality/codec/file paths live).",
    risk: 'read',
    required_capabilities: ['read_plex_library'],
    input_schema: LibraryInput,
    output_schema: LibraryOutput,

    idempotency_key(input) {
      return `plex_library:${input.kind}`;
    },

    async execute(input, ctx: ToolContext): Promise<LibraryOutputT> {
      // Phase 2b/4 — household tier OK (shared listening signal),
      // friend tier blocked (Jasper's consumption isn't theirs to see).
      require_caller_tier(ctx, ['owner', 'household']);
      const res = await plex_fetch<{ MediaContainer?: { Directory?: Record<string, unknown>[] } }>(
        cfg,
        '/library/sections',
      );
      const audit = (out: LibraryOutputT): LibraryOutputT => {
        audit_connector(
          { memory: ctx.memory, agent: ctx.specialist_id ?? 'connector', intent_id: ctx.intent_id },
          'plex_library',
          { kind: input.kind },
          { section_count: out.count },
          out.error,
        );
        return out;
      };
      if (!res.ok) return audit({ count: 0, sections: [], error: res.error });
      const dirs = res.data?.MediaContainer?.Directory ?? [];
      const filtered = input.kind === 'all' ? dirs : dirs.filter((d) => str(d.type) === input.kind);
      const sections = filtered.map((d) => ({
        id: str(d.key),
        title: str(d.title),
        kind: str(d.type),
        item_count: num((d as { count?: unknown }).count),
        updated_at: iso_from_unix(d.updatedAt),
      }));
      return audit({ count: sections.length, sections });
    },
  };
}

// ── plex_ratings (Plex direct — user-rated items) ───────────────────────

const RatingsInput = z.object({
  kind: SectionKindEnum.default('all').describe(
    "Which section kind to pull ratings from: 'movie', 'show', 'artist', or 'all'.",
  ),
  min_rating: z.coerce
    .number()
    .min(0)
    .max(10)
    .default(0)
    .describe('Minimum user rating (0–10 in Plex). 0 returns everything rated.'),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

const RatingRow = z.object({
  title: z.string(),
  parent_title: z.string(),
  grandparent_title: z.string(),
  kind: z.string(),
  rating: z.number().nullable(),
  rated_at: z.string(),
});

const RatingsOutput = z.object({
  count: z.number(),
  items: z.array(RatingRow),
  error: z.string().optional(),
});

type RatingsInputT = z.infer<typeof RatingsInput>;
type RatingsOutputT = z.infer<typeof RatingsOutput>;

function create_plex_ratings(cfg: PlexConfig): Tool<RatingsInputT, RatingsOutputT> {
  return {
    name: 'plex_ratings',
    description:
      "Read Jasper's explicit Plex user ratings (the 1–10 star scores he's " +
      'given to items). Sparser than watch history — most things are ' +
      "unrated — but high-signal where present. Use this to anchor a " +
      "taste profile in 'here are titles Jasper actively flagged as good or " +
      "bad' rather than just 'here are titles he played'.",
    risk: 'read',
    required_capabilities: ['read_plex_library'],
    input_schema: RatingsInput,
    output_schema: RatingsOutput,

    idempotency_key(input) {
      return `plex_ratings:${input.kind}:${input.min_rating}:${input.limit}`;
    },

    async execute(input, ctx: ToolContext): Promise<RatingsOutputT> {
      // Phase 2b/4 — household tier OK (shared listening signal),
      // friend tier blocked (Jasper's consumption isn't theirs to see).
      require_caller_tier(ctx, ['owner', 'household']);
      const sections = await plex_fetch<{ MediaContainer?: { Directory?: Record<string, unknown>[] } }>(
        cfg,
        '/library/sections',
      );
      const audit = (out: RatingsOutputT): RatingsOutputT => {
        audit_connector(
          { memory: ctx.memory, agent: ctx.specialist_id ?? 'connector', intent_id: ctx.intent_id },
          'plex_ratings',
          { kind: input.kind, min_rating: input.min_rating, limit: input.limit },
          { item_count: out.count },
          out.error,
        );
        return out;
      };
      if (!sections.ok) return audit({ count: 0, items: [], error: sections.error });
      const dirs = sections.data?.MediaContainer?.Directory ?? [];
      const target = input.kind === 'all' ? dirs : dirs.filter((d) => str(d.type) === input.kind);

      const out: z.infer<typeof RatingRow>[] = [];
      for (const d of target) {
        if (out.length >= input.limit) break;
        const sec_id = str(d.key);
        const sec_kind = str(d.type);
        const path = `/library/sections/${sec_id}/all?userRating>>=${input.min_rating}&sort=userRating:desc&X-Plex-Container-Size=${input.limit - out.length}`;
        const items = await plex_fetch<{ MediaContainer?: { Metadata?: Record<string, unknown>[] } }>(
          cfg,
          path,
        );
        if (!items.ok) continue;
        for (const m of items.data?.MediaContainer?.Metadata ?? []) {
          const rating = num(m.userRating);
          if (rating == null || rating < input.min_rating) continue;
          out.push({
            title: str(m.title),
            parent_title: str(m.parentTitle),
            grandparent_title: str(m.grandparentTitle),
            kind: sec_kind,
            rating,
            rated_at: iso_from_unix(m.lastRatedAt),
          });
          if (out.length >= input.limit) break;
        }
      }
      return audit({ count: out.length, items: out });
    },
  };
}

// ── taste-sweep read (per-user model Phase B, 2026-07-04) ───────────────

/**
 * Watch-history rows for the `screen_taste` facet — an internal read the
 * 03:30 `sweep_user_models` job calls directly, NOT a Tool (no LLM surface,
 * no capability; the sweep's own audit row covers it). Fail-open by
 * contract: Tautulli unconfigured or ANY fetch error → null, so the facet
 * self-gates to a no-op — and a partial fetch (episodes landed, movies
 * errored) also returns null rather than distilling a skewed half-picture.
 * Filters to PLEX_USER by default (the owner's Tautulli identity); an empty
 * filter means a single-account household.
 */
export async function fetch_screen_history_for_taste(
  opts: { days?: number; limit_per_type?: number; user?: string } = {},
): Promise<ScreenPlayRow[] | null> {
  try {
    const cfg = load_config();
    if (!cfg.tautulli_key) return null;
    const user = opts.user ?? cfg.default_user;
    const days = opts.days ?? 180;
    const limit = opts.limit_per_type ?? 200;
    const rows: ScreenPlayRow[] = [];
    for (const media_type of ['episode', 'movie'] as const) {
      // `after` = range since (NOT `start_date`, which is an exact-day filter).
      const params: Record<string, string | number | undefined> = {
        length: limit,
        order_column: 'date',
        order_dir: 'desc',
        after: days_ago_iso_date(days),
        media_type,
      };
      if (user) params.user = user;
      const res = await tautulli_fetch<{ data?: Record<string, unknown>[] }>(
        cfg,
        'get_history',
        params,
      );
      if (!res.ok) return null;
      for (const r of Array.isArray(res.data?.data) ? res.data!.data! : []) {
        const p = project_history_row(r);
        rows.push({
          media_type: p.media_type,
          title: p.title,
          grandparent_title: p.grandparent_title,
          watched_at: p.watched_at,
          watched_fraction: p.watched_fraction,
        });
      }
    }
    return rows;
  } catch {
    return null;
  }
}

// ── factory ─────────────────────────────────────────────────────────────

export function create(_deps: ToolDeps): Tool[] {
  const cfg = load_config();
  return [
    create_plex_history(cfg),
    create_plex_heavy_rotation(cfg),
    create_plex_now_playing(cfg),
    create_plex_library(cfg),
    create_plex_ratings(cfg),
  ];
}
