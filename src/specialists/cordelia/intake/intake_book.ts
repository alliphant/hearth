/**
 * Cordelia — book cover intake.
 *
 * Two-stage flow:
 *
 *   1. **At intake (this handler):** file a candidate-acquisition note
 *      onto Knowledge/Cordelia/queue/ with `status: awaiting_decision`,
 *      then file a `book_candidate` proposal with three dynamic
 *      actions (Acquire / File only / Skip). The proposal appears in
 *      the standard proposals queue; iOS / web render the three
 *      buttons via the dynamic-actions surface.
 *
 *   2. **When Jasper picks an action (decide route's book_candidate
 *      resolver):** the resolver mutates the queue note's `status`
 *      field directly — pure backend write, no LLM turn, no chat
 *      surface, no fabrication risk.
 *
 *      - `acquire`            → `status: queued` (04:00 pass acts)
 *      - `file_only`          → `status: filed_for_reference`
 *      - `skip`               → `status: skipped`
 *
 * The point is to keep the human in the loop BEFORE Cordelia spends
 * effort hunting for / paying for a copy — most book photos are
 * physical purchases or gifts where there's no acquisition intent.
 */

import type { IntakeHandler, IntakeHandlerInput } from '@core/reactive_inbox';
import { audit_intake, date_part, mark_intake_done, slug } from '../../_intake_helpers';
import { ProposalsStore } from '@core/proposals';

function pick_title_author(ocr_text: string, vl_desc: string): { title: string | null; author: string | null } {
  // Books typically render Title (largest) then Author. Reuse the same
  // "biggest line of mostly letters" heuristic the band poster handler
  // uses, then look for the next plausible line as the author.
  const lines = ocr_text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
  let title: string | null = null;
  let author: string | null = null;
  for (const l of lines) {
    if (l.length < 3 || l.length > 80) continue;
    if (/^isbn/i.test(l)) continue;
    if (/^\d/.test(l)) continue;
    if (!title) {
      title = l;
      continue;
    }
    if (!author) {
      author = l;
      break;
    }
  }
  // VL fallback when OCR is sparse.
  if (!title && vl_desc) {
    const sentences = vl_desc.split(/[.!?]\s+/);
    for (const s of sentences) {
      const m = s.match(/(?:titled|called)\s+["“]?([^"”.]+)["”]?/i);
      if (m && m[1]) {
        title = m[1].trim();
        break;
      }
    }
  }
  return { title, author };
}

export const intake_book: IntakeHandler = async (input: IntakeHandlerInput) => {
  const payload = input.decision.extracted_payload;
  const ocr_text = payload.ocr_text ?? '';
  const vl_desc = payload.vl_description ?? '';

  const { title, author } = pick_title_author(ocr_text, vl_desc);
  const date = date_part(new Date().toISOString());
  const seed = title ?? 'book-cover';
  const rel = `Knowledge/Cordelia/queue/${date}-${slug(seed)}.md`;

  const fm: Record<string, unknown> = {
    type: 'book_candidate',
    source_capture_id: input.capture_id,
    source_capture_note: input.note_path,
    title_candidate: title,
    author_candidate: author,
    // `awaiting_decision` until Jasper answers the present_questions
    // form we surface below. Only `queued` rows are picked up by her
    // 04:00 acquisition pass — the others (`filed_for_reference` /
    // `skipped`) stay in the folder as a record without consuming any
    // hunt-for-copy effort.
    status: 'awaiting_decision',
    captured_on: date,
    private_to: input.user_id,
  };

  const body = [
    `# Book candidate — ${title ?? 'untitled'}`,
    '',
    title ? `**Title**: ${title}` : '',
    author ? `**Author**: ${author}` : '',
    `**Route reason**: ${input.decision.route_reason}`,
    '',
    'Next: waiting on Jasper to confirm whether to chase an open-access copy, just file the note, or skip entirely. See the form attached to this capture in chat.',
    vl_desc ? `\n## VL description\n\n${vl_desc}` : '',
    ocr_text ? `\n## OCR text\n\n\`\`\`\n${ocr_text}\n\`\`\`` : '',
    '',
    '## Source',
    `Capture: [[${input.note_path}|original]]`,
  ].filter((l) => l !== '').join('\n');
  input.memory.upsert_note(rel, fm, body);

  // ── Surface the decision to Jasper via a book_candidate proposal ───
  // The dynamic-actions proposal surface renders the three options
  // (Acquire / File only / Skip) as buttons. When Jasper picks one,
  // the decide route's book_candidate resolver mutates the queue
  // note's status directly — no LLM turn, no fabrication path.
  const proposals = new ProposalsStore(input.db);
  const proposal_id = proposals.create({
    specialist_id: 'cordelia',
    kind: 'book_candidate',
    // Cordon the book candidate to the user whose capture produced it.
    user_id: input.user_id ?? null,
    // `execution_kind: 'composite'` — the kind's resolver produces
    // the side effect (queue-note mutation) rather than firing a
    // dispatch_tool. Marks the proposal as having a side effect at
    // decide-time without needing a tool registry hop.
    execution_kind: 'composite',
    payload: {
      queue_note_path: rel,
      title_candidate: title,
      author_candidate: author,
      source_capture_id: input.capture_id,
      source_capture_note: input.note_path,
    },
    rationale: title
      ? `Cordelia spotted *${title}* in a capture${author ? ` (${author})` : ''}. ` +
        `Three legitimate outcomes: hunt for a copy at 04:00, just file the note, or skip.`
      : 'Cordelia spotted a book cover in a capture. Pick how to handle it.',
    // Signature: each book_candidate is its own subject (no
    // accumulation across different books toward autonomy tier).
    // Anchor on the queue path so re-files of the same book
    // collapse via the existing supersession mechanism.
    signature: {
      specialist_id: 'cordelia',
      kind: 'book_candidate',
      category: 'library_acquisition',
      anchor: rel,
    },
  });

  mark_intake_done(input.memory, input.note_path, {
    handler: 'cordelia.intake_book',
    outcome: 'proposed', // 'proposed' = waiting on user decision
    artifact_path: rel,
    proposal_id,
    summary: title
      ? `Asked Jasper: acquire / file / skip "${title}"`
      : 'Asked Jasper: acquire / file / skip this book',
  });

  audit_intake(input, {
    handler: 'cordelia.intake_book',
    record_path: rel,
    title_candidate: title,
    author_candidate: author,
    proposal_id,
  });
};
