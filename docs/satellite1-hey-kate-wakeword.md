# Satellite1 "Hey Kate" custom wake word — build handoff

**Status:** BUILT 2026-06-06 — model trained, firmware compiled, web flasher
LIVE. Only the physical USB flash + HA wake-word re-select remain (Jasper's part).
See "As built" below; the rest of this doc is the original plan/reference.

---

## As built (2026-06-06)

- **Model:** TTS-only v1, trained on **the workstation** (RTX PRO 4000 Blackwell) with
  TaterTotterson's Nvidia-Docker trainer. 50k samples / 40k steps, ~23 min on GPU.
  Calibrated **cutoff 0.48 @ sliding_window 3 → recall 99.17%, ~0.83 false-accepts/hr**
  ambient. Artifacts: `hey_kate.tflite` (63 KB) + `hey_kate.json`
  (`tensor_arena_size: 30000` present, `wake_word: "Hey Kate"`, v2,
  min esphome 2024.7.0).
- **Two gotchas hit & fixed:** (1) the augmenter HARD-requires all 5 background
  datasets (MIT RIRs/AudioSet-bal/FMA/WHAM/CHiME) — not optional; ran
  `setup_training_datasets`. (2) the tf-nightly venv ships WITHOUT `tensorboard`,
  so `tf.summary.scalar` crashes at step 0 — `pip install tensorboard` in
  `/data/.venv` fixes it. Both are one-time per venv.
- **Firmware:** forked `FutureProofHomes/Satellite1-ESPHome` @ `develop`, embedded
  the model at `config/common/models/hey_kate.json` (referenced as
  `common/models/hey_kate.json` — resolves relative to the CONFIG DIR via
  `cv.file_`, not the package file), added `hey_kate` as the first/default model,
  and wired calibrated cutoffs into the "Wake word sensitivity" select
  (slight/moderate/very = uint8 **133/122/107**). **Build esphome version MUST be
  `2026.4.5`** (pinned in repo `requirements.txt`; 2026.5.1 fails with a
  `const`/`CONF_B_CONSTANT` external-component skew). Compiled on the workstation via
  `ghcr.io/esphome/esphome:2026.4.5` → `firmware.factory.bin` 3.4 MB, flash 41%.
- **Fork pushed to both remotes** (branch `hey-kate-wakeword`):
  GitHub `alliphant/Satellite1-ESPHome`, Gitea `jasper/Satellite1-ESPHome`
  (your-llm-host.local:3010).
- **Web flasher LIVE** (ESP Web Tools / Web Serial) at
  **`https://your-llm-host.local/webflasher`** (also the trusted-cert tailnet URL
  `https://your-llm-host.your-tailnet.ts.net/webflasher`; plain http→https redirects so
  Web Serial gets a secure context). Files in the LLM host webroot
  `/docker/homeassistant_config/www/webflasher/` + nginx `location /webflasher/`
  in `/docker/nginx/locations.conf`. The `satellite1-hey-kate.factory.bin` is
  served there (verified 200, 3,399,360 bytes).
- **Sample audio browser** (the 50k Piper positives): `http://192.168.0.11:8011/`
  (the workstation `wav-server` container; `docker rm -f wav-server` to stop).

### Remaining (Jasper — physical/credential)
1. Plug Satellite1 Core board into the Mac (USB-C data cable); open
   `https://your-llm-host.local/webflasher` in **Chrome/Edge**; Install. (Erases NVS →
   re-provision Wi-Fi via Improv, re-adopt in HA with a new API key.)
2. In HA set `select.satellite1_aabbcc_wake_word` → **"Hey Kate"** (reflash resets
   it) and re-verify the "Kate (Hearth Voice)" pipeline assignment.
3. Say "Hey Kate" to verify. If it false-accepts (short name), do a v2 retrain
   with real recorded voice samples (drop WAVs in the trainer's personal-samples).

### Rebuild/retrain quickref
- Retrain: `ssh the workstation` → `~/mww-hey-kate/` has the venv + datasets cached.
  `docker run --rm --gpus all -v ~/mww-hey-kate:/data ... bash -lc 'source /data/.venv/bin/activate && cd /root/mww-scripts && ./train_wake_word --language=en "hey kate" "Hey Kate"'`
- Recompile: fork is at `~/Satellite1-ESPHome` on the workstation (and on the Mac).
  `docker run --rm -v ~/Satellite1-ESPHome:/workspace -w /workspace ghcr.io/esphome/esphome:2026.4.5 compile config/satellite1.yaml`
  then copy `config/.esphome/build/satellite1/.pioenvs/satellite1/firmware.factory.bin`
  → the LLM host `…/webflasher/firmware/satellite1-hey-kate.factory.bin`.

---

### Original plan / reference (below)

**Goal:** replace the Satellite1's wake word with **"Hey Kate"** so saying her
name summons the Kate voice pipeline. The wake word is an on-device TFLite model
baked into the ESP32-S3 firmware at compile time — there is no runtime/HA toggle
that can add a new one. FutureProofHomes confirms: to change it you *"modify and
compile your own firmware."*

**Chosen approach (decided by Jasper):** *Approach 1 — fork the official
FutureProofHomes firmware and embed the model as a local file.* Canonical,
version-controlled, self-contained. (Alternatives considered: a no-fork ESPHome
package-merge overlay, and TaterTotterson's `satellite1-TaterTimer.yaml`
drop-in — see "Alternatives" at the end.)

---

## What changes vs. what doesn't

- **Changes:** the Satellite1 firmware (one new embedded model) + the HA
  wake-word select entity.
- **Untouched:** the entire the LLM host voice stack — speaches STT, Qwen3 Laur TTS on
  forza, the `/v1/chat/completions`→Kate shim, the "Kate (Hearth Voice)" HA
  pipeline. The wake word only gates *when* audio starts streaming to that
  pipeline. See [[satellite1-voice-stack]] memory + PLAN.md Tier 1.

## How wake word actually works on the device

XMOS XU316 does the audio DSP (AEC / noise-suppression / AGC) → feeds clean audio
to the **ESP32-S3**, which runs the `micro_wake_word` ESPHome component against an
embedded `.tflite`. ESPHome downloads/embeds the model **at compile time**; HA's
wake-word dropdown only toggles between models already compiled in. Therefore a
new wake word = recompile + reflash.

---

## Phase A — Train `hey_kate` on the workstation

the workstation is the host because the trainer image (`ghcr.io/tatertotterson/microwakeword:latest`)
is a CUDA/`--gpus all` image built for **x86_64**. the workstation is x86_64 Linux,
ssh alias `the workstation`, LAN `192.168.0.11`. (The DGX Spark / forza is ARM64 +
Blackwell — the prebuilt image is almost certainly amd64-only, so do NOT train
there. Apple-Silicon trainer on the Mac is a fallback if the workstation's GPU stack
isn't ready.)

### A1 — Pre-flight (before pulling a multi-GB image)
```bash
ssh the workstation 'nvidia-smi'                                   # GPU + driver present
ssh the workstation 'docker info | grep -i -A2 runtimes'           # nvidia container runtime registered
ssh the workstation 'docker run --rm --gpus all nvidia/cuda:12.4.0-base-ubuntu22.04 nvidia-smi'   # toolkit end-to-end
ssh the workstation 'df -h ~'                                       # Piper voices + negative datasets need several GB
```
If the third command prints the GPU table you're good. If not, install
`nvidia-container-toolkit` on the workstation first.

### A2 — Run the trainer
```bash
ssh the workstation
mkdir -p ~/mww-hey-kate && cd ~/mww-hey-kate
docker pull ghcr.io/tatertotterson/microwakeword:latest
docker run -d --gpus all --network host -e REC_PORT=8789 \
  -v "$PWD":/data ghcr.io/tatertotterson/microwakeword:latest
```
Reach the web UI from the Mac via tunnel (don't expose it on the LAN):
```bash
ssh -L 8789:localhost:8789 the workstation     # then open http://localhost:8789
```

### A3 — In the Trainer tab
1. Wake phrase `hey kate`, language English.
2. **"Test TTS" first** — Piper generates the positive samples; if it
   mispronounces "Kate" every sample is wrong. Phonetic fallback: `hey kayt`.
3. **Record personal samples (biggest quality lever for a short name).** "Kate"
   collides acoustically with late/gate/wait/cake. Upload 20–50 clips of the
   household saying "Hey Kate" at varied distance/tone/room (WAV/MP3/M4A/FLAC…,
   auto-normalized to 16 kHz mono 16-bit).
4. Leave bundled negative datasets + background noise on. Start training.

### A4 — Collect output + verify the manifest
Output: `~/mww-hey-kate/trained_wake_words/hey_kate.tflite` + `hey_kate.json`
(also under `~/mww-hey-kate/output/<timestamp>-hey_kate-.../`). Pull to Mac:
```bash
scp 'the workstation:~/mww-hey-kate/trained_wake_words/hey_kate.*' /tmp/hey_kate/
```
Verify the JSON — the #1 deploy failure is a missing `tensor_arena_size`:
```json
{
  "type": "micro",
  "wake_word": "Hey Kate",
  "model": "hey_kate.tflite",
  "trained_languages": ["en"],
  "version": 2,
  "micro": {
    "probability_cutoff": 0.97,
    "sliding_window_size": 5,
    "feature_step_size": 10,
    "tensor_arena_size": 22860,
    "minimum_esphome_version": "2024.7"
  }
}
```
- `wake_word` = the friendly phrase HA shows → **"Hey Kate"**.
- `tensor_arena_size` **must exist**.
- `minimum_esphome_version` must be ≤ the ESPHome used in Phase B.

---

## Phase B — Fork firmware, embed the model, compile, flash

### Reference: the live FPH wake-word block
From `config/common/voice_assistant.yaml` (pulled into `satellite1.yaml` via
`packages: va: !include common/voice_assistant.yaml`):
```yaml
micro_wake_word:
  microphone:
    microphone: sat1_mics
    channels: 1
    gain_factor: 6
  vad:                       # VAD already on — cuts non-speech false wakes
  models:
    - model: https://fph-firmware-assets.s3.us-east-1.amazonaws.com/wake-word/hey_jarvis.json
      id: hey_jarvis
    - model: https://fph-firmware-assets.s3.us-east-1.amazonaws.com/wake-word/okay_nabu.json
      id: okay_nabu
    - model: https://fph-firmware-assets.s3.us-east-1.amazonaws.com/wake-word/stop.json
      id: stop
      internal: true
```

### B1 — Fork + embed
1. Fork `FutureProofHomes/Satellite1-ESPHome` → push to Gitea on the LLM host
   (`http://your-llm-host.local:3010`) and/or GitHub; clone on the Mac.
2. Copy `hey_kate.tflite` + `hey_kate.json` into `config/models/`. In the JSON,
   `"model": "hey_kate.tflite"` (relative to the JSON).
3. Edit `config/common/voice_assistant.yaml` — add `hey_kate` **first** so it's
   the default-enabled model on first boot:
   ```yaml
   models:
     - model: ./models/hey_kate.json
       id: hey_kate
     - model: https://fph-firmware-assets.s3.us-east-1.amazonaws.com/wake-word/okay_nabu.json
       id: okay_nabu
     - model: https://fph-firmware-assets.s3.us-east-1.amazonaws.com/wake-word/stop.json
       id: stop
       internal: true
   ```
4. Use the **base config variant matching the hardware** (FPH dev-kit PCB vs the
   assembled Satellite1.1 Smart Speaker use different board variants in the repo).

### B2 — Compile + flash (standalone; HA has no ESPHome add-on)
HA runs as a plain container (no Supervisor) → no "ESPHome Device Builder"
add-on. Run ESPHome standalone on the Mac or the workstation:
```bash
# from repo root (config/ holds satellite1.yaml)
docker run --rm -v "$PWD/config":/config -it ghcr.io/esphome/esphome compile satellite1.yaml
docker run --rm --network host -v "$PWD/config":/config -it ghcr.io/esphome/esphome run satellite1.yaml   # OTA over LAN
```
- **Match the ESPHome version to the Sat1 firmware version** (compat matrix:
  Sat1 **v0.2.0 ⇒ ESPHome 2026.4.5**). Check out the firmware tag for the
  version on the device and use the ESPHome it pins.
- **API-key gotcha:** if the compiled `api: encryption: key:` differs from what
  the device currently uses, HA drops the device and you re-add it. Reuse the
  device's existing `secrets.yaml` (api key + OTA password + wifi) to avoid that.
  If flashed from FPH prebuilt and the secrets are unknown, expect a one-time
  re-add (pipeline assignment survives a re-add per the voice-stack memory).
- **USB-C fallback** if OTA from stock refuses: `pip install esphome` on the Mac,
  `esphome run satellite1.yaml --device /dev/cu.usbserial-XXXX`.

---

## Phase C — Re-point HA (device entity `assist_satellite.satellite1_aabbcc_assist_satellite`)

A reflash resets the wake word to `no_wake_word` (known gotcha), so always set it:
1. `select.select_option` on `select.satellite1_aabbcc_wake_word` → **"Hey Kate"**.
2. Re-verify `select.satellite1_aabbcc_assistant` (+ `_2`) → **"Kate (Hearth Voice)"**.
3. If the API key rotated, re-add the device in HA first, then do 1–2.

Nothing on the LLM host changes.

---

## Tuning & validation loop

- `esphome logs satellite1.yaml` prints per-candidate probabilities — say
  "Hey Kate" at varied volume/angle/distance and read the numbers.
- **False accepts:** raise `micro.probability_cutoff` in `hey_kate.json`
  (recompile), or nudge the **Wake Word Sensitivity** number entity FPH exposes
  in HA (no recompile). VAD already on.
- **Misses:** lower the cutoff, or (better) add more *personal* samples in A3 and
  retrain. Real recordings beat TTS-only for a short name by a wide margin.

## Risk table

| Risk | Mitigation |
|---|---|
| Trainer image won't run on forza (ARM64/Blackwell) | Train on the workstation (x86_64) |
| `nvidia-container-toolkit` missing on the workstation | A1 pre-flight verifies first |
| Piper mispronounces "Kate" | "Test TTS" first; phonetic `hey kayt` |
| Short two-syllable name → false accepts | personal samples + higher cutoff + VAD |
| `tensor_arena_size` missing → invalid model | verify JSON before compile (A4) |
| ESPHome version mismatch | match compat matrix (v0.2.0 ⇒ 2026.4.5) |
| API key rotates → HA loses device | reuse `secrets.yaml`, or one-time re-add |
| Reflash resets wake word | Phase C step 1 always re-sets it |

## Alternatives (not chosen)

- **No-fork overlay (ESPHome package merge):** keep FPH as a remote package, add
  `hey_kate` via a thin top-level YAML merging into `micro_wake_word.models`
  (lists merge by `id`). No fork to maintain, but requires hosting the model at a
  URL and FPH's local `!include`s make full-tree package resolution fiddly.
- **TaterTotterson `satellite1-TaterTimer.yaml` drop-in:** set
  `wake_word_name: hey_kate` + `wake_word_model_url: <url>`, compile. Fastest, but
  a third-party firmware fork (own core-board/dashboard/wifi packages, extra
  timer features) that can lag official FPH. Useful only for a quick
  proof-of-detection.

## Sources

- FutureProofHomes — modifying the firmware: https://docs.futureproofhomes.net/satellite1-modifying-the-firmware/
- FutureProofHomes — FAQs (wake words): https://docs.futureproofhomes.net/satellite1-faqs/
- Satellite1-ESPHome firmware: https://github.com/FutureProofHomes/Satellite1-ESPHome
- ESPHome micro_wake_word component: https://esphome.io/components/micro_wake_word/
- microWakeWord trainer (Nvidia Docker): https://github.com/TaterTotterson/microWakeWord-Trainer-Nvidia-Docker
- microWakeWord trainer (Apple Silicon fallback): https://github.com/TaterTotterson/microWakeWord-Trainer-AppleSilicon
- TaterTotterson microWakeWords collection: https://github.com/TaterTotterson/microWakeWords
