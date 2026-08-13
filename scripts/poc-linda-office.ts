export {};
/**
 * POC: Linda's Resale Desk, populated — what the office looks like when a
 * seller (Kim) has a real ~10-item inventory across marketplaces.
 *
 * Seeds a throwaway temp DB with a realistic mix (sold + active, several
 * platforms, cost basis, markdowns, two stale items), runs the REAL
 * `compose_resale_pane` (so it's the actual office, not a mockup), and
 * renders the composed pane document to a self-contained HTML file with a
 * faithful dark/gold theme + photo-placeholder thumbnails.
 *
 *   bun run scripts/poc-linda-office.ts
 *   → writes /tmp/linda-office-poc/index.html  (override with POC_OUT_DIR)
 */
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { open_db } from '@memory/stores/structured';
import { ResaleItemsStore } from '@memory/stores/resale_items';
import { compose_pane, type PaneBlock, type PaneDeps } from '@core/specialist_pane';
import type { LoadedSpecialist } from '@core/specialist';

const USER = 'kim';

// Photo-placeholder per item — a gradient tile + emoji standing in for the
// real /api/cordelia/thumbnail/<id> image (which doesn't resolve outside the
// app). Keyed by the capture id the office card carries.
const THUMBS: Record<string, { emoji: string; from: string; to: string }> = {
  cap_boot: { emoji: '🥾', from: '#6b7a8f', to: '#3a4654' },
  cap_pata: { emoji: '🧥', from: '#7c5e3b', to: '#4a3722' },
  cap_carh: { emoji: '🧥', from: '#9c7b3f', to: '#5e4a26' },
  cap_coach: { emoji: '👜', from: '#8a5a3c', to: '#523322' },
  cap_cand: { emoji: '🕯️', from: '#b59a5e', to: '#6e5d38' },
  cap_lc: { emoji: '🍲', from: '#b1442e', to: '#6e2a1d' },
  cap_pyrex: { emoji: '🥣', from: '#5f8a6b', to: '#385340' },
  cap_ks: { emoji: '👚', from: '#a05a78', to: '#62374a' },
  cap_staub: { emoji: '🍳', from: '#555', to: '#2c2c2c' },
  cap_levis: { emoji: '👖', from: '#3f5d8a', to: '#263953' },
};

interface Seed {
  ref: string;
  title: string;
  category: string;
  platform: 'ebay' | 'poshmark' | 'facebook';
  cap: string;
  cost: number;
  list: number;
  listed_at: string;
  drops?: { at: string; price: number }[];
  sold?: { price: number; at: string };
}

// Realistic Kim inventory — her vintage/homeware/footwear/clothing voice.
const ITEMS: Seed[] = [
  // ── Sold (5) ──
  { ref: 'boot', title: 'Sundance Vero Cuoio Grey Suede Chelsea Boot EU 39', category: 'footwear', platform: 'ebay', cap: 'cap_boot', cost: 22, list: 89, listed_at: '2026-04-22', drops: [{ at: '2026-05-02', price: 79 }], sold: { price: 72, at: '2026-05-10' } },
  { ref: 'pata', title: 'Patagonia Better Sweater Jacket, M', category: 'outerwear', platform: 'poshmark', cap: 'cap_pata', cost: 8, list: 58, listed_at: '2026-05-18', sold: { price: 52, at: '2026-05-21' } },
  { ref: 'carh', title: 'Carhartt Duck Canvas Chore Coat, L', category: 'outerwear', platform: 'ebay', cap: 'cap_carh', cost: 12, list: 75, listed_at: '2026-05-05', drops: [{ at: '2026-05-18', price: 68 }], sold: { price: 64, at: '2026-05-24' } },
  { ref: 'coach', title: 'Coach Leather Crossbody Bag, Tan', category: 'bag', platform: 'ebay', cap: 'cap_coach', cost: 18, list: 88, listed_at: '2026-05-26', sold: { price: 80, at: '2026-06-01' } },
  { ref: 'cand', title: 'Vintage Brass Candlesticks, Pair', category: 'homeware', platform: 'facebook', cap: 'cap_cand', cost: 8, list: 50, listed_at: '2026-05-20', sold: { price: 45, at: '2026-05-30' } },
  // ── Active (5) — two of them stale ──
  { ref: 'lc', title: 'Le Creuset 5.5qt Dutch Oven, Cerise', category: 'homeware', platform: 'facebook', cap: 'cap_lc', cost: 30, list: 180, listed_at: '2026-05-26' },
  { ref: 'pyrex', title: 'Vintage Pyrex Spring Blossom Bowl Set', category: 'homeware', platform: 'ebay', cap: 'cap_pyrex', cost: 6, list: 65, listed_at: '2026-04-24', drops: [{ at: '2026-05-08', price: 57 }, { at: '2026-05-22', price: 48 }] },
  { ref: 'ks', title: 'Kate Spade Floral Silk Blouse, S', category: 'clothing', platform: 'poshmark', cap: 'cap_ks', cost: 5, list: 42, listed_at: '2026-05-22' },
  { ref: 'staub', title: 'Staub Cast Iron Skillet, 10in', category: 'homeware', platform: 'facebook', cap: 'cap_staub', cost: 20, list: 95, listed_at: '2026-05-31' },
  { ref: 'levis', title: "Levi's 501 Vintage Selvedge, 32x32", category: 'denim', platform: 'poshmark', cap: 'cap_levis', cost: 9, list: 68, listed_at: '2026-05-04', drops: [{ at: '2026-05-16', price: 59 }, { at: '2026-05-28', price: 52 }] },
];

function seed(store: ResaleItemsStore): void {
  for (const it of ITEMS) {
    store.upsert({
      user_id: USER,
      specialist_id: 'linda',
      dedup_key: it.ref,
      item_title: it.title,
      category: it.category,
      platform: it.platform,
      source_capture_id: it.cap,
      cost_basis: it.cost,
      list_price: it.list,
      listed_at: it.listed_at,
      ...(it.drops ? { price_drops: it.drops } : {}),
      ...(it.sold ? { status: 'sold', sold_price: it.sold.price, sold_at: it.sold.at } : {}),
    });
  }
}

// ── HTML render of the composed pane ───────────────────────────────────────

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

function thumb_html(cap?: string): string {
  if (!cap) return '';
  const t = THUMBS[cap];
  if (!t) return '<div class="thumb thumb-blank"></div>';
  return `<div class="thumb" style="background:linear-gradient(135deg,${t.from},${t.to})">${t.emoji}</div>`;
}

function row_html(it: { title: string; subtitle?: string; thumb_capture_id?: string }, opts: { aging?: boolean } = {}): string {
  return (
    `<div class="row${opts.aging ? ' row-aging' : ''}">` +
    thumb_html(it.thumb_capture_id) +
    `<div class="row-tx"><div class="row-t">${esc(it.title)}</div>` +
    (it.subtitle ? `<div class="row-s">${esc(it.subtitle)}</div>` : '') +
    '</div></div>'
  );
}

function block_html(b: PaneBlock): string {
  switch (b.type) {
    case 'hero_metric': {
      const down = /down/.test(b.delta_kind ?? '');
      return (
        '<div class="hero">' +
        `<div class="hero-val">${esc(b.value)}</div>` +
        `<div class="hero-col"><div class="hero-lab">${esc(b.label)}</div>` +
        (b.delta ? `<div class="hero-delta ${esc(b.delta_kind ?? 'neutral')}">${down ? '▼' : '▲'} ${esc(b.delta)}</div>` : '') +
        '</div></div>'
      );
    }
    case 'list': {
      const aging = b.title === 'Time to nudge the price';
      const rows = b.items.map((it) => row_html(it, { aging })).join('');
      return (
        `<div class="block${aging ? ' block-aging' : ''}">` +
        (b.title ? `<div class="block-title">${aging ? '⏳ ' : ''}${esc(b.title)}</div>` : '') +
        `<div class="card list">${rows}</div></div>`
      );
    }
    case 'load_chart': {
      // Chart scales to the height_hint ('md' is taller) — bars fill the card.
      const chartH = b.height_hint === 'md' ? 150 : 96;
      const barMax = chartH - 28;
      const max = Math.max(1, ...b.points.map((p) => p.y));
      const cols = b.points
        .map((p) => {
          const h = Math.round((p.y / max) * barMax) + 2;
          const tip = p.detail ?? String(p.y);
          return `<div class="bar-col"><span class="bar-tip">${esc(tip)}</span><div class="bar" style="height:${h}px"></div><span class="bar-x">${esc(p.label ?? '')}</span></div>`;
        })
        .join('');
      return `<div class="block">${b.title ? `<div class="block-title">${esc(b.title)}</div>` : ''}<div class="card bars" style="height:${chartH}px">${cols}</div></div>`;
    }
    case 'stacked_strip': {
      const total = b.segments.reduce((a, s) => a + s.value, 0) || 1;
      const hues: Record<string, string> = { z1: '#5b8def', z2: '#37c2a8', z3: '#e0a13a', z4: '#e0653a', z5: '#a05ad0' };
      const bar = b.segments
        .map((s) => `<span style="flex-grow:${s.value};background:${hues[s.hue ?? 'z3'] ?? '#888'}"></span>`)
        .join('');
      const leg = b.segments
        .map((s) => `<span class="leg"><i style="background:${hues[s.hue ?? 'z3'] ?? '#888'}"></i>${esc(s.label)} · $${Math.round(s.value)} (${Math.round((s.value / total) * 100)}%)</span>`)
        .join('');
      return `<div class="block">${b.title ? `<div class="block-title">${esc(b.title)}</div>` : ''}<div class="card strip"><div class="strip-bar">${bar}</div><div class="strip-leg">${leg}</div></div></div>`;
    }
    case 'text':
      return `<div class="block"><div class="card text">${esc(b.body_md.replace(/^_|_$/g, ''))}</div></div>`;
    default:
      return '';
  }
}

function page(title: string, subtitle: string | undefined, blocks: PaneBlock[]): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} — POC</title>
<style>
  * { box-sizing: border-box; }
  body { margin: 0; background: #14110c; color: #ece3d0; font: 15px/1.45 -apple-system, "SF Pro Text", Segoe UI, Roboto, sans-serif; }
  .phone { max-width: 430px; margin: 0 auto; min-height: 100vh; background: radial-gradient(120% 80% at 50% 0%, #221c12 0%, #14110c 60%); }
  .topbar { background: linear-gradient(135deg, #6e4a2b, #3a2715); padding: 22px 20px 16px; }
  .topbar h1 { margin: 0; font-size: 22px; font-weight: 650; letter-spacing: .2px; color: #f6ecd6; }
  .topbar .sub { margin-top: 3px; color: #d9c39a; font-size: 13px; }
  .body { padding: 14px 14px 40px; }
  .hero { display: flex; align-items: center; gap: 16px; padding: 18px 18px; margin-bottom: 14px;
          background: linear-gradient(135deg, rgba(224,161,58,.14), rgba(224,161,58,.04)); border: 1px solid rgba(224,161,58,.28);
          border-radius: 16px; }
  .hero-val { font-size: 40px; font-weight: 720; color: #f6ecd6; line-height: 1; }
  .hero-lab { color: #d9c39a; font-size: 13px; }
  .hero-delta { margin-top: 4px; font-size: 13px; font-weight: 600; }
  .hero-delta.up_good { color: #58c98a; }
  .block { margin-bottom: 16px; }
  .block-title { font-size: 13px; font-weight: 650; color: #cdb88c; text-transform: none; margin: 0 4px 7px; letter-spacing: .3px; }
  .card { background: rgba(255,255,255,.035); border: 1px solid rgba(224,161,58,.14); border-radius: 14px; overflow: hidden; }
  .block-aging .block-title { color: #e9b24a; }
  .block-aging .card { border-color: rgba(224,161,58,.4); box-shadow: 0 0 0 1px rgba(224,161,58,.12) inset; }
  .row { display: flex; align-items: center; gap: 11px; padding: 11px 13px; border-bottom: 1px solid rgba(255,255,255,.06); }
  .row:last-child { border-bottom: none; }
  .row-aging { background: rgba(224,161,58,.06); }
  .thumb { width: 46px; height: 46px; flex: none; border-radius: 9px; display: flex; align-items: center; justify-content: center;
           font-size: 23px; border: 1px solid rgba(255,255,255,.12); box-shadow: 0 1px 3px rgba(0,0,0,.4); }
  .thumb-blank { background: #333; }
  .row-tx { min-width: 0; }
  .row-t { font-weight: 600; font-size: 14.5px; color: #f1e7d2; line-height: 1.25; }
  .row-s { font-size: 12.5px; color: #b6a47e; margin-top: 2px; }
  .bars { display: flex; align-items: flex-end; gap: 8px; padding: 12px 14px; }
  .bar-col { flex: 1; display: flex; flex-direction: column; align-items: center; gap: 4px; }
  .bar-tip { font-size: 10px; color: #b6a47e; height: 12px; }
  .bar { width: 70%; min-height: 2px; border-radius: 3px 3px 0 0; background: linear-gradient(180deg, #e9b24a, #b9863a); }
  .bar-x { font-size: 10px; color: #8d7c5c; }
  .strip { padding: 14px; }
  .strip-bar { display: flex; height: 16px; border-radius: 8px; overflow: hidden; }
  .strip-bar span { display: block; }
  .strip-leg { display: flex; flex-wrap: wrap; gap: 12px; margin-top: 10px; font-size: 12px; color: #c3b288; }
  .leg i { display: inline-block; width: 9px; height: 9px; border-radius: 2px; margin-right: 5px; vertical-align: middle; }
  .text { padding: 14px; color: #b6a47e; font-style: italic; }
</style></head>
<body><div class="phone">
  <div class="topbar"><h1>${esc(title)}</h1>${subtitle ? `<div class="sub">${esc(subtitle)}</div>` : ''}</div>
  <div class="body">${blocks.map(block_html).join('')}</div>
</div></body></html>`;
}

// ── main ───────────────────────────────────────────────────────────────────

const tmp = mkdtempSync(join(tmpdir(), 'hearth-poc-db-'));
const db = open_db(join(tmp, 'poc.db'));
const store = new ResaleItemsStore(db);
// POC_EMPTY=1 renders the brand-new, no-data office (the pre-created scaffold).
const is_empty = process.env.POC_EMPTY === '1';
if (!is_empty) seed(store);

const doc = await compose_pane({ pane_kind: 'resale' } as LoadedSpecialist, db, USER, {} as unknown as PaneDeps);
if (!doc) throw new Error('pane composed null');

const out_dir = process.env.POC_OUT_DIR ?? (is_empty ? '/tmp/linda-office-poc-empty' : '/tmp/linda-office-poc');
mkdirSync(out_dir, { recursive: true });
const html = page(doc.title, doc.subtitle, doc.blocks);
writeFileSync(join(out_dir, 'index.html'), html);

db.close();

// Console summary so the POC is legible without opening the browser.
console.log(`\nLinda's Resale Desk — POC (${is_empty ? 'EMPTY / pre-created scaffold' : `${ITEMS.length} items`})\n`);
for (const b of doc.blocks) {
  if (b.type === 'hero_metric') console.log(`  ${b.value}  ${b.label}${b.delta ? `  (${b.delta})` : ''}`);
  else if (b.type === 'list') {
    console.log(`\n  ${b.title}`);
    for (const it of b.items) console.log(`    • ${it.title}${it.subtitle ? `\n        ${it.subtitle}` : ''}`);
  } else if (b.type === 'stacked_strip') {
    console.log(`\n  ${b.title}: ${b.segments.map((s) => `${s.label} $${Math.round(s.value)}`).join(' · ')}`);
  } else if (b.type === 'load_chart') {
    console.log(`\n  ${b.title}: ${b.points.map((p) => p.detail).join(' ')}`);
  }
}
console.log(`\nHTML → ${join(out_dir, 'index.html')}\n`);
