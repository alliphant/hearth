/**
 * Download integrity gate (2026-06-01).
 *
 * The binary-file sibling to capture_quality.ts. Where that gate judges
 * a TEXT capture ("is this real content or a nav-chrome shell?") on the
 * URL/ingest path, this judges a downloaded FILE on Cordelia's
 * `download_to_library` path — the one that bit Ruby's FCGOV budget
 * pull: a request for a budget PDF returned HTTP 200, but the bytes were
 * a redirect/landing page (`<!doctype html>… the file will begin
 * downloading…`) rather than the PDF. The HTML stub landed in the
 * library masquerading as the document, "hefty file, 2 KB of nothing."
 *
 * Two layers, mirroring the capture gate. Fail-OPEN everywhere — a judge
 * outage or an unparseable verdict must never block an acquisition; the
 * gate is only ever stricter on a CONFIDENT reject.
 *
 *   Layer 1 — structural (deterministic, no LLM, generalizes by SHAPE):
 *     magic-byte sniff of the actual format. Confirmed binary bytes
 *     (a real %PDF, PNG, ZIP/OOXML, …) accept immediately — the
 *     redirect-stub failure class is structurally impossible once the
 *     bytes ARE the file. Asked-for-a-binary-but-got-HTML/text is the
 *     FCGOV mismatch: a type contradiction, not a judgment call, so it
 *     rejects deterministically and surfaces the real file's `follow_url`
 *     (via capture_quality's `find_binary_link`) for a retry.
 *
 *   Layer 2 — LLM intent judge (the dynamic core, ambiguous band only):
 *     when the bytes decode as text/HTML AND the intended type was text
 *     or unspecified, a cheap planner-role classify call answers the
 *     question this gate exists for: "is this the file the librarian
 *     INTENDED, or a stand-in page (login wall / error / redirect /
 *     nav shell) returned in its place?" Semantic, so it catches
 *     stand-ins a signature check never could.
 *
 * Out of scope by design: reading a *real* binary's semantic content to
 * confirm it's the RIGHT document (a valid-but-wrong PDF). That's a
 * heavyweight extraction job and belongs to the visual/text pipeline and
 * the nightly curation pass, not the ingest hot path.
 */

import { z } from 'zod';
import type { LLMRouter } from '@core/llm';
import { find_binary_link } from './capture_quality';

/** What the download actually turned out to be, relative to intent. */
export type DownloadVerdictType =
  | 'match' // the intended file — accept
  | 'redirect_stub' // a "download will begin" / JS-redirect landing page
  | 'login_wall' // a sign-in / subscribe / paywall instead of the file
  | 'error_page' // a 404 / access-denied / "enable JavaScript" stub
  | 'nav_chrome' // a navigation/portal shell with no body
  | 'wrong_content' // real readable content, but a different subject
  | 'thin' // a near-empty file
  | 'unknown_binary'; // real bytes in an unrecognized binary format — accept

const TEXTUAL_VERDICTS = new Set<DownloadVerdictType>([
  'redirect_stub',
  'login_wall',
  'error_page',
  'nav_chrome',
]);

export interface DownloadIntegrityVerdict {
  ok: boolean;
  content_type?: DownloadVerdictType;
  reason?: string;
  /** The real file a stub page was fronting, when resolvable. */
  follow_url?: string;
  /** The format sniffed from the bytes ('pdf'|'png'|'html'|'text'|…). */
  sniffed_format: string;
}

export interface AssessDownloadArgs {
  bytes: Uint8Array;
  /** The chosen filename (override or server/URL-derived). */
  filename?: string | null;
  /** The source URL (for extension hints and follow-link resolution). */
  url?: string | null;
  /** Cordelia's free-text intent ("the 2021 city budget PDF"). */
  description?: string | null;
  /** 'full' — structural + intent judge. 'off' — always accept. */
  mode?: 'full' | 'off';
  llm?: LLMRouter;
}

// How much of a textual body to hand the judge / scan for follow links.
const JUDGE_BODY_CHARS = 3000;
// Bytes inspected for the textual-vs-binary decision and signatures.
const SNIFF_BYTES = 2048;

/** Recognized formats whose mere presence proves "this is a real file." */
const BINARY_FORMATS = new Set([
  'pdf',
  'png',
  'jpeg',
  'gif',
  'webp',
  'zip',
  'gzip',
  'rar',
  '7z',
  'mp3',
  'mp4',
  'ico',
  'binary',
]);

// ── format sniffing ───────────────────────────────────────────────────

/** Decode the leading bytes as UTF-8 text, or null if they're binary
 *  (a NUL byte or a high replacement-char rate means "not text"). */
function decode_text(bytes: Uint8Array, max: number): string | null {
  const slice = bytes.subarray(0, Math.min(max, bytes.length));
  for (let i = 0; i < slice.length; i++) {
    if (slice[i] === 0) return null; // NUL → binary
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: false }).decode(slice);
  } catch {
    return null;
  }
  let bad = 0;
  for (const ch of text) if (ch === '�') bad++;
  if (bad / Math.max(1, text.length) > 0.1) return null;
  return text;
}

/**
 * Identify the format from the bytes. Returns a binary format name, one
 * of 'html'|'xml'|'json'|'text', or 'empty'. 'binary' is the catch-all
 * for real bytes in an unrecognized binary format.
 */
export function sniff_format(bytes: Uint8Array): string {
  if (bytes.length === 0) return 'empty';
  const b = bytes;
  const at = (sig: number[], off = 0): boolean =>
    sig.every((v, i) => b[off + i] === v);

  if (at([0x25, 0x50, 0x44, 0x46, 0x2d])) return 'pdf'; // %PDF-
  if (at([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'png';
  if (at([0xff, 0xd8, 0xff])) return 'jpeg';
  if (at([0x47, 0x49, 0x46, 0x38])) return 'gif'; // GIF8
  if (at([0x52, 0x49, 0x46, 0x46]) && at([0x57, 0x45, 0x42, 0x50], 8)) return 'webp';
  if (at([0x50, 0x4b, 0x03, 0x04]) || at([0x50, 0x4b, 0x05, 0x06])) return 'zip'; // zip/docx/xlsx/epub
  if (at([0x1f, 0x8b])) return 'gzip';
  if (at([0x52, 0x61, 0x72, 0x21])) return 'rar'; // Rar!
  if (at([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c])) return '7z';
  if (at([0x49, 0x44, 0x33])) return 'mp3'; // ID3
  if (at([0x66, 0x74, 0x79, 0x70], 4)) return 'mp4'; // ....ftyp
  if (at([0x00, 0x00, 0x01, 0x00])) return 'ico';

  const text = decode_text(b, SNIFF_BYTES);
  if (text === null) return 'binary';
  const head = text.replace(/^﻿/, '').trimStart().toLowerCase();
  if (
    head.startsWith('<!doctype html') ||
    head.startsWith('<html') ||
    head.startsWith('<head') ||
    head.startsWith('<body') ||
    /<html[\s>]/.test(head.slice(0, 1000)) ||
    text.toLowerCase().includes('</html>')
  ) {
    return 'html';
  }
  if (head.startsWith('<?xml') || head.startsWith('<svg')) return 'xml';
  if (head.startsWith('{') || head.startsWith('[')) return 'json';
  return 'text';
}

// ── expected type from the filename / URL extension ─────────────────────

interface ExtKind {
  binary: boolean;
  label: string;
}
const EXT_KIND: Record<string, ExtKind> = {
  pdf: { binary: true, label: 'a PDF document' },
  doc: { binary: true, label: 'a Word document' },
  docx: { binary: true, label: 'a Word document' },
  xls: { binary: true, label: 'a spreadsheet' },
  xlsx: { binary: true, label: 'a spreadsheet' },
  ppt: { binary: true, label: 'a slide deck' },
  pptx: { binary: true, label: 'a slide deck' },
  epub: { binary: true, label: 'an EPUB book' },
  zip: { binary: true, label: 'a ZIP archive' },
  gz: { binary: true, label: 'a gzip archive' },
  tgz: { binary: true, label: 'a gzip archive' },
  tar: { binary: true, label: 'a tar archive' },
  '7z': { binary: true, label: 'a 7-Zip archive' },
  rar: { binary: true, label: 'a RAR archive' },
  png: { binary: true, label: 'a PNG image' },
  jpg: { binary: true, label: 'a JPEG image' },
  jpeg: { binary: true, label: 'a JPEG image' },
  gif: { binary: true, label: 'a GIF image' },
  webp: { binary: true, label: 'a WebP image' },
  heic: { binary: true, label: 'a HEIC image' },
  bmp: { binary: true, label: 'a bitmap image' },
  tiff: { binary: true, label: 'a TIFF image' },
  mp3: { binary: true, label: 'an audio file' },
  wav: { binary: true, label: 'an audio file' },
  flac: { binary: true, label: 'an audio file' },
  m4a: { binary: true, label: 'an audio file' },
  mp4: { binary: true, label: 'a video file' },
  mov: { binary: true, label: 'a video file' },
  mkv: { binary: true, label: 'a video file' },
  csv: { binary: false, label: 'a CSV/tabular text file' },
  tsv: { binary: false, label: 'a tab-separated text file' },
  txt: { binary: false, label: 'a text file' },
  md: { binary: false, label: 'a markdown file' },
  markdown: { binary: false, label: 'a markdown file' },
  json: { binary: false, label: 'a JSON file' },
  xml: { binary: false, label: 'an XML file' },
  svg: { binary: false, label: 'an SVG file' },
  yaml: { binary: false, label: 'a YAML file' },
  yml: { binary: false, label: 'a YAML file' },
  html: { binary: false, label: 'an HTML page' },
  htm: { binary: false, label: 'an HTML page' },
};

function ext_of(name: string | null | undefined): string | null {
  if (!name) return null;
  let path = name;
  try {
    if (/^https?:\/\//i.test(name)) path = new URL(name).pathname;
  } catch {
    /* treat as a plain filename */
  }
  const m = path.toLowerCase().match(/\.([a-z0-9]{1,8})$/);
  return m ? m[1]! : null;
}

/** What kind of file the caller intended, from the filename then the URL. */
export function expected_kind(
  filename: string | null | undefined,
  url: string | null | undefined,
): { binary: boolean | null; label: string | null } {
  const ext = ext_of(filename) ?? ext_of(url);
  if (!ext) return { binary: null, label: null };
  const k = EXT_KIND[ext];
  return k ? { binary: k.binary, label: k.label } : { binary: null, label: null };
}

// ── LLM intent judge ────────────────────────────────────────────────────

const JudgeSchema = z.object({
  matches_intent: z.boolean(),
  content_type: z.enum([
    'match',
    'redirect_stub',
    'login_wall',
    'error_page',
    'nav_chrome',
    'wrong_content',
    'thin',
  ]),
  confidence: z.number().min(0).max(1).optional(),
  reason: z.string().default(''),
  follow_url: z.string().nullable().default(null),
});

const JUDGE_SYSTEM =
  'You decide whether a downloaded file is the FILE THE LIBRARIAN INTENDED ' +
  'to save, or a STAND-IN page returned in its place. The librarian asked a ' +
  'server for a file and got back this content; servers often return a ' +
  'landing/redirect page, a login wall, or an error page with HTTP 200 ' +
  'instead of the real file. Bias toward ACCEPTING any real, readable ' +
  'document, record, dataset, or notes — even if short.\n\n' +
  'Reject ONLY when the content is plainly not the intended file but a ' +
  'placeholder/shell, one of:\n' +
  '  - redirect_stub: a "your download will begin" / "click here to ' +
  'download" / JavaScript-redirect landing page fronting a real file\n' +
  '  - login_wall: a sign-in / subscribe / paywall / cookie wall\n' +
  '  - error_page: a 404 / access-denied / "enable JavaScript" / server-error stub\n' +
  '  - nav_chrome: a navigation menu / portal landing with no body content\n' +
  '  - wrong_content: real readable content, but plainly about a DIFFERENT ' +
  'subject than the stated intent\n' +
  '  - thin: almost nothing (a title and little else)\n\n' +
  'If you can see the URL of the real file in the page, put it in follow_url; ' +
  'else null. If the intent is "(not specified)", judge only shell-vs-real, ' +
  'not subject match.\n\n' +
  'Reply with ONLY this JSON, nothing else:\n' +
  '{"matches_intent": <bool>, "content_type": "match"|"redirect_stub"|' +
  '"login_wall"|"error_page"|"nav_chrome"|"wrong_content"|"thin", ' +
  '"confidence": <0..1>, "reason": "<short>", "follow_url": <string|null>}';

function strip_fence(s: string): string {
  const m = s.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
  return (m ? m[1]! : s).trim();
}

/** Cheap HTML→text so the judge reads content, not tag soup. */
function to_plain_text(body: string): string {
  return body
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

async function judge_download_intent(
  llm: LLMRouter,
  args: {
    text: string;
    description: string | null;
    sniffed: string;
    source_url?: string;
  },
): Promise<DownloadIntegrityVerdict | null> {
  let role;
  try {
    role = llm.for_role('planner');
  } catch {
    return null;
  }
  const plain = to_plain_text(args.text);
  const truncated =
    plain.length > JUDGE_BODY_CHARS
      ? plain.slice(0, JUDGE_BODY_CHARS) + '\n\n[...truncated]'
      : plain;
  let resp;
  try {
    resp = await role.provider.complete({
      messages: [
        { role: 'system', content: JUDGE_SYSTEM },
        {
          role: 'user',
          content:
            `Intended file: ${args.description?.trim() || '(not specified)'}\n` +
            `Detected format: ${args.sniffed}\n` +
            `Source URL: ${args.source_url ?? '(none)'}\n\n` +
            `Content:\n${truncated}\n\nReply with ONLY the JSON.`,
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
  if (r.data.matches_intent || r.data.content_type === 'match') {
    return { ok: true, sniffed_format: args.sniffed };
  }
  const follow = TEXTUAL_VERDICTS.has(r.data.content_type)
    ? (r.data.follow_url ?? find_binary_link(args.text, args.source_url)) || undefined
    : undefined;
  return {
    ok: false,
    content_type: r.data.content_type,
    reason: r.data.reason || `judged ${r.data.content_type}`,
    follow_url: follow,
    sniffed_format: args.sniffed,
  };
}

// ── the gate ──────────────────────────────────────────────────────────

/**
 * Assess a downloaded file. The single source of truth for "did this
 * download produce the file it was supposed to?" Structural sniff first;
 * the LLM intent judge only runs on the ambiguous text band; fail-open
 * everywhere.
 */
export async function assess_download_integrity(
  args: AssessDownloadArgs,
): Promise<DownloadIntegrityVerdict> {
  const mode = args.mode ?? 'full';
  const sniffed = sniff_format(args.bytes);
  if (mode === 'off') return { ok: true, sniffed_format: sniffed };

  if (sniffed === 'empty') {
    return {
      ok: false,
      content_type: 'thin',
      reason: 'the downloaded file was empty (0 bytes)',
      sniffed_format: 'empty',
    };
  }

  // Real binary bytes → it IS a file; the stand-in class is impossible.
  if (BINARY_FORMATS.has(sniffed)) {
    return { ok: true, sniffed_format: sniffed };
  }

  // From here the bytes decode as text: html | xml | json | text.
  const text = decode_text(args.bytes, JUDGE_BODY_CHARS * 2) ?? '';
  const expected = expected_kind(args.filename, args.url);

  // Asked for a binary, got text/HTML — the FCGOV redirect-stub class. A
  // type contradiction, not a judgment call: reject deterministically and
  // hand back the real file's link for a retry.
  if (expected.binary === true) {
    const follow = find_binary_link(text, args.url ?? undefined);
    return {
      ok: false,
      content_type: follow || sniffed === 'html' ? 'redirect_stub' : 'wrong_content',
      reason:
        `expected ${expected.label} but the server returned ` +
        `${sniffed.toUpperCase()} (${args.bytes.length} bytes)` +
        (follow
          ? ' — a landing/redirect page fronting the real file'
          : ' — likely a redirect or error page, not the file itself'),
      follow_url: follow,
      sniffed_format: sniffed,
    };
  }

  // Intended text (or unspecified) and got text — the genuinely ambiguous
  // band, and the only one that pays for the model. Fail-open without it.
  if (!args.llm) return { ok: true, sniffed_format: sniffed };
  const verdict = await judge_download_intent(args.llm, {
    text,
    description: args.description ?? null,
    sniffed,
    source_url: args.url ?? undefined,
  });
  return verdict ?? { ok: true, sniffed_format: sniffed };
}
