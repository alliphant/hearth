/**
 * update_user_profile — Kate's per-user onboarding + profile writer (2026-06-15).
 *
 * The generalized, multi-user-correct sibling of Astrid's update_astrid_vault:
 * where Astrid's per-user paths hardcode `users/jasper/`, this resolves the
 * target user from `ctx.user.id` (the conversation's speaker) and stamps every
 * note `private_to: <user_id>` — so Kate's onboarding of Sam writes SAM's
 * profile, visible only to Sam (the owner has no god-view; cordon holds).
 *
 * It does four things, any combination in one call (flat schema — no
 * required-conditional fields, so the small model never arg-spirals):
 *   - `facets`         → set the user's active facets (+ optional detail). This
 *                        is what makes their brief/persona drop what isn't
 *                        theirs (no EV block for a user without the `ev` facet).
 *   - `profile_md`     → overwrite the narrative profile note.
 *   - `note`           → append one durable fact to the profile note.
 *   - `seed_*`         → seed another specialist with what they should know
 *                        about this user (Kate orchestrates; the rest start
 *                        knowing them). Writes users/<id>/<specialist>/profile.md.
 *   - `complete`       → mark onboarding finished (the setup prompt stops
 *                        showing).
 *
 * Capability: write_user_profile. Granted to Kate (the onboarding orchestrator).
 */
import { z } from 'zod';
import { createHash } from 'node:crypto';
import { ulid } from 'ulid';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import matter from 'gray-matter';
import type { Tool, ToolContext } from '@core/tool';
import { stamp_private_to_if_needed, type Caller } from '@memory/private_to';
import { KNOWN_FACETS } from '@memory/stores/user_profile';

const InputSchema = z.object({
  facets: z
    .array(z.string())
    .optional()
    .describe(
      `The user's active facets — ONLY what applies to THEM. Known facets: ${KNOWN_FACETS.join(', ')}. ` +
        `Replaces their current facet set (weather + calendar are always on regardless). ` +
        `Omit a facet they don't have — that's what keeps it out of their brief.`,
    ),
  detail: z
    .record(z.unknown())
    .optional()
    .describe(
      'Optional per-facet detail to remember, e.g. {"primary_vehicle":"Honda Civic","pet_names":"Rex and Bella","partner_name":"Alex","interests":["hiking","jazz"]}. Merged over any existing detail.',
    ),
  profile_md: z
    .string()
    .max(10_000)
    .optional()
    .describe(
      "A short narrative profile of the user (overwrites the prior narrative). Use once you have the picture of who they are and what they want.",
    ),
  note: z
    .string()
    .max(2_000)
    .optional()
    .describe('Append one durable, dated fact about the user to their profile note.'),
  seed_specialist_id: z
    .string()
    .optional()
    .describe(
      'To seed another specialist with what they should know about this user, the specialist id (pair with seed_body).',
    ),
  seed_body: z
    .string()
    .max(4_000)
    .optional()
    .describe('What that specialist should know about this user (pair with seed_specialist_id).'),
  complete: z
    .boolean()
    .optional()
    .describe(
      'Set true when onboarding is finished — marks the user onboarded so the first-time setup prompt stops showing.',
    ),
});

const OutputSchema = z.object({
  user_id: z.string(),
  updated: z.array(z.string()),
  onboarded: z.boolean(),
  facets: z.array(z.string()),
});

type Input = z.infer<typeof InputSchema>;
type Output = z.infer<typeof OutputSchema>;

export function make_update_user_profile(vault_root: string): Tool<Input, Output> {
  return {
    name: 'update_user_profile',
    description:
      "Record what you've learned about the CURRENT user (onboarding + ongoing). " +
      'Set their `facets` (the parts of life that are theirs — only include what applies, e.g. ev, pets, garden, finance), ' +
      'optional `detail` (their own vehicle/pets/etc.), a `profile_md` narrative or a one-line `note`, ' +
      'and `seed_specialist_id`+`seed_body` to brief another specialist about them. ' +
      'Pass `complete:true` when onboarding is done. Writes are private to this user.',
    risk: 'write_internal',
    required_capabilities: ['write_user_profile'],
    input_schema: InputSchema,
    output_schema: OutputSchema,

    idempotency_key(input) {
      const h = createHash('sha256');
      h.update(JSON.stringify(input.facets ?? []));
      h.update('\n');
      h.update(JSON.stringify(input.detail ?? {}));
      h.update('\n');
      h.update(input.profile_md ?? '');
      h.update('\n');
      h.update(input.note ?? '');
      h.update('\n');
      h.update(`${input.seed_specialist_id ?? ''}:${input.seed_body ?? ''}`);
      h.update('\n');
      h.update(String(input.complete ?? false));
      return `update_user_profile:${h.digest('hex').slice(0, 16)}`;
    },

    async execute(input, ctx: ToolContext): Promise<Output> {
      // User-scoped: the target is the conversation's speaker, never a model
      // arg. Absent ctx.user means a system context that shouldn't be writing a
      // personal profile — reject loudly rather than mis-stamp.
      const user_id = ctx.user?.id;
      if (!user_id) {
        throw new Error(
          'update_user_profile: no user in context — this tool writes the CURRENT user’s profile and must be called within a user conversation.',
        );
      }
      const caller: Caller = { user_id, tier: ctx.user!.tier };
      const ts = (ctx.now ?? new Date()).toISOString();
      const updated: string[] = [];

      // 1. Facets (+ detail). The structured signal the brief/persona read.
      if (input.facets !== undefined || input.detail !== undefined) {
        const current = ctx.memory.user_profiles.get(user_id);
        const facets = input.facets ?? current?.facets ?? [];
        ctx.memory.user_profiles.set_facets(user_id, facets, input.detail);
        updated.push('facets');
      }

      // 2/3. Narrative profile note (overwrite) and/or appended fact — same
      // file, always stamped private_to the user so it never leaks cross-user.
      if (input.profile_md !== undefined || input.note !== undefined) {
        write_profile_note(ctx, vault_root, user_id, caller, ts, {
          overwrite: input.profile_md,
          append_bullet: input.note,
        });
        if (input.profile_md !== undefined) updated.push('profile');
        if (input.note !== undefined) updated.push('note');
      }

      // 4. Per-specialist seed — Kate orchestrates; the specialist starts
      // knowing the user. Same per-user, private_to cordon.
      if (input.seed_specialist_id && input.seed_body) {
        const rel = `users/${user_id}/${input.seed_specialist_id}/profile.md`;
        const fm = stamp_private_to_if_needed(
          { type: 'user_profile', user_id, for_specialist: input.seed_specialist_id, updated: ts },
          caller,
        );
        ctx.memory.upsert_note(
          rel,
          fm,
          `# What ${input.seed_specialist_id} should know about ${user_id}\n\n_Seeded ${ts} by Kate._\n\n${input.seed_body.trim()}\n`,
        );
        updated.push(`seed:${input.seed_specialist_id}`);
      }

      // 5. Onboarding completion.
      if (input.complete) {
        ctx.memory.user_profiles.mark_onboarded(user_id);
        updated.push('onboarded');
      }

      const final = ctx.memory.user_profiles.get(user_id);
      ctx.memory.log_action({
        intent_id: ctx.intent_id || ulid(),
        agent: ctx.specialist_id ?? 'kate',
        tool_name: 'update_user_profile',
        tool_input: {
          // Audit the SHAPE, not the personal content — facet names + which
          // ops ran. The narrative lives in the private_to-stamped note.
          target_user: user_id,
          facets: input.facets,
          updated,
          complete: Boolean(input.complete),
        },
        execution_result: { updated, onboarded: Boolean(final?.onboarded_at) },
        user_id,
      });

      return {
        user_id,
        updated,
        onboarded: Boolean(final?.onboarded_at),
        facets: final?.facets ?? [],
      };
    },
  };
}

/**
 * Read-modify-write the user's narrative profile note with a stamped
 * frontmatter. Avoids `append_to_note` (which writes empty frontmatter → no
 * private_to stamp → cordon leak); always re-upserts with the private_to stamp.
 */
function write_profile_note(
  ctx: ToolContext,
  vault_root: string,
  user_id: string,
  caller: Caller,
  ts: string,
  opts: { overwrite?: string; append_bullet?: string },
): void {
  const rel = `users/${user_id}/profile.md`;
  const abs = resolve(vault_root, rel);
  let body = '';
  if (existsSync(abs)) {
    try {
      body = matter(readFileSync(abs, 'utf8')).content;
    } catch {
      body = '';
    }
  }
  if (opts.overwrite !== undefined) {
    body = `# ${user_id}'s profile\n\n_Updated ${ts} by Kate._\n\n${opts.overwrite.trim()}\n`;
  }
  if (opts.append_bullet) {
    if (!body.trim()) body = `# ${user_id}'s profile\n`;
    body = `${body.trimEnd()}\n\n- ${ts}: ${opts.append_bullet.trim()}\n`;
  }
  const fm = stamp_private_to_if_needed({ type: 'user_profile', user_id, updated: ts }, caller);
  ctx.memory.upsert_note(rel, fm, body);
}
