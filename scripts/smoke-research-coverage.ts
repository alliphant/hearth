/**
 * smoke:research-coverage — the deep-research coverage ledger
 * (Deep Research v2 phase 2, 2026-07-29).
 *
 * The failure this replays. The owner asked for a workup with six facets: a
 * councilmember's record and stated reasons, an assessment of those reasons on
 * privacy and immigration data sharing, his re-election timing, what the city
 * charter requires for a recall, and the public case against a successor camera
 * vendor. What came back was a biography. FOUR facets were absent entirely —
 * the recall procedure, the successor-vendor case, the budget analysis, and the
 * subject's own stated reasoning — and the dossier read as though it were
 * complete. The cause was arithmetic (six facets, three fetches each, one of
 * them a JS-rendered municipal-code site), but the damage was that NOTHING
 * RECORDED THE LOSS: a facet nobody attempted looked exactly like a facet the
 * sources could not answer, and the reader had to notice an absence.
 *
 * So this pins, in order: the mapping from what an investigator returned to
 * what the ledger says; that a facet lost to the clock is `not_attempted`
 * (resumable) and NOT the same statement as `unanswerable`; that the dossier
 * OPENS with the ledger; that such an investigation is `incomplete`, not
 * `done`; that a resume re-runs ONLY the missing facets and keeps the answered
 * ones; and that it always converges rather than resuming forever.
 *
 * Self-contained: temp db + vault, scripted search/fetch/LLM/verifier seams
 * (no network, no live model — do NOT set HEARTH_TEST_MODE, which would can
 * the turns).
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ulid } from 'ulid';
import { open_db } from '../src/memory/stores/structured';
import { MemoryClient } from '../src/memory/client';
import { SpecialistRegistry } from '../src/core/specialist';
import { load_extra_capabilities } from '../src/core/capabilities';
import { SpecialistInbox } from '../src/memory/stores/conversations';
import { AppEventBus, type AppEvent } from '../src/app/events';
import type { ToolContext } from '../src/core/tool';
import type { LLMRouter } from '../src/core/llm';
import type { UserRegistry } from '../src/core/users';
import type { LibraryRoutesDeps } from '../src/app/routes/library';
import type { SpecialistRuntime } from '../src/core/specialist_runtime';
import type { ConversationStore } from '../src/memory/stores/conversations';
import type { FetchOutcome } from '../src/connectors/fetch_with_browser_fallback';
import type { FactCriticResult } from '../src/core/fact_critic';
import {
  ResearchInvestigationStore,
  OPEN_INVESTIGATION_STATUSES,
  type InvestigationPlan,
  type SubQuestionResult,
} from '../src/memory/stores/research_investigations';
import { ResearchSourcesStore } from '../src/memory/stores/research_sources';
import {
  compute_coverage,
  coverage_summary_line,
  coverage_tally,
  has_unattempted,
  prepend_coverage_section,
  render_coverage_section,
} from '../src/core/research_coverage';
import {
  advance_investigation,
  type InvestigationRunnerDeps,
} from '../src/specialists/kate/research_investigation_runner';
import { make_get_research_investigation } from '../src/specialists/kate/tools/get_research_investigation';

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    console.log(`  ✓ ${name}`);
    passed++;
  } else {
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
    failed++;
  }
}

/* ================================================================== */
/* A. Pure mapping — what the investigator returned → what we record   */
/* ================================================================== */

console.log('→ A. compute_coverage: the four states, and why they differ');

const SIX: InvestigationPlan = {
  sub_questions: [
    { id: 'sq_0', question: 'What is his voting record on the camera contract?' },
    { id: 'sq_1', question: 'What reasons has he stated publicly?' },
    { id: 'sq_2', question: 'What does the city charter require for a recall?' },
    { id: 'sq_3', question: 'When is his seat next up for election?' },
    { id: 'sq_4', question: 'What is the public case against the successor vendor?' },
    { id: 'sq_5', question: 'What does the police budget show?' },
  ],
};

function result(
  id: string,
  status: SubQuestionResult['status'],
  findings: number,
  sources: number,
  note?: string,
): SubQuestionResult {
  return {
    sub_question_id: id,
    question: SIX.sub_questions.find((q) => q.id === id)?.question ?? id,
    status,
    findings: Array.from({ length: findings }, (_, i) => ({ text: `finding ${i}`, source_indices: [1] })),
    sources: Array.from({ length: sources }, (_, i) => ({
      url: `https://s${i}.example`,
      title: `S${i}`,
      fetched_ok: true,
    })),
    ...(note !== undefined ? { note } : {}),
  };
}

{
  const ledger = compute_coverage(SIX, [
    result('sq_0', 'ok', 3, 3),
    result('sq_1', 'partial', 1, 2, 'some sources could not be read'),
    result('sq_2', 'not_attempted', 0, 0, 'slice deadline reached before this facet was attempted'),
    result('sq_3', 'failed', 0, 0, 'no sources could be read'),
    result('sq_4', 'ok', 0, 2, 'sources read but no grounded answer found'),
    // sq_5 has NO result at all — the fan-out never produced one.
  ]);
  const by = new Map(ledger.facets.map((f) => [f.sub_question_id, f]));
  check('every planned facet appears (none can vanish)', ledger.facets.length === 6);
  check('ok + findings → answered', by.get('sq_0')?.status === 'answered');
  check('partial + findings → partial', by.get('sq_1')?.status === 'partial');
  check('deadline-truncated → not_attempted (RESUMABLE)', by.get('sq_2')?.status === 'not_attempted');
  check('…and it carries the reason verbatim', /slice deadline/.test(by.get('sq_2')?.reason ?? ''));
  check('looked-and-failed → unanswerable (NOT the same statement)', by.get('sq_3')?.status === 'unanswerable');
  check('read sources but nothing grounded → unanswerable', by.get('sq_4')?.status === 'unanswerable');
  check('a missing result → not_attempted, never silently dropped', by.get('sq_5')?.status === 'not_attempted');
  check('counts ride along', by.get('sq_0')?.finding_count === 3 && by.get('sq_0')?.source_count === 3);
  check('answered facets need no excuse', by.get('sq_0')?.reason === undefined);

  const t = coverage_tally(ledger);
  check('tally', t.answered === 1 && t.partial === 1 && t.unanswerable === 2 && t.not_attempted === 2 && t.total === 6);
  check('has_unattempted is true', has_unattempted(ledger));
  check('summary names the shortfall', coverage_summary_line(ledger) === '1 of 6 facet(s) answered (1 partial, 2 unanswerable, 2 not attempted)', coverage_summary_line(ledger));
}

{
  const all_good = compute_coverage(SIX, SIX.sub_questions.map((q) => result(q.id, 'ok', 2, 2)));
  check('a fully answered plan has no gaps', !has_unattempted(all_good) && coverage_tally(all_good).answered === 6);
  check('…and says so plainly', coverage_summary_line(all_good) === '6 of 6 facet(s) answered');
  const empty = compute_coverage(null, []);
  check('no plan → empty ledger, no throw', empty.facets.length === 0 && coverage_summary_line(empty) === 'no facets planned');
}

/* ================================================================== */
/* B. The dossier OPENS with it                                        */
/* ================================================================== */

console.log('→ B. the reader cannot miss what was not established');
{
  const ledger = compute_coverage(SIX, [
    result('sq_0', 'ok', 3, 3),
    result('sq_2', 'not_attempted', 0, 0, 'slice deadline reached before this facet was attempted'),
  ]);
  const block = render_coverage_section(ledger);
  check('the block is a Coverage section', /^## Coverage$/m.test(block));
  check('an answered facet is marked answered', /answered.*voting record/i.test(block));
  check('the recall facet is marked NOT attempted', /not attempted.*charter require for a recall/i.test(block));
  check('an explicit INCOMPLETE warning is present', /INCOMPLETE/.test(block));
  check('the warning counts the gaps', /5 facet\(s\) were never attempted/.test(block), block);

  const dossier =
    '# Deep research: Chris Barrett\n\n**Brief:** record, recall, successor vendor\n\n' +
    'He is a teacher and co-founder. [S1]\n';
  const out = prepend_coverage_section(dossier, ledger);
  const lines = out.split('\n').filter((l) => l.trim() !== '');
  check('the H1 still comes first (it identifies the report)', lines[0]?.startsWith('# Deep research') === true);
  check('the Brief line stays with the title', lines[1]?.startsWith('**Brief:**') === true);
  check('coverage comes BEFORE any findings', out.indexOf('## Coverage') < out.indexOf('He is a teacher'));
  check('the body is untouched', out.includes('He is a teacher and co-founder. [S1]'));
  check(
    'a dossier with no H1 gets the ledger at the very top',
    prepend_coverage_section('Some prose.\n', ledger).trimStart().startsWith('## Coverage'),
  );
  check('re-synthesis does not stack two ledgers', (() => {
    const twice = prepend_coverage_section(out, ledger);
    return (twice.match(/## Coverage/g) ?? []).length === 1;
  })());
  check('an empty ledger changes nothing', prepend_coverage_section(dossier, { facets: [] }) === dossier);
  check('a null ledger changes nothing', prepend_coverage_section(dossier, null) === dossier);
}

/* ================================================================== */
/* C. End-to-end: incomplete → resume → converge (the real runner)     */
/* ================================================================== */

console.log('→ C. the lifecycle, driven through the real runner');

const dir = mkdtempSync(join(tmpdir(), 'hearth-research-coverage-'));
const vault_root = join(dir, 'vault');
const db = open_db(join(dir, 'smoke.db'));
const memory = new MemoryClient({ vault_root, db });
const inbox = new SpecialistInbox(db);
const events = new AppEventBus();
load_extra_capabilities(join(import.meta.dir, '../config/capabilities.yaml'));

const spec_dir = join(dir, 'specialists');
mkdirSync(spec_dir, { recursive: true });
writeFileSync(
  join(spec_dir, 'kate.yaml'),
  `id: kate
name: Kate
role: Chief of Staff
voice: warm-direct
persona: |
  Test fixture persona for the deep-research coverage smoke. Long enough to pass.
proactive:
  mode: reactive
capabilities:
  deep_research: true
`,
);
const specialists = new SpecialistRegistry(spec_dir);

/**
 * The scripted world: three facets, all answerable from readable pages. The
 * failure is reproduced with the CLOCK — which is what actually happened. When
 * `charter_renders` is false the municipal-code portal never renders, which is
 * the separate "looked, cannot read it" case that must NOT trigger a resume.
 */
let charter_renders = true;
const CHARTER_URL = 'https://library.municode.example/charter';

const llm = {
  for_role: (_role: string) => ({
    provider: {
      complete: async (req: { messages: Array<{ role: string; content: string }> }) => {
        const system = req.messages.find((m) => m.role === 'system')?.content ?? '';
        const user = req.messages.find((m) => m.role === 'user')?.content ?? '';
        if (system.includes('You plan a deep-research investigation')) {
          return {
            content: JSON.stringify({
              sub_questions: [
                { question: 'What is his voting record on the camera contract?' },
                { question: 'What does the city charter require for a recall?' },
                { question: 'What is the public case against the successor vendor?' },
              ],
            }),
          };
        }
        if (system.includes('Give 2-3 web search queries')) {
          if (user.includes('recall')) return { content: JSON.stringify({ queries: ['fort collins charter recall'] }) };
          if (user.includes('successor vendor')) return { content: JSON.stringify({ queries: ['successor camera vendor'] }) };
          return { content: JSON.stringify({ queries: ['conway camera contract vote'] }) };
        }
        if (system.includes('You extract grounded findings')) {
          if (user.includes('recall')) {
            return {
              content: JSON.stringify({
                findings: [{ text: 'A recall petition needs signatures equal to 25% of votes cast.', source_indices: [1] }],
              }),
            };
          }
          if (user.includes('successor vendor')) {
            return {
              content: JSON.stringify({
                findings: [{ text: 'The successor vendor shares plate data with federal partners.', source_indices: [1] }],
              }),
            };
          }
          return {
            content: JSON.stringify({
              findings: [{ text: 'Council voted 6-1 on June 16, 2026 to end the contract.', source_indices: [1] }],
            }),
          };
        }
        if (system.includes('You compose a cited deep-research dossier')) {
          // Deliberately writes NO coverage section — the runner must add it.
          return {
            content:
              '# Deep research: Chris Barrett\n\nCouncil voted 6-1 on June 16, 2026 to end the contract. [S1]\n\n' +
              '## Sources\n[S1] Herald — https://news.example/vote\n',
          };
        }
        return { content: '' };
      },
    },
    defaults: {},
  }),
} as unknown as LLMRouter;

type SearchResp = { query: string; results: Array<{ title: string; url: string; snippet: string }>; error?: string };
const search_fn = async (input: { query: string }): Promise<SearchResp> => {
  if (input.query.includes('recall')) {
    return { query: input.query, results: [{ title: 'City Charter Article IX', url: CHARTER_URL, snippet: 'recall' }] };
  }
  if (input.query.includes('successor')) {
    return { query: input.query, results: [{ title: 'Vendor review', url: 'https://news.example/vendor', snippet: 'vendor' }] };
  }
  return { query: input.query, results: [{ title: 'Council ends contract', url: 'https://news.example/vote', snippet: 'vote' }] };
};

const BODY_VOTE =
  '# Council ends camera contract\n\nPublished June 17, 2026\n\n' +
  'Council voted 6-1 on June 16, 2026 to terminate the surveillance-camera contract. '.repeat(4);
const BODY_CHARTER =
  '# Article IX — Recall\n\nPublished July 12, 2026\n\n' +
  'A recall petition must be signed by electors equal to twenty-five percent of votes cast. '.repeat(4);
const BODY_VENDOR =
  '# Vendor review\n\nPublished July 20, 2026\n\n' +
  'The successor vendor shares plate data with federal partners under a standing agreement. '.repeat(4);

const fetch_page_fn = async (url: string): Promise<FetchOutcome> => {
  if (url === CHARTER_URL && !charter_renders) {
    // A JS-rendered municipal-code portal that will never render for this
    // fetcher. Permanently unreadable — not a resumable state.
    return { kind: 'failed', reason: 'page did not render', source_url: url };
  }
  const markdown = url === CHARTER_URL ? BODY_CHARTER : url.includes('vendor') ? BODY_VENDOR : BODY_VOTE;
  const title = url === CHARTER_URL ? 'Article IX — Recall' : url.includes('vendor') ? 'Vendor review' : 'Council ends contract';
  return { kind: 'firecrawl', markdown, title, source_url: url };
};

const verify_fn = async (): Promise<FactCriticResult> => ({ checked: true, unsupported: [] });

const users = {
  get: (id: string) => (id === 'jasper' ? { id: 'jasper', tier: 'owner' } : null),
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
const sources = new ResearchSourcesStore(db);
const ctx: ToolContext = {
  memory,
  llm,
  now: new Date('2026-07-29T16:00:00Z'),
  intent_id: ulid(),
  specialist_id: 'kate',
  user: { id: 'jasper', tier: 'owner' },
};

const captured: AppEvent[] = [];
events.subscribe((e) => captured.push(e));

const row = store.create({
  subject: 'Chris Barrett',
  subject_kind: 'general',
  brief: 'his record, the recall procedure, and the case against the successor vendor',
  requested_by: 'jasper',
  agent_id: 'kate',
  private_to: 'jasper',
});

/* ---- pass 1: the CLOCK runs out — the actual F1 cause ------------- */
{
  // A deadline already IN THE PAST reproduces the failure deterministically:
  // the fan-out has no clock left when the facets come up. (A tiny positive
  // budget is flaky — the scripted seams return instantly, so the first
  // facets can finish inside 1ms.) Before the ledger, each of these returned
  // `failed` / "no sources could be read" and the dossier shipped reading as
  // though the web simply had nothing to say.
  let res = await advance_investigation(runner_deps, ctx, row.id, { deadline_ms: -1 });
  for (let i = 0; i < 5 && res.status !== 'incomplete' && res.status !== 'done'; i++) {
    res = await advance_investigation(runner_deps, ctx, row.id, { deadline_ms: -1 });
  }
  const after = store.get(row.id)!;
  check('a facet lost to the clock leaves the run INCOMPLETE, not done', after.status === 'incomplete', after.status);
  check('completed_at is NOT stamped on an incomplete run', after.completed_at === null);
  const t = coverage_tally(after.coverage);
  check('all three facets are recorded as not attempted', t.not_attempted === 3, JSON.stringify(t));
  check(
    'the reason says the clock, not "the web had nothing"',
    /deadline/.test((after.coverage?.facets ?? [])[0]?.reason ?? ''),
    (after.coverage?.facets ?? [])[0]?.reason,
  );
  check('every planned facet is on the ledger — none vanished', (after.coverage?.facets ?? []).length === 3);
  check('a partial dossier exists and OPENS with the ledger', (after.dossier_md ?? '').includes('## Coverage'));
  check('…and the dossier states it is INCOMPLETE', /INCOMPLETE/.test(after.dossier_md ?? ''));
  check('an SSE event announced the incomplete status', captured.some((e) => e.type === 'research_investigation_updated' && e.status === 'incomplete'));
  check('nothing was shelved yet (a partial is not the finished article)', after.dossier_note_path === null);
  check('no "report is ready" FYI yet', inbox.unactioned_for('kate').length === 0);
}

/* ---- the read tool is honest about the gap ------------------------ */
{
  const get_tool = make_get_research_investigation(runner_deps);
  const out = await get_tool.execute({ investigation_id: row.id }, ctx);
  check('get_research_investigation hands back the partial dossier', (out.dossier_md ?? '').includes('## Coverage'));
  check('…with the coverage ledger', (out.coverage ?? []).length === 3);
  check('…and a summary line', (out.coverage_summary ?? '').includes('of 3 facet(s) answered'));
  check('…and steers Kate to say it is incomplete', /incomplete/i.test(out.next_action));
}

/* ---- pass 2: given time, the resume finishes the job -------------- */
{
  let res = await advance_investigation(runner_deps, ctx, row.id);
  for (let i = 0; i < 5 && res.status !== 'done'; i++) {
    res = await advance_investigation(runner_deps, ctx, row.id);
  }
  const after = store.get(row.id)!;
  check('the resume reaches done', after.status === 'done', after.status);
  check('completed_at is stamped', after.completed_at !== null);
  const t = coverage_tally(after.coverage);
  check('all three facets are now answered', t.answered === 3 && t.not_attempted === 0, JSON.stringify(t));
  check('the recall facet — the one that went missing live — has a finding', (after.findings.find((f) => /recall/.test(f.question))?.findings.length ?? 0) > 0);
  check('the finished dossier still opens with the ledger', (after.dossier_md ?? '').includes('## Coverage'));
  check('…and no longer warns INCOMPLETE', !/INCOMPLETE/.test(after.dossier_md ?? ''));
  check('NOW it is shelved', after.dossier_note_path !== null);
  check('…and Kate got exactly one ready FYI', inbox.unactioned_for('kate').length === 1);
  check(
    '…whose body states the coverage',
    /Coverage: 3 of 3/.test(inbox.unactioned_for('kate')[0]?.body_md ?? ''),
  );

  // Phase 1 keystone, proven through the REAL runner: the bodies are on disk.
  const bodies = sources.list_for_investigation(row.id);
  check('source bodies were PERSISTED by the run', bodies.length === 3, `${bodies.length}`);
  check('a body holds the SOURCE text, not the finding text', bodies.some((b) => b.body_md.includes('terminate the surveillance-camera contract')));
  check(
    'the verifier now has a corpus that is not its own output',
    bodies.some((b) => b.body_md.includes('twenty-five percent of votes cast')),
  );
  check("each page's own publication date was captured", bodies.some((b) => b.published_at === '2026-06-17') && bodies.some((b) => b.published_at === '2026-07-12'));
  check('bodies carry the investigation cordon', bodies.every((b) => b.private_to === 'jasper'));
  check('the publisher is recorded per source', bodies.some((b) => b.publisher === 'library.municode.example'));
  check('a re-read across the resume did not duplicate bodies', new Set(bodies.map((b) => b.url)).size === bodies.length);
}

/* ---- a permanently unreadable source is NOT a resumable state ----- */
{
  charter_renders = false;
  const unreadable = store.create({
    subject: 'Unreadable Portal Subject',
    subject_kind: 'general',
    brief: 'a facet behind a portal that never renders',
    requested_by: 'jasper',
    agent_id: 'kate',
    private_to: 'jasper',
  });
  let res = await advance_investigation(runner_deps, ctx, unreadable.id);
  let slices = 1;
  for (; slices < 10 && res.status !== 'done' && res.status !== 'failed'; slices++) {
    res = await advance_investigation(runner_deps, ctx, unreadable.id);
  }
  const after = store.get(unreadable.id)!;
  check('a looked-at-but-unreadable facet goes straight to done', after.status === 'done', after.status);
  check('…without spending a resume attempt on it', (after.state.resume_attempts ?? 0) === 0);
  const facet = (after.coverage?.facets ?? []).find((f) => /recall/.test(f.question));
  check('…and is recorded UNANSWERABLE with the real reason', facet?.status === 'unanswerable' && /no sources could be read/.test(facet?.reason ?? ''), `${facet?.status}: ${facet?.reason}`);
  check('the other two facets still answered', coverage_tally(after.coverage).answered === 2);
  check('the dossier reports the shortfall', /⛔/.test(after.dossier_md ?? ''));
  charter_renders = true;
}

/* ---- the merge seam: a cancel must beat a RESUME ------------------- */
// `incomplete` is an OPEN status, so it is cancellable — a combination neither
// the coverage ledger nor the cancel verb was written against (they landed the
// same day, from different branches). The runner's guarded `set_status` is what
// makes it safe: without it, a resume slice would write `investigating` over a
// landed cancel and the sweep would keep reviving a run the requester stopped.
console.log('→ D. a cancel beats a resume (the two same-day branches meeting)');
{
  const stopped = store.create({
    subject: 'Cancelled Mid-Resume Subject',
    subject_kind: 'general',
    brief: 'an investigation the requester stops while it is incomplete',
    requested_by: 'jasper',
    agent_id: 'kate',
    private_to: 'jasper',
  });
  // Starve it to `incomplete`.
  let res = await advance_investigation(runner_deps, ctx, stopped.id, { deadline_ms: -1 });
  for (let i = 0; i < 5 && res.status !== 'incomplete'; i++) {
    res = await advance_investigation(runner_deps, ctx, stopped.id, { deadline_ms: -1 });
  }
  check('the run reached the cancellable incomplete state', store.get(stopped.id)!.status === 'incomplete', res.status);

  // Out-of-band cancel, exactly as POST …/research/:rid/cancel writes it.
  store.update(stopped.id, { status: 'cancelled' });
  const findings_before = JSON.stringify(store.get(stopped.id)!.findings);

  // Now give it a full clock. A resume must NOT revive it.
  const after_res = await advance_investigation(runner_deps, ctx, stopped.id);
  const after = store.get(stopped.id)!;
  check('a cancelled investigation is not resumed', after.status === 'cancelled', after.status);
  check('…and the advance reports it made no progress', after_res.progressed === false);
  check('…and did no further investigating', JSON.stringify(after.findings) === findings_before);
  check(
    '…and fetched no new source bodies',
    sources.list_for_investigation(stopped.id).length === 0,
  );
  check(
    '…and the sweep will not list it again',
    store.list({ statuses: OPEN_INVESTIGATION_STATUSES, limit: 200 }).every((r) => r.id !== stopped.id),
  );
}

/* ---- convergence: a facet the clock never reaches must not resume
        forever — past the cap it becomes an honest unanswerable ------ */
{
  const starved = store.create({
    subject: 'Starved Subject',
    subject_kind: 'general',
    brief: 'an investigation that never gets any clock',
    requested_by: 'jasper',
    agent_id: 'kate',
    private_to: 'jasper',
  });
  let slices = 0;
  let status = '';
  for (; slices < 20; slices++) {
    const res = await advance_investigation(runner_deps, ctx, starved.id, { deadline_ms: -1 });
    status = res.status;
    if (status === 'done' || status === 'failed') break;
    if (!res.progressed) break;
  }
  const after = store.get(starved.id)!;
  check('a permanently starved investigation still converges to done', after.status === 'done', `${after.status} after ${slices + 1} slice(s)`);
  check('it did not loop forever', slices < 12, `${slices} slices`);
  const t = coverage_tally(after.coverage);
  check('no facet is left in the open not_attempted state', t.not_attempted === 0, JSON.stringify(t));
  const facet = (after.coverage?.facets ?? [])[0];
  check('the leftover is recorded UNANSWERABLE', facet?.status === 'unanswerable', facet?.status);
  check('…with an honest reason naming the budget', /budget/.test(facet?.reason ?? ''), facet?.reason);
  check('…that preserves the last state it was in', /deadline/.test(facet?.reason ?? ''), facet?.reason);
  check('the resume attempts were bounded at 2', (after.state.resume_attempts ?? 0) === 2, String(after.state.resume_attempts));
  // A standard-depth run converges to an honest report rather than stalling.
  // That is deliberate: the watchdog is an exhaustive-depth mechanism (see
  // stall_threshold's note), because at standard a stuck run is already
  // finishing and a "keep going / narrow / stop" prompt would be noise.
  check('…and standard depth converges rather than stalling', after.status !== 'stalled');
}

/* ---- E. THE WATCHDOG, THROUGH THE REAL RUNNER ---------------------- */
// This block exists because the first cut of the stall watchdog was DEAD CODE
// and every check I had written passed anyway: smoke:research-budget drives
// `record_slice`/`is_stalled` as pure functions, and a pure check structurally
// cannot see whether the runner ever calls them with a number big enough to
// matter. It did not — a slice always ENDS on incomplete/done/cancelled, the
// check was gated on an open status AT SLICE END, and the resume cap held
// no_progress_slices one below the threshold forever. An adversarial review
// found it by instrumenting this file.
//
// So the guard has to walk the real runner to a real stall.
console.log('\n→ E. the stall watchdog, driven through the real runner');
{
  const stuck = store.create({
    subject: 'Permanently Stuck Subject',
    subject_kind: 'general',
    brief: 'an exhaustive investigation that never gets any clock',
    requested_by: 'jasper',
    agent_id: 'kate',
    private_to: 'jasper',
    depth: 'exhaustive',
  });
  let slices = 0;
  let last = '';
  for (; slices < 12; slices++) {
    const res = await advance_investigation(runner_deps, ctx, stuck.id, { deadline_ms: -1 });
    last = res.status;
    if (last === 'stalled' || last === 'done' || last === 'failed') break;
    if (!res.progressed) break;
  }
  const row = store.get(stuck.id)!;
  check('an exhaustive run that moves NOTHING reaches stalled', row.status === 'stalled', `${row.status} after ${slices + 1} slice(s)`);
  check('…and it took more than the threshold of stationary slices', slices >= 3, String(slices));
  check('…recording why in the log', (row.state.log ?? []).some((l) => l.includes('STALLED')));
  check('…with the counters that justified it', (row.state.counters?.no_progress_slices ?? 0) >= 3, JSON.stringify(row.state.counters));
  check('…and it did NOT converge to done instead', row.status !== 'done');

  // A stalled row must be inert to the sweep, or a stall becomes a silent loop.
  const inert = await advance_investigation(runner_deps, ctx, stuck.id);
  check('a stalled row is not advanced again', inert.progressed === false);
  check('…and keeps its status', store.get(stuck.id)!.status === 'stalled');

  // The owner's option 1 must genuinely resume THIS row, not mint a twin.
  const reopened = store.reopen_with_facts(stuck.id, [], { carry_dossier: false, depth: 'exhaustive' });
  check('re-opening returns the SAME investigation', reopened?.id === stuck.id);
  check('…back to planning', reopened?.status === 'planning');
  check('…with the budget counters cleared', reopened?.state.counters === undefined, JSON.stringify(reopened?.state.counters));
  check(
    '…AND the resume attempts cleared (else it converges instantly and does nothing)',
    (reopened?.state.resume_attempts ?? 0) === 0,
    String(reopened?.state.resume_attempts),
  );
}

db.close();
rmSync(dir, { recursive: true, force: true });

console.log(`\n  passed=${passed}  failed=${failed}`);
if (failed > 0) {
  console.error('\n✗ RESEARCH-COVERAGE SMOKE FAILED');
  process.exit(1);
}
console.log('\n✓ RESEARCH-COVERAGE SMOKE OK');
process.exit(0);
