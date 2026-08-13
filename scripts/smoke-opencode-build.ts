/**
 * smoke:opencode-build — the OpenCode harness integration seams (2026-07-18).
 *
 * The full harness run needs the binary + a live model, so this smoke covers
 * everything AROUND it deterministically:
 *   A. partition_porcelain — the collection filter (injected-file exclusion,
 *      allowlist skips, deletion/rename rejection, quoted paths).
 *   B. Degradation shapes — kill switch + missing binary both return honest
 *      ok:false results pointing at the workbench, never a throw.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { open_db } from '@memory/stores/structured';
import { SpecialistInbox } from '@memory/stores/conversations';
import type { ToolContext, Tool } from '@core/tool';
import type { ToolDeps } from '@core/tool_deps';
import {
  make_opencode_build,
  partition_porcelain,
  opencode_enabled,
} from '../src/specialists/trainer/tools/opencode_build';

let failures = 0;
function assert(cond: unknown, msg: string): void {
  if (cond) console.log(`  ✓ ${msg}`);
  else {
    console.error(`  ✗ ${msg}`);
    failures++;
  }
}

// ── A. partition_porcelain ──────────────────────────────────────────────────
console.log('A. partition_porcelain — the collection filter');
{
  const porcelain = [
    ' M src/core/example.ts',
    '?? scripts/smoke-new.ts',
    ' M opencode.json', // injected — dropped silently
    ' M the private dev log', // injected — dropped silently
    '?? .home/.config/opencode/state', // jail — dropped silently
    ' M package.json', // outside allowlist — skipped with a note
    ' D src/core/dead.ts', // deletion — not collectable
    'R  src/old.ts -> src/new_name.ts', // rename = delete + add
    '?? "src/app/weird name.ts"', // quoted path
  ].join('\n');
  const res = partition_porcelain(porcelain);
  assert(
    res.collect.includes('src/core/example.ts') && res.collect.includes('scripts/smoke-new.ts'),
    'allowlisted modifications + new files are collected',
  );
  assert(
    !res.collect.some((p) => p === 'opencode.json' || p === 'the private dev log' || p.startsWith('.home/')),
    'injected files + the .home jail never collect',
  );
  assert(
    res.skipped_outside_allowlist.includes('package.json'),
    'non-allowlisted paths are skipped WITH a note (not failed)',
  );
  assert(
    res.deletions.includes('src/core/dead.ts') && res.deletions.includes('src/old.ts'),
    'deletions and rename-sources are surfaced as not-collectable',
  );
  assert(res.collect.includes('src/new_name.ts'), 'rename-target collects as an add');
  assert(res.collect.includes('src/app/weird name.ts'), 'quoted paths are unwrapped');
  assert(partition_porcelain('').collect.length === 0, 'empty porcelain → empty buckets');
}

// ── B. degradation shapes ───────────────────────────────────────────────────
console.log('B. degradation — kill switch + missing binary');
{
  const tmp = mkdtempSync(join(tmpdir(), 'smoke-oc-build-'));
  const db = open_db(join(tmp, 'test.db'));
  const tool = make_opencode_build({
    db,
    inbox: new SpecialistInbox(db),
    events: { emit: () => undefined } as unknown as ToolDeps['events'],
  }) as Tool;
  const ctx = {
    memory: { log_action: () => 'audit_fake' },
    now: new Date(),
    intent_id: 'i1',
    specialist_id: 'trainer',
  } as unknown as ToolContext;
  const run = (env: Record<string, string | undefined>) => {
    const prev: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(env)) {
      prev[k] = process.env[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    const p = tool.execute(
      tool.input_schema.parse({ task: 'add a trivial comment somewhere reasonable in scripts/' }),
      ctx,
    ) as Promise<Record<string, unknown>>;
    return p.finally(() => {
      for (const [k, v] of Object.entries(prev)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    });
  };

  const killed = await run({ HEARTH_OPENCODE: '0' });
  assert(
    killed.ok === false && String(killed.error).includes('disabled'),
    'kill switch declines honestly',
  );
  assert(
    String(killed.next_action).includes('workbench'),
    'kill-switch recovery points at the workbench',
  );
  assert(opencode_enabled(), 'kill switch env restored after the run');

  const missing = await run({
    HEARTH_OPENCODE: undefined,
    HEARTH_OPENCODE_BIN: join(tmp, 'no-such-binary'),
  });
  assert(
    missing.ok === false && String(missing.error).includes('harness unavailable'),
    'missing binary degrades to an honest harness-unavailable result',
  );
  assert(
    String(missing.next_action).includes('workbench'),
    'missing-binary recovery points at the workbench',
  );

  db.close();
  rmSync(tmp, { recursive: true, force: true });
}

if (failures > 0) {
  console.error(`\nsmoke:opencode-build FAILED — ${failures} assertion(s)`);
  process.exit(1);
}
console.log('\nsmoke:opencode-build PASSED');
process.exit(0);
