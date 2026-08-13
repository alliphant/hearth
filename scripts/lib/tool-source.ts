/**
 * Read tool declarations out of the SOURCE tree, without booting the registry.
 *
 * The config lints (`smoke:tool-reflexes`, `smoke:standing-duties`,
 * `smoke:prompt-supply`) all need the same three facts about a tool — does it
 * exist, what capabilities does it need, is it dispatch-only — and all three
 * need to run in the CI ring, which means no DB, no LLM, no network and no
 * native modules. Booting the real ToolRegistry pulls the whole tool graph,
 * which reaches jsdom → canvas, whose prebuilt binding is tied to a specific
 * V8 and dies on load wherever that doesn't match.
 *
 * So the lints read the declarations the way `smoke:yield-coverage-lint`
 * already does: anchor on `name: '<tool>'`, read to `execute(`. Every Tool in
 * this repo declares its metadata above `execute`, which makes that a reliable
 * window terminator and keeps a neighbouring tool in the same file from
 * bleeding in.
 *
 * This module exists because that reader was about to be copy-pasted into a
 * third script. It is deliberately test-only — nothing in `src/` imports it.
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const REPO = resolve(import.meta.dir, '..', '..');
const SEARCH_ROOTS = ['src/specialists', 'src/connectors', 'src/tools', 'src/agents'];

export interface ToolFacts {
  required_capabilities: string[];
  dispatch_only: boolean;
  /** Source file the declaration was found in — useful in failure messages. */
  file: string;
}

function walk(dir: string, acc: string[] = []): string[] {
  if (!existsSync(dir)) return acc;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, acc);
    else if (e.name.endsWith('.ts')) acc.push(p);
  }
  return acc;
}

let _index: Map<string, ToolFacts> | null = null;

/** Every tool declared in the source tree, by name. Built once per process. */
export function tool_index(): Map<string, ToolFacts> {
  if (_index) return _index;
  const idx = new Map<string, ToolFacts>();
  const DECL = /^[ \t]*name: '([a-z][a-z0-9_]*)',/gm;
  for (const file of SEARCH_ROOTS.flatMap((r) => walk(join(REPO, r)))) {
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(DECL)) {
      const name = m[1]!;
      if (idx.has(name)) continue; // first declaration wins, as the loader does
      const at = m.index!;
      const exec_at = src.indexOf('execute(', at);
      const w = src.slice(at, exec_at === -1 ? at + 6000 : exec_at);
      const caps = /^[ \t]*required_capabilities:\s*\[([^\]]*)\]/m.exec(w);
      idx.set(name, {
        required_capabilities: [...(caps?.[1] ?? '').matchAll(/'([^']+)'/g)]
          .map((c) => c[1])
          .filter((c): c is string => Boolean(c)),
        dispatch_only: /^[ \t]*dispatch_only:\s*true/m.test(w),
        file: file.slice(REPO.length + 1),
      });
    }
  }
  _index = idx;
  return idx;
}

/** Facts for one tool, or null when no such tool is declared anywhere. */
export function tool_facts(name: string): ToolFacts | null {
  return tool_index().get(name) ?? null;
}

/** Capability tokens this specialist grants (`{cap: true}` entries only). */
export function granted_set(caps: Record<string, boolean> | undefined): Set<string> {
  return new Set(
    Object.entries(caps ?? {})
      .filter(([, v]) => v === true)
      .map(([k]) => k),
  );
}

/** Which of `tool`'s required capabilities this specialist is missing. */
export function missing_capabilities(name: string, granted: ReadonlySet<string>): string[] {
  return (tool_facts(name)?.required_capabilities ?? []).filter((c) => !granted.has(c));
}
