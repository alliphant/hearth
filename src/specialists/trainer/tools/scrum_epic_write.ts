/**
 * scrum_epic_write — create / update / move an epic on Beatrice's dev-board.
 *
 * One action-discriminated write tool (flat schema, validated in execute — Qwen
 * fills flat args more reliably than a discriminated union). `move` ALWAYS
 * writes the lane-transition event log (the blueprint's metrics gold). Epics are
 * the unit of work, typed feature | bug, sized S/M/L for effort and (features)
 * value, or (bugs) severity-graded — that's what the ranking reads.
 */

import { z } from 'zod';
import { createHash } from 'node:crypto';
import { ulid } from 'ulid';
import type { Tool, ToolContext } from '@core/tool';
import { require_caller_tier } from '@core/tool_gates';
import { ScrumStore, type ScrumLane } from '@memory/stores/scrum';

const SizeEnum = z.enum(['S', 'M', 'L']);
const SeverityEnum = z.enum(['critical', 'high', 'medium', 'low']);
const LaneEnum = z.enum([
  'product_backlog',
  'sprint_backlog',
  'in_progress',
  'review',
  'done',
]);
const BoardEnum = z.enum(['backend', 'ios']);

const InputSchema = z.object({
  action: z.enum(['create', 'update', 'move', 'score', 'archive', 'unarchive']),
  /** create: project to file under (slug, e.g. 'scrum-tool'). */
  project_slug: z.string().optional(),
  /** update / move: target epic id. */
  epic_id: z.string().optional(),
  title: z.string().optional(),
  type: z.enum(['feature', 'bug']).optional(),
  size: SizeEnum.optional(),
  value: SizeEnum.optional(),
  value_note: z.string().optional(),
  severity: SeverityEnum.optional(),
  description: z.string().optional(),
  board: BoardEnum.optional(),
  /** create: starting lane (default product_backlog). */
  lane: LaneEnum.optional(),
  /** move: destination lane. */
  to_lane: LaneEnum.optional(),
  /** score: batch-score many epics in ONE call (the grooming primitive). */
  items: z
    .array(
      z.object({
        epic_id: z.string(),
        size: SizeEnum.optional(),
        value: SizeEnum.optional(),
        severity: SeverityEnum.optional(),
        value_note: z.string().optional(),
      }),
    )
    .optional(),
});

const OutputSchema = z.object({
  // create / update / move return the single epic's facets:
  epic_id: z.string().optional(),
  title: z.string().optional(),
  type: z.string().optional(),
  lane: z.string().optional(),
  board: z.string().nullable().optional(),
  roi: z.number().nullable().optional(),
  quadrant: z.string().optional(),
  // score returns the batch result:
  scored: z.number().optional(),
  not_found: z.array(z.string()).optional(),
  // archive / unarchive return the new state:
  archived: z.boolean().optional(),
});

type Input = z.infer<typeof InputSchema>;
type Output = z.infer<typeof OutputSchema>;

function db_of(ctx: ToolContext): import('bun:sqlite').Database {
  return (ctx.memory as unknown as { cfg: { db: import('bun:sqlite').Database } }).cfg.db;
}

export const scrum_epic_write: Tool<Input, Output> = {
  name: 'scrum_epic_write',
  description:
    "Create, update, move, or batch-SCORE epics on your dev-board. action='create' (needs project_slug + title; set type feature|bug, size S/M/L, value S/M/L for features or severity for bugs, board backend|ios, description); action='update' (needs epic_id, then any field to change); action='move' (needs epic_id + to_lane: product_backlog|sprint_backlog|in_progress|review|done — logs the lane transition); action='score' (the GROOMING primitive — pass `items`: an array of { epic_id, size, value (features) | severity (bugs) }, scoring MANY epics in ONE call so you never burn a tool round per epic); action='archive' (needs epic_id — REMOVE a junk/obsolete/wrong epic from the board; recoverable, not a destructive delete; refuses an epic committed to the open sprint); action='unarchive' (needs epic_id — restore an archived epic). Grooming = actually CALLING score with items, not describing scores in prose. An unscored epic can't be ranked, so score the backlog before you recommend a sprint; archive the dead ones so the board reflects real work.",
  risk: 'write_internal',
  required_capabilities: ['manage_scrum'],
  input_schema: InputSchema,
  output_schema: OutputSchema,

  idempotency_key(input) {
    const h = createHash('sha256');
    h.update(JSON.stringify(input));
    return `scrum_epic_write:${h.digest('hex').slice(0, 16)}`;
  },

  async execute(input, ctx: ToolContext): Promise<Output> {
    require_caller_tier(ctx, ['owner']);
    const store = new ScrumStore(db_of(ctx));
    const actor = ctx.specialist_id ?? 'beatrice';

    // ── score: batch-score many epics in one call (grooming) ──
    if (input.action === 'score') {
      if (!input.items || input.items.length === 0) {
        throw new Error("score needs a non-empty `items` array of { epic_id, size, value | severity }.");
      }
      const result = store.score_epics(input.items);
      ctx.memory.log_action({
        intent_id: ctx.intent_id || ulid(),
        agent: actor,
        tool_name: 'scrum_epic_write',
        tool_input: { action: 'score', count: input.items.length },
        execution_result: { scored: result.scored, not_found: result.not_found.length },
      });
      return { scored: result.scored, not_found: result.not_found };
    }

    // ── archive / unarchive: prune the board (recoverable; not a destructive delete) ──
    if (input.action === 'archive' || input.action === 'unarchive') {
      if (!input.epic_id) throw new Error(`${input.action} needs epic_id.`);
      const archived = input.action === 'archive';
      const ep = archived ? store.archive_epic(input.epic_id) : store.unarchive_epic(input.epic_id);
      ctx.memory.log_action({
        intent_id: ctx.intent_id || ulid(),
        agent: actor,
        tool_name: 'scrum_epic_write',
        tool_input: { action: input.action, epic_id: input.epic_id },
        execution_result: { archived: !!ep.archived },
      });
      return { epic_id: ep.id, title: ep.title, lane: ep.lane, archived: !!ep.archived };
    }

    let epic;
    if (input.action === 'create') {
      if (!input.project_slug || !input.title) {
        throw new Error("create needs both project_slug and title.");
      }
      const project = store.project_by_slug(input.project_slug);
      if (!project) {
        const slugs = store.list_projects().map((p) => p.slug).join(', ') || '(none)';
        throw new Error(`No project with slug '${input.project_slug}'. Known slugs: ${slugs}.`);
      }
      epic = store.create_epic({
        project_id: project.id,
        title: input.title,
        type: input.type ?? 'feature',
        size: input.size ?? null,
        value: input.value ?? null,
        value_note: input.value_note ?? null,
        severity: input.severity ?? null,
        description: input.description ?? null,
        lane: input.lane,
        board: input.board ?? null,
      });
    } else if (input.action === 'update') {
      if (!input.epic_id) throw new Error('update needs epic_id.');
      epic = store.update_epic(input.epic_id, {
        title: input.title,
        type: input.type,
        size: input.size,
        value: input.value,
        value_note: input.value_note,
        severity: input.severity,
        description: input.description,
        board: input.board,
      });
    } else {
      // move
      if (!input.epic_id || !input.to_lane) throw new Error('move needs epic_id and to_lane.');
      epic = store.move_epic(input.epic_id, input.to_lane as ScrumLane, actor);
    }

    const project = store.get_project(epic.project_id);
    const board =
      project ? (epic.board ?? project.board) : epic.board;
    // Recompute ranking facets from the canonical store helpers via read_board.
    const view = store.read_board();
    const card = view.lanes[epic.lane].find((c) => c.id === epic.id);

    ctx.memory.log_action({
      intent_id: ctx.intent_id || ulid(),
      agent: actor,
      tool_name: 'scrum_epic_write',
      tool_input: { action: input.action, epic_id: epic.id, to_lane: input.to_lane },
      execution_result: { lane: epic.lane },
    });

    return {
      epic_id: epic.id,
      title: epic.title,
      type: epic.type,
      lane: epic.lane,
      board: board ?? null,
      roi: card?.roi ?? null,
      quadrant: card?.quadrant ?? 'Unscored',
    };
  },
};
