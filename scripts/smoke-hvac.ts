/**
 * smoke:hvac — the heat-pump guide surface at /app/hvac/.
 *
 * Self-contained: temp db, no network, no LLM. Exercises the contract the
 * guide's autosave IIFE actually depends on:
 *   - MOUNTED under a parent at `/app`, the real shape: `/app/hvac` 301s and
 *     `/app/hvac/` serves the page. Hono matches those as ONE route, so a
 *     redirect registered on one answers both — that shipped once as an
 *     infinite loop. This is the regression that catches it.
 *   - empty read before any save (rev 0, updated null, data {})
 *   - POST returns the stored state; rev is monotonic across saves
 *   - `data` is opaque — nested/unicode/empty payloads round-trip verbatim
 *   - GET after POST reflects the last write (the 15 s cross-device poll)
 *   - malformed body → 400, oversized declared length → 413, neither of
 *     which disturbs the state already stored
 *   - a corrupt blob in kv_settings reads as empty instead of throwing
 *   - daily snapshots accumulate one row per local day and prune to 30
 *   - the shipped page is wired to the vendored fonts, not Google's CDN
 */
import { Hono } from 'hono';
import { RegExpRouter } from 'hono/router/reg-exp-router';
import { TrieRouter } from 'hono/router/trie-router';
import { PatternRouter } from 'hono/router/pattern-router';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { open_db } from '../src/memory/stores/structured';
import { create_hvac_router, type HvacState } from '../src/app/routes/hvac';

let pass = 0;
function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
  pass++;
}

const tmp = mkdtempSync(join(tmpdir(), 'hearth-hvac-'));

try {
  const db = open_db(join(tmp, 'hearth.db'));
  const client_dir = resolve(import.meta.dir, '../src/app/client');

  // Mounted EXACTLY as production mounts it: the hvac router under `/hvac` on
  // the /app sub-router, which is itself mounted under `/app`. The trailing-
  // slash bug only manifests through this nesting — testing the router bare
  // would pass while the deployed page redirect-looped.
  const app_router = new Hono();
  app_router.route('/hvac', create_hvac_router({ db, client_dir }));
  const app = new Hono();
  app.route('/app', app_router);

  const API = '/app/hvac/api/state';
  const get = async (): Promise<HvacState> => {
    const res = await app.request(API);
    assert(res.status === 200, `GET ${API} -> 200 (got ${res.status})`);
    return (await res.json()) as HvacState;
  };
  const post = async (body: unknown, expect = 200) => {
    const res = await app.request(API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });
    assert(res.status === expect, `POST ${API} -> ${expect} (got ${res.status})`);
    return res;
  };

  // ── Routing: the trailing slash (regression, 2026-07-29) ──────────────
  //
  // THE bug, twice over. Hono's routers disagree about which pattern owns the
  // trailing-slash mount root — measured, not guessed:
  //
  //     RegExpRouter    /app/hvac/  ->  '/*'
  //     TrieRouter      /app/hvac/  ->  '/*'
  //     PatternRouter   /app/hvac/  ->  '/'      <-- what production resolves to
  //
  // `new Hono()` uses SmartRouter, which picks among them based on the app's
  // whole pattern mix. A dev-sized app lands on RegExpRouter, so the first fix
  // passed every local test and still redirect-looped on the box. Asserting
  // against each concrete router is the only honest coverage; a
  // SmartRouter-only test proves nothing about production.
  const ROUTERS: Array<[string, () => unknown]> = [
    ['RegExpRouter', () => new RegExpRouter()],
    ['TrieRouter', () => new TrieRouter()],
    ['PatternRouter', () => new PatternRouter()],
  ];
  for (const [rname, mk] of ROUTERS) {
    const sub = new Hono({ router: mk() as never });
    sub.route('/hvac', create_hvac_router({ db, client_dir }));
    const parent = new Hono({ router: mk() as never });
    parent.route('/app', sub);

    const canon = await parent.request('/app/hvac/');
    // THE loop invariant: the canonical URL must never redirect to itself.
    assert(
      canon.status !== 301 && canon.status !== 302,
      `[${rname}] /app/hvac/ must NOT redirect (got ${canon.status} -> ${canon.headers.get('location')})`,
    );
    assert(canon.status === 200, `[${rname}] GET /app/hvac/ serves the page (got ${canon.status})`);

    const bare_r = await parent.request('/app/hvac');
    assert(bare_r.status === 301, `[${rname}] GET /app/hvac -> 301 (got ${bare_r.status})`);
    assert(
      bare_r.headers.get('location') === '/app/hvac/',
      `[${rname}] bare path redirects to /app/hvac/ (got ${bare_r.headers.get('location')})`,
    );

    const api_r = await parent.request('/app/hvac/api/state');
    assert(api_r.status === 200, `[${rname}] state API resolves under the mount (got ${api_r.status})`);
    const junk = await parent.request('/app/hvac/junk');
    assert(junk.status === 404, `[${rname}] junk under the mount 404s (got ${junk.status})`);
  }

  const bare = await app.request('/app/hvac');
  assert(bare.status === 301, `GET /app/hvac -> 301 (got ${bare.status})`);
  assert(
    bare.headers.get('location') === '/app/hvac/',
    `bare path redirects to /app/hvac/ (got ${bare.headers.get('location')})`,
  );

  const page = await app.request('/app/hvac/');
  assert(page.status === 200, `GET /app/hvac/ -> 200, NOT another redirect (got ${page.status})`);
  assert(
    (page.headers.get('content-type') ?? '').startsWith('text/html'),
    `the page is served as html (got ${page.headers.get('content-type')})`,
  );
  const html = await page.text();
  assert(html.includes('<title>'), 'page body is the guide, not an error string');
  // The guide's autosave IIFE fetches a RELATIVE api/state — that only resolves
  // correctly from the trailing-slash URL, which is why the redirect exists.
  assert(html.includes("'api/state'"), 'the shipped page still uses the relative api/state fetch');
  // Fonts are vendored: nothing about this page may reach out to Google.
  assert(
    !html.includes('fonts.googleapis.com') && !html.includes('fonts.gstatic.com'),
    'the shipped page references NO external font CDN',
  );
  assert(html.includes('./fonts.css'), 'the shipped page points at the vendored fonts.css');

  const css = await app.request('/app/hvac/fonts.css');
  assert(css.status === 200, `GET fonts.css -> 200 (got ${css.status})`);
  const css_body = await css.text();
  assert(
    !css_body.includes('https://'),
    'vendored fonts.css contains no absolute URLs — every src is local',
  );
  const woff = await app.request('/app/hvac/fonts/Fraunces-latin.woff2');
  assert(woff.status === 200, `GET a vendored woff2 -> 200 (got ${woff.status})`);
  assert(
    woff.headers.get('content-type') === 'font/woff2',
    `woff2 served with the font MIME (got ${woff.headers.get('content-type')})`,
  );
  const escape = await app.request('/app/hvac/fonts/..%2F..%2Fapp.css');
  assert(escape.status !== 200, `path traversal out of fonts/ is refused (got ${escape.status})`);

  // ── Empty read ────────────────────────────────────────────────────────
  const empty = await get();
  assert(empty.rev === 0, 'fresh db reads rev 0');
  assert(empty.updated === null, 'fresh db has no updated stamp');
  assert(JSON.stringify(empty.data) === '{}', 'fresh db has empty data');

  // ── Round-trip, opaque payload ────────────────────────────────────────
  // Shaped like the real worksheet: text fields, checked boxes, scratchpad.
  const worksheet = {
    f: { sc_vendor1_price: '18,400', vname_1: 'Bell & Sons — Mitsubishi', notes_odd: 'ø é 日本語' },
    c: { cb_manual_j: 1, cb_ductwork_static: 1 },
    pad: 'Ask about the 25C credit cap.\nSecond line.',
  };
  const saved = (await (await post({ data: worksheet })).json()) as HvacState;
  assert(saved.rev === 1, 'first save mints rev 1');
  assert(typeof saved.updated === 'string' && saved.updated.length > 0, 'save stamps updated');
  assert(
    JSON.stringify(saved.data) === JSON.stringify(worksheet),
    'POST echoes the payload verbatim',
  );

  const reread = await get();
  assert(reread.rev === 1, 'GET sees rev 1');
  assert(
    JSON.stringify(reread.data) === JSON.stringify(worksheet),
    'GET round-trips unicode + nested payload byte-equal',
  );

  // ── Monotonic rev — what the cross-device poll keys on ────────────────
  const second = (await (await post({ data: { ...worksheet, pad: 'edited' } })).json()) as HvacState;
  assert(second.rev === 2, 'second save mints rev 2');
  const third = (await (await post({ data: {} })).json()) as HvacState;
  assert(third.rev === 3, 'rev advances even when data empties');
  assert(JSON.stringify((await get()).data) === '{}', 'clearing the worksheet persists');

  // ── Bad input never disturbs stored state ─────────────────────────────
  await post('{not json', 400);
  const after_bad = await get();
  assert(after_bad.rev === 3, 'a 400 does not advance rev');

  const big = await app.request(API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'content-length': '9000000' },
    body: JSON.stringify({ data: {} }),
  });
  assert(big.status === 413, `oversized POST -> 413 (got ${big.status})`);
  assert((await get()).rev === 3, 'a 413 does not advance rev');

  // A POST with no `data` key stores empty rather than throwing.
  const noData = (await (await post({})).json()) as HvacState;
  assert(noData.rev === 4, 'POST without data still commits');

  // ── Corrupt blob degrades to empty, not a 500 ─────────────────────────
  db.prepare(`UPDATE kv_settings SET value_json = '{oops' WHERE key = 'hvac_guide_state'`).run();
  const corrupt = await get();
  assert(corrupt.rev === 0 && corrupt.updated === null, 'corrupt blob reads as empty state');
  // ...and the next save starts a clean sequence rather than wedging.
  const recovered = (await (await post({ data: { pad: 'after corruption' } })).json()) as HvacState;
  assert(recovered.rev === 1, 'save after corruption re-mints rev 1');

  // ── Daily snapshots: one row per local day, pruned to 30 ──────────────
  const backups = () =>
    (
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM kv_settings WHERE key LIKE 'hvac_guide_backup:%'`,
        )
        .get() as { n: number }
    ).n;
  assert(backups() === 1, `saves on one day share one snapshot row (got ${backups()})`);

  // Seed 40 older days directly, then save again and confirm the prune keeps 30.
  const insert = db.prepare(
    `INSERT OR REPLACE INTO kv_settings (key, value_json, ts_updated) VALUES (@k, @v, @ts)`,
  );
  for (let i = 1; i <= 40; i++) {
    const d = new Date(Date.UTC(2026, 0, i, 12)).toISOString().slice(0, 10);
    insert.run({ '@k': `hvac_guide_backup:${d}`, '@v': '{}', '@ts': `${d}T12:00:00Z` });
  }
  assert(backups() === 41, `seeded snapshots present (got ${backups()})`);
  await post({ data: { pad: 'prune me' } });
  assert(backups() === 30, `prune keeps exactly 30 snapshots (got ${backups()})`);
  const oldest = db
    .prepare(
      `SELECT key FROM kv_settings WHERE key LIKE 'hvac_guide_backup:%' ORDER BY key ASC LIMIT 1`,
    )
    .get() as { key: string };
  assert(
    oldest.key > 'hvac_guide_backup:2026-01-11',
    `prune drops the OLDEST days first (oldest kept: ${oldest.key})`,
  );

  // The live state survived all the snapshot churn.
  const final = await get();
  assert(final.rev === 2, `state intact after prune (rev ${final.rev})`);
  assert((final.data as { pad: string }).pad === 'prune me', 'last write wins');

  console.log(`smoke:hvac OK — ${pass} assertions`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
