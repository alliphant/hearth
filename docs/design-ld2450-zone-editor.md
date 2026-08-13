# Design: LD2450 presence viewer + WYSIWYG zone editor (a Hearth office)

**Status:** plan, research-complete. Nothing applied. Authored 2026-06-07 from a
deep planning pass (LD2450 datasheet + ESPHome component + FutureProof firmware
source + Hearth pane/SSE/coordinator code read). Depends on the Hearth Voice
Coordinator (`feat/voice-coordinator`) holding the device session — see §8.

This doc is the file-level execution plan for the feature scoped in
[design-esp-direct-voice.md](design-esp-direct-voice.md) §4:

> **LD2450 zone *editor* (the GUI Jasper wants)** — zone corners are writable
> entities + a zone_type select over the API → a top-down room canvas with
> draggable zone rects + live target dots, writing corners back via the
> coordinator. Same compose-pane + ⚙-settings pattern as the Code Shop office.
> **Highest-value rebuild; better than HA's raw sliders.**

## 0. TL;DR of the architecture

A new **`pane_kind: 'presence'`** office (web today, iOS later), composed by
`compose_presence_pane()` in `specialist_pane.ts` exactly like the Code Shop's
`compose_codeshop_pane()`. The office hosts a **vanilla-canvas room view** in
`app.js`: sensor at the apex, ±60° FOV cone + range arcs, up to 3 live target
dots, and draggable/resizable zone rectangles. A new **presence_zones store**
(`src/memory/stores/presence_zones.ts`) holds per-device room calibration + the
zone config (mirrors `codeshop_settings.ts`). A new **`/api/presence/*`** route
namespace (`src/app/routes/presence.ts`) is the web↔backend contract; live
targets reach the canvas over the **existing SSE bus** as a new
`presence_targets` event. The **Voice Coordinator** is the only thing that
talks to the device: it republishes live targets up to Hearth and applies zone
writes down to the device. The web pane never touches the device directly.

```
device (.29 LD2450)
   │  aioesphomeapi: subscribe_states (targets)  ▲ number_command/select_command (zone writes)
   ▼                                              │   — OR — radar-tuner HTTP PATCH (custom-firmware path; §3)
Voice Coordinator (integrations/voice-coordinator)
   │  POST /api/presence/targets  (republish, throttled)   ▲ GET /api/presence/zones/pending (poll desired zones)
   ▼                                                        │   POST /api/presence/zones/ack
Hearth orchestrator (:7700)
   │  SSE: { type:'presence_targets', … }      ▲ POST /api/presence/zones (desired config from the editor)
   ▼  GET /api/presence/state (snapshot)        │
web office pane (app.js canvas)  ── drag zone rect ──┘
```

The one genuine fork — and the doc's most important finding — is **how zones
are written**, because the *live* device runs FutureProof's **custom
`satellite1_radar` firmware**, which exposes zones over an **on-device HTTP
tuner**, NOT as ESPHome `number`/`select` entities. The stock ESPHome `ld2450`
platform *does* expose them as entities. The coordinator abstracts both behind
one `ZoneWriter` interface (§3). Read §1 + §3 before building.

---

## 1. The HLK-LD2450 — facts the transforms depend on

The HLK-LD2450 is a 24 GHz one-transmit / two-receive FMCW mmWave module that
tracks up to **3 moving/still targets** and reports each target's position and
velocity. ([Hi-Link instruction manual][m1]; [serial protocol v1.03][m2];
[Hi-Link product page][m3])

### Coordinate system (THE thing the canvas transform encodes)

- **Origin = the sensor.** All coordinates are relative to the module.
- **Units = millimeters** (mm) for position, **mm/s** for speed, **degrees** for
  angle. ([serial protocol v1.03][m2]; [ESPHome ld2450 component][e1])
- **X axis = lateral, SIGNED.** Range **−3000 … +3000 mm** (≈ ±3 m). Negative =
  left of the sensor's centerline, positive = right. ([ESPHome ld2450][e1])
- **Y axis = distance straight out from the sensor face, POSITIVE only.** Range
  **0 … +6000 mm** (≈ 6 m max). ([ESPHome ld2450][e1])
- **FOV ≈ ±60° in azimuth** (120° total). Effective tracking range ~6 m;
  detection narrows toward the edges of the cone. ([Hi-Link manual][m1])
- **Per-target fields:** `x` (mm, signed), `y` (mm), `speed` (mm/s; sign =
  toward/away), `angle` (°), `distance` (mm, = √(x²+y²)), `resolution` (mm).
  ([ESPHome ld2450][e1])
- **Report rate ≈ 10 Hz** (10 frames/s over the 256000-baud serial link).
  ([serial protocol v1.03][m2]) — important for §6 (SSE throttling).

> ⚠ **Units gotcha:** the *datasheet + the ESPHome `ld2450` entities use mm*,
> but FutureProof's **on-device tuner API uses centimeters** (its
> `cmToCanvas`/`canvasToCm` and the `{x,y}` save payload are cm —
> [radar_tuner_ld2450.html][f4]). The coordinator's `ZoneWriter` MUST convert at
> the boundary so Hearth speaks ONE unit internally. **Decision: Hearth stores
> and transports millimeters everywhere** (matches the datasheet + the
> location-awareness convention); the cm↔mm ×10 conversion lives only inside the
> tuner-HTTP `ZoneWriter` (§3b).

### Zone model

- **3 configurable zones** (`zone_1`, `zone_2`, `zone_3`), plus the stock
  platform also models per-zone target counts. ([ESPHome ld2450][e1])
- **Zone type** is a 3-way `select`: **`Disabled` / `Detection` / `Filter`**.
  `Detection` = "presence counts only inside this region"; `Filter` = "ignore
  targets inside this region" (exclusion). ([ESPHome ld2450][e1])
- **Stock ESPHome zones are axis-aligned RECTANGLES** defined by two opposite
  corners: `zone_N x1,y1` (one corner) and `zone_N x2,y2` (the opposite),
  each a `number` entity. X1/X2 range −3000…3000 mm; Y1/Y2 range 0…6000 mm.
  ([ESPHome ld2450][e1]) — this is the model the Hearth editor uses (draggable
  rects).
- **FutureProof's custom tuner allows POLYGONS** (up to 8 points/zone) +
  a dedicated exclusion polygon ([radar_tuner_ld2450.html][f4]). The Hearth v1
  editor deliberately constrains to **rectangles** (2-corner) for both paths —
  simpler UX, and it's the lowest common denominator that maps cleanly to the
  stock entity model. (A polygon mode is an explicit non-goal for v1; §10.)

### How targets "count as present"

The radar firmware applies the zones: with a `Detection` zone defined, the
`zone_N target_count` / `has_target` reflect only targets inside it; `Filter`
zones subtract targets in that region. With all zones `Disabled`, presence is
the whole FOV. The editor's job is to let the user draw those regions on a
top-down room picture instead of typing eight mm numbers into HA sliders.

---

## 2. How the firmware exposes targets + zones (the decisive fork)

There are **two firmware shapes**, and the live device is the harder one.

### 2a. Stock ESPHome `ld2450` platform — entities over the native API

Build `config/satellite1.ld2450.yaml` does `satellite1_radar: !remove` and
includes `common/mmwave_ld2450.yaml`, which uses the **upstream ESPHome `ld2450`
platform** ([satellite1.ld2450.yaml][f5]; [ESPHome ld2450][e1]). That platform
exposes, as real native-API entities the coordinator can `subscribe_states` /
`number_command` / `select_command`:

| kind | entities (human `name:`) |
|---|---|
| sensor | `Target-1 X/Y/Speed/Angle/Distance/Resolution` (+ `-2`, `-3`); `Presence Target Count`, `Still Target Count`, `Moving Target Count`; `Zone-1/2/3 All/Still/Moving Target Count` |
| binary_sensor | `Presence`, `Moving Target`, `Still Target` |
| **number** | **`Zone-1 X1/Y1/X2/Y2`** (+ `-2`, `-3`) — the writable corners; `Timeout` (presence_timeout) |
| **select** | **`Zone Type`** (`Disabled`/`Detection`/`Filter`), `Baud rate` |
| switch | `Bluetooth`, `Multi Target Tracking` |
| button | `LD2450 Restart`, `LD2450 Factory Reset` |
| text_sensor | `Target-N Direction` (`Stationary`/`Moving away`/`Approaching`/`NA`) |

The coordinator's existing `ld2450.py` `parse_presence()` **already matches these
names** (`"Target-1 X"`, `"Zone-1 X1"`, presence/moving/still) by
case-insensitive substring. This is the *clean* path: zone writes are
`number_command(key, mm_value)` + `select_command(key, option)`.

### 2b. FutureProof custom `satellite1_radar` firmware — on-device HTTP tuner

The **default / live `.29` firmware** (`config/satellite1.yaml` →
`common/mmwave.yaml` → the `satellite1_radar:` component) is a custom C++
external component, NOT the stock platform ([mmwave.yaml][f1];
[satellite1.base.yaml][f2]). Reading its source settles the question:

- `radar_entities.h` declares dynamic **`Sensor` / `BinarySensor` /
  `TextSensor` / `Switch` / `Button`** classes — **and NO `Number` or `Select`
  class** ([radar_entities.h][f3]). So **the zone corners are NOT ESPHome entities
  on this firmware** — `number_command`/`select_command` have nothing to target.
- Instead, `radar_tuner_server.cpp` runs an **on-device HTTP server on port 80**
  (gated by the **`Radar Tuner WebUI`** switch in HA's Diagnostics —
  [presence-sensors docs][f6]) with a REST API ([radar_tuner_server.cpp][f7]):
  - `GET /api/v1/ld2450/config` — read zones
  - `PATCH /api/v1/ld2450/config` — write zones (`{"zones":[[{x,y},…],…],"exclusion":[…]}`, **cm**), returns `{"reboot_required":true|false}`
  - `GET /api/v1/ld2450/live` — poll targets: `{"targets":[{"x":…,"y":…},{…},{…}]}` (**cm, x/y only, no speed**)
  - `POST /api/v1/save` — flush to NVS; `POST /api/v1/reboot`
- The custom firmware **DOES still publish live target + presence data as
  ESPHome sensors** (the dynamic `Sensor`/`BinarySensor` in `radar_entities`,
  surfaced via `ld2450_handler.cpp`/`radar_entities.cpp`) — so the coordinator's
  `subscribe_states` path **gets live targets + presence on BOTH firmwares**.
  Only the *zone-write* surface differs (entities vs HTTP tuner).

**Consequence for the build:** the coordinator gains a `ZoneWriter` abstraction
with two impls (§3). Live VIEWER (Phase 1) works on the live firmware as-is via
`subscribe_states`. The EDITOR's write-back (Phase 2) on the live firmware goes
through the **tuner HTTP API** — which means **toggling the `Radar Tuner WebUI`
switch on** (the coordinator can flip it via `switch_command`) before a PATCH,
and a **reboot to persist** (a real UX cost — surfaced in the editor; §4). The
cleaner long-term option is to flash the **stock `ld2450` build** so zones become
entities (a config-only firmware swap, reversible) — recommended but **not
required** for v1 (§10 open question #1).

> The on-device tuner already IS a WYSIWYG zone editor — so why rebuild it in
> Hearth? Three reasons, all from §4 of the voice design: (1) it's polygon-only
> and visually raw; (2) it requires holding the device's HTTP port + a reboot and
> is divorced from Hearth's room model / presence-awareness; (3) the whole point
> of the ESP-direct move is that **Hearth owns the device** — a Hearth office is
> the cohesive surface (live dots + zones + calibration + the same ⚙ gear
> pattern as every other office), and it can layer Hearth concepts (named rooms,
> presence-arms-voice, location-awareness) the bare tuner can't. We *borrow* the
> tuner's proven coordinate transform (§5), not its UI.

---

## 3. The coordinator ↔ Hearth contract (live targets up, zones down)

The coordinator (`integrations/voice-coordinator/`) is the **only** process with
the device session (§8 concurrency). Two new responsibilities, both additive to
the existing files.

### 3a. Live targets UP — `device → coordinator → Hearth → SSE`

The coordinator already accumulates entity states in `coordinator.py`
`_on_device_state()` and calls `ld2450.parse_presence()` — but currently only
feeds the barge-in gate, with a `# (Phase 3) republish snap into a Hearth
presence store here` TODO. Implement that republish:

**Files/changes:**
- `integrations/voice-coordinator/ld2450.py` — extend `PresenceSnapshot` →
  `to_wire()` returning a JSON-ready dict: `present`, `moving`, `still`,
  `nearest_mm`, and `targets: [{index, x_mm, y_mm, speed_mms, angle_deg,
  distance_mm, active}]`. (The parsing already exists; just serialize it.)
- `integrations/voice-coordinator/hearth_client.py` — add
  `async def post_presence_targets(self, snapshot: dict) -> None` →
  `POST {base}/api/presence/targets` with the bearer. Fire-and-forget; swallow
  errors (presence is opportunistic, never load-bearing).
- `integrations/voice-coordinator/coordinator.py` — in `_on_device_state()`,
  after `parse_presence()`, **throttle** (the LD2450 is ~10 Hz; we don't need a
  POST per frame) to ≤ **4 Hz** via a monotonic-time gate + a "publish on
  meaningful change" rule (presence/zone-count flip publishes immediately; pure
  position jitter coalesces). Call `hearth.post_presence_targets(snap.to_wire())`.
- `integrations/voice-coordinator/config.py` — add `PresenceConfig`
  (`republish_hz` default 4.0, `enabled` default True) under
  `CoordinatorConfig`.

**Hearth side (`src/app/routes/presence.ts`, NEW):**
- `POST /api/presence/targets` — bearer-gated (same internal-bearer the
  coordinator uses for conversations). Zod-validate the snapshot, cache it
  **in-process** (a tiny `PresenceLiveCache` singleton keyed by device id; live
  targets are ephemeral — do NOT persist them to SQLite, mirroring the
  `WorkoutSessionTracker` ephemeral-ledger decision), and **emit the SSE event**:
  ```ts
  deps.events?.emit({ type: 'presence_targets', device_id, present, moving,
    still, nearest_mm, targets, captured_at });
  ```
- `GET /api/presence/state` — returns the cached live snapshot **+** the current
  zone config + room calibration (so a fresh page load paints immediately,
  before the first SSE frame; same "cached doc paints instantly, SSE keeps it
  live" contract as the rest of `/app`).

**SSE (`src/app/events.ts`):** add the `presence_targets` variant to the
`AppEvent` union (documented like the others). It is NOT tracked in
`active_streams`/`active_tool_calls` (those are turn-scoped) — it's a pure
fan-out signal. No replay-on-subscribe needed (the next ~250 ms frame refreshes
it; and `GET /api/presence/state` covers the cold-load case).

### 3b. Zones DOWN — the `ZoneWriter` abstraction

The editor saves a *desired* zone config to Hearth; the coordinator **pulls** it
and applies it to the device. Pull (not push) because the coordinator owns the
device session and may be mid-call / reconnecting — it applies when it safely
can, then acks. This mirrors the system's "writes are idempotent + the holder of
the resource performs them" posture.

**Hearth side (`src/app/routes/presence.ts`):**
- `POST /api/presence/zones` — **owner-gated** (`user.tier === 'owner'`, like the
  Code Shop gear). Body = the desired `ZoneConfig` (§7 store schema, mm). Persist
  to the `presence_zones` store with `status='pending'` + a monotonic
  `revision`. Audit `tool_name='presence_zones_update'` (the fact + which zones,
  never coords-as-secret — though zone rects aren't sensitive like live
  location). Return the stored config.
- `GET /api/presence/zones/pending` — bearer-gated (coordinator). Returns the
  latest `pending` config + its `revision`, or `{ pending: null }`.
- `POST /api/presence/zones/ack` — bearer-gated. Body `{ revision, applied:
  bool, reboot_required: bool, error?: string }`. Flips the row to
  `status='applied'` (or `'error'`), records `reboot_required`. Emits an SSE
  `presence_zones_acked` so the editor can show "✓ applied / ⟳ reboot needed".

**Coordinator side:**
- `integrations/voice-coordinator/zone_writer.py` (NEW) — the abstraction:
  ```python
  class ZoneWriter(Protocol):
      async def read_zones(self) -> ZoneConfig: ...
      async def write_zones(self, cfg: ZoneConfig) -> WriteResult: ...  # {applied, reboot_required}
  ```
  Two impls:
  - **`EntityZoneWriter`** (stock `ld2450` firmware) — maps each
    `zone_N x1/y1/x2/y2` → the entity key from `device._entities_by_key`
    (reverse-lookup by name substring, reusing `ld2450.py`'s matcher), calls
    `device.number_command(key, mm)` and `device.select_command(zone_type_key,
    option)`. `reboot_required=False` (entity writes are live). **Needs a new
    `DeviceConnection.number_command()/select_command()`** — thin wrappers over
    `aioesphomeapi`'s `APIClient.number_command(key, value)` /
    `select_command(key, option)` (sync client calls, like the existing
    `media_player_command`). Verify exact method signatures against the pinned
    `aioesphomeapi` in the container (it was not installed in the planning env;
    the README pins the version — confirm there).
  - **`TunerHttpZoneWriter`** (custom `satellite1_radar` firmware) — (1) flip the
    `Radar Tuner WebUI` switch on via `device.switch_command(key, True)`; (2)
    `PATCH http://<device_ip>:80/api/v1/ld2450/config` with the **cm**-converted
    rectangle expressed as the tuner's polygon shape (a rect = 4 points), reading
    back `reboot_required`; (3) `POST /api/v1/save`; (4) if reboot_required,
    surface it (do NOT auto-reboot mid-call — see §4); (5) flip the tuner switch
    back off. Converts mm→cm (÷10) at this boundary ONLY.
- `integrations/voice-coordinator/coordinator.py` — a periodic task (e.g. every
  10 s, and immediately on an SSE `presence_zones_update` if the coordinator also
  subscribes to events) calls `hearth.get_pending_zones()`; if a newer revision
  exists and the device session is healthy and **not mid-SPEAKING/LISTENING**,
  `zone_writer.write_zones()` then `hearth.ack_zones(revision, result)`. Pick the
  writer impl by probing the device entity set at enumerate time (zone `number`
  entities present → `EntityZoneWriter`, else `TunerHttpZoneWriter`).
- `config.py` — `ZoneWriteConfig`: `tuner_http_port` (80), `mode`
  (`auto`/`entity`/`tuner`, default `auto`), `auto_reboot_after_write` (default
  **False** — a reboot drops the voice session; the user triggers it explicitly).

> **Why not let the web pane PATCH the tuner directly?** Because of §8: the
> device session is single-holder. While the coordinator holds the native API
> session for voice, the device's HTTP tuner is still reachable on port 80 (it's
> a separate server) — but routing zone writes through Hearth keeps ONE source of
> truth (the `presence_zones` store), keeps the web pane device-agnostic, gives
> us audit + owner-gating + the entity-path option for free, and avoids the pane
> needing the device IP / CORS. The contract is web → Hearth → coordinator →
> device, full stop.

---

## 4. The web office — `pane_kind: 'presence'`

Mirrors the Code Shop office end-to-end: a registry `pane_kind`, a
`compose_presence_pane()`, an owner-gated ⚙ gear, and a custom interactive block
rendered in `app.js`. The **canvas itself is NOT a server-composed block** — it's
a client-rendered surface keyed off `pane_kind === 'presence'`, exactly as the
Code Shop's settings modal is client logic keyed off `pane_kind === 'codeshop'`.

### 4a. Backend: the pane composer

**`src/core/specialist.ts`** — add `'presence'` to the `pane_kind` z.enum.

**`src/core/specialist_pane.ts`:**
- Add `'presence'` to the `PaneKind` union.
- `compose_presence_pane(db, user_id, deps): PaneDocument` — composes the
  *non-canvas* furniture (the canvas is client-side; these blocks frame it):
  - a `hero_metric` — "Present" / "Empty", label = nearest target distance or
    "no one in view" (read from the in-process `PresenceLiveCache` via a getter
    on `deps`, or just render a placeholder the SSE fills — the canvas is the
    live surface, so this is a static-at-compose glance);
  - a `text` block with the room name + zone summary ("3 zones · Zone 1
    Detection, Zone 2 Filter");
  - a `list` of zones (name, type, corner extents in mm→human "1.2 m × 0.8 m")
    with `detail_md` per row;
  - returns `{ pane_kind: 'presence', title: "Presence", subtitle: "<device> ·
    <room>", blocks, generated_at }`.
- Add `case 'presence': return compose_presence_pane(db, user_id, deps);` to
  `compose_pane()`'s switch (the exhaustiveness `never` check forces this).

**`src/app/routes/presence.ts` (NEW)** — all the §3 routes, wired with
`deps.events`, `deps.db`, `deps.users`, `deps.memory`, the bearer check helper,
and the owner check. Register in `apps/orchestrator/server.ts` via
`app.route('/api/presence', create_presence_router({ db, events: app_events,
users: users_registry, memory }))`.

> **⚠ nginx (CLAUDE.md "API mount topology"):** `/api/presence/*` is a NEW
> top-level `/api/<namespace>/`. It MUST be added to the
> `location ~ ^/api/(...)` alternation in `/docker/nginx/locations.conf` on
> the LLM host or it falls through to Home Assistant's catch-all and 404s. Apply with
> `docker restart nginx` (single-file bind mount; `nginx -s reload` re-reads the
> stale inode). Validate with `docker exec nginx nginx -t` first.

### 4b. Frontend: the canvas room view (`app.js`)

`app.js` already uses `<canvas>` (the liquid-glass displacement maps) and is a
no-bundler ES module — the room view is the same toolkit. In `_pane_header()`,
add a `presence` gear (copy the `codeshop` branch → `open_presence_settings_modal`).
In `render_pane()` / a new `render_presence_canvas(doc)` keyed off
`doc.pane_kind === 'presence'`, mount the canvas + controls:

**The live VIEWER:**
- A `<canvas>` sized to the office body (ResizeObserver re-renders on reflow,
  like the LG filters). A top-down room: sensor at the **apex** (top-center),
  Y increasing **downward** = distance away, X spanning **left/right signed**.
- Draw, every frame: the **±60° FOV cone** (two rays from the apex), **range
  arcs** at 1/2/3/4/5/6 m, the **zone rectangles** (colored by type:
  Detection = accent, Filter = warn-red hatch, Disabled = faint), and up to **3
  live target dots** with a short **trail** (last ~6 positions) and a **speed
  vector** (a short line from the dot along its velocity). Render the
  `present`/moving/still counts in a corner badge.
- **Data source:** subscribe to the existing `/app/api/events` SSE (the client
  already holds this connection — `app.js` has the EventSource/stream consumer).
  On `presence_targets`, update an in-memory target buffer + repaint via rAF.
  On cold load, `GET /api/presence/state` paints the first frame (cached snapshot
  + zones + calibration) so the canvas is never empty waiting for SSE.

**The WYSIWYG EDITOR (toggle "Edit zones" in the pane):**
- Each of the 3 zones is a **draggable + resizable rectangle** (8 handles +
  body-drag), drawn in canvas px, edited in px, **stored/sent in mm** via the
  `pxToMm`/`mmToPx` transform (§5). A per-zone `zone_type` segmented control
  (`Disabled`/`Detection`/`Filter`) and a color/name from the gear.
- **Snapping:** optional grid (e.g. 100 mm) + edge-snap to the FOV cone, toggled
  in the gear. Constrain corners to the legal box (X −3000…3000, Y 0…6000); clamp
  on drag so you can't author an out-of-range rect.
- **Save** → `POST /api/presence/zones` with the mm `ZoneConfig`.
  **Optimistic UI:** the rect stays where dropped immediately; show a "saving…"
  chip. On the `presence_zones_acked` SSE, confirm "✓ applied" or "⟳ reboot
  needed to take effect" (custom-firmware path) with a **"Reboot device"** button
  that calls a coordinator-proxied reboot (a `POST /api/presence/reboot`,
  owner+PIN-gated, since a reboot drops the voice session — make the cost
  explicit). Read-back: after ack, re-`GET /api/presence/zones` to confirm the
  device's actual stored rect matches (the tuner can clamp/round).
- **Read-only fallback:** if `GET /api/presence/state` reports the coordinator
  has **no device session** (HA holds it — §8), the editor renders **disabled**
  with a banner "Live presence is owned by Home Assistant right now — viewer and
  editor are unavailable until Hearth holds the device." The viewer also shows
  the last-known cached snapshot greyed-out. Never silently fail.

### 4c. The ⚙ gear — `open_presence_settings_modal` + the store

Copy `open_codeshop_settings_modal` (`app.js`) → a presence modal posting to
`POST /api/presence/settings`. Owner-only (both route + the gear only renders for
`viewer_is_owner`). Fields → the `presence_zones` store (§7):

- **Room:** `room_name`, `room_width_mm`, `room_depth_mm`.
- **Canvas scale:** `px_per_m` (or "fit to range" auto).
- **Sensor mount:** `mount_x_offset_mm` (sensor not centered on the wall),
  `mount_rotation_deg` (sensor rotated/tilted), `mount_height_mm` (informational).
- **Per-zone presentation:** `zones[i].name`, `zones[i].color`.
- **Snap:** `snap_grid_mm`, `snap_enabled`.

**Secret-free, owner-global** — same posture as `codeshop_settings.ts` (this
store has no secrets at all, which is *simpler*, but follow the same
redacted-GET / audit-the-keys / never-LLM-readable discipline so the pattern
stays uniform). The GET returns the full config (nothing to redact). Mirror the
`CodeShopSettings` class shape (CREATE TABLE IF NOT EXISTS in the constructor,
`get()`/`set(patch)`).

---

## 5. The coordinate transform (mm ↔ canvas px)

Borrowed from FutureProof's proven tuner ([radar_tuner_ld2450.html][f4]), adapted
to mm + a configurable mount. Their core (in cm):

```js
cx = W/2; cy = 20*dpr; scale = min(W,H)*0.0013;     // their cm→px
cmToCanvas(x,y) = [cx + x*scale, cy + y*scale];      // +X right, +Y down(=away)
canvasToCm(px,py) = [(px-cx)/scale, (py-cy)/scale];
```

Hearth's version (mm, mount-aware). Let `px_per_mm = px_per_m / 1000`
(from the gear, or auto-fit: `px_per_mm = (H - 2*pad) / 6000` to fit 6 m of
range, then `cx/cy` from there):

```js
// apex (sensor) position on canvas
const apex_x = W/2 + mount_x_offset_mm * px_per_mm;
const apex_y = pad;                       // sensor at top
const θ = mount_rotation_deg * Math.PI/180;

function mmToPx(x_mm, y_mm) {
  // apply mount rotation about the sensor, then scale, +X right / +Y down(away)
  const xr = x_mm*Math.cos(θ) - y_mm*Math.sin(θ);
  const yr = x_mm*Math.sin(θ) + y_mm*Math.cos(θ);
  return [apex_x + xr*px_per_mm, apex_y + yr*px_per_mm];
}
function pxToMm(px, py) {
  const xr = (px - apex_x)/px_per_mm;
  const yr = (py - apex_y)/px_per_mm;
  const x_mm =  xr*Math.cos(θ) + yr*Math.sin(θ);   // inverse rotation
  const y_mm = -xr*Math.sin(θ) + yr*Math.cos(θ);
  return [x_mm, y_mm];
}
```

- **FOV cone:** two rays from `(apex_x,apex_y)` at ±60° from the +Y(down,
  rotated) axis, length = 6000 mm → px. `dir(±60°)` = rotate the +Y unit vector
  by `θ ± 60°`.
- **Range arcs:** arcs centered on the apex at radii `{1000…6000} mm * px_per_mm`,
  clipped to the cone. Label each "1 m … 6 m".
- **Zone rect:** four corners `(x1,y1),(x2,y1),(x2,y2),(x1,y2)` each through
  `mmToPx`. When the mount is rotated the "rect" renders as a rotated quad — fine,
  because the *radar's* zone is axis-aligned in the radar's own frame, and we draw
  the radar frame rotated to match the room. (Editing happens in radar-frame mm
  via `pxToMm`, so the stored corners stay axis-aligned and legal.)
- **Target dot:** `mmToPx(t.x_mm, t.y_mm)`; trail = last N positions; speed
  vector = a short segment toward `mmToPx(t.x_mm + t.speed_x, t.y_mm +
  t.speed_y)` (decompose `speed_mms` along the target's `angle_deg`, or — since
  the stock platform gives per-target `speed` as a scalar toward/away — draw it
  radially from the apex).

> **Sign discipline (the bug-prone bit):** X is signed (−left/+right), Y is
> positive-away. Keep ALL internal math in mm in the radar frame; convert to px
> only for drawing and back to mm only on pointer events. The §10 risk note
> reiterates: a flipped X sign or a cm/mm ×10 error puts zones in the wrong half
> of the room — assert with the live dots (a person walking left should move the
> dot left).

---

## 6. End-to-end data flow (named artifacts)

**Live targets (Phase 1):**
```
LD2450 (10 Hz)
 → satellite1_radar / ld2450 platform publishes target sensors
 → coordinator device.py _subscribe_states → on_state → coordinator.py _on_device_state
 → ld2450.py parse_presence() → PresenceSnapshot.to_wire()
 → THROTTLE ≤4 Hz → hearth_client.post_presence_targets()
 → POST /api/presence/targets  (presence.ts; bearer)
 → PresenceLiveCache.set(device_id, snap) + events.emit('presence_targets')
 → /app/api/events SSE → app.js EventSource → target buffer → rAF repaint canvas
```

**Zone write (Phase 2):**
```
app.js editor drag → POST /api/presence/zones {ZoneConfig mm}  (owner)
 → presence_zones store: status='pending', revision++  (presence.ts)
 → coordinator poll GET /api/presence/zones/pending  (bearer)
 → zone_writer.write_zones(cfg):
      EntityZoneWriter:  device.number_command(zone_N_x1_key, mm) ×12 + select_command(zone_type)   [stock fw]
      TunerHttpZoneWriter: switch_command(tuner,on) → PATCH :80/api/v1/ld2450/config {cm} → POST save  [custom fw]
 → POST /api/presence/zones/ack {revision, applied, reboot_required}  (bearer)
 → presence_zones store status='applied' + events.emit('presence_zones_acked')
 → app.js confirms "✓ applied" / "⟳ reboot needed"
```

**Files to ADD:**
- `src/app/routes/presence.ts` — the `/api/presence/*` router.
- `src/memory/stores/presence_zones.ts` — the store (zones + room calibration).
- `integrations/voice-coordinator/zone_writer.py` — the `ZoneWriter` abstraction
  + two impls.
- `scripts/smoke-presence.ts` — exercises the routes (targets POST → SSE; zones
  POST → pending → ack lifecycle; owner-gating; bearer-gating).

**Files to CHANGE:**
- `src/core/specialist.ts` — `pane_kind` enum += `'presence'`.
- `src/core/specialist_pane.ts` — `PaneKind` += `'presence'`; `compose_presence_pane()`;
  `compose_pane()` switch case.
- `src/app/events.ts` — `AppEvent` += `presence_targets`, `presence_zones_acked`.
- `src/app/client/app.js` — `presence` gear branch; `render_presence_canvas()`;
  `open_presence_settings_modal()`; SSE handler for the two new events.
- `src/app/client/app.css` — canvas + zone-handle + editor-toolbar styles.
- `apps/orchestrator/server.ts` — `app.route('/api/presence', …)`.
- `integrations/voice-coordinator/ld2450.py` — `PresenceSnapshot.to_wire()`.
- `integrations/voice-coordinator/hearth_client.py` — `post_presence_targets()`,
  `get_pending_zones()`, `ack_zones()`.
- `integrations/voice-coordinator/device.py` — `number_command()`,
  `select_command()`, `switch_command()` wrappers; expose `_entities_by_key`
  reverse-lookup.
- `integrations/voice-coordinator/coordinator.py` — presence republish (throttled)
  + the pending-zone poll/apply/ack task; writer selection at enumerate time.
- `integrations/voice-coordinator/config.py` — `PresenceConfig`, `ZoneWriteConfig`.
- A new specialist YAML (or an existing device/voice specialist) gets
  `pane_kind: presence` (§9).
- `/docker/nginx/locations.conf` (the LLM host) — add `presence` to the `/api/(...)`
  alternation.

---

## 7. Store schema — `presence_zones.ts`

Self-contained store (CREATE TABLE IF NOT EXISTS in the constructor, like
`codeshop_settings.ts` / the Kristi stores — NOT in central `SCHEMA_SQL`).
Owner-global per device; v1 a single device, but key by `device_id` so
multi-device is a row, not a migration.

```ts
// one row per device
interface PresenceDeviceConfig {
  device_id: string;            // 'satellite1' (HEARTH_VC_DEVICE_NAME)
  // room calibration (the gear)
  room_name: string;            // 'Living room'
  room_width_mm: number;        // for the canvas frame
  room_depth_mm: number;
  px_per_m: number | null;      // null ⇒ auto-fit 6 m
  mount_x_offset_mm: number;    // sensor offset from wall center
  mount_rotation_deg: number;
  mount_height_mm: number;      // informational
  snap_grid_mm: number;         // 0 ⇒ off
  snap_enabled: boolean;
  // the zones (mm, radar frame, axis-aligned rects)
  zones: Array<{
    index: 1 | 2 | 3;
    name: string;               // 'Couch', 'Doorway'
    color: string;              // presentation only
    type: 'Disabled' | 'Detection' | 'Filter';
    x1_mm: number; y1_mm: number; x2_mm: number; y2_mm: number;
  }>;
  // write lifecycle
  revision: number;             // bumped on every editor save
  status: 'pending' | 'applied' | 'error';
  reboot_required: boolean;     // last write needed a reboot (custom fw)
  last_error: string | null;
  updated_at: string;           // ISO 8601 UTC
}
```

Methods: `get(device_id)` (defaults merged), `set_zones(device_id, zones)` (bumps
revision, status='pending'), `set_calibration(device_id, patch)`,
`get_pending(device_id)`, `ack(device_id, revision, {applied, reboot_required,
error})`. Store `zones` as a JSON column (same `config_json` shape as
`codeshop_settings`). **Columns additive; no `SCHEMA_VERSION` bump.**

> The two stores (zones + room calibration) are deliberately ONE store/table —
> they're per-device, owner-global, and always read together by the pane. (The
> §1 of the task brief named them as two; collapsing to one row avoids a JOIN and
> matches the Code Shop's single-row precedent.)

---

## 8. Concurrency dependency — the coordinator must hold the device

This feature **requires the Voice Coordinator to hold the device's native-API
session** (it's the only path to live targets + entity zone writes). From the
voice design §3: **"the device's Noise login FAILS while HA holds the session —
HA and the coordinator can't both hold an authenticated session to the same
device."** So:

- **Coordinator holds the session (post-handoff / dev-kit):** full feature —
  live viewer + editor work.
- **HA holds the session (today, on `.29`):** the coordinator's
  `device.connected == False`. `GET /api/presence/state` reports
  `device_connected: false`; the viewer shows last-known cached data greyed-out
  and the editor is **disabled with the §4b banner**. **No silent failure, no
  crash** — the coordinator already degrades to standby (`coordinator.py` logs
  "no device session — running in standby"); presence republish + zone-apply
  simply don't fire until a session is acquired.
- **The custom-firmware tuner HTTP port (80) is a SEPARATE server** from the
  native API — so in principle a zone PATCH could go direct even while HA holds
  the native session. We deliberately **do not** do that in v1: it splits the
  source of truth and bypasses owner-gating/audit. The contract stays web →
  Hearth → coordinator. (If a "zones without taking the device off HA" mode is
  ever wanted, it's a `TunerHttpZoneWriter` that doesn't need the native session
  — a clean future extension, noted in §10.)

This is why the feature **phases behind** the voice-coordinator handoff:
Phase 1 (viewer) is best demoed on the **dev-kit / 2nd device** the coordinator
owns; the live `.29` viewer lights up once the §5-design AEC handoff moves `.29`
off HA. The editor (Phase 2) likewise.

---

## 9. Which specialist owns the office?

Options, recommended first:
1. **A dedicated device/voice specialist** (e.g. extend Hazel, or a new `home`/
   `sentry` persona) with `pane_kind: presence`. The presence office is about the
   *physical space + the voice device*, which is Hazel/voice territory. Clean
   conceptual home; the chat surface below the pane can answer "is anyone in the
   living room?" from the same `PresenceLiveCache`.
2. **Iris** — she already consumes `get_current_location` and owns spatial/route
   context; presence-in-the-home is adjacent. But Iris is EV/travel-flavored;
   presence is a stretch.
3. **A new minimal specialist** `presence`/`home` whose ONLY job is this office
   (like Linda↔resale, Kristi↔competitive). Cleanest separation; one more YAML.

**Recommendation: option 1 if a voice/home specialist exists post-coordinator,
else option 3.** Either way it's a YAML edit (`pane_kind: presence` + the
specialist's `granted` capabilities; the office reads need no special tool
capability since the data flows over `/api/presence/*`, not a specialist tool).
Per CLAUDE.md, no restart — `SpecialistRegistry` hot-reloads the YAML.

---

## 10. Phasing

- **Phase 1 — live VIEWER (read-only).** Coordinator presence republish (§3a) +
  `POST /api/presence/targets` + `presence_targets` SSE + the canvas viewer (FOV,
  arcs, live dots, counts) + `GET /api/presence/state`. Demo on the **dev-kit**
  (coordinator owns it). **No device writes — zero risk.** This alone is "better
  than HA" (a real-time top-down room view Hearth-native).
- **Phase 2 — WYSIWYG EDITOR (zone write-back).** The `presence_zones` store +
  zone POST/pending/ack routes + the `ZoneWriter` abstraction (both impls) + the
  draggable-rect editor + optimistic UI + read-back. Start with
  `EntityZoneWriter` against a **stock-`ld2450`-firmware** dev-kit (entity writes
  are live, no reboot — the easy path to prove the loop), then add
  `TunerHttpZoneWriter` for the custom firmware.
- **Phase 3 — ⚙ settings + polish.** The gear modal (room size, scale, mount
  offset/rotation, zone names/colors, snapping), trails + speed vectors, the
  reboot-to-persist affordance, the read-only/unavailable states.
- **iOS parity:** web office ships first. iOS already routes to a room on raw
  `pane_kind` and renders typed blocks, but the **canvas is a custom interactive
  surface with no existing `HearthCardPrimitives` block** — so iOS needs a native
  `PresenceRoomView` (SwiftUI Canvas) added in `hearth-ios`, consuming the SAME
  `/api/presence/*` + SSE. That's a follow-up iOS pass (mirror the touches in
  `../hearth-ios/ARCHITECTURE.md` + `CLAUDE.md` per the cross-repo rule); the
  backend contract is built once and serves both.

---

## 11. Open questions / risks

**Top 3 open questions:**

1. **Does the live `.29` (custom `satellite1_radar`) firmware publish the
   per-target X/Y/speed sensors over the native API, or only the
   presence/count + the text "Radar Detected"?** Reading `radar_entities.h`
   confirms it registers dynamic `Sensor`s (so likely yes), and the device
   already shows `radar_targets_total/moving/still` + `radar_target` (state) in
   HA — but the *per-target x/y/speed/angle* numeric sensors may be
   `disabled_by_default` (the header has a `disabled_by_default` bit) or only
   present on the stock build. **Resolve by enumerating entities once the
   coordinator holds the session** (`device.py _enumerate_entities` already logs
   them at DEBUG — grep for "Target-1 X"). If they're absent/disabled on the
   custom firmware, Phase-1 live dots fall back to the **tuner's
   `GET /api/v1/ld2450/live` poll** (cm, x/y only — no speed vector) via the
   coordinator, OR flash the stock `ld2450` build. This is the single biggest
   "confirm against the real device" item.

2. **Entity-write vs tuner-HTTP-write on the live device — and is the
   reboot-to-persist acceptable?** The custom firmware's zone write needs a
   reboot (drops the voice session); the stock build's entity writes are live.
   Is flashing `satellite1.ld2450.yaml` (stock `ld2450`, a reversible config-only
   firmware swap that turns zones into entities and removes the reboot cost) the
   right call for the editor — at the price of losing the custom firmware's
   on-device tuner + any `satellite1_radar`-specific tuning? **Recommend testing
   the entity path on a dev-kit first; decide on the live device after.**

3. **The existing FutureProof tuner already does this (polygon editor on
   port 80) — reuse vs replace?** We replace the *UI* (Hearth office, rects, room
   model, live integration) but **reuse the proven coordinate transform + the
   tuner REST API as one `ZoneWriter` backend.** Is rectangle-only (vs the
   tuner's 8-point polygons) sufficient for the household's rooms, or is polygon
   support needed in v1? **Assumption: rectangles suffice for v1** (couch /
   doorway / desk are rect-shaped); polygon mode is a deliberate non-goal.

**Other risks:**
- **Refresh-rate vs SSE flood.** 10 Hz × per-frame POST/SSE would be chatty.
  Mitigated by the coordinator-side ≤4 Hz throttle + publish-on-meaningful-change
  (§3a). The canvas repaints on rAF regardless, interpolating between frames.
- **Coordinate sign / unit bugs.** Flipped X or a cm/mm ×10 error mislocates
  everything. Mitigation: ONE internal unit (mm), conversion only at the
  tuner-HTTP boundary; validate live (walk left → dot left); the §5 transform is
  the single source.
- **Coordinator not holding the session** (HA does) → read-only/unavailable, by
  design (§8). Not a failure; a documented degrade.
- **Owner-gating + audit.** Zone writes + settings are owner-only (route + gear);
  audited by key, not value. Live presence in the home IS privacy-sensitive — but
  it's NOT location-awareness data (no GPS, no cross-user reach); it stays in the
  ephemeral `PresenceLiveCache` (not persisted), and the office is gated to the
  owner. Do not add presence to any cross-specialist sharing surface without the
  same deliberate review `read_my_location_granted_to` gets.
- **Multi-device.** Schema keys by `device_id` from day one so a second
  Satellite1 is a row + a second coordinator `DeviceConnection`, not a migration.

---

## Sources

**LD2450 hardware / protocol:**
- [m1] Hi-Link HLK-LD2450 Instruction Manual — https://www.tinytronics.nl/product_files/006000_HLK-LD2450-Instruction-Manual.pdf
- [m2] HLK-LD2450 Serial Communication Protocol v1.03 — https://make.net.za/wp-content/datasheets/HLK%20LD2450%20Serial%20Communication%20Protocol%20v1.03.pdf
- [m3] Hi-Link HLK-LD2450 product page — https://www.hlktech.net/index.php?id=1157

**ESPHome stock `ld2450` platform (entity names + ranges + zone_type):**
- [e1] ESPHome LD2450 Sensor component — https://esphome.io/components/sensor/ld2450/

**FutureProof Satellite1-ESPHome firmware (the custom `satellite1_radar` fork):**
- [f1] config/common/mmwave.yaml — https://raw.githubusercontent.com/FutureProofHomes/Satellite1-ESPHome/develop/config/common/mmwave.yaml
- [f2] config/satellite1.base.yaml — https://raw.githubusercontent.com/FutureProofHomes/Satellite1-ESPHome/develop/config/satellite1.base.yaml
- [f3] esphome/components/satellite1_radar/radar_entities.h (declares Sensor/BinarySensor/TextSensor/Switch/Button — NO Number/Select) — https://raw.githubusercontent.com/FutureProofHomes/Satellite1-ESPHome/develop/esphome/components/satellite1_radar/radar_entities.h
- [f4] esphome/components/satellite1_radar/tuner_ui/radar_tuner_ld2450.html (the existing WYSIWYG tuner — coordinate transform + live poll + save payload borrowed here) — https://raw.githubusercontent.com/FutureProofHomes/Satellite1-ESPHome/develop/esphome/components/satellite1_radar/tuner_ui/radar_tuner_ld2450.html
- [f5] config/satellite1.ld2450.yaml (the stock-`ld2450` build variant; `satellite1_radar: !remove`) — https://raw.githubusercontent.com/FutureProofHomes/Satellite1-ESPHome/develop/config/satellite1.ld2450.yaml
- [f6] FutureProof presence-sensors docs (the Radar Tuner WebUI: on-device, port 80, gated by the "Radar Tuner WebUI" Diagnostics switch) — https://docs.futureproofhomes.net/satellite1-presence-sensors/
- [f7] esphome/components/satellite1_radar/radar_tuner_server.cpp (the on-device REST API: `/api/v1/ld2450/config` PATCH, `/api/v1/ld2450/live` poll, reboot_required) — https://raw.githubusercontent.com/FutureProofHomes/Satellite1-ESPHome/develop/esphome/components/satellite1_radar/radar_tuner_server.cpp

**Hearth patterns mirrored (in-repo):**
- `src/core/specialist_pane.ts` (`compose_codeshop_pane`, `compose_pane` dispatch, `PaneDocument`/`PaneBlock`)
- `src/memory/stores/codeshop_settings.ts` (single-row owner-global settings store)
- `src/app/client/app.js` (`render_pane`, `_pane_header` gear branch, `open_codeshop_settings_modal`, canvas usage)
- `src/app/events.ts` + `src/app/router.ts` `/api/events` (the SSE bus + variant pattern)
- `src/app/routes/specialists.ts` (`/specialists/:id/pane` route, `/codeshop/settings` owner-gated GET/POST)
- `apps/orchestrator/server.ts` (`app.route('/api/<ns>', …)` mount pattern)
- `integrations/voice-coordinator/{device,coordinator,ld2450,hearth_client,config}.py` (the device session, state subscription, `parse_presence`, the `# (Phase 3) republish` seam, `media_player_command`)
- The voice design's §4 scoping + §8 concurrency: [design-esp-direct-voice.md](design-esp-direct-voice.md)
