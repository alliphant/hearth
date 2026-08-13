/**
 * research_fetch — the binary-aware document fetcher shared by the
 * research subsystems (2026-06-19).
 *
 * Lifted out of src/specialists/cordelia/research_runner.ts so both
 * Cordelia's roster commissions AND Kate's subject-oriented deep-research
 * investigations import ONE fetcher instead of cross-importing each other.
 * Behavior is byte-identical to the commission runner's original (same
 * env var HEARTH_RESEARCH_MAX_DOC_BYTES, same magic-byte sniff, same
 * Firecrawl → warmed-browser page path via fetch_with_browser_fallback).
 *
 * A binary-document URL (a .pdf / .docx PATH, query string ignored) takes
 * the bytes path with a magic-byte sanity check; everything else rides the
 * page-fetch path (Firecrawl, escalating to the warmed browser on a bot
 * wall). The caller supplies optional seams so a smoke can inject canned
 * transports.
 */
import type { ToolContext } from '@core/tool';
import {
  fetch_with_browser_fallback,
  type AttributionRefusal,
  type FetchOutcome,
} from '@connectors/fetch_with_browser_fallback';
import type { AttributionTier } from '@core/research_attribution';

export type DocumentFetch =
  | { kind: 'document'; bytes: Uint8Array; mime: string; filename: string }
  | {
      kind: 'markdown';
      markdown: string;
      title: string | null;
      /** Anonymous-only read: the browser escalation was refused because it
       *  would have been traceable to this household. The text is real but may
       *  be a login shell — the caller should say so rather than trust it. */
      attribution_capped?: AttributionRefusal;
    }
  | { kind: 'deferred'; reason: string }
  | { kind: 'failed'; reason: string; refused?: AttributionRefusal };

export interface FetchDocOptions {
  /** Ceiling on what this fetch may disclose. See research_attribution.ts. */
  attribution_cap?: AttributionTier;
}

/** Smoke seams — default to the real connectors. */
export interface FetchDocSeams {
  /** Binary-document fetch (PDF/DOCX bytes). */
  fetch_doc_fn?: (url: string, mime: string) => Promise<DocumentFetch>;
  /** Web-page fetch (Firecrawl → warmed browser). */
  fetch_page_fn?: typeof fetch_with_browser_fallback;
}

function max_doc_bytes(): number {
  return parseInt(
    process.env.HEARTH_RESEARCH_MAX_DOC_BYTES ?? String(50 * 1024 * 1024),
    10,
  );
}

const DOC_MIME_BY_EXT: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};

/**
 * Document mime for a URL whose PATH ends in a binary-document
 * extension (query string ignored — the Trek service-manual case is a
 * .pdf path with a long SAS query). null = treat as a web page.
 */
export function document_mime_for_url(url: string): string | null {
  try {
    const path = new URL(url).pathname.toLowerCase();
    for (const [ext, mime] of Object.entries(DOC_MIME_BY_EXT)) {
      if (path.endsWith(ext)) return mime;
    }
    return null;
  } catch {
    return null;
  }
}

function filename_from_url(url: string): string {
  try {
    const last = new URL(url).pathname.split('/').filter(Boolean).pop();
    return last ? decodeURIComponent(last) : 'document';
  } catch {
    return 'document';
  }
}

/** Magic-byte sanity: a "PDF" that opens with an HTML tag is a login
 *  wall / interstitial, not the document. */
function sniff_matches(mime: string, bytes: Uint8Array): boolean {
  if (bytes.length < 4) return false;
  const head = new TextDecoder('latin1').decode(bytes.slice(0, 256)).trimStart();
  if (mime === 'application/pdf') return head.startsWith('%PDF');
  // docx is a zip — PK\x03\x04
  return bytes[0] === 0x50 && bytes[1] === 0x4b;
}

async function default_fetch_doc(url: string, mime: string): Promise<DocumentFetch> {
  const cap = max_doc_bytes();
  let res: Response;
  try {
    res = await fetch(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(120_000),
      headers: { 'User-Agent': 'hearth-research/1.0 (+household library)' },
    });
  } catch (err) {
    return { kind: 'failed', reason: `fetch failed: ${(err as Error).message}` };
  }
  if (!res.ok) return { kind: 'failed', reason: `HTTP ${res.status}` };
  const declared = Number(res.headers.get('content-length') ?? '0');
  if (declared > cap) {
    return { kind: 'failed', reason: `declared ${declared} bytes, over the ${cap}-byte cap` };
  }
  if (!res.body) return { kind: 'failed', reason: 'response had no body' };
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > cap) {
        await reader.cancel();
        return { kind: 'failed', reason: `download exceeded the ${cap}-byte cap` };
      }
      chunks.push(value);
    }
  }
  if (total === 0) return { kind: 'failed', reason: 'downloaded document was empty' };
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  if (!sniff_matches(mime, bytes)) {
    return {
      kind: 'failed',
      reason:
        'URL did not return the expected document (got an HTML/landing page — ' +
        'login wall or interstitial?). Find a direct link.',
    };
  }
  return { kind: 'document', bytes, mime, filename: filename_from_url(url) };
}

/** Binary-document URLs take the bytes path; everything else rides the
 *  Firecrawl → warmed-browser page path. */
export async function fetch_document(
  seams: FetchDocSeams,
  ctx: ToolContext,
  url: string,
  title_fallback?: string,
  opts: FetchDocOptions = {},
): Promise<DocumentFetch> {
  const mime = document_mime_for_url(url);
  if (mime) {
    // The binary path is a plain anonymous GET — no browser, no session, so
    // nothing to disclose and nothing to cap.
    const doc_fn = seams.fetch_doc_fn ?? default_fetch_doc;
    return doc_fn(url, mime);
  }
  const page_fn = seams.fetch_page_fn ?? fetch_with_browser_fallback;
  const outcome: FetchOutcome = await page_fn(url, ctx, {
    ...(title_fallback !== undefined ? { title_fallback } : {}),
    ...(opts.attribution_cap !== undefined ? { attribution_cap: opts.attribution_cap } : {}),
  });
  if (outcome.kind === 'deferred') return { kind: 'deferred', reason: outcome.reason };
  if (outcome.kind === 'failed') {
    return {
      kind: 'failed',
      reason: outcome.reason,
      ...(outcome.refused ? { refused: outcome.refused } : {}),
    };
  }
  return {
    kind: 'markdown',
    markdown: outcome.markdown,
    title: outcome.title,
    ...(outcome.kind === 'firecrawl' && outcome.attribution_capped
      ? { attribution_capped: outcome.attribution_capped }
      : {}),
  };
}
