/**
 * Roadmap route — parses PLAN.md into structured sections + items, and
 * watches the file for changes (chokidar → SSE roadmap_updated event).
 *
 * The UI overlay renders this structure with filter pills, status
 * coloring, and commit-SHA click-throughs. PLAN.md stays the single
 * source of truth; this route is a thin parser/projection.
 *
 * (Renamed 2026-05-29 — `TODO.md` is now `PLAN.md`; the new tier
 * subsections under `## Current` and `## Future` are detected via
 * the `### Tier N` prefix below.)
 */

import { Hono } from 'hono';
import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import chokidar, { type FSWatcher } from 'chokidar';
import type { AppEventBus } from '../events';

export interface RoadmapRoutesDeps {
  repo_root: string;
  events?: AppEventBus;
}

export type ItemStatus = 'not_started' | 'in_flight' | 'blocked' | 'done';

export interface RoadmapItem {
  /** Visible title (the bold/strikethrough portion of the bullet line). */
  title: string;
  status: ItemStatus;
  /**
   * Body markdown: the bullet's continuation lines + nested content,
   * with the leading indent stripped so the client can re-render it.
   */
  body: string;
  /** First YYYY-MM-DD found in title or body (ship_date for [x] items). */
  ship_date?: string;
  /** First 7–40-hex-char commit SHA found in title or body. */
  commit?: string;
}

export interface RoadmapSection {
  /** H2 heading text without the leading "## ". */
  title: string;
  /** Optional one-line subtitle following the heading (preserved as-is). */
  subtitle?: string;
  items: RoadmapItem[];
}

export interface RoadmapPayload {
  sections: RoadmapSection[];
  /** Mtime of PLAN.md (epoch ms) — clients can compare to detect drift. */
  mtime: number;
  /** Raw PLAN.md contents — for the "show source" toggle in the overlay. */
  raw: string;
}

// ── Parser ──────────────────────────────────────────────────────────────────

const STATUS_FOR_BRACKET: Record<string, ItemStatus> = {
  ' ': 'not_started',
  '~': 'in_flight',
  '!': 'blocked',
  'x': 'done',
  'X': 'done',
};

// Section headings that ARE roadmap content.
//
// The 2026-05-29 restructure moved PLAN.md to a Past / Current / Future
// shape with `### Tier N` subsections — the parser now matches either
// the H2 wrapper headers (Current / Future) AND/OR the `Tier N`
// subsection headers. The "Past" pointer block is intentionally
// skipped (its content lives in `the private shipped-log archive`).
// Legacy section names are kept for back-compat in case an older
// PLAN.md is encountered.
const ROADMAP_SECTION_NAMES = new Set([
  // New shape (post 2026-05-29)
  'Current',
  'Future',
  'Tier 1',
  'Tier 2',
  'Tier 3',
  'Tier 4',
  'Tier 5',
  // Legacy shape (pre 2026-05-29)
  'Now',
  'Next',
  'Future passes',
  'Tactical',
  'Tiny',
  'Recently shipped',
]);

/** First H2/H3 token to test if a section is a roadmap section. */
function _matches_roadmap_section(title: string): boolean {
  // Sections in PLAN.md look like "## Current — work in flight…" or
  // "### Tier 1 — ship next (…)" — match on the part before the em-dash
  // / hyphen / parenthesis so subtitles don't break detection.
  const head = title.split(/[—–\-(]/, 1)[0]?.trim() ?? title;
  return ROADMAP_SECTION_NAMES.has(head);
}

function _section_subtitle(rawTitle: string): string | undefined {
  const idx = rawTitle.search(/[—–]/);
  if (idx < 0) return undefined;
  return rawTitle.slice(idx + 1).trim();
}

function _section_short_title(rawTitle: string): string {
  const idx = rawTitle.search(/[—–]/);
  return (idx < 0 ? rawTitle : rawTitle.slice(0, idx)).trim();
}

const COMMIT_RE = /\b([0-9a-f]{7,40})\b/i;
const DATE_RE = /\b(20\d{2}-\d{2}-\d{2})\b/;
// Bullet item start: `- [<status>] <title-rest>`
const BULLET_RE = /^\s*-\s+\[([ ~!xX])\]\s+(.*)$/;
// Title-extraction patterns: bold, strikethrough, or fallback to whole rest.
const BOLD_RE = /\*\*(.+?)\*\*/;
const STRIKE_RE = /~~(.+?)~~/;

/**
 * Returns the title text plus the rest of the bullet line AFTER the
 * title's containing wrapper (so leftover `**` / `~~` markers don't
 * leak into the body).
 */
function _split_title(rest: string): { title: string; tail: string } {
  const bold = rest.match(BOLD_RE);
  if (bold && bold[1] !== undefined && bold.index !== undefined) {
    const after = rest.slice(bold.index + bold[0].length);
    return { title: bold[1], tail: after };
  }
  const strike = rest.match(STRIKE_RE);
  if (strike && strike[1] !== undefined && strike.index !== undefined) {
    const after = rest.slice(strike.index + strike[0].length);
    return { title: strike[1], tail: after };
  }
  // Fallback: take up to the first " — " separator (em-dash) or whole line.
  const dashIdx = rest.search(/\s+[—–]\s+/);
  if (dashIdx >= 0) {
    return { title: rest.slice(0, dashIdx).trim(), tail: rest.slice(dashIdx) };
  }
  return { title: rest.trim(), tail: '' };
}

export function parse_plan_md(raw: string): RoadmapSection[] {
  const lines = raw.split('\n');
  const sections: RoadmapSection[] = [];
  let current: RoadmapSection | null = null;
  let currentItem: RoadmapItem | null = null;
  let bodyLines: string[] = [];

  const flushItem = (): void => {
    if (!currentItem || !current) return;
    const bodyJoined = bodyLines.join('\n').replace(/\s+$/, '');
    currentItem.body = bodyJoined;
    // Hoist commit + date from full text scope.
    const fullText = `${currentItem.title}\n${bodyJoined}`;
    const dateMatch = fullText.match(DATE_RE);
    if (dateMatch) currentItem.ship_date = dateMatch[1];
    const commitMatch = fullText.match(COMMIT_RE);
    // Filter out commit-shaped matches that are obviously dates or
    // generic words ("default" is 7 chars but not hex; the regex
    // already enforces hex). 7 hex chars matches things like "2026-05"
    // partially but the regex requires word boundaries.
    if (commitMatch && commitMatch[1] && !/^20\d{2}/.test(commitMatch[1])) {
      currentItem.commit = commitMatch[1];
    }
    current.items.push(currentItem);
    currentItem = null;
    bodyLines = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    // H2 heading
    if (line.startsWith('## ')) {
      flushItem();
      const rawTitle = line.slice(3).trim();
      if (_matches_roadmap_section(rawTitle)) {
        current = {
          title: _section_short_title(rawTitle),
          ...((_section_subtitle(rawTitle))
            ? { subtitle: _section_subtitle(rawTitle) }
            : {}),
          items: [],
        };
        sections.push(current);
      } else {
        current = null;
      }
      continue;
    }
    if (!current) continue;
    // Bullet item start
    const bulletMatch = line.match(BULLET_RE);
    if (bulletMatch && bulletMatch[1] !== undefined && bulletMatch[2] !== undefined) {
      flushItem();
      const status = STATUS_FOR_BRACKET[bulletMatch[1]] ?? 'not_started';
      const rest = bulletMatch[2].trim();
      const { title, tail } = _split_title(rest);
      currentItem = { title, status, body: '' };
      // Any "after the title" portion goes into body so the detail view
      // shows the full line (commit SHAs, dates, em-dashed context).
      const cleaned = tail.replace(/^\s*[-—–:]\s*/, '').trim();
      if (cleaned) bodyLines.push(cleaned);
      continue;
    }
    // Continuation lines (indented, non-bullet, non-H2)
    if (currentItem) {
      // Strip a leading indent of up to 4 spaces so client renders cleanly.
      const trimmed = line.replace(/^ {0,4}/, '');
      bodyLines.push(trimmed);
    }
  }
  flushItem();
  return sections;
}

// ── Router ──────────────────────────────────────────────────────────────────

export function create_roadmap_router(deps: RoadmapRoutesDeps): Hono {
  const r = new Hono();
  const PLAN_PATH = resolve(deps.repo_root, 'PLAN.md');

  async function build_payload(): Promise<RoadmapPayload | null> {
    try {
      const raw = await readFile(PLAN_PATH, 'utf8');
      const st = await stat(PLAN_PATH);
      return {
        sections: parse_plan_md(raw),
        mtime: st.mtimeMs,
        raw,
      };
    } catch {
      return null;
    }
  }

  r.get('/', async (c) => {
    const payload = await build_payload();
    if (!payload) return c.json({ error: 'PLAN.md not found' }, 404);
    return c.json(payload);
  });

  // chokidar watch — emit SSE event on every change so open Roadmap
  // panels live-update. awaitWriteFinish so a slow editor save doesn't
  // emit twice for one logical change.
  const watcher: FSWatcher = chokidar.watch(PLAN_PATH, {
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 150, pollInterval: 50 },
  });
  const fire = (): void => {
    deps.events?.emit({
      type: 'roadmap_updated',
      mtime_ms: Date.now(),
    });
  };
  watcher.on('add', fire);
  watcher.on('change', fire);
  watcher.on('unlink', fire);

  return r;
}
