#!/usr/bin/env bash
# Fetch the Silero v5 VAD onnx model (~2 MB) for the coordinator's endpointing +
# barge-in detection. Idempotent. The model is NOT vendored in git (binary);
# fetch it once here, or bake it into the Docker image (see Dockerfile), or point
# HEARTH_VC_VAD_MODEL at an existing copy.
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)/models"
OUT="$DIR/silero_vad.onnx"
URL="${SILERO_VAD_URL:-https://raw.githubusercontent.com/snakers4/silero-vad/master/src/silero_vad/data/silero_vad.onnx}"
mkdir -p "$DIR"
if [ -f "$OUT" ]; then
  echo "already present: $OUT ($(stat -c%s "$OUT" 2>/dev/null || stat -f%z "$OUT") bytes)"
  exit 0
fi
echo "fetching Silero v5 VAD → $OUT"
curl -fsSL "$URL" -o "$OUT"
echo "done: $OUT ($(stat -c%s "$OUT" 2>/dev/null || stat -f%z "$OUT") bytes)"
