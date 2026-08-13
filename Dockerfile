# Hearth container image — Bun 1.3.14 matched to the always-on host's prior runtime.
#
# Three services run from this image (orchestrator, ingestor, scheduler);
# compose at /docker/docker-compose.yml on the LLM host overrides `command:`.
#
# The repo is bind-mounted at /app so git pull-and-restart works the same
# way it did on the always-on host. node_modules is an anonymous volume in compose so the
# bind mount doesn't shadow the image's linux-native install.
FROM oven/bun:1.3.14-debian

# Native deps:
# - ffmpeg for HEIC → JPEG vision transcode (src/core/image_transcode.ts)
# - git for Beatrice's change pipeline (propose_code_change / apply_low_risk_fix
#   shell out to git via src/specialists/trainer/change_pipeline.ts — without it
#   the whole self-modification loop throws "git: not found" and no PR ever opens)
# - openssh-client for the ops-relay's REMOTE restart path (ops/ops-relay/relay.ts
#   shells out to `ssh` to restart a forza-hosted container, e.g. the vision tier;
#   the key is forced-command-restricted on the remote, so it can only restart
#   allowlisted containers there). Only the hearth-ops-relay service uses it.
# - cairo/pango/jpeg/gif/rsvg for jsdom (URL inbox converter)
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ffmpeg \
      git \
      openssh-client \
      ca-certificates \
      curl \
      python3-pip \
      sqlite3 \
      libcairo2-dev \
      libpango1.0-dev \
      libjpeg-dev \
      libgif-dev \
      librsvg2-dev \
 && rm -rf /var/lib/apt/lists/*

# Media Archive (2026-07-11): yt-dlp for the archival pipeline's probe + download
# (src/connectors/media_probe.ts + media_download.ts). The official zipapp runs on
# the image's python3; ffmpeg (above) does the merge/recode + keyframe sampling.
# Pinned to the latest release at build time; rebuild (docker compose build
# hearth-orchestrator) to refresh for site changes.
RUN curl -fsSL https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp \
 && chmod a+rx /usr/local/bin/yt-dlp

# curl_cffi backs yt-dlp's `--impersonate`, which media_probe.ts / media_download.ts
# use to get past 403/bot-wall sites (e.g. Cloudflare-fronted adult sites) that
# block the default extractor. Installed into the SAME system python3 the yt-dlp
# zipapp runs on. `--break-system-packages` for Debian's PEP-668 externally-
# managed env; fall back for older pip. Verify a target is actually available so
# the build fails loudly if impersonation didn't wire up.
RUN (pip3 install --break-system-packages --no-cache-dir "curl_cffi>=0.7" \
     || pip3 install --no-cache-dir "curl_cffi>=0.7") \
 && yt-dlp --list-impersonate-targets | grep -qiE 'chrome|edge|safari'

# gallery-dl for image-gallery archiving (media_download.ts download_gallery +
# the media_probe.ts gallery-dl fallback). Releases moved GitHub → Codeberg (the
# GitHub release now ships NO assets), and Codeberg has no `latest/download`
# alias, so resolve the newest tag via the API at build time. `gallery-dl.bin`
# is a self-contained PyInstaller Linux executable (no python dependency); the
# trailing `--version` fails the build loudly if the binary can't run here.
RUN GDL_VER="$(curl -fsSL https://codeberg.org/api/v1/repos/mikf/gallery-dl/releases/latest | grep -oE '"tag_name":"[^"]+"' | head -1 | cut -d'"' -f4)" \
 && test -n "$GDL_VER" \
 && curl -fsSL "https://codeberg.org/mikf/gallery-dl/releases/download/${GDL_VER}/gallery-dl.bin" -o /usr/local/bin/gallery-dl \
 && chmod a+rx /usr/local/bin/gallery-dl \
 && /usr/local/bin/gallery-dl --version

WORKDIR /app

# Pre-install deps as root so node_modules lands linux-native in the image
# layer. Compose then anonymizes /app/node_modules so the host bind mount
# doesn't replace it with whatever the host happens to have.
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

# /app owned by UID 1000 so the bind mount lines up with /docker/hearth/repo
# on the host (owned jasper:jasper 1000:1000).
RUN chown -R 1000:1000 /app

USER 1000:1000

# No CMD — compose specifies the per-service entry point.
