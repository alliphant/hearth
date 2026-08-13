# Hearth Voice Coordinator

An `aioesphomeapi` client that runs the FutureProof **Satellite1** as a
**Hearth-direct full-duplex voice device with barge-in** — replacing the
Home Assistant Assist path so Jasper can interrupt Kate mid-sentence.

Design + rationale: [`docs/design-esp-direct-voice.md`](../../docs/design-esp-direct-voice.md).

> **Status: code-complete; the live loop RAN end-to-end on `.29` (2026-06-07).**
> Proven: "Hey Kate" → wake fired `handle_start` → LISTENING → parakeet STT
> ("what's on my calendar tomorrow") → Kate turn → real grounded reply → played
> out the speaker via `media_player`; barge-in STOP fired. The AEC §2 test was
> **FULL-DUPLEX GO** (interrupt WER 0% @ 1/2/3 m). Built on top of that:
> - **Capture**: `handle_start → 0` (API-audio) + `handle_audio(data, data2)`.
> - **Silero VAD** bound + verified on the real AEC capture (speech 1.000 / silence 0.009).
> - **LED ring feedback** via the firmware's VoiceAssistantEvents — `stt_vad_start`
>   → listening, `stt_vad_end` → thinking, `tts_start` → replying, `run_end` → idle
>   (FutureProof `common/voice_assistant.yaml`), with a **per-turn run lifecycle**.
> - **SPEAKING output = duration-driven sentence-streaming (2026-06-08).** Each
>   reply sentence is synthesized as it streams in and played back-to-back via
>   `media_player` announcements (mic stays open), sequenced by each clip's
>   MEASURED mp3 duration — anchored on the device's PLAYING event, ended by
>   IDLE. The earlier "streaming stalls 45 s → buffer-then-speak" revert was a
>   MISDIAGNOSIS: the device reports IDLE reliably; media-state was routed by
>   display name ("Media Player") so IDLE was dropped (→ a `bytes/2200` guess →
>   ~15 s LED-lag). Fixed by routing media state by KEY (`device.py`). Barge-in
>   still tears the pipeline down.
> State machine + LD2450 parsing + splitter unit-tested (43/43); coordinator loop
> smoke green. Confirmed LIVE 2026-06-07: one smooth clip, no gap. **Remaining
> latency is the TURN, not the coordinator** — the voice turn ran a grounding_pack
> (17K tokens_in) so it's NOT hitting the fully-lean path; making it lean (skip
> grounding) is the next latency win (Hearth-side). Then deploy (Dockerfile +
> compose). Nothing is deployed; rollback = re-enable HA.

## Barge-in — A + B + B+ (2026-06-08)

Implemented on this branch; plan + root-cause in
[`docs/design-voice-barge-in.md`](../../docs/design-voice-barge-in.md). The
investigation found the failure was **AEC convergence**, not the output
component: the XMOS `fixed_delay` AEC references *all* speaker output, but
per-sentence multi-clip playback de-converged it (residual ≈20 → ≈11k →
self-barge). The note in older docs that "media_player isn't AEC-referenced" is
refuted; `send_voice_assistant_audio` is a dead end (no `SPEAKER` feature). Fixes,
all coordinator-side, each an env flag:

- **A — Action button** (`HEARTH_VC_BARGE_BUTTON`, default ON). The `btn_action`
  binary_sensor press surfaces over the API; the firmware already stops playback
  locally, and the coordinator cancels the turn + ends the run. Deterministic,
  AEC-independent — working barge today, no validation needed.
- **B — gapless playback** (`HEARTH_VC_TTS_PLAYBACK_MODE=stream_gapless`, default).
  ONE chunked HTTP stream per turn (forza mp3 piped through as it synthesizes) →
  ONE media_player session → the AEC converges once and holds. Same time-to-first-
  word as multi-clip. The device's `AudioReader` streams a chunked/growing body and
  waits on slow reads (source-confirmed, design §9 Q3). Rollback: `=stream`.
- **B+ — adaptive barge gate** (`HEARTH_VC_ENABLE_BARGE_IN`, default **OFF**). The
  state machine gates a barge on rms over an ADAPTIVE floor (decaying peak-hold of
  Kate's residual × ratio), not a fixed constant; the open mic is re-opened during
  the reply only in gapless mode. **OFF until on-device convergence is validated
  (Probe 1, design §7)** — the button covers barge meanwhile.

Tests (green on py3.12): `test_state_machine.py` (48 checks incl. the adaptive
floor) + `test_coordinator_loop.py` (gapless single-stream + button interrupt).
**On-device validation (Probe 1) + flipping `HEARTH_VC_ENABLE_BARGE_IN` on are the
remaining steps** before acoustic open-mic barge goes live; A + B are safe now.

## Why a coordinator (not custom firmware)

It keeps the proven FutureProof firmware (XMOS AEC, OTA, LEDs/timers, sensors)
intact and makes Hearth the device's "Assist server" — exactly how HA itself
talks to the device. Lowest brick risk, fully reversible (re-point to HA). See
design §3 (a > b > c).

## Layout

```
config.py          all-env config (device PSK/host, Hearth bearer/url, STT/TTS urls, VAD/barge-in thresholds)
state_machine.py   ★ the PURE barge-in state machine (stdlib only, unit-tested)
                     IDLE → LISTENING → THINKING → SPEAKING → (barge-in) → LISTENING
ld2450.py          ★ PURE LD2450 presence/zone parsing (stdlib only, unit-tested)
hearth_client.py   conversation API: create(reuse,voice) / message / stream(SSE) / cancel
audio_clients.py   STT (parakeet) + TTS (forza) OpenAI-compat clients
device.py          aioesphomeapi wrapper — connect, enumerate, subscribe states + voice_assistant
                     (gracefully no-ops + logs when it can't acquire a session)
coordinator.py     wires it all together + a /health endpoint; the container entrypoint
tests/             stdlib-only unit tests (no device, no network, no pytest)
Dockerfile         host-network container for the LLM host
docker-compose.snippet.yml   paste into /docker/docker-compose.yml (DO NOT DEPLOY yet)
requirements.txt   aioesphomeapi, httpx, aiohttp, onnxruntime/numpy (Silero VAD)
```

The two `★` modules are stdlib-only on purpose — they hold the decisions that
matter and are fully unit-testable without the device or any network.

## The barge-in contract (proven)

Every Hearth route the loop needs already exists; this build proves the
load-bearing one — **cancel** — end-to-end against the live orchestrator:

```
bun run smoke:voice-coordinator        # from this repo, HEARTH_URL + HEARTH_BEARER set
```

It runs: `POST /api/conversations {reuse:true, surface:"voice"}` →
`POST /api/conversations/{id}/messages {surface:"voice"}` → consume the reply
on the `openai_shim` SSE (`POST /v1/chat/completions {stream:true}`) and on
`/app/api/events` → **mid-stream `POST /api/conversations/{id}/cancel`** →
asserts the turn aborts and persists `"(stopped)"`. That cancel is the backend
half of barge-in; the whole full-duplex design rests on it.

```
# against the live orchestrator on the LLM host (reachable on the LAN):
HEARTH_URL=http://your-llm-host.local:7700 \
HEARTH_BEARER="$(ssh your-llm-host.local cat /docker/hearth/data/claude-scrum-token)" \
  bun run smoke:voice-coordinator
```

## Unit tests (state machine + parsing)

No device, no network, no extra deps:

```
python3 integrations/voice-coordinator/tests/test_state_machine.py
# or: bun run smoke:voice-coordinator-unit
```

Covers: the listen→think→speak path, VAD endpointing, **barge-in firing on
sustained speech over the echo floor**, NO-barge-in below the floor (Kate's own
voice), transient-blip rejection, the presence gate, the "stop"-word interrupt
(§7), playback-complete re-arm (kills the self-hearing bug), and LD2450
presence/near parsing.

## The AEC efficacy test (§2 — DONE 2026-06-07: FULL-DUPLEX GO)

The working harness is **`scripts/aec-fullduplex-probe.py`** (a dual-transport,
double-talk-scoring probe with a safe HA disable→probe→enable bracket that
verifies restore via `/api/states`, plus `scripts/aec-watchdog.sh` as an
independent re-enable backstop). It supersedes the original
`scripts/aec-efficacy-test.py` stub (whose play/capture seams were unbound).

Result: **FULL-DUPLEX GO.** Mic streams continuously during `media_player`
playback; the human interrupt phrase transcribed verbatim (interrupt-phrase WER
**0%** by the substring metric, zero echo bleed) at **1 / 2 / 3 m** — no distance
falloff. Each window was a ~26–29 s household-voice outage. Operator-run only
(needs the device session; NOT CI). Usage:

```
# free the device in HA first (the probe does this itself in its bracket):
HA_TOKEN=… HEARTH_VC_DEVICE_PSK=… python3 scripts/aec-fullduplex-probe.py \
    --interrupt "Kate stop what's on my calendar tomorrow" --distance 2.0
```

## The remaining step — ONE live integration window

The assembled loop has not yet run end-to-end on the device (each primitive is
confirmed; the whole chain is not). When ready, in a maintenance window
(disable HA for `.29` → run → re-enable; rollback is the re-enable):

1. Set the env (`HEARTH_VC_DEVICE_PSK`, `HEARTH_INTERNAL_BEARER`,
   `HEARTH_VC_SELF_HOST=<your-llm-host-ip>`) and run `python -m
   integrations.voice_coordinator.coordinator` on the LLM host (host network).
2. Say the wake word ("Hey Kate") → confirm `handle_start` fires, VAD endpoints
   your utterance, STT transcribes, Kate replies, the reply plays out the
   speaker (`media_player`), and the mic stays open.
3. **Barge in** mid-reply → confirm `media_player` STOP + `/cancel` fire and
   measure the **STOP latency** against the §3 <100 ms / sub-250 ms bar. If it's
   too slow for an announcement, switch the SPEAKING output to
   `send_voice_assistant_audio` + `voice_assistant.stop` (the documented PCM
   alternative in `device.play_tts_audio`).
4. Tune `HEARTH_VC_BARGE_IN_SPEECH_THRESHOLD` so Kate's residual echo never
   self-triggers a barge-in (set it above the §2 floor).

## Deploy (NOT in this pass)

Per design §5: build the image + paste the compose snippet (Phase 0), run the
§2 AEC test (Phase 1), bring the coordinator up against a **2nd device** (Phase
2 — HA keeps `.29`), add the LD2450 pane (Phase 3), then A/B-promote (Phase 4 —
the only step that touches `.29`, and it's a config handoff: disable HA's
integration, point the coordinator at it; rollback = re-enable HA, ~10 s).

Secrets — the device Noise PSK and the Hearth bearer — live ONLY in an
`env_file` (e.g. `/docker/hearth/voice-coordinator.env`, chmod 600), never in
YAML or the image, mirroring the Code Shop secret rule.

### Config quick reference (all env, see `config.py`)

| var | default | what |
|---|---|---|
| `HEARTH_VC_DEVICE_HOST` | `192.168.0.29` | Satellite1 IP |
| `HEARTH_VC_DEVICE_PSK` | — (**secret**) | Noise PSK from HA `core.config_entries` |
| `HEARTH_INTERNAL_BEARER` | — (**secret**) | `mint:service-bearer` token |
| `HEARTH_VC_HEARTH_URL` | `http://127.0.0.1:7700` | orchestrator |
| `HEARTH_VC_SPECIALIST` | `kate` | who answers |
| `HEARTH_VC_STT_URL` | `http://<your-llm-host-ip>:8093/v1` | parakeet |
| `HEARTH_VC_TTS_URL` | `http://192.168.0.188:8023/v1` | forza |
| `HEARTH_VC_TTS_VOICE` | `EN_F_Laur` | TTS voice |
| `HEARTH_VC_SELF_HOST` | `<your-llm-host-ip>` | coordinator's own LAN IP — the device fetches TTS clips from `http://<self_host>:<health_port>/tts/<id>` (must be device-reachable, not 127.0.0.1) |
| `HEARTH_VC_VAD_MODEL` | (baked in image) | path to `silero_vad.onnx`; empty → `models/silero_vad.onnx` next to the package (Dockerfile fetches it; `fetch-vad-model.sh` for local) |
| `HEARTH_VC_BARGE_IN_SPEECH_THRESHOLD` | `0.7` | **set from the §2 AEC result** — the residual-echo floor a real interrupt must clear |
| `HEARTH_VC_BARGE_IN_MIN_MS` | `320` | sustained-speech window for barge-in |
| `HEARTH_VC_GATE_BARGE_ON_PRESENCE` | `false` | also require LD2450 "present & near" to barge in |
| `HEARTH_VC_HEALTH_PORT` | `8094` | `/health` |
```
