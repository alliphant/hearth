/**
 * delegate — hand a task to another specialist as a SUB-AGENT
 * (Kate sub-agents Phase 1, 2026-07-03 — docs/design-kate-subagents.md).
 *
 * The structural upgrade over consult_specialist: the delegatee runs a
 * full turn in its own disposable context (own tool budget, own token
 * budget) on its own inference slot, and only a bounded digest returns.
 * quick mode waits up to a wall cap then degrades to background; a
 * background run reports back via a specialist-inbox FYI.
 *
 * ONE comprehensive tool (the all-encompassing-tools rule): `action` picks
 * run vs status; the contract stays FLAT (no nested unions — the
 * deep-schema garble class) and required-at-runtime fields are validated
 * in execute() with typed recovery messages, never via schema .regex().
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { delegate_enabled, DelegationRunner } from '@core/delegation';
import type { Tool, ToolContext } from '@core/tool';
import type { ToolDeps } from '@core/tool_deps';
import { DelegationStore } from '@memory/stores/delegations';

const InputSchema = z.object({
  action: z
    .enum(['run', 'status'])
    .default('run')
    .describe(`'run' dispatches a task; 'status' lists your recent delegations.`),
  to: z
    .string()
    .optional()
    .describe(`Specialist to delegate to — id, name, or alias (e.g. "vivian", "Beatrice").`),
  task: z
    .string()
    .optional()
    .describe(
      `The task, phrased for someone with no view of this conversation — name the ` +
        `subject, the deliverable, and any constraints.`,
    ),
  context: z
    .string()
    .optional()
    .describe(
      `Relevant context worth handing over (what the user said, ids, dates, prior ` +
        `findings). The delegatee cannot see your conversation.`,
    ),
  mode: z
    .enum(['quick', 'background'])
    .default('quick')
    .describe(
      `'quick' waits for the digest (falls back to background if it runs long); ` +
        `'background' returns immediately and the result lands in your inbox.`,
    ),
  delegation_id: z
    .string()
    .optional()
    .describe(`With action:'status' — check one specific delegation.`),
});

const OutputSchema = z.object({
  ok: z.boolean(),
  action: z.enum(['run', 'status']),
  delegation_id: z.string().optional(),
  specialist: z.string().optional(),
  /** The delegatee's bounded, self-contained result (quick success). */
  digest: z.string().optional(),
  /** What to do/say next — steer, don't leave the model guessing. */
  next_action: z.string().optional(),
  delegations: z
    .array(
      z.object({
        id: z.string(),
        specialist: z.string(),
        task: z.string(),
        status: z.string(),
        mode: z.string(),
        created_at: z.string(),
        digest_md: z.string().nullable(),
        error: z.string().nullable(),
      }),
    )
    .optional(),
  error: z.string().optional(),
  /** Recovery hint (connector-affordance pattern): the delegable roster. */
  candidates: z
    .array(z.object({ id: z.string(), name: z.string(), role: z.string() }))
    .optional(),
});

type Input = z.infer<typeof InputSchema>;
type Output = z.infer<typeof OutputSchema>;

export function create(deps: ToolDeps): Tool {
  const store = new DelegationStore(deps.db);
  const runner = new DelegationRunner({
    runtime: deps.runtime,
    specialists: deps.specialists,
    store,
    inbox: deps.inbox,
    memory: deps.memory,
    // Live-subagents (2026-07-14): content-free started/completed events for
    // the GUI tray + chips, and the db handle that lets a background run
    // report back into its originating conversation on completion.
    events: deps.events,
    db: deps.db,
  });

  const roster_candidates = (exclude_id?: string) =>
    deps.specialists
      .list()
      .filter((s) => s.id !== exclude_id)
      .map((s) => ({ id: s.id, name: s.name, role: s.role }));

  const delegate_tool: Tool<Input, Output> = {
    name: 'delegate',
    description:
      `Hand a task to another specialist to work in their OWN context with their own ` +
      `tools and budget — you get back only a tight digest, so your context stays ` +
      `clean. Use for any domain task a teammate owns (call action:'run' with no ` +
      `\`to\` to see the current roster) instead of ` +
      `doing their work with your own tools, and ` +
      `for anything needing several lookups. mode:'quick' waits (up to ~90s) for the ` +
      `digest; mode:'background' returns immediately and the result arrives in your ` +
      `inbox. Prefer this over consult_specialist for real WORK; keep consult for a ` +
      `one-line question. action:'status' lists your recent delegations and their ` +
      `results.`,
    risk: 'read',
    required_capabilities: ['delegate_subagents'],
    input_schema: InputSchema,
    output_schema: OutputSchema,
    // A digest is the tool's entire value — don't let default truncation
    // clip it (the runner already bounds it via max_tokens_override).
    llm_budget: 8000,

    idempotency_key(input) {
      const h = createHash('sha256');
      h.update(input.action);
      h.update('\n');
      h.update(input.to ?? '');
      h.update('\n');
      h.update(input.task ?? '');
      h.update('\n');
      h.update(input.mode);
      h.update('\n');
      h.update(input.delegation_id ?? '');
      return `delegate:${h.digest('hex').slice(0, 16)}`;
    },

    async execute(input, ctx: ToolContext): Promise<Output> {
      const requester = ctx.specialist_id;
      if (!requester) {
        return {
          ok: false,
          action: input.action,
          error: 'delegate requires a specialist turn context',
        };
      }

      if (input.action === 'status') {
        if (input.delegation_id) {
          const row = store.get(input.delegation_id);
          const visible =
            row &&
            row.requested_by === requester &&
            (row.user_id === null
              ? !ctx.user || ctx.user.tier === 'owner'
              : row.user_id === (ctx.user?.id ?? null));
          if (!visible) {
            return {
              ok: false,
              action: 'status',
              error: `no delegation ${input.delegation_id} for you`,
              next_action: `Call delegate with action:'status' (no delegation_id) to list yours.`,
            };
          }
          return {
            ok: true,
            action: 'status',
            delegations: [
              {
                id: row.id,
                specialist: row.profile_id,
                task: row.task,
                status: row.status,
                mode: row.mode,
                created_at: row.created_at,
                digest_md: row.digest_md,
                error: row.error,
              },
            ],
          };
        }
        const rows = store.list_recent(requester, {
          user_id: ctx.user?.id ?? null,
          is_owner: !ctx.user || ctx.user.tier === 'owner',
        });
        return {
          ok: true,
          action: 'status',
          delegations: rows.map((r) => ({
            id: r.id,
            specialist: r.profile_id,
            task: r.task,
            status: r.status,
            mode: r.mode,
            created_at: r.created_at,
            digest_md: r.digest_md,
            error: r.error,
          })),
        };
      }

      // action === 'run'
      if (!delegate_enabled()) {
        return {
          ok: false,
          action: 'run',
          error: 'delegation is disabled (HEARTH_DELEGATE=0)',
          next_action:
            'Handle the task yourself with your own tools, or ask a one-line question via consult_specialist.',
        };
      }
      // ── Mis-slotted call (the observed real failure) ──────────────────
      // Measured 2026-08-02: 4 of 42 delegate calls over 14 days arrived as
      // `{action:'run', context:'<the whole task>'}` — both `to` AND `task`
      // dropped, everything crammed into `context`. The old generic "task is
      // required" named the missing field but not the MISTAKE, and carried no
      // candidates (the `to` branch below never ran), so the retry had neither
      // the shape nor the roster and dropped the args again. Name the specific
      // error and hand back everything one retry needs.
      const has_context = (input.context?.trim().length ?? 0) >= 8;
      const task = input.task?.trim() ?? '';
      const task_missing = task.length < 8;

      if (task_missing && has_context) {
        return {
          ok: false,
          action: 'run',
          error:
            `the task landed in \`context\` instead of \`task\` — \`context\` is ` +
            `supporting background only, and a delegation with no \`task\` is ` +
            `never dispatched`,
          next_action:
            `Re-call delegate ONCE with: task = the instruction you just put in ` +
            `context (subject + deliverable + constraints, phrased for someone ` +
            `who cannot see this conversation), to = the specialist below, and ` +
            `context = only the extra background they'd need.`,
          candidates: roster_candidates(requester),
        };
      }
      if (task_missing) {
        return {
          ok: false,
          action: 'run',
          error: 'task is required — a self-contained instruction for the delegatee',
          next_action:
            `Re-call delegate with BOTH task and to set. Phrase task for someone ` +
            `who cannot see this conversation (subject + deliverable + constraints).`,
          candidates: roster_candidates(requester),
        };
      }
      if (!input.to) {
        return {
          ok: false,
          action: 'run',
          error: 'to is required — which specialist should take this?',
          next_action: `Re-call delegate with the same task and to set to one of the candidates below.`,
          candidates: roster_candidates(requester),
        };
      }
      const resolved = deps.specialists.resolve_id(input.to);
      const profile = resolved ? deps.specialists.get(resolved) : null;
      if (!profile) {
        return {
          ok: false,
          action: 'run',
          error: `no specialist "${input.to}"`,
          candidates: roster_candidates(requester),
        };
      }
      if (profile.id === requester) {
        // Observed twice on 2026-08-02, both golden-eval redos whose subject
        // WAS the requester: there is no valid target, so re-calling delegate
        // can only fail again. Steer to the work, not to another dispatch —
        // the old candidates-only reply read as "pick someone else" and the
        // retries came back as mis-slotted calls instead.
        return {
          ok: false,
          action: 'run',
          error: 'cannot delegate to yourself',
          next_action:
            `You ARE the specialist for this task — do it now with your own ` +
            `tools instead of dispatching it. Only re-call delegate if you ` +
            `meant a different specialist (candidates below).`,
          candidates: roster_candidates(requester),
        };
      }

      const display_name =
        (ctx.user && deps.users?.get(ctx.user.id)?.display_name) ?? ctx.user?.id;
      const result = await runner.run({
        requested_by: requester,
        profile_id: profile.id,
        task,
        context: input.context?.trim() || undefined,
        mode: input.mode,
        user:
          ctx.user && display_name
            ? {
                id: ctx.user.id,
                display_name,
                tier: ctx.user.tier,
                timezone: ctx.user.timezone,
              }
            : undefined,
        conversation_id: ctx.conversation_id,
      });

      if (result.outcome === 'done') {
        return {
          ok: true,
          action: 'run',
          delegation_id: result.delegation_id,
          specialist: profile.id,
          digest: result.digest,
          next_action:
            'Answer the user grounded in this digest — cite its specifics, not memory.',
        };
      }
      if (result.outcome === 'backgrounded') {
        return {
          ok: true,
          action: 'run',
          delegation_id: result.delegation_id,
          specialist: profile.id,
          next_action:
            `${profile.name} is still working (delegation ${result.delegation_id}). Tell ` +
            `the user you've handed it off and will report back — the digest lands in ` +
            `your inbox. Do NOT invent findings this turn.`,
        };
      }
      return {
        ok: false,
        action: 'run',
        delegation_id: result.delegation_id,
        specialist: profile.id,
        error: result.error,
        next_action:
          'Tell the user the hand-off failed and either retry with a narrower task or handle it yourself.',
      };
    },
  };

  return delegate_tool as Tool;
}
