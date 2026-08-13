/**
 * smoke:delegate — Kate sub-agents Phase 1 (docs/design-kate-subagents.md).
 *
 * Self-contained (temp db, scripted fake turn-runner, no LLM/network):
 *
 *   A. subagent_only flag — schema default false; a flagged YAML loads; a
 *      default_landing + subagent_only combo throws at dir load; the alias
 *      map and a roster-style filter exclude flagged profiles.
 *   B. DelegationStore — round-trip, complete/fail, list_recent cordon
 *      matrix (user sees own; system rows owner-only).
 *   C. DelegationRunner — quick success (digest inline, row done, NO inbox
 *      FYI), quick overrun → backgrounded (run continues, FYI + row done
 *      land later), background dispatch (FYI on completion), failure paths
 *      (throwing turn / empty digest → row failed + FAILED FYI), the
 *      Semaphore cap (max 1 ⇒ never 2 concurrent), and the user cordon
 *      (user threaded into the sub-turn, row.user_id + FYI
 *      originating_user_id stamped).
 *   D. delegate tool — kill switch, missing/unknown `to` → candidates
 *      recovery, missing task hint, self-delegation refusal, run-quick
 *      end-to-end digest, delegating TO a subagent_only profile works,
 *      status action + its cordon.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build_alias_map } from '@app/routes/relay';
import {
  DelegationRunner,
  _test_reset_pool,
  type DelegationRunnerDeps,
} from '@core/delegation';
import { load_specialists_dir } from '@core/specialist';
import type { SpecialistRegistry } from '@core/specialist';
import type { SpecialistTurnInput, SpecialistTurnOutput } from '@core/specialist_runtime';
import type { ToolDeps } from '@core/tool_deps';
import type { ToolContext } from '@core/tool';
import { SpecialistInbox } from '@memory/stores/conversations';
import { DelegationStore } from '@memory/stores/delegations';
import { open_db } from '@memory/stores/structured';
import { create as create_delegate_tool } from '../src/tools/delegate';

let failures = 0;
function assert(cond: unknown, msg: string): void {
  if (cond) console.log(`  ✓ ${msg}`);
  else {
    console.error(`  ✗ ${msg}`);
    failures++;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function turn_output(text: string): SpecialistTurnOutput {
  return {
    message_text: text,
    tool_calls_made: [],
    proposals_created: [],
    consulted_specialists: [],
    reasoning_trace: '',
    cost: { tokens_in: 0, tokens_out: 0, ms: 0, model: 'fake' },
  };
}

const tmp = mkdtempSync(join(tmpdir(), 'smoke-delegate-'));
const db = open_db(join(tmp, 'test.db'));
const store = new DelegationStore(db);
const inbox = new SpecialistInbox(db);

const audit_calls: Array<{ tool_name: string; user_id?: string }> = [];
const memory_fake = {
  log_action(record: { tool_name: string; user_id?: string }): string {
    audit_calls.push({ tool_name: record.tool_name, user_id: record.user_id });
    return 'audit_fake';
  },
};

const ROSTER = [
  { id: 'kate', name: 'Kate', role: 'Chief of Staff' },
  { id: 'vivian', name: 'Vivian', role: 'Finance Officer' },
  { id: 'iris', name: 'Iris', role: 'EV Specialist', subagent_only: true },
];
const specialists_fake = {
  get: (id: string) => ROSTER.find((s) => s.id === id) ?? null,
  resolve_id: (c: string) =>
    ROSTER.find((s) => s.id === c.toLowerCase() || s.name.toLowerCase() === c.toLowerCase())
      ?.id ?? null,
  list: () => ROSTER,
};

// ── A. subagent_only flag ────────────────────────────────────────────────────
console.log('A. subagent_only schema + filters');
{
  const dir = join(tmp, 'specialists-ok');
  mkdirSync(dir);
  const base = (id: string, extra: string) =>
    `id: ${id}\nname: ${id[0]!.toUpperCase()}${id.slice(1)}\nrole: Test ${id}\nvoice: warm\npersona: |\n  Test persona for ${id}.\nproactive:\n  mode: reactive\n${extra}`;
  writeFileSync(join(dir, 'alpha.yaml'), base('alpha', 'subagent_only: true\n'));
  writeFileSync(join(dir, 'beta.yaml'), base('beta', ''));
  const loaded = load_specialists_dir(dir);
  const alpha = loaded.find((s) => s.id === 'alpha')!;
  const beta = loaded.find((s) => s.id === 'beta')!;
  assert(alpha.subagent_only === true, 'subagent_only: true loads');
  assert(beta.subagent_only === false, 'subagent_only defaults false');

  const bad_dir = join(tmp, 'specialists-bad');
  mkdirSync(bad_dir);
  writeFileSync(
    join(bad_dir, 'gamma.yaml'),
    base('gamma', 'subagent_only: true\ndefault_landing: true\n'),
  );
  let threw = false;
  try {
    load_specialists_dir(bad_dir);
  } catch {
    threw = true;
  }
  assert(threw, 'default_landing + subagent_only throws at load');

  const alias_map = build_alias_map({
    list: () => [
      { id: 'kate', aliases: ['cos'], subagent_only: false },
      { id: 'iris', aliases: ['ev'], subagent_only: true },
    ],
  } as unknown as SpecialistRegistry);
  assert(alias_map['kate'] === 'kate' && alias_map['cos'] === 'kate', 'alias map keeps roster specialists');
  assert(!('iris' in alias_map) && !('ev' in alias_map), 'alias map hides subagent_only');
}

// ── B. DelegationStore ───────────────────────────────────────────────────────
console.log('B. DelegationStore');
{
  const row = store.create({
    requested_by: 'kate',
    profile_id: 'vivian',
    task: 'test task',
    mode: 'quick',
    user_id: 'jasper',
  });
  assert(row.id.startsWith('dg_') && row.status === 'running', 'create → running row with dg_ id');
  store.complete(row.id, 'the digest');
  assert(store.get(row.id)!.status === 'done' && store.get(row.id)!.digest_md === 'the digest', 'complete()');

  const frow = store.create({ requested_by: 'kate', profile_id: 'vivian', task: 't2', mode: 'background' });
  store.fail(frow.id, 'boom');
  assert(store.get(frow.id)!.status === 'failed' && store.get(frow.id)!.error === 'boom', 'fail()');

  store.create({ requested_by: 'kate', profile_id: 'vivian', task: 'sam task', mode: 'quick', user_id: 'sam' });
  const jasper_view = store.list_recent('kate', { user_id: 'jasper', is_owner: true });
  assert(
    jasper_view.some((r) => r.user_id === 'jasper') &&
      jasper_view.some((r) => r.user_id === null) &&
      !jasper_view.some((r) => r.user_id === 'sam'),
    'owner sees own + system rows, never another user',
  );
  const sara_view = store.list_recent('kate', { user_id: 'sam', is_owner: false });
  assert(
    sara_view.length === 1 && sara_view[0]!.user_id === 'sam',
    'non-owner sees only their own rows (no system rows)',
  );
}

// ── C. DelegationRunner ──────────────────────────────────────────────────────
console.log('C. DelegationRunner');

function make_runner(turn: (input: SpecialistTurnInput) => Promise<SpecialistTurnOutput>): {
  runner: DelegationRunner;
  turns: SpecialistTurnInput[];
} {
  const turns: SpecialistTurnInput[] = [];
  const deps: DelegationRunnerDeps = {
    runtime: {
      turn: async (input) => {
        turns.push(input);
        return turn(input);
      },
    },
    specialists: specialists_fake,
    store,
    inbox,
    memory: memory_fake,
  };
  return { runner: new DelegationRunner(deps), turns };
}

const fyis = () =>
  db
    .prepare(
      `SELECT from_specialist_id, to_specialist_id, body_md, originating_user_id
         FROM specialist_inboxes WHERE kind = 'fyi' ORDER BY ts`,
    )
    .all() as Array<{
    from_specialist_id: string;
    to_specialist_id: string;
    body_md: string;
    originating_user_id: string | null;
  }>;

{
  _test_reset_pool(2);
  process.env.HEARTH_DELEGATE_QUICK_TIMEOUT_MS = '60000';

  // C1: quick success — digest inline, no FYI.
  const { runner, turns } = make_runner(async () => turn_output('Vivian digest: all reconciled.'));
  const before_fyis = fyis().length;
  const res = await runner.run({
    requested_by: 'kate',
    profile_id: 'vivian',
    task: 'reconcile the June receipts',
    context: 'user asked in chat',
    mode: 'quick',
    user: { id: 'jasper', display_name: 'Jasper', tier: 'owner' },
    conversation_id: 'conv_1',
  });
  assert(res.outcome === 'done' && res.digest.includes('reconciled'), 'quick success returns digest inline');
  assert(fyis().length === before_fyis, 'quick success pushes NO inbox FYI');
  const row = store.get(res.delegation_id)!;
  assert(row.status === 'done' && row.user_id === 'jasper' && row.conversation_id === 'conv_1', 'row done + cordon stamped');
  const sub_turn = turns[0]!;
  assert(
    sub_turn.user?.id === 'jasper' &&
      sub_turn.specialist_id === 'vivian' &&
      sub_turn.message.from_specialist_id === 'kate' &&
      sub_turn.message.content.includes('reconcile the June receipts') &&
      sub_turn.message.content.includes('user asked in chat'),
    'sub-turn carries user cordon + framed task + context',
  );
  assert(
    audit_calls.some((a) => a.tool_name === 'delegate_dispatched') &&
      audit_calls.some((a) => a.tool_name === 'delegate_completed'),
    'dispatch + completion audited',
  );

  // C2: quick overrun → backgrounded, FYI lands after the run finishes.
  process.env.HEARTH_DELEGATE_QUICK_TIMEOUT_MS = '40';
  const slow = make_runner(async () => {
    await sleep(120);
    return turn_output('Late digest.');
  });
  const res2 = await slow.runner.run({
    requested_by: 'kate',
    profile_id: 'vivian',
    task: 'slow research task here',
    mode: 'quick',
    user: { id: 'sam', display_name: 'Sam', tier: 'household' },
  });
  assert(res2.outcome === 'backgrounded', 'quick overrun degrades to backgrounded');
  await sleep(200);
  const late_fyi = fyis().find((f) => f.body_md.includes('Late digest.'));
  assert(!!late_fyi && late_fyi.to_specialist_id === 'kate', 'overrun digest reports back via inbox FYI');
  assert(late_fyi!.originating_user_id === 'sam', 'FYI carries originating_user_id cordon');
  assert(store.get(res2.delegation_id)!.status === 'done', 'overrun row completes after the fact');
  process.env.HEARTH_DELEGATE_QUICK_TIMEOUT_MS = '60000';

  // C3: background dispatch.
  const bg = make_runner(async () => {
    await sleep(30);
    return turn_output('Background digest.');
  });
  const res3 = await bg.runner.run({
    requested_by: 'kate',
    profile_id: 'vivian',
    task: 'background task please',
    mode: 'background',
  });
  assert(res3.outcome === 'backgrounded', 'background returns immediately');
  await sleep(120);
  assert(
    fyis().some((f) => f.body_md.includes('Background digest.')),
    'background digest lands as FYI',
  );

  // C4: failure paths.
  const boom = make_runner(async () => {
    throw new Error('provider exploded');
  });
  const res4 = await boom.runner.run({
    requested_by: 'kate',
    profile_id: 'vivian',
    task: 'this one will fail',
    mode: 'quick',
  });
  assert(res4.outcome === 'failed' && res4.error.includes('exploded'), 'throwing turn → failed inline');
  assert(store.get(res4.delegation_id)!.status === 'failed', 'failure recorded on row');

  const empty = make_runner(async () => turn_output('   '));
  const res5 = await empty.runner.run({
    requested_by: 'kate',
    profile_id: 'vivian',
    task: 'produces no digest',
    mode: 'quick',
  });
  assert(res5.outcome === 'failed' && res5.error.includes('no digest'), 'empty digest → honest failure');

  const bgfail = make_runner(async () => {
    await sleep(20);
    throw new Error('late boom');
  });
  const res6 = await bgfail.runner.run({
    requested_by: 'kate',
    profile_id: 'vivian',
    task: 'background failure',
    mode: 'background',
  });
  await sleep(100);
  assert(
    fyis().some((f) => f.body_md.includes('FAILED') && f.body_md.includes('late boom')),
    'background failure reports back honestly',
  );
  assert(store.get(res6.delegation_id)!.status === 'failed', 'background failure recorded');

  // C5: semaphore cap — max 1 ⇒ second run queues (never 2 concurrent).
  _test_reset_pool(1);
  let concurrent = 0;
  let max_concurrent = 0;
  const capped = make_runner(async () => {
    concurrent++;
    max_concurrent = Math.max(max_concurrent, concurrent);
    await sleep(60);
    concurrent--;
    return turn_output('capped digest');
  });
  await Promise.all([
    capped.runner.run({ requested_by: 'kate', profile_id: 'vivian', task: 'parallel one', mode: 'background' }),
    capped.runner.run({ requested_by: 'kate', profile_id: 'vivian', task: 'parallel two', mode: 'background' }),
  ]);
  await sleep(250);
  assert(max_concurrent === 1, `semaphore caps concurrency (saw max ${max_concurrent})`);
  _test_reset_pool();
}

// ── D. delegate tool ─────────────────────────────────────────────────────────
console.log('D. delegate tool');
{
  const tool_deps = {
    db,
    runtime: { turn: async () => turn_output('Tool-path digest: done.') },
    specialists: specialists_fake,
    inbox,
    memory: memory_fake,
    users: { get: (id: string) => ({ id, display_name: id === 'jasper' ? 'Jasper' : 'Sam' }) },
  } as unknown as ToolDeps;
  const tool = create_delegate_tool(tool_deps);
  const ctx = (over: Partial<ToolContext> = {}): ToolContext =>
    ({
      memory: memory_fake,
      llm: null,
      now: new Date(),
      intent_id: 'i1',
      specialist_id: 'kate',
      conversation_id: 'conv_t',
      user: { id: 'jasper', tier: 'owner' },
      ...over,
    }) as unknown as ToolContext;
  const run = (input: Record<string, unknown>, c = ctx()) =>
    tool.execute(tool.input_schema.parse(input), c) as Promise<Record<string, any>>;

  process.env.HEARTH_DELEGATE = '0';
  const killed = await run({ to: 'vivian', task: 'a valid long task' });
  assert(killed.ok === false && String(killed.error).includes('disabled'), 'kill switch declines honestly');
  delete process.env.HEARTH_DELEGATE;

  const no_task = await run({ to: 'vivian' });
  assert(no_task.ok === false && String(no_task.next_action ?? '').includes('Re-call'), 'missing task → typed recovery');
  assert(
    Array.isArray(no_task.candidates) && no_task.candidates.length > 0,
    'missing task → candidates too (one retry has everything)',
  );

  // The real 2026-08-02 failure: both `to` and `task` dropped, the whole
  // instruction crammed into `context`. The generic "task is required" never
  // named the mistake, so the retry made it again.
  const mis_slotted = await run({ context: 'Golden eval redo: handle a read_note 404 by calling ha_get_state.' });
  assert(mis_slotted.ok === false, 'mis-slotted call is refused');
  assert(
    String(mis_slotted.error).includes('`context`') && String(mis_slotted.error).includes('`task`'),
    'mis-slotted call names the actual mistake, not just the missing field',
  );
  assert(
    Array.isArray(mis_slotted.candidates) && mis_slotted.candidates.length > 0,
    'mis-slotted call still carries the roster',
  );

  const no_to = await run({ task: 'a valid long task' });
  assert(no_to.ok === false && Array.isArray(no_to.candidates) && no_to.candidates.length > 0, 'missing to → candidates');

  const unknown = await run({ to: 'zelda', task: 'a valid long task' });
  assert(
    unknown.ok === false && unknown.candidates?.some((c: any) => c.id === 'vivian'),
    'unknown to → candidates recovery',
  );

  const self = await run({ to: 'kate', task: 'a valid long task' });
  assert(self.ok === false && String(self.error).includes('yourself'), 'self-delegation refused');
  assert(
    /do it now with your own tools/i.test(String(self.next_action ?? '')),
    'self-delegation steers to doing the work, not to another dispatch',
  );

  const ok = await run({ to: 'Vivian', task: 'reconcile everything please' });
  assert(ok.ok === true && ok.digest?.includes('Tool-path digest'), 'run quick end-to-end returns digest');
  assert(typeof ok.delegation_id === 'string', 'delegation id returned');

  const to_hidden = await run({ to: 'iris', task: 'plan the EV day for tomorrow' });
  assert(to_hidden.ok === true && to_hidden.specialist === 'iris', 'subagent_only profile is delegable');

  const status = await run({ action: 'status' });
  assert(
    status.ok === true && status.delegations.some((d: any) => d.task.includes('reconcile everything')),
    'status lists recent delegations',
  );
  const sara_status = await run(
    { action: 'status' },
    ctx({ user: { id: 'kim', tier: 'friend' } as ToolContext['user'] }),
  );
  assert(
    sara_status.ok === true &&
      !sara_status.delegations.some((d: any) => d.task.includes('reconcile everything')),
    'status cordons by calling user',
  );

  const one = await run({ action: 'status', delegation_id: ok.delegation_id });
  assert(one.ok === true && one.delegations?.[0]?.id === ok.delegation_id, 'status by id returns the row');
  const cross = await run(
    { action: 'status', delegation_id: ok.delegation_id },
    ctx({ user: { id: 'kim', tier: 'friend' } as ToolContext['user'] }),
  );
  assert(cross.ok === false, 'status by id 404-shapes across the cordon');
}

// ── E. live-subagents: SSE events + conversation report-back (2026-07-14) ───
console.log('E. live-subagents (events + report-back)');
{
  const events: Array<Record<string, unknown>> = [];
  const turns: SpecialistTurnInput[] = [];
  const deps: DelegationRunnerDeps = {
    runtime: {
      turn: async (input) => {
        turns.push(input);
        return turn_output('Background digest: research complete.');
      },
    },
    specialists: specialists_fake,
    store,
    inbox,
    memory: memory_fake,
    events: { emit: (e) => events.push(e as unknown as Record<string, unknown>) },
    db,
  };
  const live_runner = new DelegationRunner(deps);

  const report_rows = () =>
    db
      .prepare(
        `SELECT id, intent, context_json FROM scheduled_tasks
          WHERE idempotency_key LIKE 'delegation-report:%'`,
      )
      .all() as Array<{ id: string; intent: string; context_json: string }>;

  // E1: background run from a REAL conversation → events + report enqueued.
  const before = report_rows().length;
  const res = await live_runner.run({
    requested_by: 'kate',
    profile_id: 'vivian',
    task: 'research what a new tool would take',
    mode: 'background',
    user: { id: 'jasper', display_name: 'Jasper', tier: 'owner' },
    conversation_id: 'conv_live_1',
  });
  assert(res.outcome === 'backgrounded', 'E1 background dispatch returns immediately');
  await sleep(150); // let the detached run land
  assert(
    events.some(
      (e) => e.type === 'delegation_started' && e.conversation_id === 'conv_live_1',
    ),
    'delegation_started emitted with conversation_id',
  );
  assert(
    events.some((e) => e.type === 'delegation_completed' && e.ok === true),
    'delegation_completed ok:true emitted',
  );
  const rows = report_rows();
  assert(
    rows.length === before + 1 && rows.every((r) => r.intent === 'deliver_followup'),
    'background completion enqueues ONE deliver_followup report',
  );
  const report = rows
    .map((r) => JSON.parse(r.context_json).body)
    .find((b) => b.conversation_id === 'conv_live_1');
  assert(
    report != null &&
      report.specialist_id === 'kate' &&
      String(report.scope).includes('research complete'),
    'report fires as the REQUESTER in the originating conversation, digest in scope',
  );

  // E2: synthetic (colon) conversation contexts never enqueue a report —
  // a deliberation-launched delegation (e.g. a Vera critique) stays
  // inbox-only instead of spamming a nonexistent conversation.
  const before2 = report_rows().length;
  await live_runner.run({
    requested_by: 'kate',
    profile_id: 'vivian',
    task: 'critique change bchg_x adversarially',
    mode: 'background',
    user: { id: 'jasper', display_name: 'Jasper', tier: 'owner' },
    conversation_id: 'deliberation:kate:07:00',
  });
  await sleep(150);
  assert(report_rows().length === before2, 'deliberation-context delegation stays inbox-only');
}

db.close();
rmSync(tmp, { recursive: true, force: true });

if (failures > 0) {
  console.error(`\nsmoke:delegate FAILED — ${failures} assertion(s)`);
  process.exit(1);
}
console.log('\nsmoke:delegate PASSED');
// The DelegationRunner's background dispatch + module-level Semaphore pool leave
// the loop non-empty even after db.close(); a smoke must exit cleanly for the ring.
process.exit(0);
