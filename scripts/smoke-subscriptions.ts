/**
 * smoke:subscriptions — self-contained test of the source-subscription
 * store + Cordelia's refresh_subscriptions tool (knowledge metabolism #2).
 *
 * Temp vault + db + specialist registry; fetch is a stub (no network),
 * LLM absent (quality gate runs structural-only, judge fail-open),
 * embedder is a fake so embed-at-ingest is asserted too.
 *
 * Asserts: subscription parsing round-trip, due-cadence math, the refresh
 * loop (due-only, cap, hash-diff unchanged skip, changed → re-shelve),
 * chunks_fts + chunk_embeddings rows landing for shelved content, wrapper
 * frontmatter (trust_tier / specialist_scope / shelf-wide visibility),
 * per-source audit rows, failure recovery hints, the kill switch, and
 * that a plain add_trusted_source re-add doesn't wipe subscription state.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ulid } from 'ulid';
import { open_db } from '../src/memory/stores/structured';
import { MemoryClient } from '../src/memory/client';
import { SpecialistRegistry } from '../src/core/specialist';
import type { Embedder } from '../src/core/embeddings';
import type { ToolContext } from '../src/core/tool';
import type { LLMRouter } from '../src/core/llm';
import type { LibraryRoutesDeps } from '../src/app/routes/library';
import type { SpecialistRuntime } from '../src/core/specialist_runtime';
import type { ConversationStore } from '../src/memory/stores/conversations';
import {
  read_sources,
  upsert_source,
  subscriptions_due,
  is_due,
  roster_tier,
  content_hash,
} from '../src/specialists/cordelia/sources_store';
import { make_refresh_subscriptions } from '../src/specialists/cordelia/tools/refresh_subscriptions';
import { make_add_trusted_source } from '../src/specialists/cordelia/tools/add_trusted_source';
import type { FetchOutcome } from '../src/connectors/fetch_with_browser_fallback';

let failures = 0;
function check(label: string, ok: boolean): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) failures++;
}

const dir = mkdtempSync(join(tmpdir(), 'hearth-subs-'));
const vault_root = join(dir, 'vault');
const db = open_db(join(dir, 'smoke.db'));
const memory = new MemoryClient({ vault_root, db });

// Minimal specialist fixtures the registry will load.
const spec_dir = join(dir, 'specialists');
mkdirSync(spec_dir, { recursive: true });
writeFileSync(
  join(spec_dir, 'iris.yaml'),
  `id: iris
name: Iris
role: EV and home automation
voice: warm-technical
persona: |
  Test fixture persona for the subscriptions smoke. Long enough to pass.
proactive:
  mode: reactive
trusted_sources:
  tier_1:
    - manifest-tier1.example.org
`,
);
writeFileSync(
  join(spec_dir, 'eleanor.yaml'),
  `id: eleanor
name: Eleanor
role: Garden
voice: warm
persona: |
  Test fixture persona for the subscriptions smoke. Long enough to pass.
proactive:
  mode: reactive
`,
);
const specialists = new SpecialistRegistry(spec_dir);

const fake_embedder: Embedder = {
  enabled: true,
  model: 'fake-embed',
  async embed(texts: string[]): Promise<number[][]> {
    return texts.map(() => [0.1, 0.2, 0.3]);
  },
  async rerank(): Promise<number[]> {
    return [];
  },
};

const library_deps: LibraryRoutesDeps = {
  db,
  vault_root,
  memory,
  specialists,
  runtime: null as unknown as SpecialistRuntime, // save path never touches it
  conversations: null as unknown as ConversationStore,
  llm: undefined, // quality judge absent → structural-only, fail-open
  embedder: fake_embedder,
};

// Prose long enough to clear the structural thin-capture bar (~900 chars).
const para =
  'Front Range gardeners contend with a short growing season, intense ultraviolet light at elevation, and alkaline clay soils that drain poorly in spring. ' +
  'Successful plantings lean on deep but infrequent watering, generous compost amendment, and cultivar selection proven in semi-arid continental climates. ';
let page_version = 1;
const page_content = (): string =>
  `# Subscription test document v${page_version}\n\n${para.repeat(5)}\n\nVersion marker: ${page_version}.`;

let fetch_calls: string[] = [];
let browser_first_urls: string[] = [];
let fail_urls = new Set<string>();
const fetch_fn = async (
  url: string,
  _ctx: unknown,
  opts?: { browser_first?: boolean },
): Promise<FetchOutcome> => {
  fetch_calls.push(url);
  if (opts?.browser_first) browser_first_urls.push(url);
  if (fail_urls.has(url)) {
    return { kind: 'failed', reason: 'HTTP 404', source_url: url };
  }
  return {
    kind: opts?.browser_first ? 'browser' : 'firecrawl',
    markdown: page_content(),
    title: 'Subscription Test Document',
    source_url: url,
  };
};

const NOW = new Date('2026-06-10T03:40:00Z');
const days_ago = (n: number): string =>
  new Date(NOW.getTime() - n * 86_400_000).toISOString();

// ------------------------------------------------------------------
// 1. Store round-trip + due math
// ------------------------------------------------------------------
upsert_source(memory, {
  url: 'https://news.example.org/garden',
  description: 'Garden news (weekly sub, never crawled)',
  tags: ['garden'],
  specialist_id: 'eleanor',
  cadence: 'weekly',
  tier: 2,
  seeded_by: 'smoke',
});
upsert_source(memory, {
  url: 'https://docs.example.org/ev-manual',
  description: 'EV manual (monthly sub, stale)',
  tags: ['ev'],
  specialist_id: 'iris',
  cadence: 'monthly',
  tier: 1,
});
upsert_source(memory, {
  url: 'https://fresh.example.org/feed',
  description: 'Fresh weekly sub — crawled yesterday, not due',
  tags: [],
  specialist_id: 'iris',
  cadence: 'weekly',
});
upsert_source(memory, {
  url: 'https://plain.example.org',
  description: 'Plain curated URL — not a subscription',
  tags: ['misc'],
});

// Hand-set crawl state for the stale + fresh entries (machine-owned fields).
{
  const entries = read_sources(memory);
  const stale = entries.find((e) => e.url.includes('ev-manual'))!;
  stale.last_crawled_at = days_ago(45);
  stale.last_content_hash = 'stalehash';
  const fresh = entries.find((e) => e.url.includes('fresh'))!;
  fresh.last_crawled_at = days_ago(1);
  // Real hash of the v1 page so a later force-run sees it unchanged.
  fresh.last_content_hash = content_hash(page_content());
  const { write_sources } = await import('../src/specialists/cordelia/sources_store');
  write_sources(memory, entries);
}

const all = read_sources(memory);
check('store round-trips 4 entries', all.length === 4);
const sub = all.find((e) => e.url.includes('ev-manual'))!;
check('subscription fields survive round-trip', sub.cadence === 'monthly' && sub.specialist_id === 'iris' && sub.tier === 1);
check('crawl state survives round-trip', sub.last_crawled_at === days_ago(45) && sub.last_content_hash === 'stalehash');
const due = subscriptions_due(all, NOW);
check('due = never-crawled weekly + stale monthly (not fresh, not plain)', due.length === 2);
check('never-crawled sorts first', due[0]!.url.includes('news.example.org'));
check('fresh weekly is not due', !due.some((e) => e.url.includes('fresh')));
check(
  'is_due flips after cadence elapses',
  is_due({ ...due[1]!, last_crawled_at: days_ago(8), cadence: 'weekly' }, NOW) &&
    !is_due({ ...due[1]!, last_crawled_at: days_ago(2), cadence: 'weekly' }, NOW),
);

// roster_tier: manifest beats subscriptions; subscription domains count.
const iris = specialists.get('iris')!;
check('roster_tier resolves manifest tier 1', roster_tier('https://manifest-tier1.example.org/x', iris, all) === 1);
check('roster_tier resolves subscription domain tier', roster_tier('https://docs.example.org/other-page', iris, all) === 1);
check('roster_tier null for out-of-roster', roster_tier('https://random-blog.example.net/p', iris, all) === null);
check(
  "roster_tier ignores another specialist's subscriptions",
  roster_tier('https://news.example.org/garden', iris, all) === null,
);

// ------------------------------------------------------------------
// 2. Refresh pass — shelve, index, embed, audit
// ------------------------------------------------------------------
// Feed fixtures for the RSS fast path (section 7c). Keyed by URL; null
// for everything else so the legacy page-path cases are untouched.
let feed_xml: Record<string, string> = {};
const raw_fetch_fn = async (url: string): Promise<string | null> => feed_xml[url] ?? null;

const tool = make_refresh_subscriptions({ specialists, library_deps, fetch_fn, raw_fetch_fn });
const ctx: ToolContext = {
  memory,
  llm: null as unknown as LLMRouter,
  now: NOW,
  intent_id: ulid(),
  specialist_id: 'cordelia',
};

const run1 = await tool.execute({ max_sources: 10, max_daily: 10, force: false }, ctx);
check('run1 enabled + checked the 2 due sources', run1.enabled && run1.checked === 2);
check('run1 shelved both (content changed vs stale/none)', run1.refreshed.length === 2 && run1.failed.length === 0);
const shelved = run1.refreshed.find((r) => r.specialist_id === 'iris')!;
check('shelved trust_tier comes from the subscription record', shelved.trust_tier === 1);

const note = memory.read_note(shelved.wrapper_note_path);
check('wrapper note exists with specialist_scope=iris', note !== null && (note.frontmatter as Record<string, unknown>).specialist_scope === 'iris');
check('wrapper stamped trust_tier 1', (note?.frontmatter as Record<string, unknown>).trust_tier === 1);
check('wrapper is shelf-wide (no private_to)', (note?.frontmatter as Record<string, unknown>).private_to === undefined);
check('wrapper carries source_url', (note?.frontmatter as Record<string, unknown>).source_url === 'https://docs.example.org/ev-manual');

const fts = db
  .prepare(`SELECT COUNT(*) AS n FROM chunks_fts WHERE note_path = ?`)
  .get(shelved.wrapper_note_path) as { n: number };
check('chunks_fts rows landed (save_library_item path, not bare upsert)', fts.n > 0);
const emb = db
  .prepare(`SELECT COUNT(*) AS n FROM chunk_embeddings WHERE note_path = ?`)
  .get(shelved.wrapper_note_path) as { n: number };
check('chunk_embeddings rows landed (embed-at-ingest via ToolDeps.embedder)', emb.n > 0);

const audits = db
  .prepare(`SELECT COUNT(*) AS n FROM audit_log WHERE tool_name = 'source_refresh' AND agent = 'cordelia'`)
  .get() as { n: number };
check('one source_refresh audit row per source', audits.n === 2);

const after1 = read_sources(memory);
const sub1 = after1.find((e) => e.url.includes('ev-manual'))!;
check('crawl state updated after shelve', sub1.last_crawled_at === NOW.toISOString() && sub1.last_content_hash === content_hash(page_content()));

// ------------------------------------------------------------------
// 3. Idempotency: unchanged content shelves nothing
// ------------------------------------------------------------------
fetch_calls = [];
const run2 = await tool.execute({ max_sources: 10, max_daily: 10, force: true }, ctx);
check('run2 (force) checked all 3 subscriptions', run2.checked === 3);
check('run2 shelved nothing — hashes unchanged', run2.refreshed.length === 0 && run2.unchanged.length === 3);

// 4. Changed content re-shelves
page_version = 2;
const run3 = await tool.execute({ max_sources: 10, max_daily: 10, force: true }, ctx);
check('run3 re-shelves on content change', run3.refreshed.length === 3 && run3.unchanged.length === 0);

// 5. Cap + due_remaining
page_version = 3;
const run4 = await tool.execute({ max_sources: 1, max_daily: 10, force: true }, ctx);
check('cap respected (1 checked)', run4.checked === 1);
check('due_remaining reports the unserviced tail', run4.due_remaining === 2);

// 6. Failure → recovery hint, entry stays due
fail_urls = new Set(['https://news.example.org/garden']);
{
  // Make only the news sub due again by aging its crawl state.
  const entries = read_sources(memory);
  const news = entries.find((e) => e.url.includes('news'))!;
  news.last_crawled_at = days_ago(10);
  const { write_sources } = await import('../src/specialists/cordelia/sources_store');
  write_sources(memory, entries);
}
const run5 = await tool.execute({ max_sources: 10, max_daily: 10, force: false }, ctx);
check('failed fetch lands in failed[] with next_action hint', run5.failed.length === 1 && run5.failed[0]!.next_action.length > 10);
const after5 = read_sources(memory);
check(
  'failed source stays due (crawl state untouched)',
  after5.find((e) => e.url.includes('news'))!.last_crawled_at === days_ago(10),
);
const err_audit = db
  .prepare(`SELECT COUNT(*) AS n FROM audit_log WHERE tool_name = 'source_refresh' AND error IS NOT NULL`)
  .get() as { n: number };
check('failure audited with error', err_audit.n >= 1);
fail_urls = new Set();

// 7. Kill switch
process.env.HEARTH_SOURCE_REFRESH = '0';
const run6 = await tool.execute({ max_sources: 10, max_daily: 10, force: true }, ctx);
check('kill switch disables (enabled=false, nothing checked)', !run6.enabled && run6.checked === 0 && run6.skipped_reason !== undefined);
delete process.env.HEARTH_SOURCE_REFRESH;

// ------------------------------------------------------------------
// 7b. Daily cadence: due math, separate budget pool, browser-first
// ------------------------------------------------------------------
const hours_ago = (h: number): string =>
  new Date(NOW.getTime() - h * 3_600_000).toISOString();
upsert_source(memory, {
  url: 'https://news-a.example.org/rss',
  description: 'daily news A',
  tags: [],
  specialist_id: 'iris',
  cadence: 'daily',
  tier: 2,
});
upsert_source(memory, {
  url: 'https://news-b.example.org/rss',
  description: 'daily news B',
  tags: [],
  specialist_id: 'iris',
  cadence: 'daily',
  tier: 2,
});
upsert_source(memory, {
  url: 'https://paywall.example.org/section',
  description: 'paywalled daily — signed-in browser fetch',
  tags: [],
  specialist_id: 'iris',
  cadence: 'daily',
  tier: 2,
  fetch_via: 'browser',
});
{
  const { write_sources, is_subscription } = await import(
    '../src/specialists/cordelia/sources_store'
  );
  const es = read_sources(memory);
  es.find((e) => e.url.includes('news-a'))!.last_crawled_at = hours_ago(20); // ≥18h → due
  es.find((e) => e.url.includes('news-b'))!.last_crawled_at = hours_ago(10); // <18h → not due
  // Park every non-daily subscription so only the dailies are due.
  for (const e of es) {
    if (is_subscription(e) && e.cadence !== 'daily') e.last_crawled_at = NOW.toISOString();
  }
  write_sources(memory, es);
}
const due7b = subscriptions_due(read_sources(memory), NOW);
check(
  'daily due math: 20h-old + never-crawled due, 10h-old not (6h slack)',
  due7b.length === 2 &&
    due7b.some((e) => e.url.includes('news-a')) &&
    due7b.some((e) => e.url.includes('paywall')) &&
    !due7b.some((e) => e.url.includes('news-b')),
);
const fetch_via_roundtrip = read_sources(memory).find((e) => e.url.includes('paywall'));
check('fetch_via survives the store round-trip', fetch_via_roundtrip?.fetch_via === 'browser');

browser_first_urls = [];
const run7b = await tool.execute({ max_sources: 10, max_daily: 10, force: false }, ctx);
check('daily subs refresh from the daily pool', run7b.checked === 2 && run7b.refreshed.length === 2);
check(
  'fetch_via:browser routes browser-first (and ONLY that sub)',
  browser_first_urls.length === 1 && browser_first_urls[0]!.includes('paywall'),
);

// Pool separation: one daily + one non-daily due; caps of 1 each → BOTH
// pools serviced (a single shared cap would starve one of them).
{
  const { write_sources } = await import('../src/specialists/cordelia/sources_store');
  const es = read_sources(memory);
  es.find((e) => e.url.includes('news-a'))!.last_crawled_at = hours_ago(30);
  es.find((e) => e.url.includes('news-b'))!.last_crawled_at = hours_ago(30);
  es.find((e) => e.url.includes('ev-manual'))!.last_crawled_at = days_ago(60);
  es.find((e) => e.url === 'https://news.example.org/garden')!.last_crawled_at = days_ago(10);
  write_sources(memory, es);
}
const run7c = await tool.execute({ max_sources: 1, max_daily: 1, force: false }, ctx);
check(
  'budget pools are separate: 1 daily + 1 non-daily checked, 2 left due',
  run7c.checked === 2 && run7c.due_remaining === 2,
);

// ------------------------------------------------------------------
// 7c. Feed fast path: RSS parses into news_items + a clean digest
// ------------------------------------------------------------------
const RSS_V1 = `<?xml version="1.0"?>
<rss version="2.0"><channel><title>Test Wire</title>
<item><title>First story about solar</title><link>https://wire.example.org/a</link><description><![CDATA[Solar &amp; storage <b>news</b> body.]]></description><pubDate>Tue, 09 Jun 2026 12:00:00 GMT</pubDate></item>
<item><title>Second story about batteries</title><link>https://wire.example.org/b</link><description>Battery prices fell again.</description><pubDate>Tue, 09 Jun 2026 13:00:00 GMT</pubDate></item>
</channel></rss>`;
const RSS_V2 = RSS_V1.replace(
  '</channel></rss>',
  '<item><title>Third story about grids</title><link>https://wire.example.org/c</link><description>Grid upgrade approved.</description><pubDate>Wed, 10 Jun 2026 01:00:00 GMT</pubDate></item></channel></rss>',
);
upsert_source(memory, {
  url: 'https://wire.example.org/rss',
  description: 'test wire feed',
  tags: ['rss'],
  specialist_id: 'iris',
  cadence: 'daily',
  tier: 2,
  category: 'energy',
});
feed_xml['https://wire.example.org/rss'] = RSS_V1;
fetch_calls = [];
const run7d = await tool.execute({ max_sources: 1, max_daily: 10, force: false }, ctx);
const wire = run7d.refreshed.find((r) => r.url.includes('wire.example.org'));
check('feed parses + shelves a digest', wire !== undefined && wire.feed_items_added === 2);
check('feed fast path never touches the page fetcher', !fetch_calls.includes('https://wire.example.org/rss'));
const ni = db
  .prepare(`SELECT title, category, specialist_id, source_domain FROM news_items ORDER BY link`)
  .all() as Array<{ title: string; category: string; specialist_id: string; source_domain: string }>;
check(
  'news_items rows landed with category + owner + domain',
  ni.length === 2 && ni[0]!.category === 'energy' && ni[0]!.specialist_id === 'iris' && ni[0]!.source_domain === 'wire.example.org',
);
check('CDATA/html stripped from description', !JSON.stringify(ni).includes('<b>'));
const digest_note = memory.read_note(wire!.wrapper_note_path);
check('digest is clean markdown with linked headlines', (digest_note?.body ?? '').includes('## [First story about solar](https://wire.example.org/a)'));
const digest_fts = db
  .prepare(`SELECT COUNT(*) AS n FROM chunks_fts WHERE note_path = ?`)
  .get(wire!.wrapper_note_path) as { n: number };
check('digest indexed into chunks_fts', digest_fts.n > 0);

// Unchanged feed → no new shelve, no dup items.
const run7e = await tool.execute({ max_sources: 1, max_daily: 10, force: true }, ctx);
check('same items hash → unchanged (timestamp churn ignored)', run7e.unchanged.some((u) => u.url.includes('wire')));

// New item appears → re-shelve, INSERT OR IGNORE keeps old rows single.
feed_xml['https://wire.example.org/rss'] = RSS_V2;
const run7f = await tool.execute({ max_sources: 1, max_daily: 10, force: true }, ctx);
const wire2 = run7f.refreshed.find((r) => r.url.includes('wire'));
check('new story → exactly 1 item added (no dups)', wire2?.feed_items_added === 1);
const ni_count = db.prepare(`SELECT COUNT(*) AS n FROM news_items`).get() as { n: number };
check('news_items has 3 distinct stories', ni_count.n === 3);

// Paused subscriptions are never due.
{
  const { write_sources } = await import('../src/specialists/cordelia/sources_store');
  const es = read_sources(memory);
  es.find((e) => e.url.includes('wire'))!.paused = true;
  es.find((e) => e.url.includes('wire'))!.last_crawled_at = days_ago(5);
  write_sources(memory, es);
}
const due_paused = subscriptions_due(read_sources(memory), NOW);
check('paused sub is never due', !due_paused.some((e) => e.url.includes('wire')));
{
  const { write_sources } = await import('../src/specialists/cordelia/sources_store');
  const es = read_sources(memory);
  const w = es.find((e) => e.url.includes('wire'))!;
  delete w.paused;
  w.last_crawled_at = NOW.toISOString();
  write_sources(memory, es);
}
feed_xml = {};

// 8. Plain re-add must not wipe subscription fields
const add_tool = make_add_trusted_source(memory);
await add_tool.execute(
  { url: 'https://docs.example.org/ev-manual', description: 'EV manual (re-added)', tags: ['ev'] },
  { ...ctx, specialist_id: 'cordelia' },
);
const readd = read_sources(memory).find((e) => e.url.includes('ev-manual'))!;
check(
  're-add keeps cadence/owner/crawl state',
  readd.cadence === 'monthly' && readd.specialist_id === 'iris' && readd.last_content_hash !== undefined,
);
check('re-add updates description', readd.description === 'EV manual (re-added)');

// 9. add_trusted_source can create a subscription directly
await add_tool.execute(
  {
    url: 'https://newsub.example.org/feed',
    description: 'subscribed via chat',
    tags: [],
    specialist_id: 'eleanor',
    cadence: 'weekly',
    tier: 2,
  },
  ctx,
);
const newsub = read_sources(memory).find((e) => e.url.includes('newsub'))!;
check('add_trusted_source creates a subscription', newsub.cadence === 'weekly' && newsub.specialist_id === 'eleanor' && newsub.tier === 2);

// 10. Output schema round-trip
check('refresh output validates against output_schema', tool.output_schema.safeParse(run1).success);

await specialists.close();
db.close();
rmSync(dir, { recursive: true, force: true });

console.log(
  failures === 0
    ? '\nsmoke:subscriptions OK'
    : `\nsmoke:subscriptions FAILED (${failures} check(s))`,
);
process.exit(failures === 0 ? 0 : 1);
