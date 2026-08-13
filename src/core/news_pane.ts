/**
 * news_pane — the News Desk TAB for Kate's briefing office (2026-06-10).
 *
 * Kate's office uses the server-side `tabs` pane primitive (the Ruby
 * Politics Desk pattern): tab 1 is her Briefing (brief embed, needs-you,
 * team health), tab 2 is this News Desk — her lead take with tappable
 * numbered citations, then the freshest headlines grouped by beat.
 * iOS renders the segmented tabs natively (PaneTabsView). The WEB
 * office UNWRAPS the primitive and drives its own tab bar instead,
 * because its News Desk tab is the richer interactive surface (word
 * cloud, pause toggles, track box over /api/news) — see app.js
 * render_pane's briefing branch.
 *
 * Lives in its own file per the library_pane extraction pattern —
 * specialist_pane.ts is shared across concurrent session lanes; the
 * hook there stays tiny. The full native iOS News Desk (cloud +
 * toggles) is board epic sep_s0sew01k44t5; this tab is the bridge.
 */
import type { Database } from 'bun:sqlite';
import type { PaneBlock } from './specialist_pane';
import { format_short_datetime } from './time';

const WINDOW_HOURS = 36;
const PER_CATEGORY = 2;
const MAX_HEADLINES = 14;
const BADGE_WINDOW_HOURS = 24;

export interface NewsDeskTab {
  id: string;
  label: string;
  badge?: number;
  blocks: PaneBlock[];
}

export function compose_news_desk_tab(db: Database): NewsDeskTab | null {
  const cutoff = new Date(Date.now() - WINDOW_HOURS * 3_600_000).toISOString();

  const items = db
    .prepare(
      `SELECT title, link, description, source_domain, category, published_at, fetched_at
         FROM (
           SELECT *, ROW_NUMBER() OVER (
             PARTITION BY category
             ORDER BY COALESCE(published_at, fetched_at) DESC
           ) AS rn
           FROM news_items
          WHERE fetched_at >= @cutoff AND category IS NOT NULL
         )
        WHERE rn <= @per
        ORDER BY COALESCE(published_at, fetched_at) DESC
        LIMIT @cap`,
    )
    .all({ '@cutoff': cutoff, '@per': PER_CATEGORY, '@cap': MAX_HEADLINES }) as Array<{
    title: string;
    link: string;
    description: string;
    source_domain: string;
    category: string;
    published_at: string | null;
    fetched_at: string;
  }>;

  const lead = db
    .prepare(
      `SELECT take_md, cited_links, ts FROM news_takes
        WHERE category IS NULL ORDER BY ts DESC LIMIT 1`,
    )
    .get() as { take_md: string; cited_links: string; ts: string } | null;

  if (!lead && items.length === 0) return null;

  const blocks: PaneBlock[] = [];

  // Kate's read — full prose; the numbered [n](url) citations are plain
  // markdown, so iOS renders them tappable as-is.
  if (lead) {
    let cited = '';
    try {
      const links = JSON.parse(lead.cited_links) as string[];
      const doms = [...new Set(links.map((l) => new URL(l).hostname.replace(/^www\./, '')))];
      if (doms.length > 0) cited = `\n\n*Grounded on: ${doms.slice(0, 6).join(' · ')}*`;
    } catch {
      /* tolerate */
    }
    blocks.push({
      type: 'text',
      body_md: `### Kate's read\n\n${lead.take_md}${cited}\n\n*as of ${format_short_datetime(lead.ts)}*`,
    });
  }

  // Headlines grouped by beat — one list block per category (the Ruby
  // desk feel), newest categories first.
  const by_cat = new Map<string, typeof items>();
  for (const it of items) {
    const list = by_cat.get(it.category) ?? [];
    list.push(it);
    by_cat.set(it.category, list);
  }
  for (const [category, rows] of by_cat) {
    blocks.push({
      type: 'list',
      title: category,
      items: rows.map((it) => ({
        title: it.title,
        subtitle: it.source_domain,
        deep_link: it.link,
        ...(it.description ? { detail_md: it.description } : {}),
      })),
    });
  }

  const fresh_cutoff = new Date(Date.now() - BADGE_WINDOW_HOURS * 3_600_000).toISOString();
  const fresh = db
    .prepare(`SELECT COUNT(*) AS n FROM news_items WHERE fetched_at >= @c`)
    .get({ '@c': fresh_cutoff }) as { n: number };

  return {
    id: 'news',
    label: 'News Desk',
    ...(fresh.n > 0 ? { badge: Math.min(fresh.n, 99) } : {}),
    blocks,
  };
}
