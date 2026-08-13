# Design — BLE room presence (the device-bound identity layer)

**Status:** design (not built). 2026-06-15. Owner-directed. This is the detailed
**P3** plan of the Household Awareness Layer
([design-household-awareness-layer.md](design-household-awareness-layer.md) §3a, §8).
Scrum: roadmap epic `sep_whxtd5fgbqtt`.
**Hardware ordered:** 2× **M5Stack Atom Lite** (ESP32-PICO) — the POC nodes.
**Builds on (live today):** the `home_map` store + its `ble_areas` overlay field
([home_map.ts](../src/memory/stores/home_map.ts)), `get_household_occupancy`
([client.ts](../src/memory/client.ts)), the HA connector's `fetch_ha_state(entity_id)`
([home_assistant.ts](../src/connectors/home_assistant.ts), `HA_BASE_URL` + `HA_TOKEN`),
the enrolled-faces roster ([structured.ts](../src/memory/stores/structured.ts)
`enrolled_persons`), and Luna's Home office + Cassandra's People room.

---

## 1. Why this layer exists — the gap it fills

P1/P1.5 occupancy is **face-recognition-based**, and we just hit its wall live: a
person standing in the **Garage** is *person-detected* by the camera but produces
**no face sighting** (the G4 dome is too high/oblique to capture a croppable face),
so occupancy shows nothing. Face is a **sparse anchor** that only fires at the one
good face-cam (the doorbell). The two threads that carry identity into face-blind
rooms are **body re-ID (P2)** and **BLE (this doc, P3)**.

BLE is the **device-bound identity** signal: *"Jasper's iPhone is in the Garage."* It
is the one signal that:
- **covers camera-blind rooms** (garage, halls, bedrooms) the cameras can't,
- carries a **strong, named identity** (the device is bound to a person) without a
  face hit,
- runs **continuously + cheaply** (server-side; zero phone battery cost).

Its honest failure mode (§7): it tracks the **device, not the person** — a phone on
the kitchen counter reads "kitchen." So BLE is a **strong prior fused with** face +
body + camera, never a sole proof. But for "is Jasper home and roughly where," when
his phone is on him, it's the most reliable signal we have — and it directly fixes
the Garage gap.

## 2. The chain (device → proxy → HA → Hearth → occupancy)

```
iPhone / Apple Watch (rotating BLE MAC, RPA)
   │  BLE advertisements
   ▼
M5Stack Atom Lite ×N  — ESPHome bluetooth_proxy (one per room, bound to an HA Area)
   │  forwards adverts over the ESPHome API
   ▼
Home Assistant
   ├─ Private BLE Device (HA core)  — resolves the rotating MAC via the device's IRK
   └─ Bermuda (HACS)               — per-device nearest-Area decision from proxy RSSI
   │     → sensor.<device>_area  (state = HA Area name, e.g. "Garage")
   ▼  GET /api/states/<entity>  (Bearer token)  — OR  WS subscribe_events state_changed
Hearth orchestrator
   ├─ ble_devices store      device(IRK/HA entity) → enrolled_person   (the grouping)
   ├─ HA Area → room_id      via home_map.rooms[].ble_areas (the overlay, already exists)
   ├─ beacon_readings cache  latest room per device (ephemeral, PresenceLiveCache-style)
   ▼
get_household_occupancy  — BLE fused with face/body/iOS-home-away → occupancy state
   ▼
Cassandra people-awareness  +  Luna's household Home office (named map)
```

**Key contract:** HA owns the radio + the trilateration/area decision (Bermuda);
**Hearth reads the resolved `device → HA Area`**, maps Area → room via the home_map
overlay, binds device → person via `ble_devices`, and fuses. Hearth never talks to
the ESP32s.

## 3. Hardware + firmware — the Atom Lite nodes

The Atom Lite **works** for a POC but is the **weak** ESP32 for this job: classic
ESP32-PICO, **PCB trace antenna (no external-antenna connector)**, single-radio
WiFi/BLE coexistence. Rules from the research:

- **Standardize on identical boards.** Bermuda's area decision is *relative* RSSI;
  RSSI offsets are per-hardware. Two identical Atom Lites is good — don't mix an
  ESP32-S3 in later without recalibrating.
- **Keep the firmware single-purpose.** BLE proxy already near the Atom Lite's RAM
  ceiling — no audio/extra components, or boot loops.
- **Active scanning ON, 320 ms / 300 ms** (the WiFi-board duty cycle; the tight
  `1000/1000` is for Ethernet boards only).
- **ESPHome ≥ 2025.5**, board `m5stack-atom`, framework `esp-idf`. Flash once over
  USB-C via web.esphome.io, then OTA.

```yaml
# atom-<room>.yaml — one per room (atom-garage, atom-office, …)
esphome:
  name: atom-garage
  friendly_name: BT Proxy Garage
esp32:
  board: m5stack-atom
  framework: { type: esp-idf }
api:
  encryption: { key: !secret api_encryption_key }
ota: [{ platform: esphome }]
wifi:
  ssid: !secret wifi_ssid
  password: !secret wifi_password
esp32_ble_tracker:
  scan_parameters: { interval: 320ms, window: 300ms, active: true }
bluetooth_proxy:
  active: true
```

**Placement beats calibration on these boards:** central in the room, off metal,
away from the WiFi AP. If you scale past ~3–4 rooms or want reliable Watch tracking,
move to ESP32-S3 / external-antenna boards (e.g. XIAO ESP32-C6) and recalibrate.

## 4. The HA layer — Bermuda + Private BLE Device + IRK

1. **Flash both Atom Lites**, adopt into the ESPHome add-on, and **assign each
   ESPHome device to its HA Area** (Garage, Office, …) — Bermuda keys off the
   proxy's Area.
2. **Get each person's device IRK** (defeats Apple's MAC rotation). Best paths:
   **macOS Keychain** (`Remote IRK`, base64, same iCloud as the phone/watch) or the
   **DuckDuck25 / DerekSeaman ESP32 "IRK capture"** ESPHome package (pair the phone
   to the broadcast device, copy the IRK).
3. **HA → Add Integration → Private BLE Device**, paste the IRK (base64 or hex). The
   device must be powered on + in range during setup (HA validates against a live
   advert). Creates a `device_tracker` (home/away) + estimated distance.
4. **Install Bermuda (HACS).** It auto-detects Private BLE Device entries and tracks
   them by IRK; per device it creates a **Area sensor** whose **state = the HA Area
   name** ("Garage"), a `device_tracker`, and (disabled-by-default) per-proxy
   distance sensors. **One proxy per room is enough for area-level** — 3+ only
   matters for distance/trilateration, which this layer does not need.
5. **Read the exact area-sensor `entity_id` from Developer Tools → States** after
   setup — the slug is partly user-determined (`sensor.<device>_area` vs
   `…_bermuda_area`); **do not hardcode it**, store it on the `ble_devices` row.

**Honest caveats (bake into the UX):** iPhone is reliable; **Apple Watch is jumpy**
(power-saving → sparse bursty adverts → wild distance) — track the phone as primary,
the watch as best-effort. Private BLE Device has **slow away-detection + no
`consider_home`** — Hearth debounces home/away itself (§6d).

## 5. The unified person identity — "grouping devices into face/body detection"

The thing you asked for: BLE devices become part of the **same person identity** the
face (and later body re-ID) resolve to. `enrolled_persons` is already that anchor
(today: `cpai_userid` = the face). We add a sibling table so one **Person** =
**{ face (CPAI) + BLE devices + body signatures (P2) }**:

```ts
// src/memory/stores/structured.ts — additive; no SCHEMA_VERSION bump
// One row per BLE device, FK to the enrolled person (the unified identity).
CREATE TABLE IF NOT EXISTS ble_devices (
  id TEXT PRIMARY KEY,                  // 'bd_xxxxxx'
  user_id TEXT NOT NULL,                // owner scope
  enrolled_person_id TEXT NOT NULL,     // FK enrolled_persons.id — the SAME person as the face
  kind TEXT NOT NULL                    // 'phone' | 'watch' | 'tag'
    CHECK (kind IN ('phone','watch','tag')),
  label TEXT,                           // "Jasper's iPhone"
  ha_area_entity TEXT NOT NULL,         // the Bermuda area sensor entity_id (read from Dev Tools)
  ha_tracker_entity TEXT,               // the Private BLE Device device_tracker (home/away + distance)
  irk_fingerprint TEXT,                 // a NON-secret hash of the IRK for dedup/debug — NOT the IRK
  reliability TEXT NOT NULL DEFAULT 'primary'  // 'primary' (phone) | 'best_effort' (watch)
    CHECK (reliability IN ('primary','best_effort')),
  ts_created TEXT NOT NULL,
  ts_updated TEXT NOT NULL,
  UNIQUE (user_id, ha_area_entity)
);
```

> **The IRK itself lives in Home Assistant, not Hearth.** HA's Private BLE Device
> holds the secret; Hearth only references the resolved HA *entities* + a non-secret
> fingerprint. Same posture as the Code Shop secrets rule — the privileged key never
> enters a Hearth-readable surface.

**Grouping:** a person may have multiple `ble_devices` (phone + watch + tag). The
fusion treats **any of a person's devices being in a room** as evidence that person
is there, weighted by `reliability` (phone > watch). This is exactly "add them into
the facial/body detection" — the BLE signal resolves to the **same
`enrolled_person_id`** as the face, so the occupancy scorer fuses face + BLE (+ body,
P2) into one named identity rather than three disconnected signals.

## 6. Hearth integration

### 6a. Reading device → room from HA

- **POC: REST poll.** A background reader (LoopDriver tick / a dedicated job) calls
  `fetch_ha_state(ha_area_entity)` per enrolled device every ~10–15 s. `state` = the
  HA Area name; `last_updated` gives staleness (treat **> ~30 s** as stale → drop to
  "unknown", never assert a stale room).
- **Production: WebSocket push.** Subscribe to HA's `ws://…/api/websocket`
  `subscribe_events { event_type: state_changed }` (same long-lived token) filtered
  to the device area entities — instant room transitions, no poll floor. Keep the
  REST read as the cold-start/reconcile path. (MQTT is the wrong fit — these are
  native HA entities, not MQTT-published.)

### 6b. HA Area → room_id

The home_map already carries the overlay: `rooms[].ble_areas` (HA Area names that
map to that room). Resolve `Bermuda area "Garage"` → the room whose `ble_areas`
includes `"Garage"`. The owner assigns BLE areas to rooms in **Luna's Home-office
assign overlay** (the field + `set_assignments` exist; the overlay UI does cameras
today — wiring its BLE half is P3c). HA Area names should be named to match (or the
overlay maps them).

### 6c. `beacon_readings` — the ephemeral cache

Mirror `PresenceLiveCache` / `location_awareness`: a process singleton (+ a thin
table for cold-load) holding the **latest room per device**, recency-derived liveness
(stale → not live). **Never a long log** — like the LD2450 targets, BLE readings are
transient. (`beacon_readings` is already named in the awareness §4 data model.)

### 6d. Fusion into `get_household_occupancy`

The §5 scorer gains a BLE input. Per the awareness design:
- A **fresh** BLE reading for a person's device → that person is **in that room** at
  high-but-not-certain confidence (device-not-person caveat → never "certain").
- BLE **corroborates** a camera/face hit in the same room (raises confidence) and
  **conflicts lower it** (camera says living room, BLE says kitchen → "uncertain",
  not a guess).
- BLE **stands alone** where there's no camera: **the Garage payoff** — a node in
  the garage makes "Jasper in Garage" show on the map with **no face needed**, fixing
  the exact gap we hit.
- Debounce home/away in Hearth (Private BLE Device's away-detection is slow).
- `reliability: best_effort` (watch) contributes at lower weight than `primary`
  (phone).

### 6e. Cassandra people-awareness

Cassandra already correlates camera scenes with "who's home." BLE makes that
correlation **named + room-precise**:
- A **known person's device** in a zone = strong "expected, routine" signal (his
  phone's in the garage → the garage person is probably him, even unrecognized by
  face).
- An **unknown BLE device** persistently present while all known phones are away is a
  *new* concern signal (a device nobody enrolled, lingering) — a future Cassandra
  alert (open decision §10). Today Bermuda only surfaces IRK-enrolled devices; raw
  unknown-device detection is a separate scan.

## 7. Privacy & security

BLE device-location is **privileged** — mirror `location_awareness` / `privacy.yaml`:
- **Owner-gated enrollment** — binding a device → person is owner-only (like face
  enrollment + the home-office assign overlay).
- **The IRK never enters Hearth** — it lives in HA's Private BLE Device; Hearth holds
  only the HA entity refs + a non-secret fingerprint.
- **Named occupancy stays household-visible** (the §9.2 mutual-transparency line);
  the **device→person map is owner-only** and never on any cross-specialist sharing
  or RAG surface (gate any new reader like `read_my_location_granted_to`).
- **Derived, not raw** — store rooms + confidences, never raw RSSI streams.
- **Kill switch** — one env/setting disables the BLE reader + fusion.
- **Household awareness (the consent line)** — same as the awareness doc: the
  household sees the same named map; tracking is mutual, not covert.

## 8. POC runbook (the 2 Atom Lites)

What 2 nodes prove: **area-level "which of 2 rooms" for an IRK-enrolled iPhone** —
e.g. **Garage** (the face-blind gap) + one adjacent room (Office/Kitchen). Not
distance/trilateration (needs 3+), not reliable Watch.

1. Flash both Atom Lites (§3 YAML), adopt in ESPHome, assign each to its HA Area.
2. Capture Jasper's iPhone IRK → HA Private BLE Device.
3. Install Bermuda (HACS); confirm the per-device **Area sensor** flips Garage↔Office
   as the phone moves (Developer Tools → States). **Skip calibration first** —
   relative RSSI usually nails 2-room separation; only tune `reference_power` (1 m) +
   one proxy's per-scanner offset if it flickers.
4. **Hearth side (P3b):** `ble_devices` row for the iPhone (its area entity_id),
   `ble_areas` on the Garage/Office rooms in the home_map, a poll reader →
   `beacon_readings`, and the occupancy fusion. Verify: stand in the garage with the
   phone, no face → **Luna's Home office shows "Jasper — Garage."**

## 9. Phasing

- **P3a — HA/Bermuda hardware (no Hearth).** Flash, IRK-enroll, Bermuda area sensors
  flipping in HA. Pure HA; nothing in Hearth yet.
- **P3b — Hearth reads + fuses (✅ SCAFFOLDING PRE-BUILT 2026-06-15, DORMANT).**
  Shipped behind `HEARTH_BLE_PRESENCE` (off → byte-identical occupancy):
  `BleDevicesStore` ([ble_devices.ts](../src/memory/stores/ble_devices.ts), the
  device→person grouping), `BlePresenceCache`
  ([ble_presence_cache.ts](../src/core/ble_presence_cache.ts), ephemeral),
  `run_ble_presence_sweep` (HA area reader, injectable `fetch_state`, throttled,
  HA-Area→room via `ble_areas`) + `resolve_ble_occupants` (per-person best room,
  primary>watch) + `augment_occupancy_with_ble` (the Garage payoff — adds people
  the cameras missed; face wins) in [ble_presence.ts](../src/core/ble_presence.ts),
  wired (lazy-on-read, fail-open) into Luna's `home_occupancy` route +
  `compose_home_pane`. Smoke `smoke:ble-presence` (18 checks) green. **Remaining
  for live:** flip the flag + enroll devices once Bermuda's publishing areas; the
  reader uses REST poll-on-read today (background sweep / WebSocket is P3d).
- **P3c — enrollment + assignment UX.** Cassandra People room: add **BLE devices** to
  a person (alongside faces) — the add-device flow + the unified identity card. Wire
  the **BLE half of Luna's Home-office assign overlay** (assign HA areas → rooms).
- **P3d — polish.** WebSocket push (replace polling), calibration helpers, more nodes
  / antenna upgrade, the unknown-device Cassandra alert (§10).

## 10. Open questions / decisions

1. **Reader transport** — REST poll (POC, simple) → WebSocket `state_changed`
   (production). Start poll, plan WS. (Recommended: WS once P3b proves out.)
2. **Where the reader runs** — a LoopDriver tick vs a dedicated background job vs an
   HA automation that POSTs to a Hearth `/api/ble` route on area change. Recommend:
   Hearth-pulls (poll/WS) — keeps HA dumb, mirrors the location-awareness read model.
3. **HA Area naming vs `ble_areas` overlay** — name HA Areas to match room ids, or
   rely on the overlay mapping. Recommend the overlay (decouples HA naming from
   Hearth room ids).
4. **Which 2 rooms first** — **Garage** (the proven face-blind gap) + ? (Office?).
5. **Apple Watch** — enroll as `best_effort` or skip for v1? (Phone-first; watch
   optional.)
6. **Unknown-device detection** — should an un-enrolled BLE device lingering while all
   phones are away be a Cassandra concern? (Powerful but noisy — needs a raw-adopter
   scan beyond Bermuda's IRK set. Defer to P3d, owner decision.)
7. **Tag option** — a cheap static-MAC BLE tag (keychain/wallet) is the *most*
   reliable Bermuda target (no rotation, no power-save). Worth offering as a `tag`
   device kind for non-phone-carriers (kids?).

## 11. Files (when P3b/P3c build)

- ADD: `src/memory/stores/` — `ble_devices` table + `BleDevicesStore` (or fold into
  the enrolled-persons store); `beacon_readings` ephemeral cache
  (`src/core/ble_presence_cache.ts`, PresenceLiveCache pattern).
- ADD: `src/core/ble_reader.ts` — the HA area reader (REST poll → WS), device→room
  via `ble_areas`, writes `beacon_readings`. Wired in `apps/orchestrator/server.ts`.
- CHANGE: `get_household_occupancy` ([client.ts](../src/memory/client.ts)) — fuse
  `beacon_readings` per person (the §6d scorer).
- CHANGE: Cassandra People room (`src/app/client/app.js` + a route) — the
  add-BLE-device enrollment flow.
- CHANGE: Luna Home-office assign overlay (`app.js` `_home_open_picker`) — the BLE
  half (assign HA areas → rooms), writing `ble_areas` (route field exists).
- ADD: `scripts/smoke-ble-presence.ts` + `package.json` entry.
- CONFIG: `HA_BASE_URL` / `HA_TOKEN` already set; add a `HEARTH_BLE_PRESENCE=1` kill
  switch + the WS endpoint when P3d lands.

## 12. Sources

- Bermuda (agittins/bermuda) — wiki: ESPHome Configurations (board, active 320/300),
  Calibration (reference_power/attenuation/offset), Troubleshooting (1-proxy
  area-level, freshness).
- HA **Private BLE Device** integration (IRK formats, entities, retrieval).
- HA Community — "Grabbing your Phone/Watch Bluetooth IRKs (2026 edition)";
  DerekSeaman, "Track Who's in Each Room with ESPHome + Bermuda BLE" (Dec 2025).
- HA Community — "Removed support for M5Stack Atom Lite as BT Proxy"
  (`board: m5stack-atom`, esp-idf); esphome/bluetooth-proxies#83.
- ESPHome — Bluetooth Proxy + `esp32_ble_tracker` docs; HA Bluetooth integration
  (active vs passive).
- HA — REST API (`/api/states/<entity>` shape, Bearer) + WebSocket API
  (`subscribe_events` `state_changed`).
- In-repo: [home_map.ts](../src/memory/stores/home_map.ts) (`ble_areas`),
  [home_assistant.ts](../src/connectors/home_assistant.ts) (`fetch_ha_state`),
  [client.ts](../src/memory/client.ts) (`get_household_occupancy`),
  [structured.ts](../src/memory/stores/structured.ts) (`enrolled_persons`),
  [design-household-awareness-layer.md](design-household-awareness-layer.md) (§3a, §4, §8).
```
