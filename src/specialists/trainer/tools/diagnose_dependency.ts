/**
 * diagnose_dependency — Beatrice's self-diagnosis tool (2026-06-20).
 *
 * The closed-loop deepening of the system-health feature. Kate's scan DETECTS a
 * down dependency and flags Beatrice ("Firecrawl down, 98% failing") — but that
 * escalation is shallow. This tool does the diagnostic work a human does by
 * hand, all on the LOCAL deep model:
 *
 *   1. gather the evidence (the actual error strings from the audit log, the
 *      probe detail, the resolved config, AND the failing service's container
 *      logs via the read-only ops-relay /logs);
 *   2. ask the local deep model for a ROOT CAUSE grounded ONLY in that evidence
 *      (the shared fact critic drops any specific the evidence doesn't support);
 *   3. emit N typed candidate fixes (restart / config_change / code_change /
 *      escalate), each scored adversarially by a second deep pass on
 *      likelihood / risk / reversibility / blast-radius and ranked.
 *
 * It then PERSISTS the diagnosis + scored fixes (HealthDiagnosisStore) and FILES
 * an owner-facing recommendation proposal so Jasper sees a diagnosed incident
 * with ranked, scored fix options as a decision. It NEVER applies a fix itself —
 * every fix carries an `apply_via` naming an EXISTING gate (restart_service /
 * apply_low_risk_fix / propose_code_edit / propose_code_change / escalate), and
 * the `next_action` steers Beatrice to apply the top one through that gate (a
 * high-confidence restart is the only auto-applyable class — via the existing,
 * circuit-broken restart_service). There is no new privileged apply surface.
 *
 * Fail-open + kill-switched (HEARTH_HEALTH_DIAGNOSIS=0). Wired as a Beatrice
 * deliberation tool — she's already woken by Kate's health flag.
 */
import { z } from 'zod';
import { ulid } from 'ulid';
import type { Tool, ToolContext } from '@core/tool';
import type { ToolDeps } from '@core/tool_deps';
import type { MemoryClient } from '@memory/client';
import type { ProposalsStore } from '@core/proposals';
import type { ProcessMissStore } from '@core/process_misses';
import { DEPENDENCIES } from '@core/system_health';
import {
  run_diagnosis,
  render_diagnosis_markdown,
  health_diagnosis_enabled,
  recommend_floor,
  type DiagnosisEngineDeps,
  type ScoredFix,
} from '@core/health_diagnosis';
import { HealthDiagnosisStore } from '@memory/stores/health_diagnoses';
import { push_text } from '@policy/push';

const InputSchema = z.object({
  dependency: z
    .string()
    .min(2)
    .describe(
      "The dependency to diagnose, as named in the health incident / Kate's flag " +
        "(e.g. 'firecrawl', 'searxng', 'embeddings', 'home_assistant').",
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
  dependency: z.string(),
  diagnosis_id: z.string().nullable(),
  root_cause: z.string(),
  inconclusive: z.boolean(),
  confidence: z.number(),
  fix_count: z.number(),
  recommended_fix: RecommendedFixSchema,
  proposal_id: z.string().nullable(),
  next_action: z.string(),
  refused: z.boolean(),
  refused_reason: z.string().nullable(),
});

type Input = z.infer<typeof InputSchema>;
type Output = z.infer<typeof OutputSchema>;

export interface DiagnoseDependencyDeps {
  db: import('bun:sqlite').Database;
  memory: MemoryClient;
  proposals: ProposalsStore;
  process_misses?: ProcessMissStore;
  /** Smoke seams — forwarded to the diagnosis engine; default to real paths. */
  complete_role_fn?: DiagnosisEngineDeps['complete_role_fn'];
  verify_fn?: DiagnosisEngineDeps['verify_fn'];
  assess_fn?: DiagnosisEngineDeps['assess_fn'];
  fetch_logs_fn?: DiagnosisEngineDeps['fetch_logs_fn'];
}

/** Compact a scored fix for the proposal payload (drop the heavy detail prose
 *  to keep the card lean; the full diagnosis_md is persisted on the row). */
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

export function make_diagnose_dependency(deps: DiagnoseDependencyDeps): Tool<Input, Output> {
  return {
    name: 'diagnose_dependency',
    description:
      "Diagnose WHY a down dependency is failing, on the LOCAL deep model. Reads " +
      "the dependency's container logs (via the read-only ops-relay), the actual " +
      'error strings from the audit log, the probe, and the resolved config, then ' +
      'the deep model produces a root cause grounded ONLY in that evidence and ' +
      'emits typed candidate fixes (restart / config_change / code_change / ' +
      'escalate) each adversarially scored on likelihood/risk/reversibility/' +
      'blast-radius and ranked. Persists the diagnosis and files an owner ' +
      "recommendation with the scored options. Call it when Kate flags a " +
      '"Dependency DOWN/DEGRADED" — BEFORE restarting — then act on the ' +
      'recommended fix through the existing gate per the returned next_action ' +
      "(a high-confidence restart → restart_service; config → apply_low_risk_fix " +
      'or an owner flag; code → propose_code_edit). It NEVER applies a fix ' +
      'itself. Pass the dependency name from the flag.',
    risk: 'write_internal',
    required_capabilities: ['diagnose_infra', 'write_proposals'],
    input_schema: InputSchema,
    output_schema: OutputSchema,
    volatile: true,

    idempotency_key(input) {
      return `diagnose_dependency:${input.dependency}:${Math.floor(Date.now() / 60_000)}`;
    },

    async execute(input, ctx: ToolContext): Promise<Output> {
      const empty_rec = null;
      if (!health_diagnosis_enabled()) {
        return {
          ok: false,
          enabled: false,
          dependency: input.dependency,
          diagnosis_id: null,
          root_cause: '',
          inconclusive: true,
          confidence: 0,
          fix_count: 0,
          recommended_fix: empty_rec,
          proposal_id: null,
          next_action: 'HEARTH_HEALTH_DIAGNOSIS=0 — self-diagnosis is disabled.',
          refused: false,
          refused_reason: null,
        };
      }

      const dep = DEPENDENCIES.find((d) => d.name === input.dependency);
      if (!dep) {
        return {
          ok: false,
          enabled: true,
          dependency: input.dependency,
          diagnosis_id: null,
          root_cause: '',
          inconclusive: true,
          confidence: 0,
          fix_count: 0,
          recommended_fix: empty_rec,
          proposal_id: null,
          next_action: `No dependency named "${input.dependency}" in the registry. Known: ${DEPENDENCIES.map((d) => d.name).join(', ')}.`,
          refused: true,
          refused_reason: `Unknown dependency "${input.dependency}". Use the exact name from the health flag.`,
        };
      }

      // ── run the engine (gather → diagnose → score → rank), fail-open ──
      const engine: DiagnosisEngineDeps = {
        db: deps.db,
        ...(ctx.llm ? { llm: ctx.llm } : {}),
        ...(ctx.now ? { now: ctx.now } : {}),
        ...(deps.complete_role_fn ? { complete_role_fn: deps.complete_role_fn } : {}),
        ...(deps.verify_fn ? { verify_fn: deps.verify_fn } : {}),
        ...(deps.assess_fn ? { assess_fn: deps.assess_fn } : {}),
        ...(deps.fetch_logs_fn ? { fetch_logs_fn: deps.fetch_logs_fn } : {}),
      };
      const diag = await run_diagnosis(engine, dep);

      // ── persist ──
      const store = new HealthDiagnosisStore(deps.db);
      const md = render_diagnosis_markdown(diag);
      const diagnosis_id = store.create(
        {
          dependency: diag.dependency,
          incident_id: diag.evidence.incident?.id ?? null,
          root_cause: diag.root_cause,
          inconclusive: diag.inconclusive,
          confidence: diag.confidence,
          diagnosis_md: md,
          fixes: diag.fixes,
          recommended_index: diag.recommended_index,
          evidence: diag.evidence,
          ungrounded_dropped: diag.ungrounded_dropped,
          model: diag.model,
        },
        ctx.now,
      );
      store.supersede_open(diag.dependency, diagnosis_id);

      const rec = diag.recommended_index >= 0 ? diag.fixes[diag.recommended_index] ?? null : null;
      const rec_weak = !rec || rec.type === 'escalate' || rec.score.confidence < recommend_floor();

      // ── cite the open health miss (blast radius), if present ──
      const cited_miss_ids: string[] = [];
      if (deps.process_misses) {
        try {
          const want = `dependency:${diag.dependency}:health`;
          for (const m of deps.process_misses.list({ open_only: true })) {
            if (m.evidence_ref === want) cited_miss_ids.push(m.id);
          }
        } catch {
          /* fail-open */
        }
      }

      // ── file the owner-facing recommendation (system kind → owner-global;
      //    skip Kate pre-review — an outage diagnosis is time-sensitive and
      //    informational, not a code-change for her to vet) ──
      const conf_pct = Math.round((rec?.score.confidence ?? 0) * 100);
      const headline = `${diag.evidence.label} ${diag.evidence.status} — ${rec ? rec.title : 'needs attention'}`;
      const summary =
        `Diagnosed ${diag.evidence.label} (${diag.evidence.status}). ` +
        (diag.inconclusive ? 'Root cause inconclusive. ' : '') +
        `${diag.fixes.length} fix(es) scored; recommended: ${rec ? `${rec.title} (${conf_pct}%)` : 'escalate'}.`;
      const rationale =
        `Kate flagged ${diag.evidence.label} ${diag.evidence.status}. I diagnosed it locally — ` +
        `read the container logs, the audit error samples, and the config. ${first_sentence(diag.root_cause)} ` +
        (rec && !rec_weak
          ? `My top fix is "${rec.title}" (${conf_pct}% confidence, ${rec.score.risk} risk), applied via \`${rec.apply_via}\`. `
          : `I couldn't land a confident fix automatically, so this is yours to call. `) +
        `${diag.fixes.length} option(s) are scored below; ${cited_miss_ids.length ? `closes ${cited_miss_ids.length} open health miss(es).` : 'the incident stays open until a scan confirms recovery.'}`;

      let proposal_id: string | null = null;
      try {
        proposal_id = deps.proposals.create({
          specialist_id: ctx.specialist_id ?? 'trainer',
          kind: 'recommendation',
          execution_kind: 'manual',
          skip_kate_review: true,
          payload: {
            headline,
            slug: `infra-diagnosis-${diag.dependency}`,
            summary,
            dependency: diag.dependency,
            diagnosis_id,
            status: diag.evidence.status,
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
            kind: 'infra_diagnosis',
            category: 'infra',
            anchor: diag.dependency,
          },
        });
        store.attach_proposal(diagnosis_id, proposal_id);
      } catch {
        /* fail-open — the diagnosis is persisted even if the proposal fails */
      }

      // ── nudge the owner that a diagnosis is ready (fail-open) ──
      try {
        await push_text(
          `🔎 Diagnosed ${diag.evidence.label} (${diag.evidence.status}): ${first_sentence(diag.root_cause)} ` +
            `Recommended: ${rec ? `${rec.title} (${conf_pct}%)` : 'escalate'}. See the proposal for the scored options.`,
          deps.memory,
          ctx.intent_id ?? ulid(),
          'health_diagnosis',
        );
      } catch {
        /* fail-open */
      }

      // ── steer Beatrice toward the existing gate (no new apply surface) ──
      let next_action: string;
      if (rec_weak) {
        next_action =
          `Diagnosis filed (proposal ${proposal_id ?? 'n/a'}). No high-confidence auto-fix — leave it for Jasper; ` +
          `the proposal carries the scored options. Don't fabricate a fix you can't ground.`;
      } else if (rec!.type === 'restart' && diag.evidence.restartable) {
        next_action =
          `Recommended fix is a restart of \`${rec!.target || diag.evidence.restart_service}\` (${conf_pct}% confidence, ${rec!.score.risk} risk). ` +
          `If you agree, call restart_service({dependency:'${diag.dependency}'}) now — it's circuit-broken and won't claim "fixed" (the next scan confirms). Otherwise Jasper has the scored options.`;
      } else if (rec!.type === 'config_change') {
        next_action =
          `Recommended fix is a config change (apply via \`${rec!.apply_via}\`). If it's a safe-set in-repo YAML toggle, apply_low_risk_fix; ` +
          `if it's an env/ops change you can't see, it's already in the owner proposal — flag it, don't code around it.`;
      } else if (rec!.type === 'code_change') {
        next_action =
          `Recommended fix is a code change. Author it with propose_code_edit per the diagnosis detail, through the normal Kate-review + owner-merge gate. Proposal: ${proposal_id ?? 'n/a'}.`;
      } else {
        next_action = `See the scored fixes in proposal ${proposal_id ?? 'n/a'}.`;
      }

      deps.memory.log_action({
        intent_id: ctx.intent_id,
        agent: ctx.specialist_id ?? 'trainer',
        tool_name: 'diagnose_dependency',
        tool_input: { dependency: diag.dependency },
        execution_result: {
          diagnosis_id,
          proposal_id,
          inconclusive: diag.inconclusive,
          confidence: diag.confidence,
          fix_count: diag.fixes.length,
          recommended: rec ? { type: rec.type, apply_via: rec.apply_via, confidence: rec.score.confidence } : null,
          logs_read: diag.evidence.logs_source === 'relay',
          ungrounded_dropped: diag.ungrounded_dropped.length,
          cited_miss_ids,
        },
      });

      return {
        ok: true,
        enabled: true,
        dependency: diag.dependency,
        diagnosis_id,
        root_cause: diag.root_cause,
        inconclusive: diag.inconclusive,
        confidence: diag.confidence,
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
        next_action,
        refused: false,
        refused_reason: null,
      };
    },
  };
}

/** ToolLoader entry point. */
export function create(deps: ToolDeps): Tool {
  return make_diagnose_dependency({
    db: deps.db,
    memory: deps.memory,
    proposals: deps.proposals,
    ...(deps.process_misses ? { process_misses: deps.process_misses } : {}),
  }) as Tool;
}
