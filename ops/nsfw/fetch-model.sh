#!/usr/bin/env bash
# Fetch the GantMan/nsfw_model MobileNetV2 SavedModel into ./model/ (gitignored,
# ~27 MB extracted). Idempotent: skips if the model dir already exists.
#
# We use the release ZIP's SavedModel directory (not the bundled saved_model.h5,
# which is a hub.KerasLayer needing tensorflow_hub, and not the S3 .h5 the README
# once linked — that bucket now 403s). The dir loads standalone in TF 2.15.
set -euo pipefail
cd "$(dirname "$0")"

DEST="model/mobilenet_v2_140_224"
REL="https://github.com/GantMan/nsfw_model/releases/download/1.1.0/nsfw_mobilenet_v2_140_224.zip"

if [ -f "$DEST/saved_model.pb" ]; then
  echo "[fetch-model] already present at $DEST — nothing to do"
  exit 0
fi

echo "[fetch-model] downloading MobileNetV2 SavedModel (~142 MB zip)…"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
curl -sSL -o "$tmp/m.zip" "$REL"
unzip -q -o "$tmp/m.zip" -d "$tmp"

# Keep only what tf.keras.models.load_model(dir) needs: the SavedModel graph +
# variables + assets. Drop the .h5 / tflite / frozen_graph / web_model bloat.
mkdir -p "$DEST"
src="$tmp/mobilenet_v2_140_224"
cp "$src/saved_model.pb" "$DEST/"
cp "$src/class_labels.txt" "$DEST/" 2>/dev/null || true
cp -r "$src/variables" "$DEST/"
[ -d "$src/assets" ] && cp -r "$src/assets" "$DEST/" || true

echo "[fetch-model] ready: $DEST ($(du -sh "$DEST" | cut -f1))"
