# Concept — novel uses of the idle local GPU VRAM

**Status:** concepting only. No code in this doc; it's a ranked menu of *new
household-facing capabilities* the freed VRAM makes possible, with honest
feasibility. Pick from it later; nothing here is committed.

**Date:** 2026-06-24. **Author:** Claude (concepting session).

---

## The headroom (verified live, not trusted from notes)

`ssh glacier 'nvidia-smi'`, 2026-06-24:

| GPU | Total | Used | **Free** | Util | What's on it |
|---|---|---|---|---|---|
| **RTX PRO 4000 Blackwell** (idx 0) | 24 GB | 11.5 GB | **~12.4 GB** | **0 %** | RAG only (infinity bge embed+rerank). Reliably idle. Co-located with orchestrator. |
| **RTX 6000 Ada** (idx 1) | 48 GB | 29.4 GB | **~19 GB** | 0 % | 35B-A3B deep+interactive tier (llama.cpp `:8200`) + whisper STT. Free *now*, contended under load. |
| forza GB10 (ARM, separate box) | 128 GB | — | ~67 GB | — | Vision 27B-VL `:8096` + Laur TTS `:8023`. **Cross-arch wall** — can't host x86 containers. |

**The placement model this doc assumes:**

- **Continuous / always-on / latency-critical → Blackwell.** It's the one
  reliably-idle, orchestrator-co-located lane. A 4–8B model (Q4/Q8), a CV or
  audio model, or an embedding model all fit the ~12 GB with KV headroom. **This
  is the prime target — prefer ideas that fit here.**
- **Overnight heavy / bursty batch → Ada off-peak.** The deep tier is idle
  ~01:00–06:00 (the nightly sweeps run sequentially, one specialist/tick; measured
  0 `requests_deferred`). Good for QLoRA training runs and deep batch passes that
  can yield. **Flag the contention risk** — anything here must back off when a
  real deep-tier turn arrives.
- **forza is pinned** by image arch (ARM). Don't plan to move its containers.

## The lens — what makes an idea *qualify* (not just "a sensible use")

The bar is **"I haven't seen anyone do this,"** filtered through Hearth's ethos:

1. **Uniquely enabled by idle LOCAL compute** — it's a capability that's
   *impossible, unaffordable, or unacceptable* in the cloud. Three flavors:
   privacy-impossible (24/7 home audio, the family's messages/health/video),
   cost-impossible (a model thinking continuously over the whole life-stream),
   latency-impossible (a sub-second perception loop). If a cloud API could do it
   cheaply, it's not on this list.
2. **Household-facing** — it becomes a demoable feature the family *values*, not
   a serving optimization. ("Talking to attentive staff," not "lower TTFT.")
3. **LAW #1 clean** — it makes the system *more capable* (a real model deciding
   and acting), never a hard-coded shortcut.
4. **Composes with the stack** — no new datastore (SQLite + vault), fail-open,
   kill-switched, cordon-native.

---

## 1. Ranked shortlist (12 ideas)

Composite-ranked **novelty × feasibility × product-value**. The **§2 distillation**
then collapses these into three slots — **①** a better *model* · **②** an always-on
*reasoner* (ideas 3·4·5·7 are one substrate) · **③** a new *sense*. The **Slot**
column shows where each rolls up (— = below the cut). Idea #s are stable labels, not
the final rank (that's §2).

| # | Idea | Nov | Feas | Value | Slot | GPU |
|---|---|---|---|---|---|---|
| 1 | **The model that learns *your house*** (continuous own-data fine-tune) | ●●● | ●○○ | ●●● | **①** | Ada (train) → Blackwell (serve) |
| 2 | **"The house has ears"** (ambient acoustic perception) | ●●● | ●●○ | ●●● | **③** | Blackwell |
| 3 | **"Something's off"** (household anomaly watch) | ●●○ | ●●● | ●●● | **②** | Blackwell |
| 4 | **Knowledge-base contradiction sentinel** (continuous self-consistency) | ●●○ | ●●○ | ●●○ | **②** | Blackwell |
| 5 | **Ambient cognition loop** (cheap always-on "quiet attention") | ●●● | ●○○ | ●●○ | **②** | Blackwell |
| 6 | **Local meeting / call note-taker** (speech, zero-cloud) | ●●○ | ●●○ | ●●○ | — | Ada (STT) + Blackwell |
| 7 | **"Before you see them"** (relationship-intelligence inference loop) | ●●○ | ●●○ | ●●● | **②** | Blackwell |
| 8 | **Local document intelligence** (VLM-grade OCR for the household's paper) | ●○○ | ●●● | ●●○ | — | Blackwell |
| 9 | **Presence-driven embodied gaze** (the avatar makes eye contact) | ●●○ | ●●● | ●○○ | — | Blackwell |
| 10 | **Family media-archive understanding** (searchable home video/voice) | ●○○ | ●●○ | ●●○ | — | Ada (batch) + Blackwell |
| 11 | **Intelligent cordon firewall** (active local PII-leak guard) | ●●○ | ●●○ | ●○○ | — | Blackwell (1.5–4B) |
| 12 | **Overnight memory consolidation** ("the house sleeps on it") | ●●○ | ●●○ | ●●○ | — | Ada off-peak |

### Per-idea detail

**1 ★ — The model that learns *your house* (continuous own-data fine-tune).**
A weekly QLoRA run on idle local GPU fine-tunes Hearth's *own interactive model*
on the household's accumulated exhaust — the `audit_log`'s **successful tool-call
traces**, Jasper's writing voice, the family's vocabulary and people. The model
gets measurably better at *this* house: the documented #1 pain (the 9B fabricates
"saved it" and won't reliably call `record_relationship` / `set_event_owner` —
`[[toolcalling-reliability-strategy]]`), Jasper's email voice for Phase-4
`draft_email`, and it can finally override base-model format priors (the "no-lists"
ceiling that prompting *cannot* beat — `[[house-voice-feature]]`). A flywheel:
the more the household uses Hearth, the better its private model gets.
- *Workload/VRAM/GPU:* QLoRA of a 4–8B interactive model — ~10–16 GB on the **Ada
  overnight**; serve the merged/adapter model ~6–9 GB on the **Blackwell**. Data
  already exists in SQLite (`audit_log`, `messages`, vault, `jasper_style`).
- *Feasibility/risk:* **real build (weeks).** Risks: training pipeline, quality
  regression / catastrophic forgetting → mitigated by LoRA-not-full-FT, a
  **champion/challenger swap gated by the existing golden-eval harness**, and
  starting narrow (tool-call reliability only). Highest ceiling, highest effort.
- *Why idle LOCAL VRAM uniquely enables this:* you cannot send your family's
  private messages, health, and life to a cloud fine-tuner — and the improving
  model that results is *yours*, getting better in the dark, forever.

**2 ★ — "The house has ears" (ambient acoustic perception).**
The twin of the camera CV stack (`arcface`/`reid`/`cpai`), which today has **no
audio counterpart**. Continuous, local, *non-speech* sound understanding: the
smoke alarm, glass breaking, water running too long, a distressed pet, a knock, a
fall — each fused with what Hearth already knows (occupancy from the belief
estimator, time, room) to *act*: "smoke alarm in the kitchen + everyone marked
away → high-severity push that pierces quiet hours" (the `[[dangerous-weather-alerts]]`
contract, generalized to sound).
- *Workload/VRAM/GPU:* a small sound-event model (BEATs/PANNs/CLAP-class, <1–2 GB)
  on the **Blackwell** for the continuous event layer; optionally escalate
  ambiguous clips to **Qwen2-Audio-7B** (~6–8 GB Q4) for "describe what you hear."
- *Feasibility/risk:* the model is easy; the **real work is the continuous audio
  tap.** Today audio is wake-word-gated on-device (HA Assist); ambient perception
  needs a continuous stream to Hearth (the ESP voice-coordinator / full-duplex AEC
  work shows it's possible — `[[esp-direct-voice-coordinator-bringup]]`). **Real
  build, gated on the audio plumbing + a deliberate privacy decision** (continuous
  mic in common areas). Coverage = wherever mic devices live (today ~the
  Satellite1's room; grows with pucks).
- *Why idle LOCAL VRAM uniquely enables this:* nobody streams their home's 24/7
  audio to a cloud — free local compute is the only way continuous listening is
  both *acceptable* and *affordable*.

**3 ★ — "Something's off" (household anomaly watch).**
Attentive staff notice when something's *unusual*. A cheap always-on model learns
the household's normal rhythm (the `routines` facet, the occupancy belief
estimator, calendar, locations, mail cadence) and gently flags genuine deviations
— "your car's still here at 9:30, no calendar event, you usually leave by 8," "the
garage has been open 3 hours," "no one's heard from Sam on the family thread in 2
days." It *asks*, it doesn't assume (cordon + "ask when uncertain"). It's the
proactivity engine's missing sensor: today proactivity fires on **known** edges (a
birthday, a return window); this fires on **the absence of the expected**.
- *Workload/VRAM/GPU:* a 4–8B reasoner (~6–9 GB) on the **Blackwell**, a
  continuous low-frequency loop over the already-fused signal stream. **No new
  data** — it all flows into Hearth already.
- *Feasibility/risk:* **HIGH feasibility** (data's there; it's a new consumer +
  a "what's normal" representation). Risk: **alarm fatigue** → must be
  high-precision, edge-only, and learn from dismissals.
- *Why idle LOCAL VRAM uniquely enables this:* it can only reason by fusing *all*
  the household's private signals *continuously* — cloud cost (24/7 tokens) and
  privacy (the whole life-stream) both forbid it.

**4 — Knowledge-base contradiction sentinel.**
A continuous pass that scans the vault + the typed knowledge graph for
*contradictions and stale facts* — "the vault says Sam's hairdresser is Rosa,
but a recent message says she switched to Rachel," "this person-note's address
predates a 'we moved' mention." Distinct from Cordelia's `synthesis-heal` (which
checks integrity *of syntheses*); this checks consistency *across the whole graph*
and surfaces confirmations. Directly serves the People-substrate goal of "predict,
not read" (`[[people-reasoning-substrate]]`).
- *Workload/VRAM/GPU:* a small LLM (~4–6 GB) on the **Blackwell**, overnight +
  trickle. Pairs naturally with RAG (already on the same GPU).
- *Feasibility/risk:* real build; risk is precision (a "contradiction" that's
  actually two true facts about different people). Conservative — propose a
  confirmation, never auto-edit.
- *Why idle LOCAL VRAM uniquely enables this:* continuously re-reading the entire
  private knowledge base is token-prohibitive in the cloud; free locally.

**5 — Ambient cognition loop ("quiet attention").**
Today Kate *thinks* only on a scheduled heavy-tier deliberation (a few times a
day) or on a turn. A cheap always-on small model runs a continuous low-stakes
reasoning loop over the live signal stream — noticing, drafting candidate
proactive nudges, pre-forming "what might Jasper ask next" — and **only escalates to
the 35B when something's worth it.** The difference between staff who think when
you ring the bell and staff who are always quietly paying attention. (Ideas 3, 4,
and the relationship loop in 7 are arguably *applications* of this one substrate.)
- *Workload/VRAM/GPU:* a 4–8B model (~6–9 GB) on the **Blackwell**, always
  resident, low duty cycle.
- *Feasibility/risk:* the engine is straightforward; the **hard part is taste** —
  what's worth surfacing vs noise. Best built *after* one concrete consumer (3) so
  it has a sharp first job.
- *Why idle LOCAL VRAM uniquely enables this:* "a model that just keeps thinking
  about your life" is a non-starter on metered cloud tokens; free idle compute
  makes ambient cognition's marginal cost ~zero.

**6 — Local meeting / call note-taker.**
The speech sibling of idea 2: when a conversation or call happens in the home
office, Hearth transcribes + diarizes + extracts decisions and action items
locally, then fuses them into the people/calendar graph — "Kate, what did we decide
on the call?" → real notes, action items already drafted as follow-ups. Otter-class
*as a feature*, but **100 % local and graph-aware**, which is the whole point for
private/work calls.
- *Workload/VRAM/GPU:* whisper (already on the **Ada**) for STT + a small LLM
  (~4–6 GB) on the **Blackwell** for live summary/action-item extraction.
- *Feasibility/risk:* real build; shares the "continuous/triggered audio tap"
  dependency with idea 2 (build the tap once, both ride it). Diarization quality is
  the main unknown.
- *Why idle LOCAL VRAM uniquely enables this:* recording and machine-reading your
  meetings is exactly what you *won't* send to a cloud; local makes it usable.

**7 — "Before you see them" (relationship-intelligence inference loop).**
The People substrate already *observes* (deterministic `person_observers` intake)
but the *inference* (turn raw observations into predicted relationship facts, life
events, and conversation prep) runs only on the heavy tier, nightly. A dedicated
small model on free VRAM runs that inference **continuously** — powering the
canonical "Sam's cut is 4pm, date night 6pm, leave by 5:35" prediction chain and
a "before you see them" brief ("you're seeing Rachel today; last time she'd just
started a new job — ask how it's going"). Directly advances a stated Jasper priority
(`[[people-reasoning-substrate]]` Tier-3 B).
- *Workload/VRAM/GPU:* a 4–8B reasoner (~6–9 GB) on the **Blackwell**.
- *Feasibility/risk:* real build; the primitives exist (calendar + location +
  travel + the relates-to graph). Risk: prediction precision; ask-don't-assume
  discipline.
- *Why idle LOCAL VRAM uniquely enables this:* the inference fuses the entire
  private relationship graph + presence + calendar — cloud-prohibitive on both
  cost and privacy.

**8 — Local document intelligence (VLM-grade OCR for the household's paper).**
An **upgrade** to the existing PaddleOCR sidecar (`ocr.ts`): a small document-VLM
(Florence-2 ~0.5–1.5 GB, or GOT-OCR2 ~3 GB) gives fast, accurate, *structured*
extraction from the household's paper — mail, receipts, handwritten notes,
whiteboards, school/medical/financial forms, appliance manuals — feeding Cordelia's
intake and search. Also fixes the forza VL's confident fabrication on
hard reads (it invents license plates — `[[project-vl-camera-capability-envelope]]`)
by giving OCR a *dedicated, honest* path instead of a chatty general VLM.
- *Workload/VRAM/GPU:* tiny, easily fits the **Blackwell**.
- *Feasibility/risk:* **weekend-to-real.** Lower novelty (OCR exists everywhere),
  but the *local document-intelligence-into-the-graph* framing is the value.
- *Why idle LOCAL VRAM uniquely enables this:* medical/financial paper is exactly
  what you don't OCR in the cloud.

**9 — Presence-driven embodied gaze + expression.**
The VTuber face already ships (`[[project-kate-embodied-presence]]`; P3 explicitly
wants presence-driven gaze). A tiny fast vision model on the Blackwell, watching a
camera near the display, drives the face to **look at whoever's speaking** and
react to expressions — eye contact in real time. High delight, very demoable.
- *Workload/VRAM/GPU:* a face-mesh/gaze model is sub-1 GB on the **Blackwell**;
  latency-critical (must be <100 ms), which a local loop nails and a cloud
  round-trip cannot.
- *Feasibility/risk:* **weekend** for a first pass; risk is the camera placement +
  the eeriness/uncanny line. Lower household *value* (polish, not utility).
- *Why idle LOCAL VRAM uniquely enables this:* a sub-100 ms perception→render loop
  is impossible over a cloud hop, and a camera pointed at the family's faces stays
  in the house.

**10 — Family media-archive understanding.**
Point the existing STT + a small LLM at the household's *media* — old home videos,
voice memos, the captures library — to make it **searchable by content**: "find the
video where the dog first came home," "what did that voice memo from the hardware
store say?" The face-clustering stack can auto-tag people across the photo archive
in the same pass.
- *Workload/VRAM/GPU:* whisper batch on the **Ada** off-peak + a small summarizer
  on the **Blackwell**.
- *Feasibility/risk:* real build; mostly a batch pipeline + index. Bounded by how
  much media is actually on the box.
- *Why idle LOCAL VRAM uniquely enables this:* family video → cloud is a hard no.

**11 — Intelligent cordon firewall (active local PII-leak guard).**
Makes the data cordon *provable* (`[[provable-cordon-concept]]`) by adding an
*intelligent* boundary: a small model checks every outbound action (a `web_search`
query, a `web_fetch`, push text) for accidental private-data leakage *before* it
leaves — "this search query you assembled contains Sam's medical condition; drop
it?" Privacy as an active, reasoning boundary, not just a static rule.
- *Workload/VRAM/GPU:* the 1.5B (or a 4B) on the **Blackwell**; latency-sensitive
  (it's inline on outbound calls) — local is mandatory.
- *Feasibility/risk:* real build; risk is over-blocking (must fail-*open* to "warn,
  don't block," or it breaks legitimate searches). Narrower value than the top
  ideas, but it's the literal embodiment of the cordon ethos.
- *Why idle LOCAL VRAM uniquely enables this:* the privacy guard itself must be
  trusted and local — sending data to a cloud "is this private?" checker defeats
  the purpose.

**12 — Overnight memory consolidation ("the house sleeps on it").**
A biologically-inspired nightly pass: replay the day's events, consolidate them
into long-term structured memory, strengthen the knowledge edges that mattered,
prune noise, and generate "what mattered today/this week." Broader than Cordelia's
shelf-synthesis (which is library-corpus-scoped) — this is **whole-household**
episodic→semantic consolidation across presence, people, calendar, and captures.
- *Workload/VRAM/GPU:* a mid model on the **Ada** off-peak (it's heavy but
  nightly).
- *Feasibility/risk:* real build; overlaps existing synthesis machinery (reuse it,
  don't fork). Risk: defining "what mattered" without it becoming a generic digest.
- *Why idle LOCAL VRAM uniquely enables this:* nightly whole-life replay is
  cost-prohibitive on cloud tokens; free off-peak GPU makes it routine.

---

## 2. The ranking, distilled

**Full ranking** (composite): **1.** Own-data fine-tune · **2.** "Something's off"
(anomaly watch) · **3.** "The house has ears" (audio) · **4.** "Before you see them"
(relationship loop) · **5.** Ambient-cognition substrate · **6.** Contradiction
sentinel · **7.** Meeting note-taker · **8.** Document intelligence · **9.** Memory
consolidation · **10.** Media-archive · **11.** Cordon firewall · **12.** Embodied gaze.

**The distillation insight:** ranks 2, 4, 5, and 6 are *not four ideas — they are
one*. Anomaly-watch, the relationship-prediction loop, the contradiction sentinel,
and "ambient cognition" are all the **same mechanism** — a cheap, always-on local
model reasoning continuously over the household's fused private signal stream — with
different objective functions bolted on. Collapse that, and the twelve fall into
**three conceptually-distinct ways to spend the idle VRAM** — a better *model*, an
always-on *reasoner*, and a new *sense*:

- **① A better brain** — the own-data fine-tune (idea 1).
- **② A mind that's always on** — the always-on reasoner (ideas 3·4·5·7); first jobs
  "something's off" + "before you see them".
- **③ A new sense** — ambient acoustic perception (idea 2).

Each spends the VRAM a *different* way (fine-tune + serve · continuous reasoning ·
continuous perception), so they're complementary, not competing.

**Build-order ≠ rank.** Fastest visible win is **②** via anomaly-watch (every signal
already flows in — no new plumbing). Highest ceiling + compounding (it makes ② and ③
better too) is **①**, but it's weeks + regression risk. Most genuinely-new is **③**,
but it's gated on a continuous-mic decision. The rank below favors uniqueness ×
ceiling (① first); if you want a *working feature this month*, start with ②.

---

### ① The model that learns *your house* — *a better brain*

**The product story.** Hearth's interactive model is a generic small LLM today. It
doesn't know your house, and it shows: it *fabricates* "I saved that" instead of
calling the tool, it won't reliably fire `record_relationship` / `set_event_owner`
even when forced-decoding nudges it, and it physically cannot stop emitting numbered
lists no matter how the prompt is written (a base-model prior that *prompting
cannot override* — three escalating attempts failed, per `[[house-voice-feature]]`).
Every one of those is a **model-capability** gap, and LAW #1 says the fix is to make
the model more capable — not to keep bolting on forcing logic and guards around it.

The unlock: **fine-tune the model on the household's own exhaust, weekly, on idle
local GPU.** The training data already exists and is already the right shape —
`audit_log` is a clean record of *successful* tool calls (the exact
intent→tool→args pairs the model keeps fumbling), `messages` carries the
conversation register, the vault carries the people/places/vocabulary, and
`jasper_style` carries his email voice. A LoRA over that corpus produces a model
that's *demonstrably better at this house*: more reliable tool-calling, Jasper's
voice for Phase-4 `draft_email`, the family's names and idioms, and — because
fine-tuning *can* move format priors where prompting can't — finally less listy.

And it's a **flywheel the family can feel**: the more they use Hearth, the better
its private model gets, every week, in the dark. That's a genuinely new product
posture — not "an AI you query" but "an AI that grows into your household."

**Why this is the flagship.** It's the most *uniquely-local* idea on the list (you
literally cannot cloud-fine-tune on a family's private corpus), it attacks the
*single most-documented open pain* in the whole system, it's LAW #1 in its purest
form, and the **regression guard already exists** — the golden-task eval harness
(`src/core/evals`) was built precisely to catch behavior regressions and already
gates autonomy graduation. A fine-tune is exactly the kind of change it's meant to
police.

**First-prototype sketch (a weekend spike, narrow):**
1. **Export** N successful tool-call traces from `audit_log` (filter to clean
   `execution_result`, no errors) → format as instruction/response pairs
   (conversation context → the tool call the model *should* have made).
2. **Train** a QLoRA on a small base (start with a 4B to keep the Ada run short)
   with unsloth/axolotl, overnight on the Ada (deep tier idle ~03:00–05:00).
3. **Gate** champion-vs-challenger: run the existing golden-eval harness on both
   the current served model and the LoRA. Promote *only* if the challenger wins on
   tool-call assertions **without** regressing the honesty/grounding tasks.
4. **Serve** the winning adapter on the Blackwell behind a flag; keep the champion
   one swap away. Start with **tool-call reliability only** — prove the loop before
   adding voice/vocabulary objectives.

**Risks, honestly:** training quality + catastrophic forgetting (mitigate: LoRA not
full-FT, small rank, the eval gate, champion/challenger). It's weeks to a real
production loop, not a weekend — the weekend gets you the *spike that proves the
data and the gate*.

---

### ② Quiet attention — *the mind that's always on*

**The product story.** The best chiefs of staff notice the dog that *didn't* bark —
and they're always quietly paying attention, not just when you ring the bell. Today
Kate *reasons* only on a scheduled heavy-tier deliberation (a few times a day) or on a
turn; between those, the live signal stream goes unwatched. This is **one** cheap
model, always resident on the Blackwell, running a continuous low-stakes loop over the
*already-fused* stream (presence belief, routines, calendar, location, mail, the
people graph) — noticing, drafting candidate nudges, escalating to the 35B only when
something's worth it. Its two flagship jobs:

- **"Something's off" (anomaly-watch)** — the missing *sensor* for proactivity. Today
  proactivity fires on **known** edges (a birthday 14 days out, a warranty window, a
  vacation that needs flights); it has no sense for **the expected thing that didn't
  happen** — the car still in the driveway long past the usual departure, the garage
  open for hours, the family member gone unusually quiet. It **asks, doesn't assume**
  ("your car's still here and nothing's on your calendar — running late, or want me to
  do anything?").
- **"Before you see them" (relationship prediction)** — the People substrate already
  *observes* (deterministic `person_observers` intake); the *inference* runs only
  nightly on the heavy tier. Run it continuously and you get the canonical "Sam's cut
  is 4pm, date night 6pm, leave by 5:35" chain and a "you're seeing Rachel today — last
  time she'd just started a new job, ask how it's going" prep. This is the stated
  "predict, not read" north star (`[[people-reasoning-substrate]]`).

(The contradiction sentinel — "the vault says Rosa's the hairdresser but a recent
message says Rachel" — is the same engine pointed at the knowledge graph. One
substrate, many objectives.)

**Why it's #2 — and arguably the one to build first.** Highest *feasibility* of the
three: **the data already flows into Hearth**, so this is a new *consumer* plus a
"what's normal" representation, not new plumbing, and it rides the existing
cross-signal / delivery-window machinery (`scan_cross_signals`, `delivery_window.ts`).
It serves Jasper's explicitly-stated People-anchor priority. The one hard part is
*taste* — anomaly-detection lives or dies on precision; a false "something's off" is
worse than silence. That's a tuning problem, not an architecture one.

**First-prototype sketch:**
1. **Baseline**: derive a per-person normal-rhythm profile by extending the existing
   `routines` facet (typical departure/arrival, message cadence, room-by-hour from the
   belief history).
2. **Score**: a low-frequency loop (hourly + a nightly pass) on the Blackwell — a cheap
   4–8B reasoner judging "is this a meaningful deviation, given the calendar and who's
   home?" / "what's worth prepping before today's people-events?"
3. **Gate hard**: only a high-confidence, *dismissable* nudge ships, through the
   existing cross-signal / delivery-window path (respects quiet hours, meetings,
   presence).
4. **Learn from dismissals**: a dismissed nudge teaches the baseline "not worth
   flagging" — precision self-improves, and (full circle) those dismissals are training
   data for **①**.

**Risks:** alarm fatigue is the killer → ship "watch-desk only" first (surface on a
pane, don't push), graduate only the high-precision classes to push. Cold-start: the
baselines need a few weeks of history — say so, don't fabricate confidence early.

---

### ③ "The house has ears" — *a new sense*

**The product story.** Hearth already *sees* continuously — the camera CV stack
(face + body re-ID + the occupancy belief estimator) is one of the system's
crown jewels. It is **deaf.** Sound is the household's richest untapped real-time
signal, and the most safety-relevant: smoke and CO alarms, glass breaking, water
running far too long, a hard fall, a pet in distress, a knock at a door no camera
covers. A local audio model gives Hearth continuous *non-speech* sound
understanding, and — this is the part nobody ships — it **fuses each acoustic event
with everything Hearth already knows** before it acts. "Smoke alarm in the kitchen"
is an alert; "smoke alarm in the kitchen *and the belief estimator says everyone's
away*" is a high-severity push that pierces quiet hours and maybe a call. That
fusion is only possible because the ears are *inside* the agent, not a standalone
sensor.

**Why it's #3, not higher.** The *model* is cheap and easy. The honest gating
factor is **plumbing + a privacy decision**: today audio is wake-word-gated
on-device, so a continuous stream doesn't flow to Hearth yet (the ESP
voice-coordinator full-duplex work proves it's buildable —
`[[esp-direct-voice-coordinator-bringup]]`), and "a mic that's always listening in
common areas" is a deliberate household choice, not a default. Coverage starts at
~one room (the Satellite1) and grows with mic devices. That's a real build with a
real dependency — hence #3 — but the capability is genuinely new and
the safety value is high.

**First-prototype sketch:**
1. **Tap** one continuous mic stream (Satellite1 / the voice coordinator) → 1-second
   windows.
2. **Classify** each window with a small sound-event model resident on the
   Blackwell (BEATs/PANNs/CLAP-class, <2 GB) — alarm / breakage / water / impact /
   bark / knock / speech-present.
3. **Edge-detect** with the existing reactive-trigger discipline (threshold +
   debounce + min-interval; edge-only, fail-open, kill-switched) so a steady
   dishwasher hum doesn't re-fire.
4. **Fuse + act**: on a flagged edge, pull occupancy belief + time + room, and route
   through the existing escalation/push path (`[[dangerous-weather-alerts]]` is the
   exact contract — deterministic, edge-only, pierces quiet hours only when
   warranted).
5. **(Later)** escalate genuinely-ambiguous clips to Qwen2-Audio-7B for a
   "describe what you hear" second opinion before alerting.

**Risks:** false positives on safety events erode trust fast → start in *observe-only*
mode (log + show on Cassandra's watch desk), earn the right to push. The continuous
mic is a privacy line — make it owner-opt-in per device, and note it's the same
"local-only is what makes this acceptable" argument as the cameras.

---

## 3. Rejected / lower-value (so they're not re-litigated)

**Already ruled out in the brief — restated so they stay closed:**
- **More llama.cpp slots (`-np 4`)** — measured 0 slot pressure; no benefit.
- **fp16 / larger KV** — no quality gap that needs it.
- **Small critic/judge offload** — bake-off TESTED + REJECTED (a 9B over-flags
  abbreviations/acronyms 6/8 vs the 35B's 8/8; no slot pressure → zero upside,
  real false-positive regression). Critics stay on the 35B.
- **Small VL for forza-resilience** — resilience-of-existing, not a new capability.
- **Speculative-decode draft model** — serving optimization, not household-facing.

**New, and deliberately *not* recommended:**
- **A "de-list" post-generation reformatter** (reflow the 9B's lists → prose, the
  non-prompt lever from `[[house-voice-feature]]`). It's a real UX fix, but it's a
  cosmetic patch around a *model* limitation — exactly what idea 1 fixes at the
  root (a fine-tune *can* move the format prior). Build the fine-tune; don't spend a
  resident model on papering over the symptom.
- **Speculative pre-computation of likely next user needs** (pre-warm the calendar,
  pre-draft the reply). Latency optimization, not a new capability — and risks doing
  work the user never asked for. Out of scope by the lens.
- **Continuous self-eval harness on the GPU** (run the golden tasks 24/7 to catch
  regressions instantly). Internal quality loop, not household-facing; and it's
  cheap to just *schedule* nightly (already does). Doesn't need resident VRAM.
- **Offline-resilient full local voice** (STT+TTS+LLM all on the Blackwell so the
  house keeps talking when forza/internet is down). Genuinely useful, but it's
  resilience of an *existing* capability, lower novelty — fold it in opportunistically
  if a small local TTS lands, don't headline it.
- **A generic "second model for overflow / a local chatbot"** — that's the
  serving-optimization framing the brief explicitly excludes. The VRAM should buy a
  *new capability*, not more of the same inference.

---

## 4. Recommendation

The distilled three are complementary layers — **① a better brain · ② an always-on
mind · ③ a new sense** — so the real plan is "all three, in order," not "pick one."
If forced to sequence:

- **Build first → ② (quiet attention), starting with the anomaly-watch app.** Fastest
  path to a *working, visible* feature: every signal already flows into Hearth, it
  rides the existing cross-signal / delivery-window machinery, and it serves Jasper's
  stated People-anchor priority. Ship it "watch-desk only," earn the right to push.
- **Invest in parallel → ① (the own-data fine-tune).** Highest ceiling, most
  uniquely-local, and it *compounds* — a household-tuned model makes ② sharper and ③'s
  escalations smarter. The weekend spike (export `audit_log` traces → QLoRA a 4B →
  champion/challenger on the existing golden harness) is cheap and decisive: the
  challenger either beats the champion on tool-call reliability or it doesn't, and
  you'll know in one run. Worth starting now precisely because it's the long pole.
- **Commit when ready → ③ (the house has ears).** The most genuinely-new capability,
  but gated on a continuous-mic decision + the audio-tap plumbing — budget *that* as
  the real cost, not the model.

A scrum epic for **①** is already filed under the **roadmap** project,
`product_backlog` lane. Given the re-rank, **②** is the strongest candidate for a
second epic — say the word and I'll file it.
