#!/usr/bin/env bash
#
# release-mac.sh — cut a full Hearth Mac release in ONE command:
#
#   archive → export Developer ID → notarize → staple   (hearth-ios/scripts/dist-macos.sh)
#   → publish the notarized .app + manifest to /app/download   (publish-mac-app.sh)
#
# The notarization half is the iOS repo's existing, proven pipeline — this
# wrapper just chains it to the publish step. After this finishes, the page at
# https://your-llm-host.local/app/download shows the new version, size, checksum, and
# an auto-generated "What's new" list (git commits since the last release).
#
# One-time prereq: the notary credential dist-macos.sh expects — either the
#   `HearthNotary` keychain profile
#     (xcrun notarytool store-credentials HearthNotary --key <AuthKey.p8> \
#        --key-id <id> --issuer <issuer-id>)
#   or ASC_KEY / ASC_KEY_ID / ASC_ISSUER exported in the environment.
#
# Usage:
#   scripts/release-mac.sh                         # build + notarize + publish
#   scripts/release-mac.sh --dry-run               # build, then dry-run the publish
#   scripts/release-mac.sh --skip-build --app PATH # publish an already-notarized .app
#   scripts/release-mac.sh --ios-repo ~/Projects/hearth-ios --host glacier
#
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
IOS_REPO="${HOME}/Projects/hearth-ios"
HOST="glacier"
SKIP_BUILD=0
APP_OVERRIDE=""
PUBLISH_ARGS=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --ios-repo) IOS_REPO="$2"; shift 2 ;;
    --host) HOST="$2"; PUBLISH_ARGS+=(--host "$2"); shift 2 ;;
    --skip-build) SKIP_BUILD=1; shift ;;
    --app) APP_OVERRIDE="$2"; shift 2 ;;
    --notes) PUBLISH_ARGS+=(--notes "$2"); shift 2 ;;
    --allow-unnotarized) PUBLISH_ARGS+=(--allow-unnotarized); shift ;;
    --dry-run) PUBLISH_ARGS+=(--dry-run); shift ;;
    -h|--help) sed -n '2,28p' "$0"; exit 0 ;;
    *) echo "unknown flag: $1" >&2; exit 2 ;;
  esac
done

die() { echo "✗ $*" >&2; exit 1; }

DIST="$IOS_REPO/scripts/dist-macos.sh"

# ── build + notarize (the iOS repo's pipeline) ───────────────────────
if [[ "$SKIP_BUILD" -ne 1 ]]; then
  [[ -f "$DIST" ]] || die "dist-macos.sh not found at $DIST (pass --ios-repo, or --skip-build)"
  echo "▸ build + notarize → $DIST"
  ( cd "$IOS_REPO" && bash "$DIST" )
fi

# ── locate the notarized .app it produced ────────────────────────────
APP="$APP_OVERRIDE"
if [[ -z "$APP" ]]; then
  for cand in \
    "$IOS_REPO/build/dist/export/Hearth.app" \
    "$IOS_REPO/build/dist/Hearth.app"; do
    [[ -d "$cand" ]] && { APP="$cand"; break; }
  done
  [[ -z "$APP" ]] && APP="$(find "$IOS_REPO/build" -maxdepth 4 -type d -name 'Hearth.app' 2>/dev/null | head -1 || true)"
fi
[[ -n "$APP" && -d "$APP" ]] || die "no built Hearth.app found under $IOS_REPO/build — pass --app"

# ── publish to the download page ─────────────────────────────────────
echo "▸ publish → $APP"
"$HERE/publish-mac-app.sh" --app "$APP" --ios-repo "$IOS_REPO" \
  ${PUBLISH_ARGS[@]+"${PUBLISH_ARGS[@]}"}
