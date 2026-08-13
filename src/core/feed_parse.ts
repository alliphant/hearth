/**
 * feed_parse — RSS/Atom/RDF parsing for the subscription refresh
 * (News Desk, 2026-06-10).
 *
 * Shelving a Firecrawl rendering of a feed URL produced one opaque
 * "snapshot" item per refresh — fine for hash-diffing, useless as a
 * reading surface and mediocre RAG material. When a subscription's
 * content IS a feed, the refresh now parses it into discrete items
 * (title / link / description / published_at), records them in the
 * `news_items` table (the News Desk's query surface), and shelves a
 * CLEAN markdown digest instead of mangled XML.
 *
 * Parsing rides jsdom (already a dependency for the URL converter) —
 * DOMParser in XML mode handles RSS 2.0 `<item>`, Atom `<entry>`, and
 * RDF/RSS 1.0 alike, including CDATA. Best-effort by design: anything
 * that doesn't parse as a feed returns null and the caller falls back
 * to the normal fetch path. Never throws.
 */
import { JSDOM } from 'jsdom';
import { createHash } from 'node:crypto';

export interface FeedItem {
  title: string;
  link: string;
  /** Plain-text description/summary, HTML stripped, capped. */
  description: string;
  /** ISO 8601 UTC when the feed carried a parseable date, else null. */
  published_at: string | null;
}

export interface ParsedFeed {
  feed_title: string | null;
  items: FeedItem[];
}

/** Cheap pre-sniff so we don't spin up jsdom on obvious HTML/markdown. */
export function looks_like_feed(text: string): boolean {
  const head = text.slice(0, 2000);
  return /<rss[\s>]|<feed[\s>]|<rdf:RDF[\s>]/i.test(head);
}

const DESCRIPTION_CAP = 500;
const MAX_ITEMS = 60;

function text_of(el: Element | null | undefined): string {
  if (!el) return '';
  return (el.textContent ?? '').trim();
}

/** Strip embedded HTML from a description (feeds love CDATA'd markup). */
function strip_html(s: string): string {
  return s
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

function iso_or_null(s: string): string | null {
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

/**
 * Parse feed XML into items. Returns null when the text isn't a feed
 * (or is empty/unparseable) — the caller falls back to the page path.
 */
export function parse_feed(xml: string): ParsedFeed | null {
  if (!looks_like_feed(xml)) return null;
  let doc: Document;
  try {
    const dom = new JSDOM(xml, { contentType: 'text/xml' });
    doc = dom.window.document;
  } catch {
    return null;
  }
  // jsdom surfaces XML parse errors as a parsererror document.
  if (doc.querySelector('parsererror')) return null;

  const items: FeedItem[] = [];

  // RSS 2.0 / RDF: <item>; Atom: <entry>.
  const rss_items = Array.from(doc.querySelectorAll('item'));
  const atom_entries = rss_items.length === 0 ? Array.from(doc.querySelectorAll('entry')) : [];

  for (const el of rss_items.slice(0, MAX_ITEMS)) {
    const title = strip_html(text_of(el.querySelector('title')));
    let link = text_of(el.querySelector('link'));
    if (!link) {
      // RDF feeds sometimes carry the link as an attribute or guid.
      link = el.getAttribute('rdf:about') ?? text_of(el.querySelector('guid'));
    }
    if (!title || !link) continue;
    items.push({
      title,
      link,
      description: strip_html(text_of(el.querySelector('description'))).slice(0, DESCRIPTION_CAP),
      published_at:
        iso_or_null(text_of(el.querySelector('pubDate'))) ??
        // RDF/Dublin Core date (BBC-style RSS 1.0, DW)
        iso_or_null(text_of(el.getElementsByTagName('dc:date').item(0) as Element | null)),
    });
  }

  for (const el of atom_entries.slice(0, MAX_ITEMS)) {
    const title = strip_html(text_of(el.querySelector('title')));
    // Atom: prefer rel=alternate link href, else first link href.
    let link = '';
    const links = Array.from(el.querySelectorAll('link'));
    const alt = links.find((l) => (l.getAttribute('rel') ?? 'alternate') === 'alternate');
    link = (alt ?? links[0])?.getAttribute('href') ?? '';
    if (!title || !link) continue;
    items.push({
      title,
      link,
      description: strip_html(
        text_of(el.querySelector('summary')) || text_of(el.querySelector('content')),
      ).slice(0, DESCRIPTION_CAP),
      published_at:
        iso_or_null(text_of(el.querySelector('published'))) ??
        iso_or_null(text_of(el.querySelector('updated'))),
    });
  }

  if (items.length === 0) return null;
  const feed_title =
    strip_html(text_of(doc.querySelector('channel > title'))) ||
    strip_html(text_of(doc.querySelector('feed > title'))) ||
    null;
  return { feed_title, items };
}

/**
 * Content hash over the ITEM IDENTITIES (links + titles), not the raw
 * XML — feeds churn timestamps/ad markers every fetch, which would
 * defeat the unchanged-skip. Same items ⇒ same hash.
 */
export function items_hash(items: FeedItem[]): string {
  const h = createHash('sha256');
  for (const it of items) {
    h.update(it.link);
    // 0x01/0x02 separate the fields so a link ending where a title begins
    // can't collide. Written as escapes, never literal control bytes in
    // source (see guard:encoding) — the encoded byte is identical, so no
    // stored `last_content_hash` changes and no feed re-shelves.
    h.update('\x01');
    h.update(it.title);
    h.update('\x02');
  }
  return h.digest('hex');
}

/**
 * Clean markdown digest for the library shelf — what RAG and the
 * specialist actually read. One dated section, one bullet per story.
 */
export function items_digest_markdown(
  feed_title: string | null,
  source_url: string,
  items: FeedItem[],
  fetched_at_iso: string,
): string {
  const lines: string[] = [
    `# ${feed_title ?? source_url} — headlines`,
    '',
    `Source: ${source_url} (fetched ${fetched_at_iso})`,
    '',
  ];
  for (const it of items) {
    lines.push(`## [${it.title}](${it.link})`);
    if (it.published_at) lines.push(`*${it.published_at}*`);
    if (it.description) lines.push(it.description);
    lines.push('');
  }
  return lines.join('\n');
}
