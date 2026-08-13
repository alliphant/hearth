/**
 * Anna — utility-bill intake.
 *
 * Cordelia classified a capture as a utility bill (FC Utilities combined
 * electric+water, or an Xcel gas bill) and routed it to Anna. Pull the text
 * (OCR from the classifier, or extract the PDF ourselves), run the structured
 * extractor for usage + costs + period, store a row in the shared
 * utility_readings table (Anna analyses usage; Vivian reads the cost), file a
 * markdown record under Knowledge/Anna/utility-bills/, and FYI Vivian the cost.
 *
 * No proposal — observe + record + share; Anna surfaces actions in chat
 * ("your gas use says a heat pump pays back in N years") on demand.
 */
import { readFileSync } from 'node:fs';
import type { IntakeHandler, IntakeHandlerInput } from '@core/reactive_inbox';
import { UtilityReadingsStore } from '@memory/stores/utility_readings';
import { extract_utility_bill } from '../../cordelia/extractors';
import { audit_intake, date_part, mark_intake_done, slug } from '../../_intake_helpers';

/** Extract text from a PDF attachment (utility bills download as PDFs). */
async function pdf_text(abs_path: string): Promise<string> {
  try {
    const { extractText, getDocumentProxy } = await import('unpdf');
    const bytes = new Uint8Array(readFileSync(abs_path));
    const pdf = await getDocumentProxy(bytes);
    const { text } = await extractText(pdf, { mergePages: true });
    return Array.isArray(text) ? text.join('\n') : text;
  } catch {
    return '';
  }
}

function infer_service(f: {
  electric_kwh: number | null;
  gas_therms: number | null;
  water_gallons: number | null;
}): string {
  const has = (n: number | null) => n != null && n > 0;
  const e = has(f.electric_kwh), g = has(f.gas_therms), w = has(f.water_gallons);
  if (g && !e && !w) return 'gas';
  if (e && w) return 'combined';
  if (e) return 'electric';
  if (w) return 'water';
  return 'unknown';
}

const usd = (n: number | null | undefined) => (n == null ? '—' : `$${n.toFixed(2)}`);

export const intake_utility_bill: IntakeHandler = async (input: IntakeHandlerInput) => {
  // Prefer the classifier's OCR text; for a PDF with no/thin OCR, parse it.
  let text = input.decision.extracted_payload.ocr_text ?? '';
  if (text.trim().length < 40 && input.attachment_path && /\.pdf$/i.test(input.attachment_path)) {
    text = await pdf_text(input.memory.abs_path(input.attachment_path));
  }

  const fields = text.trim().length > 20 ? await extract_utility_bill(input.llm, text) : null;

  const provider = fields?.utility_provider ?? 'utility';
  const service = fields ? infer_service(fields) : 'unknown';
  const period_end = fields?.period_end ?? date_part(new Date().toISOString());
  const period_start = fields?.period_start ?? null;
  const dedup_key = `${slug(provider)}|${period_start ?? '?'}|${period_end}`;

  // Store the reading (shared table — Vivian reads the cost trend too).
  const store = new UtilityReadingsStore(input.db);
  const rel = `Knowledge/Anna/utility-bills/${period_end}-${slug(provider)}.md`;
  if (fields) {
    store.upsert({
      user_id: input.user_id,
      utility_provider: fields.utility_provider,
      service,
      period_start,
      period_end,
      electric_kwh: fields.electric_kwh,
      gas_therms: fields.gas_therms,
      water_gallons: fields.water_gallons,
      electric_cost: fields.electric_cost,
      gas_cost: fields.gas_cost,
      water_cost: fields.water_cost,
      total_cost: fields.total_cost,
      currency: fields.currency ?? 'USD',
      account_number: fields.account_number,
      source_capture_id: input.capture_id,
      source_note_path: rel,
      extractor_confidence: fields.confidence,
      dedup_key,
    });
  }

  // File a human-readable record.
  const frontmatter: Record<string, unknown> = {
    type: 'utility_reading',
    source_capture_id: input.capture_id,
    source_capture_note: input.note_path,
    utility_provider: fields?.utility_provider ?? null,
    service,
    period_start,
    period_end,
    electric_kwh: fields?.electric_kwh ?? null,
    gas_therms: fields?.gas_therms ?? null,
    water_gallons: fields?.water_gallons ?? null,
    total_cost: fields?.total_cost ?? null,
    currency: fields?.currency ?? null,
    extractor_confidence: fields?.confidence ?? 0,
    private_to: input.user_id,
  };
  const lines: string[] = [];
  lines.push(`# Utility bill — ${provider} (${period_start ?? '?'} → ${period_end})`);
  lines.push('');
  lines.push('| Service | Usage | Cost |');
  lines.push('|---|---|---|');
  if (fields?.electric_kwh != null) lines.push(`| Electric | ${fields.electric_kwh} kWh | ${usd(fields.electric_cost)} |`);
  if (fields?.gas_therms != null) lines.push(`| Gas | ${fields.gas_therms} therms | ${usd(fields.gas_cost)} |`);
  if (fields?.water_gallons != null) lines.push(`| Water | ${fields.water_gallons} gal | ${usd(fields.water_cost)} |`);
  lines.push(`| **Total** |  | **${usd(fields?.total_cost)}** |`);
  lines.push('');
  if (!fields) lines.push('_Could not extract structured fields — review the source capture._');
  lines.push('## Source');
  lines.push(`Capture: [[${input.note_path}|original]] — ${input.decision.route_reason}`);
  if (text.trim().length > 0) {
    lines.push('', '## Extracted text', '', '```', text.slice(0, 4000), '```');
  }
  input.memory.upsert_note(rel, frontmatter, lines.join('\n'));

  // Hand the cost angle to Vivian (she owns the household budget).
  if (fields?.total_cost != null) {
    input.inbox.push({
      from_specialist_id: 'anna',
      to_specialist_id: 'vivian',
      kind: 'fyi',
      body_md:
        `Utility bill filed — **${provider}**, ${period_start ?? '?'} → ${period_end}: ` +
        `total **${usd(fields.total_cost)}** (electric ${fields.electric_kwh ?? '—'} kWh, ` +
        `gas ${fields.gas_therms ?? '—'} therms, water ${fields.water_gallons ?? '—'} gal). ` +
        `Reading stored for cost-trend tracking; details at [[${rel}]].`,
      originating_user_id: input.user_id,
    });
  }

  mark_intake_done(input.memory, input.note_path, {
    handler: 'anna.intake_utility_bill',
    outcome: fields ? 'filed' : 'noted',
    artifact_path: rel,
    summary: `Filed ${service} bill from ${provider}` + (fields?.total_cost != null ? ` (${usd(fields.total_cost)})` : ''),
  });

  audit_intake(input, {
    handler: 'anna.intake_utility_bill',
    record_path: rel,
    extractor_confidence: fields?.confidence ?? 0,
    provider,
    service,
    total_cost: fields?.total_cost ?? null,
  });
};
