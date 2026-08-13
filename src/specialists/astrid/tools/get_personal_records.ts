/**
 * get_personal_records — Astrid's read into the PR shelf.
 *
 * Reads users/<user_id>/astrid/records/<workout-type>.md and returns
 * the parsed PR record set. Returns nulls cleanly for metrics that
 * don't apply (distance is null for strength sessions) or for
 * never-recorded workout types (Astrid then says "this is the first
 * X I've watched you do").
 *
 * Used by Astrid mid-workout to decide whether the current session
 * is in PR-in-reach territory ("you're at 920 kcal with 12 min left;
 * your record is 935 — push and you've got it"). Also used post-
 * workout to acknowledge a beaten record in the coaching note.
 *
 * Capability: read_health. Per-user — never crosses users.
 */

import { z } from 'zod';
import { createHash } from 'node:crypto';
import type { Tool, ToolContext } from '@core/tool';
import type { ToolDeps } from '@core/tool_deps';
import { read_shelf, type PRRecord } from '../pr_shelf';

const InputSchema = z.object({
  user_id: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Omit — defaults to the conversation's user (resolved from context). Only set it to read another household member's shelf.",
    ),
  workout_type: z
    .string()
    .min(1)
    .max(80)
    .describe(
      'The workout type (snake_case) — cycling, running, hiit, strength_traditional, yoga, etc. Use the same string the WorkoutValueSchema carries on the workout sample.',
    ),
});

const PRRecordSchema = z.object({
  value: z.number(),
  date: z.string(),
  prior_value: z.number().nullable(),
  prior_date: z.string().nullable(),
});

const OutputSchema = z.object({
  user_id: z.string(),
  workout_type: z.string(),
  has_records: z.boolean(),
  longest_seconds: PRRecordSchema.nullable(),
  longest_distance_m: PRRecordSchema.nullable(),
  highest_active_kcal: PRRecordSchema.nullable(),
});

type Input = z.infer<typeof InputSchema>;
type Output = z.infer<typeof OutputSchema>;

function record_or_null(r: PRRecord | null): z.infer<typeof PRRecordSchema> | null {
  return r;
}

export function create(deps: ToolDeps): Tool<Input, Output> {
  return {
    name: 'get_personal_records',
    description:
      "Read the user's PR shelf for a given workout type. Returns longest session, longest distance, and highest active calories — each with the prior record so Astrid can say 'you beat your X by N'. Returns has_records=false when no shelf exists yet (this is the first session of this type Astrid has watched).",
    risk: 'read',
    required_capabilities: ['read_health'],
    input_schema: InputSchema,
    output_schema: OutputSchema,

    idempotency_key(input) {
      const h = createHash('sha256');
      h.update(input.user_id ?? '');
      h.update('\n');
      h.update(input.workout_type);
      return `get_personal_records:${h.digest('hex').slice(0, 16)}`;
    },

    async execute(input, ctx: ToolContext): Promise<Output> {
      // user_id is ambient (the conversation's user), not model-supplied.
      const user_id = input.user_id ?? ctx.user?.id;
      if (!user_id) {
        throw new Error('get_personal_records: no user on ToolContext and no user_id override.');
      }
      const shelf = read_shelf(deps.vault_root, user_id, input.workout_type);
      if (!shelf) {
        return {
          user_id,
          workout_type: input.workout_type,
          has_records: false,
          longest_seconds: null,
          longest_distance_m: null,
          highest_active_kcal: null,
        };
      }
      return {
        user_id,
        workout_type: input.workout_type,
        has_records:
          shelf.longest_seconds != null ||
          shelf.longest_distance_m != null ||
          shelf.highest_active_kcal != null,
        longest_seconds: record_or_null(shelf.longest_seconds),
        longest_distance_m: record_or_null(shelf.longest_distance_m),
        highest_active_kcal: record_or_null(shelf.highest_active_kcal),
      };
    },
  };
}
