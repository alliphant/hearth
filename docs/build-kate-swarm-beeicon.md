# Build spec — the bee icon + the review swarm (#1 + swarm)

> Build-ready plan for: **(#1)** dual-surface LIVE swarm status — iOS "bee icon" + web Code Shop panel —
> and **(swarm)** growing the single code-critic **Vera** into a red/blue/**judge** bench.
> Verified against **`origin/main @ f95f30a`** (the DEPLOYED tree; local branches are divergent/stale).
> Companion to [`design-kate-self-improvement.md`](design-kate-self-improvement.md).

## 0. The three realities that shrink this

1. **Vera already runs as a tool-using sub-turn and already streams live.** `delegate to:'critic'`
   (`src/tools/delegate.ts`) → `DelegationRunner.run()` → `runtime.turn({ specialist_id:'critic',
   conversation_id:'delegate:<id>' })` (`src/core/delegation.ts:283`). Every emit inside `runtime.turn`
   is unconditional, so on the shared bus we ALREADY get, for that sub-turn: `specialist_thinking`
   (`specialist_runtime.ts:2586/2902…`), `tool_invoked` **with a `preview` code snippet**
   (`specialist_runtime.ts:4093`; preview populated for code tools, `events.ts:281`), `tool_completed`
   (`:4115`), `message_token` (`:3942`), plus `delegation_started`/`delegation_completed`
   (`delegation.ts:185/298`). **The live panel selects these; it does not add emit points.**
2. **One guard, and it's safe to harden.** Code-teeth auto-merge consults exactly one thing —
   `vera_reviewed` IIFE (`review_change.ts:266–278`) feeding `teeth_eligible` (`:280–286`), a soft
   existence check: `SELECT 1 FROM delegations WHERE profile_id='critic' AND status='done' AND task
   LIKE '%<bchg_id>%'`. It does NOT read the digest or any verdict; absence never *blocks* (falls back to
   the owner tap). `review_change.ts` is itself a `PROTECTED_CODE_PATH` (`code_teeth.ts:36`), so editing
   this guard stays owner+PIN — the circuit breaker can't be self-bypassed.
3. **The real gap:** no structured critique/verdict store exists — findings live only in
   `delegations.digest_md` prose (`delegations.ts:96`). `beatrice_changes` has no critique columns. The
   swarm's one genuinely-new backend surface is a **judged-verdict store**.

Fan-out point: **`route_change_for_review`** (`src/specialists/trainer/review_routing.ts`) is the single
funnel every build lands in (→ `pending_kate_review`, flags Kate). GPU: the delegate `Semaphore` is
concurrency **2** (shared 35B). Kill switches to inherit: `HEARTH_DELEGATE`, `HEARTH_CODE_TEETH`,
`HEARTH_OPENCODE`, `HEARTH_CODE_UNDO_MINUTES`.

---

## 1. Data model — the judged-verdict store (new)

New table `swarm_reviews` (sibling to `beatrice_changes`; DDL in `structured.ts` near the change-records
DDL `:1304`, additive migration in the `add_column`/`CREATE TABLE IF NOT EXISTS` block):

```
swarm_reviews:
  id            TEXT PK   -- swr_<ulid>
  change_id     TEXT      -- bchg_* (FK by convention)
  status        TEXT      -- 'running' | 'judged' | 'failed'
  verdict       TEXT      -- NULL | 'pass' | 'pass_with_concerns' | 'block'
  bench_json    TEXT      -- [{seat_id, role:'red'|'blue'|'judge', profile}]
  started_at    TEXT
  judged_at     TEXT
  user_id       TEXT      -- client-side SSE cordon
swarm_findings:
  id            TEXT PK
  review_id     TEXT      -- FK swarm_reviews.id
  seat_id       TEXT
  role          TEXT      -- 'red' | 'blue' | 'judge'
  severity      TEXT      -- 'blocker' | 'concern' | 'nit'   (Vera's existing vocabulary)
  summary       TEXT
  file          TEXT
  line          INTEGER
  refuted_by    TEXT      -- blue seat_id that refuted this red finding, or NULL
  ts            TEXT
```

`SwarmReviewStore` (new, `src/memory/stores/swarm_reviews.ts`): `create(change_id, bench, user_id)`,
`add_finding(...)`, `set_verdict(id, verdict)`, `judged_pass_for(change_id): boolean`,
`get(change_id)`, `get_findings(review_id)`.

---

## 2. Backend — the swarm engine

**New:** `src/specialists/kate/tools/review_swarm.ts` (or `src/core/review_swarm.ts`), gated by a new
capability token `orchestrate_review_swarm` (`config/capabilities.yaml` only; no `capabilities.ts` edit;
no `": "` in the description; run `bun run smoke:boot-check`).

- **Bench** from `config/swarm.yaml` (hot-reloaded like capabilities). Each seat = one delegate-style
  sub-turn on the **`critic` profile** with role framing (reuse Vera; no new personas needed to start):
  - `red` seats: "Break it — find the input/edge/security/regression/scope-creep that makes this diff
    wrong. Findings: blocker/concern/nit + file:line." (Vera's existing method, attack-only framing.)
  - `blue` seat(s): "For each red finding, refute it with evidence from the real repo, or confirm it and
    propose the minimal fix."
  - `judge`: adjudicate the findings ledger. Verdict = **block** if any un-refuted `blocker`;
    **pass_with_concerns** if only concerns/nits; else **pass**.
- **Fan-out** = a **dedicated** `Semaphore(HEARTH_SWARM_CONCURRENCY ?? 2)` (NOT delegation's module pool)
  over `runtime.turn`, exactly the `DelegationRunner._run` shape (`delegation.ts:210`), each seat with
  `tools_override:['read_change_for_critique','grep_codebase','read_codebase_file','list_codebase']`
  (capability-prefiltered → grant seat profiles `read_codebase` + `critique_code_change`). Each seat's
  `conversation_id = 'delegate:swr_<id>:<seat_id>'` so the live panel groups by it.
- **Persistence:** the engine writes `swarm_reviews` + `swarm_findings` rows as seats complete and the
  judge rules → `set_verdict`.
- **Commissioning:** auto-fire from `route_change_for_review` (every build funnels there), OR keep it a
  Kate tool she calls in her review turn. Recommended: auto-fire for `change_kind==='code'` nontrivial
  diffs; Kate still rules via `review_change`.
- **Kill/degrade:** `HEARTH_REVIEW_SWARM=0` → fall back to today's single Vera delegation (unchanged).
  A seat that times out is dropped from the tally (abstain), never blocks.

**Guard hardening** (`review_change.ts:266–286`, a protected-path edit → owner+PIN, correct): replace
the `task LIKE '%id%'` existence check with `swarmReviews.judged_pass_for(change.id)` (i.e. teeth arm
only on a genuine judged **pass**, not merely "a critique happened"). This *strengthens* the gate;
absence still falls back to the owner tap, never blocks. Leave the owner-merge cordon + `arm_trust_autoexec`
downstream untouched.

---

## 3. Live-status event contract (both surfaces, one stream)

Most of the panel runs off events already emitted for the seat sub-turns (§0.1). Add **correlation
events** so a client can group sub-turns into one swarm + show the verdict. Append flat arms to the
`AppEvent` union (`src/app/events.ts`, before the `media_archived` arm's closing `};` ~`:716`); emit via
`this.deps.events?.emit(...)` from the swarm engine. Carry `user_id` (stream cordons client-side):

```ts
| { type:'swarm_review_started'; review_id:string; change_id:string; title:string;
    bench:{ seat_id:string; role:'red'|'blue'|'judge'; conversation_id:string }[]; user_id:string }
| { type:'swarm_seat_update'; review_id:string; change_id:string; seat_id:string;
    role:'red'|'blue'|'judge'; phase:'queued'|'working'|'done'|'failed'; summary?:string; user_id:string }
| { type:'swarm_finding_added'; review_id:string; change_id:string; seat_id:string;
    severity:'blocker'|'concern'|'nit'; summary:string; refuted:boolean; user_id:string }
| { type:'swarm_verdict'; review_id:string; change_id:string;
    verdict:'pass'|'pass_with_concerns'|'block'; user_id:string }
```

Durability (the bus is fire-and-forget, no replay for offline subscribers): the `swarm_reviews`/
`swarm_findings` rows back a refetch — `GET /api/specialists/trainer/swarm/:change_id` (mount INSIDE the
existing specialists router → **no nginx alternation edit**). Optionally teach `AppEventBus._track`
(`events.ts:824`) to replay open reviews on connect, like `active_tool_calls`.

---

## 4. Web — `render_swarm_panel` in the Code Shop office

- **Clone `beaSSE`** (`src/app/client/scrum-canvas/index.html:772–799`) into `render_swarm_panel(doc)` in
  `src/app/client/app.js`. Change its single-id guard `if (e.specialist_id !== BEA_ID) return;` (`:779`)
  to a **set-membership** test over the review's seat ids / `conversation_id.startsWith('delegate:swr_')`,
  and render **one LED-row + status + `beaShowCode` code-preview per seat** (red/blue/judge), plus a
  verdict pill fed by `swarm_verdict`. LED CSS from `scrum-canvas/index.html:250–281`.
- **Mount** in the codeshop office: add a third tab `{ id:'swarm', label:'Swarm' }` to the `tabs` array in
  `compose_codeshop_pane` (`src/core/specialist_pane.ts:4055`) and call `render_swarm_panel(doc)` inside
  `render_pane`'s `pane_kind==='codeshop'` handling (`app.js:4314`, mirroring the `render_presence_canvas`
  mount at `:4175`). On a **pass**, the judge row reuses the existing `codeshop:merge:<proposal_id>`
  deep-link (`app.js:5079`) so approve-to-merge stays one flow.
- **Deploy:** `app.js`/client edits = **no restart** (bind mount, 60s cache). `events.ts` + swarm-engine
  (`.ts`) = `docker compose restart hearth-orchestrator`. Reusing `/app/api/events` = **no nginx change**;
  the `GET /api/specialists/trainer/swarm/:change_id` refetch rides the existing specialists alternation.

---

## 5. iOS — the bee icon (this repo, ships FIRST)

Purely additive; new events decode to `.unknown` on old builds (safe). Exact seams:

| Piece | File | Action |
|---|---|---|
| `swarm_*` AppEvent cases | `HearthAPI/.../DTOs/AppEvent.swift` (case ~`:85`, payload struct ~`:454`, decode switch before `default` `:526`) | 3-part add per event; model payload on `SpecialistStatusPayload` |
| Force-handle | `Hearth/Features/Chat/ChatCoordinator.swift:178–191` | add cases to the no-op group (switch has NO `default` → won't compile until handled) |
| `BeeStatus` store (new) | `Hearth/Features/Staff/BeeStatus.swift` | copy `LiveStaffSignals.swift` (`@Observable @MainActor`, `subscribe()` loop, `handle`, `sweep` deadlines, `reset`); hold `[changeID: SwarmBuild]`, expose `activeBuilds` + `mostRecent` |
| Store wiring | `Hearth/App/AppDependencies.swift:50` (declare), `:298` (construct), `:404`+`:431` (reset) | mirror `liveStaff` |
| Bee glyph mount | `Hearth/Features/Root/RootTabView.swift` after `KateVoiceOrb` `:147` | floating glyph at `.bottom, 240`, gated `!deps.beeStatus.activeBuilds.isEmpty`; model on `KateVoiceOrb` (`:622`), hue `specialistHues.color(for:"beatrice")` |
| Detail sheet | `RootTabView.swift:44–60` (state) + `:181–347` (root `.sheet`); new `BeeBuildSheet.swift` | copy `ReconOpsSheet` `Status` enum (`:61`), `runControl` icons (`:148`), "Step N of M" (`:221`), `seedStatuses` reopen-resume (`:233`) |
| Foreground catch-up | `RootTabView.swift:363–370` (existing scenePhase `.onChange`) | add `Task { await deps.beeStatus.refreshActive() }` |
| Refetch + DTO | `HearthClient.swift` (~`:290`), new `DTOs/Swarm.swift` | `swarmStatus(changeID:)` via `transport.send`; timestamps as `String?` (ISO8601 decoder gotcha, per `BackgroundJobStatus.swift:17`) |

iOS build number auto-stamps from git commit count on archive.

---

## 6. Phased plan + cross-repo ship ordering

1. **iOS-first scaffold** (this repo, zero live-system risk): `swarm_*` AppEvent cases + `BeeStatus` store
   + bee glyph + `BeeBuildSheet` + `swarmStatus` client. Builds green, degrades to inert (no events yet).
   **Ship/install before the backend emitter** (cross-repo ordering rule).
2. **Backend swarm engine + store** (behind `HEARTH_REVIEW_SWARM`, dark): `swarm_reviews`/`swarm_findings`
   + `SwarmReviewStore`, `review_swarm.ts`, `config/swarm.yaml`, `orchestrate_review_swarm` token, emit the
   `swarm_*` events, the `GET .../swarm/:change_id` refetch. `smoke:boot-check` + deploy (restart).
3. **Web `render_swarm_panel`** in the codeshop office (client edit, no restart).
4. **Guard hardening** (`review_change.ts` → `judged_pass_for`) — a protected-path change, so it flows
   through Beatrice→Vera→**owner+PIN merge** itself (fitting: the swarm reviews its own swarm).
5. **Flip `HEARTH_REVIEW_SWARM=1`**, soak, watch the panel.

## 7. Open decisions (owner)

- **Autonomy posture of a swarm PASS.** (a) A judged **pass** arms code-teeth auto-merge (Vera-panel
  replaces the single-Vega gate; owner keeps the undo-window + protected-floor). (b) The swarm only
  *informs* Kate, who still rules and the owner still taps every merge. — recommend starting at (b),
  earning (a).
- **Bench size vs GPU** (shared 35B, delegate Semaphore=2). Recommend **2 red + 1 blue + 1 judge**, run in
  waves of 2; grow later.
