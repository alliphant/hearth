/**
 * scrum_board_read — Beatrice's read into her scrum / dev-board.
 *
 * The blueprint's `standup` + `/llm-context.json` reads, collapsed into one
 * tool. Returns a compact markdown summary she can reason over (ranked next-up,
 * say/do, in-progress) plus the structured précis. `view: 'full'` returns the
 * whole canvas markdown (lanes + burndown mermaid + ranked backlog table) — use
 * it when grooming, not on every standup, to keep the turn cheap.
 */

import { z } from 'zod';
import { createHash } from 'node:crypto';
import { ulid } from 'ulid';
import type { Tool, ToolContext } from '@core/tool';
import { require_caller_tier } from '@core/tool_gates';
import { ScrumStore } from '@memory/stores/scrum';
import {
  render_scrum_summary_md,
  render_scrum_canvas_md,
  render_scrum_search_md,
} from '@core/scrum_render';

const InputSchema = z.object({
  view: z.enum(['summary', 'full']).default('summary'),
  query: z
    .string()
    .max(200)
    .optional()
    .describe(
      'Keyword(s) to find a SPECIFIC epic by name. When set, returns matching epics WITH their ids (substring match on title + description across the whole board), ignoring `view`.',
    ),
});

const MatchSchema = z.object({
  id: z.string(),
  title: z.string(),
  lane: z.string(),
  type: z.string(),
  size: z.string().nullable(),
  value: z.string().nullable(),
  severity: z.string().nullable(),
  project_slug: z.string().nullable(),
});

const OutputSchema = z.object({
  markdown: z.string(),
  precis: z.unknown(),
  matches: z.array(MatchSchema).optional(),
});

type Input = z.infer<typeof InputSchema>;
type Output = z.infer<typeof OutputSchema>;

function db_of(ctx: ToolContext): import('bun:sqlite').Database {
  return (ctx.memory as unknown as { cfg: { db: import('bun:sqlite').Database } }).cfg.db;
}

export const scrum_board_read: Tool<Input, Output> = {
  name: 'scrum_board_read',
  description:
    "Read your scrum / dev-board: the ranked next-up backlog, say/do ratio, the backend/iOS committed split, and what's in progress. Default `view: 'summary'` returns a compact markdown briefing (cheap — use it for standup). `view: 'full'` returns the whole board as markdown + mermaid (lanes, burndown, ranked backlog table) — use it when grooming. To find ONE specific epic by name (e.g. to get its `id` so you can move or score it), pass `query:` with a distinctive word or two from its title — it substring-matches title + description across the WHOLE board (past the capped canvas view) and returns the matching epics with their ids. Reach for `query:` instead of asking the user to paste an epic id. The board tracks feature-adds + bug-adds for building Hearth itself; ranking is deterministic (ROI = value/effort; a critical bug always outranks features). Read this BEFORE you propose a sprint commit so the ranking is grounded.",
  risk: 'read',
  required_capabilities: ['manage_scrum'],
  input_schema: InputSchema,
  output_schema: OutputSchema,

  idempotency_key(input) {
    const h = createHash('sha256');
    h.update(JSON.stringify(input));
    return `scrum_board_read:${h.digest('hex').slice(0, 16)}`;
  },

  async execute(input, ctx: ToolContext): Promise<Output> {
    require_caller_tier(ctx, ['owner']);
    const store = new ScrumStore(db_of(ctx));
    const precis = store.standup_precis();

    const query = input.query?.trim();
    if (query) {
      const rows = store.search_epics(query, { limit: 25 });
      const projects = new Map(store.list_projects().map((p) => [p.id, p]));
      const matches = rows.map((e) => ({
        id: e.id,
        title: e.title,
        lane: e.lane,
        type: e.type,
        size: e.size,
        value: e.value,
        severity: e.severity,
        project_slug: projects.get(e.project_id)?.slug ?? null,
      }));

      ctx.memory.log_action({
        intent_id: ctx.intent_id || ulid(),
        agent: ctx.specialist_id ?? 'trainer',
        tool_name: 'scrum_board_read',
        tool_input: { query },
        execution_result: { matched: rows.length },
      });

      return { markdown: render_scrum_search_md(store, query, rows), precis, matches };
    }

    const markdown =
      input.view === 'full' ? render_scrum_canvas_md(store) : render_scrum_summary_md(store);

    ctx.memory.log_action({
      intent_id: ctx.intent_id || ulid(),
      agent: ctx.specialist_id ?? 'trainer',
      tool_name: 'scrum_board_read',
      tool_input: { view: input.view },
      execution_result: { sprint: precis.sprint?.label ?? null, next_up: precis.next_up.length },
    });

    return { markdown, precis };
  },
};
