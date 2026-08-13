/**
 * Measure the serialized size of a specialist's DELIBERATION prompt surface.
 *
 * Replicates the runtime's tool-schema serialization (to_tooldef +
 * zodToJsonSchema, $refStrategy:'none') and the deterministic system/user
 * prompt components so we can see what's eating the context window for a
 * deliberation pass. The variable parts (live inbox, open misses, context
 * JSON, vault deltas) depend on production state and are reported as
 * "(runtime-variable)".
 *
 * Usage:  bun run scripts/measure-deliberation-prompt.ts <specialist_id>
 *
 * Not a smoke; a one-off investigative tool kept in-tree for the next time a
 * specialist's deliberation prompt overflows.
 */
import { resolve } from 'node:path';
import { zodToJsonSchema } from 'zod-to-json-schema';
import type { z } from 'zod';
import { ToolRegistry } from '../src/core/tool_registry';
import { ToolLoader, type ToolRoot } from '../src/core/tool_loader';
import { SpecialistRegistry } from '../src/core/specialist';
import { load_extra_capabilities } from '../src/core/capabilities';
import type { ToolDeps } from '../src/core/tool_deps';

const CHARS_PER_TOKEN = 3.7; // ~English+JSON; calibrated against prod 45,153-tok overflow
const tok = (s: string) => Math.round(s.length / CHARS_PER_TOKEN);
const line = (label: string, chars: number) =>
  `  ${label.padEnd(42)} ${String(chars).padStart(7)} chars  ~${String(
    Math.round(chars / CHARS_PER_TOKEN),
  ).padStart(6)} tok`;

const specialist_id = process.argv[2] ?? 'kristi';
const REPO_ROOT = resolve(import.meta.dir, '..');

// Replicate boot: the config-extended capability tokens (consult_deep_model,
// read_inbox, read_workstation_intel, …) must be registered before the
// SpecialistRegistry validates configs that grant them.
load_extra_capabilities(
  resolve(REPO_ROOT, process.env.HEARTH_CAPABILITIES_PATH ?? 'config/capabilities.yaml'),
);

// Stub deps: factories only capture these in closures (used inside execute,
// never at construction), so a shared inert proxy is enough to build the
// Tool objects and read their static Zod input_schema.
const inert: object = new Proxy(function () {}, {
  get: () => inert,
  apply: () => inert,
  construct: () => inert,
});
const deps = new Proxy({}, { get: () => inert }) as unknown as ToolDeps;

const registry = new ToolRegistry();
const roots: ToolRoot[] = [
  { dir: resolve(REPO_ROOT, 'src/connectors') },
  { dir: resolve(REPO_ROOT, 'src/tools') },
  { dir: resolve(REPO_ROOT, 'src/specialists'), pattern: /[/\\]tools[/\\]/ },
];
const loader = new ToolLoader({ registry, roots, deps });
await loader.load_all();

const specialists = new SpecialistRegistry(resolve(REPO_ROOT, 'config/specialists'));
const spec = specialists.get(specialist_id);
if (!spec) throw new Error(`no specialist ${specialist_id}`);

// Replicate to_tooldef exactly.
function serialize_tool(t: { name: string; description: string; input_schema: z.ZodType }): {
  name: string;
  chars: number;
} {
  let parameters: object;
  try {
    const schema = zodToJsonSchema(t.input_schema, { $refStrategy: 'none' }) as Record<
      string,
      unknown
    >;
    delete schema.$schema;
    parameters = schema;
  } catch {
    parameters = { type: 'object', additionalProperties: true };
  }
  // The provider sends { name, description, parameters } per tool.
  const serialized = JSON.stringify({ name: t.name, description: t.description, parameters });
  return { name: t.name, chars: serialized.length };
}

const delib_list = spec.proactive.tools_for_deliberation ?? [];
console.log(`\n=== ${specialist_id} — tools_for_deliberation (${delib_list.length} listed + consult_specialist) ===\n`);

const all = registry.list();
const by_name = new Map(all.map((t) => [t.name, t]));
let tool_total = 0;
const rows: Array<{ name: string; chars: number }> = [];
for (const name of delib_list) {
  const t = by_name.get(name);
  if (!t) {
    rows.push({ name: `${name}  (NOT LOADED)`, chars: 0 });
    continue;
  }
  const r = serialize_tool(t as never);
  rows.push(r);
  tool_total += r.chars;
}
rows.sort((a, b) => b.chars - a.chars);
for (const r of rows) console.log(line(r.name, r.chars));
console.log('  ' + '-'.repeat(60));
console.log(line(`TOOL SCHEMAS TOTAL (${delib_list.length} tools)`, tool_total));
console.log(
  `\n  Tool schemas ≈ ${tok(' '.repeat(tool_total))} tokens of the deliberation prompt.\n`,
);

// Deterministic prompt components.
const persona = (spec.persona_template ?? spec.persona ?? '').replace(/\{\{user_name\}\}/g, 'Jasper');
const prelude = spec.proactive.deliberation_prelude_override ?? '';
const outro = spec.proactive.deliberation_outro_override ?? '';
console.log(`=== ${specialist_id} — system+user prompt components (deterministic parts) ===\n`);
console.log(line('persona', persona.length));
console.log(line('deliberation_prelude_override', prelude.length));
console.log(line('deliberation_outro_override', outro.length));
console.log(
  line('knowledge_scope', (spec.knowledge_scope ?? []).join(', ').length),
);
console.log('\n  (runtime-variable, not measured here: inbox section, open-miss');
console.log('   ledger, context JSON [≤16000 chars], vault deltas, research-');
console.log('   workload block, fixed deliberation scaffolding ~3-4k chars)\n');

const measured = tool_total + persona.length + prelude.length + outro.length;
console.log(
  `  MEASURED DETERMINISTIC SUBTOTAL: ${measured} chars  ~${tok(
    ' '.repeat(measured),
  )} tok  (of the ~45,153-tok prod overflow)\n`,
);
