# hearth-wol-relay

A tiny **host-network** Wake-on-LAN relay so the orchestrator (which runs
in a Docker **bridge** network) can wake the workstation from S3 suspend.

## Why this exists

`browse_url` wakes the workstation by broadcasting a WoL magic packet. The
orchestrator container is on the `docknet` bridge; a broadcast it sends to
`255.255.255.255` (or even the LAN directed broadcast `192.168.0.255`)
**never crosses the bridge onto the physical LAN** — the kernel won't
forward a directed broadcast off a bridge without a host-wide
`net.ipv4.conf.<if>.bc_forwarding` sysctl, and the LLM host has **no host sudo**
to set (let alone persist) one. Result: the connector sent the packet
"successfully" but the box never woke
(`the workstation did not power on within 90000ms after WoL`).

This relay runs with `network_mode: host`, so it shares the host's network
namespace. A broadcast it sends egresses the real LAN interface (`ens2f0`)
directly — the exact path that wakes the workstation when a packet is sent from
the the LLM host host by hand. The connector POSTs here instead of broadcasting
from inside the bridge.

```
orchestrator (docknet) ──POST /wake──► host.docker.internal:9099
                                              │  (relay, network_mode: host)
                                              └─ UDP broadcast → 192.168.0.255 → the workstation copper NIC wakes
```

Verified 2026-06-09: a host-network container broadcasting to
`192.168.0.255` woke a suspended the workstation in ~29 s (BIOS POST + resume +
agentd up; the packet delivery itself is instant). The connector's 90 s
wake budget covers it.

## The contract

- `GET  /health` → `{ ok: true, service: "wol-relay" }` (no auth)
- `POST /wake { mac, broadcast?, port? }` with `Authorization: Bearer <token>`
  → sends the magic packet; `{ ok: true, mac, broadcast, port }`

The connector ([src/connectors/avalanche.ts](../../src/connectors/avalanche.ts))
uses the relay when `AVALANCHE_WOL_RELAY_URL` is set, falling back to a
direct broadcast if the relay call fails (correct for single-host deploys
and harmless in the bridge case).

## Env

Relay side:

| var | default | meaning |
|---|---|---|
| `AVALANCHE_WOL_RELAY_TOKEN` | — (**required**) | shared Bearer secret; unset ⇒ every `/wake` is refused (503) |
| `AVALANCHE_WOL_RELAY_PORT` | `9099` | listen port |
| `AVALANCHE_WOL_RELAY_BIND` | `0.0.0.0` | listen address |
| `AVALANCHE_WOL_BROADCAST` | `255.255.255.255` | default broadcast target (set to `192.168.0.255`) |
| `AVALANCHE_WOL_ALLOWED_MACS` | _(any)_ | optional comma-separated MAC allowlist |

Orchestrator side (same `hearth.env`):

| var | value | meaning |
|---|---|---|
| `AVALANCHE_WOL_RELAY_URL` | `http://host.docker.internal:9099` | where the connector POSTs |
| `AVALANCHE_WOL_RELAY_TOKEN` | _(same secret as relay)_ | Bearer sent to the relay |
| `AVALANCHE_WOL_BROADCAST` | `192.168.0.255` | broadcast the connector asks the relay to use |

Generate the token once, e.g. `openssl rand -hex 24`, and put the same
value in both `AVALANCHE_WOL_RELAY_TOKEN` lines. The token lives only in
`hearth.env` (never logged, never in a YAML/LLM-readable surface).

## Deploy on the LLM host

The live compose is `/docker/docker-compose.yml` (box-only, not in git).
Add this service (it reuses `hearth:latest` + the bind-mounted repo — **no
new image build**, just `docker compose up -d`):

```yaml
  hearth-wol-relay:
    image: hearth:latest
    container_name: hearth-wol-relay
    restart: unless-stopped
    network_mode: host          # share host net ns → real LAN broadcast
    env_file:
      - /docker/hearth/hearth.env
    volumes:
      - /docker/hearth/repo:/app
      - /app/node_modules
    command: ["bun", "run", "ops/wol-relay/relay.ts"]
```

No special capabilities are needed: sending a `SO_BROADCAST` datagram is
unprivileged, and the listen port is > 1024.

```sh
ssh your-llm-host.local
cd /docker/hearth/repo && git pull --ff-only origin main
#   add the service above to /docker/docker-compose.yml
#   add the env vars above to /docker/hearth/hearth.env (incl. a fresh token)
cd /docker
docker compose up -d hearth-orchestrator hearth-wol-relay   # recreate orch (env) + create relay
curl -s http://localhost:9099/health      # → {"ok":true,"service":"wol-relay"}
```

A code change to `relay.ts` needs only `docker compose restart
hearth-wol-relay` (bind mount). Env/compose changes need `up -d`.

## Test

`bun run smoke:wol-relay` — self-contained (no real LAN broadcast): drives
the handler with an injected send-capture and exercises the connector's
relay path + direct-broadcast fallback.
