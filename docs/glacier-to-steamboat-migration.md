# the LLM host → the workstation migration runbook

Migrate the primary host from **the LLM host** (Intel Sapphire Rapids, 3090 + A4000)
to **the workstation** (workstation-class, Intel Granite Rapids, 4× DW slots → A4000 + 6000 Ada + 3090).
Strategy: **fresh Ubuntu Server on the workstation + rsync the bind-mount trees** (the stack
is Docker config-as-code), keeping old the LLM host alive as a fallback until cutover.
forza (GB10 deep/vision tier) is **not** part of this move.

> Generated from a live inventory of the LLM host on 2026-06-08. Re-run §0 commands to refresh
> before executing — sizes/usage drift.

---

## TL;DR shape

1. **Build the workstation base** while the LLM host runs hot (Ubuntu Server, Docker, NVIDIA, NAS mounts).
2. **Pre-sync** the big static data (models, maps, Plex metadata) hot, over 10 Gb.
3. **Cutover window** (the LLM host stack stopped, ~15–30 min): final cold delta-sync of stateful
   DBs → move the GPUs into the workstation → `docker compose up` → verify.
4. **Assume the LLM host's identity** (IP `<your-llm-host-ip>`, hostname, Tailscale node, TLS certs) so
   nothing downstream needs repointing.
5. **Keep old the LLM host's M.2** untouched as the rollback.

---

## §0 — Data & service map (from live inventory)

### Storage reality
- **Boot/OS M.2:** `nvme1n1` (953 G Samsung) → `/` is **810 G used / 937 G (92 % FULL)**.
  Everything local lives here. *(The 2nd NVMe `nvme0n1` is a BitLocker/NTFS Windows disk —
  unused by Linux, ignore or repurpose.)*
- **Media = NAS over SMB, does NOT migrate** — just re-mount on the workstation:
  - `//192.168.0.205/Alexandria` → `/mnt/nas` (65 T vol, 29 T used) — Movies, Music, books, Downloads, Transcode
  - `//192.168.0.206/Serapeum` → `/mnt/nas2` (65 T vol, 39 T used) — TV Shows, photos, maggie/torrents, youtube
  - `/mnt/nas2/TV Shows` → `/mnt/media-tv` (bind remount)

### Local data to migrate (~810 G on the M.2) — biggest first

| Tree | Size | Type | How to migrate |
|---|---|---|---|
| `/docker/comfyui` | 65 G | FLUX/AI models | rsync (or re-download) — **keep** |
| `/docker/plex` | 61 G (20 G = metadata DB) | stateful config | **stop plex**, tar-over-ssh (small-file heavy) |
| `/docker/ollama` | 17 G | model cache | **verify if used** — not in compose; likely **prune** |
| `/docker/homeassistant_config` | 8.1 G | HA config + recorder DB | **stop HA**, cold rsync |
| `/docker/maps` | 7.9 G | built OSRM + Nominatim data | rsync (rebuild = hours) |
| `/docker/parakeet` | 7.6 G | STT whisper models | rsync (re-downloadable) |
| `/docker/hearth-embeddings` | 6.8 G | RAG bge models | rsync (re-downloadable) |
| `/docker/radarr` `/lidarr` `/sonarr` `/readarr` | ~9.7 G | *arr configs + SQLite | **stop**, cold rsync |
| `/docker/speaches-cpu-cache` | 4.4 G | OCR/STT cache | rsync or re-pull |
| `/docker/gitea` | 231 M | git repos (**origin remote!**) | **stop**, cold rsync |
| `/docker/hearth` | 1007 M | vault + `hearth.db` + library + repo + apns + agentd-token | **stop**, cold rsync |
| `/docker/tautulli` `/mealie` `/music-assistant` `/overseerr` `/matter-server` `/mosquitto` `/qbittorrent_config` `/searxng` `/sabnzbd` `/nginx` `/friday_*` | <300 M each | stateful configs + **TLS certs** | cold rsync |
| `/home/jasper/llm` | ~9 G+ | beellama build + 9B GGUF (`qwen35-9b/…Q8_0.gguf`) | rsync (host inference) |
| `/var/lib/docker/volumes` | TBD | named volumes (`docker_hearth-nominatim-data`, `docker_firecrawl-redis`, ~10 anon) | migrate named vols (see §5) |
| **DEAD — do NOT migrate** | — | retired | `cosyvoice` 72 M, `pipecat` 338 M, `kokoro-tts`, `Zonos`/`zonos-api` (if unused) |

> `du -sh /var/lib/docker` and `/home/jasper/llm` were not captured — get them in the refresh pass.

### Services (40 compose services in `/docker/docker-compose.yml`)
`comfyui` `comfyui-2` `cosyvoice`✗ `firecrawl` `firecrawl-puppeteer` `firecrawl-redis`
`firecrawl-worker` `friday-watchdog` `friday-writer` `gitea` `hearth-ingestor`
`hearth-nominatim` `hearth-orchestrator` `hearth-osrm-bike` `hearth-osrm-drive`
`hearth-osrm-walk` `hearth-scheduler` `hearth-voice-coordinator` `hearth-wol-relay`
`homeassistant` `lidarr` `matter-server` `mealie` `metube` `mosquitto`
`music-assistant-server` `nginx` `overseerr` `parakeet` `plex` `qbittorrent` `radarr`
`readarr` `rreading-glasses` `rreading-glasses-db` `sabnzbd` `searxng` `sonarr`
`tautulli` `zonos`✗  *(pipecat already removed ✓; ✗ = retire, don't carry)*

### Host (non-Docker) services
- **`llamacpp-glacier.service`** — the 9B (Qwen3.5-9B Q8, `-np 4`, no DFlash) on the 3090.
  The only host inference unit. Carry the unit file + beellama binary + `/home/jasper/llm` models.
  *(Being reworked for the new GPU layout anyway — see §9.)*

### Network / identity
- Active NIC: **`ens2f0` = <your-llm-host-ip>/24** (others down). **Will rename** on the new board.
- netplan: single file `50-cloud-init.yaml`.
- Tailscale node `100.67.99.70` / `your-llm-host.your-tailnet.ts.net`.
- nginx TLS: `/docker/nginx/{cert.crt,cert.key,your-llm-host.your-tailnet.ts.net.{crt,key},locations.conf,nginx.conf}`.
- **USB radios:** none matched (`lsusb`) — HA appears to use **Matter + MQTT (network)**, not USB
  Zigbee/Z-Wave dongles. **Verify with full `lsusb`** before assuming nothing physical moves.

### Refresh-the-inventory commands (run before executing)
```bash
ssh your-llm-host.local 'lsblk -f; df -h; du -sh /docker/*/ /var/lib/docker /home/jasper/llm 2>/dev/null | sort -h; \
  docker compose -f /docker/docker-compose.yml config --services; docker volume ls; \
  lsusb; ip -br addr; cat /etc/fstab'
```

---

## §1 — Decisions to make first

1. **Does the new box BECOME "the LLM host" (recommended)?** Assume the LLM host's IP `<your-llm-host-ip>`,
   hostname, Tailscale state, and TLS certs. Then **zero** downstream repointing — every
   `your-llm-host.local` / `.ts.net` / `<your-llm-host-ip>` reference in Hearth, iOS, nginx, and the NAS
   keeps working. The physical box is the Z8 Fury; logically it's the LLM host. *(Alternative: new
   identity + repoint everything — much more work, not recommended.)*
2. **Browser role rehoming.** the workstation today is the `agentd` + warm-Firefox `browse_url` host.
   That role moves to an upstairs box; update the orchestrator's `STEAMBOAT_HOST` env to the new
   IP and redeploy via `ops/agentd/deploy.sh` (don't hand-edit — drift gotcha). Settle naming so
   `STEAMBOAT_HOST` stays coherent once "the workstation" the box becomes the LLM host.
3. **Fresh drive for the workstation's OS** — don't reuse the LLM host's 92 %-full M.2. New/larger NVMe;
   keep both the LLM host's M.2 and the workstation's current drive as rollbacks.
4. **Prune list** — confirm `ollama` (17 G, not in compose), `zonos`/`Zonos`, `cosyvoice`,
   `speaches-cpu-cache` are dead before deciding to skip them.

---

## §2 — Pre-flight / safety

- [ ] **Image the LLM host's M.2** (Clonezilla/`dd`) OR simply **leave it intact** and install the workstation's
      OS on a *different* drive. The original the LLM host drive is the rollback — do not wipe it.
- [ ] Note the LLM host's `/etc/fstab` CIFS lines + the SMB credentials file (path referenced in fstab).
- [ ] Confirm the workstation PSU headroom (6000 300 W + 3090 350 W + A4000 140 W ≈ 790 W + Xeon).
- [ ] Confirm the 10 Gb NIC slot vs GPU slots (NIC may consume one DW slot → 3 GPU slots = your 3 cards).

---

## §3 — the workstation base install (the LLM host stays hot)

1. Install **Ubuntu Server LTS** (24.04+) on the fresh NVMe. UEFI boot, minimal.
2. **Networking** — set the static identity you chose in §1 (likely `<your-llm-host-ip>`). Edit the new
   board's netplan with the **new NIC name** (`ip -br addr` to find it; it won't be `ens2f0`).
3. **Docker + NVIDIA:**
   ```bash
   # Docker engine + compose plugin
   curl -fsSL https://get.docker.com | sh
   # NVIDIA driver (matching forza/the LLM host major) + container toolkit
   sudo apt install -y nvidia-driver-580 nvidia-container-toolkit
   sudo nvidia-ctk runtime configure --runtime=docker && sudo systemctl restart docker
   ```
4. **NAS mounts** — copy the LLM host's CIFS fstab lines + creds file, then:
   ```bash
   sudo mkdir -p /mnt/nas /mnt/nas2 /mnt/media-tv
   # paste the //192.168.0.205/Alexandria and //192.168.0.206/Serapeum CIFS lines into /etc/fstab
   sudo mount -a && df -h | grep /mnt   # must show both NAS shares before bringing up Plex/*arr
   ```
5. **BIOS:** enable **Above 4G Decoding** (mandatory for 3+ GPUs) + **Resizable BAR**.

---

## §4 — GPU install (at the cutover, not before)

Leave the GPUs in the LLM host until §6 so the LLM host keeps serving during the build. At cutover:
1. Seat all three (give the **open-air 3090 the best-airflow slot** — it's the thermal weak link
   between the blower-style 6000 Ada + A4000).
2. Boot, `nvidia-smi -L` → confirm all three + capture UUIDs.
3. **Pin every GPU service by UUID, never index** (`CUDA_VISIBLE_DEVICES=GPU-<uuid>`), so future
   reseats never renumber-break a service (the dead-9B lesson).

---

## §5 — Data migration

### Phase A — pre-sync (the LLM host HOT, no downtime)
Big static trees that don't change moment-to-moment. Run **from the workstation**, over 10 Gb:
```bash
for d in comfyui maps parakeet hearth-embeddings; do
  sudo rsync -aHAX --info=progress2 root@<your-llm-host-ip>:/docker/$d/ /docker/$d/
done
sudo rsync -aHAX --info=progress2 root@<your-llm-host-ip>:/home/jasper/llm/ /home/jasper/llm/
# media is on NAS — already mounted in §3, nothing to copy
```

### Phase B — final cold sync (cutover window, the LLM host STOPPED)
Stateful DBs must be quiesced for a consistent copy:
```bash
# on the LLM host:
ssh your-llm-host.local 'cd /docker && docker compose stop'      # HA down starts here
ssh your-llm-host.local 'sudo systemctl stop llamacpp-glacier'

# on the workstation — cold rsync the stateful trees (small deltas after Phase A):
for d in hearth gitea homeassistant_config radarr sonarr lidarr readarr \
         tautulli mealie music-assistant matter-server mosquitto overseerr \
         qbittorrent_config searxng sabnzbd nginx friday_watchdog friday_writer; do
  sudo rsync -aHAX --delete --info=progress2 root@<your-llm-host-ip>:/docker/$d/ /docker/$d/
done

# Plex — small-file heavy, tar-over-ssh beats per-file rsync (container already stopped):
ssh your-llm-host.local 'tar -C /docker/plex -cf - .' | sudo tar -C /docker/plex -xf -

# the compose file + env + any /docker root files:
sudo rsync -aHAX root@<your-llm-host-ip>:/docker/docker-compose.yml root@<your-llm-host-ip>:/docker/hearth/hearth.env /docker/...
```

### Named volumes
Most app state is bind-mounted (above). For the named volumes that hold real data
(`docker_hearth-nominatim-data`, `docker_firecrawl-redis`, anon volumes), either let the service
**recreate** them (nominatim re-imports from `/docker/maps`; redis is a cache) or migrate explicitly:
```bash
# per volume, if it holds non-rebuildable data:
ssh your-llm-host.local 'docker run --rm -v <vol>:/v -w /v alpine tar -cf - .' \
  | docker run --rm -i -v <vol>:/v -w /v alpine tar -xf -
```
Audit each anon volume's owner first (`docker inspect <container> | grep -A3 Mounts`); skip caches.

### Identity carry-over (do during Phase B)
```bash
# Tailscale node identity (keeps 100.67.99.70 + the .ts.net name → nginx cert stays valid):
ssh your-llm-host.local 'sudo systemctl stop tailscaled'
sudo rsync -aHAX root@<your-llm-host-ip>:/var/lib/tailscale/ /var/lib/tailscale/
# nginx certs already came over inside /docker/nginx
```

---

## §6 — Bring-up + verify

```bash
sudo systemctl restart docker
cd /docker && docker compose up -d
# host 9B unit (after re-pinning to the 3090's UUID — see §4/§9):
sudo systemctl enable --now llamacpp-glacier
```
Verify, in order:
- [ ] `nvidia-smi -L` → 3 GPUs; `nvidia-smi` shows the 9B + RAG + STT + comfyui resident on the right cards
- [ ] `curl localhost:7700/status` → Hearth up, tools present, `uptime_s` low
- [ ] `curl localhost:8088/v1/models` (9B), `:8091/models` (RAG), `:8093/v1/models` (STT)
- [ ] HA UI loads, devices present (Matter/MQTT reconnected), no re-pair needed
- [ ] Plex loads, libraries intact (metadata DB came over), NAS media visible
- [ ] *arr apps see their libraries (NAS) + history (SQLite came over)
- [ ] gitea reachable at `:3010`, repos intact (it's the `origin` remote — push test)
- [ ] nginx `/api/*` routes resolve over the `.ts.net` cert

---

## §7 — Cutover (network identity flip)

If the new box assumed `<your-llm-host-ip>` + hostname + Tailscale state + certs (§1), there is **nothing
to repoint** — Hearth, iOS (`your-llm-host.your-tailnet.ts.net` / `your-llm-host.local`), and the NAS all keep
working. Otherwise: update DNS/mDNS, repoint every `your-llm-host.local` reference, re-issue certs.
- [ ] Power **off** old the LLM host (the SPR box) — do NOT wipe its M.2 (rollback).
- [ ] Update `STEAMBOAT_HOST` → new browser-role host; redeploy agentd there (§1).
- [ ] iOS smoke: a chat turn + a voice turn + a Cordelia capture end-to-end.

---

## §8 — Rollback

Pre-merge of nothing is destroyed, so rollback is clean at every stage:
- **Before cutover:** old the LLM host is still whole — power it back on, you've lost nothing.
- **After cutover, if the workstation misbehaves:** move the GPUs back, power the LLM host on (its M.2 is
  intact). The only data delta is whatever changed on the workstation post-cutover (re-sync back if needed).
- Keep **both** old drives (the LLM host M.2 + the workstation's old drive) shelved until the workstation has run
  clean for a week.

---

## §9 — Post-cutover: the new inference layout

Now reconfigure the GPU tiers for the consolidated box (this is the upgrade, not just a move):
- **6000 Ada (48 G):** stand up the **35B-A3B FP8** deep tier; repoint the deep roles' `base_url`
  in `config/llm-roles.yaml` → the new endpoint. *(That file is read once at boot → orchestrator
  restart, not just a pull.)*
- **3090 (24 G):** 9B interactive + STT + Laur TTS (voice loop local).
- **A4000 (16 G):** RAG (infinity) — back on its own card, no more squatting the 3090.
- **forza (GB10):** keep vision (27B-VL) + overflow. *(If the 35B moves to the 6000 Ada, shed it
  from forza.)*
- Re-pin **all** GPU services by UUID. Smoke each tier independently before declaring done.

---

## Appendix — prune candidates (reclaim before/after)
`ollama` (17 G, not in compose — confirm dead), `cosyvoice` (72 M), `pipecat` (338 M, retired),
`kokoro-tts`, `Zonos`/`zonos-api` (if the kiosk TTS is unused), `speaches-cpu-cache` (4.4 G if OCR
moved). Don't carry these to the new box.
