"""Silero VAD binding test — guards the context-prepend wiring (vad.py).

The bug this guards: Silero v5 onnx must receive [64-sample context + 512 new]
per call at 16 kHz; feeding bare 512 (no context) returns garbage (~0.003) for
ALL audio, so endpointing + barge-in silently never fire. A pure-silence check
would NOT catch it (silence reads low either way) — so this asserts REAL speech
reads HIGH.

SKIP-CLEAN (like scripts/smoke-connectors): needs onnxruntime + the model file
(+ forza TTS for the speech sample). Absent → skip, not fail. Run:
    HEARTH_VC_TTS_URL=http://192.168.0.188:8023/v1 \
      python integrations/voice-coordinator/tests/test_vad.py
"""
from __future__ import annotations

import audioop
import io
import json
import os
import sys
import urllib.request
import wave

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from vad import SileroVad, default_model_path  # noqa: E402


def _model_available() -> bool:
    try:
        import onnxruntime  # noqa: F401
    except Exception:
        return False
    return os.path.exists(os.environ.get("HEARTH_VC_VAD_MODEL") or default_model_path())


def _fetch_speech_16k() -> bytes | None:
    """Synthesize a short clip via forza and resample to 16 kHz mono PCM."""
    base = os.environ.get("HEARTH_VC_TTS_URL", "http://192.168.0.188:8023/v1").rstrip("/")
    body = json.dumps({
        "model": os.environ.get("HEARTH_VC_TTS_MODEL", "EN_F_Laur"),
        "voice": os.environ.get("HEARTH_VC_TTS_VOICE", "EN_F_Laur"),
        "input": "What is on my calendar tomorrow afternoon?",
        "response_format": "wav", "stream": True,
    }).encode()
    try:
        req = urllib.request.Request(f"{base}/audio/speech", data=body, headers={"Content-Type": "application/json"})
        raw = urllib.request.urlopen(req, timeout=30).read()
        with wave.open(io.BytesIO(raw), "rb") as w:
            sr, ch, sw, pcm = w.getframerate(), w.getnchannels(), w.getsampwidth(), w.readframes(w.getnframes())
        if ch == 2:
            pcm = audioop.tomono(pcm, sw, 0.5, 0.5)
        pcm16, _ = audioop.ratecv(pcm, 2, 1, sr, 16000, None)
        return pcm16
    except Exception as e:  # noqa: BLE001
        print(f"  (forza TTS unreachable: {e})")
        return None


def _scan(vad: SileroVad, pcm16: bytes) -> tuple[float, float]:
    probs = []
    for i in range(0, len(pcm16) - 1023, 1024):
        p, _ = vad.process_frame(pcm16[i:i + 1024])
        probs.append(p)
    return (max(probs), sum(probs) / len(probs)) if probs else (0.0, 0.0)


def run() -> int:
    if not _model_available():
        print("SKIP test_vad: onnxruntime or silero_vad.onnx not available")
        return 0
    speech = _fetch_speech_16k()
    if speech is None:
        print("SKIP test_vad: no speech sample (forza TTS unreachable)")
        return 0

    vad = SileroVad(threshold=0.5, sample_rate=16000)
    assert vad.enabled, f"VAD failed to load: {vad.reason}"

    # 1. real speech must read HIGH (the context-prepend bug makes this ~0.1).
    smax, smean = _scan(vad, speech)
    print(f"speech: max={smax:.3f} mean={smean:.3f}")
    assert smax > 0.8, f"speech max prob {smax:.3f} too low — context-prepend likely broken"
    assert smean > 0.4, f"speech mean prob {smean:.3f} too low"

    # 2. silence must read LOW.
    vad.reset()
    silence = b"\x00\x00" * 16000  # 1 s of 16 kHz silence
    qmax, _ = _scan(vad, silence)
    print(f"silence: max={qmax:.3f}")
    assert qmax < 0.3, f"silence max prob {qmax:.3f} too high"

    # 3. reset() must clear state without error.
    vad.reset()
    _scan(vad, speech)

    print("PASS test_vad: context-prepend wiring correct (speech high, silence low)")
    return 0


if __name__ == "__main__":
    sys.exit(run())
