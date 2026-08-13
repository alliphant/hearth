"""Unit test for the alert-tone synthesizer (tones.py).

    python3 integrations/voice-coordinator/tests/test_tones.py

The mp3 synthesis needs numpy + lameenc (present in the container image). When
they're absent locally, the valid-kind cases SKIP; the dependency-free
unknown-kind case (fail-soft → None) always runs.
"""
import importlib.util
import os
import sys

_DIR = os.path.dirname(os.path.abspath(__file__))
_TONES = os.path.join(os.path.dirname(_DIR), "tones.py")
_spec = importlib.util.spec_from_file_location("vc_tones", _TONES)
tones = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(tones)


def main() -> None:
    passed = 0

    # Dependency-free: an unknown / None kind returns None and never imports
    # numpy/lameenc (the fail-soft path the coordinator relies on).
    assert tones.tone_mp3(None) is None
    assert tones.tone_mp3("bogus") is None
    print("  ✓ unknown/None kind → None (fail-soft, no deps)")
    passed += 1

    try:
        import lameenc  # noqa: F401
        import numpy  # noqa: F401
    except Exception:  # noqa: BLE001
        print("  ⚠ numpy/lameenc absent — skipping mp3 synth assertions (run in the container)")
        print(f"\n  passed={passed} (synth skipped)")
        return

    for kind in ("critical", "notice"):
        b = tones.tone_mp3(kind)
        assert isinstance(b, bytes) and len(b) > 500, f"{kind}: {type(b)} len={len(b) if b else 0}"
        # raw mp3 frame sync: 0xFF then top 3 bits set
        assert b[0] == 0xFF and (b[1] & 0xE0) == 0xE0, f"{kind}: no mp3 frame sync ({b[:3]!r})"
        assert tones.tone_mp3(kind) is b, f"{kind}: not cached on 2nd call"
        print(f"  ✓ {kind}: {len(b)} bytes mp3, cached")
        passed += 1

    print(f"\n  passed={passed}")


if __name__ == "__main__":
    try:
        main()
        print("✓ TONES TEST OK")
    except AssertionError as e:
        print("✗ TONES TEST FAILED:", e)
        sys.exit(1)
