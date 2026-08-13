export {};
/**
 * Smoke for the *provable cordon* — the member-facing privacy self-test
 * (src/core/privacy_self_test.ts).
 *
 * Self-contained: temp vault + temp SQLite, REAL MemoryClient /
 * ProposalsStore / ConversationStore (no LLM, no orchestrator). The point
 * is to prove the prover: the self-test exercises the production cordoned
 * read surfaces, so a pass means "other members' data exists AND none of
 * it is reachable by you," not "the test printed green."
 *
 * Asserts:
 *   1. As a FRIEND (kim), the vault/RAG probe sees other members' notes
 *      exist (belonging_to_others > 0) and reaches 0 of them via the REAL
 *      retrieve_scoped_chunks path.
 *   2. ANTI-VACUOUS: kim CAN retrieve his OWN note via the same surface —
 *      so a pass is meaningful (the gate excluded others, retrieval isn't
 *      just returning nothing).
 *   3. Proposals + conversations probes: others exist, reachable = 0.
 *   4. As a HOUSEHOLD member (sam), the same holds, and the household
 *      note is visible to her (not counted as "belonging to others").
 *   5. Leak-verdict logic: probe_passed(0)=true, probe_passed(2)=false.
 *   6. Oversight history: an owner_oversight_review audit row targeting kim
 *      surfaces on kim's report with the reviewer's display name.
 *   7. Determinism: two runs return identical counts.
 *
 *   bun run smoke:privacy-self-test
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { open_db } from '@memory/stores/structured';
import { MemoryClient } from '@memory/client';
import { ProposalsStore } from '@core/proposals';
import { ConversationStore } from '@memory/stores/conversations';
import {
  run_privacy_self_test,
  probe_passed,
  type PrivacyCaller,
} from '@core/privacy_self_test';
import type { Database } from 'bun:sqlite';

const SIG = (specialist_id: string, kind: string) => ({
  specialist_id,
  kind,
  category: 'test',
});

let pass = 0;
let fail = 0;
function check(label: string, cond: boolean): void {
  if (cond) {
    pass += 1;
    console.log(`  ✓ ${label}`);
  } else {
    fail += 1;
    console.error(`  ✗ ${label}`);
  }
}

/** Write a vault note (frontmatter + body) AND its clippings + chunk rows. */
function seed_note(
  db: Database,
  vault: string,
  note_path: string,
  title: string,
  body: string,
  private_to: string | undefined,
): void {
  const abs = resolve(vault, note_path);
  mkdirSync(dirname(abs), { recursive: true });
  const fm = [
    '---',
    'type: clipping',
    `title: ${title}`,
    ...(private_to ? [`private_to: ${private_to}`] : []),
    '---',
    '',
    body,
    '',
  ].join('\n');
  writeFileSync(abs, fm);

  db.prepare(
    `INSERT INTO clippings
       (id, kind, source, title, captured_at, note_path, frontmatter_json, mtime, private_to)
     VALUES (@id, 'note', 'test', @title, @ts, @path, @fm, @ts, @pt)`,
  ).run({
    '@id': `c_${note_path.replace(/[^a-z0-9]/gi, '').slice(0, 12)}`,
    '@title': title,
    '@ts': '2026-06-20T00:00:00.000Z',
    '@path': note_path,
    '@fm': JSON.stringify({ title, private_to: private_to ?? null }),
    '@pt': private_to ?? null,
  });

  // One FTS chunk so the note is retrievable by title+body tokens.
  db.prepare(
    `INSERT INTO chunks_fts (note_path, chunk_idx, chunk_text) VALUES (@p, 0, @c)`,
  ).run({ '@p': note_path, '@c': `${title}\n${body}` });
}

function main(): void {
  const root = mkdtempSync(resolve(tmpdir(), 'hearth-privacy-selftest-'));
  const vault = resolve(root, 'vault');
  mkdirSync(vault, { recursive: true });

  try {
    const db = open_db(resolve(root, 'hearth.db'));
    const memory = new MemoryClient({ vault_root: vault, db });
    const proposals = new ProposalsStore(db);
    const conversations = new ConversationStore(db);
    const users = {
      get(id: string) {
        const names: Record<string, string> = {
          jasper: 'Jasper',
          sam: 'Sam',
          kim: 'Kim',
        };
        return names[id] ? { display_name: names[id] } : undefined;
      },
    };

    // ── Seed vault notes across scopes ──────────────────────────────────
    seed_note(db, vault, 'Journal/kim-private.md', 'Kim weekend hike plan', 'kim zarbnax trailhead', 'kim');
    seed_note(db, vault, 'Knowledge/Brigid/diet/sam-plan.md', 'Sam nutrition plan qmplex', 'sam macros qmplex', 'sam');
    seed_note(db, vault, 'Journal/sam-private.md', 'Sam therapy notes vorbel', 'sam vorbel session', 'sam');
    seed_note(db, vault, 'People/Aunt-May.md', 'Aunt May contact wexlon', 'household shared contact wexlon', 'household');
    seed_note(db, vault, 'Journal/jasper-private.md', 'Jasper finance jklint', 'owner only jklint', 'owner');

    const deps = { db, memory, proposals, conversations, users };

    // ── Seed proposals + conversations across users ─────────────────────
    proposals.create({
      specialist_id: 'kate', kind: 'draft_message', user_id: 'sam',
      execution_kind: 'manual', payload: { recipient_id: 'x', draft: 'hi' },
      rationale: "Sam's draft", signature: SIG('kate', 'draft_message'),
    });
    proposals.create({
      specialist_id: 'kate', kind: 'draft_message', user_id: 'kim',
      execution_kind: 'manual', payload: { recipient_id: 'y', draft: 'yo' },
      rationale: "Kim's draft", signature: SIG('kate', 'draft_message'),
    });
    conversations.create('kate', 'Sam chat', 'sam');
    conversations.create('kate', 'Kim chat', 'kim');

    // ── Oversight audit row: Jasper reviewed Kim ─────────────────────────
    memory.log_action({
      intent_id: 'oversight_test_1',
      agent: 'kate',
      tool_name: 'owner_oversight_review',
      tool_input: { target_user_id: 'kim', since: '2026-06-13', focus: null },
      user_id: 'jasper',
      execution_result: { actions: 3 },
    });

    // ── 1+2+3. Run as FRIEND kim ────────────────────────────────────────
    console.log('→ self-test as friend (kim)');
    const kim: PrivacyCaller = { user_id: 'kim', tier: 'friend', display_name: 'Kim' };
    const r_lee = run_privacy_self_test(deps, kim);

    const vault_lee = r_lee.probes.find((p) => p.id === 'vault_rag')!;
    // sam×2 + household×1 + owner×1 = 4 notes kim cannot see; his own is visible.
    check('vault: other members’ notes exist (>0)', vault_lee.belonging_to_others === 4);
    check('vault: 0 reachable by kim', vault_lee.reachable_by_you === 0);
    check('vault: probe passed', vault_lee.passed === true);

    // ANTI-VACUOUS: the SAME retrieval surface returns kim's OWN note.
    const own_hits = memory.retrieve_scoped_chunks({
      query: 'zarbnax trailhead', knowledge_scope: ['**'], k: 8,
      user_id: 'kim', user_tier: 'friend',
    });
    check(
      'anti-vacuous: kim CAN retrieve his own note (retrieval works)',
      own_hits.some((h) => h.note_path === 'Journal/kim-private.md'),
    );
    // And the cordon really blocks sam's note from kim on that surface.
    const cross = memory.retrieve_scoped_chunks({
      query: 'qmplex macros', knowledge_scope: ['**'], k: 8,
      user_id: 'kim', user_tier: 'friend',
    });
    check(
      'cordon: sam’s note NOT reachable by kim via retrieval',
      !cross.some((h) => h.note_path === 'Knowledge/Brigid/diet/sam-plan.md'),
    );

    const prop_lee = r_lee.probes.find((p) => p.id === 'proposals')!;
    check('proposals: others exist (sam’s)', prop_lee.belonging_to_others === 1);
    check('proposals: 0 reachable by kim', prop_lee.reachable_by_you === 0);

    const conv_lee = r_lee.probes.find((p) => p.id === 'conversations')!;
    check('conversations: others exist (sam’s)', conv_lee.belonging_to_others === 1);
    check('conversations: 0 reachable by kim', conv_lee.reachable_by_you === 0);

    check('overall passed (kim)', r_lee.overall_passed === true);

    // ── 4. Run as HOUSEHOLD sam ────────────────────────────────────────
    console.log('→ self-test as household (sam)');
    const sam: PrivacyCaller = { user_id: 'sam', tier: 'household', display_name: 'Sam' };
    const r_sara = run_privacy_self_test(deps, sam);
    const vault_sara = r_sara.probes.find((p) => p.id === 'vault_rag')!;
    // sam sees: her 2 notes + household + ... but NOT kim's, NOT owner's.
    // belonging_to_others = kim(1) + owner(1) = 2; household note is hers to see.
    check('vault(sam): household note NOT counted as others', vault_sara.belonging_to_others === 2);
    check('vault(sam): 0 reachable', vault_sara.reachable_by_you === 0);
    check('overall passed (sam)', r_sara.overall_passed === true);
    // sam CAN see the household note via retrieval.
    const sara_house = memory.retrieve_scoped_chunks({
      query: 'wexlon contact', knowledge_scope: ['**'], k: 8,
      user_id: 'sam', user_tier: 'household',
    });
    check(
      'household note reachable by sam (shared graph)',
      sara_house.some((h) => h.note_path === 'People/Aunt-May.md'),
    );

    // ── 5. Leak-verdict logic ───────────────────────────────────────────
    check('probe_passed(0) === true', probe_passed(0) === true);
    check('probe_passed(2) === false', probe_passed(2) === false);

    // ── 6. Oversight history surfaces ───────────────────────────────────
    check('oversight: kim shows 1 review', r_lee.exception.used_count === 1);
    check('oversight: reviewer is Jasper', r_lee.exception.history[0]?.reviewer === 'Jasper');
    check('oversight: sam shows 0 reviews', r_sara.exception.used_count === 0);

    // ── 7. Determinism ──────────────────────────────────────────────────
    const r_lee2 = run_privacy_self_test(deps, kim);
    check(
      'deterministic counts across runs',
      JSON.stringify(r_lee.probes.map((p) => [p.belonging_to_others, p.reachable_by_you])) ===
        JSON.stringify(r_lee2.probes.map((p) => [p.belonging_to_others, p.reachable_by_you])),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main();
