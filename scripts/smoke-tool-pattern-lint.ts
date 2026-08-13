/**
 * smoke:tool-pattern-lint — keeps the regex-`pattern` class DRAINED.
 *
 * A tool `input_schema` becomes a JSON Schema and then a GBNF grammar on the
 * interactive 9B (beellama/llama.cpp on :8088). llama.cpp's JSON-Schema→GBNF
 * converter MISTRANSLATES a regex `pattern` and SILENTLY disables the whole
 * tool grammar — the server then generates unconstrained and returns 200 OK
 * (llama.cpp #22314 / #19051). There is no validation error, so the central
 * `_recover_tool_args` layer cannot fix it: the ONLY fix is removing the
 * `pattern` at authoring time and validating in `execute()` (see
 * src/specialists/kate/tools/propose_hire.ts for the canonical pattern).
 *
 * `ToolRegistry.lint()` flags this at boot, but boot warnings get missed — a
 * `.regex()` reappeared in a new connector the same week the lint shipped. This
 * smoke promotes the boot warning to a HARD gate: it loads every tool exactly
 * as the orchestrator does (the same three ToolLoader roots) and FAILS if any
 * registered tool's input_schema carries a regex `pattern`.
 *
 * Self-contained — a throwaway SQLite file + a stub dep bag; no orchestrator,
 * no network. The stub resolves `deps.db` to the real temp db and returns a
 * benign callable proxy for everything else, which is enough for every tool
 * factory to construct (they touch real deps only at execute time).
 *
 *   bun run smoke:tool-pattern-lint
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { open_db } from '@memory/stores/structured';
import { ToolRegistry } from '@core/tool_registry';
import { ToolLoader, type ToolRoot } from '@core/tool_loader';
import type { ToolDeps } from '@core/tool_deps';

const dir = mkdtempSync(join(tmpdir(), 'hearth-pattern-lint-'));
// Kristi's process-singleton store reads this env at first construction.
process.env.HEARTH_KRISTI_DB_PATH = join(dir, 'kristi.db');
const db = open_db(join(dir, 'lint.db'));

let failures = 0;
const check = (label: string, ok: boolean): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) failures++;
};

// A stub dep bag: `db` is real (some factories build a store at construction);
// every other access returns a callable no-op proxy so a factory never throws.
const handler: ProxyHandler<object> = {
  get(_t, prop) {
    if (prop === 'db') return db;
    if (prop === 'then') return undefined; // not a thenable
    return new Proxy(function () {} as object, handler);
  },
  apply() {
    return new Proxy(function () {} as object, handler);
  },
};
const deps = new Proxy({}, handler) as unknown as ToolDeps;

try {
  const registry = new ToolRegistry();
  const REPO_ROOT = resolve(import.meta.dir, '..');
  const roots: ToolRoot[] = [
    { dir: resolve(REPO_ROOT, 'src/connectors') },
    { dir: resolve(REPO_ROOT, 'src/tools') },
    { dir: resolve(REPO_ROOT, 'src/specialists'), pattern: /[/\\]tools[/\\]/ },
  ];
  const loader = new ToolLoader({ registry, deps, roots });
  await loader.load_all();

  const loaded = registry.list().length;
  // Guard against a vacuous pass: if loading silently broke and registered
  // almost nothing, "zero offenders" would be a false green.
  check(`loaded a full tool surface (${loaded} tools, expected > 200)`, loaded > 200);

  const offenders = registry
    .lint()
    .map((w) => ({
      tool: w.tool,
      fields: w.warnings
        .filter((m) => /pattern|GBNF/.test(m))
        .map((m) => m.match(/field `([^`]+)`/)?.[1] ?? '<root>'),
    }))
    .filter((o) => o.fields.length > 0);

  if (offenders.length > 0) {
    console.error('\nTools with a regex `pattern` in their input_schema:');
    for (const o of offenders) console.error(`  ${o.tool}: ${o.fields.join(', ')}`);
    console.error(
      '\nRemove the `.regex(...)` from the Zod input_schema and validate the ' +
        'shape in execute() instead (see propose_hire.ts).',
    );
  }
  check('no registered tool has a regex `pattern` (GBNF silent-fail-open trap)', offenders.length === 0);
} finally {
  try {
    db.close();
  } catch {
    /* ignore */
  }
  rmSync(dir, { recursive: true, force: true });
}

if (failures > 0) {
  console.error(`\n${failures} tool-pattern-lint assertion(s) FAILED`);
  process.exit(1);
}
console.log('\nAll tool-pattern-lint assertions passed.');
