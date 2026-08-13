#!/usr/bin/env python3
"""Vendor the guide's Google Fonts into src/app/client/hvac/fonts/.

Keeps only the latin + latin-ext subsets (the guide is English prose with
typographic punctuation), rewrites every gstatic URL to a relative local
path, and writes fonts.css alongside the .woff2 files.
"""
import hashlib, os, re, sys, urllib.request

SRC = sys.argv[1]
OUT_DIR = sys.argv[2]
KEEP = {"latin", "latin-ext"}
UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/126.0 Safari/537.36")

os.makedirs(OUT_DIR, exist_ok=True)
css = open(SRC, encoding="utf-8").read()

# Split into (subset-comment, @font-face block) pairs.
blocks = re.findall(r"/\*\s*([\w-]+)\s*\*/\s*(@font-face\s*\{.*?\})", css, re.S)
kept, downloaded, by_hash = [], {}, {}

for subset, block in blocks:
    if subset not in KEEP:
        continue
    m = re.search(r"font-family:\s*'([^']+)'", block)
    w = re.search(r"font-weight:\s*(\d+)", block)
    url = re.search(r"url\((https://fonts\.gstatic\.com[^)]+)\)", block)
    if not (m and w and url):
        continue
    family = m.group(1).replace(" ", "")
    req = urllib.request.Request(url.group(1), headers={"User-Agent": UA})
    data = urllib.request.urlopen(req, timeout=30).read()
    # Fraunces and IBM Plex are VARIABLE fonts: Google serves one file per
    # subset and every requested weight points at the same bytes. Key the
    # filename on content so 16 @font-face rules share 6 downloads.
    digest = hashlib.sha256(data).hexdigest()
    name = by_hash.get(digest)
    if name is None:
        name = f"{family}-{subset}.woff2"
        open(os.path.join(OUT_DIR, name), "wb").write(data)
        by_hash[digest] = name
        downloaded[name] = len(data)
    kept.append(block.replace(url.group(1), f"./fonts/{name}"))

header = (
    "/* Vendored from Google Fonts — latin + latin-ext subsets only.\n"
    " * Regenerate with scripts/vendor-hvac-fonts.py. The guide is served\n"
    " * offline-capable: no request leaves the tailnet to render it. */\n"
)
open(os.path.join(OUT_DIR, "..", "fonts.css"), "w", encoding="utf-8").write(
    header + "\n".join(kept) + "\n"
)
total = sum(downloaded.values())
print(f"{len(downloaded)} files, {total/1024:.0f} KB, {len(kept)} @font-face rules")
for n in sorted(downloaded):
    print(f"  {downloaded[n]/1024:6.1f} KB  {n}")
