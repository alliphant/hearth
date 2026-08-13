/**
 * knowledge_demand_report — Cordelia's read-only view of the demand
 * ledger (knowledge metabolism #1, 2026-06-10).
 *
 * Surfaces the top knowledge gaps mined from the audit trail
 * (src/core/knowledge_demand.ts): suppressed low-confidence RAG,
 * empty search_library lookups, golden-task eval failures, and
 * citation-guard gaps — clustered into per-specialist demand topics
 * with evidence counts and audit refs. This is the FIRST move of her
 * deliberation playbook: read demand, then spend acquisition budget
 * (acquire_knowledge / curate_for_specialist) on the topics with real
 * evidence behind them.
 *
 * Gated on `write_vault_any_library` — same Cordelia-pair gate as
 * scan_shelf_quality / curate_for_specialist; these tools work as a
 * set and nobody else holds the capability.
 *
 * Per-user cordon: each topic carries `private_to_hint` — set when ALL
 * user-attributed evidence came from a single non-owner user. Pass it
 * through to acquire_knowledge's `private_to_user_id` so material
 * acquired for that user's questions shelves at THEIR visibility.
 */
import { z } from 'zod';
import type { Database } from 'bun:sqlite';
import type { Tool, ToolContext } from '@core/tool';
import type { ToolDeps } from '@core/tool_deps';
import { mine_knowledge_demand } from '@core/knowledge_demand';

const InputSchema = z.object({
  window_days: z
    .number()
    .int()
    .min(1)
    .max(60)
    .default(14)
    .describe(
      'Audit window in days. Default 14 — wide enough to accumulate a real cluster, narrow enough to track current demand.',
    ),
  max_topics: z
    .number()
    .int()
    .min(1)
    .max(30)
    .default(12)
    .describe('Cap on returned demand topics (highest evidence first). Default 12.'),
});

const TopicSchema = z.object({
  specialist_id: z.string().nullable(),
  label: z.string(),
  evidence_count: z.number(),
  kinds: z.record(z.string(), z.number()),
  sample_texts: z.array(z.string()),
  refs: z.array(z.string()),
  /** Set when every user-attributed signal came from ONE non-owner user —
   *  thread it into acquire_knowledge.private_to_user_id (cordon). */
  private_to_hint: z.string().nullable(),
  last_seen: z.string(),
  /** Recent half of the window vs older half: `growing` / `declining` /
   *  `steady` / `new`. A `growing` or `new` gap of equal raw evidence
   *  deserves the budget before a `declining` one. */
  trend_direction: z.enum(['growing', 'steady', 'declining', 'new']),
  recent_evidence: z.number(),
  prior_evidence: z.number(),
});

const OutputSchema = z.object({
  window_days: z.number(),
  generated_at: z.string(),
  signals_scanned: z.number(),
  topics: z.array(TopicSchema),
  note: z.string(),
});

type Input = z.infer<typeof InputSchema>;
type Output = z.infer<typeof OutputSchema>;

export function make_knowledge_demand_report(deps: { db: Database }): Tool<Input, Output> {
  return {
    name: 'knowledge_demand_report',
    description:
      'Read the demand ledger: knowledge gaps mined from the last N days of audit signals (suppressed low-confidence retrieval, empty library searches, eval failures, citation gaps), clustered into per-specialist topics with evidence counts and audit refs. Call this FIRST in a curation pass, then spend acquisition budget on the top topics via acquire_knowledge or curate_for_specialist. Each topic carries a `trend_direction` (recent half of the window vs older) — favor a `growing` or `new` gap over a `declining` one of equal evidence. A topic with `private_to_hint` set came from one non-owner user — pass that id to acquire_knowledge.private_to_user_id so the shelved material stays at their visibility.',
    risk: 'read',
    required_capabilities: ['write_vault_any_library'],
    input_schema: InputSchema,
    output_schema: OutputSchema,

    idempotency_key(input) {
      return `knowledge_demand_report:${input.window_days}:${input.max_topics}`;
    },

    async execute(input, ctx: ToolContext): Promise<Output> {
      const now = ctx.now ?? new Date();
      const owner = process.env.HEARTH_OWNER_USER_ID ?? 'jasper';
      const { signals_scanned, topics } = mine_knowledge_demand(deps.db, {
        window_days: input.window_days,
        now,
        max_topics: input.max_topics,
      });

      ctx.memory.log_action({
        intent_id: ctx.intent_id,
        agent: ctx.specialist_id ?? 'cordelia',
        tool_name: 'knowledge_demand_report',
        tool_input: { window_days: input.window_days, max_topics: input.max_topics },
        execution_result: {
          signals_scanned,
          topics: topics.length,
          top_labels: topics.slice(0, 5).map((t) => t.label),
        },
        user_id: ctx.user?.id,
      });

      return {
        window_days: input.window_days,
        generated_at: now.toISOString(),
        signals_scanned,
        topics: topics.map((t) => ({
          specialist_id: t.specialist_id,
          label: t.label,
          evidence_count: t.evidence_count,
          kinds: t.kinds as Record<string, number>,
          sample_texts: t.sample_texts,
          refs: t.refs,
          private_to_hint:
            t.sole_user_id && t.sole_user_id !== owner ? t.sole_user_id : null,
          last_seen: t.last_seen,
          trend_direction: t.trend_direction,
          recent_evidence: t.recent_evidence,
          prior_evidence: t.prior_evidence,
        })),
        note:
          topics.length === 0
            ? 'No demand signals in the window — the shelves are keeping up. Do not pre-fetch speculatively.'
            : 'Topics are evidence-ranked. specialist_id null = unattributed legacy rows (team-wide).',
      };
    },
  };
}

export function create(deps: ToolDeps): Tool {
  return make_knowledge_demand_report({ db: deps.db }) as Tool;
}
