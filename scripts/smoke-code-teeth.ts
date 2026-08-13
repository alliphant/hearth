/**
 * smoke:code-teeth — trust teeth for code merges + the health-gated deploy
 * (2026-07-05, owner-decided).
 *
 *   A. The protected-path FLOOR (pure): policy/guards/capabilities/audit/
 *      auth/alert/pipeline/composition-root changes are protected; a plain
 *      tool change is clear; an EMPTY file list is protected (fail-closed);
 *      HEARTH_CODE_PROTECTED_EXTRA widens.
 *   B. arm_trust_autoexec honors the per-class window override, and the
 *      sweep gate opens for EITHER teeth flag (both off = frozen).
 *   C. The relay /deploy handler over scripted seams: bearer + allowlist
 *      gates; healthy deploy records 'deployed'; a failed boot rolls back
 *      to the pre-pull sha (checkout prev + restart + recovered health →
 *      'rolled_back'); a no-change pull is a 'noop' with NO restart.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { open_db } from '@memory/stores/structured';
import { MemoryClient } from '@memory/client';
import { ProposalsStore } from '@core/proposals';
import { arm_trust_autoexec, sweep_trust_autoexec } from '@core/trust_teeth';
import { is_protected_code_change } from '@specialists/trainer/code_teeth';
import { makeHandler, type RelayConfig } from '../ops/ops-relay/relay';

let failures = 0;
function assert(cond: unknown, msg: string): void {
  if (cond) console.log(`  ✓ ${msg}`);
  else {
    console.error(`  ✗ ${msg}`);
    failures++;
  }
}

async function main() {
  // ── A. the floor ──────────────────────────────────────────────────────
  console.log('A. protected-path floor');
  for (const f of [
    'src/policy/gateway.ts',
    'config/capabilities.yaml',
    'config/specialists/kate.yaml',
    'src/core/specialist_runtime.ts',
    'src/core/audit_chain.ts',
    'src/specialists/trainer/change_pipeline.ts',
    'src/specialists/trainer/code_teeth.ts',
    'apps/orchestrator/server.ts',
    'ops/ops-relay/relay.ts',
    'package.json',
  ]) {
    assert(is_protected_code_change([f]), `protected: ${f}`);
  }
  assert(!is_protected_code_change(['src/specialists/kate/tools/manage_household_services.ts']), 'a plain tool change is clear');
  assert(!is_protected_code_change(['src/core/delegation.ts', 'scripts/smoke-delegate.ts']), 'runner + smoke change is clear');
  assert(is_protected_code_change(['src/core/delegation.ts', 'src/policy/push.ts']), 'ONE protected file protects the whole change');
  assert(is_protected_code_change([]), 'empty file list is protected (fail-closed)');
  process.env.HEARTH_CODE_PROTECTED_EXTRA = 'src/core/kate_line';
  assert(is_protected_code_change(['src/core/kate_line.ts']), 'env extra widens the floor');
  delete process.env.HEARTH_CODE_PROTECTED_EXTRA;

  // ── B. arm window + sweep gate ────────────────────────────────────────
  console.log('B. arm window override + sweep dual-flag gate');
  const tmp = mkdtempSync(join(tmpdir(), 'smoke-code-teeth-'));
  const db = open_db(join(tmp, 't.db'));
  const memory = new MemoryClient({ vault_root: join(tmp, 'vault'), db });
  const proposals = new ProposalsStore(db);
  const pid = proposals.create({
    specialist_id: 'trainer',
    kind: 'recommendation',
    execution_kind: 'dispatch',
    user_id: null,
    skip_kate_review: true,
    payload: { dispatch_tool: 'merge_approved_change', dispatch_input: { change_id: 'bc_x' }, code_teeth_armed: true },
    rationale: 'test merge card',
    signature: { specialist_id: 'trainer', kind: 'beatrice_merge', category: 'self_improvement', anchor: 'bc_x' },
  });
  const p = proposals.get(pid)!;
  const now = new Date('2026-07-05T12:00:00Z');
  const pushes: string[] = [];
  const armed = await arm_trust_autoexec(
    { db, proposals, memory, push_fn: async (_u, text) => void pushes.push(text) },
    p,
    'code-trust',
    [{ seat: 'kate', vote: 'approve', reason: 'clean review' }],
    now,
    120,
  );
  const exec_at = Date.parse(armed.row.execute_after);
  assert(exec_at === now.getTime() + 120 * 60_000, 'window override lands execute_after at +120min');
  assert(pushes.length === 1 && pushes[0]!.includes('deny it in the proposal queue'), 'arm push names the cancel affordance');
  const rearm = await arm_trust_autoexec({ db, proposals, memory, push_fn: async () => {} }, p, 'code-trust', [], now, 120);
  assert(rearm.already_armed === true && pushes.length === 1, 're-arm is idempotent (no second push)');

  delete process.env.HEARTH_TRUST_TEETH;
  delete process.env.HEARTH_CODE_TEETH;
  const frozen = await sweep_trust_autoexec({ db, proposals, memory } as never, now);
  assert(frozen.enabled === false, 'both flags off → sweep frozen');
  process.env.HEARTH_CODE_TEETH = '1';
  // Not yet due — the sweep is live but executes nothing.
  const live = await sweep_trust_autoexec({ db, proposals, memory } as never, new Date(now.getTime() + 60_000));
  assert(live.enabled === true && live.executed.length === 0, 'code flag alone opens the sweep; undo window respected');
  delete process.env.HEARTH_CODE_TEETH;

  // ── C. relay /deploy over scripted seams ──────────────────────────────
  console.log('C. relay deploy handler');
  function make_relay(script: {
    shas: string[]; // successive rev-parse results
    pull_ok?: boolean;
    healthy_when?: (state: { checked_out: string | null }) => boolean;
  }) {
    const state = { checked_out: null as string | null, restarts: 0 };
    let rev = 0;
    const cfg: RelayConfig = {
      token: 'tok',
      allowedServices: new Set(['hearth-orchestrator']),
      dockerSocket: '/dev/null',
      restart: async () => {
        state.restarts++;
        return { ok: true, status: 200 };
      },
      run_git: async (args) => {
        if (args[0] === 'rev-parse') return { ok: true, out: script.shas[Math.min(rev++, script.shas.length - 1)]! };
        if (args[0] === 'checkout') {
          state.checked_out = args[1]!;
          return { ok: true, out: '' };
        }
        if (args[0] === 'pull') return script.pull_ok === false ? { ok: false, out: '', error: 'diverged' } : { ok: true, out: '' };
        return { ok: true, out: '' };
      },
      probe_health: async () => (script.healthy_when ? script.healthy_when(state) : true),
      healthBudgetMs: 60,
      healthIntervalMs: 10,
    };
    return { handle: makeHandler(cfg), state };
  }
  const post = (handle: (r: Request) => Promise<Response>, path: string, body: unknown, token?: string) =>
    handle(
      new Request(`http://relay${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify(body),
      }),
    );
  const last = async (handle: (r: Request) => Promise<Response>) => {
    for (let i = 0; i < 40; i++) {
      const res = await handle(new Request('http://relay/deploy/last', { headers: { Authorization: 'Bearer tok' } }));
      const body = (await res.json()) as { last: { status: string } | null; in_flight: boolean };
      if (body.last && !body.in_flight) return body.last;
      await new Promise((r) => setTimeout(r, 15));
    }
    return null;
  };

  const auth = make_relay({ shas: ['aaa', 'bbb'] });
  assert((await post(auth.handle, '/deploy', { service: 'hearth-orchestrator' })).status === 401, 'no bearer → 401');
  assert((await post(auth.handle, '/deploy', { service: 'firecrawl' }, 'tok')).status === 403, 'non-allowlisted service → 403');

  const good = make_relay({ shas: ['aaa', 'bbb'] });
  assert((await post(good.handle, '/deploy', { service: 'hearth-orchestrator' }, 'tok')).status === 200, 'deploy dispatches');
  const good_rec = await last(good.handle);
  assert(good_rec?.status === 'deployed', `healthy boot records 'deployed' (got ${good_rec?.status})`);
  assert(good.state.restarts === 1, 'healthy deploy restarts exactly once');

  const bad = make_relay({
    shas: ['aaa', 'bbb'],
    // Unhealthy until the rollback checkout of the PREV sha lands.
    healthy_when: (s) => s.checked_out === 'aaa',
  });
  await post(bad.handle, '/deploy', { service: 'hearth-orchestrator' }, 'tok');
  const bad_rec = await last(bad.handle);
  assert(bad_rec?.status === 'rolled_back', `failed boot rolls back (got ${bad_rec?.status})`);
  assert(bad.state.checked_out === 'aaa' && bad.state.restarts === 2, 'rollback checks out prev sha + restarts again');

  const noop = make_relay({ shas: ['aaa', 'aaa'] });
  await post(noop.handle, '/deploy', { service: 'hearth-orchestrator' }, 'tok');
  const noop_rec = await last(noop.handle);
  assert(noop_rec?.status === 'noop' && noop.state.restarts === 0, 'no-change pull is a noop with no restart');

  rmSync(tmp, { recursive: true, force: true });
  if (failures > 0) {
    console.error(`\nsmoke:code-teeth FAILED — ${failures} assertion(s)`);
    process.exit(1);
  }
  console.log('\nsmoke:code-teeth PASSED');
}

main().catch((err) => {
  console.error('smoke crashed:', err);
  process.exit(1);
});
