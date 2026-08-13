#!/usr/bin/env bash
#
# publish-mac-app.sh — package a built Hearth.app and publish it to the
# /app/download page on the LLM host in one shot.
#
# What it does:
#   1. reads the version + build from the built .app's Info.plist (authoritative)
#   2. verifies the app is signed + notarized (gate; --allow-unnotarized to skip)
#   3. zips it with `ditto` (preserves the bundle, signature, and staple) under a
#      build-stamped, IMMUTABLE name: Hearth-<version>-b<build>.zip
#   4. computes the sha256 + byte size
#   5. auto-generates the changelog from iOS-repo git commits since the last
#      published build (or --notes <file>)
#   6. uploads THREE files to the host downloads dir:
#        Hearth-<v>-b<build>.zip    the archived build (kept forever)
#        Hearth-<v>-b<build>.json   per-build sidecar (the archive list reads these)
#        manifest.json              "latest build" pointer the page hero reads
#
# The /app/download page hydrates from manifest.json (current build) and lists
# every sidecar via /download/archive.json ("Previous versions"), so a publish
# needs NO HTML edit and NO orchestrator restart — both routes are no-cache and
# the static page is bind-mounted. Run this after a release build + notarize +
# staple (or via scripts/release-mac.sh, which does the whole pipeline).
#
# Usage:
#   scripts/publish-mac-app.sh --app /path/to/Hearth.app
#   scripts/publish-mac-app.sh                 # auto-discovers a Hearth.app
#   scripts/publish-mac-app.sh --keep 10       # prune archived builds beyond 10
#
# Flags:
#   --app PATH             the .app to publish (default: discover, see below)
#   --notes FILE           changelog override (default: auto from git commits)
#   --ios-repo PATH        repo for the git changelog (default: ~/Projects/hearth-ios)
#   --host HOST            ssh host (default: glacier)
#   --dest DIR             remote downloads dir (default: /docker/hearth/downloads)
#   --name NAME            zip basename without .zip (default: Hearth-<version>-b<build>)
#   --keep N               keep newest N archived builds, prune older (default: keep all)
#   --allow-unnotarized    publish even if the notarization check fails
#   --dry-run              do everything locally, print the manifest, skip the upload
#
set -euo pipefail

# ── defaults ─────────────────────────────────────────────────────────
APP=""
NOTES_FILE=""
IOS_REPO="${HOME}/Projects/hearth-ios"
HOST="glacier"
DEST="/docker/hearth/downloads"
ZIP_NAME=""
ALLOW_UNNOTARIZED=0
DRY_RUN=0
KEEP=0   # 0 = keep ALL archived builds; N = keep newest N, prune older

# ── arg parse ────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    --app) APP="$2"; shift 2 ;;
    --notes) NOTES_FILE="$2"; shift 2 ;;
    --ios-repo) IOS_REPO="$2"; shift 2 ;;
    --host) HOST="$2"; shift 2 ;;
    --dest) DEST="$2"; shift 2 ;;
    --name) ZIP_NAME="$2"; shift 2 ;;
    --keep) KEEP="$2"; shift 2 ;;
    --allow-unnotarized) ALLOW_UNNOTARIZED=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) sed -n '2,46p' "$0"; exit 0 ;;
    *) echo "unknown flag: $1" >&2; exit 2 ;;
  esac
done

die() { echo "✗ $*" >&2; exit 1; }
note() { echo "  $*"; }

# ── locate the .app ──────────────────────────────────────────────────
if [[ -z "$APP" ]]; then
  for cand in \
    "${HOME}/Desktop/Hearth.app" \
    "${HOME}/Library/Developer/Xcode/DerivedData"/Hearth-*/Build/Products/Release/Hearth.app; do
    [[ -d "$cand" ]] && { APP="$cand"; break; }
  done
fi
[[ -n "$APP" && -d "$APP" ]] || die "no Hearth.app found — pass --app <path>"
APP="$(cd "$(dirname "$APP")" && pwd)/$(basename "$APP")"   # absolutize
PLIST="$APP/Contents/Info.plist"
[[ -f "$PLIST" ]] || die "no Info.plist in $APP"
echo "▸ app:     $APP"

# ── read version metadata (authoritative: the built artifact) ────────
extract() { /usr/bin/plutil -extract "$1" raw "$PLIST" 2>/dev/null || true; }
VERSION="$(extract CFBundleShortVersionString)"
BUILD="$(extract CFBundleVersion)"
MIN_OS="$(extract LSMinimumSystemVersion)"
[[ -n "$VERSION" ]] || die "could not read CFBundleShortVersionString"
[[ -n "$BUILD" ]] || BUILD=""
[[ -n "$MIN_OS" ]] || MIN_OS=""
echo "▸ version: $VERSION (build ${BUILD:-?}) · min macOS ${MIN_OS:-?}"

# ── arch ─────────────────────────────────────────────────────────────
EXEC_NAME="$(extract CFBundleExecutable)"; EXEC_NAME="${EXEC_NAME:-Hearth}"
ARCHS="$(lipo -archs "$APP/Contents/MacOS/$EXEC_NAME" 2>/dev/null || echo "")"
if [[ "$ARCHS" == *arm64* && "$ARCHS" == *x86_64* ]]; then
  ARCH="Universal (Apple Silicon & Intel)"
elif [[ "$ARCHS" == *arm64* ]]; then
  ARCH="Apple Silicon"
elif [[ "$ARCHS" == *x86_64* ]]; then
  ARCH="Intel"
else
  ARCH=""
fi
echo "▸ arch:    ${ARCH:-unknown} ($ARCHS)"

# ── signing + notarization gate ──────────────────────────────────────
SIGNED_BY="$(codesign -dvv "$APP" 2>&1 | sed -n 's/^Authority=\(Developer ID Application:.*\)$/\1/p' | head -1)"
NOTARIZED=false
if xcrun stapler validate "$APP" >/dev/null 2>&1 && spctl -a -t exec "$APP" >/dev/null 2>&1; then
  NOTARIZED=true
fi
echo "▸ signed:  ${SIGNED_BY:-<unsigned>}"
echo "▸ notarized: $NOTARIZED"
if [[ "$NOTARIZED" != true && "$ALLOW_UNNOTARIZED" -ne 1 ]]; then
  die "app is not notarized/stapled — notarize + staple first, or pass --allow-unnotarized"
fi

# ── zip with ditto (preserves bundle + signature + staple) ───────────
# Build-stamped filename so every release is an IMMUTABLE archive entry
# (Hearth-0.1.0-b62.zip) — never overwritten by a later build.
if [[ -z "$ZIP_NAME" ]]; then
  ZIP_NAME="Hearth-${VERSION}${BUILD:+-b${BUILD}}"
fi
ZIP_FILE="${ZIP_NAME}.zip"
TMP_ZIP="$(mktemp -d)/${ZIP_FILE}"
echo "▸ zipping → $ZIP_FILE"
ditto -c -k --keepParent --sequesterRsrc "$APP" "$TMP_ZIP"

SIZE_BYTES="$(stat -f %z "$TMP_ZIP")"
SHA256="$(shasum -a 256 "$TMP_ZIP" | awk '{print $1}')"
BUILT_AT="$(stat -f '%Sm' -t '%Y-%m-%d' "$PLIST")"
PUBLISHED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "▸ size:    $((SIZE_BYTES / 1024 / 1024)) MB ($SIZE_BYTES bytes)"
echo "▸ sha256:  $SHA256"

# ── changelog (auto-generated from git commits) ──────────────────────
# Each line of $CHANGELOG_RAW becomes one JSON string in the array.
# Default: subjects of the iOS repo's commits since the LAST published build
# — we read the commit recorded in the live manifest's "git_commit" and list
# everything after it, so each release shows exactly what's new. Fallbacks:
# since the previous v* tag, else the last 15 commits. `--notes <file>`
# overrides with hand-written bullets.
GIT_COMMIT="$(git -C "$IOS_REPO" rev-parse HEAD 2>/dev/null || echo "")"
CHANGELOG_RAW=""
if [[ -n "$NOTES_FILE" ]]; then
  [[ -f "$NOTES_FILE" ]] || die "--notes file not found: $NOTES_FILE"
  CHANGELOG_RAW="$(sed -e 's/^[[:space:]]*[-*][[:space:]]*//' "$NOTES_FILE" | grep -v '^[[:space:]]*$' || true)"
elif [[ -n "$GIT_COMMIT" ]]; then
  # previous published commit, read best-effort from the live manifest
  PREV_COMMIT="$(ssh -o ConnectTimeout=5 "$HOST" "cat '${DEST}/manifest.json' 2>/dev/null" 2>/dev/null \
    | sed -n 's/.*"git_commit": *"\([0-9a-f]\{7,\}\)".*/\1/p' | head -1 || true)"
  RANGE=""
  if [[ -n "$PREV_COMMIT" ]] && git -C "$IOS_REPO" merge-base --is-ancestor "$PREV_COMMIT" HEAD 2>/dev/null; then
    RANGE="${PREV_COMMIT}..HEAD"
  else
    PREV_TAG="$(git -C "$IOS_REPO" describe --tags --abbrev=0 --match 'v*' HEAD^ 2>/dev/null || true)"
    [[ -n "$PREV_TAG" ]] && RANGE="${PREV_TAG}..HEAD"
  fi
  GITLOG="git -C $IOS_REPO log --no-merges --pretty=format:%s"
  RAW="$([[ -n "$RANGE" ]] && $GITLOG "$RANGE" 2>/dev/null || $GITLOG -15 2>/dev/null)" || true
  # strip conventional-commit "type(scope): " prefixes, capitalize, cap at 20
  CHANGELOG_RAW="$(printf '%s\n' "$RAW" \
    | sed -E 's/^[a-z]+(\([^)]*\))?!?: //' \
    | awk 'NF { print toupper(substr($0,1,1)) substr($0,2) }' \
    | head -20)" || true
fi

# JSON-escape a string (backslash + double-quote; prose has no control chars).
json_escape() { printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'; }

CHANGELOG_JSON="[]"
if [[ -n "$CHANGELOG_RAW" ]]; then
  items=""
  while IFS= read -r line; do
    [[ -z "$line" ]] && continue
    esc="$(json_escape "$line")"
    items="${items}${items:+,}\"${esc}\""
  done <<< "$CHANGELOG_RAW"
  [[ -n "$items" ]] && CHANGELOG_JSON="[${items}]"
fi

# ── manifest ─────────────────────────────────────────────────────────
MANIFEST="$(mktemp -d)/manifest.json"
cat > "$MANIFEST" <<JSON
{
  "name": "Hearth",
  "version": "$(json_escape "$VERSION")",
  "build": "$(json_escape "$BUILD")",
  "filename": "$(json_escape "$ZIP_FILE")",
  "size_bytes": ${SIZE_BYTES},
  "sha256": "${SHA256}",
  "arch": "$(json_escape "$ARCH")",
  "min_macos": "$(json_escape "$MIN_OS")",
  "notarized": ${NOTARIZED},
  "signed_by": "$(json_escape "$SIGNED_BY")",
  "built_at": "${BUILT_AT}",
  "published_at": "${PUBLISHED_AT}",
  "git_commit": "$(json_escape "$GIT_COMMIT")",
  "changelog": ${CHANGELOG_JSON}
}
JSON

# validate the JSON before shipping it (`plutil -lint` rejects JSON on some
# macOS versions; `-convert` actually parses it and fails on malformed input).
/usr/bin/plutil -convert binary1 -o /dev/null -- "$MANIFEST" || die "generated manifest is not valid JSON"

echo "▸ manifest:"
sed 's/^/    /' "$MANIFEST"

if [[ "$DRY_RUN" -eq 1 ]]; then
  echo "✓ dry run — wrote nothing to $HOST. zip: $TMP_ZIP"
  exit 0
fi

# ── publish ──────────────────────────────────────────────────────────
# Three files per release:
#   <ZIP_FILE>        the immutable build zip (archived forever)
#   <ZIP_NAME>.json   the per-build sidecar the /download/archive.json route lists
#   manifest.json     the "latest build" pointer the page hero hydrates from
SIDECAR="${ZIP_NAME}.json"
echo "▸ uploading to ${HOST}:${DEST}"
ssh "$HOST" "mkdir -p '$DEST'"
scp -q "$TMP_ZIP" "${HOST}:${DEST}/${ZIP_FILE}"
scp -q "$MANIFEST" "${HOST}:${DEST}/${SIDECAR}"
scp -q "$MANIFEST" "${HOST}:${DEST}/manifest.json"

# verify the remote sha matches what we shipped
REMOTE_SHA="$(ssh "$HOST" "sha256sum '${DEST}/${ZIP_FILE}' | awk '{print \$1}'")"
[[ "$REMOTE_SHA" == "$SHA256" ]] || die "remote sha mismatch ($REMOTE_SHA != $SHA256)"

# ── retention (optional) ─────────────────────────────────────────────
# Default keeps ALL archived builds. --keep N prunes the OLDEST zip+sidecar
# pairs beyond the newest N (by mtime), never touching manifest.json.
if [[ "$KEEP" =~ ^[0-9]+$ && "$KEEP" -gt 0 ]]; then
  echo "▸ retention: keeping newest $KEEP build(s)"
  # shellcheck disable=SC2029  # intentional client-side expansion of DEST/KEEP
  ssh "$HOST" "bash -s" <<REMOTE
    set -e
    cd "$DEST" || exit 0
    ls -1t Hearth-*.zip 2>/dev/null | tail -n +\$(( $KEEP + 1 )) | while IFS= read -r z; do
      echo "  pruning \$z"
      rm -f -- "\$z" "\${z%.zip}.json"
    done
REMOTE
fi

rm -f "$MANIFEST"
echo "✓ published Hearth $VERSION (build $BUILD) as $ZIP_FILE"
echo "    LAN:       https://your-llm-host.local/app/download"
echo "    Tailscale: https://your-llm-host.your-tailnet.ts.net/app/download"
