/**
 * Per-specialist library upload — extends the existing /inbox conversion
 * pipeline by routing the resulting wrapper note into the specialist's
 * own knowledge namespace instead of the global Inbox/.
 *
 * Endpoints:
 *   POST /app/api/library/upload   multipart file → wrapper note in the
 *                                  specialist's namespace
 *   POST /app/api/library/url      JSON { url, specialist_id } → same
 *   GET  /app/api/library/:specialist_id   list items in that library
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { ulid } from 'ulid';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';
import matter from 'gray-matter';
import { convert } from '@inbox/pipeline';
import type { ConversionInput } from '@inbox/types';
import { local_iso_date } from '@core/time';
import type { Database } from 'bun:sqlite';
import type { MemoryClient } from '@memory/client';
import type { SpecialistRegistry, LoadedSpecialist } from '@core/specialist';
import { resolve_trust_tier } from '@core/specialist';
import { fetch_with_browser_fallback } from '@connectors/fetch_with_browser_fallback';
import {
  assess_capture_quality,
  type CaptureRejection,
  type QualityMode,
} from '@connectors/capture_quality';
import type { SpecialistRuntime } from '@core/specialist_runtime';
import type { ConversationStore } from '@memory/stores/conversations';
import { capitalize } from '@core/loops';
import { to_turn_user } from '@core/users';
import type { AppEventBus } from '../events';

const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

/**
 * Archive grace period. An archived library item sits in
 * `Knowledge/<Spec>/library/_archive/` for this many days, then the
 * opportunistic sweeper (see `sweep_expired_archives`) hard-deletes
 * it. Picked at 30 days as a forgiving "did I mistakenly upload
 * something?" undo window — long enough that the user notices a
 * regression in specialist behavior, short enough that abandoned
 * archives don't accumulate.
 */
const ARCHIVE_PURGE_DAYS = 30;

export interface LibraryRoutesDeps {
  db: Database;
  vault_root: string;
  memory: MemoryClient;
  specialists: SpecialistRegistry;
  runtime: SpecialistRuntime;
  conversations: ConversationStore;
  /** For ingest-time summary generation via the scribe_writer role. */
  llm?: import('@core/llm').LLMRouter;
  /**
   * RAG embedder (Pass 7). When `.enabled`, library ingest also writes
   * per-chunk embeddings (best-effort). A `NoopEmbedder` (the default when
   * HEARTH_RAG_VECTOR is off) makes embed-at-ingest a no-op.
   */
  embedder?: import('@core/embeddings').Embedder;
  events?: AppEventBus;
}

/**
 * Naive paragraph-boundary chunker. ~1000-char target, split on blank lines,
 * fall back to length-cap when a paragraph is itself long. Good enough for
 * FTS5 keyword search until Pass 7 brings in embeddings.
 */
function chunk_markdown(text: string, max_chars = 1200): string[] {
  const paras = text.split(/\n{2,}/).map((p) => p.trim()).filter((p) => p.length > 0);
  const out: string[] = [];
  let buf = '';
  for (const para of paras) {
    if (para.length > max_chars) {
      if (buf.length > 0) {
        out.push(buf);
        buf = '';
      }
      for (let i = 0; i < para.length; i += max_chars) {
        out.push(para.slice(i, i + max_chars));
      }
      continue;
    }
    if (buf.length + para.length + 2 > max_chars) {
      out.push(buf);
      buf = para;
    } else {
      buf = buf.length === 0 ? para : `${buf}\n\n${para}`;
    }
  }
  if (buf.length > 0) out.push(buf);
  return out;
}

/**
 * One-shot LLM title + summary at ingest time. The PDF/image
 * converter's "title" is just the first non-empty line of extracted
 * text — usually a header dump like "the clinic VTH: Jasper Doe,'Bailey'
 * ,0000000, Visit Date: 2/17/2026 Page 1 VISIT MEDICAL SUMMARY..." —
 * which is unreadable in the library UI and produces an equally
 * unreadable filename slug. This call generates a clean, human-
 * friendly title (8-14 words) AND the 1-2 sentence summary in a
 * single completion so the library list is glanceable.
 *
 * Routed through `scribe_writer` (think OFF, no specialist model
 * tie-up). Body capped at 8k chars so long PDFs don't time out.
 */
async function titleize_and_summarize_for_ingest(
  deps: LibraryRoutesDeps,
  extracted_title_hint: string,
  body: string,
): Promise<{ title?: string; summary?: string }> {
  const role = deps.llm?.for_role('scribe_writer');
  if (!role) return {};
  const truncated =
    body.length > 8000
      ? body.slice(0, 8000) + '\n\n[...truncated for summary]'
      : body;
  const resp = await role.provider.complete({
    messages: [
      {
        role: 'system',
        content:
          "You produce two short fields for a household vault's library entry.\n\n" +
          'FORMAT — reply with these two lines EXACTLY, nothing else:\n' +
          'TITLE: <8-14 word human-friendly title>\n' +
          'SUMMARY: <1-2 sentence summary, ~60 words max, plain prose>\n\n' +
          'TITLE GUIDELINES:\n' +
          '- Treat the entry as something a human will scan in a list. Examples of good titles:\n' +
          '  "Bailey\'s the clinic VTH internal medicine visit — Feb 17, 2026"\n' +
          '  "Eleanor\'s soil test results from Front Range Ag — Apr 2026"\n' +
          '  "Mortgage closing docs — 3215 Westwood, Sep 2024"\n' +
          '- Lead with the WHO (person/pet/property) and WHAT, then any date worth knowing.\n' +
          '- No raw header dumps, no page numbers, no patient IDs, no all-caps section names.\n' +
          '- Do not include the file extension. Do not start with "Document:" or "PDF:".\n\n' +
          'SUMMARY GUIDELINES:\n' +
          '- What kind of doc, who/what it concerns, the most important factual content.\n' +
          '- Never invent details. Use only what is in the body.\n' +
          '- Plain prose, no headings, no bullets.',
      },
      {
        role: 'user',
        content:
          `Extracted-first-line hint (may be garbage — use only if useful): ${extracted_title_hint}\n\n` +
          `Body:\n${truncated}`,
      },
    ],
    temperature: 0.3,
    think: false,
  });
  const out = resp.content.trim();
  if (!out) return {};
  // Parse the two-line response. Be lenient: the model may add a
  // blank line, or wrap the summary across multiple lines. Anything
  // after "SUMMARY:" up to end-of-message is the summary.
  const title_match = out.match(/^\s*TITLE:\s*(.+?)\s*$/im);
  const summary_match = out.match(/SUMMARY:\s*([\s\S]+?)\s*$/im);
  const title = title_match?.[1]?.trim();
  const summary = summary_match?.[1]?.trim();
  return {
    title: title && title.length > 0 ? title.slice(0, 140) : undefined,
    summary: summary && summary.length > 0 ? summary : undefined,
  };
}

export function index_chunks(db: Database, note_path: string, body: string): string[] {
  // Remove any prior rows for this note (idempotent re-upload).
  db.prepare(`DELETE FROM chunks_fts WHERE note_path = @p`).run({ '@p': note_path });
  const chunks = chunk_markdown(body);
  const stmt = db.prepare(
    `INSERT INTO chunks_fts (note_path, chunk_idx, chunk_text) VALUES (@p, @i, @c)`,
  );
  for (let i = 0; i < chunks.length; i++) {
    stmt.run({ '@p': note_path, '@i': i, '@c': chunks[i]! });
  }
  return chunks;
}

/**
 * Embed a note's chunks and store them in `chunk_embeddings` (RAG Pass 7).
 * Best-effort + fail-open: a NoopEmbedder (flag off) or a down/slow
 * embeddings server logs and continues — `scripts/backfill-embeddings.ts`
 * reconciles any chunk that didn't get embedded at ingest.
 * The `(note_path, chunk_idx)` keys mirror chunks_fts exactly.
 *
 * THE INVARIANT: a vector never outlives the chunk text it was made from.
 * The caller just replaced this note's chunks_fts rows, so any path that
 * can't write FRESH vectors must CLEAR the stale ones — otherwise a
 * re-save with the embedder off (or throwing) leaves vector RAG serving
 * the previous body's content at chunk indices that no longer mean that.
 * Missing vectors are recoverable (backfill); wrong ones are not.
 */
export async function embed_chunks_best_effort(
  deps: LibraryRoutesDeps,
  note_path: string,
  chunks: string[],
): Promise<void> {
  const embedder = deps.embedder;
  if (!embedder?.enabled || chunks.length === 0) {
    deps.memory.delete_chunk_embeddings(note_path);
    return;
  }
  try {
    const vectors = await embedder.embed(chunks);
    if (vectors.length !== chunks.length) {
      deps.memory.delete_chunk_embeddings(note_path);
      return;
    }
    deps.memory.upsert_chunk_embeddings(
      note_path,
      vectors.map((embedding, chunk_idx) => ({ chunk_idx, embedding })),
      embedder.model,
    );
  } catch (err) {
    deps.memory.delete_chunk_embeddings(note_path);
    console.error(
      `[library] embed-at-ingest failed for ${note_path} (backfill will catch up):`,
      err,
    );
  }
}

export interface SavedItem {
  id: string;
  wrapper_note_path: string;
  attachment_path?: string;
  title: string;
  kind: string;
  specialist_id: string;
  acknowledged: boolean;
}

const UrlSchema = z.object({
  url: z.string().url(),
  specialist_id: z.string(),
  acknowledge: z.boolean().optional(),
  // Slice A — 2026-05-30. Curation scripts (and Slice B's
  // `curate_for_specialist` tool) pass an explicit trust tier so
  // hand-vetted seed lists don't have to rely on URL-host inference
  // (which would tag a curated Cochrane review correctly but miss a
  // PDF mirror hosted on a generic CDN). Normal uploads omit and let
  // save_library_item infer from the URL host.
  trust_tier: z.union([z.literal(1), z.literal(2)]).optional(),
  // 2026-05-30. When the URL host is known-bot-blocked (Mayo,
  // Cleveland Clinic, Harvard Health, publishers behind Cloudflare
  // /PerimeterX), Firecrawl returns 403/406. With this flag, the
  // endpoint retries via the workstation's warmed Firefox profile on the
  // same URL — same shape as Cordelia's `curate_for_specialist`
  // bot-fallback. Default off because the browser path is slower +
  // ties up the workstation's session pool.
  try_browser_fallback: z.boolean().optional(),
});

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
}

function sanitize_filename(name: string): string {
  const ext = extname(name);
  const base = basename(name, ext)
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .slice(0, 80);
  return base + ext.toLowerCase();
}

/**
 * The specialist's library lives under Knowledge/<CapitalizedId>/library/
 * — matching the convention used everywhere else (memory_files.ts,
 * loops.ts, etc.: `capitalize(spec.id)`, e.g. `Knowledge/Anya/`,
 * `Knowledge/Kate/`). Previously this used `spec.name` which broke for
 * display names that aren't a pure capitalization of the id (e.g.
 * "Dr. Anya" → `Knowledge/Dr. Anya/`, which no one else looked at).
 */
function destination_dirs(spec: LoadedSpecialist, vault_root: string) {
  const ns = capitalize(spec.id);
  const lib_rel = `Knowledge/${ns}/library`;
  const att_rel = `Knowledge/${ns}/library/_attachments`;
  const lib_abs = resolve(vault_root, lib_rel);
  const att_abs = resolve(vault_root, att_rel);
  mkdirSync(att_abs, { recursive: true });
  return { lib_rel, att_rel, lib_abs, att_abs };
}

/**
 * Fetch a binary (PDF/DOCX) for the interstitial auto-follow, size- and
 * time-capped. `safe_fetch` in _audit.ts is text-only (it calls
 * `res.text()`), which corrupts binary, so the follow uses this. Returns
 * null on any failure or oversize body — the caller then falls back to a
 * plain rejection (still stops the junk).
 */
async function fetch_binary_capped(
  url: string,
  max_bytes = MAX_UPLOAD_BYTES,
  timeout_ms = 20_000,
): Promise<Uint8Array | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeout_ms) });
    if (!res.ok) return null;
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.byteLength === 0 || buf.byteLength > max_bytes) return null;
    return buf;
  } catch {
    return null;
  }
}

/**
 * Browser-retry seam. A URL capture the quality gate rejects as a paywall /
 * nav-chrome shell may render in the warmed, signed-in Firefox on the workstation
 * even though Firecrawl couldn't get past it. `save_library_item` retries
 * once through this; the indirection is a test seam (`_test_set_browser_fetch`)
 * so the retry path can be smoked without the box.
 */
let _browser_fetch: typeof fetch_with_browser_fallback = fetch_with_browser_fallback;
export function _test_set_browser_fetch(
  fn: typeof fetch_with_browser_fallback | null,
): void {
  _browser_fetch = fn ?? fetch_with_browser_fallback;
}

export async function save_library_item(
  deps: LibraryRoutesDeps,
  input: ConversionInput,
  spec: LoadedSpecialist,
  opts: {
    source: 'file' | 'url';
    source_url?: string;
    upload_id?: string;
    tz?: string;
    /**
     * Override the URL-host-derived trust tier. Used by the seed
     * curation script when injecting a hand-curated list — the
     * caller has already vetted each URL, so we accept its
     * classification verbatim. Normal route handlers leave this
     * unset and `save_library_item` infers tier from the URL
     * host against the specialist's `trusted_sources` manifest.
     * Pass `null` to deliberately skip tier classification.
     */
    trust_tier_override?: 1 | 2 | null;
    /**
     * Capture quality gate (#2b). 'full' (default) runs the structural
     * pre-filter + LLM judge and rejects shells (nav-chrome,
     * interstitials, paywalls, thin captures). 'minimal' (direct user
     * uploads) only rejects near-empty bodies — a deliberate upload
     * shouldn't be second-guessed. 'off' bypasses entirely.
     */
    quality_gate?: QualityMode;
    /**
     * Visibility scope (per-user cordon, 2026-06-04). A DIRECT USER
     * upload passes the uploader's id so the item cordons to them
     * (`private_to: <user_id>`). System curation (`curate_for_specialist`
     * enriching a shelf with public reference material) leaves this
     * undefined/null → shelf-wide, visible to anyone using that
     * specialist. Flows into both the wrapper frontmatter and the
     * library_files row.
     */
    private_to?: string | null;
  },
): Promise<SavedItem | CaptureRejection> {
  const upload_id = opts.upload_id;
  // Phase-by-phase status fanout so the UI can show italicized
  // progress underneath the dropped file. The client matched our
  // emit on upload_id (passed as a form field).
  const progress = (
    phase:
      | 'received'
      | 'converting'
      | 'summarizing'
      | 'indexing'
      | 'acknowledging'
      | 'done'
      | 'failed',
    detail?: string,
    error?: string,
  ): void => {
    if (!upload_id) return;
    deps.events?.emit({
      type: 'library_upload_progress',
      upload_id,
      specialist_id: spec.id,
      filename: input.filename,
      phase,
      detail,
      error,
    });
  };

  progress('converting', input.filename);
  let result = await convert(input);

  // Capture quality gate (#2b — 2026-05-30). Reject shells (nav-chrome,
  // download interstitials, paywalls, thin captures) before they're
  // written + Tier-1 stamped into a specialist's library, where they'd
  // be cited as durable truth. Structural pre-filter + LLM judge; see
  // src/connectors/capture_quality.ts. For interstitials that front a
  // real binary, follow ONCE to the actual file so the real document
  // lands on the shelf instead of the cover page.
  const quality_mode: QualityMode = opts.quality_gate ?? 'full';
  let followed = false;
  let browser_tried = false;
  for (;;) {
    const verdict = await assess_capture_quality({
      body: result.markdown_body,
      source_url: opts.source_url,
      kind: result.kind,
      mode: quality_mode,
      llm: deps.llm,
    });
    if (verdict.ok) break;
    // Paywall / nav-chrome shell on a URL capture → the warmed signed-in
    // Firefox on the workstation may render what Firecrawl couldn't. Retry the
    // fetch ONCE through the browser before rejecting; on success, swap the
    // body in place and re-assess. Fail-open: if the browser can't rescue it
    // (box down, still gated, empty) we fall through to the reject below.
    if (
      !browser_tried &&
      opts.source === 'url' &&
      opts.source_url &&
      quality_mode === 'full' &&
      (verdict.content_type === 'paywall' || verdict.content_type === 'nav_chrome')
    ) {
      browser_tried = true;
      progress('converting', `browser retry (${verdict.content_type})`);
      try {
        const outcome = await _browser_fetch(opts.source_url, {
          intent_id: `library_browser_retry:${ulid()}`,
          memory: deps.memory,
          specialist_id: spec.id,
        });
        if (
          (outcome.kind === 'browser' || outcome.kind === 'firecrawl') &&
          outcome.markdown.trim().length > 0
        ) {
          result = {
            ...result,
            markdown_body: outcome.markdown,
            title: outcome.title ?? result.title,
          };
          continue;
        }
      } catch (err) {
        console.error(
          `[library] browser retry for ${opts.source_url} failed: ${(err as Error).message}`,
        );
      }
      // fall through to reject — the browser couldn't rescue it either.
    }
    // Interstitial → fetch the real binary and re-convert (once).
    if (
      verdict.content_type === 'interstitial' &&
      verdict.follow_url &&
      !followed &&
      quality_mode === 'full'
    ) {
      progress('converting', `following ${verdict.follow_url}`);
      const bytes = await fetch_binary_capped(verdict.follow_url);
      if (bytes) {
        followed = true;
        input = {
          filename: verdict.follow_url,
          mime_type: 'application/pdf',
          bytes,
        };
        result = await convert(input);
        continue;
      }
    }
    // Reject: do not write. Audit the rejection so it's queryable.
    progress('failed', undefined, `quality gate: ${verdict.reason}`);
    deps.memory.log_action({
      intent_id: `library_capture_rejected:${ulid()}`,
      agent: 'orchestrator',
      tool_name: 'library_capture_rejected',
      tool_input: {
        specialist_id: spec.id,
        source: opts.source,
        source_url: opts.source_url,
        filename: input.filename,
        content_type: verdict.content_type,
      },
      execution_result: { reason: verdict.reason, follow_url: verdict.follow_url },
    });
    return {
      rejected: true,
      content_type: verdict.content_type ?? 'thin',
      reason: verdict.reason ?? 'low-quality capture',
      follow_url: verdict.follow_url,
    };
  }

  const id = `c_${ulid().toLowerCase().slice(-10)}`;
  const { lib_rel, att_rel } = destination_dirs(spec, deps.vault_root);
  const date_str = local_iso_date(new Date(), opts.tz);

  let attachment_rel: string | undefined;
  if (result.attachment_bytes && result.attachment_filename) {
    const safe = sanitize_filename(result.attachment_filename);
    attachment_rel = `${att_rel}/${id}-${safe}`;
    const att_abs = resolve(deps.vault_root, attachment_rel);
    mkdirSync(dirname(att_abs), { recursive: true });
    writeFileSync(att_abs, result.attachment_bytes);
  }

  // Generate a clean human-friendly title + summary in one LLM call.
  // The converter's `result.title` is just the first non-empty line of
  // extracted text (e.g. "the clinic VTH: Jasper Doe,'Bailey' ,0000000,
  // Visit Date: 2/17/2026 Page 1..."), which makes for an unreadable
  // library list and a worthless filename slug. The titleize call gives
  // us "Bailey's the clinic VTH internal medicine visit — Feb 17, 2026" style
  // titles. Best-effort: on failure we fall back to result.title so the
  // upload still completes.
  let clean_title: string | undefined;
  let summary: string | undefined;
  if (result.markdown_body.length > 500) {
    progress('summarizing', 'generating title and summary...');
    try {
      const out = await titleize_and_summarize_for_ingest(
        deps,
        result.title,
        result.markdown_body,
      );
      clean_title = out.title;
      summary = out.summary;
    } catch (err) {
      console.error('[library] title/summary generation failed:', err);
    }
  }
  const display_title = clean_title || result.title;

  const slug = slugify(display_title) || id;
  const wrapper_rel = `${lib_rel}/${date_str}-${slug}.md`;

  const frontmatter: Record<string, unknown> = {
    type: 'clipping',
    id,
    kind: result.kind,
    source: opts.source,
    title: display_title,
    captured_at: new Date().toISOString(),
    reviewed: false,
    tags: [],
    extracted_metadata: result.extracted_metadata,
    specialist_scope: spec.id,
  };
  // Preserve the raw extracted header for debugging / re-titleizing.
  if (clean_title && result.title && clean_title !== result.title) {
    frontmatter.extracted_header = result.title;
  }
  if (summary) frontmatter.summary = summary;
  if (opts.source_url) frontmatter.source_url = opts.source_url;
  if (attachment_rel) frontmatter.attachment_path = attachment_rel;
  // Per-user cordon: a direct user upload scopes to the uploader; system
  // curation leaves it shelf-wide (NULL). Projected into clippings.private_to
  // by the ingestor, so the unified search filters it for the caller.
  if (opts.private_to) frontmatter.private_to = opts.private_to;

  // Trust tier (Slice A — 2026-05-30). Stamp provenance into the
  // wrapper so specialists know whether they're reading peer-reviewed
  // / professional-body content (Tier 1, no attribution required) or
  // clinical-lay / practitioner content (Tier 2, cite when used).
  // Inferred from the URL host against the specialist's `trusted_sources`
  // manifest unless the caller overrode (the seed-curation case).
  const tier: 1 | 2 | null =
    opts.trust_tier_override !== undefined
      ? opts.trust_tier_override
      : opts.source_url
        ? resolve_trust_tier(opts.source_url, spec)
        : null;
  if (tier !== null) frontmatter.trust_tier = tier;

  let body = result.markdown_body;
  if (result.kind === 'image' && attachment_rel) {
    body = `![${display_title}](${attachment_rel})\n`;
  }

  progress('indexing', 'writing note and indexing...');
  deps.memory.upsert_note(wrapper_rel, frontmatter, body);

  // Index the body into chunks_fts so the unified search can find content
  // inside library uploads today (embeddings come in Pass 7). Runs even for
  // an EMPTY body: this path is create-or-REPLACE, and skipping it would
  // leave a prior save's chunks + vectors indexed under a note that no
  // longer says any of it (index_chunks/embed both clear-then-write).
  try {
    const chunks = index_chunks(deps.db, wrapper_rel, body);
    await embed_chunks_best_effort(deps, wrapper_rel, chunks);
    deps.events?.emit({ type: 'search_index_updated' });
  } catch (err) {
    console.error('[library] chunk indexing failed:', err);
  }

  deps.memory.log_action({
    intent_id: `library_upload:${ulid()}`,
    agent: 'orchestrator',
    tool_name: 'library_upload',
    tool_input: {
      specialist_id: spec.id,
      source: opts.source,
      source_url: opts.source_url,
      filename: input.filename,
      kind: result.kind,
    },
    execution_result: {
      id,
      wrapper_note_path: wrapper_rel,
      attachment_path: attachment_rel,
    },
  });

  deps.events?.emit({
    type: 'library_updated',
    specialist_id: spec.id,
    item_count_delta: 1,
  });

  return {
    id,
    wrapper_note_path: wrapper_rel,
    attachment_path: attachment_rel,
    title: result.title,
    kind: result.kind,
    specialist_id: spec.id,
    acknowledged: false,
  };
}

/**
 * Optionally produce a short in-character acknowledgement from the specialist
 * about the new library item. The acknowledgement goes into the most-recent
 * conversation with that specialist (so the user sees it without changing
 * threads). When no conversation exists yet, skip silently — there's nowhere
 * to surface the message.
 */
async function acknowledge_addition(
  deps: LibraryRoutesDeps,
  spec: LoadedSpecialist,
  title: string,
  user: import('@core/users').TurnUser | undefined,
): Promise<boolean> {
  const recent = deps.conversations.list({ specialist_id: spec.id, limit: 1 });
  if (recent.length === 0) return false;
  const conv = recent[0]!;
  const prompt =
    `The user just added a new item to your library: "${title}". ` +
    `Acknowledge it briefly in your voice (one sentence, max ~30 words). ` +
    `No tools. No JSON. Just a single warm sentence.`;
  try {
    const out = await deps.runtime.turn({
      specialist_id: spec.id,
      conversation_id: conv.id,
      message: { role: 'user', content: prompt },
      conversation_history: deps.conversations.list_messages(conv.id, { limit: 10 }).map((m) => ({
        role: m.role,
        content: m.content_md,
        specialist_id: m.specialist_id ?? undefined,
      })),
      // Phase 2b — the ack runs as the uploader. If that uploader's
      // tier doesn't allow access to this specialist (e.g. Sam uploads
      // to Cassandra's library), the hard gate prevents the ack from
      // running — same boundary as a regular chat turn.
      user,
    });
    const msg = deps.conversations.append_message({
      conversation_id: conv.id,
      role: 'specialist',
      specialist_id: spec.id,
      content_md: out.message_text,
    });
    deps.events?.emit({
      type: 'message_added',
      conversation_id: conv.id,
      message_id: msg.id,
      role: 'specialist',
      specialist_id: spec.id,
      content_preview: out.message_text.slice(0, 200),
    });
    return true;
  } catch (err) {
    console.error('[library] acknowledgement failed:', err);
    return false;
  }
}

export function create_library_router(deps: LibraryRoutesDeps): Hono {
  const r = new Hono();

  r.post('/upload', async (c) => {
    let body: Record<string, unknown>;
    try {
      body = await c.req.parseBody();
    } catch (err) {
      return c.json({ error: `Failed to parse upload: ${(err as Error).message}` }, 400);
    }
    const file = body.file;
    const sid_raw = body.specialist_id;
    if (!(file instanceof File)) {
      return c.json({ error: 'No file in upload (field name "file")' }, 400);
    }
    if (typeof sid_raw !== 'string' || sid_raw.length === 0) {
      return c.json({ error: 'specialist_id (string) required' }, 400);
    }
    const spec = deps.specialists.get(sid_raw);
    if (!spec) return c.json({ error: `unknown specialist: ${sid_raw}` }, 400);
    if (file.size > MAX_UPLOAD_BYTES) {
      return c.json(
        { error: `File too large: ${file.size} bytes (max ${MAX_UPLOAD_BYTES})` },
        413,
      );
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    const ack_param =
      typeof body.acknowledge === 'string'
        ? body.acknowledge.toLowerCase() === 'true'
        : undefined;
    const upload_id = typeof body.upload_id === 'string' ? body.upload_id : undefined;
    if (upload_id) {
      deps.events?.emit({
        type: 'library_upload_progress',
        upload_id,
        specialist_id: spec.id,
        filename: file.name,
        phase: 'received',
        detail: `${(file.size / 1024).toFixed(0)} KB`,
      });
    }

    try {
      const saved = await save_library_item(
        deps,
        {
          filename: file.name,
          mime_type: file.type || 'application/octet-stream',
          bytes,
        },
        spec,
        // Direct user upload — only the near-empty hard floor applies; a
        // deliberate upload shouldn't be second-guessed by the judge.
        // Cordon to the uploader.
        {
          source: 'file',
          upload_id,
          tz: c.get('user_tz'),
          quality_gate: 'minimal',
          private_to: c.get('user')?.id ?? null,
        },
      );
      if ('rejected' in saved) {
        if (upload_id) {
          deps.events?.emit({
            type: 'library_upload_progress',
            upload_id,
            specialist_id: spec.id,
            filename: file.name,
            phase: 'failed',
            error: saved.reason,
          });
        }
        return c.json({ error: saved.reason, content_type: saved.content_type }, 422);
      }
      if (ack_param ?? true) {
        if (upload_id) {
          deps.events?.emit({
            type: 'library_upload_progress',
            upload_id,
            specialist_id: spec.id,
            filename: file.name,
            phase: 'acknowledging',
            detail: `${spec.name} is acknowledging...`,
          });
        }
        saved.acknowledged = await acknowledge_addition(deps, spec, saved.title, to_turn_user(c.get('user'), c.get('user_tz')));
      }
      if (upload_id) {
        deps.events?.emit({
          type: 'library_upload_progress',
          upload_id,
          specialist_id: spec.id,
          filename: file.name,
          phase: 'done',
        });
      }
      return c.json(saved);
    } catch (err) {
      if (upload_id) {
        deps.events?.emit({
          type: 'library_upload_progress',
          upload_id,
          specialist_id: spec.id,
          filename: file.name,
          phase: 'failed',
          error: err instanceof Error ? err.message : String(err),
        });
      }
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  r.post('/url', async (c) => {
    let payload: unknown;
    try {
      payload = await c.req.json();
    } catch (err) {
      return c.json({ error: `Invalid JSON: ${(err as Error).message}` }, 400);
    }
    const parsed = UrlSchema.safeParse(payload);
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    const spec = deps.specialists.get(parsed.data.specialist_id);
    if (!spec) return c.json({ error: `unknown specialist: ${parsed.data.specialist_id}` }, 400);
    try {
      let conversion_input: ConversionInput = {
        filename: parsed.data.url,
        mime_type: 'text/url',
        url: parsed.data.url,
      };
      if (parsed.data.try_browser_fallback) {
        const outcome = await fetch_with_browser_fallback(
          parsed.data.url,
          { specialist_id: 'orchestrator', intent_id: ulid(), memory: deps.memory },
        );
        if (outcome.kind === 'failed' || outcome.kind === 'deferred') {
          return c.json(
            { error: `fetch failed for ${parsed.data.url}: ${outcome.reason}` },
            502,
          );
        }
        if (outcome.kind === 'browser') {
          conversion_input = {
            filename: parsed.data.url,
            mime_type: 'text/markdown',
            text: outcome.markdown,
          };
        }
        // kind === 'firecrawl' — leave conversion_input as the text/url shape;
        // save_library_item's convert() will re-fetch with the same Firecrawl
        // bytes (idempotent; cache-friendly).
      }
      const saved = await save_library_item(
        deps,
        conversion_input,
        spec,
        {
          source: 'url',
          source_url: parsed.data.url,
          tz: c.get('user_tz'),
          trust_tier_override: parsed.data.trust_tier,
          // Cordon a user's URL grab to them; curation paths pass null.
          private_to: c.get('user')?.id ?? null,
        },
      );
      if ('rejected' in saved) {
        return c.json(
          {
            error: saved.reason,
            content_type: saved.content_type,
            follow_url: saved.follow_url,
          },
          422,
        );
      }
      if (parsed.data.acknowledge ?? true) {
        saved.acknowledged = await acknowledge_addition(deps, spec, saved.title, to_turn_user(c.get('user'), c.get('user_tz')));
      }
      return c.json(saved);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  /**
   * Project one library wrapper note from disk into the list item
   * shape. Shared between the active list, the archived shelf, and
   * the single-item detail endpoint so the metadata projection stays
   * consistent. `dir_rel` is the vault-relative directory the file
   * lives in (`Knowledge/<Ns>/library` for active items,
   * `Knowledge/<Ns>/library/_archive` for archived).
   */
  function project_item(
    lib_dir_abs: string,
    dir_rel: string,
    name: string,
  ): {
    path: string;
    filename: string;
    title: string;
    summary: string | null;
    captured_at: string;
    kind: string;
    source_url: string | null;
    attachment_path: string | null;
    id: string | null;
    archived_at: string | null;
    archive_purge_at: string | null;
    trust_tier: 1 | 2 | null;
  } {
    const full = join(lib_dir_abs, name);
    const stat = statSync(full);
    let title = name.replace(/\.md$/, '');
    let captured_at = stat.mtime.toISOString();
    let kind = 'other';
    let summary: string | null = null;
    let source_url: string | null = null;
    let attachment_path: string | null = null;
    let id: string | null = null;
    let archived_at: string | null = null;
    let archive_purge_at: string | null = null;
    let trust_tier: 1 | 2 | null = null;
    try {
      const parsed = matter(readFileSync(full, 'utf8'));
      const fm = parsed.data as Record<string, unknown>;
      if (typeof fm.title === 'string') title = fm.title;
      if (typeof fm.captured_at === 'string') captured_at = fm.captured_at;
      if (typeof fm.kind === 'string') kind = fm.kind;
      if (typeof fm.summary === 'string') summary = fm.summary;
      if (typeof fm.source_url === 'string') source_url = fm.source_url;
      if (typeof fm.attachment_path === 'string') attachment_path = fm.attachment_path;
      if (typeof fm.id === 'string') id = fm.id;
      if (typeof fm.archived_at === 'string') archived_at = fm.archived_at;
      if (typeof fm.archive_purge_at === 'string') archive_purge_at = fm.archive_purge_at;
      if (fm.trust_tier === 1 || fm.trust_tier === 2) trust_tier = fm.trust_tier;
    } catch {
      // ignore — partial metadata still produces a usable row
    }
    return {
      path: `${dir_rel}/${name}`,
      filename: name,
      title,
      summary,
      captured_at,
      kind,
      source_url,
      attachment_path,
      id,
      archived_at,
      archive_purge_at,
      trust_tier,
    };
  }

  /**
   * Opportunistic purge of archived items past their `archive_purge_at`.
   * Called from the archived-list endpoint and from the archive POST
   * so the sweep fires under organic user pressure — no separate
   * scheduler hook required for a 30-day window where the user is
   * the one revisiting the archive shelf. Hard-deletes the wrapper
   * note, any attachment file that lives in this library's
   * `_attachments/` dir, the clippings row, and chunks_fts (defense
   * in depth — they were torn down at archive time, but a manual
   * frontmatter stamp could leave them).
   */
  function sweep_expired_archives(spec: LoadedSpecialist): number {
    const ns = capitalize(spec.id);
    const archive_rel = `Knowledge/${ns}/library/_archive`;
    const archive_abs = resolve(deps.vault_root, archive_rel);
    if (!existsSync(archive_abs)) return 0;
    const now = Date.now();
    let removed = 0;
    for (const name of readdirSync(archive_abs)) {
      if (!name.endsWith('.md')) continue;
      const full = join(archive_abs, name);
      let purge_at: number | null = null;
      let attachment_rel: string | null = null;
      try {
        const parsed = matter(readFileSync(full, 'utf8'));
        const fm = parsed.data as Record<string, unknown>;
        if (typeof fm.archive_purge_at === 'string') {
          const t = Date.parse(fm.archive_purge_at);
          if (!Number.isNaN(t)) purge_at = t;
        }
        if (typeof fm.attachment_path === 'string') attachment_rel = fm.attachment_path;
      } catch {
        // missing purge stamp — leave it alone, manual fix
        continue;
      }
      if (purge_at === null || purge_at > now) continue;
      const wrapper_rel = `${archive_rel}/${name}`;
      try {
        unlinkSync(full);
      } catch (err) {
        console.error('[library sweep] unlink wrapper failed:', err);
        continue;
      }
      if (
        attachment_rel &&
        attachment_rel.startsWith(`Knowledge/${ns}/library/_attachments/`) &&
        !attachment_rel.includes('..')
      ) {
        const att_abs = resolve(deps.vault_root, attachment_rel);
        try {
          if (existsSync(att_abs)) unlinkSync(att_abs);
        } catch (err) {
          console.error('[library sweep] unlink attachment failed:', err);
        }
      }
      try {
        deps.db.prepare(`DELETE FROM clippings WHERE note_path = @p`).run({
          '@p': wrapper_rel,
        });
      } catch {
        // ignore
      }
      try {
        deps.db.prepare(`DELETE FROM chunks_fts WHERE note_path = @p`).run({
          '@p': wrapper_rel,
        });
        deps.memory.delete_chunk_embeddings(wrapper_rel);
      } catch {
        // ignore
      }
      removed += 1;
    }
    if (removed > 0) {
      deps.events?.emit({
        type: 'library_updated',
        specialist_id: spec.id,
        item_count_delta: -removed,
      });
    }
    return removed;
  }

  r.get('/:specialist_id', (c) => {
    const sid = c.req.param('specialist_id');
    const spec = deps.specialists.get(sid);
    if (!spec) return c.json({ error: `unknown specialist: ${sid}` }, 404);
    const limit_param = c.req.query('limit');
    const limit = limit_param
      ? Math.max(1, Math.min(200, parseInt(limit_param, 10) || 50))
      : 50;
    const view = c.req.query('view') === 'archived' ? 'archived' : 'active';
    const ns = capitalize(spec.id);
    const lib_rel =
      view === 'archived'
        ? `Knowledge/${ns}/library/_archive`
        : `Knowledge/${ns}/library`;
    const lib_abs = resolve(deps.vault_root, lib_rel);
    // When loading the archive shelf, opportunistically purge anything
    // past its grace window first so the user's view always matches
    // what the disk will actually retain.
    if (view === 'archived') sweep_expired_archives(spec);
    if (!existsSync(lib_abs)) {
      return c.json({ specialist_id: sid, view, items: [] });
    }
    const entries = readdirSync(lib_abs).filter((f) => f.endsWith('.md'));
    const items = entries
      .map((name) => project_item(lib_abs, lib_rel, name))
      .sort((a, b) => (a.captured_at < b.captured_at ? 1 : -1))
      .slice(0, limit);
    return c.json({ specialist_id: sid, view, items });
  });

  // ── GET single item with full body ── for in-app viewing of text/
  // markdown/URL clippings. Returns the projected list-item shape
  // plus the raw markdown body. Image and PDF kinds also include
  // the body (typically just `![title](attachment_path)` for images
  // or empty for PDFs); the iOS detail surface uses the attachment
  // URL for image/PDF rendering and the body for everything else.
  r.get('/:specialist_id/:filename/body', (c) => {
    const sid = c.req.param('specialist_id');
    const filename = c.req.param('filename');
    const spec = deps.specialists.get(sid);
    if (!spec) return c.json({ error: `unknown specialist: ${sid}` }, 404);
    if (
      !filename ||
      filename.includes('/') ||
      filename.includes('..') ||
      !filename.endsWith('.md')
    ) {
      return c.json({ error: 'invalid filename' }, 400);
    }
    const ns = capitalize(spec.id);
    // Check active first, archive second — the same filename can
    // exist in both only transiently during a race; active wins.
    const active_rel = `Knowledge/${ns}/library`;
    const archive_rel = `Knowledge/${ns}/library/_archive`;
    const active_abs = resolve(deps.vault_root, active_rel, filename);
    const archive_abs = resolve(deps.vault_root, archive_rel, filename);
    let dir_rel: string;
    let dir_abs: string;
    if (existsSync(active_abs)) {
      dir_rel = active_rel;
      dir_abs = resolve(deps.vault_root, active_rel);
    } else if (existsSync(archive_abs)) {
      dir_rel = archive_rel;
      dir_abs = resolve(deps.vault_root, archive_rel);
    } else {
      return c.json({ error: 'not found' }, 404);
    }
    const item = project_item(dir_abs, dir_rel, filename);
    let body = '';
    try {
      const parsed = matter(readFileSync(join(dir_abs, filename), 'utf8'));
      body = parsed.content;
    } catch (err) {
      return c.json({ error: `read failed: ${(err as Error).message}` }, 500);
    }
    return c.json({ ...item, body });
  });

  // Serve an attachment file for in-browser viewing/download. Scope is
  // hard-clamped to `Knowledge/<spec>/library/_attachments/<file>` —
  // filename can't contain slashes, dots-dots, or other traversal
  // tricks. Streams the file with a content-type sniffed from the
  // extension so PDFs render inline rather than forcing a download.
  r.get('/:specialist_id/attachments/:filename', (c) => {
    const sid = c.req.param('specialist_id');
    const filename = c.req.param('filename');
    const spec = deps.specialists.get(sid);
    if (!spec) return c.json({ error: `unknown specialist: ${sid}` }, 404);
    if (
      !filename ||
      filename.includes('/') ||
      filename.includes('..') ||
      filename.startsWith('.')
    ) {
      return c.json({ error: 'invalid filename' }, 400);
    }
    const ns = capitalize(spec.id);
    const att_abs = resolve(
      deps.vault_root,
      `Knowledge/${ns}/library/_attachments`,
      filename,
    );
    // Defense in depth: ensure resolved path is still under the
    // specialist's attachments dir (catches symlink shenanigans).
    const att_dir_abs = resolve(deps.vault_root, `Knowledge/${ns}/library/_attachments`);
    if (!att_abs.startsWith(att_dir_abs + '/')) {
      return c.json({ error: 'path escape' }, 400);
    }
    if (!existsSync(att_abs)) return c.json({ error: 'not found' }, 404);
    const ext = extname(filename).toLowerCase();
    const mime =
      ext === '.pdf' ? 'application/pdf' :
      ext === '.png' ? 'image/png' :
      ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' :
      ext === '.gif' ? 'image/gif' :
      ext === '.webp' ? 'image/webp' :
      ext === '.txt' || ext === '.md' ? 'text/plain; charset=utf-8' :
      ext === '.html' || ext === '.htm' ? 'text/html; charset=utf-8' :
      'application/octet-stream';
    const bytes = readFileSync(att_abs);
    return new Response(bytes, {
      headers: {
        'Content-Type': mime,
        'Content-Length': String(bytes.length),
        'Content-Disposition': `inline; filename="${filename.replace(/"/g, '')}"`,
      },
    });
  });

  // Delete a library entry: removes the wrapper note, any attachment
  // file, the clippings row, and any chunks_fts rows. Path-validated to
  // the specialist's own library directory to prevent traversal.
  // ── POST archive ── soft-delete with a 30-day grace window.
  // Moves the wrapper note into `_archive/`, stamps `archived_at`
  // + `archive_purge_at` on the frontmatter, and tears down the
  // FTS rows so the specialist's `search_library` / `read_note`
  // structurally stop seeing the item. The attachment file stays
  // in `_attachments/` — only the wrapper that references it
  // moves, so a restore is a single inverse rename. Hard-delete
  // happens via the opportunistic sweeper or an explicit DELETE
  // call against the archived filename.
  r.post('/:specialist_id/:filename/archive', (c) => {
    const sid = c.req.param('specialist_id');
    const filename = c.req.param('filename');
    const spec = deps.specialists.get(sid);
    if (!spec) return c.json({ error: `unknown specialist: ${sid}` }, 404);
    if (
      !filename ||
      filename.includes('/') ||
      filename.includes('..') ||
      !filename.endsWith('.md')
    ) {
      return c.json({ error: 'invalid filename' }, 400);
    }
    const ns = capitalize(spec.id);
    const lib_rel = `Knowledge/${ns}/library`;
    const archive_rel = `${lib_rel}/_archive`;
    const wrapper_rel = `${lib_rel}/${filename}`;
    const archived_rel = `${archive_rel}/${filename}`;
    const wrapper_abs = resolve(deps.vault_root, wrapper_rel);
    const archived_abs = resolve(deps.vault_root, archived_rel);
    if (!existsSync(wrapper_abs)) {
      return c.json({ error: 'not found' }, 404);
    }
    // Stamp archive metadata on the frontmatter, then move the
    // file. Writing via fs (not memory.upsert_note) keeps gray-
    // matter's serializer in charge of frontmatter formatting and
    // avoids re-projecting the note in its still-active location.
    const raw = readFileSync(wrapper_abs, 'utf8');
    const parsed = matter(raw);
    const fm = { ...(parsed.data as Record<string, unknown>) };
    const now = new Date();
    const purge = new Date(now.getTime() + ARCHIVE_PURGE_DAYS * 86400 * 1000);
    fm.archived_at = now.toISOString();
    fm.archive_purge_at = purge.toISOString();
    const new_doc = matter.stringify(parsed.content, fm);
    mkdirSync(resolve(deps.vault_root, archive_rel), { recursive: true });
    try {
      writeFileSync(wrapper_abs, new_doc);
      renameSync(wrapper_abs, archived_abs);
    } catch (err) {
      return c.json(
        { error: `archive failed: ${(err as Error).message}` },
        500,
      );
    }
    // Tear down search indexing for the OLD path so the specialist
    // stops surfacing this note. The clippings row is left in place
    // — the ingestor will reproject from the new path on its next
    // tick; until then, specialists holding `read_vault` can still
    // hit the file by archive path if they happen to know it, but
    // their auto-retrieval + FTS rank only sees what's indexed.
    try {
      deps.db.prepare(`DELETE FROM chunks_fts WHERE note_path = @p`).run({
        '@p': wrapper_rel,
      });
      deps.memory.delete_chunk_embeddings(wrapper_rel);
    } catch {
      // ignore
    }
    try {
      deps.db.prepare(`DELETE FROM clippings WHERE note_path = @p`).run({
        '@p': wrapper_rel,
      });
    } catch {
      // ignore
    }
    // Opportunistic sweep — archiving is a natural moment to clean
    // up anything past its purge window from a prior session.
    sweep_expired_archives(spec);
    deps.events?.emit({
      type: 'library_updated',
      specialist_id: sid,
      item_count_delta: -1,
    });
    return c.json({
      ok: true,
      archived: archived_rel,
      archived_at: fm.archived_at,
      archive_purge_at: fm.archive_purge_at,
    });
  });

  // ── POST restore ── inverse of archive. Moves the wrapper back
  // into the active library directory, strips the archive stamps
  // from the frontmatter, and re-indexes the body into chunks_fts
  // so the specialist's search surfaces it again.
  r.post('/:specialist_id/:filename/restore', async (c) => {
    const sid = c.req.param('specialist_id');
    const filename = c.req.param('filename');
    const spec = deps.specialists.get(sid);
    if (!spec) return c.json({ error: `unknown specialist: ${sid}` }, 404);
    if (
      !filename ||
      filename.includes('/') ||
      filename.includes('..') ||
      !filename.endsWith('.md')
    ) {
      return c.json({ error: 'invalid filename' }, 400);
    }
    const ns = capitalize(spec.id);
    const lib_rel = `Knowledge/${ns}/library`;
    const archive_rel = `${lib_rel}/_archive`;
    const wrapper_rel = `${lib_rel}/${filename}`;
    const archived_rel = `${archive_rel}/${filename}`;
    const wrapper_abs = resolve(deps.vault_root, wrapper_rel);
    const archived_abs = resolve(deps.vault_root, archived_rel);
    if (!existsSync(archived_abs)) {
      return c.json({ error: 'not found in archive' }, 404);
    }
    if (existsSync(wrapper_abs)) {
      return c.json(
        { error: 'an active item with the same filename exists' },
        409,
      );
    }
    const raw = readFileSync(archived_abs, 'utf8');
    const parsed = matter(raw);
    const fm = { ...(parsed.data as Record<string, unknown>) };
    delete fm.archived_at;
    delete fm.archive_purge_at;
    const new_doc = matter.stringify(parsed.content, fm);
    try {
      writeFileSync(archived_abs, new_doc);
      renameSync(archived_abs, wrapper_abs);
    } catch (err) {
      return c.json(
        { error: `restore failed: ${(err as Error).message}` },
        500,
      );
    }
    try {
      const chunks = index_chunks(deps.db, wrapper_rel, parsed.content);
      await embed_chunks_best_effort(deps, wrapper_rel, chunks);
      deps.events?.emit({ type: 'search_index_updated' });
    } catch (err) {
      console.error('[library restore] chunk re-indexing failed:', err);
    }
    deps.events?.emit({
      type: 'library_updated',
      specialist_id: sid,
      item_count_delta: 1,
    });
    return c.json({ ok: true, restored: wrapper_rel });
  });

  r.delete('/:specialist_id/:filename', (c) => {
    const sid = c.req.param('specialist_id');
    const filename = c.req.param('filename');
    const spec = deps.specialists.get(sid);
    if (!spec) return c.json({ error: `unknown specialist: ${sid}` }, 404);
    // Reject anything that could traverse out of the library dir.
    if (
      !filename ||
      filename.includes('/') ||
      filename.includes('..') ||
      !filename.endsWith('.md')
    ) {
      return c.json({ error: 'invalid filename' }, 400);
    }
    const ns = capitalize(spec.id);
    const lib_rel = `Knowledge/${ns}/library`;
    const archive_rel = `${lib_rel}/_archive`;
    // Find the wrapper in either the active dir or the archive
    // shelf — DELETE from the archive surface should hard-delete
    // immediately rather than 404.
    const active_abs = resolve(deps.vault_root, lib_rel, filename);
    const archived_abs = resolve(deps.vault_root, archive_rel, filename);
    let wrapper_abs: string;
    let wrapper_rel: string;
    if (existsSync(active_abs)) {
      wrapper_abs = active_abs;
      wrapper_rel = `${lib_rel}/${filename}`;
    } else if (existsSync(archived_abs)) {
      wrapper_abs = archived_abs;
      wrapper_rel = `${archive_rel}/${filename}`;
    } else {
      return c.json({ error: 'not found' }, 404);
    }
    // Read frontmatter to discover the attachment so we can clean it up too.
    let attachment_rel: string | null = null;
    try {
      const parsed = matter(readFileSync(wrapper_abs, 'utf8'));
      const fm = parsed.data as Record<string, unknown>;
      if (typeof fm.attachment_path === 'string') attachment_rel = fm.attachment_path;
    } catch {
      // ignore
    }
    // Unlink wrapper note.
    try {
      unlinkSync(wrapper_abs);
    } catch (err) {
      console.error('[library DELETE] failed to unlink wrapper:', err);
    }
    // Unlink attachment if it sits inside the same library's _attachments dir.
    if (
      attachment_rel &&
      attachment_rel.startsWith(`${lib_rel}/_attachments/`) &&
      !attachment_rel.includes('..')
    ) {
      const att_abs = resolve(deps.vault_root, attachment_rel);
      try {
        if (existsSync(att_abs)) unlinkSync(att_abs);
      } catch (err) {
        console.error('[library DELETE] failed to unlink attachment:', err);
      }
    }
    // Clear DB rows — both the live path and (when present) the
    // active-path twin in case the item was archived and DB rows
    // hadn't reprojected yet.
    for (const path of new Set([
      wrapper_rel,
      `${lib_rel}/${filename}`,
      `${archive_rel}/${filename}`,
    ])) {
      try {
        deps.db.prepare(`DELETE FROM clippings WHERE note_path = @p`).run({
          '@p': path,
        });
      } catch {
        // ignore
      }
      try {
        deps.db.prepare(`DELETE FROM chunks_fts WHERE note_path = @p`).run({
          '@p': path,
        });
        deps.memory.delete_chunk_embeddings(path);
      } catch {
        // ignore
      }
    }
    deps.events?.emit({
      type: 'library_updated',
      specialist_id: sid,
      item_count_delta: -1,
    });
    return c.json({ ok: true, removed: wrapper_rel, attachment_removed: attachment_rel });
  });

  return r;
}
