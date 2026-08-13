# Concept — the *provable* cordon: from "trust us" to "watch it fail to peek"

> **STATUS: Phase 1 SHIPPED 2026-06-26 — slice 1 (live self-test + panel +
> oversight history) AND slice 2 / Phase 1b (the tamper-evident audit
> ledger). Phase 2 (boundary encryption) and off-box anchoring (Phase 1.5)
> remain concept, awaiting a go.** The design forks for Jasper are in **§0**.
>
> **Slice 1** — the "Privacy & Data" panel in Settings →
> `GET /api/users/privacy/report`:
> - Engine [src/core/privacy_self_test.ts](../../src/core/privacy_self_test.ts) —
>   runs the REAL cordoned read surfaces (`retrieve_scoped_chunks`,
>   `proposals.list`, `conversations.list`) AS the caller and reports
>   "{N} items belong to other members — {reachable} reachable by you"
>   (LAW #1: a regression turns it RED, it doesn't print green).
> - Route [src/app/routes/privacy.ts](../../src/app/routes/privacy.ts)
>   (nginx-safe `/api/users/*`), audited as `privacy_self_test`.
> - UI: `settings_privacy()` in [app.js](../../src/app/client/app.js).
> - Proof: `bun run smoke:privacy-self-test` (20 checks).
>
> **Slice 2 / Phase 1b** — the tamper-evident audit ledger
> ([src/core/audit_chain.ts](../../src/core/audit_chain.ts)):
> - `MemoryClient.log_action` HMAC-chains every audit row to the previous one
>   (`row_hash = HMAC(KEY, prev ‖ canonical(row))`) inside a `BEGIN IMMEDIATE`
>   transaction (cross-process-atomic), **fail-open** to a plain insert.
> - `subject_user_id` audit column (Phase 1a mechanism) — set on
>   `review_user_activity`, so oversight surfaces on the subject's panel.
> - The panel shows a 🔒 **"Verified — entries form an unbroken chain"** badge
>   (`verify_audit_chain` over a recent window); full genesis-anchored proof
>   via `bun run verify:audit-chain`; seal history with
>   `bun run backfill:audit-chain`.
> - HMAC KEY lives in `HEARTH_AUDIT_CHAIN_KEY` (env only — defeats the
>   in-scope developer/backup editor; the owner-on-box is trusted). Kill
>   switch `HEARTH_AUDIT_CHAIN=0`.
> - Proof: `bun run smoke:audit-chain` (23 checks — chain forms, edit/delete
>   detected, key matters, kill switch, reseal, recent-window).

*Author: Claude. Date: 2026-06-20 (Phase 1 shipped 2026-06-26).*

## Why

Hearth already has a real per-user cordon — one pure function,
[`note_visible_to_caller`](../../src/memory/private_to.ts#L83), gating every
read surface, fail-closed, with **no owner god-view**. That's documented for
both members and engineers in
[data-separation.md](data-separation.md). It works.

But it is **promised, not provable**, in two specific ways:

1. **A member can't see or verify it.** Sam has no way, from her own phone,
   to *know* that Jasper can't read her chats. She has to trust the code (and
   trust that Jasper trusts the code). The only "proof" today is two smoke
   tests an engineer runs — invisible to her.
2. **It's access control, not opacity.** The vault and SQLite DB are
   **plaintext on disk**. The cordon provably stops *the AI and the app
   surfaces* from showing Sam's data to Kim. It does **nothing** to an
   artifact that leaves the box — a backup blob, the git repo, a dev clone,
   a Claude session's filesystem reach. Anyone holding one of those holds
   everyone's raw private content.

This concept closes both gaps. It makes the cordon **legible** (the member
understands it), **verifiable** (the member can prove it holds, live, as
themselves), and **opaque at the boundary** (nothing readable leaves the
box) — without changing the part that already works.

## The threat model — Jasper's contract (decided 2026-06-20)

A provable cordon is only meaningful against a *named* adversary set. Jasper
set it explicitly. This is the spec the rest of the doc serves.

**Must be provably unable to read a member's private chats / captures / notes:**

- **The AI & app surfaces.** No specialist, RAG/search result, proposal,
  capture list, file manager, profile pane, or voice turn ever surfaces one
  member's private content to another. *Enforced today by the access-control
  cordon; this concept makes it visible + self-verifiable to the member.*
- **The developer & backups.** Any artifact that crosses the live box's trust
  boundary — an offsite/cloud backup, the git-tracked repo, a dev clone, the
  filesystem a Claude Code session can reach — must be **opaque**: it cannot
  yield a member's raw private content. *New work (Phase 2 + guards).*

**Deliberately trusted — OUT of scope by Jasper's choice:**

- **The owner with live server access.** It's his box; he can read on-box.
  Crucially, this is *"trusted," not "invisible"* — see the elegant
  consequence below.
- **External attacker / stolen device.** Out of the current model (the
  orchestrator is LAN/Tailscale-bound, never WAN-exposed). Phase 2 boundary
  encryption raises this bar *incidentally*, but it isn't the design target.

### The load-bearing reading of that contract

These picks have one clean architectural meaning:

> **Trust the live box and the owner. Encrypt at the trust boundary.**

Inside the live box, plaintext is fine — the owner is trusted, the AI needs
to read it, and performance matters. The moment data crosses *out* (backup,
repo, dev clone, offsite copy), it must be ciphertext keyed to something the
owner holds and the artifact does not. This is **dramatically simpler than
per-user end-to-end encryption** (which would be required only if
"owner-with-server-access" were in scope — it isn't) and it maps exactly onto
the picks.

And the consequence that makes "owner trusted" palatable to a member:

> **Owner-trusted ≠ owner-invisible.** The owner can technically read on-box,
> but the *only sanctioned, non-destructive* way to reach a member's data —
> `review_user_activity` — is **logged to that member** (Phase 1's access
> ledger). The captain keeps the keys to the house; the residents still get a
> doorbell camera on their own door.

---

## §0 — Decisions for Jasper (sign-off gates)

The big two (threat model + phasing) are already decided. These are the
remaining sub-forks; recommendation first in each, with the why.

**D0.1 — Access-ledger tamper-evidence.** "Provable" includes "the log of who
touched my data can't be quietly rewritten." How hard?
- **(Recommended) Append-only hash-chain, on-box.** Each ledger row carries
  `prev_hash` + `row_hash = H(prev_hash ‖ canonical(row))`; any edit/delete
  breaks the chain and is detectable by recomputation. Cheap, no infra,
  re-uses the existing audit write path. *Caveat stated plainly:* a chain
  detects tampering but the owner with DB access could recompute the whole
  chain after an edit — so this defends against silent corruption + a dev/AI
  rewrite, not against a determined owner. That matches the threat model
  (owner trusted).
- Hash-chain **+ off-box head anchoring.** The member's app remembers the last
  chain-head hash it saw; a later truncation/rewrite is detectable
  *client-side* even by the owner. One more rung, defends the
  owner-rewrite case too. Recommend designing the row shape for this now,
  shipping it Phase 1.5.
- External append-only sink (a tiny write-only audit service). Strongest,
  most infra. Defer.

**D0.2 — Backup encryption tool.** What makes a backup opaque?
- **(Recommended) [`age`](https://age-encryption.org).** Recipients = the
  owner's public key; the private key never goes in the backup. Modern,
  file-based, one binary, trivially scriptable into the existing backup job.
- libsodium sealed-box in-process (Bun has WebCrypto / we can vendor a
  sealed-box). No external binary, but we own the format.
- restic/borg native encryption. Great if we adopt one of those as the backup
  engine anyway; otherwise it's a bigger dependency than the job needs.

**D0.3 — On-box at-rest encryption (the strongest, optional tier).** Do we go
beyond the boundary and encrypt live data *on the box* so even an on-box dev
session can't read it?
- **(Recommended) Defer.** Jasper's picks don't require locking the owner (or
  an on-box dev session) out of live data. The realistic "developer" worry —
  a Claude session reading private content — is already covered by *operational
  scoping + audited, member-visible access* (Phase 1/2c). True on-box
  encryption needs an owner-gated unlock (passphrase at boot / hardware token
  / TPM-sealed key), which costs headless auto-restart. Not worth it for the
  stated model.
- Ship it. Only if Jasper later wants "even I, on the box, see ciphertext for a
  member's private notes unless they're actively in use." This is the natural
  home if "owner-with-server-access" is ever added to the threat model.

**D0.4 — Self-test surface.** Who can run the live "Prove it" check?
- **(Recommended) Member-first.** Each member runs it on their own data, from
  their own session. That's the trust-building moment.
- Member + a household "privacy health" badge (a green ✓ everyone can see that
  the last self-test passed). A nice ambient signal; layer it on after.

*(Defaults below assume D0.1=hash-chain now / anchor-ready, D0.2=`age`,
D0.3=defer, D0.4=member-first. Say the word and I'll re-cut.)*

---

## Phase 1 — Make the existing cordon legible + member-verifiable (no crypto)

This is the **"understand and know"** half, and it delivers most of the felt
trust on its own. Four pieces, all built on surfaces that already exist.

> **Build status (2026-06-26):** 1a (subject-stamped — `subject_user_id`
> column, set on owner-oversight), 1b (hash-chained ledger — `audit_chain.ts`,
> `prev_hash`/`row_hash` columns, the panel integrity badge + `verify`/
> `backfill` CLIs), 1c (live self-test), and 1d (privacy panel) are all
> **shipped**. Remaining: broadening `subject_user_id` to any future
> cross-cordon path (the mechanism is in place — pass it to `log_action`), and
> off-box head-hash anchoring (Phase 1.5).

### 1a — The member-readable access ledger ("Who touched my data")

Today's [`audit_log`](../../src/memory/stores/structured.ts#L134) records the
**actor** (`user_id` = who triggered the row). For a member-facing access log
we need the missing half: the **subject** — *whose data* a read/write touched.
We already know it at the chokepoint: `note_visible_to_caller` is called with
the note's `private_to`, so the subject is in hand at the exact moment of
every gated access.

- **Concept:** stamp a `subject_user_id` (the data owner) on audit rows for
  personal-data reads/writes. For the overwhelming majority, actor == subject
  (you reading your own things — summarized, not itemized). The rows that
  matter are **actor ≠ subject** — a cross-cordon access. By the cordon's own
  design those can *only* be `review_user_activity` (owner oversight) or a
  system/admin/dev path. Those are exactly what a member wants surfaced.
- **Surface:** `GET /api/me/access-log` — each member reads *their own subject
  ledger* (cordoned by construction; you only ever see accesses *to your
  data*). Rendered in plain language: *"Jun 18 — Jasper ran an activity review
  over your last 7 days."* (the `owner_oversight_review` row, surfaced to the
  subject). If any dev/admin/system path ever reads her content, it appears
  here too.
- **The property this buys:** *every cross-cordon access to a member's data,
  including the owner's one sanctioned oversight path, is visible to that
  member.* This is what makes "owner trusted but not invisible" concrete.

### 1b — Tamper-evidence on the ledger

A log you can't trust isn't proof. The audit log is plaintext SQLite +
markdown today (editable). Make the ledger **append-only + hash-chained**
(D0.1): each row links to the previous via `row_hash = H(prev_hash ‖
canonical(row))`. Any deletion or edit breaks the chain; a member (or an
auditor) can recompute and verify it. Design the row to carry the head hash so
the member's app can remember it and later detect a truncation off-box
(Phase 1.5). This re-uses the existing dual-write `log_action` path — it's an
additive column + a hash step, no new store.

### 1c — The live "Prove it" self-test (the centerpiece)

The engineer-facing smokes (`smoke:privacy`, `smoke:multiuser`) already *prove*
the cordon holds — but only to an engineer, against fixtures. Turn that into a
**member-facing, live demonstration**: a one-tap action on the member's privacy
page that, *from their own authenticated session against the real running
system*, attempts to peek and shows it being blocked:

- Search / RAG for content known to belong to another member → returns nothing.
- Attempt to open another member's note / capture id directly → blocked.
- Confirm the file manager refuses them, their captures are theirs, their
  proposals are theirs.

Result rendered as a green checklist: *"We just tried to reach another
household member's data **as you**, 7 different ways. All 7 were blocked.
Here's exactly what we tried, and what came back."* This is the difference
between *"trust our tests"* and *"watch the system fail to peek, live, as
you."* The probes are read-only, audited, and reuse the very cordon functions
they're testing — so a passing self-test is a statement about the *production*
code path, not a parallel mock.

### 1d — The plain-language privacy page (legibility)

An in-app version of [data-separation.md](data-separation.md), *personalized*:
"Here is exactly who can see your stuff." It renders the member's own scopes,
the single sanctioned exception (owner oversight) annotated with *their actual
oversight history* pulled from the ledger (1a), and the "Prove it" button (1c).
The "understand" half; 1a/1c are the "know/verify" half.

---

## Phase 2 — Boundary encryption (developer & backups: opaque)

Plaintext stays *inside* the live box (owner trusted, the AI reads it,
performance). Everything that crosses *out* becomes ciphertext keyed to
something the owner holds and the artifact does not.

### 2a — Encrypt at the boundary

- **Backups → opaque.** The backup job encrypts the vault + DB snapshot to the
  owner's public key (D0.2: `age`); the private key never enters the backup.
  An offsite/cloud/stolen backup is then ciphertext — unreadable by a thief, a
  cloud provider, or a developer poking at it. The owner restores by supplying
  the key from the live box / his keychain. *(Verifiable trivially: try to read
  a backup file — it's noise.)*
- **The repo → never carries private content.** Mostly already true (the vault
  is separate from the repo), but make it *enforced* with a guard in the
  `bun run guard` family — fail the commit if vault-shaped/personal content or
  a secret key ever lands in tracked source. Same shape as `guard:encoding` /
  `guard:time`.
- **Dev clones & dev sessions → no production key, audited live reads.** A dev
  session never holds the backup/boundary key. Dev work defaults to synthetic
  or redacted fixtures (the repo already has a strong `HEARTH_TEST_MODE` +
  fixture culture). Any read of *live* private content is gated + audited +
  **surfaced to the member** via the Phase 1 ledger — so a developer reading a
  member's data is structurally unable to do it silently.

### 2b — (Optional, deferred — D0.3) On-box at-rest encryption

If Jasper ever wants even an *on-box* reader unable to see live private content:
encrypt the vault/DB at rest, releasing the key only on the owner's interactive
unlock (passphrase at boot / hardware token / OS keyring the orchestrator
authenticates to). Trade-off: the orchestrator can't fully auto-restart
headless without the owner (or a TPM-sealed key). Recommended **deferred** —
the audited, member-visible access of Phase 1 already covers the realistic
dev-session worry.

### 2c — Forward-compat: per-user keys map onto the existing scopes

If the threat model ever extends to *"owner-with-server-access: no"* (not
picked today), the same boundary machinery generalizes cleanly: wrap each
member's content with a per-user key — escrowed to the owner (owner can
*recover* but doesn't passively read) or held client-side (true E2E). The key
point for *today's* design: **the `private_to` scopes and the `stamp_*`
partition are already the exact unit a per-user key would attach to.** One key
per scope value. So shipping Phase 1 + 2a paints us into no corner; per-user
crypto is an additive future, not a rewrite.

---

## What "provable" means, layer by layer

| Claim a member can make | What proves it | Phase |
|---|---|---|
| "The AI can't show my data to others" | The **live self-test** runs cordon probes *as me* and shows them blocked | 1c |
| "Every time someone reached my data, I can see it" | The **member-readable access ledger** (incl. owner oversight) | 1a |
| "That log hasn't been quietly edited" | **Hash-chained** ledger; recompute to verify | 1b |
| "I understand who can see what" | The **personalized privacy page** | 1d |
| "My data is useless if it leaves the box" | **Read a backup file — it's ciphertext** | 2a |
| "A developer can't peek silently" | No prod key off-box + **every live read shows in my ledger** | 2a |
| "An engineer can audit the rule itself" | One pure function + smokes + the self-test exercises prod code | exists + 1c |

The throughline: a member never has to take anyone's *word*. They can **watch
it fail to peek** (1c), **see who reached in** (1a, tamper-evident via 1b), and
**confirm exports are noise** (2a).

---

## What this builds on (already in the tree)

The design deliberately extends existing mechanisms rather than inventing:

- **The pure cordon** [`note_visible_to_caller`](../../src/memory/private_to.ts#L83)
  and `stamp_private_to_if_needed` — the self-test (1c) and the subject stamp
  (1a) call the same functions, so proof tracks production.
- **The dual-write audit log** ([`log_action`](../../src/memory/client.ts),
  schema at [structured.ts:134](../../src/memory/stores/structured.ts#L134)) —
  the access ledger is an additive `subject_user_id` + `prev_hash`/`row_hash`
  on this path, not a new store.
- **The one sanctioned oversight path** [`review_user_activity`](../../src/specialists/kate/tools/review_user_activity.ts)
  — already audited; 1a just *surfaces that row to its subject*.
- **The smoke culture** (`smoke:privacy`, `smoke:multiuser`) — the live
  self-test is these assertions, re-pointed at the running system with the
  member's real identity.
- **`config/privacy.yaml` + `privacy.ts`** — the natural home for the
  self-test roster, ledger retention, and the boundary-encryption toggles.
- **The SSE bus** ([events.ts](../../src/app/events.ts)) — the privacy page and
  ledger live-update like every other surface.
- **The `guard:*` family** — the "no private content / no key in the repo"
  check (2a) is one more guard.

---

## Security checklist (what an implementation must satisfy)

- [ ] **Access ledger is subject-aware:** every gated personal-data read/write
      records `(actor, subject, surface, what, when)`; the member reads *their
      own subject ledger* and nobody else's.
- [ ] **Every cross-cordon access is in the ledger** — including
      `review_user_activity` (surfaced to its subject) and any system/dev path.
      No personal read bypasses the ledger.
- [ ] **Ledger is append-only + hash-chained;** an edit/delete is detectable by
      recomputation; row shape ready for off-box head anchoring.
- [ ] **The self-test runs against production code paths** (the real cordon
      functions), as the member's real identity, read-only and audited — never
      a parallel mock.
- [ ] **Backups are ciphertext at rest;** the decryption key is never in the
      backup, the repo, or any LLM-readable surface.
- [ ] **A guard fails the build** if personal/vault content or a secret key
      lands in tracked source.
- [ ] **Dev sessions hold no production boundary key;** live private reads are
      gated, audited, and surfaced to the member.
- [ ] **The owner gains no new reach** — Phase 1 only *reveals* the existing
      sanctioned path to its subject; it does not add a cross-cordon read.
- [ ] **Fail-closed preserved** — none of this weakens the existing unset →
      owner-only default or adds an `if (owner) return true` bypass.
- [ ] **Kill-switchable + smoke-covered** — new surfaces gated, with a
      `smoke:provable-cordon` asserting subject stamping, ledger chain
      integrity, the self-test verdicts, and (Phase 2) backup opacity.

---

## Rollout

1. Jasper signs off on **§0** (ledger strength, backup tool, on-box defer,
   self-test scope).
2. **Phase 1:** subject-stamp the ledger (1a) → hash-chain it (1b) → the
   member access-log route → the live self-test (1c) → the privacy page (1d).
   Add `smoke:provable-cordon`.
3. **Phase 1.5:** off-box head-hash anchoring in the member app (D0.1 rung 2).
4. **Phase 2:** `age`-encrypt the backup job (2a) → the repo/secret guard →
   document the dev-session posture. Extend the smoke to assert backup opacity.
5. **(If ever)** Phase 2b on-box at-rest encryption / 2c per-user keys — only
   if the threat model extends to owner-with-server-access.
6. Docs: ship-log entry, an `architecture.md` "provable cordon" note, and fold
   the member-facing parts back into [data-separation.md](data-separation.md)
   so the plain-language page and this concept stay in sync.

---

## Summary

- **The cordon already holds; this makes it *provable to the member*** — they
  watch it fail to peek (live self-test), see who reached in (subject-aware,
  tamper-evident ledger), and confirm exports are noise (boundary encryption).
- **Threat model (Jasper's):** defeat the AI/app surfaces *and* the
  developer/backups; trust the owner-on-box and leave external attackers out —
  which reads cleanly as *"trust the live box, encrypt at the boundary."*
- **Owner-trusted ≠ owner-invisible** — the one sanctioned oversight path
  becomes visible to its subject.
- **No corner painted** — per-user keys, if ever wanted, attach 1:1 to the
  `private_to` scopes that already exist.
- **Concept only. Nothing ships until the go.**
</content>
</invoke>
