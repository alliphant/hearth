/**
 * Hybrid retrieval — the query side of the RAG pipeline (Pass 7).
 *
 * Fuses the existing lexical FTS path (`MemoryClient.retrieve_scoped_chunks`)
 * with vector cosine search (`MemoryClient.vector_search`) via Reciprocal
 * Rank Fusion, then optionally reranks the fused pool with a cross-encoder.
 *
 * Designed so the two hot call sites (turn-start auto-RAG in
 * specialist_runtime, and the `search_library` tool) can swap in one
 * `await retrieve_hybrid(...)` with NO behavior change while the vector path
 * is dark: when `embedder.enabled` is false — or the query embed fails, or
 * the corpus has no embeddings yet — this returns exactly the FTS result
 * (`retrieve_scoped_chunks`), byte-identical to pre-RAG. Fail-open is the
 * contract at every step: retrieval is opportunistic, never load-bearing.
 *
 * The lexical and vector paths BOTH apply `MemoryClient._chunk_gates`, so the
 * `private_to` cordon holds regardless of which path surfaces a chunk.
 */

import type { MemoryClient, ScopedChunkHit } from '@memory/client';
import type { Embedder } from './embeddings';
import type { Tier } from './users';

/** RRF damping constant — the standard 60 from the original RRF paper. */
const RRF_K = 60;

/** Synthesis notes live under `…/library/_synthesis/…` (Cordelia's distill
 *  output). They're the Second Brain's curated, grounded view of a shelf. */
const SYNTHESIS_PATH_RE = /\/_synthesis\//;
/** At most this many distilled syntheses LEAD the context — enough to front the
 *  curated view without crowding out the raw fragments that carry specifics. */
const SYNTH_LEAD_CAP = 2;

function is_synthesis_hit(h: ScopedChunkHit): boolean {
  return SYNTHESIS_PATH_RE.test(h.note_path);
}

/**
 * Privilege the distilled synthesis at read time — the Second Brain's whole
 * payoff. A `synthesis_note` is the grounded, evergreen "what we know about X"
 * for a shelf; when it's topically relevant (i.e. it survived into the ranked
 * pool at all), it should LEAD the injected context, with the raw fragments
 * following for specifics. Scale-free rank-promotion, NOT a calibrated score
 * bonus (which couldn't be tuned against the reranker's opaque scale): stably
 * move the top `SYNTH_LEAD_CAP` synthesis hits to the front, preserving all
 * other order. This is reorder-only — it never changes the SET, so the
 * call-site low-confidence gate (which keys on the pool's MAX rerank score) is
 * unaffected.
 *
 * Deliberately NOT health-gated here: a rotting synthesis (cited sources
 * deleted) is removed from the corpus by the nightly heal pass, and every hit
 * already carries an `as_of` staleness label, so the bounded window between a
 * source deletion and the next heal is self-qualifying in the prompt. Kill
 * switch: HEARTH_SYNTHESIS_LEAD=0.
 */
function lead_with_synthesis(ordered: ScopedChunkHit[]): ScopedChunkHit[] {
  if (process.env.HEARTH_SYNTHESIS_LEAD === '0') return ordered;
  const lead: ScopedChunkHit[] = [];
  const rest: ScopedChunkHit[] = [];
  for (const h of ordered) {
    if (lead.length < SYNTH_LEAD_CAP && is_synthesis_hit(h)) lead.push(h);
    else rest.push(h);
  }
  return lead.length > 0 ? [...lead, ...rest] : ordered;
}

/**
 * Apply the synthesis lead, slice to k, and best-effort record synthesis
 * retrieval USAGE (the worth axis, loop Phase B) — one chokepoint so every
 * return path of `retrieve_hybrid` stamps it. A synthesis that lands in a
 * turn's top-k is being VALUED; one that never does is dead weight the heal
 * pass can prune. Best-effort: a usage-write failure must never break a turn.
 */
function finalize(args: HybridRetrieveArgs, ordered: ScopedChunkHit[], k: number): ScopedChunkHit[] {
  const out = lead_with_synthesis(ordered).slice(0, k);
  const synth_paths = [...new Set(out.filter(is_synthesis_hit).map((h) => h.note_path))];
  if (synth_paths.length > 0) {
    try {
      args.memory.record_synthesis_retrievals(synth_paths, new Date().toISOString());
    } catch (err) {
      console.error('[retrieval] synthesis usage record failed (non-fatal):', err);
    }
  }
  return out;
}

export interface HybridRetrieveArgs {
  memory: MemoryClient;
  embedder: Embedder;
  query: string;
  knowledge_scope: string[];
  k?: number;
  user_id?: string;
  user_tier?: Tier;
  bypass_private?: boolean;
}

function chunk_key(h: ScopedChunkHit): string {
  return `${h.note_path}::${h.chunk_idx}`;
}

/**
 * Reciprocal Rank Fusion over N ranked lists. An item's fused score is
 * `Σ 1/(RRF_K + rank)` across the lists it appears in (rank 0-based), so a
 * chunk that BOTH the lexical and vector paths rank highly floats to the top
 * even if neither ranked it #1. Returns items sorted by fused score desc,
 * deduped on `(note_path, chunk_idx)`.
 */
export function rrf_fuse(lists: ScopedChunkHit[][]): ScopedChunkHit[] {
  const score = new Map<string, number>();
  const hit = new Map<string, ScopedChunkHit>();
  for (const list of lists) {
    for (let rank = 0; rank < list.length; rank++) {
      const h = list[rank]!;
      const key = chunk_key(h);
      score.set(key, (score.get(key) ?? 0) + 1 / (RRF_K + rank));
      if (!hit.has(key)) hit.set(key, h);
    }
  }
  return [...score.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([key]) => hit.get(key)!);
}

/**
 * Run hybrid retrieval. See module header for the fail-open contract.
 */
export async function retrieve_hybrid(args: HybridRetrieveArgs): Promise<ScopedChunkHit[]> {
  const k = args.k ?? 5;
  const visibility = {
    ...(args.user_id !== undefined ? { user_id: args.user_id } : {}),
    ...(args.user_tier !== undefined ? { user_tier: args.user_tier } : {}),
    ...(args.bypass_private !== undefined ? { bypass_private: args.bypass_private } : {}),
  };
  // Over-fetch each path so RRF + rerank have candidates to work with.
  const pool = Math.max(k * 4, 12);

  // Lexical path always runs — it's the fallback AND half the fusion.
  const fts = args.memory.retrieve_scoped_chunks({
    query: args.query,
    knowledge_scope: args.knowledge_scope,
    k: pool,
    ...visibility,
  });

  // Vector path is dark unless the embedder is wired AND the query embeds.
  if (!args.embedder.enabled) return finalize(args, fts, k);

  let vec: ScopedChunkHit[] = [];
  try {
    const vectors = await args.embedder.embed([args.query]);
    const qvec = vectors[0];
    if (qvec && qvec.length > 0) {
      vec = args.memory.vector_search(qvec, {
        knowledge_scope: args.knowledge_scope,
        k: pool,
        ...visibility,
      });
    }
  } catch (err) {
    // Embeddings server down/slow → degrade to lexical. Never break a turn.
    console.error('[retrieval] query embed failed; FTS-only this turn:', err);
  }
  if (vec.length === 0) return finalize(args, fts, k);

  // Fuse, then optionally rerank the fused pool with the cross-encoder.
  const fused = rrf_fuse([fts, vec]);
  const rerank_pool = fused.slice(0, pool);
  const scores = await args.embedder.rerank(
    args.query,
    rerank_pool.map((h) => h.chunk_text),
  );
  if (scores) {
    // Carry the cross-encoder relevance on each hit (additive field) — the
    // auto-RAG call sites gate on it: weak evidence invites blend-with-
    // memory fabrication, so a below-bar retrieval is worth suppressing.
    const reranked = rerank_pool
      .map((h, i) => ({ h, s: scores[i] ?? Number.NEGATIVE_INFINITY }))
      .sort((a, b) => b.s - a.s)
      .map((x) => ({ ...x.h, rerank_score: x.s }));
    return finalize(args, reranked, k);
  }
  return finalize(args, fused, k);
}
