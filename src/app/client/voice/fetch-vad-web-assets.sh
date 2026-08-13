#!/usr/bin/env bash
# Fetch the browser VAD runtime for the web voice orb's full-duplex barge-in:
# Silero v5 (ONNX) + @ricky0123/vad-web (mic worklet + frame pump) +
# onnxruntime-web (wasm inference). ~16 MB total, NOT vendored in git (binary)
# — same pattern as integrations/voice-coordinator/fetch-vad-model.sh.
# Idempotent; run once on the deploy host after pulling:
#   bash src/app/client/voice/fetch-vad-web-assets.sh
#
# Missing assets are a DEGRADED mode, not a breakage: voice.html detects the
# absence at runtime and falls back to the legacy energy-gate, turn-based loop
# (no barge-in) — exactly the pre-barge behavior.
#
# Versions are EXACT-pinned and move together: vad-web's frame pump feeds its
# bundled model architecture (silero_vad_v5.onnx ships inside the vad-web
# package, so bundle + worklet + model always agree), and vad-web declares
# onnxruntime-web ^1.17 (1.27.0 pinned here).
set -euo pipefail

VAD_WEB_VERSION="0.0.30"
ORT_VERSION="1.27.0"

DIR="$(cd "$(dirname "$0")" && pwd)/vendor"
mkdir -p "$DIR"

fetch() {
  local url="$1" out="$DIR/$2"
  if [ -s "$out" ]; then
    echo "already present: $out"
    return 0
  fi
  echo "fetching $2"
  curl -fsSL "$url" -o "$out.tmp"
  mv "$out.tmp" "$out"
}

VAD_BASE="https://cdn.jsdelivr.net/npm/@ricky0123/vad-web@${VAD_WEB_VERSION}/dist"
ORT_BASE="https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VERSION}/dist"

fetch "$VAD_BASE/bundle.min.js" "vad-web.bundle.min.js"
fetch "$VAD_BASE/vad.worklet.bundle.min.js" "vad.worklet.bundle.min.js"
fetch "$VAD_BASE/silero_vad_v5.onnx" "silero_vad_v5.onnx"
fetch "$ORT_BASE/ort.min.js" "ort.min.js"
fetch "$ORT_BASE/ort-wasm-simd-threaded.wasm" "ort-wasm-simd-threaded.wasm"
fetch "$ORT_BASE/ort-wasm-simd-threaded.mjs" "ort-wasm-simd-threaded.mjs"

echo "done → $DIR"
ls -la "$DIR"
