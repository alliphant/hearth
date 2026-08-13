"""The full-duplex barge-in state machine (design-esp-direct-voice.md §3).

This is the load-bearing logic, kept PURE (stdlib only, no I/O, no device, no
network) so it is unit-testable with synthetic frames. The orchestration layer
(coordinator.py) feeds it real events and executes the actions it emits; the
tests feed it synthetic events and assert the action sequence — same machine.

    States: IDLE → LISTENING → THINKING → SPEAKING → (barge-in) → LISTENING

The machine consumes `Event`s (wake detected, a VAD frame, STT transcript, a
reply sentence, reply finished, playback finished) and returns `Action`s the
caller must perform (start STT capture, send the turn, speak a sentence, STOP
playback, CANCEL the Hearth turn, …). It NEVER performs them itself.

The barge-in detection is the crux: while SPEAKING, the mic + VAD stay running,
and *sustained* speech (≥ barge_in_min_ms) whose probability clears the
echo-floor threshold flips the machine to BARGE_IN → emits STOP_PLAYBACK +
CANCEL_TURN + START_LISTENING in one step. Transient echo below the floor, or
speech shorter than the sustain window, is ignored — that's what stops Kate
hearing herself.
"""
from __future__ import annotations

import enum
from dataclasses import dataclass, field


class State(enum.Enum):
    IDLE = "idle"
    LISTENING = "listening"
    THINKING = "thinking"
    SPEAKING = "speaking"
    BARGE_IN = "barge_in"


class EventType(enum.Enum):
    WAKE = "wake"                       # on-device wake word OR presence-arm
    VAD_FRAME = "vad_frame"             # one mic frame: (speech_prob, is_speech, ts_ms)
    TRANSCRIPT = "transcript"           # STT produced an utterance
    REPLY_SENTENCE = "reply_sentence"   # one clean sentence arrived from Hearth
    REPLY_DONE = "reply_done"           # Hearth turn finished (message_added)
    PLAYBACK_DONE = "playback_done"     # device finished playing all queued audio
    RESET = "reset"                     # hard reset to IDLE (error/teardown)


class ActionType(enum.Enum):
    START_LISTENING = "start_listening"   # open/keep mic, run VAD endpointing, capture
    RUN_STT = "run_stt"                   # endpointed — transcribe the captured buffer
    SEND_TURN = "send_turn"               # POST the transcript to Hearth
    SPEAK = "speak"                       # synth+stream this sentence to the device
    STOP_PLAYBACK = "stop_playback"       # device audio off NOW (barge-in step 1)
    CANCEL_TURN = "cancel_turn"           # POST /cancel (barge-in step 2)
    GO_IDLE = "go_idle"                   # nothing in flight; await wake


@dataclass(frozen=True)
class Event:
    type: EventType
    # VAD frame payload
    speech_prob: float = 0.0
    is_speech: bool = False
    ts_ms: int = 0
    # 16-bit PCM RMS energy of this frame — the barge loudness measure (B+). The
    # coordinator computes it (numpy) and threads it in; the machine owns the
    # adaptive-floor DECISION so it stays pure + unit-testable.
    rms: float = 0.0
    # transcript / reply payload
    text: str = ""


@dataclass(frozen=True)
class Action:
    type: ActionType
    text: str = ""  # for SPEAK / SEND_TURN


@dataclass
class BargeInThresholds:
    """Tunables, mirrored from VadConfig. The barge-in floor is the value the
    §2 AEC test sets — speech must clear it to count as an interrupt over Kate."""

    speech_threshold: float = 0.5
    endpoint_silence_ms: int = 700
    barge_in_min_ms: int = 320
    barge_in_speech_threshold: float = 0.7
    # B+ adaptive echo-floor (2026-06-08, design-voice-barge-in.md §5). A barge
    # frame's RMS must clear an ADAPTIVE floor = max(floor_min, residual-peak ×
    # ratio), not a fixed constant. When the AEC is converged Kate's residual is
    # quiet (≈20) so the floor sits at floor_min; on loud syllables / partial
    # de-convergence the residual rises and the machine lifts the bar with it —
    # rejecting echo a fixed 500 floor would let through, while a genuinely
    # louder human barge still passes. The machine peak-holds the residual with
    # per-frame decay (echo_peak_decay). NOT magic constants — every knob is an
    # env override (VadConfig). The next increment replaces the self-estimated
    # peak with a delay-aligned reference envelope (the coordinator knows its own
    # TTS); the seam is `Event.rms` + this floor.
    barge_in_rms_floor_min: float = 500.0
    barge_in_rms_ratio: float = 2.0
    echo_peak_decay: float = 0.98  # per 32 ms frame (~half-life ≈ 1 s)


@dataclass
class BargeInMachine:
    """Deterministic barge-in state machine. One per active call/device."""

    thresholds: BargeInThresholds = field(default_factory=BargeInThresholds)
    # optional gate: only allow barge-in when presence says someone's near.
    gate_barge_in_on_presence: bool = False

    state: State = State.IDLE
    # rolling LISTENING capture bookkeeping
    _last_speech_ts: int = 0
    _had_speech: bool = False
    _last_frame_ts: int = 0
    # SPEAKING barge-in accumulation
    _barge_speech_start_ts: int | None = None
    # B+ adaptive echo-floor: decaying peak-hold of Kate's AEC'd residual RMS
    # during the current SPEAKING phase. Lifts the barge floor above the live
    # echo level. Reset per turn (in _reset_listen_accum).
    _echo_rms_peak: float = 0.0
    # presence latch (republished by the coordinator from LD2450)
    _present_near: bool = True

    # ── presence (LD2450 republish) ──────────────────────────────────────────

    def set_presence(self, present_near: bool) -> None:
        """Update the LD2450-derived 'someone present & near' latch."""
        self._present_near = present_near

    # ── the single entry point ───────────────────────────────────────────────

    def handle(self, ev: Event) -> list[Action]:
        """Advance the machine by one event; return the actions to perform."""
        if ev.type == EventType.RESET:
            return self._to_idle()

        if ev.type == EventType.WAKE:
            return self._on_wake()

        if ev.type == EventType.VAD_FRAME:
            return self._on_vad_frame(ev)

        if ev.type == EventType.TRANSCRIPT:
            return self._on_transcript(ev)

        if ev.type == EventType.REPLY_SENTENCE:
            return self._on_reply_sentence(ev)

        if ev.type == EventType.REPLY_DONE:
            return self._on_reply_done()

        if ev.type == EventType.PLAYBACK_DONE:
            return self._on_playback_done()

        return []

    # ── transitions ──────────────────────────────────────────────────────────

    def _on_wake(self) -> list[Action]:
        # A wake while idle (or even mid-speak) starts a fresh listen.
        if self.state == State.SPEAKING:
            # Treat an explicit wake during playback like a deliberate interrupt.
            return self._begin_barge_in()
        self._enter_listening()
        return [Action(ActionType.START_LISTENING)]

    def _on_vad_frame(self, ev: Event) -> list[Action]:
        self._last_frame_ts = ev.ts_ms

        if self.state == State.LISTENING:
            return self._listening_frame(ev)

        if self.state == State.SPEAKING:
            return self._speaking_frame(ev)

        # IDLE/THINKING/BARGE_IN ignore raw frames.
        return []

    def _listening_frame(self, ev: Event) -> list[Action]:
        speech = ev.is_speech and ev.speech_prob >= self.thresholds.speech_threshold
        if speech:
            self._had_speech = True
            self._last_speech_ts = ev.ts_ms
            return []
        # silence — have we had speech AND been silent long enough to endpoint?
        # (_had_speech is the gate; _last_speech_ts may legitimately be 0 at t=0,
        # so don't treat it as falsy — that would swallow the endpoint.)
        if self._had_speech:
            gap = ev.ts_ms - self._last_speech_ts
            if gap >= self.thresholds.endpoint_silence_ms:
                self.state = State.THINKING
                self._reset_listen_accum()
                return [Action(ActionType.RUN_STT)]
        return []

    def _speaking_frame(self, ev: Event) -> list[Action]:
        # The crux: detect a genuine interrupt over Kate's own (AEC'd) voice.
        # A barge frame must (a) be speech, (b) clear the speech-prob floor, and
        # (c) be LOUDER than Kate's residual echo — measured ADAPTIVELY (B+),
        # not by a fixed constant: floor = max(floor_min, residual-peak × ratio).
        # A SUSTAINED run (≥ barge_in_min_ms) of such frames is the interrupt.
        # Kate's residual (quiet when AEC-converged; syllabic + gappy otherwise)
        # never sustains over its own adaptive floor; a human's continuous,
        # louder speech does. See design-voice-barge-in.md §5 (B / B+).
        th = self.thresholds
        self._echo_rms_peak *= th.echo_peak_decay
        floor = max(th.barge_in_rms_floor_min, self._echo_rms_peak * th.barge_in_rms_ratio)
        energy_candidate = (
            ev.is_speech
            and ev.speech_prob >= th.barge_in_speech_threshold
            and ev.rms >= floor
        )

        if not energy_candidate:
            # Kate's residual (or silence) → fold its loudness into the peak-hold
            # so the floor tracks the echo, and reset the sustain accumulator
            # (transient over-floor blips die here).
            self._echo_rms_peak = max(self._echo_rms_peak, ev.rms)
            self._barge_speech_start_ts = None
            return []

        presence_ok = (not self.gate_barge_in_on_presence) or self._present_near
        if not presence_ok:
            # Loud, speech-shaped, but nobody near (optional gate) → hold; don't
            # pollute the echo estimate with what is probably a real voice.
            self._barge_speech_start_ts = None
            return []

        if self._barge_speech_start_ts is None:
            self._barge_speech_start_ts = ev.ts_ms
            return []

        sustained = ev.ts_ms - self._barge_speech_start_ts
        if sustained >= th.barge_in_min_ms:
            return self._begin_barge_in()
        return []

    def _begin_barge_in(self) -> list[Action]:
        """Barge-in fired: audio off, cancel the turn, reopen the mic. (§3)."""
        self.state = State.BARGE_IN
        self._barge_speech_start_ts = None
        # After we stop+cancel, we immediately go LISTENING to catch the redirect.
        self._enter_listening()
        return [
            Action(ActionType.STOP_PLAYBACK),  # device audio off <100 ms
            Action(ActionType.CANCEL_TURN),    # POST /cancel → "(stopped)"
            Action(ActionType.START_LISTENING),
        ]

    def _on_transcript(self, ev: Event) -> list[Action]:
        # STT done → send the turn. Empty/garbled transcript → back to listening
        # (the persona handles "I didn't catch that" on the spoken side).
        text = ev.text.strip()
        if self.state != State.THINKING:
            # A late transcript after a reset/barge-in — ignore.
            return []
        if not text:
            self._enter_listening()
            return [Action(ActionType.START_LISTENING)]
        # Stay in THINKING until the first reply sentence; the reply transitions
        # us to SPEAKING.
        return [Action(ActionType.SEND_TURN, text=text)]

    def _on_reply_sentence(self, ev: Event) -> list[Action]:
        # First sentence flips THINKING → SPEAKING; the mic+VAD KEEP RUNNING
        # (that's the whole point — see _speaking_frame). Subsequent sentences
        # just queue more speech.
        if self.state == State.BARGE_IN:
            # We already barged in on this turn — drop trailing sentences.
            return []
        if self.state in (State.THINKING, State.SPEAKING):
            self.state = State.SPEAKING
            return [Action(ActionType.SPEAK, text=ev.text)]
        return []

    def _on_reply_done(self) -> list[Action]:
        # The turn finished generating. We don't go idle yet — we wait for
        # PLAYBACK_DONE (true end-of-audio) before reopening the mic in the
        # half-duplex sense; in full-duplex the mic was never closed, so this
        # is mostly a bookkeeping transition.
        if self.state == State.SPEAKING:
            return []  # keep speaking out the queued audio
        return []

    def _on_playback_done(self) -> list[Action]:
        # True end-of-audio (the device drained its queue). PER-TURN model: end
        # the run so the device returns to wake-word and the LED ring goes idle
        # (the coordinator sends RUN_END on GO_IDLE — the firmware's on_end →
        # idle). The next turn is a fresh "Hey Kate". Barge-in still works WITHIN
        # a turn — _begin_barge_in re-listens inside the SAME run rather than
        # ending it, so interrupting Kate and redirecting needs no re-wake.
        if self.state in (State.SPEAKING, State.BARGE_IN):
            return self._to_idle()
        return []

    # ── helpers ──────────────────────────────────────────────────────────────

    def _enter_listening(self) -> None:
        self.state = State.LISTENING
        self._reset_listen_accum()

    def _reset_listen_accum(self) -> None:
        self._had_speech = False
        self._last_speech_ts = 0
        self._barge_speech_start_ts = None
        self._echo_rms_peak = 0.0  # B+: fresh residual peak-hold per turn

    def _to_idle(self) -> list[Action]:
        self.state = State.IDLE
        self._reset_listen_accum()
        return [Action(ActionType.GO_IDLE)]
