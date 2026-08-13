/**
 * drive_configurator — Kristi's per-OEM COMMODITY-price extractor, the one path
 * that reaches what the static `acquire_pricing` job cannot.
 *
 * Per-OEM commodity pricing (what HP vs Dell vs Lenovo each charge to step up
 * the SAME GPU / CPU / RAM / SSD) lives in the vendor CONFIGURATORS — the
 * "Customize and buy" build flows — as AJAX-loaded `+$X` option deltas. Those
 * pages are JS-rendered and bot-walled, so Firecrawl/`web_fetch_clean` can't
 * read them (a plain fetch times out). This drives a REAL warmed Firefox on
 * the workstation via `withBrowserSession` — the same connector `browse_url` uses,
 * but with the one interaction `browse_url` lacks: it clicks the configurator
 * CTA, lets the option matrix render, and reads the priced options out.
 *
 * Design choices that keep it from being brittle (HP's DOM is unseen + churns):
 *   - Interaction is by VISIBLE TEXT (`*=Customize and buy`), never a guessed
 *     CSS/XPath selector. Class churn doesn't break it.
 *   - It does NOT toggle each option and re-read (a long, fragile click loop).
 *     Configurators render the option list with inline `+$X` deltas, so it
 *     scrolls to trigger lazy sections, captures the rendered `innerText`, and
 *     runs ONE bounded LLM pass to lift (component, delta) pairs. Bounded,
 *     no spiral, mirrors the scan_cert_registries render-then-extract pattern.
 *   - HONEST yield: if the render yields 0 priced options, the prices are gated
 *     behind per-option interaction — reported as `options_found: 0` so that
 *     escalation (a v2 click-toggle-read loop) is a data-driven decision, not a
 *     guess. Same philosophy as `acquire_pricing.commodity_oem_coverage`.
 *
 * Proof-of-concept scope: workstation-class machine only (CONFIGURATOR_TARGETS). Extend to
 * Dell/Lenovo by adding targets once the loop is confirmed on the box — it can
 * only be verified against live the workstation (a real Firefox), never from a fetch.
 */
import { z } from 'zod';
import type { Browser } from 'webdriverio';
import type { Tool, ToolContext } from '@core/tool';
import type { ToolDeps } from '@core/tool_deps';
import { withBrowserSession, DeferredError, StaleProfileLockError } from '@connectors/avalanche';
import {
  getKristiWorkstationsStore,
  type Vendor,
  type CommodityClass,
} from '@memory/stores/kristi_workstations';
import { validate_system_price } from '../cost_model';
import { CONFIGURATOR_TARGETS } from '../sources';

const COMMODITY_CLASSES = new Set(['gpu', 'cpu', 'memory', 'storage', 'psu', 'cooling', 'other']);
const PRICE_KINDS = new Set(['addon', 'config_delta', 'standalone', 'included']);
const DELTA_MIN = 0; // an "included" base option is a legitimate $0 delta
const DELTA_MAX = 40_000;
const RENDER_WAIT_MS = 7000; // configurator SPAs paint slowly
const MAX_TEXT = 24_000;

const InputSchema = z
  .object({
    targets: z.array(z.string()).optional().describe('CONFIGURATOR_TARGETS keys to drive. Omit for all (PoC: HP only).'),
    wait_ms: z.number().int().min(1000).max(15_000).optional().describe('Render wait after the configurator opens.'),
  })
  .strict();
type Input = z.infer<typeof InputSchema>;

const TargetResult = z.object({
  key: z.string(),
  vendor: z.string(),
  final_url: z.string(),
  customize_clicked: z.boolean(),
  cta_text_present: z.boolean().default(false), // did the rendered text even contain a configurator CTA phrase?
  cta_candidates: z.array(z.string()).optional(), // actual clickable labels matching a CTA — to debug a missed click
  text_chars: z.number(),
  text_sample: z.string().optional(), // first chars of the rendered text — blind-debug aid
  /** Diagnostic: count + samples of lines carrying a $ amount in the rendered
   *  text. Tells us whether option prices are in the captured DOM (→ extraction
   *  bug) or absent (→ collapsed/async/interaction-gated, the v2 trigger). */
  price_hits: z.number().default(0),
  price_lines: z.array(z.string()).optional(),
  options_found: z.number(),
  recorded: z.number(),
  /** Rows the store's price-plausibility gate refused (misread/decimal-shift class). */
  rejected: z.number().default(0),
  /** Base-unit auto-capture: did this drive record the platform's base config
   *  (price + included commodities) into base_units? */
  base_captured: z.boolean().default(false),
  base_price: z.number().nullable().default(null),
  base_components: z.number().default(0),
  deferred: z.boolean().default(false),
  error: z.string().optional(),
});
const OutputSchema = z.object({
  ok: z.boolean(),
  results: z.array(TargetResult),
  total_recorded: z.number(),
});
type Output = z.infer<typeof OutputSchema>;

/** Isolate the JSON array/object: drop a `<think>` block, strip a fence, slice
 *  to the outermost brackets. */
function strip_fence(s: string): string {
  let t = s.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence && fence[1]) t = fence[1].trim();
  const start = Math.min(
    ...[t.indexOf('['), t.indexOf('{')].filter((i) => i >= 0).concat([Infinity]),
  );
  const end = Math.max(t.lastIndexOf(']'), t.lastIndexOf('}'));
  if (Number.isFinite(start) && end > start) t = t.slice(start, end + 1);
  return t.trim();
}

/** Parse the model's option array, tolerating a TRUNCATED array (a long
 *  configurator overruns max_tokens, leaving the JSON unclosed). First try a
 *  clean parse; on failure, salvage every complete flat `{...}` object the
 *  array did emit — so 95 options minus the truncated tail still records ~94,
 *  not zero. */
function parse_rows(raw: string): Record<string, unknown>[] {
  const cleaned = strip_fence(raw);
  try {
    const p = JSON.parse(cleaned) as unknown;
    if (Array.isArray(p)) return p as Record<string, unknown>[];
    if (Array.isArray((p as { rows?: unknown }).rows)) return (p as { rows: Record<string, unknown>[] }).rows;
  } catch {
    /* fall through to salvage */
  }
  const objs: Record<string, unknown>[] = [];
  for (const m of cleaned.matchAll(/\{[^{}]*\}/g)) {
    try {
      objs.push(JSON.parse(m[0]) as Record<string, unknown>);
    } catch {
      /* skip a partial object */
    }
  }
  return objs;
}

function num(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const n = Number(v.replace(/[^0-9.]/g, ''));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * Ground an LLM-transcribed price against the page's OWN literal $-amounts:
 * accept it only when the captured text shows that amount (±$1). The live
 * failure class this kills: a cents price transcribed without its decimal —
 * Lenovo's "$1,467.84" came back as 146784 (×100) and sailed through the
 * absolute window. If the page shows price/100 instead, the misread
 * self-corrects; otherwise return null — never record a number the page
 * doesn't literally contain. Exported for the smoke.
 */
export function ground_price_to_page(price: number | null, page_text: string): number | null {
  if (price === null || !Number.isFinite(price) || price <= 0) return null;
  const amounts: number[] = [];
  for (const m of page_text.matchAll(/\$\s?(\d[\d,]*(?:\.\d{1,2})?)/g)) {
    const v = Number(m[1]!.replace(/,/g, ''));
    if (Number.isFinite(v) && v > 0) amounts.push(Math.round(v * 100) / 100);
  }
  const near = (x: number): boolean => amounts.some((a) => Math.abs(a - x) <= 1);
  if (near(price)) return price;
  const decimated = Math.round(price) / 100;
  if (near(decimated)) return decimated;
  return null;
}

const SYSTEM =
  'You extract per-component CONFIGURATOR option pricing from the rendered text of an OEM ' +
  '"customize and buy" page. Each configurable component option carries a PRICE DELTA — the ' +
  'add/upgrade cost vs the base build, shown as "+$1,200", "Included", "$0", etc. Pull ONLY ' +
  'GPU / CPU / memory / storage / PSU options that have a readable price (or are explicitly ' +
  'Included/base = 0). NEVER invent a number; skip an option whose price you cannot read. ' +
  'Normalize each component to a canonical name shared across OEMs, ordered MODEL → CAPACITY → ' +
  'SPEED, and ALWAYS keep the discriminator that makes a variant distinct: storage interface ' +
  'GENERATION as "Gen4"/"Gen5" ONLY when the page states the PCIe generation explicitly ("PCIe ' +
  'Gen4", "PCIe 4.0", "Gen 4") — DO NOT infer the generation from a vendor performance-TIER label ' +
  'like Dell\'s "Class 40"/"Class 50" (those are not a reliable PCIe-gen mapping); if only a tier ' +
  'is given and no explicit gen, omit the Gen token rather than guess. GPU GENERATION ("Ada" vs ' +
  '"Blackwell" — an RTX 6000 Ada and RTX PRO 6000 Blackwell are DIFFERENT parts); memory SPEED ' +
  '(DDR5-6400) + ECC. Examples: "NVIDIA RTX PRO 6000 Blackwell", "Intel Xeon w7-3565X", ' +
  '"64GB DDR5-4800 ECC RDIMM", "2TB NVMe Gen4 M.2 SSD". Reply with ' +
  'ONLY a JSON array (no prose, no fence): [{"commodity":"<canonical name>","commodity_class":' +
  '"gpu|cpu|memory|storage|psu|other","price":<delta number USD; 0 if Included/base>,' +
  '"price_kind":"config_delta|included"}]. If the text shows NO priced component options ' +
  '(prices are hidden until you select something), return [].';

export function create(deps: ToolDeps): Tool<Input, Output> {
  return {
    name: 'drive_configurator',
    description:
      "BACKGROUND JOB. Drive an OEM 'Customize and buy' configurator in a real warmed Firefox on the workstation (the JS/bot-walled per-component price source `acquire_pricing` can't reach), clicking the configurator CTA by visible text, letting the option matrix render, and lifting per-component PRICE DELTAS into commodity_prices (price_kind config_delta) via one bounded LLM pass. This is THE source of genuine per-OEM commodity pricing. PoC: workstation-class machine. Reports options_found so a 0-yield render (prices gated behind interaction) is visible.",
    risk: 'write_internal',
    required_capabilities: ['browse_web', 'write_workstation_intel'],
    weight: 'heavy',
    input_schema: InputSchema,
    output_schema: OutputSchema,

    idempotency_key(input) {
      const t = (input.targets ?? CONFIGURATOR_TARGETS.map((c) => c.key)).slice().sort().join(',');
      return `drive_configurator:${t}:${new Date().toISOString().slice(0, 13)}`;
    },

    async execute(input, ctx: ToolContext): Promise<Output> {
      const store = getKristiWorkstationsStore();
      const agent = ctx.specialist_id ?? 'kristi';
      const wait_ms = input.wait_ms ?? RENDER_WAIT_MS;
      const wanted = new Set(input.targets ?? CONFIGURATOR_TARGETS.map((c) => c.key));
      const targets = CONFIGURATOR_TARGETS.filter((t) => wanted.has(t.key));
      const results: z.infer<typeof TargetResult>[] = [];
      let total_recorded = 0;
      let ok = true;

      for (const target of targets) {
        const r: z.infer<typeof TargetResult> = {
          key: target.key,
          vendor: target.vendor,
          final_url: target.pdp_url,
          customize_clicked: false,
          cta_text_present: false,
          text_chars: 0,
          price_hits: 0,
          options_found: 0,
          recorded: 0,
          rejected: 0,
          base_captured: false,
          base_price: null,
          base_components: 0,
          deferred: false,
        };
        try {
          // ── render the configurator in Kristi's warmed Firefox on the workstation ──
          const captured = await withBrowserSession(
            { agent, taskId: ctx.intent_id },
            async (browser) => {
              // ── reach a VALIDATED PDP, retrying warm+PDP on a bot wall ──────
              // Session-warming (visit OEM home, mouse-move + dwell, settle
              // consent) carries a natural in-site history + a real sensor score
              // to the bot-walled targets. Akamai's sensor is PROBABILISTIC: a
              // warmed session sometimes still 403s on the first PDP hit, then
              // passes on a retry as the sensor accumulates behavior — so the
              // warmed (home_url) targets retry the warm+PDP a few times. Cold
              // targets (HP/Lenovo) aren't walled, so they load first try.
              const BOT_WALL = /access denied|reference #\d|you don't have permission|you have been blocked|akamai|pardon the interruption|are you a human|verify you are human/i;
              const max_attempts = target.home_url ? 3 : 1;
              for (let attempt = 1; ; attempt++) {
                if (target.home_url) await warm_session(browser, target.home_url, wait_ms, target.warm_via);
                await browser.url(target.pdp_url);
                // Let the SPA fully paint BEFORE looking for the CTA.
                await sleep(wait_ms);
                const ttl = await browser.getTitle().catch(() => '');
                const probe = await (await browser.$('body')).getText().catch(() => '');
                if (!BOT_WALL.test(ttl) && !BOT_WALL.test(probe.slice(0, 600))) break;
                if (attempt >= max_attempts) break; // give up; downstream stamps bot_wall
                await sleep(1800);
              }
              // Best-effort: dismiss a cookie/consent overlay that would eat clicks.
              await dismiss_consent(browser);
              await sleep(600);

              const STRONG = /customize|configure|build your own|build your pc|view (all )?config/i;
              const WEAK = /add to cart|select|shop now/i;
              const cta_candidates: string[] = [];
              let clicked = false;
              // eslint-disable-next-line @typescript-eslint/no-explicit-any -- resolved WebdriverIO element handle
              let toClick: any = null;
              const handles_before = (await browser.getWindowHandles().catch(() => [])).length;
              const url_before = await browser.getUrl().catch(() => '');

              // A `cta_selector` targets a configurator-entry element the
              // visible-text scan can't reach — Dell's "Build your own" is a
              // `<div role="link" data-redirect-url=…>` card whose text exceeds
              // the scan's length cap and which isn't an a/button. Click it
              // directly (real pointer click navigates to the configurator; the
              // JS fallback below covers a click that doesn't take).
              if (target.cta_selector) {
                try {
                  const el = await browser.$(target.cta_selector);
                  if (await el.isExisting().catch(() => false)) {
                    cta_candidates.push(`[cta_selector:${target.cta_selector}]`);
                    await el.scrollIntoView().catch(() => {});
                    await el.click().catch(() => {});
                    toClick = el;
                    clicked = true;
                  }
                } catch {
                  /* selector best-effort */
                }
              }

              // Find + click the configurator CTA by SCANNING real clickable
              // elements and matching their visible text — NOT geckodriver's
              // partial-link-text (`*=`) strategy, which throws "too much
              // recursion" on huge DOMs. Strong CTAs (customize/configure/build)
              // win over weak ones (add-to-cart/select). Skipped once a
              // cta_selector already clicked. The scan doubles as cta_candidates.
              if (!clicked) {
                try {
                  const els = await browser.$$('a, button, [role="button"]');
                  const seen = new Set<string>();
                  let scanned = 0;
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  let strongEl: any = null;
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  let weakEl: any = null;
                  for (const el of els) {
                    if (scanned >= 220) break;
                    scanned++;
                    const t = (await el.getText().catch(() => '')).trim().replace(/\s+/g, ' ');
                    if (!t || t.length > 40) continue;
                    const isStrong = STRONG.test(t);
                    const isWeak = !isStrong && WEAK.test(t);
                    if (!isStrong && !isWeak) continue;
                    if (!seen.has(t) && cta_candidates.length < 12) { seen.add(t); cta_candidates.push(t); }
                    if (isStrong && !strongEl) strongEl = el;
                    else if (isWeak && !weakEl) weakEl = el;
                  }
                  toClick = strongEl ?? weakEl;
                  if (toClick) {
                    await toClick.scrollIntoView().catch(() => {});
                    await toClick.click().catch(() => {});
                    clicked = true;
                  }
                } catch {
                  /* scan/click best-effort — never abort the run on a selector error */
                }
              }
              const cta_text_present = cta_candidates.length > 0;
              if (clicked) {
                await sleep(wait_ms);
                // The CTA may open the configurator in a NEW tab — switch to the
                // newest window so we capture the configurator, not the PDP.
                let handles = await browser.getWindowHandles().catch(() => []);
                let newest = handles[handles.length - 1];
                if (handles.length > handles_before && newest) {
                  await browser.switchToWindow(newest).catch(() => {});
                  await sleep(2000);
                } else if (toClick && (await browser.getUrl().catch(() => '')) === url_before) {
                  // The real-pointer click registered but DIDN'T navigate — some
                  // CTAs (verified: Lenovo's "Build Your PC" → /configurator/cto/)
                  // only act on a DOM-dispatched click, not WebdriverIO's
                  // synthetic pointer event. Re-dispatch via JS and re-check for a
                  // same-tab nav or a new tab. (HP/Dell navigate on the pointer
                  // click, so they don't reach this branch.)
                  await browser.execute('arguments[0] && arguments[0].click()', toClick).catch(() => {});
                  await sleep(wait_ms);
                  handles = await browser.getWindowHandles().catch(() => []);
                  newest = handles[handles.length - 1];
                  if (handles.length > handles_before && newest) {
                    await browser.switchToWindow(newest).catch(() => {});
                    await sleep(2000);
                  }
                }
              }
              // Trigger lazy-loaded option sections, then capture the rendered
              // visible text via the same getText() browse_url uses. PROGRESSIVE
              // scroll (not a single jump to the bottom): some configurators
              // render the option matrix as a MID-PAGE lazy section keyed to
              // viewport intersection (verified on the box: Dell's Precision PDP
              // exposes its priced config under an in-page #configure-anchor, not
              // a separate configurator page like HP). A straight jump to the
              // bottom can skip past such a section without ever triggering it;
              // stepping through the page height fires every intersection
              // observer on the way down. String-form execute keeps the DOM
              // globals out of this Bun/Node tsconfig.
              for (const frac of [0.2, 0.45, 0.7, 0.95, 1]) {
                await browser.execute(`window.scrollTo(0, document.body.scrollHeight * ${frac})`).catch(() => {});
                await sleep(900);
              }
              const body = await browser.$('body');
              const text = await body.getText().catch(() => '');
              const final_url = await browser.getUrl().catch(() => target.pdp_url);
              return { clicked, cta_text_present, cta_candidates, text: String(text ?? ''), final_url };
            },
          );

          if (captured === undefined) {
            // onDeferred not passed → unreachable, but the union forces handling.
            r.deferred = true;
            results.push(r);
            continue;
          }

          r.customize_clicked = captured.clicked;
          r.cta_text_present = captured.cta_text_present;
          r.cta_candidates = captured.cta_candidates;
          r.final_url = captured.final_url;
          r.text_chars = captured.text.length;
          r.text_sample = captured.text.slice(0, 300);
          // Diagnostic: pair each $ amount with its adjacent COMPONENT label
          // (HP renders the name on the line above the price), skipping promo
          // chrome — so the signal is "what the option is" → "what it costs".
          const price_re = /\$\s?\d[\d,]{2,}/;
          const chrome_re = /save up to|flash sale|financing|% off|care pack|free shipping|subtotal|estimated total|^total$/i;
          const pairs: string[] = [];
          let label = '';
          for (const raw of captured.text.split('\n')) {
            const l = raw.trim();
            if (!l) continue;
            if (price_re.test(l)) {
              if (!chrome_re.test(l)) pairs.push(`${label} :: ${l}`.slice(0, 140));
            } else if (!chrome_re.test(l) && l.length > 2 && l.length < 90) {
              label = l; // candidate component name for the next price line
            }
          }
          r.price_hits = pairs.length;
          r.price_lines = [...new Set(pairs)].slice(0, 20);

          if (/access denied|reference #\d|you don't have permission|you have been blocked|akamai|pardon the interruption|are you a human|verify you are human/i.test(captured.text)) {
            r.error = 'bot_wall: the site blocked the automated browser (e.g. Akamai "Access Denied")';
            ok = false;
            results.push(r);
            continue;
          }
          if (captured.text.trim().length < 200) {
            r.error = 'configurator rendered empty/too short (bot wall or render miss)';
            ok = false;
            results.push(r);
            continue;
          }

          // ── bounded extraction pass over the rendered option text ──
          // A configurator can list ~100 priced options, so the JSON array is
          // large — give it room and salvage-parse so a truncated array still
          // yields every complete option object.
          //
          // Resilience: the full-page pass (24K chars) is the proven path (it
          // yields 60-70 options on HP) but on a busy LIVE tier it sometimes
          // TIMES OUT mid-stream and returns nothing (observed 2026-06-03: a
          // render with 100 priced lines extracted 0 because the LLM call timed
          // out). When the page clearly HAS priced lines but the full pass came
          // back empty or threw, retry over the COMPACT priced-line block we
          // already extracted — a fraction of the input, so the call is fast and
          // far less likely to time out, and the model only has to normalize
          // names + classes rather than hunt prices out of page chrome.
          const role = deps.llm.for_role('research_extract');
          const header = `OEM: ${target.vendor.toUpperCase()} — ${target.label}\nConfigurator URL: ${captured.final_url}\n\n`;
          const extract = async (body: string): Promise<Record<string, unknown>[]> => {
            const resp = await role.provider.complete({
              messages: [
                { role: 'system', content: SYSTEM },
                { role: 'user', content: header + body },
              ],
              max_tokens: 4000,
              think: false,
            });
            return parse_rows(resp.content);
          };

          let rows: Record<string, unknown>[] = [];
          let extract_err = '';
          try {
            rows = await extract(`RENDERED TEXT:\n${captured.text.slice(0, MAX_TEXT)}`);
          } catch (e) {
            extract_err = e instanceof Error ? e.message : String(e);
          }
          if (rows.length === 0 && pairs.length > 0) {
            const compact = [...new Set(pairs)].slice(0, 220).join('\n').slice(0, MAX_TEXT);
            try {
              rows = await extract(`PRICED OPTION LINES (component :: price delta):\n${compact}`);
              if (rows.length > 0) extract_err = ''; // fallback recovered it
            } catch (e) {
              if (!extract_err) extract_err = e instanceof Error ? e.message : String(e);
            }
          }
          r.options_found = rows.length;
          // Surface a still-empty extraction as an error so the run reads ok:false
          // and the failure is diagnosable, instead of a silent 0-recorded "ok".
          if (rows.length === 0 && extract_err) {
            r.error = `extraction failed: ${extract_err}`;
            ok = false;
          }

          for (const row of rows) {
            try {
              const commodity = String(row.commodity ?? '').trim();
              const price = num(row.price);
              if (!commodity || price === null || price < DELTA_MIN || price > DELTA_MAX) continue;
              const cls = String(row.commodity_class ?? 'other');
              const kind = String(row.price_kind ?? 'config_delta');
              const verdict = store.record_commodity_price({
                commodity: commodity.slice(0, 120),
                commodity_class: (COMMODITY_CLASSES.has(cls) ? cls : 'other') as CommodityClass,
                vendor: target.vendor as Vendor,
                model_id: target.model_id,
                price,
                price_kind: PRICE_KINDS.has(kind) ? kind : 'config_delta',
                url: captured.final_url,
              });
              if (!verdict.stored) { r.rejected++; continue; }
              r.recorded++;
            } catch {
              /* skip a malformed row */
            }
          }
          total_recorded += r.recorded;

          // ── BASE-UNIT auto-capture (2026-06-10) ────────────────────────────
          // The base config is right here on the page we just rendered: the
          // 'Included'/$0 options ARE the default components, and the running
          // 'starting at' total is the base price. Capturing it deterministically
          // is what feeds base_unit_view + cost_outlook — before this, recording
          // a base unit relied on deliberation judgment and the table sat empty.
          // Best-effort: a failed capture never fails the options run.
          try {
            const included = rows
              .filter((row) => {
                const kind = String(row.price_kind ?? '');
                const price = num(row.price);
                const cls = String(row.commodity_class ?? '');
                return (
                  (kind === 'included' || price === 0) &&
                  ['cpu', 'gpu', 'memory', 'storage'].includes(cls) &&
                  String(row.commodity ?? '').trim().length > 0
                );
              })
              .map((row) => ({
                commodity_class: String(row.commodity_class) as CommodityClass,
                commodity: String(row.commodity).trim().slice(0, 120),
              }));
            const base_resp = await deps.llm.for_role('research_extract').provider.complete({
              messages: [
                {
                  role: 'system',
                  content:
                    'You read the rendered text of an OEM workstation configurator. Find the BASE configured PRICE — ' +
                    'the current total/“starting at” price for the DEFAULT configuration as shown, before any upgrades ' +
                    '(if both a struck-through list price and a current price show, use the CURRENT price). ' +
                    'Reply with ONLY the number in USD (no $, no commas), or 0 if no base price is readable.',
                },
                { role: 'user', content: captured.text.slice(0, 16_000) },
              ],
              max_tokens: 30,
              think: false,
            });
            // Ground the transcription to the page's own $-amounts (the live
            // Lenovo run read "$1,467.84" as 146784 — ×100 — without this).
            const base_price = ground_price_to_page(
              num(base_resp.content.replace(/<think>[\s\S]*?<\/think>/gi, '')),
              captured.text,
            );
            if (base_price !== null && validate_system_price(base_price).ok) {
              store.record_base_unit({
                model_id: target.model_id,
                vendor: target.vendor as Vendor,
                base_config_price: base_price,
                base_components: included,
                confidence: included.length >= 2 ? 'medium' : 'low',
                note:
                  'auto-captured from the configurator render (default/Included options as base components)' +
                  (included.length === 0 ? ' — no included components readable; residual = full base price' : ''),
                source_url: captured.final_url,
              });
              // The base price is also a price OBSERVATION — feed the daily
              // series so discount-over-time + the residual's history exist.
              store.record_price({
                model_id: target.model_id,
                config_label: 'base',
                segment: 'prosumer',
                list_price: base_price,
                sale_price: null,
                url: captured.final_url,
              });
              r.base_captured = true;
              r.base_price = base_price;
              r.base_components = included.length;
            }
          } catch {
            /* base capture is opportunistic — options already recorded */
          }
        } catch (err) {
          if (err instanceof DeferredError) {
            r.deferred = true;
            r.error = `deferred: ${err.reason.reason}`;
          } else if (err instanceof StaleProfileLockError) {
            r.error = err.message;
            ok = false;
          } else {
            r.error = err instanceof Error ? err.message : String(err);
            ok = false;
          }
        }
        results.push(r);
      }

      deps.memory.log_action({
        intent_id: ctx.intent_id,
        agent,
        tool_name: 'drive_configurator',
        tool_input: { targets: [...wanted] },
        execution_result: { ok, total_recorded, results },
      });

      return { ok, results, total_recorded };
    },
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

const CONSENT_RE = /^(accept all( cookies)?|accept cookies|accept|agree|i agree|got it|allow all)$/i;

/** Dismiss a cookie/consent overlay by SCANNING real clickable elements and
 *  matching their visible text — NOT geckodriver's `*=` partial-link-text
 *  strategy, which throws "too much recursion" on huge DOMs like Dell's. Bounded
 *  + best-effort; returns whether something was clicked. */
async function dismiss_consent(browser: Browser): Promise<boolean> {
  try {
    const els = await browser.$$('button, a, [role="button"]');
    let scanned = 0;
    for (const el of els) {
      if (scanned >= 120) break;
      scanned++;
      const t = (await el.getText().catch(() => '')).trim().replace(/\s+/g, ' ');
      if (!t || t.length > 30 || !CONSENT_RE.test(t)) continue;
      await el.scrollIntoView().catch(() => {});
      await el.click().catch(() => {});
      return true;
    }
  } catch {
    /* best-effort — a selector/recursion error here must never abort the run */
  }
  return false;
}

/** A few human-paced mouse moves via the W3C Actions API. Akamai's sensor
 *  weights REAL mouse movement heavily — a scroll-only session still reads as a
 *  bot (verified: adding these moves took Dell's PDP from intermittent to
 *  reliable). Best-effort; coordinates are viewport-relative. */
async function human_mouse(browser: Browser, moves: Array<[number, number]>): Promise<void> {
  try {
    const actions = moves.flatMap(([x, y]) => [
      { type: 'pointerMove' as const, duration: 350, x, y },
      { type: 'pause' as const, duration: 160 },
    ]);
    await browser.performActions([
      { type: 'pointer', id: 'mouse', parameters: { pointerType: 'mouse' }, actions },
    ]);
    await browser.releaseActions().catch(() => {});
  } catch {
    /* actions best-effort */
  }
}

/** Warm the session against an OEM home before the PDP: land, settle consent,
 *  move the mouse + dwell at human pace (jittered scroll + pauses), then visit
 *  an in-site page. Builds the behavioral signal an Akamai-style sensor needs to
 *  mint its trust cookie, so the protected PDP/configurator loads instead of
 *  403-ing. Bounded so it can't spiral. */
async function warm_session(browser: Browser, home_url: string, wait_ms: number, via?: string): Promise<void> {
  try {
    await browser.url(home_url);
    await sleep(Math.min(wait_ms, 4000)); // initial paint + bot-wall sensor boot
    await dismiss_consent(browser);
    // Real mouse movement (the sensor's highest-signal behavioral input) +
    // progressive scroll so the sensor (the `_abck`/`sbsd` cookies start INVALID
    // and only validate after enough behavior) validates BEFORE the protected
    // PDP. Verified on the box: a scroll-only or fast hop still 403s; mouse +
    // ~12s dwell lets the Dell PDP load.
    await human_mouse(browser, [[180, 220], [520, 360], [800, 500], [360, 640]]);
    for (const y of [700, 1500, 2400]) {
      await browser.execute(`window.scrollTo(0, ${y})`).catch(() => {});
      await sleep(1200 + Math.floor(Math.random() * 1100));
      await human_mouse(browser, [[400 + Math.floor(Math.random() * 300), 300 + Math.floor(Math.random() * 300)]]);
    }
    // One intermediate IN-SITE navigation (e.g. the workstations category) before
    // the PDP — a real visitor browses a category, not a cold deep link. This
    // measurably improved Dell PDP reliability on the box.
    if (via) {
      await browser.url(via).catch(() => {});
      await sleep(Math.min(wait_ms, 5000));
      await human_mouse(browser, [[300, 260], [700, 440], [900, 600]]);
      await browser.execute('window.scrollTo(0, 900)').catch(() => {});
      await sleep(1500 + Math.floor(Math.random() * 800));
    }
    await browser.execute('window.scrollTo(0, 0)').catch(() => {});
    await sleep(1000 + Math.floor(Math.random() * 600));
  } catch {
    /* warming is best-effort; fall through to the PDP regardless */
  }
}
