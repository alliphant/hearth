# Design: Voice barge-in on the Hearth Voice Coordinator (Satellite1)

**Status:** **WORKING + LIVE** (2026-06-08) — voice barge-in confirmed on the
device: "Hey Kate" mid-reply stops her and she handles the redirect, with smooth
playback and the Action button as a deterministic backup. `main` @ `73681c4`,
`hearth-voice-coordinator` rebuilt on the LLM host. **The design changed materially during
live testing — what actually works is NOT the original A/B/B+ plan in §4–§5 below.**
The final live design:

- **Playback = multi-clip `stream` mode** (smooth). Gapless (Phase B) was
  ABANDONED: it had 2–3 s pauses at every sentence break (the device outruns the
  per-sentence forza synth, stalling the one continuous stream), and its only
  payoff — open-mic AEC convergence — was moot because the open mic never streams
  (the `media_player` playback preempts the opener's run; logs: "NO mic-SPEAKING
  frames"). So the open-mic adaptive-VAD gate (Phase B+) is **not on the live path.**
- **Voice interrupt = the WAKE-WORD barge** ("Hey Kate" mid-reply). The device's
  on-device spotter fires during playback ONLY while a `start_conversation`
  "opener" run is active — fired once per turn (`_maybe_open_barge_mic`, both
  playback modes). The opener's OWN `handle_start` carries the conversation's wake
  phrase ("Hey Kate"), so it must be consumed **regardless of phrase** (`_on_wake`,
  fix `73681c4`) or it self-barges its own turn ("(stopped)"). The original
  investigation wrongly ruled this path out (design-esp-direct-voice.md §2 family of
  "ruled-out #2") — with the opener active, it works.
- **Button (Phase A)** — deterministic, AEC-independent, always reliable.
- **Live config (env_file, persisted):** `HEARTH_VC_TTS_PLAYBACK_MODE=stream`,
  `HEARTH_VC_ENABLE_BARGE_IN=true` (arms the opener + wake-barge),
  `HEARTH_VC_BARGE_BUTTON=true`.
- **Remaining = inference latency, NOT the coordinator.** The mid-reply pause is
  forza TTS + the voice-turn LLM generating the next sentence; the coordinator
  already synth-races-ahead. A faster TTS/STT/LLM box is the lever.

The B/B+ code (gapless stream, adaptive echo-floor gate, `Event.rms`) stays in the
tree behind flags as a tested, dormant alternative (for a future reference-
correlation increment), not on the live path. Unit tests green on py3.12 (state
machine 48; coordinator loop). §4–§5 below is the historical investigation + the
original ranking — read it for the root-cause analysis, but the **live design is
the bullets above.**

Read this with [design-esp-direct-voice.md](design-esp-direct-voice.md) (the
parent design — §2 AEC, §3 state machine, §5 migration, §7 half-duplex). This doc
**supersedes that doc's "FULL-DUPLEX GO" framing** with the corrected,
post-live-failure root cause and the path forward.

---

## TL;DR

- **Barge-in fails for ONE reason: the XMOS AEC loses convergence under the
  coordinator's multi-clip streamed playback.** The hardware AEC references *all*
  speaker output (proven), and a *single* continuous clip cancels cleanly
  (residual RMS ≈ 20). But the production path re-issues one `media_player`
  announcement **per sentence**; each clip boundary shifts the reference↔mic
  delay, and the device runs the **`fixed_delay`** XMOS pipeline variant — which
  does **not** re-estimate that delay — so the adaptive canceller re-converges at
  every gap and the residual spikes to ≈ 11 000 RMS, which masks the mic and
  self-triggers the barge detector.
- **The originally-planned fix (path b — `send_voice_assistant_audio`) is dead.**
  The device does not advertise the `SPEAKER` feature, the native voice_assistant
  flow closes the mic *before* TTS anyway, and `media_player` is *already*
  AEC-referenced. Three independent reasons; see §6.
- **Recommended plan, phased and each independently shippable + reversible:**
  - **Phase A (ship now, zero risk):** the **Action button** as a deterministic,
    AEC-independent interrupt — it's a `binary_sensor` whose press surfaces over
    the API *and* stops playback on-device instantly.
  - **Phase B (the real fix, software-only on the coordinator):** make playback
    **one continuous, gapless STREAM** (NOT a buffered clip — **same
    time-to-first-word as today**) so the AEC stays converged, then re-enable the
    *existing* open-mic barge gate (it was only ever defeated by the ≈ 11 k
    residual). **(Source-confirmed viable 2026-06-08 — the device's `AudioReader`
    streams a chunked/growing body and waits on slow reads, never EOF-ing a
    transient empty read; §9 Q3.)** **Phase B+** (reference-aware detection) then
    hardens against residual that leaks on loud syllables — and needs no playback
    change at all.
  - **Phase C (firmware-YAML hardening, no XMOS reflash):** forward mic
    `channels: 1` for a real double-talk detector; surface the on-device `stop`
    word to the coordinator.
  - **Phase D (XMOS reflash, fallback only):** the `adec` (auto-delay) pipeline
    variant, which fixes convergence *at the firmware* and tolerates gappy
    playback.

---

## 1. What works, what fails

**Works (live-proven, 2026-06-07):** wake ("Hey Kate") → `handle_start` →
LISTENING → parakeet STT → Kate turn → reply streamed out the speaker via
`media_player` → firmware LED ring. The whole turn loop is solid.

**Fails:** interrupting Kate mid-reply. Three mechanisms were built and pinned
off (`enable_barge_in=false`, commit `4d67fa0`):

| mechanism | how it was built | why it failed |
|---|---|---|
| Open-mic VAD during SPEAKING | re-open the mic mid-reply (`open_listen_run` fires a `start_conversation` run; `_SILENT_OPENER`), gate on Silero prob + an RMS floor (`barge_in_rms_floor=500`) | Kate's AEC residual during multi-clip playback is ≈ 11 k RMS / prob ≈ 0.99 — indistinguishable from a human → **self-barge** |
| Wake-word-during-SPEAKING | `_on_wake`: a device wake while SPEAKING → barge | inert — no wake event surfaces during playback |
| "stop" word during TTS | (design §7 floor) | nothing catchable surfaces to the coordinator |

The parent doc's §2 ran an AEC probe and returned **"FULL-DUPLEX GO"** (human
interrupt transcribed at WER 0 % over a playing clip, at 1/2/3 m). That verdict
was **not wrong — it was incomplete**: it tested a **single 13 s clip**. The
production coordinator streams **one clip per sentence**. The gap between those
two conditions is the entire bug (§2).

---

## 2. Root cause: AEC convergence under multi-clip playback

### 2.1 The mechanism (high confidence — firmware source + the probe agree)

The Satellite1's echo cancellation is **hardware**, in the XMOS XU316, on the I2S
bus between the ESP32 and the mics/DAC. The far-end (echo) reference is an **I2S
loopback of the ESP32's speaker output, captured inside the XMOS**:

- Every sound the ESP32 plays — TTS announcements, media, the wake chime — is
  mixed by `mixing_speaker` and sent out the single `i2s_audio_speaker` (GPIO9) →
  XMOS (`config/common/speaker.yaml`).
- The XMOS plays that to the DAC **and** queues the identical buffer as the AEC
  reference (`Satellite1-XMOS/.../src/main.c` `speaker_pipeline_output()` ~L90–143,
  "send to microphone pipeline as reference"; `audio_pipeline_input()` ~L171–185;
  `appconfAEC_REF_DEFAULT = appconfAEC_REF_I2S`).
- The AEC runs 2 mic × 2 ref, **10 main + 5 shadow filter phases**
  (`audio_pipeline_t1.c stage_aec()`).

**There is no output path that bypasses the reference** — so `media_player` and
`voice_assistant` TTS are AEC-referenced *identically*. (This refutes the
`config.py` note "the XMOS AEC cancels the voice_assistant TTS path but NOT
media_player announcements." The variable was never the output component.)

The decisive detail: the live firmware is the **`fixed_delay`** XMOS variant
(`appconfINPUT_SAMPLES_MIC_DELAY_MS = 0`; `satellite1.cmake`). It assumes a
**constant, known** mic↔reference latency and does **not** continuously
re-estimate it — that's what the *separate* `adec`/`adec_alt_arch` variants do
("Automatic Delay Estimation and Correction"). An adaptive (LMS) echo canceller
needs the reference and the echo it produces to stay **time-aligned** to hold
convergence. Multi-clip streamed TTS — re-issuing `media_player_command(…,
announcement=True)` per sentence — introduces buffer underruns / pipeline restarts
that **shift the effective reference↔mic delay at each clip boundary**, forcing the
filter to re-converge each time. During each re-convergence window the residual
is near the raw echo; the ASR-tuned AGC on the clean channel then *boosts* that
residual past Silero's VAD threshold. Hence ≈ 20 (one continuous clip, converged
once) vs ≈ 11 000 (many clips, perpetually re-converging).

Corroboration: FPH's own FAQ lists **"TTS stuttering"** as a known issue, and the
ESPHome speaker/mixer chain has documented buffer-underrun problems — both point
at gappy playback as a real failure mode on this exact hardware. The XMOS v1.0.3
release notes contain no AEC/convergence fix, so there's no upstream patch to lean
on.

### 2.2 How the coordinator gets "mic open during playback" at all

This reconciles the probe ("378 mic frames *during* the 12.1 s playback") with the
protocol fact that the native `voice_assistant` flow is **half-duplex** (it stops
the mic on `STT_VAD_END → STOP_MICROPHONE`, *before* the TTS response plays — there
is no flag to keep it open; `voice_assistant.cpp` state machine, mic only streams
in `STREAMING_MICROPHONE`).

The coordinator does **not** use the native TTS flow. It uses a **trick**: open a
`start_conversation` listening run (device enters `STREAMING_MICROPHONE`, mic
streaming to `handle_audio`) and play the reply **out-of-band via `media_player`**
on top. The mic is open because the device thinks it's *listening for a command*,
while the audio rides a parallel mixer input. This is sound and is the *only* way
to get full-duplex capture on this device — both the probe and `open_listen_run`
do exactly this. So the architecture is correct; **only convergence is broken.**

> Tuning note for Phase B: that listening run must not self-endpoint on Kate's own
> residual. With `USE_VAD` on, the device's VAD can fire `STT_VAD_END` on the echo
> and close the mic mid-reply. Open the barge-listen run with the device VAD off
> (the coordinator runs its own Silero) — verify in the Phase-B probe (§7).

---

## 3. Evidence base (cited)

**Firmware (Satellite1-XMOS / Satellite1-ESPHome / esphome):**
- AEC references all DAC output via I2S loopback — `Satellite1-XMOS/src/main.c:139,171–185`;
  `audio_pipeline_t1.c stage_aec`; `appconfAEC_REF_DEFAULT=appconfAEC_REF_I2S`.
- Single output path — `config/common/speaker.yaml` (`mixing_speaker → i2s_audio_speaker` GPIO9).
- `fixed_delay` variant, no auto-delay re-estimation; `adec` variants do — `satellite1.cmake`, XMOS `audio_pipelines/reference/`, XMOS README.
- The XMOS computes a **6-channel** frame (ch0 = AEC+IC+NS+AGC clean; ch3 = AEC+IC+NS; ch4/5 = RAW mic) but the stock `fixed_delay` build sends **only ch0 + ch3** to the ESP over I2S; raw mic + a true reference channel are NOT sent (TDM + USB paths compiled out) — `main.c:216–243`, `app_conf.h:109–134`.
- `micro_wake_word` has **no playback gate** — `esphome/components/micro_wake_word/micro_wake_word.cpp:254–351`. The main wake words are armed during playback; they fail only because the echo residual dominates the mic.
- The on-device **`stop`** model: `internal:true` (API-invisible), armed during long TTS by `activate_stop_word_once`, acts **locally** (`media_player.stop`) — `config/common/voice_assistant.yaml:36–51,43–45,52–94,217–234`.
- Announcement path is **ducked −20 dB, not muted** during TTS — `media_player.yaml on_announcement`, `voice_assistant.yaml on_start`.

**Protocol (aioesphomeapi v45.3.1 / esphome / HA core):**
- `send_voice_assistant_audio(data)` — `client.py:1992–1994`; `VoiceAssistantAudio` (msg 106), fields `data`/`end`/`data2`, **no format field** (`api.proto`). Fixed format **16 kHz / 16-bit / mono** (`voice_assistant.cpp:21`; HA `assist_satellite.py:693–722` validates + warns "media player preferred" for long audio).
- **Half-duplex is structural**: `voice_assistant.h:47–61` state machine; `STT_VAD_END → STOP_MICROPHONE` (`voice_assistant.cpp:969`); mic streams only in `STREAMING_MICROPHONE` (`374–398`); none during `STREAMING_RESPONSE`. No request/audio-settings/subscribe flag changes this.
- API-TTS PCM is **gated on the `SPEAKER` feature** — `on_audio()` is `#ifdef USE_SPEAKER` (`voice_assistant.cpp:978–992`); HA PCM-streams only to SPEAKER devices (`assist_satellite.py:397–405`). **Satellite1 binds `voice_assistant` to a `media_player`, not a `speaker`.**
- **Device feature flags = 61** = `VOICE_ASSISTANT(1)|API_AUDIO(4)|TIMERS(8)|ANNOUNCE(16)|START_CONVERSATION(32)` — **no `SPEAKER`(2), no `MULTI_CHANNEL_AUDIO`(64)** (live, from the probe/coordinator logs).
- `handle_start` return contract — `client.py:1854–1857,1891–1898`: `0` → audio over the API; positive int → UDP port; `None` → error. (Matches `device.py`.)
- **No API message cancels TTS** — the only "cancel" token is `VOICE_ASSISTANT_TIMER_CANCELLED`. Barge-in is device-local `request_stop()` (`voice_assistant.cpp:690–734`). *(The coordinator owns the `media_player` playback, so it stops Kate with a direct `media_player.stop` — it does not need an API TTS-cancel; §5.)*
- `dual mic channels: stream_api_audio_()` already sends `data`+`data2` in one message (`voice_assistant.cpp:38–53,212–257`); FPH wires only `channels:0` (`voice_assistant.yaml:98–100`); HA Voice PE wires both.

**Device entities (Satellite1-ESPHome `config/common/`):**
- **Action button is `binary_sensor: platform: gpio`** (`buttons.yaml:96–106`, `id: btn_action`, "Button Right (Action)") — a physical press **surfaces as a state change over the native API**. There is *also* a template `event:` entity "Action Button Press" (`buttons.yaml:19–31`, single/double/triple/long). All four buttons (Up/Down/Left/Right) are state-surfacing binary_sensors.
- The on-device single-click **already barges**: `voice_assistant.stop` / `media_player.stop(announcement)` / `media_player.pause` (`buttons.yaml:138–157`).
- Media player is `platform: speaker_source` (`media_player.yaml:54–75`) with an `http_request` media source — plays a **finite HTTP audio URL** (FLAC/MP3/OPUS/WAV), decoded on-device. i2s 48 kHz/32-bit/stereo duplex (`speaker.yaml:30–41`).
- **Buffers are YAML-tunable**: `i2s_audio_speaker buffer_duration` is *commented out* (default; `speaker.yaml:41`), `media_mixing_input buffer_duration: 100ms` (`speaker.yaml:53`), `http_media_source buffer_size: 500000` (`media_player.yaml:52`).

**Flashing safety:** ESP32 = standard ESPHome OTA + `safe_mode` auto-revert
(`satellite1.base.yaml:73–116`). XMOS = flashed by the ESP32 over SPI via
`memory_flasher`, ESP holds a known-good embedded factory image + MD5
(`satellite1.base.yaml:143–149`); USB-DFU as backup. ESP-side auto-revert; XMOS
recoverable. XMOS rebuilds need XTC-Tools 15.3.1. No on-XMOS dual-image
auto-revert (recovery = "ESP reflashes the XMOS").

---

## 4. Ranked solution paths

Ranked by **viability × low-effort × low-risk**. Phases A and B are the plan;
C and D are hardening / fallback.

| # | path | layer | effort | risk | what it buys |
|---|---|---|---|---|---|
| **A** | **Action button interrupt** | coordinator (sw) | XS | none | deterministic, instant, AEC-independent barge — ship now |
| **B** | **Continuous gapless STREAM playback → re-enable existing barge gate** (same TTFT as today — NOT buffer-then-speak) | coordinator (sw) | S–M | low (config flag, reversible) | fixes the root cause; restores ≈ 20 residual; voice barge-in works |
| **B+** | reference-aware double-talk detector — hardens B against loud-syllable residual (also a standalone no-playback-change option) | coordinator (sw) | M | low | uses the coordinator's own reference; robust even to de-converged residual |
| **C1** | forward mic `channels: 1` to the API | ESP firmware YAML (OTA) | S | low (safe-mode revert) | a 2nd processed mic view → real double-talk detection |
| **C2** | surface the on-device `stop` word to the coordinator | ESP firmware YAML (OTA) | S–M | low | reliable "say stop" barge (the §7 floor), API-visible |
| **D1** | switch XMOS pipeline to an `adec` (auto-delay) variant | XMOS reflash | L | med (recoverable) | fixes convergence *at the firmware* — tolerates gappy playback |
| **D2** | enable TDM → raw mic + true reference to the coordinator | XMOS reflash + ESP mic YAML | XL | med | full external residual-AEC (raw near-end + far-end) |
| ~~b~~ | ~~`send_voice_assistant_audio` PCM TTS~~ | — | — | — | **DEAD** (§6) |

---

## 5. Recommended plan (concrete steps)

### Phase A — Action button interrupt (ship now)

A deterministic, AEC-independent barge that works *today*, regardless of the
acoustic fix. The on-device single-click already stops/pauses playback locally
(≈ 0 ms, device-side) — the coordinator just has to catch the press and finish the
barge (cancel the Hearth turn + reopen the mic).

Steps (coordinator-only, `feat/voice-coordinator`):
1. In `device.py`, the state subscription already routes entity states. Add a
   handler for the `btn_action` binary_sensor **on→true** transition (and/or
   subscribe to the `action_button_press_event` event entity for single/double/
   long semantics).
2. Route a button press to the *same* state-machine path as a barge:
   `Event(WAKE)` while SPEAKING → `_begin_barge_in()` (STOP_PLAYBACK + CANCEL_TURN
   + START_LISTENING). The local on-device stop already killed the audio; the
   coordinator's `stop_playback` is then idempotent.
3. Gate behind a new flag (e.g. `HEARTH_VC_BARGE_BUTTON=true`) independent of
   `enable_barge_in`, so the button works even while the acoustic path is off.
4. Decide UX: which click count = "interrupt and listen" vs "stop and stand down."
   A single press already pauses; map double-press → interrupt+listen if a single
   press feels overloaded.

> Confirm before building: the press surfaces over the live API session (it should
> — it's a `binary_sensor`). Fold this into the Phase-B probe (§7) or read it off
> the next coordinator state-log.

### Phase B — Continuous playback → re-enable the existing barge (the real fix)

This attacks the root cause directly and is **coordinator-only, no firmware,
reversible via a config flag.**

1. **Make playback ONE continuous gapless STREAM** (not a buffered clip — that's
   the slow trap). The de-convergence is caused by per-sentence clip **restarts**
   shifting the reference↔mic delay, **NOT by streaming per se**. So serve the
   reply as a SINGLE chunked HTTP audio resource the device fetches **once**: the
   coordinator pipes forza's streaming mp3 straight through (or concatenates
   per-sentence mp3 frames — CBR mp3 frames butt together gaplessly) into one
   growing response body. The device starts playing at the **first bytes**
   (**time-to-first-word == today's multi-clip**, ≈ forza's first chunk ~1–1.5 s —
   no whole-reply buffering) and plays ONE continuous stream to the end → one
   playback session, one fixed delay → the `fixed_delay` AEC converges once and
   **holds** (the probe's clean ≈ 20 condition, now without buffering). A brief
   synth-lag underrun is benign *as long as it doesn't restart the pipeline* —
   it's a gap of far-end silence, not a delay shift; size the buffers (Phase C /
   `media_player.yaml`) + synth-ahead so it doesn't.
   Config flag `HEARTH_VC_TTS_PLAYBACK_MODE`: **`stream_gapless`** (new primary) |
   `stream` (current multi-clip — rollback / A-B) | `single` (buffer-then-speak —
   **slow fallback only**, for very-short replies if neither gapless-stream nor B+
   is available).
   **✓ CONFIRMED viable at the source (2026-06-08, §9 Q3):** the pinned
   `kahrendt/esphome@7a6cf5c` `AudioReader` streams the HTTP body progressively
   into a ring buffer (`audio_reader.cpp:196–197`), fetches but **never checks**
   Content-Length (L120) — relying only on `esp_http_client_is_complete_data_received()`
   (L188), so chunked / unknown-length works — and on a 0-byte read with the
   connection still open it **`delay`s 20 ms and stays in `READING`** (L199–211),
   so a real-time growing stream is handled, not EOF-ed. It ends only when the
   server closes the stream (final chunk); the sole failure mode is a >~30 s
   total no-data stall (L206), irrelevant for a continuously-synthesized reply.
   Implementation: aiohttp serves a chunked `StreamResponse`; pipe forza's
   streaming mp3 (mp3 input proven by the probe) through to it.
2. **Re-enable the open-mic barge** (`HEARTH_VC_ENABLE_BARGE_IN=true`) *only* in a
   continuous mode. The existing gate — Silero prob ≥ 0.7, RMS ≥ 500, sustained
   ≥ 320 ms (`state_machine._speaking_frame`, `coordinator._on_mic_audio`) — should
   now cleanly separate Kate's ≈ 20 residual from a loud human, and the 320 ms
   sustain rejects transient loud-syllable residual.
3. **Open the barge-listen run with the device VAD off** so the device doesn't
   `STT_VAD_END` on Kate's residual and close the mic mid-reply (§2.2 note).
4. **Measure barge STOP latency** against the design §3 <100 ms / sub-250 ms bar
   (`media_player.stop`, which the coordinator already issues). The button (Phase
   A) is the latency floor if `media_player.stop` is slow on an announcement.

If, after this, loud syllables still occasionally false-trigger:

### Phase B+ — reference-aware double-talk detection (software; hardening for B)

**With B now source-confirmed (§9 Q3), B+'s primary role is hardening: run it on
top of B if the converged-AEC residual still leaks on loud syllables (the task's
"single clip still leaked on loud syllables" note). It also stands alone as a
latency-preserving option — it keeps fast multi-clip playback and changes only the
*detector* — but that's no longer needed as a fallback.**

Replace the magic RMS floor with a principled test. The coordinator **knows the
exact TTS it's playing** (it synthesized + serves it). Estimate the playback↔mic
delay once (cross-correlate the served clip against the captured mic in a
human-silent window), then accept a barge only when mic energy **exceeds the
delay-aligned predicted echo** (independent near-end energy) — not merely "above
500." This is the "no magic constant" version and generalizes across volume.
Pure software on ch0; strengthened by Phase C1's second channel. Because it keys
on the coordinator's OWN reference (not the device's AEC), it discriminates a
human **even in the de-converged windows where the residual is loud** — so unlike
the bare RMS floor it does not depend on fixing convergence at all. (Hard case:
true double-talk over a loud, de-converged echo needs spectral/coherence analysis,
not just energy — which is why B/B+ compose well: gapless playback lowers the echo
*and* the detector gets smarter.)

### Phase C — firmware-YAML hardening (ESP OTA, safe-mode revert, NO XMOS reflash)

- **C1 — forward `channels: 1`.** One-line FPH YAML edit (`voice_assistant: microphone: [channels:0, channels:1]`). The device then sends `data2` (ch3 = AEC+IC+NS, a differently-processed view); `device.py._handle_audio(data, data2)` *already accepts it* (currently dropped). Feed both channels to the double-talk gate. Low brick risk (ESP safe-mode).
- **C2 — surface the `stop` word.** YAML edits to `activate_stop_word_once`: drop the 1 s arm delay, and surface detection to the coordinator (a template `binary_sensor`/`event` in `on_wake_word_detected`) so "say stop" is an explicit, catchable barge — the design §7 half-duplex floor, now API-visible. (Still benefits from Phase B convergence, since the `stop` model also listens on the AEC'd channel.)

### Phase D — XMOS reflash (fallback only, if B/C can't hold the bar)

- **D1 — `adec` (automatic-delay) pipeline variant.** Fixes convergence *at the
  firmware*: the AEC re-estimates delay continuously, tolerating the
  reference-timing drift that gappy playback causes — i.e. it would make even
  multi-clip streaming stay converged. The cleanest *firmware* fix; reserve for
  when the software path proves insufficient. XTC-Tools build, ESP-SPI reflash,
  USB-DFU backup. Flash a **dev-kit / 2nd device first**, never the daily driver.
- **D2 — TDM raw-stereo (`appconfI2S_TDM_ENABLED=1`).** Streams all 6 channels
  (raw mic ch4/5 + true reference) to the ESP so the coordinator runs a *full*
  external residual-AEC (raw near-end + far-end cross-cancellation). The most
  general "real mechanism," but highest effort (needs matching ESPHome
  `sat1_microphone` 6-channel changes). Only if D1 is somehow inadequate.

---

## 6. Dead path: `send_voice_assistant_audio` PCM TTS (the original plan b)

Recorded explicitly because `config.py` and the parent doc point at it. It fails
for **three independent reasons** — any one is fatal:

1. **No `SPEAKER` feature.** The device advertises flags = 61 (no bit-2). API-TTS
   PCM playback is `#ifdef USE_SPEAKER` on the device and HA/clients only PCM-stream
   to SPEAKER devices. The Satellite1 binds `voice_assistant` to a `media_player`,
   not a `speaker` — so `on_audio()` is dead code on this hardware.
2. **It wouldn't keep the mic open.** The native voice_assistant flow is
   structurally half-duplex (mic stops on `STT_VAD_END`, before any TTS). The PCM
   path changes *delivery*, not the mic state machine.
3. **No reference benefit.** `media_player` is *already* AEC-referenced (same I2S
   loopback). There was never an un-referenced path to escape.

Re-binding `voice_assistant` to a `speaker` would be a firmware change that *loses*
the `media_player` mixer/ducking pipeline the device relies on and **still**
delivers neither full-duplex nor a reference gain. Do not pursue.

(Likewise, "wake/stop word is firmware-gated off during playback" is **not** a real
gate — `micro_wake_word` runs throughout; it's defeated by the same ≈ 11 k residual.
Phase B is its fix too.)

---

## 7. Read-only confirmation probes (designed; NOT run here)

Two cheap reads would de-risk the plan. **Both require the device's single API
session, which the live `hearth-voice-coordinator` container now holds** — so the
old `scripts/aec-fullduplex-probe.py` HA-disable bracket is **wrong for the current
topology** (HA no longer holds the session). The safe pattern is now
**stop-container → probe → start-container**, watchdog-backed. Do not run unless a
brief (~30 s) self-restoring voice outage is acceptable and explicitly authorized;
for an investigate-only pass, these are specs.

**Probe 1 — Phase-B convergence confirmation (the load-bearing read).**
Goal: confirm that *single-clip* playback through the real coordinator path
restores ≈ 20 residual and a human barge is cleanly separable, and that the
barge-listen run doesn't self-endpoint on echo.
- Safety bracket (adapted): arm an independent watchdog that runs
  `docker start hearth-voice-coordinator` at a hard deadline; `docker stop
  hearth-voice-coordinator` to free the session; run; in `finally` disconnect the
  probe session, `docker start` the container, and **verify restore via
  `curl :8094/health` → `device_connected:true`** (never via your own
  aioesphomeapi login — if *yours* succeeds, the coordinator hasn't reclaimed it).
- Procedure: open a `start_conversation` run with device VAD **off**; play ONE
  continuous Kate clip via `media_player`; capture the AEC'd mic during; report
  per-frame residual RMS (expect ≈ 20, not ≈ 11 k) and, with a human interrupt,
  the substring WER + whether the existing gate (prob 0.7 / RMS 500 / 320 ms)
  fires exactly once. Reuse `aec-fullduplex-probe.py`'s analysis; swap the HA
  bracket for the container bracket above.

**Probe 2 — Phase-A/C facts (fold into the same session).**
- Subscribe to states; physically press the Action button; confirm the
  `btn_action` binary_sensor on-transition (and the `action_button_press_event`)
  arrive over the API.
- Re-read `device_info().voice_assistant_feature_flags` (expect 61 — no SPEAKER).
- If trialing C1: confirm `data2` is non-empty after a YAML `channels:1` change
  (on a dev-kit, not the daily driver).

---

## 8. Risks + reversibility

| change | reversibility |
|---|---|
| Phase A (button) | config flag; coordinator-only |
| Phase B (single-clip + re-enable barge) | `HEARTH_VC_TTS_PLAYBACK_MODE=stream` / `enable_barge_in=false` — instant rollback |
| Phase C (ESP YAML: channels:1, stop-word) | ESPHome OTA + `safe_mode` auto-revert; reflash prior image |
| Phase D (XMOS variant) | ESP reflashes the XMOS from its embedded factory image; USB-DFU backup; **dev-kit first, daily driver only after a clean week** |

The whole-system fallback is unchanged from the parent design: if the coordinator
misbehaves, re-point the device to Home Assistant's integration (config, ~10 s) —
the device is never bricked by Phases A–C.

---

## 9. Open questions

1. **Does Phase B alone clear the bar?** Strong hypothesis (the probe's converged
   ≈ 20 + the 320 ms sustain should reject loud-syllable transients), but the
   "single clip still leaked on loud syllables" note means B+ (reference-aware
   detection) or C1 (second channel) may be needed. Probe 1 settles it.
2. **`single` (buffer-then-speak) is the slow fallback, NOT the plan.** It costs
   whole-reply synth before first audio (the correct "B is slow" objection) — use
   it only for very-short replies if both B's gapless-stream and B+ are
   unavailable. The plan's B is the gapless STREAM (same TTFT as today), not this.
3. **✓ RESOLVED (2026-06-08) — the media_player DOES stream a chunked/growing
   body.** Source-read of the pinned `kahrendt/esphome@7a6cf5c`
   `esphome/components/audio/audio_reader.cpp`: it reads the HTTP body
   progressively into a ring buffer (L196–197); fetches but **never checks**
   Content-Length (L120), relying solely on
   `esp_http_client_is_complete_data_received()` (L188) — so chunked / unknown-
   length works; and on a 0-byte read with the connection open it **`delay`s 20 ms
   and stays in `READING`** (L199–211) — a real-time growing stream is handled, not
   EOF-ed. Fails only after ~30 s of *no* data (L206). ⇒ **Phase B's gapless
   stream is viable** (mp3 input already proven by the probe; aiohttp serves a
   chunked `StreamResponse` trivially). The remaining unknown is purely whether an
   underrun mid-stream ever forces a pipeline *restart* (delay shift) vs a benign
   silent gap — verify in Probe 1 by watching for a single continuous PLAYING
   state across the whole reply.
4. **Barge STOP latency** of `media_player.stop` on an announcement vs the <100 ms
   bar — measure in Probe 1. The button (Phase A, device-local stop) is the floor.
