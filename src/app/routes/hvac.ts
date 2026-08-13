/**
 * /app/hvac — the heat-pump replacement guide: page, assets, and persistence.
 *
 * The guide itself (`src/app/client/hvac/index.html`) is a self-contained
 * decision worksheet — 107 checkboxes and 171 text fields across a per-vendor
 * contractor checklist and a scorecard — authored outside this repo and
 * dropped in wholesale. It ships with a ~50-line autosave IIFE that talks to a
 * RELATIVE `api/state`, which is why the canonical URL carries a TRAILING
 * SLASH: from `/app/hvac/` that resolves to `/app/hvac/api/state` (mounted
 * here), while from a bare `/app/hvac` it would resolve to `/app/api/state`
 * and 404. So `/app/hvac` 301s to `/app/hvac/`, and the HTML stays
 * byte-identical to what the chat session produced.
 *
 *   GET  /app/hvac        ->  301 /app/hvac/
 *   GET  /app/hvac/       ->  the guide
 *   GET  /app/hvac/api/state  ->  { rev, updated, data }
 *   POST /app/hvac/api/state  <-  { data }
 *                             ->  { rev, updated, data }
 *
 * ⚠ THE TRAILING SLASH CANNOT BE A ROUTING CONCERN. Hono matches `/hvac` and
 * `/hvac/` as the SAME route, so registering a redirect on one and the page on
 * the other means whichever was registered first answers both — which shipped
 * once (2026-07-29) as an infinite `/app/hvac/` -> `/app/hvac/` loop that made
 * the page unreachable. One handler owns `/`, and it decides by reading the
 * REAL pathname off the request. `smoke:hvac` mounts this router under a
 * parent at `/app` — the exact shape that broke — and asserts both.
 *
 * `data` is opaque here — store it and hand it back. Its shape is the page's
 * business: `{ f: {inputId: string}, c: {checkboxId: 1}, pad: string }`.
 *
 * `rev` is a monotonic counter. The page polls every 15 s and reloads when the
 * server's rev exceeds its own AND it has no pending local edits — that's what
 * lets a phone at a contractor appointment sync back to the laptop at home.
 * Last-write-wins is deliberate; there is no merge logic and two people are
 * the entire audience.
 *
 * Storage is `kv_settings` (the existing JSON-blob store) rather than a new
 * table or a file on disk: it inherits SQLite's atomicity, it lives in the
 * bind-mounted data dir so a redeploy can't lose entries, and it needs no
 * migration. Read-modify-write runs inside a transaction so two devices
 * saving at once can't both mint the same rev.
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
import type { Database } from 'bun:sqlite';
import { resolve } from 'node:path';
import { local_iso_date, format_short_datetime } from '@core/time';
import { serve_static } from '../static';

/** Live state. One row — this is a single household worksheet, not a table. */
const STATE_KEY = 'hvac_guide_state';
/** Daily snapshot rows, `hvac_guide_backup:YYYY-MM-DD` (local day). */
const BACKUP_PREFIX = 'hvac_guide_backup:';
const BACKUP_KEEP_DAYS = 30;

/**
 * Cap on a single save. The full worksheet serializes to well under 100 KB;
 * 4 MB is a generous ceiling that still refuses a runaway client.
 */
const MAX_BODY_BYTES = 4_000_000;

export interface HvacState {
  rev: number;
  /** Display string in the house zone, e.g. "Tue 9:04 AM". Null before first save. */
  updated: string | null;
  data: unknown;
}

const EMPTY: HvacState = { rev: 0, updated: null, data: {} };

export interface HvacRouterDeps {
  db: Database;
  /** `src/app/client` — the guide lives in the `hvac/` subdir beneath it. */
  client_dir: string;
  /**
   * Absolute path the bare-path redirect targets. Defaults to the real mount;
   * the smoke overrides it to assert the redirect independent of that default.
   */
  canonical_path?: string;
}

function read_state(db: Database): HvacState {
  const row = db
    .prepare(`SELECT value_json FROM kv_settings WHERE key = @k`)
    .get({ '@k': STATE_KEY }) as { value_json: string } | undefined;
  if (!row) return EMPTY;
  try {
    const parsed = JSON.parse(row.value_json) as Partial<HvacState>;
    return {
      rev: typeof parsed.rev === 'number' ? parsed.rev : 0,
      updated: typeof parsed.updated === 'string' ? parsed.updated : null,
      data: parsed.data ?? {},
    };
  } catch {
    // A corrupt blob reads as empty rather than throwing — the page then shows
    // an empty worksheet instead of an error, and yesterday's snapshot is still
    // sitting in a backup row if it needs recovering by hand.
    return EMPTY;
  }
}

export function create_hvac_router(deps: HvacRouterDeps): Hono {
  const { db } = deps;
  const hvac_dir = resolve(deps.client_dir, 'hvac');
  const canonical = deps.canonical_path ?? '/app/hvac/';

  /**
   * Read-modify-write + daily snapshot + prune, atomically. Anything that
   * throws inside rolls the whole thing back, so a crash mid-save leaves the
   * previous revision intact.
   */
  const commit = db.transaction((data: unknown): HvacState => {
    const now = new Date();
    const ts_iso = now.toISOString();
    const current = read_state(db);
    const next: HvacState = {
      rev: current.rev + 1,
      updated: format_short_datetime(ts_iso) ?? ts_iso,
      data,
    };

    const upsert = db.prepare(
      `INSERT INTO kv_settings (key, value_json, ts_updated)
       VALUES (@k, @v, @ts)
       ON CONFLICT(key) DO UPDATE SET value_json = @v, ts_updated = @ts`,
    );
    const payload = JSON.stringify(next);
    upsert.run({ '@k': STATE_KEY, '@v': payload, '@ts': ts_iso });

    // One snapshot per local day (the day's last save wins), keep 30.
    const day = local_iso_date(now);
    upsert.run({ '@k': `${BACKUP_PREFIX}${day}`, '@v': payload, '@ts': ts_iso });
    db.prepare(
      `DELETE FROM kv_settings
        WHERE key LIKE @like
          AND key NOT IN (
            SELECT key FROM kv_settings
             WHERE key LIKE @like
             ORDER BY key DESC
             LIMIT @keep
          )`,
    ).run({ '@like': `${BACKUP_PREFIX}%`, '@keep': BACKUP_KEEP_DAYS });

    return next;
  });

  const r = new Hono();

  // ⚠ ROUTE ORDER IS LOAD-BEARING IN THIS FILE. The page's catch-all (`/*`,
  // registered LAST, below) is the only way to serve the trailing-slash root,
  // and Hono resolves a wildcard against earlier-registered routes by
  // REGISTRATION ORDER — a `/*` placed above `/api/state` swallows it (probed
  // directly, both orders). Every specific route must be registered first.

  // ── Assets ──────────────────────────────────────────────────────────────
  //
  // Vendored webfonts — the guide makes no external request (scripts/vendor-hvac-fonts.py).
  r.get('/fonts.css', (c) => serve_static(c, resolve(hvac_dir, 'fonts.css')));
  r.get('/fonts/:name', (c) => {
    const name = c.req.param('name');
    if (name.includes('..') || name.includes('/')) return c.text('bad request', 400);
    return serve_static(c, resolve(hvac_dir, 'fonts', name));
  });

  // ── State ───────────────────────────────────────────────────────────────

  r.get('/api/state', (c) => {
    c.header('Cache-Control', 'no-store');
    return c.json(read_state(db));
  });

  r.post('/api/state', async (c) => {
    const declared = Number(c.req.header('content-length') ?? 0);
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
      return c.json({ error: 'too large' }, 413);
    }
    let body: { data?: unknown };
    try {
      body = (await c.req.json()) as { data?: unknown };
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : 'bad json' }, 400);
    }
    c.header('Cache-Control', 'no-store');
    return c.json(commit(body?.data ?? {}));
  });

  // ── The page — REGISTERED LAST (see the route-order note above) ──────────
  //
  // ONE handler, registered on BOTH `'/'` and `'/*'`, deciding purely from the
  // REAL pathname. Which of the two patterns Hono picks for a given URL is not
  // knowable in advance and must not be relied on: Hono's SmartRouter chooses a
  // different underlying matcher depending on how many routes the app has, so a
  // 4-route probe and the ~300-route production router disagree about whether
  // `/app/hvac/` lands on `'/'` or `'/*'`. Both prior attempts at this shipped
  // an infinite `/app/hvac/` -> `/app/hvac/` loop by assuming otherwise.
  //
  // Because the handler is identical on both patterns, the response depends
  // only on the pathname — a self-redirect is not representable whichever
  // matcher runs. Do not "simplify" this into two different handlers.
  const page = (c: Context): Response => {
    const path = new URL(c.req.url).pathname;
    if (path === canonical) return serve_static(c, resolve(hvac_dir, 'index.html'));
    // The bare path — canonical minus its trailing slash — is the only thing
    // that redirects. Everything else under the mount is a genuine 404.
    if (`${path}/` === canonical) return c.redirect(canonical, 301);
    return c.text('not found', 404);
  };
  r.get('/', page);
  r.get('/*', page);

  return r;
}
