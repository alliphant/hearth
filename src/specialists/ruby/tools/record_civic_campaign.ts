/**
 * Ruby — open, advance, and close a civic CAMPAIGN (2026-07-28).
 *
 * The distinction that makes the beat work:
 *
 *   - a watch topic (record_watch_event) answers *what happened* — a dated
 *     timeline of developments, aged off the board when the story stops
 *     moving;
 *   - a campaign answers *what do we want, who decides it, when is it
 *     decidable, and what work is running* — the household acting on a
 *     story rather than following it.
 *
 * It composes instead of duplicating. The factual spine stays in the linked
 * `watch_topic`'s timeline; the deep background stays in linked
 * `deep_research` investigations; the thing Jasper actually sends or reads
 * aloud still ships through `propose_action` as a communication_draft. What
 * lives here is only what had nowhere else to go: the position, the targets,
 * the next moment the outcome can move, and the campaign's own lifecycle.
 *
 * Updates are STICKY per field — advancing the milestone does not wipe the
 * position or the talking points (the politics `take_md` rule). Campaigns
 * close like stories do (won / lost / closed) so the board can't accumulate
 * dead crusades.
 */
import { z } from 'zod';
import type { Tool, ToolContext } from '@core/tool';
import type { CivicCampaignStatus } from '@memory/client';

const InputSchema = z
  .object({
    slug: z
      .string()
      .min(1)
      .max(80)
      .describe('Stable lowercase slug for the campaign. Reuse it exactly to advance one.'),
    title: z.string().min(1).max(200).describe('Plain-language name for the fight.'),
    stake_md: z
      .string()
      .max(2_000)
      .optional()
      .describe(
        "What's at stake for this household specifically — the money, the " +
          'pending decision, the effect on the street/commute/utilities/taxes. ' +
          'Set it when you open the campaign.',
      ),
    position_md: z
      .string()
      .max(6_000)
      .optional()
      .describe('What we want to happen and the argument for it, with receipts.'),
    talking_points_md: z
      .string()
      .max(6_000)
      .optional()
      .describe(
        'The 90-second version — what Jasper says at the podium or in the ' +
          'email. Short, concrete, quotable, each point resting on a receipt.',
      ),
    targets: z
      .array(z.string().max(160))
      .max(20)
      .optional()
      .describe('Who can actually decide this — a body, a named member, city staff.'),
    next_milestone: z
      .string()
      .max(200)
      .optional()
      .describe('The next moment the outcome can move (a vote, a hearing, a comment window).'),
    next_milestone_at: z
      .string()
      .max(40)
      .optional()
      .describe('When that milestone lands, ISO YYYY-MM-DD.'),
    watch_topic: z
      .string()
      .max(80)
      .optional()
      .describe("The watch topic slug whose timeline is this campaign's factual spine."),
    attach_investigation_id: z
      .string()
      .max(80)
      .optional()
      .describe(
        'An investigation_id returned by deep_research, to attach to this ' +
          'campaign. Adds to the running set; never replaces it.',
      ),
    status: z
      .enum(['active', 'paused', 'won', 'lost', 'closed'])
      .default('active')
      .describe(
        "'won'/'lost' when it is decided; 'closed' when it stops being ours " +
          "to fight (moot, overtaken); 'paused' when nothing can move until a " +
          'later milestone.',
      ),
    outcome_md: z
      .string()
      .max(2_000)
      .optional()
      .describe('How it ended and what it cost or won. Set it when you close the campaign.'),
  })
  .strict();

const OutputSchema = z.object({
  ok: z.boolean(),
  id: z.string().optional(),
  slug: z.string().optional(),
  created: z.boolean().optional(),
  investigation_attached: z.boolean().optional(),
  next_action: z.string().optional(),
  error: z.string().optional(),
});

type Input = z.infer<typeof InputSchema>;
type Output = z.infer<typeof OutputSchema>;

function slugify(s: string, max = 80): string {
  return s.toLowerCase().trim().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '').slice(0, max);
}

/** ISO calendar-date shape, checked in execute() — never as a schema
 *  `.regex()`, which silently disables the whole tool's grammar on the
 *  interactive 9B (see the private dev log "no regex in an input_schema"). */
function bad_iso_date(v: string | undefined): string | null {
  if (!v) return null;
  const t = v.trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(t) && Number.isFinite(Date.parse(t))) return null;
  return `next_milestone_at must be an ISO date (YYYY-MM-DD), got "${v}".`;
}

export const record_civic_campaign: Tool<Input, Output> = {
  name: 'record_civic_campaign',
  description:
    'Open, advance, or close a civic campaign — a fight the household is ' +
    'actively working, not just a story you follow. Open one when a tracked ' +
    'issue has a decision still winnable and someone reachable who decides ' +
    'it: give the stake, the position, who the targets are, and the next ' +
    'milestone. Advance it as the fight moves (fields you omit keep their ' +
    'current value, so you can just move the milestone). Attach background ' +
    'work by passing attach_investigation_id with the id deep_research gave ' +
    'you. Close it with won/lost/closed and an outcome the moment it is ' +
    'decided — an open campaign nobody can act on is clutter. Link ' +
    'watch_topic so the campaign and its timeline stay one thing.',
  risk: 'write_internal',
  required_capabilities: ['write_civic_intel'],
  input_schema: InputSchema,
  output_schema: OutputSchema,

  idempotency_key(input) {
    return `record_civic_campaign:${slugify(input.slug, 40)}:${input.status}:${slugify(input.next_milestone ?? '', 24)}`;
  },

  async execute(input, ctx: ToolContext): Promise<Output> {
    const user_id = ctx.user?.id ?? process.env.HEARTH_OWNER_USER_ID ?? 'jasper';
    const date_problem = bad_iso_date(input.next_milestone_at);
    if (date_problem) {
      return {
        ok: false,
        error: date_problem,
        next_action: `Re-call record_civic_campaign with next_milestone_at as YYYY-MM-DD.`,
      };
    }

    const slug = slugify(input.slug);
    if (!slug) {
      return {
        ok: false,
        error: 'slug reduced to empty after normalization.',
        next_action: 'Re-call with a slug containing letters or numbers.',
      };
    }

    try {
      const { id, created } = ctx.memory.upsert_civic_campaign({
        user_id,
        slug,
        title: input.title,
        stake_md: input.stake_md ?? null,
        position_md: input.position_md ?? null,
        talking_points_md: input.talking_points_md ?? null,
        targets: input.targets ?? null,
        next_milestone: input.next_milestone ?? null,
        next_milestone_at: input.next_milestone_at ?? null,
        watch_topic: input.watch_topic ? slugify(input.watch_topic) : null,
        status: input.status as CivicCampaignStatus,
        outcome_md: input.outcome_md ?? null,
      });

      let investigation_attached: boolean | undefined;
      if (input.attach_investigation_id) {
        investigation_attached = ctx.memory.attach_campaign_investigation(
          user_id,
          slug,
          input.attach_investigation_id.trim(),
        );
      }

      const closed = input.status !== 'active' && input.status !== 'paused';
      return {
        ok: true,
        id,
        slug,
        created,
        ...(investigation_attached === undefined ? {} : { investigation_attached }),
        next_action: closed
          ? `Campaign "${slug}" closed as ${input.status}. Record the closing development on its watch topic too, with status 'resolved', so the story leaves the board.`
          : created
            ? `Campaign "${slug}" opened. It shows on the Politics Desk. Next: record developments on its watch topic as the fight moves, and hand any deep background to deep_research.`
            : `Campaign "${slug}" updated.`,
      };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  },
};
