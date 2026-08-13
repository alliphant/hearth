# Design — Cordelia as the expert on what makes specialists experts

**Status:** design note, not yet built. Decision needed on the one fork in §6.
**Author:** Claude (Opus 4.8), 2026-06-03, at Jasper's ask ("how can we empower
Cordelia to be the EXPERT on what makes our specialists EXPERTS?").
**Companion:** the Kristi knowledge-seed + persona/ICP/UCP work shipped the same
day is the first *manual* run of the loop this note proposes generalizing — see
[shipped-2026-06.md](archive/shipped-2026-06.md) and
[scripts/seed-kristi-knowledge.ts](../scripts/seed-kristi-knowledge.ts).

---

## 1. The idea

Each time we make a specialist excellent we do the same thing by hand: figure out
the *advanced, non-obvious knowledge* that separates an expert from a
brochure-reader in that domain, then seed it and tune the persona/sources/tools.
We just did it for Kristi (deep-research pass → 6 framing notes → a new
persona/ICP/UCP capability). The goal is to make that a **household capability,
owned by a specialist** — Jasper's standing rule (and the lesson in the Kristi
memory): *don't do the specialist's reasoning in your own context; build the
capability into the specialist.* Generalized one level up: the "specialist
excellence" loop should itself live in a specialist, not in a Claude session.

Cordelia is the right home for the *knowledge* half of that loop. She is the
Master Librarian, and she already holds the household's only cross-specialist
knowledge powers.

## 2. What already exists (two halves, already built)

**Cordelia — the curation engine.** She is most of the way there:
- `write_vault_any_library` — the only specialist who can write onto *any*
  shelf; read access to `Knowledge/*/library/**`.
- `curate_for_specialist` ([src/connectors/curate_for_specialist.ts](../src/connectors/curate_for_specialist.ts))
  — names a *target specialist* + focus areas, reads that specialist's
  `trusted_sources` + `knowledge_scope`, searches Tier-1-scoped, fetches, saves
  with provenance, files `trusted_source_addition` proposals for unlisted
  domains (each candidate LLM-judged for actual relevance to the focus area
  first — 2026-08-10; keyword-rank alone can collide), logs to
  `_curation_log.md`.
- `specialist_bootstrap` ([src/core/specialist_bootstrap.ts](../src/core/specialist_bootstrap.ts))
  — on hire, the orchestrator pushes a high-severity flag to Cordelia with 3–5
  focus areas; her `wake_on_flag` debounce picks it up → `curate_for_specialist`.
- `flag_cordelia` + `wake_on_flag` — any specialist hitting a knowledge gap pulls
  her in mid-stream; she fills the shelf.

So she is a fully-built, **reactive, cross-shelf gap-filler**. What she is *not*
yet is a proactive **expertise authority** — she fills gaps that are pointed out,
but holds no model of what "expert" *means* for a given specialist.

**Beatrice — the critic/architect.** Separately, Beatrice is the household's
auditor, and is being built into the architect (PLAN Tier 1, Passes 1/2/4):
process-miss triage, `audit_connector_affordances` findings route to her, the
diagnostic kit (`analyze_tool_sequence`, `grep_codebase`, team-shape view), the
`mission:` layer + weekly team-health pass, and a bounded self-improvement loop
with a multi-agent review panel. She is the *judgment* layer.

The clean seam already exists: **Beatrice judges; Cordelia fills.** (Cordelia's
04:00 curation pass already reads the gaps Beatrice flagged at 03:00.)

## 3. The gap

To be "the expert on what makes specialists experts," three things are missing:

1. **A model of specialist excellence** — Cordelia has no stored notion of *what
   good looks like*. There is no rubric and no craft knowledge: the reusable
   patterns we keep re-deriving (domain-coverage completeness, source-tier
   discipline, grounded-with-falsifier claims, the structured-store +
   scan→extract→synthesize shape, recurring-question flags, swimlanes-by-
   capability-not-naming, leak/pre-launch signal, confirmed-vs-announced-vs-
   leaked labeling, demand-side persona/ICP/UCP grounding).
2. **Read access to specialist DEFINITIONS, not just shelves.** Her scope is
   `Knowledge/*/library/**` — she sees what's *on* the shelf but not the
   `persona` / `tools` / `trusted_sources` / `knowledge_scope` that *define* the
   specialist. To assess "is this specialist actually expert in their domain"
   she must read `config/specialists/*.yaml`, not just the clippings.
3. **A proactive deepening trigger.** Today the loop only runs on hire or on an
   explicit flag. Nothing periodically asks "which specialist is below bar, on
   which axis, and what advanced knowledge would close it?"

## 4. The proposal — three pieces

### (A) The "Specialist Craft" shelf — the meta-knowledge (Cordelia owns this)
Seed `Knowledge/Cordelia/craft/` with the playbook of what makes any specialist
world-class, distilled from the patterns we've shipped. This shelf *is* the thing
Cordelia is an expert in. The Kristi reference notes
([seed-kristi-knowledge.ts](../scripts/seed-kristi-knowledge.ts)) and her
two-layer architecture (scan→extract→synthesize, structured store + grounded
projections + demand-side profiles) are the first worked example to generalize.
Smallest, highest-value first step; ships independently of everything else.

### (B) Read access to specialist definitions
Give Cordelia a `read_specialist_spec(specialist_id)` tool (or widen her
`knowledge_scope` to include `config/specialists/**` read-only) so she can audit
the *spec*, not just the shelf — persona disciplines, `trusted_sources` tiers,
tool surface, `knowledge_scope`, `mission:` (once Beatrice Pass 2 lands).

### (C) The expertise-deepening loop (compose, don't duplicate)
- **Audit lives with Beatrice.** Add an *expertise-coverage* lens to her audit —
  an `audit_specialist_expertise` tool, modeled on Mariah's registry-walking
  `audit_connector_affordances`, scoring each specialist against the rubric
  (domain-coverage gaps, thin/stale sources, missing disciplines, empty
  structured-store layers, recurring-question coverage). It emits **`expertise_gap`
  findings**.
- **Fill lives with Cordelia.** An `expertise_gap` finding flags Cordelia over
  the **existing** `flag_cordelia` / `wake_on_flag` path — the *same shape* as
  on-hire bootstrap, just sourced from Beatrice instead of the orchestrator. She
  runs the research (she has `research_workload` + web/browse + `consult_deep_model`),
  `curate_for_specialist` onto the target's shelf, and files a `propose_action`
  for spec-level deltas (new sources, new persona disciplines, a new structured
  layer) that need Jasper's sign-off — because those edit the YAML.

This turns "Claude runs a deep-research workflow to seed Kristi" into "Beatrice
flags the expertise gap → Cordelia deepens the shelf → Jasper approves the spec
delta." No new wakeup machinery — it rides the bootstrap rails already in place.

## 5. Reuse map

| Need | Existing primitive to reuse |
|---|---|
| Curate onto a target's shelf | `curate_for_specialist` (Cordelia) |
| Wake Cordelia on a gap | `flag_cordelia` + `wake_on_flag` |
| Bootstrap rails / flag shape | `specialist_bootstrap` (orchestrator→Cordelia) |
| Registry-walking audit emitting findings | `audit_connector_affordances` (Mariah→Beatrice) |
| Gate spec-level changes to Jasper | `propose_action` + `trusted_source_addition` propose-gate |
| Team-shape / mission context for the audit | Beatrice Pass 1 (team-shape) + Pass 2 (`mission:`) |
| First worked example of the whole loop | The 2026-06-03 Kristi seed + persona/ICP/UCP build |

## 6. The fork — DECIDED 2026-06-03 (Jasper): Beatrice judges, Cordelia curates

**Where does the expertise RUBRIC + AUDIT live?**

- **DECIDED ✓ — Beatrice audits, Cordelia curates.** Preserves the
  critic/curator separation already working (and the 03:00→04:00 handoff).
  Beatrice is already getting the diagnostic kit, team-shape view, and mission
  layer that an expertise audit needs; adding an expertise lens there is cheap
  and avoids bloating the Master Librarian into a QA role. Cordelia stays the
  authority on *the craft + how to close the gap*, and executes it.
- ~~Alternative — Cordelia owns rubric + audit + fill.~~ Not chosen: duplicates
  audit machinery Beatrice is already growing, and stretches Cordelia's role.

Secondary questions (still open):
- Is the rubric **YAML/config** (a structured checklist Beatrice scores against)
  or **knowledge** (a Craft-shelf note Cordelia reasons from)? Leaning:
  knowledge for the craft, a thin structured checklist for the audit's
  machine-checkable axes (source count, empty store layers, missing falsifiers).
- Scope: all specialists, or opt-in per specialist (a `deepen: true` flag)?

## 7. Relationship to in-flight Beatrice work

This is the **knowledge-curation complement** to Beatrice's **behavior/structure**
passes — they meet at one new finding type (`expertise_gap`) and otherwise stay
in their lanes. It should sequence *after* Beatrice Pass 1 (the diagnostic kit
gives the audit its raw signal) and composes naturally with Pass 2's `mission:`
field (an expertise audit needs to know what the specialist is *for*). Piece (A)
— the Craft shelf — has no dependency and can land first.

## 8. Suggested sequencing

1. **(A) Seed the Specialist Craft shelf** — standalone, immediate, low-risk.
   Generalize the Kristi seed into the reusable craft playbook.
2. **(B) `read_specialist_spec`** — small tool; unlocks spec-level auditing.
3. **(C) the loop** — after Beatrice Pass 1: add `audit_specialist_expertise` +
   the `expertise_gap` finding on Beatrice; wire it to Cordelia's existing
   wake-on-flag; spec deltas go through `propose_action`.

A good standalone first PR is (A)+(B): Cordelia gains the craft knowledge and the
ability to read specs, immediately useful in chat ("Cordelia, where is Kristi's
domain coverage thin?") even before the automated loop exists.
