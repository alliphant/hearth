# Data separation in Hearth — what the owner can and cannot see

*Last updated 2026-06-07. Describes behaviour shipped 2026-06-04 (the
"fail-closed cordon" flip) and the surfaces wired to it since.*

This document explains, in plain language, how Hearth keeps one
household member's personal data out of every other member's view —
**including the owner's view.** If you are Jasper, Sam, or Kim and you
want to know exactly what the captain of the system can and can't read
about you, this is the page. Every claim cites the file and line that
enforces it, so an engineer can verify it too.

The one-sentence version:

> **The owner runs the system, but the owner is not a super-user of
> other people's private data.** Hearth treats "the system improving
> itself" and "a person's private life" as two completely separate
> things. The first always flows up to the owner. The second is walled
> off per person — and the wall does *not* have an owner-shaped door in
> it. There is exactly one narrow, deliberate, fully-logged exception,
> described at the end.

---

## The two axes — never confuse them

Everything Hearth stores falls into one of two buckets, and they are
governed by opposite rules.

### Axis 1 — "Hearth improving itself" → flows to the owner

When the system notices a way to improve *itself* — a connector that
keeps failing, a persona that needs tuning, a code change a specialist
wants to propose, a process gap one of the back-office agents (Beatrice
the trainer, Mariah the PM) wants escalated — that is **system-
improvement work, not personal data.** It belongs to whoever runs the
system: the owner. It surfaces to the owner *regardless of which user's
session happened to trigger it.* If Sam's chat with a specialist
exposes a bug, the bug report goes to Jasper — but **the content of
Sam's chat does not.**

This is enforced structurally. Self-improvement proposals are forced to
have **no owner** at the data level — their `user_id` column is set to
`NULL`, which the queue reads as "owner-global." The set of kinds that
get this treatment is hard-coded:

- `SYSTEM_PROPOSAL_KINDS` — `recommendation`, `persona_tuning`,
  `binding_proposal`, `trusted_source_addition`, `scrum_decision`
  ([src/core/proposals.ts:243](../../src/core/proposals.ts#L243)).
- At creation time, *any* proposal of one of those kinds has its
  `user_id` overwritten with `NULL` even if a caller passed a real
  user id — `scoped_user = SYSTEM_PROPOSAL_KINDS.has(p.kind) ? null :
  p.user_id ?? null`
  ([src/core/proposals.ts:578](../../src/core/proposals.ts#L578)).

So a system-improvement proposal *cannot* accidentally be tagged to (and
hidden inside) one user's queue. It's owner-global by construction.

### Axis 2 — actual personal data → cordoned to the one person

Everything else is **a person's private life**: their chats, their
photo/voice captures, their uploads, the life-notes specialists keep
about them (Brigid's diet plan for Sam, Marguerite's family-tree
research, a journal entry, a receipt). This is cordoned to the one
user it belongs to — **and the cordon holds against the owner too.**
Jasper does not see Sam's or Kim's personal notes through search,
retrieval (RAG), the library, captures, or the proposal queue. He is,
for that data, just another caller the cordon checks.

The rest of this document is about how Axis 2 is enforced.

---

## The cordon itself — one pure function, no owner bypass

All visibility decisions for personal vault notes funnel through a
single pure function,
[`note_visible_to_caller`](../../src/memory/private_to.ts#L83)
([src/memory/private_to.ts:83](../../src/memory/private_to.ts#L83)).
It takes a note's `private_to` scope and the caller (their `user_id` +
`tier`) and returns a yes/no. The whole rule is four lines of logic:

```ts
if (!private_to) return caller.tier === 'owner';           // unset → owner-only (fail-closed)
if (value === 'owner')     return caller.tier === 'owner';
if (value === 'household') return caller.tier === 'owner' || caller.tier === 'household';
return value === caller.user_id;                           // a user id → that user, STRICTLY
```

Read the last line carefully, because it is the heart of the whole
design:

> When a note is scoped to a specific person (`private_to: sam`), it is
> visible **only if the caller's own id equals that id.** The owner's
> tier grants nothing here. **Jasper does not match `sam`, so Jasper does
> not see the note** — exactly as Kim doesn't, exactly as a stranger
> wouldn't.

There is deliberately **no `if (caller.tier === 'owner') return true`
short-circuit, and no special-case branch for Kate** (the chief-of-staff
specialist) or any acting specialist. An earlier design had a passive
"Kate can see everything" bypass; it was removed. The function's own
doc-comment states the invariant plainly: *"This is a **pure cordon —
the owner has NO blanket bypass.**"*
([src/memory/private_to.ts:58](../../src/memory/private_to.ts#L58)).

### The four scopes

| `private_to` value | Who can see the note |
|---|---|
| unset / empty | **owner only** (fail-closed default — see below) |
| `owner` | owner tier only (captain-private: finance, security) |
| `household` | owner + household members (the shared family graph) |
| `<user_id>` (e.g. `sam`, `kim`) | **that one user, strictly — not even the owner** |

A caller with no user id at all (the system's own internal passes —
deliberation, the scheduler, internal HTTP) is treated as owner tier
upstream, so it sees unset + tier-matched notes but **never** a
`<user_id>`-scoped personal note. That's the safe default for a faceless
system pass.

### Fail-closed: a forgotten stamp hides, it does not leak

The unset/empty case returns `caller.tier === 'owner'` — i.e.
**owner-only, not visible-to-everyone.** This is the "fail-closed" flip
that shipped 2026-06-04
([src/memory/private_to.ts:7](../../src/memory/private_to.ts#L7),
[:87](../../src/memory/private_to.ts#L87)). Before the flip, an unscoped
note was visible to all; after a one-time backfill stamped the legacy
notes, the default was inverted so that **a writer who forgets to label
a note hides it (owner/system-only) instead of leaking it to the whole
household.** The only notes left unstamped today are system/no-type
artifacts (the trainer's scratch files, specialist `memory.md`) which
are owner/system context anyway.

The principle: *the safe failure mode is over-hiding, never
over-sharing.*

---

## How notes get their label — `stamp_private_to_if_needed`

A note gets its `private_to` scope stamped automatically when it's
written, by
[`stamp_private_to_if_needed`](../../src/memory/private_to.ts#L159)
([src/memory/private_to.ts:159](../../src/memory/private_to.ts#L159)).
Tool authors call it right before writing to the vault; it reads the
caller's tier and a `scope_hint` and picks the right label:

| caller tier | personal note (default) | shared entity (`scope_hint: 'shared_entity'`) |
|---|---|---|
| owner | `private_to: <owner id>` | `private_to: household` |
| household | `private_to: <their id>` | `private_to: household` |
| friend | `private_to: <their id>` | `private_to: <their id>` (fully siloed) |

Three things to notice:

1. **The owner is not exempt.** An owner's *personal* note is stamped
   `private_to: <owner-id>`, the same as anyone else's. Because the
   default is now fail-closed, an unstamped owner note would already be
   owner-only — but stamping it explicitly keeps the data model honest
   and makes the owner symmetric with every other user. The function's
   own comment spells this out: *"the owner is NOT exempt; an unstamped
   note is visible to everyone, so the owner's personal notes must be
   stamped too or they leak"* — language written before the fail-closed
   flip, now belt-and-suspenders.
2. **`scope_hint: 'shared_entity'`** is the one path that produces a
   *communal* label. People and Places are the shared household graph —
   one family address book, one set of garden/venue places — so they're
   stamped `household` for owner + household members. This is how the
   family shares a contact list while a *friend's* contact entries still
   silo to the friend (the table's bottom-right cell).
3. **An explicit label always wins.** If a note already carries a
   `private_to`, the stamper leaves it alone
   ([src/memory/private_to.ts:165](../../src/memory/private_to.ts#L165)) —
   an author can deliberately set a *narrower* scope (`owner` for
   sensitive captain-only state) or a wider one.

---

## Every surface that reads personal data is cordoned

The cordon is only as good as its coverage. Here is each place a user's
data could surface, and the gate that stops it crossing the wall.

### RAG retrieval — one gate for both search paths

When a specialist answers a question, Hearth retrieves relevant vault
chunks two ways in parallel: a keyword (FTS) search and a vector
(semantic) search. **Both share one visibility gate**, so there's no way
for the semantic path to surface something the keyword path would have
hidden. The gate is `_chunk_gates` in the memory client
([src/memory/client.ts:406](../../src/memory/client.ts#L406)); it builds
a `visible_to_user(note_path)` predicate that calls
`note_visible_to_caller` under the hood
([src/memory/client.ts:454](../../src/memory/client.ts#L454)).

- Keyword path (`retrieve_scoped_chunks`) applies it at
  [src/memory/client.ts:373](../../src/memory/client.ts#L373).
- Vector path (`vector_search`) applies the **same** gate at
  [src/memory/client.ts:540](../../src/memory/client.ts#L540).

So a semantic hit on another user's private note is dropped exactly as a
keyword hit would be. (There is a `bypass_private` flag at
[src/memory/client.ts:455](../../src/memory/client.ts#L455), but it
exists **only for system/product reads** — e.g. a shared product catalog
— and is never used for personal notes.)

### Unified search — chat, vault, and proposals all filtered

The `/api/search` route ([src/app/routes/search.ts](../../src/app/routes/search.ts))
returns three kinds of results and cordons each:

- **Chat** is filtered by *conversation ownership*. A helper resolves
  each conversation's owning `user_id` and only shows it if the caller
  owns it; legacy ownerless conversations show to the owner only
  ([src/app/routes/search.ts:85](../../src/app/routes/search.ts#L85)).
- **Vault** results LEFT JOIN the clipping's `private_to` column and run
  every hit through `note_visible_to_caller` before returning it
  ([src/app/routes/search.ts:115](../../src/app/routes/search.ts#L115),
  filter at [:127](../../src/app/routes/search.ts#L127)).
- **Proposals** are filtered the same way the queue is (below): the
  owner sees system (NULL) + their own; a non-owner sees only their own
  ([src/app/routes/search.ts:144](../../src/app/routes/search.ts#L144)).

### The proposal queue

The proposal list applies the per-user cordon directly in SQL: an
**owner** sees `(user_id IS NULL OR user_id = @me)` — system proposals
plus their own; a **non-owner** sees `user_id = @me` — *only* their own,
never the system/self-improvement ones
([src/core/proposals.ts:665](../../src/core/proposals.ts#L665)). Note
the asymmetry is the *correct* one: the owner sees more **system** work
(Axis 1), but **not** more **personal** proposals (Axis 2) — a
non-owner's `draft_message` or `calendar_event` proposal stays theirs.

### Library and the file manager

- Library notes carry a `private_to` column too. A direct user upload is
  stamped to the uploader (`private_to: c.get('user')?.id`)
  ([src/app/routes/library.ts:690](../../src/app/routes/library.ts#L690)),
  while system curation of shelf-wide reference material leaves it NULL
  ([src/app/routes/library.ts:500](../../src/app/routes/library.ts#L500)).
  The unified search then filters library hits for the caller, as above.
- The **`/files` file manager is owner-only, full stop** — it returns
  `403 the file manager is owner-only` to anyone else
  ([src/library/router.ts:63](../../src/library/router.ts#L63)).
  Household and friend users work with curated libraries, not the raw
  tree.

### Captures (photos, voice memos, shared text)

Every capture that comes in through Cordelia's pipeline is auto-stamped
with the uploader's id and tier before it's written
([src/app/routes/cordelia.ts:257](../../src/app/routes/cordelia.ts#L257)),
so a photo Sam captures is `private_to: sam` from the moment it lands.
The capture-listing endpoints re-apply the same `note_visible_to_caller`
filter when serving recent captures
([src/app/routes/cordelia.ts:414](../../src/app/routes/cordelia.ts#L414)).

### Specialist profile panes

When a household member opens a specialist's profile/office pane, the
composer is told whether the viewer is the owner
(`viewer_is_owner: user?.tier === 'owner'`,
[src/app/routes/specialists.ts:930](../../src/app/routes/specialists.ts#L930)).
Team-ops internals — Kate's team-health blocks, recommendation cards,
the back-office machinery — render only for the owner; a non-owner sees
their own brief, not household-wide activity or proposals.

---

## The one sanctioned cross-user path — `review_user_activity`

There is exactly **one** place where the owner can deliberately reach
across the cordon, and it is built to be loud, narrow, and logged.

The owner can ask Kate "what has Sam been up to lately?" and get back a
*summary* — counts of actions, captures, conversation topics over a time
window — via the
[`review_user_activity`](../../src/specialists/kate/tools/review_user_activity.ts)
tool. It is protected two ways:

1. **A capability grant** (`owner_oversight`) that only Kate holds, and
2. **A hard runtime check** that refuses unless the caller is literally
   the owner — `if (ctx.user && ctx.user.tier !== 'owner') { return …
   'owner-only … Decline this request.' }`
   ([src/specialists/kate/tools/review_user_activity.ts:102](../../src/specialists/kate/tools/review_user_activity.ts#L102)).
   The capability grant alone isn't trusted; the tier check is
   defence-in-depth behind it.

And every use writes an oversight audit row — *who reviewed whom, over
what window* — as `owner_oversight_review`
([src/specialists/kate/tools/review_user_activity.ts:231](../../src/specialists/kate/tools/review_user_activity.ts#L231)).
So the crossing is never silent; it leaves a permanent trail.

Three things make this *not* a god-view:

- It returns a **summary**, not the raw notes/chats/photos. It reads the
  audit trail and topic tallies, not the private content itself.
- It is **explicit and pull-based** — the owner has to ask, by name, for
  one user, for one window. There is no passive, always-on visibility.
- It is **logged every time.** Oversight that can't itself be audited
  isn't oversight.

Everywhere *other* than this one tool, the owner is just another caller
the cordon checks.

---

## How to keep it that way (for engineers)

When you add a new surface that reads or writes personal data:

- **Writing a vault note?** Call `stamp_private_to_if_needed(fm, caller)`
  before `upsert_note` — pass `'shared_entity'` *only* for People/Places.
  Forgetting to stamp is now safe (fail-closed → owner-only) but is still
  a bug: the note should be visible to its real owner.
- **Reading notes/chunks?** Go through `retrieve_scoped_chunks` /
  `vector_search` (they apply `_chunk_gates` for you) or call
  `note_visible_to_caller` directly. Never read raw rows and skip the
  gate.
- **A new list/search endpoint?** Cordon it the way the proposal queue
  and `/api/search` do: `(user_id IS NULL OR user_id = caller)` for the
  owner, `user_id = caller` for everyone else.
- **Never** add an `if (owner) return true` bypass. The single sanctioned
  cross-user path already exists (`review_user_activity`); any second one
  is a design error.

---

## Proof — verify it yourself, live, from Settings

You don't have to take any of this on faith. **Settings → Privacy & Data**
runs a *live* self-test from your own account: it actually tries to reach
other members' data **as you** — through the AI's knowledge retrieval, the
proposals queue, and your conversations — and shows you the result, e.g.
*"12 items belong to other household members; 0 reachable by you."* If a
change ever broke the cordon, that number would be non-zero and the check
would turn red. The same page shows your owner-oversight history — every
time (if ever) the owner pulled a *summary* of your activity — under a 🔒
**"tamper-evident record"** badge: every audit entry is HMAC-chained to the
one before it ([audit_chain.ts](../../src/core/audit_chain.ts)), so an edit
or deletion breaks the chain and is caught by re-walking it
(`bun run verify:audit-chain`). The chain key lives only in the
orchestrator's environment, so a backup or a database dump can't be edited
and re-sealed. (Backend:
[run_privacy_self_test](../../src/core/privacy_self_test.ts) behind
`GET /api/users/privacy/report`; concept + roadmap in
[provable-cordon-concept.md](provable-cordon-concept.md).)

## Proof — the tests that hold the line

Three smoke tests assert this behaviour and will fail loudly if a change
regresses it:

- **`bun run smoke:privacy`**
  ([scripts/smoke-privacy.ts](../../scripts/smoke-privacy.ts)) — asserts
  the proposal split (system kinds forced to NULL; owner sees NULL+own,
  non-owner sees only own) and the `review_user_activity` oversight tool
  (refuses non-owner, writes the `owner_oversight_review` audit row).
- **`bun run smoke:multiuser`**
  ([scripts/smoke-multiuser.ts](../../scripts/smoke-multiuser.ts)) — the
  full visibility/stamp matrix, explicitly asserting the inverted owner
  semantics: that `note_visible_to_caller` gives the owner **no** bypass
  on a `<user_id>`-scoped note, and that stamping routes personal →
  `<user_id>`, shared entity → `household`, friend → fully siloed.
- **`bun run smoke:privacy-self-test`**
  ([scripts/smoke-privacy-self-test.ts](../../scripts/smoke-privacy-self-test.ts)) —
  the member-facing live self-test (the Settings → Privacy & Data panel):
  exercises the REAL `retrieve_scoped_chunks` / `proposals.list` /
  `conversations.list` surfaces as a friend and a household member, asserts
  other members' data exists yet 0 is reachable, includes the anti-vacuous
  guard (the caller CAN reach their own note, so a pass is meaningful), the
  leak-verdict logic, and the oversight-history surfacing.

(Script names are mapped in [package.json:69](../../package.json#L69).)

---

## Summary

- **Two axes, opposite rules.** System self-improvement → the owner,
  always. Personal data → the one person, including *from* the owner.
- **One pure cordon** (`note_visible_to_caller`) with **no owner
  bypass**, **fail-closed** by default.
- **Auto-stamping** scopes each note correctly at write time; People and
  Places are the only communal exception.
- **Every read surface** — RAG (both paths), search, proposals, library,
  the file manager, captures, profile panes — applies the cordon.
- **One deliberate, owner-only, fully-audited exception**
  (`review_user_activity`) that returns a *summary*, never raw content.
- **Two smoke tests** lock the behaviour in.
