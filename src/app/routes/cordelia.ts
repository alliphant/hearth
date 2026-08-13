/**
 * Cordelia capture HTTP route.
 *
 *   POST /api/cordelia/capture     multipart: id, kind, capturedAt, note?,
 *                                  localTranscript?, artifact (File)
 *
 * The iOS app posts here whenever Jasper holds-to-record a voice memo,
 * snaps a photo through the FAB, shares text from another app, etc.
 * We persist the artifact + a wrapper note in the vault, audit the
 * action, and return a receipt. Downstream specialist routing (faster-
 * whisper transcription, Brigid/Anya/etc. routing) is intentionally NOT
 * here yet — Cordelia's awareness loop / a future ingestion pipeline
 * picks up the wrapper notes via chokidar and does the real work.
 *
 * This route stops the 404 the iOS client has been hitting since the
 * endpoint was speced in ARCHITECTURE.md § 3.2 but never implemented.
 */

import { Hono } from 'hono';
import { resolve, dirname } from 'node:path';
import { writeFileSync, mkdirSync, existsSync, readFileSync, statSync } from 'node:fs';
import { ulid } from 'ulid';
import type { Database } from 'bun:sqlite';
import type { MemoryClient } from '@memory/client';
import { stamp_private_to_if_needed, note_visible_to_caller } from '@memory/private_to';
import type { AppEventBus } from '@app/events';
import type { ReactiveInboxDriver } from '@core/reactive_inbox';

export interface CordeliaRouterDeps {
  memory: MemoryClient;
  vault_root: string;
  /** Direct SQLite handle for read endpoints that don't go through
   *  MemoryClient (the clippings projection lives here, not the vault
   *  upsert path). */
  db: Database;
  /** Optional event bus — emits `capture_received` after persistence so
   *  the reactive driver classifies + routes. Absent in tests that
   *  don't wire the bus. */
  events?: AppEventBus;
  /** Optional reactive driver — when present, the capture route awaits
   *  the routing decision (short timeout) so the 202 response can
   *  carry `routedTo` populated. */
  reactive?: ReactiveInboxDriver;
}

// Upper bound — keeps a runaway upload from filling the vault disk.
// Voice memos clip ~1 MB/minute (m4a 64kbps mono), photos ~5 MB; 25 MB
// covers a 20-minute voice memo or a 4k HEIC photo with headroom.
const MAX_BYTES = 25 * 1024 * 1024;

// Map iOS CaptureKind values to ClippingFrontmatter.kind values. iOS
// sends `voiceMemo` / `photo` / `sharedText` / `sharedFile`; the
// clipping schema accepts `image` / `text` / `other`. We collapse to
// the closest semantic.
function clipping_kind_for(cordelia_kind: string): 'image' | 'text' | 'other' {
  switch (cordelia_kind) {
    case 'photo':
      return 'image';
    case 'sharedText':
      return 'text';
    case 'voiceMemo':
    case 'sharedFile':
    default:
      return 'other';
  }
}

function extension_for_mime(mime: string, fallback_name: string | undefined): string {
  // Trust the iOS-supplied filename's extension first; fall back to
  // the mime type. Both can lie; the receiving file system doesn't
  // care because we read by frontmatter `attachment_path`.
  const from_name = fallback_name?.match(/\.([a-z0-9]{1,6})$/i)?.[1];
  if (from_name) return from_name.toLowerCase();
  if (mime.startsWith('audio/m4a') || mime.includes('mp4a')) return 'm4a';
  if (mime === 'audio/wav') return 'wav';
  if (mime === 'image/jpeg') return 'jpg';
  if (mime === 'image/png') return 'png';
  if (mime === 'image/heic') return 'heic';
  if (mime === 'text/plain') return 'txt';
  return 'bin';
}

function safe_basename(s: string): string {
  return s.replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 80) || 'capture';
}

/**
 * Summarize the iOS-supplied EXIF block for the audit_log row — boolean
 * presence flags + the redacted make/model (provenance, no privacy
 * concern), nothing else. Raw GPS coordinates and timestamps remain in
 * the wrapper note's frontmatter where the existing `private_to`
 * tier-gate protects them; the audit_log is the read most likely to
 * leak across users (Mariah's scans, query_audit_log tool, etc.) so it
 * gets the curated subset.
 *
 * This mirrors the maps connector's `redact_for_audit` pattern in
 * `src/connectors/maps.ts` — boundary-level redaction, raw values stay
 * where they're needed.
 */
function exif_summary(ios_metadata: Record<string, unknown>): {
  hasGps: boolean;
  hasTimestamp: boolean;
  makeModel: string | null;
} {
  const exif = ios_metadata.exif;
  if (!exif || typeof exif !== 'object') {
    return { hasGps: false, hasTimestamp: false, makeModel: null };
  }
  const e = exif as Record<string, unknown>;
  const hasGps =
    typeof e.gps_latitude === 'number' && typeof e.gps_longitude === 'number';
  const hasTimestamp =
    typeof e.date_time_original === 'string' || typeof e.gps_timestamp === 'string';
  const make = typeof e.make === 'string' ? e.make : '';
  const model = typeof e.model === 'string' ? e.model : '';
  const makeModel =
    make.length > 0 || model.length > 0 ? `${make} ${model}`.trim() : null;
  return { hasGps, hasTimestamp, makeModel };
}

export function create_cordelia_router(deps: CordeliaRouterDeps): Hono {
  const r = new Hono();

  r.post('/capture', async (c) => {
    const user = c.get('user');
    if (!user) return c.json({ error: 'authentication required' }, 401);

    let body: Record<string, unknown>;
    try {
      body = await c.req.parseBody();
    } catch (err) {
      return c.json({ error: `multipart parse failed: ${(err as Error).message}` }, 400);
    }

    const artifact = body.artifact;
    if (!(artifact instanceof File)) {
      return c.json({ error: 'missing required field "artifact" (File)' }, 400);
    }
    if (artifact.size > MAX_BYTES) {
      return c.json(
        { error: `artifact too large: ${artifact.size} bytes (max ${MAX_BYTES})` },
        413,
      );
    }

    const client_id = typeof body.id === 'string' ? body.id : null;
    const cordelia_kind = typeof body.kind === 'string' ? body.kind : 'sharedFile';
    const captured_at_in = typeof body.capturedAt === 'string' ? body.capturedAt : null;
    const note = typeof body.note === 'string' && body.note.length > 0 ? body.note : undefined;
    const local_transcript =
      typeof body.localTranscript === 'string' && body.localTranscript.length > 0
        ? body.localTranscript
        : undefined;

    // Optional iOS enrichment — single `metadata` multipart field
    // carrying JSON ({on_device_ocr_text, local_classification_hint,
    // vision_completed_ms, image_dimensions}). Merged into
    // extracted_metadata below so the classifier's doc-track sees
    // `on_device_ocr_text` directly. Older iOS builds without this
    // field continue to work; absence means "iOS doesn't have the
    // signals yet."
    let ios_metadata: Record<string, unknown> = {};
    const raw_metadata = body.metadata;
    if (typeof raw_metadata === 'string' && raw_metadata.length > 0) {
      try {
        const parsed = JSON.parse(raw_metadata) as unknown;
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          ios_metadata = parsed as Record<string, unknown>;
        }
      } catch {
        // Malformed metadata blob is non-fatal — the capture still
        // persists and routes via doc-text-empty fallback. The audit
        // row carries the raw string for after-the-fact debugging.
      }
    }

    const now = new Date();
    const captured_at = captured_at_in ?? now.toISOString();
    const internal_id = `c_${ulid().toLowerCase().slice(-10)}`;

    // 1. Attachment to vault/_attachments/cordelia-<id>.<ext>
    const ext = extension_for_mime(artifact.type, artifact.name);
    const attachment_rel = `_attachments/cordelia-${internal_id}.${ext}`;
    try {
      const bytes = new Uint8Array(await artifact.arrayBuffer());
      const attachment_abs = resolve(deps.vault_root, attachment_rel);
      mkdirSync(dirname(attachment_abs), { recursive: true });
      writeFileSync(attachment_abs, bytes);
    } catch (err) {
      return c.json(
        { error: `attachment write failed: ${(err as Error).message}` },
        500,
      );
    }

    // 2. Wrapper note in Cordelia/Inbox/<date>-<kind>-<id>.md. Body is
    //    whatever text we have (local_transcript or user-typed note);
    //    image kind embeds the attachment.
    const date_str = captured_at.slice(0, 10);
    const wrapper_rel = `Cordelia/Inbox/${date_str}-${cordelia_kind}-${safe_basename(internal_id)}.md`;

    const title =
      note?.slice(0, 80) ??
      local_transcript?.slice(0, 80) ??
      `Cordelia ${cordelia_kind} ${date_str}`;

    let body_md = '';
    if (clipping_kind_for(cordelia_kind) === 'image') {
      body_md = `![${title}](${attachment_rel})\n`;
    }
    if (local_transcript) {
      body_md += `\n## Local transcript\n\n${local_transcript}\n`;
    }
    if (note) {
      body_md += `\n## User note\n\n${note}\n`;
    }
    if (body_md.length === 0) {
      body_md = `_Cordelia capture — artifact at \`${attachment_rel}\`._\n`;
    }

    const fm: Record<string, unknown> = {
      type: 'clipping',
      id: internal_id,
      kind: clipping_kind_for(cordelia_kind),
      source: 'file',
      title,
      captured_at,
      reviewed: false,
      tags: ['cordelia', cordelia_kind],
      extracted_metadata: {
        cordelia_kind,
        cordelia_client_id: client_id,
        mime_type: artifact.type,
        size_bytes: artifact.size,
        ...(local_transcript ? { local_transcript_excerpt: local_transcript.slice(0, 280) } : {}),
        // The user-typed caption (`note` from the multipart) is the
        // highest-signal indicator of WHY the user captured this —
        // far better than OCR text or VL description for "what is
        // this?" / "how many calories?" / "is this safe for pets?"
        // intent. classify.ts reads extracted_metadata.user_note
        // directly; without this stamp the note lands only in `title`
        // and `body_md`, neither of which the classifier sees. The
        // Dunkin' cup misroute on 2026-05-27 (c_7c4msww1vy) was
        // partly this gap — user asked about calories, classifier
        // never saw the question.
        ...(note ? { user_note: note } : {}),
        // iOS-supplied enrichment overlay. The classifier reads
        // `on_device_ocr_text` + `local_classification_hint` directly
        // from this block. Spread LAST so a client overriding a
        // server-derived key is a deliberate choice, not a silent one.
        ...ios_metadata,
      },
      attachment_path: attachment_rel,
      specialist_scope: 'cordelia',
    };

    const stamped = stamp_private_to_if_needed(fm, {
      user_id: user.id,
      tier: user.tier,
    });

    deps.memory.upsert_note(wrapper_rel, stamped, body_md);

    const intent_id = `cordelia_capture:${ulid()}`;
    deps.memory.log_action({
      intent_id,
      agent: 'orchestrator',
      tool_name: 'cordelia_capture',
      tool_input: {
        cordelia_kind,
        client_id,
        captured_at,
        mime_type: artifact.type,
        size_bytes: artifact.size,
        has_local_transcript: Boolean(local_transcript),
        has_note: Boolean(note),
        // Telemetry only — knowing which captures benefited from
        // iOS-side Vision lets us measure doc-track hit rate later.
        ios_ocr_chars:
          typeof ios_metadata.on_device_ocr_text === 'string'
            ? (ios_metadata.on_device_ocr_text as string).length
            : 0,
        ios_hint:
          typeof ios_metadata.local_classification_hint === 'string'
            ? ios_metadata.local_classification_hint
            : null,
        ios_vision_ms:
          typeof ios_metadata.vision_completed_ms === 'number'
            ? ios_metadata.vision_completed_ms
            : null,
        // EXIF presence — telemetry only. Raw GPS coordinates,
        // make/model, and timestamps stay in the wrapper note's
        // frontmatter (tier-gated like the rest of Cordelia/Inbox/);
        // the audit_log carries booleans + presence-only summary so
        // a query_audit_log scan can measure EXIF coverage across
        // captures without leaking the values themselves. This
        // mirrors the maps-connector pattern from
        // src/connectors/maps.ts: redact-before-audit at the boundary,
        // raw values stay where they're needed.
        exif_has_gps: exif_summary(ios_metadata).hasGps,
        exif_has_timestamp: exif_summary(ios_metadata).hasTimestamp,
        exif_make_model: exif_summary(ios_metadata).makeModel,
      },
      execution_result: {
        id: internal_id,
        wrapper_note_path: wrapper_rel,
        attachment_path: attachment_rel,
      },
      user_id: user.id,
    });

    // Kick the reactive driver: emit `capture_received`, optionally
    // await the routing decision so the receipt can carry routedTo
    // populated. The reactive driver's single-photo bypass classifies
    // immediately; for cluster cases the wait times out at ~800ms and
    // iOS gets `routedTo: null`, then refetches via /api/cordelia/recent
    // once the cluster window closes.
    const kind_normalized = (() => {
      if (
        cordelia_kind === 'voiceMemo' ||
        cordelia_kind === 'photo' ||
        cordelia_kind === 'sharedText' ||
        cordelia_kind === 'sharedFile'
      ) {
        return cordelia_kind;
      }
      return 'sharedFile';
    })();
    deps.events?.emit({
      type: 'capture_received',
      capture_id: internal_id,
      user_id: user.id,
      kind: kind_normalized,
      note_path: wrapper_rel,
      attachment_path: attachment_rel,
      captured_at,
    });

    let routedTo: string[] | null = null;
    if (deps.reactive) {
      const decisions = await deps.reactive.await_route(internal_id);
      if (decisions.length > 0) {
        const ids = new Set<string>();
        for (const d of decisions) if (!d.below_threshold) ids.add(d.specialist_id);
        routedTo = Array.from(ids);
      }
    }

    // Receipt shape matches iOS CordeliaCaptureReceipt: { id, acceptedAt, routedTo? }.
    // routedTo is populated when the reactive driver classified within the await window;
    // otherwise null and iOS refetches via /api/cordelia/recent.
    return c.json(
      {
        id: internal_id,
        acceptedAt: now.toISOString(),
        routedTo,
      },
      202,
    );
  });

  // ── GET /recent ── list this caller's recent Cordelia captures ──────
  // Powers the iOS Library tab's "Recent" feed. Returns clippings whose
  // wrapper notes live under `Cordelia/Inbox/` (kept narrow on purpose
  // — the broader knowledge tree gets its own endpoint later). Each row
  // is filtered through `note_visible_to_caller` so a non-owner can't
  // see the owner's captures, matching the rest of the discretion
  // stack (see Phase 2b).
  r.get('/recent', async (c) => {
    const user = c.get('user');
    if (!user) return c.json({ error: 'authentication required' }, 401);
    const limit = Math.min(
      Math.max(1, Number(c.req.query('limit') ?? '50')),
      200,
    );
    type Row = {
      id: string;
      kind: string;
      title: string;
      attachment_path: string | null;
      captured_at: string;
      note_path: string;
      reviewed: number;
      frontmatter_json: string;
    };
    // Cordelia captures live exclusively under `Cordelia/Inbox/`; the
    // `note_path LIKE` filter scopes us to that namespace cheaply. The
    // index on (note_path) is implicit via the UNIQUE constraint.
    const rows = deps.db
      .prepare(
        `SELECT id, kind, title, attachment_path, captured_at, note_path,
                reviewed, frontmatter_json
         FROM clippings
         WHERE note_path LIKE 'Cordelia/Inbox/%'
         ORDER BY captured_at DESC
         LIMIT @limit`,
      )
      .all({ '@limit': limit }) as Row[];

    const captures = rows
      .map((row) => {
        let fm: Record<string, unknown> = {};
        try {
          fm = JSON.parse(row.frontmatter_json) as Record<string, unknown>;
        } catch {
          fm = {};
        }
        // Honor `private_to` — same filter the proposal / brief routes
        // apply. Owner-tier callers see owner-stamped rows; non-owner
        // tier callers only see rows stamped to their own user id.
        const private_to = fm.private_to;
        if (
          !note_visible_to_caller(
            typeof private_to === 'string' ? private_to : undefined,
            { user_id: user.id, tier: user.tier },
          )
        ) {
          return null;
        }
        // Derive routed-to specialists from the frontmatter if Cordelia's
        // ingestion pipeline has run (today still pending — falls back
        // to an empty array). iOS chips off of this directly.
        const routed_raw = fm.routed_to;
        const routedTo = Array.isArray(routed_raw)
          ? routed_raw.filter((v): v is string => typeof v === 'string')
          : [];
        // Local-transcript excerpt is what iOS streams on the speech
        // path. Backend stores the canonical-via-faster-whisper one in
        // a different field when re-transcription lands; until then we
        // ship the excerpt that arrived with the capture.
        const meta = fm.extracted_metadata as Record<string, unknown> | undefined;
        const transcript_excerpt =
          typeof meta?.local_transcript_excerpt === 'string'
            ? (meta.local_transcript_excerpt as string)
            : null;
        return {
          id: row.id,
          kind: row.kind, // 'image' | 'text' | 'other' (voice memos)
          title: row.title,
          captured_at: row.captured_at,
          attachment_path: row.attachment_path,
          note_path: row.note_path,
          reviewed: row.reviewed === 1,
          routed_to: routedTo,
          transcript_excerpt,
        };
      })
      .filter((row): row is NonNullable<typeof row> => row !== null);

    // Optional inline timeline — adds an audit-log derived per-capture
    // action list. iOS Library tab requests `?include_timeline=1` for
    // the detail view; the index list omits it to keep the payload small.
    const include_timeline = c.req.query('include_timeline') === '1';
    if (include_timeline) {
      type TimelineRow = {
        ts: string;
        agent: string;
        tool_name: string;
        execution_result: string | null;
      };
      const augmented = captures.map((capture) => {
        const audit_rows = deps.db
          .prepare(
            `SELECT ts, agent, tool_name, execution_result
             FROM audit_log
             WHERE tool_input LIKE @needle
                OR execution_result LIKE @needle
             ORDER BY ts ASC LIMIT 50`,
          )
          .all({ '@needle': `%${capture.id}%` }) as TimelineRow[];
        const timeline = audit_rows.map((row) => {
          let result_summary: string | null = null;
          if (row.execution_result) {
            try {
              const parsed = JSON.parse(row.execution_result) as Record<string, unknown>;
              const candidates = ['intake_summary', 'record_path', 'route_reason', 'summary'];
              for (const key of candidates) {
                if (typeof parsed[key] === 'string') {
                  result_summary = parsed[key] as string;
                  break;
                }
              }
            } catch {
              /* ignore */
            }
          }
          return {
            ts: row.ts,
            agent: row.agent,
            tool_name: row.tool_name,
            summary: result_summary,
          };
        });
        return { ...capture, timeline };
      });
      return c.json({ captures: augmented });
    }

    return c.json({ captures });
  });

  // ── POST /reclassify/:id ── re-emit capture_received for an existing capture ──
  //
  // Replay surface for captures whose wrapper note exists in the vault
  // but never made it through the reactive driver — usually because the
  // capture landed BEFORE an orchestrator restart that introduced or
  // recovered the driver. Looks up the clipping row, validates the
  // caller's `private_to` access, re-emits `capture_received` exactly
  // as the POST /capture path would, and awaits the routing decision
  // so the response can carry the new `routedTo`.
  //
  // Idempotent on the reactive driver's side — its `already_processed`
  // set is per-id, so re-firing for a capture that DID route would be a
  // no-op (the LLM call wouldn't repeat); but in practice this endpoint
  // is only invoked for captures whose frontmatter shows
  // `routing_status` absent or `triage`.
  r.post('/reclassify/:id', async (c) => {
    const user = c.get('user');
    if (!user) return c.json({ error: 'authentication required' }, 401);
    const id = c.req.param('id');
    if (!id || !/^c_[a-z0-9]{1,30}$/.test(id)) {
      return c.json({ error: 'invalid capture id' }, 400);
    }
    type Row = {
      attachment_path: string | null;
      note_path: string;
      captured_at: string;
      frontmatter_json: string;
    };
    const row = deps.db
      .prepare(
        `SELECT attachment_path, note_path, captured_at, frontmatter_json
         FROM clippings WHERE id = @id AND note_path LIKE 'Cordelia/Inbox/%'`,
      )
      .get({ '@id': id }) as Row | undefined;
    if (!row) return c.json({ error: 'not found' }, 404);

    let fm: Record<string, unknown> = {};
    try {
      fm = JSON.parse(row.frontmatter_json) as Record<string, unknown>;
    } catch {
      fm = {};
    }
    if (
      !note_visible_to_caller(
        typeof fm.private_to === 'string' ? (fm.private_to as string) : undefined,
        { user_id: user.id, tier: user.tier },
      )
    ) {
      return c.json({ error: 'not found' }, 404);
    }
    const meta = (fm.extracted_metadata ?? {}) as Record<string, unknown>;
    const raw_kind =
      typeof meta.cordelia_kind === 'string' ? (meta.cordelia_kind as string) : 'sharedFile';
    const kind: 'voiceMemo' | 'photo' | 'sharedText' | 'sharedFile' =
      raw_kind === 'voiceMemo' || raw_kind === 'photo' || raw_kind === 'sharedText'
        ? raw_kind
        : 'sharedFile';

    deps.memory.log_action({
      intent_id: `cordelia_reclassify:${ulid()}`,
      agent: 'orchestrator',
      tool_name: 'cordelia_reclassify',
      tool_input: { capture_id: id },
      execution_result: { note_path: row.note_path, kind },
      user_id: user.id,
    });

    deps.events?.emit({
      type: 'capture_received',
      capture_id: id,
      user_id: user.id,
      kind,
      note_path: row.note_path,
      attachment_path: row.attachment_path,
      captured_at: row.captured_at,
    });

    let routedTo: string[] | null = null;
    if (deps.reactive) {
      const decisions = await deps.reactive.await_route(id);
      if (decisions.length > 0) {
        const ids = new Set<string>();
        for (const d of decisions) if (!d.below_threshold) ids.add(d.specialist_id);
        routedTo = Array.from(ids);
      }
    }
    return c.json({ id, kind, routedTo }, 202);
  });

  // ── GET /thumbnail/:id ── small image for the iOS Library tab grid ──
  // v1: serves the original attachment with a generous cache header. iOS
  // already downsamples client-side via NSCache + UIImage, so most of the
  // savings on iPhone come from the OS-level cache. A future pass adds a
  // server-side 256px sharp/native resize keyed by mtime; see PLAN.md
  // "Cordelia thumbnail server-side resize". Access is gated by the same
  // private_to visibility filter the /recent endpoint enforces.
  r.get('/thumbnail/:id', async (c) => {
    const user = c.get('user');
    if (!user) return c.json({ error: 'authentication required' }, 401);
    const id = c.req.param('id');
    if (!id || !/^c_[a-z0-9]{1,30}$/.test(id)) {
      return c.json({ error: 'invalid capture id' }, 400);
    }
    const row = deps.db
      .prepare(
        `SELECT attachment_path, frontmatter_json
         FROM clippings WHERE id = @id AND note_path LIKE 'Cordelia/Inbox/%'`,
      )
      .get({ '@id': id }) as { attachment_path: string | null; frontmatter_json: string } | undefined;
    if (!row) return c.json({ error: 'not found' }, 404);
    // Private_to visibility — same as /recent.
    let fm: Record<string, unknown> = {};
    try {
      fm = JSON.parse(row.frontmatter_json) as Record<string, unknown>;
    } catch {
      fm = {};
    }
    if (
      !note_visible_to_caller(
        typeof fm.private_to === 'string' ? (fm.private_to as string) : undefined,
        { user_id: user.id, tier: user.tier },
      )
    ) {
      return c.json({ error: 'not found' }, 404);
    }
    if (!row.attachment_path) return c.json({ error: 'no attachment for capture' }, 404);
    const abs = resolve(deps.vault_root, row.attachment_path);
    if (!existsSync(abs)) return c.json({ error: 'attachment missing on disk' }, 404);
    let bytes: ArrayBuffer;
    let mtime: Date;
    try {
      const src = readFileSync(abs);
      // Copy through a fresh ArrayBuffer so the Response constructor
      // gets a BodyInit-shaped buffer under TS strict mode.
      bytes = new ArrayBuffer(src.length);
      new Uint8Array(bytes).set(src);
      mtime = statSync(abs).mtime;
    } catch (err) {
      return c.json(
        { error: `read failed: ${(err as Error).message}` },
        500,
      );
    }
    const ext = abs.slice(abs.lastIndexOf('.') + 1).toLowerCase();
    const mime =
      ext === 'png' ? 'image/png'
      : ext === 'heic' || ext === 'heif' ? 'image/heic'
      : ext === 'webp' ? 'image/webp'
      : ext === 'gif' ? 'image/gif'
      : 'image/jpeg';
    return new Response(bytes, {
      headers: {
        'content-type': mime,
        // Captures are immutable once stored. iOS gets a fresh URL
        // every time the row mtime changes; cache aggressively here.
        'cache-control': 'private, max-age=86400',
        'last-modified': mtime.toUTCString(),
        // Tag with a stable etag — capture id + mtime second-precision.
        etag: `"${id}-${Math.floor(mtime.getTime() / 1000)}"`,
      },
    });
  });

  return r;
}
