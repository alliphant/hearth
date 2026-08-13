/**
 * lookup_commodity_market_prices — the "cost beyond the deltas" half of Kristi's
 * pricing intel.
 *
 * A configurator delta (`drive_configurator`) is `+$X` over the included base
 * option — never the part's absolute, and OEMs mark components up well above
 * street (HP's RTX PRO 6000 delta +$10,907 vs ~$8,500 street), non-linearly. So
 * you cannot back an OEM absolute out of a street anchor. What you CAN do — and
 * what actually answers "what does the part cost, beyond the OEM's delta" — is
 * observe the open-market street/MSRP price per commodity and surface it beside
 * each OEM's delta, so the PREMIUM is visible. As AI-server demand squeezes
 * NAND/DRAM/VRAM, that market price is the moving number, and the OEM-delta-vs-
 * market gap is the competitive signal.
 *
 * For every commodity that has an OEM configurator delta (ALL hardware classes —
 * gpu/cpu/memory/storage/psu, not just the constrained ones), this runs a
 * bounded street-price lookup (search → fetch → one LLM number-extract) and
 * records it as a `standalone` row (vendor-agnostic, the observed market price).
 * Bounded per run; skips commodities already priced recently; backfills over
 * runs. The `premium_view` store read + the Recon Desk pane do the juxtaposition.
 */
import { z } from 'zod';
import type { Tool, ToolContext } from '@core/tool';
import type { ToolDeps } from '@core/tool_deps';
import { getKristiWorkstationsStore, type CommodityClass } from '@memory/stores/kristi_workstations';
import { fetch_with_browser_fallback } from '@connectors/fetch_with_browser_fallback';
import { web_search } from '@connectors/searxng';

const DEFAULT_CLASSES: CommodityClass[] = ['gpu', 'cpu', 'memory', 'storage', 'psu'];
const DEFAULT_MAX = 10; // commodities priced per run (bounded; backfills over runs)
// Re-price window by class. The AI-server NAND/DRAM/VRAM squeeze moves the
// constrained classes fast, so refresh them DAILY; others can go stale longer.
const STALE_HOURS: Partial<Record<CommodityClass, number>> = { memory: 24, storage: 24, gpu: 24 };
const DEFAULT_STALE_HOURS = 96;

// Per-class sane street-price bounds (USD); a hit outside is a misread/bundle.
const BOUNDS: Record<string, [number, number]> = {
  gpu: [120, 20_000],
  cpu: [80, 20_000],
  memory: [20, 60_000], // 512GB DDR5 ECC kits run very high under the DRAM squeeze
  storage: [20, 12_000],
  psu: [20, 2_000],
  other: [10, 60_000],
};

const InputSchema = z
  .object({
    classes: z
      .array(z.enum(['gpu', 'cpu', 'memory', 'storage', 'psu', 'cooling', 'other']))
      .optional()
      .describe('Commodity classes to price. Omit for all hardware classes.'),
    max: z.number().int().min(1).max(30).optional().describe('Cap commodities priced per run.'),
    force: z.boolean().default(false).describe('Re-price even commodities priced recently.'),
  })
  .strict();
type Input = z.infer<typeof InputSchema>;

const OutputSchema = z.object({
  ok: z.boolean(),
  worklist: z.number(),
  recorded: z.number(),
  skipped: z.number(),
  fails: z.number(),
  /** Hits the store's price-plausibility gate refused (misread/decimal-shift class). */
  rejected: z.number(),
  priced: z.array(z.object({ commodity: z.string(), price: z.number() })),
});
type Output = z.infer<typeof OutputSchema>;

function extract_price(s: string): number | null {
  const t = s.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  const n = Number((t.match(/-?\d[\d,]*\.?\d*/)?.[0] ?? '').replace(/,/g, ''));
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function create(deps: ToolDeps): Tool<Input, Output> {
  return {
    name: 'lookup_commodity_market_prices',
    description:
      "BACKGROUND JOB. For each commodity that has an OEM configurator delta (all hardware classes), look up its open-market street/MSRP price and record it as a `standalone` observation — the 'cost beyond the delta'. Surfaced beside each OEM's delta (premium_view + the Recon Desk) so the OEM markup is visible — the signal that tracks the NAND/DRAM/VRAM squeeze. Bounded per run; skips recently-priced commodities; backfills over runs.",
    risk: 'write_internal',
    required_capabilities: ['write_workstation_intel', 'query_web', 'browse_web'],
    weight: 'heavy',
    input_schema: InputSchema,
    output_schema: OutputSchema,

    idempotency_key(input) {
      const c = (input.classes ?? DEFAULT_CLASSES).slice().sort().join(',');
      return `lookup_commodity_market_prices:${c}:${new Date().toISOString().slice(0, 13)}`;
    },

    async execute(input, ctx: ToolContext): Promise<Output> {
      const store = getKristiWorkstationsStore();
      const classes = (input.classes ?? DEFAULT_CLASSES) as CommodityClass[];
      const max = input.max ?? DEFAULT_MAX;
      const now = Date.now();

      const worklist = store.delta_commodities(classes);
      const priced: Array<{ commodity: string; price: number }> = [];
      let recorded = 0;
      let skipped = 0;
      let fails = 0;
      let rejected = 0;
      let ok = true;

      for (const item of worklist) {
        if (recorded >= max) break;
        if (!input.force) {
          const prior = store.latest_standalone(item.commodity);
          if (prior) {
            const age_h = (now - Date.parse(prior.captured_date)) / 3_600_000;
            const limit = STALE_HOURS[item.commodity_class] ?? DEFAULT_STALE_HOURS;
            if (Number.isFinite(age_h) && age_h < limit) { skipped++; continue; }
          }
        }
        const [lo, hi] = BOUNDS[item.commodity_class] ?? BOUNDS.other ?? [10, 60_000];
        let found: { price: number; url: string } | null = null;
        try {
          const sr = await web_search.execute(
            { query: `${item.commodity} price buy`, max_results: 3 },
            ctx,
          );
          for (const r of (sr.results ?? []).slice(0, 2)) {
            if (!r.url) continue;
            const outcome = await fetch_with_browser_fallback(r.url, ctx, { title_fallback: r.title || undefined });
            if (outcome.kind !== 'firecrawl' && outcome.kind !== 'browser') continue;
            const role = deps.llm.for_role('research_extract');
            const resp = await role.provider.complete({
              messages: [
                {
                  role: 'system',
                  content:
                    'Extract the single best CURRENT US retail/street price in USD for EXACTLY this part — the SAME quality of commodity. EVERY discriminator must match: capacity, the storage GENERATION (Gen4 vs Gen5 are different parts), memory SPEED + ECC, and the GPU GENERATION (Ada vs Blackwell are different parts). If the page prices a different capacity / generation / speed / variant, or it is an accessory, bundle, or financing-per-month figure, return 0. Reply with ONLY a number (no $, no commas), or 0 if THIS EXACT part is not clearly priced.',
                },
                { role: 'user', content: `PART: ${item.commodity}\n\nPAGE:\n${outcome.markdown.slice(0, 12_000)}` },
              ],
              max_tokens: 30,
              think: false,
            });
            const price = extract_price(resp.content);
            if (price !== null && price >= lo && price <= hi) {
              found = { price, url: r.url };
              break;
            }
          }
        } catch (err) {
          fails++;
          ok = false;
          continue;
        }
        if (!found) { fails++; continue; }
        const verdict = store.record_commodity_price({
          commodity: item.commodity,
          commodity_class: item.commodity_class,
          vendor: 'other', // market price is vendor-agnostic
          price: found.price,
          price_kind: 'standalone',
          url: found.url,
        });
        if (!verdict.stored) { rejected++; continue; } // store gate: misread/decimal-shift vs the series' own history
        recorded++;
        priced.push({ commodity: item.commodity, price: found.price });
      }

      deps.memory.log_action({
        intent_id: ctx.intent_id,
        agent: ctx.specialist_id ?? 'kristi',
        tool_name: 'lookup_commodity_market_prices',
        tool_input: { classes },
        execution_result: { ok, worklist: worklist.length, recorded, skipped, fails, rejected },
      });

      return { ok, worklist: worklist.length, recorded, skipped, fails, rejected, priced };
    },
  };
}
