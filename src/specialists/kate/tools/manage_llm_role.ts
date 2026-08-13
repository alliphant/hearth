/**
 * manage_llm_role — inspect, swap, and REVERT the model behind an LLM role
 * (2026-08-01). Owner-only, Kate's service mode.
 *
 * The one comprehensive tool for the role-config domain (named `action` slots,
 * never a family of narrow siblings): `inspect` · `set` · `revert` · `history`.
 *
 * WHY IT EXISTS. `config/llm-roles.yaml` is `readFileSync`'d once in the
 * `ConfigLLMRouter` constructor and has no watcher, so changing which model
 * serves a role needed `docker compose restart hearth-orchestrator`. That made
 * the most consequential self-modification the system can make also the one it
 * could not undo quickly — the exact inversion of what you want. `revert` is
 * now a single call that takes effect on the next request.
 *
 * WHAT IT WILL NOT DO. It refuses a `base_url` change that would land the role
 * on an endpoint whose mutex already exists with a different slot count, and it
 * names both numbers so the caller can match and retry. That is not caution for
 * its own sake: a Semaphore's width is fixed at construction and never resized,
 * so the role would silently inherit the wrong backpressure — too few slots
 * serializes the batch away, too many stampedes past the server's `--parallel
 * N`. A `model`-only swap shares the endpoint and is always safe.
 *
 * The YAML remains the base and the git source of truth. An override is an
 * explicitly temporary layer that records what it displaced, so `revert` always
 * has somewhere to go back to.
 */
import { z } from 'zod';
import type { Tool, ToolContext } from '@core/tool';
import type { ToolDeps } from '@core/tool_deps';
import type { MemoryClient } from '@memory/client';
import type { ConfigLLMRouter } from '@core/router';
import { role_overrides_enabled } from '@core/router';
import {
  LlmRoleOverrideStore,
  type RoleOverridePatch,
} from '@memory/stores/llm_role_overrides';
import { ChangeWindowStore } from '@memory/stores/change_windows';

const OWNER_ONLY_MSG =
  "Which model serves which role is owner-only — I don't re-point inference for anyone but you.";

function is_owner(ctx: ToolContext): boolean {
  // Absent user = legacy owner-default (system/deliberation context).
  return !ctx.user || ctx.user.tier === 'owner';
}

const PatchSchema = z.object({
  model: z.string().optional(),
  base_url: z.string().optional(),
  temperature: z.number().optional(),
  max_tokens: z.number().int().optional(),
  timeout_ms: z.number().int().optional(),
  think: z.boolean().optional(),
  concurrent: z.boolean().optional(),
  max_concurrency: z.number().int().optional(),
  context_window_tokens: z.number().int().optional(),
});

const InputSchema = z.object({
  action: z
    .enum(['inspect', 'set', 'revert', 'history'])
    .describe(
      'inspect = what is live for this role (and whether an override is on); ' +
        'set = apply an override; revert = lift it, taking effect on the next ' +
        'request; history = what has been tried and lifted.',
    ),
  role: z
    .string()
    .optional()
    .describe('The LLM role, e.g. "specialist", "deep_consult", "voice_realtime". Omit on history for all.'),
  patch: PatchSchema.optional().describe('For `set` — the fields to override. Usually just `model`.'),
  reason: z
    .string()
    .optional()
    .describe('Why. Recorded on the row and shown in history — say what you are testing.'),
});

const OverrideView = z.object({
  id: z.string(),
  role: z.string(),
  patch: z.record(z.unknown()),
  reason: z.string(),
  applied_by: z.string(),
  applied_at: z.string(),
  reverted_at: z.string().nullable(),
});

const OutputSchema = z.object({
  ok: z.boolean(),
  action: z.string(),
  enabled: z.boolean(),
  role: z.string().nullable(),
  /** For inspect: the config actually in force right now. */
  effective: z.record(z.unknown()).nullable(),
  override_active: z.boolean(),
  override: OverrideView.nullable(),
  history: z.array(OverrideView).optional(),
  /** Set when a `set` was refused — carries both slot counts so it can be fixed. */
  refused_reason: z.string().optional(),
  next_action: z.string(),
});

type Input = z.infer<typeof InputSchema>;
type Output = z.infer<typeof OutputSchema>;

export interface ManageLlmRoleDeps {
  db: import('bun:sqlite').Database;
  memory: MemoryClient;
  /** The live router — needed to read effective config + check mutex safety. */
  router?: ConfigLLMRouter;
}

function view(r: {
  id: string;
  role: string;
  patch: RoleOverridePatch;
  reason: string;
  applied_by: string;
  applied_at: string;
  reverted_at: string | null;
}): z.infer<typeof OverrideView> {
  return {
    id: r.id,
    role: r.role,
    patch: r.patch as Record<string, unknown>,
    reason: r.reason,
    applied_by: r.applied_by,
    applied_at: r.applied_at,
    reverted_at: r.reverted_at,
  };
}

export function make_manage_llm_role(deps: ManageLlmRoleDeps): Tool<Input, Output> {
  return {
    name: 'manage_llm_role',
    description:
      'Inspect, swap, or REVERT the model behind an LLM role — without restarting ' +
      'the orchestrator. `inspect` shows what is live and whether an override is on; ' +
      '`set` applies one (usually just `model`); `revert` lifts it in one call, ' +
      'effective on the next request; `history` shows what has been tried. ' +
      'config/llm-roles.yaml stays the base and the git source of truth. Owner-only. ' +
      'A base_url change onto an endpoint whose mutex already has a different slot ' +
      'count is refused with both numbers, because slot width is fixed at ' +
      'construction and the role would silently get the wrong backpressure.',
    risk: 'write_internal',
    required_capabilities: ['service_mode_infra'],
    input_schema: InputSchema,
    output_schema: OutputSchema,
    volatile: true, // inspect after set must re-read, not re-serve

    idempotency_key(input) {
      return `manage_llm_role:${input.action}:${input.role ?? 'all'}:${Math.floor(Date.now() / 60_000)}`;
    },

    async execute(input, ctx: ToolContext): Promise<Output> {
      const base: Omit<Output, 'ok' | 'next_action'> = {
        action: input.action,
        enabled: role_overrides_enabled(),
        role: input.role ?? null,
        effective: null,
        override_active: false,
        override: null,
      };

      if (!is_owner(ctx)) {
        return { ...base, ok: false, next_action: OWNER_ONLY_MSG };
      }
      if (!role_overrides_enabled()) {
        return {
          ...base,
          ok: false,
          enabled: false,
          next_action:
            'HEARTH_LLM_ROLE_OVERRIDES=0 — the hot role layer is disabled; llm-roles.yaml + a ' +
            'restart is the only path while it stays off.',
        };
      }

      const store = new LlmRoleOverrideStore(deps.db);
      const by = ctx.user?.id ?? 'owner';

      if (input.action === 'history') {
        const rows = store.history({ ...(input.role ? { role: input.role } : {}), limit: 20 });
        return {
          ...base,
          ok: true,
          history: rows.map(view),
          next_action:
            rows.length === 0
              ? 'No role has ever been overridden — every role is running its llm-roles.yaml config.'
              : `${rows.length} override(s) on record; ${rows.filter((r) => !r.reverted_at).length} still active.`,
        };
      }

      if (!input.role) {
        return {
          ...base,
          ok: false,
          next_action: `\`${input.action}\` needs a \`role\` (e.g. "specialist", "deep_consult").`,
        };
      }
      const role = input.role;

      if (input.action === 'inspect') {
        const active = store.active_for(role);
        return {
          ...base,
          ok: true,
          override_active: active != null,
          override: active ? view(active) : null,
          next_action: active
            ? `\`${role}\` is OVERRIDDEN (${JSON.stringify(active.patch)}) — applied ${active.applied_at} ` +
              `by ${active.applied_by}: ${active.reason}. Revert with ` +
              `\`manage_llm_role{action:"revert", role:"${role}"}\`.`
            : `\`${role}\` is running its llm-roles.yaml config — no override active.`,
        };
      }

      if (input.action === 'revert') {
        const reverted = store.revert(role, by, ctx.now);
        deps.router?.invalidate_override_cache();
        deps.memory.log_action({
          intent_id: ctx.intent_id,
          agent: ctx.specialist_id ?? 'kate',
          tool_name: 'llm_role_reverted',
          tool_input: { role },
          execution_result: { reverted_id: reverted?.id ?? null, patch: reverted?.patch ?? null },
        });
        return {
          ...base,
          ok: true,
          override: reverted ? view(reverted) : null,
          next_action: reverted
            ? `Reverted \`${role}\` to its llm-roles.yaml config (was ${JSON.stringify(reverted.patch)}). ` +
              `Effective on the next request — no restart.`
            : `\`${role}\` had no active override; it was already on its llm-roles.yaml config.`,
        };
      }

      // ── set ──
      const patch = (input.patch ?? {}) as RoleOverridePatch;
      if (Object.keys(patch).length === 0) {
        return {
          ...base,
          ok: false,
          next_action: `\`set\` needs a \`patch\` — e.g. {model: "qwen36-35b-a3b"}. Nothing to apply.`,
        };
      }

      // The one real hazard: landing on an endpoint whose mutex width is fixed
      // and different. Refuse with both numbers rather than silently mis-sizing
      // this role's backpressure.
      const conflict = deps.router?.check_endpoint_conflict(role as never, patch);
      if (conflict) {
        return {
          ...base,
          ok: false,
          refused_reason: conflict.reason,
          next_action:
            `Refused: ${conflict.reason} Retry with ` +
            `\`patch.max_concurrency: ${conflict.existing_slots}\` if that is genuinely the ` +
            `server's batch width.`,
        };
      }

      const applied = store.apply({
        role,
        patch,
        reason: input.reason ?? 'no reason given',
        applied_by: by,
        ...(ctx.now ? { now: ctx.now } : {}),
      });
      deps.router?.invalidate_override_cache();

      // Open a measurement window. The baseline HAS to be snapshotted here —
      // once the change is live, what the suite looked like before it is gone.
      // Best-effort: failing to measure a swap must never block making it.
      let window_id: string | null = null;
      try {
        const windows = new ChangeWindowStore(deps.db);
        window_id = windows.open({
          kind: 'llm_role_override',
          ref: applied.id,
          target: role,
          reason: applied.reason,
          applied_by: by,
          baseline: windows.current_outcomes(),
          ...(ctx.now ? { now: ctx.now } : {}),
        });
      } catch {
        /* fail-open */
      }
      deps.memory.log_action({
        intent_id: ctx.intent_id,
        agent: ctx.specialist_id ?? 'kate',
        tool_name: 'llm_role_overridden',
        tool_input: { role, patch },
        execution_result: { id: applied.id, reason: applied.reason, window_id },
      });
      return {
        ...base,
        ok: true,
        override_active: true,
        override: view(applied),
        next_action:
          `\`${role}\` now runs ${JSON.stringify(patch)} — effective on the next request, no restart. ` +
          `llm-roles.yaml is untouched and still the base. Undo any time with ` +
          `\`manage_llm_role{action:"revert", role:"${role}"}\`.` +
          (window_id
            ? ` The golden-suite baseline is snapshotted (window ${window_id}); the next eval run scores ` +
              `this swap on a same-task delta and flags it if anything regressed.`
            : ''),
      };
    },
  };
}

export function create(deps: ToolDeps): Tool {
  return make_manage_llm_role({
    db: deps.db,
    memory: deps.memory,
    // The router is the live ConfigLLMRouter; the interface type on ToolDeps is
    // the narrower LLMRouter, so narrow back only when the concrete class is in
    // play (fail-open: without it, inspect/set/revert still work — only the
    // mutex-conflict check and the cache bust are skipped).
    ...(typeof (deps.llm as { check_endpoint_conflict?: unknown }).check_endpoint_conflict === 'function'
      ? { router: deps.llm as unknown as ConfigLLMRouter }
      : {}),
  }) as Tool;
}
