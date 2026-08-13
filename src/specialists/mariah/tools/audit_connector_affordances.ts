/**
 * audit_connector_affordances — Mariah sweeps the tool registry for
 * connectors that surface errors without surfacing a way out.
 *
 * The Iris EV failure showed why this matters: `ha_get_state` returned
 * `{state: null, error: "HA HTTP 404"}` four times, gave Iris nothing
 * actionable to do next, and she fabricated a percentage instead of
 * retrying against a real entity_id. The fix (Pass A, 2026-05-25) was
 * to extend ha_get_state to return `candidates` on 404 — a structured
 * recovery hint the LLM can act on without persona-level coaching.
 *
 * Every other connector that returns bare `error: "..."` without an
 * adjacent "and here's what would work" carries the same risk. This
 * tool walks the registry weekly and flags them.
 *
 * Heuristic: a tool's output_schema has an `error` field AND lacks
 * any of the recovery-hint key shapes a healthy connector exposes
 * (candidates / suggestions / alternatives / available_* / recovery_* /
 * retry_with / next_action / hint(s)). Each finding opens a low-
 * severity process_miss routed to Beatrice; she audits the connector's
 * real failure modes and proposes the appropriate enrichment.
 *
 * Conservative on purpose. False positives (a Scribe writer whose
 * errors don't admit retry, an internal helper) are cheap — Beatrice
 * dismisses them on triage. False negatives (a connector that returns
 * an unstructured error and silently invites fabrication) are the
 * expensive class; we'd rather over-flag than miss.
 */
import { z } from 'zod';
// The recovery-hint definition is SHARED with Beatrice's
// propose_connector_recovery_hint (which refuses redundant proposals
// against it) — one source of truth in @core/connector_affordances.
import { is_recovery_hint, output_keys } from '@core/connector_affordances';
import type { Tool, ToolContext } from '@core/tool';
import type { ToolDeps } from '@core/tool_deps';
import type {
  ProcessMissSeverity,
  ProcessMissStore,
} from '@core/process_misses';
import type { ToolRegistry } from '@core/tool_registry';

const InputSchema = z.object({});

const OpenedSchema = z.object({
  miss_id: z.string(),
  tool_name: z.string(),
  evidence_ref: z.string(),
});

const OutputSchema = z.object({
  tools_inspected: z.number(),
  tools_with_error_field: z.number(),
  tools_without_recovery_hint: z.number(),
  already_tracked: z.number(),
  misses_opened: z.array(OpenedSchema),
  /**
   * Every evidence_ref this scan would emit on this run, BEFORE the
   * idempotency dedup against existing process_misses. Used by
   * verify_fix_landed to know which refs the scan currently considers
   * active — a miss whose ref is absent here is the signal that a fix
   * landed and the miss should auto-close. Without this field, the
   * scan's `already_tracked` counter tells you how many got deduped
   * but not which ones, so verify couldn't reliably tell "fixed" from
   * "still failing."
   */
  current_findings_refs: z.array(z.string()),
  /**
   * The live set of tools still lacking a recovery hint, by name. The rollup
   * miss's gap can't re-edit itself between scans, so this is the authoritative
   * current list — Beatrice re-runs the audit to see exactly what's left.
   */
  tools_without_hint_names: z.array(z.string()),
});

type Input = z.infer<typeof InputSchema>;
type Output = z.infer<typeof OutputSchema>;


function make_audit_connector_affordances(
  tools: ToolRegistry,
  misses: ProcessMissStore,
): Tool<Input, Output> {
  return {
    name: 'audit_connector_affordances',
    description:
      "Mariah's connector-affordance audit. Walks the tool registry and " +
      "flags connectors whose output_schema can return an `error` but " +
      "carries no recovery-hint field — the failure mode behind Iris's " +
      "EV fabrication (ha_get_state returned `{state: null, error: '404'}` " +
      "with nothing actionable, so the LLM fabricated). Findings roll up into a " +
      "SINGLE low-severity process_miss routed to Beatrice (the live tool list " +
      "is in the return value), not one row per tool. Idempotent; the rollup " +
      "auto-closes via verify_fix_landed once every tool is enriched.",
    risk: 'write_internal',
    required_capabilities: ['write_process_miss'],
    input_schema: InputSchema,
    output_schema: OutputSchema,

    yield: { none: true, reason: 'a detector — it opens misses only for connectors lacking a recovery hint; zero means the roster is clean' },
    idempotency_key() {
      return 'audit_connector_affordances';
    },

    async execute(_input, _ctx: ToolContext): Promise<Output> {
      const tracked = new Set<string>();
      for (const m of misses.list()) {
        if (m.evidence_ref) tracked.add(m.evidence_ref);
      }

      // ROLLUP — one process miss for the whole affordance gap, not one per
      // tool. The per-tool form produced 51 near-identical low-severity rows
      // that buried the real signal in Beatrice's inbox (2026-06-04). A single
      // stable rollup ref keeps it to one row; verify_fix_landed (pattern
      // `no-recovery-hint`) auto-closes it once the set empties — and the legacy
      // per-tool refs, no longer emitted, auto-close the same way. The live tool
      // list is always returned, so the rollup gap never needs re-editing.
      const ROLLUP_REF = 'affordance:no-recovery-hint:rollup';

      let with_error = 0;
      const without_hint_tools: string[] = [];

      const registered = tools.list();
      for (const t of registered) {
        const keys = output_keys(t.output_schema as z.ZodType);
        const has_error = keys.some((k) => k.toLowerCase() === 'error');
        if (!has_error) continue;
        with_error++;
        if (keys.some(is_recovery_hint)) continue;
        without_hint_tools.push(t.name);
      }
      without_hint_tools.sort();

      const opened: z.infer<typeof OpenedSchema>[] = [];
      const current_findings_refs: string[] = [];
      let already = 0;

      if (without_hint_tools.length > 0) {
        // Still emit the ref every run so verify_fix_landed keeps the rollup
        // open until the set is empty; only CREATE when one isn't already open.
        current_findings_refs.push(ROLLUP_REF);
        if (tracked.has(ROLLUP_REF)) {
          already = 1;
        } else {
          const gap =
            `${without_hint_tools.length} connector tools can return an ` +
            `\`error\` field but expose no structured recovery hint (no ` +
            `candidates, suggestions, alternatives, available_*, recovery_*, ` +
            `retry_with, next_action, hint(s), or matches). When one fails the ` +
            `calling LLM has nothing to act on but an opaque string — the ` +
            `failure mode behind Iris's 2026-05-25 EV fabrication (ha_get_state ` +
            `returned \`{state: null, error: "HA HTTP 404"}\` and she ` +
            `manufactured a percentage rather than retry). Beatrice: for each, ` +
            `audit its real failure modes and add the appropriate recovery ` +
            `field (the \`candidates\` pattern from ha_get_state is the ` +
            `template), or note the ones whose errors don't admit recovery ` +
            `(e.g. idempotent writes) so the audit stops flagging them. Tools ` +
            `(re-run audit_connector_affordances for the live set): ` +
            `${without_hint_tools.join(', ')}.`;
          const miss_id = misses.create({
            subject_specialist_id: 'trainer',
            reporter: 'mariah',
            task_summary:
              `enrich ${without_hint_tools.length} connectors' error shapes ` +
              `with structured recovery hints so callers have somewhere to go ` +
              `besides fabrication (rollup)`,
            gap,
            severity: 'low' satisfies ProcessMissSeverity,
            evidence_ref: ROLLUP_REF,
          });
          opened.push({
            miss_id,
            tool_name: `rollup:${without_hint_tools.length}`,
            evidence_ref: ROLLUP_REF,
          });
        }
      }

      return {
        tools_inspected: registered.length,
        tools_with_error_field: with_error,
        tools_without_recovery_hint: without_hint_tools.length,
        already_tracked: already,
        misses_opened: opened,
        current_findings_refs,
        tools_without_hint_names: without_hint_tools,
      };
    },
  };
}

/** ToolLoader entry point. */
export function create(deps: ToolDeps): Tool {
  return make_audit_connector_affordances(
    deps.tool_registry,
    deps.process_misses,
  ) as Tool;
}
