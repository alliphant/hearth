/**
 * Proof for the bun:sqlite bind guard installed at the open_db chokepoint
 * (src/memory/stores/structured.ts). It makes two SILENT footguns THROW:
 *
 *   1. Bare-key named bind — `{ id: 'x' }` against `@id` SQL → bun binds NULL
 *      silently (the `NOT NULL constraint failed: audit_log.ts` mystery).
 *   2. Mixed named + positional — `run({ '@x': 1 }, 'pos')` → bun no-ops
 *      silently, zero rows affected (the proposals.ts supersession no-op).
 *
 * And asserts the legitimate forms still pass untouched: all three sigils
 * (@ / $ / :), pure-positional binds, and no-arg calls.
 *
 * Run: bun run scripts/test-bind-guard.ts
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { open_db } from '../src/memory/stores/structured';

let failures = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) console.log('  ✓', name);
  else {
    failures++;
    console.log('  ✗', name, detail ? `— ${detail}` : '');
  }
}
function throws(name: string, fn: () => unknown, must_include = ''): void {
  try {
    fn();
    check(name, false, 'did not throw');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    check(name, msg.includes(must_include), `threw "${msg}"`);
  }
}
function ok(name: string, fn: () => unknown): void {
  try {
    fn();
    check(name, true);
  } catch (err) {
    check(name, false, `threw "${err instanceof Error ? err.message : err}"`);
  }
}

const dir = mkdtempSync(join(tmpdir(), 'hearth-bind-guard-'));
const db = open_db(join(dir, 'guard.db'));
db.exec('CREATE TABLE t (id TEXT NOT NULL, v TEXT)');

console.log('Footgun 1 — bare-key named binds THROW (was: silent NULL):');
throws(
  'prepare().run({ id }) bare key',
  () => db.prepare('INSERT INTO t (id, v) VALUES (@id, @v)').run({ id: 'x', v: 'y' } as never),
  'missing its sigil',
);
throws(
  'one bad key among good ones is caught',
  () => db.prepare('INSERT INTO t (id, v) VALUES (@id, @v)').run({ '@id': 'x', v: 'y' } as never),
  '"v"',
);
throws(
  'query().get({ bare }) bare key',
  () => db.query('SELECT * FROM t WHERE id = @id').get({ id: 'x' } as never),
  'missing its sigil',
);
throws(
  'query().all({ bare }) bare key',
  () => db.query('SELECT * FROM t WHERE id = @id').all({ id: 'x' } as never),
  'missing its sigil',
);

console.log('\nFootgun 2 — mixed named + positional THROW (was: silent no-op):');
throws(
  'run(namedObj, positional) is rejected',
  () => db.prepare('UPDATE t SET v = @v WHERE id = @id').run({ '@v': '2' } as never, 'a' as never),
  'no-ops',
);
throws(
  'get(namedObj, positional) is rejected',
  () => db.query('SELECT * FROM t WHERE id = @id').get({ '@id': 'a' } as never, 'b' as never),
  'no-ops',
);

console.log('\nLegitimate forms still PASS untouched:');
ok('@-sigil named bind', () =>
  db.prepare('INSERT INTO t (id, v) VALUES (@id, @v)').run({ '@id': 'a', '@v': '1' }),
);
ok('$-sigil named bind', () =>
  db.prepare('INSERT INTO t (id, v) VALUES ($id, $v)').run({ '$id': 'b', '$v': '2' }),
);
ok(':-sigil named bind', () =>
  db.prepare('INSERT INTO t (id, v) VALUES (:id, :v)').run({ ':id': 'c', ':v': '3' }),
);
ok('pure-positional (? + spread)', () =>
  db.prepare('INSERT INTO t (id, v) VALUES (?, ?)').run('d', '4'),
);
ok('no-arg query', () => db.prepare('SELECT COUNT(*) AS n FROM t').get());
ok('empty bind object', () => db.prepare('SELECT 1 AS one').get({}));

// And the writes that passed actually landed (the guard didn't corrupt them).
const rows = db.prepare('SELECT id, v FROM t ORDER BY id').all() as Array<{
  id: string;
  v: string;
}>;
check(
  'four good rows landed with non-null ids/values',
  rows.length === 4 && rows.every((r) => r.id && r.v),
  JSON.stringify(rows),
);

console.log(failures === 0 ? '\nPASS' : `\nFAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
