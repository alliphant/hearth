/**
 * write_standup_snapshot — the `daily_standup` scrum ceremony.
 *
 * Appends a dated board-state snapshot to Beatrice's vault standup log
 * (Knowledge/Trainer/standup-log.md), so there's a durable daily record of
 * where the board stood — the "standup" half of the scrum ceremonies (grooming
 * + retro already run in her deliberation passes). Deterministic (no LLM): it
 * RENDERS the board, it doesn't reason about it. Idempotent per local day —
 * re-running the same day is a no-op (today's entry is already logged), so a
 * manual re-fire or a restart can't double-write. Driven by the `daily_standup`
 * background job in trainer.yaml; capability-gated by `manage_scrum`. The log is
 * an untyped vault note (like memory.md / the audit markdown), so the ingestor
 * skips it silently — it's a record to read, not a note to project.
 */

import { z } from 'zod';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ulid } from 'ulid';
import type { Tool, ToolContext } from '@core/tool';
import { ScrumStore } from '@memory/stores/scrum';
import { render_standup_entry_md } from '@core/scrum_render';
import { local_iso_date } from '@core/time';

const STANDUP_LOG = 'Knowledge/Trainer/standup-log.md';

const InputSchema = z.object({}).strict();
const OutputSchema = z.object({
  note_path: z.string(),
  date: z.string(),
  skipped: z.boolean(),
});

type Input = z.infer<typeof InputSchema>;
type Output = z.infer<typeof OutputSchema>;

function db_of(ctx: ToolContext): import('bun:sqlite').Database {
  return (ctx.memory as unknown as { cfg: { db: import('bun:sqlite').Database } }).cfg.db;
}
function vault_root_of(ctx: ToolContext): string {
  return (ctx.memory as unknown as { cfg: { vault_root: string } }).cfg.vault_root;
}

export const write_standup_snapshot: Tool<Input, Output> = {
  name: 'write_standup_snapshot',
  description:
    'Append a dated board-state snapshot (sprint say/do, lane counts, in-progress, next-up) to the dev-board standup log in the vault — the daily "standup" ceremony, a durable record of where the board stood. Deterministic + idempotent per day. Normally fired by the daily_standup background job, not called by hand.',
  risk: 'write_internal',
  required_capabilities: ['manage_scrum'],
  input_schema: InputSchema,
  output_schema: OutputSchema,

  yield: { none: true, reason: 'writes exactly one snapshot note per run, so a count that is always 1 carries no signal' },
  idempotency_key() {
    // One standup per local day — the dedup unit is the day, not the (empty) input.
    return `write_standup_snapshot:${local_iso_date()}`;
  },

  async execute(_input, ctx: ToolContext): Promise<Output> {
    const date = local_iso_date(ctx.now);
    const header = `## ${date} — standup`;

    // Idempotent per day: if today's entry is already logged, no-op (covers a
    // manual re-fire or a same-day restart re-hitting the slot).
    const abs = resolve(vault_root_of(ctx), STANDUP_LOG);
    if (existsSync(abs) && readFileSync(abs, 'utf8').includes(header)) {
      return { note_path: STANDUP_LOG, date, skipped: true };
    }

    const store = new ScrumStore(db_of(ctx));
    ctx.memory.append_to_note(STANDUP_LOG, render_standup_entry_md(store, date));

    ctx.memory.log_action({
      intent_id: ctx.intent_id || ulid(),
      agent: ctx.specialist_id ?? 'trainer',
      tool_name: 'write_standup_snapshot',
      tool_input: { date },
      execution_result: { note_path: STANDUP_LOG, skipped: false },
    });

    return { note_path: STANDUP_LOG, date, skipped: false };
  },
};
