/**
 * yield_diagnosis — WHY does this capability run clean and write nothing?
 * (2026-08-01)
 *
 * The third sibling of `health_diagnosis` (a dependency is down) and
 * `toolcall_diagnosis` (a tool keeps failing validation). Same spine, same
 * non-negotiables: an evidence pack assembled deterministically, a root cause
 * the LOCAL deep model grounds in ONLY that pack (the fact critic drops
 * unsupported specifics and a deterministic scrub removes the lines carrying
 * them), typed fixes each adversarially scored, and — the invariant — every
 * fix's `apply_via` is one of the EXISTING gates. This module APPLIES NOTHING.
 *
 * WHAT MAKES THIS ONE DIFFERENT: there is no error to read. The other two
 * diagnosers start from an exception string; here every run returned success.
 * So the evidence pack is built around the one thing that IS diagnostic — the
 * **considered-vs-produced series**, which separates the two causes that look
 * identical from outside:
 *
 *   considered > 0, produced == 0  → input arrives and is DROPPED. The failure
 *                                    is downstream: extraction, a filter, a
 *                                    validation contract, a changed page shape.
 *   considered  == 0 every run     → input never arrives. The failure is
 *                                    upstream: discovery, the query, the source.
 *
 * `extract_meeting_votes` was the second kind wearing the first kind's clothes:
 * it fetched documents every run (so input LOOKED present) but they were the
 * meeting of October 2023, because "find the latest X" was built on a web
 * search, and a search returns what it indexed ranked by relevance with no
 * relation to recency. That is why `stale_source` is a first-class fix type
 * rather than a flavour of `code_change` — it is the single most likely cause
 * of a barren capability and the least likely to be guessed.
 *
 * `retire_capability` is a first-class verdict for the same reason. A job that
 * cannot produce is WORSE than one that does not exist, because it reads as
 * coverage on every dashboard it appears on. Saying so is a real answer.
 */
import type { Database } from 'bun:sqlite';
import type { LLMRouter } from './llm';
import type { ToolRegistry } from './tool_registry';
import { assess_factual_grounding } from './fact_critic';
import { build_grounding_context, build_grounding_evidence } from './provenance';
import { EXISTING_GATES, type ApplyVia, type FixScore } from './health_diagnosis';
import type { CompleteRoleFn } from './toolcall_diagnosis';
import {
  assess_yield,
  read_yield,
  run_is_active,
  yield_window_runs,
  type YieldAssessment,
  type YieldDeclaration,
  type YieldRun,
} from './capability_yield';

export { EXISTING_GATES } from './health_diagnosis';
export type { ApplyVia, FixScore } from './health_diagnosis';

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

export type YieldFixType =
  /** Reading real-but-WRONG data — a stale document, a relevance-ranked search
   *  standing in for a recency question, last year's page. */
  | 'stale_source'
  /** Pointed at the wrong artifact entirely — an index/listing page instead of
   *  the document, a search form instead of results. */
  | 'wrong_target'
  /** Extraction works; a downstream filter/threshold/validation rejects all of it. */
  | 'broken_filter'
  /** The upstream shape changed and the parser silently matches nothing. */
  | 'contract_drift'
  /** The capability has no purpose any more — remove it rather than leave a
   *  job that reads as coverage while producing nothing. */
  | 'retire_capability'
  | 'code_change'
  | 'escalate';

export interface YieldCandidateFix {
  type: YieldFixType;
  title: string;
  detail: string;
  target: string;
  apply_via: ApplyVia;
}

export interface YieldScoredFix extends YieldCandidateFix {
  score: FixScore;
}

/** One run, flattened for the model: did work arrive, did anything come out. */
export interface YieldRunSample {
  ts: string;
  active: boolean;
  considered: number | null;
  produced: number | null;
  /** Raw result keys → counts, so the model can see the shape it must reason about. */
  fields: Record<string, number>;
}

export interface YieldEvidencePack {
  tool: string;
  specialist_id: string | null;
  assessment: YieldAssessment;
  /** Newest-first run series — THE diagnostic artifact for this class. */
  runs: YieldRunSample[];
  /** The scheduled job(s) that invoke this tool, if resolvable from config. */
  schedule: Array<{ specialist_id: string; name: string; at: string; input: unknown }>;
  /** The tool's own self-description + declared yield contract, when registered. */
  tool_info: {
    description: string;
    risk: string;
    declared_yield: YieldDeclaration | null;
  } | null;
  /** Rare for this class — present only if some runs DID error. */
  error_samples: Array<{ ts: string; message: string }>;
}

export interface YieldDiagnosis {
  subject: string;
  root_cause: string;
  confidence: number;
  inconclusive: boolean;
  fixes: YieldScoredFix[];
  recommended_index: number;
  ungrounded_dropped: string[];
  evidence: YieldEvidencePack;
  model: string;
}

/* ------------------------------------------------------------------ */
/* Tunables                                                            */
/* ------------------------------------------------------------------ */

export function yield_diagnosis_enabled(): boolean {
  return process.env.HEARTH_YIELD_DIAGNOSIS !== '0';
}

function int_env(name: string, dflt: number, lo: number, hi: number): number {
  const raw = Number.parseInt(process.env[name] ?? '', 10);
  const v = Number.isFinite(raw) && raw > 0 ? raw : dflt;
  return Math.max(lo, Math.min(v, hi));
}
function window_days(): number {
  return int_env('HEARTH_YIELD_DIAGNOSIS_WINDOW_DAYS', 45, 2, 365);
}
export function yield_recommend_floor(): number {
  const raw = Number(process.env.HEARTH_YIELD_DIAGNOSIS_FLOOR);
  return Number.isFinite(raw) && raw > 0 && raw < 1 ? raw : 0.45;
}

const ERROR_MSG_CAP = 320;

export interface YieldDiagnosisDeps {
  db: Database;
  tools?: ToolRegistry;
  /** Specialist configs, for resolving which job schedules this tool. */
  specialists?: { list(): Array<{ id: string; proactive?: { background_jobs?: Array<{ name: string; at: string; tool: string; input?: unknown }> } }> };
  llm?: LLMRouter;
  /** Smoke seams — default to the real local-model / critic paths. */
  complete_role_fn?: CompleteRoleFn;
  verify_fn?: typeof assess_factual_grounding;
}

function default_complete(llm: LLMRouter | undefined): CompleteRoleFn {
  return async (role, opts) => {
    if (!llm) return null;
    let resolved;
    try {
      resolved = llm.for_role(role);
    } catch {
      return null;
    }
    try {
      const resp = await resolved.provider.complete({
        messages: [
          { role: 'system', content: opts.system },
          { role: 'user', content: opts.user },
        ],
        temperature: opts.temperature ?? 0.2,
        max_tokens: opts.max_tokens ?? 1400,
        think: false,
        ...resolved.defaults,
      });
      return resp.content;
    } catch {
      return null;
    }
  };
}

function strip_fence(s: string): string {
  const m = s.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
  return (m ? m[1]! : s).trim();
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

/* ------------------------------------------------------------------ */
/* 1. Evidence pack                                                    */
/* ------------------------------------------------------------------ */

interface RunRow {
  ts: string;
  agent: string;
  result_json: string | null;
  error: string | null;
}

/** Every countable top-level field, so the model sees the real result shape
 *  rather than only the two numbers our reader distilled out of it. */
function flatten_counts(result: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!result || typeof result !== 'object' || Array.isArray(result)) return out;
  for (const [k, v] of Object.entries(result as Record<string, unknown>)) {
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
    else if (Array.isArray(v)) out[k] = v.length;
  }
  return out;
}

function inner_result(result_json: string | null): unknown {
  if (!result_json) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(result_json);
  } catch {
    return null;
  }
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const obj = parsed as Record<string, unknown>;
    if ('result' in obj && obj.result && typeof obj.result === 'object') return obj.result;
  }
  return parsed;
}

export function gather_yield_evidence(deps: YieldDiagnosisDeps, tool: string): YieldEvidencePack {
  const since = new Date(Date.now() - window_days() * 86_400_000).toISOString();
  const rows = deps.db
    .prepare(
      `SELECT ts, agent, execution_result AS result_json, error
         FROM audit_log
        WHERE tool_name = 'background_job'
          AND json_extract(tool_input, '$.tool') = @tool
          AND ts >= @since
        ORDER BY ts DESC
        LIMIT @lim`,
    )
    .all({ '@tool': tool, '@since': since, '@lim': yield_window_runs() * 2 }) as RunRow[];

  const declared = deps.tools?.get(tool)?.yield;
  const runs: YieldRunSample[] = [];
  const yruns: YieldRun[] = [];
  const error_samples: Array<{ ts: string; message: string }> = [];

  for (const row of rows.slice(0, yield_window_runs())) {
    const result = inner_result(row.result_json);
    const reading = read_yield(result, declared);
    const active = run_is_active(result);
    yruns.push({ ts: row.ts, active, reading });
    runs.push({
      ts: row.ts,
      active,
      considered: reading.considered,
      produced: reading.produced,
      fields: flatten_counts(result),
    });
  }
  for (const row of rows) {
    if (row.error && error_samples.length < 5) {
      error_samples.push({ ts: row.ts, message: row.error.slice(0, ERROR_MSG_CAP) });
    }
  }

  const schedule: YieldEvidencePack['schedule'] = [];
  for (const s of deps.specialists?.list() ?? []) {
    for (const job of s.proactive?.background_jobs ?? []) {
      if (job.tool === tool) {
        schedule.push({ specialist_id: s.id, name: job.name, at: job.at, input: job.input ?? null });
      }
    }
  }

  const registered = deps.tools?.get(tool);
  return {
    tool,
    specialist_id: rows[0]?.agent ?? schedule[0]?.specialist_id ?? null,
    assessment: assess_yield(tool, yruns),
    runs,
    schedule,
    tool_info: registered
      ? {
          description: registered.description.slice(0, 600),
          risk: registered.risk,
          declared_yield: registered.yield ?? null,
        }
      : null,
    error_samples,
  };
}

export function render_yield_evidence_text(pack: YieldEvidencePack): string {
  const L: string[] = [];
  L.push(`CAPABILITY: ${pack.tool}`);
  if (pack.specialist_id) L.push(`OWNED BY: ${pack.specialist_id}`);
  L.push(`VERDICT: ${pack.assessment.verdict} — ${pack.assessment.summary}`);
  L.push(
    `TOTALS over ${pack.assessment.runs_examined} run(s): considered=${pack.assessment.total_considered}, ` +
      `produced=${pack.assessment.total_produced}, yield basis=${pack.assessment.basis}`,
  );
  L.push('');

  if (pack.tool_info) {
    L.push('TOOL:');
    L.push(`  description: ${pack.tool_info.description}`);
    L.push(`  risk: ${pack.tool_info.risk}`);
    L.push(
      `  declared yield contract: ${
        pack.tool_info.declared_yield
          ? JSON.stringify(pack.tool_info.declared_yield)
          : 'NONE (yield read by field-name convention)'
      }`,
    );
    L.push('');
  }

  if (pack.schedule.length > 0) {
    L.push('SCHEDULE:');
    for (const s of pack.schedule) {
      L.push(`  ${s.specialist_id}/${s.name} at ${s.at}${s.input ? ` input=${JSON.stringify(s.input)}` : ''}`);
    }
    L.push('');
  }

  L.push('RUN SERIES (newest first) — considered vs produced is the key signal:');
  for (const r of pack.runs) {
    const fields = Object.entries(r.fields)
      .map(([k, v]) => `${k}=${v}`)
      .join(' ');
    L.push(
      `  ${r.ts}${r.active ? '' : ' [GATED/SKIPPED]'} considered=${r.considered ?? '?'} ` +
        `produced=${r.produced ?? '?'}${fields ? `  |  ${fields}` : ''}`,
    );
  }
  L.push('');

  if (pack.error_samples.length > 0) {
    L.push('ERRORS (rare for this class — most runs succeed):');
    for (const e of pack.error_samples) L.push(`  ${e.ts}: ${e.message}`);
  } else {
    L.push('ERRORS: none. Every run returned success. That is the defining property here.');
  }
  return L.join('\n');
}

/* ------------------------------------------------------------------ */
/* 2. Diagnose (grounded)                                              */
/* ------------------------------------------------------------------ */

const DIAGNOSE_SYSTEM =
  'You are Beatrice, the enterprise trainer for a household agentic system, ' +
  'diagnosing a capability that RUNS SUCCESSFULLY AND PRODUCES NOTHING. There is ' +
  'no exception to read — every run returned success. Ground EVERY specific claim ' +
  'in the EVIDENCE PACK; if the evidence does not support a detail, do not state ' +
  'it.\n\n' +
  'THE KEY SIGNAL is the considered-vs-produced series:\n' +
  '  - considered > 0 with produced == 0 → input ARRIVES and is dropped. The ' +
  'failure is DOWNSTREAM: extraction, a filter/threshold, a validation contract, ' +
  'or a changed upstream page shape.\n' +
  '  - considered == 0 every run → input NEVER ARRIVES. The failure is UPSTREAM: ' +
  'discovery, the query, or the source.\n' +
  '  - considered > 0 but the fetched items are the WRONG items (an old document, ' +
  'a listing page, a search form) LOOKS like the first and behaves like the ' +
  'second. Discovery that must be CURRENT cannot be a relevance-ranked web ' +
  'search — it returns what it indexed, forever, with no relation to recency.\n\n' +
  'FIX TYPES (pick the most specific the evidence supports):\n' +
  '  "stale_source"     — reading real but WRONG/OLD data (a relevance search ' +
  'standing in for a recency question). apply_via "propose_code_edit".\n' +
  '  "wrong_target"     — pointed at an index/listing page or a search form ' +
  'instead of the document. apply_via "propose_code_edit".\n' +
  '  "broken_filter"    — extraction works, a downstream filter/threshold/' +
  'validation rejects everything. apply_via "propose_code_edit".\n' +
  '  "contract_drift"   — the upstream shape changed; the parser matches nothing. ' +
  'apply_via "propose_code_edit".\n' +
  '  "retire_capability"— the capability has no purpose any more. This is a REAL ' +
  'answer: a job that cannot produce is worse than absent because it reads as ' +
  'coverage. apply_via "propose_code_edit".\n' +
  '  "code_change"      — a deeper source fix. apply_via "propose_code_edit" or ' +
  '"propose_code_change".\n' +
  '  "escalate"         — hand to the owner with a specific step. apply_via ' +
  '"escalate".\n\n' +
  'Reply with ONLY this JSON, nothing else:\n' +
  '{"root_cause":"<grounded explanation>","confidence":0.0-1.0,"inconclusive":' +
  'true|false,"fixes":[{"type":"stale_source|wrong_target|broken_filter|' +
  'contract_drift|retire_capability|code_change|escalate","title":"<short>",' +
  '"detail":"<concrete what-to-do, naming the file/field/source>","target":' +
  '"<tool/file or empty>","apply_via":"propose_code_edit|propose_code_change|' +
  'apply_low_risk_fix|manual|escalate"}]}';

const FIX_TYPES: ReadonlySet<YieldFixType> = new Set<YieldFixType>([
  'stale_source',
  'wrong_target',
  'broken_filter',
  'contract_drift',
  'retire_capability',
  'code_change',
  'escalate',
]);

/** Coerce apply_via into a sanctioned gate. A garbled value can never name a
 *  novel apply surface — that invariant is what keeps this diagnoser inert. */
function normalize_apply_via(type: YieldFixType, raw: unknown): ApplyVia {
  if (typeof raw === 'string' && EXISTING_GATES.has(raw as ApplyVia)) return raw as ApplyVia;
  return type === 'escalate' ? 'escalate' : 'propose_code_edit';
}

interface RawYieldDiagnosis {
  root_cause: string;
  confidence: number;
  inconclusive: boolean;
  fixes: YieldCandidateFix[];
}

function default_escalate(pack: YieldEvidencePack, reason?: string): YieldCandidateFix {
  return {
    type: 'escalate',
    title: 'Escalate to the owner',
    detail:
      reason ??
      `Surface the diagnosis to Jasper — \`${pack.tool}\` has been producing nothing while ` +
        `reporting success, and whether it should be fixed or retired is his call.`,
    target: '',
    apply_via: 'escalate',
  };
}

function fallback_diagnosis(pack: YieldEvidencePack): RawYieldDiagnosis {
  return {
    root_cause: `Automated diagnosis was unavailable. ${pack.assessment.summary}`,
    confidence: 0.2,
    inconclusive: true,
    fixes: [
      default_escalate(pack, 'The local model was unavailable; a person should read the run series and act.'),
    ],
  };
}

async function diagnose(pack: YieldEvidencePack, complete: CompleteRoleFn): Promise<RawYieldDiagnosis> {
  const content = await complete('research_extract', {
    system: DIAGNOSE_SYSTEM,
    user: `EVIDENCE PACK:\n\n${render_yield_evidence_text(pack)}\n\nReply with ONLY the JSON.`,
    temperature: 0.2,
    max_tokens: 1600,
  });
  if (!content) return fallback_diagnosis(pack);
  try {
    const parsed = JSON.parse(strip_fence(content)) as {
      root_cause?: unknown;
      confidence?: unknown;
      inconclusive?: unknown;
      fixes?: Array<Record<string, unknown>>;
    };
    const root_cause =
      typeof parsed.root_cause === 'string' && parsed.root_cause.trim().length > 2
        ? parsed.root_cause.trim().slice(0, 4000)
        : fallback_diagnosis(pack).root_cause;
    const confidence =
      typeof parsed.confidence === 'number' ? clamp01(parsed.confidence) : 0.5;
    const inconclusive = parsed.inconclusive === true;
    const fixes: YieldCandidateFix[] = [];
    if (Array.isArray(parsed.fixes)) {
      for (const raw of parsed.fixes.slice(0, 4)) {
        const type = (typeof raw.type === 'string' ? raw.type : '') as YieldFixType;
        if (!FIX_TYPES.has(type)) continue;
        const title = typeof raw.title === 'string' ? raw.title.trim().slice(0, 160) : '';
        const detail = typeof raw.detail === 'string' ? raw.detail.trim().slice(0, 1200) : '';
        if (!title && !detail) continue;
        fixes.push({
          type,
          title: title || type,
          detail: detail || title,
          target: typeof raw.target === 'string' ? raw.target.trim().slice(0, 200) : '',
          apply_via: normalize_apply_via(type, raw.apply_via),
        });
      }
    }
    if (fixes.length === 0) {
      return { root_cause, confidence, inconclusive: true, fixes: fallback_diagnosis(pack).fixes };
    }
    return { root_cause, confidence, inconclusive, fixes };
  } catch {
    return fallback_diagnosis(pack);
  }
}

function scrub_dropped(narrative: string, dropped: string[]): string {
  if (dropped.length === 0) return narrative;
  const needles = dropped.map((d) => d.toLowerCase().trim()).filter((d) => d.length >= 3);
  if (needles.length === 0) return narrative;
  return narrative
    .split('\n')
    .filter((line) => !needles.some((n) => line.toLowerCase().includes(n)))
    .join('\n')
    .trim();
}

/* ------------------------------------------------------------------ */
/* 3. Score (adversarial) + rank                                       */
/* ------------------------------------------------------------------ */

const SCORE_SYSTEM =
  'You are a SKEPTICAL reviewer scoring proposed fixes for a capability that ' +
  'produces no output. Be honest about what the evidence supports: repointing a ' +
  'stale source is usually high-likelihood and contained when the run series ' +
  'shows items arriving; a filter fix only helps if extraction is actually ' +
  'succeeding; RETIRING a capability is low-risk and easily reversed but should ' +
  'only score high when the evidence genuinely shows no remaining purpose; a ' +
  'broad code_change is slower and higher blast-radius. Score each fix:\n' +
  '- likelihood_to_resolve: 0.0-1.0 given the EVIDENCE.\n' +
  '- risk: "low"|"medium"|"high".\n' +
  '- reversibility: "easy"|"moderate"|"hard".\n' +
  '- blast_radius: "contained"|"service"|"broad".\n' +
  '- rationale: one short sentence.\n\n' +
  'Reply with ONLY this JSON, one entry per fix IN ORDER:\n' +
  '{"scores":[{"likelihood_to_resolve":0.0-1.0,"risk":"low|medium|high",' +
  '"reversibility":"easy|moderate|hard","blast_radius":"contained|service|broad",' +
  '"rationale":"<one sentence>"}]}';

const RISK_W = { low: 1, medium: 0.65, high: 0.35 } as const;
const REV_W = { easy: 1, moderate: 0.85, hard: 0.6 } as const;
const RISK_RANK = { low: 0, medium: 1, high: 2 } as const;
/** Most-specific / least-invasive first on a confidence tie. */
const TYPE_RANK: Record<YieldFixType, number> = {
  stale_source: 0,
  wrong_target: 1,
  contract_drift: 2,
  broken_filter: 3,
  code_change: 4,
  retire_capability: 5,
  escalate: 6,
};

function composite(s: Pick<FixScore, 'likelihood_to_resolve' | 'risk' | 'reversibility'>): number {
  return clamp01(s.likelihood_to_resolve * RISK_W[s.risk] * REV_W[s.reversibility]);
}
function escalate_score(): FixScore {
  const base = {
    likelihood_to_resolve: 0.5,
    risk: 'low' as const,
    reversibility: 'easy' as const,
    blast_radius: 'contained' as const,
  };
  return {
    ...base,
    confidence: composite(base),
    rationale: 'Always available; hands the call to a human who can see the live system.',
  };
}
function neutral_score(type: YieldFixType): FixScore {
  const by_type: Record<YieldFixType, Omit<FixScore, 'confidence' | 'rationale'>> = {
    stale_source: { likelihood_to_resolve: 0.6, risk: 'low', reversibility: 'easy', blast_radius: 'contained' },
    wrong_target: { likelihood_to_resolve: 0.55, risk: 'low', reversibility: 'easy', blast_radius: 'contained' },
    contract_drift: { likelihood_to_resolve: 0.5, risk: 'medium', reversibility: 'moderate', blast_radius: 'contained' },
    broken_filter: { likelihood_to_resolve: 0.5, risk: 'medium', reversibility: 'moderate', blast_radius: 'service' },
    code_change: { likelihood_to_resolve: 0.4, risk: 'medium', reversibility: 'moderate', blast_radius: 'broad' },
    retire_capability: { likelihood_to_resolve: 0.35, risk: 'low', reversibility: 'easy', blast_radius: 'contained' },
    escalate: { likelihood_to_resolve: 0.5, risk: 'low', reversibility: 'easy', blast_radius: 'contained' },
  };
  const base = by_type[type];
  return { ...base, confidence: composite(base), rationale: 'Scoring unavailable — neutral default for this fix type.' };
}

interface RawScore {
  likelihood_to_resolve: number;
  risk: FixScore['risk'];
  reversibility: FixScore['reversibility'];
  blast_radius: FixScore['blast_radius'];
  rationale: string;
}

function parse_scores(content: string, n: number): (RawScore | null)[] {
  try {
    const parsed = JSON.parse(strip_fence(content)) as { scores?: Array<Record<string, unknown>> };
    if (!Array.isArray(parsed.scores)) return new Array(n).fill(null);
    const out: (RawScore | null)[] = [];
    for (const raw of parsed.scores.slice(0, n)) {
      const lk = typeof raw.likelihood_to_resolve === 'number' ? clamp01(raw.likelihood_to_resolve) : null;
      const risk = (['low', 'medium', 'high'] as const).includes(raw.risk as FixScore['risk'])
        ? (raw.risk as FixScore['risk'])
        : null;
      const rev = (['easy', 'moderate', 'hard'] as const).includes(raw.reversibility as FixScore['reversibility'])
        ? (raw.reversibility as FixScore['reversibility'])
        : null;
      const blast = (['contained', 'service', 'broad'] as const).includes(raw.blast_radius as FixScore['blast_radius'])
        ? (raw.blast_radius as FixScore['blast_radius'])
        : null;
      if (lk === null || risk === null || rev === null || blast === null) {
        out.push(null);
        continue;
      }
      out.push({
        likelihood_to_resolve: lk,
        risk,
        reversibility: rev,
        blast_radius: blast,
        rationale: typeof raw.rationale === 'string' ? raw.rationale.slice(0, 300) : '',
      });
    }
    while (out.length < n) out.push(null);
    return out;
  } catch {
    return new Array(n).fill(null);
  }
}

async function score_and_rank(
  pack: YieldEvidencePack,
  diag: RawYieldDiagnosis,
  complete: CompleteRoleFn,
): Promise<YieldScoredFix[]> {
  const real = diag.fixes.filter((f) => f.type !== 'escalate');
  let model_scores: (RawScore | null)[] = new Array(real.length).fill(null);
  if (real.length > 0) {
    const fix_list = real
      .map((f, i) => `${i + 1}. [${f.type}] ${f.title} — ${f.detail}${f.target ? ` (target: ${f.target})` : ''}`)
      .join('\n');
    const content = await complete('research_extract', {
      system: SCORE_SYSTEM,
      user:
        `EVIDENCE PACK:\n\n${render_yield_evidence_text(pack)}\n\n` +
        `DIAGNOSED ROOT CAUSE: ${diag.root_cause}\n(diagnosis ${diag.inconclusive ? 'INCONCLUSIVE' : 'conclusive'})\n\n` +
        `CANDIDATE FIXES:\n${fix_list}\n\nReply with ONLY the JSON.`,
      temperature: 0.2,
      max_tokens: 1200,
    });
    if (content) model_scores = parse_scores(content, real.length);
  }
  const scored: YieldScoredFix[] = [];
  let ri = 0;
  for (const f of diag.fixes) {
    if (f.type === 'escalate') {
      scored.push({ ...f, score: escalate_score() });
      continue;
    }
    const raw = model_scores[ri++];
    if (raw) {
      const { rationale, ...rest } = raw;
      scored.push({ ...f, score: { ...rest, confidence: composite(rest), rationale } });
    } else {
      scored.push({ ...f, score: neutral_score(f.type) });
    }
  }
  scored.sort((a, b) => {
    if (b.score.confidence !== a.score.confidence) return b.score.confidence - a.score.confidence;
    if (RISK_RANK[a.score.risk] !== RISK_RANK[b.score.risk]) return RISK_RANK[a.score.risk] - RISK_RANK[b.score.risk];
    return TYPE_RANK[a.type] - TYPE_RANK[b.type];
  });
  return scored;
}

/* ------------------------------------------------------------------ */
/* Orchestrator                                                        */
/* ------------------------------------------------------------------ */

export async function run_yield_diagnosis(
  deps: YieldDiagnosisDeps,
  tool: string,
): Promise<YieldDiagnosis> {
  const complete = deps.complete_role_fn ?? default_complete(deps.llm);
  const pack = gather_yield_evidence(deps, tool);
  const diag = await diagnose(pack, complete);

  // The escalate floor is ALWAYS present, so a "real" fix only wins by
  // out-scoring handing it to a human.
  if (!diag.fixes.some((f) => f.type === 'escalate')) {
    diag.fixes.push(default_escalate(pack));
  }

  const ungrounded_dropped: string[] = [];
  const verify = deps.verify_fn ?? assess_factual_grounding;
  if (deps.llm && !diag.inconclusive) {
    try {
      const evidence_parts = { tool_results: [render_yield_evidence_text(pack)] };
      const res = await verify({
        reply: diag.root_cause,
        grounding: build_grounding_context(evidence_parts),
        evidence_text: build_grounding_evidence(evidence_parts),
        llm: deps.llm,
        self_identity:
          'Beatrice, the enterprise trainer, diagnosing a capability that runs successfully and produces no output.',
      });
      for (const u of res.unsupported) ungrounded_dropped.push(u.claim);
    } catch {
      /* fail-open */
    }
  }
  const root_cause = scrub_dropped(diag.root_cause, ungrounded_dropped) || diag.root_cause;
  const confidence = clamp01(diag.confidence - Math.min(0.4, ungrounded_dropped.length * 0.15));

  const fixes = await score_and_rank(pack, diag, complete);

  return {
    subject: `capability:${tool}`,
    root_cause,
    confidence,
    inconclusive: diag.inconclusive,
    fixes,
    recommended_index: fixes.length === 0 ? -1 : 0,
    ungrounded_dropped,
    evidence: pack,
    model: deps.llm ? 'research_extract' : 'fallback',
  };
}

export function render_yield_diagnosis_markdown(d: YieldDiagnosis): string {
  const L: string[] = [];
  L.push(`# Zero-output diagnosis — \`${d.evidence.tool}\``);
  L.push('');
  L.push(`**Verdict:** ${d.evidence.assessment.summary}`);
  L.push('');
  L.push(
    `**Root cause** (confidence ${Math.round(d.confidence * 100)}%${d.inconclusive ? ', INCONCLUSIVE' : ''}):`,
  );
  L.push('');
  L.push(d.root_cause);
  L.push('');
  L.push('## Ranked fixes');
  L.push('');
  d.fixes.forEach((f, i) => {
    const mark = i === d.recommended_index && f.score.confidence >= yield_recommend_floor() ? ' ← recommended' : '';
    L.push(`${i + 1}. **[${f.type}] ${f.title}**${mark}`);
    L.push(
      `   - score ${f.score.confidence.toFixed(2)} (likelihood ${f.score.likelihood_to_resolve.toFixed(2)}, ` +
        `risk ${f.score.risk}, reversibility ${f.score.reversibility}, blast ${f.score.blast_radius})`,
    );
    L.push(`   - ${f.detail}`);
    L.push(`   - apply via \`${f.apply_via}\`${f.target ? ` (target: ${f.target})` : ''}`);
    L.push(`   - _${f.score.rationale}_`);
  });
  if (d.ungrounded_dropped.length > 0) {
    L.push('');
    L.push(`_Dropped as ungrounded: ${d.ungrounded_dropped.join('; ')}_`);
  }
  return L.join('\n');
}
