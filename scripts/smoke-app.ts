export {}; // module scope
/**
 * Smoke for the unified UI at /app.
 *
 * Requires a running orchestrator with the /app router mounted. Best
 * launched against HEARTH_TEST_MODE=1 HEARTH_DISABLE_LOOPS=1 so the
 * library upload's optional specialist acknowledgement uses canned
 * responses rather than a live LLM.
 */

import { resolve } from 'node:path';
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';

const ORCH_URL = process.env.HEARTH_URL ?? 'http://localhost:7700';
const VAULT_ROOT = process.env.HEARTH_VAULT_ROOT ?? `${process.env.HOME}/vault-friday`;
const SPECIALISTS_DIR = resolve(
  process.env.HEARTH_SPECIALISTS_DIR ?? '/home/jasper/hearth/config/specialists',
);
const SMOKE_USER = process.env.HEARTH_SMOKE_USER ?? 'jasper';

// Phase 1 multi-user: the auth middleware gates /app + /api. The
// smoke creates a throwaway session row directly in SQLite and pins
// its cookie to every fetch. Cleanup at end. Works without knowing
// any user's real PIN — same approach Hearth's own CI would use.
import { Database } from 'bun:sqlite';
const DB_PATH = process.env.HEARTH_DB_PATH ?? '/home/jasper/hearth/data/hearth.db';
const _db = new Database(DB_PATH);
const SMOKE_SID = `sess_smoke_${Math.random().toString(36).slice(2, 10)}`;
_db
  .prepare(
    `INSERT INTO sessions (id, user_id, created_at, expires_at, last_seen_at, ip, ua)
     VALUES (@id, @uid, @now, @exp, @now, '127.0.0.1', 'smoke-app')`,
  )
  .run({
    '@id': SMOKE_SID,
    '@uid': SMOKE_USER,
    '@now': new Date().toISOString(),
    '@exp': new Date(Date.now() + 3600_000).toISOString(),
  });

const SMOKE_COOKIE = `hearth_sid=${SMOKE_SID}`;

// Monkey-patch fetch so every call to ORCH_URL/* carries the smoke
// session cookie. Saves wrapping every existing fetch() call site
// after Phase 1 auth landed and rejected anonymous requests.
const _real_fetch = fetch;
(globalThis as { fetch: typeof fetch }).fetch = function patched_fetch(input, init) {
  const url = typeof input === 'string' ? input : (input instanceof URL ? input.toString() : input.url);
  if (url.startsWith(ORCH_URL)) {
    const headers = new Headers((init?.headers) ?? (typeof input !== 'string' && !(input instanceof URL) ? input.headers : undefined));
    if (!headers.has('Cookie')) headers.set('Cookie', SMOKE_COOKIE);
    return _real_fetch(input, { ...(init ?? {}), headers });
  }
  return _real_fetch(input as Parameters<typeof fetch>[0], init);
} as typeof fetch;

function _with_cookie(init?: RequestInit): RequestInit {
  // Retained for callers that want to be explicit; patched fetch
  // would add the cookie anyway, but this stays here to avoid
  // confusion in future smoke edits.
  return init ?? {};
}
void _with_cookie;

async function fetch_json<T>(path: string, init?: RequestInit): Promise<{ status: number; body: T }> {
  const res = await fetch(`${ORCH_URL}${path}`, init);
  const text = await res.text();
  try {
    return { status: res.status, body: JSON.parse(text) as T };
  } catch {
    throw new Error(`Non-JSON ${path} (${res.status}): ${text.slice(0, 200)}`);
  }
}

async function main() {
  // 1) Static shell.
  console.log('→ GET /app/');
  const home = await fetch(`${ORCH_URL}/app/`);
  if (!home.ok) throw new Error(`/app/ HTTP ${home.status}`);
  const html = await home.text();
  if (!html.includes('<title>Hearth</title>')) {
    throw new Error('/app/ index does not include <title>Hearth</title>');
  }
  if (!html.includes('/app/app.css') || !html.includes('/app/app.js')) {
    throw new Error('/app/ index missing references to app.css or app.js');
  }
  console.log('  ✓ /app/ served with title + asset references');

  // 2) Static assets.
  for (const path of ['/app/app.css', '/app/app.js', '/app/manifest.webmanifest']) {
    console.log(`→ GET ${path}`);
    const r = await fetch(`${ORCH_URL}${path}`);
    if (!r.ok) throw new Error(`${path} HTTP ${r.status}`);
    console.log(`  ✓ ${path} → 200`);
  }

  // 3) manifest is valid JSON.
  console.log('→ Validate manifest JSON');
  const m = await fetch(`${ORCH_URL}/app/manifest.webmanifest`).then((r) => r.json() as Promise<{ name: string; icons: unknown[] }>);
  if (m.name !== 'Hearth') throw new Error(`manifest name wrong: ${m.name}`);
  if (!Array.isArray(m.icons) || m.icons.length === 0) throw new Error('manifest icons empty');
  console.log(`  ✓ manifest valid, name=${m.name}`);

  // 4) Avatar route.
  console.log('→ GET /app/api/avatars/kate');
  const ak = await fetch(`${ORCH_URL}/app/api/avatars/kate`);
  if (!ak.ok) throw new Error(`avatar HTTP ${ak.status}`);
  const ak_ct = ak.headers.get('content-type') || '';
  if (!ak_ct.startsWith('image/')) throw new Error(`avatar wrong content-type: ${ak_ct}`);
  console.log(`  ✓ /app/api/avatars/kate → ${ak_ct}`);

  console.log('→ GET /app/api/avatars/nonexistent_id');
  const an = await fetch(`${ORCH_URL}/app/api/avatars/nonexistent_id`);
  if (!an.ok) throw new Error(`fallback avatar HTTP ${an.status}`);
  const an_ct = an.headers.get('content-type') || '';
  if (!an_ct.startsWith('image/')) throw new Error(`fallback avatar wrong CT: ${an_ct}`);
  console.log(`  ✓ unknown specialist → fallback SVG (${an_ct})`);

  // 4b) Avatar POST / DELETE round-trip on Marguerite.
  // Marguerite is the canonical avatar target because she's a stable
  // registered specialist. The destructive POST/DELETE here would
  // permanently nuke her real avatar if we didn't snapshot+restore —
  // an earlier version of this smoke wiped her every hire cycle.
  const av_target_dir = resolve(VAULT_ROOT, 'Knowledge', 'Marguerite');
  const av_target_path = resolve(av_target_dir, 'avatar.png');
  const av_snapshot: Buffer | null = existsSync(av_target_path)
    ? readFileSync(av_target_path)
    : null;
  try {
    console.log('→ POST /app/api/avatars/marguerite (tiny PNG)');
    // 1×1 transparent PNG.
    const png_b64 =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
    const png_bytes = Uint8Array.from(atob(png_b64), (c) => c.charCodeAt(0));
    const av_form = new FormData();
    av_form.append('file', new File([png_bytes], 'avatar.png', { type: 'image/png' }));
    const ap = await fetch(`${ORCH_URL}/app/api/avatars/marguerite`, { method: 'POST', body: av_form });
    const ap_json = (await ap.json()) as { ok?: boolean; rel_path?: string; error?: string };
    if (!ap.ok || !ap_json.ok) throw new Error(`avatar POST failed: ${ap_json.error ?? ap.status}`);
    if (!ap_json.rel_path || !ap_json.rel_path.endsWith('avatar.png')) {
      throw new Error(`avatar POST wrong rel_path: ${ap_json.rel_path}`);
    }
    console.log(`  ✓ uploaded → ${ap_json.rel_path}`);

    console.log('→ GET /app/api/avatars/marguerite (uploaded PNG)');
    const ar = await fetch(`${ORCH_URL}/app/api/avatars/marguerite`);
    const ar_ct = ar.headers.get('content-type') || '';
    if (!ar.ok || ar_ct !== 'image/png') {
      throw new Error(`expected uploaded PNG, got HTTP ${ar.status} ct=${ar_ct}`);
    }
    console.log(`  ✓ serves uploaded PNG (${ar_ct})`);

    console.log('→ DELETE /app/api/avatars/marguerite');
    const ad = await fetch(`${ORCH_URL}/app/api/avatars/marguerite`, { method: 'DELETE' });
    const ad_json = (await ad.json()) as { ok?: boolean; files_removed?: number; error?: string };
    if (!ad.ok || !ad_json.ok || (ad_json.files_removed ?? 0) < 1) {
      throw new Error(`avatar DELETE failed: ${ad_json.error ?? ad.status} removed=${ad_json.files_removed}`);
    }
    const ar2 = await fetch(`${ORCH_URL}/app/api/avatars/marguerite`);
    const ar2_ct = ar2.headers.get('content-type') || '';
    if (!ar2.ok || ar2_ct !== 'image/svg+xml') {
      throw new Error(`after delete expected fallback SVG, got ${ar2.status} ct=${ar2_ct}`);
    }
    console.log(`  ✓ revert → fallback SVG`);

    // Reject the wrong mime so we don't accept arbitrary files.
    console.log('→ POST /app/api/avatars/marguerite (text file rejected)');
    const bad_form = new FormData();
    bad_form.append('file', new File(['hi'], 'note.txt', { type: 'text/plain' }));
    const bad = await fetch(`${ORCH_URL}/app/api/avatars/marguerite`, { method: 'POST', body: bad_form });
    if (bad.status !== 415) throw new Error(`expected 415 unsupported, got ${bad.status}`);
    console.log(`  ✓ rejects non-image (HTTP 415)`);
  } finally {
    if (av_snapshot) {
      writeFileSync(av_target_path, av_snapshot);
      console.log(`  ↺ restored Marguerite's avatar (${av_snapshot.length} bytes)`);
    }
  }

  // 4c) Banner POST/GET/DELETE on Marguerite. Mirror the avatar
  // snapshot-and-restore so a real banner survives the smoke.
  const bn_dir = resolve(VAULT_ROOT, 'Knowledge', 'Marguerite');
  const bn_paths = ['banner.png', 'banner.jpg', 'banner.webp'].map((n) => resolve(bn_dir, n));
  const bn_snapshots = bn_paths.map((p) => (existsSync(p) ? { path: p, bytes: readFileSync(p) } : null));
  try {
    console.log('→ POST /app/api/banners/marguerite (tiny PNG)');
    const png_b64 =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
    const bn_bytes = Uint8Array.from(atob(png_b64), (c) => c.charCodeAt(0));
    const bn_form = new FormData();
    bn_form.append('file', new File([bn_bytes], 'banner.png', { type: 'image/png' }));
    const bp = await fetch(`${ORCH_URL}/app/api/banners/marguerite`, { method: 'POST', body: bn_form });
    const bp_json = (await bp.json()) as { ok?: boolean; error?: string };
    if (!bp.ok || !bp_json.ok) throw new Error(`banner POST failed: ${bp_json.error ?? bp.status}`);
    console.log(`  ✓ uploaded`);
    const br = await fetch(`${ORCH_URL}/app/api/banners/marguerite`);
    if (!br.ok || br.headers.get('content-type') !== 'image/png') {
      throw new Error(`expected PNG banner back, got ${br.status} ${br.headers.get('content-type')}`);
    }
    console.log(`  ✓ serves uploaded PNG`);
    const bd = await fetch(`${ORCH_URL}/app/api/banners/marguerite`, { method: 'DELETE' });
    const bd_json = (await bd.json()) as { ok?: boolean; files_removed?: number };
    if (!bd.ok || !bd_json.ok || (bd_json.files_removed ?? 0) < 1) {
      throw new Error(`banner DELETE failed: removed=${bd_json.files_removed}`);
    }
    const br2 = await fetch(`${ORCH_URL}/app/api/banners/marguerite`);
    if (!br2.ok || br2.headers.get('content-type') !== 'image/svg+xml') {
      throw new Error(`expected SVG fallback after delete, got ${br2.headers.get('content-type')}`);
    }
    console.log(`  ✓ revert → themed SVG fallback`);
  } finally {
    for (const snap of bn_snapshots) {
      if (snap) {
        writeFileSync(snap.path, snap.bytes);
        console.log(`  ↺ restored Marguerite's ${snap.path.split('/').pop()} (${snap.bytes.length} bytes)`);
      }
    }
  }

  // 4d) Profile endpoint.
  console.log('→ GET /app/api/profile/kate');
  const pf = await fetch(`${ORCH_URL}/app/api/profile/kate`);
  if (!pf.ok) throw new Error(`profile HTTP ${pf.status}`);
  const pf_json = (await pf.json()) as {
    id?: string; name?: string; persona?: string; joined_at?: string;
    capabilities?: string[]; banner_url?: string; avatar_url?: string;
    recent_proposals?: unknown[]; recent_activity?: unknown[]; totals?: { total_proposals?: number };
  };
  if (pf_json.id !== 'kate') throw new Error(`profile id mismatch: ${pf_json.id}`);
  if (!pf_json.persona || pf_json.persona.length < 50) {
    throw new Error(`profile missing persona text (len=${(pf_json.persona || '').length})`);
  }
  if (!pf_json.banner_url || !pf_json.avatar_url) {
    throw new Error(`profile missing avatar_url or banner_url`);
  }
  if (!Array.isArray(pf_json.capabilities) || pf_json.capabilities.length === 0) {
    throw new Error('profile missing capabilities');
  }
  console.log(
    `  ✓ profile: persona=${pf_json.persona.length}c caps=${pf_json.capabilities.length} ` +
    `joined=${pf_json.joined_at} proposals=${pf_json.totals?.total_proposals}`,
  );

  console.log('→ GET /app/api/profile/nonexistent_id (404)');
  const pf404 = await fetch(`${ORCH_URL}/app/api/profile/nonexistent_id`);
  if (pf404.status !== 404) throw new Error(`expected 404 for unknown profile, got ${pf404.status}`);
  console.log(`  ✓ unknown id → 404`);

  // 5) Library upload to Vivian.
  console.log('→ POST /app/api/library/upload (vivian)');
  const test_body = `# Library smoke test ${new Date().toISOString()}\n\nThis file lands in Vivian's library.\n`;
  const form = new FormData();
  form.append('file', new File([test_body], 'library-smoke.md', { type: 'text/markdown' }));
  form.append('specialist_id', 'vivian');
  form.append('acknowledge', 'false');
  const up = await fetch(`${ORCH_URL}/app/api/library/upload`, { method: 'POST', body: form });
  const up_json = (await up.json()) as {
    id?: string;
    wrapper_note_path?: string;
    specialist_id?: string;
    error?: string;
  };
  if (!up.ok || !up_json.wrapper_note_path) {
    throw new Error(`upload failed: ${up_json.error ?? up.status}`);
  }
  if (up_json.specialist_id !== 'vivian') {
    throw new Error(`specialist_id mismatch: ${up_json.specialist_id}`);
  }
  if (!up_json.wrapper_note_path.startsWith('Knowledge/Vivian/library/')) {
    throw new Error(`wrapper note not in Vivian's namespace: ${up_json.wrapper_note_path}`);
  }
  const abs = resolve(VAULT_ROOT, up_json.wrapper_note_path);
  if (!existsSync(abs)) throw new Error(`wrapper note missing on disk: ${abs}`);
  const content = readFileSync(abs, 'utf8');
  if (!content.includes('specialist_scope: vivian')) {
    throw new Error(`wrapper note missing specialist_scope: vivian frontmatter`);
  }
  console.log(`  ✓ library item ${up_json.id} at ${up_json.wrapper_note_path}`);

  // 6) Search shape.
  console.log('→ GET /app/api/search?q=library&scope=all');
  const sr = await fetch_json<{ chat: unknown[]; vault: unknown[]; proposals: unknown[] }>(
    '/app/api/search?q=library&scope=all',
  );
  if (sr.status !== 200) throw new Error(`search HTTP ${sr.status}`);
  if (!Array.isArray(sr.body.chat) || !Array.isArray(sr.body.vault) || !Array.isArray(sr.body.proposals)) {
    throw new Error(`search returned wrong shape: ${JSON.stringify(sr.body).slice(0, 200)}`);
  }
  console.log(`  ✓ search shape OK (chat=${sr.body.chat.length}, vault=${sr.body.vault.length}, proposals=${sr.body.proposals.length})`);

  // 7) Search finds the just-uploaded library item via chunks_fts.
  console.log('→ Search hits library content via chunks_fts');
  const sr2 = await fetch_json<{ vault: Array<{ note_path: string; snippet: string }> }>(
    '/app/api/search?q=smoke&scope=vault',
  );
  const lib_hit = sr2.body.vault?.some((v) => v.note_path === up_json.wrapper_note_path);
  if (!lib_hit) {
    console.warn(`  ⚠ chunks_fts did not return the new library item — index may not have committed yet`);
  } else {
    console.log(`  ✓ chunks_fts returned the library upload`);
  }

  // 8) SSE: open and wait for at least one heartbeat or a known event.
  console.log('→ SSE /app/api/events — wait for heartbeat (up to 30s)');
  const ctrl = new AbortController();
  const sse_promise = (async () => {
    const r = await fetch(`${ORCH_URL}/app/api/events`, { signal: ctrl.signal });
    if (!r.ok || !r.body) throw new Error(`SSE HTTP ${r.status}`);
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let received = '';
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      received += dec.decode(value, { stream: true });
      if (received.includes(':') || received.includes('data:')) break;
    }
    return received;
  })();
  // Race against a 30s wall clock.
  const got = await Promise.race([
    sse_promise,
    new Promise<string>((resolve) => setTimeout(() => resolve(''), 30_000)),
  ]);
  ctrl.abort();
  if (!got || got.length === 0) {
    throw new Error('SSE produced no output in 30s');
  }
  console.log(`  ✓ SSE produced ${got.length} bytes`);

  // 9) Hiring flow.
  const test_id = `smoke_${Date.now().toString(36)}`;
  console.log(`→ POST /app/api/specialists — hire ${test_id}`);
  const hire = await fetch_json<{ id: string; persona_preview?: string; error?: string }>(
    '/app/api/specialists',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: test_id,
        name: `Smoke ${test_id}`,
        role: 'Smoke Tester',
        voice: 'warm',
        description:
          'A test specialist created by the smoke runner. Reads the vault, runs nothing.',
        knowledge_scope: [`Knowledge/Smoke/${test_id}/**`],
        capabilities: { read_vault: true, query_web: true, write_proposals: true },
        proactive: { mode: 'reactive' },
        persona: `You are Smoke ${test_id} — a placeholder specialist created for testing.`,
      }),
    },
  );
  if (hire.status !== 200) throw new Error(`hire HTTP ${hire.status}: ${hire.body.error}`);
  if (hire.body.id !== test_id) throw new Error(`hire returned wrong id: ${hire.body.id}`);
  // Confirm it shows up in /api/specialists.
  const list = await fetch_json<{ specialists: Array<{ id: string }> }>('/api/specialists');
  const found = list.body.specialists.some((s) => s.id === test_id);
  if (!found) throw new Error(`hired specialist not visible in /api/specialists`);
  const yaml_path = resolve(SPECIALISTS_DIR, `${test_id}.yaml`);
  if (!existsSync(yaml_path)) throw new Error(`yaml not written: ${yaml_path}`);
  console.log(`  ✓ hired ${test_id}, yaml at ${yaml_path}`);

  // Cleanup via DELETE — synchronously triggers a registry reload so
  // back-to-back smokes don't see the stale specialist.
  await fetch(`${ORCH_URL}/app/api/specialists/${test_id}`, { method: 'DELETE' });
  const test_namespace = resolve(VAULT_ROOT, 'Knowledge', `Smoke ${test_id}`);
  if (existsSync(test_namespace)) {
    try { rmSync(test_namespace, { recursive: true, force: true }); } catch {}
  }
  if (existsSync(yaml_path)) {
    try { rmSync(yaml_path); } catch {}
  }
  console.log(`  ✓ cleanup done`);

  // Confirm the wrapper note from earlier upload still has content stat.
  const stat = statSync(abs);
  if (stat.size === 0) throw new Error('wrapper note ended up empty');

  console.log('\n✓ APP SMOKE PASSED');
}

function _cleanup_smoke_session() {
  try {
    _db.prepare(`DELETE FROM sessions WHERE id = @id`).run({ '@id': SMOKE_SID });
  } catch { /* best-effort */ }
}

main()
  .then(() => _cleanup_smoke_session())
  .catch((err: unknown) => {
    _cleanup_smoke_session();
    console.error(`\n✗ APP SMOKE FAILED:`, err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
