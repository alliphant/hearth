/**
 * expire_civic_watchlist — age out the `watching` bucket (2026-07-31).
 *
 * Ruby's office had 136 active civic items and 96 of them — 71% — were
 * unverified `watching` leads, the oldest two months old, with nothing that
 * could ever retire one. The `civic_items.status` CHECK has allowed
 * `'expired'` since the table was written; nothing had ever set it.
 *
 * The bucket fills because it is the evidence-quote gate's escape hatch:
 * `record_civic_item` rejects an `announcement` / `agenda_item` whose claim
 * isn't backed by a verbatim quote from a page read that turn, and every one
 * of its rejection messages ends with "or record it as kind 'watching'". That
 * steer is right — an unconfirmed lead must not be filed as fact — but with
 * no lifetime on the destination it made "watching" a free, permanent
 * disposal. This gives it a cost: a lead now either gets verified (re-recorded
 * as a real kind, with a quote) or it ages out.
 *
 * ARCHIVE, never delete. Expired rows keep their title, summary, source and
 * `ts_created` and stay queryable; re-recording one revives it (the upsert's
 * status CASE), so a story that goes quiet and then moves again returns on
 * its own. A `dismissed` item is untouched — that is a human decision.
 *
 * Runs as a background job (deterministic, no LLM). Also directly invocable
 * with `dry_run` so Ruby — or a person — can see what a sweep would retire
 * before it runs.
 */
import { z } from 'zod';
import type { Tool, ToolContext } from '@core/tool';
import {
  civic_expiry_verdict,
  DEFAULT_CIVIC_EXPIRY,
  type CivicExpiryConfig,
} from '../civic_analysis';

const InputSchema = z
  .object({
    dry_run: z
      .boolean()
      .default(false)
      .describe('Report what would be retired without changing anything.'),
    stale_days: z
      .number()
      .int()
      .min(1)
      .max(365)
      .optional()
      .describe('Days an UNDATED lead may sit untouched before it ages out (default 30).'),
    event_grace_days: z
      .number()
      .int()
      .min(0)
      .max(90)
      .optional()
      .describe('Days a DATED lead outlives its own date (default 2).'),
  })
  .strict();

const OutputSchema = z.object({
  ok: z.boolean(),
  /** How many leads were retired (or would be, under dry_run). */
  expired: z.number(),
  /** Counts keyed by why: event_passed | unverified_and_stale. */
  by_reason: z.record(z.string(), z.number()),
  /** Active watching leads remaining after the sweep. */
  remaining_watching: z.number(),
  dry_run: z.boolean(),
  error: z.string().optional(),
});

type Input = z.infer<typeof InputSchema>;
type Output = z.infer<typeof OutputSchema>;

export const expire_civic_watchlist: Tool<Input, Output> = {
  name: 'expire_civic_watchlist',
  description:
    "Retire stale 'watching' leads from the civic office: a dated lead whose date has passed, or an undated one nobody has touched in a month. Archives them (status='expired') — never deletes, and re-recording a lead revives it. Only 'watching' is affected; recorded findings and dismissed items are untouched. Pass dry_run to preview.",
  risk: 'write_internal',
  required_capabilities: ['write_vault_general'],
  input_schema: InputSchema,
  output_schema: OutputSchema,
  // The result depends on wall-clock time and on rows other passes wrote, so
  // it must not be served from the per-turn duplicate-call cache.
  volatile: true,

  // Reporting-only: the fields are authoritative, but expires only watch items that have actually aged out; zero is the common, healthy case.
  yield: { produced: ['expired'], armed: false },
  idempotency_key(input) {
    return `expire_civic_watchlist:${input.dry_run ? 'dry' : 'apply'}:${input.stale_days ?? 'd'}`;
  },

  async execute(input, ctx: ToolContext): Promise<Output> {
    // A BACKGROUND JOB runs with no user in ctx — the loop driver invokes it
    // directly, not inside a user-scoped turn. Guarding on `ctx.user?.id` and
    // refusing is the documented failure that left this desk's office empty
    // for months (deliberation tool calls ran user-LESS, so every
    // `record_civic_item` silently no-op'd), and it would have made this
    // sweep a no-op EVERY night at 04:45 while reporting ok:true — the same
    // succeeds-and-writes-nothing shape it was built to clean up. Resolve the
    // owner the way every other Ruby background job does.
    const user_id = ctx.user?.id ?? process.env.HEARTH_OWNER_USER_ID ?? 'jasper';

    const cfg: CivicExpiryConfig = {
      event_grace_days: input.event_grace_days ?? DEFAULT_CIVIC_EXPIRY.event_grace_days,
      stale_days: input.stale_days ?? DEFAULT_CIVIC_EXPIRY.stale_days,
    };
    const now = new Date();
    const decide = (row: {
      kind: string;
      status: string;
      event_at: string | null;
      ts_updated: string;
    }): { expire: boolean; reason: string | null } => civic_expiry_verdict(row, now, cfg);

    let expired = 0;
    let by_reason: Record<string, number> = {};

    if (input.dry_run) {
      for (const row of ctx.memory.list_civic_items(user_id)) {
        if (row.kind !== 'watching') continue;
        const v = civic_expiry_verdict(row, now, cfg);
        if (!v.expire) continue;
        expired++;
        by_reason[v.reason] = (by_reason[v.reason] ?? 0) + 1;
      }
    } else {
      const res = ctx.memory.expire_stale_civic_items(user_id, now, decide);
      expired = res.expired;
      by_reason = res.by_reason;
    }

    const remaining_watching = ctx.memory
      .list_civic_items(user_id)
      .filter((r) => r.kind === 'watching').length;

    ctx.memory.log_action({
      intent_id: ctx.intent_id,
      agent: ctx.specialist_id ?? 'ruby',
      tool_name: 'expire_civic_watchlist',
      tool_input: { dry_run: input.dry_run, ...cfg },
      execution_result: { expired, by_reason, remaining_watching },
      user_id,
    });

    return { ok: true, expired, by_reason, remaining_watching, dry_run: input.dry_run };
  },
};
