# Hearth 2.0 — target architecture + migration plan

> **Status: DESIGN APPROVED — §8 DECIDED (Jasper, 2026-07-06).** All four
> recommendations accepted: in-repo strangler via Bun workspaces; Phase 0
> (deletion + flag collapse) first; signals + reconciliation sweeps; web client
> frozen on stable contracts and deferred post-2.0. Nothing is built yet; P0
> gets its own build session. Companion PLAN.md entry: Tier 3 "Hearth 2.0 —
> the strangler refactor".
>
> Jasper's ask, near-verbatim: *"define a refactor of the ENTIRETY of Hearth into
> a new 2.0 project/git structure — remove redundancy and unnecessary cruft; more
> LLM accuracy and more LIVE ownership of items (event-driven) as opposed to
> scheduled deliberations. We crawled, now we're walking, but need to quickly get
> to running."*

Every number in this doc was measured on the tree at `main` (2026-07-06) or the
live box, not quoted from docs. Where a "this is redundant" folk-claim turned
out to be WRONG on inspection, that's recorded too — several did.

---

## 0. The verdict up front (limiting factors first)

1. **The migration itself is the biggest risk, not the current architecture.**
   The household depends on this system 24/7 — voice, emergency alerts, mail
   triage, presence, the morning brief. Hearth 1.x is cruft-heavy but it *works*,
   and ~200 documented gotchas in the private dev log are scar tissue a rewrite would
   shed and then re-learn in production, on the family. Every phase below is
   judged by "the household never notices a phase boundary."

2. **A repo reorg does not, by itself, make the LLM more accurate.** The single
   biggest accuracy lever already shipped: all interactive roles moved off the
   9B onto the 35B with grammar-constrained tool decoding (llama.cpp `--jinja`,
   2026-06-24), and the 9B tier is now idle. What's LEFT on accuracy is
   architectural but smaller: scoped context (a woken pass with 3K of relevant
   context beats a 22K standing envelope), declared per-surface contracts
   instead of ad-hoc guard accretion, eval coverage as a merge gate, and a
   smaller/cleaner tool surface. Those are real, and the event inversion buys
   the first one — but nobody should expect a step-change from moving files.

3. **Event-inversion is bounded by signal availability.** You can only be
   event-driven where an edge signal exists. Mail has IMAP IDLE; calendar has
   the iOS snapshot POST; presence has sensor packets. But a *missing* bill has
   no event (absence is defined by a clock), external APIs without webhooks
   (council meetings, assessor rolls, market data) are inherently polled, and
   date-driven edges (birthday−14d) are clocks by nature. The honest inversion
   converts roughly **half** of Kate's 21-job train, not all of it. The rest
   gets demoted to *declared* reconciliation sweeps rather than pretending to
   be live.

4. **This is a multi-week arc.** Honest total: **26–41 working sessions over
   2–3 months**, run alongside feature work (the strangler makes that possible;
   a big-bang would freeze features for the duration). No weekend-spike framing.

**Recommendations (blunt):** strangler migration **in the same repo** via Bun
workspaces, not a new repo (§5); **deletion + flag collapse first** (cheapest
real win, zero structural risk); SignalBus + ownership registry as the 2.0
spine (§3); accuracy consolidated into per-surface contracts + an eval CI gate
(§4); the conversation runtime (`specialist_runtime.ts`, 5,659 lines) moves
**last** (§6).

---

## 1. The measured state (2026-07-06)

| Metric | Value |
|---|---|
| Total TypeScript LOC (src + apps + scripts) | **243,981** |
| `src/core/` | 160 files / 58,330 LOC — **91% flat** (146 files at top level) |
| `src/specialists/` | 233 files / 54,708 LOC (kate 11.2K, trainer 8.9K) |
| `src/app/client/` (vanilla-JS web UI) | 45 files / **80,597 LOC** (⅓ of the repo) |
| `src/memory/stores/` | 44 stores / 18,101 LOC; **28 re-implement the same CREATE TABLE boilerplate** |
| Files > 2,000 lines | 5 — `specialist_runtime.ts` 5,659; `specialist_pane.ts` 4,406; `memory/client.ts` 3,381; `kristi_workstations.ts` 3,185; `routes/specialists.ts` 2,850 |
| Registered tools (live `/status`) | **309** specialist + 5 scribe + 3 concierge (the private dev log still says "~270") |
| Distinct `HEARTH_*` env vars in code | **366** (97 boolean gates + 269 tunables) |
| Dark-launch flags now permanently armed in prod | **54 of 54** default-off gates set `=1` in hearth.env |
| Clock-driven passes per day | **~76–85** (22 deliberation slots + ~55 background jobs + 4 hourly ticks) |
| Kate alone | 21 background jobs + 4 deliberation slots = 25 clock passes/day |
| Named event-driven drivers | ~12 (ReactiveInbox, ReactiveTrigger, GuardFeedback, LiveSynthesis, MailShelf, HouseholdKnowledge, PersonObserver, CalendarSource, CaseDriver, EpisodicAlert, user-model observers, LiveThrottle) |
| Smoke scripts | **195** (of 263 package.json scripts); unit tests: **0**; CI: **none** (pre-commit runs guard:time+encoding only) |
| Golden eval tasks | 16, nightly only — nothing blocks a merge on regression |
| Specialist YAML | 9,638 lines / 14 files (kate.yaml 1,738) |
| Scheduler app (live box) | near-dormant: 63 failed / 2 fired / 3 pending rows |
| Orientation docs | the private dev log 5,087 + architecture.md 5,700 + PLAN.md 2,937 + 26K lines under docs/ |

The last row is a symptom worth naming: **the private dev log is 5,000 lines because the
structure doesn't communicate itself.** A 160-file flat directory with six
coexisting tool-surface mechanisms needs a book; a package layout with declared
contracts needs a chapter.

---

## 2. The three buckets

### 2.1 Load-bearing (the spines — 2.0 keeps every one)

| Spine | What it is | Why it stays |
|---|---|---|
| **Data** | MemoryClient → vault (markdown, source of truth) → ingestor → SQLite projection; retrieval (FTS+vector+rerank) | The vault IS the user's data. The projection pattern (note = truth, table = index) is correct and battle-tested. |
| **Dispatch** | ToolRegistry + capability tokens + the arg-recovery layers (enum trim, scalar_recovery, `_recover_tool_args`) + recovery-hint affordances | This is LAW #1 made mechanical: the model decides, the registry makes calls survivable. |
| **Conversation** | The single `turn_streaming` body + the 12-step finalize guard cascade + intent forcing + tool-result compaction | One turn body was hard-won (2026-06-19); the cascade is the honesty layer the household actually relies on. |
| **Governance** | proposals + court + trust XP/teeth + policy gateway + approvals + precedent + the permission floor | draft→tap→PIN is the trust contract with the family. Untouchable. |
| **Reactive** | AppEventBus + the driver pattern (subscribe, gated, fail-open, debounced) + `wake_deliberation_scoped` | This is the *seed* of 2.0 — it generalizes into the SignalBus (§3). |
| **Verification** | eval harness + golden tasks + the 195 smokes + guard scripts + the four Beatrice change-pipeline gates | 2.0's job is to promote this from "nightly + on-demand" to a merge gate, not to replace it. |
| **Invariants** | cordon (`note_visible_to_caller`), audit hash-chain, `time.ts`, idempotency-from-inputs, fail-open/fail-closed discipline | §7 — the crown jewels. The refactor exists to make these *more* enforceable. |

### 2.2 Redundant / superseded — verified verdicts

Each candidate was inspected, not assumed. **Refuted claims are listed too.**

**Confirmed dead / delete in Phase 0:**

| Item | Evidence |
|---|---|
| Pipecat SDP proxy half of `src/app/routes/voice.ts` + `HEARTH_PIPECAT_URL` | Route still mounted (server.ts:1147) but proxies to the pipecat container retired 2026-06-08 (compose profile `["retired"]`). Dead-in-practice. ⚠ The SAME file carries the **live** `/api/voice/tts` + `/api/voice/emotion` routes (Kate's real voice; face.js calls them) — split the file, delete the proxy, keep tts/emotion. |
| Orphaned fold-in remnants: `src/specialists/awareness/{anya,iris,marguerite}.ts`, `src/specialists/luna/tools/update_luna_vault.ts`, `src/specialists/iris/tools/*` | server.ts:99 comments the awareness handlers "retired with the 2026-07-04 fold-in… the loop never fired them." No live imports found for the luna/iris tools. **Exception:** `marguerite/gedcom_parser.ts` IS live (imported by `src/inbox/converters/gedcom.ts`) and `anya/intake/intake_pet_record.ts` IS live (imported by Kate's intake dispatcher) — move both to their consumers' homes, delete the rest. |
| Telegram schema scaffolding | `users.ts:51` fields, the `'telegram'` MessageSurface enum value, `ts_last_telegram_message` column, push.ts comments. Inert since the 2026-06-14 Hermes removal. Dies at the 2.0 schema boundary (historical rows keep the raw column; new code stops carrying the enum). |
| `ops/systemd/llamacpp-live-glacier.service` + pre-consolidation `hearth-*.service` units | The :8089 tier was decommissioned 2026-06-04; deployment is Docker. Reference-only rot. |
| `ops/vl/` docs | The standalone VL server story; vision rides forza :8096 via `for_role('vision')`. Historical. |
| One-shot migration scripts (~8: `backfill-*`, `import-next-to-scrum`, `quarantine-library-trash`, …) | Applied; no live trigger. Archive to `scripts/archive/`. |
| `NEXT.md` (463 lines) | Frozen 2026-06-05, superseded by the scrum board. Move to docs/archive/. |
| `apps/scheduler` (the third process) | Near-dormant on the box (63 failed / 3 pending). Its one live consumer is the nightly-eval seed. Fold that into the background-job mechanism and retire a whole process + its systemd/compose surface. |
| Concierge brief route + agent | Its scheduled_tasks consumers failed/expired on the box; Kate's deliberation briefs are the product. Scribe's 5 tools are **live** (cross-registered to Kate + /scribe routes) — they migrate into the registry proper; the fixed-persona agent layer retires. |
| `HEARTH_PROVENANCE_GUARD` + the unwired `enforce_provenance`/`redact_ungrounded` redaction paths | Off since 2026-05-31; fact_critic is the mechanism. Keep the regex *extractor* (it's the citation guard's candidate generator); delete the dead redaction surface. |
| The 54 armed dark-launch flags | All permanently `=1` in prod. Collapse: delete the checks, make the behavior unconditional. Keep only genuine kill switches (§4.4). |

**Claims REFUTED on inspection (do not delete):**

| Folk claim | Reality |
|---|---|
| "listening.ts (MusicKit) is deprecated cruft" | Already deleted. Cleanup culture worked; nothing to do. |
| "Uppercase CLAUDE.md/ARCHITECTURE.md twins duplicate the lowercase" | Git tracks only the lowercase pair. (A case-insensitive macOS checkout makes them *look* like four files.) Already resolved. |
| "Mariah's scan suite is subsumed by guard-feedback/case-driver/evals" | Complementary, not superseded: the scans are the slow-drip *behavioral-quality* layer (authenticity, drift, affordance audits); guard feedback is the instant edge layer reading the same rows. 2.0 unifies them behind one signal spine (§3) but the detection logic survives. |
| "`_curate_tools_for_turn` is the pre-dynamic-tools legacy path" | It's the live fail-open substrate dynamic-tools *refines*, and the ranking prior. Not dead — but it IS one of **six** coexisting tool-surface mechanisms (base toolset, tools_for_chat, tools_for_voice, tools_for_deliberation, dynamic_tools, directed `tools_override`), which is the §4.3 consolidation target. |
| "deliberation_fixtures.ts is retired-test residue" | Live TEST_MODE seam; the proactive smoke depends on it. Keep. |

### 2.3 Cruft-by-accretion (structural, not deletable — the refactor target)

- **The flat core.** 146 top-level files in `src/core/` with no expressed
  layering — `time.ts` (pure) sits next to `specialist_runtime.ts` (everything).
  Import discipline is convention-only; nothing stops a leaf importing the world.
- **The god files.** 5,659-line runtime, 4,406-line server-side pane composer,
  3,381-line MemoryClient facade, 2,850-line specialists route file. Each is a
  merge-conflict magnet and the reason concurrent sessions collide.
- **44 stores × copy-pasted boilerplate.** 28 self-contained stores each
  re-implement CREATE TABLE / additive columns / sigil binds / cordon stamping.
  The cordon is a *convention* repeated 28 times — one missed `private_to`
  filter is a leak. (§7 makes it a type.)
- **366 env vars.** 97 booleans + 269 tunables, 125 set in prod. Every flag is
  a config state the docs must explain and a code path the smokes must cover
  twice.
- **The YAML/code blur.** kate.yaml is 1,738 lines because persona prose,
  job wiring, tool lists, and addenda essays all live in one hot-reloaded file.
  Wiring belongs in typed code; voice belongs in YAML.
- **195 smokes, zero unit tests, no CI.** The smokes are excellent integration
  proof but nothing runs them automatically, and pure functions (scorers,
  detectors, edge math) are tested only through their smokes.

---

## 3. The paradigm shift: LIVE ownership over scheduled deliberation

### 3.1 Today's shape, measured

~76–85 clock passes/day vs ~12 event drivers. Kate's morning is a batch window:
03:00 style distill → 03:20/03:25 research sweeps → 03:30 user models → 03:45
person facts + iMessage distill → 03:50 life events → 04:00 dossiers → 04:10
Kate's read → 04:40 services → 04:50 precedent → 05:30 reflection → then the
08:15/08:20/08:25/08:30/08:35 probe train → 09:05 case driver, plus hourly
`*:10` health and `*:15` style ticks. Most of these jobs are **edge detectors
running on a clock**: they scan a store for "did something change since my
cursor," which is exactly what an event subscription does — except the signal
already exists in-process for many of them (the mail driver *emits* on ingest;
the calendar source *diffs* on snapshot POST) and the job re-derives it hours
later.

The cost is not compute (the boxes idle through it). The cost is:
- **Latency of ownership** — a life-event observation lands at 19:40; the offer
  fires at 03:50. Live ownership is Jasper's explicit ask.
- **Accuracy** — a scheduled envelope pass carries a standing prelude + the
  whole ledger (the Kristi 45K-token 400 was this class). A scoped wake carries
  one signal and a narrow tool surface. Smaller, fresher context is the
  highest-leverage prompt-quality lever left (§4).
- **Comprehensibility** — 40+ distinct HH:MM slots is a schedule nobody can
  hold in their head; "who owns signal X" is currently answered by grep.

### 3.2 The 2.0 spine: signal → owner → action

One first-class **SignalBus** (the AppEventBus generalized, in
`packages/signals`), with three rules:

1. **Every signal source emits a TYPED signal.** Mail ingest, calendar snapshot
   diff, location flip, presence edge, capture routed, guard catch, health
   probe edge, proposal decided, observation recorded, vault note projected.
   The existing AppEvent union is the seed; it grows a schema per signal
   (Zod-validated at emit, same discipline as tool boundaries).

2. **Every signal has exactly ONE declared owner.** A `SignalOwnership`
   registry — declarative, inspectable at `/signals` (signal type → owning
   handler → last-handled → outcome) — replaces "which of the 12 drivers and
   55 jobs touches this?" Ownership is a routing fact, not a grep result.
   A handler does one of: deterministic action (the LiveThrottle shape),
   file-a-proposal (the probe shape), or `wake_scoped(owner_specialist,
   signal)` for judgment calls (the deep-tier scoped pass, existing mechanics).

3. **The handler is a function of the signal, not of the clock.** Each
   edge-detection lives ONCE, callable from two entry points: the live
   subscription (event arrives → handle now) and a **reconciliation sweep**
   (windowed re-scan → replay missed signals through the SAME handler).
   Sweeps exist because events get dropped (restart mid-burst, a down driver,
   a source that only polls); they are the safety net, demoted from "the
   mechanism" to "the backstop," and they share 100% of the handler code, so
   event-vs-sweep can never behave differently. This is the single biggest
   dedup in 2.0: today `calendar_followups` (cron) and `CalendarSource`
   (event) are separate implementations of "calendar changed."

**LAW #1 guardrail, stated now:** the inversion must not become pre-injection.
A scoped wake hands the model *the signal and its tools* — never a pre-baked
answer. Deterministic handlers are legitimate exactly where today's drivers
are (fixed transforms, filing, fan-out); anything requiring judgment spends a
scoped LLM pass that decides and calls tools itself.

### 3.3 The honest clock/event split (per today's job inventory)

**Converts to signal ownership (~8–12 jobs):**

| Today's cron job | The signal that already exists |
|---|---|
| calendar_followups 08:20, meeting_prep 08:30, cross_signals 08:25 | calendar snapshot diff (CalendarSource already computes it) + a `days_until` timer-signal (below) |
| good_followups 08:15 | `order_upserted` (already emitted by mail ingest) |
| life_event_offers 03:50 | `person_observation_recorded` (observers already write the row) |
| sweep_person_facts / synthesize_dossiers dirty-gates | same — the dirty-cursor IS an event edge, evaluated nightly today |
| Ruby's hourly council scan | already edge-shaped (RevisionID diff) — becomes a poller-source emitting a signal, decoupling detection from ownership |
| Kristi's ~15 staggered inventory scans | price/stock deltas from her fetchers → signals; the stagger was only queue management |
| guard/health escalations | already event-driven; they just join the same bus |

**Stays on the clock, and *declared* as such (cadence IS the product):**

- Kate's four briefs (07:00/12:30/18:00/22:00) — a brief is a scheduled digest by definition.
- Court convenings (3×/day) — batched adjudication is the design, not a limitation.
- Nightly distills/decay/prune (style, dossiers, shelf synthesis, precedent index) — batch consolidation over a day's accumulation; running them per-event would burn deep-tier slots for no user-visible gain.
- Reconciliation sweeps (the demoted backstops) + hourly health probe (a probe is a poll by nature).
- **Absence edges**: expected_bills (a missing bill has no event), lapse detection, "haven't heard from X" — absence is only definable against a clock. 2.0 gives these a first-class **timer-signal** source (`at(t, key)` / `days_until(date, n, key)` — the scheduler's good idea, typed and deduped), so even clock-born edges flow through the same ownership registry.
- External polls without webhooks: assessor roll, market data, feeds. The poller becomes a *source* that emits diffs; ownership of the diff is still signal-shaped.

Net effect on Kate: 21 background jobs → **~8 clock jobs + ~10 signal
ownerships**, with every ownership visible on `/signals`. Passes/day roughly
halve; latency-to-ownership for the converted class drops from hours to
seconds; and each converted pass runs on scoped context instead of the
standing envelope.

---

## 4. LLM accuracy as an architectural layer

### 4.1 What exists (inventory), and the honest gap map

Today's machinery, all live: the 12-step finalize cascade (ghost-promise,
intent-miss, save-honesty, fabricated-save regex + semantic, fabricated-action,
read-failure, data-denial, citation, provenance [off], fact-critic, synthesis
nudge) + brief_critic at the envelope + proposal_critic at filing +
capture_quality at ingest + the tool-arg recovery stack + intent forcing
(3 groups) + grammar-constrained decoding on :8200 + evidence shaping
(citations, exemplars, RAG gates, complexity route) + 16 golden tasks nightly.

The gaps, honestly:
- **Coverage is per-surface accidental, not declared.** Chat gets everything;
  voice gets almost nothing post-hoc (by design — it streams to TTS with 0
  re-rolls — but the *compensating* controls, round-0 forcing + grammar, are
  implicit, discoverable only by reading the runtime); deliberation gets
  envelope-level checks; background LLM calls (distills, judges) each hand-roll
  their own fail-open/grounding discipline.
- **Nothing gates a merge.** A change that regresses a golden is discovered at
  03:15 the next morning as a process_miss. The Beatrice pipeline runs
  tsc+guard pre-PR; humans run smokes by hand.
- **309 tools** and six surface-selection mechanisms tax every prompt and every
  small-model decision.

### 4.2 The 2.0 mechanism: the declared SurfaceContract

One type, one registry, enforced by the runtime:

```ts
interface SurfaceContract {
  surface: 'chat' | 'voice' | 'deliberation' | 'scoped_wake' | 'background_llm';
  grounding: GroundingSource[];      // what evidence the turn may see
  guards: GuardSpec[];               // ordered; each with reroll budget
  decoding: { grammar: boolean; think: boolean; max_tokens: number };
  tool_surface: 'dynamic' | 'curated' | 'narrow';   // ONE mechanism per surface (§4.3)
  failure_mode: 'fail_open' | 'fail_closed';        // per LAW-of-the-class (§7)
  eval_tags: string[];               // golden tasks that MUST exist for this surface
}
```

This is not new behavior — it's the existing behavior made *declarative*, so:
(a) adding guard #13 is a registry entry, not a 330-line copy-paste (the
2026-06-19 unification finished half of this); (b) voice's contract becomes
explicit — "no post-hoc re-rolls; compensated by grammar + round-0 forcing +
audit-only post-checks" — instead of a the private dev log paragraph; (c) a **coverage
assertion** runs in CI: every surface must map to ≥N golden tasks, and a guard
with no eval exercising it is a build warning. The eval harness already
supports `voice:` and `conversation_history` task shapes; the contract makes
the mapping mechanical.

### 4.3 Fewer, larger tool surfaces

309 tools is a discovery problem for the model and a prompt-budget problem for
every surface. 2.0 direction (per the standing all-encompassing-tools
feedback): **one comprehensive tool per domain concept** with named slots —
`record_person_pref`/`manage_household_services` are the proven shape. Target:
**~120–150 registered tools** (not a hard number; driven by audit-log usage
mining — Beatrice's `audit_connector_affordances` already has the data).
Honest counterweight, from scars: consolidation must not recreate the
**deep-schema garble** class (`propose_action`'s nested unions). The pattern
that works is flat contracts + a `kind` enum + optional named slots, never
discriminated-union nesting. Consolidation is *measured* work — each merge
rides golden tasks proving the small... the 35B still emits the calls natively.

Also collapse the six surface-selection mechanisms to **two**: `dynamic`
(catalog + RAG-ranked hot set — today's dynamic_tools, kept) and `curated`
(explicit list for voice/deliberation/narrow wakes). The base-toolset union and
per-turn overrides become contract fields, not parallel code paths.

### 4.4 The model fleet answer

The 9B is **already idle** (all interactive roles ride the 35B @ :8200 since
2026-06-23). 2.0 deletes the tier from llm-roles.yaml and the docs rather than
carrying a dormant path. Everything text rides the 35B (grammar-constrained,
think-off default); deep/think stays the same box; vision stays forza :8096;
the 1.5B status-flavor CPU toy stays (cosmetic, isolated). No new models are
required for 2.0 — that keeps the accuracy story honest: **contract + context
discipline, not fleet churn.**

### 4.5 Eval gate as CI (the S2 immunity idea, generalized)

Two rings:
- **Per-merge (deterministic, minutes):** tsc, guards, the self-contained smoke
  subset (no live model, no network — most of the 195 qualify), and the
  scripted-model golden tasks. Runs as a Gitea Actions job (or, pragmatically,
  as a required step in Beatrice's `run_checks` + a `git push` hook for human
  sessions — the pipeline chokepoint already exists at `open_change_pr`).
  A regression **blocks the merge** instead of filing a morning miss.
- **Nightly (live-model):** the full golden set against the real 35B, exactly
  today's mechanism, still feeding graduation gating and process misses.

Flag hygiene folds in here: **366 → target <60 env vars.** Keep genuine kill
switches (safety-critical subsystems, expensive externals: ~15 booleans) +
genuinely-tuned numerics; everything else either graduates (checks deleted) or
moves to one typed, hot-reloaded `config/hearth.yaml` with a Zod schema. Every
surviving flag must name its owner and its "when would you flip this."

---

## 5. Structure: in-place strangler, not a new repo

### 5.1 Verdict

**Bun workspaces inside the existing repo; `packages/*` grow while `src/*`
shrinks; every phase ships through the existing PR → smoke → deploy gates.**
"New git structure" is satisfied by the workspace layout + `git mv` (history
preserved), not by a new origin.

Why not a fresh repo (the failure modes, named):
- **The two-systems trap.** 1.x must keep taking fixes (household is live).
  Every fix then lands twice or diverges. Historical base rate for parallel
  rewrites of live systems while the old one evolves is dismal, and this system
  changes *daily*.
- **It breaks the autonomy loop.** Beatrice's change pipeline, the Code Shop,
  the merge-recovery ladder, the bind-mount deploy, both remotes, the ops-relay
  allowlists — all are wired to THIS repo's paths and remotes. A new repo
  suspends the self-modification story mid-migration, exactly when we're
  touching the most code.
- **The "clean slate freedom" is illusory.** The contracts a new repo would
  free us to break — HTTP routes, vault layout, hearth.db schema, SSE events —
  are precisely the ones that CANNOT break (iOS, macOS, the voice coordinator,
  the HA shim, the web client all consume them). The stable seam is the reason
  strangler works at all.
- Scar-tissue loss: 195 smokes and the gotcha ledger assume this tree. Ports
  lose fidelity silently.

### 5.2 Target workspace layout

```
hearth/
├── packages/
│   ├── kernel/      # pure, zero-I/O: types, time, ids, cordon types, audit-chain
│   │                #   primitives, semaphore, zod helpers, scalar recovery
│   ├── memory/      # vault client, defineStore framework, projection, retrieval
│   ├── llm/         # providers, router/serializer, constrained decoding, embeddings
│   ├── signals/     # SignalBus, typed signals, ownership registry, timer-signals,
│   │                #   reconciliation-sweep runner, all drivers
│   ├── runtime/     # turn body, SurfaceContracts, guard pipeline, tool registry,
│   │                #   capabilities, dynamic tool surface
│   ├── governance/  # proposals, court, trust, gateway, approvals, precedent
│   ├── agents/      # specialist definitions: persona YAML + typed wiring co-located
│   ├── surfaces/    # HTTP app, routes, SSE, voice endpoints, pane composition
│   └── evals/       # golden tasks, harness, smoke framework, coverage assertion
├── apps/
│   ├── orchestrator/  # thin composition root (wiring only)
│   └── ingestor/
├── src/             # ← shrinks to zero over the arc; re-export shims keep old
│                    #   import paths compiling until their last consumer moves
└── config/          # personas (YAML, prose only) + hearth.yaml (typed tunables)
```

Import direction is enforced (kernel ← memory/llm ← signals/runtime ←
governance/agents ← surfaces) by a lint the pre-merge ring runs — the layering
becomes a build error, not a convention.

### 5.3 The data story (the fixed points)

**The vault and hearth.db do not migrate. They are the ground the strangler
walks on.** The vault is user data (markdown, Obsidian-owned); the SQLite
schema evolves only by the existing additive rules (IF NOT EXISTS, additive
columns, SCHEMA_VERSION for incompatibles). The HTTP/SSE contracts freeze for
the duration of the arc (additive-only). Anything 2.0 wants to rename in the
schema waits for a deliberate, single migration at the END of the arc — or
never happens, because renames buy nothing the household can feel. The audit
hash-chain is append-only across the whole arc; `log_action` stays the sole
writer throughout.

Beatrice's pipeline stays live the whole time: her path allowlist gains
`packages/**` in Phase 1, and the check gate (tsc over the workspace) covers
the new layout automatically since the root tsconfig type-checks the project.

---

## 6. The migration plan

Every phase: shippable behind the existing gates, reversible by revert,
household-invisible. Estimates are honest working-session counts (a session ≈
one focused Claude block), and they will be wrong in the familiar direction —
treat the high end as real.

### Phase 0 — Deletion pass + flag collapse (2–3 sessions, zero structural risk)

> **Tranche 1 (the deletion pass) SHIPPED 2026-07-06** — see the
> [ship log](archive/shipped-2026-07.md). Build-time corrections to this
> design, recorded honestly: the scheduler was NOT retired but folded
> in-process (it turned out load-bearing for `promise_followup` delivery —
> and its eval seeding was 2 days from running dry, now self-reseeding);
> the "fold-in orphans" were mostly LIVE Kate tools (re-homed, not
> deleted); the Telegram scaffolding is deferred to the schema boundary
> (strict UserConfigSchema + the box's hand-edited users.yaml make it a
> boot-loop risk today). Tranche 2 = the flag collapse.
The §2.2 confirmed-dead list: pipecat proxy split-and-delete, fold-in orphans
(gedcom parser + pet intake relocated first), Telegram scaffolding, stale ops
units/docs, NEXT.md + one-shot scripts archived, scheduler app folded into
background jobs (migrate the 3 pending rows; the eval seed becomes a job),
Concierge retired (Scribe tools re-homed to the registry). Then the flag
collapse: the 54 armed dark-launch gates go unconditional; dead tunables
pruned; survivors documented in one place. **Deliverable:** a `-15–20K LOC`
diff, ~300 fewer flag sites, one fewer process on the box, all smokes green.
Reversible: pure revert.

### Phase 1 — Workspace scaffold + kernel (3–4 sessions)
Bun workspaces config; `packages/kernel` extracted from the pure leaves
(time, ids, privacy/cordon types, audit_chain, semaphore, scalar_recovery,
capabilities tokens). Old paths keep working via re-export shims — behavior
byte-identical, proven by the smoke suite. Adds the import-direction lint +
the per-merge deterministic CI ring (§4.5) so every later phase lands gated.

### Phase 2 — `defineStore` + memory package (5–8 sessions)
The one store framework (DDL, additive columns, sigil binds, idempotent
upserts, **cordon-in-the-type** — §7). Migrate the 44 stores in batches; each
batch is mechanical + smoke-proven. This is well-shaped directed-Beatrice work
(bounded, patterned, checkable) — the migration can partially run through her
pipeline as live practice. MemoryClient's 3,381-line facade splits along
store lines as stores move.

### Phase 3 — SignalBus + ownership registry (4–6 sessions)
`packages/signals`: typed signal schemas over the existing AppEvent union,
the ownership registry, the `/signals` introspection route, timer-signals,
the reconciliation-sweep runner. Existing drivers move in **unchanged in
behavior** (same debounce/fail-open/kill-switch contracts). No job converts
yet — this phase is pure substrate, so the diff risk stays in plumbing.

### Phase 4 — The cron inversion (6–10 sessions, the paradigm payoff)
Convert the §3.3 list one job at a time: define the edge as a signal handler,
wire the live subscription, demote the cron job to the reconciliation sweep
calling the same handler, run BOTH for a soak window (the sweep should find
nothing the subscription didn't already handle — that's the proof), then
retire the redundant slot. Kate's train shrinks 21 → ~8 clock jobs. Each
conversion is its own PR with its own soak. This phase produces the visible
product change: minutes-latency ownership.

### Phase 5 — Runtime split + SurfaceContracts (6–10 sessions, highest risk, LAST)
Carve `specialist_runtime.ts` (5,659) into turn-loop / prompt-composer /
guard-pipeline / contract-enforcement modules inside `packages/runtime`;
declare the five SurfaceContracts; wire the eval-coverage assertion into CI.
Guard order and latch/budget semantics are frozen by golden-transcript
comparison (record real turns before, assert identical guard firing after).
The conversation spine moves last because it's the one the household touches
every hour of every day.

### Phase 6 — Ongoing: tool consolidation + YAML slimming (data-driven, no end date)
Merge tools per the audit-log usage mining, one domain at a time, each behind
golden tasks; move YAML wiring (jobs, tool lists, triggers) into typed
`packages/agents` definitions, leaving persona prose in YAML. This is a
standing workstream, not a phase with a finish line — and it's deliberately
allowed to trail the rest.

**Total: 26–41 sessions, 2–3 months alongside feature work.** The explicit
non-goals of the arc: no schema renames, no HTTP contract breaks, no web-client
rewrite (the 80K-line client keeps consuming frozen contracts; it is a
*post-2.0* decision), no model-fleet changes.

---

## 7. What 2.0 must NOT lose — and how it gets stronger

| Invariant | 1.x enforcement | 2.0 enforcement (the upgrade) |
|---|---|---|
| **The cordon — owner has NO god-view** | `note_visible_to_caller` convention, repeated per store/route | `Cordoned<T>` in kernel + defineStore visibility built-in: a read of a cordoned table without a caller **does not typecheck**. Routes get the same via a `CordonedQuery` helper. The privacy self-test stays. |
| **Permission floor** (send/spend/PIN/hiring; draft→tap→PIN is permanent) | gateway + court floors in code | unchanged mechanics, relocated to `packages/governance`; the floor cases become golden tasks in the per-merge ring so a regression can't merge. |
| **Fail-open vs fail-closed per class** | per-feature discipline (guards fail open; proactive offers fail closed) documented in the private dev log | a declared field on SurfaceContract + DriverContract; the coverage assertion flags an undeclared failure mode. |
| **Audit hash-chain; `log_action` sole writer** | convention + backfill/verify scripts | the chain moves inside the store framework's transaction path; a raw `INSERT INTO audit_log` fails the import-direction lint. Append-only across the whole arc. |
| **Idempotency-from-inputs** | convention (hash inputs, never Date.now) | a kernel `idempotency_key()` helper + a guard script banning `Date.now\|ulid` inside `idempotency_key` bodies, in the per-merge ring. |
| **The guard cascade + re-roll budgets** | one `run_reply_guards` closure | contract-declared, order-frozen by golden transcripts (§6 Phase 5). |
| **LAW #1 — dynamic, never hard-coded around the model** | the private dev log + memory + review culture | restated as the SignalBus rule (§3.2): handlers transform and route; judgment spends a scoped LLM pass with tools. The inversion is *more* LAW-#1-compliant than cron scans, not less — but the temptation to "just pre-compute the answer into the wake prompt" is named here so reviews catch it. |
| **Smokes + goldens as the source of truth** | 195 scripts, run by hand; goldens nightly | the per-merge CI ring; eval-coverage assertion per surface; nightly live ring unchanged. |
| **Time discipline** (`time.ts` only), **bind-guard**, **note-type registry**, **recovery-hint affordances** | guards + registry checks | carried into kernel/memory/runtime unchanged; the guards join CI. |

---

## 8. Decisions (put to Jasper, ranked; recommendations first)

> **DECIDED 2026-07-06:** Jasper accepted the recommended option on all four —
> (1a) in-repo strangler, (2a) Phase 0 first, (3a) signals + sweeps,
> (4a) web client freeze + defer.

1. **Repo strategy** — (a) *Recommended:* in-place strangler, Bun workspaces,
   `git mv` history; (b) new repo with cross-repo strangler (breaks Beatrice's
   pipeline + double-fix tax, named in §5.1); (c) new-repo big-bang (rejected:
   two-systems trap on a live household); (d) no reorg, targeted cleanups only
   (keeps the 160-file flat core and convention-enforced cordon forever).

2. **First move** — (a) *Recommended:* Phase 0 deletion + flag collapse
   (cheapest real win, de-risks everything after); (b) SignalBus first (paradigm
   sooner, but built on uncleaned ground); (c) store framework first;
   (d) runtime split first (rejected: highest risk, zero warm-up).

3. **Inversion posture** — (a) *Recommended:* signal ownership + demoted
   reconciliation sweeps (soak-proven per job); (b) aggressive events-only, no
   sweeps (rejected: dropped-signal classes are real — restarts, down drivers);
   (c) keep cron, only dedupe handlers (misses the latency/accuracy point of
   Jasper's ask).

4. **The 80K-line web client** — (a) *Recommended:* freeze on stable contracts,
   defer to post-2.0; (b) fold a client rewrite into the arc (adds months);
   (c) sunset toward iOS/macOS-first (a product decision, not a refactor one).

---

*Grounding: five parallel code-inspection sweeps on `main` @ 2026-07-06 (core/store
inventory; env-flag census incl. prod hearth.env names; redundancy verification
with per-claim verdicts; cron-vs-event census; accuracy-machinery + tool census)
plus live-box checks (`/status` tool counts, scheduled_tasks state, doc-twin
resolution on a case-sensitive FS).*
