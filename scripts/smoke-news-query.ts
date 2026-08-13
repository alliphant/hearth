/**
 * smoke:news-query — query_news_items read tool over the News Desk.
 *
 * Self-contained (temp db). Seeds news_items across categories + ages and
 * asserts: grouping by category (most-covered first), the 24h window
 * excludes stale rows, per_category caps, a category filter narrows, and
 * an empty window returns total 0 with an actionable hint.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ulid } from 'ulid';
import { open_db } from '../src/memory/stores/structured';
import type { ToolContext } from '../src/core/tool';
import { make_query_news_items } from '../src/specialists/kate/tools/query_news_items';

let failures = 0;
function check(name: string, cond: boolean): void {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`);
  if (!cond) failures++;
}

const dir = mkdtempSync(join(tmpdir(), 'hearth-news-query-'));
const db = open_db(join(dir, 'smoke.db'));
const tool = make_query_news_items(db);
const ctx = {} as ToolContext;

// Parse inputs through the schema first, exactly as the ToolRegistry does
// (so Zod `.default()`s apply — execute is only ever handed parsed input).
const run = (raw: Record<string, unknown>): ReturnType<typeof tool.execute> =>
  tool.execute(tool.input_schema.parse(raw), ctx);

const now = Date.now();
const iso = (ms_ago: number): string => new Date(now - ms_ago).toISOString();
const H = 3_600_000;

function seed(
  title: string,
  category: string | null,
  domain: string,
  fetched_ms_ago: number,
): void {
  db.prepare(
    `INSERT OR IGNORE INTO news_items
       (id, link, title, description, source_url, source_domain, specialist_id, category, published_at, fetched_at)
     VALUES (@id, @link, @title, '', @su, @dom, 'kate', @cat, @pub, @fetched)`,
  ).run({
    '@id': ulid(),
    '@link': `https://${domain}/${ulid()}`,
    '@title': title,
    '@su': `https://${domain}`,
    '@dom': domain,
    '@cat': category,
    '@pub': iso(fetched_ms_ago),
    '@fetched': iso(fetched_ms_ago),
  });
}

async function main(): Promise<void> {
  // markets: 3 fresh; ai-business: 1 fresh; markets also 1 STALE (40h).
  seed('Fed signals a pause', 'markets', 'apnews.com', 2 * H);
  seed('Yields slip', 'markets', 'reuters.com', 5 * H);
  seed('Chip rally', 'markets', 'bloomberg.com', 8 * H);
  seed('Stale market note', 'markets', 'old.com', 40 * H);
  seed('New model ships', 'ai-business', 'theverge.com', 3 * H);
  seed('Uncategorized blip', null, 'nowhere.com', 1 * H);

  // 1. Default 24h window: markets (3) before ai-business (1); stale excluded.
  const r = await run({ window_hours: 24, per_category: 5 });
  check('two categories returned', r.categories.length === 2);
  check('markets first (most-covered)', r.categories[0]?.category === 'markets');
  check('stale row excluded from markets', r.categories[0]?.headlines.length === 3);
  check('headline carries source_domain', (r.categories[0]?.headlines[0]?.source_domain.length ?? 0) > 0);
  check('total counts fresh only', r.total === 4);
  check('null-category excluded', !r.categories.some((c) => c.category === null));

  // 2. per_category cap.
  const capped = await run({ window_hours: 24, per_category: 2 });
  check('per_category caps headlines', (capped.categories[0]?.headlines.length ?? 0) === 2);
  check('count still reflects true total', capped.categories[0]?.count === 3);

  // 3. category filter narrows.
  const filt = await run({ window_hours: 24, categories: ['ai-business'] });
  check('filter returns only requested category', filt.categories.length === 1 && filt.categories[0]?.category === 'ai-business');

  // 4. empty window → hint.
  const empty = await run({ window_hours: 1, per_category: 5 });
  // only the 1h-old null-category row is in window, and null categories are excluded → 0
  check('empty window returns total 0', empty.total === 0);
  check('empty window carries a hint', typeof empty.note === 'string' && /refresh/.test(empty.note ?? ''));
}

main()
  .catch((err) => {
    console.error(err);
    failures++;
  })
  .finally(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
    console.log(failures === 0 ? '\nsmoke:news-query OK' : `\nsmoke:news-query FAILED (${failures})`);
    process.exit(failures === 0 ? 0 : 1);
  });
