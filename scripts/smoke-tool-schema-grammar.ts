/**
 * smoke:tool-schema-grammar — keeps the grammar-hostile keyword class DRAINED
 * from every tool's LLM-facing `parameters` schema.
 *
 * A tool `input_schema` becomes a JSON Schema (`to_tooldef`) and then a GBNF
 * grammar on the `--jinja` llama.cpp tiers. Length/range/item bounds and
 * `pattern`/`format` either silently disable the tool grammar OR — when two
 * sibling objects repeat a property name with different bounds — collide on the
 * generated rule name and make llama.cpp answer the whole request with
 * HTTP 400 "failed to parse grammar", killing the specialist's turn. That's the
 * 2026-07-13 Linda outage (draft_listing's ebay/poshmark/facebook `title` etc.).
 *
 * `sanitize_tool_schema_for_grammar` strips that keyword class from the
 * LLM-facing copy (Zod still enforces the bounds in execute()). This smoke
 * loads every tool exactly as the orchestrator does — same three ToolLoader
 * roots — reproduces the real conversion, and FAILS if any sanitized schema
 * still carries a hostile keyword at a schema-keyword position.
 *
 * Self-contained: throwaway SQLite + a stub dep bag; no orchestrator, no
 * network (mirrors smoke-tool-pattern-lint.ts).
 *
 *   bun run smoke:tool-schema-grammar
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { open_db } from '@memory/stores/structured';
import { ToolRegistry } from '@core/tool_registry';
import { ToolLoader, type ToolRoot } from '@core/tool_loader';
import type { ToolDeps } from '@core/tool_deps';
import {
  sanitize_tool_schema_for_grammar,
  find_grammar_hostile_positions,
} from '@core/tool_schema_grammar';

const dir = mkdtempSync(join(tmpdir(), 'hearth-schema-grammar-'));
process.env.HEARTH_KRISTI_DB_PATH = join(dir, 'kristi.db');
const db = open_db(join(dir, 'grammar.db'));

let failures = 0;
const check = (label: string, ok: boolean): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) failures++;
};

const handler: ProxyHandler<object> = {
  get(_t, prop) {
    if (prop === 'db') return db;
    if (prop === 'then') return undefined;
    return new Proxy(function () {} as object, handler);
  },
  apply() {
    return new Proxy(function () {} as object, handler);
  },
};
const deps = new Proxy({}, handler) as unknown as ToolDeps;

const to_json_schema = (schema: unknown): Record<string, unknown> => {
  const json = zodToJsonSchema(schema as Parameters<typeof zodToJsonSchema>[0], {
    $refStrategy: 'none',
  }) as Record<string, unknown>;
  delete json.$schema;
  return json;
};

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

  const tools = registry.list();
  check(`loaded a full tool surface (${tools.length} tools, expected > 200)`, tools.length > 200);

  // Guard against a vacuous pass: the raw (un-sanitized) schemas MUST contain
  // hostile keywords somewhere, or the test proves nothing.
  let raw_offenders = 0;
  for (const t of tools) {
    if (find_grammar_hostile_positions(to_json_schema(t.input_schema)).length > 0) raw_offenders++;
  }
  check(`raw schemas exercise the hostile class (${raw_offenders} tools carry bounds pre-sanitize)`, raw_offenders > 0);

  // The real gate: after sanitize, NO tool's schema carries a hostile keyword.
  const survivors: Array<{ tool: string; positions: string[] }> = [];
  for (const t of tools) {
    const sanitized = sanitize_tool_schema_for_grammar(to_json_schema(t.input_schema));
    const positions = find_grammar_hostile_positions(sanitized);
    if (positions.length > 0) survivors.push({ tool: t.name, positions });
  }
  if (survivors.length > 0) {
    console.error('\nTools whose sanitized schema STILL carries a grammar-hostile keyword:');
    for (const s of survivors) console.error(`  ${s.tool}: ${s.positions.join(', ')}`);
  }
  check('every sanitized tool schema is grammar-safe (no hostile keyword survives)', survivors.length === 0);

  // Targeted: draft_listing is the tool that first tripped the 400 — assert it
  // is present, exercised the bug pre-sanitize, and is clean after.
  const draft = tools.find((t) => t.name === 'draft_listing');
  check('draft_listing is loaded', !!draft);
  if (draft) {
    const raw = find_grammar_hostile_positions(to_json_schema(draft.input_schema));
    check(`draft_listing carried bounds pre-sanitize (${raw.length} positions)`, raw.length > 0);
    const clean = find_grammar_hostile_positions(
      sanitize_tool_schema_for_grammar(to_json_schema(draft.input_schema)),
    );
    check('draft_listing is grammar-safe post-sanitize', clean.length === 0);
  }

  // Structure is preserved: a property legitimately NAMED "format" (the eBay
  // fixed_price/auction enum) must survive sanitization; only keywords go.
  if (draft) {
    const sanitized = sanitize_tool_schema_for_grammar(to_json_schema(draft.input_schema)) as Record<string, unknown>;
    const ebay = ((sanitized.properties as Record<string, unknown>)?.ebay as Record<string, unknown>)
      ?.properties as Record<string, unknown> | undefined;
    check('property named "format" is preserved (only keywords stripped)', !!ebay && 'format' in ebay);
  }
} finally {
  try {
    db.close();
  } catch {
    /* ignore */
  }
  rmSync(dir, { recursive: true, force: true });
}

if (failures > 0) {
  console.error(`\n${failures} tool-schema-grammar assertion(s) FAILED`);
  process.exit(1);
}
console.log('\nAll tool-schema-grammar assertions passed.');
