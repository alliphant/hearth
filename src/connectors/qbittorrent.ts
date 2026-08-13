/**
 * qBittorrent connector — Maggie's torrent surface.
 *
 * Wraps qBittorrent's Web API (v2; same port as the Web UI) so Maggie
 * can queue, list, and remove torrents through Hearth's tool registry
 * rather than the *arr-stack's automated grab path. The *arr stack
 * already drives qBittorrent invisibly for matched releases; this
 * connector exposes the same client for the ad-hoc cases (a specific
 * magnet link, a release not in any indexer the *arrs reach, a
 * standalone curation acquisition).
 *
 * Auth: POST /api/v2/auth/login (form-urlencoded username + password)
 * returns a SID cookie; subsequent calls send it back. Cookies expire
 * (~1 hour default); a 401/403 triggers one re-login + retry.
 *
 * Three tools, all capability-gated on `manage_torrents`:
 *   - torrent_add    — queue a magnet link (risk: write_internal)
 *   - torrent_list   — read the current torrent set (risk: read)
 *   - torrent_remove — cancel + optionally delete files (risk: write_internal)
 *
 * Env: QBITTORRENT_URL (defaults to http://qbittorrent:8090 for in-
 * compose calls; orchestrator on host uses http://localhost:8090),
 * QBITTORRENT_USERNAME, QBITTORRENT_PASSWORD. Without all three set,
 * the tools return a clean "not configured" message rather than
 * throwing — same pattern as the arr.ts connector.
 */
import { z } from 'zod';
import { createHash } from 'node:crypto';
import { ulid } from 'ulid';
import type { Tool, ToolContext } from '@core/tool';

const QB_URL = (process.env.QBITTORRENT_URL ?? '').replace(/\/+$/, '');
const QB_USER = process.env.QBITTORRENT_USERNAME ?? '';
const QB_PASS = process.env.QBITTORRENT_PASSWORD ?? '';

let cached_cookie: string | null = null;

function is_configured(): boolean {
  return Boolean(QB_URL && QB_USER && QB_PASS);
}

function not_configured_error(): { ok: false; error: string } {
  return {
    ok: false,
    error:
      'qBittorrent is not configured — set QBITTORRENT_URL, ' +
      'QBITTORRENT_USERNAME, and QBITTORRENT_PASSWORD in Hearth\'s ' +
      '.env and restart the orchestrator.',
  };
}

async function login(): Promise<void> {
  const body = new URLSearchParams({ username: QB_USER, password: QB_PASS });
  const res = await fetch(`${QB_URL}/api/v2/auth/login`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      // qBit's CSRF check requires a matching Referer when not on localhost.
      Referer: QB_URL,
    },
    body,
  });
  if (!res.ok) {
    throw new Error(`qBittorrent login failed: HTTP ${res.status}`);
  }
  // Body shape varies across versions: older qBit (4.x and earlier)
  // returns 200 + "Ok." / "Fails."; newer builds (linuxserver/qbittorrent
  // current) return 204 with an empty body and rely entirely on the
  // SID cookie to signal success. The cookie is the load-bearing
  // signal in both cases — check it directly. A "Fails." body always
  // means rejection regardless of status.
  const text = (await res.text()).trim();
  if (text === 'Fails.') {
    throw new Error('qBittorrent login rejected (bad credentials)');
  }
  const set_cookies =
    (res.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie?.() ?? [];
  const sid = set_cookies
    .map((c) => c.split(';')[0])
    .find((c) => c?.startsWith('SID='));
  if (!sid) {
    throw new Error(
      `qBittorrent login: no SID cookie in response (HTTP ${res.status}, body: "${text}")`,
    );
  }
  cached_cookie = sid;
}

async function qb_fetch(
  path: string,
  init: { method?: 'GET' | 'POST'; body?: URLSearchParams } = {},
): Promise<Response> {
  if (!cached_cookie) await login();
  const do_fetch = (): Promise<Response> =>
    fetch(`${QB_URL}/api/v2${path}`, {
      method: init.method ?? 'GET',
      headers: {
        Cookie: cached_cookie!,
        Referer: QB_URL,
        ...(init.body
          ? { 'Content-Type': 'application/x-www-form-urlencoded' }
          : {}),
      },
      body: init.body,
    });
  let res = await do_fetch();
  if (res.status === 401 || res.status === 403) {
    cached_cookie = null;
    await login();
    res = await do_fetch();
  }
  return res;
}

// ── torrent_add ─────────────────────────────────────────────────────────

const AddInput = z.object({
  magnet: z
    .string()
    .min(1)
    .describe(
      'Magnet URI starting with `magnet:?xt=urn:btih:...`. To add a ' +
        'remote .torrent file, pass an http(s) URL instead — qBittorrent ' +
        'fetches it. Multiple are not supported in one call; queue them ' +
        'one at a time so each can be tracked separately.',
    ),
  category: z
    .string()
    .optional()
    .describe(
      "Optional qBit category (e.g. 'sonarr', 'maggie-manual'). Useful " +
        "for routing different download lifecycles to different watch " +
        "folders or post-processing rules.",
    ),
  savepath: z
    .string()
    .optional()
    .describe(
      "Override the default save path (inside the container). Omit to " +
        "let qBit use its category-default or global-default save path.",
    ),
});

const AddOutput = z.object({
  ok: z.boolean(),
  error: z.string().optional(),
  /**
   * qBit's add endpoint does NOT return the info-hash directly; we
   * derive it from the magnet URI's `xt=urn:btih:<hash>` portion when
   * the input is a magnet. For .torrent URLs we return null and the
   * caller can `torrent_list` to find the newly added item.
   */
  info_hash: z.string().nullable(),
  detail: z.string(),
});

type AddIn = z.infer<typeof AddInput>;
type AddOut = z.infer<typeof AddOutput>;

function info_hash_from_magnet(magnet: string): string | null {
  const m = magnet.match(/[?&]xt=urn:btih:([a-zA-Z0-9]+)/);
  return m?.[1]?.toLowerCase() ?? null;
}

export const torrent_add: Tool<AddIn, AddOut> = {
  name: 'torrent_add',
  description:
    "Queue a torrent in qBittorrent by magnet URI or remote .torrent URL. Pass the link via `magnet`. Optional `category` tags the torrent (useful for differentiating Maggie's manual adds from the *arr stack's automated ones — try 'maggie-manual'). Optional `savepath` overrides where files land (container-side path; the default is qBit's configured root). Returns the info_hash for follow-up calls to `torrent_list` / `torrent_remove`. Use this for ad-hoc grabs — releases not in any *arr indexer, single-file curation acquisitions, magnet links Jasper hands you directly. Don't use it to duplicate work the *arr stack would do for matched releases.",
  risk: 'write_internal',
  required_capabilities: ['manage_torrents'],
  input_schema: AddInput,
  output_schema: AddOutput,

  idempotency_key(input) {
    const h = createHash('sha256');
    h.update(input.magnet);
    return `torrent_add:${h.digest('hex').slice(0, 16)}`;
  },

  async execute(input, ctx: ToolContext): Promise<AddOut> {
    if (!is_configured()) {
      const err = not_configured_error();
      return { ok: false, error: err.error, info_hash: null, detail: err.error };
    }
    const body = new URLSearchParams();
    body.append('urls', input.magnet);
    if (input.category) body.append('category', input.category);
    if (input.savepath) body.append('savepath', input.savepath);
    const res = await qb_fetch('/torrents/add', { method: 'POST', body });
    const text = await res.text();
    const hash = info_hash_from_magnet(input.magnet);
    const ok = res.ok && text.trim() === 'Ok.';

    ctx.memory.log_action({
      intent_id: ctx.intent_id || ulid(),
      agent: ctx.specialist_id ?? 'unknown',
      tool_name: 'torrent_add',
      tool_input: {
        magnet_preview: input.magnet.slice(0, 80),
        category: input.category,
        savepath: input.savepath,
      },
      execution_result: ok ? { info_hash: hash } : undefined,
      error: ok ? undefined : `qBit add failed: HTTP ${res.status} ${text.slice(0, 120)}`,
    });

    if (!ok) {
      return {
        ok: false,
        error: `qBit returned HTTP ${res.status}: ${text.slice(0, 200)}`,
        info_hash: hash,
        detail: `Add rejected. ${text.slice(0, 200)}`,
      };
    }
    return {
      ok: true,
      info_hash: hash,
      detail: hash
        ? `Queued in qBittorrent (info_hash: ${hash}).`
        : `Queued in qBittorrent (URL accepted; call torrent_list to find the new item).`,
    };
  },
};

// ── torrent_list ────────────────────────────────────────────────────────

const ListInput = z.object({
  filter: z
    .enum(['all', 'downloading', 'completed', 'paused', 'active', 'stalled', 'errored'])
    .default('all')
    .describe('Status filter. Default `all`.'),
  category: z
    .string()
    .optional()
    .describe('Filter to one qBit category.'),
  limit: z
    .coerce.number()
    .int()
    .positive()
    .max(200)
    .default(50)
    .describe('Max items returned. Default 50, max 200.'),
});

const TorrentRow = z.object({
  hash: z.string(),
  name: z.string(),
  state: z.string(),
  progress: z.number(),
  size: z.number(),
  downloaded: z.number(),
  dl_speed_bps: z.number(),
  up_speed_bps: z.number(),
  eta_seconds: z.number(),
  category: z.string(),
  save_path: z.string(),
  added_on: z.number(),
});

const ListOutput = z.object({
  ok: z.boolean(),
  error: z.string().optional(),
  total: z.number(),
  torrents: z.array(TorrentRow),
});

type ListIn = z.infer<typeof ListInput>;
type ListOut = z.infer<typeof ListOutput>;

interface QbTorrent {
  hash: string;
  name: string;
  state: string;
  progress: number;
  size: number;
  downloaded: number;
  dlspeed: number;
  upspeed: number;
  eta: number;
  category: string;
  save_path: string;
  added_on: number;
}

export const torrent_list: Tool<ListIn, ListOut> = {
  name: 'torrent_list',
  description:
    "Read the current torrent set in qBittorrent. Filters: `filter` (all|downloading|completed|paused|active|stalled|errored, default all), `category` (one qBit category), `limit` (default 50, max 200). Returns each torrent's hash, name, state, progress (0-1), size, dl/up speeds, ETA, category, save path, added timestamp. Newest first. Use this to answer 'what's downloading right now', 'did the magnet I queued earlier land', 'how full is the active queue'. Read-only — pair with `torrent_remove` to clean up.",
  risk: 'read',
  required_capabilities: ['manage_torrents'],
  input_schema: ListInput,
  output_schema: ListOutput,

  idempotency_key(input) {
    const h = createHash('sha256');
    h.update(JSON.stringify(input));
    return `torrent_list:${h.digest('hex').slice(0, 16)}`;
  },

  async execute(input, ctx: ToolContext): Promise<ListOut> {
    if (!is_configured()) {
      const err = not_configured_error();
      return { ok: false, error: err.error, total: 0, torrents: [] };
    }
    const qs = new URLSearchParams();
    qs.append('filter', input.filter);
    qs.append('limit', String(input.limit));
    qs.append('sort', 'added_on');
    qs.append('reverse', 'true');
    if (input.category) qs.append('category', input.category);
    const res = await qb_fetch(`/torrents/info?${qs.toString()}`);
    if (!res.ok) {
      return {
        ok: false,
        error: `qBit list failed: HTTP ${res.status}`,
        total: 0,
        torrents: [],
      };
    }
    const rows = (await res.json()) as QbTorrent[];

    ctx.memory.log_action({
      intent_id: ctx.intent_id || ulid(),
      agent: ctx.specialist_id ?? 'unknown',
      tool_name: 'torrent_list',
      tool_input: { filter: input.filter, category: input.category, limit: input.limit },
      execution_result: { returned: rows.length },
    });

    return {
      ok: true,
      total: rows.length,
      torrents: rows.map((t) => ({
        hash: t.hash,
        name: t.name,
        state: t.state,
        progress: t.progress,
        size: t.size,
        downloaded: t.downloaded,
        dl_speed_bps: t.dlspeed,
        up_speed_bps: t.upspeed,
        eta_seconds: t.eta,
        category: t.category ?? '',
        save_path: t.save_path,
        added_on: t.added_on,
      })),
    };
  },
};

// ── torrent_remove ──────────────────────────────────────────────────────

const RemoveInput = z.object({
  hash: z
    .string()
    .min(1)
    .describe(
      'Info-hash from `torrent_list` or returned by `torrent_add`. ' +
        'Lowercase hex.',
    ),
  delete_files: z
    .coerce.boolean()
    .default(false)
    .describe(
      'When true, also delete the downloaded files from disk. Default ' +
        'false — removes the torrent from qBit but leaves files intact ' +
        '(safer for "stop sharing this but keep what I have").',
    ),
});

const RemoveOutput = z.object({
  ok: z.boolean(),
  error: z.string().optional(),
  hash: z.string(),
  files_deleted: z.boolean(),
  detail: z.string(),
});

type RemoveIn = z.infer<typeof RemoveInput>;
type RemoveOut = z.infer<typeof RemoveOutput>;

export const torrent_remove: Tool<RemoveIn, RemoveOut> = {
  name: 'torrent_remove',
  description:
    "Remove a torrent from qBittorrent by info-hash. Args: `hash` (from torrent_list), `delete_files` (default false — torrent leaves qBit's tracking but the downloaded files stay on disk). Use `delete_files: true` only when reclaiming space or removing an unwanted acquisition. The destructive flag is opt-in by design; default to the soft remove.",
  risk: 'write_internal',
  required_capabilities: ['manage_torrents'],
  input_schema: RemoveInput,
  output_schema: RemoveOutput,

  idempotency_key(input) {
    return `torrent_remove:${input.hash}:${input.delete_files}`;
  },

  async execute(input, ctx: ToolContext): Promise<RemoveOut> {
    if (!is_configured()) {
      const err = not_configured_error();
      return {
        ok: false,
        error: err.error,
        hash: input.hash,
        files_deleted: false,
        detail: err.error,
      };
    }
    const body = new URLSearchParams();
    body.append('hashes', input.hash);
    body.append('deleteFiles', String(input.delete_files));
    const res = await qb_fetch('/torrents/delete', { method: 'POST', body });

    ctx.memory.log_action({
      intent_id: ctx.intent_id || ulid(),
      agent: ctx.specialist_id ?? 'unknown',
      tool_name: 'torrent_remove',
      tool_input: { hash: input.hash, delete_files: input.delete_files },
      execution_result: res.ok ? { removed: true } : undefined,
      error: res.ok ? undefined : `qBit delete failed: HTTP ${res.status}`,
    });

    if (!res.ok) {
      return {
        ok: false,
        error: `qBit delete failed: HTTP ${res.status}`,
        hash: input.hash,
        files_deleted: false,
        detail: `Remove rejected (HTTP ${res.status}).`,
      };
    }
    return {
      ok: true,
      hash: input.hash,
      files_deleted: input.delete_files,
      detail: input.delete_files
        ? `Removed ${input.hash} from qBittorrent AND deleted files from disk.`
        : `Removed ${input.hash} from qBittorrent (files left on disk).`,
    };
  },
};
