/**
 * update_household_diet — write back to a household member's dietary
 * block in config/users.yaml.
 *
 * The chat-driven counterpart to `get_household_diets`. When Jasper tells
 * Brigid "Sam wants 1650 cal max and 80g protein," she calls this tool
 * with `{ member_id: 'sam', daily_calorie_max: 1650, macro_targets:
 * { protein_g: 80 } }`. The user-facing structured-data store
 * (`config/users.yaml`) is the source of truth — chat updates go there,
 * not into memory.md drift.
 *
 * Capability: `write_household_diets`. Brigid alone holds it — no other
 * specialist may rewrite the household roster. The orchestrator's
 * UserRegistry doesn't watch users.yaml today, so changes take effect
 * for `get_household_diets` (which reads disk on every call) but won't
 * propagate to in-memory consumers like the relay's quiet-hours lookup
 * until restart. That's fine for v0.5 — dietary fields aren't read by
 * those consumers; they're read by Brigid's planning tools, which all
 * go through disk.
 *
 * YAML writes use the `yaml` package's Document API (parseDocument →
 * mutate → toString) so existing comments and field order survive a
 * round-trip. The user-facing PLACEHOLDER comment on Sam's record is
 * preserved on first write; you remove it manually when Jasper has
 * confirmed the values.
 *
 * Semantics:
 *   - scalar fields (calorie targets, macro_priority, portion_factor,
 *     macro_targets sub-fields) — pass to overwrite, omit to leave alone,
 *     pass `null` to clear (for nullable fields). `macro_targets` is a
 *     partial MERGE: omitted sub-fields stay; passed sub-fields overwrite.
 *   - array fields (restrictions, favorites, dislikes) — use explicit
 *     `add_*` / `remove_*` arrays. Set semantics — duplicates de-duped on
 *     add, missing entries on remove are silently ignored. No `replace_*`
 *     yet; if you need it, edit the YAML by hand.
 *
 * Audit: every call writes a structured row with the before/after delta
 * so the audit log shows what changed and why.
 */

import { z } from 'zod';
import { createHash } from 'node:crypto';
import { ulid } from 'ulid';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseDocument, isMap, isSeq } from 'yaml';
import type { Document, YAMLMap, YAMLSeq } from 'yaml';
import type { Tool, ToolContext } from '@core/tool';
import {
  DietaryProfileSchema,
  UserConfigSchema,
  type DietaryProfile,
} from '@core/users';

function users_path(): string {
  return resolve(process.env.HEARTH_USERS_PATH ?? './config/users.yaml');
}

const MacroPriorityEnum = z.enum(['balanced', 'protein_high', 'low_carb', 'mediterranean']);

const MacroTargetsPatchSchema = z
  .object({
    protein_g: z.number().nonnegative().nullable().optional(),
    carbs_g: z.number().nonnegative().nullable().optional(),
    fat_g: z.number().nonnegative().nullable().optional(),
    fiber_g: z.number().nonnegative().nullable().optional(),
    net_carbs_g: z.number().nonnegative().nullable().optional(),
  })
  .strict();

const InputSchema = z.object({
  member_id: z
    .string()
    .min(1)
    .max(80)
    .describe('Lowercase id of the household member whose dietary block to update (e.g. "sam", "jasper"). Must already exist in users.yaml.'),

  daily_calorie_target: z
    .number()
    .int()
    .positive()
    .nullable()
    .optional()
    .describe('Daily calorie AIM. Pass null to clear; omit to leave alone. Usually ≤ daily_calorie_max.'),
  daily_calorie_max: z
    .number()
    .int()
    .positive()
    .nullable()
    .optional()
    .describe('Daily calorie CEILING — Brigid will not plan a day above this. Pass null to clear; omit to leave alone.'),
  macro_priority: MacroPriorityEnum.optional().describe(
    "Soft macro direction: balanced | protein_high | low_carb | mediterranean. Omit to leave alone.",
  ),
  macro_targets: MacroTargetsPatchSchema.optional().describe(
    "Gram-level macro targets. Partial merge — fields you pass overwrite, omitted fields stay. Pass null on a sub-field to clear it. To clear the entire block, pass `clear_macro_targets: true`.",
  ),
  clear_macro_targets: z
    .boolean()
    .optional()
    .describe('When true, delete the entire macro_targets block (resetting to the macro_priority enum). Use sparingly.'),
  portion_factor: z
    .number()
    .positive()
    .max(5)
    .optional()
    .describe("Multiplier on per-meal calories for this member (e.g. 1.4 for a larger eater). Default 1.0."),

  add_restrictions: z.array(z.string().min(1)).optional().describe('Restrictions to add (de-duped against existing). Each is a short phrase like "shellfish" or "no_pork".'),
  remove_restrictions: z.array(z.string().min(1)).optional().describe('Restrictions to remove. Missing entries are silently ignored.'),
  add_favorites: z.array(z.string().min(1)).optional().describe('Favorites to add (de-duped). Short tags like "vegetable-forward" or "spicy".'),
  remove_favorites: z.array(z.string().min(1)).optional().describe('Favorites to remove.'),
  add_dislikes: z.array(z.string().min(1)).optional().describe('Dislikes to add (de-duped).'),
  remove_dislikes: z.array(z.string().min(1)).optional().describe('Dislikes to remove.'),

  reason: z
    .string()
    .max(400)
    .optional()
    .describe("One-line note recorded in the audit log — why the change. E.g. 'Jasper confirmed Sam's values 2026-05-23.'"),
});

const OutputSchema = z.object({
  member_id: z.string(),
  source_path: z.string(),
  changed: z.boolean().describe('True if any field actually changed; false on a no-op call.'),
  before: DietaryProfileSchema.nullable(),
  after: DietaryProfileSchema,
  diff_summary: z.array(z.string()).describe('Human-readable one-liners per field that changed.'),
});

type Input = z.infer<typeof InputSchema>;
type Output = z.infer<typeof OutputSchema>;

function find_member_map(doc: Document, member_id: string): { users: YAMLSeq; index: number; node: YAMLMap } | null {
  const users = doc.get('users');
  if (!isSeq(users)) return null;
  for (let i = 0; i < users.items.length; i++) {
    const item = users.items[i];
    if (!isMap(item)) continue;
    const id = item.get('id');
    if (id === member_id) return { users, index: i, node: item };
  }
  return null;
}

function uniq_add(existing: string[], add: string[]): string[] {
  const set = new Set(existing);
  for (const v of add) set.add(v);
  return Array.from(set);
}

function array_remove(existing: string[], remove: string[]): string[] {
  const drop = new Set(remove);
  return existing.filter((v) => !drop.has(v));
}

function dump_diet(node: YAMLMap | null): DietaryProfile | null {
  if (!node) return null;
  const raw = node.toJSON() as unknown;
  const parsed = DietaryProfileSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

function set_or_clear(diet: YAMLMap, key: string, value: number | string | null): void {
  if (value === null) {
    diet.set(key, null);
  } else {
    diet.set(key, value);
  }
}

export const update_household_diet: Tool<Input, Output> = {
  name: 'update_household_diet',
  description:
    "Write back to a household member's `dietary:` block in config/users.yaml. Scalar fields (calorie targets, macro_priority, portion_factor, macro_targets) overwrite when passed; omit to leave alone; pass null to clear nullable fields. `macro_targets` is a PARTIAL MERGE — fields you pass overwrite, omitted sub-fields stay. Array fields use explicit `add_*` / `remove_*` (set semantics, de-duped). Use this when Jasper confirms a target or volunteers a preference in chat — the structured source of truth lives in users.yaml, not in memory.md. Pass a one-line `reason` so the audit log explains the change.",
  risk: 'write_internal',
  required_capabilities: ['write_household_diets'],
  input_schema: InputSchema,
  output_schema: OutputSchema,

  idempotency_key(input) {
    const h = createHash('sha256');
    h.update(input.member_id);
    h.update('\n');
    h.update(JSON.stringify(input, Object.keys(input).sort()));
    return `update_household_diet:${h.digest('hex').slice(0, 16)}`;
  },

  async execute(input, ctx: ToolContext): Promise<Output> {
    const file_path = users_path();
    if (!existsSync(file_path)) {
      throw new Error(`users.yaml not found at ${file_path}`);
    }
    const text = readFileSync(file_path, 'utf8');
    const doc = parseDocument(text);
    const found = find_member_map(doc, input.member_id);
    if (!found) {
      throw new Error(
        `update_household_diet: no user with id="${input.member_id}" in ${file_path}.`,
      );
    }

    // Validate the parent user record before mutating — catches a malformed
    // user record early so we don't write a YAML that won't parse on reload.
    const user_check = UserConfigSchema.safeParse(found.node.toJSON());
    if (!user_check.success) {
      throw new Error(
        `update_household_diet: existing user record for "${input.member_id}" fails schema before edit: ${user_check.error.message}`,
      );
    }

    // Ensure a `dietary:` map exists.
    let diet = found.node.get('dietary');
    if (!isMap(diet)) {
      found.node.set('dietary', {});
      diet = found.node.get('dietary') as YAMLMap;
    }

    const before: DietaryProfile | null = dump_diet(diet as YAMLMap);

    // Scalar updates.
    if (input.daily_calorie_target !== undefined) {
      set_or_clear(diet as YAMLMap, 'daily_calorie_target', input.daily_calorie_target);
    }
    if (input.daily_calorie_max !== undefined) {
      set_or_clear(diet as YAMLMap, 'daily_calorie_max', input.daily_calorie_max);
    }
    if (input.macro_priority !== undefined) {
      (diet as YAMLMap).set('macro_priority', input.macro_priority);
    }
    if (input.portion_factor !== undefined) {
      (diet as YAMLMap).set('portion_factor', input.portion_factor);
    }

    // Macro targets — clear or partial-merge.
    if (input.clear_macro_targets === true) {
      (diet as YAMLMap).delete('macro_targets');
    } else if (input.macro_targets) {
      let mt = (diet as YAMLMap).get('macro_targets');
      if (!isMap(mt)) {
        (diet as YAMLMap).set('macro_targets', {});
        mt = (diet as YAMLMap).get('macro_targets') as YAMLMap;
      }
      const patch = input.macro_targets;
      for (const key of ['protein_g', 'carbs_g', 'fat_g', 'fiber_g', 'net_carbs_g'] as const) {
        if (patch[key] !== undefined) {
          if (patch[key] === null) (mt as YAMLMap).delete(key);
          else (mt as YAMLMap).set(key, patch[key]);
        }
      }
      // If the patch left macro_targets empty, drop the empty block.
      if ((mt as YAMLMap).items.length === 0) {
        (diet as YAMLMap).delete('macro_targets');
      }
    }

    // Array updates.
    const apply_array = (key: 'restrictions' | 'favorites' | 'dislikes'): void => {
      const add_key = `add_${key}` as const;
      const rem_key = `remove_${key}` as const;
      const add = (input as Record<string, unknown>)[add_key] as string[] | undefined;
      const rem = (input as Record<string, unknown>)[rem_key] as string[] | undefined;
      if (!add && !rem) return;
      const current_raw = (diet as YAMLMap).get(key);
      const current = isSeq(current_raw)
        ? ((current_raw.toJSON() as unknown[]).filter((v): v is string => typeof v === 'string'))
        : [];
      let next = current;
      if (add && add.length > 0) next = uniq_add(next, add);
      if (rem && rem.length > 0) next = array_remove(next, rem);
      (diet as YAMLMap).set(key, next);
    };
    apply_array('restrictions');
    apply_array('favorites');
    apply_array('dislikes');

    // Validate the post-edit record before writing — catches a typo that
    // would have produced an unparseable file at next reload.
    const after_check = UserConfigSchema.safeParse(found.node.toJSON());
    if (!after_check.success) {
      throw new Error(
        `update_household_diet: post-edit record for "${input.member_id}" fails schema: ${after_check.error.message}`,
      );
    }
    const after = dump_diet(diet as YAMLMap);
    if (!after) {
      throw new Error(`update_household_diet: dietary block failed to re-parse after edit`);
    }

    // Compute a human-readable diff.
    const diff_summary: string[] = [];
    const before_safe = before ?? ({} as Partial<DietaryProfile>);
    for (const k of [
      'daily_calorie_target',
      'daily_calorie_max',
      'macro_priority',
      'portion_factor',
    ] as const) {
      if (JSON.stringify(before_safe[k]) !== JSON.stringify(after[k])) {
        diff_summary.push(`${k}: ${JSON.stringify(before_safe[k])} → ${JSON.stringify(after[k])}`);
      }
    }
    if (JSON.stringify(before_safe.macro_targets ?? {}) !== JSON.stringify(after.macro_targets ?? {})) {
      diff_summary.push(`macro_targets: ${JSON.stringify(before_safe.macro_targets ?? null)} → ${JSON.stringify(after.macro_targets ?? null)}`);
    }
    for (const k of ['restrictions', 'favorites', 'dislikes'] as const) {
      const b = (before_safe[k] ?? []) as string[];
      const a = after[k];
      const added = a.filter((v) => !b.includes(v));
      const removed = b.filter((v) => !a.includes(v));
      if (added.length > 0) diff_summary.push(`${k} +: ${added.join(', ')}`);
      if (removed.length > 0) diff_summary.push(`${k} -: ${removed.join(', ')}`);
    }

    const changed = diff_summary.length > 0;
    if (changed) {
      writeFileSync(file_path, doc.toString(), 'utf8');
    }

    ctx.memory.log_action({
      intent_id: ctx.intent_id || ulid(),
      agent: ctx.specialist_id ?? 'brigid',
      tool_name: 'update_household_diet',
      tool_input: {
        member_id: input.member_id,
        reason: input.reason,
        diff: diff_summary,
      },
      execution_result: { changed, after },
    });

    return {
      member_id: input.member_id,
      source_path: file_path,
      changed,
      before,
      after,
      diff_summary,
    };
  },
};
