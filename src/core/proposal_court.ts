/**
 * The Proposal Court — Kate, Beatrice, and Mariah as DIFFERENT skeptics,
 * clearing the internal proposal queue so it stops building up on the owner
 * (2026-07-02; the Council design, owner-approved envelope: "hygiene +
 * internal decisions").
 *
 * The queue's structural problem: every loop terminates in an owner tap, so
 * the owner's attention is the bottleneck and nothing resolves without it
 * (live audit: 25 pending). The Court convenes daily over AGED pending
 * proposals and does two things:
 *
 *   1. DECIDES the internal/system kinds (COURT_KINDS) on unanimous consensus
 *      of three lens verdicts — approve executes through the SAME effects the
 *      owner's tap would (kind resolvers / the Beatrice-build flag), deny
 *      declines with the reasons on record.
 *   2. LAPSES stale offers of ANY kind (a return-window offer past its date
 *      is dead weight) — status 'expired', NO XP effect (a lapsed offer is
 *      not a rejected one; the specialist isn't punished for the owner's
 *      silence).
 *
 * Split verdicts and everything outside the envelope go to ONE consolidated
 * owner digest instead of N cards.
 *
 * The three lenses are genuinely different PERSPECTIVES, not three samples:
 *   - mariah   — the EVIDENCE skeptic: is it supported, duplicated, earned?
 *   - trainer  — the MECHANISM skeptic: right layer, right gate, sound?
 *   - kate     — the HOUSEHOLD skeptic: does anyone actually want this? is
 *                it still timely?
 * Each lens verdict is a think-OFF deep-tier call carrying that specialist's
 * persona core + its lens brief (the 2026-07-02 benches: think-ON adds
 * nothing at 3-14× cost; DIVERSITY is what decorrelates). AUTHORSHIP
 * RECUSAL: the agent that filed a proposal advises but does not vote — the
 * dense 27B (the vision endpoint, a genuinely different model) takes its
 * seat, and also breaks 2-1 splits.
 *
 * HARD LIMITS (the permanent floor, enforced in code):
 *   - anything `requires_step_up`, send_external/spend_money-shaped, or a
 *     hiring packet is NEVER court-decidable — owner class, digest only.
 *   - user-action kinds (calendar_event, draft_message, action_proposal…)
 *     are NEVER court-APPROVED in place — lapse-only (unanimous, Kate
 *     concurring). The ONE earned exception is trust teeth (2026-07-02,
 *     src/core/trust_teeth.ts, DARK behind HEARTH_TRUST_TEETH): a TEETH_KINDS
 *     proposal whose signature GRADUATED to tier2c/tier3 + a unanimous bench
 *     is ARMED for auto-execution after an undo window — the proposal stays
 *     pending so the owner's queue Deny cancels it (and carries reject-XP).
 *     draft_message and everything owner_only stay outside teeth forever.
 *   - caps per convening; kill switch HEARTH_PROPOSAL_COURT; fail-open per
 *     proposal; every verdict + decision audited with all lens votes.
 */

import type { Database } from 'bun:sqlite';
import type { LLMRouter } from './llm';
import type { MemoryClient } from '@memory/client';
import type { SpecialistRegistry } from './specialist';
import type { SpecialistInbox } from '@memory/stores/conversations';
import { ProposalsStore, type ProposalRow, type AutonomyStatus } from './proposals';
import {
  trusted_source_addition_resolver,
  is_beatrice_build_proposal,
  directed_build_instruction,
} from '../app/routes/specialists';
import { ulid } from 'ulid';
import { local_iso_date, format_short_datetime } from './time';
import {
  trust_teeth_enabled,
  teeth_armed_for_kind,
  teeth_tier_for,
  arm_trust_autoexec,
  TEETH_KINDS,
} from './trust_teeth';
import { compute_proposal_title } from './proposal_render';
import type { ProposalKind } from './proposals';
import { apply_kate_voice } from './kate_line';
import { gather_docket_precedent, precedent_enabled } from './precedent';
import type { PrecedentStore } from '@memory/stores/precedent_cases';
import type { Embedder } from './embeddings';

export function proposal_court_enabled(): boolean {
  return process.env.HEARTH_PROPOSAL_COURT === '1';
}

/**
 * The owner-queue triage rung (2026-07-04, the 2026-06-11 triage-gate epic):
 * before the bench sits, ONE batched judge call classifies each docket card —
 * is this a genuine DECISION for the owner, or a work log / peer reply /
 * self-declared duplicate that never belonged in the queue? Non-decisions are
 * filed to the record (expired, no XP — the live 76-card queue was ~⅓
 * "Routine 22:00 reflection log. Quiet night, nothing needed Jasper's
 * attention"-class cards that no lapse rule caught because they were
 * "timely"). The MODEL judges; code applies; unsure → keep (fail-open).
 * ON by default with the court; kill switch HEARTH_COURT_TRIAGE=0.
 */
export function court_triage_enabled(): boolean {
  return process.env.HEARTH_COURT_TRIAGE !== '0';
}

/**
 * The measured-swap experiment (2026-07-30): ONE lens seat, named here by
 * seat id (e.g. `mariah`), votes with the `court_judge_deep` role — the
 * Qwen3.5-122B big judge on forza — instead of `specialist_deliberation`.
 * Model diversity is what decorrelates a bench (the court's own 2026-07-02
 * think-ON bench), and the 122B is the most different brain in the fleet.
 * Unset/empty = experiment off, byte-identical pre-experiment behavior.
 * Every proposal_court_verdict audit row stamps the active value so
 * scorecard agreement epochs split cleanly at the flip date.
 */
export function court_deep_seat(): string {
  return (process.env.HEARTH_COURT_DEEP_SEAT ?? '').trim();
}

/**
 * The theme-rollup rung (2026-07-04, same epic): related pending cards about
 * ONE underlying matter (the EV-sensor outage spanned ~6 cards across three
 * specialists) roll up into ONE consolidated ask; members are superseded into
 * it (still readable via superseded_by — nothing is lost, the owner decides
 * once). Conservative scope in code: only owner-global (user_id NULL),
 * execution_kind 'none', plain action_proposals — never step-up / dispatch /
 * teeth-armed / cordoned cards. ON by default with the court; kill switch
 * HEARTH_COURT_ROLLUP=0.
 */
export function court_rollup_enabled(): boolean {
  return process.env.HEARTH_COURT_ROLLUP !== '0';
}

function min_age_hours(): number {
  const n = Number(process.env.HEARTH_COURT_MIN_AGE_HOURS ?? 24);
  return Number.isFinite(n) && n >= 0 ? n : 24;
}

function max_decides(): number {
  const n = Number(process.env.HEARTH_COURT_MAX_DECIDES ?? 20);
  return Number.isFinite(n) && n > 0 ? n : 20;
}

/** Internal/system kinds the Court may fully decide (approve or deny). */
const COURT_KINDS = new Set(['recommendation', 'binding_proposal', 'persona_tuning', 'trusted_source_addition']);

/** The three seats. The author of a proposal is recused per-proposal. */
const SEATS = ['mariah', 'trainer', 'kate'] as const;

/** How long a SPLIT stays off the docket before the bench re-hears it. Long
 *  enough that the owner has had a real chance and the evidence has moved;
 *  short enough that a case cannot sit for 41 days as they did pre-fix. */
function split_cooldown_days(): number {
  const n = Number(process.env.HEARTH_COURT_SPLIT_COOLDOWN_DAYS ?? 10);
  return Number.isFinite(n) && n > 0 ? n : 10;
}
/** Re-hearings before a chronically-split case is lapsed instead of re-seated. */
function max_rehearings(): number {
  const n = Number(process.env.HEARTH_COURT_MAX_REHEARINGS ?? 2);
  return Number.isFinite(n) && n >= 0 ? n : 2;
}

/**
 * Is this row parked off the bench's normal rotation?
 *
 * ALL parked rows are — including splits still inside their cooldown. A split
 * whose cooldown HAS elapsed is added back explicitly by the re-hearing pass,
 * which is also what bumps the stamp so the next cooldown starts. Relaxing
 * this predicate for splits instead would re-seat every split at every
 * convening, which is the daily re-digest churn the park exists to prevent.
 */
function parked_off_docket(p: ProposalRow): boolean {
  return Boolean(p.court_parked_at) || Boolean(p.court_split_at);
}

// Every seat is briefed on all THREE verdicts it can cast. `lapse_consensus`
// (see the tally below) requires unanimity among the non-abstaining seats, so a
// seat that was never told `lapse` exists votes `approve` on a stale card and
// single-handedly vetoes every timeliness lapse. That was the live behavior
// until 2026-07-18: only Kate's brief mentioned lapse, and across 947 recorded
// verdicts NOT ONE all-lapse tally ever formed — 877 came back `skipped`, the
// owner's queue grew monotonically, and the lapse rung might as well not have
// existed. Each brief frames lapse through its OWN lens rather than sharing one
// generic sentence: the point is for each seat to reach the judgment from its
// own discipline, not to recite a rule.
const LENS_BRIEFS: Record<(typeof SEATS)[number], string> = {
  mariah:
    'Your lens is EVIDENCE. Vote approve only if the proposal is supported by real, current signals; ' +
    'vote reject if it duplicates existing work, cites stale/absent evidence, or its filer has not ' +
    'earned trust for this class; vote lapse when the evidence no longer describes a live situation — ' +
    'the signal it rested on has since resolved, been overtaken, or gone cold. ' +
    'Ignore how appealing the idea sounds — you audit the record.',
  trainer:
    'Your lens is MECHANISM. Vote approve only if this is technically sound, at the right layer, and ' +
    'flows through the right existing gate; vote reject if it is a patch where a mechanism belongs, ' +
    'touches the wrong contract, or would create a parallel system; vote lapse when the mechanism this ' +
    'depended on has already resolved or elapsed — the fix landed elsewhere, the window closed, the ' +
    'condition cleared. Ignore popularity — you audit design.',
  kate:
    'Your lens is the HOUSEHOLD. Vote approve only if the household plausibly wants this and it is ' +
    'still TIMELY; vote lapse when the moment has passed (a window closed, an event happened, an offer ' +
    'went stale); vote reject when nobody asked and nothing evidences the need. You audit fit and timing.',
};

export interface CourtVote {
  seat: string;
  vote: 'approve' | 'reject' | 'lapse' | 'abstain';
  reason: string;
}

export interface CourtCaseResult {
  id: string;
  kind: string;
  outcome:
    | 'approved'
    | 'rejected'
    | 'lapsed'
    | 'split'
    | 'owner_class'
    | 'skipped'
    /** Trust teeth (2026-07-02): a graduated-signature user-action proposal
     *  drew a unanimous approve — armed for auto-execution after the undo
     *  window (the proposal itself stays pending; deny in the queue cancels). */
    | 'auto_armed';
  votes: CourtVote[];
  detail?: string;
  /** Human-readable card title (compute_proposal_title at verdict time) —
   *  the digest renders THIS, not the raw proposal id (kate_line slice,
   *  2026-07-04). Optional: absent on the error/skipped path. */
  title?: string;
}

export interface CourtResult {
  enabled: boolean;
  examined: number;
  approved: string[];
  rejected: string[];
  lapsed: string[];
  split: string[];
  /** Trust-teeth arms this convening (see 'auto_armed'). */
  armed: string[];
  owner_class: number;
  /** Cards the triage rung filed to the record (expired as work-log /
   *  peer-reply / duplicate — never real owner decisions). */
  triaged_out: string[];
  /** Consolidated rollup cards created this convening (each superseding
   *  its member cards). */
  rollups: string[];
  /** Autonomy promotions this convening (graduation rung, 2026-07-20):
   *  "specialist/category → tier" strings, ≤3 per convening. */
  graduated: string[];
  digest_id?: string;
  cases: CourtCaseResult[];
}

export interface CourtDeps {
  db: Database;
  proposals: ProposalsStore;
  memory: MemoryClient;
  llm: LLMRouter;
  specialists: SpecialistRegistry;
  inbox?: SpecialistInbox;
  /** Vault root, for inlining a binding-proposal spec into the directed-build
   *  instruction (2026-08-11). Optional + fail-open: absent → the instruction
   *  carries the payload + rationale only. */
  vault_root?: string;
  /** Smoke seam: scripted lens caller replaces the LLM. */
  lens_fn?: (seat: string, brief: string, cases: ProposalRow[]) => Promise<CourtVote[]>;
  /** Smoke seam: scripted tie-breaker (the 27B seat). */
  tiebreak_fn?: (proposal: ProposalRow) => Promise<CourtVote>;
  /** Smoke seam: scripted triage judge (the pre-bench decision/noise classifier). */
  triage_fn?: (cases: ProposalRow[]) => Promise<TriageVerdict[]>;
  /** Smoke seam: scripted rollup judge (the theme grouper). */
  rollup_fn?: (cases: ProposalRow[]) => Promise<RollupGroup[]>;
  /** Trust-teeth notification seam (default: the gated push pipeline). */
  push_fn?: (user_id: string | null, text: string, related_id: string) => Promise<unknown>;
  /** Precedent memory (C3, 2026-07-05): when wired + HEARTH_PRECEDENT is on,
   *  each docket case's lens pack carries the decided history's nearest cases
   *  ("the bench has seen this shape: approved 2×, denied 1× because…") —
   *  evidence for the lenses, never a rule. Absent/dark ⇒ byte-identical. */
  precedent?: PrecedentStore;
  /** Vector fidelity for the precedent gather (falls back to deterministic
   *  token overlap when absent/down). */
  embedder?: Embedder;
  /** Directed-build handle (2026-07-20): when wired, a court-approved
   *  Beatrice build FIRES the directed build immediately — the same
   *  fire_deliberation_now path the owner decide route uses (PR #95) —
   *  instead of only flagging her inbox. Court approvals were the one
   *  approval class that never converted to work (two approved specs sat
   *  unbuilt through three standing passes, 2026-07-18..20). Absent ⇒
   *  flag-only (legacy). */
  fire_directed_build?: (proposal: ProposalRow) => void;
  /** Registry risk lookup (2026-07-20): keys the permanent floor on the
   *  dispatch tool's DECLARED risk instead of only the name regex — the
   *  regex missed live actuation tools (write_home_assistant-shaped,
   *  medication updates). Absent ⇒ regex-only floor (legacy). */
  tool_risk_of?: (tool_name: string) => string | null;
}

// ── eligibility ──────────────────────────────────────────────────────────

function payload_of(p: ProposalRow): Record<string, unknown> {
  try {
    const parsed = JSON.parse(p.payload_json) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Card title for the digest — the same title the queue renders, so the
 *  owner reads "what it was", never a raw proposal id. Fail-open to the
 *  kind name. */
function safe_title(p: ProposalRow): string {
  try {
    return compute_proposal_title(p.kind as ProposalKind, payload_of(p), p.rationale_md);
  } catch {
    return p.kind;
  }
}

/**
 * Floor test for a tool/effect-family NAME (2026-07-20): send/spend/merge
 * shapes by regex, PLUS the tool's DECLARED registry risk when a lookup is
 * wired — the regex alone missed live actuation tools (the
 * write_home_assistant / medication-update class). `unknown_is_floor`
 * controls the fail direction for a name the registry doesn't know:
 * dispatch names fail CLOSED (an unregistered actuation name waits for the
 * owner); graduation categories fail OPEN (they're effect families, not
 * registered tool names — treating every family as unknown would nullify
 * graduation outright).
 *
 * That fail-OPEN on categories is safe ONLY because the graduation rung no
 * longer relies on it alone: it also floors a family by the actual
 * `dispatch_tool` names its proposals carry (registry names, checked
 * unknown_is_floor:true). See the graduation block below — the category test
 * is a cheap first pass, the dispatch-tool test is the real gate.
 */
export function is_floor_name(
  name: string,
  risk_of?: (n: string) => string | null,
  opts?: { unknown_is_floor?: boolean },
): boolean {
  if (/send_|spend_|merge_approved_change/.test(name)) return true;
  if (risk_of) {
    const risk = risk_of(name);
    if (risk === 'send_external' || risk === 'spend_money') return true;
    if (risk === null && opts?.unknown_is_floor) return true;
  }
  return false;
}

/** The permanent floor: never court-decidable, not even lapse-by-court —
 *  a step-up / hiring / send/spend/high-risk-shaped proposal waits for the
 *  owner. `risk_of` (CourtDeps.tool_risk_of) upgrades the name test from
 *  regex-only to declared-registry-risk; absent ⇒ legacy behavior. */
export function is_owner_only(
  p: ProposalRow,
  risk_of?: (n: string) => string | null,
): boolean {
  return owner_only_reason(p, risk_of) !== null;
}

/**
 * WHY a case is owner-only, or null when it isn't.
 *
 * Same test as `is_owner_only`, reported rather than collapsed, because the
 * reasons differ in one way that matters: all but `unknown_tool` are pure
 * functions of the row's own payload, so re-examining the case can never
 * change the verdict and it is safe to park it off the docket permanently.
 * `unknown_tool` is the exception — the dispatch tool isn't in the registry
 * *yet*, and floor-by-default is a safety stance, not a permanent property.
 * Park the stable ones; keep re-seating that one.
 */
export type OwnerOnlyReason = 'step_up' | 'packet' | 'floor_tool' | 'unknown_tool';

export function owner_only_reason(
  p: ProposalRow,
  risk_of?: (n: string) => string | null,
): OwnerOnlyReason | null {
  const payload = payload_of(p);
  if (payload.requires_step_up === true) return 'step_up';
  // Hiring packets: approved is a meaningful intermediate state.
  if (p.kind === 'recommendation' && payload.packet && typeof payload.packet === 'object') {
    return 'packet';
  }
  const dispatch = payload.dispatch_tool;
  const name =
    typeof dispatch === 'string'
      ? dispatch
      : ((dispatch as { name?: string; tool?: string; action?: string } | undefined)?.name ??
        (dispatch as { tool?: string } | undefined)?.tool ??
        (dispatch as { action?: string } | undefined)?.action);
  if (typeof name !== 'string') return null;
  // The name/declared-risk floor: permanent by construction.
  if (is_floor_name(name, risk_of)) return 'floor_tool';
  // Floor ONLY because the registry doesn't know this tool yet.
  if (is_floor_name(name, risk_of, { unknown_is_floor: true })) return 'unknown_tool';
  return null;
}

// ── lens transport (think-OFF deep tier; fenced-JSON + repair) ──────────

function persona_core(registry: SpecialistRegistry, id: string): string {
  const s = registry.get(id);
  if (!s) return '';
  const p = s.persona ?? '';
  const cut = p.indexOf('\n## ');
  return (cut > 0 ? p.slice(0, cut) : p).slice(0, 1500);
}

function render_case(p: ProposalRow, now_ms: number, precedent_block?: string): string {
  const age_d = Math.floor((now_ms - Date.parse(p.ts_created)) / 86_400_000);
  const payload = payload_of(p);
  const gist =
    p.title || p.summary ||
    (typeof payload.description === 'string' ? payload.description : '') ||
    (typeof payload.topic === 'string' ? payload.topic : '');
  const lines = [
    `- id: ${p.id}`,
    `  kind: ${p.kind} | filed_by: ${p.specialist_id} | age_days: ${age_d}`,
    `  gist: ${String(gist).slice(0, 200)}`,
    `  rationale: ${(p.rationale_md ?? '').replace(/\s+/g, ' ').slice(0, 350)}`,
  ];
  // Precedent memory (C3): the decided history's nearest cases, as evidence
  // for the lenses. Absent (dark / no matches) ⇒ byte-identical rendering.
  if (precedent_block) lines.push(precedent_block);
  return lines.join('\n');
}

function repair_control_chars(s: string): string {
  let out = '';
  let in_string = false;
  let escaped = false;
  for (const ch of s) {
    if (in_string) {
      if (escaped) { out += ch; escaped = false; continue; }
      if (ch === '\\') { out += ch; escaped = true; continue; }
      if (ch === '"') { in_string = false; out += ch; continue; }
      if (ch === '\n') { out += '\\n'; continue; }
      if (ch === '\r') { out += '\\r'; continue; }
      if (ch === '\t') { out += '\\t'; continue; }
      out += ch;
      continue;
    }
    if (ch === '"') in_string = true;
    out += ch;
  }
  return out;
}

function extract_json_array(content: string): unknown[] | null {
  const stripped = content.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  const fenced = stripped.match(/```(?:json)?\s*([\s\S]*?)```/);
  for (const c of [fenced?.[1], stripped]) {
    if (!c) continue;
    const start = c.indexOf('[');
    if (start === -1) continue;
    try {
      const parsed = JSON.parse(repair_control_chars(c.slice(start, c.lastIndexOf(']') + 1))) as unknown;
      if (Array.isArray(parsed)) return parsed;
    } catch {
      /* try next candidate */
    }
  }
  return null;
}

const VOTE_VALUES = new Set(['approve', 'reject', 'lapse', 'abstain']);

async function llm_lens_votes(
  deps: CourtDeps,
  seat: (typeof SEATS)[number],
  cases: ProposalRow[],
  now_ms: number,
  precedent?: Map<string, string>,
): Promise<CourtVote[]> {
  if (deps.lens_fn) return deps.lens_fn(seat, LENS_BRIEFS[seat], cases);
  // The measured-swap seat votes with the 122B big judge; a missing role
  // (config regression) degrades to the shared deliberation tier — the
  // experiment can silently pause, the bench can never lose a seat over it.
  let resolved;
  if (seat === court_deep_seat()) {
    try {
      resolved = deps.llm.for_role('court_judge_deep');
    } catch {
      resolved = deps.llm.for_role('specialist_deliberation');
    }
  } else {
    resolved = deps.llm.for_role('specialist_deliberation');
  }
  const system =
    `${persona_core(deps.specialists, seat)}\n\n` +
    `You sit on the internal Proposal Court. ${LENS_BRIEFS[seat]}\n` +
    `Some cases carry a 'precedent' block — how similar past cases were decided. Treat it as ` +
    `EVIDENCE with the stated confidence weights, never as a rule; you judge THIS case on your lens.\n` +
    `Reply with ONE fenced json array only — one entry per case, shape ` +
    `[{"id":"<proposal id>","vote":"approve"|"reject"|"lapse"|"abstain","reason":"<one sentence>"}]. ` +
    `Vote strictly on YOUR lens; abstain when your lens has nothing to say. No prose outside the json.`;
  const user = `The docket (${cases.length} case(s)):\n\n${cases.map((c) => render_case(c, now_ms, precedent?.get(c.id))).join('\n')}`;
  const resp = await resolved.provider.complete({
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    temperature: 0.2,
    max_tokens: 2000,
    think: false,
  });
  const arr = extract_json_array(resp.content ?? '');
  if (!arr) throw new Error(`lens ${seat}: unparseable verdict payload`);
  const by_id = new Map<string, CourtVote>();
  for (const raw of arr) {
    const r = raw as Record<string, unknown>;
    const id = String(r.id ?? '');
    const vote = String(r.vote ?? '').toLowerCase();
    if (!id || !VOTE_VALUES.has(vote)) continue;
    by_id.set(id, { seat, vote: vote as CourtVote['vote'], reason: String(r.reason ?? '').slice(0, 300) });
  }
  return cases.map(
    (c) => by_id.get(c.id) ?? { seat, vote: 'abstain', reason: 'no verdict returned for this case' },
  );
}

async function llm_tiebreak(
  deps: CourtDeps,
  p: ProposalRow,
  now_ms: number,
  precedent_block?: string,
): Promise<CourtVote> {
  if (deps.tiebreak_fn) return deps.tiebreak_fn(p);
  const resolved = deps.llm.for_role('vision'); // the dense 27B — a different model on purpose
  const resp = await resolved.provider.complete({
    messages: [
      {
        role: 'system',
        content:
          'You are an independent reviewer breaking a tie on an internal proposal. Judge on the ' +
          'merits: evidence, mechanism, and household fit. A precedent block, when present, is ' +
          'evidence with stated confidence weights, never a rule. Reply with ONE fenced json object only: ' +
          '{"vote":"approve"|"reject"|"lapse","reason":"<one sentence>"}.',
      },
      { role: 'user', content: render_case(p, now_ms, precedent_block) },
    ],
    temperature: 0.2,
    max_tokens: 300,
    think: false,
  });
  const arr = extract_json_array(`[${(resp.content ?? '').replace(/```(json)?/g, '')}]`);
  const r = (arr?.[0] ?? {}) as Record<string, unknown>;
  const vote = String(r.vote ?? '').toLowerCase();
  return {
    seat: 'qwen-27b',
    vote: VOTE_VALUES.has(vote) && vote !== 'abstain' ? (vote as CourtVote['vote']) : 'abstain',
    reason: String(r.reason ?? 'tie-break unavailable').slice(0, 300),
  };
}

// ── the triage rung (pre-bench) ──────────────────────────────────────────

export interface TriageVerdict {
  id: string;
  class: 'decision' | 'work_log' | 'peer_reply' | 'duplicate';
  reason: string;
}

const TRIAGE_CLASSES = new Set(['decision', 'work_log', 'peer_reply', 'duplicate']);

/** Cards the triage judge may examine: never the owner-only floor (step-up /
 *  hiring / send/spend-shaped — those are the owner's, untouchable) and never
 *  briefings (that kind already self-expires via the FYI TTL). */
function triage_eligible(p: ProposalRow, risk_of?: (n: string) => string | null): boolean {
  return !is_owner_only(p, risk_of) && p.kind !== 'briefing';
}

const TRIAGE_SYSTEM =
  "You triage a chief-of-staff's OWNER QUEUE — the cards awaiting the owner's personal " +
  'decision. Specialists sometimes file things here that are not decisions at all, and ' +
  'every such card costs the owner attention. Classify each numbered card:\n' +
  '  - decision:   a genuine ask — the owner must approve/decline/choose something that ' +
  'has NOT happened yet. When in doubt, choose decision.\n' +
  '  - work_log:   it REPORTS work already done or a status ("reviewed X", "promoted Y", ' +
  '"routine reflection log", "nothing needed attention", "I pulled fresh readings"). ' +
  'Nothing is being asked.\n' +
  '  - peer_reply: it answers ANOTHER SPECIALIST\'s question — an internal reply filed ' +
  'as an owner card ("Mariah asked for X — here it is").\n' +
  '  - duplicate:  the card ITSELF SAYS it duplicates / re-files / logs-for-tracking ' +
  'another card or id. Only when the text says so — never infer similarity yourself.\n\n' +
  'Reply with ONE fenced json array only, one entry per card: ' +
  '[{"id":"<proposal id>","class":"decision"|"work_log"|"peer_reply"|"duplicate",' +
  '"reason":"<one sentence>"}]. No prose outside the json.';

/** ONE batched judge call classifying the docket. Fail-open: any error →
 *  null → every card proceeds to the bench (today's behavior). */
async function llm_triage(
  deps: CourtDeps,
  cases: ProposalRow[],
  now_ms: number,
): Promise<TriageVerdict[] | null> {
  if (cases.length === 0) return [];
  if (deps.triage_fn) {
    try {
      return await deps.triage_fn(cases);
    } catch {
      return null;
    }
  }
  try {
    const resolved = deps.llm.for_role('specialist_deliberation');
    const resp = await resolved.provider.complete({
      messages: [
        { role: 'system', content: TRIAGE_SYSTEM },
        { role: 'user', content: `The queue (${cases.length} card(s)):\n\n${cases.map((c) => render_case(c, now_ms)).join('\n')}` },
      ],
      temperature: 0.1,
      max_tokens: 2000,
      think: false,
    });
    const arr = extract_json_array(resp.content ?? '');
    if (!arr) return null;
    const out: TriageVerdict[] = [];
    for (const raw of arr) {
      const r = raw as Record<string, unknown>;
      const id = String(r.id ?? '');
      const cls = String(r.class ?? '').toLowerCase();
      if (!id || !TRIAGE_CLASSES.has(cls)) continue;
      out.push({ id, class: cls as TriageVerdict['class'], reason: String(r.reason ?? '').slice(0, 300) });
    }
    return out;
  } catch {
    return null;
  }
}

// ── the theme-rollup rung (post-bench) ───────────────────────────────────

export interface RollupGroup {
  theme: string;
  ask: string;
  /** 1-based indices into the numbered candidate list. */
  members: number[];
}

const ROLLUP_INPUT_CAP = 60;
const ROLLUP_MAX_GROUPS = 3;
const ROLLUP_MAX_MEMBERS = 12;

/** Cards the rollup may consolidate — deliberately conservative: owner-global
 *  (user_id NULL, so no cross-cordon grouping), acknowledge-class only
 *  (execution_kind 'none' — superseding a dispatch/web_action card would
 *  orphan its executor), plain action_proposals, never snoozed (an explicit
 *  defer means "show me later", not "absorb me"), never the owner-only floor. */
function rollup_eligible(p: ProposalRow, risk_of?: (n: string) => string | null): boolean {
  return (
    p.kind === 'action_proposal' &&
    p.execution_kind === 'none' &&
    p.user_id === null &&
    p.snoozed_until === null &&
    !is_owner_only(p, risk_of)
  );
}

const ROLLUP_SYSTEM =
  "You consolidate a chief-of-staff's owner queue. You are given numbered pending cards. " +
  'Group ONLY cards that are about the SAME underlying matter — the same incident, the ' +
  'same person + topic, the same ask — such that ONE consolidated card could honestly ' +
  'replace them and the owner would decide once instead of N times. Different matters ' +
  'that merely share a category are NOT a group. Most queues have zero or one real group.\n\n' +
  'Reply with ONE fenced json array only (possibly empty):\n' +
  '[{"theme":"<3-6 word name>","ask":"<one-sentence consolidated ask for the owner>",' +
  '"members":[<card numbers>]}]\n' +
  'Reference cards ONLY by their [number]. A group needs at least 2 members. ' +
  'Never put one card in two groups. No prose outside the json.';

/** ONE batched grouping call. Fail-open: any error → null → no rollups. */
async function llm_rollup(
  deps: CourtDeps,
  cases: ProposalRow[],
  now_ms: number,
): Promise<RollupGroup[] | null> {
  if (cases.length < 2) return [];
  if (deps.rollup_fn) {
    try {
      return await deps.rollup_fn(cases);
    } catch {
      return null;
    }
  }
  try {
    const resolved = deps.llm.for_role('specialist_deliberation');
    const numbered = cases
      .map((c, i) => render_case(c, now_ms).replace(/^- id: /, `- [${i + 1}] id: `))
      .join('\n');
    const resp = await resolved.provider.complete({
      messages: [
        { role: 'system', content: ROLLUP_SYSTEM },
        { role: 'user', content: `Pending cards (${cases.length}):\n\n${numbered}` },
      ],
      temperature: 0.1,
      max_tokens: 1200,
      think: false,
    });
    const arr = extract_json_array(resp.content ?? '');
    if (!arr) return null;
    const out: RollupGroup[] = [];
    for (const raw of arr) {
      const r = raw as Record<string, unknown>;
      const theme = String(r.theme ?? '').trim();
      const ask = String(r.ask ?? '').trim();
      const members = Array.isArray(r.members)
        ? r.members.map((m) => Number(m)).filter((m) => Number.isInteger(m) && m >= 1)
        : [];
      if (!theme || !ask || members.length < 2) continue;
      out.push({ theme: theme.slice(0, 80), ask: ask.slice(0, 400), members });
    }
    return out;
  } catch {
    return null;
  }
}

/** Validate + apply the judge's groups: in-range, disjoint, capped; create ONE
 *  consolidated card per group and supersede the members into it. */
function apply_rollups(
  deps: CourtDeps,
  groups: RollupGroup[],
  candidates: ProposalRow[],
  now: Date,
): string[] {
  const created: string[] = [];
  const used = new Set<number>();
  for (const g of groups.slice(0, ROLLUP_MAX_GROUPS)) {
    const idxs = [...new Set(g.members)]
      .filter((m) => m >= 1 && m <= candidates.length && !used.has(m))
      .slice(0, ROLLUP_MAX_MEMBERS);
    if (idxs.length < 2) continue;
    const members = idxs.map((m) => candidates[m - 1]!);
    try {
      const member_lines = members
        .map((m) => `- ${m.id} (${m.specialist_id}): ${(m.title || m.summary || '').slice(0, 100)}`)
        .join('\n');
      const anchor = `${g.theme.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40)}:${local_iso_date(now)}`;
      const rollup_id = deps.proposals.create({
        specialist_id: 'kate',
        kind: 'action_proposal',
        user_id: null,
        execution_kind: 'none',
        payload: {
          rollup: true,
          theme: g.theme,
          member_ids: members.map((m) => m.id),
          verb: 'review',
        },
        rationale:
          `**${g.theme}** — ${g.ask}\n\n` +
          `The court consolidated ${members.length} related cards into this one ask ` +
          `(each is still readable under it):\n${member_lines}`,
        signature: { specialist_id: 'kate', kind: 'action_proposal', category: 'court_rollup', anchor },
      });
      const flipped = deps.proposals.supersede_into(members.map((m) => m.id), rollup_id);
      idxs.forEach((m) => used.add(m));
      created.push(rollup_id);
      deps.memory.log_action({
        intent_id: ulid(),
        agent: 'kate',
        tool_name: 'proposal_court_rollup',
        tool_input: { theme: g.theme, member_ids: members.map((m) => m.id) },
        execution_result: { rollup_id, members: members.length, superseded: flipped },
      });
    } catch (err) {
      console.error('[proposal-court] rollup group failed (fail-open):', err);
    }
  }
  return created;
}

// ── consensus + effects ──────────────────────────────────────────────────

function tally(votes: CourtVote[]): { approve: number; reject: number; lapse: number; voting: number } {
  const t = { approve: 0, reject: 0, lapse: 0, voting: 0 };
  for (const v of votes) {
    if (v.vote === 'abstain') continue;
    t.voting++;
    t[v.vote]++;
  }
  return t;
}

async function apply_approval(deps: CourtDeps, p: ProposalRow): Promise<string> {
  // Same effects the owner's tap produces, via the SAME exported machinery.
  if (p.kind === 'trusted_source_addition') {
    const result = await trusted_source_addition_resolver({
      proposal: p,
      action_id: 'approve',
      payload: payload_of(p),
      memory: deps.memory,
    });
    return `resolver: ${JSON.stringify(result).slice(0, 120)}`;
  }
  if (is_beatrice_build_proposal(p)) {
    // The owner-approval fan-out: flag Beatrice to implement via her normal
    // (Kate-reviewed, owner-merged) pipeline. The court starts the WORK; the
    // permanent merge gate still owns the LANDING.
    deps.inbox?.push({
      from_specialist_id: 'kate',
      to_specialist_id: 'trainer',
      kind: 'flag',
      related_proposal_id: p.id,
      body_md:
        `The Proposal Court approved your ${p.kind} \`${p.id}\` on unanimous lens consensus.\n\n` +
        directed_build_instruction(p, { vault_root: deps.vault_root }),
    });
    // Conversion teeth (2026-07-20): the flag alone never converted — two
    // court-approved specs sat unbuilt through three standing passes. When
    // the handle is wired, FIRE the directed build now (same path as the
    // owner decide route, PR #95); the flag stays as the paper trail and
    // the fallback when the handle is absent.
    if (deps.fire_directed_build) {
      try {
        deps.fire_directed_build(p);
        return 'beatrice build FIRED (directed) + flagged (pipeline gates unchanged)';
      } catch (err) {
        console.error('[proposal-court] directed-build fire failed (flag remains):', err);
      }
    }
    return 'beatrice build flagged (pipeline gates unchanged)';
  }
  return 'approved (no executor for kind — record only)';
}

/**
 * Convene the Court once. Deterministic driver; the lens calls are the only
 * model steps. Never throws — per-case fail-open.
 */
export async function convene_proposal_court(
  deps: CourtDeps,
  opts?: { now?: Date },
): Promise<CourtResult> {
  const result: CourtResult = {
    enabled: proposal_court_enabled(),
    examined: 0,
    approved: [],
    rejected: [],
    lapsed: [],
    split: [],
    armed: [],
    owner_class: 0,
    triaged_out: [],
    rollups: [],
    graduated: [],
    cases: [],
  };
  if (!result.enabled) return result;
  const now = opts?.now ?? new Date();
  const now_ms = now.getTime();
  const cutoff = now_ms - min_age_hours() * 3_600_000;

  const pending = deps.proposals
    .list({ status: 'pending', limit: 200 })
    // Min-age is the OWNER-FIRST grace: his cards (user-action kinds) sit a
    // day so he gets first crack. INTERNAL kinds (COURT_KINDS — Beatrice's
    // specs, persona tunings, source additions) get NO grace: parking a
    // staff enablement in his queue for 24h before the bench even looks was
    // the "jerky start-stop" flow the owner flagged 2026-07-05 (the
    // manage_household_services gap round-tripped through him). The bench
    // examines those the next convening; splits still reach him via the
    // digest, and code merges keep their owner floor regardless.
    .filter((p) => COURT_KINDS.has(p.kind) || Date.parse(p.ts_created) <= cutoff)
    // Park memory: a case the bench already handed to the owner went into
    // that convening's digest once; re-examining it daily wastes docket slots
    // and re-digests a case the bench has no authority to move.
    // `court_split_at` is still honoured for rows stamped by builds before
    // the park column existed.
    //
    // EXCEPT a split (2026-08-02). The other park reasons are pure functions
    // of the row's payload, so the bench genuinely cannot reach a different
    // answer — but a split means it HAD authority and merely disagreed, on
    // evidence that was current that day. Treating both the same made every
    // disagreement permanent, and the owner's tap became the only exit: all
    // 28 pending proposals were splits, each judged exactly once, the oldest
    // 41 days old. A split park is therefore a COOLDOWN, re-seated below.
    .filter((p) => !parked_off_docket(p));
  result.examined = pending.length;

  // ── Re-seat cooled-off splits, and retire the undecidable ────────────────
  // Runs before the docket is cut so re-heard cases compete for slots on the
  // same oldest-first ordering as everything else.
  const rehearing: ProposalRow[] = [];
  try {
    for (const p of deps.proposals.splits_due_for_rehearing({
      cooldown_days: split_cooldown_days(),
      limit: max_decides(),
    })) {
      if ((p.court_rehear_count ?? 0) >= max_rehearings()) {
        // The bench has now failed to agree on this case max_rehearings+1
        // times across weeks. That is not a live disagreement, it is an
        // undecidable one, and leaving it pending forever is the drain.
        // Lapse is the honest retirement: a timing verdict, explicitly NOT a
        // rejection, so nobody is punished for the owner's silence.
        deps.proposals.expire_one(
          p.id,
          `proposal court: lapsed after ${p.court_rehear_count} re-hearings without consensus or owner action`,
        );
        result.lapsed.push(p.id);
        continue;
      }
      if (deps.proposals.rehear_split(p.id, now)) rehearing.push(p);
    }
  } catch (err) {
    console.error('[proposal-court] split re-hearing failed (fail-open):', err);
  }
  for (const p of rehearing) if (!pending.some((q) => q.id === p.id)) pending.push(p);

  if (pending.length === 0) return result;

  // Docket selection. `list()` returns newest-first, so a plain `slice(0, cap)`
  // seated the 20 NEWEST eligible cards at every convening — and with more
  // eligible rows than the cap, the same recent cards were re-judged three
  // times a day while older ones were never seen at all (2026-07-18: 18 pending
  // rows had zero recorded verdicts, some 3+ weeks old). Staleness is exactly
  // what the `lapse` verdict exists to retire, so the cards that most needed
  // the bench were the ones structurally denied it.
  //
  // Ordering preserves BOTH existing intents rather than replacing one with the
  // other: COURT_KINDS keep their no-grace priority (a staff enablement should
  // not wait behind a backlog — the "jerky start-stop" flow above), and the
  // remaining slots go OLDEST-first so aged user-action cards actually reach a
  // verdict instead of starving behind each day's fresh inflow.
  const docket_order = (a: ProposalRow, b: ProposalRow): number => {
    const a_internal = COURT_KINDS.has(a.kind) ? 0 : 1;
    const b_internal = COURT_KINDS.has(b.kind) ? 0 : 1;
    if (a_internal !== b_internal) return a_internal - b_internal;
    return Date.parse(a.ts_created) - Date.parse(b.ts_created);
  };
  let docket = [...pending].sort(docket_order).slice(0, max_decides());

  // ── the triage rung — is this even a decision? ─────────────────────────
  // ONE batched judge over the eligible docket cards: work logs, peer
  // replies, and self-declared duplicates are filed to the record (expired,
  // no XP) instead of waiting on the bench or the owner. Fail-open: judge
  // down/unparseable → everything proceeds to the bench unchanged.
  if (court_triage_enabled()) {
    try {
      const eligible = docket.filter((p) => triage_eligible(p, deps.tool_risk_of));
      const verdicts = await llm_triage(deps, eligible, now_ms);
      if (verdicts) {
        const by_id = new Map(verdicts.map((v) => [v.id, v]));
        for (const p of eligible) {
          const v = by_id.get(p.id);
          if (!v || v.class === 'decision') continue;
          const ok = deps.proposals.expire_one(
            p.id,
            `court triage: ${v.class.replace('_', ' ')} — ${v.reason || 'not an owner decision'}`,
          );
          if (!ok) continue;
          result.triaged_out.push(p.id);
          deps.memory.log_action({
            intent_id: ulid(),
            agent: 'kate',
            tool_name: 'proposal_court_triage',
            tool_input: { proposal_id: p.id, kind: p.kind },
            execution_result: { class: v.class, reason: v.reason },
          });
        }
        if (result.triaged_out.length > 0) {
          const dropped = new Set(result.triaged_out);
          docket = docket.filter((p) => !dropped.has(p.id));
        }
      }
    } catch (err) {
      console.error('[proposal-court] triage rung failed (fail-open):', err);
    }
  }

  // ── precedent memory (C3, 2026-07-05) — the decided history's nearest
  // cases per docket case, rendered into the lens evidence packs ("the bench
  // has seen this shape before"). Evidence for the lenses, never a rule.
  // Fail-open + dark: any error / HEARTH_PRECEDENT off / no store wired →
  // empty map → rendering byte-identical to today.
  let precedent_blocks = new Map<string, string>();
  if (precedent_enabled() && deps.precedent && docket.length > 0) {
    try {
      precedent_blocks = await gather_docket_precedent({
        store: deps.precedent,
        embedder: deps.embedder,
        docket,
      });
    } catch (err) {
      console.error('[proposal-court] precedent gather failed (fail-open):', err);
    }
  }

  // One batched call per seat over the whole docket (recusal applied per case).
  const seat_votes = new Map<string, CourtVote[]>();
  for (const seat of SEATS) {
    try {
      seat_votes.set(seat, await llm_lens_votes(deps, seat, docket, now_ms, precedent_blocks));
    } catch (err) {
      console.error(`[proposal-court] lens ${seat} failed (fail-open, abstains):`, err);
      seat_votes.set(
        seat,
        docket.map(() => ({ seat, vote: 'abstain' as const, reason: 'lens unavailable' })),
      );
    }
  }

  for (let i = 0; i < docket.length; i++) {
    const p = docket[i]!;
    try {
      const owner_only = is_owner_only(p, deps.tool_risk_of);
      const decideable = COURT_KINDS.has(p.kind) && !owner_only;

      // Trust teeth (2026-07-02): a USER-ACTION kind whose signature has
      // EARNED tier2c/tier3 becomes consensus-armable — unanimity of the
      // (recusal-adjusted) voting seats schedules an auto-execution after
      // the undo window instead of leaving the card for the owner. The
      // permanent floor (owner_only) is checked FIRST and TEETH_KINDS is a
      // positive allowlist, so step-up / hiring / send / spend / drafts can
      // never arm. DARK behind HEARTH_TRUST_TEETH — or, since 2026-08-02,
      // behind HEARTH_TRUST_TEETH_KINDS for a kind that earned arming on its
      // own scorecard record. `teeth_armed_for_kind` folds the allowlist
      // check in, so this stays one gate rather than two that can drift.
      const teeth_tier =
        teeth_armed_for_kind(p.kind) && !owner_only && !decideable
          ? teeth_tier_for(deps.proposals, p)
          : null;

      // LAPSE tallies count ALL seats — recusal exists to stop an author
      // approving their own idea; expiring your own stale offer is no
      // conflict (and Kate files most offers, so recusing her here would
      // kill the hygiene rule outright).
      // A lens that returned a short/mismatched array abstains for the gap —
      // never an undefined vote (fail-open at the finest grain).
      const seat_vote_at = (seat: string): CourtVote =>
        seat_votes.get(seat)?.[i] ?? { seat, vote: 'abstain', reason: 'no verdict returned' };
      const votes_full: CourtVote[] = SEATS.map((seat) => seat_vote_at(seat));

      // APPROVE/REJECT consensus applies authorship recusal — the filer's
      // seat passes to the 27B (a genuinely different model). A teeth-armable
      // case gets the same fill: an auto-execution deserves the full bench.
      let votes: CourtVote[] = SEATS
        .filter((seat) => seat !== p.specialist_id)
        .map((seat) => seat_vote_at(seat));
      if ((decideable || teeth_tier !== null) && votes.length < SEATS.length) {
        votes = [...votes, await llm_tiebreak(deps, p, now_ms, precedent_blocks.get(p.id))];
      }
      const t = tally(votes);
      const t_full = tally(votes_full);

      let outcome: CourtCaseResult['outcome'];
      let detail: string | undefined;
      // CONSENSUS = unanimity of the voting (non-abstaining) seats, at least
      // two of them. ANY dissent → the owner sees the disagreement (that's
      // the point of different-perspective skeptics). The 27B seat exists to
      // FILL a recusal, never to outvote a dissenter.
      const unanimous = (kind: 'approve' | 'reject' | 'lapse') => t.voting >= 2 && t[kind] === t.voting;

      const lapse_consensus =
        t_full.voting >= 2 &&
        t_full.lapse === t_full.voting &&
        // For user-action kinds, Kate's timeliness concurrence is required.
        (decideable || votes_full.some((v) => v.seat === 'kate' && v.vote === 'lapse'));

      if (owner_only) {
        outcome = 'owner_class';
        result.owner_class++;
        // Hand it over ONCE. The reason is a pure function of the row's
        // payload for every case but `unknown_tool`, where the floor is a
        // safety default that a later tool registration can lift — that one
        // keeps coming back to the bench.
        const reason = owner_only_reason(p, deps.tool_risk_of);
        if (reason !== null && reason !== 'unknown_tool') {
          deps.proposals.park_for_owner(p.id, reason);
          detail = `owner-class (${reason}) — parked; it stays in your queue`;
        }
      } else if (lapse_consensus) {
        deps.proposals.expire_one(p.id, `proposal court: lapsed — ${votes_full.find((v) => v.vote === 'lapse')?.reason ?? 'window passed'}`);
        outcome = 'lapsed';
        result.lapsed.push(p.id);
      } else if (decideable && unanimous('approve')) {
        deps.proposals.decide(p.id, 'approve', undefined, `proposal court consensus: ${votes.map((v) => `${v.seat}=${v.vote}`).join(', ')}`, 'approve');
        detail = await apply_approval(deps, p);
        outcome = 'approved';
        result.approved.push(p.id);
      } else if (decideable && unanimous('reject')) {
        deps.proposals.decide(p.id, 'deny', undefined, `proposal court consensus: ${votes.map((v) => `${v.seat}: ${v.reason}`).join(' | ')}`, 'reject');
        outcome = 'rejected';
        result.rejected.push(p.id);
      } else if (decideable) {
        outcome = 'split';
        result.split.push(p.id);
        // Split memory: this disagreement goes to the owner in TODAY's
        // digest; the stamp keeps it out of every future docket.
        deps.proposals.park_for_owner(p.id, 'split');
      } else if (teeth_tier !== null && unanimous('approve')) {
        // Graduated signature + unanimous bench → ARM, don't execute: the
        // proposal stays pending through the undo window (deny in the queue
        // cancels AND carries the reject-XP signal); the sweep executes
        // through the owner-tap decide()+effects path when the window passes.
        const armed = await arm_trust_autoexec(
          { db: deps.db, proposals: deps.proposals, memory: deps.memory, push_fn: deps.push_fn },
          p,
          teeth_tier,
          votes,
          now,
        );
        detail =
          `auto-executes ~${format_short_datetime(armed.row.execute_after)} ` +
          `(${teeth_tier} trust; deny in the queue to cancel)`;
        outcome = 'auto_armed';
        result.armed.push(p.id);
      } else {
        outcome = 'skipped'; // user-action kind, not lapsed — stays for the owner
      }

      result.cases.push({
        id: p.id,
        kind: p.kind,
        outcome,
        votes: outcome === 'lapsed' ? votes_full : votes,
        detail,
        title: safe_title(p),
      });
      deps.memory.log_action({
        intent_id: ulid(),
        agent: 'kate',
        tool_name: 'proposal_court_verdict',
        tool_input: {
          proposal_id: p.id,
          kind: p.kind,
          // Epoch marker for the measured-swap experiment: which seat (if
          // any) voted with the 122B on this verdict. Absent = baseline.
          ...(court_deep_seat() ? { deep_seat: court_deep_seat() } : {}),
        },
        execution_result: { outcome, votes: votes.map((v) => `${v.seat}=${v.vote}`), detail },
      });
    } catch (err) {
      console.error(`[proposal-court] case ${p.id} failed (fail-open):`, err);
      result.cases.push({ id: p.id, kind: p.kind, outcome: 'skipped', votes: [], detail: String(err) });
    }
  }

  // ── the theme-rollup rung — one matter, one ask ─────────────────────────
  // After triage + the bench, related surviving cards about ONE underlying
  // matter consolidate into ONE card; members supersede into it (readable
  // under it, hidden from the queue). Fresh read so just-expired/decided
  // rows never enter; conservative eligibility in rollup_eligible(). A
  // rollup card the court itself filed is excluded (never roll up rollups).
  if (court_rollup_enabled()) {
    try {
      const candidates = deps.proposals
        .list({ status: 'pending', limit: 200 })
        .filter((p) => Date.parse(p.ts_created) <= cutoff)
        .filter((p) => rollup_eligible(p, deps.tool_risk_of))
        .filter((p) => payload_of(p).rollup !== true)
        .slice(0, ROLLUP_INPUT_CAP);
      const groups = await llm_rollup(deps, candidates, now_ms);
      if (groups && groups.length > 0) {
        result.rollups = apply_rollups(deps, groups, candidates, now);
      }
    } catch (err) {
      console.error('[proposal-court] rollup rung failed (fail-open):', err);
    }
  }

  // ── the graduation rung (2026-07-20, owner-decided) ────────────────────
  // The court promotes proposal families whose EARNED record clears every
  // evidence gate — approvals, edit/denial hygiene, Trust-Ladder XP,
  // authenticity, eval health (all computed in check_graduation_candidates,
  // the actuator that previously had ZERO callers, so tier2a was forever).
  // Floor-class families (send/spend/merge-shaped by regex or declared
  // registry risk) NEVER self-graduate — they stay the owner's. Promotions
  // go straight to the earned tier (the owner delegated this decision to
  // the court, 2026-07-20); ≤3 per convening, every one audited and
  // narrated in the digest. Walk-back is always available
  // (autonomy_status 'revoked') — the owner says the word, Kate files it.
  if (process.env.HEARTH_COURT_GRADUATION !== '0') {
    try {
      const candidates = deps.proposals.check_graduation_candidates();
      let promoted = 0;
      for (const cand of candidates) {
        if (promoted >= 3) break;
        const category = cand.signature.category ?? '';
        if (is_floor_name(category, deps.tool_risk_of, { unknown_is_floor: false })) continue;
        // The category label is an EFFECT FAMILY, not a tool name — resolving
        // it against the registry almost always yields null, which is why the
        // check above must fail OPEN (flooring every unknown would nullify
        // graduation outright). That leaves the real question unasked: what
        // would this family actually EXECUTE once it reaches an auto-executing
        // tier? Ask the proposals themselves (2026-07-21). Their dispatch
        // tools ARE registry names, so here the fail direction flips to CLOSED
        // — matching `is_owner_only`'s per-proposal floor — and an
        // unregistered actuation name (`update_pet_medication`,
        // `write_home_assistant`, `set_irrigation_schedule`) keeps its family
        // owner-only instead of riding a benign-looking category into teeth.
        const family_tools = deps.proposals.dispatch_tools_for_signature(cand.signature_hash);
        if (
          family_tools.some((t) =>
            is_floor_name(t, deps.tool_risk_of, { unknown_is_floor: true }),
          )
        ) {
          continue;
        }
        const target =
          (
            {
              tier2b_proposed: 'tier2b',
              tier2c_proposed: 'tier2c',
              tier3_proposed: 'tier3',
            } as Record<string, AutonomyStatus>
          )[cand.proposed_status] ?? cand.proposed_status;
        deps.proposals.graduate(cand.signature_hash, target);
        promoted++;
        result.graduated.push(
          `${cand.signature.specialist_id}'s ${category || 'general'} family → ${target}`,
        );
        deps.memory.log_action({
          intent_id: ulid(),
          agent: 'kate',
          tool_name: 'court_graduation',
          tool_input: {
            hash: cand.signature_hash,
            category,
            specialist_id: cand.signature.specialist_id,
            from: cand.current_status,
          },
          execution_result: { to: target, reason: cand.reason },
        });
      }
    } catch (err) {
      console.error('[proposal-court] graduation rung failed (fail-open):', err);
    }
  }

  // ── the one owner digest ────────────────────────────────────────────────
  // kate_line slice (2026-07-04): the digest the owner READS. The body is a
  // DETERMINISTIC humanizer — each case renders as its queue card title +
  // a plain-English outcome (dissenter named on a decline; ids stay off the
  // card — that's show-details machinery). The TOPIC (the card headline)
  // goes through apply_kate_voice: model owns the voice, code owns the fact
  // guard, any miss ships the template. No LLM ever touches the case lines.
  const needs_owner = result.split.length + result.owner_class;
  if (
    result.cases.length > 0 ||
    result.triaged_out.length > 0 ||
    result.rollups.length > 0 ||
    result.graduated.length > 0
  ) {
    try {
      const lines = result.cases
        .filter((c) => c.outcome !== 'skipped')
        .map((c) => `- ${describe_case(c)}`);
      // Owner-queue triage gate (2026-07-04): the digest also accounts for
      // what the triage + rollup rungs did this convening.
      if (result.triaged_out.length > 0) {
        lines.push(`- filed to the record (not owner decisions): ${result.triaged_out.length} card(s)`);
      }
      if (result.rollups.length > 0) {
        lines.push(`- consolidated into ${result.rollups.length} rollup ask(s): ${result.rollups.join(', ')}`);
      }
      // Graduation narrative (2026-07-20, owner-requested shape): informal
      // SCR — what happened, why it's right, what the owner gets, how to
      // undo. Plain English, no ids.
      if (result.graduated.length > 0) {
        lines.push('', '**Autonomy earned this convening:**');
        for (const g of result.graduated) lines.push(`- ${g}`);
        lines.push(
          'What happened: these families cleared every evidence gate — your approval ' +
            'record, clean edit/denial history, earned XP, authenticity, and eval health. ' +
            'What changes: the court now clears cards from these families on your behalf. ' +
            'What you get: fewer cards, same guardrails — the send/spend/merge floor never ' +
            'graduates. To walk one back, just tell Kate to revoke that family and she files ' +
            'the reversal.',
        );
      }
      const armed_part = result.armed.length ? `, ${result.armed.length} auto-executing` : '';
      const triage_part = result.triaged_out.length ? `, ${result.triaged_out.length} filed to the record` : '';
      const rollup_part = result.rollups.length ? `, ${result.rollups.length} consolidated` : '';
      const grad_part = result.graduated.length ? `, ${result.graduated.length} promoted` : '';
      const template_topic = `Proposal Court — ${result.approved.length} approved, ${result.rejected.length} declined, ${result.lapsed.length} lapsed${armed_part}${triage_part}${rollup_part}${grad_part}, ${needs_owner} for you`;
      const topic = await apply_kate_voice(deps.llm, template_topic, { kind: 'briefing' });
      const digest_id = deps.proposals.create({
        specialist_id: 'kate',
        kind: 'briefing',
        execution_kind: 'none',
        payload: {
          topic,
          depth: 'quick',
          body_md: lines.join('\n'),
          consulted: ['mariah', 'trainer', 'kate'],
        },
        rationale: 'Daily Proposal Court digest — the staff cleared the internal queue; split votes and floor-class items await you.',
        signature: { specialist_id: 'kate', kind: 'briefing', category: 'proposal_court', anchor: local_iso_date(now) },
        user_id: null,
      });
      result.digest_id = digest_id;
      // Digest supersedes digest: yesterday's still-pending court digest is
      // stale the moment today's exists — one court card in the queue, ever.
      try {
        const stale_digests = deps.proposals
          .list({ status: 'pending', limit: 100 })
          .filter(
            (p) =>
              p.id !== digest_id &&
              p.kind === 'briefing' &&
              p.specialist_id === 'kate' &&
              String(payload_of(p).topic ?? '').startsWith('Proposal Court'),
          )
          .map((p) => p.id);
        if (stale_digests.length > 0) deps.proposals.supersede_into(stale_digests, digest_id);
      } catch {
        /* best-effort — the FYI TTL still ages them out */
      }
    } catch (err) {
      console.error('[proposal-court] digest failed (fail-open):', err);
    }
  }

  return result;
}

/** One digest line, deterministic — "what it was, what happened, who
 *  disagreed", in prose. Exported for the smoke. */
export function describe_case(c: CourtCaseResult): string {
  const title = (c.title ?? c.kind).trim();
  const kind_label = c.kind.replace(/_/g, ' ');
  const dissenters = c.votes.filter((v) => v.vote === 'reject').map((v) => seat_name(v.seat));
  const approvers = c.votes.filter((v) => v.vote === 'approve').map((v) => seat_name(v.seat));
  switch (c.outcome) {
    case 'approved':
      return `**${title}** — approved${approvers.length >= 3 ? ' unanimously' : ''} (${kind_label})`;
    case 'rejected':
      return `**${title}** — declined${dissenters.length ? ` on ${dissenters.join(' and ')}'s objection` : ''} (${kind_label})`;
    case 'lapsed':
      return `**${title}** — expired as stale; re-files if it matters again (${kind_label})`;
    case 'split':
      return `**${title}** — the bench split${dissenters.length ? ` (${dissenters.join(', ')} against)` : ''}; your call (${kind_label})`;
    case 'owner_class':
      return `**${title}** — yours alone to decide (${kind_label})`;
    case 'auto_armed':
      return `**${title}** — earned auto-execution${c.detail ? `; ${c.detail}` : ''} (${kind_label})`;
    default:
      return `**${title}** — ${c.outcome} (${kind_label})`;
  }
}

function seat_name(seat: string): string {
  if (seat === 'trainer') return 'Beatrice';
  return seat.charAt(0).toUpperCase() + seat.slice(1);
}
