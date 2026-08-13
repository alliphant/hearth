/**
 * existing_tool_scan — guard against Beatrice proposing/building a tool that
 * ALREADY EXISTS under a different name.
 *
 * The 2026-06-07 `update_workstation_sku` ghost: Beatrice spent 15+ rounds
 * proposing (and re-proposing) a tool whose function — `update_sku`, shipped
 * 61ba7bd 2026-06-05 — was already registered and granted to Kristi. She
 * searched by the wrong NAME (`update_workstation_sku`) and never matched the
 * real one, asserted the store was "insert-only" without reading it, and filed
 * three redundant proposals.
 *
 * A pure capability-TOKEN check (`analyze_capability_gaps`) misses this class:
 * the duplicate carries a different token. This scans by FUNCTION instead —
 * keyword overlap against every registered tool's name + description — so a
 * near-duplicate surfaces in-band, at propose time, in the tool result the
 * weak chat model actually reads (a persona line it read 4k tokens ago does
 * not steer it; a `possible_duplicates` field in the immediate result does).
 *
 * Deliberately a SOFT signal (candidates, not a hard block): a heuristic must
 * never refuse a genuinely-novel tool. It surfaces the most-similar existing
 * tools and lets Beatrice confirm the gap is real.
 */
import type { ToolRegistry } from '@core/tool_registry';

export interface ExistingToolMatch {
  name: string;
  description: string;
  /** Overlap score — name-token hits weigh double a description-token hit. */
  score: number;
}

/** Connective/boilerplate tokens that carry no duplicate signal. NOT filtered:
 *  domain verbs like `update`/`patch`/`record` — those are the signal. */
const GENERIC = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'its', 'from', 'into', 'tool',
  'new', 'add', 'adds', 'existing', 'field', 'fields', 'value', 'values', 'use',
  'used', 'uses', 'via', 'per', 'when', 'each', 'any', 'all', 'one', 'only',
]);

function tokenize(s: string): Set<string> {
  const out = new Set<string>();
  for (const t of s.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
    if (t.length >= 3 && !GENERIC.has(t)) out.add(t);
  }
  return out;
}

/**
 * Find registered tools whose name/description overlap `query` (a proposed
 * tool name + its spec). A name-token hit weighs double — a name collision is
 * a far stronger duplicate signal than a shared description word. Returns the
 * top matches at or above `min_score`, most-similar first. Dispatch-only tools
 * are included (a duplicate of a dispatch tool is still a duplicate).
 */
export function scan_existing_tools(
  registry: ToolRegistry,
  query: string,
  opts: { limit?: number; min_score?: number } = {},
): ExistingToolMatch[] {
  const limit = opts.limit ?? 5;
  const min_score = opts.min_score ?? 3;
  const q = tokenize(query);
  if (q.size === 0) return [];

  const matches: ExistingToolMatch[] = [];
  for (const tool of registry.list()) {
    const nameTokens = tokenize(tool.name);
    const descTokens = tokenize(tool.description ?? '');
    let score = 0;
    for (const t of q) {
      if (nameTokens.has(t)) score += 2;
      else if (descTokens.has(t)) score += 1;
    }
    if (score >= min_score) {
      matches.push({ name: tool.name, description: tool.description ?? '', score });
    }
  }
  return matches.sort((a, b) => b.score - a.score).slice(0, limit);
}
