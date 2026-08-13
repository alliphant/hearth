# Design — the People observational engine + trust surface (A+D)

> v1 SHIPPED 2026-06-22 (branch `feat/people-observers`). The second build of the
> People reasoning substrate, on top of Phase 0's relationship graph
> ([design-people-relationship-graph.md](design-people-relationship-graph.md)).

## The ask
Make the People layer **maintain itself**. Today it depends on you *telling* Kate
facts (the fragile chat-told path). The anchor's real value is the system
**observing** people from the signals it already has — so you stop data-entering —
and **showing its work** so you can trust and correct it.

Two halves, inseparable:
- **A — the observational engine.** Cheap, event-time observers mine the exhaust
  into provenance-stamped `person_observations` (what was noticed, the source,
  confidence, when, the cordon).
- **D — the trust surface.** The Friends card shows, per person, *what Hearth has
  noticed and where it learned it*, with one-tap dismiss. Auto-population is only
  safe *because of* D — so they ship together.

## Why observation, not conversation (the design pivot)
The live test of Phase 0 showed Kate narrating "I've recorded that" while calling
no tool — the chat-told write path is the smallest and most fragile input. The
anchor must be **resilient through redundancy**: a fact should be learnable from
*many* signals, so no single broken path loses it. So the engine is signal-
agnostic; observers are pluggable; the chat mention is just one of them.

## What shipped (v1)
- **`person_observations` store** ([stores/person_observations.ts](../src/memory/stores/person_observations.ts))
  — append-only, the log AND the provenance source of truth. Idempotent on
  `(person_id, source_type, source_ref, kind)` (one "mentioned in conversation X"
  row, time-refreshed — not a row per message). Cordoned (`private_to`,
  `note_visible_to_caller`), additive table.
- **`PersonObserverDriver`** ([core/person_observers.ts](../src/core/person_observers.ts))
  — sibling of `user_model_observers`; one `attach(events)`. v1 observers:
  - `message_added` (role=user) → conservative name-match (full + preferred name
    always; bare first name only when unique) of the conversation OWNER's visible
    people → a `mention` observation, debounced per (conversation, person).
  - `capture_routed` (+ `capture_received` correlation) → name-match the capturing
    user's visible people in the route_reason → a `capture` observation.
  - DARK by default (`HEARTH_PERSON_OBSERVERS=1`), fail-open, cordoned (matches
    only people that user can see; the observation inherits the person's
    `private_to`), self-note + genealogy excluded.
- **D surface** ([routes/friends.ts](../src/app/routes/friends.ts) + the Friends
  card in [app.js](../src/app/client/app.js)) — a "What Hearth's noticed" section
  per person: each observation with its source + date + a ✕ dismiss
  (`POST …/friends/:pid/observation/:oid/dismiss`, cordon-checked).
- Proof: `bun run smoke:people-observers` (24 — store idempotency/cordon/dismiss,
  the mention + capture observers, debounce, cordon-on-match, self-exclusion,
  triage/cache-miss skips, kill switch).

## How to add an observer (the seam)
The engine is signal-agnostic. A new signal = a new case in
`PersonObserverDriver.attach` that resolves the signal's user, name-matches (or
otherwise resolves) that user's visible people, and calls
`observations.record({ … source_type, source_ref … })`. Keep it DARK-gated,
fail-open, and cordoned (inherit the person's `private_to`). The richer friend
channels drop in here:
- **iMessage** — via the **macOS** app reading `~/Library/Messages/chat.db` (Full
  Disk Access) → a Hearth ingest endpoint → a `messages` observer. **iOS cannot**
  (Messages is sandboxed; the Message Filter extension only sees unknown-sender
  SMS). On both, the share-sheet/screenshot route already works via captures.
- **Discord** — harder (no local store; bot/API + ToS). A later stretch.
- **presence/face** — a friend visits → recognized → "visited." Needs the
  enrolled_persons↔person-note link closed first.
- **calendar** — an event naming a friend → "saw them."

## Roadmap (next)
- **A v2 — distillation.** A nightly threshold-gated pass distills observations →
  durable person-note facts (with `inferred` provenance), extending
  `sweep_person_facts`. v1 surfaces observations directly; v2 turns the strong,
  recurring ones into facts + can bump `last_contacted` (auto stay-in-touch).
- **C — life-event detection.** Compare new observations vs current facts → on a
  real edge (moved / new job), propose "update their note?"
- **B — right-moment proactivity + conversation prep** — consumes the now-rich
  model + the graph + live signals.

## Honest stretches / risks
- **Entity resolution** is the quiet hard part (same as Phase 0). The matcher is
  deliberately conservative (unique-first-name only); a miss means no observation,
  never a wrong one.
- **The capture observer is best-effort** — `capture_routed` carries only the
  short route_reason, not the full VL/OCR; a richer matcher that reads the capture
  note is a v2 refinement.
- **Auto-population is only safe because of D** — every observation is provenance-
  tagged + dismissable; nothing silently overwrites a told fact.
- **v1 is sparse for friends until iMessage lands** — by design (the owner chose
  "engine now, seam later"). It gets rich when the macOS iMessage observer ships.
