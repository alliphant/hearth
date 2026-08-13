#!/usr/bin/env bash
#
# Keep the voice stack hot so the first call of the day isn't the slow one.
#
# Deploy target: the LLM host host (where the parakeet/speaches container and the
# llamacpp-9b systemd unit run). NOT run on the dev Mac.
#
# What gets cold and why this exists:
#   - speaches models are NOT preloaded — they load on first request and can
#     be evicted when idle (see the private dev log "Models are NOT preloaded by env
#     vars"). A cold first STT/TTS adds 1–5s to the first call.
#   - The 9B (llamacpp-9b-glacier.service) is a persistent systemd unit and
#     stays resident, so it doesn't need pinging here.
#
# This script (a) ensures both models are loaded/resident and (b) runs one
# tiny TTS synth to exercise the hot inference path (loads the ONNX graph +
# CUDA context). Idempotent; safe to run on a timer.
#
# Endpoints/model ids are from the private dev log "Pipecat real-time voice loop".
# VERIFY against your installed speaches version on first deploy — the
# /v1/models/{id} POST semantics (load vs download) are version-dependent.

set -uo pipefail

SPEACHES_URL="${SPEACHES_URL:-http://localhost:8093}"
STT_MODEL="${STT_MODEL:-deepdml/faster-whisper-large-v3-turbo-ct2}"
TTS_MODEL="${TTS_MODEL:-speaches-ai/Kokoro-82M-v1.0-ONNX-fp16}"
TTS_VOICE="${TTS_VOICE:-af_heart}"
CURL_MAX_TIME="${CURL_MAX_TIME:-30}"

log() { echo "[voice-prewarm] $*"; }

# Ensure a model is loaded/resident (idempotent after first download).
ensure_model() {
  local id="$1"
  local code
  code=$(curl -fsS -o /dev/null -w '%{http_code}' --max-time "$CURL_MAX_TIME" \
    -X POST "${SPEACHES_URL}/v1/models/${id}" 2>/dev/null)
  if [[ "$code" =~ ^2|^4 ]]; then
    # 2xx = loaded; 409/4xx = already loaded — both fine for a keepalive.
    log "model ${id}: ok (${code})"
  else
    log "model ${id}: WARN (${code:-no response})"
    return 1
  fi
}

# Exercise the TTS hot path with a throwaway short synth.
warm_tts() {
  local code
  code=$(curl -fsS -o /dev/null -w '%{http_code}' --max-time "$CURL_MAX_TIME" \
    -X POST "${SPEACHES_URL}/v1/audio/speech" \
    -H 'Content-Type: application/json' \
    -d "{\"model\":\"${TTS_MODEL}\",\"voice\":\"${TTS_VOICE}\",\"input\":\"warm\"}" 2>/dev/null)
  if [[ "$code" =~ ^2 ]]; then
    log "tts synth: ok (${code})"
  else
    log "tts synth: WARN (${code:-no response})"
    return 1
  fi
}

rc=0
ensure_model "$STT_MODEL" || rc=1
ensure_model "$TTS_MODEL" || rc=1
warm_tts || rc=1
exit "$rc"
