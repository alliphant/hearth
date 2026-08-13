/**
 * batch_advance_misses — apply one miss action to a filtered group.
 *
 * The single-step advance_process_miss tool is right for hand-triaged
 * one-off decisions. It's wrong for a queue of 42 connector-affordance
 * findings that all need to be routed to Beatrice with the same note,
 * or 18 thinking-only-consult historicals that all need to close at
 * once because the live ghost-promise guard supersedes them. This tool
 * is the batch variant: one filter, one action, one note, applied to
 * every miss the filter selects.
 *
 * Same lifecycle guard as the single-step tool (`apply_miss_action`
 * remains the source of truth — this one calls it in a loop), so
 * invalid transitions on any miss fail that miss only and leave the
 * batch's other moves intact. Returns a per-miss outcome list so the
 * LLM can see what landed and what didn't without a second query.
 *
 * Hard safety rails:
 *
 *   - `close` and `verify` on high-severity misses require an explicit
 *     `allow_high_severity: true` to fire — the default refuses, to
 *     prevent a wide filter from accidentally erasing a serious finding.
 *
 *   - The filter MUST select something to qualify as a batch. A filter
 *     resolving to a single miss returns an error directing the caller
 *     to use advance_process_miss instead — keeps the audit trail
 *     honest about which tool did the work.
 *
 *   - A safety cap on batch size (default 50, max 200) so a mis-filter
 *     can't sweep the entire ledger silently. The cap is configurable
 *     per-call; over the cap, the tool returns the would-affect count
 *     and refuses, letting the LLM narrow the filter.
 */
import { z } from 'zod';
import type { Database } from 'bun:sqlite';
import type { Tool, ToolContext } from '@core/tool';
import type { ToolDeps } from '@core/tool_deps';
import {
  apply_miss_action,
  type ProcessMissAction,
  type ProcessMissRow,
  type ProcessMissStore,
} from '@core/process_misses';
import type { SpecialistInbox } from '@memory/stores/conversations';
import type { AppEventBus } from '@app/events';

const ActionEnum = z.enum([
  'route',
  'dispatch_redo',
  'verify',
  'close',
  'escalate',
]);

const SeverityEnum = z.enum(['low', 'medium', 'high']);

const FilterSchema = z
  .object({
    /** Match by evidence_ref pattern segment — e.g. 'no-recovery-hint',
     *  'fab-after-read-failure', 'dangling-tool'. Matched against
     *  evidence_ref of shape `prefix:pattern[:id]`. */
    pattern: z.string().optional(),
    /** Restrict to a single subject specialist id. */
    subject_specialist_id: z.string().optional(),
    /** Restrict to a single severity. */
    severity: SeverityEnum.optional(),
    /** Restrict to a current status. Default: any non-closed. */
    status: z
      .enum(['open', 'routed', 'redo_dispatched', 'verified', 'escalated'])
      .optional(),
    /** Restrict to misses whose routed_to equals this value. */
    routed_to: z.string().optional(),
  })
  .refine(
    (f) =>
      !!(
        f.pattern ||
        f.subject_specialist_id ||
        f.severity ||
        f.status ||
        f.routed_to
      ),
    {
      message:
        'filter must restrict on at least one of pattern, subject_specialist_id, severity, status, routed_to',
    },
  );

const InputSchema = z.object({
  filter: FilterSchema,
  action: ActionEnum,
  note: z.string().min(1).max(2_000),
  /** Per-call safety cap on how many misses one batch may touch. Default
   *  50. Hard ceiling 200 to prevent a runaway sweep. */
  max_batch: z.coerce.number().int().positive().max(200).optional(),
  /** Required to be `true` when applying `close` or `verify` to any
   *  high-severity miss. Refused by default — protects against a wide
   *  filter accidentally erasing serious findings. */
  allow_high_severity: z.coerce.boolean().optional(),
});

const PerMissOutcome = z.object({
  miss_id: z.string(),
  ok: z.boolean(),
  status: z.string().nullable(),
  skipped_reason: z.string().nullable(),
});

const OutputSchema = z.object({
  matched_count: z.number(),
  applied_count: z.number(),
  skipped_count: z.number(),
  refused: z.boolean(),
  refused_reason: z.string().nullable(),
  outcomes: z.array(PerMissOutcome),
});

type Input = z.infer<typeof InputSchema>;
type Output = z.infer<typeof OutputSchema>;

const DEFAULT_MAX_BATCH = 50;

/**
 * Extract the pattern segment from an `evidence_ref` of shape
 * `prefix:pattern[:id]`. Returns null when no ref or no pattern segment.
 */
function pattern_of(evidence_ref: string | null): string | null {
  if (!evidence_ref) return null;
  const parts = evidence_ref.split(':');
  if (parts.length < 2) return null;
  return parts[1] ?? null;
}

function make_batch_advance_misses(
  db: Database,
  misses: ProcessMissStore,
  inbox: SpecialistInbox,
  events: AppEventBus | undefined,
): Tool<Input, Output> {
  return {
    name: 'batch_advance_misses',
    description:
      'Apply one process-miss action to every miss matching a filter — ' +
      'the batch counterpart to advance_process_miss. Useful for clearing ' +
      'an entire pattern in one call (e.g. routing 42 connector-affordance ' +
      'findings to Beatrice with one note, or closing 18 historical ' +
      'thinking-only-consult misses now that the live guard supersedes ' +
      'them). The filter must restrict on at least one field; a filter ' +
      'matching a single miss returns an error (use advance_process_miss ' +
      'directly). Default batch cap is 50; high-severity close/verify ' +
      'requires allow_high_severity: true. Returns a per-miss outcome ' +
      'list so the caller sees exactly what landed and what was skipped.',
    risk: 'write_internal',
    required_capabilities: ['write_process_miss'],
    input_schema: InputSchema,
    output_schema: OutputSchema,

    idempotency_key(input) {
      const f = input.filter;
      return (
        `batch_advance_misses:${input.action}:` +
        [f.pattern, f.subject_specialist_id, f.severity, f.status, f.routed_to]
          .map((v) => v ?? '_')
          .join('|')
      );
    },

    async execute(input, ctx: ToolContext): Promise<Output> {
      const reporter = ctx.specialist_id ?? 'mariah';
      const max_batch = input.max_batch ?? DEFAULT_MAX_BATCH;
      const action = input.action as ProcessMissAction;

      // Pull candidates. We do the pattern filter in JS (evidence_ref
      // shape is application-level, not SQL-indexable cleanly) and push
      // the other filters into SQL where they're indexed.
      const where: string[] = [];
      const params: Record<string, string> = {};
      if (input.filter.status) {
        where.push('status = @status');
        params['@status'] = input.filter.status;
      } else {
        where.push(`status != 'closed'`);
      }
      if (input.filter.subject_specialist_id) {
        where.push('subject_specialist_id = @subject');
        params['@subject'] = input.filter.subject_specialist_id;
      }
      if (input.filter.severity) {
        where.push('severity = @severity');
        params['@severity'] = input.filter.severity;
      }
      if (input.filter.routed_to) {
        where.push('routed_to = @routed');
        params['@routed'] = input.filter.routed_to;
      }
      const sql =
        `SELECT * FROM process_misses WHERE ${where.join(' AND ')} ` +
        `ORDER BY ts_created ASC`;
      const candidates = db.prepare(sql).all(params) as ProcessMissRow[];

      const filtered = input.filter.pattern
        ? candidates.filter(
            (m) => pattern_of(m.evidence_ref) === input.filter.pattern,
          )
        : candidates;

      const matched_count = filtered.length;

      // ── Safety rails ────────────────────────────────────────────────
      if (matched_count === 0) {
        return {
          matched_count: 0,
          applied_count: 0,
          skipped_count: 0,
          refused: true,
          refused_reason:
            'filter matched no open misses — nothing to do. ' +
            'Run program_dashboard to see what is open.',
          outcomes: [],
        };
      }
      if (matched_count === 1) {
        return {
          matched_count: 1,
          applied_count: 0,
          skipped_count: 0,
          refused: true,
          refused_reason:
            `filter matched a single miss (${filtered[0]!.id}) — call ` +
            `advance_process_miss directly for one-offs so the audit ` +
            `trail records the right tool.`,
          outcomes: [],
        };
      }
      if (matched_count > max_batch) {
        return {
          matched_count,
          applied_count: 0,
          skipped_count: 0,
          refused: true,
          refused_reason:
            `filter would touch ${matched_count} misses, over the cap ` +
            `(${max_batch}). Narrow the filter or pass max_batch up to 200. ` +
            `If the queue is genuinely that large, split into multiple ` +
            `batches by subject_specialist_id or severity.`,
          outcomes: [],
        };
      }
      if (
        (action === 'close' || action === 'verify') &&
        !input.allow_high_severity
      ) {
        const high = filtered.filter((m) => m.severity === 'high');
        if (high.length > 0) {
          return {
            matched_count,
            applied_count: 0,
            skipped_count: 0,
            refused: true,
            refused_reason:
              `${high.length} of ${matched_count} matching misses are ` +
              `severity=high. Closing or verifying high-severity misses ` +
              `in bulk requires allow_high_severity: true — reconfirm ` +
              `you mean to clear them, or narrow the filter to exclude ` +
              `severity high.`,
            outcomes: [],
          };
        }
      }

      // ── Apply ───────────────────────────────────────────────────────
      const outcomes: z.infer<typeof PerMissOutcome>[] = [];
      let applied_count = 0;
      let skipped_count = 0;
      for (const m of filtered) {
        try {
          const after = apply_miss_action({
            misses,
            inbox,
            miss_id: m.id,
            action,
            note: input.note,
            reporter,
            events,
          });
          outcomes.push({
            miss_id: m.id,
            ok: true,
            status: after.status,
            skipped_reason: null,
          });
          applied_count++;
        } catch (err) {
          outcomes.push({
            miss_id: m.id,
            ok: false,
            status: m.status,
            skipped_reason: err instanceof Error ? err.message : String(err),
          });
          skipped_count++;
        }
      }

      return {
        matched_count,
        applied_count,
        skipped_count,
        refused: false,
        refused_reason: null,
        outcomes,
      };
    },
  };
}

/** ToolLoader entry point. */
export function create(deps: ToolDeps): Tool {
  return make_batch_advance_misses(
    deps.db,
    deps.process_misses,
    deps.inbox,
    deps.events,
  ) as Tool;
}
