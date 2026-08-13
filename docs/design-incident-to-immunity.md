# Incident → Immunity: the staff permanently solves its own problems

**Status (2026-07-02): S4 + S1 SHIPPED + DEPLOYED** (PR #8 → main; the think
bench REFUTED the think-ON presumption — see the boxed verdict in "The model
question" below — and the Case Driver is ARMED LIVE behind
`HEARTH_CASE_DRIVER=1`). **S3 + S2 + the bench-derived multi-review follow-up
remain** (PLAN Tier 2). Original concept session (2026-07-01) with the owner:
"give Kate + the staff greater intelligence around self-improvement, recovery
from agentd and other research issues — to the point they identify, recognize
and solve issues *permanently*. Should Beatrice's coding and Kate's skeptic
runs be think-ON or 27B-based?"

---

## Honest gap analysis — where the loop actually breaks

Hearth already has more self-healing machinery than most production systems:
detection (hourly `scan_system_health` probes + audit error rates, the
guard-feedback spine, nightly Mariah scans, the eval gate), diagnosis
(`diagnose_dependency`, `diagnose_tool_failure` — grounded, scored, typed
fixes, apply-via-existing-gates-only), and remediation (circuit-broken
`restart_service`, the Firecrawl functional-probe + the workstation failover, the
full Beatrice change pipeline with merge recovery). **Detection and diagnosis
are not the gap.**

The loop breaks in three specific places:

1. **Nobody owns the middle.** An incident's path is a chain of hopeful
   handoffs: miss filed → Beatrice *hopefully* wakes and calls the right tool
   → fix *hopefully* filed → Kate *hopefully* reviews (documented failure:
   she stalls when several changes queue) → owner merges → someone
   *hopefully* runs `verify_fix_landed`. Every hop can silently park. The
   media_library twin sat `merge_failed` for two days; the regex-pattern
   sweep sat **uncommitted for nine days** while main carried the live bug.
   Each mechanism exists; no driver walks a case through them.

2. **Permanence is a human ritual, not a structural gate.** "Add a golden
   task for every incident worth fixing twice" is a the private dev log instruction to
   human sessions, not something the pipeline enforces or Beatrice does. The
   boot-time `ToolRegistry.lint()` regex warning existed and was *missed* —
   a `.regex()` re-entered the tree within a week; only the hard
   `smoke:tool-pattern-lint` gate made the fix permanent. That pattern
   (fix ships WITH its guard) is currently a happy accident, not a rule.

3. **Research/browse failures are second-class signals.** The `browser`
   dependency is registered **with no probe** — an idle-dead agentd is
   invisible until a browse fails mid-research (the silent-Firecrawl class,
   again). `guard_feedback` knows only `honesty` + `arg_mismatch`; a browse
   deferral storm, a search outage mid-investigation, or a
   thin-dossier-shipped-anyway never wakes Beatrice. The research runners
   fail open to degraded output by design — but nothing *files the debt*.

**Residual ceiling (name it honestly):** woken deliberation passes on the
small/deep tiers sometimes don't call the intended tool (documented
2026-06-10: two 62-token zero-tool envelopes). The fix that proved out is
DIRECTED passes with `require_tool_call` / `tool_choice:'required'`. Any new
driver must use directed passes, never "wake and hope."

---

## The concept, in one breath

```
SIGNAL → CASE (owned, resumable) → DIAGNOSE → FIX (gated pipeline)
       → VERIFY (re-run the failing probe/eval) → IMMUNIZE (guard ships with fix)
       → WATCH (recurrence window) → CLOSE (proven, not hoped)
```

Three pillars, all extensions of existing mechanisms — no parallel systems.

---

## Pillar 1 — The Case Driver (own every miss to proven closure)

NOT a new ledger. `process_misses` stays the single source of truth (one row
per evidence_ref, lifecycle guard, `advance` actions, `verify_fix_landed` —
all shipped). What's missing is a **deterministic driver** that walks open
misses on a cadence and executes the next step *itself* where the step is
mechanical, or fires a **directed** pass where it needs a model:

- **Mechanical steps run without an LLM:** a miss whose linked
  `beatrice_changes` row merged ≥N hours ago → the driver invokes
  `verify_fix_landed` (re-runs the owning scan / probe / eval) and closes or
  reopens on evidence. A miss with a scored diagnosis whose top fix is
  `restart` → route through the existing circuit-broken `restart_service`.
- **Model steps are DIRECTED, tools forced:** a miss with no diagnosis →
  `wake_deliberation_scoped(trainer)` with `tools_override:
  [diagnose_dependency|diagnose_tool_failure]` + `require_tool_call`. A
  change stuck `pending_kate_review` → a directed Kate pass naming the ONE
  change id (the documented fix for her clutter-stall).
- **Stall escalation, once:** a case idle past `HEARTH_CASE_STALL_DAYS`
  (default 3) escalates to the owner ONE time (a proposal card naming the
  stuck hop), then holds. No nagging; no silent parking.
- **Recurrence watch before close:** `verified` misses hold a
  `watch_until` (default 7d); the same evidence_ref recurring inside the
  window reopens WITH the history attached (the store already supports
  reopen — the driver adds the watch semantics).

Shape: a Kate background job (`drive_open_cases`, job-only like
`scan_system_health`) + pure functions in `src/core/case_driver.ts`. Kill
switch `HEARTH_CASE_DRIVER`. Meta-agents excluded as subjects (the
2026-06-09 meta-loop lesson). Every action audited; the driver never invents
a next step — it executes the typed `next_action` the diagnosis/scan already
produced.

## Pillar 2 — Immunity artifacts (a fix isn't done without its guard)

Make "solve permanently" structural, not aspirational:

- **The gate:** extend `run_checks` in the change pipeline — a change whose
  commit/record cites `pm_*` miss ids must ADD or TOUCH a regression guard:
  a golden task, a lint smoke (the `smoke:tool-pattern-lint` idiom), a
  `DependencyDef` probe, or an eval assertion. Same shape as the shipped
  test-first gate (tool file without a smoke → red). Red = no PR, with the
  guard-type menu in the error.
- **Auto-drafted golden tasks:** a guard-feedback recurrence already carries
  the failing turn (specialist, message, tool ledger, guard that fired).
  That IS a golden-task fixture. Beatrice's diagnostic pass gains a
  `draft_golden_task` tool that converts the captured failure into a
  replayable eval (deterministic assertions only, per the harness contract)
  and files it through her normal code pipeline. The nightly eval gate +
  the eval-health graduation gate then enforce permanence forever.
- **Closure requires green:** the Case Driver (Pillar 1) only closes a miss
  whose immunity artifact has passed at least once post-merge.

## Pillar 3 — Research & browse resilience as first-class citizens

- **agentd functional probe, sleep-aware.** The `browser` DependencyDef
  gains a `health_probe` that must NOT WoL the box hourly (it sleeps by
  design): when the workstation is awake (cheap `/health` on the copper NIC),
  probe agentd properly (spawn → `about:blank` → teardown, the
  `firecrawl_scrape_probe` idiom); when asleep, derive health from the last
  N `browse_url` audit outcomes + ONE scheduled daily wake-probe at a quiet
  hour. Remediation ladder for Beatrice: WoL → orphan-session reap (exists)
  → agentd restart via the proven ssh-relay pattern (forza `vllm-vision`
  precedent) → escalate.
- **New quality_signal classes:** `browse_failure` (defer storms, stale-lock
  loops, wedge-reaps), `research_degraded` (an investigation/commission
  slice that shipped thin because search/fetch was down — the runners
  currently know this and say nothing), `fetch_poisoning` (cached logged-out
  shells). Same edge-only, windowed, debounced guard-feedback spine —
  recurrence files the miss + wakes Beatrice with a browse evidence pack
  (agentd `/status`, session list, last N browse audit rows) via a new
  entry in the diagnosis registry, not a new tool shape.
- **Runners file their own debt:** a deep-research / commission slice that
  degrades past a threshold (>50% fetch failures, search outage) emits the
  signal instead of silently emitting a skeleton dossier. The dossier still
  ships (fail-open stands); the debt gets a case.

---

## The model question: think-ON, not 27B

> **⚠ BENCH VERDICT (2026-07-02) — the think-ON half of this section is
> REFUTED.** The owner's directive was validate-don't-presume, and the
> validation said no: on the live 35B (`scripts/bench-think-scrutiny.ts`,
> 11 scrutiny tasks × 3 samples × both conditions, deterministic scoring,
> the exact production transport), think-OFF scored **31/33 at ~1s/task**
> vs think-ON's **30/33 at ~14s/task and 22× the output tokens** — no
> accuracy gain, large cost. What SHIPPED instead: the per-pass `think`
> CAPABILITY (fire_deliberation `think` field, TriggerContext.think, and
> the two-way `think_in_deliberation` YAML fix — the `true` branch had
> been silently dead since the 2026-06-07 35B swap) with the
> `HEARTH_SCRUTINY_THINK` default **left OFF**. The productive reading of
> the numbers: at ~1s per think-OFF review, **multiple independent review
> passes** are the cheaper scrutiny multiplier (three independent reviews
> cost less than one thinking pass) — that is the follow-up mechanism for
> "multiple reviews of heavy scrutiny." The no-27B half below stands.

**Original recommendation (pre-bench, kept for the record): flip think-ON
on the existing 35B for exactly two surfaces — Beatrice's authoring passes
and Kate's skeptic/review verdicts. Do not stand up a 27B text tier.**

Why not the 27B: it lost the deep slot on the merits
(config/llm-roles.yaml documents the bench — dense 27B decoded ~8 tok/s on
the GB10 era hardware; the sparse 35B-A3B is both faster AND stronger at
reasoning), and today's 27B deployment is the *vision* model. A third text
model on the Ada 48GB has no free VRAM slot next to the 35B.

Why think-ON is nearly free: llama.cpp on `:8200` honors thinking
**per-request** (`chat_template_kwargs:{enable_thinking:...}` — exactly what
openai.ts sends), and the dormant `specialist_thinking` role (think:true,
preserve_thinking, same endpoint) already exists. The runtime already has
`think_override` on `SpecialistTurnInput`. The build is: thread a think-on
flag through (a) Beatrice's directed-build / workbench channels, (b) Kate's
`review_change` directed passes, likely as a per-surface field the
fire_deliberation body accepts. Both surfaces are background/latency-tolerant
and tool-call-shaped (grammar-constrained via `--jinja`), which bounds the
known think-ON risk (envelope-JSON rambling — the reason deliberation
defaults think-OFF at 100% clean envelopes).

Keep think-OFF deliberately where grounding discipline depends on it:
`research_extract`, the diagnosis evidence-pack calls, the brief envelope.

**Prove it, don't vibe it:** golden tasks for one review verdict and one
authoring pass, run think-off vs think-on before flipping the default
(the eval harness exists for exactly this).

> ~~Optional follow-on: bench Qwable-35B (the Claude-distilled fine-tune
> already showed a reasoning-efficiency edge) as the deep checkpoint.~~
> **Retired 2026-07-30 — the weights are gone.** `Qwable-v1.Q8_0.gguf`
> (35 GB) and `Qwable-9B-Claude-Fable-5.Q8_0.gguf` (8.9 GB) were deleted
> from `/docker/models` in the disk sweep, on the owner's call after being
> shown that they were the only copies. No adapter, checkpoint or merge
> script survives anywhere on the LLM host, so this is not a re-download —
> reviving the idea means redoing the distillation. Receipt:
> `/docker/models/DELETED-2026-07-30-qwable-inventory.txt`. The think-off
> vs think-on work above is unaffected and still stands on its own.

---

## Slices (each dark, flagged, smoked, independently shippable)

| Slice | What | Effort | Kill switch |
|---|---|---|---|
| S1 | Case Driver: mechanical advance + directed passes + stall-once + recurrence watch | ~2–3d | `HEARTH_CASE_DRIVER` |
| S2 | Immunity gate in `run_checks` + `draft_golden_task` from captured failures | ~2–3d | gate flag + tool cap |
| S3 | agentd sleep-aware probe + browse/research signal classes + browse evidence pack | ~1–2d | per-class flags |
| S4 | think-ON plumbing for Beatrice-authoring + Kate-review + the A/B eval | ~0.5–1d | per-surface config |

Order: S4 first (cheapest, raises the IQ of every other slice's model steps),
then S1 (the loop-owner), S3, S2.

## Out of scope (named, not built)

Auto-merge of Beatrice's code (the owner-merge + PIN floor is permanent);
any new apply surface (every fix still routes through `EXISTING_GATES`);
remote/cloud models; a new incident store (process_misses IS the ledger).
