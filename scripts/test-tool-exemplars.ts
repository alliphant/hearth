/**
 * smoke:tool-exemplars — worked-example mining + the privacy sanitizer.
 *
 * The sanitizer is the load-bearing part: exemplars ride tool
 * descriptions into EVERY prompt, so free-text values (queries, note
 * bodies) must never survive — only shape (keys, ids, enums, numbers).
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ulid } from 'ulid';
import { open_db } from '../src/memory/stores/structured';
import {
  _test_reset_exemplars,
  exemplar_for,
  exemplars_enabled,
  sanitize_args,
} from '../src/core/tool_exemplars';

let checks = 0;
function check(name: string, ok: boolean): void {
  checks++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) process.exitCode = 1;
}

function insert_audit(
  db: ReturnType<typeof open_db>,
  tool_name: string,
  tool_input: unknown,
  error: string | null,
  ts: string,
): void {
  db.prepare(
    `INSERT INTO audit_log (id, ts, intent_id, agent, tool_name, tool_input, error)
     VALUES (?, ?, ?, 'smoke', ?, ?, ?)`,
  ).run(ulid(), ts, ulid(), tool_name, JSON.stringify(tool_input), error);
}

function main(): void {
  // ── sanitizer ────────────────────────────────────────────────────────
  const clean = sanitize_args({
    entity_id: 'sensor.ioniq5_ev_battery_level',
    query: 'where does Sam go to therapy on tuesdays',
    k: 5,
    flag: true,
    tags: ['private thoughts about work', 'second'],
    nested: { url: 'https://citygov.com/agenda', body: 'a long personal paragraph here' },
  }) as Record<string, unknown>;
  check('token-like strings survive (ids/urls)', clean.entity_id === 'sensor.ioniq5_ev_battery_level');
  check('free text is redacted to …', clean.query === '…');
  check('numbers and booleans survive', clean.k === 5 && clean.flag === true);
  check('arrays collapse to one sanitized element', Array.isArray(clean.tags) && clean.tags.length === 1 && clean.tags[0] === '…');
  const nested = clean.nested as Record<string, unknown>;
  check('nested urls survive, nested prose is redacted', nested.url === 'https://citygov.com/agenda' && nested.body === '…');

  // ── mining ───────────────────────────────────────────────────────────
  const root = mkdtempSync(join(tmpdir(), 'hearth-exemplars-'));
  const db = open_db(join(root, 'x.db'));
  insert_audit(db, 'lookup_thing', { id: 'older_call' }, null, '2026-06-01T00:00:00Z');
  insert_audit(db, 'lookup_thing', { id: 'failed_call' }, 'INPUT_VALIDATION_FAILED: nope', '2026-06-09T00:00:00Z');
  insert_audit(db, 'lookup_thing', { id: 'newest_ok', note: 'free text here' }, null, '2026-06-08T00:00:00Z');

  _test_reset_exemplars();
  const ex = exemplar_for(db, 'lookup_thing');
  check('mines the newest SUCCESSFUL call (errors skipped)', ex !== null && ex.includes('newest_ok'));
  check('mined exemplar is sanitized', ex !== null && !ex.includes('free text') && ex.includes('…'));
  check('unknown tool → null, no throw', exemplar_for(db, 'never_called') === null);

  // Cache: a later insert is invisible until TTL/reset (cheap per-turn).
  insert_audit(db, 'lookup_thing', { id: 'even_newer' }, null, '2026-06-10T00:00:00Z');
  check('cached between calls', exemplar_for(db, 'lookup_thing')!.includes('newest_ok'));
  _test_reset_exemplars();
  check('reset re-mines', exemplar_for(db, 'lookup_thing')!.includes('even_newer'));

  // ── kill switch ──────────────────────────────────────────────────────
  process.env.HEARTH_TOOL_EXEMPLARS = '0';
  check('kill switch disables', exemplars_enabled() === false);
  delete process.env.HEARTH_TOOL_EXEMPLARS;
  check('default is enabled', exemplars_enabled() === true);

  rmSync(root, { recursive: true, force: true });
  if (process.exitCode === 1) {
    console.log('\nsmoke:tool-exemplars FAILED');
    process.exit(1);
  }
  console.log(`\n✓ smoke:tool-exemplars — ${checks} checks passed`);
}

main();
