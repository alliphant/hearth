# Technical details

The README is meant to read like a brochure. This is the room behind
the brochure — for the curious, for people thinking about contributing,
and for anyone who hits something weird and wants to understand why.

For the full design rationale, read [architecture.md](architecture.md).
For the contributor-side conventions, read the private dev log. This
file is the middle ground.

## What Hearth is, more precisely

Hearth is a **tool server**, not an agent. This is the most important
architectural decision in the project; everything else follows.

- A **tool server** exposes typed HTTP endpoints. Each endpoint does
  one thing (write a journal entry, look up a person, queue an
  approval), validates inputs against a schema, executes
  deterministically, audits, returns structured output. It does *not*
  decide *when* to do things, *which* thing to do, or *how* to chain
  them.
- An **agent runtime** is the LLM-driven planner. Hearth has a small
  one of its own (`SpecialistRuntime`), running each persona as a turn
  over the shared model. But the persona doesn't own the storage; the
  storage doesn't depend on which persona is calling.
- This separation gives us **surface independence** (new UI, new bot,
  new iOS app — all are new clients of the same API), **model
  swappability** (point at any OpenAI-compatible endpoint via one
  config edit), and **multiple concurrent agents** (the web UI and a
  messaging client both call the same Hearth; the audit log ties their
  actions together so the system stays coherent).

## Stack

| Layer | Tool | Why |
|---|---|---|
| Runtime | [Bun](https://bun.sh) ≥ 1.3 | Fast cold start, native TypeScript, batteries-included (test runner, sqlite driver, fetch) |
| HTTP | [Hono](https://hono.dev) | Tiny, sub-routable, runs on any JS runtime |
| Storage | SQLite (WAL mode) via `bun:sqlite` | One file, no daemon, scales to vault sizes easily; WAL means readers don't block the writer |
| File watcher | chokidar | The ingestor reflects vault edits in ~500 ms; cross-platform |
| Validation | Zod | At every HTTP and tool boundary — types you can trust |
| Service supervisor | systemd user units (Linux) or launchd plists (macOS) | Boot-with-no-login via `loginctl enable-linger`; no root install |
| Front-end | Vanilla HTML/CSS/JS | No build step, no bundler, no framework — fast iteration on `/app`, `/inbox`, `/files` |

We don't add cloud dependencies by default. Localhost-bound;
[Tailscale](https://tailscale.com) for remote access if you want it.

## Token-templated personas

Persona YAMLs ship with placeholders that bind from the household block
in `config/users.yaml` at boot. Example:

```yaml
# config/specialists/anya.yaml (excerpt)
persona: |
  You are Dr. Anya. You care for {{pet_names:the household's animals}}
  the way you'd care for patients you've known for years...
```

```yaml
# config/users.yaml
household:
  brand: "Hearth"
  partner_name: "Sam"
  primary_city: "Pleasantville"
  pets:
    - { name: "Bailey", species: "dog" }
    - { name: "Mango",  species: "cat" }
  vehicles:
    - { make: "Hyundai", model: "Ioniq 5" }
```

At runtime Anya's persona reads "You care for Bailey and Mango..."
even though the on-disk YAML stays generic. Tokens with no binding
fall back to the default phrase after the colon, so the persona reads
naturally on a fresh install with an empty household block.

Implementation lives in [src/core/household.ts](src/core/household.ts).
The substitution runs in `load_specialist_file()`
([src/core/specialist.ts](src/core/specialist.ts)) right after the YAML
parses and before the persona compiles.

The full token list:

| Token | Source field | Used by |
|---|---|---|
| `{{user_name}}` | `users[admin].display_name` | every persona |
| `{{household_brand}}` | `household.brand` | Iris, Anya, Kate |
| `{{home_name}}` | `household.home_name` | Kate, optional |
| `{{primary_city}}` | `household.primary_city` | Eleanor, Maggie |
| `{{primary_region}}` | `household.primary_region` | Eleanor |
| `{{usda_growing_zone}}` | `household.usda_growing_zone` | Eleanor |
| `{{partner_name}}` | `household.partner_name` | Brigid |
| `{{pet_names}}` | `household.pets[].name` (joined) | Anya |
| `{{primary_vehicle}}` | `household.vehicles[0]` | Iris, Cordelia |
| `{{nearby_venues}}` | `household.nearby_venues` (joined) | Maggie |
| `{{nearby_cities}}` | `household.nearby_cities` (joined) | Maggie |

Adding a new token: add the field to `HouseholdSchema` in
[src/core/household.ts](src/core/household.ts), add the derivation to
`build_context()`, then reference it in any persona's text.

## The sanitizer

This repo is the public, sanitized mirror of a private dev tree. The
sanitizer that produces it ships in the repo too —
[scripts/sanitize.ts](scripts/sanitize.ts) driven by
[ops/sanitize-rules.yaml](ops/sanitize-rules.yaml) — so if you fork
this and develop your own variant against a personal vault, the same
pattern (`bun run sanitize`) keeps your downstream public mirror
PII-free.

### How it works

1. **Excludes** per-install state (vault, library, db, .env,
   downloaded map data, logs).
2. Applies **regex-driven text replacements** (your name, pets,
   places, hostnames → generic placeholders). The name-shorthand
   handles JS escape-boundary edge cases like `"\nBailey"`.
3. Renames `config/users.yaml` → `config/users.yaml.example` (curated
   template).
4. Runs a **final audit pass that fails the run** if any forbidden
   literals leak through.

### Commands

```bash
bun run sanitize          # dry-run preview (default; writes to /tmp scratch)
bun run sanitize:apply    # write to ~/hearth-prod
bun run sanitize:audit    # audit an existing target without writing
```

### Safety guards

The sanitizer refuses to run if `--out` would clobber the dev tree.
Four guards layered:

1. `realpath(out) == realpath(cwd)` → refuses
2. `realpath(out)` is inside `realpath(cwd)` → refuses
3. `realpath(cwd)` is inside `realpath(out)` → refuses
4. `out` is a git repo whose `.git/config` mentions any `-private`
   suffix → refuses

This means you literally cannot `bun run sanitize --out .` and overwrite
your source.

## Audit log

Every action and every gate decision is **dual-written**:

- to the `audit_log` table in SQLite — queryable, structured
- to `~/<vault>/System/Audit/YYYY-MM-DD.md` — durable, grep-friendly,
  survives database corruption

The cost is small duplication; the benefit is enormous trust. If you
ever wonder "what did the system actually do," the answer is one cat
away:

```bash
cat ~/vault-friday/System/Audit/$(date +%Y-%m-%d).md
```

The orchestrator can be turned off and the audit log remains useful.
The database can be wiped and the projection rebuilds from the vault
via `bun run ingestor:rebuild`. The vault is the source of truth.

## The three-loop model

Hearth's runtime is **awareness · deliberation · interrupts**.

- **Awareness** runs continuously. The ingestor watches the vault via
  chokidar; the scheduler ticks every 60s; per-specialist handlers
  diff what's changed since they last looked (note mtimes, audit-log
  clusters, inbox arrivals). No LLM — just signals.
- **Deliberation** runs at scheduled HH:MM slots per specialist (Kate
  at 07:00 / 12:30 / 18:00 / 22:00; Vivian at 07:30 and 17:00; etc.).
  One LLM turn synthesizing recent observations into a structured JSON
  envelope: inbox flags to peers, proposals for the user, interrupts
  if warranted.
- **Interrupts** fire only when a deliberation pass produces one
  above the specialist's threshold. Kate routes most interrupts —
  she either **absorbs** (logs what she did instead) or **promotes**
  (routes to the user). Most cases absorb. The absorb-to-promote ratio
  over time is the calibration metric.

One loop ("the LLM reads everything and decides what to push") would
be too noisy or too quiet. The three-loop structure separates concerns:
awareness is fast and dumb (updates state); deliberation is slow and
thoughtful (batches state into proposals); interrupts are rare and
important (only fire when justified).

## Capability gating

Every tool declares `required_capabilities`. Every specialist's YAML
declares the granted set. The ToolRegistry denies any call missing a
required capability and returns a structured error the LLM can route
around.

This is a **security boundary**, not a styleguide. Looking at a
specialist's config answers "what can this specialist do to my life?"
Reads (`read_vault`, `query_web`) are low-risk. Vault writes
(`write_vault_finance`, etc.) are scoped to one specialist's library.
External acting (`send_email`, `spend_money`) is approval-gated and
only Kate has it in the seed config.

## Tiered autonomy

A 5-rung trust ladder:

1. **Read** — auto. Vault lookups, audit queries, external read-only
   feeds.
2. **Write internal** — auto. Vault writes (reversible; the audit log
   shows exactly what changed).
3. **Send external, low-stakes** — defaults to approve; graduates per
   recipient after N approvals-without-edits.
4. **Send external, high-stakes** — first-contact emails, sensitive
   recipients, novel categories. Approval-only; never auto-graduates.
5. **Spend money or commit time** — always approval-required, with a
   cooldown.

Trust graduates **narrowly**: just because the user auto-approves
texts to their mother doesn't mean texts to their boss auto-approve.
Per-recipient, per-domain. Hard exclusions (legal, medical,
first-contact, over-cap amounts) never auto-graduate regardless.

## Cross-platform reach

| Platform | Status |
|---|---|
| **Linux** | First-class — primary target. systemd user units, apt/dnf/pacman package detection. |
| **macOS** | First-class — Bun runs native, SQLite/chokidar/Hono all work. Services via launchd plists (TODO — currently the installer prints a manual `bun run dev` note). |
| **Windows** | Via WSL2 (recommended). Native Windows is technically possible but the installer doesn't target it. |

The browser-host extension (Maggie's `browse_url` for Cloudflare-walled
pages) is **Linux-only on the browser host** because it uses
`kwin_wayland` for nested compositors. The always-on Hearth host can
still be any of the three.

## Security posture

- **Localhost-bound by default.** The orchestrator listens on
  `127.0.0.1:7700`. Never WAN-bind. Tailscale for remote access if
  you want it.
- **PIN auth on the web app.** SHA-256 hashed, per-user rate-limited
  to 5 attempts per 15 minutes (persisted across restarts so an
  attacker can't restart-loop to reset).
- **Audit redaction defaults on.** Location data is the most
  privileged data in the system — coords rounded to 3 decimals
  (~110m precision) before any audit row is written; street-level
  addresses stripped to `<city>, <region>`. Browse URLs recorded
  host-only by default. Toggleable in `config/privacy.yaml` if you
  really want a precise journal.
- **Capability gating** — described above.
- **Threat model: well-meaning automation overstepping,** not
  external attacker. We don't add auth scaffolding beyond what you've
  explicitly opted into.

## What we explicitly don't do

A list of capabilities omitted from v1 and why:

- **No multi-user yet.** The data model is multi-user-ready
  (`users.yaml` is a list); the runtime isn't. Cross-user-privacy
  enforcement (Kate + Cassandra as sensitivity gates before any
  specialist sees data that isn't theirs) lands in a future pass.
- **No vector DB as a service.** SQLite FTS5 + (when retrieval lands)
  an embedded vector store. The vault is hundreds-to-low-thousands
  of notes, not millions; no need to pay the Pinecone/Weaviate/etc.
  tax.
- **No conversation streaming protocols beyond SSE.** When the
  unified web UI needs to push live updates, SSE is the streaming
  primitive. No WebSockets unless we hit a specific need WebSockets
  uniquely solves.
- **No automatic execution of web actions by default.** Browser-host
  fetches are read-only. Form submissions, bookings, etc. are
  approval-gated tier 2c.
- **No AI ops dashboard.** The system is observed via the audit log
  and `journalctl --user`. If you want a dashboard, query the audit
  log. Adding a dashboard is YAGNI until proven otherwise.

## Where to read next

- [architecture.md](architecture.md) — full design rationale, every
  decision with its reasoning
- the private dev log — contributor conventions, how to add tools,
  things that will trip you up
- [showcase.html](src/app/client/showcase.html) — visual tour of the
  whole system, rendered at `http://localhost:7700/app/showcase.html`
  after install
