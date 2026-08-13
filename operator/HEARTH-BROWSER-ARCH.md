# Hearth — browser specialist architecture

> **Historical.** This is the original design draft, written when the browser
> host was called `steamboat` (hence `/run/steamboat-wake/…` throughout). It was
> folded into [architecture.md](../architecture.md) and is kept for provenance.
>
> **Its SLEEP POLICY section is superseded and now wrong in one load-bearing
> way:** it scopes the wake marker to *uptime*. Markers are scoped to a single
> **wake cycle** (kernel suspend counter), and an ack that arrives long after
> the box woke does not arm sleep at all. See "Browser specialist surface
> (the workstation)" in [architecture.md](../architecture.md) for the live contract.

How Hearth's agents use a real, authentic Firefox session for live-web
work without disrupting the host workstation. Drop this into Hearth's
overall architecture doc; the **Claude.md guidance** section at the
bottom is the imperative-mood subset suitable for inclusion in
`CLAUDE.md`.

================================================================
TOPOLOGY
================================================================

```
┌─────────────────┐         ┌──────────────────────┐         ┌────────────────┐
│   the LLM host       │◄────────│   the always-on host               │────────►│   the workstation    │
│   <your-llm-host-ip>  │  Qwen3  │   Hearth runtime     │  agentd │   browser rig  │
│   RTX 3090      │  ──►    │   (Bun/TypeScript    │  :4446  │   (KWin 6.6 +  │
│   LLM tier      │         │   systemd user svcs) │         │   NVIDIA       │
│                 │         │                      │         │   Blackwell)   │
└─────────────────┘         └──────────────────────┘         └────────────────┘
                              Hearth's agents call
                              steamboat-client.ts to
                              reach the workstation over LAN.
```

**Three hosts, three roles, one direction of data flow.**

- **the always-on host** runs the Hearth orchestrator and all its sub-agents. Agents are
  TypeScript modules that import `steamboat-client.ts` when they need a
  browser.
- **the workstation** runs `agentd`, a single Bun/TypeScript daemon. It owns
  the entire browser stack (KWin nested compositor, Firefox, geckodriver)
  and a sleep/wake state machine. It exposes one HTTP port (`:4446`) to
  the LAN.
- **the LLM host** is the LLM tier — the always-on host asks it for completions. It does
  not interact with the workstation. Never wire them together.

================================================================
COMPONENTS
================================================================

### `agentd` (on the workstation)

A single Bun/TypeScript daemon at `/home/jasper/hearthoperator/agentd/`,
running as `systemd --user` service. It is the only LAN-reachable port
on the workstation's browser surface.

Responsibilities:

1. **Per-session spawn.** Each browser session triggers a fresh
   `kwin_wayland --virtual --xwayland` (nested compositor), a fresh
   `geckodriver` (bound to localhost), and a fresh Firefox with the
   requested agent's profile. Teardown reaps all three.
2. **WebDriver proxying.** Geckodriver is never LAN-reachable. the always-on host
   talks WebDriver through `agentd`'s `/wd/session/{id}/*` proxy. One
   shared auth token (`X-Agentd-Auth`) on every call.
3. **Activity awareness.** Shells out to `steamboat-activity.sh` for the
   "is Jasper at the keyboard" check. Pre-flight blocks if so.
4. **Wake / sleep state machine.** A wake marker in
   `/run/steamboat-wake/woken-by-wol` (tmpfs — cleared on every boot)
   tracks whether the current uptime was caused by the always-on host's WoL or by
   Jasper. Sleep is only attempted when the marker is present.

### `steamboat-client.ts` (on the always-on host)

A single TypeScript file imported by Hearth's agents. Wraps the agentd
HTTP surface and the WoL/wake/defer dance. The recommended call shape:

```typescript
await withBrowserSession({ agent, taskId }, fn, onDeferred);
```

Inside, it: waits for the workstation to be ready (sending WoL if needed),
runs the pre-flight, spawns a session, hands `fn` a `webdriverio`
Browser, and tears down in a finally.

### `steamboat-activity.sh` (on the workstation)

Independent bash helper, emits JSON. Read once per pre-flight and once
per drain tick. Encodes every "is something happening" check (user
input, external SSH, torrents, Steam, USB imaging, compilation, video
conf, etc.) in one place so agentd doesn't need to grow heuristics.

### Wake marker

A file at `/run/steamboat-wake/woken-by-wol` whose presence means
*"this uptime was started by the always-on host, so it's OK to suspend when idle."*

Lifecycle:
- the always-on host writes it via `POST /wake-ack` after sending the magic packet.
- agentd deletes it on every tick if it sees `user_idle_seconds < 60`
  (Jasper touched input → he owns the session now → stay awake forever).
- Reboot wipes it (tmpfs).

================================================================
LIFECYCLE FLOWS
================================================================

### Cold — the workstation suspended-to-RAM

1. the always-on host's agent calls `withBrowserSession`.
2. Client `GET /health` — connection refused.
3. Client sends WoL magic packet to `02:00:00:00:00:2d` (the workstation's
   I219-LM copper NIC; the wifi `ens3` does not WoL reliably on resume).
4. Client polls `/health` every 2s. the workstation resumes from S3 (Jasper's
   KWin session is intact); `agentd` (lingered) comes back within ~5s.
5. Client `POST /wake-ack { source:"mint", task_id }`. Marker written.
6. Client `GET /can-start?agent=maggie` — 200 (Jasper isn't there).
7. Client `POST /sessions { agent:"maggie" }`. agentd spawns nested KWin
   + geckodriver + Firefox; returns `{ gd_session_id, webdriver_base }`.
8. Client `webdriverio.attach()` → user code runs → `browser.deleteSession()`.
9. agentd's drain timer fires 3 min after last session ended, re-runs the
   activity check, sees marker + clean → `systemctl suspend`.

### Warm — the workstation awake, Jasper away

1. `GET /health` — 200 immediately.
2. **Client still POSTs `/wake-ack`.** Wait — actually no, only on cold.
   Re-read the client: if `health() != null` it skips WoL but still
   POSTs wake-ack. *This is intentional* — it marks "agent intent to
   work" but doesn't change the policy: if Jasper was here recently, the
   marker gets cleared on the next tick anyway, and agentd never
   suspends an unclean machine.
3. Pre-flight, spawn, run, tear down (same as steps 6–8 above).
4. Drain timer: marker may have been cleared by Jasper's recent input →
   stays awake. Or marker still present → suspends. Either way, the
   *agent* doesn't care — it's done.

### Takeover — Jasper walks up mid-session

1. Jasper touches keyboard. Activity check next tick: `idle_seconds = 0`.
2. agentd deletes the wake marker.
3. Maggie's running session is **not** killed — her browser is on a
   nested KWin output Jasper cannot see; her work proceeds invisibly.
4. When she finishes and the always-on host calls `DELETE /wd/session/{id}`, agentd
   tears down, drain timer fires, marker is gone → no suspend.
5. the workstation stays up for Jasper.

### Takeover — Jasper at keyboard when agent wants to work

1. `can-start` returns 409 with `{reason:"user_input_recent", details:{
   user_idle_seconds: 12}}`.
2. Client invokes `onDeferred(reason)`. Hearth's agent schedules a
   `promise_followup` (e.g. "retry tonight at 2am").
3. Jasper is never interrupted; never even knows Maggie tried.

================================================================
PER-AGENT PROFILE MODEL
================================================================

Each agent that browses gets its own `~/.mozilla/firefox/<agent>/`
profile:

- `maggie` — music/concert discovery
- `librarian` — research (future)
- `shopper` — purchase tracking (future)

Profiles are independent (separate cookies, history, autofill,
fingerprint baseline). New agents are added in three steps:

1. `firefox -CreateProfile "<name> /home/jasper/.mozilla/firefox/<name>"`
2. Drop the standard `user.js` (see the workstation `prompt.md` Part 2).
3. **Jasper warms it manually** — log into relevant sites, browse like a
   human for a couple of weeks, build up history.

No agentd code changes. The daemon reads the agent parameter and routes.

**Profile warming is non-optional.** A pristine Firefox profile that
opens, visits one site, and closes is a strong bot signal regardless of
how authentic the browser binary is.

================================================================
SLEEP POLICY
================================================================

agentd's sleep state machine, in detail:

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
        │  SUSPENDING   │ → systemctl suspend → machine asleep
        └───────────────┘
```

Critical invariants:

1. **No marker → no auto-suspend, ever.** Jasper booted it → he decides.
2. **Marker + activity → no suspend.** Something else is running
   (torrent, build, Steam, etc.); wait.
3. **Marker + clean + drained → suspend.** This is the entire point.
4. **Human input deletes the marker.** Once Jasper has touched the box,
   we never auto-sleep this uptime.

================================================================
FAILURE BOUNDARIES & DEBUGGING
================================================================

| Failure | Owned by | First check |
|---|---|---|
| WoL doesn't wake | the workstation BIOS / network | `sudo ethtool enp44s31f6 \| grep Wake-on` (must be `g`) on the workstation — that's the I219-LM copper NIC we WoL on. BIOS must have Wake-on-LAN enabled for the copper interface; the switch port must pass magic packets through. Don't check `ens3` (wifi) — that interface is not the WoL target. |
| agentd unreachable after wake | the workstation | `ssh the workstation 'systemctl --user status agentd'` |
| 401 from any endpoint | Token mismatch | `diff` the token file on the always-on host vs the workstation |
| 409 always | Activity check false positive | `ssh the workstation 'steamboat-activity.sh --human'` |
| Session create hangs | KWin/geckodriver spawn fail | `journalctl --user -u agentd -n 100` on the workstation |
| WebGL says llvmpipe | Nested KWin not hitting GPU | the workstation-side bug — agentd should use `/dev/dri/renderD128` |
| Suspend never fires | Marker gone or activity dirty | `cat /run/steamboat-wake/woken-by-wol` + `steamboat-activity.sh --human` |
| Suspend fires while session active | Bug in state machine | `journalctl --user -u agentd` — should never happen; if it does, file it |

**Operator's debug command on the workstation:**

```
journalctl --user -u agentd -f
```

shows all session lifecycle events, drain ticks, and suspend decisions.

**Watching Maggie work** (rare, debug only): see `HANDOFF.md` step 5 —
stop her session, manually spawn `kwin_wayland --width 1920 --height 1080
--xwayland --socket debug-peek`, run `WAYLAND_DISPLAY=debug-peek firefox
-P maggie --no-remote`. You'll see her profile in a real desktop window.

================================================================
FUTURE EXTENSIBILITY
================================================================

- **Adding agents** is a profile + warming pass + Hearth-side wiring.
  agentd doesn't change.
- **Concurrent sessions** (Maggie + librarian at the same time): agentd
  v1 serializes; lifting this means spawning multiple nested KWin
  compositors in parallel (each gets its own socket, port, profile).
- **WebDriver BiDi** (event streams, websocket): not in v1 proxy. When
  needed, agentd's `/wd/*` handler grows websocket support.
- **Non-Firefox agents** (e.g., Chromium for a site Firefox can't
  handle): would require a chromedriver branch in agentd. Don't add
  until forced; Firefox+profile is the unified model.
- **Other hosts** (e.g., a future the workstation-like rig in another room):
  the agentd API is host-agnostic. `configureClient()` can take any
  reachable host + matching token.

================================================================
CLAUDE.MD GUIDANCE
================================================================

Imperative-mood subset suitable for inclusion in Hearth's `CLAUDE.md`:

> ### Working with the browser specialist
>
> Hearth has one browser surface: `agentd` on the workstation
> (`the workstation.local:4446`). the always-on host-side agents reach it through
> `lib/steamboat-client.ts`.
>
> - **To do anything that requires a real browser, use
>   `withBrowserSession({ agent, taskId }, fn, onDeferred)`.** Do not
>   instantiate webdriverio directly; the helper handles WoL, wake-ack,
>   pre-flight, and teardown.
> - **Always pass `onDeferred`** that schedules a follow-up. If
>   pre-flight returns 409 (Jasper is at the keyboard), the task must be
>   deferred — never bypassed, never retried in a tight loop.
> - **Each agent has one profile.** Don't share profiles between agents.
>   Don't create profiles ad hoc — they need a human warming pass before
>   first use.
> - **Don't run agents in tight parallel.** agentd serializes
>   concurrent sessions for the same agent; for different agents it
>   currently 503s. Sequence your work.
> - **Don't touch the wake marker or the suspend logic from the always-on host.**
>   That's agentd's contract; Hearth only signals intent via
>   `wake-ack`. agentd decides when to sleep.
> - **the LLM host never talks to the workstation.** the LLM host is your LLM upstream
>   from the always-on host. If you find yourself wiring a the workstation call from
>   the LLM host, stop.
> - **Debugging an agent's browser run starts at:** `ssh
>   the workstation.local 'journalctl --user -u agentd -f'`.
> - **WebGL diagnostic check the VENDOR, not the renderer.** Firefox
>   122+ masks `UNMASKED_RENDERER_WEBGL` to a canned
>   `"NVIDIA GeForce 8800 GTX, or similar"` for every user via
>   FingerprintingProtection — this is the expected user-realistic
>   value. The trustworthy GPU-path signal is
>   `UNMASKED_VENDOR_WEBGL`: a real NVIDIA card returns
>   `"NVIDIA Corporation"`; software rasterizers return `"Mozilla"`,
>   `"Brian Paul"`, `"Mesa/X.org"`, or contain `"llvmpipe"`. Demanding
>   the real Blackwell/RTX string in the renderer would itself be a
>   bot signal — practically no Firefox users see their actual
>   renderer anymore.
