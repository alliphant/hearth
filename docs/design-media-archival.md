# Design — Media Archival (Kate's URL → Serapeum archive)

> **Status:** Phase 1 backend **BUILT + smoke-verified** (2026-07-11) — the full
> pipeline, the `/api/media/*` serving API with HTTP range, the NSFW cordon, and
> two self-contained smokes (`smoke:media-archive` + `smoke:media-serving`, 62
> checks); tsc + guards clean; in the CI ring. NOT yet deployed (sidecar + NAS
> mount + nginx are box steps). Companion iOS doc:
> [design-media-player-ios.md](design-media-player-ios.md). Scrum epics under the
> `roadmap` project.
>
> **Build deviations from this design (honest record, 2026-07-11):**
> - **The runner shells `yt-dlp` / `gallery-dl` DIRECTLY, not MeTube.** MeTube's
>   queue UI can't express the deterministic output path + `.info.json` sidecar +
>   post-download compat recode the detached runner needs. yt-dlp IS the engine
>   MeTube wraps, so the pipeline uses the engine directly (as the probe already
>   does); MeTube stays Maggie's manual/queue surface. `download_media` /
>   `sample_keyframes` are test-seamed so smokes need no yt-dlp/ffmpeg.
> - **The folder is chosen from the PRE-download NSFW verdict, then HELD to the
>   final one — and the final verdict is DISCERNED, not thresholded**
>   (owner directive 2026-08-10: *"I don't want things auto private. I want
>   classification and video review to discern contents."*). `private_to` is not
>   chosen from a verdict at all (§5.0 — the requester, always). The download
>   must know its folder before the re-check runs, so it lands where the
>   thumbnail verdict pointed; after download, frames sampled across the whole
>   item feed BOTH the MobileNet threshold AND the **VL content review**
>   (`@connectors/media_review` — per-frame `explicit / suggestive / safe` +
>   identity-free scene notes; a no-visual audio rip gets a metadata judgment
>   instead), and a real review replaces the threshold verdict in either
>   direction, with provenance (`content_rating` + `review`) on the note. The
>   filing phase then **folds the files to match** (`apply_final_cordon`,
>   `@core/media/refile`) — into `Private/` on the flag alone, OUT of it only on
>   a verdict with provenance (a review or scored frames): unlooked-at content
>   still fails closed to `Private/`, but that state is now a repairable backlog,
>   not a destiny — `rescan_media_metadata` facet:'nsfw' re-reviews it off the
>   archive itself and facet:'taxonomy' re-shelves to match (un-privating
>   requires the review provenance, always). Above ALL of it sits the owner's
>   word: facet:'move' ("put this under Music/Concerts") pins a `placement` on
>   the note that outranks every derivation — including the cordon prefix — so
>   a directed move sticks instead of being "repaired" back by the next sweep
>   (`to:'auto'` un-pins). The folder is a human/NAS-layer
>   label and `note_visible_to_caller` remains the boundary; `private_to` never
>   changes on any move.
> - **NSFW recode target is H.264 MP4 (`--recode-video mp4`) in v1**, not HEVC —
>   universal AVPlayer playback now; HEVC-via-NVENC for 4K size is a follow-up.

## 1. What Jasper asked for

> Hand Kate a URL. She auto-downloads the content at the highest quality
> *within reason*, infers its category (content style/genre, music-vs-video,
> the musician/artist, and **NSFW-vs-SFW**), and files it onto the **Serapeum
> NAS** in a deep, human-navigable folder tree — each item paired with a rich
> context `.md` carrying **extensive per-site metrics** (for YouTube: title,
> channel, upload date, views, likes, duration, resolution/codec, description,
> tags, chapters — and an equally rich, site-appropriate set for every other
> source). Then: a native iOS way to **inference-search** and **stream** the
> archive, with a smooth player (background audio, PIP).

This doc covers the **backend pipeline + serving API**. The player is its own doc.

### Decisions locked with Jasper (2026-07-11)

| Axis | Decision | Consequence |
|---|---|---|
| **Playback** | Never store in-app; always stream Serapeum→the LLM host; **direct-play** | Make the *stored* file AVPlayer-native at **download** time; the stream endpoint is pure **HTTP-range direct-play**, no per-stream transcode, no device storage |
| **NSFW** | **Dedicated classifier** ([gantman/nsfw_model](https://github.com/GantMan/nsfw_model) / `nsfwjs`) | A small purpose-built model, not the VL; frees the slow GB10 VL; LAW-#1-clean (a model judging a real image, not a blocklist) |
| **Quality** | **4K / ~20 GB cap**, ask above | `-S res:2160` + a ~20 GB ceiling; over-cap files a "want the full 4K?" ask, never silently grabs 40 GB or silently downshifts |
| **Ownership** | **Kate fronts → detached runner** | Kate's `archive_url` tool kicks a detached `MediaArchiveRunner` and returns instantly; Maggie keeps her existing MeTube/*arr/Plex tools |
| **Site scope** | **yt-dlp + gallery-dl** | Video/audio (yt-dlp, incl. NSFW tubes) **and** image galleries (gallery-dl) in v1 — dual downloader, dual metadata schema, a gallery viewer mode |
| **Auto-tag** | **Fully automatic** | No confirmation step; `uncertain` still fails-closed (uncertain ≠ confident-SFW) — it shelves under `Private/` and sets `nsfw: true`. Since 2026-07-29 the verdict no longer picks the AUDIENCE either way (§5.0) |

## 2. LAW #1 framing (read [[feedback-dynamic-not-hardcoded]] first)

The whole pipeline is **model-decides → tool-acts**, never hard-coded around the model:

- **Category / genre / music-vs-video / artist** = the **planner model's judgment** over
  *real signals* (the yt-dlp/gallery-dl info-json + the NSFW verdict), exactly like the
  Cordelia capture classifier ([classify.ts](../src/specialists/cordelia/classify.ts)).
  **No** hard-coded genre enum, **no** channel allow/deny-list, **no** domain NSFW blocklist.
- **NSFW-vs-SFW** = a **dedicated ML model** judging the *actual frames* — a model making a
  judgment, not an `if (host in badlist)` rule. It is determinism *inside a tool the runner
  chose to call*, which is the one sanctioned place for determinism.
- **The metrics are DERIVED, never authored.** Every number/date/count in the context `.md`
  is copied verbatim from the extractor's info-json. The LLM writes only the *human summary*
  and the *category judgment* — clearly separated from the measured block. This is the
  "never author a metric you didn't read" discipline the fact-critic
  ([fact_critic.ts](../src/core/fact_critic.ts)) already enforces.
- Determinism is legitimate **only inside** the probe (metadata extraction), the downloader,
  the file move, and the NSFW model. It is never a substitute for the model deciding.

**The VL capability boundary is load-bearing here** (see [[project-vl-camera-capability-envelope]]):
the vision model is *describe-not-recognize* — trust it for scene/object/activity and
large-text OCR, but it **fabricates fine identities at high confidence** (it invented five
different license plates for one frame). So: **never ask any vision model "who is this
performer?"** The artist/creator name comes **only from metadata** (uploader/title/tags/
description). The NSFW threshold model only answers *"is this sexual content?"*, and the
VL content review (2026-08-10) only ever rates *what is happening* in a frame and
describes the scene — its prompt forbids naming or identifying anyone, and its summary
carries activities, never identities.

## 3. Reuse map — build ON these

| Need | Reuse | Notes |
|---|---|---|
| yt-dlp video/audio download + queue/progress | **MeTube** — [metube.ts](../src/connectors/metube.ts) (`youtube_download` / `youtube_queue_list`) | Already NAS-graduation-aware (its `/downloads` bind-mounts to the NAS). The AVPlayer-compat + info-json policy rides MeTube's `YTDL_OPTIONS`. |
| Metadata probe (pre-download decision) | **new** — shell `yt-dlp --dump-single-json` / `gallery-dl -j` | yt-dlp + gallery-dl **standalone binaries** in the orchestrator image (like `ffmpeg`/`git` already are) |
| Image-gallery download | **new** — shell `gallery-dl` | MeTube is yt-dlp-only; galleries need gallery-dl |
| NSFW classify | **new sidecar** + connector | MobileNetV2 (gantman) or `nsfwjs`; the OCR/embeddings-sidecar pattern |
| Category inference | **planner LLM** — mirror [classify.ts](../src/specialists/cordelia/classify.ts) | JSON-out, `for_role('planner')`, `think:false` |
| Download integrity | [download_integrity.ts](../src/connectors/download_integrity.ts) `sniff_format` / `expected_kind` | Confirm the file is real media, not an error page |
| Inference-search index | [library.ts](../src/app/routes/library.ts) `index_chunks` + `embed_chunks_best_effort` (or `save_library_item`) → `retrieve_hybrid` ([retrieval.ts](../src/core/retrieval.ts)) | FTS5 + vector over the context `.md`, cordon-stamped |
| Per-user cordon | `media_cordon_for` ([cordon.ts](../src/core/media/cordon.ts)) + `note_visible_to_caller` (see [[provable-cordon-concept]]) | `private_to: <requester>` for EVERY item — see §5.0. (Was `<owner>` for NSFW / `household` for SFW until 2026-07-29.) |
| Detached runner shape | **deep_research** ([research_investigation_runner.ts](../src/specialists/kate/research_investigation_runner.ts)) + research commissions | file a job row → kick detached → advance slices → report via inbox FYI + push + SSE |
| Projected node + structured browse | **household_good** ([household_good.ts](../src/memory/schemas/household_good.ts) + its table/projector) | The `media_items` table follows this exactly |
| Media apps (Maggie, unchanged) | [arr.ts](../src/connectors/arr.ts), qBittorrent, Plex/Tautulli | Maggie keeps `manage_media` / `manage_torrents` / `read_plex_*` |

**Do NOT reinvent:** the download engine (MeTube), the RAG stack, the cordon, the detached-runner
pattern, or the projected-node pattern. This feature is *glue + two new models (probe, NSFW) + a
serving API*.

## 4. The pipeline

```
Jasper ──URL──▶ Kate.archive_url ──(files media_archive_jobs row)──▶ returns instantly
                                                                     "on it — I'll file it and let you know"
                                                                          │  (detached)
                                                                          ▼
                                                   ┌──────────  MediaArchiveRunner  ──────────┐
   1. PROBE      yt-dlp/gallery-dl --dump-json  ──▶ info-json (metrics, formats, thumbnail)
   2. NSFW       nsfw_classify(thumbnail)       ──▶ {drawings,hentai,neutral,porn,sexy} → SFW|NSFW|uncertain
   3. CATEGORIZE planner LLM(info-json + nsfw)  ──▶ {media_kind, genre, creator, title_clean, confidence}
                 then DERIVE the path            ──▶ folder_segments (@core/media/taxonomy — not a model output)
   4. QUALITY    apply policy to formats[]       ──▶ pick best ≤2160p & ≤20GB, AVPlayer-compat; over-cap → ask
   5. DOWNLOAD   MeTube (video/audio) / gallery-dl (images) ──▶ file(s) on Serapeum + .info.json + thumbnail sidecars
   6. VERIFY     sniff_format / expected_kind    ──▶ real media?  + re-run NSFW on N sampled keyframes (video)
   7. FILE       move to taxonomy path (SFW root | Private/ cordon root) + write context .md next to media
   8. INDEX      media_items row (cordon-stamped) + index_chunks + embed  ──▶ inference-searchable
   9. REPORT     inbox FYI → Kate  +  push → Jasper  +  SSE media_archived
                                                   └──────────────────────────────────────────┘
```

**Slices + resumability** (mirror the deep-research runner): each numbered step is a resumable
slice keyed on the `media_archive_jobs` row; a slice that can't finish re-runs the step. A
download is minutes-long → step 5 polls MeTube (`youtube_queue_list`) or the gallery-dl process
to completion. Kill switch `HEARTH_MEDIA_ARCHIVE=0` → the tool files the row but the runner
no-ops.

### 4.1 Probe (metadata-only, no download)

- **yt-dlp:** `yt-dlp --dump-single-json --no-playlist --no-download <url>` → the full info-json
  (see §6 for the field set). Playlists/channels: `--flat-playlist --dump-json` to enumerate,
  then per-entry (capped, with a `log()` of what was dropped — no silent truncation).
- **gallery-dl:** `gallery-dl -j <url>` → per-image metadata + the extractor's fields.
- **Dispatch:** attempt yt-dlp first (richer video path); on `Unsupported URL` fall to gallery-dl;
  if neither supports it, honest failure with `candidates` (the recovery-hint rule — an
  extractor list / "try the canonical page URL"). This dispatch is determinism *inside the tool*.
- Runs from the orchestrator image (standalone binaries; no Python runtime — yt-dlp and
  gallery-dl both ship PyInstaller single-file builds).

### 4.2 NSFW classify (the dedicated model)

`gantman/nsfw_model` (MIT) predicts five classes: **`drawings`** (SFW art/anime),
**`hentai`** (porn drawings), **`neutral`** (SFW), **`porn`** (explicit), **`sexy`** (suggestive).
We ship the light **MobileNetV2 (224×224)** variant behind a tiny FastAPI/`nsfwjs` **sidecar**
(the OCR-sidecar idiom, CPU-only — no GPU needed, so the Ada/Blackwell/GB10 stay free):

```
POST {HEARTH_NSFW_URL}/classify  (image bytes)  ──▶  {drawings, hentai, neutral, porn, sexy}
```

- Connector `nsfw_classify` in `src/connectors/nsfw.ts`, gated (internal to the runner; the
  runner calls `.execute()` bypassing capability gating like the commission/research runners).
- **Aggregation → verdict** (pure, tunable — *not* a magic constant in a hot path; a configured
  env/YAML): probe the thumbnail first (cheap gate), then after download sample **N keyframes**
  (ffmpeg at even % marks) for a video and score each. `nsfw_score = max_over_frames(porn +
  hentai + w·sexy)`.
  - `nsfw_score ≥ HEARTH_NSFW_HIGH` → **NSFW**.
  - `nsfw_score ≤ HEARTH_NSFW_LOW` → **SFW**.
  - between → **uncertain**, treated as NSFW everywhere (uncertain ≠ confident-SFW), no
    confirmation step (Jasper: fully automatic).
  - What the verdict decides: the storage folder (`Private/…` for anything not confirmed SFW)
    and the `nsfw` flag on the note + row (which drives the clients' local unlock gate — a
    per-session paint gate, not an eligibility rule; see §5.1). What it does
    **NOT** decide is who can see the item — that is the requester, always (**§5.0**). This is
    the 2026-07-29 change and it is the reason a wrong verdict is no longer an exposure.
- ~~Audio-only (music) has no frames → **SFW by default**~~ — **RETRACTED 2026-07-29; this line
  was the spec's one fail-open.** The invariant is now: **`sfw` may only ever be asserted from an
  actual classifier result**, so `frames_scored: 0` always means *unclassified* and fails closed
  to `uncertain` (→ `Private/` + `nsfw: true`). Nothing infers "safe" from metadata. The concrete failure:
  `is_audio_only` is derived from the extractor's format list, and a generic/HTML5-embed
  extractor emits `vcodec: null` — so the flag read TRUE for a plain MP4 **video**, and the
  `audio_only → sfw` early return filed an explicit clip **household-visible**. The pre-gate now
  classifies **any** thumbnail that exists regardless of `audio_only` (real music carries cover
  art, so music still gets a real verdict); `is_audio_only` is a **download hint only** and can
  never waive classification. The post-download keyframe check keeps its `audio_only` skip — it
  runs on the downloaded m4a, which genuinely has no frames, and it only ever returns the
  *pre*-verdict rather than asserting one. Remediation for rows already filed under the old rule:
  `rescan_media_metadata` with `facet: 'nsfw'`.
- **Fail-open on the model, fail-CLOSED on the tag:** if the sidecar is down/unreachable the
  item is `uncertain` — never guessed SFW — so it shelves under `Private/`, projects `nsfw: true`,
  and the job notes the degradation. A missed NSFW presented as safe is the unacceptable failure;
  not-confirmed-safe-on-doubt is the safe default. (Its AUDIENCE is the requester either way — a
  sidecar outage no longer changes who sees it, §5.0.)

### 4.3 Categorize (the planner model)

A single planner-role LLM call (mirrors [classify.ts](../src/specialists/cordelia/classify.ts)) —
`for_role('planner')`, `temperature: 0.2`, `think:false`, strict JSON-out:

```jsonc
{
  "media_kind": "music_video | song | album | live_set | talk | interview | lecture |
                 film | episode | trailer | clip | tutorial | gameplay | podcast |
                 image_gallery | photoset | other",
  "genre": "free text the model reads from tags/description (e.g. 'synthwave', 'true-crime')",
  "creator": { "name": "<from metadata only>", "channel": "<uploader>", "from_metadata": true },
  "title_clean": "human-friendly title (like the library titleizer)",
  "mood_tags": ["..."],
  "confidence": 0.0-1.0,
  "rationale": "one sentence"
}
```

- The model is handed the info-json **plus the NSFW verdict** as *context for the classification*
  (an explicit clip is rarely a 'tutorial') — it never *decides* NSFW (the classifier's job) and it
  **never authors the folder path**.
- `creator.name` comes from metadata; the prompt forbids inventing a name (and there's no image
  passed for identity — the NSFW model saw the pixels, the category model sees only text).
- No hard-coded genre list; `media_kind` is the load-bearing enum the taxonomy derives from, and
  `genre`/`mood_tags` are free text the model reads from real signals.

**The path is DERIVED, not generated (2026-07-29).** Until then the prompt asked for
`folder_segments` with loose examples and separately told the model to make the first segment
`Private` for a non-SFW verdict — which `apply_nsfw_cordon` already does deterministically. Both
halves were defects, and the owner found them: `Private/` held `PornHub`, `Video` **and** `Videos`
side by side. Free-text segments grew the plural; the redundant Private instruction made an obedient
model spend its KIND slot, so the next value it emitted landed in the kind position and a *site*
became a top-level folder. See the header of [taxonomy.ts](../src/core/media/taxonomy.ts) for the
full diagnosis and [`smoke:media-taxonomy`](../scripts/smoke-media-taxonomy.ts) for the pinned
before→after table of the **nine** live items. That table is a SNAPSHOT of a growing archive — a
tenth item can land at any time, so re-derive the dry run against live data immediately before any
`apply: true` rather than trusting the pinned count.

The `media_kind` the path is derived from is the **measurement-reconciled** one:
[`media_measured_kind`](../src/core/media/types.ts) is the single producer of that rule. It used to be
split in half — the classify phase only upgraded a measured gallery to `image_gallery`, while
`build_media_note` *also* stripped a spurious gallery label off a non-gallery down to `other` — so a
planner that called a YouTube video an `image_gallery` wrote the bytes into `Images/…` while its own
note said `other`, and the repair sweep then reported every freshly archived item of that shape as
off-schema forever. The path is still chosen pre-download and the note written post-download, so the
agreement is argued rather than assumed: the rule's only evidence reduces to `probe.source`, which is
measured once and cannot change. That argument is what a new field on `MediaGalleryEvidence` has to
preserve — a signal only the download can measure would mean moving the filing decision after the
download, not re-splitting the rule.

### 4.4 Quality policy ("highest quality within reason")

Config-driven (env + a hot-reloaded `config/media-quality.yaml`), **per-request overridable**
(Jasper: "get the 4K"). Defaults from the decision: **≤2160p (4K), ≤~20 GB**.

The AVPlayer-compat reconciliation (this is what makes "direct-play, never transcode at stream
time" work):

- **≤1080p:** prefer **H.264 (avc1) + AAC**, remux to **MP4** (`--remux-video mp4
  --merge-output-format mp4`). YouTube serves avc1 at ≤1080p, so this is a **cheap remux**, no
  re-encode.
- **>1080p (1440p/4K):** YouTube offers these **only in VP9/AV1**, which AVPlayer can't play. So
  **recode to HEVC (hvc1) MP4 at download time** — a one-time background transcode (NVENC on a GPU
  slice if we want it fast, else CPU; it's not latency-sensitive). HEVC-in-MP4 is AVPlayer-native
  and reasonably sized. This is the *only* place a real re-encode happens, and it's paid once, in
  the background — never per stream.
- **Audio / music:** best audio → **AAC in M4A** (AVPlayer-native; Opus-in-webm is not, so we
  transcode audio to AAC when the source is Opus).
- **Over-cap:** if the best rep within 4K exceeds ~20 GB, download the **capped** rep AND file a
  `recommendation`/ask proposal to Jasper ("the full 4K is ~40 GB — want it?"). Never silently grab
  40 GB; never silently downgrade without saying so (`log()` the choice — the no-silent-caps rule).
- The policy reads the **real `formats[]`** from the probe and picks — the model/heuristic sees
  actual sizes/codecs, never a guess.
- **The cap is a preference, never a precondition.** Every video selector
  [`decide_quality`](../src/connectors/media_quality.ts) emits must be *total* — it may never match
  zero formats, because yt-dlp answers that with exit 1 "Requested format is not available" and the
  runner then burns all three retries on a deterministic failure. Two clauses hold that line:
  - `height<=?N` — **the `?` is load-bearing.** yt-dlp's numeric filters *exclude* a format whose
    field is unknown unless the operator carries that suffix. A generic / HTML5-embed page (no
    extractor of its own) yields exactly one format with no height, no width and no codecs —
    `0  mp4  unknown | https | unknown unknown` — so the unsuffixed `[height<=2160]` matched nothing
    and killed the download of a plain, directly fetchable MP4 (sickjunk.com, jobs
    `ma_ry9gxgxvaz57` + `ma_cchh1m7avb6e`, 2026-08-11). A height nobody measured cannot be over the
    cap; filtering it out asserts the opposite.
  - a terminal **uncapped** clause — every rep measured and every one over the cap ⇒ take the best
    rather than fail (the same outcome `decide_quality`'s `fallback` branch already reaches when the
    *probe* reported heights; the clause makes it hold when the probe reported none).
- **Failure carries its own diagnosis.** A download that dies on format selection records the
  selector we asked for *and* the `--list-formats` table yt-dlp actually had, and every other failure
  records yt-dlp's `ERROR:` line **whole** (it used to be a fixed 300-char head slice, which cut the
  sentence carrying the answer). That is what `media_archive_status(diagnose:true)` reads to
  classify `format-selection` apart from a block or a gate — see §8.
  On top of the stored record, `diagnose` asks **`yt-dlp -F` live** (`formats_now`). Deliberate, and
  not redundant: a stored error is a record of one moment, whereas the question Kate is actually
  answering is *what is on that URL now* — and for every row that failed **before 2026-08-11** there
  is no stored table at all, which is exactly the population she was asked to go diagnose. One
  producer for both readers: `list_formats` in
  [media_download.ts](../src/connectors/media_download.ts) (metadata-only, downloads no media,
  fail-soft to `null`, test-seamed).
- Pinned by [`smoke:media-quality`](../scripts/smoke-media-quality.ts) against the live captured
  format shape. `decide_quality` had **no test at all** before 2026-08-11 — which is how a selector
  that could match zero formats shipped and stayed shipped.

For MeTube, most of this rides **`YTDL_OPTIONS`** globally
(`--remux-video mp4 -S 'res:2160,vcodec:h264,acodec:aac' --write-info-json --write-thumbnail
--write-description`), with per-item quality via the tool's `quality`/`format` args (extend the
enum to include `2160`). The HEVC-recode-for->1080p case is a post-download ffmpeg step the runner
owns (MeTube's simple enum can't express codec-conditional recode).

### 4.5 File onto Serapeum + write the context .md

- **Roots** (the cordon's storage layer):
  - **SFW →** `/mnt/nas2/Archive/` (openly navigable on the NAS)
  - **NSFW / uncertain →** `/mnt/nas2/Archive/Private/` (the SFW browse API never lists
    `Private`; both clients render the `Private/` subtree padlocked and paint nothing inside it
    until the viewer passes a step-up — for whoever is looking, at any tier). The segment name is
    `MEDIA_PRIVATE_SEGMENT` in [taxonomy.ts](../src/core/media/taxonomy.ts) and `Private/` is what
    the live NAS carries — earlier drafts of this doc said `_private/`, which was never the on-disk
    name.

  This is the STORAGE axis only — a human/NAS-layer label, not the boundary, and **not** "owner-only":
  who may READ an item is §5.0 (its requester), independent of which root it sits under.
- **Canonical taxonomy** = `media_folder_segments()` ([taxonomy.ts](../src/core/media/taxonomy.ts)),
  always **exactly three** segments under the root plus the cordon's optional `Private/` prefix.
  Two shapes, and the asymmetry is a rule: the **site segment exists exactly where the creator's
  identity is platform-scoped**, because a channel handle is only unique inside its platform while
  an artist is a global identity that shouldn't be fragmented across the sites it was pulled from.

  | top level | shape | why |
  |---|---|---|
  | `Music` | `Music/<Artist>/<Album-or-Year>` | creator-first; the Plex/Jellyfin shape, year as the standard album stand-in |
  | `Audio` | `Audio/<Show>/<Album-or-Year>` | a podcast show is a global identity too |
  | `Video` | `Video/<Site>/<Creator>` | `jawed` means nothing without `YouTube` |
  | `Talks` | `Talks/<Site>/<Speaker>` | site-first: no probe field carries a series or venue |
  | `Images` | `Images/<Site>/<Uploader>` | as Video |
  | `Other` | `Other/<Site>/<Creator>` | the honest "the model couldn't say" |

  A missing slot is FILLED with `Unknown`, never collapsed — dropping an empty segment is the
  left-shift that once put a title in the creator position. A **title is never a folder segment**:
  it names an item, not a group of them. Human-navigable and Obsidian/Plex-openable.
- **Re-filing an existing archive**: `rescan_media_metadata` `facet:'taxonomy'` reports every
  off-schema item (`is_off_schema`) and moves it on `apply:true` — dry run by default, idempotent,
  prunes emptied directories, and can never widen a cordon. It is the storage-axis sibling of
  `facet:'nsfw'` (§5.2), which repairs the audience instead — orthogonal passes.
- Each item ships **three sidecars next to the media** (yt-dlp writes them; gallery-dl similarly):
  the `.info.json` (authoritative metrics), the thumbnail/poster, the `.description`.
- The **context `.md`** (see §6) is written next to the media **and** indexed (§4.6).

> **Threat-model note** (see [[provable-cordon-concept]]): the SMB NAS files are readable by
> anyone with SMB access — but that's the *owner-trusted box*, which is deliberately in-trust.
> The enforced cordon is at the **index + surface** layers (below), which is where the AI/app
> surfaces and any non-owner session are gated. `Private/` on disk is defense-in-depth + human
> hygiene, not the security boundary.

### 4.6 Index for inference-search

Two projections, both cordon-stamped:

1. **`media_items` table** (structured browse/metrics) — the **projected-node pattern**
   ([household_good.ts](../src/memory/schemas/household_good.ts)): `IF NOT EXISTS`, additive, no
   `SCHEMA_VERSION` bump; columns `id, media_kind, title, creator, genre, nas_path, duration_s,
   width, height, vcodec, filesize, source_url, extractor, nsfw (bool), private_to, metrics_json,
   context_note_path, created_at`. `media_cordon_for(requested_by)` → `private_to =
   <requester>` for every item (§5.0). Cordoned reads via `note_visible_to_caller`.
2. **RAG index of the context `.md`** — `index_chunks` + `embed_chunks_best_effort`
   ([library.ts](../src/app/routes/library.ts)) so `retrieve_hybrid` (FTS5 + vector) can do
   *semantic* "inference search" over the rich description/tags/summary. Cordon rides the note's
   `private_to`, so an NSFW `.md` never enters shared RAG/briefs/household search — exactly the
   existing behavior.

Browse reads `media_items`; inference-search reads `retrieve_hybrid` then joins to `media_items`
for the card; item-detail joins both.

### 4.7 Report back

Inbox FYI → Kate (she says "filed *X* under *Music/…*"), `push_text` → Jasper (quiet-hours gated),
SSE `media_archived` (the iOS Archive tab live-updates). Mirrors deep-research's report-back.

## 5. The NSFW cordon — three layers (the load-bearing privacy design)

### 5.0 Who can see it: the REQUESTER, always (owner directive 2026-07-29)

> *"Archive content should be specific to user that has requested it be downloaded."*

`private_to` = the requester of the archive job, SFW or not, whatever their tier. One
definition, in [`@core/media/cordon`](../src/core/media/cordon.ts), read by both the runner's
filing phase and the `rescan_media_metadata` facet:'nsfw' repair pass. **Nothing archived is
household-scoped any more, and there is no owner god-view of a member's item.**

Why the SFW → `household` default had to go, in one sentence: it put the NSFW classifier on the
critical path of an *exposure*, so one fabricated `sfw` verdict was enough to put explicit
content in front of every household member — which is what happened to `mi_arxnmccn` on
2026-07-15. Under the silo a wrong verdict costs a mis-shelved folder, not an exposure.

Consequences, stated rather than discovered later:

- **Browse/recent is legitimately empty** for anyone who has archived nothing. The web client's
  empty state says so instead of implying the archive is empty.
- **`household_heatmap`** (item detail) is now one viewer's re-watch curve, since only that
  viewer can see the row or POST progress for it. The wire name is kept for client compatibility.
- **User-less reads see no archive at all.** `note_visible_to_caller` never shows a
  `<user_id>`-scoped note to a caller with no `user_id`, so deliberation / scheduler / brief
  passes cannot read archive notes — only a real chat turn by that user can. Fail-closed and
  consistent with the directive; whether Kate's background reasoning should get an exception is
  an **open owner decision**, not something this doc assumes.
- ~~**There is no share affordance.** Nothing in the codebase can broaden a cordon~~ —
  **SUPERSEDED 2026-07-29 (§5.3).** Named-grant sharing is the ONE way an item reaches a second
  person, and it is the ONLY thing in the codebase that broadens a cordon. Everything else in this
  bullet still holds: `archive_url` files the cordon, `rescan_media_metadata` is tighten-only by
  construction, and no other route exposes it. The cordon is no longer *absolute* — but it is
  still the default and the floor: broadening happens one named user, one item, one owner-signed
  write at a time, never by tier and never as a side effect.

| Layer | SFW | NSFW / uncertain |
|---|---|---|
| **Audience** (`private_to`) | `<requester>` | `<requester>` — the verdict does not change this |
| **Storage** (folder) | `Archive/…` | `Archive/Private/…` (the SFW browse never lists it) |
| **Index** (RAG scope) | `private_to: <requester>` — that user's scoped RAG only; **never** shared RAG / briefs / household search | same |
| **Surface** (API + Kate) | the requester's reads only, **plus anyone explicitly named in `shared_with`** (§5.3); 404-shape for everyone else | same, **plus** a client-side PAINT gate: `nsfw: true` items and the `Private/` subtree render only after a per-session step-up — whoever is looking, own PIN, any tier |

### 5.1 Enforcement

- Every `/api/media/*` read — browse, search, item, thumb, **stream**, progress — resolves the
  row through `get_media_item`/`query_media_items`, i.e. `note_visible_to_caller` on the note's
  `private_to`. That single check is the boundary: a caller who isn't the item's requester gets
  the 404-shape, so there is nothing left for a per-endpoint tier check to add. (An earlier draft
  of this doc specified an extra `user.tier === 'owner'` hard-check on `stream` for `Private/`
  files; it was never implemented and is no longer the right shape — the folder is not the
  audience, §5.0 is.) The client-side gate on `nsfw: true` / `Private/` is a PAINT gate, never the
  boundary and never an eligibility rule: it withholds explicit content from the screen until
  whoever is sitting there re-authenticates (web PIN via `/api/auth/step_up`, iOS Face ID), and it
  is user-agnostic — a member or friend holding their own explicit item unlocks it with their OWN
  PIN. The web client's former owner-tier variant of this gate was removed 2026-07-29: with every
  item siloed to its requester it left a member locked out of their own archive with no key, while
  iOS (which never had the rule) rendered the same item. Withheld content is reported, with the
  unlock path, rather than silently dropped.

### 5.2 Correction after the fact

- **Fully automatic** (Jasper): no confirmation gate; `uncertain` shelves under `Private/` and
  sets `nsfw: true` automatically.
- ~~A correction affordance (`re-tag / move to household`) lets the owner fix a
  misclassification after the fact~~ — **NEVER BUILT, and as of 2026-07-29 half of it is
  contradicted by §5.0** (there is no household bucket to move to). What exists is
  `rescan_media_metadata` facet:'nsfw', which is deliberately **tighten-only**: it re-runs the
  classifier off the on-disk thumbnail and re-files household leftovers onto their requester.
  Re-tagging an item *less* private still has **no mechanism at all** — don't cite this bullet as
  though that affordance exists. Reaching a second *person*, however, now does: **named-grant
  sharing, §5.3**, which is deliberately not the same thing as re-tagging — it leaves `private_to`
  exactly where it is and adds named users beside it. The repair sweep and a grant are orthogonal
  by construction: the facet writes a `{private_to}`-only patch and `upsert_note` shallow-merges,
  so a repair can neither drop a live grant nor resurrect a revoked one (pinned in
  `smoke:media-sharing`).
- A sweep (`facet: 'nsfw'` with no `item`) is **bounded work per run**, not the whole archive in one
  turn: every targeted item is a classifier HTTP round trip plus an `upsert_note`, and the tool runs
  in-turn. `sweep_bounds()` caps the batch (`HEARTH_MEDIA_RESCAN_MAX`, default 25) and stops taking
  new items past a time budget (`HEARTH_MEDIA_RESCAN_BUDGET_MS`, default 20 s), always doing at
  least one. The remainder comes back as `deferred` on the result *and* in Kate's message + the
  audit row — never silently truncated, because a half-finished audit reported as finished is worse
  than a slow one. The target set drains, so re-running resumes.
- The sibling repair, `facet: 'taxonomy'` (§4.5), is a different axis and touches **no** cordon: it
  moves an item's FILES to their canonical folder, carrying the item's existing `Private/` prefix
  forward rather than re-judging it, so it can never change who may see anything. An item can need
  one repair, the other, or both.
- Audit every archival + every cordon-crossing read (the HMAC-chained ledger,
  [[provable-cordon-concept]]).

### 5.3 Sharing — the one way an item reaches a second person (2026-07-29)

§5.0 silos every item to its requester. That is the default and the floor, but it is no longer
*absolute*: an item's owner can name individual users who may read it. **Visibility is ONE rule —
the `private_to` cordon OR an explicit named grant** — and it lives in one function pair,
`note_visible_to_caller` / `note_frontmatter_visible_to_caller`
([private_to.ts](../src/memory/private_to.ts)).

- **The grant is a frontmatter field on the note:** `shared_with: [<user_id>, …]`, plus a
  `shared_at: {<user_id>: <iso>}` stamp map. Per-note and per-user. It never widens a tier, never
  covers a sibling note, and a user-less system caller (deliberation, scheduler) can never match
  one. Only the note's own owner may write it, only onto their own item.
- **Every read path reaches the rule through one of two `MemoryClient` seams** —
  `note_path_visible_to_caller` (live note: single-item reads, the RAG chunk gate, both vault
  searches, `read_note`) or `note_row_visible_to_caller` (candidate-then-confirm: the list reads).
  Spelling the rule a third time is the bug class: three paths once passed only `private_to`, which
  made a shared item *discoverable but unreadable* by the person it was shared with —
  `search_library` returned its chunk and `read_note` on that very path answered "not found… Try
  search_library".
- **A grant may lag; a revocation may not.** List reads use the projection as a free candidate
  filter and confirm the claimed grant against the live note, so an unshare bites instantly even
  with the ingestor down, while a new grant appears in browse/recent on the next reproject.
  Single-item reads pay neither latency.
- **The server owns eligibility, state and copy** (owner directive: *"start consolidating UI
  between WebGUI and iOS so you're not duplicating work"*). `GET /api/media/item/:id` carries a
  `sharing` object; `POST /api/media/item/:id/share` `{user_ids: [...]}` returns the same object
  bare. Declarative set replacement — `{"user_ids": []}` unshares. `targets` is the server's
  eligible pool and the only ids the verb accepts; `hint` / `empty_hint` / `state_label` are
  server-composed strings the clients render verbatim. A caller who may not share gets
  `{can_share: false}` and nothing else — a recipient never learns who else holds a grant, and a
  friend is never handed the household roster (they may share UP to the owner only).
- **`media_shared` SSE is delivered to prior ∪ new**, with the audience stripped from the wire.
  The revoked user is the subscriber who most needs it: their Archive still shows an item they no
  longer have, and nothing else tells them to refetch.
- Proof: `bun run smoke:media-sharing` — the read model, the no-god-view cases, revocation
  authoritative on every surface with a deliberately stale projection, the search→read round trip,
  the repair×share interaction, and the rosterless degradation.

## 6. Metric schemas (the context .md)

The `.md` has a **measured block** (DERIVED, verbatim from the info-json) and a **derived-judgment
block** (the model's category call, clearly separated). YouTube is fully specified; every other
site uses the **general template** — *emit every field the extractor actually returned*, which is
LAW-#1-aligned (the schema is driven by what the site gave us, not a hard-coded per-site enum).

### 6.1 YouTube — fully specified

```yaml
---
type: media_item
id: m_<ulid>
media_kind: music_video        # ← model judgment (§4.3)
nsfw: false                    # ← classifier verdict (§4.2)
private_to: jasper              # ← the REQUESTER, always (§5.0); never 'household'
# ── measured (verbatim from yt-dlp .info.json — NEVER model-authored) ──
source_url: https://www.youtube.com/watch?v=...
extractor: youtube
title: "..."
channel: "..."                 # uploader
channel_id: UC...
channel_url: https://...
upload_date: 2026-05-01        # yyyymmdd → ISO
duration_s: 372
view_count: 1234567
like_count: 45678
comment_count: 890
age_limit: 0
availability: public
width: 3840
height: 2160
fps: 60
vcodec: hvc1                   # after our compat recode
acodec: mp4a.40.2
container: mp4
filesize_bytes: 1893746271
resolution_label: "2160p"
language: en
tags: ["...", "..."]
categories: ["Music"]
chapters:                      # ← powers the player's chapter markers
  - { start_s: 0,   title: "Intro" }
  - { start_s: 45,  title: "Verse 1" }
thumbnail_path: _sidecars/m_<ulid>.jpg
description_path: _sidecars/m_<ulid>.description
nas_path: /Archive/Video/YouTube/<Channel>/<Title>/<file>.mp4
# ── derived judgment (model — separated from measured) ──
creator: "<artist, from metadata>"
genre: "synthwave"
mood_tags: ["nocturnal", "driving"]
archived_at: 2026-07-11T...Z
quality_policy: "≤2160p / ≤20GB; recoded VP9→HEVC"
---

## Summary
<1–2 sentence human summary — model prose, grounded in the description. No invented facts.>

## Description (verbatim)
<the video description, from the .description sidecar>
```

### 6.2 General template (every other yt-dlp site)

yt-dlp's info-json is a **union across ~1800 extractors** — a common core plus site-specific
extras. The `.md` **emits the core as typed fields and every remaining present field as a
`metrics:` passthrough map** — never fabricating a field that's absent.

- **Common core** (present on ~all): `id, title, uploader/uploader_id, duration, webpage_url,
  ext, format/format_id, vcodec/acodec, width/height/fps, filesize(_approx), thumbnail,
  description, tags, upload_date/timestamp, extractor_key, age_limit, view_count`.
- **Site extras** (typed where common, passthrough otherwise): SoundCloud → `genre, license,
  playback_count, repost_count`; Vimeo → `uploader_url, license`; Twitch → `is_live, was_live`;
  Bandcamp → `track, album, artist, release_date`; a tube site → `tags/categories` (often the
  "performers as tags" — captured as **tags**, never asserted as identity). The rule: **typed core
  + `metrics: {<everything else present>}`**.

### 6.3 gallery-dl (image galleries — Phase 2)

gallery-dl emits **per-image** metadata; the item is a *set*. The `.md` carries a gallery-level
block + a per-image list:

```yaml
media_kind: image_gallery
image_count: 42
# the per-item DIRECTORY (canonical 3 segments + the cordon prefix), not a file
nas_path: /Archive/Private/Images/<Site>/<Uploader>/<id>/
images:
  - { idx: 1, file: 001.jpg, width: 2000, height: 3000, metrics: { <extractor fields> } }
  # extractor-specific: booru → tags/rating/score/artist(from metadata); reddit → subreddit/author; etc.
site_metrics: { <gallery-level extractor fields> }
```

The player renders galleries as a **paged image viewer**, not AVPlayer (iOS doc §Gallery mode).

## 7. Serving / streaming API — `/api/media/*` (new top-level namespace)

Every row's cordon is the SAME check — `note_visible_to_caller` on the row's `private_to` **OR an
explicit `shared_with` named grant** (§5.3), i.e. the requester plus anyone they named. The
404-shape, never a 403. "Requester-filtered" below is shorthand for that one rule; the sole
exception is `POST /item/:id/share` itself, where visible-but-not-yours is a 403 (the caller already
knows the item exists).

| Route | Purpose | Cordon |
|---|---|---|
| `GET /api/media/browse?path=` | Walk the canonical taxonomy (folders + items) | requester-filtered (legitimately empty for a caller who archived nothing) |
| `GET /api/media/search?q=` | **Inference search** — `retrieve_hybrid` over context `.md`, join `media_items` | requester-filtered (`note_visible_to_caller`) |
| `GET /api/media/item/:id` | Context `.md` + metrics + stream URL + poster + chapters (+ image list for galleries) + the `sharing` read model (§5.3) | 404-shape for a non-requester |
| `POST /api/media/item/:id/share` | **Named-grant sharing** (§5.3) — `{user_ids: [...]}` set replacement; returns the bare `sharing` object; emits `media_shared` | 404-shape if invisible; **403** if visible but not the caller's to share; 503 with no roster |
| `GET /api/media/stream/:id` | **HTTP-range (206) direct-play** from the NAS | 404-shape for a non-requester, before serving a byte |
| `GET /api/media/thumb/:id` | Poster/thumbnail bytes (cache-control + etag, like `/api/cordelia/thumbnail/:id`) | 404-shape for a non-requester |
| `GET /api/media/image/:id/:idx` | Gallery image bytes (Phase 2) | 404-shape for a non-requester |
| `POST /api/media/progress/:id` | Playback position → the re-watch heat buckets | 404-shape for a non-requester (so the curve is that one viewer's) |

**Range serving** (net-new — there is **no** 206 handler in the repo today; the library
attachment route reads whole files into memory, wrong for a 4 GB video). Bun makes it a few
lines — `Bun.file(path)` + `.slice(start, end)` as the Response body, with:

```
206 Partial Content
Accept-Ranges: bytes
Content-Range: bytes <start>-<end>/<total>
Content-Length: <end-start+1>
Content-Type: video/mp4   # sniffed
```

Parse the `Range: bytes=start-end` request header; a range-less GET returns `200` + `Accept-Ranges:
bytes` so the client knows to range. AVPlayer drives seek/progressive playback entirely off this.
No transcode here — the file is already AVPlayer-native from §4.4.

**Path safety:** every route clamps the resolved path under `/data/archive` (the mounted
`Archive` root) and rejects `..`/absolute escapes — the same defense-in-depth the library
attachment route already does.

## 8. Tools & capabilities

- **New capability `archive_media`** (config/capabilities.yaml; Kate-only) → the **all-encompassing**
  `archive_url` tool (Jasper's [[feedback-all-encompassing-tools]] rule — ONE comprehensive tool,
  named optional slots, never narrow siblings):

  ```
  archive_url(url, *, quality_override?, note?, audio_only?)
  ```

  Two slots that earlier drafts of this doc listed are gone, for independent reasons: `folder_hint`
  because the model no longer authors the path at all (§4.3 — the taxonomy derives it), and
  `force_owner_only` per the retraction below. Neither has ever existed in
  [archive_url.ts](../src/specialists/kate/tools/archive_url.ts)'s schema since 2026-07-29.

  It files a `media_archive_jobs` row and kicks the detached runner, returning immediately with a
  `next_action` that steers Kate to say "on it — I'll file it and let you know" (the deep-research
  handoff idiom, so she doesn't try to archive in-turn). `quality_override` carries "get the 4K".

  ~~`force_owner_only` lets Jasper pre-cordon ("archive this privately")~~ — **RETIRED 2026-07-29**,
  with the `force_owner_only` column on `media_archive_jobs`. §5.0 made the cordon unconditional,
  so the slot promised the LLM a privacy effect it no longer had; what it *did* still reach was the
  `media_archived` event's `nsfw` flag and nothing else — not the cordon, not the note's `nsfw`
  frontmatter, not the `Private/` folder — which made that event disagree with the note and row it
  projects. It was NOT re-founded on the explicit axis ("file under `Private/` regardless of the
  classifier") because a hand-forced flag is a verdict from no evidence: precisely what
  `rescan_media_metadata` facet:'nsfw' treats as a fabrication (`frames_scored: 0`) and would
  re-sweep and overwrite. Giving the owner that lever honestly means adding forced-verdict
  provenance to the note and teaching the sweep to respect it — a feature, not a description fix,
  and unasked-for. The `nsfw` flag now has ONE derivation, `nsfw_flag_for(verdict)` in
  [nsfw.ts](../src/connectors/nsfw.ts), feeding the three FLAG surfaces (note frontmatter, projected
  row, SSE event) — all three read the same final verdict, so they cannot disagree about an item.
  The storage folder runs the same rule one moment earlier — decided off the pre-download
  thumbnail verdict — and since 2026-08-10 is HELD to the final verdict by the filing phase's
  `Private/` fold (`apply_final_cordon`; see the deviation note at the top of this doc), so it
  agrees with the flag on every fresh item (folder placement remains a NAS/human label, the
  audience is §5.0). `requester_tier` was
  retired in the same pass — the cordon stopped consulting tier, which left that column with no
  reader at all.
- **Runner-internal** (not LLM tools; the runner calls `.execute()` bypassing gating, like the
  research/commission runners): `media_probe` (yt-dlp/gallery-dl dump-json), the gallery-dl
  downloader, `nsfw_classify` (sidecar connector), the category planner call, `index_chunks`/embed.
- **`archive_media_sweep`** background job (Kate) — crash-recovery for stuck jobs (the
  research-sweep idiom).
- **Maggie unchanged** — keeps `manage_youtube_downloads` / `manage_torrents` / `manage_media` /
  `read_plex_*` for her manual media work. Kate fronts the *archival* surface; Maggie owns
  *acquisition/library* management.
- **Capability-visibility scan** (mandatory, per the private dev log): after granting `archive_media`,
  confirm it's in Kate's `granted:` and that `archive_url` is reachable on her chat surface
  (`dynamic_tools: true` surfaces it from the catalog on a media-shaped turn; add a
  `chat_addendum` pointer so she reaches for it on a bare URL).

## 9. Smokes (self-contained, per the CI ring)

- **`smoke:media-archive`** — fixture info-json (a canned YouTube + a canned tube-site + a
  gallery-dl set) + **mock** NSFW classifier + **scripted** planner LLM; asserts: probe parse →
  category JSON → NSFW verdict mapping (SFW/NSFW/**uncertain→`Private/` + `nsfw:true`**) → folder
  taxonomy → context `.md` schema (measured verbatim, judgment separated, **no fabricated
  metric**) → cordon stamping (`private_to` = the requester, §5.0, incl. the classifier-can't-
  waive-it invariant) → `media_items` row → `index_chunks`/embed called → job lifecycle (slice
  resumability) → kill switch `HEARTH_MEDIA_ARCHIVE=0`; plus `rescan_media_metadata`
  facet:'nsfw' (the remediation sweep, both re-file reasons + its tier gate),
  `parse_classify_response` (sidecar shape drift) and the cordon rule itself. Temp vault/db, no
  network/NAS.
- **`smoke:media-serving`** — mounts `/api/media` in-process (temp archive dir, fake auth):
  **range/206** (Content-Range math, range-less→200+Accept-Ranges, path-escape 400), the **cordon
  matrix** (a caller who isn't the requester gets 404-shape on the stream/item, never 403-leak;
  unauth 401), browse/search shape, thumb etag.
- **`smoke:media-taxonomy`** — the canonical deriver + the re-filing migration (temp vault/db +
  a temp archive root with real files): one case per top level, **every** vocabulary alias, totality
  over `MEDIA_KINDS`, the missing-creator placeholder (no left-shift), the site slot (casing,
  sub-extractors, generic→page host), a hostile planner whose `folder_segments` + Private
  instruction are both ignored, the `Private/` prefix applied exactly once, and — pinned as
  fixtures — the **eight real live `nas_path`s** mapping to their canonical targets. Then the tool:
  dry-run default, apply, idempotence, friend-tier refusal, the two-items-one-directory case, a
  name clash that is reported rather than overwritten, and directory pruning.
- **`smoke:media-quality`** — `decide_quality`, which had **zero** coverage until 2026-08-11 (that
  gap is the whole reason a selector able to match no formats survived). Pure, plus one stubbed
  `yt-dlp` shell script: the unknown-height regression pinned against the **live captured**
  `formats[]` of the failing job, the totality rule (every emitted selector ends in an uncapped
  clause), that a *known* height still binds the cap, override parsing, recode/remux thresholds,
  the fail-soft empty probe, the over-size flag — and the download path's diagnostics (selector +
  offered-format table on a format failure; the whole `ERROR:` line and **no** extra
  `--list-formats` call on any other). Then `media_archive_status(diagnose:true)`, also previously
  untested: the `format-selection` bucket over both a rich row and a **legacy** row whose stored
  selector is lost (the live `formats_now` read is its only evidence), the one-line report under a
  multi-line error, and the age-gate detector refusing to fire on "page"/"image"/"storage"/"message"
  while still firing on a real members-only/sign-in gate.
- Add all four to `CANDIDATES` in [ci-ring.ts](../scripts/ci-ring.ts) so they gate merges once green.

## 10. Deploy / ops notes

- **Orchestrator image** (Dockerfile → `docker compose up -d --build`, not just restart): add the
  **yt-dlp** + **gallery-dl** standalone binaries (+ `ffmpeg` already present for the keyframe
  sampling + HEVC recode).
- **NSFW sidecar**: a new compose service (MobileNetV2 / `nsfwjs`, CPU-only), `HEARTH_NSFW_URL`
  in `hearth.env`. Mirrors the OCR/embeddings sidecars.
- **NAS mount**: bind `/mnt/nas2/Archive` into the orchestrator container (rw for the `.md`
  sidecar + gallery-dl writes; ro suffices for streaming). MeTube's downloads root → the same
  `Archive` tree; set MeTube **`YTDL_OPTIONS`** for the compat + info-json policy (§4.4).
- **nginx**: add `media` to the `/api/(...)` alternation in `/docker/nginx/locations.conf` (else
  `/api/media/*` falls through to Home Assistant's catch-all and 404s) — `docker exec nginx nginx
  -t` then **`docker restart nginx`** (single-file bind mount; a reload re-reads the stale inode).
- **Host**: don't hard-code `your-llm-host.local` — the box is `<your-llm-host-ip>` / the Tailscale FQDN; iOS
  reaches it via nginx over Tailscale (the migration keeps the LLM host's identity). See
  [[project-glacier-steamboat-gpu-fleet]].
- **Env / config**: `HEARTH_MEDIA_ARCHIVE` (kill switch), `HEARTH_MEDIA_MAX_GB=20`,
  `HEARTH_MEDIA_MAX_HEIGHT=2160`, `HEARTH_NSFW_URL`, `HEARTH_NSFW_HIGH`/`_LOW`, `config/media-quality.yaml`.
- **`config/llm-roles.yaml`** unchanged — the category call uses the existing `planner` role (35B
  `:8200`). NSFW is the sidecar, not an LLM role.

## 11. Phasing

- **Phase 1 (MVP)** — yt-dlp video/audio only: probe → NSFW → categorize → compat download (MeTube)
  → verify → context `.md` → `media_items` + RAG index → `archive_url` (Kate detached runner) →
  full NSFW cordon. Serving: browse / search / item / **stream(range)** / thumb + nginx + NAS
  mount + NSFW sidecar. Both smokes.
- **Phase 2** — gallery-dl image galleries (dual downloader, per-image schema §6.3, the gallery
  viewer mode) + chapters polish + the over-cap "want the 4K?" ask proposal.
- **Phase 3 (rich)** — on-demand transcode *fallback* for any odd stored file (explicitly not the
  primary path); optional Plex cross-surface for SFW items; playlist/channel bulk archival;
  dedupe against `media_items`; richer per-site metric templates as they come up.

## 12. Open questions / risks

- **HEVC-recode cost for 4K**: a one-time background transcode per >1080p item. NVENC on a GPU
  slice is fast but the cards are busy; CPU is slow-but-fine for a background job. Measure before
  defaulting 4K-recode on; may prefer "store VP9 4K + recode-on-first-play-and-cache" if volume is
  low. (Doesn't block Phase 1 — most content is ≤1080p H.264 = cheap remux.)
- **gallery-dl auth**: some galleries need cookies/login; gallery-dl supports a cookies file. Out
  of scope for Phase 1 (yt-dlp only), a Phase 2 detail.
- **NSFW model precision on drawings/anime**: gantman splits `drawings` (SFW) vs `hentai` (NSFW);
  validate the threshold on real content before trusting fully-automatic filing (the correction
  affordance is the backstop).
- **Storage growth**: 4K/20 GB items add up on the 65 TB Serapeum (39 TB used). The over-cap ask +
  the cap are the throttle; a future "archive budget" surface could track it.
