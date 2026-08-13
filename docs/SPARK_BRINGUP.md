# DGX Spark bring-up — the background depth + concurrency tier

**Status:** bring-up in progress — **hardware arrived 2026-06-04** (HP ZGX Nano /
NVIDIA DGX Spark, GB10 Grace-Blackwell, 128 GB unified LPDDR5X @ ~273 GB/s,
~1 PFLOP FP4). **Hostname `forza`, static LAN IP `192.168.0.188`.** forza is a
**LAN-only internal inference backend** — the the LLM host orchestrator calls it at
`http://192.168.0.188:8090` over the LAN; it is NOT tailnet-exposed (Tailscale
is the client→the LLM host hop only). See the standing rule:
[memory/inference-tier-network-topology.md].

## ⚡ Day-one bring-up results (2026-06-04) — READ FIRST, supersedes planning below

Hardware live (`forza`, LAN-local at `192.168.0.188`). A full day of benching
**settled the engine + model + mode with data** and **overturned several
committed assumptions**. This section is the empirical truth; planning sections
below are kept for rationale but superseded where they conflict.

### FINAL STACK (decided 2026-06-04)
**vLLM + Qwen3-Next-80B-A3B-Instruct (NVFP4) + think-OFF**, served at
`http://192.168.0.188:8090/v1` (model id `qwen3-next-80b-a3b`).
Measured on forza via vLLM: **39 t/s single-stream · 129 t/s @ N=4 (batching
scales 3.3×) · 4,398 t/s prefill · 128 K context · 1.52 M-token KV.**

1. **The 122B-A10B does NOT fit a single Spark.** Model + its Qwen3.6 vision
   encoder + reserves consume **~116 GB of 121 GB** resident → **0 allocatable
   KV blocks**. Cannot serve. It's a two-Spark (EP=2) model. → 80B-A3B is primary.
2. **Engine = vLLM, NOT Atlas.** Atlas (GB10-tuned) got us serving + benched in
   an hour and has faster *single-stream* (~73 vs 39), but: (a) its batching is
   **flat** (~70 t/s ceiling, no aggregate gain), (b) immature OpenAI-compat
   (mangled think-ON+tools). vLLM supports the full stack (Qwen3-Next arch +
   NVFP4 + GDN kernels + hermes tool parser), batches properly, and has ~4×
   prefill. For Hearth's concurrent, prefill-heavy deliberation, vLLM wins.
3. **CORRECTION — batching is NOT flat "physics."** That earlier finding was
   **Atlas-specific**, not fundamental. **vLLM scales: 39 → 78 → 129 t/s at
   N=1/2/4** (its FlashInfer CUTLASS NVFP4 MoE kernels batch experts properly).
   So concurrency = real throughput on vLLM; the batched-deliberation thesis
   holds.
4. **Mode = think-OFF.** The `-Thinking` model variant *rambles* (circular
   "wait… maybe… another angle…"), is **3× more verbose for no quality gain**,
   and on the hardest case reasoned itself into a *worse* answer than the
   Instruct model's clean one-pass (it even thinks for 50 tokens on "say OK in
   one word"). Confirmed 3 ways: Atlas+Thinking vs vLLM+Instruct, **vLLM+Thinking
   vs vLLM+Instruct same-engine**, and the prior `THINK_OFF_CHAT_BRIEF`. Hearth
   deliberation is grounded judgment + structured output (one-pass), and
   correctness comes from RAG + `fact_critic`, not the think channel.

Read [design-two-tier-inference.md](design-two-tier-inference.md) and
[config/llm-roles.yaml](../config/llm-roles.yaml) first. This doc supersedes the
earlier "DEEP-XL serialized capability tier" framing — analysis of the live role
config showed the Spark's real value is **offloading the serialized background
pile-up off the 3090 with batched concurrency**, not being a single serialized
super-genius.

> **2026-06-04: voice dropped.** Voice (Hazel `voice_realtime`, pipecat) is
> parked indefinitely — not worth the latency budget right now. That removes the
> one workload that *required* a dedicated low-latency isolated GPU, which frees
> the **A4000 to become the dedicated RAG tier** and lets the Spark absorb the
> remaining concurrent work. No "future fast card" is needed for this plan.

> **2026-06-04: Phase 2 + RAG SHIPPED LIVE.** The partition below is now
> reality: `specialist_deliberation`/`research_extract`/`deep_consult` **and**
> `live`/`librarian` (Astrid/Cordelia) serve from forza's 80B; the A4000's
> IQ2-27B LIVE tier (`:8089`, `llamacpp-live-glacier`) is **decommissioned**;
> the A4000 now runs **infinity** (bge embeddings + rerank) at `:8091` for the
> wired hybrid RAG pipeline (`HEARTH_RAG_VECTOR=1`, whole vault backfilled).
> The staged §6 `llm-roles.yaml` edits below are APPLIED (model id is
> `qwen3-next-80b-a3b`, not the 122B; embeddings base_url has no `/v1`). See
> [shipped-2026-06.md](archive/shipped-2026-06.md) + [ops/embeddings/README.md](../ops/embeddings/README.md).

---

## 1. The diagnosis (why the Spark, really)

Reading `llm-roles.yaml` surfaced the actual bottleneck — it isn't "the 27B
isn't smart enough":

- **The 3090 is an overloaded everything-box.** `specialist_deliberation`,
  `research_extract`, `deep_consult`, `specialist_drafter`, `reflector`,
  `scribe_writer`, `concierge_drafter` **all** resolve to `Qwen3.6-27B-Q4_K_M`
  on `:8088`, **single-slot + DFlash (`-np 1`)**. Every scheduled brief,
  Beatrice's 03:00 codebase sweep, Kristi's research extraction, and any
  `consult_deep_model` call **serialize through one slot** — behind each other
  and behind interactive chat.
- **`deep_consult` is currently a no-op escalation.** The header says it: the
  two-tier split collapsed, so `consult_deep_model` is *"a same-model call now."*
- **The RAG layer isn't wired.** `embeddings` (`bge-large`) and `reranker`
  (`bge-reranker-v2-m3`) are **placeholders, never invoked in code** — yet
  retrieval quality is the highest-ROI lever for a RAG-first system.

So the Spark's job is: **(a)** take all async/background reasoning off the 3090
and run it *concurrently* on a *more capable* model, **(b)** un-collapse
`deep_consult` into a real model escalation; and with voice gone, **(c)** the
A4000 finally gives the RAG pipeline a dedicated home.

---

## 2. Why batched concurrency, not a serialized big model

Decode at **batch=1** reads all active weights per token → **bandwidth-bound**
(the Spark's weakness). Decode at **batch=N** reads the active weights **once**
and applies them to N sequences → arithmetic intensity rises ~N× until it hits
the compute roof. The Spark has a **huge FP4 compute roof (~1 PFLOP) and a low
bandwidth floor** — *exactly* the profile where `--parallel N` continuous
batching converts idle compute into aggregate throughput. **⚠ MEASURED FALSE
2026-06-04 for this sparse MoE — batching gave ZERO aggregate gain (see Day-one
results). The amortization theory holds for DENSE models; a sparse MoE's
concurrent sequences activate disjoint experts, so there is no shared weight-read
to amortize.** 128 GB = enormous KV
headroom → many slots.

**Corollary (answers "would a ~70B give us concurrency?"): yes — and a smaller
model gives *more*.** An 80B-A3B (~45 GB) leaves ~70 GB for KV caches → more
slots than a 122B (~70 GB). A *dense* 70B is the trap (~2.7 t/s single-stream) —
"70-ish B" only works as a **low-active MoE**.

**Caveat — measure the curve.** MoE batching is sub-linear (concurrent tokens
route to different experts, eroding weight-read amortization). Bench
N-vs-aggregate (the A4000 plateaued at N=4 in design-two-tier-inference.md §5;
the Spark plateaus higher — find where → sets `max_concurrency`).

---

## 3. The partition (voice-dropped) — match each box's binding constraint

| | VRAM | Bandwidth | Compute | Role |
|---|---|---|---|---|
| **RTX 3090** | 24 GB | **936 GB/s** ★ | strong | **Latency tier** — interactive chat |
| **RTX A4000** | 16 GB | 448 GB/s | weak | **RAG tier** — embeddings + rerank |
| **DGX Spark** | **128 GB** ★ | 273 GB/s | **~1 PFLOP FP4** ★ | **Background depth + concurrency** (all async LLM work) |

### 3090 — Latency tier (synchronous, user-waiting). **Unchanged.**
Keep it doing **only what Jasper waits on**: `specialist` chat (27B Q4 + DFlash,
~70 t/s) + the cheap `planner`/`fact_critic` calls. Relieving it of background
work (§4) is the core win. **Never batch the 3090** (DFlash + `-np 2` corrupts
output — design-two-tier-inference.md §5).

### A4000 — RAG tier. **Repurposed (voice freed it).**
The IQ2-27B LIVE/voice tier is retired here; the A4000 becomes the dedicated
home for the retrieval pipeline that's currently just dead placeholders:
`bge-large` embeddings + `bge-reranker-v2-m3` (~2.5 GB), with headroom (16 GB)
for an optional small `fact_critic`/`planner` judge model later to relieve the
3090 further. Weak compute is fine — encoder forward passes are tiny and fast;
retrieval stays low-latency on the local host (`host.docker.internal`, no
tailnet hop). **This is the highest-ROI change for a RAG-first system** and is
nearly independent of the Spark — do it first.

### Spark — Background depth + concurrency tier. **New. Absorbs all async LLM.**
One capable MoE with `--parallel N` continuous batching, serving **everything
async/concurrent**:
- `specialist_deliberation` (all scheduled briefs/passes) — off the 3090
- `research_extract` (Kristi)
- a **real** `deep_consult` (un-collapsed escalation)
- `librarian` (Cordelia's curation/verify) — moved off the A4000; it's
  background and the model's already loaded, so co-running her verify stream
  costs nothing extra (the "use a 2-bit model for fetch-not-recall" efficiency
  rationale was about not wasting a *dedicated* GPU on her — co-hosting on the
  batch tier doesn't)
- `live` (Astrid mid-workout coaching) — moved off the A4000; the Spark's
  ~51 t/s single-stream still *beats* the old IQ2-27B (~25 t/s), and batching
  joins her cue to the in-flight batch immediately (no wait for a heavy turn to
  finish). Lost "dedicated-GPU isolation" is a non-issue now that voice — the
  one hard-real-time consumer — is gone.
- plus Beatrice's PR drafting and Mariah's audits (the hard-reasoning tail)

---

## 4. Specialist routing

Moving `specialist_deliberation` to the Spark shifts **every** specialist's
scheduled/background reasoning there (intended — all latency-tolerant, the Spark
batches the volume). On top of that:

| Specialist | Role | Spark? | Why |
|---|---|---|---|
| **Beatrice** (meta-dev) | autonomous **codebase PR + systemic audit** | **#1 yes** | Code/impl reasoning is the most size-sensitive & least RAG-groundable work; her YAML *already* notes the 27B "drops tool args when 15+ tools compete" — at the ceiling. Async (03:00). |
| **Mariah** (PM) | program/authenticity **auditor** | **yes** | Adversarial judgment — "is the operation healthy" can't be fetched. |
| **Kate** (COS) | brief + discretion | **split** | Brief synthesis is grounded (wash); her discretion/prioritization benefits. Optionally keep her brief on the 27B via a per-specialist `provider_role` override (she's user-facing → persona-continuity costs more). |
| **Cordelia** (Librarian) | curation / verify | **yes (free)** | Fetch-not-recall — doesn't *need* the big model, but co-hosting her `librarian` stream on the always-on batch tier is free; frees the A4000 for RAG. |

`deep_consult` repointing means a 27B chat turn that hits `consult_deep_model`
now escalates to the Spark's 80B — a genuine model jump again.

---

## 5. Model choice — primary: Qwen3.5-122B-A10B on Atlas

| Model | VRAM (NVFP4) | Active | ~Decode (b=1) | Concurrency room | Persona-consistent |
|---|---|---|---|---|---|
| Qwen3.6-35B-A3B | ~20 GB | 3B | ~131 t/s | highest | ✅ same gen as 27B |
| Qwen3-Next-80B-A3B | ~45 GB | 3B | ~74 t/s | high | ⚠️ 3.5-era |
| **Qwen3.5-122B-A10B** | ~70 GB | 10B | ~51 t/s | lower | ⚠️ 3.5-era |

**Primary: Qwen3-Next-80B-A3B on Atlas** — REVISED 2026-06-04: the 122B-A10B
does NOT fit a single Spark (0 KV; see Day-one results), so the 80B-A3B is the
working primary. *The 122B capability reasoning below is retained as the
rationale for a future two-Spark (EP=2) deployment, not the current single-box
choice.* The deep-think tier's real job is
**tool-heavy, context-heavy reasoning** — Beatrice's codebase PRs (15+ tools),
Mariah's whole-roster audits — and reliable many-tool attention + long-context
synthesis scale with **active** parameters, not total. The 122B's 10B active is
materially stronger at that than the 3B-active 80B/35B. It's a pre-tuned Atlas
config (`Sehyo/Qwen3.5-122B-A10B-NVFP4`, GDN+attention+MoE+MTP); Atlas's MTP
speculative decode is the lever that lifts its ~51 t/s baseline.

The cost is **fewer concurrent slots** (~70 GB model → smaller KV pool) — fine
*if* real concurrent-deliberation demand is modest (≈3–6 specialists overlap at
a busy slot, not 16). **Measure it** (sizing below). If demand turns out high,
fall back to **Qwen3-Next-80B-A3B** (3B active, more slots, ~74 t/s); `35B-A3B`
is the persona-consistent further fallback. All MoE; never a dense 70B.

### Deep-think tier sizing — context/KV vs concurrency

The Spark's 50–80 GB KV pool is **shared** between *per-request context length*
and *number of concurrent slots* — you can't max both. A bigger KV cache also
**slows decode** (more bytes/token on the Spark's low bandwidth), and — being
RAG-first — you want *retrieved relevant* context in a 64–128 k window, not a
256 k dump ("lost in the middle" is real; more context ≠ better). So size by:
1. **Tools:** lift Beatrice/Mariah off the 27B's fear-trimmed ~4–10 back to the
   ~15–25 they actually need — the 27B's "drops args at 15+ tools" wall lifts
   with the 122B's active-param budget. Curate for relevance, don't kitchen-sink.
2. **Context:** big-but-not-absurd (64–128 k) — a codebase sweep / full-day
   synthesis, reserving KV for the slots you need.
3. **Slots:** set `--parallel`/`max_concurrency` to *measured* overlap, not a
   round number — every reserved slot is context budget spent.

### Tool-round ceiling on the deep-think tier

Agentic tool depth per turn is a **runtime constant**, not a hardware property:
`MAX_TOOL_ROUNDS = 15` ([src/core/specialist_runtime.ts:64](../src/core/specialist_runtime.ts)),
overridable per-specialist via YAML `max_tool_rounds`. A *round* is one
model→tools step; the model can emit multiple tool calls per round, so actual
calls/turn ≈ `rounds × calls-per-round`. The Spark doesn't auto-raise the 15 —
but it makes a higher ceiling **usable**: the bigger context window raises the
cumulative tool-result budget (`tool_budget_chars_for_window` /
`enforce_cumulative_tool_budget` in `tool_result_compaction.ts`), and the 122B's
10B active sustains a coherent 30+-round chain where the 27B drifts/repeats.

**The binding limit is the timeout, not the round count.** At ~51 t/s each round
is ~5–15 s, so the 240 s `timeout_ms` caps you at ~16–30 rounds regardless of
`max_tool_rounds`. To use a higher ceiling, raise BOTH (it's latency-tolerant
background work, so a long timeout is free):

```yaml
# specialist YAML (e.g. Beatrice) — up from the default 15
max_tool_rounds: 35
```
```yaml
# the deliberation_xl role in llm-roles.yaml
timeout_ms: 540000   # ~9 min, up from 240000 — lets the 35 rounds actually run
```

Yields ~35 rounds → ~35–70+ tool calls/turn, coherently. **Don't fetishize one
mega-turn:** the runtime already boomerangs toward synthesis as the budget
tightens (`_budget_signal`) and `promise_followup` schedules a fresh full-budget
turn — so the design is *bounded per turn, continued across turns*. Raise the
per-turn bound where coherence justifies it (Beatrice's codebase sweeps,
Mariah's audits); let `promise_followup` handle anything longer.

---

## 6. Staged `llm-roles.yaml` changes — **apply at Phase 5, not now**

> ⚠️ **Do NOT apply until the Spark is serving.** Repointing roles at a dead
> endpoint breaks every brief/consult on the next call. Gate with
> `HEARTH_SPARK_TIER` and keep the `:8088` 27B as instant rollback.

**Networking — SOLVED, LAN-local (2026-06-04).** forza is a **pure internal
inference backend** — only the LLM host's orchestrator talks to it, **over the LAN**
(`192.168.0.188`), never the tailnet. Verified: the orchestrator container
reaches `http://192.168.0.188:8090` with `curl → 200` (Docker bridge NAT routes
to LAN hosts fine — no tailnet-in-container problem). Atlas is bound to the LAN
interface only (`--bind 192.168.0.188`, not `0.0.0.0`). **Tailscale is the
client→the LLM host hop ONLY** — forza doesn't need to be a tailnet node and can be
dropped from it (remote admin jumps through the LLM host). See the standing rule:
[memory/inference-tier-network-topology.md]. RAG on the A4000 stays
`host.docker.internal` (same host as the orchestrator).

```yaml
# ── BACKGROUND tier — moved to the DGX Spark (GB10), 80B-A3B, --parallel N ──
# base_url = forza LAN IP (192.168.0.188); model id must match what the engine serves;
# max_concurrency MUST equal --parallel (mutex keyed by base_url → never
# cross-serializes :8088).

  specialist_deliberation:
    provider: openai
    base_url: http://192.168.0.188:8090/v1   # was host.docker.internal:8088
    model: qwen3-next-80b-a3b   # Atlas --model-name; was Qwen3.5-122B (didn't fit)                        # was Qwen3.6-27B-Q4_K_M.gguf
    concurrent: true
    max_concurrency: 3        # tune from the bench curve (§2)
    temperature: 0.3
    preserve_thinking: true
    think: true
    timeout_ms: 240000
    max_tokens: 3000
    context_window_tokens: 98304

  deep_consult:               # un-collapsed: a REAL model escalation again
    provider: openai
    base_url: http://192.168.0.188:8090/v1
    model: qwen3-next-80b-a3b   # Atlas --model-name; was Qwen3.5-122B (didn't fit)
    concurrent: true
    max_concurrency: 3
    temperature: 0.5
    preserve_thinking: true
    think: true
    timeout_ms: 240000
    max_tokens: 4000
    context_window_tokens: 98304

  research_extract:
    provider: openai
    base_url: http://192.168.0.188:8090/v1
    model: qwen3-next-80b-a3b   # Atlas --model-name; was Qwen3.5-122B (didn't fit)
    concurrent: true
    max_concurrency: 3
    temperature: 0.3
    preserve_thinking: true
    think: true
    timeout_ms: 240000
    max_tokens: 4000
    context_window_tokens: 98304

  # live + librarian move off the A4000 onto the Spark batch tier (the A4000
  # is now the RAG box). Same base_url as the background roles — they share the
  # Spark's --parallel slots.
  live:
    provider: openai
    base_url: http://192.168.0.188:8090/v1   # was host.docker.internal:8089
    model: qwen3-next-80b-a3b   # Atlas --model-name; was Qwen3.5-122B (didn't fit)                        # was Qwen3.6-27B-UD-IQ2_M.gguf
    concurrent: true
    max_concurrency: 3
    temperature: 0.4
    think: false
    max_tokens: 800
    context_window_tokens: 98304   # Spark window (was 36864 on the A4000)

  librarian:
    provider: openai
    base_url: http://192.168.0.188:8090/v1
    model: qwen3-next-80b-a3b   # Atlas --model-name; was Qwen3.5-122B (didn't fit)
    concurrent: true
    max_concurrency: 3
    temperature: 0.3
    preserve_thinking: true
    think: true
    timeout_ms: 240000
    max_tokens: 4000
    context_window_tokens: 98304

# ── RAG tier — WIRE THE PLACEHOLDERS on the A4000 (local, host.docker.internal) ──
# Provision a real embeddings/rerank server (infinity / TEI) on the A4000.
  embeddings:
    provider: openai                                       # was ollama placeholder
    base_url: http://host.docker.internal:8091/v1
    model: bge-large-en-v1.5

  reranker:
    provider: openai
    base_url: http://host.docker.internal:8091/v1
    model: bge-reranker-v2-m3

# ── PARKED ─────────────────────────────────────────────────────────────
#   voice_realtime → DORMANT (voice dropped 2026-06-04). Leave the role
#     defined but unused; Hazel's turns are parked with it. Re-home on the
#     Spark batch tier (or a future fast card) if/when voice returns.
#
# ── UNCHANGED — stay on the 3090 (:8088) [latency] ─────────────────────
#   specialist / specialist_thinking / planner.
#   scribe_writer / concierge_drafter / reflector / specialist_drafter:
#     leave on :8088 for now; move to the Spark in a second wave once the
#     core cutover is proven (latency-tolerant → Spark is fine).
```

Per-specialist overrides (Beatrice/Mariah pin, Kate brief-stays-on-27B) go in
each specialist's YAML via `llm_role` / `provider_role`, not here.

---

## 7. Day-one checklist

### Phase 0 — Pre-flight
- [ ] Firmware + GB10 drivers (Blackwell/CUDA, SM121); `HF_HOME` on fast NVMe
- [ ] **Static LAN IP** (`192.168.0.188`); confirm the orchestrator container
      reaches `http://192.168.0.188:8090` (`curl → 200`). No Tailscale needed on
      the inference box — LAN-only (see memory/inference-tier-network-topology.md).
- [ ] Docker + NVIDIA Container Toolkit

### Phase 1 — Pull models
- [ ] **Primary:** `Qwen3.5-122B-A10B-NVFP4` (~70 GB) on Atlas; concurrency
      fallback `Qwen3-Next-80B-A3B`; persona fallback `Qwen3.6-35B-A3B`
- [ ] **RAG (A4000):** `bge-large-en-v1.5` + `bge-reranker-v2-m3`

### Phase 2 — Engines + batching bench
- [ ] Serve **Qwen3.5-122B-A10B-NVFP4 on Atlas** (`avarok/atlas-gb10` — primary;
      a pre-tuned config; MTP off→on is the key decode lever) with **vLLM** as
      the comparison baseline. AGPLv3 unmodified self-host = fine.
- [ ] **Bench N-vs-aggregate** (§2) at N=1,2,4,6,8 on Hearth-shaped prompts
      (full persona + 8–16 K brief context + a structured tool-call) → set
      `max_concurrency`

### Phase 3 — RAG first (highest ROI, Spark-independent)
- [ ] Stand up embeddings/rerank on the A4000 (`:8091`); **wire them into
      retrieval** and confirm they're actually invoked (today: dead placeholders)

### Phase 4 — Quality spot-check
- [ ] **JSON-schema adherence across 20+ structured runs** (the 80B's tool
      dialect differs from the 27B — re-validate `_parse_tool_code_dialect`)
- [ ] Fidelity vs a cloud reference on Beatrice/Mariah's hardest real cases

### Phase 5 — Cut the LLM tiers over (gated)
- [ ] `curl` Spark from inside the orchestrator container (networking gate)
- [ ] Apply §6 behind `HEARTH_SPARK_TIER=1`; keep `:8088` 27B as instant rollback
- [ ] Confirm background work no longer queues on the 3090 (interactive latency
      under concurrent background load should *improve*)
- [ ] A/B Beatrice + Mariah hard cases: 80B-Spark vs 27B-3090; keep what wins

### Phase 6 — Lock
- [ ] Engine (Atlas only if it beats vLLM on Hearth prompts AND survives a soak)
- [ ] Freeze model + NVFP4 + KV precision (FP8 KV for long briefs) +
      `max_concurrency`; record numbers in the month's ship log

---

## 8. What the Spark does NOT do
- **Not interactive chat** — bandwidth-bound, latency loses to the 3090. That
  tier is unchanged.
- **Not two big LLMs co-resident** — one generative model owns the pool
  (bandwidth contention).
- **Not Qwen3-235B on one box** — ~118–130 GB at usable quant, over the pool
  before KV; that's a two-Spark NVLink-C2C (256 GB) model.

## 9. Follow-ups
- **PLAN.md / NEXT.md:** add the items (RAG wiring on A4000, Spark background
  tier) once Phase-2 bench numbers justify (four-docs-co-evolve rule).
- **Second wave:** move drafting/reflector roles to the Spark after the core
  cutover proves out.
- **Voice:** parked. If it returns, re-home `voice_realtime` on the Spark batch
  tier or revisit a dedicated fast card then.
- **Two-Spark future:** NVLink-C2C → 256 GB unlocks 235B/405B-class; separate doc.
