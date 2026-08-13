/**
 * /api/media/* — the Media Archive serving surface (design-media-archival.md §7).
 *
 * Browse the deep taxonomy, inference-search (hybrid RAG over the context .md),
 * item detail, and DIRECT-PLAY streaming of the media file from the NAS archive
 * root via HTTP Range (206) — the file is already AVPlayer-native from the
 * download step, so there is no per-stream transcode. Every read is
 * cordon-filtered (note_visible_to_caller); the stream + item + thumb endpoints
 * return a 404-shape (never 403-leak) when a caller can't see a row.
 *
 * SCOPE (owner directive 2026-07-29, @core/media/cordon): every archived item is
 * stamped `private_to` its REQUESTER, so each caller browses only what they
 * themselves asked Kate to archive — there is no household-shared shelf and no
 * owner god-view. Two consequences are visible here rather than hidden:
 *   - a caller who has archived nothing gets a legitimately EMPTY browse/recent;
 *     the web client says why instead of implying the archive is empty.
 *   - `household_heatmap` on item detail is one viewer's re-watch curve for an
 *     unshared item (see the wire-name note on `watch_heat` below).
 *
 * SHARING (2026-07-29) is the ONE way an item reaches a second person, and it
 * does not soften the silo: it is per-item, by name, written only by that item's
 * own requester, and it grants read on that one item and nothing else. See the
 * sharing block below — the note's `shared_with` frontmatter is the storage, and
 * `note_visible_to_caller` reads it alongside the cordon so every read here
 * (browse, recent, item, stream, thumb, captions, RAG) inherits one rule.
 *
 * NEW top-level /api namespace → needs the the LLM host nginx /api/(...) alternation
 * edit + `docker restart nginx` (see the mount comment in server.ts).
 */
import { Hono } from 'hono';
import type { Context } from 'hono';
import type { Database } from 'bun:sqlite';
import { existsSync, statSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { ulid } from 'ulid';
import type { MemoryClient, MediaItemRow, ScopedChunkHit } from '@memory/client';
import type { AppEventBus } from '@app/events';
import { parse_shared_with, type Caller } from '@memory/private_to';
import type { UserRegistry } from '@core/users';
import { retrieve_hybrid } from '@core/retrieval';
import { NOOP_EMBEDDER } from '@core/embeddings';
import type { Embedder } from '@core/embeddings';

export interface MediaRouterDeps {
  db: Database;
  memory: MemoryClient;
  /** absolute path to the NAS media archive root (HEARTH_MEDIA_ARCHIVE_ROOT) */
  archive_root: string;
  /**
   * The users.yaml roster — the ONLY source of eligible share targets (see the
   * sharing block below). Optional: absent (partial smokes, a fresh box
   * mid-provisioning) the `sharing` object is omitted from item detail and the
   * share verb 503s, rather than the route guessing a roster.
   */
  users?: UserRegistry;
  /**
   * Where the generate_image tool writes chat images
   * (`<vault>/_attachments/generated`) — served read-only at
   * GET /generated/:filename. Optional: absent (partial smokes) the
   * route 404s rather than guessing a root.
   */
  generated_root?: string;
  events?: AppEventBus;
  embedder?: Embedder;
}

function caller_of(c: Context): Caller | null {
  const user = c.get('user');
  if (!user) return null;
  return { user_id: user.id, tier: user.tier };
}

/** Resolve a stored archive-relative path under the archive root, rejecting escapes. */
function safe_archive_abs(root: string, rel: string): string | null {
  // Normalize the root FIRST: the configured archive_root may be relative
  // ('./data/media-archive') or trailing-slashed ('/mnt/nas/media/'), and
  // comparing a resolved-absolute path against the raw string rejects everything.
  const nroot = resolve(root);
  const cleaned = String(rel ?? '')
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '');
  if (cleaned.length === 0 || cleaned.includes('\0')) return null;
  const abs = resolve(nroot, cleaned);
  if (abs !== nroot && !abs.startsWith(nroot + sep)) return null;
  return abs;
}

function content_type_for(path: string): string {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  switch (ext) {
    case 'mp4':
    case 'm4v':
      return 'video/mp4';
    case 'm4a':
      return 'audio/mp4';
    case 'mp3':
      return 'audio/mpeg';
    case 'webm':
      return 'video/webm';
    case 'mkv':
      return 'video/x-matroska';
    case 'mov':
      return 'video/quicktime';
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg';
    case 'png':
      return 'image/png';
    case 'webp':
      return 'image/webp';
    case 'gif':
      return 'image/gif';
    default:
      return 'application/octet-stream';
  }
}

/**
 * HTTP-range direct-play. Parses `Range: bytes=start-end` (also `start-` and
 * `-suffix`), returns 206 + Content-Range for a range, 200 + Accept-Ranges for a
 * full GET, 416 for an unsatisfiable range. Streams via `Bun.file().slice()` (a
 * Blob byte-range) so a 4 GB file never lands in memory.
 */
function serve_media_file(c: Context, abs: string): Response {
  let total: number;
  try {
    total = statSync(abs).size;
  } catch {
    return c.json({ error: 'not found' }, 404);
  }
  const mime = content_type_for(abs);
  const range = c.req.header('range');
  if (!range) {
    return new Response(Bun.file(abs), {
      headers: {
        'content-type': mime,
        'content-length': String(total),
        'accept-ranges': 'bytes',
        'cache-control': 'private, max-age=3600',
      },
    });
  }
  const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
  if (!m) {
    return new Response('malformed range', {
      status: 416,
      headers: { 'content-range': `bytes */${total}`, 'accept-ranges': 'bytes' },
    });
  }
  const raw_start = m[1] ?? '';
  const raw_end = m[2] ?? '';
  let start: number;
  let end: number;
  if (raw_start === '') {
    // suffix range: bytes=-N → the last N bytes
    const suffix = raw_end === '' ? 0 : parseInt(raw_end, 10);
    if (suffix <= 0) {
      return new Response('unsatisfiable', {
        status: 416,
        headers: { 'content-range': `bytes */${total}`, 'accept-ranges': 'bytes' },
      });
    }
    start = Math.max(0, total - suffix);
    end = total - 1;
  } else {
    start = parseInt(raw_start, 10);
    end = raw_end === '' ? total - 1 : parseInt(raw_end, 10);
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= total) {
    return new Response('unsatisfiable', {
      status: 416,
      headers: { 'content-range': `bytes */${total}`, 'accept-ranges': 'bytes' },
    });
  }
  end = Math.min(end, total - 1);
  const length = end - start + 1;
  const body = Bun.file(abs).slice(start, end + 1);
  return new Response(body, {
    status: 206,
    headers: {
      'content-type': mime,
      'content-range': `bytes ${start}-${end}/${total}`,
      'accept-ranges': 'bytes',
      'content-length': String(length),
      'cache-control': 'private, max-age=3600',
    },
  });
}

/** SRT → WebVTT: the header + comma→dot in cue timestamps (HTML5 <track> needs
 *  VTT; SRT's numeric cue ids are valid VTT identifiers, so nothing else moves). */
export function srt_to_vtt(srt: string): string {
  const body = srt
    .replace(/^﻿/, '') // strip BOM
    .replace(/\r\n/g, '\n')
    .replace(/(\d\d:\d\d:\d\d),(\d\d\d)/g, '$1.$2');
  return 'WEBVTT\n\n' + body;
}

function parse_frontmatter(row: MediaItemRow): Record<string, unknown> {
  try {
    const fm = JSON.parse(row.frontmatter_json) as unknown;
    return fm && typeof fm === 'object' ? (fm as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** The card projection returned by browse/search/item (no raw disk paths leaked as URLs). */
function project_card(row: MediaItemRow): Record<string, unknown> {
  return {
    id: row.id,
    title: row.name,
    media_kind: row.media_kind,
    creator: row.creator,
    genre: row.genre,
    nsfw: row.nsfw !== 0,
    duration_s: row.duration_s,
    width: row.width,
    height: row.height,
    source_site: row.source_site,
    source_url: row.source_url,
    archived_at: row.archived_at,
    thumb_url: `/api/media/thumb/${row.id}`,
    stream_url: `/api/media/stream/${row.id}`,
  };
}

function dirname_of(p: string): string {
  const i = p.lastIndexOf('/');
  return i === -1 ? '' : p.slice(0, i);
}

export function create_media_router(deps: MediaRouterDeps): Hono {
  const r = new Hono();

  // Re-watch heat — a per-item bucket histogram fed by playback progress (POST
  // /progress/:id), served on item detail as the "your curve" (Milwaukee-red)
  // scrubber overlay. Self-contained CREATE IF NOT EXISTS here rather than
  // SCHEMA_SQL, to sidestep migration-ordering hazards.
  //
  // It was conceived as HOUSEHOLD heat — several people's replays of one shared
  // item — and that is not what it is by default: under the requester-silo cordon
  // (2026-07-29, @core/media/cordon) an item reaches exactly one person unless it
  // is explicitly shared, and `/progress/:id` is cordon-gated, so an UNSHARED
  // row's buckets all come from that one viewer. The table stays honest (it counts
  // the plays it was told about); only the name over-claimed, hence the rename.
  // The WIRE key stays `household_heatmap` — the web and iOS players both read
  // it, and renaming a served field to fix a comment would break two clients to
  // no one's benefit.
  //
  // The named-grant share verb below is exactly the "if a share affordance is
  // added" case the rename anticipated: a SHARED item's curve does aggregate
  // every grantee who plays it, with no schema change — `watch_heat` is keyed by
  // media_id, not by viewer. That is the intended reading of a shared item's
  // curve, not a leak: the grant is what admitted them to the item in the first
  // place, and a bucket count names nobody.
  const HEAT_BUCKETS = 100;
  deps.db.run(`CREATE TABLE IF NOT EXISTS media_watch_heat (
    media_id TEXT NOT NULL,
    bucket INTEGER NOT NULL,
    count INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (media_id, bucket)
  )`);
  const watch_heat = (media_id: string): number[] | null => {
    const rows = deps.db
      .prepare('SELECT bucket, count FROM media_watch_heat WHERE media_id = ?')
      .all(media_id) as { bucket: number; count: number }[];
    if (rows.length === 0) return null;
    const buckets = new Array<number>(HEAT_BUCKETS).fill(0);
    let max = 0;
    for (const row of rows) {
      if (row.bucket >= 0 && row.bucket < HEAT_BUCKETS) {
        buckets[row.bucket] = row.count;
        if (row.count > max) max = row.count;
      }
    }
    return max > 0 ? buckets.map((v) => v / max) : null;
  };

  // ── browse the taxonomy ──────────────────────────────────────────────────
  // GET /api/media/browse?path=Video/YouTube → { folders:[…], items:[…] }
  r.get('/browse', (c) => {
    const caller = caller_of(c);
    if (!caller) return c.json({ error: 'authentication required' }, 401);
    const path = (c.req.query('path') ?? '').replace(/^\/+|\/+$/g, '');
    const rows = deps.memory.query_media_items({ caller, limit: 5000 });
    const folders = new Map<string, number>(); // subfolder name → count
    const items: Record<string, unknown>[] = [];
    for (const row of rows) {
      const np = (row.nas_path ?? '').replace(/^\/+/, '');
      if (!np) continue;
      const dir = dirname_of(np);
      if (dir === path) {
        items.push(project_card(row));
        continue;
      }
      const under = path === '' ? dir : dir.startsWith(path + '/') ? dir.slice(path.length + 1) : null;
      if (under === null || under === '') continue;
      const seg = under.indexOf('/') === -1 ? under : under.slice(0, under.indexOf('/'));
      folders.set(seg, (folders.get(seg) ?? 0) + 1);
    }
    return c.json({
      path,
      folders: [...folders.entries()]
        .map(([name, count]) => ({ name, path: path === '' ? name : `${path}/${name}`, count }))
        .sort((a, b) => a.name.localeCompare(b.name)),
      items,
    });
  });

  // ── recent (the office landing grid — newest first, all folders) ─────────
  // GET /api/media/recent?limit=40 → { items:[card] }. query_media_items is
  // already cordon-filtered + ORDER BY archived_at DESC, so a caller only ever
  // sees the items THEY requested (the 2026-07-29 requester silo) — never
  // another user's, in either direction. An empty list is therefore a normal
  // state for someone who hasn't archived anything, not a broken archive; the
  // client says which.
  r.get('/recent', (c) => {
    const caller = caller_of(c);
    if (!caller) return c.json({ error: 'authentication required' }, 401);
    const lim_raw = parseInt(c.req.query('limit') ?? '40', 10);
    const limit = Number.isFinite(lim_raw) ? Math.max(1, Math.min(200, lim_raw)) : 40;
    const rows = deps.memory.query_media_items({ caller, limit });
    return c.json({ items: rows.map(project_card) });
  });

  // ── inference search (hybrid RAG over the context .md) ───────────────────
  r.get('/search', async (c) => {
    const caller = caller_of(c);
    if (!caller) return c.json({ error: 'authentication required' }, 401);
    const query = (c.req.query('q') ?? '').trim();
    if (!query) return c.json({ query, results: [] });
    const k_raw = parseInt(c.req.query('k') ?? '20', 10);
    const k = Number.isFinite(k_raw) ? Math.max(1, Math.min(50, k_raw)) : 20;
    let hits: ScopedChunkHit[] = [];
    try {
      hits = await retrieve_hybrid({
        memory: deps.memory,
        embedder: deps.embedder ?? NOOP_EMBEDDER,
        query,
        knowledge_scope: ['**'],
        k,
        user_id: caller.user_id,
        user_tier: caller.tier,
      });
    } catch (err) {
      return c.json({ error: `search failed: ${(err as Error).message}` }, 500);
    }
    // Join each hit's note_path → its media_items row (cordon-checked); non-media
    // notes have no row and drop out. Dedup by media id, preserve rank order.
    const seen = new Set<string>();
    const results: Record<string, unknown>[] = [];
    for (const hit of hits) {
      const row = deps.memory.get_media_item_by_note_path(hit.note_path, caller);
      if (!row || seen.has(row.id)) continue;
      seen.add(row.id);
      results.push({ ...project_card(row), snippet: hit.chunk_text.slice(0, 240) });
    }
    return c.json({ query, results });
  });

  // ── sharing (2026-07-29) ─────────────────────────────────────────────────
  // "Share this one item with Sam." The SERVER owns eligibility, current
  // state, and the user-facing copy; iOS and /app are thin renderers that POST
  // a user_id list back (the WebGUI/iOS consolidation directive). No client
  // hardcodes who may receive, computes whether sharing is allowed, or invents
  // label text — a new rule or string lands HERE, once, for both surfaces.
  //
  // Storage is the note's `shared_with` frontmatter (the note is the source of
  // truth; the ingestor owns the media_items projection — never UPDATE it from
  // here). `nas_path` never moves, which is what makes a shared item show up
  // for the recipient in the identical folder.
  //
  // ALL share copy lives in these three constants — the clients render them
  // verbatim and author no share strings of their own. Two clients writing
  // their own version of the same sentence is how "Nobody else is set up to
  // receive shares yet." and "There's no one else to share this with yet."
  // ended up on the same feature.
  //
  // They are therefore CANONICAL: when a client's wording disagrees, the client
  // changes, not this file. (Settled 2026-07-29: iOS had shipped a third variant
  // of the empty-pool line as a pre-deploy fallback, plus a note asking the
  // server to adopt it. That fallback now mirrors SHARE_EMPTY_HINT byte for
  // byte — curly apostrophe included — so a pre-deploy build and a deployed one
  // read identically. It is the ONE client-side copy of any string here; if you
  // edit one, follow it there, and delete it outright once every deployment
  // sends the field.)
  /** Footer under the picker, whenever sharing is possible. */
  const SHARE_HINT = 'Shared items show up in the same folders for them.';
  /** Rendered INSTEAD of the picker list when `targets` is empty. */
  const SHARE_EMPTY_HINT = 'There’s no one else set up to receive shares yet.';
  /** The current-state line, shown with the picker closed. Null when unshared. */
  const share_state_label = (names: string[]): string | null =>
    names.length > 0 ? `Shared with ${names.join(', ')}` : null;

  /** The item's owning user id — the cordon value when it's a user silo. */
  const owner_of = (row: MediaItemRow): string => (row.private_to ?? '').trim();

  /**
   * A caller may share an item ONLY if the item is THEIRS. The owner gets no
   * god-view: they cannot share a household member's or a friend's item (they
   * can't even see one — the pure cordon 404s it upstream). Items stamped with
   * a TIER (`household`, `owner`) are nobody's to share: 'household' is already
   * shared, and widening 'owner' would be a tier edit dressed up as a share.
   */
  const may_share = (row: MediaItemRow, caller: Caller): boolean =>
    !!caller.user_id && owner_of(row) === caller.user_id;

  /**
   * Every user eligible to RECEIVE this item, server-filtered: the whole
   * users.yaml roster minus the caller and minus the item's owning user (the
   * same user today, but the exclusion is written out so it survives any
   * future widening of `may_share`). Already-shared users are INCLUDED — the
   * client renders a toggle list, not an add-only list.
   *
   * FRIEND-TIER USERS ARE ELIGIBLE RECIPIENTS. The friend silo is deliberate
   * and stays intact: it exists to stop PASSIVE, bulk visibility (a friend is
   * excluded from `private_to: household`, from the household graph, and from
   * shared_entity stamping). A share is the opposite of passive — it is one
   * item, named, chosen by that item's own owner, and it grants nothing else.
   * The precedent is already in this file: a generated image sent to Kim
   * renders for Kim. Excluding friends here would also mean Hearth could
   * never send a friend the one clip they were promised, while a friend's own
   * items stay siloed from everyone regardless, since only an item's owner can
   * share it.
   *
   * BUT A FRIEND-TIER *CALLER* SEES ONLY THE OWNER (2026-07-29). The roster —
   * ids, display names and tiers of every household member and every other
   * friend — is household-confidential, and this list is the one place it would
   * otherwise reach a friend's client. `can_share: false` already strips it for
   * that exact reason ("a friend has no business receiving the household
   * roster"); handing a friend the full list the moment they own one archived
   * item contradicted that. A friend's relationship with this house is mediated
   * by its owner: sharing UP to the owner is the flow that has a justification
   * (Kim sends back the clip he was asked for), and it costs a friend nothing
   * they could otherwise do, since the owner cannot see a friend's item at all
   * (pure cordon) and so cannot fetch it themselves.
   *
   * The conservative option is implemented on purpose: friend→household-member
   * sharing is now impossible rather than silently permitted. Widening it is an
   * owner policy call, and it needs a consent step (the recipient opting in to
   * being discoverable), not a wider list here.
   */
  const share_targets = (
    row: MediaItemRow,
    caller: Caller,
  ): { user_id: string; name: string; tier: string }[] => {
    if (!deps.users) return [];
    const excluded = new Set([caller.user_id, owner_of(row)]);
    const eligible = deps.users.list().filter((u) => !excluded.has(u.id));
    const visible_to_caller =
      caller.tier === 'friend' ? eligible.filter((u) => u.tier === 'owner') : eligible;
    return visible_to_caller.map((u) => ({
      user_id: u.id,
      name: u.display_name,
      tier: u.tier,
    }));
  };

  /**
   * The note's live sharing state: `shared_with` ids + the per-user
   * `shared_at` stamps. Read from the LIVE note, not the projection's
   * frontmatter_json — the ingestor reprojects async, so a share written a
   * moment ago isn't on the row yet (the projection-lag hazard).
   */
  const share_state = (row: MediaItemRow): { ids: string[]; at: Record<string, string> } => {
    const fm = deps.memory.read_note(row.note_path)?.frontmatter ?? {};
    const raw_at = fm.shared_at;
    const at: Record<string, string> = {};
    if (raw_at && typeof raw_at === 'object' && !Array.isArray(raw_at)) {
      for (const [k, v] of Object.entries(raw_at as Record<string, unknown>)) {
        if (typeof v === 'string' && v.trim()) at[k] = v;
      }
    }
    return { ids: parse_shared_with(fm.shared_with), at };
  };

  /**
   * The `sharing` object served on item detail and returned by the share verb.
   * `undefined` when no roster is configured (the key is simply absent).
   *
   * When the caller may NOT share, this is `{ can_share: false }` and nothing
   * else: a recipient has no business learning who ELSE holds a grant, and a
   * friend has no business receiving the household roster. Clients render no
   * share affordance at all in that case, so they need no other field.
   *
   * Every user-facing string in here is server-owned (`hint`, `empty_hint`,
   * `state_label`) — a client that composes its own is a divergence waiting to
   * happen, and `state_label` in particular is a name-joining decision (order,
   * separator, locale) that must not be made twice.
   */
  const sharing_of = (row: MediaItemRow, caller: Caller): Record<string, unknown> | undefined => {
    if (!deps.users) return undefined;
    if (!may_share(row, caller)) return { can_share: false };
    const roster = new Map(deps.users.list().map((u) => [u.id, u]));
    const { ids, at } = share_state(row);
    // A grant naming someone who has since left the roster still shows (as the
    // raw id) rather than vanishing silently; it drops out on the next save,
    // since the picker only ever offers current targets.
    const shared_with = ids.map((id) => ({
      user_id: id,
      name: roster.get(id)?.display_name ?? id,
      tier: roster.get(id)?.tier ?? null,
      shared_at: at[id] ?? null,
    }));
    return {
      can_share: true,
      shared_with,
      targets: share_targets(row, caller),
      hint: SHARE_HINT,
      empty_hint: SHARE_EMPTY_HINT,
      state_label: share_state_label(shared_with.map((e) => e.name)),
    };
  };

  // POST /api/media/item/:id/share { user_ids: [...] } → the BARE `sharing`
  // object, post-mutation (NOT `{ok, sharing}` — the response IS the same value
  // the read serves under `sharing`, so one client decoder handles both).
  // Declarative SET REPLACEMENT, not add/remove: it is idempotent, it lets the
  // client be a pure renderer of a checkbox list, and two clients editing the
  // same item can't interleave into a wrong set. `{"user_ids": []}` unshares
  // completely. Errors are `{error: <server copy>}` — the clients render that
  // string, they don't substitute their own.
  r.post('/item/:id/share', async (c) => {
    const caller = caller_of(c);
    if (!caller) return c.json({ error: 'authentication required' }, 401);
    const row = deps.memory.get_media_item(c.req.param('id'), caller);
    if (!row) return c.json({ error: 'not found' }, 404); // cordon miss = 404, never 403
    if (!deps.users) return c.json({ error: 'sharing is unavailable on this server' }, 503);
    // Visible but not the caller's to share (an item shared WITH them, or a
    // household item). 403 leaks nothing they don't already know — the
    // 404-shape rule covers items they can't see, which the cordon caught above.
    if (!may_share(row, caller)) return c.json({ error: 'not yours to share' }, 403);

    let body: { user_ids?: unknown } = {};
    try {
      body = (await c.req.json()) as typeof body;
    } catch {
      /* empty/invalid body — fall through to the validation below */
    }
    if (!Array.isArray(body.user_ids)) {
      return c.json({ error: 'user_ids must be an array of user ids' }, 400);
    }
    // Reject a malformed entry rather than dropping it: a set-replacement verb
    // that silently ignored a bad id would UNSHARE instead of erroring.
    if (body.user_ids.some((v) => typeof v !== 'string' || v.trim().length === 0)) {
      return c.json({ error: 'user_ids must contain non-empty user id strings' }, 400);
    }
    const requested = parse_shared_with(body.user_ids);
    // Never trust the client's list: only ids the SERVER offered as targets.
    const allowed = new Set(share_targets(row, caller).map((t) => t.user_id));
    const rejected = requested.filter((id) => !allowed.has(id));
    if (rejected.length > 0) {
      return c.json({ error: `not a valid share target: ${rejected.join(', ')}` }, 400);
    }

    // Preserve the original stamp for a user who stays in the set; stamp NOW
    // for a newly-added one, so "shared_at" stays honest across a set rewrite.
    const prior = share_state(row);
    const now = new Date().toISOString();
    const shared_at: Record<string, string> = {};
    for (const id of requested) shared_at[id] = prior.at[id] ?? now;
    // upsert_note MERGES frontmatter over the existing note and preserves the
    // body, so a two-key patch is safe.
    deps.memory.upsert_note(row.note_path, { shared_with: requested, shared_at }, '');

    try {
      deps.memory.log_action({
        intent_id: ulid(),
        agent: 'orchestrator',
        tool_name: 'media_share',
        tool_input: { media_item_id: row.id, note_path: row.note_path, by: caller.user_id },
        execution_result: { shared_with: requested, was: prior.ids },
      });
    } catch {
      /* audit is best-effort — never block a share on audit plumbing */
    }

    deps.events?.emit({
      type: 'media_shared',
      media_item_id: row.id,
      shared_with: requested,
      by: caller.user_id ?? null,
      // Delivery audience = prior ∪ new. A REVOKED user is the subscriber who
      // most needs this: their Archive is still showing an item they no longer
      // have, and nothing else will tell them to refetch. Stripped from the
      // wire payload by sse_wire_payload (see the event's docs).
      deliver_to: [...new Set([...prior.ids, ...requested])],
    });

    // The response IS the `sharing` object, bare — the contract-literal shape,
    // identical to the read's `sharing` value so one client decoder serves both.
    const sharing = sharing_of(row, caller);
    // Unreachable: the rosterless case 503'd above and may_share passed.
    if (!sharing) return c.json({ error: 'sharing is unavailable on this server' }, 503);
    return c.json(sharing);
  });

  // ── item detail (metrics + stream/thumb urls + chapters) ─────────────────
  r.get('/item/:id', (c) => {
    const caller = caller_of(c);
    if (!caller) return c.json({ error: 'authentication required' }, 401);
    const row = deps.memory.get_media_item(c.req.param('id'), caller);
    if (!row) return c.json({ error: 'not found' }, 404); // cordon miss = 404, never 403
    const fm = parse_frontmatter(row);
    const metrics = (fm.metrics && typeof fm.metrics === 'object' ? fm.metrics : {}) as Record<string, unknown>;
    const chapters = Array.isArray(fm.chapters)
      ? fm.chapters
      : Array.isArray(metrics.chapters)
        ? metrics.chapters
        : [];
    // Serve the source "most replayed" curve top-level (grey scrubber overlay)
    // and strip it from the served metrics so it isn't sent twice.
    const raw_heatmap = Array.isArray((metrics as Record<string, unknown>).heatmap)
      ? ((metrics as Record<string, unknown>).heatmap as unknown[])
      : null;
    const { heatmap: _heat_drop, ...metrics_clean } = metrics as Record<string, unknown>;
    return c.json({
      ...project_card(row),
      fps: typeof fm.fps === 'number' ? fm.fps : null,
      vcodec: typeof fm.vcodec === 'string' ? fm.vcodec : null,
      acodec: typeof fm.acodec === 'string' ? fm.acodec : null,
      container: row.container,
      filesize: row.filesize,
      published_at: row.published_at,
      language: typeof fm.language === 'string' ? fm.language : null,
      tags: Array.isArray(fm.tags) ? fm.tags : [],
      summary: typeof fm.summary === 'string' ? fm.summary : null,
      chapters,
      // Where `chapters` came from: the source's own bar, or mined from the
      // description / a top comment when it had none. Null for legacy items
      // archived before mining existed — an absent credit is not a claim of
      // officialness, so clients should attribute only when this is present.
      chapter_source:
        chapters.length > 0 && fm.chapter_source && typeof fm.chapter_source === 'object'
          ? fm.chapter_source
          : null,
      metrics: metrics_clean,
      heatmap: raw_heatmap,
      household_heatmap: watch_heat(row.id), // wire name kept — see watch_heat
      // Subtitle/caption tracks (rescan_media_metadata). Each is served as
      // WebVTT via GET /api/media/captions/:id/:lang — the player wires a <track>.
      captions: Array.isArray(fm.captions)
        ? (fm.captions as Array<Record<string, unknown>>)
            .filter((c) => c && typeof c.lang === 'string')
            .map((c) => ({ lang: c.lang as string, format: (c.format as string) ?? 'srt', auto: c.auto === true }))
        : undefined,
      images: Array.isArray(fm.images) ? fm.images : undefined,
      image_count:
        typeof fm.image_count === 'number'
          ? fm.image_count
          : Array.isArray(fm.images)
            ? fm.images.length
            : undefined,
      // Sharing: eligibility + current state + the picker's copy, all
      // server-owned (see the sharing block above). Additive and optional —
      // absent on a server with no roster, and a client that predates it just
      // ignores the key, so neither deploy order breaks.
      sharing: sharing_of(row, caller),
    });
  });

  // ── watch progress → household heat ───────────────────────
  // POST /api/media/progress/:id { position_s, duration_s } → bump the bucket
  // for the current position. Cordon-gated (get_media_item 404s a hidden item,
  // so a member can't feed heat for an owner-only NSFW row).
  r.post('/progress/:id', async (c) => {
    const caller = caller_of(c);
    if (!caller) return c.json({ error: 'authentication required' }, 401);
    const id = c.req.param('id');
    const row = deps.memory.get_media_item(id, caller);
    if (!row) return c.json({ error: 'not found' }, 404); // cordon miss = 404
    let body: { position_s?: unknown; duration_s?: unknown } = {};
    try {
      body = (await c.req.json()) as typeof body;
    } catch {
      /* empty/invalid body — fall through to the validation below */
    }
    const pos = Number(body.position_s);
    const dur = Number(body.duration_s);
    if (!Number.isFinite(pos) || !Number.isFinite(dur) || dur <= 0 || pos < 0) {
      return c.json({ ok: false, error: 'position_s and positive duration_s required' }, 400);
    }
    const bucket = Math.max(0, Math.min(HEAT_BUCKETS - 1, Math.floor((pos / dur) * HEAT_BUCKETS)));
    deps.db
      .prepare(
        `INSERT INTO media_watch_heat (media_id, bucket, count) VALUES (?, ?, 1)
         ON CONFLICT(media_id, bucket) DO UPDATE SET count = count + 1`,
      )
      .run(id, bucket);
    return c.json({ ok: true });
  });

  // ── direct-play stream (HTTP range / 206) ────────────────────────────────
  r.get('/stream/:id', (c) => {
    const caller = caller_of(c);
    if (!caller) return c.json({ error: 'authentication required' }, 401);
    const row = deps.memory.get_media_item(c.req.param('id'), caller);
    if (!row || !row.nas_path) return c.json({ error: 'not found' }, 404);
    // A gallery's nas_path is a DIRECTORY, not a streamable file — clients use
    // /image/:id/:idx instead; never statSync+serve a directory.
    if (row.media_kind === 'image_gallery' || row.media_kind === 'photoset') {
      return c.json({ error: 'not a streamable file (image gallery)' }, 404);
    }
    const abs = safe_archive_abs(deps.archive_root, row.nas_path);
    if (!abs || !existsSync(abs)) return c.json({ error: 'not found' }, 404);
    return serve_media_file(c, abs);
  });

  // ── poster / thumbnail bytes ─────────────────────────────────────────────
  r.get('/thumb/:id', (c) => {
    const caller = caller_of(c);
    if (!caller) return c.json({ error: 'authentication required' }, 401);
    const row = deps.memory.get_media_item(c.req.param('id'), caller);
    if (!row || !row.thumbnail_path) return c.json({ error: 'not found' }, 404);
    const abs = safe_archive_abs(deps.archive_root, row.thumbnail_path);
    if (!abs || !existsSync(abs)) return c.json({ error: 'not found' }, 404);
    let mtime: Date;
    try {
      mtime = statSync(abs).mtime;
    } catch {
      return c.json({ error: 'not found' }, 404);
    }
    return new Response(Bun.file(abs), {
      headers: {
        'content-type': content_type_for(abs),
        'cache-control': 'private, max-age=86400',
        'last-modified': mtime.toUTCString(),
        etag: `"${row.id}-${Math.floor(mtime.getTime() / 1000)}"`,
      },
    });
  });

  // ── generated chat images ────────────────────────────────────────────────
  // GET /api/media/generated/:filename → a PNG the generate_image tool wrote
  // (Krea 2 on forza), referenced by markdown in chat `content_md`. The gate
  // is AUTHENTICATION, not a cordon row: the filename is a server-minted
  // ULID (unguessable), the URL only ever lands in the thread it was made
  // for, and an image sent to a friend-tier user (Linda→Kim) must render
  // for that user too. Immutable cache — a filename is written exactly once.
  r.get('/generated/:filename', (c) => {
    const caller = caller_of(c);
    if (!caller) return c.json({ error: 'authentication required' }, 401);
    if (!deps.generated_root) return c.json({ error: 'not found' }, 404);
    const abs = safe_archive_abs(deps.generated_root, c.req.param('filename'));
    if (!abs || !existsSync(abs)) return c.json({ error: 'not found' }, 404);
    return new Response(Bun.file(abs), {
      headers: {
        'content-type': content_type_for(abs),
        'cache-control': 'private, max-age=31536000, immutable',
      },
    });
  });

  // ── caption/subtitle track as WebVTT ─────────────────────────────────────
  // GET /api/media/captions/:id/:lang → the SRT track for :lang converted to
  // WebVTT (HTML5 <track> rejects SRT). Cordon-checked (an owner-only item
  // 404-shapes for a member); path clamped like every other archive read.
  r.get('/captions/:id/:lang', async (c) => {
    const caller = caller_of(c);
    if (!caller) return c.json({ error: 'authentication required' }, 401);
    const row = deps.memory.get_media_item(c.req.param('id'), caller);
    if (!row) return c.json({ error: 'not found' }, 404); // cordon miss = 404
    const lang = c.req.param('lang');
    const fm = parse_frontmatter(row);
    const tracks = Array.isArray(fm.captions) ? (fm.captions as Array<Record<string, unknown>>) : [];
    const track = tracks.find((t) => t && t.lang === lang && typeof t.path === 'string');
    const rel = track && typeof track.path === 'string' ? track.path : null;
    if (!rel) return c.json({ error: 'not found' }, 404);
    const abs = safe_archive_abs(deps.archive_root, rel);
    if (!abs || !existsSync(abs)) return c.json({ error: 'not found' }, 404);
    let srt: string;
    try {
      srt = await Bun.file(abs).text();
    } catch {
      return c.json({ error: 'not found' }, 404);
    }
    return new Response(srt_to_vtt(srt), {
      headers: { 'content-type': 'text/vtt; charset=utf-8', 'cache-control': 'private, max-age=3600' },
    });
  });

  // ── gallery image bytes (image_gallery items — the per-image viewer) ──────
  // GET /api/media/image/:id/:idx → the idx-th image under the gallery directory.
  // nas_path is the DIRECTORY; images[idx].file (from frontmatter) is the name.
  r.get('/image/:id/:idx', (c) => {
    const caller = caller_of(c);
    if (!caller) return c.json({ error: 'authentication required' }, 401);
    const row = deps.memory.get_media_item(c.req.param('id'), caller);
    if (!row || !row.nas_path) return c.json({ error: 'not found' }, 404); // cordon miss = 404
    // Strict digits only — Number.parseInt('1e3',10) would silently become 1 and
    // serve the wrong (in-range) image; reject anything non-numeric outright.
    const idx_raw = c.req.param('idx');
    if (!/^\d+$/.test(idx_raw)) return c.json({ error: 'not found' }, 404);
    const idx = Number.parseInt(idx_raw, 10);
    if (!Number.isSafeInteger(idx)) return c.json({ error: 'not found' }, 404);
    const fm = parse_frontmatter(row);
    const images = Array.isArray(fm.images) ? fm.images : [];
    const img = images[idx] as { file?: unknown } | undefined;
    const file = img && typeof img.file === 'string' ? img.file : null;
    if (!file) return c.json({ error: 'not found' }, 404);
    // Resolve <nas_path>/<file>; safe_archive_abs clamps any escape under the root.
    const rel = `${row.nas_path.replace(/\/+$/, '')}/${file}`;
    const abs = safe_archive_abs(deps.archive_root, rel);
    if (!abs || !existsSync(abs)) return c.json({ error: 'not found' }, 404);
    let mtime: Date;
    try {
      mtime = statSync(abs).mtime;
    } catch {
      return c.json({ error: 'not found' }, 404);
    }
    return new Response(Bun.file(abs), {
      headers: {
        'content-type': content_type_for(abs),
        'cache-control': 'private, max-age=86400',
        'last-modified': mtime.toUTCString(),
        etag: `"${row.id}-${idx}-${Math.floor(mtime.getTime() / 1000)}"`,
      },
    });
  });

  return r;
}
