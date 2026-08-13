/**
 * news_desk — compose logic for the News Desk tab in Kate's office
 * (2026-06-10).
 *
 * The desk is a CROSS-RACK display surface: it groups every categorized
 * source subscription (sources_store `category`) regardless of which
 * specialist's shelf the content feeds — Kristi's workstation feeds and
 * Ruby's Colorado Sun appear under their cloud words without violating
 * one-URL-one-rack. Headlines come from the `news_items` table the
 * feed-aware refresh populates; page-shaped (non-feed) subscriptions
 * still count in the cloud but contribute shelf digests rather than
 * discrete headlines.
 *
 * The word cloud has three states:
 *   - active  — categories with live subscriptions (size ∝ 7-day volume)
 *   - paused  — owner toggled off via the gear (refresh skips them)
 *   - offered — curated bundles Jasper can switch ON from the cloud
 *               (activation seeds their subscriptions); plus free-text
 *               "track something new" which runs Cordelia's
 *               scout_sources → proposals → approval auto-subscribes.
 *
 * Entertainment taste boost: watched titles from Plex (Tautulli heavy-
 * rotation, invoked through the tool registry AS Maggie — she holds
 * read_plex_consumption) float matching headlines with a "because you
 * watch X" attribution. Fail-open: Plex/Tautulli down ⇒ no boost,
 * never an error. Cached 6h per process.
 */
import type { Database } from 'bun:sqlite';
import { ulid } from 'ulid';
import type { MemoryClient } from '@memory/client';
import type { SpecialistRegistry } from '@core/specialist';
import type { ToolRegistry } from '@core/tool_registry';
import type { LLMRouter } from '@core/llm';
import {
  read_sources,
  write_sources,
  upsert_source,
  is_subscription,
  type SubscriptionCadence,
} from '@specialists/cordelia/sources_store';

export interface NewsDeskDeps {
  db: Database;
  memory: MemoryClient;
  specialists: SpecialistRegistry;
  tool_registry: ToolRegistry;
  llm: LLMRouter;
  /** Smoke seam — returns watched show/movie titles. Defaults to the
   *  Plex heavy-rotation path via the tool registry (as Maggie). */
  watched_titles_fn?: () => Promise<string[]>;
}

export interface OfferedBundle {
  key: string;
  label: string;
  /** Feeds seeded (onto Kate's rack) when the owner activates it. */
  sources: Array<{
    url: string;
    description: string;
    tier: 1 | 2;
    cadence: SubscriptionCadence;
    tags: string[];
  }>;
}

/**
 * Curated switch-on bundles for the cloud's "offered" ring. Feeds are
 * pipeline-verified on their first refresh (a dead/shell feed
 * self-reports as a quality-gate rejection — same contract as seeds).
 */
export const OFFERED_BUNDLES: OfferedBundle[] = [
  {
    key: 'climate',
    label: 'Climate',
    sources: [
      { url: 'https://insideclimatenews.org/feed/', description: 'Inside Climate News — nonprofit climate journalism', tier: 2, cadence: 'daily', tags: ['news', 'climate', 'rss'] },
      { url: 'https://www.carbonbrief.org/feed/', description: 'Carbon Brief — UK climate science + policy analysis', tier: 2, cadence: 'daily', tags: ['news', 'climate', 'rss'] },
    ],
  },
  {
    key: 'health',
    label: 'Health',
    sources: [
      { url: 'https://kffhealthnews.org/feed/', description: 'KFF Health News — nonprofit health policy newsroom', tier: 2, cadence: 'daily', tags: ['news', 'health', 'rss'] },
    ],
  },
  {
    key: 'open-source',
    label: 'Open Source',
    sources: [
      { url: 'https://lwn.net/headlines/rss', description: 'LWN — Linux/open-source weekly of record', tier: 2, cadence: 'daily', tags: ['news', 'opensource', 'rss'] },
    ],
  },
  {
    key: 'longform',
    label: 'Longform',
    sources: [
      { url: 'https://longreads.com/feed/', description: 'Longreads — curated longform nonfiction', tier: 2, cadence: 'weekly', tags: ['news', 'longform', 'rss'] },
    ],
  },
];

export interface DeskCategory {
  key: string;
  source_count: number;
  item_count_7d: number;
  paused: boolean;
  state: 'active' | 'paused' | 'offered';
}

export interface DeskItem {
  id: string;
  title: string;
  link: string;
  description: string;
  source_domain: string;
  category: string | null;
  published_at: string | null;
  fetched_at: string;
  /** Set on entertainment items matching a Plex-watched title. */
  because_you_watch?: string;
}

export interface DeskTake {
  take_md: string;
  cited_links: string[];
  ts: string;
}

export interface DeskPayload {
  categories: DeskCategory[];
  items: DeskItem[];
  /** Kate's Read — latest lead take + latest take per category. */
  takes: { lead: DeskTake | null; by_category: Record<string, DeskTake> };
  generated_at: string;
  taste_titles_used: number;
}

/* ── Plex taste (fail-open, 6h cache) ─────────────────────────────── */

const TASTE_CACHE_MS = 6 * 3_600_000;
let taste_cache: { at: number; titles: string[] } | null = null;

/** Test hook — reset the module cache between smoke cases. */
export function _test_reset_taste_cache(): void {
  taste_cache = null;
}

async function default_watched_titles(deps: NewsDeskDeps): Promise<string[]> {
  const maggie = deps.specialists.get('maggie');
  if (!maggie) return [];
  const titles = new Set<string>();
  for (const stat of ['top_tv', 'top_movies'] as const) {
    try {
      const out = await deps.tool_registry.invoke(
        'plex_heavy_rotation',
        { stat, window_days: 60, count: 15 },
        {
          memory: deps.memory,
          llm: deps.llm,
          now: new Date(),
          intent_id: ulid(),
          specialist_id: 'maggie',
        },
        maggie.granted,
        'maggie',
      );
      if (!out.ok) continue;
      const items = (out.result as { items?: Array<Record<string, unknown>> })?.items ?? [];
      for (const it of items) {
        for (const k of ['title', 'grandparent_title'] as const) {
          const v = it[k];
          if (typeof v === 'string' && v.trim().length >= 3) titles.add(v.trim());
        }
      }
    } catch {
      /* fail-open — no boost */
    }
  }
  return Array.from(titles);
}

async function watched_titles_cached(deps: NewsDeskDeps): Promise<string[]> {
  if (taste_cache && Date.now() - taste_cache.at < TASTE_CACHE_MS) {
    return taste_cache.titles;
  }
  const fn = deps.watched_titles_fn ?? (() => default_watched_titles(deps));
  let titles: string[] = [];
  try {
    titles = await fn();
  } catch {
    titles = [];
  }
  taste_cache = { at: Date.now(), titles };
  return titles;
}

/** Case-insensitive whole-ish title match against headline+description. */
function taste_match(item: { title: string; description: string }, watched: string[]): string | null {
  const hay = `${item.title} ${item.description}`.toLowerCase();
  for (const w of watched) {
    if (w.length < 4) continue; // 'Up', 'It' — too noisy to match on
    if (hay.includes(w.toLowerCase())) return w;
  }
  return null;
}

/* ── Desk composition ─────────────────────────────────────────────── */

export async function compose_desk(
  deps: NewsDeskDeps,
  opts: { category?: string; limit?: number } = {},
): Promise<DeskPayload> {
  const now = new Date();
  const week_ago = new Date(now.getTime() - 7 * 86_400_000).toISOString();
  const entries = read_sources(deps.memory).filter(
    (e) => is_subscription(e) && typeof e.category === 'string',
  );

  // Category aggregation across ALL racks.
  const by_cat = new Map<string, { sources: number; paused_n: number }>();
  for (const e of entries) {
    const acc = by_cat.get(e.category!) ?? { sources: 0, paused_n: 0 };
    acc.sources++;
    if (e.paused) acc.paused_n++;
    by_cat.set(e.category!, acc);
  }
  const counts = deps.db
    .prepare(
      `SELECT category, COUNT(*) AS n FROM news_items
        WHERE fetched_at >= @cutoff AND category IS NOT NULL
        GROUP BY category`,
    )
    .all({ '@cutoff': week_ago }) as Array<{ category: string; n: number }>;
  const count_map = new Map(counts.map((r) => [r.category, r.n]));

  const categories: DeskCategory[] = [];
  for (const [key, acc] of Array.from(by_cat.entries()).sort()) {
    const paused = acc.paused_n === acc.sources;
    categories.push({
      key,
      source_count: acc.sources,
      item_count_7d: count_map.get(key) ?? 0,
      paused,
      state: paused ? 'paused' : 'active',
    });
  }
  for (const bundle of OFFERED_BUNDLES) {
    if (by_cat.has(bundle.key)) continue;
    categories.push({
      key: bundle.key,
      source_count: bundle.sources.length,
      item_count_7d: 0,
      paused: false,
      state: 'offered',
    });
  }

  // Headlines (newest first; published_at preferred, fetch time fallback).
  const limit = Math.min(Math.max(opts.limit ?? 60, 1), 200);
  const rows = (
    opts.category
      ? deps.db
          .prepare(
            `SELECT id, title, link, description, source_domain, category,
                    published_at, fetched_at
               FROM news_items
              WHERE category = @cat
              ORDER BY COALESCE(published_at, fetched_at) DESC
              LIMIT @lim`,
          )
          .all({ '@cat': opts.category, '@lim': limit })
      : deps.db
          .prepare(
            `SELECT id, title, link, description, source_domain, category,
                    published_at, fetched_at
               FROM news_items
              ORDER BY COALESCE(published_at, fetched_at) DESC
              LIMIT @lim`,
          )
          .all({ '@lim': limit })
  ) as DeskItem[];

  // Entertainment taste boost — annotate, then float boosted items
  // above their unboosted category peers (stable within groups).
  const watched = await watched_titles_cached(deps);
  let boosted = 0;
  if (watched.length > 0) {
    for (const it of rows) {
      if (it.category !== 'entertainment') continue;
      const m = taste_match(it, watched);
      if (m) {
        it.because_you_watch = m;
        boosted++;
      }
    }
    if (boosted > 0) {
      // Reorder ONLY the entertainment subsequence in place (boosted
      // first, recency preserved within each group) — a global sort
      // with a "0 for unrelated pairs" comparator is inconsistent and
      // V8 may never compare the pair that matters.
      const idxs: number[] = [];
      for (let i = 0; i < rows.length; i++) {
        if (rows[i]!.category === 'entertainment') idxs.push(i);
      }
      const ent = idxs.map((i) => rows[i]!);
      const reordered = [
        ...ent.filter((e) => e.because_you_watch),
        ...ent.filter((e) => !e.because_you_watch),
      ];
      for (let j = 0; j < idxs.length; j++) rows[idxs[j]!] = reordered[j]!;
    }
  }

  // Kate's Read — newest take per category (NULL category = the lead).
  const take_rows = deps.db
    .prepare(
      `SELECT category, take_md, cited_links, ts FROM news_takes
        ORDER BY ts DESC LIMIT 80`,
    )
    .all() as Array<{ category: string | null; take_md: string; cited_links: string; ts: string }>;
  const takes: DeskPayload['takes'] = { lead: null, by_category: {} };
  for (const t of take_rows) {
    let links: string[] = [];
    try {
      const v = JSON.parse(t.cited_links) as unknown;
      if (Array.isArray(v)) links = v.filter((x): x is string => typeof x === 'string');
    } catch {
      /* tolerate */
    }
    const take: DeskTake = { take_md: t.take_md, cited_links: links, ts: t.ts };
    if (t.category === null) {
      if (!takes.lead) takes.lead = take;
    } else if (!takes.by_category[t.category]) {
      takes.by_category[t.category] = take;
    }
  }

  return {
    categories,
    items: rows,
    takes,
    generated_at: now.toISOString(),
    taste_titles_used: watched.length,
  };
}

/**
 * Pause/resume every subscription in a category (the gear toggle).
 * Returns how many entries flipped. Unknown category ⇒ 0 (no-op).
 */
export function set_category_paused(
  memory: MemoryClient,
  category: string,
  paused: boolean,
): number {
  const entries = read_sources(memory);
  let flipped = 0;
  for (const e of entries) {
    if (!is_subscription(e) || e.category !== category) continue;
    if (paused) {
      if (e.paused !== true) {
        e.paused = true;
        flipped++;
      }
    } else if (e.paused === true) {
      delete e.paused;
      flipped++;
    }
  }
  if (flipped > 0) write_sources(memory, entries);
  return flipped;
}

/**
 * Activate an offered bundle: seed its feeds as Kate-rack subscriptions
 * under the bundle's category key. Idempotent (upsert by URL). Returns
 * the bundle or null when the key isn't offered.
 */
export function activate_offered_bundle(
  memory: MemoryClient,
  key: string,
): OfferedBundle | null {
  const bundle = OFFERED_BUNDLES.find((b) => b.key === key);
  if (!bundle) return null;
  for (const s of bundle.sources) {
    upsert_source(memory, {
      url: s.url,
      description: s.description,
      tags: s.tags,
      specialist_id: 'kate',
      cadence: s.cadence,
      tier: s.tier,
      category: key,
      seeded_by: 'news-desk-activation',
    });
  }
  return bundle;
}
