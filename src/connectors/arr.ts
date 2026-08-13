/**
 * arr.ts — the Sonarr / Radarr / Lidarr / Readarr connector.
 *
 * Gives Cordelia the household's media-acquisition surface: look a show,
 * movie, artist, or book author up, see what's already in the libraries
 * (and what's downloading / upcoming / missing), and add new things —
 * which kicks off the *arr app's own search-and-grab pipeline.
 *
 * Four apps, one connector. Sonarr (TV) and Radarr (movies) speak the
 * v3 API; Lidarr (music) and Readarr (books) speak v1 — `APPS` carries
 * the per-app version, base URL, and library kind so the rest of the
 * file stays uniform. URLs + API keys come from the environment (see
 * .env.example); an unconfigured app's tools return a clean "not
 * configured" message rather than throwing.
 *
 * Three tools, all capability-gated on `manage_media` (Cordelia only):
 *   - media_search   — look up a title (risk: read)
 *   - media_library  — read the libraries / queue / calendar / etc.
 *                      (risk: read)
 *   - media_add      — add a title and trigger the grab
 *                      (risk: write_internal — frictionless, per Jasper)
 */
import { z } from 'zod';
import { createHash } from 'node:crypto';
import type { Tool, ToolContext } from '@core/tool';
import { safe_fetch } from './_audit';
import { local_iso_date } from '@core/time';

// ── per-app configuration ───────────────────────────────────────────────

interface AppConfig {
  name: string;
  url: string;
  key: string;
  api: 'v3' | 'v1';
  /** library endpoint + the external-id field of a lookup result */
  resource: 'series' | 'movie' | 'artist' | 'author';
  id_field: 'tvdbId' | 'tmdbId' | 'foreignArtistId' | 'foreignAuthorId';
  title_field: 'title' | 'artistName' | 'authorName';
}

const APPS: Record<'sonarr' | 'radarr' | 'lidarr' | 'readarr', AppConfig> = {
  sonarr: {
    name: 'Sonarr',
    url: process.env.SONARR_URL ?? 'http://your-llm-host.local:8989',
    key: process.env.SONARR_API_KEY ?? '',
    api: 'v3',
    resource: 'series',
    id_field: 'tvdbId',
    title_field: 'title',
  },
  radarr: {
    name: 'Radarr',
    url: process.env.RADARR_URL ?? 'http://your-llm-host.local:7878',
    key: process.env.RADARR_API_KEY ?? '',
    api: 'v3',
    resource: 'movie',
    id_field: 'tmdbId',
    title_field: 'title',
  },
  lidarr: {
    name: 'Lidarr',
    url: process.env.LIDARR_URL ?? 'http://your-llm-host.local:8686',
    key: process.env.LIDARR_API_KEY ?? '',
    api: 'v1',
    resource: 'artist',
    id_field: 'foreignArtistId',
    title_field: 'artistName',
  },
  readarr: {
    name: 'Readarr',
    url: process.env.READARR_URL ?? 'http://your-llm-host.local:8787',
    key: process.env.READARR_API_KEY ?? '',
    api: 'v1',
    resource: 'author',
    id_field: 'foreignAuthorId',
    title_field: 'authorName',
  },
};

type AppName = keyof typeof APPS;
const APP_NAMES = ['sonarr', 'radarr', 'lidarr', 'readarr'] as const;

// ── HTTP helper ─────────────────────────────────────────────────────────

interface ArrResult<T = unknown> {
  ok: boolean;
  status?: number;
  data?: T;
  error?: string;
}

async function arr_fetch<T = unknown>(
  cfg: AppConfig,
  path: string,
  init: RequestInit = {},
): Promise<ArrResult<T>> {
  if (!cfg.key) {
    return {
      ok: false,
      error:
        `${cfg.name} is not configured — set ${cfg.name.toUpperCase()}_API_KEY ` +
        `(and ${cfg.name.toUpperCase()}_URL) in Hearth's .env and restart the ` +
        `orchestrator.`,
    };
  }
  const base = cfg.url.replace(/\/+$/, '');
  const res = await safe_fetch(
    `${base}/api/${cfg.api}${path}`,
    {
      ...init,
      headers: {
        'X-Api-Key': cfg.key,
        'Content-Type': 'application/json',
        ...(init.headers ?? {}),
      },
    },
    20_000,
  );
  if (!res.ok) {
    return {
      ok: false,
      status: res.status,
      // surface the *arr error body — it carries "already added" etc.
      error: res.error ?? `${cfg.name} HTTP ${res.status}: ${res.body.slice(0, 300)}`,
    };
  }
  try {
    return { ok: true, status: res.status, data: (res.body ? JSON.parse(res.body) : null) as T };
  } catch (err) {
    return { ok: false, error: `${cfg.name}: unparseable response — ${(err as Error).message}` };
  }
}

/** Page-wrapped *arr endpoints return `{ records: [...] }`; others a bare array. */
function as_array(data: unknown): unknown[] {
  if (Array.isArray(data)) return data;
  if (data && typeof data === 'object' && Array.isArray((data as { records?: unknown[] }).records)) {
    return (data as { records: unknown[] }).records;
  }
  return [];
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : v == null ? '' : String(v);
}
function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

// ── media_search ────────────────────────────────────────────────────────

const SearchInput = z.object({
  app: z
    .enum(APP_NAMES)
    .describe(
      'Which library to search: sonarr (TV shows), radarr (movies), ' +
        'lidarr (music artists), or readarr (book authors).',
    ),
  term: z
    .string()
    .min(1)
    .max(300)
    .describe('The title to look up — a show, movie, artist, or author name.'),
});

const SearchResult = z.object({
  id: z.string().describe('External id — pass this to media_add to add the item.'),
  title: z.string(),
  year: z.number().nullable(),
  overview: z.string(),
  in_library: z.boolean().describe('True if this title is already added to the app.'),
});

const SearchOutput = z.object({
  app: z.string(),
  results: z.array(SearchResult),
  error: z.string().optional(),
});

type SearchInputT = z.infer<typeof SearchInput>;
type SearchOutputT = z.infer<typeof SearchOutput>;

function normalize_lookup(cfg: AppConfig, raw: unknown[]): z.infer<typeof SearchResult>[] {
  return raw.slice(0, 12).map((r) => {
    const o = (r ?? {}) as Record<string, unknown>;
    const lib_id = num(o.id);
    return {
      id: str(o[cfg.id_field]),
      title: str(o[cfg.title_field]) || str(o.title),
      year: num(o.year),
      overview: str(o.overview).slice(0, 280),
      in_library: lib_id != null && lib_id > 0,
    };
  });
}

export const media_search: Tool<SearchInputT, SearchOutputT> = {
  name: 'media_search',
  description:
    'Look up a TV show, movie, music artist, or book author in Sonarr / ' +
    'Radarr / Lidarr / Readarr. Returns candidates with an `id`, year, ' +
    'overview, and whether each is already in the library. Use this to find ' +
    'the right title before calling media_add. `app` picks which library: ' +
    'sonarr=TV, radarr=movies, lidarr=music, readarr=books.',
  risk: 'read',
  required_capabilities: ['manage_media'],
  input_schema: SearchInput,
  output_schema: SearchOutput,

  idempotency_key(input) {
    return `media_search:${input.app}:${createHash('sha256')
      .update(input.term)
      .digest('hex')
      .slice(0, 16)}`;
  },

  async execute(input, _ctx: ToolContext): Promise<SearchOutputT> {
    const cfg = APPS[input.app];
    const path = `/${cfg.resource}/lookup?term=${encodeURIComponent(input.term)}`;
    const res = await arr_fetch<unknown[]>(cfg, path);
    if (!res.ok) return { app: input.app, results: [], error: res.error };
    return { app: input.app, results: normalize_lookup(cfg, as_array(res.data)) };
  },
};

// ── media_add ───────────────────────────────────────────────────────────

const AddInput = z.object({
  app: z
    .enum(APP_NAMES)
    .describe(
      'Which library to add to: sonarr (TV show), radarr (movie), ' +
        'lidarr (music artist), or readarr (book author).',
    ),
  id: z
    .string()
    .min(1)
    .describe('The external `id` of the item, taken from a media_search result.'),
});

const AddOutput = z.object({
  app: z.string(),
  added: z.boolean(),
  already_present: z.boolean(),
  title: z.string(),
  message: z.string(),
  error: z.string().optional(),
});

type AddInputT = z.infer<typeof AddInput>;
type AddOutputT = z.infer<typeof AddOutput>;

/** First root folder path + first quality profile id (+ metadata profile for Lidarr). */
async function add_defaults(
  cfg: AppConfig,
): Promise<{ ok: true; root: string; quality: number; metadata: number | null } | { ok: false; error: string }> {
  const roots = await arr_fetch<Array<{ path?: string }>>(cfg, '/rootfolder');
  if (!roots.ok) return { ok: false, error: roots.error ?? 'rootfolder lookup failed' };
  const root = as_array(roots.data)[0] as { path?: string } | undefined;
  if (!root?.path) return { ok: false, error: `${cfg.name}: no root folder configured` };

  const profiles = await arr_fetch<Array<{ id?: number }>>(cfg, '/qualityprofile');
  if (!profiles.ok) return { ok: false, error: profiles.error ?? 'qualityprofile lookup failed' };
  const quality = (as_array(profiles.data)[0] as { id?: number } | undefined)?.id;
  if (quality == null) return { ok: false, error: `${cfg.name}: no quality profile configured` };

  let metadata: number | null = null;
  if (cfg.resource === 'artist' || cfg.resource === 'author') {
    const mp = await arr_fetch<Array<{ id?: number }>>(cfg, '/metadataprofile');
    metadata = mp.ok ? (as_array(mp.data)[0] as { id?: number } | undefined)?.id ?? null : null;
  }
  return { ok: true, root: root.path, quality, metadata };
}

export const media_add: Tool<AddInputT, AddOutputT> = {
  name: 'media_add',
  description:
    'Add a TV show, movie, music artist, or book author to Sonarr / Radarr ' +
    '/ Lidarr / Readarr and immediately trigger the search-and-download. ' +
    'Pass the `id` from a media_search result. Root folder and quality ' +
    'profile are chosen automatically. This acts right away — there is no ' +
    'approval step — so be sure it is the title Jasper asked for. It is ' +
    'reversible: he can delete it in the app.',
  risk: 'write_internal',
  required_capabilities: ['manage_media'],
  input_schema: AddInput,
  output_schema: AddOutput,

  idempotency_key(input) {
    return `media_add:${input.app}:${input.id}`;
  },

  async execute(input, _ctx: ToolContext): Promise<AddOutputT> {
    const cfg = APPS[input.app];
    const fail = (error: string): AddOutputT => ({
      app: input.app,
      added: false,
      already_present: false,
      title: '',
      message: error,
      error,
    });

    // Re-resolve the full lookup object by external id — the *arr add
    // endpoints want the whole object, not just the id.
    const term =
      cfg.resource === 'series'
        ? `tvdb:${input.id}`
        : cfg.resource === 'movie'
          ? `tmdb:${input.id}`
          : input.id;
    const lookup = await arr_fetch<unknown[]>(
      cfg,
      `/${cfg.resource}/lookup?term=${encodeURIComponent(term)}`,
    );
    if (!lookup.ok) return fail(lookup.error ?? 'lookup failed');
    const candidates = as_array(lookup.data) as Array<Record<string, unknown>>;
    const item =
      candidates.find((c) => str(c[cfg.id_field]) === input.id) ?? candidates[0];
    if (!item) return fail(`${cfg.name}: nothing found for id ${input.id}`);

    const title = str(item[cfg.title_field]) || str(item.title) || input.id;
    const existing = num(item.id);
    if (existing != null && existing > 0) {
      return {
        app: input.app,
        added: false,
        already_present: true,
        title,
        message: `"${title}" is already in ${cfg.name}.`,
      };
    }

    const defs = await add_defaults(cfg);
    if (!defs.ok) return fail(defs.error);

    // Build the add payload: the lookup object + monitoring + add options.
    const body: Record<string, unknown> = {
      ...item,
      qualityProfileId: defs.quality,
      rootFolderPath: defs.root,
      monitored: true,
    };
    if (cfg.resource === 'series') {
      body.seasonFolder = true;
      body.addOptions = { searchForMissingEpisodes: true, monitor: 'all' };
    } else if (cfg.resource === 'movie') {
      body.minimumAvailability = 'released';
      body.addOptions = { searchForMovie: true };
    } else {
      // Lidarr (artist) / Readarr (author) — v1 apps, metadata profile required.
      if (defs.metadata != null) body.metadataProfileId = defs.metadata;
      body.monitorNewItems = 'all';
      body.addOptions =
        cfg.resource === 'artist'
          ? { searchForMissingAlbums: true, monitor: 'all' }
          : { searchForMissingBooks: true, monitor: 'all' };
    }

    const post = await arr_fetch(cfg, `/${cfg.resource}`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
    if (!post.ok) {
      if (post.status === 400 && /already|exist/i.test(post.error ?? '')) {
        return {
          app: input.app,
          added: false,
          already_present: true,
          title,
          message: `"${title}" is already in ${cfg.name}.`,
        };
      }
      return fail(post.error ?? `${cfg.name}: add failed`);
    }
    return {
      app: input.app,
      added: true,
      already_present: false,
      title,
      message: `Added "${title}" to ${cfg.name} and started the search.`,
    };
  },
};

// ── media_library ───────────────────────────────────────────────────────

const VIEWS = [
  'library',
  'queue',
  'calendar',
  'wanted',
  'history',
  'diskspace',
  'status',
] as const;
type View = (typeof VIEWS)[number];

const LibraryInput = z.object({
  app: z
    .enum(APP_NAMES)
    .describe(
      'Which library: sonarr (TV), radarr (movies), lidarr (music), ' +
        'or readarr (books).',
    ),
  view: z
    .enum(VIEWS)
    .describe(
      'What to read: library (everything added), queue (downloading now), ' +
        'calendar (next 14 days), wanted (monitored but missing), history ' +
        '(recent grabs/imports), diskspace, or status (the app version/health).',
    ),
});

const LibraryOutput = z.object({
  app: z.string(),
  view: z.string(),
  count: z.number(),
  summary: z.string(),
  items: z.array(z.unknown()),
  error: z.string().optional(),
});

type LibraryInputT = z.infer<typeof LibraryInput>;
type LibraryOutputT = z.infer<typeof LibraryOutput>;

function iso_date(offset_days: number): string {
  return local_iso_date(new Date(Date.now() + offset_days * 86_400_000));
}

/** Endpoint + a compact row projection for each view. */
function view_request(cfg: AppConfig, view: View): { path: string; project: (o: Record<string, unknown>) => unknown } {
  const lib_row = (o: Record<string, unknown>) => ({
    title: str(o[cfg.title_field]) || str(o.title),
    year: num(o.year),
    monitored: o.monitored === true,
    status: str(o.status),
  });
  switch (view) {
    case 'library':
      return { path: `/${cfg.resource}`, project: lib_row };
    case 'queue':
      return {
        path: '/queue?pageSize=50&includeUnknownItems=true',
        project: (o) => ({
          title: str(o.title),
          status: str(o.status),
          tracked: str(o.trackedDownloadStatus),
          time_left: str(o.timeleft),
        }),
      };
    case 'calendar':
      return {
        path: `/calendar?start=${iso_date(0)}&end=${iso_date(14)}`,
        project: (o) => ({
          title: str(o.title) || str(o[cfg.title_field]),
          airDate: str(o.airDateUtc) || str(o.releaseDate) || str(o.airDate),
          monitored: o.monitored === true,
        }),
      };
    case 'wanted':
      return {
        path: '/wanted/missing?pageSize=50&sortKey=title',
        project: lib_row,
      };
    case 'history':
      return {
        path: '/history?pageSize=30&sortKey=date&sortDirection=descending',
        project: (o) => ({
          event: str(o.eventType),
          title: str(o.sourceTitle),
          date: str(o.date),
        }),
      };
    case 'diskspace':
      return {
        path: '/diskspace',
        project: (o) => ({
          path: str(o.path),
          freeGB: num(o.freeSpace) != null ? Math.round((o.freeSpace as number) / 1e9) : null,
          totalGB: num(o.totalSpace) != null ? Math.round((o.totalSpace as number) / 1e9) : null,
        }),
      };
    case 'status':
      return {
        path: '/system/status',
        project: (o) => ({
          appName: str(o.appName),
          version: str(o.version),
          osName: str(o.osName),
        }),
      };
  }
}

export const media_library: Tool<LibraryInputT, LibraryOutputT> = {
  name: 'media_library',
  description:
    "Read a Sonarr / Radarr / Lidarr / Readarr app: what's in the library, " +
    "what's downloading now (queue), what airs/releases in the next two weeks " +
    '(calendar), what is monitored but still missing (wanted), recent ' +
    'grabs (history), disk space, or the app status. Use before media_add ' +
    "to check whether something is already there. `app` picks the library.",
  risk: 'read',
  required_capabilities: ['manage_media'],
  input_schema: LibraryInput,
  output_schema: LibraryOutput,

  idempotency_key(input) {
    return `media_library:${input.app}:${input.view}`;
  },

  async execute(input, _ctx: ToolContext): Promise<LibraryOutputT> {
    const cfg = APPS[input.app];
    const { path, project } = view_request(cfg, input.view);
    const res = await arr_fetch(cfg, path);
    if (!res.ok) {
      return { app: input.app, view: input.view, count: 0, summary: '', items: [], error: res.error };
    }
    const rows = as_array(res.data);
    const total = rows.length;
    const items = rows.slice(0, 60).map((r) => project((r ?? {}) as Record<string, unknown>));

    let summary: string;
    if (input.view === 'library') {
      const monitored = rows.filter((r) => (r as { monitored?: boolean }).monitored === true).length;
      summary = `${cfg.name} library: ${total} ${cfg.resource}${total === 1 ? '' : 's'} (${monitored} monitored)`;
    } else if (input.view === 'status') {
      const s = (rows[0] ?? res.data ?? {}) as Record<string, unknown>;
      // /system/status is a single object, not a list.
      const obj = total === 0 ? (res.data as Record<string, unknown>) : s;
      return {
        app: input.app,
        view: input.view,
        count: 1,
        summary: `${cfg.name} ${str(obj?.version)} on ${str(obj?.osName)}`,
        items: [
          { appName: str(obj?.appName), version: str(obj?.version), osName: str(obj?.osName) },
        ],
      };
    } else {
      summary = `${cfg.name} ${input.view}: ${total} item${total === 1 ? '' : 's'}` +
        (total > 60 ? ' (showing first 60)' : '');
    }
    return { app: input.app, view: input.view, count: total, summary, items };
  },
};
