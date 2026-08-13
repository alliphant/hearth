export {};
/**
 * Backfill `chunk_embeddings` for every chunk already in `chunks_fts` (RAG
 * Pass 7). Ingest embeds new uploads going forward; this catches up the
 * existing corpus (and re-embeds after a model swap).
 *
 * Requires the embeddings server reachable AND the roles wired:
 *   HEARTH_RAG_VECTOR=1 \
 *   OPENAI_API_KEY=... OPENAI_BASE_URL=... \
 *   bun run backfill:embeddings            # resumable; skips already-embedded
 *   bun run backfill:embeddings -- --force # re-embed everything (model swap)
 *
 * Resumable: a note whose chunk_embeddings rows already match the current
 * embedding model is skipped unless --force. Safe to re-run after an
 * interruption. Reads the same DB + llm-roles.yaml the orchestrator does.
 */

import { resolve } from 'node:path';
import { open_db } from '@memory/stores/structured';
import { MemoryClient } from '@memory/client';
import { ConfigLLMRouter } from '@core/router';
import { make_embedder } from '@core/embeddings';

async function main() {
  const force = process.argv.includes('--force');
  const DB_PATH = process.env.HEARTH_DB_PATH ?? './data/hearth.db';
  const VAULT_ROOT = process.env.HEARTH_VAULT_ROOT ?? `${process.env.HOME}/vault-friday`;
  const ROLES_PATH = process.env.HEARTH_ROLES_PATH ?? './config/llm-roles.yaml';

  const db = open_db(resolve(DB_PATH));
  const memory = new MemoryClient({ vault_root: VAULT_ROOT, db });
  const llm = new ConfigLLMRouter(ROLES_PATH, {
    ollama_base_url: process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434',
    openai_base_url: process.env.OPENAI_BASE_URL,
    openai_api_key: process.env.OPENAI_API_KEY,
  });
  const embedder = make_embedder({
    embeddings: llm.endpoint_for_role('embeddings'),
    reranker: llm.endpoint_for_role('reranker'),
  });

  if (!embedder.enabled) {
    console.error(
      'Embedder disabled. Set HEARTH_RAG_VECTOR=1 and point the `embeddings` ' +
        'role at a live OpenAI-compat endpoint in llm-roles.yaml. Aborting.',
    );
    process.exit(1);
  }
  console.log(`Backfilling embeddings with model=${embedder.model} (force=${force})`);

  // Every note that has FTS chunks.
  const note_paths = (
    db.prepare(`SELECT DISTINCT note_path FROM chunks_fts ORDER BY note_path`).all() as Array<{
      note_path: string;
    }>
  ).map((r) => r.note_path);
  console.log(`${note_paths.length} notes in chunks_fts`);

  let embedded = 0;
  let skipped = 0;
  let failed = 0;
  let chunks_total = 0;
  for (const note_path of note_paths) {
    if (!force) {
      const have = db
        .prepare(
          `SELECT COUNT(*) AS n FROM chunk_embeddings WHERE note_path = @p AND model = @m`,
        )
        .get({ '@p': note_path, '@m': embedder.model }) as { n: number };
      const want = db
        .prepare(`SELECT COUNT(*) AS n FROM chunks_fts WHERE note_path = @p`)
        .get({ '@p': note_path }) as { n: number };
      if (have.n > 0 && have.n === want.n) {
        skipped++;
        continue;
      }
    }
    const rows = db
      .prepare(
        `SELECT chunk_idx, chunk_text FROM chunks_fts WHERE note_path = @p ORDER BY chunk_idx`,
      )
      .all({ '@p': note_path }) as Array<{ chunk_idx: number; chunk_text: string }>;
    if (rows.length === 0) continue;
    try {
      const vectors = await embedder.embed(rows.map((r) => r.chunk_text));
      if (vectors.length !== rows.length) throw new Error('vector count mismatch');
      memory.upsert_chunk_embeddings(
        note_path,
        rows.map((r, i) => ({ chunk_idx: r.chunk_idx, embedding: vectors[i]! })),
        embedder.model,
      );
      embedded++;
      chunks_total += rows.length;
      if (embedded % 25 === 0) console.log(`  …${embedded} notes embedded`);
    } catch (err) {
      failed++;
      console.error(`  ✗ ${note_path}: ${(err as Error).message}`);
    }
  }

  console.log(
    `\nDone. embedded=${embedded} (${chunks_total} chunks), skipped=${skipped}, failed=${failed}`,
  );
  if (failed > 0) process.exit(2);
}

main().catch((err) => {
  console.error('backfill:embeddings failed:', err);
  process.exit(1);
});
