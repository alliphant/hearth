/**
 * restart_service — Beatrice's guarded infra remediation (2026-06-20).
 *
 * The last rung of "help solve it": when a dependency is down and a restart is
 * the known fix, Beatrice calls this. It restarts the ACTUAL failing container
 * (Firecrawl's worker, not the API) via the ops-relay sidecar — never the
 * orchestrator itself. Deliberately conservative, shaped by what the live test
 * taught us (restarting firecrawl-worker did NOT fix the deeper fault):
 *
 *   - CIRCUIT-BREAKER: refuse if the incident already hit the restart cap →
 *     escalate to the owner instead of restart-looping.
 *   - NO false "fixed": a successful restart does NOT auto-close the incident.
 *     It re-probes for a quick reachability signal, but TRUE recovery (the
 *     error rate dropping) is confirmed by the next health scan. A restart that
 *     doesn't recover the service escalates to the owner.
 *   - DEGRADES to escalation when the ops-relay is unwired (self-healing is
 *     opt-in); non-restartable faults are for the change pipeline / the owner.
 */
import { z } from 'zod';
import type { Tool, ToolContext } from '@core/tool';
import type { ToolDeps } from '@core/tool_deps';
import type { MemoryClient } from '@memory/client';
import { assess_system_health, DEPENDENCIES } from '@core/system_health';
import { HealthIncidentStore } from '@memory/stores/system_health';
import { restart_service as relay_restart, ops_relay_configured } from '@connectors/ops_relay';
import { push_text } from '@policy/push';
import { ulid } from 'ulid';

function max_restarts(): number {
  const v = Number(process.env.HEARTH_OPS_MAX_RESTARTS);
  return Number.isFinite(v) && v > 0 ? v : 2;
}

const InputSchema = z.object({
  dependency: z
    .string()
    .min(2)
    .describe("The dependency name to restart, as named in the health incident (e.g. 'firecrawl')."),
});

const OutputSchema = z.object({
  ok: z.boolean(),
  action: z.enum([
    'restarted',
    'circuit_broken',
    'not_restartable',
    'relay_unavailable',
    'no_incident',
    'restart_failed',
  ]),
  recovered_probe: z.boolean().nullable(),
  next_action: z.string(),
});

type Input = z.infer<typeof InputSchema>;
type Output = z.infer<typeof OutputSchema>;

export interface RestartServiceDeps {
  db: import('bun:sqlite').Database;
  memory: MemoryClient;
  /** Smoke seam — defaults to the real ops-relay client. */
  relay_restart_fn?: typeof relay_restart;
  relay_configured_fn?: typeof ops_relay_configured;
  reprobe_fn?: typeof assess_system_health;
  /** Test seam: skip the post-restart wait. */
  wait_ms?: number;
}

export function make_restart_service(deps: RestartServiceDeps): Tool<Input, Output> {
  const do_restart = deps.relay_restart_fn ?? relay_restart;
  const is_configured = deps.relay_configured_fn ?? ops_relay_configured;
  const reprobe = deps.reprobe_fn ?? assess_system_health;

  return {
    name: 'restart_service',
    description:
      "Restart a down dependency's container (the actual failing one, e.g. firecrawl-worker) via the guarded ops-relay, when a restart is the likely fix. Conservative: it won't restart-loop (escalates to the owner after the cap), it does NOT claim 'fixed' — the next health scan confirms real recovery — and it escalates when a restart doesn't help. For non-restartable faults, use your change pipeline or escalate.",
    risk: 'write_internal',
    required_capabilities: ['remediate_infra'],
    input_schema: InputSchema,
    output_schema: OutputSchema,
    volatile: true,

    idempotency_key(input) {
      return `restart_service:${input.dependency}:${Math.floor(Date.now() / 60_000)}`;
    },

    async execute(input, ctx: ToolContext): Promise<Output> {
      const incidents = new HealthIncidentStore(deps.db);
      const def = DEPENDENCIES.find((d) => d.name === input.dependency);
      const incident = incidents.get_open(input.dependency);

      const audit = (action: string, extra: Record<string, unknown> = {}): void => {
        deps.memory.log_action({
          intent_id: ctx.intent_id,
          agent: ctx.specialist_id ?? 'trainer',
          tool_name: 'restart_service',
          tool_input: { dependency: input.dependency },
          execution_result: { action, ...extra },
        });
      };
      const escalate = async (text: string): Promise<void> => {
        try {
          await push_text(text, deps.memory, ctx.intent_id ?? ulid(), 'system_health');
        } catch {
          /* fail-open */
        }
      };

      if (!incident) {
        audit('no_incident');
        return {
          ok: false,
          action: 'no_incident',
          recovered_probe: null,
          next_action: `No open incident for "${input.dependency}" — nothing to restart. Check system_health / the incident list.`,
        };
      }
      if (!def?.restartable || !def.restart_service) {
        audit('not_restartable');
        await escalate(`${def?.label ?? input.dependency} is ${incident.status} but isn't auto-restartable — needs a hands-on fix.`);
        return {
          ok: false,
          action: 'not_restartable',
          recovered_probe: null,
          next_action: `${def?.label ?? input.dependency} isn't auto-restartable. Fix via your change pipeline or escalate to Jasper (already pushed).`,
        };
      }
      if (incident.restart_attempts >= max_restarts()) {
        audit('circuit_broken', { attempts: incident.restart_attempts });
        await escalate(
          `${def.label} is still ${incident.status} after ${incident.restart_attempts} restart attempt(s) — a restart isn't fixing it. Needs you.`,
        );
        return {
          ok: false,
          action: 'circuit_broken',
          recovered_probe: null,
          next_action: `Already restarted \`${def.restart_service}\` ${incident.restart_attempts}× without recovery — escalated to Jasper. Don't restart again; diagnose the deeper fault or hand it to him.`,
        };
      }
      if (!is_configured()) {
        audit('relay_unavailable');
        await escalate(`${def.label} is ${incident.status} and needs a restart, but the ops-relay isn't wired — needs you to restart \`${def.restart_service}\`.`);
        return {
          ok: false,
          action: 'relay_unavailable',
          recovered_probe: null,
          next_action: `The ops-relay isn't configured, so I can't restart \`${def.restart_service}\` myself — escalated to Jasper.`,
        };
      }

      // Do the restart.
      const res = await do_restart(def.restart_service);
      incidents.record_restart(input.dependency);
      if (!res.ok) {
        audit('restart_failed', { reason: res.reason, detail: res.detail });
        await escalate(`Tried to restart ${def.label} (\`${def.restart_service}\`) but it failed: ${res.detail ?? res.reason}. Needs you.`);
        return {
          ok: false,
          action: res.reason === 'relay_unavailable' ? 'relay_unavailable' : 'restart_failed',
          recovered_probe: null,
          next_action: `Restart of \`${def.restart_service}\` failed (${res.detail ?? res.reason}) — escalated to Jasper.`,
        };
      }

      // Give it a moment, then a quick reachability re-probe (NOT a recovery
      // claim — for an error-rate-detected dep the probe was reachable even
      // when broken; the next health scan confirms true recovery).
      const wait = deps.wait_ms ?? 8000;
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      let recovered_probe: boolean | null = null;
      try {
        const snap = await reprobe(deps.db, { deps: DEPENDENCIES.filter((d) => d.name === input.dependency) });
        const d = snap.dependencies[0];
        recovered_probe = d ? d.probe_reachable : null;
      } catch {
        recovered_probe = null;
      }

      audit('restarted', { recovered_probe, attempt: incident.restart_attempts + 1 });
      return {
        ok: true,
        action: 'restarted',
        recovered_probe,
        next_action:
          `Restarted \`${def.restart_service}\`. ` +
          (recovered_probe === false
            ? "It's still unreachable — escalate to Jasper if the next scan doesn't show recovery."
            : "Tell Jasper you restarted it; the next health scan confirms whether it actually recovered (a restart doesn't always fix the deeper fault). Don't restart again this pass."),
      };
    },
  };
}

export function create(deps: ToolDeps): Tool {
  return make_restart_service({ db: deps.db, memory: deps.memory }) as Tool;
}
