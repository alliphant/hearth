# WeatherFlow Tempest — weather-station integration

**Status:** Path 1 (HA-relay) SHIPPED 2026-06-23 (device-free smoke green;
returns real conditions the moment HA exposes the entities + the prefix is
set). Paths 2 (direct UDP) and 3 (cloud forecast) are DESIGNED here, not
built.

**Hardware:** WeatherFlow Tempest (all-in-one station + hub), installed
2026-06-23, reporting to the WeatherFlow cloud app. On-property ground-truth
for: air temperature, feels-like, relative humidity, dew point, station +
sea-level pressure (and trend), wind speed / gust / lull / direction, rain
rate + daily accumulation, UV index, solar radiation, illuminance, and
lightning strike count + last distance + last-strike time.

## Why a station at all — forecast vs ground-truth

Hearth already has weather: `weather.ts` serves a GEOCODED forecast (Pirate
Weather, keyed off the user's `home_location` in `config/users.yaml`,
39.7411,-104.9880). That answers "will it rain this afternoon" and "how cold
tomorrow morning." A forecast is a model over a grid cell; it cannot tell you
that it is raining **here, now, at 0.04 in/hr**, that the last lightning
strike was **3 mi away two minutes ago**, or how much rain **actually fell**
on the yard overnight. Those are exactly the facts that gate real decisions:
irrigation (Eleanor), lightning safety (Cassandra), departure conditions
(Iris), and the brief's lead weather line (Kate). Forecast and station are
complementary — keep both; the station owns "now, here," the forecast owns
"later / elsewhere."

## The three ingestion paths

```
                 ┌─────────────────────────────────────────────┐
 Tempest hub ──► │ (1) HA WeatherFlow integration (LAN UDP)    │──► HA sensor.* ──► tempest_conditions ──► specialists
   (LAN,         │ (2) Direct UDP :50222 listener (Hearth)     │──► PresenceLiveCache-style conditions cache
    UDP          │ (3) Cloud "Better Forecast" API (token)     │──► replaces the GEOCODED forecast
    broadcast)   └─────────────────────────────────────────────┘
```

### Path 1 — HA-relay (BUILT, recommended, lowest effort)

The hub is added to Home Assistant via HA's native **WeatherFlow**
integration (Settings → Devices & Services → Add Integration → WeatherFlow;
it auto-discovers the hub over local UDP — **no cloud, no token**). HA then
creates one `sensor.*` entity per measurement under a device named after the
station. Hearth already reads HA entities through `home_assistant.ts`, so the
integration is a **single new read tool** that maps those entities into a
typed current-conditions object.

- **Tool:** `tempest_conditions` ([src/connectors/tempest.ts](../src/connectors/tempest.ts)),
  `risk: read`, capability `read_weather_station`, zero required args.
- **One HA round-trip.** It fetches the whole `/api/states` dump once
  (`fetch_ha_all_states()`, added to `home_assistant.ts`), builds an
  `entity_id → state` map, and resolves all 24 measurements locally. The
  same dump yields the `candidates` list for free on the recovery path.
- **Entity-ids are configurable** (the device slug isn't known until the hub
  exists), read at CALL time so re-pointing needs no restart:
  - `HEARTH_TEMPEST_ENTITY_PREFIX` (default `sensor.tempest`) — the station's
    device slug. HA's CORE WeatherFlow integration names the device after the
    Tempest serial (e.g. `sensor.st_00214775`), and the default suffix map
    matches that integration's sensor names, so setting just this one value
    resolves every measurement. (Live device verified 2026-06-23:
    `HEARTH_TEMPEST_ENTITY_PREFIX=sensor.st_00214775`.)
  - `HEARTH_TEMPEST_<KEY>` (full entity_id) — per-measurement override when a
    sensor is named unusually or the community `weatherflow2mqtt` integration
    (different suffixes) is used. Keys: `TEMPERATURE FEELS_LIKE DEW_POINT
    WET_BULB HUMIDITY PRESSURE VAPOR_PRESSURE AIR_DENSITY WIND_SPEED
    WIND_SPEED_AVG WIND_GUST WIND_LULL WIND_DIRECTION WIND_DIRECTION_AVG
    RAIN_RATE PRECIPITATION PRECIP_TYPE UV_INDEX SOLAR_RADIATION ILLUMINANCE
    LIGHTNING_COUNT LIGHTNING_DISTANCE BATTERY BATTERY_VOLTAGE`.

  The default suffixes (HA core integration): `_temperature _feels_like
  _dew_point _wet_bulb_temperature _humidity _air_pressure _vapor_pressure
  _air_density _wind_speed _wind_speed_average _wind_gust _wind_lull
  _wind_direction _wind_direction_average _precipitation_intensity
  _precipitation _precipitation_type _uv_index _irradiance _illuminance
  _lightning_count _lightning_average_distance _battery _battery_voltage`.
  Note the core integration exposes NO last-strike timestamp; `lightning_count`
  is strikes-in-the-last-minute, so `signals.lightning_active` (count > 0) is
  the recency signal.
- **Recovery-hint pattern (connector affordance).** When NO measurement
  resolves (integration not added yet, or the prefix is wrong) the tool
  returns `{ ok:false, error, candidates }` — the weather-shaped `sensor.*`
  entities HA DOES have, so the operator/LLM re-points the prefix instead of
  fabricating a reading. When HA itself can't be read (no token / unreachable)
  it returns an actionable `recovery_hint` and no candidates. This mirrors
  `ha_get_state`'s candidates-on-404.
- **Units are honest.** Each reading passes through HA's own
  `unit_of_measurement` attribute (°F/°C, mph, in/hr, inHg/hPa, …). The
  connector never converts or assumes a unit system — consumers render
  `{value} {unit}`.

**The go-live step (no code):**
1. In HA, add the **WeatherFlow** integration; confirm the Tempest device +
   its `sensor.*` entities appear.
2. Read the device slug — call `tempest_conditions` once; it returns
   `candidates` listing the real sensor ids. Take the prefix before
   `_temperature` (e.g. `sensor.st_00214775`).
3. Set `HEARTH_TEMPEST_ENTITY_PREFIX` in `/docker/hearth/hearth.env` on
   the LLM host (env change → `docker compose up -d` to recreate, per the
   env-file-needs-recreate note). If any suffix differs from the defaults,
   set the matching `HEARTH_TEMPEST_<KEY>` override.
4. `tempest_conditions` now returns real readings. No restart for a later
   prefix change — env is read at call time (the `up -d` is only needed when
   `hearth.env` itself changes).

A one-liner to discover the prefix once HA has it (run where HA is reachable):
`curl -s -H "Authorization: Bearer $HA_TOKEN" $HA_BASE_URL/api/states | grep -oE '"sensor\.[a-z0-9_]*(air_temperature|wind_speed|lightning[a-z_]*)"'`

### Path 2 — Direct UDP listener (DESIGN ONLY — needs the device)

The Tempest hub broadcasts JSON over LAN **UDP :50222**, no cloud, no HA. This
is the lowest-latency path (sub-second) and removes HA as a dependency for the
station, at the cost of running a listener.

**Message types** (WeatherFlow UDP API):
- `obs_st` — full observation (~1/min): the complete measurement array
  (temp, RH, pressure, wind avg, gust, lull, direction, illuminance, UV,
  solar, rain accumulation, lightning count + avg distance, battery).
- `rapid_wind` (`ob`) — wind speed + direction every ~3s.
- `evt_strike` — a lightning strike the instant it's detected (distance + energy).
- `evt_precip` — rain-start event.
- `hub_status` / `device_status` — health/RSSI/battery (low-frequency).

**Shape (mirror the `PresenceLiveCache` pattern,
[src/core/presence_cache.ts](../src/core/presence_cache.ts)):**
- A `TempestUdpListener` (a `dgram` socket bound to `0.0.0.0:50222`, joined to
  the broadcast) parses each datagram by `type` and folds it into a
  **process-local current-conditions cache** — a singleton, never SQLite
  (live readings are ephemeral, exactly like presence targets). `is_live()` is
  recency-derived (a TTL like `HEARTH_TEMPEST_LIVE_TTL_MS`), so the cache
  degrades to "no live station" on its own when datagrams stop.
- `tempest_conditions` gains a source preference: **UDP cache first** (when
  `is_live()`), HA-relay fallback, so the tool surface and output schema are
  UNCHANGED — Path 2 is a faster *source*, not a new tool. A
  `source: 'udp' | 'home_assistant'` field on the output already anticipates
  this (today always `'home_assistant'`).
- Wiring: a new long-running listener, attached once in
  `apps/orchestrator/server.ts` next to the other process singletons, behind
  `HEARTH_TEMPEST_UDP=1` (off → byte-identical to Path 1). The orchestrator
  runs in a container — the listener needs the host's LAN broadcast domain
  (`network_mode: host` or a host-side relay sidecar, exactly like the
  `hearth-wol-relay` / `hearth-ops-relay` pattern), since a container on
  `docknet` won't receive the LAN UDP broadcast.
- **Lightning/rain events are the reactive-trigger source** (below): an
  `evt_strike` / `evt_precip` datagram is a real false→true edge, far crisper
  than polling HA state.

**Why not build it now:** the listener can't be validated without the device
on the LAN broadcasting, and HA-relay already delivers every measurement. Path
2 is the latency/独立性 upgrade once Path 1 is proven live.

### Path 3 — Cloud "Better Forecast" API (DESIGN ONLY — needs a token)

WeatherFlow's REST API (`swd.weatherflow.com/swd/rest`, **token required** —
generated in the Tempest app / `tempestwx.com` account settings) offers a
**station-calibrated forecast** ("Better Forecast") that fuses the local
station's history with the model. This is the one path that touches the
*forecast*, not current conditions.

**Design:** a `tempest_forecast` connector (or a `source: 'tempest'` branch in
`weather.ts`) calling `/better_forecast?station_id=…&token=…`, returning the
same `weather_forecast` output shape so it's a drop-in **forecast provider
swap** — Kate/Eleanor/Iris keep calling `weather_forecast`, the hyper-local
station forecast just replaces the geocoded grid-cell one for the home point.
Keyed/cached like `weather.ts` (5-min TTL, `WEATHERFLOW_TOKEN` +
`WEATHERFLOW_STATION_ID` env, read at call time). **Local-first caveat:** this
is a CLOUD call (the only one of the three) — gate it behind explicit opt-in
and keep the keyless Pirate path as the fallback so a missing/revoked token
degrades to the existing forecast rather than failing.

**Recommended sequencing:** Path 1 live first (done) → Path 3 (cloud forecast
swap, biggest forecast-quality win, small surface) → Path 2 (UDP, latency +
independence + event-driven triggers) only if the sub-second / event path is
wanted.

## Data model

`tempest_conditions` output (full schema in
[src/connectors/tempest.ts](../src/connectors/tempest.ts)):

```jsonc
{
  "ok": true,
  "source": "home_assistant",          // 'udp' once Path 2 lands
  "station_prefix": "sensor.st_00214775",
  "as_of": "2026-06-23T17:42:10Z",     // newest last_changed across readings
  "resolved_count": 23,
  "requested_count": 24,
  "missing": ["battery_voltage"],      // absent/unavailable entities
  "readings": {                                 // one entry per measurement
    "temperature": { "entity_id": "sensor.st_00214775_temperature",
                     "available": true, "value": 80.9, "raw": "80.942",
                     "unit": "°F", "as_of": "…" },
    "precip_type": { "…": "…", "value": null, "raw": "rain", "unit": null },
    "lightning_distance": { "…": "…", "value": 3, "unit": "mi" }
    // … temperature feels_like dew_point wet_bulb humidity pressure
    //    vapor_pressure air_density wind_speed wind_speed_avg wind_gust
    //    wind_lull wind_direction wind_direction_avg rain_rate precipitation
    //    precip_type uv_index solar_radiation illuminance lightning_count
    //    lightning_distance battery battery_voltage
  },
  "signals": {                          // derived, pure functions of readings
    "raining": true,                    // rain_rate > 0 (or precip_type != none)
    "lightning_active": true,           // lightning_count > 0 (strike in last min)
    "lightning_distance": 3             // avg distance when active (reading's unit)
  }
}
```

Each `Reading` is a uniform `{ entity_id, available, value, raw, unit, as_of }`
— `value` is the numeric parse (null for text readings or when absent), `raw`
holds the verbatim state (the landing place for the text `precip_type`). The
`signals` block is the small-model-friendly safety digest, computed in code
(never asked of the model).

On the recovery path: `{ ok:false, error, recovery_hint, candidates?,
station_prefix, resolved_count:0, missing:[…] }`.

## Wiring points (Path 1, as built)

| Piece | Location |
|---|---|
| Read tool | `src/connectors/tempest.ts` (`tempest_conditions`, plus the `_test_set_states_provider` smoke seam) |
| Shared HA helper | `src/connectors/home_assistant.ts` → `fetch_ha_all_states()` + `HAEntityState` |
| Registration | Automatic — the ToolLoader scans `src/connectors/` (no `server.ts` edit) |
| Capability | `config/capabilities.yaml` → `read_weather_station` (least-privilege; distinct from `read_weather` forecast + `read_home_assistant` raw access) |
| Grants + surfaces | `config/specialists/{kate,eleanor,cassandra,iris}.yaml` — granted, surfaced on the relevant curated `tools_for_chat` / `tools_for_deliberation`, and pointed at in each persona |
| Smoke | `scripts/smoke-tempest.ts` (`bun run smoke:tempest`) — device-free, injected HA entities |

**Capability-visibility scan (per CLAUDE.md):** for each of Kate / Eleanor /
Cassandra / Iris the grant is present, `tempest_conditions` is on a curated
surface (so it's not silently excluded), and each persona names it + when to
use it. Kate's VOICE surface intentionally omits it (the lean-voice prefill
discipline — `weather_now` already answers casual spoken weather; depth is one
`consult` away).

## Consumers

- **Kate (brief).** Lead weather line uses real on-property readings when the
  station is up (`tempest_conditions` on `tools_for_deliberation` + chat),
  falling back to the geocoded forecast (`weather_now`/`weather_forecast`).
- **Eleanor (irrigation).** Real rain rate + accumulation + UV paired with her
  HA Ecowitt soil-moisture sensors before any watering recommendation.
- **Cassandra (lightning safety).** `signals.lightning_active` (≥1 strike in
  the last minute) + `signals.lightning_distance` → advise indoors / hold
  outdoor activity on close active strikes.
- **Iris (departure conditions).** Actual wind/rain/temp at the house folded
  into the EV day-plan + arrival checks.

## Proactive danger alerts — the DangerousWeatherDriver (BUILT 2026-06-23)

The safety payoff of owning a lightning sensor: a dangerous condition should
reach the household *autonomously*, not only when someone asks. Built as
[src/core/dangerous_weather.ts](../src/core/dangerous_weather.ts)
(`DangerousWeatherDriver`), wired in
[apps/orchestrator/server.ts](../apps/orchestrator/server.ts) next to
`FlightTrackingDriver`.

- **A 60s ticker** edge-detects a real danger from two sources: the Tempest via
  `tempest_conditions` (close **active lightning** — `signals.lightning_active`
  with `lightning_distance` ≤ `HEARTH_DANGER_LIGHTNING_MI`/10 — and **extreme
  wind** — `wind_gust` ≥ `HEARTH_DANGER_WIND_GUST_MPH`/50), and Pirate via
  `fetch_weather_alerts` (the **full active NWS WARNING taxonomy** — `classify_alert`
  fires on any "* Warning"/Emergency, drops watches/advisories/statements).
- **On the false→true edge it alerts the household BOTH ways**: it **speaks**
  the warning over the Satellite1 (`try_speak_followup` → coordinator `/speak`,
  if anyone's home + near), **preceded by a TONE TIERED BY URGENCY** —
  `classify_alert` reserves the EAS-style attention two-tone (`critical`) for the
  genuinely take-cover-NOW set (Tornado/Flash-Flood Warning+Emergency, Extreme
  Wind, a destructive-tagged Severe Thunderstorm, Fire Warning) and uses the soft
  chime (`notice`) for the rest of the taxonomy (Winter Storm, High Wind, Extreme
  Cold/Heat, Flood, Red Flag, …) AND for routine lightning/wind — so common
  Front-Range warnings + strikes don't cry wolf. An unrecognized "* Warning"
  defaults to `notice` (never wrongly alarming). Tiering keys on the EVENT TYPE,
  not the feed's `severity` field (which is unreliable — seen as "Unknown"). AND
  **pushes every home member** (owner + household, never friend, never a
  synthetic/test account — `is_synthetic_account` excludes the internal
  `@hearth.local` email domain) at **`high` severity** — which pierces quiet
  hours *and* the read-the-room gate (a tornado warning at 3am must wake you).
  Both channels fire on purpose: the away spouse still needs the phone push even
  when the house speaker is heard by whoever's home. The tone is synthesized +
  cached as mp3 in the coordinator (`integrations/voice-coordinator/tones.py`,
  numpy + lameenc) and enqueued ahead of Kate's TTS clip; the driver passes
  `pre_tone` through `try_speak_followup` → `/speak`. Fail-soft: a tone
  synth/encode failure just means no tone, the alert still speaks.
- **Why a deterministic driver and NOT a woken deliberation** (the one place
  the reactive-trigger "wake a scoped deliberation" pattern is deliberately not
  used): safety delivery cannot depend on the LLM choosing to call a speak/push
  tool. Detection + the Kate-framed alert text are composed in code; the model
  is never in the loop.
- **Cadence: episode-based gentle + a pressure-relief valve (redesigned
  2026-06-24).** A danger can last minutes (a close strike) or HOURS (a
  winter-storm / extreme-cold warning), so a fixed "re-alert every N minutes"
  cadence nags on the long ones AND can still firehose on a flickering storm.
  The model that holds for both:
  - **GENTLE = ONCE PER EPISODE.** The value is in the FIRST alert. While a
    notice-tier danger is ongoing the driver stays SILENT — **no clock-based
    re-alert at all** (a 12–24 h cold/wind warning would otherwise mean dozens of
    "still cold" pushes). An *episode* ends only when the danger has been ABSENT
    for a full **clear-gap** (`HEARTH_DANGER_CLEAR_GAP_MS`/30m); the next
    occurrence after that is a fresh alert. The clock is `last_seen_current_ms`
    (refreshed every tick the danger is present), so an INTERMITTENT signal
    (lightning toggles active↔clear between strikes) keeps the episode alive as
    long as strikes are closer together than the clear-gap — it can't re-fire as
    a "new edge." This replaces the prior "≤1 per 30-min window" floor (and its
    window-survives-the-clear hack): the clear-gap, measured from last-PRESENT
    not last-ALERTED, is the correct general mechanism.
  - **PRESSURE-RELIEF VALVE = release on genuine INTENSIFICATION.** The episode
    cooldown holds back routine continuation, but if the danger is getting
    genuinely WORSE — lightning *closing in* — that pierces the cooldown. The
    release is a MONOTONIC band crossing: each Tempest danger has an intensity
    axis (lightning: closeness, bands `HEARTH_DANGER_LIGHTNING_ESCALATION_MI`/`3,2`
    mi — a ≤3 mi "closing in" tier and a ≤2 mi "right overhead" tier; wind: gust
    strength, `HEARTH_DANGER_WIND_ESCALATION_MPH`/`70,90` mph) mapped to a band;
    the valve opens ONLY when the current band is STRICTLY HIGHER than the worst
    band already alerted this episode, then re-seats `worst_band` higher.
    Self-limiting — it can only release as the storm *strictly worsens*, never on
    steady-state or oscillation, and at most once per band (an overhead cell
    oscillating 1↔2.5 mi fires the overhead alert exactly once). **The invariant:**
    the real grounding storm (distance drifting 6→5→6 mi, clustered intermittent
    strikes) stays in one band → EXACTLY ONE alert; a storm that genuinely marches
    8→2.8→1.5 mi releases at most three times (fresh + closing-in + overhead), each
    a real step up, with a proximity-aware message ("closing in" then "right
    overhead — stay away from windows and exterior walls"). The bands are coarse
    enough that normal ±1–2 mi storm noise never crosses (the nearest band, ≤3 mi,
    sits well below the 5 mi floor of that storm). **Why a SECOND (overhead) band**
    (owner call 2026-06-25): the danger gradient from 3 mi to on-top-of-you is
    steep — an essentially-overhead strike warrants a fresh alert, and the monotonic
    valve makes it nuisance-free by construction. Inner band is ≤2 mi (not ≤1) because
    the Tempest reports AVERAGE strike distance — a genuinely-overhead cell may only
    pull the average to ~2 mi, so ≤1 could rarely fire; the per-alert audit row
    (`value`=distance, `band`, `reason`) lets us tune it from the first real storm.
    NWS alerts carry no band (an upgrade arrives as a different KEY — Tornado
    *Warning* → *Emergency*), so the valve is naturally Tempest-only. *(Strike-
    frequency surge was considered as a third axis and deferred — clustered strikes
    are normal storm behavior, not intensification, so a rate trigger risks
    re-introducing the nuisance; the strike count is threaded through
    `DangerReadings` so it's a one-line add if wanted.)*
  - **CRITICAL keeps a periodic reminder.** A sustained take-cover event
    (tornado / flash-flood / extreme-wind / fire warning) is the ONE case where
    repetition is a safety feature — it re-fires on the clock
    (`HEARTH_DANGER_CRITICAL_MIN_INTERVAL_MS`/10m) while ongoing, toggleable via
    `HEARTH_DANGER_CRITICAL_REMIND` (default ON; `=0` makes critical also
    once-per-episode). The gentle/notice tier never reminds on a clock.
- **Fail-open** per tick (a throwing source/delivery is logged + skipped, never
  aborts the tick or boot), **DARK by default** (`attach()` is a no-op unless
  `HEARTH_DANGEROUS_WEATHER=1`), **deterministic** (no LLM in the safety loop).
  Proof: `bun run smoke:dangerous-weather` (103 checks — once-per-episode silence
  while ongoing, the intermittent-flicker + clear-gap-new-episode lifecycle, the
  relief-valve closing-in→overhead two-band release + the steady-state-no-release
  invariant, the band math, the critical-reminder-on/off matrix, the NWS tier
  matrix, distance + wind gates, owner+household recipients, fail-open, kill
  switch; injected sources + spy delivery + a controllable clock, no device).

**Future (Path 2):** the crisp version rides the UDP `evt_strike` / `evt_precip`
datagrams (instant, not a 60s poll) — same detection + delivery, push-driven.
The driver's `DangerSources` seam is where that swaps in.
