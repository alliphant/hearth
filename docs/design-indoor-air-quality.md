# Indoor air quality — read (Iris) + proactive alerts (Kate)

**Status:** SHIPPED 2026-06-25. The indoor complement of the WeatherFlow Tempest
work ([docs/design-tempest-weather-integration.md](design-tempest-weather-integration.md)):
a typed read of the household's AirThings monitors (owned by **Iris**, the
HA-oriented specialist) + a deterministic proactive alert driver that reaches the
household autonomously when indoor air turns dangerous (delivered **as Kate**).

## The split — Iris reads, Kate alerts

Mirrors the weather split (the Tempest read tool is shared; the alert driver
speaks as Kate). Indoor air is HA-oriented, so **Iris owns the on-demand read**;
the proactive **alert is Kate's** (the household ambassador + the Satellite1
voice).

| Piece | Location |
|---|---|
| Read tool | `src/connectors/airthings.ts` (`airthings_conditions`, cap `read_air_quality`, owner/household gate) — auto-loaded (ToolLoader scans `src/connectors`) |
| Capability | `config/capabilities.yaml` → `read_air_quality` (least-privilege; one tool, not raw HA) |
| Grant + surface | `config/specialists/iris.yaml` — granted, on `tools_for_chat`, persona pointer |
| Alert driver | `src/core/indoor_air_quality.ts` (`IndoorAirQualityDriver`), wired in `apps/orchestrator/server.ts` next to `DangerousWeatherDriver` |
| Cadence engine | `src/core/episodic_alert.ts` (shared with the weather driver — see below) |
| Smoke | `scripts/smoke-air-quality.ts` (`bun run smoke:air-quality`, 54 checks, device-free) |

## The read — `airthings_conditions`

A typed sibling of `tempest_conditions`. One `/api/states` dump resolves every
reading; per monitored room (Basement, En Suite, Living Room by default) it
returns radon (Bq/m³), CO₂ (ppm), VOC/TVOC (ppb), PM1 + PM2.5 (µg/m³), humidity,
temperature — each with HA's own `unit_of_measurement`, never inferred — plus a
`signals.worst` digest naming the WORST room per pollutant (the small-model /
driver surface). Rooms are configurable (`HEARTH_AIRTHINGS_ROOMS` =
`Label:slug,…`, read at call time, defaults match the live household); a
per-pollutant suffix override is `HEARTH_AIRTHINGS_SUFFIX_<KEY>`. When nothing
resolves it degrades to `{ ok:false, error, candidates }` listing the
air-quality-shaped `sensor.*` entities HA actually has — the same recovery-hint
pattern as `tempest_conditions` / `ha_get_state`. So Iris can answer "what's the
radon / CO₂ right now?" grounded in the actual reading.

## The alert — `IndoorAirQualityDriver`

A 60s ticker, deterministic (no LLM in the safety loop), DARK by default
(`attach()` is a no-op unless `HEARTH_AIR_QUALITY_ALERTS=1`), fail-open per tick.
It reads two sources and composes `ActiveAlert`s, then runs them through the
shared cadence engine and delivers as Kate (push every home member + speak over
the Satellite1).

### Tiering (owner calls 2026-06-25)

| Signal | Tier / tone | Thresholds (env-tunable) | Pierces quiet hours? |
|---|---|---|---|
| **CO₂** | gentle chime → **EBS klaxon** | chime ≥1500 ppm · **klaxon ≥2500** · stronger ≥5000 (`HEARTH_AIR_CO2_BANDS`, `_CRITICAL_FROM`=2) | klaxon: **yes**; chime: no |
| **Radon** | gentle chime only | ≥100 · ≥148 Bq/m³ (EPA action) (`HEARTH_AIR_RADON_BANDS`) | no |
| **VOC** | gentle chime only | ≥1000 · ≥2000 ppb (`HEARTH_AIR_VOC_BANDS`) | no |
| **PM2.5** | gentle chime only | ≥35 · ≥55 µg/m³ (`HEARTH_AIR_PM25_BANDS`) | no |
| **CO / smoke alarm** (camera-heard) | **EBS klaxon** | binary `on` | **yes** |

**Why CO₂ is acute here** (not the textbook chronic-monitor framing): the
household runs a **5 lb CO₂ cylinder in a DIY kegerator** (sparkling/spicy
water). A cylinder leak in the enclosed basement displaces oxygen, and **CO₂ is
heavier than air so it pools at floor level** — exactly where the dogs are, and
*below* where the wall-mounted AirThings reads. So the sensor under-reports the
floor-level danger, which is why the klaxon fires conservatively early (≥2500
ppm, well above any normal household CO₂) and re-reminds while elevated (a
developing leak is an ongoing emergency). Inner threshold is ≥2500 not higher
because the AirThings CO₂ sensor saturates ~5000 ppm; tune from the live
basement baseline (a calm ~567 ppm at ship time) via the audit row.

**Why the camera CO/smoke alarms are the true acute tier:** AirThings measures
CO₂, *not* carbon **monoxide** (the acutely-deadly gas). The genuine
"evacuate-now" signal is a physical CO/smoke alarm sounding, which the UniFi
Protect cameras *hear* (`binary_sensor.*_co_alarm_detected` /
`*_smoke_alarm_detected`). Those map to the EBS klaxon that pierces quiet hours.
(`binary_sensor.rear_door_*` read `unavailable` at ship time — a coverage gap to
watch, not an alerting source until it reports.)

### Overnight behavior (only the firmest tier wakes you)

Tier → push severity: critical → `high` (pierces the quiet-hours gate), notice →
`medium` (the gate HOLDS it overnight and delivers in waking hours). The SPEAK is
gated separately: critical always speaks; a notice chime is silent aloud during
the owner's quiet hours (a 3am chronic-air chime is intrusive + not actionable) —
`is_within_quiet_hours` over the owner's notification config.

### Cadence — the shared `EpisodicAlertEngine`

The once-per-episode + monotonic pressure-relief-valve cadence (built for the
weather driver) is now a shared core: a level **chimes once** when it crosses a
band and stays silent while elevated; the **relief valve** re-alerts only on a
strictly-worse band (CO₂ 1500→2500→5000 each releases once, with proximity-aware
copy); a **critical** level re-reminds on the clock; the episode ends after the
level clears for a **clear-gap** (60 min default — air quality is slow). The
engine is pure w.r.t. delivery (`decide_pass(alerts, now)` returns what to
deliver), so each driver owns its own severity + quiet-hours policy. The weather
driver's 103-check smoke guards that the extraction kept its behavior
byte-identical.

**Extending — a new household danger alerter:** build it on
`EpisodicAlertEngine` (supply `detect(): ActiveAlert[]` + a delivery), don't
re-implement the cadence. Per-band tones are supported (an `ActiveAlert.tone` can
differ by band, as CO₂'s chime→klaxon does), so a pollutant/signal that
escalates in *kind* as well as *degree* is a config, not a fork.

## Knobs

Kill switch `HEARTH_AIR_QUALITY_ALERTS=0`. Tunables: `HEARTH_AIR_POLL_MS`,
`HEARTH_AIR_CLEAR_GAP_MS` (60m), `HEARTH_AIR_CRITICAL_MIN_INTERVAL_MS` (10m),
`HEARTH_AIR_CRITICAL_REMIND` (on), the per-pollutant `*_BANDS`, the room map
`HEARTH_AIRTHINGS_ROOMS`. Every alert audits `tool_name=indoor_air_quality_alert`
with `value`/`band`/`tone`/`reason` for tuning. Smoke: `bun run smoke:air-quality`.

**Future:** a per-pollutant rate-of-rise trigger (a fast CO₂ climb is a leak
signal before it hits an absolute band) — the relief valve already catches the
climb via bands; rate-of-rise would catch it a tick earlier.
