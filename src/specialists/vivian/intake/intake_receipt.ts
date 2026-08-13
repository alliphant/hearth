/**
 * Vivian — receipt intake.
 *
 * Cordelia classified a capture as a receipt and routed it to Vivian.
 * Run the structured extractor to pull store / date / total / items,
 * file the result onto Knowledge/Vivian/receipts/<date>/<store>.md,
 * stamp the wrapper frontmatter, audit.
 *
 * No proposal — Vivian's domain is observe+record; a downstream
 * deliberation pass can decide to surface a spending pattern.
 */

import type { IntakeHandler, IntakeHandlerInput } from '@core/reactive_inbox';
import { extract_receipt } from '../../cordelia/extractors';
import {
  audit_intake,
  date_part,
  mark_intake_done,
  slug,
} from '../../_intake_helpers';

export const intake_receipt: IntakeHandler = async (input: IntakeHandlerInput) => {
  const ocr_text = input.decision.extracted_payload.ocr_text ?? '';
  const fields = ocr_text.length > 20 ? await extract_receipt(input.llm, ocr_text) : null;

  const date = fields?.date ?? date_part(new Date().toISOString());
  const store = fields?.store ?? 'unknown-store';
  const rel = `Knowledge/Vivian/receipts/${date}/${slug(store)}.md`;

  const frontmatter: Record<string, unknown> = {
    type: 'receipt',
    source_capture_id: input.capture_id,
    source_capture_note: input.note_path,
    store,
    transaction_date: fields?.date ?? null,
    transaction_id: fields?.transaction_id ?? null,
    payment_method: fields?.payment_method ?? null,
    total: fields?.total ?? null,
    currency: fields?.currency ?? null,
    items_count: fields?.items.length ?? 0,
    extractor_confidence: fields?.confidence ?? 0,
    private_to: input.user_id, // receipts are personal-scope by default
  };

  const lines: string[] = [];
  lines.push(`# Receipt — ${store} (${fields?.date ?? 'date unknown'})`);
  lines.push('');
  if (fields?.total != null) {
    lines.push(`**Total**: ${fields.currency ? fields.currency + ' ' : ''}${fields.total.toFixed(2)}`);
  }
  if (fields?.payment_method) lines.push(`**Payment**: ${fields.payment_method}`);
  if (fields?.transaction_id) lines.push(`**Txn id**: ${fields.transaction_id}`);
  if (fields?.return_policy) lines.push(`**Return policy**: ${fields.return_policy}`);
  if (fields?.items.length) {
    lines.push('');
    lines.push('## Items');
    for (const it of fields.items) {
      lines.push(`- ${it.label}${it.price != null ? ` — ${it.price.toFixed(2)}` : ''}`);
    }
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

  input.memory.upsert_note(rel, frontmatter, lines.join('\n'));

  mark_intake_done(input.memory, input.note_path, {
    handler: 'vivian.intake_receipt',
    outcome: 'filed',
    artifact_path: rel,
    summary:
      `Filed receipt from ${store}` +
      (fields?.total != null ? ` (${fields.currency ?? ''} ${fields.total.toFixed(2)})` : ''),
  });

  audit_intake(input, {
    handler: 'vivian.intake_receipt',
    record_path: rel,
    extractor_confidence: fields?.confidence ?? 0,
    store,
    total: fields?.total ?? null,
  });
};
