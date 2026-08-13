/**
 * Kristi's discovery manifest — SEED QUERIES, not hardcoded deep links.
 *
 * Vendor/spec/cert pages move and 404 (HP's `/z-desktops.html` was already
 * dead on day one), so a static URL list rots. Instead `scan_sources` runs
 * these queries through SearXNG (`web_search`), takes the top current results,
 * and ingests them via the Firecrawl→the workstation fallback — self-healing against
 * URL churn. Adding coverage is a one-line query here; no parser, no URL upkeep.
 *
 * Kristi's deliberation is ALSO search-first (see her prelude): she uses
 * web_search scoped to trusted_sources, web_fetch_clean to pull, and browse_url
 * (the workstation) for JS-rendered / bot-blocked pages. This manifest just seeds the
 * automated sweep.
 *
 * Cert registries get model-strings via `scan_cert_registries`, which renders
 * each listing through the workstation (`browse_url`) — they're JS SPAs, so a plain
 * fetch returns chrome, not data — and diffs the certified model strings.
 */

import type { CertRegistry } from '@memory/stores/kristi_workstations';

export type SourceCategory = 'vendor' | 'nvidia' | 'benchmark' | 'isv' | 'frontier' | 'analyst';

export interface SeedQuery {
  query: string; // SearXNG query; use site: to scope to a trusted domain
  category: SourceCategory;
  /**
   * Coverage bucket for FAIR interleaving in `scan_sources`. The sweep has a
   * bounded per-run ingest budget; without buckets it drains the array in order
   * (HP-desktop first) and starves the tail (Lenovo / MWS / entry tier). The
   * scan round-robins across buckets so one run spreads across vendors+classes.
   * Vendor seeds tag `<vendor>-<class>` (e.g. 'lenovo-desktop'); others default
   * to their category.
   */
  bucket?: string;
}

/**
 * Discovery queries. Scoped with `site:` to the authoritative domain where the
 * canonical spec page lives; SearXNG honors Google-style operators. The scan
 * fetches the top current hits, so a vendor reorganizing its site self-heals.
 */
export const SEED_QUERIES: SeedQuery[] = [
  // ── DESKTOP workstations — towers / SFF / mini (DTWS) ─────────────────────
  // Discover by vendor + product LINE + class — NEVER enumerate specific model
  // numbers or generations. Enumerated SKUs go stale (a query pinned to a gen
  // can't find its successor), bias discovery toward what we already know, and
  // miss net-new models — the opposite of intel work. The scan lands on the
  // vendor's current lineup pages; `acquire_quickspecs` then fetches the spec
  // sheet per model SHE discovers. Discover broad, fetch specific.
  { query: 'HP Z desktop workstation tower SFF lineup specifications QuickSpecs site:hp.com', category: 'vendor', bucket: 'hp-desktop' },
  { query: 'HP Z entry desktop workstation tower SFF mini specifications QuickSpecs site:hp.com', category: 'vendor', bucket: 'hp-desktop' },
  { query: 'Dell Pro Precision tower workstation lineup specifications site:dell.com', category: 'vendor', bucket: 'dell-desktop' },
  { query: 'Dell Precision tower workstation lineup specifications site:dell.com', category: 'vendor', bucket: 'dell-desktop' },
  { query: 'Dell Precision entry tower SFF workstation specifications site:dell.com', category: 'vendor', bucket: 'dell-desktop' },
  { query: 'Lenovo ThinkStation tower SFF Tiny workstation lineup specifications site:lenovo.com', category: 'vendor', bucket: 'lenovo-desktop' },
  { query: 'Lenovo ThinkStation Tiny P3 SFF small form factor workstation PSREF specifications site:lenovo.com', category: 'vendor', bucket: 'lenovo-desktop' },
  // ── MOBILE workstations (MWS) ─────────────────────────────────────────────
  { query: 'HP ZBook mobile workstation lineup specifications QuickSpecs site:hp.com', category: 'vendor', bucket: 'hp-mobile' },
  { query: 'Lenovo ThinkPad P series mobile workstation PSREF specifications site:lenovo.com', category: 'vendor', bucket: 'lenovo-mobile' },
  { query: 'Dell Precision mobile workstation OR Pro Max laptop specifications site:dell.com', category: 'vendor', bucket: 'dell-mobile' },
  // ── RACK workstations (RWS) ───────────────────────────────────────────────
  { query: 'Dell Precision rack workstation specifications site:dell.com', category: 'vendor', bucket: 'dell-rack' },
  { query: 'HP Z rack-mount workstation OR Lenovo ThinkStation rack specifications', category: 'vendor', bucket: 'hp-rack' },
  // Prior-generation lineage — needed to PROJECT the next gen. Discover the
  // line's previous generations by line+class (don't pin a gen suffix); the
  // verified per-gen lineage comes from her own store (lookup_workstation +
  // compare_configs), not a hardcoded gen list.
  { query: 'HP Z desktop workstation previous generation specifications site:hp.com', category: 'vendor' },
  { query: 'Dell Precision tower workstation previous generation specifications site:dell.com', category: 'vendor' },
  { query: 'Lenovo ThinkStation previous generation workstation specifications site:lenovo.com', category: 'vendor' },
  // ── NVIDIA — pro graphics + ARM/DGX disruption vectors ────────────────────
  { query: 'NVIDIA RTX PRO Blackwell desktop workstation GPU specifications site:nvidia.com', category: 'nvidia' },
  { query: 'NVIDIA DGX Spark GB10 Grace Blackwell specifications site:nvidia.com', category: 'nvidia' },
  { query: 'NVIDIA workstation GPU announcement 2026', category: 'nvidia' },
  // ── benchmarks / independent measurement ──────────────────────────────────
  { query: 'PassMark high end CPU benchmark chart Xeon W Threadripper Pro', category: 'benchmark' },
  { query: 'Threadripper Pro vs Xeon W workstation CPU benchmark review', category: 'benchmark' },
  { query: 'workstation review HP Z Dell Precision Lenovo ThinkStation 2026 site:servethehome.com', category: 'benchmark' },
  { query: 'entry workstation comparison HP Z vs Dell Precision vs Lenovo ThinkStation 2026', category: 'benchmark' },
  // ── ISV certified-hardware surfaces (AEC / M&E / PD&M / etc.) ──────────────
  { query: 'Autodesk certified hardware workstation graphics list', category: 'isv' },
  { query: 'SOLIDWORKS certified graphics cards hardware site:solidworks.com', category: 'isv' },
  { query: 'Siemens NX PTC Creo certified hardware workstation GPU', category: 'isv' },
  // ── frontier — workstation-adjacent threats/disruptors + net-new players ───
  { query: 'NVIDIA N1X ARM workstation agentic ISV support announcement', category: 'frontier' },
  { query: 'Windows on ARM workstation professional ISV application support 2026', category: 'frontier' },
  { query: 'NVIDIA DGX Spark GB10 desktop AI vs workstation', category: 'frontier' },
  { query: 'cloud workstation virtual workstation AWS Azure NVIDIA Omniverse vs desktop', category: 'frontier' },
  { query: 'BOXX Puget Systems Maingear workstation desktop specifications', category: 'frontier' },
  { query: 'Lambda Exxact Velocity Micro AI workstation builder', category: 'frontier' },
  // ── frontier — edge-AI inference accelerators: DISCOVER the field, don't wait
  //    for it. Independent inference silicon (FPGAs / ASICs / NPUs, PCIe/M.2
  //    add-in cards) beyond NVIDIA's DGX/IGX/N1X line, AND its applicability to
  //    workstation AI-dev / agentic workflows. Field-discovering, NOT a fixed
  //    vendor list — name a few only to seed the search; Kristi uncovers the rest.
  { query: 'inference accelerator startup FPGA ASIC LLM edge AI silicon 2026', category: 'frontier' },
  { query: 'AI inference chip PCIe M.2 add-in card workstation local LLM accelerator', category: 'frontier' },
  { query: 'transformer LLM inference ASIC dedicated silicon emerging vs GPU', category: 'frontier' },
  { query: 'Hailo Tenstorrent Groq Etched Taalas inference accelerator workstation card review', category: 'frontier' },
  { query: 'AI accelerator chip software stack llama.cpp ONNX runtime developer support workstation', category: 'frontier' },
  { query: 'next-gen inference silicon FPGA NPU agentic workflow on-device LLM 2026', category: 'frontier' },
  // ── analyst / market intelligence — the DEMAND-side, market-DIRECTION signal ─
  //    Public analyst output + reputable market coverage that says where the
  //    workstation market is HEADED (TAM, forecast/CAGR, segment share, demand
  //    drivers) — the input to Kristi's MARKET-PULL projections. IDC/Gartner FULL
  //    reports are paywalled and NOT scraped; these queries target their PUBLIC
  //    output (press releases, free trackers, blogs, vendor-cited figures) plus
  //    secondary coverage. Analyst figures are DIRECTIONAL (a forecast/methodology,
  //    not a measured spec) — tag them so when you record from them. Search-first
  //    by topic, never a pinned report URL (those rot behind paywalls/redesigns).
  { query: 'IDC worldwide workstation market tracker forecast press release', category: 'analyst' },
  { query: 'Gartner workstation market forecast blog professional workstation', category: 'analyst' },
  { query: 'workstation market forecast 2026 CAGR TAM size segment', category: 'analyst' },
  { query: 'professional workstation market share vendor HP Dell Lenovo IDC', category: 'analyst' },
  { query: 'mobile workstation market growth forecast demand drivers 2026', category: 'analyst' },
  { query: 'AI workstation demand local LLM inference market forecast analyst', category: 'analyst' },
  { query: 'workstation market trends edge AI inference accelerator forecast site:nextplatform.com', category: 'analyst' },
  { query: 'professional visualization workstation GPU market forecast analyst report summary', category: 'analyst' },
];

/**
 * Price-discovery queries for `acquire_pricing`. SPEC queries (SEED_QUERIES)
 * surface the machine; these surface its PRICE — the pages that actually carry
 * dollars: reseller listings (CDW / Insight / Newegg Business), vendor
 * "configure / starting at" pages, configurator option matrices, and
 * as-configured reviews. Search-first for the same reason: a saved price URL
 * rots, but the query self-heals. `mixed` queries chase per-component pricing
 * across OEMs — where a genuine commodity SPREAD forms — and are ALWAYS run
 * regardless of the vendor scope. Adding coverage is a one-line query here.
 */
export type PriceVendor = 'hp' | 'dell' | 'lenovo' | 'mixed';

export interface PriceQuery {
  query: string;
  vendor: PriceVendor;
}

export const PRICE_QUERIES: PriceQuery[] = [
  // ── HP Z — vendor configure pages + resellers ─────────────────────────────
  { query: 'HP Z6 G5 workstation configure price site:hp.com', vendor: 'hp' },
  { query: 'HP Z4 G5 workstation price CDW OR Insight', vendor: 'hp' },
  { query: 'workstation-class machine workstation price Newegg OR CDW', vendor: 'hp' },
  // ── Dell Precision — vendor configure pages + resellers ───────────────────
  { query: 'Dell Precision 7875 tower configure price site:dell.com', vendor: 'dell' },
  { query: 'Dell Precision 5860 tower workstation price CDW OR Insight', vendor: 'dell' },
  { query: 'Dell Pro Precision tower workstation price buy', vendor: 'dell' },
  // ── Lenovo ThinkStation — vendor configure pages + resellers ──────────────
  { query: 'Lenovo ThinkStation P7 workstation configure price site:lenovo.com', vendor: 'lenovo' },
  { query: 'Lenovo ThinkStation PX workstation price CDW OR Insight', vendor: 'lenovo' },
  { query: 'Lenovo ThinkStation P5 P620 workstation price Newegg OR CDW', vendor: 'lenovo' },
  // ── entry tier — so the apples-to-apples price series reaches Z1/Z2 + rivals ─
  { query: 'HP Z1 Z2 G10 entry workstation price CDW OR Insight', vendor: 'hp' },
  { query: 'Dell Pro Max Tower T2 Slim Micro entry workstation price CDW OR Newegg', vendor: 'dell' },
  { query: 'Dell Precision 3680 tower entry workstation price CDW OR Newegg', vendor: 'dell' },
  { query: 'Lenovo ThinkStation P3 Tower entry workstation price configure CDW', vendor: 'lenovo' },
  // ── cross-OEM commodity / option pricing (where the per-OEM spread forms) ──
  { query: 'RTX PRO 6000 Blackwell workstation configurator upgrade option price Dell HP Lenovo', vendor: 'mixed' },
  { query: 'NVIDIA RTX 4000 Ada workstation configure add option price', vendor: 'mixed' },
  { query: 'workstation configurator GPU memory upgrade option price RTX PRO Ada CDW', vendor: 'mixed' },
];

/**
 * Configurator targets for `drive_configurator` — the OEM "Customize and buy"
 * build flows where per-component PRICE DELTAS live (AJAX-loaded, JS/bot-walled,
 * so a plain fetch can't read them; they need a real browser on the workstation).
 * This is the only place that genuinely yields per-OEM commodity pricing — what
 * HP vs Dell vs Lenovo each charge to step up the SAME part. Driven by visible
 * text (the customize CTA), not brittle selectors, so it survives class churn.
 * Start: workstation-class machine (proof-of-concept); add Dell/Lenovo once the pattern holds.
 */
export interface ConfiguratorTarget {
  key: string; // stable id, e.g. 'hp-z8-fury-g6i'
  vendor: 'hp' | 'dell' | 'lenovo';
  model_id: string; // platform tag recorded on each commodity row
  label: string;
  /** OEM home/landing URL. When set, drive_configurator WARMS the session by
   *  visiting it first (dismiss consent, human-paced dwell) BEFORE the PDP, so
   *  the request to the bot-walled configurator carries a natural in-site
   *  navigation history + a settled consent cookie instead of a cold deep hit.
   *  Set it for targets behind an aggressive bot wall (Dell/Akamai); omit for
   *  OEMs whose plain PDP path already works (HP). */
  home_url?: string;
  /** Optional intermediate in-site URL to visit during warming (e.g. the
   *  workstations category) before the PDP — a real visitor browses a category,
   *  not a cold deep link. Measurably improves Akamai PDP reliability. */
  warm_via?: string;
  /** Optional CSS selector for the configurator-entry element when it is NOT a
   *  visible-text a/button the scan can match — e.g. Dell's "Build your own" is
   *  a `<div role="link" data-redirect-url=…>` card. When set, the driver clicks
   *  this element to open the configurator instead of (before) the text scan. */
  cta_selector?: string;
  pdp_url: string; // the customizable product page
  /** Visible-text variants of the CTA that opens the configurator from the PDP
   *  (matched with WebdriverIO `*=` partial text). First match wins; if none is
   *  found the PDP itself is captured (it may already show option pricing). */
  customize_text: string[];
}

export const CONFIGURATOR_TARGETS: ConfiguratorTarget[] = [
  {
    key: 'hp-z8-fury-g6i',
    vendor: 'hp',
    model_id: 'hp-z8-fury-g6i',
    label: 'workstation-class machine Workstation',
    pdp_url:
      'https://www.hp.com/us-en/shop/pdp/hp-z8-fury-g6i-workstation-desktop-pc-customizable-b52wlav-mb',
    customize_text: ['Customize and buy', 'Customize & buy', 'Customize'],
  },
  {
    key: 'dell-precision-7960',
    vendor: 'dell',
    model_id: 'dell-precision-7960',
    label: 'Dell Precision 7960 Tower Workstation',
    // Dell DIRECT per-component pricing — CRACKED 2026-06-03. The configurator
    // is behind Akamai's stricter `sbsd` tier, which mints its trust cookie from
    // a STABLE, REAL gpu/canvas hash. Two things unlock it (both shipped):
    //   1. agentd disables Firefox Fingerprinting Protection so our genuine
    //      RTX-PRO-4000 fingerprint shows (not the sanitized fake GPU + noisy
    //      canvas) — see ops/agentd/source/src/sessions.ts.
    //   2. warming with REAL mouse movement (Actions API) + an in-site category
    //      visit builds the sensor score; the driver retries the PDP on a 403.
    // Then the "Build your own" card — a `<div role="link" data-redirect-url=…>`
    // (NOT an a/button, text too long for the visible-text scan) — is clicked via
    // `cta_selector`; its real-pointer click navigates to the configurator, which
    // renders the FULL per-component matrix (verified: 225 "+$" deltas,
    // +$569 … +$9,369). Akamai stays probabilistic, so a run can still 403 out;
    // the bot-wall retry + daily schedule absorb that.
    home_url: 'https://www.dell.com/en-us/',
    warm_via: 'https://www.dell.com/en-us/shop/dell-workstations/scr/workstations',
    cta_selector: '[data-redirect-url]',
    pdp_url:
      'https://www.dell.com/en-us/shop/desktop-computers/precision-7960-tower-workstation/spd/precision-t7960-workstation',
    customize_text: ['Customize & Buy', 'Customize and Buy', 'Configure & Buy', 'Configure', 'Customize'],
  },
  {
    key: 'lenovo-thinkstation-p8',
    vendor: 'lenovo',
    model_id: 'lenovo-thinkstation-p8',
    label: 'Lenovo ThinkStation P8 Workstation',
    // Lenovo's flagship Threadripper PRO tower — direct rival to the HP Z8 Fury
    // G6i and Dell Precision 7960 already targeted. Verified on the box
    // (2026-06-03): lenovo.com is NOT bot-walled (home/PDP load cold), and the
    // PDP's "Build Your PC" CTA navigates (same tab) to the CTO configurator
    // (/configurator/cto/?bundleId=…) which renders the FULL per-component option
    // matrix — 46 "+$" deltas on first capture (+$255 … +$25,210 across CPU /
    // GPU / memory / storage). Standard-DOM CTA (matched by the STRONG regex's
    // new "build your pc" term), not shadow-DOM like Dell — no warming needed, so
    // no home_url. The configurator opens in-session; the progressive scroll then
    // renders the matrix for the bounded extraction pass.
    pdp_url:
      'https://www.lenovo.com/us/en/p/workstations/thinkstation-p-series/thinkstation-p8-workstation/len102s0017',
    customize_text: ['Build Your PC', 'Build your PC', 'Customize', 'Configure'],
  },
  // ── ENTRY desktop lane (2026-06-10) — where the discount + GeForce games are
  // sharpest, and where commodity pricing / base units had ZERO coverage. Each
  // reuses its OEM's proven pattern above (HP plain PDP; Dell warm + redirect
  // card; Lenovo standard-DOM CTA). URLs verified live 2026-06-10.
  {
    key: 'hp-z2-tower-g1i',
    vendor: 'hp',
    model_id: 'hp-z2-tower-g1i',
    label: 'HP Z2 Tower G1i Workstation',
    pdp_url:
      'https://www.hp.com/us-en/shop/pdp/hp-z2-tower-g1i-workstation-desktop-pc-customizable-b04f0av-mb',
    customize_text: ['Customize and buy', 'Customize & buy', 'Customize'],
  },
  // Dell's CURRENT entry workstation tower — the renamed Precision 3680
  // (Core Ultra "Pro Max Tower T2", FCT2250; NOT the Xeon-W Pro Precision 9
  // T2). Daily target; the outgoing 3680 below runs weekly for its discount
  // endgame. URL verified live 2026-06-10.
  {
    key: 'dell-pro-max-tower-t2',
    vendor: 'dell',
    model_id: 'dell-pro-max-tower-t2',
    label: 'Dell Pro Max Tower T2 Workstation',
    home_url: 'https://www.dell.com/en-us/',
    warm_via: 'https://www.dell.com/en-us/shop/dell-workstations/scr/workstations',
    cta_selector: '[data-redirect-url]',
    pdp_url:
      'https://www.dell.com/en-us/shop/desktop-computers/dell-pro-max-tower-t2-desktop/spd/dell-pro-max-fct2250-desktop',
    customize_text: ['Customize & Buy', 'Customize and Buy', 'Configure & Buy', 'Configure', 'Customize'],
  },
  {
    key: 'dell-precision-3680',
    vendor: 'dell',
    model_id: 'dell-precision-3680',
    label: 'Dell Precision 3680 Tower Workstation',
    home_url: 'https://www.dell.com/en-us/',
    warm_via: 'https://www.dell.com/en-us/shop/dell-workstations/scr/workstations',
    cta_selector: '[data-redirect-url]',
    pdp_url:
      'https://www.dell.com/en-us/shop/desktop-computers/precision-3680-tower-workstation/spd/precision-t3680-workstation',
    customize_text: ['Customize & Buy', 'Customize and Buy', 'Configure & Buy', 'Configure', 'Customize'],
  },
  {
    key: 'lenovo-thinkstation-p3-tower',
    vendor: 'lenovo',
    model_id: 'lenovo-thinkstation-p3-tower-gen-2',
    label: 'Lenovo ThinkStation P3 Tower Gen 2 Workstation',
    pdp_url:
      'https://www.lenovo.com/us/en/p/workstations/thinkstation-p-series/lenovo-thinkstation-p3-tower-gen-2-intel-workstation/len102s0019',
    customize_text: ['Build Your PC', 'Build your PC', 'Customize', 'Configure'],
  },
  // ── MOBILE lane (first MWS configurator target). Lenovo first — least
  // bot-walled, same proven PDP → "Build Your PC" CTO pattern as the P8/P3.
  {
    key: 'lenovo-thinkpad-p16',
    vendor: 'lenovo',
    model_id: 'lenovo-thinkpad-p16-gen-3',
    label: 'Lenovo ThinkPad P16 Gen 3 Mobile Workstation',
    pdp_url:
      'https://www.lenovo.com/us/en/p/laptops/thinkpad/thinkpadp/lenovo-thinkpad-p16-gen-3-16-inch-intel-mobile-workstation/len101t0147',
    customize_text: ['Build Your PC', 'Build your PC', 'Customize', 'Configure'],
  },
];

export interface CertRegistrySource {
  registry: CertRegistry;
  url: string;
  label: string;
  /** Regex source strings (case-insensitive) matching watched model
   *  nomenclatures. A match not already in the store is a new leak. Tune as
   *  vendors introduce new naming. */
  patterns: string[];
  /** Optional: map a lowercased matched-string substring → a vendor guess. */
  vendor_hints?: Array<{ contains: string; vendor: string }>;
  /** ms to wait after navigation for the SPA to render its results before
   *  scraping text (these finders fetch their listings client-side). */
  wait_ms?: number;
  /** SearXNG terms to search WITHIN this registry's domain. The most reliable
   *  leak signal: a cert page's URL/title carries the model string (DMTF puts
   *  it right in the path, e.g. /certifications/dell-pro-precision-9-t6-pw9t6260),
   *  and SearXNG surfaces those individual pages even when the SPA listing
   *  doesn't render scrapable rows. Each is run as `site:<domain> <query>`. */
  search_queries?: string[];
}

/**
 * Certification / regulatory registries. They publish certified model
 * identifiers BEFORE retail launch — the highest-value early-warning signal
 * (e.g. the Dec-2025 DMTF listing `dell-pro-precision-9-t6-pw9t6260`). All are
 * JS SPAs, so `scan_cert_registries` renders each via the workstation (browse_url)
 * with a wait, then diffs the certified model strings out of the rendered text.
 */
// Nomenclature now spans all four workstation classes — DESKTOP (DTWS), MOBILE
// (MWS), RACK (RWS), and EDGE-AI. Each matched string is tagged with its class
// downstream via `ws_class_from_nomenclature` (ThinkPad/ZBook = mobile,
// ThinkStation/Z = desktop, "…Rack" = rack, DGX/IGX = edge-ai), so the leak
// radar can be segmented by class. Patterns are matched case-insensitively
// against the lowercased URL+title / rendered text.
export const CERT_REGISTRY_SOURCES: CertRegistrySource[] = [
  {
    registry: 'dmtf',
    url: 'https://registry.dmtf.org/certifications/',
    label: 'DMTF Redfish certification registry',
    wait_ms: 5000,
    patterns: [
      // DTWS — desktop towers
      'dell-pro-precision-9-t[246][a-z0-9-]*', // Dell Pro Precision 9 T2/T4/T6
      'precision-\\d{4}[a-z0-9-]*', // legacy Dell Precision tower/rack codes (rack tagged by class)
      'pw\\d?t\\d{3,}', // Dell internal chassis codes (e.g. pw9t6260)
      'hp-z[0-9]+[a-z0-9-]*', // HP Z towers
      'thinkstation-p[a-z0-9-]+', // Lenovo ThinkStation PX/P-series
      'dell-pro-max[a-z0-9-]*', // Dell's 2025 "Pro Max" workstation branding
      // MWS — mobile workstations
      'hp-zbook[a-z0-9-]*', // HP ZBook (Fury / Power / Studio / Firefly / Ultra)
      'thinkpad-p[a-z0-9-]+', // Lenovo ThinkPad P-series mobile WS
      // EDGE-AI — DGX / IGX appliances
      'dgx-[a-z0-9-]+',
      'nvidia-igx[a-z0-9-]*',
    ],
    vendor_hints: [
      { contains: 'dell', vendor: 'dell' },
      { contains: 'precision', vendor: 'dell' },
      { contains: 'pro-max', vendor: 'dell' },
      { contains: 'hp-z', vendor: 'hp' },
      { contains: 'zbook', vendor: 'hp' },
      { contains: 'thinkstation', vendor: 'lenovo' },
      { contains: 'thinkpad', vendor: 'lenovo' },
      { contains: 'dgx', vendor: 'nvidia' },
      { contains: 'igx', vendor: 'nvidia' },
    ],
    search_queries: [
      'dell pro precision tower',
      'dell precision rack',
      'dell pro max workstation',
      'hp z workstation',
      'hp zbook mobile workstation',
      'lenovo thinkstation',
      'lenovo thinkpad p mobile workstation',
      'nvidia dgx',
    ],
  },
  {
    registry: 'energystar',
    url: 'https://www.energystar.gov/productfinder/product/certified-computers/results',
    label: 'ENERGY STAR certified computers',
    wait_ms: 6000,
    patterns: [
      // DTWS / RWS (rack tagged by class)
      'precision\\s+\\d{4}[a-z0-9 -]*',
      '\\bZ[0-9]\\s?G[0-9]+[a-z0-9 -]*', // HP Z G-series (e.g. Z4 G5)
      'thinkstation\\s+p[a-z0-9 -]+',
      'pro\\s?max[a-z0-9 -]*', // Dell Pro Max (mobile/desktop; class disambiguates)
      // MWS — mobile (ENERGY STAR's certified-computers list includes notebooks)
      'zbook[a-z0-9 -]*',
      'thinkpad\\s+p[a-z0-9 -]+',
    ],
    vendor_hints: [
      { contains: 'precision', vendor: 'dell' },
      { contains: 'pro max', vendor: 'dell' },
      { contains: 'zbook', vendor: 'hp' },
      { contains: 'thinkstation', vendor: 'lenovo' },
      { contains: 'thinkpad', vendor: 'lenovo' },
    ],
    search_queries: [
      'Dell Precision tower certified',
      'Dell Precision rack certified',
      'HP Z workstation certified',
      'HP ZBook mobile workstation certified',
      'Lenovo ThinkStation certified',
      'Lenovo ThinkPad P workstation certified',
    ],
  },
  {
    registry: 'tco',
    url: 'https://tcocertified.com/product-finder/?category=Desktops',
    label: 'TCO Certified desktops',
    wait_ms: 6000,
    patterns: [
      'precision\\s+\\d{4}[a-z0-9 -]*',
      'elite\\s?tower\\s+\\d{3}[a-z0-9 -]*',
      '\\bZ[0-9]\\s?G[0-9]+[a-z0-9 -]*',
      'thinkstation\\s+p[a-z0-9 -]+',
      'pro\\s?max[a-z0-9 -]*',
    ],
    vendor_hints: [
      { contains: 'precision', vendor: 'dell' },
      { contains: 'pro max', vendor: 'dell' },
      { contains: 'elite', vendor: 'hp' },
      { contains: 'thinkstation', vendor: 'lenovo' },
    ],
    search_queries: [
      'Dell Precision desktop',
      'HP Z Tower desktop',
      'Lenovo ThinkStation desktop',
    ],
  },
  {
    // MWS — TCO certifies notebooks separately; this is the mobile-workstation lane.
    registry: 'tco',
    url: 'https://tcocertified.com/product-finder/?category=Notebooks',
    label: 'TCO Certified notebooks (mobile workstations)',
    wait_ms: 6000,
    patterns: [
      'zbook[a-z0-9 -]*', // HP ZBook
      'thinkpad\\s+p[a-z0-9 -]+', // Lenovo ThinkPad P mobile WS
      'precision\\s+\\d{4}[a-z0-9 -]*', // Dell Precision mobile (4-digit)
      'pro\\s?max[a-z0-9 -]*', // Dell Pro Max mobile
    ],
    vendor_hints: [
      { contains: 'zbook', vendor: 'hp' },
      { contains: 'thinkpad', vendor: 'lenovo' },
      { contains: 'precision', vendor: 'dell' },
      { contains: 'pro max', vendor: 'dell' },
    ],
    search_queries: [
      'HP ZBook mobile workstation',
      'Lenovo ThinkPad P mobile workstation',
      'Dell Precision mobile workstation',
    ],
  },
];
