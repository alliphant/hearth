#!/usr/bin/env bash
# Independent safety watchdog for the Phase-1 AEC probe.
# After $1 seconds it FORCE-ENABLES the HA config entry for the Satellite1, so
# the household voice is NEVER left down even if the probe (or the operator's
# session) dies. Re-enable is idempotent — a late fire after a clean probe is a
# harmless no-op. Launch detached (setsid+nohup) BEFORE disabling HA.
#   setsid nohup bash /tmp/aec-watchdog.sh 420 01KTDX9HCM48H94ZRF3SDRD4JE </dev/null >/tmp/aec-watchdog.log 2>&1 &
set -u
DEADLINE="${1:-420}"
ENTRY="${2:-01KTDX9HCM48H94ZRF3SDRD4JE}"
LOG=/tmp/aec-watchdog.log
echo "[$(date -Is)] watchdog armed: will enable $ENTRY in ${DEADLINE}s (pid $$)" >>"$LOG"
sleep "$DEADLINE"
TOKEN="$(grep ^HA_TOKEN= /docker/hearth/hearth.env | cut -d= -f2-)"
HA_TOKEN="$TOKEN" /home/jasper/aec-venv/bin/python /tmp/ha_entry.py enable "$ENTRY" >>"$LOG" 2>&1
echo "[$(date -Is)] watchdog FIRED: enabled $ENTRY (rc=$?)" >>"$LOG"
# confirm via REST
AVAIL="$(curl -s -H "Authorization: Bearer $TOKEN" http://localhost:8123/api/states \
  | /home/jasper/aec-venv/bin/python -c 'import sys,json;d=json.load(sys.stdin);print(sum(1 for s in d if "aabbcc" in s["entity_id"] and s["state"] not in ("unavailable","unknown")))' 2>/dev/null)"
echo "[$(date -Is)] watchdog post-enable: $AVAIL satellite1 entities live" >>"$LOG"
