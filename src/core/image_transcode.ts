/**
 * Just-in-time image transcode for vision-bearing LLM requests.
 *
 * the LLM host's Qwen3.6 + mmproj endpoint accepts the standard OpenAI
 * vision content shape (`{type:'image_url', image_url:{url:'data:...'}}`)
 * but does NOT accept HEIC/HEIF. iOS captures land as HEIC, so the
 * OpenAI provider runs each image through `ensure_jpeg_for_vl` before
 * base64-encoding it.
 *
 * Universal-dep choice: ffmpeg (which links libheif on the always-on host and is on
 * every Linux distro by default). One spawn per HEIC capture, ~150-
 * 300ms on commodity hardware. Non-HEIC images WITHIN the size cap pass
 * through with no spawn at all.
 *
 * DOWNSCALE CAP (2026-06-28): a full-resolution camera frame (a ~4-8 MP
 * UniFi snapshot) drives a large vision-encoder attention workload that
 * crashed the forza vision tier — the FlashAttention-2 ViT kernel threw
 * `CUDA error: operation not permitted` on the GB10/Blackwell →
 * `EngineDeadError` → the whole vLLM worker died (a ~3-min reload). The
 * prod capture pipeline downscales upstream, but a raw frame (e.g. a
 * direct camera_proxy fetch) doesn't — so the cap is enforced HERE, at
 * the one chokepoint every vision request flows through, so NO caller
 * can hand the model an image big enough to crash it. The longest side
 * is capped at HEARTH_VL_MAX_IMAGE_PX (default 1280) — ample for scene
 * understanding, well within the encoder's token budget.
 */

import { existsSync, readFileSync, mkdirSync, rmSync } from 'node:fs';
import { resolve, basename, extname } from 'node:path';
import { tmpdir } from 'node:os';
import { ulid } from 'ulid';

/** Longest-side pixel cap for any image handed to the vision model. A frame
 *  larger than this is downscaled (preserving aspect) before encoding. */
export function vl_max_image_px(): number {
  const n = Number(process.env.HEARTH_VL_MAX_IMAGE_PX);
  return Number.isFinite(n) && n >= 256 && n <= 4096 ? Math.floor(n) : 1280;
}

/**
 * Cheap, dependency-free pixel-dimension read from an image's header bytes
 * (JPEG / PNG / GIF — the formats cameras and iOS actually send). Returns null
 * for an unrecognized/unparseable header; the caller treats null as "size
 * unknown → downscale to be safe" so an unreadable header can never let an
 * oversized frame through. No full decode — just the header.
 */
export function image_dimensions(b: Uint8Array): { w: number; h: number } | null {
  // PNG — 8-byte sig, then IHDR: width @16, height @20 (big-endian u32).
  if (b.length >= 24 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    return { w: dv.getUint32(16, false), h: dv.getUint32(20, false) };
  }
  // GIF — 'GIF8', logical screen width @6, height @8 (little-endian u16).
  if (b.length >= 10 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) {
    return { w: b[6]! | (b[7]! << 8), h: b[8]! | (b[9]! << 8) };
  }
  // JPEG — FFD8, then walk segment markers to the SOFn (frame header) and read
  // its height/width. SOF0..SOFF are 0xC0..0xCF EXCEPT 0xC4 (DHT), 0xC8 (JPG),
  // 0xCC (DAC). Markers without a length payload (RSTn, SOI, EOI) are skipped.
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    let o = 2;
    while (o + 1 < b.length) {
      if (b[o] !== 0xff) { o++; continue; }
      let marker = b[o + 1]!;
      while (marker === 0xff && o + 2 < b.length) { o++; marker = b[o + 1]!; }
      o += 2;
      if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (o + 1 >= b.length) break;
      const len = (b[o]! << 8) | b[o + 1]!;
      const isSOF =
        marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isSOF) {
        if (o + 7 < b.length) {
          const h = (b[o + 3]! << 8) | b[o + 4]!;
          const w = (b[o + 5]! << 8) | b[o + 6]!;
          return { w, h };
        }
        break;
      }
      if (len < 2) break;
      o += len;
    }
  }
  return null;
}

export type SupportedMime =
  | 'image/jpeg'
  | 'image/png'
  | 'image/webp'
  | 'image/gif';

export interface TranscodedImage {
  /** Path to a vision-server-acceptable image file (JPEG/PNG/WEBP/GIF). */
  path: string;
  mime: SupportedMime;
  bytes: Uint8Array;
  /** Set when a temp file was created for transcoding — caller must invoke
   *  after the LLM request completes to remove it. */
  cleanup?: () => void;
}

function mime_for_ext(ext: string): SupportedMime | 'image/heic' | null {
  switch (ext.toLowerCase().replace(/^\./, '')) {
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg';
    case 'png':
      return 'image/png';
    case 'webp':
      return 'image/webp';
    case 'gif':
      return 'image/gif';
    case 'heic':
    case 'heif':
      return 'image/heic';
    default:
      return null;
  }
}

/**
 * Ensure the image at `image_path` is a vision-server-acceptable format.
 * HEIC/HEIF inputs are transcoded to JPEG in a tmpdir; the returned
 * `cleanup` removes the temp file.
 *
 * Throws on transcode failure (no silent fallback — the caller is asking
 * for vision and the request can't proceed without an image the server
 * will read).
 */
export async function ensure_jpeg_for_vl(image_path: string): Promise<TranscodedImage> {
  if (!existsSync(image_path)) {
    throw new Error(`image not found: ${image_path}`);
  }
  const ext = extname(image_path);
  const mime = mime_for_ext(ext);
  if (mime === null) {
    throw new Error(`unsupported image extension: ${ext} (${image_path})`);
  }
  const cap = vl_max_image_px();

  if (mime !== 'image/heic') {
    const bytes = new Uint8Array(readFileSync(image_path));
    const dims = image_dimensions(bytes);
    // Within the cap AND a known/parseable format → pass through, no spawn (the
    // common path — preserves the original zero-spawn optimization). An oversized
    // frame OR an unparseable header (dims === null) falls through to a downscale
    // so a too-large image can never reach the model and crash the vision tier.
    if (dims && dims.w <= cap && dims.h <= cap) {
      return { path: image_path, mime, bytes };
    }
    return transcode_via_ffmpeg(image_path, ext, cap, 'downscale');
  }

  // HEIC → JPEG, downscaled to the cap in the same pass.
  return transcode_via_ffmpeg(image_path, ext, cap, 'HEIC→JPEG');
}

/**
 * ffmpeg → a cap-bounded JPEG in a tmp file. Used for HEIC transcode AND for
 * downscaling any oversized frame. The scale filter fits the image WITHIN a
 * cap×cap box preserving aspect and NEVER upscales (min(cap,iw/ih) +
 * decrease) — so a within-cap HEIC transcodes unchanged in size. The returned
 * `cleanup` removes the tmp file; the caller invokes it after the LLM request.
 */
async function transcode_via_ffmpeg(
  image_path: string,
  ext: string,
  cap: number,
  why: string,
): Promise<TranscodedImage> {
  const tmp_dir = resolve(tmpdir(), 'hearth-vl-transcode');
  mkdirSync(tmp_dir, { recursive: true });
  const tmp_path = resolve(
    tmp_dir,
    `${basename(image_path, ext)}-${ulid().toLowerCase().slice(-8)}.jpg`,
  );
  // `force_original_aspect_ratio=decrease` only shrinks; min(cap,iw/ih) bounds
  // the box so a smaller image is left untouched. `-q:v 3` ≈ JPEG quality ~82.
  const vf = `scale='min(${cap}\\,iw)':'min(${cap}\\,ih)':force_original_aspect_ratio=decrease`;
  const proc = Bun.spawn(
    ['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', '-i', image_path, '-vf', vf, '-q:v', '3', tmp_path],
    { stdout: 'ignore', stderr: 'pipe' },
  );
  const exit_code = await proc.exited;
  if (exit_code !== 0) {
    let stderr = '';
    try {
      stderr = await new Response(proc.stderr).text();
    } catch {
      /* ignore */
    }
    try { rmSync(tmp_path, { force: true }); } catch { /* ignore */ }
    throw new Error(`ffmpeg ${why} failed (exit ${exit_code}): ${stderr.slice(0, 200)}`);
  }
  return {
    path: tmp_path,
    mime: 'image/jpeg',
    bytes: new Uint8Array(readFileSync(tmp_path)),
    cleanup: () => {
      try { rmSync(tmp_path, { force: true }); } catch { /* ignore */ }
    },
  };
}

/** Build the standard OpenAI vision `data:<mime>;base64,...` URL for an
 *  already-transcoded image. Inline so callers can drop straight into a
 *  user-content array. */
export function data_url_for(img: TranscodedImage): string {
  // Buffer is faster than btoa for large bytes under Bun, and we already
  // hold the bytes from ensure_jpeg_for_vl().
  return `data:${img.mime};base64,${Buffer.from(img.bytes).toString('base64')}`;
}
