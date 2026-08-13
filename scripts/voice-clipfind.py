#!/usr/bin/env python3
"""Find the best reference clip(s) for zero-shot voice cloning from a long
recording — ranked to MINIMIZE uptalk (rising terminal intonation) while keeping
clean, well-paced, consistent-timbre speech.

Why: Qwen3-TTS VoiceClone copies the reference's prosodic style. A reference with
declarative, FALLING terminal pitch → a clone with little uptalk. This scores
every clean utterance and surfaces the flattest-terminal, cleanest candidates.

Usage:
  pip install librosa soundfile numpy        # one-time
  python3 voice-clipfind.py LAUR.mp3                 # rank + print top candidates
  python3 voice-clipfind.py LAUR.mp3 --extract 4 --out ./laur_candidates
      # also write the top 4 as 24kHz mono WAVs (the clone reference format)
  # then clone-test each: POST each WAV as ref_audio, synth the same sentence, pick by ear.

Scoring (higher = better reference):
  - terminal_slope (semitones/sec over last ~0.6s of voiced F0): NEGATIVE/flat is
    good (declarative), POSITIVE is uptalk → penalized hard. THE key metric.
  - snr_db: utterance loudness over the noise floor (clean speech, no music/hiss).
  - duration: 8-15s sweet spot for cloning (too short = unstable timbre).
  - voiced_frac + f0 stability: clear, single-speaker, consistent pitch.
"""
import sys, os, json, argparse
import numpy as np

def log(*a): print(*a, file=sys.stderr)

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("audio")
    ap.add_argument("--extract", type=int, default=0, help="write top N candidates as WAV")
    ap.add_argument("--out", default="./clip_candidates")
    ap.add_argument("--min-dur", type=float, default=6.0)
    ap.add_argument("--max-dur", type=float, default=16.0)
    ap.add_argument("--top", type=int, default=10)
    args = ap.parse_args()

    try:
        import librosa, soundfile as sf
    except ImportError:
        log("Need: pip install librosa soundfile numpy"); sys.exit(2)

    log(f"loading {args.audio} ...")
    y, sr = librosa.load(args.audio, sr=24000, mono=True)   # 24k = clone target rate
    dur_total = len(y) / sr
    log(f"  {dur_total:.1f}s @ {sr}Hz")

    # Noise floor from the quietest 1% of frames (for SNR).
    frame = 2048; hop = 512
    rms = librosa.feature.rms(y=y, frame_length=frame, hop_length=hop)[0]
    noise_floor = np.percentile(rms, 5) + 1e-6

    # Segment on silence (top_db: lower = more aggressive splitting).
    intervals = librosa.effects.split(y, top_db=32, frame_length=frame, hop_length=hop)
    # Merge segments separated by < 0.35s (keep whole utterances together).
    merged = []
    gap = int(0.35 * sr)
    for s, e in intervals:
        if merged and s - merged[-1][1] < gap:
            merged[-1][1] = e
        else:
            merged.append([s, e])

    cands = []
    for s, e in merged:
        d = (e - s) / sr
        if d < args.min_dur or d > args.max_dur:
            continue
        seg = y[s:e]
        # F0 contour (pyin). fmin/fmax for an adult female voice.
        f0, voiced, _ = librosa.pyin(seg, sr=sr, fmin=110, fmax=400,
                                     frame_length=frame, hop_length=hop)
        vmask = ~np.isnan(f0)
        voiced_frac = float(vmask.mean())
        if voiced_frac < 0.35:
            continue
        f0v = f0[vmask]
        if len(f0v) < 10:
            continue
        semis = 12.0 * np.log2(f0v / np.nanmedian(f0v))   # F0 in semitones rel. median
        # terminal slope: linear fit over the last ~0.6s of VOICED frames
        tail_n = max(6, int(0.6 * sr / hop))
        tail = semis[-tail_n:]
        tx = np.arange(len(tail)) * (hop / sr)
        slope = float(np.polyfit(tx, tail, 1)[0]) if len(tail) >= 4 else 0.0  # semitones/sec
        seg_rms = float(np.sqrt(np.mean(seg**2)) + 1e-9)
        snr_db = 20 * np.log10(seg_rms / noise_floor)
        f0_std = float(np.std(semis))   # expressiveness / stability

        # Score: punish uptalk (positive slope) hard; reward clean + sweet-spot duration.
        uptalk_pen = max(0.0, slope) * 2.5          # rising terminal is the enemy
        falling_bonus = max(0.0, -slope) * 1.0      # gentle falling is ideal
        dur_fit = 1.0 - min(1.0, abs(d - 11.0) / 6.0)
        snr_fit = min(1.0, max(0.0, (snr_db - 12) / 24))
        stab_fit = 1.0 - min(1.0, abs(f0_std - 3.0) / 4.0)  # ~3 semitones = natural, not flat/wild
        score = (3.0 * snr_fit + 2.0 * dur_fit + 1.0 * stab_fit + falling_bonus + voiced_frac) - uptalk_pen
        cands.append(dict(start=s/sr, end=e/sr, dur=d, terminal_slope=round(slope, 2),
                          snr_db=round(snr_db, 1), voiced=round(voiced_frac, 2),
                          f0_semitone_std=round(f0_std, 2), score=round(score, 3),
                          s_samp=s, e_samp=e))

    cands.sort(key=lambda c: c["score"], reverse=True)
    log(f"\n{len(cands)} candidate utterances in [{args.min_dur},{args.max_dur}]s\n")
    print(f"{'#':>2} {'start':>8} {'dur':>5} {'termSlope':>9} {'snr':>6} {'voiced':>6} {'pitchStd':>8} {'score':>7}")
    print(f"{'':>2} {'(mm:ss)':>8} {'(s)':>5} {'(st/s↑bad)':>9} {'(dB)':>6} {'frac':>6} {'(semi)':>8}")
    for i, c in enumerate(cands[:args.top]):
        mm, ss = divmod(int(c["start"]), 60)
        print(f"{i+1:>2} {mm:02d}:{ss:02d}   {c['dur']:>5.1f} {c['terminal_slope']:>9.2f} "
              f"{c['snr_db']:>6.1f} {c['voiced']:>6.2f} {c['f0_semitone_std']:>8.2f} {c['score']:>7.2f}")

    if args.extract:
        os.makedirs(args.out, exist_ok=True)
        for i, c in enumerate(cands[:args.extract]):
            seg = y[c["s_samp"]:c["e_samp"]]
            mm, ss = divmod(int(c["start"]), 60)
            path = os.path.join(args.out, f"cand{i+1}_{mm:02d}m{ss:02d}s_slope{c['terminal_slope']:+.1f}.wav")
            sf.write(path, seg, sr, subtype="PCM_16")
            print(f"  wrote {path}")
        print(f"\nNext: clone-test each — synth the SAME sentence with each as ref_audio, pick by ear.")

if __name__ == "__main__":
    main()
