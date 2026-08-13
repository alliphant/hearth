# Design: Satellite1 → Hearth-direct full-duplex voice with barge-in

**Status:** plan, pending the §2 AEC confirmation test. Nothing applied; the live
HA voice path is untouched. Authored 2026-06-07 from a deep planning pass
(read-only device + HA probing + XMOS/ESPHome research). This doc is meant to be
executed from directly.

## 1. Why

The live path is **Satellite1 → HA Assist "Kate (Hearth Voice)" → wyoming-openai
bridge → STT (A4000) + TTS (forza) + conversation agent → Hearth `openai_shim`**.
Two motivating problems:

- **The self-hearing bug.** HA re-opens the follow-up mic on the pipeline's
  *tts-end* (stream sent), not the device's *playback-complete*. With streaming
  TTS, synthesis finishes ~instantly while the device still has 15-20 s of audio
  queued → the mic opens seconds before Kate stops talking → she records herself.
- **The actual want (Jasper):** not the conservative "open the mic only after
  playback" fix, but the opposite — **listen continuously so he can barge in**:
  interrupt Kate mid-sentence to redirect/cancel. That is full-duplex voice, and
  it lives or dies on the device's **acoustic echo cancellation (AEC)** being able
  to cancel Kate's own output out of the always-open mic.

So: move the device **off HA** onto a **Hearth-direct full-duplex loop with
barge-in**, gated on AEC efficacy.

## 2. AEC efficacy — the crux (verdict: GO, pending one test)

**Determination: GO for full-duplex barge-in, conditionally but solidly.**

Evidence the XMOS XU316 AEC is sufficient:
1. **Silicon.** XU316 is the chip behind the **XVF3800 VocalFusion** — spec'd for
   *full-duplex mono AEC, "natural double-talk performance"* (192 ms AEC tail,
   hardware speaker-reference via the **duplex I2S** bus; AEC runs in the XU316,
   not in ESPHome — that's why the ESP-side `noise_suppression_level` / `auto_gain`
   are intentionally off).
2. **Comparable real-world spec.** XVF-class hardware AEC ≈ **18-20 dB echo
   suppression, reliable barge-in over playback at ~6 ft.**
3. **★ Direct on-device proof.** The shipping firmware already runs an on-device
   **"stop" wake-word detector against the AEC'd mic *while Kate's TTS is
   playing*** (the `activate_stop_word_once` script; `micro_wake_word` consumes the
   AEC'd channel). If AEC weren't suppressing the speaker, it would false-trigger
   on Kate's own voice constantly. Keyword spotting during playback working ⇒ AEC
   removes the bulk of the echo today.
4. **Wired for it.** `i2s_audio` is **duplex**; the XU316 taps the speaker I2S
   internally as its AEC reference — the loopback architecture weaker satellites
   lack.

**Residual unknown:** whether FutureProof's *specific* XU316 build (derived from
`sln_voice`, currently **2 of 4 mics**, pipeline `aec__vnr_ic__ns__agc`) is clean
enough for **full open-mic STT** at conversational distance (a step beyond keyword
spotting). That is the one thing the confirmatory test settles.

### The confirmatory test (safe; no firmware flash; ~10-min maintenance window)

A live mic-tap needs a `voice_assistant` audio subscription over the native API,
and the device's Noise login **fails while HA holds the session** (see §4
concurrency) — so the test requires briefly freeing the session. It does NOT flash
anything and is reversible in seconds.

```
Setup:
  - HA → Settings → Devices → Satellite1 → ⋮ → Disable (this device only; 10s, reversible).
  - aioesphomeapi client connects with the device noise PSK (stored in HA's
    core.config_entries) → subscribe_voice_assistant() for the mic stream.
Procedure (double-talk capture), repeat at 1.0 / 2.0 / 3.0 m:
  1. Play a known 10 s Kate TTS clip out the device speaker at normal volume.
  2. At t=3 s a person says a known phrase: "Kate, stop — what's on my calendar tomorrow?"
  3. Record the device's AEC'd mic (channels:0) for the full 10 s → WAV.
  4. Also do a playback-only (no human) capture for the echo-floor reference, and a
     music-playback variant (speech-like echo is the hardest case).
Measure:
  A. ERLE (objective): 10·log10(playback-only power / residual). Target ≥ 15-20 dB.
  B. Functional (the one that matters): feed each double-talk WAV to the SAME STT
     Hearth uses (parakeet faster-whisper-large-v3-turbo, <your-llm-host-ip>:8093,
     /v1/audio/transcriptions). Does the interrupt phrase transcribe over Kate?
     Score WER of the interrupt phrase per distance.
Verdict tree:
  - interrupt clean (WER < ~15%) at ≥ 2 m → FULL-DUPLEX GO.
  - clean only ≤ 1 m / marginal at distance → HYBRID (open-mic close, "stop"-word at distance).
  - garbled at all distances → HALF-DUPLEX fallback (§7). [rated unlikely given proof #3]
Teardown: re-enable HA's integration. Zero persistent change.
```

Expected outcome given all evidence: **HYBRID-to-FULL.** The architecture below is
built for full-duplex and degrades gracefully.

### RESULT — test run 2026-06-07: **FULL-DUPLEX GO** ✅

> **⚠ UPDATE 2026-06-08 — this verdict held for a SINGLE continuous clip; live
> barge-in still FAILED.** The probe below played one 13 s clip; the production
> coordinator streams one clip per sentence, which de-converges the XMOS AEC
> (residual ≈ 20 → ≈ 11 000) and self-barges. Root cause + the ranked fix plan
> are in [design-voice-barge-in.md](design-voice-barge-in.md). The `media_player`
> vs `voice_assistant`-TTS hypothesis is **refuted** there (both are
> AEC-referenced; `send_voice_assistant_audio` is a dead end — no `SPEAKER`
> feature).

Both phases ran against the live device (`scripts/aec-fullduplex-probe.py`;
HA-integration disabled→probe→re-enabled, ~26-29 s outage each, restore verified
via HA `/api/states` on every path, independent watchdog as backstop):

- **Phase 1 — no-human capture (the open firmware question): CONFIRMED.** The stock
  firmware streams the AEC'd mic **continuously while a `media_player` clip plays
  out the speaker** — 48 baseline frames, **378 frames *during* the 12.1 s
  playback** (max inter-frame gap 0.099 s = continuous 32 ms frames), the voice run
  never stopped. The run-gated mic is NOT suspended during playback ⇒ the SPEAKING-
  state "keep the mic open while TTS streams" ask is buildable on **stock firmware**
  (no §5/Phase-5 custom build needed for capture). No-human echo floor: residual
  RMS ≈ 20 (≈ −64 dBFS), STT heard nothing.
- **Phase 2 — human double-talk @ 1 / 2 / 3 m: PASS at ALL THREE.** Jasper said
  "Kate, stop — what's on my calendar tomorrow" over a playing Kate clip; STT
  returned the phrase **verbatim** with **interrupt-phrase WER = 0%** (substring
  metric) and **zero Kate-bleed** (none of the brief's words leaked into the
  capture) at **every** distance — no HYBRID falloff across the conversational
  range. Per the verdict tree (clean at ≥ 2 m) → **FULL-DUPLEX GO.** Notes: raw WER
  can misread ~100% when the phrase is captured twice / amid echo, so the probe
  scores **substring** WER (the correct "did it come through" metric); a first 1 m
  take that read 71% was an off-script utterance (a redo was 0%), and one 3 m run
  needed a retry after a transient run-start hiccup — neither an AEC issue.

**★ The transport fact the coordinator encodes** (the v1→v2 bring-up bug):
`voice_assistant`'s `handle_start` RETURN VALUE selects the audio transport.
`None` → `VoiceAssistantResponse(error=True)` (no stream — what the scaffold's
`device.py` did). A **positive int N** → UDP to port N. **`0`** (with the
`API_AUDIO` subscription flag that `handle_audio=` sets) → frames over the API to
`handle_audio`. Device advertises `voice_assistant_feature_flags=61` (incl.
`API_AUDIO`), so **`_handle_start` returns `0`** — fixed in
`integrations/voice-coordinator/device.py`.

## 3. Architecture — the Hearth Voice Coordinator

A small **always-on `aioesphomeapi` client** (Python), `hearth-voice-coordinator`,
as a **Docker container on the LLM host** (host network; LAN reach to the device at
`192.168.0.29`, parakeet `:8093`, forza `:8023`, orchestrator `:7700`). One
`APIClient` per device; trivially multi-device later.

**Why a coordinator, not custom firmware** (a > b > c):
- **(a) aioesphomeapi client [CHOSEN].** Keeps the proven FutureProof firmware
  (XMOS AEC, OTA, LEDs/timers, sensors) intact; Hearth becomes the device's "Assist
  server." Lowest brick risk, fully reversible (re-point to HA), reuses the device's
  own audio pipeline. This is how HA itself talks to the device.
- **(b) custom ESPHome firmware → Hearth.** More control (raw stereo for our own
  residual-echo gate, `continuous` listening) but every change is a flash = brick
  risk + loses FutureProof's XMOS improvements. Reserve for ONE tuning variant in
  an A/B slot (§6 Phase 5), not the primary.
- **(c) wyoming-satellite on-device.** Wrong layer (another HA-ecosystem protocol);
  no advantage.

### Full-duplex barge-in state machine

The device's `voice_assistant` component (driven over the native API) emits
`VoiceAssistantEventType` events and streams mic audio frames (16 kHz mono, AEC'd,
`channels:0`). The coordinator owns:

```
States: IDLE → LISTENING → THINKING → SPEAKING → (barge-in) → LISTENING

IDLE       on-device micro_wake_word ("hey jarvis"/…) OR LD2450 presence-arm →
           VoiceAssistantWakeWordDetected → coordinator starts a run.
LISTENING  receive AEC'd mic frames → server-side Silero VAD endpointing →
           STT (parakeet /v1/audio/transcriptions) → transcript.
THINKING/  POST /api/conversations {specialist_id:"kate", reuse:true, surface:"voice"}
SPEAKING   POST /api/conversations/{id}/messages {content, surface:"voice"}
           consume the reply via the openai_shim SSE (it already sentence-chunks +
             markdown-strips + dedupes — clean per-sentence text for TTS)
           per chunk: POST forza /v1/audio/speech (EN_F_Laur) → stream PCM to the
             device (voice_assistant TTS frames / media_player)
           *** KEEP the mic subscription + VAD RUNNING the whole time TTS streams ***  ← the ask
BARGE-IN   VAD detects sustained user speech over playback (threshold set ABOVE the
(during    §2-measured residual echo floor; require >~300 ms; optionally gate on
SPEAKING)  LD2450 "someone present & near"):
             1. voice_assistant.stop / media_player.stop  (audio off at device <100 ms)
             2. POST /api/conversations/{id}/cancel        (Hearth aborts the turn → "(stopped)")
             3. cancel the in-flight local TTS synth/stream
             4. → LISTENING, capture the redirect utterance → new turn
```

**Every Hearth route it needs already exists** — no new backend routes:
- `POST /api/conversations` `{specialist_id,user_id,title,reuse:true,surface:"voice"}` — reuse the dedicated voice thread (`resolve_for_user`, specialists.ts:~1035).
- `POST /api/conversations/{id}/messages` `{content,surface:"voice"}` — lean voice turn (`llm_role:'voice_realtime'`, `provider_role:'live'`, `max_tokens_override:200`).
- `POST /v1/chat/completions` `{model:"kate",stream:true,…}` — the sentence-chunking shim (or subscribe `/app/api/events` filtered by conversation_id, the Pipecat pattern).
- **`POST /api/conversations/{id}/cancel`** — the AbortController route (`active_turns`, specialists.ts:~1342). **This is the backend half of barge-in and it already works.**
- TTS: `POST {forza}/v1/audio/speech` (or the existing `/api/voice/tts` proxy).
- Auth: a `mint:service-bearer` token (same as the current HA path).

**Latency budget:**

| stage | est. |
|---|---|
| device mic → coordinator (API frame) | ~30-60 ms (wifi RTT 20-90 ms measured) |
| Silero VAD endpoint | ~100 ms |
| parakeet STT (warm) | ~150-500 ms |
| Hearth lean voice TTFT (9B :8088) | ~250-400 ms |
| forza TTS first chunk (streaming) | ~1-1.5 s |
| **first audible word** | **~1.8-2.5 s** |
| **★ barge-in STOP latency** (speech → audio stops at device) | **<150 ms** (VAD ~100 + API stop <50) |

The **<150 ms stop latency** is what makes interrupting feel instant (under the
~250 ms human "it heard me" threshold).

### Concurrency constraint (confirmed during probing)

The Noise login failed while HA held the session → **HA and the coordinator can't
both hold an authenticated session to the same device.** So migration is a
**handoff** (HA releases → coordinator takes), and A/B testing uses a **second
device**. This is a clean "one voice client per device" model anyway.

## 4. Reproducing HA's affordances, ESP-direct

The native API exposes every entity HA sees; the coordinator subscribes and
republishes into Hearth.

| capability | HA gives free | rebuild as | how |
|---|---|---|---|
| Voice pipeline | Assist pipeline | **coordinator** (§3) | aioesphomeapi `voice_assistant` + parakeet + forza + Hearth conv API |
| LD2450 presence/zones (sensors) | entities | **coordinator → Hearth presence store** | subscribe presence/moving/still binary_sensors + 3 targets (x/y/speed/angle); arms voice, feeds location-awareness |
| **LD2450 zone *editor* (the GUI Jasper wants)** | HA number sliders (Zone-N X1/Y1/X2/Y2) | **Hearth pane** (`pane_kind: presence`/`voice_device`) | zone corners are writable `number` entities + a `zone_type` select over the API → a top-down room canvas with draggable zone rects + live target dots, writing corners back via the coordinator. Same compose-pane + ⚙-settings pattern as the Code Shop office. **Highest-value rebuild; better than HA's raw sliders.** |
| device sensors (temp/humidity/lux, mute/volume/wake-sensitivity selects, LED) | entities | **coordinator → Hearth status** | subscribe; volume/mute writable |
| ESP32 OTA | ESPHome dashboard / HA update entity | **keep ESPHome OTA** | OTA is independent of who holds the API; run an ESPHome dashboard container on the LLM host; the API even exposes an `update` entity |
| XMOS DFU (XU316 audio image) | flashed via `memory_flasher` over I2C from the ESP32 | **keep as-is** | unaffected by the coordinator; pin pipeline `aec__vnr_ic__ns__agc` |
| music / media_player | Music Assistant / HA media | coordinator `media_player` control, OR keep HA for music on a separate device | the one real product trade-off (see §6 step 3) |
| voice timers + LED ring | on-device, HA-aware | coordinator handles timer events | `voice_assistant` emits timer events; LED ring self-manages |

**Net loss by leaving HA:** only HA's broader automation ecosystem touching these
entities + Music Assistant — both addressable (keep HA on a *separate* device for
music/automation, or drive media via the coordinator).

## 5. Migration — incremental, reversible, no big-bang

- **Phase 0 — backend readiness (0 device risk).** Add `scripts/smoke-voice-coordinator.ts` driving create→message→stream→**cancel** against a test conversation (proves the contract). Scaffold the empty `hearth-voice-coordinator` container (connect + enumerate entities + log) against a **dev-kit / 2nd device**, not the live `.29`.
- **Phase 1 — AEC confirmation (10-min window).** Run the §2 test on the live device (disable→test→re-enable HA). Record ERLE + interrupt WER at 1/2/3 m. **Decides full-duplex vs hybrid vs half-duplex before any further build.**
- **Phase 2 — coordinator on a TEST device (parallel to live HA).** Full state machine (§3) against a second device; HA keeps `.29` untouched. This is the A/B rig — same room, two devices, compare "Kate (HA)" vs "Kate (Hearth-direct)" on barge-in feel + latency. No risk to the daily driver.
- **Phase 3 — the LD2450 presence/zone Hearth pane** (§4) against the test device.
- **Phase 4 — A/B promotion.** When Hearth-direct wins, flip the primary: disable HA's integration for `.29`, point the coordinator at it. **Rollback = re-enable HA's integration (10 s, config not firmware).**
- **Phase 5 (optional, only if §2 said "marginal at distance").** ONE custom ESPHome variant (raw stereo for our own residual-echo gate / `continuous` listening / 4-mic pipeline). Flash **via USB-C to the dev-kit first** (never OTA-first, never the daily driver first); ESPHome dual-image OTA auto-reverts a bad flash; XU316 DFU is separate + recoverable. Promote to `.29` only after a clean week.

**No step ever** flashes the live device first, dual-homes one device long-term, or
removes the HA path before the Hearth path is proven.

## 6. Risks + mitigations

| risk | likelihood | mitigation |
|---|---|---|
| AEC insufficient for open-mic STT at distance | low-med (proof #3 says low) | §2 test gates it; **half-duplex fallback (§7) ships regardless** and still beats today |
| bricking via firmware | low *if §5 followed* | stock firmware for Phases 0-4 (coordinator = config-only); custom variant USB-C-to-dev-kit first; dual-OTA auto-revert; XU316 DFU recoverable |
| coordinator as a new always-on dependency | med | small + per-turn-stateless; `restart: unless-stopped` on the LLM host; health endpoint; **if it dies, fallback = re-enable HA's integration** (device not bricked) |
| HA+coordinator API contention | confirmed | one voice client per device; A/B on two devices; cutover is a handoff |
| barge-in false-trigger on Kate's own voice | med | VAD threshold ABOVE the §2 residual floor; require >~300 ms sustained; optionally gate on LD2450 presence; worst case fall back to the "stop" keyword |
| losing HA's free integrations (Music Assistant, automations) | med | voice+presence+zones fully rebuilt (§4); keep HA for music/automation on a separate device, or drive media via the coordinator |
| wifi latency spikes (saw up to ~385 ms) | low-med | wired option if available; accept ~250 ms worst-case stop; not a blocker |

## 7. Half-duplex fallback (ships even if AEC is marginal)

If §2 says open-mic STT can't beat the echo at distance, you **still fix the
self-hearing bug and get intentional interruption**:
- **Mic opens on real playback-COMPLETE**, not tts-stream-sent. The coordinator
  streams the TTS, so unlike HA's pipeline it knows the true end-of-audio and opens
  the listening mic only after the last PCM frame plays. **This alone kills the
  self-hearing bug.**
- **Interrupt = the on-device "stop" word** (already works during playback) →
  coordinator catches `WakeWordDetected("stop")` → cancel + stop playback → open
  mic for the redirect. "Interrupt and redirect" still works; it just costs saying
  "stop" first instead of barging in cold.

This is the guaranteed floor — strictly better than today.

## 8. Facts this builds on

**Device:** `192.168.0.29` (`satellite1-aabbcc`, MAC `02:00:00:aa:bb:cc`), ESPHome
2026.4.5, native API port **6053** (RTT ~20-90 ms). ESP32-S3 + **XMOS XU316**
(XVF3800-class: AEC/beamforming/NS/AGC) + **LD2450 mmWave** + speaker/mic array.
`microphone: platform: satellite1` (48 kHz/32-bit stereo I2S; `voice_assistant`←ch0
AEC'd, `micro_wake_word`←ch1); `i2s_audio` duplex; XMOS pipeline
`aec__vnr_ic__ns__agc`, DFU-flashed to the XU316 over I2C via `memory_flasher`.
Noise PSK in HA's `core.config_entries`.

**HA side (the LLM host):** `homeassistant` container, config `/docker/homeassistant_config`
(`/config`); pipeline "Kate (Hearth Voice)" = `stt.openai`+`tts.openai`(EN_F_Laur)+
`conversation.extended_openai_conversation` → `wyoming-openai` (`/docker/wyoming-openai/run.sh`,
Wyoming :10300) → parakeet `:8093` / forza `:8023` / Hearth shim. continue-conversation
is response/integration-driven (not a static pipeline toggle).

**Hearth repo files the coordinator reuses:**
- `src/app/routes/specialists.ts` — cancel route (~:1342), lean voice turn (~:1233-1285), conversation reuse (~:1035).
- `src/app/routes/openai_shim.ts` — the sentence-chunking SSE bridge to consume.
- `src/app/routes/voice.ts` — existing WebRTC/Pipecat + TTS-proxy + `/api/voice/status` patterns to mirror.
- `apps/orchestrator/server.ts` (~:430) — `/v1` shim mount.
- `scripts/voice-turn-probe.py` — extend into the §2 AEC test harness.

**Sources:** FutureProofHomes Satellite1-ESPHome + Satellite1-XMOS; XMOS XVF3800
datasheet (overview + audio-pipeline); the XU316-AEC HA community thread; ESPHome
`voice_assistant` / `api` (max_connections) / LD2450 docs; aioesphomeapi.

## 9. Next steps
1. ~~**Run the §2 AEC test**~~ — DONE 2026-06-07: **FULL-DUPLEX GO** (see §2 RESULT).
   Capture transport wired into `device.py` (`_handle_start` → `0`).
2. **Phase 2 (§5) — coordinator on a TEST/2nd device.** Build the full state machine
   (LISTENING→THINKING→SPEAKING→barge-in) against a SECOND Satellite1, HA keeps `.29`.
   Needs: the forza-TTS → HTTP-URL bridge for the SPEAKING `media_player` output path
   (option (b) in `device.py.play_tts_audio`), server-side Silero VAD endpointing on
   the API mic stream, and the barge-in `media_player` STOP + `/cancel` wiring
   (`/api/conversations/{id}/cancel` already proven). **Blocked on a 2nd device.**
3. **Decide the music/automation trade-off** (HA-on-a-2nd-device vs coordinator-drives-media) — the only real product choice; everything else is additive.
