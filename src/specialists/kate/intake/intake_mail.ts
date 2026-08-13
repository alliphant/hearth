/**
 * Kate — paper-mail intake.
 *
 * Files the capture under Knowledge/Kate/mail/<date>/<seed>.md.
 * Mail volume + urgency live in the OCR text (return addresses,
 * "important", "final notice"); Kate's deliberation reads these for
 * the next brief. We flag URGENT_KEYWORDS straight into the inbox so
 * a "final notice" doesn't wait until 07:00 to surface.
 */

import type { IntakeHandler, IntakeHandlerInput } from '@core/reactive_inbox';
import { audit_intake, date_part, mark_intake_done, slug } from '../../_intake_helpers';

const URGENT_KEYWORDS = [
  'final notice', 'past due', 'overdue', 'urgent', 'action required',
  'jury duty', 'subpoena', 'court', 'eviction', 'collections',
  'cancellation', 'rate change',
];

export const intake_mail: IntakeHandler = async (input: IntakeHandlerInput) => {
  const ocr_text = input.decision.extracted_payload.ocr_text ?? '';
  const lower = ocr_text.toLowerCase();
  const urgent_hits = URGENT_KEYWORDS.filter((kw) => lower.includes(kw));

  const first_line = ocr_text.split(/\r?\n/).find((l) => l.trim().length > 0) ?? 'mail';
  const date = date_part(new Date().toISOString());
  const rel = `Knowledge/Kate/mail/${date}/${slug(first_line)}.md`;

  const fm: Record<string, unknown> = {
    type: 'mail',
    source_capture_id: input.capture_id,
    source_capture_note: input.note_path,
    urgent_keywords_present: urgent_hits,
    needs_attention: urgent_hits.length > 0,
    private_to: input.user_id,
  };

  const body = [
    `# Mail — ${first_line.slice(0, 80)}`,
    '',
    `**Route reason**: ${input.decision.route_reason}`,
    urgent_hits.length ? `**Urgent keywords**: ${urgent_hits.join(', ')}` : '',
    '',
    '## OCR text',
    '',
    '```',
    ocr_text,
    '```',
    '',
    '## Source',
    `Capture: [[${input.note_path}|original]]`,
  ].filter((l) => l !== '').join('\n');
  input.memory.upsert_note(rel, fm, body);

  let inbox_id: string | null = null;
  if (urgent_hits.length > 0) {
    inbox_id = input.inbox.push({
      from_specialist_id: 'cordelia',
      to_specialist_id: 'kate',
      kind: 'flag',
      body_md: `Mail with urgent keywords (**${urgent_hits.join(', ')}**) — see [[${rel}]].`,
      originating_user_id: input.user_id,
    });
  }

  mark_intake_done(input.memory, input.note_path, {
    handler: 'kate.intake_mail',
    outcome: urgent_hits.length > 0 ? 'proposed' : 'filed',
    artifact_path: rel,
    summary: urgent_hits.length > 0 ? `Urgent mail: ${urgent_hits.join(', ')}` : 'Mail filed',
  });

  audit_intake(input, {
    handler: 'kate.intake_mail',
    record_path: rel,
    urgent_keywords: urgent_hits,
    inbox_id: inbox_id ?? undefined,
  });
};
