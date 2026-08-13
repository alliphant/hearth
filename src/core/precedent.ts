/**
 * Precedent memory — household case law (Kate self-direction C3, 2026-07-05).
 *
 * The decided history — every decided proposal, every Proposal-Court verdict
 * with its lens votes, every closed process miss — is labeled training data
 * nobody reads. This engine renders each into a compact CASE
 * (situation → action → outcome, WITH outcome confidence), indexes it into
 * `precedent_cases` (PrecedentStore), and answers "what did we do last time?"
 * three ways:
 *
 *   1. `recall_precedent` (Kate's chat/deliberation read tool) — the model
 *      DECIDES to consult history (LAW #1-clean).
 *   2. The Proposal Court's lens evidence packs — top matches for each docket
 *      case ("the bench has seen this shape: approved 2×, denied 1× because…").
 *   3. `ProposalsStore.create()` — precedent matches stamped onto the new
 *      row's `precedent_json` for the court/owner surfaces.
 *
 * (2) and (3) are evidence-shaping inside DETERMINISTIC system pipelines the
 * runtime already invoked (the citations/exemplar idiom) — not chat
 * pre-injection. Precedent is ALWAYS evidence in a prompt, never a decision
 * rule: nothing here decides anything, and the label-honesty contract means
 * every case carries its outcome confidence ("denied, no reason recorded —
 * weak precedent").
 *
 * DARK behind HEARTH_PRECEDENT. Fail-open everywhere: no embedder ⇒ cases
 * index text-only and matching degrades to deterministic token overlap; any
 * error in a gather/attach path leaves the caller byte-identical to today.
 * The falsifiable metric is the court scorecard — agreement should RISE with
 * precedent in the lens packs; if it doesn't move in two weeks, say so.
 */

import type { Database } from 'bun:sqlite';
import { cosine, norm, unpack_f32, type Embedder } from './embeddings';
import {
  PrecedentStore,
  type PrecedentCandidate,
  type PrecedentCaseInput,
  type PrecedentConfidence,
  type PrecedentScope,
} from '@memory/stores/precedent_cases';

export function precedent_enabled(): boolean {
  return process.env.HEARTH_PRECEDENT === '1';
}

/** Vector-similarity floor for a case to count as "the same shape". */
function min_vector_sim(): number {
  const n = Number(process.env.HEARTH_PRECEDENT_MIN_SIM ?? 0.35);
  return Number.isFinite(n) && n > 0 && n < 1 ? n : 0.35;
}

/** Token-overlap floor for the deterministic fallback path. */
const MIN_TEXT_SIM = 0.12;

/** Per-run cap on embedding back-fill (batches of EMBED_BATCH). */
function embed_cap(): number {
  const n = Number(process.env.HEARTH_PRECEDENT_EMBED_CAP ?? 4096);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 4096;
}
const EMBED_BATCH = 64;

// ── text helpers ──────────────────────────────────────────────────────────

function gist(s: string | null | undefined, n = 180): string {
  return (s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
}

/** Same stopword discipline as the proposal critic's grouper: drop glue +
 *  queue boilerplate that would manufacture false overlap. */
const STOP = new Set([
  'the', 'and', 'for', 'that', 'this', 'with', 'from', 'was', 'are', 'has',
  'have', 'not', 'but', 'all', 'any', 'can', 'her', 'his', 'its', 'our',
  'out', 'who', 'why', 'how', 'when', 'what', 'which', 'into', 'over', 'than',
  'then', 'them', 'they', 'you', 'your', 'a', 'an', 'is', 'it', 'to', 'of',
  'in', 'on', 'at', 'so', 'no', 'or', 'be', 'as', 'by', 'we', 'will',
  'proposal', 'jasper', 'kate', 'beatrice', 'needs', 'fix', 'add', 'update',
  'flag', 'note', 'see', 'action', 'details', 'review', 'household',
]);

function tokens_of(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.toLowerCase().matchAll(/[a-z][a-z0-9_]{2,}/g)) {
    const t = m[0];
    if (!STOP.has(t)) out.add(t);
  }
  return out;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

// ── case rendering (label honesty lives here) ─────────────────────────────

interface RenderedCase {
  situation: string;
  case_md: string;
  outcome: string;
  confidence: PrecedentConfidence;
  confidence_note: string;
}

interface DecidedProposalRowLite {
  id: string;
  ts_decided: string;
  status: string;
  kind: string;
  specialist_id: string;
  rationale_md: string | null;
  title: string | null;
  summary: string | null;
  user_feedback: string | null;
  action_taken: string | null;
  user_id: string | null;
}

/** The scorecard's decided-by-court detection — feedback markers stamped by
 *  the court/teeth decide paths. */
function decided_by_court(feedback: string | null): boolean {
  const fb = (feedback ?? '').toLowerCase();
  return fb.startsWith('proposal court') || fb.startsWith('trust teeth');
}

export function render_proposal_case(row: DecidedProposalRowLite): RenderedCase {
  const by_court = decided_by_court(row.user_feedback);
  const decider = by_court ? 'court' : 'owner';
  const feedback = gist(row.user_feedback, 220);
  const headline = gist(row.title ?? row.summary ?? row.rationale_md, 140) || row.kind;

  let outcome: string;
  let confidence: PrecedentConfidence;
  let confidence_note: string;
  switch (row.status) {
    case 'approved':
    case 'acknowledged':
    case 'executed':
      outcome = 'approved';
      if (by_court) {
        confidence = 'moderate';
        confidence_note = 'court consensus (three lenses), not an owner decision';
      } else {
        confidence = 'strong';
        confidence_note = `owner approved${row.action_taken ? ` via '${row.action_taken}'` : ''}`;
      }
      break;
    case 'failed':
      outcome = 'approved';
      confidence = 'moderate';
      confidence_note = 'approved, but the execution itself failed';
      break;
    case 'denied':
      outcome = 'denied';
      if (by_court) {
        confidence = 'moderate';
        confidence_note = 'court consensus denial, lens reasons on record';
      } else if (feedback.length > 0) {
        confidence = 'strong';
        confidence_note = 'owner denied with a reason on record';
      } else {
        confidence = 'weak';
        confidence_note = 'denied, no reason recorded — weak precedent (could be wrong idea, bad timing, or already handled)';
      }
      break;
    case 'expired':
      outcome = 'lapsed';
      confidence = 'weak';
      confidence_note = 'lapsed unactioned — a timing signal, not a merits verdict';
      break;
    default:
      outcome = row.status;
      confidence = 'weak';
      confidence_note = `terminal status '${row.status}'`;
  }

  const decision_line = feedback.length > 0 ? `${decider}: ${feedback}` : `${decider}: no reason recorded`;
  const case_md = [
    `[${outcome} • ${confidence}] ${row.kind} by ${row.specialist_id} (${row.ts_decided.slice(0, 10)}) — ${headline}`,
    `why filed: ${gist(row.rationale_md, 220) || '(no rationale recorded)'}`,
    `decision: ${decision_line}`,
    `precedent weight: ${confidence_note}`,
  ].join('\n');

  return {
    situation: `${row.kind} ${headline} ${gist(row.rationale_md, 300)}`.trim(),
    case_md,
    outcome,
    confidence,
    confidence_note,
  };
}

interface VerdictSourceRow {
  audit_id: string;
  ts: string;
  proposal_id: string;
  outcome: string; // approved | rejected | lapsed | split | auto_armed
  votes: string[]; // "seat=vote"
  detail: string | null;
  // joined from the proposals table (the verdict row alone has no situation)
  proposal: {
    kind: string;
    specialist_id: string;
    title: string | null;
    summary: string | null;
    rationale_md: string | null;
    user_id: string | null;
  };
}

export function render_verdict_case(v: VerdictSourceRow): RenderedCase {
  const headline = gist(v.proposal.title ?? v.proposal.summary ?? v.proposal.rationale_md, 140) || v.proposal.kind;
  let outcome: string;
  let confidence: PrecedentConfidence;
  let confidence_note: string;
  switch (v.outcome) {
    case 'approved':
    case 'auto_armed':
      outcome = 'court approved';
      confidence = 'moderate';
      confidence_note = 'unanimous bench consensus (three lenses)';
      break;
    case 'rejected':
      outcome = 'court rejected';
      confidence = 'moderate';
      confidence_note = 'unanimous bench consensus (three lenses)';
      break;
    case 'lapsed':
      outcome = 'court lapsed';
      confidence = 'weak';
      confidence_note = 'expired as stale — timing, not merits';
      break;
    default:
      outcome = 'bench split';
      confidence = 'moderate';
      confidence_note = 'the lenses disagreed — it went to the owner';
  }
  const case_md = [
    `[${outcome} • ${confidence}] ${v.proposal.kind} by ${v.proposal.specialist_id} (${v.ts.slice(0, 10)}) — ${headline}`,
    `bench votes: ${v.votes.join(', ') || '(none recorded)'}${v.detail ? ` — ${gist(v.detail, 120)}` : ''}`,
    `precedent weight: ${confidence_note}`,
  ].join('\n');
  return {
    situation: `${v.proposal.kind} ${headline} ${gist(v.proposal.rationale_md, 300)}`.trim(),
    case_md,
    outcome,
    confidence,
    confidence_note,
  };
}

interface MissSourceRow {
  id: string;
  ts_created: string;
  ts_updated: string;
  subject_specialist_id: string;
  task_summary: string;
  gap: string;
  severity: string;
  status: string; // closed | verified
  evidence_ref: string | null;
  notes_md: string;
}

export function render_miss_case(m: MissSourceRow): RenderedCase {
  const verified = m.status === 'verified';
  const outcome = verified ? 'resolved (verified)' : 'resolved';
  const confidence: PrecedentConfidence = verified ? 'strong' : 'moderate';
  const confidence_note = verified
    ? 'fix verified against a fresh scan of the same evidence'
    : 'closed with the resolution in the trail (not independently verified)';
  // The tail of notes_md is the resolution trail — the freshest note lines.
  const trail = gist(m.notes_md.slice(-400), 260);
  const case_md = [
    `[${outcome} • ${confidence}] process miss for ${m.subject_specialist_id} (${m.ts_updated.slice(0, 10)}) — ${gist(m.task_summary, 140)}`,
    `gap: ${gist(m.gap, 220)}`,
    `resolution: ${trail || '(no trail recorded)'}`,
    `precedent weight: ${confidence_note}`,
  ].join('\n');
  return {
    situation: `${m.task_summary} ${gist(m.gap, 300)}`.trim(),
    case_md,
    outcome,
    confidence,
    confidence_note,
  };
}

// ── the nightly indexer ───────────────────────────────────────────────────

export interface PrecedentIndexDeps {
  db: Database;
  store: PrecedentStore;
  embedder?: Embedder;
}

export interface PrecedentIndexResult {
  enabled: boolean;
  scanned: number;
  indexed_new: number;
  updated: number;
  embedded: number;
  embed_pending: number;
  total_cases: number;
  /** Per-source failures (fail-open — one bad source never kills the run). */
  source_errors: string[];
}

const DECIDED_STATUSES = ['approved', 'acknowledged', 'executed', 'failed', 'denied', 'expired'];
const SOURCE_CAP = 3000;

/**
 * Index the decided history into precedent_cases. Idempotent — keyed on the
 * source id, unchanged sources skip. Embedding back-fill runs only when the
 * embedder is live; without it cases store text-only and recall degrades to
 * deterministic token overlap (never breaks).
 */
export async function run_precedent_index(deps: PrecedentIndexDeps): Promise<PrecedentIndexResult> {
  const result: PrecedentIndexResult = {
    enabled: precedent_enabled(),
    scanned: 0,
    indexed_new: 0,
    updated: 0,
    embedded: 0,
    embed_pending: 0,
    total_cases: 0,
    source_errors: [],
  };
  if (!result.enabled) return result;

  const apply = (c: PrecedentCaseInput): void => {
    result.scanned++;
    const r = deps.store.upsert(c);
    if (r.is_new) result.indexed_new++;
    else if (r.changed) result.updated++;
  };

  // 1. Decided proposals — the owner's (and court's) verdict trail.
  try {
    const rows = deps.db
      .prepare(
        `SELECT id, ts_decided, status, kind, specialist_id, rationale_md,
                title, summary, user_feedback, action_taken, user_id
           FROM proposals
          WHERE status IN (${DECIDED_STATUSES.map(() => '?').join(', ')})
            AND ts_decided IS NOT NULL
          ORDER BY ts_decided DESC LIMIT ${SOURCE_CAP}`,
      )
      .all(...DECIDED_STATUSES) as DecidedProposalRowLite[];
    for (const row of rows) {
      const rendered = render_proposal_case(row);
      if (rendered.situation.length < 8) continue; // nothing to match on
      apply({
        source_kind: 'proposal',
        source_id: row.id,
        proposal_id: row.id,
        kind: row.kind,
        specialist_id: row.specialist_id,
        user_id: row.user_id,
        decided_at: row.ts_decided,
        source_updated_at: row.ts_decided,
        ...rendered,
      });
    }
  } catch (err) {
    result.source_errors.push(`proposals: ${(err as Error).message}`);
  }

  // 2. Court verdicts — the bench's positions, including splits the owner
  //    hasn't resolved (a disagreement is itself precedent-worthy).
  try {
    const audit_rows = deps.db
      .prepare(
        `SELECT id, ts, tool_input, execution_result FROM audit_log
          WHERE tool_name = 'proposal_court_verdict'
          ORDER BY ts DESC LIMIT ${SOURCE_CAP}`,
      )
      .all() as Array<{ id: string; ts: string; tool_input: string; execution_result: string | null }>;
    const proposal_stmt = deps.db.prepare(
      `SELECT kind, specialist_id, title, summary, rationale_md, user_id
         FROM proposals WHERE id = @id`,
    );
    for (const row of audit_rows) {
      let proposal_id = '';
      let outcome = '';
      let votes: string[] = [];
      let detail: string | null = null;
      try {
        const input = JSON.parse(row.tool_input) as { proposal_id?: string };
        const res = JSON.parse(row.execution_result ?? '{}') as {
          outcome?: string;
          votes?: unknown;
          detail?: string;
        };
        proposal_id = String(input.proposal_id ?? '');
        outcome = String(res.outcome ?? '');
        votes = Array.isArray(res.votes) ? res.votes.filter((v): v is string => typeof v === 'string') : [];
        detail = typeof res.detail === 'string' ? res.detail : null;
      } catch {
        continue; // a malformed audit row never breaks the run
      }
      if (!proposal_id || !outcome) continue;
      // No position taken → no precedent (owner_class is the floor, skipped is noise).
      if (outcome === 'skipped' || outcome === 'owner_class') continue;
      const p = proposal_stmt.get({ '@id': proposal_id }) as VerdictSourceRow['proposal'] | null;
      if (p == null) continue; // proposal gone — nothing to describe
      const rendered = render_verdict_case({
        audit_id: row.id,
        ts: row.ts,
        proposal_id,
        outcome,
        votes,
        detail,
        proposal: p,
      });
      if (rendered.situation.length < 8) continue;
      apply({
        source_kind: 'court_verdict',
        source_id: row.id,
        proposal_id,
        kind: p.kind,
        specialist_id: p.specialist_id,
        user_id: p.user_id,
        decided_at: row.ts,
        source_updated_at: row.ts,
        ...rendered,
      });
    }
  } catch (err) {
    result.source_errors.push(`court_verdicts: ${(err as Error).message}`);
  }

  // 3. Closed/verified process misses — root cause → fix → (verified) proof.
  try {
    const rows = deps.db
      .prepare(
        `SELECT id, ts_created, ts_updated, subject_specialist_id, task_summary,
                gap, severity, status, evidence_ref, notes_md
           FROM process_misses
          WHERE status IN ('closed', 'verified')
          ORDER BY ts_updated DESC LIMIT ${SOURCE_CAP}`,
      )
      .all() as MissSourceRow[];
    for (const m of rows) {
      const rendered = render_miss_case(m);
      if (rendered.situation.length < 8) continue;
      apply({
        source_kind: 'process_miss',
        source_id: m.id,
        proposal_id: null,
        kind: 'process_miss',
        specialist_id: m.subject_specialist_id,
        user_id: null, // the miss ledger is system-side — owner-global
        decided_at: m.ts_updated,
        source_updated_at: m.ts_updated,
        ...rendered,
      });
    }
  } catch (err) {
    result.source_errors.push(`process_misses: ${(err as Error).message}`);
  }

  // 4. Embedding back-fill — optional fidelity, never load-bearing.
  if (deps.embedder?.enabled) {
    try {
      const pending = deps.store.needing_embedding(embed_cap());
      for (let i = 0; i < pending.length; i += EMBED_BATCH) {
        const batch = pending.slice(i, i + EMBED_BATCH);
        const vecs = await deps.embedder.embed(batch.map((b) => b.situation));
        for (let j = 0; j < batch.length; j++) {
          const row = batch[j];
          const vec = vecs[j];
          if (!row || !vec) continue;
          deps.store.set_embedding(row.id, vec, deps.embedder.model);
          result.embedded++;
        }
      }
    } catch (err) {
      result.source_errors.push(`embed: ${(err as Error).message}`);
    }
  }

  const counts = deps.store.counts();
  result.total_cases = counts.total;
  result.embed_pending = counts.total - counts.embedded;
  return result;
}

// ── matching ──────────────────────────────────────────────────────────────

export interface PrecedentMatch {
  id: string;
  source_kind: string;
  source_id: string;
  proposal_id: string | null;
  kind: string;
  specialist_id: string;
  case_md: string;
  outcome: string;
  confidence: PrecedentConfidence;
  confidence_note: string;
  decided_at: string;
  /** Cosine (vector path) or Jaccard (text path) — scales differ; use for
   *  ordering, never cross-path comparison. */
  similarity: number;
  match_kind: 'vector' | 'text';
}

function to_match(c: PrecedentCandidate, similarity: number, match_kind: 'vector' | 'text'): PrecedentMatch {
  return {
    id: c.id,
    source_kind: c.source_kind,
    source_id: c.source_id,
    proposal_id: c.proposal_id,
    kind: c.kind,
    specialist_id: c.specialist_id,
    case_md: c.case_md,
    outcome: c.outcome,
    confidence: c.confidence,
    confidence_note: c.confidence_note,
    decided_at: c.decided_at,
    similarity,
    match_kind,
  };
}

/**
 * Rank candidates against a situation: cosine over embedded rows when a query
 * vector is available, deterministic token overlap otherwise (and as the fill
 * when too few embedded rows clear the floor). Dedupes on the underlying
 * proposal so one decided proposal never fills two slots (a proposal case and
 * its court_verdict sibling tell the same story).
 */
export function rank_precedent_candidates(
  candidates: PrecedentCandidate[],
  situation: string,
  query_vec: Float32Array | null,
  k: number,
  exclude_proposal_id?: string,
): PrecedentMatch[] {
  const pool = exclude_proposal_id
    ? candidates.filter((c) => c.proposal_id !== exclude_proposal_id && c.source_id !== exclude_proposal_id)
    : candidates;

  const ranked: PrecedentMatch[] = [];
  if (query_vec && query_vec.length > 0) {
    const q_norm = norm(query_vec);
    for (const c of pool) {
      if (!c.embedding || c.dim !== query_vec.length) continue;
      const sim = cosine(query_vec, unpack_f32(c.embedding), q_norm);
      if (sim >= min_vector_sim()) ranked.push(to_match(c, sim, 'vector'));
    }
    ranked.sort((a, b) => b.similarity - a.similarity);
  }
  if (ranked.length < k) {
    const covered = new Set(ranked.map((m) => m.id));
    const q_tokens = tokens_of(situation);
    const text_ranked: PrecedentMatch[] = [];
    for (const c of pool) {
      if (covered.has(c.id)) continue;
      if (query_vec && c.embedding && c.dim === query_vec.length) continue; // vector already judged it
      const sim = jaccard(q_tokens, tokens_of(c.situation));
      if (sim >= MIN_TEXT_SIM) text_ranked.push(to_match(c, sim, 'text'));
    }
    text_ranked.sort((a, b) => b.similarity - a.similarity);
    ranked.push(...text_ranked);
  }

  const out: PrecedentMatch[] = [];
  const seen_proposals = new Set<string>();
  for (const m of ranked) {
    if (out.length >= k) break;
    if (m.proposal_id) {
      if (seen_proposals.has(m.proposal_id)) continue;
      seen_proposals.add(m.proposal_id);
    }
    out.push(m);
  }
  return out;
}

export interface RecallArgs {
  store: PrecedentStore;
  embedder?: Embedder;
  situation: string;
  scope: PrecedentScope;
  k: number;
  exclude_proposal_id?: string;
}

/** The full recall path: cordon-filtered candidates → vector (when live) or
 *  text ranking. Fail-open: an embed error degrades to text, never throws. */
export async function recall_precedent_cases(args: RecallArgs): Promise<PrecedentMatch[]> {
  if (!precedent_enabled()) return [];
  const candidates = args.store.match_candidates(args.scope);
  if (candidates.length === 0) return [];
  let qvec: Float32Array | null = null;
  if (args.embedder?.enabled) {
    try {
      const vecs = await args.embedder.embed([args.situation]);
      const v = vecs[0];
      if (v && v.length > 0) qvec = Float32Array.from(v);
    } catch {
      qvec = null; // embeddings down — deterministic overlap carries the read
    }
  }
  return rank_precedent_candidates(candidates, args.situation, qvec, args.k, args.exclude_proposal_id);
}

// ── the create() chokepoint (sync, deterministic) ─────────────────────────

/** Compact shape stamped into proposals.precedent_json. */
export interface PrecedentAttachment {
  outcome: string;
  confidence: string;
  note: string;
  decided_at: string;
  headline: string;
  source_kind: string;
  source_id: string;
}

/**
 * Sync text-overlap match for `ProposalsStore.create()` (create is sync — the
 * vector path lives in the async reads). Reads the table directly so the
 * store class isn't re-constructed per filing; a missing table (pre-indexer
 * db) returns [] via the caller's try/catch. Cordon: the new proposal's OWN
 * scope — system cases + that user's, never another user's.
 */
export function match_precedent_text(
  db: Database,
  situation: string,
  opts: { proposal_user_id: string | null; k: number; exclude_proposal_id?: string },
): PrecedentAttachment[] {
  if (!precedent_enabled()) return [];
  const clause =
    opts.proposal_user_id !== null ? '(user_id IS NULL OR user_id = @uid)' : 'user_id IS NULL';
  const stmt = db.prepare(
    `SELECT id, source_kind, source_id, proposal_id, kind, specialist_id,
            situation, case_md, outcome, confidence, confidence_note,
            user_id, decided_at, NULL AS embedding, NULL AS dim
       FROM precedent_cases WHERE ${clause}
      ORDER BY decided_at DESC LIMIT 4000`,
  );
  const candidates = (
    opts.proposal_user_id !== null ? stmt.all({ '@uid': opts.proposal_user_id }) : stmt.all()
  ) as PrecedentCandidate[];
  const matches = rank_precedent_candidates(candidates, situation, null, opts.k, opts.exclude_proposal_id);
  return matches.map((m) => ({
    outcome: m.outcome,
    confidence: m.confidence,
    note: m.confidence_note,
    decided_at: m.decided_at,
    headline: (m.case_md.split('\n')[0] ?? '').slice(0, 200),
    source_kind: m.source_kind,
    source_id: m.source_id,
  }));
}

// ── the court's lens-pack injection ───────────────────────────────────────

/** Render matches as an indented evidence block for a court case (appended by
 *  render_case). Leads with the tally, then one line per case — outcome,
 *  weight, date, headline. Explicitly evidence, never a rule. */
export function render_precedent_block(matches: PrecedentMatch[]): string {
  if (matches.length === 0) return '';
  const tally = new Map<string, number>();
  for (const m of matches) tally.set(m.outcome, (tally.get(m.outcome) ?? 0) + 1);
  const tally_str = [...tally.entries()].map(([o, n]) => `${o} ${n}×`).join(', ');
  const lines = matches.map(
    (m) =>
      `    · ${m.outcome} [${m.confidence} — ${m.confidence_note}] ${m.decided_at.slice(0, 10)}: ` +
      `${gist(m.case_md.split('\n')[0], 150)}`,
  );
  return [
    `  precedent (household case law — evidence, not a rule; similar past cases): ${tally_str}`,
    ...lines,
  ].join('\n');
}

/** Minimal structural slice of a docket ProposalRow the gather needs. */
interface DocketCaseLite {
  id: string;
  user_id: string | null;
  kind: string;
  title: string | null;
  summary: string | null;
  rationale_md: string | null;
}

/**
 * Pre-bench gather for the Proposal Court: top-3 precedent matches per docket
 * case, rendered as evidence blocks keyed by proposal id. ONE batched embed
 * call covers the whole docket; per-case candidates respect that case's own
 * cordon. Fail-open: any error → an empty map → the court runs byte-identical
 * to today.
 */
export async function gather_docket_precedent(args: {
  store: PrecedentStore;
  embedder?: Embedder;
  docket: DocketCaseLite[];
}): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!precedent_enabled() || args.docket.length === 0) return out;

  const situations = args.docket.map((p) =>
    `${p.kind} ${gist(p.title ?? p.summary ?? p.rationale_md, 140)} ${gist(p.rationale_md, 300)}`.trim(),
  );
  let qvecs: Array<Float32Array | null> = situations.map(() => null);
  if (args.embedder?.enabled) {
    try {
      const vecs = await args.embedder.embed(situations);
      qvecs = situations.map((_, i) => {
        const v = vecs[i];
        return v && v.length > 0 ? Float32Array.from(v) : null;
      });
    } catch {
      qvecs = situations.map(() => null); // text overlap carries the gather
    }
  }

  for (let i = 0; i < args.docket.length; i++) {
    const p = args.docket[i];
    const situation = situations[i];
    if (!p || !situation) continue;
    try {
      const candidates = args.store.match_candidates({ kind: 'proposal', user_id: p.user_id });
      const matches = rank_precedent_candidates(candidates, situation, qvecs[i] ?? null, 3, p.id);
      if (matches.length > 0) out.set(p.id, render_precedent_block(matches));
    } catch {
      /* one case's precedent failing never touches the others */
    }
  }
  return out;
}
