/**
 * smoke:universal-read — the universal read/search + memory-notebook floor
 * (2026-07-17), fully offline.
 *
 * Asserts:
 *  1. BASE_TOOLSET union now applies to DELIBERATION turns: a curated
 *     `tools_for_deliberation` list no longer strands the pass without
 *     search_library / read_note / recall_brain / remember / read_memory /
 *     read_my_proposals.
 *  2. Chat parity (regression) + voice-curated suppression (regression).
 *  3. read_note is UNSCOPED but enforces the per-user `private_to` cordon
 *     (fail-closed like RAG; invisible ⇒ "not found", no existence oracle).
 *  4. remember → read_memory round-trip against a temp vault, hard-scoped
 *     to the caller's own notebook (per-user isolation included).
 *  5. read_my_proposals pins specialist_id to the caller.
 *
 * Mirrors scripts/smoke-directed-task.ts's offline `new SpecialistRuntime`
 * + `_test_*` seam pattern.
 */
import { mkdtempSync, readFileSync, rmSync, existsSync, mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { SpecialistRuntime, type SpecialistRuntimeDeps } from '@core/specialist_runtime';
import type { LoadedSpecialist } from '@core/specialist';
import type { ToolContext } from '@core/tool';
import type { ToolDeps } from '@core/tool_deps';
import { read_note } from '@connectors/read_library_note';
import { remember, read_memory } from '../src/tools/memory_notebook';
import { create as create_read_my_proposals } from '../src/tools/read_my_proposals';

let failures = 0;
function check(label: string, ok: boolean): void {
  console.log(`${ok ? '✓' : '✗'} ${label}`);
  if (!ok) failures++;
}

// ── 1+2. Curation: the base floor unions into deliberation AND chat, not voice ──
const runtime = new SpecialistRuntime({} as unknown as SpecialistRuntimeDeps);
const spec = {
  id: 'mariah',
  granted: new Set<string>(['read_vault', 'read_inbox']),
  proactive: {
    tools_for_deliberation: ['domain_tool'],
    tools_for_chat: ['domain_tool'],
    tools_for_voice: ['domain_tool'],
  },
} as unknown as LoadedSpecialist;
const available = [
  { name: 'domain_tool' },
  { name: 'search_library' },
  { name: 'read_note' },
  { name: 'recall_brain' },
  { name: 'read_inbox' },
  { name: 'remember' },
  { name: 'read_memory' },
  { name: 'read_my_proposals' },
  { name: 'ungranted_tool' },
];
const FLOOR = [
  'search_library',
  'read_note',
  'recall_brain',
  'read_inbox',
  'remember',
  'read_memory',
  'read_my_proposals',
];

const delib = runtime._test_curate_tools_for_turn(available, spec, 'specialist_deliberation');
check(
  'deliberation surface unions the full read/memory floor',
  FLOOR.every((n) => delib.some((t) => t.name === n)),
);
check(
  'deliberation surface keeps the curated domain tool',
  delib.some((t) => t.name === 'domain_tool'),
);
check(
  'deliberation surface still excludes non-floor uncurated tools',
  !delib.some((t) => t.name === 'ungranted_tool'),
);

const chat = runtime._test_curate_tools_for_turn(available, spec, 'specialist');
check(
  'chat surface unions the full read/memory floor (regression)',
  FLOOR.every((n) => chat.some((t) => t.name === n)),
);

const voice = runtime._test_curate_tools_for_turn(available, spec, 'voice_realtime');
check(
  'voice-curated surface suppresses the union (lean prefill, regression)',
  voice.length === 1 && voice[0]!.name === 'domain_tool',
);

// ── 3. read_note: unscoped + private_to cordon ─────────────────────────────
const vault = mkdtempSync(join(tmpdir(), 'hearth-smoke-vault-'));
function write_note(rel: string, frontmatter: string, body: string): void {
  const abs = resolve(vault, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, `---\n${frontmatter}\n---\n${body}`, 'utf8');
}
write_note('Knowledge/Kate/secret_plan.md', 'title: Plan\nprivate_to: owner', 'The owner-only plan body.');
write_note('Knowledge/Linda/lee_note.md', 'title: Kim\nprivate_to: kim', "Kim's personal note body.");
write_note('People/Alex.md', 'title: Alex', 'Shared person note body.');

// Minimal MemoryClient stand-in: the exact surface these tools touch.
const fake_memory = {
  cfg: { vault_root: vault },
  read_note(rel_path: string) {
    const abs = resolve(vault, rel_path);
    if (!existsSync(abs)) return null;
    const raw = readFileSync(abs, 'utf8');
    const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(raw);
    const fm: Record<string, unknown> = {};
    for (const line of (m?.[1] ?? '').split('\n')) {
      const kv = /^(\w+):\s*(.*)$/.exec(line);
      if (kv) fm[kv[1]!] = kv[2];
    }
    return { frontmatter: fm, body: m?.[2] ?? raw };
  },
  append_to_note(rel_path: string, body_append: string): void {
    const abs = resolve(vault, rel_path);
    mkdirSync(dirname(abs), { recursive: true });
    if (!existsSync(abs)) writeFileSync(abs, '', 'utf8');
    appendFileSync(abs, `\n${body_append}`, 'utf8');
  },
  log_action(): void {},
};
const ctx_for = (user?: { id: string; tier: string }): ToolContext =>
  ({
    specialist_id: 'mariah',
    intent_id: 'smoke-universal-read',
    memory: fake_memory,
    user,
  }) as unknown as ToolContext;

async function read_ok(path: string, user?: { id: string; tier: string }): Promise<boolean> {
  try {
    await read_note.execute({ note_path: path, max_chars: undefined } as never, ctx_for(user));
    return true;
  } catch {
    return false;
  }
}

check(
  "owner reads ANOTHER specialist's shelf (scope gate removed)",
  await read_ok('Knowledge/Kate/secret_plan.md', { id: 'jasper', tier: 'owner' }),
);
check(
  'userless internal caller defaults to owner tier (legacy behavior)',
  await read_ok('People/Alex.md'),
);
check(
  "friend-tier caller CANNOT read another user's private_to note",
  !(await read_ok('Knowledge/Linda/lee_note.md', { id: 'sam', tier: 'friend' })),
);
check(
  'the private_to user themself CAN read their note',
  await read_ok('Knowledge/Linda/lee_note.md', { id: 'kim', tier: 'friend' }),
);
check(
  "owner CANNOT read a user's personal note (pure cordon, no owner bypass)",
  !(await read_ok('Knowledge/Linda/lee_note.md', { id: 'jasper', tier: 'owner' })),
);
check(
  'unstamped note is owner-only (fail-closed)',
  !(await read_ok('People/Alex.md', { id: 'kim', tier: 'friend' })),
);

// ── 4. remember → read_memory round-trip ───────────────────────────────────
const saved = await remember.execute(
  { note: 'Jasper prefers terse morning briefs.', context_tag: 'user preference' } as never,
  ctx_for({ id: 'jasper', tier: 'owner' }),
);
check(
  'remember writes to the caller-own notebook path',
  saved.saved === true && saved.memory_file === 'Knowledge/Mariah/memory.md',
);
const tail = await read_memory.execute(
  { last_n: 10 } as never,
  ctx_for({ id: 'jasper', tier: 'owner' }),
);
check(
  'read_memory returns the remembered entry verbatim',
  tail.entries.some((e) => e.body.includes('terse morning briefs')),
);
const lee_saved = await remember.execute(
  { note: 'Kim likes vinyl.', context_tag: undefined } as never,
  ctx_for({ id: 'kim', tier: 'friend' }),
);
check(
  'non-owner user writes are isolated to memory_<user>.md',
  lee_saved.memory_file === 'Knowledge/Mariah/memory_lee.md',
);
const jasper_tail = await read_memory.execute(
  { last_n: 10 } as never,
  ctx_for({ id: 'jasper', tier: 'owner' }),
);
check(
  "per-user isolation: Kim's entry never appears in Jasper's tail",
  !jasper_tail.entries.some((e) => e.body.includes('vinyl')),
);
const no_sid = await remember.execute(
  { note: 'context-less write attempt', context_tag: undefined } as never,
  { memory: fake_memory, intent_id: 'x' } as unknown as ToolContext,
);
check('remember without specialist context is a silent no-op', no_sid.saved === false);

// ── 5. read_my_proposals pins the caller ───────────────────────────────────
let seen_filter: Record<string, unknown> | null = null;
const fake_deps = {
  proposals: {
    list(filter: Record<string, unknown>) {
      seen_filter = filter;
      return [
        {
          id: 'p1',
          ts_created: '2026-07-17T00:00:00Z',
          status: 'pending',
          kind: 'action_proposal',
          title: 'T',
          summary: 'S',
          rationale_md: 'because',
          payload_json: '{"full":"body"}',
          execution_result_json: null,
          user_feedback: null,
          superseded_by: null,
        },
      ];
    },
  },
} as unknown as ToolDeps;
const rmp = create_read_my_proposals(fake_deps);
const out = await rmp.execute({ status: undefined, proposal_id: undefined, limit: 5 } as never, ctx_for());
check(
  'read_my_proposals pins specialist_id to the caller',
  seen_filter !== null && (seen_filter as Record<string, unknown>).specialist_id === 'mariah',
);
check(
  'read_my_proposals returns the FULL payload + rationale',
  out.rows.length === 1 && out.rows[0]!.payload_json === '{"full":"body"}' && out.rows[0]!.rationale_md === 'because',
);
const anon = await rmp.execute(
  { status: undefined, proposal_id: undefined, limit: 5 } as never,
  { memory: fake_memory, intent_id: 'x' } as unknown as ToolContext,
);
check('read_my_proposals without specialist context returns empty', anon.rows.length === 0);

rmSync(vault, { recursive: true, force: true });

if (failures > 0) {
  console.error(`\n✗ smoke-universal-read: ${failures} check(s) FAILED`);
  process.exit(1);
}
console.log('\n✓ smoke-universal-read: all checks passed');
