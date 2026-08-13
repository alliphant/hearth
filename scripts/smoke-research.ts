/**
 * smoke:research — self-contained test of Cordelia's research
 * commissions (commission_research / runner / list / sweep).
 *
 * Temp vault + db + specialist registry; search/fetch/LLM are scripted
 * seams. Asserts: the kill switch; re-file collapse on an open
 * commission; plan persistence + slice resumability (a dead-deadline
 * slice plans but acquires nothing, the next slice resumes); seed
 * documents fetched binary-aware (a REAL minimal PDF runs through the
 * inbox converter) and shelved Tier 1 with attachment + chunks_fts;
 * in-roster candidates shelve at manifest tier; out-of-roster domains
 * shelve only past the source judge (rejected domains never shelve,
 * verdicts are cached across subtopics); denied domains skipped; judge
 * outage degrades to roster-only WITHOUT advancing past the subtopic;
 * synthesis writes the repository guide, flags the target's inbox, and
 * files capped trusted_source_addition proposals with the resolver
 * payload contract; the list tool and the nightly sweep tool report
 * honestly; friend-tier and unknown-specialist asks return recovery
 * hints instead of throwing.
 *
 * Also pins the think/spread ORDERING at all three of this runner's LLM call
 * sites (planner, source judge, coverage notes): the scripted role defaults turn
 * thinking ON, and every captured request must still carry `think: false` while
 * inheriting the rest of the defaults. Reverse the spread and `think` arrives
 * `true` — which on the real deep tier empties `content` and silently degrades
 * the planner to its fallback, the judge to no verdicts, and the guide to no
 * coverage notes.
 */
import { mkdtempSync, mkdirSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ulid } from 'ulid';
import { open_db } from '../src/memory/stores/structured';
import { MemoryClient } from '../src/memory/client';
import { SpecialistRegistry } from '../src/core/specialist';
import { ProposalsStore } from '../src/core/proposals';
import { SpecialistInbox } from '../src/memory/stores/conversations';
import type { ToolContext } from '../src/core/tool';
import type { LLMRouter } from '../src/core/llm';
import type { LibraryRoutesDeps } from '../src/app/routes/library';
import type { SpecialistRuntime } from '../src/core/specialist_runtime';
import type { ConversationStore } from '../src/memory/stores/conversations';
import type { FetchOutcome } from '../src/connectors/fetch_with_browser_fallback';
import { DENIALS_PATH } from '../src/specialists/cordelia/sources_store';
import {
  ResearchCommissionStore,
} from '../src/memory/stores/research_commissions';
import {
  advance_commission,
  document_mime_for_url,
  type DocumentFetch,
  type ResearchRunnerDeps,
} from '../src/specialists/cordelia/research_runner';
import { make_commission_research } from '../src/specialists/cordelia/tools/commission_research';
import { make_list_research_commissions } from '../src/specialists/cordelia/tools/list_research_commissions';
import { make_advance_research_commissions } from '../src/specialists/cordelia/tools/advance_research_commissions';

let failures = 0;
/** `extra` is printed only on a FAIL — the observed value, so a red line says
 *  what it actually saw instead of just which assertion tripped. */
function check(label: string, ok: boolean, extra?: string): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok || !extra ? '' : `  — ${extra}`}`);
  if (!ok) failures++;
}

/* ------------------------------------------------------------------ */
/* Harness                                                             */
/* ------------------------------------------------------------------ */

const dir = mkdtempSync(join(tmpdir(), 'hearth-research-'));
const vault_root = join(dir, 'vault');
const db = open_db(join(dir, 'smoke.db'));
const memory = new MemoryClient({ vault_root, db });
const proposals = new ProposalsStore(db);
const inbox = new SpecialistInbox(db);

const spec_dir = join(dir, 'specialists');
mkdirSync(spec_dir, { recursive: true });
writeFileSync(
  join(spec_dir, 'astrid.yaml'),
  `id: astrid
name: Astrid
role: Fitness and endurance coach
voice: warm-direct
persona: |
  Test fixture persona for the research smoke. Long enough to pass.
proactive:
  mode: reactive
trusted_sources:
  tier_1:
    - manuals.example.org
`,
);
const specialists = new SpecialistRegistry(spec_dir);

// A previously-denied domain for astrid (the resolver's reject format).
memory.upsert_note(
  DENIALS_PATH,
  {},
  '# Denials\n\n- **2026-06-01T00:00:00Z** — `denied.example.net` proposed for astrid Tier 2, denied.\n',
);

const library_deps: LibraryRoutesDeps = {
  db,
  vault_root,
  memory,
  specialists,
  runtime: null as unknown as SpecialistRuntime,
  conversations: null as unknown as ConversationStore,
  llm: undefined,
};

/* ---- a REAL minimal PDF (valid xref) so the seed path exercises ----
 * the actual unpdf conversion the Trek service manual would ride. */
function build_minimal_pdf(lines: string[]): Uint8Array {
  const stream = lines
    .map((l, i) => `BT /F1 12 Tf 72 ${720 - i * 16} Td (${l.replace(/[\\()]/g, '')}) Tj ET`)
    .join('\n');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let body = '%PDF-1.4\n';
  const offsets: number[] = [];
  for (let i = 0; i < objects.length; i++) {
    offsets.push(body.length);
    body += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xref_off = body.length;
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) xref += `${String(off).padStart(10, '0')} 00000 n \n`;
  body +=
    xref +
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref_off}\n%%EOF\n`;
  return new TextEncoder().encode(body);
}

const seed_pdf = build_minimal_pdf([
  'Trek Powerfly FS service manual extract for the smoke test.',
  'Bosch Performance CX drive unit mounting bolts torque to 9 Nm.',
  'Remove the drive unit cover before disconnecting the speed sensor.',
  'Battery rail bolts torque specification is 5 Nm with threadlocker.',
  'Hydraulic brake hose fittings use a 8 mm flare wrench at 5 Nm.',
  'Always remove the battery before any drivetrain service work.',
  'Motor interface single bolt pattern requires a torque wrench.',
  'Check spoke tension after the first fifty kilometers of riding.',
]);
const SEED_URL =
  'https://retailerassets.example.net/techassets/TK_PowerFly_FS_ServiceManual_MY23.pdf?sv=2018-03-28&sig=abc%3D';

/* ---- scripted LLM: plan / judge / overview, routed on system text -- */
let judge_mode: 'ok' | 'garbage' = 'ok';
let judge_calls = 0;
const PLANS: Array<{ match: string; plan: unknown }> = [
  {
    match: 'Bicycle and e-bike repair',
    plan: {
      subtopics: [
        {
          title: 'Bosch drive unit service',
          queries: ['bosch ebike drive unit service manual'],
          rationale: 'manufacturer documentation first',
        },
        { title: 'Hydraulic brake bleed', queries: ['mtb hydraulic brake bleed guide'] },
      ],
    },
  },
  {
    match: 'judge outage',
    plan: { subtopics: [{ title: 'Outage subtopic', queries: ['judge outage q'] }] },
  },
  {
    match: 'quick single',
    plan: { subtopics: [{ title: 'Quick subtopic', queries: ['quick single q'] }] },
  },
];
const JUDGE_ROWS: Record<string, unknown> = {
  'spamblog.example.net': {
    domain: 'spamblog.example.net',
    authority: 0.2, independence: 0.3, freshness: 0.5, fit: 0.3,
    propose: false, suggested_tier: 2, suggested_cadence: 'monthly',
    reason: 'SEO listicle farm',
  },
  'parktool.example.com': {
    domain: 'parktool.example.com',
    authority: 0.9, independence: 0.85, freshness: 0.9, fit: 0.95,
    propose: true, suggested_tier: 2, suggested_cadence: 'monthly',
    reason: 'professional repair reference of record',
  },
  'onlyblog.example.io': {
    domain: 'onlyblog.example.io',
    authority: 0.7, independence: 0.7, freshness: 0.7, fit: 0.75,
    propose: false, suggested_tier: 2, suggested_cadence: 'quarterly',
    reason: 'solid but not roster-grade',
  },
};
// The role defaults deliberately turn thinking ON and move temperature. All
// three commission-runner LLM call sites spread `...role.defaults` and then
// force `think: false` AFTER it — load-bearing, not tuning: the planner and judge
// replies are JSON.parse()d and the overview is read as prose, while the deep
// tier puts its trace in `reasoning_content` and exhausts max_tokens, returning
// EMPTY `content`. Every call is captured so that ordering is a TESTED contract
// rather than a comment: put the spread last again and the assertions below go
// red. `temperature` is captured with it to prove the fix didn't achieve
// think:false by ignoring role defaults wholesale.
const ROLE_DEFAULTS = { think: true, temperature: 0.9 };
const seen: Array<{ system: string; think: unknown; temperature: unknown }> = [];
const llm = {
  for_role: (_role: string) => ({
    provider: {
      complete: async (req: {
        messages: Array<{ role: string; content: string }>;
        think?: boolean;
        temperature?: number;
      }) => {
        const system = req.messages.find((m) => m.role === 'system')?.content ?? '';
        const user = req.messages.find((m) => m.role === 'user')?.content ?? '';
        seen.push({ system, think: req.think, temperature: req.temperature });
        if (system.includes('You decompose a research commission')) {
          const hit = PLANS.find((p) => user.includes(p.match));
          return { content: JSON.stringify(hit ? hit.plan : { subtopics: [] }) };
        }
        if (system.includes('You evaluate candidate WEB DOMAINS')) {
          judge_calls++;
          if (judge_mode === 'garbage') return { content: 'not json at all' };
          const rows = Object.keys(JUDGE_ROWS)
            .filter((d) => user.includes(d))
            .map((d) => JUDGE_ROWS[d]);
          return { content: JSON.stringify(rows) };
        }
        if (system.includes('closing coverage notes')) {
          return {
            content:
              'The shelf now covers Bosch drive unit service and hydraulic brake bleeds, anchored by the seeded service manual.\n\nGaps worth a follow-up: wheel building and suspension service.',
          };
        }
        return { content: '' };
      },
    },
    defaults: ROLE_DEFAULTS,
  }),
} as unknown as LLMRouter;

/* ---- scripted search + fetch seams -------------------------------- */
type SearchResp = {
  query: string;
  results: Array<{ title: string; url: string; snippet: string }>;
  error?: string;
};
const SEARCHES: Record<string, SearchResp['results']> = {
  'bosch ebike drive unit service manual': [
    { title: 'Bosch drive unit service', url: 'https://manuals.example.org/bosch-drive-service', snippet: 'official' },
    { title: 'Ten best ebike hacks', url: 'https://spamblog.example.net/10-best', snippet: 'listicle' },
    { title: 'Park Tool drive maintenance', url: 'https://parktool.example.com/repair/drive', snippet: 'how-to' },
  ],
  'mtb hydraulic brake bleed guide': [
    { title: 'Brake bleed guide', url: 'https://parktool.example.com/repair/brake-bleed', snippet: 'guide' },
    { title: 'Denied domain post', url: 'https://denied.example.net/brakes', snippet: 'no' },
  ],
  'judge outage q': [
    { title: 'Only blog post', url: 'https://onlyblog.example.io/post', snippet: '' },
  ],
  'quick single q': [
    { title: 'Manifest quick doc', url: 'https://manuals.example.org/quick', snippet: '' },
  ],
};
const search_fn = async (input: { query: string }): Promise<SearchResp> => ({
  query: input.query,
  results: SEARCHES[input.query] ?? [],
});

const para =
  'Drive unit service intervals depend on mileage and riding conditions, and the manufacturer documents each torque value in the dealer service literature. ' +
  'Hydraulic systems need a full fluid exchange when lever feel degrades, and pad contamination is the most common cause of noise complaints. ';
const page_markdown = `# Repair reference\n\n${para.repeat(5)}`;
const fetch_page_fn = async (url: string): Promise<FetchOutcome> => ({
  kind: 'firecrawl',
  markdown: page_markdown,
  title: 'Repair reference',
  source_url: url,
});
let doc_fetches: Array<{ url: string; mime: string }> = [];
const fetch_doc_fn = async (url: string, mime: string): Promise<DocumentFetch> => {
  doc_fetches.push({ url, mime });
  return {
    kind: 'document',
    bytes: seed_pdf,
    mime,
    filename: 'TK_PowerFly_FS_ServiceManual_MY23.pdf',
  };
};

const runner_deps: ResearchRunnerDeps = {
  specialists,
  proposals,
  library_deps,
  llm,
  inbox,
  search_fn: search_fn as never,
  fetch_page_fn: fetch_page_fn as never,
  fetch_doc_fn,
};

const store = new ResearchCommissionStore(db);
const ctx: ToolContext = {
  memory,
  llm,
  now: new Date('2026-06-11T04:00:00Z'),
  intent_id: ulid(),
  specialist_id: 'cordelia',
  user: { id: 'jasper', tier: 'owner' },
};

const commission_tool = make_commission_research(runner_deps);
const list_tool = make_list_research_commissions(db);
const sweep_tool = make_advance_research_commissions(runner_deps);

/* ------------------------------------------------------------------ */
/* 0. Pure helpers                                                     */
/* ------------------------------------------------------------------ */

check(
  'document_mime_for_url: .pdf path with SAS query string → application/pdf',
  document_mime_for_url(SEED_URL) === 'application/pdf',
);
check(
  'document_mime_for_url: .docx → wordprocessingml',
  (document_mime_for_url('https://x.example/a/spec.DOCX') ?? '').includes('wordprocessingml'),
);
check(
  'document_mime_for_url: plain page → null',
  document_mime_for_url('https://x.example/manuals.pdf.html') === null,
);

/* ------------------------------------------------------------------ */
/* 1. Filing — kill switch on, so the detached kick stays out of the   */
/*    way and the smoke drives slices deterministically.               */
/* ------------------------------------------------------------------ */

process.env.HEARTH_RESEARCH_COMMISSIONS = '0';

const filed = await commission_tool.execute(
  {
    brief:
      'Bicycle and e-bike repair for a Trek Powerfly FS — Bosch drive system service, hydraulic brake bleeds, drivetrain wear.',
    target_specialist_id: 'astrid',
    title: 'Bike + e-bike repair',
    seed_urls: [SEED_URL],
    depth: 'standard',
  },
  ctx,
);
check('commission filed', filed.commission_id !== undefined && filed.status === 'pending');
check('kill switch reflected at filing', filed.enabled === false && filed.next_action.includes('HEARTH_RESEARCH_COMMISSIONS'));
const c1 = filed.commission_id!;

const blocked = await advance_commission(runner_deps, ctx, c1);
check(
  'advance no-ops under the kill switch',
  blocked.progressed === false && (blocked.error ?? '').includes('kill switch') && store.get(c1)!.status === 'pending',
);

delete process.env.HEARTH_RESEARCH_COMMISSIONS;

/* ------------------------------------------------------------------ */
/* 2. Slice resumability: a dead deadline plans but acquires nothing   */
/* ------------------------------------------------------------------ */

const slice1 = await advance_commission(runner_deps, ctx, c1, { deadline_ms: -1000 });
const mid = store.get(c1)!;
check('dead-deadline slice planned and stopped', slice1.progressed === true && mid.status === 'acquiring');
check('plan persisted (2 subtopics)', mid.plan?.subtopics.length === 2);
check('nothing shelved yet', mid.shelved.length === 0);

/* ------------------------------------------------------------------ */
/* 3. Full advance → done                                              */
/* ------------------------------------------------------------------ */

const slice2 = await advance_commission(runner_deps, ctx, c1);
const done = store.get(c1)!;
check('commission completed', slice2.status === 'done' && done.status === 'done');
check('seed fetched binary-aware with pdf mime', doc_fetches.length === 1 && doc_fetches[0]!.mime === 'application/pdf' && doc_fetches[0]!.url === SEED_URL);

const seed_doc = done.shelved.find((s) => s.subtopic === 'Seed documents');
check('seed shelved at Tier 1 despite out-of-roster domain', seed_doc?.trust_tier === 1);
if (seed_doc) {
  const note = memory.read_note(seed_doc.wrapper_note_path);
  const fm = (note?.frontmatter ?? {}) as Record<string, unknown>;
  check('seed wrapper carries source_url + trust_tier', fm.source_url === SEED_URL && fm.trust_tier === 1);
  check('seed body holds the unpdf-extracted text', (note?.body ?? '').includes('torque'));
  const att = typeof fm.attachment_path === 'string' ? fm.attachment_path : null;
  check('seed PDF preserved as attachment', att !== null && existsSync(resolve(vault_root, att)));
  const fts = db
    .prepare(`SELECT COUNT(*) AS n FROM chunks_fts WHERE note_path = ?`)
    .get(seed_doc.wrapper_note_path) as { n: number };
  check('seed indexed into chunks_fts (searchable)', fts.n > 0);
}

const manifest_doc = done.shelved.find((s) => s.url.includes('manuals.example.org/bosch'));
check('in-roster candidate shelved at manifest Tier 1', manifest_doc?.trust_tier === 1);
const judged_docs = done.shelved.filter((s) => s.url.includes('parktool.example.com'));
check('judge-cleared domain shelved (both subtopics) at judge tier 2', judged_docs.length === 2 && judged_docs.every((d) => d.trust_tier === 2));
check('judge verdict cached across subtopics (one judge call)', judge_calls === 1);
check('judge-rejected domain never shelved', !done.shelved.some((s) => s.url.includes('spamblog')));
check('denied domain skipped with reason', done.skipped.some((s) => s.url.includes('denied.example.net') && s.reason.includes('denied')));
check('4 documents total (1 seed + 3 searched)', done.shelved.length === 4);

check('roster proposal filed for the used judge-cleared domain', done.proposed.length === 1 && done.proposed[0]!.domain === 'parktool.example.com');
const prop_row = db
  .prepare(`SELECT user_id, payload_json FROM proposals WHERE kind = 'trusted_source_addition'`)
  .get() as { user_id: string | null; payload_json: string } | null;
check('proposal row exists (system-kind NULL user_id)', prop_row !== null && prop_row.user_id === null);
const payload = JSON.parse(prop_row!.payload_json) as Record<string, unknown>;
check(
  'proposal payload matches the resolver contract',
  payload.target_specialist_id === 'astrid' && payload.domain === 'parktool.example.com' && payload.tier === 2 && payload.suggested_cadence === 'monthly',
);

check('index note path recorded', done.index_note_path !== null);
if (done.index_note_path) {
  const guide = memory.read_note(done.index_note_path);
  const body = guide?.body ?? '';
  check(
    'repository guide groups by subtopic and links the docs',
    body.includes('### Bosch drive unit service') && body.includes(seed_doc?.wrapper_note_path ?? '@@'),
  );
  check('guide carries the LLM coverage notes', body.includes('Coverage notes'));
}

const flags = inbox.unread_for('astrid');
check('target specialist flagged on completion', flags.some((f) => f.body_md.includes('Research repository ready') && f.from_specialist_id === 'cordelia'));

const audits = db
  .prepare(`SELECT COUNT(*) AS n FROM audit_log WHERE tool_name = 'research_commission' AND agent = 'cordelia'`)
  .get() as { n: number };
check('runner slices audited', audits.n >= 2);

/* ------------------------------------------------------------------ */
/* 3b. think:false survives a think-ON role default, at ALL 3 sites    */
/* ------------------------------------------------------------------ */
// The commission that just ran exercised every LLM call site in this runner:
// the planner (plan_commission), the source judge (judge_commission_domains),
// and the closing coverage notes (compose_overview). Each spreads
// `...role.defaults` and then forces `think: false` after it; assert per call
// site so a regression at any ONE of the three is named, not averaged away.
{
  const site = (needle: string) => seen.filter((s) => s.system.includes(needle));
  const sites: Array<[string, string]> = [
    ['planner', 'You decompose a research commission'],
    ['source judge', 'You evaluate candidate WEB DOMAINS'],
    ['coverage notes', 'closing coverage notes'],
  ];
  check('the fixture role default really is think:true (the test is vacuous otherwise)', ROLE_DEFAULTS.think === true);
  for (const [label, needle] of sites) {
    const calls = site(needle);
    check(`${label}: the call site ran (coverage is real)`, calls.length > 0);
    check(
      `${label}: forced think:false despite the think-ON role default`,
      calls.length > 0 && calls.every((c) => c.think === false),
      JSON.stringify(calls.map((c) => c.think)),
    );
    check(
      `${label}: role defaults still win for everything else (temperature)`,
      calls.length > 0 && calls.every((c) => c.temperature === ROLE_DEFAULTS.temperature),
      JSON.stringify(calls.map((c) => c.temperature)),
    );
  }
}

/* ------------------------------------------------------------------ */
/* 4. Judge outage: roster-only, subtopic NOT silently completed       */
/* ------------------------------------------------------------------ */

judge_mode = 'garbage';
const filed3 = await commission_tool.execute(
  { brief: 'judge outage domain coverage for astrid testing', target_specialist_id: 'astrid', seed_urls: [], depth: 'standard' },
  { ...ctx, intent_id: ulid() },
);
// The detached kick is async — wait for it to settle (it stops on
// no-progress once the judge comes back garbled).
await new Promise((r) => setTimeout(r, 150));
const c3 = filed3.commission_id!;
let c3_row = store.get(c3)!;
check('judge outage leaves the commission open at the same subtopic', c3_row.status === 'acquiring' && (c3_row.state.subtopic_cursor ?? 0) === 0 && c3_row.shelved.length === 0);

// Re-file collapse while open: same brief returns the SAME commission.
const refiled = await commission_tool.execute(
  { brief: 'judge outage domain coverage for astrid testing', target_specialist_id: 'astrid', seed_urls: [], depth: 'standard' },
  { ...ctx, intent_id: ulid() },
);
check('re-file of an open commission collapses to the existing id', refiled.already_existed === true && refiled.commission_id === c3);

// Judge recovers → the same subtopic resumes and completes.
judge_mode = 'ok';
const c3_done = await advance_commission(runner_deps, ctx, c3);
c3_row = store.get(c3)!;
check('after judge recovery the commission completes', c3_done.status === 'done' && c3_row.shelved.length === 1);
check('propose:false verdict shelves without a roster proposal', c3_row.proposed.length === 0);

/* ------------------------------------------------------------------ */
/* 5. The nightly sweep tool                                           */
/* ------------------------------------------------------------------ */

process.env.HEARTH_RESEARCH_COMMISSIONS = '0';
const filed4 = await commission_tool.execute(
  { brief: 'quick single subtopic build for astrid', target_specialist_id: 'astrid', seed_urls: [], depth: 'standard' },
  { ...ctx, intent_id: ulid() },
);
delete process.env.HEARTH_RESEARCH_COMMISSIONS;
const c4 = filed4.commission_id!;

const swept = await sweep_tool.execute({ max_commissions: 2 }, { ...ctx, intent_id: ulid() });
check('sweep closed the open commission', swept.enabled && swept.advanced.some((a) => a.commission_id === c4 && a.status === 'done'));
check('sweep reports no open commissions remaining', swept.open_remaining === 0);

/* ------------------------------------------------------------------ */
/* 6. List tool + recovery paths                                       */
/* ------------------------------------------------------------------ */

const listed = await list_tool.execute({ status: 'done', limit: 10 }, ctx);
check('list(done) returns all three completed commissions', listed.commissions.length === 3 && listed.open_count === 0);
const listed_c1 = listed.commissions.find((c) => c.commission_id === c1);
check(
  'list row carries progress + guide path',
  listed_c1 !== undefined && listed_c1.shelved === 4 && listed_c1.subtopics_done === 2 && listed_c1.index_note_path !== null,
);
const listed_open = await list_tool.execute({ status: 'open', limit: 5 }, ctx);
check('list(open) empty with grounded next_action', listed_open.commissions.length === 0 && (listed_open.next_action ?? '').length > 10);

const friend = await commission_tool.execute(
  { brief: 'friend should not be able to commission this', target_specialist_id: 'astrid', seed_urls: [], depth: 'standard' },
  { ...ctx, intent_id: ulid(), user: { id: 'kim', tier: 'friend' } },
);
check('friend tier refused with recovery hint', friend.error !== undefined && friend.commission_id === undefined && friend.next_action.includes('household'));

const unknown = await commission_tool.execute(
  { brief: 'who is this for anyway, nobody we know', target_specialist_id: 'nonexistent', seed_urls: [], depth: 'standard' },
  { ...ctx, intent_id: ulid() },
);
check('unknown specialist returns known ids (no throw)', unknown.error !== undefined && (unknown.known_specialist_ids ?? []).includes('astrid'));

check('output validates against output_schema', commission_tool.output_schema.safeParse(filed).success);

await specialists.close();
db.close();
rmSync(dir, { recursive: true, force: true });

console.log(
  failures === 0 ? '\nsmoke:research OK' : `\nsmoke:research FAILED (${failures} check(s))`,
);
process.exit(failures === 0 ? 0 : 1);
