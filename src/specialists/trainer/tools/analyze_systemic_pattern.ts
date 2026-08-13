/**
 * analyze_systemic_pattern — Beatrice's cross-miss diagnostic.
 *
 * Mariah's program_dashboard tells her WHICH cluster to route at a
 * pattern level (e.g. "42 no-recovery-hint findings"). Beatrice needs
 * the layer underneath that: of those 42, which CONNECTORS are
 * implicated, and which one connector's fix would close the most
 * downstream fabrication misses?
 *
 * The structural insight the tool surfaces:
 *
 *   A single fabrication-after-read-failure miss says "Iris fabricated
 *   after a 404." That's one persona-fix opportunity if you stop
 *   there. But trace the audit_log for the same intent_id and you
 *   find the failure was a 404 from `web_fetch_clean` — and 18 other
 *   open fabrication misses are upstream of the same connector. ONE
 *   propose_connector_recovery_hint on web_fetch_clean closes all 19.
 *
 * This tool walks the ledger and surfaces those cross-miss patterns
 * with their blast radii so Beatrice doesn't author 19 individual
 * fixes when one will do. The output feeds directly into
 * propose_connector_recovery_hint — each systemic pattern carries
 * the input shape that tool wants.
 *
 * Read-only. Walks open process_misses + audit_log; no writes.
 */
import { z } from 'zod';
import type { Database } from 'bun:sqlite';
import type { Tool, ToolContext } from '@core/tool';
import type { ToolDeps } from '@core/tool_deps';
import type { ProcessMissStore } from '@core/process_misses';

const InputSchema = z.object({
  /** Limit the scan to misses opened in the last N days. Default 14. */
  lookback_days: z.coerce.number().int().positive().max(180).optional(),
  /** Only return systemic patterns whose blast radius is at least this
   *  many misses. Default 2 — fewer than 2 isn't a systemic pattern. */
  min_blast_radius: z.coerce.number().int().positive().max(50).optional(),
});

const SystemicTarget = z.object({
  kind: z.enum(['connector_recovery_hint', 'persona_curation_class', 'capability_grant_class']),
  /** What to fix. For connector_recovery_hint: the connector tool name. */
  anchor: z.string(),
  blast_radius: z.number(),
  related_miss_ids: z.array(z.string()),
  affected_specialists: z.array(z.string()),
  /** A ready-to-paste call shape for the proposal tool that closes
   *  this pattern. Beatrice reads it and either calls the tool with
   *  the suggested args or refines the spec from the diagnostic. */
  suggested_proposal: z.object({
    tool_to_call: z.string(),
    args_sketch: z.record(z.string(), z.unknown()),
  }),
  rationale: z.string(),
});

const OutputSchema = z.object({
  scanned_open_misses: z.number(),
  scanned_audit_rows: z.number(),
  systemic_targets: z.array(SystemicTarget),
});

type Input = z.infer<typeof InputSchema>;
type Output = z.infer<typeof OutputSchema>;

function pattern_of(evidence_ref: string | null): string | null {
  if (!evidence_ref) return null;
  const parts = evidence_ref.split(':');
  return parts.length >= 2 ? (parts[1] ?? null) : null;
}

/**
 * Pull the failing tool name out of a fabrication-after-read-failure
 * miss's evidence_ref + audit_log trace. The miss's `evidence_ref` is
 * `auth:fab-after-read-failure:<message_id>` (or `…-consult:<intent_id>`).
 * For the message form, follow back to audit_log via the intent_id
 * stashed in the message's tool_calls_json; for the consult form, use
 * the intent_id directly. Either way, the FIRST failing tool call in
 * that intent_id is the connector to credit.
 */
function failing_tool_for_miss(
  db: Database,
  evidence_ref: string,
): string | null {
  const parts = evidence_ref.split(':');
  const variant = parts[1];
  const id = parts.slice(2).join(':');
  if (!id) return null;
  let intent_id: string | null = null;
  if (variant === 'fab-after-read-failure-consult') {
    intent_id = id;
  } else if (variant === 'fab-after-read-failure') {
    // id is a message_id — look up its tool_calls_json for an intent
    // anchor. Simplest: most messages don't store intent directly,
    // but the specialist_turn audit row for the message shares ts.
    // The reliable indirection is via messages.ts (close to audit
    // ts) — pull the message ts, then the matching specialist_turn.
    const m = db
      .prepare(`SELECT ts FROM messages WHERE id = @id`)
      .get({ '@id': id }) as { ts: string } | undefined;
    if (!m) return null;
    const a = db
      .prepare(
        `SELECT intent_id FROM audit_log
          WHERE tool_name = 'specialist_turn' AND ts BETWEEN @lo AND @hi
          ORDER BY ts DESC LIMIT 1`,
      )
      .get({
        '@lo': new Date(new Date(m.ts).getTime() - 2_000).toISOString(),
        '@hi': new Date(new Date(m.ts).getTime() + 2_000).toISOString(),
      }) as { intent_id: string } | undefined;
    intent_id = a?.intent_id ?? null;
  }
  if (!intent_id) return null;
  const failing = db
    .prepare(
      `SELECT tool_name, error, execution_result FROM audit_log
        WHERE intent_id = @i
          AND tool_name NOT IN (
            'specialist_turn','rag_retrieval','awareness_observation',
            'deliberation_pass','llm_error','turn_cancelled',
            'blank_turn_fallback','ghost_promise_guard',
            'same_tool_spiral_exhaust','consult_specialist'
          )
        ORDER BY ts ASC`,
    )
    .all({ '@i': intent_id }) as Array<{
    tool_name: string;
    error: string | null;
    execution_result: string | null;
  }>;
  for (const f of failing) {
    if (f.error && f.error.length > 0) return f.tool_name;
    if (f.execution_result) {
      try {
        const er = JSON.parse(f.execution_result) as Record<string, unknown>;
        if (typeof er.error === 'string' && er.error.length > 0) return f.tool_name;
        if (er.state === null) return f.tool_name;
      } catch {
        /* skip */
      }
    }
  }
  return null;
}

function make_analyze_systemic_pattern(
  db: Database,
  misses: ProcessMissStore,
): Tool<Input, Output> {
  return {
    name: 'analyze_systemic_pattern',
    description:
      "Beatrice's cross-miss diagnostic. Walks open process_misses + " +
      'their underlying audit_log trace to find single-fix-many-misses ' +
      "opportunities. Today's main pattern: fabrication-after-read- " +
      'failure misses cluster upstream of specific connectors — one ' +
      "propose_connector_recovery_hint on the right connector closes " +
      'every miss caused by its bare error shape. Returns a ranked ' +
      'list of systemic targets, each with blast_radius, affected ' +
      "specialists, related_miss_ids (to cite in the resulting " +
      "proposal), and a ready-to-paste suggested_proposal carrying " +
      "the tool to call and its args sketch. Read-only. Cheap. Call " +
      'this before authoring connector-affordance proposals — it ' +
      'rolls them up so one PR covers many gaps.',
    risk: 'read',
    required_capabilities: ['read_audit_log'],
    input_schema: InputSchema,
    output_schema: OutputSchema,

    idempotency_key() {
      return 'analyze_systemic_pattern';
    },

    async execute(input, _ctx: ToolContext): Promise<Output> {
      const lookback_days = input.lookback_days ?? 14;
      const min_blast = input.min_blast_radius ?? 2;
      const since = new Date(
        Date.now() - lookback_days * 86_400_000,
      ).toISOString();

      const open_misses = misses
        .list({ open_only: true })
        .filter((m) => m.ts_created >= since);

      // Per-connector aggregation for the fabrication clusters.
      const by_connector = new Map<
        string,
        { miss_ids: string[]; specialists: Set<string> }
      >();

      let scanned_audit_rows = 0;
      for (const m of open_misses) {
        const pat = pattern_of(m.evidence_ref);
        if (pat !== 'fab-after-read-failure' && pat !== 'fab-after-read-failure-consult') {
          continue;
        }
        if (!m.evidence_ref) continue;
        scanned_audit_rows++;
        const tool_name = failing_tool_for_miss(db, m.evidence_ref);
        if (!tool_name) continue;
        let agg = by_connector.get(tool_name);
        if (!agg) {
          agg = { miss_ids: [], specialists: new Set() };
          by_connector.set(tool_name, agg);
        }
        agg.miss_ids.push(m.id);
        agg.specialists.add(m.subject_specialist_id);
      }

      // Also surface the no-recovery-hint misses themselves — each is
      // a 1-miss/1-connector cluster but the targeted-blast variant
      // (fabrication-after-read-failure on this same connector) might
      // already be in by_connector. Merge: a no-recovery-hint miss on
      // tool X folds into by_connector[X] so the blast radius shows
      // the FULL story (1 affordance miss + N fab misses = N+1).
      for (const m of open_misses) {
        const pat = pattern_of(m.evidence_ref);
        if (pat !== 'no-recovery-hint') continue;
        const ref_parts = (m.evidence_ref ?? '').split(':');
        const tool_name = ref_parts[2];
        if (!tool_name) continue;
        let agg = by_connector.get(tool_name);
        if (!agg) {
          agg = { miss_ids: [], specialists: new Set() };
          by_connector.set(tool_name, agg);
        }
        if (!agg.miss_ids.includes(m.id)) agg.miss_ids.push(m.id);
        agg.specialists.add('trainer');
      }

      // Build systemic targets.
      const systemic_targets: z.infer<typeof SystemicTarget>[] = [];
      for (const [tool_name, agg] of by_connector) {
        const blast_radius = agg.miss_ids.length;
        if (blast_radius < min_blast) continue;
        const specialists_arr = [...agg.specialists].sort();
        systemic_targets.push({
          kind: 'connector_recovery_hint',
          anchor: tool_name,
          blast_radius,
          related_miss_ids: agg.miss_ids,
          affected_specialists: specialists_arr,
          suggested_proposal: {
            tool_to_call: 'propose_connector_recovery_hint',
            args_sketch: {
              tool_name,
              recovery_field_name: 'candidates',
              recovery_field_description:
                `When ${tool_name} fails (error or empty result), this ` +
                `field carries close-match candidates the calling LLM ` +
                `can retry against — mirrors the ha_get_state pattern.`,
              when_to_populate:
                'On the error branch of execute() — when the underlying ' +
                'call returns 4xx, an empty body, or any structured failure.',
              how_to_derive:
                'Tool-specific — for HA-style tools, same-domain entities ' +
                'ranked by shared-token overlap. For search/fetch tools, ' +
                'alternative URLs from the same search session or domain. ' +
                'For routing/maps tools, alternative endpoints near the ' +
                'failing one. Beatrice refines per connector.',
              closes_miss_ids: agg.miss_ids,
            },
          },
          rationale:
            `${blast_radius} open miss${blast_radius === 1 ? '' : 'es'} trace upstream of \`${tool_name}\`'s ` +
            `bare error shape — one recovery-hint fix closes them all. ` +
            `Affected specialists: ${specialists_arr.join(', ')}.`,
        });
      }
      systemic_targets.sort((a, b) => b.blast_radius - a.blast_radius);

      return {
        scanned_open_misses: open_misses.length,
        scanned_audit_rows,
        systemic_targets,
      };
    },
  };
}

/** ToolLoader entry point. */
export function create(deps: ToolDeps): Tool {
  return make_analyze_systemic_pattern(
    deps.db,
    deps.process_misses,
  ) as Tool;
}
