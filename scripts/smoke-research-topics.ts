/**
 * smoke:research-topics — deep research on ANY subject, plus the three fixes
 * that were keeping it from working (2026-07-29).
 *
 * Why it exists: the deep-research spine has always accepted five subject
 * kinds, but only `person` ever had facet guidance, so `general`, `decision`,
 * and `place` fell through a bare "cover complementary facets" prompt and got
 * whatever the planner improvised. Every one of the eleven live investigations
 * was a person or a product. This smoke pins the shape of the fix end to end.
 *
 * What it covers, with everything external stubbed (no network, no live model —
 * do NOT set HEARTH_TEST_MODE; mocks are injected the way test-deep-research
 * does it):
 *
 *   1. The facet packs are exhaustive, distinct, and say what each kind needs.
 *   2. `think: false` survives a role default that turns thinking ON — the
 *      ordering defect. `...role.defaults` used to be spread AFTER `think`, so
 *      a config change could re-enable reasoning; the deep tier then returns
 *      EMPTY content and every JSON.parse in the runner fails into a fail-open
 *      catch. Sourceless dossier, no error, no log.
 *   3. A `general` open QUESTION runs end to end: the open-topic pack reaches
 *      the planner, the fan-out yields cited findings, the dossier shelves, and
 *      NO person-note writeback fires.
 *   4. A `decision` runs end to end and gets the options/criteria/tradeoffs pack.
 *   5. Status broadcasts carry the FILING specialist, not a hardcoded 'kate'.
 *   6. The cancel path: the route reaches `'cancelled'`, the runner honours it
 *      at a phase boundary mid-slice, a repeat cancel is idempotent, and a
 *      cross-user cancel 404s instead of confirming the row exists.
 *      Both TERMINAL writes are covered too — a cancel that lands during
 *      SYNTHESIS is not clobbered back to `done` (and the report-ready push +
 *      FYI are withheld), and an errored slice on a cancelled run does not
 *      relabel it `failed`. Plus the audit half: the route's
 *      `cancelled by <user> while <phase>` line survives every later write the
 *      slice makes, which is why `state.log` is store-owned and append-only.
 *   7. The Research Room pane tab composes from already-shipped block kinds
 *      only, previews reports via detail_md with no competing deep_link, keeps
 *      the per-requester cordon, and stamps `native: "research_room"` — and
 *      stays inside its WIRE BUDGET (8 rows × a 700-char excerpt, not 12 whole
 *      dossiers), asserted against a user with 14 oversized dossiers shelved.
 *   8. The "Needs you" recommendation read filters by kind in SQL, so a pile of
 *      unrelated pending cards can't starve the one real recommendation —
 *      asserted through the COMPOSED OFFICE (compose_recommendation_blocks),
 *      not only against the store it calls, and scoped to the office's own
 *      specialist.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { ulid } from 'ulid';
import { open_db } from '../src/memory/stores/structured';
import { MemoryClient } from '../src/memory/client';
import { SpecialistRegistry } from '../src/core/specialist';
import { load_extra_capabilities } from '../src/core/capabilities';
import { SpecialistInbox } from '../src/memory/stores/conversations';
import { AppEventBus, type AppEvent } from '../src/app/events';
import { ProposalsStore } from '../src/core/proposals';
import type { ToolContext } from '../src/core/tool';
import type { LLMRouter, LLMRequest } from '../src/core/llm';
import type { UserRegistry } from '../src/core/users';
import type { LibraryRoutesDeps } from '../src/app/routes/library';
import type { SpecialistRuntime } from '../src/core/specialist_runtime';
import type { ConversationStore } from '../src/memory/stores/conversations';
import type { FetchOutcome } from '../src/connectors/fetch_with_browser_fallback';
import type { FactCriticResult } from '../src/core/fact_critic';
import {
  ResearchInvestigationStore,
  type SubjectKind,
} from '../src/memory/stores/research_investigations';
import {
  advance_investigation,
  facet_guidance,
  type InvestigationRunnerDeps,
} from '../src/specialists/kate/research_investigation_runner';
import { make_deep_research } from '../src/specialists/kate/tools/deep_research';
import { create_research_router } from '../src/app/routes/research';
import { compose_research_room_tab } from '../src/core/research_pane';
import { compose_pane, type PaneDeps, type PaneBlock } from '../src/core/specialist_pane';
import { format_short_date } from '../src/core/time';
import type { LoadedSpecialist } from '../src/core/specialist';

let failures = 0;
function check(label: string, ok: boolean, extra?: string): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok || !extra ? '' : `  — ${extra}`}`);
  if (!ok) failures++;
}

/* ------------------------------------------------------------------ */
/* 1. Facet packs — data, exhaustive, one per kind                     */
/* ------------------------------------------------------------------ */

console.log('\n→ facet packs');
{
  const kinds: SubjectKind[] = ['person', 'product', 'place', 'decision', 'general'];
  const packs = kinds.map((k) => facet_guidance(k));
  check('every subject kind has a pack', packs.every((p) => p.length > 60));
  check('the packs are all distinct', new Set(packs).size === kinds.length);

  // The four that had NO guidance before this change are the point of it.
  check('product pack names independent testing over marketing', /independent/i.test(facet_guidance('product')) && /marketing/i.test(facet_guidance('product')));
  check('place pack anchors on the SPECIFIC place named', /specific/i.test(facet_guidance('place')) && /same-named/i.test(facet_guidance('place')));
  const dec = facet_guidance('decision');
  check('decision pack covers options', /OPTIONS/.test(dec));
  check('decision pack covers criteria', /CRITERIA/.test(dec));
  check('decision pack covers tradeoffs', /TRADEOFFS/.test(dec));
  check('decision pack refuses to pick for the user', /not to pick for them/i.test(dec));
  const gen = facet_guidance('general');
  check('general pack is shaped for an OPEN TOPIC or QUESTION', /OPEN TOPIC or QUESTION/.test(gen));
  check('general pack separates consensus from contested', /consensus/i.test(gen) && /DISAGREE/.test(gen));

  // The person pack is unchanged — the guardrail must survive the refactor.
  check('person pack keeps its privacy guardrail', /publicly published/.test(facet_guidance('person')));
}

/* ------------------------------------------------------------------ */
/* Harness                                                             */
/* ------------------------------------------------------------------ */

const dir = mkdtempSync(join(tmpdir(), 'hearth-research-topics-'));
const vault_root = join(dir, 'vault');
const db = open_db(join(dir, 'smoke.db'));
const memory = new MemoryClient({ vault_root, db });
const inbox = new SpecialistInbox(db);
const events = new AppEventBus();

load_extra_capabilities(join(import.meta.dir, '../config/capabilities.yaml'));

const spec_dir = join(dir, 'specialists');
mkdirSync(spec_dir, { recursive: true });
for (const [id, name] of [
  ['kate', 'Kate'],
  ['ruby', 'Ruby'],
] as const) {
  writeFileSync(
    join(spec_dir, `${id}.yaml`),
    `id: ${id}
name: ${name}
role: Fixture
voice: warm-direct
persona: |
  Test fixture persona for the research-topics smoke. Long enough to pass.
proactive:
  mode: reactive
capabilities:
  deep_research: true
`,
  );
}
writeFileSync(
  join(spec_dir, 'nocap.yaml'),
  'id: nocap\nname: NoCap\nrole: Fixture\nvoice: warm\npersona: |\n  Fixture without the research grant. Long enough to pass.\nproactive:\n  mode: reactive\n',
);
const specialists = new SpecialistRegistry(spec_dir);

/* ---- scripted LLM ------------------------------------------------- */
// `defaults` deliberately turns thinking ON and moves temperature, so the
// captured requests prove BOTH halves of the ordering contract: role defaults
// still win for everything, and `think` is forced OFF regardless.
const ROLE_DEFAULTS: Partial<LLMRequest> = { think: true, temperature: 0.9 };
const seen: Array<{ system: string; user: string; think: unknown; temperature: unknown }> = [];
/** Set to run a side effect (e.g. an out-of-band cancel) inside the planner. */
let during_plan: (() => void | Promise<void>) | null = null;
/** Same, but fired inside the SYNTHESIS call — the phase whose terminal `done`
 *  write used to clobber a cancel back out of the row. One-shot. */
let during_synthesis: (() => void | Promise<void>) | null = null;

const llm = {
  for_role: (_role: string) => ({
    provider: {
      complete: async (req: LLMRequest) => {
        const system = req.messages.find((m) => m.role === 'system')?.content ?? '';
        const user = req.messages.find((m) => m.role === 'user')?.content ?? '';
        seen.push({ system, user, think: req.think, temperature: req.temperature });

        if (system.includes('You plan a deep-research investigation')) {
          if (during_plan) {
            const fn = during_plan;
            during_plan = null;
            await fn();
          }
          return {
            content: JSON.stringify({
              sub_questions: [
                { question: 'What is the settled current state of the question?' },
                { question: 'Where do credible sources disagree, and why?' },
              ],
            }),
          };
        }
        if (system.includes('Give 2-3 web search queries')) {
          return { content: JSON.stringify({ queries: ['cold climate heat pump performance'] }) };
        }
        if (system.includes('You extract grounded findings')) {
          return {
            content: JSON.stringify({
              findings: [
                { text: 'Modern cold-climate heat pumps retain useful output near -15C.', source_indices: [1] },
              ],
            }),
          };
        }
        if (system.includes('You compose a cited deep-research dossier')) {
          if (during_synthesis) {
            const fn = during_synthesis;
            during_synthesis = null;
            await fn();
          }
          return {
            content:
              '# Deep research: do heat pumps work in a hard winter\n\n' +
              'Modern cold-climate units retain useful output near -15C. [S1]\n\n' +
              '## Sources\n[S1] Test source — https://hp.example/cold\n',
          };
        }
        return { content: '' };
      },
    },
    defaults: ROLE_DEFAULTS,
  }),
} as unknown as LLMRouter;

/* ---- scripted search + fetch + verifier ---------------------------- */
type SearchResp = { query: string; results: Array<{ title: string; url: string; snippet: string }>; error?: string };
/** One-shot side effect fired inside the fan-out's first search. */
let during_search: (() => void | Promise<void>) | null = null;
/** When true the search seam THROWS, which is how a real slice error gets out
 *  of `investigate_sub_question` (every LLM call in the runner is fail-open). */
let search_throws = false;
const search_fn = async (input: { query: string }): Promise<SearchResp> => {
  if (during_search) {
    const fn = during_search;
    during_search = null;
    await fn();
  }
  if (search_throws) throw new Error('search backend exploded');
  return {
    query: input.query,
    results: [{ title: 'Cold-climate heat pumps', url: 'https://hp.example/cold', snippet: 'field data' }],
  };
};
const page = `# Cold-climate heat pumps\n\n${'Field measurements show useful capacity well below freezing. '.repeat(6)}`;
const fetch_page_fn = async (url: string): Promise<FetchOutcome> => ({
  kind: 'firecrawl',
  markdown: page,
  title: 'Cold-climate heat pumps',
  source_url: url,
});
const verify_fn = async (): Promise<FactCriticResult> => ({ checked: true, unsupported: [] });

const users = {
  get: (id: string) =>
    id === 'sam' ? { id: 'sam', tier: 'household' } : id === 'jasper' ? { id: 'jasper', tier: 'owner' } : null,
  get_timezone: () => 'America/Denver',
} as unknown as UserRegistry;

const library_deps: LibraryRoutesDeps = {
  db,
  vault_root,
  memory,
  specialists,
  runtime: null as unknown as SpecialistRuntime,
  conversations: null as unknown as ConversationStore,
  llm: undefined,
  events,
};

const runner_deps: InvestigationRunnerDeps = {
  specialists,
  library_deps,
  llm,
  inbox,
  events,
  users,
  search_fn: search_fn as never,
  fetch_page_fn: fetch_page_fn as never,
  verify_fn: verify_fn as never,
};

const store = new ResearchInvestigationStore(db);
const deep_research = make_deep_research(runner_deps);
const owner_ctx: ToolContext = {
  memory,
  llm,
  now: new Date('2026-07-29T16:00:00Z'),
  intent_id: ulid(),
  specialist_id: 'kate',
  user: { id: 'jasper', tier: 'owner' },
};

const captured: AppEvent[] = [];
events.subscribe((e) => captured.push(e));

/* ------------------------------------------------------------------ */
/* 3. A general OPEN QUESTION, end to end                              */
/* ------------------------------------------------------------------ */

console.log('\n→ an open question runs end to end (subject_kind: general)');
{
  seen.length = 0;
  captured.length = 0;
  process.env.HEARTH_DEEP_RESEARCH = '0'; // file without the detached kick
  const filed = await deep_research.execute(
    {
      subject: 'whether heat pumps hold up in a hard winter',
      subject_kind: 'general',
      brief: 'we are deciding what to do about the furnace and I keep hearing both stories',
    },
    { ...owner_ctx, intent_id: ulid() },
  );
  delete process.env.HEARTH_DEEP_RESEARCH;
  const id = filed.investigation_id!;
  check('an open question files as an investigation', typeof id === 'string' && id.length > 0);

  const res = await advance_investigation(runner_deps, owner_ctx, id);
  const row = store.get(id)!;
  check('the open-question investigation completes', res.status === 'done' && row.status === 'done');

  const planner = seen.find((s) => s.system.includes('You plan a deep-research investigation'));
  check('the planner ran', planner !== undefined);
  check(
    'the planner received the OPEN TOPIC facet pack',
    (planner?.system ?? '').includes(facet_guidance('general')),
  );
  check(
    'and NOT the person pack',
    !(planner?.system ?? '').includes(facet_guidance('person')),
  );

  check('the fan-out produced one result per sub-question', row.findings.length === 2);
  check(
    'findings are cited into real sources',
    row.findings.every((f) =>
      f.findings.every((fi) => fi.source_indices.every((i) => i >= 1 && i <= f.sources.length)),
    ),
  );
  check('a dossier was composed', (row.dossier_md ?? '').includes('cold-climate'));
  check('the dossier shelved', row.dossier_note_path !== null);
  check(
    'NO person-note writeback for a non-person subject',
    row.person_id === null && memory.find_person({ name: 'whether heat pumps hold up in a hard winter' }) === null,
  );
}

/* ------------------------------------------------------------------ */
/* 2. think: false survives a think-ON role default                    */
/* ------------------------------------------------------------------ */

console.log('\n→ the think/spread ordering defect');
{
  check('at least one role call was made', seen.length >= 3);
  check(
    'EVERY runner LLM call forced think:false despite the role default',
    seen.every((s) => s.think === false),
    `saw: ${JSON.stringify(seen.map((s) => s.think))}`,
  );
  check(
    'the role default still wins for everything else (temperature)',
    seen.every((s) => s.temperature === ROLE_DEFAULTS.temperature),
  );
  check('the fixture default really is think:true (the test would be vacuous otherwise)', ROLE_DEFAULTS.think === true);
}

/* ------------------------------------------------------------------ */
/* 4. A decision, end to end                                           */
/* ------------------------------------------------------------------ */

console.log('\n→ a decision gets the options/criteria/tradeoffs pack');
{
  seen.length = 0;
  process.env.HEARTH_DEEP_RESEARCH = '0';
  const filed = await deep_research.execute(
    {
      subject: 'replace the furnace or add a heat pump',
      subject_kind: 'decision',
      brief: 'budget is around 12k and the furnace has one more winter in it',
    },
    { ...owner_ctx, intent_id: ulid() },
  );
  delete process.env.HEARTH_DEEP_RESEARCH;
  const res = await advance_investigation(runner_deps, owner_ctx, filed.investigation_id!);
  check('the decision investigation completes', res.status === 'done');
  const planner = seen.find((s) => s.system.includes('You plan a deep-research investigation'));
  check(
    'the planner received the DECISION facet pack',
    (planner?.system ?? '').includes(facet_guidance('decision')),
  );
}

/* ------------------------------------------------------------------ */
/* 5. Status broadcasts name the FILING specialist                     */
/* ------------------------------------------------------------------ */

console.log('\n→ progress broadcasts under the specialist that filed it');
{
  captured.length = 0;
  process.env.HEARTH_DEEP_RESEARCH = '0';
  const ruby_ctx: ToolContext = { ...owner_ctx, intent_id: ulid(), specialist_id: 'ruby' };
  const filed = await deep_research.execute(
    { subject: 'the district 1 seat', subject_kind: 'general', brief: 'who is running and on what' },
    ruby_ctx,
  );
  delete process.env.HEARTH_DEEP_RESEARCH;
  const id = filed.investigation_id!;
  check("the row records ruby as the filing agent", store.get(id)!.agent_id === 'ruby');

  await advance_investigation(runner_deps, ruby_ctx, id);
  const updates = captured.filter(
    (e): e is Extract<AppEvent, { type: 'research_investigation_updated' }> =>
      e.type === 'research_investigation_updated' && e.investigation_id === id,
  );
  check('status events were emitted', updates.length >= 4);
  check(
    "EVERY status event names ruby, not kate",
    updates.every((e) => e.specialist_id === 'ruby'),
    `saw: ${JSON.stringify([...new Set(updates.map((e) => e.specialist_id))])}`,
  );
  const fyi = captured.filter((e) => e.type === 'inbox_message_added');
  check(
    "the dossier-ready FYI goes to ruby's inbox, not kate's",
    fyi.length > 0 && fyi.every((e) => e.type === 'inbox_message_added' && e.to_specialist_id === 'ruby'),
  );
}

/* ------------------------------------------------------------------ */
/* 6. The cancel path                                                  */
/* ------------------------------------------------------------------ */

console.log('\n→ cancel');

let current_user: { id: string; tier: string } | null = { id: 'jasper', tier: 'owner' };
const app = new Hono();
app.use('*', async (ctx, next) => {
  if (current_user) ctx.set('user', current_user as never);
  await next();
});
app.route('/api/specialists', create_research_router({ db, specialists, events }));
const post = async (path: string) => {
  const res = await app.request(path, { method: 'POST' });
  return { status: res.status, body: (await res.json().catch(() => null)) as Record<string, unknown> | null };
};

{
  // A cancel that lands MID-SLICE, inside the plan phase. The runner must stop
  // at the next phase boundary rather than clobbering 'cancelled' with the next
  // running status and carrying on spending search + deep-tier budget.
  process.env.HEARTH_DEEP_RESEARCH = '0';
  const filed = await deep_research.execute(
    { subject: 'a subject nobody wants researched', subject_kind: 'general', brief: 'filed by mistake' },
    { ...owner_ctx, intent_id: ulid() },
  );
  delete process.env.HEARTH_DEEP_RESEARCH;
  const id = filed.investigation_id!;

  const cancel_call: { status: number; body: Record<string, unknown> | null } = { status: 0, body: null };
  during_plan = async () => {
    const r = await post(`/api/specialists/kate/research/${id}/cancel`);
    cancel_call.status = r.status;
    cancel_call.body = r.body;
  };
  const res = await advance_investigation(runner_deps, owner_ctx, id);

  check('the cancel route returns 200', cancel_call.status === 200);
  check(
    '…and reports cancelled',
    cancel_call.body?.cancelled === true && cancel_call.body?.status === 'cancelled',
  );
  const row = store.get(id)!;
  check('the row is cancelled', row.status === 'cancelled' && res.status === 'cancelled');
  check('the runner stopped at the phase boundary — no fan-out ran', row.findings.length === 0);
  check('…and no dossier was composed', row.dossier_md === null);
  check('the cancel is stamped terminal (completed_at)', row.completed_at !== null);
  check(
    'the run log records the stop',
    (row.state.log ?? []).some((l) => /^cancelled — stopping before /.test(l)),
    JSON.stringify(row.state.log),
  );
  // The AUDIT half, and the reason the log is store-owned: the route's line is
  // the only record of WHO stopped the run, and it is written while a slice is
  // mid-flight. The slice used to snapshot `state` at its start and write the
  // whole JSON column back on its next persist, deleting this line every time.
  check(
    'the "cancelled by <user> while <phase>" line SURVIVES the slice\'s later writes',
    (row.state.log ?? []).includes('cancelled by jasper while planning'),
    JSON.stringify(row.state.log),
  );
  check(
    'a cancelled status event reached the bus',
    captured.some(
      (e) => e.type === 'research_investigation_updated' && e.investigation_id === id && e.status === 'cancelled',
    ),
  );

  // A further advance must not resurrect it (the sweep + detached loop path).
  const again = await advance_investigation(runner_deps, owner_ctx, id);
  check('a later advance does not resurrect a cancelled run', again.status === 'cancelled' && again.progressed === false);

  // Idempotent repeat.
  const repeat = await post(`/api/specialists/kate/research/${id}/cancel`);
  check('a repeat cancel is idempotent (200, already cancelled)', repeat.status === 200 && repeat.body?.cancelled === true);

  // A finished run says so honestly instead of pretending to cancel.
  const done_row = store.list({ statuses: ['done'], limit: 1 })[0];
  if (done_row) {
    const term = await post(`/api/specialists/kate/research/${done_row.id}/cancel`);
    check(
      'cancelling a finished run is honest, not an error',
      term.status === 200 && term.body?.cancelled === false && term.body?.status === 'done',
    );
    check('…and it did not change the row', store.get(done_row.id)!.status === 'done');
  } else {
    check('a finished run exists to test the terminal path', false);
  }
}

{
  // A cancel that lands during SYNTHESIS — the phase whose terminal write used
  // to undo it. `synthesize_and_report` wrote `{state, status: 'done'}` straight
  // to the store, bypassing the guarded writer, so the route returned
  // `{cancelled: true}`, emitted a `cancelled` event, and then the finishing
  // slice flipped the row to `done` and pushed "your report is ready".
  process.env.HEARTH_DEEP_RESEARCH = '0';
  const filed = await deep_research.execute(
    { subject: 'stopped while it was being written up', subject_kind: 'general', brief: 'changed my mind late' },
    { ...owner_ctx, intent_id: ulid() },
  );
  delete process.env.HEARTH_DEEP_RESEARCH;
  const id = filed.investigation_id!;

  const mark = captured.length;
  // A holder rather than plain `let`s: the assignment happens inside the LLM
  // seam's callback, which the compiler can't see, so bare locals narrow to
  // `never` at the assertions below.
  const at_cancel: { body: Record<string, unknown> | null; log: string[] } = { body: null, log: [] };
  during_synthesis = async () => {
    const r = await post(`/api/specialists/kate/research/${id}/cancel`);
    at_cancel.body = r.body;
    at_cancel.log = store.get(id)!.state.log ?? [];
  };
  const res = await advance_investigation(runner_deps, owner_ctx, id);
  const row = store.get(id)!;
  const after = captured.slice(mark);

  check('the cancel landed while the run was synthesizing', at_cancel.body?.status === 'cancelled');
  check(
    '…and the route recorded the phase it interrupted',
    at_cancel.log.includes('cancelled by jasper while synthesizing'),
    JSON.stringify(at_cancel.log),
  );
  check(
    'a cancel during synthesis STAYS cancelled — the terminal write does not clobber it',
    row.status === 'cancelled' && res.status === 'cancelled',
    `row=${row.status} returned=${res.status}`,
  );
  check(
    'no "done" status event was broadcast for a cancelled run',
    !after.some(
      (e) => e.type === 'research_investigation_updated' && e.investigation_id === id && e.status === 'done',
    ),
    JSON.stringify(
      after
        .filter((e) => e.type === 'research_investigation_updated')
        .map((e) => (e as { status: string }).status),
    ),
  );
  check(
    'the report-ready FYI is NOT sent — nobody asked for the report any more',
    !after.some((e) => e.type === 'inbox_message_added'),
  );
  // The phase still FINISHES: the dossier is already paid for, so it is kept and
  // shelved (the office renders it) — the stop is at the boundary, not a
  // half-composed fragment thrown away.
  check('…but the composed dossier is kept', (row.dossier_md ?? '').includes('cold-climate'));
  check('…and stays shelved', row.dossier_note_path !== null);
  check(
    'the run log says it refused to mark the run done',
    (row.state.log ?? []).includes('cancelled — not marking done'),
    JSON.stringify(row.state.log),
  );
  check(
    'and the audit line survives here too',
    (row.state.log ?? []).includes('cancelled by jasper while synthesizing'),
    JSON.stringify(row.state.log),
  );
}

{
  // The OTHER terminal write: the error-streak `failed` stamp. A run the
  // requester already stopped must not be relabelled `failed` — that reads as
  // "Hearth broke" when what happened is "you cancelled it".
  process.env.HEARTH_DEEP_RESEARCH = '0';
  const filed = await deep_research.execute(
    { subject: 'stopped then the search broke', subject_kind: 'general', brief: 'two things at once' },
    { ...owner_ctx, intent_id: ulid() },
  );
  delete process.env.HEARTH_DEEP_RESEARCH;
  const id = filed.investigation_id!;
  // Two errored slices already on the record, so this slice's throw is the third
  // and trips MAX_ERROR_STREAK.
  store.set_error_streak(id, 2);
  store.update(id, {
    status: 'investigating',
    plan: { sub_questions: [{ id: 'sq_0', question: 'Q?' }] },
  });
  during_search = async () => {
    await post(`/api/specialists/kate/research/${id}/cancel`);
  };
  search_throws = true;
  const res = await advance_investigation(runner_deps, owner_ctx, id);
  search_throws = false;
  const row = store.get(id)!;
  check(
    'an errored slice on a cancelled run does not relabel it failed',
    row.status === 'cancelled' && res.status === 'cancelled',
    `row=${row.status} returned=${res.status}`,
  );
  check('…and the slice error is still recorded honestly', (row.error ?? '').includes('search backend exploded'));
  check(
    '…and the log carries both the error and who cancelled',
    (row.state.log ?? []).some((l) => /slice error \(3\/3\)/.test(l)) &&
      (row.state.log ?? []).includes('cancelled by jasper while investigating'),
    JSON.stringify(row.state.log),
  );
}

{
  // Gating is identical to the reads: unauth, no-capability, cross-user.
  const mine = store.create({
    subject: 'sam only', subject_kind: 'general', brief: 'b',
    requested_by: 'sam', agent_id: 'kate', private_to: 'sam',
  });
  current_user = { id: 'jasper', tier: 'owner' };
  check(
    "the owner cannot cancel a household member's run (404, no leak)",
    (await post(`/api/specialists/kate/research/${mine.id}/cancel`)).status === 404,
  );
  check('…and it is untouched', store.get(mine.id)!.status === 'pending');
  check(
    'a specialist without deep_research → 404',
    (await post(`/api/specialists/nocap/research/${mine.id}/cancel`)).status === 404,
  );
  current_user = null;
  check(
    'unauthenticated → 401',
    (await post(`/api/specialists/kate/research/${mine.id}/cancel`)).status === 401,
  );
  current_user = { id: 'sam', tier: 'household' };
  check(
    'the requester can cancel their own',
    (await post(`/api/specialists/kate/research/${mine.id}/cancel`)).status === 200 &&
      store.get(mine.id)!.status === 'cancelled',
  );
  current_user = { id: 'jasper', tier: 'owner' };
}

/* ------------------------------------------------------------------ */
/* 7. The Research Room pane tab                                       */
/* ------------------------------------------------------------------ */

console.log('\n→ the Research Room tab');
{
  // One in-flight run so the tab has both halves.
  const live = store.create({
    subject: 'the furnace question', subject_kind: 'general', brief: 'what to do before winter',
    requested_by: 'jasper', agent_id: 'kate', private_to: null,
  });
  store.update(live.id, {
    status: 'investigating',
    plan: { sub_questions: [{ id: 'sq_0', question: 'A?' }, { id: 'sq_1', question: 'B?' }] },
    findings: [
      {
        sub_question_id: 'sq_0', question: 'A?', status: 'ok',
        findings: [{ text: 'A finding.', source_indices: [1] }],
        sources: [{ url: 'https://x.example/a', title: 'A', fetched_ok: true }],
      },
    ],
  });
  store.append_log(live.id, 'planned 2 sub-question(s)', 'investigated 2 sub-question(s) — 1 finding(s)');

  const tab = compose_research_room_tab(db, { user_id: 'jasper', tier: 'owner' });
  check('the tab composes', tab !== null);
  if (tab) {
    check('id + label', tab.id === 'research' && tab.label === 'Research');
    check('blocks is always present (iOS Tab.blocks is non-optional)', Array.isArray(tab.blocks) && tab.blocks.length > 0);
    check('native activation switch is stamped from day one', tab.native === 'research_room');
    check('the badge counts in-flight runs', tab.badge === 1);

    // ONLY already-shipped block kinds — a new kind here blanks the whole pane
    // on every build in the field.
    const ALLOWED = new Set(['hero_metric', 'text', 'list', 'load_chart']);
    check(
      'every block is an already-proven kind',
      tab.blocks.every((b) => ALLOWED.has(b.type)),
      JSON.stringify([...new Set(tab.blocks.map((b) => b.type))]),
    );

    const hero = tab.blocks.find((b) => b.type === 'hero_metric');
    check('a hero_metric leads', hero !== undefined);
    if (hero && hero.type === 'hero_metric') {
      check('the hero counts the running investigations', hero.value === '1');
      check(
        'delta_kind stays inside the shipped enum',
        hero.delta_kind === undefined || ['up_good', 'down_good', 'neutral'].includes(hero.delta_kind),
      );
    }

    const lists = tab.blocks.filter((b): b is Extract<typeof b, { type: 'list' }> => b.type === 'list');
    const progress = lists.find((l) => l.title === 'In progress');
    check('an "In progress" list exists', progress !== undefined);
    check('…titled by subject', progress?.items[0]?.title === 'the furnace question');
    check(
      '…subtitled with the shared progress helpers (status + % + angles + findings)',
      /reading sources/.test(progress?.items[0]?.subtitle ?? '') &&
        /45%/.test(progress?.items[0]?.subtitle ?? '') &&
        /1\/2 angles/.test(progress?.items[0]?.subtitle ?? '') &&
        /1 finding/.test(progress?.items[0]?.subtitle ?? ''),
      progress?.items[0]?.subtitle,
    );

    const recent = lists.find((l) => l.title === 'Recent reports');
    check('a "Recent reports" list exists', recent !== undefined);
    check(
      '…inlines the dossier body as detail_md',
      (recent?.items ?? []).some((i) => (i.detail_md ?? '').includes('cold-climate')),
    );
    // The load-bearing iOS contract: detail_md and deep_link are mutually
    // exclusive (detail_md wins and kills the link), and no hearth:// route
    // exists for a dossier — so a row must never set both.
    check(
      'NO row sets deep_link alongside detail_md',
      lists.every((l) => l.items.every((i) => !(i.detail_md !== undefined && i.deep_link !== undefined))),
    );
    check(
      'in fact no row sets deep_link at all (Phase 1 inlines)',
      lists.every((l) => l.items.every((i) => i.deep_link === undefined)),
    );

    const chart = tab.blocks.find((b) => b.type === 'load_chart');
    if (chart && chart.type === 'load_chart') {
      check('chart kind stays inside the shipped enum', chart.kind === 'bars');
      check('chart height_hint stays inside the shipped enum', chart.height_hint === 'sm');
      check('chart counts this week\'s filings', chart.points.at(-1)!.y >= 3);
    } else {
      check('a cadence chart composed (enough rows exist)', false);
    }
  }

  // Cordon: a household member's own research is theirs; the owner has no
  // god-view, and vice versa.
  const sara_tab = compose_research_room_tab(db, { user_id: 'sam', tier: 'household' });
  const subjects_of = (t: ReturnType<typeof compose_research_room_tab>): string[] =>
    (t?.blocks ?? [])
      .filter((b): b is Extract<typeof b, { type: 'list' }> => b.type === 'list')
      .flatMap((l) => l.items.map((i) => i.title));
  check("the owner's tab excludes a household member's subject", !subjects_of(tab).includes('sam only'));
  check("the member's tab shows their own", subjects_of(sara_tab).includes('sam only'));
  check("…and excludes the owner's", !subjects_of(sara_tab).includes('the furnace question'));

  // No research at all → no tab, so Kate's office stays exactly as it was.
  check(
    'a user with no investigations gets no tab (office unchanged)',
    compose_research_room_tab(db, { user_id: 'nobody', tier: 'household' }) === null,
  );
}

/* ------------------------------------------------------------------ */
/* 7c. The tab's WIRE BUDGET                                           */
/* ------------------------------------------------------------------ */
// The briefing pane is composed on every office open, so whatever this tab
// costs is paid over the wire every time. The first cut inlined whole dossiers
// — 12 rows × an 8 000-char cap ≈ 96 KB of markdown per composition, to
// duplicate text the drill-in route and the shelved note already serve on
// demand. A list row is a preview: 8 rows × a 700-char excerpt. This block is
// isolated on its own user (14 heavy finished rows) so the cap can't be
// vacuously satisfied by a fixture that never reaches it.
console.log('\n→ the tab is a preview, not a payload');
{
  const heavy = `# A very long dossier\n\n${'Field measurements show useful capacity well below freezing. '.repeat(340)}`;
  check('the fixture dossier really is oversized (the cap would be vacuous otherwise)', heavy.length > 19_000);
  for (let i = 0; i < 14; i++) {
    const r = store.create({
      subject: `heavy subject ${i}`, subject_kind: 'general', brief: 'b',
      requested_by: 'bulk', agent_id: 'kate', private_to: 'bulk',
    });
    store.update(r.id, { status: 'done', dossier_md: heavy, dossier_note_path: `Knowledge/Kate/library/h${i}.md` });
  }
  const tab = compose_research_room_tab(db, { user_id: 'bulk', tier: 'household' });
  const rows = (tab?.blocks ?? [])
    .filter((b): b is Extract<PaneBlock, { type: 'list' }> => b.type === 'list')
    .flatMap((l) => l.items);
  check('the recent list is capped at 8 rows', rows.length === 8, `saw ${rows.length}`);
  check(
    'every row is an EXCERPT, not the dossier (≤ 800 chars incl. the marker)',
    rows.every((i) => (i.detail_md ?? '').length <= 800),
    JSON.stringify(rows.map((i) => (i.detail_md ?? '').length)),
  );
  check(
    '…and says so, so a reader knows there is more',
    rows.every((i) => /opening excerpt/.test(i.detail_md ?? '')),
  );
  check(
    '…cut on a boundary, not mid-word',
    rows.every((i) => /(freezing|\.)\s*\n\n_…opening excerpt/.test(i.detail_md ?? '')),
    (rows[0]?.detail_md ?? '').slice(-90),
  );
  const bytes = Buffer.byteLength(JSON.stringify(tab), 'utf8');
  console.log(`      (tab payload: ${bytes} bytes for 14 heavy dossiers on the shelf)`);
  check(
    'the whole tab stays under 12 KB (was ~96 KB of dossier alone)',
    bytes < 12_000,
    `${bytes} bytes`,
  );
}

/* ------------------------------------------------------------------ */
/* 7d. The idle hero names the newest COMPLETION                       */
/* ------------------------------------------------------------------ */
// `rows` is ordered created_at DESC, so the first finished row is the most
// recently FILED one — not the most recently COMPLETED one. A deep run filed on
// Monday can land after a quick one filed on Tuesday, and the hero read
// `finished[0].completed_at`, so the "newest" label could name a date that isn't.
console.log('\n→ the idle hero names the newest completion');
{
  const first_filed = store.create({
    subject: 'filed first, finished last', subject_kind: 'general', brief: 'the slow one',
    requested_by: 'lag', agent_id: 'kate', private_to: 'lag',
  });
  const last_filed = store.create({
    subject: 'filed last, finished first', subject_kind: 'general', brief: 'the quick one',
    requested_by: 'lag', agent_id: 'kate', private_to: 'lag',
  });
  store.update(first_filed.id, { status: 'done', dossier_md: '# Slow\n\nDone eventually.' });
  store.update(last_filed.id, { status: 'done', dossier_md: '# Quick\n\nDone fast.' });
  const stamp = db.prepare(
    `UPDATE research_investigations SET created_at = ?, completed_at = ? WHERE id = ?`,
  );
  const NEWEST_COMPLETION = '2026-07-28T00:00:00.000Z';
  stamp.run('2026-07-20T00:00:00.000Z', NEWEST_COMPLETION, first_filed.id);
  stamp.run('2026-07-21T00:00:00.000Z', '2026-07-22T00:00:00.000Z', last_filed.id);

  const tab = compose_research_room_tab(db, { user_id: 'lag', tier: 'household' });
  const hero = tab?.blocks.find((b) => b.type === 'hero_metric');
  const expected = format_short_date(NEWEST_COMPLETION);
  check(
    'the fixture really does invert filing order vs completion order',
    store.list_for_user({ user_id: 'lag', tier: 'household' })[0]?.id === last_filed.id,
  );
  check(
    'the idle hero counts the reports on the shelf',
    hero?.type === 'hero_metric' && hero.value === '2',
  );
  check(
    'the "newest" label names the newest COMPLETION, not the newest filing',
    hero?.type === 'hero_metric' && hero.delta === `newest ${expected}`,
    `${hero?.type === 'hero_metric' ? hero.delta : '—'} (expected "newest ${expected}")`,
  );
}

/* ------------------------------------------------------------------ */
/* 7b. …and it is actually INJECTED into Kate's office, by capability  */
/* ------------------------------------------------------------------ */

console.log('\n→ the tab reaches the office, gated on the capability');
{
  const pane_deps = { memory, vault_root } as unknown as PaneDeps;
  const granted = { id: 'kate', pane_kind: 'briefing', granted: new Set(['deep_research']) } as unknown as LoadedSpecialist;
  const ungranted = { id: 'kate', pane_kind: 'briefing', granted: new Set<string>() } as unknown as LoadedSpecialist;

  const tab_ids = async (spec: LoadedSpecialist): Promise<string[]> => {
    const doc = await compose_pane(spec, db, 'jasper', {
      ...pane_deps,
      viewer_is_owner: true,
      viewer_tier: 'owner',
    });
    const tabs = (doc?.blocks ?? []).find((b): b is Extract<PaneBlock, { type: 'tabs' }> => b.type === 'tabs');
    return (tabs?.tabs ?? []).map((t) => t.id);
  };

  const with_grant = await tab_ids(granted);
  check('the office is tabbed and Briefing stays first', with_grant[0] === 'briefing', JSON.stringify(with_grant));
  check('the Research tab is injected for a deep_research grantee', with_grant.includes('research'));
  const without = await tab_ids(ungranted);
  check(
    'a specialist WITHOUT the grant gets no Research tab (capability, not name)',
    !without.includes('research'),
    JSON.stringify(without),
  );
}

/* ------------------------------------------------------------------ */
/* 8. "Needs you" cannot be starved by unrelated pending cards         */
/* ------------------------------------------------------------------ */

console.log('\n→ the recommendation read filters by kind in SQL');
{
  const proposals = new ProposalsStore(db);
  // The real recommendation goes in FIRST, so it is the OLDEST row — exactly
  // the shape that broke: `list({limit: 10})` orders ts_created DESC, so a pile
  // of newer cards of another kind pushed it past the window and the JS
  // `.filter(kind === 'recommendation')` then found nothing.
  const rec_id = proposals.create({
    specialist_id: 'kate',
    kind: 'recommendation',
    execution_kind: 'manual',
    payload: { attempt_md: 'tried the obvious thing' },
    rationale: 'The one recommendation that actually needs him.',
    signature: { specialist_id: 'kate', kind: 'recommendation', category: 'household', anchor: 'furnace' },
  });
  for (let i = 0; i < 12; i++) {
    proposals.create({
      specialist_id: 'kate',
      kind: 'face_enrollment',
      execution_kind: 'manual',
      payload: { face_id: `f_${i}` },
      rationale: `Enroll face ${i}.`,
      signature: { specialist_id: 'kate', kind: 'face_enrollment', category: 'security', anchor: `face_${i}` },
    });
  }

  const kind_scoped = proposals.list({ status: 'pending', specialist_id: 'kate', kind: 'recommendation', limit: 10 });
  check('the SQL kind filter finds the recommendation', kind_scoped.some((r) => r.id === rec_id));

  // Prove the old shape really was starved, so this check can never pass for
  // the wrong reason.
  const old_shape = proposals
    .list({ status: 'pending', specialist_id: 'kate', limit: 10 })
    .filter((r) => r.kind === 'recommendation');
  check(
    'limit-then-filter (the old shape) would have rendered "Needs you" EMPTY',
    old_shape.length === 0,
    `old shape found ${old_shape.length}`,
  );

  // …and now the CHANGED CODE, not just the store it calls. Everything above is
  // a statement about ProposalsStore.list; the fix lives in
  // compose_recommendation_blocks, which is only reachable through the composed
  // office — so compose it and look for the card that used to go missing.
  const pane_deps = { memory, vault_root } as unknown as PaneDeps;
  const briefing_of = async (id: string): Promise<PaneBlock[]> => {
    const spec = { id, pane_kind: 'briefing', granted: new Set(['deep_research']) } as unknown as LoadedSpecialist;
    const doc = await compose_pane(spec, db, 'jasper', {
      ...pane_deps,
      viewer_is_owner: true,
      viewer_tier: 'owner',
    });
    const tabs = (doc?.blocks ?? []).find((b): b is Extract<PaneBlock, { type: 'tabs' }> => b.type === 'tabs');
    return (tabs?.tabs ?? []).find((t) => t.id === 'briefing')?.blocks ?? [];
  };

  const kate_briefing = await briefing_of('kate');
  const recs = kate_briefing.filter(
    (b): b is Extract<PaneBlock, { type: 'recommendation' }> => b.type === 'recommendation',
  );
  check(
    'the office renders the recommendation card 12 unrelated cards used to bury',
    recs.length === 1,
    `saw ${recs.length} recommendation block(s) in ${JSON.stringify(kate_briefing.map((b) => b.type))}`,
  );
  check(
    '…with her actual rationale, not a placeholder',
    /actually needs him/.test(JSON.stringify(recs[0] ?? {})),
  );
  check(
    '…under a "Needs you" heading',
    kate_briefing.some((b) => b.type === 'text' && /### Needs you/.test(b.body_md)),
  );
  // The other half of the same signature change: the read is scoped to the
  // office's OWN specialist, so another office does not surface Kate's card.
  const ruby_briefing = await briefing_of('ruby');
  check(
    "another specialist's office does not show Kate's recommendation",
    !ruby_briefing.some((b) => b.type === 'recommendation'),
    JSON.stringify(ruby_briefing.map((b) => b.type)),
  );
}

await specialists.close();
db.close();
rmSync(dir, { recursive: true, force: true });

console.log(failures === 0 ? '\nsmoke:research-topics OK' : `\nsmoke:research-topics FAILED (${failures} check(s))`);
process.exit(failures === 0 ? 0 : 1);
