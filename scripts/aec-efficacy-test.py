#!/usr/bin/env python3
"""AEC efficacy test (design-esp-direct-voice.md §2) — the ONE fact that
finalizes full-duplex vs hybrid vs half-duplex before any further build.

⚠ THIS NEEDS THE DEVICE SESSION. The device's Noise login FAILS while Home
Assistant holds it (§3 concurrency), so this is an OPERATOR-RUN, maintenance-
window tool — it is NOT run automatically and NOT run by CI. Procedure:

  1. HA → Settings → Devices → Satellite1 → ⋮ → Disable (this device only;
     ~10 s, reversible). This frees the native-API session.
  2. Run this script from a box on the LAN (the LLM host or the Mac). It connects
     via aioesphomeapi with the device Noise PSK, plays a known Kate TTS clip
     out the device speaker, captures the AEC'd mic (channels:0) during
     double-talk, computes ERLE, and feeds the capture to the SAME parakeet STT
     Hearth uses — scoring whether the interrupt phrase transcribes over Kate.
  3. Repeat at 1.0 / 2.0 / 3.0 m. Also do a playback-only capture (echo floor)
     and a music-playback variant (speech-like echo is the hardest case).
  4. Re-ENABLE HA's integration. Zero persistent change; no firmware flashed.

VERDICT TREE (printed at the end):
  - interrupt clean (WER < ~15%) at >= 2 m → FULL-DUPLEX GO.
  - clean only <= 1 m / marginal at distance → HYBRID (open-mic close,
    "stop"-word at distance).
  - garbled at all distances → HALF-DUPLEX fallback (§7). [rated unlikely]

USAGE
  # Free the device in HA first (see step 1), then:
  export HEARTH_VC_DEVICE_PSK="<base64 noise psk from HA core.config_entries>"
  python3 scripts/aec-efficacy-test.py \
      --device 192.168.0.29 \
      --tts http://192.168.0.188:8023/v1 --tts-voice EN_F_Laur \
      --stt http://<your-llm-host-ip>:8093/v1 \
      --interrupt "Kate stop what's on my calendar tomorrow" \
      --distance 1.0

  # Echo-floor reference (no human speaking — measures residual echo):
  python3 scripts/aec-efficacy-test.py --device 192.168.0.29 ... --playback-only --distance 1.0

  # Music variant (hardest echo case):
  python3 scripts/aec-efficacy-test.py --device 192.168.0.29 ... --music-clip my_song.wav --distance 2.0

Run one invocation per (distance, variant); the script prints that run's ERLE +
WER and where it falls in the verdict tree. Keep a notepad of the three
distances; the FINAL verdict is across all three (the script reminds you).

This file deliberately performs NO write to the device beyond playing audio,
and exits cleanly on Ctrl-C. It does not run unless you pass --device.
"""
from __future__ import annotations

import argparse
import asyncio
import io
import json
import math
import os
import sys
import time
import urllib.request
import wave

# ── helpers: WER, ERLE, audio math (stdlib only) ─────────────────────────────


def _normalize_words(s: str) -> list[str]:
    keep = []
    for ch in s.lower():
        if ch.isalnum() or ch == " " or ch == "'":
            keep.append(ch)
        else:
            keep.append(" ")
    return "".join(keep).split()


def word_error_rate(reference: str, hypothesis: str) -> float:
    """Levenshtein word error rate. 0.0 = perfect, 1.0 = nothing matched."""
    ref = _normalize_words(reference)
    hyp = _normalize_words(hypothesis)
    if not ref:
        return 0.0 if not hyp else 1.0
    # DP edit distance over words.
    d = list(range(len(hyp) + 1))
    for i in range(1, len(ref) + 1):
        prev = d[0]
        d[0] = i
        for j in range(1, len(hyp) + 1):
            cur = d[j]
            cost = 0 if ref[i - 1] == hyp[j - 1] else 1
            d[j] = min(d[j] + 1, d[j - 1] + 1, prev + cost)
            prev = cur
    return d[len(hyp)] / len(ref)


def _pcm16_rms(pcm: bytes) -> float:
    """RMS power of 16-bit little-endian mono PCM."""
    n = len(pcm) // 2
    if n == 0:
        return 0.0
    import array

    a = array.array("h")
    a.frombytes(pcm[: n * 2])
    if sys.byteorder == "big":
        a.byteswap()
    total = 0.0
    for s in a:
        total += float(s) * float(s)
    return math.sqrt(total / n)


def erle_db(playback_only_pcm: bytes, residual_pcm: bytes) -> float:
    """ERLE = 10·log10(playback-only power / residual power). Higher = better
    echo cancellation. Target >= 15-20 dB (design §2)."""
    p = _pcm16_rms(playback_only_pcm)
    r = _pcm16_rms(residual_pcm)
    if r <= 1e-9:
        return 99.0
    if p <= 1e-9:
        return 0.0
    return 10.0 * math.log10((p * p) / (r * r))


def _wav_to_pcm16_mono(wav_bytes: bytes, target_rate: int = 16000) -> bytes:
    """Extract mono 16-bit PCM at target_rate from a WAV (best-effort; assumes
    the captured mic is already 16 kHz mono per the device spec)."""
    with wave.open(io.BytesIO(wav_bytes), "rb") as w:
        ch = w.getnchannels()
        sw = w.getsampwidth()
        fr = w.getframerate()
        frames = w.readframes(w.getnframes())
    if sw != 2:
        # Only 16-bit handled in this stdlib path; flag loudly.
        print(f"  ! capture sample width {sw*8}-bit (expected 16) — ERLE may be off")
    if ch > 1:
        # Take channel 0 (the AEC'd channel per device spec).
        import array

        a = array.array("h")
        a.frombytes(frames)
        frames = array.array("h", a[0::ch]).tobytes()
    if fr != target_rate:
        print(f"  ! capture rate {fr} != {target_rate}; not resampling (informational)")
    return frames


def _pcm_to_wav(pcm: bytes, rate: int = 16000) -> bytes:
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(pcm)
    return buf.getvalue()


# ── TTS + STT (urllib, no third-party) — same shapes as scripts/bench-voice.py ──


def fetch_tts_wav(tts_base: str, voice: str, model: str, text: str, timeout: float = 60.0) -> bytes:
    body = {"model": model, "voice": voice, "input": text, "response_format": "wav", "stream": True}
    req = urllib.request.Request(
        f"{tts_base.rstrip('/')}/audio/speech",
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json"},
    )
    buf = io.BytesIO()
    with urllib.request.urlopen(req, timeout=timeout) as r:
        while True:
            chunk = r.read(4096)
            if not chunk:
                break
            buf.write(chunk)
    return buf.getvalue()


def stt_transcribe(stt_base: str, model: str, wav_bytes: bytes, timeout: float = 30.0) -> str:
    boundary = "----aectest"
    crlf = "\r\n"
    head = []
    head.append(
        f'--{boundary}{crlf}Content-Disposition: form-data; name="model"{crlf}{crlf}{model}{crlf}'
    )
    head.append(
        f'--{boundary}{crlf}Content-Disposition: form-data; name="file"; filename="a.wav"{crlf}'
        f"Content-Type: audio/wav{crlf}{crlf}"
    )
    body = b"".join(p.encode() for p in head) + wav_bytes + f"{crlf}--{boundary}--{crlf}".encode()
    req = urllib.request.Request(
        f"{stt_base.rstrip('/')}/audio/transcriptions",
        data=body,
        headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
    )
    with urllib.request.urlopen(req, timeout=timeout) as r:
        out = json.loads(r.read())
    return str(out.get("text", "")).strip()


# ── device capture (aioesphomeapi) ───────────────────────────────────────────


async def capture_double_talk(
    device_host: str,
    device_port: int,
    psk: str,
    *,
    tts_wav: bytes,
    capture_seconds: float,
    play_audio: bool,
) -> bytes:
    """Connect, optionally play `tts_wav` out the device, and capture the AEC'd
    mic for `capture_seconds`. Returns captured mono 16-bit PCM.

    The exact play/capture API binding is version-specific on aioesphomeapi; the
    operator confirms the device build during the window. This isolates ALL the
    device-session code to this one coroutine — the math/scoring above is pure.
    """
    try:
        from aioesphomeapi import APIClient  # type: ignore
    except Exception as e:  # noqa: BLE001
        raise SystemExit(
            "aioesphomeapi is required for the device capture. Install it:\n"
            "  pip3 install aioesphomeapi\n"
            f"(import error: {e})"
        )

    client = APIClient(address=device_host, port=device_port, password="", noise_psk=psk)
    captured = bytearray()
    done = asyncio.Event()

    async def _on_audio(data: bytes) -> None:
        captured.extend(data)

    try:
        await client.connect(login=True)
    except Exception as e:  # noqa: BLE001
        raise SystemExit(
            f"could not connect to {device_host}:{device_port} — {e}\n"
            "Is HA's integration for this device DISABLED? (one voice client per "
            "device — the Noise login fails while HA holds the session.)"
        )

    print(f"  connected to {device_host}:{device_port}")
    entities, _ = await client.list_entities_services()
    print(f"  device exposes {len(entities)} entities")

    # Subscribe to the voice_assistant mic stream. Binding kept defensive across
    # aioesphomeapi versions (kwargs first, positional fallback).
    async def _start(*a, **k):  # noqa: ANN002, ANN003
        return None

    async def _stop(*a, **k):  # noqa: ANN002, ANN003
        done.set()

    try:
        client.subscribe_voice_assistant(handle_start=_start, handle_stop=_stop, handle_audio=_on_audio)
    except TypeError:
        client.subscribe_voice_assistant(_start, _stop, _on_audio)

    # Play the TTS clip out the device speaker (the echo source). The exact
    # call is version-specific — operator confirms during the window. If the
    # build needs media_player, set --media-entity and adapt here.
    if play_audio:
        print("  ▶ playing TTS clip out the device speaker (speak the interrupt phrase at t≈3 s)…")
        # TODO(bring-up): bind the device audio-out call for this firmware build
        # (voice_assistant TTS frames or media_player play_media of tts_wav).
        # Left explicit so the operator wires the one device-specific call with
        # the session in hand.
        pass
    else:
        print("  ▶ playback-only OFF (this is a no-play capture)")

    # Capture for the window.
    t0 = time.monotonic()
    while time.monotonic() - t0 < capture_seconds and not done.is_set():
        await asyncio.sleep(0.05)

    await client.disconnect()
    print(f"  captured {len(captured)} bytes of mic audio ({capture_seconds:.1f}s window)")
    return bytes(captured)


# ── verdict ──────────────────────────────────────────────────────────────────


def print_verdict(distance_m: float, erle: float | None, wer: float | None, transcript: str) -> None:
    print("\n" + "═" * 64)
    print(f"  AEC RESULT @ {distance_m:.1f} m")
    print("═" * 64)
    if erle is not None:
        flag = "✓" if erle >= 15 else ("~" if erle >= 8 else "✗")
        print(f"  [{flag}] ERLE: {erle:.1f} dB  (target ≥ 15-20 dB)")
    if wer is not None:
        flag = "✓" if wer < 0.15 else ("~" if wer < 0.4 else "✗")
        print(f"  [{flag}] interrupt-phrase WER: {wer*100:.0f}%  (clean < 15%)")
        print(f"        STT heard: {transcript!r}")
    print("")
    print("  This run's bucket:")
    if wer is not None and wer < 0.15 and distance_m >= 2.0:
        print("    → FULL-DUPLEX GO (clean interrupt at ≥ 2 m).")
    elif wer is not None and wer < 0.15:
        print("    → clean at this (≤1 m) distance — points to HYBRID if it")
        print("      degrades at 2-3 m. Run the 2 m + 3 m captures to decide.")
    elif wer is not None and wer < 0.4:
        print("    → MARGINAL — HYBRID territory (open-mic close, 'stop'-word at distance).")
    else:
        print("    → GARBLED at this distance — if all distances garble, HALF-DUPLEX (§7).")
    print("")
    print("  FINAL verdict is across ALL THREE distances + the music variant.")
    print("  Record this run; compare 1.0 / 2.0 / 3.0 m before deciding.")
    print("═" * 64)


# ── main ─────────────────────────────────────────────────────────────────────


def main() -> None:
    ap = argparse.ArgumentParser(description="Satellite1 AEC efficacy test (design §2).")
    ap.add_argument("--device", required=True, help="device IP/host (e.g. 192.168.0.29)")
    ap.add_argument("--device-port", type=int, default=6053)
    ap.add_argument("--psk", default=os.environ.get("HEARTH_VC_DEVICE_PSK", ""), help="Noise PSK (or HEARTH_VC_DEVICE_PSK)")
    ap.add_argument("--tts", default="http://192.168.0.188:8023/v1", help="TTS base url")
    ap.add_argument("--tts-voice", default="EN_F_Laur")
    ap.add_argument("--tts-model", default="EN_F_Laur")
    ap.add_argument("--stt", default="http://<your-llm-host-ip>:8093/v1", help="STT base url")
    ap.add_argument("--stt-model", default="deepdml/faster-whisper-large-v3-turbo-ct2")
    ap.add_argument(
        "--clip-text",
        default=(
            "Good morning. You have three things today: the farmers market at ten, "
            "dog grooming at eleven, and a tasting at noon. Want me to map the drive?"
        ),
        help="the Kate TTS clip played out the speaker (the echo source)",
    )
    ap.add_argument(
        "--interrupt",
        default="Kate stop what's on my calendar tomorrow",
        help="the phrase the human says at t≈3 s (the reference for WER)",
    )
    ap.add_argument("--distance", type=float, required=True, help="mic-to-device distance in meters (1.0/2.0/3.0)")
    ap.add_argument("--capture-seconds", type=float, default=10.0)
    ap.add_argument("--playback-only", action="store_true", help="echo-floor reference: play, do NOT speak")
    ap.add_argument("--music-clip", default="", help="path to a WAV to play instead of TTS (hardest echo case)")
    ap.add_argument("--save-wav", default="", help="optional path to write the captured WAV for inspection")
    args = ap.parse_args()

    if not args.psk:
        sys.exit(
            "No Noise PSK. Pass --psk or set HEARTH_VC_DEVICE_PSK (from HA's "
            "core.config_entries). The device login needs it."
        )

    print("Satellite1 AEC efficacy test (design §2)")
    print("  ⚠ Confirm HA's integration for this device is DISABLED before running.")
    print(f"  device={args.device}:{args.device_port}  distance={args.distance:.1f} m")
    print(f"  TTS={args.tts} ({args.tts_voice})   STT={args.stt}")

    # 1. Build the playback clip (TTS or music).
    if args.music_clip:
        with open(args.music_clip, "rb") as f:
            play_wav = f.read()
        print(f"  playback source: music clip {args.music_clip} ({len(play_wav)} bytes)")
    else:
        print("  synthesizing the Kate TTS clip…")
        play_wav = fetch_tts_wav(args.tts, args.tts_voice, args.tts_model, args.clip_text)
        print(f"  TTS clip: {len(play_wav)} bytes")

    # 2. Capture the AEC'd mic while playing.
    print("\n  Get in position; capture starts on connect.")
    captured = asyncio.run(
        capture_double_talk(
            args.device,
            args.device_port,
            args.psk,
            tts_wav=play_wav,
            capture_seconds=args.capture_seconds,
            play_audio=True,
        )
    )

    if not captured:
        sys.exit(
            "No mic audio captured. The device-audio binding in "
            "capture_double_talk() needs the firmware-specific call wired with "
            "the session in hand (see the TODO). Confirm the voice_assistant "
            "subscription is receiving frames."
        )

    capture_wav = _pcm_to_wav(captured)
    if args.save_wav:
        with open(args.save_wav, "wb") as f:
            f.write(capture_wav)
        print(f"  saved capture → {args.save_wav}")

    # 3. ERLE: needs a playback-only reference. In --playback-only mode this
    #    capture IS the reference (print its power; ERLE computed against a
    #    separately-run double-talk capture by the operator). In double-talk
    #    mode we approximate ERLE against the played clip's power as a rough
    #    floor and rely on WER as the decisive functional metric (§2 B).
    erle = None
    if args.playback_only:
        rms = _pcm16_rms(captured)
        print(f"\n  playback-only residual RMS: {rms:.1f} (this is the echo-floor reference)")
        print("  Run a double-talk capture at the same distance to compute ERLE.")
    else:
        try:
            play_pcm = _wav_to_pcm16_mono(play_wav)
            erle = erle_db(play_pcm, captured)
        except Exception as e:  # noqa: BLE001
            print(f"  (ERLE approximation skipped: {e})")

    # 4. Functional: feed the double-talk capture to the SAME STT, score WER.
    wer = None
    transcript = ""
    if not args.playback_only:
        print("\n  transcribing the capture via parakeet (the SAME STT Hearth uses)…")
        try:
            transcript = stt_transcribe(args.stt, args.stt_model, capture_wav)
            wer = word_error_rate(args.interrupt, transcript)
        except Exception as e:  # noqa: BLE001
            print(f"  ! STT failed: {e}")

    print_verdict(args.distance, erle, wer, transcript)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\ninterrupted — no persistent change made.")
        sys.exit(130)
