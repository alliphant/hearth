/**
 * Embeddings + rerank client for the RAG retrieval pipeline (Pass 7).
 *
 * The chat `LLMProvider` interface is `complete()`-only — embeddings and
 * reranking are a different wire shape (OpenAI `/v1/embeddings`; a
 * `/rerank` endpoint), served by a dedicated TEI/infinity instance on the
 * A4000 (`host.docker.internal:8091`), NOT the beellama chat servers. So
 * this is its own thin HTTP client rather than a provider method.
 *
 * EVERYTHING here is gated by `HEARTH_RAG_VECTOR`. When the flag is off (or
 * no embeddings endpoint is configured) the orchestrator wires a
 * `NoopEmbedder` whose `.enabled === false`, and the hybrid retrieval path
 * degrades to pure FTS — byte-identical to pre-RAG behavior. So this module
 * is safe to ship dark.
 *
 * Fail-open is the contract end to end: a down/slow embeddings server must
 * never break ingest or a chat turn. `embed()` throws (callers catch +
 * fall back to FTS); `rerank()` returns null (caller keeps prior order).
 */

// ── BLOB (de)serialization — Float32 little-endian, shared with MemoryClient ──

/** Pack a vector into a Uint8Array for a SQLite BLOB column (Float32 LE). */
export function pack_f32(vec: number[] | Float32Array): Uint8Array {
  const f = vec instanceof Float32Array ? vec : Float32Array.from(vec);
  return new Uint8Array(f.buffer, f.byteOffset, f.byteLength);
}

/**
 * Unpack a SQLite BLOB back into a Float32Array. Copies into a fresh
 * 0-offset buffer first so the Float32Array view is 4-byte aligned
 * regardless of the source Uint8Array's byteOffset (bun:sqlite may hand
 * back a view into a larger buffer).
 */
export function unpack_f32(blob: Uint8Array): Float32Array {
  const copy = new Uint8Array(blob.length);
  copy.set(blob);
  return new Float32Array(copy.buffer);
}

/** L2 norm of a vector. */
export function norm(v: Float32Array | number[]): number {
  let s = 0;
  for (let i = 0; i < v.length; i++) s += (v[i] as number) * (v[i] as number);
  return Math.sqrt(s);
}

/**
 * Cosine similarity in [-1, 1]. Pass a precomputed `a_norm` when scoring one
 * query against many docs to avoid recomputing the query norm each call.
 * Returns 0 for a zero vector or a dimension mismatch (defensive — mixed
 * embedding models must never crash a query).
 */
export function cosine(
  a: Float32Array,
  b: Float32Array,
  a_norm?: number,
): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  let bn = 0;
  for (let i = 0; i < a.length; i++) {
    const av = a[i] as number;
    const bv = b[i] as number;
    dot += av * bv;
    bn += bv * bv;
  }
  const an = a_norm ?? norm(a);
  const denom = an * Math.sqrt(bn);
  return denom === 0 ? 0 : dot / denom;
}

// ── Embedder interface ────────────────────────────────────────────────────

export interface Embedder {
  /** False => RAG vector path is off; callers degrade to FTS-only. */
  readonly enabled: boolean;
  /** The embedding model id (stored per chunk_embeddings row for mismatch detection). */
  readonly model: string;
  /**
   * Embed each text → one vector (same order). Throws on transport error —
   * callers MUST try/catch and fall back. Returns [] for an empty input.
   */
  embed(texts: string[]): Promise<number[][]>;
  /**
   * Rerank `docs` by relevance to `query`. Returns a score per doc (same
   * order, higher = more relevant), or `null` when reranking is unavailable
   * or fails (caller keeps the pre-rerank order). Never throws.
   */
  rerank(query: string, docs: string[]): Promise<number[] | null>;
}

/** The off state: wired whenever HEARTH_RAG_VECTOR is unset/0 or no endpoint. */
export class NoopEmbedder implements Embedder {
  readonly enabled = false;
  readonly model = 'noop';
  async embed(): Promise<number[][]> {
    return [];
  }
  async rerank(): Promise<number[] | null> {
    return null;
  }
}

/** Process-wide FTS-only fallback — used wherever no embedder is wired. */
export const NOOP_EMBEDDER: Embedder = new NoopEmbedder();

export interface HttpEmbedderConfig {
  base_url: string; // OpenAI-compat, e.g. http://host.docker.internal:8091/v1
  model: string; // e.g. bge-large-en-v1.5
  api_key?: string; // TEI/infinity usually ignore it; sent if present
  /** Rerank endpoint (often the SAME infinity server). Omit to disable rerank. */
  reranker_base_url?: string;
  reranker_model?: string;
  timeout_ms?: number; // default 30s
}

/**
 * OpenAI-compatible embeddings + rerank over HTTP. Targets infinity's API
 * (one server serving both an embedding and a rerank model); the rerank
 * parser is lenient enough to also accept TEI's `[{index,score}]` shape.
 */
export class HttpEmbedder implements Embedder {
  readonly enabled = true;
  readonly model: string;
  private readonly cfg: HttpEmbedderConfig;
  private readonly timeout_ms: number;

  constructor(cfg: HttpEmbedderConfig) {
    this.cfg = cfg;
    this.model = cfg.model;
    this.timeout_ms = cfg.timeout_ms ?? 30_000;
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { 'content-type': 'application/json' };
    if (this.cfg.api_key) h['authorization'] = `Bearer ${this.cfg.api_key}`;
    return h;
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const res = await fetch(`${this.cfg.base_url.replace(/\/$/, '')}/embeddings`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ model: this.cfg.model, input: texts }),
      signal: AbortSignal.timeout(this.timeout_ms),
    });
    if (!res.ok) {
      throw new Error(`embeddings ${res.status}: ${(await res.text()).slice(0, 200)}`);
    }
    const json = (await res.json()) as {
      data?: Array<{ embedding: number[]; index: number }>;
    };
    const data = json.data;
    if (!Array.isArray(data) || data.length !== texts.length) {
      throw new Error(
        `embeddings response shape: expected ${texts.length} vectors, got ${data?.length ?? 'none'}`,
      );
    }
    // Order by `index` — the server may not preserve input order.
    const out: number[][] = new Array(texts.length);
    for (const row of data) {
      if (!Array.isArray(row.embedding) || typeof row.index !== 'number') {
        throw new Error('embeddings response: malformed row');
      }
      out[row.index] = row.embedding;
    }
    for (let i = 0; i < out.length; i++) {
      if (!out[i]) throw new Error(`embeddings response: missing vector at index ${i}`);
    }
    return out;
  }

  async rerank(query: string, docs: string[]): Promise<number[] | null> {
    if (!this.cfg.reranker_model || !this.cfg.reranker_base_url || docs.length === 0) {
      return null;
    }
    try {
      const res = await fetch(`${this.cfg.reranker_base_url.replace(/\/$/, '')}/rerank`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({
          model: this.cfg.reranker_model,
          query,
          documents: docs, // infinity
          return_documents: false,
        }),
        signal: AbortSignal.timeout(this.timeout_ms),
      });
      if (!res.ok) return null;
      const json = (await res.json()) as
        | { results?: Array<{ index: number; relevance_score?: number; score?: number }> }
        | Array<{ index: number; score?: number; relevance_score?: number }>;
      // infinity: { results: [{index, relevance_score}] }; TEI: [{index, score}].
      const rows = Array.isArray(json) ? json : json.results;
      if (!Array.isArray(rows)) return null;
      const scores = new Array<number>(docs.length).fill(Number.NEGATIVE_INFINITY);
      for (const r of rows) {
        const s = r.relevance_score ?? r.score;
        if (typeof r.index === 'number' && typeof s === 'number' && r.index < scores.length) {
          scores[r.index] = s;
        }
      }
      return scores;
    } catch {
      return null; // fail-open: keep the pre-rerank (RRF) order
    }
  }
}

/** Master flag. RAG vector retrieval is dark unless this is set truthy. */
export function rag_vector_enabled(): boolean {
  const v = process.env.HEARTH_RAG_VECTOR;
  return v === '1' || v === 'true' || v === 'on';
}

/**
 * Build the process embedder. Returns a `NoopEmbedder` (enabled=false) when
 * the flag is off or no embeddings endpoint resolves — so every downstream
 * caller is unconditional (`if (embedder.enabled)`), never null-checked.
 */
export function make_embedder(
  endpoints: {
    embeddings?: { base_url: string; model: string; api_key?: string } | null;
    reranker?: { base_url: string; model: string; api_key?: string } | null;
  },
): Embedder {
  if (!rag_vector_enabled()) return new NoopEmbedder();
  const emb = endpoints.embeddings;
  if (!emb?.base_url || !emb.model) return new NoopEmbedder();
  return new HttpEmbedder({
    base_url: emb.base_url,
    model: emb.model,
    ...(emb.api_key ? { api_key: emb.api_key } : {}),
    ...(endpoints.reranker?.base_url
      ? { reranker_base_url: endpoints.reranker.base_url }
      : {}),
    ...(endpoints.reranker?.model ? { reranker_model: endpoints.reranker.model } : {}),
  });
}
