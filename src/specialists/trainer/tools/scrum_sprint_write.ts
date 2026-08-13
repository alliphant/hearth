/**
 * scrum_sprint_write — create / commit / close the weekly sprint.
 *
 * Single-open-sprint invariant lives in the store. `commit` is the blueprint's
 * "STOP and ask" gate: Beatrice never calls it directly from a deliberation
 * turn — she files a `scrum_decision` proposal whose `dispatch_tool` is this
 * tool with action='commit', so the owner's approval is what runs the commit.
 * It moves the committed epics into sprint_backlog (logging each transition).
 */

import { z } from 'zod';
import { createHash } from 'node:crypto';
import { ulid } from 'ulid';
import type { Tool, ToolContext } from '@core/tool';
import { require_caller_tier } from '@core/tool_gates';
import { ScrumStore } from '@memory/stores/scrum';

const InputSchema = z.object({
  action: z.enum(['create', 'commit', 'close']),
  /** create: e.g. "Sprint 2". */
  label: z.string().optional(),
  /** create: ISO YYYY-MM-DD. */
  start_date: z.string().optional(),
  end_date: z.string().optional(),
  capacity_pts: z.coerce.number().int().positive().max(50).optional(),
  /** commit: epic ids to commit to the open sprint. */
  epic_ids: z.array(z.string()).optional(),
  /** close: optional closing note. */
  notes: z.string().optional(),
});

const OutputSchema = z.object({
  sprint_id: z.string(),
  label: z.string(),
  action: z.string(),
  committed_count: z.number().optional(),
  closed: z.boolean().optional(),
});

type Input = z.infer<typeof InputSchema>;
type Output = z.infer<typeof OutputSchema>;

function db_of(ctx: ToolContext): import('bun:sqlite').Database {
  return (ctx.memory as unknown as { cfg: { db: import('bun:sqlite').Database } }).cfg.db;
}

export const scrum_sprint_write: Tool<Input, Output> = {
  name: 'scrum_sprint_write',
  description:
    "Manage the weekly sprint. action='create' (needs label + start_date + end_date, optional capacity_pts; refuses if one is already open); action='commit' (needs epic_ids — stamps them on the open sprint and moves them into sprint_backlog; NEVER call this directly from a deliberation turn — file a scrum_decision proposal with dispatch_tool='scrum_sprint_write' so the owner approves the commit); action='close' (closes the open sprint, optional notes). One sprint, one capacity pool.",
  risk: 'write_internal',
  required_capabilities: ['manage_scrum'],
  input_schema: InputSchema,
  output_schema: OutputSchema,

  idempotency_key(input) {
    const h = createHash('sha256');
    h.update(JSON.stringify(input));
    return `scrum_sprint_write:${h.digest('hex').slice(0, 16)}`;
  },

  async execute(input, ctx: ToolContext): Promise<Output> {
    require_caller_tier(ctx, ['owner']);
    const store = new ScrumStore(db_of(ctx));
    const actor = ctx.specialist_id ?? 'beatrice';

    let result: Output;
    if (input.action === 'create') {
      if (!input.label || !input.start_date || !input.end_date) {
        throw new Error('create needs label, start_date, and end_date (ISO YYYY-MM-DD).');
      }
      const s = store.create_sprint({
        label: input.label,
        start_date: input.start_date,
        end_date: input.end_date,
        capacity_pts: input.capacity_pts,
      });
      result = { sprint_id: s.id, label: s.label, action: 'create' };
    } else if (input.action === 'commit') {
      if (!input.epic_ids || input.epic_ids.length === 0) {
        throw new Error('commit needs a non-empty epic_ids list.');
      }
      const s = store.commit_sprint(input.epic_ids, actor);
      result = {
        sprint_id: s.id,
        label: s.label,
        action: 'commit',
        committed_count: s.committed_ids.length,
      };
    } else {
      const s = store.close_sprint(input.notes ?? null, actor);
      result = { sprint_id: s.id, label: s.label, action: 'close', closed: true };
    }

    ctx.memory.log_action({
      intent_id: ctx.intent_id || ulid(),
      agent: actor,
      tool_name: 'scrum_sprint_write',
      tool_input: { action: input.action, label: input.label, epics: input.epic_ids?.length },
      execution_result: { sprint_id: result.sprint_id },
    });

    return result;
  },
};
