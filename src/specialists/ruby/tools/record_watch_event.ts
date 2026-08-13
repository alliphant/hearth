/**
 * Ruby (#3) — append a dated development to a tracked story's timeline.
 *
 * This is the beat's write side. A story is OPENED by recording its first
 * development (with `why_tracked` — the criterion it cleared) and CLOSED by
 * recording the development that ended it with `status: 'resolved'`. Between
 * those, each call adds one dated event, so reading the topic back gives the
 * arc rather than a snapshot. Idempotent per (topic, headline, date).
 *
 * The topic's LIVENESS is derived, never stored: `summarize_watch_topics`
 * (civic_analysis.ts) reads the timeline and ages a story off the active
 * board once it has gone quiet, so a fight that ends simply stops appearing
 * without anyone sweeping it. Recording a new development on a dormant topic
 * revives it automatically. (Before 2026-07-28 this was append-only with a
 * per-event status nothing read, so nothing ever aged out — which is why the
 * beat had to be pinned in the persona and stayed pinned long after the
 * stories closed.)
 *
 * `source_url` is optional (some developments are Ruby's own synthesis
 * across sources) but strongly encouraged.
 */
import { z } from 'zod';
import type { Tool, ToolContext } from '@core/tool';

const InputSchema = z
  .object({
    /** Stable lowercase slug so developments accrue under one story. */
    topic: z
      .string()
      .min(1)
      .max(80)
      .describe(
        'Stable lowercase slug naming the STORY, not the day\'s headline — ' +
          'reuse it exactly so developments accrue under one thread.',
      ),
    headline: z.string().min(1).max(200).describe('What moved, in one line.'),
    detail: z.string().max(2_000).optional(),
    /** ISO date of the development. */
    event_at: z.string().min(4).max(40).describe('ISO date of the development (YYYY-MM-DD).'),
    status: z
      .enum(['open', 'resolved', 'dormant'])
      .default('open')
      .describe(
        "The STORY's state as of this development. 'resolved' when it is " +
          'genuinely over — voted through, contract ended, project built, ' +
          "petition failed. 'dormant' when you are deliberately dropping it. " +
          'Otherwise leave it open; a story that simply goes quiet ages off ' +
          'the board on its own.',
      ),
    why_tracked: z
      .string()
      .max(400)
      .optional()
      .describe(
        'Only on the FIRST development: what makes this worth the ' +
          "household's attention — the pending decision, the money, the " +
          'scheduled vote, the proximity, the direct effect. Keeps the board ' +
          'auditable.',
      ),
    source_url: z.string().url().max(500).optional(),
  })
  .strict();

const OutputSchema = z.object({
  ok: z.boolean(),
  id: z.string().optional(),
  error: z.string().optional(),
});

type Input = z.infer<typeof InputSchema>;
type Output = z.infer<typeof OutputSchema>;

function slug(s: string, max = 80): string {
  return s.toLowerCase().trim().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '').slice(0, max);
}

export const record_watch_event: Tool<Input, Output> = {
  name: 'record_watch_event',
  description:
    "Append a dated development to a story you're tracking, or open a new one. " +
    'Track an issue when it has a decision still to be made and someone the ' +
    'household could reach — a scheduled vote or hearing, public money moving, ' +
    'a contract up for renewal, a rule being written, something recurring that ' +
    "keeps coming back, or something that lands on the household's street, " +
    'commute, utilities, or taxes. A story that is merely interesting is a ' +
    "library note, not a tracked issue. Give `why_tracked` on the story's " +
    'first development. Record the development that ENDS it with ' +
    "status='resolved' (voted through, contract ended, project built) — that " +
    'is how a beat stays current. A story you just stop hearing about ages off ' +
    'the board on its own; recording a new development revives it. topic is a ' +
    'stable lowercase slug so events accrue under one thread. Idempotent per ' +
    'topic+headline+date.',
  risk: 'write_internal',
  required_capabilities: ['write_vault_general'],
  input_schema: InputSchema,
  output_schema: OutputSchema,

  idempotency_key(input) {
    return `record_watch_event:${slug(input.topic, 40)}:${input.event_at}:${slug(input.headline, 40)}`;
  },

  async execute(input, ctx: ToolContext): Promise<Output> {
    const user_id = ctx.user?.id ?? process.env.HEARTH_OWNER_USER_ID ?? 'jasper';
    try {
      const id = ctx.memory.record_watch_event({
        user_id,
        topic: slug(input.topic),
        headline: input.headline,
        detail: input.detail ?? null,
        event_at: input.event_at,
        status: input.status,
        why_tracked: input.why_tracked ?? null,
        source_url: input.source_url ?? null,
        dedup_key: `watch:${slug(input.topic, 40)}:${input.event_at}:${slug(input.headline, 60)}`,
      });
      return { ok: true, id };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  },
};
