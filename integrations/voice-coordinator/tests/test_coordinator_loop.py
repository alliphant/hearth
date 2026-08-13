"""Coordinator integration smoke — drives a full turn with MOCKED device + STT +
TTS + Hearth and asserts the action→LED→streaming-pipeline sequence the live
window can't regression-guard. Complements test_state_machine (the pure machine)
by covering coordinator.py's _execute wiring + the synth/play pipeline.

coordinator.py uses package-relative imports, so (unlike the pure
test_state_machine) this must run as a MODULE from a dir where the package
resolves as `integrations.voice_coordinator` (the Dockerfile layout / the staged
/tmp/vc on the LLM host):
    cd /tmp/vc && python -m integrations.voice_coordinator.tests.test_coordinator_loop

SKIP-CLEAN: the coordinator imports httpx/aiohttp/aioesphomeapi/onnxruntime; if
any are absent (or the package path doesn't resolve) this skips. No device, no
network — the device/clients are fakes.
"""
from __future__ import annotations

import asyncio
import sys

try:
    from integrations.voice_coordinator.config import CoordinatorConfig
    from integrations.voice_coordinator.coordinator import VoiceCoordinator
    from integrations.voice_coordinator.hearth_client import TurnEvent
    from integrations.voice_coordinator.state_machine import Event, EventType, State
    _OK = True
except Exception as e:  # noqa: BLE001
    print(f"SKIP test_coordinator_loop: {e}")
    _OK = False


class FakeDevice:
    """Records LED events + plays; play auto-advances the media_player state so
    the play loop's `await _play_idle` returns (simulating instant playback)."""
    def __init__(self) -> None:
        self.coord = None
        self.events: list[str] = []
        self.played: list[str] = []
        self.stopped = 0
        self.connected = True
        self._media_player_key = 1

    def send_va_event(self, name: str, data=None) -> None:  # noqa: ANN001
        self.events.append(name)

    async def play_media_url(self, url: str) -> bool:
        self.played.append(url)
        if self.coord is not None:  # device reports PLAYING; IDLE is driven by the
            self.coord._on_media_state("PLAYING")  # test once the gapless stream closes
        return True

    async def stop_playback(self) -> None:
        self.stopped += 1

    async def open_listen_run(self, media_url: str, timeout: float = 45.0) -> None:
        self.listen_opens = getattr(self, "listen_opens", 0) + 1

    async def start(self) -> bool:
        return True

    async def stop(self) -> None:
        pass


class FakeStt:
    async def transcribe_wav(self, wav: bytes) -> str:
        return "what's on my calendar tomorrow"

    async def aclose(self) -> None:
        pass


class FakeTts:
    def __init__(self) -> None:
        self.last_instruct = None  # the instruct the most recent synth received

    async def synthesize(self, text: str, *, instruct: str = "") -> bytes:
        self.last_instruct = instruct
        return b"MP3:" + text.encode()

    async def synthesize_stream(self, text: str, *, instruct: str = ""):  # noqa: ANN201 - async generator (gapless path)
        self.last_instruct = instruct
        yield b"MP3:" + text.encode()

    async def aclose(self) -> None:
        pass


class FakeHearth:
    async def create_or_reuse_voice_conversation(self) -> str:
        return "conv1"

    def send_message(self, conv_id: str, text: str):  # noqa: ANN201
        async def _noop() -> None:
            return None
        return asyncio.ensure_future(_noop())

    async def stream_reply(self, conv_id: str):  # noqa: ANN201
        for tok in ("Good morning. ", "You have two things today. "):
            yield TurnEvent(kind="token", text=tok)
        yield TurnEvent(kind="done")

    async def cancel(self, conv_id: str) -> bool:
        return True

    emotion = ""  # what classify_emotion returns (overridden per test)

    last_emotion_context = ""  # the context= the last classify_emotion received

    async def classify_emotion(self, text: str, context: str = "") -> str:
        self.last_emotion_context = context
        return self.emotion

    async def aclose(self) -> None:
        pass


class FakeVad:
    enabled = True

    def reset(self) -> None:
        pass

    def process_frame(self, frame: bytes):  # noqa: ANN201
        return (0.9, True)


_fails = 0


def check(cond: bool, msg: str) -> None:
    global _fails
    print(("  ✓ " if cond else "  ✗ ") + msg)
    if not cond:
        _fails += 1


async def _amain() -> int:
    cfg = CoordinatorConfig.from_env()
    coord = VoiceCoordinator(cfg)
    dev = FakeDevice()
    dev.coord = coord
    coord.device = dev
    coord.stt = FakeStt()
    coord.tts = FakeTts()
    coord.hearth = FakeHearth()
    coord.vad = FakeVad()

    print("[wake → listen]")
    coord._on_wake("")  # device wake fires this
    check("run_start" in dev.events, "wake → run_start LED")
    check("stt_start" in dev.events, "START_LISTENING → stt_start LED")
    check(coord.machine.state == State.LISTENING, "machine in LISTENING")

    print("[speech → endpoint → STT → turn]  (synthetic VAD_FRAME timing)")
    coord._dispatch(Event(type=EventType.VAD_FRAME, speech_prob=0.9, is_speech=True, ts_ms=100))
    coord._dispatch(Event(type=EventType.VAD_FRAME, speech_prob=0.0, is_speech=False, ts_ms=1000))  # gap 900>700 → endpoint
    check("stt_vad_end" in dev.events, "endpoint → stt_vad_end LED (the 'thinking' transition)")
    check(coord.machine.state == State.THINKING, "machine → THINKING on endpoint")
    await asyncio.sleep(0.2)  # let _run_stt → TRANSCRIPT → SEND_TURN → _send_turn fire
    check("intent_start" in dev.events, "SEND_TURN → intent_start LED")

    print("[reply streams → ONE gapless stream → media_player]")
    await asyncio.sleep(0.1)  # let _consume_reply dispatch the SPEAKs (creates the stream tasks)
    # Drain the synth into the per-turn queue (completes when the reply is done),
    # then simulate the device finishing the stream (IDLE) so the play loop ends.
    if coord._synth_stream_task is not None:
        try:
            await asyncio.wait_for(coord._synth_stream_task, timeout=5.0)
        except asyncio.TimeoutError:
            check(False, "synth stream finished within 5s")
    else:
        check(False, "gapless synth stream task was created")
    check(coord._stream_done, "synth closed the stream (sentinel queued)")
    check(len(dev.played) == 1, f"GAPLESS: exactly ONE media_player stream for the turn ({len(dev.played)})")
    check(bool(dev.played) and "/tts/turn" in dev.played[0], "played the per-turn gapless stream URL")
    check("tts_start" in dev.events, "playback → tts_start LED (replying)")
    coord._on_media_state("IDLE")  # device drained the stream → IDLE
    if coord._play_stream_task is not None:
        try:
            await asyncio.wait_for(coord._play_stream_task, timeout=5.0)
        except asyncio.TimeoutError:
            check(False, "play stream loop ended within 5s after IDLE")

    print("[turn end → run ends, ring idle]")
    check("run_end" in dev.events, "PLAYBACK_DONE → GO_IDLE → run_end LED (idle)")
    check(coord.machine.state == State.IDLE, "machine → IDLE after the turn (per-turn lifecycle)")

    print("[LED order]")
    order = [e for e in dev.events if e in ("run_start", "stt_start", "stt_vad_end", "intent_start", "tts_start", "run_end")]
    expect = ["run_start", "stt_start", "stt_vad_end", "intent_start", "tts_start", "run_end"]
    check(order == expect, f"LED event order {order} == {expect}")

    print("[mp3 duration parser — the duration-driven bound]")
    from integrations.voice_coordinator.coordinator import mp3_duration_seconds
    # 10 synthetic MPEG1 Layer III frames @ 128 kbps / 44100 Hz:
    #   header FF FB 90 00 → frame_len = 144*128000//44100 = 417 B, 1152 samples/frame.
    frame = b"\xff\xfb\x90\x00" + b"\x00" * (417 - 4)
    expect = 10 * 1152 / 44100  # ≈ 0.261 s
    d = mp3_duration_seconds(frame * 10)
    check(d is not None and abs(d - expect) < 0.01, f"mp3_duration_seconds(10 frames) ≈ {expect:.3f}s (got {d})")
    check(mp3_duration_seconds(b"") is None, "mp3_duration_seconds(empty) → None")
    check(mp3_duration_seconds(b"not an mp3 at all") is None, "mp3_duration_seconds(garbage) → None (caller falls back)")

    print("[barge-in resets the pipeline]")
    coord._reply_buf = ["stale"]
    coord._reset_playback()
    check(coord._reply_buf == [] and not coord._reply_done, "reset clears reply buffer + done flag")

    print("[Phase A — action button interrupts a reply]")
    coord.machine.state = State.SPEAKING       # pretend Kate is mid-reply
    dev.stopped = 0
    coord._on_button_state(True)               # rising edge = a press
    check(coord.machine.state == State.IDLE, "button press during SPEAKING → turn cancelled → IDLE")
    await asyncio.sleep(0.05)                   # let the ensure_future stop/cancel run
    check(dev.stopped >= 1, "button press → media_player STOP issued")
    coord.machine.state = State.SPEAKING       # back to speaking
    coord._on_button_state(False)              # a release must NOT re-fire (rising-edge only)
    check(coord.machine.state == State.SPEAKING, "button release is a no-op")

    print("[POST /speak — proactive spoken followup]")
    import integrations.voice_coordinator.coordinator as C
    from integrations.voice_coordinator.coordinator import _speak_auth_reason

    coord.machine.state = State.IDLE  # not mid-turn (the announce waits for IDLE)

    class _Snap:
        def __init__(self, near: bool) -> None:
            self._near = near
            self.present = near

        def present_and_near(self, *a, **k) -> bool:  # noqa: ANN002, ANN003
            return self._near

    # present+near → speaks (background play) → spoken:true + a clip played
    C.parse_presence = lambda states: _Snap(True)
    played_before = len(dev.played)
    res = await coord.handle_speak("Back on your last-frost question — May 15th.")
    check(res.get("spoken") is True, f"present → spoken:true (got {res})")
    await asyncio.sleep(0.15)  # let the background _announce synth+play
    check(len(dev.played) == played_before + 1, "present → exactly one announce clip played")
    check(bool(dev.played) and "/tts/a" in dev.played[-1], "announce clip served from /tts/a*")
    coord._on_media_state("IDLE")  # release the background _announce's clip-end wait
    await asyncio.sleep(0.05)

    # away → no speech; spoken:false away so the server pushes; no new clip
    C.parse_presence = lambda states: _Snap(False)
    played_before = len(dev.played)
    res = await coord.handle_speak("hello")
    check(res.get("spoken") is False and res.get("reason") == "away", f"away → spoken:false away (got {res})")
    await asyncio.sleep(0.05)
    check(len(dev.played) == played_before, "away → nothing played (push fallback)")

    # kill switch — enable_announce False → spoken:false disabled (cfg is frozen)
    object.__setattr__(coord.cfg, "enable_announce", False)
    C.parse_presence = lambda states: _Snap(True)
    res = await coord.handle_speak("hi")
    check(res.get("spoken") is False and res.get("reason") == "disabled", "enable_announce=False → spoken:false disabled")
    object.__setattr__(coord.cfg, "enable_announce", True)

    print("[/speak — critical BARGES + honest spoken; notice queues politely]")
    C.parse_presence = lambda states: _Snap(True)
    # Shorten the timing knobs so the test doesn't wait the real 120s / 3s / 6.5s.
    coord._announce_idle_wait_s = 0.4
    coord._announce_barge_settle_s = 0.4
    coord._announce_confirm_s = 0.6
    # Isolate the barge/wait/confirm DECISION from the real playback machinery.
    # The fake resolves the honest-`spoken` `started` future like the real clip
    # play does (True when it "plays", False when there's no session).
    orig_play = coord._play_announce_clip
    announce_plays: list[str] = []
    play_ok = {"v": True}  # toggle: does the fake clip actually start playing?

    async def _fake_play_clip(clip, prefix, started=None):  # noqa: ANN001, ANN202
        announce_plays.append(prefix)
        if started is not None and not started.done():
            started.set_result(play_ok["v"])
        return play_ok["v"]

    coord._play_announce_clip = _fake_play_clip  # type: ignore[assignment]

    # CRITICAL (EAS) while Kate is mid-reply → BARGE: stop playback, cancel the
    # turn, land IDLE, play NOW — and honest spoken:true ONLY because the device
    # actually started playing.
    coord.machine.state = State.SPEAKING
    dev.stopped = 0
    announce_plays.clear()
    play_ok["v"] = True
    res = await coord.handle_speak("CO2 leak in the basement — get the dogs out.", pre_tone="critical")
    check(res.get("spoken") is True, f"critical + confirmed play → spoken:true (got {res})")
    await asyncio.sleep(0.1)  # let the barge's ensure_future stop/cancel run
    check(coord.machine.state == State.IDLE, "critical announce BARGED the SPEAKING turn → IDLE")
    check(dev.stopped >= 1, "critical announce → media_player STOP issued (barge)")
    check(len(announce_plays) >= 1, "critical announce PLAYED immediately (did not wait/drop)")

    # HONEST spoken: critical where the device can't actually play (no session) →
    # spoken:false so the audit reflects reality + Hearth's push is the backstop.
    coord.machine.state = State.IDLE
    announce_plays.clear()
    play_ok["v"] = False
    res = await coord.handle_speak("Tornado warning — take cover now.", pre_tone="critical")
    check(res.get("spoken") is False, f"critical but play UNCONFIRMED → spoken:false (got {res})")
    check(res.get("reason") == "play_unconfirmed", f"reason play_unconfirmed (got {res})")
    play_ok["v"] = True

    # NOTICE (gentle chime) while busy → does NOT barge; waits, drops politely
    # rather than cutting off the conversation (no honest-confirm — best-effort).
    coord.machine.state = State.SPEAKING
    dev.stopped = 0
    announce_plays.clear()
    res = await coord.handle_speak("Radon is a little elevated in the basement.", pre_tone="notice")
    check(res.get("spoken") is True, "notice present → spoken:true (accepted, optimistic)")
    await asyncio.sleep(0.6)  # > the shortened idle-wait (0.4s)
    check(coord.machine.state == State.SPEAKING, "notice announce did NOT barge (state untouched)")
    check(dev.stopped == 0, "notice announce issued NO media STOP (no barge)")
    check(len(announce_plays) == 0, "notice announce DROPPED while busy (queued politely, didn't cut in)")

    coord._play_announce_clip = orig_play  # restore
    coord.machine.state = State.IDLE

    print("[/speak auth matrix]")
    check(_speak_auth_reason("tok", "Bearer tok") is None, "valid bearer → authorized")
    check(_speak_auth_reason("tok", "Bearer nope") == "unauthorized", "wrong bearer → unauthorized")
    check(_speak_auth_reason("tok", "") == "unauthorized", "missing auth → unauthorized")
    check(_speak_auth_reason(None, "Bearer tok") == "auth_unconfigured", "no configured bearer → auth_unconfigured")

    print("[emotion — context-aware per-sentence, pre-kicked (overlaps synth)]")
    object.__setattr__(coord.cfg, "enable_emotion", True)
    object.__setattr__(coord.cfg, "emotion_per_sentence", True)
    coord.hearth.emotion = "warm"
    coord._reply_buf = ["I don't have that.", "But here's what you can do."]
    coord._instruct_tasks = {}
    coord._kick_instruct(1)  # SPEAK pre-kicks the classify as the sentence ARRIVES
    check(1 in coord._instruct_tasks, "per-sentence: SPEAK-time kick starts the classify AHEAD of synth")
    inst = await coord._get_instruct(1, coord._reply_buf[1])
    check(inst == "warm", "per-sentence: synth awaits the pre-kicked instruct")
    check(
        "But here's what you can do." in coord.hearth.last_emotion_context
        and "I don't have that." in coord.hearth.last_emotion_context,
        "per-sentence: the WHOLE reply-so-far is sent as context",
    )
    await coord.tts.synthesize("hello", instruct=inst)
    check(coord.tts.last_instruct == "warm", "synth receives the per-sentence instruct")

    print("[emotion — turn-once fallback (emotion_per_sentence=0)]")
    object.__setattr__(coord.cfg, "emotion_per_sentence", False)
    coord._instruct_tasks = {}
    coord._turn_instruct = ""
    coord._turn_instruct_done = False
    coord.hearth.emotion = "warm"
    first = await coord._get_instruct(0, "Great news — your order shipped!")
    check(first == "warm" and coord._turn_instruct == "warm", "turn-once: first sentence classified + cached")
    coord.hearth.emotion = "serious"
    later = await coord._get_instruct(1, "a later sentence")
    check(later == "warm", "turn-once: classified ONCE per reply (idempotent)")

    print("[emotion disabled]")
    object.__setattr__(coord.cfg, "enable_emotion", False)
    coord._instruct_tasks = {}
    coord.hearth.emotion = "warm"
    check((await coord._get_instruct(0, "Great news!")) == "", "disabled → instruct stays neutral ('')")

    print("[overlapped STT — speculative fire + staleness guard]")
    object.__setattr__(coord.cfg, "stt_overlap", True)
    coord._spec_task = None
    coord._spec_stale = False
    coord._silence_run = 0
    coord._capture = bytearray(b"\x00\x00" * 200)  # non-empty pcm so a task is created
    coord._fire_speculative_stt()
    check(coord._spec_task is not None, "overlap: trailing pause fires a speculative transcription")
    check(coord._spec_stale is False, "overlap: fresh speculative is not stale")
    coord._spec_stale = True  # speech resuming marks it stale → _run_stt re-transcribes
    check(coord._spec_stale is True, "overlap: resumed speech marks the speculative stale")
    if coord._spec_task is not None:
        coord._spec_task.cancel()
    coord._spec_task = None
    coord._spec_stale = False
    coord._capture = bytearray()
    object.__setattr__(coord.cfg, "stt_overlap", False)

    await coord._shutdown() if False else None  # don't actually shutdown the fakes
    return _fails


def run() -> int:
    if not _OK:
        return 0
    fails = asyncio.run(_amain())
    print("─" * 50)
    if fails:
        print(f"  {fails} FAILED")
        return 1
    print("  ✓ COORDINATOR LOOP SMOKE PASSED")
    return 0


if __name__ == "__main__":
    sys.exit(run())
