/**
 * file_build_request — Kate's spec-first intake for new tools/specialists.
 *
 * The owner says "I want a tool that does X" in chat; Kate turns it into a
 * STRUCTURED build spec (problem, acceptance criteria, owning specialist)
 * filed at Knowledge/Trainer/build-requests/, and drops a high-severity
 * **Build request** flag that wakes Beatrice off-schedule. Her deliberation
 * addendum owns the execution playbook: read the spec → scaffold_code →
 * workbench iterate → workbench_submit — and the result still passes the
 * normal Kate-review + owner-merge gates, so filing a request never ships
 * anything by itself.
 *
 * Why a tool and not "just tell Beatrice": directed builds used to require
 * the owner to hand-craft a directive with inlined code shapes. The spec
 * template + the scaffolder do that inlining mechanically; Kate's job is
 * only to capture WHAT and WHY in acceptance-criteria form.
 */
import { z } from 'zod';
import { createHash } from 'node:crypto';
import type { Tool, ToolContext } from '@core/tool';
import type { ToolDeps } from '@core/tool_deps';
import type { SpecialistInbox } from '@memory/stores/conversations';
import type { AppEventBus } from '@app/events';
import { local_iso_date } from '@core/time';

const InputSchema = z.object({
  /** Short imperative title, e.g. "Track propane tank levels for Cassandra". */
  title: z.string().min(8).max(120),
  /** The problem in the owner's terms — what's missing or painful today. */
  problem: z.string().min(20).max(4_000),
  /** Testable acceptance criteria. Beatrice quotes these in her PR body and
   *  says how each is met — make them concrete enough to check. */
  acceptance_criteria: z.array(z.string().min(5).max(500)).min(1).max(10),
  /** Specialist who will own the artifact (id, e.g. 'cassandra'). */
  owning_specialist: z.string().min(2).max(40),
  /** Best guess at the artifact kind — matches scaffold_code's kinds. */
  artifact_kind: z
    .enum(['specialist_tool', 'connector', 'intake_handler', 'app_route', 'specialist_yaml'])
    .optional(),
  /** Anything else Beatrice should know (constraints, related tools, prior art). */
  notes: z.string().max(2_000).optional(),
});

const OutputSchema = z.object({
  spec_path: z.string(),
  inbox_message_id: z.string(),
});

type Input = z.infer<typeof InputSchema>;
type Output = z.infer<typeof OutputSchema>;

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

export function make_file_build_request(
  inbox: SpecialistInbox,
  events: AppEventBus | undefined,
): Tool<Input, Output> {
  return {
    name: 'file_build_request',
    description:
      'File a structured BUILD SPEC for a new tool, connector, intake handler, route, or ' +
      'specialist, and wake Beatrice to build it. Use when the owner asks for new ' +
      'functionality ("I want a tool that…", "can we track…", "hire a specialist for…"). ' +
      'Capture the problem in the owner\'s terms and write CONCRETE acceptance criteria — ' +
      'they become the definition of done Beatrice codes against. The build still passes ' +
      'your review and the owner\'s merge approval; filing never ships anything by itself. ' +
      'Reply to the owner with "Spec filed — Beatrice is on it; the PR will come to me for ' +
      'review." Not for bug REPORTS (flag_beatrice) or info requests (consult_specialist).',
    risk: 'write_internal',
    required_capabilities: ['write_proposals'],
    input_schema: InputSchema,
    output_schema: OutputSchema,

    idempotency_key(input) {
      const h = createHash('sha256');
      h.update(input.title);
      h.update('\n');
      h.update(input.owning_specialist);
      return `file_build_request:${h.digest('hex').slice(0, 16)}`;
    },

    async execute(input, ctx: ToolContext): Promise<Output> {
      const reporter = ctx.specialist_id ?? 'kate';
      const date = local_iso_date(new Date(), ctx.user?.timezone);
      const spec_path = `Knowledge/Trainer/build-requests/${date}-${slugify(input.title)}.md`;

      const body = [
        `# Build request: ${input.title}`,
        '',
        `**Filed by:** ${reporter} · **Owning specialist:** ${input.owning_specialist}` +
          (input.artifact_kind ? ` · **Artifact kind:** ${input.artifact_kind}` : ''),
        '',
        '## Problem',
        '',
        input.problem,
        '',
        '## Acceptance criteria',
        '',
        ...input.acceptance_criteria.map((c, i) => `${i + 1}. ${c}`),
        ...(input.notes ? ['', '## Notes', '', input.notes] : []),
        '',
        '## Build playbook (Beatrice)',
        '',
        'Default: ONE `opencode_build` call with a self-contained task — the problem + every ' +
          'acceptance criterion verbatim + file/dir hints (the harness sees only what you pass). ' +
          `Fallback for surgical single-file work: \`scaffold_code\` (kind: ${input.artifact_kind ?? 'pick from the request'}), ` +
          'iterate in the workbench until `workbench_check` is green, submit with a pr_body that ' +
          'quotes each acceptance criterion and says how it is met.',
        '',
      ].join('\n');

      // Auxiliary-typed spec note — Beatrice reads it via read_note; it is
      // deliberately NOT structured-projected (note_types registry).
      ctx.memory.upsert_note(
        spec_path,
        {
          type: 'reference',
          title: `Build request: ${input.title}`,
          date,
          private_to: 'owner',
        },
        body,
      );

      const inbox_id = inbox.push({
        from_specialist_id: reporter,
        to_specialist_id: 'trainer',
        kind: 'flag',
        body_md:
          `**Build request** from ${reporter} — *${input.title}*.\n\n` +
          `Spec note: \`${spec_path}\` (read it FIRST — it carries the problem, ` +
          `the acceptance criteria, and the build playbook).\n` +
          `Owning specialist: \`${input.owning_specialist}\`` +
          (input.artifact_kind ? ` · artifact kind: \`${input.artifact_kind}\`` : '') +
          `.\n\nExecute per your "Build requests" deliberation playbook: spec → ` +
          `scaffold → workbench → green check → ONE submit. The PR goes to Kate ` +
          `for review and the owner for merge.`,
        originating_user_id: ctx.user?.id ?? null,
      });
      events?.emit({
        type: 'inbox_message_added',
        message_id: inbox_id,
        from_specialist_id: reporter,
        to_specialist_id: 'trainer',
        kind: 'flag',
        severity: 'high',
      });

      ctx.memory.log_action({
        intent_id: ctx.intent_id,
        agent: reporter,
        user_id: ctx.user?.id,
        tool_name: 'file_build_request',
        tool_input: {
          title: input.title,
          owning_specialist: input.owning_specialist,
          artifact_kind: input.artifact_kind,
          spec_path,
        },
        execution_result: { inbox_message_id: inbox_id },
      });

      return { spec_path, inbox_message_id: inbox_id };
    },
  };
}

/** ToolLoader entry point. */
export function create(deps: ToolDeps): Tool {
  return make_file_build_request(deps.inbox, deps.events) as Tool;
}
