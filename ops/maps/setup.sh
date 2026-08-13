#!/usr/bin/env bash
#
# One-time setup for the local maps stack. Downloads the Colorado OSM
# extract from Geofabrik (~150 MB compressed, ~1.2 GB uncompressed),
# builds OSRM graphs for drive / bike / walk, and primes Nominatim.
#
# First run: 60-90 minutes (mostly OSRM partition + customize). After
# that, refresh.sh handles incremental updates.

set -euo pipefail

cd "$(dirname "$0")"

OSM_REGION="${OSM_REGION:-north-america/us/colorado}"
OSM_FILE="colorado-latest.osm.pbf"
OSM_URL="https://download.geofabrik.de/${OSM_REGION}-latest.osm.pbf"

OSM_DATA=./osm-data
OSRM_DATA=./osrm-data

mkdir -p "$OSM_DATA" "$OSRM_DATA"

# ── 1. Download OSM extract ─────────────────────────────────────────────
if [ ! -f "$OSM_DATA/$OSM_FILE" ]; then
  echo "[setup] Downloading $OSM_URL ..."
  curl -L --fail -o "$OSM_DATA/$OSM_FILE" "$OSM_URL"
else
  echo "[setup] $OSM_DATA/$OSM_FILE already exists; skipping download"
fi

# ── 2. Build OSRM graphs (drive, bike, walk) ───────────────────────────
build_profile() {
  local mode="$1"
  local profile="$2"           # osrm bundled profile file (car.lua etc.)
  local out_name="$3"          # output graph name
  local source="$OSM_DATA/$OSM_FILE"

  if [ -f "$OSRM_DATA/${out_name}.osrm" ]; then
    echo "[setup] $out_name OSRM graph already built; skipping"
    return
  fi

  echo "[setup] Building OSRM graph for $mode (profile=$profile)..."
  # osrm-backend image accepts the profile path at /opt/<profile>.lua.
  docker run --rm -v "$PWD/$OSM_DATA:/data" \
    ghcr.io/project-osrm/osrm-backend:latest \
    osrm-extract -p "/opt/$profile" "/data/$OSM_FILE"

  # The above produces <basename>.osrm in /data; rename to the per-mode
  # filename the compose unit expects.
  local extracted_base
  extracted_base="${OSM_FILE%.osm.pbf}"
  for f in "$OSM_DATA/${extracted_base}.osrm"*; do
    [ -e "$f" ] || continue
    local rel="${f#"$OSM_DATA/${extracted_base}"}"
    mv "$f" "$OSRM_DATA/${out_name}${rel}"
  done

  docker run --rm -v "$PWD/$OSRM_DATA:/data" \
    ghcr.io/project-osrm/osrm-backend:latest \
    osrm-partition "/data/${out_name}.osrm"
  docker run --rm -v "$PWD/$OSRM_DATA:/data" \
    ghcr.io/project-osrm/osrm-backend:latest \
    osrm-customize "/data/${out_name}.osrm"

  echo "[setup] Built ${out_name}.osrm"
}

build_profile drive car.lua colorado-drive
build_profile bike  bicycle.lua colorado-bike
build_profile walk  foot.lua colorado-walk

# ── 3. Bring the stack up ──────────────────────────────────────────────
echo "[setup] Starting OSRM + Nominatim..."
docker compose up -d

# Give Nominatim a moment for its first-run import (this can take a
# while on first boot — it's loading the PBF into PostgreSQL).
echo "[setup] Waiting for services to settle (up to 5 minutes)..."
for _ in $(seq 1 30); do
  if curl -fsS http://localhost:5001/health > /dev/null 2>&1 \
     && curl -fsS http://localhost:5002/health > /dev/null 2>&1 \
     && curl -fsS http://localhost:5003/health > /dev/null 2>&1; then
    break
  fi
  sleep 10
done

# ── 4. Verify ──────────────────────────────────────────────────────────
echo "[setup] Verifying:"

# Two points roughly between downtown Pleasantville and the clinic.
TEST_FROM="-104.9903,39.7392"
TEST_TO="-104.9792,39.7431"

for port_label in "5001 drive" "5002 bike" "5003 walk"; do
  port="${port_label% *}"
  label="${port_label#* }"
  if curl -fsS "http://localhost:${port}/route/v1/driving/${TEST_FROM};${TEST_TO}?overview=false" > /dev/null; then
    echo "  ✓ OSRM ${label} on :${port}"
  else
    echo "  ✗ OSRM ${label} on :${port} NOT responding"
  fi
done

if curl -fsS "http://localhost:8989/search?q=Fort+Collins&format=jsonv2&limit=1" > /dev/null; then
  echo "  ✓ Nominatim on :8989"
else
  echo "  ✗ Nominatim on :8989 NOT responding (first-time import may still be running)"
fi

DISK_USAGE=$(du -sh "$OSM_DATA" "$OSRM_DATA" 2>/dev/null | awk '{print $1}' | paste -sd,)
echo ""
echo "[setup] Done. 4 services up, ${DISK_USAGE} on disk for OSM + OSRM data."
echo "[setup] Maps endpoints:"
echo "  OSRM drive: http://localhost:5001"
echo "  OSRM bike:  http://localhost:5002"
echo "  OSRM walk:  http://localhost:5003"
echo "  Nominatim:  http://localhost:8989"
