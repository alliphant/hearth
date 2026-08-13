/**
 * ops_relay — client for the hearth-ops-relay sidecar (2026-06-20).
 *
 * The orchestrator can't restart a wedged container from inside its own; it
 * POSTs the guarded ops-relay (ops/ops-relay/relay.ts), which restarts an
 * allowlisted service via the Docker socket. Mirrors AvalancheClient's
 * sendWolViaRelay: bearer-auth, short timeout, and FAIL-SAFE — when the relay
 * is unwired or unreachable this returns a structured `relay_unavailable`
 * (never throws), so remediation cleanly degrades to "escalate to the owner"
 * and the detect/surface/escalate spine works with no sidecar at all.
 */

export type RestartReason =
  | 'restarted'
  | 'relay_unavailable'
  | 'not_allowed'
  | 'restart_failed';

export interface OpsRelayResult {
  ok: boolean;
  reason: RestartReason;
  detail?: string;
}

export interface OpsRelayOptions {
  url?: string;
  token?: string;
  fetchImpl?: typeof fetch;
  timeout_ms?: number;
}

/** Restart an allowlisted container via the ops-relay. Fail-safe. */
export async function restart_service(
  service: string,
  opts: OpsRelayOptions = {},
): Promise<OpsRelayResult> {
  const url = (opts.url ?? process.env.HEARTH_OPS_RELAY_URL ?? '').replace(/\/$/, '');
  const token = opts.token ?? process.env.HEARTH_OPS_RELAY_TOKEN;
  if (!url) {
    return { ok: false, reason: 'relay_unavailable', detail: 'HEARTH_OPS_RELAY_URL not set' };
  }
  const fetchImpl = opts.fetchImpl ?? fetch;
  try {
    const res = await fetchImpl(`${url}/restart`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ service }),
      signal: AbortSignal.timeout(opts.timeout_ms ?? 35_000),
    });
    if (res.ok) return { ok: true, reason: 'restarted' };
    if (res.status === 403) {
      return { ok: false, reason: 'not_allowed', detail: `"${service}" not on the relay allowlist` };
    }
    const body = await res.text().catch(() => '');
    return { ok: false, reason: 'restart_failed', detail: `HTTP ${res.status}: ${body.slice(0, 160)}` };
  } catch (err) {
    // Relay down / unreachable → degrade to escalation, never throw.
    return {
      ok: false,
      reason: 'relay_unavailable',
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Is the relay wired (a URL configured)? Lets the remediation tool tell the
 *  difference between "no relay" (escalate) and "restart failed". */
export function ops_relay_configured(opts: OpsRelayOptions = {}): boolean {
  return Boolean(opts.url ?? process.env.HEARTH_OPS_RELAY_URL);
}

/** Health-gated auto-deploy (2026-07-05). `request_deploy` fires the relay's
 *  /deploy — the sequence (pull → restart → boot-health → rollback) runs
 *  DETACHED on the relay because the requester IS the container being
 *  restarted; a short timeout here is expected, never an error to chase.
 *  `fetch_last_deploy` is the boot-reconciliation read: after any boot the
 *  orchestrator asks what the last deploy did and alerts on a rollback. */
export async function request_deploy(
  service = 'hearth-orchestrator',
  opts: OpsRelayOptions = {},
): Promise<{ ok: boolean; detail?: string }> {
  const url = (opts.url ?? process.env.HEARTH_OPS_RELAY_URL ?? '').replace(/\/$/, '');
  const token = opts.token ?? process.env.HEARTH_OPS_RELAY_TOKEN;
  if (!url) return { ok: false, detail: 'HEARTH_OPS_RELAY_URL not set' };
  const fetchImpl = opts.fetchImpl ?? fetch;
  try {
    const res = await fetchImpl(`${url}/deploy`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ service }),
      signal: AbortSignal.timeout(opts.timeout_ms ?? 5_000),
    });
    if (res.ok) return { ok: true };
    return { ok: false, detail: `HTTP ${res.status}` };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

export interface LastDeploy {
  at: string;
  prev_sha: string;
  to_sha: string | null;
  status: string;
  detail: string;
}

export async function fetch_last_deploy(
  opts: OpsRelayOptions = {},
): Promise<LastDeploy | null> {
  const url = (opts.url ?? process.env.HEARTH_OPS_RELAY_URL ?? '').replace(/\/$/, '');
  const token = opts.token ?? process.env.HEARTH_OPS_RELAY_TOKEN;
  if (!url) return null;
  const fetchImpl = opts.fetchImpl ?? fetch;
  try {
    const res = await fetchImpl(`${url}/deploy/last`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      signal: AbortSignal.timeout(opts.timeout_ms ?? 5_000),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { last?: LastDeploy | null };
    return body.last ?? null;
  } catch {
    return null;
  }
}

export type LogsReason = 'ok' | 'relay_unavailable' | 'not_allowed' | 'failed';

export interface OpsLogsResult {
  ok: boolean;
  reason: LogsReason;
  /** The demuxed log tail on success. */
  logs?: string;
  detail?: string;
}

/**
 * Read an allowlisted container's recent log tail via the ops-relay (READ-ONLY
 * — the diagnostic half of self-healing). Fail-safe exactly like
 * `restart_service`: the relay being unwired/unreachable returns a structured
 * `relay_unavailable` (never throws), so the diagnosis runner degrades to "no
 * container logs available" rather than crashing. Same bearer + allowlist as
 * the restart path — a service not on the relay allowlist returns `not_allowed`.
 */
export async function fetch_logs(
  service: string,
  opts: OpsRelayOptions & { tail?: number } = {},
): Promise<OpsLogsResult> {
  const url = (opts.url ?? process.env.HEARTH_OPS_RELAY_URL ?? '').replace(/\/$/, '');
  const token = opts.token ?? process.env.HEARTH_OPS_RELAY_TOKEN;
  if (!url) {
    return { ok: false, reason: 'relay_unavailable', detail: 'HEARTH_OPS_RELAY_URL not set' };
  }
  const fetchImpl = opts.fetchImpl ?? fetch;
  const tail = Number.isFinite(opts.tail) && (opts.tail ?? 0) > 0 ? Math.floor(opts.tail!) : 200;
  try {
    const res = await fetchImpl(
      `${url}/logs/${encodeURIComponent(service)}?tail=${tail}`,
      {
        method: 'GET',
        headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        signal: AbortSignal.timeout(opts.timeout_ms ?? 25_000),
      },
    );
    if (res.ok) {
      const body = (await res.json().catch(() => ({}))) as { logs?: unknown };
      return { ok: true, reason: 'ok', logs: typeof body.logs === 'string' ? body.logs : '' };
    }
    if (res.status === 403) {
      return { ok: false, reason: 'not_allowed', detail: `"${service}" not on the relay allowlist` };
    }
    const text = await res.text().catch(() => '');
    return { ok: false, reason: 'failed', detail: `HTTP ${res.status}: ${text.slice(0, 160)}` };
  } catch (err) {
    return {
      ok: false,
      reason: 'relay_unavailable',
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

// ── READ-ANY diagnostic reads (2026-07-08, Phase B infra service mode) ────────
// list / inspect are bearer-gated but NOT allowlisted (reading is low blast
// radius) — the visibility half of "is Plex down? why?". Same fail-safe shape
// as fetch_logs: an unwired/unreachable relay returns relay_unavailable, never
// throws.

/**
 * Where a container came from, per its own Docker labels (2026-07-25). Mirrors
 * `ComposeOrigin` in ops/ops-relay/relay.ts — the ground truth that lets an ops
 * answer QUOTE the governing compose file instead of inventing a path. `null`
 * on a container started with a bare `docker run` (no compose file exists).
 */
export interface ComposeOrigin {
  project: string;
  service: string;
  working_dir?: string;
  config_files?: string[];
}

export interface ContainerSummary {
  name: string;
  image: string;
  state: string;
  status: string;
  compose?: ComposeOrigin | null;
}

export interface OpsListResult {
  ok: boolean;
  reason: LogsReason;
  containers?: ContainerSummary[];
  detail?: string;
}

export interface InspectDetail {
  name: string;
  image: string;
  state: string;
  health?: string;
  exit_code?: number;
  restart_count?: number;
  oom_killed?: boolean;
  started_at?: string;
  finished_at?: string;
  error?: string;
  compose?: ComposeOrigin | null;
}

export interface OpsInspectResult {
  ok: boolean;
  reason: LogsReason;
  detail?: InspectDetail;
  extra?: string;
}

export interface OpsDiagResult {
  ok: boolean;
  reason: 'ok' | 'relay_unavailable' | 'not_enabled' | 'failed';
  output?: string;
  exit_code?: number | null;
  timed_out?: boolean;
  detail?: string;
}

/**
 * Run one open-ended READ-ONLY diagnostic on the host, in the relay's throwaway
 * sandbox (network-less, read-only bind of `/`, `nobody`, caps dropped, hard
 * timeout — see the header note in ops/ops-relay/relay.ts). This is what lets a
 * specialist see BELOW the container boundary — driver vs kernel module, disk,
 * thermals, memory pressure — instead of guessing at a layer it can't observe.
 * Fail-safe exactly like the rest of this client: never throws.
 */
export async function run_host_diagnostic(
  command: string,
  opts: OpsRelayOptions = {},
): Promise<OpsDiagResult> {
  const url = (opts.url ?? process.env.HEARTH_OPS_RELAY_URL ?? '').replace(/\/$/, '');
  const token = opts.token ?? process.env.HEARTH_OPS_RELAY_TOKEN;
  if (!url) return { ok: false, reason: 'relay_unavailable', detail: 'HEARTH_OPS_RELAY_URL not set' };
  const fetchImpl = opts.fetchImpl ?? fetch;
  try {
    const res = await fetchImpl(`${url}/diag`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ command }),
      signal: AbortSignal.timeout(opts.timeout_ms ?? 60_000),
    });
    if (res.status === 503) {
      return { ok: false, reason: 'not_enabled', detail: 'host diagnostics not enabled on the relay' };
    }
    const body = (await res.json().catch(() => ({}))) as {
      ok?: boolean; output?: string; exit_code?: number | null; timed_out?: boolean; error?: string;
    };
    if (res.ok) {
      return {
        ok: Boolean(body.ok),
        reason: 'ok',
        output: typeof body.output === 'string' ? body.output : '',
        exit_code: body.exit_code ?? null,
        timed_out: Boolean(body.timed_out),
      };
    }
    return { ok: false, reason: 'failed', detail: body.error ?? `HTTP ${res.status}` };
  } catch (err) {
    return { ok: false, reason: 'relay_unavailable', detail: err instanceof Error ? err.message : String(err) };
  }
}

/** List every container on the host (docker ps -a equivalent) via the relay. */
export async function list_containers(opts: OpsRelayOptions = {}): Promise<OpsListResult> {
  const url = (opts.url ?? process.env.HEARTH_OPS_RELAY_URL ?? '').replace(/\/$/, '');
  const token = opts.token ?? process.env.HEARTH_OPS_RELAY_TOKEN;
  if (!url) return { ok: false, reason: 'relay_unavailable', detail: 'HEARTH_OPS_RELAY_URL not set' };
  const fetchImpl = opts.fetchImpl ?? fetch;
  try {
    const res = await fetchImpl(`${url}/containers`, {
      method: 'GET',
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      signal: AbortSignal.timeout(opts.timeout_ms ?? 25_000),
    });
    if (res.ok) {
      const body = (await res.json().catch(() => ({}))) as { containers?: ContainerSummary[] };
      return { ok: true, reason: 'ok', containers: Array.isArray(body.containers) ? body.containers : [] };
    }
    const text = await res.text().catch(() => '');
    return { ok: false, reason: 'failed', detail: `HTTP ${res.status}: ${text.slice(0, 160)}` };
  } catch (err) {
    return { ok: false, reason: 'relay_unavailable', detail: err instanceof Error ? err.message : String(err) };
  }
}

/** Inspect one container's diagnostic state (running/exited, health, exit code,
 *  restart count, OOM) via the relay. */
export async function inspect_container(
  service: string,
  opts: OpsRelayOptions = {},
): Promise<OpsInspectResult> {
  const url = (opts.url ?? process.env.HEARTH_OPS_RELAY_URL ?? '').replace(/\/$/, '');
  const token = opts.token ?? process.env.HEARTH_OPS_RELAY_TOKEN;
  if (!url) return { ok: false, reason: 'relay_unavailable', extra: 'HEARTH_OPS_RELAY_URL not set' };
  const fetchImpl = opts.fetchImpl ?? fetch;
  try {
    const res = await fetchImpl(`${url}/inspect/${encodeURIComponent(service)}`, {
      method: 'GET',
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      signal: AbortSignal.timeout(opts.timeout_ms ?? 25_000),
    });
    if (res.ok) {
      const body = (await res.json().catch(() => ({}))) as { detail?: InspectDetail };
      return { ok: true, reason: 'ok', detail: body.detail };
    }
    if (res.status === 404) return { ok: false, reason: 'failed', extra: `no such container "${service}"` };
    const text = await res.text().catch(() => '');
    return { ok: false, reason: 'failed', extra: `HTTP ${res.status}: ${text.slice(0, 160)}` };
  } catch (err) {
    return { ok: false, reason: 'relay_unavailable', extra: err instanceof Error ? err.message : String(err) };
  }
}
