/**
 * get_research_investigation — Kate reads back one deep-research dossier
 * (2026-06-19).
 *
 * Returns the synthesized dossier markdown when done, or the live progress
 * (sub-questions + status) while it runs. Cordon-respecting: a caller may
 * only read their own investigation (the owner has NO god-view) — a miss
 * returns a not-found shape, never leaking that it exists. Read-only.
 *
 * Carries the COVERAGE ledger (v2 phase 2) and steers the reply toward naming
 * the facets that were not established. A dossier read back as if it answered
 * everything is the F1 failure arriving in conversation instead of in a file.
 */
import { z } from 'zod';
import type { Tool, ToolContext } from '@core/tool';
import type { ToolDeps } from '@core/tool_deps';
import { note_visible_to_caller, type Caller } from '@memory/private_to';
import { coverage_summary_line } from '@core/research_coverage';
import { ResearchInvestigationStore } from '@memory/stores/research_investigations';
import {
  investigation_runner_deps_from,
  type InvestigationRunnerDeps,
} from '../research_investigation_runner';

const InputSchema = z.object({
  investigation_id: z.string().describe('The ri_… id from deep_research / list_research_investigations.'),
});

const OutputSchema = z.object({
  found: z.boolean(),
  investigation_id: z.string().optional(),
  subject: z.string().optional(),
  status: z.string().optional(),
  sub_questions: z.array(z.string()).optional(),
  /** The synthesized cited dossier markdown — present when status is done, and
   *  on `incomplete` (a partial report is honest and readable). */
  dossier_md: z.string().optional(),
  dossier_note_path: z.string().optional(),
  dropped_claims: z.array(z.string()).optional(),
  /** Claims that failed verification. Flagged, not deleted — so this is the
   *  only place a failed claim reaches Kate. */
  verdicts: z
    .array(z.object({ claim: z.string(), verdict: z.string(), reason: z.string() }))
    .optional(),
  /** Per-facet coverage — what was established and what was NOT. The dossier
   *  opens with the same ledger; this is the machine-readable copy. */
  coverage: z
    .array(
      z.object({
        question: z.string(),
        status: z.string(),
        reason: z.string().optional(),
      }),
    )
    .optional(),
  coverage_summary: z.string().optional(),
  progress_log: z.array(z.string()).optional(),
  next_action: z.string(),
});

type Input = z.infer<typeof InputSchema>;
type Output = z.infer<typeof OutputSchema>;

export function make_get_research_investigation(
  deps: InvestigationRunnerDeps,
): Tool<Input, Output> {
  return {
    name: 'get_research_investigation',
    description:
      'Read back one deep-research investigation by id — the finished cited dossier (status done) or its live progress while it runs. Use it when the user asks what you found, or after an inbox FYI says a dossier is ready, so you can speak the findings back grounded in the report.',
    risk: 'read',
    required_capabilities: ['deep_research'],
    input_schema: InputSchema,
    output_schema: OutputSchema,

    idempotency_key(input) {
      return `get_research_investigation:${input.investigation_id}`;
    },

    async execute(input, ctx: ToolContext): Promise<Output> {
      const store = new ResearchInvestigationStore(deps.library_deps.db);
      const row = store.get(input.investigation_id);
      const caller: Caller = { user_id: ctx.user?.id, tier: ctx.user?.tier ?? 'friend' };
      // Cordon: own investigation OR private_to visible. A miss is "not found"
      // (never 403-style) so we don't leak that someone else's exists.
      const visible =
        row !== null &&
        (row.requested_by === caller.user_id ||
          note_visible_to_caller(row.private_to ?? undefined, caller));
      if (!row || !visible) {
        return {
          found: false,
          next_action: 'No investigation with that id for this user — check list_research_investigations.',
        };
      }
      const done = row.status === 'done';
      // `incomplete` carries a real partial dossier plus a ledger naming the
      // facets that were never attempted. Hand both back: a partial report the
      // reader can see is the whole point of the ledger.
      const partial = row.status === 'incomplete';
      // A STALLED run also carries a real partial dossier, and the stalled
      // branch of next_action below tells Kate to say "what it did establish" —
      // so withholding dossier_md here would instruct her to describe something
      // she was not given, and she would either say nothing or invent it. The
      // two must agree. 2026-08-01.
      const stalled = row.status === 'stalled';
      const facets = row.coverage?.facets ?? [];
      const unresolved = facets.filter((f) => f.status !== 'answered');
      return {
        found: true,
        investigation_id: row.id,
        subject: row.subject,
        status: row.status,
        sub_questions: (row.plan?.sub_questions ?? []).map((q) => q.question),
        ...((done || partial || stalled) && row.dossier_md ? { dossier_md: row.dossier_md } : {}),
        ...(row.dossier_note_path ? { dossier_note_path: row.dossier_note_path } : {}),
        ...(row.verification ? { dropped_claims: row.verification.dropped_claims } : {}),
        // Kate speaks from this. The verifier flags rather than drops, so a
        // failed claim reaches her ONLY here — `dropped_claims` is empty by
        // design now. 2026-07-31.
        ...(row.verification && row.verification.verdicts.length > 0
          ? {
              verdicts: row.verification.verdicts.map((v) => ({
                claim: v.claim,
                verdict: v.verdict,
                reason: v.reason,
              })),
            }
          : {}),
        ...(facets.length > 0
          ? {
              coverage: facets.map((f) => ({
                question: f.question,
                status: f.status,
                ...(f.reason !== undefined ? { reason: f.reason } : {}),
              })),
              coverage_summary: coverage_summary_line(row.coverage),
            }
          : {}),
        progress_log: row.state.log ?? [],
        next_action: done
          ? unresolved.length > 0
            ? `The dossier is ready but does NOT cover everything asked — ${coverage_summary_line(row.coverage)}. ` +
              'Read the findings back grounded in dossier_md, and say plainly which facets were not established ' +
              `(${unresolved.map((f) => f.question).join('; ')}). Never imply coverage the report lacks.`
            : 'The dossier is ready — read the findings back to the user, grounded in dossier_md; cite where useful.'
          : partial
            ? `A PARTIAL dossier exists and the remaining facets are being retried — ${coverage_summary_line(row.coverage)}. ` +
              'You can share what is established now, but say it is incomplete and name what is still open.'
            : stalled
              // A stalled run is NOT underway, and saying it is would be the
              // same false-reassurance class the rest of this subsystem exists
              // to kill: the owner would wait for a report that is never coming.
              ? `This investigation has STALLED — it stopped making progress ` +
                `(${coverage_summary_line(row.coverage)}) and is waiting on a decision from ` +
                `the user, not on more work. Tell them plainly that it stopped, what it did ` +
                `establish, and offer the three ways forward: keep going with a bigger ` +
                `budget (re-run the same subject at exhaustive depth and it RESUMES this ` +
                `same investigation), narrow it to the one question that matters most, or ` +
                `stop and keep the partial report.`
              : `Still ${row.status} — tell the user it's underway and you'll report back when the full dossier lands.`,
      };
    },
  };
}

export function create(deps: ToolDeps): Tool {
  return make_get_research_investigation(investigation_runner_deps_from(deps)) as Tool;
}
