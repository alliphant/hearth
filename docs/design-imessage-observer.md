# Design — the opt-in macOS iMessage observer (the People engine's richest source)

> v1 (the **Hearth half**) SHIPPED 2026-06-22 (branch `feat/imessage-observer`),
> DARK behind `HEARTH_IMESSAGE_OBSERVER`. The third build of the People reasoning
> substrate, on top of Phase 0's relationship graph
> ([design-people-relationship-graph.md](design-people-relationship-graph.md)) and
> the A+D observational engine
> ([design-people-observational-engine.md](design-people-observational-engine.md)),
> whose seam this fills. The **macOS reader half** is BUILT (2026-06-22) on
> `hearth-ios` `main` (macOS-only, un-sandboxed Developer-ID app) and consumes the
> upload contract below — `ChatDBReader` + `IMessageObserverFeeder` + a
> `Settings → iMessage` surface; compiles green. End-to-end goes live when the
> backend flag `HEARTH_IMESSAGE_OBSERVER` is armed + the user grants Full Disk
> Access + opts a contact in on the Friends card.

## The ask
Hearth learns about the people Jasper talks to from his iMessage threads — the
richest friend signal, because his friendships live on iMessage/Discord, not
email. But Hearth keeps only the **distillate** (durable facts, open loops,
themes), **never a copy of his messages**. Per-contact opt-in, default OFF. This
is the most sensitive data source in the system; the privacy spine is the
load-bearing constraint, not a feature.

## Architecture (decided)
- **macOS app = reader/pipe (NO distillation).** The native macOS Hearth app
  reads `~/Library/Messages/chat.db` (SQLite; Full Disk Access, prompted once),
  incrementally via a per-chat watermark (max `message.ROWID`/`date`). It
  resolves each `handle.id` (phone/email) → a Hearth `person` by matching
  `contact.phone`/`contact.email`, and for each **opted-in** contact
  **chunk-uploads raw 1:1 message windows** (`{text, ts, from_me}`) to a Hearth
  ingest endpoint. **1:1 chats only for v1** (group chats are multi-party, noisy,
  hard to attribute). The app runs **no LLM**.
- **Hearth = the brain.** A transient staging store holds uploaded raw; a
  **nightly** background job distills each opted-in person's new staged window on
  Hearth's **local** model tiers and writes only the distillate, then **drops the
  raw**.
- **Decoupled clocks.** Upload is cheap + frequent (hourly / on app launch — it
  just moves bytes). Distill is the expensive local-LLM half, off-peak nightly,
  **cadence-gated** by an env knob so the distill clock is tunable without a
  schedule edit (`HEARTH_IMESSAGE_DISTILL_MIN_INTERVAL_H`, default 20h; set 168
  for weekly).

## Privacy spine (NON-NEGOTIABLE)
- **Opt-in per contact, default OFF.** Hearth **owns and ENFORCES** the registry
  ([imessage_staging.ts](../src/memory/stores/imessage_staging.ts) `ImessageOptIn`):
  the ingest route drops any window whose `person_id` isn't opted-in **for that
  uploader** AND visible to them, so a stale or misbehaving client can never
  stage a not-opted contact's messages. The toggle UI lives on the **Friends
  card** ("What Hearth's noticed" section); the macOS app reads the resulting
  allowlist from `GET /api/imessage/opt_in`.
- **On-box only.** Content goes Mac → Hearth over LAN/Tailscale, never to an
  external service. Distillation runs on Hearth's **local** planner/deep tiers.
- **Hearth keeps ONLY the distillate.** Staged raw is **transient** — the distill
  `drop`s a person's windows the moment it has extracted their distillate. The
  staging table is **never read by any user-facing surface** — only the distill
  reads it, then deletes. The Mac's `chat.db` is the source of truth; re-distill
  = re-upload. Hearth never becomes a searchable archive of message history.
  This is the difference between a chief-of-staff and a wiretap. (An `attempts`
  counter drops windows that fail to distill `>= HEARTH_IMESSAGE_DISTILL_MAX_ATTEMPTS`
  times, so raw can't linger even on a persistent failure.)
- **Cordon model (two tiers, deliberate):**
  - **Durable FACTS** (likes / dislikes / dietary / pets / dates / relations) are
    merged into the People note via the SAME grounded `extract_person_facts` +
    `merge_facts` engine the chat-told enrichment uses, so a fact about a shared
    contact is **communal** (household-visible, exactly as if typed into the
    card) and the source channel is not recorded.
  - **Relationship OBSERVATIONS** (open loops, life events, topics) are stamped
    `private_to` = the **uploader** (owner-only) — STRICTER than the chat-mention
    observer, on purpose: the distillate of someone's private correspondence is
    theirs to see, not the household's. The Friends card cordon-filters them per
    viewer (`note_visible_to_caller`); the owner has no god-view of another
    user's.
- **DARK by default** (`HEARTH_IMESSAGE_OBSERVER`, off → ingest accept-but-noops,
  distill no-ops), **fail-open everywhere**, kill-switched.

## What shipped (v1 — the Hearth half)
- **Stores** ([imessage_staging.ts](../src/memory/stores/imessage_staging.ts),
  additive, no `SCHEMA_VERSION` bump): `ImessageOptIn` (per-contact registry,
  default OFF, cordoned), `ImessageStaging` (transient raw windows, idempotent on
  a deterministic `content_hash`, `drop`/`bump_attempts`/`exhausted_ids`), and an
  `imessage_meta` k/v for the `last_distill_at` cadence cursor.
- **Distill engine** ([imessage_distill.ts](../src/core/imessage_distill.ts)) —
  `run_imessage_distill_sweep`: per opted-in person → assemble a
  speaker-attributed transcript → **substance filter** (structural pre-filter +
  LLM judge, fail-open to "distill"; mirrors
  [capture_quality.ts](../src/connectors/capture_quality.ts)) → reuse
  `extract_person_facts` + `merge_facts` → person note (communal) → NEW
  `extract_imessage_signals` (open loops / life events / topics, grounded,
  extract-only-stated, fail-open) → `person_observations` (`source_type:
  'imessage'`, owner-cordoned) → **drop the raw**.
- **Nightly job**
  ([distill_imessage_observations.ts](../src/specialists/kate/tools/distill_imessage_observations.ts))
  — Kate's `background_jobs` tick at `03:45` (mirrors `sweep_person_facts`),
  `volatile`, off her LLM surfaces; manual catch-up via
  `fire_background_job?name=distill_imessage`.
- **Ingest route** ([imessage.ts](../src/app/routes/imessage.ts)) — `POST
  /api/imessage/ingest` + `GET /api/imessage/opt_in` (owner-tier, opt-in +
  cordon gated). **NEW top-level `/api` namespace → the the LLM host nginx
  `/api/(...)` alternation needs `imessage` added** (single-file bind mount —
  edit + `docker restart nginx`, not reload).
- **Opt-in toggle** on the Friends router
  ([friends.ts](../src/app/routes/friends.ts), `POST
  /:id/friends/:pid/imessage_opt_in`, EXISTING `/api/specialists` namespace → no
  nginx edit) + the Friends-card UI ([app.js](../src/app/client/app.js), in the
  "What Hearth's noticed" section).
- Proof: `bun run smoke:imessage-observer` (44 — opt-in cordon, staging
  idempotency/drop/attempt-cap, the substance filter matrix, the end-to-end
  distill landing facts + observations, the owner-only cordon, **raw dropped**, a
  not-opted person dropped, idempotent re-distill, the cadence gate).

## The macOS upload contract (for `hearth-ios` `feat/macos-native`)
The Mac is the only side that touches `chat.db`. The wire contract:

- **`GET /api/imessage/opt_in`** → `{ enabled: [{ person_id, name, handles: string[] }] }`
  — the opted-in people, each with their contact `handles` (raw `contact.phone` +
  `contact.email` from the person note). The app matches each chat.db `handle.id`
  (phone/email) against `handles` to resolve a 1:1 chat → its `person_id`, and
  uploads windows ONLY for matched, opted-in people (Hearth re-enforces
  regardless). The client normalizes both sides for matching (phones → digits,
  emails → lowercased). Auth: owner bearer (the same one the iOS/macOS client
  already holds).
- **`POST /api/imessage/ingest`** — body:
  ```jsonc
  {
    "windows": [{
      "person_id":   "p_xxxxxx",          // the Hearth person the handle resolved to
      "chat_guid":   "iMessage;-;+15551234", // optional, for dedup/grouping
      "window_start": "2026-06-20T00:00:00Z", // optional ISO bounds
      "window_end":   "2026-06-22T23:59:59Z",
      "messages": [{ "text": "...", "ts": "2026-06-22T18:03:00Z", "from_me": true }]
    }]
  }
  ```
  → `{ ok, enabled, staged, skipped }`. Up to 200 windows / 2000 messages each
  per call. **The app converts Apple's date (nanoseconds since 2001-01-01 UTC) →
  ISO 8601 UTC before upload** — Hearth does no Apple-epoch math (keeps the
  `guard:time` surface clean). `from_me` drives open-loop directionality ("you
  owe Sam" vs "Sam owes you"), so it must be accurate.
- **Watermark is the Mac's.** The app tracks a per-chat max `ROWID`/`date` in its
  own prefs and uploads only new messages. Hearth keeps no per-chat cursor (the
  staged rows are transient); re-distill = re-upload. Identical re-uploads
  collapse on `content_hash`, so a retry is safe.
- **Idempotency / retry.** `staged` counts newly-staged windows; an identical
  re-POST returns it under `skipped` (collapsed). When the feature is DARK the
  endpoint returns `{ ok: true, enabled: false, staged: 0 }` so the app can back
  off without erroring.

## Deploy (ships DARK)
Land on `main` → on the LLM host `git pull --ff-only` → add `imessage` to the nginx
`/api/(...)` alternation (`docker exec nginx nginx -t` then `docker restart
nginx`) → set `HEARTH_IMESSAGE_OBSERVER=1` in `hearth.env` → **`docker compose up
-d` (recreate — an env_file change is NOT picked up by `restart`)**. Restart
`hearth-ingestor` too only if shared `src/core`/`src/memory` modules changed
(they did — the new store), to avoid a stale projector. Confirm `distill_imessage`
appears under Kate's jobs; manual catch-up:
`POST /api/specialists/kate/fire_background_job?name=distill_imessage`.

## Roadmap / deferred
- **The macOS reader half — BUILT 2026-06-22** (`hearth-ios` `main`, macOS-only):
  `ChatDBReader` (raw SQLite3 read-only chat.db; 1:1 chats; Apple-ns→ISO;
  `attributedBody` typedstream decode; per-chat ROWID watermark;
  bounded initial backfill), `IMessageObserverFeeder` (hourly: fetch opt-in →
  normalize+match handles→person → read new windows → chunked upload → advance
  watermarks only on a non-dark accept), un-sandboxed macOS entitlements,
  `Settings → iMessage` (FDA status + Grant + Sync-now). The notarized RELEASE is
  a separate explicit step (held). Live once the flag is armed + FDA granted + a
  contact opted in.
  - **attributedBody decoder fix — 2026-06-24** (`hearth-ios` `main`). The shipped
    reader's `attributedBody` extraction was a hand-rolled byte heuristic (find an
    `NSString` marker → scan for a `+`/0x2B lead → read a length-prefixed run) that
    mis-parses the real `streamtyped` layout on modern macOS (the backing store is
    an `NSMutableString`; the content is not introduced by a `+`). On macOS 26 —
    where `message.text` is NULL and the text lives only in `attributedBody` — it
    therefore dropped MOST received messages. Symptom: tiny, `from_me`-skewed staged
    windows and a distill that correctly returned `facts:0, observations:0` because
    it was STARVED of substance (the substance filter + extractors were never at
    fault — thin input → empty output is the designed behavior). Fixed by decoding
    through Foundation's own `NSUnarchiver` (the real first-party `streamtyped`
    reader) in a new `hearth-ios` SPM package `HearthTypedStream`, wrapped in an
    Objective-C `@try/@catch` (`NSUnarchiver` is macOS-only AND raises an
    `NSException` on a truncated blob, which Swift cannot catch → nil-on-failure,
    never fabricate, never crash). A one-time client watermark reset re-reads the
    recent backfill the broken decoder had already skipped past. **No backend
    change** — an upload-quality fix; the staging + distill contract is unchanged.
- **Themes synthesis (v2) — SHIPPED 2026-06-24.** The nightly People-engine
  synthesis pass ([core/people_synthesis.ts](../src/core/people_synthesis.ts),
  Kate's 04:00 `synthesize_dossiers` job, after the 03:45 distill) PROMOTES durable
  cross-window signal out of the flat observation stream into the durable dossier —
  communal FACTS → the People note via the shared `merge_facts`; the relationship
  NARRATIVE (a portrait + recurring themes: concerns, texture, network, trajectory)
  → the CORDONED [person_synthesis store](../src/memory/stores/person_synthesis.ts)
  (owner-only, inheriting the observations' cordon). The GATE — "would this still
  matter in 6-12 months / does it shape the relationship?" — is the deep-tier
  model's judgment (grounded, fail-open); recurrence is the strongest promote
  signal (a deterministic token-cluster hint feeds it). DARK behind
  `HEARTH_PEOPLE_SYNTHESIS`, dirty-gated + cadence-gated. The Friends card renders
  it as "Hearth's read."
- **Open-loop followups — SHIPPED 2026-06-24** (same pass). A genuinely actionable
  `open_loop` becomes a Kate followup `action_proposal` ("Open loop with Sam: book
  daycare for Mango — want me to handle this?"), edge-deduped on the observation's
  `source_ref`, cordoned, capped (the Calendar-Knowledge-Graph followup idiom — a
  sweep has no conversation, so it files a proposal, not `promise_followup`).
  Independently disableable (`HEARTH_PEOPLE_SYNTHESIS_FOLLOWUPS=0`).
- **Decay** (same pass) — the model dismisses resolved/trivial observations, and a
  deterministic per-kind TTL backstop (`PersonObservations.decay_stale`) ages out
  the rest, so "what Hearth noticed" stays a recent glance instead of an ever-growing
  list.
- **Discord** — harder (no local store; bot/API + ToS). A later stretch.

## Honest stretches / risks
- **Entity resolution is the Mac's hard part** — handle→person rests on
  `contact.phone`/`contact.email` matching the person note. A miss means no
  upload (silence), never a wrong attribution. Group chats are skipped in v1
  precisely because attribution is unreliable.
- **The substance filter is a cost saver, not a correctness gate** — it fails
  open to "distill," and the grounded extractor is the backstop (it pulls nothing
  from noise). So a filter miss costs one LLM call, never a wrong fact.
- **Auto-population is only safe because of the trust surface (D)** — every
  observation is provenance-tagged (`source_type: 'imessage'`) + dismissable on
  the card; facts ride the same union-dedup merge as a typed-in fact.
