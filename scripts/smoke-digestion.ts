export {};
/**
 * smoke:digestion — proves the end-to-end "user drops a doc, the
 * specialist notices it" loop.
 *
 * Layers exercised:
 *   1. The upload path (write a wrapper note to Knowledge/<CapId>/library/).
 *   2. Ingestor projection into the `clippings` table.
 *   3. chunks_fts indexing so the FTS search finds the body.
 *   4. scan_vault_deltas in the deliberation context.
 *   5. The deliberation envelope (under HEARTH_TEST_MODE fixtures)
 *      flagging the new doc to Kate.
 *   6. The flag landing in Kate's inbox.
 *
 * Self-contained: temp vault + temp SQLite + canned LLM fixtures.
 * No network calls. No real LLM invocation.
 */

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { ulid } from 'ulid';
import { open_db } from '@memory/stores/structured';
import { MemoryClient } from '@memory/client';
import { SpecialistRegistry } from '@core/specialist';
import { SpecialistRuntime } from '@core/specialist_runtime';
import { ToolRegistry } from '@core/tool_registry';
import { ProposalsStore } from '@core/proposals';
import {
  ConversationStore,
  InterruptStore,
  SpecialistInbox,
} from '@memory/stores/conversations';
import { LoopDriver } from '@core/loops';
import { ConfigLLMRouter } from '@core/router';
import { anya_awareness } from '@specialists/awareness/anya';

process.env.HEARTH_TEST_MODE = '1';

const tests: Array<[string, boolean]> = [];
function expect(label: string, ok: boolean): void {
  tests.push([label, ok]);
  console.log(`  ${ok ? '✓' : '✗'} ${label}`);
}

function setup() {
  const root = mkdtempSync(resolve(tmpdir(), 'hearth-digestion-'));
  const vault = resolve(root, 'vault');
  mkdirSync(vault, { recursive: true });
  const db_path = resolve(root, 'hearth.db');
  const db = open_db(db_path);
  const memory = new MemoryClient({ vault_root: vault, db });

  // Bare-minimum vault skeleton.
  mkdirSync(resolve(vault, 'Knowledge', 'Anya', 'library'), { recursive: true });
  mkdirSync(resolve(vault, 'Knowledge', 'Kate'), { recursive: true });
  mkdirSync(resolve(vault, 'Animals'), { recursive: true });
  mkdirSync(resolve(vault, 'People'), { recursive: true });

  // Anya + Kate specialist configs (minimal, real schema).
  const specs_dir = resolve(root, 'specialists');
  mkdirSync(specs_dir, { recursive: true });

  writeFileSync(
    resolve(specs_dir, 'anya.yaml'),
    `id: anya
name: Dr. Anya
role: Veterinarian
voice: warm
knowledge_scope:
  - "Animals/**"
capabilities:
  read_vault: true
  write_vault_animals: true
  write_proposals: true
proactive:
  mode: batched
  deliberation_at: ["08:00"]
  interrupt_threshold: medium-high
persona: |
  You are Dr. Anya. You care for Bailey and Mango. Triage threshold is
  medium-high; everyday observations route to Kate via flag.
`,
    'utf8',
  );

  writeFileSync(
    resolve(specs_dir, 'kate.yaml'),
    `id: kate
name: Kate
role: Chief of Staff
voice: warm-direct
default_landing: true
knowledge_scope:
  - "**"
capabilities:
  read_vault: true
  write_vault_general: true
  write_proposals: true
proactive:
  mode: active
  awareness_hz: 0.0167
  deliberation_at: ["07:00"]
  interrupt_threshold: high
persona: |
  You are Kate. You see what the team flags and decide what reaches Jasper.
`,
    'utf8',
  );

  const specialists = new SpecialistRegistry(specs_dir);
  const tool_registry = new ToolRegistry();
  // Default autonomy config — this smoke exercises the digestion
  // pipeline, not proposal-tier graduation.
  const proposals = new ProposalsStore(db);
  const conversations = new ConversationStore(db);
  const interrupts = new InterruptStore(db);
  const inbox = new SpecialistInbox(db);

  // The runtime uses HEARTH_TEST_MODE so an LLM is not actually called,
  // but the constructor still needs an LLMRouter. Point it at a junk
  // URL — never reached.
  const llm = new ConfigLLMRouter('./config/llm-roles.yaml', {
    ollama_base_url: 'http://127.0.0.1:1',
  });
  const runtime = new SpecialistRuntime({
    specialists,
    llm,
    memory,
    tools: tool_registry,
    proposals,
    inbox,
  });
  const driver = new LoopDriver({
    db,
    memory,
    specialists,
    runtime,
    proposals,
    interrupts,
    inbox,
    tools: tool_registry,
    llm,
  });
  driver.register_awareness(anya_awareness);

  return {
    root,
    vault,
    db,
    memory,
    specialists,
    runtime,
    inbox,
    interrupts,
    proposals,
    driver,
    conversations,
    tool_registry,
  };
}

async function main() {
  const ctx = setup();

  console.log('→ #1 — Anya auto-includes Knowledge/Anya/** in scope');
  const anya = ctx.specialists.get('anya')!;
  expect(
    'Anya scope contains Knowledge/Anya/**',
    anya.knowledge_scope.includes('Knowledge/Anya/**'),
  );
  expect(
    'Anya scope still contains the YAML-declared Animals/**',
    anya.knowledge_scope.includes('Animals/**'),
  );

  console.log('\n→ #2 — Simulate a library upload (wrapper note + chunks_fts)');
  const clipping_id = `c_${ulid().toLowerCase().slice(-10)}`;
  const clipping_path = `Knowledge/Anya/library/2026-05-16-bailey-bloodwork.md`;
  const clipping_body =
    `# Bailey's Bloodwork Summary\n\nWBC 22, RBC normal, PCV 48. ` +
    `Differential: marked neutrophilia, mild lymphopenia. ` +
    `Note: revisit prednisolone dose schedule given inflammation marker.`;
  ctx.memory.upsert_note(
    clipping_path,
    {
      type: 'clipping',
      id: clipping_id,
      kind: 'pdf',
      source: 'file',
      title: "Bailey's Bloodwork Summary",
      captured_at: new Date().toISOString(),
      reviewed: false,
      tags: [],
      specialist_scope: 'anya',
    },
    clipping_body,
  );
  // Simulate the library route's chunks_fts indexing.
  ctx.db
    .prepare(`INSERT INTO chunks_fts (note_path, chunk_idx, chunk_text) VALUES (@p, 0, @c)`)
    .run({ '@p': clipping_path, '@c': clipping_body });
  // Simulate ingestor projection of the clipping row.
  ctx.db
    .prepare(
      `INSERT INTO clippings
       (id, kind, source, source_url, title, attachment_path, captured_at,
        reviewed, note_path, frontmatter_json, mtime)
       VALUES (@id, 'pdf', 'file', NULL, @title, NULL, @cap, 0, @path, '{}', @mt)`,
    )
    .run({
      '@id': clipping_id,
      '@title': "Bailey's Bloodwork Summary",
      '@cap': new Date().toISOString(),
      '@path': clipping_path,
      '@mt': new Date().toISOString(),
    });

  console.log('\n→ #3 — chunks_fts hit on the new clipping body');
  const fts_hits = ctx.db
    .prepare(`SELECT note_path FROM chunks_fts WHERE chunks_fts MATCH 'neutrophilia'`)
    .all() as Array<{ note_path: string }>;
  expect(
    `FTS finds the new clipping by content (1 hit, was ${fts_hits.length})`,
    fts_hits.length === 1 && fts_hits[0]?.note_path === clipping_path,
  );

  console.log('\n→ #4 — Anya deliberation sees the delta and flags Kate');
  // No mtime bump: the clipping's real mtime is NOW (just-written), which
  // beats the first-pass 24h fallback. Pass 1 picks it up; pass 2 won't,
  // because pass 2's `since` becomes pass-1's audit-log ts.
  await ctx.driver.fire_deliberation_now('anya', '08:00');

  // The fixture's library-delta branch emits a flag to Kate. Confirm
  // it landed in Kate's inbox referencing the clipping path.
  const kate_unread = ctx.inbox.unread_for('kate', 10);
  const lib_flag = kate_unread.find(
    (m) =>
      m.from_specialist_id === 'anya' &&
      m.body_md.includes('Bailey') &&
      m.body_md.includes('library'),
  );
  expect(
    `Anya's deliberation flagged Kate (${kate_unread.length} unread total, lib-flag ${lib_flag ? 'present' : 'absent'})`,
    Boolean(lib_flag),
  );

  console.log('\n→ #5 — Audit trail captures the deliberation');
  const audit = ctx.db
    .prepare(
      `SELECT execution_result FROM audit_log
       WHERE agent = 'anya' AND tool_name = 'deliberation_pass'
       ORDER BY ts DESC LIMIT 1`,
    )
    .get() as { execution_result: string } | undefined;
  const exec = audit?.execution_result ? JSON.parse(audit.execution_result) : null;
  expect(
    `audit_log row for the deliberation exists and counts ≥1 flag (${exec?.flags_count ?? 0})`,
    exec && exec.flags_count >= 1,
  );

  console.log('\n→ #6 — retrieve_scoped_chunks returns the new chunk for an Anya-scoped query');
  const hits = ctx.memory.retrieve_scoped_chunks({
    query: 'neutrophilia prednisolone',
    knowledge_scope: anya.knowledge_scope,
    k: 3,
  });
  expect(
    `Scoped FTS retrieval returns the clipping (${hits.length} hits)`,
    hits.length >= 1 && hits[0]?.note_path === clipping_path,
  );
  expect(
    `Top hit's text contains "neutrophilia"`,
    (hits[0]?.chunk_text ?? '').toLowerCase().includes('neutrophilia'),
  );
  // Anti-test: a query outside Anya's scope shouldn't match this chunk.
  const wrong_scope_hits = ctx.memory.retrieve_scoped_chunks({
    query: 'neutrophilia',
    knowledge_scope: ['Knowledge/Kate/**'],
    k: 3,
  });
  expect(
    `Out-of-scope query returns zero hits (${wrong_scope_hits.length})`,
    wrong_scope_hits.length === 0,
  );

  console.log('\n→ #7 — Re-deliberating immediately produces NO new flag (idempotency)');
  // The "prior deliberation_pass" audit row from pass 1 means scan_vault_deltas's
  // `since` is now after the clipping's mtime. Pass 2 should add zero new flags.
  // Kate hasn't read the pass-1 flag yet (no Kate pass), so it's still in her
  // unread queue — we assert the COUNT didn't grow.
  const before_2 = ctx.inbox.unread_for('kate', 50).length;
  await ctx.driver.fire_deliberation_now('anya', '08:00');
  const after_2 = ctx.inbox.unread_for('kate', 50).length;
  expect(
    `Second deliberation adds 0 new flags (before=${before_2}, after=${after_2})`,
    after_2 === before_2,
  );

  // Cleanup.
  await ctx.specialists.close();
  ctx.db.close();
  rmSync(ctx.root, { recursive: true, force: true });

  console.log('\n' + '─'.repeat(60));
  const passed = tests.filter(([, ok]) => ok).length;
  const failed = tests.filter(([, ok]) => !ok).length;
  console.log(`Results: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log('✗ SMOKE FAILED');
    process.exit(1);
  } else {
    console.log('✓ SMOKE PASSED');
    process.exit(0);
  }
}

main().catch((err) => {
  console.error('smoke crashed:', err);
  process.exit(1);
});
