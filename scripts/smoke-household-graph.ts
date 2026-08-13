/**
 * smoke:household-graph — the Household Knowledge Graph core (Phase 1b).
 *
 * Self-contained: temp vault + temp db, no orchestrator, no LLM. Exercises:
 *   - the pure enricher (enrich_order_to_good): category classify, cost parse,
 *     implication windows (return/warranty), typed edges, idempotent id/path
 *   - the household_good projection: write the enriched note → rebuild →
 *     a household_goods row with the right date-scannable columns
 *   - the cordon matrix on query_household_goods + the KnowledgeEdges store
 *     (owner/household see a shared good; a friend does not; a personal good
 *     silos to its user — the owner has NO god-view)
 *   - the date-scans goods_with_return_window_closing / _warranty_expiring
 *
 *   bun run smoke:household-graph
 */
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { open_db } from '@memory/stores/structured';
import { MemoryClient } from '@memory/client';
import { rebuild } from '@ingestor/rebuild';
import { enrich_order_to_good } from '@core/household_knowledge/enrich';
import type { Caller } from '@memory/private_to';

let passed = 0;
function check(label: string, cond: unknown): void {
  if (!cond) throw new Error(`FAIL: ${label}`);
  passed++;
  console.log(`  ✓ ${label}`);
}

const OWNER: Caller = { user_id: 'jasper', tier: 'owner' };
const HOUSEHOLD: Caller = { user_id: 'sam', tier: 'household' };
const FRIEND: Caller = { user_id: 'kim', tier: 'friend' };

async function main(): Promise<void> {
  const tmp = mkdtempSync(join(tmpdir(), 'hearth-hkg-'));
  const vault = join(tmp, 'vault');
  const db_path = join(tmp, 'hearth.db');
  mkdirSync(vault, { recursive: true });
  const db = open_db(db_path);
  const memory = new MemoryClient({ vault_root: vault, db });

  // Fixed "now" so the date-window math is deterministic.
  const now = new Date('2026-06-20T12:00:00Z');

  // ── 1. The pure enricher ────────────────────────────────────────────────
  const enriched = enrich_order_to_good(
    {
      order_key: 'sony:abc-123',
      merchant: 'Sony',
      items: 'WH-1000XM5 wireless headphones',
      order_total: '$348.00',
      order_date: '2026-06-18T00:00:00Z',
      status: 'delivered',
      fulfillment: 'durable_goods',
      source_message_id: 'msg-1',
    },
    { buyer_display_name: 'Jasper', private_to: 'household', now },
  );
  check('enrich classifies electronics', enriched.frontmatter.category === 'electronics');
  check('enrich parses cost', enriched.frontmatter.cost === 348);
  check('enrich derives warranty (electronics → +365d)', enriched.frontmatter.warranty_until === '2027-06-18');
  check('enrich derives return window (+30d)', enriched.frontmatter.return_window_until === '2026-07-18');
  check('enrich sets owner from buyer', enriched.frontmatter.owner === 'Jasper');
  check('enrich stamps cordon', enriched.frontmatter.private_to === 'household');
  check('enrich emits purchased-from edge', enriched.edges.some((e) => e.kind === 'purchased-from' && e.to_ref === 'Sony'));
  check('enrich emits owned-by edge', enriched.edges.some((e) => e.kind === 'owned-by' && e.to_ref === 'Jasper'));

  // Idempotency: same order_key → same id + path.
  const again = enrich_order_to_good(
    { order_key: 'sony:abc-123', merchant: 'Sony', items: 'x', order_total: null, order_date: null, status: 'ordered' },
    { private_to: 'household', now },
  );
  check('enrich id is stable per order_key', again.id === enriched.id);
  check('enrich path is stable per order_key', again.note_path === enriched.note_path);
  check('enrich omits windows with no purchase_date', !again.frontmatter.warranty_until && !again.frontmatter.return_window_until);

  // ── 1b. Returnability is the MODEL's judgment, not the keyword category ──
  // The keyword classifier can't tell a cheeseburger from a wireless mouse —
  // both land in `other` — so `fulfillment` decides whether a window exists at
  // all. Before 2026-07-20 the `other` default fabricated +30d on everything,
  // and Kate offered to start a return on fast food and a massage.
  const windows_of = (o: Partial<Parameters<typeof enrich_order_to_good>[0]>) =>
    enrich_order_to_good(
      {
        order_key: `k:${o.items ?? 'x'}`,
        merchant: o.merchant ?? 'Somewhere',
        items: o.items ?? null,
        order_total: '$12.00',
        order_date: '2026-06-18T00:00:00Z',
        status: 'delivered',
        ...o,
      } as Parameters<typeof enrich_order_to_good>[0],
      { private_to: 'household', now },
    ).frontmatter;

  const burger = windows_of({ merchant: "McDonald's", items: '1x Cheeseburger', fulfillment: 'consumable' });
  check('a consumable gets NO return window', !burger.return_window_until);
  const massage = windows_of({ merchant: 'Dana Marsh LMT', items: '90 Minute Therapeutic Massage', fulfillment: 'service' });
  check('a service gets NO return window', !massage.return_window_until);
  const twitch = windows_of({ merchant: 'Twitch', items: 'Tier 1 - 1 Month Subscription', fulfillment: 'subscription' });
  check('a subscription gets NO return window', !twitch.return_window_until);

  // The other half of the trap: these are ALSO `other` to the keyword list, so
  // a category allowlist would have silently dropped their real windows.
  const mouse = windows_of({ merchant: 'Amazon', items: 'Logitech G PRO X2 Wireless Gaming Mouse', fulfillment: 'durable_goods' });
  check('an unclassifiable DURABLE good keeps its return window', mouse.return_window_until === '2026-07-18');
  check('…and the keyword classifier still called it `other`', mouse.category === 'other');

  // Unjudged is UNKNOWN, never "returnable" — an LLM outage must file nothing
  // rather than guess, the same rule as a missing purchase date.
  const unjudged = windows_of({ merchant: 'Amazon', items: 'Something the extractor could not read' });
  check('an unjudged order derives NO window (honest absence)', !unjudged.return_window_until);

  // ── 2. Write the good note + project it ──────────────────────────────────
  memory.upsert_note(enriched.note_path, enriched.frontmatter as Record<string, unknown>, enriched.body);

  // A second good, owned personally by Sam (cordon silo), return window soon.
  const sams = enrich_order_to_good(
    {
      order_key: 'rei:zip-9',
      merchant: 'REI',
      items: 'rain jacket',
      order_total: '$129.00',
      order_date: '2026-06-19T00:00:00Z',
      status: 'delivered',
      fulfillment: 'durable_goods',
    },
    { buyer_display_name: 'Sam', private_to: 'sam', now },
  );
  memory.upsert_note(sams.note_path, sams.frontmatter as Record<string, unknown>, sams.body);

  await rebuild(vault, memory, db);

  // ── 3. Projection + cordon matrix ───────────────────────────────────────
  const owner_goods = memory.query_household_goods({ caller: OWNER });
  check('owner sees the household good', owner_goods.some((g) => g.id === enriched.id));
  check('owner does NOT see Sam’s personal good (no god-view)', !owner_goods.some((g) => g.id === sams.id));

  const sara_goods = memory.query_household_goods({ caller: HOUSEHOLD });
  check('household member sees the shared good', sara_goods.some((g) => g.id === enriched.id));
  check('Sam sees her own personal good', sara_goods.some((g) => g.id === sams.id));

  const lee_goods = memory.query_household_goods({ caller: FRIEND });
  check('friend sees neither household nor personal good', lee_goods.length === 0);

  const projected = owner_goods.find((g) => g.id === enriched.id)!;
  check('projection kept category', projected.category === 'electronics');
  check('projection kept cost', projected.cost === 348);
  check('projection kept warranty_until', projected.warranty_until === '2027-06-18');

  // ── 4. Date-scans ───────────────────────────────────────────────────────
  // Sam's return window closes 2026-07-19 (+30d from 06-19); within 30d of now.
  const closing = memory.goods_with_return_window_closing(30, HOUSEHOLD, now);
  check('return-window scan finds Sam’s jacket for Sam', closing.some((g) => g.id === sams.id));
  const closing_owner = memory.goods_with_return_window_closing(30, OWNER, now);
  check('return-window scan does NOT leak Sam’s jacket to owner', !closing_owner.some((g) => g.id === sams.id));
  const warranty = memory.goods_with_warranty_expiring(400, OWNER, now);
  check('warranty scan finds the headphones within 400d', warranty.some((g) => g.id === enriched.id));
  const warranty_narrow = memory.goods_with_warranty_expiring(30, OWNER, now);
  check('warranty scan excludes the headphones at 30d horizon', !warranty_narrow.some((g) => g.id === enriched.id));

  // ── 5. Typed edges store + cordon ───────────────────────────────────────
  for (const e of enriched.edges) memory.knowledge_edges.upsert(e);
  for (const e of sams.edges) memory.knowledge_edges.upsert(e);
  const owner_edges = memory.knowledge_edges.from(enriched.note_path, OWNER);
  check('edges: owner reads the household good’s edges', owner_edges.length === enriched.edges.length);
  const friend_edges = memory.knowledge_edges.from(sams.note_path, FRIEND);
  check('edges: friend can’t read Sam’s personal edges', friend_edges.length === 0);
  const merchant_in = memory.knowledge_edges.to('Sony', OWNER, 'purchased-from');
  check('edges: reverse lookup by merchant', merchant_in.some((e) => e.from_ref === enriched.note_path));

  db.close();
  rmSync(tmp, { recursive: true, force: true });
  console.log(`\n✅ smoke:household-graph — ${passed} checks passed`);
}

main().catch((err) => {
  console.error(`\n❌ ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
