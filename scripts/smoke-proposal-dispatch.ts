export {};
/**
 * smoke:proposal-dispatch — Mariah executing approved-but-stalled proposals.
 *
 * Self-contained: temp SQLite, trainer config copied into a temp
 * specialists dir, a ToolRegistry with a real tool to dispatch.
 * Exercises dispatch_approved_proposal:
 *   - a clean dispatch-payload proposal (tool resolved from payload)
 *   - a freeform proposal dispatched with explicit tool args
 *   - rejection of non-approved / already-executed / unknown proposals
 *
 *   bun run smoke:proposal-dispatch
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { open_db } from '@memory/stores/structured';
import { SpecialistRegistry } from '@core/specialist';
import { ProposalsStore } from '@core/proposals';
import { ToolRegistry } from '@core/tool_registry';
import { load_extra_capabilities } from '@core/capabilities';
import { create as create_analyze } from '@specialists/trainer/tools/analyze_capability_gaps';
import { create as create_dispatch } from '@specialists/mariah/tools/dispatch_approved_proposal';
import type { ToolDeps } from '@core/tool_deps';
import type { ToolContext } from '@core/tool';

let failures = 0;
function check(label: string, ok: boolean): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) failures++;
}
async function rejects(fn: () => Promise<unknown>): Promise<boolean> {
  try {
    await fn();
    return false;
  } catch {
    return true;
  }
}

const dir = mkdtempSync(resolve(tmpdir(), 'hearth-dispatch-'));
const specialists_dir = resolve(dir, 'specialists');
mkdirSync(specialists_dir, { recursive: true });
const seed = resolve(import.meta.dir, '..', 'config', 'specialists');
writeFileSync(
  resolve(specialists_dir, 'trainer.yaml'),
  readFileSync(resolve(seed, 'trainer.yaml'), 'utf8'),
  'utf8',
);
load_extra_capabilities(resolve(import.meta.dir, '..', 'config', 'capabilities.yaml'));

const db = open_db(resolve(dir, 'hearth.db'));

try {
  const specialists = new SpecialistRegistry(specialists_dir);
  const proposals = new ProposalsStore(db);
  const tools = new ToolRegistry();
  const deps = { db, proposals, specialists, tool_registry: tools } as unknown as ToolDeps;
  // analyze_capability_gaps is the tool we dispatch (trainer can run it).
  tools.register(create_analyze(deps));
  const dispatch = create_dispatch(deps);

  check('trainer config loaded', !!specialists.get('trainer'));
  const ctx = { now: new Date(), intent_id: 'smoke' } as unknown as ToolContext;
  const sig = { specialist_id: 'trainer', kind: 'test', category: 'test' };

  // ── 1. clean dispatch payload — tool resolved from the payload ──────────
  const id1 = proposals.create({
    specialist_id: 'trainer',
    kind: 'action_proposal',
    execution_kind: 'dispatch',
    payload: {
      dispatch_tool: 'analyze_capability_gaps',
      dispatch_input: { capability_wishlist: ['read_vault'] },
    },
    rationale: 'analyze a capability wishlist',
    signature: sig,
  });
  proposals.decide(id1, 'approve');
  const out1 = (await dispatch.execute({ proposal_id: id1 }, ctx)) as {
    ok: boolean;
    proposal_status: string;
  };
  check('dispatches a clean-payload approved proposal', out1.ok && out1.proposal_status === 'executed');
  check(
    'the proposal is marked executed',
    proposals.get(id1)?.status === 'executed' && proposals.get(id1)?.ts_executed != null,
  );

  // ── 2. freeform payload — caller supplies the explicit tool call ────────
  const id2 = proposals.create({
    specialist_id: 'trainer',
    kind: 'action_proposal',
    execution_kind: 'manual',
    payload: { action: { task: 'analyze gaps', note: 'freeform — no dispatch_tool' } },
    rationale: 'freeform action proposal',
    signature: sig,
  });
  proposals.decide(id2, 'approve');
  const out2 = (await dispatch.execute(
    {
      proposal_id: id2,
      tool_name: 'analyze_capability_gaps',
      tool_input: { capability_wishlist: ['read_caldav'] },
    },
    ctx,
  )) as { ok: boolean };
  check('dispatches a freeform proposal with explicit tool args', out2.ok);
  check('the freeform proposal is marked executed', proposals.get(id2)?.ts_executed != null);

  // ── 3. guards ──────────────────────────────────────────────────────────
  const id3 = proposals.create({
    specialist_id: 'trainer',
    kind: 'action_proposal',
    execution_kind: 'manual',
    payload: {},
    rationale: 'still pending',
    signature: sig,
  });
  check(
    'rejects a non-approved proposal',
    await rejects(() =>
      dispatch.execute(
        { proposal_id: id3, tool_name: 'analyze_capability_gaps', tool_input: { capability_wishlist: [] } },
        ctx,
      ),
    ),
  );
  check(
    'rejects an already-executed proposal',
    await rejects(() => dispatch.execute({ proposal_id: id1 }, ctx)),
  );
  check(
    'rejects an unknown proposal id',
    await rejects(() => dispatch.execute({ proposal_id: 'no_such_proposal' }, ctx)),
  );
} finally {
  db.close();
  rmSync(dir, { recursive: true, force: true });
}

console.log(
  failures === 0
    ? '\nsmoke:proposal-dispatch OK'
    : `\nsmoke:proposal-dispatch FAILED (${failures} check(s))`,
);
process.exit(failures === 0 ? 0 : 1);
