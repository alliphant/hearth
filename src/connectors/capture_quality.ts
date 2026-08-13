/**
 * Capture quality gate (#2b — 2026-05-30).
 *
 * Cordelia's curation writes web captures into specialists' libraries and
 * stamps them Tier-1, where they're cited as durable truth forever. Ruby's
 * bootstrap had a ~50% trash rate: a PDF download interstitial ("the file
 * X.pdf will begin downloading…") filed AS the budget, an OpenData portal
 * nav-chrome shell ("Browse Data | Sign In") filed AS the master plan.
 * Garbage in the durable layer is worse than a transient chat hallucination
 * — it persists and a grounding check happily treats it as "sourced."
 *
 * This gate JUDGES quality; it is NOT a trash-string blacklist (the
 * enumerate-the-failures anti-pattern). Two layers:
 *
 *   Layer 1 — structural pre-filter (deterministic, no LLM, generalizes):
 *     content SHAPE, not word lists. Link density, prose-sentence count,
 *     length. Clearly-substantive documents accept and clearly-empty
 *     shells reject WITHOUT a model call (both documented trash cases, 86
 *     and 184 chars, are caught here deterministically).
 *
 *   Layer 2 — LLM quality judge (the dynamic core, ambiguous band only):
 *     a cheap planner-role classify call that judges "is this the content
 *     the user wanted, or a shell?" — semantic, so it catches shell shapes
 *     a regex never would. Mirrors the extractor pattern in
 *     src/specialists/cordelia/extractors.ts.
 *
 * FAIL-OPEN, always. A judge that errors / can't parse, or an absent LLM
 * router, resolves to ACCEPT. A judge outage must never halt curation; the
 * gate is only ever stricter than today on a CONFIDENT reject.
 *
 * The single source of truth for "is this junk" — reused by the save-time
 * integration (save_library_item) AND the existing-trash quarantine script.
 */

import { z } from 'zod';
import type { LLMRouter } from '@core/llm';

export type CaptureContentType =
  | 'document'
  | 'nav_chrome'
  | 'interstitial'
  | 'paywall'
  | 'error_page'
  | 'thin';

/** Result of assessing one capture. `ok:true` → write it; otherwise the
 *  fields explain why and (for interstitials) where the real file is. */
export interface QualityVerdict {
  ok: boolean;
  content_type?: CaptureContentType;
  reason?: string;
  /** A binary (.pdf/.docx/…) the interstitial was a cover page for. */
  follow_url?: string;
}

/** The shape save_library_item returns when the gate rejects a capture.
 *  Callers narrow on `'rejected' in result`. */
export interface CaptureRejection {
  rejected: true;
  content_type: CaptureContentType;
  reason: string;
  follow_url?: string;
}

/** 'full' — structural + LLM judge (auto-curation / URL ingest).
 *  'minimal' — hard-empty check only, no judge (a user's deliberate
 *  upload shouldn't be second-guessed). 'off' — always accept. */
export type QualityMode = 'full' | 'minimal' | 'off';

// Structural thresholds. Tuned so the two documented trash cases (86 &
// 184 chars) hard-reject and a real document hard-accepts, leaving only
// the genuinely ambiguous middle for the model.
const HARD_REJECT_LEN = 200;
const MINIMAL_EMPTY_LEN = 50;
const HARD_ACCEPT_LEN = 1200;
const HARD_ACCEPT_LINK_RATIO = 0.4;
const HARD_ACCEPT_SENTENCES = 5;
const JUDGE_BODY_CHARS = 3000;

const BINARY_EXT = /\.(pdf|docx?|xlsx?|pptx?|csv|zip)\b/i;
const MD_LINK_RE = /!?\[[^\]]*\]\(([^)\s]+)[^)]*\)/g;
const BARE_URL_RE = /https?:\/\/[^\s)<>"']+/g;

/** Fraction of the body consumed by markdown-link / image / bare-URL
 *  syntax. Nav-chrome is mostly links; a document is mostly prose. */
export function link_ratio(body: string): number {
  const len = body.trim().length;
  if (len === 0) return 1;
  let link_chars = 0;
  for (const m of body.matchAll(MD_LINK_RE)) link_chars += m[0].length;
  // Bare URLs not already inside a markdown link.
  const without_md = body.replace(MD_LINK_RE, ' ');
  for (const m of without_md.matchAll(BARE_URL_RE)) link_chars += m[0].length;
  return Math.min(1, link_chars / len);
}

/** Count of sentence-like segments of >= 6 words. A cover page is one
 *  short sentence; a real document has many. */
export function prose_sentences(body: string): number {
  const prose = body
    .replace(MD_LINK_RE, ' ') // drop link syntax
    .replace(/^#{1,6}\s.*$/gm, ' ') // drop heading lines
    .replace(/[*_`>|#-]+/g, ' ');
  let count = 0;
  for (const seg of prose.split(/[.!?]+(?:\s|$)/)) {
    const words = seg.trim().split(/\s+/).filter(Boolean);
    if (words.length >= 6) count++;
  }
  return count;
}

/** Find the binary a cover page is fronting: the first .pdf/.docx/etc.
 *  link in the body, or a named binary filename resolved against the
 *  source page's host. Best-effort — null when nothing resolvable. */
export function find_binary_link(body: string, source_url?: string): string | undefined {
  for (const m of body.matchAll(MD_LINK_RE)) {
    const url = m[1];
    if (url && BINARY_EXT.test(url)) return absolutize(url, source_url);
  }
  for (const m of body.matchAll(BARE_URL_RE)) {
    if (BINARY_EXT.test(m[0])) return m[0];
  }
  // A named filename in prose ("'ECON 2021 Offer Narratives.pdf'") with a
  // page host to resolve it against.
  const named = body.match(/['"]?([\w .()\-]+\.(?:pdf|docx?|xlsx?|pptx?|csv|zip))['"]?/i);
  if (named && named[1] && source_url) {
    try {
      const host = new URL(source_url);
      // Can't know the real path; this is a weak guess. Only return when
      // the page itself looks like a download landing for that file.
      return new URL(encodeURI(named[1].trim()), host.origin).href;
    } catch {
      /* fall through */
    }
  }
  return undefined;
}

function absolutize(url: string, base?: string): string {
  if (/^https?:\/\//i.test(url)) return url;
  if (!base) return url;
  try {
    return new URL(url, base).href;
  } catch {
    return url;
  }
}

// ── LLM judge ─────────────────────────────────────────────────────────

const JudgeSchema = z.object({
  is_substantive: z.boolean(),
  content_type: z.enum([
    'document',
    'nav_chrome',
    'interstitial',
    'paywall',
    'error_page',
    'thin',
  ]),
  confidence: z.number().min(0).max(1).optional(),
  reason: z.string().default(''),
  follow_url: z.string().nullable().default(null),
});

const JUDGE_SYSTEM =
  'You decide whether a web capture is REAL CONTENT worth saving to a ' +
  'knowledge library, or a SHELL with no real content. Bias toward ' +
  'accepting: any actual readable material — an article, a record, a ' +
  'dataset description, notes, a document — is substantive even if short.\n\n' +
  'Reject ONLY when the capture is a shell, i.e. one of:\n' +
  '  - nav_chrome: a navigation menu / portal landing (links, "Browse", ' +
  '"Sign In", breadcrumbs) with no body content\n' +
  '  - interstitial: a "your download will begin" / "click here to ' +
  'download" cover page fronting a real file\n' +
  '  - paywall: a login / subscribe / cookie wall instead of the article\n' +
  '  - error_page: a 404 / "page not found" / "enable JavaScript" stub\n' +
  '  - thin: almost no content (a title and nothing else)\n\n' +
  'If interstitial AND you can see the real file URL in the text, put it in ' +
  'follow_url; else null.\n\n' +
  'Reply with ONLY this JSON, nothing else:\n' +
  '{"is_substantive": <bool>, "content_type": "document"|"nav_chrome"|' +
  '"interstitial"|"paywall"|"error_page"|"thin", "confidence": <0..1>, ' +
  '"reason": "<short>", "follow_url": <string|null>}';

function strip_fence(s: string): string {
  const m = s.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
  return (m ? m[1]! : s).trim();
}

async function judge_capture(
  llm: LLMRouter,
  body: string,
  source_url: string | undefined,
): Promise<QualityVerdict | null> {
  let role;
  try {
    role = llm.for_role('planner');
  } catch {
    return null;
  }
  const truncated =
    body.length > JUDGE_BODY_CHARS
      ? body.slice(0, JUDGE_BODY_CHARS) + '\n\n[...truncated]'
      : body;
  let resp;
  try {
    resp = await role.provider.complete({
      messages: [
        { role: 'system', content: JUDGE_SYSTEM },
        {
          role: 'user',
          content:
            `Source URL: ${source_url ?? '(none)'}\n\n` +
            `Captured content:\n${truncated}\n\nReply with ONLY the JSON.`,
        },
      ],
      temperature: 0.1,
      max_tokens: 400,
      think: false,
      ...role.defaults,
    });
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(strip_fence(resp.content));
  } catch {
    return null;
  }
  const r = JudgeSchema.safeParse(parsed);
  if (!r.success) return null;
  if (r.data.is_substantive) return { ok: true };
  return {
    ok: false,
    content_type: r.data.content_type,
    reason: r.data.reason || `judged ${r.data.content_type}`,
    follow_url:
      r.data.content_type === 'interstitial'
        ? (r.data.follow_url ?? find_binary_link(body, source_url)) || undefined
        : undefined,
  };
}

// ── The gate ──────────────────────────────────────────────────────────

export interface AssessArgs {
  body: string;
  source_url?: string;
  /** Conversion kind ('article' | 'pdf' | 'image' | …). Non-text kinds
   *  (image, already-binary pdf/docx) bypass the gate — they're not the
   *  nav-chrome/interstitial failure class. */
  kind?: string;
  mode?: QualityMode;
  llm?: LLMRouter;
}

/**
 * Assess one capture. The single source of truth for "is this junk."
 * Structural pre-filter first (the only band that hits the LLM is the
 * ambiguous middle); fail-open everywhere.
 */
export async function assess_capture_quality(args: AssessArgs): Promise<QualityVerdict> {
  const mode: QualityMode = args.mode ?? 'full';
  if (mode === 'off') return { ok: true };

  // Non-text captures (images, the binary itself) aren't the shell class.
  if (args.kind === 'image') return { ok: true };

  const body = (args.body ?? '').trim();
  const len = body.length;

  if (mode === 'minimal') {
    return len < MINIMAL_EMPTY_LEN
      ? { ok: false, content_type: 'thin', reason: `near-empty capture (${len} chars)` }
      : { ok: true };
  }

  // Hard-reject: too short to be a real document.
  if (len < HARD_REJECT_LEN) {
    const follow = find_binary_link(body, args.source_url);
    if (follow) {
      return {
        ok: false,
        content_type: 'interstitial',
        reason: `download cover page (${len} chars) fronting ${follow}`,
        follow_url: follow,
      };
    }
    const linky = link_ratio(body) > 0.4;
    return {
      ok: false,
      content_type: linky ? 'nav_chrome' : 'thin',
      reason: `${linky ? 'navigation/portal shell' : 'thin capture'} (${len} chars)`,
    };
  }

  // Hard-accept: clearly a substantive document.
  if (
    len >= HARD_ACCEPT_LEN &&
    link_ratio(body) < HARD_ACCEPT_LINK_RATIO &&
    prose_sentences(body) >= HARD_ACCEPT_SENTENCES
  ) {
    return { ok: true };
  }

  // Ambiguous middle — the only band that pays for the model. Fail-open
  // when the judge can't run or can't decide.
  if (!args.llm) return { ok: true };
  const verdict = await judge_capture(args.llm, body, args.source_url);
  return verdict ?? { ok: true };
}
