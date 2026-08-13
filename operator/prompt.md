# Set up Maggie's real-browser scraping rig on the workstation — with activity awareness and WoL-aware auto-sleep

## Context

You are running on **the workstation.local**, my CachyOS workstation (**KDE Plasma 6
on Wayland**). I use Firefox here as my daily browser — keep that untouched.

I'm building **Hearth**, a personal AI assistant with specialist sub-agents.
One specialist, **Maggie**, browses the live web on my behalf — mostly
concert/music discovery. She needs a real browser (not headless) to defeat
Cloudflare/PerimeterX bot detection.

**Topology of the LAN:**
- **the always-on host** (`the always-on host.local`) — Linux the always-on host, the LAN's runtime/services host.
  **Hearth runs here** as Bun/TypeScript systemd user services. the always-on host is
  the host that will reach the workstation over LAN to drive the browser.
- **the workstation** (this machine) — CachyOS workstation, hosts the Firefox /
  geckodriver / Xpra rig you're about to build.
- **the LLM host** (<your-llm-host-ip>, basement Ubuntu + RTX 3090) — Hearth's LLM tier
  only. Serves Qwen3.6-27B to the always-on host. **the LLM host does not talk to the workstation
  directly.** Don't wire anything to the LLM host.

So the data flow is: **the always-on host (Hearth) ⇄ the workstation (this rig)** over LAN.

## Three things to build

1. **Maggie's browser** — headed Firefox + geckodriver, drivable from the always-on host
2. **Takeover detection** — Maggie must yield (or warn) if I'm actively using
   the workstation when she wants the browser
3. **WoL-aware auto-sleep** — if the always-on host woke the workstation via Wake-on-LAN to do
   Maggie work, and the work is done AND nothing else is running, the workstation
   should suspend itself again. If I woke it (or took over after a WoL wake),
   it stays awake.

## Architecture decisions already made (don't relitigate)

- **Firefox**, not Chrome. Smaller bot-detection surface; multiple profiles
  run concurrently with `--no-remote`.
- **Marionette + geckodriver** for automation. Not Playwright/Selenium IDE.
  No stealth plugins, no patched binaries — the whole point is "this IS a
  real browser."
- **Xpra** for the display. Headed, GPU-real, attachable from anywhere on LAN
  for debugging. Not Xvfb.
- **Profile warming is mandatory** before going agentic. I'll do the human
  warming pass; you stand up the profile and prefs.
- **`privacy.resistFingerprinting` stays OFF** — it makes Firefox stand out
  as bot-like because almost no real users set it.
- **Auto-sleep uses a wake-marker file.** the always-on host writes the marker over SSH
  when it sends a WoL packet; sleep guard checks for it. Any human input on
  the workstation deletes the marker (you took over → no more auto-sleep).

================================================================
PART 1 — BROWSER STACK
================================================================

### 1.1 Install dependencies

```
sudo pacman -S geckodriver xpra firefox jq bun
# also: ydotool (for the smoke test that simulates input on Wayland)
sudo pacman -S ydotool
```

Verify: `geckodriver --version`, `xpra --version`, `bun --version`,
`ydotool --version`.

### 1.2 Create the Maggie Firefox profile

```
firefox -CreateProfile "maggie /home/jasper/.mozilla/firefox/maggie"
```

Write `/home/jasper/.mozilla/firefox/maggie/user.js`:

```
user_pref("dom.webdriver.enabled", false);
user_pref("marionette.enabled", true);
user_pref("privacy.resistFingerprinting", false);
user_pref("media.peerconnection.enabled", true);
user_pref("dom.ipc.processCount", 1);
user_pref("browser.shell.checkDefaultBrowser", false);
user_pref("browser.startup.homepage", "about:blank");
```

### 1.3 Xpra display service

`~/.config/systemd/user/maggie-xpra.service`:

```
[Unit]
Description=Xpra display for Maggie's Firefox
After=graphical-session.target

[Service]
Type=simple
ExecStart=/usr/bin/xpra start :99 \
  --daemon=no \
  --bind-tcp=0.0.0.0:14500 \
  --html=off \
  --notifications=no \
  --pulseaudio=no \
  --webcam=no \
  --start-child=
ExecStop=/usr/bin/xpra stop :99
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
```

### 1.4 geckodriver service

`~/.config/systemd/user/maggie-geckodriver.service`:

```
[Unit]
Description=geckodriver for Maggie WebDriver sessions
After=maggie-xpra.service
Requires=maggie-xpra.service

[Service]
Type=simple
Environment="DISPLAY=:99"
ExecStart=/usr/bin/geckodriver \
  --host 0.0.0.0 \
  --port 4444 \
  --binary /usr/bin/firefox \
  --log info \
  --marionette-port 2828
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
```

Enable + start:

```
systemctl --user daemon-reload
systemctl --user enable --now maggie-xpra.service maggie-geckodriver.service
loginctl enable-linger jasper
```

Verify: `curl http://the workstation.local:4444/status` returns JSON with
`ready: true`.

================================================================
PART 2 — ACTIVITY DETECTION
================================================================

Build a single canonical activity-check script that every other component
calls. It outputs JSON describing what's happening on the workstation right now.

### 2.1 The activity script

`/home/jasper/hearthoperator/bin/steamboat-activity.sh`

Bash script. Must check **every** signal in this checklist and emit JSON like:

```json
{
  "busy": true,
  "user_present": true,
  "blockers": ["user_input_recent", "qbittorrent_active"],
  "details": {
    "user_idle_seconds": 42,
    "ssh_sessions_external": 0,
    "torrent_processes": ["qbittorrent"],
    "usb_imaging": [],
    "steam_running": false,
    "steam_downloading": false,
    "steam_game_running": false,
    "steam_remote_play_active": false,
    "media_playing": false,
    "compilation_running": false,
    "large_file_transfer": false,
    "package_manager_running": false,
    "maggie_session_active": false,
    "network_throughput_mbps": 0.4,
    "video_conf_active": false
  }
}
```

**Checklist — sleep is BLOCKED if ANY of these are true:**

1. **User input recent.** User idle < 600 seconds.
   - **Primary (KDE Plasma 6 / KWin Wayland):**
     `qdbus6 org.freedesktop.ScreenSaver /ScreenSaver GetSessionIdleTime`
     returns idle time in **milliseconds**. Divide by 1000.
   - Fallback only if the D-Bus call fails (e.g., script run outside graphical
     session): `loginctl show-session $(loginctl list-sessions --no-legend |
     awk '$3=="jasper"{print $1; exit}') -p IdleSinceHint`.
   - Threshold configurable, default 600s.
2. **External SSH sessions.** Resolve the always-on host's LAN IP once at script start:
   `MINT_IP=$(getent hosts the always-on host.local | awk '{print $1}')`. Exclude that IP
   from `who` output. Anything else with an external IP in `who | grep -E
   'pts/[0-9]+ +.*\('` = human SSH = busy. (the always-on host is the only host that
   should be SSHing in for automated reasons.)
3. **Torrents.** `pgrep -x qbittorrent || pgrep -x qbittorrent-nox || pgrep
   -x transmission-daemon || pgrep -x deluged || pgrep -x rtorrent`. If
   qBittorrent's WebUI is up, also query its API for active torrents > 0
   at `http://127.0.0.1:8080/api/v2/torrents/info?filter=active`.
4. **USB imaging.** `pgrep -fa 'dd if=|balena|ddrescue|caligula|fedora-media-writer|popsicle'`.
   Also check for any `dd` writing to `/dev/sd[b-z]` or `/dev/nvme[1-9]`.
5. **Steam client running.** `pgrep -x steam`.
6. **Steam download active.** Look at `~/.steam/steam/steamapps/downloading/`
   — if any subdirs have mtime within last 60s, downloading.
7. **Steam game running.** `pgrep -f 'steamapps/common'`.
8. **Steam Remote Play / Link hosting.** `ss -ulnp | grep -E ':2703[1567]'`
   (27031/27036 UDP = Remote Play discovery + streaming; 27037 = Link).
9. **Media playback.** `playerctl status` returns `Playing` for any player.
10. **Compilation/build.** `pgrep -x cargo || pgrep -x rustc || pgrep -x
    make || pgrep -x ninja || pgrep -x cc || pgrep -x gcc || pgrep -x
    clang || pgrep -x tsc || pgrep -x node` PLUS sustained load avg > 2.0
    — only count this as busy if BOTH (avoid false positives from idle
    node processes).
11. **Large file transfer.** `pgrep -x rsync || pgrep -x scp || pgrep -x
    sftp` AND network throughput sustained > 1 MB/s for last 30s. Network
    throughput from `/proc/net/dev` delta.
12. **Package manager running.** `pgrep -x pacman || pgrep -x paru || pgrep
    -x yay || pgrep -x makepkg`.
13. **Maggie WebDriver session active.** `curl -s http://127.0.0.1:4444/status
    | jq` and also check `/sessions` if available; any active session = busy.
14. **Sustained network throughput.** Independent of process detection: if
    total `eth0`/`wlan0`/`enp*` throughput > 2 MB/s sustained over 30s,
    something is happening even if you can't name it.
15. **Active video conference.** `pactl list source-outputs 2>/dev/null |
    grep -iE 'firefox|chromium|zoom|teams|slack|discord'` — if any source
    (microphone) is being read by a known conf app.

The script should run in < 1 second. Cache nothing; freshness matters.

`steamboat-activity.sh --human` should also output a human-readable version
for me to eyeball.

### 2.2 Test the activity script

Run it under varied conditions and confirm output:

- Idle desktop, nothing running → `busy: false`
- You start typing → `busy: true, blockers: [user_input_recent]`
- Maggie has an active WebDriver session → `busy: true, blockers: [maggie_session_active]`
- Start a Steam game → `busy: true, blockers: [steam_game_running]`

Report at least three runs back to me with their JSON output.

================================================================
PART 3 — WoL-AWARE AUTO-SLEEP GUARD
================================================================

### 3.1 The wake-marker contract

the always-on host signals "I woke you, you may sleep when done" by creating:

```
/var/lib/steamboat-wake/woken-by-wol
```

over SSH after sending the WoL magic packet. The file's content is a
timestamp + optional task ID. Setup:

```
sudo mkdir -p /var/lib/steamboat-wake
sudo chown jasper:jasper /var/lib/steamboat-wake
```

The marker means: "this boot was caused by an automated WoL from the always-on host, not
by Jasper walking up to the machine."

**Critical rule:** any human input deletes the marker. Once I touch the
keyboard or mouse, the marker goes away and auto-sleep is disabled until
the next WoL boot.

### 3.2 The marker-clearer service

`~/.config/systemd/user/steamboat-wake-marker-clearer.service` — oneshot
triggered by a timer that runs every 30s and:

- Calls `steamboat-activity.sh`
- If `user_idle_seconds < 60`, `rm -f /var/lib/steamboat-wake/woken-by-wol`
- Otherwise no-op

`~/.config/systemd/user/steamboat-wake-marker-clearer.timer`:

```
[Unit]
Description=Clear WoL marker when human takes over

[Timer]
OnBootSec=30s
OnUnitActiveSec=30s

[Install]
WantedBy=timers.target
```

### 3.3 The sleep-guard service

`~/.config/systemd/user/steamboat-sleep-guard.service` — oneshot triggered
every 5 minutes:

Logic:
1. If `/var/lib/steamboat-wake/woken-by-wol` does NOT exist → exit 0
   (Jasper booted this; never auto-sleep).
2. Run `steamboat-activity.sh`. If `busy: true` → exit 0.
3. Check `journalctl --user -u maggie-geckodriver -S '15 min ago' --no-pager`
   for any session activity. If non-empty → exit 0 (give a buffer in case
   Maggie just finished).
4. All clear → log "auto-sleeping" with timestamp, then `systemctl suspend`.

For the suspend call to work without password, add a polkit rule at
`/etc/polkit-1/rules.d/50-jasper-suspend.rules`:

```
polkit.addRule(function(action, subject) {
  if (action.id == "org.freedesktop.login1.suspend" &&
      subject.user == "jasper") {
    return polkit.Result.YES;
  }
});
```

`~/.config/systemd/user/steamboat-sleep-guard.timer`:

```
[Timer]
OnBootSec=10min
OnUnitActiveSec=5min

[Install]
WantedBy=timers.target
```

### 3.4 Enable and verify

```
systemctl --user daemon-reload
systemctl --user enable --now \
  steamboat-wake-marker-clearer.timer \
  steamboat-sleep-guard.timer
```

Verify:
- `touch /var/lib/steamboat-wake/woken-by-wol` and stay idle — the workstation
  should suspend within ~10 minutes. **Test this with me present.** I don't
  want a surprise suspend cycle until I've confirmed the logic.
- Touch keyboard during the wait — marker file should disappear within 30s.
- Run a torrent or start Maggie session — even with marker present, sleep
  should be deferred.

================================================================
PART 4 — MAGGIE TAKEOVER CHECK
================================================================

Maggie shouldn't seize Firefox's display if I'm at the keyboard. The
`maggie` Firefox profile is on a separate Xpra display (`:99`), so it
doesn't visually steal focus from my real desktop. But:

- If I have `xpra attach`ed to `:99` to watch her work, the window is visible
- If I'm actively using the workstation for something else, Maggie should at
  minimum *log* that she's about to run, and optionally defer

### 4.1 HTTP shim: `maggie-can-takeover`

Build a tiny Bun HTTP server at
`/home/jasper/hearthoperator/takeover-check.ts` exposed on `0.0.0.0:4445`.
One endpoint:

```
GET /can-takeover
  → 200 {"ok": true}     when system idle-enough for Maggie
  → 409 {"ok": false, "reason": "user_input_recent", "details": {...}}
        when I'm actively using the box
```

Logic: shell out to `steamboat-activity.sh`. If `user_idle_seconds > 60`
AND no external SSH AND no media playing AND no video conf → `ok: true`.
Other blockers (torrents, Steam download) are FINE — those don't conflict
with Maggie. The check is specifically "is Jasper at the keyboard?"

Hearth on the always-on host calls this BEFORE starting a Maggie WebDriver session. If
`ok: false`, Maggie defers her task to a follow-up (using Hearth's existing
promise_followup mechanism) and notifies me: "Saw you were using the workstation,
will retry concert search at 2am."

Systemd user service:
`~/.config/systemd/user/maggie-takeover-check.service`, simple `ExecStart=
/usr/bin/bun run /home/jasper/hearthoperator/takeover-check.ts`.

================================================================
PART 5 — SMOKE TESTS
================================================================

Write into `/home/jasper/hearthoperator/test/`:

### 5.1 `browser-smoke.ts`

From the workstation, drive geckodriver:
1. Connect to `http://127.0.0.1:4444` with capabilities
   `moz:firefoxOptions.args = ["-P", "maggie", "--no-remote"]`
2. Load `https://bot.sannysoft.com/`. Screenshot to `/tmp/maggie-sannysoft.png`.
3. Load `https://arh.antoinevastel.com/bots/areyouheadless`. Screenshot.
4. Load `https://www.mishawaka.com/calendar` (real venue I care about).
   Wait for event list. Dump event titles + dates to stdout.
5. Quit cleanly.

### 5.2 `activity-smoke.sh`

1. Print baseline `steamboat-activity.sh`.
2. `touch /var/lib/steamboat-wake/woken-by-wol`, sleep 35, confirm marker
   still present (no human input).
3. Simulate human input under Wayland. KDE Plasma 6 has no X11 root, so
   `xdotool` will not work. Use `ydotool mousemove 1 1` (needs `ydotoold`
   running — `systemctl --user enable --now ydotool.service` if a unit
   exists, otherwise document it for me). If `ydotool` is unavailable,
   fall back to `wtype -k Shift`. If neither works, print a clear
   instruction asking me to nudge the mouse manually and wait for
   keypress. Sleep 35, confirm marker is gone.
4. Drop marker again, start a fake busy process (`yes > /dev/null &`),
   confirm sleep-guard logs "deferred — system busy."
5. Stop the fake busy process, confirm sleep-guard would suspend (use
   `systemd-run --user --on-active=5s` to test without actually suspending
   — replace `systemctl suspend` in the guard with `echo "WOULD SUSPEND"`
   for the test, then revert).

### 5.3 `takeover-shim.sh`

Curl `http://the workstation.local:4445/can-takeover` under varied states:
- I'm typing → expect 409
- Idle 5min → expect 200
- Steam downloading but I'm idle → expect 200 (download is fine)

================================================================
PART 6 — HAND-OFF FOR HEARTH ON MINT
================================================================

Write `/home/jasper/hearthoperator/HANDOFF.md` with:

**Topology header:** "the always-on host (Hearth runtime) → the workstation (this browser rig)
over LAN. the LLM host is Hearth's LLM upstream; it does not interact with
the workstation."

1. **WebDriver endpoint:** `http://the workstation.local:4444`
2. **Takeover-check endpoint:** `http://the workstation.local:4445/can-takeover`
3. **Required capabilities** to reuse the warmed profile (JSON example)
4. **WoL contract:**
   - the always-on host sends magic packet to the workstation MAC `<fill in>`
   - the always-on host waits for `:4444/status` to return ready (poll every 5s, max 90s)
   - the always-on host creates `/var/lib/steamboat-wake/woken-by-wol` over SSH with
     content `{"woken_at": "...", "by": "mint", "task_id": "..."}`
   - the always-on host runs Maggie's task
   - the always-on host does NOT delete the marker — sleep-guard owns lifecycle
5. **Pre-flight check sequence** for Hearth before any browser task:
   1. `curl -fsS http://the workstation.local:4445/can-takeover` — if 409, defer
   2. `curl -fsS http://the workstation.local:4444/status` — if unreachable, WoL
   3. Drop marker if WoL was needed
   4. Run task
6. **How to watch Maggie work:** `xpra attach tcp://the workstation.local:14500`
7. **Restart commands** for all four services
8. **Known limitations**

================================================================
PART 7 — FIREWALL
================================================================

Restrict ports 4444 (geckodriver), 4445 (takeover-check), 14500 (xpra) to
LAN only (192.168.0.0/24). Use whatever firewall is active (check with
`systemctl status firewalld ufw nftables iptables` first). Do NOT expose
to WAN.

================================================================
WHAT NOT TO DO
================================================================

- Don't modify my daily Firefox profile (`~/.mozilla/firefox/*.default*`)
- Don't run anything as root that doesn't need to be — systemd **user**
  services throughout. Suspend permission via polkit, not sudoers.
- Don't apply stealth plugins or navigator overrides. Real browser, real
  profile.
- Don't actually call `systemctl suspend` during smoke testing. Stub it
  with `echo` until I'm watching live.
- Don't expose any port to WAN.
- Don't auto-sleep if the WoL marker is absent. Boot from cold = Jasper
  did it = stay awake forever.
- Don't wire anything to the LLM host. the LLM host is Hearth's LLM upstream on the always-on host,
  not a peer of the workstation.

================================================================
DELIVERABLES — REPORT BACK
================================================================

When done, report:
1. All systemd unit files (paste them)
2. `systemctl --user status` for all five services
3. Three `steamboat-activity.sh` JSON outputs under different conditions
4. Smoke test results (sannysoft pass/fail, Riverbend event count, activity
   shim 200/409 results)
5. The HANDOFF.md content
6. The MAC address of the workstation's primary NIC (for the always-on host's WoL config)

Then I'll do the Firefox profile warming pass manually, and confirm
go-live with you before Hearth on the always-on host starts using it.
