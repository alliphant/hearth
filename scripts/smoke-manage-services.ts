/**
 * smoke:manage-services — the told-first Services & Bills write tool
 * (manage_household_services, 2026-07-05 — built the day Kate collected the
 * owner's ledger corrections in chat and had no way to land them).
 *
 * Self-contained (temp vault + db, real MemoryClient, the real ingestor
 * projector standing in for the chokidar watcher, no LLM):
 *   - add → note at service_note_path, cordon 'household', source 'manual',
 *     confidence 1.0, dollars→cents
 *   - add on an existing vendor = create-or-update (same note path)
 *   - partial-name resolution ("CityFiber" → "Pleasantville CityFiber")
 *   - deactivate → status lapsed; remove → note + row gone
 *   - unknown/ambiguous vendor → error + the roster as candidates
 *   - bad next_due shape → typed recovery error (checked in execute, no
 *     schema regex — the GBNF rule)
 *   - list reads the projected ledger back
 */
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { open_db } from '@memory/stores/structured';
import { MemoryClient } from '@memory/client';
import { VaultIndex } from '@ingestor/vault_index';
import { project_note } from '@ingestor/project';
import { service_note_path } from '@core/household_services';
import { make_manage_household_services } from '../src/specialists/kate/tools/manage_household_services';
import type { ToolContext } from '@core/tool';

let failures = 0;
function assert(cond: unknown, msg: string): void {
  if (cond) console.log(`  ✓ ${msg}`);
  else {
    console.error(`  ✗ ${msg}`);
    failures++;
  }
}

const tmp = mkdtempSync(join(tmpdir(), 'smoke-manage-services-'));
const vault = join(tmp, 'vault');
const db = open_db(join(tmp, 'test.db'));
const memory = new MemoryClient({ vault_root: vault, db });
const index = new VaultIndex();
const pctx = { vault_root: vault, db, memory, index };

const tool = make_manage_household_services({ db, memory });
const ctx = {
  memory,
  llm: null,
  now: new Date('2026-07-05T17:00:00Z'),
  intent_id: 'i1',
  specialist_id: 'kate',
  user: { id: 'jasper', tier: 'owner', timezone: 'America/Denver' },
} as unknown as ToolContext;

/** Stand in for the chokidar ingestor: project one service note. */
function project(anchor: string): void {
  project_note(resolve(vault, service_note_path(anchor)), pctx);
}

const run = (input: Record<string, unknown>) =>
  tool.execute(tool.input_schema.parse(input), ctx);

async function main() {
  // add — dollars→cents, manual source, household cordon.
  const add = await run({
    action: 'add',
    vendor: 'Pleasantville CityFiber',
    category: 'internet',
    cadence: 'monthly',
    amount: 100,
  });
  assert(add.ok === true && add.action === 'add', 'add succeeds');
  const note_path = add.note_path!;
  assert(existsSync(resolve(vault, note_path)), 'note written to the vault');
  project('fort-collins-cityfiber');
  const row1 = db
    .prepare(`SELECT * FROM household_services WHERE vendor_anchor='fort-collins-cityfiber'`)
    .get() as Record<string, unknown> | null;
  assert(row1 != null, 'ingestor projects the note into the ledger table');
  assert(row1!.typical_amount_cents === 10000, 'amount stored as cents (100 → 10000)');
  assert(row1!.source === 'manual', 'told-first entry carries source=manual');
  assert(row1!.private_to === 'household', 'cordon stamped household (shared entity)');
  const fm1 = JSON.parse(String(row1!.frontmatter_json)) as Record<string, unknown>;
  assert(fm1.confidence === 1, 'told fact carries confidence 1.0');

  // second vendor for resolution/ambiguity cases.
  await run({ action: 'add', vendor: 'T-Mobile', category: 'cellular', cadence: 'monthly', amount: 72.96 });
  project('t-mobile');

  // add on an EXISTING vendor = create-or-update, same note path.
  const readd = await run({ action: 'add', vendor: 'Pleasantville CityFiber', amount: 105 });
  assert(readd.ok === true && readd.note_path === note_path, 'repeat add updates in place');
  project('fort-collins-cityfiber');

  // partial-name update resolves uniquely.
  const upd = await run({ action: 'update', vendor: 'CityFiber', autopay: true });
  assert(upd.ok === true && upd.vendor === 'Pleasantville CityFiber', 'partial name resolves to the full vendor');
  project('fort-collins-cityfiber');
  const row2 = db
    .prepare(`SELECT autopay, typical_amount_cents FROM household_services WHERE vendor_anchor='fort-collins-cityfiber'`)
    .get() as { autopay: number; typical_amount_cents: number };
  assert(row2.autopay === 1 && row2.typical_amount_cents === 10500, 'update merges (autopay + the re-add amount held)');

  // deactivate → lapsed.
  const off = await run({ action: 'deactivate', vendor: 'T-Mobile' });
  assert(off.ok === true, 'deactivate succeeds');
  project('t-mobile');
  const row3 = db
    .prepare(`SELECT status FROM household_services WHERE vendor_anchor='t-mobile'`)
    .get() as { status: string };
  assert(row3.status === 'lapsed', 'deactivate lands status=lapsed');

  // unknown vendor → candidates recovery.
  const missing = await run({ action: 'update', vendor: 'Comcast', amount: 50 });
  assert(
    missing.ok === false && (missing.candidates ?? []).includes('Pleasantville CityFiber'),
    'unknown vendor returns the roster as candidates',
  );

  // ambiguous match → candidates recovery.
  await run({ action: 'add', vendor: 'Apple', category: 'subscription' });
  await run({ action: 'add', vendor: 'Apple Card', category: 'credit' });
  project('apple');
  project('apple-card');
  const ambiguous = await run({ action: 'deactivate', vendor: 'Appl' });
  assert(
    ambiguous.ok === false && (ambiguous.candidates ?? []).length >= 2,
    'ambiguous match refuses with candidates',
  );

  // bad next_due shape → typed recovery, not a schema regex.
  const bad_due = await run({ action: 'update', vendor: 'CityFiber', next_due: 'next month' });
  assert(
    bad_due.ok === false && String(bad_due.error).includes('YYYY-MM-DD'),
    'bad next_due gets a typed recovery message',
  );

  // list reads the ledger back.
  const list = await run({ action: 'list' });
  assert(
    list.ok === true && (list.services ?? []).some((s) => s.vendor === 'Pleasantville CityFiber' && s.amount === '$105.00'),
    'list renders the projected ledger',
  );

  // remove → note + row gone.
  const rm = await run({ action: 'remove', vendor: 'Apple Card' });
  assert(rm.ok === true, 'remove succeeds');
  assert(!existsSync(resolve(vault, service_note_path('apple-card'))), 'removed note is gone from the vault');
  const gone = db
    .prepare(`SELECT COUNT(*) AS n FROM household_services WHERE vendor_anchor='apple-card'`)
    .get() as { n: number };
  assert(gone.n === 0, 'removed row is gone from the table');

  rmSync(tmp, { recursive: true, force: true });
  if (failures > 0) {
    console.error(`\nsmoke:manage-services FAILED — ${failures} assertion(s)`);
    process.exit(1);
  }
  console.log('\nsmoke:manage-services PASSED');
}

main().catch((err) => {
  console.error('smoke crashed:', err);
  process.exit(1);
});
