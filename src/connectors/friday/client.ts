/**
 * friday-writer HTTP client. Hearth's read-only window into FRIDAY's
 * data layer — JSON files at `friday_intel/*.json` and the shared
 * `friday.db` SQLite database. friday-writer is the canonical service
 * for that data (see `docker/.github/copilot-instructions.md` §Intelligence
 * Data Layer); this client wraps it with caching, schema validation,
 * and a typed surface.
 *
 * Design choices documented for the architecture-doc review:
 *
 * 1. **Read-only.** This client deliberately exposes only GETs. The
 *    friday-writer endpoint has a legacy POST hazard (a POST without
 *    `file=` overwrites friday_users.json wholesale). We never POST
 *    from Hearth tools — write paths would need their own deliberate
 *    surface with explicit guards.
 *
 * 2. **In-memory TTL cache.** Multiple specialists deliberating around
 *    the same time often want overlapping pets/yard/etc. state. A
 *    short cache absorbs that without staleness mattering for the
 *    workflows we have today.
 *
 * 3. **friday-writer has no auth on LAN.** Same-host case is fine.
 *    When we wire authenticated access (a future task), this client
 *    is the one place to add the bearer.
 */

const DEFAULT_BASE_URL =
  process.env.HEARTH_FRIDAY_WRITER_URL ?? 'http://localhost:8765';
const DEFAULT_CACHE_TTL_MS = 30_000;

export interface FridayClientOptions {
  base_url?: string;
  cache_ttl_ms?: number;
  fetch_timeout_ms?: number;
}

interface CacheEntry<T> {
  value: T;
  expires_at_ms: number;
}

export class FridayClient {
  private base_url: string;
  private cache_ttl_ms: number;
  private fetch_timeout_ms: number;
  private json_cache = new Map<string, CacheEntry<unknown>>();

  constructor(opts: FridayClientOptions = {}) {
    this.base_url = (opts.base_url ?? DEFAULT_BASE_URL).replace(/\/$/, '');
    this.cache_ttl_ms = opts.cache_ttl_ms ?? DEFAULT_CACHE_TTL_MS;
    this.fetch_timeout_ms = opts.fetch_timeout_ms ?? 4_000;
  }

  /**
   * Read a JSON file from friday-writer. `file` must include the
   * `.json` extension (e.g. `'pets_data.json'`, `'house_data.json'`)
   * — friday-writer's `?file=` param rejects bare names.
   *
   * Returns the parsed object. Cached for `cache_ttl_ms` keyed on the
   * file name. Pass `force_refresh: true` to bypass.
   */
  async read_json(
    file: string,
    opts: { force_refresh?: boolean } = {},
  ): Promise<unknown> {
    if (!file.endsWith('.json')) {
      throw new Error(
        `FridayClient.read_json: file must end with .json (got "${file}"). ` +
          `Examples: 'pets_data.json', 'house_data.json'.`,
      );
    }
    const now = Date.now();
    if (!opts.force_refresh) {
      const cached = this.json_cache.get(file);
      if (cached && cached.expires_at_ms > now) {
        return cached.value;
      }
    }
    const url = `${this.base_url}/read?file=${encodeURIComponent(file)}`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.fetch_timeout_ms);
    try {
      const resp = await fetch(url, { signal: ctrl.signal });
      if (!resp.ok) {
        const body = await resp.text().catch(() => '');
        throw new Error(
          `friday-writer GET ${file}: HTTP ${resp.status} ${resp.statusText}: ${body.slice(0, 200)}`,
        );
      }
      const parsed = await resp.json();
      this.json_cache.set(file, {
        value: parsed,
        expires_at_ms: now + this.cache_ttl_ms,
      });
      return parsed;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Execute an allowlisted SQL query against friday.db via friday-writer's
   * /db/query endpoint. Use only for SELECT — INSERT/UPDATE/DELETE
   * paths exist on the friday-writer side but Hearth tools should not
   * mutate FRIDAY's database without a dedicated, explicitly-gated
   * tool that we don't ship today.
   */
  async db_query(sql: string, params: unknown[] = []): Promise<unknown[]> {
    if (!/^\s*select\b/i.test(sql)) {
      throw new Error(
        `FridayClient.db_query: only SELECT is allowed from Hearth tools. ` +
          `Got: ${sql.slice(0, 80)}`,
      );
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.fetch_timeout_ms);
    try {
      const resp = await fetch(`${this.base_url}/db/query`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sql, params }),
        signal: ctrl.signal,
      });
      if (!resp.ok) {
        const body = await resp.text().catch(() => '');
        throw new Error(
          `friday-writer db_query: HTTP ${resp.status}: ${body.slice(0, 200)}`,
        );
      }
      const json = await resp.json() as { rows?: unknown[] } | unknown[];
      // friday-writer returns either { rows: [...] } or a bare array
      // depending on schema version — accept both shapes.
      if (Array.isArray(json)) return json;
      if (json && Array.isArray((json as { rows?: unknown[] }).rows)) {
        return (json as { rows: unknown[] }).rows;
      }
      return [];
    } finally {
      clearTimeout(timer);
    }
  }

  /** Drop all cached entries. Useful for tests; in production the TTL handles it. */
  clear_cache(): void {
    this.json_cache.clear();
  }
}

/** Shared singleton — most callers want the default instance. */
let _shared: FridayClient | null = null;
export function get_friday_client(): FridayClient {
  if (!_shared) _shared = new FridayClient();
  return _shared;
}
