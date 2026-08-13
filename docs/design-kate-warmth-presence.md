# Design — Kate's warmth & felt presence (push + Satellite1)

**Status:** DESIGN / IDEATION ONLY — nothing in here is built. This is a
prioritized catalog of opportunities to give **Kate** (chief-of-staff
specialist + the household's voice ambassador) more *warmth* and a felt sense
of *presence* across two surfaces: **iOS push notifications** (APNs) and the
**in-home Satellite1 speaker(s)** (Kate's cloned "Laur" voice via the voice
coordinator).

**Date:** 2026-06-24 · **Author:** Claude (ideation session) · **Companion:**
[design-tempest-weather-integration.md](design-tempest-weather-integration.md)
(the alarm-tier sibling), [design-per-user-model.md](design-per-user-model.md),
[design-reactive-triggers.md](design-reactive-triggers.md).

**Owner taste calls captured for this doc (2026-06-24):**
- **Ambient voice at home: MODERATE** — a few warm moments/day, read-the-room
  gated. Feels looked-after, not chatty.
- **Push persona: YES, full person-presence** — pushes should render as a
  *message from Kate* (avatar + name, iMessage-style) via Apple Communication
  Notifications.
- **Scope: OWNER-FIRST, then expand to household** — tune on Jasper, then roll
  the same per-user machinery out. Cordon-respecting by construction.
- **Top warm moments: (1) daily rhythm, (2) welcome-home & "by the way",
  (3) warm weather heads-ups.** ("I noticed / I handled it" was *not* picked —
  it stays in the catalog but ranks lower.)

---

## 0. The thesis: presence is a budget, not a feature

A great human chief-of-staff makes their presence felt **without being noisy**.
You know they're there — a warm good-morning, a "your 2pm moved, I already told
them you'd be five late," a quiet "drive safe, it's icing up" as you grab your
keys — and you almost never notice them *interrupting* you. That asymmetry is
the whole design problem. Warmth that pesters isn't warmth; it's the cry-wolf
failure the dangerous-weather work was built to avoid, pointed at the everyday.

So this doc treats unprompted presence as a **scarce budget** spent against a
felt-value bar, and it leans hard on three things the repo already believes:

1. **Two tiers, never conflated** (the prompt's load-bearing distinction):
   - **ALARM tier** — deterministic, tone + pierce-quiet-hours, the model is
     never consulted. This already exists: `DangerousWeatherDriver`
     ([src/core/dangerous_weather.ts](../src/core/dangerous_weather.ts)) +
     the EAS/`critical` + soft-`notice` tones in
     [tones.py](../integrations/voice-coordinator/tones.py). **Out of scope to
     re-propose; in scope as the structural template.**
   - **WARM-PRESENCE tier** — soft/no tone, respects quiet hours **and** the
     read-the-room delivery window, opt-in-feeling, and **Kate-authored** (see
     #2). This is what this doc designs.
2. **Trigger is deterministic; the warm LINE is the model's** (LAW #1 — the
   `feedback-dynamic-not-hardcoded` memory). The alarm tier hard-codes its text
   because safety can't wait on the model. Warmth is the *opposite* case: a
   templated "Good morning ☀️" is the un-warm, un-AI thing. The architecture is
   **deterministic edge-detection → a scoped, grounded Kate turn that AUTHORS
   the line** in her house-voice, from verified context, per-recipient. Warmth
   is exactly where the LLM register, the per-user model, and `house_voice`
   should shine — never a magic-string greeting.
3. **Warmth is per-person; the owner has no god-view** (the cordon). Kate
   authors *for the speaker/recipient*, grounds in *their* facets and *their*
   private context, stamps `private_to`, and presence-at-home keys on *whose*
   phone is home. Owner-first build, household-shaped from day one.

### The presence budget, concretely

A single shared ledger caps unprompted **warm-tier** touches so the whole
system can't collectively pester, even as we add moments:

- **Default ≤ 3 unprompted warm touches/user/day**, configurable
  (`HEARTH_WARMTH_DAILY_CAP`). The daily-rhythm greeting + an arrival moment +
  one weather heads-up is a *full* warm day. Anything past the cap silently
  drops to the next surface or waits.
- **Edge-only + debounced + rate-limited per moment-kind** (mirrors the
  reactive-trigger contract — `wake_deliberation_scoped`'s dedupe/min-interval).
- **Routed through the read-the-room delivery window** (see §3) so warmth lands
  when you're receptive, not at 6:58am or mid-meeting.
- **Alarm tier is exempt** from the budget and the window — safety always
  delivers. The two ledgers never touch.
- **One global kill switch** (`HEARTH_WARMTH=0`) + per-moment flags, all
  fail-open to today's behavior.

This is the spine every catalog item below plugs into.

---

## 1. What already exists (build on, don't re-propose)

The repo is already warm in a dozen quiet ways. The catalog *composes* these;
it does not re-invent them.

| Machinery | What it gives warmth | Gate / file |
|---|---|---|
| **`status_flavor`** — live typing-bubble gerund + chat-bubble status | Kate *feels* like she's thinking about your specific thing | `HEARTH_STATUS_FLAVOR` · [status_flavor.ts](../src/core/status_flavor.ts) |
| **`voice_emotion`** — inferred TTS `instruct` word (warm/reassuring/upbeat/…) on the Laur fine-tune | Spoken replies carry felt emotion | `HEARTH_VOICE_EMOTION` · [voice_emotion.ts](../src/core/voice_emotion.ts) |
| **`house_voice` + `user_style`** — warm/economical register, per-user learned | Kate talks like a person, the way *you* like | `HEARTH_HOUSE_VOICE` / `HEARTH_USER_STYLE_LEARN` · [house_voice.ts](../src/core/house_voice.ts) |
| **Per-user model / facets** — style/interests/routines, nightly-learned | Warm lines are grounded in *your* life | `HEARTH_USER_MODEL` · [user_model.ts](../src/core/user_model.ts) |
| **Morning brief** — Kate's deliberation output at 07:00/12:30/18:00/22:00, grounded + `brief_critic`-checked | The substance a daily-rhythm warm line distills from | [deliberation.ts](../src/core/deliberation.ts) · [kate.yaml](../config/specialists/kate.yaml) |
| **`promise_followup`** — promised work delivered back, spoken on Satellite1 | "I said I'd look into it, and I did" | [followups.ts](../src/core/followups.ts) |
| **`DangerousWeatherDriver` + tones** — the alarm tier + edge/rate-limit/fail-open template | The structural pattern the warm tier mirrors | `HEARTH_DANGEROUS_WEATHER` · [dangerous_weather.ts](../src/core/dangerous_weather.ts) |
| **Reactive triggers** — `home_arrival`/`home_departure` edges → scoped deliberation wake | The arrival-edge spine for welcome-home | `HEARTH_REACTIVE_TRIGGERS` · [reactive_triggers.ts](../src/core/reactive_triggers.ts) |
| **Voice coordinator `/speak`** — presence-gated (LD2450 "present + ≤2.5m, else push"), optional `pre_tone` | The "speak if you're here, text if you're out" delivery contract | [integrations/voice-coordinator](../integrations/voice-coordinator) |
| **Live Activities** — 5 types already shipped (chat turn, voice turn, workout companion, pre-commit, Kate filter), iOS 18 min | The ambient lock-screen/Dynamic-Island surface already exists | `HearthLiveActivities/` (iOS) |
| **VRM "VTuber face"** — idle + eased emotion + amplitude lip-sync, mirror/kiosk ambient mode | An embodied ambient presence surface, live at `/app/face` | `project-kate-embodied-presence` memory |

**The warm-presence tier is mostly an orchestration + delivery-craft layer over
this stack, not new intelligence.**

---

## 2. The delivery surfaces today — affordance baseline

### 2a. Push (APNs) — what ships now vs. what warmth needs

The pipeline ([push.ts](../src/policy/push.ts) → [apns.ts](../src/policy/apns.ts))
is solid but **minimal**. Today's `aps` payload sets only:

```jsonc
{ "aps": {
    "alert": { "title": "Kate", "body": "…" },   // title = capitalized specialist or "Hearth"
    "sound": "default",                            // or null (silent, e.g. Astrid clip cues)
    "category": "kate.brief",                      // 7 categories, NO action buttons yet
    "thread-id": "<related_id>",                   // inconsistently set
    "badge": 1
  },
  "hearth": { "route": { "kind": "brief", "id": "…" } }  // deep-link
}
```

**Not set today** (all are warmth levers): `interruption-level`,
`mutable-content`, custom `sound`, `relevance-score`, any sender/avatar fields.
Severity → quiet-hours threshold + priority header (`high` ⇒ priority 10,
pierces quiet hours). `severity: 'high'` is the only quiet-hours-piercing path
and is reserved for flights + dangerous weather. **Warm-tier pushes are
`low`/`medium`** and must never pierce.

iOS client reality ([PushCoordinator.swift], [HearthAppDelegate.swift]):
APNs registration + deep-link routing + Live Activities are **built and live**.
**Communication Notifications, a Notification Service Extension, notification
action buttons, and custom sounds are ABSENT.** Deployment target is **iOS 18**,
so every API below is available without availability gymnastics.

### 2b. Voice (Satellite1) — what ships now

`POST /speak { text, conversation_id, summary, pre_tone? }` →
`present_and_near()` gate (LD2450 mmWave, ≤2.5m default) → if present, optionally
play `pre_tone` (`'notice'` soft chime / `'critical'` EAS tone) then TTS in
Laur's voice; if away/error, **fall back to push**. `voice_emotion` supplies an
`instruct` word at TTS time. This contract is exactly right for warm ambient
moments — it already says "speak if you're here, otherwise text you." The warm
tier needs **one addition: a gentle `'warm'` pre-tone** (a soft single note,
distinct from the alarm `'notice'` chime) for the rare warm moment that wants a
tiny attention cue, and the discipline that **most warm voice moments use NO
tone at all**.

---

## 3. Cross-cutting infrastructure (the shared spine)

These aren't user-facing "moments" — they're the plumbing every moment rides.
Build first; they're cheap and they make everything else safe.

### W0a — `WarmPresenceDriver` + the warm-tier severity lane
**What:** A sibling of `DangerousWeatherDriver`: a deterministic edge-detector
that, on a genuine false→true moment edge, fires a **scoped Kate turn** to
author the warm line (grounded, `brief_critic`/fact-critic gated), then delivers
it via the warm tier (`severity: 'warm'` — a *new* lane below `low` that **never
pierces quiet hours**, always routes the delivery window, counts against the
presence budget). Reuses `wake_deliberation_scoped` (debounce + min-interval +
deep-tier), the reactive-trigger fail-open contract, and the existing audit
chokepoint.
**Why warmth:** Centralizes the cry-wolf discipline so no individual moment can
re-derive it (the meta-loop-noise lesson). One place owns "is this worth
spending presence on, right now, for this person."
**Data/affordances:** the moment edge + a verified grounding context (life_context
pack already exists) + the recipient's facets/register.
**Feasibility:** the pattern is proven (danger driver, reactive triggers). The
new bits are the `'warm'` severity lane in [push.ts](../src/policy/push.ts) +
the presence-budget ledger.
**Noise/cordon:** the budget + window + edge-only live here; the turn authors
`private_to` the recipient.
**Effort: M.**

### W0b — Reconcile the "read-the-room delivery window" with the push pipeline
**What:** A read-the-room delivery-window gate exists for proactive nudges
(`HEARTH_DELIVERY_WINDOW`, shipped with the Kate-COS proactivity polish
2026-06-21 — see the `kate-cos-fusion-spine` memory), but the **core push
pipeline ([push.ts](../src/policy/push.ts)) does NOT route through it** — it only
does quiet-hours threshold queueing (the push.ts audit confirmed "no delivery
window gate exists" in the pipeline itself). Generalize the window into a gate
that the warm-tier `deliver_or_queue` consults so warm pushes inherit
read-the-room timing instead of firing the instant quiet hours lift (today a
queued batch dumps at 07:00).
**Why warmth:** Timing *is* warmth. A greeting at the right minute is warm; the
same words at the wrong minute are noise.
**Effort: S–M** (mostly wiring an existing gate into a new code path).
**Aside (out of scope, worth a Tier 4 ticket):** the push.ts audit also found a
real bug — `scan_system_health` *comments* "severity high punches quiet hours"
but calls `push_text()` which hard-codes `'medium'`, so infra-down alerts never
actually pierce. Not a warmth item; flagging so it's not lost.

---

## 4. The catalog

Each item: **what · why warmth · data/affordances · feasibility ·
noise/quiet-hours/cordon · effort.** Items are tagged ⭐ where they map to the
owner's picked priorities (daily rhythm, welcome-home/"by the way", warm
weather). Effort legend: **S** ≈ hours–1 day · **M** ≈ 1–3 days · **L** ≈ 3+
days / new target / Apple approval.

### Group 1 — The platform unlock & notification craft

#### W1 — Push as a *message from Kate* (Communication Notifications) ⭐ unlock
**What:** Render every Kate push as an iMessage-style **message from a person** —
her avatar on the left, "Kate" as the sender, lock-screen styling — via Apple's
Communication Notifications (`INSendMessageIntent` + `INPerson` + `INImage`,
donated inside a Notification Service Extension). Byproducts: Siri can **announce
it on AirPods/CarPlay/HomePod**, and it can **break Focus by *who it's from***
(separate from urgency).
**Why warmth:** Research's verdict — the single biggest warmth lever iOS offers.
It moves Kate from "an app pinged me" to "Kate texted me." It's the foundation
that makes every other push moment land warm, and it's exactly the owner's
chosen "full person-presence."
**Data/affordances:** server adds `"mutable-content": 1` + sender fields
(`sender-name`, a small pre-rendered avatar thumbnail URL/blob) to the warm-tier
payload; client adds a **new Notification Service Extension target** + the
**`com.apple.developer.usernotifications.communication` managed capability**
(needs Apple approval — *request early*) + Info.plist `INSendMessageIntent`
entries. Kate's avatar already exists (`/app/api/avatars/:id`).
**Feasibility:** well-trodden; iOS 18 min covers the iOS-15 API floor. The NSE
also unlocks W2/W3/W4 (rich media, mutable content). The one schedule risk is
the managed-capability approval — kick it off day one.
**Noise/quiet-hours/cordon:** the *framing* is warm; **severity still governs
intrusiveness** (warm-tier stays `passive`/`active`, never pierces). Per-user:
the donated `INPerson` is Kate (the sender), the recipient is the device owner —
no cross-user leak. This also auto-restores the warm **group-summary line**
("Kate · 3 updates") that `summaryArgument` used to give before iOS 15 killed it
(the system derives it from the donated sender).
**Effort: M** (client) + **S** (server) + approval lead time.

#### W2 — Kate's signature chime + the interruption-level dial
**What:** (a) Ship a soft branded `.caf` chime (≤30s, referenced by filename) so
Kate's warm pushes have *her* sound, not the system ding. (b) Set
`interruption-level` per moment: **`passive`** for ambient FYIs (silent, goes to
the summary), **`active`** for normal warm notes, **`time-sensitive`** reserved
for the rare must-see (e.g., "leave now to make your 2pm" — no Apple approval
needed), and **never `critical`** in the warm tier (that's the alarm tier's
already-approved lane).
**Why warmth:** A consistent gentle chime is a recognizable presence cue; the
interruption dial lets warmth be *ambient* by default and only occasionally
*present*, which is the whole moderate-presence posture.
**Data/affordances:** a bundled sound file (client) + `sound` + `interruption-level`
keys in the payload (server). No entitlement for passive/active/time-sensitive.
**Feasibility:** S on both ends. Pairs naturally with W1's NSE.
**Noise/cordon:** the interruption-level *is* the noise knob; warm tier defaults
`passive`/`active`. No cordon surface.
**Effort: S.**

#### W3 — "Reply to Kate…" + tap-actions on the notification
**What:** Register `UNNotificationCategory` actions, including a
`UNTextInputNotificationAction` ("Reply to Kate…") so you can answer a warm push
*from the lock screen* without opening the app, plus contextual buttons
("Snooze," "Tell me more," "👍"). Background-action handlers round-trip the reply
into the conversation.
**Why warmth:** Two-way presence. A push you can *reply to* is a conversation,
not a billboard — it's the difference between a person and a noticeboard.
**Data/affordances:** category-action registration (client) + an endpoint to
accept the inline reply (mostly exists — it's a conversation message). The push
already carries `category`.
**Feasibility:** S–M client; the reply round-trip is the work.
**Noise/cordon:** inline reply is owner-initiated; reply text is `private_to` the
sender by construction.
**Effort: M.**

#### W4 — Rich avatar/weather-glyph attachment (the W1 fallback / subset)
**What:** Attach an image (Kate avatar, or a weather glyph for a weather
heads-up) to the notification via the NSE (`UNNotificationAttachment`). If W1's
managed capability is delayed, this is the **"subtle" path** the owner listed as
a fallback — avatar presence without full message-from-a-person framing.
**Why warmth:** A face/glyph is warmer than text alone; it also makes weather
heads-ups (W9) glanceable.
**Data/affordances:** the same NSE as W1 + a small image URL in the payload.
**Feasibility:** S once the NSE exists (it's the same target as W1).
**Effort: S** (incremental on W1).

### Group 2 — Daily rhythm ⭐ (owner's #1 pick)

#### W5 — Warm morning greeting ⭐
**What:** Once a day, in the **read-the-room morning window** (not a fixed
6:58am), Kate sends a short, genuinely-personal good-morning — distilled from the
**07:00 brief she already authors** (grounded + `brief_critic`-checked): the one
thing that matters today, a small win, what's on the calendar, the weather worth
knowing. One warm line, not the full brief. Delivered as a W1 message-from-Kate
push; **spoken on the Satellite1 instead if you're already up and near it**
(presence gate).
**Why warmth:** This is the archetypal chief-of-staff moment — you wake up and
someone who's thinking about your day has already framed it for you. It's the
highest-felt-value, lowest-marginal-cost item because the substance already
exists.
**Data/affordances:** the existing morning brief + `house_voice`/facets for the
register + the delivery window + presence gate. Kate **authors** the line (LAW
#1), grounded in the verified brief context — no template.
**Feasibility:** High reuse. New work = the warm-line distillation turn + window
routing + the surface choice (voice-if-present-else-push).
**Noise/quiet-hours/cordon:** one/day, counts against the budget, never before
the morning window opens. Per-user — each person's greeting is *their* brief,
`private_to`. (Sam's greeting omits EV per her facets, etc.)
**Effort: M.**

#### W6 — Evening wind-down ⭐
**What:** The bookend: a brief, warm evening note (from the 18:00/22:00 brief) —
tomorrow's first thing, anything that needs a decision before bed, a genuine
"nice work today" when the day's signals support it. Quieter than the morning
(`passive` interruption level), spoken on the Satellite1 if you're home and
near.
**Why warmth:** Closing the loop on the day is what makes presence feel
*continuous* rather than transactional.
**Data/affordances:** same as W5, evening brief slot.
**Feasibility:** Falls out of W5's machinery almost for free.
**Noise/cordon:** `passive`/quiet, budget-counted, never pierces; per-user.
**Effort: S** (incremental on W5).

### Group 3 — Welcome-home & "by the way" ⭐ (owner's #2 pick)

#### W7 — Welcome-home moment ⭐
**What:** On the **`home_arrival` edge** (which already wakes a scoped
deliberation — today routed to Luna), add a **Kate subscription** that, when
you've been out a meaningful while, gives a warm welcome-home **spoken on the
Satellite1 if you're present-and-near**, otherwise a soft push. Tuned: not every
trip to the mailbox — debounced, away-duration-gated.
**Why warmth:** The "oh, you're home" beat is deeply human presence. Reuses the
exact reactive-trigger spine the repo already runs for arrival edges.
**Data/affordances:** the `home_arrival` TriggerDef + `reactive_triggers.ts`
subscription on Kate + the `/speak` presence gate. The line is Kate-authored from
context (what's waiting, what's relevant now).
**Feasibility:** the trigger fires today; this adds a Kate subscription + the
warm-line turn. Genuinely incremental.
**Noise/cordon:** edge-only + away-duration threshold + min-interval (already in
the trigger contract); per-arriving-user (whose phone crossed the edge), spoken
only if *that* person is the one near the speaker.
**Effort: M.**

#### W8 — The single most-useful "by the way…" on arrival ⭐
**What:** Bundled with W7 (or standalone): when you walk in, Kate surfaces **at
most one** genuinely-useful heads-up — "your package is at the door," "trash goes
out tonight," "you've got 20 min before you said you'd leave for dinner" — chosen
by felt-value, never a list. Silent if nothing clears the bar.
**Why warmth:** This is the *competence* half of presence — a chief of staff who
notices the one thing, not the assistant who reads you a digest.
**Data/affordances:** the arrival turn already has Kate's full context (calendar,
inbox, household signals); the design constraint is **ruthless selection** (one,
or none). The fact/data-denial critics already keep it honest.
**Feasibility:** M — the hard part is taste-tuning the "is this worth saying"
bar, not the plumbing.
**Noise/cordon:** one-or-none, counts against the budget; per-user context only.
**Effort: M** (shares W7's turn; the work is the selection discipline).

### Group 4 — Warm weather heads-ups ⭐ (owner's #3 pick)

#### W9 — The warm weather tier (`WarmWeatherDriver`) ⭐
**What:** The non-emergency sibling of `DangerousWeatherDriver`: deterministic
edge-detection on **benign** weather changes → a Kate-authored warm heads-up.
The discussed-but-unbuilt tiers (captured here as the candidate set):
| Tier | Edge | Surface | Example line (Kate authors) |
|---|---|---|---|
| **Rain starting** | nowcast precip < ~15 min away | speak-if-present / soft push | "Rain's about ten minutes out — grab anything on the porch." |
| **Dry window** | a 12h+ gap < 20% precip ahead, *and* you've got outdoor stuff | speak/push, daytime | "You've got a dry stretch from 2 to midnight — good window for the yard." |
| **Hard freeze tonight** | overnight low < ~25°F + vulnerable plants/pipes | daytime push (heads-up, not urgent) | "Hard freeze tonight — worth covering the tender plants." |
| **All-clear** | active warning clears (danger keys drop) | speak-if-present / push | "That storm warning's expired — you're clear." |
**Why warmth:** This is presence as *looking out for you* — the gentle,
non-alarming weather attentiveness a good household manager has. Distinct from
the alarm tier by tone (soft `'warm'` chime or none, **never the EAS tone**) and
by never piercing quiet hours.
**Data/affordances:** Tempest + Pirate Weather are already wired for the danger
driver (reuse the readers). Adds the benign-edge predicates + the dry-window /
freeze logic. **Unlike the danger driver, the warm tier AUTHORS via Kate** (LAW
#1) — safety must template, warmth must not.
**Feasibility:** High structural reuse of the danger driver; the new work is the
benign predicates + Kate authoring + the `'warm'` pre-tone.
**Noise/quiet-hours/cordon:** edge-only, rate-limited, budget-counted, never
pierces; tied to the *household* (weather is shared) but delivered per-present-user.
**Effort: M.**

### Group 5 — Ambient voice presence (moderate dial)

#### W10 — Ambient good-morning / "you're around" on the Satellite1
**What:** The voice expression of W5/W7 — when you're **present and near** in the
morning, Kate *speaks* the greeting rather than pushing it. The "moderate"
posture: the morning greeting + the occasional welcome-home + a genuinely-useful
"by the way," and otherwise silence. No idle chit-chat.
**Why warmth:** A voice in the room is the most present a household member gets.
Moderate cadence keeps it warm, not clingy.
**Data/affordances:** `/speak` + presence gate (built) + the W5/W7 lines. This is
a *delivery-surface choice* on existing moments, not a new moment.
**Feasibility:** S–M — mostly routing warm moments to voice-when-present.
**Noise/cordon:** the budget governs frequency; present-and-near is the gate;
spoken only to whoever's there (no broadcasting one user's note to a room with
someone else — see Open Questions on multi-occupant rooms).
**Effort: S–M.**

#### W11 — Deepen the warm voice (emotion + a gentle `'warm'` pre-tone)
**What:** Lean on `voice_emotion` so warm moments carry a genuinely warm
`instruct` (the fine-tune already supports it), and add a soft single-note
`'warm'` pre-tone to [tones.py](../integrations/voice-coordinator/tones.py) —
used sparingly, distinct from the alarm `'notice'` chime — for the rare warm
moment that wants a tiny "Kate's about to say something" cue. Most warm voice
moments use **no** tone.
**Why warmth:** Timbre is half of spoken warmth; a recognizable gentle cue makes
the speaker feel like *Kate*, not a PA system.
**Data/affordances:** `voice_emotion` (built) + a ~0.4s synthesized note in
tones.py.
**Feasibility:** S.
**Effort: S.**

### Group 6 — Proactive "looked-after" presence (lower priority — not picked)

#### W12 — "I noticed…" cross-signal nudges
**What:** Surface Kate's cross-signal observations ("you've got three calls
stacked back-to-back Thursday — want me to space them?") as warm-tier touches.
The `HEARTH_CROSS_SIGNAL` "I noticed" machinery already exists (Kate-COS
proactivity); this is about giving its output a warm delivery surface + the
budget/window discipline.
**Why warmth:** Presence as *attention* — Kate watching the seams of your life.
**Why lower:** the owner didn't pick it; cross-signal already partly ships. Fold
in once daily-rhythm + arrival land, so it inherits the budget rather than adding
to noise.
**Effort: S–M** (delivery + budget wiring over existing detection).

#### W13 — "I handled it" follow-through landings
**What:** When a `promise_followup` (or a gated action Kate took) lands, deliver
a warm "done — here's what I did" via W1, spoken if present.
**Why warmth:** Reliability you can *feel*. The strongest trust-builder.
**Why lower:** partly exists (`promise_followup` already speaks back); this is
warming the wording + routing through the new tier.
**Effort: S** (mostly register + surface, machinery exists).

### Group 7 — Ongoing / ambient surfaces

#### W14 — A "Kate is on it" / storm / EV-charge Live Activity
**What:** Reuse the **already-shipped** Live Activity infra for an ambient
presence card: a "Kate is on it…" status while a deep-research / follow-through
runs, a storm tracker during the alarm tier, an EV-charge or workout companion
(workout already has one). Push-to-start (iOS 17.2+, app is 18) lets the backend
materialize the card without the app foregrounded.
**Why warmth:** Persistent, glanceable "she's working on it" presence on the lock
screen / Dynamic Island — presence without a single notification.
**Data/affordances:** the iOS Live Activity targets exist; needs the
`apns-push-type: liveactivity` payload + token capture (the APNs `node:http2`
path already exists). A new `ActivityAttributes` per card type.
**Feasibility:** M — the infra is built; each card type is incremental.
**Noise/cordon:** Live Activities are opt-in-feeling by nature (you glance, they
don't interrupt); per-user.
**Effort: M** per card type; **L** if remote push-to-start + budget tuning.

#### W15 — The embodied VRM face as ambient presence (note — mostly built)
**What:** The VRM "VTuber face" at `/app/face` (idle + eased emotion + amplitude
lip-sync, mirror/kiosk mode) is a genuine ambient presence surface on a wall
display. The warmth hook: drive its emotion from `voice_emotion`/`status_flavor`
on warm moments, and have it speak the W5/W7 lines in kiosk mode.
**Why warmth:** A face is maximal presence. Already P1+P2 shipped (see
`project-kate-embodied-presence`).
**Why a note, not a build:** the surface exists; this is about *feeding* it warm
moments. Captured so it's part of the presence story, not re-proposed.
**Effort: S** to wire warm moments into the existing face; the P3 fluid-emotion
work is its own track.

#### W16 — Watch / CarPlay ambient presence (near-free via Live Activity `.small`)
**What:** iOS 18's `.supplementalActivityFamilies([.small])` puts an existing
Live Activity on the **Apple Watch Smart Stack with no Watch app**, and iOS/macOS
26 extends the same to CarPlay + the Mac menu bar. A "Kate is on it" or
welcome-home card appears on the wrist/dash automatically.
**Why warmth:** Glanceable presence everywhere you are, for almost no marginal
work once W14 exists.
**Effort: S** (incremental on W14).

### Group 8 — The learning substrate

#### W17 — A per-user *warmth profile* facet
**What:** Extend the per-user model (`FACET_REGISTRY`) with a `warmth_profile`
facet that learns each person's calibration — how much ambient presence they
welcome, preferred cadence, which moment-kinds they engage with vs. dismiss —
from their reactions (replies, dismissals, snoozes, opt-outs). Feeds the
presence budget + window per-user.
**Why warmth:** Warmth that *learns your tolerance* is the difference between a
good chief of staff and a great one. It's also how "owner-first → household"
scales without hand-tuning each person.
**Data/affordances:** the per-user model + observers (built) + a feedback signal
from notification engagement (needs the W3 action handlers / dismissal
telemetry).
**Feasibility:** M — the facet is cheap; the engagement-signal plumbing is the
work.
**Noise/cordon:** the most cordon-sensitive item — it's a model *of the person*;
strictly `private_to`, never cross-user, owner has no view of Sam's warmth
profile.
**Effort: M** (defer until W3 gives a feedback signal).

---

## 5. Recommended sequencing

Weighted to the owner's picks (daily rhythm · welcome-home/"by the way" · warm
weather), and to maximizing reuse before new platform work.

### Phase 0 — Spine (do first; cheap, makes everything safe)
- **W0a** `WarmPresenceDriver` + the `'warm'` severity lane + presence budget.
- **W0b** route warm pushes through the read-the-room delivery window.
- **Kick off the W1 managed-capability request with Apple in parallel** (long
  lead time; nothing else blocks on it).

### Phase 1 — Quick wins (high felt-value, high reuse)
- **W5 / W6 — Daily rhythm** ⭐. Distills the brief that already exists. The
  single highest value-per-effort item.
- **W7 / W8 — Welcome-home & "by the way"** ⭐. Rides the arrival edge that
  already fires. Add a Kate subscription + the selection discipline.
- **W11 — `'warm'` pre-tone + voice emotion** (S; makes voice moments land warm).
- **W2 — Kate's chime + interruption dial** (S; pairs with W1's NSE when it lands;
  the chime alone is shippable independently).

These four give a *complete* warm day on the surfaces the owner cares about,
mostly from existing machinery, before any Apple-approval dependency.

### Phase 2 — The platform unlock (the felt-presence leap)
- **W1 — Push as a message from Kate** ⭐ unlock (once the capability is
  approved). Retroactively warms every Phase-1 push.
- **W4 — Rich avatar/glyph attachment** (incremental on W1's NSE; also the
  "subtle" fallback if approval drags).
- **W9 — Warm weather tier** ⭐. Reuses the danger driver's readers + structure.
- **W10 — Ambient voice routing** for the Phase-1 moments (S–M).

### Phase 3 — Two-way + ambient + learning (bigger plays)
- **W3 — Reply-to-Kate + actions** (enables the W17 feedback signal).
- **W14 / W16 — Live Activity presence** + the near-free Watch/CarPlay views.
- **W13 — "I handled it" landings** warmed through the tier.
- **W17 — Per-user warmth profile** (once W3 gives engagement signal) — and the
  **owner-first → household** rollout of the whole tier.

### Deferred / fold-in
- **W12 "I noticed"** — fold into the tier once Phase 1–2 land, so it inherits
  the budget instead of adding noise.
- **W15 VRM face feeding** — wire warm moments into the existing face opportunistically.

---

## 6. Open questions (taste calls to resolve before/at build)

1. **Multi-occupant rooms.** When two people are near a Satellite1, whose warm
   moment may Kate speak? Proposal: speak only *household/shared* warm lines
   aloud when >1 person is present; deliver *personal* lines via push. Needs the
   presence layer to expose occupant identity (it can — face/BLE/body-ReID), and
   a clear cordon rule. **Confirm the rule.**
2. **Greeting cadence floor.** Is a *daily* morning greeting right, or should it
   skip days with nothing worth saying (silence as a feature)? Leaning:
   skip-when-empty beats a forced "good morning, nothing's up."
3. **`time-sensitive` for warm moments.** Should *any* warm moment ever be
   `time-sensitive` (breaks Focus, no Apple approval), e.g. "leave in 5 to make
   your 2pm"? Or is that already the alarm-adjacent line warm tier shouldn't
   cross? Leaning: a tiny allowlist of *logistics* moments may use it; pure
   warmth never does.
4. **Critical-alerts entitlement for the alarm tier.** Out of this doc's warm
   scope, but the dangerous-weather tier currently relies on `severity: 'high'`
   (priority 10) rather than the `critical` interruption level + the
   `com.apple.developer.usernotifications.critical-alerts` entitlement (which
   bypasses the mute switch and Focus). Worth a separate decision — it's the only
   way a true emergency wakes a silenced phone.

---

## 7. Effort summary

| ID | Item | Surface | Effort | Priority |
|---|---|---|---|---|
| W0a | WarmPresenceDriver + warm severity lane + budget | infra | M | spine |
| W0b | Read-the-room window in push pipeline | infra | S–M | spine |
| W1 | Push as message-from-Kate (Communication Notifications) | push | M + approval | ⭐ unlock |
| W2 | Signature chime + interruption dial | push | S | high |
| W3 | Reply-to-Kate + tap-actions | push | M | phase 3 |
| W4 | Rich avatar/glyph attachment | push | S (on W1) | phase 2 |
| W5 | Warm morning greeting | both | M | ⭐ |
| W6 | Evening wind-down | both | S (on W5) | ⭐ |
| W7 | Welcome-home moment | both | M | ⭐ |
| W8 | "By the way…" arrival heads-up | both | M (on W7) | ⭐ |
| W9 | Warm weather tier (WarmWeatherDriver) | both | M | ⭐ |
| W10 | Ambient voice routing | voice | S–M | high |
| W11 | `'warm'` pre-tone + voice emotion | voice | S | high |
| W12 | "I noticed" cross-signal nudges | push | S–M | fold-in |
| W13 | "I handled it" landings | both | S | phase 3 |
| W14 | "Kate is on it" Live Activity | push/LA | M | phase 3 |
| W15 | VRM face feeding | face | S | opportunistic |
| W16 | Watch/CarPlay ambient (Live Activity `.small`) | LA | S (on W14) | phase 3 |
| W17 | Per-user warmth profile facet | infra | M | phase 3 |

**Proposed env flags** (all fail-open to today): `HEARTH_WARMTH` (master),
`HEARTH_WARMTH_DAILY_CAP`, `HEARTH_WARMTH_MORNING` / `_EVENING` / `_WELCOME_HOME`
/ `_WEATHER`, reusing `HEARTH_VOICE_EMOTION` / `HEARTH_HOUSE_VOICE` /
`HEARTH_USER_MODEL` / `HEARTH_DELIVERY_FENCE` as they exist.

**Smokes to add when built** (per repo standard): a `smoke:warmth-presence`
covering the budget ledger, edge-only firing, window routing, fail-open, kill
switch, and per-user cordon — mirroring `smoke:dangerous-weather` /
`smoke:reactive-triggers`.

---

*End of design. Nothing here is implemented. Strongest near-term plays for a
build prompt: **W0a+W0b (spine) → W5/W6 (daily rhythm) → W7/W8 (arrival) →
W9 (warm weather)**, with the **W1 Apple capability request kicked off in
parallel** since it gates the biggest felt-presence leap.*
