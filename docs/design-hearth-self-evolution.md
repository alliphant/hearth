# Hearth self-evolution — the cheap middle layer, and the loop that closes itself

> **Status:** BUILT, deployed, and dark. 2026-08-03; hardened 2026-08-04 after
> an adversarial audit broke two of the safety claims (see §7). Skills are live
> for Kate; the evolution pass is unarmed.
> Companion to [`design-kate-self-improvement.md`](design-kate-self-improvement.md)
> (this builds its §2 "Tier-1 skills-as-data", the piece marked unbuilt) and
> [`design-kate-self-direction.md`](design-kate-self-direction.md) (this reuses
> its arming discipline verbatim).
> Prompted by a read of Nous Research's **Hermes Agent** v0.18–v0.20 releases.

---

## 0. TL;DR

Hermes's whole self-improvement story is that **learning lands in cheap data
artifacts, not in code and not in weights**. Hearth's is the opposite: every
improvement-shaped thing routes through a git PR, a deterministic gate, a
review swarm, and the owner's thumbprint. That is *correct* for code and
*ruinous* as the only speed available.

Two gaps, both now closed:

| | Gap | Closed by |
|---|---|---|
| **#2** | No procedural memory. A six-call sequence worked out with the owner is gone by tomorrow. | `src/core/skills.ts` + `learn_skill` / `recall_skill` |
| **#1** | Eval failures dead-end at a human. A red task files a `process_miss` and waits. | `src/core/eval_diagnosis.ts` |

**What Hearth already had, and Hermes does not.** Worth stating before the
gaps, because it changes what is worth copying: `change_measurement.ts` — a
same-task delta arbiter that scores whether an applied change actually helped.
Hermes has no equivalent; its loop can drift and never know. Hearth's problem
was never measurement. It was that nothing *proposed*.

---

## 1. What Hermes actually does

From v0.18 "Judgment" (2026-07-01) through v0.20 "Herald" (2026-08-03):

- **Skills-as-data.** Solve once → write a reusable `SKILL.md` → recall it.
  Data, not code, so it is live the same session. `/learn` distills a workflow
  into one.
- **Skill self-patching.** A skill invoked and found lacking is patched in
  place. No review round-trip.
- **The Curator** (v0.20). A background job that prunes and sharpens the skill
  library.
- **GEPA self-evolution** (separate repo, ICLR 2026). Reads execution *traces*
  to work out **why** something failed — not merely that it did — then proposes
  targeted prompt/skill diffs via DSPy. Gated by tests and size limits; every
  variant lands as a PR, "never direct commit." ~$2–10 per run, no GPU.
- **Completion contracts** (v0.18) + **tool self-recovery** (v0.20). "Done"
  proven by test execution rather than asserted; tools that return an
  actionable failure instead of a dead end.

The transferable insight is not any one feature. It is the **three-speed
system**: documents (free, instant, reversible) → prompts (cheap, gated) →
code (expensive, reviewed). Hearth had speeds one and three, and had wired
speed two to only ever be edited by hand.

---

## 2. Gap #2 — Tier-1 skills-as-data

### 2.1 The one invariant

> **A skill is a DOCUMENT, never a PROGRAM.**

The runtime never executes a skill. It renders one into the prompt; the model
then makes each tool call itself through the ordinary gated dispatch — same
capability check, same risk tier, same audit row, same owner tap on anything
externally-visible.

Everything else follows from that sentence. A skill cannot widen what a
specialist may do, so the worst a bad skill can do is give bad advice — the
same blast radius as a bad persona line. That is why this needs no court, no
merge, and no `PROTECTED_CODE_PATHS` carve-out, and why it can come alive
mid-session while Tier-2 (real hot-loaded tool code) still goes the long way
round.

**The invariant is enforced, not asserted.** `validate_skill` rejects any step
naming a tool the specialist has not been granted; `render_skill_body`
re-checks at read time, so a capability revoked *after* a skill was learned
renders the step struck-through with a staleness warning rather than quietly
outliving the grant. `scripts/smoke-skills.ts` §B is that guarantee. If §B ever
goes red, the feature should go dark — not get patched.

### 2.2 Shape

```
skills (specialist_id, name) UNIQUE
  ├─ trigger        WHEN to reach for this — a situation, not a label
  ├─ steps[]        {tool, purpose, args_note} over ALREADY-GRANTED tools
  ├─ verification   how you know it worked
  └─ status         shadow → active → retired
```

Two-tier rendering, lifted straight from `dynamic_tools.ts`: an **awareness
block** (one line per skill: name + trigger) sits in every prompt, and
`recall_skill` pulls the **body** on demand. Carrying every body in every
prompt is exactly the bloat that module was written to kill.

The block lives in the **KV-stable region** of the system prompt (below
`tool_block`, above the tail time-anchor), so it costs a prefix invalidation
only when a skill is learned, graduated, or retired — never on an ordinary
turn.

### 2.3 Earned, not assumed

| Rung | Rule | Why |
|---|---|---|
| Born `shadow` | Rendered, but labelled provisional | A skill from one lucky turn must not harden into doctrine |
| → `active` | 3 reported successes | The trust-teeth scored-week pattern, applied to procedure |
| → `retired` | 2 dismissals | Retirement beats graduation: the cheap direction to be wrong in is *dropping a good skill* |
| Re-learn a name | Resets the ladder | A rewritten recipe has not earned the old one's reputation, and inheriting it launders a bad edit |
| Library cap | 24/specialist, refuse and name the coldest | Refusing is cheaper than the Curator that would otherwise be needed to mop up |

Outcome reporting rides on the *next* `recall_skill` rather than a separate
rate-this tool — a separate tool is one the model reliably forgets to call, and
an unreported skill never moves, which would make the ladder decorative.

### 2.4 Deliberately NOT built

- **Cross-specialist skill sharing.** The capability invariant is only
  meaningful against one specialist's grants; sharing needs a re-validation
  pass that does not exist. Skills are per-specialist and never leak.
- **The Curator.** The library cap and auto-retirement do the same job for a
  24-skill shelf. Revisit if the cap starts binding in practice.
- **Skill self-patching.** Hermes patches a skill mid-use; here, re-learning
  resets the ladder instead. Patching without resetting is the laundering path
  above.

---

## 3. Gap #1 — eval trace → diagnosis → gated proposal

### 3.1 Why this was nearly free

Three findings flip the cost:

1. **The runtime already produces the whole trace.**
   `SpecialistTurnOutput.tool_calls_made` carries each call's name, **args**,
   result, error, and any recovery `candidates`. The eval harness was
   projecting all of it down to `{name, errored}` and dropping the rest.
2. **The diagnosis engine already exists — twice.**
   `toolcall_diagnosis.ts` (audit-log evidence) and `health_diagnosis.ts`
   (infra evidence) both run gather → diagnose → score → rank → ground, emit
   typed fixes each naming an **existing** apply gate, and apply nothing. This
   is the third sibling, over eval evidence, reusing their taxonomy
   (`ToolFixType`), their gate set (`EXISTING_GATES`), and their score shape
   (`FixScore`) rather than minting parallel ones.
3. **The gate already exists.** `recommendation` and `persona_tuning` are both
   in `KATE_REVIEW_KINDS`, so a trainer-authored proposal of either kind is
   born `pending_kate_review` — hidden from the owner queue until Kate promotes
   it. No new review surface was needed.

So the build is: keep the trace, point a diagnoser at it, file through the
existing gate. Not new architecture.

### 3.2 The trap this is built around

The obvious version of this feature writes a persona line for every failure.
That is precisely the hack `propose_persona_tuning`'s own description warns
against — persona tuning is *"the WEAKEST layer; it does not generalize"*, and
a line reading "always search first / don't make things up" will **not** fix a
specialist that fabricated over a 404, lacked a capability, or fumbled an
argument shape.

A loop that papers over broken contracts with prompt text would be strictly
worse than no loop: it would turn the evals green while the system stayed
broken, and it would do it automatically, nightly, without anyone watching.

**The first attempt at this defence was wrong, and an adversarial audit broke
it within the hour.** It multiplied a persona fix's confidence by
`PERSONA_DISCOUNT = 0.6` and called that "anti-hack pressure as arithmetic."
A multiplier competes with the risk/reversibility weights — and it lost:

| fix | rating | score |
|---|---|---|
| persona line | low risk / easy — an **honest** rating for a prompt edit | `1.0 x 1 x 1 x 0.6` = **0.600** |
| real code fix | medium / moderate — `coerce_fix`'s own **default** | `1.0 x 0.65 x 0.85` = **0.5525 (ceiling)** |

Five of the nine risk x reversibility cells could never outrank a maximally-rated
persona line *at any likelihood*. Worse, the smoke that claimed to guarantee
this passed only because its fixture happened to rate the mechanical fix
`low/easy` — the one cell where the margin worked. Flipping a single adjective
inverted the headline assertion.

**A margin between two adjectives the same untrusted model chose is not a
guarantee.** The defences that actually hold:

1. **The prompt leads with layer attribution** — tool contract → grounding →
   missing reach → logic → *only then* voice.
2. **Rank by LAYER, then by score.** `TYPE_RANK` puts `persona_tuning` last,
   always. A persona fix can never outrank a mechanical one because they are
   never compared on score at all. (The sibling `toolcall_diagnosis.ts` already
   had this tiebreak; dropping it here was the original mistake — and a
   violation of this doc's own "reuse, don't mint parallel" principle.)
3. **Re-type on the target, not the model's word.** The audit's other route was
   labelling: `type: 'code_change'`, `target: 'config/specialists/kate.yaml'`,
   detail "append this line to her persona" took **no** penalty and filed as a
   `recommendation`, dodging both the layer order and the persona proposal
   kind. `effective_fix_type()` now re-types any fix whose target is a persona
   YAML, deterministically.
4. **Gate filing on the FIX, not just the story.** `file_eval_fix_proposal` used
   to check only `report.confidence` — the model's confidence in its own
   *narrative*. A fix scoring 0.03 could file as long as the write-up sounded
   sure. It now gates on both.

`smoke-eval-diagnosis.ts` §C pins all four, and its fixture is now
**adversarial by construction**: the mechanical fix carries the worst plausible
rating *and* a lower likelihood than the persona line, so the assertion can only
pass on a structural order — never on a numeric margin.

### 3.3 What it will not do

- **It applies nothing.** Every fix names a gate that already exists; the most
  the module does on its own is file a Kate-gated proposal.
- **A harness crash is never diagnosed as a behavior defect.** Infrastructure
  is not persona.
- **A garbled envelope, a model outage, or a missing trace files nothing** —
  the `kate_reflection` fail-closed contract.
- **Low-confidence or inconclusive reads file nothing.** The owner queue is
  the scarce resource, not the compute.
- **No silent caps.** 3 diagnoses per run, and the log states out loud how many
  failures were left for the next run.

### 3.4 Arming

Mirrors `HEARTH_KATE_REFLECTION` / `_ACT` exactly:

| Env | Behaviour |
|---|---|
| unset | **Dark.** Nothing runs. ← ships here |
| `HEARTH_EVAL_EVOLUTION=1` | Diagnose + record. Reports logged; nothing filed. **The soak** — read what it *would* have proposed. |
| `+ HEARTH_EVAL_EVOLUTION_FILE=1` | Arm filing, through Kate's pre-review gate. |

### 3.5 The loop, end to end

```
nightly eval run
      │  a task goes red
      ▼
eval_traces          ← args + errors + missing recovery hints  [NEW]
      ▼
eval_diagnosis       ← WHY, layer-attributed, scored, grounded [NEW]
      ▼
proposal (trainer)   → born pending_kate_review                [existed]
      ▼
Kate promotes → owner decides → applied
      ▼
change_windows opens with a baseline                           [existed]
      ▼
next eval run scores the delta; regression → flag/revert       [existed]
```

Four of the six boxes already existed. The two new ones are the hole that made
the loop an open arc.

---

## 4. What shipped

**New**

| File | What |
|---|---|
| `src/core/skills.ts` | Pure: types, validation, lifecycle, rendering |
| `src/memory/stores/skills.ts` | `SkillsStore` |
| `src/tools/learn_skill.ts` | Crystallize a recipe; refuses as *data*, not an exception |
| `src/tools/recall_skill.ts` | Pull the body; carries the outcome report |
| `src/memory/stores/eval_traces.ts` | Failure evidence — args whole, results previewed |
| `src/core/eval_diagnosis.ts` | Gather → diagnose → score → rank → ground → file |
| `scripts/smoke-skills.ts` | 43 checks |
| `scripts/smoke-eval-diagnosis.ts` | 35 checks |

**Changed**

- `src/memory/stores/structured.ts` — `skills`, `eval_traces` tables.
- `src/core/evals/harness.ts` — `EvalResult.trace`; persist on failure only.
- `src/core/specialist_runtime.ts` — `skills?` dep (fail-open),
  `render_skills_section()` in the KV-stable region.
- `apps/orchestrator/server.ts` — wire `SkillsStore`; run the evolution pass
  after the suite.
- `config/capabilities.yaml` — `learn_skills`. (The built-in enum in
  `capabilities.ts` is frozen; new tokens go here.)
- `config/specialists/kate.yaml` — grant `learn_skills`.

**Kill switches:** `HEARTH_SKILLS=0`, `HEARTH_EVAL_EVOLUTION`,
`HEARTH_EVAL_EVOLUTION_FILE`.

---

## 5. Bring-up

1. Deploy. Both features are dark; prompts are byte-identical until Kate learns
   her first skill.
2. **Skills:** they are live for Kate on deploy (the grant is in her YAML). Watch
   whether she reaches for `learn_skill` unprompted, and whether the recipes are
   procedures or cached answers. The `args_note` field is the tell — literal ids
   in it mean the skill is an answer wearing a procedure's clothes.
3. **Evolution:** set `HEARTH_EVAL_EVOLUTION=1` and read a week of
   *would-have-filed* logs before arming `_FILE`. The question that decides
   arming is not "is the root cause right" — it is **"how often does it reach
   for `persona_tuning` when the trace shows a mechanical failure?"** If that
   number is not near zero, the discount is too weak and the arming waits.

## 7. The adversarial audit (2026-08-04)

Twenty agents were pointed at five safety claims and told to **refute** them,
with every claimed break given an independent second opinion prompted to refute
*the refutation*. It was worth the tokens: it broke the headline claim.

| Claim | Verdict | Outcome |
|---|---|---|
| A skill cannot widen tool reach | **held** | Attacked against the live 348-tool registry — forged `ctx.specialist_id`, the one `dispatch_only` tool, a search for a second writer to the table. All three legs held. |
| Persona tuning cannot paper over a mechanical failure | **BROKEN** | Four defects; see §3.2. Fixed by layer order, target re-typing, and a fix-level filing gate. |
| One red task files one proposal | **BROKEN** | Dedup keyed on the LLM's volatile fix type (up to 8 proposals/task); cap ranking starved sub-alphabetical tasks forever. Fixed. |
| Every degraded path is safe | **weakened** | Filing sat outside the per-task `try`; `recall_skill` double-counted a dismissal; the library cap was breachable by one. Fixed. |
| Traces cannot leak private data | **weakened** | Evals are not fully fixture-isolated — personas carry the real household block. Traces are eval-only and the flagged address is a repo fixture, so nothing has leaked; but the table has no cordon column or retention policy. **Open.** |

**The correction that matters most** is not any single defect — it is that the
original design justified shipping *without review* by claiming a bad skill has
"the same blast radius as a bad persona line." That is false. A persona line is
owner-authored YAML under review; a skill's text is model-authored at runtime,
unreviewed, persistent, and lands in the same system prompt. The grant invariant
held, but the prompt's **structure** was forgeable — the audit rendered a skill
whose trigger carried a forged `# SYSTEM OVERRIDE` block and orphaned the
`*(provisional)*` marker. `flatten_for_prompt()` is the fix: model-authored text
is now treated as untrusted input to the prompt. Content survives; structure does
not.

The honest reading is narrower and still sufficient: **a skill cannot widen
REACH, so it needs no capability review — but its text is untrusted.**

---

## 6. Open

- Cross-specialist skill sharing (needs re-validation-on-read).
- Widening `learn_skills` past Kate — after her soak.
- Feeding `capability_demand` misses into skill candidates: the ledger already
  proves the inverse case is worth keeping.
- **`eval_traces` has no cordon column and no retention policy** (audit, §7).
  Traces are eval-only today, but the personas that generate them carry the real
  household block, so a reply could echo household facts into an owner-global
  row. Add retention + a cordon column before the suite runs unattended.
- **Per-viewer scoping for skills.** The block is owner-only for now, because
  skills are keyed per-specialist with no `private_to`. That is a stopgap.
- The idea *not* taken: Hermes's tool self-recovery. The good version is an
  **error-contract** change (a tool returning near-misses instead of a dead
  string); the bad version is a retry shim masking a broken tool. Worth doing,
  worth scoping as the former, and out of scope here.
