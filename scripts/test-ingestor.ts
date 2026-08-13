/**
 * Hand-written test for the ingestor's projection logic.
 *
 * Spins up a temp vault directory, drops in one valid sample of each
 * managed note type (plus a deliberately-invalid clipping and a note
 * with an unknown type), runs `rebuild()` against it, and asserts
 * that the projection tables contain exactly the expected rows.
 *
 *   bun run smoke:ingestor
 *
 * Self-contained: no Hearth or Hermes process needed; uses an
 * in-memory SQLite-on-disk file inside the temp directory so it
 * doesn't touch the user's vault or main db.
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { open_db } from '@memory/stores/structured';
import { MemoryClient } from '@memory/client';
import { rebuild, project_note, VaultIndex } from '@ingestor/rebuild';
import { unproject_note } from '@ingestor/project';

interface Row {
  [k: string]: unknown;
}

function assert_eq(label: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    throw new Error(`assert ${label}: expected ${e}, got ${a}`);
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`assert: ${message}`);
}

async function main(): Promise<void> {
  const tmp = mkdtempSync(join(tmpdir(), 'hearth-ingestor-test-'));
  const vault = join(tmp, 'vault');
  const db_path = join(tmp, 'hearth.db');
  mkdirSync(vault, { recursive: true });

  console.log(`→ temp vault: ${vault}`);

  // ── fixtures ──────────────────────────────────────────────────────────

  mkdirSync(join(vault, 'People'), { recursive: true });
  writeFileSync(
    join(vault, 'People', 'Alex.md'),
    `---
type: person
id: p_abc123
name: Alex Curie
relationship: friend
birthday: '1867-11-07'
tone: warm
sensitive: false
friday_managed: false
do_not_contact: false
---

Coffee buddy. Known her since college. See also [[Theresa]].
`,
  );

  // Second person — referenced by the wikilink from Alex and Kim.
  writeFileSync(
    join(vault, 'People', 'Theresa.md'),
    `---
type: person
id: p_def456
name: Theresa
relationship: family
friday_managed: false
---

Alex's mom.
`,
  );

  // Ambiguous wikilink target — two notes with basename "Foo".
  mkdirSync(join(vault, 'Projects'), { recursive: true });
  mkdirSync(join(vault, 'Drafts'), { recursive: true });
  writeFileSync(
    join(vault, 'Projects', 'Foo.md'),
    `---
type: person
id: p_foo001
name: Foo One
relationship: colleague
friday_managed: false
---
`,
  );
  writeFileSync(
    join(vault, 'Drafts', 'Foo.md'),
    `---
type: person
id: p_foo002
name: Foo Two
relationship: colleague
friday_managed: false
---
`,
  );

  // A note with an ambiguous link target — should log warning, not fail.
  mkdirSync(join(vault, 'Journal'), { recursive: true });
  writeFileSync(
    join(vault, 'Journal', '2026-05-15.md'),
    `---
type: journal_entry
date: 2026-05-15
tags: [smoke, test]
---

Had coffee with [[Alex]] today. Also mentioned [[Foo]] (ambiguous) and [[Nonexistent]].
`,
  );

  mkdirSync(join(vault, 'Decisions'), { recursive: true });
  writeFileSync(
    join(vault, 'Decisions', '2026-05-15-switch-to-bun.md'),
    `---
type: decision
id: d_xyz789
date: 2026-05-15
domain: infra
options_considered: [Node.js, Bun, Deno]
chosen: Bun
rationale: Native TypeScript, faster startup, built-in sqlite.
reversible: true
related: []
---

Made the call after the better-sqlite3 dlopen issue.
`,
  );

  mkdirSync(join(vault, 'Inbox'), { recursive: true });
  writeFileSync(
    join(vault, 'Inbox', '2026-05-15-example.md'),
    `---
type: clipping
id: c_abc1234567
kind: article
source: url
source_url: https://example.com/
title: Example Domain
captured_at: '2026-05-15T20:00:00.000Z'
reviewed: false
tags: []
extracted_metadata: {}
---

Example body.
`,
  );

  // Invalid clipping (missing required \`title\`) — should be logged
  // as validation_failed and skipped, not crash the rebuild.
  writeFileSync(
    join(vault, 'Inbox', '2026-05-15-broken.md'),
    `---
type: clipping
id: c_zzzzzzzzzz
kind: article
source: url
captured_at: '2026-05-15T20:01:00.000Z'
---

Missing the title field. Should fail validation.
`,
  );

  // Unknown frontmatter type — should be logged as validation_failed.
  writeFileSync(
    join(vault, 'Inbox', '2026-05-15-mystery.md'),
    `---
type: mystery_meat
id: m_aaaaaaaaaa
---

Body.
`,
  );

  // No frontmatter — should be silently skipped (not every .md is managed).
  writeFileSync(
    join(vault, 'README.md'),
    `# This is a plain note with no frontmatter; ingestor should skip it.\n`,
  );

  // ── run rebuild ──────────────────────────────────────────────────────

  const db = open_db(db_path);
  const memory = new MemoryClient({ vault_root: vault, db });

  const summary = await rebuild(vault, memory, db);
  console.log('  summary:', JSON.stringify(summary));

  // ── assertions ────────────────────────────────────────────────────────

  assert_eq('scanned', summary.scanned, 10);
  assert_eq('projected person count', summary.by_type.person, 4);
  assert_eq('projected journal_entry count', summary.by_type.journal_entry, 1);
  assert_eq('projected decision count', summary.by_type.decision, 1);
  assert_eq('projected clipping count', summary.by_type.clipping, 1);

  // 2 failures: broken clipping (schema) + mystery_meat (unknown type — skipped, not failed)
  // 1 skip: README.md (no frontmatter)
  // mystery_meat is "skipped" by our outcome model, so:
  assert_eq('skipped', summary.skipped, 2);
  assert_eq('failed', summary.failed, 1);

  // wikilink [[Foo]] is ambiguous, [[Nonexistent]] has 0 candidates,
  // [[Alex]] resolves cleanly, [[Theresa]] resolves cleanly.
  // Ambiguous count = 2 (Foo + Nonexistent), both from the same journal note.
  assert_eq('ambiguous_links total', summary.ambiguous_links, 2);

  // Spot-check the projected rows.
  const people = db.prepare('SELECT id, name, relationship FROM people ORDER BY id').all() as Row[];
  assert_eq(
    'people rows',
    people,
    [
      { id: 'p_abc123', name: 'Alex Curie', relationship: 'friend' },
      { id: 'p_def456', name: 'Theresa', relationship: 'family' },
      { id: 'p_foo001', name: 'Foo One', relationship: 'colleague' },
      { id: 'p_foo002', name: 'Foo Two', relationship: 'colleague' },
    ],
  );

  const journals = db.prepare('SELECT date, note_path FROM journal_entries').all() as Row[];
  assert_eq('journal rows', journals, [
    { date: '2026-05-15', note_path: 'Journal/2026-05-15.md' },
  ]);

  const decisions = db
    .prepare('SELECT id, date, domain, chosen, reversible FROM decisions')
    .all() as Row[];
  assert_eq('decision rows', decisions, [
    {
      id: 'd_xyz789',
      date: '2026-05-15',
      domain: 'infra',
      chosen: 'Bun',
      reversible: 1,
    },
  ]);

  const clippings = db
    .prepare('SELECT id, kind, source, title, reviewed FROM clippings')
    .all() as Row[];
  assert_eq('clipping rows', clippings, [
    {
      id: 'c_abc1234567',
      kind: 'article',
      source: 'url',
      title: 'Example Domain',
      reviewed: 0,
    },
  ]);

  // Graph edges: journal → Alex (resolved unambiguously), journal → Theresa
  // (NOT — body doesn't link Theresa from the journal, only Alex's note does),
  // Alex → Theresa (the [[Theresa]] in Alex's body).
  const edges = db
    .prepare('SELECT from_path, to_path FROM graph_edges ORDER BY from_path, to_path')
    .all() as Row[];
  assert_eq('graph edges', edges, [
    { from_path: 'Journal/2026-05-15.md', to_path: 'People/Alex.md' },
    { from_path: 'People/Alex.md', to_path: 'People/Theresa.md' },
  ]);

  // Audit log after a REBUILD: ONE rebuild_vault summary row (the bulk
  // path suppresses per-note project_note / ambiguous_link success rows —
  // a full rebuild runs on every ingestor restart, and per-note rows were
  // ~4.5k audit entries per boot), plus one validation_failed for the
  // broken clipping and one for the mystery_meat type (failure rows log
  // in both audit modes).
  const audit_by_name = (): Record<string, number> => {
    const rows = db
      .prepare(
        `SELECT tool_name, COUNT(*) as n FROM audit_log
         WHERE agent = 'ingestor' GROUP BY tool_name`,
      )
      .all() as Row[];
    return Object.fromEntries(rows.map((r) => [r.tool_name as string, r.n as number]));
  };
  const by_name = audit_by_name();
  assert(by_name.rebuild_vault === 1, `rebuild_vault audit count: ${by_name.rebuild_vault}`);
  assert(
    by_name.project_note === undefined,
    `rebuild must not write per-note project_note rows, got: ${by_name.project_note}`,
  );
  assert(
    by_name.ambiguous_link === undefined,
    `rebuild must not write per-link ambiguous_link rows, got: ${by_name.ambiguous_link}`,
  );
  assert(
    by_name.validation_failed === 2,
    `validation_failed audit count: ${by_name.validation_failed}`,
  );

  // The summary row's execution_result carries the counts format_summary
  // prints — the queryable record of what the pass did.
  const summary_row = db
    .prepare(
      `SELECT execution_result FROM audit_log
       WHERE agent = 'ingestor' AND tool_name = 'rebuild_vault'`,
    )
    .get() as Row;
  const recorded = JSON.parse(summary_row.execution_result as string) as Record<string, unknown>;
  assert_eq('summary row scanned', recorded.scanned, 10);
  assert_eq('summary row failed', recorded.failed, 1);
  assert_eq('summary row ambiguous_links', recorded.ambiguous_links, 2);

  // Steady-state watcher events (add/change in server.ts) keep per-note
  // audit: a direct project_note call in the default audit mode writes
  // the project_note row + one ambiguous_link row per unresolved link.
  const index = await VaultIndex.build(vault);
  const watcher_outcome = project_note(join(vault, 'Journal', '2026-05-15.md'), {
    vault_root: vault,
    db,
    memory,
    index,
  });
  assert(
    watcher_outcome.kind === 'projected',
    `watcher-style projection outcome: ${JSON.stringify(watcher_outcome)}`,
  );
  const after_watcher = audit_by_name();
  assert(
    after_watcher.project_note === 1,
    `watcher project_note audit count: ${after_watcher.project_note}`,
  );
  assert(
    after_watcher.ambiguous_link === 2,
    `watcher ambiguous_link audit count: ${after_watcher.ambiguous_link}`,
  );
  assert(
    after_watcher.rebuild_vault === 1,
    `rebuild_vault count unchanged by watcher event: ${after_watcher.rebuild_vault}`,
  );

  // ── unproject_note tears down the RETRIEVAL index, not just the row ──────
  //
  // A deleted note whose chunks_fts / chunk_embeddings rows survive is still
  // returned by FTS and by vector RAG — deleted content keeps grounding turns
  // (a library note deleted 2026-07-30 left 7 live embedding rows behind).
  console.log('\n→ unproject_note: deleted note leaves no retrieval rows');

  const lib_rel = 'Knowledge/Vivian/library/2026-05-15-orphan-check.md';
  mkdirSync(join(vault, 'Knowledge', 'Vivian', 'library'), { recursive: true });
  writeFileSync(
    join(vault, lib_rel),
    `---
type: clipping
id: c_orphan0001
kind: article
source: url
title: Orphan Check
captured_at: '2026-05-15T12:00:00Z'
reviewed: false
---

Body text the retrieval index would otherwise keep serving after deletion.
`,
  );
  const lib_index = await VaultIndex.build(vault);
  const lib_outcome = project_note(join(vault, lib_rel), {
    vault_root: vault,
    db,
    memory,
    index: lib_index,
  });
  assert(lib_outcome.kind === 'projected', `library fixture projected: ${JSON.stringify(lib_outcome)}`);

  // Stand in for the library ingest path (index_chunks + embed_chunks_best_effort).
  db.prepare(`INSERT INTO chunks_fts (note_path, chunk_idx, chunk_text) VALUES (@p, @i, @c)`).run({
    '@p': lib_rel,
    '@i': 0,
    '@c': 'Body text the retrieval index would otherwise keep serving after deletion.',
  });
  memory.upsert_chunk_embeddings(lib_rel, [{ chunk_idx: 0, embedding: [1, 0, 0, 0] }], 'mock');

  const retrieval_counts = (): { clippings: number; fts: number; emb: number } => ({
    clippings: (
      db.prepare(`SELECT COUNT(*) AS n FROM clippings WHERE note_path = @p`).get({
        '@p': lib_rel,
      }) as Row
    ).n as number,
    fts: (
      db.prepare(`SELECT COUNT(*) AS n FROM chunks_fts WHERE note_path = @p`).get({
        '@p': lib_rel,
      }) as Row
    ).n as number,
    emb: (
      db.prepare(`SELECT COUNT(*) AS n FROM chunk_embeddings WHERE note_path = @p`).get({
        '@p': lib_rel,
      }) as Row
    ).n as number,
  });
  assert_eq('indexed before delete', retrieval_counts(), { clippings: 1, fts: 1, emb: 1 });

  rmSync(join(vault, lib_rel), { force: true });
  const un = unproject_note(join(vault, lib_rel), { vault_root: vault, db, memory });
  assert_eq('unproject removed_from', un.removed_from, 'clippings');
  assert_eq('unproject chunks_removed', un.chunks_removed, 1);
  assert_eq('unproject embeddings_removed', un.embeddings_removed, 1);
  assert_eq('all three tables clear after delete', retrieval_counts(), {
    clippings: 0,
    fts: 0,
    emb: 0,
  });

  // An AUXILIARY note (a `_synthesis/` synthesis) never projects a row, so
  // these two deletes are its ENTIRE teardown — the case a projection-only
  // unproject silently skips.
  const syn_rel = 'Knowledge/Vivian/library/_synthesis/orphan-check-topic.md';
  mkdirSync(join(vault, 'Knowledge', 'Vivian', 'library', '_synthesis'), { recursive: true });
  writeFileSync(
    join(vault, syn_rel),
    `---
type: synthesis_note
title: Orphan check — synthesis
---

Distilled prose.
`,
  );
  db.prepare(`INSERT INTO chunks_fts (note_path, chunk_idx, chunk_text) VALUES (@p, @i, @c)`).run({
    '@p': syn_rel,
    '@i': 0,
    '@c': 'Distilled prose.',
  });
  memory.upsert_chunk_embeddings(syn_rel, [{ chunk_idx: 0, embedding: [0, 1, 0, 0] }], 'mock');
  rmSync(join(vault, syn_rel), { force: true });
  const un_syn = unproject_note(join(vault, syn_rel), { vault_root: vault, db, memory });
  assert_eq('auxiliary note projects nowhere', un_syn.removed_from, null);
  assert_eq('auxiliary chunks_removed', un_syn.chunks_removed, 1);
  assert_eq('auxiliary embeddings_removed', un_syn.embeddings_removed, 1);

  db.close();
  rmSync(tmp, { recursive: true, force: true });

  console.log('\n✓ INGESTOR TEST PASSED');
}

main().catch((err: unknown) => {
  console.error(
    '\n✗ INGESTOR TEST FAILED:',
    err instanceof Error ? err.message : String(err),
  );
  process.exit(1);
});
