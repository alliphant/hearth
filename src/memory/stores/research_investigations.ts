/**
 * ResearchInvestigationStore — durable state for Kate's subject-oriented
 * deep-research investigations (2026-06-19).
 *
 * A deep-research investigation is a "go find out everything about X"
 * ask Kate hands off: a person (Dana Marsh, the massage therapist), a
 * product, a place, a decision. Too big for one chat turn (8 fetches, 15
 * rounds, 2000 tokens, no async), so the runner
 * (src/specialists/kate/research_investigation_runner.ts) advances it in
 * bounded slices and persists progress here after each one.
 *
 * Sibling of ResearchCommissionStore, but a different SHAPE: a commission
 * builds a roster CATALOG (repository guide); an investigation answers a
 * QUESTION (a synthesized, cited dossier) by fanning out across
 * sub-questions, verifying the load-bearing claims, then composing.
 *
 * Status machine:
 *   pending → planning → investigating → verifying → synthesizing → done
 *                            ↖________________________ incomplete
 *                  ↘ failed (terminal, carries `error`)
 *   cancelled is terminal and reachable from ANY open status via
 *   POST /api/specialists/:id/research/:rid/cancel (2026-07-29; before that it
 *   was an operator UPDATE only). The runner adopts it at its next phase
 *   boundary, and every status write in the runner — terminal ones included —
 *   goes through one guarded writer, so a finishing slice cannot put
 *   `done`/`failed` back over a cancel.
 *
 *   `incomplete` (v2 phase 2) means a partial dossier exists but the coverage
 *   ledger still carries `not_attempted` facets. It is OPEN, so the sweep
 *   resumes it — the runner re-enters `investigating` for just those facets and
 *   merges. Bounded by state.resume_attempts so it always converges: past the
 *   cap the leftovers are recorded `unanswerable` and the row reaches `done`.
 *   Being open, it is also CANCELLABLE, and the guarded writer above is what
 *   stops a resume slice from writing `incomplete` over a landed cancel.
 *
 * Resumability is PER-PHASE, not per-sub-question: the fan-out is the
 * point, and a sub-investigator is an idempotent read (search → fetch →
 * extract), so a slice that can't finish the fan-out re-runs it next slice
 * (overwriting findings_json). The slice mechanism is the crash-recovery
 * backstop, not the steady-state driver — the common case finishes
 * investigating in one slice.
 *
 * JSON columns are parsed defensively — a corrupt blob degrades to the
 * empty default, never throws.
 */
import type { Database } from 'bun:sqlite';
import { randomBytes } from 'node:crypto';
import { note_visible_to_caller, type Caller } from '@memory/private_to';
import { normalize_depth, type BudgetCounters, type ResearchDepth } from '@core/research_budget';

export type InvestigationStatus =
  | 'pending'
  | 'planning'
  | 'investigating'
  | 'verifying'
  | 'synthesizing'
  /** A partial dossier exists but the coverage ledger still carries
   *  `not_attempted` facets — honest, resumable, NOT done (v2 phase 2). */
  | 'incomplete'
  /**
   * Progress stopped, budget did not (v2 phase 5). N consecutive slices moved
   * no counter — not slow, STATIONARY. Deliberately NOT in
   * OPEN_INVESTIGATION_STATUSES: the sweep must not quietly resume a run that
   * is going nowhere, because that is how a stall becomes an infinite loop
   * nobody sees. The owner picks: resume with more budget, narrow, or stop.
   */
  | 'stalled'
  | 'done'
  | 'failed'
  | 'cancelled';

/** Statuses the runner will still advance. */
export const OPEN_INVESTIGATION_STATUSES: readonly InvestigationStatus[] = [
  'pending',
  'planning',
  'investigating',
  'verifying',
  'synthesizing',
  'incomplete',
];

/**
 * `public_figure` (2026-07-29) is a person in the PUBLIC record — an official, a
 * candidate, an executive, an author. It carves the work up exactly like
 * `person` and still writes a People/ note, but stamps `relationship:
 * public_figure` so the note stays OUT of the household's relationship surfaces
 * (see is_non_contact). Ruby's civic research filed councilmembers as plain
 * `person`, which defaulted them to `acquaintance` and put a stranger in the
 * contact graph. The distinction is the researching model's call, not a name
 * list — that's why it's a subject_kind and not a post-hoc classifier.
 */
export type SubjectKind =
  | 'person'
  | 'public_figure'
  | 'product'
  | 'place'
  | 'decision'
  | 'general';

/** Subject kinds that produce a People/ note writeback. */
export const PERSON_SUBJECT_KINDS: readonly SubjectKind[] = ['person', 'public_figure'];

export interface SubQuestion {
  id: string;
  question: string;
  rationale?: string;
  /**
   * How this facet should be WORKED (2026-07-31).
   *
   * `records` routes to government record systems — CourtListener for federal
   * dockets, and the resolved county's appraisal district / clerks — because a
   * records question is not answerable by reading the open web. Searching the
   * words "Georgetown TX property records" returns SEO farms; the record is in
   * the Williamson County Appraisal District.
   *
   * `topic` is the pre-existing search-and-read pipeline.
   *
   * Assigned by the PLANNER model, which is the thing that actually knows
   * whether "does he own the house" is a records question. Optional so rows
   * planned before this existed keep working (undefined ≡ `topic`).
   */
  kind?: 'records' | 'topic';
}

export interface InvestigationPlan {
  sub_questions: SubQuestion[];
}

/** One cited source. Its [S#] index is its position in the sub-question's
 *  `sources` array + 1. fetched_ok=false records a source we tried but
 *  couldn't read — kept for honesty, never cited. */
export interface Source {
  url: string;
  title: string | null;
  fetched_ok: boolean;
}

export interface SubFinding {
  /** A grounded claim answering the sub-question. */
  text: string;
  /** 1-based [S#] indices into the sub-question's `sources`. */
  source_indices: number[];
  /**
   * A VERBATIM span from a cited source that states this claim (§3.5 rung 2,
   * 2026-07-31). Optional and additive — legacy findings have none, and an
   * absent quote never flags anything. When present it is checked by string
   * containment against the source's persisted body: no LLM, no judgement, and
   * no way to be talked out of it. The same check Ruby's `evidence_quote` gate
   * runs on the write side (@core/quote_grounding).
   */
  quote?: string;
}

export interface SubQuestionResult {
  sub_question_id: string;
  question: string;
  /**
   * `not_attempted` (v2 phase 2) is the load-bearing addition: it separates
   * "the slice deadline ran out / the search backend never answered" from
   * "we looked and the sources do not answer this" (`failed`). Before it
   * existed both collapsed into `failed`, so a facet lost to arithmetic was
   * indistinguishable from a facet the web genuinely cannot answer — which is
   * precisely why six-facet briefs lost most of their facets silently. Only
   * `not_attempted` is resumable.
   */
  status: 'ok' | 'partial' | 'failed' | 'not_attempted';
  findings: SubFinding[];
  sources: Source[];
  /**
   * Sources fetched and READ, then refused because they never name the subject
   * (2026-07-30). Recorded rather than silently discarded: "I read six pages
   * about other people named Josie" is the single most useful thing the
   * Reyes investigation could have said, and it said nothing at all.
   */
  dropped_sources?: Array<{ url: string; title: string | null; reason: string }>;
  /**
   * Sources we chose NOT to fetch because reading them would have been
   * traceable to this household — and on a social network, shown to the person
   * being researched (2026-07-31). Distinct from `dropped_sources` in the way
   * that matters: those were read and refused, these were never read, on
   * purpose. The dossier states them so a reader understands the gap is a
   * decision, not a failure.
   */
  refused_sources?: Array<{ url: string; title: string | null; reason: string }>;
  /** Agentic follow-up rounds this facet spent (v2 phase 4). Feeds the
   *  investigation-level round budget. */
  rounds_spent?: number;
  /** "search backend down", "no sources resolved", etc. */
  note?: string;
}

/** Where one planned facet ended up. See src/core/research_coverage.ts. */
export type FacetStatus = 'answered' | 'partial' | 'unanswerable' | 'not_attempted';

export interface CoverageFacet {
  sub_question_id: string;
  question: string;
  status: FacetStatus;
  /** Why, for everything except `answered`. Surfaced to the reader verbatim. */
  reason?: string;
  finding_count: number;
  source_count: number;
}

/**
 * The tracked checklist of the plan's facets. The dossier OPENS with this, so
 * an unanswered facet is stated rather than discovered by its absence.
 */
export interface CoverageLedger {
  facets: CoverageFacet[];
}

export interface ClaimVerdict {
  claim: string;
  verdict: 'verified' | 'unverified' | 'contradicted';
  reason: string;
}

export interface VerificationResult {
  claims_checked: number;
  verdicts: ClaimVerdict[];
  /** Claims pulled from the dossier (unverified/contradicted by the judge). */
  dropped_claims: string[];
}

export interface InvestigationRunState {
  /** Consecutive errored slices; MAX_ERROR_STREAK of them → failed. */
  error_streak?: number;
  /**
   * Capped human-readable progress trail for the office + status tool.
   *
   * APPEND-ONLY and store-owned: written exclusively through `append_log`,
   * never through `update()`. Two independent writers touch it (the runner's
   * slice and the cancel route), so a caller holding a snapshot cannot write
   * the column back without deleting the other's lines.
   */
  log?: string[];
  /**
   * How many times an `incomplete` investigation has been resumed to retry its
   * `not_attempted` facets. Bounded by MAX_RESUME_ATTEMPTS in the runner: past
   * it, the leftovers are recorded as `unanswerable` with an honest reason
   * rather than resumed forever (an open status the sweep can never close is
   * its own silent failure).
   */
  resume_attempts?: number;
  /**
   * Budget + progress counters (v2 phase 5). Absent on rows written before the
   * phase; `counters_from` fills the zeros, so an old row simply starts
   * counting from its next slice.
   */
  counters?: BudgetCounters;
}

/** Trailing log lines kept. Enforced in `append_log` — one place, so the two
 *  writers can't disagree about the cap. */
const LOG_CAP = 40;

export interface InvestigationRow {
  id: string;
  subject: string;
  subject_kind: SubjectKind;
  brief: string;
  person_id: string | null;
  /**
   * Selects the WORK budget (v2 phase 5) — sources, investigator rounds,
   * slices. Legacy rows carry `'deep'`, which `normalize_depth` maps to
   * `standard`, so nothing written before the phase changes behaviour.
   */
  depth: ResearchDepth;
  status: InvestigationStatus;
  requested_by: string | null;
  /** Specialist that filed it — the dossier shelves to THEIR library. */
  agent_id: string | null;
  private_to: string | null;
  conversation_id: string | null;
  plan: InvestigationPlan | null;
  state: InvestigationRunState;
  findings: SubQuestionResult[];
  /** Per-facet checklist; null on rows written before the ledger existed
   *  (the runner recomputes from findings on the next slice). */
  coverage: CoverageLedger | null;
  /**
   * Disambiguating facts the OWNER supplied ("she works at BrightCase", "she
   * lives in Milton CO", a profile URL). A private person's name alone is not
   * a searchable identity — these are what turn an unfindable subject into a
   * findable one, and they ride into query planning and the extractor prompt.
   */
  anchor_facts: string[];
  /** How many times this dossier has been REVISED. 0 = first pass. */
  revision: number;
  verification: VerificationResult | null;
  dossier_md: string | null;
  dossier_note_path: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

interface RawRow {
  id: string;
  subject: string;
  subject_kind: string;
  brief: string;
  person_id: string | null;
  depth: string;
  status: string;
  requested_by: string | null;
  /** Specialist that filed it — the dossier shelves to THEIR library. */
  agent_id: string | null;
  private_to: string | null;
  conversation_id: string | null;
  plan_json: string | null;
  state_json: string;
  findings_json: string;
  coverage_json: string | null;
  anchor_facts_json: string | null;
  revision: number | null;
  verification_json: string | null;
  dossier_md: string | null;
  dossier_note_path: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

function parse_json<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

const SUBJECT_KINDS: readonly SubjectKind[] = [
  'person',
  'public_figure',
  'product',
  'place',
  'decision',
  'general',
];

const ALL_STATUSES: readonly InvestigationStatus[] = [
  'pending',
  'planning',
  'investigating',
  'verifying',
  'synthesizing',
  'incomplete',
  // Must be listed: `to_row` coerces any status it does not recognise to
  // 'failed', so omitting this would make every stalled row read back as a
  // failure — and "Hearth broke" is a materially different thing to tell the
  // owner than "this stopped making progress, here are three ways forward".
  'stalled',
  'done',
  'failed',
  'cancelled',
];

function to_row(raw: RawRow): InvestigationRow {
  return {
    id: raw.id,
    subject: raw.subject,
    subject_kind: SUBJECT_KINDS.includes(raw.subject_kind as SubjectKind)
      ? (raw.subject_kind as SubjectKind)
      : 'general',
    brief: raw.brief,
    person_id: raw.person_id,
    depth: normalize_depth(raw.depth),
    status: ALL_STATUSES.includes(raw.status as InvestigationStatus)
      ? (raw.status as InvestigationStatus)
      : 'failed',
    requested_by: raw.requested_by,
    agent_id: (raw as { agent_id?: string | null }).agent_id ?? null,
    private_to: raw.private_to,
    conversation_id: raw.conversation_id,
    plan: parse_json<InvestigationPlan | null>(raw.plan_json, null),
    state: parse_json<InvestigationRunState>(raw.state_json, {}),
    findings: parse_json<SubQuestionResult[]>(raw.findings_json, []),
    coverage: parse_json<CoverageLedger | null>(
      (raw as { coverage_json?: string | null }).coverage_json ?? null,
      null,
    ),
    anchor_facts: parse_json<string[]>(
      (raw as { anchor_facts_json?: string | null }).anchor_facts_json ?? null,
      [],
    ),
    revision: Number((raw as { revision?: number | null }).revision ?? 0) || 0,
    verification: parse_json<VerificationResult | null>(raw.verification_json, null),
    dossier_md: raw.dossier_md,
    dossier_note_path: raw.dossier_note_path,
    error: raw.error,
    created_at: raw.created_at,
    updated_at: raw.updated_at,
    completed_at: raw.completed_at,
  };
}

/** Opaque 12-char id with the ri_ type prefix (mirrors rc_/ap_/sch_). */
function new_investigation_id(): string {
  const alphabet = 'abcdefghjkmnpqrstvwxyz0123456789';
  const bytes = randomBytes(12);
  let out = '';
  for (let i = 0; i < 12; i++) out += alphabet[bytes[i]! % alphabet.length];
  return `ri_${out}`;
}

function normalize_subject(subject: string): string {
  return subject.trim().toLowerCase().replace(/\s+/g, ' ');
}

export interface CreateInvestigationInput {
  subject: string;
  subject_kind: SubjectKind;
  brief: string;
  person_id?: string | null;
  requested_by?: string | null;
  /** Specialist filing it (ctx.specialist_id). Drives the dossier shelf. */
  agent_id?: string | null;
  private_to?: string | null;
  conversation_id?: string | null;
  /** Work budget (v2 phase 5). Omitted ≡ `standard`. */
  depth?: ResearchDepth | null;
}

export class ResearchInvestigationStore {
  constructor(private db: Database) {}

  create(input: CreateInvestigationInput): InvestigationRow {
    const now = new Date().toISOString();
    const id = new_investigation_id();
    this.db
      .prepare(
        `INSERT INTO research_investigations
           (id, subject, subject_kind, brief, person_id, depth, status,
            requested_by, agent_id, private_to, conversation_id, state_json,
            findings_json, created_at, updated_at)
         VALUES (@id, @subject, @kind, @brief, @person_id, @depth, 'pending',
                 @requested_by, @agent_id, @private_to, @conversation_id, '{}', '[]',
                 @now, @now)`,
      )
      .run({
        '@id': id,
        '@subject': input.subject,
        '@kind': input.subject_kind,
        '@brief': input.brief,
        '@person_id': input.person_id ?? null,
        '@depth': normalize_depth(input.depth),
        '@requested_by': input.requested_by ?? null,
        '@agent_id': input.agent_id ?? null,
        '@private_to': input.private_to ?? null,
        '@conversation_id': input.conversation_id ?? null,
        '@now': now,
      });
    const row = this.get(id);
    if (!row) throw new Error(`research_investigations: insert of ${id} not readable back`);
    return row;
  }

  get(id: string): InvestigationRow | null {
    const raw = this.db
      .prepare(`SELECT * FROM research_investigations WHERE id = @id`)
      .get({ '@id': id }) as RawRow | null;
    return raw ? to_row(raw) : null;
  }

  list(
    opts: {
      statuses?: readonly InvestigationStatus[];
      requested_by?: string;
      limit?: number;
    } = {},
  ): InvestigationRow[] {
    const limit = Math.max(1, Math.min(opts.limit ?? 25, 200));
    const wheres: string[] = [];
    const binds: string[] = [];
    if (opts.statuses && opts.statuses.length > 0) {
      wheres.push(`status IN (${opts.statuses.map(() => '?').join(', ')})`);
      binds.push(...opts.statuses);
    }
    if (opts.requested_by !== undefined) {
      wheres.push('requested_by = ?');
      binds.push(opts.requested_by);
    }
    const where = wheres.length > 0 ? `WHERE ${wheres.join(' AND ')}` : '';
    // Open statuses sweep oldest-first (fair drain); listing is newest-first.
    const order =
      opts.statuses && opts.statuses.length > 0 ? 'created_at ASC' : 'created_at DESC';
    const rows = this.db
      .prepare(
        `SELECT * FROM research_investigations ${where} ORDER BY ${order} LIMIT ?`,
      )
      .all(...binds, limit) as RawRow[];
    return rows.map(to_row);
  }

  /**
   * Investigations the caller may see — their own asks, plus anything the
   * `private_to` cordon makes visible to their tier. The owner has NO
   * god-view: an owner does not see a household member's investigation.
   */
  list_for_user(caller: Caller, opts: { limit?: number } = {}): InvestigationRow[] {
    const rows = this.list({ limit: Math.max(1, Math.min(opts.limit ?? 25, 200)) });
    return rows.filter(
      (r) =>
        r.requested_by === caller.user_id ||
        note_visible_to_caller(r.private_to ?? undefined, caller),
    );
  }

  /**
   * Re-file collapse: an OPEN investigation by the same requester into the
   * same normalized subject is the same ask — return it instead of minting
   * a twin (mirrors the commission/proposals-inflow contract).
   */
  find_open_for_subject(subject: string, requested_by: string | null): InvestigationRow | null {
    const norm = normalize_subject(subject);
    for (const row of this.list({ statuses: OPEN_INVESTIGATION_STATUSES, limit: 100 })) {
      if (row.requested_by !== requested_by) continue;
      if (normalize_subject(row.subject) === norm) return row;
    }
    return null;
  }

  /**
   * Append progress lines to `state.log`, read-modify-write from the LIVE row.
   *
   * `state` is a whole-JSON column with TWO writers — the runner's slice and
   * `POST …/research/:rid/cancel` — and a slice holds the row for up to five
   * minutes. Writing a snapshot taken at slice start back over the column
   * therefore DELETES whatever the other writer appended in between: that is
   * exactly how the `cancelled by <user> while <status>` line used to vanish on
   * the runner's very next persist, leaving no record of who stopped the run.
   * So `state` is store-owned and append-only, and `update()` deliberately
   * cannot write it (see the patch type below) — there is no snapshot to go
   * stale.
   *
   * The read and the write sit in one synchronous block: bun:sqlite is
   * synchronous and every writer of this table runs in the orchestrator on the
   * same event loop, so no `await` splits them and no other JS can interleave.
   * (A cross-process writer would need SQLite's own `json_set`; there isn't
   * one, and adding one would have to come here.)
   */
  append_log(id: string, ...lines: string[]): void {
    if (lines.length === 0) return;
    this.mutate_state(id, (state) => ({
      ...state,
      log: [...(state.log ?? []), ...lines].slice(-LOG_CAP),
    }));
  }

  /** Consecutive-errored-slice counter. Goes through `mutate_state` for the
   *  same reason `append_log` does: it shares the `state` column with the log,
   *  so writing it from a snapshot would clobber the other writer's lines. */
  set_error_streak(id: string, streak: number): void {
    this.mutate_state(id, (state) => ({ ...state, error_streak: streak }));
  }

  /** How many times an `incomplete` run has been resumed to retry facets it
   *  never attempted (v2 phase 2). Same `mutate_state` discipline as
   *  `set_error_streak`: it shares the `state` column with the log, and a
   *  snapshot write here would delete a `cancelled by …` line appended between
   *  this slice's read and its write. */
  set_resume_attempts(id: string, attempts: number): void {
    this.mutate_state(id, (state) => ({ ...state, resume_attempts: attempts }));
  }

  /**
   * Work counters for the budget + stall watchdog (v2 phase 5). Same
   * `mutate_state` discipline as the two above — they share the `state` column
   * with the append-only log, and a snapshot write would delete a
   * `cancelled by …` line appended between this slice's read and its write.
   */
  set_counters(id: string, counters: BudgetCounters): void {
    this.mutate_state(id, (state) => ({ ...state, counters }));
  }

  private mutate_state(
    id: string,
    fn: (state: InvestigationRunState) => InvestigationRunState,
  ): void {
    const live = this.get(id);
    if (!live) return;
    this.db
      .prepare(
        `UPDATE research_investigations SET state_json = @state, updated_at = @now WHERE id = @id`,
      )
      .run({
        '@id': id,
        '@state': JSON.stringify(fn(live.state)),
        '@now': new Date().toISOString(),
      });
  }

  /**
   * The most recent investigation into this subject by this requester, at ANY
   * status, within `max_age_ms`.
   *
   * `find_open_for_subject` deliberately only sees OPEN rows — it exists to stop
   * twins. This one sees FINISHED ones too, because the owner handing over a
   * disambiguating fact ("she works at BrightCase") is not a new question, it is
   * the SAME question with the missing piece. Re-opening that row keeps the
   * evidence trail, the cordon and the person link together instead of minting
   * a rival investigation into the same human being.
   */
  find_recent_for_subject(
    subject: string,
    requested_by: string | null,
    max_age_ms: number,
    now: Date = new Date(),
  ): InvestigationRow | null {
    const norm = normalize_subject(subject);
    const cutoff = now.getTime() - max_age_ms;
    for (const row of this.list({ limit: 200 })) {
      if (row.requested_by !== requested_by) continue;
      if (normalize_subject(row.subject) !== norm) continue;
      if (Date.parse(row.updated_at) < cutoff) continue;
      return row;
    }
    return null;
  }

  /**
   * Re-open a finished investigation with new anchor facts and send it back
   * through the pipeline from planning.
   *
   * **The dossier is what accumulates; findings are per-run working material.**
   * Findings are ALWAYS cleared, because re-opening replans, a new plan mints
   * fresh `sq_*` ids, and carrying old per-sub-question results across that
   * boundary would silently reuse an answer to a DIFFERENT question. What
   * carries forward instead is the dossier itself — exactly the shape
   * people_synthesis settled on (2026-07-26): feed the prior portrait back in
   * and revise it, because a dossier rebuilt from scratch every time can never
   * get deep.
   *
   * `carry_dossier` is the one real decision, and it is derived from what the
   * prior run actually recorded, not guessed:
   *   - **false — correction.** The prior run could not confirm the subject (or
   *     flagged a same-name conflict). Its dossier describes a stranger; it is
   *     poison, not a starting point, and refining it would launder a wrong
   *     person's biography into the next revision.
   *   - **true — deepening.** The prior run was about the right person and the
   *     owner is adding detail. Keep the dossier as the thing to revise.
   *
   * `dossier_note_path` is preserved either way — the runner needs it to
   * SUPERSEDE the old shelved note rather than leave a second copy of the
   * subject on the library shelf (and in RAG) forever.
   */
  reopen_with_facts(
    id: string,
    facts: readonly string[],
    opts: { carry_dossier: boolean; depth?: ResearchDepth | null },
  ): InvestigationRow | null {
    const row = this.get(id);
    if (!row) return null;
    const merged = [...row.anchor_facts];
    for (const f of facts) {
      const t = f.trim();
      if (t.length === 0) continue;
      if (!merged.some((m) => m.toLowerCase() === t.toLowerCase())) merged.push(t);
    }
    this.db
      .prepare(
        `UPDATE research_investigations
            SET status = 'planning', anchor_facts_json = @facts, findings_json = '[]',
                coverage_json = NULL, verification_json = NULL,
                dossier_md = @dossier, error = NULL, completed_at = NULL,
                depth = @depth,
                revision = revision + 1, updated_at = @now
          WHERE id = @id`,
      )
      .run({
        '@id': id,
        '@facts': JSON.stringify(merged.slice(0, 25)),
        '@dossier': opts.carry_dossier ? row.dossier_md : null,
        // A re-run at a DEEPER setting must actually get the larger allowance —
        // `deep_research`'s own description promises exactly that. Omitted
        // (undefined) keeps whatever the row already had.
        '@depth': normalize_depth(opts.depth ?? row.depth),
        '@now': new Date().toISOString(),
      });
    // RESET THE BUDGET COUNTERS. This is not housekeeping — leaving them is a
    // FALSE STALL waiting to happen. A re-open replans and clears findings, so
    // the runner recomputes `sources_read` from the NEW (empty) result set and
    // the signature drops — 26 back to 3 — while `last_progress_signature`
    // still holds the old high-water mark. `record_slice` then sees every
    // genuinely productive slice as "moved nothing", and three of them declare
    // a working run stalled. That is precisely the failure smoke:research-budget
    // exists to forbid, reached through a path the pure smoke cannot see.
    // `resume_attempts` goes with them, and that one is load-bearing: an
    // exhaustive row reaches `stalled` only by exhausting its 25 resumes, so a
    // re-open that kept the count would compute `attempts < resume_cap` false on
    // its very first slice and converge instantly — the owner takes option 1,
    // is told the investigation resumed, and it does nothing. Four reviewers
    // independently flagged the counters comment as claiming more than it did.
    //
    // A new revision is new work and gets a fresh allowance.
    this.mutate_state(id, (state) => {
      const { counters: _c, resume_attempts: _r, ...rest } = state;
      return rest;
    });
    return this.get(id);
  }

  /**
   * Persist a partial update. Only the provided fields change; updated_at
   * always bumps. Terminal statuses stamp completed_at.
   *
   * `state` is NOT patchable here on purpose — see `append_log`.
   */
  update(
    id: string,
    patch: Partial<{
      status: InvestigationStatus;
      plan: InvestigationPlan;
      findings: SubQuestionResult[];
      coverage: CoverageLedger;
      anchor_facts: string[];
      verification: VerificationResult;
      dossier_md: string;
      dossier_note_path: string;
      person_id: string;
      error: string | null;
    }>,
  ): void {
    const sets: string[] = ['updated_at = @now'];
    const binds: Record<string, unknown> = { '@id': id, '@now': new Date().toISOString() };
    if (patch.status !== undefined) {
      sets.push('status = @status');
      binds['@status'] = patch.status;
      if (patch.status === 'done' || patch.status === 'failed' || patch.status === 'cancelled') {
        sets.push('completed_at = @completed');
        binds['@completed'] = new Date().toISOString();
      }
    }
    if (patch.plan !== undefined) {
      sets.push('plan_json = @plan');
      binds['@plan'] = JSON.stringify(patch.plan);
    }
    if (patch.findings !== undefined) {
      sets.push('findings_json = @findings');
      binds['@findings'] = JSON.stringify(patch.findings);
    }
    if (patch.coverage !== undefined) {
      sets.push('coverage_json = @coverage');
      binds['@coverage'] = JSON.stringify(patch.coverage);
    }
    if (patch.anchor_facts !== undefined) {
      sets.push('anchor_facts_json = @anchor_facts');
      binds['@anchor_facts'] = JSON.stringify(patch.anchor_facts);
    }
    if (patch.verification !== undefined) {
      sets.push('verification_json = @verification');
      binds['@verification'] = JSON.stringify(patch.verification);
    }
    if (patch.dossier_md !== undefined) {
      sets.push('dossier_md = @dossier');
      binds['@dossier'] = patch.dossier_md;
    }
    if (patch.dossier_note_path !== undefined) {
      sets.push('dossier_note_path = @dossier_path');
      binds['@dossier_path'] = patch.dossier_note_path;
    }
    if (patch.person_id !== undefined) {
      sets.push('person_id = @person_id');
      binds['@person_id'] = patch.person_id;
    }
    if (patch.error !== undefined) {
      sets.push('error = @error');
      binds['@error'] = patch.error;
    }
    this.db
      .prepare(`UPDATE research_investigations SET ${sets.join(', ')} WHERE id = @id`)
      .run(binds as never);
  }
}
