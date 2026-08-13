/**
 * eval_diagnosis — turn a failing golden eval into a GROUNDED, scored, filed
 * proposal instead of a process_miss that waits for a human (2026-08-03).
 *
 * THE GAP. Hearth already owns both hard halves of a self-improvement loop and
 * has never connected them. `evals/golden_tasks.ts` says WHAT broke (53+
 * replayable past failures, deterministic assertions, run against the live
 * personas and the live model). `change_measurement.ts` says WHETHER a fix
 * helped (a same-task delta, never an absolute rate). Between them sits a hole:
 * a red task files a `process_miss` keyed `eval:<task_id>` and stops. Nothing
 * reads the failure and asks WHY. That is the only missing piece, and this is
 * it.
 *
 * The shape is deliberately NOT new. `toolcall_diagnosis.ts` (audit-log
 * evidence) and `health_diagnosis.ts` (infra evidence) already run
 * gather → diagnose → score → rank → ground, emit typed fixes each naming an
 * EXISTING apply gate, and apply nothing. This is the third sibling, over eval
 * evidence, and it reuses their taxonomy, their gate set, and their score shape
 * rather than minting parallel ones.
 *
 * THE TRAP THIS IS BUILT AROUND. The obvious version of this feature writes a
 * persona line for every failure — and that is exactly the hack
 * `propose_persona_tuning`'s own description warns against: persona tuning is
 * "the WEAKEST layer; it does not generalize", and a line reading "always
 * search first / don't make things up" does NOT fix a specialist that
 * fabricated over a 404, lacked a capability, or fumbled a tool's argument
 * shape. So the diagnosis prompt LEADS with layer attribution, and the ranking
 * is by LAYER first (`TYPE_RANK`) — a persona fix can never outrank a mechanical
 * one, because they are never compared on score at all. A loop that papers over
 * broken contracts with prompt text would be worse than no loop: it would make
 * the evals green while the system stayed broken, and it would do it
 * automatically. (The first version used a 0.6 confidence MULTIPLIER for this
 * and an adversarial audit broke it in minutes — a margin between two adjectives
 * the same untrusted model chose is not a guarantee. See §3.2 of the design doc.)
 *
 * IT APPLIES NOTHING. Every fix carries an `apply_via` naming a gate that
 * already exists, and the most this module does on its own is FILE a proposal —
 * of a `KATE_REVIEW_KINDS` kind, so it is born `pending_kate_review`, hidden
 * from the owner queue until Kate promotes it. Kate reviews, the owner decides,
 * the existing change-window machinery measures the result. No new apply
 * surface, no new merge path, no `PROTECTED_CODE_PATHS` exposure.
 *
 * ARMING, in the scored-week pattern kate_reflection established:
 *   - default (unset)             → dark, nothing runs.
 *   - HEARTH_EVAL_EVOLUTION=1     → diagnose + RECORD. Reports are logged and
 *                                   returned; nothing is filed. This is the
 *                                   soak: read what it WOULD have proposed.
 *   - +HEARTH_EVAL_EVOLUTION_FILE=1 → arm filing, through Kate's gate.
 *
 * Fail-open and fail-QUIET: an LLM outage, a garbled envelope, a missing trace,
 * or a low-confidence read all produce no fix and no proposal. A nightly suite
 * that cannot diagnose must still record its results — the eval run outranks
 * its own post-mortem.
 */
import type { Database } from 'bun:sqlite';
import { zodToJsonSchema } from 'zod-to-json-schema';
import type { LLMRouter } from './llm';
import type { ToolRegistry } from './tool_registry';
import type { SpecialistRegistry } from './specialist';
import type { ProposalsStore, ProposalKind } from './proposals';
import { assess_factual_grounding } from './fact_critic';
import { build_grounding_context, build_grounding_evidence } from './provenance';
import { EvalTracesStore, type EvalTrace } from '@memory/stores/eval_traces';
import type { GoldenTask } from './evals/golden_tasks';
// ONE definition of "the sanctioned apply gates" and of a fix's score shape,
// shared with the infra + tool-call diagnosers.
import { EXISTING_GATES, type ApplyVia, type FixScore } from './health_diagnosis';
import type { ToolFixType } from './toolcall_diagnosis';

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

export interface EvalCandidateFix {
  /** Reuses the tool-contract taxonomy — six real layers and one persona rung. */
  type: ToolFixType;
  title: string;
  detail: string;
  /** Tool name / persona file / module the fix touches, or ''. */
  target: string;
  apply_via: ApplyVia;
}

export interface EvalScoredFix extends EvalCandidateFix {
  score: FixScore;
}

export interface EvalDiagnosisReport {
  task_id: string;
  specialist_id: string;
  root_cause: string;
  /** 0..1 in the DIAGNOSIS itself (not in any one fix). */
  confidence: number;
  /** True when the evidence does not support a call. Nothing is filed. */
  inconclusive: boolean;
  fixes: EvalScoredFix[];
  /** Specifics the fact critic could not tie to the evidence, dropped. */
  ungrounded_dropped: string[];
}

export type CompleteRoleFn = (
  role: Parameters<LLMRouter['for_role']>[0],
  args: { system: string; user: string; temperature?: number; max_tokens?: number },
) => Promise<string | null>;

export interface EvalDiagnosisDeps {
  db: Database;
  tools: ToolRegistry;
  specialists: SpecialistRegistry;
  llm?: LLMRouter;
  proposals?: ProposalsStore;
  now?: Date;
  /** Smoke seams. */
  complete_role_fn?: CompleteRoleFn;
  verify_fn?: typeof assess_factual_grounding;
}

/* ------------------------------------------------------------------ */
/* Arming                                                              */
/* ------------------------------------------------------------------ */

export function eval_evolution_enabled(): boolean {
  return process.env.HEARTH_EVAL_EVOLUTION === '1';
}

/** Filing is a SEPARATE rung above diagnosing — soak the reports first. */
export function eval_evolution_filing_armed(): boolean {
  return eval_evolution_enabled() && process.env.HEARTH_EVAL_EVOLUTION_FILE === '1';
}

/**
 * Below this diagnosis confidence nothing is filed. A weak read on a flaky
 * task is how an automated proposer turns noise into owner-queue traffic, and
 * the queue is the scarce resource here — not the compute.
 */
export const MIN_FILE_CONFIDENCE = 0.5;

/** How many failing tasks one nightly pass will diagnose. The cap exists so a
 *  bad model swap that reddens 40 tasks files a handful of proposals, not 40. */
export const MAX_DIAGNOSES_PER_RUN = 3;

/* ------------------------------------------------------------------ */
/* 1. Evidence                                                         */
/* ------------------------------------------------------------------ */

export interface EvalEvidencePack {
  task_id: string;
  specialist_id: string;
  /** What the task asked. */
  message: string;
  /** What the task DEMANDED, rendered from its assertions. */
  expected: string[];
  /** What actually failed, verbatim from the harness. */
  failed_assertions: string[];
  reply: string;
  calls: EvalTrace['calls'];
  /** JSON schema of each tool the run called — the arg-shape evidence. */
  tool_schemas: Array<{ name: string; description: string; schema: string }>;
  /** Whether this task has failed repeatedly (a standing failure vs a flake). */
  recent_failures: number;
}

function render_expectations(task: GoldenTask): string[] {
  const a = task.assertions;
  const out: string[] = [];
  if (a.must_call?.length) out.push(`must call: ${a.must_call.join(', ')}`);
  if (a.min_calls) {
    for (const [t, n] of Object.entries(a.min_calls)) out.push(`must call ${t} at least ${n}x`);
  }
  if (a.args_valid?.length) out.push(`must produce VALID args for: ${a.args_valid.join(', ')}`);
  if (a.call_order?.length) out.push(`must call in order: ${a.call_order.join(' → ')}`);
  if (a.text_any?.length) out.push(`reply must contain one of: ${a.text_any.slice(0, 6).join(' | ')}`);
  if (a.text_none?.length) out.push(`reply must NOT contain: ${a.text_none.slice(0, 6).join(' | ')}`);
  return out;
}

export function gather_eval_evidence(
  task: GoldenTask,
  trace: EvalTrace,
  deps: Pick<EvalDiagnosisDeps, 'db' | 'tools'>,
): EvalEvidencePack {
  const called = [...new Set(trace.calls.map((c) => c.name))];
  const tool_schemas: EvalEvidencePack['tool_schemas'] = [];
  for (const name of called) {
    const tool = deps.tools.get(name);
    if (!tool) continue;
    let schema = '(unavailable)';
    try {
      schema = JSON.stringify(zodToJsonSchema(tool.input_schema)).slice(0, 1_200);
    } catch {
      /* an un-serializable schema is itself weak evidence; keep the placeholder */
    }
    tool_schemas.push({ name, description: tool.description.slice(0, 400), schema });
  }

  let recent_failures = 0;
  try {
    const row = deps.db
      .prepare(
        `SELECT COUNT(*) AS n FROM (
           SELECT passed FROM eval_runs WHERE task_id = @t ORDER BY ts DESC LIMIT 5
         ) WHERE passed = 0`,
      )
      .get({ '@t': task.id }) as { n: number } | undefined;
    recent_failures = row?.n ?? 0;
  } catch {
    /* history is context, not a precondition */
  }

  return {
    task_id: task.id,
    specialist_id: trace.specialist_id,
    message: task.message,
    expected: render_expectations(task),
    failed_assertions: trace.failed_assertions,
    reply: trace.reply,
    calls: trace.calls,
    tool_schemas,
    recent_failures,
  };
}

export function render_eval_evidence(pack: EvalEvidencePack): string {
  const lines: string[] = [];
  lines.push(`TASK: ${pack.task_id}  (specialist: ${pack.specialist_id})`);
  lines.push(`FAILED ${pack.recent_failures} of the last 5 runs.`);
  lines.push('');
  lines.push(`USER MESSAGE:\n${pack.message}`);
  lines.push('');
  lines.push(`WHAT THE TASK REQUIRED:\n${pack.expected.map((e) => `  - ${e}`).join('\n') || '  (none)'}`);
  lines.push('');
  lines.push(`WHAT FAILED (verbatim from the assertion harness):\n${pack.failed_assertions.map((f) => `  - ${f}`).join('\n')}`);
  lines.push('');
  lines.push(`THE SPECIALIST'S ACTUAL REPLY:\n${pack.reply.slice(0, 2_000) || '(empty)'}`);
  lines.push('');
  if (pack.calls.length === 0) {
    lines.push('TOOL CALLS: none were made.');
  } else {
    lines.push('TOOL CALLS (args are what the model actually produced):');
    for (const [i, c] of pack.calls.entries()) {
      let args = '(none)';
      try {
        args = JSON.stringify(c.input ?? {}).slice(0, 500);
      } catch {
        args = '(unserializable)';
      }
      lines.push(`  ${i + 1}. ${c.name}  args=${args}`);
      if (c.error) lines.push(`     ERROR: ${c.error}`);
      if (c.candidates?.length) lines.push(`     tool offered recovery hints: ${c.candidates.join('; ')}`);
      else if (c.error) lines.push(`     tool offered NO recovery hint (the model had nothing actionable to go on)`);
      if (c.result_preview) lines.push(`     result: ${c.result_preview.slice(0, 300)}`);
    }
  }
  if (pack.tool_schemas.length > 0) {
    lines.push('');
    lines.push('SCHEMAS OF THE TOOLS IT CALLED:');
    for (const t of pack.tool_schemas) {
      lines.push(`  ${t.name}: ${t.description}`);
      lines.push(`    input schema: ${t.schema}`);
    }
  }
  return lines.join('\n');
}

/* ------------------------------------------------------------------ */
/* 2. Diagnose                                                         */
/* ------------------------------------------------------------------ */

const DIAGNOSE_SYSTEM =
  'You are diagnosing why an automated behavioral test of an AI household assistant failed. ' +
  'You are given the exact user message, what the test required, which assertions failed, the ' +
  'assistant\'s real reply, and every tool call it made with the ARGUMENTS IT PRODUCED and any errors.\n\n' +
  'ATTRIBUTE THE FAILURE TO A LAYER BEFORE PROPOSING ANYTHING. In order of how often they are the ' +
  'real cause:\n' +
  '  1. TOOL CONTRACT — the model called the right tool and got the argument shape wrong, or the ' +
  'schema demands a field no model reliably produces. Look at the args against the schema. ' +
  'Fix types: rename_field, make_optional, add_alias, relax_contract.\n' +
  '  2. GROUNDING — a tool failed or returned nothing useful AND offered no actionable next step, ' +
  'so the model invented one. Fix type: grounding_fix (a recovery hint on the connector).\n' +
  '  3. MISSING REACH — the model wanted an ability that does not exist or it was not granted. ' +
  'Fix type: code_change or escalate.\n' +
  '  4. LOGIC — the runtime did the wrong thing regardless of prompt. Fix type: code_change.\n' +
  '  5. VOICE — the model did the right thing MECHANICALLY and said it the wrong way. ONLY THEN ' +
  'is the fix persona_tuning.\n\n' +
  'PERSONA TUNING IS THE WEAKEST LAYER AND IT DOES NOT GENERALIZE. A persona line like "always ' +
  'search before answering" or "do not make things up" will NOT fix a fabrication over a failed ' +
  'tool, a missing capability, or a broken argument contract — it only makes the test green while ' +
  'the system stays broken. If the failure is mechanical, say so and propose the mechanical fix, ' +
  'even if a prompt tweak would pass the assertion sooner.\n\n' +
  'GROUND EVERY SPECIFIC IN THE EVIDENCE. Do not name a field, tool, file, or error string that ' +
  'does not appear above. If the evidence does not support a confident call, set inconclusive ' +
  'true and say what evidence is missing — that is a useful answer, and a confident wrong one is not.\n\n' +
  'Reply with ONLY JSON:\n' +
  '{"root_cause":"<grounded explanation>","confidence":0.0-1.0,"inconclusive":false,' +
  '"fixes":[{"type":"rename_field|make_optional|add_alias|relax_contract|grounding_fix|persona_tuning|code_change|escalate",' +
  '"title":"<imperative>","detail":"<concretely what to do>","target":"<tool/field/file or empty>",' +
  '"apply_via":"restart_service|apply_low_risk_fix|propose_code_edit|propose_code_change|manual|escalate",' +
  '"likelihood_to_resolve":0.0-1.0,"risk":"low|medium|high","reversibility":"easy|moderate|hard",' +
  '"blast_radius":"contained|service|broad","rationale":"<why this score>"}]}';

function strip_fence(s: string): string {
  const m = s.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
  return (m ? m[1]! : s).trim();
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

const RISK_W = { low: 1, medium: 0.65, high: 0.35 } as const;
const REV_W = { easy: 1, moderate: 0.85, hard: 0.6 } as const;

/** Same deterministic composite the infra diagnoser uses — one ranking key. */
function composite(s: Pick<FixScore, 'likelihood_to_resolve' | 'risk' | 'reversibility'>): number {
  return clamp01(s.likelihood_to_resolve * RISK_W[s.risk] * REV_W[s.reversibility]);
}

/**
 * LAYER ORDER — the anti-hack guarantee (rewritten 2026-08-04 after an
 * adversarial audit broke the first attempt).
 *
 * The first version multiplied a persona fix's confidence by 0.6 and called
 * that "anti-hack pressure as arithmetic." It was not. A multiplier competes
 * with the risk/reversibility weights, and it LOST: a persona line rated
 * low-risk/easily-reversible (an honest rating for a prompt edit — it IS cheap
 * and reversible) scored 1.0 x 1 x 1 x 0.6 = 0.60, while a real mechanical fix
 * rated medium/moderate had a hard CEILING of 1.0 x 0.65 x 0.85 = 0.5525. Five
 * of the nine risk x reversibility cells could never outrank a maximally-rated
 * persona line at any likelihood — including `medium/moderate`, which is
 * `coerce_fix`'s own default when the model omits those fields. The original
 * smoke passed only because its fixture happened to rate the mechanical fix
 * low/easy, the one cell where the margin worked.
 *
 * A margin between two adjectives the same untrusted model chose is not a
 * guarantee. This is: **rank by LAYER first, confidence only within a layer.**
 * A persona fix can now never outrank a mechanical one, at any score, because
 * they are never compared on score at all. The sibling `toolcall_diagnosis.ts`
 * already had a TYPE_RANK tiebreak; dropping it here was the mistake.
 *
 * Order mirrors the diagnosis prompt's own attribution ladder: tool contract →
 * grounding → deeper code → escalate → voice.
 */
const TYPE_RANK: Record<ToolFixType, number> = {
  rename_field: 0,
  make_optional: 0,
  add_alias: 0,
  relax_contract: 0,
  grounding_fix: 1,
  code_change: 2,
  escalate: 3,
  // ALWAYS last. Not "discounted" — last.
  persona_tuning: 4,
};

/**
 * Paths whose edits ARE persona edits, whatever the model calls them.
 *
 * The audit's other route around the discount was labelling: a fix declaring
 * `type: 'code_change'` with `target: 'config/specialists/kate.yaml'` and a
 * detail reading "append this line to her persona" took no penalty at all and
 * filed as a `recommendation`, dodging both the layer order and the
 * persona_tuning proposal kind. The taxonomy was enforced on the model's
 * self-declared TYPE and nothing else.
 *
 * Re-typing on the TARGET is deterministic and checkable — no second LLM
 * round, no keyword guessing at the detail prose.
 */
const PERSONA_TARGET_RE = /config\/specialists\/|specialists\/[a-z_]+\.yaml|^[a-z_]+\.yaml$/i;

/** Normalize a self-declared type against what the fix actually touches. */
export function effective_fix_type(type: ToolFixType, target: string): ToolFixType {
  if (type === 'persona_tuning') return type;
  return PERSONA_TARGET_RE.test(target.trim()) ? 'persona_tuning' : type;
}

const VALID_TYPES: ReadonlySet<string> = new Set<ToolFixType>([
  'rename_field',
  'make_optional',
  'add_alias',
  'relax_contract',
  'grounding_fix',
  'persona_tuning',
  'code_change',
  'escalate',
]);

function coerce_fix(raw: Record<string, unknown>): EvalScoredFix | null {
  const type = String(raw.type ?? '');
  if (!VALID_TYPES.has(type)) return null;
  const apply_via_raw = String(raw.apply_via ?? '');
  // An unsanctioned gate is not silently rewritten into a real one — it falls
  // to `escalate`, which is the honest reading of "the model named a path we
  // do not have."
  const apply_via: ApplyVia = EXISTING_GATES.has(apply_via_raw as ApplyVia)
    ? (apply_via_raw as ApplyVia)
    : 'escalate';
  const title = String(raw.title ?? '').trim().slice(0, 200);
  const detail = String(raw.detail ?? '').trim().slice(0, 2_000);
  if (title.length < 3 || detail.length < 10) return null;

  const risk = (['low', 'medium', 'high'] as const).includes(raw.risk as never)
    ? (raw.risk as FixScore['risk'])
    : 'medium';
  const reversibility = (['easy', 'moderate', 'hard'] as const).includes(raw.reversibility as never)
    ? (raw.reversibility as FixScore['reversibility'])
    : 'moderate';
  const blast_radius = (['contained', 'service', 'broad'] as const).includes(raw.blast_radius as never)
    ? (raw.blast_radius as FixScore['blast_radius'])
    : 'service';
  const likelihood =
    typeof raw.likelihood_to_resolve === 'number' ? clamp01(raw.likelihood_to_resolve) : 0.4;

  const base = { likelihood_to_resolve: likelihood, risk, reversibility, blast_radius };
  const target = String(raw.target ?? '').slice(0, 200);
  // Re-type BEFORE anything downstream sees it, so the layer order, the
  // proposal kind, and the report all agree about what this fix really is.
  const effective = effective_fix_type(type as ToolFixType, target);
  return {
    type: effective,
    title,
    detail,
    target,
    apply_via,
    score: {
      ...base,
      // Confidence is now purely the merit composite. It no longer carries the
      // layer judgement — TYPE_RANK does, and it cannot be outbid.
      confidence: composite(base),
      rationale: String(raw.rationale ?? '').slice(0, 600) || 'No rationale given.',
    },
  };
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
        max_tokens: opts.max_tokens ?? 1_800,
        think: false,
        ...resolved.defaults,
      });
      return resp.content;
    } catch {
      return null;
    }
  };
}

/**
 * Diagnose ONE failing task. Applies nothing, files nothing — returns the
 * report. Null when there is no evidence to work from or the model is down.
 */
export async function diagnose_eval_failure(
  task: GoldenTask,
  deps: EvalDiagnosisDeps,
): Promise<EvalDiagnosisReport | null> {
  const traces = new EvalTracesStore(deps.db);
  const trace = traces.latest_for_task(task.id);
  if (!trace) return null;
  // A harness crash is infrastructure, not behavior. Diagnosing a broken temp
  // env as if it were a persona defect is exactly the false attribution this
  // module exists to avoid.
  if (trace.failed_assertions.some((f) => f.startsWith('harness error:'))) return null;

  const pack = gather_eval_evidence(task, trace, deps);
  const evidence = render_eval_evidence(pack);
  const complete = deps.complete_role_fn ?? default_complete(deps.llm);

  const content = await complete('research_extract', {
    system: DIAGNOSE_SYSTEM,
    user: `EVIDENCE:\n\n${evidence}\n\nReply with ONLY the JSON.`,
    temperature: 0.2,
    max_tokens: 1_800,
  });
  if (!content) return null;

  let parsed: {
    root_cause?: unknown;
    confidence?: unknown;
    inconclusive?: unknown;
    fixes?: Array<Record<string, unknown>>;
  };
  try {
    parsed = JSON.parse(strip_fence(content)) as typeof parsed;
  } catch {
    // A garbled envelope files NOTHING. Same contract as kate_reflection: a
    // proactive surface skips rather than acting on noise.
    return null;
  }

  const root_cause =
    typeof parsed.root_cause === 'string' && parsed.root_cause.trim().length > 2
      ? parsed.root_cause.trim().slice(0, 4_000)
      : '';
  if (!root_cause) return null;

  const fixes = (parsed.fixes ?? [])
    .map(coerce_fix)
    .filter((f): f is EvalScoredFix => f !== null)
    // Deterministic rank: LAYER first (a persona fix can never outrank a
    // mechanical one — see TYPE_RANK), then confidence within the layer, then
    // the cheaper-to-undo one.
    .sort((a, b) => {
      if (TYPE_RANK[a.type] !== TYPE_RANK[b.type]) return TYPE_RANK[a.type] - TYPE_RANK[b.type];
      if (b.score.confidence !== a.score.confidence) return b.score.confidence - a.score.confidence;
      return REV_W[b.score.reversibility] - REV_W[a.score.reversibility];
    });

  // Ground the narrative against the evidence and drop unsupported specifics —
  // the same fact-critic pass the other two diagnosers run, for the same
  // reason: a diagnosis that invents a field name reads exactly as confidently
  // as one that read it.
  let confidence =
    typeof parsed.confidence === 'number' ? clamp01(parsed.confidence) : 0.4;
  let ungrounded_dropped: string[] = [];
  const verify = deps.verify_fn ?? assess_factual_grounding;
  try {
    const assessment = await verify({
      reply: root_cause,
      grounding: build_grounding_context({ tool_results: [evidence] }),
      evidence_text: build_grounding_evidence({ tool_results: [evidence] }),
      llm: deps.llm,
    });
    ungrounded_dropped = assessment.unsupported.map((f) => f.claim).slice(0, 10);
    // Dropping specifics lowers confidence in the narrative that carried them.
    confidence = clamp01(confidence - Math.min(0.4, ungrounded_dropped.length * 0.15));
  } catch {
    /* fact critic unavailable → keep the model's own confidence, file nothing
     * extra. Fail-open: the grounding pass is a filter, not a gate. */
  }

  const inconclusive = parsed.inconclusive === true || fixes.length === 0 || confidence < 0.3;

  return {
    task_id: task.id,
    specialist_id: pack.specialist_id,
    root_cause,
    confidence,
    inconclusive,
    fixes,
    ungrounded_dropped,
  };
}

/* ------------------------------------------------------------------ */
/* 3. File (armed separately)                                          */
/* ------------------------------------------------------------------ */

/** Which existing proposal kind carries this fix. Both are KATE_REVIEW_KINDS,
 *  so either is born `pending_kate_review` — hidden from the owner until Kate
 *  promotes it. No new gate is introduced by this module. */
function kind_for(fix: EvalScoredFix): ProposalKind {
  return fix.type === 'persona_tuning' ? 'persona_tuning' : 'recommendation';
}

export function render_report_markdown(r: EvalDiagnosisReport): string {
  const out: string[] = [];
  out.push(
    `Golden eval \`${r.task_id}\` (${r.specialist_id}) is failing. Here is what the trace actually shows.`,
  );
  out.push('');
  out.push(`**Root cause** (confidence ${Math.round(r.confidence * 100)}%${r.inconclusive ? ', INCONCLUSIVE' : ''}):`);
  out.push(r.root_cause);
  if (r.fixes.length > 0) {
    out.push('');
    out.push('**Candidate fixes, ranked:**');
    for (const f of r.fixes.slice(0, 4)) {
      out.push(
        `- **${f.title}** (${f.type}${f.target ? ` · ${f.target}` : ''}) — ` +
          `${Math.round(f.score.confidence * 100)}% · ${f.score.risk} risk · apply via \`${f.apply_via}\``,
      );
      out.push(`  ${f.detail}`);
    }
  }
  if (r.ungrounded_dropped.length > 0) {
    out.push('');
    out.push(
      `_Dropped ${r.ungrounded_dropped.length} specific(s) the trace did not support._`,
    );
  }
  out.push('');
  out.push(
    '_Nothing has been applied. This was diagnosed from the failing eval trace; ' +
      'the fix above still goes through its named gate._',
  );
  return out.join('\n');
}

/**
 * File the top-ranked fix as a proposal. Returns the id, or null when nothing
 * was filed (and why is logged, not swallowed).
 *
 * Deduped on the category signature `(trainer, eval_evolution, <task id>)`.
 * The fix TYPE is deliberately NOT in the signature: it is the LLM's own
 * volatile label, and keying on it meant one stubbornly-red task could file a
 * separate proposal for every type the model happened to pick on a given night
 * (the audit counted up to 8). One task, one open proposal.
 */
export function file_eval_fix_proposal(
  report: EvalDiagnosisReport,
  deps: Pick<EvalDiagnosisDeps, 'proposals'>,
  log: (line: string) => void = () => {},
): string | null {
  if (!deps.proposals) return null;
  // The arming switch is checked HERE too, not only in the pass. A caller that
  // reaches this directly must not be able to file behind a dark flag.
  if (!eval_evolution_filing_armed()) {
    log(`[eval-evolution] ${report.task_id}: filing not armed — nothing filed`);
    return null;
  }
  if (report.inconclusive) {
    log(`[eval-evolution] ${report.task_id}: inconclusive — nothing filed`);
    return null;
  }
  if (report.confidence < MIN_FILE_CONFIDENCE) {
    log(
      `[eval-evolution] ${report.task_id}: confidence ${report.confidence.toFixed(2)} < ${MIN_FILE_CONFIDENCE} — nothing filed`,
    );
    return null;
  }
  const top = report.fixes[0];
  if (!top) return null;
  // Gate on the FIX's own merit as well as the diagnosis narrative's. The
  // first version checked only `report.confidence` — the model's self-reported
  // confidence in its own story — so a fix scoring 0.03 could still file as
  // long as the model sounded sure about the write-up.
  if (top.score.confidence < MIN_FILE_CONFIDENCE) {
    log(
      `[eval-evolution] ${report.task_id}: top fix scores ${top.score.confidence.toFixed(2)} < ` +
        `${MIN_FILE_CONFIDENCE} — nothing filed (the story was confident; the fix is not)`,
    );
    return null;
  }

  const signature = {
    specialist_id: 'trainer',
    kind: 'eval_evolution',
    category: 'fix',
    anchor: report.task_id,
  };
  if (deps.proposals.covered_for_signature(signature)) {
    log(`[eval-evolution] ${report.task_id}: covered by an open proposal (or one inside the re-file cooldown) — skipped`);
    return null;
  }

  const kind = kind_for(top);
  const id = deps.proposals.create({
    specialist_id: 'trainer',
    kind,
    execution_kind: 'manual',
    payload:
      kind === 'persona_tuning'
        ? {
            target_specialist_id: report.specialist_id,
            verbatim_feedback: `golden eval '${report.task_id}' is failing: ${report.root_cause.slice(0, 500)}`,
            diagnosis: 'silent-on-posture',
            proposed_change: top.detail,
          }
        : {
            source: 'eval_diagnosis',
            task_id: report.task_id,
            target_specialist_id: report.specialist_id,
            fix_type: top.type,
            target: top.target,
            apply_via: top.apply_via,
            detail: top.detail,
            confidence: top.score.confidence,
          },
    rationale: render_report_markdown(report),
    signature,
  });
  log(`[eval-evolution] ${report.task_id}: filed ${kind} ${id} (${top.type}, via ${top.apply_via})`);
  return id;
}

/* ------------------------------------------------------------------ */
/* 4. The pass                                                         */
/* ------------------------------------------------------------------ */

export interface EvalEvolutionOutcome {
  diagnosed: number;
  filed: string[];
  reports: EvalDiagnosisReport[];
}

/**
 * Run the post-eval diagnosis pass over this run's failures.
 *
 * `failing` is the run's failed task ids; `tasks` the live suite (to resolve
 * each id back to its definition). Ordered so the tasks failing most
 * consistently are diagnosed first — a standing failure is a real defect, a
 * one-off is more often a flake, and the per-run cap should be spent on the
 * former.
 */
export async function run_eval_evolution_pass(
  args: {
    failing: readonly string[];
    tasks: readonly GoldenTask[];
    log?: (line: string) => void;
  },
  deps: EvalDiagnosisDeps,
): Promise<EvalEvolutionOutcome> {
  const log = args.log ?? (() => {});
  const out: EvalEvolutionOutcome = { diagnosed: 0, filed: [], reports: [] };
  if (!eval_evolution_enabled()) return out;

  const by_id = new Map(args.tasks.map((t) => [t.id, t]));
  const traces = new EvalTracesStore(deps.db);

  // Drop tasks an open proposal already covers BEFORE ranking. Checking dedup
  // only at filing time meant a task with a standing proposal consumed one of
  // the three diagnosis slots every night — burning a real LLM call to
  // rediscover something already sitting in Kate's queue, and starving the
  // tasks nothing covers yet.
  const already_covered = (id: string): boolean => {
    if (!deps.proposals) return false;
    try {
      return deps.proposals.covered_for_signature({
        specialist_id: 'trainer',
        kind: 'eval_evolution',
        category: 'fix',
        anchor: id,
      });
    } catch {
      return false;
    }
  };

  const eligible = args.failing.filter((id) => {
    if (!already_covered(id)) return true;
    log(`[eval-evolution] ${id}: covered by an open proposal (or one filed in the last 14 days) — not re-diagnosed`);
    return false;
  });

  const ranked = eligible
    .map((id) => {
      let recent = 0;
      try {
        recent = traces.recent_for_task(id, 5).length;
      } catch {
        /* ordering hint only */
      }
      return { id, recent };
    })
    // Rotate the alphabetical tail. The first version's final tie-break was
    // `a.id < b.id`, so among equally-persistent tasks the same alphabetical
    // prefix won every night and everything after it was starved forever while
    // the log promised it was "left for the next run". Seeding the rotation on
    // the run's own failure count keeps it deterministic per run (no
    // Date.now/random — the workflow-resume rule) while moving the window.
    .sort((a, b) => b.recent - a.recent || (a.id < b.id ? -1 : 1));
  const offset = ranked.length > MAX_DIAGNOSES_PER_RUN ? args.failing.length % ranked.length : 0;
  const picked = [...ranked.slice(offset), ...ranked.slice(0, offset)].slice(0, MAX_DIAGNOSES_PER_RUN);

  if (eligible.length > picked.length) {
    // No silent caps: say what was left undiagnosed rather than letting the
    // log imply the whole failure set was looked at.
    log(
      `[eval-evolution] ${eligible.length} uncovered failing task(s); diagnosing ${picked.length} ` +
        `(rotation offset ${offset}), ${eligible.length - picked.length} left for the next run`,
    );
  }

  for (const { id } of ranked) {
    const task = by_id.get(id);
    if (!task) continue;
    let report: EvalDiagnosisReport | null = null;
    try {
      report = await diagnose_eval_failure(task, deps);
    } catch (err) {
      log(`[eval-evolution] ${id}: diagnosis threw — ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    if (!report) {
      log(`[eval-evolution] ${id}: no usable diagnosis (no trace, model down, or garbled) — skipped`);
      continue;
    }
    out.diagnosed++;
    out.reports.push(report);
    const top = report.fixes[0];
    log(
      `[eval-evolution] ${id}: ${report.inconclusive ? 'INCONCLUSIVE' : 'diagnosed'} ` +
        `(conf ${report.confidence.toFixed(2)})${top ? ` → ${top.type} via ${top.apply_via}` : ''}`,
    );

    if (!eval_evolution_filing_armed()) {
      // The soak rung: record what it WOULD have filed. Intended-vs-applied,
      // exactly as kate_reflection records intended vs applied dispositions.
      log(`[eval-evolution] ${id}: filing not armed (HEARTH_EVAL_EVOLUTION_FILE) — would have filed the above`);
      continue;
    }
    // Filing sits INSIDE the per-task guard. It used to be outside it, so a
    // throw from the proposals store on ONE task aborted the whole pass —
    // directly contradicting this module's fail-open, fail-quiet contract.
    try {
      const filed = file_eval_fix_proposal(report, deps, log);
      if (filed) out.filed.push(filed);
    } catch (err) {
      log(`[eval-evolution] ${id}: filing threw — ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return out;
}
