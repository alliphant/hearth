# hearth-ops-relay — guarded service-restart sidecar

The orchestrator runs in a Docker container with no host sudo and no Docker
access, so it can't recover a wedged dependency itself. This sidecar is the
guarded remediation hook for the system-health feature: Beatrice's
`restart_service` tool POSTs here, and the relay restarts an **allowlisted**
container via the Docker Engine API over the mounted socket. It also serves a
**read-only** `GET /logs/<service>` — the diagnostic half of self-healing
(`diagnose_dependency`): Beatrice reads the actual crash in a down service's
container logs to feed the local deep-model root-cause diagnosis.

Same pattern as `hearth-wol-relay` (a host-side helper Hearth calls to do
something it can't from its container). Self-contained — runs as
`bun run ops/ops-relay/relay.ts` off the same bind-mounted repo + `hearth:latest`
image, no docker CLI, no Dockerfile change.

## Security model (read before deploying)

- The **only** things it can do are `restart` an allowlisted container or read
  an allowlisted container's `logs`. Both gate on the same env allowlist
  `HEARTH_OPS_RESTART_ALLOWED`. **Default empty ⇒ nothing is restartable or
  readable** until you opt a service in. There is no create/exec/stop/inspect
  path — it is not a general Docker surface. `/logs` is strictly read-only.
- Bearer-token gated, even on the LAN. No token ⇒ every `/restart` AND `/logs`
  is refused (fail-closed). The requested service is checked against the
  allowlist **before** any Docker call and validated to a safe name shape (the
  `/restart` and `/logs` branches share one `gate_service` so the two can never
  diverge on auth or allowlist).
- Blast radius if the bearer leaks: restart or read the logs of an allowlisted
  service. That's it.
- Mounting `/var/run/docker.sock` is the deliberate tradeoff (an opt-in,
  owner-decided one). Hardening option: front the socket with a
  `docker-socket-proxy` scoped to container restart only.

## Endpoints

```
GET  /health                    → { ok, service: 'ops-relay', allowlist }   (no auth)
POST /restart  { service }      (Bearer token)  → restarts the allowlisted container
GET  /logs/<service>?tail=N     (Bearer token)  → { ok, service, tail, logs } — read-only
```

`/logs` reads `GET /containers/<id>/logs` (stdout+stderr, last `tail` lines,
timestamps) and de-multiplexes Docker's framed stream into plain text. `tail`
defaults to 200, capped at 2000.

## Env

| Variable | Default | Where | Purpose |
|---|---|---|---|
| `HEARTH_OPS_RELAY_TOKEN` | — (required) | both | shared Bearer secret. Unset ⇒ /restart refused. |
| `HEARTH_OPS_RESTART_ALLOWED` | _(empty)_ | relay | comma-separated container allowlist (e.g. `firecrawl-worker,searxng`). Empty ⇒ none. |
| `HEARTH_OPS_RELAY_PORT` | `9098` | relay | listen port |
| `HEARTH_OPS_RELAY_BIND` | `0.0.0.0` | relay | listen address |
| `HEARTH_OPS_DOCKER_SOCKET` | `/var/run/docker.sock` | relay | docker socket path |
| `HEARTH_OPS_RELAY_URL` | — | orchestrator | where to POST, e.g. `http://host.docker.internal:9098`. Unset ⇒ remediation degrades to owner-escalation. |
| `HEARTH_OPS_MAX_RESTARTS` | `2` | orchestrator | restart attempts per incident before the circuit-breaker escalates to the owner |

## Compose service (add to `/docker/docker-compose.yml` on the box)

```yaml
hearth-ops-relay:
  image: hearth:latest
  container_name: hearth-ops-relay
  restart: unless-stopped
  network_mode: host                       # reach at host.docker.internal:9098
  # The hearth image runs as uid 1000 (bun); the docker socket is root:docker
  # mode 660, so bun must join the host's docker GROUP to read it. Use the
  # HOST's docker GID — find it with `getent group docker` (984 on the LLM host).
  # Without this every /restart + /logs fails with a bun socket-connect error
  # ("Was there a typo in the url or port?"), NOT an obvious EACCES.
  group_add:
    - "984"                                # host docker GID (box-specific!)
  env_file:
    - /docker/hearth/hearth.env            # shared env (token + allowlist)
  volumes:
    - /docker/hearth/repo:/app             # bind-mounted repo (same as orch)
    - /app/node_modules                    # named volume for deps
    - /var/run/docker.sock:/var/run/docker.sock   # the one privileged mount
  command: ["bun", "run", "ops/ops-relay/relay.ts"]
```

## Deploy

1. `git pull --ff-only origin main` on the LLM host.
2. Add the service block to `/docker/docker-compose.yml` — including `group_add`
   with the **host** docker GID (`getent group docker`).
3. Add `HEARTH_OPS_RELAY_TOKEN`, `HEARTH_OPS_RESTART_ALLOWED`, `HEARTH_OPS_RELAY_URL`
   to `/docker/hearth/hearth.env`.
4. `docker compose up -d hearth-orchestrator hearth-ops-relay` (recreate orch for
   the new env; create the relay).
5. Verify health: `curl -s http://localhost:9098/health` → the allowlist you set.
6. Verify socket access (the part `group_add` enables) — a real log read:
   `curl -s -H "Authorization: Bearer $TOKEN" http://localhost:9098/logs/<allowlisted>?tail=4`
   should return `{"ok":true,...,"logs":"..."}`. `{"ok":false,...,"error":"Was
   there a typo..."}` means `group_add` is missing or the GID is wrong.
   (Live deploy 2026-06-20 set GID 984 + allowlist `firecrawl-worker,searxng`.)

A `relay.ts` change needs only `docker compose restart hearth-ops-relay` (bind
mount). Env/compose changes need `up -d`.

Self-healing is opt-in: with `HEARTH_OPS_RELAY_URL` unset (or the relay not
deployed), the system-health monitor still detects + surfaces + escalates —
remediation just becomes "push the owner to restart it by hand."
