"""aioesphomeapi client wrapper for the Satellite1 (design §3 option (a)).

This is how HA itself talks to the device: ONE `APIClient` per device, Noise
PSK login, enumerate entities, subscribe to entity states (LD2450 + device
sensors) and the `voice_assistant` audio/event stream.

⚠ CONCURRENCY (design §3 / §4): the device's Noise login FAILS while HA holds
the session — HA and the coordinator can't both hold an authenticated session
to the SAME device. So this wrapper is built to **gracefully no-op and log**
when it can't acquire a session (the live device is HA's until a maintenance
window frees it). It is structured for a real session against a dev-kit / 2nd
device; its parsing/logic is unit-tested with synthetic frames (no device).

The voice-assistant audio half (mic frames in, TTS frames out) is wired here
but its live verification is deferred to a maintenance window — exactly the
boundary this build stops at.
"""
from __future__ import annotations

import asyncio
import logging
from typing import Awaitable, Callable

from .config import DeviceConfig

log = logging.getLogger("voice_coordinator.device")

# Imported lazily so the rest of the package (config, state machine, hearth
# client, tests) imports cleanly without aioesphomeapi present. The container
# installs it; local stdlib-only test runs don't need it.
try:  # pragma: no cover - import guard
    from aioesphomeapi import APIClient, APIConnectionError, MediaPlayerCommand, ReconnectLogic  # type: ignore

    try:
        from aioesphomeapi import VoiceAssistantEventType  # type: ignore
    except Exception:  # noqa: BLE001
        from aioesphomeapi.model import VoiceAssistantEventType  # type: ignore
    _AIOESPHOME_AVAILABLE = True
except Exception:  # noqa: BLE001  pragma: no cover
    APIClient = object  # type: ignore
    APIConnectionError = Exception  # type: ignore
    ReconnectLogic = object  # type: ignore
    MediaPlayerCommand = None  # type: ignore
    VoiceAssistantEventType = None  # type: ignore
    _AIOESPHOME_AVAILABLE = False

# Phase name → VoiceAssistantEventType. The Satellite1 LED ring animates off
# these events (HA sends them as the pipeline progresses; without them the ring
# stays dark even though wake + audio work — observed live 2026-06-07). The
# coordinator calls send_va_event() at each state transition to drive the ring.
_VA_LED_EVENTS: dict[str, object] = {}
if VoiceAssistantEventType is not None:
    _VA_LED_EVENTS = {
        "run_start": VoiceAssistantEventType.VOICE_ASSISTANT_RUN_START,
        "stt_start": VoiceAssistantEventType.VOICE_ASSISTANT_STT_START,
        # ★ the FutureProof firmware LED keys on these two (+ tts_start + run_end):
        "stt_vad_start": VoiceAssistantEventType.VOICE_ASSISTANT_STT_VAD_START,  # → "listening for command"
        "stt_vad_end": VoiceAssistantEventType.VOICE_ASSISTANT_STT_VAD_END,      # → "thinking"
        "stt_end": VoiceAssistantEventType.VOICE_ASSISTANT_STT_END,
        "intent_start": VoiceAssistantEventType.VOICE_ASSISTANT_INTENT_START,
        "tts_start": VoiceAssistantEventType.VOICE_ASSISTANT_TTS_START,          # → "replying"
        "tts_end": VoiceAssistantEventType.VOICE_ASSISTANT_TTS_END,
        "run_end": VoiceAssistantEventType.VOICE_ASSISTANT_RUN_END,              # → "idle" (ring off)
    }


# Callback signatures the coordinator supplies.
StateCallback = Callable[[str, object], None]
"""(entity_name, value) for every entity-state update."""

AudioCallback = Callable[[bytes], Awaitable[None] | None]
"""Raw AEC'd mic audio frame (16 kHz mono, channels:0)."""

WakeCallback = Callable[[str], Awaitable[None] | None]
"""(wake_phrase) when the device's on-device wake word fires."""


class DeviceConnection:
    """A connection to one Satellite1 over the ESPHome native API.

    Lifecycle: `start()` attempts the Noise login and subscriptions; if the
    session can't be acquired (HA holds it, or aioesphomeapi is absent), it
    logs and stays in a `connected=False` state instead of raising — the
    coordinator keeps running its health endpoint and retries.
    """

    def __init__(
        self,
        cfg: DeviceConfig,
        *,
        on_state: StateCallback | None = None,
        on_audio: AudioCallback | None = None,
        on_wake: WakeCallback | None = None,
    ) -> None:
        self.cfg = cfg
        self.on_state = on_state
        self.on_audio = on_audio
        self.on_wake = on_wake
        self.connected = False
        self._client = None  # type: ignore[assignment]
        self._entities_by_key: dict[int, str] = {}
        self._media_player_key: int | None = None  # set during enumerate; SPEAKING-state output
        self._reconnect = None
        self._logged_connect_error = False  # throttle the "HA holds the session" retry log

    # ── lifecycle ─────────────────────────────────────────────────────────────

    async def start(self) -> bool:
        """Start the (re)connect loop. Returns True iff the loop was STARTED
        (aioesphomeapi present + a credential configured) — not that a live
        session is up yet. ReconnectLogic owns the connect lifecycle: it dials
        the device, fires `_on_connect` (enumerate + subscribe) when a session
        is acquired and `_on_disconnect` when it drops, retrying with backoff
        across device reboots / startup races and the HA→coordinator handoff.
        `self.connected` is the live-session truth — check that, not this return.
        NEVER raises on a session conflict; a busy device is just a retry."""
        if not _AIOESPHOME_AVAILABLE:
            log.warning(
                "aioesphomeapi not installed — device half is a no-op. "
                "Install it in the container; the coordinator's Hearth/STT/TTS "
                "contract is unaffected."
            )
            return False
        if not self.cfg.psk and not self.cfg.password:
            log.warning(
                "no device PSK/password configured (HEARTH_VC_DEVICE_PSK) — "
                "device half is a no-op. Paste the Noise PSK from HA's "
                "core.config_entries into the compose env."
            )
            return False

        self._client = APIClient(  # type: ignore[operator]
            address=self.cfg.host,
            port=self.cfg.port,
            password=self.cfg.password or "",
            noise_psk=self.cfg.psk,
            expected_name=self.cfg.expected_name,
        )
        # ReconnectLogic drives connect + retry so a deployed daemon survives
        # device reboots, wifi blips, and the HA→coordinator handoff (design §6:
        # "small + per-turn-stateless; restart: unless-stopped; if it dies, fall
        # back to HA"). We connect by static IP, so zeroconf_instance is omitted.
        # The enumerate + subscriptions live in `_on_connect` because the device
        # drops them with the session — they MUST re-run on every reconnect.
        self._reconnect = ReconnectLogic(  # type: ignore[operator]
            client=self._client,
            on_connect=self._on_connect,
            on_disconnect=self._on_disconnect,
            on_connect_error=self._on_connect_error,
            name=self.cfg.name,
        )
        try:
            await self._reconnect.start()
        except Exception:  # noqa: BLE001
            log.exception("could not start reconnect loop for %s", self.cfg.name)
            return False
        log.info(
            "reconnect loop started for %s (%s:%s) — connecting in the background",
            self.cfg.name,
            self.cfg.host,
            self.cfg.port,
        )
        return True

    async def _on_connect(self) -> None:
        """ReconnectLogic acquired a live session. (Re)run enumerate + the
        subscriptions — they're dropped with the session, so this fires on the
        FIRST connect AND every reconnect."""
        self.connected = True
        self._logged_connect_error = False  # re-arm the retry-log for the next outage
        log.info("connected to device %s (%s:%s)", self.cfg.name, self.cfg.host, self.cfg.port)
        await self._enumerate_entities()
        await self._subscribe_states()
        await self._subscribe_voice_assistant()

    async def _on_disconnect(self, expected_disconnect: bool) -> None:
        """The session dropped (device reboot, wifi blip, or our own stop()).
        Mark down; ReconnectLogic redials unless we asked it to stop."""
        self.connected = False
        log.info(
            "device %s disconnected (expected=%s) — %s",
            self.cfg.name,
            expected_disconnect,
            "shutting down" if expected_disconnect else "will reconnect",
        )

    async def _on_connect_error(self, err: Exception) -> None:
        """A connect attempt failed. While HA still holds the device this is the
        EXPECTED state (one voice client per device) — log it once prominently,
        then quietly, since ReconnectLogic keeps retrying with backoff."""
        self.connected = False
        if not self._logged_connect_error:
            self._logged_connect_error = True
            log.warning(
                "could not acquire device session for %s (%s:%s): %s. EXPECTED "
                "while Home Assistant holds the device (one voice client per "
                "device); retrying with backoff — free the device in HA to hand off.",
                self.cfg.name,
                self.cfg.host,
                self.cfg.port,
                err,
            )
        else:
            log.debug("connect retry for %s still failing: %s", self.cfg.name, err)

    async def stop(self) -> None:
        """Stop the reconnect loop FIRST (so it doesn't redial after we drop),
        then disconnect the client."""
        if self._reconnect is not None:
            try:
                await self._reconnect.stop()
            except Exception:  # noqa: BLE001
                log.exception("error stopping reconnect loop for %s", self.cfg.name)
        if self._client is not None:
            try:
                await self._client.disconnect()
            except Exception:  # noqa: BLE001
                log.exception("error disconnecting device %s", self.cfg.name)
        self.connected = False

    # ── subscriptions ──────────────────────────────────────────────────────────

    async def _enumerate_entities(self) -> None:
        """List entities so we can map state-update keys → human names."""
        try:
            entities, _services = await self._client.list_entities_services()  # type: ignore[union-attr]
        except Exception:  # noqa: BLE001
            log.exception("list_entities_services failed for %s", self.cfg.name)
            return
        for ent in entities:
            # Each entity has .key (int) and .name / .object_id (str).
            name = getattr(ent, "name", None) or getattr(ent, "object_id", None) or str(getattr(ent, "key", "?"))
            key = getattr(ent, "key", None)
            if key is not None:
                self._entities_by_key[key] = name
            if type(ent).__name__ == "MediaPlayerInfo" and key is not None and self._media_player_key is None:
                self._media_player_key = key  # SPEAKING-state output target (confirmed key 2232357057 on the live unit)
        log.info(
            "device %s exposes %d entities (media_player key=%s)",
            self.cfg.name, len(self._entities_by_key), self._media_player_key,
        )
        if log.isEnabledFor(logging.DEBUG):
            for k, n in self._entities_by_key.items():
                log.debug("  entity %s → %s", k, n)

    async def _subscribe_states(self) -> None:
        """Subscribe to all entity states — LD2450 + device sensors (design §4)."""

        def _on_state(state) -> None:  # noqa: ANN001 - aioesphomeapi state object
            if self.on_state is None:
                return
            key = getattr(state, "key", None)
            name = self._entities_by_key.get(key, str(key))
            # Route the media_player by KEY, not its display name. The device's
            # entity name is "Media Player" (space + caps), so a downstream
            # `"media_player" in name` check never matched — the PLAYING/IDLE
            # events were silently dropped and playback end-detection fell back to
            # a duration GUESS (the ~15 s "ring stayed lit after she finished" lag,
            # 2026-06-07). Canonicalize the name for this one key so routing is
            # exact + reliable.
            if key is not None and key == self._media_player_key:
                name = "media_player"
            value = getattr(state, "state", None)
            try:
                self.on_state(name, value)
            except Exception:  # noqa: BLE001
                log.exception("on_state callback raised for %s", name)

        try:
            self._client.subscribe_states(_on_state)  # type: ignore[union-attr]
        except Exception:  # noqa: BLE001
            log.exception("subscribe_states failed for %s", self.cfg.name)

    async def _subscribe_voice_assistant(self) -> None:
        """Subscribe to the voice_assistant stream — mic frames + VA events.

        aioesphomeapi exposes `subscribe_voice_assistant(handle_start=,
        handle_stop=, handle_audio=)`. The device emits VoiceAssistantEventType
        events (wake-word detected, run start/stop) and streams AEC'd mic audio
        frames. We forward audio to `on_audio` and wake events to `on_wake`.

        NOTE: this is the device-audio half whose LIVE test is deferred to a
        maintenance window (we can't hold the session while HA does). The wiring
        is here; the structure follows HA's own usage.
        """

        async def _handle_audio(data: bytes, data2: bytes | None = None) -> None:
            # aioesphomeapi 45.x calls handle_audio(audio.data, audio.data2) — TWO
            # args (confirmed live 2026-06-07). `data` is the AEC'd mic PCM
            # (16 kHz mono 16-bit); `data2` is an optional second channel we don't
            # use. A 1-arg signature here crashes on the first frame.
            if self.on_audio is None:
                return
            res = self.on_audio(data)
            if asyncio.iscoroutine(res):
                await res

        async def _handle_start(*args, **kwargs) -> int | None:  # noqa: ANN002, ANN003
            # Called when the device starts a voice run. The RETURN VALUE is the
            # audio-transport handshake — CONFIRMED on the live device 2026-06-07
            # (esphome 2026.4.5, voice_assistant_feature_flags=61 incl. API_AUDIO;
            # see docs/design-esp-direct-voice.md §2 and scripts/aec-fullduplex-probe.py):
            #   None       → VoiceAssistantResponse(error=True) "Server could not be
            #                started" — the device NEVER streams. (This was the bug:
            #                returning None here yielded zero mic frames.)
            #   positive N → VoiceAssistantResponse(port=N) → device streams audio
            #                over UDP to port N (would need a UDP receiver, unwired).
            #   0          → with the API_AUDIO subscription flag set (providing
            #                handle_audio below sets it), the device streams the AEC'd
            #                mic over the API → _handle_audio. ★ THIS is the path.
            # Full-duplex capture (mic streaming continuously DURING media playback)
            # is proven on this stock firmware — no custom firmware needed.
            log.debug("voice_assistant start: args=%s kwargs=%s", args, kwargs)
            if self.on_wake is not None:
                # handle_start(conversation_id, flags, audio_settings, wake_word_phrase)
                # — on aioesphomeapi 45.x the phrase is positional arg[3] (a real
                # user wake carries "Hey Kate"; our start_conversation barge-listen
                # run carries "").
                phrase = ""
                if "wake_word_phrase" in kwargs:
                    phrase = str(kwargs["wake_word_phrase"] or "")
                elif len(args) >= 4:
                    phrase = str(args[3] or "")
                res = self.on_wake(phrase)
                if asyncio.iscoroutine(res):
                    await res
            return 0  # API_AUDIO transport (see the handshake note above) — NOT None, NOT a positive port

        async def _handle_stop(*args, **kwargs) -> None:  # noqa: ANN002, ANN003
            log.debug("voice_assistant stop: args=%s kwargs=%s", args, kwargs)

        try:
            # The exact signature varies across aioesphomeapi versions; pass by
            # keyword and let it raise if unsupported (we log + continue).
            self._client.subscribe_voice_assistant(  # type: ignore[union-attr]
                handle_start=_handle_start,
                handle_stop=_handle_stop,
                handle_audio=_handle_audio,
            )
            log.info("subscribed to voice_assistant on %s", self.cfg.name)
        except TypeError:
            # Older/newer positional signature — try the common positional form.
            try:
                self._client.subscribe_voice_assistant(_handle_start, _handle_stop, _handle_audio)  # type: ignore[union-attr]
                log.info("subscribed to voice_assistant on %s (positional)", self.cfg.name)
            except Exception:  # noqa: BLE001
                log.exception(
                    "subscribe_voice_assistant unsupported on this aioesphomeapi "
                    "build for %s — pin the version per the README",
                    self.cfg.name,
                )
        except Exception:  # noqa: BLE001
            log.exception("subscribe_voice_assistant failed for %s", self.cfg.name)

    # ── outbound: TTS playback to the device ───────────────────────────────────

    async def play_tts_audio(self, pcm_chunks) -> None:  # noqa: ANN001 - async iterator of bytes
        """Stream TTS PCM frames to the device (SPEAKING state).

        Deferred-live: the exact API call to push audio frames out the
        voice_assistant TTS channel is version-specific; wired as the single
        place the coordinator pushes audio so the maintenance-window bring-up
        edits ONE method. No-ops with a debug log when no session.
        """
        if not self.connected or self._client is None:
            log.debug("play_tts_audio called with no device session — no-op")
            return
        # OUTPUT seam (SPEAKING state). Two device-audio-out options:
        #   (a) self._client.send_voice_assistant_audio(_chunk) — push raw PCM
        #       frames over the API (NOT yet tested on this firmware).
        #   (b) self._client.media_player_command(<media_player_key>,
        #       media_url=<GET-able http url>, announcement=True) — CONFIRMED
        #       2026-06-07 to play out the speaker WHILE the AEC'd mic keeps
        #       streaming (the full-duplex result). Requires the coordinator to
        #       serve the TTS bytes at an HTTP URL the device can fetch. This is
        #       the proven path; wire the forza-TTS → HTTP bridge here.
        async for _chunk in pcm_chunks:
            # bind during the SPEAKING-state build (see options (a)/(b) above)
            pass

    def send_va_event(self, name: str, data: dict[str, str] | None = None) -> None:
        """Drive the device LED ring: send the matching VoiceAssistantEvent so the
        firmware animates the listen/think/speak phases. `name` is a phase key
        from _VA_LED_EVENTS (run_start / stt_start / stt_end / intent_start /
        tts_start / tts_end / run_end). No-ops without a session or an unknown
        name. Sync (the client call is sync)."""
        if not self.connected or self._client is None:
            return
        et = _VA_LED_EVENTS.get(name)
        if et is None:
            return
        try:
            self._client.send_voice_assistant_event(et, data)  # type: ignore[union-attr]
        except Exception:  # noqa: BLE001
            log.debug("send_va_event(%s) failed", name, exc_info=True)

    async def play_media_url(self, url: str) -> bool:
        """SPEAKING-state output: play `url` out the device speaker via the
        media_player, announcement-style so the AEC'd mic KEEPS streaming
        (full-duplex — confirmed 2026-06-07: media_player playback + open mic
        coexist). The coordinator serves `url` (its forza-TTS clip) on its own
        HTTP port; the device fetches it over the LAN. Returns False on no-op."""
        if not self.connected or self._client is None or self._media_player_key is None:
            log.debug("play_media_url: no session / no media_player — no-op")
            return False
        try:
            self._client.media_player_command(  # type: ignore[union-attr]
                self._media_player_key, media_url=url, announcement=True
            )
            return True
        except Exception:  # noqa: BLE001
            log.exception("play_media_url failed for %s", self.cfg.name)
            return False

    async def stop_playback(self) -> None:
        """BARGE-IN step 1: device audio off NOW (<100 ms target, design §3).

        Sends media_player STOP. NOTE: the stop LATENCY is not yet measured live —
        the integration window must confirm it clears the §3 <100 ms / sub-250 ms
        bar; if media_player STOP is too slow for an announcement, switch the
        SPEAKING output to send_voice_assistant_audio + voice_assistant.stop."""
        if not self.connected or self._client is None or self._media_player_key is None:
            log.debug("stop_playback called with no session / no media_player — no-op")
            return
        try:
            if MediaPlayerCommand is not None:
                self._client.media_player_command(  # type: ignore[union-attr]
                    self._media_player_key, command=MediaPlayerCommand.STOP
                )
                log.debug("stop_playback: media_player STOP sent to %s", self.cfg.name)
        except Exception:  # noqa: BLE001
            log.exception("stop_playback failed for %s", self.cfg.name)

    async def open_listen_run(self, media_url: str, timeout: float = 45.0) -> None:
        """Re-open the device mic DURING a reply for full-duplex barge-in. Fires a
        start_conversation announcement (the AEC-probe-proven mechanism): the
        device plays `media_url` (a silent opener) then opens a conversation, so
        the AEC'd mic streams to handle_audio while media_player plays the reply.
        Fire-and-forget — the await_response resolves when the device's own
        endpoint / `timeout` closes the run; we don't block the turn on it."""
        if not self.connected or self._client is None:
            log.debug("open_listen_run: no session — no-op")
            return

        async def _run() -> None:
            try:
                res = self._client.send_voice_assistant_announcement_await_response(  # type: ignore[union-attr]
                    media_url, timeout, "", "", True
                )
                if asyncio.iscoroutine(res):
                    await res
            except Exception:  # noqa: BLE001
                log.debug("open_listen_run announcement ended for %s", self.cfg.name, exc_info=True)

        asyncio.ensure_future(_run())
        log.info("opened barge-listen run (start_conversation) on %s media=%s", self.cfg.name, media_url)
