# the always-on host-side setup — the workstation browser surface integrated into Hearth

This documents the integration that landed on the always-on host when the workstation's
`agentd` came up. It's the Hearth-side record, written from Hearth's
conventions — what files changed, what's now wired, and how a future
session reasons about it.

This is **not** a fresh prompt to hand to Claude. The integration is
already done; this file describes it. For *why* the architecture looks
this way, see [`architecture.md`](../architecture.md) → "Browser
specialist surface (the workstation)". For *how* to add a tool that uses it,
see [`the private dev log`](../the private dev log) → "Adding tools that specialists invoke".

================================================================
Topology recap (Hearth's view)
================================================================

```
┌──────────────┐  qwen3.6   ┌──────────────────┐  agentd  ┌──────────────┐
│   the LLM host    │◄───────────│   the always-on host           │─────────►│   the workstation  │
│ :8088 LLM    │            │   Hearth         │  :4446   │   Firefox +  │
│              │            │   orchestrator   │   + WoL  │   geckodriver│
└──────────────┘            └──────────────────┘          └──────────────┘
                              `src/connectors/                One agent per
                              steamboat.ts`                   profile; sleeps
                              owns the wire.                  when idle.
```

Three hosts, three roles, one direction of browser traffic. **the LLM host
never talks to the workstation** — the LLM host is the always-on host's LLM upstream, period.
If you find yourself wiring a the workstation call from the LLM host, stop.

================================================================
What landed on the always-on host
================================================================

| Path | What |
|---|---|
| [`src/connectors/steamboat.ts`](../src/connectors/steamboat.ts) | Client (`SteamboatClient`, `getClient`, `withBrowserSession`, `DeferredError`) **and** the `browse_url` Tool. Single file, mirrors the firecrawl/maps connector pattern (env-driven config, lazy-init singleton, declared Tool registered automatically). |
| [`src/core/capabilities.ts`](../src/core/capabilities.ts) | Adds `browse_web` to the built-in capability set. |
| [`src/core/privacy.ts`](../src/core/privacy.ts) | Adds `browse.audit_redaction` config field and a `browse_audit_redaction_enabled()` export, symmetric with the existing `location.audit_redaction` posture. |
| [`config/privacy.yaml`](../config/privacy.yaml) | Adds `browse:` section, redaction ON by default. |
| [`config/specialists/maggie.yaml`](../config/specialists/maggie.yaml) | Grants `browse_web: true`; curates `browse_url` into both `tools_for_chat` and `tools_for_deliberation`. |
| [`package.json`](../package.json) | Adds `webdriverio@^9.27.1` as a runtime dep. |

Nothing else changed. The orchestrator auto-discovers the new tool —
`apps/orchestrator/server.ts` already scans `src/connectors/` via
`ToolLoader`, so no boot-wiring edit was needed. Capability gating in
`tool_registry` already denies any specialist whose YAML lacks
`browse_web` from invoking `browse_url`. No HTTP route mounting, no
plugin registration, no restart-required edit.

================================================================
Why a connector, not an integration
================================================================

The the workstation surface is *invoked by specialists in-process*. That's the
defining shape of a connector (`src/connectors/*`), not an integration
(`integrations/*`, which is for separately-deployed processes like
Hermes). Specifically:

- It's TypeScript, in-process, called by `execute()` in a Tool.
- It uses Hearth's ToolContext (`ctx.memory`, `ctx.intent_id`,
  `ctx.specialist_id`) directly.
- Its config lives in env vars + `config/privacy.yaml`, hot-reloaded
  through the same paths as every other connector.

If a second browser-using surface ever lands (e.g. a Chromium connector
for a site Firefox can't handle), it goes in as a sibling file —
`src/connectors/chromium_remote.ts` — not as a refactor of the steamboat
file.

================================================================
The browse_url Tool — schema and contract
================================================================

```ts
// src/connectors/steamboat.ts (excerpt)

export const browse_url: Tool<BrowseIn, BrowseOut> = {
  name: 'browse_url',
  risk: 'read',
  required_capabilities: ['browse_web'],
  // input:  { url, wait_ms?, selector? }
  // output: { url, title, text, extracted?, deferred, defer_reason?, fetched_at, error? }
  ...
};
```

Three contract points worth knowing when calling it from a specialist
or writing a sibling browse tool:

1. **`deferred: true` is a success, not an error.** When Jasper is at
   the the workstation keyboard, `agentd` returns 409 from `/can-start`. The
   Tool catches that as `DeferredError` and returns
   `{ deferred: true, defer_reason: 'user_input_recent', ... }`.
   The LLM should then call `promise_followup` to retry later. This
   pattern is the model-friendly equivalent of the
   `onDeferred` callback in the raw client.

2. **`text` is capped at 50,000 chars.** Real venue calendars can be
   enormous; the cap prevents one runaway page from blowing a turn's
   context. Use `selector` (CSS) when you want a focused slice.

3. **Per-agent serialization is built in.** The connector holds a
   per-agent `Promise` chain so two concurrent Maggie turns queue
   rather than race against agentd's per-agent serializer. Cross-agent
   calls (Maggie + a future librarian at the same time) will surface
   `agentd`'s 503 as a `deferred: false, error: ...`; lifting that
   needs agentd v2 (parallel nested KWin compositors).

================================================================
Audit redaction
================================================================

URLs are sensitive in the same way coordinates are. The Tool follows
the maps-connector pattern: `browse.audit_redaction: true` (default) →
audit_log records `host` only, no path or query string. To get full
URLs in the audit (e.g. for debugging a scrape failure), flip the flag
in `config/privacy.yaml` — chokidar will reload it without a restart.

Audit fields recorded per call:
- `agent`: `steamboat_connector:<specialist_id>` (so Maggie's browsing
  is distinguishable from a future librarian's)
- `tool_name`: `browse_url`
- `tool_input`: `{ url: <host|full>, wait_ms, selector }`
- `execution_result`: `{ ok, deferred, defer_reason, title (truncated),
  text_chars }`

================================================================
Environment variables
================================================================

Set in Hearth's environment (or the systemd unit drop-in for
`hearth-orchestrator.service`). All have defaults:

| Var | Default | Why |
|---|---|---|
| `STEAMBOAT_HOST` | `the workstation.local` | Resolves to the **wifi** interface (`ens3`, 10 GbE WiFi 7, currently 192.168.0.11). This is the **data path** — SSH, sshfs, and agentd HTTP all flow over wifi for throughput. |
| `STEAMBOAT_PORT` | `4446` | agentd's HTTP port |
| `STEAMBOAT_MAC` | `02:00:00:00:00:2d` | The **I219-LM copper NIC** (`enp44s31f6`, 1 GbE, 192.168.0.83). **WoL-only.** Copper stays powered through S3 suspend; the WiFi 7 NIC can't WoL through suspend reliably. Do not conflate the two interfaces: **copper wakes the box, wifi carries the work.** |
| `STEAMBOAT_TOKEN_PATH` | `~/.config/agentd/token` | Shared HMAC token with agentd |
| `STEAMBOAT_WAKE_TIMEOUT` | `90000` | ms budget for WoL → ready |

The token file must exist before any specialist invokes `browse_url` —
the first call will throw with a clear message if not. Pull it from
the workstation once:

```
mkdir -p ~/.config/agentd
scp jasper@the workstation.local:/home/jasper/.config/agentd/token \
    ~/.config/agentd/token
chmod 600 ~/.config/agentd/token
```

================================================================
Smoke
================================================================

Self-contained smoke (skips cleanly when the workstation is unreachable) at
`scripts/smoke-steamboat.ts` — TBD; the pattern is the same as
`smoke:connectors` for the existing optional services. Until that
lands, manually exercise from a the always-on host shell:

```bash
bun -e "
import { getClient, browse_url } from './src/connectors/steamboat';
const c = getClient();
console.log('health:', await c.health());
console.log('canStart:', await c.canStart('maggie'));
"
```

A fuller end-to-end test that confirms the GPU path: have Maggie hit
`https://browserleaks.com/webgl` and pull
`WEBGL_debug_renderer_info` from a fresh WebGL context via in-page JS.
The trustworthy signal is the **vendor** string, not the renderer:

- **Vendor must be `NVIDIA Corporation`** (or `AMD` / `Intel` if the
  hardware ever changes). Software rasterizers return `Mozilla`,
  `Brian Paul`, `Mesa/X.org`, `llvmpipe`, etc.
- **Renderer will return `"NVIDIA GeForce 8800 GTX, or similar"`** on
  any Firefox 122+ (so all of 151). This is Firefox's default
  FingerprintingProtection mask, applied to every user with FPP active
  in any mode — it is the user-realistic value, not a the workstation bug.
  Demanding the real Blackwell/RTX string would itself be a bot signal;
  practically no Firefox users see their actual renderer anymore.
- **Fail if vendor is missing or matches a software-rasterizer
  signature** — that means the nested KWin isn't hitting
  `/dev/dri/renderD128`.

================================================================
Failure modes — Hearth-side checks first
================================================================

| Symptom | Where to look first |
|---|---|
| `browse_url` returns `error: "token file not found"` | Token never scp'd. Pull it (above), no restart needed (lazy-init). |
| `browse_url` returns `error: "the workstation did not come up within 90000ms after WoL"` | the workstation BIOS WoL setting, or switch dropping magic packets. `ssh steamboat 'sudo ethtool enp44s31f6 \| grep Wake-on'` must show `g` (that's the I219-LM copper NIC we WoL on; the wifi `ens3` is not the WoL target). |
| Always `deferred: true, defer_reason: "user_input_recent"` | Working as designed — Jasper is at the keyboard. Maggie should `promise_followup`. |
| `browse_url` returns `error: "createSession returned 503"` | A second specialist is already in a session. v1 agentd serializes; Hearth's per-agent lock handles same-agent, but cross-agent collisions surface here. Sequence the work. |
| Audit log shows full URLs when you wanted host-only | Did someone flip `browse.audit_redaction: false`? Check `config/privacy.yaml`. |
| Audit log shows hosts when you wanted full URLs | Same — default is `true`. Flip it. |

For deeper debugging on the the workstation side, see
[HEARTH-BROWSER-ARCH.md](HEARTH-BROWSER-ARCH.md) — agentd journal,
WebGL sanity-check, nested-KWin inspection.

================================================================
What's deliberately NOT here yet
================================================================

- **`scripts/smoke-steamboat.ts`** — pending. The connector loads
  cleanly and individual calls work; an integrated smoke that asserts
  WebGL renderer + audit row + capability deny path is the next step.
- **Forced-teardown endpoint.** `client.deleteSession()` proxies through
  geckodriver. If geckodriver is the thing that's hung, there's no way
  to force a reap from Hearth without sshing into the workstation. agentd
  v1.x should add `DELETE /sessions/{session_id}` (out-of-band of the
  WebDriver path); when it does, add a `forceTeardown(session_id)`
  method to `SteamboatClient` and have `withBrowserSession`'s finally
  block fall through to it.
- **Orphan session reap on Hearth restart.** If the orchestrator
  crashes mid-session, agentd holds the Firefox + KWin until its own
  timeout. A `GET /sessions` (not yet defined) at boot would let
  Hearth ask agentd to clean up anything stamped with a stale
  Hearth-side intent. Low priority — sessions expire on the workstation side
  already; this just makes recovery quieter.
- **Sibling browse tools.** `browse_url` is intentionally the minimal
  shape. Domain-specific helpers (`browse_calendar_extract`,
  `browse_login_and_capture`) belong under
  `src/specialists/maggie/tools/` and compose on top of
  `withBrowserSession`, not as new connector entries.
