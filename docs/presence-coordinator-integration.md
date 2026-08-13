# Presence office — Voice Coordinator integration (handoff)

**Status:** ready to apply. The Hearth-side of the LD2450 presence office shipped
on `main` (2026-06-07) — store, routes, SSE, the pane composer, the canvas
viewer + WYSIWYG editor, the ⚙ gear, and `smoke:presence`. This doc is the
**coordinator-side** drop-in: the `ZoneWriter` abstraction + the seam changes in
`integrations/voice-coordinator/`.

It lives here (not in `integrations/voice-coordinator/`) on purpose: that tree is
on the **`feat/voice-coordinator`** branch (absent on `main`), owned by the
voice-coordinator session. Applying these edits is that session's lane — drop
them in when the coordinator holds the `.29` session (post-cutover), or on a 2nd
Satellite1. Nothing here is needed for the device-free Hearth office that already
ships.

Design references: [design-ld2450-zone-editor.md](design-ld2450-zone-editor.md)
§3 (the contract), §5 (the transform — already implemented client-side), §8 (the
concurrency dependency). Owner decisions (2026-06-07): **firmware target =
`tuner`** (keep FutureProof's custom `satellite1_radar` firmware; zones via the
on-device HTTP tuner, reboot-to-persist), **office host = Iris**.

---

## 1. The live Hearth contract (concrete — these endpoints exist now)

All under `/api/presence/*`, behind the global auth middleware. The coordinator
authenticates with its service bearer (`HEARTH_VC_BEARER`, the same one it uses
for `/api/conversations/*`; it resolves to the owner today).

> ⚠ **nginx:** the top-level `/api/presence/` namespace must be added to the
> `location ~ ^/api/(...)` alternation in `/docker/nginx/locations.conf` on
> the LLM host, or it falls through to Home Assistant's catch-all and 404s. Edit the
> file + `docker restart nginx` (single-file bind mount — `nginx -s reload`
> re-reads the stale inode); `docker exec nginx nginx -t` first. (See CLAUDE.md
> "nginx /api alternation".)

### Live targets UP

`POST /api/presence/targets` — republish a throttled snapshot. Body (mm, radar
frame, X signed −left/+right, Y positive-away):

```json
{
  "device_id": "satellite1",
  "present": true,
  "moving": 1,
  "still": 0,
  "nearest_mm": 1850,
  "targets": [
    { "index": 1, "x_mm": -320, "y_mm": 1820, "speed_mms": 110,
      "angle_deg": -10, "distance_mm": 1850, "active": true }
  ],
  "captured_at": "2026-06-07T18:30:00.000Z"
}
```

`200 {ok:true}`. Hearth caches it (ephemeral; not SQLite) + fans it out over SSE
as `presence_targets`. Max 3 targets. Not audited (≤4 Hz). `is_live` is derived
from recency (`HEARTH_PRESENCE_LIVE_TTL_MS`, default 10 s) — so if the coordinator
stops republishing, the office degrades to read-only on its own.

### Zones DOWN

`GET /api/presence/zones/pending?device_id=satellite1` →

```json
{ "pending": {
    "device_id": "satellite1", "revision": 4,
    "zones": [ { "index": 1, "name": "Couch", "color": "#5e8aa8",
                 "type": "Detection", "x1_mm": -1000, "y1_mm": 500,
                 "x2_mm": 1000, "y2_mm": 2500 } ],
    "firmware_target": "tuner", "reboot_requested": false } }
```

`{ "pending": null }` when nothing is queued. Returns non-null when EITHER a zone
write is pending OR the owner requested a reboot.

`POST /api/presence/zones/ack` — after applying:

```json
{ "device_id": "satellite1", "revision": 4, "applied": true,
  "reboot_required": true, "error": null }
```

Flips the row to `applied`/`error`, records `reboot_required`, clears
`reboot_requested` when `applied`, and emits `presence_zones_acked` (the editor
confirms on it). **Ack against the SAME `revision` you pulled** — a stale-revision
ack (the owner saved again mid-apply) is ignored so the newer pending survives.

(The owner-facing routes — `GET /state`, `POST /zones`, `GET/POST /settings`,
`POST /reboot` — are driven by the web pane, not the coordinator. The coordinator
only ever calls `targets`, `zones/pending`, `zones/ack`.)

---

## 2. `integrations/voice-coordinator/zone_writer.py` (NEW — full source)

Two impls behind one Protocol. **`TunerHttpZoneWriter` is the live path** (owner
keeps the custom firmware); `EntityZoneWriter` is the no-reboot path if/when the
stock `ld2450` build is flashed. `device` is the coordinator's `DeviceConnection`
(the live aioesphomeapi session).

```python
"""ZoneWriter — apply desired LD2450 zone config to the device (design §3b).

Hearth speaks ONE unit: millimeters, radar frame (origin = sensor, X signed
−left/+right, Y positive-away). The mm→cm ÷10 conversion the FutureProof tuner
needs lives ONLY in TunerHttpZoneWriter, at the boundary.
"""
from __future__ import annotations
import logging
from dataclasses import dataclass
from typing import Protocol, runtime_checkable

import httpx

log = logging.getLogger("voice_coordinator.zone_writer")

# LD2450 datasheet legal box (mm) — mirror of the TS store's exported constants.
X_MIN, X_MAX, Y_MIN, Y_MAX = -3000, 3000, 0, 6000


@dataclass
class ZoneRect:
    index: int           # 1..3
    type: str            # 'Disabled' | 'Detection' | 'Filter'
    x1_mm: float
    y1_mm: float
    x2_mm: float
    y2_mm: float
    name: str = ""
    color: str = ""


@dataclass
class WriteResult:
    applied: bool
    reboot_required: bool = False
    error: str | None = None


@runtime_checkable
class ZoneWriter(Protocol):
    async def write_zones(self, zones: list[ZoneRect]) -> WriteResult: ...


def _clamp(v: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, v))


class TunerHttpZoneWriter:
    """Custom satellite1_radar firmware — the on-device HTTP tuner on port 80.

    Sequence per write (design §3b):
      1. flip the 'Radar Tuner WebUI' switch ON (switch_command);
      2. PATCH /api/v1/ld2450/config with the cm-converted polygon (a rect = 4
         points), read back reboot_required;
      3. POST /api/v1/save;
      4. flip the tuner switch back OFF.
    The reboot itself is NOT auto-run here (it drops the voice session) — surface
    reboot_required up; the owner reboots explicitly (POST /api/presence/reboot →
    pending.reboot_requested → reboot_now()).
    """

    def __init__(self, device, device_ip: str, tuner_switch_key: int | None,
                 port: int = 80, timeout_s: float = 6.0):
        self._device = device
        self._base = f"http://{device_ip}:{port}"
        self._tuner_switch_key = tuner_switch_key
        self._timeout = timeout_s

    @staticmethod
    def _rect_to_cm_polygon(z: ZoneRect) -> list[dict]:
        # Rect → 4 polygon points, mm→cm (÷10), clamped to the legal box.
        xs = (_clamp(z.x1_mm, X_MIN, X_MAX), _clamp(z.x2_mm, X_MIN, X_MAX))
        ys = (_clamp(z.y1_mm, Y_MIN, Y_MAX), _clamp(z.y2_mm, Y_MIN, Y_MAX))
        corners = [(xs[0], ys[0]), (xs[1], ys[0]), (xs[1], ys[1]), (xs[0], ys[1])]
        return [{"x": round(x / 10.0), "y": round(y / 10.0)} for (x, y) in corners]

    async def write_zones(self, zones: list[ZoneRect]) -> WriteResult:
        try:
            if self._tuner_switch_key is not None:
                self._device.switch_command(self._tuner_switch_key, True)
            # Build the tuner's payload. Detection/Filter rects become polygons;
            # a Filter zone goes to the exclusion polygon, Detection to zones[].
            detection = [self._rect_to_cm_polygon(z) for z in zones if z.type == "Detection"]
            exclusion = [self._rect_to_cm_polygon(z) for z in zones if z.type == "Filter"]
            payload = {"zones": detection, "exclusion": exclusion}
            async with httpx.AsyncClient(timeout=self._timeout) as http:
                patch = await http.patch(f"{self._base}/api/v1/ld2450/config", json=payload)
                patch.raise_for_status()
                reboot_required = bool(patch.json().get("reboot_required", True))
                save = await http.post(f"{self._base}/api/v1/save")
                save.raise_for_status()
            return WriteResult(applied=True, reboot_required=reboot_required)
        except Exception as e:  # noqa: BLE001 — surface to Hearth, never crash the loop
            log.warning("tuner zone write failed: %s", e)
            return WriteResult(applied=False, error=str(e))
        finally:
            if self._tuner_switch_key is not None:
                try:
                    self._device.switch_command(self._tuner_switch_key, False)
                except Exception:  # noqa: BLE001
                    pass

    async def reboot_now(self) -> bool:
        try:
            async with httpx.AsyncClient(timeout=self._timeout) as http:
                r = await http.post(f"{self._base}/api/v1/reboot")
                r.raise_for_status()
            return True
        except Exception as e:  # noqa: BLE001
            log.warning("tuner reboot failed: %s", e)
            return False


class EntityZoneWriter:
    """Stock ESPHome ld2450 build — zone corners are number entities + a Zone
    Type select. Live writes, no reboot. Maps each zone_N x1/y1/x2/y2 to its
    entity key (reverse-lookup by the same name substrings ld2450.py matches),
    then number_command / select_command.

    `entity_keys` is a dict like {'zone_1_x1': key, 'zone_1_type': key, ...},
    built once at enumerate time from device._entities_by_key.
    """

    def __init__(self, device, entity_keys: dict[str, int]):
        self._device = device
        self._keys = entity_keys

    async def write_zones(self, zones: list[ZoneRect]) -> WriteResult:
        try:
            for z in zones:
                p = f"zone_{z.index}"
                for corner, val in (("x1", z.x1_mm), ("y1", z.y1_mm),
                                    ("x2", z.x2_mm), ("y2", z.y2_mm)):
                    key = self._keys.get(f"{p}_{corner}")
                    if key is not None:
                        self._device.number_command(key, float(val))  # mm; entity unit is mm
                type_key = self._keys.get(f"{p}_type")
                if type_key is not None:
                    self._device.select_command(type_key, z.type)
            return WriteResult(applied=True, reboot_required=False)
        except Exception as e:  # noqa: BLE001
            log.warning("entity zone write failed: %s", e)
            return WriteResult(applied=False, error=str(e))
```

> Verify the exact `aioesphomeapi` method signatures against the version pinned
> in the coordinator's container (`number_command(key, value)` /
> `select_command(key, option)` / `switch_command(key, bool)` — same shape as the
> existing `media_player_command`). They weren't installed in the planning env.

---

## 3. Seam changes (additive, per file)

**`ld2450.py`** — add `PresenceSnapshot.to_wire()` returning the §1 dict:
`{device_id, present, moving, still, nearest_mm, targets:[{index, x_mm, y_mm,
speed_mms, angle_deg, distance_mm, active}], captured_at}`. The parse already
exists (`parse_presence`); this just serializes it. `captured_at` =
`datetime.now(timezone.utc).isoformat()`.

**`hearth_client.py`** — three methods (bearer = `HEARTH_VC_BEARER`):

```python
async def post_presence_targets(self, snap: dict) -> None:
    # fire-and-forget; presence is opportunistic, never load-bearing
    try:
        await self._http.post(f"{self._base}/api/presence/targets", json=snap,
                              headers=self._auth, timeout=3.0)
    except Exception as e:
        log.debug("presence targets republish failed: %s", e)

async def get_pending_zones(self, device_id: str) -> dict | None:
    r = await self._http.get(f"{self._base}/api/presence/zones/pending",
                            params={"device_id": device_id}, headers=self._auth, timeout=5.0)
    r.raise_for_status()
    return r.json().get("pending")

async def ack_zones(self, device_id: str, revision: int, result) -> None:
    await self._http.post(f"{self._base}/api/presence/zones/ack", headers=self._auth, timeout=5.0,
        json={"device_id": device_id, "revision": revision, "applied": result.applied,
              "reboot_required": result.reboot_required, "error": result.error})
```

**`device.py`** — thin wrappers over the aioesphomeapi `APIClient` (mirror
`media_player_command`): `number_command(key, value)`, `select_command(key,
option)`, `switch_command(key, on)`. Expose the `_entities_by_key` reverse-lookup
so the writer-selection + `EntityZoneWriter` can find keys by name substring.

**`config.py`** — two config blocks:

```python
@dataclass
class PresenceConfig:
    enabled: bool = True
    republish_hz: float = 4.0     # throttle ceiling; LD2450 is ~10 Hz

@dataclass
class ZoneWriteConfig:
    mode: str = "auto"            # 'auto' | 'entity' | 'tuner' (Hearth's firmware_target overrides)
    tuner_http_port: int = 80
    auto_reboot_after_write: bool = False   # a reboot drops the voice session — owner triggers it
    poll_interval_s: float = 10.0
```

**`coordinator.py`** — two additions:

1. **Republish (the `# (Phase 3) republish` seam in `_on_device_state`).** After
   `parse_presence()`, throttle to ≤`republish_hz` via a monotonic gate, with a
   "publish on meaningful change" override (presence/zone-count flip publishes
   immediately; pure position jitter coalesces). Then
   `await hearth.post_presence_targets(snap.to_wire())`.

2. **Pending-zone poll/apply/ack task.** Every `poll_interval_s` (and you may
   also subscribe to a future `presence_zones_update` SSE for immediacy), call
   `hearth.get_pending_zones(device_id)`. If a newer `revision` exists **and the
   session is healthy and NOT mid-SPEAKING/LISTENING**: build `[ZoneRect(...)]`
   from `pending["zones"]`, `await writer.write_zones(...)`, then
   `await hearth.ack_zones(device_id, revision, result)`. If
   `pending["reboot_requested"]` and the writer is the tuner, run
   `reboot_now()` (guarded by `auto_reboot_after_write` / an explicit owner
   action), then ack.

   **Writer selection** (at enumerate time): `firmware_target` from the pending
   payload wins; on `auto`, probe — if `zone_1_x1`-style **number** entities are
   present → `EntityZoneWriter`, else `TunerHttpZoneWriter`. (The owner chose
   `tuner`, so today it's the tuner path.)

---

## 4. Open item to resolve against the real device (design §11 #1)

Does the live `.29` custom firmware publish the **per-target x/y/speed/angle**
sensors over the native API (the viewer needs them), or only presence/counts?
`radar_entities.h` registers dynamic `Sensor`s (likely yes) but they may be
`disabled_by_default`. **Resolve by enumerating once the coordinator holds the
session** (`device.py _enumerate_entities` logs them — grep for "Target-1 X").
If absent/disabled: fall back to the tuner's `GET /api/v1/ld2450/live` poll (cm,
x/y only — no speed vector) feeding the same `to_wire()`/`post_presence_targets`
path, OR flash the stock `ld2450` build. The viewer + republish contract are
identical either way.

---

## 5. Phasing

- **Now (shipped, device-free):** the Hearth office renders for the owner on
  Iris — FOV cone, range arcs, default zones, the read-only banner ("owned by
  HA"), the editor UI, the gear. `smoke:presence` green.
- **Phase 1 (this doc, viewer):** republish (§3.1) → live target dots light up.
  Best demoed on the dev-kit / 2nd device the coordinator owns; the live `.29`
  viewer lights up once the AEC handoff moves `.29` off HA.
- **Phase 2 (this doc, editor):** the pending/apply/ack task (§3.2) +
  `zone_writer.py` (§2) → zone write-back. Tuner path (reboot-per-save); the
  editor already surfaces the "Reboot device" button on `reboot_required`.
