#!/usr/bin/env python3
"""Extract PornHub's popularity heat from a watch page and print it in yt-dlp's
heatmap shape (a JSON array of {start_time, end_time, value}, value 0..1).
yt-dlp doesn't surface PornHub's `flashvars.hotspots` (a per-5s view-weight
array); this fetches the page with curl_cffi impersonation (beats the 403) and
converts it. Prints "[]" on any failure (fail-soft — the caller no-ops)."""
import sys, re, json

def main():
    url = sys.argv[1]
    from curl_cffi import requests
    html = requests.get(url, impersonate="chrome", timeout=30).text
    m = re.search(r'var\s+flashvars_\d+\s*=\s*(\{.*?\})\s*;', html, re.S)
    if not m:
        print("[]"); return
    fv = json.loads(m.group(1))
    h = [float(x) for x in fv.get("hotspots", []) if isinstance(x, (int, float))]
    dur = float(fv.get("video_duration") or 0)
    if len(h) < 4 or dur <= 0:
        print("[]"); return
    # Normalize by the 95th percentile, not the raw max: the 0:00 segment is a
    # huge outlier (everyone starts there) and max-normalizing flattens the rest.
    srt = sorted(h)
    p95 = srt[min(len(srt) - 1, int(len(srt) * 0.95))] or max(h) or 1.0
    n = len(h)
    out = [
        {"start_time": round(i / n * dur, 3),
         "end_time": round((i + 1) / n * dur, 3),
         "value": round(min(1.0, v / p95), 4)}
        for i, v in enumerate(h)
    ]
    print(json.dumps(out))

try:
    main()
except Exception:
    print("[]")
