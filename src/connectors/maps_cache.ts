/**
 * Process-local LRU cache for maps connector calls.
 *
 * Hit rate is high because deliberation passes re-query the same places
 * (Kate routes to the same vet, the same barber). Geocode and route
 * results are stable enough at the cache TTL (24h for geocode, 1h for
 * route) that this avoids hammering the OSRM/Nominatim stack.
 *
 * Vault writeback for known Places/People (PART 5 layer B) lives in
 * maps.ts directly and uses MemoryClient methods added in PART 4.
 */

interface CacheEntry {
  value: unknown;
  expires_at: number;
}

class LRU {
  private map = new Map<string, CacheEntry>();
  constructor(
    private max_entries: number,
    private ttl_ms: number,
  ) {}

  get(key: string): unknown {
    const e = this.map.get(key);
    if (!e) return undefined;
    if (Date.now() > e.expires_at) {
      this.map.delete(key);
      return undefined;
    }
    // Touch — move to end so it's the most-recently-used.
    this.map.delete(key);
    this.map.set(key, e);
    return e.value;
  }

  set(key: string, value: unknown): void {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, { value, expires_at: Date.now() + this.ttl_ms });
    while (this.map.size > this.max_entries) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }

  /** Test-only. */
  clear(): void {
    this.map.clear();
  }

  size(): number {
    return this.map.size;
  }
}

export const maps_cache = new LRU(1000, 24 * 60 * 60 * 1000);
