/**
 * smoke:boot-check — would the current config + schema boot the orchestrator?
 *
 * Runs the boot-only crash class against a :memory: DB + the cwd's config tree:
 * SQLite migrations (CREATE-INDEX-before-ALTER), capabilities.yaml (dup-builtin
 * / malformed token), the specialist registry (dup id, multi default_landing,
 * undefined capability grant), and llm-roles.yaml shape. tsc and the offline
 * smokes can't see these (bun strips types; the crash is at runtime boot).
 *
 * Run by hand / in CI / pre-deploy from the repo root, AND spawned by Beatrice's
 * `run_checks` inside a worktree so a self-modification that would crash-loop the
 * orchestrator is caught BEFORE the PR opens. Exits non-zero on any failure.
 *
 * It also self-tests the detectors against throwaway fixtures (a dup-builtin
 * capability, a malformed roles file) so a regression in the check itself is
 * caught too — those run against temp paths, never the real config.
 */
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run_boot_check } from '../src/core/boot_check';
import { open_db } from '../src/memory/stores/structured';

let failures = 0;
function check(name: string, cond: boolean): void {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`);
  if (!cond) failures++;
}

// ── 1. The REAL config + live schema must boot ──────────────────────────────
const live = run_boot_check();
for (const c of live.checks) {
  check(`live: ${c.name}`, c.ok);
  if (!c.ok) console.log(`        ↳ ${c.error}`);
}
check('live config would boot the orchestrator', live.ok);

// ── 2. Detector self-tests against throwaway fixtures ───────────────────────
const dir = mkdtempSync(join(tmpdir(), 'hearth-bootcheck-'));
try {
  // 2a. A capabilities.yaml token colliding with a built-in must FAIL.
  const cap_bad = join(dir, 'caps-dup.yaml');
  writeFileSync(cap_bad, 'read_vault: this duplicates a built-in token\n');
  const r_dup = run_boot_check({ capabilities_path: cap_bad });
  const capCheck = r_dup.checks.find((c) => c.name.startsWith('capabilities'));
  check('detects a dup-with-builtin capability token', !r_dup.ok && capCheck?.ok === false);
  check('and the message names the collision', /already a built-in/.test(capCheck?.error ?? ''));

  // 2b. A malformed token must FAIL.
  const cap_malformed = join(dir, 'caps-malformed.yaml');
  writeFileSync(cap_malformed, 'BadToken-1: not snake_case\n');
  const r_mal = run_boot_check({ capabilities_path: cap_malformed });
  check('detects a malformed capability token', !r_mal.ok);

  // 2c. A malformed llm-roles.yaml (a list, not a map) must FAIL.
  const roles_bad = join(dir, 'roles-bad.yaml');
  writeFileSync(roles_bad, '- not\n- a\n- map\n');
  const r_roles = run_boot_check({ roles_path: roles_bad });
  const rolesCheck = r_roles.checks.find((c) => c.name.startsWith('llm-roles'));
  check('detects a malformed llm-roles file', !r_roles.ok && rolesCheck?.ok === false);

  // 2d. A specialist dir with a duplicate default_landing must FAIL.
  const spec_dir = join(dir, 'specialists');
  mkdirSync(spec_dir, { recursive: true });
  const yaml = (id: string, dl: boolean): string =>
    `id: ${id}\nname: ${id}\nrole: tester\nvoice: warm\npersona: |\n  Fixture persona long enough to satisfy the schema.\nproactive:\n  mode: reactive\ndefault_landing: ${dl}\n`;
  writeFileSync(join(spec_dir, 'a.yaml'), yaml('a', true));
  writeFileSync(join(spec_dir, 'b.yaml'), yaml('b', true));
  // Point caps at an empty (valid) file so check 2 passes and check 3 runs.
  const cap_empty = join(dir, 'caps-empty.yaml');
  writeFileSync(cap_empty, '# none\n');
  const r_dl = run_boot_check({ specialists_dir: spec_dir, capabilities_path: cap_empty });
  const regCheck = r_dl.checks.find((c) => c.name.startsWith('specialist registry'));
  check('detects two default_landing specialists', !r_dl.ok && regCheck?.ok === false);
} finally {
  rmSync(dir, { recursive: true, force: true });
}

// ── 3. Migrations must be IDEMPOTENT against a re-opened FILE DB ────────────
// The boot-only class this file exists to catch has a second member that a
// `:memory:` check structurally CANNOT see: a one-time backfill that was never
// gated on the ALTER actually happening. On a fresh in-memory DB there are no
// pre-existing rows, so a stray `UPDATE ... WHERE col IS NULL` is always a
// no-op and always passes. Against the LIVE file DB it re-fires on every boot
// of every process (orchestrator + ingestor) and overwrites NULLs that later
// rows legitimately mean.
//
// That is not hypothetical: the ungated `proposals.user_id` backfill silently
// disabled the Proposal Court's rollup rung for its entire lifetime (NULL =
// owner-global is exactly what `rollup_eligible` keys on), so 41 rollup-shaped
// cards piled into the owner's queue and `proposal_court_rollup` fired zero
// times across 49 convenings. Fixed 2026-07-18 by gating every backfill on
// `add_column_if_missing`'s return value.
//
// The check below is deliberately GENERIC — it asserts the invariant "a NULL in
// a cordon column survives a reopen" for every such column, so a future ungated
// backfill on any of them fails here instead of in production six weeks later.
const db_dir = mkdtempSync(join(tmpdir(), 'hearth-migrate-'));
try {
  const db_path = join(db_dir, 'idempotency.db');
  // `proposals.user_id` is the load-bearing cordon column and the regression
  // that motivated this check: NULL means "owner-global", which is what the
  // Court's `rollup_eligible` keys on.
  const first = open_db(db_path);
  first.exec(
    `INSERT INTO proposals (id, ts_created, specialist_id, kind, execution_kind,` +
      ` payload_json, rationale_md, status, user_id)` +
      ` VALUES ('smoke_p1', '2026-01-01T00:00:00Z', 'kate', 'action_proposal', 'none',` +
      ` '{}', 'smoke fixture', 'pending', NULL)`,
  );
  const before = first
    .prepare(`SELECT user_id FROM proposals WHERE id = 'smoke_p1'`)
    .get() as { user_id: string | null } | undefined;
  first.close();
  check('migration fixture: a NULL user_id is written as NULL', before?.user_id === null);

  // The second open replays every migration — exactly what a restart does.
  const second = open_db(db_path);
  const after = second
    .prepare(`SELECT user_id FROM proposals WHERE id = 'smoke_p1'`)
    .get() as { user_id: string | null } | undefined;
  second.close();
  check(
    'reopening the DB does NOT clobber an owner-global NULL user_id ' +
      '(one-time backfills stay gated on the ALTER)',
    after?.user_id === null,
  );
  if (after?.user_id !== null) {
    console.log(
      `        ↳ user_id became ${JSON.stringify(after?.user_id)} on reopen — an ` +
        `open_db backfill is re-firing on every boot; gate it on ` +
        `add_column_if_missing()'s return value.`,
    );
  }
} finally {
  rmSync(db_dir, { recursive: true, force: true });
}

console.log(failures === 0 ? '\nsmoke:boot-check OK' : `\nsmoke:boot-check FAILED (${failures})`);
process.exit(failures === 0 ? 0 : 1);
