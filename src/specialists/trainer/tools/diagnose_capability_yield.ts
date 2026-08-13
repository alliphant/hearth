/**
 * diagnose_capability_yield — Beatrice's diagnosis for a capability that runs
 * clean and writes nothing (2026-08-01).
 *
 * The third member of the diagnosis family (`diagnose_dependency` for infra,
 * `diagnose_tool_failure` for tool contracts) and structurally identical to
 * both: the guard-feedback driver files a miss + wakes her, she runs this
 * FIRST, it assembles an evidence pack, the local deep model grounds a root
 * cause in only that pack, typed fixes are adversarially scored and ranked, an
 * owner recommendation is filed with the options, and it APPLIES NOTHING —
 * every fix names an EXISTING gate and `next_action` steers her through the
 * unchanged change pipeline (propose_code_edit → Kate review → owner merge).
 *
 * The one thing that differs is the evidence, because for this class there is
 * no error to read: the diagnostic artifact is the considered-vs-produced run
 * series, which is what separates "input arrives and is dropped" from "input
 * never arrives" — two causes that look identical from outside and have
 * completely different fixes.
 *
 * Fail-open + kill-switched (HEARTH_YIELD_DIAGNOSIS=0). On Beatrice's
 * deliberation surface — she is already woken there by the scoped task.
 */
import { z } from 'zod';
import type { Tool, ToolContext } from '@core/tool';
import type { ToolDeps } from '@core/tool_deps';
import type { MemoryClient } from '@memory/client';
import type { ProposalsStore } from '@core/proposals';
import type { ProcessMissStore } from '@core/process_misses';
import type { ToolRegistry } from '@core/tool_registry';
import { yield_evidence_ref } from '@core/capability_yield';
import {
  run_yield_diagnosis,
  render_yield_diagnosis_markdown,
  yield_diagnosis_enabled,
  yield_recommend_floor,
  type YieldDiagnosisDeps,
  type YieldScoredFix,
} from '@core/yield_diagnosis';

const InputSchema = z.object({
  /** The barren capability — a bare tool name, or the miss evidence_ref
   *  (`yield:<tool>`). Both resolve to the same target. */
  subject: z
    .string()
    .min(1)
    .describe(
      'The capability producing nothing — its tool name (e.g. "extract_meeting_votes") ' +
        'or the miss evidence_ref ("yield:extract_meeting_votes").',
    ),
});

const OutputSchema = z.object({
  ok: z.boolean(),
  enabled: z.boolean(),
  subject: z.string(),
  verdict: z.string(),
  root_cause: z.string(),
  inconclusive: z.boolean(),
  confidence: z.number(),
  /** The considered-vs-produced headline — the diagnostic one-liner. */
  yield_summary: z.string(),
  fix_count: z.number(),
  recommended_fix: z.record(z.unknown()).nullable(),
  proposal_id: z.string().nullable(),
  cited_miss_ids: z.array(z.string()),
  next_action: z.string(),
  refused: z.boolean().optional(),
  refused_reason: z.string().optional(),
  /** Recovery hint when the subject names no registered tool. */
  candidates: z.array(z.string()).optional(),
});

type Input = z.infer<typeof InputSchema>;
type Output = z.infer<typeof OutputSchema>;

export interface DiagnoseCapabilityYieldDeps {
  db: import('bun:sqlite').Database;
  memory: MemoryClient;
  proposals: ProposalsStore;
  tools: ToolRegistry;
  specialists?: YieldDiagnosisDeps['specialists'];
  process_misses?: ProcessMissStore;
  /** Smoke seams — forwarded to the engine; default to the real paths. */
  complete_role_fn?: YieldDiagnosisDeps['complete_role_fn'];
  verify_fn?: YieldDiagnosisDeps['verify_fn'];
}

/**
 * Resolve a `capability:yield:<tool>` evidence_ref OR a bare tool name to the
 * tool. The short `yield:<tool>` form is accepted too — the model will type it,
 * and refusing a near-miss it can't distinguish just burns a round.
 */
export function parse_yield_subject(subject: string): { tool: string; evidence_ref: string } {
  const s = subject.trim();
  if (s.startsWith('capability:yield:')) {
    return { tool: s.slice('capability:yield:'.length), evidence_ref: s };
  }
  if (s.startsWith('yield:')) {
    const tool = s.slice('yield:'.length);
    return { tool, evidence_ref: yield_evidence_ref(tool) };
  }
  return { tool: s, evidence_ref: yield_evidence_ref(s) };
}

function compact_fix(f: YieldScoredFix): Record<string, unknown> {
  return {
    type: f.type,
    title: f.title,
    apply_via: f.apply_via,
    target: f.target,
    confidence: f.score.confidence,
    risk: f.score.risk,
    reversibility: f.score.reversibility,
    blast_radius: f.score.blast_radius,
  };
}

function first_sentence(s: string): string {
  const m = s.match(/^.*?[.!?](\s|$)/);
  return (m ? m[0] : s).trim().slice(0, 300);
}

export function make_diagnose_capability_yield(
  deps: DiagnoseCapabilityYieldDeps,
): Tool<Input, Output> {
  return {
    name: 'diagnose_capability_yield',
    description:
      'Diagnose WHY a capability runs successfully and produces no output — the ' +
      'failure class with no error to read. Assembles the run series, the ' +
      'considered-vs-produced trend (which separates "input arrives and is dropped" ' +
      'from "input never arrives"), the job schedule and the tool contract, then the ' +
      'LOCAL deep model produces a root cause grounded ONLY in that evidence and ' +
      'emits typed candidate fixes (stale_source / wrong_target / broken_filter / ' +
      'contract_drift / retire_capability / code_change / escalate), each ' +
      'adversarially scored and ranked. Files an owner recommendation with the ' +
      'scored options. Call it FIRST when a flag names a barren capability — BEFORE ' +
      'authoring a fix — then ship the recommended fix through your change pipeline ' +
      '(propose_code_edit → Kate review → owner merge) per the returned next_action. ' +
      'It NEVER applies a fix itself. Pass the tool name or the miss evidence_ref.',
    risk: 'write_internal',
    required_capabilities: ['diagnose_capability_yield', 'write_proposals'],
    input_schema: InputSchema,
    output_schema: OutputSchema,
    volatile: true,
    // Its yield is the diagnosis it files. Reporting-only: it runs on demand
    // from a woken pass, not on a schedule, so there is no "work available"
    // count to compare against — and an armed contract without one is inert
    // anyway (see Tool.yield's `considered` note).
    yield: { produced: ['fix_count'], armed: false },

    idempotency_key(input) {
      return `diagnose_capability_yield:${input.subject}:${Math.floor(Date.now() / 60_000)}`;
    },

    async execute(input, ctx: ToolContext): Promise<Output> {
      const base = {
        subject: input.subject,
        verdict: 'unknown',
        root_cause: '',
        inconclusive: true,
        confidence: 0,
        yield_summary: '',
        fix_count: 0,
        recommended_fix: null,
        proposal_id: null,
        cited_miss_ids: [] as string[],
      };

      if (!yield_diagnosis_enabled()) {
        return {
          ...base,
          ok: false,
          enabled: false,
          next_action: 'HEARTH_YIELD_DIAGNOSIS=0 — zero-output diagnosis is disabled.',
        };
      }

      const { tool, evidence_ref } = parse_yield_subject(input.subject);

      // Unknown tool → return CANDIDATES rather than diagnosing thin air (the
      // connector-affordance pattern: an error that ships a recovery path).
      if (!deps.tools.has(tool)) {
        const stem = tool.slice(0, 4);
        const candidates = deps.tools
          .list()
          .map((t) => t.name)
          .filter((n) => n.includes(stem) || tool.includes(n.slice(0, 4)))
          .slice(0, 8);
        return {
          ...base,
          ok: false,
          enabled: true,
          refused: true,
          refused_reason: `No registered tool named "${tool}".`,
          candidates,
          next_action:
            `"${tool}" isn't a registered tool. Did you mean: ${candidates.join(', ') || '(no close matches)'}? ` +
            `Pass the exact tool name or the miss evidence_ref.`,
        };
      }

      const engine: YieldDiagnosisDeps = {
        db: deps.db,
        tools: deps.tools,
        ...(deps.specialists ? { specialists: deps.specialists } : {}),
        ...(ctx.llm ? { llm: ctx.llm } : {}),
        ...(deps.complete_role_fn ? { complete_role_fn: deps.complete_role_fn } : {}),
        ...(deps.verify_fn ? { verify_fn: deps.verify_fn } : {}),
      };
      const diag = await run_yield_diagnosis(engine, tool);
      const md = render_yield_diagnosis_markdown(diag);
      const rec = diag.recommended_index >= 0 ? diag.fixes[diag.recommended_index] ?? null : null;
      const rec_weak = !rec || rec.type === 'escalate' || rec.score.confidence < yield_recommend_floor();
      const conf_pct = Math.round((rec?.score.confidence ?? 0) * 100);

      // Cite the open guard-feedback miss for this evidence_ref.
      const cited_miss_ids: string[] = [];
      if (deps.process_misses) {
        try {
          for (const m of deps.process_misses.list({ open_only: true })) {
            if (m.evidence_ref === evidence_ref) cited_miss_ids.push(m.id);
          }
        } catch {
          /* fail-open */
        }
      }

      const headline = `\`${tool}\` produces nothing — ${rec ? rec.title : 'needs attention'}`;
      const summary =
        `Diagnosed the zero-output capability \`${tool}\`. ` +
        (diag.inconclusive ? 'Root cause inconclusive. ' : '') +
        `${diag.fixes.length} fix(es) scored; recommended: ${rec ? `${rec.title} (${conf_pct}%)` : 'escalate'}.`;
      const rationale =
        `\`${tool}\` has been running successfully and writing nothing — the class no error-rate ` +
        `detector can see. ${diag.evidence.assessment.summary} I diagnosed it locally from the run ` +
        `series, the considered-vs-produced trend, the job schedule and the tool contract. ` +
        `${first_sentence(diag.root_cause)} ` +
        (rec && !rec_weak
          ? `My top fix is "${rec.title}" (${conf_pct}% confidence, ${rec.score.risk} risk), applied via \`${rec.apply_via}\`. `
          : `I couldn't land a confident fix automatically, so this is yours to call. `) +
        `${diag.fixes.length} option(s) are scored below${cited_miss_ids.length ? `; closes ${cited_miss_ids.length} open miss(es).` : '.'}`;

      let proposal_id: string | null = null;
      try {
        proposal_id = deps.proposals.create({
          specialist_id: ctx.specialist_id ?? 'trainer',
          kind: 'recommendation',
          execution_kind: 'manual',
          // Informational scored-options card; the actual fix re-enters Kate's
          // review gate through the change pipeline.
          skip_kate_review: true,
          payload: {
            headline,
            slug: `yield-diagnosis-${tool.replace(/[^a-z0-9]+/gi, '-')}`,
            summary,
            subject: diag.subject,
            verdict: diag.evidence.assessment.verdict,
            yield_summary: diag.evidence.assessment.summary,
            total_considered: diag.evidence.assessment.total_considered,
            total_produced: diag.evidence.assessment.total_produced,
            inconclusive: diag.inconclusive,
            confidence: diag.confidence,
            recommended_fix: rec ? compact_fix(rec) : null,
            fixes: diag.fixes.map(compact_fix),
            diagnosis_md: md,
            cited_miss_ids,
          },
          rationale,
          signature: {
            specialist_id: ctx.specialist_id ?? 'trainer',
            kind: 'yield_diagnosis',
            category: 'capability',
            anchor: tool,
          },
        });
      } catch {
        /* fail-open — the diagnosis is returned even if the proposal fails */
      }

      let next_action: string;
      if (rec_weak) {
        next_action =
          `Diagnosis filed (proposal ${proposal_id ?? 'n/a'}). No high-confidence auto-fix — leave it for Jasper; ` +
          `the proposal carries the scored options. Don't author a fix you can't ground in the run series.`;
      } else if (rec!.type === 'retire_capability') {
        next_action =
          `Recommended verdict is to RETIRE \`${tool}\` ("${rec!.title}", ${conf_pct}% confidence) — it has no ` +
          `remaining purpose, and a job that cannot produce reads as coverage it isn't providing. Author the ` +
          `removal with \`propose_code_edit\` (drop the background_jobs entry, then the tool if nothing else ` +
          `calls it) through the normal Kate-review + owner-merge gate. Say plainly in the PR that this is a ` +
          `removal, not a fix.`;
      } else if (rec!.type === 'stale_source' || rec!.type === 'wrong_target') {
        next_action =
          `Recommended fix repoints what \`${tool}\` READS ("${rec!.title}", ${conf_pct}% confidence) on ` +
          `\`${rec!.target || tool}\`. Author it with \`propose_code_edit\` per the diagnosis detail. If the ` +
          `current path is a relevance-ranked search standing in for a recency question, walk the source's own ` +
          `list/feed/API instead and follow its links — a search returns what it indexed, not what is latest. ` +
          `Add a smoke pinned to the real failing case so it can't regress silently.`;
      } else {
        next_action =
          `Recommended fix is "${rec!.title}" (${rec!.type}, ${conf_pct}% confidence). Author it with ` +
          `\`propose_code_edit\` (or \`propose_code_change\` for a new file) through the normal Kate-review + ` +
          `owner-merge gate, and add a smoke asserting rows actually come out. Proposal: ${proposal_id ?? 'n/a'}.`;
      }

      deps.memory.log_action({
        intent_id: ctx.intent_id,
        agent: ctx.specialist_id ?? 'trainer',
        tool_name: 'diagnose_capability_yield',
        tool_input: { subject: input.subject, tool },
        execution_result: {
          verdict: diag.evidence.assessment.verdict,
          inconclusive: diag.inconclusive,
          confidence: diag.confidence,
          fix_count: diag.fixes.length,
          recommended: rec ? rec.type : null,
          proposal_id,
          cited_miss_ids,
        },
      });

      return {
        ok: true,
        enabled: true,
        subject: input.subject,
        verdict: diag.evidence.assessment.verdict,
        root_cause: diag.root_cause,
        inconclusive: diag.inconclusive,
        confidence: diag.confidence,
        yield_summary: diag.evidence.assessment.summary,
        fix_count: diag.fixes.length,
        recommended_fix: rec ? compact_fix(rec) : null,
        proposal_id,
        cited_miss_ids,
        next_action,
      };
    },
  };
}

export function create(deps: ToolDeps): Tool {
  return make_diagnose_capability_yield({
    db: deps.db,
    memory: deps.memory,
    proposals: deps.proposals,
    tools: deps.tool_registry,
    ...(deps.specialists ? { specialists: deps.specialists as YieldDiagnosisDeps['specialists'] } : {}),
    ...(deps.process_misses ? { process_misses: deps.process_misses } : {}),
  }) as Tool;
}
