/**
 * Infra service mode (2026-07-08, Phase B) — Kate diagnoses server-grade issues
 * on the the LLM host Docker stack (Plex, the *arr apps, Home Assistant, gitea, …).
 *
 * Owner-only. Reads through the already-deployed guarded `ops-relay` (host-side
 * docker-socket sidecar): list / inspect / logs are READ-ANY (bearer only, low
 * blast radius); restart stays NARROW (the relay's `HEARTH_OPS_RESTART_ALLOWED`
 * allowlist is the real gate — Kate can only restart the sanctioned few). The
 * diagnosis itself is LAW-#1: the tool returns the REAL evidence (container
 * state + logs) and Kate reasons over it in-turn, grounded — no fabrication.
 *
 * Three tools, one capability (`service_mode_infra` — distinct from Beatrice's
 * `diagnose_infra`, which is her dependency-registry diagnosis):
 *   - list_services      — the inventory ("what's running / what's down")
 *   - diagnose_service   — one container's state + recent logs (the evidence)
 *   - restart_container  — restart (owner-gated here, allowlist-gated at the relay)
 *
 * PATH GROUNDING (2026-07-25 — the /opt/plex incident). These tools returned
 * state and logs but nothing about WHERE a container is defined, so an answer
 * that had to hand the owner a manual command had no grounded path to quote and
 * invented a plausible one (`cd /opt/plex` — a directory that doesn't exist).
 * Docker Compose then walked UP from the wrong cwd, found the MASTER compose
 * file, and a `down` meant for one service tore down ~45. Every read here now
 * carries the container's real compose origin from its own Docker labels —
 * project / service / working_dir / config_files — plus the blast radius of the
 * project it belongs to and the narrowest command that fixes just that service.
 * A container with no compose labels reports `compose_managed: false` and SAYS
 * so; the honest absence is the point — there is nothing to guess at.
 */
import { z } from 'zod';
import type { Tool, ToolContext } from '@core/tool';
import type { ToolDeps } from '@core/tool_deps';
import {
  list_containers as real_list,
  inspect_container as real_inspect,
  fetch_logs as real_logs,
  restart_service as real_restart,
  ops_relay_configured as real_configured,
  type ComposeOrigin,
  type OpsListResult,
  type OpsInspectResult,
} from '@connectors/ops_relay';

const OWNER_ONLY_MSG =
  "The server room's owner-only — I don't open the Docker stack for anyone but you.";
const UNWIRED_MSG =
  "I can't reach the server's containers from here — the ops relay isn't wired up (HEARTH_OPS_RELAY_URL). " +
  'Diagnosis needs that bridge; without it I can only tell you what my own health monitor already knows.';

function is_owner(ctx: ToolContext): boolean {
  // Absent user = legacy owner-default (system/deliberation context).
  return !ctx.user || ctx.user.tier === 'owner';
}

// ── compose grounding (the path half) ────────────────────────────────────────

/** Everything an ops answer needs to name a real file and a narrow command. */
export interface ComposeGrounding {
  compose_managed: boolean;
  project?: string;
  service?: string;
  working_dir?: string;
  /** The compose file that actually governs this container (the quotable path). */
  config_file?: string;
  config_files?: string[];
  /** How many containers share this compose project — the blast radius number. */
  project_container_count?: number;
  blast_radius?: string;
  /** The narrowest commands that act on THIS service only. Grounded, not guessed. */
  commands: Record<string, string>;
  note: string;
}

/**
 * Turn a container's real Docker labels into a quotable path + the narrowest
 * commands for it. PURE and deterministic — every string here is derived from
 * `docker inspect`, never authored. `siblings` is the count of containers in
 * the same compose project (null when the inventory read failed — the blast
 * radius is then stated as unknown, never as a number we don't have).
 *
 * The commands use the `-f <file>` form on purpose: `docker compose` resolves
 * its project by walking UP the directory tree from the cwd, so a `cd` into the
 * wrong directory silently retargets a PARENT project. Naming the file removes
 * that whole failure mode.
 */
export function derive_compose_grounding(
  container: string,
  compose: ComposeOrigin | null | undefined,
  siblings: number | null,
): ComposeGrounding {
  if (!compose || !compose.project) {
    return {
      compose_managed: false,
      commands: { restart: `docker restart ${container}` },
      note:
        `"${container}" has NO Docker Compose labels — it was started with a bare \`docker run\`, ` +
        `so there is no compose project and no compose file for it anywhere on the box. ` +
        `Do not suggest any \`docker compose\` command for it: \`docker restart ${container}\` is the whole story.`,
    };
  }
  const service = compose.service || container;
  const files = compose.config_files ?? [];
  const config_file = files[0];
  const count = siblings ?? null;
  const blast_radius = config_file
    ? `Compose project "${compose.project}" (${config_file}) defines ` +
      `${count === null ? 'multiple' : count} container${count === 1 ? '' : 's'}. ` +
      `A bare \`docker compose down\` there stops and REMOVES all of them, not just ${service}.`
    : `Compose project "${compose.project}" contains ${count === null ? 'multiple' : count} container${
        count === 1 ? '' : 's'
      }; a bare \`docker compose down\` in it affects all of them.`;

  // With a known file, every command is scoped to the one service and needs no
  // `cd`. Without one (compose didn't stamp config_files), fall back to the
  // plain docker verb — always correct, always narrow — rather than a guess.
  const commands: Record<string, string> = config_file
    ? {
        restart: `docker compose -f ${config_file} restart ${service}`,
        recreate: `docker compose -f ${config_file} up -d ${service}`,
        logs: `docker compose -f ${config_file} logs --tail=200 ${service}`,
      }
    : { restart: `docker restart ${container}` };

  return {
    compose_managed: true,
    project: compose.project,
    service,
    ...(compose.working_dir ? { working_dir: compose.working_dir } : {}),
    ...(config_file ? { config_file } : {}),
    ...(files.length ? { config_files: files } : {}),
    ...(count !== null ? { project_container_count: count } : {}),
    blast_radius,
    commands,
    note:
      `Quote ONLY the paths in this result — they come from ${container}'s own Docker labels. ` +
      (config_file
        ? `${config_file} is the compose file that governs it. Prefer the \`-f <file>\` commands above: ` +
          `\`docker compose\` finds its project by walking UP from the current directory, so a \`cd\` into ` +
          `the wrong place silently targets a parent project.`
        : `Compose did not record a config file for it, so there is no compose path to quote — use the plain ` +
          `\`docker restart\` above.`),
  };
}

/** Zod shape for the grounding block — mirrors ComposeGrounding exactly. */
const ComposeGroundingSchema = z.object({
  compose_managed: z.boolean(),
  project: z.string().optional(),
  service: z.string().optional(),
  working_dir: z.string().optional(),
  config_file: z.string().optional(),
  config_files: z.array(z.string()).optional(),
  project_container_count: z.number().optional(),
  blast_radius: z.string().optional(),
  commands: z.record(z.string(), z.string()),
  note: z.string(),
});

export interface InfraServiceDeps {
  list_fn?: typeof real_list;
  inspect_fn?: typeof real_inspect;
  logs_fn?: typeof real_logs;
  restart_fn?: typeof real_restart;
  configured_fn?: typeof real_configured;
}

export function make_infra_service_tools(deps: InfraServiceDeps = {}): Tool[] {
  const list_fn = deps.list_fn ?? real_list;
  const inspect_fn = deps.inspect_fn ?? real_inspect;
  const logs_fn = deps.logs_fn ?? real_logs;
  const restart_fn = deps.restart_fn ?? real_restart;
  const configured_fn = deps.configured_fn ?? real_configured;

  const audit = (ctx: ToolContext, tool: string, input: unknown, result: unknown) =>
    ctx.memory.log_action({
      intent_id: ctx.intent_id,
      agent: ctx.specialist_id ?? 'kate',
      tool_name: tool,
      tool_input: input,
      execution_result: result,
      user_id: ctx.user?.id,
    });

  // ── list_services ──────────────────────────────────────────────────────────
  const ListInput = z.object({});
  const ListOutput = z.object({
    owner_only: z.boolean().optional(),
    available: z.boolean(),
    message: z.string().optional(),
    total: z.number().optional(),
    running: z.number().optional(),
    not_running: z.number().optional(),
    containers: z
      .array(
        z.object({
          name: z.string(),
          state: z.string(),
          status: z.string(),
          compose_project: z.string().nullable(),
        }),
      )
      .optional(),
    compose_projects: z
      .array(
        z.object({
          project: z.string(),
          config_file: z.string().nullable(),
          working_dir: z.string().nullable(),
          container_count: z.number(),
        }),
      )
      .optional(),
    unmanaged_containers: z.array(z.string()).optional(),
    path_grounding: z.string().optional(),
  });
  const list_services: Tool<z.infer<typeof ListInput>, z.infer<typeof ListOutput>> = {
    name: 'list_services',
    description:
      'SERVICE MODE (owner-only): list every container running on the the LLM host server with its state and status — the ' +
      'inventory behind "what\'s running / what\'s down / is Plex up?". Also returns each container\'s real Docker ' +
      'Compose project + the compose FILE that governs it (and how many containers that file defines — the blast ' +
      'radius), plus the containers that have no compose file at all. Read-only via the ops relay. Quote only the ' +
      'paths this returns; never guess a directory.',
    risk: 'read',
    required_capabilities: ['service_mode_infra'],
    volatile: true,
    input_schema: ListInput,
    output_schema: ListOutput,
    idempotency_key: () => 'list_services',
    async execute(_input, ctx) {
      if (!is_owner(ctx)) return { owner_only: true, available: false, message: OWNER_ONLY_MSG };
      if (!configured_fn()) return { available: false, message: UNWIRED_MSG };
      const r = await list_fn();
      if (!r.ok) {
        audit(ctx, 'list_services', {}, { ok: false, reason: r.reason });
        return { available: false, message: `Couldn't list containers: ${r.detail ?? r.reason}.` };
      }
      const raw = r.containers ?? [];
      const containers = raw.map((c) => ({
        name: c.name,
        state: c.state,
        status: c.status,
        compose_project: c.compose?.project ?? null,
      }));
      const running = containers.filter((c) => c.state === 'running').length;

      // Group by REAL compose project so the blast radius of any project-wide
      // command is visible without a second call.
      const by_project = new Map<
        string,
        { project: string; config_file: string | null; working_dir: string | null; container_count: number }
      >();
      const unmanaged: string[] = [];
      for (const c of raw) {
        if (!c.compose?.project) {
          unmanaged.push(c.name);
          continue;
        }
        const existing = by_project.get(c.compose.project);
        if (existing) existing.container_count++;
        else
          by_project.set(c.compose.project, {
            project: c.compose.project,
            config_file: c.compose.config_files?.[0] ?? null,
            working_dir: c.compose.working_dir ?? null,
            container_count: 1,
          });
      }
      audit(ctx, 'list_services', {}, { ok: true, total: containers.length, running, projects: by_project.size });
      return {
        available: true,
        total: containers.length,
        running,
        not_running: containers.length - running,
        containers: containers.sort((a, b) => a.name.localeCompare(b.name)),
        compose_projects: [...by_project.values()].sort((a, b) => b.container_count - a.container_count),
        unmanaged_containers: unmanaged.sort(),
        path_grounding:
          `Compose paths above come from each container's own Docker labels — they are the only paths to quote. ` +
          (unmanaged.length
            ? `The ${unmanaged.length} container${unmanaged.length === 1 ? '' : 's'} in unmanaged_containers ` +
              `(${unmanaged.slice(0, 8).join(', ')}${unmanaged.length > 8 ? ', …' : ''}) were started with a bare ` +
              `\`docker run\` and have NO compose file — say that rather than naming one. `
            : '') +
          `A command aimed at a whole compose project hits every container in its container_count; ` +
          `scope to the one service instead.`,
      };
    },
  };

  // ── diagnose_service ───────────────────────────────────────────────────────
  const DiagInput = z.object({
    service: z.string().min(1).describe('The container name to diagnose, e.g. "plex", "radarr", "gitea".'),
    log_lines: z.number().int().positive().max(1000).optional().describe('How many recent log lines (default 150).'),
  });
  const DiagOutput = z.object({
    owner_only: z.boolean().optional(),
    available: z.boolean(),
    message: z.string().optional(),
    service: z.string().optional(),
    headline: z.string().optional(),
    state: z.record(z.string(), z.unknown()).optional(),
    log_tail: z.string().optional(),
    compose: ComposeGroundingSchema.optional(),
  });
  const diagnose_service: Tool<z.infer<typeof DiagInput>, z.infer<typeof DiagOutput>> = {
    name: 'diagnose_service',
    description:
      'SERVICE MODE (owner-only): diagnose one container on the the LLM host server — returns its REAL state (running/exited, ' +
      'health, exit code, restart count, OOM) and its recent LOGS so you can see WHY something is down, PLUS its real ' +
      'compose origin: the exact compose file that governs it, how many containers that file defines (the blast radius), ' +
      'and the narrowest commands that touch only this service. Read-only via the ops relay. Reason over the evidence it ' +
      'returns; do not guess. If you hand the owner a command, take the path from `compose` here — never invent one, and ' +
      'if `compose_managed` is false say there is no compose file for it.',
    risk: 'read',
    required_capabilities: ['service_mode_infra'],
    volatile: true,
    input_schema: DiagInput,
    output_schema: DiagOutput,
    idempotency_key: () => 'diagnose_service:volatile',
    async execute(input, ctx) {
      if (!is_owner(ctx)) return { owner_only: true, available: false, message: OWNER_ONLY_MSG };
      if (!configured_fn()) return { available: false, message: UNWIRED_MSG };
      const tail = input.log_lines ?? 150;
      // The inventory rides along so the compose project's container count (the
      // blast radius of any project-wide command) is REAL, not asserted. It is
      // fail-open: a failed list only makes the count unknown.
      const [ins, logs, inv] = await Promise.all([
        inspect_fn(input.service),
        logs_fn(input.service, { tail }),
        list_fn().catch((): OpsListResult => ({ ok: false, reason: 'failed' })),
      ]);
      if (!ins.ok && /no such container/i.test(ins.extra ?? '')) {
        audit(ctx, 'diagnose_service', { service: input.service }, { ok: false, reason: 'no_such_container' });
        return { available: true, service: input.service, message: `There's no container named "${input.service}" on the server.` };
      }
      const d = ins.detail;
      const project = d?.compose?.project;
      const siblings =
        inv.ok && project
          ? (inv.containers ?? []).filter((c) => c.compose?.project === project).length
          : null;
      const compose = derive_compose_grounding(input.service, d?.compose, siblings);
      // Deterministic headline from the real state — Kate reasons over the logs.
      let headline = 'state unavailable';
      if (d) {
        if (d.state === 'running' && d.health === 'unhealthy') headline = 'running but UNHEALTHY';
        else if (d.state === 'running') headline = d.health && d.health !== 'healthy' ? `running (${d.health})` : 'up and healthy';
        else if (d.state === 'restarting') headline = `RESTART-LOOPING (${d.restart_count ?? '?'} restarts)`;
        else if (d.state === 'exited') headline = `DOWN — exited (code ${d.exit_code ?? '?'}${d.oom_killed ? ', OOM-killed' : ''})`;
        else headline = `state: ${d.state}`;
      }
      audit(
        ctx,
        'diagnose_service',
        { service: input.service },
        { ok: true, headline, has_logs: logs.ok, compose_managed: compose.compose_managed, project: project ?? null },
      );
      return {
        available: true,
        service: input.service,
        headline,
        compose,
        state: d
          ? {
              state: d.state,
              health: d.health ?? 'none',
              exit_code: d.exit_code ?? null,
              restart_count: d.restart_count ?? null,
              oom_killed: d.oom_killed ?? false,
              started_at: d.started_at ?? null,
              finished_at: d.finished_at ?? null,
              error: d.error ?? null,
              image: d.image ?? null,
            }
          : { note: ins.extra ?? 'inspect unavailable' },
        log_tail: logs.ok ? (logs.logs ?? '') : `(logs unavailable: ${logs.detail ?? logs.reason})`,
      };
    },
  };

  // ── restart_container ──────────────────────────────────────────────────────
  const RestartInput = z.object({
    service: z.string().min(1).describe('The container to restart. Only works if it is on the ops restart allowlist.'),
  });
  const RestartOutput = z.object({
    owner_only: z.boolean().optional(),
    ok: z.boolean(),
    service: z.string(),
    message: z.string(),
    /** On a refusal: the grounded command the owner can run by hand. */
    manual_command: z.string().optional(),
    compose: ComposeGroundingSchema.optional(),
  });
  const restart_container: Tool<z.infer<typeof RestartInput>, z.infer<typeof RestartOutput>> = {
    name: 'restart_container',
    description:
      'SERVICE MODE (owner-only): restart a container on the the LLM host server. Owner-gated here AND allowlist-gated at the ' +
      "relay — it only works for services on the ops restart allowlist (the sanctioned few); anything else is refused. Use " +
      'after diagnose_service shows something is genuinely down/looping and a restart is the right move.',
    risk: 'write_internal',
    required_capabilities: ['service_mode_infra'],
    volatile: true,
    input_schema: RestartInput,
    output_schema: RestartOutput,
    idempotency_key: (input) => `restart_container:${input.service}`,
    async execute(input, ctx) {
      if (!is_owner(ctx)) return { owner_only: true, ok: false, service: input.service, message: OWNER_ONLY_MSG };
      if (!configured_fn()) return { ok: false, service: input.service, message: UNWIRED_MSG };
      const r = await restart_fn(input.service);
      if (r.ok) {
        audit(ctx, 'restart_container', { service: input.service }, { ok: true, reason: r.reason });
        return {
          ok: true,
          service: input.service,
          message: `Restarted ${input.service}. Give it a few seconds and I'll re-check its health if you want.`,
        };
      }
      // REFUSED — this is exactly the moment an answer has to hand over a manual
      // command, and exactly where a plausible-looking path used to get invented.
      // Ground it: read the container's own compose labels and return the real,
      // narrowest command alongside the refusal. Fail-open — a failed inspect
      // just means no command to offer, never a guessed one.
      const ins = await inspect_fn(input.service).catch(
        (): OpsInspectResult => ({ ok: false, reason: 'failed' }),
      );
      const compose = derive_compose_grounding(input.service, ins.detail?.compose, null);
      const manual = compose.commands.restart;
      let message: string;
      if (r.reason === 'not_allowed')
        message =
          `${input.service} isn't on the ops restart allowlist, so I can't restart it from here — that's the guardrail. ` +
          `Add it to HEARTH_OPS_RESTART_ALLOWED on the box if you want me to be able to` +
          (manual ? `, or run it yourself: \`${manual}\`.` : '.');
      else if (r.reason === 'relay_unavailable')
        message =
          `The ops relay is unreachable, so I can't restart ${input.service} right now (${r.detail ?? ''})` +
          (manual ? `. By hand: \`${manual}\`.` : '.');
      else
        message =
          `Couldn't restart ${input.service}: ${r.detail ?? r.reason}.` + (manual ? ` By hand: \`${manual}\`.` : '');
      audit(ctx, 'restart_container', { service: input.service }, { ok: false, reason: r.reason });
      return {
        ok: false,
        service: input.service,
        message,
        ...(manual ? { manual_command: manual } : {}),
        compose,
      };
    },
  };

  return [list_services as Tool, diagnose_service as Tool, restart_container as Tool];
}

export function create_infra_service(_deps: ToolDeps): Tool[] {
  return make_infra_service_tools();
}
