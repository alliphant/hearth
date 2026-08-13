/**
 * Ruby — civic-mail intake.
 *
 * Cordelia classified a capture as Pleasantville civic mail (a council
 * notice, a ballot guide, a neighborhood newsletter, a construction
 * flyer) and routed it to Ruby. Extract a single civic item and record
 * it into the structured `civic_items` store so it shows in her office —
 * the photo path into the same surface her web sweeps populate.
 *
 * Because Jasper bothered to photograph it, it's at-a-glance by default
 * (interest_score floored at 0.5). Idempotent on the capture id.
 */

import type { IntakeHandler, IntakeHandlerInput } from '@core/reactive_inbox';
import { extract_civic_item } from '../../cordelia/extractors';
import { audit_intake, mark_intake_done } from '../../_intake_helpers';

export const intake_civic_mail: IntakeHandler = async (input: IntakeHandlerInput) => {
  const ocr_text = input.decision.extracted_payload.ocr_text ?? '';
  const fields = ocr_text.length > 20 ? await extract_civic_item(input.llm, ocr_text) : null;

  if (!fields || !fields.title) {
    // Nothing extractable — note it so the capture doesn't re-fire, but
    // don't fabricate a civic item from noise.
    mark_intake_done(input.memory, input.note_path, {
      handler: 'ruby.intake_civic_mail',
      outcome: 'noted',
      summary: 'civic mail — no extractable item',
    });
    audit_intake(input, { handler: 'ruby.intake_civic_mail', recorded: false });
    return;
  }

  const id = input.memory.record_civic_item({
    user_id: input.user_id,
    kind: fields.kind ?? 'watching',
    title: fields.title,
    summary: fields.summary ?? null,
    event_at: fields.event_at ?? null,
    url: null,
    location_label: fields.location_label ?? null,
    lat: null,
    lon: null,
    corridor_match: null,
    // Captured by Jasper ⇒ he cares ⇒ at-a-glance, not the outskirts.
    interest_score: Math.max(0.5, fields.confidence ?? 0.5),
    dedup_key: `capture:${input.capture_id}`,
    source: 'cordelia_capture',
  });

  audit_intake(input, { handler: 'ruby.intake_civic_mail', recorded: true, civic_item_id: id, kind: fields.kind });
  mark_intake_done(input.memory, input.note_path, {
    handler: 'ruby.intake_civic_mail',
    outcome: 'filed',
    summary: `civic item: ${fields.title}`,
  });
};
