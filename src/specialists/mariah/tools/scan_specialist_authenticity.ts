/**
 * scan_specialist_authenticity — Mariah's behavioral roster check.
 *
 * Siblings:
 *   - scan_program_health    — work that FAILED (proposals, follow-ups)
 *   - scan_program_patterns  — behaviour that DRIFTED across turns
 *   - scan_specialist_alignment — CONFIGURATION misalignment (the layer
 *     under failed work)
 *
 * This one catches the layer under BOTH: turns that **looked** like they
 * answered the user but didn't actually do the work. The fabrication-
 * shaped failure mode — the one Iris hit on 2026-05-25 when she guessed
 * four entity_ids, 404'd four times, and replied with a percentage
 * anyway — wouldn't trip any of the three other scans. It's an
 * authentic-tool-call problem, and it has its own signal pool.
 *
 * Four deterministic patterns mined from `messages` + `audit_log`:
 *
 *   - thinking_only_consult — `messages.reasoning_trace_md` committed
 *     to consulting a peer ("I'll ask Iris") but no matching
 *     consult_specialist call landed in `tool_calls_json`. The
 *     SpecialistRuntime live guard catches this going forward; this
 *     scan retrospectively surfaces instances that slipped through
 *     before the guard existed (or after a future regression).
 *
 *   - consult_then_parrot — a `consult_specialist` call returned an
 *     empty/diagnostic answer ("[X produced no answer — ...]") OR a
 *     trivially short body, AND the calling specialist's visible
 *     reply was substantive (>300 chars). The reply was unbacked.
 *
 *   - fabrication_after_read_failure — a `ha_get_state` (or similar
 *     read) errored or returned a null state, and the same turn had
 *     no recovery read on a related entity, but produced a non-empty
 *     reply. The exact Iris 2026-05-25 pattern.
 *
 *   - empty_args_call — a tool with a non-empty input schema was
 *     invoked with `{}`. The Qwen drop-args-to-{} wall, structurally;
 *     scan_specialist_alignment catches uncurated surfaces but this
 *     catches the actual mis-fills that result.
 *
 * Each finding opens a process_miss keyed by a stable evidence_ref
 * (intent_id + pattern), so re-runs never double-flag. Routes through
 * the existing closed loop: Beatrice picks up persona/config patterns
 * via her usual escalation path. Runs daily as Mariah's 04:45
 * background job; also invocable directly for ad-hoc audits.
 */
import { z } from 'zod';
import type { Database } from 'bun:sqlite';
import type { Tool, ToolContext } from '@core/tool';
import type { ToolDeps } from '@core/tool_deps';
import type {
  ProcessMissSeverity,
  ProcessMissStore,
} from '@core/process_misses';
import type { SpecialistRegistry } from '@core/specialist';
import type { ToolRegistry } from '@core/tool_registry';
import type { AppEventBus } from '@app/events';
import {
  build_peer_name_to_id,
  compute_score,
  describe_failed_read,
  empty_tally,
  had_recovery_read,
  is_duplicate_call_entry,
  is_empty_args_call,
  is_empty_consult_result,
  is_failed_read,
  record_finding,
  unfulfilled_thinking_consults,
  type AuthenticityTally,
  type SerializedToolCall,
} from '@core/authenticity';

const InputSchema = z.object({
  // Lookback window. Optional, not `.default()` — keeps Tool<I,O>'s
  // input/output types aligned. Default applied in execute().
  lookback_hours: z.coerce.number().int().positive().max(24 * 30).optional(),
});

const DEFAULT_LOOKBACK_HOURS = 24;

/**
 * Minimum visible-reply length (chars) to consider a turn "substantive"
 * for the consult_then_parrot pattern. Shorter than this, the
 * specialist might just be acknowledging the empty consult ("nothing
 * back from Iris yet"), which isn't a parrot. 300 chars ≈ 50-60
 * words — about three sentences.
 */
const SUBSTANTIVE_REPLY_CHARS = 300;

type Pattern =
  | 'thinking_only_consult'
  | 'consult_then_parrot'
  | 'fabrication_after_read_failure'
  | 'empty_args_call'
  | 'retry_storm';

const OpenedSchema = z.object({
  miss_id: z.string(),
  subject_specialist_id: z.string(),
  pattern: z.string(),
  evidence_ref: z.string(),
});

const ScorePersistedSchema = z.object({
  specialist_id: z.string(),
  score: z.number().int().min(0).max(100),
});

const OutputSchema = z.object({
  messages_scanned: z.number(),
  consult_turns_scanned: z.number(),
  thinking_only_consult_seen: z.number(),
  consult_then_parrot_seen: z.number(),
  fabrication_after_read_failure_seen: z.number(),
  empty_args_call_seen: z.number(),
  retry_storm_seen: z.number(),
  already_tracked: z.number(),
  misses_opened: z.array(OpenedSchema),
  scores_persisted: z.array(ScorePersistedSchema),
  /** Every evidence_ref this scan would emit on this run, BEFORE the
   *  idempotency dedup. Used by verify_fix_landed to know which refs
   *  the scan currently considers active so a closed-by-reality miss
   *  can auto-close. See audit_connector_affordances for the rationale. */
  current_findings_refs: z.array(z.string()),
});

type Input = z.infer<typeof InputSchema>;
type Output = z.infer<typeof OutputSchema>;

interface MessageRow {
  id: string;
  conversation_id: string;
  ts: string;
  role: string;
  specialist_id: string | null;
  content_md: string;
  tool_calls_json: string | null;
  reasoning_trace_md: string | null;
}

/**
 * Tools whose input schema accepts `{}` — calling them with no args is
 * valid by contract, not a drop-args bug. Derived from the registry's
 * Zod schemas (the authority — `input_schema.safeParse({})`), NOT a
 * hand-list: the hand-list this replaced was missing `weather_now`
 * (every field optional; location resolves from user context), which
 * filed an empty_args_call miss against Kate on every correct no-arg
 * weather read — 8 false positives in the first June 2026 week. A
 * schema that can't be probed is treated as zero-arg-OK: never flag
 * what we can't verify.
 */
function zero_arg_ok_tools(tools: ToolRegistry): ReadonlySet<string> {
  const ok = new Set<string>();
  for (const t of tools.list()) {
    try {
      if (t.input_schema.safeParse({}).success) ok.add(t.name);
    } catch {
      ok.add(t.name);
    }
  }
  return ok;
}

/**
 * Duplicate-flagged calls in one turn before it counts as a retry
 * storm. 1–2 repeats happen to good models on long turns; 3+ means
 * the loop is stuck re-calling even though the runtime serves each
 * repeat from cache.
 */
const RETRY_STORM_MIN_DUPES = 3;

function make_scan_specialist_authenticity(
  db: Database,
  specialists: SpecialistRegistry,
  tools: ToolRegistry,
  misses: ProcessMissStore,
  events: AppEventBus | undefined,
): Tool<Input, Output> {
  return {
    name: 'scan_specialist_authenticity',
    description:
      'Mariah\'s behavioral roster check. Mine the last N hours of ' +
      'specialist turns for fabrication-shaped patterns the structural ' +
      'scans miss: a thinking-only consult commitment that never landed ' +
      'in the tool channel; a consult that returned no answer and was ' +
      'parroted anyway; a read tool that errored with no recovery and a ' +
      'substantive reply produced anyway; a tool call with empty args ' +
      '(the Qwen drop-args wall in practice). Opens a process_miss per ' +
      'finding, idempotent on (intent_id + pattern) — safe to re-run. ' +
      'Default lookback is 24 hours.',
    risk: 'write_internal',
    required_capabilities: ['write_process_miss'],
    input_schema: InputSchema,
    output_schema: OutputSchema,

    idempotency_key() {
      return 'scan_specialist_authenticity';
    },

    async execute(input, ctx: ToolContext): Promise<Output> {
      const now = ctx.now ?? new Date();
      const lookback_hours = input.lookback_hours ?? DEFAULT_LOOKBACK_HOURS;
      const since_iso = new Date(
        now.getTime() - lookback_hours * 3_600_000,
      ).toISOString();

      const tracked = new Set<string>();
      for (const m of misses.list()) {
        if (m.evidence_ref) tracked.add(m.evidence_ref);
      }

      const peer_map = build_peer_name_to_id(specialists);
      const valid_specialist_ids = new Set(
        specialists.list().map((s) => s.id),
      );

      // Pull every specialist-role message in the window. tool_calls_json
      // carries the per-turn results (including errors), so we don't
      // need a separate audit_log walk for the four patterns we're
      // detecting — they're all visible in messages.
      const rows = db
        .prepare(
          `SELECT id, conversation_id, ts, role, specialist_id,
                  content_md, tool_calls_json, reasoning_trace_md
             FROM messages
            WHERE role = 'specialist'
              AND ts >= @since
            ORDER BY ts ASC`,
        )
        .all({ '@since': since_iso }) as MessageRow[];

      const opened: z.infer<typeof OpenedSchema>[] = [];
      const current_findings_refs: string[] = [];
      let already = 0;
      let thinking_only_consult_seen = 0;
      let consult_then_parrot_seen = 0;
      let fabrication_after_read_failure_seen = 0;
      let empty_args_call_seen = 0;
      let retry_storm_seen = 0;
      // Schema-derived "calling with {} is valid" set — see
      // zero_arg_ok_tools(). Built once per scan run; the registry is
      // hot-reloaded so a fresh run always sees the current contracts.
      const zero_arg_ok = zero_arg_ok_tools(tools);

      // Per-specialist tallies for score computation at the end of the
      // scan. Lazily created when we first touch a specialist so we don't
      // emit zero-score rows for specialists with no activity in the
      // window (those keep their last computed score).
      const tallies = new Map<string, AuthenticityTally>();
      function tally_for(sid: string): AuthenticityTally {
        let t = tallies.get(sid);
        if (!t) { t = empty_tally(); tallies.set(sid, t); }
        return t;
      }

      for (const row of rows) {
        const sid = row.specialist_id;
        if (!sid || !valid_specialist_ids.has(sid)) continue;
        const specialist = specialists.get(sid);
        if (!specialist) continue;
        tally_for(sid).turns++;

        let tool_calls: SerializedToolCall[] = [];
        if (row.tool_calls_json) {
          try {
            const parsed = JSON.parse(row.tool_calls_json) as unknown;
            if (Array.isArray(parsed)) tool_calls = parsed as SerializedToolCall[];
          } catch {
            // Bad JSON — skip the tool-related patterns for this row.
            tool_calls = [];
          }
        }

        // ── A. thinking_only_consult ─────────────────────────────────
        if (row.reasoning_trace_md && row.reasoning_trace_md.trim().length > 0) {
          const orphans = unfulfilled_thinking_consults(
            row.reasoning_trace_md,
            tool_calls,
            peer_map,
          );
          if (orphans.length > 0) {
            thinking_only_consult_seen++;
            record_finding(tally_for(sid), 'thinking_only_consult');
            const ref = `auth:thinking-only-consult:${row.id}`;
            current_findings_refs.push(ref);
            if (tracked.has(ref)) {
              already++;
            } else {
              const orphan_list = orphans.join(', ');
              const reply_preview = row.content_md.slice(0, 180);
              const gap =
                `${specialist.name}'s reasoning trace committed to ` +
                `consulting ${orphan_list} but no matching ` +
                `consult_specialist call landed in this turn's tool ` +
                `channel. The visible reply was produced as if the ` +
                `consult had happened: "${reply_preview}${row.content_md.length > 180 ? '…' : ''}". ` +
                `Thinking is private deliberation; commitments only ` +
                `become real through the tool channel. The runtime's ` +
                `ghost-promise guard catches this live going forward — ` +
                `this finding flags an instance that slipped past it ` +
                `(or predates it). If Mariah sees a cluster of these ` +
                `from one specialist, the persona's thinking-to-action ` +
                `discipline is the layer to fix; escalate to Beatrice.`;
              const miss_id = misses.create({
                subject_specialist_id: sid,
                reporter: 'mariah',
                task_summary:
                  `${specialist.name} honoring the consults their thinking commits to`,
                gap,
                severity: 'high' satisfies ProcessMissSeverity,
                evidence_ref: ref,
              });
              opened.push({
                miss_id,
                subject_specialist_id: sid,
                pattern: 'thinking_only_consult' satisfies Pattern,
                evidence_ref: ref,
              });
            }
          }
        }

        // ── B. consult_then_parrot ───────────────────────────────────
        // For each empty consult result in this turn, if the visible
        // reply is substantive (>300 chars), flag — the reply was
        // produced without the consult's value backing it.
        const empty_consults = tool_calls.filter(
          (c) => c.name === 'consult_specialist' && is_empty_consult_result(c.result),
        );
        if (
          empty_consults.length > 0 &&
          row.content_md.trim().length > SUBSTANTIVE_REPLY_CHARS
        ) {
          consult_then_parrot_seen++;
          record_finding(tally_for(sid), 'consult_then_parrot');
          const ref = `auth:consult-then-parrot:${row.id}`;
          current_findings_refs.push(ref);
          if (tracked.has(ref)) {
            already++;
          } else {
            const peers_asked = empty_consults
              .map((c) => {
                const a = (c.input ?? {}) as { specialist_id?: string };
                return a.specialist_id ?? '?';
              })
              .join(', ');
            const reply_preview = row.content_md.slice(0, 200);
            const gap =
              `${specialist.name} consulted ${peers_asked} this turn; the ` +
              `consult(s) returned no usable answer (empty or "produced ` +
              `no answer" diagnostic). The visible reply was ` +
              `${row.content_md.length} chars: "${reply_preview}${row.content_md.length > 200 ? '…' : ''}". ` +
              `When a consult comes back empty, the right shapes are: ` +
              `(a) attribute it cleanly to the user ("Iris is offline / ` +
              `didn't have data — let me try directly"), then do the ` +
              `read yourself, or (b) ask the user for what the peer ` +
              `would have answered. A substantive reply built on an ` +
              `empty consult is unbacked.`;
            const miss_id = misses.create({
              subject_specialist_id: sid,
              reporter: 'mariah',
              task_summary:
                `${specialist.name} backing their reply with verified data, ` +
                `not paraphrasing an empty consult`,
              gap,
              severity: 'high' satisfies ProcessMissSeverity,
              evidence_ref: ref,
            });
            opened.push({
              miss_id,
              subject_specialist_id: sid,
              pattern: 'consult_then_parrot' satisfies Pattern,
              evidence_ref: ref,
            });
          }
        }

        // ── C. fabrication_after_read_failure ────────────────────────
        // For each failed read in this turn, check whether a later
        // tool call recovered. Only flag when at least one read failed
        // AND no recovery AND the reply is non-empty (the specialist
        // chose to answer rather than report the read failure).
        const failures: SerializedToolCall[] = [];
        for (let i = 0; i < tool_calls.length; i++) {
          const c = tool_calls[i];
          if (!c) continue;
          if (!is_failed_read(c.name, c.result, c.error)) continue;
          const later = tool_calls.slice(i + 1);
          if (!had_recovery_read(c, later)) failures.push(c);
        }
        if (failures.length > 0 && row.content_md.trim().length > 0) {
          fabrication_after_read_failure_seen++;
          record_finding(tally_for(sid), 'fabrication_after_read_failure');
          const ref = `auth:fab-after-read-failure:${row.id}`;
          current_findings_refs.push(ref);
          if (tracked.has(ref)) {
            already++;
          } else {
            const fail_summary = failures
              .slice(0, 3)
              .map((c) => describe_failed_read(c))
              .join('; ');
            const reply_preview = row.content_md.slice(0, 200);
            const gap =
              `${specialist.name} had ${failures.length} read failure(s) ` +
              `with no recovery in this turn: ${fail_summary}. The ` +
              `visible reply was produced anyway: ` +
              `"${reply_preview}${row.content_md.length > 200 ? '…' : ''}". ` +
              `For ha_get_state 404s the connector now returns ` +
              `\`candidates\` — the right move is to retry against one ` +
              `of those instead of answering from a guess. If the ` +
              `connector returned a real error (timeout, 401, 500), ` +
              `the right move is to surface that to the user, not ` +
              `manufacture a plausible value.`;
            const miss_id = misses.create({
              subject_specialist_id: sid,
              reporter: 'mariah',
              task_summary:
                `${specialist.name} recovering from read failures via ` +
                `retry or honest report, not fabrication`,
              gap,
              severity: 'high' satisfies ProcessMissSeverity,
              evidence_ref: ref,
            });
            opened.push({
              miss_id,
              subject_specialist_id: sid,
              pattern: 'fabrication_after_read_failure' satisfies Pattern,
              evidence_ref: ref,
            });
          }
        }

        // ── D. empty_args_call ───────────────────────────────────────
        // Only judge tools the registry knows: an unregistered name
        // (retired tool, inline meta-tool) has no schema to check, and
        // we never flag what we can't verify.
        const empty_args = tool_calls.filter(
          (c) =>
            tools.get(c.name) !== undefined &&
            is_empty_args_call(c.name, c.input, zero_arg_ok),
        );
        if (empty_args.length > 0) {
          empty_args_call_seen++;
          record_finding(tally_for(sid), 'empty_args_call');
          const ref = `auth:empty-args:${row.id}`;
          current_findings_refs.push(ref);
          if (tracked.has(ref)) {
            already++;
          } else {
            const which = empty_args
              .map((c) => c.name)
              .slice(0, 5)
              .join(', ');
            const gap =
              `${specialist.name} emitted ${empty_args.length} tool ` +
              `call(s) with empty arguments this turn: ${which}. This ` +
              `is the Qwen3.6 drop-args-to-{} wall manifesting at the ` +
              `call site — usually a symptom of too many tools in scope, ` +
              `a schema with $refs the parser stumbles on, or a tool ` +
              `description that doesn't make the parameters obvious. ` +
              `Cross-check scan_specialist_alignment for an uncurated ` +
              `tool surface; if curated, look at the offending tool's ` +
              `input_schema for refs / unions / undescribed enums.`;
            const miss_id = misses.create({
              subject_specialist_id: sid,
              reporter: 'mariah',
              task_summary:
                `${specialist.name}'s tool-call args landing populated, ` +
                `not dropped to {}`,
              gap,
              severity: 'medium' satisfies ProcessMissSeverity,
              evidence_ref: ref,
            });
            opened.push({
              miss_id,
              subject_specialist_id: sid,
              pattern: 'empty_args_call' satisfies Pattern,
              evidence_ref: ref,
            });
          }
        }

        // ── D2. retry_storm ──────────────────────────────────────────
        // ≥3 duplicate-flagged calls in one turn: the model kept
        // repeating identical calls even though the runtime served each
        // repeat from cache (or, for failed originals, re-rejected
        // them). Low severity — a storm wastes rounds but fabricates
        // nothing; the structural fixes are tool-surface curation and
        // result salience, not persona lectures. This is the honest
        // home for behavior the fabrication pattern used to
        // false-flag.
        const dup_entries = tool_calls.filter((c) => is_duplicate_call_entry(c));
        if (dup_entries.length >= RETRY_STORM_MIN_DUPES) {
          retry_storm_seen++;
          record_finding(tally_for(sid), 'retry_storm');
          const ref = `auth:retry-storm:${row.id}`;
          current_findings_refs.push(ref);
          if (tracked.has(ref)) {
            already++;
          } else {
            const by_tool = new Map<string, number>();
            for (const c of dup_entries) {
              by_tool.set(c.name, (by_tool.get(c.name) ?? 0) + 1);
            }
            const which = [...by_tool.entries()]
              .sort((a, b) => b[1] - a[1])
              .slice(0, 3)
              .map(([name, n]) => `${name}×${n}`)
              .join(', ');
            const gap =
              `${specialist.name} repeated ${dup_entries.length} identical ` +
              `tool call(s) in one turn (${which}); the runtime served each ` +
              `repeat from its per-turn cache. Wasted rounds, not ` +
              `fabrication — but a storm this size usually means the tool's ` +
              `result wasn't salient enough to act on, the surface is too ` +
              `broad, or the workflow needs a ranged/scoped read. ` +
              `Cross-check the tool's output shape and the specialist's ` +
              `curated surface before reaching for persona text.`;
            const miss_id = misses.create({
              subject_specialist_id: sid,
              reporter: 'mariah',
              task_summary:
                `${specialist.name} acting on a tool result the first time ` +
                `instead of re-calling it`,
              gap,
              severity: 'low' satisfies ProcessMissSeverity,
              evidence_ref: ref,
            });
            opened.push({
              miss_id,
              subject_specialist_id: sid,
              pattern: 'retry_storm' satisfies Pattern,
              evidence_ref: ref,
            });
          }
        }
      }

      // ── E. consult-turn fabrications (audit_log walk) ────────────────
      // SpecialistRuntime.consult() runs the consultee's turn against an
      // ephemeral conversation_id (`consult:<ulid>`), which never
      // persists to `messages`. So a consult-reply turn — exactly where
      // Iris fabricated "Wallbox CPH50" and "95 minutes" — is invisible
      // to the `messages` walk above. The audit_log still has the full
      // tool-call trace for those turns; we walk the `specialist_turn`
      // rows whose conversation_id starts with `consult:` and apply the
      // fabrication_after_read_failure pattern there.
      const consult_turn_rows = db
        .prepare(
          `SELECT id, ts, intent_id, agent, tool_input, execution_result
             FROM audit_log
            WHERE tool_name = 'specialist_turn'
              AND ts >= @since
            ORDER BY ts ASC`,
        )
        .all({ '@since': since_iso }) as Array<{
        id: string;
        ts: string;
        intent_id: string;
        agent: string;
        tool_input: string;
        execution_result: string | null;
      }>;

      // Per-intent-id tool-call timeline from audit_log, in order.
      const tool_calls_by_intent = new Map<string, SerializedToolCall[]>();
      const tool_call_rows = db
        .prepare(
          `SELECT intent_id, tool_name, tool_input, execution_result, error
             FROM audit_log
            WHERE ts >= @since
              AND tool_name NOT IN (
                'specialist_turn', 'rag_retrieval',
                'awareness_observation', 'deliberation_pass',
                'llm_error', 'turn_cancelled', 'blank_turn_fallback',
                'ghost_promise_guard', 'same_tool_spiral_exhaust',
                'read_failure_guard', 'fabricated_save_guard', 'provenance_guard'
              )
            ORDER BY ts ASC`,
        )
        .all({ '@since': since_iso }) as Array<{
        intent_id: string;
        tool_name: string;
        tool_input: string | null;
        execution_result: string | null;
        error: string | null;
      }>;
      for (const r of tool_call_rows) {
        let input: unknown;
        let result: unknown;
        try { input = r.tool_input ? JSON.parse(r.tool_input) : null; } catch { input = null; }
        try { result = r.execution_result ? JSON.parse(r.execution_result) : null; } catch { result = null; }
        const list = tool_calls_by_intent.get(r.intent_id) ?? [];
        list.push({
          name: r.tool_name,
          input,
          result,
          ...(r.error ? { error: r.error } : {}),
        });
        tool_calls_by_intent.set(r.intent_id, list);
      }

      let consult_turns_scanned = 0;
      for (const turn of consult_turn_rows) {
        let ti: { conversation_id?: string } = {};
        try { ti = turn.tool_input ? JSON.parse(turn.tool_input) : {}; } catch { ti = {}; }
        // Only consult-turns — direct user-facing turns are covered by
        // the messages walk above.
        if (!ti.conversation_id || !ti.conversation_id.startsWith('consult:')) continue;
        const sid = turn.agent;
        if (!valid_specialist_ids.has(sid)) continue;
        const specialist = specialists.get(sid);
        if (!specialist) continue;
        consult_turns_scanned++;
        tally_for(sid).turns++;

        const calls = tool_calls_by_intent.get(turn.intent_id) ?? [];

        // Fabrication-after-read-failure on consult turns. Iris's exact
        // shape on 2026-05-25: 4 ha_get_state 404s with no recovery,
        // then a substantive (fabricated) reply pushed back through
        // the inbox to Kate.
        const failures: SerializedToolCall[] = [];
        for (let i = 0; i < calls.length; i++) {
          const c = calls[i];
          if (!c) continue;
          if (!is_failed_read(c.name, c.result, c.error)) continue;
          if (!had_recovery_read(c, calls.slice(i + 1))) failures.push(c);
        }
        if (failures.length === 0) continue;

        fabrication_after_read_failure_seen++;
        record_finding(tally_for(sid), 'fabrication_after_read_failure');
        const ref = `auth:fab-after-read-failure-consult:${turn.intent_id}`;
        current_findings_refs.push(ref);
        if (tracked.has(ref)) {
          already++;
          continue;
        }
        const fail_summary = failures
          .slice(0, 3)
          .map((c) => describe_failed_read(c))
          .join('; ');
        const gap =
          `${specialist.name} answered a consult with ${failures.length} ` +
          `unrecovered read failure(s) in the same turn: ${fail_summary}. ` +
          `The reply went back to the requester via the inbox; the ` +
          `requester then has no way to know the answer wasn't backed by ` +
          `live data. This is the upstream source of the consult-then- ` +
          `parrot pattern downstream specialists hit. For ha_get_state ` +
          `404s the connector now returns \`candidates\` — retry against ` +
          `one of those. For real read failures (timeout, 401, 500), say ` +
          `so in the consult reply so the requester can route around it.`;
        const miss_id = misses.create({
          subject_specialist_id: sid,
          reporter: 'mariah',
          task_summary:
            `${specialist.name} answering consults from live data, ` +
            `not from guesses after read failures`,
          gap,
          severity: 'high' satisfies ProcessMissSeverity,
          evidence_ref: ref,
        });
        opened.push({
          miss_id,
          subject_specialist_id: sid,
          pattern: 'fabrication_after_read_failure' satisfies Pattern,
          evidence_ref: ref,
        });
      }

      // ── Score computation + persistence ──────────────────────────────
      // For every specialist that had at least one turn in the window,
      // compute a 0-100 score, upsert the row, and emit an SSE event
      // so /app's staff rail can refresh the badge live. Specialists
      // with zero activity keep their last computed score (don't blow
      // it away with a placeholder).
      const ts_computed = now.toISOString();
      const score_upsert = db.prepare(
        `INSERT INTO authenticity_scores
           (specialist_id, ts_computed, score, lookback_hours,
            turns_in_window, signals_json)
         VALUES (@sid, @ts, @score, @lh, @turns, @signals)
         ON CONFLICT(specialist_id) DO UPDATE SET
           ts_computed = @ts,
           score = @score,
           lookback_hours = @lh,
           turns_in_window = @turns,
           signals_json = @signals`,
      );
      const scores_persisted: Array<{ specialist_id: string; score: number }> = [];
      for (const [sid, tally] of tallies) {
        const score = compute_score(tally);
        const signals = JSON.stringify({
          turns: tally.turns,
          by_pattern: tally.by_pattern,
          by_severity: tally.by_severity,
        });
        score_upsert.run({
          '@sid': sid,
          '@ts': ts_computed,
          '@score': score,
          '@lh': lookback_hours,
          '@turns': tally.turns,
          '@signals': signals,
        });
        scores_persisted.push({ specialist_id: sid, score });
        events?.emit({
          type: 'authenticity_updated',
          specialist_id: sid,
          score,
          ts_computed,
        });
      }

      return {
        messages_scanned: rows.length,
        consult_turns_scanned,
        thinking_only_consult_seen,
        consult_then_parrot_seen,
        fabrication_after_read_failure_seen,
        empty_args_call_seen,
        retry_storm_seen,
        already_tracked: already,
        misses_opened: opened,
        scores_persisted,
        current_findings_refs,
      };
    },
  };
}

/** ToolLoader entry point. */
export function create(deps: ToolDeps): Tool {
  return make_scan_specialist_authenticity(
    deps.db,
    deps.specialists,
    deps.tool_registry,
    deps.process_misses,
    deps.events,
  ) as Tool;
}
