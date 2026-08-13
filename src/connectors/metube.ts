/**
 * MeTube connector — Maggie's YouTube (and general yt-dlp) surface.
 *
 * Thin HTTP wrapper around yt-dlp via the MeTube web service. Maggie
 * queues a URL → MeTube runs yt-dlp → file lands in MeTube's downloads
 * dir. MeTube handles the retries, format negotiation, and progress
 * tracking that a raw `yt-dlp` shell-out wouldn't.
 *
 * Three tools, all capability-gated on `manage_youtube_downloads`:
 *   - youtube_download    — queue a URL (risk: write_internal)
 *   - youtube_queue_list  — read queued + completed downloads (risk: read)
 *   - youtube_queue_clear — remove items from queue or history (risk: write_internal)
 *
 * Env: METUBE_URL — OPTIONAL. Defaults to http://metube:8081, the in-compose
 * service address (a host-run orchestrator wants http://localhost:8095). That
 * default was documented here from the start but only implemented 2026-08-13;
 * until then an absent var silently disabled all three tools. Set the var to an
 * empty value to turn MeTube off deliberately. MeTube doesn't
 * require auth by default — it's a single-tenant household service.
 * If exposed publicly, gate via nginx/reverse-proxy, not in-app auth.
 *
 * Future NAS-graduation note: when Jasper moves the downloads volume to
 * an NAS mount, MeTube continues writing to /downloads inside the
 * container; the bind mount on the host side changes from
 * ./downloads/youtube to /mnt/nas/<somewhere>/youtube. No connector
 * change required.
 */
import { z } from 'zod';
import { createHash } from 'node:crypto';
import { ulid } from 'ulid';
import type { Tool, ToolContext } from '@core/tool';

/**
 * The in-compose service address, which is where MeTube actually is on every
 * deployment this connector has ever run on.
 *
 * The header above has documented this default since the file was written; the
 * code never implemented it, so `METUBE_URL` being absent — which it is, in
 * `/docker/hearth/hearth.env` and in the orchestrator's environment — made
 * `is_configured()` false and every one of the three tools below answer "MeTube
 * is not configured". Kate reported that to Jasper as "MeTube is down"
 * (2026-08-12) while the container was healthy and answering 200 on this exact
 * URL from inside the orchestrator. A docstring promising a default is not a
 * default; this is.
 */
const MT_DEFAULT_URL = 'http://metube:8081';
const MT_URL = (process.env.METUBE_URL ?? MT_DEFAULT_URL).replace(/\/+$/, '');

function is_configured(): boolean {
  return Boolean(MT_URL);
}

/**
 * Still reachable, and deliberately so: `??` catches only null/undefined, so an
 * UNSET `METUBE_URL` takes the default above while an explicitly EMPTY one
 * (`METUBE_URL=`) still reads as off. Unset means "wherever it normally is";
 * blank means "I turned this off on purpose" — the guard is what keeps the
 * second one expressible.
 */
function not_configured_error(): { ok: false; error: string } {
  return {
    ok: false,
    error:
      'MeTube is switched off — METUBE_URL is set to an empty value in Hearth\'s ' +
      `.env. Unset it to use the default (${MT_DEFAULT_URL}), or point it at a ` +
      'MeTube instance, then restart the orchestrator.',
  };
}

// ── youtube_download ────────────────────────────────────────────────────

const DownloadInput = z.object({
  url: z
    .string()
    .url()
    .describe(
      'Full URL to download. YouTube and any other yt-dlp-supported ' +
        'site work — including playlists, channels, and direct video URLs.',
    ),
  quality: z
    .enum(['best', 'audio', '1440', '1080', '720', '480', '360'])
    .default('best')
    .describe(
      'Quality cap. `best` = highest available (default); `audio` = ' +
        'audio-only (useful for podcasts / music videos); a number = ' +
        "max video height. Default to `best` and downshift only when " +
        "the user explicitly asks for lower quality (saving space, " +
        "metered connection, etc).",
    ),
  format: z
    .enum(['mp4', 'webm', 'mkv', 'mp3', 'm4a', 'opus'])
    .optional()
    .describe(
      'Container format. Pick `mp3` / `m4a` / `opus` when `quality: ' +
        "'audio'`. Default = MeTube's preferred for the requested quality.",
    ),
  folder: z
    .string()
    .optional()
    .describe(
      'Subfolder under MeTube\'s downloads root, e.g. "channels/lex-' +
        'fridman" or "music/2026". Created if missing. Useful for ' +
        "organizing into per-channel or per-purpose buckets.",
    ),
  filename_prefix: z
    .string()
    .optional()
    .describe(
      'Prefix prepended to the auto-generated filename. Keep it short ' +
        "and filesystem-friendly (no slashes).",
    ),
});

const DownloadOutput = z.object({
  ok: z.boolean(),
  error: z.string().optional(),
  url: z.string(),
  detail: z.string(),
});

type DownloadIn = z.infer<typeof DownloadInput>;
type DownloadOut = z.infer<typeof DownloadOutput>;

export const youtube_download: Tool<DownloadIn, DownloadOut> = {
  name: 'youtube_download',
  description:
    "Queue a yt-dlp download via MeTube. Pass the `url` (YouTube or any yt-dlp-supported site — channels, playlists, individual videos). Optional `quality` (best|audio|1440|1080|720|480|360, default `best` — highest available; downshift only when Jasper explicitly asks), `format` (mp4|webm|mkv|mp3|m4a|opus — pair audio formats with quality:'audio'), `folder` (subfolder under MeTube's downloads root, like 'channels/lex-fridman'), and `filename_prefix`. Returns immediately once queued; use `youtube_queue_list` to track progress. Use for: ad-hoc YouTube grabs Jasper hands you, archiving a specific video, audio rips for podcasts/music. Default to `best` unless Jasper says lower-quality is the point.",
  risk: 'write_internal',
  required_capabilities: ['manage_youtube_downloads'],
  input_schema: DownloadInput,
  output_schema: DownloadOutput,

  idempotency_key(input) {
    const h = createHash('sha256');
    h.update(input.url);
    h.update('\n');
    h.update(input.quality);
    h.update('\n');
    h.update(input.folder ?? '');
    return `youtube_download:${h.digest('hex').slice(0, 16)}`;
  },

  async execute(input, ctx: ToolContext): Promise<DownloadOut> {
    if (!is_configured()) {
      const err = not_configured_error();
      return { ok: false, error: err.error, url: input.url, detail: err.error };
    }
    const body: Record<string, string> = {
      url: input.url,
      quality: input.quality,
    };
    if (input.format) body.format = input.format;
    if (input.folder) body.folder = input.folder;
    if (input.filename_prefix) body.custom_name_prefix = input.filename_prefix;

    const res = await fetch(`${MT_URL}/add`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    ctx.memory.log_action({
      intent_id: ctx.intent_id || ulid(),
      agent: ctx.specialist_id ?? 'unknown',
      tool_name: 'youtube_download',
      tool_input: {
        url_preview: input.url.slice(0, 120),
        quality: input.quality,
        format: input.format,
        folder: input.folder,
      },
      execution_result: res.ok ? { queued: true } : undefined,
      error: res.ok ? undefined : `MeTube add failed: HTTP ${res.status}`,
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      return {
        ok: false,
        error: `MeTube returned HTTP ${res.status}`,
        url: input.url,
        detail: `Add rejected. ${detail.slice(0, 200)}`,
      };
    }
    return {
      ok: true,
      url: input.url,
      detail:
        `Queued in MeTube (${input.quality}` +
        (input.format ? `/${input.format}` : '') +
        (input.folder ? `, folder: ${input.folder}` : '') +
        '). Use youtube_queue_list to track progress.',
    };
  },
};

// ── youtube_queue_list ──────────────────────────────────────────────────

const ListInput = z.object({
  filter: z
    .enum(['all', 'active', 'completed', 'errored'])
    .default('all')
    .describe(
      "Status filter. `active` = pending/downloading, `completed` = " +
        "finished, `errored` = failed. Default `all`.",
    ),
  limit: z
    .coerce.number()
    .int()
    .positive()
    .max(200)
    .default(50)
    .describe('Max items returned. Default 50, max 200.'),
});

const QueueRow = z.object({
  id: z.string(),
  title: z.string(),
  url: z.string(),
  status: z.string(),
  percent: z.number().nullable(),
  size_bytes: z.number().nullable(),
  speed: z.string().nullable(),
  filename: z.string().nullable(),
  folder: z.string().nullable(),
  quality: z.string().nullable(),
  format: z.string().nullable(),
  error: z.string().nullable(),
  timestamp: z.number().nullable(),
});

const ListOutput = z.object({
  ok: z.boolean(),
  error: z.string().optional(),
  total: z.number(),
  items: z.array(QueueRow),
});

type ListIn = z.infer<typeof ListInput>;
type ListOut = z.infer<typeof ListOutput>;

interface MeTubeItem {
  id?: string;
  title?: string;
  url?: string;
  status?: string;
  percent?: number;
  size?: number;
  speed?: string;
  filename?: string;
  folder?: string;
  quality?: string;
  format?: string;
  msg?: string;        // error message field on failed items
  error?: string;      // alt error field
  timestamp?: number;
}

function meets_filter(status: string | undefined, filter: ListIn['filter']): boolean {
  if (filter === 'all') return true;
  const s = (status ?? '').toLowerCase();
  if (filter === 'active') return s === 'pending' || s === 'downloading' || s === 'preparing';
  if (filter === 'completed') return s === 'finished';
  if (filter === 'errored') return s === 'error' || s === 'failed';
  return true;
}

export const youtube_queue_list: Tool<ListIn, ListOut> = {
  name: 'youtube_queue_list',
  description:
    "List MeTube's download queue + history. Filters: `filter` (all|active|completed|errored, default all), `limit` (default 50, max 200). Returns each item's id, title, url, status, percent, size, speed, filename (when known), folder, quality, format, any error, and timestamp. Newest first. Use to answer 'did that download finish', 'what's queued right now', 'why did the lex-fridman download fail'.",
  risk: 'read',
  required_capabilities: ['manage_youtube_downloads'],
  input_schema: ListInput,
  output_schema: ListOutput,

  idempotency_key(input) {
    const h = createHash('sha256');
    h.update(JSON.stringify(input));
    return `youtube_queue_list:${h.digest('hex').slice(0, 16)}`;
  },

  async execute(input, ctx: ToolContext): Promise<ListOut> {
    if (!is_configured()) {
      const err = not_configured_error();
      return { ok: false, error: err.error, total: 0, items: [] };
    }
    const res = await fetch(`${MT_URL}/history`);
    if (!res.ok) {
      return {
        ok: false,
        error: `MeTube list failed: HTTP ${res.status}`,
        total: 0,
        items: [],
      };
    }
    // MeTube's /history shape: { queue: { id: item, ... }, done: { id: item, ... } }.
    // We flatten + sort timestamp desc, then filter + cap.
    const raw = (await res.json()) as { queue?: Record<string, MeTubeItem>; done?: Record<string, MeTubeItem> };
    const flat: MeTubeItem[] = [
      ...Object.values(raw.queue ?? {}),
      ...Object.values(raw.done ?? {}),
    ];
    flat.sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0));
    const filtered = flat
      .filter((i) => meets_filter(i.status, input.filter))
      .slice(0, input.limit);

    ctx.memory.log_action({
      intent_id: ctx.intent_id || ulid(),
      agent: ctx.specialist_id ?? 'unknown',
      tool_name: 'youtube_queue_list',
      tool_input: { filter: input.filter, limit: input.limit },
      execution_result: { returned: filtered.length, total_seen: flat.length },
    });

    return {
      ok: true,
      total: filtered.length,
      items: filtered.map((i) => ({
        id: i.id ?? '',
        title: i.title ?? '(no title yet)',
        url: i.url ?? '',
        status: i.status ?? 'unknown',
        percent: i.percent ?? null,
        size_bytes: i.size ?? null,
        speed: i.speed ?? null,
        filename: i.filename ?? null,
        folder: i.folder ?? null,
        quality: i.quality ?? null,
        format: i.format ?? null,
        error: i.msg ?? i.error ?? null,
        timestamp: i.timestamp ?? null,
      })),
    };
  },
};

// ── youtube_queue_clear ─────────────────────────────────────────────────

const ClearInput = z.object({
  id: z
    .string()
    .min(1)
    .describe(
      'Item id from `youtube_queue_list`. Each download has its own id.',
    ),
  where: z
    .enum(['queue', 'done'])
    .describe(
      "Which list the item is in. Active/pending items are in `queue`; " +
        "completed items are in `done`. If unsure, call " +
        "`youtube_queue_list` first.",
    ),
});

const ClearOutput = z.object({
  ok: z.boolean(),
  error: z.string().optional(),
  id: z.string(),
  detail: z.string(),
});

type ClearIn = z.infer<typeof ClearInput>;
type ClearOut = z.infer<typeof ClearOutput>;

export const youtube_queue_clear: Tool<ClearIn, ClearOut> = {
  name: 'youtube_queue_clear',
  description:
    "Remove an item from MeTube's queue or history. Args: `id` (from youtube_queue_list), `where` ('queue' for active/pending or 'done' for completed). Cancels an active download in `queue`; just hides a completed one from `done` (does NOT delete the downloaded file from disk — that needs a separate filesystem cleanup). Use to abandon a stuck or unwanted download, or to tidy the history view.",
  risk: 'write_internal',
  required_capabilities: ['manage_youtube_downloads'],
  input_schema: ClearInput,
  output_schema: ClearOutput,

  idempotency_key(input) {
    return `youtube_queue_clear:${input.where}:${input.id}`;
  },

  async execute(input, ctx: ToolContext): Promise<ClearOut> {
    if (!is_configured()) {
      const err = not_configured_error();
      return { ok: false, error: err.error, id: input.id, detail: err.error };
    }
    const res = await fetch(`${MT_URL}/delete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: [input.id], where: input.where }),
    });

    ctx.memory.log_action({
      intent_id: ctx.intent_id || ulid(),
      agent: ctx.specialist_id ?? 'unknown',
      tool_name: 'youtube_queue_clear',
      tool_input: { id: input.id, where: input.where },
      execution_result: res.ok ? { cleared: true } : undefined,
      error: res.ok ? undefined : `MeTube delete failed: HTTP ${res.status}`,
    });

    if (!res.ok) {
      return {
        ok: false,
        error: `MeTube delete failed: HTTP ${res.status}`,
        id: input.id,
        detail: `Clear rejected (HTTP ${res.status}).`,
      };
    }
    return {
      ok: true,
      id: input.id,
      detail: `Cleared ${input.id} from MeTube's ${input.where} list.`,
    };
  },
};
