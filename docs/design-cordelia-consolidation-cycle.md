# Design — Cordelia's consolidation cycle (Hearth's "second brain" back-half)

Status: **Phase 1 built + verified** (2026-06-14, uncommitted); Phases 2–3
proposed. Owner: Cordelia (the knowledge-metabolism specialist). Phased; Phase 1
ships and proves value before the cordon-sensitive Phase 2 lands.

**Phase 1 landed (2026-06-14):** the `synthesize_shelves` job-only tool +
`shelf_synthesis.ts` runner + `shelf_synthesis_state` store + `synthesis_note`
note-type + the `nightly_shelf_synthesis` 04:20 background job, all green under
`bun run smoke:shelf-synthesis` (30 checks; the no-bucket-mixing cordon assertion
is the centerpiece) + guard + tsc. One refinement from the build: synthesis notes
shelve through the chunk/embed primitives directly (not `save_library_item`)
because they need **upsert-by-topic** semantics — a stable path so re-synthesizing
a topic replaces its note rather than proliferating dated copies — which
`save_library_item`'s append-style `${date}-${slug}` path can't give. The
"distilled note → high-signal RAG hit" win is structural (same chunks_fts +
embeddings path as every library item); the live before/after RAG spot-check on a
heavy shelf is the remaining Phase-1 acceptance step, to run post-deploy.

**Phase 1.5 — write-time grounding gate (2026-06-14):** because a synthesis is
durable evidence future turns ground against, a fabrication in one would launder
past the read-time fact critic (which trusts retrieved notes). `ground_synthesis()`
now runs `assess_factual_grounding` on the distilled prose against its OWN sources
before shelving — the brief_critic pattern: one tool-free re-distill on findings;
drop the flagged sentences or reject the topic when too little survives; a
confirmed fabrication is never shelved; fail-open on critic outage. Synthesis
notes carry `derived: true` (cite THROUGH them to the primary source) +
`grounding_outcome`; every reduce/reject emits a `synthesis_grounding` audit row.
This is what clears synthesis notes to be trusted in live retrieval — covered by
the 4 gate-outcome unit checks + an end-to-end fabrication-caught case in
`smoke:shelf-synthesis`.

## The problem, stated precisely

Hearth already has a *first* brain: the vault is the authoritative store and
hybrid FTS+vector RAG ([retrieval.ts](../src/core/retrieval.ts)) is the recall
path. What's missing is the **back half of a knowledge metabolism** — the two
middle stages of capture → **distill** → **connect** → retrieve:

- **Distill.** Captures and acquired library items are shelved *raw*. Cordelia
  acquires and files (`acquire_knowledge` / `scout_sources` /
  `commission_research` → `save_library_item`), but nothing ever consolidates a
  shelf's accumulating raw material into compact, evergreen *understanding*.
- **Connect.** Knowledge is **siloed per specialist** by `knowledge_scope`.
  Eleanor's garden notes, Iris's routes, Vivian's spend never cross-reference.
  Nothing surfaces "the thing on shelf A relates to the note on shelf B."

This design adds both stages to the metabolism Cordelia already runs, closing
the loop:

```
acquire → shelve → DISTILL → CONNECT → retrieve
                      │          │
                      └──────────┴──→ gaps → demand ledger → acquire
```

## The load-bearing constraint: the per-user cordon

Hearth's privacy invariant is absolute and fail-closed: the owner has **no
god-view**, `note_visible_to_caller` is a pure cordon, specialists are scoped by
`knowledge_scope`. "A second brain *overall*" can therefore **never** mean a
cross-user or cross-cordon brain. It means **one user's collective memory across
*their own* specialists**, and every derived artifact must carry a `private_to`
no wider than its narrowest source.

Two rules make this safe and are non-negotiable:

1. **Synthesis notes never mix visibility buckets.** The distill pass buckets a
   shelf's new items by their *exact* resolved `private_to` value
   (`owner` / `household` / `<user_id>`), synthesizes **within a single bucket
   only**, and stamps the resulting note with that bucket's value. A note built
   from `private_to: household` sources is stamped `household`; a note built from
   `private_to: sam` sources is stamped `sam`. No cross-bucket combination in
   v1 — it's the one leak vector, and the conservative default costs us little.
2. **Connection edges store no visibility; it's re-checked at read time.** An
   edge is a bare pointer `(from_path, to_path, relation)`. It is *recorded* only
   when a single viewer identity currently passes the cordon on **both**
   endpoints, and *surfaced* only when the caller currently passes the cordon on
   both. Notes can be re-stamped; a stored visibility floor would go stale, so we
   never store one — `_chunk_gates` / `note_visible_to_caller` are the only
   visibility authority, evaluated live.

Both rules reuse the existing primitives in
[private_to.ts](../src/memory/private_to.ts) and `MemoryClient._chunk_gates`
([client.ts](../src/memory/client.ts)) verbatim. **Do not roll a new cordon
check.**

A consequence worth stating: the connection layer **never widens scope**. It
surfaces links only *within* what a caller can already read. The "Hearth knows
across all my domains" feeling therefore lands most for **Kate** (scope `**`) and
**Cordelia** (all library shelves) — which is correct: the chief of staff is the
right holder of the cross-domain view. A domain specialist (Eleanor, Iris) still
only ever sees connections among notes inside their own scope.

---

## Phase 1 — Distill (evergreen synthesis notes)

**Goal:** a nightly Cordelia job that consolidates each shelf's new raw material
into compact, cited, evergreen notes that become high-signal RAG hits. Lowest
risk; rides existing infra end-to-end; cordon-safe by bucketing.

### Mechanism

A new background job `nightly_shelf_synthesis` at **04:20** (after subscriptions
refresh 03:40, commission sweep 03:20, and her 04:00 deliberation — so it sees
the freshest shelves), registered the YAML-driven way in
[config/specialists/cordelia.yaml](../config/specialists/cordelia.yaml)
`proactive.background_jobs`, backed by a new **job-only** tool
`synthesize_shelves` (volatile; not on any LLM surface — same posture as
`advance_research_commissions` / `refresh_subscriptions`).

Per run, deadline-bounded into slices (≤ N shelves/topics per night), for each
shelf `Knowledge/<Target>/library/**`:

1. **Select new material.** Items added/changed since this shelf's
   `last_synthesized_at`. Track per-shelf synthesis state in a small store
   (`shelf_synthesis_state`, mirroring the sources-crawl `last_crawled_at`
   idiom in [sources_store.ts](../src/specialists/cordelia/sources_store.ts)) —
   machine-owned, never reset by writes.
2. **Bucket by `private_to`** (the cordon rule above). Each bucket is processed
   independently and produces independently-stamped notes.
3. **Cluster within a bucket** using the *deterministic* token-overlap clustering
   already proven in [knowledge_demand.ts](../src/core/knowledge_demand.ts)
   (no LLM in the clustering step — re-runs must be reproducible).
4. **Distill each topic with enough new material.** One planner/deep-tier LLM
   call (the forza 35B, think-off, **fail-open** — a judge/synthesis outage
   skips the topic, never blocks) turning the topic's raw chunks into a
   "what we now know about X" note with inline `[[wikilinks]]` back to every
   source note (the wikilinks populate `graph_edges` for free via the ingestor).
5. **Shelve** via `save_library_item`
   ([library.ts](../src/app/routes/library.ts)) to
   `Knowledge/<Target>/library/_synthesis/<topic-slug>.md`, with:
   - `type: synthesis_note` — registered **AUXILIARY** in
     [note_types.ts](../src/memory/schemas/note_types.ts) (specialist-owned,
     deliberately unprojected).
   - `quality_gate: 'off'` — it's our own derived content, not a web capture.
   - `private_to` = the bucket's value (the stamp rule).
   - frontmatter `synthesized_from: [<source paths>]` + `source_hash` for
     idempotency.
6. **Idempotency + kill switch.** Deterministic key from
   `(shelf, topic, sha256(sorted source paths + source mtimes))`; an unchanged
   topic re-run is a no-op. Kill switch `HEARTH_SHELF_SYNTHESIS=0`. Volatile
   tool (its result depends on shelf state the run mutates).

Because the synthesis note is chunked + embedded by `save_library_item`, it is
immediately retrievable — and being a *distilled* note, it tends to outrank the
raw fragments on a topic query. **That is the Phase-1 win to measure**: a
before/after RAG-quality spot-check on a shelf with heavy raw accumulation.

### Phase 1 deliverables
- `src/specialists/cordelia/shelf_synthesis.ts` — the runner (slice loop,
  bucketing, clustering reuse, fail-open distill, idempotent shelve).
- `synthesize_shelves` job-only tool + orchestrator registration + YAML job.
- `shelf_synthesis_state` store (per-shelf `last_synthesized_at`).
- `synthesis_note` registered AUXILIARY in `note_types.ts`.
- `bun run smoke:shelf-synthesis` — self-contained: temp vault + db, seed a
  shelf with mixed-`private_to` raw items, assert (a) one synthesis note per
  bucket per topic, (b) **no** note ever mixes buckets, (c) idempotent re-run is
  a no-op, (d) fail-open on a throwing judge, (e) the note is chunked/embedded
  and retrievable, (f) kill switch disables.

---

## Phase 2 — Connect (cross-specialist edges within one user's cordon)

**Goal:** record and surface "relates-to" links across shelves, strictly inside
each user's cordon, so a broad-scope holder (Kate / Cordelia) experiences Hearth
as one connected mind. Higher value; the cordon work is the hard part and is
designed *first*.

### New table — NOT `graph_edges`

`graph_edges` is wikilink-semantic and carries no scope/visibility; it cannot be
reused. New table in [structured.ts](../src/memory/stores/structured.ts)
(`IF NOT EXISTS`, additive, no `SCHEMA_VERSION` bump):

```sql
CREATE TABLE IF NOT EXISTS knowledge_connections (
  id            TEXT PRIMARY KEY,
  from_path     TEXT NOT NULL,
  to_path       TEXT NOT NULL,
  relation      TEXT NOT NULL,   -- 'relates_to' | 'complements' | 'updates' | 'contradicts'
  reason        TEXT,            -- short why, for surfacing context
  discovered_by TEXT NOT NULL,   -- 'cordelia_synthesis'
  created_at    TEXT NOT NULL,
  UNIQUE(from_path, to_path, relation)
);
CREATE INDEX IF NOT EXISTS idx_kconn_from ON knowledge_connections(from_path);
CREATE INDEX IF NOT EXISTS idx_kconn_to   ON knowledge_connections(to_path);
```

**No `private_to` column by design** — visibility is the notes', evaluated live.

### Discovery (rides the Phase-1 pass)

Two cheap sources, both bounded to a single user's visible set:
- **Intra-topic.** The source notes a synthesis topic pulled together *are* a
  connection cluster — record `relates_to` edges among them.
- **Cross-shelf.** For each synthesis note, vector-search the *rest of that same
  user's visible corpus* (run `retrieve_hybrid` with that user's id/tier — the
  gates do the cordon) for high-similarity notes on other shelves; record an edge
  above a similarity threshold. An edge is recorded **only** if that one viewer
  passes the gates on both endpoints.

### Surfacing — two paths, both cordon-gated at read time

1. **Transparent (the real win).** In turn-start retrieval, after the normal
   hybrid pool is built, expand by one hop along `knowledge_connections` and
   admit connected notes that pass the caller's `_chunk_gates` (scope +
   visibility) — no new tool call, the specialist just gets better context. For
   Eleanor this stays within Garden/Cooking; for Kate it spans everything she can
   see. This is the dynamic that makes Hearth feel like one brain.
2. **Explicit.** A read tool `related_notes(note_path | topic)` for
   Kate/Cordelia that walks edges and returns connected notes, each
   re-checked against the caller's cordon. Useful for "what across the household
   touches X."

### Phase 2 deliverables
- `knowledge_connections` table + a thin store
  (`src/memory/stores/knowledge_connections.ts`) whose **read methods always
  take a `Caller` and filter through `_chunk_gates`** — there is no un-gated read.
- Discovery wired into `shelf_synthesis.ts` (Phase 1's pass).
- One-hop expansion in `retrieve_hybrid` (opt-in flag, dark by default behind
  `HEARTH_CONNECTION_EXPANSION=1`, fail-open to today's pool).
- `related_notes` tool on Kate's + Cordelia's surfaces.
- `bun run smoke:knowledge-connections` — the cordon is the whole test: assert a
  cross-user edge is **never** surfaced (owner can't follow an edge into Sam's
  private note; Sam can't follow one into Kim's), a re-stamp silently drops a
  previously-surfaced edge, scope still bounds a domain specialist, and the
  transparent expansion fails open when disabled.

---

## Phase 3 — Close the loop (synthesis gaps → demand ledger)

**Goal:** turn what the synthesis pass *couldn't* do into next-cycle acquisition
demand, completing the metabolism.

When distill/connect finds a topic with real pull but thin material (a cluster of
one weak source; a connection that points at an absent note; a contradiction it
can't resolve), emit a new audit signal the demand ledger already knows how to
mine:

- Audit row `tool_name: 'synthesis_gap'`, `agent: 'cordelia'`,
  `user_id: <originating user, nullable>`,
  `tool_input.gap_description` (≤ 240 chars).
- Add `'synthesis_gap'` to the `DemandSignalKind` union and a case to
  `mine_demand_signals` in [knowledge_demand.ts](../src/core/knowledge_demand.ts)
  (the contract is already there — `gap_description` clusters like
  `query_preview`).
- The existing `sole_user_id → private_to_hint → acquire_knowledge.private_to_user_id`
  path then cordons the resulting acquisition to the right user automatically.

Now: acquire → shelve → distill → connect → **gap** → demand → acquire. The
system notices its own holes and fills them.

### Phase 3 deliverables
- `synthesis_gap` emission in `shelf_synthesis.ts`.
- `DemandSignalKind` + `mine_demand_signals` case.
- Extend `smoke:knowledge-demand` with the `synthesis_gap` mining + cordon case.

---

## Sequencing & risk

| Phase | Value | Risk | Gate before next |
|---|---|---|---|
| 1 Distill | High (RAG quality) | Low — rides `save_library_item` + job idiom | RAG-win spot-check on a heavy shelf |
| 2 Connect | Highest (the "one brain") | **Cordon** — the connection table + live-recheck | `smoke:knowledge-connections` cordon matrix green |
| 3 Loop | Medium (autonomy) | Low — one audit signal + one ledger case | — |

Ship 1, measure, then 2. Don't build the connection table until the distill
notes exist to connect.

## Open decisions (for owner)

1. **Distill cadence/scope** — every shelf nightly, or only shelves with ≥ K new
   items since last synthesis? (Default: threshold-gated, to keep the deep-tier
   spend bounded.)
2. **Synthesis-note placement** — `_synthesis/` subfolder per shelf (proposed),
   or a single `Knowledge/Cordelia/synthesis/<shelf>/` namespace she owns
   outright? The former keeps each note inside its target's scope (better for
   transparent expansion); proposed.
3. **Transparent expansion default** — ship Phase 2's one-hop RAG expansion on
   for Kate/Cordelia only at first, or for all specialists within-scope from day
   one? (Default: Kate/Cordelia first, widen after a week.)
