# architecture.md — Hearth design decisions and their reasoning

This is the **why** document. Pair it with
the private dev log (the **how** document for contributors).

When something in the codebase feels off in the future, this file is
what you read to figure out whether the off-feeling is a real problem
or a load-bearing constraint someone reasoned through.

> **⚠ 2026-08-04 — every section below describing the camera/vision layer is
> HISTORY, not current design.** Frigate, person threads/tracks, face
> recognition and clustering, the Security Room, the away-from-home camera
> monitor, visitor ask-back, camera-derived occupancy, and `unifi_camera_view`
> were all removed on 2026-08-04. The reasoning is preserved here because it
> explains decisions still visible in adjacent code — but do not build on it,
> and do not treat it as describing a live subsystem. What the house actually
> has now: UniFi Protect's own smart detections (unchanged, owned by Protect),
> `unifi_protect_events` + `unifi_security_snapshot` as Kate's reads, and
> WiFi/BLE presence for "who's home". The full deleted/survived inventory is
> the top addendum of the private dev log.

## Foundational law — dynamic + agentic, never hard-coded around the model

The most important design principle in Hearth, and the one most often violated under
deadline pressure: **a fix makes the LLM more capable; it never works AROUND the LLM
with determinism.** Hearth is an agentic system — its value is that the model
*determines intent → spends a tool call → acts on the result.* So the answer to
"the model didn't do X" is a better/more-obvious/general TOOL and reliable
tool-calling — not pre-computing the answer and force-feeding it.

Concretely banned as a primary fix: **pre-injecting** data into the prompt "so the
model has it" (it's cheaty and deterministic where it should be dynamic);
**hard-coded special-cases / carve-outs** ("a specific-case carve-out is a signal you
missed the general mechanism"); and **forcing/pre-empting the model's decision**.
Determinism is legitimate ONLY *inside* a tool the model already chose to call (e.g.
`who_is` resolving a name → a person record — the model decided to call it and
supplied the name). It is never a substitute for the model deciding.

Worked example (2026-06-22): the "Kim's flights" miss — Kate had no tool that
answered "a *person's* flights," so the model jammed "Kim" into `flight_status`. The
WRONG fixes (both built + thrown away): a `list_tracked_flights` person-filter
carve-out, then a grounding-pack that pre-injected every named person's dossier into
the prompt. The RIGHT fix: make `who_is` the one obvious, model-driven person-lookup
tool that returns the whole dossier (incl. flights) — the model decides to call it,
spends the call, reads the result. The Kate-pack calendar pre-inject (under "The
Household Knowledge Graph" / grounding packs) exists only as an anti-fabrication
BACKSTOP for a proven model failure — it is not license to pre-inject more.

## The mission

Hearth is a **personal chief of staff** that knows the user, prepares
their life, and acts on their behalf within boundaries the user has
calibrated. It's the part of FRIDAY OS that remembers people,
journals decisions, surfaces what's coming up, and — over time —
takes increasingly autonomous action on the user's behalf as trust is
earned in narrow domains.

The shape of "chief of staff" we want, in priority order:

1. **Memory.** The user shouldn't have to re-tell the system
   anything. It should remember names, dates, decisions, the texture
   of relationships.
2. **Preparation.** Each morning, the system should know what's
   coming up — birthdays, anniversaries, lapsed contacts, follow-ups.
   It should surface this without being asked, briefly, while the user
   is making coffee.
3. **Boundaries.** Every action that touches the outside world goes
   through a policy gateway. The defaults are conservative. Trust
   graduates over weeks of approvals-without-edits, narrowly, per
   domain.
4. **Voice.** The system communicates in a consistent persona (a
   warm, maternal team). Conversations feel like working with staff,
   not wielding tools.

What Hearth is **not**: a productivity tool, a personal assistant
chatbot, a CRM, a SaaS knowledge base, a notes app. It's the
*substrate* underneath all those framings — the durable memory and
policy layer that the user's actual interfaces (Telegram via Hermes,
the planned web UI, future iOS app) talk to.

## Hosts and topology

Three physical hosts, distinct roles. **Topology consolidated to
the LLM host on 2026-05-29** — the always-on host lost its server role to fan noise and
the more general "two-of-everything is fragile" argument. The
historical breakdown of what used to live where is preserved in
the private shipped-log archive
under the "Full FRIDAY-stack migration" ship entry.

### the LLM host — the always-on home stack host (2026-05-29)

An workstation-class machine in the basement, Ubuntu 24.04, dual Intel Xeon Gold
6430 (128 vCPU), 128 GiB RAM, two GPUs:

- **RTX 3090** (24 GB VRAM, CUDA 8.6, 936 GB/s) — reserved for the LLM.
  Runs `Qwen3.6-27B-Q4_K_M` via **beellama.cpp** (single-author
  llama.cpp fork, github.com/Anbeeld/beellama.cpp) with DFlash
  speculative decoding against a Qwen3 1.7B draft model. 96k context,
  q8_0 K/V KV-cache quant, `--kv-unified`, single concurrent slot
  (`-np 1` — **load-bearing: DFlash + `-np ≥2` corrupts output and poisons
  the server; never batch this tier.** Measured 2026-06-03, see
  [design-two-tier-inference.md](docs/design-two-tier-inference.md) "DEEP tier:
  keep DFlash + `-np 1`"). Endpoint `http://localhost:8088/v1` (OpenAI-compatible);
  Hearth reaches it via `http://host.docker.internal:8088/v1` from
  inside docknet. Measured 1.2–1.5× over stock-with-spec-decode on
  Hearth-shaped prompts (highest gain on structured-JSON tool calls).
- **RTX A4000** (16 GB VRAM) — display + Plex HW transcode + Zonos
  GPU TTS + the voice 9B + speaches STT/TTS. FLUX/comfyui runs
  on CPU instead (no GPU contention with the voice stack).
- **CPU image gen.** FLUX-dev runs on the Xeon Gold 6430 (Sapphire
  Rapids) via ComfyUI in a CPU-only container — PyTorch's oneDNN
  dispatches BF16 matmul to AMX hardware tiles. ~5 min per 512²
  image at 20 steps; ~6-7 min per banner-res. ComfyUI's stale
  `is_device_cpu → return False` gate in `should_use_bf16()` is
  patched at image-build time to enable the BF16 path.

As of 2026-05-29 the LLM host hosts the entire household stack as a single
Docker Compose project at `/docker/docker-compose.yml`:

- **Hearth** (this repo's services: `hearth-orchestrator` on
  `:7700` + `hearth-ingestor`; the standalone `hearth-scheduler` container
  was folded into the orchestrator 2026-07-06 — the 60s scheduled-tasks
  tick runs in-process, [src/core/scheduled_tasks_tick.ts](src/core/scheduled_tasks_tick.ts),
  and self-reseeds the nightly-eval rows). Repo bind-mounted
  from `/docker/hearth/repo` (a Gitea clone); deploys are
  `git pull && docker compose restart hearth-orchestrator`. Vault at
  `/docker/hearth/vault/`, DB at `/docker/hearth/data/hearth.db`,
  library at `/docker/hearth/library/`.
- **Home Assistant** (`:8123`) + `matter-server` + `mosquitto` (MQTT),
  all `network_mode: host`. Lutron/Hue/etc. bridges still on the LAN
  — no re-pairing needed when HA moved.
- **Maps** — OSRM drive/bike/walk (`:5001`/`:5002`/`:5003`) +
  Nominatim (`:8979`, remapped from 8989 to avoid Sonarr conflict).
- **FRIDAY service mesh** — firecrawl + 3 sidecars, mealie, searxng,
  metube, qbittorrent, friday-writer (`:8765`), friday-watchdog
  (`:8770`). Hearth's `web_search`, `web_fetch_clean`, `mealie_*` tools
  hit these via docknet container hostnames.
- **nginx** (host network) — TLS front door. Three server blocks: 443
  default with self-signed cert (`glacier`/`your-llm-host.local`/LAN), 443
  SNI with Tailscale-issued Let's Encrypt cert
  (`your-llm-host.your-tailnet.ts.net`), and :80. Both 443 blocks include
  `/etc/nginx/locations.conf`. iOS hits the Tailscale endpoint; LAN
  browsers hit `your-llm-host.local`; the FRIDAY HELIX kiosk is served at
  the root of both. Cert renewal: monthly user systemd timer at
  `~/.config/systemd/user/tailscale-cert-renew.{service,timer}`.
- **Gitea** at `your-llm-host.local:3010` — origin remote for all Hearth /
  FRIDAY / HELIX repos.
- **Media stack** — Plex, Tautulli, Sonarr, Radarr, Lidarr, Readarr
  (+ rreading-glasses sidecar + postgres), Sabnzbd, Overseerr, Zonos.

the LLM host is always on. Always-on is non-negotiable for a chief of
staff: the daily brief fires at 7 AM whether anyone's logged in or not,
the ingestor reflects vault edits within ~500 ms, and the approval
queue must be live whenever a specialist might queue something.
`loginctl enable-linger jasper` lets user systemd units run without a
session.

**Nightly backup** to Serapeum NAS via restic
(`/docker/scripts/backup.sh`, fires daily 03:00 ±15 min). 14-day +
8-week + 12-month retention with a 5% pack-subset verify per run.
Bare-metal restore runbook at `/docker/scripts/RESTORE.md`.

### the always-on host — the kitchen client (was the home stack host, pre-2026-05-29)

An small-form-factor box workstation (the integrated AI accelerator APU) in the kitchen. Runs
zero docker containers today. Roles post-consolidation:

- **a touchscreen kiosk kiosk display** — points its browser at
  `https://your-llm-host.local/` (the FRIDAY HELIX kiosk root). LAN
  self-signed cert; browser nag accepted once.
- **SSH terminal** — `ssh jasper@your-always-on-host.local` still works for accessing
  preserved state (every commented-out docker service block lives in
  `/home/jasper/docker/docker-compose.yaml` with its data dir intact
  for revert).

the always-on host's the integrated AI accelerator APU was unused for Hearth-side LLM (Lemonade is
decommissioned). The fan-noise problem that originally pushed the LLM
to the LLM host ([architecture pre-2026-05-23](the private shipped-log archive))
was also the dominant reason for full consolidation.

### the workstation — the dev workstation, and the on-demand browser runtime

A workstation running CachyOS with KDE Plasma on Wayland (the former
the workstation M.2/OS transplanted onto new hardware 2026-06-11 — the old
the workstation **workstation-class chassis is now the LLM host**; the workstation's own
chassis + GPU are TBD/verify, though the browser role needs a real
NVIDIA GPU). It plays two roles for Hearth:

**Role 1 — development surface:**

- **Code editing** via VS Code Remote-SSH into the LLM host (was the always-on host
  pre-2026-05-29). The Hearth repo lives at `/docker/hearth/repo` on
  the LLM host; the workstation edits over SSH.
- **Obsidian** as the user's vault editor. Mounts
  `/docker/hearth/vault` (formerly `~/vault-friday/`) over a network
  share; the ingestor watches the canonical location.

**Role 2 — on-demand browser runtime (added 2026-05-24):**

the workstation runs `agentd` (Bun/TypeScript, `systemd --user`, port :4446)
as the **only** real-browser surface in the household. When Maggie (or
a future librarian/shopper) needs a page that Firecrawl can't get past
— Cloudflare-walled venue calendars, JS-only show listings, scraper-
hostile festival pages — Hearth on the LLM host reaches into the workstation via
the `avalanche` connector
([src/connectors/avalanche.ts](src/connectors/avalanche.ts)). Each
session is a fresh `kwin_wayland --virtual --xwayland` + fresh
`geckodriver` + fresh Firefox bound to that agent's warmed profile.

the workstation is **on-demand load-bearing**: not always-on, but
authoritative for the browser surface when it's needed. WoL brings it
up from S3 suspend; agentd's drain timer + sleep state machine put it
back down once idle. The wake marker at `/run/avalanche-wake/woken-by-
wol` (tmpfs) tracks whether the current **wake cycle** was
the LLM host-initiated (OK to auto-sleep) or human-initiated (stay up
forever).

"Wake cycle", not "uptime": `/run` is cleared on boot but survives
suspend/resume, so a marker scoped to uptime outlives the wake it
describes and keeps authorizing sleep across every later resume —
including Jasper's. Markers therefore carry the kernel suspend counter
(`/sys/power/suspend_stats/success`) and are rejected once it moves.

See "Browser specialist surface (the workstation)" below for the full
contract, sleep policy, and per-agent profile model.

**Deploy + drift control.** The agentd tree at `~/hearthoperator/agentd`
is a hand-copied directory, **not** a git checkout, so the repo is the
source of truth and a deploy step bridges the gap. The reference copy
lives at [ops/agentd/source](ops/agentd/source);
[ops/agentd/deploy.sh](ops/agentd/deploy.sh) rsyncs it to the box
(push-from-Mac over `ssh avalanche`, since the workstation isn't
name-resolvable from the LLM host), restarts the unit, and health-checks,
while `deploy.sh --check` is a no-op drift diff (source files + the live
systemd unit) that exits non-zero on divergence — the CI-able guard
against the silent drift that bit us on 2026-05-31 (uncommitted box
edits to `sessions.ts`/`config.ts`). The design keeps `config.ts`
**portable**: every box-specific path is an `AGENTD_*` env override, and
the the workstation values live in the unit's `Environment=` lines — the
canonical unit is [ops/agentd/avalanche.service](ops/agentd/avalanche.service),
kept byte-identical to the deployed one. Two paths intentionally differ
from the portable defaults: the wake marker dir (`/run/avalanche-wake`,
provisioned by a root-owned `tmpfiles.d` entry) and the Firefox profile
base (`~/.config/mozilla/firefox`, the XDG-flavor Plasma location). The
chosen rsync-deploy approach (over a sparse git checkout on the box) was
the lighter touch for a subdirectory of eight small files on a host that
carries no other part of the repo.

### URL surface

- `https://your-llm-host.your-tailnet.ts.net/` — Tailscale-issued Let's
  Encrypt cert; iOS app and off-LAN browsers hit this. Catch-all
  routes to HA on `localhost:8123`; Hearth at `/app/`/`/files`/
  `/api/(...)`; FRIDAY mesh at `/firecrawl/`, `/mealie-api/`,
  `/friday-writer/`, `/friday-watchdog/`, `/music-assistant/`.
- `https://your-llm-host.local/` — LAN browsers (self-signed cert) +
  FRIDAY HELIX kiosk at `/`. Same routes as the Tailscale endpoint.
- `http://your-llm-host.local:8123/` — direct HA (no proxy).
- `your-always-on-host.your-tailnet.ts.net` — **dead** as of 2026-05-29 (nginx
  decommissioned). *(The hearth-ios docs lagged on this — corrected
  2026-06-01; iOS connects to `your-llm-host.your-tailnet.ts.net` via
  `HostStore.defaultHost`.)*

### API mount topology — `/api/*` (top-level, iOS) vs `/app/api/*` (web)

Two HTTP mount points, and the distinction is load-bearing — getting it
wrong makes a route 404 from iOS while it "works" in the browser:

- **Top-level `/api/*`** — registered in
  [apps/orchestrator/server.ts](apps/orchestrator/server.ts). This is the
  surface the **iOS app** calls (no `/app` prefix). nginx gates it to
  Hearth (vs HA's catch-all) via the `location ~ ^/api/(...)` alternation
  in `/docker/nginx/locations.conf` on **the LLM host** — a new top-level
  namespace must be added to that alternation or it falls through to HA
  and 404s.
- **`/app/api/*`** — registered in [src/app/router.ts](src/app/router.ts),
  which is mounted under `/app`. This is the **web client's** surface;
  anything registered on that router as `/api/...` actually serves at
  `/app/api/...`, so it's invisible to iOS.

**Rule: any route the iOS app needs must be mounted top-level in
server.ts** (several routers — specialists/conversations/listing-drafts —
are mounted on BOTH so web + iOS share them). The 2026-05-27 sensors-404
and the 2026-06-01 listing-drafts nginx miss were both this gotcha.
**nginx-alternation deploy gotcha:** `/docker/nginx/locations.conf` is a
single-file bind mount, so `sed -i` replaces the inode and the container
serves the stale file (`nginx -s reload` no-ops) — apply with
`docker restart nginx`.

### present_questions — where the multiple-choice form surfaces

`present_questions` persists a `pending_questions` row and emits a
`questions_presented` SSE (`questions_answered` on submit). The row's
attachment decides where the form renders:

- **conversation_id set** → inline form in that chat thread (web:
  `render_pending_question_forms`; iOS: `PendingQuestionForm` in
  `ChatThreadView`). Surfaced off-tab via a rail **"?" badge + toast** on
  the SSE (web, 2026-06-01) so an off-tab ask isn't silently stored and
  lost — the reported "Linda asked and the quizzer never showed" bug.
- **conversation_id null + brief_id set** → renders in the brief
  (deliberation-time asks; `deliberation_pass` patches `brief_id` on after
  the pass completes). Web: Kate's right rail; iOS: `BriefDetailView`
  footer (2026-06-01).
- Answer: `POST /api/present-questions/:id/answer` → marks answered, emits
  `questions_answered` (cross-surface dismissal), fires the resume turn.
- **Gap (follow-up):** no cross-conversation "all pending for this user"
  endpoint, so the web rail badge is SSE- + visit-populated (survives the
  live session, not a hard reload). A `GET /api/pending-questions` +
  boot fetch would make the badge reload-durable.

### Three Linux workstations, plus a macOS laptop

- **the LLM host** (workstation-class machine, basement, Ubuntu, RTX 3090 + RTX A4000)
  is the always-on home stack host as of 2026-05-29 — Hearth, HA,
  FRIDAY mesh, LLM, media, nginx, gitea, backup.
- **the always-on host** (small-form-factor box workstation, Ubuntu, hostname `the always-on host`) is
  the kitchen kiosk display and SSH terminal. Zero server services.
- **the workstation** (CachyOS/KDE — the former the workstation M.2 on new hardware
  as of 2026-06-11; chassis + GPU TBD/verify, the old workstation-class is now
  the LLM host) is the user's main Linux dev workstation +
  on-demand browser host.
- Plus a **macOS laptop** — used alongside the workstation for everyday
  work; not load-bearing for Hearth.

None of the Linux machines are laptops. Don't call them laptops.

### Why everything is on the LLM host (and not the always-on host)

- **Always-on is non-negotiable.** A chief of staff that goes dark
  when the workstation is closed is useless. Both the always-on host and the LLM host
  were always-on, so this argument was a wash — but consolidating
  to one always-on host halves the "two-of-everything-can-fail"
  surface.
- **Acoustics.** the always-on host's fans under sustained inference load were
  audible between the kitchen and living room. the LLM host in the
  basement is silent from where humans sit. This was the dominant
  practical driver — first for the LLM move (2026-05-23), then for
  the full stack (2026-05-29).
- **GPU.** RTX 3090 (CUDA) is the right hardware for the LLM; the
  the integrated AI accelerator's ROCm path was always second-class. the LLM host also gives
  us a second GPU (RTX A4000) for display + Plex + voice (the
  9B + speaches STT/TTS). FLUX runs on CPU instead (Sapphire Rapids
  AMX) so it doesn't compete for A4000 VRAM with the voice stack.
- **localhost beats LAN for the chatty parts.** Hearth's
  orchestrator now talks to beellama, HA, Mosquitto, Mealie,
  Searxng, Firecrawl all on the same host. The cross-LAN hop to
  the always-on host that used to exist (for HA, maps, FRIDAY mesh) is gone.
- **One docker compose to back up.** Restic on the same host that
  owns the state captures all of `/docker/` atomically nightly.
  Previously needed coordination between two boxes.
- **inotify on local disk is reliable.** The ingestor's chokidar
  watcher needs filesystem events; network-share inotify is
  inconsistent. Keeping the canonical vault on the LLM host's local NVMe
  (`/docker/hearth/vault/`, bind-mounted into the ingestor) means
  atomic-rename writes from Obsidian fire clean events.
- **One source of truth.** Two-host setups invariably grow
  inconsistencies. Pulling everything to one box trades flexibility
  for clarity, and the user has flexibility elsewhere (the network-
  mounted Obsidian client, the VS Code Remote-SSH editor).

## Hearth's role

Hearth is a **tool server**, not an agent. This is the most important
architectural decision in the project; everything else follows.

### The distinction

- A **tool server** exposes typed HTTP endpoints. Each endpoint does
  one thing (write a journal entry, look up a person, queue an
  approval). It validates input, executes deterministically, audits,
  returns structured output. It does not decide *when* to do things,
  *which* thing to do, or *how* to chain things.
- An **agent runtime** is the LLM-driven planner. It receives a user
  intent, decides which tools to call in which order, manages a
  conversation, handles partial failures, and renders results back
  to a human.

For Hearth v0 the agent layer is **Hermes-on-mint** (the Telegram
surface). After Prompt 6b lands, a unified web UI (`/app`) will be a
second agent layer that calls the same Hearth endpoints. Both
surfaces share Hearth's vault, its audit, its policy gateway, and its
specialist personas (post-6a).

### Why this matters

This separation gives us:

- **Surface independence.** Changes to the conversational surface
  (new Telegram features, new web UI layout, an iOS app later) don't
  require Hearth refactors. They're new clients of the same API.
- **Model swappability.** We can swap the Qwen model, add Claude as
  a cloud fallback for high-stakes drafting, or run different models
  per role — all by editing `config/llm-roles.yaml`. No call sites
  change.
- **Multiple concurrent agents.** Hermes-on-mint and the future web
  UI can both run, both calling the same Hearth. The audit log
  ties their actions together so the system stays coherent. Since
  2026-06-26 the audit log is also a **tamper-evident hash-chain**
  (provable cordon Phase 1b, [audit_chain.ts](src/core/audit_chain.ts)):
  `log_action` HMAC-links each row to the previous one inside a
  `BEGIN IMMEDIATE` transaction (cross-process-atomic, fail-open), with
  the key held only in the orchestrator env so a backup/DB-dump can't be
  edited and re-sealed. It makes the "who reached my data" record a member
  can read in Settings → Privacy & Data provably un-rewritten.
- **Replaceability of the agent layer.** If Hermes ever stops being
  the right choice, we replace it without touching Hearth.

The cost: Hearth can't do anything purely on its own — every
user-facing interaction starts from an agent layer. (Historical note:
the Concierge's scheduler-fired daily brief was the one exception; the
Concierge agent was retired 2026-07-06 — Kate's deliberation briefs are
the product.)

## The specialist abstraction (Option A, not Option B)

Status: **implemented in Prompt 6a.** Seven specialists live in
[config/specialists/](config/specialists/), instantiated by
[src/core/specialist.ts](src/core/specialist.ts), invoked through
[src/core/specialist_runtime.ts](src/core/specialist_runtime.ts), and
hot-reloaded by chokidar. Capability gating runs through
[src/core/tool_registry.ts](src/core/tool_registry.ts). This section
documents the design decision so future Claude sessions don't relitigate it.

### The two options we considered

**Option A — Personas over a shared model.** Each specialist (Kate
the Chief of Staff, plus a small team of SMEs) is a configuration
object: a name, a persona prompt, a `knowledge_scope` (vault folders
they can read), a `granted_capabilities` (tool risk tiers and
categories they can use). They all run against the same Qwen model.
Specialist selection is a planner step inside Hermes: the planner
looks at the user's message and picks which specialist responds.

**Option B — Separate agent runtimes.** Each specialist runs as its
own process with its own model, possibly its own tooling. The specialists
communicate over a message bus.

### Why we chose A

Option B has stronger isolation between domains and would let
specialists run different models, but the cost is enormous: per-process
overhead, IPC complexity, conversation routing that crosses
process boundaries, model selection per specialist (most would still
end up on the same Qwen anyway). And the practical benefit of hard
isolation is small at single-user, local-first scale.

Option A's tradeoffs we accepted:

- **Specialists feel related.** Because they share a model, their
  "voice" beyond the persona prompt is similar. This is a deliberate
  UX choice: the team should feel like staff at the same firm, not
  contractors hired independently.
- **No hard isolation.** If Hermes loads the wrong specialist's
  context, the model could leak across domains. Mitigated by
  `knowledge_scope` filtering at retrieval time and `capabilities`
  filtering at tool-dispatch time.

Option A's benefits we wanted:

- **Trivially adding specialists.** A new specialist is a YAML file
  plus a vault folder. No new process, no config plumbing.
- **One conversation fabric.** The user talks to "FRIDAY" via
  Telegram; the planner routes within the conversation. The user
  never has to pick which specialist to address.
- **Cross-pollination when useful.** If Kate is briefing about a
  family event and Eleanor (the family SME) has relevant context,
  the planner can hand off mid-conversation without a context
  switch.
- **Cheap compute.** Same model, same KV-cache strategy, no extra
  Ollama overhead.

### The all-female maternal-presence choice

The team is written as a small group of women — Kate the Chief of
Staff plus a few SMEs. This is a deliberate UX choice, not a default.
The team should feel like **staff you trust**, not **tools you
wield**. A maternal-presence framing keeps the conversational
register warm and competent without sliding into either obsequious
("happy to help!") or transactional ("query executed"). The personas
are written in one voice family — different specialists have
different specialties and quirks, but they're recognizably from the
same world.

The named personas are load-bearing for UX. Don't rename them
casually; the user has spent words on each. Future Claude: ask before
editing persona text.

### Kate sub-agents — specialists as staff, not peers (2026-07-03)

The roster is consolidating toward **one brain (Kate) with disposable
worker contexts** — the owner's read, confirmed by prod data (Kate holds
~75% of 30-day user messages and was already the consult hub), is that
fracturing capability across 18 peers reduces her autonomy. A specialist
YAML conflates three things — a user-facing persona, a capability bundle,
and a scheduled background worker — and only the first needs a roster
entry. Two mechanisms (design + phased plan in
[docs/design-kate-subagents.md](docs/design-kate-subagents.md)):

- **`delegate`** (src/tools/delegate.ts, cap `delegate_subagents`, Kate
  only) runs another specialist's FULL turn in its own disposable context
  via the `DelegationRunner` (src/core/delegation.ts) and returns only a
  bounded digest — quick mode degrades to background past a wall cap, the
  digest reports back as an inbox FYI, concurrency is Semaphore-bounded so
  a burst can't starve the shared 35B slots. `consult_specialist` survives
  for one-line questions; delegate is for WORK.
- **`subagent_only: true`** on a specialist YAML demotes it from peer to
  staff: hidden from rosters/aliases — chat surfaces only. Everything
  machine-side (deliberation, jobs, inbox, grants, delegability, AND
  capture-intake candidacy) stays intact; intake re-owns to Kate only at a
  Phase 3 fold-in. Reversible. Currently flagged: anna, brigid, eleanor,
  maggie.
- **Phase 3 fold-ins COMPLETED 2026-07-04**: Luna, Anya, Marguerite, and
  Iris are Kate's own domains — YAMLs deleted, capability union + domain
  tools + persona map on Kate, arrival/departure triggers on her YAML, the
  folded standing duties (Monday house pass, daily pet-refill glance,
  morning EV check) in her deliberation addendum, pet-record intake
  dispatched inside `intake_kate`, and the Home occupancy canvas re-homed
  as a Kate office tab (her `read_home` grant — the home routes are
  specialist-generic). The presence-zone editor is parked until the voice
  coordinator holds the LD2450.
  **Ruby is permanently exempt from demotion/fold-in** — she is named in
  memory of Jasper's beloved dog; that decision outranks any usage data.

### Specialist-id naming discipline

The `id` field in `config/specialists/<id>.yaml` is the load-bearing
identifier — it's how tools dispatch, how vault namespaces resolve
(`Knowledge/<Id capitalized>/**`), how the `/api/specialists/:id`
routes key, and how aliases route slash commands. **Use the
specialist's actual name (lowercase) as the id**, not a generic role
descriptor.

We learned this the wrong way around. The first iteration of
Beatrice (the codebase/process diagnostician) shipped as
`config/specialists/trainer.yaml` with `id: trainer`, because "trainer"
described what she did. When a *second* trainer-shaped specialist came
into design — Astrid, the fitness coach — the id was already taken,
the vault namespace was `Knowledge/Trainer/`, and slash-command
aliases collided (`/trainer`, `/coach`, `/bea` were all Beatrice's).
The rename to `beatrice.yaml` had to thread through capability tokens
(`write_vault_trainer` is still on disk; the rename is the parallel
thread's work), tool import paths, awareness handler registrations,
and aliases.

Rule: id matches name. Roles are descriptive metadata
(`role: "Enterprise Trainer"` vs `role: "Trainer"`); they can collide
freely because nothing dispatches on them. Aliases can include role
words but should be deliberately curated to not collide with another
specialist's likely aliases.

### Cold-start: gating on profile-absent

A specialist whose work depends on user context they don't yet have
should NOT coach blind. Astrid is the canonical example: on her first
contact she searches for `users/<user_id>/astrid/profile.md`, and if
the file is absent she runs a structured interview (4 questions via
`present_questions`) before saying anything that pretends to be
coaching. The absence of the known state file IS the trigger — no
separate onboarding flow, no "first run" flag, no awareness handler
gymnastics. The vault is the source of truth; she reads it on every
turn anyway via the structural knowledge floor, so checking for
profile-presence is free.

The pattern generalizes. A future financial planner needs goals
before recommending allocations; an HR specialist needs preferences
before drafting policy. The discipline:

1. **Pick the smallest set of questions** the specialist genuinely
   needs to do their job competently. Four is usually enough; six is
   the ceiling. More than that and the user bails partway through.
2. **Persist answers as a markdown file** in the per-user namespace,
   so they live next to everything else the specialist writes about
   that user, and the user can edit them in Obsidian.
3. **Make profile-absence the only trigger.** A separate
   "onboarded?" flag goes stale; a file either exists or doesn't.
4. **Re-calibrate on a cadence** — after N sessions or N days, the
   specialist offers another short interview to update the profile.
   Same overwrite-by-rewrite pattern.

This is a stronger pattern than "the user types `/onboard`" because
it's structural: a fresh deployment, a new household member, a vault
restored from backup with profile missing — all hit the same gate
and re-interview automatically.

### Self-documentation as a specialist responsibility

Specialists that build a relationship with the user over time should
write down what they're learning. Astrid's per-user layout is the
template:

- `profile.md` — overwrite-only; the interview answers + every
  re-calibration. Mostly stable.
- `observations.md` — append-only running list of patterns the
  specialist notices ("rides hardest Tuesdays, under-fuels
  beforehand"). Compacted weekly; raw entries archive to
  `observations.archive/<YYYY-Q#>.md` so nothing is lost.
- `sessions/<YYYY-MM-DD>-<slug>.md` — one journal entry per
  domain-relevant event (workout, meal-planning pass, vet visit). The
  specialist's *interpretation*, not the raw data dump (which lives
  in `sensor_packets` or the connector's storage).
- `coaching-log.md` (or `decision-log.md` for non-coaching
  specialists) — every push the specialist sent AND every push they
  deliberately withheld. Trigger, decision, one-sentence why.
- `Knowledge/<Specialist>/memory.md` — household-level / cross-user
  observations and the specialist's own working philosophy notes.
  Not user-specific; that goes in per-user observations.

Why this matters architecturally:

1. **Continuity across sessions and threads.** A new Claude session,
   a restarted orchestrator, a future redeploy — the specialist reads
   the per-user files via the structural knowledge floor and picks up
   exactly where she left off. No "tell me about your goals again."
2. **Cross-specialist context.** Brigid reads
   `users/<user_id>/astrid/observations.md` before meal planning so a
   hard ride Tuesday means a bigger dinner Monday. Without
   self-documentation, this coordination has to invent its own data
   shape.
3. **User-auditable.** Files are plain markdown in the vault; the
   user reads, edits, or corrects anything the specialist wrote. The
   next read picks up the correction.
4. **Substrate for persona tuning.** Beatrice's
   `propose_persona_tuning` pass reads coaching-log alongside the
   user's verbatim feedback and proposes specific edits to the
   specialist's YAML based on actual decisions, not guesses.

The discipline mirrors the broader "vault as source of truth"
principle: the markdown file IS the specialist's memory; SQLite
indexes it; LLM rounds read from it. Nothing important lives only in
context.

### Structural runtime injections beat per-persona carve-outs

When the same instruction belongs in N specialists' personas, that
instruction belongs in the **runtime**, not in N persona files. The
pattern is now load-bearing in three places, and the rule reads the
same in all three:

1. **`BASE_TOOLSET`** (née `CHAT_BASE_TOOLSET`) in
   [src/core/specialist_runtime.ts](src/core/specialist_runtime.ts) —
   the structural read + memory floor (`search_library`, `read_note`,
   `recall_brain`, `read_inbox`, `remember`, `read_memory`,
   `read_my_proposals`, `present_questions`). Every specialist with
   the appropriate capabilities gets them on every chat AND
   deliberation turn (2026-07-17 — deliberation previously skipped
   the union, stranding autonomous passes without a read path),
   regardless of what their YAML `tools_for_chat` /
   `tools_for_deliberation` lists. Pre-2026-05-27 each persona was
   supposed to remember to ask for these; most didn't.
2. **`render_chat_inbox_section()` + `render_chat_knowledge_first_snippet()`**
   — the inbox preview and the "read your scope before denying" block.
   Auto-injected when the specialist holds `read_inbox` / `read_vault`.
   Closes the Brigid Dunkin'-cup failure where she "didn't have a
   record" of a routed capture she literally owned.
3. **`render_research_workload_block()`** (added 2026-05-30) — six
   research-efficiency behaviors (plan-before-call, batch parallel,
   no-duplicates-in-fan-outs, no-refetch, cap-scope, name-what's-
   missing-on-exhaust). Opt-in via `proactive.research_workload:
   true`. Six specialists opted in at ship (Vivian, Maggie, Cordelia,
   Mariah, Ruby, Beatrice). Replaces the persona carve-out Vivian
   carried in commit `10a0473` — same words, lifted from one YAML to
   the runtime so every research-heavy specialist gets them.

4. **`render_structural_gap_block()`** (added 2026-08-03) — what to do
   when a turn hits a gap (no tool / broken integration / ad-hoc answer
   that deserves a real one). Two variants keyed on `write_codebase_pr`:
   a specialist who can AUTHOR gets the ladder it actually holds and
   names no persona; everyone else keeps the `consult_specialist(trainer)`
   routing essay, which for them really is the only path. It was
   unconditional before, so after the Beatrice dissolution handed Kate
   the build tools it contradicted four paragraphs of her own persona
   from the recency-strong slot BELOW them — and its closing line armed
   the ghost-promise guard against a reply that named Beatrice, so the
   prompt pushed her toward a sentence the runtime then punished her
   for. Keyed on capability rather than id so it self-applies to the
   next fold.
5. **`render_peer_directory()`** in
   [src/core/staff_roster.ts](src/core/staff_roster.ts) (added
   2026-08-03) — the routing directory injected into every chat and
   deliberation prompt. Replaces an inline unfiltered map over
   `specialists.list()` that rendered every FOLDED persona as a named
   teammate (`- trainer: Beatrice, Enterprise Trainer`) directly after
   a `{{staff_roster}}` paragraph saying never to name anyone off the
   visible list. Visible peers keep id + name + role; `subagent_only`
   ones keep the routing **id** and lose the **name** — reachable, not
   nameable. See the module header for why both properties have to
   survive.
6. **`render_tool_reflexes()`** (added 2026-08-03) — the per-specialist
   `tool_reflexes` table (ask-shape → tool), rendered into the CHAT
   prompt between the grounding rule and `chat_style`. The grounding
   rule says "go get it" and says nothing about WHICH call, so the
   model obeyed it and still guessed the tool. This is the structural
   answer to the single most-repeated sentence shape in a mature
   persona ("when he asks X, call `tool_y` FIRST") — as config it costs
   a line instead of a paragraph, lives in one place instead of
   whichever block an author was editing, and is **checkable**:
   `smoke:tool-reflexes` (in `ci:fast`) fails when a reflex names a
   tool that doesn't exist, that the specialist can't reach, that is
   `dispatch_only`, or that is declared twice. That lint is what makes
   "don't deliberate, just call this" a safe instruction to give.

**The decision criterion: would a future specialist hire benefit
from this instruction without anyone remembering to copy-paste it?**
If yes, it's structural — author it as a render helper that fires
on a capability or a new opt-in flag, not as persona prose. The
runtime-injection cost is paid once; the per-persona-drift cost is
paid forever.

The corollary: **specific-case carve-outs are a signal you missed
the general mechanism.** When a fix would be a section in one
specialist's persona, look for the abstraction across the team
first — a `proactive.<archetype>: true` flag with a render helper
is almost always the right shape. The runtime injection makes the
contract explicit and uniform; the carve-out makes it implicit and
drift-prone.

## The three-loop model

Status: **fully wired in Prompt 6c** — every specialist has a real
awareness handler ([src/specialists/awareness/](src/specialists/awareness/)),
deliberation passes produce structured JSON envelopes via
[src/core/deliberation.ts](src/core/deliberation.ts) that write inbox
flags / proposals / interrupts / brief rows, and Kate is the explicit
router-between-staff-and-user.

The earlier (6a) scaffolding fired observations into a buffer that
deliberation read at slot time; 6c extends that so awareness handlers
can ALSO write directly to a peer's inbox (`suggests_inbox_to`) or
ask to interrupt immediately (`suggests_interrupt`) without waiting
for a slot.

### The three loops

- **Awareness loop** — runs continuously. The ingestor watches the
  vault; the scheduler ticks every 60 s; per-specialist passive
  monitors (Prompt 10) watch external signals (HA logs, Plaid feeds,
  inbox events). This loop produces **state** — what the system
  knows about the world right now.
- **Deliberation loop** — runs daily and on-demand. The Concierge
  brief at 7 AM is the deliberation pass for relationships; future
  per-specialist daily passes will be similar (Vivian reviews
  finances, Cassandra reviews home status, etc.). This loop produces
  **proposals** — things the system thinks the user should know or
  act on.
- **Interrupt loop** — runs only when a proposal crosses a
  threshold that justifies stealing the user's attention. The
  approval gateway is the main interrupt today (every send_external
  is an interrupt by default). Future per-specialist interrupt
  budgets will be calibrated separately.

### Why three not one

A single loop (e.g. "the LLM reads everything and decides what to
push") would either be too noisy (interrupting on every state change)
or too quiet (waiting until things are critical). The three-loop
structure separates concerns:

- Awareness is fast and dumb. It updates state.
- Deliberation is slow and thoughtful. It batches state into
  proposals.
- Interrupts are rare and important. They only fire when a proposal
  is worth the user's attention.

The economic logic: **every interrupt has an attention cost. The
interrupt budget is the user's most precious resource.** The system
is designed to absorb and prepare so it can interrupt rarely and
well. A system that interrupts hourly gets muted; a system that
interrupts twice a week with high-signal proposals gets trusted.

### Frequency choices

- **Awareness loop**: continuous (chokidar) and 60 s tick (scheduler).
  No upper bound on how often the system can update its state — only
  on how often it acts on the state.
- **Deliberation loop**: daily at 7 AM local for the Concierge.
  Earlier than the user typically gets going; the brief is "ready
  before you are." Per-specialist deliberation passes will be daily
  too, possibly at staggered times.
- **Interrupt loop**: as-needed, but with a soft cap of "no more than
  one interrupt per hour" outside the morning brief. Enforced
  socially today (the gateway doesn't rate-limit), enforced in
  policy later.

## The reactive loop (2026-05-26)

The Cordelia visual-understanding pipeline added a **fourth loop**
that runs parallel to awareness, deliberation, and interrupts: a
**reactive** loop driven by `AppEventBus` events, not by a tick.
It exists for the class of work where the deliberation cadence is
too slow — a photo lands, the user needs the action *now*, not at
07:00 tomorrow morning. The driver lives in
[src/core/reactive_inbox.ts](src/core/reactive_inbox.ts) and runs
inside the orchestrator process alongside the LoopDriver.

The reactive loop's job is narrow:

1. **Subscribe** to `capture_received` (and, planned, other
   event-shaped signals — voice memo intake is the next consumer).
2. **Cluster** captures within a per-user 5-minute sliding window so
   a 30-photo museum visit produces one routing decision, not 30.
3. **Classify** via a planner-role LLM call that picks a destination
   specialist with a structured-output prompt. Two tracks: doc
   (substantive OCR text) or scene (VL endpoint).
4. **Apply** the decision: write a `capture_routes` row, push to the
   specialist's inbox, **file the capture onto the destination's
   `Knowledge/<Target>/library/` shelf via `save_library_item`** (so it's
   chunked into `chunks_fts` and actually searchable for that specialist —
   and, via Cordelia's `Knowledge/<id>/library` scope, for Cordelia), and
   fire the matching intake handler. Routing only considers specialists the
   capturing user is allowed (`allowed_specialists` — a friend's capture
   can't route outside their set). *(Gotcha: the `Cordelia/Inbox/` wrapper
   note is written via `upsert_note`, which does NOT chunk — only
   `save_library_item` does; routing without the filing step leaves the
   destination an inbox flag it can't retrieve, and leaves Cordelia no
   searchable record of what she routed.)*

Below-threshold (`< 0.4` confidence) decisions don't drop — they
raise an interrupt to Kate via the same
[src/core/interrupts.ts](src/core/interrupts.ts) raise path the
deliberation loop uses. The classifier is allowed to be uncertain;
the human gates the ambiguous cases.

The reactive driver is **deliberately stateless** outside the
in-memory cluster buffer + a small `recent_decisions` cache. A
restart loses no work — the wrapper note + the chokidar projection
remain the durable record, and Cordelia's 04:00 deliberation pass
back-stops anything the reactive driver dropped (no
`capture_routes` row, no `routed_to` frontmatter stamp → her
deliberation reads the unreviewed wrapper). The reactive path is
the *fast* path, not the *only* path.

### Why a separate driver and not "wake_on_capture" on deliberation

We considered piggy-backing on the existing wake-on-flag mechanism
(LoopDriver's debounced off-schedule deliberation fire). Two
reasons it didn't fit:

1. Captures need a CLASSIFICATION step before they reach any single
   specialist — there's nobody for the LoopDriver to wake until the
   classifier picks one. The classifier wants to run independently
   of any specialist's persona / tool surface.
2. A specialist's deliberation pass is expensive — a long persona,
   their full tool surface, a structured JSON envelope demand. For
   "log this receipt to Vivian" the reactive intake handler is the
   right grain (~50 ms of work), not a full deliberation turn (10s
   of seconds, many tokens). Deliberation remains for synthesis;
   the reactive loop is for *acknowledgment*.

### Cordelia's consolidation cycle — the distill stage (Phase 1)

"Deliberation remains for synthesis" became literal at the shelf level
on 2026-06-14. After material is *acquired* and *shelved* (the demand
ledger → subscriptions → sprints → research-commissions metabolism), a
nightly `nightly_shelf_synthesis` job (`synthesize_shelves`, 04:20 —
after the night's acquisition settles) *consolidates* each library
shelf's accumulating raw notes into compact, cited, evergreen syntheses.
This is the back-half of the metabolism and the first stage of Hearth's
per-user "second brain" (capture → distill → connect → retrieve). A
synthesis shelves through the same `chunks_fts` + embeddings primitives
as every library item, so it becomes a high-signal RAG hit the moment
it's written — tending to outrank the raw fragments it summarizes.

The load-bearing property is the **per-user cordon**: a synthesis NEVER
mixes visibility buckets. The pass buckets a shelf's items by their exact
`private_to` value, clusters + distills WITHIN one bucket (deterministic
token-overlap clustering — reproducible, no LLM), and stamps the note to
that bucket — the same topic in a `household` bucket and a `<user_id>`
bucket yields two distinct, separately-stamped notes. Output is
`synthesis_note` (AUXILIARY), so the `clippings` projection excludes it
and the pass can never re-synthesize its own output. Unlike a capture, a
synthesis is *upsert-by-topic* — a stable `_synthesis/<bucket>-<topic>.md`
path so re-synthesizing replaces in place rather than proliferating dated
copies — so it shelves via the chunk/embed primitives directly, not
through `save_library_item` (whose append-style `${date}-${slug}` path
can't give that). Idempotent (a topic whose source set hashes unchanged
skips the planner LLM) and fail-open (a distiller outage skips the topic,
never the pass). A **write-time grounding gate** (Phase 1.5) verifies the
distilled prose against its OWN sources before shelving — the brief_critic
pattern (`assess_factual_grounding`: one tool-free re-distill on findings;
drop flagged sentences or reject the topic when too little survives) — so a
fabrication can't launder into the vault past the read-time fact critic;
synthesis notes carry `derived: true` and a confirmed unsupported specific
is never shelved. Phases 2 (cross-specialist connection edges, visibility
re-checked at read time so the layer never widens scope) + 3 (synthesis
gaps feeding the demand ledger) are designed in
[docs/design-cordelia-consolidation-cycle.md](docs/design-cordelia-consolidation-cycle.md).

**The read path + the self-governing loop (2026-06-15) — what makes it a
brain, not a nightly writer.** A distilled synthesis only earns its keep if
it changes answers, so retrieval now PRIVILEGES it: `retrieve_hybrid` leads
the injected context with the relevant `synthesis_note` (scale-free
rank-promotion, reorder-only so the low-confidence gate is untouched), and
`recall_brain` is the explicit specialist-facing query of the distilled
layer. The loop closes itself on two new signals: a **worth axis** —
`synthesis_usage` counts real retrievals, so the scorer stops being neutral
and a never-used synthesis is identifiable dead weight — and a nightly
**heal pass** (`heal_syntheses`, before the distill) that DELETES integrity-
rotted syntheses (a cited source was removed) and resets their shelf so the
same run regenerates from survivors, and prunes dead weight (unused + old +
low-health, conservatively — health OR recent use protects). The **connect**
stage is live: deterministic cross-shelf token-overlap edges (the mesh; the
cordon holds because nodes are visibility-filtered before linking). The whole
layer is rendered as Cordelia's office canvas (galaxy → shelf → synthesis →
fact, with health-coloured orbs, the cross-shelf arcs, and an owner
re-synthesize cockpit). Every step is fail-open with a kill switch
(`HEARTH_SYNTHESIS_LEAD` / `_HEAL`).

A second pass (2026-06-15 #2) made the loop fully autonomous with NO
owner-facing surface — at Jasper's direction the brain self-ranks, cleans,
aggregates, and fetches entirely in the background; the owner only meets it on
a pull. Worth is recency-weighted (current value, not lifetime count); heal
prunes cold-abandoned weight alongside never-used; the cross-shelf mesh is
semantic (embedding cosine, lexical fallback, capped); and a nightly self-fetch
job reads the demand ledger and runs Cordelia's acquisition in a new SILENT
mode — shelving in-roster for the strongest evidence-backed gaps while
suppressing the out-of-roster proposals, so a background sprint never reaches
the owner's queue (the per-user cordon is preserved end to end). It is also
LIVE: a `LiveSynthesisDriver` subscribes to capture routing and re-distills the
destination shelf the moment material lands (debounced + rate-limited + scoped),
so the brain consolidates new knowledge in real time rather than waiting for the
nightly pass.

### Why the cluster window matters

A capture-by-capture classifier produces narrow decisions ("here's a
photo of a tomato leaf"). A cluster classifier sees the *batch* — 30
photos that share salient objects + a venue keyword in one OCR text
collapse into "museum visit, route to Marguerite." The window also
prevents flag-storms: 30 inbox flags from one walk would drown out
real signal in Marguerite's queue. The 5-minute window is empirical;
shorter windows split clusters that the user perceives as one
sitting, longer windows delay routing on bursts that are genuinely
isolated.

The first-capture *bypass* (flush immediately, then keep the bucket
open for follow-ups) is the asymmetric optimum: the user expects
their single photo to be acknowledged in the receipt; if a second
one lands a moment later, the classifier sees both together on the
second flush and produces a refined decision. The intake handler
runs once per route, not once per capture-in-route, so dual flush
doesn't double-act.

### What runs in the reactive loop today, what doesn't

- **In**: Cordelia captures (`capture_received`).
- **Planned next** (per
  [BACKEND_VISUAL_CAPTURE_BRIEF.md](../hearth-ios/BACKEND_VISUAL_CAPTURE_BRIEF.md)
  follow-ups in PLAN): voice-memo transcription via the
  push-receiver — once the local transcript is good enough that the
  classifier can run on it directly. Currently voice memos with
  `localTranscript` already participate in the visual pipeline as a
  doc-track input.
- **NOT in**: outbound proposals, peer escalations, the brief
  cadence. Those stay on the deliberation loop where the cadence
  matches the work.

### The reactive trigger layer (2026-06-18) — event-driven deliberation waking

The reactive loop above acknowledges a capture cheaply (~50 ms intake). The
**reactive trigger layer** is the complementary move for the *deliberation*
side: wake a specialist's full deliberation pass on the **edge of a real-world
state change** instead of only on the `deliberation_at` clock. It exists because
the roster's ~28 scheduled deep-tier passes/day are mostly domain *polls* ("did
anything change since 07:00?" → "no") that also fire as a burst — the same
thundering herd that starved interactive chat/voice until background work moved
to forza. A cron tick is a poll; this turns the poll into a subscription.

It is a **generalization of the existing `wake_deliberation`** (which already
woke a deliberation off-schedule, but only on an inbox flag), built the same way
`LiveSynthesisDriver` generalized the nightly distill:

- **`LoopDriver.wake_deliberation_scoped(id, { task, reason, dedupe_key, … })`**
  ([src/core/loops.ts](src/core/loops.ts)) is the shared fire path. It debounces
  per `(specialist, dedupe_key)`, rate-limits with a per-key `min_interval`, and
  fires `deliberate()` at slot `trigger:<key>` carrying a **`TriggerContext`**
  (reason + task) that *replaces the standing "scheduled reflection" prelude* with
  scoped framing ("you were woken because X — focus on this"). It inherits
  `deliberate()`'s per-specialist serialization chain + the **deep tier**
  (`specialist_deliberation` role), so a flood of triggers can never contend with
  the interactive tier.
- **`ReactiveTriggerDriver`** ([src/core/reactive_triggers.ts](src/core/reactive_triggers.ts))
  subscribes once to the `AppEventBus`. A **`TriggerDef`** owns the typed
  matching + edge-detection for one kind of world change; it runs **once per
  event** (the edge is a world fact), then the wake **fans out** to every
  specialist whose YAML `proactive.triggers` subscribes to that def — each with
  its own scoped `task`. So two specialists subscribing to `home_arrival` share
  one edge but get two scoped passes. Matching lives in typed TS (the
  awareness/intake-handler idiom), not a YAML expression — no eval foot-gun.
- **Two entry points, one fire path.** The push path is the driver above
  (event-bus-driven, for signals that already arrive as events). The **probe
  path** is `AwarenessObservation.wake_self` — an awareness handler that
  edge-detects a condition with *no* push event (a refill date crossing, a market
  threshold) and wakes its own deliberation through the same
  `wake_deliberation_scoped`. The cheap awareness tick is the edge detector; the
  expensive deliberation fires only on the edge.

Guardrails (all mirror the LiveSynthesis/escalation contracts): **edge-triggered**
(fire on false→true only; a level can't re-fire), **debounced + rate-limited**,
**deep-tier only**, **fail-open** (a throwing def is logged and skipped), and
kill-switched (`HEARTH_REACTIVE_TRIGGERS=0` makes `attach` a no-op → byte-identical
to today; `proactive.triggers` defaults to `[]`, so the roster is unchanged until a
YAML opts in). Crucially, **live ≠ noisy**: a woken pass that surfaces nothing
pushes nothing, and what it *does* surface still flows through the proposal/interrupt
→ `push.ts` quiet-hours/threshold gate. The autonomy is in the reacting; the
restraint is in the speaking.

The flagship def is **`home_arrival`**: iOS posts a `signal:location` packet on a
region/visit transition; the def mirrors `compute_is_home` (arrival/enter at the
`home` anchor ⇒ the away→home edge) and wakes **Luna** — the household / Home-office
owner — scoped to a quick house-systems read. Increment 1 ships the spine + this one
trigger; migrating the low-event *polling* passes onto triggers/`wake_self` (and
thinning Kate's brief toward render-of-pre-assembled-state) is the documented
follow-up — each a small, independently-reviewable step, not a roster collapse (the
many-narrow-specialist decomposition is load-bearing for the small model's tool
surface; the waste was in the *scheduling*, which this fixes).

## Deep research — subject-oriented detached investigations (2026-06-19)

A chat turn is structurally incapable of *deep* research: the runtime hard-caps
external fetches (8/turn), tool rounds, and reply length, and there is no way to
start async work — so "deeply research my massage therapist" rationally produces a
skim plus a "ask them directly" punt. The answer is not a bigger chat budget (that
just trades one ceiling for another and blocks the turn for minutes); it's a
**hand-off**. `deep_research` files a `research_investigations` row and kicks a
**detached runner** that escapes the chat ceiling entirely, then Kate tells the
user she's on it and reports back when the dossier lands.

It is deliberately a *sibling* of Cordelia's research commissions, not an
extension of them. A commission builds a specialist's standing **roster** (its
output is a catalog of sources); an investigation answers a **question about a
subject** (its output is a synthesized, cited dossier). The execution models also
differ: a commission walks subtopics **sequentially**; an investigation **fans
out** across sub-questions and **verifies** before it synthesizes. Sharing the
runner would have meant mangling the commission's careful cursor-resumability to
graft fan-out on; instead they share only what's genuinely common — the
binary-aware fetcher (lifted to `src/core/research_fetch.ts`), the
slice/kick-detached *pattern*, and the grounding judge.

"Sub-agentic" here is honest within the repo's no-new-agent-runtime rule: it is a
**bounded fan-out of focused LLM calls + the existing connectors**, orchestrated
by the runner — not an agent loop. The fan-out concurrency is capped at 2 against
the shared 4-slot deep tier so a background investigation can never starve an
interactive `consult_deep_model` escalation or the deliberation lane; only the
per-sub-question extraction and the final synthesis touch the deep tier, while
query-planning, search, and verification run on the fast/planner tier. Verification
reuses `assess_factual_grounding` (the same adversarial grounding judge the
chat-finalize critic uses) rather than a bespoke re-fetcher, and the runner
enforces its verdict **deterministically** — a `scrub_dropped_claims` pass removes
any dossier line still asserting a dropped specific, so honesty does not depend on
the synthesizer obeying an instruction. The per-user cordon (`private_to`) holds
end-to-end: the row, the shelved dossier, the office route, and the read tools all
scope to the requester, and the owner has no god-view of a household member's
investigation. Live progress reaches the web via a `research_investigation_updated`
SSE event per slice (the Research office tab refetches), and the finished dossier
lands as a searchable library note plus, for a person, a People-note summary.

### v2 phases 1–2 — keeping the evidence, and recording what went missing (2026-07-29)

The v1 pipeline had one worker shape and one quality gate, and the gate could not
fail. Two structural gaps, both closed at the layer that owned them (full design +
the remaining phases: [design-deep-research-v2.md](docs/design-deep-research-v2.md)).

**The evidence was being discarded.** A sub-investigator fetched a page, fed 6,000
characters to the extractor, and threw the text away — only the url and title
survived. So `verify_investigation` had no corpus and assembled one out of the
*finding texts*, making every claim trivially supported by itself; a real dossier
carrying a false claim recorded `claims_checked: 4, verdicts: []`. The fix is
architectural rather than clever: an additive `research_sources` table persists
every readable body, keyed `(investigation_id, url)` with a stable row id so a
resumed phase refreshes rather than duplicates. It also captures what only exists
at fetch time — the `publisher` (read off the url) and a best-effort
`published_at` parsed from the page's own leading text, which is the missing half
of "a vote recorded on the date its coverage was *published*": you cannot compare
an event date against a publication date once the page is gone. Bodies inherit the
dossier's `private_to` cordon exactly (the owner has no god-view of a member's
evidence trail), are capped with truncation *recorded* so a downstream
quote-containment failure is interpretable, are written fail-open, and expire on a
retention window swept inline by the runner. Notably, phase 1 stops there and does
**not** rewire the verifier: a gate that can finally fail can finally fail
wrongly, and its verdict feeds a pass that deletes dossier lines, so precision is
tuned against real dossiers before any drop is enabled.

**A lost facet was an absence, not a state.** A six-facet brief lost four facets
to arithmetic (six sub-questions × three fetches), and nothing recorded the loss —
a facet nobody attempted was indistinguishable, in the finished dossier, from one
the sources genuinely could not answer. The primitive that fixes it is a single new
sub-question outcome, `not_attempted`, separating *we never got to look* (slice
deadline, search-backend outage, a deferred fetch) from *we looked and found no
answer*. Only the former is resumable, and collapsing them is what made the loss
invisible. A pure `compute_coverage` maps the plan into a ledger the dossier
**opens with**, prepended deterministically because a section the model composes
is a section the model can omit — while the gap list is also handed to the
synthesiser so it states the shortfall rather than writing around it. An
investigation carrying unattempted facets is `incomplete`, an *open* status the
existing sweep resumes by re-running only the missing facets; shelving, the
person-note writeback and the requester's push all wait for `done`, so a resume
cannot double-notify. Resumption is bounded, and past the bound a leftover becomes
an honest `unanswerable` — an open status the sweep can never close would just be
a new silent failure. Every reporting surface now carries the coverage, because
"the full report is ready" for a report missing four of six facets is the original
failure relocated.

## The search layer — SearchRouter (2026-06-19)

Web search is the muscle behind every agent — 74 `web_search` call sites, plus
the deep-research fan-out that issues ~18 searches per investigation — and until
this pass it was the system's weakest link: every call hit SearXNG → the keyed
Brave Search API raw, with no caching and no reranking, driving ~6,000 Brave
requests/month of which a large fraction was redundant. The fix is deliberately
*one mechanism, not 74 carve-outs*: `web_search` became a thin delegate to a
module-level `SearchRouter`, so the upgrade is invisible to callers yet lifts all
of them at once. The router does what the bare call never did — cache, rerank,
and abstract the provider — and it reuses infrastructure already running rather
than adding a vendor (the explicit "stay lean" choice: Brave stays primary).

The cache is the bulk of the cost win and is the right shape *because search
results are public data* — there is no per-user cordon to respect, so a
process-global LRU keyed on the normalized query is correct (contrast the vault,
where every read is cordoned). It stores the reranked top-20 once and slices to
each caller's `max_results`, so a repeat query — common across turns, agents, the
critic re-verify nudges, and a fan-out's overlapping sub-queries — is free: no
Brave request, no GPU. The rerank reuses the same fail-open bge cross-encoder the
RAG path uses (the A4000 was already running it, idle for this purpose); it
reorders Brave's keyword ranking to the agent's *exact* query phrasing, which is
where the quality lift concentrates for precise deep-research sub-questions.
Crucially the rerank is *reorder-only* — it never changes the result set and a
null score (endpoint down) keeps provider order, so it can only help. The
provider is an interface with one implementation today; the seam exists so fusing
or falling back to a neural/agent-grade backend later is configuration, not a
rewrite, but nothing new is wired. A sibling fetch cache applies the same logic
to page reads (successful fetches only; bypassed for login-gated `browser_first`
fetches whose value is the live signed-in render). Everything is fail-open and
kill-switched, so the whole layer degrades cleanly to the pre-router behavior —
and the reranking specifically engages only when the RAG vector stack is on,
falling back to cache-only otherwise.

## Operational health + self-healing (2026-06-20)

A core dependency died and the system ran on for eight days as if nothing were
wrong — research came back empty, every agent's web-fetch silently failed, and the
only way it surfaced was a human noticing a blank report and SSHing in. The flaw
wasn't the broken service; it was the absence of operational *awareness*. Hearth
had careful per-call recovery hints and a fastidious audit log, but nothing stood
back and asked "are my dependencies actually working?" — so a failure that was
loud in the aggregate (a tool erroring on every call for a week) was invisible
because no one read the aggregate. This adds that missing layer as a general smoke
detector, deliberately not a Firecrawl patch: the next dead LLM endpoint or
embeddings server is caught the same way.

The detection is two signals because a dependency can fail two ways. An endpoint
probe catches a service that's simply unreachable — including one nobody happened
to call, which an audit-log-only approach would miss. The audit-log error rate
catches the harder case: a service that answers but fails every request. The
subtlety that made the original outage invisible is encoded here — a connector
tool reports failure by returning `{error}` in its *output*, which lands in
`execution_result`, not the audit row's `error` column, so the health query has to
read both. Neither signal is trusted to crash the assessment; a probe that throws
just marks its own dependency down.

The honesty of the surface comes from modeling *incidents*, not instantaneous
state. An incident opens on the edge into trouble and carries its `first_seen`, so
the system can say "down for eight days" truthfully and alert exactly once rather
than every time it checks. That single design choice is what separates a useful
monitor from an alert-fatigue generator.

The remediation tier reflects a hard-won lesson from the live test that birthed
this feature: restarting the dead worker did *not* fix the deeper fault. So the
self-healing is studiously un-triumphant — it restarts the actual failing
container (not the user-facing service), it refuses to restart-loop (a couple of
attempts, then it escalates to the owner), and it never marks an incident resolved
on its own authority; only the next health scan, seeing the error rate actually
drop, closes the loop. The split of duty is the same chief-of-staff/meta-agent
division the rest of the system uses: Kate notices and triages and tells the
owner; Beatrice, who already owns changing the system, owns fixing it — by restart
when that's the fix, by her reviewed change pipeline when it's config or code, and
by honest escalation when it's neither.

The one genuinely new piece of trust is the restart itself. The orchestrator runs
in a container with no Docker access by design, so remediation goes through a
tiny, tightly-scoped sidecar — the same pattern as the Wake-on-LAN relay — that
can do exactly one thing: restart a container whose name is on an explicit env
allowlist (empty by default), bearer-gated, over the Docker socket. It is not a
general Docker surface; the blast radius if its credential leaked is "restart an
allowlisted service." And the whole layer is opt-in in two stages — detection and
escalation work with no sidecar at all (remediation simply becomes "escalate to
the owner"), and self-healing turns on only when the owner wires the relay and
names services it may touch.

The remaining gap was that the escalation was *shallow*: "Firecrawl down, 98%
failing" tells Beatrice that something is wrong but nothing about WHY, and the
actual root cause in the live incident — `firecrawl-worker Exited (1) ELIFECYCLE`
— lived only in the worker's container logs, which nothing read. So the same
two-step opt-in now extends to *diagnosis* (`diagnose_dependency`,
`src/core/health_diagnosis.ts`), automating the work a human does by hand — read
the logs, find the crash, reason about the cause, propose and weigh fixes —
entirely on the **local** deep model, because operational diagnosis is exactly the
kind of always-on, privacy-sensitive reasoning that should never leave the house.
The shape deliberately reuses the deep-research engine's discipline applied to an
incident instead of a subject: gather an evidence pack (the actual error strings
from the audit log, the probe, the resolved config, and the container logs via a
new *read-only* `/logs` endpoint on the same guarded relay — same bearer, same
allowlist, one shared gate so the read path can never be looser than the restart
path), reason to a root cause grounded only in that evidence with the shared fact
critic dropping anything the logs don't support, then adversarially score each
typed candidate fix on likelihood, risk, reversibility, and blast radius and rank
them by a pure deterministic composite. The load-bearing constraint is that the
diagnosis layer has *no authority to act*: every fix it proposes names an existing
gate (the circuit-broken restart, the reviewed config/code change, or honest
escalation), so the new capability is purely "understand and recommend." What
reaches the owner is no longer a bare alarm but a diagnosed incident with ranked,
scored options — and the only thing Beatrice may apply without him is the same
high-confidence restart she already could, now justified by evidence rather than
reflex.

### Instant guard-feedback — closing the loop on quality misses (2026-06-22)

The same shape — *detect aggregate failure, diagnose locally, recommend through
existing gates* — generalizes from infra outages to the system's OWN quality
misses. The finalize reply-guards and the tool-arg recovery layer already caught a
fabricated save, a ghost promise, a data-denial-without-query, or a tool call the
model couldn't get past validation — and re-rolled it in-turn so the user never saw
it. But that catch only wrote an audit row; the *pattern* it belonged to sat unread
until a nightly scan happened to mine it. The exact wound the operational-health
layer fixed for Firecrawl, one level up: a failure loud in the aggregate, invisible
because nothing stood back and read the aggregate.

The fix mirrors `scan_system_health` but runs on the *edge* instead of the clock. A
guard catch emits a `quality_signal`; a driver aggregates recurrences per
`(class, guard, tool/specialist)` over a rolling window and, on the edge, files a
process_miss (Mariah's program ledger) and wakes Beatrice with a scoped diagnostic
task — over the same deep-tier, debounced wake spine the reactive triggers use. The
load-bearing discipline is *edge-only*: a single re-rolled catch is not an incident
(the runtime already handled it), so only a genuine recurrence escalates — and the
meta-agents are skipped as producers, because a system that diagnosed its own
diagnoser would drown in self-noise (the lesson of the 2026-06-09 meta-loop audit).

What makes the woken pass more than another alarm is that Beatrice now has the
*human* diagnostic loop in code. `diagnose_tool_failure` is the tool-call sibling of
`diagnose_dependency`: it reads the audit error text, extracts the literal
PROVIDED-vs-REQUIRED field mismatch (the model sent `path`; the schema demanded
`note_path`), reads the tool's own schema, and PROBES the live interactive endpoint
to settle the one question a human always asks first — *is the model wrong, or is the
schema?* If the endpoint emits valid args for canonical shapes, the model is fine and
the recurring failure is the contract. The diagnosis is grounded (the fact critic
drops any specific the evidence doesn't support) and every proposed fix names an
existing gate — so, exactly like the infra diagnoser, this is "understand and
recommend," never a new authority. The fix she ships travels her unchanged
change pipeline: Kate's review, then the owner's merge.

## The live-session loop (Astrid Pass 3 — shipped; insight + voice 2026-06-10)

Designed 2026-05-27; the deterministic throttle/trigger loop shipped as
Astrid Pass 3, and **Live Ride Companion Phase 1 (2026-06-10)** layered
inference and voice on top — see
[docs/design-astrid-live-companion.md](docs/design-astrid-live-companion.md).
The layering contract: **detection stays deterministic and LLM-free per
packet** (`live_throttle.ts` + `insight.ts` — zone shifts, distance
milestones, pace changes, HR drift, longest-in-30-days, cooldown); on a
hit, the cue TEXT is rendered by the `live` tier grounded in the session
evidence (`cue_render.ts`, deterministic numeric-grounding check,
fail-open to the fixed templates), a Laur clip is synthesized
(`cue_voice.ts`, Laur TTS on the the LLM host RTX 6000 Ada `:8023` → ffmpeg → Opus-in-CAF, fail-open to
text-only), and delivery rides an APNs `hearth.workout_cue` payload
carrying the clip ref (owner-cordoned `GET /api/workout/cues/:clip_id`),
falling back to `push_text`. Cadence/mute are user state, not code:
`users.yaml` `training.cue_*` + the `workout_sessions.cues_muted`
column. Every fail-open lands exactly on the pre-Phase-1 behavior.

The reactive loop is event-triggered but **one-shot per event** — a
capture lands, the classifier picks a destination, the intake handler
fires, done. The live-session loop is event-triggered but
**long-lived with sub-events**: a workout starts, the specialist
enters a sustained coaching stance for the duration of the session,
new sensor packets stream in at ~30s intervals, and the specialist
emits throttled coaching output until the workout ends.

The canonical case: Astrid's in-workout coaching. Apple Watch
starts an `HKWorkoutSession`; iOS streams per-30s packets to
`/api/sensors/workout` with rolling HR / pace / distance / active-kcal;
a `workout_started` AppEvent wakes Astrid off-schedule into "live
mode"; she reads her per-user PR shelf (`Knowledge/Astrid/records/
<workout-type>.md`) to know what counts as in-reach today; she
decides per-packet whether to push a coaching note; `workout_completed`
on the final packet ends the session, triggers the post-workout
journal write, and flips off live mode.

### Why a separate channel from reactive

A workout is one event in the reactive sense (`workout_started`) but
generates 60-180 sub-events over its duration. Running this through
the reactive classifier would re-classify every packet to the same
destination — wasted rounds, no new information. Live mode says:
*one event opens the channel, the channel stays open for the bounded
session, sub-events are routed implicitly to the specialist who
opened it.*

The channel ends on a session-end event (`workout_completed`), a
session timeout (no packets for 5 min while session was active), or
an explicit user "stop" command.

### Live session state is warm in SQLite, not just in memory

The `WorkoutSessionTracker` is the in-memory authority for a live
session (rolling HR/kcal/zone-minutes + the push-ledger the throttle
reads). But in-memory state dies with the process, and an orchestrator
restart mid-ride used to drop the Activity pane to a degraded "Live
readings unavailable" stub even though the `workout_sessions` row still
said `status='active'`. So the route (`POST /api/workout`, mounted at
the top level to avoid the `/api/sensors/:signal` collision) now **warms
the row's rolling columns on every heartbeat** — `current_hr`,
`current_hr_zone`, `elapsed_s`, `active_kcal`, `distance_m`,
`last_packet_at` (rolling zone-minutes reuse `hr_zone_minutes_json`).
The pane and `get_workout_state` read this warm row through
`MemoryClient.query_active_workout` rather than poking the tracker, so a
live session survives a restart; and a heartbeat for a session the
tracker doesn't know **rehydrates the tracker** from the warm row so
live coaching + the push-ledger resume mid-ride. The tracker stays the
source of truth only for the ephemeral push history (not persisted —
restarts reset it; orphan GC covers the rest). Completed workouts are
read via `MemoryClient.query_workouts` over the `healthkit` workout
packets (the superset that also catches post-hoc Apple-Health rides that
never streamed live).

### Push throttle is structural, not advisory

A live-mode specialist with no throttle would spam notifications on
every packet — the model would happily narrate every kilometer. Push
spam erodes trust faster than silence does. The architectural
controls:

- **Hard cap per session window.** Astrid's design: one push per
  10 minutes mid-workout, regardless of how interesting the model
  thinks something is. Enforced in the push channel, not the persona.
- **Smart triggers only.** PR-in-reach, HR-zone drift, midpoint,
  final-push window. Silent inside HR zone 2-3 with no anomaly.
- **Periodic check-in budget.** A separate slot every ~15 min on
  long sessions for "still with you" presence, even when no trigger
  fires. Tunable per user via the same per-user threshold mechanism
  as the recovery-snack flag (`users.yaml` config).
- **Quiet-hours bypass is session-scoped.** Quiet hours normally
  gate every push; an active live-mode session flips that gate off
  for the session's duration only. Closes when the session does.

### Distinct from interrupt budget

The approval-gateway interrupt budget governs proactive pushes that
steal user attention from whatever they were doing. Live-mode pushes
go to a user who is *already* doing the activity the specialist is
coaching — they expect to hear from her, and the cost of an extra
push is low *as long as* it's earned. So the two budgets compose:
the interrupt budget continues to gate ambient pushes (proposals,
flags, brief deliveries); the session-window throttle governs only
the pushes within the live channel.

### What this is NOT for

- One-shot events with no follow-up state (Cordelia captures, voice
  memos). Reactive loop handles those.
- Scheduled work that happens to take a while (Beatrice's 03:00
  audit scan, Kate's 07:00 brief generation). Those are deliberation
  passes that the LoopDriver already serializes.
- Pseudo-streaming where the specialist polls. If there's a real
  stream, use it; if there isn't, the deliberation loop is the
  right rhythm.

Live mode is specifically for the case where a real external session
opens (a workout, a future driving session, a future cooking session
with the camera on), runs for a bounded time with continuous signal,
and benefits from low-latency reactive coaching across that
duration.

## Kate as router

Kate's job in 6c is **filtering**, not forwarding. Every
non-Kate-originated interrupt routes to her inbox first (with
`related_interrupt_id` linking back to the interrupt row). At her
next deliberation she chooses one of:

- **Absorb** (`absorb_interrupt` tool) — acknowledge the interrupt
  with a note of what she did instead (drafted a proposal, flagged
  to another specialist, decided no action). Most cases. The
  absorption rationale is appended to the interrupt's `details_md`
  so the audit trail captures Kate's judgment.
- **Promote** (`promote_interrupt` tool) — re-raise as a fresh
  interrupt with `routed_to='user'`, attaching her rationale.
  Rare. Triggers the `would_have_pushed` audit row, and the push
  pipeline (src/policy/push.ts) delivers the alert to the user's
  registered iOS devices via APNs.

Her calibration is visible in the audit log: the absorb/promote
ratio over time is the metric for whether her filtering is well-
calibrated. Promoting too often means she's not filtering enough;
never promoting means she's swallowing things the user should see.
Don't auto-tune this from data — it's a deliberately human-shaped
decision that the audit log makes inspectable.

The corollary: when a Kate-originated interrupt fires (rare —
usually only at her own report-time slots or via promote), it goes
straight to `routed_to='user'` without re-routing through herself.

## Tiered autonomy (2a → 2b → 2c → 3)

Status: **storage + graduation framework implemented** in Prompt 6a.
Every proposal carries a category_signature_hash; approvals accumulate
on the signature; signatures that earn approvals-without-edits at the
configured thresholds (see [config/autonomy.yaml](config/autonomy.yaml))
become candidates for graduation, surfaced as proposals of
`kind=recommendation` that the user explicitly approves. The user
approves graduation; the system never auto-graduates itself. Real
sending tools land in Prompt 8 and will plug into the same signature
machinery.

**What belongs in the queue at all (2026-07-04):** a proposal card asks
the owner's PERMISSION, and the standing floor is narrow — send_external,
spend_money, step-up, plus genuine judgment calls. `propose_action`
enforces this at filing time: an `action_proposal` whose named tool
(`dispatch_tool` / `tool_name`) carries a `read`/`write_internal` risk
tier in the ToolRegistry is rejected with a do-it-now steer — the
specialist executes the internal action directly and reports it in the
reply/brief instead of carding an offer. Classification is the tool's
declared risk tier (registry data), never a keyword list; `dispatch_only`
tools, step-up/money specs, and system kinds are excluded. Kill switch
`HEARTH_INTERNAL_ACTION_GATE=0`; see the CLAUDE.md note and
`smoke:internal-action-gate`.

### The Trust Ladder — autonomy as an RPG (2026-06-20)

Jasper's framing turns the abstract graduation ladder into a legible,
motivating progression. **draft→tap→PIN stays the permanent floor** — Kate
never silently sends or spends — but each *decided* proposal awards **XP**
weighted by the action's **risk × the decision effect** (a clean accept earns
full; an edited accept partial; a denial subtracts, clamped at 0). XP
accumulates **per category-signature** (per "skill"), and a signature must
hold the **XP threshold for its tier to graduate — ANDed** with the existing
approval-count gate AND the authenticity + eval-health floors. The closed loop
reinforces Kate doing the right things; the owner watches her level up and
grants each new capability.

The engine is pure ([src/core/trust_xp.ts](src/core/trust_xp.ts): `xp_for`,
`level_for`, `risk_class_for`, `xp_threshold_for`); accrual happens at the one
`ProposalsStore.decide()` chokepoint (`_award_trust_xp`); `category_signatures`
gained additive `xp`/`level` columns. Config is a YAML block in
[config/autonomy.yaml](config/autonomy.yaml) (`trust_xp:` — base XP by risk,
effect multipliers, per-tier XP thresholds). **DARK behind `HEARTH_TRUST_XP`**
— off → no XP is written and graduation is byte-identical to pre-Trust-Ladder.
`trust_level_for(hash)` is the read surface for the eventual "Kate's Growth"
office.

**Hearth rank badges** are the visible face. The same decide() chokepoint also
accrues XP to a per-specialist total (`specialist_xp` table, `_bump_specialist_xp`),
from which `compute_specialist_rank` derives a copper→silver→gold→platinum→diamond
badge + level + XP bar (a linear-growth level curve, its own progression separate
from the graduation thresholds). `GET /api/specialists/:id/rank` (specialist-global,
no cordon — a rank is the specialist's standing) serves the chat-header + office-pane
badge in the web client; gated by `HEARTH_TRUST_XP` (off → `{enabled:false}` → the
badge stays hidden).

**Trust teeth — the ladder's first actual unlock (2026-07-02, DARK).** Until
now graduation changed nothing at execution time. With `HEARTH_TRUST_TEETH=1`
(separate from `HEARTH_PROPOSAL_COURT`), a **user-action** proposal
(`TEETH_KINDS` allowlist — never `draft_message`, never anything
`is_owner_only`) whose signature earned **tier2c/tier3** and draws a unanimous
recusal-adjusted Proposal-Court bench is **armed**: a durable `trust_autoexec`
row schedules execution after an undo window (`HEARTH_TRUST_UNDO_MINUTES`, 30)
and the user is push-notified what will run and how to stop it. The proposal
stays `pending` through the window — the queue's Deny IS the undo (and carries
the negative XP through the normal decide path); the orchestrator's 60s sweep
then executes survivors through the same `decide()` +
`execute_approved_proposal` machinery an owner tap runs
([src/core/trust_teeth.ts](src/core/trust_teeth.ts)). **Arming is gated on
evidence**: the court scorecard
([src/core/court_scorecard.ts](src/core/court_scorecard.ts) — court-vs-owner
agreement from resolved splits, reversals, digest reactions, plus a
historical-signature backtest; `GET /api/proposals/court_scorecard` + Kate's
`court_scorecard` tool) documents the bar — ≥90% overall agreement over ≥10
comparisons across ≥1 week — and the flip stays a human decision.

**Mail second-brain shelving** is the second-brain feed for the Post Office: the
event-driven `MailShelfDriver` ([src/core/mail_shelf.ts](src/core/mail_shelf.ts))
subscribes to `mail_message_triaged` and shelves significant non-bulk mail through
`save_library_item` (vault note + chunks_fts + embeddings, RAG-searchable + feeding
the knowledge graph), idempotent via `mail_messages.shelved_at`, the
`save_library_item` call injected so src/core stays @app-value-free. Cordon: stamped
`private_to` the account OWNER — mail never leaks cross-user via RAG, even from a
household-shared account. DARK behind `HEARTH_MAIL_SHELVE`.

### The generic signal router + Calendar attribution (Phase 2, 2026-06-20)

Phase 1 hard-wired sources into the graph; Phase 2 makes routing source-agnostic.
The `SignalRouter` ([src/core/signal_router/router.ts](src/core/signal_router/router.ts))
is the shared deliver primitive — a cordoned inbox flag + `inbox_message_added`
SSE + audit, in one call — extracted from Cordelia's capture spine. Captures
delegate to it (source #1, behavior-identical); the **Calendar source**
([src/core/calendar/calendar_source.ts](src/core/calendar/calendar_source.ts)) is
source #2. Each source keeps its own classify + persistence; the router owns
delivery.

**Owner attribution** answers "whose event is this?" on a shared calendar where
generic titles can't. `attribute_event_owner`
([src/core/calendar/attribution.ts](src/core/calendar/attribution.ts)) FUSES the
signals the title lacks — the sub-calendar naming a member, the organizer, the
location→Place(`private_to`), and a LEARNED fingerprint (title+location+weekday+
hour) — into a per-member score. A clear signal attributes; conflicting/absent
ones stay UNCERTAIN, so Kate ASKS rather than assuming the owner (the bug). Her
`set_event_owner` tool records the answer to `event_attributions`, so the next
occurrence of that generic slot self-attributes. The Calendar source writes an
attributed, cordon-stamped `life_event` per new event and batches one calendar
FYI to Kate. DARK behind `HEARTH_CALENDAR_GRAPH`.

## The Household Knowledge Graph (2026-06-20)

The signal-fusion substrate: a shared, cordon-respecting store every specialist
reads/writes, so a raw signal becomes connected knowledge. Phase 1 covers the
**purchased-good** slice; calendar life-events + people-accretion follow.

- **Nodes are PROJECTED vault notes.** `household_good`
  ([schema](src/memory/schemas/household_good.ts)) is registered like People/
  Places — a vault note (RAG-searchable, Obsidian-visible, `[[wikilink]]`-able)
  projected by the ingestor into a `household_goods` SQLite table so it's also
  **date-scannable** (the warranty/return reactive triggers). Cordon-native via
  `stamp_private_to_if_needed(..., 'shared_entity')`: a household good stamps
  `'household'`; a member's personal good silos to them; the owner has NO
  god-view (`query_household_goods` is cordon-filtered).
- **Typed inference edges.** `graph_edges` keeps the wikilink structure; the new
  `knowledge_edges` store ([src/memory/stores/knowledge_edges.ts](src/memory/stores/knowledge_edges.ts))
  holds machine-inferred, typed relations (`owned-by` / `purchased-from` /
  `gifted-to` / `attending` / `implies`) with confidence + source, each carrying
  the node's cordon.
- **The signal router.** Per Jasper ("should they go through Cordelia? — yes, via
  the shared router"), order signals fuse through one driver. `mail_ingest`
  emits `order_upserted`; the `HouseholdGraphDriver`
  ([driver.ts](src/core/household_knowledge/driver.ts), the ReactiveInboxDriver
  pattern) enriches (deterministic [enrich.ts](src/core/household_knowledge/enrich.ts):
  category classify + return/warranty implication windows + typed edges), writes
  the good node + edges, and fans the slice to **Vivian** (cost, every good) +
  **Luna** (warranty/manual, durable goods) as cordoned inbox FYIs; **Kate**
  reads the running picture. The good is written ONCE; each specialist reads its
  slice — no duplication. This is the first concrete source of the generalized
  signal router (Phase 2 extracts the generic cluster→classify→fan-out from this
  + Cordelia's capture spine — the principled two-source moment). Seam:
  [signal_router/types.ts](src/core/signal_router/types.ts).
- **Reason on the edge → Kate acts.** Kate's `scan_good_followups` background job
  (job-only, gate `monitor_household_goods`) date-scans goods for closing return
  windows / expiring warranties and, on the edge (surfaced once per good+kind via
  `ProposalsStore.exists_for_signature`), files a cordon-scoped followup
  `action_proposal` so she OFFERS to act — gated by the owner's tap, accruing
  Trust-Ladder XP when decided. DARK behind `HEARTH_HOUSEHOLD_GRAPH`; fail-open
  throughout.

### The Services & Bills ledger (executive-assistant endgame Phase A, 2026-07-04)

The household's STANDING vendor relationships — the facts Kate reasons from
without being told ("we have Republic waste service → this bill is
legitimate"). `household_service` is the second PROJECTED node type in the
graph (schema + `household_services` table + projector, the household_good
pattern file-for-file), keyed on the normalized sender root domain
(`vendor_anchor`) so learner re-runs refresh rather than duplicate. The
learner is Kate's weekly `learn_household_services` background job with a
LAW #1 split: deterministic code clusters inbound `mail_messages` into
recurring-sender candidates (counts, median cadence gaps, money-mention
extraction); ONE deep-tier call judges which numbered candidates are real
services and assigns vendor/category/cadence/amount/autopay/status; code
stores the verdicts and derives `next_due_estimate`. Three read surfaces:
the comprehensive `household_services` chat tool (matched vendors + the
bills picture + a monthly-equivalent total), the working-memory "Bills &
services" section, and **mail-triage grounding** — `ingest_one` fetches
cordoned ledger matches for a sender's domain + the household member names
into the triage judge's evidence block (sanctioned evidence-shaping in a
system pipeline; the model still judges, and an auth failure still trumps a
claimed vendor). Never sends or spends. DARK behind
`HEARTH_HOUSEHOLD_SERVICES`; gate `monitor_household_services` (Kate only).

### The relationship-and-role graph (People reasoning substrate, Phase 0, 2026-06-22)

Relationships are a third SOURCE feeding the SAME `knowledge_edges` graph — the
People layer's move from *recording* to *understanding* ("Rosa is Sam's
hairdresser"; "Rachel works at the salon"). Not a parallel table; a new
`relates-to` edge kind on the existing store (the general-mechanism rule).

- **Authoring truth = `relations` frontmatter, projected.** A person note's
  `relations` ([person.ts](src/memory/schemas/person.ts), now permissive — legacy
  `{name, relation}` AND role/place `{to, to_kind, predicate, provenance,
  confidence}`) is the vault-authoritative truth; the ingestor projects it into
  typed `relates-to` edges via [person_relations.ts](src/core/person_relations.ts)
  (`relation_edges_for`) in [project.ts](apps/ingestor/project.ts). The role rides
  `context`; provenance (told\|observed\|inferred) rides `source` as a `<prov>:<ref>`
  prefix — no schema column added to the shared store. Targets resolve to a
  `People/`/`Places/` note_path (alias-aware via `find_place_by_name`) or stay a
  free token; idempotent re-projection via `replace_from`; fail-open.
- **Told-first + provenance.** `record_relationship` (Kate, told-first) writes the
  `relations` entry AND warms the edge; `who_is` reads every tie touching an entity
  (both directions, cordon-safe — the owner has no god-view of a siloed person).
  The Friends card's read-only **Connections** section is the "what Kate believes"
  surface (direction + provenance chip). Edges carry the node's `private_to` and
  read through `knowledge_edges`' per-caller filter.
- **Why it's the keystone.** Both halves of the vision depend on it: understand-
  not-face-value now, and the Phase-1 prediction chain (a "haircut" event resolves
  *through* the graph to Sam + Rosa + the salon, whose coords feed
  `distance_matrix` for the leave-by math). Proof: `bun run smoke:people-graph`.

### People/ holds three classes of person, and only one is a relationship (2026-07-29)

`People/` is not "the contacts." It is every person-shaped record the household
keeps, and it has always held more than contacts: 144 of its 162 notes are GEDCOM
genealogy ancestors. What makes the contact graph a contact graph is not the
folder — it's the **exclusion predicate** every relationship surface applies.

Three classes, each with its own reason not to be a relationship:

- **contacts** — family / friend / colleague / acquaintance / service. The real
  graph. Birthdays to remember, gifts to buy, cadences to fall behind on.
- **`self`** — the owner's biographical baseline. You're not your own friend, but
  the per-user model reads it, so `person_enrichment` deliberately keeps it.
- **genealogy** (`gedcom_xref` / `-ancestor.md`) and **`public_figure`** — a
  person the household knows *about*, not someone it relates *to*.

`public_figure` was added when Ruby's civic research filed Pleasantville
councilmember Chris Barrett into the graph as `acquaintance` with `tone: warm` and
an empty `gift_history`, and Jasper's brief started naming a stranger as a
contact ("Neither are my contacts or friends"). Two 2026 CD-3 primary candidates
had landed the same way, each with a note whose only content was "Deep research
found no grounded public details."

The design decisions worth keeping:

- **A relationship VALUE, not a separate table.** `civic_members` already held
  the correct Barrett row, and "civic figures live only there" was the tempting
  fix — but it is Ruby-shaped. The same bug is open for every other research
  front (an author Cordelia reads, an executive Vivian tracks), and a
  Fort-Collins-council table has no room for them. A class of person generalizes;
  a per-domain table is the carve-out. The two are complementary, and Ruby's
  persona says so: the investigation is the narrative, the `upsert_civic_member`
  row is the queryable spine behind `member_dossier` / `voting_record`.
- **The classification is the MODEL's, at research time.** `deep_research` gained
  `subject_kind: 'public_figure'` next to `'person'`, described by the distinction
  that actually matters ("someone in his LIFE" vs "someone he is FOLLOWING"), and
  the writeback stamps the relationship from it. No name list, no
  `if (agent === 'ruby')`, no post-hoc classifier — LAW #1. The kind also aims the
  research: a public figure's facet pack leads with office, votes, funding and
  accountability rather than a résumé, which is why four Barrett passes kept
  returning the same four biographical facts and nothing about the Flock Safety
  vote Ruby was tracking.
- **Exclusion is not erasure.** The note stays, so `who_is` still answers "who is
  Chris Barrett", the relations graph can still tie him to YIMBY Pleasantville, and
  the six `research_investigations.person_id` backrefs don't orphan. What changes
  is that `is_non_contact` now excludes the class from the brief's occasions, the
  gift loop, cadence nudges, the Friends tab, meeting prep, dossier synthesis and
  chat-fact enrichment.
- **The predicate had drifted into five copies, and three had the bug.**
  `is_non_contact` documented itself as "the one place both surfaces agree," but
  `birthdays_within` (the GIFT loop) and `people_occasions` (cross-signal) applied
  NO exclusion at all, and `scan_meeting_prep` had re-derived
  `relationship !== 'self' && !is_genealogy(...)` inline. Adding a class to the
  shared predicate would silently have missed all three. They route through it
  now; the two sites that legitimately keep `self` (`person_enrichment`, the
  Friends tab's "You" rung) compose `is_genealogy` + `is_public_figure` instead of
  re-deriving. Same shape as the `home_anchor.ts` consolidation: four copies of
  "is the user home", three broken identically.

Proof: `bun run smoke:public-figures`. Migration for the notes this already
created: `bun run migrate:public-figures` (dry-run default, allowlisted by id).

### The People observational engine + trust surface (A+D, 2026-06-22)

The People layer maintains itself. The pivot came from a live test of the
relationship graph: Kate *narrated* "I've recorded that" while calling no tool —
proof that the chat-told write path is the smallest and most fragile input. So the
anchor's value is the system **observing** people from the exhaust it already emits
(resilient through redundancy — a fact learnable from many signals survives any one
broken path), and **showing its work** so the owner can trust + correct it.

- **A — afferent observers → a provenance log.** `PersonObserverDriver`
  ([person_observers.ts](src/core/person_observers.ts)) is the sibling of
  `user_model_observers`: one `attach(events)`, cheap (no LLM at intake), DARK
  (`HEARTH_PERSON_OBSERVERS`), fail-open, cordoned. v1 mines `message_added` (a
  conservative name-match of the conversation owner's visible people → a `mention`)
  and `capture_routed` (→ a `capture`) into `person_observations`
  ([stores/person_observations.ts](src/memory/stores/person_observations.ts)) — the
  append-only log AND the provenance source of truth (what / source / confidence /
  when / cordon), idempotent per `(person, source, ref, kind)`.
- **D — the trust surface.** The Friends card's "What Hearth's noticed" section
  renders each observation with its source + date + a one-tap dismiss
  ([friends.ts](src/app/routes/friends.ts)). Auto-population is only SAFE because of
  D — every signal is provenance-tagged + dismissable; nothing silently overwrites a
  told fact. So A and D are one build, not two.
- **Signal-agnostic seam.** A new signal = a new case in the driver (resolve the
  user, name-match their visible people, `observations.record(...)`). The real
  friend channels land here: **iMessage via the macOS app reading `chat.db`** (iOS
  can't — Messages is sandboxed; the Message Filter extension sees only
  unknown-sender SMS), Discord (bot/API, harder), presence/face "visited", calendar.
- **Roadmap:** A v2 distills observations → durable person-note facts (nightly,
  `inferred` provenance, extends `sweep_person_facts`) + auto stay-in-touch; C =
  life-event detection (edge vs current facts); B = right-moment proactivity +
  conversation prep. Proof: `bun run smoke:people-observers`.

### The iMessage observer — the engine's richest source, distillate-only (2026-06-22)

The first rich friend channel filling that seam, and the most sensitive source in
the system. Unlike the cheap event-time observers above, iMessage is a **two-clock
pipeline** split across repos so the privacy boundary is structural, not a policy:

- **macOS reads, Hearth distills.** The native macOS app
  ([upload contract in design-imessage-observer.md](docs/design-imessage-observer.md))
  reads `~/Library/Messages/chat.db` and chunk-uploads raw 1:1 windows (`{text,
  ts, from_me}`) for **opted-in** contacts to `POST /api/imessage/ingest`
  ([routes/imessage.ts](src/app/routes/imessage.ts), a NEW `/api` namespace — needs
  the nginx alternation edit). It runs no LLM. Upload is cheap + frequent; the
  expensive distill is nightly on the LOCAL tiers.
- **Distillate-only retention.** Uploaded raw lands in a **transient** staging
  buffer ([stores/imessage_staging.ts](src/memory/stores/imessage_staging.ts))
  that NO user-facing surface reads. The nightly job
  ([distill_imessage_observations.ts](src/specialists/kate/tools/distill_imessage_observations.ts)
  → [core/imessage_distill.ts](src/core/imessage_distill.ts)) filters chatter
  (structural + LLM judge, fail-open), then extracts durable FACTS (→ the People
  note, via the shared `extract_person_facts`/`merge_facts`) + relationship
  OBSERVATIONS (open loops / life events / topics → `person_observations`,
  `source_type: 'imessage'`), and then **drops the raw**. The Mac's chat.db is the
  source of truth; re-distill = re-upload. Hearth is never a message archive.
- **Hearth owns + ENFORCES the per-contact opt-in** (`ImessageOptIn`, default
  OFF): ingest drops any not-opted/invisible `person_id` even if a client
  misbehaves. The toggle lives on the Friends card (no nginx edit); the Mac reads
  the allowlist from `GET /api/imessage/opt_in`.
- **Two-tier cordon (deliberate):** facts are **communal** (a fact about a shared
  contact, source unrecorded); observations are stamped to the **uploader**
  (owner-only — private correspondence's distillate is theirs). Cadence-gated
  (`HEARTH_IMESSAGE_DISTILL_MIN_INTERVAL_H`) so the distill clock is tunable; DARK
  behind `HEARTH_IMESSAGE_OBSERVER`. Proof: `bun run smoke:imessage-observer`.

### The People-engine synthesis pass — stream → durable dossier (2026-06-24)

The observers SENSE (they distill conversations into `person_observations`), but
nothing flowed FROM that stream INTO the durable dossier and the stream never
decayed — so it piled up as noise while the People note stayed thin. "What Hearth
noticed" was decaying working memory read as if it were the dossier. The nightly
synthesis pass ([core/people_synthesis.ts](src/core/people_synthesis.ts), Kate's
04:00 `synthesize_dossiers` job AFTER the 03:45 distill) closes that, per
`(person, owner)` with new observation activity:

- **The gate is the model's judgment, the rest is deterministic bookkeeping.** One
  grounded deep-tier call (`research_extract`, think:false, fail-open) reads the
  current dossier + the person's observations — enumerated `[1]…[n]` (the
  `citations.ts` `[S#]` idiom, so the 35B references rows by NUMBER, never a
  garbled id) + a deterministic recurrence hint (token-clustered summaries) — and
  returns `{summary, themes[], facts{}, followups[], decay[]}`. The system prompt
  carries the **durability gate** ("would this still matter in 6-12 months / does
  it shape the relationship?"); recurrence is the strongest promote signal. This is
  the dynamic-not-hardcoded law: the model decides what's durable, the code only
  applies it.
- **Promote, two destinations by cordon.** Durable FACTS merge into the People note
  via the shared `merge_facts` (communal, union-dedup, idempotent — exactly as if
  typed in). The relationship NARRATIVE (portrait + themes) goes to a NEW **cordoned**
  store ([stores/person_synthesis.ts](src/memory/stores/person_synthesis.ts), one
  row per person+user, `private_to` = the uploader) — NOT the household-shared note,
  because it distills owner-private observations; writing it to the note would leak
  it. Same two-tier cordon the distill enforces.
- **Decay, two layers.** The model dismisses observations it judges resolved/trivial;
  a deterministic per-kind TTL backstop (`PersonObservations.decay_stale` — mention
  7d, topic 30d, open_loop 60d, life_event 120d, each tunable) ages out the rest, so
  the "noticed" surface stays a recent glance. Genuinely actionable open loops become
  Kate followup `action_proposal`s (edge-deduped on the observation's `source_ref`,
  cordoned, capped — the calendar-followup idiom).
- **Dirty-gated + cadence-gated + DARK.** A person is re-synthesized only when a new
  observation post-dates the stored cursor (an unchanged contact costs no LLM call);
  cadence knob `HEARTH_PEOPLE_SYNTHESIS_MIN_INTERVAL_H` (default 20h, 168 = weekly);
  kill switch `HEARTH_PEOPLE_SYNTHESIS`, followups separately disableable. The
  Friends card renders the narrative as "Hearth's read" above the raw stream
  (cordon-filtered). Proof: the `H.` block of `bun run smoke:imessage-observer`.

### Dossier DEPTH — refine-not-rebuild, the corpus, and `communication` (2026-07-26)

The synthesis pass above worked and still produced shallow dossiers: a live
`person_synthesis` row read `source_observation_count: 4` after weeks of real
correspondence, and its "themes" were restatements of that week's open loops.
Three structural causes, all fixed here (proof: the `H2.` block of
`bun run smoke:imessage-observer`, plus `smoke:people-observers`):

- **It rebuilt instead of refining.** The pass got the People-note facts and the
  active observations but never its own prior narrative, then overwrote the row —
  so a portrait could never outgrow one night's window. It now reads the prior row
  back (`PersonSynthesisStore.get_for_refine`, engine-only + uncordoned since the
  sweep already partitions by owner) and the prompt leads with it: *carry forward
  what still holds even if this window didn't re-mention it, revise what changed,
  retire only what's contradicted*. The model returns the FULL refreshed dossier;
  `merge_refinement` then guarantees refinement can only ADD depth — an empty field
  from a flaky deep-tier turn falls back to the prior, never blanking an earned
  portrait. `revision` counts the passes and is the depth signal on the card. This
  is the discipline `docs/design-per-user-model.md` names and the one
  `distill_jasper_style` has always followed via `read_prior_profile`.
- **Decay outran accumulation.** Retirement is aggressive (a live table: 137
  dismissed / 16 active) and the pass saw only active rows, so evidence was
  destroyed before it could compound. It now also reads a bounded tail of decayed
  observations (`PersonObservations.history_for_person`, `HEARTH_PEOPLE_SYNTHESIS_HISTORY`,
  default 60) as **unnumbered** background — deliberately not `[n]`-labelled, since
  the decay/followup contracts index the active list and a numbered history row
  could be re-promoted or re-decayed. User surfaces are untouched: "noticed" still
  reads `dismissed = 0`. `prune_dismissed` (`HEARTH_PEOPLE_OBS_RETENTION_DAYS`,
  default 365) is the retention floor — keeping evidence must not become keeping an
  archive. Active rows are never pruned however old.
- **Nothing learned how they TALK.** `communication` is the relational sibling of
  the user's own style profile — register, what they open with, what they ask you
  about, cadence, humor, what lands. Its afferent half is a new `style_notes` key on
  the distill's existing extraction call (same call, no new cost), recorded as
  `kind: 'style'` observations at confidence 0.4 (one window is weak evidence of a
  voice; it earns weight by recurring). Extracted THERE because the distill is the
  only point where the raw transcript exists — it's dropped moments later, so no
  downstream pass could recover it. Decay TTL 180d. Surfaces on the friends API
  (`SynthesisView.communication` + `revision`) and as **How they talk** in
  `assemble_meeting_prep` — which never surfaces a prep on the strength of a
  communication portrait alone.

Also: the `mention` observer no longer writes the contentless literal `"mentioned
in conversation"` (62 of 153 live observations — noise that competed for prompt
slots and polluted the recurrence clustering). It keeps the capped sentence the
name appeared in, records **nothing** when that sentence isn't substantive, and is
cordoned to the SPEAKER rather than the mentioned person's household cordon,
because the summary now quotes the user's own words.

### Life-event proactive offers — People-engine Phase C (2026-06-25)

The first *act* phase on top of the now-deepening dossier: turn a NEW, actionable
`life_event` observation into a proactive Kate offer.
[scan_life_events.ts](src/specialists/kate/tools/scan_life_events.ts) (Kate's 03:50
`life_event_offers` job — between the 03:45 distill and the 04:00 synthesis, which
promotes an actionable life event to a durable theme and then DECAYS the raw
observation, so running AFTER it would miss exactly the actionable ones) is the
relationship-signal sibling of `scan_calendar_followups` —
SAME proactive-offer idiom (detect an edge → file a cordoned `action_proposal` once
→ the owner's tap is the floor, Trust-Ladder XP on decide), DIFFERENT source: the
`person_observations` stream (kind `life_event`), not the PROJECTED calendar
life_event NOTES (vacations/appointments) that `scan_calendar_followups` reads — so
the two never double-offer. Two gates: a deterministic RECENCY window (an old
milestone never back-fills a stale offer) + the model's ACTIONABILITY judgment (one
planner call per scan classifies each event — travel / new job / engagement / move /
loss / health vs a passing mention / transient illness / old condition — and writes
the offer; the dynamic-not-hardcoded law). **Fail-CLOSED** on the gate (the opposite
of the substance filter): a proactive surface is user-facing, so an LLM outage files
NOTHING rather than offering on noise. Edge-dedup on the observation's stable
`source_ref`; `monitor_life_events` capability (Kate-only); DARK behind
`HEARTH_LIFE_EVENT_OFFERS`. Proof: the `I.` block of `bun run smoke:imessage-observer`.

### "Before you see them" meeting prep — People-engine Phase B (2026-06-25)

The payoff: surface the now-rich dossier at the right moment.
[scan_meeting_prep.ts](src/specialists/kate/tools/scan_meeting_prep.ts) (Kate's
08:30 `meeting_prep` job) scans the next couple of days of calendar meetings for
ones that NAME a person in the contact graph (first-name-when-unique matching over
title + participants — a real calendar says "Beer with Heather", not the full name —
with genealogy ancestors + self excluded and birthday/anniversary events skipped
since the gift scans own those) and, on the edge (once per person+meeting), files a
**briefing** with the heads-up — what's OPEN with them (open-loop observations),
what's worth BRINGING UP (the synthesis narrative + recent life events), whether
you're OVERDUE (cadence vs last_contacted). The assembly
([people_prep.ts](src/core/people_prep.ts) `assemble_meeting_prep`) is **pure** —
no LLM, nothing to fabricate, because the intelligence already happened upstream
(the distill decided what's an open loop; the synthesis model decided what's a
durable theme) and this just PRESENTS it, cordon-correct (reads owner-private
observations/synthesis through the viewer's `note_visible_to_caller`). High-recall
first-name matching finds candidates; a cheap LLM gate then decides which are real
meetings WITH the person (so "Sam Payday" — a name match, not a meeting — is gated
out; the `scan_life_events` gate shape, fail-CLOSED, LAW #1 — the meeting judgment is
the model's, not a hard-coded word list). It's the
relationship counterpart of `scan_calendar_followups` (which fires on the
calendar's OWN concerns — birthdays/vacations/appointments); this fires when an
event names someone you KNOW. A `briefing` is the right kind — an FYI heads-up that
SELF-EXPIRES (a prep for a past meeting shouldn't linger) and dedups on
`topic`+`for_event`; the ACTIONABLE items keep their own action_proposals (Phase A
open-loop followups / Phase C life-event offers), so this is the read-in, not a
second action surface. `has_content:false` → no card. `monitor_meeting_prep`
capability (Kate-only); DARK behind `HEARTH_MEETING_PREP`. Proof: the `J.` block of
`bun run smoke:imessage-observer`.

### The Calendar Knowledge Graph + cross-domain triggers + the gift loop (Phase 3, 2026-06-20)

Phase 3 replicates the goods pattern in the calendar domain and closes the
birthday→gift loop. The second graph node type is now load-bearing:

- **`life_event` PROMOTED to a PROJECTED node.** What Phase 2 wrote as an
  AUXILIARY note is now a full projected type ([schema](src/memory/schemas/life_event.ts)
  + a `life_events` SQLite table + an ingestor projector, mirroring
  `household_good`), so an attributed calendar event is BOTH RAG-searchable AND
  **date-scannable**. MemoryClient gains cordon-filtered reads (`query_life_events`,
  `events_within`), an uncordoned system scan for the followup job
  (`life_events_needing_followup`, one entry per actionable event in window), and
  `birthdays_within(within_days, now)` — a deterministic, ctx.now-based birthday
  query (the legacy `upcoming_dates` reads the host clock, which a date-scan and a
  smoke can't ground on).
- **Calendar inference.** `enrich_life_event`
  ([src/core/calendar/enrich_life_event.ts](src/core/calendar/enrich_life_event.ts),
  pure + fail-open, injected lookups) types each event's IMPLICATIONS (vacation →
  ask flights + welcome-back; appointment → prep; birthday → gift), classifies it
  **actionable vs informational**, names participants, and emits typed
  `knowledge_edges` (participant `attending`, place `located-at` — a new edge
  kind). The `CalendarSource` calls it on every new event, so the note lands
  enriched + the graph gains the edges.
- **Cross-domain proactive triggers.** `scan_calendar_followups`
  ([src/specialists/kate/tools/scan_calendar_followups.ts](src/specialists/kate/tools/scan_calendar_followups.ts))
  is the calendar twin of `scan_good_followups` — the same "probe path" idiom: a
  deterministic date-scanning background job (Kate's 08:20 `calendar_followups`,
  gate `monitor_calendar_followups`) that edge-dedupes via
  `exists_for_signature` and files a cordon-scoped `action_proposal` per edge,
  gated by the owner's tap and earning Trust-Ladder XP on decide. A background job
  (not a `wake_deliberation_scoped` pass) precisely because edge dedup must
  survive a multi-day window AND a restart — and a deliberation's proposal
  signature is LLM-authored, unreliable for `exists_for_signature`. Three edges:
  **birthday−14d → gift** (the flagship — ideas drawn from the person's tracked
  likes within a LEARNED budget, brainstormed by a fail-open planner call),
  **vacation → flights + welcome-back**, **appointment → prep**. DARK behind
  `HEARTH_CALENDAR_TRIGGERS` (off by default).
- **People accretion + the LEARNED gift budget.** The Person schema gains
  `likes`/`dislikes`/`sizes` + structured `gift_history.cost`/`occasion`;
  `record_person_pref` (a chat LEARN tool, with the "CALL it, don't acknowledge"
  persona nudge) accretes them. `compute_learned_gift_budget`
  ([src/core/gift_budget.ts](src/core/gift_budget.ts)) derives the per-person
  budget from that person's OWN recorded spend — **never a hard-coded constant**
  (no spend → "ask"). A `gift_budget` user_model facet
  ([user_model.ts](src/core/user_model.ts)) carries the cross-gift narrative; it
  self-gates on observations, so adding it is a no-op on the live sweep until
  gifts are recorded. People stay household-stamped shared entities.
- **Cordon holds end-to-end.** `query_life_events` filters via
  `note_visible_to_caller`; a member's personal event/appointment is invisible to
  the owner; a birthday gift (People are shared) files owner-global; a member's
  appointment followup cordons to them. The set_event_owner golden eval
  ([golden_tasks.ts](src/core/evals/golden_tasks.ts)) locks the Phase 2
  fabricated-save fix into the nightly gate.

**Proactivity polish (2026-06-21) — three DARK upgrades on the same spine.**

- **Cross-signal "I noticed" fusion nudges** — `scan_cross_signals`
  ([src/specialists/kate/tools/scan_cross_signals.ts](src/specialists/kate/tools/scan_cross_signals.ts),
  pure math in [cross_signals.ts](src/core/calendar/cross_signals.ts)) is the
  same probe-path idiom as `scan_calendar_followups`, but it fires on a
  COINCIDENCE across two upcoming signals a single-domain scan can't see: a
  **visitor + their occasion** (an upcoming visit/trip whose participant has a
  birthday/anniversary inside the visit window → offer a gift from tracked likes
  within a learned budget + a plan) and a **double-booking** (two SHORT timed
  same-owner events overlapping; multi-day spans are excluded — a span isn't a
  slot clash). Two uncordoned SYSTEM-scan reads back it
  (`upcoming_life_events_uncordoned`, `people_occasions`), each proposal cordons
  to the SIGNAL's owner, dedup is `exists_for_signature` on a content-stable
  anchor (person+occasion+visit / the sorted event pair). Kate's 08:25 job, cap
  `monitor_cross_signals`, DARK behind `HEARTH_CROSS_SIGNAL`.
- **Intent forcing v2** — the record-intent constrained-decoding machinery
  ([record_intent.ts](src/core/record_intent.ts)) now also forces
  `schedule_calendar_event` (a scheduling instruction WITH a time anchor) and
  `promise_followup` (a reminder/follow-up directive). `detect_actionable_intent`
  is the pure superset (record/attribute wins on a tie); the runtime's
  `tool_choice:'required'` path was already tool-agnostic, so gating is per-GROUP
  via `intent_force_enabled_for(tool)` — the record pair on
  `HEARTH_RECORD_INTENT_FORCE` (live), the schedule+remind pair on the NEW
  `HEARTH_INTENT_FORCE` (DARK).
- **Intent forcing v3 (2026-06-26) — VOICE + the emergency self-test.** A 5th
  class `test_emergency_alert` (`detect_emergency_test_intent` — an imperative
  emergency-test/drill command, most-specific so it wins the union), AND the
  round-0 force now runs on the VOICE surface (the gate was chat-only). This is the
  fix for a fabricated *safety* confirmation: a voice reply streams to TTS as it
  generates and gets 0 re-rolls, so a post-hoc fabricated-action guard can't catch
  it — the model already SPOKE the lie ("Test fired" with zero tool calls). Round-0
  forcing is the only place to PREVENT it; the live voice tier's grammar-constrained
  decode (35B on llama.cpp `--jinja`) makes `required` structurally enforced, so the
  single shot suffices. The emergency class is the anti-fabrication GUARD family —
  its gate `HEARTH_EMERGENCY_INTENT_FORCE` is **default-ON** (`=0` disables), unlike
  the opt-in record/schedule groups.
- **Read-the-room delivery window** — [delivery_window.ts](src/core/delivery_window.ts)
  adds a deterministic gate to [push.ts](src/policy/push.ts): a NON-URGENT
  proactive push defers (queued to `pending_pushes` with a `not_before`, re-aired
  by the 60s sweep — never dropped) during quiet hours (reused), an active
  meeting, presence-away (a location welcome-home nudge is exempt), or too soon
  after the last push. URGENT always delivers; the gate is fail-open and DARK
  behind `HEARTH_DELIVERY_WINDOW` (off → the legacy quiet-hours-only path,
  byte-identical).

**Proposal supersession + readability (2026-05-26).** The proposals
table gained five columns: `title`, `summary`, `dedup_key`,
`superseded_by`, `superseded_at`. `compute_dedup_key(kind, payload)`
in [src/core/proposal_render.ts](src/core/proposal_render.ts)
returns a subject identifier for kinds whose subject is cleanly
derivable from payload (persona_tuning by target_specialist_id,
recommendation by tool_name, binding_proposal by slug, calendar_event
by title+start). When a new proposal lands with a non-null dedup_key
that matches an existing open (pending/snoozed) row, the older flips
to status='superseded' and points at the new id; queue listings hide
it by default so the user can't approve a stale version. Kinds
without safe subject identity (action_proposal, draft_message,
briefing) return null and stay independent — meaningfully different
proposals never collapse. Title + summary are computed at create
time and surfaced in the iOS proposals list (was just "kind +
rationale tail"; now "Tune Kate's persona — silent-on-posture" with
a 1-line subtitle).

**Attribution is canonicalized at the create() chokepoint
(2026-06-10).** `ProposalsStore.create()` runs the filer AND the
signature owner through an injected `SpecialistIdResolver`
(orchestrator boot wires it to `SpecialistRegistry.resolve_id` —
id / display name / alias → canonical id, case-insensitive, no
fuzz), throwing typed `UnknownSpecialistError` on an unresolvable
filer. Upstream, `propose_action` attributes to `ctx.specialist_id`
over the LLM-authored signature value (the same ambient-context rule
as `user_id`; deliberation already forced `specialist.id`). This
closed the live 2026-06-10 incident where trainer's turns filed
rows under 'beatrice' / 'maggia' / 'all' — ids no per-specialist
filter or autonomy signature could ever match.

**The filing-quality critic (2026-06-22).** `create()`'s three dedup
layers are all EQUALITY-based (byte/rationale idempotency, dedup_key
supersession, validated pm_*-ref supersession), so they can't catch the
queue's real noise: the SAME root cause re-filed under a drifting
fingerprint (a stale-presence cluster filed 8 cards; an absorb_interrupt
cluster, 3 — different slugs, no shared misses), and a fix that doesn't
address its own diagnosis (grant a read capability to "fix" an entity-ID
mismatch). That class is semantic, so it gets a semantic critic
([proposal_critic.ts](src/core/proposal_critic.ts)) mirroring fact_critic /
data_denial: Layer 1 is deterministic token-overlap candidate grouping
(narrows which open proposals a new one might duplicate — it never decides),
Layer 2 a fail-open planner judge that rules `duplicate` (→ supersede the
NEWER row via `supersede_duplicate`; the canonical earlier one survives) or
`fix_mismatch` (→ audit a warning only, never auto-deny). It runs OUT OF BAND
in the orchestrator sweep — never in `create()`'s sync hot path — and is DARK
by default (`HEARTH_PROPOSAL_CRITIC=1`), since it auto-supersedes. This gates
proposals at the GENERATION layer; the tsc check / Kate review / owner merge
keep the LANDING layer safe, but nothing screened filing before this.

### The tiers in plain English

- **Tier 1 — Read.** Anything that only looks at vault data or
  external read-only feeds. Auto-approved. Examples: `who_is`,
  `upcoming_dates`, `surface_relationship_signal`.
- **Tier 2a — Write internal.** Vault writes — journal entries,
  person notes, decisions, links. Auto-approved. Reversible; the
  audit log lets the user see exactly what changed. Examples: the
  five Scribe tools.
- **Tier 2b — Send external, low-stakes.** External communication to
  established contacts — a text to family, an email to a frequent
  colleague. Defaults to approve; graduates to auto after N approvals
  without edits, per recipient.
- **Tier 2c — Send external, high-stakes.** First-contact emails,
  sensitive recipients, anything novel. Approval-only; never
  graduates automatically. The user can grant per-conversation
  exceptions.
- **Tier 3 — Spend money or commit time.** Booking a flight,
  scheduling a calendar event for someone else, making a purchase.
  Always approval-required, with a cooldown (the gateway waits N
  seconds before executing after the user approves, in case they
  change their mind).

### Hard exclusions

A small set of actions are **never** auto-approvable regardless of
graduation:

- Any spend over a configurable dollar cap.
- Any send to a recipient flagged `sensitive` or `do_not_contact` in
  their person note.
- Anything in the legal, medical, or first-contact categories.

These show up in [config/policies/v0.yaml](config/policies/v0.yaml)
as rules that deny or require approval even when other rules would
auto-approve.

### The graduation calibration loop

When the user approves an action without edits, that's a vote of
confidence in the system's judgment for that *kind* of action. The
gateway tallies approvals-without-edits per (specialist, tool,
recipient) tuple. When the count exceeds a threshold (default 5
without edits, no denies), the tier graduates from approve to auto
for that specific tuple. Edits and denials cost — they zero or
decrement the count.

This produces a system that becomes more autonomous over time, but
**narrowly**. It doesn't generalize: just because the user
auto-approves texts to their mother doesn't mean texts to their boss
auto-approve. Trust is per-recipient, per-domain.

Not implemented in the current policy engine. Will be implemented
when sending tools land; the data structure is in the audit log
already.

### Authenticity gate (2026-05-25)

Pure approval count isn't sufficient — a specialist who fabricates
shouldn't earn more autonomy regardless of how many approvals their
signatures accumulated. `config/autonomy.yaml`'s
`min_authenticity_score_for_tier2b/2c/3` (defaults 70/85/90) gates
graduation on the owning specialist's score from
`scan_specialist_authenticity`. Below threshold, candidates are held
(approvals still accumulate, recommendation isn't surfaced); above,
they pass. New hires with no scan history pass through so a brand-new
specialist isn't permanently blocked before Mariah's first scan runs.

The path back up for a held specialist is the same closed loop —
Beatrice ships persona/tool/connector fixes from the same scan's
findings, the next scan sees fewer fabrication-shaped misses, the
score recovers, held graduations re-appear as candidates. See
[Closed-loop roster maintenance](#closed-loop-roster-maintenance)
for the full machinery.

## Capability gating

Every Tool declares `risk: 'read' | 'write_internal' | 'send_external'
| 'spend_money'`. As of Prompt 6a, every Tool also declares
`required_capabilities: Capability[]` — named tokens like `read_vault`,
`write_vault_finance`, `send_email` — and every specialist declares
the granted set in their YAML config under `capabilities:`. The
ToolRegistry checks the granted set at dispatch time; missing
capability produces a structured error the LLM can route around
(delegate to a peer or explain to the user). The risk tier still
drives the policy gateway (for auto/approve/deny decisions on
external effects); capabilities are the per-specialist permission
layer in front of it.

This is a **security boundary**, not a styleguide. Adding a
capability to a specialist is a deliberate act. The user should be
able to look at a specialist's config and answer "what can this
specialist do to my life?" by reading the capabilities list. Tools
without an honest risk tier (e.g. a "read" tool that secretly sends
emails) are bugs.

### Ownership beats per-entity allowlists

A capability is sometimes the wrong shape — sometimes the right
answer is "this whole domain belongs to one specialist; others
consult them." Calendar is the canonical case. Until 2026-05-25
nine specialists carried `read_calendar`; on `c9f0cee` it became
Kate's (Chief of Staff) plus Iris (because `plan_ev_day` composes
calendar+routing+SoC synchronously and refactoring that to consult
mid-tool is a deeper change). Other specialists who need calendar
context route through `consult_specialist(kate, ...)`. The
discretion semantics of which calendar gets which event
(`calendar_hint`: `household` shared with Sam vs `personal`
Jasper-private for surprises) lives in
[schedule_calendar_event](src/specialists/kate/tools/schedule_calendar_event.ts)'s
tool description so Kate's LLM reads it every relevant turn.

As of 2026-06-07 that tool no longer dispatches through Home Assistant.
It emits a `kind: 'calendar_event'` proposal (execution_kind `none` —
no server-side write); the runtime fires a `calendar_event_proposed`
SSE event, and the iOS `CalendarWritebackCoordinator` writes the event
through EventKit on the user's approval, reporting the `EKEvent` id back
via the decide call's `modifications`. iOS's native sync propagates to
iCloud / Google / Exchange with **no server-side calendar credentials**.
A `replaces_event_id` on the payload makes it a **move**: iOS relocates
the existing event in place (`event(withIdentifier:)` → update),
something HA's create-only REST surface (`create_event` + `get_events`
only) can't do. The user's wall-clock is converted to an absolute UTC
instant in *their* timezone via `time.ts` `zoned_wall_to_utc_iso` (the
write-side inverse of `to_local_instant`), at second precision because
iOS's `ISO8601DateFormatter` rejects fractional seconds. The HA-CalDAV
calendar connector (read `ha_calendar_query` + write
`ha_calendar_create_event`) and `caldav_upcoming` were RETIRED 2026-06-14
once Iris's `plan_ev_day` moved to the iOS calendar snapshot — it reads the
`calendar_snapshots` store directly (same store as the sensor_calendar_*
tools), so no server-side Apple/CalDAV credentials remain. See
`BACKEND_HA_CALDAV_DEPRECATION_BRIEF`.

The pattern: when "who owns this?" is a clearer answer than "who has
permission to do this?", encode ownership in the capability grant
and let the consult system handle the federation.

### Why we declare risk on the Tool, not the route

The HTTP route is incidental — a tool could be exposed via multiple
routes, or via the LLM-mediated agent dispatch path, or via the
scheduler. The risk tier is intrinsic to the tool's effect. Putting
it on the Tool means the gateway evaluates the same answer regardless
of how the tool was invoked.

## Per-turn tool curation

Capability gating decides what a specialist *may* invoke. It does not
decide what the model *sees* on a given turn — and those are not the
same number. A specialist with a broad capability grant can resolve to
two-dozen-plus tools, and handing all of them to the model every turn
is its own failure mode.

The constraint is the model. Bench runs (2026-05-19) on
Qwen3.6-35B-A3B-MTP showed it fills tool-call arguments reliably with
1–3 tools in scope and **degrades sharply once ~15 tool schemas
compete for the decision surface** — it starts emitting tool calls
with empty `{}` arguments. Empty args fail Zod validation, the error
is fed back, the model retries, and the turn burns its tool-round
budget (`MAX_TOOL_ROUNDS`) in a retry storm. Each round also ships
every tool's JSON Schema with `strict: true`, so the backend compiles
a combined GBNF grammar over all of them — prefill and grammar cost
both scale with the tool count. A wide-enough turn blows past the chat
role's LLM timeout and the user sees the specialist "time out."

The fix is **per-turn curation**, separate from capability gating:

- `proactive.tools_for_chat` — the tools shown on a conversation turn
  (`llm_role: specialist`).
- `proactive.tools_for_deliberation` — the tools shown on a scheduled
  deliberation pass (`llm_role: specialist_deliberation`).
- `proactive.tools_for_voice` — the tools shown on a VOICE turn
  (`llm_role: voice_realtime` / `surface:'voice'`). Added 2026-06-07
  because tool JSON schemas are the dominant voice-turn prefill cost
  (Kate's 37-tool chat surface ≈ 9.8K+ tokens of tool defs — the bulk
  of an 18.7K-token voice prompt; curating to 9 read/escalate tools cut
  `tokens_in` 18,760→6,732). When set it REPLACES `tools_for_chat` for
  voice AND suppresses the `BASE_TOOLSET` knowledge-floor union
  (voice has no knowledge-first snippet — list reads explicitly);
  `consult_specialist` is still appended by the runtime. Unset → voice
  falls back to `tools_for_chat` (legacy; a specialist with no voice surface is unchanged).

The `BASE_TOOLSET` read/memory floor (search_library, read_note,
recall_brain, read_inbox, remember, read_memory, read_my_proposals,
present_questions, promise_followup, flag_cordelia) is unioned into
the curated list on chat AND deliberation turns (deliberation since
2026-07-17; voice-curated turns excluded). A curated list narrows the
DOMAIN surface; it can never remove the floor.

`_curate_tools_for_turn()` in
[specialist_runtime.ts](src/core/specialist_runtime.ts) intersects the
capability-granted set with the relevant list. An empty/omitted list
means "show everything the capabilities grant" — the legacy behavior,
fine for a narrow specialist. For any specialist whose grant resolves
past the ~15-tool wall, the list is **not optional**: without it every
turn is uncurated and the model degrades.

Two properties keep this honest:

- **Curation never grants.** A name in `tools_for_chat` the specialist
  lacks the capability for is silently dropped — the capability check
  remains the only thing that authorizes a tool. Curation is a
  UX-shaping filter *on top of* the security boundary, never a hole
  through it.
- **Curation is per workflow.** A specialist's chat tools and
  deliberation tools are usually different short lists — what they
  reach for answering Jasper is not what they reach for in a 7 AM
  reflective pass.

Iris is the live example: she carried the widest SME grant (vault,
web, maps, HA, calendar, location, FRIDAY, places, proposals — ~25
resolved tools) with no curation, so every turn put her squarely past
the wall. (The "Iris times out when I ask her things" report that
surfaced this turned out to have a *separate* root cause — canned
error replies poisoning her conversation history; see the private dev log
"Canned error replies must not re-enter conversation history". The
uncurated surface was a real latent fault, found and curbed alongside
it.) The standing rule: **a broad capability grant with a missing
`tools_for_chat` is a configuration bug**, not a style preference.

### Dynamic tool surface — awareness without the schema tax (2026-06-08)

Curation trades reach for cost: it makes a tool cheap by making it *invisible*
(off-list tools are reachable only by delegating to `consult_specialist`). The
**dynamic tool surface** (`proactive.dynamic_tools: true`, chat turns only)
decouples the two costs a tool carries. Every tool ships twice: cheap
`tool_summary` lines (`name: description` = **awareness**) and an expensive
inlined `zodToJsonSchema` in the `tools:` array (the model's invocation grammar
+ a compiled GBNF — **cost**). Both were fed the same curated list. Now
`_build_turn_surface()` ([specialist_runtime.ts](src/core/specialist_runtime.ts),
logic in [dynamic_tools.ts](src/core/dynamic_tools.ts)) produces two lists: a
`catalog` (the FULL capability-granted set → awareness, auto from the registry —
zero persona lines) and a small `hot` set (→ schemas). A non-LLM tool-RAG
pre-pass cosine-ranks the user message against cached per-tool
`"name: description"` vectors (reuses the A4000 bge embedder + `cosine`/`norm`)
and seeds `hot` with the top-K plus a floor (`search_library`,
`present_questions`, extendable per specialist via
`proactive.dynamic_tools_floor` — Kate pins `sensor_calendar_upcoming`, added
2026-07-15 after a terse "Call" turn ranked zero calendar tools hot and burned
the turn looping `search_library` into a blank_turn_fallback; ungranted names
are skipped, so the YAML can't escalate capability); a `load_tools` meta-tool
pulls any other catalog tool's
schema on demand mid-turn (handled inline like `consult_specialist`, recorded as
a result not an error, so it never trips the dedup/heavy-fetch/spiral guards).
The chat prompt renders a two-tier block: the hot set with full descriptions
(callable now) + the rest as **compact** (truncated) catalog lines (pick-by-name,
`load_tools` for detail). Live (Kate, 2026-06-08): `catalog_n=71, hot_n=8` per
turn, `tokens_in` **26,585 → ~16–18K (−32–39%)** with the hot set adapting
per query (calendar query → calendar tools hot; "draft a note" → `draft_message`
hot). **Fail-open** is the contract: opt-out, non-chat surface, embeddings down,
or any embed error ⇒ exactly the curated path, byte-identical. `tools_for_chat`
is retained as the ranking prior + fail-open surface. Opt-in per specialist;
generalizing is a flag flip. A `dynamic_tool_surface` audit row records
`catalog_n`/`hot_n`/hot names per dynamic turn.

## Per-specialist tool-round budget

Curation shapes *what tools the model sees on a turn*. The tool-round
budget shapes *how many loops of "LLM thinks → tools execute → results
re-feed"* a single turn can run. Both are loop-ceiling problems; they
fail differently and need separate dials.

`MAX_TOOL_ROUNDS = 10` was the global default through 2026-05-24,
calibrated to the old Qwen3.6-35B-A3B-MTP and to chat shapes where 8–10
rounds covered the workflow comfortably. Two things have changed since:

- **Research-heavy workflows hit the wall.** Maggie's concert-research
  flow (search → drill cross-source → escalate to `browse_url` when
  Cloudflare blocks → capture to memory + watchlist → reply) routinely
  spends 10–14 rounds even when nothing goes wrong. The first round is
  a taste-capture (`update_maggie_memory`), the second is an existence
  check (`artist_watchlist_list`), then 4–8 are research, then 1–2 are
  writes back to vault, then synthesis. The Cloudflare escalation
  ([browser specialist surface](#browser-specialist-surface-avalanche))
  costs an extra round per failed Firecrawl fetch — the persona rule is
  "one Firecrawl attempt, then `browse_url` immediately," which by
  design adds 1 round per gated URL.
- **The the LLM host 27B-Q4 + DFlash run is faster per-round than the old
  35B-MTP**, so 2–4 extra rounds is real but not catastrophic in
  wall-clock.

Per-specialist override: `max_tool_rounds: <int>` at the top of the
specialist's YAML (validated 1–20; default 10). Maggie sits at 14 as
of 2026-05-24; Cordelia bumps when her deep-catalog workflows show the
same pattern; everyone else stays at the default.

Two properties keep this honest:

- **Bumping is not a fix for spinning.** A specialist that hits the
  ceiling because the LLM is emitting empty-args, ghost promises, or
  retry storms won't be saved by more rounds — it'll just fail slower.
  Diagnose the underlying issue first; bump only when the workflow's
  *successful* path legitimately needs more rounds.
- **The unit is loops, not tool calls.** A single round can emit
  multiple tool calls in one LLM response (1–3 is normal). So `14
  rounds` is a soft cap on actions of 14–30+ — the loop terminates on
  iteration count, not on cumulative call count. This is intentional;
  a single round legitimately producing 3 parallel reads (e.g. "list
  artist watchlist + list venue watchlist + read inbox") shouldn't be
  penalized as if it were 3 sequential rounds of indecision.

The wall isn't TPS; it's accumulated context. Each round adds the
tool input + tool result to the next LLM call's prompt. Bigger
context = slower prefill = closer to the chat-role timeout floor. The
fix for big-context turns is **not** more rounds OR more idle budget
(both delay the failure); it's [tool-output compression](docs/design-tool-output-compression.md)
— smart truncation, mid-turn query-aware summarization, or
structured-by-default tool outputs. That design lands in a future pass.

## Model topology

Status: **collapsed to single-tier 2026-05-23, then re-split into a
DEEP + LIVE tier 2026-05-31** — but the split is now along *concurrency
and precision*, not capability. All Hearth openai-provider roles still
run against `Qwen3.6-27B` on the LLM host; `think: true/false` in
[config/llm-roles.yaml](config/llm-roles.yaml) (plumbed to
`chat_template_kwargs.enable_thinking` per request) differentiates depth
vs fast on the same model. `consult_deep_model` is a same-model
focused-question call — the value was always in the scoped-prompt
discipline, not the model swap.

### Inference topology — interactive 9B (3090) + deep 35B-A3B (forza) + vision/RAG

The CURRENT three-box layout (deep tier swapped to the Qwen3.6-35B-A3B 2026-06-07;
interactive/vision/RAG from re-tier #2, 2026-06-06). Supersedes every tier
description below (kept as audit trail). The binding problem: the `live` tier
(typed chat + voice) shared
the the LLM host 3090's SINGLE llama.cpp slot (`-np 1`; DFlash corrupts at `-np ≥ 2`)
with the nightly deliberation sweep + awareness + grooming, so voice turns queued
7–20 s behind background work (a free slot is ~2 s). The fix splits interactive
from deep onto separate boxes, each multi-slot:

- **3090 `:8088` — INTERACTIVE tier.** Qwen3.5-9B Q8 GGUF on beellama.cpp,
  `-np 4` (multi-slot, NO DFlash — for interactive, not-queuing beats single-
  stream spec speed), no mmproj. Default `OPENAI_BASE_URL`. Roles: `specialist`,
  `planner`, `live`, `voice_realtime` — all think-OFF, all `concurrent:true` +
  `max_concurrency:4` (one shared `:8088` mutex). 16 K ctx per slot. (There is no
  Qwen3.6-9B — the 3.6 gen ships only the dense 27B + the 35B-A3B MoE; 3.5-9B is
  the same-lineage dense sibling, native 262 K ctx.)
- **forza (DGX Spark, GB10) — DEEP/text + VISION (two vLLM containers).** The GB10
  is bandwidth-bound (~273 GB/s unified memory), so the deep tier must be a SPARSE
  A3B MoE (~3 B active/token amortizes the weight-read) — a dense 27B-FP8 managed
  only ~8 tok/s here and timed consults out.
  - **`:8090` text deep** — **Qwen3.6-35B-A3B (FP8)** (vLLM, 49 K, 4 slots,
    `--gpu-memory-utilization 0.50`, **`--tool-call-parser qwen3_xml`**). Sparse
    A3B (~3 B active → **~52 tok/s think-off**) AND a HYBRID-thinking checkpoint,
    same generation as the 9B/27B. Roles: `specialist_deliberation`, `deep_consult`
    (text), `research_extract`, `librarian` + drafting/reflection — **think-OFF by
    default** (100% clean envelope JSON @ 2.1 s; only `deep_consult` +
    `specialist_thinking` think-ON). Swapped 2026-06-07 from the
    Qwen3-Next-80B-A3B-**Thinking** (which couldn't think-off → rambled structured
    output, 20% envelope JSON @ 28–56 s, off-family); see
    [docs/design-inference-fleet-loadout.md](docs/design-inference-fleet-loadout.md)
    for the same-box bench. (FP8 = 35 GB, loads on the current vLLM; the lighter
    NVFP4 22 GB checkpoint is the future target — it currently throws
    `KeyError: w2_input_scale` in this vLLM build's `qwen3_5.py` loader.)
  - **`:8096` vision** — Qwen3.6-27B-FP8 (natively VL), a second low-footprint
    vLLM container for the image path. **Start it SEQUENTIALLY after the deep model
    is healthy** — simultaneous start dual-peak-allocs the unified memory and
    swap-thrashes the box (see the private dev log "Swapping a forza deep model").
- **A4000 `:8091` — RAG tier.** infinity (bge embeddings + rerank). Unchanged.

**Vision is its own tier on forza.** The text deep model (the A3B MoE) is text-only, so
the image path routes through a dedicated `vision` role at `:8096` — a second vLLM
container running Qwen3.6-27B-FP8 (natively VL, serves OpenAI `image_url` directly,
no mmproj). `analyze_image_direct` (Cordelia's classifier) always uses it;
`consult_deep_model` uses it only when an `image_path` is attached
(`src/connectors/vl.ts` + `src/tools/consult_deep_model.ts` → `for_role('vision')`).
The interactive 9B is text-only; any image in chat/voice escalates via
`consult_deep_model`. The mmproj-on-the-3090 path in "Vision rides the same
endpoint" below is retired.

**Keeping the 9B chat hallucination-free is structural, not model-dependent.**
The grounding stack — turn-start RAG, the `kate_pack` grounding pack (now
pre-injecting today's REAL calendar PLUS weather + EV/home status from a
background warmer, so the common voice asks need zero model judgment and zero tool
round), the round-0 forced-tool backstop on voice lookups, the provenance check,
and the fact_critic — does the work the model's size used to be relied on for. A
periodic warmer ([apps/orchestrator/server.ts](apps/orchestrator/server.ts)) keeps
weather/EV readings hot in a process cache so pre-injection is a fast local read,
never a per-turn network fetch. Weather terms left `_LOOKUP_INTENT_RE` once
pre-injected (a forced weather fetch would be a redundant round); battery/charge
stays as the EV backstop. Tier selection stays declarative; the N-slot `HostMutex`
mechanism is unchanged — see [config/llm-roles.yaml](config/llm-roles.yaml),
[src/core/router.ts](src/core/router.ts),
[src/core/llm_serializer.ts](src/core/llm_serializer.ts).

**The chat turn has ONE implementation now (2026-06-19).** The runtime carried
two near-twin turn methods — `turn()` (non-streaming) and `turn_streaming()` —
each re-implementing prompt build, the tool loop, the finalize-guard cascade,
and audits; the duplication is the structural reason a fix could land in one
path and miss the other (the calendar-proposal-reached-iOS-only-in-chat class).
`turn_streaming()` is now the single body; `turn()` is a thin shim passing
`stream:false`. The generation primitive is the only per-call branch
(`complete_stream` + token events vs a single `complete()`); everything else —
grounding, the tool loop, the guards, the audits — runs once. The eight
finalize guards (ghost-promise, fabricated-save/-action, read-failure,
data-denial, citation, provenance, fact-critic, + the synthesis nudge)
collapsed from a copy-pasted cascade into one `run_reply_guards()` pass with a
single re-roll path, so a new guard is one ordered entry rather than surgery in
two methods. That single re-roll path is also what made the **hold-back**
rewrite fix tractable: short/voice/lean turns withhold their reply from the
live stream and deliver it once via `message_added` after the guards pass (no
visible draft); research turns keep streaming and, on the rare re-roll, emit a
`message_superseded` event so the client swaps the draft cleanly instead of
wiping and re-typing. Net: ~1,480 lines removed from
[src/core/specialist_runtime.ts](src/core/specialist_runtime.ts).

### Historical: the two-tier inference architecture (2026-05-31)

Two beellama processes serve the **same 27B** at different precisions
on different GPUs:

- **DEEP** — `Qwen3.6-27B-Q4_K_M` on the RTX 3090 (`:8088`,
  `llamacpp-glacier.service`), single-tenant (`-np 1`). One heavy
  reasoning turn at a time. The default `specialist` /
  `specialist_deliberation` / `deep_consult` roles. **Unchanged.**
- **LIVE / CONCURRENT** — `Qwen3.6-27B-UD-IQ2_M` (2-bit) on the RTX
  A4000 (`:8089`, `llamacpp-live-glacier.service`), `--parallel N`
  continuous batching. Many concurrent live + background turns. The new
  `live` (think off) and `librarian` (think on) roles.

The decisive design choice is using the **same 27B at 2-bit** rather
than a separate small model: identical tokenizer, chat template,
`<think>` toggle and `<tool_code>` recovery, so *"same persona, the
situation picks the tier"* is literally true. The A/B
([ops/llm/ab-quant.sh](ops/llm/ab-quant.sh)) picked UD-IQ2_M over
IQ2_XXS because the more-aggressive quant *narrated* searching instead
of emitting a `web_search` tool call — disqualifying for the
verification (`librarian`) role, whose job is to fetch-and-cite, not
recall. This tier is the GPU substrate for Durable-Truth Phases 2–3
(Cordelia off-GPU + the live concurrent librarian lane). Full design:
[docs/design-two-tier-inference.md](docs/design-two-tier-inference.md).

Tier selection is **declarative, not load-based**: a turn lands on LIVE
because the *situation* says so (a per-call `llm_role`/tier hint, a
specialist's pinned `llm_role`, or a background worker), never because
the 3090 is busy — the primary interactive answer is never silently
downgraded to 2-bit. Concurrency at the model host is gated by the
per-endpoint `HostMutex`, now an N-slot semaphore: the 27B keeps 1 slot
(single-tenant), the A4000 endpoint gets N slots matching `--parallel`
so batched turns don't serialize. See the per-role `base_url` pattern
in [config/llm-roles.yaml](config/llm-roles.yaml) +
[src/core/router.ts](src/core/router.ts) and the N-slot mutex in
[src/core/llm_serializer.ts](src/core/llm_serializer.ts).

The N-slot FIFO semaphore behind `HostMutex` was extracted to
[src/core/semaphore.ts](src/core/semaphore.ts) (2026-06-28) as the shared
`Semaphore` primitive so the same backpressure mechanism also bounds the
**Firecrawl scrape** path: every `web_fetch_clean` funnels through one
module-level limiter (`HEARTH_FIRECRAWL_MAX_CONCURRENCY`, default 3) so a
nightly fan-out burst queues instead of saturating the single-worker
Firecrawl service — the root-cause fix for the recurring "firecrawl down"
incidents. Reuse `Semaphore` for any "bound concurrent requests to a shared
backend" need rather than hand-rolling another limiter.

### Vision rides the same endpoint (2026-05-26)

the LLM host's Qwen3.6 build is loaded with mmproj, so the same
`/v1/chat/completions` URL that serves text accepts the OpenAI vision
content shape directly. The OpenAI provider attaches an image to the
last user message when the caller sets `LLMRequest.vision = {
image_path }` ([src/core/llm.ts](src/core/llm.ts)) and transcodes HEIC
→ JPEG via ffmpeg ([src/core/image_transcode.ts](src/core/image_transcode.ts))
before sending — iOS captures land as HEIC, the server-side
transcode keeps the wire payload as JPEG.

Practical consequence: every specialist that holds the
`consult_deep_model` capability is also a vision-capable specialist —
the tool gained an optional `image_path` input and propagates it
through the LLMRequest. No per-specialist YAML change, no new
capability to grant. Cordelia's classifier scene track lives on the
same endpoint; she doesn't have a dedicated VL service URL anymore.
`HEARTH_VL_BASE_URL` is retired.

A non-vision endpoint (e.g. a future text-only OpenRouter fallback) is
handled by the `LLMCapabilities.supports_vision` flag — the provider
silently drops the attachment, the request proceeds text-only.

### Stream idle timeout — `OPENAI_IDLE_TIMEOUT_MS`

`src/core/providers/openai.ts` aborts a stream if no SSE frame arrives
for `OPENAI_IDLE_TIMEOUT_MS` (default `45000`). That budget covers the
gap between the last tool result re-feeding into the LLM and the first
output token of the synthesis phase. For 1–5-round chat turns the
default is plenty. For research-heavy turns where the LLM has accumulated
60k+ tokens of tool output across 10+ rounds, the LLM host can spend >45s on
silent generation before the first synthesis token — tripping the abort
and falling back to a canned "I ran into a problem" reply.

Bumped to `120000` (120s) in the orchestrator unit as of 2026-05-24
after the South-Arcade / Honey-Revenge turn surfaced the failure on the
real Maggie path. The overall request timeout (`total_timeout_ms`,
default 240s) is the real ceiling; the idle timeout just gives synthesis
its share of that budget. Future [tool-output compression](docs/design-tool-output-compression.md)
addresses the root cause (big-context synthesis is slow); the bump is
the band-aid until then.

The two-tier history below is preserved as audit trail.

### Historical: two-tier (2026-05-22 → 2026-05-23, retired)

Status: **implemented 2026-05-22.** Two models, warm in Lemonade, with
a clear division of labor — see [config/llm-roles.yaml](config/llm-roles.yaml).

Before this, every LLM role ran on one model, `Qwen3.6-35B-A3B-MTP`.
That worked, but it spent a 35B's compute on chit-chat and left no VRAM
headroom for the vision model the Inbox wants. The replacement is two
tiers:

- **Fast tier — `Qwen3.5-9B-Heretic`.** Carries every specialist's
  conversational chat turn (the `specialist` and `planner` roles). A 9B
  answers ordinary questions in a second or two; the user is not
  waiting on a 35B to decide what time it is.
- **Depth tier — `Qwen3.6-35B-A3B-Heretic`.** Runs the work where
  reasoning *is* the product: scheduled deliberation passes, voice-
  imitation drafting, reflection (Mariah's pattern scans), the daily
  relationship brief. It is also the escalation target.

Both are "Heretic" (decensored) builds — a deliberate call: a
household assistant should not refuse or moralize at its owner. With
the 9B as the default chat model, every specialist is uncensored with
no per-specialist `llm_role` overrides at all.

### Escalation, not a smarter small model

A 9B is not a 35B, and no amount of routing config makes it one. The
bridge is application logic: the `consult_deep_model` tool
([src/tools/consult_deep_model.ts](src/tools/consult_deep_model.ts)).
Any specialist, mid-chat-turn, can hand one hard, scoped sub-question
to the depth model and fold the answer back into its own reply. This is
the "engage the 35B as necessary" path — the fast model stays in the
driver's seat and reaches for depth only when a turn genuinely needs
it. It is the model-layer sibling of `consult_specialist`: that
consults a *teammate* for domain knowledge; this consults the *deep
model* for raw reasoning.

### The chat role runs think OFF — and the `<tool_code>` recovery

The `specialist` role runs `think: false`. A 9B's job on the chat path
is speed; thinking adds a measured ~7s per turn for quality the chat
turn does not need (real depth goes to the 35B via `consult_deep_model`
anyway).

That had one catch worth recording. This 9B is a Claude-distilled
finetune, and with thinking OFF it sometimes expresses a tool call in a
hybrid XML dialect — `<tool_code><tool_name>…</tool_name><parameter=…>`
— emitted as plain `content` rather than through the tool-call channel.
llama.cpp's Qwen parser expects `<tool_call>` to open a call, so the
dialect falls through uncaught: the tool never runs and the raw tags
land in the user's reply. It is intermittent — in isolation the same
model emits clean structured calls; the full runtime turn, with its
large instruction-dense system prompt, is what tips it.

The fix is an adapter, not thinking. `OpenAIProvider`
(`_parse_tool_code_dialect`) recognizes the dialect, parses it back into
real tool calls, and scrubs it from the visible content — the same
"meet the model where it is" move as tool_registry's
`_normalize_qwen_tool_args`. That family of boundary adapters grew a
schema-driven member in [scalar_recovery.ts](src/core/scalar_recovery.ts):
`_recover_tool_args` walks a failing field's Zod leaf and extracts the scalar
the model nested in an object/array (an enum option out of `{type:"friend"}`,
`YYYY-MM-DD` out of `{year,month,day}`, a number out of `{value:42}`), under
the invariant that a *structured* field is never blind-stringified into garbage
(`birthday='{"year":1994}'`) — the general mechanism that replaced a per-field
birthday/relationship carve-out, applied at both the registry boundary and
tool-internal `safeParse` sites. With that adapter, think OFF is clean and
fast and the escalation path still works. (One latency caveat unrelated
to thinking: a chat turn still spends ~15s on *prefill* of the large
persona + scaffolding + RAG system prompt — that floor is the prompt
size, not the model, and is a separate optimization if it ever needs
one.)

### Retiring MTP

`Qwen3.6-35B-A3B-MTP` is unloaded and out of the roster. Lemonade's
VRAM use dropped from 55 GB to 36 GB — ~19 GB freed on the spot, and
the headroom is the entire point: it is what later makes room to serve
a vision model warm alongside the 9B and the 35B. Lemonade holds
exactly two models warm now.

## LiteLLM — evaluated and deferred

Status: **decided 2026-05-22 — not adopted.**

LiteLLM is a gateway/proxy: one OpenAI-compatible endpoint in front of
many model backends, with logging, fallback, retry, and cost tracking.
It was evaluated alongside the model-layer work. The decision is to
**not** stand it up — now, and probably for a good while.

- LiteLLM does not do the thing it is tempting to imagine it doing. It
  does not make a small model "escalate" to a big one — that is
  application logic, and it already exists as `consult_deep_model`.
- Hearth already owns the pieces LiteLLM would duplicate. Role-based
  routing is `config/llm-roles.yaml` + `ConfigLLMRouter`. Model and
  token counts already land in the audit log. Retry-on-transient is
  already in `OpenAIProvider`. Adopting LiteLLM would mean a second
  routing-config surface and a second service to run, for capability
  the system already has.
- The honest trigger for a gateway is **more than one backend**. Today
  there is exactly one: Lemonade, OpenAI-compatible, serving
  everything. One backend behind a one-backend proxy is moving parts
  for nothing — and the local-first, minimal-moving-parts ethos says
  don't.

The real question is the vision model (Qwen3-VL, for Inbox image
captioning). If Lemonade can serve it warm alongside the 9B and the
35B — which retiring MTP now leaves the VRAM for — there is still one
backend and still no need for LiteLLM: register the model, add a
`vision` role, done. LiteLLM earns its place only if the VL model
forces a *second* backend (vLLM, sglang) into the picture; then it is
the bridge that unifies the two behind one endpoint. So: **stand up
the vision model first, by whatever backend serves it; adopt LiteLLM
only if that turns out to be a different backend.** Don't add the
service speculatively.

## Operational health + self-healing (2026-06-20)

A core dependency died and the system ran on for eight days as if nothing were
wrong — research came back empty, every agent's web-fetch silently failed, and the
only way it surfaced was a human noticing a blank report and SSHing in. The flaw
wasn't the broken service; it was the absence of operational *awareness*. Hearth
had careful per-call recovery hints and a fastidious audit log, but nothing stood
back and asked "are my dependencies actually working?" — so a failure that was
loud in the aggregate (a tool erroring on every call for a week) was invisible
because no one read the aggregate. This adds that missing layer as a general smoke
detector, deliberately not a Firecrawl patch: the next dead LLM endpoint or
embeddings server is caught the same way.

The detection is two signals because a dependency can fail two ways. An endpoint
probe catches a service that's simply unreachable — including one nobody happened
to call, which an audit-log-only approach would miss. The audit-log error rate
catches the harder case: a service that answers but fails every request. The
subtlety that made the original outage invisible is encoded here — a connector
tool reports failure by returning `{error}` in its *output*, which lands in
`execution_result`, not the audit row's `error` column, so the health query has to
read both. Neither signal is trusted to crash the assessment; a probe that throws
just marks its own dependency down.

The honesty of the surface comes from modeling *incidents*, not instantaneous
state. An incident opens on the edge into trouble and carries its `first_seen`, so
the system can say "down for eight days" truthfully and alert exactly once rather
than every time it checks. That single design choice is what separates a useful
monitor from an alert-fatigue generator.

The remediation tier reflects a hard-won lesson from the live test that birthed
this feature: restarting the dead worker did *not* fix the deeper fault. So the
self-healing is studiously un-triumphant — it restarts the actual failing
container (not the user-facing service), it refuses to restart-loop (a couple of
attempts, then it escalates to the owner), and it never marks an incident resolved
on its own authority; only the next health scan, seeing the error rate actually
drop, closes the loop. The split of duty is the same chief-of-staff/meta-agent
division the rest of the system uses: Kate notices and triages and tells the
owner; Beatrice, who already owns changing the system, owns fixing it — by restart
when that's the fix, by her reviewed change pipeline when it's config or code, and
by honest escalation when it's neither.

The one genuinely new piece of trust is the restart itself. The orchestrator runs
in a container with no Docker access by design, so remediation goes through a
tiny, tightly-scoped sidecar — the same pattern as the Wake-on-LAN relay — that
can do exactly one thing: restart a container whose name is on an explicit env
allowlist (empty by default), bearer-gated, over the Docker socket. It is not a
general Docker surface; the blast radius if its credential leaked is "restart an
allowlisted service." And the whole layer is opt-in in two stages — detection and
escalation work with no sidecar at all (remediation simply becomes "escalate to
the owner"), and self-healing turns on only when the owner wires the relay and
names services it may touch.

The remaining gap was that the escalation was *shallow*: "Firecrawl down, 98%
failing" tells Beatrice that something is wrong but nothing about WHY, and the
actual root cause in the live incident — `firecrawl-worker Exited (1) ELIFECYCLE`
— lived only in the worker's container logs, which nothing read. So the same
two-step opt-in now extends to *diagnosis* (`diagnose_dependency`,
`src/core/health_diagnosis.ts`), automating the work a human does by hand — read
the logs, find the crash, reason about the cause, propose and weigh fixes —
entirely on the **local** deep model, because operational diagnosis is exactly the
kind of always-on, privacy-sensitive reasoning that should never leave the house.
The shape deliberately reuses the deep-research engine's discipline applied to an
incident instead of a subject: gather an evidence pack (the actual error strings
from the audit log, the probe, the resolved config, and the container logs via a
new *read-only* `/logs` endpoint on the same guarded relay — same bearer, same
allowlist, one shared gate so the read path can never be looser than the restart
path), reason to a root cause grounded only in that evidence with the shared fact
critic dropping anything the logs don't support, then adversarially score each
typed candidate fix on likelihood, risk, reversibility, and blast radius and rank
them by a pure deterministic composite. The load-bearing constraint is that the
diagnosis layer has *no authority to act*: every fix it proposes names an existing
gate (the circuit-broken restart, the reviewed config/code change, or honest
escalation), so the new capability is purely "understand and recommend." What
reaches the owner is no longer a bare alarm but a diagnosed incident with ranked,
scored options — and the only thing Beatrice may apply without him is the same
high-confidence restart she already could, now justified by evidence rather than
reflex.

## Closed-loop roster maintenance

A fix applied by hand fixes one specialist once. The same class of
misconfiguration recurs — the next specialist added with a broad
grant, the next persona that drifts — unless the system itself learns
to catch it. So every fix is also fed back as **detection**: the
program watches its own roster and heals.

### Mariah owns the loop — five layers of detection

| Scan | Cadence | What it catches |
|---|---|---|
| `scan_program_health` | hourly | work that *failed* — undelivered followups, failed proposals |
| `scan_program_patterns` | daily 04:00 | behavior that *drifted* — error clusters, repeated miss classes, re-asked consults (LLM judgment, slower) |
| `scan_specialist_alignment` | daily 04:30 | a specialist's **configuration** is misaligned — uncurated tool surface, dangling `tools_for_chat`, persona prescribing a tool they can't invoke, idle specialist with no audited activity |
| `scan_specialist_authenticity` | daily 04:45 | a specialist's **behavior** is fabrication-shaped — thinking-only consults, parroted empty consults, fabrication after read failures, dropped-args tool calls |
| `audit_connector_affordances` | daily 05:00 | a *connector* returns `error` with no structured recovery hint, inviting the fabrication-after-read-failure pattern at scale |

The last two layers landed 2026-05-25 as a deliberate pair: behavior
detection finds the symptom; affordance detection finds the upstream
cause. Each scan is idempotent on a stable `evidence_ref` so a daily
re-run never double-flags — and since 2026-06-09 the STORE backstops
that contract: `ProcessMissStore.create()` dedups on `evidence_ref`
across all statuses (annotates a live row; REOPENS a closed one on
recurrence), so a scan that drifts can't fragment the ledger.
Recurring runtime signals aggregate by design — the round-ceiling miss
keys per `(specialist, ISO week)`, so a noisy week is one row with a
recurrence trail instead of dozens.

**Detector precision is a first-class requirement (2026-06-09).** The
loop's first month showed the dominant failure mode is not missed
findings but FALSE ones: the duplicate-call guard's error shape read
as "unrecovered read failure" (27 fabrication misses against
well-behaved specialists), a hand-listed zero-arg allowlist flagged
Kate's correct no-arg `weather_now` calls, and ~⅔ of ledger inflow was
detector noise about the meta-agents themselves. The fixes were all
mechanism-level: duplicates are served from a per-turn cache as
results (`retry_storm` is their honest, low-severity pattern);
behavior-signal errors are classified out of `is_failed_read`; the
zero-arg set derives from the registry's Zod schemas
(`safeParse({})`). A scan that cries wolf doesn't just waste Mariah's
queue — it feeds Beatrice false structural work and erodes the owner's
trust in the whole loop.

**Surfacing the ledger is a capability, separate from filing into it
(2026-06-08).** A deliberation pass surfaces the whole open-miss ledger —
and accepts the envelope's `miss_actions` driver — only for specialists
granted `drive_process_misses` (Mariah + Beatrice, the loop's managers).
That is deliberately distinct from `write_process_miss`, which merely
authorizes FILING a miss and is held by domain specialists too (Kristi's
`acquire_quickspecs` opens one when a spec-write is rejected). The two were
conflated until Kristi's deliberation prompt — carrying all 22 open misses
rendered twice — overflowed the 35B's 49,152-token window and 400'd her
scheduled passes; splitting the capability dropped her base prompt by 52%.
The rule generalizes: a specialist who only *reports* into the loop must
not pay the prompt cost of *managing* it.

### The roster grows the same way — evidence-driven hiring (2026-06-10)

Mariah's loop heals existing specialists; the staffing loop grows the
roster from the same kind of audit-mined evidence. Two signals the
runtime already writes mean "the household keeps needing something
nobody owns": **Cordelia's triage interrupts** (captures her classifier
couldn't route to any specialist above threshold — the capture's own
route-reason/OCR/VL text rides in `details_md`) and the demand ledger's
**unattributed signals** (knowledge_demand.ts rows with no specialist
attribution). [src/core/roster_gaps.ts](src/core/roster_gaps.ts) mines
both deterministically, clusters them with the demand ledger's
token-overlap grouping (same window in → same topics out, so packet
rationales cite re-verifiable refs), and applies an evidence floor
(`HEARTH_ROSTER_GAP_MIN_EVIDENCE`, default 4 signals over a 21-day
window). Above-bar topics render into the deliberation pass of any
specialist holding `drive_roster_gaps` (Kate — she runs the team),
alongside the pending/recently-denied hire packets so she never
re-files or re-litigates a denial. Her instructed move is the existing
`propose_hire` pipeline: persona draft + Beatrice's capability gap
analysis + a two-tier packet (day-1 capabilities vs build queue) filed
as a proposal only Jasper can approve — the evidence side and the
review side of hiring are now both closed-loop. Most passes mine
nothing and render nothing; when a report does render, a
`roster_gap_report` audit row records the topics + refs. The same gate
split as the miss ledger applies: mining is meaningless prompt weight
to a domain specialist, so the capability is Kate's alone.

Two roster mechanisms shipped alongside it: **`deliberation_dow`**
(ProactiveSchema) restricts a specialist's `deliberation_at` slots to
listed local weekdays — the scheduled-tick analogue of a background
job's `dow`, read off the same wall clock as the slot match
(`local_dow()` in time.ts); off-schedule wakes are not gated. **Luna**
(House Steward — building systems, maintenance cadences, warranties,
contractors) is the first weekly specialist on it (`["mon"]`, 08:30,
90-day planning horizon), with the Astrid-idiom `update_luna_vault`
ledger writer and `bun run seed:luna` day-1 knowledge.

### Strategic-PM autonomy at queue depth

The pre-existing one-miss-per-deliberation flow held up at ~12 open
misses. When the new behavioral + affordance scans opened ~120 misses
on first run, walking them one at a time would take Mariah months.
Three tools shifted the unit of work from "one miss" to "one cluster"
without breaking the commit-early shape:

- `program_dashboard` — strategic snapshot Mariah reads first every
  deliberation. Open totals by severity / age / pattern, the trend
  window (opened-vs-closed in N days), per-scan freshness,
  authenticity tier distribution + bottom-3, and — most importantly —
  `leverage_targets`: clusters where one fix would close N misses,
  each carrying a `status_breakdown`, a pre-computed `suggested_action`
  (the legal batch transition for the dominant status), and a synth
  `one_fix_hint`.
- `batch_advance_misses` — apply one action to every miss matching a
  filter. Safety rails: single-miss filter refused (use the
  single-step tool for those), batch cap default 50/max 200,
  bulk close/verify on high-severity requires `allow_high_severity:
  true`. Composes on `apply_miss_action` so the lifecycle guard
  remains the source of truth.
- `verify_fix_landed` — the loop-closer. Pick candidates by pattern
  (or explicit `miss_ids`), re-run the scan that owns the pattern
  via the tool registry, compare each candidate's evidence_ref
  against the scan's fresh `current_findings_refs`, auto-close any
  whose ref no longer appears. Lifecycle-respecting; closes through
  `apply_miss_action`. The reason the scans expose
  `current_findings_refs` is precisely this verify path — without
  it the close branch can't fire because open misses look "still
  active" by their own existence.

Together those three change a Mariah deliberation from "list 120
misses, advance one" to "open dashboard, batch-route the top
leverage_target, optionally verify last cycle's fix landed."

### The connector affordance pattern

The Iris/EV fabrication on 2026-05-25 traced to a single shape:
`ha_get_state` returned `{state: null, error: '404'}` four times with
nothing actionable, and Iris manufactured a percentage rather than
retry. The fix lived at the tool layer, not the persona layer:
extend `ha_get_state` to also return `candidates: Array<{entity_id,
friendly_name}>` ranked by shared-token overlap on a 404, so the
calling LLM has a real next call to make.

That fix is now the template every read connector follows:

> **A connector whose `output_schema` includes `error` should also
> expose a structured recovery hint — `candidates` / `suggestions` /
> `alternatives` / `available_*` / `recovery_*` / `retry_with` /
> `next_action` / `hint(s)` / `matches`. The recovery field is
> `.optional()` and populated only on the error path; successful
> reads stay unchanged.**

`audit_connector_affordances` is the enforcement: it walks the tool
registry daily, flags every tool whose schema has `error` but no
recovery-hint field, and opens a `process_miss` per gap routed to
Beatrice. The "no bare errors" rule is not advisory — it's audited.

Since 2026-06-09 the pattern is enforced on BOTH sides of the loop.
The recovery-hint detector lives in one shared module
(`src/core/connector_affordances.ts`): the audit uses it to find gaps,
and Beatrice's `propose_connector_recovery_hint` uses it to
mechanically REFUSE a proposal for a tool whose schema already carries
a hint (she had re-proposed `candidates` for `web_fetch_clean` two
weeks after it shipped — instruction-level guards don't hold; schema
checks do). And on the consumption side, the specialist runtime
appends a one-line use-it-or-admit-it nudge to any tool result
carrying `error` + a populated recovery field — the hint's value no
longer depends on each persona remembering to mention it.

Live as of 2026-05-25: `ha_get_state` and `web_fetch_clean` both
carry `candidates`; the other ~40 connectors with `error` fields are
queued through Beatrice's templated proposal flow described below.

### The sibling rule — a diagnosis must carry what acting on it requires (2026-07-25)

The affordance pattern above says a tool that can FAIL must hand back a
usable next call. The 2026-07-25 whole-stack outage exposed its mirror
image: a tool that SUCCEEDS must hand back everything acting on its
answer requires. `diagnose_service` returned Plex's real state and real
logs and was, on its own terms, correct — but an ops answer's next step
is a command, a command needs a path, and the tool returned no path. The
model filled the hole the way models fill holes: it authored
`/opt/plex`, a directory that has never existed on that box. Compose then
walked UP the tree from the wrong cwd to the master
`/docker/docker-compose.yml`, and a `down` meant for one container
removed ~45.

Nothing in the grounding stack was positioned to catch it. The
`fact_critic` ran on that reply and passed it — an invented directory is
not an unsupported *claim*, and a destructive verb is not a fabrication
at all. Provenance checks what a reply asserts; it has no opinion on what
a reply instructs.

So the rule generalizes:

> **A tool whose result the model will turn into an ACTION must return
> the operands that action needs.** For an ops read that means the
> container's real compose origin — project, service, working dir,
> config file — read from its own Docker labels, plus the blast-radius
> count and the narrowest commands, pre-assembled. Where the operand
> genuinely doesn't exist (a container started with a bare `docker run`
> has no compose file anywhere), the tool says so explicitly. The honest
> absence is load-bearing: a blank field invites the same invention the
> missing field did.

The refusal path is where this bites hardest, and it's the easiest to
overlook. `restart_container` refusing a non-allowlisted service is
precisely the moment the answer must hand the owner a manual command —
the guardrail that stops Kate acting is what forces her to instruct
instead. A refusal that says only "I can't" pushes the invention one
layer out. It now returns `manual_command`, derived from real labels.

And because a command handed over in prose is an **effect with no gate**
— unlike `send_external`, `spend_money`, or a code merge, all of which
route through approval — grounding the tool is only half. The other half
is `shell_safety.ts` in the finalize pipeline, which gates the effect
rather than the composition: a destructive verb passes only when it is
both targeted and blast-radius-stated, and an absolute path inside a
command block must appear in the turn's tool evidence. See the private dev log,
"The shell-safety guard". The two halves are deliberately paired — the
tool contract makes the truth *available*, the guard makes it *enforced*.
A persona instruction to "check before you act" is neither: this reply
was authored with three correct tool calls already in context.

### Visibility is a capability — and its absence manufactures confabulation (2026-07-25)

The sibling rule above says a tool must return the operands an action needs.
The 07-25 outage had a second, subtler version of the same disease, and it's
worth stating separately because the fix is a *new capability*, not a better
result shape.

Kate could see inside containers and nothing about the machine. Asked why Plex
was down, she read a real `nvml error: driver/library version mismatch` out of
real logs and then explained it wrongly — blaming the container image, when the
fault was host userspace NVML running ahead of the still-loaded kernel module.
Both facts that settle it (`/proc/driver/nvidia/version` for the module,
`libnvidia-ml.so.*` for userspace) were unreachable by every tool in the tree.

The instructive part is that **this is not a model-capacity failure and a larger
model would not fix it.** The evidence that decides the question was absent from
the context, and no amount of reasoning recovers an absent fact. What the missing
capability *does* do is make confabulation the likely outcome rather than merely
a possible one: the container-layer evidence she could see was real, suggestive,
and pointed somewhere plausible-but-wrong. Give an agent a partial view of a
system and ask it to explain the whole, and it will explain the part it can see.

The fix is `diagnose_host` — and its design is the point:

> **Bound the ENVIRONMENT, not the command.** A blessed list of diagnostic
> commands closes the incident in front of you and stops at the next one. Instead
> the command is arbitrary and the sandbox is what makes it safe: no network,
> read-only bind of the host, unprivileged uid, capabilities dropped, destroyed
> after one call. Safety comes from walls, not from predicting what will be
> asked. That is the difference between a carve-out and a mechanism.

Two properties fall out that are worth keeping in mind whenever a read surface
widens. First, **ordinary Unix permissions do more than a denylist can**: running
as `nobody` denies the entire credential surface structurally, without predicting
a single path. Second, **the thing a denylist is actually for here is the cordon,
not the secrets** — the vault, library and database are world-readable and hold
other household members' private data, and a raw filesystem read has no concept
of `private_to`. The owner-has-no-god-view invariant is a design commitment the
rest of the architecture is built on; one unrestricted read tool would void it.
Those paths are shadowed so they read as absent.

### On-property weather — the WeatherFlow Tempest connector (2026-06-23)

`weather.ts` serves a GEOCODED *forecast* (Pirate Weather, keyed off
`home_location`). A WeatherFlow Tempest station on the property adds the
complementary axis: ACTUAL *ground-truth* conditions — temp/humidity/pressure,
wind speed+dir+gust+lull, rain rate + daily accumulation, UV/solar/illuminance,
and lightning strike count+distance+recency. Forecast and station are kept
separate by design: the station owns "now, here," the forecast owns "later /
elsewhere."

The shipped path is **HA-relay** (`tempest_conditions` in
[src/connectors/tempest.ts](src/connectors/tempest.ts), capability
`read_weather_station`): HA's native WeatherFlow integration ingests the hub
over local LAN UDP and exposes one `sensor.*` entity per measurement; the tool
reads them through the existing HA connector (one `fetch_ha_all_states()` dump
resolves all ~20 sensors) and returns a typed conditions object with each
reading carrying HA's own `unit_of_measurement` (units are never inferred or
converted). Entity-ids are configurable at call time
(`HEARTH_TEMPEST_ENTITY_PREFIX` + per-measurement `HEARTH_TEMPEST_<KEY>`
overrides) because the device slug isn't known until the hub is added — and the
tool is itself an instance of the **connector affordance pattern** above: when
no measurement resolves (integration not added yet / wrong prefix) it degrades
to `{ ok:false, error, candidates }` listing the weather-shaped sensors HA DOES
have, so the prefix self-corrects instead of the model fabricating a reading.
A derived `signals` digest (`raining`, `lightning_active`,
`lightning_distance`) is the small-model-friendly safety surface for
Cassandra (lightning) and Eleanor (irrigation). Two further ingestion paths —
a direct LAN UDP :50222 listener (sub-second + event-driven lightning/rain
triggers) and the cloud "Better Forecast" API (a hyper-local forecast-provider
swap) — are designed but unbuilt; full write-up in
[docs/design-tempest-weather-integration.md](docs/design-tempest-weather-integration.md).

The **proactive danger-alert layer** rides on top of those pull signals
([src/core/dangerous_weather.ts](src/core/dangerous_weather.ts),
`DangerousWeatherDriver`, wired next to `FlightTrackingDriver`): a 60s ticker
edge-detects a real danger — close active lightning, extreme wind gust, or an
active NWS warning (the full taxonomy via Pirate `fetch_weather_alerts`, tiered
by urgency in `classify_alert`: the EAS `critical` tone reserved for take-cover-
now events, the friendly `notice` chime for the rest + lightning/wind) — and on
the false→true edge alerts the household BOTH ways: it speaks the warning over the Satellite1
(`try_speak_followup` → coordinator `/speak`, presence-gated) AND pushes every
home member (owner + household, never friend, never a synthetic/test account) at
`high` severity, which pierces quiet hours and the read-the-room gate
(`delivery_window`: high/interrupt always delivers). Deliberately
DETERMINISTIC (the alert text is composed in code, never via a woken
deliberation) — safety delivery must not depend on the model choosing to call a
tool. Edge-only + per-key rate-limited (one alert per storm, re-alert only on
lightning closing in), fail-open, DARK until `HEARTH_DANGEROUS_WEATHER=1`.

### Market data + the speculative radar (Vivian, 2026-06-11)

`src/connectors/market_data.ts` gives Vivian live market reach —
quotes, OHLCV history, per-ticker technical snapshots, trending /
day-gainer movers, and `momentum_screen`, a theme-universe momentum
ranker over `config/market-themes.yaml` (AI infrastructure, AI
software, datacenters, power & nuclear, vertical farming/agtech,
space, robotics, quantum, defense tech). Design decisions worth
keeping:

- **Keyless Yahoo endpoints, not an API-key service.** Chart /
  trending / predefined-screener / search work with only a browser
  User-Agent — no credential to provision, rotate, or leak, in
  keeping with local-first. Data is ~15-min delayed, which is fine:
  nothing downstream is latency-sensitive (no execution path exists,
  by design).
- **Momentum is pure math, not LLM judgment.** The score is a
  transparent rank-percentile blend (35% 3-mo return, 30% 1-mo
  return, 20% 52-week-high proximity, 15% volume surge) computed
  in-process from fetched bars, and every output row carries its risk
  numbers (annualized volatility, 3-mo max drawdown, RSI) next to its
  momentum numbers — the tool shape itself keeps a radar pitch
  honest, per fix-at-the-layer-that-owns-it.
- **The two-lane persona stance.** Jasper explicitly opted in
  (2026-06-11) to Vivian recommending specific tickers as speculative
  radar candidates — superseding the prior hard "never recommend
  specific securities" stance. The fiduciary lane (ER audits,
  concentration, filings, macro) is unchanged and stays first-reflex;
  the radar lane requires same-turn tool evidence, risk numbers in
  the same breath, sleeve sizing (5–10% of investable assets total),
  and bans certainty language. Radar picks live in chat + briefs,
  never as action proposals — there is deliberately no trade
  execution surface anywhere in Hearth.
- **Themes are hand-editable config read fresh per call** — one
  mechanism for "what counts as the AI theme," shared by the screen,
  the persona, and the brief radar line; pruning a delisted ticker is
  a YAML edit, and the screen tolerates per-symbol failures
  (`skipped`) rather than aborting. Gated by `read_market_data`
  (config/capabilities.yaml), Vivian-only.
- **Fundamentals vetting separates the trend from the story**
  (2026-06-14). `company_fundamentals` (sec_fundamentals.ts) reads real
  financial statements from keyless SEC XBRL — revenue / earnings / cash
  flow series, margins, growth, debt, and live market cap / P/E / P/S —
  so a momentum name can be judged on whether the run is *earned*. The
  momentum tools say what is moving; this says whether it should be. The
  architectural lesson worth keeping: XBRL tags migrate across a
  company's filing history, so a concept's tag-fallback list is fetched
  in FULL and the freshest annual series selected, never first-hit
  (which silently served stale revenue). US-GAAP filers only, fail-soft
  to an honest no-financials note. Vivian's persona requires vetting a
  name before naming it a radar candidate.
- **The radar tracks its own deltas** (2026-06-14). The 14-day snapshot
  history (kept since the table shipped) powers a pure read-time diff —
  entrants, accelerators, and dropouts vs a ~week-old comparison run —
  surfaced as the Market Radar tab's "New & accelerating" section. No
  new table, no new write: just `MarketRadarStore` history accessors and
  a route-level diff. The "what's moving" question is answered most
  sharply by what CHANGED, and the data was already there.

The radar grew an **office surface** (2026-06-12): Vivian's fuel office
is tabbed Finances | **Market Radar** — the News Desk pattern (client-
rendered tab in app.js over `GET /api/specialists/:id/market_radar`, no
pane-composer change, no nginx change since it rides the existing
/api/specialists namespace). The snapshot behind it is the
`market_radar_snapshots` table, written by Vivian's
`refresh_market_radar` background job (06:50/13:30 — momentum_screen
over every theme + trending, per-theme failures tolerated) and the
route is capability-gated generically: any specialist granted
`read_market_data` serves a radar, owner-only. The headline rail reads
`news_items` cross-rack by category (`markets`/`ai-business` from
Vivian's daily feed rack + Kate's `ai` vertical) — same single-URL-one-
rack contract as the News Desk. The same ship widened **Kristi's
charter** from workstations to the on-prem AI compute stack (AI
servers, rack workstations, accelerators, agentic-workload demand) and
wired the Vivian↔Kristi partnership at the persona layer over the
existing `consult_specialist` channel: Kristi hands over investable
hardware inflections (never stock takes), Vivian pulls hardware truth
behind AI-infra radar picks.

### Provenance enforcement — the structural anti-hallucination layer

Every LLM hallucinates: it's a next-token predictor over parametric
memory and cannot itself distinguish "I retrieved this" from "this is
statistically plausible." A bigger dense model makes hallucinations
*more convincing*, not rarer. The worked example is Ruby's Ponds Fire
turn — asked who owns the power line that caused a local fire, she
invented PUC Order `E-23734`, a verbatim DFPC quote, and Xcel
ownership, all fluent, all wrong. The durable-truth thesis: you don't
fix this by scaling the model or scolding it in a prompt; you fix it
*architecturally*, weakest layer to strongest — prompt rules →
provenance enforcement → durable curation → live verification.

**Phase 0** (`c0d3660`) is the prompt layer: the source-not-category
grounding rule, the deliberation grounding block, the fabricated-save
guard. Necessary, ignorable under pressure. **Phase 1** (Durable Truth,
2026-05-30) is the enforcement layer that holds when the model is
confidently wrong — [src/core/provenance.ts](src/core/provenance.ts).

The mechanism: after a reply is generated, extract its load-bearing
claims (identifiers, verbatim quotes, dates, numbers) and check each
against a GROUNDING CONTEXT — the union of everything the specialist
legitimately retrieved this turn (tool results, conversation history,
the user's message, retrieved library material). Two normalized forms:
a whitespace-collapsed lowercase corpus for phrase/quote checks, and a
fully-squashed (alphanumerics-only) corpus for identifier checks so
`E-23734`, `E‑23734` and `E 23734` all resolve to the same `e23734`
needle. A claim whose token resolves to *nothing* in that context is
ungrounded — the model produced it from memory, which for a specific
identifier or quote is by definition a fabrication.

Two design invariants make this sound:
- **The system prompt is NOT a grounding source.** Its grounding-rule
  block literally contains the `E-23734` worked example; including it
  would ground the very fabrication we exist to catch. Grounding is
  *evidence the model retrieved*, never the instructions.
- **Tool inputs are NOT a grounding source.** A fabricated id the model
  passed as a search argument must not ground itself; only what came
  back counts.

**The lexical detector is interim, and known-brittle.** The extractor
is a finite set of regexes for the claim shapes we anticipated —
which is itself an *enumeration of failure modes*, the exact
anti-pattern this codebase otherwise rejects (a fabricated street
address, a quote without quote marks, a hallucinated institution name
all sail through; the `≥4-digit` rule that stops `US-287` from
matching is a literal carve-out). It cannot generalize, because
"hallucination" is an epistemic property (a claim the model never
retrieved), not a token shape. The **durable** detector is semantic —
a verifier model that judges whether each assertion is *entailed by*
the evidence — which is what the librarian lane (Phases 2-3) and the
`fact_critic` pass (NEXT.md #5) are for. The regex detector is a
stopgap; do not extend it with more shapes.

Because the detector is brittle, the enforcement is deliberately
**non-destructive**: the only live action is a one-retry *nudge* that
names the unsourced specifics and pushes the model to fetch or drop
them (aligned with the thesis — make truth cheaper to fetch). The
hard-redaction backstop that originally shipped was **removed
2026-05-30 at Jasper's direction**: silently stripping tokens from a
finished reply is a blunt instrument that false-redacts whenever the
grounding builder misses a source, and it's the wrong response to a
brittle detector. Enforcement is tiered by extraction precision
(`PROVENANCE_POLICY`): `identifier` / `quote` drive the retry; `date`
/ `number` are FLAG (detected + audit-logged only).

Wiring:
- **Chat finalize** (`turn()` + `turn_streaming()`): a provenance retry
  nudge with its own latch (mirrors the ghost-promise / fabricated-save
  idiom). Skipped for voice (TTFB). No redaction.
- **Deliberation finalize**: no Phase-1 enforcement (it was redact-only,
  and the redaction was removed); the Phase-0 prompt grounding block
  still applies to the brief.

The redaction primitives (`enforce_provenance` / `redact_ungrounded`)
remain in [src/core/provenance.ts](src/core/provenance.ts) as a tested
library capability — unwired from the runtime, available if a future
*semantic* verifier wants a redaction action behind a confident
"this claim is not supported by the evidence" verdict.

The grounding for the brief comes from **domain packs** — the
generalization of `pull_brief_context` into
[src/core/domain_packs/](src/core/domain_packs/). A domain pack
pre-pumps verified, *sourced* readings before the turn and exposes a
`grounding_corpus()` of its FRESH readings only (an `unavailable`
reading is an explicit "no data" marker and must never ground a claim).
`life_context` is the first pack; future packs (finance, pet-medical)
follow the same two-method contract. Audit trail: `provenance_guard`
(retry fired), `provenance_redaction` (per surface). Phases 2-3 add
durable curation and live concurrent verification on top.

The pack is also **per-recipient privacy-scoped**. `life_context`'s
HA-sourced readings (EV SoC/range, indoor temp) come from the single
admin-home Home Assistant instance, so `pull_brief_context` pumps them
only for an **owner-tier** brief (`is_owner`, resolved from the
recipient's tier via `users.get(user_id)` when not passed explicitly);
a non-owner brief gets `unavailable` owner-only markers in their place,
so no admin device data leaks into a household member's context — and
the brief prompt's HARD RULE keeps Kate from filling the gap from
memory. Weather + calendar stay per-user regardless of tier. The same
gate scopes the chat/voice warm-cache pre-injection (the warmer omits
`is_owner`, so the in-function tier resolution covers it). Until a
per-user HA source exists, owner-only is the correct scope.

#### Phase 1.5 — the semantic fact critic (named-entity fabrications)

Phase 1's lexical detector closes the *identifier* class (Ruby's
fabricated `E-23734`) but is structurally blind to the **dominant**
civic-fabrication shape: a confidently-invented council agenda ("Budget
Work Session: FY2027 Budget"), a fabricated plan name ("Strategic Trails
Plan"), an invented trail ("Mack Trail", "West Side Loop"), a made-up
address. These carry no docket-shaped id and no quoted string, so
`extract_claims` produces no claim for them (there was never a
`named_entity` extractor — the kind was declared in `PROVENANCE_POLICY`
but nothing emitted it), and the retry only fires on `enforce`-tier
claims, so a reply whose only specifics are a fabricated date +
named entities triggered **nothing**. That is exactly how Ruby's
"next council meeting is June 2 + [invented agenda]" reached Jasper
(2026-05-30).

You cannot close this with more regexes — "hallucination is a claim
never retrieved, not a token shape," and enumerating shapes is the
banned anti-pattern. The generalizing layer is **semantic**:
[src/core/fact_critic.ts](src/core/fact_critic.ts) (Phase 1.5,
2026-05-31), modeled on the blessed two-layer shape of the capture
quality gate. Layer 1 — a deterministic pre-filter generates candidate
specifics from the reply (proper-noun phrases with leading determiners
stripped, real acronyms/codes, dates, magnitudes) and drops the ones
already present in the turn's evidence. A reply that used its tools well
leaves few/no ungrounded candidates and **skips the model call** — the
common low-latency path. The pre-filter is a *candidate generator*,
never the decider, so it isn't a blacklist. Layer 2 — a planner-role LLM
judge separates (a) supported-by-evidence and (b) stable general
knowledge from (c) **unsupported volatile claims** (a specific
meeting/agenda/vote/figure/named-plan that required retrieval and
wasn't retrieved); only (c) returns. **Fail-open always** — judge
error / unparseable / absent router / empty candidate set → no
findings; a critic outage never blocks a reply.

The enforcement action is the same one-retry **nudge** (Jasper's
no-hard-redact direction holds), generalized via
`fact_critic_retry_nudge` and sharing the existing `provenance_retried`
latch in `turn()` + `turn_streaming()`. It runs only when the regex
pass found nothing `enforce`-tier, so the two layers compose without
double-nudging. Skipped for voice and under `HEARTH_TEST_MODE` (so the
fixture smokes keep their deterministic shape); kill switch
`HEARTH_FACT_CRITIC=0`. Audit row: `fact_critic`. Both the structural
plumbing (mocked judge) and the real-27B semantics (the live judge
flags all nine of Ruby's invented agenda specifics) are proven in
[scripts/test-fact-critic.ts](scripts/test-fact-critic.ts) /
`bun run smoke:fact-critic`. Evidence selection is shared with the
regex layer through `build_grounding_evidence` in `provenance.ts`, so a
source added once is seen by both. This is the layer that catches what
Beatrice's persona-tuning ("cite or don't say it") never could — the
fix lives in the runtime that owns the boundary, not in prose the model
can ignore.

**Precision for domain-dense specialists (2026-06-08).** The critic's recall
bias is correct only if Layer 1 doesn't drown the judge in non-claims. A
workstation analyst (Kristi) whose replies are markdown-heavy and acronym-
dense tripped it on nearly every turn — flagging her own office name "Recon
Desk", her `### headers` and `**bold labels**`, and standard acronyms
(ISV/CAD) — and the model answered the resulting nudge with apologetic
machinery-leaking prose ("you're right, I fabricated…"). Three structural
fixes keep the layer honest without weakening it: the specialist's **own
identity** (name, role, office/pane name, held tools) is folded into the
grounding so self-reference never reads as fabrication; **markdown structure**
(headers, code fences, bold spans) is stripped before *named-entity*
extraction only (dates/figures still run on the raw reply); and the **retry
nudge is silent** — it instructs a direct correction, never an apology or a
"reset" narration the user would see. The same release taught
`_STALE_DENIAL_PATTERNS` to recognize *write/modify* capability denials
("insert-only", "can't reclassify"), closing the poisoned-history loop where a
specialist parrots a false "I can't" it stated earlier in the thread.

#### Phase 1.6 — grounding precedence for person facts (2026-06-14)

The fact critic is only as good as the EVIDENCE it checks against — and
turn-RAG can surface the *wrong* evidence. A specialist's own derived/cache
library clipping (inside its `knowledge_scope`) gets retrieved; the master
`vault/People/<name>.md` record, usually OUT of that scope, does not. So a stale
`reviewed:false` clipping carrying a wrong address outranked both the master
record AND the user's own correction — and the critic, seeing only the wrong
value, branded the CORRECT address a fabrication for two days (the 2026-06-03
Ruby / the clinic-vet-lab loop: `2450 Parkfield Drive` beat `3215 Westwood Ct`).
[src/core/grounding_precedence.ts](src/core/grounding_precedence.ts) fixes the
ORDERING the critic trusts: it classifies a turn's evidence by authority tier
(`user_statement > master_record > tool_result > reviewed_clipping >
derived_clipping`) and, when a clipping address conflicts with an authoritative
one for the SAME person, scrubs it from the grounding evidence while injecting
the master record as authoritative. A wrong clipping then neither anchors a
mistaken reply nor flags the correct one as ungrounded. The bridge
`gather_person_precedence` runs in both chat turn paths (conversation-only,
address-gated, fail-open) and emits a `grounding_precedence` audit row. Proof:
`bun run smoke:grounding-precedence` (incl. the real provenance grounding check).
Fix #1 of the incident (the `upsert_person_note` schema mismatch) shipped
2026-06-05; the duplicate Jasper person records are a separate data migration.

#### The unified per-turn re-roll budget (2026-06-05)

Each content guard above — ghost-promise, fabricated-save, read-failure,
provenance, the semantic fact-critic, and (since 2026-06-12) the
data-denial guard — carried its OWN one-shot latch.
Independently that's right (each catches a distinct failure), but they
COMPOSE badly: a single turn could trip several across successive rounds,
and because the chat loop streams each round's reply live, the user watched
the message get rewritten **over and over**. The reported cases were Anna
(property-tax) and Kristi (workstations) — number/spec-dense replies the
guards re-rolled turn after turn (audit: `fact_critic` retry_triggered on
nearly every Anna turn; Kristi dominated by `blank_turn_fallback` +
`same_tool_spiral_exhaust`).

The fix is a single per-turn budget — `max_content_rerolls_per_turn()` +
`rerolls_used`, mirrored in `turn()` and `turn_streaming()` — shared across
ALL the content-re-roll guards: the first to fire spends it; once spent,
the rest skip their re-roll for that turn (the fact-critic's LLM judge is
skipped too, saving the call). The **synthesis nudge is deliberately
excluded** — it fills a blank/meta turn (an improvement), not a rewrite of
visible content, and capping it could strand a blank reply. Default **1**
(one self-correction per turn; `HEARTH_MAX_REROLLS_PER_TURN`, raise to 2 for
a second grounding pass, 0 to disable in-loop re-rolls). The post-loop
provenance redaction backstop is unaffected, so the highest-risk
`enforce`-tier fabrications stay covered even when the budget blocks a
re-roll. One change, in the runtime that owns the boundary, caps visible
rewriting at one self-correction per turn for every specialist. The deeper,
per-specialist drivers (e.g. Anna's `assess_protest_case` persona↔tool
arg-contract mismatch that spirals her into the ungrounded state) are
tracked separately — the budget bounds the *symptom* roster-wide; the tool
fixes remove the *cause* one specialist at a time.

#### Narrative chat — the persona-level guard opt-out (2026-07-27)

The budget above bounds *how often* a reply gets rewritten. It cannot help a
surface where the guards are the wrong instrument entirely. Every guard asks the
same question — does this specific trace to evidence retrieved THIS turn? —
so a turn whose content is **invented by design** fails that test by
construction, at any threshold.

That is roleplay / collaborative fiction. Observed on Mariah over
2026-07-13..27: 81 guard fires, of which `ghost_promise_guard` matching
present-tense narration (26, nothing factual in any of them) and `fact_critic`
flagging in-fiction nouns as fabrications (30, e.g.
`named_entity:Chief of Staff`). It surfaced as *"as I RP with Mariah, she
regenerates"* rather than as latency because she also sets
`proactive.research_workload: true`, which puts her on the `stream_live` path —
every other chat specialist holds its reply back until the guards pass, so their
re-rolls are invisible; hers emitted `message_superseded` and re-typed the draft
in front of the owner. The guard RATE was roster-wide (281 of 868 replies re-rolled
in that window); only the visibility was hers.

The fix is a top-level persona field, `narrative: true`
([specialist.ts](src/core/specialist.ts)), read by the pure exported
`content_reroll_budget(mode, narrative)`
([specialist_runtime.ts](src/core/specialist_runtime.ts)) — which is now the one
place the budget is decided, replacing the inline ternary. A narrative
**chat** turn gets 0, the same structural zero the voice path already had and for
the same reason.

Three properties worth keeping in mind before extending it:

- **Chat-only.** `mode === 'conversation'` is load-bearing. A narrative
  specialist's *deliberation* turns are real work making real assertions —
  Mariah's stuck-work ledger, her process misses — and keep the full stack.
- **Cheap, not merely quiet.** Zeroing the budget (rather than early-returning
  from `run_reply_guards`) means data-denial, semantic fabricated-save and
  fact-critic skip their LLM judges too: each gates on
  `rerolls_used < max_rerolls` *before* the planner call.
- **Blank turns still recover.** The synthesis nudge never consumed the budget,
  so a narrative turn that comes back empty after tool calls is still re-prompted
  for substance.

Default false — every other persona is byte-identical. Proof:
`bun run smoke:narrative-guards` (policy in both directions, env-override
composition, the persona flag, and the roster's defaults).

#### The persisted-fabrication guard (2026-06-05)

The reply-side critics check the user-facing REPLY. They do not check write-tool
ARGUMENTS — so when `browse_url` spiraled and Ruby answered the gap from memory,
her `record_civic_item("Strategic Trails Plan adopted 2025")` sailed through
ungrounded and into the ledger, where it then *grounded the next turn as fact*
(the self-laundering loop). The guard
(`persisted_fabrication_block` in [specialist_runtime.ts](src/core/specialist_runtime.ts),
both turn loops) closes the write side: before a durable write executes, if a
read-tier tool errored this turn AND the write's args carry specifics absent
from every successful tool result (the same deterministic Layer-1 check the fact
critic uses, via `unsourced_specifics`), the write is blocked with a recovery
nudge. Narrow by construction — a write grounded in a read that DID succeed
passes even if a sibling read failed; deterministic (no LLM, grounding computed
lazily off the hot path); audit `persisted_fabrication_guard`; kill-switch
`HEARTH_PERSIST_GUARD=0`. This is the structural answer to "specialists rely on
past conversation": stop the fabrication from entering the past in the first place.

The same critic has a **deliberation arm**
([src/core/brief_critic.ts](src/core/brief_critic.ts)) for Kate's
morning brief — the dashboard hero card, which previously had *no*
Phase-1 enforcement. The chat retry can't be reused: a deliberation
turn creates proposals via tool calls *during* the turn, so re-running
it would double-create them. Instead the brief is checked at the
envelope level (after the turn, before storage); on findings the model
makes ONE **tool-free** planner call to re-do the brief prose grounded
in the same verified context — no tools fire, so nothing double-fires.
The brief's `ready_for_review` (real proposal ids) is grounded by
construction and skipped; only `noticed` / `attention_today` /
`watching` are checked. Fail-open to the original brief; audit row
`fact_critic` with `surface: 'deliberation_brief'`. `SpecialistRuntime`
exposes a read-only `get llm()` so the deliberation can make the
tool-free call without a full turn.

#### The data-denial guard — fabricated ABSENCE (2026-06-12)

Every guard above polices fabricated *presence* — specifics asserted
without retrieval. The inverse shipped to the owner on 2026-06-12: Astrid
told him a ride had "no heart rate, no calories — distance and duration
only" and speculated about Watch sensor problems, while the readings sat
in her own stores behind read tools she held. No critic could see it —
an absence claim carries no ungrounded specific to flag. The data-denial
guard ([src/core/data_denial.ts](src/core/data_denial.ts), both turn
loops) closes the class at the layer that owns it: a deterministic
recall-biased candidate generator finds denial-shaped sentences (no LLM
on the happy path), then a planner-role judge — given the candidates,
the turn's COMPLETE tool ledger, and the read-tier tools on the surface
— separates honest verified absence (a covering query ran and came back
empty/errored) from UNVERIFIED absence (denial with no backing query),
and only the latter triggers the standard one-retry nudge: call the read
now; state absence only after a query returns empty, and say what you
checked. Complement of the read-failure guard (failed-read-answered-over
vs denial-without-query). Same contracts as its siblings: fail-open
everywhere, conversation-mode only, shared re-roll budget, own latch,
audit row `data_denial_guard`, kill switch `HEARTH_DATA_DENIAL_GUARD=0`.
A paired **data map** prompt section (structural, like the knowledge
floor) names the surface's store-backed read tools — names only, derived
from the registry's risk tiers — so awareness precedes enforcement, for
every future specialist and tool with zero persona edits. Two golden
eval tasks replay the incident class in the nightly gate. Proof:
`bun run smoke:data-denial`.

### The curation quality gate — protecting the corpus grounding reads

Provenance enforcement is only as good as the corpus it grounds against.
If curation files a nav-chrome shell *as* the transportation master plan,
a later grounding check happily treats that garbage as "sourced" — junk
in the durable layer is worse than a transient chat hallucination because
it persists and gets cited forever. Ruby's bootstrap had a ~50% trash
rate (a PDF download interstitial filed as the budget; an OpenData portal
nav-chrome filed as the master plan). The quality gate (#2b, 2026-05-30)
is the input-side defense.

It **judges quality**, it is not a trash-string blacklist (the same
enumerate-failures anti-pattern as the removed redaction backstop).
[src/connectors/capture_quality.ts](src/connectors/capture_quality.ts)
runs two layers: a deterministic structural pre-filter (link-density,
prose-sentence count, length) that hard-accepts clear documents and
hard-rejects clear shells with no model call, and a cheap planner-role
LLM judge for the ambiguous middle band only (document / nav_chrome /
interstitial / paywall / error_page / thin). It **fails open** — any
judge error or absent router resolves to accept, so a judge outage never
halts curation; the gate is only ever stricter on a confident reject.

It lives at the **single choke point** — `save_library_item`
([src/app/routes/library.ts](src/app/routes/library.ts)), which every
library write flows through (the `/upload` + `/url` routes,
`ingest_to_library`, `curate_for_specialist`). One gate there closes the
whole class. The function returns `SavedItem | CaptureRejection`;
TypeScript forces every caller to narrow. A download interstitial that
fronts a real `.pdf` is auto-followed ONCE (fetch the binary, re-convert)
so the real document lands instead of the cover page. Direct user uploads
run a `'minimal'` mode (near-empty check only — a deliberate upload isn't
second-guessed); curation runs `'full'`. The same gate function backs
`scripts/quarantine-library-trash.ts`, which retro-quarantines existing
junk (structural-only, never over-removes) into `_quarantine/` with a
manifest. Audit: `library_capture_rejected`.

The capture gate guards the **text** path; its **binary-file** sibling is
the download integrity gate (2026-06-01,
[src/connectors/download_integrity.ts](src/connectors/download_integrity.ts)),
wired into Cordelia's `download_to_library`. That tool fetches raw bytes
(PDFs, datasets, images), and a server can answer HTTP 200 with a
redirect/landing page, a login wall, or an error stub *in place of* the
file — Ruby's FCGOV budget pull landed a 2 KB HTML stub masquerading as
the PDF. `assess_download_integrity` mirrors the same two-layer, fail-open
shape but keyed to bytes: Layer 1 is a magic-byte sniff — real binary
bytes (`%PDF`, PNG, ZIP/OOXML, …) accept immediately because the
stand-in class is structurally impossible once the bytes *are* the file,
while asked-for-a-binary-but-got-HTML is a type contradiction that rejects
deterministically and surfaces the real file's `follow_url` (reusing
capture_quality's `find_binary_link`) for a retry. Layer 2 is the **intent
judge** — only when the bytes decode as text and the intended type was
text or unspecified, a planner-role call answers "is this the file the
librarian intended, or a stand-in (redirect / login wall / error / nav
shell) returned in its place?" Reading a *valid-but-wrong* binary's
semantic content is out of scope by design (heavyweight; belongs to the
extraction pipeline and the nightly curation pass, not the ingest hot
path). On reject the tool throws an actionable error so Cordelia's
reasoning loop retries against the real link. Smoke:
`bun run smoke:download-integrity`.

### Beatrice's force multipliers

Hand-authoring a binding proposal per finding doesn't scale past
~5 misses. Two tools turn the connector-affordance batch from "42
hand-written proposals" into "5 systemic-target proposals":

- `analyze_systemic_pattern` — diagnostic. For each open
  fab-after-read-failure miss, walks the audit_log back to the
  failing connector in the offending intent_id, aggregates per
  connector, folds in `no-recovery-hint` misses, returns ranked
  systemic targets. Each target carries blast_radius, affected
  specialists, and a `suggested_proposal.args_sketch` shaped for the
  fix tool. Beatrice reads the sketch and ships it.
- `propose_connector_recovery_hint` — templated proposal generator.
  Validates the tool name against the registry, locates the
  connector source, extracts the current `output_schema` snippet,
  writes a binding-proposal markdown citing the ha_get_state
  precedent + blast radius + every cited miss, files a
  `kind='binding_proposal'` proposal. One call per connector instead
  of ~30 min of authoring.
- `analyze_tool_sequence` — raw-signal lens. Reads one specialist's
  `audit_log` directly and reports tool-call SHAPE: duplicate calls,
  failure-guard markers (`ghost_promise_guard` / `same_tool_spiral_exhaust`
  / `blank_turn_fallback`), parallel-vs-sequential ratio, and the hottest
  turns, with quotable `summary` lines. Surfaces behaviors that never
  become a curated `process_miss` — a path-guessing spiral, a turn that
  blew its round budget. Added 2026-06-04.
- `grep_codebase` / `list_codebase` — locate-by-content + directory
  listing across the read allowlist (`src/`, `config/`, `scripts/`,
  `apps/`), paired with `read_codebase_file` (open a known path). All
  three share one path-safety boundary,
  [src/specialists/trainer/codebase_fs.ts](src/specialists/trainer/codebase_fs.ts).
  Added 2026-06-04 after Beatrice burned a 13-call chat turn permuting
  filenames she couldn't find (no grep) and punted to a scheduled
  followup: `read_codebase_file` could open a path but nothing could
  FIND one. "grep before guessing" is now persona-directed.

The Beatrice persona explicitly directs her to pass
`suggested_proposal.args_sketch` through verbatim — improvising a
tool_name from persona text was the documented failure mode on
2026-05-25 validation.

### The fleet map — a live view of this topology (`/app/architecture`)

The topology described above is rendered as a live, auto-refreshing page at
**`/app/architecture`** — boxes → GPU/CPU units → model-serving services →
the roles each backs → a one-line purpose, with a health dot per service.
The backend is `GET /app/api/topology`
([src/app/routes/topology.ts](src/app/routes/topology.ts), mounted in
`create_app_router`): a static `TOPOLOGY` constant (the only place the fleet
shape is authored server-side) merged with **live health** — every service
with a `probe` is HTTP-pinged in parallel (3 s timeout, 5 s cache), tagged
`up` (2xx/connection) / `degraded` (5xx) / `down` (timeout/refused), and the
llama.cpp + vLLM endpoints additionally get a cheap Prometheus `/metrics`
scrape (in-flight requests, tok/s, KV usage). The page
([src/app/client/architecture.html](src/app/client/architecture.html))
inherits `app.css` tokens + dark mode, mirrors the saved theme, polls every
6 s with an "updated Ns ago" ticker, and renders the compose-flows
(chat→9B, hard→35B, voice STT→9B→TTS, RAG, vision, deliberation) as the
"story." It's auth-gated like the rest of `/app` (a logged-in session). The
page bakes a `FALLBACK_BOXES` copy of the structure for instant paint /
offline render — **keep it in sync with the route's `TOPOLOGY`** (each file
notes the other). Probe hosts match `llm-roles.yaml` (the LLM host via
`host.docker.internal`, forza via `192.168.0.188`).

### Closed-loop self-apply for bounded-safe edits

A binding proposal sitting in the queue waiting for "yes, fine" is a
waste of trust on changes that are structurally bounded — adding an
existing registered tool to a specialist's chat surface, granting a
read-only capability from a known-safe set. Beatrice's
[apply_low_risk_fix](src/specialists/trainer/tools/apply_low_risk_fix.ts)
collapses that wait. It accepts only these bounded patch families:

1. **`add_tool_to_chat_surface` / `add_tool_to_deliberation_surface`** —
   append a tool name to a specialist's
   `proactive.tools_for_chat` or `tools_for_deliberation` array.
   Validates: tool exists in the registry, target specialist already
   has the tool's `required_capabilities`. Refuses unfulfillable
   exposures so the model isn't shown a tool that will fail at call
   time.
2. **`grant_capability`** — set `<specialist>.capabilities.<token>:
   true`. Refuses anything outside the hard-coded
   `AUTO_APPLY_SAFE_CAPABILITIES` set (read-only + consult primitives
   today: read_vault, read_calendar, read_inbox, query_web,
   consult_deep_model, etc.). Never write_*/send_*/spend_*/web_action —
   those still queue through `write_binding_proposal` because the
   side-effect surface needs Jasper's eyes.
3. **`enable_optin`** (added 2026-06-04) — flip an additive `proactive`
   boolean ON: `research_workload`, `wake_on_flag`,
   `think_in_deliberation`, `intake_captures`. OFF→ON only, never
   narrowing; the enum IS the safe-set. Deliberately EXCLUDED:
   `trusted_sources` (changes what a specialist trusts as a source) and
   `chat_addendum`/`deliberation_addendum` (injected PROMPT text — the
   exact thing `propose_persona_tuning` + human review exist to gate).
   Those stay on `write_binding_proposal`.

Edits go through the yaml Document API so comments are preserved on
round-trip. The write triggers SpecialistRegistry's existing chokidar
watcher — the change is live in the next turn with no orchestrator
restart. Every apply audits the YAML diff (before + after excerpt)
so a future `revert_low_risk_fix(audit_id)` can invert. Beatrice is
the only specialist granted `auto_apply_low_risk`; granting it
elsewhere would defeat the gate.

The narrowness is deliberate. Self-apply is for the obvious subset
where review adds no information; everything else routes through the
binding-proposal queue. As that scope proves out, the safe-set can
extend — but the contract that "code changes always queue, YAML
field touches on existing identifiers may self-apply" is the line.

### Directed deliberation — owner-handed on-demand builds

`apply_low_risk_fix` (above) and the audit loop are how Beatrice acts
*autonomously*. A directed task is how the owner hands her a *specific*
job. The default deliberation pass reasons over what's accumulated
(inbox, misses, vault deltas) and decides what's worth doing; that's the
wrong shape for "build me tool X now" — the standing prelude steers her
toward her audit sweep, and (the load-bearing detail)
`propose_code_change` is curated off both her standing tool surfaces, so
she can't author code even if she wanted to.

A `DirectedTask` (`{ instruction, tools?, max_tokens?, max_tool_rounds?,
think? }`, carried on `fire_deliberation`'s owner-gated body) inverts
that for one pass: the prelude is replaced by a strong directive built
from `instruction`, and the tool surface is replaced by `tools` via a
per-turn `SpecialistTurnInput.tools_override` (which
`_curate_tools_for_turn` honors ahead of the YAML-curated list, still
capability-gated by the specialist's grants). This is the seam that
surfaces a *granted-but-curated-out* tool — passing
`tools: ["propose_code_change"]` is what makes her code-authoring tool
visible for the build. It runs on the same 80B deliberation tier and
lands in the same gate: `propose_code_change` → Kate `review_change` →
owner-tier `decide` → `merge_approved_change`. Nothing auto-merges; the
directive only changes what she's pointed at, not the review/merge
cordon.

Two hardenings from the 2026-08-10/11 postmortem live on this seam. A
directed pass sizes its own tool-round budget — `max_tool_rounds`, else
`directed_tool_rounds_default()` (env `HEARTH_DIRECTED_TOOL_ROUNDS`, 30)
— instead of inheriting the specialist's chat-sized ceiling (three
builds died at exactly 15/15 then 20/20; standing deliberation passes
have their own YAML slot-scope, `max_tool_rounds_deliberation`). And
the directive is a self-contained work order: the payload + rationale +
binding-proposal markdown are inlined into `directed_build_instruction`
(the proposal record is terminal — `acknowledged` — by fire time, so
"re-read the proposal" was structurally impossible for the build agent;
`read_proposal_by_id` is the general read for anything past the inline
caps). Directed failures are LOUD: blank turn, ceiling exhaustion, a
thrown pass, and journal abandonment each file a high-severity
process_miss keyed per-directive, and the second identical failed tool
call ends the pass instead of burning the remaining rounds.

The mechanism is general (it also drives Kate's review and a one-shot
`scrum_groom` run), but the design choice worth remembering is that the
directive is the *only* new authority — the safety properties are
entirely inherited from the existing change pipeline. The pipeline runs
git inside the orchestrator container, so it depends on `git` being in
the image and the Gitea/GitHub credentials being container-reachable and
repo-scoped (see "Beatrice's change pipeline runs in-container" in
the private dev log — these were latently broken until 2026-06-06, which is why
`beatrice_changes` had no rows before then).

### The deterministic check gate — compile-correctness is the machine's

Until 2026-06-06 there was no automated build check anywhere in the
self-modification loop: Beatrice could author code that doesn't compile,
Kate (an LLM reading the diff) could approve it from the diff alone, and
it would merge — a human running `tsc` was the only thing catching it.
That made the autonomy untrustworthy. The fix adds a deterministic layer
*beneath* Kate's judgment, at the layer that owns the problem.

`open_change_pr` now runs `run_checks(worktree_path, files_changed)`
inside the committed worktree **before the push**: `bunx tsc --noEmit`
(when any changed file is `.ts`/`.tsx`) + `bun run guard`. A git worktree
has no `node_modules`, so the tsc step symlinks the main repo's
`node_modules` in first — Beatrice can't change deps (`package.json` is
outside the path allowlist `src/,config/,scripts/,apps/`), so the main
tree is always the valid one to check against, and the committed
`tsconfig.json` type-checks the whole project (a change that breaks a
consumer anywhere is caught). The placement is deliberate: checks run
*before* the push, so a red change throws `ChecksFailedError` (carrying
the truncated tsc/guard output) and **never becomes a PR at all** — the
calling tool returns the error to Beatrice, who fixes + re-files cheaply
via `propose_code_edit`. A green verdict rides on `OpenChangeResult` onto
the `beatrice_changes.checks_passed`/`checks_summary` columns.

This splits the review cleanly: **compile-correctness is the machine's
gate; design-correctness is Kate's.** `review_change` hard-refuses an
`approve` on a `checks_passed=false` row (defense-in-depth — a red change
throws before a record even exists, so in practice the row is always
green or null-legacy), and the Code Shop card surfaces a ✅/⛔ badge so the
owner sees the verdict before approving. Config-only YAML edits skip tsc
(irrelevant) but still run guard. The gate is a correctness/standard
check, **not** crash-prevention: bun runs TypeScript by stripping types,
so a tsc error doesn't crash the orchestrator at boot — the actual boot-
crash class (a duplicate capability token, a CREATE INDEX referencing a
column before its ALTER) is invisible to tsc, and a TEST_MODE boot check
is the open Layer-1.5 follow-up.

Since 2026-06-10 the gate is also a STANDARDS gate, not just a compile
gate: `run_checks` fails a change that ADDS a tool/connector file
without touching a smoke in the same change (the repo's own
test-with-feature rule made mechanical — "checks green" has to mean
more than "it compiles" before merge autonomy can rise), and appends
deterministic review notes (specialist-YAML changed → the
capability-visibility checklist; new tool → capability/recovery-field/
description checks) so Kate's LLM judgment is reserved for design
intent.

### Merge recovery — the owner's approval always lands or wakes someone (2026-06-11)

The merge dispatch used to have one move: ask Gitea to merge the PR. A
branch that went stale between Kate's review and the owner's approval
(main moved underneath) came back 405-not-mergeable and the row parked
at `merge_failed` — silently. Both Maggie tool-surface changes hit
exactly this; one sat stuck for two days after the owner approved it.
The fix is a recovery ladder (`merge_recovery.ts`), run only inside the
dispatch-only `merge_approved_change`, cheapest rung first:

1. **Direct merge** — unchanged happy path.
2. **Update branch + retry** — Gitea's own "update branch from base";
   git's 3-way merge is the correctness proof for the
   stale-but-not-conflicting class.
3. **Re-land from stored inputs** — `open_change_pr` now persists the
   change's verbatim authoring inputs (`change_inputs_json`, additive
   column), and `plan_reland` deterministically re-classifies them
   against current origin/main: an edit whose exact-unique `old_string`
   still matches re-applies semantically even where git's textual merge
   conflicts; a full file only when absent or byte-identical (a moved
   full file would clobber later changes — that parks). A re-land opens
   a fresh branch through the FULL pipeline (checks re-run against the
   new base), supersedes the conflicted row, and carries Kate's verdict
   forward — sanctioned precisely because the inputs are byte-identical
   to what she approved. `already_applied` (the content was hand-landed)
   records the row as merged instead of failing forever.
4. **Park + waking flag** — terminal failure still marks `merge_failed`,
   but now also pushes a high-severity flag to Beatrice naming the
   change and the re-author path. Never silent.

The not-mergeable case is a typed `PrNotMergeableError`, so the ladder
only engages for recoverable failures — a missing token or network error
parks immediately rather than thrashing. None of the four merge gates
moved: recovery runs post-Kate-approval, post-owner-approval, and a
carried verdict requires identical inputs plus a green re-check.

### The workbench — iteration before the gates (2026-06-10)

One-shot authoring was the autonomy ceiling: the pipeline applied a
finished change and a red check bounced the WHOLE attempt back as an
error blob, which a small model handles badly. The workbench
(`src/specialists/trainer/workbench.ts` + the eight `workbench_*`
tools) gives Beatrice a persistent worktree session: write/edit
(surgical edits applied against her CURRENT state), `workbench_check`
returning STRUCTURED tsc errors (file, line, code, a marked frame —
the shape small models act on), optionally one self-contained smoke,
then `workbench_submit`, which feeds the accumulated files through the
unchanged `open_change_pr` → review → merge gates. The workbench adds
iteration BEFORE the gates, never a path around them — same
`write_codebase_pr` capability, same path allowlist, red submits
preserve the session. Supporting cast: `scaffold_code` (exact-idiom
skeletons + registration checklists), `repo_map` + outline/ranged
reads (navigate by symbol, not by paging files), and the
`Tool.volatile` contract (state-dependent tools bypass the runtime's
per-turn duplicate-call cache so a post-fix re-check actually
recompiles). Intake is spec-first: Kate's `file_build_request` turns
the owner's ask into acceptance criteria Beatrice codes against, and
her review verdicts append BUILD LESSONs to Beatrice's memory file —
the loop learns from its own reviews.

### Behavioral evals — the regression gate under autonomy (2026-06-10)

Smokes prove plumbing; the golden-task harness (`src/core/evals`)
proves BEHAVIOR. Each task replays a curated past failure (fixture
tool results, throwaway vault/db, the LIVE personas and LIVE model)
and scores deterministic assertions — tools called, retry counts,
honesty/grounding markers, forbidden fabrication shapes. Results land
in `eval_runs`; a pass→fail transition files a high-severity
`eval:<task_id>` process_miss into Mariah's ledger, so a persona edit
or model swap that regresses a hard-won behavior surfaces as closed-
loop work by morning instead of as a repeat incident. Nightly via the
scheduler (03:15); on demand after any persona/prompt/model change.
Autonomy-tier increases now REQUIRE a green eval streak — the measurement
that made "let her merge more on her own" a decision rather than a hope is
wired into the graduation gate itself (next section). Mariah's
`program_dashboard` surfaces the per-specialist pass-rate (`eval_health`) so
the held-by-regression specialists read at a glance.

### Authenticity AND eval-health gate autonomy graduation

`config/autonomy.yaml` carries `min_authenticity_score_for_tier2b/2c/3`
(defaults 70/85/90). When a category signature would otherwise
qualify for graduation by approval count, `proposals.ts:
check_graduation_candidates()` looks up the signature's owning
specialist's current authenticity score from `authenticity_scores`
and holds the candidate if the score is below threshold. Approvals
still accumulate — the candidate isn't lost, just held until the
score recovers. New hires with no scan history pass through (don't
permanently block before Mariah's first scan).

The social mechanism: a specialist who fabricates gets a red trust
meter in `/app`'s topbar AND can't earn more autonomy until they
clean up. The path back up is the same closed loop above —
Beatrice ships connector fixes, the next authenticity scan sees
fewer fabrication-shaped findings, the score climbs.

**A sibling eval-health gate (2026-06-14) runs alongside the authenticity
floor.** `config/autonomy.yaml` carries `require_eval_health_for_graduation`
(default true) + `eval_health_window_days` (14). The same
`check_graduation_candidates()` holds a candidate whose owning specialist has
a STANDING behavioral regression — the most recent run, within the window, of
ANY golden eval task it owns FAILED (`ProposalsStore.eval_health_by_specialist`
over `eval_runs`). A specialist fabricating/denying in the regression suite
shouldn't earn more autonomy until the eval goes green; the pass→fail miss
Beatrice is already working is the exact path back up. It is **fail-open**,
mirroring the authenticity floor: a specialist with NO eval runs in the window
is "unknown" and passes — a brand-new specialist isn't blocked before the
first nightly run scores it. Approvals keep accumulating below the gate; the
candidate is held, not lost. Mariah's `program_dashboard` shows the pass-rate
(`eval_health`), the `held_by_eval_count` per specialist, and a
`blocked_by_eval` flag on each near-ready signature so the held door is
visible next to the approval count.

### The human gates remain — for everything but bounded-safe YAML

Jasper approves the proposal. Jasper merges the PR. Those two gates
are deliberate and permanent for **code changes** and **side-effect
capability grants**. The closed-loop self-apply layer above carves
out a narrow exception: bounded-safe YAML edits to
`config/specialists/*.yaml` ship without Jasper in the loop, because
the contract makes review redundant — the tool refuses anything that
could escalate privilege, introduce a new attack surface, or invoke
new code. Every other class of fix still routes through the
proposal queue + PR gate.

The shape of "the system improves itself" the project wants: it
finds its own gaps, traces them to the right layer, applies the
narrow ones itself, and writes everything else as a reviewable
proposal — but a person still says yes to anything that touches
code or side effects.

### The expertise-curation complement — Beatrice judges, Cordelia curates

Roster maintenance above watches *behavior and configuration* (did a
specialist fail, drift, fabricate, or carry a misshapen tool surface).
A parallel seam watches *expertise* — is a specialist actually
world-class in their domain, or brochure-level. The decision (2026-06-03)
is to keep the same critic/curator split the roster loop already uses:
**Beatrice judges; Cordelia curates.** Cordelia is the household's
Master Librarian and already holds the cross-shelf curation engine
(`curate_for_specialist`, `specialist_bootstrap`, `wake_on_flag`); she
becomes the authority on *the craft of expertise + how to close a gap*,
while Beatrice's audit (a future `audit_specialist_expertise` lens,
modeled on `audit_connector_affordances`) emits the `expertise_gap`
finding that flags her.

Two of the three pieces shipped first as a standalone PR (15c A+B,
2026-06-03):

- **The Specialist Craft shelf** (`Knowledge/Cordelia/craft/`, seeded by
  `scripts/seed-cordelia-craft.ts`) — the reusable meta-knowledge of what
  makes any specialist excellent, distilled into a 9-axis rubric
  (domain-coverage completeness, source-tier discipline, grounded-with-
  falsifier claims, confirmed/announced/leaked labeling, the two-layer
  scan→extract→synthesize + own-store architecture, capability-envelope
  swimlanes, pre-launch/leak signal, recurring-question flags, demand-side
  persona/ICP/UCP). The first worked example it generalizes is the manual
  Kristi build. This shelf *is* the thing Cordelia is an expert in.
- **`read_specialist_spec`** — a read tool (gated by the same-named
  capability, Cordelia only) that gives her the specialist's DEFINITION
  (persona / tools / `trusted_sources` / `knowledge_scope` / capabilities)
  from the live registry, so an audit can read the spec, not just the
  shelf. Returns an `available_specialists` recovery hint on an unknown id
  (the connector affordance pattern).

The third piece shipped 2026-06-03 (15c part C). **`audit_specialist_expertise`**
(`src/specialists/trainer/tools/`) is Beatrice's expertise lens — modeled on
Mariah's registry-walking `audit_connector_affordances` crossed with the
`fact_critic` planner-judge. It walks every `deepen:true` specialist (opt-in via a
new `SpecialistConfigSchema.deepen` flag), gathers machine signals (source-tier
counts, library shelf size, tool-surface size) and has the planner LLM score them
against the 9-axis craft rubric, then per gap opens an `expertise_gap`
process_miss AND flags Cordelia — one consolidated wake-flag per specialist — over
the **existing** `flag_cordelia` / `wake_on_flag` rails (no new wakeup machinery;
same path as on-hire bootstrap). Cordelia's `deliberation_addendum` routes a
`shelf` gap to `curate_for_specialist` and a `spec` gap to a `propose_action` for
Jasper. It's FAIL-OPEN (a judge outage never fabricates a gap), budget-bounded
(opt-in scope + a 3-flag/run cap protect Cordelia's ≤3-shelves/pass), scheduled as
Beatrice's `05:30` daily background_job, and auto-closes through
`verify_fix_landed` (a new `expertise` → scan entry in its `PATTERN_TO_SCAN`).
Composes with — but does not require — Beatrice's Pass 1/2 (a `mission:` field
enriches the judge when present). Design note:
`docs/design-cordelia-specialist-excellence.md`.

### Research commissions — Cordelia's durable deep-research engine (2026-06-11)

The acquisition tools before this were all single-shot: `acquire_knowledge`
closes ONE measured gap (one search, roster-only, ≤5 docs),
`curate_for_specialist` broadens an existing shelf over its Tier-1 manifest,
`scout_sources` builds the roster via proposals. None of them could take
"make Astrid authoritative on bicycle + e-bike repair, here's the Trek
service manual" — a whole missing DOMAIN, with seed documents, needing
decomposition and more wall-clock than any one tool call can hold.

A **research commission** is that job, made durable. `commission_research`
(brief + target specialist + optional `seed_urls` + depth) files a row in
the `research_commissions` table and kicks a detached in-process run; the
runner (`src/specialists/cordelia/research_runner.ts`) advances the row
through phases in deadline-bounded slices, persisting after every shelved
document so restarts resume mid-subtopic:

- **plan** — a planner-role LLM decomposes the brief into ≤5 (standard) /
  ≤8 (deep) subtopics with human-phrased queries, manufacturer/official
  documentation first. Fail-open: the brief itself becomes the single
  subtopic.
- **acquire** — seeds first: owner-handed documents fetch binary-aware
  (a URL whose *path* ends `.pdf`/`.docx` streams bytes with magic-byte
  sniffing — an HTML login wall masquerading as a PDF is rejected — and
  rides the inbox converter, so the raw PDF lands as a vault attachment
  and the extracted text chunks + embeds), shelved Tier 1 with quality
  gate `'minimal'` (a hand-delivered manual is pre-trusted, same posture
  as `add_trusted_source`). Then per-subtopic search fan-out: in-roster
  candidates shelve at manifest/subscription tier; an out-of-roster
  DOMAIN goes to the scout-grade source judge — **a commission is
  owner-initiated work, so a judge-cleared domain (avg ≥ 0.6 across
  authority/independence/freshness/fit) may shelve directly**, with the
  verdict cached in commission state and the quality gate still applied
  per document. Judge outage degrades to roster-only WITHOUT advancing
  past the subtopic (no silent "completion" of unworked subtopics — the
  same fail-safe shape as a search-backend outage). Denied domains never
  participate.
- **synthesize** — a repository-guide note (per-subtopic doc map with
  wrapper summaries + an LLM coverage/gaps overview, fail-open to
  deterministic-only) shelves alongside the documents, the target
  specialist gets an inbox flag (knowledge-floor surfaces it on their
  next turn), and judge-cleared `propose: true` domains that actually
  contributed file `trusted_source_addition` proposals (≤3, same payload
  contract + signature anchor as scout, so the standing roster catches
  up through the owner gate).

Three tools, one capability (`run_research_commissions`, Cordelia only):
`commission_research` and `list_research_commissions` ride her chat +
deliberation surfaces; `advance_research_commissions` is job-only — the
03:20 `research_commission_sweep` background job is the crash-recovery /
retry path behind the detached kick (a no-progress slice breaks the
detached loop rather than hot-looping; the sweep retries nightly).
Re-filing an open commission collapses to the existing row (the
proposals-inflow re-fire contract); friend-tier callers are refused; a
non-owner household requester's repository cordons `private_to` them all
the way through (wrapper frontmatter, guide note, completion flag's
`originating_user_id`). Kill switch `HEARTH_RESEARCH_COMMISSIONS=0`;
three consecutive errored slices mark the commission `failed` with the
partial shelf intact. Proof: `bun run smoke:research` (42 checks,
including a real minimal PDF through the unpdf seed path).

## Vault as source of truth

The user's knowledge lives in `~/vault-friday/` as a tree of markdown
files with YAML frontmatter. Obsidian-readable, vim-editable, git-
ignorable.

### Why a markdown vault

Considered and rejected: a database (Postgres or SQLite-only), a
SaaS knowledge tool (Notion, Obsidian Sync), a vector DB as primary
store.

Why markdown wins:

- **Portability.** The user's personal data, in plain text, on local
  disk. No vendor risk. No format obsolescence (markdown will
  outlive most of us).
- **Longevity.** A file is the most durable data structure we have.
  If Hearth disappears tomorrow, the vault remains useful in
  Obsidian.
- **Human-curatable.** The user opens `People/Alex.md` and edits.
  No API, no UI, no migration. This matters for trust: the user
  always knows the system can be inspected and fixed by hand.
- **git-friendly.** Diffable history. Branchable for experiments.
  Backupable to any git host.
- **Cheap.** Reading a markdown file is essentially free. Writing
  one is essentially free. The "database" cost is zero.

### Why SQLite is an index, not authority

SQLite gives us fast structured queries — "all people with
relationship=family", "decisions in the last month", "wikilinks to
this note." But the values in SQLite are **derived** from frontmatter
in the vault. If they disagree, the vault wins; the index is rebuilt.

This is what `bun run ingestor:rebuild` is for: truncate the
projection tables, re-walk the vault, re-project. The audit log
survives the rebuild (it's its own table, not a projection).

**The RETRIEVAL index is a projection too, and teardown has to say so.**
`chunks_fts` + `chunk_embeddings` are derived from a note's body exactly as
`clippings` is derived from its frontmatter, so a delete has to clear all
three or the vault stops being authoritative in the one direction that
matters: a note gone from disk whose chunks and vectors survive is still
returned by FTS and by vector RAG, and deleted content keeps grounding
turns. `unproject_note` clears them (2026-07-30 — it previously cleared only
the projected row + graph edges). Two consequences worth holding: the
teardown is the ENTIRE teardown for an AUXILIARY type (a `_synthesis/`
note projects no row at all, so a projection-only unproject was a complete
no-op for it), and a re-index is clear-then-write on both tables — a path
that can't write fresh vectors clears the stale ones rather than leaving a
vector pointing at a body that no longer says it (missing vectors are
recoverable via `backfill:embeddings`; wrong ones are not). Orphan-hunting
is by FILE EXISTENCE, never by "has no projected row" — most indexed notes
legitimately have none.

### Vault edit conflicts

If the user edits `People/Alex.md` in Obsidian while the orchestrator
is also writing to it (via `upsert_person_note`), the file system is
the synchronization point. Whoever writes last wins. The ingestor
will pick up the final state within ~500 ms either way.

This is acceptable because in practice the two don't race — the user
edits when conversation pauses, and the orchestrator writes when
conversation is active. If we ever hit a real race, the answer is
not a database; the answer is per-file mutex-via-flock or git-style
optimistic-merge. Both are forward-looking.

## Knowledge namespaces and scope filtering

Post-Prompt 6a, the vault grows a `Knowledge/` tree:

```
~/vault-friday/
├── People/                  shared across all specialists
├── Journal/                 shared
├── Decisions/               shared
├── Inbox/                   shared
└── Knowledge/
    ├── Kate/                Chief of Staff's curated library
    ├── Vivian/              Finance SME
    ├── Cassandra/           Home/HA SME
    └── ...                  one folder per specialist
```

Each specialist's config declares `knowledge_scope`: a list of vault
paths the specialist can read from when answering. The retrieval
pipeline filters candidate chunks by scope before reranking.

### Hybrid retrieval — FTS + vector + RRF + rerank (RAG Pass 7)

Retrieval was keyword/FTS5 only for a long time; the `embeddings` and
`reranker` roles were declared but never invoked. Pass 7 wired a real
vector path WITHOUT disturbing the FTS one. The shape:

- **Lexical** — `MemoryClient.retrieve_scoped_chunks` (FTS5 MATCH over
  `chunks_fts`, AND-then-OR) stays exactly as it was, synchronous, with
  many callers. It's the fallback AND half the fusion.
- **Vector** — `MemoryClient.vector_search` brute-force cosines a query
  embedding against the `chunk_embeddings` BLOB table. Same SQLite, no new
  store (see "No vector DB as a service").
- **Fusion** — `retrieve_hybrid` ([src/core/retrieval.ts](src/core/retrieval.ts))
  combines the two ranked lists via Reciprocal Rank Fusion (a chunk both
  paths rank highly floats up), then reranks the fused pool with a
  cross-encoder.
- **The two paths share one cordon.** `vector_search` and the FTS path both
  go through `MemoryClient._chunk_gates` (scope glob + `private_to`
  visibility + trust/title meta), so the per-user data cordon holds no
  matter which path surfaced a chunk — the owner has no god-view over a
  vector hit either.

Embeddings are written best-effort at library ingest and reconciled by
`backfill:embeddings`. The whole vector path is **gated by
`HEARTH_RAG_VECTOR` + a live embeddings endpoint**; off → FTS-only,
byte-identical to before. Fail-open throughout: a down embeddings server
degrades to FTS, never blocks a turn. The embeddings+rerank server runs on
the **A4000** (freed by moving the live/librarian tier to forza — see the
Spark partition in [docs/SPARK_BRINGUP.md](docs/SPARK_BRINGUP.md)), host-local
to the orchestrator, never the tailnet. This is the highest-ROI accuracy
lever for a RAG-first system: better retrieval beats parameter count for
grounded answers.

**Turn-start auto-RAG runs on the chat/`live` tier (2026-06-05).** The
turn-start retrieval in `specialist_runtime.ts` keys on the conversational
prompt mode, NOT the inference tier — a `live`-tier chat turn retrieves the
same as a deep turn. Until 2026-06-05 the gate skipped retrieval whenever
`effective_role === 'live'` (bolted onto the voice TTFB skip), which silently
left ALL interactive chat ungrounded once chat moved onto the live tier: the
grounding-rule's "retrieved library section" was always empty and the
fact-critic had no retrieved evidence to verify against (a primary source of
false-positive re-rolls / the "specialist rewrites itself" symptom). Now
skipped only for voice (TTFB), scopeless specialists, or a
per-specialist `auto_rag: false` opt-out (latency-critical specialists whose
value is real-time, e.g. Astrid mid-workout — they keep the explicit
`search_library` tool). `live` is an ENDPOINT choice, never a reason to leave
a specialist ungrounded.

**Chat grounding packs — structured-data grounding (Phase 1b, 2026-06-05).**
Auto-RAG grounds a turn in the prose LIBRARY (chunks). But some specialists
answer from STRUCTURED tables RAG-over-prose never touches — Ruby's civic ledger,
Anna's assessor parcel cache, Kristi's SKU registry. `src/core/grounding_packs.ts`
adds a per-specialist `specialist_id → pack` registry: a cheap, read-only,
fail-open, topic-gated pre-turn fetch of the specialist's authoritative records
relevant to the message, injected BOTH into the system prompt and into
`GroundingParts.verified` (so the provenance check + fact critic count it as
grounding — the same slot the brief's domain packs use). This is the chat-side
analogue of the deliberation `DomainPack` mechanism (`src/core/domain_packs/`),
built on the existing `verified` seam rather than a parallel one. Conversation
turns only; logs a `grounding_pack` audit row when it fires. (Voice was briefly
included 2026-06-06 to pre-inject the calendar, reverted 2026-06-07: on voice the
pack was redundant with the tool call `voice_style` already forces, and the
prefill mattered more — see the voice-prompt-slimming ship.)

**Working memory — the fused household situational block (2026-07-01).** The
signal pipelines each fill their store (mail triage, person observations +
synthesis, calendar life_events, household goods, proposals) and the morning
scan jobs reason over them pairwise — but at answer time the model saw only
today's calendar + RAG; every other signal was tool-gated on the flaky
interactive tier. `src/core/working_memory.ts` is the read-side convergence
layer: `compose_working_memory` does five independent, fail-open, capped,
CORDONED reads over the existing stores (no new write path — the stores ARE
the stream) and renders one ~500–800-token block. Injection reuses the two
existing seams: chat rides the grounding-pack verified channel (per-specialist
`proactive.situational_context` YAML opt-in — Kate first), deliberation gets a
`situational_signals` ctx field composed for the pass's recipient (rendered
markdown, not nested JSON — the Qwen extraction constraint). Voice is
deliberately excluded (lean-prefill surface). The cordon is the stores' own:
`note_visible_to_caller` post-filter for mail, `visible_to` for proposals,
caller-threaded reads for life_events/goods; a friend-tier caller gets no
people section; the owner has no god-view. DARK behind
`HEARTH_WORKING_MEMORY=1`; proof `bun run smoke:working-memory`.

### Why folders, not tags

Folders are visible, ordered, easy to drag-into in Obsidian. Tags
are flexible but invisible — the user can't easily see what
Cassandra "knows." With folders, the user audits a specialist's
expertise by browsing their `Knowledge/<Specialist>/` directory.
Curation is dragging files in or out.

### Why per-specialist namespaces, not a single shared library

A shared library would let any specialist surface anything, which
sounds nice but produces noisy retrievals — Vivian answering a
question about HA logs because the embeddings looked plausible. The
narrower scope per specialist trades flexibility for precision, and
precision matters when the system is going to act on what it
retrieves.

Cross-specialist context still works via the planner: if Vivian
needs context that lives in Kate's namespace, the planner can call
Kate's "introduce_context" tool (post-6c). This is rare by design.

### Per-user namespaces — Brigid, Astrid

Some specialists work on a single shared concern across the
household — Iris owns one EV per household, Cassandra watches one
network. Their `knowledge_scope` is a single `Knowledge/<Name>/**`
glob and that's fine. But specialists whose work is **inherently
individual** — what someone eats, how someone trains, what someone's
goals are — need a per-user partition so each household member's
data doesn't commingle in a single file.

The convention (prototyped in Brigid, generalized with Astrid):

```
~/vault-friday/
├── Knowledge/
│   └── Brigid/
│       └── memory.md             ← household-level / shared
└── users/
    ├── jasper/
    │   ├── brigid/
    │   │   ├── backlog.md
    │   │   └── plans/<date>.md
    │   └── astrid/
    │       ├── profile.md
    │       ├── observations.md
    │       ├── coaching-log.md
    │       └── sessions/<date>-<slug>.md
    └── sam/
        ├── brigid/
        └── astrid/
```

`Knowledge/<Name>/` stays for what's hers (working philosophy,
cross-user observations). `users/<user_id>/<specialist>/` is the
per-user heap where everything specific to that person lives.
`knowledge_scope` lists both globs (`Knowledge/Brigid/**` and
`users/*/brigid/**`) so the specialist reads from any user's files
when answering THAT user — and only that user, because tier
discretion + per_user_tracking gate cross-user reads.

The pattern only makes sense for individual-by-design concerns. Don't
shard Kate's calendar context per-user (the household has one
calendar); don't shard Cassandra's network rules per-user (one
network). Shard when the underlying reality is per-person — diets,
training, goals, preferences — and the same specialist would
otherwise have to manage one document with N people's data
interleaved.

## The unified UI

Status: **implemented in Prompt 6b** at `/app`. Lives in [src/app/](src/app/) — a Hono sub-router that serves a single-page shell ([client/index.html](src/app/client/index.html), `app.css`, `app.js`) plus the `/app/api/*` routes specific to it (avatars, library, search, chat, hire). Mounts alongside the existing `/api/*` routes from 6a; the UI uses both.

Design decisions:

- **Conversational, not dashboard-y.** The default surface is bubbles + a composer. No tables, no JSON, no audit grids. The "show details" toggle in Settings → Behavior is an escape valve for the curious; it stays OFF by default. The chief-of-staff metaphor only works if the user feels they're talking with staff, not wielding tools.
- **Three-pane on desktop, tabbed on mobile.** Single layout, single codebase. Mobile is a first-class citizen — touch targets, swipe-able rows, no hover-required interactions, safe-area-aware. PWA-installable so it lives on the home screen on phones.
- **Per-specialist threads with independent histories.** Each specialist has their own conversation stream. Switching specialists in the rail is fast and free (no LLM round-trip). The model talks to the user as one chosen voice at a time; cross-pollination happens via `consult_specialist`, surfaced inline as a pill so the user sees who Kate (or whoever) deferred to.
- **Library drag-drop scoped per specialist.** Vivian's library is not Eleanor's library. Dropping a PDF on Vivian's panel writes to `Knowledge/Vivian/library/` with `specialist_scope: vivian` in frontmatter, and the extracted body is chunked into `chunks_fts` immediately so the unified search finds it today. Embeddings + RRF (Pass 7) build on the same scope.
- **Proposals first-class in three places.** Inline in the conversation where they were created (cards under the specialist's message), summarized in Kate's right rail ("Awaiting your nod"), and the full queue overlay (Cmd/Ctrl+⌘K from anywhere). Decisions roundtrip via `POST /api/proposals/:id/decide`; the SSE bus fans-out the update to every open browser.
- **SSE not WebSockets.** One direction (server → browser), the only direction we need. Reconnect-with-backoff handles flaky LAN proxies; a 25-second heartbeat keeps the connection alive through anything that drops idle TCP. No WebSocket complexity until something requires bidirectional streaming.
- **Hiring is a five-step modal, Kate-assisted.** The user fills in identity / domain / capabilities / cadence; Kate (the "HR" specialist) drafts the persona text in the chosen voice family from the user's description. The user edits and hires. Hire writes the YAML atomically and triggers a registry reload — the specialist is live in seconds with no restart. Send/spend/web-action capabilities are hard-locked OFF for UI hires (edit YAML to enable) as a safety rail.

What the UI explicitly does NOT do (yet):

- No voice transcription (the mic button is stubbed; Whisper integration is later).
- No "let go" UI for firing a specialist (the DELETE route exists; the modal is later).
- No native iOS app (PWA is sufficient; native is its own effort).
- No avatar generation via vision models (user drops a PNG into `Knowledge/<Name>/avatar.png`).

## The library / file manager

Status: **implemented 2026-05-22** at `/files`. Lives in
[src/library/](src/library/) — a Hono sub-router mounted by the
orchestrator the way `/inbox` is.

Cordelia, the Master Librarian, can already file cleaned *text* onto a
specialist's vault shelf for retrieval (`ingest_to_library`). The
library adds the other half: fetching actual *files* — a PDF, a
dataset, an installer, an image — and putting them somewhere Jasper can
browse and grab them.

### Why a store outside the vault

The files live at `~/hearth-library/` (env `HEARTH_LIBRARY_ROOT`),
**not** in `~/vault-friday/`. The vault is markdown — human-readable,
git-diffable, meant to stay legible for years (see "Why a markdown
vault"). A 400 MB ISO or a binary dataset is none of those things.
Putting binaries in the vault would bloat it, wreck its git story, and
violate the "anything the user reads or edits in five years is
markdown" principle. So the library is its own tree.

### Filesystem authoritative, SQLite as index

The store has the same two-source shape as the vault and its SQLite
projection, for the same reason. The **filesystem** is authoritative
for what files exist — Jasper can drop a file into
`~/hearth-library/Documents/` by hand and it appears. The
`library_files` **table** is a metadata index: source URL, description,
tags, who fetched a file, and a stable `lib_` id — the things a
directory entry cannot carry. `LibraryStore.list()` reconciles the two
on every call, so the index self-heals and never shows a ghost or hides
a real file. Content search is deliberately not here yet — filename and
tag/metadata search only; full-text is a later add.

### Fixed categories, free sub-foldering

Seven top-level buckets — `Documents/ Media/ Software/ Archives/
Reference/ Datasets/ Other/` — are structural and fixed. Within each,
Cordelia (and Jasper) create subfolders freely (`Reference/Ioniq-5/`,
`Software/ROCm/`). Structured enough to stay navigable, adaptive enough
to organize real material. The category roots cannot be renamed,
moved, or deleted.

### The flow

Jasper asks Cordelia to find something → she searches (`web_search`) and
vets candidates (`web_fetch_clean`) → she downloads the winner with
`download_to_library` into the right category → he browses and grabs it
at `/files`. `download_to_library` is `write_internal` risk, gated by
the `download_files` capability — Cordelia alone holds it — and streams
the fetch against a 5 GB cap so a runaway URL cannot fill the disk.

### A Finder-grade UI, deliberately

The `/files` page is vanilla HTML/CSS/JS, no build step, modeled
closely on macOS Finder: a sidebar category tree with a Recents smart
view above it, list and icon views with sortable columns, drag-to-move,
drag-in-from-the-OS upload, right-click context menus, Get Info,
breadcrumbs, search. That was a
deliberate budget call. A file manager that feels like a file manager
is worth the UI effort — the alternative (a flat list, or raw paths)
is exactly the kind of thing that quietly stops getting used.

## Live flight tracking — outbound poll, not a webhook (2026-06-22)

Kate tracks flights via AeroDataBox ([flights.ts](src/connectors/flights.ts)) with a
per-user `tracked_flights` watch-list and a `FlightTrackingDriver`
([flight_tracking.ts](src/core/flight_tracking.ts)). The load-bearing design choice
is **poll, not push**: a true event-push provider would need an internet-reachable
webhook endpoint, which collides head-on with the local-first "never WAN-bind the
orchestrator" rule. So the driver reaches OUT on a 60s tick and gets its "instant"
feel from an **adaptive cadence** — ~60s in the departure/arrival windows, sparse
(30 min) far out — which keeps a tracked flight to ~100–150 API calls across its
whole lifecycle. Three properties mirror the other reactive layers (LiveSynthesis /
reactive triggers): edge-only notification (diff the stored snapshot, push only on a
real change), fail-open (a transient 429 advances the poll clock but NEVER wipes a
known snapshot — wiping would suppress the next real event), and a kill switch
(`HEARTH_FLIGHT_TRACKING=0`). Notice rides the existing `push.ts` quiet-hours gate.
A flight links to a People/ note via `tracked_flights.person_id`, which is how the
Friends tab surfaces "Sam's flight" on her card. If a position/overhead layer is
ever wanted, local ADS-B (an SDR's `aircraft.json`) is the constraint-aligned add —
an additive `flights_overhead` tool, not a rework.

## Media apps — the *arr connector

Status: **implemented 2026-05-22.** A connector
([src/connectors/arr.ts](src/connectors/arr.ts)) wiring Cordelia to the
household media stack on `your-llm-host.local`: Sonarr (TV), Radarr (movies),
Lidarr (music), Readarr (books).

It is the streaming-pipeline sibling of the library. Where
`download_to_library` fetches a specific file Cordelia found and vetted,
the *arr apps take a title and hand it to an automated search-and-grab
pipeline. Three tools, one capability (`manage_media`, Cordelia only):

- `media_search` / `media_library` — look a title up, or read an app's
  library / queue / calendar / wanted list / history / status. Risk
  `read`.
- `media_add` — add a show, movie, artist, or author and trigger the
  grab. Risk `write_internal` — **frictionless, by Jasper's call**:
  Cordelia adds when asked, with no approval gate. The reasoning mirrors
  `download_to_library` — acquisition for the household shelf is the
  Librarian's job — and an add is cheap to reverse (delete it in the
  app). Every add is still audit-logged.

Sonarr and Radarr speak the v3 API; Lidarr and Readarr speak v1. `APPS`
carries the per-app version, base URL, and library kind so the tool code
stays uniform. Root folder and quality profile are auto-discovered per
app, so adding needs nothing but the title. URLs + API keys live in the
gitignored `.env`; an app with no key is simply unavailable — its tools
return a clean "not configured" message.

One honest limitation: Readarr is wired and its read views work, but its
*lookup* depends on Goodreads metadata, which is broken upstream (the
reason Readarr's own development stalled). `media_search` / `media_add`
for books surface that as a clean error until the metadata source
recovers; the other three apps are unaffected.

## The Hermes-on-mint two-track design (HISTORICAL — 2026-05-29)

**This section describes a removed surface.** Hermes-on-mint was
killed 2026-05-29 alongside the broader stack consolidation to
the LLM host; the user retired Telegram as a household interface. The thin
client + relay design described here ran from Prompt 7 through May 2026.
**On 2026-06-14 the integration code itself was removed** to shrink
attack surface: `integrations/hermes/` (the plugin + the
`hearth-push-receiver` FastAPI service on :8765), the inbound
`/api/relay/message` route, the `push_to_hermes` / direct-Telegram-Bot-API
delivery paths in `src/policy/push.ts`, the `/api/relay` auth-bypass, and
the Telegram bridge UI in `/app`. Push to iOS is the sole path now via APNs
(see "Push notifications — two parallel paths"); the web mic's `/app/api/transcribe`
now forwards to the speaches whisper STT instead of the receiver. The
`telegram` value survives only as an inert legacy message-`surface` enum on
historical rows. the workstation's Hermes-for-dev install (described below) is a
separate product and is unaffected. The rest of the section is kept for
design-history context — if a future similar gateway is built, the
constraints captured here still apply.

There were two Hermes installs in play. They shared nothing at
runtime and should be thought of as separate products that happen to
share an open-source upstream.

### Hermes-on-mint (the chief-of-staff surface — Prompt 7 thin-client) — retired

- Runs as `hermes-gateway.service` on the always-on host.
- Configured against the FRIDAY bot token.
- Persona at `~/.hermes/SOUL.md` includes the Hearth integration
  snippet (between `<!-- BEGIN: hearth integration -->` markers).
- Loads the `hearth` plugin from `~/.hermes/plugins/hearth/`
  (symlink to `integrations/hermes/` in this repo).
- Is a **thin Telegram gateway** for Hearth. Post-Prompt-7, the
  Hermes-side LLM, persona, memory, and skills are dormant. The
  plugin registers exactly one tool — `hearth_relay` — and the
  persona instructs the LLM to call it on every input and return
  the relay's reply verbatim. The voice the user hears is Hearth's
  specialist team, not Hermes.
- Companion `hearth-push-receiver.service` on :8765 owns the
  outbound direction (Hearth → Telegram pushes with inline
  keyboards) and the local faster-whisper transcription for
  voice memos and the web-UI mic button.

### Hermes-on-the workstation (the dev companion)

- Separate install on the user's workstation.
- Different bot token, different persona, different vault, different
  tools.
- Used for general AI work — coding help, research, scratch
  conversations.
- Has nothing to do with Hearth. They don't share processes,
  databases, or vault.

The clean separation is possible because Hermes is configured
per-install (`~/.hermes/` for one user-level install). Each install
has its own plugin list, its own bot, its own persona. The user can
talk to either via Telegram by which bot they message.

### Why thin-client rather than co-located

Considered: making Hermes-on-mint own the vault directly, no
separate Hearth process. Rejected because:

- It conflates two responsibilities: conversation and storage.
- It couples the agent runtime to the storage layer; swapping Hermes
  would require migrating storage.
- It blocks the future where multiple agent layers (Telegram +
  unified web UI + iOS) need to share the same vault.

Keeping Hearth separate makes Hermes a small, well-bounded
deployment, and lets the vault layer evolve independently.

### Why the Prompt-7 thin-client over the Prompt-2 per-tool model

The original Prompt-2 integration registered 11 `hearth_*` tools and
let Hermes's own LLM decide when to call them. That worked, but
introduced two intelligences with two views of the world: Hermes's
in-session memory and persona was separate from Hearth's specialist
runtime. When the user said "Kate, what's on your mind?" on Telegram,
they got Hermes's interpretation of Kate rather than Hearth's actual
Kate. With the thin-client refactor, Telegram messages route through
`/api/relay/message` and the same SpecialistRuntime that powers the
web UI produces the reply. Hermes's agent loop is intentionally
dormant — it exists only to invoke the relay tool.

## Specialist rooms — pane composition

Status: **Stages 0–4 + Maggie's listening + Astrid's activity + Mariah/Kate program + Ruby's `civic` + Vivian's `fuel` + Kristi's `competitive` + Anna's `property` + Linda's `resale` panes shipped.** (Hazel's `reception` pane was removed 2026-06-08 when Hazel was fired.) The
load-bearing design lives in
[~/Projects/hearth-ios/SPECIALIST_AS_ROOM_BRIEF.md](../hearth-ios/SPECIALIST_AS_ROOM_BRIEF.md);
this section is the backend half — what to know when adding the next
specialist's room.

A specialist with a non-null `pane_kind` on its YAML earns a *room*:
a glanceable header (driven by `compute_active_status`) plus a
backend-composed pane document iOS renders as the body of
`SpecialistRoomView`, with chat available via a footer pill. The
pane document is opaque to iOS — same contract as briefs — so adding
a new room is a backend + YAML edit, never a Swift edit per
specialist.

**Both clients render the same document.** The **web `/app` client**
(2026-06-02) consumes `GET /api/specialists/:id/pane` and renders the office
as the primary center surface for pane-enabled specialists, with an
`Office ⇄ Conversation` segmented toggle — office is the default landing, and
the choice is sticky per specialist; pane-less specialists open straight to
chat (the toggle stays hidden). It renders all seven block kinds (`hero_metric`,
`load_chart` bars/sparkline, `stacked_strip`, `list`, `link`, `text`,
`embed:library`) with the same forward-compat as iOS (unknown block → nothing),
so a new `pane_kind` is zero web work too. The context donut stays a
conversation affordance (suppressed on the office surface); media-attach is
available from the office action bar (same Cordelia-capture pipeline as the
composer). Web-client-only — no backend or nginx change, since the pane
endpoint already existed for iOS.

Backend surfaces:

- **`GET /api/specialists/:id/pane`** in
  [src/app/routes/specialists.ts](src/app/routes/specialists.ts) —
  the iOS entrypoint. Returns 404 when the specialist has no pane
  configured, which iOS treats as "fall back to chat-first" so
  legacy specialists keep working unchanged.
- **`compose_pane(spec, db, user_id, deps)`** in
  [src/core/specialist_pane.ts](src/core/specialist_pane.ts) — async;
  dispatches by `pane_kind` to a per-kind composer. Composers can
  read from the structured store (Maggie's `upcoming_shows`,
  Cordelia's library projection) and/or invoke registered tools
  through `deps.tool_registry.get(name)` (Maggie's listening pane
  reads `plex_heavy_rotation` and `media_library` this way).
  External-dependency failures degrade to a placeholder list item
  rather than dropping the section — empty-state copy ("no shows
  on radar yet") reads very differently from "Tautulli is down."
- **Beatrice's `codeshop` office → "Scrum" tab (2026-06-05).** The Code
  Shop pane is a top-level `tabs` block — **Office** (change-pipeline:
  merges awaiting approval, Kate's review queue, metrics) + **Scrum**
  (her AI-run dev-board). The Scrum tab is composed in
  [src/core/scrum_pane.ts](src/core/scrum_pane.ts) from existing
  primitives only (hero_metric say/do, load_chart burndown, stacked_strip
  backend/iOS split, list-per-lane, an "Awaiting you" list deep-linking
  `hearth://proposal/<id>`) — zero new block kind, zero iOS edit. The board
  itself is [src/memory/stores/scrum.ts](src/memory/stores/scrum.ts)
  (`ScrumStore` over hearth.db): projects → epics (typed feature|bug, sized
  S/M/L for effort + value, bugs severity-graded) in five lanes, weekly
  sprints, a `scrum_epic_events` lane-transition log, and **deterministic
  ROI/severity ranking** (no LLM in the sort — a critical bug tops; the rest
  by value/effort). `board` partitions backend|ios over ONE sprint + ONE
  capacity pool. Beatrice grooms it via the `scrum_*` tools (`manage_scrum`
  capability); a **sprint commit or judgment call is a `scrum_decision`
  proposal**, so it rides the one proposal/approve/push queue rather than a
  parallel inbox. A markdown+mermaid live canvas renders at
  `/app/scrum-canvas` (vendored mermaid, no CDN, same-origin under /app —
  no nginx change). Grooming reasoning runs on Forza via her deliberation
  tier. Adapted from `~/Downloads/scrum-starter-kit` (blueprint) +
  `planning-canvas-kit` (the canvas render).
  - **HTTP surface (read + write, owner-bearer-gated):**
    [src/app/routes/scrum.ts](src/app/routes/scrum.ts) —
    `GET /api/scrum/roadmap` (`{board, shipped}`) + `/board`;
    `POST /api/scrum/epic` (create — REQUIRED `project_slug` + `title`;
    optional `type` feature|bug, `size`/`value` S|M|L, `severity`, `description`,
    `lane`), `POST /api/scrum/epic/:id/move` (`{to_lane}`), `/epics/score`
    (batch). The two projects are **`roadmap`** (the imported frozen NEXT.md +
    ship records) and **`scrum-tool`** (the board's own dev). Lanes flow
    `product_backlog → sprint_backlog → in_progress → review → done`. The
    write token is the owner bearer at `/docker/hearth/data/claude-scrum-token`
    (good for ANY `/api/*` route on the LLM host). Concrete call shapes for a
    Claude session live in the private dev log's scrum boxed note.
  - **Targeted lookup (2026-06-07):** the canvas render caps cards per lane
    (top 12, `_+N more_`) and the ranked table (16 rows), so a deep-backlog
    epic isn't in `scrum_board_read`'s `summary`/`full` output AT ALL — it's a
    `.slice()`, not a length cutoff. To resolve a specific epic to its `id`
    (e.g. to move the shipped one to `done`, or to act on a board title a human
    pasted), `scrum_board_read` takes a **`query:`** —
    [`ScrumStore.search_epics`](src/memory/stores/scrum.ts) substring-matches
    title + description across the WHOLE board and returns the matches WITH
    ids. Multi-term AND (whitespace-split, every term must match in either
    field) so word order and any invisible characters BETWEEN words (the
    copy/paste-from-the-canvas case) don't break it — Beatrice searches a
    distinctive word or two, not the whole pasted line; LIKE wildcards are
    escaped. This is a deterministic SQL lookup, deliberately NOT RAG: the
    board is ~tens of short structured rows and the query is essentially exact,
    so cosine retrieval would add infra and lose the exactness a write path
    (move-to-done) needs.
  - **Soft-archive (2026-06-07):** an epic can be REMOVED from the board (junk /
    obsolete / wrong) without a destructive delete — an additive `archived`
    column on `scrum_epics` (backfills 0, no index — the boot-only-crash class),
    filtered out of `list_epics` / `read_board` / `search_epics` /
    `shipped_history` by default (`include_archived` opts in; `list_archived()`
    is the archive view). `archive_epic` refuses an epic committed to the OPEN
    sprint (archiving it would silently distort say/do — move it out first).
    Exposed on BOTH surfaces because **Beatrice owns ongoing board maintenance**:
    her `scrum_epic_write` tool gains `archive`/`unarchive` actions (she prunes
    during grooming), and the owner/Claude HTTP path gets `DELETE
    /api/scrum/epic/:id` + `POST /api/scrum/epic/:id/restore`. One store method
    backs both. Recoverable by design (the repo's "don't drop silently" ethos).
  - **Ceremonies — all three now run (2026-06-07).** Scrum's recurring rituals:
    **grooming** (score/rank the backlog) and **retro** already ran as Beatrice
    deliberation passes; the **daily standup** was the missing one — it existed
    only as a code comment. Now a `daily_standup` **background job** (trainer.yaml
    `proactive.background_jobs`, 06:00, after the 02:30 groom) fires
    `write_standup_snapshot` ([trainer/tools](src/specialists/trainer/tools/write_standup_snapshot.ts)),
    a deterministic (no-LLM) tool that appends a dated board snapshot (sprint
    say/do, lane counts, in-progress, next-up — `render_standup_entry_md`) to
    `Knowledge/Trainer/standup-log.md`. Untyped vault note (skipped by the
    ingestor like memory.md), idempotent per local day. The standup is a RENDER
    of the board, not a reasoning pass — same "no LLM in the board's
    deterministic surface" rule as the ranking.
  - **Interactive canvas — click-to-act + "start developing" (2026-06-07).** The
    `/app/scrum-canvas` board went from read-only to **directly actionable**:
    clicking a card opens a detail/action modal — **move** lane, **score**
    (effort/value or severity), **archive**, and **Start developing**. The first
    three hit the existing `/api/scrum/*` mutation routes (owner-session-gated,
    same as the bearer path). **Start developing** is a new route
    `POST /api/scrum/epic/:id/develop`: it moves the epic to `in_progress` and,
    for **backend** epics, hands it to Beatrice's directed-build pipeline
    (`fire_directed_build` dep → detached `fire_deliberation_now('trainer', …,
    {instruction, tools})`) — she investigates + opens a reviewed `beatrice/*` PR;
    Kate's review + the owner PIN-gated merge still gate it, so a click NEVER
    merges code. iOS epics just move (her pipeline is the backend repo). The
    hybrid is deliberate: direct manipulation for board housekeeping, Beatrice
    (with the safety gates) for actual development — and she can still do all of
    it conversationally via her chat `scrum_epic_write` surface. **Deploy gotcha:
    the nginx `/api/` alternation had to gain `scrum`** — the board's reads go
    through `/app/scrum-canvas/*` (always routed) but the mutation routes are
    top-level `/api/scrum/*`, which 404'd through nginx until added (it was never
    browser-reachable while the board was read-only).
- **Iris's `presence` office — LD2450 radar viewer + zone editor (2026-06-07).**
  The Satellite1's mmWave presence sensor gets a live top-down room canvas with
  a WYSIWYG detection-zone editor — the Code Shop pattern applied to a physical
  space. Plan: [docs/design-ld2450-zone-editor.md](docs/design-ld2450-zone-editor.md).
  The **canvas is client-rendered** (vanilla `<canvas>` in
  [src/app/client/app.js](src/app/client/app.js), keyed off `pane_kind ===
  'presence'` as the Code Shop's settings modal is client logic);
  `compose_presence_pane` composes only framing furniture. The canvas encodes a
  **mm↔px transform** with mount offset + rotation (design §5); internal math is
  mm in the radar frame (origin = sensor, X signed, Y positive-away). Data flows
  strictly **web → Hearth → coordinator → device** — the pane never touches the
  device: live targets ride UP (`POST /api/presence/targets` → ephemeral
  `PresenceLiveCache` ([src/core/presence_cache.ts](src/core/presence_cache.ts),
  never SQLite) → `presence_targets` SSE the canvas repaints on), zones ride DOWN
  (`POST /api/presence/zones` → `pending`/revision → coordinator
  `GET /zones/pending` → applies → `POST /zones/ack` → `presence_zones_acked`).
  Store: [src/memory/stores/presence_zones.ts](src/memory/stores/presence_zones.ts)
  (one row per device, single-row-merged-over-defaults). **The decisive fork is
  HOW zones are written** — the live `.29` runs FutureProof's custom firmware
  (on-device HTTP tuner, reboot-to-persist), NOT ESPHome entities; the
  coordinator abstracts both behind a `ZoneWriter` (TunerHttp vs Entity), specced
  in [docs/presence-coordinator-integration.md](docs/presence-coordinator-integration.md).
  Owner chose **tuner**; the editor surfaces a "Reboot device" affordance on it.
  **Privacy:** owner-gated at the `compose_pane` dispatch (non-owner → chat) +
  on every viewer/editor/gear route; NOT location-awareness data, never
  persisted. Hosted on **Iris** (presence is home automation). `/api/presence/`
  is a NEW top-level namespace — add it to the the LLM host nginx `/api/(...)`
  alternation. Hearth-side shipped device-free (`smoke:presence`); live dots +
  write-back gated on the coordinator holding the device.
- **Ruby's `civic` office (2026-05-30)** reads the new `civic_items`
  table (via `MemoryClient.list_civic_items`): next-council-meeting
  hero + countdown, then agenda / new-in-town / corridor-traffic /
  FCGOV sections (interest_score ≥ 0.5), then an "Also watching"
  outskirts (below the bar). Ruby populates it in deliberation with
  the `record_civic_item` tool (capability `write_vault_general`),
  not free-form memory.md. The split — at-a-glance up top, scrollable
  outskirts below — is the user's explicit office shape.
- **Ruby's receipts ledger (2026-06-10)** — the money-and-interests
  side of the civic record, on the Kristi store+acquire idioms.
  [`RubyCivicStore`](src/memory/stores/ruby_civic.ts) is its own SQLite
  file beside hearth.db (`ruby_civic.db`, `HEARTH_RUBY_CIVIC_DB_PATH`):
  `donations` / `finance_filings` / `member_interests` /
  `conflict_flags`, all global (public-record facts, like Kristi's
  market cache — not household data), every row requiring a
  `source_url`, amounts gated for plausibility at the write chokepoint.
  Votes stay in the main DB's `civic_votes`; the nightly
  `extract_meeting_votes` job (official-government-host floor enforced
  in code) and the manual `record_civic_vote` tool converge on the same
  dedup keys. Weekly `acquire_campaign_finance` (city clerk + TRACER +
  reporting, provenance derived from the document host) feeds the
  deterministic `scan_conflicts` sweep — distinctive-name-token
  cross-reference of donor rollups + interests against the voting
  ledger, filing `conflict_flags` whose status machine (flagged →
  reviewed → substantiated | cleared) survives re-scans, so a cleared
  flag never resurrects. Analytics are pure functions in
  [civic_analysis.ts](src/specialists/ruby/civic_analysis.ts)
  (topic buckets, alignment matrix over shared substantive votes,
  conflict matching) read through `member_dossier` / `voting_record` /
  `council_alignment` / `query_civic_finance`; the City Desk gains
  "Council ledger" + "Money & conflicts watch" blocks. The judgment
  half — proximity framing, never causation; only substantiated flags
  reach the household — lives in Ruby's persona + the Tuesday review
  ritual, on top of the structural floors. Proof:
  `bun run smoke:ruby-civic`.
- **Ruby's promotion — the Politics Desk (2026-06-10 #2).** Role →
  Politics Correspondent; the office becomes four tabs on the generic
  `tabs` primitive (The Brief rollup / Pleasantville / Colorado /
  Nation & World), `pane_kind` unchanged (`civic`) so iOS needs
  nothing. Non-local altitudes live in `politics_items` (same
  `RubyCivicStore`): scoped items whose `take_md` — Ruby's grounded
  read — renders as tap-to-expand `detail_md` (the Kristi assessments
  pattern). Write floors: fact-kinds require a citing url, takes are
  sticky across re-records, dismissed items don't resurrect. Fort
  Collins keeps the entire `civic_items` machinery; the tabs only
  re-home its blocks. The voice mandate ("spicy, never cruel" — heat
  up at power, kindness to people, wit earned by receipts) is a
  persona value, deliberately NOT a mechanism — the citation floor is
  the mechanism.
- **The evidence-quote gate (2026-06-10 #3)** closes the tool-ARGUMENT
  blind spot for civic claims. The reply-side critics (provenance regex,
  fact critic, read_failure_guard) never see what a turn WRITES through
  tools — the StreetMedia fabrication (a "June 16 work session review"
  announcement whose cited page, fetched that same turn and stored
  verbatim in the audit log, contained no such claim) landed mid-turn on
  a degraded pass even though the guard fired on the reply. Fix at the
  write chokepoint: claim-shaped kinds (`record_civic_item`
  announcement/agenda_item, `record_politics_item` fact-kinds) require
  `evidence_quote`, verified deterministically against
  `MemoryClient.audit_evidence_for_intent()` — the SAME TURN's audited
  read results, no re-fetch (the audit log already holds every fetch
  verbatim). Quotes under 12 normalized chars never match (scaffold
  tokens prove nothing); `kind: watching` stays the honest uncited home;
  intake/scan writers call the MemoryClient directly with their own
  provenance and bypass the tool gate by design. The pattern (audit log
  as same-turn evidence substrate for write gates) is reusable for any
  specialist whose tools assert facts into a pane.
- **Corridor-affinity (2026-05-30).** `location_corridors` table +
  [src/core/geo.ts](src/core/geo.ts) (haversine + greedy single-pass
  clustering + linear-decay corridor scoring). Ruby's daily
  `cluster_location_corridors` background job reads the location
  sensor stream (`MemoryClient.list_location_points` loads each packet
  payload + extracts coords defensively) and full-replaces the user's
  corridors; a geolocated `civic_item` scored on a corridor is
  promoted in her office (the music-affinity pattern, applied to
  geography — refines as history accumulates). Location is the most
  privileged data in the system: gated on `read_my_location` + the
  `privacy.yaml` allowlist, with a runtime `location_specialist_allowed`
  re-check; audit logs counts only, never coordinates.
- **Recent-trip awareness (2026-05-31).** Corridors are aggregate
  clusters; they don't answer "where did I go yesterday." That gap left
  Ruby unaware of the user's trips in chat. The fix adds, on the same
  privacy footing: `MemoryClient.list_location_events` (preserves the
  `kind` + `motion` fields `list_location_points` drops),
  `summarize_recent_trips()` in `location_awareness.ts` (a pure
  arrival/departure-pairing function → newest-first visit timeline with
  durations + `ongoing`), and the on-demand `recent_trips` tool
  (audited, allowlist-gated). Travel mode (car vs bike) is an optional
  `motion` enum on the `/api/sensors/location` packet
  (`automotive|cycling|walking|running|stationary|unknown`); the backend
  accepts it now, iOS attaches `CMMotionActivity` in a follow-up — until
  then consumers report mode as "not recorded," never inferred. This is
  the reusable shape for any specialist that should know where the user
  has been: a gated tool, not location in the prompt.
- **The civic pane's empty-state bug (2026-05-31)** was not the pane —
  it was that deliberation ran `runtime.turn()` with no `user`, so
  `record_civic_item` (and every user-scoped deliberation tool) rejected
  its write with "no user in context." `deliberation_pass` now threads
  the recipient as the turn user, so deliberation-time writes land.
- **Vivian's `fuel` office (2026-05-30)** keeps her a fiduciary —
  no trade signals, no persona change. MTD *tracked* spend (receipt
  markdown under `Knowledge/Vivian/receipts/`; partial pending Plaid)
  + recent receipts + portfolio total & concentration (>5% positions,
  pure math) from a `Knowledge/Finance/holdings.md` snapshot Jasper
  maintains. Self-contained reads; macro/ER-audit/subscription-drift
  stay chat-time work.
- **Block types** are the existing card primitives
  (`HearthCardPrimitives`): `text`, `list`, `link`, `embed`,
  `hero_metric`, `stacked_strip`, `load_chart`. A new block type
  requires a Swift change in `HearthCardPrimitives`; the bar for
  adding one is reuse across ≥2 specialists. The 2026-05-29 trio
  (`hero_metric` / `stacked_strip` / `load_chart`) was added with
  Astrid's activity pane and is consciously generic — `stacked_strip`
  takes semantic hue tokens (`z1`..`z5`, `protein`/`carbs`/`fat`,
  `critical`/`warn`/`info`) that iOS resolves to a concrete color,
  so the backend stays presentation-free.

Today's rooms:

- **Cordelia — `library`** (Stage 4, 2026-05-28). Single `embed`
  block (`view: 'library'`) renders the existing Library tab as the
  room body — no new fetches at the pane layer; the embed re-fetches
  its own content.
- **Maggie — `listening`** (2026-05-29). Four `list` blocks: Coming
  to town (`upcoming_shows` filtered to non-sold-out, capped 5), On
  your radar (artist watchlist top-by-affinity), Hitting your Plex
  (Tautulli 30d top_artists), New in the library (recent *arr
  imports across sonarr/radarr/lidarr). Validates the second
  specialist room and unblocks the Staff-tab restructure.
- **Astrid — `activity`** (2026-05-29). Two modes dispatched by data:
  LIVE when `workout_sessions` carries an active row for the user
  (reads `WorkoutSessionTracker.get(session_id)` for current HR / kcal
  / elapsed / zone strip + a `silence-cues` deep link), STANDBY
  otherwise (7-day hero of training minutes with a vs-prior-week
  delta, daily load-chart of training minutes, aggregated zone
  strip, PR top-3 from `users/<uid>/astrid/records/*.md`, recent
  sessions list, observations tail). A third edge case — the
  orchestrator-restart "SQL active, tracker doesn't know" path —
  renders elapsed + a "reconnect on next packet" line rather than
  fabricating zone minutes. Introduced the three new generic
  primitives noted above.
- **Kristi — `competitive`** (2026-06-02). The Recon Desk. Pure
  structured reads from the `kristi_workstations` SQLite store (its own
  file beside hearth.db, `HEARTH_KRISTI_DB_PATH`): a `hero_metric` of
  unmatched cert-registry leaks + a price-moves delta, then `list`
  blocks — Leak radar (unreconciled DMTF/ENERGY STAR/TCO model-strings),
  HP-Z leads / HP-Z gaps (from `hp_z_gap_view`), Latest moves
  (newest leaked/announced SKUs), Projected next gen, ISV/GeForce watch.
  No new primitives — reuses `hero_metric` + `list`. Soft empty-state until
  her scrapers + deliberation fill the store. Two-layer pattern: `scan_sources` /
  `scan_cert_registries` background jobs do the dumb fetch+ingest+diff;
  her deliberation reads the clippings and records normalized rows via
  `record_sku` / `record_price` / `record_isv_cert` (gated
  `write_workstation_intel`), each carrying a `source_url`. **Generational
  projection:** from a line's verified lineage (`lookup_workstation` family
  filter + `compare_configs` across gens) + public roadmaps, she records a
  next-gen inference via `record_projection` into a SEPARATE `projections`
  table (kept out of the verified-spec views), keyed by a shared `swimlane`
  slug so the three OEMs contrast directly — each with confidence + falsifier +
  sources, surfaced in "Projected next gen". The cert
  registries are the pre-launch leak radar — a certified model-string
  with no known SKU is a leak (e.g. DMTF `dell-pro-precision-9-t6-pw9t6260`,
  Dec 2025). **Note:** since the iOS `hasPane` refactor (2026-05-30), a new
  `pane_kind` no longer needs a paired Swift enum edit — iOS routes to the
  room on raw string presence and renders the server blocks; the backend
  enum stays closed only so `compose_pane` is exhaustively checked.
  **Demand-side profiles per lane (2026-06-03):** each swimlane row now
  carries a "Who it's for" tap-down — **personas** (the human seat),
  the **ICP** (Ideal Customer Profile — the org that should buy the lane),
  and **UCP** (UNideal Customer Profile — who looks like a fit but
  shouldn't, plus the lane they belong in). They live in their own
  `swimlane_profiles` table (keyed by `ws_class`/`swimlane`/`profile_kind`/
  `title`), are derived by the `derive_swimlane_profiles` background job
  (06:48) — one deep-model call per lane, grounded BACKWARDS along the
  chain *workflow compute demand → capability driver → buyer*, re-derived
  only when a lane's supply-side data moves (a `sync_meta` content-hash),
  replacing each lane's set atomically — and appended to the swimlane's
  `detail_md` so the build-54 iOS tap-through renders them with no iOS
  change. Read with `swimlane_profiles`; written by hand via
  `record_swimlane_profile`. Every profile carries `grounded_on` +
  `capability_drivers` + a falsifier; a UCP carries a validated
  `redirect_swimlane` (a real peer lane) — an unideal profile without a
  redirect is a complaint, not analysis. Covers all four classes (DTWS /
  MWS / RWS / Edge-AI).
  **Commodity price history + base unit cost (2026-06-03):** a pane list
  item gained an optional `charts[]` (the `load_chart` shape — tappable
  points, value-on-tap) rendered below the blurb on tap-through. The
  *commodity price spread* rows carry a per-OEM price-history sparkline,
  *component cost vs OEM markup* rows the market-street + per-OEM markup
  trends, and a new shared **Base unit cost** section tracks each
  component's observed market street/MSRP price over time (the base beneath
  every OEM configurator markup; `price_series` aggregates the
  one-row-per-commodity/vendor/day history to one point/day). The
  `commodity` assessment blurb now folds in the wow/mom market trend. iOS
  build 58 renders the charts (`ListPayload.Item.charts`); older clients
  ignore the field.
  **Run-everything + real completion tracking (2026-06-03):** the data-pipeline
  gear (web + iOS) got a single **Run everything** control that fires the whole
  ordered pipeline sequentially with no overlap, and — the load-bearing change —
  every step now reports ACTUAL completion. The `fire_background_job` /
  `fire_deliberation` routes run detached (a browser scan outlives the proxy read
  timeout), so the client never saw the end. New in-memory tracker
  [src/core/job_runs.ts](src/core/job_runs.ts) records `running` → `ok`/`failed`
  per `(specialist, job)` as the server's own sequential detached runner
  progresses (the deliberation pass under `__deliberation__`, via
  `fire_deliberation?detached=1`); `GET /api/specialists/:id/background_jobs/status`
  exposes it. Both clients kick off detached then **poll to completion** — spinner
  spans the real work, ✓ persists until re-run, seeded on gear reopen. The next
  step waits for the prior to genuinely finish, so the old fast-vs-detached gap
  heuristic is gone. In-memory by design (restart clears checkmarks; the audit log
  is the durable record).
  **IDC class × tier taxonomy + breadth/recording fixes (2026-06-03):** an audit
  found Kristi's store thin and mis-categorized — missing all Lenovo, all HP-Z2 /
  entry tier, most MWS, and bucketing HP Z1 (entry) beside Dell Pro Precision 9
  (expert). Four-layer fix, each closing the failure *class*: (1) **discovery
  breadth** — `scan_sources` round-robins seed queries across coverage `bucket`s
  (`<vendor>-<class>`) instead of draining the array HP-desktop-first, with the
  existing per-URL recency-skip carrying depth across runs (cap 8→16). (2)
  **fetch escalation** — `fetch_with_browser_fallback` now escalates a THIN
  (<900-char) Firecrawl 200 to the the workstation browser, not just hard errors, so
  bot-walled SPAs (Lenovo PSREF) that returned ~750-byte shells get the rich
  render. (3) **recording coverage** — a new `coverage_gaps` read
  ([store `coverage_summary()`](src/memory/stores/kristi_workstations.ts)) maps
  recorded SKUs per `(class × vendor × tier)`; the deliberation prelude records
  net-new models into the EMPTY cells (all OEMs, all tiers) before re-confirming
  flagships. (4) **categorization** — `cluster_swimlanes` rewritten to the
  IDC-aligned **class × performance-tier** taxonomy: class is derived in code
  from `form_factor` (never mis-filed), the LLM assigns a tier ∈ {entry,
  mainstream, performance, expert} anchored on each OEM's line position, and the
  slug is composed as `<class> · <tier>`. A new `tier` column on `skus` (additive)
  stores it; a genuinely-novel segment may still spawn its own lane (the one
  free-form path → "discover NEW swimlanes"). Proof: `smoke:kristi-tiering`.
  **Cost engine — price gate, robust street, fitted drift, deterministic
  outlook (2026-06-10):** pricing got the accuracy + foresight layer specs
  already had. (1) **Write-side price plausibility gate** at the store
  chokepoints (`record_price` / `record_commodity_price`, mirroring
  `record_spec`'s `validateSpec`): per-class absolute USD windows + a
  history-relative outlier check (>4×/<¼ the series' own recent median, ≥2
  priors so one bad seed can't lock a series) from
  [cost_model.ts](src/specialists/kristi/cost_model.ts); a rejection returns
  `{stored:false, reason}` — the LLM tools surface it as a RESULT and the four
  background writers count it (`rejected`). (2) **Robust street price** —
  `robust_standalone` (median of recent daily points, median-nearest row as
  provenance, dispersion as `spread_pct`) anchors `base_unit_view` and
  `premium_view`, so one bad scrape can't swing a platform residual or fake a
  markup story; `base_unit_view` also canonicalizes recorded base-component
  names (`normalize_commodity`) at read so they always find their street rows,
  and flags NEGATIVE residuals + noisy windows. (3) **Fitted commodity
  drift** — log-linear OLS over each street series → compounding monthly % with
  r²/n/span/sigma (`commodity_trend` / `trend_table` / `class_drift` — the
  per-class median IS the DRAM/NAND/VRAM squeeze as one number). (4)
  **Deterministic forward `cost_outlook`** — platform residual held constant,
  each backed-out commodity compounded by its own fit (class-median as labeled
  proxy, flat when neither), at 3/6/12-month horizons with widening bands,
  per-platform confidence + caveats. Three new read tools
  ([cost_analysis.ts](src/specialists/kristi/tools/cost_analysis.ts)):
  `base_unit_costs` (residuals + the missing-street-price worklist),
  `commodity_trends`, `cost_outlook` — on both chat + deliberation surfaces;
  the persona's "commodity cost cycle" section + prelude step (4c) own the
  judgment discipline (quote drifts WITH their window, projections WITH bands,
  the falsifier is the drift reversing). Recon Desk: street rows show the
  fitted drift; base-unit cards carry the 6-month outlook + integrity flags.
  Proof: `smoke:kristi-cost` (47 checks).
  **Verified leak radar (2026-06-10):** the radar shows ONLY verified-new
  platforms. A cert sighting is `pending` (a count, never a leak row) until the
  reconcile job verifies it: deterministic catalog cross-reference first, then
  ONE bounded web search per sighting and an LLM judgment over the retrieved
  EVIDENCE (memory is only the tiebreak — the old knowledge-only judge filed
  shipping products as leaks whenever they post-dated its training). Verdicts
  stamp `market_checked_at` + `evidence_url`; `pre_launch` verdicts EXPIRE
  (~10 days) and re-verify so a leak that launches retires itself; and an
  `in_market` verdict that names the product AUTO-RECORDS the SKU
  (`apply_reconcile_verdicts` in
  [reconcile_leaks.ts](src/specialists/kristi/tools/reconcile_leaks.ts)) — the
  catalog converges toward the entire launched+announced universe, which IS the
  radar's subtraction basis. Proof: `smoke:kristi-leaks` (15 checks).
  **Value engine (2026-06-10 #2):** (1) `drive_configurator` auto-captures each
  target's BASE UNIT in the same drive ('Included' options = the default
  components; one bounded LLM call reads the base price) → `record_base_unit` +
  a 'base' price point — and four new targets extend coverage to the ENTRY lane
  (HP Z2 G1i / Dell 3680 / Lenovo P3) + the first MOBILE (ThinkPad P16). (2)
  **Price-per-performance**: `benchmark_scores` (canonical PassMark/Geekbench
  keys with plausibility windows — scores only compare within one benchmark),
  filled by the bounded `lookup_benchmark_scores` job; `perf_per_dollar` joins
  score ÷ robust street (tool + Recon Desk section). (3) **`cost_watch`**
  (07:12, no LLM): materiality thresholds over class drift + the 6-mo outlook →
  ONE sync_meta-deduped flag into Kristi's own inbox ahead of her pass —
  detection structural, judgment hers. (4) **`data_health`**: the quality
  companion to coverage_gaps (≥3 comparable specs, ≤14d price freshness, base
  units per cell; "stale beats missing") feeding the stock-take. Two golden
  eval tasks lock the cost-tool and pending-not-a-leak behaviors. Proof:
  `smoke:kristi-value` (23 checks).
- **Linda — `resale`** (2026-06-03). The Resale Desk — the outcome layer over
  her listing *drafts*. `draft_listing` composes the three platform listings;
  the new **`resale_items`** per-user ledger tracks what the seller actually
  ran: chosen marketplace, listed date + price, markdowns (`price_drops_json`),
  and final sale (+ optional `cost_basis`/`fees` → profit). Written by
  **`track_listing`** (one flexible lifecycle tool — field-level merge so a
  drop/sale turn carries only the new fact + `item_ref`; reuses
  `write_vault_linda`), read by **`query_sales_history`** (the seed of the
  longer-term "price off the seller's own outcomes, not just comps" goal).
  Pane: a `hero_metric` of revenue + sold count (profit/margin as the delta),
  a revenue-by-week `load_chart`, a per-platform `stacked_strip`, a
  Performance `list` (sell-through, avg days-to-sell, avg discount + drops,
  margin), and the tracked-item cards (Active listings / Recently sold). The
  cards carry an item photo via a new **`thumb_capture_id`** on the `list`-item
  primitive — a Cordelia capture id each client resolves to
  `/api/cordelia/thumbnail/<id>` (iOS `HearthClient.thumbnailURL`, web a direct
  `<img>`); presentation-free, the first cross-repo primitive extension since
  `charts[]`. `track_listing` emits `resale_item_updated` so the web office
  refetches live; the post-draft "which platform did you list on?"
  multiple-choice is `present_questions` + `track_listing`, encoded in Linda's
  `chat_addendum`, not new code. **Aging radar (2026-06-03):** the ledger's
  payoff — `compute_aging()` ([resale_items.ts](src/memory/stores/resale_items.ts))
  flags active listings live past ~1.5× the seller's own days-to-sell
  benchmark (per-category when there's enough history, else overall, else a
  21-day default) and suggests a charm-priced markdown; it renders as a "Time
  to nudge the price" block under the hero AND rides `query_sales_history`'s
  `aging` array so Linda raises the stalest item in chat unprompted. **Fee-aware
  profit:** [src/connectors/marketplace_fees.ts](src/connectors/marketplace_fees.ts)
  (`estimate_platform_fee` — eBay/Poshmark/Mercari/Depop/FB schedule, verified
  June 2026) fills in `fees` when the seller didn't record an exact number, so
  the office's net-profit/margin reflect real take-home; the seller can override
  with an actual fee. **Knowledge seed:** authored notes under
  `scripts/seed/linda/` (marketplace fees, sourcing-ROI playbook, pricing/markdown
  strategy, resale operations) seeded via `bun run seed:linda-knowledge` (multipart
  `/upload`, `specialist_id=linda`) so she retrieves them through
  `search_library`; official fee-page URLs added to `curate:linda-seed` for live
  provenance. Proof: `smoke:resale`.

The structured backing for Maggie's Coming-to-town section is the
`upcoming_shows` table. Maggie's deliberation passes call
`check_show_status` ([src/specialists/maggie/tools/check_show_status.ts](src/specialists/maggie/tools/check_show_status.ts))
as the all-in-one "capture + verify ticket availability" step:
upsert by (user_id, artist, venue, show_date), fetch the ticketing
page (Firecrawl → browse_url escalation), parse for ticket-status
signals, stamp `ticket_status` + `ticket_status_checked_at`. The
parser's precedence (`sold_out` beats co-present "buy tickets" copy)
is what keeps a sold-out marquee from reading as "tickets
available" in the pane.

### The Watch Desk + camera-VL — describe, correlate, never recognize (2026-06-10)

Cassandra's `security` office (the Watch Desk, `compose_security_pane`)
is store-driven like the civic pane — it reads the `security_events`
ledger her deliberation + away-from-home monitor populate, so compose
never blocks on a live UniFi call (the camera roster is the one live
read, best-effort with a 5s race + graceful "unavailable" fallback).
Owner-gated at the `compose_pane` dispatch, mirroring the presence
office: cameras and perimeter are the most private surface in the house.

The novel mechanism is **tying the vision tier into the camera stack**.
`fetch_camera_snapshot` ([unifi.ts](src/connectors/unifi.ts)) pulls a
Protect camera's current JPEG to a temp file; `classify_camera_scene`
([security_vision.ts](src/core/security_vision.ts)) hands that host path
to the `vision` role (the 27B-VL on forza — the same endpoint
`analyze_image_direct` uses) under a SECURITY system prompt, returning a
structured `{description, people_count, appearance[], activity, concern,
reasoning, confidence}`. The load-bearing design constraint, baked into
the prompt and the persona:

- **The model DESCRIBES; it does not RECOGNIZE.** Qwen-VL reliably
  reports appearance, count, and activity, but it cannot assert identity
  from a frame — "that's Sam" when it's a similar-haired neighbor is a
  confident-wrong alarm, worse than silence. The prompt forbids naming
  individuals; the persona teaches the same. True named identity, if
  ever wanted, is Protect's OWN trained face-detect (a hardware setting),
  whose labels Cassandra would read — not a VL guess.
- **Identity comes from CORRELATION, upstream of the model.** The
  away-from-home monitor (`camera_watch.run_away_monitor`, called every
  awareness tick) is **presence-gated**: it watches only when the house
  is confirmed empty (the owner has a recent location fix away from home
  AND no member is within the home radius — *unknown* location is not
  *away*, so a stale fix can't trigger a false alarm). The judgment is
  the VL description PLUS who's expected home: a person the model grades
  notable/concern *while the house is empty* is the escalation; the same
  detection with "delivery uniform, parcel" is routine even with no one
  home. This is what makes it "pertinent commentary on what's happening
  when I'm gone" rather than a motion-alert firehose.
- **Cost is event-shaped within the gate.** Zero VL calls on a quiet
  empty house (no Protect person/vehicle smart-detect → no snapshot);
  one VL call when someone appears; capped per tick so a busy minute
  can't stall the awareness loop. Fail-open everywhere — no llm, presence
  unknown, UniFi down, vision unparseable all degrade to "no judgment
  made," never a manufactured alarm.

`unifi_camera_view` is the on-demand owner-only sibling ("is anyone in
the backyard?") — same snapshot→VL path, ephemeral file, a hard
owner-tier check on top of the `view_cameras` capability. When you add a
new place that wants a camera read, drive it through
`fetch_camera_snapshot` + `classify_camera_scene`; the snapshot's
temp-file lifecycle is the caller's (`cleanup_snapshot` in a finally).

### Enrolled-face recognition — the deliberate exception to "never recognize" (2026-06-14)

The "describe, never RECOGNIZE" constraint above is about the VL *guessing* identity from
appearance — which it can't do reliably, so it doesn't. But the owner can now TEACH Cassandra
specific faces, and a *matched enrolled* face is honest identity, not a guess. This is the
**People room** of her (now tabbed: Watch Desk | People | Plates) office.

A self-hosted **CodeProject.AI FaceProcessing** server holds enrollment-based face
embeddings; the [face connector](src/connectors/face.ts) wraps its register / recognize /
detect / list / delete endpoints (`CPAI_BASE_URL`, stub-aware, recovery-hint on error).
Enrollment is **capture-driven**: the owner captures a frame from a doorbell camera in the
People room → CPAI detects the face → the owner tags it with a name → it's registered. Hearth
stores only roster metadata (`enrolled_persons`, owner-scoped, OUTSIDE the cordon); the
biometric embedding lives in CPAI, and the reference photos are written as RAW BYTES to an
owner-private vault dir (`write_face_photo`) — never a markdown note, so they never enter RAG
/ search. The routes live under `/api/specialists/cassandra/*` (the market_radar namespace
precedent — no nginx change), owner + `enroll_faces`-gated.

Recognition closes the loop two ways: the `face_recognize` tool (gated by the new
`recognize_faces` cap, owner-only) answers "who's at the door?" in chat, and
`run_away_monitor` runs it on every person detection — a known enrolled member while away
DOWNGRADES the concern (it's family), an unrecognized person with the house empty keeps or
raises it. The persona doctrine was rewritten accordingly: describe by default, name ONLY a
confident enrolled match, never a guess; never deny a name without running the recognizer.
ALPR is a deferred placeholder tab — the current high/oblique driveway cameras can't resolve
plates (tested empirically), so that room waits on a dedicated entrance plate-camera.

### Household Awareness Layer — P1 "who's home & where" (2026-06-14)

The first phase of the [Household Awareness Layer](docs/design-household-awareness-layer.md) is
**assembly over signals already collected**, not new CV. Two additions feed it:

- **VL appearance per sighting.** `run_face_sighting_sweep`
  ([face_sightings.ts](src/core/face_sightings.ts)) now stamps a `face_sightings.appearance`
  (a VL describe — "gray hoodie, tall build") on each detection frame. The describe is the
  only expensive new call, so it's bounded HARD: ONE per detection *frame* (not per face),
  only when a face was actually recorded, capped at `HEARTH_SIGHTING_VL_MAX_PER_TICK` (2) per
  awareness tick, kill-switchable (`HEARTH_SIGHTING_VL=0`), and fully fail-open (no
  vision → appearance stays null, the sighting still stands). Additive nullable column, no
  `SCHEMA_VERSION` bump.
- **Detection-keyframe, not the live frame (2026-06-15).** The sweep fetches the Protect EVENT
  keyframe (`fetch_event_keyframe` → `/proxy/protect/api/events/<id>/thumbnail`, via
  `acquire_detection_frame`) instead of the camera's current frame, falling back to
  `fetch_camera_snapshot` only when an event has no keyframe (motion-fallback detections). The live
  frame is pulled up to a 60s tick after the detection, by which point a doorbell visitor has left —
  so the door's few face-yielding moments captured an empty porch. A 2026-06-15 audit found the
  sweep had recorded ~1 sighting ever: it's healthy and firing, but face is **doorbell-mostly /
  sparse by design** (93% of detections are high-mounted driveway/garage/backyard cams with no
  resolvable face; the away-monitor's recognizer matched 0/276 such frames). The keyframe makes the
  one camera that *can* yield faces capture reliably — naming for P1/P2 must still lean on BLE +
  body-ReID, with face as the occasional anchor (see [the awareness-layer design §3](docs/design-household-awareness-layer.md)).
- **The derived occupancy view.** `MemoryClient.get_household_occupancy()` is the derivation
  (sync, DB-only): each ENROLLED person's newest in-window sighting (zone = camera friendly
  name today; a camera→room `zone_map` is the P3 slot-in — `zone` is kept distinct from
  `camera_name` for exactly that) joined by name with iOS home/away, PLUS active UNKNOWN
  clusters (the concern signal). The home/away half — async + needing the UserRegistry home
  anchor — is resolved separately by `resolve_household_locations`
  ([household_awareness.ts](src/core/household_awareness.ts)) and passed in, so MemoryClient
  stays sync + UserRegistry-free.

Surfaced three ways: the owner-only `household_occupancy` read tool (gated by the new
`read_occupancy` cap, Cassandra's chat surface — the grounding read for "concerning camera
signal vs nothing-burger"), the `GET /api/specialists/cassandra/occupancy` route (the
market_radar namespace precedent — no nginx change), and a **"Who's home" office tab**
(client-rendered web view with home/away via `render_occupancy_room` in app.js + a
camera-derived server tab for iOS). Owner-only + local + derived-not-raw (the §7 rails): the
occupancy state never enters RAG/search/cross-specialist sharing, lives outside the per-user
cordon (derived security data, not user content), and the audit row records counts only.
Smoke: `smoke:household-occupancy`. **P2 (continuous appearance-anchored tracks) shipped
2026-06-15 — see below;** P3 (BLE room layer) is the dormant `ble_presence` scaffolding.

### Household Awareness Layer — P2 "appearance-anchored continuous tracks" (2026-06-15)

P2 turns last-seen occupancy into **continuous tracks** — a hypothesis about one person
moving room to room, threaded by appearance between the sparse face hits. **Dormant by
default** (`HEARTH_PERSON_TRACKS`, off), exactly like P3's BLE layer: when off every entry
point is a no-op and occupancy is byte-identical to P1 (fail-open contract). Greenlit by the
2026-06-15 OSNet de-risk benchmark on 60 real Protect crops (same-person cross-camera cosine
0.83; the ~0.55–0.70 overlap band makes this a **same-day / same-outfit thread, never a
day-spanning identity** — threshold 0.70 for precision).

- **Two CPU CV sidecars (the LLM host Xeon, no GPU contention; the `cpai` docker pattern).** An
  **OSNet body-ReID** sidecar ([ops/reid](ops/reid), `POST /embed` person-crop → 512-d body
  vector — the dense thread the VL can't be) and an **InsightFace ArcFace** sidecar
  ([ops/arcface](ops/arcface), crop → 512-d face vector). CPAI stays the primary NAMER; ArcFace
  gives Hearth its OWN face vector to confirm identity by cosine without round-tripping CPAI per
  frame. Connectors [reid.ts](src/connectors/reid.ts) / [arcface.ts](src/connectors/arcface.ts)
  mirror [face.ts](src/connectors/face.ts) — env-gated (`REID_BASE_URL` / `ARCFACE_BASE_URL`),
  fail-open, test-seamed.
- **Data model (additive, self-contained — CREATE TABLE IF NOT EXISTS in the ctor, the
  `home_map`/`ble_devices` style, no `SCHEMA_VERSION` bump).** `person_sightings`
  ([person_sightings.ts](src/memory/stores/person_sightings.ts)) — one row per person-detection
  crop (body + optional face Float32 BLOBs, zone, captured_at) — and `person_tracks`
  ([person_tracks.ts](src/memory/stores/person_tracks.ts)) — the live/recent tracks (identity +
  confidence + source, current zone, body signature, `started_day` for the same-day cap, status
  live|stale|closed, owner-only `evidence_json`) + a `known_face_vectors` cache (enrolled ArcFace
  vectors). Owner-private derived bytes, outside the cordon.
- **The deterministic fusion scorer (NOT an LLM).**
  [person_track_scorer.ts](src/core/person_track_scorer.ts) is pure functions over the live tracks
  + the `home_map` adjacency graph: a sighting EXTENDS the nearest live track (body cosine ≥
  `HEARTH_PT_BODY_MATCH` 0.70, same/adjacent zone via `adjacency_index()` — no teleporting, a
  motion-plausible Δt) or BIRTHS a new one. A body cosine below the bar is the §5 **hard reset on
  a clothing/lighting discontinuity** — a changed outfit no longer matches, so the name is NOT
  carried. Identity is stamped by ArcFace face cosine or CPAI; with no fresh face signal a prior
  name **carries forward at decaying confidence, capped to the same local day**, floored below
  which it drops to uncertain. The **everyone-home prior** (iOS home/away) bounds the candidate
  set — a track can only be named for a person whose phone is home; an away match is suppressed.
  Decay→stale→closed on coverage gaps. Every decision carries evidence; the scorer never asserts
  a name it can't defend ("always able to say uncertain").
- **Fused into occupancy the BLE way.** [person_tracks.ts](src/core/person_tracks.ts) mirrors
  [ble_presence.ts](src/core/ble_presence.ts): the collection sweep (`run_person_tracks_sweep`,
  wired gated into Cassandra's awareness loop) gathers sightings → scorer → store; the read path
  (`augment_occupancy_with_tracks`, wired gated into [home_pane.ts](src/core/home_pane.ts) +
  [routes/home.ts](src/app/routes/home.ts)) fuses live NAMED tracks — ADDing a person the face
  didn't catch in-window, or carrying a name to the MORE-RECENT room they moved to (face anchors
  identity, the track advances position). Unnamed/uncertain tracks never reach the household map
  (the owner-only concern signal stays on Cassandra's Watch Desk — §7/§9.2). Retention 30 days.
  Smoke: `smoke:person-tracks` (fixture embeddings + injected sidecar transports, no live cameras).

**Made live + tuned (2026-06-15).** P2 went dormant→live; four live-integration fixes the unit
smoke can't catch: the collector reads the **event keyframe** not the live frame (empty a tick
later); the everyone-home prior suppresses only on a **confident `away`** (`unknown` ≠ away — iOS
geofence reads `unknown` most of the time; `ScoreContext.persons_away`); the collector pulls
**motion-only G3 Instants** via `gated_motion_detections` (interior rooms have no smart-detect);
the ArcFace backfill globs the enrollment dir. Body-ReID is clothing-dominated / same-day; measured
same-person cosine ~0.61–0.77 on the interior cams → `HEARTH_PT_BODY_MATCH` tuned 0.70→0.62. Track
births record the best **rejected** cosine (tuning telemetry); owner-only
`GET /api/specialists/cassandra/person_tracks_debug` is the observability surface.

**Build #1 — face-anchored daily appearance gallery (2026-06-15).** Face anchors are
single-digits-per-day and almost entirely at the doorbell (§3 measured), so a person is named
on a camera maybe once. This makes that sparse face-truth DENSE without new hardware: when a
track is face/cpai-anchored to person P, that detection's OSNet body vector is labeled "P,
today" into a per-person, per-LOCAL-day gallery
([person_gallery.ts](src/memory/stores/person_gallery.ts), self-contained store). An UNANCHORED
body track elsewhere then matches today's galleries (centroid + a few exemplars) and earns a
name via a NEW `identity_source: 'appearance_gallery'` — stamped BELOW a live face, ABOVE
unknown. Wired into the scorer's identify step as a fallback **after** fresh face/cpai and
**before** pure body-carry (it can NAME an unanchored track that carry never could). Honesty
rails: **only a fresh face/cpai anchor (ground truth) ever feeds the gallery** — never a
gallery-named or body-carried sighting (no self-reinforcement); galleries are LOCAL-DAY keyed
and the matcher only reads *today* (resets at the day boundary); away-gated; a gallery name
conflicting with a still-valid carried name → **uncertain** (never guess); a fresh face always
overrides. Dark behind `HEARTH_PT_APPEARANCE_GALLERY` (off → `advance_tracks` neither feeds nor
reads, no table created, byte-identical scorer). The debug read gains a `gallery` section
(per-person exemplar counts + `gallery_named_live`). Smoke: `smoke:person-tracks` (+gallery
store/scorer matrix + a cross-batch feed→match).

**Build #2 — belief-state occupancy estimator (2026-06-15).** Replaces last-seen
occupancy with a probability distribution over each person's room: a **discrete Bayes
filter (HMM filtering)** over the `home_map` adjacency graph
([occupancy_belief.ts](src/core/occupancy_belief.ts)) — state per person over
`{rooms} ∪ AWAY ∪ UNSURE`; PREDICT diffuses room mass along adjacency (carries belief
into camera-blind rooms) + leaks to UNSURE with time + a process-noise floor (states
stay recoverable); UPDATE multiplies a per-signal likelihood (reliability-weighted by
`strength`). Discrete Bayes, NOT a particle filter — the exact forward filter is
cheap/deterministic over a small room graph (a particle filter only approximates it +
needs banned RNG). Stateless recompute over a signal window → byte-identical
reproducibility; `summarize_belief` emits `in_room|likely_room|home_unsure|away`
without asserting a room the mass doesn't support. The glue
([occupancy_estimator.ts](src/core/occupancy_estimator.ts)) maps the existing signals
into `BeliefSignal[]` (`signals_from_sightings` names each person-detection by its
track; `signals_from_locations` rides home/away; the reliability ladder face > cpai >
gallery > ble > body_carry), runs the filter per enrolled person (no signal →
`verdict:'unknown'`), and `project_household_belief` sanitizes it for the
household tier. Surfaces: owner-only `belief` section on `person_tracks_debug` (the
measurement surface) + household-tier `GET /api/specialists/luna/home_belief`
(friend-excluded, member-filtered, room display names). Additive + gated
`HEARTH_OCCUPANCY_BELIEF` (off → no work; `get_household_occupancy()` untouched, its
last-seen point is the argmax this refines). Smokes: `smoke:occupancy-belief` (the
pure filter), `smoke:occupancy-estimator` (glue + projection).

**Build #3 (3a+3b) — multi-shot + quality-weighted track signatures (2026-06-15).**
Attacks track fragmentation. **3a**: a track's association signature becomes a
centroid + a few exemplars of its recent crops (derived from `person_sightings`,
no new schema; `build_track_signatures`), and the scorer matches a sighting against
`max(centroid, exemplars, latest body_sig)` — so a new-angle crop below the bar vs
the latest crop can still match a good exemplar, avoiding a fragment. Gated
`HEARTH_PT_MULTISHOT`. **3b**: [crop_quality.ts](src/core/crop_quality.ts) scores
each crop `confidence × size × edge` (resolution-independent when a frame-dims probe
succeeds, pixel proxy otherwise), DROPS tiny/edge-cut/low-confidence crops at
collection, and stores a quality (additive `person_sightings.quality` column) so the
multi-shot centroid is quality-WEIGHTED (`weighted_centroid`). Gated
`HEARTH_PT_CROP_QUALITY` (off → quality 1, byte-identical to 3a). `person_tracks_debug`
gains a `flags` block. Smokes: `smoke:person-tracks`, `smoke:crop-quality`. (3c —
mid-event frames — deferred as a live-CV follow-up.)

**Build #4 — auto-calibrated per-camera thresholds (2026-06-16).** Replaces the
single hand-set `body_match` (0.62) with a per-camera bar set from that camera's own
cosine statistics ([camera_threshold.ts](src/core/camera_threshold.ts) +
[camera_cosine_stats.ts](src/memory/stores/camera_cosine_stats.ts)). EXTEND cosines
are right-censored at the current bar, so the calibrator combines extend + REJECT
histograms ABOVE the different-people floor (the rejects are the sub-bar fragment
data), takes a low percentile, and clamps to `[floor, default]` — LOWERING an oblique
cam's bar toward its real same-person edge but never RAISING above the global default
(precision guard) nor below the floor. The scorer returns `assoc_sim` on every
decision; `advance_tracks` accumulates per-camera extend/reject cosines → the adaptive
bar (`body_match_by_camera`, keyed by the sighting's camera) on the next sweep. A
statistics-driven heuristic, gated `HEARTH_PT_AUTO_THRESHOLD` (off → byte-identical),
observable via `person_tracks_debug.camera_thresholds`. Smokes: `smoke:camera-threshold`,
`smoke:person-tracks`.

### WiFi-association presence — the shared-resolver corroborator (2026-06-15)

A household member whose phone is currently associated to the home UniFi APs is HOME — direct
evidence that overrides the edge-triggered iOS geofence (which reads `unknown` most of the time).
Reuses the existing UniFi connector: a new `list_active_clients` ([unifi.ts](src/connectors/unifi.ts))
reads `/proxy/network stat/sta` (active stations), surfacing the UniFi **alias** (user-set name) as a
field distinct from the device hostname. A `wifi_devices` store
([wifi_devices.ts](src/memory/stores/wifi_devices.ts)) maps device→**member** by alias and/or MAC.
[wifi_presence.ts](src/core/wifi_presence.ts) (`resolve_wifi_home` + the pure `apply_wifi_home`) fuses
into `resolve_household_locations` ([household_awareness.ts](src/core/household_awareness.ts), opt-in
`db`) so better home/away flows EVERYWHERE it's read (the P2 away-prior, the occupancy office, Kate's
brief). It confirms **HOME only — never forces `away`** (a device's absence could be WiFi-off; confident
`away` stays the iOS departure event's job). Gated `HEARTH_WIFI_PRESENCE`, fail-open. The same shape the
P3 BLE layer will use (device→person + an area read → a corroborating prior); the Ioniq 5 (Protect
vehicle/plate) is the next signal to slot in the same way. Smoke: `smoke:wifi-presence`.

## Cross-surface continuity

Status: **implemented in Prompt 7.** A conversation thread is keyed
by `(user_id, specialist_id)`, NOT by surface. When a user talks to Kate
by voice, then opens `/app` an hour later, the same conversation appears
with the morning's voice messages mixed in chronologically. Each message
records `surface ∈ {web, telegram, voice}` (the `telegram` value is a
legacy/historical-row artifact since the Telegram bridge was removed
2026-06-14 — see the Hermes history section) and the conversation tracks
`ts_last_*_message` per surface; the UI uses these to render a small
surface indicator (📱/💻/🎤) next to each message's timestamp (toggleable
in Settings; on by default).

The relay creates a new conversation when the most recent activity is
>24h old, on the assumption that "morning's chat" and "tonight's chat"
are usually different threads anyway. Below 24h the conversation
continues. This heuristic is intentionally coarse — it's better to
err toward "one long thread" than to chop conversations awkwardly.

`conversation_created` is a new SSE event so open browsers see new
threads appear in real time.

## Push notifications — two parallel paths

Status: **Telegram path live, APNs path queued.** Hearth pushes
notifications out via two surfaces that coexist; the right one fires
per user based on which surfaces they're registered on.

- **Telegram (live)** — `src/policy/push.ts:push_to_hermes` → push
  receiver on :8765 → Telegram Bot API, with fallback to direct
  Telegram and a `pending_pushes` queue if both fail. Briefs,
  proposal approvals, urgent flags. Owned by Hermes-on-mint's
  push-receiver service; Hearth posts JSON, receiver formats and
  sends.
- **APNs (planned, see PLAN.md)** — Hearth → `api.push.apple.com`
  via ES256-signed JWT, HTTP/2. iOS device tokens land at a
  not-yet-built `/api/apns/register` (iOS already calls it; today
  it 404s). Token storage in a new `apns_tokens(user_id,
  device_token, environment, bundle_id, registered_at, last_seen)`
  table; sender module at `src/policy/apns.ts`; integrated with
  the existing `push_text` / `push_approval` helpers so callers
  don't choose paths — the helpers fan out to whichever surfaces
  the user has live.

**Direct, not relayed.** iOS push goes Hearth → Apple → device,
*not* through Hermes/Telegram. This is a deliberate split: Hermes
serves the Telegram contract (which has its own auth + delivery
shape); APNs serves the iOS contract (Apple's HTTP/2 + JWT model).
Trying to unify them — e.g. having Hermes proxy APNs — would buy
nothing and obscure failures across two LLM hops.

**Token lifecycle.** APNs returns HTTP 410 when a device token is
no longer valid (user uninstalled, re-installed, switched Apple
ID). The sender treats 410 as authoritative and purges the row;
the next cold launch of the iOS app re-registers. 400 errors
indicate token format issues — log and drop.

**Sandbox vs production.** TestFlight + Debug builds receive
pushes via `api.sandbox.push.apple.com`; App Store builds via
`api.push.apple.com`. iOS reports its environment at register
time so Hearth picks the right endpoint per device. Mixing them
silently drops pushes — the topic + env pairing is strict.

## Spatial awareness

Status: **implemented in Prompt 7.5.** Local-first routing + geocoding via OSRM + Nominatim, optional Mapbox / Google fallback for traffic-aware ETAs, HA Companion app as the source of "where Jasper is right now," a Places vault namespace symmetric with People, and a 5-minute process-wide location cache that awareness handlers keep warm.

### The local-first stack and why

- **OSRM** for routing — three engines, one per mode (drive / bike / walk), because each profile produces an incompatible graph. Running them locally gives sub-100ms route responses (vs. 200-400ms for Mapbox API), and survives offline. Cost: ~1.5GB on disk for Colorado graphs, ~60-90 min first-build (mostly partition+customize).
- **Nominatim** for geocoding — addresses → coords, reverse-geocoding for "what neighborhood is this." Runs alongside OSRM in the same docker-compose stack.
- **Overpass** for POI search (the `nearby` tool) — `pharmacy within 5km`, `veterinary near my current location`. Defaults to a public instance because hosting a private Overpass needs OSM database snapshots. The pattern is "use the public one if the local stack isn't co-hosted; fall back to Mapbox Places if neither is reachable."
- **Mapbox / Google as opt-in fallback** — set `MAPBOX_TOKEN` and the connector layers a traffic-aware ETA on top of the OSRM free-flow ETA, picking the more conservative number. Add `GOOGLE_MAPS_API_KEY` for the same thing with Google's data. Without either, the system stays fully local.

The provider dispatch lives in [src/connectors/maps.ts](src/connectors/maps.ts) (`get_providers()` + per-tool dispatchers). New providers slot in by adding a `route_<provider>` / `geocode_<provider>` function and wiring it into the primary/fallback selection.

### HA Companion as the source of current-location truth

The HA Companion app on Jasper's phone reports lat/lon, GPS accuracy, activity (stationary / walking / cycling / automotive), battery, connection type, and the named HA zone he's currently in. Reading those is one HTTP call to HA's REST API.

We don't run a separate geofence — HA zones are already first-class entities in HA, the user defines them once in the HA UI ([integrations/home_assistant/ZONES.md](integrations/home_assistant/ZONES.md)), and `device_tracker.<phone>.state` is the zone name. The Places vault note for each significant location stores `ha_zone_name` so the two domains stay linked.

### Why the 5-minute cache

Refreshing location on every specialist turn or tool call would be wasteful — Jasper's not usually moving meaningfully within a 5-minute window, and HA already has the data with high precision. The cache is process-wide (one snapshot, shared across specialists), refreshed by:

- Awareness handlers for specialists with `read_my_location` (Kate, Iris, Cassandra) ticking the refresh on their cadence
- Lazy refresh in `get_current_location()` if the cached snapshot is older than the configured TTL

The TTL is the right tradeoff between freshness and overhead. If 5 minutes turns out to be wrong, [config/privacy.yaml](config/privacy.yaml)'s `location.snapshot_ttl_minutes` is the dial. A push-based path (HA webhook → `/api/location/push`) would give sub-second updates but is a Prompt-9-ish enhancement; the cache is good enough.

### Places as a vault namespace, symmetric with People

A Place is a markdown file with `type: place` frontmatter, just like a Person is `type: person`. The ingestor projects both into SQLite tables (`people`, `places`); both can have `coords`; both can have `address`; both get a vault-writeback when the geocode tool successfully resolves them.

The symmetry matters: if Kate routes to "Aunt Alex's house" the same code path resolves whether Alex has an `address` in her Person note or Alex's house lives as a standalone Place. The MemoryClient method `find_place_by_name` and the Person lookups co-exist; Kate's `upsert_place` tool creates and updates Place notes the way Scribe's `upsert_person_note` does for People.

### The per-user data cordon (2026-06-04)

The multi-user model has two data channels that the code keeps strictly
separate:

1. **System-improvement work** — Beatrice/Mariah proposals
   (recommendation / binding_proposal / persona_tuning /
   trusted_source_addition), process-miss escalations, `flag_beatrice`.
   This is "Hearth improving itself" and flows to the **owner regardless
   of which user's session triggered it**. In the `proposals` table these
   carry `user_id = NULL`; `SYSTEM_PROPOSAL_KINDS` in
   [proposals.ts](src/core/proposals.ts) forces NULL at create time.
2. **Actual user data** — chats, captures, uploads, specialist life-notes
   — is cordoned to the one user, *including from the owner*.

The cordon is enforced at the data-filtering layer (Phase 2b's third
defense, after `allowed_tiers` hard-refusal and per-tier discretion). The
key 2026-06-04 change is that **the owner no longer bypasses it**:
`note_visible_to_caller` ([private_to.ts](src/memory/private_to.ts)) is a
pure table — `owner`→owner, `household`→owner+household, `<user_id>`→that
user strictly. The earlier Phase 2b shipped the owner as broad-visibility
(a deliberate single-user-era default); the cordon inverts it so a
household member's (Sam's) and a friend's (Kim's) personal data never
reach the owner through any default surface (RAG, search, library,
captures, proposals).

Stamping is tier- and scope-aware (`stamp_private_to_if_needed`): friends
silo to themselves; owner/household *shared entities* (People/Places) are
communal at `household` (one family contact graph); all other writes —
including the owner's — stamp to the author. Newly user-scoped surfaces:
`clippings.private_to` + `library_files.private_to` (additive columns),
both search routes, the proposal queue + decide route, the `/files`
manager (owner-only), and the specialist-profile route (diagnostic fields
owner-only).

The single sanctioned cross-cordon path is **owner-oversight**:
[review_user_activity](src/specialists/kate/tools/review_user_activity.ts),
an owner-only (`owner_oversight` capability + hard tier check), audited
(`owner_oversight_review` row per call) tool that summarizes a non-owner
user's activity from their audit trail + captures + conversation topics.
It covers all non-owner users (the host retains oversight of guests AND
household members) but is explicit and logged, never passive — reconciling
"cordoned even from me" (true at every default surface) with "let me ask
what Kim's been up to." Friend tier (Kim) is a complete silo from every
*other* user; only the owner, via this tool, can review him. Legacy notes
were stamped by `scripts/backfill-private-to.ts`, after which the
fail-closed flip landed (2026-06-04): an unset `private_to` resolves
owner-only, so a forgotten stamp hides rather than leaks. User-less
internal callers (deliberation/scheduler) default to owner tier upstream,
so they still read unstamped system notes.

### Privacy posture: audit redaction default-on, capability allowlist explicit

Location is the most privileged data in the system. Two defense-in-depth layers:

- **Audit redaction** ([src/connectors/maps.ts](src/connectors/maps.ts) `redact_for_audit()`). Coordinates rounded to 3 decimals (~110m precision); street-level addresses stripped to `<city>, <region>`; `ha_get_my_location` records only zone + confidence + staleness in audit_log, never the raw coords (those live in HA's history; Hearth doesn't duplicate them in its audit). On by default in [config/privacy.yaml](config/privacy.yaml); flip `location.audit_redaction: false` only if you really want a location journal.
- **Capability allowlist** beyond the per-specialist capability flag. Even if a specialist's YAML grants `read_my_location`, the awareness handler and deliberation prompt-builder also check `location_specialist_allowed(specialist_id)` from privacy.yaml. The default list is `[kate, iris, cassandra]`. Editing this list is a deliberate act, not a side effect of granting a capability.

Map-based proactive monitoring (Iris noticing the car's charge is too low for tomorrow's plans, Kate noticing you need to leave for an event) becomes possible after this prompt and will land as part of P6c-style work extension in later prompts. The deliberation prompt now sees a one-line spatial context string — "Jasper is currently <activity> at <zone>, confidence: <h/m/l>, as of <ts>" — for specialists with both the capability and the allowlist entry. That's enough for the LLM to factor location into briefs naturally without exposing precise coords.

## Device-as-sensor pipeline

Status: **backend landed 2026-05-25; iOS feeders ship incrementally
(Focus → Calendar → CarPlay → Location → HealthKit).** See
[BACKEND_SENSORS_BRIEF.md](BACKEND_SENSORS_BRIEF.md) for the
implementation brief and [src/app/routes/sensors.ts](src/app/routes/sensors.ts)
for the live code.

Hearth treats Jasper's iPhone (and eventually Watch) as a sensor array,
not a chat client. iOS posts low-friction context signals — Focus mode,
calendar boundaries, CarPlay connect/disconnect, visit arrivals,
HealthKit aggregates — and Hearth turns them into derived projections
the staff can plan against. The shape:

```
POST /api/sensors/:signal              ingest SensorPacket {signal, captured_at, payload}
GET  /api/sensors/derived/:query       compute on read; cached
GET  /api/sensors/status               per-signal stats for Settings → Sensors
```

The richer `healthkit` payloads ship a typed sub-schema inside the
permissive `value` union — `WorkoutValueSchema` (session-end stats) and,
as of 2026-05-31, `ActivityRingValueSchema` (daily Move/Exercise/Stand
rings: raw achieved + goal + percent per component). The union stays
permissive at the route boundary for back-compat; consumers `safeParse`
the typed schema. The Move ring's raw `move_kcal`/`move_goal_kcal` is
Astrid's daily calorie-burn signal — it was the wire gap behind her
office showing no calories (iOS sent only percentages until the feeder
was fixed to emit raw kcal too).

Storage follows the "vault as source of truth" rule — the SQLite
`sensor_packets` table is index-only (id, user, signal, timestamps,
payload_path); the JSON payload bytes live at
`<vault_root>/Users/<user_id>/sensors/<signal>/<YYYY-MM-DD>/<captured_at>-<id>.json`.
One file per packet, daily-partitioned, append-only, easy to
re-encrypt or rotate by directory. Retention: 90 days raw on disk
(see [scripts/prune-sensor-packets.ts](scripts/prune-sensor-packets.ts)),
indefinite derived computation results.

**Iris owns the pipeline.** Every successful POST emits a
`sensor_packet_received` event with identifiers only (no payload)
on the app event bus; Iris's runtime subscribes and re-fetches via
the DB index when she needs the body. Kate also subscribes for
`derived/focus_mode` so her routing layer can gate non-critical
pushes while Jasper is in Sleep / Driving / Do Not Disturb.

**CarPlay is the strongest contextual signal in the v0.1 set.**
Connected = user is physically driving, hands occupied, attention
on road, phone reachable only by audio. Kate holds all non-critical
pushes while connected; the CarPlay app handles the foreground
voice surface. Disconnect = "arrived" timestamp for end-of-trip
briefings.

**Per-signal payload validation is strict** — Zod schemas reject
unknown fields. iOS sends a known shape per signal; anything
unexpected is a client bug worth surfacing immediately. Unknown
signal names pass through as `Record<string, unknown>` so iOS can
ship a new feeder before backend catches up.

**Rate limit: 60 packets/minute per (user, signal).** Burst is
tolerated — iOS replays queued batches on reconnect — so the cap
protects against a runaway feeder, not against normal catch-up
traffic.

**Caching:** derived signals compute on read from the latest raw
packets (no separate "derived" table). Cheap queries cache 30s;
the sleep aggregation gets 5 min. Every packet write invalidates
that user's cache entries.

**Auth gating:** the auth middleware sets `c.get('user')`; the
sensors route 401s anything unauthenticated. iOS authenticates via
the per-device bearer token; `device_id` is captured into each
packet row so the status endpoint can render "3 of 5 signals
connected from this iPhone."

Per-signal tier discretion is not applied — every Hearth user gets
the full sensor menu. Encryption at rest piggybacks on the vault's
existing per-user-key encryption (see "Vault as source of truth").

### OS-level integrations beat per-vendor connectors

The HealthKit feeder design (Astrid Pass 2, planned) tested a
principle that's worth naming: **when a third-party device already
syncs into an OS health/data store, ride that integration instead of
building a per-vendor connector.**

The naive read of "Astrid reads Withings scale data" suggests a
`src/connectors/withings.ts` with OAuth2, token refresh,
rate-limiting, vendor-specific schema mapping — the standard
external-API stack. The right read is: a Withings scale already
writes weight, body fat %, lean mass, BMI, and resting HR into Apple
HealthKit via the Withings Health Mate iOS app's HealthKit
integration. So the HealthKit feeder reads those sample types
(`bodyMass`, `bodyMassIndex`, `bodyFatPercentage`, `leanBodyMass`,
`restingHeartRate`) and the Withings data shows up automatically,
tagged with source metadata so provenance is clear. No OAuth flow.
No vendor-specific connector. No second integration to keep alive
when Withings rotates their API.

The principle generalizes beyond HealthKit. iOS Shortcuts can write
to the Reminders / Calendar / Notes stores; many smart-home devices
publish through HomeKit; many wearables publish through HealthKit or
Google Fit. When the device-as-sensor pipeline can read from the OS
aggregator, prefer that path. When the OS aggregator is unreliable
or doesn't carry the field you need (Withings-specific muscle quality
metrics aren't in HealthKit; some HomeKit accessories report a thin
slice of their actual state), then a per-vendor connector earns its
keep — but as the exception, not the default.

The shape this principle gives the codebase:
- One feeder per OS data store (`HealthKitSensorFeeder`,
  `HomeKitSensorFeeder`, `CalendarSensorFeeder`), each speaking the
  shared `/api/sensors/:signal` shape.
- Per-vendor connectors only when the OS store is missing the data
  or the device doesn't publish to one.
- The cost of adding a new device-shaped data source is "ensure it
  syncs to the OS store" rather than "build OAuth + schema mapping
  + retry logic."

## Browser specialist surface (the always-on host primary, the workstation last resort)

Status: **landed 2026-05-24 on the workstation; primary host moved to the always-on host 2026-07-28.** Kate, Maggie, Cordelia and any other browser-using specialist drive a real warmed Firefox session through the `browse_url` Tool. The connector lives at [src/connectors/avalanche.ts](src/connectors/avalanche.ts); the operational doc — failure boundaries, debugging, profile model — is at [operator/HEARTH-BROWSER-ARCH.md](operator/HEARTH-BROWSER-ARCH.md). This section is the *why*.

**The host moved because of power and heat.** the workstation is a workstation with a discrete GPU that had to POST and resume from S3 for every scrape, then idle at workstation draw until the drain timer put it back to sleep. the always-on host is already up 24/7 for other reasons, so a browse session there costs essentially nothing above idle — and the house evacuates heat slowly enough that a workstation spinning up for a calendar scrape is a real comfort cost, not just an electricity one. Everything below about warmed profiles, hardware WebGL, and agentd's contract is unchanged; only *which box* runs it moved, plus the sleep machinery becoming inert.

### The escape hatch from Firecrawl

Firecrawl (`web_fetch_clean`) handles the long tail of "give me this page as clean markdown" well. It does not handle:

- Cloudflare-walled venue calendars (Riverbend, Bluebird, Mission Ballroom, Red Rocks).
- PerimeterX-protected ticketing pages.
- JS-only event listings that don't render server-side.
- Anything that needs a session cookie warmed by months of human-like browsing.

For those, headless + stealth is not enough. The fingerprint signature of a fresh ephemeral browser is itself a bot signal. The reliable path is a **real warmed browser** — a profile with months of human history, real cookies, real plugin manifest, real WebGL renderer string from a real GPU — driven by WebDriver. This is the the workstation surface.

### Why Firefox + geckodriver, not Chromium + CDP

Earlier thinking favored headed Chromium driven via CDP, on the reasoning that CDP is more capable than WebDriver and Chromium has wider site coverage. The flip to Firefox + geckodriver was deliberate:

- **Profile isolation is first-class in Firefox.** `firefox -CreateProfile <name>` + `-P <name> --no-remote` gives each agent a completely separate `~/.mozilla/firefox/<name>/` with independent cookies, history, autofill, fingerprint baseline. Chromium's `--user-data-dir` is similar but the agentd spawning story is messier.
- **WebDriver is enough for what Maggie does.** She scrapes calendars and reads listings; she does not need CDP's network interception, performance traces, or coverage profiling.
- **One driver shape across agents.** Maggie's `browse_url` and a future librarian's deeper navigations both go through the same `withBrowserSession` helper. Adding Chromium later is a sibling connector if it's needed for a specific site, not a rewrite.

The corollary: **profile warming is non-negotiable.** A pristine Firefox profile that opens, visits one site, and closes is itself a bot signal regardless of how authentic the binary is. Jasper warms each new agent's profile manually — log into relevant sites, browse like a human for a couple of weeks, build up history — before any agent invokes it.

### Why the always-on host (and still not the LLM host)

The original three reasons named the workstation and explicitly ruled the always-on host out. Two of the three now argue *for* the always-on host, and the third stopped being true when the always-on host's hardware changed. What has NOT changed is the rule against the LLM host: it runs the entire household stack (Hearth ×3, HA, matter-server, mosquitto, maps ×4, nginx, beellama, *arr stack, FRIDAY mesh) and must never be one runaway Firefox tab away from OOM.

1. **GPU for WebGL fingerprint authenticity — satisfied.** The original objection to the always-on host was that it had no real GPU, which would force `llvmpipe` software rasterization. the always-on host is now an **small-form-factor box — Ryzen AI Max+ PRO 395 with a Radeon 8060S (the integrated AI accelerator)**, and its nested session gets genuine hardware GL:
   ```
   GL vendor:   AMD
   GL renderer: AMD Radeon Graphics (radeonsi, gfx1151, LLVM 20.1.2)
   ```
   Verified through the full stack — a WebGL probe in a live agentd session returns `UNMASKED_VENDOR_WEBGL: "AMD"`. **What gets fingerprinted is the vendor string** (`AMD` / `NVIDIA Corporation` vs `Mozilla` / `Mesa/X.org` for llvmpipe); the renderer model has been masked to `"…, or similar"` for every Firefox user since v122, so the always-on host reports `"Radeon HD 3200 Graphics, or similar"` exactly like every other AMD Firefox user. Blending into that population is *better* than exposing a rare workstation card. The iGPU is otherwise idle (0% busy, 547 MiB of 96 GiB VRAM), so nothing contends.
2. **Isolation from the always-on stack — still satisfied.** the always-on host is not the LLM host. A leaking scrape session is bounded to the FRIDAY kiosk box, not the Hearth stack. The real constraint there is RAM — 31 GiB of system memory, since 96 of the 128 is carved out to the iGPU — which is why the always-on host's activity probe blocks a session start on `memory_pressure` (see below).
3. **Sleep-when-idle — no longer a benefit, and the reason for the move.** This was the argument *for* a separate sleeping box. In practice it inverted: a bursty workload meant a workstation POSTing, resuming, and idling at workstation draw for every scrape, dumping heat into a house that clears it slowly. An always-on host that is up regardless makes the marginal cost of a browse session ~0. **the workstation is now a last resort, not a failover** — see "Escalation to the fallback host".
4. **Firecrawl already runs on the always-on host** (`firecrawl`, `-worker`, `-puppeteer`, `-redis`). Since `browse_url` is defined as the escape hatch *from* `web_fetch_clean`, hosting both on one box makes the entire escalation ladder a same-machine hop.

### The contract — agentd as the only LAN-reachable surface

agentd on the workstation exposes one port (:4446) with one shared auth token (`X-Agentd-Auth` on every call; mirrored from `~/.config/agentd/token` on both boxes). Geckodriver is **never** LAN-reachable; the WebDriver protocol is proxied through agentd's `/wd/session/*` routes. The endpoints Hearth's connector calls:

- `GET /health` — probe (no auth). Used to detect "is the workstation up?"
- `GET /status` — sessions, idle seconds, wake-marker presence **and whether it is honored** (`wake_marker_honored` + `wake_marker_reason`: `armed` / `no_marker` / `not_armed_at_ack` / `stale_cycle` / `unreadable`), wake-cycle id and origin, will-suspend-at.
- `POST /wake-ack` — the always-on host declares intent-to-work; writes the wake marker.
- `GET /can-start?agent=<name>` — pre-flight. 200 if clear, 409 if Jasper is at the keyboard.
- `POST /sessions` — spawn the per-agent stack (nested KWin + geckodriver + Firefox).
- `POST /wd/session/*` — proxied WebDriver, authenticated.
- `DELETE /wd/session/{id}` — clean shutdown; agentd reaps the spawned processes.

Reverse direction is not needed. the workstation never initiates to the
orchestrator.

### Two hosts: the always-on primary and the WoL last resort

The connector holds an ordered pair of hosts. Both speak the identical agentd
contract above; they differ only in whether they need waking.

| | **the always-on host** (primary) | **the workstation** (last resort) |
|---|---|---|
| env prefix | `BROWSER_*` | legacy `AVALANCHE_*` |
| reached at | `your-always-on-host.your-tailnet.ts.net:4446` | `192.168.0.11:4446` (health on `.83`) |
| wake | none — always on | WoL magic packet via the host-network relay |
| compositor | `weston --backend=headless --renderer=gl` | `kwin_wayland --virtual` |
| GPU | Radeon 8060S iGPU (radeonsi) | GeForce RTX 3090 |
| concurrent sessions | 3 | 1 |
| suspends when idle | never (`AGENTD_ALWAYS_ON=1`) | yes, 3-min drain |

**Addressing uses the Tailscale MagicDNS name, not the LAN IP.** the always-on host is on
WiFi with a DHCP lease, so `192.168.0.62` can move; the MagicDNS name cannot.
This also follows the standing rule against `.local` in app config. Verified
reachable from inside the `docknet` bridge.

**`BROWSER_HOST` unset ⇒ the primary IS the workstation**, and behavior is exactly
what it was before this tier existed. That is the migration property: the
two-host code path is inert until the env says otherwise.

#### Escalation to the fallback host

Reaching the workstation **powers a workstation on**. The escalation is therefore
deliberately hard to trigger, and the asymmetry is explicit: a false positive
costs heat and power, a false negative costs one page.

- It fires **only** when the primary successfully rendered a page **and** that
  page matches a known challenge/denial marker (Cloudflare `Just a moment…`,
  PerimeterX `Access to this page has been denied`, Akamai `Access Denied`,
  DataDome, and friends — `looks_like_bot_wall()` in the connector).
- It **never** fires on an error path: timeouts, capacity 503s, activity
  deferrals, stale profile locks, or an unreachable primary. Those are either
  retry-later conditions or would fail identically on the fallback.
- A short body, an empty title, or a slow render do **not** count. Too many
  legitimate pages look like that.
- It is gated behind `BROWSER_FALLBACK_ENABLED=1` and is skipped entirely when
  no primary is configured (escalating to yourself is pointless).
- If the fallback fails, the primary's walled page is returned rather than
  turning a partial result into a hard error.
- `browse_url` reports `served_by` so an escalation is visible in the audit log
  instead of silent.

#### Why the sleep machinery is inert on the always-on host, structurally

`AGENTD_ALWAYS_ON=1` does two things: the drain ticker — the only caller of
`systemctl suspend` — is never armed, and `/wake-ack` returns 409. Both matter.
agentd already refused to auto-suspend without a wake marker (invariant #1
below), but relying on "no marker was ever written" is incidental; on a box
running Home Assistant, the FRIDAY kiosk and Firecrawl, a stray suspend is
catastrophic, so the path is made unreachable rather than merely unused.

The 409 is load-bearing in the other direction too: the connector's `wake()`
throws on any non-200 from `/wake-ack`, so an always-on host **must** be paired
with a client in `alwaysOn` mode, which skips WoL and wake-ack and does a plain
reachability probe instead.

### Network path + Wake-on-LAN (the workstation only)

Since the 2026-05-29 consolidation the orchestrator runs on **the LLM host**
(in the `docknet` Docker bridge), and reaches the workstation over the LAN.
**This whole subsection now applies only to the fallback host** — the primary
needs none of it:

- **Two NICs, split by job.** the workstation's **copper** I219-LM
  (`enp44s31f6`, MAC `02:00:00:00:00:2d`, **192.168.0.83**) is the WoL +
  health/detection NIC — copper stays powered through S3 suspend and
  answers within a second of resume. The **10 GbE** NIC (`ens3`,
  **192.168.0.11**) carries the agentd session + WebDriver traffic. The
  connector splits these as `AVALANCHE_HEALTH_HOST` (.83) vs
  `AVALANCHE_HOST` (.11) so a slow-to-reassociate session NIC never reads
  as "box never woke." **The copper NIC is pinned static at 192.168.0.83
  in NetworkManager** (was DHCP `auto`) — a lease change while asleep
  would otherwise leave the post-wake `/health` probe pointed at the wrong
  IP even after a successful wake.
- **WoL goes through a host-network relay.** A magic packet the
  orchestrator broadcasts from inside `docknet` never crosses the bridge
  onto the physical LAN (the kernel won't forward a directed broadcast off
  a bridge without a host `bc_forwarding` sysctl, and the LLM host has no host
  sudo to persist one). So the connector POSTs the
  **`hearth-wol-relay`** sidecar
  ([ops/wol-relay/relay.ts](ops/wol-relay/relay.ts)) instead — it runs
  `network_mode: host`, shares the host net namespace, and broadcasts on
  the real LAN interface (`ens2f0`), the proven host-side wake path.
  Configured via `AVALANCHE_WOL_RELAY_URL` /
  `AVALANCHE_WOL_RELAY_TOKEN` / `AVALANCHE_WOL_BROADCAST=192.168.0.255`;
  the connector falls back to a direct broadcast if the relay is
  unreachable (correct for single-host deploys). See
  [ops/wol-relay/README.md](ops/wol-relay/README.md).

### Sleep / wake state machine

The point of having the browser host is that it sleeps when idle. agentd owns the state machine:

```
        ┌───────────────┐
        │     IDLE      │ (no sessions, evaluating periodically)
        └───────┬───────┘
                │ POST /sessions
                ▼
        ┌───────────────┐
        │    ACTIVE     │ (≥1 session live; no sleep evaluation)
        └───────┬───────┘
                │ last DELETE /wd/session/{id}
                ▼
        ┌───────────────┐
        │   DRAINING    │ (3-min countdown; new session resets it)
        └───────┬───────┘
                │ drain expired AND activity clean AND marker present
                ▼
        ┌───────────────┐
        │  SUSPENDING   │ → systemctl suspend
        └───────────────┘
```

Six invariants are load-bearing. The one-line form: **agentd may only suspend a box that agentd woke — this wake cycle.**

1. **No honored marker → no auto-suspend, ever.** Jasper booted it → he decides.
2. **Marker + activity → no suspend.** Something else is running (torrent, build, Steam, etc.); wait.
3. **Marker + clean + drained → suspend.** This is the entire point.
4. **Human input deletes the marker.** Once Jasper has touched the box, we never auto-sleep this wake cycle.
5. **A marker is scoped to one wake cycle.** It records the kernel suspend counter at `/wake-ack` time; once the box has slept and returned, the counter has moved and the marker is rejected as `stale_cycle`. Marker *presence* and marker *authority* are different questions — `/status` reports both (`wake_marker_present`, `wake_marker_honored`).
6. **If WoL wasn't needed, sleep isn't armed.** An ack only counts if it lands within `AGENTD_WAKE_ACK_WINDOW_SECONDS` (default 180) of the cycle starting. Reaching an already-awake box means it is up for someone else's reasons; Hearth may use it, but must not put it to sleep. The ack still returns `200` — it is logged as `wake_marker_set_unarmed`.

Invariants 5 and 6 are written in blood. On 2026-08-03 a single the LLM host wake at 06:01 left a marker that authorized **seven** auto-suspends that afternoon, across twelve resumes it had nothing to do with, under a desktop Jasper was actively using. Both the marker scoping and the idle probe were at fault; see "The idle sensor" below for why the second guard was also dead.

Hearth never touches the marker or the sleep logic. agentd owns that contract; Hearth signals intent (via `/wake-ack`) and agentd decides what to do with it.

### Takeover semantics

If Jasper walks up to the workstation mid-session:

- Maggie's running session is **not** killed. Her browser is on a nested KWin output Jasper cannot see; her work proceeds invisibly.
- Activity check next tick: `idle_seconds` drops to ~0 (via the swayidle sensor). agentd deletes the wake marker.
- When Maggie finishes and Hearth calls `DELETE /wd/session/{id}`, agentd tears down, drain timer fires, marker is gone → no suspend. the workstation stays up for Jasper.

If Jasper is at the keyboard — or gaming, watching media, on a video call — when Hearth wants to start a session:

- **The session starts anyway.** Because it runs on a nested `kwin_wayland --virtual` output Jasper can't see, human presence doesn't conflict with it. As of 2026-05-31 the `can-start` / session-start gate (`SESSION_BLOCKERS` in [activity.ts](../ops/agentd/source/src/activity.ts)) no longer treats presence signals — `user_input_recent`, `steam_running`/`steam_game_running`/`steam_remote_play_active`, `media_playing`, `video_conf_active` — as blockers. Jasper explicitly wanted browsing to proceed even while gaming, accepting the single-discrete-GPU contention trade-off.
- **A session is still deferred for genuine resource contention** — `external_ssh`, `compilation_running`, `package_manager_running`, `usb_imaging`, `large_file_transfer`, `sustained_network_high`. Those would actually fight a browser session for CPU/disk/network/USB. On those, `can-start` returns 409 and `browse_url` returns `{ deferred: true, defer_reason }`; the LLM calls `promise_followup` to retry later. Same structured `deferred` pattern used elsewhere — a success-with-no-result the LLM routes around, not an error.
- **The suspend gate is unchanged.** Auto-suspend (`isCleanForSleep`) still checks the FULL blocker list, so presence keeps the box awake — only the *start* gate relaxed, not the *drain* gate. Note this is the **second** guard, not the first: what actually protects Jasper is wake-cycle provenance (invariants 5–6), because a presence check can only be as good as the idle sensor behind it.

### The idle sensor

`user_idle_seconds` comes from **swayidle** speaking `ext-idle-notify-v1`, run as `agentd-idle-stamp.service` ([ops/agentd/avalanche-idle-stamp.service](ops/agentd/avalanche-idle-stamp.service)) and deployed by `deploy.sh` alongside the source and the probe. It maintains one file: absent means input within the last 10s, present means idle since its contents.

This exists because **under KWin/Wayland there is otherwise no way to measure idleness**: `org.freedesktop.ScreenSaver.GetSessionIdleTime` returns `NotSupported`, logind's `IdleHint` is never set by KDE, and reading evdev needs group `input`. The probe previously filled that gap by taking the newest mtime across `/dev/input/event*` — but the kernel never updates those mtimes on input. Measured 2026-08-03: every node on the box, PC Speaker and Power Button included, shared one frozen mtime of boot+9s. The probe was reporting **seconds since boot as idleness**, confidently, which both defeated the presence guard ten minutes into every uptime and shadowed the working fallback beneath it.

Two rules follow, and both are enforced in [avalanche-activity.sh](ops/agentd/avalanche-activity.sh):

- **A sensor that cannot measure reports `null`, never a number.** `null` means unmeasurable — not idle, not active. Callers must not coerce it to 0.
- **Do not reinstate the mtime heuristic as a fallback.** A sensor that reports uptime as idleness is worse than no sensor, because everything downstream believes it.

`null` idle deliberately does *not* block sleep. If it did, every legitimate remote wake would pin the box awake forever. Provenance is what protects a human at the keyboard.

### Privacy posture for browsing

Symmetrical to the location-data posture. Two layers:

- **Audit redaction** ([src/core/privacy.ts](src/core/privacy.ts) `browse_audit_redaction_enabled()`). URLs in audit_log are recorded host-only by default — `mishawaka.com` instead of `https://www.mishawaka.com/calendar?month=2026-06&genre=indie`. On by default in [config/privacy.yaml](config/privacy.yaml); flip `browse.audit_redaction: false` only if you really want a browsing-history journal.
- **Capability gating** through `browse_web`. Only specialists whose YAML grants this can invoke `browse_url`. Adding the capability to a specialist is a deliberate edit; reading the YAML answers "can this specialist see the open web through a real session?"

There is no per-specialist allowlist beyond the capability flag yet (unlike location's allowlist). If we add a second browser-using specialist later, that becomes the right moment to introduce one.

### Concurrency

- **Same agent + same host, concurrent calls** — the connector holds a `Promise` chain keyed on `(host, agent)`, so two concurrent Maggie turns queue cleanly. It is keyed on the *pair* because during an escalation one agent legitimately holds a session on each host; keying on the agent alone would deadlock that against itself.
- **Different agents, concurrent calls** — bounded by `AGENTD_MAX_SESSIONS`; past it agentd returns 503. the always-on host runs **3**, the workstation stays at **1**.

The v1 cap of 1 was hard-coded and justified by "until a second browser-using specialist exists, two agents wanting the browser at once isn't a real scenario." That stopped being true: Kate uses `browse_url` as her in-turn `web_fetch_clean` failover, so a chat turn now collides with any background scrape. The per-session plumbing (unique Wayland socket, unique geckodriver port from a 100-port range, per-agent profile) was always concurrent-capable — only the cap stood in the way. 32 threads and an idle iGPU carry 3 comfortably.

**A 503 is never a reason to escalate to the fallback host.** It means "come back shortly," not "this box can't render the page."

### The escalation pattern: Firecrawl → browse_url

`browse_url` is **the escape hatch from `web_fetch_clean` (Firecrawl)**, not a default-grade web tool. Firecrawl handles the long tail of "give me this page as clean markdown" well; it bounces off Cloudflare- and PerimeterX-protected pages with HTTP 403, an empty-markdown response, or a challenge-page body. The persona rule for specialists with both tools granted:

> Try `web_fetch_clean` ONCE on a given URL. If it errors or returns an obviously-gated body, fall through to `browse_url` on the same URL immediately — do not retry Firecrawl. Reserve `browse_url` for venue/ticketing/festival URLs and similar Cloudflare-walled targets; independent venue sites and band-owned domains usually pass Firecrawl cleanly.

Maggie's persona ([config/specialists/maggie.yaml](config/specialists/maggie.yaml)) carries this rule plus a hint about which sites typically need escalation (Ticketmaster, Live Nation, SeatGeek, StubHub; AXS / Bandsintown intermittent; band sites and indie venues usually fine). She picked it up cleanly on her first encounter in the 2026-05-24 South-Arcade / Honey-Revenge turn: Firecrawl on `seatgeek.com/idobi-radio-summer-school-tickets` returned no markdown, the next round was `browse_url` on the exact same URL, and the real Firefox session pulled 10K of page content.

The escalation costs one round per gated URL — which is why research-heavy specialists need a bumped [`max_tool_rounds`](#per-specialist-tool-round-budget). The two changes were calibrated together.

### What this surface is NOT

- **Not a planner.** browse_url loads a URL and returns text. Decision-making about which URL to load lives in the specialist's persona, the same as for `web_search` / `web_fetch_clean`.
- **Not a screenshot service.** Visual capture is its own concern; the v1 contract is text out. If a future Tool needs screenshots, that's a sibling Tool on the same client.
- **Not a generic browser-automation framework.** It's deliberately narrow — load, wait, extract. Form fills, login flows, multi-step navigation are sibling Tools under `src/specialists/<id>/tools/`, composed on top of `withBrowserSession`, not bolted onto `browse_url`.
- **Reached from the LLM host over the LAN (updated 2026-06-09).** This bullet
  previously read "Not the LLM host-reachable" — true only in the pre-2026-05-29
  the always-on host era. Since the consolidation the orchestrator *is* on the LLM host and
  reaches the workstation directly over the LAN (`.83` copper for wake/health,
  `.11` for the session), with WoL routed through the `hearth-wol-relay`
  host-network sidecar (see "Network path + Wake-on-LAN" above). What
  remains true: the workstation never initiates back to the orchestrator, and
  geckodriver is never LAN-reachable — only agentd's `:4446` is.

## Voice latency constraint for Prompt 8

Voice IN — asynchronous transcription of voice memos — is live as of
Prompt 7. The Hermes-on-mint push receiver runs faster-whisper
locally; Telegram voice memos transcribe in ~1-2s on CPU for short
clips (`small.en`), faster on GPU. This is fine because the user is
sending a memo, not having a conversation; the latency budget is
"reply within a few seconds."

Voice OUT — bidirectional real-time conversation via Pipecat — is
**Prompt 8** and has a much tighter budget. Pipecat assumes
**sub-second LLM response** so the conversation flows naturally. Qwen
3.6 35B running locally on ROCm produces 45-60 tok/s, which means a
typical 100-token reply takes ~1.5-2s — too slow for natural
turn-taking.

When Prompt 8 lands, plan for:

- **A smaller fast model dedicated to voice mode**, persona-injected
  per specialist. Candidate: a quantized 7B-13B model that can do
  120+ tok/s on the same hardware. Quality is lower; that's the
  tradeoff for naturalness.
- **A new `voice_realtime` role in `llm-roles.yaml`** so voice mode
  routes to the small fast model and the rest of the system keeps
  using Qwen 3.6.
- **Persona compression.** The full persona files are tuned for the
  reflective specialist runtime; voice mode needs a tighter prompt
  so the small model can keep up while still sounding like the
  specialist.

The web UI voice button (microphone in the composer) reuses the
Prompt-7 transcription path — it's voice-in only. Voice-out is its
own surface in Prompt 8.

### Pass 8 — what landed 2026-05-29 (infrastructure)

> **⚠️ RETIRED 2026-06-08 — read before trusting the stack below.** The Pipecat
> WebRTC voice loop is torn down (never wired to a live iOS client; its
> `LLM_URL` pointed at the decommissioned `:8089` tier, so it ran `unhealthy`
> and never completed a turn). Container + image `hearth/pipecat:0.1` removed;
> the `pipecat` compose service is profile-gated `["retired"]`. The
> CosyVoice→Kokoro and parakeet-NeMo→speaches-whisper pivots already superseded
> most of the detail below; **Kokoro** (pipecat-only) and the orphaned
> `Systran/faster-whisper-large-v3` were deleted in the same pass (~5 GB
> reclaimed). **Live voice = direct-client:** STT speaches whisper `:8093`, TTS
> Laur qwen3-tts on the the LLM host RTX 6000 Ada `:8023` (moved off forza 2026-07-02), LLM via `/api/conversations/:id/messages`;
> iOS / macOS / web own VAD + barge-in on-device. The working physical-device
> path is the ESP-direct coordinator (next section), not Pipecat. Kept below for
> history / rollback. See the private dev log "Pipecat real-time voice loop" for the full
> teardown note.

The "voice_realtime LLM role" and "smaller fast model dedicated to voice
mode" predictions above are now concrete:

- **9B is `unsloth/Qwen3.5-9B-Q4_K_M` + `Anbeeld/Qwen3.5-9B-DFlash` draft**
  — `unsloth/Qwen3.6-9B-GGUF` doesn't exist, so we went one generation
  back. DFlash speculative decoding preserved. ~6.5 GB on the A4000.
- **The 9B runs as a HOST systemd unit** (`llamacpp-9b-glacier.service` on
  :8089), NOT as a docker container. The PLAN's "container" language was
  aspirational; consistency with the existing host-side 27B
  (`llamacpp-glacier.service` on :8088) is the dominant constraint. Same
  beellama binary, different `--device CUDA0`.
- **`voice_realtime` role + per-role `base_url` override.** The pre-Pass
  8 router was single-endpoint (one `OPENAI_BASE_URL` env var). Pass 8
  adds an optional `base_url` per-role in
  [config/llm-roles.yaml](config/llm-roles.yaml); when set, that role
  gets its own provider instance and its own endpoint mutex. Voice
  (9B) and chat/deliberation (27B) run on independent endpoints on
  independent GPUs — concurrent turns don't serialize at the LLM
  layer.
- **`voice_aide` specialist** at
  [config/specialists/voice_aide.yaml](config/specialists/voice_aide.yaml)
  — narrow tool whitelist (6 explicit + the structural knowledge
  floor), conversational persona under 2 KB. `allowed_tiers: [owner]`
  for v0. The escalation discipline ("acknowledge first, escalate via
  `consult_deep_model`") lets the 9B handle 70 % of turns directly
  and lean on the 27B for the rest with natural conversational cover.
- **Pipecat container** at `/docker/pipecat/` chains
  ParakeetSTTService → HearthLLMService (POSTs to
  `/api/conversations/:id/messages`) → CosyVoiceTTSService with
  sentence-boundary chunking and per-stage cancellation on barge-in.
  WebRTC offer/answer at `POST /offer`; Hearth's `/api/voice/sdp`
  ([src/app/routes/voice.ts](src/app/routes/voice.ts)) is a thin
  proxy. The LLM stage hits Hearth's normal conversation API — tool
  calls, knowledge floor, capability gates, audit log, present_questions
  all work as they do in chat.
- **Parakeet** (`/docker/parakeet/`) is an NVIDIA NeMo
  `parakeet-tdt-1.1b` behind a thin OpenAI-compat FastAPI wrapper.
  Utterance-shape (not streaming partials); Silero VAD inside
  pipecat decides when to flush.
- **CosyVoice** (`/docker/cosyvoice/`) is the upstream
  FunAudioLLM/CosyVoice repo BIND-MOUNTED into a small CUDA image
  — keeps the untrusted upstream out of our image layer and makes
  upstream updates a `git pull` instead of a rebuild. Reference voice
  clones at `/docker/cosyvoice/voices/<name>.{wav,txt}`.
- **A4000 VRAM math:** 9B+DFlash ~6.5 + parakeet ~5 + cosyvoice ~2 =
  ~13.5 GB of 16 GB. Zonos (the current TTS) retained idle (no VRAM
  until used) for the first production week; planned retirement after.
  **FLUX runs on CPU**, not the A4000 — that's deliberate so it
  doesn't compete with the voice stack for VRAM. The Xeon Gold 6430
  (Sapphire Rapids) + AMX BF16 dispatch gives acceptable performance
  for the household's low-frequency banner/avatar regen workload.
  See `/docker/comfyui/Dockerfile` for the build (includes the
  upstream-stale `should_use_bf16` CPU gate patch).

iOS `HearthVoiceCoordinator` is a separate follow-up bundle — the
Hearth-side route + WebRTC proxy are ready when it lands. See the private dev log
"Pipecat real-time voice loop" for the operational view.

## ESP-direct full-duplex voice (Satellite1 coordinator)

The FutureProof **Satellite1** (`192.168.0.29`) can run as a **Hearth-direct
full-duplex voice device with barge-in** — Jasper interrupts Kate mid-sentence
— instead of going through Home Assistant's Assist pipeline. Design +
rationale: [docs/design-esp-direct-voice.md](docs/design-esp-direct-voice.md);
operational/deploy detail in
[integrations/voice-coordinator/README.md](integrations/voice-coordinator/README.md).
This is a *different* surface from the iOS/Pipecat `HearthVoiceCoordinator`
above (WebRTC/Pipecat, retired) — this one is the ESP-direct path for the physical
Satellite1.

**Why a coordinator, not custom firmware** (design §3, a > b > c): an
always-on `aioesphomeapi` client keeps the proven FutureProof firmware (XMOS
XU316 AEC, OTA, LEDs/timers, sensors) intact and makes Hearth the device's
"Assist server" — exactly how HA itself talks to the device. Lowest brick
risk, fully reversible (re-point to HA).

**The AEC gate (design §2) passed: FULL-DUPLEX GO.** The XU316 hardware AEC
suppresses Kate's own output out of the always-open mic well enough for
open-mic STT *over playback* — the interrupt phrase transcribed verbatim
(interrupt-phrase WER 0% by the substring metric, zero echo bleed) at
1 / 2 / 3 m with no distance falloff. So the architecture is full-duplex
barge-in on stock firmware, not a custom-firmware variant.

**Shape** ([integrations/voice-coordinator/](integrations/voice-coordinator/)):
a small Python container on the LLM host's host network (`:8094` `/health` + a
`/tts/<id>` clip server the device fetches its TTS from). `device.py` is the
aioesphomeapi wrapper; `state_machine.py` is the pure barge-in machine
(IDLE → LISTENING → THINKING → SPEAKING → (barge-in) → LISTENING, stdlib-only +
unit-tested); `coordinator.py` wires device ↔ Silero VAD ↔ parakeet STT ↔ the
Hearth conversation API ↔ forza TTS. Every Hearth route it needs already
exists — `POST /api/conversations {reuse:true,surface:"voice"}`, `.../messages`
(the lean voice turn), the `openai_shim` SSE, and crucially `.../cancel` (the
backend half of barge-in). Capture rides the **API-audio** transport
(`handle_start → 0` with the API_AUDIO flag + `handle_audio(data, data2)` — a
positive return would select UDP, `None` an error); SPEAKING is
**duration-driven sentence-streaming** (synthesize each reply sentence as it
streams in, play clips back-to-back via `media_player` announcements so the mic
stays open, sequenced by each clip's measured mp3 duration — anchored on the
device's PLAYING event, ended by its IDLE event); the LED ring is driven by the
firmware's own `VoiceAssistantEvents` (stt_vad_start → listening, stt_vad_end →
thinking, tts_start → replying, run_end → idle). The earlier "streaming stalls
45 s → one-clip buffer-then-speak" revert was a MISDIAGNOSIS: the device reports
IDLE reliably, but media-state was routed by display name ("Media Player") so
IDLE was dropped and end-detection fell back to a `bytes/2200` guess (a ~15 s
"ring stayed lit after she finished" lag); fixed 2026-06-08 by routing media
state by KEY.

**Reconnect + handoff.** `device.py` drives `aioesphomeapi.ReconnectLogic` so a
deployed daemon survives device reboots / wifi blips / the HA→coordinator
handoff: it dials by static IP (zeroconf omitted), runs enumerate + subscribe
in `on_connect` (re-run on every reconnect — the device drops its
subscriptions with the session), and retries with backoff. While HA still
holds the device the connect simply fails-and-retries (one voice client per
device — the Noise login fails for whoever doesn't hold the session), so the
container can run in standby *before* cutover without disturbing HA.

**Cutover is a config handoff, not a flash.** Disable HA's integration for
`.29` (frees the session) → bring up the coordinator container → it grabs the
freed session. **Rollback = re-enable HA's integration (~10 s, config not
firmware) + stop the container.** Verify restore via HA `/api/states`, never
the coordinator's own login (if *your* login succeeds, HA has NOT reclaimed the
device). Secrets — the device Noise PSK and the Hearth bearer — live only in an
`env_file` (`/docker/hearth/voice-coordinator.env`, chmod 600), never in YAML
or the image, mirroring the Code Shop secret rule.

## Why so much markdown

Almost everything the system reads or writes that isn't transient
operational state is markdown:

- Vault notes (people, journals, decisions, clippings)
- Audit log (dual-written: SQLite **and** `System/Audit/<date>.md`)
- LLM system prompts (`config/prompts/concierge_brief.md`)
- Persona files (`~/.hermes/SOUL.md`,
  `integrations/hermes/persona-snippet.md`)
- Memory files (`~/.claude/projects/.../memory/*.md`)
- Skill files (when those land in Claude integration)

**The principle: anything the user might want to read or edit in
five years should be a plain markdown file.** Anything that's purely
operational state (the SQLite tables, the `data/hearth.db` file) is
allowed to be opaque because it's *derived* from markdown sources
and rebuildable.

The corollary: when designing new state, ask "does the user
plausibly read or edit this in five years?" If yes, markdown. If no,
SQLite is fine.

## The approval gateway philosophy

The gateway is the enforcement point for the boundaries between what
the user has calibrated as "go ahead" vs "ask first" vs "never."
Three design choices matter:

### Policy lives in YAML, not code

[config/policies/v0.yaml](config/policies/v0.yaml) is the source of
truth for what gates what. It's:

- **Inspectable.** The user can read it and understand what the
  system will and won't auto-approve.
- **Version-controllable.** Policy changes diff cleanly. A future
  iteration tracks changes (git or audit-log style) so the user can
  see "in May 2026, I auto-approved family texts."
- **Hot-reloadable.** chokidar watches the file. Edit it, save,
  next evaluation uses the new rules. No restart.

A code-defined policy would be faster to evaluate (no YAML parsing)
and could be more expressive (arbitrary predicates), but the cost is
that policy changes require code changes, code reviews, and
deployments. For a personal system that calibrates over time, the
YAML cost is paid once and the user benefits forever.

### First-match-wins, with a required default

Rules evaluate top-to-bottom; the first match wins. The last rule
**must** be a catch-all (no `applies_when` or empty `applies_when`).
The engine refuses to boot without a default. This is a
fail-closed design — if the policy file is malformed in a way that
removes the default, the gateway logs an error and **keeps the
previous valid rule set** (it doesn't fall through to "allow
everything").

### Audit log is dual-written

Every action — including every gate decision — appears in two
places:

- `audit_log` table in SQLite, queryable.
- `System/Audit/<YYYY-MM-DD>.md` in the vault, human-readable.

Why both:

- **SQLite is queryable.** "Show me every approval-decision in the
  last week, grouped by tool."
- **Markdown is survivable.** If the SQLite file corrupts, the
  markdown audit is intact. If the user wants to grep the history,
  markdown is easier.
- **Markdown is editable.** The user can annotate the audit log
  (e.g. add a note explaining why they denied something) without
  having to schema-extend a database.

The cost is a small duplication. Worth it.

## Media Archive — URL → Serapeum (2026-07)

Hand Kate a URL; a detached runner downloads it, figures out what it is, files it
onto the NAS with a rich metadata note, and it becomes searchable + streamable.
Full design in [docs/design-media-archival.md](docs/design-media-archival.md); the
architectural contracts worth stating here:

- **The pipeline is model-decides / deterministic-acts (LAW #1).** Metrics are
  MEASURED verbatim from yt-dlp/gallery-dl (never LLM-authored); category / genre /
  creator are the planner's judgment over those real signals; NSFW is a DEDICATED
  classifier (not the VL — it fabricates identity); the download + file move are
  deterministic. `media_kind`'s gallery-ness is measured (from the downloaded files
  / extractor source), not the model's label — a video the model mislabels
  `image_gallery` gets that label stripped so the stream guard can't 404 it.
- **The cordon is the load-bearing layer.** Owner directive 2026-07-29 —
  *"archive content should be specific to the user that requested it."* Every
  archived item silos to its requester, SFW or not, whatever their tier:
  `private_to: <requester>`, with `'owner'` as the fail-closed fallback when a
  runner slice can't say whose it is. One definition, `media_cordon_for` /
  `tighten_media_cordon` in [src/core/media/cordon.ts](src/core/media/cordon.ts),
  read by both the write path and the repair sweep — two copies of a privacy rule
  is how a remediation pass ends up enforcing the policy it was written to
  retire. This replaced a tier-aware ternary whose SFW branch returned
  `'household'`, which put the NSFW classifier on the critical path of an
  *exposure*; siloing by requester takes it out of that blast radius, so a wrong
  verdict costs a mis-shelved folder rather than explicit content in front of the
  household. The verdict still drives the storage folder (`Private/…`) and the
  `nsfw` flag the clients use as a per-session PAINT gate — neither decides
  eligibility. Enforced at three layers: folder, index (`private_to` on the note →
  RAG/browse/search never leak), and the `/api/media/*` surface (a cordon miss is
  a 404-shape, never a 403-leak). Galleries are spatially independent, so **every**
  image is classified, not sampled — one explicit image cordons the whole set.
- **Visibility is ONE rule: the cordon OR a named grant.** A note may carry
  `shared_with: [<user_id>, …]` in frontmatter — an explicit, per-note, per-user
  grant on top of the cordon (media sharing, 2026-07-29). It never widens a
  tier, never covers a sibling note, and a user-less system caller can never
  match one. The rule lives in exactly one function pair —
  `note_visible_to_caller` / `note_frontmatter_visible_to_caller` in
  [src/memory/private_to.ts](src/memory/private_to.ts) — reached by every read
  path through one of two `MemoryClient` seams:
  `note_path_visible_to_caller` (live note; single-item reads, the RAG chunk
  gate, both vault-search surfaces) and `note_row_visible_to_caller`
  (candidate-then-confirm; the list reads). **Spelling the rule twice is the bug
  class:** three read paths passed only `private_to` while the chunk gate passed
  `shared_with` too, so a grantee's `search_library` returned a chunk from a
  shared item and the `read_note` on that very path answered *"not found… Try
  search_library"* — fail-closed, but a loop, and an item discoverable-but-
  unreadable by the one person it was shared with is not shared. Any new
  cordon-bearing read either goes through those two seams or documents at the
  call site why a grant cannot reach it (`media_archived` SSE fires before a
  grant can exist; a `media_archive_jobs` row is the requester's pipeline state,
  not the shared thing).
- **A grant may lag; a REVOCATION may not.** The share verb writes the note; the
  `media_items` projection is rewritten asynchronously by the ingestor. So a
  list read consults the projection only as a free CANDIDATE filter and then
  CONFIRMS the grant it claims against the live note — the file read is paid
  only for rows the projection already says are shared with this caller. A new
  grant therefore reaches browse/recent on the next reproject (seconds), while an
  unshare is authoritative the instant it is written even if the ingestor is
  slow, down, or disabled. Single-item reads pay nothing: one row, one live read,
  instant both directions.
- **Sharing: the server owns eligibility, state and copy; clients render and
  POST.** Owner directive — *"we need to start consolidating UI between WebGUI
  and iOS so you're not duplicating work."* Item detail carries a `sharing`
  object; `POST /api/media/item/:id/share` `{user_ids: [...]}` returns the SAME
  object **bare** (not `{ok, sharing}`), so one client decoder serves the read
  and the write. It is declarative **set replacement**, not add/remove:
  idempotent, lets the client be a pure renderer of a checkbox list, and two
  clients editing one item can't interleave into a wrong set; `{"user_ids": []}`
  unshares completely. `{can_share: false}` and nothing else when the caller may
  not share — a recipient has no business learning who else holds a grant, and a
  friend is never handed the household roster (they may share UP to the owner
  only). Otherwise: `shared_with` (ids resolved to display names + tier +
  `shared_at`), `targets` (the eligible pool, computed server-side and the ONLY
  ids the verb accepts), and three server-owned strings — `hint`, `empty_hint`,
  `state_label`. `state_label` is server-composed on purpose: joining names is an
  order/separator/locale decision that must not be made twice. Only the note's
  own owner may write a grant, only onto their own item; a cordon miss is 404,
  visible-but-not-yours is 403.
- **`media_shared` SSE, delivered to prior ∪ new.** The event publishes
  `{media_item_id, shared_with, by}`; its `deliver_to` audience is the union of
  the previous and new sets and is **stripped from the wire** by
  `sse_wire_payload`. The union matters: the REVOKED user is the one subscriber
  who most needs the event — their Archive is still showing an item they no
  longer have and nothing else tells them to refetch — and gating delivery on
  the new set alone silently excludes exactly them. Fail-closed for an
  unidentified subscriber.
- **Chapters are MINED when the source has none, and always attributed.**
  YouTube only builds a chapter bar when the UPLOADER puts a qualifying list in
  the description (starts at 0:00, ≥3 entries, ≥10s apart), so most of what gets
  archived here — live sets, DJ mixes, full-album uploads, long talks — arrives
  with no chapters even though the tracklist plainly exists on the page: in a
  description that missed those rules, or in a top comment a few hundred people
  upvoted. [src/connectors/media_chapter_mining.ts](src/connectors/media_chapter_mining.ts)
  recovers it. This stays inside LAW #1 because the timestamps are **parsed, not
  authored** — a deterministic text parse, no model anywhere on the path. Three
  contracts:
  - **Description first, then top comments.** The description is the uploader's
    own words and free (already in the probe). Comments cost one extra
    `yt-dlp --write-comments` pass, sorted top and hard-capped, replies never
    fetched (`max_comments=N,all,0,0`) — replies are where the cost explodes and
    an index never lives there anyway.
  - **Corroboration decides, and it is recorded.** Candidates rank by: the
    uploader wrote it (their own list, posted as a comment — description-tier
    trust, so it outranks any number of viewer thumbs) → `like_count` → a pin →
    detail. The winner's evidence persists as `chapter_source` on the note and is
    served on item detail, so a player can credit a viewer's setlist as a
    viewer's setlist. An absent `chapter_source` is NOT a claim of officialness
    (legacy items predate the field) — clients attribute only when present.
  - **A weak list is worse than no list.** Structural validation rejects
    anything that isn't an index of the whole item: <3 entries, any stamp past
    the duration, non-monotonic (that's commentary quoting moments), a last stamp
    inside the first 40%, or mostly-untitled. Everything is fail-soft — a mining
    failure never fails an archive job. Gated by duration
    (`HEARTH_MEDIA_CHAPTER_MIN_S`, default 300s) in the pipeline; an explicit
    `rescan_media_metadata facet:'chapters'` forces past the floor for one named
    item. Kill switch `HEARTH_MEDIA_CHAPTER_MINING=0`.
- **The NSFW classifier has no phone-home.** The MobileNetV2 sidecar
  ([ops/nsfw/](ops/nsfw/)) is a purpose-built CPU model on an `internal: true`
  Docker network with no gateway — zero outbound. It never needs the internet (a
  local read-only model + FastAPI); the isolation makes a phone-home structurally
  impossible even for TensorFlow's network-capable transitive deps.
- **Serving is direct-play.** The stored file is made AVPlayer-native at download
  time (remux/recode once), so `/api/media/stream/:id` is pure HTTP-range (206) with
  no per-stream transcode; galleries page via `/api/media/image/:id/:idx`. The web
  surface is an "Archive" tab on Kate's office (grid + inline video/audio player +
  gallery lightbox); the native iOS Archive tab is the deferred sibling.

## What we explicitly DON'T do

A list of capabilities deliberately omitted from v0 and why:

- **No multi-user support.** This is a personal system. The trust
  calibration is per-user; the persona is per-user; the vault is
  per-user. Sharing breaks the model. If two people want to use
  Hearth, they run two installs.
- **No public exposure.** Localhost-bound by default. Tailscale for
  remote access (the user has it set up; Hearth doesn't need to
  know). Never WAN-bind.
- **No vector DB as a service.** RAG Pass 7 shipped vector retrieval as
  a **BLOB column (`chunk_embeddings`) in the existing SQLite + brute-force
  cosine in JS** — adequate at vault scale (a few ms over thousands of
  chunks), no native extension, no new database. `MemoryClient.vector_search`
  is the one method to swap for an ANN index (sqlite-vec) if the corpus ever
  outgrows brute force; LanceDB was the older plan and proved unnecessary.
  No Pinecone, Weaviate, Qdrant. The vault is hundreds-to-low-thousands of
  notes, not millions.
- **No conversation streaming protocols beyond SSE.** When the
  unified web UI lands, SSE is the streaming primitive. No
  WebSockets unless we hit a specific need WebSockets uniquely
  solves.
- **No mobile app yet.** PWA is sufficient for v0 mobile (when the
  unified web UI lands). A real iOS app is on the roadmap but later.
- **No voice synthesis in Hearth.** FRIDAY Voice 2.0 lives at the
  UI layer; Hearth shouldn't grow audio-out plumbing.
- **No automatic execution of web actions by default.** Browser Use
  (Prompt 9) is Tier 2c by default — every web action requires
  approval. The user can grant per-site exceptions, but never
  globally.
- **No "AI ops dashboard."** The system is observed via the audit
  log and `journalctl --user`. If you want a dashboard, query the
  audit log. Adding a dashboard is YAGNI until proven otherwise.
- **No agent-to-agent protocol.** Specialists talk via the planner
  (post-6a) and inter-specialist messaging (post-6c) within the same
  process. There's no external A2A protocol because there are no
  external agents.

## The roadmap sketch

In plain English, where the prompt sequence is going. Pass numbering
reflects the actual session arc, not the original v0 plan in
the private shipped-log archive
(superseded; archived 2026-05-24).

**Three companion files own the active picture:**

- **[NEXT.md](NEXT.md)** — the ranked one-line
  index, cross-repo (hearth-backend + hearth-ios). The "what should
  I work on next" quick check. Tiers 1–5.
- **[PLAN.md](PLAN.md)** — canonical pending-work list with full
  detail per entry. **Forward-only**: Current + Future sections,
  Tier 1–5 subsections that mirror NEXT exactly. Status
  markers, full design notes per entry. Shipped items don't survive
  here.
- **[the private shipped-log archive](docs/archive/)** —
  chronological ship log, one file per month. The ship commit writes
  the entry directly into the current month's file (newest first).
  This is the human-scannable "what happened when" surface;
  regressions trace back through it without a git log spelunk.

This section is the *narrative* roadmap — load-bearing decisions
about what each pass is for and why it's ordered where it is. When
the trio disagree, NEXT + PLAN.md + the ship log are
current; this section is historical narrative. Update NEXT
+ PLAN.md + the ship log first; touch this section when a roadmap
*decision* shifts (a pass re-scoped, deprecated, or split).

- **Passes 1–5 (complete).**
  - Pass 1: Scribe toolset and `/scribe/*` routes, with a gateway
    stub.
  - Pass 2: Hermes integration (architecture shift — Hearth became a
    pure tool server; Hermes became the LLM-driven planner).
  - Pass 3: Ingestor — vault-to-SQLite projection.
  - Pass 4: Real approval gateway — YAML rules, ApprovalStore,
    inline-button push to Telegram.
  - Pass 5: Concierge read tools + scheduler. The daily brief lights
    up at 7 AM.

- **Pass 6 (next): Concierge drafting tools.** Send-external tools
  (Postmaster for email, future Twilio for SMS) gated by the
  approval gateway. The first time the system actually composes and
  sends a thing.

- **Pass 6a (done): The staff abstraction.** Kate the Chief of Staff
  and six SMEs. Each is a YAML config with persona, knowledge_scope,
  and capabilities. Hot-reloadable. Connector tools (Firecrawl,
  SearXNG, Home Assistant, CalDAV, FRIDAY UI) registered through a
  capability-gated tool registry. Three loops (awareness,
  deliberation, interrupts), proposals + autonomy graduation,
  `/api/*` HTTP routes for conversations/proposals/interrupts/search.

- **Pass 6b (done): The unified web UI.** Three-pane chat at `/app`:
  staff rail, per-specialist conversation, library + queue. Mobile-
  responsive PWA-installable. Live updates via SSE. Hiring modal.
  Library drag-drop scoped per specialist with immediate chunks_fts
  indexing for keyword search.

- **Pass 6c (done): Proactive staff loop.** Real awareness handlers
  for all 7 specialists, deliberation passes that produce structured
  JSON envelopes (inbox flags + proposals + interrupts + briefs),
  Kate-as-router with absorb/promote tools, the `briefs` table and
  morning-brief UI in Kate's right rail, the inter-specialist inbox
  routes (`/api/inbox`), weekly memory.md compaction, the envelope-
  on-new-message indicator with per-tab sync via SSE.

- **Pass 7 (done): Hermes thin-client refactor + real push + voice
  IN + quiet hours + slash commands.** Hermes-on-mint becomes a thin
  Telegram gateway over Hearth. A companion push receiver service
  bridges Hearth → Telegram with inline keyboards. faster-whisper
  transcribes voice memos and web-UI mic recordings locally. Quiet
  hours queue low-severity pushes overnight; the 60s sweep drains
  them at window end. Slash commands (`/brief`, `/pending`, `/kate`,
  `/quiet`, ...) and `@<name>` per-message redirects make the
  Telegram surface as expressive as `/app`.

- **Pass 7.5 (done): Spatial awareness.** Local OSRM + Nominatim +
  Overpass for routing, geocoding, and POI search; optional Mapbox /
  Google fallback for traffic-aware ETAs. HA Companion app as the
  source of current-location truth via a new `ha_get_my_location`
  tool. A new Places vault namespace symmetric with People. Process-
  wide 5-minute location cache shared across specialists. Privacy
  posture: audit redaction default-on, per-specialist allowlist in
  `config/privacy.yaml` enforced alongside the capability flag. Kate
  and Iris gain real spatial reasoning; Iris's `plan_ev_day` tool
  answers "will tomorrow's plans fit on this charge?" concretely.

- **Pass 7.6 (done): Browser specialist surface (the workstation).** the workstation
  becomes an on-demand load-bearing host alongside the always-on host and the LLM host.
  agentd on the workstation exposes a single LAN-reachable port (:4446) that
  spawns a per-agent nested KWin + geckodriver + Firefox stack on each
  session, with WoL-driven wake and a sleep-when-idle state machine. On
  the always-on host, [src/connectors/avalanche.ts](src/connectors/avalanche.ts) wraps
  the wake/can-start/spawn/teardown dance and exports a `browse_url`
  Tool gated by the new `browse_web` capability. Maggie is the first
  consumer — venue calendars that Firecrawl can't get past now route
  through a real warmed Firefox profile on the workstation's NVIDIA Blackwell
  GPU. Browse URLs are audit-redacted host-only by default via
  `browse.audit_redaction` in [config/privacy.yaml](config/privacy.yaml).

- **Pass 8 (planned): Pipecat real-time voice OUT.** Bidirectional
  voice conversation with a small fast model in a `voice_realtime`
  LLM role. See "Voice latency constraint for Prompt 8" above.

- **Pass 9 (planned): Send capabilities.** Real outbound channels —
  SMTP for email, Twilio for SMS, eventually Lob for postcards. Each
  gated, each calibrating its own tier-graduation.

- **Pass 10 (planned): Browser Use.** Tier 2c web actions for things
  no API provides — reserve a table, fill a form, navigate a
  government site. Default-deny, per-site exceptions.

- **Pass 11 (planned): Per-specialist proactive monitoring.** Vivian
  watches Plaid feeds for unusual spending; Cassandra watches HA
  logs for sensor anomalies; etc. Each specialist gets their own
  awareness loop with their own interrupt budget.

- **Astrid passes (interleaved):** Pass 1 shipped 2026-05-27 — the
  Trainer specialist (warm-blunt, dry goth) with `read_health` /
  `write_vault_astrid` capabilities, `update_astrid_vault` writer
  (5 kinds: profile / observation / session / coaching_log /
  memory), cold-start interview gate, self-documentation discipline.
  Reactive-only in v0.5. Pass 2 (planned) lands the iOS HealthKit
  feeder + `get_health_summary` + awareness handler + Brigid
  recovery-snack inbox handoff. Pass 3 (planned) lands the
  workout-streaming endpoint + live-session loop (see "The
  live-session loop" above) + PR shelf + push throttle + Live
  Activity. Pass 4 (planned) has Cordelia ingest a curated
  public-domain coaching corpus to Astrid's library shelf via
  `ingest_to_library`. Each pass is independently shippable; the
  staging in [PLAN.md](PLAN.md) carries the URL list and the iOS
  spec details.

- **Retrieval (interleaved): Embeddings (bge-large-en-v1.5)
  + FTS5 + RRF rerank + reranker (bge-reranker-v2-m3). Lights up
  semantic recall in specialist turns. Scope filtering by
  specialist's `knowledge_scope`.

- **Beyond:**
  - Native iOS app.
  - FRIDAY Voice 2.0 integration (the kiosk speaks).
  - Multi-modal capture: drop a photo into the Inbox, get a
    vision-captioned wrapper note.

## When in doubt

Read this file. Read the private dev log. Read the spec the user
maintains externally (the README references `hearth-v0-spec.md` but
it isn't checked in here). Then read [README.md](README.md).

If still unclear, **ask the user**. Don't guess. Architecture
decisions in this document are load-bearing; reversing them costs
more than asking once.

The user is comfortable with the stack and direct in feedback. A
brief "I can see two ways to do X — A or B; A has these tradeoffs,
B has these; I'd default to A unless [reason]" gets a fast answer.
A page of hedging gets impatience.
