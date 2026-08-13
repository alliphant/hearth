/**
 * Case Driver — own every process miss to proven closure (Incident→Immunity
 * S1, 2026-07-02; design: docs/design-incident-to-immunity.md).
 *
 * The ledger, the diagnosis tools, the change pipeline, and verify_fix_landed
 * all exist — but nothing WALKS a case through them, so misses stall between
 * hopeful handoffs (the regex-pattern fix sat uncommitted nine days while
 * main carried the live bug). This driver is the deterministic walker:
 *
 *   - NUDGE   — a stale `open`/`routed` miss gets ONE directed scoped wake
 *               at the meta-agent that owns the next step
 *               (trainer for fixing, per the closed-loop docs), naming the
 *               exact pm_ids + the expected next tool. Never wake-and-hope:
 *               the wake rides wake_deliberation_scoped's debounce +
 *               min-interval spine, and a durable `[case-driver]` marker in
 *               notes_md enforces the per-miss cooldown across restarts.
 *   - VERIFY  — a stale `redo_dispatched` miss (a fix was dispatched; nobody
 *               confirmed it landed) wakes MARIAH with her verify tools —
 *               closure comes from evidence (`verify_fix_landed` re-runs the
 *               owning scan), never from optimism.
 *   - ESCALATE— a miss still stale after `max_nudges` driver nudges is
 *               escalated ONCE: the existing `escalate` action (status
 *               machine + inbox flag via apply_miss_action at the tool
 *               layer is the LLM path; the driver uses the store's own
 *               transition) + ONE aggregate owner proposal naming the stuck
 *               cases. No nagging — escalated misses are skipped thereafter.
 *
 * Contracts (mirror the reactive-trigger + guard-feedback spines):
 *   - DETERMINISTIC: the driver itself makes no LLM calls; model steps are
 *     the directed wakes it fires (thinking governed by the S4 resolver —
 *     the 2026-07-02 bench found think-OFF equal at 1/14th the latency, so
 *     nothing here forces think-ON).
 *   - EDGE-ONLY per miss: markers in notes_md make every driver action
 *     idempotent across runs and restarts.
 *   - META-LOOP SAFE: wakes go ONLY to the meta-agents (trainer/mariah,
 *     whose JOB is the ledger); misses REPORTED BY the driver's own wake
 *     targets about themselves are skipped (no Beatrice-diagnoses-Beatrice).
 *   - FAIL-OPEN per miss: one bad row never stops the walk.
 *   - DARK: HEARTH_CASE_DRIVER=1 enables; off → no-op, byte-identical.
 */

import type { ProcessMissStore, ProcessMissRow } from './process_misses';
import type { ProposalsStore } from './proposals';

export function case_driver_enabled(): boolean {
  return process.env.HEARTH_CASE_DRIVER === '1';
}

function stall_days(): number {
  const n = Number(process.env.HEARTH_CASE_STALL_DAYS ?? 3);
  return Number.isFinite(n) && n > 0 ? n : 3;
}

function nudge_cooldown_days(): number {
  const n = Number(process.env.HEARTH_CASE_NUDGE_COOLDOWN_DAYS ?? 2);
  return Number.isFinite(n) && n > 0 ? n : 2;
}

function max_nudges(): number {
  const n = Number(process.env.HEARTH_CASE_MAX_NUDGES ?? 2);
  return Number.isFinite(n) && n > 0 ? n : 2;
}

/** Ids per wake — a directive listing 40 misses is noise, not focus. */
const IDS_PER_WAKE = 5;

/** A defect class seen this many times in the window is not bad luck. */
function recur_min_count(): number {
  const n = Number(process.env.HEARTH_CASE_RECUR_MIN ?? 3);
  return Number.isFinite(n) && n >= 2 ? n : 3;
}
function recur_window_days(): number {
  const n = Number(process.env.HEARTH_CASE_RECUR_WINDOW_DAYS ?? 14);
  return Number.isFinite(n) && n > 0 ? n : 14;
}
/** Classes per pass — one real repair beats five queued ones. */
const CLASSES_PER_PASS = 2;

const NUDGE_MARKER = '[case-driver] nudge';
const ESCALATE_MARKER = '[case-driver] escalated';
const RECUR_MARKER = '[case-driver] recurrence';

/** The meta-agents the driver may wake. Never a domain specialist. */
const FIX_OWNER = 'trainer';
const VERIFY_OWNER = 'mariah';

export interface ScopedWake {
  task: string;
  reason: string;
  dedupe_key: string;
  think?: boolean;
  min_interval_ms?: number;
}

export interface CaseDriverDeps {
  misses: ProcessMissStore;
  proposals: ProposalsStore;
  /** LoopDriver.wake_deliberation_scoped, injected at wiring time. */
  wake: (specialist_id: string, opts: ScopedWake) => void;
}

export interface CaseDriverResult {
  enabled: boolean;
  examined: number;
  nudged: string[];
  verify_swept: string[];
  escalated: string[];
  skipped_meta: number;
  /** Defect classes escalated from redo to repair this pass. */
  repairs_requested: string[];
}

function driver_marker_times(row: ProcessMissRow, marker: string): number[] {
  // note_line renders "- [<iso>] status -> status: <text>"; recover the
  // timestamps for our own markers to enforce cooldowns durably.
  const out: number[] = [];
  for (const line of row.notes_md.split('\n')) {
    if (!line.includes(marker)) continue;
    const m = line.match(/\[(\d{4}-\d{2}-\d{2}T[^\]]+)\]/);
    if (m) {
      const t = Date.parse(m[1]!);
      if (Number.isFinite(t)) out.push(t);
    }
  }
  return out;
}

function is_stale(row: ProcessMissRow, now_ms: number): boolean {
  const updated = Date.parse(row.ts_updated);
  if (!Number.isFinite(updated)) return true;
  return now_ms - updated >= stall_days() * 86_400_000;
}

function fmt_miss(row: ProcessMissRow): string {
  return `${row.id} (${row.subject_specialist_id}: ${truncate(row.gap, 90)})`;
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1).trimEnd()}…`;
}

/**
 * One driver pass. Pure orchestration over the deps — no LLM, no network.
 */
export function run_case_driver(
  deps: CaseDriverDeps,
  opts?: { now?: Date },
): CaseDriverResult {
  const result: CaseDriverResult = {
    enabled: case_driver_enabled(),
    examined: 0,
    nudged: [],
    verify_swept: [],
    escalated: [],
    skipped_meta: 0,
    repairs_requested: [],
  };
  if (!result.enabled) return result;
  const now_ms = (opts?.now ?? new Date()).getTime();
  const cooldown_ms = nudge_cooldown_days() * 86_400_000;

  const open = deps.misses.list({ open_only: true });
  const nudge_bucket: ProcessMissRow[] = [];
  const verify_bucket: ProcessMissRow[] = [];
  const escalate_bucket: ProcessMissRow[] = [];

  for (const row of open) {
    try {
      result.examined++;
      // Meta-loop guard: never drive a wake target to work a miss ABOUT
      // itself that IT reported (self-referential churn). Misses about a
      // meta-agent filed by others still flow.
      if (
        (row.subject_specialist_id === FIX_OWNER && row.reporter === FIX_OWNER) ||
        (row.subject_specialist_id === VERIFY_OWNER && row.reporter === VERIFY_OWNER)
      ) {
        result.skipped_meta++;
        continue;
      }
      if (row.status === 'escalated' || row.status === 'verified') continue;
      if (!is_stale(row, now_ms)) continue;

      const nudges = driver_marker_times(row, NUDGE_MARKER);
      const last_nudge = nudges.length > 0 ? Math.max(...nudges) : 0;
      const escalated_before = driver_marker_times(row, ESCALATE_MARKER).length > 0;
      if (escalated_before) continue; // escalate-once: we already rang the bell

      if (nudges.length >= max_nudges()) {
        escalate_bucket.push(row);
        continue;
      }
      if (now_ms - last_nudge < cooldown_ms) continue; // cooling down

      if (row.status === 'redo_dispatched') verify_bucket.push(row);
      else nudge_bucket.push(row); // open | routed
    } catch (err) {
      console.error(`[case-driver] miss ${row.id} failed (fail-open):`, err);
    }
  }

  // ── NUDGE: one directed think-ON wake at the fix owner ─────────────────
  if (nudge_bucket.length > 0) {
    const batch = nudge_bucket.slice(0, IDS_PER_WAKE);
    try {
      deps.wake(FIX_OWNER, {
        task:
          `Case Driver: these process misses have had no movement for ${stall_days()}+ days. ` +
          `For each, run the diagnostic that fits (diagnose_dependency for a dependency:* ref, ` +
          `diagnose_tool_failure for a tool/guard ref, analyze_systemic_pattern for a cluster), ` +
          `then file the fix through your normal pipeline. The misses:\n` +
          batch.map((r) => `- ${fmt_miss(r)}`).join('\n'),
        reason: `case-driver: ${batch.length} stale case(s) with no movement`,
        dedupe_key: 'case-driver:nudge',
        // think deliberately NOT forced: the 2026-07-02 bench showed no
        // accuracy gain from think-ON on this task family; the scrutiny env
        // (HEARTH_SCRUTINY_THINK) remains the owner's per-deploy dial.
      });
      for (const r of batch) {
        deps.misses.annotate(r.id, `${NUDGE_MARKER} #${driver_marker_times(r, NUDGE_MARKER).length + 1} → ${FIX_OWNER}`);
        result.nudged.push(r.id);
      }
    } catch (err) {
      console.error('[case-driver] nudge wake failed (fail-open):', err);
    }
  }

  // ── VERIFY: one directed think-ON wake at the verifier ─────────────────
  if (verify_bucket.length > 0) {
    const batch = verify_bucket.slice(0, IDS_PER_WAKE);
    try {
      deps.wake(VERIFY_OWNER, {
        task:
          `Case Driver: a fix was dispatched for these misses but nobody confirmed it landed. ` +
          `Run verify_fix_landed for each (it re-runs the owning scan) and close what comes back ` +
          `clean via batch_advance_misses; anything still failing goes back to trainer with what ` +
          `you saw. The misses:\n` +
          batch.map((r) => `- ${fmt_miss(r)}`).join('\n'),
        reason: `case-driver: ${batch.length} dispatched fix(es) awaiting verification`,
        dedupe_key: 'case-driver:verify',
      });
      for (const r of batch) {
        deps.misses.annotate(r.id, `${NUDGE_MARKER} #${driver_marker_times(r, NUDGE_MARKER).length + 1} → ${VERIFY_OWNER} (verify)`);
        result.verify_swept.push(r.id);
      }
    } catch (err) {
      console.error('[case-driver] verify wake failed (fail-open):', err);
    }
  }

  // ── ESCALATE-ONCE: the bell rings one time, then silence ───────────────
  if (escalate_bucket.length > 0) {
    try {
      deps.proposals.create({
        specialist_id: 'kate',
        kind: 'recommendation',
        execution_kind: 'manual',
        payload: {
          description:
            `${escalate_bucket.length} case(s) are stuck after ${max_nudges()} automated nudges — ` +
            `they need a human call (re-scope, descope, or unblock):\n` +
            escalate_bucket.map((r) => `- ${fmt_miss(r)} [status: ${r.status}]`).join('\n'),
        },
        rationale:
          `Case Driver stall escalation: each of these misses sat ${stall_days()}+ days per hop ` +
          `despite ${max_nudges()} directed nudges. Escalating once, then holding — no further ` +
          `automated action until a human moves them.`,
        signature: {
          specialist_id: 'kate',
          kind: 'recommendation',
          category: 'case_driver_stall',
          anchor: escalate_bucket.map((r) => r.id).sort().join(','),
        },
        user_id: null,
      });
      for (const r of escalate_bucket) {
        try {
          deps.misses.update_status(r.id, 'escalated', 'case-driver: stall escalation to owner');
          deps.misses.annotate(r.id, ESCALATE_MARKER);
          result.escalated.push(r.id);
        } catch (err) {
          // An illegal transition (e.g. verified) just skips — the walk survives.
          console.error(`[case-driver] escalate ${r.id} failed (fail-open):`, err);
        }
      }
    } catch (err) {
      console.error('[case-driver] escalation proposal failed (fail-open):', err);
    }
  }

  // ── REPAIR: a defect that keeps coming back doesn't need another redo ────
  // Every bucket above measures STALENESS — a miss sitting too long in one
  // state. That misses the failure mode this ledger actually exhibits: misses
  // close promptly and the same defect returns next week, so nothing is ever
  // stale and nothing is ever escalated (934 misses, 0 escalations, while one
  // class recurred 13 times in 18 days). This pass measures RECURRENCE
  // instead, and asks for the durable fix — a persona, tool or artifact
  // change — rather than a fourteenth redo.
  try {
    const classes = deps.misses.recurring_classes({
      window_days: recur_window_days(),
      min_count: recur_min_count(),
    });
    for (const klass of classes) {
      if (result.repairs_requested.length >= CLASSES_PER_PASS) break;
      // Meta-loop guard, same contract as the staleness buckets.
      if (klass.subject_specialist_id === FIX_OWNER) {
        const all_self = klass.ids.every((id) => {
          const row = deps.misses.get(id);
          return row?.reporter === FIX_OWNER;
        });
        if (all_self) {
          result.skipped_meta++;
          continue;
        }
      }
      // Once per class per window: the marker lives on the NEWEST row in the
      // class, so a class that recurs again after a repair lands on a fresh
      // row and is eligible to ring again — which is exactly the signal that
      // the repair did not work.
      const newest = deps.misses.get(klass.ids[0]!);
      if (!newest || driver_marker_times(newest, RECUR_MARKER).length > 0) continue;

      const span_days = Math.max(
        1,
        Math.round((Date.parse(klass.last_ts) - Date.parse(klass.first_ts)) / 86_400_000),
      );
      deps.wake(FIX_OWNER, {
        task:
          `Case Driver: ${klass.subject_specialist_id} has hit the SAME defect ` +
          `${klass.count} times in ${span_days} day(s), and every one of them was ` +
          `closed by a redo. The redo is working and the defect is not fixed, so ` +
          `stop redoing and repair the cause: run analyze_systemic_pattern over ` +
          `these, decide whether it is a persona, tool, capability or missing ` +
          `artifact problem, and file the change through your normal pipeline.\n` +
          `Defect class: ${klass.signature}\n` +
          `Representative gap: ${truncate(klass.sample_gap, 240)}\n` +
          `Misses: ${klass.ids.slice(0, IDS_PER_WAKE).join(', ')}`,
        reason: `case-driver: ${klass.subject_specialist_id} recurrence x${klass.count}`,
        dedupe_key: `case-driver:repair:${klass.subject_specialist_id}:${klass.signature}`,
      });
      deps.misses.annotate(
        newest.id,
        `${RECUR_MARKER} x${klass.count}/${span_days}d → ${FIX_OWNER} (repair, not redo)`,
      );
      result.repairs_requested.push(`${klass.subject_specialist_id}:${klass.signature}`);
    }
  } catch (err) {
    console.error('[case-driver] recurrence pass failed (fail-open):', err);
  }

  return result;
}
