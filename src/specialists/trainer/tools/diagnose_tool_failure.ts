/**
 * diagnose_tool_failure — Beatrice's self-diagnosis tool for a recurring
 * tool-call / honesty miss (2026-06-22).
 *
 * The instant-feedback driver (guard_feedback.ts) files a process_miss + wakes
 * Beatrice when a tool-arg failure or an honesty-guard catch RECURS. This tool
 * is what she runs in that woken pass — the TOOL-CALL sibling of
 * diagnose_dependency. It does the diagnostic work a human did by hand on
 * 2026-06-22, all on the LOCAL deep model:
 *
 *   1. read the audit error text for the failing tool + the (PROVIDED vs
 *      REQUIRED) field-mismatch extraction;
 *   2. read the tool's actual schema (required/optional/aliases/patterns);
 *   3. PROBE the live interactive endpoint to localize blame (endpoint vs schema);
 *   4. diagnose the ROOT CAUSE grounded ONLY in that evidence + emit typed,
 *      adversarially-scored candidate fixes.
 *
 * It then files an owner recommendation with the scored options and cites the
 * open guard-feedback miss. It NEVER applies a fix — every fix carries an
 * `apply_via` naming an EXISTING gate (propose_code_edit / propose_code_change /
 * apply_low_risk_fix / escalate), and the `next_action` steers Beatrice to ship
 * the top fix THROUGH her change pipeline (Kate review → owner merge).
 *
 * Fail-open + kill-switched (HEARTH_TOOLCALL_DIAGNOSIS=0). On Beatrice's
 * deliberation surface — she's already woken by the guard-feedback scoped task.
 */
import { z } from 'zod';
import { ulid } from 'ulid';
import type { Tool, ToolContext } from '@core/tool';
import type { ToolDeps } from '@core/tool_deps';
import type { MemoryClient } from '@memory/client';
import type { ProposalsStore } from '@core/proposals';
import type { ProcessMissStore } from '@core/process_misses';
import type { ToolRegistry } from '@core/tool_registry';
import {
  run_toolcall_diagnosis,
  render_toolcall_diagnosis_markdown,
  toolcall_diagnosis_enabled,
  recommend_floor,
  type DiagnosisTarget,
  type ScoredFix,
  type ToolcallDiagnosisDeps,
} from '@core/toolcall_diagnosis';

const InputSchema = z.object({
  subject: z
    .string()
    .min(2)
    .describe(
      "The failing tool name (e.g. 'read_note', 'edgar_read_filing'), OR the miss " +
        "evidence_ref verbatim from the guard-feedback process_miss " +
        "('arg-mismatch:read_note', 'arg-mismatch:edgar_read_filing:filing_url', or " +
        "'honesty:fabricated_save_guard:kate').",
    ),
  role: z
    .string()
    .optional()
    .describe(
      "Which interactive role's endpoint to probe — default 'specialist' (chat). " +
        "Use 'specialist_deliberation' for a deliberation-time failure.",
    ),
});

const RecommendedFixSchema = z
  .object({
    type: z.string(),
    title: z.string(),
    apply_via: z.string(),
    confidence: z.number(),
    target: z.string(),
  })
  .nullable();

const OutputSchema = z.object({
  ok: z.boolean(),
  enabled: z.boolean(),
  subject: z.string(),
  kind: z.string(),
  root_cause: z.string(),
  inconclusive: z.boolean(),
  confidence: z.number(),
  probe_summary: z.string().nullable(),
  fix_count: z.number(),
  recommended_fix: RecommendedFixSchema,
  proposal_id: z.string().nullable(),
  cited_miss_ids: z.array(z.string()),
  next_action: z.string(),
  refused: z.boolean(),
  refused_reason: z.string().nullable(),
});

type Input = z.infer<typeof InputSchema>;
type Output = z.infer<typeof OutputSchema>;

export interface DiagnoseToolFailureDeps {
  db: import('bun:sqlite').Database;
  memory: MemoryClient;
  proposals: ProposalsStore;
  tools: ToolRegistry;
  process_misses?: ProcessMissStore;
  /** Smoke seams — forwarded to the engine; default to real paths. */
  complete_role_fn?: ToolcallDiagnosisDeps['complete_role_fn'];
  verify_fn?: ToolcallDiagnosisDeps['verify_fn'];
  probe_fn?: ToolcallDiagnosisDeps['probe_fn'];
}

/** Resolve a guard-feedback evidence_ref OR a bare tool name into a target. */
export function parse_subject(subject: string, role?: string): { target: DiagnosisTarget; evidence_ref: string } {
  const s = subject.trim();
  const role_part = role ? { role } : {};
  if (s.startsWith('arg-mismatch:')) {
    const rest = s.slice('arg-mismatch:'.length);
    // `arg-mismatch:<tool>` or `arg-mismatch:<tool>:<field>` — the field only
    // scopes the evidence_ref (the engine derives provided-vs-required from the
    // schema), so we keep it on the ref but target the tool.
    const tool = rest.split(':')[0] ?? rest;
    return { target: { tool, ...role_part }, evidence_ref: s };
  }
  if (s.startsWith('honesty:')) {
    const parts = s.split(':');
    const guard = parts[1] ?? 'fabricated_save_guard';
    const specialist_id = parts[2] ?? '';
    return { target: { guard, specialist_id, ...role_part }, evidence_ref: s };
  }
  // Bare tool name.
  return { target: { tool: s, ...role_part }, evidence_ref: `arg-mismatch:${s}` };
}

function compact_fix(f: ScoredFix): Record<string, unknown> {
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

export function make_diagnose_tool_failure(deps: DiagnoseToolFailureDeps): Tool<Input, Output> {
  return {
    name: 'diagnose_tool_failure',
    description:
      'Diagnose WHY a tool keeps failing argument validation (or why a specialist ' +
      'keeps tripping an honesty guard), on the LOCAL deep model. Reads the audit ' +
      'error strings + the PROVIDED-vs-REQUIRED field mismatch, the tool schema ' +
      '(required/optional/aliases/patterns), and PROBES the live interactive ' +
      'endpoint to localize blame (endpoint vs schema), then the deep model ' +
      'produces a root cause grounded ONLY in that evidence and emits typed ' +
      'candidate fixes (rename_field / make_optional / add_alias / relax_contract / ' +
      'grounding_fix / code_change / escalate) each adversarially scored and ranked. ' +
      'Files an owner recommendation with the scored options. Call it FIRST when ' +
      'the guard-feedback flag names a recurring tool-arg / honesty miss — BEFORE ' +
      'authoring a fix — then ship the recommended fix through your change pipeline ' +
      '(propose_code_edit → Kate review → owner merge) per the returned next_action. ' +
      'It NEVER applies a fix itself. Pass the failing tool name or the miss ' +
      'evidence_ref as `subject`.',
    risk: 'write_internal',
    required_capabilities: ['diagnose_toolcalls', 'write_proposals'],
    input_schema: InputSchema,
    output_schema: OutputSchema,
    volatile: true,

    idempotency_key(input) {
      return `diagnose_tool_failure:${input.subject}:${Math.floor(Date.now() / 60_000)}`;
    },

    async execute(input, ctx: ToolContext): Promise<Output> {
      const refuse = (reason: string, next: string): Output => ({
        ok: false,
        enabled: true,
        subject: input.subject,
        kind: 'unknown',
        root_cause: '',
        inconclusive: true,
        confidence: 0,
        probe_summary: null,
        fix_count: 0,
        recommended_fix: null,
        proposal_id: null,
        cited_miss_ids: [],
        next_action: next,
        refused: true,
        refused_reason: reason,
      });

      if (!toolcall_diagnosis_enabled()) {
        return {
          ...refuse('', 'HEARTH_TOOLCALL_DIAGNOSIS=0 — tool-call self-diagnosis is disabled.'),
          enabled: false,
          refused: false,
        };
      }

      const { target, evidence_ref } = parse_subject(input.subject, input.role);

      // A bare/arg subject naming an unknown tool → recovery hint, don't fabricate.
      if (target.tool && !deps.tools.has(target.tool)) {
        const known = deps.tools
          .list()
          .map((t) => t.name)
          .filter((n) => n.includes(target.tool!.slice(0, 4)) || target.tool!.includes(n.slice(0, 4)))
          .slice(0, 8);
        return refuse(
          `No registered tool named "${target.tool}".`,
          `"${target.tool}" isn't a registered tool. Did you mean: ${known.join(', ') || '(no close matches)'}? ` +
            `Pass the exact tool name or the miss evidence_ref.`,
        );
      }

      // ── run the engine (gather → probe → diagnose → score → rank), fail-open ──
      const engine: ToolcallDiagnosisDeps = {
        db: deps.db,
        tools: deps.tools,
        ...(ctx.llm ? { llm: ctx.llm } : {}),
        ...(ctx.now ? { now: ctx.now } : {}),
        ...(deps.complete_role_fn ? { complete_role_fn: deps.complete_role_fn } : {}),
        ...(deps.verify_fn ? { verify_fn: deps.verify_fn } : {}),
        ...(deps.probe_fn ? { probe_fn: deps.probe_fn } : {}),
      };
      const diag = await run_toolcall_diagnosis(engine, target);
      const md = render_toolcall_diagnosis_markdown(diag);
      const rec = diag.recommended_index >= 0 ? diag.fixes[diag.recommended_index] ?? null : null;
      const rec_weak = !rec || rec.type === 'escalate' || rec.score.confidence < recommend_floor();
      const conf_pct = Math.round((rec?.score.confidence ?? 0) * 100);

      // ── cite the open guard-feedback miss for this evidence_ref ──
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

      const label = target.tool ? `tool \`${target.tool}\`` : `${target.guard} on ${target.specialist_id}`;
      const headline = `${label} keeps failing — ${rec ? rec.title : 'needs attention'}`;
      const summary =
        `Diagnosed the recurring failure on ${label}. ` +
        (diag.inconclusive ? 'Root cause inconclusive. ' : '') +
        `${diag.fixes.length} fix(es) scored; recommended: ${rec ? `${rec.title} (${conf_pct}%)` : 'escalate'}.`;
      const rationale =
        `A recurring tool-call/honesty miss on ${label} crossed the escalation threshold. I diagnosed it ` +
        `locally — read the audit error text, the provided-vs-required mismatch, the schema, and probed the ` +
        `live endpoint. ${first_sentence(diag.root_cause)} ` +
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
          skip_kate_review: true, // the scored-options CARD is informational; the actual fix re-enters her review gate
          payload: {
            headline,
            slug: `toolcall-diagnosis-${(target.tool ?? target.guard ?? 'subject').replace(/[^a-z0-9]+/gi, '-')}`,
            summary,
            subject: diag.subject,
            kind: diag.kind,
            inconclusive: diag.inconclusive,
            confidence: diag.confidence,
            probe_summary: diag.evidence.probe?.summary ?? null,
            recommended_fix: rec ? compact_fix(rec) : null,
            fixes: diag.fixes.map(compact_fix),
            diagnosis_md: md,
            cited_miss_ids,
          },
          rationale,
          signature: {
            specialist_id: ctx.specialist_id ?? 'trainer',
            kind: 'toolcall_diagnosis',
            category: 'tool',
            anchor: target.tool ?? evidence_ref,
          },
        });
      } catch {
        /* fail-open — the diagnosis is returned even if the proposal fails */
      }

      // ── steer Beatrice to the recommended fix's EXISTING gate ──
      let next_action: string;
      if (rec_weak) {
        next_action =
          `Diagnosis filed (proposal ${proposal_id ?? 'n/a'}). No high-confidence auto-fix — leave it for Jasper; ` +
          `the proposal carries the scored options. Don't author a fix you can't ground in the evidence.`;
      } else if (rec!.type === 'rename_field' || rec!.type === 'make_optional' || rec!.type === 'add_alias' || rec!.type === 'relax_contract') {
        next_action =
          `Recommended fix is a SCHEMA/CONTRACT change ("${rec!.title}", ${conf_pct}% confidence) on \`${rec!.target || target.tool}\`. ` +
          `Author it with \`propose_code_edit\` per the diagnosis detail — small surgical edits to the tool's input_schema ` +
          `(or the central FIELD_ALIASES for add_alias) — through the normal Kate-review + owner-merge gate. Extend ` +
          `smoke:tool-contracts to lock the new contract.`;
      } else if (rec!.type === 'grounding_fix') {
        next_action =
          `Recommended fix is a GROUNDING/connector change ("${rec!.title}"). If it's a bare-error connector, ` +
          `\`propose_connector_recovery_hint\`; otherwise \`propose_code_edit\` per the detail. Kate-review + owner-merge.`;
      } else {
        next_action =
          `Recommended fix is "${rec!.title}" (${rec!.type}). Author it with \`propose_code_edit\` (or ` +
          `\`propose_code_change\` for a new file) through the normal gate. Proposal: ${proposal_id ?? 'n/a'}.`;
      }

      deps.memory.log_action({
        intent_id: ctx.intent_id,
        agent: ctx.specialist_id ?? 'trainer',
        tool_name: 'diagnose_tool_failure',
        tool_input: { subject: input.subject },
        execution_result: {
          subject: diag.subject,
          kind: diag.kind,
          proposal_id,
          inconclusive: diag.inconclusive,
          confidence: diag.confidence,
          fix_count: diag.fixes.length,
          probe_all_valid: diag.evidence.probe?.all_valid ?? null,
          recommended: rec ? { type: rec.type, apply_via: rec.apply_via, confidence: rec.score.confidence } : null,
          ungrounded_dropped: diag.ungrounded_dropped.length,
          cited_miss_ids,
        },
      });

      return {
        ok: true,
        enabled: true,
        subject: diag.subject,
        kind: diag.kind,
        root_cause: diag.root_cause,
        inconclusive: diag.inconclusive,
        confidence: diag.confidence,
        probe_summary: diag.evidence.probe?.summary ?? null,
        fix_count: diag.fixes.length,
        recommended_fix: rec
          ? {
              type: rec.type,
              title: rec.title,
              apply_via: rec.apply_via,
              confidence: rec.score.confidence,
              target: rec.target,
            }
          : null,
        proposal_id,
        cited_miss_ids,
        next_action,
        refused: false,
        refused_reason: null,
      };
    },
  };
}

/** ToolLoader entry point. */
export function create(deps: ToolDeps): Tool {
  return make_diagnose_tool_failure({
    db: deps.db,
    memory: deps.memory,
    proposals: deps.proposals,
    tools: deps.tool_registry,
    ...(deps.process_misses ? { process_misses: deps.process_misses } : {}),
  }) as Tool;
}
