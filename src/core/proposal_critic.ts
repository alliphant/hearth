/**
 * Proposal-filing quality critic (2026-06-22).
 *
 * The proposal queue's noise is not bad LANDINGs — the tsc gate, Kate's
 * review, owner merge, and the chat-time critics keep garbage out of
 * production. It's bad FILINGs: ~30% of proposals are denied/expired, the
 * same root cause re-files under a drifting fingerprint (the Cassandra
 * stale-presence cluster: 8 cards; the absorb_interrupt cluster: 3), and a
 * fraction propose a fix that doesn't address their own diagnosis (grant a
 * capability to "fix" an entity-ID mismatch). `ProposalsStore.create()`
 * already has three EQUALITY-based dedup layers (byte/rationale idempotency,
 * dedup_key supersession, pm_*-ref supersession); they can't catch "same
 * root cause, different wording" — that's fundamentally semantic.
 *
 * This module is the semantic companion, mirroring fact_critic / data_denial:
 *   - Layer 1 (#2, deterministic): token-overlap candidate grouping. Narrows
 *     which OPEN proposals a new one might duplicate. It NEVER decides — it
 *     only picks who the judge compares against (so we never auto-collapse on
 *     similarity, the contract create()'s equality dedup also honors).
 *   - Layer 2 (#3, LLM judge): a cheap planner-role call that rules DUPLICATE
 *     (same root cause/fix as an open proposal) or FIX_MISMATCH (the proposed
 *     fix/dispatch does not address the stated problem). FAIL-OPEN to 'keep'
 *     on every error/parse/empty path — a critic outage must never suppress a
 *     legitimate proposal.
 *
 * It runs OUT OF BAND in the orchestrator sweep (not in the synchronous
 * create() hot path — adding an async LLM call there would force create()
 * async, a huge blast radius). The sweep's ACTION is conservative:
 *   - 'duplicate' → supersede the NEWER proposal (the canonical earlier one
 *     SURVIVES — safe; this is the dominant, low-risk win).
 *   - 'fix_mismatch' → AUDIT a warning only; never auto-deny on an LLM's
 *     say-so (auto-killing a real fix is worse than surfacing a flag).
 *
 * DARK by default — HEARTH_PROPOSAL_CRITIC=1 to enable (it auto-supersedes,
 * so it ships opt-in; flip it on after watching the audit trail).
 */

import { z } from 'zod';
import { judgment_role, type LLMRouter } from './llm';
import type { ProposalRow } from './proposals';

export interface ProposalCriticVerdict {
  /** True when the LLM judge actually ran (false = disabled / no candidates / no llm). */
  checked: boolean;
  /**
   * 'keep'            — file it (default + every fail-open path).
   * 'duplicate'       — substantially the same root cause/fix as `duplicate_of` (an OPEN
   *                     proposal); supersede this one.
   * 'fix_mismatch'    — the fix does not address the stated problem; surface, don't auto-kill.
   * 'refile_of_denied' — C6 fold-in (2026-07-05): re-files something recently DECIDED
   *                     against (denied/expired — `duplicate_of` points at the decided row).
   *                     The sweep retires it ONLY on a strong label (see
   *                     `should_retire_refile`); a weak label is surfaced, never auto-killed.
   */
  action: 'keep' | 'duplicate' | 'fix_mismatch' | 'refile_of_denied';
  /** Open-proposal id this duplicates ('duplicate'), or the decided row it
   *  re-files ('refile_of_denied'). */
  duplicate_of?: string;
  reason: string;
}

const KEEP = (reason: string, checked = false): ProposalCriticVerdict => ({
  checked,
  action: 'keep',
  reason,
});

/** DARK by default — opt in with HEARTH_PROPOSAL_CRITIC=1. */
export function proposal_critic_enabled(): boolean {
  return process.env.HEARTH_PROPOSAL_CRITIC === '1';
}

// ── Layer 1: deterministic candidate generation (#2) ───────────────────────
// Token-overlap (Jaccard) between the new proposal and each open one, scoped
// to the same specialist OR the same kind. Recall-biased: a low floor + a
// small top-K so the judge gets the plausible duplicates without seeing the
// whole queue. NOT a decision — the judge filters.

const STOP = new Set([
  'the', 'and', 'for', 'that', 'this', 'with', 'from', 'was', 'are', 'has',
  'have', 'not', 'but', 'all', 'any', 'can', 'her', 'his', 'its', 'our',
  'out', 'who', 'why', 'how', 'when', 'what', 'which', 'into', 'over', 'than',
  'then', 'them', 'they', 'you', 'your', 'a', 'an', 'is', 'it', 'to', 'of',
  'in', 'on', 'at', 'so', 'no', 'or', 'be', 'as', 'by', 'we',
  // proposal-queue boilerplate that would manufacture false overlap
  'proposal', 'jasper', 'kate', 'beatrice', 'needs', 'fix', 'add', 'update',
  'flag', 'note', 'see', 'action', 'details', 'review',
]);

const TOKEN_FLOOR = Number(process.env.HEARTH_PROPOSAL_CRITIC_OVERLAP ?? '0.18');
const MAX_CANDIDATES = Number(process.env.HEARTH_PROPOSAL_CRITIC_MAX_CANDIDATES ?? '6');

function content_tokens(p: {
  title?: string | null;
  summary?: string | null;
  rationale_md?: string | null;
}): Set<string> {
  const text = `${p.title ?? ''} ${p.summary ?? ''} ${p.rationale_md ?? ''}`.toLowerCase();
  const out = new Set<string>();
  for (const m of text.matchAll(/[a-z][a-z0-9_]{2,}/g)) {
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

/**
 * Open proposals the new one most plausibly duplicates. Scoped to the same
 * specialist OR the same kind (a root-cause cluster is almost always one
 * specialist re-filing, or one systemic issue across kinds), ranked by token
 * overlap, floored, capped. The judge decides; this only narrows.
 */
export function duplicate_candidates(
  target: ProposalRow,
  open: ProposalRow[],
): ProposalRow[] {
  const t_tokens = content_tokens(target);
  if (t_tokens.size === 0) return [];
  const scored: Array<{ row: ProposalRow; score: number }> = [];
  for (const row of open) {
    if (row.id === target.id) continue;
    if (row.specialist_id !== target.specialist_id && row.kind !== target.kind) continue;
    const score = jaccard(t_tokens, content_tokens(row));
    if (score >= TOKEN_FLOOR) scored.push({ row, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, MAX_CANDIDATES).map((s) => s.row);
}

/**
 * C6 fold-in (2026-07-05): DECIDED-history candidates — the same grouping
 * over recently denied/expired rows, so a re-file of something decided
 * against last month no longer sails past a critic that only saw the OPEN
 * queue. Same scoping + floor + cap as `duplicate_candidates`; the judge
 * still decides.
 */
export function decided_candidates(
  target: ProposalRow,
  decided: ProposalRow[],
): ProposalRow[] {
  const t_tokens = content_tokens(target);
  if (t_tokens.size === 0) return [];
  const scored: Array<{ row: ProposalRow; score: number }> = [];
  for (const row of decided) {
    if (row.id === target.id) continue;
    if (row.status !== 'denied' && row.status !== 'expired') continue;
    if (row.specialist_id !== target.specialist_id && row.kind !== target.kind) continue;
    const score = jaccard(t_tokens, content_tokens(row));
    if (score >= TOKEN_FLOOR) scored.push({ row, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, MAX_CANDIDATES).map((s) => s.row);
}

/** Days a denial stays a structural re-file blocker. */
function refile_window_days(): number {
  const n = Number(process.env.HEARTH_PROPOSAL_CRITIC_REFILE_DAYS ?? '30');
  return Number.isFinite(n) && n > 0 ? n : 30;
}

/**
 * Label honesty for the refile action (the precedent-memory contract): the
 * sweep RETIRES a re-file only on a STRONG label — an owner/court DENIAL with
 * a reason on record, recent enough to still speak. An expired row (timing,
 * not merits) or a reason-less denial only gets flagged, never auto-killed.
 * Deterministic; the judge found the match, this gates the action.
 */
export function should_retire_refile(decided: ProposalRow, now: Date): boolean {
  if (decided.status !== 'denied') return false;
  const feedback = (decided.user_feedback ?? '').trim();
  if (feedback.length === 0) return false;
  if (!decided.ts_decided) return false;
  const age_ms = now.getTime() - Date.parse(decided.ts_decided);
  return Number.isFinite(age_ms) && age_ms >= 0 && age_ms <= refile_window_days() * 86_400_000;
}

// ── C6 deterministic temporal sanity ───────────────────────────────────────
// "Proposing prep for a meeting that already happened." TYPED payload
// contracts only — calendar_event's ts_end/ts_start and a briefing's
// for_event — never a generic scan for past-looking dates (payloads
// legitimately reference past dates: receipts, history, evidence).

const TEMPORAL_GRACE_MS = 24 * 3_600_000;

export interface TemporalFinding {
  stale: boolean;
  reason?: string;
}

export function temporal_sanity(
  row: Pick<ProposalRow, 'kind' | 'payload_json'>,
  now: Date,
): TemporalFinding {
  let payload: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(row.payload_json ?? '{}') as unknown;
    if (parsed && typeof parsed === 'object') payload = parsed as Record<string, unknown>;
  } catch {
    return { stale: false };
  }
  const past = (value: unknown): string | null => {
    if (typeof value !== 'string' || value.length < 8) return null;
    const t = Date.parse(value);
    if (!Number.isFinite(t)) return null;
    return t < now.getTime() - TEMPORAL_GRACE_MS ? value : null;
  };
  if (row.kind === 'calendar_event') {
    const ended = past(payload.ts_end) ?? past(payload.ts_start);
    if (ended) {
      return {
        stale: true,
        reason: `proposes a calendar event that already ended (${ended.slice(0, 16)})`,
      };
    }
  }
  if (row.kind === 'briefing') {
    const for_event = past(payload.for_event);
    if (for_event) {
      return {
        stale: true,
        reason: `prep/briefing for an event already past (${for_event.slice(0, 16)})`,
      };
    }
  }
  return { stale: false };
}

// ── Layer 2: the LLM judge ─────────────────────────────────────────────────

const JUDGE_SYSTEM = `You are a quality gate on a household assistant's PROPOSAL queue — the list of suggested actions/fixes its specialists file for the owner to approve. You are given ONE new proposal, a numbered list of currently-open proposals it might duplicate, and a numbered list of RECENTLY DECIDED proposals (denied or expired) it might be re-filing.

Decide ONE verdict:
- "duplicate": the new proposal is substantially the SAME root cause AND the same intended fix as one of the OPEN proposals (re-filed wording differs, but approving both would be redundant). Set duplicate_index to that open proposal's number.
- "refile_of_denied": the new proposal re-files substantially the SAME thing as one of the RECENTLY DECIDED proposals — same underlying ask, same fix — that was already denied or expired. Set decided_index to that decided proposal's number.
- "fix_mismatch": the new proposal's stated FIX or dispatched action does NOT actually address the problem it diagnoses (e.g. "grant a read capability" to fix an entity-ID config mismatch; restart a service to fix a code bug). Independent of duplication.
- "keep": none of the above — it is a distinct, coherent proposal.

Be conservative: only say "duplicate"/"refile_of_denied" when the SAME underlying problem has the SAME fix (two distinct fixes for one symptom are NOT duplicates — they're alternatives; a genuinely NEW attempt with new evidence after a denial is NOT a re-file). Only say "fix_mismatch" when the mismatch is clear, not merely incomplete.

Reply with ONLY this JSON: {"verdict":"keep|duplicate|refile_of_denied|fix_mismatch","duplicate_index":<number or null>,"decided_index":<number or null>,"reason":"<one short clause>"}`;

const JudgeSchema = z.object({
  verdict: z.enum(['keep', 'duplicate', 'refile_of_denied', 'fix_mismatch']),
  duplicate_index: z.number().int().nullable().optional(),
  decided_index: z.number().int().nullable().optional(),
  reason: z.string().optional(),
});

function strip_fence(s: string): string {
  const t = s.trim();
  if (t.startsWith('```')) return t.replace(/^```[a-z]*\n?/i, '').replace(/```\s*$/, '').trim();
  return t;
}

function digest(p: ProposalRow): string {
  const rationale = (p.rationale_md ?? '').replace(/\s+/g, ' ').trim().slice(0, 400);
  const title = (p.title ?? p.summary ?? '').replace(/\s+/g, ' ').trim().slice(0, 160);
  return `[${p.kind} by ${p.specialist_id}] ${title}${rationale ? ` — ${rationale}` : ''}`;
}

/**
 * Judge a freshly-filed proposal against the open queue. Fail-open to 'keep'
 * on disabled / no-llm / no-candidate / role-unresolved / error / unparseable.
 */
export async function assess_proposal(args: {
  proposal: ProposalRow;
  open: ProposalRow[];
  /** C6 fold-in: recently DECIDED (denied/expired) rows — lets the judge
   *  catch a re-file of something already decided against. Optional; absent
   *  behaves exactly like the pre-C6 critic. */
  decided?: ProposalRow[];
  llm?: LLMRouter;
}): Promise<ProposalCriticVerdict> {
  const { proposal, open, decided = [], llm } = args;
  if (!proposal_critic_enabled()) return KEEP('disabled', false);
  if (!llm) return KEEP('no llm', false);

  const candidates = duplicate_candidates(proposal, open);
  const decided_cands = decided_candidates(proposal, decided);
  // No duplicate candidates AND nothing to check for mismatch cheaply — still
  // run the judge for fix_mismatch (it needs only the proposal), but skip the
  // call entirely when there's neither a candidate NOR a payload worth judging.
  const has_payload = Boolean(proposal.payload_json && proposal.payload_json !== '{}');
  if (candidates.length === 0 && decided_cands.length === 0 && !has_payload) {
    return KEEP('no candidates, empty payload', false);
  }

  let role;
  try {
    role = judgment_role(llm);
  } catch {
    return KEEP('judge role unresolved', false);
  }

  const candidate_list =
    candidates.length > 0
      ? candidates.map((c, i) => `${i + 1}. ${digest(c)}`).join('\n')
      : '(none)';
  const decided_list =
    decided_cands.length > 0
      ? decided_cands
          .map(
            (c, i) =>
              `${i + 1}. [${c.status.toUpperCase()} ${(c.ts_decided ?? '').slice(0, 10)}` +
              `${c.user_feedback ? ` — reason: ${c.user_feedback.replace(/\s+/g, ' ').slice(0, 160)}` : ' — no reason recorded'}] ${digest(c)}`,
          )
          .join('\n')
      : '(none)';
  const payload_snippet = (proposal.payload_json ?? '{}').slice(0, 800);

  let resp;
  try {
    resp = await role.provider.complete({
      messages: [
        { role: 'system', content: JUDGE_SYSTEM },
        {
          role: 'user',
          content:
            `NEW PROPOSAL:\n${digest(proposal)}\n\nNEW PROPOSAL PAYLOAD (the fix/dispatch):\n${payload_snippet}\n\n` +
            `OPEN PROPOSALS it might duplicate:\n${candidate_list}\n\n` +
            `RECENTLY DECIDED (denied/expired) proposals it might re-file:\n${decided_list}\n\nReply with ONLY the JSON.`,
        },
      ],
      ...role.defaults,
      // pins AFTER the spread so a yaml regression can't flip them (llm.ts depth-tier note)
      temperature: 0.1,
      max_tokens: 300,
      think: false,
    });
  } catch {
    return KEEP('judge call failed', true);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(strip_fence(resp.content));
  } catch {
    return KEEP('judge output unparseable', true);
  }
  const r = JudgeSchema.safeParse(parsed);
  if (!r.success) return KEEP('judge schema mismatch', true);

  const reason = (r.data.reason ?? '').trim().slice(0, 240);
  if (r.data.verdict === 'duplicate') {
    // Map the index back to OUR candidate set — never trust a free-form id.
    const idx = r.data.duplicate_index;
    if (typeof idx !== 'number' || idx < 1 || idx > candidates.length) {
      return KEEP('duplicate verdict without a valid candidate index', true);
    }
    const dup = candidates[idx - 1];
    if (!dup) return KEEP('duplicate index out of range', true);
    return {
      checked: true,
      action: 'duplicate',
      duplicate_of: dup.id,
      reason: reason || `duplicate of ${dup.id}`,
    };
  }
  if (r.data.verdict === 'refile_of_denied') {
    // Same index-mapping discipline against the DECIDED candidate set.
    const idx = r.data.decided_index;
    if (typeof idx !== 'number' || idx < 1 || idx > decided_cands.length) {
      return KEEP('refile verdict without a valid decided index', true);
    }
    const prior = decided_cands[idx - 1];
    if (!prior) return KEEP('decided index out of range', true);
    return {
      checked: true,
      action: 'refile_of_denied',
      duplicate_of: prior.id,
      reason: reason || `re-files ${prior.status} proposal ${prior.id}`,
    };
  }
  if (r.data.verdict === 'fix_mismatch') {
    return { checked: true, action: 'fix_mismatch', reason: reason || 'fix does not address the stated problem' };
  }
  return KEEP(reason || 'distinct proposal', true);
}
