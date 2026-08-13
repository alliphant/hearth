/**
 * smoke:order-fanout — the order → household-good signal fan-out (Phase 1c).
 *
 * Self-contained: temp db + vault, real AppEventBus / SpecialistInbox /
 * MemoryClient, a stub UserRegistry, no mail server, no LLM. Exercises:
 *   - HouseholdGraphDriver.on_order: order → good node + typed edges
 *   - the per-specialist fan-out (Vivian always; Kate for durable goods — the
 *     home-inventory slice folded into Kate 2026-07-04, was Luna)
 *   - the cordon: a household order → 'household' good + shared FYI; a personal
 *     order → siloed good + a user-scoped FYI (owner has NO god-view)
 *   - the event-driven path + the HEARTH_HOUSEHOLD_GRAPH kill switch
 *
 *   bun run smoke:order-fanout
 */
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { open_db } from '@memory/stores/structured';
import { MemoryClient } from '@memory/client';
import { rebuild } from '@ingestor/rebuild';
import { AppEventBus } from '@app/events';
import { SpecialistInbox } from '@memory/stores/conversations';
import { MailOrders } from '@memory/stores/mail_orders';
import { HouseholdGraphDriver } from '@core/household_knowledge/driver';
import type { UserRegistry } from '@core/users';
import type { Caller } from '@memory/private_to';

let passed = 0;
function check(label: string, cond: unknown): void {
  if (!cond) throw new Error(`FAIL: ${label}`);
  passed++;
  console.log(`  ✓ ${label}`);
}
const flush = () => new Promise((r) => setTimeout(r, 15));

const OWNER: Caller = { user_id: 'jasper', tier: 'owner' };
const SAM: Caller = { user_id: 'sam', tier: 'household' };

// Minimal UserRegistry stub — the driver only reads display_name.
const users = {
  get: (id: string) => ({ display_name: id === 'sam' ? 'Sam' : 'Jasper' }),
} as unknown as UserRegistry;

async function main(): Promise<void> {
  const tmp = mkdtempSync(join(tmpdir(), 'hearth-fanout-'));
  const vault = join(tmp, 'vault');
  mkdirSync(vault, { recursive: true });
  const db = open_db(join(tmp, 'hearth.db'));
  const memory = new MemoryClient({ vault_root: vault, db });
  const events = new AppEventBus();
  const inbox = new SpecialistInbox(db);
  const orders = new MailOrders(db);

  const driver = new HouseholdGraphDriver({ events, memory, db, inbox, users });

  // ── 1. A household electronics order (durable) → direct on_order ─────────
  orders.upsert({
    user_id: 'jasper',
    private_to: 'household',
    order_key: 'sony:abc-1',
    merchant: 'Sony',
    order_number: 'abc-1',
    items: 'WH-1000XM5 headphones',
    order_total: '$348.00',
    order_date: '2026-06-18T00:00:00Z',
    status: 'ordered',
    fulfillment: 'durable_goods',
    source_message_id: 'm1',
  });
  await driver.on_order('jasper', 'sony:abc-1', true);
  await rebuild(vault, memory, db);

  const goods = memory.query_household_goods({ caller: OWNER });
  const sony = goods.find((g) => g.order_key === 'sony:abc-1');
  check('order → household_good node created', !!sony);
  check('good is household-cordoned', sony?.private_to === 'household');
  check('good carries cost', sony?.cost === 348);
  check('good carries warranty (durable)', !!sony?.warranty_until);

  // `fulfillment` must survive the store round-trip — it is what decides
  // whether the good gets return/warranty windows at all, so a dropped column
  // binding would silently un-return every durable good in the house.
  check(
    'fulfillment round-trips through the store',
    orders.get_by_key('jasper', 'sony:abc-1')?.fulfillment === 'durable_goods',
  );
  check('durable good therefore carries a return window', !!sony?.return_window_until);

  // Typed edges present + cordon-readable.
  check(
    'purchased-from edge written',
    memory.knowledge_edges.from(sony!.note_path, OWNER, 'purchased-from').some((e) => e.to_ref === 'Sony'),
  );
  check(
    'owned-by edge written',
    memory.knowledge_edges.from(sony!.note_path, OWNER, 'owned-by').some((e) => e.to_ref === 'Jasper'),
  );

  // Fan-out FYIs: Vivian (cost) + Kate (durable → warranty; the home-inventory
  // slice folded into Kate 2026-07-04, was Luna).
  const vivian_fyi = inbox.unread_for('vivian', 20);
  const kate_fyi = inbox.unread_for('kate', 20);
  check('Vivian got a cost FYI', vivian_fyi.some((m) => m.body_md.includes('WH-1000XM5')));
  check('Kate got a durable-good FYI (home inventory; was Luna)', kate_fyi.some((m) => m.body_md.includes('WH-1000XM5')));
  check('household FYI is shared (originating_user_id null)', vivian_fyi[0]?.originating_user_id === null);

  // ── 2. A grocery order (non-durable) → Vivian yes, Kate no ──────────────
  orders.upsert({
    user_id: 'jasper',
    private_to: 'household',
    order_key: 'wholefoods:g1',
    merchant: 'Whole Foods',
    order_number: 'g1',
    items: 'weekly grocery food order',
    order_total: '$84.00',
    order_date: '2026-06-19T00:00:00Z',
    status: 'ordered',
    fulfillment: 'consumable',
    source_message_id: 'm2',
  });
  await driver.on_order('jasper', 'wholefoods:g1', true);
  const kate_after = inbox.unread_for('kate', 20);
  check('Kate NOT pinged for a grocery (non-durable) good', !kate_after.some((m) => m.body_md.includes('grocery')));
  check('Vivian IS pinged for the grocery cost', inbox.unread_for('vivian', 20).some((m) => m.body_md.includes('grocery')));

  // ── 3. A personal order (Sam) → siloed good + user-scoped FYI ──────────
  orders.upsert({
    user_id: 'sam',
    private_to: 'sam',
    order_key: 'rei:s1',
    merchant: 'REI',
    order_number: 's1',
    items: 'rain jacket',
    order_total: '$129.00',
    order_date: '2026-06-19T00:00:00Z',
    status: 'ordered',
    source_message_id: 'm3',
  });
  await driver.on_order('sam', 'rei:s1', true);
  await rebuild(vault, memory, db);
  check('owner does NOT see Sam’s personal good', !memory.query_household_goods({ caller: OWNER }).some((g) => g.order_key === 'rei:s1'));
  check('Sam sees her own good', memory.query_household_goods({ caller: SAM }).some((g) => g.order_key === 'rei:s1'));
  const sara_fyi = inbox.unread_for('vivian', 50).find((m) => m.body_md.includes('rain jacket'));
  check('Sam’s order FYI is user-scoped (originating_user_id=sam)', sara_fyi?.originating_user_id === 'sam');

  // ── 4. Event-driven path + kill switch ──────────────────────────────────
  // Disabled: attach() should NOT subscribe → emitting does nothing.
  delete process.env.HEARTH_HOUSEHOLD_GRAPH;
  const db2 = open_db(join(tmp, 'hearth2.db'));
  const vault2 = join(tmp, 'vault2');
  mkdirSync(vault2, { recursive: true });
  const memory2b = new MemoryClient({ vault_root: vault2, db: db2 });
  const events2 = new AppEventBus();
  const inbox2 = new SpecialistInbox(db2);
  const orders2 = new MailOrders(db2);
  orders2.upsert({
    user_id: 'jasper', private_to: 'household', order_key: 'k:off', merchant: 'K', order_number: 'off',
    items: 'thing', order_total: '$5.00', order_date: '2026-06-19T00:00:00Z', status: 'ordered', source_message_id: 'm4',
  });
  const driver_off = new HouseholdGraphDriver({ events: events2, memory: memory2b, db: db2, inbox: inbox2, users });
  driver_off.attach(); // disabled → no subscription
  events2.emit({ type: 'order_upserted', user_id: 'jasper', order_key: 'k:off', is_new: true });
  await flush();
  await rebuild(vault2, memory2b, db2);
  check('kill switch OFF → emit does nothing', memory2b.query_household_goods({ caller: OWNER }).length === 0);

  // Enabled: attach() subscribes → emit fans out.
  process.env.HEARTH_HOUSEHOLD_GRAPH = '1';
  const driver_on = new HouseholdGraphDriver({ events: events2, memory: memory2b, db: db2, inbox: inbox2, users });
  driver_on.attach();
  events2.emit({ type: 'order_upserted', user_id: 'jasper', order_key: 'k:off', is_new: true });
  await flush();
  await rebuild(vault2, memory2b, db2);
  check('kill switch ON → emit fans the order into the graph', memory2b.query_household_goods({ caller: OWNER }).some((g) => g.order_key === 'k:off'));
  delete process.env.HEARTH_HOUSEHOLD_GRAPH;

  db.close();
  db2.close();
  rmSync(tmp, { recursive: true, force: true });
  console.log(`\n✅ smoke:order-fanout — ${passed} checks passed`);
}

main().catch((err) => {
  console.error(`\n❌ ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
