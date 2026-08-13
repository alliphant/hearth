# Reactive trigger layer — event-driven specialist waking

*Status: increment 1 shipped 2026-06-18 (spine + `home_arrival` → Luna). Increment 2
(migrate the polling passes) tracked in PLAN.md Tier 2.*

## The problem: a cron tick is a poll, not "live"

Hearth's 18 specialists react to the world on a **fixed clock**. Across the roster
that's ~28 scheduled deep-tier deliberation passes/day (`proactive.deliberation_at`),
plus per-specialist `background_jobs` on cron slots. Two costs:

1. **Most passes are polls that find nothing.** "Did anything change in my domain
   since the last slot?" → usually "no." Eleanor's garden doesn't change between her
   06:30 and 18:30 passes; Anya's pet records don't change daily. The pass still runs
   — a full persona, the tool surface, a structured JSON envelope demand.
2. **They fire as a burst.** 07:00 wakes Kate + Iris + half the roster simultaneously
   — the same thundering herd that starved interactive chat/voice on the shared GPU
   slot until background work was moved to forza.

The owner's framing: *"it's not really 'live' if these are just scheduled actions."*
Correct. A cron tick is a **poll**. "Live and autonomous" means the system reacts to
the event the poll was checking for, the moment it happens. The fix is
**polling → subscription**.

## What is NOT the problem: the specialist decomposition

Collapsing the roster into fewer, broader specialists is the wrong lever. The
decomposition is load-bearing:

- The small local model (Qwen) drops tool-call args past ~15 tools on a surface. The
  whole `tools_for_chat` / `dynamic_tools` / `tools_for_voice` curation machinery
  exists to keep each persona's surface narrow enough that tool calls stay reliable.
  A broad generalist regrows the surface and walks back into that wall.
- The per-user privacy cordon rides `knowledge_scope`.

Per turn, "many narrow specialists" is the *efficient* shape. The waste is entirely
in the **scheduling**, which is what this layer fixes — and for once the live thing
and the efficient thing are the same: most domains change rarely, so wake-on-change
is far fewer passes than 2–4 polls/day each, AND it spreads them across real events
instead of a 07:00 herd.

## Design: generalize the spine that already exists

This is not a new paradigm. Three mechanisms in the tree are already event-driven —
`ReactiveInboxDriver` (capture → route → intake), `LiveSynthesisDriver` (capture →
re-distill a shelf), and `LoopDriver.wake_deliberation` (inbox flag → off-schedule
deliberation). The reactive trigger layer **generalizes `wake_deliberation`** the
same way `LiveSynthesisDriver` generalized the nightly distill: its only trigger
source today is an inbox flag; we extend the sources to the sensor/event streams
already flowing.

### One shared fire path

`LoopDriver.wake_deliberation_scoped(id, { task, reason, dedupe_key, debounce_ms?, min_interval_ms? })`
([src/core/loops.ts](../src/core/loops.ts)):

- **Debounce** per `(specialist, dedupe_key)` — a burst of the same edge collapses to
  one pass (the timer resets on each call).
- **Per-key min-interval** rate-limit — a re-fire of the same key inside the window is
  dropped, so a condition that stays true (or re-edges quickly) can't thrash.
- Fires `deliberate()` at slot `trigger:<dedupe_key>` carrying a **`TriggerContext`**
  (`{ reason, task }`) that replaces the standing "scheduled reflection / be
  conservative" prelude with scoped framing ("⚡ You were woken because X — focus this
  pass on Y"), keeping the rest of the prompt (trust tiers, inbox, envelope shape).
- Inherits `deliberate()`'s per-specialist serialization chain + the 300 s timeout
  backstop + the **deep tier** (`specialist_deliberation` role). A flood of triggers
  can never contend with the interactive tier.

### Edge detection once, fan out to subscribers

`ReactiveTriggerDriver` ([src/core/reactive_triggers.ts](../src/core/reactive_triggers.ts))
subscribes once to the `AppEventBus`. A **`TriggerDef`** owns the typed matching +
edge-detection for one world change:

```ts
interface TriggerDef {
  name: string;                                  // matches a YAML subscription's `def:`
  event_types: ReadonlyArray<AppEvent['type']>;  // which bus events it inspects
  detect(event, deps, state): { dedupe_key, reason } | null; // false->true world edge, else null
}
```

A def runs **once per event** — the edge is a world fact, not a per-specialist fact —
then the wake fans out to every specialist whose YAML `proactive.triggers` subscribes
to that def, each with its own scoped `task`. (Two specialists subscribing to
`home_arrival` share one edge but get two scoped passes. Per-def edge state lives in a
driver-held map so a level — a still-true condition — can't re-fire.)

**Why a `TriggerDef` registry and not a YAML expression.** Matching/edge logic lives
in typed TS — the repo's existing idiom (awareness handlers, intake handlers are
code-registered + YAML-opted-in). A YAML mini-expression language ("when ==
'away->home'") would be an eval foot-gun and couldn't express stateful edges or
derived conditions. The YAML stays declarative (*which* trigger, *what* task, *what*
params); the predicate is typed and testable.

### Two entry points, one fire path

- **Push path** — the `ReactiveTriggerDriver`, for signals that already arrive as
  `AppEventBus` events (a location packet, a routed capture, a workout start).
- **Probe path** — `AwarenessObservation.wake_self = { task, dedupe_key, reason? }`,
  for conditions with **no push event** (a refill date crossing, a market threshold).
  The specialist's cheap awareness handler (already on an interval) edge-detects and
  asks to wake its own deliberation through the same `wake_deliberation_scoped`. The
  tick is the edge detector; the expensive deliberation fires only on the edge.

## Guardrails (all mirror existing contracts)

- **Edge-triggered, not level** — fire on false→true only; per-`(sid, key)` state.
- **Debounce + per-key min-interval** — reuse the LiveSynthesis/escalation patterns.
- **Deep-tier only** — inherits `deliberate()` routing; never the interactive tier.
- **Live ≠ noisy** — no new push path. A woken pass that surfaces nothing pushes
  nothing; what it surfaces still flows proposal/interrupt → `push.ts`
  `deliver_or_queue` → `should_dispatch_now` (quiet hours + per-user threshold). The
  autonomy is in the reacting; the restraint is in the speaking.
- **Fail-open** — a throwing `TriggerDef` is logged and skipped, never propagated to
  the bus.
- **Kill switch** — `HEARTH_REACTIVE_TRIGGERS=0` makes `attach` a no-op → byte-
  identical to today. `proactive.triggers` defaults to `[]`, so the roster is
  unchanged until a YAML opts in.

## Increment 1 (shipped) vs increment 2

**Increment 1** ships the full spine + **one** flagship trigger end-to-end:
`home_arrival` → **Luna**. iOS posts a `signal:location` packet on a region/visit
transition; the def mirrors `compute_is_home` (arrival/enter at the `home` anchor ⇒
the away→home edge, departure/exit ⇒ re-arm) and wakes Luna — the household /
Home-office owner — scoped to a quick house-systems read. **No cron slots are removed
in increment 1**: the flagship proves "live + event-driven"; ripping polling passes is
per-specialist judgment best done as independent follow-ups.

**Increment 2** (PLAN.md Tier 2) migrates the low-event polling passes onto
triggers/`wake_self` (`workout_started` → Astrid, `refill_window` → Anya,
`market_threshold` → Vivian, a `security_concern` def for Cassandra), retires the
now-redundant `deliberation_at` slots on the converted specialists, and thins Kate's
brief toward render-of-pre-assembled-state — keeping only the genuinely-temporal ticks
(the brief, quiet-hours boundaries, "it's been N days since X" nudges).

## Verification

`bun run smoke:reactive-triggers` (self-contained, no DB/LLM/network): the
`home_arrival` edge detector (arrival ⇒ edge, repeat ⇒ none, departure ⇒ re-arm,
non-home/no-packet ⇒ none); driver fan-out (one arrival wakes every subscriber once,
edge-dedup across repeats, per-sub debounce/min-interval pass-through, kill switch,
fail-open against a throwing def); and `wake_deliberation_scoped` (debounce coalesces a
burst, min-interval suppresses a too-soon re-fire, the woken pass runs at
`trigger:<key>` carrying the `TriggerContext`). Regression: `smoke:proactive` +
`guard`. Live: a location packet flipping away→home logs
`[loops] wake_deliberation_scoped firing for luna (home_arrival:<user>)` + a
`deliberation_pass` audit row at slot `trigger:home_arrival:<user>`; a re-entry within
`min_interval` produces none.
