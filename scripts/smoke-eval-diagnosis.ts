/**
 * smoke:eval-diagnosis — a failing eval becomes a grounded, scored, gated
 * proposal instead of a process_miss that waits for a human.
 *
 * Self-contained: temp SQLite, scripted model, no network.
 *
 * The behaviour under test is the anti-hack pressure. The obvious version of
 * this feature writes a persona line for every failure, which is precisely
 * what `propose_persona_tuning`'s own description warns against — a prompt
 * tweak cannot fix a broken argument contract, and a loop that ships one would
 * turn the evals green while the system stayed broken, automatically. §C is
 * that guarantee. If it goes red, this feature should be dark, not patched.
 *
 * Coverage:
 *   A. trace capture — failures keep args/errors/hints; passes write nothing;
 *      a harness crash is never read as a behavior defect.
 *   B. evidence rendering — the discriminating facts reach the prompt, and a
 *      tool that failed with NO recovery hint is called out as its own finding.
 *   C. LAYER ATTRIBUTION — a mechanical fix outranks a persona fix that rated
 *      itself higher; an unsanctioned apply gate falls to escalate.
 *   D. arming — dark by default; diagnose-only at =1; filing needs its own rung.
 *   E. filing — Kate-gated kind, signature-deduped, and refused on a
 *      low-confidence or inconclusive read.
 */
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { open_db } from '@memory/stores/structured';
import { EvalTracesStore, to_trace_calls } from '@memory/stores/eval_traces';
import { record_eval_result, type EvalResult } from '@core/evals/harness';
import type { GoldenTask } from '@core/evals/golden_tasks';
import type { ToolRegistry } from '@core/tool_registry';
import type { SpecialistRegistry } from '@core/specialist';
import { ProposalsStore } from '@core/proposals';
import {
  diagnose_eval_failure,
  file_eval_fix_proposal,
  gather_eval_evidence,
  render_eval_evidence,
  run_eval_evolution_pass,
  eval_evolution_enabled,
  eval_evolution_filing_armed,
  MIN_FILE_CONFIDENCE,
  type CompleteRoleFn,
  type EvalDiagnosisReport,
} from '@core/eval_diagnosis';

let failures = 0;
function assert(cond: unknown, msg: string): void {
  if (cond) console.log(`  ✓ ${msg}`);
  else {
    console.error(`  ✗ ${msg}`);
    failures++;
  }
}

delete process.env.HEARTH_EVAL_EVOLUTION;
delete process.env.HEARTH_EVAL_EVOLUTION_FILE;

const dir = mkdtempSync(join(tmpdir(), 'hearth-smoke-evaldiag-'));
const db: Database = open_db(join(dir, 'smoke.db'));
const traces = new EvalTracesStore(db);

const TASK = {
  id: 'upsert-person-note-args',
  specialist_id: 'kate',
  message: 'note that Sam mentioned her sister is visiting in March',
  fixtures: {},
  assertions: { must_call: ['upsert_person_note'], args_valid: ['upsert_person_note'] },
} as unknown as GoldenTask;

const failing_result = (): EvalResult => ({
  task_id: TASK.id,
  specialist_id: 'kate',
  passed: false,
  detail: 'args_valid: upsert_person_note args never validated (arg-spiral)',
  tool_calls: [{ name: 'find_or_create_person', errored: false }, { name: 'upsert_person_note', errored: true }],
  reply_preview: "I've noted that for you.",
  trace: {
    failed_assertions: ['args_valid: upsert_person_note args never validated (arg-spiral)'],
    reply: "I've noted that for you.",
    calls: to_trace_calls([
      { name: 'find_or_create_person', input: { name: 'Sam' }, result: { person_id: 'p_1' } },
      {
        name: 'upsert_person_note',
        input: { person: 'p_1', note: 'sister visiting in March' },
        error: 'INPUT_VALIDATION_FAILED: required field "person_id" missing',
        candidates: [],
      },
    ]),
  },
});

/* ================================================================== */
console.log('\nA. trace capture — failures keep the WHY, passes keep nothing');
/* ================================================================== */

{
  record_eval_result(db, failing_result(), 'live');
  const t = traces.latest_for_task(TASK.id);
  assert(t !== null, 'a failing run writes a trace');
  assert(
    JSON.stringify(t!.calls[1]!.input) === JSON.stringify({ person: 'p_1', note: 'sister visiting in March' }),
    'the ARGS the model actually produced are kept whole — that is usually the bug',
  );
  assert(t!.calls[1]!.error!.includes('person_id'), 'and the error naming the field it got wrong');
  assert(t!.failed_assertions[0]!.includes('arg-spiral'), 'the assertion failures are stored verbatim, not the model\'s account of itself');

  record_eval_result(
    db,
    { ...failing_result(), task_id: 'a-green-task', passed: true, detail: 'all assertions held' },
    'live',
  );
  assert(
    traces.latest_for_task('a-green-task') === null,
    'a PASSING run writes no trace — a green trace has no consumer and the table would grow by the whole suite nightly',
  );

  const crash: EvalResult = {
    ...failing_result(),
    task_id: 'crashed-task',
    detail: 'harness error: ENOENT',
    trace: { failed_assertions: ['harness error: ENOENT'], reply: '', calls: [] },
  };
  record_eval_result(db, crash, 'live');
  assert(traces.latest_for_task('crashed-task') !== null, 'a harness crash still records a trace so the row is not a hole');
}

/* ================================================================== */
console.log('\nB. evidence — the discriminating facts reach the prompt');
/* ================================================================== */

const tools = {
  get: (name: string) =>
    name === 'upsert_person_note'
      ? {
          name,
          description: 'Write a note onto a person record.',
          input_schema: { _def: {} },
        }
      : undefined,
} as unknown as ToolRegistry;

{
  const trace = traces.latest_for_task(TASK.id)!;
  const pack = gather_eval_evidence(TASK, trace, { db, tools });
  const text = render_eval_evidence(pack);
  assert(text.includes('"person":"p_1"'), 'the evidence carries the exact args the model produced');
  assert(text.includes('required field "person_id" missing'), 'and the exact error it got back');
  assert(text.includes('must produce VALID args for: upsert_person_note'), 'and what the task actually required');
  assert(
    text.includes('tool offered NO recovery hint'),
    'a tool that failed with no actionable next step is called out — that ABSENCE is itself the grounding_fix finding',
  );
  assert(pack.recent_failures >= 1, 'and how persistently this task has been failing');
}

/* ================================================================== */
console.log('\nC. LAYER ATTRIBUTION — the anti-hack guarantee');
/* ================================================================== */

const specialists = { get: () => ({ id: 'kate' }) } as unknown as SpecialistRegistry;

/** A model that proposes BOTH a real contract fix and a lazy persona line,
 *  rating the persona line HIGHER. The ranking must not believe it. */
const two_fix_model: CompleteRoleFn = async () =>
  JSON.stringify({
    root_cause:
      'upsert_person_note requires person_id but the model produced "person"; the call failed INPUT_VALIDATION_FAILED and the reply claimed success anyway.',
    confidence: 0.8,
    inconclusive: false,
    fixes: [
      {
        type: 'persona_tuning',
        title: 'Tell Kate to double-check argument names',
        detail: 'Add a persona line reminding her to check required fields before calling a tool.',
        target: 'config/specialists/kate.yaml',
        apply_via: 'manual',
        likelihood_to_resolve: 0.95,
        risk: 'low',
        reversibility: 'easy',
        blast_radius: 'contained',
        rationale: 'cheap',
      },
      {
        type: 'add_alias',
        title: 'Alias person → person_id on upsert_person_note',
        detail: 'Add "person" to the central FIELD_ALIASES map so the conventional name the model emits resolves.',
        target: 'upsert_person_note',
        apply_via: 'propose_code_edit',
        // ADVERSARIAL ON PURPOSE (2026-08-04). The original fixture rated this
        // low/easy — the ONE risk x reversibility cell where the old
        // multiplicative discount comfortably worked — so §C passed while the
        // guarantee it claimed did not hold. An audit showed that flipping this
        // single adjective to 'medium' inverted the headline assertion. It now
        // carries the WORST plausible rating for a real code fix, AND a lower
        // likelihood than the persona line, so the assertion below can only
        // pass on a structural layer order, never on a numeric margin.
        likelihood_to_resolve: 0.6,
        risk: 'medium',
        reversibility: 'moderate',
        blast_radius: 'service',
        rationale: 'the schema is the thing that is wrong',
      },
    ],
  });

// The fact critic is a filter here, not the thing under test — script it clean.
const clean_critic = (async () => ({ checked: true, unsupported: [] })) as never;

{
  const report = (await diagnose_eval_failure(TASK, {
    db,
    tools,
    specialists,
    complete_role_fn: two_fix_model,
    verify_fn: clean_critic,
  }))!;
  assert(report !== null, 'a failing task with a trace produces a report');
  assert(
    report.fixes[0]!.type === 'add_alias',
    'THE MECHANICAL FIX RANKS FIRST even though the model rated the persona line higher — a prompt tweak cannot fix a broken arg contract',
  );
  assert(
    report.fixes[0]!.score.confidence < report.fixes[1]!.score.confidence,
    'and it ranks first DESPITE scoring lower — the layer order is structural, not a numeric margin ' +
      '(the previous multiplicative discount lost this exact case)',
  );

  // The regression that the audit found: every risk x reversibility cell must
  // lose to layer order, not just the favourable one.
  for (const [risk, rev] of [['medium', 'moderate'], ['high', 'hard'], ['medium', 'hard']] as const) {
    const model: CompleteRoleFn = async () =>
      JSON.stringify({
        root_cause: 'upsert_person_note requires person_id but the model produced "person".',
        confidence: 0.8,
        inconclusive: false,
        fixes: [
          { type: 'persona_tuning', title: 'Just tell her to check', detail: 'Add a persona line about checking required fields.', target: 'kate', apply_via: 'manual', likelihood_to_resolve: 1.0, risk: 'low', reversibility: 'easy', blast_radius: 'contained', rationale: 'cheap and easily undone — an honest rating for a prompt line' },
          { type: 'add_alias', title: 'Alias person → person_id', detail: 'Add the alias to the central FIELD_ALIASES map.', target: 'upsert_person_note', apply_via: 'propose_code_edit', likelihood_to_resolve: 1.0, risk, reversibility: rev, blast_radius: 'service', rationale: 'the real fix' },
        ],
      });
    const r = (await diagnose_eval_failure(TASK, { db, tools, specialists, complete_role_fn: model, verify_fn: clean_critic }))!;
    assert(
      r.fixes[0]!.type === 'add_alias',
      `a mechanical fix rated ${risk}/${rev} still outranks a maximally-rated persona line`,
    );
  }

  // The labelling dodge: call a persona edit a code_change and point it at the
  // persona YAML. It must be re-typed, not waved through.
  const laundered: CompleteRoleFn = async () =>
    JSON.stringify({
      root_cause: 'Kate produced the wrong argument name for upsert_person_note.',
      confidence: 0.9,
      inconclusive: false,
      fixes: [
        { type: 'code_change', title: 'Append a reminder to the persona', detail: 'Append to Kate persona block: "Always re-read the tool schema before calling."', target: 'config/specialists/kate.yaml', apply_via: 'propose_code_edit', likelihood_to_resolve: 0.95, risk: 'low', reversibility: 'easy', blast_radius: 'contained', rationale: 'quick' },
        { type: 'add_alias', title: 'Alias person → person_id', detail: 'Add the alias to the central FIELD_ALIASES map.', target: 'upsert_person_note', apply_via: 'propose_code_edit', likelihood_to_resolve: 0.6, risk: 'medium', reversibility: 'moderate', blast_radius: 'service', rationale: 'the real fix' },
      ],
    });
  const lr = (await diagnose_eval_failure(TASK, { db, tools, specialists, complete_role_fn: laundered, verify_fn: clean_critic }))!;
  assert(
    lr.fixes.find((f) => f.target.includes('kate.yaml'))!.type === 'persona_tuning',
    'a persona edit LABELLED code_change is re-typed from its target — the taxonomy is not enforced on the model\'s word alone',
  );
  assert(
    lr.fixes[0]!.type === 'add_alias',
    'and having been re-typed, it drops below the real mechanical fix',
  );
  assert(report.fixes.every((f) => ['restart_service','apply_low_risk_fix','propose_code_edit','propose_code_change','manual','escalate'].includes(f.apply_via)), 'every fix names a gate that already exists — this module introduces no apply surface');

  const bad_gate: CompleteRoleFn = async () =>
    JSON.stringify({
      root_cause: 'the same arg mismatch on upsert_person_note',
      confidence: 0.7,
      inconclusive: false,
      fixes: [{ type: 'code_change', title: 'Just merge it', detail: 'Apply the change directly to main.', target: 'x', apply_via: 'auto_merge_to_main', likelihood_to_resolve: 0.9, risk: 'low', reversibility: 'easy', blast_radius: 'contained', rationale: 'fast' }],
    });
  const r2 = (await diagnose_eval_failure(TASK, { db, tools, specialists, complete_role_fn: bad_gate, verify_fn: clean_critic }))!;
  assert(
    r2.fixes[0]!.apply_via === 'escalate',
    'an invented apply gate falls to ESCALATE rather than being rewritten into a real one',
  );

  const garbled: CompleteRoleFn = async () => 'sorry, I could not parse that';
  assert(
    (await diagnose_eval_failure(TASK, { db, tools, specialists, complete_role_fn: garbled })) === null,
    'a garbled envelope diagnoses NOTHING — fail-closed, like every other proactive surface',
  );
  assert(
    (await diagnose_eval_failure(TASK, { db, tools, specialists, complete_role_fn: async () => null })) === null,
    'a model outage diagnoses nothing rather than guessing',
  );

  const crashed = { ...TASK, id: 'crashed-task' } as GoldenTask;
  assert(
    (await diagnose_eval_failure(crashed, { db, tools, specialists, complete_role_fn: two_fix_model, verify_fn: clean_critic })) === null,
    'a HARNESS CRASH is never diagnosed as a behavior defect — infrastructure is not persona',
  );
}

/* ================================================================== */
console.log('\nD. arming — dark, then diagnose, then file');
/* ================================================================== */

{
  assert(!eval_evolution_enabled(), 'unset means DARK — nothing runs');
  const dark = await run_eval_evolution_pass(
    { failing: [TASK.id], tasks: [TASK] },
    { db, tools, specialists, complete_role_fn: two_fix_model, verify_fn: clean_critic },
  );
  assert(dark.diagnosed === 0 && dark.filed.length === 0, 'a dark pass diagnoses nothing at all');

  process.env.HEARTH_EVAL_EVOLUTION = '1';
  assert(eval_evolution_enabled() && !eval_evolution_filing_armed(), 'the first rung diagnoses but does not file');

  const lines: string[] = [];
  const soak = await run_eval_evolution_pass(
    { failing: [TASK.id], tasks: [TASK], log: (l) => lines.push(l) },
    { db, tools, specialists, complete_role_fn: two_fix_model, verify_fn: clean_critic },
  );
  assert(soak.diagnosed === 1 && soak.filed.length === 0, 'the soak rung produces a report and files nothing');
  assert(
    lines.some((l) => l.includes('would have filed')),
    'and RECORDS what it would have filed — intended-vs-applied, the scored-week discipline',
  );

  const many = await run_eval_evolution_pass(
    { failing: ['t1', 't2', 't3', 't4', 't5'], tasks: [], log: (l) => lines.push(l) },
    { db, tools, specialists, complete_role_fn: two_fix_model, verify_fn: clean_critic },
  );
  assert(many.diagnosed === 0, 'unknown task ids diagnose nothing');
  assert(
    lines.some((l) => l.includes('left for the next run')),
    'the per-run cap is stated out loud — no silent truncation reading as full coverage',
  );
}

/* ================================================================== */
console.log('\nE. filing — Kate-gated, deduped, and refusable');
/* ================================================================== */

{
  const created: Array<{ kind: string; specialist_id: string; payload: unknown; signature: unknown }> = [];
  let dedup = false;
  const proposals = {
    create: (p: { kind: string; specialist_id: string; payload: unknown; signature: unknown }) => {
      created.push(p);
      return `prop_${created.length}`;
    },
    exists_for_signature: () => dedup,
    covered_for_signature: () => dedup,
  } as unknown as ProposalsStore;

  // §C's fixture deliberately rates its mechanical fix badly (medium/moderate
  // @0.6 → 0.33) to prove the layer order does not lean on a numeric margin.
  // That same rating is correctly BELOW the filing floor, so filing needs its
  // own fixture: a mechanical fix that genuinely earns the owner's queue.
  const filing_model: CompleteRoleFn = async () =>
    JSON.stringify({
      root_cause: 'upsert_person_note requires person_id but the model produced "person"; the call failed INPUT_VALIDATION_FAILED.',
      confidence: 0.85,
      inconclusive: false,
      fixes: [{
        type: 'add_alias',
        title: 'Alias person → person_id on upsert_person_note',
        detail: 'Add "person" to the central FIELD_ALIASES map so the conventional name resolves.',
        target: 'upsert_person_note',
        apply_via: 'propose_code_edit',
        likelihood_to_resolve: 0.85, risk: 'low', reversibility: 'easy', blast_radius: 'contained',
        rationale: 'the schema is the thing that is wrong, and an alias is trivially reversible',
      }],
    });

  const report = (await diagnose_eval_failure(TASK, {
    db, tools, specialists, complete_role_fn: filing_model, verify_fn: clean_critic,
  }))!;
  assert(report.fixes[0]!.score.confidence >= MIN_FILE_CONFIDENCE,
    'the filing fixture carries a fix that actually clears the floor');

  // The filing rung is now checked INSIDE file_eval_fix_proposal too, not only
  // in the pass — a caller reaching this directly must not file behind a dark
  // flag.
  delete process.env.HEARTH_EVAL_EVOLUTION_FILE;
  assert(file_eval_fix_proposal(report, { proposals }) === null,
    'filing refuses when its own arming rung is unset, even called directly');
  process.env.HEARTH_EVAL_EVOLUTION = '1';
  process.env.HEARTH_EVAL_EVOLUTION_FILE = '1';

  const id = file_eval_fix_proposal(report, { proposals });
  assert(id === 'prop_1', 'a confident, conclusive report files one proposal');
  assert(
    created[0]!.kind === 'recommendation' && created[0]!.specialist_id === 'trainer',
    'it files as a trainer RECOMMENDATION — a KATE_REVIEW_KIND, so it is born pending_kate_review and hidden from the owner queue',
  );
  assert(
    (created[0]!.signature as { anchor: string }).anchor === TASK.id,
    'anchored on the failing task so a task that stays red annotates one proposal instead of filing nightly',
  );

  dedup = true;
  assert(file_eval_fix_proposal(report, { proposals }) === null, 'an existing open proposal for the same signature blocks a second filing');
  dedup = false;

  // THE GAG BUG (2026-08-04, from the audit's unverified tail). The pass used
  // `exists_for_signature`, which has NO status filter — so one proposal, even
  // denied or expired months ago, silenced that task forever, under a log line
  // that falsely claimed an OPEN proposal covered it. A recurring eval failure
  // is precisely the signal that must be able to speak again when the fix
  // didn't work.
  {
    const pdb = open_db(join(dir, 'dedup.db'));
    const store = new ProposalsStore(pdb);
    const sig = { specialist_id: 'trainer', kind: 'eval_evolution', category: 'fix', anchor: 'gag-task' };
    const pid = store.create({
      specialist_id: 'trainer', kind: 'recommendation', execution_kind: 'manual',
      payload: {}, rationale: 'x'.repeat(50), signature: sig,
    });
    assert(store.covered_for_signature(sig), 'an open proposal covers the signature');
    pdb.prepare(`UPDATE proposals SET status = 'denied' WHERE id = ?`).run(pid);
    assert(store.exists_for_signature(sig), 'the OLD check still says "exists" for a denied proposal — forever');
    assert(store.covered_for_signature(sig), 'a just-denied proposal still holds the cooldown (no daily nagging)');
    const later = new Date(Date.now() + 15 * 86_400_000);
    assert(
      !store.covered_for_signature(sig, later),
      'but 15 days after a DENIED proposal the still-failing task can speak again — a cooldown, not a grave',
    );
    pdb.close();
  }

  assert(
    (created[0]!.signature as { category: string }).category === 'fix',
    "the signature category is a CONSTANT, not the LLM's volatile fix type — one task, one open proposal",
  );

  const weak: EvalDiagnosisReport = { ...report, confidence: MIN_FILE_CONFIDENCE - 0.01 };
  assert(file_eval_fix_proposal(weak, { proposals }) === null, 'a low-confidence read files NOTHING — the owner queue is the scarce resource');

  // The gate the audit found missing: a confident STORY carrying a worthless
  // FIX used to file, because only report.confidence was checked.
  const confident_story_weak_fix: EvalDiagnosisReport = {
    ...report,
    confidence: 0.95,
    fixes: [{ ...report.fixes[0]!, score: { ...report.fixes[0]!.score, confidence: 0.03 } }],
  };
  assert(
    file_eval_fix_proposal(confident_story_weak_fix, { proposals }) === null,
    'a confident narrative carrying a 0.03-scoring fix files NOTHING — the FIX is gated, not just the story',
  );

  const unsure: EvalDiagnosisReport = { ...report, inconclusive: true };
  assert(file_eval_fix_proposal(unsure, { proposals }) === null, 'an inconclusive read files nothing');

  assert(file_eval_fix_proposal(report, {}) === null, 'no proposals store wired → nothing filed, no throw');

  // The persona path still EXISTS — it is discounted, not banned. A genuine
  // voice failure must still be able to reach the right kind.
  const voice_only: CompleteRoleFn = async () =>
    JSON.stringify({
      root_cause: 'Kate answered correctly but in three bullets where one sentence would do.',
      confidence: 0.75,
      inconclusive: false,
      fixes: [{ type: 'persona_tuning', title: 'Loosen the structure', detail: 'One sentence first; structure only when asked.', target: 'kate', apply_via: 'manual', likelihood_to_resolve: 0.9, risk: 'low', reversibility: 'easy', blast_radius: 'contained', rationale: 'genuinely a voice issue' }],
    });
  const vr = (await diagnose_eval_failure(TASK, { db, tools, specialists, complete_role_fn: voice_only, verify_fn: clean_critic }))!;
  file_eval_fix_proposal(vr, { proposals });
  assert(
    created[1]!.kind === 'persona_tuning',
    'a genuine voice failure still routes to persona_tuning — the layer ranks LAST, it is not banned',
  );
  assert(
    (created[1]!.payload as { target_specialist_id: string }).target_specialist_id === 'kate',
    'and carries the payload shape that kind already expects',
  );
}

delete process.env.HEARTH_EVAL_EVOLUTION;
db.close();
rmSync(dir, { recursive: true, force: true });

console.log(failures === 0 ? '\nsmoke:eval-diagnosis OK' : `\nsmoke:eval-diagnosis FAILED (${failures})`);
process.exit(failures === 0 ? 0 : 1);
