# Kate sub-agents — one brain, disposable worker contexts

**Status:** Phase 1 SHIPPED 2026-07-03 (delegate tool + DelegationRunner +
`subagent_only` flag). **Phase 2 batch 1 FLIPPED 2026-07-03** (owner-approved:
iris, marguerite, anya, brigid, anna, eleanor, maggie). **Phase 3 batch 1
FOLDED AND COMPLETED 2026-07-03/04 (owner-directed): Luna, Anya, Marguerite,
Iris are fully Kate's** — capability union + tools + persona map, ALL FOUR
YAMLs deleted, every seam re-pointed (arrival/departure triggers on her YAML;
folded-domain standing duties in her deliberation addendum; pet-record intake
dispatched inside `intake_kate` off the classifier's rationale; the Home
occupancy canvas as a Kate office tab via her `read_home` grant — zero route
changes; goods warranty FYI + the two iris golden tasks re-owned). The
presence-zone editor is PARKED (device-gated dormant) until the voice
coordinator holds the LD2450.
**Owner dispositions (2026-07-03):** **Ruby is permanently exempt** — named in
memory of Jasper's beloved dog; no usage data overrides that. **Linda stays
user-facing** (Kim is friend-tier scoped to her). **Astrid stays for now**
(hardcoded iOS/watchOS pieces) but the owner wants her folded EVENTUALLY —
unblock by de-hardcoding the iOS/watchOS references first.

## The problem

The specialist roster fractures Kate's autonomy. Jasper: "I worry the fracture
of all the specialists actually reduces her autonomy and overall intelligence."
The evidence agrees:

- **Kate is already the household's brain.** 30-day usage (2026-07-03,
  the LLM host prod DB): Kate received **517 of ~690 user messages (~75%)**. Next:
  trainer 32, kristi 29, luna 28, linda 23, ruby 20. Iris and Marguerite: **0**
  (last touched 2026-05-22).
- **Kate is already the delegation hub — through a weak channel.** 30-day
  consult edges: kate→cassandra 26, kate→trainer 19, kate→ruby 14, kate→iris 8,
  kate→mariah 8, kate→{anna,cordelia,linda,luna} 5 each. But
  `consult_specialist` **blocks her turn synchronously**, runs the consultee on
  a squeezed budget with no conversation context (the "Flag Beatrice, don't
  consult her" class), and serializes — one consult at a time, on her rounds.
- **Signal fans out away from her.** Captures route to 18 inboxes;
  deliberations produce 18 silos of conclusions. Kate's context window was
  never the constraint — *what reaches her* is. (She already holds
  `knowledge_scope: "**"`.)

## The reframe

A specialist YAML conflates three things:

1. **A user-facing persona** — someone the household talks to.
2. **A capability bundle** — tools + knowledge scope + workflow addenda.
3. **A scheduled background worker** — deliberation slots, intake handlers,
   background jobs.

Only (1) needs a roster entry. (2) is a **sub-agent profile** — and a
specialist YAML already *is* one (capability gating, cordons, hot-reload all
work today). (3) doesn't care whether its owner is user-facing.

**So specialists aren't deleted; most demote from "peer" to "Kate's staff."**
Jasper talks to Kate; Kate tasks the hats. Small models degrade with wide
*action spaces*, not wide *awareness* — one brain with total awareness
(working memory + inboxes + full vault scope) commanding narrow-context
workers beats 18 medium brains holding slices. Each delegated task runs with
the delegatee's small curated tool surface (where Qwen decision quality is
best); Kate's strategic layer sees everything that converges.

## The mechanism (Phase 1 — shipped)

### `delegate` — the sub-agent tool ([src/tools/delegate.ts](../src/tools/delegate.ts))

ONE comprehensive tool (the all-encompassing-tools rule), flat contract,
gated by the `delegate_subagents` capability (Kate only today):

- `action: 'run'` — `to` + a **self-contained** `task` + optional `context`.
  The delegatee runs a FULL turn in its own disposable context — own tool
  rounds, own token budget, its own ephemeral `delegate:<id>` conversation —
  and only a bounded digest returns. Kate's window pays for the task framing
  + the digest, never the delegatee's tool exhaust.
- `mode: 'quick'` (default) awaits up to `HEARTH_DELEGATE_QUICK_TIMEOUT_MS`
  (90s), then **degrades to background** — the run continues; the digest
  reports back as a specialist-inbox FYI (which Kate's knowledge-floor inbox
  section surfaces next turn). `mode: 'background'` detaches immediately.
- `action: 'status'` — recent delegations + digests, cordoned per user
  (system rows owner-only, the proposals-queue pattern).
- Recovery hints everywhere: unknown/missing `to` → `candidates` roster
  (connector-affordance pattern); failures return typed `next_action`s.

### `DelegationRunner` ([src/core/delegation.ts](../src/core/delegation.ts))

- **Bounded**: module-level `Semaphore` (`HEARTH_DELEGATE_MAX_CONCURRENCY`,
  default 2) so a delegation burst queues instead of starving the shared 35B
  slots. Module-level so ToolLoader hot-reloads can't widen the pool.
- **Fail-honest**: a failed/empty run marks the row failed AND reports back —
  a delegation never vanishes silently. Audited as `delegate_dispatched` /
  `delegate_completed` / `delegate_failed`.
- **Cordoned**: the originating user threads into the sub-turn (their
  visibility applies inside it), stamps the `delegations` row and the FYI's
  `originating_user_id`.
- **Kill switch**: `HEARTH_DELEGATE=0` → the tool declines with a recovery
  hint. Digest bounded via `max_tokens_override`
  (`HEARTH_DELEGATE_DIGEST_MAX_TOKENS`, default 1200).
- Narrow structural deps (`DelegationTurnRunner` etc.) so smokes inject fakes
  without the full stack. Proof: `bun run smoke:delegate` (40 checks).

### `subagent_only: true` ([src/core/specialist.ts](../src/core/specialist.ts))

The demotion lever. A flagged profile is hidden from the /app + iOS rosters
and the composer alias map — **chat surfaces only**. Everything machine-side
stays alive: deliberation slots, background jobs, inbox, grants,
**capture-intake candidacy** (amended 2026-07-03 before batch 1 — a routed
vet bill still fires Anya's prescription extractor; a demotion must never
silently lose domain intelligence, and re-owning intake is Phase 3's fold-in
job, not the flag's), and the profile stays reachable via `delegate` /
`consult_specialist`. `default_landing` + `subagent_only` is a load error.
Fully reversible by flipping the flag. **Batch 1 flipped 2026-07-03**
(owner-approved): iris, marguerite, anya, brigid, anna, eleanor, maggie.

### Why `delegate` ≠ `consult_specialist`

Consult already returns only final text, but it (a) blocks the caller's turn
for the full duration, (b) gives no async option, (c) has no record/status
surface, (d) no concurrency bound, (e) no failure report-back. Consult stays
for one-line questions; Kate's addendum steers real WORK to `delegate`.

## Hardware reality (the honest constraint)

Everything text — chat, voice, deliberation, deep consults, delegations —
shares ONE llama.cpp on the RTX 6000 Ada (`:8200`, Qwen3.6-35B-A3B).
**Bumped 2026-07-03 to `-np 4` + `--ctx-size 196608`** (4 real slots ×
49,152/slot, verified live — 36.3/49.1 GB on the Ada; unit backup
`.bak-np2`), so chat + a delegate + a background pass + one spare no longer
contend for 2 slots. Sub-agents are still not free compute — they're *cheap
context*, bounded GPU: the runner's Semaphore (default 2) is the backpressure.

## The phased path

- **Phase 0 — evidence (done 2026-07-03).** Usage data above.
- **Phase 1 — mechanism (SHIPPED).** No roster changes; `delegate` improves
  delegation to ALL existing specialists immediately.
- **Phase 2 — demote the hat-shaped heavies.** Flip `subagent_only: true` on
  specialists whose value is workflow scripts + tools, not a relationship.
  Candidates from config-weight + usage (owner decides; conversation counts
  are a proxy, not the verdict):
  - Strong candidates — **BATCH 1, FLIPPED 2026-07-03 (owner-approved)**:
    **Iris** (0 msgs/30d), **Marguerite** (0), **Anya** (3), **Brigid** (4),
    **Anna** (4), **Maggie** (2), **Eleanor** (4).
  - Borderline (recent real chat): **Kristi** (29 — Jasper's workstation
    research partner), **Luna** (28), **Linda** (23), **Vivian** (14),
    **Astrid** (11).
  - Never: **Ruby** (memorial — permanent), **Kate**, **Cordelia** (knowledge
    metabolism), **Beatrice**/**Mariah** (meta-agents; meta-loop guards
    depend on their distinctness), **Cassandra** (safety-critical surfaces).
  Each demotion: flip the flag, verify her jobs still run, add a line to
  Kate's staff map if needed. Golden tasks gate each batch.
- **Phase 3 — true fold-ins.** For profiles that stay unused as hats: grant
  their tools to Kate (her dynamic tool surface absorbs them as catalog
  lines), re-own intake handlers + background jobs, delete the YAML. Only
  after a hat proves dead weight — deleting is the irreversible step.

## Contracts for future work

- A delegation digest is the delegatee's own guarded turn output (the full
  reply-guard cascade ran inside it). Do NOT bolt a second critic onto the
  digest path without measuring; the sub-turn already pays for honesty.
- Never point `delegate` at a new parallel runner — extend `DelegationRunner`
  (status kinds, panes, working-memory lines are additive reads over the
  `delegations` table).
- A `subagent_only` profile KEEPS its capture-intake candidacy (amended
  2026-07-03, pre-batch-1): demotion hides chat surfaces, never machine work.
  Do not re-add a routing exclusion — intake moves to Kate only at Phase 3
  fold-in, deliberately, per specialist. Known cosmetic seam: the iOS Library
  tab's "routedTo" chip may name a specialist with no roster tile; fix at
  display time if it grates, never by dropping the intake.
- Ruby stays. See the top of this doc.
