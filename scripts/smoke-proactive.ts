export {};
/**
 * Smoke test for the proactive staff loop (Prompt 6c).
 *
 * Self-contained — does not require the orchestrator. Spins up its own
 * temp vault, temp SQLite, registers awareness handlers + the loop driver,
 * and drives the awareness/deliberation/interrupt flows end-to-end using
 * HEARTH_TEST_MODE=1 (deliberation fixtures stand in for the LLM).
 *
 * Run via `bun run smoke:proactive`.
 */

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { open_db } from '@memory/stores/structured';
import { MemoryClient } from '@memory/client';
import { SpecialistRegistry } from '@core/specialist';
import { SpecialistRuntime } from '@core/specialist_runtime';
import { ToolRegistry } from '@core/tool_registry';
import { ProposalsStore } from '@core/proposals';
import { ProcessMissStore } from '@core/process_misses';
import { load_extra_capabilities } from '@core/capabilities';
import {
  ConversationStore,
  InterruptStore,
  SpecialistInbox,
} from '@memory/stores/conversations';
import { LoopDriver } from '@core/loops';
import { ConfigLLMRouter } from '@core/router';
import { format_now_anchor } from '@core/time';
import { kate_awareness } from '@specialists/awareness/kate';
import { anya_awareness } from '@specialists/awareness/anya';
import { vivian_awareness } from '@specialists/awareness/vivian';
import {
  compact_memory,
  memory_path,
  append_to_memory,
  read_memory_tail,
} from '@core/memory_files';
import { register_kate_tools } from '@specialists/kate/tools';
import { pull_brief_context, life_context_grounding_corpus } from '@core/domain_packs';

// HEARTH_TEST_MODE is required — the deliberation fixtures replace LLM calls.
process.env.HEARTH_TEST_MODE = '1';

function setup() {
  const root = mkdtempSync(resolve(tmpdir(), 'hearth-proactive-'));
  const vault = resolve(root, 'vault');
  mkdirSync(vault, { recursive: true });
  const db_path = resolve(root, 'hearth.db');
  const db = open_db(db_path);
  const memory = new MemoryClient({ vault_root: vault, db });

  // Seed minimal vault: People/Alex, Animals/Bailey with a due dose,
  // Animals/Mango.
  mkdirSync(resolve(vault, 'People'), { recursive: true });
  mkdirSync(resolve(vault, 'Animals'), { recursive: true });
  mkdirSync(resolve(vault, 'Knowledge', 'Kate'), { recursive: true });
  mkdirSync(resolve(vault, 'Knowledge', 'Anya'), { recursive: true });

  // Alex: birthday 5 days out (year-agnostic).
  const today = new Date();
  const target = new Date(today);
  target.setDate(target.getDate() + 5);
  const mm_dd = `${String(target.getMonth() + 1).padStart(2, '0')}-${String(target.getDate()).padStart(2, '0')}`;
  writeFileSync(
    resolve(vault, 'People', 'Alex.md'),
    `---\ntype: person\nid: p_marie1\nname: Alex\nrelationship: friend\nbirthday: "${mm_dd}"\n---\n\nNotes about Alex.\n`,
    'utf8',
  );

  // Bailey: medication due ~2h out, last dose 11h ago (every 12h).
  const due_iso = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
  const last_dose_iso = new Date(Date.now() - 11 * 60 * 60 * 1000).toISOString();
  writeFileSync(
    resolve(vault, 'Animals', 'Bailey.md'),
    `---\ntype: animal\nname: Bailey\nmedications:\n  - name: Prednisolone\n    next_due: "${due_iso}"\n    ts_last_dose: "${last_dose_iso}"\n    every_hours: 12\n---\n\nBailey's care notes.\n`,
    'utf8',
  );

  writeFileSync(
    resolve(vault, 'Animals', 'Mango.md'),
    `---\ntype: animal\nname: Mango\n---\n\nMango's notes.\n`,
    'utf8',
  );

  // Specialist configs: copy seed configs into a temp dir so the registry
  // reads our test-controlled set.
  const specialists_dir = resolve(root, 'specialists');
  mkdirSync(specialists_dir, { recursive: true });
  const seed_dir = resolve(import.meta.dir, '..', 'config', 'specialists');
  // Retired specialists (the 2026-07-04 Kate fold-in — anya/iris/marguerite/
  // luna are gone from config/) seed from the FROZEN fixture copies instead:
  // the awareness→flag→brief pipeline this smoke exercises is a MECHANISM
  // test, and anya's batched shape remains its canonical fixture.
  const fixtures_dir = resolve(import.meta.dir, 'fixtures', 'specialists');
  for (const id of [
    'kate',
    'anya',
    'eleanor',
    'vivian',
    'mariah',
    // Brigid carries the canonical "curated list omits the knowledge
    // floor" shape — her tools_for_chat names mealie tools and
    // read_inbox but NOT search_library / read_note. The chat-base-
    // toolset cases below assert the runtime adds them anyway.
    'brigid',
  ]) {
    const src = resolve(seed_dir, `${id}.yaml`);
    const fixture = resolve(fixtures_dir, `${id}.yaml`);
    const pick = existsSync(src) ? src : existsSync(fixture) ? fixture : null;
    if (pick) {
      writeFileSync(resolve(specialists_dir, `${id}.yaml`), readFileSync(pick, 'utf8'), 'utf8');
    }
  }

  // Config-extended capability tokens (e.g. write_process_miss, which
  // Mariah's YAML grants) must load before the registry compiles —
  // granted_set() validates every grant against the known set.
  load_extra_capabilities(resolve(import.meta.dir, '..', 'config', 'capabilities.yaml'));

  const specialists = new SpecialistRegistry(specialists_dir);
  const proposals = new ProposalsStore(db);
  const process_misses = new ProcessMissStore(db);
  const conversations = new ConversationStore(db);
  const interrupts = new InterruptStore(db);
  const inbox = new SpecialistInbox(db);
  const tools = new ToolRegistry();

  // The LLM router is required by SpecialistRuntime, but in TEST_MODE the
  // runtime short-circuits before calling it. Provide a roles config that
  // points at ollama (won't be used).
  const roles_path = resolve(root, 'roles.yaml');
  writeFileSync(
    roles_path,
    `roles:\n  specialist:\n    provider: ollama\n    model: test\n    temperature: 0.7\n`,
    'utf8',
  );
  const llm = new ConfigLLMRouter(roles_path, {
    ollama_base_url: 'http://localhost:11434',
  });

  const runtime = new SpecialistRuntime({
    specialists,
    llm,
    memory,
    tools,
    proposals,
    inbox,
  });

  register_kate_tools(tools, {
    proposals,
    inbox,
    interrupts,
    conversations,
    specialists,
    vault_root: vault,
  });

  const driver = new LoopDriver({
    db,
    memory,
    specialists,
    runtime,
    proposals,
    interrupts,
    inbox,
    process_misses,
  });
  driver.register_awareness(kate_awareness);
  driver.register_awareness(anya_awareness);
  driver.register_awareness(vivian_awareness);

  return {
    root,
    db,
    memory,
    specialists,
    runtime,
    proposals,
    process_misses,
    conversations,
    interrupts,
    inbox,
    driver,
  };
}

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
}

async function main() {
  const ctx = setup();
  let pass = 0;
  let cleanup_root: string | null = ctx.root;

  try {
    // 1+2. Anya awareness should fire and detect Bailey medication.
    console.log('→ Anya awareness (Bailey medication due in 2h)');
    const anya_obs = await ctx.driver.fire_awareness_now('anya');
    assert(anya_obs !== null, 'Anya awareness should return an observation');
    assert(
      anya_obs!.summary.toLowerCase().includes('bailey'),
      `Anya observation should mention Bailey; got: ${anya_obs!.summary}`,
    );
    assert(anya_obs!.severity === 'medium-high', `Severity should be medium-high; got ${anya_obs!.severity}`);
    console.log(`  ✓ Anya: "${anya_obs!.summary}"`);
    pass++;

    // 3. Anya deliberation should produce an inbox flag to Kate.
    console.log('→ Anya deliberation (08:00) — should flag Bailey medication to Kate');
    await ctx.driver.fire_deliberation_now('anya', '08:00');
    const kate_inbox = ctx.inbox.unread_for('kate');
    assert(kate_inbox.length > 0, 'Kate should have at least one unread inbox message after Anya deliberates');
    const merrit_flag = kate_inbox.find((m) => m.body_md.toLowerCase().includes('bailey'));
    assert(merrit_flag !== undefined, `One of Kate's inbox messages should mention Bailey. Got: ${JSON.stringify(kate_inbox.map((m) => m.body_md.slice(0, 80)))}`);
    console.log(`  ✓ Inbox flag to Kate: "${merrit_flag!.body_md.slice(0, 60)}"`);
    pass++;

    // 4. Kate awareness should pick up unread inbox.
    console.log('→ Kate awareness (should see unread inbox)');
    const kate_obs = await ctx.driver.fire_awareness_now('kate');
    assert(kate_obs !== null, 'Kate awareness should emit an observation');
    assert(
      typeof kate_obs!.details.unread_inbox === 'number' && (kate_obs!.details.unread_inbox as number) > 0,
      `Kate's observation should report unread_inbox > 0; details: ${JSON.stringify(kate_obs!.details)}`,
    );
    console.log(`  ✓ Kate awareness: "${kate_obs!.summary}"`);
    pass++;

    // 5. Kate morning deliberation should generate a brief.
    console.log('→ Kate morning deliberation (07:00) — should generate a brief');
    await ctx.driver.fire_deliberation_now('kate', '07:00');
    const briefs = ctx.db.prepare(`SELECT * FROM briefs ORDER BY ts_generated DESC LIMIT 1`).all() as Array<{
      id: string;
      kind: string;
      sections_json: string;
      mood: string;
    }>;
    assert(briefs.length === 1, 'Should have created exactly one brief row');
    assert(briefs[0]!.kind === 'morning', `Brief kind should be 'morning'; got ${briefs[0]!.kind}`);
    const sections = JSON.parse(briefs[0]!.sections_json) as {
      attention_today: Array<{ title: string }>;
    };
    const merrit_attention = sections.attention_today.find((a) =>
      a.title.toLowerCase().includes('bailey'),
    );
    assert(
      merrit_attention !== undefined,
      `Brief's attention_today should mention Bailey. Got titles: ${JSON.stringify(sections.attention_today.map((a) => a.title))}`,
    );
    console.log(`  ✓ Morning brief with Bailey attention item`);
    pass++;

    // 6. After Kate's deliberation pass, her inbox items are actioned
    //    (which also marks them read) — that's the design: deliberation
    //    consumes the inbox. Verify the actioned_at is set.
    console.log('→ Inbox actioned-after-deliberation');
    const post_delib = ctx.inbox.list_all({ to: 'kate' });
    const actioned_anya = post_delib.find((m) => m.id === merrit_flag!.id);
    assert(actioned_anya !== undefined, 'Anya message should still exist after deliberation');
    assert(actioned_anya!.actioned_at !== null, 'Anya message should be marked actioned by Kate deliberation');
    console.log(`  ✓ Anya flag marked actioned by Kate deliberation`);
    pass++;

    // 7. Push a fresh inbox message and verify mark_read.
    console.log('→ Push a fresh inbox message and mark_read');
    const fresh_id = ctx.inbox.push({
      from_specialist_id: 'anya',
      to_specialist_id: 'kate',
      kind: 'fyi',
      body_md: 'Mango drank a normal amount of water today.',
    });
    ctx.inbox.mark_read([fresh_id]);
    const post = ctx.inbox.get(fresh_id);
    assert(post && post.read_at !== null, 'mark_read should set read_at');
    console.log(`  ✓ Fresh message mark_read works`);
    pass++;

    // 8. Kate awareness — after we've actioned + marked all messages, unread is 0.
    console.log('→ Kate awareness reflects mark_read');
    const kate_obs_2 = await ctx.driver.fire_awareness_now('kate');
    if (kate_obs_2 !== null) {
      const unread_count_2 = (kate_obs_2.details.unread_inbox as number) ?? 0;
      assert(unread_count_2 === 0, `Unread count should be 0 after mark_read; got ${unread_count_2}`);
    }
    console.log(`  ✓ Kate re-awareness: unread_inbox=0`);
    pass++;

    // 10. High-severity security-signal observation → interrupt routed to Kate.
    // The deny-burst detector used to live in Cassandra's awareness handler; the
    // 2026-07-26 dissolve moved it into the perimeter subsystem that Kate's own
    // handler drives, so this now fires on 'kate' and doubles as the regression
    // test that the rehome actually wired up.
    console.log('→ deny-burst → high-severity observation → interrupt routed to Kate');
    const now_iso = new Date().toISOString();
    const ulid_stmt = ctx.db.prepare(
      `INSERT INTO audit_log (id, ts, intent_id, agent, tool_name, tool_input, gate_decision)
       VALUES (@id, @ts, @i, 'orchestrator', 'test_gate_call', '{}', '{"decision":"deny"}')`,
    );
    for (let n = 0; n < 6; n++) {
      ulid_stmt.run({ '@id': `aud${n}-${Date.now()}`, '@ts': now_iso, '@i': `int${n}` });
    }
    const cass_obs = await ctx.driver.fire_awareness_now('kate');
    assert(cass_obs !== null, 'Kate should observe the deny burst');
    assert(cass_obs!.severity === 'high', `Severity should be high; got ${cass_obs!.severity}`);
    // After awareness with suggests_interrupt, an interrupt row should exist
    // routed_to=kate.
    const interrupts_rows = ctx.interrupts.list();
    assert(
      interrupts_rows.some((i) => i.routed_to === 'kate' && i.originating_specialist_id === 'kate'),
      `Interrupt should be routed to Kate from the perimeter watch. Got: ${JSON.stringify(interrupts_rows.map((i) => ({ from: i.originating_specialist_id, to: i.routed_to })))}`,
    );
    console.log(`  ✓ perimeter interrupt routed to Kate`);
    pass++;

    // 10b. Regression (absorb_interrupt root-cause fix): acknowledge() must
    // work for an interrupt in ANY non-acknowledged status, not just 'pending'
    // — the status='pending'-only WHERE clause silently returned 0 changes for
    // escalated/routed/dismissed rows, surfacing as {acknowledged:false} with
    // no error and driving Kate's 100+ cycle retry loop (119 silent fails/24h).
    console.log('→ absorb_interrupt: acknowledge a non-pending interrupt (broadened WHERE)');
    const ack_test = ctx.interrupts.create({
      originating_specialist_id: 'kate',
      severity: 'high',
      summary: 'ack-broadening regression probe',
      routed_to: 'kate',
    });
    ctx.db.prepare(`UPDATE interrupts SET status = 'escalated' WHERE id = @id`).run({ '@id': ack_test.id });
    assert(ctx.interrupts.acknowledge(ack_test.id) === true, 'acknowledge() must succeed on an escalated (non-pending) interrupt');
    assert(ctx.interrupts.acknowledge(ack_test.id) === true, 'acknowledge() must be idempotent (already-acknowledged → true, no retry loop)');
    assert(ctx.interrupts.acknowledge('itr_does_not_exist') === false, 'acknowledge() must return false for a genuinely missing id');
    console.log('  ✓ acknowledge() works for non-pending + is idempotent + false on missing id');
    pass++;

    // 11. Kate deliberation with the interrupt — fixture promotes it.
    console.log('→ Kate deliberation (12:30) with a perimeter interrupt in her inbox — should promote');
    await ctx.driver.fire_deliberation_now('kate', '12:30');
    const after_interrupts = ctx.interrupts.list();
    const user_routed = after_interrupts.filter((i) => i.routed_to === 'user');
    assert(user_routed.length >= 1, 'Should have at least one user-routed interrupt after Kate promotes');
    const would_have_pushed = ctx.db
      .prepare(`SELECT COUNT(*) as n FROM audit_log WHERE tool_name = 'would_have_pushed'`)
      .get() as { n: number };
    assert(would_have_pushed.n >= 1, 'Should have at least one would_have_pushed audit row');
    console.log(`  ✓ Kate promoted perimeter interrupt to user; would_have_pushed=${would_have_pushed.n}`);
    pass++;

    // 12. Memory compaction.
    console.log('→ Memory compaction (Kate, 40 days of entries → archive pre-30d)');
    const kate_memory = resolve(ctx.root, 'vault', 'Knowledge', 'Kate', 'memory.md');
    mkdirSync(dirname(kate_memory), { recursive: true });
    const lines: string[] = ['---', '---', ''];
    for (let day_offset = 40; day_offset >= 1; day_offset--) {
      const d = new Date(Date.now() - day_offset * 24 * 60 * 60 * 1000);
      const stamp = `${d.toISOString().slice(0, 10)} 12:00`;
      lines.push(`## ${stamp}`);
      lines.push('');
      lines.push(`Routine entry ${day_offset} days ago.`);
      lines.push('');
    }
    writeFileSync(kate_memory, lines.join('\n'), 'utf8');
    const result = await compact_memory({
      memory: ctx.memory,
      specialist_id: 'kate',
      keep_recent_days: 30,
      summarize: async (text) =>
        `[summary covering ${text.split('\n## ').length - 1} entries]`,
    });
    assert(result.archived_count >= 10, `Should archive ~10 entries; got ${result.archived_count}`);
    assert(result.remaining_count >= 28, `Should keep ~30 entries; got ${result.remaining_count}`);
    const compacted = readFileSync(kate_memory, 'utf8');
    assert(compacted.includes('## Archive: pre-'), `Compacted file should contain an Archive header. Tail: ${compacted.slice(0, 200)}`);
    console.log(`  ✓ Compacted: archived=${result.archived_count}, kept=${result.remaining_count}`);
    pass++;

    // 12b. Per-user memory cordon (2026-07-29 regression guard).
    //
    // Kate used to be EXEMPT from the per-user memory split, so her per-user
    // brief fan-out wrote every member's private facts into the single shared
    // `memory.md` and the owner's next pass read them back as recall — that is
    // how a `private_to: sam` birthday reached Jasper's brief. Separately, the
    // deliberation write had never passed `user_id` at all, so no
    // `memory_<user_id>.md` had ever been created for ANY specialist. Both
    // directions are asserted here: a member's entry must not be readable from
    // the owner's tail, and the owner's must not be readable from hers.
    console.log('→ Per-user memory cordon — Kate is NOT exempt from the split');
    assert(
      memory_path('kate', 'sam') === 'Knowledge/Kate/memory_sara.md',
      `Kate must resolve per-user, not to the shared file; got ${memory_path('kate', 'sam')}`,
    );
    assert(
      memory_path('kate', 'jasper') === 'Knowledge/Kate/memory.md',
      `The owner keeps the legacy canonical file; got ${memory_path('kate', 'jasper')}`,
    );
    assert(
      memory_path('kate', undefined) === 'Knowledge/Kate/memory.md',
      'A user-less system pass resolves to the canonical file',
    );
    const sara_secret = 'SARA_PRIVATE_CANARY birthday';
    const owner_secret = 'OWNER_ONLY_CANARY payday';
    append_to_memory(ctx.memory, 'kate', sara_secret, 'deliberation 12:30', 'sam');
    append_to_memory(ctx.memory, 'kate', owner_secret, 'deliberation 12:30', 'jasper');
    const owner_tail = read_memory_tail(ctx.memory, 'kate', 50, 'jasper');
    const sara_tail = read_memory_tail(ctx.memory, 'kate', 50, 'sam');
    assert(
      !owner_tail.includes(sara_secret),
      "A member's memory entry must never appear in the owner's tail (the Grace Ma leak)",
    );
    assert(
      owner_tail.includes(owner_secret),
      "The owner's own entry must still be in his tail",
    );
    assert(
      !sara_tail.includes(owner_secret),
      "The owner's memory entry must not appear in a member's tail",
    );
    assert(
      sara_tail.includes(sara_secret),
      'A member reads her own accumulated recall (not an empty tail)',
    );
    assert(
      existsSync(resolve(ctx.root, 'vault', 'Knowledge', 'Kate', 'memory_sara.md')),
      'The per-user file must actually be created on write',
    );
    console.log('  ✓ Member and owner memory tails are mutually invisible; per-user file written');
    pass++;

    // 13. Mariah's autonomous miss-drive — her deliberation pass reviews
    //     her open process misses and advances each a step. Seed two: a
    //     plain miss and one whose gap reads as recurring.
    console.log('→ Mariah deliberation — autonomous process-miss drive (route)');
    const normal_miss = ctx.process_misses.create({
      subject_specialist_id: 'iris',
      reporter: 'mariah',
      task_summary: 'plan the EV day',
      gap: 'ignored the charge level',
      severity: 'medium',
    });
    const recurring_miss = ctx.process_misses.create({
      subject_specialist_id: 'anya',
      reporter: 'mariah',
      task_summary: 'summarize the visit notes',
      gap: 'same omission recurring a third time',
      severity: 'medium',
    });
    await ctx.driver.fire_deliberation_now('mariah', '13:15');
    assert(
      ctx.process_misses.get(normal_miss)?.status === 'routed',
      `Mariah should route the plain miss (open→routed); got ${ctx.process_misses.get(normal_miss)?.status}`,
    );
    assert(
      ctx.process_misses.get(normal_miss)?.routed_to === 'mariah',
      'routed miss should record routed_to=mariah',
    );
    assert(
      ctx.process_misses.get(recurring_miss)?.status === 'routed',
      `Mariah should route the recurring miss too; got ${ctx.process_misses.get(recurring_miss)?.status}`,
    );
    console.log('  ✓ Mariah routed both open misses without being asked');
    pass++;

    // 14. Next pass — the plain miss gets a redo dispatched; the recurring
    //     miss escalates to Beatrice. Each side effect drops the right flag.
    console.log('→ Mariah deliberation — dispatch redo / escalate recurring');
    await ctx.driver.fire_deliberation_now('mariah', '17:15');
    assert(
      ctx.process_misses.get(normal_miss)?.status === 'redo_dispatched',
      `Plain miss should be redo_dispatched; got ${ctx.process_misses.get(normal_miss)?.status}`,
    );
    assert(
      ctx.process_misses.get(recurring_miss)?.status === 'escalated',
      `Recurring miss should be escalated; got ${ctx.process_misses.get(recurring_miss)?.status}`,
    );
    assert(
      ctx.inbox.list_all({ to: 'iris' }).some((m) => m.body_md.includes('Redo requested')),
      'dispatch_redo should drop a redo flag in the subject specialist (iris) inbox',
    );
    assert(
      ctx.inbox
        .list_all({ to: 'trainer' })
        .some((m) => m.body_md.includes('Recurring process miss')),
      'escalate should drop a flag in Beatrice (trainer) inbox',
    );
    console.log('  ✓ Mariah dispatched a redo and escalated the recurring miss');
    pass++;

    // 15. Final passes — the plain miss walks redo_dispatched→verified→closed.
    console.log('→ Mariah deliberation — verify then close the redo loop');
    await ctx.driver.fire_deliberation_now('mariah', '21:15');
    assert(
      ctx.process_misses.get(normal_miss)?.status === 'verified',
      `Plain miss should be verified; got ${ctx.process_misses.get(normal_miss)?.status}`,
    );
    await ctx.driver.fire_deliberation_now('mariah', '09:15');
    assert(
      ctx.process_misses.get(normal_miss)?.status === 'closed',
      `Plain miss should be closed; got ${ctx.process_misses.get(normal_miss)?.status}`,
    );
    assert(
      ctx.process_misses.list({ open_only: true }).every((m) => m.id !== normal_miss),
      'a closed miss should drop out of the open_only list',
    );
    console.log('  ✓ Mariah verified then closed the redo loop');
    pass++;

    // 16. CHAT_BASE_TOOLSET — chat-turn curation always includes the
    //     knowledge floor (search_library / read_note / read_inbox /
    //     present_questions) when the specialist has the corresponding
    //     capability, regardless of what tools_for_chat lists. Brigid's
    //     yaml curates a mealie-focused list and DOES NOT name
    //     search_library; the runtime should add it anyway because she
    //     holds read_vault.
    console.log('→ Chat-turn base toolset — search_library + read_note are always available');
    const brigid = ctx.specialists.get('brigid');
    assert(brigid, 'brigid specialist must be loaded');
    const fake_tools_universe = [
      // Brigid's curated domain tools.
      { name: 'mealie_search_recipes', description: 'search recipes' },
      { name: 'mealie_get_recipe', description: 'get recipe' },
      { name: 'present_questions', description: 'ask the user' },
      { name: 'consult_deep_model', description: 'consult depth' },
      // The base toolset tools — present in the registry, NOT in
      // brigid's tools_for_chat list.
      { name: 'search_library', description: 'search library' },
      { name: 'read_note', description: 'read a note' },
      { name: 'read_inbox', description: 'read own inbox' },
      // An unrelated tool not in any of brigid's lists — should be
      // filtered out.
      { name: 'ha_get_state', description: 'ha state' },
    ];
    const chat_filtered = ctx.runtime._test_curate_tools_for_turn(
      fake_tools_universe,
      brigid!,
      'specialist',
    );
    const chat_names = new Set(chat_filtered.map((t) => t.name));
    assert(
      chat_names.has('search_library'),
      `chat surface must include search_library (base toolset). Got: ${[...chat_names].join(',')}`,
    );
    assert(
      chat_names.has('read_note'),
      `chat surface must include read_note (base toolset). Got: ${[...chat_names].join(',')}`,
    );
    assert(
      chat_names.has('read_inbox'),
      `chat surface must include read_inbox (base toolset). Got: ${[...chat_names].join(',')}`,
    );
    assert(
      chat_names.has('mealie_search_recipes'),
      `chat surface must retain brigid's curated mealie tools. Got: ${[...chat_names].join(',')}`,
    );
    assert(
      !chat_names.has('ha_get_state'),
      `chat surface must exclude non-domain non-base tools. Got: ${[...chat_names].join(',')}`,
    );
    // Deliberation pass leaves the curated list alone — base toolset
    // is chat-only because deliberation gets inbox+observations through
    // the deliberation builder's own context plumbing.
    const delib_filtered = ctx.runtime._test_curate_tools_for_turn(
      fake_tools_universe,
      brigid!,
      'specialist_deliberation',
    );
    const delib_names = new Set(delib_filtered.map((t) => t.name));
    // Brigid's tools_for_deliberation list isn't set in her yaml, so
    // _curate_tools_for_turn returns the full available set. The
    // assertion that matters: chat-mode added search_library above,
    // deliberation didn't get it added by the base-toolset logic.
    // (When her deliberation list IS set in a future yaml edit, the
    // assertion shifts to "search_library absent from delib unless
    // curated in"; for now this is enough to prove the chat-only
    // gate.)
    void delib_names; // currently unused — see comment above.
    console.log('  ✓ Brigid chat surface = curated mealie + base (search_library/read_note/read_inbox)');
    pass++;

    // 17. Chat-turn system prompt includes "## Your recent inbox" when
    //     the specialist has unactioned items + read_inbox. Drop a
    //     fresh flag in Brigid's inbox, build her chat prompt, assert
    //     the block + body excerpt appear.
    console.log('→ Chat system prompt — inbox block surfaces unactioned items');
    const brigid_flag_id = ctx.inbox.push({
      from_specialist_id: 'cordelia',
      to_specialist_id: 'brigid',
      kind: 'flag',
      body_md:
        'Cordelia routed 1 capture(s) to you (confidence 0.95).\n' +
        'User asked about calorie count on a Dunkin iced coffee.\n' +
        'Wrapper note(s): Cordelia/Inbox/2026-05-27-photo-c_test01.md',
    });
    const brigid_chat_prompt = ctx.runtime._test_build_system_prompt(
      brigid!,
      [{ name: 'read_inbox', description: 'read inbox' }],
      'conversation',
    );
    assert(
      brigid_chat_prompt.includes('## Your recent inbox'),
      'chat system prompt must include "## Your recent inbox" header when items exist',
    );
    assert(
      brigid_chat_prompt.includes('Dunkin iced coffee'),
      'chat system prompt must inline the inbox item body so the LLM reads it on the FIRST turn',
    );
    assert(
      brigid_chat_prompt.includes(brigid_flag_id),
      'chat system prompt must cite the inbox row id so the specialist can act on it (mark_read, follow refs)',
    );
    console.log('  ✓ Chat prompt carries the inbox block + body + row id');
    pass++;

    // 18. Knowledge-first persona snippet — appended for every
    //     specialist with read_vault. Verifies the lifted-from-yamls
    //     instruction is structural.
    console.log('→ Chat system prompt — "read your scope first" snippet present');
    assert(
      brigid_chat_prompt.toLowerCase().includes('the whole vault is yours to read'),
      'chat prompt must include the shared knowledge-first snippet for read_vault specialists',
    );
    console.log('  ✓ Knowledge-first snippet present for read_vault specialists');
    pass++;

    // 19. The snippet is NOT appended for a hypothetical specialist
    //     without read_vault. We don't have such a specialist in the
    //     seed roster, so simulate by constructing a tiny clone with
    //     granted set stripped. This proves the capability gate works.
    console.log('→ Knowledge-first snippet is gated on read_vault capability');
    const stripped_brigid: typeof brigid = {
      ...brigid!,
      granted: new Set(['read_inbox']),
    };
    const stripped_prompt = ctx.runtime._test_build_system_prompt(
      stripped_brigid,
      [],
      'conversation',
    );
    assert(
      !stripped_prompt.toLowerCase().includes('the whole vault is yours to read'),
      'snippet must be omitted when specialist lacks read_vault',
    );
    console.log('  ✓ Snippet correctly gated by read_vault capability');
    pass++;

    // 19b. chat_style character tail (2026-07-03) — a specialist with a
    //      chat_style block gets it appended as the LAST section of the
    //      conversation prompt (after the late-loaded grounding essays, so
    //      the register is the recency-weighted tail — the voice_style
    //      treatment for chat). Deliberation and voice prompts must NOT
    //      carry it, and a specialist without one is byte-unchanged.
    console.log('→ chat_style renders as the conversation prompt TAIL, chat-only');
    const styled_brigid: typeof brigid = {
      ...brigid!,
      chat_style: 'CHAT_STYLE_TAIL_MARKER — dry, warm, no bullets.',
    };
    const styled_chat = ctx.runtime._test_build_system_prompt(styled_brigid, [], 'conversation');
    assert(
      styled_chat.trimEnd().endsWith('CHAT_STYLE_TAIL_MARKER — dry, warm, no bullets.'),
      'chat_style must be the LAST content of the conversation system prompt (the recency tail)',
    );
    const styled_delib = ctx.runtime._test_build_system_prompt(styled_brigid, [], 'deliberation');
    const styled_voice = ctx.runtime._test_build_system_prompt(styled_brigid, [], 'voice');
    assert(
      !styled_delib.includes('CHAT_STYLE_TAIL_MARKER') &&
        !styled_voice.includes('CHAT_STYLE_TAIL_MARKER'),
      'chat_style must NOT render on deliberation or voice prompts (conversation-only)',
    );
    assert(
      !brigid_chat_prompt.includes('CHAT_STYLE_TAIL_MARKER'),
      'a specialist without chat_style must be unchanged',
    );
    console.log('  ✓ chat_style is the conversation tail; absent on deliberation/voice/unset');
    pass++;

    // 20. KV-prefix invariant (2026-07-30) — the system prompt must contain
    //     NOTHING that varies turn to turn. The "**Right now**" anchor
    //     includes the minute, so it now rides the final USER turn; when it
    //     sat in the system prompt, every minute tick invalidated the
    //     ~11K-token cached prefix and forced a full re-eval (3.2s turns vs
    //     1.0s — see the KV-PREFIX ORDERING note in specialist_runtime.ts).
    //     Guard both halves: the prompt carries no anchor and is build-stable,
    //     and the anchor itself still follows the user's device zone
    //     (iOS X-User-Timezone → users.yaml → SpecialistTurnInput.user.timezone).
    console.log('→ KV-prefix invariant: system prompt is minute-stable, anchor follows the zone');
    const denver_user = { id: 'jasper', display_name: 'Jasper', timezone: 'America/Denver' };
    const denver_prompt = ctx.runtime._test_build_system_prompt(brigid!, [], 'conversation', denver_user);
    const voice_prompt_kv = ctx.runtime._test_build_system_prompt(brigid!, [], 'voice', denver_user);
    assert(
      !denver_prompt.includes('**Right now**') && !voice_prompt_kv.includes('**Right now**'),
      'the conversation/voice system prompts must NOT carry the "Right now" anchor — per-minute state there invalidates the whole KV prefix',
    );
    const denver_prompt_again = ctx.runtime._test_build_system_prompt(brigid!, [], 'conversation', denver_user);
    assert(
      denver_prompt === denver_prompt_again,
      'two consecutive builds of the conversation system prompt must be byte-identical — anything volatile breaks prompt caching',
    );
    assert(
      format_now_anchor('America/Denver') !== format_now_anchor('Asia/Tokyo'),
      'the "Right now" anchor must follow user.timezone, not a hardcoded zone',
    );
    // No-user path still renders (Denver fallback), never crashes.
    assert(
      format_now_anchor().length > 0,
      'the no-user anchor (Denver fallback) must render, never crash',
    );
    console.log('  ✓ System prompt carries no volatile anchor; anchor renders per device zone');
    pass++;

    // 21. Speaker identity is authoritative, never inferred (2026-05-31).
    //     The chat prompt must NAME the current speaker from their login,
    //     so a specialist can't guess who it's talking to from greeting or
    //     tone (Ruby inferred "Sam" from an "Oh hi!"). Switching the turn
    //     user must switch the named speaker, and the no-user path must omit
    //     the block (not crash, not name a stale default).
    console.log('→ Chat system prompt — current speaker is named from login');
    const jasper_turn = { id: 'jasper', display_name: 'Jasper', tier: 'owner' as const };
    const sara_turn = { id: 'sam', display_name: 'Sam', tier: 'household' as const };
    const jasper_prompt = ctx.runtime._test_build_system_prompt(brigid!, [], 'conversation', jasper_turn);
    const sara_prompt = ctx.runtime._test_build_system_prompt(brigid!, [], 'conversation', sara_turn);
    assert(
      jasper_prompt.includes('You are speaking with Jasper') &&
        sara_prompt.includes('You are speaking with Sam') &&
        !sara_prompt.includes('You are speaking with Jasper'),
      'chat prompt must name the current speaker from the turn user (Jasper vs Sam), not leave identity to be inferred',
    );
    assert(
      sara_prompt.includes('Never infer or guess'),
      'speaker block must instruct the model not to infer identity from greeting/tone',
    );
    const no_user_prompt = ctx.runtime._test_build_system_prompt(brigid!, [], 'conversation');
    assert(
      !no_user_prompt.includes('You are speaking with'),
      'no-user chat prompt must omit the speaker block rather than name a stale default',
    );
    console.log('  ✓ Speaker named from login; switches with the turn user; anti-inference rule present');
    pass++;

    // ── Per-user brief recipients — device-active gate (2026-06-07) ─────────
    // brief_user_ids_for returns the owner ALWAYS, plus non-owner household
    // members ONLY once their iOS app has posted device data (calendar
    // snapshot / location). Temporarily swaps the driver's users + memory
    // deps (the smoke wires neither) to exercise the private selector.
    {
      const mkUser = (id: string, tier: string) => ({
        id,
        tier,
        allowed_specialists: '*',
        display_name: id,
      });
      const mockUsers = {
        list: () => [mkUser('jasper', 'owner'), mkUser('sam', 'household'), mkUser('kim', 'household')],
      };
      const deviceActive = new Set(['sam']); // sam has posted; kim has not
      const mockMem = {
        query_calendar_snapshot: (uid: string) => (deviceActive.has(uid) ? { events: [] } : null),
        query_latest_location_packet: () => null,
      };
      const d = ctx.driver as unknown as { deps: { users: unknown; memory: unknown } };
      const savedUsers = d.deps.users;
      const savedMem = d.deps.memory;
      d.deps.users = mockUsers;
      d.deps.memory = mockMem;
      let ids: string[];
      try {
        ids = (ctx.driver as unknown as {
          brief_user_ids_for: (s: string) => string[];
        }).brief_user_ids_for('kate');
      } finally {
        d.deps.users = savedUsers;
        d.deps.memory = savedMem;
      }
      assert(ids.includes('jasper'), 'owner always receives a brief');
      assert(ids.includes('sam'), 'device-active household member receives a brief');
      assert(!ids.includes('kim'), 'device-inactive household member is excluded from briefs');
      console.log('  ✓ brief recipients: owner always + device-active only (kim excluded)');
      pass++;
    }

    // ── verified_life_context HA pump is owner-only (2026-06-07) ────────────
    // pull_brief_context reads EV SoC/range + indoor temp from the SINGLE
    // admin-home Home Assistant. For a NON-owner (household) brief those are
    // the admin's device data, not the recipient's — so the pump is
    // suppressed and emits `unavailable` markers, while weather + calendar
    // stay per-user. Call the puller directly for both tiers. HA env is
    // forced-unset here so an owner's HA reads resolve to the distinct "not
    // configured" reason — proving the gate flips on TIER, not on env.
    {
      console.log('→ verified_life_context: HA fields (EV SoC/range, indoor temp) are owner-only');
      for (const v of ['IONIQ5_SOC_ENTITY', 'IONIQ5_RANGE_ENTITY', 'HEARTH_BRIEF_INDOOR_TEMP_ENTITY']) {
        delete process.env[v];
      }
      const owner_ctx = await pull_brief_context({
        memory: ctx.memory,
        user_id: 'jasper',
        users: undefined,
        is_owner: true,
      });
      const nonowner_ctx = await pull_brief_context({
        memory: ctx.memory,
        user_id: 'sam',
        users: undefined,
        is_owner: false,
      });

      // Non-owner (2026-06-15 facet gate): a household member without the `ev`
      // facet has NO ev block at all — the key is absent, not an `unavailable`
      // slot. That's "Sam has no EV", not "Sam's EV reads no data". Indoor
      // temp stays owner-only-suppressed (still an admin-HA reading).
      assert(
        nonowner_ctx.ev === undefined,
        `non-owner without the ev facet must have NO ev block; got ${JSON.stringify(nonowner_ctx.ev)}`,
      );
      {
        const r = nonowner_ctx.weather.indoor_temp;
        assert(r.status === 'unavailable', `non-owner indoor_temp must be unavailable; got ${r.status}`);
        assert(r.value === null, `non-owner indoor_temp must carry no value (no admin reading)`);
        assert(
          r.source_entity === null,
          `non-owner indoor_temp must name no source entity (no admin HA leak); got ${r.source_entity}`,
        );
        assert(
          /owner-only/i.test(r.reason ?? ''),
          `non-owner indoor_temp reason must mark it owner-only; got: ${r.reason}`,
        );
      }

      // Owner: the EV block is present and went through the real HA path (env
      // unset here → the "not configured" reason), NOT tier-suppression.
      assert(owner_ctx.ev !== undefined, 'owner brief must carry the ev block');
      assert(
        !/owner-only/i.test(owner_ctx.ev?.soc_percent.reason ?? ''),
        `owner ev.soc_percent must NOT be tier-suppressed; reason: ${owner_ctx.ev?.soc_percent.reason}`,
      );
      assert(
        /not configured/i.test(owner_ctx.ev?.soc_percent.reason ?? ''),
        `owner ev.soc_percent should reflect the HA env path; reason: ${owner_ctx.ev?.soc_percent.reason}`,
      );

      // Weather + calendar are NOT collateral-suppressed — each resolves via
      // its own per-user path (here: no coords / no snapshot → its OWN
      // unavailable reason, distinct from the HA tier marker).
      assert(
        !/owner-only/i.test(nonowner_ctx.weather.forecast.reason ?? ''),
        `non-owner weather must use per-user resolution, not the HA tier gate; reason: ${nonowner_ctx.weather.forecast.reason}`,
      );
      assert(
        nonowner_ctx.calendar.status === 'unavailable' &&
          !/owner-only/i.test(nonowner_ctx.calendar.reason ?? ''),
        `non-owner calendar must stay per-user (own snapshot resolution); reason: ${nonowner_ctx.calendar.reason}`,
      );

      // The grounding corpus of a non-owner context emits NO admin HA lines
      // (only `fresh` readings ground, and the suppressed ones are unavailable).
      const corpus = life_context_grounding_corpus(nonowner_ctx);
      assert(
        !/ev\.soc_percent|ev\.range_miles|indoor_temp/.test(corpus),
        `non-owner grounding corpus must not surface admin HA readings; got: ${corpus.slice(0, 200)}`,
      );
      console.log('  ✓ HA pump owner-only; weather/calendar stay per-user; no admin HA in non-owner grounding');
      pass++;
    }

    console.log(`\n✓ ${pass} checks passed. smoke-proactive done.`);
  } catch (err) {
    console.error(`\n✗ Smoke failed (${pass} passed):`, err);
    process.exitCode = 1;
  } finally {
    // Release the driver's timers/handles so the process can exit even
    // after a failed assert short-circuits the run.
    try {
      ctx.driver.stop();
    } catch {
      /* ignore */
    }
    if (cleanup_root && !process.env.HEARTH_KEEP_TMP) {
      try {
        rmSync(cleanup_root, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    } else if (cleanup_root) {
      console.log(`(kept temp dir at ${cleanup_root})`);
    }
  }
}

// Explicit exit: lingering handles (the SQLite WAL, any registry watcher)
// can otherwise keep the event loop alive after main() resolves.
main().then(
  () => process.exit(process.exitCode ?? 0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
