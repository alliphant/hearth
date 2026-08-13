/**
 * smoke:health-diagnosis — the self-diagnosis + scored-fix loop on top of the
 * system-health monitor.
 *
 * Self-contained: temp db + vault, a SCRIPTED deep model (no network/Docker/LLM),
 * injected log + audit + probe transports. Covers:
 *   0. the ops-relay /logs PURE handler (auth + same allowlist as /restart,
 *      read-only) + the Docker log-stream demux + the ops_relay fetch_logs CLIENT.
 *   1. the evidence pack assembles (error samples from the audit log, container
 *      logs via the relay, resolved config, the open incident).
 *   2. the diagnosis is GROUNDED — a fabricated specific the evidence doesn't
 *      support is dropped by the (scripted) fact critic + scrubbed from the
 *      narrative.
 *   3. fixes are TYPED + SCORED + RANKED — best-first by the deterministic
 *      composite; an escalate floor is always present; EVERY fix's apply_via is
 *      an EXISTING gate (no novel apply surface).
 *   4. the diagnose_dependency TOOL persists the diagnosis, files an owner
 *      recommendation, cites the open health miss, and returns a next_action
 *      that routes application through the existing gate (restart_service) —
 *      and applies NOTHING itself.
 *   5. fail-open (model/logs/critic outage) + kill switch + unknown-dep refusal.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ulid } from 'ulid';
import { open_db } from '../src/memory/stores/structured';
import { MemoryClient } from '../src/memory/client';
import { ProposalsStore } from '../src/core/proposals';
import { ProcessMissStore } from '../src/core/process_misses';
import { HealthIncidentStore } from '../src/memory/stores/system_health';
import { HealthDiagnosisStore } from '../src/memory/stores/health_diagnoses';
import {
  gather_evidence_pack,
  run_diagnosis,
  EXISTING_GATES,
  type DiagnosisEngineDeps,
  type CompleteRoleFn,
} from '../src/core/health_diagnosis';
import {
  assess_system_health,
  type DependencyDef,
  type SystemHealthSnapshot,
} from '../src/core/system_health';
import { make_diagnose_dependency } from '../src/specialists/trainer/tools/diagnose_dependency';
import { makeHandler, demuxDockerLogs, type RelayConfig, type LogsResult } from '../ops/ops-relay/relay';
import { fetch_logs, type OpsLogsResult } from '../src/connectors/ops_relay';
import type { ToolContext } from '../src/core/tool';
import type { FactCriticResult } from '../src/core/fact_critic';

let failures = 0;
function check(label: string, ok: boolean): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) failures++;
}

const dir = mkdtempSync(join(tmpdir(), 'hearth-diag-'));
const db = open_db(join(dir, 'smoke.db'));
const memory = new MemoryClient({ vault_root: join(dir, 'vault'), db });

/* ------------------------------------------------------------------ */
/* Fixtures: a firecrawl dep, a crash log, a scripted model           */
/* ------------------------------------------------------------------ */

const FIRECRAWL: DependencyDef = {
  name: 'firecrawl',
  label: 'Firecrawl (web page fetch)',
  probe: { url_env: 'FIRECRAWL_BASE_URL', default_url: 'http://firecrawl:3002/health', health_path: '' },
  backs_tools: ['web_fetch_clean'],
  restartable: true,
  restart_service: 'firecrawl-worker',
  impact: 'all web-page reading',
};

const CRASH_LOG = [
  '2026-06-20T03:00:01Z firecrawl-worker | > firecrawl-worker@1.0.0 start',
  '2026-06-20T03:00:02Z firecrawl-worker | npm ERR! code ELIFECYCLE',
  '2026-06-20T03:00:02Z firecrawl-worker | npm ERR! errno 1',
  '2026-06-20T03:00:02Z firecrawl-worker | worker exited (1)',
].join('\n');

// The scripted model fabricates a PHANTOM_ERROR_XYZ specific NOT in the logs —
// the grounding critic must drop it.
const complete_role_fn: CompleteRoleFn = async (_role, { system }) => {
  if (system.includes('Diagnose the ROOT CAUSE')) {
    return JSON.stringify({
      root_cause:
        'The firecrawl-worker container exited (1) with ELIFECYCLE during npm start, so the worker crashed on boot.\n' +
        'It also cites PHANTOM_ERROR_XYZ as the underlying trigger.',
      confidence: 0.8,
      inconclusive: false,
      fixes: [
        { type: 'restart', title: 'Restart firecrawl-worker', detail: 'Restart the crashed worker container.', target: 'firecrawl-worker', apply_via: 'restart_service' },
        { type: 'code_change', title: 'Pin the failing dep', detail: 'Pin the npm dep that breaks the worker boot in package.json.', target: 'package.json', apply_via: 'propose_code_edit' },
      ],
    });
  }
  if (system.includes('SKEPTICAL SRE reviewer')) {
    return JSON.stringify({
      scores: [
        { likelihood_to_resolve: 0.7, risk: 'low', reversibility: 'easy', blast_radius: 'service', rationale: 'a wedged worker restart usually clears ELIFECYCLE' },
        { likelihood_to_resolve: 0.6, risk: 'medium', reversibility: 'moderate', blast_radius: 'broad', rationale: 'real fix but slow + wider blast radius' },
      ],
    });
  }
  return null;
};

// Scripted fact critic: flags the fabricated specific, grounds everything else.
const verify_fn = (async (args: { reply: string }): Promise<FactCriticResult> => ({
  checked: true,
  unsupported: args.reply.includes('PHANTOM_ERROR_XYZ')
    ? [{ claim: 'PHANTOM_ERROR_XYZ', kind: 'named_entity', reason: 'not present in the gathered evidence' }]
    : [],
})) as DiagnosisEngineDeps['verify_fn'];

// Injected assess: firecrawl DOWN (probe reachable, but error-rate 100%).
const assess_fn = (async (): Promise<SystemHealthSnapshot> => ({
  generated_at: new Date().toISOString(),
  dependencies: [
    {
      name: 'firecrawl', label: FIRECRAWL.label, status: 'down', probe_reachable: true,
      probe_detail: 'HTTP 200', error_rate: 1, calls: 12, errors: 12,
      restartable: true, restart_service: 'firecrawl-worker', impact: FIRECRAWL.impact,
      reason: '100% of 12 calls failing',
    },
  ],
  unhealthy: ['firecrawl'],
})) as typeof assess_system_health;

const fetch_logs_fn = async (_svc: string, _tail: number): Promise<OpsLogsResult> => ({ ok: true, reason: 'ok', logs: CRASH_LOG });

const engine_seams = { complete_role_fn, verify_fn, assess_fn, fetch_logs_fn };

/* ------------------------------------------------------------------ */
/* 0. ops-relay /logs PURE handler + demux + client                    */
/* ------------------------------------------------------------------ */
{
  function frame(stream: number, text: string): Uint8Array {
    const payload = new TextEncoder().encode(text);
    const buf = new Uint8Array(8 + payload.length);
    buf[0] = stream;
    new DataView(buf.buffer).setUint32(4, payload.length, false);
    buf.set(payload, 8);
    return buf;
  }
  function concat(...arrs: Uint8Array[]): Uint8Array {
    const out = new Uint8Array(arrs.reduce((n, a) => n + a.length, 0));
    let o = 0;
    for (const a of arrs) { out.set(a, o); o += a.length; }
    return out;
  }
  check('demux: framed stdout+stderr → joined text', demuxDockerLogs(concat(frame(1, 'hello '), frame(2, 'world'))) === 'hello world');
  check('demux: TTY (unframed) text passes through', demuxDockerLogs(new TextEncoder().encode('plain log line')) === 'plain log line');

  let logged: string[] = [];
  const cfg: RelayConfig = {
    token: 'secret',
    allowedServices: new Set(['firecrawl-worker']),
    dockerSocket: '/dev/null',
    fetchLogs: async (svc): Promise<LogsResult> => { logged.push(svc); return { ok: true, status: 200, logs: CRASH_LOG }; },
  };
  const h = makeHandler(cfg);
  const getLogs = (svc: string, auth?: string) =>
    h(new Request(`http://r/logs/${svc}?tail=50`, { headers: auth ? { authorization: auth } : {} }));

  check('relay /logs no auth → 401', (await getLogs('firecrawl-worker')).status === 401);
  // READ-ANY (2026-07-08 service-mode Phase B): the read endpoints
  // (list/inspect/logs) are bearer-gated but NOT allowlisted — diagnostic
  // visibility over the whole stack. Only /restart stays allowlist-narrow.
  const anyRes = await getLogs('evil', 'Bearer secret');
  check('relay /logs read-any: un-allowlisted service readable with bearer',
    anyRes.status === 200 && logged.length === 1 && logged[0] === 'evil');
  const okRes = await getLogs('firecrawl-worker', 'Bearer secret');
  const okBody = (await okRes.json()) as { ok: boolean; logs: string };
  check('relay /logs allowlisted+auth → 200 + logs', okRes.status === 200 && okBody.logs.includes('ELIFECYCLE') && logged.length === 2);

  const noTok = makeHandler({ token: undefined, allowedServices: new Set(['x']), dockerSocket: '/dev/null', fetchLogs: async () => ({ ok: true, status: 200, logs: 'x' }) });
  check('relay /logs no token → 503 (fail-closed)', (await noTok(new Request('http://r/logs/x', { headers: { authorization: 'Bearer x' } }))).status === 503);

  // client fetch_logs
  const okFetch = (async () => new Response(JSON.stringify({ ok: true, logs: CRASH_LOG }), { status: 200 })) as unknown as typeof fetch;
  const c1 = await fetch_logs('firecrawl-worker', { url: 'http://relay', token: 't', fetchImpl: okFetch });
  check('client fetch_logs: 200 → ok + logs', c1.ok && c1.reason === 'ok' && (c1.logs ?? '').includes('ELIFECYCLE'));
  const forbid = (async () => new Response('no', { status: 403 })) as unknown as typeof fetch;
  const c2 = await fetch_logs('evil', { url: 'http://relay', token: 't', fetchImpl: forbid });
  check('client fetch_logs: 403 → not_allowed', !c2.ok && c2.reason === 'not_allowed');
  const boom = (async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch;
  const c3 = await fetch_logs('x', { url: 'http://relay', token: 't', fetchImpl: boom });
  check('client fetch_logs: relay down → relay_unavailable (fail-safe)', !c3.ok && c3.reason === 'relay_unavailable');
  const c4 = await fetch_logs('x', { url: '' });
  check('client fetch_logs: no relay URL → relay_unavailable', !c4.ok && c4.reason === 'relay_unavailable');
}

/* ------------------------------------------------------------------ */
/* seed: audit errors + an open incident + a health miss               */
/* ------------------------------------------------------------------ */

function seed_audit_error(tool: string, msg: string, in_column: boolean): void {
  db.prepare(
    `INSERT INTO audit_log (id, ts, intent_id, agent, tool_name, tool_input, execution_result, error)
     VALUES (@id, @ts, @intent, 'kate', @tool, '{}', @res, @err)`,
  ).run({
    '@id': ulid(),
    '@ts': new Date().toISOString(),
    '@intent': ulid(),
    '@tool': tool,
    '@res': in_column ? '{"ok":false}' : JSON.stringify({ error: msg }),
    '@err': in_column ? msg : null,
  });
}
// Mix: some errors in the `error` column, some inside execution_result (the
// silent-connector-outage shape) — the gatherer must read BOTH.
seed_audit_error('web_fetch_clean', 'Request timed out after 30000ms', true);
seed_audit_error('web_fetch_clean', 'fetch failed: ECONNREFUSED firecrawl:3002', false);
seed_audit_error('web_fetch_clean', 'Request timed out after 30000ms', true); // dup → deduped

const incidents = new HealthIncidentStore(db);
incidents.open_or_update('firecrawl', 'down', '100% of 12 calls failing', { error_rate: 1 }, new Date(Date.now() - 8 * 86400_000));
const misses = new ProcessMissStore(db);
misses.create({
  subject_specialist_id: 'trainer',
  reporter: 'kate',
  task_summary: 'Keep Firecrawl healthy',
  gap: 'Firecrawl is down: 100% of calls failing.',
  severity: 'high',
  evidence_ref: 'dependency:firecrawl:health',
});

/* ------------------------------------------------------------------ */
/* 1. evidence pack                                                    */
/* ------------------------------------------------------------------ */

const engine: DiagnosisEngineDeps = { db, llm: {} as never, ...engine_seams };
{
  const pack = await gather_evidence_pack(engine, FIRECRAWL);
  check('evidence: container logs read via relay', pack.logs_source === 'relay' && (pack.container_logs ?? '').includes('ELIFECYCLE'));
  check('evidence: error samples from BOTH error column AND execution_result', pack.error_samples.length === 2 && pack.error_samples.some((s) => s.message.includes('timed out')) && pack.error_samples.some((s) => s.message.includes('ECONNREFUSED')));
  check('evidence: resolved config carries the base URL + restart_service', pack.config['FIRECRAWL_BASE_URL'] !== undefined && pack.config['restart_service'] === 'firecrawl-worker');
  check('evidence: open incident attached (down for ~8d)', pack.incident !== null && pack.incident!.down_for === '8d');
  check('evidence: probe + rate from the assessor', pack.status === 'down' && pack.error_rate === 1 && pack.probe_reachable === true);
}

/* ------------------------------------------------------------------ */
/* 2+3. diagnosis: grounded, typed, scored, ranked, gated              */
/* ------------------------------------------------------------------ */

const diag = await run_diagnosis(engine, FIRECRAWL);
check('diagnosis: root cause grounded in the real log line (ELIFECYCLE)', diag.root_cause.includes('ELIFECYCLE'));
check('diagnosis: fabricated specific DROPPED by the critic', diag.ungrounded_dropped.includes('PHANTOM_ERROR_XYZ'));
check('diagnosis: fabricated specific SCRUBBED from the narrative', !diag.root_cause.includes('PHANTOM_ERROR_XYZ'));
check('diagnosis: fixes are typed (restart + code_change + escalate floor)', diag.fixes.some((f) => f.type === 'restart') && diag.fixes.some((f) => f.type === 'code_change') && diag.fixes.some((f) => f.type === 'escalate'));
check('diagnosis: EVERY fix carries a real FixScore', diag.fixes.every((f) => typeof f.score.confidence === 'number' && f.score.confidence >= 0 && f.score.confidence <= 1));
check('diagnosis: ranked best-first by composite confidence', diag.fixes.every((f, i) => i === 0 || diag.fixes[i - 1]!.score.confidence >= f.score.confidence));
check('diagnosis: recommended pick is the high-confidence restart', diag.recommended_index === 0 && diag.fixes[0]!.type === 'restart' && diag.fixes[0]!.score.confidence > 0.5);
check('diagnosis: code_change scored below the restart (skeptical composite)', (diag.fixes.find((f) => f.type === 'code_change')?.score.confidence ?? 1) < diag.fixes[0]!.score.confidence);
check('gates: every fix apply_via is an EXISTING gate (no novel apply surface)', diag.fixes.every((f) => EXISTING_GATES.has(f.apply_via)));

/* ------------------------------------------------------------------ */
/* 4. the tool: persist + file owner proposal + route through gates    */
/* ------------------------------------------------------------------ */

const proposals = new ProposalsStore(db);
const ctx: ToolContext = { memory, llm: {} as never, now: new Date(), intent_id: ulid(), specialist_id: 'trainer' };
{
  const tool = make_diagnose_dependency({ db, memory, proposals, process_misses: misses, ...engine_seams });
  const out = await tool.execute({ dependency: 'firecrawl' }, ctx);
  check('tool: ok + diagnosis persisted', out.ok && out.diagnosis_id !== null);
  check('tool: recommended_fix is the restart, via the restart_service gate', out.recommended_fix?.type === 'restart' && out.recommended_fix?.apply_via === 'restart_service' && EXISTING_GATES.has(out.recommended_fix!.apply_via as never));
  check('tool: next_action routes through the existing gate (restart_service)', out.next_action.includes('restart_service'));
  check('tool: filed an owner recommendation proposal', out.proposal_id !== null);

  const stored = new HealthDiagnosisStore(db).get(out.diagnosis_id!);
  check('tool: diagnosis row persisted with the scored fixes', stored !== null && stored!.fixes.length === diag.fixes.length && stored!.proposal_id === out.proposal_id);
  check('tool: stored fixes ALL route through existing gates', stored!.fixes.every((f) => EXISTING_GATES.has(f.apply_via)));

  const propRow = db.prepare(`SELECT kind, user_id, status, payload_json, rationale_md FROM proposals WHERE id = @id`).get({ '@id': out.proposal_id }) as
    | { kind: string; user_id: string | null; status: string; payload_json: string; rationale_md: string }
    | undefined;
  check('tool: proposal is an owner-global recommendation (user_id NULL)', !!propRow && propRow.kind === 'recommendation' && propRow.user_id === null);
  const payload = JSON.parse(propRow!.payload_json) as { dependency: string; recommended_fix?: { apply_via: string }; cited_miss_ids: string[] };
  check('tool: proposal payload names the dep + cites the open health miss', payload.dependency === 'firecrawl' && payload.cited_miss_ids.length === 1);
  check('tool: proposal recommended_fix applies via an existing gate', !!payload.recommended_fix && EXISTING_GATES.has(payload.recommended_fix.apply_via as never));

  // The tool itself NEVER restarts/edits — its only outbound infra call is the
  // read-only logs fetch. (A restart would have needed an ops-relay restart
  // client we never wired here; the tool has no path to it.)
  check('tool: applied NOTHING itself (read-only diagnosis)', stored!.status === 'diagnosed' && stored!.applied_fix === null);
}

/* ------------------------------------------------------------------ */
/* 5. fail-open + kill switch + unknown dep                            */
/* ------------------------------------------------------------------ */
{
  // Model + logs + critic all unavailable → inconclusive, fail-open fix, never throws.
  const blind: DiagnosisEngineDeps = {
    db, llm: {} as never,
    complete_role_fn: async () => null,
    verify_fn,
    assess_fn,
    fetch_logs_fn: async () => ({ ok: false, reason: 'relay_unavailable', detail: 'unwired' }),
  };
  const d2 = await run_diagnosis(blind, FIRECRAWL);
  check('fail-open: model outage → inconclusive diagnosis with a safe fix', d2.inconclusive && d2.fixes.length > 0 && d2.fixes.every((f) => EXISTING_GATES.has(f.apply_via)));
  check('fail-open: logs unwired → noted, never thrown', d2.evidence.logs_source === 'unavailable' && (d2.evidence.logs_note ?? '').length > 0);

  // Kill switch.
  process.env.HEARTH_HEALTH_DIAGNOSIS = '0';
  const tool = make_diagnose_dependency({ db, memory, proposals, process_misses: misses, ...engine_seams });
  const off = await tool.execute({ dependency: 'firecrawl' }, ctx);
  const propsBefore = (db.prepare(`SELECT COUNT(*) n FROM proposals WHERE kind='recommendation'`).get() as { n: number }).n;
  check('kill switch: HEARTH_HEALTH_DIAGNOSIS=0 → no-op, no proposal', off.enabled === false && off.diagnosis_id === null && propsBefore === 1);
  delete process.env.HEARTH_HEALTH_DIAGNOSIS;

  // Unknown dependency → typed refusal, not a throw.
  const tool2 = make_diagnose_dependency({ db, memory, proposals, ...engine_seams });
  const ref = await tool2.execute({ dependency: 'not_a_dep' }, ctx);
  check('refusal: unknown dependency → refused result with the known names', ref.refused && ref.diagnosis_id === null && ref.next_action.includes('firecrawl'));
}

db.close();
rmSync(dir, { recursive: true, force: true });
console.log(failures === 0 ? '\nsmoke:health-diagnosis OK' : `\nsmoke:health-diagnosis FAILED (${failures} check(s))`);
process.exit(failures === 0 ? 0 : 1);
