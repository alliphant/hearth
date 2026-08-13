/**
 * merge_approved_change — Beatrice merges a change the owner approved.
 *
 * This is the OTHER side of the propose/merge gate. `propose_code_change` and
 * `apply_low_risk_fix` open isolated branches/PRs; Kate skeptic-reviews them;
 * the owner approves the merge from the Code Shop office. That approval is a
 * `recommendation` proposal whose dispatch payload invokes THIS tool as trainer.
 *
 * Two structural safeties make the merge non-bypassable:
 *   1. `dispatch_only: true` — the tool is NEVER on Beatrice's (or anyone's)
 *      LLM-callable surface. The only caller is the proposal dispatch path,
 *      which runs only after the owner-tier `decide` cordon.
 *   2. It hard-refuses any change whose status isn't `pending_owner_merge` —
 *      and only Kate's `review_change(approve)` moves a row there. So a change
 *      Kate hasn't approved can never be merged, even if this tool is reached.
 *
 * Idempotent: an already-merged change returns its stored result.
 */
import { z } from 'zod';
import type { Tool, ToolContext } from '@core/tool';
import type { ToolDeps } from '@core/tool_deps';
import { ChangeRecordsStore } from '@memory/stores/change_records';
import { resolve_git_config, run_git, REPO_ROOT } from '../change_pipeline';
import { merge_with_recovery } from '../merge_recovery';
import { CodeShopSettings } from '@memory/stores/codeshop_settings';
import { request_deploy } from '@connectors/ops_relay';

const InputSchema = z.object({ change_id: z.string().min(1) });

const OutputSchema = z.object({
  merged: z.boolean(),
  change_id: z.string(),
  pr_number: z.number().nullable(),
  merged_sha: z.string().nullable(),
  deploy_class: z.enum(['config_hot_reload', 'code_restart', 'none']),
  reason: z.string().optional(),
});

type Input = z.infer<typeof InputSchema>;
type Output = z.infer<typeof OutputSchema>;

/** Config-only changes hot-reload after a pull; any other src/ file needs a restart. */
function classify(files: string[]): 'config_hot_reload' | 'code_restart' | 'none' {
  if (files.length === 0) return 'none';
  const all_hot = files.every((f) => f.startsWith('config/') || f.startsWith('src/app/client/'));
  return all_hot ? 'config_hot_reload' : 'code_restart';
}

export function create(deps: ToolDeps): Tool {
  const store = new ChangeRecordsStore(deps.db);
  const tool: Tool<Input, Output> = {
    name: 'merge_approved_change',
    description:
      "Merge a Beatrice change that Kate approved AND the owner approved in the Code Shop office. Refuses any change not in 'pending_owner_merge'. Dispatch-only — runs solely via the owner-approved proposal, never from a chat/deliberation turn.",
    risk: 'write_internal',
    required_capabilities: ['merge_codebase_pr'],
    dispatch_only: true,
    input_schema: InputSchema,
    output_schema: OutputSchema,

    idempotency_key: (i) => `merge_approved_change:${i.change_id}`,

    async execute(input, ctx: ToolContext): Promise<Output> {
      const change = store.get(input.change_id);
      if (!change) {
        return {
          merged: false, change_id: input.change_id, pr_number: null, merged_sha: null,
          deploy_class: 'none', reason: `no change record ${input.change_id}`,
        };
      }
      if (change.status === 'merged') {
        return {
          merged: true, change_id: change.id, pr_number: change.pr_number,
          merged_sha: change.merged_sha, deploy_class: classify(change.files),
          reason: 'already merged (idempotent no-op)',
        };
      }
      // The gate: only a Kate-approved, owner-approved change can merge.
      if (change.status !== 'pending_owner_merge') {
        return {
          merged: false, change_id: change.id, pr_number: change.pr_number, merged_sha: null,
          deploy_class: 'none',
          reason: `refused: change is '${change.status}', not 'pending_owner_merge'. Kate must approve it first.`,
        };
      }
      const git = resolve_git_config(deps.db);
      // Staged recovery (2026-06-11): direct merge → update-branch retry →
      // re-land from stored inputs (Kate verdict carried; checks re-run) →
      // park + WAKING flag to Beatrice. Never a silent merge_failed again —
      // the media_library twin sat stuck for two days with no signal. The
      // outcome's change_id is the EFFECTIVE row (a re-land supersedes the
      // original), so everything downstream reads through it.
      const outcome = await merge_with_recovery({
        db: deps.db,
        store,
        change,
        git,
        ...(deps.inbox ? { inbox: deps.inbox } : {}),
        ...(deps.events ? { events: deps.events } : {}),
      });

      if (!outcome.merged) {
        ctx.memory.log_action({
          intent_id: ctx.intent_id,
          agent: ctx.specialist_id ?? 'trainer',
          tool_name: 'merge_approved_change',
          tool_input: { change_id: change.id, pr_number: change.pr_number },
          execution_result: {
            merged: false,
            effective_change_id: outcome.change_id,
            reason: outcome.reason,
            beatrice_flagged: outcome.flagged,
          },
        });
        return {
          merged: false, change_id: outcome.change_id, pr_number: outcome.pr_number,
          merged_sha: null, deploy_class: 'none', reason: `merge failed: ${outcome.reason}`,
        };
      }

      const effective = store.get(outcome.change_id) ?? change;
      const result = { merged: true, sha: outcome.sha };
      const deploy_class = classify(effective.files);
      const is_hot = (f: string) => f.startsWith('config/') || f.startsWith('src/app/client/');
      const mixed = effective.files.some(is_hot) && effective.files.some((f) => !is_hot(f));
      let merge_reason =
        deploy_class === 'code_restart'
          ? mixed
            ? 'Merged to main. MIXED config+code change — needs a docker restart on the LLM host (the config half will NOT hot-reload until the restart).'
            : 'Merged to main. CODE change — needs a docker restart on the LLM host to take effect (hot-reload will not pick it up).'
          : 'Merged to main. Config-only — hot-reloads after the next git pull on the LLM host; no restart needed.';
      if (outcome.via !== 'direct' && outcome.note) merge_reason += ` (Recovery: ${outcome.note})`;

      // Owner opt-in: close the loop for config-only merges by pulling them onto
      // the live checkout so chokidar hot-reloads — no restart, no human step.
      // Never self-deploys code (that needs a restart, done by ops).
      if (deploy_class === 'config_hot_reload' && new CodeShopSettings(deps.db).get().auto_pull_config_merges) {
        try {
          run_git(REPO_ROOT, ['pull', '--ff-only', 'origin', git.base_branch]);
          merge_reason += ' Auto-pulled onto the live checkout; hot-reloaded.';
        } catch (err) {
          merge_reason += ` (auto-pull failed: ${err instanceof Error ? err.message : String(err)} — pull manually.)`;
        }
      }

      // Health-gated auto-deploy (2026-07-05, owner-decided): a CODE merge
      // asks the ops-relay to pull + restart the orchestrator, with a
      // boot-health probe and automatic rollback to the pre-pull sha on a
      // failed boot (the crash-loop class becomes a self-healing blip). The
      // relay runs it DETACHED — this process dies mid-deploy by design; the
      // boot reconciliation in server.ts reads /deploy/last and alerts the
      // owner if the deploy rolled back. DARK behind HEARTH_AUTO_DEPLOY.
      if (deploy_class === 'code_restart' && process.env.HEARTH_AUTO_DEPLOY === '1') {
        const dispatched = await request_deploy('hearth-orchestrator');
        merge_reason += dispatched.ok
          ? ' Auto-deploy dispatched (health-gated; rolls back on a failed boot).'
          : ` (auto-deploy not dispatched: ${dispatched.detail ?? 'relay unavailable'} — deploy manually.)`;
      }

      ctx.memory.log_action({
        intent_id: ctx.intent_id,
        agent: ctx.specialist_id ?? 'trainer',
        tool_name: 'merge_approved_change',
        tool_input: { change_id: change.id, pr_number: change.pr_number },
        execution_result: {
          merged: true,
          merged_sha: result.sha,
          deploy_class,
          merge_via: outcome.via,
          effective_change_id: outcome.change_id,
        },
      });

      // Close the loop: nudge Beatrice to run verify_fix_landed once this is
      // deployed, so the process_misses this fix resolved get CLOSED instead of
      // re-escalating forever. (The update_sku gap stayed "open" for days
      // because the fix shipped outside the tracked loop and nothing closed its
      // misses — Mariah kept re-escalating them and Beatrice kept re-proposing.)
      // A non-waking FYI: post-merge a code change isn't live yet (needs a
      // restart), so verify would no-op now — she picks this up on her next
      // scheduled pass, by which point it's deployed.
      //
      // Best-effort + NON-FATAL by construction: the merge already succeeded
      // above, so a nudge failure (or partial-deps smoke wiring without an
      // inbox) must never make this tool report the merge as failed.
      try {
        const subject = effective.target_specialist_id;
        deps.inbox?.push({
          from_specialist_id: 'orchestrator',
          to_specialist_id: 'trainer',
          kind: 'fyi',
          body_md:
            `**Merged — close the loop.** Change \`${effective.id}\`` +
            (effective.pr_number != null ? ` (PR #${effective.pr_number})` : '') +
            ` merged to main` +
            (subject ? ` (target: ${subject})` : '') +
            `. Once it's deployed, run \`verify_fix_landed\`` +
            (subject ? ` with subject_specialist_id: '${subject}'` : '') +
            ` to auto-close the process_misses this fix resolved — so they stop ` +
            `re-escalating and you don't re-propose a fix that already shipped.`,
          ...(effective.related_proposal_id ? { related_proposal_id: effective.related_proposal_id } : {}),
        });
      } catch (err) {
        console.warn(
          `[merge_approved_change] post-merge verify-nudge failed (non-fatal):`,
          err instanceof Error ? err.message : String(err),
        );
      }

      // Auto-verify bridge (2026-06-10): when the merged change's originating
      // proposal cites the misses it closes (connector-recovery proposals
      // carry cited_miss_ids), WAKE Mariah — the ledger owner — with the
      // exact ids so verify_fix_landed runs within minutes of the merge
      // instead of at her next scheduled pass. The trainer FYI above is
      // non-waking by design; this one is the loop-latency cut. Best-effort,
      // non-fatal, same as the nudge.
      try {
        if (effective.related_proposal_id) {
          const prow = deps.db
            .prepare(`SELECT payload_json FROM proposals WHERE id = ?`)
            .get(effective.related_proposal_id) as { payload_json: string } | undefined;
          const payload = prow ? (JSON.parse(prow.payload_json) as Record<string, unknown>) : null;
          const cited = Array.isArray(payload?.cited_miss_ids)
            ? (payload!.cited_miss_ids as unknown[]).filter((v): v is string => typeof v === 'string')
            : [];
          if (cited.length > 0) {
            const flag_id = deps.inbox?.push({
              from_specialist_id: 'orchestrator',
              to_specialist_id: 'mariah',
              kind: 'flag',
              body_md:
                `**Fix merged — verify now.** Change \`${effective.id}\`` +
                (effective.pr_number != null ? ` (PR #${effective.pr_number})` : '') +
                ` merged; its proposal cites ${cited.length} process miss(es): ` +
                cited.map((id) => `\`${id}\``).join(', ') +
                `. Run \`verify_fix_landed\` with these miss_ids (copy them verbatim) ` +
                `so the loop closes today, not at the next scheduled sweep.`,
              related_proposal_id: effective.related_proposal_id,
            });
            if (flag_id) {
              deps.events?.emit({
                type: 'inbox_message_added',
                message_id: flag_id,
                from_specialist_id: 'orchestrator',
                to_specialist_id: 'mariah',
                kind: 'flag',
                severity: 'medium',
              });
            }
          }
        }
      } catch (err) {
        console.warn(
          `[merge_approved_change] auto-verify wake failed (non-fatal):`,
          err instanceof Error ? err.message : String(err),
        );
      }

      // Shipped-fix backlinks (2026-08-15, owner-directed): a merged change
      // should surface the pending cards it answers — Kate's "let me read
      // that miss" card (…33F83T) sat pending while the read_miss tool it
      // asked for merged. Deterministic file-token match; judgment stays
      // with Kate: one FYI names the candidates, she rules at her next pass.
      // Best-effort + non-fatal like the two nudges above.
      try {
        const tokens = [
          ...new Set(
            effective.files
              .map((f) => f.split('/').pop()!.replace(/\.(ts|yaml|md)$/, ''))
              .filter((t) => t.length >= 6),
          ),
        ].slice(0, 6);
        if (tokens.length > 0) {
          const clauses = tokens
            .map(() => `(title LIKE '%' || ? || '%' OR rationale_md LIKE '%' || ? || '%')`)
            .join(' OR ');
          const rows = deps.db
            .prepare(
              `SELECT id, substr(COALESCE(title, rationale_md), 1, 80) AS t
                 FROM proposals WHERE status = 'pending' AND (${clauses}) LIMIT 5`,
            )
            .all(...tokens.flatMap((t) => [t, t])) as Array<{ id: string; t: string }>;
          if (rows.length > 0) {
            deps.inbox?.push({
              from_specialist_id: 'orchestrator',
              to_specialist_id: 'kate',
              kind: 'fyi',
              body_md:
                `**Shipped fix may answer pending cards.** Change \`${effective.id}\`` +
                (effective.pr_number != null ? ` (PR #${effective.pr_number})` : '') +
                ` merged, touching ${tokens.map((t) => `\`${t}\``).join(', ')}. ` +
                `Pending proposals referencing the same names — rule on each at ` +
                `your next pass (absorb what this fix answers, leave the rest):\n` +
                rows.map((r) => `- \`${r.id}\` — ${r.t}`).join('\n'),
              ...(effective.related_proposal_id
                ? { related_proposal_id: effective.related_proposal_id }
                : {}),
            });
          }
        }
      } catch (err) {
        console.warn(
          `[merge_approved_change] backlink fyi failed (non-fatal):`,
          err instanceof Error ? err.message : String(err),
        );
      }

      return {
        merged: true,
        change_id: outcome.change_id,
        pr_number: outcome.pr_number,
        merged_sha: result.sha,
        deploy_class,
        reason: merge_reason,
      };
    },
  };
  return tool as Tool;
}
