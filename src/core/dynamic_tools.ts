/**
 * Dynamic tool surface (2026-06-08) — decouple tool AWARENESS from tool
 * INVOCATION SCHEMAS on a chat turn.
 *
 * The problem: every turn ships each tool twice — as cheap `tool_summary`
 * lines (awareness) AND as an expensive `zodToJsonSchema` entry in the
 * `tools:` array (the invocation grammar; the backend also compiles a GBNF
 * grammar over all of them). Today both are fed the SAME curated list, so the
 * only way to cut schema cost is to HIDE tools (curation) — losing reach.
 * Kate's 37-tool chat surface is ~9.8K+ tokens of tool schemas alone, the bulk
 * of a chat-turn prefill, even though she calls 0–2 tools/turn.
 *
 * The fix: produce TWO lists. A `catalog` (full capability-granted set →
 * awareness, rendered as name+description) and a small `hot` set (→ schemas).
 * A non-LLM tool-RAG pre-pass picks the hot set by cosine-ranking the user
 * message against each tool's `"name: description"` vector; a `load_tools`
 * meta-tool lets the model pull any catalog tool's schema on demand mid-turn
 * (the escape hatch for a ranking miss). The runtime owns the per-turn wiring;
 * this module is the pure logic (embedder injected) so it's unit-testable with
 * a fake embedder and adds nothing to the hot file.
 *
 * Fail-open is the contract: a disabled/erroring embedder degrades to today's
 * curated surface (the caller catches), never worse than the status quo.
 */

import { z } from 'zod';
import { cosine, norm, type Embedder } from './embeddings';

/** The meta-tool name (handled inline by the runtime, never registered). */
export const LOAD_TOOLS_NAME = 'load_tools';

/** How many message-ranked tools to seed the hot set with (before the floor). */
export const DYNAMIC_TOOL_RAG_K = 6;

/** Hard cap on the round-0 hot set (floor is never dropped to honor it). */
export const MAX_HOT_TOOLS = 12;

/**
 * Hot-set cap for a DELIBERATION pass (2026-08-05).
 *
 * Larger than the chat cap because a scheduled pass legitimately touches more
 * of its surface in one go — a brief pulls weather, calendar, house, pets and
 * the proposal bench in a single envelope, with no user to ask for the next
 * step. Still a fraction of the 44 tools Kate's deliberation surface was
 * shipping in full, which measured 14,595 tokens — 43% of a static prompt that
 * was itself busting the window ("STATIC PROMPT TOO BIG — nothing was
 * evictable", 20 occurrences in 48h across kate/ruby/trainer).
 */
export const MAX_HOT_TOOLS_DELIBERATION = 20;

/** Cap on tools `load_tools` may pull in over a whole turn (bounds re-bloat). */
export const MAX_TOTAL_LOADED = 20;

/**
 * Real catalog tools that are ALWAYS in the hot set when dynamic mode is on, so
 * the model is never stranded without its knowledge floor. (`load_tools` and
 * `consult_specialist` are meta-tools the runtime appends to `tool_defs`
 * separately, exactly as it already does for consult — they are not catalog
 * entries, so they are not listed here.)
 */
export const FLOOR_TOOL_NAMES: readonly string[] = ['search_library', 'present_questions'];

/**
 * Additional hot-set floor for a DELIBERATION pass (2026-08-05).
 *
 * A pass's standing duties pin the tools it READS with; these are the three it
 * ACTS with, and they are the same for every specialist, so they belong in the
 * runtime rather than in each persona's `dynamic_tools_floor` (which is shared
 * with chat, where pinning them would spend budget for no reason).
 *
 * The failure being avoided is subtle and expensive: a pass that surfaces
 * something worth filing, and then has to spend a tool round on `load_tools`
 * before it can file it, is a pass that may simply not file. Unlike a chat turn
 * there is no user to prompt for the missing step, and the round budget is the
 * only thing standing between the envelope and a timeout.
 */
export const DELIBERATION_FLOOR_TOOL_NAMES: readonly string[] = [
  'propose_action',
  'recommend_to_user',
  'read_inbox',
];

/**
 * A small additive cosine bonus for tools on the specialist's curated
 * `tools_for_chat` list — a soft prior that nudges a borderline known-good tool
 * into the hot set without overriding a strong message match.
 */
export const PRIOR_BONUS = 0.05;

/** Minimal structural shape this module needs from a tool. */
export interface CatalogTool {
  name: string;
  description: string;
}

/** A cached tool-description embedding, keyed by tool name in the runtime. */
export interface CachedVec {
  /** Hash of `"name: description"` — re-embed when it changes (hot-reload). */
  hash: string;
  vec: Float32Array;
}

/** Cheap, dependency-free string hash (djb2) for cache invalidation. */
function hash_str(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

/** The exact text we embed + render for a tool (matches `tool_summary`). */
export function tool_embed_text(t: CatalogTool): string {
  return `${t.name}: ${t.description}`;
}

/**
 * Rank the catalog by relevance to the user message and return the top-K tool
 * NAMES (the caller unions in the floor). One embed() call per turn: the
 * message plus any tools whose vectors are stale/uncached (warm turns embed
 * only the message). Tool vectors are cached by the caller across turns.
 *
 * Throws only if `embedder.embed` throws — the caller MUST try/catch and fall
 * back to the curated surface. Returns [] (→ caller falls back) on an empty
 * catalog or a malformed embedder response.
 */
export async function rank_tools_for_message<T extends CatalogTool>(opts: {
  message: string;
  catalog: T[];
  embedder: Embedder;
  cache: Map<string, CachedVec>;
  priors?: ReadonlySet<string>;
  k?: number;
}): Promise<string[]> {
  const { message, catalog, embedder, cache, priors, k = DYNAMIC_TOOL_RAG_K } = opts;
  if (catalog.length === 0) return [];

  // Which tools need embedding (cache miss or description changed).
  const stale: Array<{ name: string; text: string; hash: string }> = [];
  for (const t of catalog) {
    const text = tool_embed_text(t);
    const h = hash_str(text);
    const cached = cache.get(t.name);
    if (!cached || cached.hash !== h) stale.push({ name: t.name, text, hash: h });
  }

  // One batched call: [message, ...stale tool texts]. Warm cache → just [message].
  const batch = [message, ...stale.map((s) => s.text)];
  const vecs = await embedder.embed(batch);
  if (!Array.isArray(vecs) || vecs.length !== batch.length) return [];

  const qvec = new Float32Array(vecs[0]!);
  const qn = norm(qvec);
  stale.forEach((s, i) => {
    cache.set(s.name, { hash: s.hash, vec: new Float32Array(vecs[i + 1]!) });
  });

  const scored = catalog.map((t) => {
    const c = cache.get(t.name);
    let score = c ? cosine(qvec, c.vec, qn) : -1;
    if (priors?.has(t.name)) score += PRIOR_BONUS;
    return { name: t.name, score };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, k).map((s) => s.name);
}

/**
 * Compose the round-0 hot set: floor first (never dropped), then the ranked
 * tail up to `cap`. Deduped; preserves the passed tool objects (so the caller
 * keeps `input_schema` for `to_tooldef`). Names not in the catalog are skipped.
 */
export function compose_hot_set<T extends { name: string }>(
  catalog: T[],
  ranked_names: readonly string[],
  floor_names: readonly string[],
  cap: number,
): T[] {
  const by_name = new Map(catalog.map((t) => [t.name, t]));
  const ordered: string[] = [];
  const seen = new Set<string>();
  const add = (n: string) => {
    if (by_name.has(n) && !seen.has(n)) {
      seen.add(n);
      ordered.push(n);
    }
  };
  for (const n of floor_names) add(n); // floor is exempt from the cap
  for (const n of ranked_names) {
    if (ordered.length >= cap) break;
    add(n);
  }
  return ordered.map((n) => by_name.get(n)!);
}

/**
 * Compact one-line-per-tool rendering for the load-on-demand ("rest") tier:
 * name + a TRUNCATED description. The model only needs enough to know WHICH
 * tool to `load_tools`; the full description + JSON schema arrive on load.
 * Keeping the rest tier terse is what makes full-catalog awareness near-free —
 * rendered with FULL descriptions, a broad grant (Kate: 71 tools) would offset
 * most of the schema win. The hot/ready tier keeps full descriptions (it's
 * callable now). Default 60 chars ≈ one short clause.
 */
export function compact_catalog_lines(
  tools: ReadonlyArray<CatalogTool>,
  max_desc = 60,
): string {
  return tools
    .map((t) => {
      const d =
        t.description.length > max_desc
          ? t.description.slice(0, max_desc - 1).trimEnd() + '…'
          : t.description;
      return `  - ${t.name}: ${d}`;
    })
    .join('\n');
}

/** Split the catalog into the hot ("ready") set vs the rest (load-on-demand). */
export function partition_awareness<T extends { name: string }>(
  catalog: T[],
  hot: T[],
): { ready: T[]; rest: T[] } {
  const hot_names = new Set(hot.map((t) => t.name));
  return { ready: hot, rest: catalog.filter((t) => !hot_names.has(t.name)) };
}

/** Validated args for the `load_tools` meta-tool. */
export const LoadToolsInputSchema = z.object({
  names: z.array(z.string().min(1)).min(1).max(MAX_TOTAL_LOADED),
});
export type LoadToolsInput = z.infer<typeof LoadToolsInputSchema>;

/**
 * Resolve a `load_tools` request against the catalog. Capability-safe by
 * construction: the catalog passed in IS the specialist's granted set, so a
 * name not in it is `missing` (never loaded) — the model cannot escalate.
 * Idempotent (already-hot → `already`); bounded by `cap` over the turn.
 * Pure — the runtime does the `tool_defs` mutation (where the by-reference +
 * `to_tooldef` contract lives).
 */
export function apply_load_tools<T extends { name: string }>(opts: {
  names: readonly string[];
  catalog: T[];
  hotNames: ReadonlySet<string>;
  total_loaded: number;
  cap?: number;
}): { newly: T[]; already: string[]; missing: string[]; capped: string[] } {
  const { names, catalog, hotNames, total_loaded, cap = MAX_TOTAL_LOADED } = opts;
  const by_name = new Map(catalog.map((t) => [t.name, t]));
  const newly: T[] = [];
  const already: string[] = [];
  const missing: string[] = [];
  const capped: string[] = [];
  const seen = new Set<string>();
  for (const raw of names) {
    const n = raw.trim();
    if (!n || seen.has(n)) continue;
    seen.add(n);
    if (hotNames.has(n)) {
      already.push(n);
      continue;
    }
    const tool = by_name.get(n);
    if (!tool) {
      missing.push(n);
      continue;
    }
    if (total_loaded + newly.length >= cap) {
      capped.push(n);
      continue;
    }
    newly.push(tool);
  }
  return { newly, already, missing, capped };
}

/** Build the concise tool-result message `load_tools` returns to the model. */
export function format_load_tools_result(res: {
  newly: Array<{ name: string }>;
  already: string[];
  missing: string[];
  capped: string[];
}): string {
  const parts: string[] = [];
  if (res.newly.length) {
    parts.push(
      `Loaded ${res.newly.map((t) => t.name).join(', ')} — you can call ` +
        `${res.newly.length === 1 ? 'it' : 'them'} directly now.`,
    );
  }
  if (res.already.length) parts.push(`Already available: ${res.already.join(', ')}.`);
  if (res.missing.length) {
    parts.push(
      `Not available to you: ${res.missing.join(', ')} — use consult_specialist ` +
        `to reach the teammate who owns that capability.`,
    );
  }
  if (res.capped.length) {
    parts.push(
      `Skipped (per-turn tool budget reached): ${res.capped.join(', ')}. ` +
        `Answer with what you have or schedule a follow-up.`,
    );
  }
  return parts.join(' ') || 'No tools loaded.';
}
