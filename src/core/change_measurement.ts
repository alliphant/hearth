/**
 * change_measurement — did the change we just made actually make things better?
 * (2026-08-01)
 *
 * Hearth could APPLY automated changes (a role swap, a low-risk config fix, a
 * merged Beatrice PR) and it could UNDO some of them by hand, but nothing ever
 * MEASURED one. A change landed and the system moved on; if it made behavior
 * worse, the only way anyone found out was the next time the worse behavior
 * happened to be noticed. This closes that: every automated change opens a
 * window carrying a metric baseline, and the next eval run scores it.
 *
 * THE ARBITER IS A DELTA ON THE SAME TASK SET — never an absolute pass rate.
 * The live golden suite is a standing mix of passing
 * and known-failing tasks, so any absolute threshold is meaningless: "below
 * 90%" fires forever and "below 70%" never fires. (This header used to cite
 * "around 110/151" as that mix. Corrected 2026-08-05: the production
 * `eval_runs` history shows the nightly running 14–20 distinct tasks per night
 * going back to at least 2026-07-25, never 151. The reasoning is unaffected —
 * a small standing mix makes an absolute threshold MORE meaningless, not less —
 * but the number was wrong, and it is the number a reader would use to judge
 * whether `min_comparable_tasks` is set sanely.) What is meaningful is that a
 * task which passed BEFORE the change fails AFTER it, on the same task, same
 * assertions. Tasks present in only one side are excluded from the comparison
 * entirely rather than counted as changes — a newly-added golden task is not
 * evidence about a config swap that predates it.
 *
 * IT FLAGS BEFORE IT REVERTS. `HEARTH_AUTO_REVERT` is opt-in and default OFF,
 * deliberately mirroring `HEARTH_RESEARCH_VERIFY_DROP`: verification there
 * surfaces verdicts and only DELETES dossier lines once precision has been
 * measured against real data, because an automated actor that destroys work on
 * a wrong verdict is worse than one that reports. Same logic here — a reverter
 * that misreads a flaky task undoes a good change, and the flake rate of this
 * suite against a live model is exactly what we have not measured yet.
 *
 * Pure and deterministic: no LLM, no I/O. The store supplies the rows.
 */

/** One task's outcome at a point in time. */
export type TaskOutcomes = Map<string, boolean>;

export type ChangeVerdict =
  /** Some task went pass → fail and none went the other way. */
  | 'regressed'
  /** Some task went fail → pass and none regressed. */
  | 'improved'
  /** Both directions, or neither — no clean signal. */
  | 'neutral'
  /** Too few comparable tasks to say anything honest. */
  | 'inconclusive';

export interface ChangeDelta {
  verdict: ChangeVerdict;
  /** Tasks present in BOTH sets — the only ones that can carry evidence. */
  compared: number;
  regressed_tasks: string[];
  improved_tasks: string[];
  unchanged: number;
  /** Present in only one side; excluded from the verdict, reported for honesty. */
  skipped_tasks: string[];
  summary: string;
}

export function auto_revert_enabled(): boolean {
  return process.env.HEARTH_AUTO_REVERT === '1';
}

function int_env(name: string, dflt: number, lo: number, hi: number): number {
  const raw = Number.parseInt(process.env[name] ?? '', 10);
  const v = Number.isFinite(raw) && raw > 0 ? raw : dflt;
  return Math.max(lo, Math.min(v, hi));
}

/** Minimum comparable tasks before any verdict but `inconclusive`. */
export function min_comparable_tasks(): number {
  return int_env('HEARTH_CHANGE_MIN_TASKS', 5, 1, 500);
}

/**
 * Compare a change's baseline against the outcomes measured after it.
 *
 * Only tasks in BOTH maps are compared. A task added or removed between the two
 * runs is reported in `skipped_tasks` and excluded — counting it either way
 * would attribute the suite's own churn to the change.
 */
export function measure_delta(baseline: TaskOutcomes, after: TaskOutcomes): ChangeDelta {
  const regressed_tasks: string[] = [];
  const improved_tasks: string[] = [];
  const skipped_tasks: string[] = [];
  let compared = 0;
  let unchanged = 0;

  for (const [task, before] of baseline) {
    if (!after.has(task)) {
      skipped_tasks.push(task);
      continue;
    }
    compared += 1;
    const now = after.get(task)!;
    if (before && !now) regressed_tasks.push(task);
    else if (!before && now) improved_tasks.push(task);
    else unchanged += 1;
  }
  for (const task of after.keys()) {
    if (!baseline.has(task)) skipped_tasks.push(task);
  }

  regressed_tasks.sort();
  improved_tasks.sort();
  skipped_tasks.sort();

  let verdict: ChangeVerdict;
  let summary: string;
  if (compared < min_comparable_tasks()) {
    verdict = 'inconclusive';
    summary =
      `Only ${compared} task(s) ran both before and after the change (floor is ` +
      `${min_comparable_tasks()}) — not enough to judge it either way.`;
  } else if (regressed_tasks.length > 0 && improved_tasks.length === 0) {
    verdict = 'regressed';
    summary =
      `${regressed_tasks.length} of ${compared} comparable task(s) went PASS → FAIL after this ` +
      `change and none improved: ${regressed_tasks.join(', ')}.`;
  } else if (improved_tasks.length > 0 && regressed_tasks.length === 0) {
    verdict = 'improved';
    summary =
      `${improved_tasks.length} of ${compared} comparable task(s) went FAIL → PASS after this ` +
      `change and none regressed: ${improved_tasks.join(', ')}.`;
  } else if (regressed_tasks.length > 0) {
    // Mixed is NEUTRAL, not regressed: a change that fixes two things and
    // breaks one is a judgment call, and reverting it automatically would be
    // the reverter making that call on its own.
    verdict = 'neutral';
    summary =
      `Mixed: ${improved_tasks.length} improved (${improved_tasks.join(', ')}), ` +
      `${regressed_tasks.length} regressed (${regressed_tasks.join(', ')}) across ${compared} ` +
      `comparable task(s) — a trade-off, not a clean regression. Yours to call.`;
  } else {
    verdict = 'neutral';
    summary = `No task changed outcome across ${compared} comparable task(s).`;
  }

  return { verdict, compared, regressed_tasks, improved_tasks, unchanged, skipped_tasks, summary };
}

/** Change kinds and whether an automated actor can mechanically undo them. */
export type ChangeKind =
  | 'llm_role_override'
  | 'low_risk_fix'
  | 'code_merge'
  /**
   * A Tier-1 skill graduating shadow → active (2026-08-04). It IS an automated
   * change to behavior — the specialist's prompt now carries a procedure it
   * treats as settled rather than provisional — and before this it was the only
   * automated change in the system that opened no window, so the delta arbiter
   * was blind to the entire learning layer.
   *
   * Deliberately NOT machine-revertible below, even though retiring a skill is a
   * one-row update with an exact prior (i.e. the same shape as the role
   * override). Auto-revert is opt-in and has never run against this kind; a
   * reverter that misreads a flaky task and silently un-learns something the
   * specialist earned over three uses is worse than one that reports. Escalate
   * first, arm later if the flake rate turns out to justify it.
   */
  | 'skill_graduation'
  | 'other';

/**
 * Can this kind be reverted by a machine, right now, with no judgment?
 *
 * ONLY the role override qualifies. Lifting it is a single row update with an
 * exact recorded prior, and it takes effect on the next request. Everything
 * else is escalate-only:
 *  - `low_risk_fix` HAS an inverse (`revert_low_risk_fix`) but that inverse
 *    routes through open_change_pr → Kate review → owner merge, so it is not
 *    something this can perform; naming it in the escalation is the useful act.
 *  - `code_merge` needs `git revert <sha>` against a shared main, which is a
 *    human's call and always will be.
 */
export function is_machine_revertible(kind: ChangeKind): boolean {
  return kind === 'llm_role_override';
}
