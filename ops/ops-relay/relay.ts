/**
 * hearth-ops-relay — a tiny, tightly-scoped service-restart relay.
 *
 * WHY THIS EXISTS
 * ---------------
 * The Hearth orchestrator runs inside a Docker container with no host sudo and
 * no Docker access, so it can't recover a wedged dependency itself. When a
 * service dies silently (Firecrawl's worker sat dead for 8 days), the system
 * could detect + surface it but not FIX it — the last rung of "help solve it"
 * was missing. This relay is the guarded remediation hook: the orchestrator
 * POSTs here and the relay restarts an ALLOWLISTED container via the Docker
 * Engine API over the mounted socket. Same pattern as hearth-wol-relay (a
 * host-side helper Hearth calls to do something it can't from its container).
 *
 * SECURITY MODEL (load-bearing — read before changing)
 * ----------------------------------------------------
 *   - The ONLY thing this relay can do is `restart` a container whose name is
 *     on the env ALLOWLIST (HEARTH_OPS_RESTART_ALLOWED). Default empty ⇒
 *     nothing is restartable until the owner opts a service in. It is NOT a
 *     general Docker exec surface — there is no create/exec/inspect/stop path.
 *   - Bearer-token gated, even on the LAN (it can restart infra). No token ⇒
 *     every /restart is refused (fail-closed).
 *   - The requested service is checked against the allowlist BEFORE any Docker
 *     call, and validated to a safe name shape. Input is never interpolated
 *     into a shell (there is no shell — it's an HTTP call to the socket).
 *   - Blast radius if the bearer leaks: restart an allowlisted service. That's
 *     it. (Hardening option: front the socket with a `docker-socket-proxy`
 *     scoped to container restart only.)
 *
 * ENDPOINTS  (READ-ANY reads, allowlist-narrow writes — 2026-07-08)
 * ---------
 *   GET  /health                  → { ok, service: 'ops-relay', allowlist }  (no auth)
 *   GET  /containers               (Bearer)  → READ-ONLY inventory of every container
 *   GET  /inspect/<service>        (Bearer)  → READ-ONLY container state (health/exit/restarts)
 *   GET  /logs/<service>?tail=N    (Bearer)  → READ-ONLY container log tail
 *   POST /restart  { service }     (Bearer + ALLOWLIST)  → restarts the container
 *
 * The READ endpoints (list / inspect / logs) are bearer-gated but NOT
 * allowlisted (the 2026-07-08 read-any change): reading a container's
 * inventory/state/logs is low blast radius, and it's what makes "is Plex down?
 * why? what's wrong with the server?" answerable across the WHOLE stack — for
 * Kate's owner-only service mode (Phase B) and Beatrice's self-diagnosis loop
 * alike. WRITES (/restart, /deploy) keep the NARROW `HEARTH_OPS_RESTART_ALLOWED`
 * allowlist: a name not on it 403s before any Docker call. There is still no
 * create/exec/stop path. Blast radius if the bearer leaks: READ any container's
 * state/logs (no secrets — logs only), RESTART only an allowlisted service.
 *
 * The read endpoints also surface each container's COMPOSE ORIGIN from its own
 * Docker labels (project / service / working_dir / config_files — 2026-07-25),
 * so an ops answer can quote the compose file that actually governs a container
 * instead of guessing a plausible-looking directory. A container with no compose
 * labels reports `compose: null` (bare `docker run`) — an honest absence.
 *
 * ENV
 * ---
 *   HEARTH_OPS_RELAY_TOKEN        REQUIRED shared secret (Bearer). Unset ⇒ /restart refused.
 *   HEARTH_OPS_RELAY_PORT         listen port (default 9098)
 *   HEARTH_OPS_RELAY_BIND         listen address (default 0.0.0.0)
 *   HEARTH_OPS_RESTART_ALLOWED    comma-separated container allowlist (empty ⇒ none)
 *   HEARTH_OPS_DOCKER_SOCKET      docker socket path (default /var/run/docker.sock)
 *
 * Dependency-free + self-contained: runs as `bun run ops/ops-relay/relay.ts`
 * off the same bind-mounted repo + image the orchestrator uses, with
 * /var/run/docker.sock mounted in. No docker CLI, no Dockerfile change.
 */

// ─── safe service name ───────────────────────────────────────────────────────

/** Container names are [a-zA-Z0-9][a-zA-Z0-9_.-]* — reject anything else so a
 *  weird value can never reach the socket even by mistake. */
export function validServiceName(s: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(s);
}

/** A service REF is either a local container name (`vllm` ) or a host-qualified
 *  remote one (`forza:vllm-vision`). Both halves of a remote ref must each be a
 *  valid name — so a single `:` is the only special char, and nothing weird can
 *  reach the socket or an ssh argv. */
export function parseServiceRef(
  ref: string,
): { kind: 'local'; container: string } | { kind: 'remote'; host: string; container: string } | null {
  const i = ref.indexOf(':');
  if (i < 0) return validServiceName(ref) ? { kind: 'local', container: ref } : null;
  const host = ref.slice(0, i);
  const container = ref.slice(i + 1);
  if (!validServiceName(host) || !validServiceName(container)) return null;
  return { kind: 'remote', host, container };
}

/** Accept a local name OR a `host:container` remote ref. */
export function validServiceRef(s: string): boolean {
  return parseServiceRef(s) !== null;
}

// ─── relay config + handler ──────────────────────────────────────────────────

/** Result of a restart attempt. */
export interface RestartResult {
  ok: boolean;
  status: number;
  error?: string;
}

/** Result of a read-only log fetch. */
export interface LogsResult {
  ok: boolean;
  status: number;
  logs?: string;
  error?: string;
}

/**
 * Where a container CAME FROM, read from its own Docker labels (2026-07-25).
 * Compose stamps every container it creates with the project name, the service
 * name, the project's working dir, and the config file(s) it was defined in —
 * so this is the ground truth for "which compose file governs this container",
 * and it is what makes an ops instruction quotable instead of guessable. A
 * container started with a bare `docker run` carries NO compose labels; that
 * case is `null`, and callers must SAY so rather than inventing a path.
 */
export interface ComposeOrigin {
  /** com.docker.compose.project — e.g. "docker" for /docker/docker-compose.yml. */
  project: string;
  /** com.docker.compose.service — the service key inside that file. */
  service: string;
  /** com.docker.compose.project.working_dir — the dir compose was invoked from. */
  working_dir?: string;
  /** com.docker.compose.project.config_files — absolute path(s) of the file(s). */
  config_files?: string[];
}

/** Pull the compose origin out of a container's labels. Null = not
 *  compose-managed (bare `docker run`) — an honest absence, never a guess. */
export function composeOriginFromLabels(
  labels: Record<string, unknown> | null | undefined,
): ComposeOrigin | null {
  if (!labels || typeof labels !== 'object') return null;
  const get = (k: string): string | undefined => {
    const v = (labels as Record<string, unknown>)[k];
    return typeof v === 'string' && v.trim() ? v.trim() : undefined;
  };
  const project = get('com.docker.compose.project');
  if (!project) return null;
  const files = get('com.docker.compose.project.config_files');
  const working_dir = get('com.docker.compose.project.working_dir');
  return {
    project,
    service: get('com.docker.compose.service') ?? '',
    ...(working_dir ? { working_dir } : {}),
    ...(files ? { config_files: files.split(',').map((f) => f.trim()).filter(Boolean) } : {}),
  };
}

/** One container in the read-only inventory (docker ps equivalent). */
export interface ContainerSummary {
  name: string;
  image: string;
  state: string; // running | exited | restarting | paused | created | dead
  status: string; // human string, e.g. "Up 15 hours (healthy)" / "Exited (1) 3 min ago"
  /** Compose origin from labels; null = bare `docker run` (no compose file). */
  compose?: ComposeOrigin | null;
}

/** Result of a read-only container list (GET /containers). */
export interface ListResult {
  ok: boolean;
  status: number;
  containers?: ContainerSummary[];
  error?: string;
}

/** Read-only container state (the diagnostic-relevant fields of docker inspect). */
export interface InspectDetail {
  name: string;
  image: string;
  state: string;
  health?: string; // healthy | unhealthy | starting | (none)
  exit_code?: number;
  restart_count?: number;
  oom_killed?: boolean;
  started_at?: string;
  finished_at?: string;
  error?: string; // container State.Error
  /** Compose origin from labels; null = bare `docker run` (no compose file). */
  compose?: ComposeOrigin | null;
}

/** Result of a read-only inspect (GET /inspect/<name>). */
export interface InspectResult {
  ok: boolean;
  status: number;
  detail?: InspectDetail;
  error?: string;
}

// ─── host diagnostics: open-ended command, bounded ENVIRONMENT (2026-07-25) ───
//
// The 07-25 outage had a second cause behind the invented path: Kate can see
// INSIDE containers (state, logs) and nothing about the MACHINE. Every fault
// below the container boundary — driver vs kernel module, disk, thermals,
// memory pressure — was structurally invisible, so when one occurred her only
// options were "I can't see that" or a confident guess. She guessed.
//
// The fix is NOT a list of blessed commands (`nvidia-smi`, `df`, `free` …) —
// that closes one incident and stops at the next unanticipated fault, which is
// the specific-case carve-out this repo bans. Instead we bound the ENVIRONMENT
// and leave the command open: any command runs, inside a throwaway container
// that structurally cannot do harm.
//
// THE WALLS (each one load-bearing — read before loosening):
//   - `--network none`      no egress, so nothing read can be exfiltrated
//   - `ReadonlyRootfs`      + a read-only bind of `/` ⇒ nothing can be written
//   - `CapDrop: ALL` + `no-new-privileges` + `User: 65534` (nobody)
//   - `--rm` after read     no persistence between calls
//   - memory + pids caps + a hard wall-clock timeout
//
// WHY `nobody` IS THE REAL SECRET GATE. Ordinary Unix permissions already deny
// the whole credential surface to an unprivileged uid — hearth.env (0600),
// .git-credentials (0600), the scrum token (0600), /etc/shadow (0640
// root:shadow), /var/lib/docker (0710 root), every ~/.ssh key (0600), and
// /proc/<pid>/environ (0400, owner-only) are all unreadable without us
// predicting a single path. That is structural, not a denylist we can get wrong.
//
// WHAT THE DENYLIST IS ACTUALLY FOR — the CORDON, not the secrets. The three
// stores that ARE world-readable are `/docker/hearth/data/*.db` (audit log,
// conversations), the vault and the library — and those hold Sam's and Kim's
// private notes. Every read path in Hearth goes through `note_visible_to_caller`
// and the standing invariant is that the OWNER HAS NO GOD-VIEW; a raw filesystem
// read has no concept of `private_to`, so it would void that by construction.
// Those paths are shadowed with an empty tmpfs (dirs) or /dev/null (files) so
// they read as absent rather than as data. Extendable via HEARTH_OPS_DIAG_DENY.

/** Result of a sandboxed host diagnostic (POST /diag). */
export interface DiagResult {
  ok: boolean;
  status: number;
  /** Combined stdout+stderr, demuxed, redacted and capped. */
  output?: string;
  exit_code?: number;
  timed_out?: boolean;
  error?: string;
}

/** The cordoned stores — shadowed so a raw read can't bypass `private_to`.
 *  Everything else sensitive is already denied by running as `nobody`. */
export const DEFAULT_DIAG_DENY = [
  '/docker/hearth/vault',
  '/docker/hearth/library',
  '/docker/hearth/data',
];

/** Secret-shaped output is scrubbed at the boundary, before it can reach an
 *  audit row. A path denylist can be walked around (symlinks, /proc/1/root,
 *  a bind mount we didn't predict); this net doesn't depend on predicting
 *  paths at all, so it's the layer that catches what the mounts miss. */
export function redact_secrets(text: string): string {
  return text
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[REDACTED private key]')
    .replace(/\b(gh[pousr]_[A-Za-z0-9]{16,})/g, '[REDACTED token]')
    .replace(/\b(sk-[A-Za-z0-9_-]{16,})/g, '[REDACTED token]')
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, '[REDACTED aws key]')
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '[REDACTED jwt]')
    // KEY=VALUE lines whose key smells like a credential (env-file shapes).
    .replace(
      /^([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|APIKEY|API_KEY|PRIVATE_KEY|CREDENTIAL)[A-Z0-9_]*)\s*=\s*\S+/gim,
      '$1=[REDACTED]',
    );
}

/** Build the Docker create-container spec for one diagnostic run. PURE, so the
 *  smoke asserts every wall without a daemon. */
export function build_diag_spec(
  command: string,
  opts: { image: string; deny: string[]; memory_mb?: number; workdir?: string },
): Record<string, unknown> {
  const tmpfs: Record<string, string> = { '/tmp': 'rw,noexec,nosuid,size=16m' };
  const binds: string[] = ['/:/host:ro'];
  for (const p of opts.deny) {
    const abs = p.startsWith('/') ? p.replace(/\/+$/, '') : null;
    if (!abs) continue;
    // A directory reads as empty; a file reads as empty. Either way: absent,
    // not denied — nothing to probe around.
    if (/\.[A-Za-z0-9]{1,8}$/.test(abs)) binds.push(`/dev/null:/host${abs}:ro`);
    else tmpfs[`/host${abs}`] = 'ro,size=1k';
  }
  return {
    Image: opts.image,
    Cmd: ['/bin/sh', '-c', command],
    User: '65534:65534', // nobody — the real secret gate (see the note above)
    WorkingDir: opts.workdir ?? '/host',
    Env: [],
    NetworkDisabled: true,
    HostConfig: {
      Binds: binds,
      Tmpfs: tmpfs,
      NetworkMode: 'none',
      ReadonlyRootfs: true,
      CapDrop: ['ALL'],
      SecurityOpt: ['no-new-privileges'],
      PidMode: 'host', // process visibility (read-only; environ stays 0400)
      PidsLimit: 256,
      Memory: (opts.memory_mb ?? 512) * 1024 * 1024,
      AutoRemove: false, // removed by hand AFTER the logs are read
    },
  };
}

/** Run one diagnostic in a throwaway sandbox via the Docker Engine API:
 *  create → start → wait (bounded) → read logs → remove. Never throws. */
export function diagViaDocker(
  socket: string,
  cfg: { image: string; deny: string[]; timeout_ms: number; max_output: number },
): (command: string) => Promise<DiagResult> {
  return async (command) => {
    const call = async (path: string, init: RequestInit = {}, ms = 20_000) =>
      fetch(`http://localhost${path}`, {
        ...init,
        signal: AbortSignal.timeout(ms),
        unix: socket,
      } as RequestInit & { unix: string });

    let id = '';
    let timed_out = false;
    try {
      const created = await call('/containers/create', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(build_diag_spec(command, { image: cfg.image, deny: cfg.deny })),
      });
      if (created.status !== 201) {
        const body = await created.text().catch(() => '');
        return { ok: false, status: created.status, error: `create failed: ${body.slice(0, 200)}` };
      }
      id = String(((await created.json()) as { Id?: string }).Id ?? '');
      if (!id) return { ok: false, status: 502, error: 'create returned no container id' };

      const started = await call(`/containers/${id}/start`, { method: 'POST' });
      if (started.status !== 204) {
        const body = await started.text().catch(() => '');
        return { ok: false, status: started.status, error: `start failed: ${body.slice(0, 200)}` };
      }

      let exit_code: number | undefined;
      try {
        const waited = await call(`/containers/${id}/wait`, { method: 'POST' }, cfg.timeout_ms);
        exit_code = ((await waited.json()) as { StatusCode?: number }).StatusCode;
      } catch {
        timed_out = true;
        await call(`/containers/${id}/kill`, { method: 'POST' }, 10_000).catch(() => undefined);
      }

      const logs = await call(`/containers/${id}/logs?stdout=1&stderr=1&tail=4000`);
      let output = '';
      if (logs.status === 200) output = demuxDockerLogs(new Uint8Array(await logs.arrayBuffer()));
      output = redact_secrets(output);
      if (output.length > cfg.max_output) {
        output = output.slice(0, cfg.max_output) + `\n… [truncated at ${cfg.max_output} chars]`;
      }
      return { ok: !timed_out, status: 200, output, exit_code, timed_out };
    } catch (err) {
      return { ok: false, status: 0, error: err instanceof Error ? err.message : String(err) };
    } finally {
      if (id) await call(`/containers/${id}?force=1&v=1`, { method: 'DELETE' }, 15_000).catch(() => undefined);
    }
  };
}

export interface RelayConfig {
  token: string | undefined;
  /** Allowlisted service refs (local names AND `host:container` remotes).
   *  Empty ⇒ nothing restartable. */
  allowedServices: Set<string>;
  dockerSocket: string;
  /** label → `user@host` for remote (SSH) restarts. A `host:container` ref whose
   *  host isn't here is rejected. Optional — absent ⇒ no remote restarts (local
   *  firecrawl/searxng path unchanged; existing test configs need no update). */
  remoteHosts?: Map<string, string>;
  /** Path to the SSH private key for remote restarts (mounted into the relay).
   *  The key is forced-command-restricted on the remote, so it can ONLY restart
   *  allowlisted containers there — least privilege. */
  sshKey?: string | undefined;
  /** Injectable for tests; defaults to the real local/remote dispatcher. */
  restart?: (service: string) => Promise<RestartResult>;
  /** Injectable for tests; defaults to the real Docker-socket log read. */
  fetchLogs?: (service: string, tail: number) => Promise<LogsResult>;
  /** Injectable for tests; defaults to the real Docker-socket container list.
   *  READ-ANY (bearer only, not allowlisted) — the diagnostic-visibility half. */
  list?: () => Promise<ListResult>;
  /** Injectable for tests; defaults to the real Docker-socket inspect. READ-ANY. */
  inspect?: (service: string) => Promise<InspectResult>;
  /** Sandboxed host diagnostic (POST /diag). Injectable for tests; defaults to
   *  the real throwaway-container runner. Unset `diagImage` ⇒ endpoint disabled
   *  (fail-closed: the surface only exists once the owner opts in). */
  diag?: (command: string) => Promise<DiagResult>;
  diagImage?: string | undefined;
  diagDeny?: string[];
  diagTimeoutMs?: number;
  diagMaxOutput?: number;
  /** Health-gated deploy (2026-07-05). Repo dir the relay bind-mounts
   *  (HEARTH_OPS_REPO_DIR, default /app) + the orchestrator health URL
   *  (HEARTH_OPS_HEALTH_URL). Both fns injectable for tests. */
  repoDir?: string;
  healthUrl?: string;
  run_git?: (args: string[]) => Promise<{ ok: boolean; out: string; error?: string }>;
  probe_health?: () => Promise<boolean>;
  /** Health-poll budget (ms) + interval (ms) — short in tests. */
  healthBudgetMs?: number;
  healthIntervalMs?: number;
}

export interface DeployRecord {
  at: string;
  prev_sha: string;
  to_sha: string | null;
  status: 'deployed' | 'noop' | 'pull_failed' | 'rolled_back' | 'rollback_failed';
  detail: string;
}

function run_git_in(repo: string): (args: string[]) => Promise<{ ok: boolean; out: string; error?: string }> {
  return async (args) => {
    try {
      const proc = Bun.spawn(['git', '-C', repo, ...args], { stdout: 'pipe', stderr: 'pipe' });
      const [out, err] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      const code = await proc.exited;
      return code === 0
        ? { ok: true, out: out.trim() }
        : { ok: false, out: out.trim(), error: err.trim().slice(0, 400) };
    } catch (err) {
      return { ok: false, out: '', error: String(err).slice(0, 400) };
    }
  };
}

function probe_url(url: string): () => Promise<boolean> {
  return async () => {
    try {
      const resp = await fetch(url, { signal: AbortSignal.timeout(4000) });
      return resp.ok;
    } catch {
      return false;
    }
  };
}

/**
 * The health-gated deploy sequence — pull, restart, prove the boot, roll
 * back on failure. Pure over the injected seams so the smoke scripts every
 * branch. Rollback is a detached `git checkout <prev>` (never reset --hard:
 * the deploy clone carries deliberate drift, e.g. users.yaml); the next
 * good deploy's `checkout main` + pull recovers the branch.
 */
export async function run_deploy(
  cfg: RelayConfig,
  restart: (service: string) => Promise<RestartResult>,
  service: string,
): Promise<DeployRecord> {
  const git = cfg.run_git ?? run_git_in(cfg.repoDir ?? '/app');
  const probe = cfg.probe_health ?? probe_url(cfg.healthUrl ?? 'http://hearth-orchestrator:7700/status');
  const budget = cfg.healthBudgetMs ?? 90_000;
  const interval = cfg.healthIntervalMs ?? 5_000;
  const at = new Date().toISOString();

  const prev = await git(['rev-parse', 'HEAD']);
  if (!prev.ok) return { at, prev_sha: '', to_sha: null, status: 'pull_failed', detail: `rev-parse failed: ${prev.error}` };

  // Re-attach if a prior rollback left a detached HEAD, then pull.
  await git(['checkout', 'main']);
  const pull = await git(['pull', '--ff-only']);
  if (!pull.ok) return { at, prev_sha: prev.out, to_sha: null, status: 'pull_failed', detail: `pull failed: ${pull.error}` };
  const now_sha = await git(['rev-parse', 'HEAD']);
  const to = now_sha.ok ? now_sha.out : null;
  if (to === prev.out) return { at, prev_sha: prev.out, to_sha: to, status: 'noop', detail: 'already at target; no restart' };

  await restart(service);
  const healthy = async (): Promise<boolean> => {
    const deadline = Date.now() + budget;
    while (Date.now() < deadline) {
      if (await probe()) return true;
      await new Promise((r) => setTimeout(r, interval));
    }
    return false;
  };

  if (await healthy()) {
    return { at, prev_sha: prev.out, to_sha: to, status: 'deployed', detail: 'boot healthy' };
  }

  // Unhealthy → roll back to the recorded sha and prove THAT boot.
  const back = await git(['checkout', prev.out]);
  await restart(service);
  const recovered = await healthy();
  if (back.ok && recovered) {
    return {
      at, prev_sha: prev.out, to_sha: to, status: 'rolled_back',
      detail: `deploy of ${to?.slice(0, 8)} failed boot health; running ${prev.out.slice(0, 8)} again`,
    };
  }
  return {
    at, prev_sha: prev.out, to_sha: to, status: 'rollback_failed',
    detail: `deploy failed AND rollback ${back.ok ? 'boot stayed unhealthy' : `checkout failed: ${back.error}`} — manual intervention needed`,
  };
}

export function configFromEnv(env: Record<string, string | undefined>): RelayConfig {
  const allow = (env.HEARTH_OPS_RESTART_ALLOWED ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && validServiceRef(s));
  // HEARTH_OPS_REMOTE_HOSTS = "forza=jasper@192.168.0.188,other=user@host"
  const remoteHosts = new Map<string, string>();
  for (const pair of (env.HEARTH_OPS_REMOTE_HOSTS ?? '').split(',').map((s) => s.trim()).filter(Boolean)) {
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    const label = pair.slice(0, eq).trim();
    const target = pair.slice(eq + 1).trim();
    if (validServiceName(label) && target) remoteHosts.set(label, target);
  }
  return {
    token: env.HEARTH_OPS_RELAY_TOKEN?.trim() || undefined,
    allowedServices: new Set(allow),
    dockerSocket: env.HEARTH_OPS_DOCKER_SOCKET?.trim() || '/var/run/docker.sock',
    remoteHosts,
    sshKey: env.HEARTH_OPS_SSH_KEY?.trim() || undefined,
    repoDir: env.HEARTH_OPS_REPO_DIR?.trim() || '/app',
    healthUrl: env.HEARTH_OPS_HEALTH_URL?.trim() || 'http://hearth-orchestrator:7700/status',
    // Host diagnostics — fail-closed: no image configured ⇒ /diag is disabled.
    diagImage: env.HEARTH_OPS_DIAG_IMAGE?.trim() || undefined,
    diagDeny: [
      ...DEFAULT_DIAG_DENY,
      ...(env.HEARTH_OPS_DIAG_DENY ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.startsWith('/')),
    ],
    diagTimeoutMs: Number(env.HEARTH_OPS_DIAG_TIMEOUT_MS ?? '') || 30_000,
    diagMaxOutput: Number(env.HEARTH_OPS_DIAG_MAX_OUTPUT ?? '') || 20_000,
  };
}

/** Restart a container via the Docker Engine API over the unix socket.
 *  POST /containers/<name>/restart → 204 on success. */
export function restartViaDocker(socket: string): (service: string) => Promise<RestartResult> {
  return async (service) => {
    const init = {
      method: 'POST',
      signal: AbortSignal.timeout(30_000),
      unix: socket,
    } as RequestInit & { unix: string };
    try {
      const res = await fetch(
        `http://localhost/containers/${encodeURIComponent(service)}/restart`,
        init,
      );
      if (res.status === 204) return { ok: true, status: 204 };
      const body = await res.text().catch(() => '');
      return { ok: false, status: res.status, error: body.slice(0, 200) || `HTTP ${res.status}` };
    } catch (err) {
      return { ok: false, status: 0, error: err instanceof Error ? err.message : String(err) };
    }
  };
}

/**
 * Restart a container on a REMOTE host over SSH. The key is forced-command-
 * restricted on the remote (authorized_keys `command="…restart wrapper…"`), so
 * the command we send is advisory — the remote wrapper validates the container
 * against its OWN allowlist and runs `docker restart`. We still pass
 * `restart <container>` as SSH_ORIGINAL_COMMAND so the wrapper knows the target.
 * Hard-killed after 45s so a hung ssh can't wedge the relay. BatchMode +
 * IdentitiesOnly so it never falls back to a password prompt or another key.
 */
export function restartViaSsh(target: string, keyPath: string): (container: string) => Promise<RestartResult> {
  return async (container) => {
    let kill: (() => void) | null = null;
    const killer = setTimeout(() => { try { kill?.(); } catch { /* ignore */ } }, 45_000);
    try {
      const proc = Bun.spawn(
        [
          'ssh', '-i', keyPath,
          '-o', 'BatchMode=yes',
          '-o', 'IdentitiesOnly=yes',
          '-o', 'StrictHostKeyChecking=accept-new',
          '-o', 'ConnectTimeout=10',
          target, 'restart', container,
        ],
        { stdout: 'pipe', stderr: 'pipe' },
      );
      kill = () => { try { proc.kill(9); } catch { /* ignore */ } };
      const exit = await proc.exited;
      if (exit === 0) return { ok: true, status: 204 };
      let msg = '';
      try {
        msg = (await new Response(proc.stderr).text()).trim() || (await new Response(proc.stdout).text()).trim();
      } catch { /* ignore */ }
      return { ok: false, status: exit, error: (msg || `ssh exited ${exit}`).slice(0, 200) };
    } catch (err) {
      return { ok: false, status: 0, error: err instanceof Error ? err.message : String(err) };
    } finally {
      clearTimeout(killer);
    }
  };
}

/**
 * The default restarter: dispatch a service ref to the local Docker socket or a
 * remote SSH restart. A `host:container` ref whose host isn't a configured
 * remote, or with no ssh key, fails cleanly (never throws). Local names behave
 * exactly as before — the firecrawl/searxng path is untouched.
 */
export function makeRestarter(cfg: RelayConfig): (service: string) => Promise<RestartResult> {
  const local = restartViaDocker(cfg.dockerSocket);
  return async (service) => {
    const parsed = parseServiceRef(service);
    if (!parsed) return { ok: false, status: 400, error: 'invalid service ref' };
    if (parsed.kind === 'local') return local(parsed.container);
    const target = cfg.remoteHosts?.get(parsed.host);
    if (!target) return { ok: false, status: 400, error: `unknown remote host "${parsed.host}"` };
    if (!cfg.sshKey) return { ok: false, status: 503, error: 'no ssh key configured for remote restart' };
    return restartViaSsh(target, cfg.sshKey)(parsed.container);
  };
}

/**
 * De-multiplex a Docker log stream. When a container has NO TTY, the logs
 * endpoint returns a framed stream: each frame is an 8-byte header
 * `[stream_type, 0, 0, 0, size(uint32 BE)]` followed by `size` payload bytes
 * (stream_type 1=stdout, 2=stderr). When the container HAS a TTY the bytes are
 * raw UTF-8 with no frames. This handles both: it walks frames while they parse
 * cleanly and falls back to treating the whole buffer as raw text the moment a
 * frame header looks wrong — so a TTY stream (or a partial frame) is never
 * mangled. */
export function demuxDockerLogs(buf: Uint8Array): string {
  const dec = new TextDecoder('utf-8', { fatal: false });
  // Heuristic: a framed stream begins with a stream-type byte in {0,1,2} and
  // three zero bytes. If the first frame header doesn't look framed, it's TTY.
  const looksFramed =
    buf.length >= 8 && buf[0]! <= 2 && buf[1] === 0 && buf[2] === 0 && buf[3] === 0;
  if (!looksFramed) return dec.decode(buf);

  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const parts: string[] = [];
  let off = 0;
  while (off + 8 <= buf.length) {
    const stream = buf[off]!;
    if (stream > 2 || buf[off + 1] !== 0 || buf[off + 2] !== 0 || buf[off + 3] !== 0) {
      // Not a valid frame header — bail to raw decode of the remainder.
      parts.push(dec.decode(buf.subarray(off)));
      break;
    }
    const size = view.getUint32(off + 4, false);
    const start = off + 8;
    const end = Math.min(start + size, buf.length);
    parts.push(dec.decode(buf.subarray(start, end)));
    off = end;
  }
  return parts.join('');
}

/** Read a container's recent logs via the Docker Engine API over the unix
 *  socket. READ-ONLY: GET /containers/<name>/logs (stdout+stderr, last `tail`
 *  lines, with timestamps). Returns the demuxed text. */
export function logsViaDocker(socket: string): (service: string, tail: number) => Promise<LogsResult> {
  return async (service, tail) => {
    const init = {
      method: 'GET',
      signal: AbortSignal.timeout(20_000),
      unix: socket,
    } as RequestInit & { unix: string };
    const qs = `stdout=1&stderr=1&timestamps=1&tail=${encodeURIComponent(String(tail))}`;
    try {
      const res = await fetch(
        `http://localhost/containers/${encodeURIComponent(service)}/logs?${qs}`,
        init,
      );
      if (res.status === 200) {
        const buf = new Uint8Array(await res.arrayBuffer());
        return { ok: true, status: 200, logs: demuxDockerLogs(buf) };
      }
      const body = await res.text().catch(() => '');
      return { ok: false, status: res.status, error: body.slice(0, 200) || `HTTP ${res.status}` };
    } catch (err) {
      return { ok: false, status: 0, error: err instanceof Error ? err.message : String(err) };
    }
  };
}

/** Read-only container inventory via the Docker Engine API over the socket:
 *  GET /containers/json?all=1 → every container + state + status string.
 *  READ-ONLY, no create/exec/stop path. */
export function listViaDocker(socket: string): () => Promise<ListResult> {
  return async () => {
    const init = { method: 'GET', signal: AbortSignal.timeout(20_000), unix: socket } as RequestInit & {
      unix: string;
    };
    try {
      const res = await fetch('http://localhost/containers/json?all=1', init);
      if (res.status !== 200) {
        const body = await res.text().catch(() => '');
        return { ok: false, status: res.status, error: body.slice(0, 200) || `HTTP ${res.status}` };
      }
      const arr = (await res.json()) as Array<Record<string, unknown>>;
      const containers: ContainerSummary[] = arr
        .map((c) => ({
          name: (Array.isArray(c.Names) && c.Names[0] ? String(c.Names[0]) : '').replace(/^\//, ''),
          image: String(c.Image ?? ''),
          state: String(c.State ?? ''),
          status: String(c.Status ?? ''),
          compose: composeOriginFromLabels(c.Labels as Record<string, unknown> | undefined),
        }))
        .filter((c) => c.name);
      return { ok: true, status: 200, containers };
    } catch (err) {
      return { ok: false, status: 0, error: err instanceof Error ? err.message : String(err) };
    }
  };
}

/** Read-only container state via GET /containers/<name>/json — the fields a
 *  diagnosis needs (running/exited, health, exit code, restart count, OOM,
 *  timestamps, State.Error). READ-ONLY. */
export function inspectViaDocker(socket: string): (service: string) => Promise<InspectResult> {
  return async (service) => {
    const init = { method: 'GET', signal: AbortSignal.timeout(20_000), unix: socket } as RequestInit & {
      unix: string;
    };
    try {
      const res = await fetch(`http://localhost/containers/${encodeURIComponent(service)}/json`, init);
      if (res.status !== 200) {
        const body = await res.text().catch(() => '');
        return { ok: false, status: res.status, error: body.slice(0, 200) || `HTTP ${res.status}` };
      }
      const j = (await res.json()) as Record<string, any>;
      const st = (j.State ?? {}) as Record<string, any>;
      return {
        ok: true,
        status: 200,
        detail: {
          name: String(j.Name ?? '').replace(/^\//, ''),
          image: String(j.Config?.Image ?? ''),
          state: String(st.Status ?? ''),
          health: st.Health?.Status ? String(st.Health.Status) : undefined,
          exit_code: typeof st.ExitCode === 'number' ? st.ExitCode : undefined,
          restart_count: typeof j.RestartCount === 'number' ? j.RestartCount : undefined,
          oom_killed: Boolean(st.OOMKilled),
          started_at: st.StartedAt ? String(st.StartedAt) : undefined,
          finished_at: st.FinishedAt ? String(st.FinishedAt) : undefined,
          error: st.Error ? String(st.Error) : undefined,
          compose: composeOriginFromLabels(j.Config?.Labels as Record<string, unknown> | undefined),
        },
      };
    } catch (err) {
      return { ok: false, status: 0, error: err instanceof Error ? err.message : String(err) };
    }
  };
}

function bearer(req: Request): string | null {
  const h = req.headers.get('authorization') ?? '';
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m ? m[1]!.trim() : null;
}

/** Constant-time-ish string compare (length-leaking but timing-flat on body). */
function tokenEq(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Pure request handler for a given config (testable without a server). */
export function makeHandler(cfg: RelayConfig) {
  const restart = cfg.restart ?? makeRestarter(cfg);
  const fetchLogs = cfg.fetchLogs ?? logsViaDocker(cfg.dockerSocket);
  const fetchList = cfg.list ?? listViaDocker(cfg.dockerSocket);
  const fetchInspect = cfg.inspect ?? inspectViaDocker(cfg.dockerSocket);
  // Host diagnostics stay OFF until an image is configured — the surface
  // doesn't exist unless the owner opts in (fail-closed, like the allowlist).
  const runDiag =
    cfg.diag ??
    (cfg.diagImage
      ? diagViaDocker(cfg.dockerSocket, {
          image: cfg.diagImage,
          deny: cfg.diagDeny ?? DEFAULT_DIAG_DENY,
          timeout_ms: cfg.diagTimeoutMs ?? 30_000,
          max_output: cfg.diagMaxOutput ?? 20_000,
        })
      : null);
  /** Last deploy outcome + in-flight latch — the orchestrator reads this on
   *  boot to alert the owner after a rollback (the requester dies mid-deploy
   *  when its own container restarts, so the RECORD is the report channel). */
  let last_deploy: DeployRecord | null = null;
  let deploy_in_flight = false;

  /** Shared auth + allowlist gate for the mutating/reading service endpoints.
   *  Returns the validated service name, or a Response to short-circuit. */
  function gate_service(req: Request, service: string): { service: string } | Response {
    if (!cfg.token) {
      return Response.json(
        { ok: false, error: 'relay has no token configured; refusing' },
        { status: 503 },
      );
    }
    const presented = bearer(req);
    if (!presented || !tokenEq(presented, cfg.token)) {
      return Response.json({ ok: false, error: 'unauthorized' }, { status: 401 });
    }
    if (!service || !validServiceRef(service)) {
      return Response.json({ ok: false, error: 'missing or invalid service' }, { status: 400 });
    }
    // The hard gate: only allowlisted names ever reach the socket.
    if (!cfg.allowedServices.has(service)) {
      return Response.json(
        { ok: false, error: `service "${service}" not in allowlist` },
        { status: 403 },
      );
    }
    return { service };
  }

  /** Bearer-only gate for the READ-ANY diagnostic endpoints (list / inspect /
   *  logs). No allowlist — reading a container's state/logs is low blast radius
   *  and is what makes "is Plex down? why?" answerable across the whole stack.
   *  WRITES (/restart, /deploy) keep the narrow `gate_service` allowlist. */
  function check_auth(req: Request): Response | null {
    if (!cfg.token) {
      return Response.json({ ok: false, error: 'relay has no token configured; refusing' }, { status: 503 });
    }
    const presented = bearer(req);
    if (!presented || !tokenEq(presented, cfg.token)) {
      return Response.json({ ok: false, error: 'unauthorized' }, { status: 401 });
    }
    return null;
  }

  return async function handle(req: Request): Promise<Response> {
    const url = new URL(req.url);

    if (req.method === 'GET' && url.pathname === '/health') {
      return Response.json({
        ok: true,
        service: 'ops-relay',
        allowlist: [...cfg.allowedServices],
      });
    }

    // GET /containers — READ-ANY inventory (bearer only, no allowlist). The
    // diagnostic-visibility half: list every container + state so "what's
    // running / what's down" is answerable across the whole stack.
    if (req.method === 'GET' && url.pathname === '/containers') {
      const denied = check_auth(req);
      if (denied) return denied;
      const result = await fetchList();
      if (result.ok) return Response.json({ ok: true, containers: result.containers ?? [] });
      console.warn(`[ops-relay] list failed status=${result.status}: ${result.error ?? ''}`);
      return Response.json({ ok: false, error: result.error ?? `list failed (status ${result.status})` }, { status: 502 });
    }

    // GET /inspect/<service> — READ-ANY container state (bearer only). state /
    // health / exit code / restart count / OOM — the fields a diagnosis needs.
    if (req.method === 'GET' && url.pathname.startsWith('/inspect/')) {
      const denied = check_auth(req);
      if (denied) return denied;
      const service = decodeURIComponent(url.pathname.slice('/inspect/'.length)).trim();
      if (!service || !validServiceRef(service)) {
        return Response.json({ ok: false, error: 'missing or invalid service' }, { status: 400 });
      }
      const result = await fetchInspect(service);
      if (result.ok) return Response.json({ ok: true, service, detail: result.detail });
      return Response.json(
        { ok: false, service, error: result.error ?? `inspect failed (status ${result.status})` },
        { status: result.status === 404 ? 404 : 502 },
      );
    }

    // GET /logs/<service>?tail=N — READ-ANY container log tail (bearer only, no
    // allowlist as of the 2026-07-08 read-any change — reading logs is low blast
    // radius, and it's what makes "why is Plex down?" answerable. WRITES stay
    // allowlisted).
    if (req.method === 'GET' && url.pathname.startsWith('/logs/')) {
      const denied = check_auth(req);
      if (denied) return denied;
      const service = decodeURIComponent(url.pathname.slice('/logs/'.length)).trim();
      if (!service || !validServiceRef(service)) {
        return Response.json({ ok: false, error: 'missing or invalid service' }, { status: 400 });
      }
      const raw = Number(url.searchParams.get('tail') ?? '200');
      const tail = Number.isFinite(raw) && raw > 0 ? Math.min(Math.floor(raw), 2000) : 200;
      const result = await fetchLogs(service, tail);
      if (result.ok) {
        return Response.json({ ok: true, service, tail, logs: result.logs ?? '' });
      }
      console.warn(`[ops-relay] logs failed service=${service} status=${result.status}: ${result.error ?? ''}`);
      return Response.json(
        { ok: false, service, error: result.error ?? `logs failed (status ${result.status})` },
        { status: 502 },
      );
    }

    // POST /diag { command } — run ONE open-ended command in a throwaway,
    // network-less, read-only sandbox as `nobody`. Bearer-gated; NOT
    // allowlisted, because the whole point is that the command isn't predicted
    // — the walls are what make it safe (see the header note above /diag's
    // helpers). Disabled entirely when no HEARTH_OPS_DIAG_IMAGE is configured.
    if (req.method === 'POST' && url.pathname === '/diag') {
      const denied = check_auth(req);
      if (denied) return denied;
      if (!runDiag) {
        return Response.json(
          { ok: false, error: 'host diagnostics are not enabled (set HEARTH_OPS_DIAG_IMAGE)' },
          { status: 503 },
        );
      }
      let body: { command?: unknown };
      try {
        body = (await req.json()) as typeof body;
      } catch {
        return Response.json({ ok: false, error: 'invalid JSON body' }, { status: 400 });
      }
      const command = typeof body.command === 'string' ? body.command.trim() : '';
      if (!command) return Response.json({ ok: false, error: 'missing command' }, { status: 400 });
      if (command.length > 2000) {
        return Response.json({ ok: false, error: 'command too long' }, { status: 400 });
      }
      const result = await runDiag(command);
      // Log the COMMAND, never the output (output can carry household data).
      console.log(`[ops-relay] diag exit=${result.exit_code ?? '?'} cmd=${command.slice(0, 120)}`);
      if (result.ok || result.timed_out) {
        return Response.json({
          ok: result.ok,
          output: result.output ?? '',
          exit_code: result.exit_code ?? null,
          timed_out: Boolean(result.timed_out),
        });
      }
      return Response.json(
        { ok: false, error: result.error ?? `diag failed (status ${result.status})` },
        { status: 502 },
      );
    }

    // GET /deploy/last — the boot-reconciliation read (bearer only; no
    // service param — it reports the relay's own last deploy record).
    if (req.method === 'GET' && url.pathname === '/deploy/last') {
      if (!cfg.token) return Response.json({ ok: false, error: 'relay has no token configured; refusing' }, { status: 503 });
      const presented = bearer(req);
      if (!presented || !tokenEq(presented, cfg.token)) {
        return Response.json({ ok: false, error: 'unauthorized' }, { status: 401 });
      }
      return Response.json({ ok: true, last: last_deploy, in_flight: deploy_in_flight });
    }

    // POST /deploy — health-gated pull + restart + rollback-on-failed-boot.
    // Same bearer + allowlist gate as /restart; the deploy runs DETACHED
    // (the requester is usually the container being restarted).
    if (req.method === 'POST' && url.pathname === '/deploy') {
      let body: { service?: unknown };
      try {
        body = (await req.json()) as typeof body;
      } catch {
        return Response.json({ ok: false, error: 'invalid JSON body' }, { status: 400 });
      }
      const requested = typeof body.service === 'string' ? body.service.trim() : '';
      const gated = gate_service(req, requested);
      if (gated instanceof Response) return gated;
      if (deploy_in_flight) {
        return Response.json({ ok: false, error: 'a deploy is already in flight' }, { status: 409 });
      }
      deploy_in_flight = true;
      const run = run_deploy(cfg, restart, gated.service)
        .then((rec) => {
          last_deploy = rec;
          console.log(`[ops-relay] deploy ${rec.status}: ${rec.detail}`);
        })
        .catch((err) => {
          last_deploy = {
            at: new Date().toISOString(), prev_sha: '', to_sha: null,
            status: 'rollback_failed', detail: `deploy crashed: ${String(err).slice(0, 300)}`,
          };
          console.error('[ops-relay] deploy crashed:', err);
        })
        .finally(() => {
          deploy_in_flight = false;
        });
      void run;
      return Response.json({ ok: true, service: gated.service, dispatched: true });
    }

    if (req.method === 'POST' && url.pathname === '/restart') {
      let body: { service?: unknown };
      try {
        body = (await req.json()) as typeof body;
      } catch {
        return Response.json({ ok: false, error: 'invalid JSON body' }, { status: 400 });
      }

      const requested = typeof body.service === 'string' ? body.service.trim() : '';
      const gated = gate_service(req, requested);
      if (gated instanceof Response) return gated;
      const service = gated.service;

      const result = await restart(service);
      if (result.ok) {
        console.log(`[ops-relay] restarted service=${service}`);
        return Response.json({ ok: true, service, restarted_at: new Date().toISOString() });
      }
      console.warn(`[ops-relay] restart failed service=${service} status=${result.status}: ${result.error ?? ''}`);
      return Response.json(
        { ok: false, service, error: result.error ?? `restart failed (status ${result.status})` },
        { status: 502 },
      );
    }

    return Response.json({ ok: false, error: 'not found' }, { status: 404 });
  };
}

// ─── server bootstrap (only when run directly) ───────────────────────────────

export function startRelay(
  env: Record<string, string | undefined> = process.env,
): { port: number; stop: () => void } {
  const cfg = configFromEnv(env);
  const port = Number(env.HEARTH_OPS_RELAY_PORT ?? '9098');
  const hostname = env.HEARTH_OPS_RELAY_BIND ?? '0.0.0.0';
  const handle = makeHandler(cfg);
  const server = Bun.serve({ port, hostname, fetch: handle });
  console.log(
    `[ops-relay] listening on ${hostname}:${server.port} ` +
      `(token=${cfg.token ? 'set' : 'MISSING — /restart + /logs disabled'}, ` +
      `socket=${cfg.dockerSocket}, ` +
      `allowlist=${cfg.allowedServices.size ? [...cfg.allowedServices].join(',') : 'NONE'}, ` +
      `remotes=${cfg.remoteHosts?.size ? [...cfg.remoteHosts.keys()].join(',') : 'none'}` +
      `${cfg.sshKey ? ` ssh-key=${cfg.sshKey}` : ''})`,
  );
  return { port: server.port ?? port, stop: () => server.stop(true) };
}

if (import.meta.main) {
  startRelay();
}
