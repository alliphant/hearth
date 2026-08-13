#!/usr/bin/env bash
#
# Drop a new hvac-guide.html into Hearth.
#
#     scripts/install-hvac-guide.sh ~/Downloads/hvac-guide.html
#
# New versions of the guide arrive wholesale from Claude chat sessions. Field
# ids are stable, so a fresh file inherits every value already saved — the
# worksheet state lives in SQLite (kv_settings), not in the HTML.
#
# The ONLY transformation applied is swapping the Google Fonts <link> for the
# vendored ./fonts.css, so the page renders with no request leaving the
# tailnet. Everything else is copied byte-for-byte: the guide stays diffable,
# and its autosave IIFE is never patched (the route is mounted beneath the
# page at /app/hvac/api/state precisely so its relative fetch just works).
#
# Deploy after running this: commit, push, then on the LLM host
# `cd /docker/hearth/repo && git pull --ff-only`. No restart — src/app/client
# is served live from the bind mount.
set -euo pipefail

SRC="${1:-}"
if [[ -z "$SRC" || ! -f "$SRC" ]]; then
  echo "usage: $0 <path-to-hvac-guide.html>" >&2
  exit 1
fi

DEST_DIR="$(cd "$(dirname "$0")/.." && pwd)/src/app/client/hvac"
DEST="$DEST_DIR/index.html"

if [[ ! -f "$DEST_DIR/fonts.css" ]]; then
  echo "missing $DEST_DIR/fonts.css — run scripts/vendor-hvac-fonts.py first" >&2
  exit 1
fi

# Any <link> pointing at fonts.googleapis.com becomes the local stylesheet.
# A guide that already references ./fonts.css passes through untouched.
sed -E 's#<link href="https://fonts\.googleapis\.com/[^"]*" rel="stylesheet">#<link href="./fonts.css" rel="stylesheet">#g' \
  "$SRC" >"$DEST"

if grep -q 'fonts\.googleapis\.com\|fonts\.gstatic\.com' "$DEST"; then
  echo "WARN: $DEST still references Google Fonts — the <link> shape changed;" >&2
  echo "      update the sed above, or the page will hit the internet." >&2
fi

echo "installed $(wc -c <"$DEST" | tr -d ' ') bytes -> $DEST"
echo "serves at /app/hvac/ (your-llm-host.local/hvac redirects there)"
