# UniFi Network integration — Home Assistant setup

This walkthrough wires the UniFi Network controller into Home
Assistant so Cassandra can see LAN topology, clients, AP health,
switch state, and WAN status. Pairs with the existing UniFi Protect
integration (already in place — exposes the `honeysuckle_house_*`
camera/NVR sensors).

## What you'll get

Once the integration is in HA, expect these entity classes to
appear:

- `device_tracker.<client>` — every connected LAN/WiFi client. Tracks
  online/offline transitions.
- `sensor.<ap>_uptime`, `sensor.<ap>_clients`, `sensor.<ap>_signal_strength`,
  `sensor.<ap>_tx_bytes`, `sensor.<ap>_rx_bytes`.
- `sensor.<switch>_*` — per-PoE-port draw, total power, port state.
- `binary_sensor.<gateway>_wan` — uplink status (up / down).
- `sensor.<gateway>_uptime`, `sensor.<gateway>_cpu`, `sensor.<gateway>_memory`.
- `update.*` — pending firmware updates per device.

Plus actionable controls (gated, Cassandra is read-only):

- `switch.<ap>_<ssid>_<vlan>` — enable/disable per-SSID broadcast
- `switch.<switch>_port_<n>_poe` — power-cycle a PoE port

## Prerequisites

1. **Local admin credentials.** Create a dedicated local UniFi user
   for Home Assistant — do not reuse your owner login. UniFi UI →
   Settings → Admins & Users → Add new admin → "Restrict to local
   access only" → Role: **Site Admin** (the integration needs
   write-capable on the site even for read-only queries; HA respects
   the read scope at the entity level). Generate a strong password
   and store it in your password manager.

2. **Controller URL reachable from HA.** Confirm HA can reach the
   controller's local URL. From the HA host:

   ```sh
   curl -sk https://<controller-ip>:443/status
   ```

   should return JSON. If HA runs in a container, that container
   needs to reach the controller — usually trivial since they're on
   the same LAN.

3. **2FA on the local admin OFF.** The HA integration uses
   username/password; 2FA breaks it. The dedicated local-only
   account should have 2FA disabled even though your owner account
   keeps it enabled.

## Install

1. HA → Settings → Devices & Services → **Add Integration** →
   search "**UniFi Network**".

2. Configuration dialog:
   - **Host**: controller IP or hostname (e.g. `10.0.0.1`)
   - **Username**: the local admin you created
   - **Password**: same
   - **Port**: `443` (default; `8443` on legacy Cloud Key Gen1)
   - **Verify SSL**: **off** (UDM controllers ship a self-signed
     cert; turn this on only if you've installed your own CA on HA)
   - **Site ID**: usually `default`. If you have multiple sites,
     pick the one with this house's gear.

3. After submit, HA scans the controller and creates a device per
   AP / switch / gateway / client. The first scan takes 30-90s.

4. Configure the integration's options (cog → Configure):
   - **Track clients**: ON — this is the value-add for Cassandra.
   - **Track wired clients**: ON.
   - **Track devices** (APs / switches): ON.
   - **Block clients** / **Allow bandwidth control**: OFF unless you
     want HA to be able to actuate. Cassandra is read-only; Iris
     would be the actuator if you ever want one.
   - **Statistics sensors**: ON — gives you the `tx_bytes` / `rx_bytes`
     trend sensors.
   - **Ignored devices**: leave empty initially; prune later if
     entity count gets noisy.

## Verify

From the orchestrator host, hit HA's REST API and confirm UniFi
entities appeared:

```sh
curl -s -H "Authorization: Bearer $HA_TOKEN" \
  http://<ha-host>:8123/api/states \
  | jq -r '.[].entity_id' \
  | grep -E 'unifi|ap_|gateway|switch_|device_tracker\.' \
  | head -40
```

You should see a mix of `device_tracker.*` (clients), `sensor.*` for
APs/switch/gateway, and `binary_sensor.*` for connection state.

## Tell Cassandra

Once entities are in HA, update [Knowledge/Cassandra/unifi_inventory.md](../../../../vault-friday/Knowledge/Cassandra/unifi_inventory.md):

- Fill in the **Access points** table with friendly names mapped to
  physical locations (e.g. `kitchen_ap` → "Kitchen ceiling, U6 Pro").
- Fill in the **Switches** table with port budgets and powered
  devices.
- Fill in the **Gateway** row with WAN provider and IP type.
- Fill in VLANs and SSIDs.

This is the human-curated part — Cassandra reads it to translate
entity names into physical context. Without it she sees
`device_tracker.aabbccddeeff` and has no idea what device that is.

## Tighten her query pattern (optional, Tier 1.5)

By default `ha_list_entities` defaults to a `limit` of 50 — fine for
a domain but coarse for noticing what's new. Once Network is in
place, you may want to add a Cassandra background job that runs a
multi-domain snapshot every N minutes and writes a HIGH-trust state
file to `Knowledge/Cassandra/unifi_state.md`. That's a separate pass
— flagged in [unifi_inventory.md](../../../../vault-friday/Knowledge/Cassandra/unifi_inventory.md)
under "When you read this note" — kept out of scope here so the
first slice is just integration + inventory.

## Troubleshooting

**Auth fails on first connect.** Confirm 2FA is off for the local
admin and that the user is set to "Restrict to local access only."

**Entities don't appear after install.** Check HA logs:
`grep -i unifi /config/home-assistant.log` (or `journalctl --user -u
home-assistant` if running as a service). A common cause: the
controller is reachable but the integration is being asked to track
a site that doesn't exist — verify the **Site ID** field.

**Too many entities.** Once everything is in, HA may show 200+
UniFi-related entities. Use the integration's "Ignored devices" list
to hide guests / IoT clients you don't care about. Don't disable
entities globally; that breaks the controller-side mapping.

**Self-signed cert distrust.** Leave **Verify SSL** off. The local-
network connection between HA and the controller is the threat
boundary — TLS pinning here is not load-bearing.
