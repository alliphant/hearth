/**
 * Brigid — food label / restaurant menu / kitchen receipt intake.
 *
 * Appends a one-line taste-signal observation to
 * Knowledge/Brigid/taste-signals.md and files the full capture
 * detail at Knowledge/Brigid/labels/<date>-<seed>.md. The
 * taste-signals file is what Brigid's next deliberation pass reads
 * to update the household's preference model.
 */

import type { IntakeHandler, IntakeHandlerInput } from '@core/reactive_inbox';
import { audit_intake, date_part, mark_intake_done, slug } from '../../_intake_helpers';

export const intake_food_label: IntakeHandler = async (input: IntakeHandlerInput) => {
  const payload = input.decision.extracted_payload;
  const ocr_text = payload.ocr_text ?? '';
  const desc = payload.vl_description ?? '';
  const salient = payload.vl_salient_objects ?? [];
  const seed = salient[0] ?? ocr_text.split(/\r?\n/)[0]?.slice(0, 40) ?? 'food-capture';
  const date = date_part(new Date().toISOString());

  const detail_rel = `Knowledge/Brigid/labels/${date}-${slug(seed)}.md`;
  input.memory.upsert_note(
    detail_rel,
    {
      type: 'food_capture',
      source_capture_id: input.capture_id,
      source_capture_note: input.note_path,
      salient_objects: salient,
      private_to: input.user_id,
    },
    [
      `# Food capture — ${seed}`,
      '',
      `**Route reason**: ${input.decision.route_reason}`,
      desc ? `\n## VL description\n\n${desc}` : '',
      ocr_text ? `\n## OCR text\n\n\`\`\`\n${ocr_text}\n\`\`\`` : '',
      '',
      '## Source',
      `Capture: [[${input.note_path}|original]]`,
    ].join('\n'),
  );

  const taste_line =
    `- **${date}** — captured "${seed}"${salient.length ? ` · salient: ${salient.slice(0, 3).join(', ')}` : ''} · [[${detail_rel}]]`;
  input.memory.append_to_note('Knowledge/Brigid/taste-signals.md', taste_line);

  mark_intake_done(input.memory, input.note_path, {
    handler: 'brigid.intake_food_label',
    outcome: 'filed',
    artifact_path: detail_rel,
    summary: `Food capture filed; taste-signal line appended (${seed})`,
  });

  audit_intake(input, {
    handler: 'brigid.intake_food_label',
    record_path: detail_rel,
    taste_signals_appended: true,
  });
};
