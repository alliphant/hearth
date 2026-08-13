#!/usr/bin/env python3
"""Self-contained unit tests for the barge-in state machine, LD2450 parsing,
and the sentence splitter — stdlib only, NO device, NO network, NO pytest.

Run:  python3 integrations/voice-coordinator/tests/test_state_machine.py

The package dir is `voice-coordinator` (hyphen), which isn't a valid Python
module name, so we load the source files directly via importlib from their
paths. The modules under test are stdlib-only (state_machine, ld2450) so they
import cleanly here; the sentence splitter is pulled from coordinator.py by
reading just that function to avoid importing its httpx/aioesphome deps.
"""
from __future__ import annotations

import importlib.util
import os
import sys

PKG_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _load(mod_name: str, filename: str):
    path = os.path.join(PKG_DIR, filename)
    spec = importlib.util.spec_from_file_location(mod_name, path)
    assert spec and spec.loader, f"cannot load {path}"
    mod = importlib.util.module_from_spec(spec)
    sys.modules[mod_name] = mod
    spec.loader.exec_module(mod)
    return mod


sm = _load("vc_state_machine", "state_machine.py")
ld = _load("vc_ld2450", "ld2450.py")

# ── tiny assert harness ──────────────────────────────────────────────────────

_passed = 0
_failed = 0


def check(cond: bool, msg: str) -> None:
    global _passed, _failed
    if cond:
        _passed += 1
        print(f"  ✓ {msg}")
    else:
        _failed += 1
        print(f"  ✗ {msg}")


def section(name: str) -> None:
    print(f"\n[{name}]")


# Convenience builders.
S, E, A = sm.State, sm.EventType, sm.ActionType


def frame(prob: float, ts_ms: int, is_speech: bool | None = None, rms: float = 3000.0):
    # rms defaults LOUD (3000) so a plain barge frame clears the floor; echo/quiet
    # tests pass a low rms explicitly. (B+: the machine gates on rms now.)
    return sm.Event(
        type=E.VAD_FRAME,
        speech_prob=prob,
        is_speech=prob >= 0.5 if is_speech is None else is_speech,
        ts_ms=ts_ms,
        rms=rms,
    )


def action_types(actions) -> list:
    return [a.type for a in actions]


# ── tests: the listen → think → speak happy path ─────────────────────────────


def test_wake_starts_listening():
    section("wake → LISTENING")
    m = sm.BargeInMachine()
    out = m.handle(sm.Event(type=E.WAKE))
    check(m.state == S.LISTENING, "wake moves IDLE → LISTENING")
    check(action_types(out) == [A.START_LISTENING], "wake emits START_LISTENING")


def test_endpoint_after_silence():
    section("VAD endpointing (speech then silence)")
    th = sm.BargeInThresholds(speech_threshold=0.5, endpoint_silence_ms=700)
    m = sm.BargeInMachine(thresholds=th)
    m.handle(sm.Event(type=E.WAKE))
    # speech frames
    for ts in range(0, 500, 32):
        m.handle(frame(0.9, ts))
    check(m.state == S.LISTENING, "still LISTENING while speech continues")
    # short silence — not enough to endpoint
    out = m.handle(frame(0.1, 500 + 300))
    check(action_types(out) == [], "300 ms silence < 700 ms gap → no endpoint yet")
    check(m.state == S.LISTENING, "still LISTENING after short gap")
    # long silence — endpoint fires RUN_STT and moves to THINKING
    out = m.handle(frame(0.1, 500 + 800))
    check(action_types(out) == [A.RUN_STT], "≥700 ms silence after speech → RUN_STT")
    check(m.state == S.THINKING, "endpoint moves LISTENING → THINKING")


def test_transcript_sends_turn():
    section("transcript → SEND_TURN")
    m = sm.BargeInMachine()
    m.state = S.THINKING
    out = m.handle(sm.Event(type=E.TRANSCRIPT, text="what's on my calendar"))
    check(action_types(out) == [A.SEND_TURN], "non-empty transcript → SEND_TURN")
    check(out[0].text == "what's on my calendar", "SEND_TURN carries the transcript")


def test_empty_transcript_relistens():
    section("empty transcript → re-LISTEN")
    m = sm.BargeInMachine()
    m.state = S.THINKING
    out = m.handle(sm.Event(type=E.TRANSCRIPT, text="   "))
    check(action_types(out) == [A.START_LISTENING], "empty/garbled transcript → START_LISTENING")
    check(m.state == S.LISTENING, "empty transcript returns to LISTENING")


def test_reply_sentence_speaks():
    section("reply sentence → SPEAK, mic stays open")
    m = sm.BargeInMachine()
    m.state = S.THINKING
    out = m.handle(sm.Event(type=E.REPLY_SENTENCE, text="You have three things today."))
    check(m.state == S.SPEAKING, "first reply sentence moves THINKING → SPEAKING")
    check(action_types(out) == [A.SPEAK], "reply sentence → SPEAK")
    out2 = m.handle(sm.Event(type=E.REPLY_SENTENCE, text="The first is at ten."))
    check(action_types(out2) == [A.SPEAK], "subsequent sentences also SPEAK (still SPEAKING)")


# ── tests: the crux — barge-in over playback ─────────────────────────────────


def test_barge_in_fires_on_sustained_speech_over_floor():
    section("BARGE-IN: sustained speech over the echo floor while SPEAKING")
    th = sm.BargeInThresholds(barge_in_min_ms=320, barge_in_speech_threshold=0.7)
    m = sm.BargeInMachine(thresholds=th)
    m.state = S.SPEAKING
    # speech over floor begins at t=1000
    out = m.handle(frame(0.9, 1000, is_speech=True))
    check(action_types(out) == [], "first over-floor frame starts the sustain window, no action yet")
    # still within the sustain window (200 ms < 320 ms)
    out = m.handle(frame(0.9, 1200, is_speech=True))
    check(action_types(out) == [], "200 ms sustained < 320 ms → no barge-in yet")
    # crosses the sustain threshold (≥320 ms)
    out = m.handle(frame(0.9, 1330, is_speech=True))
    check(
        action_types(out) == [A.STOP_PLAYBACK, A.CANCEL_TURN, A.START_LISTENING],
        "≥320 ms sustained over-floor speech → STOP_PLAYBACK + CANCEL_TURN + START_LISTENING",
    )
    check(m.state == S.LISTENING, "barge-in lands in LISTENING to catch the redirect")


def test_no_barge_in_below_floor():
    section("NO barge-in: speech-shaped but QUIET residual (Kate's own AEC'd voice)")
    th = sm.BargeInThresholds(barge_in_min_ms=320, barge_in_speech_threshold=0.7, barge_in_rms_floor_min=500.0)
    m = sm.BargeInMachine(thresholds=th)
    m.state = S.SPEAKING
    # Residual echo: HIGH Silero prob (speech-SHAPED) but QUIET — rms below the
    # floor. This is the exact self-barge case B+ kills: prob alone would fire.
    for ts in range(1000, 3000, 32):
        out = m.handle(frame(0.95, ts, is_speech=True, rms=100.0))
        if action_types(out):
            break
    check(m.state == S.SPEAKING, "quiet (sub-floor) residual never barges, even at prob 0.95")


def test_transient_speech_resets_sustain():
    section("NO barge-in: a transient blip over floor (shorter than sustain)")
    th = sm.BargeInThresholds(barge_in_min_ms=320, barge_in_speech_threshold=0.7)
    m = sm.BargeInMachine(thresholds=th)
    m.state = S.SPEAKING
    m.handle(frame(0.9, 1000, is_speech=True))   # start window (loud → candidate)
    m.handle(frame(0.9, 1100, is_speech=True))   # 100 ms
    out = m.handle(frame(0.2, 1132, is_speech=False, rms=50.0))  # quiet blip ends → reset
    check(action_types(out) == [], "drop below floor resets the sustain accumulator")
    # A fresh short blip shouldn't immediately fire.
    m.handle(frame(0.9, 1200, is_speech=True))
    out = m.handle(frame(0.9, 1300, is_speech=True))  # only 100 ms again
    check(m.state == S.SPEAKING, "transient over-floor blips don't accumulate across a reset")


def test_adaptive_floor_lifts_above_a_fixed_floor():
    section("B+ adaptive floor: elevated residual lifts the bar above floor_min")
    # floor_min 500, ratio 2. Sub-floor residual (rms 300) BUILDS the peak so the
    # floor climbs to ~peak×2. A then-CONTINUOUS 550-rms run — which a FIXED 500
    # floor would accept as a barge — sits UNDER the lifted floor: read as residual.
    th = sm.BargeInThresholds(
        barge_in_min_ms=320, barge_in_speech_threshold=0.7,
        barge_in_rms_floor_min=500.0, barge_in_rms_ratio=2.0, echo_peak_decay=0.98,
    )
    m = sm.BargeInMachine(thresholds=th)
    m.state = S.SPEAKING
    ts = 1000
    for _ in range(20):  # build the residual peak from sub-floor (~300) frames
        m.handle(frame(0.9, ts, is_speech=True, rms=300.0)); ts += 32
    check(m._echo_rms_peak >= 250.0, "residual peak tracked the ~300 echo")
    fired = False
    for _ in range(40):  # ~1.3 s of continuous 550-rms residual
        out = m.handle(frame(0.9, ts, is_speech=True, rms=550.0)); ts += 32
        if action_types(out):
            fired = True
            break
    check(not fired and m.state == S.SPEAKING,
          "550 residual under the lifted floor never barges (a fixed 500 floor would)")


def test_loud_human_still_barges_over_elevated_residual():
    section("B+ adaptive floor: a genuinely louder human still barges")
    th = sm.BargeInThresholds(
        barge_in_min_ms=320, barge_in_speech_threshold=0.7,
        barge_in_rms_floor_min=500.0, barge_in_rms_ratio=2.0, echo_peak_decay=0.98,
    )
    m = sm.BargeInMachine(thresholds=th)
    m.state = S.SPEAKING
    ts = 1000
    for _ in range(10):  # elevated residual ~400 builds the floor
        m.handle(frame(0.9, ts, is_speech=True, rms=400.0)); ts += 32
    out = []
    for _ in range(20):  # a loud human (rms 4000) ≫ lifted floor → sustains → barge
        out = m.handle(frame(0.95, ts, is_speech=True, rms=4000.0)); ts += 32
        if action_types(out):
            break
    check(action_types(out) == [A.STOP_PLAYBACK, A.CANCEL_TURN, A.START_LISTENING],
          "a loud human clears the lifted floor + sustains → barge")
    check(m.state == S.LISTENING, "landed in LISTENING for the redirect")


def test_transient_loud_syllable_rejected():
    section("B+: a transient loud echo syllable (with quiet gaps) never sustains")
    th = sm.BargeInThresholds(barge_in_min_ms=320, barge_in_speech_threshold=0.7, barge_in_rms_floor_min=500.0)
    m = sm.BargeInMachine(thresholds=th)
    m.state = S.SPEAKING
    ts = 1000
    fired = False
    for _ in range(30):  # alternate a loud syllable (800) with a quiet gap (50)
        out = m.handle(frame(0.9, ts, is_speech=True, rms=800.0)); ts += 32
        if action_types(out):
            fired = True
            break
        out = m.handle(frame(0.2, ts, is_speech=False, rms=50.0)); ts += 32  # gap resets sustain
        if action_types(out):
            fired = True
            break
    check(not fired and m.state == S.SPEAKING,
          "syllabic loud echo with gaps never sustains 320 ms → no barge")


def test_presence_gate_blocks_barge_in():
    section("presence gate: no barge-in when nobody's near (optional gate)")
    th = sm.BargeInThresholds(barge_in_min_ms=320, barge_in_speech_threshold=0.7)
    m = sm.BargeInMachine(thresholds=th, gate_barge_in_on_presence=True)
    m.state = S.SPEAKING
    m.set_presence(False)  # LD2450 says nobody near
    for ts in range(1000, 2000, 32):
        m.handle(frame(0.95, ts, is_speech=True))
    check(m.state == S.SPEAKING, "presence-gated: sustained loud speech ignored when nobody near")
    # Now someone's near — same speech barges in.
    m.set_presence(True)
    m.handle(frame(0.95, 3000, is_speech=True))
    out = m.handle(frame(0.95, 3400, is_speech=True))
    check(
        action_types(out) == [A.STOP_PLAYBACK, A.CANCEL_TURN, A.START_LISTENING],
        "with presence true, the same speech triggers barge-in",
    )


def test_wake_during_speaking_is_interrupt():
    section("explicit wake during SPEAKING = deliberate interrupt")
    m = sm.BargeInMachine()
    m.state = S.SPEAKING
    out = m.handle(sm.Event(type=E.WAKE))
    check(
        action_types(out) == [A.STOP_PLAYBACK, A.CANCEL_TURN, A.START_LISTENING],
        "wake while speaking → stop + cancel + listen (the 'stop'-word path, §7)",
    )


def test_playback_done_ends_run():
    section("playback complete → end the run (per-turn; RUN_END → LED idle, re-wake next)")
    m = sm.BargeInMachine()
    m.state = S.SPEAKING
    out = m.handle(sm.Event(type=E.PLAYBACK_DONE))
    check(action_types(out) == [A.GO_IDLE], "true end-of-audio ends the run (GO_IDLE → RUN_END)")
    check(m.state == S.IDLE, "PLAYBACK_DONE moves SPEAKING → IDLE (next turn is a fresh wake)")


def test_reset_goes_idle():
    section("reset → IDLE")
    m = sm.BargeInMachine()
    m.state = S.SPEAKING
    out = m.handle(sm.Event(type=E.RESET))
    check(action_types(out) == [A.GO_IDLE], "RESET emits GO_IDLE")
    check(m.state == S.IDLE, "RESET moves to IDLE")


def test_trailing_sentences_after_barge_in_dropped():
    section("post-barge-in trailing sentences are dropped")
    th = sm.BargeInThresholds(barge_in_min_ms=100, barge_in_speech_threshold=0.7)
    m = sm.BargeInMachine(thresholds=th)
    m.state = S.SPEAKING
    m.handle(frame(0.9, 1000, is_speech=True))
    m.handle(frame(0.9, 1150, is_speech=True))  # barge-in fires → LISTENING
    check(m.state == S.LISTENING, "barged in")
    # A late reply sentence from the now-cancelled turn shouldn't speak.
    out = m.handle(sm.Event(type=E.REPLY_SENTENCE, text="leftover from cancelled turn"))
    check(action_types(out) == [], "trailing sentence after barge-in does not SPEAK")


# ── tests: LD2450 presence parsing ───────────────────────────────────────────


def test_ld2450_presence_basic():
    section("LD2450: presence + near distance")
    snap = ld.parse_presence(
        {
            "Satellite1 Presence": "on",
            "Target-1 X": 300.0,
            "Target-1 Y": 1200.0,  # ~1.24 m
            "Target-1 Speed": 5.0,
        }
    )
    check(snap.present is True, "presence sensor 'on' → present")
    nd = snap.nearest_distance_mm()
    check(nd is not None and abs(nd - (300**2 + 1200**2) ** 0.5) < 1.0, "distance computed from x/y")
    check(snap.present_and_near(2500.0) is True, "1.24 m is within the 2.5 m near gate")


def test_ld2450_present_but_far():
    section("LD2450: present but beyond the near threshold")
    snap = ld.parse_presence(
        {"presence": "on", "Target-1 X": 0.0, "Target-1 Y": 4000.0}  # 4 m
    )
    check(snap.present is True, "present")
    check(snap.present_and_near(2500.0) is False, "4 m exceeds the 2.5 m near gate")


def test_ld2450_no_presence():
    section("LD2450: nobody present")
    snap = ld.parse_presence({"Presence": "off"})
    check(snap.present is False, "presence off → not present")
    check(snap.present_and_near() is False, "absent → present_and_near False")


def test_ld2450_target_implies_presence():
    section("LD2450: an active target implies presence even if binary lags")
    snap = ld.parse_presence({"Target-2 Distance": 1500.0})
    check(snap.present is True, "active target → present (binary sensor lag tolerated)")
    check(len(snap.targets) == 1 and snap.targets[0].index == 2, "target index parsed")


# ── tests: sentence splitter (mirror openai_shim) ────────────────────────────


def test_sentence_splitter():
    section("sentence splitter (decimal-safe, mirrors openai_shim)")
    # Pull the function from coordinator.py WITHOUT importing the module (which
    # would pull httpx). Read + exec just the function body in a clean namespace.
    coord_path = os.path.join(PKG_DIR, "coordinator.py")
    with open(coord_path, "r", encoding="utf-8") as f:
        src = f.read()
    start = src.index("def _next_sentence_boundary(")
    end = src.index("\n\n", start)
    ns: dict = {}
    exec(src[start:end], ns)  # noqa: S102 - trusted local source, test-only
    nsb = ns["_next_sentence_boundary"]

    s = "You have three things today. The first is at ten."
    cut = nsb(s)
    check(cut > 0 and s[:cut].strip() == "You have three things today.", "splits on the first period+space")
    check(nsb("The EV is at 3.14 percent") == -1, "decimal does NOT split mid-number")
    check(nsb("No terminator yet") == -1, "no terminator → -1")
    multi = nsb("Wait!? Are you sure")
    check(multi > 0 and "Wait!?".startswith("Wait"), "run-on terminators absorbed")


def main() -> int:
    print("Voice-coordinator unit tests (state machine + LD2450 + splitter)")
    test_wake_starts_listening()
    test_endpoint_after_silence()
    test_transcript_sends_turn()
    test_empty_transcript_relistens()
    test_reply_sentence_speaks()
    test_barge_in_fires_on_sustained_speech_over_floor()
    test_no_barge_in_below_floor()
    test_transient_speech_resets_sustain()
    test_adaptive_floor_lifts_above_a_fixed_floor()
    test_loud_human_still_barges_over_elevated_residual()
    test_transient_loud_syllable_rejected()
    test_presence_gate_blocks_barge_in()
    test_wake_during_speaking_is_interrupt()
    test_playback_done_ends_run()
    test_reset_goes_idle()
    test_trailing_sentences_after_barge_in_dropped()
    test_ld2450_presence_basic()
    test_ld2450_present_but_far()
    test_ld2450_no_presence()
    test_ld2450_target_implies_presence()
    test_sentence_splitter()

    print(f"\n{'─'*50}")
    print(f"  {_passed} passed, {_failed} failed")
    if _failed:
        print("  ✗ VOICE-COORDINATOR UNIT TESTS FAILED")
        return 1
    print("  ✓ VOICE-COORDINATOR UNIT TESTS PASSED")
    return 0


if __name__ == "__main__":
    sys.exit(main())
