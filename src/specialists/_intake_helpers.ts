/**
 * Shared helpers across the per-specialist intake handlers.
 *
 * Each handler under `src/specialists/<id>/intake/` is a thin
 * destination that turns a `CordeliaRoutingDecision` into the
 * specialist's idiom (a vault write, a proposal, an inbox memo,
 * etc.). The bits they all need — patching frontmatter, slugifying
 * a title, writing the structured record into the right shelf —
 * live here so each handler stays focused on its domain logic.
 *
 * Underscored so the tool loader's `is_tool_file` skips it (its
 * basename starts with `_`).
 */

import { ulid } from 'ulid';
import type { MemoryClient } from '@memory/client';
import { patch_clipping_frontmatter } from './cordelia/intake/_capture_io';
import type { IntakeHandlerInput } from '@core/reactive_inbox';
import type { LoadedSpecialist } from '@core/specialist';
import { save_library_item, type LibraryRoutesDeps } from '@app/routes/library';

export function slug(s: string, max = 60): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max) || 'item';
}

export function date_part(iso: string): string {
  return iso.slice(0, 10);
}

/**
 * Stamp the wrapper note frontmatter with the intake's outcome —
 * what was extracted, which downstream record was created, whether
 * a proposal was drafted. The iOS Library tab's per-capture timeline
 * reads these fields.
 */
export function mark_intake_done(
  memory: MemoryClient,
  note_path: string,
  patch: {
    handler: string;
    outcome: 'filed' | 'proposed' | 'noted' | 'deferred';
    artifact_path?: string;
    proposal_id?: string;
    summary?: string;
  },
): void {
  patch_clipping_frontmatter(memory, note_path, {
    intake_handler: patch.handler,
    intake_outcome: patch.outcome,
    intake_artifact_path: patch.artifact_path ?? null,
    intake_proposal_id: patch.proposal_id ?? null,
    intake_summary: patch.summary ?? null,
    intake_completed_at: new Date().toISOString(),
  });
}

/**
 * Audit row helper — every intake handler logs one of these so the
 * Library timeline (audit-driven) has a consistent row to render.
 */
export function audit_intake(
  input: IntakeHandlerInput,
  result: Record<string, unknown>,
): void {
  input.memory.log_action({
    intent_id: `cordelia_intake:${ulid()}`,
    agent: input.decision.specialist_id,
    tool_name: 'cordelia_intake',
    tool_input: {
      capture_id: input.capture_id,
      handler: result.handler ?? input.decision.specialist_id,
      route_reason: input.decision.route_reason,
    },
    execution_result: result,
    user_id: input.user_id,
  });
}

const IMAGE_EXTS = new Set(['jpg', 'jpeg', 'png', 'heic', 'heif', 'webp', 'gif']);

/** Short noun-phrase label for the shelf note title — prefer the user's
 *  caption, then the first clause of the VL description, else a dated
 *  fallback. */
function capture_label(
  user_note: string | undefined,
  vl_description: string | undefined,
  fallback: string,
): string {
  const note = (user_note ?? '').trim();
  if (note) return (note.split(/[.\n]/)[0] ?? note).trim().slice(0, 80);
  const vl = (vl_description ?? '').trim();
  if (vl) {
    const first = (vl.split(/[.\n]/)[0] ?? '').trim();
    if (first.length >= 3) return first.slice(0, 80);
  }
  return fallback;
}

/**
 * File a routed capture onto the target specialist's library shelf
 * (`Knowledge/<TargetCap>/library/`) so it becomes searchable for them —
 * and, via Cordelia's cross-specialist `Knowledge/<id>/library` scope, for
 * Cordelia too.
 *
 * This is the step that turns "Cordelia routed N capture(s) to you" from a
 * dangling inbox flag into a note the specialist can actually retrieve. A
 * capture's searchable signal lives in its FRONTMATTER (VL description, OCR,
 * the user's caption) — its body is just an image embed — and the wrapper
 * note in `Cordelia/Inbox/` is never chunked. So we compose a markdown note
 * from those signals and run it through the same `save_library_item`
 * pipeline (chunks_fts + embeddings + clippings row) that human library
 * uploads use. `quality_gate: 'off'` because a deliberate capture is never a
 * low-quality web shell to second-guess (a one-line-VL dog photo would
 * otherwise be rejected as "thin" — the exact hole this closes).
 *
 * Idempotent at the call site: the reactive driver invokes this only for a
 * newly-inserted (capture, specialist) route, mirroring the
 * `INSERT OR IGNORE INTO capture_routes` cordon. Returns the filed note's
 * path, or null when the pipeline declined to write.
 */
export async function file_capture_to_library(args: {
  library_deps: LibraryRoutesDeps;
  target: LoadedSpecialist;
  capture_id: string;
  user_id: string;
  source_note_path: string;
  attachment_path: string | null;
  vl_description?: string;
  ocr_text?: string;
  user_note?: string;
  route_reason: string;
  tz?: string;
}): Promise<string | null> {
  const vl = (args.vl_description ?? '').trim();
  const ocr = (args.ocr_text ?? '').trim();
  const note = (args.user_note ?? '').trim();
  const label = capture_label(
    args.user_note,
    args.vl_description,
    `Capture ${date_part(new Date().toISOString())}`,
  );

  const lines: string[] = [`# ${label}`, ''];
  // Embed the original image by Obsidian basename wikilink so it resolves
  // regardless of folder (the attachment lives under _attachments/).
  // Image-only — voice/file captures carry their text via OCR/transcript.
  if (args.attachment_path) {
    const base = args.attachment_path.split('/').pop() ?? '';
    const ext = base.slice(base.lastIndexOf('.') + 1).toLowerCase();
    if (base && IMAGE_EXTS.has(ext)) lines.push(`![[${base}]]`, '');
  }
  if (note) lines.push(`**Capture note:** ${note}`, '');
  if (vl) lines.push('## What the capture shows', '', vl, '');
  if (ocr) {
    lines.push('## Text in the capture (OCR / transcript)', '', '```', ocr, '```', '');
  }
  lines.push(
    '## Source',
    `Routed by Cordelia — ${args.route_reason}`,
    `Original capture: [[${args.source_note_path}|inbox copy]]`,
  );

  const saved = await save_library_item(
    args.library_deps,
    { filename: `${slug(label)}.md`, mime_type: 'text/markdown', text: lines.join('\n') },
    args.target,
    {
      source: 'file',
      tz: args.tz,
      // Per-user cordon — the capture belongs to whoever captured it.
      private_to: args.user_id,
      // Deliberate captures are never web shells; skip the judge that
      // would reject a thin (one-line-VL) capture.
      quality_gate: 'off',
    },
  );

  return 'rejected' in saved ? null : saved.wrapper_note_path;
}
