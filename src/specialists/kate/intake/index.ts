/**
 * Kate's intake dispatcher.
 *
 * Three flavors of capture route to Kate — paper mail, business cards,
 * and (since the 2026-07-04 Anya fold-in) pet medical records. The
 * reactive driver registers one handler per specialist; this module picks
 * between them. The pet branch keys on the CLASSIFIER'S OWN judgment
 * (route_reason / signal_substrate / user_note — model output, not raw
 * content sniffing): with Anya retired from the candidate roster, a vet
 * capture routes to Kate and the classifier's rationale says why. Mail vs
 * business card keeps the original cheap structural heuristic (contact-
 * token density on short OCR). Unmatched → mail intake (the generic).
 */

import type { IntakeHandler, IntakeHandlerInput } from '@core/reactive_inbox';
import { intake_mail } from './intake_mail';
import { intake_business_card } from './intake_business_card';
import { intake_pet_record } from './intake_pet_record';

const EMAIL_PATTERN = /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/;
const PHONE_PATTERN = /\b(?:\+?\d{1,3}[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/;
const URL_PATTERN = /\bhttps?:\/\/[^\s]+|\bwww\.[^\s]+/i;
const PET_MEDICAL_PATTERN = /\b(vet(erinar\w*)?|pet med|pet record|prescription|apoquel|animal (record|clinic|hospital))\b/i;

export const intake_kate: IntakeHandler = async (input: IntakeHandlerInput) => {
  // Pet medical records (folded from Anya): trust the classifier's stated
  // rationale + the user's own caption, not the document text — conservative
  // on purpose; a miss falls to mail intake, which still files and flags.
  const classifier_judgment = [
    input.decision.route_reason ?? '',
    input.decision.extracted_payload.signal_substrate ?? '',
    input.decision.extracted_payload.notes ?? '',
  ].join(' ');
  if (PET_MEDICAL_PATTERN.test(classifier_judgment)) {
    return intake_pet_record(input);
  }

  const ocr_text = input.decision.extracted_payload.ocr_text ?? '';
  // Business cards are short (often <300 chars), high-density
  // contact tokens. Anything beyond that — especially with paragraph
  // structure — reads as mail.
  const is_short = ocr_text.length > 0 && ocr_text.length < 400;
  const contact_hits =
    (EMAIL_PATTERN.test(ocr_text) ? 1 : 0) +
    (PHONE_PATTERN.test(ocr_text) ? 1 : 0) +
    (URL_PATTERN.test(ocr_text) ? 1 : 0);
  if (is_short && contact_hits >= 2) {
    return intake_business_card(input);
  }
  return intake_mail(input);
};
