/**
 * research_investigation_runner — the engine behind Kate's deep-research
 * investigations (2026-06-19).
 *
 * A deep-research investigation is a "go find out everything about X" ask
 * Kate hands off in chat — a person (Dana Marsh, the massage therapist),
 * a product, a place, a decision. A chat turn can't do it justice (8
 * external fetches, 15 rounds, a 2000-token reply, no async), so the work
 * lives in the `research_investigations` table and THIS module advances it
 * in bounded, detached slices:
 *
 *   pending/planning → plan: a planner-role LLM decomposes the subject into
 *                  4-6 independent, answerable sub-questions (fail-open: the
 *                  brief becomes one sub-question).
 *   investigating → fan out the sub-questions through a bounded pool (≤2
 *                  concurrent deep-tier calls — the load-bearing budget;
 *                  see fanout_concurrency). Each sub-investigator plans 2-3
 *                  queries (planner tier), searches, fetches the top sources
 *                  (Firecrawl → warmed browser), PERSISTS each source body to
 *                  `research_sources`, and extracts grounded findings WITH
 *                  [S#] citations (deep tier). The query-plan + search run on
 *                  the FAST tier; only the extraction touches the deep tier.
 *                  On a RESUME only the facets recorded `not_attempted` re-run.
 *   verifying → adversarially re-check the load-bearing claims against the
 *                  gathered evidence with the shared fact critic
 *                  (assess_factual_grounding). Unsupported specifics are
 *                  dropped from the dossier.
 *   synthesizing → compose a multi-section cited dossier from the verified
 *                  findings (deep tier, fail-open to a deterministic
 *                  skeleton), scrub the dropped claims deterministically,
 *                  OPEN it with the coverage ledger, shelve it (searchable),
 *                  write back a person-note summary when the subject is a
 *                  person, push + flag Kate. mark done — OR mark `incomplete`
 *                  when facets were never attempted, which the sweep resumes.
 *
 * Deep Research v2 phases 1-2 (2026-07-29) added the two things above:
 *
 *   - **Source bodies are persisted** (`research_sources`, cordoned like the
 *     dossier, capped, expiring). Before this, a fetched page was read for 6k
 *     characters and discarded, which is why verification had no corpus and
 *     graded findings against themselves, why a page's own publication date was
 *     unrecoverable, and why no quote could be anchored. Phase 3 builds the real
 *     verifier on this; phase 1 only makes the evidence exist.
 *   - **A coverage ledger** tracks every planned facet as answered / partial /
 *     unanswerable(reason) / not_attempted, and the dossier OPENS with it. A
 *     six-facet brief used to lose four facets with no trace; now an unattempted
 *     facet is a recorded, resumable state and the report says so up front.
 *
 * "Sub-agentic" here is a BOUNDED FAN-OUT of focused LLM calls + the
 * existing connectors orchestrated by this runner — NOT a new agent
 * runtime (the repo prohibits one). The binary-aware fetcher and the
 * grounding judge are shared with Cordelia's commission runner and the
 * chat-finalize critic respectively; nothing is reinvented.
 *
 * Resumability is PER-PHASE: a sub-investigator is an idempotent read, so a
 * slice that can't finish re-runs the phase next slice (overwriting
 * findings_json). The detached kick runs slices back-to-back; the nightly
 * advance_research_investigations sweep is the crash-recovery retry path.
 *
 * Kill switch: HEARTH_DEEP_RESEARCH=0 (advances no-op; nothing lost —
 * investigations stay open until re-enabled).
 */
import { ulid } from 'ulid';
import type { ToolContext } from '@core/tool';
import type { ToolDeps } from '@core/tool_deps';
import type { SpecialistRegistry, LoadedSpecialist } from '@core/specialist';
import type { LLMRole, LLMRouter } from '@core/llm';
import type { SpecialistInbox } from '@memory/stores/conversations';
import type { AppEventBus } from '@app/events';
import type { UserRegistry } from '@core/users';
import { web_search } from '@connectors/searxng';
import { fetch_document, type FetchDocSeams } from '@core/research_fetch';
import { save_library_item, type LibraryRoutesDeps } from '@app/routes/library';
import { assess_factual_grounding } from '@core/fact_critic';
import { build_grounding_context, build_grounding_evidence } from '@core/provenance';
import { push_text_to_user } from '@policy/push';
import { emit_job_progress, job_from_investigation_row } from '@core/jobs';
// The ONE progress ladder — routes/research.ts owns it and the Research Room
// pane already reads it from there; core/jobs.ts takes it as a parameter rather
// than importing it, so the projection never inverts core → app.
import { progress_of } from '@app/routes/research';
import { find_or_create_person } from '@agents/scribe/tools/find_or_create_person';
import { upsert_person_note } from '@agents/scribe/tools/upsert_person_note';
import { local_iso_date } from '@core/time';
import {
  ResearchInvestigationStore,
  OPEN_INVESTIGATION_STATUSES,
  PERSON_SUBJECT_KINDS,
  type CoverageLedger,
  type InvestigationPlan,
  type InvestigationRow,
  type InvestigationStatus,
  type Source,
  type SubFinding,
  type SubjectKind,
  type SubQuestion,
  type SubQuestionResult,
  type VerificationResult,
} from '@memory/stores/research_investigations';
import { ResearchSourcesStore } from '@memory/stores/research_sources';
import {
  compute_coverage,
  coverage_summary_line,
  coverage_tally,
  has_unattempted,
  prepend_coverage_section,
  render_coverage_section,
} from '@core/research_coverage';
import {
  normalize_for_quote,
  quote_in_evidence,
  MIN_QUOTE_CHARS,
} from '@core/quote_grounding';
import {
  anchor_from_facts,
  name_anchor_applies,
  source_corroborates_anchor,
  source_mentions_subject,
  type IdentityAnchor,
} from '@core/research_identity';
import { render_attribution_note, type AttributionTier } from '@core/research_attribution';
import {
  render_jurisdiction,
  resolve_jurisdiction,
  type Jurisdiction,
} from '@core/research_jurisdiction';
import {
  looks_captcha_walled,
  looks_like_search_form,
  plan_records_queries,
  rank_source_hits,
  records_enabled,
  render_records_limits,
  STRUCTURAL_LIMITS_NOTE,
  type InvestigatorKind,
} from '@core/research_records';
import { courtlistener_search } from '@connectors/courtlistener';
import {
  budget_for,
  budget_status,
  counters_from,
  is_stalled,
  progress_signature,
  record_slice,
  render_budget_note,
  render_stall_notice,
  rounds_remaining,
  sources_remaining,
  type BudgetCounters,
  type ResearchBudget,
} from '@core/research_budget';

/**
 * Did this investigation ever find a source that is actually about the subject?
 *
 * True when the name gate refused sources AND not one facet was answered — i.e.
 * everything we could read was about somebody else. For a private person with
 * no public footprint that is the TRUE answer, and it is far more useful than a
 * same-named stranger's biography (which is what shipped on 2026-07-30).
 */
function subject_unconfirmed(row: InvestigationRow, coverage: CoverageLedger): boolean {
  if (!name_anchor_applies(PERSON_SUBJECT_KINDS.includes(row.subject_kind), row.subject)) return false;
  const dropped = row.findings.reduce((n, r) => n + (r.dropped_sources?.length ?? 0), 0);
  if (dropped === 0) return false;
  return !coverage.facets.some((f) => f.status === 'answered' || f.status === 'partial');
}

/**
 * Is the prior dossier a starting point, or is it poison?
 *
 * Refining a dossier that described the WRONG PERSON would launder a stranger's
 * biography into the next revision — so a correction starts clean while a
 * genuine deepening builds on what is already there. Derived from what the run
 * recorded, never guessed.
 */
export function prior_dossier_worth_refining(row: InvestigationRow): boolean {
  if (!row.dossier_md) return false;
  const identity_flagged = (row.verification?.verdicts ?? []).some((v) =>
    /same-name match is not a same-person match/.test(v.reason),
  );
  if (identity_flagged) return false;
  return !subject_unconfirmed(row, row.coverage ?? compute_coverage(row.plan, row.findings));
}

/**
 * Nothing was established — so say that briefly, instead of at length.
 *
 * The 2026-07-30 "Daniel Ray Torres" dossier is the exemplar: **0 of 6 facets
 * answered**, and TEN THOUSAND CHARACTERS explaining, facet by eloquent facet,
 * what had not been found — synthesized from a Wikipedia page about the NAME
 * "Jonathan", a baby-name site, a Bible dictionary, a Honda tuning forum and a
 * GitHub bug report (17 of its 18 sources never named him at all). The owner's
 * verdict was "it's so useless", and he was right: prose cannot add information
 * that the findings do not contain, and length reads as substance.
 *
 * **A report should be as long as what it established, not as long as what was
 * asked.** The coverage ledger already names every facet and why it failed;
 * restating each one in a paragraph is padding. So when no facet is answered or
 * partial, this deterministic report replaces the synthesis entirely.
 */
function nothing_established_dossier(row: InvestigationRow, coverage: CoverageLedger): string {
  const read = row.findings.reduce((n, r) => n + r.sources.length, 0);
  const refused = row.findings.reduce((n, r) => n + (r.dropped_sources?.length ?? 0), 0);
  return [
    `# Deep research: ${row.subject}`,
    '',
    `**Brief:** ${row.brief}`,
    '',
    '## Nothing was established',
    '',
    `I read ${read} usable source(s)${refused > 0 ? ` (and refused ${refused} that were about somebody else)` : ''} ` +
      `and could not ground an answer to a single one of the ${coverage.facets.length} questions below. ` +
      `Rather than write pages about what I did not find, here is the ledger:`,
    '',
    render_coverage_section(coverage).replace(/^## Coverage\n\n/, ''),
    '',
    '### Why this can happen',
    '',
    'Public web search cannot reach anything behind an account, a paywall, or a ' +
      'county/agency portal — court filings, property and tax records, and ' +
      'member-only profiles usually live there. If a question needs one of those, ' +
      'no amount of further searching from here will answer it.',
    '',
    ...(row.anchor_facts.length > 0
      ? [`I searched with what you told me: ${row.anchor_facts.join('; ')}.`, '']
      : []),
    'If you can tell me anything else that narrows it — an employer, a middle name, ' +
      'a city, a profile link — I will run this again anchored on it.',
    '',
  ].join('\n');
}

/** The report for a subject we could not confirm a single source about. */
function unconfirmed_dossier(row: InvestigationRow, dropped: number): string {
  return [
    `# Deep research: ${row.subject}`,
    '',
    `**Brief:** ${row.brief}`,
    '',
    '## Could not find this person',
    '',
    `I could not confirm a single source that is actually about ${row.subject}.`,
    '',
    `I read ${dropped} page(s) that the search returned, and every one of them was ` +
      `about somebody else — a different person who shares part of the name, or a ` +
      `surname listing. Rather than describe a stranger, I am reporting that I found nothing.`,
    ...(row.anchor_facts.length > 0
      ? [
          '',
          `I searched with what you told me (${row.anchor_facts.join('; ')}) and still ` +
            `could not confirm a source about them.`,
        ]
      : []),
    '',
    'This is a real answer, not a failure to try: it most likely means they have little ' +
      'or no public web presence, which is true of most people.',
    '',
    '**Nothing has been written to their record.**',
    '',
    '**Tell me one thing that pins down which person this is** — where they work, what ' +
      'city, where they studied, a profile link, or the name they actually publish under ' +
      '— and I will run this again anchored on it. That single detail is usually the ' +
      'difference between finding nobody and finding them.',
    '',
    '### Sources read and refused',
    '',
    ...row.findings.flatMap((r) =>
      (r.dropped_sources ?? []).map((d) => `- ${d.title ?? d.url} — ${d.url}\n  _${d.reason}_`),
    ),
    '',
  ].join('\n');
}

/* ------------------------------------------------------------------ */
/* Tunables (read at call time — mirror the kill-switch env idiom)     */
/* ------------------------------------------------------------------ */

export function deep_research_enabled(): boolean {
  return process.env.HEARTH_DEEP_RESEARCH !== '0';
}

function int_env(name: string, dflt: number, lo: number, hi: number): number {
  const raw = Number.parseInt(process.env[name] ?? '', 10);
  const v = Number.isFinite(raw) && raw > 0 ? raw : dflt;
  return Math.max(lo, Math.min(v, hi));
}

function slice_ms(): number {
  return int_env('HEARTH_DEEP_RESEARCH_SLICE_MS', 5 * 60_000, 30_000, 30 * 60_000);
}
/** Number of sub-questions to decompose into. */
function fanout_width(): number {
  return int_env('HEARTH_DEEP_RESEARCH_FANOUT', 6, 1, 8);
}
/** Concurrent deep-tier extraction calls. Default 2 leaves ≥1 of the deep
 *  tier's 4 slots for interactive consult_deep_model and ≥1 for the
 *  deliberation lane — the fan-out never FILLS the endpoint mutex. */
function fanout_concurrency(): number {
  return int_env('HEARTH_DEEP_RESEARCH_CONCURRENCY', 2, 1, 3);
}
/** Sources fetched + read per sub-question. */
function fetch_per_sq(): number {
  return int_env('HEARTH_DEEP_RESEARCH_FETCH_PER_SQ', 3, 1, 5);
}
/** Search hits requested per query. */
const SEARCH_RESULTS = 8;
/** Per-source text fed to the extractor (chars). */
const SOURCE_CHAR_CAP = 6_000;

/** Consecutive errored slices before an investigation is marked failed. */
const MAX_ERROR_STREAK = 3;
// How many times an `incomplete` investigation re-enters the fan-out to retry
// facets it never attempted now lives on the DEPTH BUDGET
// (ResearchBudget.max_resume_attempts, v2 phase 5) rather than as one constant.
// It is still bounded so the status machine always converges — past the cap the
// leftovers are recorded `unanswerable` and the row reaches `done`, because an
// open status the sweep can never close is its own silent failure — but the
// bound is now 1/2/25 by depth instead of a flat 2, which is what makes an
// exhaustive run actually keep going.

/* ------------------------------------------------------------------ */
/* Deps                                                                */
/* ------------------------------------------------------------------ */

export interface InvestigationRunnerDeps {
  specialists: SpecialistRegistry;
  library_deps: LibraryRoutesDeps;
  llm: LLMRouter;
  inbox?: SpecialistInbox;
  events?: AppEventBus;
  users?: UserRegistry;
  /** Smoke seams — default to the real connectors / critic. */
  search_fn?: typeof web_search.execute;
  fetch_doc_fn?: FetchDocSeams['fetch_doc_fn'];
  fetch_page_fn?: FetchDocSeams['fetch_page_fn'];
  verify_fn?: typeof assess_factual_grounding;
}

/** Build runner deps from the standard ToolDeps bag — shared by the
 *  deep_research tools so the wiring lives in one place. */
export function investigation_runner_deps_from(deps: ToolDeps): InvestigationRunnerDeps {
  return {
    specialists: deps.specialists,
    llm: deps.llm,
    ...(deps.inbox !== undefined ? { inbox: deps.inbox } : {}),
    ...(deps.events !== undefined ? { events: deps.events } : {}),
    ...(deps.users !== undefined ? { users: deps.users } : {}),
    library_deps: {
      db: deps.db,
      vault_root: deps.vault_root,
      memory: deps.memory,
      specialists: deps.specialists,
      runtime: deps.runtime,
      conversations: deps.conversations,
      llm: deps.llm,
      embedder: deps.embedder,
      events: deps.events,
    },
  };
}

function seams_of(deps: InvestigationRunnerDeps): FetchDocSeams {
  return {
    ...(deps.fetch_doc_fn !== undefined ? { fetch_doc_fn: deps.fetch_doc_fn } : {}),
    ...(deps.fetch_page_fn !== undefined ? { fetch_page_fn: deps.fetch_page_fn } : {}),
  };
}

/* ------------------------------------------------------------------ */
/* Bounded-concurrency map (no p-limit in the repo — tiny inline pool) */
/* ------------------------------------------------------------------ */

/**
 * Run `fn` over `items`, at most `limit` in flight, results in input order.
 * Each task is independent; `fn` catches internally so one failure resolves
 * to its own value (a failed SubQuestionResult) rather than rejecting the
 * pool.
 */
async function pooled_map<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, idx: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]!, i);
    }
  };
  const n = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: n }, () => worker()));
  return results;
}

/* ------------------------------------------------------------------ */
/* LLM helpers                                                         */
/* ------------------------------------------------------------------ */

function strip_fence(s: string): string {
  const m = s.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
  return (m ? m[1]! : s).trim();
}

/** One role call; fail-open to null on any error (router/endpoint/throw). */
async function complete_role(
  deps: InvestigationRunnerDeps,
  role_name: LLMRole,
  opts: { system: string; user: string; temperature?: number; max_tokens?: number },
): Promise<string | null> {
  let role;
  try {
    role = deps.llm.for_role(role_name);
  } catch {
    return null;
  }
  try {
    const resp = await role.provider.complete({
      messages: [
        { role: 'system', content: opts.system },
        { role: 'user', content: opts.user },
      ],
      temperature: opts.temperature ?? 0.2,
      max_tokens: opts.max_tokens ?? 1200,
      ...role.defaults,
      // AFTER the spread — a role default must never turn thinking back on.
      // Every caller here JSON.parse()s the reply, and the deep tier
      // (qwen36-35b-a3b) emits its reasoning into `reasoning_content` and
      // exhausts max_tokens, returning EMPTY `content`. The parse then throws
      // into the fail-open catch below, which returns null — a sourceless
      // dossier with no error and no log. Ordering is the whole fix; see
      // media_category.ts for the canonical pattern.
      think: false,
    });
    return resp.content;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Facet packs — how to CARVE each kind of subject                     */
/* ------------------------------------------------------------------ */

/**
 * The decomposition is the whole investigation: a bad carve sends four
 * sub-investigators at the same facet and the dossier answers one thing
 * five times. Only `person` ever had guidance (2026-06-19); `product`,
 * `place`, `decision`, and `general` fell through to the bare "cover
 * complementary facets" line and got whatever the planner improvised —
 * which is why "research any topic" worked in principle and thinly in
 * practice. Every live investigation to date was a person or a product.
 *
 * These are DATA, deliberately: `Record<SubjectKind, string>` makes the
 * table exhaustive, so adding a kind to `SubjectKind` is a compile error
 * until it has a pack. No `if (kind === …)` branch anywhere.
 *
 * ── Why there is no separate `topic` kind ──────────────────────────────
 * Considered and rejected. `general` IS the open-ended slot; a second
 * catch-all would force a small model to choose between two overlapping
 * labels on every call — the arg-garble class the repo's tool-schema rules
 * warn about — and arbitrary routing between two buckets is worse than one
 * well-documented bucket. What the open-question case actually lacked was
 * facet guidance, not a label, so `general` gets the open-topic pack below
 * and the tool's schema now says out loud that it covers a question or a
 * theme. Adding `topic` would also touch the store's kind list, the tool
 * enum, and the route payload for no behavioural gain; the packs are
 * additive and carry zero contract risk.
 */
const FACET_PACKS: Record<SubjectKind, string> = {
  person:
    'For a PERSON, cover complementary facets: professional identity & ' +
    'credentials; public profiles & online presence; affiliation / business / ' +
    'where they practice; reputation & reviews; any public records or notable ' +
    'mentions. Do not pry into private life beyond what is publicly published.',

  // A public figure's record is their PUBLIC conduct, not their biography — the
  // household follows what they do in office, so lead with positions, votes,
  // money, and accountability rather than the résumé. Ruby's Barrett passes kept
  // returning the same four biographical facts (teacher, YIMBY co-founder, two
  // degrees) and nothing about the Flock Safety vote she was actually tracking.
  public_figure:
    'For a PUBLIC FIGURE, cover complementary facets: the office, seat, or role ' +
    'they hold and its term; their stated positions and the record of what they ' +
    'have actually voted for or decided, with dates; funding, endorsements, and ' +
    'declared or apparent conflicts of interest; public statements in their own ' +
    'words; and independent reporting or criticism of their conduct in that role. ' +
    'Biography (schooling, prior jobs) is context, not the point — keep it brief ' +
    'and prefer primary sources: minutes, filings, official rosters, their own ' +
    'published statements. Stay on their PUBLIC conduct; do not assemble personal ' +
    'details about them or their family.',

  product:
    'For a PRODUCT, cover complementary facets: what it actually is and which ' +
    'current model or version the answer applies to; specifications and real ' +
    'measured capability; independent reviews and hands-on testing; price, ' +
    'availability, and cost of ownership over time; known failures, recalls, or ' +
    'recurring complaints; and the closest genuine alternatives. Prefer primary ' +
    'documentation and independent testing over marketing copy, and say when a ' +
    'number comes from the vendor alone.',

  place:
    'For a PLACE, cover complementary facets: what and where it actually is; ' +
    'what being there is like — access, hours, cost, conditions; who runs or ' +
    'governs it and what rules or restrictions apply now; reputation and ' +
    'firsthand accounts; recent changes, closures, or planned work; and safety ' +
    'or seasonal considerations. Anchor every sub-question to the SPECIFIC ' +
    'place the brief names — a same-named place elsewhere is a different subject.',

  decision:
    'For a DECISION, structure the investigation around the choice itself: ' +
    'enumerate the real OPTIONS actually on the table, including doing nothing; ' +
    'establish the CRITERIA that should decide it, taken from the brief rather ' +
    'than invented; test each option against those criteria; surface the ' +
    'TRADEOFFS and what each option costs in money, time, reversibility, and ' +
    'risk; and find what people who already made this choice report afterward. ' +
    'Your job is to gather what someone needs in order to choose, not to pick ' +
    'for them — and to say plainly where the evidence is thin.',

  general:
    'For an OPEN TOPIC or QUESTION, work outward from the question: establish ' +
    'the settled basics and the current state of play; find the strongest ' +
    'available evidence and who produced it; identify where credible sources ' +
    'DISAGREE and why; cover the practical implications for someone in the ' +
    "requester's position; and note what changed recently or is still " +
    'unresolved. Keep consensus, contested, and speculation clearly apart — a ' +
    'confident answer to a genuinely open question is a wrong answer.',
};

/**
 * The planner guidance for a subject kind. Pure; exported for the smoke.
 *
 * No `?? FACET_PACKS.general` fallback: `Record<SubjectKind, string>` is total,
 * so there is nothing to fall back FROM, and a fallback would have contradicted
 * the exhaustiveness argument above by silently relabelling an unknown kind as
 * `general` instead of failing the compile. A bad DB value can't reach here
 * either — `to_row` coerces an unrecognized `subject_kind` to `general` at the
 * store boundary, which is the one right place for that.
 */
export function facet_guidance(kind: SubjectKind): string {
  return FACET_PACKS[kind];
}

/* ------------------------------------------------------------------ */
/* Phase 1 — plan: subject → sub-questions                             */
/* ------------------------------------------------------------------ */

async function plan_investigation(
  deps: InvestigationRunnerDeps,
  row: InvestigationRow,
): Promise<InvestigationPlan> {
  const fallback: InvestigationPlan = {
    sub_questions: [{ id: 'sq_0', question: row.brief }],
  };
  const facet_hint = `\n${facet_guidance(row.subject_kind)}`;
  const anchors =
    row.anchor_facts.length > 0
      ? `\n\nWhat the requester ALREADY KNOWS about this subject (treat as given, and ` +
        `use it to keep every sub-question about THIS specific individual rather than ` +
        `anyone who shares the name):\n` +
        row.anchor_facts.map((f) => `- ${f}`).join('\n')
      : '';
  const content = await complete_role(deps, 'planner', {
    system:
      'You plan a deep-research investigation into a SUBJECT. Decompose it into ' +
      `${fanout_width()} or fewer focused, INDEPENDENT sub-questions a researcher ` +
      'can each answer from public web sources with citations. Cover complementary ' +
      'facets; do not overlap.' +
      facet_hint +
      // The planner types each facet because the planner is the thing that
      // knows what the question IS. A records facet is then routed to record
      // SYSTEMS instead of to a web search — searching the words "property
      // records" returns SEO farms, while the record itself sits in a named
      // county system that has to be queried directly.
      '\n\nTAG EACH SUB-QUESTION with a "kind":\n' +
      '  "records" — the answer is held in a government system: property and ' +
      'ownership, court cases, divorce, liens, judgments, bankruptcy, incarceration, ' +
      'business registration, licensing. These are looked up in courts and county ' +
      'offices, not read off the web.\n' +
      '  "topic"   — everything else: reputation, background, reporting, opinion, ' +
      'products, places, how something works.\n' +
      'When in doubt use "topic".' +
      '\n\nReply with ONLY JSON, nothing else:\n' +
      '{"sub_questions": [{"question": "<one focused question>", "kind": "records|topic", ' +
      '"rationale": "<why it matters>"}]}',
    user:
      `Subject: ${row.subject}\n` +
      `Subject kind: ${row.subject_kind}\n` +
      `What the user wants to know: ${row.brief}${anchors}\n\n` +
      'Reply with ONLY the JSON object.',
    temperature: 0.2,
    max_tokens: 1200,
  });
  if (!content) return fallback;
  try {
    const parsed = JSON.parse(strip_fence(content)) as {
      sub_questions?: Array<{ question?: unknown; rationale?: unknown; kind?: unknown }>;
    };
    if (!Array.isArray(parsed.sub_questions)) return fallback;
    const sub_questions: SubQuestion[] = [];
    for (const raw of parsed.sub_questions.slice(0, fanout_width())) {
      if (typeof raw.question !== 'string' || raw.question.trim().length < 3) continue;
      // Anything the model does not clearly mark `records` is a topic facet:
      // the records path is narrower and more expensive, so an unrecognised
      // value must degrade to the general pipeline, never the specialised one.
      const kind: 'records' | 'topic' =
        typeof raw.kind === 'string' && raw.kind.trim().toLowerCase() === 'records'
          ? 'records'
          : 'topic';
      sub_questions.push({
        id: `sq_${sub_questions.length}`,
        question: raw.question.trim().slice(0, 300),
        kind,
        ...(typeof raw.rationale === 'string' ? { rationale: raw.rationale.slice(0, 300) } : {}),
      });
    }
    return sub_questions.length > 0 ? { sub_questions } : fallback;
  } catch {
    return fallback;
  }
}

/* ------------------------------------------------------------------ */
/* Phase 2 — investigate: one sub-question (the sub-investigator)       */
/* ------------------------------------------------------------------ */

async function plan_sub_queries(
  deps: InvestigationRunnerDeps,
  subject: string,
  sq: SubQuestion,
  anchor_facts: readonly string[] = [],
): Promise<string[]> {
  // Anchors belong IN the query, not just in the prompt. Searching a common
  // name alone is what returned six different strangers for "Josie Kim
  // Reyes"; searching it alongside an employer or a city is what finds the
  // actual person. This is the single highest-leverage use of what the owner
  // told us.
  const anchor_block =
    anchor_facts.length > 0
      ? `\nKnown about this specific subject (WORK THESE INTO THE QUERIES — the name ` +
        `alone is ambiguous):\n${anchor_facts.map((f) => `- ${f}`).join('\n')}`
      : '';
  const content = await complete_role(deps, 'planner', {
    system:
      'Give 2-3 web search queries, phrased the way a person would type them, that ' +
      'would surface sources answering the sub-question about the subject. When known ' +
      'facts are supplied, combine them with the name so the queries target that ONE ' +
      'individual and not everybody who shares the name. Reply with ' +
      'ONLY JSON: {"queries": ["<query>", "<query>"]}',
    user:
      `Subject: ${subject}\nSub-question: ${sq.question}${anchor_block}\n\n` +
      'Reply with ONLY the JSON.',
    temperature: 0.3,
    max_tokens: 300,
  });
  const fallback_terms = anchor_facts.slice(0, 2).join(' ');
  if (!content) {
    return [`${subject} ${fallback_terms} ${sq.question}`.replace(/\s+/g, ' ').slice(0, 200)];
  }
  try {
    const parsed = JSON.parse(strip_fence(content)) as { queries?: unknown };
    if (Array.isArray(parsed.queries)) {
      const qs = parsed.queries
        .filter((q): q is string => typeof q === 'string' && q.trim().length > 2)
        .slice(0, 3)
        .map((q) => q.trim());
      if (qs.length > 0) return qs;
    }
  } catch {
    /* fall through */
  }
  return [`${subject} ${fallback_terms} ${sq.question}`.replace(/\s+/g, ' ').slice(0, 200)];
}

const EXTRACT_SYSTEM =
  'You extract grounded findings to answer a sub-question, using ONLY the labeled ' +
  'sources provided. Each source is labeled [S1], [S2], …. Rules:\n' +
  '- Every finding MUST cite at least one source by its [S#] index (as numbers in ' +
  'source_indices). Never assert a specific the sources do not support.\n' +
  '- If the sources do not answer the sub-question, return an empty findings array.\n' +
  '- Keep each finding a single concrete claim; do not editorialize.\n' +
  '- Every finding MUST carry `quote`: a VERBATIM span, copied character for ' +
  'character out of one of the sources you cited, that states the claim. Copy it, ' +
  'do not paraphrase or tidy it — it is checked against the source text and a ' +
  'quote that is not really there marks your finding as unsound. One sentence is ' +
  'usually right; never fewer than a dozen characters.\n\n' +
  'Reply with ONLY JSON: {"findings": [{"text": "<claim>", "source_indices": [1,2], ' +
  '"quote": "<verbatim span from the cited source>"}]}';

async function extract_findings(
  deps: InvestigationRunnerDeps,
  subject: string,
  sq: SubQuestion,
  sources: Source[],
  texts: string[],
  anchor_facts: readonly string[] = [],
): Promise<SubFinding[]> {
  const labeled = texts
    .map((t, i) => `[S${i + 1}] ${sources[i]?.title ?? sources[i]?.url ?? ''}\n${t}`)
    .join('\n\n----\n\n');
  const anchor_block =
    anchor_facts.length > 0
      ? `\n\nThis subject is specifically the one who: ${anchor_facts.join('; ')}. ` +
        `If a source is plainly about a DIFFERENT person who shares the name, extract ` +
        `nothing from it — a correctly-cited fact about the wrong person is still wrong.`
      : '';
  const content = await complete_role(deps, 'research_extract', {
    system: EXTRACT_SYSTEM,
    user:
      `Subject: ${subject}\nSub-question: ${sq.question}${anchor_block}\n\n` +
      `Sources:\n${labeled}\n\n` +
      'Reply with ONLY the JSON.',
    temperature: 0.2,
    max_tokens: 1400,
  });
  if (!content) return [];
  try {
    const parsed = JSON.parse(strip_fence(content)) as {
      findings?: Array<{ text?: unknown; source_indices?: unknown; quote?: unknown }>;
    };
    if (!Array.isArray(parsed.findings)) return [];
    const out: SubFinding[] = [];
    for (const raw of parsed.findings) {
      if (typeof raw.text !== 'string' || raw.text.trim().length < 3) continue;
      const idx = Array.isArray(raw.source_indices)
        ? raw.source_indices
            .filter((n): n is number => typeof n === 'number' && n >= 1 && n <= sources.length)
            .slice(0, 6)
        : [];
      if (idx.length === 0) continue; // a finding with no valid citation is dropped
      // A missing quote is NOT a reason to drop the finding — the field is
      // additive and the check downstream fails open on its absence. Dropping
      // here would make a model that ignores one new prompt line silently
      // return nothing at all.
      const quote =
        typeof raw.quote === 'string' && raw.quote.trim().length > 0
          ? raw.quote.trim().slice(0, 600)
          : undefined;
      out.push({
        text: raw.text.trim().slice(0, 600),
        source_indices: [...new Set(idx)],
        ...(quote ? { quote } : {}),
      });
    }
    return out;
  } catch {
    return [];
  }
}

/** What a sub-investigator needs to persist its bodies under the right row
 *  and the right cordon. */
interface SubInvestigationTarget {
  investigation_id: string;
  subject: string;
  /** PERSON_SUBJECT_KINDS membership, resolved by the caller. */
  is_person_subject: boolean;
  private_to: string | null;
  sources_store: ResearchSourcesStore;
  /** Owner-supplied disambiguators; steer the queries and the extractor. */
  anchor_facts: readonly string[];
  /**
   * The county/state that actually holds the records, resolved once per slice.
   * null when none could be established — records facets then say so instead of
   * guessing, which is what put a Pleasantville page in a Texas investigation.
   */
  jurisdiction: Jurisdiction | null;
  /** Attribute set built from the owner's facts; separates same-NAME from
   *  same-PERSON where the name gate cannot. */
  anchor: IdentityAnchor;
  /**
   * Ceiling on what a fetch may disclose. `passive` for every person subject:
   * researching someone must not tell them they are being researched.
   */
  attribution_cap: AttributionTier | undefined;
  /**
   * What this facet may still spend out of the INVESTIGATION-level budget
   * (v2 phase 5). Divided across the facets in this pass by the caller, so one
   * greedy facet cannot eat an exhaustive run's whole allowance.
   */
  budget_room: { sources: number; rounds: number };
  /** Agentic follow-up rounds this facet may spend, from the depth budget. */
  rounds_per_facet: number;
}

/**
 * The investigator's own judgement between rounds (v2 phase 4).
 *
 * Given what it has read and what it has established, decide whether this facet
 * is done or what to reach for next. This is the agency: the model, not a fixed
 * pipeline, decides that the answer is one link deeper or that the query was
 * wrong — and it may also decide the facet is genuinely unanswerable, which is
 * a real, useful verdict rather than an empty section.
 *
 * FAIL-CLOSED to `stop`. An unparseable or missing decision leaves the facet
 * exactly where round 0 left it, which is the pre-phase-4 behaviour — a
 * confused model must not be able to spend budget on a guess.
 */
type NextStep =
  | { next: 'stop'; assessment: string; confidence: number }
  | { next: 'search'; queries: string[]; assessment: string; confidence: number }
  | { next: 'follow'; urls: string[]; assessment: string; confidence: number };

async function decide_next_step(
  deps: InvestigationRunnerDeps,
  subject: string,
  sq: SubQuestion,
  sources: readonly Source[],
  findings: readonly SubFinding[],
): Promise<NextStep | null> {
  const found =
    findings.length > 0
      ? findings.map((f, i) => `${i + 1}. ${f.text}`).join('\n')
      : '(nothing established yet)';
  const read = sources.map((s, i) => `[S${i + 1}] ${s.title ?? ''} ${s.url}`).join('\n');
  const content = await complete_role(deps, 'planner', {
    system:
      'You are mid-investigation on ONE question. Decide the next move. Reply with ONLY JSON.\n' +
      '{"assessment":"answered|partial|unanswerable","confidence":0.0-1.0,' +
      '"next":"stop|search|follow","queries":["..."],"urls":["..."]}\n\n' +
      'Use "stop" when the question is answered, or when you are confident no further ' +
      'reading will help — an honest "unanswerable" is a good outcome, not a failure.\n' +
      'Use "search" with 1-3 DIFFERENT queries when your earlier wording was the problem. ' +
      'Do not repeat a query you already ran.\n' +
      'Use "follow" with URLs that appear VERBATIM in the sources you read, when the ' +
      'answer is clearly one link deeper. Never invent a URL — a URL not present in the ' +
      'text will be discarded.',
    user:
      `Subject: ${subject}\nQuestion: ${sq.question}\n\n` +
      `Sources read:\n${read || '(none)'}\n\nEstablished so far:\n${found}\n\n` +
      'Reply with ONLY the JSON object.',
    temperature: 0.2,
    max_tokens: 500,
  });
  if (!content) return null;
  try {
    const p = JSON.parse(strip_fence(content)) as {
      next?: unknown;
      queries?: unknown;
      urls?: unknown;
      assessment?: unknown;
      confidence?: unknown;
    };
    const assessment = typeof p.assessment === 'string' ? p.assessment : 'partial';
    const confidence = typeof p.confidence === 'number' ? p.confidence : 0;
    const strings = (v: unknown): string[] =>
      Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.length > 2) : [];
    if (p.next === 'search') {
      return { next: 'search', queries: strings(p.queries), assessment, confidence };
    }
    if (p.next === 'follow') {
      return { next: 'follow', urls: strings(p.urls), assessment, confidence };
    }
    return { next: 'stop', assessment, confidence };
  } catch {
    return null;
  }
}

async function investigate_sub_question(
  deps: InvestigationRunnerDeps,
  ctx: ToolContext,
  sq: SubQuestion,
  target: SubInvestigationTarget,
  deadline: number,
): Promise<SubQuestionResult> {
  const subject = target.subject;
  const base = { sub_question_id: sq.id, question: sq.question };
  const search_fn = deps.search_fn ?? web_search.execute.bind(web_search);
  /** A facet we did not get to LOOK at. Distinct from `failed` (we looked and
   *  the sources do not answer it) — only this kind is resumable, and
   *  collapsing the two is what made six-facet briefs lose facets silently. */
  const not_attempted = (note: string): SubQuestionResult => ({
    ...base,
    status: 'not_attempted',
    findings: [],
    sources: [],
    note,
  });

  // The slice's clock can already be spent before this sub-question's turn in
  // the pool comes up — that is the F1 arithmetic, and it must be RECORDED as
  // "not attempted", never reported as an absence of answers.
  if (Date.now() > deadline) {
    return not_attempted('slice deadline reached before this facet was attempted');
  }

  // 0. RECORDS FIRST (2026-07-31). A records facet asks a government system a
  // question; only one tier of that stack answers in a single call, so it runs
  // before any web search and its answers are real records rather than pages
  // that rank for the phrase "court records".
  const kind: InvestigatorKind = sq.kind === 'records' && records_enabled() ? 'records' : 'topic';
  const records_findings: SubFinding[] = [];
  const records_sources: Source[] = [];
  if (kind === 'records' && target.is_person_subject) {
    try {
      const cl = await courtlistener_search.execute(
        { query: `"${subject}"`, type: 'dockets', max_results: 8 },
        ctx,
      );
      if (!cl.error && cl.results.length > 0) {
        for (const r of cl.results) {
          records_sources.push({ url: r.url, title: r.case_name, fetched_ok: true });
          const where = [r.court, r.docket_number].filter(Boolean).join(', ');
          const when = r.date_filed ? ` filed ${r.date_filed}` : '';
          const chapter = r.chapter ? ` (Chapter ${r.chapter})` : '';
          records_findings.push({
            text:
              `Federal court record: ${r.case_name}${chapter} — ${where}${when}. ` +
              `Party name matched; whether this is the SUBJECT or another person of ` +
              `the same name is not established by the docket alone.`,
            // 1-based [S#] index — this source was just pushed, so its index is
            // the new length.
            source_indices: [records_sources.length],
          });
        }
      }
    } catch (err) {
      // Fail-open — a records lookup outage must not sink the facet; the web
      // pass below still runs.
      console.error(`[deep-research] courtlistener failed:`, (err as Error).message);
    }
  }

  // 1. queries → search → dedup hits
  const records_plan =
    kind === 'records'
      ? plan_records_queries(subject, sq.question, target.jurisdiction, target.anchor_facts)
      : null;
  const queries = records_plan
    ? records_plan.queries
    : await plan_sub_queries(deps, subject, sq, target.anchor_facts);
  const hits: Array<{ title: string; url: string; snippet: string }> = [];
  // Track the two states separately. `search_ok` USED to be set on any
  // non-error response — including one with ZERO results — so a total search
  // outage (every query returning `{results: [], error: undefined}`, which is
  // exactly what a rate-limited or capped provider produced) marked the backend
  // healthy, skipped the guard below, and let the runner write a confident
  // report with no sources at all. The guard could never fire during the
  // outage it exists to catch.
  let any_error: string | undefined;
  let any_results = false;
  for (const query of queries) {
    if (Date.now() > deadline) break;
    const resp = await search_fn({ query, max_results: SEARCH_RESULTS }, ctx);
    if (resp.error) {
      any_error ??= resp.error;
      continue;
    }
    if (resp.results.length > 0) any_results = true;
    for (const hit of resp.results) {
      if (!hits.some((h) => h.url === hit.url)) hits.push(hit);
    }
  }
  if (!any_results && hits.length === 0) {
    // Distinguish "search is DOWN" from "the web genuinely has nothing on this
    // subject". Both end the investigation, but they are different facts and
    // must not be reported as the same one: calling a real no-hits result an
    // outage cries wolf on obscure subjects, and calling an outage a no-hits
    // result is the silent failure this whole fix is about. The router now
    // surfaces a real outage as an `error` (SearXNG answering 200 with zero
    // results AND every engine unresponsive), which is what `any_error` sees.
    //
    // A backend OUTAGE is not_attempted (resumable — we never got to look); a
    // healthy backend with genuinely nothing to show is a real, terminal
    // `failed` for this facet.
    // A records facet can be ANSWERED with nothing from the web: the court
    // system already replied. Reporting "nothing found" over real dockets would
    // be the same lie in a new place.
    if (records_findings.length > 0) {
      return {
        ...base,
        status: 'partial',
        findings: records_findings,
        sources: records_sources,
        note: 'answered from court records; no usable web sources',
      };
    }
    if (any_error) return not_attempted(`search backend unavailable: ${any_error}`);
    return {
      ...base,
      status: 'failed',
      findings: [],
      sources: [],
      note: 'no search results for this subject (search was healthy; the web returned nothing)',
    };
  }

  // RANK before spending the fetch budget. Aggregators and name-etymology sites
  // go last in every investigation; for a records facet official hosts go
  // first. The failed run spent three of its slots on a Bible dictionary, a
  // baby-name site and a Honda forum — all of which this drops to the back.
  const ranked = rank_source_hits(hits, { kind, jurisdiction: target.jurisdiction });
  hits.length = 0;
  hits.push(...ranked);

  // 2. fetch top sources (readable text only; [S#] maps to this order)
  const sources: Source[] = [];
  const texts: string[] = [];
  let fetch_failures = 0;
  let deferred = 0;
  let deadline_hit = false;
  const dropped_sources: Array<{ url: string; title: string | null; reason: string }> = [];
  const refused_sources: Array<{ url: string; title: string | null; reason: string }> = [];
  const gate_identity = name_anchor_applies(target.is_person_subject, subject);
  /** Anchor checking only engages when the OWNER supplied facts to check
   *  against. No facts → no anchor → today's behaviour exactly. */
  const gate_anchor = gate_identity && target.anchor.attributes.length > 0;
  /** Every URL we have already decided about — read, dropped or refused. An
   *  agentic round must never re-fetch what it has already seen. */
  const seen_urls = new Set<string>();

  /**
   * Read a batch of hits through the FULL guarded path, appending to the shared
   * source/text/dropped/refused state.
   *
   * PHASE 4 (2026-07-31) exists because of this function. The design called for
   * making each sub-question a delegated agent turn on the `delegate` spine —
   * but a raw agent turn would call web_search and browse_url ITSELF, which
   * routes around every guard this subsystem is made of: the attribution cap,
   * the name gate, the identity anchor, and source persistence. Handing an
   * agent the wheel would have re-opened the exact failures phases 1-3 closed.
   *
   * So the agency is real but it is EXERCISED THROUGH THIS DOOR: the model
   * chooses what to read next, and every choice is fetched here, gated here and
   * persisted here. That is "the model determines intent, spends a tool call,
   * acts on the result" without a hole in the safety layer.
   *
   * Returns how many sources were actually READ.
   */
  const consume_hits = async (
    batch: ReadonlyArray<{ title: string; url: string; snippet: string }>,
    cap: number,
  ): Promise<number> => {
  let read_here = 0;
  for (const hit of batch) {
    if (read_here >= cap) break;
    if (seen_urls.has(hit.url)) continue;
    seen_urls.add(hit.url);
    if (Date.now() > deadline) {
      deadline_hit = true;
      break;
    }
    const fetched = await fetch_document(seams_of(deps), ctx, hit.url, hit.title, {
      ...(target.attribution_cap !== undefined
        ? { attribution_cap: target.attribution_cap }
        : {}),
    });
    // Refused on attribution grounds: reachable, deliberately not read. Kept
    // separate from a failure so the dossier can say we CHOSE not to look.
    if (fetched.kind === 'failed' && fetched.refused) {
      refused_sources.push({ url: hit.url, title: hit.title, reason: fetched.refused.reason });
      continue;
    }
    if (fetched.kind === 'markdown' && fetched.attribution_capped) {
      // We kept an anonymous-only read of a host whose full render would have
      // been traceable. Record it — the text may be a login shell, and the
      // reader must not mistake a shell for the absence of a profile.
      refused_sources.push({
        url: hit.url,
        title: hit.title,
        reason: fetched.attribution_capped.reason,
      });
    }
    if (fetched.kind === 'markdown' && fetched.markdown.trim().length > 80) {
      const title = fetched.title ?? hit.title;

      // A county portal is the RIGHT place and still cannot be read by us.
      // Recorded honestly rather than extracted from, because extracting from
      // a search form yields "no records found" — a false negative about
      // someone's court history, which is the worst output this system can
      // produce. We do not solve CAPTCHAs, ever.
      if (kind === 'records' && looks_captcha_walled(fetched.markdown)) {
        dropped_sources.push({
          url: hit.url,
          title,
          reason:
            'the authoritative portal is CAPTCHA-walled — we do not bypass CAPTCHAs, so ' +
            'this lookup needs a person. The record is public and it is at this URL.',
        });
        continue;
      }
      if (kind === 'records' && looks_like_search_form(fetched.markdown)) {
        dropped_sources.push({
          url: hit.url,
          title,
          reason:
            'this is the authoritative record system but it served a search FORM, not ' +
            'results — an automated fetch cannot run the query. The right place to look.',
        });
        continue;
      }

      // NAME ANCHORING (2026-07-30). A source that never names the subject is
      // not about the subject. The "Josie Kim Reyes" investigation read
      // fourteen pages, not one of which contained her full name, and shipped a
      // stranger's career as her biography — because nothing between the search
      // and the dossier ever asked whether the page was about the right person.
      // The body is still PERSISTED (it is evidence of what we read), it simply
      // never reaches the extractor and can never be cited.
      if (gate_identity) {
        const verdict = source_mentions_subject(fetched.markdown, subject);
        if (!verdict.mentions) {
          dropped_sources.push({ url: hit.url, title, reason: verdict.reason });
          try {
            target.sources_store.record({
              investigation_id: target.investigation_id,
              sub_question_id: sq.id,
              url: hit.url,
              title,
              body: fetched.markdown,
              private_to: target.private_to,
            });
          } catch {
            /* fail-open — the evidence trail is never load-bearing */
          }
          continue;
        }
      }

      // IDENTITY ANCHOR (2026-07-31). The name gate is a NECESSARY condition
      // and says so; this is the sufficient half. "Daniel Torres" is common
      // enough that sources genuinely name him — the Spokeo page names 412 of
      // him, in Virginia, while the subject is anchored to Georgetown, Texas.
      // A name gate passes that page. Only an attribute check refuses it.
      //
      // Only `conflicting` is refused, and only when the owner supplied facts
      // to conflict WITH. `unconfirmed` is kept: a thin directory entry that
      // corroborates nothing is normal and usually still about the right
      // person. This is the same class as the name gate — a source
      // affirmatively placed somewhere the subject is not — so it is refused
      // at the investigator rather than flagged downstream, where "flag, don't
      // drop" governs CLAIMS in the dossier.
      if (gate_anchor) {
        const assessment = source_corroborates_anchor(fetched.markdown, target.anchor);
        if (assessment.verdict === 'conflicting') {
          dropped_sources.push({ url: hit.url, title, reason: assessment.reason });
          try {
            target.sources_store.record({
              investigation_id: target.investigation_id,
              sub_question_id: sq.id,
              url: hit.url,
              title,
              body: fetched.markdown,
              private_to: target.private_to,
            });
          } catch {
            /* fail-open — the evidence trail is never load-bearing */
          }
          continue;
        }
      }

      sources.push({ url: hit.url, title, fetched_ok: true });
      texts.push(fetched.markdown.slice(0, SOURCE_CHAR_CAP));
      read_here++;
      // PERSIST THE BODY (v2 phase 1). The extractor below only ever sees
      // SOURCE_CHAR_CAP characters and then the text was gone forever — which
      // is why verification had no corpus to grade against, a page's own
      // publication date was unrecoverable, and no quote could be anchored.
      // Fail-open: an investigation must never die because the evidence trail
      // could not be written.
      try {
        target.sources_store.record({
          investigation_id: target.investigation_id,
          sub_question_id: sq.id,
          url: hit.url,
          title,
          body: fetched.markdown,
          private_to: target.private_to,
        });
      } catch (err) {
        console.error(
          `[deep-research] source persist failed for ${hit.url}:`,
          (err as Error).message,
        );
      }
    } else {
      // `deferred` is the fetcher saying "try later" (the browser host was
      // busy, an activity blocker was up) — categorically different from a page
      // that will never render. Counted separately so a facet lost to
      // backpressure stays RESUMABLE.
      if (fetched.kind === 'deferred') deferred++;
      fetch_failures++;
    }
  }
  return read_here;
  };

  // Round 0: the planned queries, ranked.
  await consume_hits(hits, Math.min(fetch_per_sq(), target.budget_room.sources));

  if (sources.length === 0) {
    // Court records answered even though the web did not. Report the records.
    if (records_findings.length > 0) {
      return {
        ...base,
        status: 'partial',
        findings: records_findings,
        sources: records_sources,
        ...(dropped_sources.length > 0 ? { dropped_sources } : {}),
        ...(refused_sources.length > 0 ? { refused_sources } : {}),
        note: 'answered from court records; no web source could be read',
      };
    }
    // Everything worth reading was refused on attribution grounds. NOT a
    // failure — a deliberate limit, and the reader must be told which.
    if (refused_sources.length > 0 && dropped_sources.length === 0) {
      return {
        ...base,
        status: 'failed',
        findings: [],
        sources: [],
        refused_sources,
        note:
          `the readable sources for this facet were all ones we chose not to open, because ` +
          `fetching them would have been traceable to this household — ` +
          `${refused_sources[0]!.reason}`,
      };
    }
    // Ran out of clock, or everything was deferred, with readable hits still in
    // the queue → we never got to look, so this is resumable.
    if (deadline_hit) {
      return not_attempted('slice deadline reached before any source for this facet could be read');
    }
    if (deferred > 0) {
      return not_attempted(
        `every source for this facet was deferred (${deferred}) — the fetcher asked to be retried later`,
      );
    }
    // Every readable source was about somebody else. NOT resumable — retrying
    // finds the same strangers — and emphatically not the same statement as
    // "no answer found", which is what this used to say while the dossier went
    // on to describe one of them.
    if (dropped_sources.length > 0) {
      return {
        ...base,
        status: 'failed',
        findings: [],
        sources: [],
        dropped_sources,
        note:
          `read ${dropped_sources.length} source(s), none of which are about ${subject} — ` +
          `${dropped_sources[0]!.reason}. No answer can be grounded without a source about ` +
          `the right person.`,
      };
    }
    return { ...base, status: 'failed', findings: [], sources: [], note: 'no sources could be read' };
  }

  // 3. extract cited findings (deep tier — the one pooled call)
  let web_findings = await extract_findings(deps, subject, sq, sources, texts, target.anchor_facts);

  // 4. AGENTIC ROUNDS (v2 phase 4, 2026-07-31).
  //
  // Until now a sub-investigator was a FIXED pipeline: one query plan, K
  // fetches, one extraction, done. It could not notice that the answer was one
  // link deeper, that its query was wrong, or that a page had redirected to a
  // form. That is the depth phase 4 is for — but see `consume_hits` above for
  // why it is not the delegated agent turn the design first proposed.
  //
  // Every round is the model deciding, and every fetch it asks for goes back
  // through the same guarded door.
  let rounds_spent = 0;
  const max_rounds_here = Math.min(target.rounds_per_facet, target.budget_room.rounds);
  while (
    rounds_spent < max_rounds_here &&
    Date.now() < deadline &&
    sources.length < target.budget_room.sources
  ) {
    const step = await decide_next_step(deps, subject, sq, sources, web_findings);
    if (!step || step.next === 'stop') break;

    let batch: Array<{ title: string; url: string; snippet: string }> = [];
    if (step.next === 'search' && step.queries.length > 0) {
      for (const q of step.queries.slice(0, 3)) {
        if (Date.now() > deadline) break;
        const resp = await search_fn({ query: q, max_results: SEARCH_RESULTS }, ctx);
        if (resp.error) continue;
        for (const hit of resp.results) {
          if (!batch.some((h) => h.url === hit.url)) batch.push(hit);
        }
      }
    } else if (step.next === 'follow' && step.urls.length > 0) {
      // A followed link must LITERALLY APPEAR in something we actually read.
      // Without this the model can invent a plausible URL and we would fetch
      // it — manufacturing a source out of nothing, which is the fabrication
      // class this whole subsystem exists to prevent. The text is the proof.
      const corpus = texts.join('\n');
      for (const u of step.urls.slice(0, 5)) {
        if (!corpus.includes(u)) continue;
        batch.push({ title: '', url: u, snippet: '' });
      }
    }
    if (batch.length === 0) break;

    const added = await consume_hits(
      rank_source_hits(batch, { kind, jurisdiction: target.jurisdiction }),
      Math.min(fetch_per_sq(), target.budget_room.sources - sources.length),
    );
    rounds_spent++;
    // Nothing NEW could be read — every candidate was already seen, refused or
    // unreadable. Another round would ask the same question of the same
    // corpus, so stop rather than spin (this is what keeps an agentic loop
    // from becoming the stall the watchdog then has to catch).
    if (added === 0) break;
    // Re-extract over ALL sources, including the ones round 0 read — so a later
    // round can only ever see MORE. But `extract_findings` fails open to `[]`
    // on an LLM outage or an unparseable reply, and assigning that straight
    // back would DESTROY good round-0 findings because the agentic loop tried
    // to improve on them. Keep the richer result: agency may add, never
    // subtract.
    const re_extracted = await extract_findings(
      deps,
      subject,
      sq,
      sources,
      texts,
      target.anchor_facts,
    );
    if (re_extracted.length >= web_findings.length) web_findings = re_extracted;
  }

  // Merge the two source lists. [S#] is a 1-based index into `sources`, and the
  // extractor numbered against the WEB list alone, so every web citation shifts
  // by however many court records lead the array. Getting this wrong would
  // silently re-point citations at the wrong source — the exact class of bug
  // this whole workstream exists to kill, so it is done once, here.
  const offset = records_sources.length;
  const all_sources = [...records_sources, ...sources];
  const all_findings: SubFinding[] =
    offset === 0
      ? // The overwhelming common case (no court records led this facet).
        // Short-circuited so a topic facet is byte-identical to before.
        [...records_findings, ...web_findings]
      : [
          ...records_findings,
          ...web_findings.map((f) => ({
            ...f,
            source_indices: (f.source_indices ?? []).map((c) => c + offset),
          })),
        ];

  const status: SubQuestionResult['status'] =
    all_findings.length === 0 ? 'partial' : fetch_failures > 0 ? 'partial' : 'ok';
  return {
    ...base,
    status,
    findings: all_findings,
    sources: all_sources,
    ...(dropped_sources.length > 0 ? { dropped_sources } : {}),
    ...(refused_sources.length > 0 ? { refused_sources } : {}),
    ...(rounds_spent > 0 ? { rounds_spent } : {}),
    ...(all_findings.length === 0 ? { note: 'sources read but no grounded answer found' } : {}),
  };
}

/* ------------------------------------------------------------------ */
/* Phase 3 — verify: adversarial grounding re-check                    */
/* ------------------------------------------------------------------ */

async function verify_investigation(
  deps: InvestigationRunnerDeps,
  row: InvestigationRow,
): Promise<VerificationResult> {
  const all_findings = row.findings.flatMap((r) => r.findings.map((f) => f.text));
  const claims_checked = all_findings.length;
  if (claims_checked === 0) {
    return { claims_checked: 0, verdicts: [], dropped_claims: [] };
  }
  // Evidence = the readable source texts the sub-investigators gathered. We
  // re-derive a compact evidence corpus from the finding citations: the
  // sources are recorded per sub-question (titles + urls); the FINDINGS
  // themselves are the claim text. The critic judges the candidate claims
  // against the gathered evidence. (Source bodies aren't persisted, so the
  // evidence corpus is the finding set + source titles — a claim that no
  // sub-investigator could ground reads as unsupported here too.)
  const evidence_sources: string[] = [];

  // v2 PHASE 3 (2026-07-31) — grade claims against SOURCE TEXT, not against
  // themselves.
  //
  // The corpus used to be built from `f.text`, and `candidate` IS those same
  // findings, so every claim was trivially "supported by" itself and
  // `unsupported` came back empty essentially always: the Barrett dossier
  // recorded `claims_checked: 4, verdicts: []` while carrying a plainly false
  // claim. Phase 1 persisted the bodies; this reads them, which is the whole
  // point of having persisted them.
  //
  // Bodies are capped per source so a wide investigation cannot blow the
  // critic's context. Fail-open to the old finding-derived corpus if the store
  // is unreadable — a verifier outage must never stop a dossier.
  let body_chars = 0;
  try {
    const bodies = new ResearchSourcesStore(deps.library_deps.db).list_for_investigation(row.id);
    for (const b of bodies) {
      if (body_chars >= VERIFY_CORPUS_CAP) break;
      const slice = b.body_md.slice(0, VERIFY_SOURCE_CAP);
      body_chars += slice.length;
      evidence_sources.push(`${b.title ?? b.url}\n${slice}`);
    }
  } catch (err) {
    console.error('[deep-research] verify corpus read failed:', (err as Error).message);
  }
  if (evidence_sources.length === 0) {
    for (const r of row.findings) {
      for (const s of r.sources) evidence_sources.push(`${s.title ?? ''} (${s.url})`);
      for (const f of r.findings) evidence_sources.push(f.text);
    }
  }

  // FULL bodies, keyed by url, for the two checks that must not read a slice:
  // quote containment (a truncated body would flag a real quote as fabricated
  // the moment SOURCE_CHAR_CAP rose above VERIFY_SOURCE_CAP — a silent coupling
  // between two unrelated constants) and the adversarial pass, which does its
  // own bounded slicing.
  let full_bodies: Array<{ url: string; title: string | null; body: string }> = [];
  try {
    full_bodies = new ResearchSourcesStore(deps.library_deps.db)
      .list_for_investigation(row.id)
      .filter((b) => typeof b.body_md === 'string' && b.body_md.trim().length > 0)
      .map((b) => ({ url: b.url, title: b.title, body: b.body_md }));
  } catch {
    full_bodies = []; // fail-open — every check below treats [] as "not checked"
  }
  const grounding = build_grounding_context({ tool_results: evidence_sources });
  const evidence_text = build_grounding_evidence({ tool_results: evidence_sources });
  const candidate = all_findings.join('\n');

  const verify = deps.verify_fn ?? assess_factual_grounding;
  let unsupported: Array<{ claim: string; reason: string }> = [];
  try {
    const res = await verify({ reply: candidate, grounding, evidence_text, llm: deps.llm });
    unsupported = res.unsupported.map((u) => ({ claim: u.claim, reason: u.reason }));
  } catch {
    unsupported = []; // fail-open: a critic outage never fabricates a drop
  }
  // Deterministic temporal check — no LLM, no evidence corpus needed, and it
  // catches the class that shipped: a date in the FUTURE stated as settled
  // history ("re-elected in November 2029", written in July 2026). These are
  // FLAGGED, never dropped: the underlying fact is usually right and only the
  // tense is wrong, so scrubbing the sentence would lose real reporting.
  const temporal = temporal_inconsistencies(all_findings, new Date());

  // Identity disambiguation — see identity_conflicts. Only meaningful for a
  // person, where a same-name stranger is the live risk.
  const identity =
    row.subject_kind === 'person'
      ? identity_conflicts(all_findings, identity_anchor_places(row.brief, row.subject))
      : [];

  // QUOTE-ANCHORING (design §3.5 rung 2). The cheapest honest check in the
  // stack and the only one with NO judgement in it: the extractor copied a
  // verbatim span out of a source; confirm by string containment that the span
  // is actually there. Same primitive as Ruby's write-side evidence_quote gate.
  const unquoted = check_quote_anchors(row, full_bodies);

  // ADVERSARIAL PASS (design §3.5 rung 3). The grounding critic asks "is this
  // supported?"; this asks the opposite — "using ONLY these bodies, can you
  // REFUTE it?" — which is what catches a claim one source supports and another
  // contradicts. Only over claims the cheaper checks left standing, and only
  // when there is a real corpus to refute FROM. Fail-open at every step.
  const already = new Set([
    ...unsupported.map((u) => u.claim),
    ...temporal.map((t) => t.claim),
    ...identity.map((i) => i.claim),
    ...unquoted.map((q) => q.claim),
  ]);
  const survivors = all_findings.filter((c) => !already.has(c));
  const refuted =
    full_bodies.length > 0 && survivors.length > 0
      ? await refute_claims(deps, row.subject, survivors, full_bodies)
      : [];

  return {
    claims_checked,
    verdicts: [
      ...unsupported.map((u) => ({
        claim: u.claim,
        verdict: 'unverified' as const,
        reason: u.reason,
      })),
      ...temporal.map((t) => ({
        claim: t.claim,
        verdict: 'unverified' as const,
        reason: t.reason,
      })),
      ...identity.map((i) => ({
        claim: i.claim,
        verdict: 'unverified' as const,
        reason: i.reason,
      })),
      ...unquoted.map((q) => ({
        claim: q.claim,
        verdict: 'unverified' as const,
        reason: q.reason,
      })),
      ...refuted.map((r) => ({
        claim: r.claim,
        verdict: 'contradicted' as const,
        reason: r.reason,
      })),
    ],
    // FLAG, DON'T DROP (design §7). The corpus above just made this verifier
    // able to fail for the first time — which also makes it able to fail
    // WRONGLY for the first time, and `dropped_claims` feeds
    // `scrub_dropped_claims`, which DELETES lines out of a real dossier a human
    // is going to act on. A false positive there silently removes true
    // reporting, and nobody can tell it happened.
    //
    // So unsupported claims are SURFACED as verdicts (the reader sees the
    // warning next to the claim) and dropped only once precision has been
    // measured against real dossiers. Flip HEARTH_RESEARCH_VERIFY_DROP=1 to
    // enable deletion after that.
    dropped_claims: verify_drops_enabled() ? unsupported.map((u) => u.claim) : [],
  };
}

/**
 * Quote-anchoring (design §3.5 rung 2): confirm each finding's verbatim span is
 * really in a source it cited. PURE given the bodies, so the smoke pins it.
 *
 * Every step FAILS OPEN, each for its own reason:
 *   - no `quote` → not checked. The field is additive; a model that ignores the
 *     new prompt line must not have its whole dossier flagged.
 *   - no persisted body for a cited url → not checked. We cannot tell "the
 *     quote is fake" from "we never kept the page", and guessing turns a
 *     retention-window expiry into a wall of red.
 *   - below MIN_QUOTE_CHARS → not checked. A span too short to CERTIFY anything
 *     must not be able to CONDEMN anything.
 *
 * A flag therefore means the strong thing only: we kept the page, the model
 * claimed a span from it, and the span is not there.
 */
export function check_quote_anchors(
  row: InvestigationRow,
  bodies: Array<{ url: string; title: string | null; body: string }>,
): Array<{ claim: string; reason: string }> {
  if (bodies.length === 0) return [];
  const by_url = new Map(bodies.map((b) => [b.url, b.body]));
  const out: Array<{ claim: string; reason: string }> = [];
  for (const r of row.findings) {
    for (const f of r.findings) {
      const quote = f.quote?.trim();
      if (!quote || normalize_for_quote(quote).length < MIN_QUOTE_CHARS) continue;
      // Against the sources this finding actually CITED — a quote found in some
      // other page in the corpus is not evidence for THIS claim.
      const cited = f.source_indices
        .map((i) => r.sources[i - 1]?.url)
        .filter((u): u is string => typeof u === 'string');
      const evidence = cited
        .map((u) => by_url.get(u))
        .filter((b): b is string => typeof b === 'string');
      if (evidence.length === 0) continue;
      if (quote_in_evidence(quote, evidence)) continue;
      out.push({
        claim: f.text,
        reason:
          `the quote offered as evidence is not in the source it cites — ` +
          `"${quote.slice(0, 120)}${quote.length > 120 ? '…' : ''}" does not appear in ` +
          `${cited[0]}`,
      });
    }
  }
  return out;
}

/** Claims and bodies sent to one adversarial pass — bounded so the prompt fits
 *  the role's context alongside the corpus. */
const MAX_REFUTE_CLAIMS = 24;
const MAX_REFUTE_SOURCES = 6;

/**
 * Try to REFUTE each surviving claim from the persisted bodies (design §3.5
 * rung 3). Returns only claims the corpus actively CONTRADICTS — "not
 * mentioned" is not a refutation, and saying so in the prompt is load-bearing:
 * most claims are supported by one source and unmentioned by the rest, so
 * treating silence as contradiction flags an entire honest dossier.
 *
 * Runs on the deep tier (forza's 122B via `deep_consult`) — deep research is
 * DETACHED, so it tolerates latency interactive chat does not, and both the LLM host
 * cards are near capacity serving chat/voice. Fail-open everywhere.
 */
async function refute_claims(
  deps: InvestigationRunnerDeps,
  subject: string,
  claims: string[],
  bodies: Array<{ url: string; title: string | null; body: string }>,
): Promise<Array<{ claim: string; reason: string }>> {
  const numbered = claims.slice(0, MAX_REFUTE_CLAIMS).map((c, i) => `${i + 1}. ${c}`).join('\n');
  const corpus = bodies
    .slice(0, MAX_REFUTE_SOURCES)
    .map(
      (b, i) =>
        `--- SOURCE ${i + 1}: ${b.title ?? b.url} (${b.url})\n${b.body.slice(0, VERIFY_SOURCE_CAP)}`,
    )
    .join('\n\n');
  const content = await complete_role(deps, 'deep_consult', {
    system:
      'You are an adversarial fact-checker. You try to REFUTE claims using only ' +
      'the sources given. You answer with JSON only.',
    user:
      `Subject: "${subject}".\n\nCLAIMS:\n${numbered}\n\nSOURCES:\n${corpus}\n\n` +
      `For each claim, try to REFUTE it using ONLY the sources above. Report a ` +
      `claim ONLY when a source states something that CONTRADICTS it — a ` +
      `different number, date, employer, title, or outcome for the same thing.\n\n` +
      `A claim the sources simply do not mention is NOT refuted. A claim ` +
      `supported by one source and unmentioned by the others is NOT refuted. ` +
      `Silence is never a contradiction. If you refute nothing, return an empty ` +
      `array — that is the expected answer for a sound dossier.\n\n` +
      `Answer with ONLY: {"refuted":[{"index":<1-based claim number>,` +
      `"reason":"<the contradicting statement and which source it came from>"}]}`,
    temperature: 0.1,
    max_tokens: 700,
  });
  if (content === null) return [];
  try {
    const parsed: unknown = JSON.parse(strip_fence(content).trim());
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return [];
    const arr = (parsed as { refuted?: unknown }).refuted;
    if (!Array.isArray(arr)) return [];
    const out: Array<{ claim: string; reason: string }> = [];
    for (const item of arr) {
      if (typeof item !== 'object' || item === null) continue;
      const o = item as { index?: unknown; reason?: unknown };
      const idx = typeof o.index === 'number' ? Math.trunc(o.index) : 0;
      const claim = idx >= 1 && idx <= claims.length ? claims[idx - 1] : undefined;
      if (!claim) continue; // an out-of-range index refutes nothing
      out.push({
        claim,
        reason:
          typeof o.reason === 'string' && o.reason.trim().length > 0
            ? o.reason.trim().slice(0, 400)
            : 'contradicted by a source in the corpus',
      });
    }
    return out;
  } catch {
    return []; // fail-open — a garbled refutation never flags anything
  }
}

/** Per-source and total caps on the verification corpus. A wide investigation
 *  can persist dozens of bodies; the critic gets a bounded slice of each. */
const VERIFY_SOURCE_CAP = 6_000;
const VERIFY_CORPUS_CAP = 60_000;

/**
 * May verification DELETE claims from the dossier?
 *
 * Default NO — see the note at the `dropped_claims` site. Flagging is the
 * shipped behaviour; dropping is opt-in until precision is proven.
 */
export function verify_drops_enabled(): boolean {
  return process.env.HEARTH_RESEARCH_VERIFY_DROP === '1';
}

/* ------------------------------------------------------------------ */
/* Identity disambiguation — a name match is not a person match         */
/* ------------------------------------------------------------------ */

/**
 * The 2026-07-29 Barrett conflation. An investigation into "Chris Barrett,
 * Pleasantville city councilmember" returned a dossier section describing an
 * X account belonging to a New York Times Opinion editor who lives in New
 * York and is married to Jennifer Preston — a different human being with the
 * same name. Every sentence was individually TRUE and correctly cited, so
 * every existing guard passed: the pipeline verifies claim -> source and
 * never source -> SUBJECT. Name string equality was the only identity test
 * in the chain, and it was implicit.
 *
 * Worse, the synthesis MODEL noticed — it wrote "though it lists his
 * location as New York, NY" — and shipped the material anyway, because
 * nothing downstream is empowered to act on a contradiction.
 *
 * These helpers add the missing check. They are deterministic and need no
 * evidence corpus, so they work despite the verifier's self-referential
 * grounding pass (see verify_investigation).
 */

/** Phrases that assert WHERE the subject is, followed by the place. */
const LOCATION_ASSERTION =
  /\b(?:lists?\s+(?:his|her|their)\s+location\s+as|location\s*[:=]|based\s+in|located\s+in|lives\s+in|resides\s+in|residing\s+in)\s+([A-Z][A-Za-z.'-]*(?:\s+[A-Z][A-Za-z.'-]*)*(?:,\s*[A-Z]{2})?)/g;

/** Tokens too generic to distinguish one place from another. */
const PLACE_STOPWORDS = new Set([
  'the', 'city', 'town', 'county', 'state', 'of', 'north', 'south', 'east',
  'west', 'new', 'saint', 'st', 'fort', 'ft', 'los', 'las', 'san', 'santa',
]);

function place_tokens(place: string): Set<string> {
  return new Set(
    place
      .toLowerCase()
      .replace(/[^a-z\s]/g, ' ')
      .split(/\s+/)
      .filter((t) => t.length >= 3 && !PLACE_STOPWORDS.has(t)),
  );
}

/**
 * Distinguishing place tokens from the investigation's own brief — the
 * subject the requester actually asked about. "Chris Barrett, Pleasantville
 * City Council District 1" anchors on {collins}; "fort" is stopworded
 * because Fort Worth and Pleasantville must not read as the same place.
 */
export function identity_anchor_places(brief: string, subject: string): Set<string> {
  return place_tokens(`${subject} ${brief}`);
}

/**
 * Claims that place the subject somewhere the brief contradicts.
 *
 * FLAGGED, never dropped — a person can move, hold a second post, or be
 * described by a stale profile, and silently deleting a true sentence is
 * its own failure. What this buys is that the conflict becomes visible to
 * the writeback gate and to the reader, instead of surviving as a "though".
 */
export function identity_conflicts(
  claims: readonly string[],
  anchor: ReadonlySet<string>,
): Array<{ claim: string; reason: string; place: string }> {
  const out: Array<{ claim: string; reason: string; place: string }> = [];
  if (anchor.size === 0) return out;
  for (const claim of claims) {
    LOCATION_ASSERTION.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = LOCATION_ASSERTION.exec(claim)) !== null) {
      const place = (m[1] ?? '').trim();
      const toks = place_tokens(place);
      if (toks.size === 0) continue;
      // A conflict is a place that shares NO distinguishing token with the
      // subject the brief named.
      let overlaps = false;
      for (const t of toks) if (anchor.has(t)) { overlaps = true; break; }
      if (!overlaps) {
        out.push({
          claim: claim.slice(0, 400),
          place,
          reason:
            `places the subject in "${place}", which shares no distinguishing token with ` +
            `the subject named in the brief. A same-name match is not a same-person ` +
            `match — confirm this source is about the right individual before using it, ` +
            `and drop it if it is not.`,
        });
        break;
      }
    }
  }
  return out;
}

/** Month names as they appear in synthesized prose. */
const MONTHS = [
  'january', 'february', 'march', 'april', 'may', 'june', 'july',
  'august', 'september', 'october', 'november', 'december',
];

/** Past-tense/settled verbs that must not govern a future date. */
/** Verbs that put an event in the future / still open. */
const PENDING_VERBS = new RegExp(
  [
    // "currently running", "currently seeking" — the verb need not sit
    // directly after "is" (the Barrett sentence read "is a teacher and
    // co-founder …, currently running for the District 1 seat").
    String.raw`\bcurrently\s+\w+ing\b`,
    String.raw`\brunning for\b`,
    String.raw`\bis a candidate\b`,
    String.raw`\b(is|are)\s+(scheduled|slated|set|expected|pending|upcoming|underway)\b`,
    String.raw`\b(will|shall)\s+\w+`,
    String.raw`\bupcoming\b`,
  ].join('|'),
);

const SETTLED_VERBS =
  /\b(was|were|has been|have been|had been|did|voted|elected|re-?elected|appointed|approved|passed|signed|resigned|retired|won|lost|died|founded|launched|completed|ended|terminated)\b/;

/**
 * Find claims that assert a FUTURE date as completed history. Pure and
 * deterministic — exported for the smoke.
 *
 * The 2026-07-28 Barrett dossier is the exemplar: "re-elected in November
 * 2029" was written in July 2026. The underlying source almost certainly said
 * his TERM RUNS THROUGH 2029; the synthesis flattened a term-end into a past
 * event, which inverts the answer to "when is he up for re-election" — the
 * exact question the investigation was filed to answer.
 */
export function temporal_inconsistencies(
  claims: readonly string[],
  now: Date,
): Array<{ claim: string; reason: string }> {
  const out: Array<{ claim: string; reason: string }> = [];
  const now_ymd = now.toISOString().slice(0, 10); // time-guard-ok: internal verification reason string, compared against a claim's calendar year — never shown as a local wall-clock time
  const now_year = now.getUTCFullYear();
  const now_month = now.getUTCMonth(); // 0-based
  for (const claim of claims) {
    const lower = claim.toLowerCase();
    const settled = SETTLED_VERBS.test(lower);
    const pending = PENDING_VERBS.test(lower);
    if (!settled && !pending) continue;
    // "<month> <year>" or a bare 4-digit year in a plausible civic range.
    const re = /(?:(january|february|march|april|may|june|july|august|september|october|november|december)\s+)?\b(19|20)(\d{2})\b/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(lower)) !== null) {
      const year = Number(`${m[2]}${m[3]}`);
      const month = m[1] ? MONTHS.indexOf(m[1]) : null;
      const is_future =
        year > now_year || (year === now_year && month !== null && month > now_month);
      const is_past =
        year < now_year || (year === now_year && month !== null && month < now_month);
      // The mirror-image error, caught 2026-07-29: a dossier written in July
      // 2026 said Barrett "is currently running ... in the November 4, 2025,
      // election". A finished election described as upcoming is exactly as
      // wrong as a future one described as finished, and the first version of
      // this check only looked one way.
      if (is_past && pending && !settled) {
        out.push({
          claim: claim.slice(0, 400),
          reason:
            `describes ${m[1] ? `${m[1]} ` : ''}${year} as upcoming or in progress, but that ` +
            `date has already passed (now ${now_ymd}). Say what actually happened, in the ` +
            `past tense — a settled election or deadline written as pending is stale.`,
        });
        break;
      }
      if (is_future && settled) {
        out.push({
          claim: claim.slice(0, 400),
          reason:
            `states ${m[1] ? `${m[1]} ` : ''}${year} as settled history, but that date is in ` +
            `the future (now ${now_ymd}). If this is a term end, a ` +
            `scheduled election, or a deadline, say so — do not write it in the past tense.`,
        });
        break;
      }
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Phase 4 — synthesize + report back                                  */
/* ------------------------------------------------------------------ */

interface GlobalSources {
  list: Source[];
  index_of: Map<string, number>; // url → 1-based global [S#]
}

function build_global_sources(row: InvestigationRow): GlobalSources {
  const list: Source[] = [];
  const index_of = new Map<string, number>();
  for (const r of row.findings) {
    for (const s of r.sources) {
      if (!index_of.has(s.url)) {
        list.push(s);
        index_of.set(s.url, list.length);
      }
    }
  }
  return { list, index_of };
}

/** Deterministic dossier skeleton — also the synthesis fail-open. */
function deterministic_dossier(row: InvestigationRow, gs: GlobalSources): string {
  const lines: string[] = [];
  lines.push(`# Deep research: ${row.subject}`);
  lines.push('');
  lines.push(`**Brief:** ${row.brief}`);
  lines.push('');
  for (const r of row.findings) {
    lines.push(`## ${r.question}`);
    if (r.status === 'not_attempted') {
      // Not the same statement as "no answer found" — say which it was.
      lines.push(`_NOT ATTEMPTED — ${r.note ?? 'this facet was not investigated'}._`);
    } else if (r.findings.length === 0) {
      lines.push(`_No grounded answer found.${r.note ? ` (${r.note})` : ''}_`);
    } else {
      for (const f of r.findings) {
        const refs = f.source_indices
          .map((i) => r.sources[i - 1])
          .filter((s): s is Source => s !== undefined)
          .map((s) => `[S${gs.index_of.get(s.url) ?? '?'}]`)
          .join('');
        lines.push(`- ${f.text} ${refs}`.trim());
      }
    }
    lines.push('');
  }
  if (gs.list.length > 0) {
    lines.push('## Sources');
    gs.list.forEach((s, i) => lines.push(`- [S${i + 1}] ${s.title ?? s.url} — ${s.url}`));
    lines.push('');
  }
  return lines.join('\n');
}

const SYNTH_SYSTEM =
  'You compose a cited deep-research dossier from VERIFIED findings. Rules:\n' +
  '- Open with a one-paragraph summary, then a section per sub-question, then a ' +
  '"Sources" list.\n' +
  '- Use ONLY the findings provided; cite their [S#] markers inline. Never introduce ' +
  'a specific not in the findings.\n' +
  '- DROP anything in the "do not assert" list — it failed verification.\n' +
  '- Note explicitly where the findings are thin or a facet could not be confirmed.\n' +
  'Reply with ONLY the dossier markdown.';

/** Remove any line that still contains a dropped (unverified) claim — a
 *  deterministic backstop so a slipped synthesizer can't reassert it. */
/**
 * The limits, stated in the REPORT rather than only in the code (2026-07-31).
 *
 * Three things a reader has to be told, and none of them are failures:
 *
 *   - sources we chose not to open, because opening them would have told the
 *     subject we were looking;
 *   - record systems we FOUND and could not query — a CAPTCHA we will not
 *     bypass, or a search form an automated fetch cannot drive;
 *   - the structural floor: sealed records, and the paid aggregators we
 *     deliberately exclude.
 *
 * Appended deterministically to every dossier shape, so a synthesiser cannot
 * write around them. Idempotent — a re-synthesis replaces rather than stacks.
 *
 * The safety escalation rides on "a records facet was unreachable", NOT on
 * sniffing the brief for the word "stalking": the note's own wording is already
 * conditional ("If this concerns your safety"), so there is nothing to detect
 * and no keyword list to get wrong.
 */
const LIMITS_HEADING = '## What was not reachable, and why';

export function append_limits_sections(
  dossier: string,
  row: InvestigationRow,
  jurisdiction: Jurisdiction | null,
): string {
  const base = dossier.split(LIMITS_HEADING)[0]!.trimEnd();

  const refused: Array<{ url: string; reason: string }> = [];
  const captcha_walled: string[] = [];
  const forms_only: string[] = [];
  for (const r of row.findings) {
    for (const s of r.refused_sources ?? []) refused.push({ url: s.url, reason: s.reason });
    for (const s of r.dropped_sources ?? []) {
      if (s.reason.includes('CAPTCHA')) captcha_walled.push(s.url);
      else if (s.reason.includes('search FORM')) forms_only.push(s.url);
    }
  }
  const has_records_facet = (row.plan?.sub_questions ?? []).some((sq) => sq.kind === 'records');
  const records_unreachable =
    has_records_facet &&
    (jurisdiction === null || captcha_walled.length > 0 || forms_only.length > 0);

  const parts = [
    render_budget_note(
      counters_from(row.state.counters),
      budget_for(row.depth),
      (row.coverage?.facets ?? []).filter((f) => f.status !== 'answered').length,
    ),
    render_attribution_note(refused),
    render_records_limits({
      jurisdiction,
      captcha_walled,
      forms_only,
      safety_relevant: records_unreachable,
    }),
    has_records_facet ? `${STRUCTURAL_LIMITS_NOTE}\n` : '',
  ].filter((p) => p.trim().length > 0);

  if (parts.length === 0) return base;
  return `${base}\n\n${LIMITS_HEADING}\n\n${parts.join('\n')}`;
}

function scrub_dropped_claims(dossier: string, dropped: string[]): string {
  if (dropped.length === 0) return dossier;
  const needles = dropped.map((d) => d.toLowerCase().trim()).filter((d) => d.length >= 3);
  if (needles.length === 0) return dossier;
  return dossier
    .split('\n')
    .filter((line) => {
      const lc = line.toLowerCase();
      return !needles.some((n) => lc.includes(n));
    })
    .join('\n');
}

async function synthesize_dossier(
  deps: InvestigationRunnerDeps,
  row: InvestigationRow,
  gs: GlobalSources,
  coverage: CoverageLedger,
): Promise<string> {
  const skeleton = deterministic_dossier(row, gs);
  // A REVISION refines the standing dossier rather than restarting it — the
  // people_synthesis lesson (2026-07-26): a dossier rebuilt from scratch every
  // time can never outgrow a single run's window. `row.dossier_md` is present
  // here only when the re-open decided the prior work was about the right
  // person (see reopen_with_facts).
  const prior = row.revision > 0 && row.dossier_md ? row.dossier_md : null;
  const prior_block = prior
    ? `The dossier as it stands (revision ${row.revision - 1}) — REVISE this, do not ` +
      `restart it. Carry forward everything that still holds, fold the new findings in ` +
      `where they add or correct, and retire anything the new findings contradict. The ` +
      `result must be at least as complete as what you were given:\n\n${prior}\n\n` +
      `---\n\n`
    : '';
  const dropped = row.verification?.dropped_claims ?? [];
  // Build the findings block with GLOBAL [S#] refs for the model.
  const findings_block = row.findings
    .map((r) => {
      const body =
        r.findings.length === 0
          ? '(no grounded answer)'
          : r.findings
              .map((f) => {
                const refs = f.source_indices
                  .map((i) => r.sources[i - 1])
                  .filter((s): s is Source => s !== undefined)
                  .map((s) => `[S${gs.index_of.get(s.url) ?? '?'}]`)
                  .join('');
                return `- ${f.text} ${refs}`.trim();
              })
              .join('\n');
      return `### ${r.question}\n${body}`;
    })
    .join('\n\n');
  const sources_block = gs.list
    .map((s, i) => `[S${i + 1}] ${s.title ?? s.url} — ${s.url}`)
    .join('\n');
  const content = await complete_role(deps, 'research_extract', {
    system: SYNTH_SYSTEM,
    user:
      prior_block +
      `Subject: ${row.subject}\nBrief: ${row.brief}\n\n` +
      (row.anchor_facts.length > 0
        ? `Known about this specific subject: ${row.anchor_facts.join('; ')}\n\n`
        : '') +
      `Verified findings (cite these [S#]):\n${findings_block}\n\n` +
      `Sources:\n${sources_block}\n\n` +
      `Do NOT assert (failed verification): ${dropped.length > 0 ? dropped.join('; ') : '(none)'}\n\n` +
      // What the pipeline RECORDED about its own coverage. Not an instruction
      // about the answer — evidence about the investigation, so the model
      // states a gap plainly instead of writing around it.
      `Coverage: ${coverage_summary_line(coverage)}. Facets NOT established: ` +
      `${
        coverage.facets
          .filter((f) => f.status !== 'answered')
          .map((f) => `"${f.question}" (${f.status})`)
          .join('; ') || '(none)'
      }\n` +
      'Say plainly which facets were not established. Never imply coverage the ' +
      'findings do not have.\n\n' +
      'Reply with ONLY the dossier markdown.',
    temperature: 0.3,
    max_tokens: 2400,
  });
  // Monotonic: a flaky synthesis must never BLANK a dossier that previous
  // revisions earned. Falling back to the skeleton would do exactly that on a
  // revision, so the prior wins over the skeleton when one exists.
  const dossier =
    content && content.trim().length > 80 ? content.trim() : (prior ?? skeleton);
  // The coverage ledger opens the report — deterministically, so a reader can
  // never have to notice an absence (v2 phase 2, F1).
  // The verification flags CLOSE the report, also deterministically. Since
  // 2026-07-31 the verifier FLAGS rather than drops (design §7) — but nothing
  // rendered `verdicts` anywhere: the office route and get_research_investigation
  // both read `dropped_claims`, which that change made permanently empty. So a
  // failed claim was no longer deleted AND no longer shown to anyone. This is
  // the other half of flag-don't-drop: a flag the reader cannot see does not
  // exist.
  return append_verification_flags(
    prepend_coverage_section(scrub_dropped_claims(dossier, dropped), coverage),
    row.verification,
  );
}

/**
 * Render the verification verdicts at the foot of the dossier. Idempotent — a
 * re-synthesis REPLACES the section rather than stacking a second one (the
 * prepend_coverage_section discipline, and the same accretion bug the
 * person-note writeback had). No verdicts → the dossier is returned untouched,
 * so a clean report carries no ominous empty heading.
 */
export function append_verification_flags(
  dossier: string,
  verification: VerificationResult | null,
): string {
  const HEADING = '## Verification flags';
  const lines = dossier.split('\n');
  const start = lines.findIndex((l) => l.startsWith(HEADING));
  const body = start >= 0 ? lines.slice(0, start).join('\n').trimEnd() : dossier.trimEnd();

  const verdicts = verification?.verdicts ?? [];
  if (verdicts.length === 0) return body;

  const rendered = verdicts
    .map((v) => {
      const label = v.verdict === 'contradicted' ? 'CONTRADICTED' : 'unverified';
      return `- **${label}** — ${v.claim}\n  _${v.reason}_`;
    })
    .join('\n');
  return (
    `${body}\n\n${HEADING}\n\n` +
    `These claims did not survive checking against the sources actually read. ` +
    `They are left in the report above rather than deleted, so you can judge ` +
    `them yourself — treat them as unsound until confirmed.\n\n${rendered}\n`
  );
}

/** Compose a short grounded summary for the person-note writeback. */
function person_summary(row: InvestigationRow): string {
  const top = row.findings
    .flatMap((r) => r.findings.map((f) => f.text))
    .slice(0, 4);
  if (top.length === 0) return `Deep research found no grounded public details for ${row.subject}.`;
  return top.map((t) => `- ${t}`).join('\n');
}

async function synthesize_and_report(
  deps: InvestigationRunnerDeps,
  ctx: ToolContext,
  store: ResearchInvestigationStore,
  row: InvestigationRow,
  tz: string | undefined,
  /** The slice's two writers, threaded in so this function owns NEITHER the
   *  status column nor the log column — see `advance_investigation`. */
  io: { log: (line: string) => void; set_status: StatusWriter },
): Promise<InvestigationRow> {
  const { log, set_status } = io;
  const memory = deps.library_deps.memory;
  const gs = build_global_sources(row);

  // Recompute the ledger from the findings on the row — pure, so a resumed
  // slice that never re-ran the investigate phase still gets the right one.
  const coverage = compute_coverage(row.plan, row.findings);
  // Read the counter off the LIVE row, not a slice-start snapshot: `state` is
  // store-owned and shared with the cancel route's log writer.
  const attempts = row.state.resume_attempts ?? 0;
  // The cap is depth-scaled (v2 phase 5). It used to be a hard-coded 2, which
  // silently capped an `exhaustive` run at three slices no matter how many
  // sources it was authorised to read — and, because an `incomplete` slice-end
  // is the only OPEN one, also held `no_progress_slices` one below the stall
  // threshold so the watchdog could never fire.
  const resume_cap = budget_for(row.depth).max_resume_attempts;
  const resumable = has_unattempted(coverage) && attempts < resume_cap;

  // Past the resume cap, a facet we never got to becomes an honest
  // `unanswerable` rather than an open status nothing can ever close.
  const final_coverage: CoverageLedger = resumable
    ? coverage
    : {
        facets: coverage.facets.map((f) =>
          f.status === 'not_attempted'
            ? {
                ...f,
                status: 'unanswerable' as const,
                reason:
                  `not established within this investigation's budget ` +
                  `(${attempts} resume attempt(s)); last state: ${f.reason ?? 'not attempted'}`,
              }
            : f,
        ),
      };

  // If nothing we read was about the subject, do NOT compose a dossier out of
  // it. Say so plainly instead — the deterministic report is the honest one,
  // and handing these sources to a synthesiser is exactly how a stranger's
  // career became a friend's biography.
  const unconfirmed = subject_unconfirmed(row, final_coverage);
  const dropped_total = row.findings.reduce((n, r) => n + (r.dropped_sources?.length ?? 0), 0);
  // Nothing answered at all → a SHORT deterministic report. Handing these
  // findings to a synthesiser produces pages of elaborated absence (the
  // 10,000-character "Daniel Ray Torres" dossier that established nothing),
  // which reads as substance and is worse than a paragraph of truth.
  // ONLY when we have genuinely finished trying: every facet `unanswerable`.
  // A facet still `not_attempted` means the run is resumable and nothing was
  // established YET — emitting a terminal "nothing was established" there would
  // bury a partial dossier that is about to be retried.
  const empty =
    !unconfirmed &&
    final_coverage.facets.length > 0 &&
    final_coverage.facets.every((f) => f.status === 'unanswerable');
  // Re-resolve the jurisdiction for the report. Deterministic given the same
  // facts, and a local geocode call — cheaper than a schema column, and it
  // cannot drift from what the investigate phase used.
  let report_jurisdiction: Jurisdiction | null = null;
  if ((row.plan?.sub_questions ?? []).some((sq) => sq.kind === 'records')) {
    try {
      report_jurisdiction = await resolve_jurisdiction(row.anchor_facts, row.brief);
    } catch {
      /* fail-open — the limits section just omits the jurisdiction line */
    }
  }
  const dossier_body = unconfirmed
    ? unconfirmed_dossier(row, dropped_total)
    : empty
      ? nothing_established_dossier(row, final_coverage)
      : await synthesize_dossier(deps, row, gs, final_coverage);
  // Every shape gets the limits, including the two deterministic ones — a
  // "could not find this person" report is exactly where a reader most needs to
  // know that LinkedIn was deliberately left alone and the county portal wants
  // a human.
  // ⚠ ORDERING INVARIANT. `append_verification_flags` (inside
  // `synthesize_dossier`) truncates the dossier at its OWN heading before
  // re-appending, so anything placed after it is discarded on the next pass.
  // The limits section must therefore be appended LAST, here — which is also
  // why this composes correctly across a revision: the carried-forward prior
  // loses its limits block to that truncation and gets it back on this line.
  // If you add a third trailing section, append it after this one and give it
  // the same self-truncating idempotency, or a revision will silently eat it.
  const dossier_md = append_limits_sections(dossier_body, row, report_jurisdiction);
  if (empty) {
    log(
      `nothing established across ${final_coverage.facets.length} facet(s) — short report ` +
        'instead of a synthesized one',
    );
  }
  if (unconfirmed) {
    log(
      `subject UNCONFIRMED — ${dropped_total} source(s) read, none about ${row.subject}; ` +
        'reporting not-found and skipping the person writeback',
    );
  }
  store.update(row.id, { dossier_md, coverage: final_coverage });
  row = { ...row, coverage: final_coverage, dossier_md };

  // A partial report is honest and readable, but it is NOT the finished
  // article: shelving, the person-note writeback, and the requester's push all
  // wait for `done`, so a resume cannot double-shelve or double-notify.
  if (resumable) {
    const gaps = final_coverage.facets.filter((f) => f.status === 'not_attempted');
    const attempt = attempts + 1;
    store.set_resume_attempts(row.id, attempt);
    log(
      `partial dossier — ${coverage_summary_line(final_coverage)}; resuming ` +
        `${gaps.length} unattempted facet(s) (attempt ${attempt}/${resume_cap})`,
    );
    // Through the guarded writer, so a cancel that landed while we were
    // synthesizing is not overwritten with `incomplete` — it would otherwise
    // reopen a run the requester stopped, and the sweep would keep resuming it.
    const status = set_status('incomplete');
    return { ...row, status };
  }

  // Shelve to the specialist that FILED the investigation, not to Kate by
  // default (2026-07-29). Ruby's first Barrett dossier landed in
  // Knowledge/Kate/library/ — outside her own knowledge_scope — so she could
  // never search it back: a write-only investigation. Falls back to Kate for
  // pre-column rows and for any agent no longer on the roster.
  // Captured BEFORE the new note is shelved, so a revision can retire it after
  // the replacement has safely landed (never before — a failed shelve must not
  // leave the subject with no dossier at all).
  const prior_note_path = row.dossier_note_path;
  const shelf_owner =
    (row.agent_id ? deps.specialists.get(row.agent_id) : undefined) ?? deps.specialists.get('kate');
  // The SAME resolution drives the report-back surfaces below (d + e). Those
  // hardcoded Kate alongside emit_status, so a Ruby investigation pushed "Kate
  // finished researching X" and flagged KATE's inbox about a dossier sitting on
  // RUBY's shelf — she was told to read back work she had no note of.
  const reporter_id = shelf_owner?.id ?? 'kate';
  const reporter_name = shelf_owner?.name ?? 'Kate';
  let dossier_note_path: string | null = null;

  // a) Shelve the dossier — searchable (chunks_fts + embeddings), cordoned.
  if (shelf_owner) {
    try {
      const saved = await save_library_item(
        deps.library_deps,
        {
          filename: `${row.id}-dossier.md`,
          mime_type: 'text/markdown',
          text: dossier_md + '\n',
        },
        shelf_owner,
        {
          source: 'file',
          ...(tz !== undefined ? { tz } : {}),
          trust_tier_override: null,
          quality_gate: 'off', // composed from verified findings, already gated
          private_to: row.private_to,
        },
      );
      if (!('rejected' in saved)) {
        dossier_note_path = saved.wrapper_note_path;
        store.update(row.id, { dossier_note_path });
        // SUPERSEDE the previous revision's note. The shelf path is
        // `<date>-<title-slug>.md`, so a re-run on another day (or with a
        // different generated title) writes a NEW file — leaving the earlier
        // dossier on the shelf and in RAG forever, beside the one that replaced
        // it. For a correction that is the failure repeating itself: the
        // stranger's biography would stay searchable next to the fix. Deleting
        // the note is enough to de-index it — the ingestor's unproject_note
        // clears chunks_fts + chunk_embeddings on unlink.
        const prior_path = prior_note_path;
        if (prior_path && prior_path !== dossier_note_path) {
          try {
            memory.delete_note(prior_path);
            log(`superseded the previous dossier note (${prior_path})`);
          } catch (err) {
            log(`could not remove the previous dossier note: ${(err as Error).message}`);
          }
        }
      }
    } catch (err) {
      log(`dossier shelve failed: ${(err as Error).message}`);
    }
  }

  // b) Person-note summary writeback (when the subject is a person).
  //
  // GATED on identity (2026-07-29). The Barrett conflation merged a Fort
  // Collins councilmember with a same-named New York Times editor; had that
  // dossier reached this writeback it would have contaminated the canonical
  // People/ record Kate stewards, and a merged person record is far harder to
  // unpick than a bad note. When verification flagged an identity conflict we
  // shelve the dossier (the reader can judge it, conflicts and all) but
  // REFUSE the person writeback. An empty record beats a merged one.
  //
  // Two independent refusals feed this gate. `identity_flagged` is the older
  // location-conflict signal. `unconfirmed` is the 2026-07-30 addition and is
  // the one that would have saved the Reyes note: no source we read even
  // NAMED her, so there is nothing here that belongs in anyone's record.
  const identity_flagged = (row.verification?.verdicts ?? []).some((v) =>
    /same-name match is not a same-person match/.test(v.reason),
  );
  const writes_person_note = PERSON_SUBJECT_KINDS.includes(row.subject_kind);
  const block_writeback = identity_flagged || unconfirmed;
  if (writes_person_note && block_writeback) {
    log(
      unconfirmed
        ? 'person-note writeback REFUSED — no source could be confirmed to be about this ' +
            'person; an empty record beats a stranger\'s'
        : 'person-note writeback SKIPPED — verification flagged a possible same-name ' +
            'different-person conflict; dossier shelved for review instead',
    );
  }
  if (writes_person_note && !block_writeback) {
    try {
      const requester = row.requested_by
        ? deps.users?.get(row.requested_by)
        : undefined;
      const wbctx: ToolContext = {
        memory,
        llm: deps.llm,
        now: new Date(),
        intent_id: ulid(),
        // Attribute the write to whoever filed the investigation. Neither
        // person tool reads ctx.specialist_id today, so this is provenance
        // only — but an inert-yet-wrong constant is exactly what emit_status
        // was before someone read it.
        specialist_id: reporter_id,
        ...(requester ? { user: { id: requester.id, tier: requester.tier } } : {}),
      };
      // A public figure is seeded as such at CREATION, so an official never
      // defaults to `acquaintance` — the value that put a councilmember Jasper
      // has never met into the personal contact graph (2026-07-29).
      const is_public = row.subject_kind === 'public_figure';
      const person = await find_or_create_person.execute(
        {
          name: row.subject,
          ...(is_public ? { hints: { relationship: 'public_figure' } } : {}),
        },
        wbctx,
      );

      // Reclassify an EXISTING record only when it still holds the old default
      // `acquaintance` — that value is what the pre-fix writeback produced, so
      // correcting it self-heals notes this bug already created. A deliberately
      // set relationship (family/friend/colleague/service/self) is never
      // overwritten: research must not demote someone Jasper actually knows.
      const patch: Record<string, unknown> = {};
      if (is_public) {
        const current = memory.find_person({ id: person.id })?.frontmatter?.relationship;
        if (current === 'acquaintance') patch.relationship = 'public_figure';
      }

      const summary = person_summary(row);
      await upsert_person_note.execute(
        {
          identifier: { id: person.id },
          patch,
          // An IDEMPOTENT section, not an append. Four passes over Barrett left
          // four near-identical "## Deep research" blocks repeating the same
          // facts; the newest research is the one worth keeping, and the full
          // history lives in the shelved dossiers this links to.
          body_section: {
            heading: '## Deep research',
            heading_suffix: `(${local_iso_date(new Date(), tz)})`,
            body:
              summary +
              (dossier_note_path ? `\n\nFull dossier: \`${dossier_note_path}\`` : ''),
          },
        },
        wbctx,
      );
      store.update(row.id, { person_id: person.id });
    } catch (err) {
      log(`person writeback failed: ${(err as Error).message}`);
    }
  }

  // c) Mark done — through the SAME guarded writer every other transition
  //    uses, so a cancel that landed while this phase was running is adopted
  //    instead of being clobbered back out to `done`. The composed dossier is
  //    kept and stays shelved either way (it is already paid for, and the
  //    office renders it), but the run is honestly `cancelled`.
  log(`dossier ready (${gs.list.length} sources) — ${coverage_summary_line(final_coverage)}`);
  const final_status = set_status('done');
  const finished: InvestigationRow = {
    ...row,
    status: final_status,
    dossier_md,
    dossier_note_path,
  };

  // Nobody asked for this report any more — so d) and e), the two surfaces
  // that ANNOUNCE it, are skipped. Telling the requester "your report is
  // ready" seconds after they pressed stop is the cancel not working.
  if (final_status !== 'done') return finished;

  // d) Push the requester — the report is ready even if they've left the app.
  //    Say plainly when it does not cover everything asked: "the full report is
  //    ready" for a report missing four of six facets is the F1 failure
  //    reaching the owner's phone.
  if (row.requested_by) {
    const unresolved = final_coverage.facets.filter((f) => f.status !== 'answered').length;
    try {
      // AWAITED (2026-07-29): the requester asked for this dive and is owed the
      // answer, so it skips the read-the-room deferrals. `awaited_age_ms` is
      // measured from the request, and a dive is long — one fired at 23:00 that
      // lands at 02:00 is past the grace window and correctly waits for morning
      // instead of waking the house (delivery_window.ts `is_awaited_bypass`).
      // Two Chris Barrett reports were parked 5–7h before this existed.
      await push_text_to_user(
        row.requested_by,
        unresolved > 0
          ? `${reporter_name} finished researching ${row.subject} — the report is ` +
              `ready, but ${coverage_summary_line(final_coverage)}.`
          : `${reporter_name} finished researching ${row.subject} — the full report is ready.`,
        {
          kind: 'ad_hoc',
          severity: 'medium',
          originating_specialist_id: reporter_id,
          is_awaited: true,
          awaited_age_ms: Math.max(0, Date.now() - new Date(row.created_at).getTime()),
        },
      );
    } catch {
      /* fail-open — a push miss queues; never fail the investigation */
    }
  }

  // e) Flag the FILING specialist so she can speak it back on her next turn
  //    (knowledge-floor inbox section surfaces it). FYI, not a wake.
  if (deps.inbox) {
    try {
      const inbox_id = deps.inbox.push({
        from_specialist_id: reporter_id,
        to_specialist_id: reporter_id,
        kind: 'fyi',
        originating_user_id: row.private_to,
        body_md:
          `**Deep-research dossier ready** — "${row.subject}" (\`${row.id}\`). ` +
          `Coverage: ${coverage_summary_line(final_coverage)}. ` +
          `${dossier_note_path ? `Shelved at \`${dossier_note_path}\`. ` : ''}` +
          `Use get_research_investigation to read it back to the user — and say ` +
          `which facets were NOT established, do not imply coverage the report lacks.`,
      });
      deps.events?.emit({
        type: 'inbox_message_added',
        message_id: inbox_id,
        from_specialist_id: reporter_id,
        to_specialist_id: reporter_id,
        kind: 'fyi',
        severity: 'medium',
      });
    } catch {
      /* fail-open */
    }
  }

  return finished;
}

/* ------------------------------------------------------------------ */
/* Advance — one bounded slice                                         */
/* ------------------------------------------------------------------ */

export interface AdvanceInvestigationResult {
  investigation_id: string;
  status: InvestigationStatus | 'missing';
  progressed: boolean;
  error?: string;
}

/**
 * Writes one status transition and reports back the status that ACTUALLY landed
 * — which is `'cancelled'`, not the requested one, when a cancel arrived while
 * the phase was running. Every caller must branch on the return value rather
 * than assume its request won.
 */
type StatusWriter = (
  status: InvestigationStatus,
  patch?: { error?: string | null },
) => InvestigationStatus;

/**
 * Broadcast the investigation's status under the specialist that FILED it —
 * `row.agent_id`, the same source `synthesize_and_report` already uses to pick
 * the dossier's shelf. This was hardcoded `'kate'`, so Ruby's research progress
 * animated Kate's office bar and never her own; the office read
 * (GET /api/specialists/:id/research) is capability-gated, so Ruby HAS a
 * Research tab that the live event stream simply never addressed.
 *
 * The `'kate'` fallback is for pre-column rows only — verified against the live
 * table 2026-07-29: 8 rows carry a NULL `agent_id` (all filed before the column
 * existed, when Kate was the only research front), 2 are `ruby`, 1 is `kate`.
 * So the fallback mislabels nothing: it names the agent those rows actually had.
 */
function emit_status(
  deps: InvestigationRunnerDeps,
  row: InvestigationRow,
  status: InvestigationStatus,
): void {
  deps.events?.emit({
    type: 'research_investigation_updated',
    investigation_id: row.id,
    specialist_id: row.agent_id ?? 'kate',
    subject: row.subject,
    status,
    user_id: row.requested_by,
  });
  // Also patch the cross-domain "On the Fire" ledger (core/jobs.ts) — the web
  // dock and the iOS strip show a dive next to a download in ONE list, so both
  // domains emit through the same projection. The Research office keeps its own
  // event above; this is purely additive, and the mapper is shared with
  // GET /api/jobs so a phase label can't disagree between the two surfaces.
  //
  // Re-read rather than projecting the in-memory row (which `set_status` has
  // already advanced): `persist` has committed by the time we get here, and the
  // store row is the only copy carrying the columns IT owns — `completed_at`
  // most of all, which the caller's spread never sets. Same discipline as the
  // media runner's `record_slice`. Fail-open on any read error.
  try {
    const fresh = new ResearchInvestigationStore(deps.library_deps.db).get(row.id);
    if (fresh) emit_job_progress(deps.events, job_from_investigation_row(fresh, progress_of));
  } catch {
    /* the ledger patch is best-effort — never fail a phase over it */
  }
}

/**
 * Tell the owner a run stopped moving, and what they can do about it.
 *
 * A stall that only writes a log line is a run that silently dies — the thing
 * phase 5 exists to prevent. So it reaches the requester the same two ways a
 * finished dossier does (inbox flag + push), and the message names the three
 * real options rather than just reporting a problem.
 *
 * Fail-open throughout: a notification failure must never turn a stalled run
 * into a failed one.
 */
async function notify_stalled(
  deps: InvestigationRunnerDeps,
  row: InvestigationRow,
  counters: BudgetCounters,
  last_log: string | null,
): Promise<void> {
  const coverage = row.coverage;
  const answered = (coverage?.facets ?? []).filter((f) => f.status === 'answered').length;
  const body = render_stall_notice({
    subject: row.subject,
    depth: row.depth,
    counters,
    last_log_line: last_log,
    facets_answered: answered,
    facets_total: coverage?.facets.length ?? 0,
  });
  try {
    deps.inbox?.push({
      from_specialist_id: row.agent_id ?? 'kate',
      to_specialist_id: row.agent_id ?? 'kate',
      kind: 'flag',
      body_md: body,
      ...(row.private_to ? { originating_user_id: row.private_to } : {}),
    });
  } catch (err) {
    console.error('[deep-research] stall inbox flag failed:', (err as Error).message);
  }
  try {
    if (row.requested_by) {
      await push_text_to_user(
        row.requested_by,
        `Research on ${row.subject} has stalled — ${answered} of ${coverage?.facets.length ?? 0} ` +
          `questions answered. Ask me to keep going, narrow it, or stop.`,
        {
          kind: 'ad_hoc',
          severity: 'medium',
          originating_specialist_id: row.agent_id ?? 'kate',
          // The requester asked for this dive and is owed the outcome, stall
          // included — a stall the owner never hears about is the silent death
          // this phase exists to prevent.
          is_awaited: true,
          awaited_age_ms: Math.max(0, Date.now() - new Date(row.created_at).getTime()),
        },
      );
    }
  } catch (err) {
    console.error('[deep-research] stall push failed:', (err as Error).message);
  }
}

export async function advance_investigation(
  deps: InvestigationRunnerDeps,
  ctx: ToolContext,
  investigation_id: string,
  opts: { deadline_ms?: number } = {},
): Promise<AdvanceInvestigationResult> {
  const store = new ResearchInvestigationStore(deps.library_deps.db);
  const memory = deps.library_deps.memory;
  const agent = ctx.specialist_id ?? 'kate';
  let row = store.get(investigation_id);
  if (!row) {
    return { investigation_id, status: 'missing', progressed: false, error: 'investigation not found' };
  }
  if (!deep_research_enabled() || !OPEN_INVESTIGATION_STATUSES.includes(row.status)) {
    return {
      investigation_id,
      status: row.status,
      progressed: false,
      ...(deep_research_enabled()
        ? {}
        : { error: 'HEARTH_DEEP_RESEARCH=0 — runner disabled by kill switch' }),
    };
  }

  // Depth scales the slice (v2 phase 5). An explicit opts.deadline_ms still
  // wins — that is the smokes' starvation seam — and `standard` resolves to the
  // same 5 minutes v1 used, so nothing changes for an ordinary run.
  const depth_budget = budget_for(row.depth);
  const deadline =
    Date.now() +
    (opts.deadline_ms ??
      (process.env.HEARTH_DEEP_RESEARCH_SLICE_MS ? slice_ms() : depth_budget.slice_ms));
  const tz = deps.users?.get_timezone(row.requested_by ?? ctx.user?.id ?? null);
  const sources_store = new ResearchSourcesStore(deps.library_deps.db);
  /**
   * The WORK budget (v2 phase 5). The slice deadline above still bounds one
   * slice — it is what keeps a pass resumable — but it is no longer what stops
   * the INVESTIGATION. Depth decides that, and `exhaustive` is measured in
   * hundreds of sources rather than eighteen.
   */
  const budget: ResearchBudget = depth_budget;
  let counters: BudgetCounters = counters_from(row.state.counters);
  let progressed = false;
  let slice_error: string | undefined;
  /** Consecutive errored slices. Read once here; written back through the
   *  store, which owns the `state` column (the log's other writer is the cancel
   *  route — see ResearchInvestigationStore.append_log). */
  let error_streak = row.state.error_streak ?? 0;

  // Retention sweep — one indexed DELETE per slice keeps the evidence trail
  // self-maintaining with no extra job. Fail-open: a failed prune must never
  // stop an investigation.
  try {
    sources_store.prune_expired(new Date());
  } catch (err) {
    console.error('[deep-research] source retention prune failed:', (err as Error).message);
  }

  const persist = (patch: Parameters<ResearchInvestigationStore['update']>[1] = {}): void => {
    store.update(row!.id, patch);
  };
  const log = (line: string): void => {
    store.append_log(row!.id, line);
  };
  /**
   * The slice's ONE status writer. Every transition — including the two
   * TERMINAL ones (`done` from synthesis, `failed` from the error streak) —
   * goes through here, because a terminal write that bypassed it is exactly how
   * a cancel used to be undone: the route returned `{cancelled: true}`, emitted
   * a `cancelled` event, and then the finishing slice wrote `done` over it.
   *
   * A slice runs for up to five minutes across four phases, so the `row` we
   * hold goes stale the moment `POST …/research/:rid/cancel` writes the table.
   * Re-read the status before each transition: if the cancel landed, ADOPT it
   * and report that back, so the caller can also skip whatever the transition
   * was about to announce. The status the caller asked for is never written
   * over `'cancelled'`.
   *
   * Nothing else is needed to stop the chain. Once `row.status` is
   * `'cancelled'`, no later phase `if` matches, `advance_investigation` returns
   * a non-open status, `kick_investigation_detached` breaks its loop, and the
   * nightly sweep never lists the row again — the existing machinery does the
   * work, so no new job system enters the picture. A phase already mid-flight
   * finishes (a cancel during synthesis composes and shelves the dossier rather
   * than dropping a fragment); the stop is at the BOUNDARY, which is what the
   * route tells the caller.
   */
  const set_status: StatusWriter = (status, patch = {}) => {
    if (store.get(row!.id)?.status === 'cancelled') {
      log(
        status === 'done' || status === 'failed'
          ? `cancelled — not marking ${status}`
          : `cancelled — stopping before ${status}`,
      );
      row = { ...row!, status: 'cancelled' };
      persist(patch); // the patch's non-status fields only; never `status`
      return 'cancelled';
    }
    row = { ...row!, status };
    persist({ status, ...patch });
    emit_status(deps, row, status);
    return status;
  };

  try {
    /* ---- stall watchdog, BEFORE any work (v2 phase 5) ------------- */
    // Checked at slice START, which is the only place an OPEN status is
    // observable: a slice runs the whole phase chain, so at its end the status
    // is always incomplete/done/cancelled. Gating the check on an open status
    // at the END — as this first shipped — made `stalled` unreachable at every
    // depth, proven by instrumenting the coverage smoke (no_progress_slices
    // topped out at 2 against a threshold of 3).
    //
    // STALLED != SLOW: `record_slice` only fails to move when the signature
    // genuinely froze, so a long exhaustive run whose counters climb is never
    // caught here. Only a stationary one is.
    if (is_stalled(counters) && OPEN_INVESTIGATION_STATUSES.includes(row.status)) {
      const last_log = row.state.log?.at(-1) ?? null;
      log(
        `STALLED — ${counters.no_progress_slices} consecutive slices moved nothing ` +
          `(${counters.sources_read} source(s), ${counters.rounds_spent} round(s))`,
      );
      const landed = set_status('stalled');
      if (landed === 'stalled') await notify_stalled(deps, row, counters, last_log);
      // Audit it HERE. The early return sits inside the `try` with no `finally`,
      // so it skips the slice's normal log_action at the bottom — and a stall
      // was the one slice outcome with no audit row at all, while done, failed,
      // incomplete, cancelled and errored all had one. The audit log is the
      // conscience of the system; a state transition the owner is pushed about
      // must not be absent from it.
      try {
        memory.log_action({
          intent_id: ctx.intent_id,
          agent,
          tool_name: 'research_investigation',
          tool_input: { investigation_id, slice: 'stall-watchdog' },
          execution_result: {
            status: landed,
            no_progress_slices: counters.no_progress_slices,
            sources_read: counters.sources_read,
            rounds_spent: counters.rounds_spent,
            depth: row.depth,
          },
          ...(row.requested_by ? { user_id: row.requested_by } : {}),
        });
      } catch {
        /* fail-open — never let the audit write sink a slice */
      }
      return {
        investigation_id,
        status: row.status,
        progressed: false,
        ...(slice_error ? { error: slice_error } : {}),
      };
    }

    /* ---- budget spent, before any further work -------------------- */
    // Not a stall and not a failure — the honest end of what was authorised.
    // Stop resuming and let the run converge to a report; the dossier carries
    // `render_budget_note` explaining the stop.
    const spent = budget_status(counters, budget);
    if (spent.exhausted && row.status === 'incomplete') {
      log(`budget spent: ${spent.detail} — composing what we have rather than resuming`);
      store.set_resume_attempts(row.id, budget.max_resume_attempts);
      row = { ...row, state: { ...row.state, resume_attempts: budget.max_resume_attempts } };
      // Skip STRAIGHT to synthesis. Forcing the attempt count alone was not
      // enough: control fell through to the `incomplete` → `investigating`
      // resume below, logged "resuming — retrying facets that were never
      // attempted", and ran a WHOLE extra fan-out — because `budget_room`
      // floors at one source per facet, so a spent budget still buys a full
      // pass. The log line said one thing and the code did the other, which
      // three reviewers caught independently.
      set_status('synthesizing');
    }

    /* ---- plan ---------------------------------------------------- */
    // Two statements, not one block: `set_status` can adopt an out-of-band
    // 'cancelled' instead of 'planning', and the planner call below must not
    // run when it did. Every later phase gates on `row.status` the same way,
    // so the cancel needs no separate check anywhere.
    if (row.status === 'pending') set_status('planning');
    if (row.status === 'planning') {
      const plan = await plan_investigation(deps, row);
      log(`planned ${plan.sub_questions.length} sub-question(s)`);
      row = { ...row, plan };
      persist({ plan });
      set_status('investigating');
      progressed = true;
    }

    /* ---- resume an incomplete investigation ----------------------- */
    // `incomplete` means a partial dossier exists and the ledger still carries
    // facets we never got to LOOK at. Re-enter the fan-out; only the
    // unattempted facets re-run (see below), so answered work is never redone.
    if (row.status === 'incomplete') {
      log('resuming — retrying facets that were never attempted');
      // Through the guarded writer, like every other transition: a cancel that
      // landed on an `incomplete` row must NOT be reopened as `investigating`,
      // or the sweep would keep resuming a run the requester stopped. It
      // updates `row` in place, so the phase block below sees what stuck.
      set_status('investigating');
      progressed = true;
    }

    /* ---- investigate (bounded fan-out) --------------------------- */
    if (row.status === 'investigating') {
      const plan = row.plan ?? { sub_questions: [] };
      // Only run facets with no result yet, or one that records we never got to
      // look (`not_attempted`). A facet already answered — or genuinely
      // unanswerable from its sources — is left alone, so a resume costs only
      // the work that is actually missing and cannot lose findings already in
      // hand. On a first pass row.findings is empty, so this is every facet
      // (identical to the pre-ledger behaviour).
      const prior = new Map(row.findings.map((r) => [r.sub_question_id, r]));
      const to_run = plan.sub_questions.filter((sq) => {
        const p = prior.get(sq.id);
        return p === undefined || p.status === 'not_attempted';
      });
      const is_person = PERSON_SUBJECT_KINDS.includes(row.subject_kind);

      // Resolve the jurisdiction ONCE per slice, before any facet runs. A
      // records question cannot be routed without it, and re-resolving per
      // facet would just repeat the same local geocode. Deterministic given
      // the same facts, so a resumed slice reaches the same county — which is
      // why it needs no column.
      let jurisdiction: Jurisdiction | null = null;
      if (plan.sub_questions.some((sq) => sq.kind === 'records')) {
        try {
          jurisdiction = await resolve_jurisdiction(row.anchor_facts, row.brief);
        } catch (err) {
          console.error('[deep-research] jurisdiction resolve failed:', (err as Error).message);
        }
        log(render_jurisdiction(jurisdiction));
      }

      const target: SubInvestigationTarget = {
        investigation_id: row.id,
        subject: row.subject,
        is_person_subject: is_person,
        anchor_facts: row.anchor_facts,
        private_to: row.private_to,
        sources_store,
        jurisdiction,
        anchor: anchor_from_facts(row.anchor_facts),
        // Divide what the INVESTIGATION has left across the facets running in
        // this pass, so one greedy facet cannot eat an exhaustive run's whole
        // allowance before the others are attempted. At least one source each —
        // a facet with a budget of zero is `not_attempted`, not answered, and
        // pretending otherwise would resurrect the silent-facet-loss bug.
        budget_room: {
          sources: Math.max(1, Math.floor(sources_remaining(counters, budget) / Math.max(1, to_run.length))),
          rounds: Math.max(0, Math.floor(rounds_remaining(counters, budget) / Math.max(1, to_run.length))),
        },
        rounds_per_facet: budget.rounds_per_facet,
        // THE OWNER'S RULE, in code: an investigation into a PERSON never uses
        // an attributable path. A topic investigation is uncapped — nobody is
        // notified that someone read about a bike.
        attribution_cap: is_person ? 'passive' : undefined,
      };
      const fresh = await pooled_map(to_run, fanout_concurrency(), (sq) =>
        investigate_sub_question(deps, ctx, sq, target, deadline),
      );
      const fresh_by_id = new Map(fresh.map((r) => [r.sub_question_id, r]));
      // Merge in PLAN order so [S#] numbering and the ledger stay aligned.
      const results: SubQuestionResult[] = plan.sub_questions.map(
        (sq) =>
          fresh_by_id.get(sq.id) ??
          prior.get(sq.id) ?? {
            sub_question_id: sq.id,
            question: sq.question,
            status: 'not_attempted' as const,
            findings: [],
            sources: [],
            note: 'not attempted in this pass',
          },
      );
      const total = results.reduce((n, r) => n + r.findings.length, 0);
      // Fold this pass's work into the investigation-level counters. Counted
      // from the MERGED results (not just `fresh`) so a resumed run cannot
      // double-count the facets it kept, and so the numbers the owner sees are
      // the investigation's, not the slice's.
      counters = {
        ...counters,
        sources_read: results.reduce((n, r) => n + r.sources.length, 0),
        rounds_spent: results.reduce((n, r) => n + (r.rounds_spent ?? 0), 0),
      };
      const coverage = compute_coverage(plan, results);
      row = { ...row, findings: results, coverage };
      persist({ findings: results, coverage });
      log(
        `investigated ${to_run.length} of ${plan.sub_questions.length} facet(s) — ` +
          `${total} finding(s); ${coverage_summary_line(coverage)}`,
      );
      set_status('verifying');
      progressed = true;
    }

    /* ---- verify -------------------------------------------------- */
    if (row.status === 'verifying') {
      const verification = await verify_investigation(deps, row);
      row = { ...row, verification };
      persist({ verification });
      log(
        `verified ${verification.claims_checked} claim(s) — dropped ${verification.dropped_claims.length}`,
      );
      set_status('synthesizing');
      progressed = true;
    }

    /* ---- synthesize + report ------------------------------------- */
    if (row.status === 'synthesizing') {
      row = await synthesize_and_report(deps, ctx, store, row, tz, { log, set_status });
      progressed = true;
    }

    store.set_error_streak(row.id, 0);
    persist({ error: null });

    /* ---- record this slice's work (v2 phase 5) -------------------- */
    // RECORD here, CHECK at the top of the next slice. The check cannot live
    // here: a slice runs the whole phase chain, so by the time we reach this
    // line the status is always `incomplete`, `done` or `cancelled` — never
    // mid-flight — and an adversarial review proved the old end-of-slice gate
    // made `stalled` unreachable at every depth. Recording is unconditional
    // (except on cancel, which is terminal and not ours to annotate).
    if (row.status !== 'cancelled') {
      const verified = row.verification?.claims_checked ?? 0;
      const resolved = (row.coverage?.facets ?? []).filter((f) => f.status !== 'not_attempted')
        .length;
      counters = record_slice(
        counters,
        progress_signature({
          sources_read: counters.sources_read,
          rounds_spent: counters.rounds_spent,
          facets_resolved: resolved,
          claims_verified: verified,
        }),
      );
      store.set_counters(row.id, counters);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    slice_error = msg;
    error_streak += 1;
    store.set_error_streak(row.id, error_streak);
    log(`slice error (${error_streak}/${MAX_ERROR_STREAK}): ${msg}`);
    // ALSO to the console. The row's log is the right durable home, but it is
    // only readable by someone who already suspects this investigation — so a
    // slice that throws every time was invisible in the orchestrator log while
    // the run marched to `failed`. That is the same class as a background job
    // whose failure never reaches the log (see the private dev log); the stack matters
    // because these throws come from connector wiring, not from the model.
    console.error(
      `[deep-research] slice error for ${row.id} (${error_streak}/${MAX_ERROR_STREAK}):`,
      err,
    );
    // Through `set_status` like every other transition: a run the requester
    // already cancelled must not be relabelled `failed` — that reads as "Hearth
    // broke" when what happened is "you stopped it".
    if (error_streak >= MAX_ERROR_STREAK) {
      row = { ...row, status: set_status('failed', { error: msg }) };
    } else {
      persist({ error: msg });
    }
  }

  const fresh = store.get(investigation_id) ?? row;
  memory.log_action({
    intent_id: ctx.intent_id,
    agent,
    tool_name: 'research_investigation',
    tool_input: { investigation_id, subject: fresh.subject },
    execution_result: {
      status: fresh.status,
      progressed,
      findings: fresh.findings.reduce((n, r) => n + r.findings.length, 0),
      dropped: fresh.verification?.dropped_claims.length ?? 0,
      // Coverage in the audit trail, so "which facets went missing" is a query
      // rather than an archaeology exercise on the dossier text.
      coverage: coverage_tally(fresh.coverage),
      sources_persisted: (() => {
        try {
          return sources_store.count_for_investigation(investigation_id);
        } catch {
          return 0;
        }
      })(),
    },
    ...(slice_error ? { error: slice_error } : {}),
    ...(ctx.user?.id ? { user_id: ctx.user.id } : {}),
  });

  return {
    investigation_id,
    status: fresh.status,
    progressed,
    ...(slice_error ? { error: slice_error } : {}),
  };
}

/* ------------------------------------------------------------------ */
/* Serialization + the detached kick                                   */
/* ------------------------------------------------------------------ */

/** Per-investigation promise chains — two advances for the same row must
 *  never interleave (both would mutate the same state). */
const _chains = new Map<string, Promise<unknown>>();

export function advance_investigation_chained(
  deps: InvestigationRunnerDeps,
  ctx: ToolContext,
  investigation_id: string,
  opts: { deadline_ms?: number } = {},
): Promise<AdvanceInvestigationResult> {
  const prior = _chains.get(investigation_id) ?? Promise.resolve();
  const run = prior.then(() => advance_investigation(deps, ctx, investigation_id, opts));
  _chains.set(
    investigation_id,
    run.then(
      () => {},
      () => {},
    ),
  );
  return run;
}

/**
 * Fire-and-forget run after deep_research files — slices back-to-back so a
 * chat ask completes within minutes, not at the nightly sweep. A no-progress
 * slice breaks the loop; the sweep is the retry path.
 */
export function kick_investigation_detached(
  deps: InvestigationRunnerDeps,
  investigation_id: string,
  agent: string,
): void {
  void (async () => {
    try {
      // v2 phase 5: the SLICE COUNT is no longer the stop condition — the work
      // budget is. `max_slices` here is a runaway backstop set well clear of
      // what the source/round budgets allow, so an exhaustive run is bounded by
      // what it is authorised to READ rather than by an arbitrary 8 passes.
      const slice_cap = budget_for(
        new ResearchInvestigationStore(deps.library_deps.db).get(investigation_id)?.depth,
      ).max_slices;
      for (let i = 0; i < slice_cap; i++) {
        const ctx: ToolContext = {
          memory: deps.library_deps.memory,
          llm: deps.llm,
          now: new Date(),
          intent_id: ulid(),
          specialist_id: agent,
        };
        const res = await advance_investigation_chained(deps, ctx, investigation_id);
        if (!OPEN_INVESTIGATION_STATUSES.includes(res.status as InvestigationStatus)) break;
        if (!res.progressed) break;
      }
    } catch (err) {
      console.error(`[deep-research] detached run failed for ${investigation_id}:`, err);
    }
  })();
}
