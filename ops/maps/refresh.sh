#!/usr/bin/env bash
#
# Monthly OSM data refresh. Re-downloads the Colorado extract, rebuilds
# the OSRM graphs, and replicates updates into Nominatim's running
# database.
#
# ⚠ THE DRIFT RULE (the 2026-06-09 outage class): the OSRM graph files
# are only readable by the SAME osrm-backend version that prepped them.
# This script therefore preps with the EXACT image the running engine
# container serves from (docker inspect on hearth-osrm-drive), so the
# prep and serve sides structurally cannot drift — and it restarts the
# engines after the swap so they never serve stale file handles. The
# 2026-06-09 incident: graphs re-prepped with ghcr latest (v26.x) while
# the live compose still served with the 4-year-old Docker-Hub
# osrm/osrm-backend (v5.26) → all three engines crash-looped.
#
# Upgrading OSRM deliberately: bump the pinned image tag in
# /docker/docker-compose.yml, run THIS script with OSRM_IMAGE=<new tag>
# (preps + swaps data with the new binary), then
# `docker compose up -d hearth-osrm-{drive,bike,walk}` to recreate the
# engines on the new image. Never point the engines at floating :latest.
#
# Topology (2026-05-29 consolidation): the live stack is defined in
# /docker/docker-compose.yml (services hearth-osrm-*), data under
# /docker/maps/. The ops/maps/docker-compose.yaml here is the
# standalone reference. Every path/name below is env-overridable so the
# script runs against either.
#
# Drive this from a systemd timer (see ops/systemd/hearth-maps-refresh.*)
# or by hand: bash ops/maps/refresh.sh

set -euo pipefail

LOG="/tmp/hearth-maps-refresh-$(date -u +%Y%m%dT%H%M%S).log"
exec >"$LOG" 2>&1
echo "[refresh] started $(date -u)"

OSM_REGION="${OSM_REGION:-north-america/us/colorado}"
OSM_FILE="colorado-latest.osm.pbf"
OSM_URL="https://download.geofabrik.de/${OSM_REGION}-latest.osm.pbf"

# Live the LLM host defaults; override for the standalone ops/maps stack.
OSM_DATA="${OSM_DATA:-/docker/maps/osm-data}"
OSRM_DATA="${OSRM_DATA:-/docker/maps/osrm-data}"
ENGINE_PREFIX="${ENGINE_PREFIX:-hearth-osrm-}"
NOMINATIM_CONTAINER="${NOMINATIM_CONTAINER:-hearth-nominatim}"

# Prep with the EXACT image the engines serve from (the drift rule).
# OSRM_IMAGE overrides for a deliberate upgrade; the fallback pin is only
# for a cold box where no engine container exists yet.
FALLBACK_IMAGE="ghcr.io/project-osrm/osrm-backend:v26.6.5-amd64-debian"
OSRM_IMAGE="${OSRM_IMAGE:-$(docker inspect -f '{{.Config.Image}}' "${ENGINE_PREFIX}drive" 2>/dev/null || echo "$FALLBACK_IMAGE")}"
echo "[refresh] prepping with image: $OSRM_IMAGE"

# ── 1. Fetch latest PBF ────────────────────────────────────────────────
echo "[refresh] downloading $OSM_URL"
curl -L --fail -o "$OSM_DATA/$OSM_FILE.new" "$OSM_URL"
mv "$OSM_DATA/$OSM_FILE.new" "$OSM_DATA/$OSM_FILE"

# ── 2. Rebuild OSRM graphs (atomic-swap pattern) ───────────────────────
rebuild_profile() {
  local mode="$1"
  local profile="$2"
  local out_name="$3"
  local staging="${out_name}.new"

  echo "[refresh] rebuilding $out_name"

  # Extract into a new file alongside the old.
  docker run --rm -v "$OSM_DATA:/data" \
    "$OSRM_IMAGE" \
    osrm-extract -p "/opt/$profile" "/data/$OSM_FILE"

  local extracted_base="${OSM_FILE%.osm.pbf}"
  for f in "$OSM_DATA/${extracted_base}.osrm"*; do
    [ -e "$f" ] || continue
    local rel="${f#"$OSM_DATA/${extracted_base}"}"
    mv "$f" "$OSRM_DATA/${staging}${rel}"
  done

  docker run --rm -v "$OSRM_DATA:/data" \
    "$OSRM_IMAGE" \
    osrm-partition "/data/${staging}.osrm"
  docker run --rm -v "$OSRM_DATA:/data" \
    "$OSRM_IMAGE" \
    osrm-customize "/data/${staging}.osrm"

  # Promote: stop the running engine, rotate files, restart. Container
  # names (not compose service names) so this works from any cwd against
  # whichever compose project owns the stack.
  docker stop "${ENGINE_PREFIX}${mode}" || true
  for f in "$OSRM_DATA/${out_name}.osrm"*; do
    [ -e "$f" ] || continue
    rm -f "$f"
  done
  for f in "$OSRM_DATA/${staging}.osrm"*; do
    local rel="${f#"$OSRM_DATA/${staging}"}"
    mv "$f" "$OSRM_DATA/${out_name}${rel}"
  done
  docker start "${ENGINE_PREFIX}${mode}" || true
}

rebuild_profile drive car.lua colorado-drive
rebuild_profile bike  bicycle.lua colorado-bike
rebuild_profile walk  foot.lua colorado-walk

# ── 3. Verify the engines actually serve the fresh graphs ─────────────
# A crash-looping engine after a swap means a prep/serve version mismatch
# (see the drift rule above) — fail loudly rather than leaving routing
# silently down for Iris/Kate.
sleep 3
for spec in drive:5001 bike:5002 walk:5003; do
  mode="${spec%%:*}"
  port="${spec##*:}"
  if curl -sS -m 10 "http://localhost:${port}/route/v1/driving/-104.97,39.72;-104.94,39.75" | grep -q '"code":"Ok"'; then
    echo "[refresh] ${ENGINE_PREFIX}${mode} healthy on :${port}"
  else
    echo "[refresh] ERROR: ${ENGINE_PREFIX}${mode} NOT healthy on :${port} — check image/data version drift" >&2
    exit 1
  fi
done

# ── 4. Nominatim replication ──────────────────────────────────────────
# Nominatim's image supports `nominatim replication` for incremental
# updates. Run it inside the running container.
echo "[refresh] running nominatim replication"
docker exec "$NOMINATIM_CONTAINER" sudo -u nominatim nominatim replication \
  --project-dir /nominatim --once || true

echo "[refresh] done $(date -u). log: $LOG"
