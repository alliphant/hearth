/**
 * smoke:deep-research — self-contained test of Kate's deep-research
 * investigations (deep_research tool / runner / list+get reads).
 *
 * Temp vault + db + specialist registry; search / fetch / LLM / verifier are
 * scripted seams (no network, no live model — do NOT set HEARTH_TEST_MODE,
 * which would can the turns; we inject mocks like smoke:research). Asserts:
 * the kill switch (files but no-ops); the slice state machine walks
 * pending → planning → investigating → verifying → synthesizing → done and
 * emits an SSE event per transition; the bounded fan-out yields one
 * SubQuestionResult per sub-question with [S#] indices that map to real
 * sources; the verification pass DROPS an unsupported claim AND the scrub
 * keeps it out of the dossier; the dossier shelves searchable (chunks_fts);
 * the person-note summary writeback runs; the per-user cordon stamps the
 * dossier private_to the requester and the person note household, and
 * list_for_user does not leak across users; re-file collapse; the read tools.
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
import { ResearchInvestigationStore } from '../src/memory/stores/research_investigations';
import {
  advance_investigation,
  type InvestigationRunnerDeps,
} from '../src/specialists/kate/research_investigation_runner';
import { make_deep_research } from '../src/specialists/kate/tools/deep_research';
import { make_list_research_investigations } from '../src/specialists/kate/tools/list_research_investigations';
import { make_get_research_investigation } from '../src/specialists/kate/tools/get_research_investigation';

let failures = 0;
function check(label: string, ok: boolean): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) failures++;
}

/* ------------------------------------------------------------------ */
/* Harness                                                             */
/* ------------------------------------------------------------------ */

const dir = mkdtempSync(join(tmpdir(), 'hearth-deepresearch-'));
const vault_root = join(dir, 'vault');
const db = open_db(join(dir, 'smoke.db'));
const memory = new MemoryClient({ vault_root, db });
const inbox = new SpecialistInbox(db);
const events = new AppEventBus();

// Load the YAML-defined capability tokens (deep_research lives there) so the
// fixture's grant validates against the same set production uses.
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
  Test fixture persona for the deep-research smoke. Long enough to pass.
proactive:
  mode: reactive
capabilities:
  deep_research: true
`,
);
const specialists = new SpecialistRegistry(spec_dir);

const FABRICATED = 'FABRICATED-CLINIC-9000';

/* ---- scripted LLM: plan / sub-queries / extract / synthesize ------- */
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
                { question: "What is the subject's professional background and credentials?" },
                { question: "What is the subject's practice and reputation?" },
              ],
            }),
          };
        }
        if (system.includes('Give 2-3 web search queries')) {
          return { content: JSON.stringify({ queries: ['becca sagall massage therapist'] }) };
        }
        if (system.includes('You extract grounded findings')) {
          if (user.includes('background')) {
            return {
              content: JSON.stringify({
                findings: [
                  { text: 'Dana Marsh is a licensed massage therapist (LMT) in Pleasantville.', source_indices: [1] },
                ],
              }),
            };
          }
          return {
            content: JSON.stringify({
              findings: [
                { text: `She practices at ${FABRICATED} with glowing reviews.`, source_indices: [1] },
                { text: 'Clients consistently praise her deep-tissue work.', source_indices: [2] },
              ],
            }),
          };
        }
        if (system.includes('You compose a cited deep-research dossier')) {
          // Deliberately INCLUDES the unverified specific so the runner's
          // deterministic scrub is what must remove it.
          return {
            content:
              `# Deep research: Dana Marsh\n\n` +
              `Dana Marsh is a licensed massage therapist in Pleasantville. [S1]\n\n` +
              `She practices at ${FABRICATED} with glowing reviews. [S1]\n\n` +
              `Clients consistently praise her deep-tissue work. [S2]\n\n` +
              `## Sources\n[S1] MassageBook — https://massagebook.example/becca\n` +
              `[S2] Yelp — https://yelp.example/becca\n`,
          };
        }
        return { content: '' };
      },
    },
    defaults: {},
  }),
} as unknown as LLMRouter;

/* ---- scripted search + fetch seams -------------------------------- */
type SearchResp = { query: string; results: Array<{ title: string; url: string; snippet: string }>; error?: string };
const search_fn = async (input: { query: string }): Promise<SearchResp> => ({
  query: input.query,
  results: [
    { title: 'Dana Marsh — MassageBook', url: 'https://massagebook.example/becca', snippet: 'LMT' },
    { title: 'Dana Marsh — Yelp', url: 'https://yelp.example/becca', snippet: 'reviews' },
  ],
});
const page = `# Dana Marsh\n\n${'Licensed massage therapist offering deep-tissue and therapeutic massage in Pleasantville. '.repeat(6)}`;
const fetch_page_fn = async (url: string): Promise<FetchOutcome> => ({
  kind: 'firecrawl',
  markdown: page,
  title: 'Dana Marsh',
  source_url: url,
});

/* ---- scripted verifier: flags the fabricated specific ------------- */
let verify_calls = 0;
const verify_fn = async (): Promise<FactCriticResult> => {
  verify_calls++;
  return {
    checked: true,
    unsupported: [{ claim: FABRICATED, kind: 'named_entity', reason: 'not present in the gathered sources' }],
  };
};

/* ---- minimal users stub (id + tier + tz the runner needs) --------- */
const users = {
  get: (id: string) =>
    id === 'sam'
      ? { id: 'sam', tier: 'household' }
      : id === 'jasper'
        ? { id: 'jasper', tier: 'owner' }
        : null,
  get_timezone: () => 'America/Denver',
} as unknown as UserRegistry;

const library_deps: LibraryRoutesDeps = {
  db,
  vault_root,
  memory,
  specialists,
  runtime: null as unknown as SpecialistRuntime,
  conversations: null as unknown as ConversationStore,
  llm: undefined, // skip titleize; the runner's own llm drives synthesis
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
const owner_ctx: ToolContext = {
  memory,
  llm,
  now: new Date('2026-06-19T16:00:00Z'),
  intent_id: ulid(),
  specialist_id: 'kate',
  user: { id: 'jasper', tier: 'owner' },
};

const deep_research = make_deep_research(runner_deps);
const list_tool = make_list_research_investigations(runner_deps);
const get_tool = make_get_research_investigation(runner_deps);

/* ---- capture SSE events ------------------------------------------- */
const captured: AppEvent[] = [];
events.subscribe((e) => captured.push(e));

/* ------------------------------------------------------------------ */
/* 1. Kill switch — files but does not run                             */
/* ------------------------------------------------------------------ */

process.env.HEARTH_DEEP_RESEARCH = '0';
const ks = await deep_research.execute(
  { subject: 'Dana Marsh', subject_kind: 'person', brief: 'background, training, and reviews before my next appointment' },
  owner_ctx,
);
check('kill switch: filed but disabled', ks.enabled === false && ks.investigation_id !== undefined && ks.next_action.includes('HEARTH_DEEP_RESEARCH'));
const ks_id = ks.investigation_id!;
const ks_adv = await advance_investigation(runner_deps, owner_ctx, ks_id);
check('kill switch: advance no-ops, stays pending', ks_adv.progressed === false && store.get(ks_id)!.status === 'pending');
delete process.env.HEARTH_DEEP_RESEARCH;

/* ------------------------------------------------------------------ */
/* 2. Full advance → done (state machine, fan-out, verify, scrub)      */
/* ------------------------------------------------------------------ */

captured.length = 0;
const adv = await advance_investigation(runner_deps, owner_ctx, ks_id);
const done = store.get(ks_id)!;
check('investigation completed', adv.status === 'done' && done.status === 'done');

const statuses = captured
  .filter((e): e is Extract<AppEvent, { type: 'research_investigation_updated' }> => e.type === 'research_investigation_updated')
  .map((e) => e.status);
check(
  'state machine walked + emitted an event per transition',
  ['planning', 'investigating', 'verifying', 'synthesizing', 'done'].every((s) => statuses.includes(s)),
);

check('fan-out produced one result per sub-question', done.findings.length === 2);
const sq1 = done.findings.find((f) => f.question.includes('background'));
check('sub-question has cited findings with valid [S#] indices', !!sq1 && sq1.findings.length > 0 && sq1.findings.every((fi) => fi.source_indices.every((i) => i >= 1 && i <= sq1!.sources.length)));
check('sources were recorded for a sub-question', !!sq1 && sq1.sources.length > 0 && sq1.sources.every((s) => s.fetched_ok));

check('verifier ran', verify_calls >= 1);

// FLAG, DON'T DROP (2026-07-31, design §7). v2 phase 3 gave the verifier a real
// corpus — the persisted source BODIES instead of the finding texts it used to
// grade against itself — so for the first time it can actually fail a claim.
// That also means it can fail one WRONGLY, and `dropped_claims` feeds
// `scrub_dropped_claims`, which DELETES lines out of a dossier a human will act
// on. A false positive there removes true reporting and leaves no trace.
//
// So the shipped behaviour is: the unsupported claim is SURFACED as a verdict
// next to the finding, and stays in the dossier. Deletion is opt-in behind
// HEARTH_RESEARCH_VERIFY_DROP=1 until precision has been measured against real
// dossiers. These three assertions pin that contract; flip the env var and the
// two drop-shaped ones below invert.
check(
  'verification FLAGS the fabricated specific as unverified',
  (done.verification?.verdicts ?? []).some(
    (v) => v.claim.includes(FABRICATED) && v.verdict === 'unverified',
  ),
);
check(
  '…and does NOT silently delete it (drops are opt-in until precision is proven)',
  (done.verification?.dropped_claims ?? []).length === 0,
);
check('dossier composed', (done.dossier_md ?? '').includes('licensed massage therapist'));

check('dossier shelved (note path recorded)', done.dossier_note_path !== null);
if (done.dossier_note_path) {
  const fts = db.prepare(`SELECT COUNT(*) AS n FROM chunks_fts WHERE note_path = ?`).get(done.dossier_note_path) as { n: number };
  check('dossier indexed into chunks_fts (searchable)', fts.n > 0);
}

/* ---- person-note writeback (owner → shared_entity → household) ----- */
const person = memory.find_person({ name: 'Dana Marsh' });
check('person note created/updated for the subject', person !== null);
if (person) {
  const note = memory.read_note(person.note_path);
  check('person note carries the deep-research summary + dossier backlink', (note?.body ?? '').includes('Deep research') && (note?.body ?? '').includes('massage therapist'));
  check("owner's person note stamped household (shared entity)", (note?.frontmatter as Record<string, unknown>)?.private_to === 'household');
}

/* ---- report-back surfaces ----------------------------------------- */
check('research_investigation_updated:done emitted', captured.some((e) => e.type === 'research_investigation_updated' && e.status === 'done'));
check('inbox FYI flagged to Kate', captured.some((e) => e.type === 'inbox_message_added' && e.to_specialist_id === 'kate'));
const kate_inbox = inbox.unread_for('kate');
check('Kate inbox carries the dossier-ready FYI', kate_inbox.some((f) => f.body_md.includes('Deep-research dossier ready')));

/* ------------------------------------------------------------------ */
/* 3. Re-file collapse — applies to an OPEN subject (a finished one may  */
/*    be re-researched). File with the kill switch on (pending, no kick) */
/*    then re-file the same subject → collapses to the open row.         */
/* ------------------------------------------------------------------ */

process.env.HEARTH_DEEP_RESEARCH = '0';
const open1 = await deep_research.execute(
  { subject: 'Marcus Kim', subject_kind: 'general', brief: 'who is he' },
  { ...owner_ctx, intent_id: ulid() },
);
const refiled = await deep_research.execute(
  { subject: 'Marcus Kim', subject_kind: 'general', brief: 'anything new?' },
  { ...owner_ctx, intent_id: ulid() },
);
check('re-file of an OPEN subject collapses to the existing id', refiled.already_running === true && refiled.investigation_id === open1.investigation_id);
delete process.env.HEARTH_DEEP_RESEARCH;

/* ------------------------------------------------------------------ */
/* 4. Per-user cordon — a household member's investigation             */
/* ------------------------------------------------------------------ */

const sara_ctx: ToolContext = { ...owner_ctx, intent_id: ulid(), user: { id: 'sam', tier: 'household' } };
const sara_filed = await deep_research.execute(
  { subject: 'Dr Avery Stone', subject_kind: 'person', brief: 'my new physical therapist' },
  sara_ctx,
);
const sara_id = sara_filed.investigation_id!;
check('non-owner investigation stamped private_to the requester', store.get(sara_id)!.private_to === 'sam');
await advance_investigation(runner_deps, sara_ctx, sara_id);
const sara_done = store.get(sara_id)!;
check('sam investigation completed', sara_done.status === 'done');
if (sara_done.dossier_note_path) {
  const note = memory.read_note(sara_done.dossier_note_path);
  check("sam's dossier wrapper stamped private_to sam", (note?.frontmatter as Record<string, unknown>)?.private_to === 'sam');
}

// list_for_user must not leak across users (owner has NO god-view).
const jasper_list = store.list_for_user({ user_id: 'jasper', tier: 'owner' });
check("owner's list excludes sam's investigation (no god-view)", !jasper_list.some((r) => r.id === sara_id));
const sara_list = store.list_for_user({ user_id: 'sam', tier: 'household' });
check("sam's list includes her own + excludes the owner's", sara_list.some((r) => r.id === sara_id) && !sara_list.some((r) => r.id === ks_id));

/* ------------------------------------------------------------------ */
/* 5. Read tools                                                       */
/* ------------------------------------------------------------------ */

const listed = await list_tool.execute({ include_done: true, limit: 15 }, owner_ctx);
check('list tool returns the owner\'s investigation (cordon-scoped)', listed.investigations.some((i) => i.investigation_id === ks_id) && !listed.investigations.some((i) => i.investigation_id === sara_id));

const got = await get_tool.execute({ investigation_id: ks_id }, owner_ctx);
check('get tool returns the finished dossier', got.found === true && (got.dossier_md ?? '').includes('massage therapist'));
const got_cross = await get_tool.execute({ investigation_id: sara_id }, owner_ctx);
check('get tool 404-shapes a cross-user read (no leak)', got_cross.found === false);

check('deep_research output validates against its schema', deep_research.output_schema.safeParse(ks).success);

await specialists.close();
db.close();
rmSync(dir, { recursive: true, force: true });

console.log(failures === 0 ? '\nsmoke:deep-research OK' : `\nsmoke:deep-research FAILED (${failures} check(s))`);
process.exit(failures === 0 ? 0 : 1);
