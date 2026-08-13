/**
 * smoke:reveal-self — the owner-only service-mode self-reveal tool.
 *
 * Self-contained: fake ToolDeps (specialists / tool_registry / runtime / memory),
 * a temp YAML on disk for the raw-file read. No orchestrator, no LLM, no network.
 * Asserts: the owner gate, every part renders from the live config, the big parts
 * export to an owner-private vault note (right type + stamp), and the tool contract.
 */
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { create_reveal_self } from '../src/specialists/kate/tools/reveal_self';
import { is_auxiliary_note_type } from '../src/memory/schemas/note_types';

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string) {
  if (cond) {
    passed++;
    console.log('  ✓ ' + msg);
  } else {
    failed++;
    console.error('  ✗ ' + msg);
  }
}

const dir = mkdtempSync(join(tmpdir(), 'reveal-self-'));
const yamlPath = join(dir, 'kate.yaml');
writeFileSync(yamlPath, 'id: kate\nname: Kate\n# RAW-YAML-MARKER\npersona: |\n  hi\n');

const FAKE_KATE = {
  id: 'kate',
  name: 'Kate',
  role: 'Chief of Staff',
  persona: 'PERSONA-MARKER — you run this household.'.repeat(60), // big → export
  chat_addendum: 'CHAT-ADDENDUM-MARKER',
  deliberation_addendum: 'DELIB-ADDENDUM-MARKER',
  chat_style: 'CHAT-STYLE-MARKER — dry, warm.',
  voice_persona: 'VOICE-PERSONA-MARKER',
  voice_style: 'VOICE-STYLE-MARKER',
  capabilities: { read_vault: true, reveal_self: true, send_email: true, deprecated_off: false },
  granted: new Set(['read_vault', 'reveal_self', 'send_email']),
  llm_role: 'specialist',
  complexity_floor: 1,
  source_path: yamlPath,
  proactive: {
    tools_for_chat: ['reveal_self', 'search_library', 'consult_specialist'],
    tools_for_voice: ['weather_now'],
    tools_for_deliberation: ['propose_action', 'recall_precedent'],
    dynamic_tools: true,
    deliberation_at: ['07:00', '18:00'],
    background_jobs: [
      { name: 'system_health_scan', at: '*:10', tool: 'scan_system_health' },
      { name: 'household_reflection', at: '05:30', tool: 'reflect_household' },
    ],
    triggers: [{ def: 'home_arrival', task: 'x' }, { def: 'home_departure', task: 'y' }],
  },
};

const upserts: Array<{ path: string; fm: any; body: string }> = [];
const deps: any = {
  specialists: { get: (id: string) => (id === 'kate' ? FAKE_KATE : null) },
  tool_registry: {
    list_for_capabilities: (_g: Set<string>) => [
      { name: 'reveal_self', description: 'service mode' },
      { name: 'search_library', description: 'search' },
    ],
  },
  runtime: {
    _test_build_system_prompt: (_s: any, tools: any[], mode: string) =>
      `ASSEMBLED-PROMPT-MARKER mode=${mode} tools=${tools.length}\nPERSONA-MARKER floors...`,
  },
  memory: {
    upsert_note: (path: string, fm: any, body: string) => upserts.push({ path, fm, body }),
    log_action: () => 'audit_x',
  },
};

const OWNER = { id: 'jasper', tier: 'owner' as const };
const NON_OWNER = { id: 'sam', tier: 'household' as const };
const ctx = (user: any) =>
  ({ intent_id: 'i1', now: new Date('2026-07-08T12:00:00Z'), specialist_id: 'kate', user, memory: deps.memory }) as any;

async function main() {
  const tool = create_reveal_self(deps);

  console.log('→ contract');
  ok(tool.name === 'reveal_self', 'name is reveal_self');
  ok(tool.risk === 'read', 'risk is read');
  ok((tool.required_capabilities ?? []).includes('reveal_self'), 'requires reveal_self capability');
  ok(tool.volatile === true, 'volatile (re-reads on hot-reload)');
  ok(is_auxiliary_note_type('service_mode_export'), 'service_mode_export is a registered AUXILIARY note type');

  console.log('→ owner gate');
  const denied = await tool.execute({ part: 'persona' } as any, ctx(NON_OWNER));
  ok(denied.owner_only === true, 'non-owner is refused (owner_only)');
  ok(!/PERSONA-MARKER/.test(denied.content_md), 'non-owner sees NO config content');
  ok(upserts.length === 0, 'non-owner triggers no vault export');

  console.log('→ summary (owner, small, inline)');
  const sum = await tool.execute({ part: 'summary' } as any, ctx(OWNER));
  ok(/Chief of Staff/.test(sum.content_md) && /Ask me for/.test(sum.content_md), 'summary names role + offers a menu');
  ok(sum.saved_to === undefined, 'summary is inline (not exported)');

  console.log('→ capabilities (owner, small)');
  const caps = await tool.execute({ part: 'capabilities' } as any, ctx(OWNER));
  ok(/reveal_self/.test(caps.content_md) && /send_email/.test(caps.content_md), 'lists granted tokens');
  ok(!/deprecated_off/.test(caps.content_md), 'omits capabilities set false');

  console.log('→ tools + config (owner, small)');
  const tools = await tool.execute({ part: 'tools' } as any, ctx(OWNER));
  ok(/chat: 3 tools/.test(tools.content_md) && /dynamic_tools=true/.test(tools.content_md), 'tool surfaces + dynamic flag');
  const cfg = await tool.execute({ part: 'config' } as any, ctx(OWNER));
  ok(/system_health_scan/.test(cfg.content_md) && /home_arrival/.test(cfg.content_md), 'config lists jobs + triggers');
  ok(/llm_role/.test(cfg.content_md), 'config names the llm_role');
  ok(
    /interactive chat runs on the `live` tier/.test(cfg.content_md),
    'config RESOLVES the real model from llm-roles.yaml (no guessing)',
  );
  ok(
    /escalates MORE eagerly/.test(cfg.content_md) && /does NOT mean "less overhead"/.test(cfg.content_md),
    'config ANNOTATES field MEANINGS (complexity_floor read correctly, not glossed from memory)',
  );

  console.log('→ persona (owner, BIG → exported)');
  upserts.length = 0;
  const persona = await tool.execute({ part: 'persona' } as any, ctx(OWNER));
  ok(persona.saved_to === 'Knowledge/Kate/service-mode/persona.md', 'persona exported to the service-mode note');
  ok(upserts.length === 1, 'one vault write');
  ok(upserts[0]!.fm.type === 'service_mode_export', 'export note stamped service_mode_export');
  ok(upserts[0]!.fm.private_to !== undefined, 'export note carries a private_to cordon stamp');
  ok(/PERSONA-MARKER/.test(upserts[0]!.body), 'exported note body is the REAL persona');
  ok(/service-mode\/persona\.md/.test(persona.content_md), 'reply points to the exported path');

  console.log('→ system_prompt (owner, BIG → exported, assembled)');
  const sp = await tool.execute({ part: 'system_prompt' } as any, ctx(OWNER));
  ok(/ASSEMBLED-PROMPT-MARKER/.test(upserts.at(-1)!.body), 'exported system_prompt is the REAL assembled prompt');
  ok(sp.saved_to === 'Knowledge/Kate/service-mode/system_prompt.md', 'system_prompt exported');

  console.log('→ yaml (owner, BIG → exported, reads the file)');
  const y = await tool.execute({ part: 'yaml' } as any, ctx(OWNER));
  ok(/RAW-YAML-MARKER/.test(upserts.at(-1)!.body), 'exported yaml is the real file on disk');
  ok(y.saved_to === 'Knowledge/Kate/service-mode/yaml.md', 'yaml exported');

  console.log('→ system context (no user) reveals inline, no export');
  upserts.length = 0;
  const sys = await tool.execute({ part: 'persona' } as any, ctx(undefined));
  ok(/PERSONA-MARKER/.test(sys.content_md), 'absent user (legacy owner-default) reveals inline');
  ok(upserts.length === 0, 'no export without a user to stamp');

  rmSync(dir, { recursive: true, force: true });
  console.log(`\n${failed === 0 ? '✓' : '✗'} smoke:reveal-self — ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main();
