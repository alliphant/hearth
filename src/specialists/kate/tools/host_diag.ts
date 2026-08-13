/**
 * diagnose_host (2026-07-25) — the machine layer, open-ended and read-only.
 *
 * WHY. The 07-25 outage's second cause: `diagnose_service` shows what's inside
 * a container and nothing about the MACHINE. Everything below the container
 * boundary — driver vs kernel module, disk, thermals, memory pressure — was
 * structurally invisible, so when a host-layer fault occurred Kate had exactly
 * two moves: say "I can't see that", or explain confidently from the only layer
 * she could see. She explained. The nvml mismatch that took the box down is
 * settled by two facts she had no way to fetch:
 *
 *     cat /proc/driver/nvidia/version        → the LOADED kernel module
 *     ls /usr/lib/x86_64-linux-gnu/libnvidia-ml.so.*  → the host USERSPACE lib
 *
 * DESIGN — bound the ENVIRONMENT, not the command (LAW #1). A blessed list of
 * commands (`nvidia-smi`, `df`, `free`…) closes this incident and stops dead at
 * the next unanticipated fault — the specific-case carve-out this repo bans. So
 * the command is arbitrary and the SANDBOX is what makes it safe: no network,
 * read-only bind of `/`, `nobody`, all caps dropped, no-new-privileges, memory
 * and pid caps, hard timeout, container destroyed after one call. Disk dying,
 * thermals, OOM, a wedged unit — all answerable with zero code changes.
 *
 * The relay owns the walls (ops/ops-relay/relay.ts). This tool owns the
 * OWNER gate, the read-only intent check, and the audit trail. The
 * `classify_command` check here is defense-in-depth, NOT the safety boundary —
 * an enumerated verb list can always be walked around, which is precisely why
 * the sandbox is structural. It's here so an obviously-destructive command is
 * refused with a useful steer before it ever leaves the process.
 */
import { z } from 'zod';
import type { Tool, ToolContext } from '@core/tool';
import type { ToolDeps } from '@core/tool_deps';
import { classify_command } from '@core/shell_safety';
import {
  run_host_diagnostic as real_diag,
  ops_relay_configured as real_configured,
} from '@connectors/ops_relay';

const OWNER_ONLY_MSG =
  "The server room's owner-only — I don't open the host for anyone but you.";
const UNWIRED_MSG =
  "I can't reach the host from here — the ops relay isn't wired up (HEARTH_OPS_RELAY_URL).";
const NOT_ENABLED_MSG =
  'Host diagnostics are switched off on the relay (no HEARTH_OPS_DIAG_IMAGE configured), so I can ' +
  "only see inside containers right now, not the machine itself. Say the word and I'll tell you what to set.";

export interface HostDiagDeps {
  diag_fn?: typeof real_diag;
  configured_fn?: typeof real_configured;
}

export function make_host_diag_tools(deps: HostDiagDeps = {}): Tool[] {
  const diag_fn = deps.diag_fn ?? real_diag;
  const configured_fn = deps.configured_fn ?? real_configured;

  const Input = z.object({
    command: z
      .string()
      .min(1)
      .max(2000)
      .describe(
        'The shell command to run on the host, READ-ONLY. The host filesystem is mounted at /host ' +
          '(so /host/proc/driver/nvidia/version, /host/sys/class/thermal, /host/var/log/…). Pipes and ' +
          'globs work. Examples: "cat /host/proc/driver/nvidia/version", "df -h /host", "dmesg | tail -40", ' +
          '"ls -l /host/usr/lib/x86_64-linux-gnu/libnvidia-ml.so.*".',
      ),
    reason: z.string().max(300).optional().describe('What you are trying to find out. Recorded in the audit trail.'),
  });
  const Output = z.object({
    owner_only: z.boolean().optional(),
    ok: z.boolean(),
    message: z.string().optional(),
    output: z.string().optional(),
    exit_code: z.number().nullable().optional(),
    timed_out: z.boolean().optional(),
    refused: z.boolean().optional(),
  });

  const diagnose_host: Tool<z.infer<typeof Input>, z.infer<typeof Output>> = {
    name: 'diagnose_host',
    description:
      'SERVICE MODE (owner-only): run a READ-ONLY diagnostic command on the the LLM host HOST itself — the layer ' +
      'below the containers. Use it when a fault is about the MACHINE rather than a service: GPU driver vs ' +
      'loaded kernel module, disk space or SMART health, thermals, memory pressure, dmesg, systemd units, the ' +
      'contents of a config file. The host filesystem is mounted read-only at /host. Runs sandboxed (no ' +
      'network, nothing writable, unprivileged), so it can observe anything and change nothing. Reach for this ' +
      "instead of inferring a host-layer cause from container evidence — and if it can't tell you, say so.",
    risk: 'read',
    required_capabilities: ['service_mode_infra'],
    volatile: true,
    input_schema: Input,
    output_schema: Output,
    idempotency_key: () => 'diagnose_host:volatile',
    async execute(input, ctx: ToolContext) {
      if (!ctx.user || ctx.user.tier === 'owner') {
        // fall through — absent user = legacy owner-default (system context)
      } else {
        return { owner_only: true, ok: false, message: OWNER_ONLY_MSG };
      }
      if (!configured_fn()) return { ok: false, message: UNWIRED_MSG };

      // Defense-in-depth: refuse an obviously state-changing command before it
      // leaves the process. The sandbox is the real boundary (nothing is
      // writable there); this exists to return a useful steer rather than an
      // opaque failure, and to keep the audit trail honest about intent.
      const destructive = classify_command(input.command);
      if (destructive) {
        ctx.memory.log_action({
          intent_id: ctx.intent_id,
          agent: ctx.specialist_id ?? 'kate',
          tool_name: 'diagnose_host',
          tool_input: { command: input.command, reason: input.reason },
          execution_result: { refused: true, why: destructive.detail },
          user_id: ctx.user?.id,
        });
        return {
          ok: false,
          refused: true,
          message:
            `That command changes state (${destructive.detail}), and this is a read-only window — it runs in a ` +
            `sandbox where nothing is writable anyway. Re-run it as an observation (read the file, list the ` +
            `directory, check the status) and tell me what you find; if something genuinely needs changing, ` +
            `say what and why and let me decide.`,
        };
      }

      const r = await diag_fn(input.command);
      ctx.memory.log_action({
        intent_id: ctx.intent_id,
        agent: ctx.specialist_id ?? 'kate',
        tool_name: 'diagnose_host',
        // The command + outcome are audited; the OUTPUT is not — it can carry
        // household data, and the audit log is a durable plaintext record.
        tool_input: { command: input.command, reason: input.reason },
        execution_result: {
          ok: r.ok,
          reason: r.reason,
          exit_code: r.exit_code ?? null,
          output_chars: (r.output ?? '').length,
        },
        user_id: ctx.user?.id,
      });

      if (r.reason === 'not_enabled') return { ok: false, message: NOT_ENABLED_MSG };
      if (r.reason === 'relay_unavailable') {
        return { ok: false, message: `Couldn't reach the host: ${r.detail ?? 'relay unavailable'}.` };
      }
      if (r.reason === 'failed') return { ok: false, message: `That didn't run: ${r.detail ?? 'unknown error'}.` };
      if (r.timed_out) {
        return {
          ok: false,
          timed_out: true,
          output: r.output ?? '',
          message: 'That command ran past the time limit and was stopped — narrow it and try again.',
        };
      }
      return { ok: true, output: r.output ?? '', exit_code: r.exit_code ?? null };
    },
  };

  return [diagnose_host as Tool];
}

export function create_host_diag(_deps: ToolDeps): Tool[] {
  return make_host_diag_tools();
}
