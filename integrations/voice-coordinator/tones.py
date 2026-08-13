"""Pre-speech alert tones for dangerous-weather announcements (2026-06-23).

Two synthesized, cached mp3 clips the coordinator plays AHEAD of Kate's TTS on a
dangerous-weather `/speak` (Hearth passes `pre_tone`):

  - 'critical' — the EAS/EBS attention two-tone (853 + 960 Hz, duophonic), the
    familiar "this is an emergency" signal — for an NWS tornado/severe WARNING.
  - 'notice'   — a soft two-note chime — for routine close lightning / high wind
    (intentionally gentler so common Front-Range lightning doesn't cry wolf).

Synthesized once with numpy + encoded to mp3 with lameenc (mp3 is the device's
confirmed media_player format). FAIL-SOFT: any synth/encode error returns None,
and the coordinator just speaks the alert with no pre-tone.
"""
from __future__ import annotations

import logging

log = logging.getLogger("voice_coordinator.tones")

_SR = 24000
_VALID = ("critical", "notice")
_cache: dict[str, bytes] = {}


def _encode_mp3(pcm_bytes: bytes) -> bytes:
    import lameenc

    enc = lameenc.Encoder()
    enc.set_bit_rate(96)
    enc.set_in_sample_rate(_SR)
    enc.set_channels(1)
    enc.set_quality(2)  # 2 = high quality
    # lameenc returns a bytearray; normalize to immutable bytes (clean clip type).
    return bytes(enc.encode(pcm_bytes) + enc.flush())


def _critical_pcm():
    import numpy as np

    dur = 2.5
    t = np.arange(int(dur * _SR)) / _SR
    # EAS attention signal: 853 Hz and 960 Hz played simultaneously.
    s = (np.sin(2 * np.pi * 853.0 * t) + np.sin(2 * np.pi * 960.0 * t)) / 2.0
    # 12 ms raised-cosine fade in/out to avoid clicks.
    n = int(0.012 * _SR)
    ramp = (1 - np.cos(np.linspace(0, np.pi, n))) / 2
    env = np.ones(len(s))
    env[:n] = ramp
    env[-n:] = ramp[::-1]
    s *= env
    return (np.clip(s, -1, 1) * 0.9 * 32767).astype("<i2").tobytes()


def _notice_pcm():
    import numpy as np

    def note(freq: float, dur: float):
        t = np.arange(int(dur * _SR)) / _SR
        # Soft 10 ms attack + exponential decay → a gentle chime, not an alarm.
        env = np.minimum(1.0, t / 0.01) * np.exp(-t * 6.0)
        return np.sin(2 * np.pi * freq * t) * env

    gap = np.zeros(int(0.05 * _SR))
    s = np.concatenate([note(660.0, 0.22), gap, note(880.0, 0.30)])  # E5 → A5, ascending
    return (np.clip(s, -1, 1) * 0.7 * 32767).astype("<i2").tobytes()


def tone_mp3(kind: "str | None") -> "bytes | None":
    """Cached mp3 bytes for `kind` ('critical'|'notice'), or None for an unknown
    kind / a synth-or-encode failure (fail-soft → the alert speaks with no tone)."""
    if kind not in _VALID:
        return None
    if kind not in _cache:
        try:
            pcm = _critical_pcm() if kind == "critical" else _notice_pcm()
            _cache[kind] = _encode_mp3(pcm)
            log.info("alert tone '%s' synthesized (%d bytes mp3)", kind, len(_cache[kind]))
        except Exception:  # noqa: BLE001
            log.exception("alert tone '%s' synth failed — speaking with no pre-tone", kind)
            return None
    return _cache[kind]
