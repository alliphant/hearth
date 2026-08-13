/**
 * toolcall_diagnosis — the self-diagnosis + scored-fix engine for a recurring
 * tool-call / honesty miss (2026-06-22).
 *
 * The instant-feedback driver (guard_feedback.ts) files a process_miss + wakes
 * Beatrice when a tool-arg failure or an honesty-guard catch RECURS. This module
 * is what she runs in that woken pass — the diagnostic loop a human ran by hand
 * on 2026-06-22 to find the real root cause of the tool-call failures:
 *
 *   1. query the audit_log error text for the failing tool + extract the
 *      (model PROVIDED → schema REQUIRED) field mismatch;
 *   2. read the tool's actual schema (required/optional/aliases/regex patterns);
 *   3. PROBE the live interactive endpoint to localize blame (endpoint vs schema)
 *      — `interactive_probe.ts` reproduces the `:8088` probe;
 *   4. diagnose the ROOT CAUSE on the LOCAL deep model, grounded ONLY in that
 *      evidence (the shared fact critic drops any specific the evidence doesn't
 *      support), and emit typed candidate fixes each adversarially scored.
 *
 * It is the TOOL-CALL sibling of health_diagnosis.ts (same gather → diagnose →
 * score → rank → ground pipeline; a separate module because the fix taxonomy is
 * tool-contract-shaped, not infra-shaped). Every fix carries an `apply_via`
 * naming an EXISTING gate — this module APPLIES NOTHING. Fail-open +
 * kill-switched (HEARTH_TOOLCALL_DIAGNOSIS=0).
 */
import type { Database } from 'bun:sqlite';
import { zodToJsonSchema } from 'zod-to-json-schema';
import type { LLMRole, LLMRouter } from './llm';
import type { ToolRegistry } from './tool_registry';
import { assess_factual_grounding } from './fact_critic';
import { build_grounding_context, build_grounding_evidence } from './provenance';
import {
  run_interactive_probe,
  render_probe_markdown,
  type InteractiveProbeDeps,
  type InteractiveProbeReport,
} from './interactive_probe';
// Reuse the sanctioned apply-gate set + score shape from the infra engine so
// there is ONE definition of "the existing gates" across both diagnosers.
import { EXISTING_GATES, type ApplyVia, type FixScore } from './health_diagnosis';
export { EXISTING_GATES } from './health_diagnosis';
export type { ApplyVia, FixScore } from './health_diagnosis';

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

/** The tool-contract / honesty fix taxonomy (distinct from infra's). */
export type ToolFixType =
  | 'rename_field' // rename a required field to the conventional name the model emits
  | 'make_optional' // make a required field optional + derive it in execute()
  | 'add_alias' // add the synonym to the central FIELD_ALIASES map
  | 'relax_contract' // flatten/broaden an over-specific or deep schema
  | 'grounding_fix' // a connector returns bare errors the model fabricates over → add recovery hint
  | 'persona_tuning' // a genuine voice/tone issue (the weakest layer — last resort)
  | 'code_change' // a deeper source fix
  | 'escalate';

export interface CandidateFix {
  type: ToolFixType;
  title: string;
  detail: string;
  /** Tool name / field / file the fix touches, or ''. */
  target: string;
  apply_via: ApplyVia;
}

export interface ScoredFix extends CandidateFix {
  score: FixScore;
}

/** One failing tool call: what the model PROVIDED vs what the schema REQUIRED. */
export interface ProvidedVsRequired {
  ts: string;
  provided_keys: string[];
  missing_required: string[];
  error: string;
}

export interface ToolEvidencePack {
  /** 'arg' for a tool-arg failure, 'honesty' for a guard catch. */
  kind: 'arg' | 'honesty';
  tool: string | null;
  specialist_id: string | null;
  guard: string | null;
  calls: number;
  errors: number;
  /** Distinct error strings for the failing tool / guard. */
  error_samples: Array<{ ts: string; message: string }>;
  /** Per failing call: provided vs required (the load-bearing mismatch). */
  provided_vs_required: ProvidedVsRequired[];
  /** Schema introspection of the failing tool (null for a tool-less honesty miss). */
  schema: {
    required: string[];
    optional: string[];
    /** The lint warnings for this tool (synonym-required / pattern / over-wide). */
    lint: string[];
  } | null;
  /** The live-endpoint probe report (null when not run / unavailable). */
  probe: InteractiveProbeReport | null;
}

export interface ToolcallDiagnosis {
  kind: 'arg' | 'honesty';
  subject: string;
  root_cause: string;
  confidence: number;
  inconclusive: boolean;
  fixes: ScoredFix[];
  recommended_index: number;
  ungrounded_dropped: string[];
  evidence: ToolEvidencePack;
  model: string;
}

/* ------------------------------------------------------------------ */
/* Tunables                                                            */
/* ------------------------------------------------------------------ */

export function toolcall_diagnosis_enabled(): boolean {
  return process.env.HEARTH_TOOLCALL_DIAGNOSIS !== '0';
}

function int_env(name: string, dflt: number, lo: number, hi: number): number {
  const raw = Number.parseInt(process.env[name] ?? '', 10);
  const v = Number.isFinite(raw) && raw > 0 ? raw : dflt;
  return Math.max(lo, Math.min(v, hi));
}
function window_hours(): number {
  return int_env('HEARTH_TOOLCALL_DIAGNOSIS_WINDOW_HOURS', 168, 1, 720);
}
function max_samples(): number {
  return int_env('HEARTH_TOOLCALL_DIAGNOSIS_SAMPLES', 12, 1, 50);
}
export function recommend_floor(): number {
  const raw = Number(process.env.HEARTH_TOOLCALL_DIAGNOSIS_FLOOR);
  return Number.isFinite(raw) && raw > 0 && raw < 1 ? raw : 0.45;
}

const ERROR_MSG_CAP = 320;

/* ------------------------------------------------------------------ */
/* Engine deps + seams                                                 */
/* ------------------------------------------------------------------ */

export type CompleteRoleFn = (
  role: LLMRole,
  args: { system: string; user: string; temperature?: number; max_tokens?: number },
) => Promise<string | null>;

export interface ToolcallDiagnosisDeps {
  db: Database;
  tools: ToolRegistry;
  llm?: LLMRouter;
  now?: Date;
  /** Smoke seams — all default to the real local-model / probe paths. */
  complete_role_fn?: CompleteRoleFn;
  verify_fn?: typeof assess_factual_grounding;
  /** Defaults to run_interactive_probe; the smoke injects a scripted report. */
  probe_fn?: (deps: InteractiveProbeDeps) => Promise<InteractiveProbeReport>;
}

/** Which tool/specialist/guard to diagnose — resolved from the miss evidence_ref
 *  (`arg-mismatch:<tool>[:field]` or `honesty:<guard>:<specialist>`). */
export interface DiagnosisTarget {
  tool?: string;
  specialist_id?: string;
  guard?: string;
  role?: LLMRole;
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

/* ------------------------------------------------------------------ */
/* 1. Evidence pack                                                    */
/* ------------------------------------------------------------------ */

/** Distinct error STRINGS for a tool/guard from the audit log (both the `error`
 *  column and a connector's `{error}` inside execution_result). */
function error_samples(
  db: Database,
  match: { tool_name: string; agent?: string },
  cutoff_iso: string,
  cap: number,
): Array<{ ts: string; message: string }> {
  const where = ['ts >= ?', 'tool_name = ?'];
  const params: string[] = [cutoff_iso, match.tool_name];
  if (match.agent) {
    where.push('agent = ?');
    params.push(match.agent);
  }
  where.push(`(error IS NOT NULL OR (execution_result IS NOT NULL AND execution_result LIKE '%"error"%'))`);
  const rows = db
    .prepare(
      `SELECT ts, error, execution_result FROM audit_log WHERE ${where.join(' AND ')} ORDER BY ts DESC LIMIT 400`,
    )
    .all(...params) as Array<{ ts: string; error: string | null; execution_result: string | null }>;
  const out: Array<{ ts: string; message: string }> = [];
  const seen = new Set<string>();
  for (const r of rows) {
    let msg = (r.error ?? '').trim();
    if (!msg && r.execution_result) {
      try {
        const parsed = JSON.parse(r.execution_result) as { error?: unknown };
        if (typeof parsed.error === 'string') msg = parsed.error.trim();
        else if (parsed.error != null) msg = JSON.stringify(parsed.error).slice(0, ERROR_MSG_CAP);
      } catch {
        msg = r.execution_result.replace(/\s+/g, ' ').slice(0, ERROR_MSG_CAP);
      }
    }
    if (!msg) continue;
    msg = msg.slice(0, ERROR_MSG_CAP);
    const key = msg.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ ts: r.ts, message: msg });
    if (out.length >= cap) break;
  }
  return out;
}

/** Per failing CALL of a tool: the keys the model PROVIDED vs the schema's
 *  REQUIRED set — the exact extraction the 2026-06-22 session did by hand. */
function provided_vs_required(
  db: Database,
  tool: string,
  required: string[],
  cutoff_iso: string,
  cap: number,
): ProvidedVsRequired[] {
  const rows = db
    .prepare(
      `SELECT ts, tool_input, error FROM audit_log
        WHERE ts >= ? AND tool_name = ? AND error IS NOT NULL
        ORDER BY ts DESC LIMIT 200`,
    )
    .all(cutoff_iso, tool) as Array<{ ts: string; tool_input: string | null; error: string | null }>;
  const out: ProvidedVsRequired[] = [];
  const seen = new Set<string>();
  const req = new Set(required);
  for (const r of rows) {
    let provided: string[] = [];
    if (r.tool_input) {
      try {
        const obj = JSON.parse(r.tool_input) as Record<string, unknown>;
        if (obj && typeof obj === 'object' && !Array.isArray(obj)) provided = Object.keys(obj);
      } catch {
        /* unparseable input — leave provided empty */
      }
    }
    const missing = [...req].filter((k) => !provided.includes(k));
    const key = `${provided.sort().join(',')}|${missing.sort().join(',')}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      ts: r.ts,
      provided_keys: provided,
      missing_required: missing,
      error: (r.error ?? '').slice(0, ERROR_MSG_CAP),
    });
    if (out.length >= cap) break;
  }
  return out;
}

function schema_introspect(
  tools: ToolRegistry,
  tool: string,
): ToolEvidencePack['schema'] {
  const t = tools.get(tool);
  if (!t) return null;
  let required: string[] = [];
  let optional: string[] = [];
  try {
    const json = zodToJsonSchema(t.input_schema as Parameters<typeof zodToJsonSchema>[0], {
      $refStrategy: 'none',
    }) as { required?: unknown; properties?: Record<string, unknown> };
    required = Array.isArray(json.required) ? (json.required as string[]) : [];
    const props = json.properties && typeof json.properties === 'object' ? Object.keys(json.properties) : [];
    optional = props.filter((p) => !required.includes(p));
  } catch {
    /* unintrospectable schema — empty lists */
  }
  const lint = tools.lint().find((w) => w.tool === tool)?.warnings ?? [];
  return { required, optional, lint };
}

export async function gather_tool_evidence(
  deps: ToolcallDiagnosisDeps,
  target: DiagnosisTarget,
): Promise<ToolEvidencePack> {
  const now = deps.now ?? new Date();
  const cutoff = new Date(now.getTime() - window_hours() * 3600_000).toISOString();
  const cap = max_samples();
  const kind: 'arg' | 'honesty' = target.tool ? 'arg' : 'honesty';

  const schema = target.tool ? schema_introspect(deps.tools, target.tool) : null;
  const required = schema?.required ?? [];

  // Error samples key on the tool (arg) or the guard (honesty).
  const sample_match = target.tool
    ? { tool_name: target.tool }
    : { tool_name: target.guard ?? 'fabricated_save_guard', ...(target.specialist_id ? { agent: target.specialist_id } : {}) };
  const samples = error_samples(deps.db, sample_match, cutoff, cap);

  const pvr = target.tool ? provided_vs_required(deps.db, target.tool, required, cutoff, cap) : [];

  // Probe the live endpoint only for an arg miss (it characterizes tool-calling).
  let probe: InteractiveProbeReport | null = null;
  if (target.tool) {
    const probe_fn = deps.probe_fn ?? run_interactive_probe;
    try {
      probe = await probe_fn({
        ...(deps.llm ? { llm: deps.llm } : {}),
        ...(target.role ? { role: target.role } : {}),
      });
    } catch {
      probe = null; // fail-open — diagnosis proceeds from the rest
    }
  }

  return {
    kind,
    tool: target.tool ?? null,
    specialist_id: target.specialist_id ?? null,
    guard: target.guard ?? null,
    calls: samples.length,
    errors: samples.length,
    error_samples: samples,
    provided_vs_required: pvr,
    schema,
    probe,
  };
}

export function render_tool_evidence_text(pack: ToolEvidencePack): string {
  const lines: string[] = [];
  if (pack.kind === 'arg') {
    lines.push(`FAILING TOOL: ${pack.tool}`);
  } else {
    lines.push(`HONESTY GUARD: ${pack.guard} on specialist ${pack.specialist_id}`);
  }
  lines.push('');
  if (pack.schema) {
    lines.push(`SCHEMA — required: [${pack.schema.required.join(', ') || '(none)'}]`);
    lines.push(`         optional: [${pack.schema.optional.join(', ') || '(none)'}]`);
    if (pack.schema.lint.length > 0) {
      lines.push('SCHEMA LINT WARNINGS:');
      for (const w of pack.schema.lint) lines.push(`  - ${w}`);
    } else {
      lines.push('SCHEMA LINT: clean');
    }
    lines.push('');
  }
  if (pack.provided_vs_required.length > 0) {
    lines.push('PROVIDED vs REQUIRED (what the model sent vs what the schema demanded):');
    for (const p of pack.provided_vs_required) {
      lines.push(
        `  - provided [${p.provided_keys.join(', ') || '(none)'}] ; MISSING required [${
          p.missing_required.join(', ') || '(none)'
        }] ; error: ${p.error}`,
      );
    }
    lines.push('');
  }
  lines.push(`ERROR SAMPLES (${pack.error_samples.length}):`);
  if (pack.error_samples.length === 0) lines.push('  (no error rows in the window)');
  else for (const s of pack.error_samples) lines.push(`  [${s.ts}] ${s.message}`);
  lines.push('');
  if (pack.probe) {
    lines.push('LIVE ENDPOINT PROBE:');
    lines.push(render_probe_markdown(pack.probe));
  }
  return lines.join('\n');
}

/* ------------------------------------------------------------------ */
/* 2. Diagnose (local deep tier, grounded)                             */
/* ------------------------------------------------------------------ */

const DIAGNOSE_SYSTEM =
  'You are diagnosing why a TOOL CALL keeps failing (or why a specialist keeps ' +
  'tripping an honesty guard) in a local household-assistant tool server. You ' +
  'are given an EVIDENCE PACK gathered from the live system: the failing tool ' +
  "name, its SCHEMA (required/optional fields + lint warnings), the PROVIDED-vs-" +
  'REQUIRED field mismatch per failing call, the actual ERROR strings, and a LIVE ' +
  'ENDPOINT PROBE that tested whether the interactive model can emit valid args ' +
  'for canonical schema shapes.\n\n' +
  'KEY REASONING: if the probe shows the endpoint emits VALID native tool_calls ' +
  'for all shapes, the model is NOT the problem — a recurring per-tool failure is ' +
  'the SCHEMA/CONTRACT (a gratuitously-specific required field whose conventional ' +
  'synonym the model emits, e.g. the schema wants `note_path` but the model sends ' +
  '`path`; or an over-wide/deeply-nested required set). Ground every claim in the ' +
  'evidence — quote the error string or the provided-vs-required line. If the ' +
  'evidence does NOT reveal a cause, set inconclusive=true; NEVER invent a field ' +
  'name, an error, or a cause not in the evidence.\n\n' +
  'Propose 1-4 CONCRETE candidate fixes. Each has a type:\n' +
  '  "rename_field"  — rename a required field to the conventional name the model ' +
  'emits (the cleanest fix; the model SEES the better name). apply_via "propose_code_edit".\n' +
  '  "make_optional" — make a required field optional and derive it inside ' +
  'execute() from context the tool already has. apply_via "propose_code_edit".\n' +
  '  "add_alias"     — add the synonym to the central FIELD_ALIASES map in ' +
  'tool_registry.ts so recovery catches it. apply_via "propose_code_edit".\n' +
  '  "relax_contract"— flatten/broaden an over-specific or deeply-nested schema. ' +
  'apply_via "propose_code_edit" (or "propose_code_change" for a rewrite).\n' +
  '  "grounding_fix" — a connector returns bare errors the model fabricates over; ' +
  'add a recovery hint (candidates/suggestions). apply_via "propose_code_edit".\n' +
  '  "persona_tuning"— ONLY for a genuine voice/tone issue (weakest layer, last ' +
  'resort). apply_via "propose_code_edit".\n' +
  '  "code_change"   — a deeper source fix. apply_via "propose_code_edit" or ' +
  '"propose_code_change".\n' +
  '  "escalate"      — hand to the owner with a specific step. apply_via "escalate".\n\n' +
  'Reply with ONLY this JSON, nothing else:\n' +
  '{"root_cause":"<grounded explanation>","confidence":0.0-1.0,"inconclusive":' +
  'true|false,"fixes":[{"type":"rename_field|make_optional|add_alias|relax_contract|' +
  'grounding_fix|persona_tuning|code_change|escalate","title":"<short>","detail":' +
  '"<concrete what-to-do, naming the field/file>","target":"<tool/field/file or empty>",' +
  '"apply_via":"propose_code_edit|propose_code_change|apply_low_risk_fix|manual|escalate"}]}';

const FIX_TYPES: ReadonlySet<ToolFixType> = new Set<ToolFixType>([
  'rename_field',
  'make_optional',
  'add_alias',
  'relax_contract',
  'grounding_fix',
  'persona_tuning',
  'code_change',
  'escalate',
]);

/** Coerce apply_via to a sanctioned gate, defaulting by fix type so a garbled
 *  value can never name a novel apply surface. */
function normalize_apply_via(type: ToolFixType, raw: unknown): ApplyVia {
  if (typeof raw === 'string' && EXISTING_GATES.has(raw as ApplyVia)) return raw as ApplyVia;
  return type === 'escalate' ? 'escalate' : 'propose_code_edit';
}

interface RawDiagnosis {
  root_cause: string;
  confidence: number;
  inconclusive: boolean;
  fixes: CandidateFix[];
}

function default_escalate(pack: ToolEvidencePack, reason?: string): CandidateFix {
  const subj = pack.tool ? `tool \`${pack.tool}\`` : `${pack.guard} on ${pack.specialist_id}`;
  return {
    type: 'escalate',
    title: 'Escalate to the owner',
    detail:
      reason ?? `Surface the diagnosis to Jasper so he can decide — the recurring failure on ${subj} needs a human's call.`,
    target: '',
    apply_via: 'escalate',
  };
}

function fallback_diagnosis(pack: ToolEvidencePack): RawDiagnosis {
  return {
    root_cause: `Automated diagnosis was unavailable. ${
      pack.error_samples[0]?.message ?? 'See the evidence pack.'
    }`,
    confidence: 0.2,
    inconclusive: true,
    fixes: [default_escalate(pack, 'The local model was unavailable; a person should read the evidence and act.')],
  };
}

async function diagnose(pack: ToolEvidencePack, complete: CompleteRoleFn): Promise<RawDiagnosis> {
  const evidence = render_tool_evidence_text(pack);
  const content = await complete('research_extract', {
    system: DIAGNOSE_SYSTEM,
    user: `EVIDENCE PACK:\n\n${evidence}\n\nReply with ONLY the JSON.`,
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
    const confidence = typeof parsed.confidence === 'number' ? Math.max(0, Math.min(1, parsed.confidence)) : 0.5;
    const inconclusive = parsed.inconclusive === true;
    const fixes: CandidateFix[] = [];
    if (Array.isArray(parsed.fixes)) {
      for (const raw of parsed.fixes.slice(0, 4)) {
        const type = (typeof raw.type === 'string' ? raw.type : '') as ToolFixType;
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
    if (fixes.length === 0) return { root_cause, confidence, inconclusive: true, fixes: fallback_diagnosis(pack).fixes };
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
/* 3. Score (adversarial) + rank — mirrors health_diagnosis scoring    */
/* ------------------------------------------------------------------ */

const SCORE_SYSTEM =
  'You are a SKEPTICAL reviewer scoring proposed fixes for a recurring tool-call ' +
  'failure. A schema rename/alias is usually low-risk and high-likelihood when ' +
  'the evidence shows a clear synonym mismatch; making a field optional is safe ' +
  'when it is derivable; a broad code_change is slower and higher blast-radius; ' +
  'persona_tuning rarely fixes a structural arg failure. Score each fix HONESTLY:\n' +
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
const TYPE_RANK: Record<ToolFixType, number> = {
  rename_field: 0,
  add_alias: 1,
  make_optional: 2,
  grounding_fix: 3,
  relax_contract: 4,
  persona_tuning: 5,
  code_change: 6,
  escalate: 7,
};

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}
function composite(s: Pick<FixScore, 'likelihood_to_resolve' | 'risk' | 'reversibility'>): number {
  return clamp01(s.likelihood_to_resolve * RISK_W[s.risk] * REV_W[s.reversibility]);
}
function escalate_score(): FixScore {
  const base = { likelihood_to_resolve: 0.5, risk: 'low' as const, reversibility: 'easy' as const, blast_radius: 'contained' as const };
  return { ...base, confidence: composite(base), rationale: 'Always available; hands the call to a human who can see the live system.' };
}
function neutral_score(type: ToolFixType): FixScore {
  const by_type: Record<ToolFixType, Omit<FixScore, 'confidence' | 'rationale'>> = {
    rename_field: { likelihood_to_resolve: 0.6, risk: 'low', reversibility: 'easy', blast_radius: 'contained' },
    add_alias: { likelihood_to_resolve: 0.55, risk: 'low', reversibility: 'easy', blast_radius: 'contained' },
    make_optional: { likelihood_to_resolve: 0.5, risk: 'low', reversibility: 'easy', blast_radius: 'contained' },
    grounding_fix: { likelihood_to_resolve: 0.5, risk: 'medium', reversibility: 'moderate', blast_radius: 'service' },
    relax_contract: { likelihood_to_resolve: 0.45, risk: 'medium', reversibility: 'moderate', blast_radius: 'service' },
    persona_tuning: { likelihood_to_resolve: 0.3, risk: 'medium', reversibility: 'easy', blast_radius: 'contained' },
    code_change: { likelihood_to_resolve: 0.4, risk: 'medium', reversibility: 'moderate', blast_radius: 'broad' },
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
      const risk = (['low', 'medium', 'high'] as const).includes(raw.risk as FixScore['risk']) ? (raw.risk as FixScore['risk']) : null;
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
      out.push({ likelihood_to_resolve: lk, risk, reversibility: rev, blast_radius: blast, rationale: typeof raw.rationale === 'string' ? raw.rationale.slice(0, 300) : '' });
    }
    while (out.length < n) out.push(null);
    return out;
  } catch {
    return new Array(n).fill(null);
  }
}

async function score_and_rank(pack: ToolEvidencePack, diag: RawDiagnosis, complete: CompleteRoleFn): Promise<ScoredFix[]> {
  const real = diag.fixes.filter((f) => f.type !== 'escalate');
  let model_scores: (RawScore | null)[] = new Array(real.length).fill(null);
  if (real.length > 0) {
    const fix_list = real
      .map((f, i) => `${i + 1}. [${f.type}] ${f.title} — ${f.detail}${f.target ? ` (target: ${f.target})` : ''}`)
      .join('\n');
    const content = await complete('research_extract', {
      system: SCORE_SYSTEM,
      user:
        `EVIDENCE PACK:\n\n${render_tool_evidence_text(pack)}\n\n` +
        `DIAGNOSED ROOT CAUSE: ${diag.root_cause}\n(diagnosis ${diag.inconclusive ? 'INCONCLUSIVE' : 'conclusive'})\n\n` +
        `CANDIDATE FIXES:\n${fix_list}\n\nReply with ONLY the JSON.`,
      temperature: 0.2,
      max_tokens: 1200,
    });
    if (content) model_scores = parse_scores(content, real.length);
  }
  const scored: ScoredFix[] = [];
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

export async function run_toolcall_diagnosis(
  deps: ToolcallDiagnosisDeps,
  target: DiagnosisTarget,
): Promise<ToolcallDiagnosis> {
  const complete = deps.complete_role_fn ?? default_complete(deps.llm);
  const pack = await gather_tool_evidence(deps, target);
  const diag = await diagnose(pack, complete);

  if (!diag.fixes.some((f) => f.type === 'escalate')) {
    diag.fixes.push(default_escalate(pack));
  }

  const ungrounded_dropped: string[] = [];
  const verify = deps.verify_fn ?? assess_factual_grounding;
  if (deps.llm && !diag.inconclusive) {
    try {
      const evidence_parts = { tool_results: [render_tool_evidence_text(pack)] };
      const res = await verify({
        reply: diag.root_cause,
        grounding: build_grounding_context(evidence_parts),
        evidence_text: build_grounding_evidence(evidence_parts),
        llm: deps.llm,
        self_identity: 'Beatrice, the enterprise trainer, diagnosing a recurring tool-call failure.',
      });
      for (const u of res.unsupported) ungrounded_dropped.push(u.claim);
    } catch {
      /* fail-open */
    }
  }
  const root_cause = scrub_dropped(diag.root_cause, ungrounded_dropped) || diag.root_cause;
  const confidence = clamp01(diag.confidence - Math.min(0.4, ungrounded_dropped.length * 0.15));

  const fixes = await score_and_rank(pack, diag, complete);
  const subject = pack.tool ? `tool:${pack.tool}` : `${pack.guard}:${pack.specialist_id}`;

  return {
    kind: pack.kind,
    subject,
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

export function render_toolcall_diagnosis_markdown(d: ToolcallDiagnosis): string {
  const lines: string[] = [];
  const subj = d.evidence.tool ? `tool \`${d.evidence.tool}\`` : `${d.evidence.guard} on ${d.evidence.specialist_id}`;
  lines.push(`# Tool-call diagnosis — ${subj}`);
  lines.push('');
  lines.push(`**Root cause** (confidence ${Math.round(d.confidence * 100)}%${d.inconclusive ? ', INCONCLUSIVE' : ''}):`);
  lines.push('');
  lines.push(d.root_cause);
  lines.push('');
  if (d.evidence.probe) {
    lines.push(`**Live probe:** ${d.evidence.probe.summary}`);
    lines.push('');
  }
  lines.push('## Scored fixes (ranked)');
  d.fixes.forEach((f, i) => {
    const pick = i === d.recommended_index ? ' ⭐ recommended' : '';
    lines.push(
      `${i + 1}. **${f.title}**${pick} — _${f.type}_, apply via \`${f.apply_via}\`\n` +
        `   - confidence ${Math.round(f.score.confidence * 100)}% · likelihood ${Math.round(
          f.score.likelihood_to_resolve * 100,
        )}% · risk ${f.score.risk} · reversibility ${f.score.reversibility} · blast ${f.score.blast_radius}\n` +
        `   - ${f.detail}` +
        (f.score.rationale ? `\n   - _score rationale:_ ${f.score.rationale}` : ''),
    );
  });
  if (d.ungrounded_dropped.length > 0) {
    lines.push('');
    lines.push(`_Grounding critic dropped ${d.ungrounded_dropped.length} unsupported specific(s) from the narrative._`);
  }
  return lines.join('\n');
}
