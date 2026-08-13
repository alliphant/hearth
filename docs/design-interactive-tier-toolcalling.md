# Design — Interactive-tier tool-calling reliability

> **Status:** strategy (brainstorm output, 2026-06-22). Nothing built yet.
> **Reframe (see "Update" section below):** the root cause is *model selection*
> — a CHAT distill is running the TOOL path — not a harness gap. Owner chose to
> **decide by data**: build the eval harness, then bake off candidate callers.
> The grammar-hardening + contracts plan below is RETAINED as the
> fallback-if-stuck-on-the-9B path; verify-before-claim survives as model-
> independent table stakes.
>
> **Companion docs:** [design-inference-fleet-loadout.md](design-inference-fleet-loadout.md),
> [design-two-tier-inference.md](design-two-tier-inference.md). This doc is the
> *tool-calling reliability* strategy; those are the *fleet topology*.

## Update 2026-06-22 — the real wound is model selection, not the harness

Owner pushback: Phase 0/1 band-aid a model that fundamentally can't tool-call.
Correct. **No agentic harness turns a weak caller into a strong one.** Production
systems don't patch — they SPECIALIZE so the weak-at-tools part never has to be
strong. The three root fixes in the wild:

1. **Specialize the MODEL — fine-tune tool-calling in.** This is the Hermes
   answer: Hermes 2 Pro / Hermes 3 are *fine-tunes* trained on large FC datasets
   until consistent `<tool_call>{json}</tool_call>` emission is a reflex. Same
   family: Salesforce **xLAM-2** (APIGen — execution-verified synthetic
   trajectories; a 7-8B tops BFCL, beating larger general models), **Hammer**,
   **watt-tool**, **Functionary**. Proof a *small* model can call reliably — if
   it's the right one. **Hearth runs `Qwen3.5-9B-Heretic`, a Claude-distilled
   CHAT fine-tune, on the tool path. That is the wound** — model selection, not
   harness.
2. **Specialize the DECODING — a real grammar engine.** Not llama.cpp's fragile
   JSON-Schema→GBNF converter (silently fails open on `.regex()`), but
   **XGrammar** (vLLM), **Outlines**, or **llguidance** (Microsoft) — token-level
   logit masking over a proper automaton. The 35B on vLLM has XGrammar; the 9B on
   llama.cpp has the weak cousin. So Phase-1 grammar-hardening IS this root fix —
   on the worse engine. (Nuance: over-constraining *prose* can hurt reasoning per
   "Let Me Speak Freely?"; constraining *args* is a near-clean win.)
3. **Specialize by AGENT — don't make the weak model plan/chain.** BFCL v3 shows
   chaining degrades *every* model incl. GPT-4-class — "can't chain" is the
   hardest category for everyone, not a 9B defect. Harnesses either route the
   structured part to a capable model (orchestrator-worker; Anthropic's
   lead-agent-plans / subagents-execute; LLMCompiler's tool DAG) OR collapse the
   chain to single calls (create-or-update contracts). This is why the
   frontend/backend split keeps surfacing: the interactive tier has a DUAL job
   (warm chat AND reliable tools) and no small model nails both.

Two repositionings that follow:
- **Verify-before-claim is table stakes, not a band-aid** — every tool-using
  agent (frontier included) verifies execution results because even GPT-4
  fabricates completions. It's model-independent → runs in parallel regardless of
  the model choice.
- **The eval harness is the INSTRUMENT for the root fix** — you can't pick the
  right caller without a Hearth-flavored BFCL. Phase 0 is the prerequisite for
  model selection, not a substitute for it.

**Chosen path: eval harness → model bake-off (decide by data).** The bake-off
picks the ARCHITECTURE, not just a model: whether any small model can do BOTH
jobs (→ swap), or none can (→ split by intent: a good chatter converses, the
35B / an FC-specialist emits the call), or nothing small clears the bar (→ route
tool turns to the 35B + contracts to minimize chaining). Direction **(f)
right-model-for-the-job** is now first-class; (b) grammar-hardening-on-the-9B and
(c) contracts drop to "only if forced to keep the chat-9B doing tools." Bake-off
design + candidate buckets are tracked in the chat thread / a follow-up section.

## Update 2026-06-22 #2 — research pass (PARTIAL, rate-limited; sourced-but-unverified)

A deep-research pass ran but degraded: the fetch + adversarial-verify phases were
API-rate-limited mid-flight (`Server is temporarily limiting requests (not your
usage limit)`), so every verifier ABSTAINED (`0-0`) and the harness mislabeled all
25 claims "refuted." They are NOT refuted — they're **unverified**, from 6 sources
(primary: vLLM docs, BFCL Berkeley blog, Hammer GitHub; secondary: llm-stats
BFCL-v4; blog: jdhodges). Coverage is partial. Confidence noted per finding.

**FINDING A — CORRECTION to this doc's earlier claim (primary: vLLM docs, HIGH
confidence).** I previously wrote "escalate to the 35B → XGrammar guided decoding
for free." That is WRONG for the default path. Per
[vLLM tool-calling docs](https://docs.vllm.ai/en/stable/features/tool_calling/):
vLLM applies a schema constraint to tool-call args at decode time ONLY in
**named-function** or **`tool_choice='required'`** modes; under **`tool_choice='auto'`**
(what chat uses) args are PARSER-EXTRACTED from free text with NO decode-time
constraint — and vLLM does **not** implement OpenAI `strict` (the field is accepted
but a no-op). So Hearth's `strict: true` ([providers/openai.ts](../src/core/providers/openai.ts))
is inert on the 35B/vLLM auto path, and "may serialize args wrong (array as a
string)" even with a schema present. **Implication (model-independent): guaranteed-
valid args require FORCING the tool channel — `tool_choice:'required'` / named
function — on BOTH backends; it is not a property of the model or "free" by
escalating.** Hearth already has the mechanism (`force_first_tool`
[specialist_runtime.ts:3176](../src/core/specialist_runtime.ts) +
`tool_choice:'required'` [openai.ts:402](../src/core/providers/openai.ts)) — the
Phase-1 move is to route WRITE/tool turns through it, not to rely on auto+strict.

**FINDING B — serving-stack / parser alignment dominates model choice (triangulated:
vLLM docs primary + jdhodges blog; MEDIUM confidence on numbers, HIGH on the
lesson).** A mid-2026 hands-on eval found **xLAM-2 8B (ranked #1 on BFCL) scored 15%**
and **Hammer 2.1 7B scored 20%** on a 40-test tool-calling suite, while a general
**Qwen3.5 4B scored 97.5%** — the author attributes the FC-specialists' collapse to
**serving-stack format mismatch** (LM Studio's OpenAI-compat API didn't translate
their custom output formats), NOT model quality. vLLM's docs confirm the parser
split this implies: Qwen2.5/QwQ → `hermes`, Qwen3-Coder → `qwen3_xml`, xLAM →
dedicated `xlam`, Hermes-series → `hermes`. **Lesson: an FC-specialist is only as
good as your stack's parser for ITS format** (the exact `hermes`-vs-`qwen3_xml` 0%
bug Hearth already hit). Leaderboard ≠ real-world → the bake-off MUST run on our
stack. (Caveat: the numbers are one LM-Studio-specific blog; the lesson is
corroborated by the vLLM parser split + Hearth's own forza-swap incident.)

**FINDING C — the dual-strong answer tilts toward "strong GENERAL model," not an
exotic FC fine-tune (LOW-MEDIUM confidence, one blog).** Same eval's top performers
were all GENERAL models (Qwen3.5 4B 97.5%, GLM-4.7-Flash 95%, Nemotron Nano 4B 95%,
Mistral Nemo 12B 92%); its single-model recommendation is Qwen3.5 4B, none are FC
fine-tunes. Combined with Finding B, this argues AGAINST a naive swap to xLAM/Hammer
and TOWARD: (a) route writes to the 35B (Qwen3.6 — parser already aligned) with
forced tool_choice, or (b) bake off a strong GENERAL small model in a family whose
parser we run well (Qwen3.x / Qwen3-Coder for structured output; possibly Mistral
Nemo 12B). Incumbent baseline: Qwen3.5-9B ≈ 0.661 / rank #7 on the llm-stats
BFCL-v4 aggregator (secondary, low confidence on the exact figure).

**Hammer specifics (primary: GitHub):** sizes 0.5/1.5/3/7B, Apache-2.0, "Function
Masking" technique, vLLM-servable, but **no official GGUF** and base models
undocumented — a serving + provenance strike against it for our llama.cpp-friendly
fleet.

**GAPS the rate-limit left open (re-run scoped to these):**
1. **llama.cpp grammar / llguidance status — NO source fetched.** The whole Q4
   llama.cpp half is unanswered (is the fragile GBNF converter still default, or has
   llguidance landed?). Load-bearing for whether the 9B box can constrain args.
2. **FC-specialist census** — Hermes 3, ToolACE, watt-tool, current Functionary:
   nothing usable (the BFCL blog was 2024-vintage; listed only Gorilla
   OpenFunctions-v2 6.91B / Functionary-small-v2.2 7.24B / Raven-v2 13B).
3. **Qwen3-Coder as a caller** — only a passing parser mention; worth its own look
   (Coder models often emit cleaner structured output).

**Net effect on the plan:** bake-off design VINDICATED (leaderboard ≠ real-world);
candidate set SHIFTS away from exotic FC-specialists toward 35B-on-tool-path +
Qwen-family general/Coder models (parser-aligned); and a NEW model-independent
Phase-1 item lands: **route write/tool turns through forced/named `tool_choice`** —
because auto-mode constrains args on NEITHER backend.

## Update 2026-06-22 #3 — the incumbent is ABLITERATED; revised candidate set

The interactive 9B is **`Qwen3.5-9B-Heretic`** (an abliterated/uncensored chat
distill), per [consult_deep_model.ts:5](../src/tools/consult_deep_model.ts) — NOT
stock `Qwen3.5-9B-Instruct`. The deep tier is `Qwen3.6-35B-A3B-Heretic` too.
Abliteration is a capability-damaging edit (it ablates the refusal directions and
takes instruction/strict-format adherence as collateral) — and tool-calling is the
rigid-format behavior most exposed to it. So "the 9B can't tool-call" may be
substantially **"we run an abliterated checkpoint on the tool path,"** not a size
limit. This makes the cheapest-possible root fix a **gguf swap**, gated by the
bake-off (do NOT blind-flip the production model — refusals/warmth are why Heretic
is there).

Clarification (a conflation to avoid): **"Instruct" and "think" are orthogonal.**
Heretic IS an Instruct model with abliteration on top; stock Instruct *removes* the
abliteration, it doesn't *add* reasoning. Think is a per-request toggle
(`enable_thinking`), already OFF for the 9B — a Heretic→stock swap keeps think OFF,
unchanged. The only real cost of stock Instruct is reintroduced Qwen safety
refusals/moralizing → the chat axis MUST include a refusal/tone probe.

### Bake-off candidate set (revised)

All Qwen-family candidates share OUR parser → **zero parser-alignment risk**
(Finding ②), and all are hybrid-think → run think-OFF unchanged.

- **B0 — Qwen3.5-9B-Heretic (incumbent FLOOR).** What runs today; everything must beat it.
- **B1 — stock Qwen3.5-9B-Instruct.** Same size, un-abliterated → tool-intact
  control. THE cheapest root fix (gguf swap) IF it wins. Risk: reintroduces Qwen
  refusals/tone Heretic removed → probe the chat axis for it.
- **B2 — Qwen3.5-4B-Instruct.** Smaller/faster → frees VRAM on the 24 GB box (could
  widen `-np` beyond 4 → headroom for the original voice-queuing wound) + lower
  latency. Tests Finding C ("format adherence is trained, not scaled"). MOST at-risk
  on chat depth + HARD chaining/nested-union cases → must earn the slot, not assumed.
- **B3 — Qwen-Coder small** (Qwen2.5-Coder-7B / a small Qwen3-Coder if one ships).
  Coder tunes emit cleaner structured output; same parser family.
- **A — 35B-on-tool-path (routing, not a swap).** Proven caller, parser aligned →
  reference ceiling + the fallback if nothing small clears both axes. (Also Heretic
  → a stock-35B is the parallel question for the deep tier.)
- **Exotic FC-specialists (xLAM-2, Hammer) — DEPRIORITIZED.** Serving/parser-
  alignment risk (Finding ②: #1-BFCL xLAM → 15% real); Hammer has no official GGUF +
  undocumented base models.

Axes unchanged (arg-validity / chaining / honesty-under-failure / chat-quality
**incl. refusals**) + operational gates (latency, VRAM-at-`-np`). **First thing the
harness measures: B1 (and B2) vs B0** — the gguf-swap controls are the highest
information-per-effort test in the whole plan.

## Update 2026-06-22 #4 — the llama.cpp grammar gap, RESOLVED (primary sources)

A targeted research pass (direct primary-source fetches, not the rate-limited
workflow) settles the open Q4 llama.cpp question. All CONFIRMED against ggml-org
GitHub:

- **The default engine is STILL the fragile `json_schema_to_grammar`→GBNF converter,
  and the silent fail-open is CONFIRMED + WON'T-FIX.**
  [Issue #19051](https://github.com/ggml-org/llama.cpp/issues/19051) (image dated
  2026-01-23): when grammar parsing fails, llama-server "logs the error but continues
  generating UNCONSTRAINED, returning 200 OK" — "silent loss of structured-output
  guarantees; unsafe for production without external validation." **Closed as NOT
  PLANNED.** So the fail-open is upstream-by-design; mitigations must live on OUR side.
- **The `\d \w \s` (PCRE shorthand) tool-grammar breakage is CONFIRMED, OPEN, current.**
  [Issue #22314](https://github.com/ggml-org/llama.cpp/issues/22314) (opened
  2026-04-24, version b8893): a tool schema containing `\d`/`\w`/`\s`/`\b` makes "the
  entire tool grammar fail to parse" → combined with #19051's fail-open, the args then
  generate UNCONSTRAINED. Partial community fix (PR #23436) incomplete/stale. This is
  EXACTLY the [propose_hire.ts](../src/specialists/kate/tools/propose_hire.ts) `.regex()`
  landmine — now confirmed as a live upstream bug, not Hearth folklore.
- **Even simple object schemas can emit malformed tool args** —
  [Issue #22072](https://github.com/ggml-org/llama.cpp/issues/22072) — so the default
  converter leaks on the happy path too.
- **llguidance (the robust engine) IS in llama.cpp, but OPTIONAL.**
  [docs/llguidance.md](https://github.com/ggml-org/llama.cpp/blob/master/docs/llguidance.md)
  + [PR #10224](https://github.com/ggml-org/llama.cpp/pull/10224): build with
  `-DLLAMA_LLGUIDANCE=ON` (requires Rust/cargo). "Very fast" (token mask ~50µs avg,
  p99 0.5ms) with "excellent JSON Schema coverage." It COEXISTS with the built-in
  engine. **Remaining sub-unknown:** the doc confirms llama-cli `-j` and
  `%llguidance`-prefixed grammars route through it, but NOT explicitly that
  llama-server's OpenAI `tools`/`response_format:json_schema` path auto-routes through
  it — verify before betting on it (and beellama is a FORK, so confirm the flag is in
  our build / rebase-able).

**Unified conclusion across both backends:** reliable arg-constraint is NOT free on
the default chat path on EITHER stack. vLLM (Update #2): needs `tool_choice='required'`
/ named (auto + `strict` is a no-op). llama.cpp (here): default converter fails open +
breaks on PCRE shorthands; llguidance is the robust path but a build-flag opt-in. So
F1 (garbled args) has exactly two real levers, both model-independent and orthogonal
to the bake-off: **(i) force the tool channel on write/tool turns** (works on both
backends), and **(ii) on llama.cpp, switch the engine to llguidance** (or stay on the
default + Hearth-side schema-lint to dodge #22314 + lean on the repair loop).

**Phase-1 (b′) therefore SPLITS into two options:**
- **b′-mitigate** (cheap): keep the default converter + schema-lint to ban
  `\d\w\s`/`.regex()`/PCRE in tool schemas (dodge #22314) + forced `tool_choice` +
  the existing repair loop. Ceiling: the fail-open remains for any schema feature the
  converter can't translate.
- **b′-llguidance** (durable): build beellama with `-DLLAMA_LLGUIDANCE=ON`, verify the
  server tool path routes through it. Engine-level fix — robust coverage, no silent
  fail-open. Cost: Rust in the image + fork verification.

## Update 2026-06-22 #5 — the incumbent is ALREADY stock; Phase 0 instrument shipped

**The "flip to stock Instruct" is moot — the live 9B is already stock official Qwen.**
Inspected the running service on the LLM host (`llamacpp-glacier.service` →
`llama-server -m /home/jasper/llm/models/qwen35-9b/Qwen3.5-9B-Q8_0.gguf … :8088`):
the loaded gguf's metadata is `general.name = Qwen3.5-9B`, `general.basename =
Qwen3.5-9B`, provenance `huggingface.co/Qwen/Qwen3.5-9B` (the official Qwen org), and
the model dir holds ONLY plainly-named official ggufs (Q4_K_M + Q8_0) — **no Heretic
file**. So **Update #3's abliteration hypothesis is most likely WRONG for the live
model** (the "Heretic" was a stale code comment, now corrected in
[consult_deep_model.ts](../src/tools/consult_deep_model.ts)). Disk is fine (48% used,
466G free — the "97% full" note was stale). Caveat: `general.name` *could* survive a
metadata-preserving abliteration, so this is strong-not-certain; decisive only if we
hash against the official release. **Consequence: there is NO cheap checkpoint
silver bullet** — B0 (incumbent) and B1 (stock-9B) are the SAME model, so the stock
9B *is* the thing garbling args. The bake-off's real candidates collapse to: stock-9B
(floor) vs **4B** vs **Coder** vs **35B-on-tool-path**, and the model-INDEPENDENT
levers (verify-before-claim, forced `tool_choice`, llguidance) carry the load.

**Phase 0 (the bake-off instrument) is BUILT + verified** (`bun run smoke:evals` — 34
checks, +8 new; `bun run guard` clean; tsc clean on the changed files). Additive,
fail-safe (defaults unchanged). In [evals/harness.ts](../src/core/evals/harness.ts) +
[evals/golden_tasks.ts](../src/core/evals/golden_tasks.ts):
- **Tool-FAILURE fixtures** — a fixture result `{ __eval_error: "msg" }` makes the
  stub throw → the call records `ok:false`, exercising the honesty-under-failure /
  verify-before-claim axis.
- **`args_valid` assertion (F1)** — a named tool was called AND its args validated
  (no `INPUT_VALIDATION_FAILED`/`DUPLICATE_TOOL_CALL`). (Live-only: a passthrough
  fixture can't synthesize a real validation reject — the nightly run covers it.)
- **`call_order` assertion (F2)** — named tools appear and their FIRST calls are in
  order (the chaining gate: `find_or_create_person → upsert_person_note`).
- **N-sample pass-RATE** — `run_all_golden({ samples })` runs each task N times and
  aggregates (passed iff all N pass; detail leads with the rate). Default 1 →
  byte-identical to before. This is the stochastic-model + bake-off lever.

**NOT yet done (needs owner greenlight — these file regression misses + encode
behavior decisions):** new PERMANENT golden tasks — (a) a verify-before-claim
honesty task (red until Phase-1b lands), (b) a refusal/tone probe (the chat-axis gate,
newly relevant now that we're staying on stock Qwen's alignment), (c) tightening the
existing address task with `call_order`+`args_valid`. Held back deliberately: adding
assertions to a LIVE-run task can flip a currently-green gate red and file a miss.

**Next:** Phase 1a bake-off RUN (stand up 4B / Coder / 35B-routing, run the harness at
`samples≈10` per candidate, score the 4 axes) — that's ops + the candidate models.
Phase 1b (verify-before-claim + forced `tool_choice`) can proceed in parallel.

## Update 2026-06-22 #6 — ROOT CAUSE found in the audit log; the real fix SHIPPED

The whole model-bake-off / decoding-overhaul arc was **over-scoped**, and the audit
log proved it. Live probes to the 9B (`:8088`) returned clean native `tool_calls`
for simple, nested, AND `pattern` schemas — the model emits valid args. The audit log
(30d) localized the actual failures:

- **~0.2% of activity**, concentrated in **deliberation + meta-agent passes** (trainer,
  vivian, ruby, kristi, kate's flag), NOT interactive chat. The trust-killer
  `upsert_person_note` is **3 in 14 days** — rare, painful, not systemic.
- The dominant class is **field-name mismatches**: the model emits the conventional
  name (`path`, `url`), the schema demands a synonym (`note_path`, `filing_url`) —
  `read_note` 43, `edgar_read_filing` 21. The model is sensible; the schemas are
  gratuitously specific.
- A few **bad contracts**: `flag_beatrice` (41 — the model never matches its required
  set, sends free-text `flag`/`body_md`/nothing), `propose_action` rationale (already
  fixed per-tool), type/clamp/strip tail.

**So the durable fix is NOT a new model or a new decoding stack** (that would reinvent
a working wheel). It's the layered "meet the model where it is," **shipped + verified
this session** (all uncommitted on the working tree):

- **Layer 1 — central recovery in `tool_registry.invoke`** (`_recover_tool_args`,
  mirrors the enum-trim): field-name aliases (`path→note_path`, `url→filing_url`),
  object→string coercion, number clamp, strict-key strip — conservative, re-validate
  once, `[tool-recovery]`-logged. Covers all tools + future ones. Erases read_note +
  edgar transparently.
- **Layer 2 — the one real contract fix**: `flag_beatrice` `subject`/`suspected_class`
  now optional-with-derivation + its free-text aliases (`flag`/`body_md`/…→
  `what_went_wrong`). (read_note/edgar need no rename — Layer 1 recovers them.)
- **Layer 3 — schema lint at boot** (`ToolRegistry.lint()`, wired in server.ts,
  `HEARTH_TOOL_LINT`): warns on a regex `pattern` (the GBNF silent-fail-open trap that
  nothing else can catch — there's no validation error to recover from), a
  synonym-canonical required field, an over-wide required set. Born-aligned gate for
  NEW tools.
- **verify-before-claim** (`_had_durable_write` tightened + `_failed_write_call` +
  accurate UNSAVED-CLAIM nudge): a write that errored OR returned a soft-failure
  payload (`{saved:false}`) is no longer a "durable write," so the model cannot
  confirm a save the runtime KNOWS failed. The trust guarantee.

Smokes: `smoke:tool-contracts` (alias/coerce/clamp/strip + lint + flag_beatrice),
`smoke:unsaved-claim` (the 4 write-outcome cases), `smoke:evals` (the Phase-0 harness
with `args_valid`/`call_order`/tool-failure fixtures). All green; guard + tsc clean.

**Status of the earlier plan:** the bake-off harness (Phase 0) is still valuable as a
regression net and IF a model swap is ever wanted, but the model-selection /
constrained-decoding-overhaul / llguidance work is **NOT pursued** — the data didn't
justify it. The forced-`tool_choice`-on-writes idea remains a cheap future option.

## The problem

The INTERACTIVE tier — Qwen3.5-9B (Q8 GGUF, beellama/llama.cpp, think-OFF,
`-np 4`) on the the LLM host RTX 4000 `:8088`, serving typed chat + voice — (1)
**garbles structured tool args** (nested objects, discriminated-union ids) and
(2) **can't reliably chain tools** (`find_or_create_person` THEN
`upsert_person_note`). The two visible failure shapes:

- **Arg-spiral:** `INPUT_VALIDATION_FAILED` → identical retry →
  `DUPLICATE_TOOL_CALL` → `same_tool_spiral_exhaust` → turn dies ungrounded.
- **Silent write failure (the trust-killer):** the model tells the user "Got it,
  I've noted it" while the underlying write actually errored. Real incidents
  this week: a person's address / birthday / itinerary "saved" per Kate but
  never persisted.

The DEEP tier — Qwen3.6-35B-A3B (FP8, vLLM on the the LLM host 6000 Ada `:8200`,
`--tool-call-parser qwen3_xml`, hybrid think) — is a much stronger tool-caller.

## Three findings that reframe the strategy

**Finding 1 — constrained decoding is ALREADY partially on for the 9B, and the
leak is what matters.** Every tool ships to the backend with `strict: true`
([providers/openai.ts](../src/core/providers/openai.ts) `_build_body`), and
beellama compiles each tool's `parameters` JSON-Schema into a **GBNF grammar**
(stated outright in [propose_hire.ts](../src/specialists/kate/tools/propose_hire.ts),
[hiring.ts](../src/core/hiring.ts), [dynamic_tools.ts](../src/core/dynamic_tools.ts)).
So once the 9B is *in* the tool-call channel, its args are already
shape/type/enum/required-masked. **The failure mode:** `propose_hire.ts:36`
documents that `.regex()` makes llama.cpp's converter emit malformed GBNF that
"fails the whole tool grammar," and a grammar that fails to compile makes
llama.cpp **silently fall back to unconstrained generation** → free-form args →
garble. The lever is not "add constrained decoding" — it's "stop the existing
grammar from silently disabling."

> ⚠️ **Unverified assumption (de-risk first):** Finding 1 is inferred from code
> comments, not measured on the live `:8088` beellama fork. Phase-1 starts with a
> 1-day spike to PROVE beellama compiles + enforces the per-tool GBNF (e.g. an
> enum arg the model cannot violate across N samples; or grammar-compile log
> lines). This decides how much grammar-hardening is even worth.

**Finding 2 — GBNF structurally cannot fix three of the four failure classes.**
It enforces shape, not semantics or planning. It can't stop: wrong-tool /
declined-call under `tool_choice:'auto'` (the grammar only bites *after*
commitment); a required string filled with `""`/`"TODO"` (passes the grammar);
or the silent-write-failure-then-"saved" (not a generation problem at all).
Constrained decoding owns exactly ONE class.

**Finding 3 — the silent write failure is the only class where the runtime has
ground truth and throws it away.** `ToolRegistry.invoke` returns
`InvokeOutcome.ok` ([tool_registry.ts:359](../src/core/tool_registry.ts)) — the
runtime KNOWS the write errored. But the user-facing "saved" is *authored by the
model*, and the guards that police it (`_detect_fabricated_save`,
`persisted_fabrication_block` in [specialist_runtime.ts](../src/core/specialist_runtime.ts))
are regex post-hoc detectors of save-*language* with NO fired tool, or only fire
in the narrow "read failed AND args contain unsourced specifics" corner. None
check "did the write I'm confirming actually return `ok:true`?" That deterministic
check isn't being made.

## The owner's questions, answered

**Q1 — 9B-frontend / big-model-backend split.** Cheap to prototype: the
**complexity gate already does this shape** ([specialist_runtime.ts:2667](../src/core/specialist_runtime.ts))
— it mutates `input.provider_role = 'deep_consult'` + `think_override` mid-method
to reroute a whole turn to the 35B. It just routes on *prose* shape, not
*tool/write* intent. Two flavors:
- **Coarse (turn-level):** detect tool/write intent → flip the whole turn to the
  35B. ~1 signal added to the existing gate. The 35B think-off benches ~52 t/s /
  ~2s for envelope JSON; writes are rarer than chat → cheap.
- **Fine (sub-turn handshake):** 9B converses + says "tool needed," 35B emits.
  The weak link becomes the 9B's *intent signal* (which tool, what args) → you'd
  hand the 35B a possibly-wrong target + double round-trips. The clean "fine"
  version is just "force a single `tool_choice:'required'` 35B emission step."

  **Recommendation:** coarse first — ~all the benefit, ~none of the complexity,
  and the 35B sits on vLLM whose xgrammar guided decoding is *more complete* than
  llama.cpp's converter, so escalating also upgrades constrained decoding for
  that turn. (Phase 2.)

**Q2 — Hermes vs qwen3_xml: what makes a tool-call parse robustly.** Not the
parser — **three-way alignment**: the chat *template*, the model's fine-tuned
*emission habit*, and the server *parser* must all agree.
- **Hermes** = `<tool_call>{"name":...,"arguments":{...}}</tool_call>` (JSON in
  XML), catalog in a `<tools>` system block. Nous's value was a *stable,
  documented* format + reference parser + a model heavily fine-tuned to honor it.
- **qwen3_xml** = `<tool_call><function=NAME><parameter=KEY>val</parameter></function></tool_call>`
  (XML-nested, no JSON). Qwen3.6 emits this; `hermes` parser on it → empty
  `tool_calls`, call lands in `content` → 0% (the forza swap bug in CLAUDE.md).
- **The 9B is the weak link because its emission is *inconsistent*** — sometimes
  native `<tool_call>`, sometimes the `<tool_code>` hybrid that no single parser
  catches (hence `_parse_tool_code_dialect` recovery in providers/openai.ts).
  Robustness ingredients, ranked: (1) right parser for the family → (2)
  grammar/guided-decoding on → (3) recovery parser for off-template dialects.
  Hearth has all three; #1 and #3 are fragile on the 9B. The structural fix for
  "inconsistent emission" is a function-calling fine-tune (Phase 3, deferred).

**Q3 — other levers, ranked for Hearth.** Constrained decoding (have it, harden
it). Repair loop (have a strong one — `tool_registry.ts` enum-trim + LLM-friendly
error rewriting + `_normalize_qwen_tool_args`; its ceiling is that it's reactive).
Verify-before-act (under-built, high value — but the cheap version is deriving
confirmation from `InvokeOutcome.ok`, NOT a second agent). Function-calling
fine-tune (research bet). Speculative/verified tool-calling (not worth it at our
scale).

## The failure-class → layer matrix

No single direction fixes more than ~half. This is defense-in-depth.

| Failure class | (b) Constrained decode | (a) Tier-route 35B | (c) Bulletproof contracts | (d) Verify-before-claim | (e) Eval harness |
|---|---|---|---|---|---|
| **F1** garbled / invalid args | **primary** *(have, leaky)* | helps (xgrammar) | — | — | regression net |
| **F2** wrong tool / can't chain | ✗ | **primary** | **primary** (collapse chain) | — | regression net |
| **F3** silent write fail → false "saved" | ✗ | partial | — | **only real fix** *(missing)* | regression net |
| **F4** valid-but-empty/placeholder args | partial (min-len weak) | helps | **primary** | — | regression net |

The two worst-impact cells (F3, F1) are both fixable **deterministically and
model-agnostically with no new infra** → that's the 80/20.

## Recommended durable strategy + phased plan

**Principle:** fix each class at the layer that owns its contract (CLAUDE.md
doctrine) — generation-shape at the grammar, planning at the model tier, the
chain at the contract, the truth-of-the-write at the runtime — and let the eval
harness keep all four honest.

### Phase 0 — tool-calling eval harness (force-multiplier, FIRST)

The `src/core/evals` harness exists but has ONE task touching this class
(`address-correction-persists-no-denial`, [golden_tasks.ts:526](../src/core/evals/golden_tasks.ts)),
its fixture makes the tool ALWAYS succeed, and it's single-sample pass/fail —
meaningless for a stochastic 9B. Extend with:
1. **Tool-FAILURE fixtures** (`ok:false`) — exercise the honesty layer.
2. **N-sample pass-RATE** per task (not 1/1).
3. **Arg-validation assertions** — did the call's args VALIDATE, not just "was the
   tool named."
4. **Chain assertions** — `find_or_create` → `upsert` with the RETURNED id.

You cannot safely tune anything below without this.

### Phase 1 — the two deterministic wins (CHOSEN to lead)

**(d) Verify-before-claim** — two complementary mechanisms:
1. **Deterministic post-tool ground-truth injection.** After a write-tier tool
   runs, make failure LOUD in the tool-result the model reads: a machine-authored
   `[WRITE RESULT] <tool> → FAILED ❌ — not saved: <error>` (or `→ SAVED ✅`).
   Steers the model to confirm only real saves.
2. **Finalize guard — success-claim-on-failed-write veto** (new block in
   `run_reply_guards`, [specialist_runtime.ts:3209](../src/core/specialist_runtime.ts)).
   The INVERSE of `_detect_fabricated_save`: that fires on "claims save + NO write
   fired"; this fires on "claims save + the matching write FIRED but returned
   `ok:false`." Reuse the save-language regexes; nudge: "your `<tool>` call FAILED
   (<error>) — the data was NOT saved; retry correctly or tell the user honestly."
   Own latch, kill switch (`HEARTH_UNSAVED_CLAIM_GUARD`), audit row
   `unsaved_claim_guard`.
   - **Durable contract:** standardize a write-result shape so the guard reads ONE
     field, not per-tool special-casing — every write-tier tool's output_schema
     carries `saved: boolean` (the golden task + the `incremental-save-contract`
     memory already use `{ok, saved, applied}` loosely; make it the rule). The
     guard keys on `ok && saved`, not just `InvokeOutcome.ok`.

**(b′) Grammar-hardening:**
- **b′.0 — the spike (precursor):** prove beellama compiles+enforces GBNF on
  `:8088` (Finding-1's open assumption). Decides ROI of the rest.
- **b′.1 — schema-lint at registration:** `lint_tool_schema(tool)` in
  `ToolRegistry.register` / the ToolLoader — flag GBNF-hostile constructs
  (`.regex()`/`pattern`, deep `$ref`, etc.), fail loud + audit at boot/hot-reload.
  Generalizes the tribal "don't use `.regex()`" into an enforced invariant.
- **b′.2 — boot-time grammar-compiled probe:** verify each tool's schema → grammar
  actually compiles on the backend (lint is the proxy if beellama exposes no
  validate endpoint).
- **b′.3 — force the channel on unambiguous write intent:** pass
  `tool_choice:{type:'function',function:{name}}` so the 9B is grammar-masked into
  THAT tool's args from token 0 — eliminates wrong-tool + declined-call for the
  write case. Narrower, higher-confidence cousin of Phase-2 routing.

**Why the pair nukes the cited incidents:** b′ keeps `upsert_person_note` args
structurally valid (no garble → no spiral); d ensures that IF it still fails, the
model cannot say "saved." (The chaining variant is the Phase-2 residual.)

### Phase 2 — the structural wins (compounding)

- **(a) Coarse tier-routing:** extend the complexity gate with a tool/write-intent
  signal → escalate the turn to the 35B (Q1, coarse form).
- **(c) Bulletproof-contracts sweep:** create-or-update single-call tools so the
  9B NEVER needs to chain (one `record_person_fact` does find-or-create + upsert);
  derive-don't-require; lenient coercion. Removes the NEED for F2/F4 fixes at the
  source. Closes the chaining residual Phase 1 doesn't.

### Phase 3 — research bets (defer until data justifies)

- Fine-grained two-model handshake (only if coarse routing is too blunt).
- 9B function-calling fine-tune (consistent emission → parser+grammar bite
  reliably). Heaviest, least certain.

## Open unknowns / honest caveats

- Finding-1 (GBNF on `:8088`) is inferred, not measured → b′.0 spike gates b′.
- vLLM `qwen3_xml` parser + guided decoding co-operation for per-tool arg schemas
  on the 35B should be confirmed before Phase-2 routing leans on it.
- `tool_choice:'required'`/forced-function works think-OFF on beellama per
  llm.ts + CLAUDE.md ("verified") — re-confirm in the b′.0 spike since b′.3 leans
  on it.
- Phase-1 is necessary + high-coverage but not 100% of the cited incidents: the
  chain-break variant (F2) is Phase-2 contracts.

## Kill switches (all fail-open, per house style)

`HEARTH_UNSAVED_CLAIM_GUARD`, plus the schema-lint degrades to warn-not-fail under
a flag. Everything Phase-1 is deterministic + model-agnostic; nothing here
depends on forza/the 35B.
