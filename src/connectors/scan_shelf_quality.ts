/**
 * scan_shelf_quality — Cordelia-side audit-driven gap scan.
 *
 * Reads the `audit_log` for `rag_retrieval` and `search_library`
 * activity over a configurable window (default 7 days) and returns,
 * per specialist: how often retrieval came back empty, how often it
 * came back with no Tier-1 sources at all, and the top 5 query topics
 * driving each. Cordelia reads this during her 04:00 deliberation to
 * decide which shelf to spend curate budget on next.
 *
 * The "knowledge trust" surface (Slice B follow-on, 2026-05-30) made
 * this tractable: `retrieve_scoped_chunks` now stamps the
 * `trust_tiers` array into the audit row's `execution_result`, so
 * Cordelia can identify shelves where she's not just thin (empty
 * results) but *weak* (results land but none are evidence-tier).
 *
 * Gated to Cordelia via `write_vault_any_library` (same gate as
 * `curate_for_specialist` — these tools work as a pair).
 */
import { z } from 'zod';
import type { Tool, ToolContext } from '@core/tool';
import type { ToolDeps } from '@core/tool_deps';
import type { Database } from 'bun:sqlite';

const InputSchema = z.object({
  window_days: z
    .number()
    .int()
    .min(1)
    .max(60)
    .default(7)
    .describe('Audit window. Default 7 — long enough to smooth noise, short enough to detect recently-emerged gaps.'),
  min_queries: z
    .number()
    .int()
    .min(1)
    .max(50)
    .default(3)
    .describe('A specialist needs at least this many retrieval rows in the window to be reportable — otherwise the sample is too thin to draw conclusions.'),
});

const ShelfReportSchema = z.object({
  specialist_id: z.string(),
  queries: z.number(),
  empty_rate: z.number(),
  no_tier_1_rate: z.number(),
  median_k: z.number(),
  top_gap_queries: z.array(
    z.object({
      query_preview: z.string(),
      kind: z.enum(['empty', 'no_tier_1', 'weak_coverage']),
      seen_count: z.number(),
    }),
  ),
});

const OutputSchema = z.object({
  window_days: z.number(),
  evaluated_at: z.string(),
  shelves: z.array(ShelfReportSchema),
  // Cordelia priority queue: shelves ordered by (empty_rate * 2 +
  // no_tier_1_rate) descending — empty results are worse than weak
  // coverage. She can read this top-down and decide curate budget.
  priority: z.array(z.string()),
});

type Input = z.infer<typeof InputSchema>;
type Output = z.infer<typeof OutputSchema>;

interface RetrievalRow {
  agent: string;
  tool_name: string;
  tool_input_json: string;
  execution_result_json: string;
}

function safe_parse_json(s: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(s) as unknown;
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      return v as Record<string, unknown>;
    }
  } catch { /* opportunistic */ }
  return null;
}

interface PerSpecialistAcc {
  queries: number;
  empties: number;
  no_tier_1: number;
  ks: number[];
  gap_queries: Map<string, { kind: 'empty' | 'no_tier_1' | 'weak_coverage'; count: number }>;
}

function classify_row(execution_result: Record<string, unknown> | null): {
  k: number;
  has_tier_1: boolean;
  is_empty: boolean;
} {
  const k = typeof execution_result?.k === 'number' ? execution_result.k : 0;
  const tiers = Array.isArray(execution_result?.trust_tiers)
    ? (execution_result.trust_tiers as Array<unknown>)
    : [];
  const has_tier_1 = tiers.some((t) => t === 1);
  return { k, has_tier_1, is_empty: k === 0 };
}

export function make_scan_shelf_quality(deps: { db: Database }): Tool<Input, Output> {
  return {
    name: 'scan_shelf_quality',
    description:
      "Audit each specialist's library shelf quality from the rag_retrieval + search_library audit log. Returns per-specialist empty-result rate, no-Tier-1 rate, median result count, and the top 5 query topics driving each gap. Use during your 04:00 deliberation pass to decide which shelf to spend curate budget on. The `priority` array is the ranking — empty results count 2x because a hit-with-weak-sources is still a hit. Pair with `curate_for_specialist`: scan_shelf_quality → pick the top-priority shelf → curate_for_specialist against that shelf's gap topics.",
    risk: 'read',
    required_capabilities: ['write_vault_any_library'],
    input_schema: InputSchema,
    output_schema: OutputSchema,

    idempotency_key(input) {
      return `scan_shelf_quality:${input.window_days}:${input.min_queries}`;
    },

    async execute(input, _ctx: ToolContext): Promise<Output> {
      const cutoff_ms = Date.now() - input.window_days * 86_400_000;
      const cutoff_iso = new Date(cutoff_ms).toISOString();
      const rows = deps.db
        .prepare(
          `SELECT agent, tool_name, tool_input AS tool_input_json,
                  execution_result AS execution_result_json
             FROM audit_log
            WHERE tool_name IN ('rag_retrieval', 'search_library')
              AND ts >= @cutoff
              AND agent IS NOT NULL`,
        )
        .all({ '@cutoff': cutoff_iso }) as RetrievalRow[];

      const per: Map<string, PerSpecialistAcc> = new Map();
      for (const r of rows) {
        const acc = per.get(r.agent) ?? {
          queries: 0,
          empties: 0,
          no_tier_1: 0,
          ks: [] as number[],
          gap_queries: new Map(),
        };
        const exec = safe_parse_json(r.execution_result_json);
        const inp = safe_parse_json(r.tool_input_json);
        const { k, has_tier_1, is_empty } = classify_row(exec);
        acc.queries += 1;
        acc.ks.push(k);
        if (is_empty) acc.empties += 1;
        if (!has_tier_1 && !is_empty) acc.no_tier_1 += 1;

        // Track query topics that produced gaps. tool_input.query_preview
        // is the first 120 chars of the user-facing query; good enough
        // for clustering at this scale.
        const qp = typeof inp?.query_preview === 'string'
          ? inp.query_preview.trim().toLowerCase()
          : null;
        if (qp && (is_empty || !has_tier_1)) {
          const kind = is_empty ? 'empty' : 'no_tier_1';
          const prev = acc.gap_queries.get(qp);
          if (prev) {
            prev.count += 1;
            // Empty beats weak — keep the worse classification.
            if (kind === 'empty') prev.kind = 'empty';
          } else {
            acc.gap_queries.set(qp, { kind, count: 1 });
          }
        }
        per.set(r.agent, acc);
      }

      const shelves: z.infer<typeof ShelfReportSchema>[] = [];
      for (const [specialist_id, acc] of per) {
        if (acc.queries < input.min_queries) continue;
        const empty_rate = acc.empties / acc.queries;
        const no_tier_1_rate = acc.no_tier_1 / acc.queries;
        const sorted_ks = acc.ks.slice().sort((a, b) => a - b);
        const median_k = sorted_ks[Math.floor(sorted_ks.length / 2)] ?? 0;
        const top_gap_queries = Array.from(acc.gap_queries.entries())
          .sort((a, b) => b[1].count - a[1].count)
          .slice(0, 5)
          .map(([query_preview, { kind, count }]) => ({
            query_preview,
            kind,
            seen_count: count,
          }));
        shelves.push({
          specialist_id,
          queries: acc.queries,
          empty_rate: Math.round(empty_rate * 1000) / 1000,
          no_tier_1_rate: Math.round(no_tier_1_rate * 1000) / 1000,
          median_k,
          top_gap_queries,
        });
      }

      // Priority order: empty_rate * 2 + no_tier_1_rate. Empty hurts
      // twice as much as weak coverage — a hit with only Tier-2
      // sources is still a hit Astrid can cite by name.
      const priority = shelves
        .slice()
        .sort((a, b) =>
          (b.empty_rate * 2 + b.no_tier_1_rate) -
          (a.empty_rate * 2 + a.no_tier_1_rate),
        )
        .map((s) => s.specialist_id);

      return {
        window_days: input.window_days,
        evaluated_at: new Date().toISOString(),
        shelves,
        priority,
      };
    },
  };
}

export function create(deps: ToolDeps): Tool {
  return make_scan_shelf_quality({ db: deps.db }) as Tool;
}
