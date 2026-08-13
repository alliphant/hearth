/**
 * smoke:resale — self-contained test of Linda's resale office.
 *
 * Own temp SQLite (no orchestrator, no network). Exercises:
 *   - ResaleItemsStore: lifecycle upsert (active → price drop → sold),
 *     field-level merge, and the sales_metrics math.
 *   - track_listing tool: execute writes a row + emits resale_item_updated.
 *   - compose_pane('resale'): block shape, thumb_capture_id passthrough,
 *     and the empty-office state.
 *
 *   bun run smoke:resale
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { open_db } from '@memory/stores/structured';
import { ResaleItemsStore, compute_aging } from '@memory/stores/resale_items';
import { create as create_track_listing } from '@specialists/linda/tools/track_listing';
import { compose_pane } from '@core/specialist_pane';
import type { ToolContext } from '@core/tool';
import type { ToolDeps } from '@core/tool_deps';
import type { LoadedSpecialist } from '@core/specialist';
import type { PaneDeps } from '@core/specialist_pane';
import type { AppEvent } from '@app/events';

let failures = 0;
function check(label: string, ok: boolean): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) failures++;
}
function approx(a: number | null, b: number, eps = 0.5): boolean {
  return a != null && Math.abs(a - b) <= eps;
}

const dir = mkdtempSync(join(tmpdir(), 'hearth-resale-'));
const db = open_db(join(dir, 'resale.db'));
const NOW = new Date('2026-06-03T12:00:00Z');

try {
  const store = new ResaleItemsStore(db);
  const USER = 'kim';

  // ── 1. Empty office state ─────────────────────────────────────────────
  const empty = await compose_pane(
    { pane_kind: 'resale' } as LoadedSpecialist,
    db,
    USER,
    {} as unknown as PaneDeps,
  );
  check('empty office returns a resale doc', empty?.pane_kind === 'resale');
  // Pre-created scaffold: even with no data, the full office shape renders —
  // hero + revenue chart + the four standing lists — each with an empty state.
  const empty_titles = (empty?.blocks ?? [])
    .filter((b) => b.type === 'list')
    .map((b) => (b.type === 'list' ? b.title : undefined));
  check('empty office still renders the hero', !!empty && empty.blocks[0]?.type === 'hero_metric');
  check('empty office renders the revenue chart', !!empty && empty.blocks.some((b) => b.type === 'load_chart'));
  check(
    'empty office pre-creates all standing sections',
    ['Revenue by platform', 'Performance', 'Active listings', 'Recently sold'].every((t) => empty_titles.includes(t)),
  );
  const empty_active = empty?.blocks.find((b) => b.type === 'list' && b.title === 'Active listings');
  check(
    'empty Active listings shows a guiding empty-state row',
    empty_active?.type === 'list' && /tell Linda/.test(empty_active.items[0]?.subtitle ?? ''),
  );
  check('empty office does NOT show an aging block (nothing active to age)', !empty_titles.includes('Time to nudge the price'));

  // ── 2. Seed the ledger ────────────────────────────────────────────────
  // A: listed → dropped once → sold, with a cost basis + a photo.
  store.upsert({
    user_id: USER,
    specialist_id: 'linda',
    dedup_key: 'ref-a',
    item_title: 'Patagonia down jacket, M',
    source_capture_id: 'cap_a',
    platform: 'ebay',
    list_price: 50,
    listed_at: '2026-05-20',
    cost_basis: 20,
    category: 'outerwear',
  });
  store.upsert({ user_id: USER, specialist_id: 'linda', dedup_key: 'ref-a', item_title: 'Patagonia down jacket, M', add_price_drop: { at: '2026-05-24', price: 45 } });
  store.upsert({ user_id: USER, specialist_id: 'linda', dedup_key: 'ref-a', item_title: 'Patagonia down jacket, M', status: 'sold', sold_price: 45, sold_at: '2026-05-27' });

  // B: active, no sale yet.
  store.upsert({
    user_id: USER, specialist_id: 'linda', dedup_key: 'ref-b',
    item_title: 'Le Creuset dutch oven', source_capture_id: 'cap_b',
    platform: 'poshmark', list_price: 30, listed_at: '2026-05-25',
  });

  // C: listed → sold fast, no cost basis.
  store.upsert({
    user_id: USER, specialist_id: 'linda', dedup_key: 'ref-c',
    item_title: 'Vintage Pyrex bowl', platform: 'ebay',
    list_price: 100, listed_at: '2026-05-10', status: 'sold',
    sold_price: 90, sold_at: '2026-05-12',
  });

  // ── 3. Field-merge integrity ──────────────────────────────────────────
  const a = store.get(store.list_recent_sold(USER, 10).find((r) => r.item_title.startsWith('Patagonia'))!.id, USER)!;
  check('merge: A kept platform from the first call', a.platform === 'ebay');
  check('merge: A kept list_price through the drop + sale calls', a.list_price === 50);
  check('merge: A recorded one price drop', a.price_drops.length === 1);
  check('merge: A final status sold + sold_price', a.status === 'sold' && a.sold_price === 45);

  // ── 4. Metrics math ───────────────────────────────────────────────────
  const m = store.sales_metrics(USER, NOW);
  check('revenue = 45 + 90 = 135', m.total_revenue === 135);
  check('total sales = 2', m.total_sales === 2);
  check('active count = 1', m.active_count === 1);
  // A: ebay, sold $45, cost $20, no recorded fee → estimated ebay fee
  // 13.6% + $0.40 = $6.52, so net = 45 − 20 − 6.52 = 18.48.
  check('net profit ≈ 18.48 (45 − 20 − $6.52 ebay fee est)', approx(m.net_profit, 18.48, 0.05));
  check('margin ≈ 41.1% (18.48/45)', approx(m.margin_pct, 41.1, 0.3));
  check('sell-through ≈ 66.7% (2 of 3 listed)', approx(m.sell_through_pct, 66.7, 0.3));
  check('avg days-to-sell = 4.5 ((7+2)/2)', approx(m.avg_days_to_sell, 4.5));
  check('avg discount = 10%', approx(m.avg_discount_pct, 10));
  check('avg drops = 0.5', approx(m.avg_drops, 0.5));
  check('by_platform has only ebay (poshmark item unsold)', m.by_platform.length === 1 && m.by_platform[0]!.platform === 'ebay');
  check('ebay platform revenue = 135', m.by_platform[0]!.revenue === 135);
  check('revenue_by_week has 8 buckets', m.revenue_by_week.length === 8);
  check('revenue_by_week sums to 135', m.revenue_by_week.reduce((s, w) => s + w.revenue, 0) === 135);

  // ── 4b. Aging radar ───────────────────────────────────────────────────
  const benchmarks = store.days_to_sell_benchmarks(USER);
  check('overall days-to-sell benchmark ≈ 4.5', approx(benchmarks.overall, 4.5));
  // B (Le Creuset): listed 2026-05-25, active → 9 days live at NOW vs ~4.5
  // benchmark = aging (9 ≥ 1.5×4.5). Suggested = charm(30 × 0.88) = 26.
  const agingList = compute_aging(store.list_active(USER), benchmarks, NOW);
  const bEntry = agingList.find((e) => e.item.item_title.startsWith('Le Creuset'));
  check('aging radar flags the 9-day-old active listing', !!bEntry);
  check('aging entry days_live = 9', bEntry?.days_live === 9);
  check('aging entry severity = aging (not stale)', bEntry?.severity === 'aging');
  check('aging suggests a charm markdown (30 → 26)', bEntry?.suggested_price === 26);

  // ── 5. Pane composition ───────────────────────────────────────────────
  const doc = await compose_pane({ pane_kind: 'resale' } as LoadedSpecialist, db, USER, {} as unknown as PaneDeps);
  if (!doc) throw new Error('pane doc was null');
  const hero = doc.blocks.find((b) => b.type === 'hero_metric');
  check('pane hero shows revenue', hero?.type === 'hero_metric' && hero.value.includes('135'));
  check('pane hero delta shows profit', hero?.type === 'hero_metric' && /profit/.test(hero.delta ?? ''));
  const lists = doc.blocks.filter((b) => b.type === 'list');
  const active_block = lists.find((b) => b.type === 'list' && b.title === 'Active listings');
  check('pane has an Active listings block', !!active_block);
  const active_item = active_block?.type === 'list' ? active_block.items[0] : undefined;
  check('active card carries thumb_capture_id (cap_b)', active_item?.thumb_capture_id === 'cap_b');
  const sold_block = lists.find((b) => b.type === 'list' && b.title === 'Recently sold');
  check('pane has a Recently sold block', !!sold_block);
  const sold_item = sold_block?.type === 'list' ? sold_block.items.find((i) => i.thumb_capture_id === 'cap_a') : undefined;
  check('sold card carries thumb_capture_id (cap_a)', !!sold_item);
  check('sold card subtitle reads "sold $45"', !!sold_item && /sold \$45/.test(sold_item.subtitle ?? ''));
  check('pane has a Performance block', lists.some((b) => b.type === 'list' && b.title === 'Performance'));
  const aging_block = lists.find((b) => b.type === 'list' && b.title === 'Time to nudge the price');
  check('pane has an aging-radar block', !!aging_block);
  const aging_row = aging_block?.type === 'list' ? aging_block.items.find((i) => i.title.startsWith('Le Creuset')) : undefined;
  // The pane composes aging with the HOST clock (compose_pane → compute_aging
  // with no `now`), which is correct for production but diverges from this
  // smoke's fixed NOW — so the exact suggested price (aging vs stale drop)
  // isn't stable here. Section 4b already verifies the exact charm math (→ $26)
  // under a controlled NOW; this assertion verifies the pane RENDERS the row +
  // a markdown from the $30 list price, which is clock-robust.
  check('aging row names the overdue item + a markdown', !!aging_row && /drop \$30 → \$\d+/.test(aging_row.subtitle ?? ''));

  // ── 6. track_listing tool ─────────────────────────────────────────────
  const events: AppEvent[] = [];
  const deps = {
    db,
    events: { emit: (e: AppEvent) => events.push(e) },
    memory: { log_action: () => 'audit_x' },
  } as unknown as ToolDeps;
  const tool = create_track_listing(deps);
  const ctx = {
    intent_id: 'i1',
    specialist_id: 'linda',
    user: { id: USER },
    now: NOW,
    memory: deps.memory,
    llm: {},
  } as unknown as ToolContext;

  const out = await tool.execute(
    { item_title: 'Cole Haan loafers, 9', item_ref: 'ref-d', platform: 'facebook', list_price: 35, listed_at: '2026-06-01' },
    ctx,
  );
  check('track_listing returns active status', out.status === 'active');
  check('track_listing emitted resale_item_updated', events.some((e) => e.type === 'resale_item_updated'));
  check('track_listing persisted the row', store.get(out.resale_item_id, USER)?.item_title === 'Cole Haan loafers, 9');

  // Follow-up: mark it sold by item_ref only — must update in place.
  const out2 = await tool.execute(
    { item_title: 'Cole Haan loafers, 9', item_ref: 'ref-d', status: 'sold', sold_price: 32, sold_at: '2026-06-02' },
    ctx,
  );
  check('track_listing follow-up updated same row id', out2.resale_item_id === out.resale_item_id);
  check('track_listing follow-up flipped status to sold', store.get(out.resale_item_id, USER)?.status === 'sold');
} finally {
  db.close();
  rmSync(dir, { recursive: true, force: true });
}

console.log(failures === 0 ? '\nAll resale smoke checks passed.' : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
