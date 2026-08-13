/**
 * smoke:system-health — the dependency health monitor + guarded self-healing.
 *
 * Self-contained: temp db + vault, injected probe/assess/fetch transports, no
 * network and no Docker. Covers: the assessor (audit-log error-rate detection +
 * probe-down + fail-safe on a throwing probe); the incident store edges (open →
 * update → worsen → close, "down for N", restart circuit-breaker counter); the
 * scan's escalation on a NEW edge (files ONE miss with the right evidence_ref +
 * flags Beatrice + idempotent on re-run + closes on recovery); the DETERMINISTIC
 * auto-restart reflex (down + restartable + budget → restart, breaker/cooldown/
 * relay-gated + kill-switched — the 2026-06-24 firecrawl-worker "dead for 2 days
 * because the diagnosis steered away from a restart" case); the ops-relay CLIENT
 * (restart ok / allowlist-reject / relay-down fail-safe / unwired); and the
 * relay.ts PURE logic (auth required, allowlist gate, unknown → 403).
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ulid } from 'ulid';
import { open_db } from '../src/memory/stores/structured';
import { MemoryClient } from '../src/memory/client';
import { SpecialistInbox } from '../src/memory/stores/conversations';
import { ProcessMissStore } from '../src/core/process_misses';
import { AppEventBus, type AppEvent } from '../src/app/events';
import {
  assess_system_health,
  build_stt_probe_wav,
  stt_transcribe_probe,
  DEPENDENCIES,
  type DependencyDef,
  type ProbeFn,
  type SystemHealthSnapshot,
} from '../src/core/system_health';
import { HealthIncidentStore, down_duration_human } from '../src/memory/stores/system_health';
import { make_scan_system_health } from '../src/specialists/kate/tools/scan_system_health';
import { restart_service } from '../src/connectors/ops_relay';
import {
  makeHandler,
  makeRestarter,
  parseServiceRef,
  validServiceRef,
  type RelayConfig,
} from '../ops/ops-relay/relay';
import type { ToolContext } from '../src/core/tool';

let failures = 0;
function check(label: string, ok: boolean): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) failures++;
}

const dir = mkdtempSync(join(tmpdir(), 'hearth-health-'));
const db = open_db(join(dir, 'smoke.db'));
const memory = new MemoryClient({ vault_root: join(dir, 'vault'), db });

// The legacy escalation/restart sections (4, 5) assert escalate-on-first-down-
// edge semantics. With the 2026-06-28 ALERT hysteresis the default is now 2
// consecutive scans, so pin the threshold to 1 here; section 4b exercises the
// debounce explicitly at the default (2) and restores this.
process.env.HEARTH_HEALTH_ALERT_AFTER_SCANS = '1';

/* ------------------------------------------------------------------ */
/* 0. Relay PURE logic (makeHandler — no server, no socket)            */
/* ------------------------------------------------------------------ */
{
  let restarted: string[] = [];
  const cfg: RelayConfig = {
    token: 'secret',
    allowedServices: new Set(['firecrawl-worker']),
    dockerSocket: '/dev/null',
    restart: async (svc) => {
      restarted.push(svc);
      return { ok: true, status: 204 };
    },
  };
  const h = makeHandler(cfg);
  const post = (body: unknown, auth?: string) =>
    h(new Request('http://r/restart', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(auth ? { authorization: auth } : {}) },
      body: JSON.stringify(body),
    }));

  check('relay GET /health → 200 no auth', (await h(new Request('http://r/health'))).status === 200);
  check('relay /restart no auth → 401', (await post({ service: 'firecrawl-worker' })).status === 401);
  check('relay /restart wrong token → 401', (await post({ service: 'firecrawl-worker' }, 'Bearer nope')).status === 401);
  check('relay /restart unknown service → 403 (allowlist)', (await post({ service: 'evil' }, 'Bearer secret')).status === 403 && restarted.length === 0);
  const okRes = await post({ service: 'firecrawl-worker' }, 'Bearer secret');
  check('relay /restart allowlisted → 200 + restart called', okRes.status === 200 && restarted.length === 1 && restarted[0] === 'firecrawl-worker');

  const noTokenCfg: RelayConfig = { token: undefined, allowedServices: new Set(['x']), dockerSocket: '/dev/null', restart: async () => ({ ok: true, status: 204 }) };
  const r503 = await makeHandler(noTokenCfg)(new Request('http://r/restart', { method: 'POST', headers: { authorization: 'Bearer x' }, body: '{"service":"x"}' }));
  check('relay with no token → 503 (fail-closed)', r503.status === 503);
}

/* ------------------------------------------------------------------ */
/* 0b. Relay REMOTE (SSH) restart path — forza:vllm-vision            */
/* ------------------------------------------------------------------ */
{
  // Service-ref parsing: local vs host:container, with validation on both halves.
  const local = parseServiceRef('firecrawl-worker');
  check('parseServiceRef local', local?.kind === 'local' && local.container === 'firecrawl-worker');
  const remote = parseServiceRef('forza:vllm-vision');
  check('parseServiceRef remote', remote?.kind === 'remote' && remote.host === 'forza' && remote.container === 'vllm-vision');
  check('parseServiceRef rejects bad host', parseServiceRef('-bad:vllm-vision') === null);
  check('parseServiceRef rejects bad container', parseServiceRef('forza:bad name') === null);
  check('validServiceRef accepts remote', validServiceRef('forza:vllm-vision') === true);

  // The gate accepts an allowlisted REMOTE ref and hands it to restart unchanged.
  let got: string[] = [];
  const cfg: RelayConfig = {
    token: 'secret',
    allowedServices: new Set(['forza:vllm-vision']),
    dockerSocket: '/dev/null',
    remoteHosts: new Map([['forza', 'jasper@192.168.0.188']]),
    sshKey: '/keys/forza_restart',
    restart: async (svc) => { got.push(svc); return { ok: true, status: 204 }; },
  };
  const h = makeHandler(cfg);
  const post = (svc: string) => h(new Request('http://r/restart', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer secret' },
    body: JSON.stringify({ service: svc }),
  }));
  check('relay /restart allowlisted REMOTE ref → 200 + passed through', (await post('forza:vllm-vision')).status === 200 && got[0] === 'forza:vllm-vision');
  check('relay /restart non-allowlisted remote → 403', (await post('forza:something-else')).status === 403);

  // The REAL dispatcher (no injected restart): an unknown remote host fails
  // cleanly (never throws, never reaches a socket); a known host with no key 503s.
  const r1 = await makeRestarter({ token: 't', allowedServices: new Set(), dockerSocket: '/dev/null' })('forza:vllm-vision');
  check('makeRestarter unknown remote host → 400 fail-safe', r1.ok === false && r1.status === 400);
  const r2 = await makeRestarter({ token: 't', allowedServices: new Set(), dockerSocket: '/dev/null', remoteHosts: new Map([['forza', 'jasper@host']]) })('forza:vllm-vision');
  check('makeRestarter remote host but no ssh key → 503 fail-safe', r2.ok === false && r2.status === 503);
}

/* ------------------------------------------------------------------ */
/* 1. ops-relay CLIENT (mock fetch)                                    */
/* ------------------------------------------------------------------ */
{
  const okFetch = (async () => new Response(JSON.stringify({ ok: true }), { status: 200 })) as unknown as typeof fetch;
  const r1 = await restart_service('firecrawl-worker', { url: 'http://relay', token: 't', fetchImpl: okFetch });
  check('client: 200 → restarted', r1.ok && r1.reason === 'restarted');

  const forbid = (async () => new Response('no', { status: 403 })) as unknown as typeof fetch;
  const r2 = await restart_service('evil', { url: 'http://relay', token: 't', fetchImpl: forbid });
  check('client: 403 → not_allowed', !r2.ok && r2.reason === 'not_allowed');

  const boom = (async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch;
  const r3 = await restart_service('x', { url: 'http://relay', token: 't', fetchImpl: boom });
  check('client: relay down → relay_unavailable (fail-safe)', !r3.ok && r3.reason === 'relay_unavailable');

  const r4 = await restart_service('x', { url: '' });
  check('client: no relay URL → relay_unavailable', !r4.ok && r4.reason === 'relay_unavailable');
}

/* ------------------------------------------------------------------ */
/* 2. The ASSESSOR — audit error-rate + probe + fail-safe              */
/* ------------------------------------------------------------------ */

const TEST_DEPS: DependencyDef[] = [
  { name: 'firecrawl', label: 'Firecrawl', probe: { url_env: '_FC', default_url: 'http://fc/health', health_path: '' }, backs_tools: ['web_fetch_clean'], restartable: true, restart_service: 'firecrawl-worker', impact: 'web fetch' },
  { name: 'searxng', label: 'SearXNG', probe: { url_env: '_SX', default_url: 'http://sx/', health_path: '' }, backs_tools: ['web_search'], restartable: true, restart_service: 'searxng', impact: 'search' },
  { name: 'embeddings', label: 'infinity', probe: { url_env: '_EM', default_url: 'http://em/health', health_path: '' }, backs_tools: [], restartable: false, impact: 'rag' },
];

function seed_audit(tool: string, n: number, with_error: boolean): void {
  const stmt = db.prepare(
    `INSERT INTO audit_log (id, ts, intent_id, agent, tool_name, tool_input, execution_result)
     VALUES (@id, @ts, @intent, 'kate', @tool, '{}', @res)`,
  );
  for (let i = 0; i < n; i++) {
    stmt.run({
      '@id': ulid(),
      '@ts': new Date().toISOString(),
      '@intent': ulid(),
      '@tool': tool,
      '@res': with_error ? '{"error":"Request timed out"}' : '{"results":[1,2,3]}',
    });
  }
}
// Firecrawl: every web_fetch_clean failing (the silent-outage shape).
seed_audit('web_fetch_clean', 10, true);
// SearXNG: web_search all healthy.
seed_audit('web_search', 10, false);

// Probe: firecrawl + searxng reachable (firecrawl health was reachable even when
// broken — that's why error-rate is the signal); embeddings unreachable.
const probe_fn: ProbeFn = async (url) => {
  if (url.includes('em')) return { reachable: false, detail: 'ECONNREFUSED' };
  return { reachable: true, detail: 'HTTP 200' };
};
const snap = await assess_system_health(db, { deps: TEST_DEPS, probe_fn });
const byName = new Map(snap.dependencies.map((d) => [d.name, d]));
check('assessor: firecrawl DOWN via audit error-rate (probe reachable)', byName.get('firecrawl')!.status === 'down' && byName.get('firecrawl')!.error_rate === 1);
check('assessor: firecrawl recently_failing (recent window all erroring)', byName.get('firecrawl')!.recently_failing === true);
check('assessor: searxng OK (low error rate)', byName.get('searxng')!.status === 'ok');
check('assessor: embeddings DOWN via probe (no tool audit)', byName.get('embeddings')!.status === 'down' && byName.get('embeddings')!.probe_reachable === false);
check('assessor: unhealthy list = firecrawl + embeddings', snap.unhealthy.sort().join(',') === 'embeddings,firecrawl');

// Fail-safe: a throwing probe degrades that dep to down, never crashes.
const throwing: ProbeFn = async () => { throw new Error('boom'); };
const safeSnap = await assess_system_health(db, { deps: [TEST_DEPS[2]!], probe_fn: throwing });
check('assessor: throwing probe → dep down, assessment survives', safeSnap.dependencies[0]!.status === 'down');

// ── functional health_probe: drives status directly, TRAFFIC-INDEPENDENT (no
//    backs_tools, no audit rows) — the firecrawl "low-volume outage" fix.
const FUNC_DOWN: DependencyDef[] = [
  { name: 'firecrawl', label: 'Firecrawl', health_probe: async () => ({ reachable: false, detail: 'scrape timed out' }), backs_tools: [], restartable: true, restart_service: 'firecrawl-worker', impact: 'web' },
];
const fdown = await assess_system_health(db, { deps: FUNC_DOWN });
check('assessor: functional health_probe DOWN → status down (zero traffic needed)', fdown.dependencies[0]!.status === 'down' && fdown.dependencies[0]!.probe_reachable === false);
const fup = await assess_system_health(db, { deps: [{ ...FUNC_DOWN[0]!, health_probe: async () => ({ reachable: true, detail: 'scrape ok' }) }] });
check('assessor: functional health_probe OK → status ok (immediate, no 24h lag)', fup.dependencies[0]!.status === 'ok' && fup.dependencies[0]!.probe_reachable === true);
const fseam = await assess_system_health(db, { deps: FUNC_DOWN, probe_fn: async (u: string) => ({ reachable: u.startsWith('functional:firecrawl'), detail: u }) });
check('assessor: opts.probe_fn seam overrides health_probe (functional:<name> url)', fseam.dependencies[0]!.probe_reachable === true);

// ── STT functional probe (the 2026-07-18 parakeet GPU-revocation class): the
//    container lost GPU access mid-life and /v1/models kept returning 200 while
//    every /v1/audio/transcriptions 500'd with a CUDA error — ~21h of dead voice
//    with all checks green. The probe POSTs a real synthesized wav to the
//    transcription endpoint, so a GPU-dead-but-listening server reads DOWN.
{
  const stt_dep = DEPENDENCIES.find((d) => d.name === 'stt');
  check('stt: registry dep exists — functional probe, probe-only', !!stt_dep && typeof stt_dep.health_probe === 'function' && stt_dep.backs_tools.length === 0);
  check('stt: restart targets the parakeet container by name', stt_dep?.restartable === true && stt_dep?.restart_service === 'parakeet');
  check('stt: voice-critical — alerts on the first down-scan', stt_dep?.alert_after_scans === 1);

  const wav = build_stt_probe_wav();
  const riff = String.fromCharCode(...wav.slice(0, 4)) === 'RIFF' && String.fromCharCode(...wav.slice(8, 12)) === 'WAVE';
  check('stt: probe wav is a real RIFF/WAVE with non-silent 16 kHz PCM', riff && wav.length === 44 + 16_000 && wav.slice(44).some((b) => b !== 0));

  let mode: 'ok' | 'cuda_dead' = 'ok';
  let saw: { file: boolean; model: string | null } = { file: false, model: null };
  let hits = 0;
  const srv = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const url = new URL(req.url);
      // The reachability endpoint that lied through the real outage.
      if (url.pathname === '/v1/models') return Response.json({ data: [] });
      if (url.pathname !== '/v1/audio/transcriptions') return new Response('nope', { status: 404 });
      hits++;
      const form = await req.formData();
      const f = form.get('file');
      saw = { file: f instanceof File && f.size === wav.length, model: form.get('model') as string | null };
      if (mode === 'cuda_dead') {
        return Response.json({ detail: 'CUDA failed with error no CUDA-capable device is detected' }, { status: 500 });
      }
      return Response.json({ text: '' });
    },
  });
  process.env.SPEACHES_URL = `http://127.0.0.1:${srv.port}`;

  const expected_model = process.env.STT_MODEL ?? 'deepdml/faster-whisper-large-v3-turbo-ct2';
  const up = await stt_transcribe_probe();
  check('stt probe: healthy server → reachable (real multipart: file + model)', up.reachable && saw.file && saw.model === expected_model);

  mode = 'cuda_dead';
  hits = 0;
  const dead = await stt_transcribe_probe();
  check('stt probe: /v1/models green but transcription CUDA-dead → DOWN with the CUDA error in detail', !dead.reachable && dead.detail.includes('HTTP 500') && dead.detail.includes('CUDA'));
  check('stt probe: one retry before declaring down', hits === 2);

  srv.stop(true);
  const gone = await stt_transcribe_probe();
  check('stt probe: unreachable server → down (fail-safe)', gone.reachable === false);
  delete process.env.SPEACHES_URL;
}

// ── recovery hysteresis (assessor): OLD failures fill the 24h window but the
//    RECENT window is clean → still down/degraded over 24h, yet recovered_recent.
{
  const seed_at = (tool: string, n: number, err: boolean, ago_min: number) => {
    const stmt = db.prepare(
      `INSERT INTO audit_log (id, ts, intent_id, agent, tool_name, tool_input, execution_result)
       VALUES (@id, @ts, @intent, 'kate', @tool, '{}', @res)`,
    );
    const ts = new Date(Date.now() - ago_min * 60_000).toISOString();
    for (let i = 0; i < n; i++) {
      stmt.run({ '@id': ulid(), '@ts': ts, '@intent': ulid(), '@tool': tool, '@res': err ? '{"error":"timeout"}' : '{"ok":1}' });
    }
  };
  seed_at('wfc_recov', 30, true, 120); // 30 failures 2h ago (in 24h, outside recent)
  seed_at('wfc_recov', 6, false, 5); //  6 clean calls 5min ago (recent window)
  const RECOV: DependencyDef[] = [
    { name: 'firecrawl', label: 'Firecrawl', probe: { url_env: '_FC', default_url: 'http://fc/health', health_path: '' }, backs_tools: ['wfc_recov'], restartable: true, restart_service: 'firecrawl-worker', impact: 'web fetch' },
  ];
  const rs = (await assess_system_health(db, { deps: RECOV, probe_fn })).dependencies[0]!;
  check('assessor: 24h window still elevated while recovering', rs.status !== 'ok');
  check('assessor: recovered_recent true when recent window is clean', rs.recovered_recent === true);
  check('assessor: recovering dep is NOT recently_failing', rs.recently_failing !== true);
  seed_at('wfc_norecent', 30, true, 120); // only OLD failures, nothing recent
  const RECOV2: DependencyDef[] = [{ ...RECOV[0]!, backs_tools: ['wfc_norecent'] }];
  const rs2 = (await assess_system_health(db, { deps: RECOV2, probe_fn })).dependencies[0]!;
  check('assessor: no recent calls → recovered_recent false (conservative)', rs2.recovered_recent !== true);
}

/* ------------------------------------------------------------------ */
/* 3. The INCIDENT store edges                                         */
/* ------------------------------------------------------------------ */
{
  const inc = new HealthIncidentStore(db);
  const t0 = new Date('2026-06-12T00:00:00Z');
  const open1 = inc.open_or_update('firecrawl', 'degraded', 'r', {}, t0);
  check('incident: first open is a NEW edge', open1.is_new_edge === true);
  const open2 = inc.open_or_update('firecrawl', 'degraded', 'r', {}, new Date('2026-06-12T01:00:00Z'));
  check('incident: same status update is NOT a new edge', open2.is_new_edge === false);
  const worsen = inc.open_or_update('firecrawl', 'down', 'r', {}, new Date('2026-06-12T02:00:00Z'));
  check('incident: degraded→down worsening IS a new edge', worsen.is_new_edge === true);
  check('incident: one open row for the dependency', inc.list_open().filter((i) => i.dependency === 'firecrawl').length === 1);
  // "down for 8 days" from first_seen.
  check('incident: down_for ≈ 8d', down_duration_human(t0.toISOString(), new Date('2026-06-20T00:00:00Z')) === '8d');
  inc.record_restart('firecrawl');
  inc.record_restart('firecrawl');
  check('incident: restart_attempts counts (circuit-breaker input)', inc.get_open('firecrawl')!.restart_attempts === 2);
  const closed = inc.close('firecrawl', new Date('2026-06-20T00:00:00Z'));
  check('incident: close stamps recovery + down_ms', !!closed && closed.down_ms > 0 && inc.get_open('firecrawl') === null);
}

/* ------------------------------------------------------------------ */
/* 4. The SCAN escalation (real inbox/events/misses; injected assess)  */
/* ------------------------------------------------------------------ */
{
  const inbox = new SpecialistInbox(db);
  const events = new AppEventBus();
  const misses = new ProcessMissStore(db);
  const captured: AppEvent[] = [];
  events.subscribe((e) => captured.push(e));

  const down_snap: SystemHealthSnapshot = {
    generated_at: new Date().toISOString(),
    dependencies: [
      { name: 'firecrawl', label: 'Firecrawl', status: 'down', probe_reachable: true, error_rate: 1, calls: 10, errors: 10, restartable: true, restart_service: 'firecrawl-worker', impact: 'web fetch', reason: '100% of 10 calls failing' },
    ],
    unhealthy: ['firecrawl'],
  };
  const ok_snap: SystemHealthSnapshot = {
    generated_at: new Date().toISOString(),
    dependencies: [
      { name: 'firecrawl', label: 'Firecrawl', status: 'ok', probe_reachable: true, error_rate: 0, calls: 10, errors: 0, restartable: true, restart_service: 'firecrawl-worker', impact: 'web fetch', reason: 'healthy' },
    ],
    unhealthy: [],
  };

  const ctx: ToolContext = { memory, llm: undefined as never, now: new Date(), intent_id: ulid(), specialist_id: 'kate' };

  const scan_down = make_scan_system_health({ db, memory, inbox, events, process_misses: misses, assess_fn: (async () => down_snap) as never });
  const r1 = await scan_down.execute({}, ctx);
  check('scan: new down edge → escalated once', r1.new_incidents.includes('firecrawl') && r1.escalated === 1);
  const miss_rows = db.prepare(`SELECT * FROM process_misses WHERE evidence_ref = 'dependency:firecrawl:health'`).all() as Array<{ subject_specialist_id: string }>;
  check('scan: filed ONE miss for trainer with the dependency evidence_ref', miss_rows.length === 1 && miss_rows[0]!.subject_specialist_id === 'trainer');
  const flags = inbox.unread_for('trainer');
  check('scan: flagged Beatrice (trainer inbox)', flags.some((f) => f.body_md.includes('Firecrawl') && f.from_specialist_id === 'kate'));
  check('scan: emitted inbox_message_added to trainer', captured.some((e) => e.type === 'inbox_message_added' && e.to_specialist_id === 'trainer'));

  // Idempotent: re-run with the same down snapshot → no NEW edge, no new miss/flag.
  const before_flags = inbox.unread_for('trainer').length;
  const r2 = await scan_down.execute({}, { ...ctx, intent_id: ulid() });
  check('scan: re-run is idempotent (no new edge, no new escalation)', r2.new_incidents.length === 0 && r2.escalated === 0);
  check('scan: still ONE miss + no new flag', (db.prepare(`SELECT COUNT(*) n FROM process_misses WHERE evidence_ref='dependency:firecrawl:health'`).get() as { n: number }).n === 1 && inbox.unread_for('trainer').length === before_flags);

  // Recovery: firecrawl ok now → scan closes the incident.
  const scan_up = make_scan_system_health({ db, memory, inbox, events, process_misses: misses, assess_fn: (async () => ok_snap) as never });
  const r3 = await scan_up.execute({}, { ...ctx, intent_id: ulid() });
  check('scan: recovery edge closes the incident', r3.recovered.includes('firecrawl') && new HealthIncidentStore(db).get_open('firecrawl') === null);

  // ── re-open suppression: a freshly-recovered dep reading status=down ONLY by
  //    the stale long window (NOT currently failing) is not re-opened/re-alerted
  //    (firecrawl after a worker restart: 24h rate stays elevated for hours).
  const fc_stale: SystemHealthSnapshot = {
    generated_at: new Date().toISOString(),
    dependencies: [{ name: 'firecrawl', label: 'Firecrawl', status: 'down', recently_failing: false, probe_reachable: true, error_rate: 0.9, calls: 30, errors: 27, restartable: true, restart_service: 'firecrawl-worker', impact: 'web', reason: '90% (stale 24h window)' }],
    unhealthy: ['firecrawl'],
  };
  const r_stale = await make_scan_system_health({ db, memory, inbox, events, process_misses: misses, assess_fn: (async () => fc_stale) as never }).execute({}, { ...ctx, intent_id: ulid() });
  check('suppress: stale-down right after recovery is NOT re-opened', r_stale.new_incidents.length === 0 && r_stale.escalated === 0 && new HealthIncidentStore(db).get_open('firecrawl') === null);
  // but a GENUINE new outage (recently_failing) DOES re-open.
  const fc_real: SystemHealthSnapshot = { ...fc_stale, dependencies: [{ ...fc_stale.dependencies[0]!, recently_failing: true }] };
  const r_real = await make_scan_system_health({ db, memory, inbox, events, process_misses: misses, assess_fn: (async () => fc_real) as never }).execute({}, { ...ctx, intent_id: ulid() });
  check('suppress: a genuine new outage (recently_failing) DOES re-open', r_real.new_incidents.includes('firecrawl') && new HealthIncidentStore(db).get_open('firecrawl') !== null);
  new HealthIncidentStore(db).close('firecrawl'); // back to a clean recovered state for section 5

  // ── recovery hysteresis (scan): close on recovered_recent even while status
  //    is still down (stale 24h window), and the NEXT crash opens a FRESH
  //    incident with restart_attempts=0 — the circuit-breaker reset.
  const inc = new HealthIncidentStore(db);
  inc.open_or_update('searxng', 'down', 'stale failures', {}, new Date());
  inc.record_restart('searxng'); // breaker "used" on this incident
  check('scan-recov: searxng incident open with a restart logged', (inc.get_open('searxng')?.restart_attempts ?? 0) === 1);
  const recov_snap: SystemHealthSnapshot = {
    generated_at: new Date().toISOString(),
    dependencies: [
      { name: 'searxng', label: 'SearXNG', status: 'down', recovered_recent: true, probe_reachable: true, error_rate: 0.9, calls: 20, errors: 18, restartable: true, restart_service: 'searxng', impact: 'search', reason: '90% of 20 calls failing (stale window)' },
    ],
    unhealthy: ['searxng'],
  };
  const before_sx_misses = (db.prepare(`SELECT COUNT(*) n FROM process_misses WHERE evidence_ref='dependency:searxng:health'`).get() as { n: number }).n;
  const scan_recov = make_scan_system_health({ db, memory, inbox, events, process_misses: misses, assess_fn: (async () => recov_snap) as never });
  const rr = await scan_recov.execute({}, { ...ctx, intent_id: ulid() });
  check('scan-recov: recovered_recent closes incident despite status=down', rr.recovered.includes('searxng') && inc.get_open('searxng') === null);
  check('scan-recov: no spurious re-escalation while recovering', rr.escalated === 0 && (db.prepare(`SELECT COUNT(*) n FROM process_misses WHERE evidence_ref='dependency:searxng:health'`).get() as { n: number }).n === before_sx_misses);
  const down_again: SystemHealthSnapshot = { ...recov_snap, dependencies: [{ ...recov_snap.dependencies[0]!, recovered_recent: false, recently_failing: true }] };
  const scan_again = make_scan_system_health({ db, memory, inbox, events, process_misses: misses, assess_fn: (async () => down_again) as never });
  await scan_again.execute({}, { ...ctx, intent_id: ulid() });
  check('scan-recov: post-recovery crash opens FRESH incident, restart_attempts=0 (breaker reset)', (inc.get_open('searxng')?.restart_attempts ?? -1) === 0);

  // Kill switch.
  process.env.HEARTH_SYSTEM_HEALTH = '0';
  const r4 = await scan_down.execute({}, { ...ctx, intent_id: ulid() });
  check('scan: HEARTH_SYSTEM_HEALTH=0 → no-op', r4.enabled === false && r4.escalated === 0);
  delete process.env.HEARTH_SYSTEM_HEALTH;
}

/* ------------------------------------------------------------------ */
/* 4b. ALERT hysteresis — a self-healing blip never pages the owner    */
/*     (the 2026-06-28 firecrawl "down ~50m every night, recovers,     */
/*      pages me each time" fix). The ledger opens + the auto-restart   */
/*      fires on scan 1, but the miss/flag/owner-push wait for N scans. */
/* ------------------------------------------------------------------ */
{
  process.env.HEARTH_HEALTH_ALERT_AFTER_SCANS = '2'; // exercise the default
  const inbox = new SpecialistInbox(db);
  const events = new AppEventBus();
  const misses = new ProcessMissStore(db);
  const ctx: ToolContext = { memory, llm: undefined as never, now: new Date(), intent_id: ulid(), specialist_id: 'kate' };
  const inc = new HealthIncidentStore(db);

  // Synthetic dependency name so the debounce assertions are isolated from
  // section 4's firecrawl miss/flag state (same shared db). A name absent from
  // the DEPENDENCIES registry falls back to the env default threshold (2).
  const DEP = 'blip_dep';
  const fc_down: SystemHealthSnapshot = {
    generated_at: new Date().toISOString(),
    dependencies: [
      { name: DEP, label: 'Blip Dep (test)', status: 'down', probe_reachable: false, error_rate: null, calls: 0, errors: 0, restartable: false, impact: 'web fetch', reason: 'unreachable (timed out)', recently_failing: true },
    ],
    unhealthy: [DEP],
  };
  const fc_ok: SystemHealthSnapshot = {
    generated_at: new Date().toISOString(),
    dependencies: [{ name: DEP, label: 'Blip Dep (test)', status: 'ok', probe_reachable: true, error_rate: 0, calls: 5, errors: 0, restartable: false, impact: 'web fetch', reason: 'healthy' }],
    unhealthy: [],
  };
  const scan_down = make_scan_system_health({ db, memory, inbox, events, process_misses: misses, assess_fn: (async () => fc_down) as never });
  const scan_ok = make_scan_system_health({ db, memory, inbox, events, process_misses: misses, assess_fn: (async () => fc_ok) as never });
  const miss_n = () => (db.prepare(`SELECT COUNT(*) n FROM process_misses WHERE evidence_ref=@r AND status NOT IN ('closed','verified')`).get({ '@r': `dependency:${DEP}:health` }) as { n: number }).n;
  const trainer_flags = () => inbox.unread_for('trainer').length;

  // scan 1: incident opens, but BELOW threshold → no page.
  const before_miss = miss_n();
  const before_flags = trainer_flags();
  const d1 = await scan_down.execute({}, { ...ctx, intent_id: ulid() });
  const open1 = inc.get_open(DEP);
  check('debounce: scan 1 opens the incident but does NOT escalate', d1.escalated === 0 && d1.new_incidents.length === 0 && open1 !== null);
  check('debounce: scan 1 observations=1, alerted_at still null', (open1?.observations ?? 0) === 1 && open1?.alerted_at == null);
  check('debounce: scan 1 files NO Beatrice miss / flag', miss_n() === before_miss && trainer_flags() === before_flags);

  // scan 2: still down → crosses threshold → escalate ONCE.
  const d2 = await scan_down.execute({}, { ...ctx, intent_id: ulid() });
  const open2 = inc.get_open(DEP);
  check('debounce: scan 2 (still down) escalates once', d2.escalated === 1 && d2.new_incidents.includes(DEP));
  check('debounce: scan 2 stamps alerted_at + files the miss + flag', open2?.alerted_at != null && miss_n() === before_miss + 1 && trainer_flags() === before_flags + 1);

  // scan 3: still down, already alerted → no re-page.
  const flags_after_alert = trainer_flags();
  const d3 = await scan_down.execute({}, { ...ctx, intent_id: ulid() });
  check('debounce: scan 3 (already alerted) does NOT re-escalate', d3.escalated === 0 && d3.new_incidents.length === 0 && trainer_flags() === flags_after_alert);

  // recovery of an ALERTED incident closes it.
  const d4 = await scan_ok.execute({}, { ...ctx, intent_id: ulid() });
  check('debounce: recovery closes the alerted incident', d4.recovered.includes(DEP) && inc.get_open(DEP) === null);

  // ── the headline case: a blip that recovers BEFORE the threshold is fully
  //    silent — opens, then recovers, with alerted_at never set (so no ⚠️ AND
  //    no ✅ ever went to the owner) and NO Beatrice miss/flag filed.
  const miss_before_blip = miss_n();
  const flags_before_blip = trainer_flags();
  const b1 = await scan_down.execute({}, { ...ctx, intent_id: ulid() });
  check('blip: re-opens below threshold, silent', b1.escalated === 0 && (inc.get_open(DEP)?.alerted_at ?? null) === null);
  const b2 = await scan_ok.execute({}, { ...ctx, intent_id: ulid() });
  check('blip: recovers; never alerted (no ⚠️/✅), no miss/flag filed', b2.recovered.includes(DEP) &&
    (db.prepare(`SELECT alerted_at FROM health_incidents WHERE dependency=@d AND recovered_at IS NOT NULL ORDER BY recovered_at DESC LIMIT 1`).get({ '@d': DEP }) as { alerted_at: string | null }).alerted_at === null &&
    miss_n() === miss_before_blip && trainer_flags() === flags_before_blip);

  // ── per-dependency override: a safety-critical dep (voice_coordinator,
  //    alert_after_scans=1) escalates on the FIRST down-scan, no debounce.
  const vc_down: SystemHealthSnapshot = {
    generated_at: new Date().toISOString(),
    dependencies: [{ name: 'voice_coordinator', label: 'Satellite1 voice coordinator', status: 'down', probe_reachable: false, error_rate: null, calls: 0, errors: 0, restartable: true, restart_service: 'hearth-voice-coordinator', impact: 'Kate speaking', reason: 'unreachable', recently_failing: true }],
    unhealthy: ['voice_coordinator'],
  };
  const vc = await make_scan_system_health({ db, memory, inbox, events, process_misses: misses, assess_fn: (async () => vc_down) as never }).execute({}, { ...ctx, intent_id: ulid() });
  check('override: voice_coordinator (alert_after_scans=1) escalates on scan 1', vc.escalated === 1 && vc.new_incidents.includes('voice_coordinator'));
  inc.close('voice_coordinator');

  process.env.HEARTH_HEALTH_ALERT_AFTER_SCANS = '1'; // restore for section 5
}

/* ------------------------------------------------------------------ */
/* 5. The DETERMINISTIC auto-restart reflex                            */
/*    down + restartable + budget → restart (no waiting for Beatrice's */
/*    diagnosis, which mis-fired during the live firecrawl outage).    */
/* ------------------------------------------------------------------ */
{
  const inbox = new SpecialistInbox(db);
  const events = new AppEventBus();
  const misses = new ProcessMissStore(db);
  const inc = new HealthIncidentStore(db);
  const ctx: ToolContext = { memory, llm: undefined as never, now: new Date(), intent_id: ulid(), specialist_id: 'kate' };

  let relay_calls: string[] = [];
  const fake_relay = (async (svc: string) => {
    relay_calls.push(svc);
    return { ok: true, reason: 'restarted' as const };
  }) as typeof restart_service;
  const mkScan = (snap: SystemHealthSnapshot, opts: { configured?: boolean } = {}) =>
    make_scan_system_health({
      db, memory, inbox, events, process_misses: misses,
      assess_fn: (async () => snap) as never,
      relay_restart_fn: fake_relay,
      relay_configured_fn: () => opts.configured !== false,
    });
  // status=down + recently_failing (a CURRENT outage); the reflex reads
  // restartable + the REAL container name from the DEPENDENCIES registry (by
  // dep.name), NOT these snapshot fields.
  const downSnap = (name: string): SystemHealthSnapshot => ({
    generated_at: new Date().toISOString(),
    dependencies: [{ name, label: name, status: 'down', probe_reachable: true, recently_failing: true, error_rate: 1, calls: 10, errors: 10, restartable: true, impact: 'x', reason: 'down' }],
    unhealthy: [name],
  });

  // 5-stale. a freshly-recovered dep (firecrawl recovered in section 4) that is
  //          stale-down but NOT currently failing → suppressed → reflex never
  //          reached → no restart. The gate that stops the spurious restart of a
  //          just-fixed service.
  const staleSnap = (name: string): SystemHealthSnapshot => ({
    generated_at: new Date().toISOString(),
    dependencies: [{ name, label: name, status: 'down', probe_reachable: true, recently_failing: false, error_rate: 0.9, calls: 30, errors: 27, restartable: true, impact: 'x', reason: 'stale window' }],
    unhealthy: [name],
  });
  relay_calls = [];
  await mkScan(staleSnap('firecrawl')).execute({}, { ...ctx, intent_id: ulid() });
  check('reflex: stale-down after recovery (not currently failing) → NO restart', relay_calls.length === 0);

  // 5-probe-down. A FUNCTIONALLY-down dep (probe_reachable:false) with ZERO recent
  //   traffic (recently_failing:false) STILL auto-restarts — the self-sufficiency
  //   win: a low-/zero-volume outage heals itself because the functional probe,
  //   not traffic, is the signal. (firecrawl's real probe is now an active scrape;
  //   voice_coordinator stands in here, clean, with probe down + no traffic.)
  relay_calls = [];
  const probeDown: SystemHealthSnapshot = {
    generated_at: new Date().toISOString(),
    dependencies: [{ name: 'voice_coordinator', label: 'voice', status: 'down', probe_reachable: false, recently_failing: false, error_rate: null, calls: 0, errors: 0, restartable: true, impact: 'x', reason: 'probe down, no traffic' }],
    unhealthy: ['voice_coordinator'],
  };
  await mkScan(probeDown).execute({}, { ...ctx, intent_id: ulid() });
  check('reflex: probe-down + ZERO recent traffic → still auto-restarts (low-volume self-heal)', relay_calls.length === 1 && relay_calls[0] === 'hearth-voice-coordinator');

  // 5a. fresh down restartable dep → one auto-restart with the registry's real
  //     container name (firecrawl → firecrawl-worker), recorded on the incident.
  relay_calls = [];
  const a = await mkScan(downSnap('firecrawl')).execute({}, { ...ctx, intent_id: ulid() });
  check('reflex: down firecrawl → auto-restarted firecrawl-worker once', relay_calls.length === 1 && relay_calls[0] === 'firecrawl-worker' && a.auto_restarted.includes('firecrawl'));
  check('reflex: restart recorded on the incident (breaker input)', (inc.get_open('firecrawl')?.restart_attempts ?? 0) === 1);

  // 5b. immediate re-scan → cooldown blocks a second restart in the same window.
  relay_calls = [];
  const b = await mkScan(downSnap('firecrawl')).execute({}, { ...ctx, intent_id: ulid() });
  check('reflex: cooldown blocks an immediate second restart', relay_calls.length === 0 && b.auto_restarted.length === 0);

  // 5c. breaker: attempts at the cap (with an OLD last_restart_at so cooldown is
  //     NOT the blocker) → no restart; hands off to the escalation path.
  inc.open_or_update('searxng', 'down', 'r', {}, new Date());
  inc.record_restart('searxng'); inc.record_restart('searxng'); // 2 == default cap
  db.prepare(`UPDATE health_incidents SET last_restart_at = @old WHERE dependency='searxng' AND recovered_at IS NULL`).run({ '@old': new Date(Date.now() - 3600_000).toISOString() });
  relay_calls = [];
  await mkScan(downSnap('searxng')).execute({}, { ...ctx, intent_id: ulid() });
  check('reflex: breaker (attempts==cap) → no restart', relay_calls.length === 0);

  // 5d. relay unwired → no restart (degrades to the flag-Beatrice path).
  relay_calls = [];
  const d = await mkScan(downSnap('voice_coordinator'), { configured: false }).execute({}, { ...ctx, intent_id: ulid() });
  check('reflex: relay unwired → no restart', relay_calls.length === 0 && d.auto_restarted.length === 0);

  // 5e. NOT-restartable dep (home_assistant, restartable:false in the registry)
  //     → no restart even though it's down.
  relay_calls = [];
  await mkScan(downSnap('home_assistant')).execute({}, { ...ctx, intent_id: ulid() });
  check('reflex: non-restartable dep → no restart', relay_calls.length === 0);

  // 5f. kill switch.
  process.env.HEARTH_HEALTH_AUTO_RESTART = '0';
  relay_calls = [];
  await mkScan(downSnap('searxng')).execute({}, { ...ctx, intent_id: ulid() });
  check('reflex: HEARTH_HEALTH_AUTO_RESTART=0 → no restart', relay_calls.length === 0);
  delete process.env.HEARTH_HEALTH_AUTO_RESTART;
}

db.close();
rmSync(dir, { recursive: true, force: true });
console.log(failures === 0 ? '\nsmoke:system-health OK' : `\nsmoke:system-health FAILED (${failures} check(s))`);
process.exit(failures === 0 ? 0 : 1);
