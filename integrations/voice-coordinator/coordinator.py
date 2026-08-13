"""The Hearth Voice Coordinator — wires the §3 barge-in loop together.

It owns:
  - a DeviceConnection (aioesphomeapi) for one Satellite1 (gracefully no-ops
    without a session — HA holds the live one),
  - the pure BargeInMachine that decides actions from events,
  - the executors that perform those actions: STT (parakeet), Hearth turn
    (create/message/stream/cancel), TTS (forza) → device playback,
  - an LD2450 presence latch that feeds the barge-in gate + a future Hearth
    presence republish,
  - a tiny aiohttp health endpoint for `restart: unless-stopped` on the LLM host.

The action executors for the DEVICE-AUDIO half are structured but their LIVE
verification is deferred to a maintenance window (the session conflict). The
Hearth turn-lifecycle + cancel half is fully exercised by
scripts/smoke-voice-coordinator.ts against the live orchestrator.

Run: `python -m integrations.voice_coordinator.coordinator`  (or via the
Dockerfile entrypoint). Config is all env (see config.py).
"""
from __future__ import annotations

import asyncio
import logging
import signal

from .audio_clients import SttClient, TtsClient
from .config import CoordinatorConfig
from .device import DeviceConnection
from .hearth_client import HearthClient, TurnEvent
from .ld2450 import parse_presence
from .vad import SileroVad
from .state_machine import (
    Action,
    ActionType,
    BargeInMachine,
    BargeInThresholds,
    Event,
    EventType,
)

log = logging.getLogger("voice_coordinator")


class VoiceCoordinator:
    def __init__(self, cfg: CoordinatorConfig) -> None:
        self.cfg = cfg
        self.machine = BargeInMachine(
            thresholds=BargeInThresholds(
                speech_threshold=cfg.vad.speech_threshold,
                endpoint_silence_ms=cfg.vad.endpoint_silence_ms,
                barge_in_min_ms=cfg.vad.barge_in_min_ms,
                barge_in_speech_threshold=cfg.vad.barge_in_speech_threshold,
            ),
            gate_barge_in_on_presence=cfg.gate_barge_in_on_presence,
        )
        self.hearth = HearthClient(cfg.hearth)
        self.stt = SttClient(cfg.stt)
        self.tts = TtsClient(cfg.tts)
        # Overlapped ("speculative") batch STT state (cfg.stt_overlap): at the first
        # trailing pause the coordinator fires a batch transcription of the utterance
        # so far so it finishes DURING the endpoint wait. _spec_task holds it,
        # _spec_stale marks it superseded when speech resumes; _run_stt uses it if
        # fresh, else re-transcribes.
        self._spec_task = None  # asyncio.Task[str] | None
        self._spec_stale = False
        self._silence_run = 0  # consecutive trailing-silence frames since last speech
        _frame_ms = max(1.0, cfg.vad.frame_samples / max(1, cfg.vad.sample_rate) * 1000.0)
        self._spec_trigger_frames = max(1, round(cfg.stt_overlap_silence_ms / _frame_ms))
        self.vad = SileroVad(
            cfg.vad.model_path or None,
            threshold=cfg.vad.speech_threshold,
            sample_rate=cfg.vad.sample_rate,
        )
        self.device = DeviceConnection(
            cfg.device,
            on_state=self._on_device_state,
            on_audio=self._on_mic_audio,
            on_wake=self._on_wake,
        )
        # Per-call state.
        self._conv_id: str | None = None
        self._turn_task: asyncio.Task | None = None
        self._stream_task: asyncio.Task | None = None
        # Accumulated entity states for the presence snapshot.
        self._entity_states: dict[str, object] = {}
        # Captured mic buffer for the current LISTENING window.
        self._capture = bytearray()
        # SPEAKING-state output — STREAMING (one clip per sentence). _synth_loop
        # synthesizes each reply sentence as it streams in (racing ahead of
        # playback); _play_loop plays clips back-to-back, sequenced by each clip's
        # MEASURED mp3 duration with the device's PLAYING/IDLE events as the
        # precise anchor + end. The earlier "streaming stalls 45 s → one-clip
        # buffer-then-speak" era was a MISDIAGNOSIS: the device reports IDLE
        # reliably, but media-state was routed by display name ("Media Player") so
        # IDLE was dropped and end-detection fell back to a bytes/2200 GUESS (the
        # ~15 s LED-lag). Fixed by routing media state by KEY (device.py);
        # streaming is safe + gap-free now (2026-06-08).
        self._reply_buf: list[str] = []          # sentences awaiting synth
        self._reply_done = False                 # REPLY_DONE seen for this turn
        self._turn_instruct = ""                 # emotion `instruct` for this reply (classified once)
        self._turn_instruct_done = False         # classified this turn yet?
        self._instruct_tasks: dict = {}          # idx → per-sentence classify task, pre-kicked at SPEAK
        self._clips: dict[str, bytes] = {}        # id → mp3 bytes, served at /tts/<id>
        self._clip_seq = 0
        self._ready: asyncio.Queue = asyncio.Queue()  # synthesized clips ready to play
        self._synth_task: asyncio.Task | None = None
        self._play_task: asyncio.Task | None = None
        self._playing = False                    # media_player is mid-clip
        self._play_started = asyncio.Event()     # set when media_player reports PLAYING (audio actually started)
        self._play_idle = asyncio.Event()        # set when media_player returns to idle after a clip
        self._vad_spoke = False                  # sent stt_vad_start this listening window? (LED)
        # Full-duplex barge-in: we RE-OPEN the device mic during THINKING/SPEAKING
        # (the device closes the wake run's mic right after STT) via a
        # start_conversation announcement. The handle_start it fires must be read
        # as the barge-mic, not a new user wake — _expecting_listen_open gates that.
        self._expecting_listen_open = False
        self._barge_listen_active = False
        self._barge_mic_opened = False           # opened the SPEAKING open-mic this turn? (B+, once per turn)
        self._speaking_frames = 0                # mic frames seen during SPEAKING (full-duplex telemetry)
        # Phase B (gapless): ONE continuous chunked HTTP stream per turn instead
        # of one media_player clip per sentence. forza mp3 is piped through as it
        # synthesizes → ONE media_player session = ONE stable mic↔ref delay so the
        # fixed_delay AEC converges once and HOLDS. See design-voice-barge-in.md §5.
        self._stream_q: "asyncio.Queue[bytes | None] | None" = None  # per-turn mp3 chunk queue
        self._stream_done = False                # synth finished + sentinel queued this turn
        self._stream_total_s = 0.0               # accumulated synthesized duration (play backstop)
        self._stream_url_name: str | None = None  # /tts/<this> is the current turn's stream
        self._turn_seq = 0                       # cache-busts the per-turn stream URL
        self._synth_stream_task: asyncio.Task | None = None
        self._play_stream_task: asyncio.Task | None = None
        # Phase A (button): rising-edge detect on the Action button binary_sensor.
        self._last_button_state: bool | None = None
        # LISTENING watchdog: each START_LISTENING bumps this; a stale guard no-ops.
        self._listen_seq = 0
        self._running = False
        self._stop_event = asyncio.Event()
        # Serializes proactive announces (spoken followups via POST /speak) so two
        # concluding followups can't talk over each other.
        self._announce_lock = asyncio.Lock()
        # How long a GENTLE (notice / tone-less) announce waits politely for the
        # device to go IDLE before dropping (it can afford to queue). A CRITICAL
        # (EAS) announce never waits this out — it BARGES the active turn and
        # plays now (see _announce / _barge_for_announce); _barge_settle is the
        # brief grace for the device to stop + the machine to land IDLE after the
        # barge. Instance attrs so a test can shorten them.
        self._announce_idle_wait_s = 120.0
        self._announce_barge_settle_s = 3.0
        # Honest `spoken`: for a CRITICAL announce, handle_speak waits up to this
        # long for the device to actually START playing before reporting
        # spoken:true (a take-cover alert's audit must reflect reality, not just
        # "accepted"). Kept under Hearth's /speak (try_speak_followup) 8s timeout.
        self._announce_confirm_s = 6.5

    # ── top-level run loop ─────────────────────────────────────────────────────

    async def run(self) -> None:
        self._running = True
        log.info(
            "voice coordinator starting — device=%s hearth=%s stt=%s tts=%s",
            self.cfg.device.host,
            self.cfg.hearth.base_url,
            self.cfg.stt.base_url,
            self.cfg.tts.base_url,
        )
        got_session = await self.device.start()
        if not got_session:
            log.warning(
                "no device session — running in standby (health up, retrying). "
                "The Hearth/STT/TTS contract is still reachable; the device half "
                "activates when a session is acquired (hand off from HA)."
            )
        # Stay up regardless (health endpoint + retry), per the §6 dependency
        # mitigation: "if it dies, fallback = re-enable HA's integration".
        await self._stop_event.wait()
        await self._shutdown()

    async def _shutdown(self) -> None:
        self._running = False
        await self._cancel_active_turn()
        await self.device.stop()
        await self.hearth.aclose()
        await self.stt.aclose()
        await self.tts.aclose()
        log.info("voice coordinator stopped")

    def request_stop(self) -> None:
        self._stop_event.set()

    # ── device callbacks → events ──────────────────────────────────────────────

    def _on_device_state(self, name: str, value: object) -> None:
        """Every entity-state update. Accumulate + refresh the presence latch,
        and watch the media_player for end-of-playback (→ PLAYBACK_DONE)."""
        self._entity_states[name] = value
        snap = parse_presence(self._entity_states)
        self.machine.set_presence(snap.present_and_near())
        # (Phase 3) republish snap into a Hearth presence store here.
        if isinstance(name, str) and "media_player" in name:
            self._on_media_state(value)
        elif isinstance(name, str) and name == self.cfg.barge_button_name:
            self._on_button_state(value)  # Phase A: physical Action button → barge

    @staticmethod
    def _mp_is(value: object, *names: str) -> bool:
        s = str(value).upper()
        try:
            s = {0: "NONE", 1: "IDLE", 2: "PLAYING", 3: "PAUSED"}.get(int(value), s)  # type: ignore[arg-type]
        except (TypeError, ValueError):
            pass
        return any(n in s for n in names)

    def _on_media_state(self, value: object) -> None:
        """Track media_player playback so _play_loop can sequence clips: PLAYING
        clears the idle latch; IDLE/PAUSED/NONE after a clip sets it. The
        per-turn end (→ PLAYBACK_DONE) is owned by _play_loop, not this."""
        if self._mp_is(value, "PLAYING"):
            self._playing = True
            self._play_started.set()
            self._play_idle.clear()
        elif self._playing and self._mp_is(value, "IDLE", "PAUSED", "NONE"):
            self._playing = False
            self._play_idle.set()

    def _on_button_state(self, value: object) -> None:
        """Phase A: the Action button is a binary_sensor; fire on the rising edge
        (press), not release. Deterministic, AEC-independent barge."""
        pressed = value is True or str(value).strip().lower() in ("on", "true", "1")
        prev = self._last_button_state
        self._last_button_state = pressed
        if pressed and prev is not True:
            self._on_button_press()

    def _on_button_press(self) -> None:
        """A button press = a deterministic interrupt. The firmware already stops
        playback locally on a single press; the coordinator mirrors it: tear down
        our stream + cancel the Hearth turn + end the run (idle). The user re-wakes
        ('Hey Kate') for the next turn — the acoustic open mic (B+) is the
        redirect-in-place path; the button is the always-correct 'stop'."""
        from .state_machine import State
        if not self.cfg.barge_button:
            return
        st = self.machine.state
        if st not in (State.SPEAKING, State.THINKING):
            return  # nothing in flight to interrupt
        log.info("action button → interrupt (state=%s)", st.value)
        if st == State.SPEAKING:
            self._reset_playback()
            self._playing = False
            asyncio.ensure_future(self.device.stop_playback())
        asyncio.ensure_future(self._cancel_active_turn())
        self._dispatch(Event(type=EventType.RESET))  # → IDLE + run_end LED

    def _on_wake(self, phrase: str) -> None:
        from .state_machine import State
        # Our own opener (start_conversation) fires the NEXT handle_start when its
        # run opens — and the device labels that event with the CONVERSATION's wake
        # phrase (e.g. "Hey Kate"), NOT an empty string. Consume that first event as
        # the opener coming up regardless of phrase (it's ours, not a user wake) —
        # else the opener instantly self-barges its own turn. A real "Hey Kate"
        # barge is a LATER handle_start, after this latch has cleared.
        if self._expecting_listen_open:
            self._expecting_listen_open = False
            self._barge_listen_active = True
            log.info("barge-mic opener run started (consumed, not a wake; phrase=%r)", phrase)
            return
        # WAKE-WORD BARGE (2026-06-08): the device's on-device wake spotter fires
        # even while Kate is replying — and it's echo-robust (runs on the AEC'd
        # channel, matches one word) unlike the open mic we were fighting the AEC
        # over. A wake DURING SPEAKING is a deliberate interrupt → barge (the state
        # machine stops playback, cancels the turn, reopens to listen). Gated by
        # enable_barge_in.
        if self.machine.state == State.SPEAKING:
            if not self.cfg.enable_barge_in:
                log.info("wake during SPEAKING ignored (barge disabled, phrase=%r)", phrase)
                return
            log.info("wake during SPEAKING (phrase=%r) → BARGE interrupt", phrase)
            self._dispatch(Event(type=EventType.WAKE))  # → state machine _begin_barge_in
            return
        log.info("wake detected (phrase=%r)", phrase)
        self.device.send_va_event("run_start")  # LED ring: run begins
        self._dispatch(Event(type=EventType.WAKE))

    def _on_mic_audio(self, frame: bytes) -> None:
        """AEC'd mic frame. Run VAD, capture during LISTENING, and feed the
        barge-in detector during SPEAKING.

        VAD is intentionally a thin seam: the real Silero call binds here during
        bring-up. The state machine consumes the (prob, is_speech) decision —
        which is what the unit tests drive directly with synthetic frames. We
        keep the buffer so an endpointed utterance can be sent to STT.
        """
        from .state_machine import State

        prob, is_speech = self._vad_decide(frame)
        # Capture raw audio while listening so we can transcribe on endpoint, and
        # signal speech ONSET to the device LED ring (→ "listening for command").
        rms = 0.0
        if self.machine.state == State.LISTENING:
            self._capture.extend(frame)
            if is_speech:
                if not self._vad_spoke:
                    self._vad_spoke = True
                    self.device.send_va_event("stt_vad_start")  # LED ring: actively hearing you
                # speech (re)started — any earlier speculative transcript is incomplete
                if self._spec_task is not None:
                    self._spec_stale = True
                self._silence_run = 0
            elif self._vad_spoke:
                # trailing silence after speech: fire ONE speculative batch STT early
                # (before the full endpoint wait) so decode overlaps the wait.
                self._silence_run += 1
                if self.cfg.stt_overlap and self._silence_run == self._spec_trigger_frames:
                    self._fire_speculative_stt()
        elif self.machine.state == State.SPEAKING:
            # B+: the adaptive echo-floor DECISION lives in the pure state machine;
            # here we just MEASURE loudness and thread it in via Event.rms. Kate's
            # AEC'd residual is speech-shaped (high Silero prob) but quiet; the
            # machine peak-holds it and only barges on a SUSTAINED run loud enough
            # to clear the adaptive floor. The "mic SPEAKING rms=" trace is how the
            # floor is tuned from live telemetry.
            self._speaking_frames += 1
            rms = self._frame_rms(frame)
            if is_speech or self._speaking_frames % 31 == 1:
                log.info(
                    "mic SPEAKING: frame#%d prob=%.2f rms=%.0f echo_peak=%.0f",
                    self._speaking_frames, prob, rms, self.machine._echo_rms_peak,
                )
        ts_ms = self._now_ms()
        self._dispatch(
            Event(type=EventType.VAD_FRAME, speech_prob=prob, is_speech=is_speech, ts_ms=ts_ms, rms=rms)
        )

    # ── the action executor ─────────────────────────────────────────────────────

    def _dispatch(self, ev: Event) -> None:
        """Feed an event to the machine and execute the actions it returns."""
        for action in self.machine.handle(ev):
            self._execute(action)

    def _execute(self, action: Action) -> None:
        if action.type == ActionType.START_LISTENING:
            self._capture = bytearray()
            self._reset_playback()  # cancel any in-flight synth/play, drop stale reply
            self._vad_spoke = False  # re-arm speech-onset LED signal
            self.vad.reset()  # fresh recurrent state per utterance
            self.device.send_va_event("stt_start")  # LED ring: waiting for command
            self._listen_seq += 1
            asyncio.ensure_future(self._listen_timeout_guard(self._listen_seq))
            log.debug("→ LISTENING")
        elif action.type == ActionType.RUN_STT:
            # End-of-speech: stt_vad_end is the event the firmware LED keys on to
            # switch to the "thinking" animation (the transition Jasper wanted).
            self.device.send_va_event("stt_vad_end")  # LED ring: thinking
            self.device.send_va_event("stt_end")
            asyncio.ensure_future(self._run_stt())
        elif action.type == ActionType.SEND_TURN:
            self.device.send_va_event("intent_start")  # LED ring: thinking
            asyncio.ensure_future(self._send_turn(action.text))
        elif action.type == ActionType.SPEAK:
            # Stream: buffer the sentence and make sure the synth+play pipeline is
            # running (synth races ahead so playback doesn't starve between
            # sentences). The first sentence starts playback immediately.
            self._reply_buf.append(action.text)
            # Pre-kick this sentence's emotion classify NOW (as it arrives, well ahead
            # of when the synth loop reaches it) so its latency overlaps earlier
            # sentences' synth+playback instead of stalling the gapless stream.
            self._kick_instruct(len(self._reply_buf) - 1)
            self._ensure_player()
        elif action.type == ActionType.STOP_PLAYBACK:
            self._reset_playback()  # cancel synth/play + drop queued audio (barge-in)
            self._playing = False
            asyncio.ensure_future(self.device.stop_playback())
        elif action.type == ActionType.CANCEL_TURN:
            asyncio.ensure_future(self._cancel_active_turn())
        elif action.type == ActionType.GO_IDLE:
            self._expecting_listen_open = False
            self._barge_listen_active = False
            self.device.send_va_event("run_end")  # LED ring: idle (off) + ends the device run
            log.debug("→ IDLE")

    async def _listen_timeout_guard(self, seq: int) -> None:
        """Self-heal a hung LISTENING window. A false wake (or a wake with no command)
        leaves the machine in LISTENING with no endpoint — the device LED ring spins
        forever. If this same listen session is still LISTENING after max_listen_s
        with NO speech onset yet (a false / abandoned wake), reset to IDLE (→ run_end
        → ring off). Gated on no-speech (_vad_spoke), so once the user starts talking
        the endpoint owns the close-out and a real command is never cut off; seq-
        guarded so a newer listen makes it a no-op."""
        from .state_machine import State
        await asyncio.sleep(self.cfg.vad.max_listen_s)
        if (seq == self._listen_seq and self.machine.state == State.LISTENING
                and not self._vad_spoke):
            log.info("LISTENING timed out (%.0fs, no speech) → reset to idle", self.cfg.vad.max_listen_s)
            self._dispatch(Event(type=EventType.RESET))

    def _fire_speculative_stt(self) -> None:
        """Kick a batch transcription of the utterance-so-far at the first trailing
        pause, so it overlaps the endpoint-silence wait. Supersedes any in-flight
        speculative task (a resumed-then-paused utterance re-fires with the fuller
        buffer). _run_stt awaits the latest one + uses it if speech didn't resume.
        Fail-open: the task returns '' on error and _run_stt re-transcribes."""
        if self._spec_task is not None and not self._spec_task.done():
            self._spec_task.cancel()  # supersede — this buffer is longer
        pcm = bytes(self._capture)
        if not pcm:
            return
        self._spec_stale = False
        self._spec_task = asyncio.ensure_future(self._transcribe_speculative(pcm))

    async def _transcribe_speculative(self, pcm: bytes) -> str:
        try:
            return await self.stt.transcribe_wav(self._capture_to_wav(pcm))
        except Exception:  # noqa: BLE001
            return ""

    async def _run_stt(self) -> None:
        pcm = bytes(self._capture)
        self._capture = bytearray()
        task = self._spec_task
        self._spec_task = None
        stale = self._spec_stale
        self._spec_stale = False
        self._silence_run = 0
        text = ""
        # Prefer the overlapped speculative transcript — fired at the trailing pause,
        # it (almost) always finished during the endpoint wait, so post-endpoint STT
        # is ~0. Use it only if speech didn't resume after it fired (else it's an
        # incomplete utterance); on empty/error, re-transcribe the full capture.
        if self.cfg.stt_overlap and task is not None and not stale:
            try:
                text = await asyncio.wait_for(task, timeout=self.cfg.stt.timeout_s)
            except Exception:  # noqa: BLE001
                text = ""
            if text:
                log.info("STT (overlapped) → %r", text)
        if not text:
            if task is not None and not task.done():
                task.cancel()
            try:
                text = await self.stt.transcribe_wav(self._capture_to_wav(pcm))
            except Exception:  # noqa: BLE001
                log.exception("STT failed")
                text = ""
            log.info("STT → %r", text)
        self._dispatch(Event(type=EventType.TRANSCRIPT, text=text))

    async def _send_turn(self, text: str) -> None:
        # Resolve/reuse the voice conversation, then fire the turn and stream
        # the reply. The reply sentences feed REPLY_SENTENCE events back into
        # the machine (→ SPEAKING) and to TTS.
        if self._conv_id is None:
            try:
                self._conv_id = await self.hearth.create_or_reuse_voice_conversation()
            except Exception:  # noqa: BLE001
                log.exception("could not create voice conversation")
                self._dispatch(Event(type=EventType.RESET))
                return
        conv_id = self._conv_id
        self._turn_task = self.hearth.send_message(conv_id, text)
        self._stream_task = asyncio.ensure_future(self._consume_reply(conv_id))
        # Barge-in is the device WAKE WORD now (see _on_wake) — no open mic during
        # the reply, so nothing to set up here. The device's on-device wake spotter
        # fires even while Kate plays; we catch that handle_start as a deliberate
        # interrupt. (The old open-mic VAD path fought the AEC and is retired.)

    async def _consume_reply(self, conv_id: str) -> None:
        """Buffer streamed deltas into sentences and feed REPLY_SENTENCE events."""
        buf = ""
        try:
            async for ev in self.hearth.stream_reply(conv_id):
                if ev.kind == "token":
                    buf += ev.text
                    while True:
                        cut = _next_sentence_boundary(buf)
                        if cut < 0:
                            break
                        sentence = buf[:cut].strip()
                        buf = buf[cut:]
                        if sentence:
                            self._dispatch(Event(type=EventType.REPLY_SENTENCE, text=sentence))
                elif ev.kind == "done":
                    if buf.strip():
                        self._dispatch(Event(type=EventType.REPLY_SENTENCE, text=buf.strip()))
                        buf = ""
                    self._dispatch(Event(type=EventType.REPLY_DONE))
                    self._reply_done = True   # synth loop emits its sentinel once the buffer drains
                    self._ensure_player()     # covers an empty reply (no SPEAK fired)
                    return
        except Exception:  # noqa: BLE001
            log.exception("reply stream failed for %s", conv_id)
            self._dispatch(Event(type=EventType.REPLY_DONE))
            self._reply_done = True
            self._ensure_player()

    # ── streaming TTS pipeline (synth-ahead + sequential play) ─────────────────

    def _ensure_player(self) -> None:
        """Start the playback workers for this turn if not already running. Mode
        'stream_gapless' = ONE continuous chunked stream; 'stream' = per-sentence
        multi-clip. Either way, fire the wake-able 'opener' when barge is enabled so
        "Hey Kate" can interrupt mid-reply (see _maybe_open_barge_mic)."""
        self._maybe_open_barge_mic()
        if self.cfg.tts_playback_mode == "stream_gapless":
            self._ensure_gapless_player()
            return
        if self._synth_task is None or self._synth_task.done():
            self._synth_task = asyncio.ensure_future(self._synth_loop())
        if self._play_task is None or self._play_task.done():
            self._play_task = asyncio.ensure_future(self._play_loop())

    def _maybe_open_barge_mic(self) -> None:
        """Fire a start_conversation 'opener' during the reply when voice barge is
        enabled. Confirmed live (2026-06-08): this keeps the device WAKE-able while it
        plays, so "Hey Kate" mid-reply fires a wake → _on_wake → barge. Without it the
        device fires NO wake during playback (multi-clip OR gapless), so the only
        interrupt is the button. (The open mic the run also exposes is preempted by the
        media_player playback, so the wake-word path — not an open-mic VAD — is the
        working interrupt.) Once per turn; the opener's own handle_start is consumed via
        _expecting_listen_open, not treated as a wake."""
        if not self.cfg.enable_barge_in or self._barge_mic_opened:
            return
        self._barge_mic_opened = True
        self._expecting_listen_open = True
        opener = f"http://{self.cfg.self_host}:{self.cfg.health_port}/tts/_open.mp3"
        asyncio.ensure_future(self.device.open_listen_run(opener))

    def _ensure_gapless_player(self) -> None:
        """Phase B: start the single-stream synth + play workers for this turn. ONE
        chunked HTTP resource (forza mp3 piped through as it synthesizes), ONE
        media_player session → the fixed_delay AEC converges once and HOLDS.
        Same time-to-first-word as multi-clip (playback starts at the first bytes),
        without the per-clip restarts that de-converge the AEC."""
        if self._synth_stream_task is not None and not self._synth_stream_task.done():
            return  # already streaming this turn; the synth loop picks up new sentences
        self._turn_seq += 1
        self._stream_url_name = f"turn{self._turn_seq}.mp3"
        self._stream_q = asyncio.Queue(maxsize=512)
        self._stream_done = False
        self._stream_total_s = 0.0
        # The wake-able opener (so "Hey Kate" can barge) is fired by _ensure_player
        # via _maybe_open_barge_mic — for BOTH playback modes, not just here.
        self._synth_stream_task = asyncio.ensure_future(self._synth_stream_loop())
        self._play_stream_task = asyncio.ensure_future(self._play_stream_loop())

    def _kick_instruct(self, idx: int) -> None:
        """Start sentence `idx`'s emotion classify as a background task the MOMENT the
        sentence arrives (from SPEAK) — so it runs while earlier sentences synth+play,
        not inline before this one's synth (the inter-sentence-gap regression). No-op
        when emotion is off / turn-once / already kicked. Cheap + fail-open; the task
        returns '' on error. _get_instruct awaits it at synth time, by which point it
        is almost always done → no gap."""
        if not self.cfg.enable_emotion or not self.cfg.emotion_per_sentence:
            return
        if idx in self._instruct_tasks or idx < 0 or idx >= len(self._reply_buf):
            return
        sentence = self._reply_buf[idx].strip()
        if not sentence:
            return
        # Context = the whole reply buffered so far (through this sentence).
        context = " ".join(s.strip() for s in self._reply_buf if s.strip())
        self._instruct_tasks[idx] = asyncio.ensure_future(self._classify_ps(sentence, context))

    async def _classify_ps(self, sentence: str, context: str) -> str:
        try:
            instruct = await self.hearth.classify_emotion(sentence, context=context)
        except Exception:  # noqa: BLE001
            return ""
        if instruct:
            log.info("sentence emotion → instruct=%r sent=%r", instruct, sentence[:48])
        return instruct

    async def _get_instruct(self, idx: int, sentence: str) -> str:
        """The emotion `instruct` for sentence `idx`, called by the synth loop. Turn-once
        classifies the first sentence + reuses it. Per-sentence AWAITS the task pre-kicked
        at SPEAK (its latency already overlapped earlier playback), BOUNDED by
        emotion_wait_ms so a slow/contended classify falls back to neutral rather than
        stalling the gapless stream. Gated on cfg.enable_emotion; fail-open to ''."""
        if not self.cfg.enable_emotion:
            return ""
        if not self.cfg.emotion_per_sentence:
            # Turn-once: classify the first sentence, reuse for the whole turn.
            if not self._turn_instruct_done:
                self._turn_instruct_done = True
                try:
                    self._turn_instruct = await self.hearth.classify_emotion(sentence)
                except Exception:  # noqa: BLE001
                    self._turn_instruct = ""
                if self._turn_instruct:
                    log.info("turn emotion → instruct=%r", self._turn_instruct)
            return self._turn_instruct
        # Per-sentence: await the pre-kicked task (start one now if SPEAK didn't).
        task = self._instruct_tasks.get(idx)
        if task is None:
            self._kick_instruct(idx)
            task = self._instruct_tasks.get(idx)
        if task is None:
            return ""
        try:
            return await asyncio.wait_for(
                asyncio.shield(task), timeout=self.cfg.emotion_wait_ms / 1000.0
            )
        except asyncio.TimeoutError:
            return ""  # not ready in time → speak neutral now, never stall the stream
        except Exception:  # noqa: BLE001
            return ""

    def _reset_playback(self) -> None:
        """Tear the pipeline down (new listen / barge-in): cancel the workers,
        drop buffered text + queued clips/stream, clear the per-turn flags."""
        for t in (self._synth_task, self._play_task, self._synth_stream_task, self._play_stream_task):
            if t is not None and not t.done():
                t.cancel()
        self._synth_task = self._play_task = None
        self._synth_stream_task = self._play_stream_task = None
        self._reply_buf = []
        self._reply_done = False
        self._turn_instruct = ""
        self._turn_instruct_done = False
        for _t in self._instruct_tasks.values():
            if _t is not None and not _t.done():
                _t.cancel()
        self._instruct_tasks = {}
        self._playing = False
        self._play_started.clear()
        self._play_idle.clear()
        self._barge_mic_opened = False
        # Cancel any in-flight speculative STT + reset the overlap state (barge / new listen).
        if self._spec_task is not None and not self._spec_task.done():
            self._spec_task.cancel()
        self._spec_task = None
        self._spec_stale = False
        self._silence_run = 0
        # gapless: close + drop the per-turn stream so an open serve handler ends.
        if self._stream_q is not None:
            try:
                self._stream_q.put_nowait(None)
            except Exception:  # noqa: BLE001
                pass
        self._stream_q = None
        self._stream_url_name = None
        self._stream_done = False
        self._stream_total_s = 0.0
        while not self._ready.empty():
            try:
                self._ready.get_nowait()
            except asyncio.QueueEmpty:  # pragma: no cover
                break

    async def _synth_loop(self) -> None:
        """Streaming synth: synthesize each reply sentence into its OWN clip as it
        streams in (racing ahead of playback) and queue it with its measured
        duration → playback starts after sentence 1 (the time-to-first-word win).
        Always streams now: barge-in is the device WAKE WORD (an echo-robust
        on-device spotter), not an open mic, so we no longer need single-clip
        buffering to coax AEC convergence. On REPLY_DONE + drained, sentinel."""
        try:
            idx = 0
            while True:
                # Await the next streamed sentence (or end-of-reply).
                while idx >= len(self._reply_buf) and not self._reply_done:
                    await asyncio.sleep(0.02)
                if idx >= len(self._reply_buf) and self._reply_done:
                    break  # every sentence synthesized
                sentence = self._reply_buf[idx].strip()
                idx += 1
                if not sentence:
                    continue
                instruct = await self._get_instruct(idx, sentence)
                try:
                    clip = await self.tts.synthesize(sentence, instruct=instruct)  # mp3 (cfg.response_format)
                except Exception:  # noqa: BLE001
                    log.exception("TTS synth failed for a sentence")
                    continue
                dur = mp3_duration_seconds(clip) or max(1.5, len(clip) / 2200.0)
                await self._ready.put((clip, dur))
            await self._ready.put(None)  # sentinel: turn's audio complete
        except asyncio.CancelledError:
            raise

    async def _play_loop(self) -> None:
        """Duration-driven sequencer: play each ready clip back-to-back, advancing
        the instant a clip's audio actually ends. End-detection is the device's
        media_player IDLE event (reliable per-clip — confirmed live), ANCHORED on
        its PLAYING event and BOUNDED by the clip's measured mp3 duration so a
        missed event can NEVER stall (the old code fired a bytes/2200 guess and
        left the ring lit ~15 s past the audio). On the sentinel, ends the run
        (→ PLAYBACK_DONE → GO_IDLE → RUN_END → LED idle)."""
        spoke = False
        try:
            while True:
                item = await self._ready.get()
                if item is None:
                    break  # turn's audio complete
                clip, dur = item
                if not spoke:
                    spoke = True
                    self.device.send_va_event("tts_start")  # LED ring: replying
                self._clip_seq += 1
                cid = f"r{self._clip_seq}.mp3"
                self._clips[cid] = clip
                for stale in list(self._clips)[:-4]:  # keep only the last few served
                    self._clips.pop(stale, None)
                url = f"http://{self.cfg.self_host}:{self.cfg.health_port}/tts/{cid}"
                log.info("speaking clip %s (%d bytes, %.1fs) via media_player", cid, len(clip), dur)
                self._play_started.clear()
                self._play_idle.clear()
                self._playing = False
                if not await self.device.play_media_url(url):
                    continue  # no session/media_player — skip this clip
                await self._await_clip_end(dur)
            self._dispatch(Event(type=EventType.PLAYBACK_DONE))
        except asyncio.CancelledError:
            raise  # cancelled (barge-in / new listen) — the new state owns what's next

    async def _await_clip_end(self, dur: float) -> None:
        """Block until the current clip's audio ends. Wait for PLAYING first (the
        device fetched + started — so the duration bound counts from real audio
        start, not the send), then return on the IDLE event OR the measured
        duration + margin, whichever comes first. IDLE is the precise signal;
        duration is the can't-stall backstop."""
        try:
            await asyncio.wait_for(self._play_started.wait(), timeout=3.0)
        except asyncio.TimeoutError:
            pass  # never saw PLAYING — bound by duration from here anyway
        try:
            await asyncio.wait_for(self._play_idle.wait(), timeout=dur + 2.0)
        except asyncio.TimeoutError:
            log.debug("clip end fell back to duration bound (%.1fs)", dur)

    # ── proactive announce (spoken followups) ───────────────────────────────────

    async def handle_speak(self, text: str, pre_tone: "str | None" = None) -> dict:
        """POST /speak — proactively speak `text` on the device IF the user is
        present+near, else report away so Hearth pushes instead ("present now,
        else push", 2026-06-15). A one-shot NOTIFICATION, not a conversation turn:
        no wake/listen/barge machinery.

        `pre_tone` ('critical'|'notice') plays an alert tone AHEAD of the speech
        — used by Hearth's dangerous-weather / air-quality announcements.

        HONEST `spoken` (2026-06-26): a CRITICAL (EAS) announce waits (bounded,
        under Hearth's 8s timeout) for the device to actually START playing and
        reports `spoken:true` only if it did — a take-cover alert's audit must
        reflect reality, not just "accepted". On no-confirmed-play it returns
        `spoken:false` so Hearth records it honestly + the driver's separate phone
        push is the backstop. A GENTLE announce keeps the fast present-based return
        (it plays in the background and can afford to queue / fall back to push)."""
        if not self.cfg.enable_announce:
            return {"spoken": False, "reason": "disabled"}
        text = (text or "").strip()
        if not text:
            return {"spoken": False, "reason": "empty"}
        if not self.device.connected:
            return {"spoken": False, "reason": "no_device"}
        snap = parse_presence(self._entity_states)
        # present_and_near matches the approved "present+near" behavior; loosen to
        # snap.present (in-room) if followups push too often when he's across the room.
        if not snap.present_and_near():
            return {"spoken": False, "reason": "away"}
        if pre_tone == "critical":
            started = asyncio.get_running_loop().create_future()
            asyncio.ensure_future(self._announce(text, pre_tone=pre_tone, started=started))
            try:
                ok = await asyncio.wait_for(asyncio.shield(started), self._announce_confirm_s)
            except asyncio.TimeoutError:
                ok = False  # didn't start in time — the driver's push is the honest backstop
            return {"spoken": bool(ok), "reason": "present" if ok else "play_unconfirmed"}
        asyncio.ensure_future(self._announce(text, pre_tone=pre_tone))
        return {"spoken": True, "reason": "present"}

    async def _play_announce_clip(
        self, clip: bytes, prefix: str, started: "asyncio.Future | None" = None
    ) -> bool:
        """Register `clip` as a served /tts/<id> and play it ONCE on the device,
        waiting (bounded) for it to finish. Returns False if there's no media
        session. The shared per-clip play step for _announce (tone, then speech).
        `started` (the honest-`spoken` confirmation future) is resolved the moment
        the device ACCEPTS the play (True) or there's no session (False)."""
        self._clip_seq += 1
        cid = f"{prefix}{self._clip_seq}.mp3"
        self._clips[cid] = clip
        for stale in list(self._clips)[:-4]:  # keep only the last few served
            self._clips.pop(stale, None)
        url = f"http://{self.cfg.self_host}:{self.cfg.health_port}/tts/{cid}"
        dur = mp3_duration_seconds(clip) or (len(clip) / 2200.0)
        log.info("announce: playing clip %s (%d bytes, %.1fs) via media_player", cid, len(clip), dur)
        self._play_started.clear()
        self._play_idle.clear()
        self._playing = False
        if not await self.device.play_media_url(url):
            log.info("announce: no media_player session — dropped")
            if started is not None and not started.done():
                started.set_result(False)
            return False
        if started is not None and not started.done():
            started.set_result(True)  # device accepted the play → audio is starting
        await self._await_clip_end(dur)
        return True

    def _barge_for_announce(self) -> None:
        """Preempt an in-flight conversation turn so an EMERGENCY announce plays
        NOW instead of queuing behind it — the SAME teardown the action button
        does (stop playback + cancel the Hearth turn + RESET → IDLE). Used only
        for the critical (EAS) tier: a real CO₂-leak / tornado / smoke-alarm alert
        must not wait politely behind a casual conversation."""
        from .state_machine import State

        st = self.machine.state
        if st == State.IDLE:
            return
        log.info("emergency announce → barging active turn (state=%s)", st.value)
        if st == State.SPEAKING:
            self._reset_playback()
            self._playing = False
            asyncio.ensure_future(self.device.stop_playback())
        asyncio.ensure_future(self._cancel_active_turn())
        self._dispatch(Event(type=EventType.RESET))  # → IDLE + run_end LED

    async def _announce(
        self, text: str, pre_tone: "str | None" = None, started: "asyncio.Future | None" = None
    ) -> None:
        """Synthesize the reply clip (optionally preceded by an alert tone) and
        play it via the device media_player. A GENTLE announce waits (bounded) for
        IDLE so it never talks over a live turn; a CRITICAL (EAS) announce BARGES
        the active turn and plays immediately — a take-cover alert can't queue
        behind a conversation (the 2026-06-25 "the test fired 20s late behind a
        chat" diagnosis). Best-effort: any failure just means the user reads it in
        the thread instead. Serialized by _announce_lock. `started` (the honest-
        `spoken` confirmation future, critical path) is resolved True the moment
        the first clip starts playing, False on any drop/failure."""
        from .state_machine import State

        def _resolve(ok: bool) -> None:  # settle the honest-spoken future once
            if started is not None and not started.done():
                started.set_result(ok)

        async with self._announce_lock:
            if pre_tone == "critical":
                # EMERGENCY: barge whatever's in flight + play NOW. Never wait the
                # polite timeout; a brief settle for the device to stop + land
                # IDLE, then play regardless (media_player.play replaces current
                # audio even if the machine hasn't fully settled).
                if self.machine.state != State.IDLE:
                    self._barge_for_announce()
                    waited = 0.0
                    while self.machine.state != State.IDLE and waited < self._announce_barge_settle_s:
                        await asyncio.sleep(0.1)
                        waited += 0.1
            else:
                # Gentle / awareness announce — queue politely behind a live turn.
                waited = 0.0
                while self.machine.state != State.IDLE and waited < self._announce_idle_wait_s:
                    await asyncio.sleep(0.2)
                    waited += 0.2
                if self.machine.state != State.IDLE:
                    log.info("announce dropped — device busy %.0fs (reply is in the thread)", waited)
                    _resolve(False)
                    return
            instruct = await self.hearth.classify_emotion(text) if self.cfg.enable_emotion else ""
            try:
                clip = await self.tts.synthesize(text, instruct=instruct)
            except Exception:  # noqa: BLE001
                log.exception("announce TTS synth failed")
                _resolve(False)
                return
            if not clip:
                _resolve(False)
                return
            self.device.send_va_event("tts_start")  # LED ring: replying
            played_first = False
            try:
                if pre_tone:
                    # Best-effort alert tone AHEAD of the speech; a tone failure
                    # (synth/encode/no-session) must NOT swallow the announcement.
                    # The tone (or, if it fails, the speech) carries the `started`
                    # confirmation — it resolves the moment the device plays it.
                    from .tones import tone_mp3

                    tone = tone_mp3(pre_tone)
                    if tone:
                        played_first = await self._play_announce_clip(tone, "tone", started=started)
                if not await self._play_announce_clip(
                    clip, "a", started=None if played_first else started
                ):
                    _resolve(False)
                    return
                _resolve(True)
            finally:
                self.device.send_va_event("run_end")  # LED ring: back to idle

    # ── gapless single-stream pipeline (Phase B) ───────────────────────────────

    async def _synth_stream_loop(self) -> None:
        """Pipe forza's streaming mp3 for each reply sentence into the ONE per-turn
        chunk queue (the serve_tts handler drains it to the device). mp3 frames
        concatenate gaplessly; the device plays them as one continuous session. On
        REPLY_DONE + drained, queue the sentinel (None) → the HTTP response closes
        → the device drains + goes IDLE → PLAYBACK_DONE."""
        q = self._stream_q
        if q is None:  # pragma: no cover - guarded by caller
            return
        try:
            idx = 0
            while True:
                while idx >= len(self._reply_buf) and not self._reply_done:
                    await asyncio.sleep(0.02)
                if idx >= len(self._reply_buf) and self._reply_done:
                    break  # every streamed sentence synthesized
                sentence = self._reply_buf[idx].strip()
                idx += 1
                if not sentence:
                    continue
                instruct = await self._get_instruct(idx, sentence)
                sbytes = bytearray()
                try:
                    async for chunk in self.tts.synthesize_stream(sentence, instruct=instruct):
                        if chunk:
                            sbytes.extend(chunk)
                            await q.put(bytes(chunk))
                except Exception:  # noqa: BLE001
                    log.exception("TTS stream synth failed for a sentence")
                    continue
                self._stream_total_s += mp3_duration_seconds(bytes(sbytes)) or (len(sbytes) / 2200.0)
            await q.put(None)  # sentinel: stream complete → close the HTTP response
            self._stream_done = True
        except asyncio.CancelledError:
            # barge-in / new listen: unblock any open serve handler, then propagate.
            try:
                q.put_nowait(None)
            except Exception:  # noqa: BLE001
                pass
            raise

    async def _play_stream_loop(self) -> None:
        """Fire ONE media_player play for the whole turn's stream, then wait for the
        device to finish it (IDLE). The device's AudioReader blocks on the open
        chunked connection (it waits on slow reads, never EOFs a transient gap —
        confirmed in audio_reader.cpp), so IDLE fires only after the synth closes
        the stream + the device drains: that's true end-of-turn → PLAYBACK_DONE →
        GO_IDLE → RUN_END (LED idle)."""
        try:
            self.device.send_va_event("tts_start")  # LED ring: replying
            url = f"http://{self.cfg.self_host}:{self.cfg.health_port}/tts/{self._stream_url_name}"
            self._play_started.clear()
            self._play_idle.clear()
            self._playing = False
            log.info("speaking gapless stream %s via media_player", self._stream_url_name)
            if not await self.device.play_media_url(url):
                self._dispatch(Event(type=EventType.PLAYBACK_DONE))  # no session — end the turn
                return
            try:
                await asyncio.wait_for(self._play_started.wait(), timeout=5.0)
            except asyncio.TimeoutError:
                pass  # never saw PLAYING — fall through to the IDLE / backstop wait
            # IDLE is the precise end. Backstop: a hard turn-timeout ceiling, and —
            # once the synth has closed the stream — a duration-bounded drain wait,
            # so a missed IDLE can never hang the turn.
            hard_ms = self._now_ms() + int(self.cfg.hearth.turn_timeout_s * 1000)
            drain_deadline_ms: int | None = None
            while not self._play_idle.is_set():
                now = self._now_ms()
                if now > hard_ms:
                    log.debug("gapless: hard timeout waiting for IDLE")
                    break
                if self._stream_done:
                    if drain_deadline_ms is None:
                        drain_deadline_ms = now + int((self._stream_total_s + 6.0) * 1000)
                    elif now > drain_deadline_ms:
                        log.debug("gapless: drain backstop hit waiting for IDLE")
                        break
                await asyncio.sleep(0.1)
            self._dispatch(Event(type=EventType.PLAYBACK_DONE))
        except asyncio.CancelledError:
            raise  # barge-in / new listen — the new state owns what's next

    async def _cancel_active_turn(self) -> None:
        if self._conv_id is not None:
            await self.hearth.cancel(self._conv_id)
        if self._stream_task is not None:
            self._stream_task.cancel()
            self._stream_task = None

    # ── VAD + audio seams (bound during bring-up) ──────────────────────────────

    def _vad_decide(self, frame: bytes) -> tuple[float, bool]:
        """Silero VAD: one 16 kHz mono 16-bit PCM frame → (speech_prob, is_speech).

        Bound to the real model in vad.SileroVad (fail-soft → (0.0, False) if the
        onnx model is absent, so the coordinator still runs). The barge-in
        DECISION (sustain window + echo-floor threshold) lives in the pure state
        machine, which applies both the listening and barge-in thresholds to this
        raw probability.
        """
        return self.vad.process_frame(frame)

    def _frame_rms(self, frame: bytes) -> float:
        """RMS energy of a 16-bit PCM frame — the barge gate's loudness measure
        (Kate's AEC'd residual is quiet; a real barge is loud)."""
        import numpy as np

        if not frame:
            return 0.0
        x = np.frombuffer(frame, dtype=np.int16).astype(np.float32)
        return float(np.sqrt(np.mean(x * x))) if x.size else 0.0

    def _capture_to_wav(self, pcm: bytes) -> bytes:
        """Wrap captured 16 kHz mono PCM as a WAV for the STT multipart POST."""
        import io
        import wave

        buf = io.BytesIO()
        with wave.open(buf, "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(2)  # 16-bit
            w.setframerate(self.cfg.vad.sample_rate)
            w.writeframes(pcm)
        return buf.getvalue()

    @staticmethod
    def _now_ms() -> int:
        import time

        return int(time.monotonic() * 1000)


# Sentence boundary — mirrors openai_shim.ts next_sentence_boundary so the
# coordinator chunks for TTS identically to the shim path (decimal-safe).
def _next_sentence_boundary(s: str) -> int:
    for i, ch in enumerate(s):
        if ch == "\n":
            return i + 1
        if ch in ".!?…":
            j = i + 1
            while j < len(s) and s[j] in ".!?…":
                j += 1
            while j < len(s) and s[j] in "\"')]”’":
                j += 1
            if j < len(s) and s[j].isspace():
                return j
    return -1


# A ~0.2 s near-silent MP3 (8 zeroed MPEG1 Layer III frames @ 128 kbps/44.1 kHz).
# Played as the media of the start_conversation announcement that RE-OPENS the mic
# during a reply (full-duplex barge-in) — inaudible, just a vehicle to open the run.
_SILENT_OPENER = (b"\xff\xfb\x90\x00" + b"\x00" * 413) * 8


def mp3_duration_seconds(data: bytes) -> float | None:
    """Total playback seconds of an MPEG audio (Layer III) buffer, summed frame
    by frame so it's exact for CBR AND VBR. Skips a leading ID3v2 tag. Returns
    None when nothing parses (caller falls back to a byte-rate estimate). This is
    what makes the play sequencer DURATION-driven — the bound on each clip is its
    real length, not a guess."""
    if not data:
        return None
    n = len(data)
    i = 0
    if n >= 10 and data[:3] == b"ID3":  # skip an ID3v2 tag (syncsafe size)
        i = 10 + (((data[6] & 0x7F) << 21) | ((data[7] & 0x7F) << 14) | ((data[8] & 0x7F) << 7) | (data[9] & 0x7F))
    BR_V1 = (0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0)  # MPEG1 L3 kbps
    BR_V2 = (0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0)      # MPEG2/2.5 L3 kbps
    SR = {3: (44100, 48000, 32000, 0), 2: (22050, 24000, 16000, 0), 0: (11025, 12000, 8000, 0)}  # by version bits
    total = 0.0
    frames = 0
    while i + 4 <= n:
        if data[i] != 0xFF or (data[i + 1] & 0xE0) != 0xE0:  # frame sync (11 set bits)
            i += 1
            continue
        b1, b2 = data[i + 1], data[i + 2]
        ver = (b1 >> 3) & 0x3    # 3=MPEG1, 2=MPEG2, 0=MPEG2.5, 1=reserved
        layer = (b1 >> 1) & 0x3  # 1=Layer III
        br_i = (b2 >> 4) & 0xF
        sr_i = (b2 >> 2) & 0x3
        pad = (b2 >> 1) & 0x1
        srtab = SR.get(ver)
        if ver == 1 or layer != 1 or br_i in (0, 15) or sr_i == 3 or srtab is None:
            i += 1
            continue
        bitrate = (BR_V1 if ver == 3 else BR_V2)[br_i] * 1000
        sample_rate = srtab[sr_i]
        if bitrate == 0 or sample_rate == 0:
            i += 1
            continue
        if ver == 3:  # MPEG1 L3: 1152 samples/frame
            samples = 1152
            frame_len = (144 * bitrate // sample_rate) + pad
        else:         # MPEG2/2.5 L3: 576 samples/frame
            samples = 576
            frame_len = (72 * bitrate // sample_rate) + pad
        if frame_len <= 0:
            i += 1
            continue
        total += samples / sample_rate
        frames += 1
        i += frame_len
    return total if frames > 0 else None


async def _amain() -> None:
    cfg = CoordinatorConfig.from_env()
    logging.basicConfig(
        level=getattr(logging, cfg.log_level.upper(), logging.INFO),
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    coord = VoiceCoordinator(cfg)

    # Health endpoint (best-effort; coordinator runs even if aiohttp absent).
    health_runner = await _start_health_server(coord, cfg.health_port)

    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(sig, coord.request_stop)
        except NotImplementedError:  # pragma: no cover - Windows
            pass

    try:
        await coord.run()
    finally:
        if health_runner is not None:
            await health_runner.cleanup()


def _speak_auth_reason(expected: "str | None", auth_header: str) -> "str | None":
    """Authorize a POST /speak. Returns None when authorized, else a reason
    string ('auth_unconfigured' → 503, 'unauthorized' → 401). Pure so the auth
    matrix is unit-testable without binding a socket."""
    if not expected:
        return "auth_unconfigured"
    if auth_header != f"Bearer {expected}":
        return "unauthorized"
    return None


async def _start_health_server(coord: "VoiceCoordinator", port: int):
    """A minimal /health endpoint so Docker `restart: unless-stopped` + a probe
    can see the process is alive and whether the device session is up."""
    try:
        from aiohttp import web  # type: ignore
    except Exception:  # noqa: BLE001
        log.warning("aiohttp not installed — health endpoint disabled")
        return None

    async def health(_req):  # noqa: ANN001
        return web.json_response(
            {
                "ok": True,
                "device_connected": coord.device.connected,
                "conversation": coord._conv_id,
                "state": coord.machine.state.value,
            }
        )

    async def serve_tts(req):  # noqa: ANN001
        # The device GETs the SPEAKING-state audio from here (host-network on
        # the LLM host → reachable at http://<self_host>:<health_port>/tts/<id>).
        name = req.match_info.get("name", "")
        if name == "_open.mp3":  # the silent mic-opener for the barge-listen run
            return web.Response(body=_SILENT_OPENER, content_type="audio/mpeg")
        # Phase B gapless: the per-turn single stream — chunked, drained from the
        # synth queue as forza produces it (ONE continuous media_player session).
        if name == coord._stream_url_name and coord._stream_q is not None:
            q = coord._stream_q
            resp = web.StreamResponse(status=200, headers={"Content-Type": "audio/mpeg"})
            resp.enable_chunked_encoding()
            await resp.prepare(req)
            try:
                while True:
                    chunk = await q.get()
                    if chunk is None:
                        break  # sentinel: synth done / barge — close the stream
                    await resp.write(chunk)
                await resp.write_eof()
            except (asyncio.CancelledError, ConnectionResetError):
                pass  # device dropped the fetch (barge / stop) — fine
            except Exception:  # noqa: BLE001
                log.debug("gapless serve_tts stream error", exc_info=True)
            return resp
        data = coord._clips.get(name)
        if data is None:
            return web.Response(status=404, text="no such clip")
        return web.Response(body=data, content_type="audio/mpeg")

    async def speak(req):  # noqa: ANN001
        # Proactive spoken-followup ingress (2026-06-15). BEARER-gated, unlike the
        # open /tts fetch route — it puts audio into the room. Hearth's
        # deliver-followup sends `Authorization: Bearer HEARTH_INTERNAL_BEARER`.
        reason = _speak_auth_reason(coord.cfg.hearth.bearer, req.headers.get("authorization", ""))
        if reason:
            return web.json_response(
                {"spoken": False, "reason": reason},
                status=503 if reason == "auth_unconfigured" else 401,
            )
        try:
            body = await req.json()
        except Exception:  # noqa: BLE001
            return web.json_response({"spoken": False, "reason": "bad_json"}, status=400)
        text = str(body.get("text", "")).strip()
        if not text:
            return web.json_response({"spoken": False, "reason": "empty"}, status=400)
        # Optional pre-speech alert tone for danger announcements ('critical' =
        # EAS attention tone, 'notice' = soft chime). Unknown/absent → no tone.
        pre_tone = body.get("pre_tone")
        pre_tone = pre_tone if pre_tone in ("critical", "notice") else None
        return web.json_response(await coord.handle_speak(text, pre_tone=pre_tone))

    app = web.Application()
    app.router.add_get("/health", health)
    app.router.add_get("/tts/{name}", serve_tts)
    app.router.add_post("/speak", speak)
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, "0.0.0.0", port)
    await site.start()
    log.info("health endpoint on :%d/health", port)
    return runner


def main() -> None:
    asyncio.run(_amain())


if __name__ == "__main__":
    main()
