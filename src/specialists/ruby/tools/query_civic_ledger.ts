/**
 * Ruby — read back the structured civic ledger she's been building: the
 * voting record (by member and/or item), the elected-official roster, the
 * board of stories she's tracking, or the campaigns the household is
 * actively working. This is what turns the write-side ledger into answers:
 * "how did Councilmember X vote on the surveillance contract", "who's up for
 * re-election", "walk me through how that fight went". Every vote row
 * carries its source_url so Ruby can cite the document she's quoting.
 *
 * The `watch` section is the beat's read side and it has two shapes:
 * without a topic it returns the BOARD — one rollup row per story with its
 * derived status, so a fight that ended or went quiet is visibly off the
 * active set (see summarize_watch_topics); with a topic it returns that
 * story's dated timeline.
 */
import { z } from 'zod';
import type { Tool, ToolContext } from '@core/tool';
import { campaign_list_field } from '@memory/client';
import {
  summarize_watch_topics,
  WATCH_DORMANCY_DEFAULTS,
  type WatchEventLike,
} from '../civic_analysis';

const InputSchema = z
  .object({
    section: z.enum(['votes', 'members', 'watch', 'campaigns']),
    /** votes: filter to one member's record. */
    member_name: z.string().max(120).optional(),
    /** votes: filter to items whose title contains this. */
    item_contains: z.string().max(120).optional(),
    /** votes: all roll calls from ONE meeting. This is the join to the
     *  office: a council_meeting civic_item's dedup_key is
     *  `meeting:<id>` — pass that `<id>` here to read its votes. */
    meeting_id: z.string().max(40).optional(),
    /** watch: the story slug to pull the full timeline for. Omit for the board. */
    topic: z.string().max(80).optional(),
    /** watch/campaigns: include stories/campaigns that have closed or gone
     *  dormant. Off by default — the point of the board is that finished
     *  work leaves it. */
    include_archived: z.boolean().default(false),
    limit: z.number().int().min(1).max(100).default(40),
  })
  .strict();

const OutputSchema = z.object({
  ok: z.boolean(),
  section: z.string(),
  count: z.number(),
  rows: z.array(z.record(z.string(), z.unknown())),
  /** watch board only — what got left out, so an empty board is legible. */
  archived_count: z.number().optional(),
  error: z.string().optional(),
});

type Input = z.infer<typeof InputSchema>;
type Output = z.infer<typeof OutputSchema>;

export const query_civic_ledger: Tool<Input, Output> = {
  name: 'query_civic_ledger',
  description:
    "Read Ruby's structured civic ledger. section='votes' returns recorded " +
    'council votes (filter by member_name, item_contains, and/or meeting_id — ' +
    "a council_meeting office item's dedup_key `meeting:<id>` carries the " +
    'meeting_id its roll calls are recorded under) — each row ' +
    "includes the source_url to cite; section='members' returns the " +
    "elected-official roster; section='watch' with NO topic returns your " +
    'BOARD — every story you track, with how long since it last moved and ' +
    'whether it is open, going quiet, resolved, or dormant (pass a topic ' +
    "instead for that story's full dated timeline); section='campaigns' " +
    'returns the fights the household is actively working, with their ' +
    'position, targets, next milestone, and running investigations. Closed ' +
    'and dormant work is excluded unless include_archived — it stays ' +
    'queryable, it just leaves the board. Call this before characterizing ' +
    'any issue as ongoing: a story that stopped moving months ago is not a ' +
    'live fight, and the board is what tells you.',
  risk: 'read',
  required_capabilities: ['read_vault'],
  input_schema: InputSchema,
  output_schema: OutputSchema,

  idempotency_key(input) {
    return `query_civic_ledger:${input.section}:${input.member_name ?? ''}:${input.item_contains ?? ''}:${input.meeting_id ?? ''}:${input.topic ?? ''}:${input.include_archived}`;
  },

  async execute(input, ctx: ToolContext): Promise<Output> {
    const user_id = ctx.user?.id ?? process.env.HEARTH_OWNER_USER_ID ?? 'jasper';
    try {
      let rows: Array<Record<string, unknown>>;
      let archived_count: number | undefined;

      if (input.section === 'votes') {
        rows = ctx.memory.list_civic_votes(user_id, {
          member_name: input.member_name,
          item_contains: input.item_contains,
          meeting_id: input.meeting_id,
        }) as unknown as Array<Record<string, unknown>>;
      } else if (input.section === 'members') {
        rows = ctx.memory.list_civic_members(user_id, false) as unknown as Array<
          Record<string, unknown>
        >;
      } else if (input.section === 'campaigns') {
        rows = ctx.memory.list_civic_campaigns(user_id, {
          active_only: !input.include_archived,
        }).map((c) => ({
          slug: c.slug,
          title: c.title,
          status: c.status,
          stake: c.stake_md,
          position: c.position_md,
          talking_points: c.talking_points_md,
          targets: campaign_list_field(c.targets),
          next_milestone: c.next_milestone,
          next_milestone_at: c.next_milestone_at,
          watch_topic: c.watch_topic,
          investigation_ids: campaign_list_field(c.investigation_ids),
          outcome: c.outcome_md,
          updated_at: c.ts_updated,
        }));
      } else if (input.topic) {
        // One story's dated arc — the timeline, newest development first.
        rows = ctx.memory.list_watch_events(user_id, input.topic) as unknown as Array<
          Record<string, unknown>
        >;
      } else {
        // The board: one rollup row per story, liveness derived from when
        // it last moved.
        const events = ctx.memory.list_watch_events(user_id) as unknown as WatchEventLike[];
        const board = summarize_watch_topics(events, new Date().toISOString());
        const shown = input.include_archived ? board : board.filter((t) => t.active);
        archived_count = board.length - shown.length;
        rows = shown as unknown as Array<Record<string, unknown>>;
      }

      return {
        ok: true,
        section: input.section,
        count: rows.length,
        rows: rows.slice(0, input.limit),
        ...(archived_count === undefined ? {} : { archived_count }),
      };
    } catch (err) {
      return { ok: false, section: input.section, count: 0, rows: [], error: (err as Error).message };
    }
  },
};

/** Re-exported so callers that render the board share the tool's window. */
export { WATCH_DORMANCY_DEFAULTS };
