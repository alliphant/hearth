/**
 * Kate — business-card intake.
 *
 * Runs the business-card extractor, files a contact note under
 * Knowledge/Kate/contacts/<slug>.md. We DON'T auto-create a Person
 * note in the People/ namespace — that's a Scribe write and the
 * privacy contract is higher there; Kate's deliberation can propose
 * the upgrade.
 */

import type { IntakeHandler, IntakeHandlerInput } from '@core/reactive_inbox';
import { extract_business_card } from '../../cordelia/extractors';
import { audit_intake, mark_intake_done, slug } from '../../_intake_helpers';

export const intake_business_card: IntakeHandler = async (input: IntakeHandlerInput) => {
  const ocr_text = input.decision.extracted_payload.ocr_text ?? '';
  const fields = ocr_text.length > 10 ? await extract_business_card(input.llm, ocr_text) : null;

  const seed = fields?.name ?? fields?.company ?? 'business-card';
  const rel = `Knowledge/Kate/contacts/${slug(seed)}.md`;

  const fm: Record<string, unknown> = {
    type: 'contact_card',
    source_capture_id: input.capture_id,
    source_capture_note: input.note_path,
    name: fields?.name ?? null,
    company: fields?.company ?? null,
    role_title: fields?.role ?? null,
    emails: fields?.emails ?? [],
    phones: fields?.phones ?? [],
    url: fields?.url ?? null,
    address: fields?.address ?? null,
    extractor_confidence: fields?.confidence ?? 0,
    private_to: input.user_id,
  };

  const lines: string[] = [];
  lines.push(`# Contact — ${fields?.name ?? seed}`);
  lines.push('');
  if (fields?.role || fields?.company) {
    lines.push(`**Role**: ${[fields?.role, fields?.company].filter(Boolean).join(' @ ')}`);
  }
  if (fields?.emails?.length) lines.push(`**Emails**: ${fields.emails.join(', ')}`);
  if (fields?.phones?.length) lines.push(`**Phones**: ${fields.phones.join(', ')}`);
  if (fields?.url) lines.push(`**URL**: ${fields.url}`);
  if (fields?.address) lines.push(`**Address**: ${fields.address}`);
  if (fields?.notes) {
    lines.push('');
    lines.push('## Notes');
    lines.push(fields.notes);
  }
  if (ocr_text.length > 0) {
    lines.push('');
    lines.push('## OCR text');
    lines.push('');
    lines.push('```');
    lines.push(ocr_text);
    lines.push('```');
  }
  lines.push('');
  lines.push('## Source');
  lines.push(`Capture: [[${input.note_path}|original]]`);

  input.memory.upsert_note(rel, fm, lines.join('\n'));

  mark_intake_done(input.memory, input.note_path, {
    handler: 'kate.intake_business_card',
    outcome: 'filed',
    artifact_path: rel,
    summary: fields?.name ? `Filed contact card for ${fields.name}` : 'Filed business card',
  });

  audit_intake(input, {
    handler: 'kate.intake_business_card',
    record_path: rel,
    name: fields?.name ?? null,
    company: fields?.company ?? null,
    extractor_confidence: fields?.confidence ?? 0,
  });
};
