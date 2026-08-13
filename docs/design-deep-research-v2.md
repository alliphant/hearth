# Deep Research v2 — investigator subagents, real verification, no artificial clock

**Status:** design, not built. Written 2026-07-29 out of a live failure
audit, not speculation — every requirement below traces to something that
actually went wrong in a shipped investigation.

**Owner ask:** *"spin off the deep research concept and plan to enhance it
greatly — investigator and research subagents, no time limit (within
reason — Kate can determine if something has hanged?), the right tools."*

---

## 1. What v1 is today

`deep_research` files a `research_investigations` row and kicks a detached
runner ([research_investigation_runner.ts](../src/specialists/kate/research_investigation_runner.ts)):

```
plan (planner LLM → N sub-questions)
  → acquire (per sub-question: web_search, fetch top K, extract findings)
  → verify (assess_factual_grounding over the findings)
  → synthesize (dossier_md) → shelve to the filing specialist's library
                            → person-note writeback (person subjects)
```

It is detached, sliced, crash-recoverable (`advance_research_investigations`
is the retry sweep), and cordoned per requester. That skeleton is right and
v2 keeps it.

### The budget it actually runs under

| knob | default | max |
|---|---|---|
| `HEARTH_DEEP_RESEARCH_FANOUT` | 6 sub-questions | 8 |
| `HEARTH_DEEP_RESEARCH_FETCH_PER_SQ` | 3 sources | 5 |
| `HEARTH_DEEP_RESEARCH_SLICE_MS` | 5 min | 30 min |
| `MAX_DETACHED_SLICES` | 8 | — |
| `HEARTH_DEEP_RESEARCH_CONCURRENCY` | 2 | 3 |

**Ceiling: ~18 sources, ~40 minutes.** That is a briefing, not an
investigation.

---

## 2. The evidence — four failures from one real ask

The owner asked Ruby for a workup on a councilmember: his record and stated
reasons, an assessment of those reasons on privacy and immigration-enforcement
data sharing, his re-election timing, what the city charter requires for a
recall, and the public case against replacing the cancelled camera contract
with a successor vendor.

**F1 — Multi-part briefs silently lose most of their parts.** Delivered: a
biography. Absent entirely: the recall procedure, the successor-vendor case,
the police budget analysis, the subject's actual stated reasoning. Cause is
arithmetic, not judgment: six facets against a 6-sub-question fan-out at 3
fetches each, where "what does the charter require for a recall" alone needs
sustained reading of a JS-rendered municipal-code site. Nothing tracks whether
a facet was *answered*, so unanswered ones vanish without a trace.

**F2 — Verification is tautological.** `verify_investigation` builds its
evidence corpus from the finding texts, then passes those same findings as the
candidate. Every claim is "supported by" itself. Real output on a dossier that
contained a plainly false claim: `{"claims_checked":4,"verdicts":[]}`. Source
**bodies are never persisted**, so there is nothing else to check against.

**F3 — A name match was treated as a person match.** A dossier on a Fort
Collins councilmember absorbed the X profile of a same-named New York Times
editor living in New York. Every sentence was individually true and correctly
cited: the pipeline verifies *claim → source* and never *source → subject*.
The synthesis model even noticed — it wrote *"though it lists his location as
New York, NY"* — and shipped it, because nothing downstream could act.
(Partially mitigated: `identity_conflicts` + a gated person writeback now
flag location conflicts. Occupation/employer conflicts are still unmodelled.)

**F4 — Dates are taken from whatever page they appear on.** A vote was
recorded on the date its *coverage was published* rather than the date it
happened. Separately, a term-end was rendered as a completed re-election.
(`temporal_inconsistencies` now catches the tense class; provenance-of-date
is unaddressed.)

**The through-line:** v1 has one worker shape (search → fetch → extract) and
one quality gate (a grounding check that cannot fail). It cannot go deep, and
it cannot tell when it is wrong.

---

## 3. v2 — investigators, not a fan-out

### 3.1 An investigator is a real agent turn

Today a "sub-investigator" is a fixed pipeline: one search, K fetches, one
extraction call. It cannot follow a citation, cannot notice that a page
redirected to a form, cannot decide the answer lives in a PDF three links
deep.

v2 makes each sub-question a **delegated agent turn** on the existing
`delegate` / `DelegationRunner` spine (Semaphore-bounded, own context, own
tool rounds, bounded digest returned — the requester's context never pays for
the delegatee's exhaust). An investigator gets a brief, a tool grant, a round
budget, and a **required return shape**: findings with per-claim citations, a
self-assessed confidence, and an explicit `unanswerable` verdict when the
sources genuinely do not support an answer.

That last field is what fixes F1. An unanswered facet becomes a recorded
`unanswerable` with a reason, not a silent omission.

### 3.2 Typed investigators with the right tools

One tool grant for every question is why a records question and a reputation
question get the same treatment. v2 types the investigator and grants
accordingly:

| investigator | for | tools beyond search |
|---|---|---|
| `records` | statutes, charters, minutes, filings | `browse_url` (JS-rendered portals), PDF fetch → `ingest_to_library`, official-host floor |
| `person` | who someone is, disambiguation | `who_is`, `find_person`, identity-anchor checks |
| `press` | coverage, reaction, timeline | search + fetch, **publication-date vs event-date discipline** |
| `numbers` | budgets, money, quantities | filing/CSV fetch, arithmetic, no prose-only claims |
| `local` | household-specific relevance | the requesting specialist's OWN ledgers (`query_civic_ledger`, library) |

The planner picks a type per sub-question. A records investigator asked for
the recall procedure gets a browser and a document-ingest path and a round
budget that lets it actually read a code section — the specific thing that
failed.

### 3.3 Identity resolution is a PHASE, not a check

For a person subject, v2 runs a short **anchor phase before fan-out**:
establish the distinguishing attributes (place, role, employer, affiliation)
and write them to the row. Every investigator receives the anchor and must
return an identity verdict per source. Non-matching sources are dropped *at
the investigator*, with the drop recorded — not folded into the dossier with a
concessive clause.

This generalises F3's fix from location-only to the attribute set, and it puts
the decision where the evidence is.

### 3.4 Source bodies get persisted

`research_sources` (new): `investigation_id`, `url`, `fetched_at`,
`title`, `body_md`, `content_hash`, `publisher`, `published_at`.

This is the keystone. It makes verification real (F2), lets the temporal check
compare an event date against the *page's* published date (F4), gives the
synthesiser quotable text instead of remembered text, and makes re-verification
possible without re-fetching. Cap body size, keep them for the investigation's
life plus a retention window, and cordon them exactly as the dossier is.

### 3.5 Verification that can actually fail

With bodies persisted, `verify_investigation` stops grading findings against
themselves and grades them against **source text**. Then add, in order of
cheapness:

1. **Deterministic checks** — the existing temporal pair, identity conflicts,
   and a new *internal-contradiction* pass (mutually exclusive employment,
   location, or dates asserted about one subject). No LLM, no corpus.
2. **Quote-anchoring** — every load-bearing claim carries a verbatim span
   from a persisted body, verified by string containment. This is already the
   proven pattern in Ruby's `evidence_quote` gate; reuse it.
3. **Adversarial pass** — a critic that tries to *refute* each surviving
   load-bearing claim from the same bodies, rather than confirm it.

Failures are **flagged and surfaced in the dossier**, never silently scrubbed
— the existing `scrub_dropped_claims` behaviour is too destructive to trust
while precision is unproven.

### 3.6 A coverage ledger

The plan's sub-questions become a tracked checklist on the row: `answered`,
`partial`, `unanswerable(reason)`, `not_attempted`. The dossier **opens with
it**. A reader sees at a glance that the recall procedure was not established,
instead of discovering the absence themselves. An investigation with
`not_attempted` facets is not `done` — it is `incomplete`, and the sweep can
resume it.

---

## 4. "No time limit, within reason"

Replace a wall-clock ceiling with **budgets + progress**, which is what the
owner is actually asking for.

- **Budgets, not deadlines.** Cap total sources fetched, total investigator
  turns, and total tokens. An investigation runs until its facets are answered
  or its budget is spent. Depth (`quick` / `standard` / `exhaustive`) selects
  the budget, and `exhaustive` should be measured in hours and hundreds of
  sources, not 40 minutes and 18.
- **Slices stay.** Long work still advances in resumable slices; the runner is
  already crash-recoverable. Remove `MAX_DETACHED_SLICES` as a hard stop and
  let the budget be the stop.
- **Progress is the liveness signal, not elapsed time.** Every slice must move
  a counter — a source fetched, a facet resolved, a claim verified. A slice
  that ends with no counter moved is a *stall*.

### Kate as watchdog

Kate already owns `list_research_investigations` and the office Research tab,
so she is the natural supervisor. Add a **stall rule**: N consecutive slices
with no progress, or a slice that exceeds its own budget by a wide margin →
the investigation is marked `stalled` with its last log line, and Kate is
notified with three options: resume with a larger budget, narrow the brief, or
abandon with a partial dossier.

The distinction that matters: **stalled ≠ slow.** An exhaustive investigation
legitimately running for hours while its counters climb is healthy and must
never be killed. Only a *stationary* investigation is hung. Encode that, and
"no time limit within reason" becomes precise.

---

## 5. Phasing

Each phase is independently shippable and independently useful.

| # | phase | unlocks | risk |
|---|---|---|---|
| 1 | ✅ **SHIPPED 2026-07-29** — **Persist source bodies** (`research_sources`) | real verification, date provenance, quotable text | low — additive table |
| 2 | ✅ **SHIPPED 2026-07-29** — **Coverage ledger** + `incomplete` status | F1: facets stop vanishing | low |
| 3 | ✅ **SHIPPED 2026-07-31** — **Verification on bodies** | F2: the gate can fail | medium — shipped FLAGGING; drops opt-in |
| 4 | ✅ **SHIPPED 2026-07-31** — **Agentic investigator** (NOT on `delegate` — see §9) | depth; F1 properly | medium |
| 5 | ✅ **SHIPPED 2026-07-31** — **Budgets replace deadlines** + stall watchdog | "no time limit, within reason" | medium |
| 6 | ✅ **SHIPPED 2026-07-31** — **Identity anchor phase** | F3 beyond location | low |

Phases 1–2 are worth doing on their own even if 4 never lands.

**Phase 4's framing changed.** It was written as "make each sub-question a
delegated agent turn", on the theory that the fixed search→fetch→extract
pipeline was the limiting factor. The 2026-07-31 evidence says the limiting
factor was one level lower: the pipeline was pointed at the wrong *sources*. A
smarter agent searching the open web for "Georgetown TX property records" still
gets SEO farms. §8 addresses that directly; a delegated agent turn remains
valuable for depth (following a citation, reading a PDF three links deep) but is
no longer the thing standing between v1 and a usable records answer.

---

## 8. Source strategy — shipped 2026-07-31

Two live failures drove this, and neither is a model-quality problem.

**"Josie Kim Reyes"** (`ri_gzd46bpsys59`) returned a stranger's CLEANFLEET
career as a friend's biography. Fixed by the name gate (2026-07-30).

**"Daniel Ray Torres"** (`ri_3kq84nfd4mz0`) — a person apparently stalking the
household. 0 of 6 facets answered, 10,074 characters of elaborated absence, and
**17 of 18 sources never named him**: a Wikipedia page about the NAME
"Jonathan", a baby-name site, a Bible dictionary, a Honda tuning forum, a GitHub
webcompat bug, a Spokeo teaser for a different Daniel Torres in *Virginia*,
and 32KB about Pleasantville, Colorado — because the search engine localised to
the HOUSEHOLD rather than the subject, who lives in Texas.

### 8.1 Attribution tiers — the owner's explicit worry

> *"I don't want linkedin searches/browsing traced back to me."*

Today's LinkedIn fetches are anonymous (Firecrawl), so nothing is attributable.
That is not reassurance, it is the bug: the persisted guest-wall body is **549
characters**, `THIN_MARKDOWN_MIN` is **900**, so a LinkedIn fetch is a thin
shell — and a thin shell **escalates to the warmed Firefox**, which keeps
signed-in profiles by hand. LinkedIn shows the subject who viewed them. The
escalation built to defeat bot walls is exactly what would tell a stalker he is
being investigated.

Attribution is a property of the **(source, path)** pair:
[research_attribution.ts](../src/core/research_attribution.ts) computes it, the
host table lives in [config/research-sources.yaml](../config/research-sources.yaml)
(an inventory of *our own* signed-in profiles, not a LinkedIn carve-out), and
enforcement is in `fetch_with_browser_fallback` so no caller can forget it. A
PERSON investigation is capped `passive`; refusals are recorded and stated in
the dossier as a *choice*.

### 8.2 Jurisdiction as a real phase

A records question is unanswerable until you know which county system holds the
record. [research_jurisdiction.ts](../src/core/research_jurisdiction.ts) does
deterministic candidate extraction → **real geocoder verification** against the
household's own Nominatim (already deployed, US-wide): "Georgetown, Texas" →
`Williamson County`. Never an LLM guess about geography. Unresolved is a real
answer that makes records facets honestly `unanswerable` with a fixable reason.

### 8.3 Typed investigators + source rosters

The planner tags each sub-question `records` or `topic`. A `records` facet runs
CourtListener first (free, keyless, real dockets — a live probe for `"Jonathan
Torres"` returns 267), then jurisdiction-scoped discovery against the roster's
templates with an **official-host floor** that keeps `countyoffice.org` from
impersonating a county. Aggregators are demoted in every investigation.

### 8.4 Limits stated in the product

CAPTCHAs are **never** bypassed; a CAPTCHA-walled portal is named and linked as
a hard boundary. A portal that serves a search form is labelled as such rather
than read as "no records found" — a false negative about someone's court
history is the worst output this system can produce. Sealed/expunged records and
paywalled aggregators are stated as structurally unreachable. When the records
tier is closed, the report says once that a police report and a licensed PI
reach what we cannot and produce documentation a court accepts.

### 8.5 What phase 3 deliberately did NOT do

The verifier now grades against source bodies and can fail. It **flags**;
`dropped_claims` stays empty behind `HEARTH_RESEARCH_VERIFY_DROP=1`. A verifier
that can fail is one that can fail *wrongly*, and its output feeds
`scrub_dropped_claims`, which deletes lines from a dossier a human will act on.
Precision gets measured against real dossiers before anything is deleted.

## 6. Open questions for the owner

1. **Cost ceiling for `exhaustive`.** Hundreds of fetches and many deep-tier
   calls is real spend. A per-investigation budget the owner sets, or a
   standing monthly allowance?
2. **Should an investigation be able to ask for help?** When a facet is
   genuinely unanswerable from public sources, does it file a proposal asking
   the owner (who may know, or have the login), or just record it?
3. **Who else gets it.** Kate and Ruby hold `deep_research` today. Anna
   (property records) and Kristi (competitive intel) are obvious next research
   fronts — the tool is agent-agnostic and the route gates on the capability,
   so it is a grant, not a build.
4. **Retention.** How long do persisted source bodies live? They are the
   evidence trail, but they are also a copy of the web on our disk.
   **Still open.** Phase 1 shipped with a deliberately conservative
   `HEARTH_RESEARCH_SOURCE_RETENTION_DAYS=30` and a 40k-char per-body cap
   (`HEARTH_RESEARCH_SOURCE_BODY_CAP`), swept by one indexed DELETE per slice.
   30 days comfortably outlives an investigation plus a window in which the
   owner might question a dossier's grounding, and it bounds footprint without
   the owner having to decide anything — but it is a placeholder chosen to be
   safe, not an answer. Phase 3's quote-anchoring and any "re-verify an old
   dossier" workflow both want a longer window; raise it via env once the owner
   says how long the trail should be kept.

## 7. What NOT to change

- **Detached + sliced + crash-recoverable.** The skeleton is correct.
- **Cordoning.** Per-requester `private_to` on the row, the dossier, and now
  the source bodies.
- **Flag, don't drop.** Until precision is proven, a suspect claim is
  surfaced with its warning, never silently deleted.
- **The dossier shelves to the FILING specialist** (fixed 2026-07-29 — it was
  hardcoded to Kate, so Ruby could never read her own work back).

---

## 9. Phases 4 + 5 — shipped 2026-07-31

### 9.1 Phase 4 does NOT use the `delegate` spine, deliberately

§3.1 proposed making each sub-question a delegated agent turn on the existing
`delegate` / `DelegationRunner` spine. **That was written before phases 1–3
existed, and it is now the wrong shape.**

A raw delegated turn calls `web_search` and `browse_url` *itself*. Every guard
this subsystem is made of lives on the runner's fetch path:

- the **attribution cap** (a person investigation must not use a path that
  tells the person),
- the **name gate** (a source that never names the subject is not about them),
- the **identity anchor** (same name ≠ same person),
- **source persistence** (`research_sources`, which is what makes verification
  and quote-anchoring possible at all).

Handing an agent the wheel would have routed around all four and re-opened the
exact failures phases 1–3 closed — a stranger's biography, an unverifiable
dossier, a notified subject.

So the agency is real but it is **exercised through one door**: `consume_hits`
in the runner. The model decides what to read next; every choice it makes is
fetched, gated and persisted by the same code as round 0. That is still "the
model determines intent → spends a tool call → acts on the result" (LAW #1),
without a hole in the safety layer.

What the investigator can now do between rounds (`decide_next_step`):
re-query with different wording when its own phrasing was the problem, follow a
link when the answer is one level deeper, or declare the facet **unanswerable
with a confidence** — an honest verdict rather than an empty section.

**One guard is load-bearing and easy to miss:** a followed URL must appear
**verbatim in text we actually read**. Without it the model can emit a
plausible-looking URL and the runner would fetch it, *manufacturing a source
out of nothing* — the same fabrication class the whole workstream exists to
kill. The text is the proof.

Fail-CLOSED: an unparseable or missing decision leaves the facet exactly where
round 0 left it, which is the pre-phase-4 behaviour.

### 9.2 Phase 5 — stalled ≠ slow

A clock cannot tell a run that is working hard from a run that is stuck. Both
look like "still going". So the two ideas are separated:

- **Budget** bounds the WORK — sources read, investigator rounds — chosen by
  `depth`. `exhaustive` is 250 sources and 160 rounds, against v1's real
  ceiling of ~18 and 8 slices. `deep_research` takes a `depth`, and re-running
  the same subject at a deeper setting RESUMES that investigation with the
  larger allowance rather than starting over.
- **Progress** is the liveness signal: a monotonic signature over sources read,
  rounds spent, facets resolved and claims verified. A slice that ends with the
  signature unchanged did nothing, whatever its phase transitions say — which
  is why progress is measured from counters and not from the runner's
  `progressed` flag, which flips true on a bare status change.

**An exhaustive run grinding for hours while its counters climb is healthy and
is never interrupted.** Only a *stationary* run — `HEARTH_RESEARCH_STALL_SLICES`
consecutive slices moving nothing, default 3 — becomes `stalled`, which is a
real status carrying a notification that names three options: keep going with
more budget, narrow it, or stop with the partial. `smoke:research-budget`
asserts 200 slow-but-productive slices are never called stalled; if that check
ever fails, someone has reintroduced a timer.

`stalled` is deliberately **not** in `OPEN_INVESTIGATION_STATUSES`: the sweep
must not quietly resume a run that is going nowhere, because that is how a
stall becomes an infinite loop nobody sees. Note also that it had to be added
to `ALL_STATUSES` — `to_row` coerces any unrecognised status to `failed`, and
"Hearth broke" is a materially different thing to tell the owner than "this
stopped making progress, here is what you can do".

Budget exhaustion is neither a stall nor a failure: the run moves to verify so
the owner still gets the partial dossier, with a note saying it stopped because
it spent its allowance rather than because the questions ran out.
