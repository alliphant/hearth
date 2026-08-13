/**
 * sources_store — the ONE definition of Cordelia's curated trusted-source
 * list at Knowledge/Cordelia/sources.md (knowledge metabolism #2,
 * 2026-06-10).
 *
 * Storage is unchanged from add_trusted_source's original design: a single
 * markdown note whose frontmatter `sources:` array is the authoritative
 * list — no `type:` field, so the ingestor leaves it alone, and the whole
 * thing stays hand-editable in Obsidian (Jasper prunes by deleting lines).
 *
 * What 2026-06-10 ADDS is the subscription extension: an entry may carry
 * `specialist_id` + `cadence` (+ optional `tier`, `seeded_by`, and the
 * crawl state `last_crawled_at` / `last_content_hash`), turning it into a
 * SOURCE SUBSCRIPTION that Cordelia's nightly `refresh_subscriptions`
 * background job re-fetches on cadence, hash-diffs, and shelves onto the
 * owning specialist's library when the content changed. A plain entry
 * (no cadence) behaves exactly as before.
 *
 * Both legacy tools (add_trusted_source / list_trusted_sources) and every
 * new consumer read/write through this module — three private copies of
 * the parser was already one too many.
 */
import { createHash } from 'node:crypto';
import type { MemoryClient } from '@memory/client';
import type { LoadedSpecialist } from '@core/specialist';
import { resolve_trust_tier } from '@core/specialist';

export const SOURCES_PATH = 'Knowledge/Cordelia/sources.md';

export type SubscriptionCadence = 'daily' | 'weekly' | 'monthly' | 'quarterly';

export const CADENCE_DAYS: Record<SubscriptionCadence, number> = {
  // daily + the 6h due-slack ⇒ an 18h minimum gap, so the 03:40 nightly
  // job fires a daily subscription every night without drifting.
  daily: 1,
  weekly: 7,
  monthly: 30,
  quarterly: 90,
};

const CADENCES = new Set<string>(['daily', 'weekly', 'monthly', 'quarterly']);

export interface TrustedSourceEntry {
  url: string;
  domain: string;
  description: string | null;
  tags: string[];
  added: string;
  /** Subscription extension (all optional — absent ≡ plain curated URL). */
  /** Owning shelf: refreshed content lands on this specialist's library. */
  specialist_id?: string;
  /** Refresh cadence. Present (with specialist_id) ⇒ this is a subscription. */
  cadence?: SubscriptionCadence;
  /** Trust tier stamped on shelved refreshes. Absent → resolve from the
   *  target's trusted_sources manifest at shelve time. */
  tier?: 1 | 2;
  /** Provenance of seeded entries, e.g. 'fable-5-2026-06-10'. */
  seeded_by?: string;
  /** ISO UTC of the last refresh attempt that reached the source. */
  last_crawled_at?: string;
  /** sha256 hex of the last successfully fetched content — the diff key. */
  last_content_hash?: string;
  /**
   * Fetch strategy override (2026-06-10). 'browser' = go straight to
   * the workstation's warmed Firefox (skipping Firecrawl) — for paywalled /
   * login-gated sources whose value depends on the profile being signed
   * in (NYT with Jasper's subscription), and for sites whose Firecrawl
   * extraction is known-broken. Absent = the default Firecrawl-first
   * path with bot-block escalation.
   */
  fetch_via?: 'browser';
  /**
   * News Desk grouping key (2026-06-10) — 'world', 'texas-politics',
   * 'ai', 'gaming', … Cross-rack: the desk groups by category over ALL
   * subscriptions regardless of which specialist's shelf they feed, so
   * Kristi's workstation feeds and Ruby's Colorado Sun appear under
   * their cloud words without violating one-URL-one-rack.
   */
  category?: string;
  /**
   * Paused subscriptions are skipped by the nightly refresh entirely
   * (never due). The News Desk's word-cloud gear toggles this per
   * category; entries stay in the list so resuming is one flip.
   */
  paused?: boolean;
}

export const BODY_TEMPLATE = `# Cordelia's curated sources

URLs Jasper has flagged as good first-stops when searching for documents,
ebooks, datasets, or primary material. Cordelia consults this list before
any open-web search and prefers candidates from these domains.

Entries with \`specialist_id\` + \`cadence\` are SOURCE SUBSCRIPTIONS —
Cordelia's nightly refresh re-fetches them on cadence and shelves changed
content onto the owning specialist's library. Delete an entry to
unsubscribe.

The authoritative list lives in this file's frontmatter (\`sources:\`).
Edit there if you want to reorder, annotate, or remove an entry.
`;

export function domain_of(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./i, '');
  } catch {
    return '';
  }
}

export function read_sources(memory: MemoryClient): TrustedSourceEntry[] {
  const note = memory.read_note(SOURCES_PATH);
  if (!note) return [];
  const raw = (note.frontmatter as { sources?: unknown }).sources;
  if (!Array.isArray(raw)) return [];
  const out: TrustedSourceEntry[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    if (typeof rec.url !== 'string') continue;
    const entry: TrustedSourceEntry = {
      url: rec.url,
      domain: typeof rec.domain === 'string' ? rec.domain : domain_of(rec.url),
      description: typeof rec.description === 'string' ? rec.description : null,
      tags: Array.isArray(rec.tags)
        ? rec.tags.filter((t): t is string => typeof t === 'string')
        : [],
      added: typeof rec.added === 'string' ? rec.added : new Date().toISOString(),
    };
    if (typeof rec.specialist_id === 'string' && rec.specialist_id.length > 0) {
      entry.specialist_id = rec.specialist_id;
    }
    if (typeof rec.cadence === 'string' && CADENCES.has(rec.cadence)) {
      entry.cadence = rec.cadence as SubscriptionCadence;
    }
    if (rec.tier === 1 || rec.tier === 2) entry.tier = rec.tier;
    if (typeof rec.seeded_by === 'string') entry.seeded_by = rec.seeded_by;
    if (typeof rec.last_crawled_at === 'string') {
      entry.last_crawled_at = rec.last_crawled_at;
    }
    if (typeof rec.last_content_hash === 'string') {
      entry.last_content_hash = rec.last_content_hash;
    }
    if (rec.fetch_via === 'browser') entry.fetch_via = 'browser';
    if (typeof rec.category === 'string' && rec.category.length > 0) {
      entry.category = rec.category;
    }
    if (rec.paused === true) entry.paused = true;
    out.push(entry);
  }
  return out;
}

/** Persist the full list, preserving any hand-written note body. */
export function write_sources(memory: MemoryClient, entries: TrustedSourceEntry[]): void {
  const existing_note = memory.read_note(SOURCES_PATH);
  const body = existing_note?.body.trim() ? existing_note.body : BODY_TEMPLATE;
  memory.upsert_note(
    SOURCES_PATH,
    { sources: entries, last_updated: new Date().toISOString() },
    body,
  );
}

/**
 * Idempotent upsert keyed on URL — re-adding refreshes the entry's
 * metadata in place (the `added` stamp and any crawl state survive).
 */
export function upsert_source(
  memory: MemoryClient,
  next: Omit<TrustedSourceEntry, 'domain' | 'added'> & { added?: string },
): { action: 'added' | 'updated'; total: number; entry: TrustedSourceEntry } {
  const domain = domain_of(next.url);
  if (!domain) {
    throw new Error(`sources_store: could not parse URL "${next.url}"`);
  }
  const entries = read_sources(memory);
  const idx = entries.findIndex((s) => s.url === next.url);
  const prior = idx >= 0 ? entries[idx] : undefined;
  // Strip keys a caller passed as `undefined` — a plain re-add
  // (add_trusted_source with no subscription fields) must not wipe an
  // existing subscription's cadence/owner, and YAML stringify chokes on
  // explicit undefined values.
  const patch = Object.fromEntries(
    Object.entries(next).filter(([, v]) => v !== undefined),
  ) as Partial<TrustedSourceEntry> & { url: string };
  const entry: TrustedSourceEntry = {
    description: null,
    tags: [],
    ...prior,
    ...patch,
    domain,
    added: prior?.added ?? next.added ?? new Date().toISOString(),
    // Crawl state is machine-owned — an upsert never resets it.
    ...(prior?.last_crawled_at !== undefined
      ? { last_crawled_at: prior.last_crawled_at }
      : {}),
    ...(prior?.last_content_hash !== undefined
      ? { last_content_hash: prior.last_content_hash }
      : {}),
  };
  let action: 'added' | 'updated';
  if (idx >= 0) {
    entries[idx] = entry;
    action = 'updated';
  } else {
    entries.push(entry);
    action = 'added';
  }
  write_sources(memory, entries);
  return { action, total: entries.length, entry };
}

/** A subscription is an entry with both an owning shelf and a cadence. */
export function is_subscription(
  e: TrustedSourceEntry,
): e is TrustedSourceEntry & { specialist_id: string; cadence: SubscriptionCadence } {
  return typeof e.specialist_id === 'string' && e.cadence !== undefined;
}

/** 6h slack so a nightly 03:40 job vs. a 03:41 crawl last week still
 *  counts as "a week later" — without it, weekly drifts to 8 days. */
const DUE_SLACK_MS = 6 * 3_600_000;

export function is_due(
  e: TrustedSourceEntry & { cadence: SubscriptionCadence },
  now: Date,
): boolean {
  if (!e.last_crawled_at) return true;
  const last = Date.parse(e.last_crawled_at);
  if (Number.isNaN(last)) return true;
  return now.getTime() - last >= CADENCE_DAYS[e.cadence] * 86_400_000 - DUE_SLACK_MS;
}

/** Due subscriptions, never-crawled first, then oldest crawl first —
 *  so a capped pass services the most-starved sources. */
export function subscriptions_due(
  entries: TrustedSourceEntry[],
  now: Date,
): Array<TrustedSourceEntry & { specialist_id: string; cadence: SubscriptionCadence }> {
  return entries
    .filter(is_subscription)
    .filter((e) => e.paused !== true) // paused = never due (Desk gear toggle)
    .filter((e) => is_due(e, now))
    .sort((a, b) => {
      const la = a.last_crawled_at ?? '';
      const lb = b.last_crawled_at ?? '';
      return la === lb ? (a.url < b.url ? -1 : 1) : la < lb ? -1 : 1;
    });
}

/**
 * Roster tier for a URL against a target specialist: the YAML
 * `trusted_sources` manifest first (resolve_trust_tier), then the
 * specialist's subscription entries (domain-suffix match, entry tier,
 * default 2). null = out-of-roster — acquisition must PROPOSE, not shelve.
 */
export function roster_tier(
  url: string,
  target: LoadedSpecialist,
  entries: TrustedSourceEntry[],
): 1 | 2 | null {
  const manifest = resolve_trust_tier(url, target);
  if (manifest !== null) return manifest;
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
  for (const e of entries) {
    if (!is_subscription(e) || e.specialist_id !== target.id) continue;
    const d = e.domain.toLowerCase();
    if (host === d || host.endsWith(`.${d}`)) return e.tier ?? 2;
  }
  return null;
}

/** sha256 hex of normalized content — the refresh diff key. */
export function content_hash(markdown: string): string {
  return createHash('sha256').update(markdown.trim()).digest('hex');
}

/* ------------------------------------------------------------------ */
/* Denials                                                             */
/* ------------------------------------------------------------------ */

export const DENIALS_PATH = 'Knowledge/Cordelia/trusted_source_denials.md';

/** Shape the trusted_source_addition 'reject' resolver appends:
 *  `- **<ts>** — \`<domain>\` proposed for <specialist> Tier <n>, denied.` */
const DENIAL_LINE_RE = /^\s*-\s+\*\*[^*]+\*\*\s+—\s+`([^`]+)`\s+proposed for\s+(\S+)/;

/**
 * Domains Jasper has DENIED for a target specialist — Cordelia must not
 * re-propose them (the proposal queue's dedup only covers OPEN
 * proposals; this covers decided ones). Read by every proposal-filing
 * acquisition path (acquire_knowledge, scout_sources,
 * curate_for_specialist).
 */
export function denied_domains_for(
  memory: MemoryClient,
  target_specialist_id: string,
): Set<string> {
  const note = memory.read_note(DENIALS_PATH);
  const out = new Set<string>();
  if (!note) return out;
  for (const line of note.body.split('\n')) {
    if (!line.includes('denied')) continue;
    const m = DENIAL_LINE_RE.exec(line);
    if (!m) continue;
    const domain = m[1];
    const target = m[2];
    if (!domain) continue;
    if (target === target_specialist_id) out.add(domain.toLowerCase());
  }
  return out;
}
