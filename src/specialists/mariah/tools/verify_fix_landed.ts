/**
 * verify_fix_landed — the loop-closer.
 *
 * After Beatrice ships a fix from a process_miss, somebody has to
 * confirm the fix actually closed the gap. Before this tool that was a
 * manual two-step: Mariah remembers which scan owned the pattern, asks
 * the orchestrator to re-run it, eyeballs the diff, then calls
 * advance_process_miss(close) on each cleared miss. World-class
 * autonomous PMs don't have time for that; the verify step is what
 * keeps the ledger from growing forever.
 *
 * This tool collapses the loop into one call:
 *
 *   1. Pick the candidate misses (by pattern, optionally narrowed to
 *      a subject specialist; or by an explicit miss_ids list).
 *   2. Invoke the scan that owns this pattern, in-process via the
 *      tool registry, with the verifier's capability set. The scan
 *      is idempotent on (evidence_ref) so re-running it costs only
 *      its read cost — it doesn't double-open anything.
 *   3. Read the fresh findings the scan returned. Build the set of
 *      evidence_refs the world is STILL emitting.
 *   4. Walk the candidates: any whose evidence_ref is NOT in the
 *      fresh set → fix landed → close with a "no longer flagged by
 *      fresh <scan>" note. Any whose ref IS still emitted → fix
 *      didn't take → leave open with a "still flagged after re-run"
 *      note so the next miss-walk catches it.
 *
 * Read-then-write. Cheap enough to run after every batch fix; the
 * scan cost dominates and that's already paid daily by background_job.
 */
import { z } from 'zod';
import { ulid } from 'ulid';
import type { Database } from 'bun:sqlite';
import type { Tool, ToolContext } from '@core/tool';
import type { ToolDeps } from '@core/tool_deps';
import {
  apply_miss_action,
  type ProcessMissRow,
  type ProcessMissStore,
} from '@core/process_misses';
import type { SpecialistInbox } from '@memory/stores/conversations';
import type { ToolRegistry } from '@core/tool_registry';
import type { MemoryClient } from '@memory/client';
import type { LLMRouter } from '@core/llm';

const InputSchema = z
  .object({
    /** Pattern segment from evidence_ref (e.g. `no-recovery-hint`,
     *  `fab-after-read-failure`, `dangling-tool`). Selects every OPEN
     *  miss whose evidence_ref matches `*:<pattern>:*`. */
    pattern: z.string().optional(),
    /** Optional: narrow to a single subject specialist. */
    subject_specialist_id: z.string().optional(),
    /** Optional: verify an explicit list of miss ids instead of a
     *  pattern selection. Use when verifying a curated set across
     *  patterns (e.g. all the misses Beatrice flagged on her PR). */
    miss_ids: z.array(z.string()).optional(),
    /** Override the scan to re-run. Defaults to the scan owning the
     *  pattern via PATTERN_TO_SCAN. Useful when verifying a manual
     *  process_miss not opened by a scan tool. */
    scan_name: z.string().optional(),
    /** When true, close misses with no fresh ref even if a different
     *  scan-time pattern took its place. Default false — conservative. */
    aggressive: z.coerce.boolean().optional(),
  })
  .refine((v) => !!(v.pattern || v.miss_ids), {
    message: 'verify_fix_landed requires either `pattern` or `miss_ids`',
  });

const PerMissResult = z.object({
  miss_id: z.string(),
  evidence_ref: z.string().nullable(),
  outcome: z.enum(['closed', 'still_open', 'skipped']),
  note: z.string(),
});

const OutputSchema = z.object({
  scan_run: z.string(),
  candidates_count: z.number(),
  fresh_evidence_refs_count: z.number(),
  closed_count: z.number(),
  still_open_count: z.number(),
  skipped_count: z.number(),
  results: z.array(PerMissResult),
  scan_error: z.string().optional(),
});

type Input = z.infer<typeof InputSchema>;
type Output = z.infer<typeof OutputSchema>;

/**
 * Maps an evidence_ref pattern segment to the scan tool that owns it.
 * When a future scan adds a new pattern, add the mapping here so
 * verify_fix_landed can route to the right re-run target without
 * relying on the LLM to guess.
 *
 * The full evidence_ref shape is `prefix:pattern:id`:
 *   - `auth:thinking-only-consult:<msg_id>` → authenticity scan
 *   - `auth:fab-after-read-failure:<msg_id>` → authenticity scan
 *   - `auth:fab-after-read-failure-consult:<intent_id>` → authenticity
 *   - `auth:consult-then-parrot:<msg_id>` → authenticity scan
 *   - `auth:empty-args:<msg_id>` → authenticity scan
 *   - `affordance:no-recovery-hint:<tool_name>` → connector audit
 *   - `roster:uncurated-chat:<id>` → alignment scan
 *   - `roster:dangling-tool:<id>` → alignment scan
 *   - `roster:persona-tool-gap:<id>` → alignment scan
 *   - `roster:idle:<id>` → alignment scan
 *   - `pattern:errors:<agent>:<tool>` → patterns scan
 *   - `pattern:repeated-miss-class:*` → patterns scan
 *   - `pattern:reasked-consult:*` → patterns scan
 */
const PATTERN_TO_SCAN: ReadonlyMap<string, string> = new Map([
  // authenticity
  ['thinking-only-consult', 'scan_specialist_authenticity'],
  ['fab-after-read-failure', 'scan_specialist_authenticity'],
  ['fab-after-read-failure-consult', 'scan_specialist_authenticity'],
  ['consult-then-parrot', 'scan_specialist_authenticity'],
  ['empty-args', 'scan_specialist_authenticity'],
  // connector affordances
  ['no-recovery-hint', 'audit_connector_affordances'],
  // expertise coverage (Beatrice's audit; refs `<specialist>:expertise:<axis>`)
  ['expertise', 'audit_specialist_expertise'],
  // alignment
  ['uncurated-chat', 'scan_specialist_alignment'],
  ['dangling-tool', 'scan_specialist_alignment'],
  ['persona-tool-gap', 'scan_specialist_alignment'],
  ['idle', 'scan_specialist_alignment'],
  // capability yield (refs `capability:yield:<tool>`) — re-running the scan
  // and finding the ref gone IS the proof a fix restored output, which is the
  // only honest close condition for a class that never had an error to fix.
  ['yield', 'scan_capability_yield'],
  // patterns
  ['errors', 'scan_program_patterns'],
  ['repeated-miss-class', 'scan_program_patterns'],
  ['reasked-consult', 'scan_program_patterns'],
]);

function pattern_of(evidence_ref: string | null): string | null {
  if (!evidence_ref) return null;
  const parts = evidence_ref.split(':');
  return parts.length >= 2 ? (parts[1] ?? null) : null;
}

/**
 * The scan tools return a result object with `misses_opened` (newly
 * opened this run) and `current_findings_refs` (every ref the scan
 * considers active right now, BEFORE the idempotency dedup against
 * existing process_misses). The union is the authoritative "what the
 * world still emits" set — a candidate miss whose ref is absent is
 * the signal that a fix landed and the miss can auto-close.
 *
 * An earlier version of this helper used "every open miss's ref" as a
 * proxy for the active set. That was wrong by construction: an open
 * miss whose connector got fixed is STILL in open status until verify
 * closes it, so its ref remained "active" by the proxy and the close
 * branch never fired. Bug surfaced during the 2026-05-25 validation
 * walkthrough; fix is to use the scan's `current_findings_refs`
 * directly. Scans without that field fall back to the proxy with a
 * console warning so the gap is visible.
 */
async function compute_fresh_ref_set(
  scan_name: string,
  registry: ToolRegistry,
  ctx: ToolContext,
  granted: ReadonlySet<string>,
  caller_id: string,
  misses: ProcessMissStore,
): Promise<{ refs: Set<string>; error?: string }> {
  const outcome = await registry.invoke(
    scan_name,
    {},
    ctx,
    granted,
    caller_id,
  );
  if (!outcome.ok) {
    return {
      refs: new Set(),
      error:
        `${scan_name} re-run failed: ${outcome.error ?? outcome.reason ?? 'unknown'}`,
    };
  }
  const refs = new Set<string>();
  const result = (outcome.result ?? {}) as {
    misses_opened?: Array<{ evidence_ref?: unknown }>;
    current_findings_refs?: unknown;
  };
  if (Array.isArray(result.misses_opened)) {
    for (const m of result.misses_opened) {
      if (m && typeof m.evidence_ref === 'string') refs.add(m.evidence_ref);
    }
  }
  if (Array.isArray(result.current_findings_refs)) {
    for (const r of result.current_findings_refs) {
      if (typeof r === 'string') refs.add(r);
    }
    return { refs };
  }
  // Fall-through: scan doesn't expose current_findings_refs yet.
  // Use the open-miss proxy and warn so the gap stays visible.
  console.warn(
    `[verify_fix_landed] ${scan_name} did not return current_findings_refs; ` +
      `using open-miss proxy (close path may under-fire — add the field to ` +
      `the scan's output to fix). See PATTERN_TO_SCAN map for affected scans.`,
  );
  for (const m of misses.list({ open_only: true })) {
    if (m.evidence_ref) refs.add(m.evidence_ref);
  }
  return { refs };
}

function make_verify_fix_landed(
  db: Database,
  misses: ProcessMissStore,
  inbox: SpecialistInbox,
  tools: ToolRegistry,
  memory: MemoryClient,
  llm: LLMRouter,
): Tool<Input, Output> {
  return {
    name: 'verify_fix_landed',
    description:
      'Close the loop on a routed/escalated fix. Pick candidate misses ' +
      "by `pattern` (e.g. 'no-recovery-hint', 'fab-after-read-failure') " +
      'and optionally narrow by `subject_specialist_id`, or pass an ' +
      'explicit `miss_ids` list. The tool re-runs the scan that owns ' +
      "this pattern (idempotent — safe to re-run), reads the fresh set " +
      'of evidence_refs the scan now emits, and auto-closes any ' +
      "candidate miss whose ref no longer appears — i.e. the fix " +
      "actually landed. Misses still flagged are left open with a note " +
      "so the next deliberation catches them. Returns per-miss outcomes " +
      'plus a verification summary. Cheap to call after every batch fix; ' +
      "the scan re-run cost is the same cost a background_job pays daily.",
    risk: 'write_internal',
    required_capabilities: ['write_process_miss', 'read_audit_log'],
    input_schema: InputSchema,
    output_schema: OutputSchema,

    idempotency_key(input) {
      const tag = input.pattern ?? (input.miss_ids ?? []).slice(0, 3).join(',');
      return `verify_fix_landed:${tag}`;
    },

    async execute(input, ctx: ToolContext): Promise<Output> {
      const caller_id = ctx.specialist_id ?? 'mariah';

      // ── Pick candidates ────────────────────────────────────────────
      let candidates: ProcessMissRow[];
      if (input.miss_ids && input.miss_ids.length > 0) {
        candidates = input.miss_ids
          .map((id) => misses.get(id))
          .filter((m): m is ProcessMissRow => Boolean(m && m.status !== 'closed'));
      } else {
        const where = ["status != 'closed'"];
        const params: Record<string, string> = {};
        if (input.subject_specialist_id) {
          where.push('subject_specialist_id = @subject');
          params['@subject'] = input.subject_specialist_id;
        }
        const all = db
          .prepare(`SELECT * FROM process_misses WHERE ${where.join(' AND ')}`)
          .all(params) as ProcessMissRow[];
        candidates = all.filter((m) => pattern_of(m.evidence_ref) === input.pattern);
      }

      // ── Pick the scan ──────────────────────────────────────────────
      const scan_name =
        input.scan_name ??
        (input.pattern ? PATTERN_TO_SCAN.get(input.pattern) : undefined);
      if (!scan_name) {
        return {
          scan_run: '(none)',
          candidates_count: candidates.length,
          fresh_evidence_refs_count: 0,
          closed_count: 0,
          still_open_count: candidates.length,
          skipped_count: candidates.length,
          results: candidates.map((m) => ({
            miss_id: m.id,
            evidence_ref: m.evidence_ref,
            outcome: 'skipped' as const,
            note: `no scan registered for pattern ${input.pattern ?? '(none)'}`,
          })),
        };
      }

      if (candidates.length === 0) {
        return {
          scan_run: scan_name,
          candidates_count: 0,
          fresh_evidence_refs_count: 0,
          closed_count: 0,
          still_open_count: 0,
          skipped_count: 0,
          results: [],
        };
      }

      // ── Re-run the scan with the verifier's caps ───────────────────
      // We use the caller's specialist_id + a derived capability set
      // that includes the scan's required cap. apply_miss_action
      // already trusts caller_id; mirror that contract here.
      const cap_set = new Set<string>([
        'write_process_miss',
        'read_audit_log',
        'read_vault',
        'read_home_assistant',
      ]);
      const fresh_ctx: ToolContext = {
        memory,
        llm,
        now: ctx.now ?? new Date(),
        intent_id: ctx.intent_id || ulid(),
        specialist_id: caller_id,
        conversation_id: ctx.conversation_id,
      };
      const { refs: fresh_refs, error: scan_error } = await compute_fresh_ref_set(
        scan_name,
        tools,
        fresh_ctx,
        cap_set,
        caller_id,
        misses,
      );

      if (scan_error) {
        return {
          scan_run: scan_name,
          candidates_count: candidates.length,
          fresh_evidence_refs_count: 0,
          closed_count: 0,
          still_open_count: candidates.length,
          skipped_count: candidates.length,
          results: candidates.map((m) => ({
            miss_id: m.id,
            evidence_ref: m.evidence_ref,
            outcome: 'skipped' as const,
            note: scan_error,
          })),
          scan_error,
        };
      }

      // ── Walk candidates, close the ones whose refs vanished ────────
      const results: z.infer<typeof PerMissResult>[] = [];
      let closed_count = 0;
      let still_open_count = 0;
      let skipped_count = 0;
      for (const m of candidates) {
        if (!m.evidence_ref) {
          results.push({
            miss_id: m.id,
            evidence_ref: null,
            outcome: 'skipped',
            note: 'miss has no evidence_ref — cannot auto-verify',
          });
          skipped_count++;
          continue;
        }
        const still_present = fresh_refs.has(m.evidence_ref);
        if (still_present) {
          results.push({
            miss_id: m.id,
            evidence_ref: m.evidence_ref,
            outcome: 'still_open',
            note: `still flagged by fresh ${scan_name} run — fix did not close this evidence_ref`,
          });
          still_open_count++;
          continue;
        }
        // Ref gone from fresh scan → fix landed. Close it.
        try {
          // close must be reached via the lifecycle. If the miss is
          // in a status that can't go directly to closed, route first
          // (legal from open/routed/verified) then close. Most
          // verify cases come from 'routed' which closes directly.
          if (m.status === 'open') {
            // open → closed is legal in MISS_TRANSITIONS.
            apply_miss_action({
              misses,
              inbox,
              miss_id: m.id,
              action: 'close',
              note:
                `verify_fix_landed: evidence_ref no longer emitted by ` +
                `${scan_name} after fix. Auto-closing.`,
              reporter: caller_id,
            });
          } else if (m.status === 'routed' || m.status === 'verified') {
            apply_miss_action({
              misses,
              inbox,
              miss_id: m.id,
              action: 'close',
              note:
                `verify_fix_landed: evidence_ref no longer emitted by ` +
                `${scan_name} after fix. Auto-closing.`,
              reporter: caller_id,
            });
          } else {
            // escalated / redo_dispatched. Verify first if needed,
            // then close. The transition table allows
            // redo_dispatched → verified → closed and escalated → closed.
            if (m.status === 'redo_dispatched') {
              apply_miss_action({
                misses,
                inbox,
                miss_id: m.id,
                action: 'verify',
                note: `verify_fix_landed: scan shows the gap closed.`,
                reporter: caller_id,
              });
            }
            apply_miss_action({
              misses,
              inbox,
              miss_id: m.id,
              action: 'close',
              note:
                `verify_fix_landed: evidence_ref no longer emitted by ` +
                `${scan_name} after fix. Auto-closing.`,
              reporter: caller_id,
            });
          }
          results.push({
            miss_id: m.id,
            evidence_ref: m.evidence_ref,
            outcome: 'closed',
            note: `verified — ${scan_name} no longer flags this ref`,
          });
          closed_count++;
        } catch (err) {
          results.push({
            miss_id: m.id,
            evidence_ref: m.evidence_ref,
            outcome: 'skipped',
            note: `close failed: ${err instanceof Error ? err.message : String(err)}`,
          });
          skipped_count++;
        }
      }

      return {
        scan_run: scan_name,
        candidates_count: candidates.length,
        fresh_evidence_refs_count: fresh_refs.size,
        closed_count,
        still_open_count,
        skipped_count,
        results,
      };
    },
  };
}

/** ToolLoader entry point. */
export function create(deps: ToolDeps): Tool {
  return make_verify_fix_landed(
    deps.db,
    deps.process_misses,
    deps.inbox,
    deps.tool_registry,
    deps.memory,
    deps.llm,
  ) as Tool;
}
