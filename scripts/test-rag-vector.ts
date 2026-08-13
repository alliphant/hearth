export {};
/**
 * Self-contained test for the RAG vector-retrieval pipeline (Pass 7).
 * Temp DB + temp vault + a deterministic MockEmbedder — no orchestrator,
 * no real embeddings server, no LLM.
 *
 * Covers the load-bearing pieces:
 *   - BLOB pack/unpack round-trip + cosine ranking
 *   - MemoryClient.upsert/delete_chunk_embeddings + vector_search
 *   - vector_search honors scope, private_to cordon, and dim-mismatch skip
 *   - rrf_fuse pure semantics
 *   - retrieve_hybrid: FTS-only when disabled (byte-identical fallback),
 *     fuse+rerank when enabled, FTS fallback when embed throws
 *
 *   bun run smoke:rag-vector
 */

import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { open_db } from '@memory/stores/structured';
import { MemoryClient } from '@memory/client';
import { pack_f32, unpack_f32, cosine, type Embedder, NOOP_EMBEDDER } from '@core/embeddings';
import { rrf_fuse, retrieve_hybrid } from '@core/retrieval';
import type { ScopedChunkHit } from '@memory/client';

let passed = 0;
function check(label: string, cond: boolean): void {
  if (!cond) {
    console.error(`  ✗ ${label}`);
    process.exit(1);
  }
  console.log(`  ✓ ${label}`);
  passed++;
}

// ── Deterministic mock embedder ───────────────────────────────────────────
// Bag-of-words over a fixed vocab so cosine is meaningful and assertable.
const VOCAB = ['knee', 'rehab', 'squat', 'invoice', 'dell', 'laptop', 'prednisone', 'dog'];
function vec_for(text: string): number[] {
  const t = text.toLowerCase();
  return VOCAB.map((w) => (t.includes(w) ? 1 : 0));
}
class MockEmbedder implements Embedder {
  readonly enabled = true;
  readonly model = 'mock-bow-v1';
  embed_calls = 0;
  async embed(texts: string[]): Promise<number[][]> {
    this.embed_calls++;
    return texts.map(vec_for);
  }
  async rerank(query: string, docs: string[]): Promise<number[] | null> {
    const q = vec_for(query);
    const qf = Float32Array.from(q);
    return docs.map((d) => cosine(qf, Float32Array.from(vec_for(d))));
  }
}
class ThrowingEmbedder implements Embedder {
  readonly enabled = true;
  readonly model = 'throws';
  async embed(): Promise<number[][]> {
    throw new Error('embeddings server down');
  }
  async rerank(): Promise<number[] | null> {
    return null;
  }
}

function write_note(vault: string, rel: string, frontmatter: string, body: string): void {
  const abs = join(vault, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, `---\n${frontmatter}\n---\n\n${body}\n`);
}

function insert_chunk(
  db: ReturnType<typeof open_db>,
  note_path: string,
  idx: number,
  text: string,
): void {
  db.prepare(
    `INSERT INTO chunks_fts (note_path, chunk_idx, chunk_text) VALUES (@p, @i, @c)`,
  ).run({ '@p': note_path, '@i': idx, '@c': text });
}

async function main() {
  // ── pure helpers ─────────────────────────────────────────────────────
  console.log('→ pack/unpack round-trip + cosine');
  {
    const v = [0.1, -0.5, 0.9, 0.0, 1.0];
    const back = unpack_f32(pack_f32(v));
    check('round-trip preserves length', back.length === v.length);
    check(
      'round-trip preserves values (f32 precision)',
      v.every((x, i) => Math.abs((back[i] as number) - x) < 1e-6),
    );
    const a = Float32Array.from([1, 0, 0]);
    check('cosine identical = 1', Math.abs(cosine(a, a) - 1) < 1e-6);
    check('cosine orthogonal = 0', Math.abs(cosine(a, Float32Array.from([0, 1, 0]))) < 1e-6);
    check('cosine dim-mismatch = 0 (defensive)', cosine(a, Float32Array.from([1, 0])) === 0);
  }

  console.log('→ rrf_fuse merges + dedups on (note_path, chunk_idx)');
  {
    const mk = (p: string, i: number): ScopedChunkHit => ({
      note_path: p,
      chunk_idx: i,
      chunk_text: `${p}#${i}`,
      score: 0,
      trust_tier: null,
      title: null,
      as_of: null,
    });
    const lex = [mk('a', 0), mk('b', 0), mk('c', 0)];
    const vec = [mk('c', 0), mk('a', 0), mk('d', 0)];
    const fused = rrf_fuse([lex, vec]);
    const keys = fused.map((h) => `${h.note_path}${h.chunk_idx}`);
    check('dedups to 4 unique chunks', new Set(keys).size === 4 && fused.length === 4);
    // a and c each appear in BOTH lists near the top → should outrank b/d.
    check('items in both lists rank above singletons', keys[0] === 'a0' || keys[0] === 'c0');
    check('b0 and d0 (single-list) are last', keys.slice(2).every((k) => k === 'b0' || k === 'd0'));
  }

  // ── DB-backed vector_search ──────────────────────────────────────────
  const vault = mkdtempSync(join(tmpdir(), 'rag-vault-'));
  const db = open_db(join(mkdtempSync(join(tmpdir(), 'rag-db-')), 'hearth.db'));
  const memory = new MemoryClient({ vault_root: vault, db });
  const emb = new MockEmbedder();

  // Three library notes, each one chunk. knee-rehab (Astrid), dell-laptop
  // (Vivian), and a Sam-private knee note.
  const KNEE = 'Knowledge/Astrid/library/knee.md';
  const DELL = 'Knowledge/Vivian/library/dell.md';
  const PRIV = 'Knowledge/Astrid/library/sam-knee.md';
  write_note(vault, KNEE, 'type: clipping\ntitle: Knee rehab\ntrust_tier: 1\nprivate_to: household', 'knee rehab squat progressions');
  write_note(vault, DELL, 'type: clipping\ntitle: Dell invoice\nprivate_to: household', 'dell laptop invoice total');
  write_note(vault, PRIV, 'type: clipping\ntitle: Sam knee\nprivate_to: sam', 'knee rehab for sam only');
  for (const [p, txt] of [
    [KNEE, 'knee rehab squat progressions'],
    [DELL, 'dell laptop invoice total'],
    [PRIV, 'knee rehab for sam only'],
  ] as const) {
    insert_chunk(db, p, 0, txt);
  }
  // Embed all three.
  for (const [p, txt] of [
    [KNEE, 'knee rehab squat progressions'],
    [DELL, 'dell laptop invoice total'],
    [PRIV, 'knee rehab for sam only'],
  ] as const) {
    const [v] = await emb.embed([txt]);
    memory.upsert_chunk_embeddings(p, [{ chunk_idx: 0, embedding: v! }], emb.model);
  }

  console.log('→ vector_search ranks by cosine');
  {
    const [qv] = await emb.embed(['knee rehab program']);
    const hits = memory.vector_search(qv!, { knowledge_scope: ['**'], k: 5, user_tier: 'owner' });
    check('knee note ranks first for a knee query', hits[0]?.note_path === KNEE);
    check('returns chunk_text + trust_tier from frontmatter', hits[0]?.trust_tier === 1);
    check('dell note ranks below knee', hits.findIndex((h) => h.note_path === DELL) > 0);
  }

  console.log('→ vector_search honors knowledge_scope');
  {
    const [qv] = await emb.embed(['knee rehab']);
    const hits = memory.vector_search(qv!, {
      knowledge_scope: ['Knowledge/Vivian/**'],
      k: 5,
      user_tier: 'owner',
    });
    check('Astrid notes excluded by Vivian-only scope', hits.every((h) => h.note_path.startsWith('Knowledge/Vivian/')));
  }

  console.log('→ vector_search honors the private_to cordon');
  {
    const [qv] = await emb.embed(['knee rehab']);
    // Sam querying: sees household + her own, NOT jasper-only; here PRIV is sam's.
    const as_sara = memory.vector_search(qv!, {
      knowledge_scope: ['**'],
      k: 5,
      user_id: 'sam',
      user_tier: 'household',
    });
    check('Sam sees her own private knee note', as_sara.some((h) => h.note_path === PRIV));
    // Jasper (owner) must NOT see Sam's private note via retrieval (pure cordon).
    const as_jasper = memory.vector_search(qv!, {
      knowledge_scope: ['**'],
      k: 5,
      user_id: 'jasper',
      user_tier: 'owner',
    });
    check("owner does NOT see Sam's private note (no god-view)", as_jasper.every((h) => h.note_path !== PRIV));
    check('owner still sees household knee note', as_jasper.some((h) => h.note_path === KNEE));
  }

  console.log('→ dim-mismatch rows are skipped, not scored as garbage');
  {
    // A 3-dim query against 8-dim stored vectors → no matches, no crash.
    const hits = memory.vector_search([1, 0, 0], { knowledge_scope: ['**'], k: 5, user_tier: 'owner' });
    check('mismatched-dim query returns nothing (skipped)', hits.length === 0);
  }

  console.log('→ delete_chunk_embeddings drops a note vectors');
  {
    memory.delete_chunk_embeddings(DELL);
    const [qv] = await emb.embed(['dell laptop']);
    const hits = memory.vector_search(qv!, { knowledge_scope: ['**'], k: 5, user_tier: 'owner' });
    check('deleted note no longer in vector results', hits.every((h) => h.note_path !== DELL));
  }

  // ── retrieve_hybrid ──────────────────────────────────────────────────
  console.log('→ retrieve_hybrid: disabled embedder == FTS-only (no embed call)');
  {
    const hits = await retrieve_hybrid({
      memory,
      embedder: NOOP_EMBEDDER,
      query: 'knee rehab',
      knowledge_scope: ['**'],
      k: 5,
      user_tier: 'owner',
    });
    // FTS finds the knee note(s) by keyword; result is the plain FTS path.
    check('FTS-only path returns knee note', hits.some((h) => h.note_path === KNEE));
  }

  console.log('→ retrieve_hybrid: enabled fuses + reranks (embed called)');
  {
    const before = emb.embed_calls;
    const hits = await retrieve_hybrid({
      memory,
      embedder: emb,
      query: 'knee rehab squat',
      knowledge_scope: ['**'],
      k: 3,
      user_tier: 'owner',
    });
    check('hybrid path called the embedder', emb.embed_calls > before);
    check('hybrid returns the knee note first', hits[0]?.note_path === KNEE);
  }

  console.log('→ retrieve_hybrid: embed throwing falls back to FTS (fail-open)');
  {
    const hits = await retrieve_hybrid({
      memory,
      embedder: new ThrowingEmbedder(),
      query: 'knee rehab',
      knowledge_scope: ['**'],
      k: 5,
      user_tier: 'owner',
    });
    check('throwing embedder still returns FTS results', hits.some((h) => h.note_path === KNEE));
  }

  console.log('→ retrieve_hybrid: a synthesis note LEADS even when it reranks lower (#1)');
  {
    // Seed a distilled synthesis on the knee topic whose text overlaps the
    // query LESS than the raw KNEE note — so it reranks strictly lower. The
    // read-path prior must still float it to the front (the curated view leads).
    const SYN = 'Knowledge/Astrid/library/_synthesis/shelf-knee.md';
    write_note(vault, SYN, 'type: synthesis_note\ntitle: Knee — synthesis\nprivate_to: household', 'knee rehab');
    insert_chunk(db, SYN, 0, 'knee rehab');
    const [sv] = await emb.embed(['knee rehab']);
    memory.upsert_chunk_embeddings(SYN, [{ chunk_idx: 0, embedding: sv! }], emb.model);

    const args = { memory, embedder: emb, query: 'knee rehab squat', knowledge_scope: ['**'], k: 5, user_tier: 'owner' as const };
    const led = await retrieve_hybrid(args);
    check('synthesis leads the result', led[0]?.note_path === SYN);
    check('the raw KNEE note (higher rerank) is still present, just below', led.some((h) => h.note_path === KNEE) && led.findIndex((h) => h.note_path === KNEE) > 0);

    // Kill switch reverts to pure rerank order — and proves it's reorder-only:
    // the SET of note_paths is identical, only the order differs.
    process.env.HEARTH_SYNTHESIS_LEAD = '0';
    const raw = await retrieve_hybrid(args);
    delete process.env.HEARTH_SYNTHESIS_LEAD;
    check('kill switch: the higher-reranked raw note leads instead', raw[0]?.note_path === KNEE);
    check('promotion is reorder-only (same set, different order)',
      new Set(led.map((h) => h.note_path)).size === new Set(raw.map((h) => h.note_path)).size &&
      led.every((h) => raw.some((r) => r.note_path === h.note_path)));

    // #2 worth instrument: every retrieval that surfaced the synthesis stamped
    // its usage counter (both queries above retrieved SYN into the top-k).
    const u = memory.get_synthesis_usage([SYN]).get(SYN);
    check('retrieve_hybrid recorded synthesis usage (#2)', (u?.hits ?? 0) >= 2 && typeof u?.last_retrieved_at === 'string');
    check('a raw note is NOT counted as synthesis usage', memory.get_synthesis_usage([KNEE]).size === 0);
  }

  console.log('→ low-confidence gate: suppress weak reranked pools, pass strong/unscored');
  {
    const { gate_low_confidence_rag } = await import('../src/core/specialist_runtime');
    const mk = (score: number | undefined): ScopedChunkHit => ({
      note_path: 'Knowledge/X/a.md',
      chunk_idx: 0,
      chunk_text: 'x',
      score: 0,
      trust_tier: null,
      title: null,
      as_of: null,
      ...(score !== undefined ? { rerank_score: score } : {}),
    });
    const weak = gate_low_confidence_rag([mk(0.04), mk(0.01)]);
    check('all-weak reranked pool is SUPPRESSED', weak.suppressed && weak.hits.length === 0);
    const strong = gate_low_confidence_rag([mk(0.71), mk(0.02)]);
    check('one strong hit keeps the pool', !strong.suppressed && strong.hits.length === 2);
    const unscored = gate_low_confidence_rag([mk(undefined), mk(undefined)]);
    check('FTS-only (unscored) pool passes through untouched', !unscored.suppressed && unscored.hits.length === 2);
    check('empty pool is not "suppressed"', gate_low_confidence_rag([]).suppressed === false);
  }

  console.log(`\n✓ ${passed} checks passed. smoke-rag-vector done.`);
}

main().catch((err) => {
  console.error('smoke-rag-vector failed:', err);
  process.exit(1);
});
