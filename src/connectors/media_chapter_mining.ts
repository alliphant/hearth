/**
 * Chapter mining — recover a chapter index for media whose source ships none.
 *
 * A huge share of what Jasper archives (live sets, DJ mixes, full-album uploads,
 * long talks) has no official chapter bar, because YouTube only builds one when
 * the UPLOADER puts a qualifying list in the description (must start at 0:00,
 * ≥3 entries, ≥10s apart). The setlist almost always exists anyway — in the
 * description in a form that missed those rules, or in a top comment a hundred
 * people have thumbed up. That is a measurable artifact of the page, not a
 * guess, so mining it is LAW #1-clean: the timestamps are PARSED, never
 * authored by a model, and every derived list carries its provenance
 * (`ChapterProvenance`) so the player can attribute it.
 *
 * Two sources, tried in trust order:
 *   1. description — the uploader's own words; free (already in the probe).
 *   2. top comments — one extra `yt-dlp --write-comments` pass, sorted by top
 *      and hard-capped. Candidates are ranked by like_count (the corroboration
 *      signal) after passing the same structural validation.
 *
 * Fail-soft everywhere: a leaf NEVER throws up the stack, and a source that
 * yields nothing convincing yields `null` rather than a weak list — no chapters
 * beats wrong chapters on a scrubber.
 *
 * Env:
 *   HEARTH_YTDLP_BIN                    (default "yt-dlp")
 *   HEARTH_MEDIA_CHAPTER_MINING         "0" disables entirely
 *   HEARTH_MEDIA_CHAPTER_MIN_S          (default 300) skip shorter media
 *   HEARTH_MEDIA_CHAPTER_MAX_COMMENTS   (default 80) top-N comments fetched
 *   HEARTH_MEDIA_CHAPTER_TIMEOUT_MS     (default 90000)
 */

import type { MediaChapter, ChapterProvenance } from '@core/media/types';

const YTDLP_BIN = process.env.HEARTH_YTDLP_BIN ?? 'yt-dlp';

function int_env(name: string, dflt: number, lo: number, hi: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n >= lo && n <= hi ? Math.floor(n) : dflt;
}

const MIN_DURATION_S = int_env('HEARTH_MEDIA_CHAPTER_MIN_S', 300, 0, 86400);
const MAX_COMMENTS = int_env('HEARTH_MEDIA_CHAPTER_MAX_COMMENTS', 80, 10, 500);
const COMMENT_TIMEOUT_MS = int_env('HEARTH_MEDIA_CHAPTER_TIMEOUT_MS', 90000, 10000, 600000);

/** Minimum entries before a timestamp list is a chapter index and not a couple
 *  of people pointing at a moment. */
const MIN_ENTRIES = 3;
/** A real index spans the media. A list whose last entry sits in the first
 *  third is people quoting early moments, not indexing the whole thing. */
const MIN_SPAN_RATIO = 0.4;
/** Titles are the point — a bare column of times is not a chapter list. */
const MIN_TITLED_RATIO = 0.5;
const MAX_TITLE_LEN = 120;

export function chapter_mining_enabled(): boolean {
  return process.env.HEARTH_MEDIA_CHAPTER_MINING !== '0';
}

// ── the parser ───────────────────────────────────────────────────────────────

/** `1:02:03` / `02:03` → seconds. Rejects impossible clock parts. */
export function timestamp_to_seconds(raw: string): number | null {
  const parts = raw.split(':');
  if (parts.length < 2 || parts.length > 3) return null;
  const nums = parts.map((p) => Number(p));
  if (nums.some((n) => !Number.isInteger(n) || n < 0)) return null;
  if (parts.length === 3) {
    const [h, m, s] = nums as [number, number, number];
    if (m > 59 || s > 59 || h > 23) return null;
    return h * 3600 + m * 60 + s;
  }
  const [m, s] = nums as [number, number];
  if (s > 59) return null; // `1:75` is not a time
  return m * 60 + s;
}

const TS = String.raw`(?:\d{1,2}:)?\d{1,2}:\d{2}`;
/** A line that LEADS with a timestamp: `0:59 - Song`, `[0:59] Song`, `0:59 Song`. */
const LEADING = new RegExp(String.raw`^[\s\-–—•*·>»~]*[\[\(]?\s*(${TS})\s*[\]\)]?\s*[-–—:·•|>]*\s*(.*)$`);
/** A line that TRAILS with one: `Song — 0:59`, `Song (0:59)`. */
const TRAILING = new RegExp(String.raw`^(.*?)\s*[-–—:·•|(\[]*\s*[\[\(]?\s*(${TS})\s*[\]\)]?\s*$`);
/** Every timestamp anywhere — the single-paragraph fallback. */
const ANY_TS = new RegExp(TS, 'g');

function clean_title(raw: string): string {
  return raw
    .replace(/\s+/g, ' ')
    .replace(/^[\s\-–—:·•|>»~,.*_]+/, '')
    .replace(/[\s\-–—:·•|,]+$/, '')
    .replace(/^["'“”‘’]+|["'“”‘’]+$/g, '')
    .trim()
    .slice(0, MAX_TITLE_LEN);
}

interface RawEntry {
  start_s: number;
  title: string;
}

/** Line-oriented pass: one timestamp per line, leading form preferred. */
function parse_by_line(text: string): RawEntry[] {
  const out: RawEntry[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;

    const lead = LEADING.exec(trimmed);
    if (lead) {
      const start_s = timestamp_to_seconds(lead[1]!);
      if (start_s !== null) {
        out.push({ start_s, title: clean_title(lead[2] ?? '') });
        continue;
      }
    }
    const trail = TRAILING.exec(trimmed);
    if (trail) {
      const start_s = timestamp_to_seconds(trail[2]!);
      if (start_s !== null) out.push({ start_s, title: clean_title(trail[1] ?? '') });
    }
  }
  return out;
}

/**
 * Fallback for an index written as one run-on paragraph
 * (`0:00 Intro 4:17 Fear of Heights 7:38 …`): split on every timestamp and take
 * the text between this one and the next as the title.
 */
function parse_inline(text: string): RawEntry[] {
  const flat = text.replace(/\s+/g, ' ');
  const hits: Array<{ at: number; end: number; s: number }> = [];
  ANY_TS.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ANY_TS.exec(flat)) !== null) {
    const s = timestamp_to_seconds(m[0]);
    if (s !== null) hits.push({ at: m.index, end: m.index + m[0].length, s });
  }
  const out: RawEntry[] = [];
  for (let i = 0; i < hits.length; i++) {
    const h = hits[i]!;
    const stop = i + 1 < hits.length ? hits[i + 1]!.at : flat.length;
    out.push({ start_s: h.s, title: clean_title(flat.slice(h.end, stop)) });
  }
  return out;
}

/**
 * Parse a block of text into a chapter index, or `null` when it isn't one.
 * Structural validation only — no scoring, no source knowledge.
 */
export function parse_chapter_index(text: string, duration_s: number): MediaChapter[] | null {
  if (typeof text !== 'string' || text.trim().length === 0) return null;
  if (!Number.isFinite(duration_s) || duration_s <= 0) return null;

  let entries = parse_by_line(text);
  if (entries.length < MIN_ENTRIES) {
    const inline = parse_inline(text);
    if (inline.length > entries.length) entries = inline;
  }
  if (entries.length < MIN_ENTRIES) return null;

  // Every entry must land inside the media (a few seconds of rounding slack).
  if (entries.some((e) => e.start_s > duration_s + 5)) return null;

  // Strictly increasing. A list that repeats or goes backwards is commentary
  // ("loved it at 3:20, and again at 1:10"), not an index.
  for (let i = 1; i < entries.length; i++) {
    if (entries[i]!.start_s <= entries[i - 1]!.start_s) return null;
  }

  // It has to actually span the thing it claims to index.
  const last = entries[entries.length - 1]!.start_s;
  if (last < duration_s * MIN_SPAN_RATIO) return null;

  // Titles are the payload. A bare column of times helps nobody.
  const titled = entries.filter((e) => e.title.length > 0).length;
  if (titled / entries.length < MIN_TITLED_RATIO) return null;

  return entries.map((e, i) => {
    const end_s = i + 1 < entries.length ? entries[i + 1]!.start_s : Math.round(duration_s);
    const ch: MediaChapter = { start_s: e.start_s, title: e.title || `Chapter ${i + 1}` };
    if (end_s > e.start_s) ch.end_s = end_s;
    return ch;
  });
}

// ── comment fetch ────────────────────────────────────────────────────────────

export interface MinedComment {
  id?: string;
  text: string;
  like_count?: number;
  author?: string;
  is_pinned?: boolean;
  /** the uploader wrote it — their own setlist, just posted as a comment */
  by_uploader?: boolean;
}

/** Test transport (mirrors `_test_set_probe_transport`) — smokes inject
 *  comments with no yt-dlp and no network. */
let _test_comments: ((url: string) => Promise<MinedComment[]>) | null = null;
export function _test_set_comment_transport(
  fn: ((url: string) => Promise<MinedComment[]>) | null,
): void {
  _test_comments = fn;
}

interface ShellOut {
  exit: number;
  stdout: string;
  stderr: string;
}

async function run_command(cmd: string[], timeout_ms: number): Promise<ShellOut> {
  try {
    const proc = Bun.spawn(cmd, {
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, PATH: `/usr/local/bin:/usr/bin:/bin:${process.env.PATH ?? ''}` },
      signal: AbortSignal.timeout(timeout_ms),
    });
    let stdout = '';
    let stderr = '';
    try {
      stdout = await new Response(proc.stdout).text();
    } catch {
      /* partial/no stdout */
    }
    try {
      stderr = await new Response(proc.stderr).text();
    } catch {
      /* partial/no stderr */
    }
    let exit = -1;
    try {
      exit = await proc.exited;
    } catch {
      /* timeout/kill */
    }
    return { exit, stdout, stderr };
  } catch {
    return { exit: -1, stdout: '', stderr: '' };
  }
}

const is_obj = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

const num = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined;

const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v.length > 0 ? v : undefined;

/**
 * Top-level comments, sorted by top, hard-capped. Replies are explicitly NOT
 * fetched (`…,0,0`): an index lives in a root comment, and replies are where
 * the cost blows up on a popular video.
 */
export async function fetch_top_comments(url: string): Promise<MinedComment[]> {
  if (_test_comments !== null) {
    try {
      return await _test_comments(url);
    } catch {
      return [];
    }
  }
  const out = await run_command(
    [
      YTDLP_BIN,
      '--skip-download', // metadata only — the media is already handled
      '--dump-single-json',
      '--write-comments',
      '--extractor-args',
      `youtube:comment_sort=top;max_comments=${MAX_COMMENTS},all,0,0`,
      '--no-playlist',
      '--no-warnings',
      url,
    ],
    COMMENT_TIMEOUT_MS,
  );
  if (out.exit !== 0 || out.stdout.trim().length === 0) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(out.stdout) as unknown;
  } catch {
    return [];
  }
  if (!is_obj(parsed) || !Array.isArray(parsed.comments)) return [];
  const comments: MinedComment[] = [];
  for (const raw of parsed.comments) {
    if (!is_obj(raw)) continue;
    const text = str(raw.text);
    if (text === undefined) continue;
    const c: MinedComment = { text };
    const id = str(raw.id);
    if (id !== undefined) c.id = id;
    const likes = num(raw.like_count);
    if (likes !== undefined) c.like_count = likes;
    const author = str(raw.author);
    if (author !== undefined) c.author = author;
    if (raw.is_pinned === true) c.is_pinned = true;
    if (raw.author_is_uploader === true) c.by_uploader = true;
    comments.push(c);
  }
  return comments;
}

// ── ranking ──────────────────────────────────────────────────────────────────

export interface MinedChapters {
  chapters: MediaChapter[];
  provenance: ChapterProvenance;
}

/**
 * Best chapter index among the comments that parse, ranked by corroboration the
 * platform already collected:
 *
 *   1. the uploader wrote it — that's their own setlist, posted as a comment
 *      instead of in the description (description-tier trust, so it outranks
 *      any number of viewer thumbs-up)
 *   2. thumbs-up — Jasper's own heuristic: the index everyone upvoted is the
 *      index that's right
 *   3. a pin from the uploader, then the more detailed list
 */
export function pick_comment_chapters(
  comments: readonly MinedComment[],
  duration_s: number,
): MinedChapters | null {
  const rank = (c: MinedComment, n: number) => ({
    uploader: c.by_uploader === true,
    likes: c.like_count ?? 0,
    pinned: c.is_pinned === true,
    n,
  });
  let best: { c: MinedComment; chapters: MediaChapter[] } | null = null;
  for (const c of comments) {
    const chapters = parse_chapter_index(c.text, duration_s);
    if (!chapters) continue;
    if (best === null) {
      best = { c, chapters };
      continue;
    }
    const a = rank(c, chapters.length);
    const b = rank(best.c, best.chapters.length);
    const better =
      a.uploader !== b.uploader
        ? a.uploader
        : a.likes !== b.likes
          ? a.likes > b.likes
          : a.pinned !== b.pinned
            ? a.pinned
            : a.n > b.n;
    if (better) best = { c, chapters };
  }
  if (!best) return null;
  const provenance: ChapterProvenance = { from: 'comment' };
  if (best.c.author !== undefined) provenance.author = best.c.author;
  if (best.c.like_count !== undefined) provenance.like_count = best.c.like_count;
  if (best.c.is_pinned === true) provenance.pinned = true;
  if (best.c.by_uploader === true) provenance.by_uploader = true;
  if (best.c.id !== undefined) provenance.comment_id = best.c.id;
  return { chapters: best.chapters, provenance };
}

// ── public entry ─────────────────────────────────────────────────────────────

/** Human-readable credit for a chapter list — for logs and for what Kate says
 *  back ("from a comment by @chandraabudiman, 101 👍"). */
export function chapter_credit(p: ChapterProvenance): string {
  if (p.from === 'official') return 'the source’s own chapters';
  if (p.from === 'description') return 'the video description';
  const who = p.author ? `a comment by ${p.author}` : 'a top comment';
  const bits: string[] = [];
  if (p.by_uploader) bits.push('the uploader');
  if (p.like_count !== undefined) bits.push(`${p.like_count} 👍`);
  if (p.pinned) bits.push('pinned');
  return bits.length ? `${who} (${bits.join(', ')})` : who;
}

export interface MineChaptersArgs {
  url: string;
  duration_s?: number;
  /** the probe's description — searched first, and free */
  description?: string;
  /** skip the duration floor (an explicit rescan Jasper asked for) */
  force?: boolean;
}

/**
 * Recover a chapter index for media the source didn't chapter. Description
 * first (the uploader's own list), then top comments. Returns `null` when
 * neither yields a convincing index — never a weak one.
 */
export async function mine_chapters(args: MineChaptersArgs): Promise<MinedChapters | null> {
  if (!chapter_mining_enabled()) return null;
  const duration_s = args.duration_s;
  if (duration_s === undefined || !Number.isFinite(duration_s) || duration_s <= 0) return null;
  if (!args.force && duration_s < MIN_DURATION_S) return null;

  if (args.description) {
    const from_desc = parse_chapter_index(args.description, duration_s);
    if (from_desc) return { chapters: from_desc, provenance: { from: 'description' } };
  }

  try {
    const comments = await fetch_top_comments(args.url);
    if (comments.length === 0) return null;
    return pick_comment_chapters(comments, duration_s);
  } catch {
    return null; // fail-soft — chapters are a bonus, never a job failure
  }
}
