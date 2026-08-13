# status_flavor — the tiny CPU model behind the live "thinking" line

This serves the **contextual status phrase** shown under the typing bubble while
a specialist works — *"Kate is reconciling thermal shock concerns with consistent
cold brew methods…"* — on the **same `specialist_status` SSE event** every GUI
already renders (web `apply_specialist_status`, iOS `thread.liveStatus`, macOS via
the shared layer). The generator is [src/core/status_flavor.ts](../../src/core/status_flavor.ts);
the role is `status_flavor` in [config/llm-roles.yaml](../../config/llm-roles.yaml).

**It is cosmetic and FAIL-OPEN.** When this endpoint is down/absent or
`HEARTH_STATUS_FLAVOR` is unset, the runtime keeps emitting the deterministic
tool→label line (`_tool_status_phrase`) exactly as before — nothing breaks, no
turn is delayed (the upgrade is computed off the turn's critical path and never
awaited).

## Why a separate tiny CPU model

A 1–1.5B model produces the gerund phrase in ~100–300 ms and costs nothing to
keep resident in **system RAM** on the LLM host's Xeon (Sapphire Rapids / AMX). It
runs **off both GPUs on purpose** so a cosmetic status line can never contend
with chat (`:8088`), voice, deep (`:8200`), vision (`:8096`), or RAG (`:8091`).

Recommended model: **Llama-3.2-1B-Instruct** or **Qwen2.5-1.5B-Instruct**, Q5/Q6.

## Deploy (the LLM host) — DEPLOYED 2026-06-12

Live since 2026-06-12: container `hearth-status-flavor` serving
**Qwen2.5-1.5B-Instruct (Q4_K_M)** on host `:8202`, `HEARTH_STATUS_FLAVOR=1`.
the LLM host is **docker-only (no host sudo)**, so the model runs as a container that
binds host `:8202`; the orchestrator reaches it at
`http://host.docker.internal:8202/v1` (already the role's `base_url`).

1. **Serve the model (CPU, port 8202).** The official llama.cpp server image with
   HF auto-download — the gguf persists in the mounted `LLAMA_CACHE`, so a restart
   doesn't re-download. The `--health-cmd` override points the healthcheck at our
   custom port (**the image default probes `:8080` → a false "unhealthy"**):

   ```bash
   mkdir -p /docker/hearth/status-flavor-models
   docker run -d --restart unless-stopped --name hearth-status-flavor \
     -p 8202:8202 -e LLAMA_CACHE=/models \
     -v /docker/hearth/status-flavor-models:/models \
     --health-cmd 'curl -fsS http://localhost:8202/health || exit 1' \
     --health-interval 30s --health-timeout 5s --health-retries 3 --health-start-period 90s \
     ghcr.io/ggml-org/llama.cpp:server \
     -hf Qwen/Qwen2.5-1.5B-Instruct-GGUF:Q4_K_M \
     --host 0.0.0.0 --port 8202 -c 4096 -t 8 --no-warmup
   ```

   Smoke it directly once `/health` returns 200:

   ```bash
   curl -s http://localhost:8202/v1/chat/completions -H 'content-type: application/json' \
     -d '{"messages":[{"role":"user","content":"Reply with one gerund word: Pondering"}],"max_tokens":8}'
   ```

2. **Pick up the role.** `llm-roles.yaml` is BOOT-loaded (no chokidar watcher), so
   pull + restart (a `restart` IS fine here — bind-mounted code + boot-load):

   ```bash
   cd /docker/hearth/repo && git pull --ff-only origin main
   cd /docker && docker compose restart hearth-orchestrator
   ```

3. **Turn it on.** Add `HEARTH_STATUS_FLAVOR=1` to `/docker/hearth/hearth.env`, then
   **`up -d`, NOT `restart`** — `docker compose restart` re-runs the *same*
   container and does NOT re-read `env_file`; only `up -d` recreates it with the
   new env:

   ```bash
   grep -q '^HEARTH_STATUS_FLAVOR=' /docker/hearth/hearth.env || echo 'HEARTH_STATUS_FLAVOR=1' >> /docker/hearth/hearth.env
   cd /docker && docker compose up -d hearth-orchestrator
   docker exec hearth-orchestrator sh -c 'echo $HEARTH_STATUS_FLAVOR'   # must print 1
   ```

## Verify it's live

Open a specialist chat that runs a tool (e.g. ask Kate something requiring a
calendar/web lookup). The status line under the typing bubble should upgrade from
the plain *"Kate is searching the web…"* to a contextual gerund phrase a beat
later. Audit/confirm the role resolves by checking the orchestrator logs around a
fired turn, or hit the endpoint's request counter.

## Kill switch / rollback

- **Instant, no redeploy:** unset `HEARTH_STATUS_FLAVOR` (the env is read at call
  time) — the line reverts to the deterministic phrase on the next turn.
- Stopping the `:8202` server is also safe: every miss fail-opens.

## Notes

- Safety (no "Terminating…"/"Connecting…"/etc.) is enforced in **code**
  (`validate_status_phrase`'s denylist + gerund/length gate), not the prompt — a
  small model can't be trusted to remember a never-list. Add stems to
  `DENY_GERUND_STEMS` if a new alarming shape ever slips through; don't relax the
  gate.
- Wired only at the two chat-turn `_tool_status_phrase` emit sites
  (`turn()` + `turn_streaming()`). Deliberation/awareness status lines are left on
  the deterministic phrase by design (no user is watching them live).
- Smoke: `bun run smoke:status-flavor` (pure-function + mock LLM; no live model).
