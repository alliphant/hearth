/**
 * seed-source-racks — author the initial per-specialist source racks
 * (knowledge metabolism #5, 2026-06-10).
 *
 * Writes 4–8 authoritative Tier-1/2 SOURCE SUBSCRIPTIONS per specialist
 * into Knowledge/Cordelia/sources.md (sources_store), each with a
 * sensible refresh cadence, stamped `seeded_by: fable-5-2026-06-10`, and
 * a human-scannable summary note at
 * Knowledge/Cordelia/seeded-racks-2026-06-10.md so Jasper can prune.
 *
 * Primary-source bias throughout: government / professional-body /
 * publisher-of-record / vendor-of-record domains first; independent
 * high-quality secondaries (Tier 2) where the primary doesn't publish a
 * crawlable surface. Cadences: weekly for news/recall/calendar surfaces,
 * monthly for evolving reference, quarterly for stable documentation.
 *
 * Idempotent: keyed on URL (re-running refreshes metadata, never
 * duplicates, never resets crawl state). NOTE the store keys one entry
 * per URL globally, so a URL belongs to exactly ONE specialist's rack —
 * the seed data keeps them disjoint.
 *
 *   bun run seed:source-racks            # apply
 *   bun run seed:source-racks --dry-run  # print without writing
 *
 * Honors HEARTH_VAULT_ROOT (default ~/vault-friday) and HEARTH_DB_PATH
 * (default ./data/hearth.db). On the LLM host, run inside the container:
 *   docker compose exec hearth-orchestrator bun run seed:source-racks
 */
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { open_db } from '@memory/stores/structured';
import { MemoryClient } from '@memory/client';
import {
  read_sources,
  upsert_source,
  write_sources,
  type SubscriptionCadence,
} from '@specialists/cordelia/sources_store';

export const SEEDED_BY = 'fable-5-2026-06-10';
export const SUMMARY_PATH = 'Knowledge/Cordelia/seeded-racks-2026-06-10.md';

export interface SeedSource {
  specialist_id: string;
  url: string;
  tier: 1 | 2;
  cadence: SubscriptionCadence;
  description: string;
  tags: string[];
  /** 'browser' = the workstation signed-in Firefox from the start (paywalled). */
  fetch_via?: 'browser';
  /** News Desk word-cloud grouping key ('world', 'ai', 'gaming', …). */
  category?: string;
}

/**
 * URLs this seeder previously planted that production proved wrong —
 * nav-shell landing pages the quality gate rejects (their hash is
 * recorded, so they never retry: permanent dead weight) or hard
 * bot-blocks. `apply_seeds` REMOVES them, but only when the entry still
 * carries our `seeded_by` stamp — a hand-edited entry at the same URL
 * is Jasper's and survives. Replacements (content-bearing pages on the
 * same authority) live in SEEDS.
 */
export const RETIRED_URLS: string[] = [
  // 2026-06-10 production validation: all 31 rejected as nav_chrome by
  // the capture quality gate on the first full refresh burn.
  'https://afdc.energy.gov/fuels/electricity',
  'https://catvets.com/guidelines',
  'https://cmg.extension.colostate.edu/',
  'https://driveelectric.gov/',
  'https://esphome.io/changelog/',
  'https://extension.colostate.edu/topic-areas/yard-garden/',
  'https://icatcare.org/advice/',
  'https://nvidianews.nvidia.com/',
  'https://planttalk.colostate.edu/',
  'https://wsava.org/global-guidelines/',
  'https://www.aggietheatre.com/',
  'https://www.avma.org/news',
  'https://www.cdc.gov/physical-activity-basics/',
  'https://www.consumerfinance.gov/about-us/newsroom/',
  'https://www.citygov.com/council/',
  'https://www.citygov.com/gardens/',
  'https://www.citygov.com/news/',
  'https://www.citygov.com/utilities/residential/',
  'https://www.citygov.com/utilities/residential/rates/',
  'https://www.fda.gov/animal-veterinary/safety-health/recalls-withdrawals',
  'https://www.federalreserve.gov/newsevents/pressreleases.htm',
  'https://www.hp.com/us-en/workstations.html',
  'https://www.irs.gov/newsroom',
  'https://www.nsca.com/education/articles/',
  'https://www.physio-pedia.com/home/',
  'https://www.pugetsystems.com/labs/articles/',
  'https://www.redrocksonline.com/events/',
  'https://www.rhs.org.uk/advice',
  'https://www.servethehome.com/',
  'https://www.strongerbyscience.com/articles/',
  'https://www.themishawaka.com/',
  // Second validation round (2026-06-10): pages whose RAW HTML carries
  // prose but whose Firecrawl extraction yields nav-shell — gate-
  // rejected. Real fix is the gate-rejection → browser-extraction
  // retry (board epic); retired until then.
  'https://afdc.energy.gov/fuels/electricity-basics',
  'https://wsava.org/global-guidelines/global-nutrition-guidelines/',
  'https://www.irs.gov/newsroom/news-releases-for-current-month',
  // 2026-06-10 news-rack verification: AP public RSS is dead (63-char shell).
  'https://apnews.com/index.rss',
];

export const SEEDS: SeedSource[] = [
  // Production-validated 2026-06-10: the full 53-seed rack was burned
  // through the live refresh pipeline the night it shipped; 31 seeds
  // were nav-shell landing pages the quality gate rejected (hash
  // recorded → permanent dead weight) and moved to RETIRED_URLS below.
  // What remains is every seed that actually SHELVED, plus replacements
  // verified content-rich before seeding. Racks are deliberately lean —
  // scout_sources + curate_for_specialist grow them from here; a
  // subscription must be a CHANGING content surface, not a menu.

  // ── kate — world/national news rack (2026-06-10, owner-approved) ──
  // The 07:00 morning brief is the consumption point: daily-cadence
  // feeds shelve headline+abstract snapshots onto Kate's library so the
  // brief grounds in real reporting. Vantage-diversified on purpose:
  // US wire + US/UK/German public broadcasters + Gulf + two papers.
  // BBC/NPR-world/Al Jazeera verified live; the rest pipeline-verify on
  // first refresh (any shell/dead feed self-reports as a rejection).
  { specialist_id: 'kate', url: 'https://feeds.bbci.co.uk/news/world/rss.xml', tier: 1, cadence: 'daily', category: 'world', description: 'BBC News world RSS — UK public broadcaster wire', tags: ['news', 'world', 'rss'] },
  { specialist_id: 'kate', url: 'https://feeds.npr.org/1004/rss.xml', tier: 1, cadence: 'daily', category: 'world', description: 'NPR world news RSS', tags: ['news', 'world', 'rss'] },
  { specialist_id: 'kate', url: 'https://feeds.npr.org/1001/rss.xml', tier: 1, cadence: 'daily', category: 'national', description: 'NPR top news RSS — US/national', tags: ['news', 'national', 'rss'] },
  // (AP: no working public RSS — apnews.com/index.rss returns an empty
  //  shell; like Reuters, the wire reaches Kate via BBC/NPR/Guardian.)
  { specialist_id: 'kate', url: 'https://www.aljazeera.com/xml/rss/all.xml', tier: 2, cadence: 'daily', category: 'world', description: 'Al Jazeera English RSS — Gulf/Global-South vantage', tags: ['news', 'world', 'rss'] },
  { specialist_id: 'kate', url: 'https://www.theguardian.com/world/rss', tier: 2, cadence: 'daily', category: 'world', description: 'Guardian world RSS — free, no paywall', tags: ['news', 'world', 'rss'] },
  { specialist_id: 'kate', url: 'https://rss.dw.com/rdf/rss-en-world', tier: 1, cadence: 'daily', category: 'world', description: 'Deutsche Welle English world RSS — German public broadcaster', tags: ['news', 'world', 'rss'] },
  { specialist_id: 'kate', url: 'https://rss.nytimes.com/services/xml/rss/nyt/World.xml', tier: 2, cadence: 'daily', category: 'world', description: 'NYT World RSS — headlines + abstracts (free tier)', tags: ['news', 'world', 'rss', 'nyt'] },
  // Full-article NYT: rides the signed-in the workstation Firefox profile.
  // Until Jasper logs that profile into nytimes.com, this shelves the
  // logged-out section page (or gate-rejects) — harmless, self-reports.
  { specialist_id: 'kate', url: 'https://www.nytimes.com/section/world', tier: 2, cadence: 'daily', fetch_via: 'browser', category: 'world', description: 'NYT World section via signed-in browser — full ledes with the household subscription', tags: ['news', 'world', 'nyt', 'browser'] },

  // ── kate — News Desk topical feeds (owner-chosen, 2026-06-10) ─────
  // Word-cloud categories beyond world/national. RSS-first (the feed
  // fast path parses them into news_items headlines); every feed
  // pipeline-verifies on first refresh and self-reports if dead.
  // State politics — progressive lens per the owner's ask.
  { specialist_id: 'kate', url: 'https://feeds.texastribune.org/feeds/main/', tier: 1, cadence: 'daily', category: 'texas-politics', description: 'Texas Tribune — nonprofit TX politics/policy of record', tags: ['news', 'texas', 'rss'] },
  { specialist_id: 'kate', url: 'https://www.texasobserver.org/feed/', tier: 2, cadence: 'daily', category: 'texas-politics', description: 'Texas Observer — progressive TX investigative', tags: ['news', 'texas', 'rss'] },
  { specialist_id: 'kate', url: 'https://coloradonewsline.com/feed/', tier: 2, cadence: 'daily', category: 'colorado', description: 'Colorado Newsline — States Newsroom CO politics', tags: ['news', 'colorado', 'rss'] },
  { specialist_id: 'kate', url: 'https://www.propublica.org/feeds/propublica/main', tier: 2, cadence: 'daily', category: 'national', description: 'ProPublica — nonprofit investigative journalism', tags: ['news', 'national', 'rss'] },
  { specialist_id: 'kate', url: 'https://www.motherjones.com/feed/', tier: 2, cadence: 'daily', category: 'national', description: 'Mother Jones — progressive national investigative', tags: ['news', 'national', 'rss'] },
  // AI + tech.
  { specialist_id: 'kate', url: 'https://techcrunch.com/category/artificial-intelligence/feed/', tier: 2, cadence: 'daily', category: 'ai', description: 'TechCrunch AI vertical', tags: ['news', 'ai', 'rss'] },
  { specialist_id: 'kate', url: 'https://simonwillison.net/atom/everything/', tier: 2, cadence: 'daily', category: 'ai', description: 'Simon Willison — the working-engineer AI/LLM weblog', tags: ['news', 'ai', 'rss'] },
  { specialist_id: 'kate', url: 'https://feeds.arstechnica.com/arstechnica/index', tier: 2, cadence: 'daily', category: 'tech', description: 'Ars Technica — long-form tech journalism', tags: ['news', 'tech', 'rss'] },
  { specialist_id: 'kate', url: 'https://www.theverge.com/rss/index.xml', tier: 2, cadence: 'daily', category: 'tech', description: 'The Verge — consumer tech news', tags: ['news', 'tech', 'rss'] },
  { specialist_id: 'kate', url: 'https://news.ycombinator.com/rss', tier: 2, cadence: 'daily', category: 'tech', description: 'Hacker News front page', tags: ['news', 'tech', 'rss'] },
  // Gaming.
  { specialist_id: 'kate', url: 'https://www.eurogamer.net/feed', tier: 2, cadence: 'daily', category: 'gaming', description: 'Eurogamer — games journalism', tags: ['news', 'gaming', 'rss'] },
  { specialist_id: 'kate', url: 'https://www.gamesindustry.biz/feed', tier: 2, cadence: 'daily', category: 'gaming', description: 'GamesIndustry.biz — the industry trade', tags: ['news', 'gaming', 'rss'] },
  // Ubiquiti/UniFi — no public RSS; the releases page is a JS app, so it
  // rides the signed-in the workstation browser weekly.
  { specialist_id: 'kate', url: 'https://community.ui.com/releases', tier: 1, cadence: 'weekly', fetch_via: 'browser', category: 'unifi', description: 'UniFi release announcements (browser-rendered)', tags: ['news', 'unifi', 'browser'] },
  // Apple.
  { specialist_id: 'kate', url: 'https://www.apple.com/newsroom/rss-feed.rss', tier: 1, cadence: 'daily', category: 'apple', description: 'Apple Newsroom — announcements of record', tags: ['news', 'apple', 'rss'] },
  { specialist_id: 'kate', url: 'https://9to5mac.com/feed/', tier: 2, cadence: 'daily', category: 'apple', description: '9to5Mac — Apple news + rumors', tags: ['news', 'apple', 'rss'] },
  // Entertainment (Plex taste boost floats matches — see news_desk.ts).
  { specialist_id: 'kate', url: 'https://variety.com/feed/', tier: 2, cadence: 'daily', category: 'entertainment', description: 'Variety — the entertainment trade of record', tags: ['news', 'entertainment', 'rss'] },
  { specialist_id: 'kate', url: 'https://www.avclub.com/rss', tier: 2, cadence: 'daily', category: 'entertainment', description: 'The A.V. Club — TV/film criticism + news', tags: ['news', 'entertainment', 'rss'] },
  // Science + space.
  { specialist_id: 'kate', url: 'https://www.nature.com/nature.rss', tier: 1, cadence: 'daily', category: 'science', description: 'Nature — research highlights + news feed', tags: ['news', 'science', 'rss'] },
  { specialist_id: 'kate', url: 'https://www.quantamagazine.org/feed/', tier: 2, cadence: 'daily', category: 'science', description: 'Quanta Magazine — deep math/physics/biology features', tags: ['news', 'science', 'rss'] },
  { specialist_id: 'kate', url: 'https://www.nasa.gov/rss/dyn/breaking_news.rss', tier: 1, cadence: 'daily', category: 'space', description: 'NASA breaking news RSS', tags: ['news', 'space', 'rss'] },
  { specialist_id: 'kate', url: 'https://spacenews.com/feed/', tier: 2, cadence: 'daily', category: 'space', description: 'SpaceNews — the space-industry trade', tags: ['news', 'space', 'rss'] },
  // Security.
  { specialist_id: 'kate', url: 'https://krebsonsecurity.com/feed/', tier: 2, cadence: 'daily', category: 'security', description: 'Krebs on Security — breach/fraud investigative', tags: ['news', 'security', 'rss'] },
  { specialist_id: 'kate', url: 'https://www.bleepingcomputer.com/feed/', tier: 2, cadence: 'daily', category: 'security', description: 'BleepingComputer — vulns, ransomware, patches', tags: ['news', 'security', 'rss'] },

  // ── ruby — Pleasantville civic ─────────────────────────────────────
  { specialist_id: 'ruby', url: 'https://engage.citygov.com/', tier: 1, cadence: 'monthly', description: 'OurCity public-engagement portal — open projects and comment windows', tags: ['civic', 'engagement'] },
  { specialist_id: 'ruby', url: 'https://www.county.gov/bocc', tier: 1, cadence: 'monthly', description: 'your county County Board of Commissioners — county-level decisions', tags: ['civic', 'county'] },
  { specialist_id: 'ruby', url: 'https://www.herald.com/news/', tier: 2, cadence: 'weekly', description: 'Herald local news desk (paper of record, secondary source)', tags: ['civic', 'news'] },
  { specialist_id: 'ruby', url: 'https://coloradosun.com/feed/', tier: 2, cadence: 'daily', category: 'colorado', description: 'Colorado Sun RSS — nonprofit statewide news (between local civic and world)', tags: ['civic', 'colorado', 'rss'] },
  // (citygov.com/news + /council retired as nav-shells; Ruby's own
  //  scan_council_meetings background job covers the council beat.)

  // ── vivian — finance / household docs ─────────────────────────────
  { specialist_id: 'vivian', url: 'https://www.sec.gov/news/pressreleases', tier: 1, cadence: 'weekly', description: 'SEC press releases — enforcement and rulemaking of record', tags: ['finance', 'sec'] },
  { specialist_id: 'vivian', url: 'https://www.federalreserve.gov/feeds/press_all.xml', tier: 1, cadence: 'weekly', description: 'Federal Reserve all-press RSS — rate decisions and policy, feed form', tags: ['finance', 'fed', 'rss'] },
  { specialist_id: 'vivian', url: 'https://www.bogleheads.org/wiki/Main_Page', tier: 2, cadence: 'quarterly', description: 'Bogleheads wiki — evidence-based personal-finance reference', tags: ['finance', 'reference'] },
  // Vivian's Market Radar news rail (2026-06-12) — daily feeds behind
  // the fuel office's second tab (categories markets + ai-business are
  // what /api/specialists/:id/market_radar reads; they also surface on
  // Kate's cross-rack News Desk cloud by design). Dailies ride
  // Cordelia's separate news budget and are EXEMPT from the
  // reference-rack cap/ratio (see smoke-seed-racks). All feed-shaped,
  // verified live 2026-06-12.
  { specialist_id: 'vivian', url: 'https://www.cnbc.com/id/20910258/device/rss/rss.html', tier: 2, cadence: 'daily', category: 'markets', description: 'CNBC Markets RSS — market-moving headlines wire', tags: ['finance', 'markets', 'rss'] },
  { specialist_id: 'vivian', url: 'https://feeds.content.dowjones.io/public/rss/mw_topstories', tier: 2, cadence: 'daily', category: 'markets', description: 'MarketWatch top stories RSS — Dow Jones market wire', tags: ['finance', 'markets', 'rss'] },
  { specialist_id: 'vivian', url: 'https://finance.yahoo.com/news/rssindex', tier: 2, cadence: 'daily', category: 'markets', description: 'Yahoo Finance news RSS — broad market and single-name coverage', tags: ['finance', 'markets', 'rss'] },
  // (TechCrunch AI deliberately NOT seeded here — Kate's News Desk
  //  already owns that URL under category `ai`, and a URL belongs to
  //  exactly ONE rack; the radar rail reads category `ai` cross-rack.)
  { specialist_id: 'vivian', url: 'https://venturebeat.com/category/ai/feed/', tier: 2, cadence: 'daily', category: 'ai-business', description: 'VentureBeat AI RSS — enterprise AI adoption and vendor moves', tags: ['ai', 'business', 'rss'] },
  { specialist_id: 'vivian', url: 'https://www.datacenterknowledge.com/rss.xml', tier: 2, cadence: 'daily', category: 'ai-business', description: 'Data Center Knowledge RSS — datacenter buildout, power, capacity', tags: ['datacenters', 'ai', 'rss'] },

  // (anya — veterinary — folded into Kate 2026-07-04; her seed sources
  //  were dropped with the specialist. Kate scouts vet references on
  //  demand for the domain she now owns.)

  // ── eleanor — gardening / horticulture ────────────────────────────
  // Every the clinic surface (extension hub, PlantTalk, Master Gardener,
  // Gardens on Mill Creek) renders as a nav-shell — retired. Iowa
  // State's land-grant yard & garden hub publishes dated prose monthly
  // (continental-climate parallel per persona guidance). the clinic reference
  // material reaches her shelf via acquire/curate instead.
  { specialist_id: 'eleanor', url: 'https://yardandgarden.extension.iastate.edu/', tier: 1, cadence: 'monthly', description: 'Iowa State Extension Yard & Garden — dated land-grant articles (climate-parallel)', tags: ['garden', 'landgrant'] },

  // ── astrid — fitness / physio ─────────────────────────────────────
  { specialist_id: 'astrid', url: 'https://examine.com/', tier: 2, cadence: 'monthly', description: 'Examine — independent supplement/nutrition evidence synthesis', tags: ['fitness', 'evidence'] },
  // SBS bot-blocks plain fetchers; the refresh escalates via the workstation.
  { specialist_id: 'astrid', url: 'https://www.strongerbyscience.com/feed/', tier: 2, cadence: 'monthly', description: 'Stronger by Science RSS — research-grounded strength training analysis', tags: ['fitness', 'strength', 'rss'] },

  // ── brigid — food / cooking (all five shelved first pass) ─────────
  { specialist_id: 'brigid', url: 'https://www.foodsafety.gov/recalls-and-outbreaks', tier: 1, cadence: 'weekly', description: 'Federal food recalls and outbreak notices', tags: ['food', 'safety'] },
  { specialist_id: 'brigid', url: 'https://www.fsis.usda.gov/recalls', tier: 1, cadence: 'weekly', description: 'USDA FSIS meat/poultry recall list', tags: ['food', 'safety'] },
  { specialist_id: 'brigid', url: 'https://nchfp.uga.edu/', tier: 1, cadence: 'quarterly', description: 'National Center for Home Food Preservation — canning/preserving authority', tags: ['food', 'preservation'] },
  { specialist_id: 'brigid', url: 'https://extension.colostate.edu/topic-areas/nutrition-food-safety-health/', tier: 1, cadence: 'monthly', description: 'the clinic Extension nutrition & food safety — regional + altitude adjustments', tags: ['food', 'csu'] },
  { specialist_id: 'brigid', url: 'https://www.seriouseats.com/', tier: 2, cadence: 'weekly', description: 'Serious Eats — technique-driven, tested recipe journalism', tags: ['food', 'technique'] },

  // ── kristi — workstation market intel ─────────────────────────────
  { specialist_id: 'kristi', url: 'https://news.lenovo.com/', tier: 1, cadence: 'monthly', category: 'workstations', description: 'Lenovo newsroom — ThinkStation/ThinkPad P launches', tags: ['workstations', 'lenovo'] },
  { specialist_id: 'kristi', url: 'https://www.dell.com/en-us/dt/corporate/newsroom.htm', tier: 1, cadence: 'monthly', category: 'workstations', description: 'Dell Technologies newsroom — Precision launches and refreshes', tags: ['workstations', 'dell'] },
  { specialist_id: 'kristi', url: 'https://www.servethehome.com/feed/', tier: 2, cadence: 'daily', category: 'workstations', description: 'ServeTheHome RSS — independent workstation/server hardware reviews, feed form', tags: ['workstations', 'reviews', 'rss'] },

  // ── maggie — live music / venues (FoCo + Denver) ──────────────────
  // Venue-site calendars (Midtown, Riverbend, Red Rocks) are JS shells;
  // the two aggregators + Washington's cover the same shows in prose.
  { specialist_id: 'maggie', url: 'https://www.washingtonsfoco.com/events/', tier: 1, cadence: 'weekly', description: "Washington's FoCo — venue calendar of record", tags: ['music', 'venue', 'foco'] },
  { specialist_id: 'maggie', url: 'https://do303.com/', tier: 2, cadence: 'weekly', description: 'DO303 — Denver/Front Range show listings aggregator (covers Red Rocks etc.)', tags: ['music', 'listings'] },
  { specialist_id: 'maggie', url: 'https://www.visitpleasantville.com/events/', tier: 2, cadence: 'weekly', description: 'Visit Pleasantville events calendar — city-wide happenings', tags: ['music', 'events', 'foco'] },

  // (iris — EV / charging / home automation — folded into Kate
  //  2026-07-04; her seed sources were dropped with the specialist.)

  // ── anna — your county property / utilities ───────────────────────────
  { specialist_id: 'anna', url: 'https://www.county.gov/assessor', tier: 1, cadence: 'monthly', description: 'your county County Assessor — valuations, protest windows, schedules', tags: ['property', 'assessor'] },
  { specialist_id: 'anna', url: 'https://www.county.gov/treasurer', tier: 1, cadence: 'quarterly', description: 'your county County Treasurer — tax billing and due dates', tags: ['property', 'tax'] },
  { specialist_id: 'anna', url: 'https://cdola.colorado.gov/property-taxation', tier: 1, cadence: 'quarterly', description: 'Colorado DOLA Division of Property Taxation — statewide rules and rates (bot-blocked; fetches via the the workstation escalation)', tags: ['property', 'colorado'] },
];

function build_summary(applied: Array<{ seed: SeedSource; action: string }>): string {
  const by_spec = new Map<string, Array<{ seed: SeedSource; action: string }>>();
  for (const a of applied) {
    const list = by_spec.get(a.seed.specialist_id) ?? [];
    list.push(a);
    by_spec.set(a.seed.specialist_id, list);
  }
  const lines: string[] = [
    '# Seeded source racks — 2026-06-10',
    '',
    `Initial per-specialist SOURCE SUBSCRIPTIONS authored by Claude (\`${SEEDED_BY}\`)`,
    'and written into [[sources]] (Knowledge/Cordelia/sources.md). Primary-source',
    'bias; cadences are weekly for news/recall/calendar surfaces, monthly for',
    'evolving reference, quarterly for stable documentation.',
    '',
    '**Production-validated the night it shipped:** all 53 original seeds were',
    `burned through the live refresh; ${RETIRED_URLS.length} nav-shell landing pages were`,
    'quality-gate-rejected and RETIRED (removed from the list), with verified',
    'content-rich replacements seeded where a good changing surface exists.',
    "Eleanor's the clinic surfaces were all shells — her rack starts lean (Iowa State",
    'yard & garden) and grows via scout_sources / curate_for_specialist.',
    '',
    '**To prune:** delete the entry from sources.md frontmatter (this note is',
    'just the human-readable receipt). The nightly refresh (03:40, ≤10/night)',
    'picks subscriptions up automatically; a page that turns out to be a',
    'nav-shell will surface in the refresh audit as a quality-gate rejection.',
    '',
  ];
  for (const [spec, list] of Array.from(by_spec.entries()).sort()) {
    lines.push(`## ${spec}`);
    lines.push('');
    for (const { seed, action } of list) {
      lines.push(
        `- [${seed.url}](${seed.url}) — Tier ${seed.tier}, ${seed.cadence} (${action}). ${seed.description}`,
      );
    }
    lines.push('');
  }
  return lines.join('\n');
}

export function apply_seeds(memory: MemoryClient): {
  added: number;
  updated: number;
  retired: number;
  total_sources: number;
} {
  const applied: Array<{ seed: SeedSource; action: string }> = [];
  let added = 0;
  let updated = 0;
  for (const seed of SEEDS) {
    const { action } = upsert_source(memory, {
      url: seed.url,
      description: seed.description,
      tags: seed.tags,
      specialist_id: seed.specialist_id,
      cadence: seed.cadence,
      tier: seed.tier,
      fetch_via: seed.fetch_via,
      category: seed.category,
      seeded_by: SEEDED_BY,
    });
    if (action === 'added') added++;
    else updated++;
    applied.push({ seed, action });
  }
  // Retire seeder-planted URLs production proved wrong.
  const retired = retire_seeded_urls(memory, RETIRED_URLS);
  memory.upsert_note(SUMMARY_PATH, { seeded_by: SEEDED_BY }, build_summary(applied));
  return { added, updated, retired, total_sources: read_sources(memory).length };
}

/**
 * Remove seeder-planted entries at the given URLs. Only entries still
 * carrying OUR `seeded_by` stamp are removed — a hand-edited entry at
 * the same URL is Jasper's and survives. Returns the removed count.
 */
export function retire_seeded_urls(memory: MemoryClient, urls: string[]): number {
  if (urls.length === 0) return 0;
  const entries = read_sources(memory);
  const retire = new Set(urls);
  let retired = 0;
  const kept = entries.filter((e) => {
    const out = retire.has(e.url) && e.seeded_by === SEEDED_BY;
    if (out) retired++;
    return !out;
  });
  if (retired > 0) write_sources(memory, kept);
  return retired;
}

async function main(): Promise<void> {
  const dry_run = process.argv.includes('--dry-run');
  if (dry_run) {
    const by_spec = new Map<string, number>();
    for (const s of SEEDS) by_spec.set(s.specialist_id, (by_spec.get(s.specialist_id) ?? 0) + 1);
    console.log(`[seed-source-racks] DRY RUN — ${SEEDS.length} seeds across ${by_spec.size} specialists:`);
    for (const [spec, n] of Array.from(by_spec.entries()).sort()) {
      console.log(`  ${spec}: ${n}`);
    }
    return;
  }
  const vault_root = process.env.HEARTH_VAULT_ROOT ?? resolve(homedir(), 'vault-friday');
  const db_path = process.env.HEARTH_DB_PATH ?? './data/hearth.db';
  const db = open_db(db_path);
  const memory = new MemoryClient({ vault_root, db });
  const r = apply_seeds(memory);
  console.log(
    `[seed-source-racks] ${r.added} added, ${r.updated} updated, ${r.retired} retired → ` +
      `${r.total_sources} total sources. Summary at ${SUMMARY_PATH}.`,
  );
  db.close();
}

if (import.meta.main) {
  await main();
}
