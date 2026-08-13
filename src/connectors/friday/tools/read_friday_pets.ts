/**
 * read_friday_pets — Hearth-side projection over FRIDAY's pets_data.json.
 *
 * Tool semantics:
 *   - Filter to a single pet by id (Anya's most common need: drill into
 *     Bailey's clinical state vs. Mango's donor state).
 *   - Project to specific collections via `include` — saves tokens when
 *     all you need is, say, transfusions for a clinical review.
 *   - Filter time-series collections (feeding_log, med_log, transfusions,
 *     blood_donations, weight_log, symptom_journal) to entries since
 *     `since_iso` — bounds the response size for long histories.
 *   - Photos are ALWAYS stripped (huge base64 data URLs, useless to LLMs).
 *
 * Schema-drift handling: if `_schema` on the file changes from the
 * version we built against (`friday-pets-v1`), the tool returns the
 * data but adds a `schema_warning` field so the caller knows the
 * upstream contract shifted. Validation against our Zod schema still
 * happens — fields we declared required must still be present.
 *
 * Capability: `read_friday_pets`. Granted to Anya in seed config.
 * Kate's `read_friday_*` cross-app grant subsumes it.
 */
import { z } from 'zod';
import type { Tool, ToolContext } from '@core/tool';
import type { ToolDeps } from '@core/tool_deps';
import { require_caller_tier } from '@core/tool_gates';
import { get_friday_client } from '@connectors/friday/client';
import {
  PetsDataSchema,
  strip_photos,
  EXPECTED_PETS_SCHEMA_VERSION,
  type PetsData,
} from '@connectors/friday/schemas/pets';

const COLLECTION_KEYS = [
  'pets',
  'feeding_log',
  'medications',
  'med_log',
  'flea_tick',
  'transfusions',
  'blood_donations',
  'products',
  'supply_inventory',
  'vet_appointments',
  'weight_log',
  'symptom_journal',
  'vaccinations',
] as const;

type CollectionKey = (typeof COLLECTION_KEYS)[number];

// Default projection: clinical / care-decision fields. Excludes high-
// volume / low-value collections like feeding_log (151 entries, mostly
// noise for a clinical question) unless asked for explicitly.
const DEFAULT_INCLUDE: CollectionKey[] = [
  'pets',
  'medications',
  'med_log',
  'flea_tick',
  'transfusions',
  'blood_donations',
  'supply_inventory',
  'products',
  'vet_appointments',
  'weight_log',
  'symptom_journal',
  'vaccinations',
];

const InputSchema = z.object({
  // Optional pet filter — most clinical questions are pet-specific.
  pet_id: z.string().optional(),
  // Which collections to return. Default = DEFAULT_INCLUDE.
  include: z.array(z.enum(COLLECTION_KEYS)).optional(),
  // ISO timestamp — for log-style collections, drop entries older than this.
  since_iso: z.string().optional(),
});

const OutputSchema = z.object({
  schema_version: z.string(),
  schema_warning: z.string().nullable(),
  updated_iso: z.string().nullable(),
  pet_filter: z.string().nullable(),
  since_iso: z.string().nullable(),
  // Raw projected slice of pets_data.json (matches PetsData shape).
  data: z.unknown(),
});

type Input = z.infer<typeof InputSchema>;
type Output = z.infer<typeof OutputSchema>;

function filter_by_pet<T extends { pet_id?: string }>(
  rows: T[] | undefined,
  pet_id: string,
): T[] {
  if (!rows) return [];
  return rows.filter((r) => r && r.pet_id === pet_id);
}

function filter_dict_by_pet<T extends { pet_id?: string }>(
  dict: Record<string, T> | undefined,
  pet_id: string,
): Record<string, T> {
  if (!dict) return {};
  const out: Record<string, T> = {};
  for (const [k, v] of Object.entries(dict)) {
    if (v && v.pet_id === pet_id) out[k] = v;
  }
  return out;
}

function filter_since<T extends { date?: string; timestamp?: string; given_at?: string | null }>(
  rows: T[] | undefined,
  since_iso: string,
): T[] {
  if (!rows) return [];
  return rows.filter((r) => {
    // Prefer the most-precise stamp the entry has.
    const stamp = r.given_at ?? r.timestamp ?? r.date;
    if (!stamp) return true; // entry has no time → keep it (better to over-include than drop)
    return stamp >= since_iso;
  });
}

export function make_read_friday_pets(): Tool<Input, Output> {
  return {
    name: 'read_friday_pets',
    description:
      "Read pet care state from the FRIDAY Pets app — Bailey and Mango's profiles, medications, transfusion history, blood-donation log, food supply forecast, vet appointments, weight log, symptom journal, vaccinations. Use this for clinical reasoning over a pet's actual history. Filter by `pet_id` ('bailey' | 'mango') to narrow to one pet. Use `include` to project to specific collections (e.g. ['transfusions', 'medications', 'med_log'] for a clinical review). Use `since_iso` to limit log-style collections to entries after a given timestamp. Photos are stripped automatically. Returns structured data validated against the canonical schema.",
    risk: 'write_internal',
    required_capabilities: ['read_friday_pets'],
    input_schema: InputSchema,
    output_schema: OutputSchema,

    idempotency_key(input) {
      return (
        `read_friday_pets:` +
        `${input.pet_id ?? 'all'}:` +
        `${(input.include ?? []).slice().sort().join(',') || 'default'}:` +
        `${input.since_iso ?? 'all'}`
      );
    },

    async execute(input, ctx: ToolContext): Promise<Output> {
      // Pet medical records are household-shared (Sam helps care for
      // Bailey and Mango) but not friend-tier — donor logs and clinical
      // history shouldn't leak to external callers.
      require_caller_tier(ctx, ['owner', 'household']);

      const client = get_friday_client();
      const raw = await client.read_json('pets_data.json');

      const parsed = PetsDataSchema.safeParse(raw);
      if (!parsed.success) {
        throw new Error(
          `read_friday_pets: pets_data.json failed schema validation — ` +
            `the upstream FRIDAY schema may have drifted. Details: ` +
            parsed.error.message.slice(0, 400),
        );
      }
      const data: PetsData = parsed.data;

      let schema_warning: string | null = null;
      if (data._schema !== EXPECTED_PETS_SCHEMA_VERSION) {
        schema_warning =
          `pets_data.json declares schema "${data._schema}" but we built against ` +
          `"${EXPECTED_PETS_SCHEMA_VERSION}". Reading proceeded but newer fields ` +
          `may be silently dropped; verify the architecture doc and update the ` +
          `Zod schema.`;
      }

      // Defensive copy so we can mutate (strip photos, project, filter)
      // without poisoning the cache.
      const projected: Record<string, unknown> = {};
      const include_keys = input.include ?? DEFAULT_INCLUDE;
      for (const key of include_keys) {
        const val = (data as Record<string, unknown>)[key];
        if (val === undefined) continue;
        // Deep-ish copy: JSON round-trip is fine for this domain (no
        // circular refs, no Date objects we care about preserving).
        projected[key] = JSON.parse(JSON.stringify(val));
      }

      strip_photos({ pets: projected.pets as Record<string, unknown> });

      // Apply pet_id filter where each collection has a pet_id field.
      if (input.pet_id) {
        const pid = input.pet_id;
        if (projected.pets) {
          projected.pets = filter_dict_by_pet(
            projected.pets as Record<string, { pet_id?: string } & { id?: string }>,
            pid,
          );
          // Pets are keyed by id == pet_id, so also include the entry
          // directly if it exists (in case the dict's key conventions
          // ever shift).
          const pets_dict = data.pets;
          if (pets_dict && pets_dict[pid]) {
            (projected.pets as Record<string, unknown>)[pid] = JSON.parse(
              JSON.stringify({ ...pets_dict[pid], photo: undefined }),
            );
          }
        }
        for (const k of ['medications', 'flea_tick'] as const) {
          if (projected[k]) {
            projected[k] = filter_dict_by_pet(
              projected[k] as Record<string, { pet_id?: string }>,
              pid,
            );
          }
        }
        for (const k of [
          'feeding_log',
          'med_log',
          'transfusions',
          'blood_donations',
          'vet_appointments',
          'weight_log',
          'symptom_journal',
          'vaccinations',
        ] as const) {
          if (projected[k]) {
            projected[k] = filter_by_pet(
              projected[k] as Array<{ pet_id?: string }>,
              pid,
            );
          }
        }
      }

      // Apply since_iso filter to log collections.
      if (input.since_iso) {
        const since = input.since_iso;
        for (const k of [
          'feeding_log',
          'med_log',
          'transfusions',
          'blood_donations',
          'vet_appointments',
          'weight_log',
          'symptom_journal',
          'vaccinations',
        ] as const) {
          if (projected[k]) {
            projected[k] = filter_since(
              projected[k] as Array<{ date?: string; timestamp?: string; given_at?: string | null }>,
              since,
            );
          }
        }
      }

      return {
        schema_version: data._schema,
        schema_warning,
        updated_iso: data._updated ?? null,
        pet_filter: input.pet_id ?? null,
        since_iso: input.since_iso ?? null,
        data: projected,
      };
    },
  };
}

/** ToolLoader entry point. */
export function create(_deps: ToolDeps): Tool {
  return make_read_friday_pets() as Tool;
}
