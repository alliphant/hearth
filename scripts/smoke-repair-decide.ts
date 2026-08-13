/**
 * smoke-repair-decide.ts — self-contained proof of
 * scripts/repair-decide-resolver-backfill.ts (the one-time repair for the
 * a0c5249 decide-route hole's historical damage).
 *
 * Temp db + temp vault + temp "repo root" (fixture
 * config/specialists/kristi.yaml); the repair script runs as a SUBPROCESS
 * with cwd pointed at the temp root — exactly the on-box invocation shape
 * (the resolver resolves specialist YAML from process.cwd()). Asserts:
 *
 *   - dry-run writes NOTHING (YAML, denials file, queue note, rows all
 *     byte-identical)
 *   - --apply: an acknowledged 'add' row patches the YAML tier +
 *     auto-subscribes (suggested_cadence) + flips to 'executed' with the
 *     repair tag; an already-present domain still records execution
 *     without duplicating the YAML entry; an already-'executed' row is
 *     never touched; a decided book row patches its awaiting_decision
 *     queue note (decided_at = the row's ts_decided); denied rows land in
 *     trusted_source_denials.md in the resolver's parseable format
 *     (in-run duplicate collapsed, pre-existing line deduped)
 *   - a second --apply is a full no-op (no duplicate YAML entries, no
 *     duplicate denial lines, one header)
 *   - --skip-sources leaves class A untouched
 *
 * No orchestrator, no LLM, no network.
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { open_db } from '@memory/stores/structured';

// The one-shot lives under scripts/archive/ (an applied migration, moved there
// in the 2026-07-06 P0 pass); this smoke still exercises it against a temp db
// to guard the LIVE decide-resolver code path it drives.
const SCRIPT = resolve(import.meta.dir, 'archive', 'repair-decide-resolver-backfill.ts');

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean): void {
  if (cond) {
    passed++;
    console.log(`  ok  ${name}`);
  } else {
    failed++;
    console.error(`  FAIL ${name}`);
  }
}

// ── fixtures ──────────────────────────────────────────────────────────
const root = mkdtempSync(join(tmpdir(), 'repair-decide-'));
const vault = join(root, 'vault');
const repo = join(root, 'repo');
mkdirSync(join(vault, 'Knowledge/Cordelia/queue'), { recursive: true });
mkdirSync(join(repo, 'config/specialists'), { recursive: true });

const KRISTI_YAML = join(repo, 'config/specialists/kristi.yaml');
writeFileSync(
  KRISTI_YAML,
  `id: kristi
name: Kristi
# comment that must survive the Document-API round-trip
trusted_sources:
  tier_1:
    - existing.com
  tier_2: []
`,
  'utf-8',
);

const QUEUE_NOTE = 'Knowledge/Cordelia/queue/2026-06-11-book-cover.md';
writeFileSync(
  join(vault, QUEUE_NOTE),
  `---
type: clipping
status: awaiting_decision
---
book cover capture
`,
  'utf-8',
);
const QUEUE_NOTE_OK = 'Knowledge/Cordelia/queue/already-decided.md';
writeFileSync(
  join(vault, QUEUE_NOTE_OK),
  `---
type: clipping
status: queued
---
already handled
`,
  'utf-8',
);

const db_path = join(root, 'hearth.db');
const db = open_db(db_path);
const insert = db.prepare(
  `INSERT INTO proposals
     (id, ts_created, ts_decided, specialist_id, kind, execution_kind,
      payload_json, rationale_md, status, action_taken, execution_result_json)
   VALUES (@id, @tc, @td, @sp, @kind, @ek, @pl, 'smoke', @st, @at, @res)`,
);
const row = (
  id: string,
  kind: string,
  status: string,
  action: string | null,
  payload: Record<string, unknown>,
  opts: { ts_decided?: string; result?: string } = {},
): void => {
  insert.run({
    '@id': id,
    '@tc': '2026-06-10T15:00:00.000Z',
    '@td': opts.ts_decided ?? '2026-06-10T16:00:00.000Z',
    '@sp': 'cordelia',
    '@kind': kind,
    '@ek': 'manual',
    '@pl': JSON.stringify(payload),
    '@st': status,
    '@at': action,
    '@res': opts.result ?? null,
  });
};

// A: acknowledged 'add' with cadence → full repair (YAML + subscription).
row('pa_new', 'trusted_source_addition', 'acknowledged', 'add', {
  domain: 'newsrc.com',
  target_specialist_id: 'kristi',
  tier: 2,
  suggested_cadence: 'weekly',
  candidate_url: 'https://newsrc.com/feed',
});
// A: acknowledged 'add' whose domain is ALREADY in the YAML.
row('pa_present', 'trusted_source_addition', 'acknowledged', 'add', {
  domain: 'existing.com',
  target_specialist_id: 'kristi',
  tier: 1,
});
// A: already executed (post-fix decide) — must never match.
row(
  'pa_done',
  'trusted_source_addition',
  'executed',
  'add',
  { domain: 'done.com', target_specialist_id: 'kristi', tier: 2 },
  { result: '{"ok":true}' },
);
// B: decided 'skip', note still awaiting_decision.
row(
  'pb_skip',
  'book_candidate',
  'acknowledged',
  'skip',
  { queue_note_path: QUEUE_NOTE, title_candidate: 'A Book' },
  { ts_decided: '2026-06-12T03:00:00.000Z' },
);
// B: decided 'acquire' but the note already moved on — untouched.
row('pb_ok', 'book_candidate', 'acknowledged', 'acquire', {
  queue_note_path: QUEUE_NOTE_OK,
});
// C: two denials + an in-run duplicate of the first.
row('pc_1', 'trusted_source_addition', 'denied', 'reject', {
  domain: 'spam.example',
  target_specialist_id: 'kristi',
  tier: 2,
});
row('pc_1dup', 'trusted_source_addition', 'denied', 'reject', {
  domain: 'spam.example',
  target_specialist_id: 'kristi',
  tier: 2,
});
row('pc_2', 'trusted_source_addition', 'denied', 'reject', {
  domain: 'junk.example',
  target_specialist_id: 'vivian',
  tier: 1,
});
db.close();

// ── run helper ────────────────────────────────────────────────────────
function run(...args: string[]): { code: number; out: string } {
  const res = spawnSync('bun', ['run', SCRIPT, ...args], {
    cwd: repo,
    env: {
      ...process.env,
      HEARTH_DB_PATH: db_path,
      HEARTH_VAULT_ROOT: vault,
      HEARTH_TEST_MODE: '1',
    },
    encoding: 'utf-8',
  });
  const out = `${res.stdout ?? ''}${res.stderr ?? ''}`;
  if (res.status !== 0) console.error(out);
  return { code: res.status ?? -1, out };
}

const read = (p: string): string => readFileSync(p, 'utf-8');
const DENIALS_ABS = join(vault, 'Knowledge/Cordelia/trusted_source_denials.md');
const exists = (p: string): boolean => {
  try {
    readFileSync(p);
    return true;
  } catch {
    return false;
  }
};
const row_state = (id: string): { status: string; res: string | null } => {
  const d = open_db(db_path);
  const r = d
    .prepare('SELECT status, execution_result_json AS res FROM proposals WHERE id = @id')
    .get({ '@id': id }) as { status: string; res: string | null };
  d.close();
  return r;
};

// ── 1. dry run writes nothing ─────────────────────────────────────────
console.log('\n— dry run —');
const yaml_before = read(KRISTI_YAML);
const note_before = read(join(vault, QUEUE_NOTE));
const dry = run();
check('dry-run exits 0', dry.code === 0);
check('dry-run reports the two class-A rows', /would re-run resolver/.test(dry.out));
check('dry-run reports the book patch', /would patch/.test(dry.out));
check('dry-run reports the denial backfill', /would backfill/.test(dry.out));
check('dry-run: YAML untouched', read(KRISTI_YAML) === yaml_before);
check('dry-run: queue note untouched', read(join(vault, QUEUE_NOTE)) === note_before);
check('dry-run: denials file not created', !exists(DENIALS_ABS));
check('dry-run: row still acknowledged', row_state('pa_new').status === 'acknowledged');

// ── 2. --skip-sources leaves class A alone ────────────────────────────
console.log('\n— apply --skip-sources —');
const skip = run('--apply', '--skip-sources');
check('skip-sources exits 0', skip.code === 0);
check('skip-sources: YAML untouched', read(KRISTI_YAML) === yaml_before);
check('skip-sources: A rows untouched', row_state('pa_new').status === 'acknowledged');
check(
  'skip-sources: book note patched',
  /status: skipped/.test(read(join(vault, QUEUE_NOTE))),
);
check('skip-sources: denials file written', exists(DENIALS_ABS));

// ── 3. full apply ─────────────────────────────────────────────────────
console.log('\n— full apply —');
const apply = run('--apply');
check('apply exits 0', apply.code === 0);
const yaml_after = read(KRISTI_YAML);
const tiers_after = (
  (await import('yaml')).parse(yaml_after) as {
    trusted_sources: { tier_1: string[]; tier_2: string[] };
  }
).trusted_sources;
check('YAML gains newsrc.com in tier_2', tiers_after.tier_2.includes('newsrc.com'));
check('YAML keeps existing.com once', yaml_after.split('existing.com').length === 2);
check('YAML comment survived the round-trip', yaml_after.includes('# comment that must'));
const pa_new = row_state('pa_new');
check('pa_new flipped to executed', pa_new.status === 'executed');
check(
  'pa_new execution_result carries the repair tag',
  (pa_new.res ?? '').includes('repair-decide-resolver-backfill'),
);
check(
  'pa_new auto-subscribed (sources.md)',
  /newsrc\.com/.test(read(join(vault, 'Knowledge/Cordelia/sources.md'))),
);
check('pa_present flipped to executed (already_present)', row_state('pa_present').status === 'executed');
check('pa_done untouched', row_state('pa_done').res === '{"ok":true}');
const note_after = read(join(vault, QUEUE_NOTE));
check('book note: status skipped', /status: skipped/.test(note_after));
check('book note: decided_at = row ts_decided', note_after.includes('2026-06-12T03:00:00'));
check('book note: decided_action recorded', /decided_action: skip/.test(note_after));
check(
  'already-decided note untouched',
  /status: queued/.test(read(join(vault, QUEUE_NOTE_OK))),
);
const denials = read(DENIALS_ABS);
check(
  'denial line in resolver format (kristi)',
  /- \*\*2026-06-10T16:00:00\.000Z\*\* — `spam\.example` proposed for kristi Tier 2, denied\./.test(
    denials,
  ),
);
check('denial line for vivian target', /`junk\.example` proposed for vivian Tier 1/.test(denials));
check('in-run duplicate collapsed to one line', denials.split('spam.example').length === 2);
check('denials header written once', denials.split('remove a line to lift a denial').length === 2);

// ── 4. second apply is a no-op ────────────────────────────────────────
console.log('\n— re-apply (idempotency) —');
const yaml_snap = read(KRISTI_YAML);
const denials_snap = read(DENIALS_ABS);
const note_snap = read(join(vault, QUEUE_NOTE));
const again = run('--apply');
check('re-apply exits 0', again.code === 0);
check('re-apply: zero repairs', /A sources=0 B book-notes=0 C denials=0/.test(again.out));
check('re-apply: YAML unchanged', read(KRISTI_YAML) === yaml_snap);
check('re-apply: denials unchanged', read(DENIALS_ABS) === denials_snap);
check('re-apply: note unchanged', read(join(vault, QUEUE_NOTE)) === note_snap);

// ── summary ───────────────────────────────────────────────────────────
rmSync(root, { recursive: true, force: true });
console.log(`\nsmoke-repair-decide: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
