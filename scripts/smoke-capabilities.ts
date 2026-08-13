/**
 * smoke:capabilities — self-contained test of config-extended capabilities.
 *
 * Proves a capability token that lives only in config/capabilities.yaml
 * (not the built-in enum) is accepted everywhere a built-in is — by
 * is_capability, granted_set, and a specialist config — and that the
 * file hot-reloads. No orchestrator, no vault.
 *
 *   bun run smoke:capabilities
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FSWatcher } from 'chokidar';
import {
  all_capabilities,
  granted_set,
  is_capability,
  load_extra_capabilities,
  watch_extra_capabilities,
} from '@core/capabilities';
import { load_specialist_file } from '@core/specialist';

let failures = 0;
function check(label: string, ok: boolean): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) failures++;
}
function throws(fn: () => void): boolean {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
}
async function wait_for(
  label: string,
  cond: () => boolean,
  ms = 4000,
): Promise<void> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (cond()) {
      check(label, true);
      return;
    }
    await Bun.sleep(50);
  }
  check(`${label} (timed out)`, false);
}

function specialist_yaml(cap: string): string {
  return (
    [
      'id: smoke_cap_test',
      'name: Smoke Cap Test',
      'role: Test',
      'voice: warm',
      'persona: "A throwaway persona used only by the capabilities smoke test."',
      'capabilities:',
      `  ${cap}: true`,
      '  read_vault: true',
      'proactive:',
      '  mode: reactive',
    ].join('\n') + '\n'
  );
}

const dir = mkdtempSync(join(tmpdir(), 'hearth-caps-'));
const caps_path = join(dir, 'capabilities.yaml');
let watcher: FSWatcher | null = null;

try {
  // 1 — a config-only token becomes a valid capability.
  writeFileSync(caps_path, 'test_extra_cap: "smoke test capability"\n');
  load_extra_capabilities(caps_path);
  check('config-extended token is a capability', is_capability('test_extra_cap'));
  check('built-in token still a capability', is_capability('read_vault'));
  check('unknown token is rejected', !is_capability('bogus_xyz'));
  check(
    'all_capabilities() includes built-in and extended',
    all_capabilities().includes('test_extra_cap') &&
      all_capabilities().includes('read_vault'),
  );

  // 2 — granted_set accepts the extended token, rejects a bogus one.
  const granted = granted_set(['test_extra_cap', 'read_vault']);
  check(
    'granted_set accepts the extended token',
    granted.has('test_extra_cap') && granted.has('read_vault'),
  );
  check(
    'granted_set throws on a bogus token',
    throws(() => granted_set(['bogus_xyz'])),
  );

  // 3 — a specialist YAML granting the extended token loads cleanly.
  const ok_path = join(dir, 'ok.yaml');
  writeFileSync(ok_path, specialist_yaml('test_extra_cap'));
  let loaded = false;
  try {
    loaded = load_specialist_file(ok_path).granted.has('test_extra_cap');
  } catch {
    loaded = false;
  }
  check('specialist granting an extended capability loads', loaded);

  // 4 — a specialist YAML granting an unknown token is still rejected.
  const bad_path = join(dir, 'bad.yaml');
  writeFileSync(bad_path, specialist_yaml('bogus_xyz'));
  check(
    'specialist granting an unknown capability is rejected',
    throws(() => load_specialist_file(bad_path)),
  );

  // 5 — editing capabilities.yaml hot-reloads the valid set.
  watcher = watch_extra_capabilities(caps_path, () => {
    /* is_capability reads the reloaded set directly */
  });
  await Bun.sleep(300); // let chokidar settle before the edit
  writeFileSync(caps_path, 'test_extra_cap: "x"\nanother_cap: "added live"\n');
  await wait_for('capabilities.yaml change hot-reloads a new token', () =>
    is_capability('another_cap'),
  );
} finally {
  if (watcher) await watcher.close();
  rmSync(dir, { recursive: true, force: true });
}

console.log(
  failures === 0
    ? '\nsmoke:capabilities OK'
    : `\nsmoke:capabilities FAILED (${failures} check(s))`,
);
process.exit(failures === 0 ? 0 : 1);
