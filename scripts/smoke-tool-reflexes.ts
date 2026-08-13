export {}; // module scope
/**
 * smoke:tool-reflexes — every declared reflex must be a tool the specialist
 * can actually call.
 *
 * `tool_reflexes` is the routing table the runtime renders into the
 * recency-strong zone of every chat prompt: "this ask → that tool, this
 * turn." Its whole value is that the model can trust it — a reflex is the one
 * instruction in the prompt that says "don't deliberate, just call this." So a
 * reflex naming a tool that does not exist, or one this specialist's
 * capabilities cannot reach, is worse than no reflex at all: it teaches a
 * reliable reach for a call that comes back `unknown_tool` / `forbidden`,
 * burns the round, and drops the model into exactly the improvise-an-answer
 * state the table exists to prevent.
 *
 * Prose could never be checked this way, which is why the reflexes are data.
 * This lint is the other half of that trade — it is what makes the guarantee
 * real, and what stops the table rotting the way the prose did.
 *
 * Rules, per reflex:
 *   1. `tool` names a tool that EXISTS in the source tree.
 *   2. The specialist's granted capabilities SATISFY its
 *      `required_capabilities`.
 *   3. It is not `dispatch_only` (those run via proposal approval, never a
 *      direct LLM call — a reflex could never fire one).
 *   4. Within a specialist, no `tool` and no `when` repeats. A duplicated
 *      reflex is the prose-drift this table replaced, reappearing one level up.
 *
 * Reads the YAMLs and the tool SOURCE rather than booting the ToolRegistry —
 * the same choice smoke-yield-coverage-lint.ts makes and for the same reasons:
 * no DB, no LLM, no network, and no native-module load (the full tool graph
 * pulls jsdom → canvas, whose prebuilt binding is tied to a specific V8). That
 * keeps this runnable in the CI ring on any box.
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parse } from 'yaml';

const REPO = resolve(import.meta.dir, '..');
const SPECIALISTS_DIR = join(REPO, 'config', 'specialists');
const SEARCH_ROOTS = ['src/specialists', 'src/connectors', 'src/tools', 'src/agents'];

/* ── the tool index: name → { capabilities, dispatch_only } ─────────────── */

function walk(dir: string, acc: string[] = []): string[] {
  if (!existsSync(dir)) return acc;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, acc);
    else if (e.name.endsWith('.ts')) acc.push(p);
  }
  return acc;
}

const ALL_TS = SEARCH_ROOTS.flatMap((r) => walk(join(REPO, r)));

interface ToolFacts {
  required_capabilities: string[];
  dispatch_only: boolean;
}

/**
 * Read a tool's declaration out of its source. Anchors on `name: '<tool>'` and
 * reads to `execute(` — every Tool in this repo declares its metadata above
 * `execute`, so that is a reliable window terminator and keeps a neighbouring
 * tool in the same file from bleeding in. Same anchoring the yield lint uses.
 */
function tool_facts(tool: string): ToolFacts | null {
  for (const file of ALL_TS) {
    const src = readFileSync(file, 'utf8');
    const at = src.indexOf(`name: '${tool}'`);
    if (at === -1) continue;
    const exec_at = src.indexOf('execute(', at);
    const window = src.slice(at, exec_at === -1 ? at + 6000 : exec_at);

    const caps_m = /^[ \t]*required_capabilities:\s*\[([^\]]*)\]/m.exec(window);
    const required_capabilities = [...(caps_m?.[1] ?? '').matchAll(/'([^']+)'/g)]
      .map((m) => m[1])
      .filter((c): c is string => Boolean(c));
    const dispatch_only = /^[ \t]*dispatch_only:\s*true/m.test(window);

    return { required_capabilities, dispatch_only };
  }
  return null;
}

/* ── the reflex declarations ────────────────────────────────────────────── */

interface Reflex {
  when?: string;
  tool?: string;
  note?: string;
}
interface SpecDoc {
  id?: string;
  capabilities?: Record<string, boolean>;
  tool_reflexes?: Reflex[];
}

const failures: string[] = [];
let checked = 0;
let with_reflexes = 0;

for (const f of readdirSync(SPECIALISTS_DIR)) {
  if (!f.endsWith('.yaml')) continue;
  let doc: SpecDoc;
  try {
    doc = parse(readFileSync(join(SPECIALISTS_DIR, f), 'utf8')) as SpecDoc;
  } catch (err) {
    failures.push(`${f} does not parse: ${(err as Error).message}`);
    continue;
  }

  const reflexes = doc.tool_reflexes ?? [];
  if (reflexes.length === 0) continue;
  with_reflexes++;

  const id = doc.id ?? f.replace(/\.yaml$/, '');
  const granted = new Set(
    Object.entries(doc.capabilities ?? {})
      .filter(([, v]) => v === true)
      .map(([k]) => k),
  );

  const seen_tools = new Set<string>();
  const seen_whens = new Set<string>();

  for (const r of reflexes) {
    checked++;
    const where = `${id}: "${r.when ?? '(no when)'}"`;

    if (!r.tool) {
      failures.push(`${where} declares no \`tool\`.`);
      continue;
    }

    const facts = tool_facts(r.tool);
    if (!facts) {
      failures.push(
        `${where} → \`${r.tool}\` — no tool by that name exists in the source ` +
          `tree. Check the spelling, or the tool was renamed/removed.`,
      );
    } else {
      if (facts.dispatch_only) {
        failures.push(
          `${where} → \`${r.tool}\` is dispatch_only — it runs via proposal ` +
            `approval, never a direct call, so a reflex can never fire it.`,
        );
      }
      const missing = facts.required_capabilities.filter((c) => !granted.has(c));
      if (missing.length > 0) {
        failures.push(
          `${where} → \`${r.tool}\` needs ${missing.join(' + ')}, which ${id} is ` +
            `not granted. Grant it in config/specialists/${id}.yaml, or drop the ` +
            `reflex — do not ship a reflex the specialist cannot execute.`,
        );
      }
    }

    if (seen_tools.has(r.tool)) {
      failures.push(`${where} → \`${r.tool}\` is declared twice for ${id}.`);
    }
    seen_tools.add(r.tool);

    const when_key = (r.when ?? '').trim().toLowerCase();
    if (when_key && seen_whens.has(when_key)) {
      failures.push(`${where} — duplicate \`when\` for ${id}.`);
    }
    seen_whens.add(when_key);
  }
}

if (failures.length > 0) {
  console.error(`\n✗ tool_reflexes — ${failures.length} problem(s):\n`);
  for (const f of failures) console.error(`  - ${f}`);
  console.error('');
  process.exit(1);
}

console.log(
  `✓ tool_reflexes — ${checked} reflex(es) across ${with_reflexes} specialist(s): ` +
    `every tool exists, is callable by its specialist, and is declared once.`,
);
