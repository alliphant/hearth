# Phase 2b — Per-user memory & vault isolation with discretion model

You're picking up Hearth multi-user where Phase 2a left off. Phase 1
landed cookie auth + PIN-pad login; Phase 2a scoped conversations,
proposals, inbox, and the specialist roster by `c.get('user')`. Phase
2b is what's needed to safely allow Sam — and any future household
member — to talk to specialists without leaking Jasper's data.

Sam's user account is intentionally **dormant** (`pin_hash: null`
in `config/users.yaml`) until this work ships. The login screen
filters dormant users; verify_pin would reject her anyway because
pin_hash is null. **Do not re-enable her PIN until Phase 2b is
verified end-to-end.** To re-enable: copy her pin_hash back from
`/home/jasper/docker/homeassistant_config/www/friday_intel/friday_users.json`.

## The mental model (Jasper's framing)

> "I'm the captain of the spaceship and this is my crew. Kate's my
> second in command."

- **Captain (Jasper)** — full visibility, full discretion. The default
  user every legacy code path assumes.
- **First officer (Kate)** — household-wide visibility on purpose
  (Chief of Staff). She sees everything I see; her persona prompt
  carries the discretion rules about what to share with whom.
  Specialists defer to her on sensitive questions about Jasper or his
  data.
- **Crew (other specialists)** — domain-scoped. Each has a per-
  specialist policy below describing what they share with non-Jasper
  users.
- **Crew member (Sam)** — a household user with her own private
  context who interacts with a subset of the crew. Her data about
  herself is hers; she does NOT have visibility into Jasper's data
  unless a specialist explicitly judges it sharable.

## Per-specialist discretion policy

Encode this in each specialist's YAML as a new `discretion:` block,
read by the SpecialistRuntime when building the system prompt.

| Specialist | Shares with Sam | Sam's own data tracked? | Defers to Kate |
|---|---|---|---|
| **Kate** | (Chief of Staff — she IS the discretion layer) | Yes, separately | n/a — she IS Kate |
| **Vivian** (Finance) | **Nothing about Jasper.** Full stop. | No — Vivian is Jasper-only | Yes — refuses, suggests asking Kate |
| **Marguerite** (Family Historian) | Jasper's family tree openly | Yes — Sam's family tree tracked independently | On sensitive items only |
| **Brigid** (Cook) | Diet info openly between household members | Yes — separate dietary block per user (already exists in users.yaml) | No — diets are inherently shared |
| **Cassandra** (Security) | **Only Kate and Jasper.** Sam gets a polite refusal. | No | Yes — refuses, suggests Kate |
| **Eleanor** (Gardener) | Garden state openly (it's the house garden) | Sam can add observations | No — it's a shared resource |
| **Anya** (Vet) | Pet records openly (household pets) | Sam can log observations | No |
| **Iris** (EV & HA) | Car/home state requires Jasper's car? Default: defer to Kate. Sam can ask about whole-house things (HVAC) but not Jasper's specific car/charge. | No | On Jasper-specific items |
| **Cordelia** (Librarian) | Shared library is shared; Jasper's private items are Jasper's | Sam has her own library scope | On sensitive items |
| **Maggie** (Media) | Open — household media is shared | Sam has her own taste-graph | No |
| **Trainer / Mariah** (Internal staff) | Not visible to Sam at all (not in `allowed_specialists`) | n/a | n/a |

Encode this as YAML, not prose, e.g.:

```yaml
# config/specialists/vivian.yaml
discretion:
  visibility_default: jasper_only      # one of: open | jasper_only | per_user
  cross_user_disclosure: refuse        # what to do if Sam asks about Jasper
  defer_to: kate                       # who Vivian routes Sam to instead
  per_user_tracking: false             # does Vivian track Sam independently?
```

```yaml
# config/specialists/brigid.yaml
discretion:
  visibility_default: open
  cross_user_disclosure: share
  per_user_tracking: true              # per-user dietary blocks already exist
```

```yaml
# config/specialists/marguerite.yaml
discretion:
  visibility_default: open
  cross_user_disclosure: share
  per_user_tracking: true              # Sam's family tree is hers
  sensitive_topics_defer_to: kate      # for genuinely sensitive ancestry findings
```

```yaml
# config/specialists/cassandra.yaml
discretion:
  visibility_default: jasper_only
  cross_user_disclosure: refuse
  defer_to: kate
  per_user_tracking: false
  # Hard rule: Cassandra answers only to Kate and Jasper. Any other
  # caller (allowed_specialists list still gates whether she's even
  # visible) gets a courteous refusal pointing at Kate.
  allowed_callers: [jasper, kate]
```

Schema lives in `src/core/specialist.ts` (DiscretionSchema). Existing
specialists default to `visibility_default: open` if the block is
omitted — minimally disruptive to call sites that don't care.

## What this phase touches (file inventory)

### Backend
1. **`src/core/specialist.ts`** — add `DiscretionSchema`, attach to
   `SpecialistConfig`. Defaults preserve current open behavior.
2. **`src/core/specialist_runtime.ts`** — the scaffolding for `user`
   on `SpecialistTurnInput` is already there (added in this turn but
   not connected). Wire:
   - Route handlers (specialists.ts, chat.ts, library.ts) pass
     `user: c.get('user')` into every `turn()` / `turn_streaming()`.
   - System-prompt builder adds a "**Currently talking to: <Name>**"
     line plus the discretion-policy-rendered-as-instructions.
   - Hard refusal short-circuit: if `user.id` ∉ `allowed_callers` AND
     the specialist has that field set, the runtime returns a canned
     refusal message ("I only discuss this with Jasper and Kate —
     would you like to ask Kate?") without calling the LLM at all.
3. **`src/core/memory_files.ts`** — per-user path resolution already
   in place (`memory_<user_id>.md`, Kate exempt). Wire:
   - Every `read_memory_tail` / `append_to_memory` caller (deliberation,
     loops, scribe writes) takes a `user_id` param.
   - Pre-existing `memory.md` content stays as Jasper's (legacy default).
4. **`src/memory/client.ts`** — `retrieve_scoped_chunks` already
   accepts `user_id` + `bypass_private`. Wire all remaining callers
   (search_library tool, anything else doing FTS).
5. **`src/memory/schemas/`** — add an optional `private_to: string`
   field to every frontmatter schema (Person, Journal, Decision,
   Clipping). Default is unset (= shared).
6. **`src/memory/client.ts` write paths** — when a specialist appends
   a journal entry for Sam, set `private_to: sam` on the new note
   automatically. Generic rule: if the calling user is non-default
   and the note is in a per-user namespace, stamp private_to.
7. **Audit log** — add a `user_id` column (or stash inside `tool_input`
   for backward compat). At minimum, every `log_action` call should
   carry the caller's user so an admin can later answer "what did
   Sam look at?"
8. **Tool surface review**: walk every tool's `execute()` for code
   paths that return Jasper-specific data unconditionally. Pre-marked
   targets:
   - `friday_status`, `ha_get_my_location`, `plex_now_playing`,
     `music_recent_tracks`, `media_library` — all return Jasper's
     state. Either gate on caller user_id, or pass through and trust
     the persona-prompt + Kate-defer rules.
   - `read_friday_pets` — household pets, share openly.
   - `query_audit_log` — gate to Jasper + Kate only (audit log is
     household-private operational state).

### Frontend
1. **Settings → Admin → Users** — the panel I almost built before you
   paused me. Lists users, lets admin curate `allowed_specialists`,
   toggles `pin_hash` enabled/disabled (re-enable Sam from here once
   ready).
2. **Conversation footer hint** — when Kate is the active specialist
   and the calling user is not Jasper, render a discreet "Kate has
   discretion — she may decline to discuss Jasper-specific topics"
   tooltip on the bubble. Same in reverse for Vivian/Cassandra.

### Vault
1. **`~/vault-friday/Knowledge/<Specialist>/memory_sara.md`** — empty
   files seeded for each specialist Sam can talk to. Optional; the
   loader handles missing-file = empty-tail.
2. **Existing `memory.md` files** — implicitly Jasper's. Audit each one
   for accumulated personal context that should explicitly be tagged
   private. (Most are fine — they're patterns the specialist learned,
   not raw personal data — but a manual pass is worth it.)

### Auth & gating
1. **`src/core/users.ts`** — `is_caller_allowed(specialist, user)`
   helper that combines `allowed_specialists` (user-side) with
   `allowed_callers` (specialist-side). The runtime checks both
   before invoking the LLM.
2. **Sam's PIN** — restore from `friday_users.json` only after every
   item above is verified.

## Smokes to add

- `bun run smoke:multiuser` — fresh temp vault, two users (jasper +
  sam), seeds Sam's memory files, simulates:
  - Sam asks Brigid for dinner ideas → Brigid responds without
    referencing Jasper's preferences
  - Sam asks Vivian about Jasper's finances → Vivian refuses, suggests
    Kate
  - Sam asks Cassandra about cameras → Cassandra refuses
  - Sam asks Marguerite about her own family → Marguerite tracks
    Sam's tree separately (writes to `Knowledge/Marguerite/sara_family/`)
  - Sam asks Kate about Jasper's day → Kate exercises discretion
    (the LLM call happens; we assert the response doesn't leak
    specific personal data — fuzzy check against keywords)
- `bun run smoke:rag-isolation` — adds a note with `private_to: jasper`
  to the test vault, runs a Sam-context retrieve, asserts the chunk
  is filtered out. Repeats for Kate, asserts the chunk is returned
  (Kate bypasses).

## Verification before re-enabling Sam

After all of the above lands, manually verify each row of the
discretion table by:
1. Sign in as Sam (after restoring her pin_hash)
2. Ask each specialist a question in their domain
3. Ask each specialist a Jasper-specific question they shouldn't share
4. Confirm: routes work, refusals fire where expected, no Jasper-data
   leaks via tool calls or RAG
5. Check audit log shows Sam as caller on every row

Only then re-enable her PIN.

## Two important "don'ts"

- **Don't treat persona-prompt instructions as a security boundary.**
  The 27B model will follow them most of the time but isn't airtight
  against social engineering. The HARD boundaries are: capability
  gating (already there), `allowed_callers` (Cassandra/Vivian
  refusal), per-user memory file paths (data not present in context),
  `private_to` frontmatter (data filtered before retrieval). Persona
  rules are defense-in-depth on top of those, not a substitute.
- **Don't centralize discretion logic in Kate.** Each specialist
  enforces their own rules via the discretion block + the runtime's
  caller check. Kate is the FALLBACK ("would you like to ask Kate?"),
  not a gatekeeper Sam goes through to reach others.

## Estimated scope

~40 files, ~3-5 sessions. The per-specialist YAML additions + the
SpecialistTurnInput threading are mechanical and fast. The tool-by-
tool audit (item 8 in Backend) is the long pole.

## When in doubt

Read `architecture.md` "Capability gating" and "Knowledge namespaces
and scope filtering" — Phase 2b is the multi-user extension of both.
The captain/crew framing in this prompt is the UX target; the
capability + gating mechanisms are the enforcement.
