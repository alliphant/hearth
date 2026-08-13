# Design — Media Player + Inference-Search (iOS / macOS)

> **Status:** design, not built (2026-07-11). Planning session; no feature code.
> **Authored in hearth-backend for one PR; MIRROR into `hearth-ios` when iOS work
> starts** (this doc references iOS files it can't edit from here). Backend companion:
> [design-media-archival.md](design-media-archival.md).
> Scrum epics under the `roadmap` project.

## 1. Scope

A native **Archive** surface in the Hearth app (iOS + macOS — same codebase): **inference-search**
and **browse** the Serapeum media archive, and a **smooth full-screen player** with **background
audio**, **Picture-in-Picture**, and lock-screen/CarPlay controls. Per Jasper:

- **Never store media in-app** — always **stream** from Serapeum *through the LLM host* (`/api/media/stream/:id`).
  **No offline download** in v1 (deliberately dropped, not deferred).
- **Direct-play only** — the backend stores AVPlayer-native files (H.264/HEVC MP4, AAC M4A) so the
  player never transcodes; it just streams a **byte-range** endpoint.
- **New dedicated "Archive" tab** (5th tab).
- The **NSFW section is owner-only**, enforced by the backend cordon; the app hides it for
  non-owners as defense-in-depth.

## 2. Where this lands in the app (verified against the live tree)

The app is **SwiftUI-only**, Swift 6 strict-concurrency, iOS 18 / macOS 15. Key facts that shape
this design (from a full read of `~/Projects/hearth-ios`):

- **There is no video pipeline today.** Exactly **one** `AVPlayer` exists
  (`HearthCardPrimitives/.../Primitives/AudioClipPrimitive.swift`, audio-only). **No** AVKit,
  `VideoPlayer`, `AVPlayerViewController`, `AVPlayerLayer`, `AVPictureInPictureController`,
  `MPNowPlayingInfoCenter`, or `MPRemoteCommandCenter` anywhere. We build video + now-playing from
  scratch.
- **Tabs:** `Hearth/Features/Root/RootTabView.swift` — iOS-18 `Tab(...)` API,
  `.tabViewStyle(.sidebarAdaptable)`, 4 tabs (Today / Staff / Library / Settings), each its own
  `NavigationStack`. **Add a 5th `Tab("Archive", …)`.** macOS = `MacRootView.swift`
  (`NavigationSplitView`) — add an Archive sidebar entry.
- **Networking:** `HearthClient` (actor) over `URLSessionTransport` (actor, `HearthTransport`).
  Base URL `https://your-llm-host.your-tailnet.ts.net` (`HearthEnvironment.production`; user-overridable
  via `HostStore`). Bearer token from Keychain (`AuthStore.token()`), `X-User-Timezone` on every
  request. Raw bytes via `transport.sendData(...)`. Add media DTOs + `HearthClient` methods here.
- **Design system:** `HearthCardPrimitives` — `HearthTheme` tokens (`walnut/oak/gold/parchment/…`),
  `.hearthGlass(...)` / `.hearthSubstrate()` Liquid-Glass surfaces, `CardRenderer` JSON-dispatch
  (text/photo/map/list/actionRow/audioClip/amount/picker — **no video primitive**). The player is a
  full-screen SwiftUI feature, not a card primitive; the browse/search rows reuse the theme.
- **Image caching:** `Hearth/Features/Staff/AvatarCache.swift` + `BannerCache.swift` — `@MainActor
  @Observable` two-tier (memory + disk) caches, SHA-256-keyed by storage-path+mtime, Bearer-auth
  fetch, 30-day TTL, orphan pruning, `PlatformImage` (UIImage/NSImage). **This is the exact pattern
  for media posters/thumbnails** → a new `MediaThumbCache`.
- **Auth / tier:** `GET /api/auth/me` → `CurrentUser.user.role` (an **opaque String**; there is no
  `owner`/`household`/`friend` enum client-side, and `allowedSpecialists` is modeled but unread).
  The only privilege gate today is **PIN step-up** (`StepUpController.performWithStepUp`). "Cordon"
  is a **backend** concept — the client fetches and gets `401/403` if not entitled (the
  workout-cue precedent). So owner-gating here = read `role` to hide the UI **+** rely on the
  backend to cordon `/api/media/*`.
- **Background audio already declared:** `Hearth/App/Info.plist` `UIBackgroundModes` includes
  `audio` (present for WebRTC/Hazel today) — reuse it for the player; no new entitlement.
- **Build:** XcodeGen (`xcodegen generate`; `Hearth.xcodeproj` is gitignored/generated),
  `xcodebuild -scheme Hearth -destination 'platform=iOS Simulator,name=iPhone 17 Pro'`. New files go
  under `Hearth/Features/Archive/` + `HearthAPI/.../DTOs/Media.swift`; re-run `xcodegen generate`.

## 3. Module layout

| Where | What |
|---|---|
| `HearthAPI/.../DTOs/Media.swift` | `MediaItem`, `MediaFolder`, `MediaSearchResult`, `MediaChapter`, `GalleryImage` — `Codable`/`Sendable`, tolerant-optional (backend-drift-safe, like the other DTOs) |
| `HearthAPI/.../Endpoints/HearthClient.swift` | `mediaBrowse(path:)`, `mediaSearch(q:)`, `mediaItem(id:)`, `mediaStreamURL(id:)`, `mediaThumbURL(id:)`, `mediaImageURL(id:idx:)` |
| `Hearth/Features/Archive/` | `ArchiveTab` (browse + search), `MediaDetailView`, `MediaPlayerView` + `PlayerModel`, `NowPlayingController`, `GalleryViewer` (Phase 2), `MediaThumbCache` |
| `Hearth/Features/Root/RootTabView.swift` / `MacRootView.swift` | the 5th tab / sidebar entry |

**Cross-platform:** AVKit + AVFoundation + MediaPlayer are available on macOS. Keep DTOs in
`HearthAPI` and platform-shim the player view (`#if os(iOS)/os(macOS)`) so the `feat/macos-native`
port ([[macos-port-status]]) inherits the player. PIP is `AVPictureInPictureController` on both.

## 4. The player

### 4.1 Playback core — v1 uses `AVPlayerViewController` (wrapped)

For a *smooth, polished, low-risk* v1, wrap **`AVPlayerViewController`** in a
`UIViewControllerRepresentable` (AppKit equivalent on macOS). It gives, for free and Apple-polished:
native transport bar + **scrubbing**, **PIP** (`allowsPictureInPicturePlayback = true`), **AirPlay**,
**chapter markers**, subtitles, and the loading/buffering affordances a hand-rolled player gets
wrong. A **custom `AVPlayerLayer` + SwiftUI control layer** (the "rich bespoke UX") is the **Phase 3**
upgrade — start on the framework so background/PIP/now-playing land correctly first.

### 4.2 Streaming client (range + auth)

```swift
let url = client.mediaStreamURL(id: item.id)          // baseURL + /api/media/stream/:id
let headers = ["Authorization": "Bearer \(await auth.token())"]
let asset = AVURLAsset(url: url, options: [
  "AVURLAssetHTTPHeaderFieldsKey": headers,            // bearer rides every range request
])
let player = AVPlayer(playerItem: AVPlayerItem(asset: asset))
```

- AVPlayer issues **HTTP `Range` requests** natively against our **206** endpoint (§7 of the
  backend doc) → seek + progressive playback with zero client work and zero device storage.
- **Auth on the media requests:** `AVURLAssetHTTPHeaderFieldsKey` injects the bearer (the simplest
  path). If it proves flaky (it's a semi-documented key), fall back to an
  **`AVAssetResourceLoaderDelegate`** that adds the header + proxies ranges — more code, fully
  supported. **Do not** put the token in the URL query string ([[provable-cordon-concept]] /
  no-secrets-in-URLs); a short-lived signed *stream token* is a last resort only if the header
  path fails.
- Host resolution = the existing `HearthEnvironment`/`HostStore` (Tailscale MagicDNS, real TLS cert,
  no pinning) — the media endpoints ride the same nginx.

### 4.3 Background audio

- Configure `AVAudioSession` `.playback` (the `WorkoutCueAudioPlayer` already does this pattern) so
  audio continues when the app is backgrounded or the screen locks.
- `UIBackgroundModes: audio` is **already declared** — no entitlement change.
- Music/audio-only items (`media_kind: song/album/podcast`) are the primary background-audio case;
  video keeps playing audio when backgrounded too.

### 4.4 Picture-in-Picture

- `AVPlayerViewController.allowsPictureInPicturePlayback = true` → PIP on background/gesture with no
  extra code. (Custom path: `AVPictureInPictureController(playerLayer:)` + delegate.)
- Requires the `audio` background mode (present) and an active `.playback` audio session (§4.3).

### 4.5 Now-playing + remote controls

New `NowPlayingController` (there is none today):

- **`MPNowPlayingInfoCenter.default().nowPlayingInfo`** — `title`, `artist` (creator), `artwork`
  (poster via `MediaThumbCache`), `playbackDuration`, `elapsedPlaybackTime`, rate. → lock screen,
  Control Center, CarPlay, Apple Watch now-playing.
- **`MPRemoteCommandCenter`** — `play/pause/togglePlayPause`, `skipForward/Backward`,
  `changePlaybackPosition` (scrub), `nextTrack/previousTrack` (playlist/queue). Wire each to the
  `PlayerModel`.
- Keep both in sync with the `AVPlayer` timeControlStatus + a periodic time observer.

### 4.6 Chapters

`MediaItem.chapters` (from the backend's yt-dlp chapters, §6.1 of the archival doc) →
`AVPlayerViewController` chapter markers (via `AVNavigationMarkersGroup` on the asset) and
`MPNowPlayingInfoCenter` chapter info. A simple SwiftUI chapter list under the player is the
fallback if native markers are fiddly.

### 4.7 Gallery mode (Phase 2 — image galleries)

`media_kind: image_gallery/photoset` items aren't AVPlayer — render a **paged image viewer**
(`TabView(.page)` or a custom pager) over `/api/media/image/:id/:idx`, images loaded + cached via
`MediaThumbCache` (full-res variant), pinch-zoom, swipe. The item detail branches on `media_kind`.

## 5. Inference-search + browse UX

The **Archive tab** is a `NavigationStack` with:

- **Search bar** → `GET /api/media/search?q=` (backend hybrid RAG over the rich context `.md`) →
  a results grid of `MediaSearchResult` cards (poster + title + creator + duration + `media_kind`
  badge; an **NSFW badge only rendered for owner**). "Inference search" = the semantic backend;
  the client just renders ranked results.
- **Browse** → `GET /api/media/browse?path=` → the deep taxonomy as a drillable folder grid
  (Music / Video / … → artist/channel → item). Posters via `MediaThumbCache`.
- **Item detail** (`MediaDetailView`) → `GET /api/media/item/:id`: poster, title, creator, the
  measured metrics table (views/likes/duration/resolution/codec/upload date/tags/chapters), the
  summary, and a **Play** button → `MediaPlayerView` (or the gallery viewer).
- **Live updates:** subscribe the existing SSE channel (`EventStreamClient`) to **`media_archived`**
  so the grid refreshes the moment Kate files something new.

## 6. Owner-gating (NSFW)

- **Backend is the boundary.** `/api/media/*` cordons by tier; the **stream** endpoint hard-checks
  owner tier for `_private` items and returns a 404-shape (not 403-leak) to a non-owner. The client
  can't see NSFW even if it tried.
- **Client defense-in-depth:** read `CurrentUser.user.role` (from `/api/auth/me`) and **hide** the
  private section / NSFW badges for non-owners. (There's no tier enum today — introduce a small
  `UserTier` mapping over the opaque `role` string, since the backend now needs the app to reason
  about owner-vs-not. This is a new client pattern; the workout-cue "owner-cordoned server-side"
  note is the only precedent.)
- **On-device privacy gate (recommended, default on):** entering the private section requires a
  **Face ID / PIN** unlock (`LocalAuthentication`, reuse the `StepUpController` idiom) — so an
  unlocked, handed-over owner device doesn't expose the private archive at a glance. This is app
  polish over the backend cordon, not a security boundary.

## 7. Thumbnails / posters

New `MediaThumbCache` cloned from `AvatarCache` — `@MainActor @Observable`, two-tier (memory +
`cachesDirectory/media/*.bin`), SHA-256-keyed by `id`+version, **Bearer-auth** fetch of
`/api/media/thumb/:id`, 30-day TTL, orphan prune, `PlatformImage`. Reuse the etag/cache-control the
backend thumb route sends (like `/api/cordelia/thumbnail/:id`).

## 8. Phasing

- **Phase 1** — Archive tab (browse + inference-search + item detail), `MediaPlayerView` on
  `AVPlayerViewController` with **range streaming + bearer auth**, **background audio**, **PIP**,
  **now-playing + remote commands**, `MediaThumbCache`, owner-gating (hide NSFW for non-owner).
- **Phase 2** — gallery viewer (image galleries), chapter markers, the on-device Face ID gate for
  the private section, SSE live-refresh polish.
- **Phase 3** — custom `AVPlayerLayer` + bespoke SwiftUI control layer (the "rich" UX), refined
  AirPlay/CarPlay, queues/playlists, macOS window polish. **Explicitly NOT** offline download
  (Jasper: never store in-app).

## 9. Risks / notes

- **`AVURLAssetHTTPHeaderFieldsKey` reliability** — semi-documented; the resource-loader-delegate
  fallback (§4.2) is the supported path if header injection drops on redirects/ranges. Prototype
  auth'd range playback early.
- **HEVC 4K playback** — fine on modern devices (iOS 18 min); confirm the oldest target device
  decodes HEVC 4K smoothly, else the backend can cap that device's stream at 1080p H.264 (a future
  device-aware stream variant — not v1).
- **No client-side security assumptions** — every NSFW guarantee rests on the backend cordon; the
  client hiding UI is cosmetic. Verify the 404-shape (not 403) cross-tier behavior against the
  backend smoke.
- **First-play latency** — pure direct-play means no transcode wait; first bytes are a NAS read
  through the LLM host. Prefetch the poster + `item` detail on tap; the player shows the poster while the
  first range lands.
