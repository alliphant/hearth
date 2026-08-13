/**
 * Smoke for the 2026-08-10/11 directed-build postmortem hardening:
 *
 *  1. change_dedup_key — supersession requires SAME-BRANCH intent. The bare
 *     proposal-id key let sibling changes for one proposal supersede each
 *     other (PR #269 wrongly retired PR #268 and its open PR vanished from
 *     the review queue).
 *  2. ChangeRecordsStore — sibling changes coexist; a -vN re-file of the SAME
 *     branch still supersedes; supersessions increment guard_counters.
 *  3. GuardCounterStore — increment/list semantics the Mariah sweep reads.
 *  4. resolve_tool_round_ceiling — per-pass override (clamped), the
 *     deliberation-slot YAML ceiling, chat fallback, directed default.
 *  5. file_directed_build_miss — a failed build is a HIGH-severity ledger row,
 *     keyed per-directive so re-failures fold onto one row.
 *  6. scan_program_health guard-recurrence sweep — a counter at threshold
 *     opens a miss once (evidence_ref chokepoint keeps it single).
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { open_db } from '../src/memory/stores/structured';
import { GuardCounterStore, GUARD_CHANGE_DEDUP_SUPERSESSION } from '../src/memory/stores/guard_counters';
import { ChangeRecordsStore } from '../src/memory/stores/change_records';
import { change_dedup_key } from '../src/specialists/trainer/change_pipeline';
import {
  resolve_tool_round_ceiling,
  file_directed_build_miss,
  TOOL_ROUNDS_OVERRIDE_CAP,
} from '../src/core/specialist_runtime';
import { directed_tool_rounds_default } from '../src/core/deliberation';
import { ProcessMissStore } from '../src/core/process_misses';
import { create as create_scan_program_health } from '../src/specialists/mariah/tools/scan_program_health';
import type { ToolDeps } from '../src/core/tool_deps';
import type { ToolContext } from '../src/core/tool';

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) { console.log(`  ✓ ${name}`); passed++; }
  else { console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); failed++; }
}

const dir = mkdtempSync(join(tmpdir(), 'hearth-directed-guards-'));
const db = open_db(join(dir, 'smoke.db'));

// ── 1. change_dedup_key: same-branch intent ──────────────────────────────────
console.log('→ change_dedup_key requires same-branch intent');
{
  const P = '01KTESTPROPOSAL';
  const tool_key = change_dedup_key('beatrice/read-miss-tool', P);
  const grants_key = change_dedup_key('beatrice/read-miss-grants', P);
  check('sibling branches under ONE proposal get DISTINCT keys (the #268/#269 bug)', tool_key !== grants_key);
  check('a -v2 re-file of the same branch shares the key (revision supersedes)',
    change_dedup_key('beatrice/read-miss-tool-v2', P) === tool_key);
  check('no proposal id → branch-base key',
    change_dedup_key('beatrice/fix-thing-v3') === 'code:beatrice/fix-thing');
  check('proposal id is still part of the key (same branch, different proposals differ)',
    change_dedup_key('beatrice/x', 'A') !== change_dedup_key('beatrice/x', 'B'));
}

// ── 2. ChangeRecordsStore: siblings coexist, revisions supersede ─────────────
console.log('→ ChangeRecordsStore supersession behavior');
{
  const store = new ChangeRecordsStore(db);
  const P = '01KTESTPROPOSAL';
  const mk = (branch: string) =>
    store.create({
      origin: 'propose_code_change',
      change_kind: 'code',
      branch,
      files: ['src/x.ts'],
      dedup_key: change_dedup_key(branch, P),
      related_proposal_id: P,
    });
  const tool_change = mk('beatrice/read-miss-tool');
  const grants_change = mk('beatrice/read-miss-grants');
  check('filing the sibling does NOT supersede the first change',
    store.get(tool_change.id)?.status === 'pending_kate_review');
  check('both siblings are open for review',
    store.get(grants_change.id)?.status === 'pending_kate_review');
  const revision = mk('beatrice/read-miss-tool-v2');
  check('a -v2 revision of the SAME branch supersedes the original',
    store.get(tool_change.id)?.status === 'superseded' &&
      store.get(tool_change.id)?.superseded_by === revision.id);
  check('…and leaves the sibling untouched',
    store.get(grants_change.id)?.status === 'pending_kate_review');

  const counter = new GuardCounterStore(db).get(
    GUARD_CHANGE_DEDUP_SUPERSESSION,
    change_dedup_key('beatrice/read-miss-tool', P),
  );
  check('the supersession incremented its guard counter', counter?.count === 1);
}

// ── 3. GuardCounterStore semantics ───────────────────────────────────────────
console.log('→ GuardCounterStore increment/list');
{
  const counters = new GuardCounterStore(db);
  counters.increment('round_ceiling_exhaust', 'kate', '15/15 rounds');
  counters.increment('round_ceiling_exhaust', 'kate', '20/20 rounds');
  counters.increment('round_ceiling_exhaust', 'kate', '18/18 rounds');
  counters.increment('round_ceiling_exhaust', 'ruby', '18/18 rounds');
  check('three hits accumulate on one (guard, scope) row',
    counters.get('round_ceiling_exhaust', 'kate')?.count === 3);
  check('last_detail tracks the most recent hit',
    counters.get('round_ceiling_exhaust', 'kate')?.last_detail === '18/18 rounds');
  const over = counters.list({ guard: 'round_ceiling_exhaust', min_count: 3, since_hours: 1 });
  check('list(min_count 3) returns only the recurring scope',
    over.length === 1 && over[0]?.scope === 'kate');
}

// ── 4. resolve_tool_round_ceiling precedence ─────────────────────────────────
console.log('→ resolve_tool_round_ceiling precedence + clamps');
{
  const bare = {} as { max_tool_rounds?: number; max_tool_rounds_deliberation?: number };
  check('global default is 15', resolve_tool_round_ceiling(bare) === 15);
  check('chat uses max_tool_rounds', resolve_tool_round_ceiling({ max_tool_rounds: 18 }) === 18);
  check('deliberation slot ceiling wins on deliberation turns',
    resolve_tool_round_ceiling({ max_tool_rounds: 18, max_tool_rounds_deliberation: 30 }, { mode: 'deliberation' }) === 30);
  check('…but chat turns ignore it',
    resolve_tool_round_ceiling({ max_tool_rounds: 18, max_tool_rounds_deliberation: 30 }, { mode: 'chat' }) === 18);
  check('a per-pass override beats everything',
    resolve_tool_round_ceiling({ max_tool_rounds: 18, max_tool_rounds_deliberation: 30 }, { mode: 'deliberation', override: 45 }) === 45);
  check(`an oversized override clamps to ${TOOL_ROUNDS_OVERRIDE_CAP}`,
    resolve_tool_round_ceiling(bare, { override: 900 }) === TOOL_ROUNDS_OVERRIDE_CAP);
  check('a zero/negative override clamps to 1',
    resolve_tool_round_ceiling(bare, { override: 0 }) === 1);
  check('directed default is 30 when env unset', directed_tool_rounds_default() === 30);
  process.env.HEARTH_DIRECTED_TOOL_ROUNDS = '42';
  check('HEARTH_DIRECTED_TOOL_ROUNDS overrides the directed default', directed_tool_rounds_default() === 42);
  delete process.env.HEARTH_DIRECTED_TOOL_ROUNDS;
}

// ── 5. file_directed_build_miss: loud, high, folds per directive ─────────────
console.log('→ file_directed_build_miss');
{
  const misses = new ProcessMissStore(db);
  const args = {
    specialist_id: 'kate',
    conversation_id: 'deliberation:kate:build',
    shape: 'blank_turn',
    instruction_preview: 'Jasper just APPROVED your recommendation proposal `01KTESTPROPOSAL`…',
    rounds_used: 4,
    tool_round_ceiling: 30,
    tool_calls_count: 6,
    tool_errors: 3,
  };
  file_directed_build_miss(misses, args);
  const rows = misses.list().filter((m) => m.evidence_ref?.startsWith('directed-build-fail:kate:'));
  check('a failed directed build files a miss', rows.length === 1);
  check('…at HIGH severity (an approved build producing nothing is a ledger event)',
    rows[0]?.severity === 'high');
  file_directed_build_miss(misses, { ...args, shape: 'ceiling_exhausted', rounds_used: 30 });
  const after = misses.list().filter((m) => m.evidence_ref?.startsWith('directed-build-fail:kate:'));
  check('the SAME directive re-failing folds onto one row (chokepoint dedup)', after.length === 1);
  file_directed_build_miss(misses, { ...args, instruction_preview: 'a DIFFERENT directive entirely' });
  const distinct = misses.list().filter((m) => m.evidence_ref?.startsWith('directed-build-fail:kate:'));
  check('a DIFFERENT directive gets its own row', distinct.length === 2);
}

// ── 6. scan_program_health: guard recurrences open a miss ────────────────────
console.log('→ scan_program_health guard-recurrence sweep');
{
  const misses = new ProcessMissStore(db);
  // Partial deps bag — the sweep paths exercised here touch db + misses only
  // (no failed proposals / followups / stalled approvals exist in this db).
  const tool = create_scan_program_health({
    db,
    process_misses: misses,
    proposals: undefined,
    specialists: undefined,
    tool_registry: undefined,
  } as unknown as ToolDeps);
  const ctx = { now: new Date() } as unknown as ToolContext;

  const out1 = (await tool.execute(
    {},
    ctx,
  )) as { guard_recurrences_seen: number; misses_opened: Array<{ source: string; evidence_ref: string }> };
  const guard_openings = out1.misses_opened.filter((o) => o.source === 'guard_recurrence');
  check('counters at threshold are seen', out1.guard_recurrences_seen >= 1);
  check('the recurring round-ceiling counter opened a miss',
    guard_openings.some((o) => o.evidence_ref === 'guard-counter:round_ceiling_exhaust:kate'));
  check('a below-threshold counter (ruby ×1) did NOT open a miss',
    !guard_openings.some((o) => o.evidence_ref.includes(':ruby')));

  const out2 = (await tool.execute({}, ctx)) as { misses_opened: Array<{ source: string }> };
  check('re-running the scan does not double-open (tracked by evidence_ref)',
    !out2.misses_opened.some((o) => o.source === 'guard_recurrence'));
}

db.close();
rmSync(dir, { recursive: true, force: true });

console.log(`\n  passed=${passed}  failed=${failed}`);
if (failed > 0) { console.error('\n✗ DIRECTED-BUILD-GUARDS SMOKE FAILED'); process.exit(1); }
console.log('\n✓ DIRECTED-BUILD-GUARDS SMOKE OK');
