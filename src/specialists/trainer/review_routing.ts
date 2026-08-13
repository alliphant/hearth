/**
 * route_change_for_review — the shared tail for every change Beatrice makes.
 *
 * After `open_change_pr` opens the isolated branch+PR, this persists a
 * `beatrice_changes` record (status `pending_kate_review`) and flags Kate to
 * review it (wake-on-flag). Both `apply_low_risk_fix` (config) and
 * `propose_code_change` (code) call this, so EVERY Beatrice change flows
 * through the Kate skeptic gate and surfaces in the Code Shop office. Not a
 * tool — a helper, kept outside any `tools/` dir.
 */
import type { Database } from 'bun:sqlite';
import { ChangeRecordsStore, type ChangeRecord } from '@memory/stores/change_records';
import type { SpecialistInbox } from '@memory/stores/conversations';
import type { AppEventBus } from '@app/events';
import { commission_review_swarm } from '@core/review_swarm';
import type { OpenChangeResult } from './change_pipeline';

export interface RouteChangeArgs {
  db: Database;
  inbox: SpecialistInbox;
  events?: AppEventBus;
  result: OpenChangeResult;
  origin: string;
  change_kind: string;
  target_specialist_id?: string | null;
  rationale_md: string;
  dedup_key?: string | null;
  related_proposal_id?: string | null;
  gen_tokens_out?: number | null;
  gen_ms?: number | null;
  gen_tok_per_sec?: number | null;
  audit_id?: string | null;
}

export function route_change_for_review(
  args: RouteChangeArgs,
): { change: ChangeRecord; inbox_message_id: string } {
  const store = new ChangeRecordsStore(args.db);
  const change = store.create({
    origin: args.origin,
    change_kind: args.change_kind,
    target_specialist_id: args.target_specialist_id ?? null,
    branch: args.result.branch,
    pr_number: args.result.pr_number,
    pr_url: args.result.pr_url,
    commit_sha: args.result.commit_sha,
    files: args.result.files_changed,
    lines_added: args.result.lines_added,
    lines_removed: args.result.lines_removed,
    languages: args.result.languages,
    diff_summary: args.result.diff_summary,
    diff_truncated: args.result.diff_truncated,
    rationale_md: args.rationale_md,
    dedup_key: args.dedup_key ?? null,
    related_proposal_id: args.related_proposal_id ?? null,
    gen_tokens_out: args.gen_tokens_out ?? null,
    gen_ms: args.gen_ms ?? null,
    gen_tok_per_sec: args.gen_tok_per_sec ?? null,
    audit_id: args.audit_id ?? null,
    // The deterministic-gate verdict rides on the OpenChangeResult (a red change
    // never reaches here — it throws before the PR opens), so a routed change is
    // GREEN. Stored so Kate's review gate + the Code Shop card can read it.
    checks_passed: args.result.checks_passed,
    checks_summary: args.result.checks_summary,
    // Verbatim authoring inputs — merge recovery re-lands from these when the
    // PR goes stale between Kate's approval and the owner's merge.
    change_inputs: args.result.change_inputs,
  });

  const target = args.target_specialist_id ? ` on ${args.target_specialist_id}` : '';
  const langs = change.languages.join('/') || 'n/a';
  const checks_line =
    change.checks_passed === true
      ? '**Checks:** ✅ automated checks passed (tsc --noEmit + guard) — it compiles.\n'
      : change.checks_passed === false
        ? '**Checks:** ⛔ automated checks FAILED — do not approve.\n'
        : '';
  // Name the SINGLE change_id and tell Kate to review THIS one. She stalls when
  // several changes are queued and the flag says "review the queue"; a singular,
  // directive flag (handle this one, by id) keeps the trigger reliable. Compile-
  // correctness is the machine's job now (the checks line) — her review is for
  // design-correctness only, which is a far narrower call.
  const body_md =
    `**Beatrice opened a change for your skeptic review.** Review THIS change now: \`${change.id}\`.\n\n` +
    `**What:** ${args.change_kind}${target} (+${change.lines_added}/−${change.lines_removed}, ${langs})\n` +
    `**Branch:** \`${change.branch}\` · PR: ${change.pr_url ?? '(pending)'}\n` +
    checks_line +
    `\n**Rationale:** ${args.rationale_md}\n\n` +
    `Read its diff with \`list_changes_for_review\`, then call \`review_change\` with change_id \`${change.id}\` ` +
    '(approve / approve_with_concerns / deny). Automated checks already verified it compiles — your job is ' +
    "DESIGN-correctness: deny anything that could harm HEARTH, isn't justified by the rationale, exceeds the " +
    "stated scope, or you can't verify from the diff. If other changes are also queued, handle this ONE first.";

  const inbox_message_id = args.inbox.push({
    from_specialist_id: 'trainer',
    to_specialist_id: 'kate',
    kind: 'flag',
    body_md,
  });
  args.events?.emit({
    type: 'inbox_message_added',
    message_id: inbox_message_id,
    from_specialist_id: 'trainer',
    to_specialist_id: 'kate',
    kind: 'flag',
    severity: 'high',
  });

  // Review swarm (2026-07-21) — a red/blue/judge bench reviews this change in the
  // background and reports its findings to Kate + the live bee icon. Inform-only
  // (Kate still rules, the owner still merges); DARK behind HEARTH_REVIEW_SWARM,
  // so this is a no-op until the flag is set. Fire-and-forget — never blocks.
  commission_review_swarm({
    change_id: change.id,
    change_kind: args.change_kind,
    user_id: null,
  });

  return { change, inbox_message_id };
}
