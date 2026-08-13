# The per-user model — a unified, continuously-learned, low-resource user substrate

**Status:** design sketch (2026-06-19). No code yet.
**One line:** give each user ONE durable, bounded, cordoned picture of themselves that
every cheap signal feeds and every specialist reads — so the whole autonomous stack
learns about them continuously without constant inference.

## The problem

Hearth already learns, but in silos. Today a single user is scattered across the
style profile (just built), `user_profiles` facets, location-awareness, music
context, person-tracks, health/workout state, per-specialist memory.md files, and
ad-hoc deliberation flags. Nothing reads the *whole* picture; each loop re-derives
its slice; learning doesn't compound across domains. The style loop proved the
pattern works — this generalizes it from "writing style" to "everything we know
about this person," **per user**, on the same cheap principles.

## The principle: afferent → synthesize → efferent, all cheap

Continuous learning is expensive only when it means constant inference. It doesn't
have to. Three layers, mapped onto the cost disciplines:

- **Afferent (feed):** cheap observations mined from the exhaust the system already
  emits. No LLM, or a tiny one, at intake.
- **Synthesize (digest):** the ONLY expensive step — threshold-gated, off-peak,
  cheap-tier, refine-not-rebuild. Rare by construction.
- **Efferent (read):** durable text injected at context time, domain-scoped and
  size-capped. Zero inference; learning compounds without re-paying.

## The substrate — facets, not a blob

The unit is the **facet** (Hearth already has this concept). One per-user model =
a bounded set of facets, each:

```
facet {
  key            // 'style' | 'interests' | 'routines' | 'relationships'
                 // | 'food' | 'media' | 'ev' | 'home' | 'health' | 'civic' | ...
  summary        // SHORT distilled prose — the read-at-context artifact (~paragraph)
  confidence     // low|med|high — how much evidence backs it
  last_refreshed // ISO — drives staleness
  last_read      // ISO — drives worth/decay (Second-Brain pattern)
  source_signals // which exhaust streams fed it (provenance, for verify/repair)
}
```

Two-tier storage, the established Hearth split:
- **DB row** (hot path): the distilled `summary` per facet, read every turn. This is
  the `UserProfileStore` row's `detail` (already holds `style_profile`); facets
  become first-class keys in it.
- **Vault note** (`users/<id>/model/<facet>.md`, cordoned `private_to: <id>`): the
  raw dated observations + the longer narrative + provenance. The audit trail of how
  the summary was learned. Rotates/compacts like the style loop's 200-cap.

Both already exist (`users/<id>/` namespace, `detail` JSON). This is an extension,
not new infrastructure.

## Layer 1 — Afferent: mine the exhaust (cheap/free)

Observations are appended to a facet's raw note by thin **observers** that map signal
→ `(user_id, facet, observation)`. The richest signal is already being written for
free:

| Signal (already emitted) | Observer → facet |
|---|---|
| messages (`message_added`) | style, interests, corrections |
| captures (`capture_routed`) | interests, what they document/care about |
| audit rows (every tool call) | preferences (what they ask for / reject), routines |
| proposals accepted/rejected | preferences, trust |
| location packets (derived) | routines (rhythms, travel), home/away |
| music / health / presence (derived) | media, health, household |
| per-specialist domain calls | domain facets (Iris→ev habits, Brigid→food) |

Intake rules (the cheap disciplines):
- **Mine the exhaust, don't add an observation pass.** An observer is a consumer of
  audit rows / `AppEventBus` events, not a separate "go watch the user" LLM run.
- **Deterministic or tiny-model classification** of which facet a signal touches —
  the 1.5B on the Xeon (`status_flavor` tier, CPU, off both GPUs) at most. Most are
  pure code (a tool name → a facet; a sensor summary → a facet).
- **Derived summaries only, never raw streams** — location/health/music land as
  small derived facts, not firehoses.
- Reactive + debounced (the `ReactiveInboxDriver` / `LiveSynthesisDriver` pattern),
  not polled.

## Layer 2 — Synthesize: accumulate cheap, distill rare (the only LLM cost)

Per facet, per user, a **threshold-gated** distill (the style loop, generalized):
raw observations + prior summary → refreshed summary. Fires only when a facet has
accumulated ≥K new observations since `last_refreshed`. Because most facets change
slowly, most facets skip most nights → a nightly tick that's almost always a no-op.

- **Cheap tier**: the 1.5B (CPU) for routine facets; off-peak 9B for harder ones.
  Never the live tiers during live hours.
- **Refine, not rebuild** — prior summary as anchor + a small recent sample (~40
  observations), so the prompt stays ~8K not 40K.
- **Off-peak + staggered** (the existing 3–4am job slots), one user/facet at a time.
- One shared engine: `synthesize_facet(user_id, facet, deps)` — `learn_user_style`
  generalized; the style loop becomes the first caller.

## Layer 3 — Efferent: domain-scoped read at context (zero inference)

A single resolver injects the RELEVANT facets into the prompt:

```
resolve_user_model(user_id, specialist_id) -> facet summaries
  = universal facets (style, identity)        // every specialist
  + facets in this specialist's domain map     // Iris→ev/routines, Brigid→food, ...
  - cordoned out if not visible to the caller
```

- The house voice already reads the `style` facet — it becomes one consumer of this
  resolver. Kate's brief reads the life-context facets; Iris reads ev/routines; etc.
- **Domain-scoped + size-capped** → the per-turn read stays small no matter how much
  the user model has grown. A specialist sees its slice + the universals, not the
  whole model.
- Pure text injection — no inference, learning compounds for free.

## Bounding — stays cheap forever (decay/prune/worth)

Borrowed from the Second Brain:
- **Recency-weighted worth**: a facet that gets READ stays warm; never-read facets
  decay and eventually prune. The read-at-context cost tracks *current value*, not
  lifetime accumulation.
- **Staleness flags**: a facet not refreshed in N days is marked stale — the model
  is told to verify it, and synthesis re-prioritizes it.
- **Size caps + rotation**: summaries are a paragraph; raw observations rotate
  (style-loop 200-cap; memory.md compaction).
- Net: the substrate is bounded and current regardless of tenure.

## Cordon — the privacy invariant (non-negotiable)

This is THE place the per-user data cordon must hold absolutely:
- Every facet + observation is `private_to: <user_id>`. **The owner has NO god-view**
  — Jasper's model ≠ Sam's, and no RAG/search/brief/oversight path reads another
  user's model. Rides the existing `note_visible_to_caller` cordon and the user_id
  stamping; adds no new privacy surface.
- Sensor-derived facets (location, presence) additionally honor the location-privacy
  allowlist. Raw GPS/health never enters the model — only derived facts.
- `resolve_user_model` is keyed on the SPEAKER's id; cross-user reach stays the one
  audited `review_user_activity` path, never a passive bypass.

## Feeding autonomy

The accumulated facets + confidence give autonomy graduation a richer, per-user
basis: a category can graduate for a *well-understood* user (high-confidence model +
proposal-signature history) while staying cautious for a new one. Per-user autonomy,
grounded in how much the stack actually knows about that person.

## The low-resource accounting

| Layer | Cost |
|---|---|
| Afferent (feed) | ~free — mines audit/events; tiny-model classify at most |
| Synthesize | rare (threshold-gated/facet) × small prompt (~8K) × cheap tier × off-peak |
| Efferent (read) | zero inference — domain-scoped, size-capped text injection |

Quiet night across the household → a few SQLite counts, zero LLM calls. The model is
never more than ~K observations stale, compounds across domains, and the per-turn
read cost is flat over the user's whole tenure.

## Migration — incremental, reuses what's there

Not a rewrite — a unification:
1. **Substrate**: extend `UserProfileStore.detail` to first-class facets +
   `users/<id>/model/<facet>.md`. (style_profile is the first facet, already live.)
2. **Synthesis engine**: generalize `learn_user_style` → `synthesize_facet`; add the
   threshold gate + cheap-tier routing.
3. **Observers**: 2–3 to start (style ✓, interests, routines), each mining existing
   audit rows / events — no new observation passes.
4. **Resolver**: `resolve_user_model` + a per-specialist domain-facet map; the house
   voice switches to read through it.
5. **One off-peak tick** that walks users×facets, skips the un-threshold-crossed.
6. Add facets over time; each is the same observe→gate→distill→read shape.

## Contracts / invariants (so it can't degrade)

- Facet = (summary, raw observations, confidence, last_refreshed, last_read, sources).
- Intake cheap (exhaust-mined, deterministic-or-1.5B); **synthesis is the only
  LLM-heavy step** — always gated + off-peak + cheap-tier + refine-not-rebuild.
- Read is **domain-scoped + size-capped + cordoned**.
- **Never raw sensor streams** in the model — derived facts only.
- **Cordon is absolute** — per-user, owner included.
- Bounded by decay/prune/worth — read cost flat over tenure.

## Open questions

- Facet taxonomy — fixed set vs. let it grow (a "misc/emergent" facet the synthesis
  can split)? Start fixed, allow emergence later.
- Confidence model — heuristic (observation count + recency) vs. judge-scored? Start
  heuristic.
- Reactive vs. nightly synthesis — start nightly+threshold (simpler); move hot facets
  to reactive (debounced `message_added`) if staleness bites.
- Cross-facet contradiction (a routine facet says "works late," a health facet says
  "early gym") — surface as a low-confidence flag, don't auto-resolve.
