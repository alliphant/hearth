/**
 * workbench tools — Beatrice's iterate-then-submit coding surface.
 *
 * Eight thin tools over src/specialists/trainer/workbench.ts (the session
 * manager). The intended build loop:
 *
 *   workbench_open → (workbench_read_file / workbench_write_file /
 *   workbench_apply_edits)* → workbench_check → fix → workbench_check …
 *   → workbench_diff → workbench_submit
 *
 * `workbench_submit` routes through the UNCHANGED gated pipeline
 * (`open_change_pr` re-runs tsc+guard in a fresh worktree, pushes, opens
 * the PR; `route_change_for_review` files the change record for Kate's
 * skeptic review + the owner's merge approval). The workbench adds
 * iteration BEFORE the gates, never a way around them — which is why the
 * whole surface rides the existing `write_codebase_pr` capability instead
 * of a new token.
 *
 * These tools are NOT on Beatrice's standing chat/deliberation surfaces
 * (same policy as propose_code_change): directed builds pass them via
 * `tools_override`, and the build-request bridge does so automatically.
 */
import { z } from 'zod';
import type { Tool, ToolContext } from '@core/tool';
import type { ToolDeps } from '@core/tool_deps';
import type { SpecialistInbox } from '@memory/stores/conversations';
import type { AppEventBus } from '@app/events';
import type { Database } from 'bun:sqlite';
import { open_change_pr, resolve_git_config } from '../change_pipeline';
import { route_change_for_review } from '../review_routing';
import { CodeShopSettings } from '@memory/stores/codeshop_settings';
import {
  wb_check,
  wb_collect_for_submit,
  wb_diff,
  wb_discard,
  wb_edit,
  wb_open,
  wb_read,
  wb_write,
} from '../workbench';

interface WbDeps {
  db: Database;
  inbox: SpecialistInbox;
  events: AppEventBus;
}

const CAP = ['write_codebase_pr'] as const;

// ── open ───────────────────────────────────────────────────────────────────

const OpenIn = z.object({
  task_summary: z.string().min(8).max(300),
});
const OpenOut = z.object({
  workbench_id: z.string(),
  reused_existing: z.boolean(),
  next: z.string(),
});

const workbench_open: Tool<z.infer<typeof OpenIn>, z.infer<typeof OpenOut>> = {
  name: 'workbench_open',
  description:
    'Open your build workbench: an isolated worktree off origin/main where you iterate ' +
    'on code with real compiler feedback before submitting. One session at a time — ' +
    'reopening returns the live session. Loop: write/edit files → workbench_check → fix ' +
    'errors → check again → workbench_submit when green. Nothing here touches the live ' +
    'tree; submit goes through the normal review gates.',
  risk: 'write_internal',
  volatile: true,
  required_capabilities: [...CAP],
  input_schema: OpenIn,
  output_schema: OpenOut,
  idempotency_key: (i) => `workbench_open:${i.task_summary.slice(0, 40)}`,
  async execute(input) {
    const r = wb_open(input.task_summary);
    return {
      workbench_id: r.workbench_id,
      reused_existing: r.reused_existing,
      next: r.reused_existing
        ? 'Session already open — continue with workbench_read_file / workbench_apply_edits / workbench_check.'
        : 'Write or edit files, then run workbench_check. Submit only when the check is green.',
    };
  },
};

// ── write_file ─────────────────────────────────────────────────────────────

const WriteIn = z.object({
  path: z.string().min(1).max(300),
  contents: z.string().min(1),
});
const WriteOut = z.object({ path: z.string(), bytes: z.number() });

const workbench_write_file: Tool<z.infer<typeof WriteIn>, z.infer<typeof WriteOut>> = {
  name: 'workbench_write_file',
  description:
    'CREATE a new file (or deliberately rewrite one wholesale) in the open workbench. ' +
    'Full contents, no diff syntax. For a small change to an existing file use ' +
    'workbench_apply_edits instead — output proportional to the change. Path allowlist: ' +
    'src/, config/, scripts/, apps/.',
  risk: 'write_internal',
  volatile: true,
  required_capabilities: [...CAP],
  input_schema: WriteIn,
  output_schema: WriteOut,
  idempotency_key: (i) => `workbench_write_file:${i.path}:${i.contents.length}`,
  async execute(input) {
    return wb_write(input.path, input.contents);
  },
};

// ── apply_edits ────────────────────────────────────────────────────────────

const EditIn = z.object({
  edits: z
    .array(
      z.object({
        path: z.string().min(1).max(300),
        old_string: z.string().min(1),
        new_string: z.string(),
        replace_all: z.boolean().optional(),
      }),
    )
    .min(1)
    .max(20),
});
const EditOut = z.object({ files_edited: z.array(z.string()) });

const workbench_apply_edits: Tool<z.infer<typeof EditIn>, z.infer<typeof EditOut>> = {
  name: 'workbench_apply_edits',
  description:
    'Apply surgical search/replace edits to files in the open workbench. old_string must ' +
    'match the CURRENT worktree content byte-for-byte and be unique in the file (errors ' +
    'name the problem otherwise — widen the context and retry). Edits apply against your ' +
    'own prior edits, so fix compiler errors incrementally. Use workbench_read_file first ' +
    'when unsure of exact bytes.',
  risk: 'write_internal',
  volatile: true,
  required_capabilities: [...CAP],
  input_schema: EditIn,
  output_schema: EditOut,
  idempotency_key: (i) =>
    `workbench_apply_edits:${i.edits.map((e) => `${e.path}:${e.old_string.length}`).join(',')}`,
  async execute(input) {
    return wb_edit(input.edits.map((e) => ({ ...e })));
  },
};

// ── read_file ──────────────────────────────────────────────────────────────

const ReadIn = z.object({
  path: z.string().min(1).max(300),
  start_line: z.coerce.number().int().positive().optional(),
  end_line: z.coerce.number().int().positive().optional(),
});
const ReadOut = z.object({
  path: z.string(),
  content: z.string(),
  total_lines: z.number(),
  truncated: z.boolean(),
});

const workbench_read_file: Tool<z.infer<typeof ReadIn>, z.infer<typeof ReadOut>> = {
  name: 'workbench_read_file',
  description:
    'Read a file from the open workbench (your CURRENT edited state, not origin/main). ' +
    'Line-numbered; pass start_line/end_line for a range — reading a whole large file ' +
    'burns context, so prefer the range around what you are changing.',
  risk: 'read',
  volatile: true,
  required_capabilities: [...CAP],
  input_schema: ReadIn,
  output_schema: ReadOut,
  idempotency_key: (i) => `workbench_read_file:${i.path}:${i.start_line ?? 0}:${i.end_line ?? 0}`,
  async execute(input) {
    return wb_read(input.path, input.start_line, input.end_line);
  },
};

// ── check ──────────────────────────────────────────────────────────────────

const CheckIn = z.object({
  /** Optional package.json smoke script to run inside the worktree,
   *  e.g. "smoke:tool-contracts". Self-contained smokes only. */
  run_smoke: z.string().max(60).optional(),
});
const CheckOut = z.object({
  ok: z.boolean(),
  tsc_ok: z.boolean().nullable(),
  tsc_errors_rendered: z.string(),
  guard_ok: z.boolean().nullable(),
  guard_output: z.string(),
  smoke_name: z.string().nullable(),
  smoke_ok: z.boolean().nullable(),
  smoke_tail: z.string(),
  next: z.string(),
});

const workbench_check: Tool<z.infer<typeof CheckIn>, z.infer<typeof CheckOut>> = {
  name: 'workbench_check',
  description:
    'Compile-check the open workbench: tsc --noEmit (errors come back structured — file, ' +
    'line, message, a code frame around each) + the repo guards, plus optionally ONE ' +
    'self-contained smoke (run_smoke: "smoke:..."). This is your feedback loop: check, fix ' +
    'the listed errors with workbench_apply_edits, check again. Submit only when ok=true.',
  risk: 'read',
  volatile: true,
  required_capabilities: [...CAP],
  input_schema: CheckIn,
  output_schema: CheckOut,
  idempotency_key: (i) => `workbench_check:${i.run_smoke ?? 'plain'}`,
  async execute(input) {
    const r = wb_check(input.run_smoke);
    return {
      ok: r.ok,
      tsc_ok: r.tsc_ok,
      tsc_errors_rendered: r.tsc_rendered,
      guard_ok: r.guard_ok,
      guard_output: r.guard_output,
      smoke_name: r.smoke_name,
      smoke_ok: r.smoke_ok,
      smoke_tail: r.smoke_tail,
      next: r.ok
        ? 'Green. Review with workbench_diff, then workbench_submit.'
        : 'Fix the errors above with workbench_apply_edits (smallest change that resolves each), then run workbench_check again.',
    };
  },
};

// ── diff ───────────────────────────────────────────────────────────────────

const DiffIn = z.object({});
const DiffOut = z.object({
  files: z.array(z.string()),
  stat: z.string(),
  patch: z.string(),
  truncated: z.boolean(),
});

const workbench_diff: Tool<z.infer<typeof DiffIn>, z.infer<typeof DiffOut>> = {
  name: 'workbench_diff',
  description:
    'Show what the open workbench session has changed relative to origin/main — diffstat ' +
    'plus a capped patch. Read it before submitting: the diff IS what Kate will review.',
  risk: 'read',
  volatile: true,
  required_capabilities: [...CAP],
  input_schema: DiffIn,
  output_schema: DiffOut,
  idempotency_key: () => 'workbench_diff',
  async execute() {
    return wb_diff();
  },
};

// ── submit ─────────────────────────────────────────────────────────────────

const SubmitIn = z.object({
  // NOTE: no `.regex()` — a tool input_schema becomes a GBNF grammar on the
  // interactive 9B, and llama.cpp's converter mistranslates a regex `pattern`
  // and SILENTLY disables the whole tool grammar. The branch-name shape is
  // validated (and is security-load-bearing) in change_pipeline's
  // `validate_branch_name`, called by `open_change_pr`.
  branch_name: z
    .string()
    .min(3)
    .max(80)
    .describe('Branch name: letters/numbers/hyphens/underscores/slashes, starting with a letter (e.g. "beatrice/fix-thing").'),
  pr_title: z.string().min(8).max(140),
  pr_body: z.string().min(20).max(20_000),
  related_proposal_id: z.string().optional(),
  triggered_by: z.string().optional(),
});
const SubmitOut = z.object({
  change_id: z.string(),
  branch: z.string(),
  pr_url: z.string(),
  pr_number: z.number(),
  files_changed: z.array(z.string()),
});

function make_workbench_submit(deps: WbDeps): Tool<z.infer<typeof SubmitIn>, z.infer<typeof SubmitOut>> {
  return {
    name: 'workbench_submit',
    description:
      'Submit the open workbench session as a Pull Request through the normal gates: the ' +
      'pipeline re-runs tsc+guard in a fresh worktree (non-bypassable), pushes, opens the ' +
      'PR, and files the change for Kate review + owner merge approval. Run ' +
      'workbench_check until green FIRST — a red submit is rejected and wastes the round. ' +
      'On success the session closes; STOP after one success (no retries, no -v2).',
    risk: 'write_internal',
    volatile: true,
    required_capabilities: [...CAP],
    input_schema: SubmitIn,
    output_schema: SubmitOut,
    idempotency_key: (i) => `workbench_submit:${i.branch_name}`,
    async execute(input, ctx: ToolContext) {
      if (new CodeShopSettings(deps.db).get().paused) {
        throw new Error(
          'Beatrice is paused by the owner — no changes are being opened. Un-pause in the Code Shop gear.',
        );
      }
      const { files } = wb_collect_for_submit();
      const result = await open_change_pr({
        branch_name: input.branch_name,
        pr_title: input.pr_title,
        pr_body: input.pr_body,
        files,
        related_proposal_id: input.related_proposal_id,
        triggered_by: input.triggered_by ?? 'workbench',
        git: resolve_git_config(deps.db),
      });
      // The session is consumed only by a SUCCESSFUL submit — a red check
      // throws above, leaving the worktree intact so the model fixes and
      // re-submits instead of losing its work.
      wb_discard();

      const audit_id = ctx.memory.log_action({
        intent_id: ctx.intent_id,
        agent: ctx.specialist_id ?? 'trainer',
        tool_name: 'workbench_submit',
        tool_input: { branch: input.branch_name, file_count: files.length },
        execution_result: {
          pr_url: result.pr_url,
          pr_number: result.pr_number,
          commit_sha: result.commit_sha,
        },
      });
      const { change } = route_change_for_review({
        db: deps.db,
        inbox: deps.inbox,
        events: deps.events,
        result,
        origin: 'propose_code_change',
        change_kind: 'code',
        rationale_md: input.pr_title,
        dedup_key: input.related_proposal_id
          ? `code:${input.related_proposal_id}`
          : `code:${input.branch_name.replace(/-v\d+$/, '')}`,
        related_proposal_id: input.related_proposal_id,
        audit_id,
      });
      return {
        change_id: change.id,
        branch: result.branch,
        pr_url: result.pr_url,
        pr_number: result.pr_number,
        files_changed: result.files_changed,
      };
    },
  };
}

// ── discard ────────────────────────────────────────────────────────────────

const DiscardIn = z.object({});
const DiscardOut = z.object({ discarded: z.boolean(), workbench_id: z.string().nullable() });

const workbench_discard: Tool<z.infer<typeof DiscardIn>, z.infer<typeof DiscardOut>> = {
  name: 'workbench_discard',
  description:
    'Abandon the open workbench session and delete its worktree. Use when the approach ' +
    'was wrong and you want a clean slate — nothing is submitted or kept.',
  risk: 'write_internal',
  volatile: true,
  required_capabilities: [...CAP],
  input_schema: DiscardIn,
  output_schema: DiscardOut,
  idempotency_key: () => 'workbench_discard',
  async execute() {
    return wb_discard();
  },
};

/** ToolLoader entry point — the full workbench surface. */
export function create(deps: ToolDeps): Tool[] {
  const wb_deps: WbDeps = { db: deps.db, inbox: deps.inbox, events: deps.events };
  return [
    workbench_open as Tool,
    workbench_write_file as Tool,
    workbench_apply_edits as Tool,
    workbench_read_file as Tool,
    workbench_check as Tool,
    workbench_diff as Tool,
    make_workbench_submit(wb_deps) as Tool,
    workbench_discard as Tool,
  ];
}
