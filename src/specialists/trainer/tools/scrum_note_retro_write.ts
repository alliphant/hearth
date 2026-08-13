/**
 * scrum_note_retro_write — capture a board note (FYI / progress / observation)
 * or a sprint retro. Light write tool, kept separate from epic/sprint mutation
 * so the high-traffic write surface stays small.
 */

import { z } from 'zod';
import { createHash } from 'node:crypto';
import { ulid } from 'ulid';
import type { Tool, ToolContext } from '@core/tool';
import { require_caller_tier } from '@core/tool_gates';
import { ScrumStore } from '@memory/stores/scrum';

const InputSchema = z.object({
  kind: z.enum(['note', 'retro']),
  /** note: optional project slug to pin the note to. */
  project_slug: z.string().optional(),
  /** note: the body. */
  body: z.string().optional(),
  /** note: classification. */
  note_kind: z.enum(['fyi', 'progress', 'observation']).optional(),
  pinned: z.coerce.boolean().optional(),
  /** retro: free-text fields captured verbatim. */
  went_well: z.string().optional(),
  slipped: z.string().optional(),
  lessons: z.string().optional(),
  /** retro: target sprint id (defaults to the open sprint). */
  sprint_id: z.string().optional(),
});

const OutputSchema = z.object({ ok: z.boolean(), kind: z.string() });

type Input = z.infer<typeof InputSchema>;
type Output = z.infer<typeof OutputSchema>;

function db_of(ctx: ToolContext): import('bun:sqlite').Database {
  return (ctx.memory as unknown as { cfg: { db: import('bun:sqlite').Database } }).cfg.db;
}

export const scrum_note_retro_write: Tool<Input, Output> = {
  name: 'scrum_note_retro_write',
  description:
    "Capture a board note or a sprint retro. kind='note' (needs body; optional project_slug, note_kind fyi|progress|observation, pinned) — lightweight FYIs/progress shown on the board. kind='retro' (went_well / slipped / lessons captured verbatim against the open sprint, or a given sprint_id) — run it at sprint close.",
  risk: 'write_internal',
  required_capabilities: ['manage_scrum'],
  input_schema: InputSchema,
  output_schema: OutputSchema,

  idempotency_key(input) {
    const h = createHash('sha256');
    h.update(JSON.stringify(input));
    return `scrum_note_retro_write:${h.digest('hex').slice(0, 16)}`;
  },

  async execute(input, ctx: ToolContext): Promise<Output> {
    require_caller_tier(ctx, ['owner']);
    const store = new ScrumStore(db_of(ctx));

    if (input.kind === 'note') {
      if (!input.body) throw new Error('note needs a body.');
      const project = input.project_slug ? store.project_by_slug(input.project_slug) : null;
      store.add_note({
        project_id: project?.id ?? null,
        body: input.body,
        kind: input.note_kind ?? 'fyi',
        pinned: input.pinned ?? false,
      });
    } else {
      store.add_retro({
        sprint_id: input.sprint_id ?? null,
        went_well: input.went_well ?? null,
        slipped: input.slipped ?? null,
        lessons: input.lessons ?? null,
      });
    }

    ctx.memory.log_action({
      intent_id: ctx.intent_id || ulid(),
      agent: ctx.specialist_id ?? 'trainer',
      tool_name: 'scrum_note_retro_write',
      tool_input: { kind: input.kind },
      execution_result: { ok: true },
    });

    return { ok: true, kind: input.kind };
  },
};
