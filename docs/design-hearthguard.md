# HearthGuard — the household guardian (it sends Ember Alerts)

**Status:** DESIGN ONLY (2026-06-28). Nothing in this doc is built. It is the
architecture + a phased plan for growing Hearth's safety layer from "three
deterministic alerters sharing one surface" into a continuous household
guardian. The three live producers (dangerous weather, indoor air, the
emergency-light flash) and the shared cadence engine are the foundation it
builds on — see "What exists today."

**Name — DECIDED (Jasper, 2026-06-28):** the always-on system is **HearthGuard**;
the moment it warns you is an **Ember Alert**. "The HearthGuard system sends an
Ember Alert." First build chosen: **A2 — lock-up / departure Rounds** (§5/§7).
(§1 keeps the full analysis + the honest tradeoff behind the choice.)

**Companion:** [design-tempest-weather-integration.md](design-tempest-weather-integration.md)
(the weather producer + the cadence model), [design-indoor-air-quality.md](design-indoor-air-quality.md)
(the air producer + the shared engine extraction). This doc is the umbrella
the two of them live under.

---

## 0. The two deliverables, up front

This session answered two questions:

1. **What new sensor-fusion producers and broader purposes should the safety
   layer grow?** — §3–§6 below: a guardian with three postures over an
   innate/adaptive core that maintains a "house vitals" picture and learns the
   household's normal, plus a ranked catalog of new producers.
2. **What do we call it?** — §1. **Decided:** the system is **HearthGuard**, the
   moment is an **Ember Alert** (the system/signal split). Jasper chose to brand
   *both* layers.

---

## 1. The name

### The split that resolves it

"HearthGuard" and "Ember Alert" feel like competitors, but they name **two
different things**, and once you see that, the answer falls out:

- An **Ember Alert** is a *moment* — the instant the house warns you. It is the
  thing the household actually experiences and consciously names.
- A "guardian system" is the *always-on machinery* underneath — the detectors,
  the vitals loop, the postures. The household never consciously names this; it
  just runs. 95% of the time it is silent and regulating, not alarming.

Jasper endorsed this split and chose to **name both layers**: the machinery is
**HearthGuard**, the moment is an **Ember Alert**.

### Decision (Jasper, 2026-06-28)

> **The always-on system is "HearthGuard." The signal it fires is an "Ember
> Alert." — "the HearthGuard system sends an Ember Alert."**

(This overrides the doc's original recommendation, which was to *not* brand the
system and leave it as "the guardian" — the honest tradeoff behind that is
preserved below so future-me knows why it was a real choice, not an oversight.)

And make the metaphor **load-bearing**, not decorative, by mapping it onto the
two tones the code already has:

| Tier (code `tone`) | User-facing name | What it is |
|---|---|---|
| `notice` (soft chime) | an **Ember** | the early, gentle catch — garage left open as rain moves in, CO₂ creeping, the car baking in the sun, indoor temp sliding toward freezing |
| `critical` (EBS klaxon + red flash) | an **Alarm** | the blaze is here — tornado, CO/smoke alarm, confirmed CO₂ leak, intrusion: take cover / evacuate / act now |

So "Ember Alert" the system fires **Embers** (the catch) and **Alarms** (the
blaze). No code rename — `notice`/`critical` stay; this is user-facing
vocabulary only.

### Why this, pressure-tested

**Why "Ember Alert" wins as the signal name:**

- **The metaphor shapes the right behavior.** "Catch the ember before the
  blaze" *is* the design thesis (§3: smolder detection, investigate-before-
  alarm, learn-normal-and-catch-the-deviation). A name that pulls the whole
  design toward *early/predictive/fused* is doing real work. "Guard" pulls the
  opposite way — toward reactive, after-the-fact defense.
- **Instant recognition.** The Amber-Alert echo cues "urgent, trustworthy
  broadcast about something in danger." Right for the *moment*.
- **On-brand.** Hearth → ember is the same fire family. Warm, ownable,
  memorable — not corporate.

**The honest objection, and why it doesn't sink it:** an ember is literally a
*fire* precursor, and most producers aren't fire (CO₂, intrusion, hot car,
fall). But the *brand* generalizes the concrete image to "the small early sign
that precedes any harm" — the creeping ppm, the stillness before a fall is
found. Brands routinely generalize a concrete image; the behavioral pull toward
early detection is worth more than literal fire-specificity. Verdict: the
objection is real but the metaphor's pull is the bigger lever.

**The honest tradeoff in branding the system "HearthGuard" (the chosen path's
watch-outs, kept so they're not re-litigated):**

- **It leans corporate / generic** — adjacent to SaaS security branding
  (LifeLock, Ring Protect). Mitigate in the *voice*: Kate never says
  "HearthGuard" aloud to the household; it's the internal/settings name for the
  machinery, and "Ember Alert" is what's ever spoken.
- **"Guard" biases toward security/intrusion** and under-indexes the
  homeostasis/health/environmental majority. Mitigate by keeping the *scope*
  visible where the name appears — the House/vitals surface (§3.2) is the thing
  labeled HearthGuard, and it's mostly the quiet regulator, not an alarm panel.

**The split is what makes both names work.** "Alert" is exactly right for the
*moment*; the broad scope lives in the *system*, which carries the descriptive
"HearthGuard" name — so neither name has to carry the other's job. The metaphor
still does its work: "Ember" keeps the design pulling toward the early catch.

> **Decided** (see §10). Doc + filename track the decision (`design-hearthguard.md`).

---

## 2. What exists today (the foundation)

A shared **alert surface** with three output channels, on a two-tone tier
ladder, driven by a shared cadence engine. Three producers feed it.

**The surface (three channels):**
- **Voice** — Kate speaks the alert over the Satellite1 (`try_speak_followup` →
  the voice coordinator `/speak`, presence-gated, plays a pre-speech tone:
  EBS two-tone for critical, soft chime for notice; critical barges a live
  conversation).
- **Push** — every home member's phone, severity-tiered (`push_text_to_user`;
  `high` pierces quiet hours, `medium` is held overnight).
- **Light** — the house flashes red and restores, on critical only
  ([emergency_lights.ts](../src/core/emergency_lights.ts) — snapshot →
  fade-to-red → restore, fail-safe, Hue group-cast for speed).

**The cadence engine** ([episodic_alert.ts](../src/core/episodic_alert.ts),
`EpisodicAlertEngine`): once-per-episode gentle + a monotonic pressure-relief
valve (re-alert only on strict intensification) + a critical clock reminder.
PURE w.r.t. delivery — `decide_pass(alerts, now)` returns what to deliver; each
producer owns its own push/speak/severity policy. Per-band tones supported (a
signal that escalates in *kind* — CO₂ chime → klaxon — is config, not a fork).

**The three live producers:**
- **DangerousWeatherDriver** ([dangerous_weather.ts](../src/core/dangerous_weather.ts))
  — Tempest close-lightning + extreme wind + NWS warnings. Kate (weather).
- **IndoorAirQualityDriver** ([indoor_air_quality.ts](../src/core/indoor_air_quality.ts))
  — AirThings CO₂/radon/VOC/PM2.5 + camera CO/smoke-alarm audio. Kate (air),
  read owned by Iris (`airthings_conditions`).
- **The emergency-light flash** — the third channel on the critical tier.

Plus the manual drill (`test_emergency_alert`, Kate's chat + voice) and the
monthly first-Monday-noon audible drill.

**The producer contract** (every new producer in this doc follows it exactly):
a `Driver` class — `attach()` is a no-op unless its `HEARTH_*` flag is set
(DARK by default), a 60s `tick()` that is fail-open (a throwing source/delivery
is logged and skipped, never aborts the tick or boot), a `detect()` that reads
sources and composes `ActiveAlert[]`, fed to the shared `EpisodicAlertEngine`,
delivered to `default_home_user_ids` (owner + household, never a friend, never a
synthetic account). Wired one line in
[apps/orchestrator/server.ts](../apps/orchestrator/server.ts) next to the
others. **Safety delivery is deterministic — composed in code, never an LLM
tool-choice** (the one sanctioned exception to LAW #1; see §3.3).

---

## 3. The reframe: the guardian as the house's immune system

The current shape is three independent alarms that happen to share a speaker.
The reframe is a single **guardian** with one job: keep the household safe by
*mostly not alarming* — by continuously regulating, and escalating to a signal
only on a genuine deviation. The biological analogy is exact and useful:

- **Homeostasis is the default.** An immune system spends ~all its time keeping
  the body in range, silently. It is not a fire alarm that waits for smoke; it
  is a continuous process. The guardian's default state is a quiet vitals loop,
  not a row of armed tripwires.
- **Innate vs adaptive immunity** maps onto two layers we already have the
  primitives for (§3.3).
- **Inflammation is proportionate.** The response to a splinter is not the
  response to sepsis. The guardian responds in proportion — investigate before
  alarm, chime before klaxon, narrate before actuate.
- **It learns.** It tunes to *this* body's normal and stops reacting to the
  benign. Alarm fatigue is an autoimmune disorder; killing it is a first-class
  goal.

### 3.1 Three postures

One core, three operating postures. A producer that feeds one posture feeds all
— the posture is *how the same vitals + producers are read*, not a separate
stack.

- **Watch (sentry).** The default. Innate detectors running, the vitals object
  maintained, the adaptive layer dormant until an anomaly. This is where today's
  three producers live. Passive, ~free.
- **Rounds (secure / open up).** Active sweeps, scheduled or event-triggered:
  the **lock-up rounds** (bedtime, or everyone-departed → "garage's open, back
  door's unlocked, the Ioniq's unlocked in the driveway"), the **morning
  open-up**, the **arrival escort**. Rounds *query* the securement vitals and
  compose a SITREP; they don't wait for a tripwire.
- **Response (per-hazard).** The actuation posture: egress lighting on fire
  (full-bright path to the door, not red), shelter framing on tornado,
  mitigation on gas (ventilate; a future vent-fan-on), deterrence on intrusion
  (lights up, announce, flash). The red flash is today's only Response
  actuation; everything else here is the highest-autonomy, last-to-ship rung
  (§7).

### 3.2 The house-vitals object — one picture, not a cacophony

A single typed snapshot of "the house right now," **composed from reads that
already exist** (not a new store, not new sensors):

| Vital | Source (live today) |
|---|---|
| **Occupancy** — who's home, which room | `get_household_occupancy` + the belief filter (`occupancy_belief.ts`); BLE pucks, WiFi, faces (cpai) |
| **Securement** — doors/windows/garage/vehicle locked | `ha_get_state` on `cover.double_bay_isg`, locks, contacts + Ioniq lock/door entities |
| **Comfort** — indoor temps vs setpoints, humidity | HA indoor/outdoor temp entities, thermostat (if exposed) |
| **Air** — worst-room pollutant digest | `airthings_conditions.signals.worst` (the air driver already computes it) |
| **Power / grid** | `binary_sensor.honeysuckle_grid_status` (⚠ verify polarity, §6), smart-plug draws |
| **Device health** — are the sensors/cameras/voice path reporting | `assess_system_health` (`system_health.ts`) — extend its registry to the safety sensors |
| **Weather (now, here)** | `tempest_conditions` |
| **Active concerns + what we're doing** | the open-episode state in the engines + the system-health incident ledger |

The vitals object is the **read-only foundation** (§7, Phase 0) and the thing
the SITREP collapses *into*. It is a composer over existing sources + a typed
snapshot — explicitly **not** a new sensor or DB. It is the natural sibling of
the **Household Knowledge Graph** (`household_knowledge/`, `HouseholdGraphDriver`)
— same cordon-stamped, fan-to-each-specialist's-slice discipline.

**SITREP, not cacophony.** When several producers fire in a window — a storm
knocks the grid out, the sump loses power with rain forecast, the basement
humidity starts to climb — the guardian collapses them into **one narrative**
("Power's out. It's 14°F and dropping inside; the basement sump is unpowered
with more rain coming. Here's what I'd watch.") instead of four separate pushes.
This is uniquely-Hearth: it knows the *causal chain across domains*. Honest
cost: collapse needs a shared recent-alert ledger above the independent drivers
(§7, Phase 2) — the drivers ship independently first.

### 3.3 Innate vs adaptive — and how it obeys LAW #1

LAW #1: never hard-code / special-case *around* the model; let the model decide
and spend the tool call; determinism only *inside* a tool the model chose.
Safety **delivery** is the sanctioned exception (a klaxon can't wait for the LLM
to choose to call a speak tool). The reframe keeps the exception tightly
scoped to delivery, and puts the model exactly where it belongs:

- **Innate layer (deterministic, always-on, ~free) — the reflex arc.** The
  producers. Cheap edge-detectors over HA entities / Protect smart-detects /
  geofence / thresholds. They OWN the critical-path delivery (the klaxon fires
  in code). A CO alarm doesn't consult a brain. *This is the safety-delivery
  exception, and it stays confined to detection + delivery of clear-cut
  hazards.* (DangerousWeather, IndoorAirQuality, and every new innate producer
  in §5 live here.)

- **Adaptive layer (expensive LLM/VL, on-demand, only on an anomaly) — the
  judgment.** A **woken scoped deliberation** (the existing
  `wake_deliberation_scoped` reactive-trigger spine) fires when an innate
  detector flags something *ambiguous* — a situation that needs *reasoning*, not
  a *reflex*. The model reads the vitals + the triggering signal + the
  deterministic baseline (§3.4), decides benign-vs-real, and on a real one
  composes the SITREP and a *proposed* action routed through the gated autonomy
  ladder. **Here the model is fully in the loop — LAW #1-clean.** The VL is
  invoked here as the **narrator of an anomaly keyframe** only (the away-monitor
  cascade pattern), never the identifier — identity comes from cpai faces / the
  household registry / ALPR, never the VL (§3.5).

The dividing line is **clear-cut vs ambiguous**:
- *Clear-cut* (tornado warning, a sounding CO alarm, CO₂ past the leak band) →
  innate, deterministic, klaxon now. No model.
- *Ambiguous* (a single smoke-audio ping on one camera — burnt toast or fire? a
  person at the side door at 2am — a returning member or a stranger? a member
  home but unmoving for two hours — napping or fallen?) → the adaptive layer
  reasons before it decides chime-vs-klaxon-vs-nothing.

### 3.4 Learn-normal — the honest mechanism (not an ML hand-wave)

"Learn the household's normal and alarm on deviation" is a beautiful idea and a
classic over-promise. The honest version:

- **Thresholds for clear-cut hazards stay fixed.** You don't learn-normal a
  tornado or a CO alarm. Learn-normal applies only to the **behavior-shaped,
  ambiguous** signals: is a person at the door at *this* hour normal? is the
  washer running at 3am unusual? is the back door open 40 min in winter weird?
- **The baseline is deterministic, computed inside a tool — not a trained
  model.** Per-hour occupancy histograms, typical door-open durations, typical
  appliance run windows, computed from the audit log / event history — the same
  deterministic-baseline idiom the repo already uses (person-track thresholds,
  the demand ledger's token clustering, camera-cosine calibration). This obeys
  LAW #1: the determinism produces *evidence*; the **model** judges anomaly with
  the baseline as context ("normally someone's home now; right now no one is and
  the side door just opened").
- **It learns from every false alarm.** When the household dismisses an Ember
  ("that was just me"), the dismissal is logged and feeds the suppression
  baseline — the same benign pattern doesn't re-fire. This is the
  dismissed-stays-dismissed / process-miss idiom already in the repo (Ruby's
  civic flags, proposal dedup). This is the primary alarm-fatigue killer.

### 3.5 The hard constraints (load-bearing)

- **Detector-first, VL-as-narrator.** The vision tier
  ([project-vl-camera-capability-envelope] — Qwen3.6-27B-VL on forza:8096) is
  strong at scene/gist and **confidently fabricates fine identity** (it read one
  plate five different ways, every one high-confidence; it called the Ioniq 5 a
  "VW ID.4"). ~8–20 s/frame; raw full-res frames crash it (capped at 1280px,
  [vision-tier-resilience]). So **the watching is always cheap deterministic
  signals** (smart-detect, contacts, geofence, thresholds); the VL/deep-LLM is
  invoked **only on-demand to narrate/reason an anomaly**, and **identity is
  cpai faces / the registry / a dedicated ALPR — never the VL.**
- **Per-user cordon holds.** Presence and security data are owner-private. Alert
  recipients are `default_home_user_ids` (owner + household). The vitals object
  and any new occupancy/security signal stay cordoned exactly as
  `get_household_occupancy` is — no cross-specialist location/security sharing
  beyond the existing owner-gated surfaces.
- **DARK by default, fail-open, deterministic delivery** — every producer ships
  behind its own flag, smoke-tested device-free, armed individually. The whole
  layer is byte-identical to today when every flag is off.

---

## 4. How a new producer plugs in

Identical to the two live ones. A new hazard = a new `Driver` on the
`EpisodicAlertEngine`, owned by the right specialist:

```
detect() : ActiveAlert[]          // read sources fail-open, compose
   → engine.decide_pass(now)      // shared cadence (once/episode + relief valve)
   → deliver()                    // push (cordoned) + speak (Kate) + critical→flash
```

- **Ownership** routes by domain, but **Kate is always the voice** (the alert
  ambassador — she speaks every producer's alert; the producer-owner owns the
  *detection*). Map in §8.
- **Tone** per `ActiveAlert` (or per band): `notice` = Ember, `critical` =
  Alarm. The engine handles the cadence; the producer picks the tone from the
  band.
- **A reactive (event-driven) producer** subscribes to the `AppEventBus`
  instead of polling (the `ReactiveInboxDriver` / `GuardFeedbackDriver` shape) —
  e.g. an intrusion producer wakes on a Protect smart-detect event rather than a
  60s poll.

That's the whole contract. The §5 catalog is "which `detect()` to write next."

---

## 5. The producer catalog (ranked)

Ranked by **(uniquely-Hearth × low-friction)** — lead with the ones that score
high on *both*. Each row is honest about effort, dependencies, failure modes,
and the smaller shippable slice. The crown-jewel "only-Hearth" producers (fall,
roll-call, dog-confirmed hot-car) score highest on *novelty* but are gated on
signals that aren't solid yet — they're called out as **rewards for landing
presence**, not things to bolt on now (the same discipline that parked the
warmth "away-recap": substance bar, not plumbing — see [kate-warmth-presence]).

### Tier A — ship-soon: grounded, low-friction, no presence dependency

#### A1. HVAC-failure / freeze → pipe-burst prevention `[Watch→Response]` · Luna
- **Fuses:** indoor-temp *trend* (HA temps everywhere) + outdoor temp/forecast
  (Tempest + Pirate) + thermostat state (if exposed) + occupancy/pets + the
  Yardian freeze-prevent entity (a hint there's freeze-sensitive plumbing).
- **Signal:** indoor temp falling toward freezing in winter *despite* the
  system being on (furnace failure) → pipe-burst risk; or freeze-forecast-
  tonight + a zone that runs cold. The heat mirror: HVAC fails in a heat wave
  with pets home.
- **Why only Hearth:** a thermostat alarms on a setpoint miss; it doesn't know a
  freeze is forecast tonight, that the dogs are home, or that the *trend* is
  toward a burst. This is the "smolder" thesis exactly — catch the falling-temp
  ember before the pipe bursts.
- **Effort/deps:** LOW–MED, deterministic trend over existing entities.
- **Failure modes:** a deliberately-lowered setpoint (away/vacation) reads as
  "failure" → needs the away/setpoint context (learn-normal: lowered at night is
  routine). Sensor placement matters (a cold hallway ≠ a cold pipe).
- **Verdict / slice:** **strong, ship early.** First slice = the
  *freeze-tonight + a cold zone + dropping trend* Ember; the furnace-failure
  classification follows once the thermostat-state read is confirmed.

#### A2. Lock-up / departure Rounds `[Rounds]` · Luna
- **Fuses:** the securement vitals — garage cover (`cover.double_bay_isg`), door/
  window contacts (as inventoried), the Ioniq lock + every door/trunk/hood,
  exterior lights — triggered on everyone-departed (`home_departure` reactive
  trigger) or a bedtime slot.
- **Signal:** a SITREP of what's *not* secured at the moment it matters.
- **Why only Hearth:** the cross-domain sweep fused with *who's leaving*. The
  garage-open heads-up already survived the warmth feasibility review as the one
  shippable warm-catch ([kate-warmth-presence]); this generalizes it to the full
  securement set and adds the vehicle.
- **Effort/deps:** LOW–MED. Garage + vehicle are confirmed-readable today;
  full door/window rounds needs the contact-sensor inventory confirmed.
- **Failure modes:** missing contact sensors → an *incomplete* sweep that reads
  as "all secure" (must say what it *can* and *can't* see); don't nag on a
  just-parked open garage (ping on open **+ a reason** — open-too-long+no-motion,
  rain incoming, freeze tonight, late+settled).
- **Verdict / slice:** **the natural first Rounds posture.** Slice = garage +
  vehicle securement on departure/bedtime; expand to door/window as contacts are
  inventoried.

#### A3. Grid-down / power-resilience `[Watch→Response]` · Luna
- **Fuses:** `binary_sensor.honeysuckle_grid_status` (**⚠ verify polarity
  first**) + smart-plug draws (did the freezer drop?) + indoor-temp trend (HVAC
  down) + storm context (Tempest) + occupancy.
- **Signal:** grid down → reason *forward* to consequences (freezer thawing,
  sump unpowered in a storm, HVAC off in a freeze).
- **Why only Hearth:** the causal-chain fusion — power-out is the root; Hearth
  reasons forward across domains. The SITREP-not-cacophony thesis made concrete.
- **Effort/deps:** LOW for the grid-down edge (one sensor, polarity-verified);
  the consequence-reasoning is the Phase-2 synthesizer.
- **Failure modes:** the polarity bug (verify before trusting); a UPS-backed
  router keeps the sensor falsely "up."
- **Verdict / slice:** **grid-down Ember ships now** (polarity-gated); the
  consequence-SITREP rides the synthesizer.

#### A4. Appliance / smolder vitals `[Watch]` · Luna
- **Fuses:** smart-plug power draw (washer/dryer, cabinet ports) + deterministic
  run-time baselines + occupancy.
- **Signal:** a dryer running 3× its normal duration (lint-fire precursor — the
  literal ember); a device drawing power when everyone's away and normally
  wouldn't; an appliance that *stopped* reporting (failed); a sump (if
  plug-monitored) cycling abnormally or not at all during a storm.
- **Why only Hearth:** power-draw *patterns* fused with occupancy + weather. A
  smart plug is dumb; Hearth knows "the dryer's been on 2 hours, 3× normal, and
  no one's home."
- **Effort/deps:** LOW for plug-monitored circuits; baselines need a few weeks
  of data.
- **Failure modes:** limited to what's actually on a monitored circuit (the
  stove/furnace likely aren't); baseline cold-start.
- **Verdict / slice:** **solid, modest, genuinely smolder-flavored.** Scope
  honestly to the monitored circuits; lead with the dryer-overrun + away-draw.

#### A5. Water-leak / flood — **HARDWARE BUY, then a trivial producer** `[Watch→Response]` · Luna
- **The gap:** no indoor leak/flood sensors today (only garden soil-moisture).
  A burst pipe / water-heater / sump failure is a top-cost emergency Hearth is
  **blind to**. This is the single highest-leverage hardware purchase: ~$15–20
  Zigbee/Z-Wave leak pucks by the water heater, under sinks, by the sump, in the
  laundry pan.
- **Fuses (once a puck exists):** the leak `binary_sensor` + occupancy + the
  freeze producer (A1) — frozen→thaw→burst is the canonical chain — + grid (A3,
  sump unpowered).
- **Why only Hearth:** pairs the leak edge with freeze + power + occupancy into
  one chain; a standalone leak alarm beeps in an empty basement.
- **Effort/deps:** the *producer* is trivial (a `binary_sensor` edge → Alarm,
  the exact shape of the CO/smoke-alarm reader). The dependency is the **buy**.
- **Verdict / slice:** **buy the pucks.** The software lights up the moment they
  report. (Same note for a natural-gas/propane detector — another cheap buy that
  closes a real blind spot; AirThings measures CO₂, not combustible gas or CO.)

### Tier B — high value, gated (presence-naming stability or a missing signal)

#### B1. Away + interior-activity intrusion `[Watch→Response]` · Cassandra
- **Fuses:** confirmed-empty occupancy (geofence + WiFi + BLE all empty) + an
  interior/perimeter smart-detect (Protect person / glass-break / motion) +
  door/window contacts + **cpai face-check** (an enrolled member back early, or
  unknown?).
- **Why only Hearth:** the live away-monitor cascade (`camera_watch.ts`) already
  VL-concern-grades away. This *adds* the deterministic contact + confirmed-empty
  + face-disambiguation and a CRITICAL deterrence Response. An alarm panel
  doesn't know your face or that you're 40 miles away.
- **Effort/deps:** MED — builds on live away-monitor + cpai + occupancy.
- **Failure modes:** presence false-"away" (everyone's phone died → the owner
  walking in trips an intrusion) — must fail toward *not* panicking the
  household; cpai false-unknown; security false-positives are socially
  expensive.
- **Verdict / slice:** **builds on live infra, but gate the CRITICAL deterrence
  behind high confidence** (confirmed-away + unknown-face + forced-entry-shaped);
  default the ambiguous case to an Ember ("someone's at the house while you're
  out — here's the clip"), not an Alarm.

#### B2. Hot/cold parked-vehicle heads-up (the "dog in a hot car" family) `[Watch→Response]` · Iris
- **Fuses:** Ioniq telemetry (parked-at-home via GPS, climate OFF, doors closed,
  cabin temp if exposed) + Tempest (outdoor temp, solar radiation, illuminance)
  + time-since-arrival + Anya's dog registry.
- **Why only Hearth:** fuses the *vehicle* + *weather* + *pet registry* — three
  domains no single product spans. A car alarm doesn't know the weather.
- **Honest limit:** Hearth has **no in-car pet-presence signal** (the dogs
  aren't tagged in the car). So the *dog-confirmed* version is blocked; the
  *vehicle-thermal* version ("your car's been parked in the sun 20 min, the
  cabin's climbing past 100°F, climate's off") is feasible and grounded today.
- **Effort/deps:** LOW–MED for the thermal version (verify the Ioniq exposes
  cabin temp; else infer from outdoor temp + Tempest solar + time-parked).
- **Verdict / slice:** **ship the vehicle-thermal Ember.** It escalates to a
  critical Alarm *if* a dog-presence signal ever lands (a BLE collar tag, or the
  user telling Kate "the dogs are in the car"). Lead with the thermal; the
  dog-confirm is the reward.

#### B3. Wellness-by-inactivity / fall detection without a wearable `[Watch→Response]` · Astrid
- **Fuses:** BLE room presence + person/face tracks + camera motion + the
  occupancy belief + Apple Watch (HealthKit) + typical-activity baselines.
- **Signal:** a member is *home* but has shown zero movement across all room
  sensors for an anomalous waking-hours window; or the Watch reports a fall then
  no movement; or a person entered a room and didn't leave with no motion since.
- **Why only Hearth — the crown jewel:** **no single device does this.** A
  pendant must be worn; the Watch's fall-detection needs the watch on-wrist and
  covers only the wearer. Hearth fuses *ambient* room presence with the watch —
  catching the case where the watch is on the nightstand. Passive whole-home
  wellness is the highest-value, most-novel idea here.
- **Effort/deps:** HIGH, and **gated on presence-naming stability** (you must
  know *which* member is unmoving and that they're genuinely home, not
  sensor-stale). Per [kate-warmth-presence] / the presence work, this isn't
  solid yet.
- **Failure modes:** false positives are *frightening* (alarming a fall on
  someone napping/reading-still) and false negatives are *dangerous* (missing a
  real fall). Both bars are unusually high.
- **Verdict / slice:** **most valuable, least shippable-soon.** Start with the
  **lowest-risk slice — the Apple Watch fall-detection *relay*** (the watch
  already detects + can notify; Hearth's value-add is routing it into the
  household surface + "and no one else is home to help"). The ambient-stillness
  version is a research track behind solid presence, not a near-term ship.

#### B4. First-responder roll call `[Response]` · Cassandra
- **Fuses:** the occupancy belief (who's home + last-known room) attached to an
  *existing* critical fire/CO/intrusion Alarm.
- **Signal:** on a critical event, tell the responding adults (and a future 911
  surface) *who* is believed home and where last seen — "Sam and both dogs were
  home; Sam last seen in the basement 8 min ago."
- **Why only Hearth:** it KNOWS occupancy — no smoke detector does. Uniquely
  Hearth, and a genuinely high-stakes payoff.
- **Effort/deps:** MED but **fully gated on presence-naming stability** — the
  roll-call is only as good as the occupancy map, which isn't solid. It's an
  *information payload* on an existing critical, not a new detector → low
  marginal effort once presence lands.
- **Verdict / slice:** **the coarse version ships today** ("someone appears to
  be home" / "the house appears empty" — reliable); the per-person room-level
  roll-call is the reward for the presence work.

### Deliberately deprioritized (named, so they're not re-pitched as novel)
- **Package-theft** (Protect package-detect + porch) — convenience, not safety;
  low priority.
- **Driveway loitering** — the away-monitor already covers it.
- **Dog-left-outside in a freeze/heat** (Anya) — same in-car pet-presence-signal
  gap as B2; needs a door-out + pet signal Hearth lacks.
- **Generic heat-wave / cold-snap** — overlaps A1; a forecast app already does
  the generic version (the warmth-review lesson: don't rebuild his weather app).

---

## 6. The honest hardware gaps (flagged explicitly)

| Gap | Cost | What it unlocks | Verdict |
|---|---|---|---|
| **Indoor water-leak / flood pucks** | ~$15–20 ea | A5 (burst pipe / water-heater / sump) — the **biggest** uncovered top-cost emergency | **Buy first.** Producer is trivial once it reports. |
| **Natural-gas / propane / CO detector on a monitored circuit** | ~$20–40 | combustible-gas + true CO (AirThings is CO₂, *not* CO; cameras only *hear* an existing CO alarm) | Buy; closes a real blind spot. |
| **Straight-on driveway ALPR cam** | UniFi AI Pro-class | reliable plate ID (the existing G4 Domes are too high/oblique — measured: neither the VL nor real ALPR can read plates off them) | Lower safety priority; defer. |
| **In-car pet-presence signal** (BLE collar tag) | ~$30 | upgrades B2 from vehicle-thermal Ember to dog-confirmed Alarm | Optional reward. |

Two polarity / coverage caveats to verify before trusting:
`binary_sensor.honeysuckle_grid_status` (verify which state = power-out before
A3 trusts it) and the `rear_door_*` camera CO/smoke read (was `unavailable` at
the air-driver ship — a coverage gap, not a live source).

---

## 7. The phased build plan — read-only first, earn up the trust ladder

The mandate: start read-only (the synthesizer *narrates* the vitals + proposed
actions), earn up the autonomy/trust ladder (draft → tap → PIN — the COS fusion
spine's ladder, [kate-cos-fusion-spine]) before it actuates.

### Phase 0 — The vitals object (read-only, no alerts, no actuation)
Build `house_vitals` (§3.2): a periodic + on-demand deterministic gather of
occupancy/securement/comfort/air/power/device-health into one typed object, a
read surface (`GET /api/.../vitals`), and a **"House" office pane** (Luna). Pure
narration — "here's the house right now." No new alerts, no HA writes. This is
the safe foundation everything else reads, and it makes the three existing
producers' state legible. **Lowest risk, highest leverage — do this first.**

### Phase 1 — New innate producers (deterministic Embers/Alarms), DARK-by-default, one at a time
Each is a `Driver` on the `EpisodicAlertEngine`, same contract as the live two,
its own `HEARTH_*` flag, device-free smoke, armed individually. **Build order
(Jasper's pick — A2 first): A2 lock-up/departure Rounds → A1 HVAC-freeze → A3
grid-down → A4 appliance-smolder.** A2 is the right first build *and* stays
true to read-only-first — it reads the securement state and narrates; its only
side-effect is the Ember itself. (Phase 0's full vitals object can land in
parallel/just after; A2 reads securement directly via `ha_get_state` and
doesn't block on it.) These *deliver* (push/speak/flash) but do **not** actuate
HA beyond the existing flash. (A5 leak slots in the instant the hardware lands.)

### Phase 2 — The adaptive synthesizer (reasoning; still no actuation)
The `wake_deliberation_scoped` pass that fires on an *ambiguous* anomaly (§3.3):
reads vitals + the deterministic baseline (§3.4), decides benign-vs-real
(learn-normal, kills false alarms), and on a real one composes a **SITREP + a
*proposed* action** — routed as a notification / a **draft-tier gated proposal**,
**never an actuation**. This is where the model enters the loop (LAW #1-clean),
where the SITREP-collapse lives (the shared recent-alert ledger), and where the
false-alarm feedback loop closes (dismissed-stays-dismissed → baseline).
Tier-B's reasoning-heavy producers (B1 intrusion disambiguation, B3 wellness)
graduate here once their gating signal is solid.

### Phase 3 — Response actuation (gated hardest, earns up the ladder)
Per-hazard scenes that **actuate**: egress full-bright path on fire, vent-fan-on
for gas, lights-on deterrence for intrusion, thermostat-bump for freeze, (with
hardware) water-shutoff for leak. Each actuation is the highest-autonomy rung —
**PIN-gated / owner-confirmed initially**, earning toward auto as trust accrues
(the RPG trust-ladder). New actuations follow the flash's fail-safe discipline:
snapshot → act → restore, bounded blast radius, never an LLM tool (a code helper
like `ha_call_service`).

### Hardware track (parallel, independent)
Buy the leak pucks (A5) + the gas detector (§6). Each lights up a trivial Phase-1
producer the moment it reports — no software dependency on the phases above.

**The gate between phases is trust, not time.** Phase 0–1 are safe (read-only +
deterministic alerts the household already trusts from the live two). Phase 2
adds *judgment* but only ever *proposes*. Phase 3 adds *hands*, gated hardest.
Don't let Phase 3 ride ahead of demonstrated Phase-2 judgment quality.

---

## 8. Ownership map + cordon

Detection routes by domain; **Kate is always the voice** (alert ambassador) and
authors any warm/narrative framing.

| Producer / surface | Detection owner | Voice |
|---|---|---|
| Weather, indoor air | Kate (read: Iris for air) | Kate |
| HVAC-freeze, lock-up Rounds, grid-down, appliance, leak, the vitals object + House pane | **Luna** (home systems) | Kate |
| Away-intrusion, first-responder roll-call | **Cassandra** (security) | Kate |
| Hot/cold parked-vehicle | **Iris** (vehicle) | Kate |
| Wellness-by-inactivity / fall | **Astrid** (health) | Kate |
| Dog-specific (deferred) | **Anya** (pet) | Kate |

**Cordon:** alert recipients are `default_home_user_ids` (owner + household;
never friend/synthetic). The vitals object and every new occupancy/security
signal stay cordoned exactly as `get_household_occupancy` is — owner-private,
no new cross-specialist location/security sharing surface.

---

## 9. What makes this *only Hearth* (the one-paragraph pitch)

A smoke detector knows there's smoke. A thermostat knows the setpoint. A car
alarm knows the door opened. A Ring knows there's motion. **None of them know
each other, the weather, who's home, or what's normal here.** Hearth sits above
all of them: it fuses the vehicle + the weather + the pets + occupancy into "the
dog's in a baking car"; it fuses falling-indoor-temp + a freeze forecast + a
sump that just lost power into one SITREP instead of four beeps; it knows the
house is *confirmed* empty so a face at the side door means something; it knows
*who* was home to tell a first responder. And it catches the **ember** — the
small early sign — because it's a continuous regulator that learned this
household's normal, not a row of fixed tripwires waiting for the blaze.

---

## 10. Decisions

**Decided (Jasper, 2026-06-28):**
1. **Name** — system = **HearthGuard**, signal = **Ember Alert** (the
   system/signal split; both layers named). §1.
2. **First build** — **A2, the lock-up / departure Rounds** (the garage-nudge
   generalized to the full securement sweep + the vehicle). §5 A2 / §7 Phase 1.

**Still open (surface when A2 leaves design):**
3. **Hardware** — green-light the **leak pucks** (§6, A5) as the highest-leverage
   buy? (+ optional gas/CO detector.) The producer is trivial once they report.
4. **Presence-gated jewels** — B3 (fall) and B4 (roll-call) stay parked behind
   presence-naming stability, shipping only their coarse/relay slices until
   presence is solid (consistent with the warmth-review discipline).

---

**Scrum roadmap epics (filed 2026-06-28):** umbrella `sep_008bcbm7nwa2` ·
P0 vitals+House pane `sep_h5p96yt72dbd` · P1 innate producers `sep_hxxz0f0y5qz8`
· leak/gas hardware `sep_0mbgr50x71ez` · P2/P3 synthesizer+actuation
`sep_msmzvw1wyw9e`. PLAN.md Tier 2 entry added.

*Cross-refs: [dangerous-weather-alerts], [indoor-air-quality-alerts],
[vision-tier-resilience], [project-vl-camera-capability-envelope],
[kate-warmth-presence], [kate-cos-fusion-spine] (the autonomy ladder),
[project-presence-sensor-fusion-direction] (the presence work the jewels wait
on).*
