/**
 * get_household_diets — read every household member's dietary profile
 * out of config/users.yaml.
 *
 * v0.5 is single-user (only Jasper talks to specialists), but Brigid plans
 * dinner for the whole table. Household members live as entries in
 * `config/users.yaml` with `allowed_specialists: []` and a `dietary:`
 * block; canonical members like Jasper have the same block. This tool
 * surfaces every member with a dietary record so Brigid's planner can
 * intersect across the table.
 *
 * Intersection rules when planning a week:
 *   - restrictions are UNIONED — any "no shellfish" on any member wins
 *   - dislikes   are UNIONED — same logic, Brigid avoids them
 *   - favorites  are reported as-is — used to break ties, not enforced
 *   - calorie    targets are per-person (NOT intersected) — each meal
 *                card surfaces `<name>: ~X cal (Yx)` per member
 *   - macro_priority for v0.5 biases toward the sender (Jasper). When
 *                two members disagree, Jasper wins.
 *
 * Read-only, no required_capabilities — every specialist can see who's
 * at the table. The capability gate is on writing the plan, not reading
 * the diets.
 */

import { z } from 'zod';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse as parse_yaml } from 'yaml';
import type { Tool, ToolContext } from '@core/tool';
import { UserConfigSchema, type DietaryProfile } from '@core/users';

/**
 * Resolved lazily on every call so tests (and a future runtime config
 * reload) can redirect via HEARTH_USERS_PATH without re-importing the
 * module. The lookup is cheap; correctness > microseconds.
 */
function users_path(): string {
  return resolve(process.env.HEARTH_USERS_PATH ?? './config/users.yaml');
}

// The sender for v0.5 single-user mode — whose macro_priority wins when
// members disagree. Lifts out cleanly when real multi-user lands.
const SENDER_ID = 'jasper';

const MacroTargetsBlock = z.object({
  protein_g: z.number().optional(),
  carbs_g: z.number().optional(),
  fat_g: z.number().optional(),
  fiber_g: z.number().optional(),
  net_carbs_g: z.number().optional(),
});

const DietBlock = z.object({
  daily_calorie_target: z.number().int().positive().nullable(),
  daily_calorie_max: z.number().int().positive().nullable(),
  macro_priority: z.enum(['balanced', 'protein_high', 'low_carb', 'mediterranean']),
  macro_targets: MacroTargetsBlock.optional(),
  restrictions: z.array(z.string()),
  favorites: z.array(z.string()),
  dislikes: z.array(z.string()),
  portion_factor: z.number().positive(),
});

const MemberSchema = z.object({
  id: z.string(),
  display_name: z.string(),
  is_sender: z.boolean().describe('True for the user whose macro_priority wins ties (v0.5 hardcoded to jasper).'),
  dietary: DietBlock,
});

const InputSchema = z.object({
  member_id: z
    .string()
    .max(80)
    .optional()
    .describe('Optional: scope to one member (e.g. "sam"). Omit to read every member with a dietary block.'),
});

const OutputSchema = z.object({
  members: z.array(MemberSchema),
  /**
   * Pre-computed intersection. `restrictions` and `dislikes` are
   * UNIONED across the table — any "no" wins. `favorites` is the union
   * (informational; not enforced). `macro_priority` is the sender's
   * pick (v0.5). `total_calorie_target` / `total_calorie_max` sum
   * per-person targets/ceilings so Brigid can describe the table's
   * daily envelope when useful.
   */
  intersection: z.object({
    restrictions: z.array(z.string()),
    dislikes: z.array(z.string()),
    favorites: z.array(z.string()),
    macro_priority: z.enum(['balanced', 'protein_high', 'low_carb', 'mediterranean']),
    total_calorie_target: z.number().int().nullable(),
    total_calorie_max: z.number().int().nullable(),
  }),
  source_path: z.string(),
  error: z.string().optional(),
});

type Input = z.infer<typeof InputSchema>;
type Output = z.infer<typeof OutputSchema>;

function default_diet(): DietaryProfile {
  return {
    daily_calorie_target: null,
    daily_calorie_max: null,
    macro_priority: 'balanced',
    restrictions: [],
    favorites: [],
    dislikes: [],
    portion_factor: 1.0,
  };
}

export const get_household_diets: Tool<Input, Output> = {
  name: 'get_household_diets',
  description:
    "Read every household member's dietary profile (daily_calorie_target, macro_priority, restrictions, favorites, dislikes, portion_factor) from config/users.yaml. Returns each member's block plus a pre-computed intersection — restrictions and dislikes are UNIONED (any 'no' wins), favorites is reported as the union (not enforced), macro_priority defaults to the sender's pick (jasper in v0.5), total_calorie_target sums per-person targets. Call this once per /plan turn before drafting; the intersection is what the draft must satisfy. Use the per-member daily_calorie_target × portion_factor to label each meal card with per-person calorie estimates. Pass `member_id` to scope to one person.",
  risk: 'read',
  required_capabilities: ['read_household_diets'],
  input_schema: InputSchema,
  output_schema: OutputSchema,

  idempotency_key(input) {
    return `get_household_diets:${input.member_id ?? '*'}`;
  },

  async execute(input, _ctx: ToolContext): Promise<Output> {
    const file_path = users_path();
    if (!existsSync(file_path)) {
      return {
        members: [],
        intersection: {
          restrictions: [],
          dislikes: [],
          favorites: [],
          macro_priority: 'balanced',
          total_calorie_target: null,
          total_calorie_max: null,
        },
        source_path: file_path,
        error: `users.yaml not found at ${file_path}`,
      };
    }
    let raw: unknown;
    try {
      raw = parse_yaml(readFileSync(file_path, 'utf8'));
    } catch (err) {
      return {
        members: [],
        intersection: {
          restrictions: [],
          dislikes: [],
          favorites: [],
          macro_priority: 'balanced',
          total_calorie_target: null,
          total_calorie_max: null,
        },
        source_path: file_path,
        error: `users.yaml parse failed: ${(err as Error).message}`,
      };
    }
    const file = (raw ?? {}) as { users?: unknown[] };
    const all = Array.isArray(file.users) ? file.users : [];

    const members: z.infer<typeof MemberSchema>[] = [];
    for (const u of all) {
      const parsed = UserConfigSchema.safeParse(u);
      if (!parsed.success) continue;
      const user = parsed.data;
      if (!user.dietary) continue;
      if (input.member_id && user.id !== input.member_id) continue;
      const diet = { ...default_diet(), ...user.dietary };
      members.push({
        id: user.id,
        display_name: user.display_name,
        is_sender: user.id === SENDER_ID,
        dietary: diet,
      });
    }

    const union = (key: 'restrictions' | 'favorites' | 'dislikes'): string[] => {
      const s = new Set<string>();
      for (const m of members) for (const v of m.dietary[key]) s.add(v);
      return Array.from(s).sort();
    };

    // Sender wins macro tie-breaks. If sender isn't present in the
    // filtered set (member_id scoped to someone else), fall back to
    // the first member, then to 'balanced'.
    const sender = members.find((m) => m.is_sender);
    const macro_priority =
      sender?.dietary.macro_priority ??
      members[0]?.dietary.macro_priority ??
      'balanced';

    const sum_field = (key: 'daily_calorie_target' | 'daily_calorie_max'): number | null => {
      const vals = members
        .map((m) => m.dietary[key])
        .filter((t): t is number => typeof t === 'number');
      return vals.length > 0 ? vals.reduce((a, b) => a + b, 0) : null;
    };

    return {
      members,
      intersection: {
        restrictions: union('restrictions'),
        dislikes: union('dislikes'),
        favorites: union('favorites'),
        macro_priority,
        total_calorie_target: sum_field('daily_calorie_target'),
        total_calorie_max: sum_field('daily_calorie_max'),
      },
      source_path: file_path,
    };
  },
};
