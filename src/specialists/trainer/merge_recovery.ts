/**
 * merge_recovery — staged self-heal for an owner-approved merge whose PR can't
 * land as-is.
 *
 * Before 2026-06-11 the merge dispatch had exactly one move: ask Gitea to merge
 * the PR. A branch that went stale between Kate's approval and the owner's
 * approval (main moved under it) came back 405-not-mergeable, the row parked at
 * `merge_failed`, and NOTHING re-drove it or told anyone — the media_library
 * twin sat silent for two days while the owner believed his approval had
 * landed. This module owns the recovery ladder, each rung cheaper-to-stronger:
 *
 *   1. direct merge                    — the happy path, unchanged.
 *   2. update branch from base + retry — Gitea's own "Update branch" (merge
 *      base into head); git's 3-way merge is the correctness proof. Resolves
 *      the stale-but-not-conflicting class.
 *   3. re-land from stored inputs      — `plan_reland` re-classifies the
 *      change's VERBATIM authoring inputs against current origin/main. Edits
 *      whose exact-unique old_string still matches re-apply semantically even
 *      where git's textual merge conflicts; the re-land rides `open_change_pr`
 *      (fresh branch, full checks gate), supersedes the conflicted row, and
 *      CARRIES Kate's verdict — justified because the inputs are byte-identical
 *      to what she reviewed, and re-run checks re-prove compile-correctness
 *      against the new base. A genuine content change never qualifies.
 *      `already_applied` (someone hand-landed the content) records reality as
 *      merged instead of failing forever.
 *   4. park + WAKING flag to Beatrice  — never silent. The flag names the
 *      change, the reason, and the re-author next step; the owner's approval
 *      of the CONTENT stands.
 *
 * The four merge gates are untouched: this runs only INSIDE the dispatch-only
 * `merge_approved_change` (post Kate-approval, post owner-approval), re-land
 * re-runs the deterministic checks, and a carried verdict requires
 * byte-identical inputs.
 */
import { ulid } from 'ulid';
import type { Database } from 'bun:sqlite';
import type { ChangeRecordsStore, ChangeRecord, KateVerdict } from '@memory/stores/change_records';
import type { SpecialistInbox } from '@memory/stores/conversations';
import type { AppEventBus } from '@app/events';
import {
  open_change_pr,
  plan_reland,
  run_git,
  set_pr_ready_and_merge,
  update_pr_branch,
  gitea_auth_env,
  PrNotMergeableError,
  REPO_ROOT,
  type GitConfig,
  type OpenChangeResult,
} from './change_pipeline';

export interface MergeRecoveryArgs {
  db: Database;
  store: ChangeRecordsStore;
  /** Must be `pending_owner_merge` with a non-null pr_number (caller-validated). */
  change: ChangeRecord;
  git: GitConfig;
  inbox?: SpecialistInbox;
  events?: AppEventBus;
}

export type MergeRecoveryOutcome =
  | {
      merged: true;
      /** The EFFECTIVE change row — the original, or the re-land row that superseded it. */
      change_id: string;
      pr_number: number | null;
      sha: string | null;
      via: 'direct' | 'branch_update' | 'reland' | 'already_applied';
      note: string;
    }
  | { merged: false; change_id: string; pr_number: number | null; reason: string; flagged: boolean };

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Terminal failure: park the row, wake Beatrice with a directive flag. Never silent. */
function park(
  args: MergeRecoveryArgs,
  change_id: string,
  pr_number: number | null,
  reason: string,
): MergeRecoveryOutcome {
  args.store.mark_merge_failed(change_id);
  let flagged = false;
  try {
    const flag_id = args.inbox?.push({
      from_specialist_id: 'orchestrator',
      to_specialist_id: 'trainer',
      kind: 'flag',
      body_md:
        `**Owner-approved merge could not land.** Change \`${change_id}\`` +
        (pr_number != null ? ` (PR #${pr_number})` : '') +
        ` is Kate-approved AND owner-approved, but the merge failed:\n\n${reason}\n\n` +
        `The owner already approved this CONTENT — do not re-litigate the decision. ` +
        `Re-author the SAME change against current origin/main (\`propose_code_edit\`, ` +
        `surgical old_string/new_string), cite the related proposal, and route it ` +
        `through review; main moved under the original branch.`,
      ...(args.change.related_proposal_id
        ? { related_proposal_id: args.change.related_proposal_id }
        : {}),
    });
    flagged = flag_id != null;
    if (flag_id) {
      args.events?.emit({
        type: 'inbox_message_added',
        message_id: flag_id,
        from_specialist_id: 'orchestrator',
        to_specialist_id: 'trainer',
        kind: 'flag',
        severity: 'high',
      });
    }
  } catch (err) {
    console.warn('[merge_recovery] park flag push failed (non-fatal):', msg(err));
  }
  return { merged: false, change_id, pr_number, reason, flagged };
}

export async function merge_with_recovery(args: MergeRecoveryArgs): Promise<MergeRecoveryOutcome> {
  const { change, git, store } = args;
  const pr = change.pr_number;
  if (pr == null) {
    return park(args, change.id, null, 'no PR number on the change record — cannot merge');
  }

  // ── Rung 1: direct merge ──────────────────────────────────────────────────
  try {
    const r = await set_pr_ready_and_merge(pr, git);
    store.mark_merged(change.id, r.sha);
    return { merged: true, change_id: change.id, pr_number: pr, sha: r.sha, via: 'direct', note: '' };
  } catch (err) {
    // Only a not-mergeable PR is recoverable below; auth/config/network is not.
    if (!(err instanceof PrNotMergeableError)) {
      return park(args, change.id, pr, `merge failed: ${msg(err)}`);
    }
  }

  // ── Rung 2: update the branch from base, retry the merge once ────────────
  try {
    const upd = await update_pr_branch(pr, git);
    if (upd.updated) {
      try {
        const r = await set_pr_ready_and_merge(pr, git);
        store.mark_merged(change.id, r.sha);
        return {
          merged: true, change_id: change.id, pr_number: pr, sha: r.sha, via: 'branch_update',
          note: `branch was stale; updated from ${git.base_branch} and merged.`,
        };
      } catch (err) {
        if (!(err instanceof PrNotMergeableError)) {
          return park(args, change.id, pr, `merge after branch update failed: ${msg(err)}`);
        }
        // still conflicted — fall through to the re-land rung
      }
    }
  } catch (err) {
    return park(args, change.id, pr, `branch update failed: ${msg(err)}`);
  }

  // ── Rung 3: re-land from the stored verbatim inputs ───────────────────────
  const inputs = change.change_inputs;
  if (!inputs || inputs.files.length + inputs.edits.length === 0) {
    return park(
      args, change.id, pr,
      `PR #${pr} conflicts with ${git.base_branch} and the change record carries no stored ` +
        `authoring inputs to re-land from (pre-2026-06-11 row).`,
    );
  }

  let plan: ReturnType<typeof plan_reland>;
  try {
    plan = plan_reland(inputs, git);
  } catch (err) {
    return park(args, change.id, pr, `re-land planning failed: ${msg(err)}`);
  }

  if (plan.verdict === 'already_applied') {
    // The approved content is already on main (landed externally / by hand).
    // Record reality instead of failing forever.
    let sha: string | null = null;
    try {
      sha = run_git(REPO_ROOT, ['rev-parse', `origin/${git.base_branch}`], gitea_auth_env(git)).stdout;
    } catch {
      /* sha best-effort */
    }
    store.mark_merged(change.id, sha);
    return {
      merged: true, change_id: change.id, pr_number: pr, sha, via: 'already_applied',
      note:
        `content is already on origin/${git.base_branch} (landed outside this PR) — ` +
        `recorded as merged.\n${plan.detail}`,
    };
  }

  if (plan.verdict === 'conflict') {
    return park(
      args, change.id, pr,
      `PR #${pr} conflicts with ${git.base_branch} and the approved inputs no longer apply ` +
        `cleanly:\n${plan.detail}`,
    );
  }

  // relandable: fresh branch + PR through the FULL pipeline (checks re-run).
  const base_branch_name = change.branch.replace(/-reland-[a-z0-9]+$/, '');
  const reland_branch = `${base_branch_name}-reland-${ulid().toLowerCase().slice(-6)}`;
  let opened: OpenChangeResult;
  try {
    opened = await open_change_pr({
      branch_name: reland_branch,
      pr_title: `re-land: ${change.change_kind}${change.target_specialist_id ? ` on ${change.target_specialist_id}` : ''} (${change.id})`,
      pr_body:
        `Re-land of approved change \`${change.id}\` (PR #${pr}), whose branch went stale ` +
        `against ${git.base_branch} between review and merge. Inputs are byte-identical to ` +
        `the reviewed change; checks re-run against current ${git.base_branch}.\n\n` +
        `Original rationale:\n${change.rationale_md}`,
      files: plan.needed.files,
      edits: plan.needed.edits,
      ...(change.related_proposal_id ? { related_proposal_id: change.related_proposal_id } : {}),
      triggered_by: 'merge_recovery',
      git,
      db: args.db,
    });
  } catch (err) {
    // Includes ChecksFailedError: the approved content no longer compiles
    // against the new base — a genuine semantic conflict the gate caught.
    return park(args, change.id, pr, `re-land could not open a clean PR: ${msg(err)}`);
  }

  const reland_row = store.create({
    origin: change.origin,
    change_kind: change.change_kind,
    target_specialist_id: change.target_specialist_id,
    branch: opened.branch,
    pr_number: opened.pr_number,
    pr_url: opened.pr_url,
    commit_sha: opened.commit_sha,
    files: opened.files_changed,
    lines_added: opened.lines_added,
    lines_removed: opened.lines_removed,
    languages: opened.languages,
    diff_summary: opened.diff_summary,
    diff_truncated: opened.diff_truncated,
    rationale_md:
      change.rationale_md +
      `\n\n_Re-land of \`${change.id}\` after a stale-PR merge conflict; byte-identical approved inputs._`,
    dedup_key: change.dedup_key,
    related_proposal_id: change.related_proposal_id,
    checks_passed: opened.checks_passed,
    checks_summary: opened.checks_summary,
    change_inputs: opened.change_inputs,
  });
  // create() supersedes via dedup_key when one exists; this covers key-less rows.
  store.mark_superseded(change.id, reland_row.id);

  // Carry Kate's verdict: inputs are byte-identical to what she approved and
  // the deterministic checks re-ran green against the new base. A 'deny' can
  // never reach here (the change was pending_owner_merge).
  const carried: KateVerdict =
    change.kate_verdict === 'approve_with_concerns' ? 'approve_with_concerns' : 'approve';
  store.set_kate_verdict(
    reland_row.id,
    carried,
    `Carried forward from ${change.id} — byte-identical approved inputs re-landed after the ` +
      `original PR went stale. Original review:\n${change.kate_reasons_md ?? '(none recorded)'}`,
  );

  try {
    const r = await set_pr_ready_and_merge(opened.pr_number, git);
    store.mark_merged(reland_row.id, r.sha);
    return {
      merged: true, change_id: reland_row.id, pr_number: opened.pr_number, sha: r.sha, via: 'reland',
      note:
        `original PR #${pr} conflicted; re-landed byte-identical inputs as PR ` +
        `#${opened.pr_number} (change ${reland_row.id}) with Kate's verdict carried forward.`,
    };
  } catch (err) {
    return park(
      args, reland_row.id, opened.pr_number,
      `re-land PR #${opened.pr_number} (fresh off ${git.base_branch}) also failed to merge: ${msg(err)}`,
    );
  }
}
