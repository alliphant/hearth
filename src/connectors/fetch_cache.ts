/**
 * fetch_cache — process-local LRU+TTL cache for fetched page content
 * (2026-06-19), the sibling of search_router's query cache.
 *
 * `fetch_with_browser_fallback` (the shared Firecrawl → warmed-browser entry
 * the deep-research + commission fan-outs use) re-fetches the same URLs across
 * sub-questions, turns, and agents. Caching the cleaned markdown by URL kills
 * that re-fetch storm — no second Firecrawl/browser hit for a page already
 * read.
 *
 * Only SUCCESSFUL outcomes are cached (`firecrawl` / `browser`); `deferred`
 * (browser busy) and `failed` MUST retry, never serve from cache. Public web
 * content → no cordon concern (the key is the URL). Kill switch
 * HEARTH_FETCH_CACHE=0; TTL HEARTH_FETCH_CACHE_TTL_MS (default 6h).
 */
import type { FetchOutcome } from './fetch_with_browser_fallback';

/** The cacheable subset — a fetch that actually produced content. */
type CachedFetch = Extract<FetchOutcome, { kind: 'firecrawl' | 'browser' }>;

interface Entry {
  value: CachedFetch;
  expires_at: number;
}

class LRU {
  private map = new Map<string, Entry>();
  constructor(
    private max_entries: number,
    private ttl_ms: number,
  ) {}

  get(key: string): CachedFetch | undefined {
    const e = this.map.get(key);
    if (!e) return undefined;
    if (Date.now() > e.expires_at) {
      this.map.delete(key);
      return undefined;
    }
    this.map.delete(key);
    this.map.set(key, e);
    return e.value;
  }

  set(key: string, value: CachedFetch): void {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, { value, expires_at: Date.now() + this.ttl_ms });
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

function cache_enabled(): boolean {
  return process.env.HEARTH_FETCH_CACHE !== '0';
}
function int_env(name: string, dflt: number): number {
  const raw = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : dflt;
}

let _cache = new LRU(
  int_env('HEARTH_FETCH_CACHE_MAX', 500),
  int_env('HEARTH_FETCH_CACHE_TTL_MS', 6 * 60 * 60_000),
);

export function fetch_cache_get(url: string): CachedFetch | undefined {
  if (!cache_enabled()) return undefined;
  return _cache.get(url);
}

/** Store only successful fetches; deferred/failed are dropped (must retry). */
export function fetch_cache_put(url: string, outcome: FetchOutcome): void {
  if (!cache_enabled()) return;
  if (outcome.kind === 'firecrawl' || outcome.kind === 'browser') {
    _cache.set(url, outcome);
  }
}

export function fetch_cache_size(): number {
  return _cache.size();
}

/** Test seam. */
export function _fetch_cache_reset(opts?: { ttl_ms?: number; max?: number }): void {
  _cache = new LRU(opts?.max ?? 500, opts?.ttl_ms ?? 6 * 60 * 60_000);
}
