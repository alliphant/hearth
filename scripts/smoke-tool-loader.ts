/**
 * smoke:tool-loader — self-contained test of the dynamic ToolLoader.
 *
 * Drives a ToolLoader against a throwaway temp directory and asserts the
 * registry stays in sync as tool files appear, change, break, and vanish
 * — with no process restart. No orchestrator, no port, no vault.
 *
 *   bun run smoke:tool-loader
 *
 * The temp tool files are deliberately dependency-free (hand-rolled
 * objects, not zod schemas) so the smoke runs anywhere, including
 * outside the project tree.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ToolRegistry } from '@core/tool_registry';
import { ToolLoader } from '@core/tool_loader';
import type { ToolDeps } from '@core/tool_deps';

let failures = 0;
function check(label: string, ok: boolean): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) failures++;
}

async function wait_for(
  label: string,
  cond: () => boolean,
  ms = 5000,
): Promise<void> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (cond()) {
      check(label, true);
      return;
    }
    await Bun.sleep(50);
  }
  check(`${label} (timed out after ${ms}ms)`, false);
}

const PLAIN_TOOL = (desc: string): string => `
export const tool = {
  name: 'smoke_sample',
  description: ${JSON.stringify(desc)},
  risk: 'read',
  required_capabilities: [],
  input_schema: { safeParse: (x) => ({ success: true, data: x }) },
  output_schema: { safeParse: (x) => ({ success: true, data: x }) },
  idempotency_key: () => 'smoke_sample',
  execute: async () => ({ ok: true }),
};
`;

const FACTORY_TOOL = `
export function create(_deps) {
  return {
    name: 'smoke_factory',
    description: 'made-by-create',
    risk: 'read',
    required_capabilities: [],
    input_schema: { safeParse: (x) => ({ success: true, data: x }) },
    output_schema: { safeParse: (x) => ({ success: true, data: x }) },
    idempotency_key: () => 'smoke_factory',
    execute: async () => ({}),
  };
}
`;

const BROKEN_TOOL = `export const tool = { name: 'smoke_broken' this is not valid`;

const dir = mkdtempSync(join(tmpdir(), 'hearth-tool-loader-'));
const registry = new ToolRegistry();
const loader = new ToolLoader({
  registry,
  deps: {} as unknown as ToolDeps,
  roots: [{ dir }],
});

try {
  // 1 — boot scan picks up a pre-existing tool file.
  writeFileSync(join(dir, 'sample_tool.ts'), PLAIN_TOOL('v1'));
  await loader.load_all();
  check('boot scan registers a plain `export const` tool', registry.has('smoke_sample'));
  check('boot tool loaded at v1', registry.get('smoke_sample')?.description === 'v1');

  // 2 — a brand-new file added while watching becomes invocable, no restart.
  await loader.watch();
  writeFileSync(join(dir, 'factory_tool.ts'), FACTORY_TOOL);
  await wait_for('new create()-style tool is discovered with no restart', () =>
    registry.has('smoke_factory'),
  );

  // 3 — an in-place rewrite hot-reloads (exercises the snapshot path that
  // works around Bun's path-keyed module cache).
  writeFileSync(join(dir, 'sample_tool.ts'), PLAIN_TOOL('v2'));
  await wait_for('changed tool file hot-reloads to v2', () =>
    registry.get('smoke_sample')?.description === 'v2',
  );

  // 4 — a malformed tool file is skipped, not fatal; siblings survive.
  writeFileSync(join(dir, 'broken_tool.ts'), BROKEN_TOOL);
  await Bun.sleep(1200);
  check('malformed tool file is not registered', !registry.has('smoke_broken'));
  check(
    'malformed file leaves existing tools intact',
    registry.has('smoke_sample') && registry.has('smoke_factory'),
  );
  // Reaching this line at all means the bad module did not crash the host.
  check('process survived loading a malformed module', true);

  // 5 — deleting a tool file unregisters its tool.
  rmSync(join(dir, 'factory_tool.ts'));
  await wait_for('deleting a tool file unregisters its tool', () =>
    !registry.has('smoke_factory'),
  );

  // 6 — cross-module: a tool that imports a fresh export from a sibling
  // dependency module, both written in one burst (the `git pull` shape).
  // The debounce must let the dependency land before the tool imports it,
  // and the snapshot path must resolve the sibling import. This is the
  // scenario behind the "first restart logs `load failed (keeping
  // previous)`" transient.
  const DEP = (v: string): string =>
    `export const LABEL = ${JSON.stringify(v)};\n`;
  const TOOL_USING_DEP = `
import { LABEL } from './dep_module.ts';
export const tool = {
  name: 'smoke_crossmod',
  description: LABEL,
  risk: 'read',
  required_capabilities: [],
  input_schema: { safeParse: (x) => ({ success: true, data: x }) },
  output_schema: { safeParse: (x) => ({ success: true, data: x }) },
  idempotency_key: () => 'smoke_crossmod',
  execute: async () => ({ ok: true }),
};
`;
  // Burst-write both files (dependency first, then importer) with no gap —
  // the debounce should coalesce the resulting events into one clean load.
  writeFileSync(join(dir, 'dep_module.ts'), DEP('dep-v1'));
  writeFileSync(join(dir, 'crossmod_tool.ts'), TOOL_USING_DEP);
  await wait_for('cross-module tool loads its sibling dependency export', () =>
    registry.get('smoke_crossmod')?.description === 'dep-v1',
  );

  // 7 — a rapid multi-write burst on the same tool entry collapses to ONE
  // reload that reflects the LAST write. (A tool entry's own cache is busted
  // by the snapshot, so rewriting the entry — unlike rewriting an
  // already-imported dependency, which is restart-class — is picked up.)
  for (const v of ['v3', 'v4', 'v5']) {
    writeFileSync(join(dir, 'sample_tool.ts'), PLAIN_TOOL(v));
    // No await between writes: a near-simultaneous burst.
  }
  await wait_for('burst of rewrites on one entry settles to the final value', () =>
    registry.get('smoke_sample')?.description === 'v5',
  );

  // 8 — a PACK whose member imports OUT of the pack directory. The pack is
  // snapshotted wholesale to load it, and a relative specifier resolves
  // against the importing file's directory — so the snapshot must sit at
  // the pack's own depth. Nested one level deeper (the pre-2026-07-21 bug),
  // every `../` lands one directory short: the real Kate pack's
  // `archive_url.ts` → `../media_archive_runner` failed to resolve and the
  // loader silently kept serving the pre-change tools.
  const packdir = join(dir, 'packpkg');
  mkdirSync(packdir, { recursive: true });
  // Lives OUTSIDE the pack, one level up — reached as `../outside_dep.ts`.
  writeFileSync(join(dir, 'outside_dep.ts'), `export const OUT = 'outside-v1';\n`);
  const PACK_INDEX = (v: string): string => `
import { OUT } from '../outside_dep.ts';
import { INNER } from './inner_dep.ts';
export function create(_deps) {
  return {
    name: 'smoke_pack',
    description: OUT + '/' + INNER + '/' + ${JSON.stringify(v)},
    risk: 'read',
    required_capabilities: [],
    input_schema: { safeParse: (x) => ({ success: true, data: x }) },
    output_schema: { safeParse: (x) => ({ success: true, data: x }) },
    idempotency_key: () => 'smoke_pack',
    execute: async () => ({ ok: true }),
  };
}
`;
  writeFileSync(join(packdir, 'inner_dep.ts'), `export const INNER = 'inner';\n`);
  writeFileSync(join(packdir, 'index.ts'), PACK_INDEX('v1'));
  await wait_for(
    'pack member importing OUT of the pack dir loads (escaping relative import resolves)',
    () => registry.get('smoke_pack')?.description === 'outside-v1/inner/v1',
  );

  // 8b — and it HOT-RELOADS: the snapshot path (not just the boot path)
  // must resolve the escaping import, since that is where it broke.
  writeFileSync(join(packdir, 'index.ts'), PACK_INDEX('v2'));
  await wait_for('pack with an escaping import hot-reloads', () =>
    registry.get('smoke_pack')?.description === 'outside-v1/inner/v2',
  );
  const pack_stale = (): boolean =>
    loader.stale_entries().some((s) => s.entry.includes('packpkg'));
  check('a healthy pack reload leaves no stale-entry marker', !pack_stale());

  // 9 — a reload that FAILS must not look like a success. The registry
  // keeps the previous tools (isolation), but the entry is recorded as
  // stale so /status and operators can see the running set is out of date.
  // NOTE: the bad import must be USED — an unused named import is elided
  // as type-only before resolution ever runs, so it would load clean.
  writeFileSync(
    join(packdir, 'index.ts'),
    `import { NOPE } from '../does_not_exist.ts';\nexport const marker = NOPE;\n`,
  );
  await wait_for('failed pack reload is recorded as stale', pack_stale);
  check(
    'failed reload keeps serving the previous tool (isolation holds)',
    registry.get('smoke_pack')?.description === 'outside-v1/inner/v2',
  );
  const stale = loader.stale_entries().find((s) => s.entry.includes('packpkg'));
  check(
    'stale record names the tools still being served from the old version',
    stale?.serving.includes('smoke_pack') === true,
  );
  check('stale record carries the failing error', (stale?.error ?? '').length > 0);

  // 9b — a later good load clears the stale marker.
  writeFileSync(join(packdir, 'index.ts'), PACK_INDEX('v3'));
  await wait_for('a successful reload clears the stale marker', () =>
    registry.get('smoke_pack')?.description === 'outside-v1/inner/v3' &&
    !pack_stale(),
  );
} finally {
  await loader.close();
  rmSync(dir, { recursive: true, force: true });
}

console.log(
  failures === 0
    ? '\nsmoke:tool-loader OK'
    : `\nsmoke:tool-loader FAILED (${failures} check(s))`,
);
process.exit(failures === 0 ? 0 : 1);
