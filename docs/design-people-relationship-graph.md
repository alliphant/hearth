# Design — the People relationship-and-role graph (reasoning substrate)

> Phase 0 SHIPPED 2026-06-22 (branch `feat/people-relationship-graph`).
> Phases 1–3 are the forward roadmap. Companion to the Friends tab
> ([friends.ts](../src/app/routes/friends.ts),
> [relationship_signals.ts](../src/core/relationship_signals.ts),
> [person_enrichment.ts](../src/core/person_enrichment.ts)).

## The ask, in one line

Stop reading people at face value. Make the People layer a **reasoning
substrate**: a typed graph of *who plays what role for whom, and where* — so
Kate can both **understand** ("Rosa is Sam's hairdresser; Rachel & Mariah are
Jasper's, at the salon") and **predict** ("Sam's cut is 4pm, date night
is 6pm, you're home, the salon→restaurant→leave-by math says the evening is
tight"). Less reading the weather, more predicting it.

## Why the layer couldn't do it (the gaps Phase 0 closed)

| Needed | Was | Now |
|---|---|---|
| A queryable people graph | `relations` was strict `{name, relation}` frontmatter, **never projected** | `relations` projects into typed `relates-to` edges in `knowledge_edges` |
| Typed semantic edges | `graph_edges` is `path→path` from `[[wikilinks]]` only | a `relates-to` edge carries a free-text role + provenance + confidence |
| People↔place ties | none | a relation's target can be a Place (`to_kind: place`) |
| Provenance ("what does Kate believe?") | none | every edge tagged told\|observed\|inferred + confidence |

## Decisions (locked 2026-06-22)

1. **Told-first, infer-second.** Phase 0 authors only `provenance: told` (the
   owner stated it). Signal-inference (Phase 2) only ever *proposes*
   `inferred` edges to confirm. Every edge is inspectable + correctable.
2. **Nodes = People + Places/businesses.** Roles can target a place, which is
   what unlocks the travel-time prediction.

## What shipped (Phase 0) — built ON the existing substrate

The key implementation decision: **relationships are a new SOURCE feeding the
Household Knowledge Graph that already exists** ([knowledge_edges.ts](../src/memory/stores/knowledge_edges.ts),
which goods/life-events use), NOT a parallel `entity_edges` table. That's the
"find the general mechanism, don't carve out a special case" rule.

- **Authoring truth = the person note's `relations` frontmatter** (vault-
  authoritative, Obsidian-editable, git-tracked, cordoned). The schema
  ([person.ts](../src/memory/schemas/person.ts)) is now **permissive** — it
  accepts the legacy `{name, relation, birthday}` AND the role/place shape
  `{to, to_kind, predicate, provenance, confidence, …}` (all-optional +
  passthrough; coerce-don't-reject).
- **Projection** ([project.ts](../apps/ingestor/project.ts) +
  [person_relations.ts](../src/core/person_relations.ts)): the ingestor turns a
  person note's `relations` into `relates-to` edges — `kind: 'relates-to'`, the
  role in `context`, provenance encoded in `source` (`told:<ref>`), targets
  resolved to a `People/`/`Places/` note_path or kept as a free token. Idempotent
  (`replace_from` clears the note's prior edges first); fail-open (a bad relation
  never fails the note's projection).
- **Authoring tool** `record_relationship` (Kate, told-first): "Rosa is Sam's
  hairdresser" → appends the `relations` entry (vault truth) AND warms the edge
  so the same turn's read sees it; the projector reconciles to the identical row.
- **Read tool** `who_is` (Kate): resolves a person/place and returns every tie
  touching it (both directions, with provenance), cordon-safe — the owner has no
  god-view of a siloed person.
- **Friends card**: a read-only **Connections** section (both directions, places,
  provenance chips) — "what Kate believes" — plus a `🔗` count on the card.
- **Cordon**: every edge carries `private_to`, read through `knowledge_edges`'
  per-caller filter; `who_is` also cordons the entity itself.
- Proof: `bun run smoke:people-graph` (34 checks — normalizer, provenance codec,
  projection, bidirectional read, cordon, both tools, idempotent re-projection,
  unproject cleanup).

## Phases

- **Phase 0 — SHIPPED.** The substrate: typed `relates-to` edges, told-first
  authoring, `who_is`, provenance on the card.
- **Phase 1 — the prediction payoff.** The chaining engine, one end-to-end chain:
  the date-night calendar↔calendar↔travel inference. The primitives all exist —
  `sensor_calendar_upcoming`, `get_current_location`/`recent_trips`, maps
  `distance_matrix`/`route` (and Iris's `plan_ev_day` proves calendar+routing
  chaining is buildable here). The missing glue — resolving a "haircut" event
  *through* the graph to a person + a place with coords — is now in place.
- **Phase 2 — infer-second (auto-population).** Extend the nightly enrichment
  sweep (already extracts `relations`) + mail senders (a the salon
  appointment email → *propose* a salon Place + a stylist edge) + captured
  business cards → all as `provenance: inferred` edges the owner confirms.
- **Phase 3 — deeper inference.** Mutual connections / households as graph
  queries; life-event detection (a role *changes*); reciprocity & hosting
  intelligence — all queries over a now-rich graph.

## Honest stretches / risks

- **Name→entity resolution** is the quiet hard part (no note yet, two Micheles,
  "the salon" vs "and"). Mitigation: reuse `find_person`/
  `find_place_by_name` (alias-aware); keep unresolved edges as free tokens rather
  than guessing.
- **Calendar→graph resolution (Phase 1) is fuzzy** — a bare "Haircut 4pm" rarely
  names the person or salon. Early wins lean on events that carry a place/title or
  a linked reservation email; don't over-promise resolving bare titles.
- **Predicate normalization** is exact-lowercase only for now; a synonym layer is
  a later, optional refinement — never an LLM guess that silently rewrites a told
  fact.
- **One `relates-to` edge per (subject, target) pair** (the PK). Re-asserting a
  different role updates `context` (last-write-wins). Multi-role pairs are a
  documented Phase-1+ refinement.
