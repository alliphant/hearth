# The two-tier / auto-tiering inference architecture

**Status:** infra shipped (this commit) — model provisioned, `live` +
`librarian` roles, N-slot endpoint mutex, A4000 systemd unit. The runtime
tier-selection wiring and the Phase-3 async-consult lane are scoped here and
tracked in PLAN.md.

This is the GPU/model infrastructure under [DURABLE_TRUTH_BRIEF.md](../DURABLE_TRUTH_BRIEF.md)
Phases 2–3 (Cordelia off-GPU + the live concurrent "librarian lane"). Read
that brief first for the *why*; this doc is the *how*.

---

## 1. The two tiers

| | DEEP | LIVE / CONCURRENT |
|---|---|---|
| GPU | RTX 3090 (24 GB) | RTX A4000 (16 GB) |
| Port / unit | `:8088` `llamacpp-glacier.service` | `:8089` `llamacpp-live-glacier.service` |
| Model | Qwen3.6-27B **Q4_K_M** (16.8 GB) + DFlash + mmproj | Qwen3.6-27B **UD-IQ2** (~10 GB) |
| Serving | single-tenant (`-np 1`) | `--parallel N --cont-batching` |
| Mutex | strict (1 slot) | N slots (matches `--parallel`) |
| Use | one heavy reasoning turn at a time | many concurrent live + background turns |
| Status | **UNCHANGED** | new |

The 27B already spills its ~1.3 GB mmproj/CLIP encoder onto the A4000; the
LIVE tier shares the remaining ~14.5 GB.

### Why the *same* 27B at 2-bit, not a 4B/8B

The decisive property: it is the **same weights** as DEEP — same tokenizer,
same chat template, same `<think>` per-request toggle, same `<tool_code>`
dialect the OpenAI provider already recovers. So the task's premise — *"same
persona text; the situation picks the tier"* — is **literally true**, not an
approximation. No per-tier persona fork, no second model's tool-call quirks,
no separate `<think>`-stripping behavior to tune.

For the **librarian/verification** role this is the right bet despite 2-bit's
known factual degradation, because verification's job is to **fetch and cite,
not recall** (the Durable-Truth thesis: make truth cheaper to fetch than to
invent). A 2-bit model that reliably emits a `web_search` tool call and
summarizes the returned text is exactly what's wanted — and Unsloth's UD-IQ2
imatrix is calibrated on tool-calling + long-context chat, so tool reliability
survives the quant even as parametric recall thins. The fabrication-prone
voice 9B was *excluded* from verification for the opposite reason: it recalled.

Qwen3.6 over Gemma-4 (already decided): the per-request think toggle means one
loaded model serves both the latency role (`live`, think OFF) and the
careful-verify role (`librarian`, think ON). Gemma's only edge —
uncorrelated-verifier diversity — can bolt on later as a small separate
verifier beside this tier *if* the librarian rubber-stamps the 27B's errors.

---

## 2. The role layer (logical → physical)

Two new roles in [config/llm-roles.yaml](../config/llm-roles.yaml), both on
the A4000 `:8089`, `concurrent: true`:

- **`live`** — think OFF, `max_tokens: 800`, temp 0.4. Latency-sensitive
  concurrent turns: Astrid coaching mid-workout, Hazel-style relays, any
  specialist that must act *while* the user is mid-conversation on the 27B.
- **`librarian`** — think ON, `preserve_thinking`, `max_tokens: 3000`,
  `timeout_ms: 240000`, temp 0.3. Background verification: Cordelia's durable
  curation drain and the Phase-3 async-consult lane.

Both pin the same A4000 model (one process, think toggled per call). They
share the endpoint and therefore the endpoint mutex.

### The mutex change (the load-bearing code fix)

[src/core/router.ts](../src/core/router.ts) wraps **every** provider in a
`SerializedProvider` backed by a per-endpoint `HostMutex`
([src/core/llm_serializer.ts](../src/core/llm_serializer.ts)). That mutex was
single-slot — correct for the single-tenant 27B (a second request mid-stream
aborts the first), but it would funnel a `--parallel N` batched server back
down to one-at-a-time and **defeat the entire LIVE tier**.

Fix: `HostMutex` is now an **N-slot FIFO semaphore** (default `max_concurrency
= 1` → unchanged strict mutex). A role with `concurrent: true` constructs its
endpoint's mutex with `max_concurrency = max_concurrency` (matching
`--parallel`). Up to N live/librarian turns generate at once; the (N+1)th
queues client-side → backpressure preserved *and* concurrency unlocked. Keyed
by base URL, so the 27B endpoint stays single-slot and LIVE turns never block
it (distinct processes, distinct GPUs).

---

## 3. Auto-tiering: how a turn picks DEEP vs LIVE

The runtime **already** resolves the role as
`input.llm_role ?? specialist.llm_role ?? 'specialist'` and maps role → prompt
shape in `_prompt_mode()`. Tier selection is therefore role selection — no new
dispatch plumbing, just policy about who sets the role. Four layers, highest
precedence first:

1. **Per-call override `input.llm_role`** (explicit, highest). The async lane
   and background workers pass `'librarian'` directly.
2. **Situation/mode hint (the Astrid case).** Astrid is *not* a live-only
   specialist — she chats normally on DEEP and coaches live on LIVE. The
   surface that knows "this is an active workout session" declares the
   **situation**, not the GPU. Proposed contract: a `tier?: 'deep' | 'live'`
   (or `live_session: boolean`) hint on the turn input that the runtime maps
   to the `live` role *when the specialist hasn't pinned one*. Callers declare
   situation; the runtime owns the situation→role→GPU mapping. (Today a caller
   can already pass raw `input.llm_role: 'live'`; the hint is the clean sugar.)
3. **Per-specialist static pin `llm_role: live`** (YAML, like Hazel →
   `voice_realtime`). For a specialist whose *every* turn is live/concurrent.
4. **Default `specialist`** → DEEP 27B. The primary interactive answer.

### The decision table

| Turn | Tier / role | Why |
|---|---|---|
| Primary interactive chat | DEEP `specialist` | Quality path. **Never silently downgraded.** |
| Live coaching mid-workout (Astrid) | LIVE `live` (think off) | Must respond *while* a 27B turn may be running; latency over depth |
| Hazel relay / receptionist | LIVE `live` | Tiny prompt, narrow tools, latency-first |
| Cordelia curation drain / `flag_cordelia` | LIVE `librarian` (think on) | Background; drains off the 3090 so chat throughput is decoupled |
| Phase-3 async verification | LIVE `librarian`, **concurrent with** DEEP primary | "Two brains, one moment" — see §4 |
| Scheduled deliberation / briefs | DEEP `specialist_deliberation` | Unchanged; reasoning is the point and it's off the interactive path |

### Coexistence: live Astrid ‖ a 27B chat turn

Genuinely parallel, no serialization, because they're **different endpoints**:
the 27B chat holds the `:8088` single-slot mutex; Astrid's live turn holds one
of the `:8089` N slots. The router's per-endpoint mutex keying is what makes
this safe — the change in §2 is precisely what lets the two run at once.

### Why NOT a load-based auto-router (deliberate non-goal)

The tempting design — "route the primary turn to the A4000 when the 3090 is
busy" — is rejected. It silently swaps a 2-bit model under the user's primary
answer based on transient load: non-deterministic quality, hard to reason
about, and a direct violation of "the interactive answer is the quality path."
Backpressure is the right pressure-relief: the 27B's single-slot mutex queues
the second concurrent chat turn (the existing, correct behavior). If
load-shedding is ever wanted it must be **explicit and audited**, scoped to
genuinely-interruptible background work, never the interactive turn. Tier
selection stays **declarative** (situation-driven), not load-driven.

---

## 4. Phase-3 async-consult lane ("two brains, one moment")

**The binding constraint is the runtime, not the GPU.** Even with the
librarian on its own GPU, `consult_specialist` / `consult_deep_model` are
**synchronous** — the primary turn `await`s the consult to completion
([src/tools/consult_deep_model.ts](../src/tools/consult_deep_model.ts) is a
plain `await provider.complete()`). The GPU concurrency from §1–§3 is wasted
until the runtime can dispatch and *join* two turns.

### The build (scoped)

An **async consult lane** in
[src/core/specialist_runtime.ts](../src/core/specialist_runtime.ts):

- **Dispatch:** when a primary (DEEP) turn declares a verification need, the
  runtime fires a `librarian` turn *without awaiting it* — returns an
  `AsyncConsultHandle` (a `Promise<ConsultResult>` plus metadata). Because the
  librarian endpoint is `concurrent` and on a different GPU, this `complete()`
  runs truly in parallel with the primary turn's generation.
- **Join:** at the primary turn's finalize point, `await` the handle and run a
  short synthesis round that folds the librarian's cited sources in.

### Join semantics — three options, one recommendation

- **(a) Provenance-gated finalize (RECOMMENDED).** Primary streams its
  reasoning; before emitting *load-bearing* claims it awaits the librarian
  verdict, then incorporates her cited sources or drops/flags unsourced
  specifics. This dovetails with the just-shipped **semantic fact critic**
  (Durable-Truth Phase 1.5, commit `96a7482`,
  [src/core/fact_critic.ts](../src/core/fact_critic.ts)): the critic checks
  load-bearing claims against a grounding context; the async librarian is the
  *concurrent producer* of that grounding, so the critic can **verify against
  fresh sources instead of redacting**. The librarian races the primary turn,
  not the user's patience.
- **(b) Two-pass synthesis.** Primary drafts; librarian fetches concurrently;
  a final cheap synthesis round merges. Cleaner separation, higher latency
  (two primary rounds). Use when the primary answer structurally *depends* on
  what's found (e.g. "plan X around fact Y").
- **(c) Optimistic stream + correction.** Primary streams immediately; the
  librarian's sources arrive after and append a correction. Best perceived
  latency but a post-hoc correction is jarring — only for non-load-bearing
  enrichment, never for the claim the user asked about.

**Recommendation:** (a) for the fabrication-risk path the brief targets;
reserve (b) for plan-dependent turns. (c) is enrichment-only.

### Relationship to existing serialization

`serialize_per_conversation` (in the specialists route) keeps turns *within
one conversation* ordered; the per-endpoint `HostMutex` keeps the model host
sane. The async lane runs the librarian as a *sibling* of the primary turn,
not a follow-on turn in the same conversation — so it sidesteps the
per-conversation queue and lands on the LIVE endpoint's N-slot mutex. Define
the handle's lifecycle (cancel on primary abort, timeout = `librarian`'s
`timeout_ms`) when implementing.

---

## 5. Provisioning & VRAM

- **Models:** `unsloth/Qwen3.6-27B-GGUF` (same repo as the deployed Q4) →
  `Qwen3.6-27B-UD-IQ2_XXS.gguf` (9.4 GB) and `Qwen3.6-27B-UD-IQ2_M.gguf`
  (10.8 GB) under `/home/jasper/llm/models/qwen36-27b-iq2/` on the LLM host.
- **A/B (done):** [ops/llm/ab-quant.sh](../ops/llm/ab-quant.sh) launched each
  on the A4000 and probed latency, 4-way concurrency, fabrication resistance
  (the Ponds Fire bait, no tools), and tool-call emission. **UD-IQ2_M won.**
  Both quants resisted outright fabrication (neither invented a PUC order
  number — both declined). Single-stream speed was identical (~23 tok/s,
  5.5 s / 128 tok). The decider was the tool-call probe: **IQ2_XXS *narrated*
  "I will search…" but emitted NO tool call** — the precise verification
  failure the librarian role cannot have — while **IQ2_M emitted a clean
  `web_search` call**. So M is pinned for both `live` and `librarian`; XXS
  offered no latency win to justify its tool-call unreliability.
- **VRAM budget (A4000, ~14.5 GB free after the 27B's mmproj split):** IQ2_M
  ~10.2 GB model + ~3.2 GB unified KV (`--ctx-size 24576`, q8 cache) at
  `--parallel 4`. IQ2_XXS (~8.6 GB) leaves headroom for higher N / longer ctx.
- **No speculative draft on the LIVE unit** — measured and rejected
  (2026-05-31): adding the 27B DFlash draft *lowered* IQ2_M decode (~25 →
  ~20 tok/s). The draft is calibrated for the full-precision model, so its
  predictions get rejected too often against the 2-bit target to pay for the
  draft overhead. Continuous batching is the throughput mechanism here, not
  speculation.
- **Text-only** (no mmproj on `:8089`): vision stays on the 27B via
  `consult_deep_model`. A capture the librarian must *see* escalates to DEEP.

### Measured performance — concurrency, NOT speed (2026-05-31)

The LIVE tier is **not a latency upgrade** — it's slower per token than the
DEEP 27B. Single-stream, short turn, `timings` from llama.cpp:

| | prefill (→TTFT) | decode | TTFT est. |
|---|---|---|---|
| IQ2_M on A4000 | 167 tok/s | **24.8 tok/s** | ~520 ms |
| 27B Q4 on 3090 (DFlash) | 207 tok/s | **47.9 tok/s** | ~410 ms |

**Concurrent capacity (`--parallel 4`, measured 2026-05-31, 100-tok turns):**

| concurrent N | wall | aggregate | per-stream |
|---|---|---|---|
| 1 | 4.8 s | 20.7 tok/s | 20.7 |
| 2 | 5.7 s | 34.9 tok/s | ~17.5 |
| 4 | 9.3 s | 43.0 tok/s | ~10.8 |
| 8 | 20.2 s | 39.6 tok/s | ~5 (4 queue) |

**4 truly-concurrent sessions** (the `--parallel 4` slots + the matching
`max_concurrency: 4` mutex). Aggregate throughput plateaus at ~43 tok/s at
N=4; N=8 shows no aggregate gain (the extra four queue) and doubles latency,
so 4 is the right ceiling for this model on the A4000. Per-stream rate
degrades with load (20.7→10.8 tok/s from N=1→4) since the slots share
bandwidth — fine for short live acks, and the planned GPU upgrade raises both
the slot count and per-stream speed.

Decode is memory-bandwidth-bound and the **A4000 has ~half the 3090's
bandwidth** (~448 vs ~936 GB/s), which outweighs the smaller 2-bit model. So
the value of the tier is **concurrency + isolation**, not a faster turn: a
live/librarian turn runs on its *own* GPU instead of queuing behind (or
aborting) the single-slot 27B. A live turn's ~520 ms TTFT is real because
there's *no contention*, not because the model is fast; for short live acks
(~30 tok ≈ 1.2 s) the rate is a non-issue and the parallelism is the whole
point. For `librarian` (background, latency-tolerant) decode speed is
irrelevant — quality + reliable tool-calling + off-the-3090 is the win.

**Hardware path (planned).** The A4000 is the latency bottleneck. Jasper
intends to replace it with a faster card (4090 / 5090 / RTX 5000 / 6000) for
the live/concurrency role. That would make the LIVE tier genuinely *fast*
(higher bandwidth → 2–3× decode), and its extra VRAM would unlock higher
`--parallel N`, longer context, a less-aggressive quant, or even Q4 on the
live GPU. Until then, treat `live` as concurrent-not-fast; only split it onto
a dedicated small fast model if real Astrid-mid-workout latency demands it
before the GPU lands (the infra already supports a per-role `base_url` split
— `live` could point at a small model while `librarian` keeps IQ2_M). See
[PLAN.md](../PLAN.md) Tier 5.

### DEEP tier (3090): keep DFlash + `-np 1` — do NOT batch (measured 2026-06-03)

⚠️ **`--spec-type dflash` + `-np 2` (or higher) CORRUPTS output and poisons the
server.** beellama's DFlash speculative decode is not slot-isolated — the boot
log itself warns `DFlash enabled for slots 0..0; slots 1+ will use
non-speculative decode`, but in practice a concurrent request scribbles the
shared recurrent/cross-ctx ring state and the server starts returning
degenerate garbage (`"for for the for for"`, empty `content`, 17 s for a
600-tok turn) — **and it doesn't recover**: subsequent *single* requests stay
poisoned until a restart. Since `:8088` backs every depth-tier chat /
deliberation / extraction, this is production-down-quality. Reject permanently.

Measured A/B on the 3090 (Q4_K_M, 600-tok greedy turn):

| Config | Single-stream | Output | Concurrency |
|---|---|---|---|
| **DFlash, `-np 1`** (canonical) | **~8.5 s / ~70 tok/s** | clean | none (serialized) |
| no-DFlash, `-np 2` | ~16 s / ~37 tok/s | (timings clean; output unverified) | 2 slots, ~52 tok/s aggregate |
| DFlash, `-np 2` | ~8.5 s slot-0 | **CORRUPT + poisons server** | broken |

Takeaways: (1) **DFlash is a ~1.9× single-stream win** here (vs *no* speculation
— more than the "1.2–1.5× over stock spec-decode" in architecture.md, which is a
different baseline). (2) Decode is memory-bandwidth-bound, so `-np 2` *without*
DFlash gives ~52 tok/s aggregate — **less than one DFlash stream (70)** — i.e.
the single-slot DFlash config wins on BOTH latency and aggregate throughput; the
only thing batching buys is anti-head-of-line-blocking, which isn't worth losing
DFlash for. (3) **Concurrency belongs on the A4000** (which batches correctly),
NOT the 3090. The 3090 stays the fast single-stream brain; the A4000 is the
concurrency/overflow + voice lane. If a concurrency lane on the 3090 is ever
needed, the only safe path is no-DFlash `-np N` — and its *output* must be
inspected for corruption first, not just its timings.

---

## 6. What's built vs scoped

**Built + live:** IQ2 models on the LLM host; `live` + `librarian` roles; N-slot
`HostMutex` + `concurrent`/`max_concurrency` `RoleConfig`;
`llamacpp-live-glacier.service` **installed, enabled, active** (IQ2_M warm on
the A4000); the A/B harness. Plus the runtime tier-routing (2026-05-31):
- **`tier: 'deep' | 'live'` turn-input hint** → `resolve_effective_role()`
  maps `tier: 'live'` to the `live` role when the specialist hasn't pinned
  one (declarative precedence: explicit `llm_role` > `tier` > specialist pin
  > default). A `live` turn keeps the full conversation persona but skips
  turn-time RAG for latency, and curates tools like a normal chat turn.
- **`provider_role` endpoint/behavior decoupling** — a turn can run on a
  different GPU/model than its behavior role implies. The deliberation pass
  uses it: opted-in specialists (`proactive.deliberate_on_live: true`, e.g.
  **Cordelia**, whose 04:00 curation pass is verification work) keep the
  `specialist_deliberation` prompt + tools but execute on the `librarian`
  A4000 endpoint, draining off the 3090.
- **The Phase-3 async-consult lane (§4)** — when the fact critic flags
  unsupported load-bearing claims, the runtime dispatches a librarian
  (Cordelia) verification on the A4000 (`_librarian_verify`, via
  `provider_role: 'librarian'`) that FETCHES the questioned facts, then
  grounds the primary's retry in her cited findings (`librarian_findings_nudge`)
  instead of only nudging "you're ungrounded." Fail-open, recursion-guarded
  (`!input.provider_role`), and **gated by `HEARTH_ASYNC_LIBRARIAN=1`**
  (opt-in: it adds a librarian sub-turn's latency to a flagged turn). The
  chat send-route accepts a `tier: 'live'` body field threading to the
  runtime hint; the iOS client setting it per live session is the remaining
  cross-repo piece.

**Proven end-to-end (2026-05-31):** `bun run smoke:two-tier`
([scripts/smoke-two-tier.ts](../scripts/smoke-two-tier.ts), run via
`docker exec hearth-orchestrator` so `host.docker.internal:8089`
resolves) drives the REAL `ConfigLLMRouter` and confirms: `specialist`
routes to the Q4 27B (`:8088`) and `librarian` (the Cordelia lane) to
the IQ2_M (`:8089`); a DEEP and a LIVE turn fired together run in
parallel (concurrent wall-clock ≈ the slower call, not the sum — the
per-endpoint mutexes don't cross-serialize); the decode-rate gap (28 vs
22 tok/s) fingerprints the two GPUs; and the think-on librarian turn
emits a real `web_search` tool call (fetch-not-recall). Skips cleanly
when `:8089` is down (it isn't always-on until the unit is installed).

**Scoped next:**
1. **iOS** sets `tier: 'live'` per live session (cross-repo) — the backend
   send-route accepts it; the client must send it (workout-coaching context →
   Astrid). Cassandra's reactive path produces observations, not turns, so it
   needs no tier; Hazel already runs on the A4000 via `voice_realtime` (kept —
   her slim voice prompt is the right shape, no re-pin).
2. **Soak the async lane** with `HEARTH_ASYNC_LIBRARIAN=1` and tune: which
   specialists benefit, whether to fold the librarian's verified source into
   `curate_for_specialist` so the *second* ask is a local cited read (the
   durable-curation tie-in), and whether to make it default-on once proven.
