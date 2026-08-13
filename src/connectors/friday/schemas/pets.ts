/**
 * Zod schema for FRIDAY's pets_data.json. Mirrors the prose schema
 * documented in `docker/.github/copilot-instructions.md` §"Pets Module
 * — Data File" (schema version `friday-pets-v1`).
 *
 * Schemas are permissive (`.passthrough()` on entities) so a new field
 * added FRIDAY-side won't break our reads. Required fields are the
 * minimum the file commits to. Validation fails loud if a required
 * field disappears — that's the contract drift we want to catch
 * (and the trigger for an architecture-doc review).
 *
 * Photos are intentionally NOT projected into specialist-visible data
 * — they're huge base64 data URLs (often 200+ KB each) and useless to
 * an LLM. The tool layer strips them before returning.
 */
import { z } from 'zod';

const PetProfileSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    breed: z.string().optional(),
    dob: z.string().optional(), // YYYY-MM-DD
    weight_lbs: z.number().optional(),
    emoji: z.string().optional(),
    // photo: intentionally omitted from validation — stripped by tool layer
    microchip_id: z.string().nullable().optional(),
    insurance: z.string().nullable().optional(),
    // Accept both shapes — actual data uses an array, older docs
    // described it as a string. Either is fine for our reads.
    allergies: z.union([z.array(z.string()), z.string()]).nullable().optional(),
    emergency_vet: z.string().nullable().optional(),
    emergency_vet_phone: z.string().nullable().optional(),
    emergency_vet_address: z.string().nullable().optional(),
    primary_vet: z.string().nullable().optional(),
    primary_vet_phone: z.string().nullable().optional(),
    primary_vet_address: z.string().nullable().optional(),
    notes: z.string().nullable().optional(),
    feeding_notes: z.string().nullable().optional(),
  })
  .passthrough();

const FeedingLogEntrySchema = z
  .object({
    id: z.string(),
    pet_id: z.string(),
    date: z.string(),
    meal: z.string(),
    cups: z.number(),
    fed_by: z.string().nullable().optional(),
    timestamp: z.string().optional(),
  })
  .passthrough();

const MedicationSchema = z
  .object({
    id: z.string(),
    pet_id: z.string(),
    name: z.string(),
    dose: z.string().optional(),
    frequency: z.string().optional(),
    times: z.array(z.string()).optional(),
    start_date: z.string().optional(),
    end_date: z.string().nullable().optional(),
    active: z.boolean().optional(),
  })
  .passthrough();

const MedLogEntrySchema = z
  .object({
    id: z.string(),
    med_id: z.string(),
    pet_id: z.string(),
    date: z.string(),
    scheduled_time: z.string().optional(),
    given_at: z.string().nullable().optional(),
    given_by: z.string().nullable().optional(),
    status: z.string().optional(), // 'given' | 'late' | 'missed' | 'skipped'
    skipped: z.boolean().optional(),
    notes: z.string().nullable().optional(),
  })
  .passthrough();

const FleaTickSchema = z
  .object({
    id: z.string(),
    pet_id: z.string(),
    log: z.array(z.unknown()).optional(),
    product: z.string().optional(),
    frequency_days: z.number().optional(),
    last_applied: z.string().nullable().optional(),
    next_due: z.string().nullable().optional(),
  })
  .passthrough();

const TransfusionSchema = z
  .object({
    id: z.string(),
    pet_id: z.string(),
    date: z.string(),
    donor: z.string().nullable().optional(),
    volume_ml_per_kg: z.number().nullable().optional(),
    pre_rbc_pct: z.number().nullable().optional(),
    post_rbc_pct: z.number().nullable().optional(),
    notes: z.string().nullable().optional(),
    followups: z.array(z.unknown()).optional(),
  })
  .passthrough();

const BloodDonationSchema = z
  .object({
    id: z.string(),
    pet_id: z.string(),
    date: z.string(),
    location: z.string().nullable().optional(),
    volume_ml: z.number().nullable().optional(),
    notes: z.string().nullable().optional(),
  })
  .passthrough();

const ProductSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    brand: z.string().nullable().optional(),
    category: z.string().optional(),
    container_size: z.number().optional(),
    container_unit: z.string().optional(),
    serving_unit: z.string().optional(),
    conversion: z.number().nullable().optional(),
    total_servings: z.number().optional(),
    price: z.number().nullable().optional(),
    grams_per_cup: z.number().nullable().optional(),
    consumption: z
      .array(
        z
          .object({
            pet_id: z.string(),
            per_day: z.number(),
          })
          .passthrough(),
      )
      .optional(),
  })
  .passthrough();

const SupplyInventoryEntrySchema = z
  .object({
    id: z.string(),
    product_id: z.string(),
    pet_ids: z.array(z.string()).optional(),
    purchased_date: z.string().nullable().optional(),
    estimated_depletion: z.string().nullable().optional(),
    active: z.boolean().optional(),
    _days_left: z.number().nullable().optional(),
    _pct_left: z.number().nullable().optional(),
    _avg_daily_cups: z.number().nullable().optional(),
    _daily_rate: z.number().nullable().optional(),
    _serving_unit: z.string().nullable().optional(),
    _product: z.unknown().optional(),
  })
  .passthrough();

const VetAppointmentSchema = z
  .object({
    id: z.string(),
    pet_id: z.string(),
    date: z.string(),
    type: z.string().optional(),
    provider: z.string().nullable().optional(),
    notes: z.string().nullable().optional(),
  })
  .passthrough();

const WeightLogEntrySchema = z
  .object({
    id: z.string(),
    pet_id: z.string(),
    date: z.string(),
    weight_lbs: z.number(),
  })
  .passthrough();

const SymptomJournalEntrySchema = z
  .object({
    id: z.string(),
    pet_id: z.string(),
    date: z.string(),
    timestamp: z.string().optional(),
    description: z.string(),
    severity: z.string().optional(), // 'low' | 'medium' | 'high'
    status: z.string().optional(), // 'active' | 'resolved'
    classified_by: z.string().optional(), // 'user' | 'llm'
    resolved_date: z.string().nullable().optional(),
    resolved_timestamp: z.string().nullable().optional(),
  })
  .passthrough();

const VaccinationSchema = z
  .object({
    id: z.string(),
    pet_id: z.string(),
    type: z.string(),
    given_date: z.string().optional(),
    expiry_date: z.string().nullable().optional(),
    provider: z.string().nullable().optional(),
    lot_number: z.string().nullable().optional(),
  })
  .passthrough();

export const PetsDataSchema = z
  .object({
    _schema: z.string(), // 'friday-pets-v1' (warn if drifts)
    _updated: z.string().optional(),
    // Dict-keyed collections (id → entity)
    pets: z.record(PetProfileSchema).optional(),
    medications: z.record(MedicationSchema).optional(),
    flea_tick: z.record(FleaTickSchema).optional(),
    products: z.record(ProductSchema).optional(),
    food_products: z.record(z.unknown()).optional(), // legacy, may be empty
    // Array-shaped log collections
    feeding_log: z.array(FeedingLogEntrySchema).optional(),
    med_log: z.array(MedLogEntrySchema).optional(),
    transfusions: z.array(TransfusionSchema).optional(),
    blood_donations: z.array(BloodDonationSchema).optional(),
    supply_inventory: z.array(SupplyInventoryEntrySchema).optional(),
    vet_appointments: z.array(VetAppointmentSchema).optional(),
    weight_log: z.array(WeightLogEntrySchema).optional(),
    symptom_journal: z.array(SymptomJournalEntrySchema).optional(),
    vaccinations: z.array(VaccinationSchema).optional(),
  })
  .passthrough();

export type PetsData = z.infer<typeof PetsDataSchema>;

/** Strip the `photo` field from every pet profile in-place. */
export function strip_photos<T extends { pets?: Record<string, unknown> }>(
  data: T,
): T {
  if (!data.pets) return data;
  for (const k of Object.keys(data.pets)) {
    const pet = data.pets[k];
    if (pet && typeof pet === 'object' && 'photo' in pet) {
      delete (pet as Record<string, unknown>).photo;
    }
  }
  return data;
}

/** The expected schema version. Bump when we knowingly migrate. */
export const EXPECTED_PETS_SCHEMA_VERSION = 'friday-pets-v1';
