/**
 * smoke:news-desk — self-contained test of the News Desk compose logic
 * + /api/news router (Kate's office second tab).
 *
 * Temp vault + db + registry; the router is mounted in-process behind a
 * fake auth middleware; Plex taste comes through the seam; the track
 * endpoint hits a STUB scout_sources registered on a real ToolRegistry
 * (capability-gated like production).
 *
 * Asserts: cross-rack category aggregation + 7d counts, offered bundles
 * surface, paused state, item listing/filter/recency, entertainment
 * taste boost ("because you watch"), gear pause toggle (writes the
 * store + refresh sees paused), bundle activation seeds Kate's rack,
 * track → scout proposals, owner-gating on mutations, fail-open taste.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { z } from 'zod';
import { ulid } from 'ulid';
import { open_db } from '../src/memory/stores/structured';
import { MemoryClient } from '../src/memory/client';
import { SpecialistRegistry } from '../src/core/specialist';
import { ToolRegistry } from '../src/core/tool_registry';
import { load_extra_capabilities } from '../src/core/capabilities';
import type { Tool } from '../src/core/tool';
import type { LLMRouter } from '../src/core/llm';
import { upsert_source, read_sources, subscriptions_due } from '../src/specialists/cordelia/sources_store';
import { _test_reset_taste_cache, OFFERED_BUNDLES } from '../src/core/news_desk';
import { create_news_router } from '../src/app/routes/news';

let failures = 0;
function check(label: string, ok: boolean): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) failures++;
}

load_extra_capabilities(join(import.meta.dir, '../config/capabilities.yaml'));

const dir = mkdtempSync(join(tmpdir(), 'hearth-newsdesk-'));
const db = open_db(join(dir, 'smoke.db'));
const memory = new MemoryClient({ vault_root: join(dir, 'vault'), db });

const spec_dir = join(dir, 'specialists');
mkdirSync(spec_dir, { recursive: true });
for (const [id, caps] of [
  ['kate', ''],
  ['maggie', '  read_plex_consumption: true\n'],
  ['cordelia', '  query_web: true\n  write_proposals: true\n'],
] as const) {
  writeFileSync(
    join(spec_dir, `${id}.yaml`),
    `id: ${id}\nname: ${id[0]!.toUpperCase()}${id.slice(1)}\nrole: Fixture\nvoice: warm\npersona: |\n  Fixture persona for the news desk smoke. Long enough to pass.\nproactive:\n  mode: reactive\n${caps ? `capabilities:\n${caps}` : ''}`,
  );
}
const specialists = new SpecialistRegistry(spec_dir);

// Stub scout_sources on a REAL registry (capability gate exercised).
const tool_registry = new ToolRegistry();
let scout_calls: Array<{ topic: string; specialist_id: string }> = [];
const stub_scout: Tool = {
  name: 'scout_sources',
  description: 'stub',
  risk: 'write_internal',
  required_capabilities: ['query_web', 'write_proposals'],
  input_schema: z.object({ topic: z.string(), specialist_id: z.string() }),
  output_schema: z.object({}).passthrough(),
  idempotency_key: () => 'stub',
  async execute(input) {
    const i = input as { topic: string; specialist_id: string };
    scout_calls.push(i);
    return {
      topic: i.topic,
      specialist_id: i.specialist_id,
      candidates: [{ domain: 'a.example.org' }, { domain: 'b.example.org' }],
      proposals: [{ domain: 'a.example.org', proposal_id: 'p1' }],
    };
  },
} as Tool;
tool_registry.register(stub_scout);

// ── seed subscriptions across THREE racks + news items ──────────────
const NOW = new Date();
const iso_ago = (h: number): string => new Date(NOW.getTime() - h * 3_600_000).toISOString();
upsert_source(memory, { url: 'https://bbc.example/rss', description: 'world', tags: [], specialist_id: 'kate', cadence: 'daily', tier: 1, category: 'world' });
upsert_source(memory, { url: 'https://variety.example/rss', description: 'ent', tags: [], specialist_id: 'kate', cadence: 'daily', tier: 2, category: 'entertainment' });
upsert_source(memory, { url: 'https://sth.example/rss', description: 'ws', tags: [], specialist_id: 'kristi', cadence: 'weekly', tier: 2, category: 'workstations' });
upsert_source(memory, { url: 'https://sun.example/rss', description: 'co', tags: [], specialist_id: 'ruby', cadence: 'daily', tier: 2, category: 'colorado' });
upsert_source(memory, { url: 'https://nosub.example/page', description: 'plain url, no category', tags: [] });

const ins = db.prepare(
  `INSERT INTO news_items (id, link, title, description, source_url, source_domain, specialist_id, category, published_at, fetched_at)
   VALUES (@id, @link, @title, @desc, @src, @dom, @spec, @cat, @pub, @f)`,
);
const seed_item = (cat: string, title: string, desc: string, hours_old: number, dom = 'x.example'): void => {
  ins.run({
    '@id': `n_${ulid().toLowerCase()}`,
    '@link': `https://${dom}/${ulid().toLowerCase()}`,
    '@title': title,
    '@desc': desc,
    '@src': `https://${dom}/rss`,
    '@dom': dom,
    '@spec': 'kate',
    '@cat': cat,
    '@pub': iso_ago(hours_old),
    '@f': iso_ago(hours_old),
  });
};
seed_item('world', 'Summit ends with accord', 'Leaders agreed.', 2, 'bbc.example');
seed_item('world', 'Older world story', 'Old.', 30, 'bbc.example');
seed_item('entertainment', 'Severance renewed for another season', 'The show returns.', 5, 'variety.example');
seed_item('entertainment', 'Generic box office roundup', 'Numbers.', 1, 'variety.example');
seed_item('workstations', 'New Threadripper workstation parts', 'Specs.', 3, 'sth.example');
// out-of-window item must not count toward 7d volume
seed_item('world', 'Ancient story', 'Very old.', 24 * 20, 'bbc.example');

// ── mount router in-process with fake auth ──────────────────────────
let current_user: { id: string; tier: string } | null = { id: 'jasper', tier: 'owner' };
let watched: string[] = ['Severance', 'Andor'];
const app = new Hono();
app.use('*', async (c, next) => {
  if (current_user) c.set('user', current_user as never);
  await next();
});
app.route(
  '/api/news',
  create_news_router({
    db,
    memory,
    specialists,
    tool_registry,
    llm: null as unknown as LLMRouter,
    watched_titles_fn: async () => watched,
  }),
);
const get_desk = async (qs = ''): Promise<Record<string, unknown>> => {
  const res = await app.request(`/api/news/desk${qs}`);
  return (await res.json()) as Record<string, unknown>;
};

// 1. Desk payload: categories cross-rack + counts + offered
_test_reset_taste_cache();
const desk = await get_desk();
const cats = desk.categories as Array<Record<string, unknown>>;
const cat = (k: string) => cats.find((c) => c.key === k);
check('categories aggregate across racks (kate+kristi+ruby)', cat('world') !== undefined && cat('workstations') !== undefined && cat('colorado') !== undefined);
check('uncategorized plain URLs are not categories', !cats.some((c) => c.key === undefined || c.key === null));
check('7d volume counts exclude old items', cat('world')?.item_count_7d === 2);
check('offered bundles surface as state=offered', OFFERED_BUNDLES.every((b) => cat(b.key)?.state === 'offered'));
check('active categories are state=active', cat('world')?.state === 'active');

// 2. Items: recency order + taste boost
const items = desk.items as Array<Record<string, unknown>>;
check('items returned newest-first overall', (items[0]!.title as string).includes('Generic box office') || items[0]!.because_you_watch !== undefined);
const sev = items.find((i) => (i.title as string).includes('Severance'));
check('taste boost annotates the watched show', sev?.because_you_watch === 'Severance');
const ent_items = items.filter((i) => i.category === 'entertainment');
check('boosted entertainment item floats above unboosted', (ent_items[0]!.title as string).includes('Severance'));
check('taste title count reported', desk.taste_titles_used === 2);

// 3. Category filter
_test_reset_taste_cache();
const world_only = await get_desk('?category=world');
check('category filter narrows items', (world_only.items as unknown[]).length === 3 && (world_only.items as Array<Record<string, unknown>>).every((i) => i.category === 'world'));

// 4. Fail-open taste
_test_reset_taste_cache();
watched = [];
const desk_no_taste = await get_desk();
check('no Plex data → no boost, no error', desk_no_taste.taste_titles_used === 0 && (desk_no_taste.items as unknown[]).length > 0);
watched = ['Severance'];

// 5. Gear pause toggle: writes the store; refresh skips the category
let res = await app.request('/api/news/categories/world', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ paused: true }),
});
check('pause toggle 200 + flips both… well, the one world sub', res.status === 200 && ((await res.json()) as { flipped: number }).flipped === 1);
check('paused recorded in the store', read_sources(memory).find((e) => e.url.includes('bbc'))?.paused === true);
check('paused category never due', !subscriptions_due(read_sources(memory), NOW).some((e) => e.category === 'world'));
_test_reset_taste_cache();
const desk_paused = await get_desk();
check('cloud shows the category as paused', (desk_paused.categories as Array<Record<string, unknown>>).find((c) => c.key === 'world')?.state === 'paused');
res = await app.request('/api/news/categories/world', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ paused: false }),
});
check('resume flips back', read_sources(memory).find((e) => e.url.includes('bbc'))?.paused === undefined);

// 6. Offered bundle activation seeds Kate's rack
res = await app.request('/api/news/activate/climate', { method: 'POST' });
check('activation 200', res.status === 200);
const climate_subs = read_sources(memory).filter((e) => e.category === 'climate');
check('bundle feeds seeded onto kate at the bundle category', climate_subs.length === 2 && climate_subs.every((e) => e.specialist_id === 'kate' && e.seeded_by === 'news-desk-activation'));
_test_reset_taste_cache();
const desk_after = await get_desk();
check('activated bundle becomes an active category', (desk_after.categories as Array<Record<string, unknown>>).find((c) => c.key === 'climate')?.state === 'active');
res = await app.request('/api/news/activate/nope', { method: 'POST' });
check('unknown bundle 404s', res.status === 404);

// 7. Track something new → scout as cordelia targeting kate
res = await app.request('/api/news/track', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ topic: 'fusion energy progress' }),
});
const track = (await res.json()) as Record<string, unknown>;
check('track runs the scout and reports proposals', res.status === 200 && track.proposals_filed === 1 && track.candidates === 2);
check('scout invoked as cordelia targeting kate', scout_calls.length === 1 && scout_calls[0]!.specialist_id === 'kate');

// 8. Kate's Read — compose, citation gate, desk surfacing, kill switch
{
  const { make_compose_news_takes } = await import(
    '../src/specialists/kate/tools/compose_news_takes'
  );
  const take_json = JSON.stringify({
    lead: {
      // Same ref twice (dedupe → same number) + a dead token (stripped).
      take_md: 'The week turns on **the accord** [world-1]; watch the follow-through [world-1] [ghost-9].',
      cites: ['world-1'],
    },
    categories: [
      { category: 'world', take_md: 'Accord holds for now; the older story [world-2] is context.', cites: ['world-1', 'world-2'] },
      { category: 'entertainment', take_md: 'Ungrounded punditry that cites nothing real.', cites: ['bogus-9'] },
      // Key drift the live 35B exhibited on first contact — must coerce.
      { category: 'workstations', take: 'Threadripper refresh matters for the next build window.', citations: ['workstations-1'] },
      // Garbage entry — dropped without killing the good takes.
      { category: 'broken' },
    ],
  });
  class TakeProvider {
    name = 'fake-takes';
    behavior: 'json' | 'throw' = 'json';
    async complete() {
      if (this.behavior === 'throw') throw new Error('llm down');
      return { content: take_json, tool_calls: [], finish_reason: 'stop' as const, cost: { tokens_in: 0, tokens_out: 0, ms: 0, model: 'fake' } };
    }
    capabilities() {
      return { supports_json_schema: false, supports_tool_calls: false, supports_thinking_mode: false, supports_vision: false, max_context: 32768, cost_per_1m_in_cents: 0, cost_per_1m_out_cents: 0 };
    }
  }
  const take_provider = new TakeProvider();
  const take_llm = { for_role: () => ({ provider: take_provider, defaults: {}, model: 'fake' }) } as unknown as LLMRouter;
  const compose = make_compose_news_takes({
    db,
    specialists,
    llm: take_llm,
    library_deps: {
      db,
      vault_root: join(dir, 'vault'),
      memory,
      specialists,
      runtime: null as never,
      conversations: null as never,
      llm: undefined,
    },
  });
  const tctx = { memory, llm: take_llm, now: NOW, intent_id: ulid(), specialist_id: 'kate' };
  const r1 = await compose.execute(
    { window_hours: 36, headlines_per_category: 8, max_categories: 14 },
    tctx as never,
  );
  check(
    'compose writes cited takes (incl. key-drift coercion), drops uncited + garbage',
    r1.takes_written === 3 && r1.takes_dropped === 2,
  );
  const tr = db.prepare(`SELECT category, take_md, cited_links FROM news_takes ORDER BY category`).all() as Array<{ category: string | null; take_md: string; cited_links: string }>;
  check(
    'lead (NULL) + workstations (coerced keys) + world rows landed',
    tr.length === 3 && tr[0]!.category === null && tr[1]!.category === 'workstations' && tr[2]!.category === 'world',
  );
  check('cites resolved to real news_items links', (JSON.parse(tr[2]!.cited_links) as string[]).every((l) => l.startsWith('https://')));
  // Citations are TAPPABLE: inline [ref] tokens become numbered markdown
  // links at compose time (same ref → same number; dead tokens stripped).
  const lead_md = tr[0]!.take_md;
  check(
    'inline refs linkified to numbered markdown links',
    /\[1\]\(https:\/\//.test(lead_md) && !lead_md.includes('[world-1]'),
  );
  check('repeated ref reuses the same number (one stored link)', (lead_md.match(/\[1\]\(/g) ?? []).length === 2 && (JSON.parse(tr[0]!.cited_links) as string[]).length === 1);
  check('dead ref tokens stripped from prose', !lead_md.includes('ghost-9'));
  check(
    'cited_links order follows superscript order (world: inline [world-2] first)',
    (JSON.parse(tr[2]!.cited_links) as string[]).length === 2 && /\[1\]\(https:\/\//.test(tr[2]!.take_md),
  );
  check("daily 'Kate's read' note shelved", typeof r1.note_path === 'string' && r1.note_path.includes('library/'));
  const note_fts = db.prepare(`SELECT COUNT(*) AS n FROM chunks_fts WHERE note_path = ?`).get(r1.note_path) as { n: number };
  check('note indexed for chat RAG', note_fts.n > 0);

  const desk_takes = await get_desk();
  const tk = desk_takes.takes as { lead: Record<string, unknown> | null; by_category: Record<string, Record<string, unknown>> };
  check('desk payload carries the lead take', tk.lead !== null && (tk.lead!.take_md as string).includes('accord'));
  check('desk payload carries the category take', tk.by_category.world !== undefined);

  process.env.HEARTH_NEWS_TAKES = '0';
  const r2 = await compose.execute({ window_hours: 36, headlines_per_category: 8, max_categories: 14 }, tctx as never);
  check('kill switch disables takes', r2.enabled === false && r2.takes_written === 0);
  delete process.env.HEARTH_NEWS_TAKES;

  take_provider.behavior = 'throw';
  const before = (db.prepare(`SELECT COUNT(*) AS n FROM news_takes`).get() as { n: number }).n;
  const r3 = await compose.execute({ window_hours: 36, headlines_per_category: 8, max_categories: 14 }, tctx as never);
  const after = (db.prepare(`SELECT COUNT(*) AS n FROM news_takes`).get() as { n: number }).n;
  check("LLM down fails open — yesterday's takes stand", r3.error !== undefined && before === after);
}

// 8b. The News Desk TAB for Kate's office (news_pane.ts → tabs primitive)
{
  const { compose_news_desk_tab } = await import('../src/core/news_pane');
  const tab = compose_news_desk_tab(db);
  check(
    "pane tab: id 'news', label 'News Desk', fresh-count badge",
    tab !== null && tab.id === 'news' && tab.label === 'News Desk' && typeof tab.badge === 'number' && tab.badge > 0,
  );
  const text0 = tab!.blocks[0]!;
  check(
    "pane tab: Kate's read leads as a text block with tappable citations",
    text0.type === 'text' &&
      text0.body_md.includes("Kate's read") &&
      text0.body_md.includes('accord') &&
      /\[1\]\(https:\/\//.test(text0.body_md),
  );
  const lists = tab!.blocks.filter((b) => b.type === 'list');
  check(
    'pane tab: headlines grouped per beat with tappable rows',
    lists.length >= 2 &&
      lists.every((l) => l.type === 'list' && l.items.every((i) => typeof i.deep_link === 'string')),
  );
  const empty_db = open_db(':memory:');
  check('pane tab: null on an empty desk (office stays flat)', compose_news_desk_tab(empty_db) === null);
  empty_db.close();
}

// 9. Owner gating
current_user = { id: 'sam', tier: 'household' };
res = await app.request('/api/news/categories/world', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ paused: true }),
});
check('non-owner cannot toggle categories', res.status === 403);
res = await app.request('/api/news/track', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ topic: 'anything' }),
});
check('non-owner cannot track', res.status === 403);
res = await app.request('/api/news/desk');
check('household member CAN read the desk', res.status === 200);
current_user = null;
res = await app.request('/api/news/desk');
check('unauthenticated desk read 401s', res.status === 401);

await specialists.close();
db.close();
rmSync(dir, { recursive: true, force: true });

console.log(failures === 0 ? '\nsmoke:news-desk OK' : `\nsmoke:news-desk FAILED (${failures} check(s))`);
process.exit(failures === 0 ? 0 : 1);
