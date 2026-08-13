/**
 * smoke:code-edit — the search/replace authoring primitive (propose_code_edit's
 * core). Asserts the pure applier's exact-match semantics + the edits→worktree
 * synth wiring in open_change_pr (TEST_MODE), without touching the live tree.
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// REPO_ROOT is captured at module-load, so point it at a throwaway tree BEFORE
// importing change_pipeline (TEST_MODE resolves edits against REPO_ROOT).
const tmproot = mkdtempSync(join(tmpdir(), 'codeedit-'));
mkdirSync(join(tmproot, 'scripts'), { recursive: true });
writeFileSync(
  join(tmproot, 'scripts/sample.ts'),
  'export const VALUE = 1; // original\nexport const NAME = "a";\n',
  'utf8',
);
process.env.HEARTH_TEST_MODE = '1';
process.env.HEARTH_REPO_ROOT = tmproot;

const { apply_edits_to_content, open_change_pr } = await import(
  '../src/specialists/trainer/change_pipeline'
);

let fails = 0;
function check(label: string, ok: boolean): void {
  console.log(`${ok ? '✓' : '✗'} ${label}`);
  if (!ok) fails++;
}
function rejects(label: string, fn: () => unknown): void {
  let threw = false;
  try {
    fn();
  } catch {
    threw = true;
  }
  check(label, threw);
}
async function rejectsAsync(label: string, fn: () => Promise<unknown>): Promise<void> {
  let threw = false;
  try {
    await fn();
  } catch {
    threw = true;
  }
  check(label, threw);
}

// ── pure applier ──────────────────────────────────────────────────────────
check(
  'single unique replace',
  apply_edits_to_content('a foo b', [{ old_string: 'foo', new_string: 'BAR' }]) === 'a BAR b',
);
check(
  'empty new_string deletes',
  apply_edits_to_content('a foo b', [{ old_string: ' foo', new_string: '' }]) === 'a b',
);
check(
  'sequential edits each see the prior result',
  apply_edits_to_content('1 2 3', [
    { old_string: '1', new_string: 'one' },
    { old_string: '3', new_string: 'three' },
  ]) === 'one 2 three',
);
check(
  'replace_all hits every occurrence',
  apply_edits_to_content('x x x', [{ old_string: 'x', new_string: 'y', replace_all: true }]) === 'y y y',
);
check(
  'exact whitespace + newlines preserved',
  apply_edits_to_content('a\n  indented\nz\n', [{ old_string: '  indented', new_string: '  fixed' }]) ===
    'a\n  fixed\nz\n',
);
rejects('not-found is rejected', () => apply_edits_to_content('abc', [{ old_string: 'zzz', new_string: 'q' }]));
rejects('ambiguous (>1 match) is rejected', () =>
  apply_edits_to_content('x x', [{ old_string: 'x', new_string: 'y' }]),
);
rejects('identical old==new is rejected', () =>
  apply_edits_to_content('abc', [{ old_string: 'a', new_string: 'a' }]),
);

// ── edits → open_change_pr (TEST_MODE synth) ────────────────────────────────
{
  const r = await open_change_pr({
    branch_name: 'beatrice/smoke-edit',
    pr_title: 'smoke: edit existing file',
    pr_body: 'exercises the surgical-edit authoring path end to end',
    edits: [
      { path: 'scripts/sample.ts', old_string: 'VALUE = 1', new_string: 'VALUE = 2' },
      { path: 'scripts/sample.ts', old_string: 'NAME = "a"', new_string: 'NAME = "b"' },
    ],
  });
  check('edit synth: files_changed lists the edited path', r.files_changed.includes('scripts/sample.ts'));
  check('edit synth: both edits applied (VALUE = 2)', r.diff_summary.includes('VALUE = 2'));
  check('edit synth: both edits applied (NAME = "b")', r.diff_summary.includes('NAME = "b"'));
  check('edit synth: pr synthesized', r.pr_number === 0 && r.branch === 'beatrice/smoke-edit');
}
await rejectsAsync('editing a non-existent file is rejected', () =>
  open_change_pr({
    branch_name: 'beatrice/smoke-missing',
    pr_title: 'smoke: missing target',
    pr_body: 'should reject — file does not exist on base',
    edits: [{ path: 'src/does/not/exist.ts', old_string: 'x', new_string: 'y' }],
  }),
);

rmSync(tmproot, { recursive: true, force: true });
console.log(fails === 0 ? '\nsmoke:code-edit — all passed' : `\nsmoke:code-edit — ${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
