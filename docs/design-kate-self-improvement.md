# Kate, Unhandicapped — the Live Tool Forge + red/blue review swarm

> **Status:** concept / design lead-in. 2026-07-21. Drop-in companion to
> [`design-kate-self-direction.md`](design-kate-self-direction.md) (this extends C5 "self-authored
> automations" into a real executor, and finally wires the graduation actuator C2 always assumed).
> Cross-repo: the live-status half lands in **hearth-ios** (the "bee icon") and **hearth web client**
> (`src/app/client/app.js`, Code Shop office) off ONE shared event contract.
> **Nothing here is built. This is the plan + the exact seams.**

---

> ## ⚠ Reconciliation — read this first (verified against `origin/main` HEAD `8516551`, 2026-07-21)
>
> §0/§5/§6/§7 below were drafted from a **stale local backend checkout**. Several items already
> **SHIPPED 2026-07-20/21** (PR #97 + batch #92/#93/#95, deployed):
>
> - **The graduation actuator is WIRED.** `graduate()` has its caller — `proposal_court.ts:1039`; the
>   **court self-graduates** (≤3/convening, risk-keyed floor never self-graduates, `HEARTH_COURT_GRADUATION`
>   kill). So §0-finding-2, §5-step-1, and the §6 "graduate() has no callers" row are **DONE, not to-do.**
> - **commissioner≠reviewer is DECIDED and BUILT — the §7 fork is closed.** Code-teeth auto-merge already
>   requires a recorded **Vera** critique on the `bchg_*` id. **Vera** = `config/specialists/critic.yaml`, a
>   `subagent_only` adversarial code critic (born 2026-07-14). Kate `delegate to:'critic'`; Vera runs a
>   **tool-using, read-only** critique (`critique_code_change` / `read_change_for_critique`, findings =
>   blocker/concern/nit + file:line) returned as a delegation digest; Kate weighs it before `review_change`;
>   owner still merges (`kate.yaml:1714`).
> - **All autonomy flags are LIVE on the LLM host** (`HEARTH_KATE_REFLECTION/PROPOSAL_COURT/TRUST_TEETH/CODE_TEETH/AUTO_DEPLOY=1`).
>   Any "DARK" below is stale.
> - **Correction to §3.1:** the *proposal-court lens* reviewers can't read files (true), but **Vera** (a
>   *delegated* critic, not a court lens) **already runs tool rounds and reads the diff.** The tool-using
>   adversarial reviewer primitive already exists.
>
> **This SHARPENS the concept, it doesn't sink it.** The tool-using adversarial reviewer exists as **Vera
> (n=1)** — so §3's red/blue swarm is precisely **"Vera × N, split into attack/defend seats + a judge, made
> visible."** The seed is proven in production. The genuinely-still-open, still-valuable parts (confirm each
> against the LLM host): **(1)** LIVE *in-conversation* tool creation — Tier-1 skills-as-data (C5, unbuilt) + the
> Tier-2 hot-tool gaps (§2); **(2)** upgrading single-Vera into the red/blue/**judge** bench (§3); **(3)** the
> live **bee icon + web swarm panel** (§4) — today Vera's critique returns as a delegation *digest*, not a
> streamed per-seat panel, and there is no bee icon at all. That visibility piece is exactly what the owner
> asked for and is 100% still to-build.

---

## 0. TL;DR — the reframe that makes this cheap

Three findings from the code flip the framing of "let Kate build tools live, self-improving like Hermes":

1. **New tool code does NOT require a restart.** The orchestrator runs a `ToolLoader`
   (`src/core/tool_loader.ts`) that chokidar-watches `src/connectors`, `src/tools`,
   `src/specialists/*/tools/` and **hot-registers a brand-new tool file with no restart** (it imports an
   ephemeral snapshot copy to bust Bun's path-keyed module cache; `ToolRegistry.register` is
   replace-on-conflict). Capabilities (`config/capabilities.yaml`) and specialist grants
   (`config/specialists/*.yaml`) hot-reload too. **The physics we assumed ("new tool = recompile =
   restart") is false.**

2. **"Self-improving like Hermes" is mostly wiring that already exists but was never connected.**
   Kate's earned-autonomy ladder is *clinically dead*: `graduate()` (`proposals.ts:1784`) has **zero
   callers**, every `category_signature` is frozen at `tier2a` (`structured.ts:305`), so trust-teeth can
   never arm no matter what flag you flip. The reflection engine runs nightly but **watch-only**. This is
   what "artificially handicapped" actually *is* — an unplugged wire, not a safety decision.

3. **The one thing that IS a real safety floor should stay.** `PROTECTED_CODE_PATHS`
   (`code_teeth.ts:36`, fail-closed) forbids any auto-merge that touches the autonomy machinery, the
   review gate, capabilities, auth, or the cordon. Plus the owner-tap floor on send/spend/step-up
   (`is_owner_only`). These aren't handicaps — they are the circuit breaker that lets us take the
   handicaps off *everywhere else*.

**The design in one line:** dissolve Beatrice (`trainer`) into Kate so a *conversation* is the build
intake; give tool-creation two tiers (data-shaped skills that come alive mid-session, and real
hot-loaded tool code); make an **independent red/blue-team + judge swarm** the reviewer that replaces
*your* thumbprint on the safe classes; and stream every stage live to a **bee icon (iOS) + Code Shop
swarm panel (web)** off one event contract. Keep the protected floor.

---

## 1. Merge Beatrice into Kate

**Today** the split is enforced by capabilities:

| Role | Capability | Tool | Held by |
|---|---|---|---|
| Author code | `write_codebase_pr` | `propose_code_change` / `propose_code_edit` → `open_change_pr` | `trainer` (Beatrice) |
| Merge | `merge_codebase_pr` | `merge_approved_change` (dispatch-only) | `trainer` |
| Review | `review_beatrice_change` | `review_change` | `kate` |
| Delegate | `delegate_subagents` | `delegate` → `DelegationRunner` | `kate` |

Beatrice is already `subagent_only` (2026-07-14) — absent from `GET /api/specialists`, no roster row.
The merge is therefore mostly **capability + surface**, not persona demolition:

- **Give Kate the authoring surface.** Grant Kate `write_codebase_pr` (or expose `propose_code_change`
  / `propose_code_edit` to her chat surface behind a new "builder mode"). A conversation becomes the
  build intake, replacing the invisible owner-only directed build
  (`POST /api/specialists/trainer/fire_deliberation {task,tools}`).
- **Keep Beatrice as an internal builder lens, not a separate desk.** Fold her build persona/skills
  into Kate as a *sub-agent profile* the swarm and the authoring turn wear (the `trainer` profile keeps
  existing so `beatrice_changes.target_specialist_id`, the Code Shop office, and the scrum board keep
  resolving — we are collapsing the *user-facing* seam, not deleting the id).
- **The catch this creates — and why §3 exists.** Merging author+reviewer into one identity collapses
  separation-of-duties. Kate authoring *and* self-reviewing her own code (today's `HEARTH_CODE_TEETH`
  single synthetic vote, `review_change.ts:220`) is the "commissioner-is-reviewer" risk. **The red/blue
  swarm is the structural replacement for the independent reviewer** the merge removes.

---

## 2. Two-tier tool creation

### Tier 1 — skills-as-data (the Hermes loop; truly live; low-risk auto-approve)

Hermes's self-improvement is *solve once → auto-write a reusable **skill document** → recall it → 40%
faster.* Skills are **data, not compiled code**, which is exactly why they can appear mid-conversation.
Hearth's designed-but-unbuilt **C5 "self-authored automations"** is this, precisely: a *config-shaped
spec* — `trigger + condition + existing-tool + args + kill-switch + rate-cap + auto-revoke-after-N-
dismissals` — run shadow→activate, never code.

- When Kate solves a novel multi-step thing with you (Hermes triggers at ~5+ tool calls), she
  crystallizes the *recipe over tools she already has* into a Tier-1 skill artifact.
- It's **callable the same session** because it's a declarative surface the runtime reads, not a module
  the process links. Low-risk class needs **no human merge** — the kill-switch + rate-cap + auto-revoke
  are the safety, and the reflection soak grades it.
- This is the *bulk* of "she makes a tool while we talk," and it never touches `git`.

### Tier 2 — real hot-loaded tool code (new compiled connector)

For a capability that genuinely needs new code (a network call, a new integration, real side effects):

- Kate authors a **self-contained** tool file via `open_change_pr` → the deterministic gate
  (`run_checks`: `bun run guard` always, `tsc --noEmit` if `.ts` touched, and the **new-tool-must-touch-
  a-smoke** gate, `change_pipeline.ts:521/564`) → the **swarm** (§3) → lands.
- Because it's a **new self-contained tool file** (not a shared-module change), the `ToolLoader`
  hot-registers it **with no restart**. Two small, named gaps to close for true same-session
  callability:
  - **(a) A "new-tool-file → pull-but-don't-restart" deploy class.** Today `merge_approved_change.classify()`
    (`merge_approved_change.ts:43`) marks *any* non-config `src/` file as `code_restart`, so a new tool
    file is never auto-pulled onto the live checkout even though the `ToolLoader` could hot-load it on a
    mere `git pull`. Add a class that recognizes a pure new-tool-file diff and pulls-without-restart.
  - **(b) Mid-turn callability.** The per-turn tool catalog is snapshotted at `runtime.turn`
    (`specialist_runtime.ts:2928-2934`). BUT the invoke gate is `specialist.granted`, **not** the hot
    set (`specialist_runtime.ts:4286`) — and `tool_defs` is a mutable array that already grows mid-turn
    via `load_tools` (`:4088`). So a freshly registered tool is callable *this turn* if we advertise its
    schema (push to `tool_defs`) and the capability is granted. This is a small extension of the existing
    `load_tools` seam, not new machinery.
- **Authoring guardrail:** reject any tool that imports a **not-yet-loaded shared module** — that is the
  one true "needs a restart" class the `ToolLoader` can't hot-apply (`tool_loader.ts:28`).

---

## 3. The red/blue-team review swarm — the centerpiece

> **The reviewer that lets us unshackle safely.** An *independent, adversarial* panel replaces the human
> thumbprint on the safe classes — so it is never "Kate grading Kate."

### 3.1 Why the existing Proposal Court can't be it

The Proposal Court (`proposal_court.ts`) is the only multi-agent panel today, and it is the right
template for **adjudication** — but its reviewers are `provider.complete()` calls with **no tool access**
(`llm_lens_votes`, `:325`). They judge only an embedded ≤350-char rendered gist; **they cannot read
files, grep, or run the diff.** A real red/blue reviewer that inspects a code change is genuinely new and
must be built on `runtime.turn` (tool-using), *not* the court's lens path. The court gives us the judge;
`DelegationRunner` gives us the reviewers.

### 3.2 The fan-out spine (no new agent runtime — the repo forbids one)

Every reviewer is one disposable `runtime.turn`, bounded by a **dedicated** `Semaphore` (not
delegation's module-global pool of 2), joined with `Promise.all`. This is structurally identical to
`DelegationRunner._run` (`delegation.ts:210`):

```ts
// src/specialists/trainer/swarm/review_swarm.ts  (new)
const pool = new Semaphore(Number(process.env.HEARTH_SWARM_CONCURRENCY ?? 3)); // respect the single :8200 endpoint's 4 slots

async function runSeat(seat: SwarmSeat, change: ChangeRecord, runId: string): Promise<SeatResult> {
  return pool.with_slot(async () => {
    const out = await deps.runtime.turn({
      specialist_id: seat.profile_id,                       // a reviewer profile (see 3.3)
      conversation_id: `swarm:${runId}:${seat.id}`,         // ephemeral, like delegate:<id>
      message: { role: 'specialist', content: seat.framing(change), from_specialist_id: 'kate' },
      conversation_history: [],
      max_tokens_override: 1500,
      tools_override: ['read_codebase_file', 'grep_codebase', 'read_codebase'], // capability-prefiltered
    });
    return parseSeatOutput(out.message_text); // structured findings, JSON-array like the court
  });
}
```

- **`tools_override` is capability-prefiltered** (`specialist_runtime.ts:613`) — a seat can only surface
  tools its profile is already granted. Grant reviewer profiles `read_codebase` so red/blue seats can
  actually open the diff's files. This is the key difference from the court: **the reviewers run real
  tool rounds.**
- **GPU budget is load-bearing.** Everything shares one llama.cpp endpoint (:8200, `-np 4`). The
  dedicated `Semaphore(3)` is the backpressure; do not widen it past the endpoint's real slots.

### 3.3 Roles — config-declared, not hardcoded

The court's seats are hardcoded strings (`SEATS = ['mariah','trainer','kate']`). The swarm is
**config-declared** so a build can convene the right bench:

```yaml
# config/swarm.yaml  (new; hot-reloaded like capabilities.yaml)
default_bench:
  - { id: red-1,  role: red_team,  profile: trainer, lens: "Break it. Find the input/edge/security/regression that makes this diff wrong." }
  - { id: red-2,  role: red_team,  profile: mariah,  lens: "Break it from evidence: what claim in the rationale is unsupported by the diff?" }
  - { id: blue-1, role: blue_team, profile: trainer, lens: "Defend & repair: for each red finding, is it real? Propose the minimal fix." }
  - { id: judge,  role: judge,     profile: vision,  lens: "Adjudicate the findings ledger. Verdict: approve | revise | block." }
```

- **red_team** seats attack (find the break). **blue_team** seats defend/repair (triage each red
  finding, propose the minimal fix). **judge** adjudicates.
- **Diversity decorrelates** (the court's own design note): give seats *different profiles and lenses*,
  not N identical critics. The judge is `for_role('vision')` — the dense 27B, a genuinely different model
  on purpose (`proposal_court.ts:374`), mirroring the court's independent tiebreak.
- **Recursion bound:** one level. A `senior-dev` seat may recruit **one** critic sub-turn (capped,
  counted against the same `Semaphore`) so it can't fork-bomb the GPU. `delegate_subagents` is *not*
  granted to reviewer profiles, so uncontrolled recursive sub-delegation stays impossible by default.

### 3.4 The findings ledger (durable — because the event bus is fire-and-forget)

A new sibling table to `beatrice_changes`, so findings survive refresh and back the live events:

```
swarm_runs:     id (swm_*), change_id, status(running|judged|failed), verdict(approve|revise|block|null),
                started_at, judged_at, bench_json, user_id
swarm_findings: id, run_id, seat_id, role(red|blue|judge), severity(low|med|high),
                summary, detail_md, file, line, refuted_by (blue seat id | null), ts
```

The judge adjudicates over `swarm_findings` using the court's proven shape:
`tally`/`unanimous`-style consensus (`proposal_court.ts:621/822`) generalized to "no un-refuted `high`
finding survives → approve; else revise/block," plus authorship recusal (a seat whose profile == the
change author is dropped and replaced by an independent seat, exactly like `llm_tiebreak`).

### 3.5 Where the swarm plugs into the pipeline

Insert **before/at** the single-reviewer gate. `route_change_for_review` (`review_routing.ts:34`) is the
shared tail that creates the `pending_kate_review` row and flags Kate. The swarm:

1. consumes the same `change_id`, runs the bench over `ChangeRecord.diff_summary` + live file reads,
2. writes `swarm_runs`/`swarm_findings` and streams events (§4),
3. drives the **existing** verdict path — calls `review_change`'s internals (`set_kate_verdict` +
   the approve→`recommendation`/`merge_approved_change` fan-out, or deny→BUILD LESSON) with the judged
   verdict + a synthesized `reasons_md`.

**Everything downstream is unchanged and non-bypassable:** the owner-merge cordon, the code-teeth arm
(`review_change.ts:220`), the `merge_codebase_pr` dispatch-only gate, and the `PROTECTED_CODE_PATHS`
floor. The swarm changes *who produces the verdict*, not *how a merge lands*.

### 3.6 New capability + kill switch + degradation

- New token in `config/capabilities.yaml` only (no `capabilities.ts` edit → dup-boot-crash; no `": "` in
  the description → YAML crash; run `bun run smoke:boot-check`): `orchestrate_review_swarm`.
- `HEARTH_REVIEW_SWARM` kill switch. **Degradation is structural:** swarm disabled/errored →
  fall back to today's single-reviewer `review_change` (exactly the current behavior). A seat that
  times out is dropped from the tally (like an abstain), never blocks.

---

## 4. Live status — the bee icon (iOS) + Code Shop swarm panel (web), one contract

Both clients already subscribe to **one** stream: `/app/api/events`, fed by the single `AppEventBus`
process singleton (`src/app/events.ts`). Background/detached runs emit to it **for free** because the
runtime holds the singleton. So the swarm streams to both surfaces with no new endpoint and no new
connection.

### 4.1 New events (append to the `AppEvent` union, `events.ts`)

Flat payloads (there is no nested `{type,payload}` envelope), each carrying `user_id` for the
**client-side cordon** (the stream has *no* server-side per-user filtering — every authed subscriber
gets every event; clients drop `user_id` mismatches, per the existing `brief_generated` convention):

```ts
| { type:'swarm_run_started';  swarm_id:string; change_id:string; bench:{seat_id:string; role:'red'|'blue'|'judge'; profile:string}[]; user_id:string }
| { type:'swarm_seat_update';  swarm_id:string; change_id:string; seat_id:string; role:'red'|'blue'|'judge'; phase:'queued'|'working'|'done'|'failed'; summary?:string; preview?:string; user_id:string }
| { type:'swarm_finding_added';swarm_id:string; change_id:string; seat_id:string; severity:'low'|'med'|'high'; summary:string; refuted:boolean; user_id:string }
| { type:'swarm_verdict';      swarm_id:string; change_id:string; verdict:'approve'|'revise'|'block'; rationale_md:string; user_id:string }
```

`preview?` follows the existing `tool_invoked.preview` idiom (`events.ts`) that the scrum canvas already
renders as a live code preview — reuse it for a seat's in-progress reasoning snippet.

**Durability:** the bus does not replay for a subscriber that was offline at emit time. Back the live
events with the `swarm_runs`/`swarm_findings` rows + a `GET /api/specialists/trainer/swarm/:change_id`
refetch (mount it *inside* the existing specialists router → **no nginx alternation edit**), and replay
open runs on SSE-connect the way `router.ts:444` already replays `current_active_tool_calls()`.

### 4.2 Web — the Code Shop swarm panel

The Code Shop office (`pane_kind:'codeshop'`, Beatrice's room, `compose_codeshop_pane`) is the home. Use
the **live client-canvas** seam (the `render_people_room` / scrum-canvas `beaSSE` pattern), **not** a
static `PaneBlock` (blocks are refetched snapshots; they can't tick):

1. Add cases to the single `handle_sse_event` switch (`app.js:9782`):
   `swarm_run_started` / `swarm_seat_update` / `swarm_finding_added` / `swarm_verdict` → mutate a
   `state.swarm` map keyed by `swarm_id`/`seat_id` (mirroring `state.tool_chains`).
2. Add `render_swarm_panel(change_id)` mounted under a `codeshop` sub-tab (alongside `office`/`scrum`),
   structured like the tool-chain live-row list: a column of seat rows (red ⚔ / blue 🛡 / judge ⚖), each
   with a live LED (reuse `led`/`flash_led`), a status line, an expandable findings list; the judge row
   shows the verdict and, on approve, reuses the existing `codeshop:merge:<proposal_id>` deep link so
   approve-to-merge stays one flow.
3. Ships by editing `app.js` + `git pull` on the LLM host — **no restart** (bind mount, 60 s cache). Only the
   server half (new `AppEvent` variants + emit calls, `.ts`) needs the orchestrator restart.

### 4.3 iOS — the bee icon

There is **no bee icon today** (one code comment mentions Beatrice). Build it as a **global** surface (a
tab-bar glyph or a Today card + detail sheet), reusing two existing patterns:
`ReconOpsSheet`'s fire→poll→spinner→check step-tracker and `LiveStaffSignals`'s live SSE store.

- Add the four `swarm_*` cases + a `code_change_updated` case to `AppEvent.swift` (enum case + `Decodable`
  payload + decode-switch case; unknown types already fall to `.unknown`, so old builds are safe). The
  enumerate-all switches with no `default` (e.g. `ChatCoordinator.swift`) will *force* conscious handling.
- Add an `AppDependencies`-owned `@Observable BeeStatus` store (mirror `LiveStaffSignals`) so the icon
  reflects an in-flight build regardless of foreground tab, with foreground-refresh + SSE reconnect
  catch-up against the refetch route.
- Stages shown: **drafting → red/blue reviewing (each seat live) → building/checks → verifying → landed |
  failed**, with each seat's LED + findings mirroring the web panel.

### 4.4 Cross-repo ship ordering (hard-won rule)

A new *event type* is backward-compatible (old clients ignore unknown types). But **ship + install the
iOS build FIRST, then flip the backend emitter** — the build-60 embed-decode lesson. New `/api/...`
refetch route: mount it inside the existing specialists alternation so nginx needs no edit; if a brand-new
top-level token is unavoidable, edit `/docker/nginx/locations.conf` on the LLM host and apply with
`docker restart nginx` (never `sed -i` + reload — stale-inode no-op).

---

## 5. Self-improving like Hermes — wire the loop that already exists

1. **Wire the graduation actuator (highest leverage, smallest change).** `graduate()` has zero callers;
   `check_graduation_candidates()` (`proposals.ts:1658`) feeds only Mariah's dashboard. Add the
   `check → file recommendation → owner approves → graduate()` loop the comment at `proposals.ts:1655`
   always assumed. This is the single change that makes "rope earned by good behavior" actually unlock —
   the "un-handicap" you're feeling.
2. **Turn on the XP substrate** (`HEARTH_TRUST_XP`) so "attention earns rope" has data, and let it soak.
3. **Crystallization = reflection → Tier-1 skills.** The reflection engine (`kate_reflection.ts`, C2)
   already walks the house nightly (watch-only). Feed its `act` disposition into **Tier-1 skill
   authoring** (§2) instead of just a watch ledger, gated by the C3 precedent substrate
   (`HEARTH_PRECEDENT`, currently dark). That *is* Hermes's "write down how I solved it, get faster."

---

## 6. The shackle audit — cut vs keep

**CUT (artificial — unfinished wiring, not safety):**

| Shackle | Reality / fix |
|---|---|
| `graduate()` has zero callers | The earned-autonomy ladder cannot climb. Wire check→propose→graduate. |
| `HEARTH_TRUST_XP` off | The "attention earns rope" throttle has no data. Turn on, soak. |
| Directed-build-only intake | Make the *conversation* the intake (§1). |
| Invisible pipeline | The bee icon + web swarm panel (§4). |
| Single-reviewer code-teeth | Replace with the independent red/blue swarm (§3). |
| Reflection stuck watch-only | Feed `act` into Tier-1 skill crystallization (§5). |

**KEEP (load-bearing — the circuit breaker):**

- **`PROTECTED_CODE_PATHS`** (`code_teeth.ts:36`, fail-closed): a self-modifying system can **never**
  auto-merge changes to its own autonomy machinery, review gate, capabilities, auth, or cordon.
- **The owner-tap floor** on send / spend / step-up (`is_owner_only`, `proposal_court.ts:240`).

These two are what make cutting everything else safe.

---

## 7. The one decision that's yours — commissioner-is-reviewer

Do you let Kate approve her *own* non-protected code changes (today's `HEARTH_CODE_TEETH` = one synthetic
Kate-approve, no panel, no recusal)?

**Recommendation: no — route it through the red/blue swarm instead.** That gets you the autonomy you
want (you are not the bottleneck reviewer) *without* the failure mode (she is not her own reviewer
either — an independent adversarial panel is). Concretely: the swarm's judged verdict, not a lone Kate
vote, is what arms `arm_trust_autoexec` for a non-protected change; a `high` un-refuted finding blocks;
the protected floor still forces owner+PIN forever.

---

## 8. Staged rollout (PLAN.md entries)

1. **Tier 1 — wire the graduation actuator + turn on `HEARTH_TRUST_XP`.** Unshackle the ladder that
   already exists. (backend)
2. **Tier 1 — merge Beatrice into Kate** (grant authoring + conversation-as-intake) **+ build the bee
   icon / web swarm panel shells** off a first `code_change_updated` event. (backend + iOS + web)
3. **Tier 2 — the red/blue swarm primitive** (`review_swarm.ts`, `config/swarm.yaml`,
   `swarm_runs`/`swarm_findings`, the four `swarm_*` events, `render_swarm_panel`). The centerpiece.
   (backend + web + iOS)
4. **Tier 2 — Tier-1 skills-as-data executor** (C5: spec schema, constrained executor, kill/rate/auto-
   revoke, shadow→activate). The Hermes day-to-day loop. (backend)
5. **Tier 3 — Tier-2 hot-tool creation** (the two deploy/catalog gaps in §2), gated by the swarm.
   (backend)
6. **Tier 3 — reflection → skill crystallization** (§5) + revisit which taps to keep. (backend)

---

## 9. Open questions

- **Bench size vs GPU.** Default bench is 4 seats on a 4-slot endpoint. Is a serialized 4-seat bench
  (~fast) acceptable, or do we want a bigger bench that runs in waves? (`HEARTH_SWARM_CONCURRENCY`.)
- **Does the swarm gate Tier-1 skills too, or only Tier-2 code?** Recommendation: Tier-1 low-risk skips
  the swarm (kill-switch + rate-cap + shadow soak is the safety); Tier-1 *elevated* + all Tier-2 go
  through it.
- **Server-side cordon.** Swarm events carry `user_id` and cordon client-side (the platform default).
  Fine for a single-owner box; if seat previews could ever carry another user's data, add a real
  server-side filter in the `/api/events` handler keyed on `c.get('user')`.
- **The commissioner-is-reviewer fork (§7)** — owner sign-off needed.
