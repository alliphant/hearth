# Astrid Live Ride Companion — Laur in your ear, a live activity worth glancing at

**Status:** Tier 1, approved direction (Jasper, 2026-06-10). Phase 0 AND
Phase 1 (backend insight engine + Laur voice clips) shipped same day;
Phase 2 (iOS) next, Phase 3 pending. Decisions locked 2026-06-10: **Opus
only — no lossless/FLAC option** ("opus is fine"); insight engine and
Live Activity both green-lit.
**Repos:** hearth-backend (insight engine, voice clips, push contract) +
hearth-ios (Live Activity, cue playback, Ride Mode view).
**Companions:** the "Live workout state" + "Pipecat retired / direct-client
voice" notes in [the private dev log](../the private dev log); iOS inventory in
`../hearth-ios/ARCHITECTURE.md`.

---

## 1. The ride that motivated this

2026-06-10 evening (Denver): a 106-minute, 36.9 km, 995 kcal ride
(session `06FB8Q5RZAVM5298YTW7NNJBFC`). What Astrid delivered, verbatim from
`users/jasper/astrid/coaching-log.md`:

| When | Cue | Problem |
|---|---|---|
| 0:30 into the ride | "Halfway through. HR's at 142. Don't slow down on me. — A." | **Bug.** Duration baseline was a phantom 0-min "PR" from 2026-06-01. |
| ~1:00 | final_push (suppressed by throttle only) | Same bug. |
| every 15 min ×7 | "15/30/45/61/76/91 min in. Still with you. — A." | Template, zero inference. The user is mid-effort and gets a counter. |
| ride end | "106-min cycling done. 995 kcal. New record on longest seconds. — A." | The "record" was vs. the phantom 0-min session. |
| +0 s | "0-min walking done. 0 kcal. — A." | Phantom auto-detected walking session got a session-end push. |

The asks, in Jasper's words: when she's "with someone active," **infer about
it**; run the app in the background with a **rich, functional, beautiful Live
Activity**; let her **TTS come through** as small cellular-friendly voice
clips; render **dynamic, legible live metrics** for someone on a bike — a
**Tier-1, world-class Strava-esque view, with Laur talking to me**.

## 2. What exists today (review, 2026-06-10)

The plumbing is much further along than the experience suggests:

- **Live data already flows.** `WorkoutMirroringFeeder` (iOS 26+,
  hearth-ios) attaches to Watch-started workouts via
  `workoutSessionMirroringStartHandler` + `HKLiveWorkoutBuilder` and POSTs
  `/api/workout` start/heartbeat(30 s)/end packets (elapsed, kcal, distance,
  HR, zone). HealthKit grants the app background runtime for the whole
  session — **the app process is alive during the ride.**
- **Server keeps a warm row.** [workout.ts](../src/app/routes/workout.ts)
  `WorkoutSessionTracker` + `warm_session_row` → restart-proof
  `query_active_workout`. The Activity pane reads it.
- **Cues are deterministic templates.**
  [live_throttle.ts](../src/specialists/astrid/live_throttle.ts) evaluates 5
  triggers per packet (pr_in_reach / midpoint / final_push / check_in /
  session_end), NO LLM, sends **text-only alert pushes** via `push_text`,
  logs every decision to the coaching log.
- **APNs is real**, including Live Activity scaffolding nobody uses yet:
  [apns.ts](../src/policy/apns.ts) has `push_type: 'liveactivity'`,
  `APNS_LIVE_ACTIVITY_TOPIC`, an `apns_tokens.live_activity_push_token`
  column, and `POST /api/apns/live-activity/register` — wired end-to-end on
  iOS (`registerLiveActivityToken` in HearthClient).
- **iOS already ships five Live Activities** (voice turn, Kate filter, chat
  turn, ingest receipt, pre-commit) with a shared attributes package, deep
  links, and `NSSupportsLiveActivitiesFrequentUpdates: true`. None for
  workouts.
- **iOS already parses a `hearth.workout_cue` push payload** and relays it
  to the Watch (`PushCoordinator.relayWorkoutCueIfPresent`).
- **Laur TTS is one POST away.** `POST /api/voice/tts`
  ([voice.ts](../src/app/routes/voice.ts)) proxies forza `:8023`
  `/v1/audio/speech`, voice `EN_F_Laur` (the CustomVoice fine-tune; supports
  `instruct` emotion). Returns WAV. Nothing in the live path calls it.
- **iOS can play remote audio** — `AudioClipPrimitive` (AVPlayer over a URL)
  exists in the card renderer; `audio` is already in `UIBackgroundModes`.
- **No live UI.** No native workout view; the server pane is 30 s granular
  and not glanceable-on-a-bike.

Gaps, by layer: **inference** (templates only), **voice** (text only),
**surface** (notifications only).

## 3. Phase 0 — shipped 2026-06-10: degenerate-session floors

Three expressions of one root cause — nothing floored phantom sessions:

1. **Write-side floor** in [pr_shelf.ts](../src/specialists/astrid/pr_shelf.ts):
   `MIN_MEANINGFUL_SESSION_S = 120`; `update_shelf` ignores shorter sessions
   entirely (no shelf write, no PR).
2. **Baseline floor** in live_throttle: a `longest_seconds` baseline under
   `MIN_DURATION_BASELINE_S = 600` is treated as absent — midpoint/final_push
   stay silent rather than firing at 0:30. Covers legacy shelves too.
3. **Session-end floor**: a sub-2-min session gets no "0-min walking done"
   push — just a suppressed-decision line in the coaching log.

Plus the latent defect that made #2 possible: the shelf stored only the
display render ("0 min"), and `read_shelf` re-derived seconds from it. The
shelf now writes **exact raw values into a `records:` frontmatter block**
(JSON flow mappings); the body stays the human-readable display; the body
regex survives only as the legacy fallback. Proof:
`bun run smoke:astrid-floors` (22 checks, includes the literal incident
replay).

## 4. Goals and non-goals

**Goals**
- Astrid *infers* mid-workout: cues grounded in the live curve, your
  history, and your PRs — never a bare counter.
- Laur speaks the cues: small, cellular-friendly clips that duck your music
  like a nav prompt.
- A workout Live Activity (lock screen + Dynamic Island) that is the
  glanceable home of the ride.
- A native, Strava-grade Ride Mode view: huge legible type, zone color,
  live charts, Astrid's commentary timeline with replay.

**Non-goals (this arc)**
- No social/segments/leaderboards. Astrid is a coach, not a feed.
- No route upload to the server. Map/route stays on-device (see §10).
- No Watch-native app (the existing cue relay to the wrist stays).
- The deterministic trigger detector stays — we are NOT putting an LLM in
  the per-packet loop.

## 5. Architecture overview

```
Watch workout ──mirror──▶ iPhone WorkoutMirroringFeeder
   │                          │ 30s heartbeats            │ local, 1–5s
   │                          ▼                           ▼
   │                  POST /api/workout            Live Activity (local update)
   │                          │                    Ride Mode view (HKLiveWorkoutBuilder)
   │                          ▼                           ▲
   │                  workout_packet event                │
   │                          ▼                           │
   │              trigger detector (deterministic) ───────┤
   │                          ▼ (on hit, async)           │
   │              insight renderer (LLM, grounded,        │
   │                 fail-open → template)                │
   │                          ▼                           │
   │              Laur TTS (:8023) → ffmpeg → Opus clip   │
   │                          ▼                           │
   │              APNs alert push: hearth.workout_cue     │
   │                 { text, trigger, clip{id,url,…} } ───┘
   │                          ▼
   └◀── Watch cue relay   app fetches clip → AVAudioSession ducks music → Laur speaks
```

Division of labor: **metrics are local** (the phone is the data source —
seconds-granularity via the live builder, no round trip, no APNs budget);
**meaning is server-side** (Astrid's inference, voice, history). The Live
Activity updates locally; the server contributes only cue content.

## 6. Phase 1 — backend: insight engine + voice clips

### 6.1 Trigger vocabulary (expand the detector, keep it deterministic)

Existing five stay. Add, all computed from data already in the tracker +
heartbeat stream (keep a small per-session rolling window in
`LivePushState`):

| Trigger | Fires when | Class |
|---|---|---|
| `zone_shift` | sustained (≥2 min) move into a higher/lower HR zone | effort |
| `distance_milestone` | each N km crossed (default 10 km, configurable) | progress |
| `pace_change` | rolling 5-min pace meaningfully faster/slower than session average | effort |
| `hr_drift` | HR climbing at steady pace (cardiac drift — hydration/fatigue cue) | care |
| `longest_this_month` | elapsed passes the longest comparable session in 30 d (`query_workouts`) | narrative |
| `negative_split_possible` | back half pace within reach of beating front half | narrative |
| `cooldown_detected` | HR falling + pace dropping near session end | wrap-up |

Shipped 2026-06-10 in [insight.ts](../src/specialists/astrid/insight.ts) —
all of the above EXCEPT `negative_split_possible`: without a known planned
duration/distance the "half" anchor is a guess, and a wrong split cue is
the same embarrassment class as the 30-second "Halfway through" bug.
Revisit when `planned_duration_min` adoption is real. Conservatism rule
throughout: a detector missing its signal (no HR, no distance) stays
silent — a missed cue is fine, a wrong cue mid-ride is the failure mode
this design exists to kill.

### 6.2 Grounded render — inference without fabrication

On a trigger hit, instead of the hardcoded string:

- Build an **evidence JSON**: live snapshot (elapsed/HR/zone/kcal/distance/
  pace), the trigger + its computed facts, zone-minute distribution, PR
  shelf (exact values now), and a 30-day comparable-workouts digest from
  `query_workouts`.
- One LLM call, interactive tier (`for_role('live')`, think-off,
  `max_tokens` ~120): Astrid's register, **≤ 2 sentences, spoken prose** —
  it will be TTS'd, so no markdown, no emoji, digits as natural speech
  ("thirty-six k", the renderer prompt owns this).
- **Numeric grounding check (deterministic):** every number in the output
  must appear in the evidence (rounding-tolerant). Fail → fall back.
- **Fail-open contract:** LLM error/timeout/grounding-fail → the existing
  deterministic template sends as text. A coaching beat is never missed
  because inference hiccuped.
- Audit row `astrid_live_insight` (trigger, evidence keys, rendered/fallback,
  latency); coaching log keeps recording every decision.

`check_in` becomes the *last-resort* presence beat: it fires only when no
richer trigger has fired in its window — and the render gives it variety
("Hour one down, HR's been parked in zone 2 the whole way — this is how
base gets built") instead of "61 min in."

### 6.3 Voice clip pipeline — and the honest answer on "lossless"

Render text → `POST http://forza:8023/v1/audio/speech`
(`voice: EN_F_Laur`, `response_format: wav`, optional `instruct` emotion
mapped per trigger-class: effort=encouraging, care=warm-steady,
wrap-up=proud) → **ffmpeg transcode** (the binary is already on the
orchestrator image — the HEIC path uses it) → store →
`GET /api/workout/cues/:clip_id` (owner-cordoned: the session's `user_id`
must equal the caller; strong etag; `cache-control: private, max-age=86400`;
TTL sweep at 48 h; under the existing `/api/workout` namespace so **no nginx
alternation edit**).

Encoding: the TTS source is ~24 kHz mono WAV. **Opus 48 kbps mono in a CAF
container** (iOS decodes Opus-in-CAF natively) is perceptually transparent
for this voice at ~60 KB per 10-second clip — that's the default.
True lossless (FLAC, also native on iOS) is possible and only ~5–8× the
bytes, but it preserves nothing audible over Opus-48 for speech; if wanted,
a `clip_format: flac_on_wifi` user setting is a cheap follow-up, not the
default. AAC-LC 64 kbps is the compatibility fallback if Opus-in-CAF
misbehaves on any surface.

### 6.4 Delivery contract

Extend the **existing** `hearth.workout_cue` push payload (iOS already
parses it for the Watch relay) — APNs alert push, collapse-id per session:

```json
{ "aps": { "alert": { "body": "<cue text>" }, "sound": null },
  "hearth": { "workout_cue": {
    "session_id": "06FB8…", "trigger": "zone_shift",
    "text": "<cue text>", "ts": "<iso>",
    "clip": { "id": "wc_…", "url": "/api/workout/cues/wc_…",
              "duration_s": 9.2, "bytes": 58231, "format": "opus_caf" } } } }
```

Audio is never inlined (APNs 4 KB cap). When the app is alive (it is,
during mirroring) it intercepts via `willPresent`, plays the clip, updates
the Live Activity, and suppresses the banner; if the process is dead the
user still gets the text notification — graceful degrade. Watch relay
unchanged (text + haptic).

### 6.5 Throttle, cadence, mute

- Per-class min-gaps replace the single knob: voice cues default min-gap
  **5 min**; narrative/care triggers can earn priority; `session_end`
  always sends. Hard session cap (default 12 cues) so a noisy detector can
  never chatter.
- **Mute must be real:** the pane's "Silence coaching cues" link gets a
  route — `POST /api/workout/cues/mute { session_id | scope: 'today' }` —
  checked by the engine before any send; surfaced as a button on the Live
  Activity and in Ride Mode.
- Config lives in `users.yaml` `training:` (per-user), not constants:
  `cue_min_gap_min`, `cue_session_cap`, `voice_cues: on|off`,
  `cue_distance_milestone` (in the user's display units).

### 6.6 Kill switches + proof

`HEARTH_ASTRID_INSIGHT=0` (templates only), `HEARTH_ASTRID_VOICE=0`
(text-only pushes). Smokes: extend `smoke:astrid-floors`; new
`smoke:astrid-insight` (mock LLM + mock TTS transport via a
`_test_set_tts_transport` seam, same pattern as APNs `_test_set_transport`)
— trigger matrix, grounding-check rejection, fail-open to template, clip
route cordon, mute.

## 7. Phase 2 — iOS: workout Live Activity + cue playback

- **`WorkoutCompanionAttributes`** in `HearthLiveActivityShared` — static:
  `sessionID`, `workoutType`, `startedAt`; ContentState: `elapsedS`, `hr`,
  `hrZone`, `activeKcal`, `distanceM`, `paceSPerKm`, `latestCue {text, ts,
  speaking}`, `phase (warmup|working|finalPush|ended)`, `prProgress?`.
- **Started locally** by `WorkoutMirroringFeeder` when mirroring begins —
  the app has HealthKit background runtime, so no push-to-start needed on
  the primary path. **Updated locally** from the live builder (frequent
  updates entitlement already present); cue arrivals update `latestCue`.
  On end: final-summary state (duration/kcal/distance/PR ack), dismiss
  after 30 min.
- **Layouts.** Lock screen: workout-type glyph + big elapsed, HR with
  zone-colored capsule, distance + pace row, thin zone-minutes strip,
  Astrid's latest line with a speaking indicator while Laur plays.
  Dynamic Island compact: zone-colored HR + elapsed. Expanded: 2×2 metric
  grid + latest cue + mute button (AppIntent). Tap → `hearth://workout/live`.
- **Cue audio:** a `WorkoutCueAudioPlayer` — download clip (small, fine on
  cellular), `AVAudioSession` `.playback` with `.duckOthers +
  .interruptSpokenAudioAndMixWithOthers`, deactivate with
  `notifyOthersOnDeactivation` so music swells back. Serialize overlapping
  cues; drop a cue older than 60 s rather than queue stale praise.
- **Server registration:** on activity start, send the ActivityKit push
  token via the existing `registerLiveActivityToken` — unused in Phase 2
  (local updates), required for Phase 3 remote start/update.

## 8. Phase 2 — iOS: Ride Mode (the Strava-grade view)

Native SwiftUI, fed by the **local** `HKLiveWorkoutBuilder` statistics
(seconds-granularity — the server's 30 s warm row is for other surfaces)
merged with the Astrid cue feed:

- **Glanceable at 30 km/h:** paged full-screen metric panes (Elapsed ·
  HR+zone · Speed/Pace · Distance · Energy), SF Rounded **monospaced
  digits at 90–120 pt**, zone-colored backgrounds at full saturation,
  high-contrast dark default, `isIdleTimerDisabled` while active, tap
  targets sized for gloves.
- **One dense dashboard page**: 2×3 grid + live HR sparkline (last 10 min)
  + zone-minutes strip.
- **Astrid timeline**: chronological cue feed, each with a replay button
  (the existing `AudioClipPrimitive` pattern), speaking indicator, mute
  toggle.
- Entry: auto-offer when mirroring starts (foreground), Live Activity tap,
  or the Astrid room. Post-ride it becomes the session recap (zone
  distribution, splits, PR acks, Astrid's recap clip).

## 8.5. Phase 2.5 — the Ride Log: every workout browsable, named, and lively

Approved by Jasper 2026-06-11 ("each workout tracked and browsable with
rich, lively sparkline metrics; each ride gets an AI-generated ~10–15
word sentence name; elevation gain most definitely in the inference").
Backend + web shipped 2026-06-11; iOS halves follow in hearth-ios
`feat/ride-companion`.

### 8.5.1 Elevation in the live inference (shipped)

- iOS accumulates positive `CMAltimeter` deltas and ships cumulative
  `elevation_gain_m` on every heartbeat + the end packet (optional
  fields — old builds keep working). The tracker, warm row, and every
  cue's evidence snapshot carry it.
- Two new detectors in [insight.ts](../src/specialists/astrid/insight.ts),
  same conservatism rules (silent without signal): **`climbing`**
  (sustained gain rate ≥6 m/min over 4 min, ≥40 m banked this segment;
  effort; once per segment) and **`climb_crested`** (a ≥60 m segment
  levels off for 2 min; narrative; once per segment). Elevation also
  **suppresses `hr_drift` mid-climb** — rising HR on a grade is the
  grade, not dehydration.

### 8.5.2 Heartbeat time series (shipped)

New `workout_heartbeats` table — one row per 30 s heartbeat (HR, zone,
kcal, distance, elevation), keyed (session_id, elapsed_s) so retries
dedup. This is what detail surfaces draw curves from; before it, only
the warm header row survived the ride.

### 8.5.3 Ride names — three sprinkles of magic (shipped)

At session end (after the PR-shelf update, fire-and-forget so the
session_end cue never waits), [ride_name.ts](../src/specialists/astrid/ride_name.ts)
renders a **~10–15 word sentence name** — "the first line of a very
short story about this exact ride" — grounded in: metrics, elevation,
avg speed, **power band** (Watch-estimated `avg_power_w`, re-scoped IN
by Jasper 2026-06-11 for naming/recap evidence), time-of-day bucket
(dawn/golden hour/dusk/… via the user's tz), **weather** at home
coords (`fetch_brief_weather`, HEARTH_HOME_LAT/LON), and **route
descriptors** when iOS ships them. Same hard properties as cue_render:
numeric grounding (a name that invents "42 km" is rejected) and
fail-open to a deterministic name ("Golden hour cycling — 36.9 km,
412 m up, 995 kcal"). Stored as `workout_sessions.ride_name`; weather
snapshot kept in `end_weather_json` for the detail surfaces.

**Route privacy (§10 still holds):** route_notes are road/place NAMES
only (≤12 strings, derived on-device from HealthKit's saved route +
reverse geocoding) — coordinates never reach the server. This is the
deliberate, bounded exception that lets a name know its roads.

### 8.5.4 Browsable surfaces

- `GET /api/workout/sessions` (+ `/sessions/:id` with the heartbeat
  series + still-live cue texts) — owner-cordoned, one contract for
  both clients; sub-2-min phantom sessions filtered by default.
- **Web `/app/rides` (shipped):** scrum-canvas-pattern static page —
  serif ride names, weather/time chips, metric chips, zone-colored HR +
  elevation sparklines (lazy per-card series loads), zone-minutes bar,
  30-day totals strip, expandable Astrid cue timeline. Client is
  static (deploy = git pull); the API additions ride the orchestrator
  restart.
- **iOS Ride Log (next):** same API, Swift Charts sparkline detail;
  list merged with the workout Live Activity arc in
  hearth-ios `feat/ride-companion`.

## 9. Phase 3 — extensions

- **Push-to-start** (iOS 17.2+; min target is 18): server starts the Live
  Activity via APNs for non-mirrored sessions (pre-iOS-26 devices, phone-
  recorded workouts), and `liveactivity` pushes update it when the app
  process isn't alive. The token plumbing already exists end-to-end.
- **Map page** in Ride Mode — on-device GPS only (§10).
- **Personalized HR zones**: the feeder's hardcoded thresholds (z1<120 …
  z5≥180) replaced by HealthKit-derived max-HR/zones, sent with the start
  packet so server-side zone math agrees with the device.
- **Richer inference**: weather-along-ride (Kate's weather tools), Iris
  route awareness — each gated by an explicit privacy decision.
- **Post-ride recap clip**: session_end renders a 20–30 s grounded recap
  (vs. history, PR context) — Laur's "debrief" — attached to the recap view.
- **hr_zone_minutes persistence**: the heartbeat schema accepts
  `hr_zone_minutes_so_far` but the feeder never sends it (today's warm row
  had `hr_zone_minutes_json: null`) — compute zone-minutes in the feeder so
  live zone strips have data everywhere.

## 10. Privacy & cordon

- Clips and cue text are **user data**: clip files keyed by session →
  `user_id`; the serving route enforces caller == session owner (no
  god-view); APNs audit already never logs message bodies; the coaching log
  is `private_to`-stamped.
- **No location leaves the phone.** Ride Mode's map renders from on-device
  GPS; the server continues to receive only the existing heartbeat fields.
  Any future server-side route awareness is a deliberate
  `config/privacy.yaml` edit, per the location-data rule.
- Multi-user clean by construction: everything keys off the session's
  `user_id`; Sam's ride cues route to Sam's tokens and nobody else's.

## 11. Decisions (resolved 2026-06-10)

1. **Voice cadence** — shipped defaults: 5-min min-gap, 12-cue session
   cap, both per-user tunable via `users.yaml`
   `training.cue_min_gap_min` / `cue_session_cap`. Tune from the
   coaching log, not by intuition.
2. **`check_in`** — kept as the LAST-RESORT presence beat: it fires only
   when no cue of any kind has been sent for a full 15-min interval, and
   it renders through the insight engine like everything else (so it
   gets variety, not a counter). Retire it entirely if the richer
   triggers prove to cover real rides.
3. **Clip quality** — **Opus-48 everywhere, no FLAC setting** (Jasper:
   "Lossless isn't needed, opus is fine"). AAC-LC 64k remains the
   automatic fallback when the container's ffmpeg lacks libopus.
