# Voice stack ops — latency & continuity

Deploy target: **the LLM host host** (parakeet/speaches container + Pipecat + the
9B llamacpp unit). Not the dev Mac. See the full runbook at
`/docker/VOICE_STACK_DEPLOY.md` on the LLM host.

## prewarm.sh — keep speaches hot

speaches models load on first request and get evicted when idle, so the first
call after a quiet stretch eats a 1–5s cold load. `prewarm.sh` ensures both
models are resident and exercises the TTS hot path. The 9B is a persistent
systemd unit and stays warm on its own.

Install (the LLM host, user systemd — matches the maps-refresh pattern):

```sh
# Assumes this repo is checked out at ~/hearth on the LLM host.
cp ops/systemd/hearth-voice-prewarm.{service,timer} ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now hearth-voice-prewarm.timer
# Verify a manual run first:
bash ~/hearth/ops/voice/prewarm.sh
```

The timer fires every 5 min from 06:00–23:59 (+ once 2 min after boot). Tune
the window/cadence to the household. Override model ids / URL via env in the
`.service` if they drift from the parakeet defaults.

> First deploy: confirm the `POST /v1/models/{id}` and `POST /v1/audio/speech`
> behavior against your installed speaches version. The script treats 2xx and
> 4xx (already-loaded) as success; a connection failure is a real WARN.

## Conversation continuity — completing the re-greeting fix

The backend half shipped: `POST /api/conversations` accepts `reuse: true`,
which rejoins the caller's most recent thread with the specialist if it's
within `HEARTH_VOICE_REUSE_MS` (default 30 min) instead of minting an empty
conversation. That's what stops the voice agent re-greeting ("Hey Jasper, what's up")
after a mid-call reconnect — a fresh empty conversation had no history, so it
greeted from scratch and dropped the in-flight answer.

**The Pipecat side must opt in.** In `/docker/pipecat/hearth_llm_service.py`,
the lazy conversation-create POST needs the flag:

```python
# POST /api/conversations
payload = {"specialist_id": specialist_id, "user_id": user_id, "reuse": True}
```

Without `reuse: True`, the backend keeps the old create-every-time behavior and
a reconnect still re-greets. Verify with `bun run smoke:voice-reuse` (backend
logic) and a real reconnect-mid-call test once Pipecat sends the flag.
