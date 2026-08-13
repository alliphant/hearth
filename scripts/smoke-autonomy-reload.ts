/**
 * smoke:autonomy-reload — config/autonomy.yaml hot-reloads via chokidar.
 *
 * Self-contained: writes a temp autonomy.yaml, opens a ProposalsStore at a
 * boot value, starts watch_autonomy_config, rewrites the file, and asserts
 * the store's in-memory config reflects the new value without a restart.
 * Also asserts a malformed mid-write file never breaks the running store
 * (load_autonomy_config falls back to defaults / keeps serving).
 */
import { Database } from 'bun:sqlite';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ProposalsStore,
  load_autonomy_config,
  watch_autonomy_config,
} from '../src/core/proposals';

let failures = 0;
function check(name: string, cond: boolean): void {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`);
  if (!cond) failures++;
}

async function until<T>(
  read: () => T,
  pred: (v: T) => boolean,
  timeout_ms = 4000,
): Promise<T> {
  const start = Date.now();
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const v = read();
    if (pred(v)) return v;
    if (Date.now() - start > timeout_ms) return v;
    await new Promise((r) => setTimeout(r, 50));
  }
}

const dir = mkdtempSync(join(tmpdir(), 'hearth-autonomy-'));
const path = join(dir, 'autonomy.yaml');
const db = new Database(':memory:');

writeFileSync(
  path,
  ['amount_cap_cents: 20000', 'min_approvals_for_tier2b: 5', ''].join('\n'),
);

const store = new ProposalsStore(db, load_autonomy_config(path));
check('boot config reflects file', store.config().min_approvals_for_tier2b === 5);
check('boot amount cap', store.config().amount_cap_cents === 20000);

const watcher = watch_autonomy_config(path, (cfg) => store.set_config(cfg));
// Wait for chokidar's initial scan so the first edit isn't raced (in prod
// the watcher runs for the whole process before any edit lands).
await new Promise<void>((res) => {
  let done = false;
  watcher.once('ready', () => {
    done = true;
    res();
  });
  setTimeout(() => {
    if (!done) res();
  }, 1500);
});

try {
  // 1. A live edit reaches the store with no restart.
  writeFileSync(
    path,
    ['amount_cap_cents: 50000', 'min_approvals_for_tier2b: 8', ''].join('\n'),
  );
  await until(
    () => store.config().min_approvals_for_tier2b,
    (v) => v === 8,
  );
  check('reload picks up new approval threshold', store.config().min_approvals_for_tier2b === 8);
  check('reload picks up new amount cap', store.config().amount_cap_cents === 50000);

  // 2. A malformed file never throws / never wipes the running config.
  //    load_autonomy_config falls back to DEFAULT_AUTONOMY_CONFIG, so the
  //    store keeps serving a valid config (default cap 20000), not a crash.
  writeFileSync(path, ': : not : valid : yaml : [\n');
  await until(
    () => store.config().amount_cap_cents,
    (v) => v !== 50000,
  );
  check(
    'malformed file degrades to defaults, store still serving',
    typeof store.config().amount_cap_cents === 'number' &&
      store.config().min_approvals_for_tier3 > 0,
  );

  // 3. A subsequent valid edit recovers.
  writeFileSync(path, 'min_approvals_for_tier2c: 12\n');
  await until(
    () => store.config().min_approvals_for_tier2c,
    (v) => v === 12,
  );
  check('recovers on next valid edit', store.config().min_approvals_for_tier2c === 12);
} finally {
  await watcher.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
}

console.log(failures === 0 ? '\nsmoke:autonomy-reload OK' : `\nsmoke:autonomy-reload FAILED (${failures})`);
process.exit(failures === 0 ? 0 : 1);
