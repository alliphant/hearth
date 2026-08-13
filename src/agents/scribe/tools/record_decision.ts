import { z } from 'zod';
import { createHash, randomBytes } from 'node:crypto';
import type { Tool, ToolContext } from '@core/tool';
import { DecisionFrontmatter } from '@memory/schemas/decision';
import { stamp_private_to_if_needed } from '@memory/private_to';
import { local_iso_date } from '@core/time';

const InputSchema = z.object({
  // NOTE: no `.regex()` — a tool input_schema becomes a GBNF grammar on the
  // interactive 9B, and llama.cpp's converter mistranslates a regex `pattern`
  // and SILENTLY disables the whole tool grammar. The YYYY-MM-DD shape is
  // validated in execute() instead (the output `id` regex below is fine — an
  // output_schema never feeds the grammar).
  date: z.string().optional().describe('YYYY-MM-DD; defaults to today.'),
  domain: z.string().min(1),
  options_considered: z.array(z.string()).min(1),
  chosen: z.string().min(1),
  rationale: z.string().min(1),
  reversible: z.boolean(),
  related: z.array(z.string()).default([]),
  body: z.string().optional(),
});

const OutputSchema = z.object({
  id: z.string().regex(/^d_[a-z0-9]{6}$/),
  note_path: z.string(),
});

type Input = z.infer<typeof InputSchema>;
type Output = z.infer<typeof OutputSchema>;

const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

function generate_decision_id(): string {
  const bytes = randomBytes(6);
  let id = '';
  for (const b of bytes) id += ID_ALPHABET[b % 36];
  return `d_${id}`;
}

function slugify(s: string): string {
  const slug = s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9 _-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 60);
  return slug || 'decision';
}

export const record_decision: Tool<Input, Output> = {
  name: 'record_decision',
  description:
    'Record a decision with options considered, what was chosen, and rationale. Writes Decisions/<date>-<slug>.md with DecisionFrontmatter.',
  risk: 'write_internal',
  // Specialist invocation path requires the capability; Scribe's
  // /scribe/* HTTP route bypasses the registry and ignores this field.
  required_capabilities: ['write_vault_general'],
  input_schema: InputSchema,
  output_schema: OutputSchema,

  idempotency_key(input) {
    const h = createHash('sha256');
    h.update(input.date ?? '');
    h.update('\n');
    h.update(input.domain);
    h.update('\n');
    h.update(input.chosen);
    return `record_decision:${h.digest('hex').slice(0, 16)}`;
  },

  async execute(input, ctx): Promise<Output> {
    if (input.date && !/^\d{4}-\d{2}-\d{2}$/.test(input.date)) {
      throw new Error(`date must be YYYY-MM-DD; got "${input.date}".`);
    }
    const date = input.date ?? local_iso_date(ctx.now, ctx.user?.timezone);
    const id = generate_decision_id();
    const note_path = `Decisions/${date}-${slugify(input.chosen)}.md`;

    const fm = DecisionFrontmatter.parse({
      type: 'decision',
      id,
      date,
      domain: input.domain,
      options_considered: input.options_considered,
      chosen: input.chosen,
      rationale: input.rationale,
      reversible: input.reversible,
      related: input.related,
    });

    // Phase 2b/4 — decisions are unique-id per record (`d_xxxxxx`), so
    // each row is independently scopable. Non-owner-recorded decisions
    // stamp `private_to: <user_id>` so a household member's decision
    // log stays theirs; the owner's decisions remain broadly visible.
    const stamped = stamp_private_to_if_needed(
      fm as unknown as Record<string, unknown>,
      ctx.user ? { user_id: ctx.user.id, tier: ctx.user.tier } : undefined,
    );

    ctx.memory.upsert_note(note_path, stamped, input.body ?? '');

    return { id, note_path };
  },
};
