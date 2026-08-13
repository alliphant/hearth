# Kate self-direction — handling the unanticipated (design)

**Status: DESIGN-ONLY (2026-07-03). Nothing built.** Concept catalog in the
HearthGuard convention ([design-hearthguard.md](design-hearthguard.md)); build
starts only on Jasper's pick.

Jasper's ask, verbatim: *"how can we make Kate truly autonomous, unique, novel
and able to address things without our input based on common sense, logic and
various other items?"*

## The gap, stated honestly

Every autonomous behavior Kate has today is a **hand-built organ over an
anticipated class**: `scan_good_followups`, `scan_calendar_followups`,
`scan_cross_signals`, `scan_life_events`, `scan_meeting_prep`,
`scan_system_health`, the Proposal Court, the Case Driver, guard-feedback,
reactive triggers, trust teeth. Each one exists because a human anticipated a
failure/opportunity class and built a detector plus a gated action for it.
Kate exercises judgment *inside* each organ; she originates none of them, and
anything outside their union is invisible to her.

"Truly autonomous" means closing a specific loop she cannot run today:

1. **Notice** something novel is off (no scan owns it),
2. **Reason** about it from household norms + precedent + common sense,
3. **Decide** it's hers to handle,
4. **Act** within her envelope,
5. **Explain** herself afterward.

Mapped to organs:

| Loop stage | Exists today | Missing |
|---|---|---|
| Perceive | Per-class edge detectors | A general "this deviates from our normal" percept |
| Reason | Fixed per-scan prompts | An open-ended reflection over the whole fused picture |
| Ground | Persona + court lenses | Household case law — "what did we do last time" |
| Act | Proposals, trust-teeth classes | A first-class WATCH/INVESTIGATE action for things not yet actionable |
| Extend | Claude hand-builds each organ | Kate drafting her own standing behaviors |
| Explain | Audit rows (machine-facing) | A rationale surface: "what I did on my own, and why" |

## Non-negotiables (all inherited, none new)

- **The permanent floor**: send / spend / PIN-merge / hiring never
  auto-execute. Every concept below designs *around* the floor.
- **LAW #1**: code computes evidence, the model judges. No keyword lists, no
  carve-outs, no pre-injection as a substitute for the model deciding.
- **Fail-CLOSED** for anything user-facing (the `scan_life_events` contract):
  an LLM outage or garble files *nothing*.
- **Noise discipline — the roster-gaps post-mortem is a design input.** That
  failure ([roster-gaps memory](../../.claude/projects/-Users-jasper-Projects-hearth-backend/memory/roster-gaps-auto-hire-disabled.md))
  had three stacked causes, and each maps to a structural requirement here:
  1. *Category-error evidence* (raw `search_empty` exhaust read as staffing
     signal) → percepts must be **typed, grounded rows** (deviation records,
     ledger entries with evidence refs), never raw exhaust re-interpreted.
  2. *Wrong remedy headline* (the prompt led with "file a hire") → the
     disposition taxonomy **leads with the cheapest action** (ignore/watch);
     acting is the last-listed, capped option.
  3. *Prose dedup that the model ignored* → dedup and denied-suppression are
     **structural** (`exists_for_signature`, content-stable anchors,
     dismissed-stays-dismissed), never instructions.
- **The 35B's judgment ceiling is the honest baseline.** Open-ended noticing
  is exactly where a small model produces confident noise. Every concept
  below assumes intermittent bad judgment and makes bad judgment *cheap*
  (internal, dismissable, capped) rather than assuming it away.

## The one genuinely new governing mechanism: attention earns rope

Jasper's autonomy-as-RPG decision (trust XP, the scorecard's ≥90% arming gate)
governs *actions*. The same discipline extends to *initiative*: Kate's
self-directed observations and investigations get engagement-scored (brief
`got_it` / dismissed / acted-on — the court-digest idiom), and her disposition
caps (how many proposals/investigations per pass) are a function of that
score. Consistently dismissed initiative → her budget shrinks toward
watch-only. Consistently engaged initiative → caps widen. The owner never
tunes a knob; the throttle is his existing reactions. This is what makes an
open-ended noticing loop survivable with a 35B: noise self-limits instead of
compounding (the exact opposite of roster-gaps, where denied packets re-filed
every pass forever).

---

# The catalog, ranked

Ranking = how directly it closes the notice→reason→act→explain loop, weighted
by honest feasibility. Each entry leads with the limiting factor.

## 1. The walk-the-house reflection pass + observation ledger (C2) — the spine

**What.** One nightly open-mandate pass on the deep tier: Kate reads the fused
household picture and answers "what's off, what connects, what needs doing
that no scan owns?" — with a durable memory of what she's already noticed.
This is the general successor to the pairwise scans, already named in PLAN as
the "connect-the-dots pass" (Working-memory follow-ups); this design promotes
it from "coincidence nudges" to the self-direction organ.

**Limiting factor (lead).** The 35B's open-ended judgment. Expect three
failure shapes: banality (restating what working memory already says),
confident noise (a "concern" built on a misread), and disposition inflation
(everything feels act-worthy). None is speculative — roster-gaps demonstrated
all three. The envelope below makes them cheap, not absent. Second honest
limit: **signal poverty** — without C1 (norms) and C3 (precedent) the pass
only sees what working memory already fuses, so early observations may be
thin. That's acceptable (the ledger + cadence is the point; sharper inputs
arrive as C1/C3 land) but expect a modest first month, not magic.

**Mechanism.**
- Kate background job at 05:30 MT (after the 03:30–04:15 sweeps, before the
  07:00 brief so results ride it). ONE structured think-OFF envelope call
  (the bench verdict: think-ON is pure cost on the 35B), fail-CLOSED —
  garbled envelope files nothing, logs the miss.
- Input: `compose_working_memory` (exists, cordoned) + open observation-ledger
  items + norm deviations (C1, when present) + top precedent recalls (C3,
  when present) + open-loop counts (misses, aged proposals).
- Output: `observations[]`, each `{anchor, summary, evidence_refs[],
  disposition, rationale}`. Dispositions, in prompt order (cheapest first):
  `ignore` | `watch {recheck_when}` | `investigate {question}` (C4) |
  `act {via existing gated path}` | `ask {present_questions}`.
- **The observation ledger** (`kate_observations` table) is the novel organ:
  content-stable anchors, recurrence trails, dismissed-stays-dismissed,
  expiry. Open `watch` items re-enter the next pass's input — this is what
  turns one-shot scans into *ongoing attention*. Most agent systems are
  stateless between passes; the ledger is the difference between "a nightly
  prompt" and "she's been keeping an eye on it."
- **The act envelope is exactly the existing gates**: file a proposal (→
  court/owner, `exists_for_signature`-deduped, cap ≤2/pass), scoped wake to a
  domain specialist, self-expiring briefing, `present_questions`. Zero new
  effect paths. The floor is untouched by construction.
- **Explain**: the brief's existing `watching` section renders open watches;
  acts get a compact "on my own initiative" brief line carrying rationale +
  evidence refs. Every disposition writes its rationale to the ledger row —
  auditable *and* owner-readable.

**Safety / reversibility.** Kill switch (`HEARTH_KATE_REFLECTION`). Week one
ships **watch-only** (act/investigate dispositions disabled in config — the
trust-teeth scored-week pattern applied to initiative); Jasper reads the ledger
before any act disposition arms. Everything it produces is a dismissable
artifact. Worst case at full arm: ≤2 junk proposals/day that the court (which
already convenes daily) screens before Jasper sees them.

**Composes with.** Working memory (input), the court (QC on its proposals),
the brief (output surface), C1/C3/C4 (plug into input/dispositions), the
initiative scorecard (throttle). Subsumes the PLAN connect-the-dots bullet —
do not build that separately.

**Smallest slice.** Job + envelope + ledger + brief `watching` integration,
watch-only. ~1 session. Verdict: **build first — this is the spine; every
other concept is an input or an arm of it.**

## 2. Precedent memory — household case law (C3)

**What.** The decided history is labeled training data nobody reads: ~760
closed process misses (root cause → fix → verified), every decided proposal
(approved/denied/expired + reasons), every court verdict (three lens
rationales per case), engagement rows. Index each as a *case* (situation →
action → outcome), embedded (the live bge/infinity box), retrievable. "Common
sense" for a household is mostly *its own case law*.

**Limiting factor (lead).** Label quality. Owner denials often carry no
reason; a deny can mean "wrong idea," "bad timing," or "already handled," and
retrieval can't distinguish — so the model can over-generalize from a
mislabeled case. Court verdicts are richer (lens reasoning is recorded), but
the case base is hundreds of items skewed toward internal hygiene, not
household life. Mitigation: cases render *with* their outcome confidence
("denied, no reason recorded — weak precedent"), and precedent is always
evidence in a prompt, never a decision rule.

**Mechanism.**
- Nightly indexer: decided proposals + `proposal_court_verdict` audit rows +
  closed misses + engagement → compact case docs → `precedent_cases` table
  (BLOB vectors, the `chunk_embeddings` pattern). Cordon-inherited from the
  underlying proposal.
- `recall_precedent(situation)` — a read tool on Kate's chat/deliberation
  surfaces (the model decides to consult history; LAW #1-clean).
- Injection at two *system pipeline* chokepoints (evidence-shaping, the
  citations/exemplar idiom — not chat pre-injection): the court's lens
  evidence packs ("the bench has seen this shape before: approved 2×, denied
  1× because…"), and `ProposalsStore.create()` attaching precedent matches to
  the payload the court/owner sees (determinism inside a mechanism the system
  already invoked).

**Measurable — a falsifiable win.** The court scorecard already computes
court-vs-owner agreement. Precedent injection should *raise* it. If agreement
doesn't move after two weeks, the concept under-delivered — say so and stop.
No other concept in this catalog has a metric this clean.

**Safety / reversibility.** Read-only; zero user-facing surface of its own;
kill switch. Worst case: irrelevant precedent lines in prompts (token cost).

**Composes with.** The court (sharper lenses → safer trust-teeth arming),
C2 (precedent recalls in the reflection input), trust XP (case outcomes are
the XP substrate re-read as text). Fold-in from C6: while touching the
`create()` chokepoint, extend the existing proposal-filing critic with a
**decided-history** dedup check (today it only screens open proposals) and
deterministic temporal sanity (event already past, date arithmetic) — small,
same file, closes the "re-propose what was denied last month" hole
structurally.

**Smallest slice.** Indexer + table + recall tool + court-lens injection.
~1 session. Verdict: **safest high-value build; the only one with a built-in
before/after metric. Strong candidate to ship alongside or immediately after
the spine.**

## 3. Household norms substrate — deviation percepts (C1)

**What.** A deterministic "what does normal look like" layer per signal —
occupancy rhythm, calendar density, mail/order cadence, spend cadence, sensor
slow-drift, device health — with deviations emitted as typed percept rows.
This is the *perception organ*: today Kate can only notice what a hand-built
detector fires on; norms make "this is unusual for us" a first-class input.

**Limiting factor (lead).** Cold start + single-household seasonality. A
min-samples floor means **2–4 weeks dark** before any deviation is
statistically meaningful, and the first cold snap / school break / vacation
will flag as deviant *forever the first time* — a norms model over one
household's few months genuinely cannot know the difference between "anomaly"
and "annual." False positives early are certain, which is why the feed's ONLY
consumer is Kate's internal reflection (C2) — never a push, never a proposal
directly. Second limit: per-signal mapper plumbing is the real cost (each
signal needs a small adapter, the `BeliefSignal` pattern), and it's boring
work that grows linearly with coverage.

**Mechanism.**
- Accumulator driver subscribed to existing events (`sensor_packet_received`,
  `mail_message_triaged`, `order_upserted`, location packets) — the
  ReactiveInboxDriver pattern. Per (signal, entity, hour-of-week bucket)
  running stats in a `household_norms` table. Pure code; no LLM at intake
  (LAW #1: the stats are evidence; the model judges significance later).
- `norm_deviations` feed: a reading outside its band (with the min-samples
  floor) writes ONE edge-detected row `{signal, expected, actual, rarity,
  window}` — a persisting deviation updates its row, never floods.
- **Shared with HearthGuard** — its Phase-2 adaptive core needs "learns the
  household's normal" for safety signals. ONE substrate serves both; building
  two parallel norm layers would be the exact paralleling this repo bans.

**Safety / reversibility.** Read-only, dark, kill-switched. Worst case: a
table of wrong statistics nobody reads.

**Smallest slice.** Two tables + three mappers (occupancy rhythm from
location events; calendar density from `life_events`; mail/order cadence) +
the deviation feed rendered into C2's input when present. ~1 session, then
weeks of silent accumulation. Verdict: **foundational but slow to become
useful — ship it dark early precisely BECAUSE of the cold start; every week
it isn't accumulating is a week of baseline lost.**

## 4. Curiosity budget — bounded self-directed investigations (C4)

**What.** N self-directed investigations per week (start: 2) Kate can spend
on her own watch items: a `deep_research` run (the full spine exists), a
scoped specialist wake, a connector read-sweep. Output is a self-expiring
briefing/dossier — never an action. "The water bill jumped 40%, I looked into
it before bothering you" is the behavior.

**Limiting factor (lead).** Target-worthiness. Even grounded targets can be
trivia, and each investigation costs real deep-tier time (bounded: the
deep-research fan-out is already capped at 2 concurrent). The constraint that
makes it survivable: targets MUST be open ledger items (C2's `investigate`
disposition) — no free association — and the engagement score throttles the
budget like everything else. Without C2's ledger this concept has no
grounded target source, so it is **an arm of C2, not standalone**.

**Mechanism.** `initiative_budget` durable counter + spend rows (audited,
rationale + serving watch-item); the `investigate` disposition checks budget,
kicks the existing detached deep-research runner, files the dossier + ledger
update on completion.

**Safety / reversibility.** Read-only outputs; budget-capped; kill-switched.
Worst case: 2 boring dossiers a week.

**Smallest slice.** The disposition wiring + budget counter. ~half a session
once C2 exists. Verdict: **cheap, visible, genuinely "without our input" —
ship as C2's week-two arm.**

## 5. Self-authored automations — the staff extends itself (C5)

**What.** Kate detects a repeated pattern in her own exhaust ("I've filed
this same proposal shape four Mondays running"; "Jasper asks for X every
Friday") and drafts a *standing automation* — a constrained spec (trigger:
schedule|event; condition; action = existing tool + args template; cordon;
cap; kill switch), shadow-tested, owner-activated. The endgame of
self-direction: the system growing its own organs instead of waiting for a
build session.

**Limiting factor (lead).** This is the roster-gaps failure shape writ large
— a model observing itself and filing artifacts about it — and it inherits
every risk that killed auto-hire: noisy self-observation, unreliable
args-template authoring on a small model, and an activation that (unlike a
one-shot proposal) *compounds daily* if mis-authored. The generic executor's
safety rails (shadow mode, per-automation kill + rate cap, auto-revoke on N
dismissals) are the expensive 90% — realistically 2–3 sessions, not one. Do
not build this before the throttle discipline (C2's scorecard) has a proven
month.

**Mechanism (when its time comes).**
- Recurrence miner: deterministic (the `miss_class_key` normalization idiom)
  over her own proposals/audit — "same signature ≥N in M weeks." No LLM in
  detection.
- Draft: the model authors the spec — config rows, NEVER code. Code-level
  automations (a new TriggerDef, a new scan) stay in Beatrice's gated
  pipeline unchanged.
- Shadow mode mandatory: the registry runs the spec's *read side* for a week,
  logs would-have-fired rows, files nothing. Then a recommendation to Jasper
  with the shadow log attached. Activation is his tap, forever (initially).

**Smallest honest slice.** The MINER + a "you keep doing this manually — want
me to make it standing?" recommendation carrying the drafted spec. **No
executor.** If Jasper approves one, we build that automation by hand through
the normal pipeline and count how often this actually happens before
investing in the generic executor. Verdict: **the destination, and last in
build order. The slice is honest; the full executor is a bet that shouldn't
be placed until the miner proves there's recurring demand.**

## 6. Common-sense gate (C6) — verdict: fold in, not a concept

Blunt verdict: **mostly already exists.** The Proposal Court *is* the
common-sense layer for proposals (three lenses, daily); the honesty guards
own grounding; the proposal-filing critic screens duplicates at create. The
genuine residue is small and deterministic: temporal sanity (proposing prep
for a meeting that already happened), decided-history dedup (the critic only
checks OPEN proposals today), magnitude bounds (gift idea 3× any recorded
spend). That's an extension to the existing critic at the `create()`
chokepoint — folded into C3's work above — plus, optionally, one
proportionality line in the court's household lens. Not a new organ; listing
it as one would be inflating the catalog.

---

# Composition — how the organs form the loop

```
        C1 norms            C3 precedent
     (deviation feed)      (case law recall)
            \                    /
             v                  v
   C2 WALK-THE-HOUSE REFLECTION  ←— working memory (exists)
   observation ledger + dispositions
      |        |         |       |
    watch  investigate  act     ask
   (ledger)  (C4 budget) (existing gates: (present_questions)
                          proposal→court/owner,
                          scoped wake, briefing)
                     |
              outcomes + engagement
                     |
        initiative scorecard (attention earns rope)
                     |
        C5 recurrence miner → drafted automations (shadow → owner tap)
```

Every stage: kill-switched, fail-closed at user-facing edges, artifacts
dismissable, dedup structural, the floor untouched. Nothing parallels an
existing spine — C2 subsumes the planned connect-the-dots pass, C1 is shared
with HearthGuard's adaptive core, C3 rides the court and the filing critic,
C4 rides deep_research, C5 rides the scheduler/trigger/Beatrice spines.

# What we are NOT building

- **A bigger model.** The 35B + structural discipline is the bet; the
  scorecards tell us if the judgment ceiling is actually the binding
  constraint before any hardware conversation.
- **A free-form act envelope.** No new effect paths, no "Kate can run any
  tool overnight." The act disposition is a router to existing gates.
- **Auto-hire resurrection.** Staffing stays off every autonomous surface.
- **A parallel proposal/attention pipeline.** The ledger feeds the same
  proposals table, court, brief, and XP chokepoints everything else uses.
- **Unconstrained self-modification.** C5 drafts config-shaped specs;
  code changes remain Beatrice's gated pipeline with Kate review + owner
  merge, unchanged.

# Arming discipline (the pattern, uniform across concepts)

1. Ship dark behind a flag; smokes prove the mechanism with scripted seams.
2. Soak in the cheapest posture (watch-only / index-only / shadow-only) for
   ≥1 week; Jasper reads the artifacts.
3. Engagement score computed from his existing reactions — no new chores.
4. Arm the next disposition tier on his say-so, never automatically (the
   trust-teeth gate, generalized).
5. Any concept that can't show engagement after a month gets turned off and
   said so — a nightly no-op costing a deep-tier call is not a feature.

# Recommended build order

1. **C2 spine** (reflection + ledger, watch-only) — 1 session. Nothing else
   has a home until the ledger exists.
2. **C3 precedent** (+ C6 fold-in) — 1 session. Safest, and the court
   scorecard gives an immediate falsifiable read on whether it helps.
3. **C1 norms** — 1 session then silent accumulation. Ship early because
   cold-start time is the cost; every week dark-accumulating is free signal.
4. **C4 curiosity** — half a session, arms C2's investigate disposition.
5. **C5 automations** — miner+draft slice only, after the scorecard has a
   proven month.
