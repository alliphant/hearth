/**
 * smoke:search-router — the cache + rerank + provider layer behind web_search.
 *
 * Self-contained: a fake SearchProvider (counts calls) + a fake Embedder
 * (scripted rerank), no network, no GPU. Asserts: cache miss→hit→TTL-expiry;
 * one over-fetch serves multiple max_results; query normalization collapses to
 * one entry; rerank REORDERS by score and PRESERVES the set; rerank fails open
 * (null → provider order) and never drops results; provider error passes
 * through and is NOT cached; both kill switches → provider order / no cache.
 * Plus the fetch cache (success caches, deferred/failed never do, kill switch).
 */
import type { Embedder } from '../src/core/embeddings';
import {
  run_search,
  _test_reset,
  type SearchProvider,
  type SearchResult,
} from '../src/connectors/search_router';
import {
  fetch_cache_get,
  fetch_cache_put,
  _fetch_cache_reset,
} from '../src/connectors/fetch_cache';
import type { FetchOutcome } from '../src/connectors/fetch_with_browser_fallback';

let failures = 0;
function check(label: string, ok: boolean): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) failures++;
}

const RESULTS: SearchResult[] = ['A', 'B', 'C', 'D', 'E'].map((x) => ({
  title: `Title ${x}`,
  url: `https://ex.example/${x}`,
  snippet: `snippet ${x}`,
}));

let provider_calls = 0;
let last_n = 0;
const fake_provider: SearchProvider = {
  name: 'fake',
  async search(query: string, max_results: number) {
    provider_calls++;
    last_n = max_results;
    return { query, results: RESULTS.slice(0, max_results) };
  },
};

let rerank_calls = 0;
// Returns ascending indices as scores; run_search sorts DESC → reverses order.
const reverse_embedder: Embedder = {
  enabled: true,
  model: 'fake',
  async embed() {
    return [];
  },
  async rerank(_q, docs) {
    rerank_calls++;
    return docs.map((_d, i) => i);
  },
};
const null_embedder: Embedder = {
  enabled: true,
  model: 'fake',
  async embed() {
    return [];
  },
  async rerank() {
    return null;
  },
};

function reset(opts?: Parameters<typeof _test_reset>[0]): void {
  provider_calls = 0;
  rerank_calls = 0;
  _test_reset({ providers: [fake_provider], ...opts });
}

/* ------------------------------------------------------------------ */
/* 1. Cache miss → hit (the core efficiency win)                       */
/* ------------------------------------------------------------------ */
delete process.env.HEARTH_SEARCH_CACHE;
delete process.env.HEARTH_SEARCH_RERANK;
reset(); // no embedder → no rerank, isolate caching
{
  const a = await run_search('becca sagall massage', 3);
  const b = await run_search('becca sagall massage', 3);
  check('cache miss then hit → provider called ONCE', provider_calls === 1);
  check('cached results identical', JSON.stringify(a.results) === JSON.stringify(b.results));
  check('returns the requested max_results', a.results.length === 3);
}

/* ------------------------------------------------------------------ */
/* 2. One over-fetch serves multiple max_results                       */
/* ------------------------------------------------------------------ */
reset();
{
  await run_search('shared query', 2);
  const big = await run_search('shared query', 5);
  check('over-fetch (20) serves a larger later max_results from cache', provider_calls === 1 && last_n === 20);
  check('larger max_results returns up to N from the cached pool', big.results.length === 5);
}

/* ------------------------------------------------------------------ */
/* 3. Query normalization collapses to one cache entry                 */
/* ------------------------------------------------------------------ */
reset();
{
  await run_search('Dana Marsh', 3);
  await run_search('  becca   sagall ', 3);
  check('case/whitespace-different queries share one cache entry', provider_calls === 1);
}

/* ------------------------------------------------------------------ */
/* 4. Rerank reorders + preserves the set                              */
/* ------------------------------------------------------------------ */
reset({ embedder: reverse_embedder });
{
  const r = await run_search('rerank me', 5);
  const urls = r.results.map((x) => x.url);
  const orig = RESULTS.map((x) => x.url);
  check('rerank ran', rerank_calls === 1);
  check('rerank REORDERED the results (reversed by scripted scores)', JSON.stringify(urls) === JSON.stringify([...orig].reverse()));
  check('rerank PRESERVED the set (same urls, no drops)', new Set(urls).size === orig.length && orig.every((u) => urls.includes(u)));
}

/* ------------------------------------------------------------------ */
/* 5. Rerank fail-open (null scores → provider order, no drops)        */
/* ------------------------------------------------------------------ */
reset({ embedder: null_embedder });
{
  const r = await run_search('fail open', 5);
  check('null rerank → provider order preserved', JSON.stringify(r.results.map((x) => x.url)) === JSON.stringify(RESULTS.map((x) => x.url)));
  check('null rerank → no results dropped', r.results.length === 5);
}

/* ------------------------------------------------------------------ */
/* 6. Provider error passes through and is NOT cached                  */
/* ------------------------------------------------------------------ */
{
  let err_calls = 0;
  const err_provider: SearchProvider = {
    name: 'err',
    async search(query) {
      err_calls++;
      return { query, results: [], error: 'SearXNG HTTP 500' };
    },
  };
  _test_reset({ providers: [err_provider] });
  const r1 = await run_search('boom', 3);
  const r2 = await run_search('boom', 3);
  check('provider error returned (not swallowed)', r1.error === 'SearXNG HTTP 500' && r1.results.length === 0);
  check('error response NOT cached (provider re-called)', err_calls === 2 && r2.error === 'SearXNG HTTP 500');
}

/* ------------------------------------------------------------------ */
/* 7. Kill switches                                                    */
/* ------------------------------------------------------------------ */
reset({ embedder: reverse_embedder });
process.env.HEARTH_SEARCH_RERANK = '0';
{
  const r = await run_search('no rerank', 5);
  check('HEARTH_SEARCH_RERANK=0 → no rerank call, provider order', rerank_calls === 0 && JSON.stringify(r.results.map((x) => x.url)) === JSON.stringify(RESULTS.map((x) => x.url)));
}
delete process.env.HEARTH_SEARCH_RERANK;

reset();
process.env.HEARTH_SEARCH_CACHE = '0';
{
  await run_search('uncached', 3);
  await run_search('uncached', 3);
  check('HEARTH_SEARCH_CACHE=0 → every call hits the provider', provider_calls === 2);
}
delete process.env.HEARTH_SEARCH_CACHE;

/* ------------------------------------------------------------------ */
/* 8. TTL expiry                                                       */
/* ------------------------------------------------------------------ */
reset({ ttl_ms: 40 });
{
  await run_search('expires', 3);
  await new Promise((r) => setTimeout(r, 60));
  await run_search('expires', 3);
  check('expired cache entry → provider re-called', provider_calls === 2);
}

/* ------------------------------------------------------------------ */
/* 9. Fetch cache — success caches; deferred/failed never do           */
/* ------------------------------------------------------------------ */
delete process.env.HEARTH_FETCH_CACHE;
_fetch_cache_reset();
{
  const url = 'https://ex.example/page';
  const ok: FetchOutcome = { kind: 'firecrawl', markdown: '# Page\n\nbody', title: 'Page', source_url: url };
  fetch_cache_put(url, ok);
  const hit = fetch_cache_get(url);
  check('successful fetch is cached + returned', hit?.kind === 'firecrawl' && hit.markdown.includes('body'));

  const failed: FetchOutcome = { kind: 'failed', reason: 'HTTP 403', source_url: 'https://ex.example/blocked' };
  fetch_cache_put('https://ex.example/blocked', failed);
  check('failed fetch is NOT cached (must retry)', fetch_cache_get('https://ex.example/blocked') === undefined);

  const deferred: FetchOutcome = { kind: 'deferred', reason: 'browser busy', source_url: 'https://ex.example/deferred' };
  fetch_cache_put('https://ex.example/deferred', deferred);
  check('deferred fetch is NOT cached (must retry)', fetch_cache_get('https://ex.example/deferred') === undefined);

  process.env.HEARTH_FETCH_CACHE = '0';
  _fetch_cache_reset();
  fetch_cache_put(url, ok);
  check('HEARTH_FETCH_CACHE=0 → nothing cached', fetch_cache_get(url) === undefined);
  delete process.env.HEARTH_FETCH_CACHE;
}

/* ------------------------------------------------------------------ */
/* Free-first provider chain — the METERED provider is a LAST RESORT   */
/* ------------------------------------------------------------------ */
{
  let free_calls = 0;
  let metered_calls = 0;
  const free_empty: SearchProvider = {
    name: 'free',
    async search(query) {
      free_calls++;
      return { query, results: [] };
    },
  };
  const free_ok: SearchProvider = {
    name: 'free',
    async search(query, n) {
      free_calls++;
      return { query, results: RESULTS.slice(0, n) };
    },
  };
  const free_err: SearchProvider = {
    name: 'free',
    async search(query) {
      free_calls++;
      return { query, results: [], error: 'searxng down' };
    },
  };
  const metered: SearchProvider = {
    name: 'metered',
    async search(query, n) {
      metered_calls++;
      return { query, results: RESULTS.slice(0, n) };
    },
  };

  // The whole point: when the free provider answers, the metered one is never called.
  free_calls = 0;
  metered_calls = 0;
  _test_reset({ providers: [free_ok, metered] });
  let r = await run_search('free answers', 3);
  check('free provider answered → metered NOT called', free_calls === 1 && metered_calls === 0);
  check('free provider results returned', r.results.length === 3);

  // Empty (not error) from free → fall through to metered.
  free_calls = 0;
  metered_calls = 0;
  _test_reset({ providers: [free_empty, metered] });
  r = await run_search('free empty', 3);
  check('free returned EMPTY → metered used as fallback', free_calls === 1 && metered_calls === 1);
  check('fallback results returned', r.results.length === 3);

  // Error from free → also falls through (a down SearXNG must not blank the household).
  free_calls = 0;
  metered_calls = 0;
  _test_reset({ providers: [free_err, metered] });
  r = await run_search('free errored', 3);
  check('free ERRORED → metered used as fallback', metered_calls === 1 && !r.error);

  // Single-provider chain must not regress into an error-swallowing path.
  free_calls = 0;
  _test_reset({ providers: [free_err] });
  r = await run_search('only free, and it is down', 3);
  check('no fallback configured → error surfaces', r.error !== undefined);
}

/* ------------------------------------------------------------------ */
/* An EMPTY result set must never be cached                            */
/* ------------------------------------------------------------------ */
{
  // `[]` is truthy, so a cached empty entry used to return as a HIT with no
  // error — a confident "the web has nothing on this" for the whole retention
  // window. With free-first that is exactly what a capped/rate-limited provider
  // returns, so caching it would turn a transient outage into a silent blackout.
  let calls = 0;
  const empty_provider: SearchProvider = {
    name: 'empty',
    async search(query) {
      calls++;
      return { query, results: [] };
    },
  };
  _test_reset({ providers: [empty_provider] });
  await run_search('nothing anywhere', 5);
  const second = await run_search('nothing anywhere', 5);
  check('empty result set is NOT cached (provider re-called)', calls === 2);
  check('empty result set is not reported as an error', second.error === undefined);
}

/* ------------------------------------------------------------------ */
/* Freshness (max_age_ms) is per-CALLER, separate from retention       */
/* ------------------------------------------------------------------ */
{
  reset({ providers: [fake_provider], ttl_ms: 60 * 60_000 }); // 1h retention
  await run_search('freshness probe', 3);
  check('freshness: first call hit the provider', provider_calls === 1);

  // A caller demanding sub-millisecond freshness must MISS the just-stored entry…
  await run_search('freshness probe', 3, { max_age_ms: 0 });
  check('strict caller (max_age 0) → provider re-called', provider_calls === 2);

  // …while a tolerant caller still reuses it, and the entry was never evicted.
  await run_search('freshness probe', 3, { max_age_ms: 60 * 60_000 });
  check('tolerant caller reuses the cached entry', provider_calls === 2);
}

/* ------------------------------------------------------------------ */
/* Semantic collapse of near-duplicate queries                         */
/* ------------------------------------------------------------------ */
{
  // Embedder whose vector depends only on whether the query mentions "dell",
  // so the three hand-written Dell phrasings collapse and an unrelated query
  // does not.
  const topic_embedder: Embedder = {
    enabled: true,
    model: 'fake',
    async embed(texts) {
      return texts.map((t) => (t.includes('dell') ? [1, 0] : [0, 1]));
    },
    async rerank() {
      return null;
    },
  };

  reset({ providers: [fake_provider], embedder: topic_embedder });
  await run_search('dell precision tower workstation lineup specifications', 3);
  check('semantic: first query hit the provider', provider_calls === 1);

  await run_search('dell pro precision tower workstation specifications', 3);
  check('near-duplicate phrasing collapsed → NO second provider call', provider_calls === 1);

  const other = await run_search('lenovo thinkstation tiny psref', 3);
  check('unrelated query still hits the provider', provider_calls === 2);
  check('unrelated query returned results', other.results.length === 3);

  // Kill switch must restore exact-match-only behavior.
  process.env.HEARTH_SEARCH_SEMANTIC_CACHE = '0';
  reset({ providers: [fake_provider], embedder: topic_embedder });
  await run_search('dell precision tower workstation lineup specifications', 3);
  await run_search('dell pro precision tower workstation specifications', 3);
  check('HEARTH_SEARCH_SEMANTIC_CACHE=0 → near-duplicate hits provider', provider_calls === 2);
  delete process.env.HEARTH_SEARCH_SEMANTIC_CACHE;

  // A dead embedder must degrade to an ordinary miss, never throw.
  const throwing_embedder: Embedder = {
    enabled: true,
    model: 'fake',
    async embed() {
      throw new Error('embedder down');
    },
    async rerank() {
      return null;
    },
  };
  reset({ providers: [fake_provider], embedder: throwing_embedder });
  const r = await run_search('embedder is down', 3);
  check('embedder throwing → fail-open, results still returned', r.results.length === 3 && !r.error);
}

/* ------------------------------------------------------------------ */
/* Quality gate — escalate on BAD results, not just zero results       */
/* ------------------------------------------------------------------ */
{
  const GOOD: SearchResult[] = ['g1', 'g2'].map((x) => ({
    title: `relevant ${x}`, url: `https://ex.example/${x}`, snippet: 'on topic',
  }));
  const JUNK: SearchResult[] = ['j1', 'j2'].map((x) => ({
    title: `Just a moment... ${x}`, url: `https://ex.example/${x}`, snippet: 'cloudflare',
  }));

  // Scores keyed on title so the fake reranker mimics the real one: a bot-wall
  // page scores ~0, a relevant page scores ~0.99 (measured on bge-reranker-v2-m3).
  const scoring_embedder: Embedder = {
    enabled: true, model: 'fake',
    async embed() { return []; },
    async rerank(_q, docs) { return docs.map((d) => (d.includes('relevant') ? 0.99 : 0.0)); },
  };
  const junk_free: SearchProvider = { name: 'free', async search(q) { return { query: q, results: JUNK }; } };
  const good_free: SearchProvider = { name: 'free', async search(q) { return { query: q, results: GOOD }; } };

  let metered_calls = 0;
  const good_metered: SearchProvider = {
    name: 'metered',
    async search(q) { metered_calls++; return { query: q, results: GOOD }; },
  };
  const junk_metered: SearchProvider = {
    name: 'metered',
    async search(q) { metered_calls++; return { query: q, results: JUNK }; },
  };

  // Free returns a FULL page of bot-wall junk — the old empty-array gate missed this.
  metered_calls = 0;
  _test_reset({ providers: [junk_free, good_metered], embedder: scoring_embedder });
  let r = await run_search('quality junk', 5);
  check('POOR free results (non-empty) escalate to metered', metered_calls === 1);
  check('escalation returns the better set', r.results[0]?.title.includes('relevant') === true);

  // Free results are good → never pay.
  metered_calls = 0;
  _test_reset({ providers: [good_free, good_metered], embedder: scoring_embedder });
  await run_search('quality good', 5);
  check('GOOD free results do NOT escalate', metered_calls === 0);

  // Escalation that does not actually improve things must not degrade the answer.
  metered_calls = 0;
  _test_reset({ providers: [junk_free, junk_metered], embedder: scoring_embedder });
  r = await run_search('quality both junk', 5);
  check('metered no better → keeps free results', metered_calls === 1 && r.results.length === JUNK.length);

  // Kill switch.
  process.env.HEARTH_SEARCH_QUALITY_FLOOR = '0';
  metered_calls = 0;
  _test_reset({ providers: [junk_free, good_metered], embedder: scoring_embedder });
  await run_search('quality disabled', 5);
  check('HEARTH_SEARCH_QUALITY_FLOOR=0 → no quality escalation', metered_calls === 0);
  delete process.env.HEARTH_SEARCH_QUALITY_FLOOR;
}

/* ------------------------------------------------------------------ */
/* Outage must NOT read as "the web has nothing on this"               */
/* ------------------------------------------------------------------ */
{
  const outage: SearchProvider = {
    name: 'free',
    async search(q) { return { query: q, results: [], error: 'SearXNG returned no results and every engine failed (bing: timeout)' }; },
  };
  const genuine_empty: SearchProvider = {
    name: 'free',
    async search(q) { return { query: q, results: [] }; },
  };
  _test_reset({ providers: [outage] });
  const r1 = await run_search('obscure thing', 5);
  check('search OUTAGE surfaces an error, not a silent empty', r1.error !== undefined);

  _test_reset({ providers: [genuine_empty] });
  const r2 = await run_search('obscure thing', 5);
  check('genuine no-hits stays a normal empty response', r2.error === undefined && r2.results.length === 0);
}

console.log(failures === 0 ? '\nsmoke:search-router OK' : `\nsmoke:search-router FAILED (${failures} check(s))`);
process.exit(failures === 0 ? 0 : 1);
