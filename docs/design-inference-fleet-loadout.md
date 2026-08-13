# Inference fleet — optimal per-GPU loadout (benchmarked 2026-06-06)

> **UPDATE 2026-06-24 — deep+interactive tier moved to STOCK llama.cpp on the
> the LLM host RTX 6000 Ada (`:8200`).** The 2026-06-06 recommendation below (and its
> 2026-06-07 35B-on-forza-vLLM swap) is superseded twice: (1) the 2026-06-10
> hardware migration moved the deep tier onto the LLM host's new RTX 6000 Ada; (2) on
> 2026-06-24 the serving BACKEND swapped from the `vllm-deep` FP8 vLLM container to
> **stock llama.cpp b9782** serving the Unsloth `Qwen3.6-35B-A3B-UD-Q5_K_XL.gguf`,
> for **`--jinja` grammar-constrained tool-call decoding** (the decoder can't emit a
> malformed/as-text tool call — the holistic fix for the vLLM tool-calling FORMAT
> tail). Validated end-to-end: coherent generation (the `beellama.cpp` fork garbled
> this exact GGUF into a `/////` loop — stock llama.cpp does not), think-OFF honored
> natively via `chat_template_kwargs:{enable_thinking:false}`, and reliable native
> tool calls across email/phone/birthday/address/likes (zero tool-call-as-text,
> durable writes, ~7 s/turn). Run as systemd `--user` unit
> `llamacpp-35b-glacier.service`; build/serve recipe + flags in `CLAUDE.md` "The
> inference tiers" + the `config/llm-roles.yaml` top block. Rollback kept:
> `docker start vllm-deep`. The bench rationale below remains the historical record
> of *why the 35B-A3B* (vs the 80B-Thinking) — that model choice still holds; only
> the backend + box changed.

Status: **recommendation, pending Jasper's sign-off.** Nothing applied. All
numbers below are measured on the real boxes (the LLM host 3090 / A4000, forza GB10)
the night of 2026-06-06, not estimated. Bench harness: `scripts/bench-fleet.py`
(TTFT/decode/tool-call/JSON/concurrency) + `scripts/bench-voice.py` (STT/TTS).

## TL;DR

| GPU | Now | Recommendation |
|---|---|---|
| **RTX 3090** (interactive) | Qwen3.5-9B-Q8, beellama -np4 | **Keep as-is** — already optimal |
| **GB10/forza** (deep/text) | Qwen3-Next-80B-A3B-**Thinking** | **Swap → Qwen3.6-35B-A3B** (FP8 now, NVFP4 later) |
| **GB10/forza** (vision) | Qwen3.6-27B-FP8 | **Keep** — relieved by the lighter deep model |
| **A4000** (RAG + STT) | infinity bge + faster-whisper | **Keep as-is** |

The one change that matters: the deep tier. Everything else is already right.

## Measured data

### Interactive — RTX 3090, Qwen3.5-9B-Q8 (beellama, -np 4, no DFlash)
- **TTFT 0.12 s** median · **decode 79.7 t/s** single · **173 t/s** aggregate @ N=4 (per-stream ~56 under load)
- Tool-calls: **easy 8/8 (100%)** native+clean · **hard 19/24 (79%)** (12 tools, negatives, argsynth)
- Structured JSON (think-off): **8/8 (100%)**, ~1 s
- Verdict: **optimal interactive model.** Sub-150 ms TTFT clears the voice budget; perfect JSON; perfect easy tool-calls; holds its own on hard tool-selection (≥ the 35B's 70%).

### Deep — forza GB10, Qwen3-Next-80B-A3B-Thinking-NVFP4 (vLLM, current)
- decode **39 t/s** single · 116 t/s @ N=4 (per-stream ~31)
- Tool-calls 100% **but 6–9 s each** (thinks before every call)
- JSON @ 4000-tok prod budget (think-on): **1/5 (20%), median 46.8 s** — rambles 1–2k tokens inline
- **Does NOT honor `enable_thinking:false`** → `research_extract` (configured think-off) pays the full thinking tax
- Verdict: **the problem.** A Thinking-only checkpoint can't be turned off, so the deliberation envelope (`extract_envelope` needs clean ```json or the *whole pass yields nothing*) is slow + unreliable.

### Deep candidate — forza GB10, Qwen3.6-35B-A3B-FP8 (vLLM, `--tool-call-parser qwen3_xml`)
- decode **51.8 t/s** single (**+33% vs the 80B**) · 110 t/s @ N=4 (per-stream ~34)
- **think-OFF**: TTFT 0.09 s · **JSON 6/6 (100%) @ 2.1 s** · **easy tools 8/8 (100%) @ 0.9 s** · hard tools 17/24 (70%)
- think-ON: 51.8 t/s; rambles on the adversarial "ONLY JSON" test (production deliberation prompt asks for think-then-fence, which is the supported pattern)
- Footprint: **FP8 ~35 GB** (loads on current vLLM); **NVFP4 ~22 GB** (blocked — see gotchas)
- Verdict: **the fix.** Same generation as 9B/27B (persona-consistent), hybrid-thinking → think-off gives the fast reliable structured output the 80B fails at, think-on available for real reasoning.

### Voice loop (warm)
STT 0.55 s (A4000 faster-whisper-large-v3-turbo) → 9B 0.12 s TTFT (3090) → TTS 0.38 s first-byte (forza Qwen3-TTS) ≈ **~1.25 s to first audible word**. Healthy. `STT_MODEL_TTL=-1` keep-warm already set.

## Per-GPU recommendation

### RTX 3090 — INTERACTIVE. **No change.**
`Qwen3.5-9B-Q8_0.gguf` on beellama, `-np 4`, no DFlash, ctx 65536/4 slots.
The 9B is the sweet spot: fast bandwidth (936 GB/s) runs a dense 9B at 80 t/s with
0.12 s TTFT, and it's 100% on JSON + easy tool-calls. The only dense 14B/32B are
year-old original-Qwen3 (likely *worse* at tools, generation gap); in-family
Qwen3.6-27B-dense is ~17 t/s — breaks the voice budget. Hard tool-selection (79%)
already matches the bigger 35B; the `consult_deep_model` escalation covers the tail.

### GB10/forza — DEEP/text. **Swap the 80B-Thinking → Qwen3.6-35B-A3B.**
- **Why:** +33% decode, same generation (persona-consistent), and the hybrid
  checkpoint fixes the structured-output failure that's the whole problem with the
  80B-Thinking (100% JSON @ 2.1 s vs 20% @ 28–56 s). It also makes `research_extract`'s
  configured think-off actually take effect.
- **Quant:** FP8 (35 GB) now — loads on the current vLLM, already faster+lighter than
  the 80B. Move to NVFP4 (22 GB, faster) once vLLM is bumped (current build's
  `qwen3_5.py` loader throws `KeyError: w2_input_scale` on the NVFP4 checkpoint).
- **CRITICAL:** `--tool-call-parser qwen3_xml`, NOT `hermes`. The 80B-Next uses
  hermes (JSON-in-`<tool_call>`); Qwen3.6 emits the XML `<function=…><parameter=…>`
  format. With the wrong parser tool-calls silently parse as 0% (model is fine; the
  parser isn't). Hearth's `_parse_tool_code_dialect` recovery does NOT match this
  exact shape, so the vLLM parser is the right fix.
- **think policy (Jasper's call):** recommend deep tier **think-OFF by default**
  (matches the SPARK_BRINGUP day-one finding + tonight's data — faster, 100% JSON),
  with **think-ON reserved for `deep_consult`** (the explicit deep-reasoning escalation).

### GB10/forza — VISION. **Keep Qwen3.6-27B-FP8 on :8096.**
The A3B MoEs are text-only; the 27B-dense is the VL model. The lighter deep model
frees ~11 GB (FP8) / ~24 GB (NVFP4), ending the **108/121 GB + swap** pressure that
made the two containers contend. Two operational notes:
- **Start the two forza vLLM containers SEQUENTIALLY** — simultaneous start
  dual-peak-allocs and OOM/thrashes the GB10 (hit this during benching).
- Optional follow-up: a smaller VL (Qwen2.5-VL-7B-FP8, ~8 GB, ~1 min boot vs ~5)
  frees ~30 GB — test Cordelia classification quality before committing.

### A4000 — RAG + STT. **No change.**
infinity (bge-large + bge-reranker-v2-m3) at :8091 + faster-whisper-large-v3-turbo
STT at :8093. Low-latency, local, healthy. ~5 GB headroom for a future small
fact-critic/judge model if ever wanted.

### Voice loop. **Keep the chain.**
STT (A4000) → 9B (3090) → TTS (forza) ≈ 1.25 s to first word. Watch-item: TTS shares
forza with the deep tier; the lighter 35B reduces decode contention that could spike
TTS latency mid-deliberation.

## Migration

### 1. `config/llm-roles.yaml` (boot-loaded → `docker compose restart hearth-orchestrator`)
For the deep/text roles — `specialist_deliberation`, `deep_consult`,
`research_extract`, `librarian`, `reflector`, `scribe_writer`, `concierge_drafter`,
`specialist_drafter`, `specialist_thinking`:
- `model: qwen3-next-80b-a3b-thinking` → `model: qwen36-35b-a3b`
- `think: false` on all **except** `deep_consult` (keep `think: true` for the escalation).
  (If deliberation is kept think-on per Jasper's call, leave `specialist_deliberation`
  think:true and verify the envelope fence lands.)
- `base_url`, `concurrent`, `max_concurrency` unchanged.

### 2. forza vLLM `:8090` container (raw `docker run` on forza, no compose)
Relaunch with (verified working tonight):
```
docker run -d --name vllm --gpus all --ipc=host -p 8090:8000 -v /home/jasper/models:/models \
  vllm/vllm-openai:cu130-nightly /models/Qwen3.6-35B-A3B-FP8 \
  --served-model-name qwen36-35b-a3b qwen3.6-27b qwen3-next-80b-a3b \
  --trust-remote-code --max-model-len 49152 --gpu-memory-utilization 0.45 \
  --max-num-seqs 4 --enable-auto-tool-choice --tool-call-parser qwen3_xml
```
(Keep the alias served-model-names so any stale references resolve. util 0.45 fits
FP8's 35 GB; raise if KV alloc complains.)

### 3. Verify
- `curl :8090/v1/models` → `qwen36-35b-a3b`
- a deliberation envelope (think-off) returns clean ```json
- a tool call returns native (qwen3_xml) not `<function=…>` in content
- `bun run smoke:llm-serializer`

### Rollback
The 80B-Thinking dir is still on disk; relaunch the old container cmd
(`/models/Qwen3-Next-80B-A3B-Thinking-NVFP4`, `--tool-call-parser hermes`) and revert
the llm-roles.yaml model ids. Clean revert.

## Open items
- **NVFP4 35B** (22 GB, faster than FP8) needs a vLLM bump that fixes the
  `qwen3_5.py` `w2_input_scale` loader — separate, low-risk-to-test on a temp port.
- **think-on vs think-off for deliberation** — Jasper's call; recommend off.
- **Smaller VL** for vision — test-then-decide.
