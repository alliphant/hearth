/**
 * search_router — the cache + rerank + provider layer behind `web_search`
 * (2026-06-19).
 *
 * Every agent's web search (74 call sites + the deep-research fan-out) flows
 * through `run_search`. It does three things the bare SearXNG → Brave call
 * never did:
 *
 *   1. CACHE — a process-local LRU over the normalized query (mirrors
 *      maps_cache), with RETENTION and FRESHNESS split apart (2026-07-28).
 *      Retention is long (24 h); each caller states how stale an answer it will
 *      accept via `max_age_ms`, defaulting to the old 30 minutes. Before the
 *      split both were one 30-minute number, which meant the once-daily
 *      background sweeps — the traffic generating nearly all the provider cost
 *      — could never hit the cache at all.
 *   2. SEMANTIC COLLAPSE (2026-07-28) — on an exact miss, the normalized query
 *      is embedded and matched against cached queries above a high cosine
 *      floor. This folds hand-written phrasing variants of one intent (the
 *      background seed lists are full of them) into a single provider call.
 *      Fail-open: embedder off/down → ordinary miss.
 *   3. RERANK — the bge cross-encoder already running on the A4000 (infinity
 *      `/rerank`, via `Embedder.rerank`) reorders the provider's top-20 by
 *      relevance to OUR exact query, so each search fetches the right sources
 *      instead of trusting the provider's keyword order. Fail-open: rerank
 *      down → provider order.
 *   4. PROVIDER CHAIN — ordered, first-that-returns-results wins. SearXNG
 *      (free engines) is index 0; the METERED BraveProvider is appended only
 *      when BRAVE_SEARCH_API_KEY is set, so it is reached only when the free
 *      engines come back empty. Brave used to live INSIDE SearXNG as a keyed
 *      engine, where "last resort" is inexpressible — SearXNG fans out to all
 *      enabled engines in parallel, so every search hit the metered API.
 *
 * The cache stores the RERANKED top-20, so a repeat query is free — no provider
 * call, no GPU. One entry serves every caller's `max_results` (slice on read).
 *
 * NOT a cordon concern: search results are PUBLIC web content. The cache key
 * is the query string (in-process only); this layer never touches user-scoped
 * data. Fail-open + kill-switched end to end:
 *   - HEARTH_SEARCH_CACHE=0          → no caching (every call hits the provider)
 *   - HEARTH_SEARCH_RERANK=0         → provider order (no rerank)
 *   - HEARTH_SEARCH_SEMANTIC_CACHE=0 → exact-match cache only
 *   - HEARTH_SEARCH_BRAVE=0          → SearXNG only, never the metered fallback
 */
import { safe_fetch } from './_audit';
import type { Embedder } from '@core/embeddings';

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface SearchResponse {
  query: string;
  results: SearchResult[];
  error?: string;
}

export interface SearchProvider {
  readonly name: string;
  /** Return up to `max_results` results, or `{results:[],error}` on failure. */
  search(query: string, max_results: number): Promise<SearchResponse>;
}

export interface SearchOptions {
  /**
   * How stale a cached answer this caller will accept, in ms. Defaults to 30
   * minutes — the old global TTL — so untouched call sites behave identically.
   *
   * Scheduled background sweeps should pass `BACKGROUND_MAX_AGE_MS`: they
   * re-run the SAME hand-written seed queries daily against sources that change
   * on a weekly-or-slower cadence, so insisting on 30-minute freshness bought
   * nothing and guaranteed a provider call every single time.
   */
  max_age_ms?: number;
}

/* ------------------------------------------------------------------ */
/* SearXNG provider (the SearXNG → keyed-Brave path, lifted from       */
/* searxng.ts so web_search becomes a thin delegate)                   */
/* ------------------------------------------------------------------ */

const SEARXNG_BASE_URL = process.env.SEARXNG_BASE_URL ?? 'http://localhost:8888';

export class SearxngProvider implements SearchProvider {
  readonly name = 'searxng';

  async search(query: string, max_results: number): Promise<SearchResponse> {
    const url = new URL(`${SEARXNG_BASE_URL.replace(/\/$/, '')}/search`);
    url.searchParams.set('q', query);
    url.searchParams.set('format', 'json');
    const res = await safe_fetch(url.toString(), { method: 'GET' });
    if (!res.ok) {
      return {
        query,
        results: [],
        error: res.error ?? `SearXNG HTTP ${res.status}: ${res.body.slice(0, 200)}`,
      };
    }
    try {
      const json = JSON.parse(res.body) as {
        results?: Array<{ title?: string; url?: string; content?: string }>;
        unresponsive_engines?: unknown[];
      };
      const results = (json.results ?? [])
        .slice(0, max_results)
        .map((r) => ({ title: r.title ?? '', url: r.url ?? '', snippet: r.content ?? '' }))
        .filter((r) => r.url.length > 0);

      // DISTINGUISH "the web has nothing" FROM "search is down".
      //
      // SearXNG answers HTTP 200 with `results: []` in BOTH cases, which is how a
      // total search outage reached specialists as a confident, sourceless "there's
      // nothing on this" — the worst possible failure shape. `unresponsive_engines`
      // is the signal that separates them: zero results while engines reported
      // failures means the ENGINES failed, not that the web is empty. Zero results
      // with engines answering fine is a genuine no-hits answer and must stay a
      // normal empty response, or every obscure query would cry outage.
      if (results.length === 0 && (json.unresponsive_engines?.length ?? 0) > 0) {
        const names = json.unresponsive_engines!
          .map((e) => (Array.isArray(e) ? e.join(': ') : String(e)))
          .join('; ');
        return {
          query,
          results: [],
          error: `SearXNG returned no results and every engine failed (${names})`,
        };
      }
      return { query, results };
    } catch (err) {
      return {
        query,
        results: [],
        error: `Failed to parse SearXNG response: ${(err as Error).message}`,
      };
    }
  }
}

/* ------------------------------------------------------------------ */
/* Brave provider — the METERED LAST RESORT                            */
/* ------------------------------------------------------------------ */

/**
 * Brave Search API, positioned SECOND in the provider chain so it is reached
 * only when SearXNG's free engines return nothing.
 *
 * WHY THIS EXISTS AS A PROVIDER RATHER THAN A SearXNG ENGINE (2026-07-28):
 * Brave used to be wired as a keyed `braveapi` engine INSIDE SearXNG, with
 * google + duckduckgo disabled alongside it. That configuration cannot express
 * "last resort": SearXNG fans out to every enabled engine in PARALLEL and
 * merges, so the metered API was hit on every single search — a live query
 * returned 20/20 results from `braveapi`. Combined with the background sweeps
 * (Kristi's 63 seed queries × 4 daily slots, plus Cordelia/Kate research
 * fan-out), that is what drove the API bill.
 *
 * The provider chain below already had exactly the right semantics — "first
 * provider that returns results wins" — so moving Brave up here turns it into a
 * genuine fallback: free engines first, metered only when they come back empty.
 *
 * Kill switch: unset BRAVE_SEARCH_API_KEY (or HEARTH_SEARCH_BRAVE=0) and the
 * chain is SearXNG-only.
 */
const BRAVE_ENDPOINT = 'https://api.search.brave.com/res/v1/web/search';

export class BraveProvider implements SearchProvider {
  readonly name = 'brave';
  constructor(private readonly api_key: string) {}

  async search(query: string, max_results: number): Promise<SearchResponse> {
    const url = new URL(BRAVE_ENDPOINT);
    url.searchParams.set('q', query);
    // Brave caps `count` at 20, which is exactly our OVERFETCH.
    url.searchParams.set('count', String(Math.min(max_results, 20)));
    const res = await safe_fetch(url.toString(), {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        'X-Subscription-Token': this.api_key,
      },
    });
    if (!res.ok) {
      return {
        query,
        results: [],
        error: res.error ?? `Brave HTTP ${res.status}: ${res.body.slice(0, 200)}`,
      };
    }
    try {
      const json = JSON.parse(res.body) as {
        web?: { results?: Array<{ title?: string; url?: string; description?: string }> };
      };
      const results = (json.web?.results ?? [])
        .slice(0, max_results)
        .map((r) => ({ title: r.title ?? '', url: r.url ?? '', snippet: r.description ?? '' }))
        .filter((r) => r.url.length > 0);
      return { query, results };
    } catch (err) {
      return {
        query,
        results: [],
        error: `Failed to parse Brave response: ${(err as Error).message}`,
      };
    }
  }
}

/** Build the ordered chain from env. SearXNG (free) always first; Brave only
 *  when a key is present and not killed. */
function default_providers(): SearchProvider[] {
  const chain: SearchProvider[] = [new SearxngProvider()];
  const key = process.env.BRAVE_SEARCH_API_KEY?.trim();
  if (key && process.env.HEARTH_SEARCH_BRAVE !== '0') chain.push(new BraveProvider(key));
  return chain;
}

/* ------------------------------------------------------------------ */
/* LRU+TTL cache (mirrors maps_cache.ts), typed to SearchResult[]      */
/* ------------------------------------------------------------------ */

interface CacheEntry {
  value: SearchResult[];
  /** Hard retention deadline — when the entry is evicted regardless of who asks. */
  expires_at: number;
  /** When the provider actually answered. Freshness is judged per CALLER against
   *  this (see `max_age_ms`), which is what lets a background sweep reuse a
   *  day-old answer while a chat turn still insists on a recent one. */
  stored_at: number;
  /** Embedding of the normalized query, for near-duplicate collapse. Undefined
   *  when the embedder is off or the embed call failed (fail-open). */
  vec?: number[];
}

/** Cosine similarity. Vectors from the same model are same-length; a length
 *  mismatch (model swapped mid-process) returns -1 so it can never match. */
function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return -1;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  if (na === 0 || nb === 0) return -1;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

class SearchCache {
  private map = new Map<string, CacheEntry>();
  constructor(
    private max_entries: number,
    private ttl_ms: number,
  ) {}

  /**
   * Exact lookup. `max_age_ms` is the CALLER's freshness requirement — an entry
   * older than that is a miss for this caller but stays cached for others whose
   * tolerance is looser. This split is the point: retention (ttl_ms) and
   * freshness (max_age_ms) used to be the same 30-minute number, which meant a
   * once-daily background sweep could never hit the cache at all.
   */
  get(key: string, max_age_ms: number): SearchResult[] | undefined {
    // max_age_ms <= 0 is an explicit "force fresh" — never serve a cached
    // answer, even one stored microseconds ago. Without this special case a
    // same-millisecond repeat would still hit (0 - 0 > 0 is false), making
    // "force fresh" silently timing-dependent.
    if (max_age_ms <= 0) return undefined;
    const e = this.map.get(key);
    if (!e) return undefined;
    const now = Date.now();
    if (now > e.expires_at) {
      this.map.delete(key);
      return undefined;
    }
    if (now - e.stored_at > max_age_ms) return undefined; // too stale for THIS caller
    this.map.delete(key);
    this.map.set(key, e); // touch → most-recently-used
    return e.value;
  }

  /**
   * Nearest cached entry by query embedding, if it clears `threshold` and is
   * fresh enough for this caller. This is what collapses the hand-written
   * near-duplicates in the background seed lists — e.g. Kristi's
   *   'Dell Precision tower workstation lineup specifications site:dell.com'
   *   'Dell Pro Precision tower workstation lineup specifications site:dell.com'
   * which are distinct strings, miss an exact-match cache, and each cost a
   * provider call for near-identical results.
   */
  get_semantic(
    vec: number[],
    threshold: number,
    max_age_ms: number,
  ): { value: SearchResult[]; key: string; score: number } | undefined {
    if (max_age_ms <= 0) return undefined; // force-fresh, same as get()
    const now = Date.now();
    let best: { value: SearchResult[]; key: string; score: number } | undefined;
    for (const [key, e] of this.map) {
      if (now > e.expires_at) continue;
      if (now - e.stored_at > max_age_ms) continue;
      if (!e.vec) continue;
      const score = cosine(vec, e.vec);
      if (score >= threshold && (!best || score > best.score)) {
        best = { value: e.value, key, score };
      }
    }
    return best;
  }

  set(key: string, value: SearchResult[], vec?: number[]): void {
    if (this.map.has(key)) this.map.delete(key);
    const now = Date.now();
    this.map.set(key, { value, expires_at: now + this.ttl_ms, stored_at: now, vec });
    while (this.map.size > this.max_entries) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }

  clear(): void {
    this.map.clear();
  }
  size(): number {
    return this.map.size;
  }
}

/* ------------------------------------------------------------------ */
/* Tunables (read at call time for the kill switches)                  */
/* ------------------------------------------------------------------ */

function cache_enabled(): boolean {
  return process.env.HEARTH_SEARCH_CACHE !== '0';
}
function rerank_enabled(): boolean {
  return process.env.HEARTH_SEARCH_RERANK !== '0';
}
function semantic_cache_enabled(): boolean {
  return process.env.HEARTH_SEARCH_SEMANTIC_CACHE !== '0';
}
function int_env(name: string, dflt: number): number {
  const raw = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : dflt;
}
function float_env(name: string, dflt: number): number {
  const raw = Number.parseFloat(process.env[name] ?? '');
  return Number.isFinite(raw) ? raw : dflt;
}

/** Over-fetch this many from the provider, cache + rerank them once, then
 *  slice to each caller's max_results — so one entry serves everyone. */
const OVERFETCH = 20;

/**
 * Default freshness for a caller that doesn't state one — deliberately the old
 * 30-minute TTL, so every existing call site behaves exactly as before. Only
 * callers that opt in (the background sweeps) get the long window.
 */
const DEFAULT_MAX_AGE_MS = 30 * 60_000;

/**
 * Freshness for scheduled background sweeps — vendor spec sheets, cert
 * registries and the like, whose sources change on a weekly-or-slower cadence.
 *
 * BE PRECISE ABOUT WHAT THIS DOES AND DOESN'T BUY, because the obvious reading
 * is wrong: at just under 24 h it does NOT make a once-daily sweep free. A
 * query re-issued 24 h later is older than this window, so it correctly misses
 * and re-fetches. That is deliberate — a DAILY DISCOVERY sweep that served
 * yesterday's cached results could never discover anything new, which is the
 * entire point of running it.
 *
 * What it does buy:
 *   - intra-day repeats (scan_cert_registries runs 06:40 AND 16:40 — the second
 *     run now reuses the first),
 *   - manual re-runs, retries after a partial failure, and overlapping
 *     scheduled slots that share queries,
 *   - any caller that re-asks the same thing inside the day.
 * The big per-run savings come from the search budget + bucket rotation in the
 * sweeps themselves, and from semantic collapse of near-duplicate phrasings —
 * not from this.
 */
export const BACKGROUND_MAX_AGE_MS = int_env(
  'HEARTH_SEARCH_BACKGROUND_MAX_AGE_MS',
  22 * 3_600_000,
);

/** Cosine floor for near-duplicate collapse. Deliberately high: a false match
 *  silently serves the WRONG results, which is far worse than paying for one
 *  more query. 0.97 collapses hand-written phrasing variants of one intent
 *  without merging genuinely different questions. */
function semantic_threshold(): number {
  return float_env('HEARTH_SEARCH_SEMANTIC_THRESHOLD', 0.97);
}

/**
 * Relevance floor below which the free provider's results are considered
 * useless enough to justify the metered fallback.
 *
 * "Returned nothing" is too crude a gate on its own: free engines can answer
 * with a full page of off-topic filler, or with a bot-wall interstitial, and an
 * empty-array check sails straight past both.
 *
 * CALIBRATED, NOT GUESSED. Measured against the live reranker
 * (BAAI/bge-reranker-v2-m3 on the infinity server, which returns sigmoid 0..1
 * scores) for the query "fort collins colorado news":
 *   genuinely relevant results       0.994 / 0.986 / 0.776
 *   topically adjacent (Denver Post) 0.001
 *   unrelated junk                   0.000
 *   Cloudflare / "Access denied"     0.000
 * The gap between a real answer and a useless one is ~3 orders of magnitude, so
 * any floor in 0.05–0.5 separates them cleanly. 0.10 is deliberately near the
 * bottom of that band: this gate SPENDS MONEY when it fires, so it should catch
 * only genuinely worthless result sets, never merely mediocre ones.
 *
 * Set HEARTH_SEARCH_QUALITY_FLOOR=0 to disable quality-based escalation
 * entirely (empty/error escalation still applies).
 */
function quality_floor(): number {
  return float_env('HEARTH_SEARCH_QUALITY_FLOOR', 0.1);
}

/* ------------------------------------------------------------------ */
/* Module state (singleton, like maps_cache / configure_push)          */
/* ------------------------------------------------------------------ */

let _embedder: Embedder | null = null;
let _providers: SearchProvider[] | null = null;
let _cache = new SearchCache(
  int_env('HEARTH_SEARCH_CACHE_MAX', 500),
  // RETENTION, not freshness. Raised from 30 min to 24 h now that callers state
  // their own freshness need via `max_age_ms` — a long-retained entry costs a
  // little memory and can save a metered provider call; it can never serve a
  // caller staler results than that caller asked for.
  int_env('HEARTH_SEARCH_CACHE_TTL_MS', 24 * 3_600_000),
);
const _stats = {
  hits: 0,
  semantic_hits: 0,
  misses: 0,
  reranks: 0,
  errors: 0,
  /** Times the metered fallback provider actually answered. This is THE number
   *  to watch when checking that free-first is working. */
  fallback_used: 0,
  /** Subset of fallback_used triggered by POOR free results rather than none. */
  fallback_quality: 0,
};

/** Providers are built lazily so BRAVE_SEARCH_API_KEY is read after boot env
 *  is loaded, not at module-import time. */
function providers(): SearchProvider[] {
  if (!_providers) _providers = default_providers();
  return _providers;
}

/**
 * Inject the boot embedder (for rerank) and optionally override providers.
 * Called once at orchestrator boot, next to make_embedder. No-op-safe to call
 * with neither.
 */
export function configure_search(opts: { embedder?: Embedder; providers?: SearchProvider[] }): void {
  if (opts.embedder) _embedder = opts.embedder;
  if (opts.providers) _providers = opts.providers;
}

function normalize_query(q: string): string {
  return q.trim().toLowerCase().replace(/\s+/g, ' ');
}

/** Reorder by cross-encoder relevance to the query. Fail-open: a null score
 *  set (rerank disabled / embedder off / endpoint down) keeps provider order,
 *  and the result SET is never changed — only its order. */
async function rerank_results(
  query: string,
  results: SearchResult[],
): Promise<{ results: SearchResult[]; top_score: number | null }> {
  if (!rerank_enabled() || !_embedder?.enabled || results.length === 0) {
    return { results, top_score: null };
  }
  const docs = results.map((r) => `${r.title} ${r.snippet}`.trim());
  let scores: number[] | null = null;
  try {
    scores = await _embedder.rerank(query, docs);
  } catch {
    scores = null;
  }
  if (!scores) return { results, top_score: null };
  _stats.reranks++;
  const ordered = results
    .map((r, i) => ({ r, s: scores![i] ?? Number.NEGATIVE_INFINITY }))
    .sort((a, b) => b.s - a.s);
  const top = ordered[0]?.s;
  return {
    results: ordered.map((x) => x.r),
    // The scores were previously computed and THROWN AWAY after sorting. They
    // are the only quality signal we have about a result set, and they're free
    // — we already pay for the rerank on every search.
    top_score: typeof top === 'number' && Number.isFinite(top) ? top : null,
  };
}

/**
 * The one entry point `web_search` delegates to. Cache → provider → rerank.
 * Returns the same shape `web_search` always did.
 */
export async function run_search(
  query: string,
  max_results: number,
  opts: SearchOptions = {},
): Promise<SearchResponse> {
  const key = normalize_query(query);
  const max_age = opts.max_age_ms ?? DEFAULT_MAX_AGE_MS;

  if (cache_enabled()) {
    const hit = _cache.get(key, max_age);
    if (hit) {
      _stats.hits++;
      return { query, results: hit.slice(0, max_results) };
    }
  }

  // Near-duplicate collapse. Only worth an embed call when we're otherwise
  // about to pay a provider (possibly metered) call, so it sits AFTER the
  // exact-match miss. Fail-open at every step: no embedder, a throw, or no
  // match above threshold all fall through to a normal provider search.
  let vec: number[] | undefined;
  if (cache_enabled() && semantic_cache_enabled() && _embedder?.enabled) {
    try {
      const [v] = await _embedder.embed([key]);
      if (v && v.length > 0) {
        vec = v;
        const near = _cache.get_semantic(v, semantic_threshold(), max_age);
        if (near) {
          _stats.semantic_hits++;
          return { query, results: near.value.slice(0, max_results) };
        }
      }
    } catch {
      // embedder down → no semantic collapse this call, nothing else changes
    }
  }

  _stats.misses++;

  // Provider chain — FIRST PROVIDER THAT RETURNS RESULTS WINS. That ordering is
  // what makes free-first real: SearXNG (free engines) is index 0, and the
  // metered Brave provider is only reached when SearXNG errors or comes back
  // empty. See BraveProvider for why this belongs here and not inside SearXNG.
  const chain = providers();
  const free = chain[0]!;
  let resp: SearchResponse = await free.search(query, OVERFETCH);

  // Rank the free provider's answer and READ ITS QUALITY before deciding
  // whether the metered fallback is warranted.
  let ranked = await rerank_results(query, resp.results);

  const fallback = chain[1];
  if (fallback) {
    // Two DIFFERENT reasons to escalate, and the second is the point of this
    // block. "Returned nothing" is a crude gate: free engines can answer with a
    // full page of results that are useless — off-topic filler, or a bot-wall
    // interstitial, which the reranker scores at ~0.000. Escalating only on an
    // empty array would sail straight past that and hand the specialist junk.
    const empty = !!resp.error || resp.results.length === 0;
    const poor =
      !empty && ranked.top_score !== null && ranked.top_score < quality_floor();

    if (empty || poor) {
      const reason = empty
        ? resp.error
          ? `free provider errored (${resp.error})`
          : 'free provider returned no results'
        : `free results scored ${ranked.top_score!.toFixed(3)} < floor ${quality_floor()}`;
      const alt = await fallback.search(query, OVERFETCH);
      if (!alt.error && alt.results.length > 0) {
        const alt_ranked = await rerank_results(query, alt.results);
        // Keep whichever set actually scores better. On a POOR (not empty)
        // escalation the free results are a real answer, just a weak one — if
        // the metered provider does no better we must not degrade the answer
        // merely because we paid for it. Null scores (reranker down) mean we
        // cannot compare, so prefer the fallback only when free was empty.
        const better =
          empty ||
          (alt_ranked.top_score !== null &&
            ranked.top_score !== null &&
            alt_ranked.top_score > ranked.top_score);
        if (better) {
          resp = alt;
          ranked = alt_ranked;
          _stats.fallback_used++;
          if (poor) _stats.fallback_quality++;
          console.log(
            `[search] escalated to '${fallback.name}' (metered): ${reason}` +
              (alt_ranked.top_score !== null
                ? `; fallback scored ${alt_ranked.top_score.toFixed(3)}`
                : ''),
          );
        } else {
          console.log(
            `[search] escalation to '${fallback.name}' did NOT beat the free results; keeping free`,
          );
        }
      }
    }
  }

  if (resp.error) {
    _stats.errors++;
    return { query, results: resp.results, error: resp.error };
  }
  // NEVER cache an empty result set. `[]` is truthy, so a cached empty entry
  // came back from `get()` as a HIT with no error field — every caller for the
  // whole retention window saw a confident "the web has nothing on this"
  // instead of retrying. That is the worst possible failure shape here: with
  // free-first, an empty set is exactly what a rate-limited or capped provider
  // returns, so caching it would turn a transient outage into a silent,
  // self-reinforcing blackout. Errors were already excluded above; this closes
  // the same hole for the success-with-no-results path.
  if (cache_enabled() && ranked.results.length > 0) _cache.set(key, ranked.results, vec);
  return { query, results: ranked.results.slice(0, max_results) };
}

/** Observability — hit/miss/rerank counters + live cache size. `fallback_used`
 *  is the one to watch: it counts how often the METERED provider was actually
 *  needed, i.e. how often the free engines came back empty. */
export function search_stats(): {
  hits: number;
  semantic_hits: number;
  misses: number;
  reranks: number;
  errors: number;
  fallback_used: number;
  fallback_quality: number;
  cache_size: number;
  providers: string[];
} {
  return { ..._stats, cache_size: _cache.size(), providers: providers().map((p) => p.name) };
}

/** Test seam — reset the singleton (inject a fake provider/embedder, set a
 *  short TTL for expiry tests). */
export function _test_reset(opts?: {
  embedder?: Embedder | null;
  providers?: SearchProvider[];
  ttl_ms?: number;
  max?: number;
}): void {
  _embedder = opts?.embedder ?? null;
  _providers = opts?.providers ?? [new SearxngProvider()];
  _cache = new SearchCache(opts?.max ?? 500, opts?.ttl_ms ?? 24 * 3_600_000);
  _stats.hits = 0;
  _stats.semantic_hits = 0;
  _stats.misses = 0;
  _stats.reranks = 0;
  _stats.errors = 0;
  _stats.fallback_used = 0;
  _stats.fallback_quality = 0;
}
