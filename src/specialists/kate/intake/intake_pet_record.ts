/**
 * Anya — pet record / vet doc / animal prescription intake.
 *
 * Runs the prescription extractor (a vet record's lab summary fits
 * the same fields well enough); files the result onto
 * Knowledge/Anya/records/<date>-<medication-or-summary>.md and
 * stamps the wrapper. When the extractor flags a refill or a
 * follow-up date, leave a low-severity FYI in Anya's inbox so her
 * next deliberation slot can see it.
 */

import { ulid } from 'ulid';
import type { IntakeHandler, IntakeHandlerInput } from '@core/reactive_inbox';
import { extract_prescription } from '../../cordelia/extractors';
import {
  audit_intake,
  date_part,
  mark_intake_done,
  slug,
} from '../../_intake_helpers';

export const intake_pet_record: IntakeHandler = async (input: IntakeHandlerInput) => {
  const ocr_text = input.decision.extracted_payload.ocr_text ?? '';
  const fields = ocr_text.length > 20 ? await extract_prescription(input.llm, ocr_text) : null;

  const date = fields?.fill_date ?? date_part(new Date().toISOString());
  const slug_seed = fields?.medication ?? fields?.patient ?? 'pet-record';
  const rel = `Knowledge/Anya/records/${date}-${slug(slug_seed)}.md`;

  const fm: Record<string, unknown> = {
    type: 'pet_record',
    source_capture_id: input.capture_id,
    source_capture_note: input.note_path,
    patient: fields?.patient ?? null,
    patient_kind: fields?.patient_kind ?? 'unknown',
    prescriber: fields?.prescriber ?? null,
    pharmacy: fields?.pharmacy ?? null,
    medication: fields?.medication ?? null,
    dose: fields?.dose ?? null,
    instructions: fields?.instructions ?? null,
    refills_remaining: fields?.refills_remaining ?? null,
    fill_date: fields?.fill_date ?? null,
    extractor_confidence: fields?.confidence ?? 0,
    private_to: input.user_id,
  };

  const lines: string[] = [];
  lines.push(`# Pet record — ${fields?.patient ?? 'unknown patient'}`);
  lines.push('');
  if (fields?.medication) lines.push(`**Medication**: ${fields.medication}${fields.dose ? ` (${fields.dose})` : ''}`);
  if (fields?.prescriber) lines.push(`**Prescriber**: ${fields.prescriber}`);
  if (fields?.pharmacy) lines.push(`**Pharmacy**: ${fields.pharmacy}`);
  if (fields?.instructions) {
    lines.push('');
    lines.push('## Instructions');
    lines.push(fields.instructions);
  }
  lines.push('');
  lines.push('## Source');
  lines.push(`Capture: [[${input.note_path}|original]] — ${input.decision.route_reason}`);
  if (ocr_text.length > 0) {
    lines.push('');
    lines.push('## OCR text');
    lines.push('');
    lines.push('```');
    lines.push(ocr_text);
    lines.push('```');
  }

  input.memory.upsert_note(rel, fm, lines.join('\n'));

  // Drop a low-severity FYI when refills or a fill_date were found —
  // Anya's deliberation slot can decide whether to propose a reminder.
  let inbox_id: string | null = null;
  if (fields?.refills_remaining != null && fields.refills_remaining <= 1) {
    inbox_id = input.inbox.push({
      from_specialist_id: 'cordelia',
      to_specialist_id: 'anya',
      kind: 'fyi',
      body_md: `Pet prescription for ${fields.patient ?? '?'} has ${fields.refills_remaining} refill(s) remaining (${fields.medication ?? 'med?'}).`,
      originating_user_id: input.user_id,
    });
  }

  mark_intake_done(input.memory, input.note_path, {
    handler: 'anya.intake_pet_record',
    outcome: 'filed',
    artifact_path: rel,
    summary:
      `Filed pet record` +
      (fields?.medication ? ` (${fields.medication})` : '') +
      (fields?.patient ? ` for ${fields.patient}` : ''),
  });

  audit_intake(input, {
    handler: 'anya.intake_pet_record',
    record_path: rel,
    inbox_id: inbox_id ?? undefined,
    refills_remaining: fields?.refills_remaining ?? null,
    intake_id: ulid(),
  });
};
