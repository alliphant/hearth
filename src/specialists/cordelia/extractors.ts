/**
 * Cordelia's structured-output extractors.
 *
 * Per-document-shape Qwen 27B calls that turn OCR text into a small
 * JSON object the receiving specialist's intake handler can act on.
 * Not a new service — just a planner-role LLM call with a strict
 * schema-shaped prompt.
 *
 * Each extractor:
 *   - validates the LLM output against a Zod schema,
 *   - returns null when the output is unparseable,
 *   - is deterministic enough (temperature 0.1) that a re-run produces
 *     the same fields for the same OCR text.
 */

import { z } from 'zod';
import type { LLMRouter } from '@core/llm';

const ReceiptSchema = z.object({
  store: z.string().nullable(),
  date: z.string().nullable(), // YYYY-MM-DD when extractable
  transaction_id: z.string().nullable(),
  payment_method: z.string().nullable(),
  items: z.array(
    z.object({
      label: z.string(),
      price: z.number().nullable(),
    }),
  ),
  total: z.number().nullable(),
  currency: z.string().nullable(),
  return_policy: z.string().nullable(),
  confidence: z.number().min(0).max(1),
});
export type ExtractedReceipt = z.infer<typeof ReceiptSchema>;

const PrescriptionSchema = z.object({
  patient: z.string().nullable(),
  patient_kind: z.enum(['human', 'pet', 'unknown']),
  prescriber: z.string().nullable(),
  pharmacy: z.string().nullable(),
  medication: z.string().nullable(),
  dose: z.string().nullable(),
  instructions: z.string().nullable(),
  refills_remaining: z.number().nullable(),
  fill_date: z.string().nullable(),
  confidence: z.number().min(0).max(1),
});
export type ExtractedPrescription = z.infer<typeof PrescriptionSchema>;

const BusinessCardSchema = z.object({
  name: z.string().nullable(),
  company: z.string().nullable(),
  role: z.string().nullable(),
  emails: z.array(z.string()),
  phones: z.array(z.string()),
  url: z.string().nullable(),
  address: z.string().nullable(),
  notes: z.string().nullable(),
  confidence: z.number().min(0).max(1),
});
export type ExtractedBusinessCard = z.infer<typeof BusinessCardSchema>;

function strip_fence(s: string): string {
  return s
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();
}

async function call_extractor<T>(
  llm: LLMRouter,
  schema: z.ZodType<T>,
  system_prompt: string,
  ocr_text: string,
): Promise<T | null> {
  const role = llm.for_role('planner');
  const resp = await role.provider.complete({
    messages: [
      { role: 'system', content: system_prompt },
      { role: 'user', content: `OCR text:\n\n${ocr_text.slice(0, 4000)}\n\nReply with ONLY the JSON object.` },
    ],
    temperature: 0.1,
    max_tokens: 600,
    think: false,
    ...role.defaults,
  });
  let parsed: unknown;
  try {
    parsed = JSON.parse(strip_fence(resp.content));
  } catch {
    return null;
  }
  const result = schema.safeParse(parsed);
  return result.success ? result.data : null;
}

export async function extract_receipt(
  llm: LLMRouter,
  ocr_text: string,
): Promise<ExtractedReceipt | null> {
  return call_extractor(
    llm,
    ReceiptSchema,
    `You extract fields from a retail receipt OCR. Reply with ONLY this JSON shape:

{
  "store": string | null,
  "date": "YYYY-MM-DD" | null,
  "transaction_id": string | null,
  "payment_method": string | null,
  "items": [{ "label": string, "price": number | null }],
  "total": number | null,
  "currency": string | null,
  "return_policy": string | null,
  "confidence": 0.0-1.0
}

Rules: never invent fields. When a field is unclear, use null. If items aren't clearly priced, return an empty list rather than guessing.`,
    ocr_text,
  );
}

const CivicMailSchema = z.object({
  kind: z
    .enum([
      'council_meeting',
      'agenda_item',
      'new_in_town',
      'corridor_alert',
      'announcement',
      'watching',
    ])
    .nullable(),
  title: z.string().nullable(),
  summary: z.string().nullable(),
  event_at: z.string().nullable(),
  location_label: z.string().nullable(),
  confidence: z.number(),
});
export type ExtractedCivicMail = z.infer<typeof CivicMailSchema>;

/** Extract a single Pleasantville civic item from a photographed mailer /
 *  flyer / public notice OCR, for Ruby's office (`record_civic_item`). */
export async function extract_civic_item(
  llm: LLMRouter,
  ocr_text: string,
): Promise<ExtractedCivicMail | null> {
  return call_extractor(
    llm,
    CivicMailSchema,
    `You extract ONE Pleasantville civic item from a photographed mailer, flyer, or public notice OCR. Reply with ONLY this JSON shape:

{
  "kind": "council_meeting" | "agenda_item" | "new_in_town" | "corridor_alert" | "announcement" | "watching" | null,
  "title": string | null,
  "summary": string | null,
  "event_at": "YYYY-MM-DDTHH:MM:SS" | null,
  "location_label": string | null,
  "confidence": 0.0-1.0
}

Rules: never invent. kind — a dated public meeting → council_meeting; a hearing or agenda topic → agenda_item; a new business / store / event opening → new_in_town; a road, lane, or construction notice → corridor_alert; an official city announcement → announcement; anything minor → watching. Set event_at ONLY when a clear date (and time if present) is printed. Use null whenever unclear.`,
    ocr_text,
  );
}

export async function extract_prescription(
  llm: LLMRouter,
  ocr_text: string,
): Promise<ExtractedPrescription | null> {
  return call_extractor(
    llm,
    PrescriptionSchema,
    `You extract fields from a prescription label or vet record OCR. Reply with ONLY this JSON:

{
  "patient": string | null,
  "patient_kind": "human" | "pet" | "unknown",
  "prescriber": string | null,
  "pharmacy": string | null,
  "medication": string | null,
  "dose": string | null,
  "instructions": string | null,
  "refills_remaining": number | null,
  "fill_date": "YYYY-MM-DD" | null,
  "confidence": 0.0-1.0
}

If the label mentions a species, breed, weight, or vet, set patient_kind="pet". If it mentions a human dosage form (mg by mouth twice daily for "Jasper Smith"), set patient_kind="human". Otherwise "unknown".`,
    ocr_text,
  );
}

export async function extract_business_card(
  llm: LLMRouter,
  ocr_text: string,
): Promise<ExtractedBusinessCard | null> {
  return call_extractor(
    llm,
    BusinessCardSchema,
    `You extract fields from a business-card OCR. Reply with ONLY this JSON:

{
  "name": string | null,
  "company": string | null,
  "role": string | null,
  "emails": string[],
  "phones": string[],
  "url": string | null,
  "address": string | null,
  "notes": string | null,
  "confidence": 0.0-1.0
}

Rules: emails are valid only with an @. Phones include their country/area separators verbatim from the card. Never invent.`,
    ocr_text,
  );
}

// ── Utility bill (Anna) ──────────────────────────────────────────────────────
// Electric / gas / water bills. FC Utilities is combined (electric + water +
// wastewater/stormwater); gas is a separate Xcel bill (therms). Extract usage
// in natural units + costs + the service period. intake_utility_bill files +
// stores these and hands the cost trend to Vivian.
const UtilityBillSchema = z.object({
  utility_provider: z.string().nullable(),
  account_number: z.string().nullable(),
  period_start: z.string().nullable(), // YYYY-MM-DD
  period_end: z.string().nullable(),   // YYYY-MM-DD
  electric_kwh: z.number().nullable(),
  gas_therms: z.number().nullable(),
  water_gallons: z.number().nullable(),
  electric_cost: z.number().nullable(),
  gas_cost: z.number().nullable(),
  water_cost: z.number().nullable(),
  total_cost: z.number().nullable(),
  currency: z.string().nullable(),
  confidence: z.number().min(0).max(1),
});
export type ExtractedUtilityBill = z.infer<typeof UtilityBillSchema>;

export async function extract_utility_bill(
  llm: LLMRouter,
  text: string,
): Promise<ExtractedUtilityBill | null> {
  return call_extractor(
    llm,
    UtilityBillSchema,
    `You extract fields from a residential UTILITY BILL (electric, natural gas, and/or water). Reply with ONLY this JSON shape:
{
  "utility_provider": string | null,
  "account_number": string | null,
  "period_start": "YYYY-MM-DD" | null,
  "period_end": "YYYY-MM-DD" | null,
  "electric_kwh": number | null,
  "gas_therms": number | null,
  "water_gallons": number | null,
  "electric_cost": number | null,
  "gas_cost": number | null,
  "water_cost": number | null,
  "total_cost": number | null,
  "currency": string | null,
  "confidence": 0.0-1.0
}

Rules: usage in natural units — electricity in kWh, gas in therms (convert CCF→therms only if a therm factor is shown, else leave therms null), water in GALLONS (convert 1000-gal or CCF units to gallons only if the unit is explicit). Costs are decimals. A combined bill (e.g. Pleasantville Utilities) may have electric + water together; a gas bill (e.g. Xcel) has therms only — fill only what the bill shows, null the rest. Never invent a period or a unit you can't see.`,
    text,
  );
}
