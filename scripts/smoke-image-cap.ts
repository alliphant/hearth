/**
 * smoke:image-cap — the vision image-size cap (src/core/image_transcode.ts).
 *
 * A full-resolution camera frame crashed the forza vision tier (the
 * FlashAttention-2 ViT kernel threw a CUDA fault on the GB10 → vLLM
 * EngineDeadError, 2026-06-28). The cap enforces a longest-side limit at the
 * one chokepoint every vision request flows through, so no caller can hand the
 * model an image big enough to crash it. This asserts:
 *   - the dependency-free header dimension parse (JPEG/PNG/GIF) is correct,
 *   - an unparseable header → null (caller downscales to be safe),
 *   - the env cap (default + override + clamp),
 *   - end-to-end: an oversized image is actually downscaled within the cap, a
 *     within-cap image passes through untouched (ffmpeg required; skipped if not).
 *
 *   bun run smoke:image-cap
 */
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  image_dimensions,
  vl_max_image_px,
  ensure_jpeg_for_vl,
} from '../src/core/image_transcode';

let passed = 0;
function check(label: string, cond: unknown): void {
  if (!cond) throw new Error(`FAIL: ${label}`);
  passed++;
  console.log(`  ✓ ${label}`);
}

function png(w: number, h: number): Uint8Array {
  const b = new Uint8Array(33);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0); // signature
  b.set([0, 0, 0, 13], 8); // IHDR length
  b.set([0x49, 0x48, 0x44, 0x52], 12); // "IHDR"
  const dv = new DataView(b.buffer);
  dv.setUint32(16, w, false); // width  @16 (BE)
  dv.setUint32(20, h, false); // height @20 (BE)
  return b;
}
function gif(w: number, h: number): Uint8Array {
  const b = new Uint8Array(13);
  b.set([0x47, 0x49, 0x46, 0x38, 0x39, 0x61], 0); // "GIF89a"
  b[6] = w & 0xff; b[7] = (w >> 8) & 0xff; // width  @6 (LE)
  b[8] = h & 0xff; b[9] = (h >> 8) & 0xff; // height @8 (LE)
  return b;
}
function jpeg(w: number, h: number): Uint8Array {
  // FFD8 then a SOF0 (FFC0): length(2) precision(1) height(2) width(2) …
  const b = new Uint8Array(20);
  b.set([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08], 0);
  b[7] = (h >> 8) & 0xff; b[8] = h & 0xff; // height @7 (BE)
  b[9] = (w >> 8) & 0xff; b[10] = w & 0xff; // width  @9 (BE)
  return b;
}

async function ffmpeg_available(): Promise<boolean> {
  try {
    const p = Bun.spawn(['ffmpeg', '-version'], { stdout: 'ignore', stderr: 'ignore' });
    return (await p.exited) === 0;
  } catch { return false; }
}

async function main(): Promise<void> {
  // ── header dimension parse ────────────────────────────────────────────────
  check('PNG dims', JSON.stringify(image_dimensions(png(1920, 1080))) === JSON.stringify({ w: 1920, h: 1080 }));
  check('GIF dims', JSON.stringify(image_dimensions(gif(800, 600))) === JSON.stringify({ w: 800, h: 600 }));
  check('JPEG dims', JSON.stringify(image_dimensions(jpeg(2560, 1440))) === JSON.stringify({ w: 2560, h: 1440 }));
  check('unparseable header → null (downscale-safe)', image_dimensions(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])) === null);
  check('empty → null', image_dimensions(new Uint8Array(0)) === null);

  // ── env cap ──────────────────────────────────────────────────────────────
  delete process.env.HEARTH_VL_MAX_IMAGE_PX;
  check('cap default 1280', vl_max_image_px() === 1280);
  process.env.HEARTH_VL_MAX_IMAGE_PX = '1024';
  check('cap override 1024', vl_max_image_px() === 1024);
  process.env.HEARTH_VL_MAX_IMAGE_PX = '99999';
  check('cap clamps absurd → default', vl_max_image_px() === 1280);
  process.env.HEARTH_VL_MAX_IMAGE_PX = 'nonsense';
  check('cap garbage → default', vl_max_image_px() === 1280);
  delete process.env.HEARTH_VL_MAX_IMAGE_PX;

  // ── end-to-end downscale (ffmpeg) ─────────────────────────────────────────
  if (!(await ffmpeg_available())) {
    console.log('  ⚠ ffmpeg not found — skipping end-to-end downscale check');
  } else {
    const dir = mkdtempSync(join(tmpdir(), 'imgcap-'));
    try {
      // A real 2400×1600 JPEG (over the 1280 cap) via ffmpeg's testsrc.
      const big = join(dir, 'big.jpg');
      await Bun.spawn(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=2400x1600:duration=1:rate=1', '-frames:v', '1', big], { stdout: 'ignore', stderr: 'ignore' }).exited;
      const oversized = await ensure_jpeg_for_vl(big);
      const od = image_dimensions(oversized.bytes)!;
      check('oversized JPEG downscaled within cap', od.w <= 1280 && od.h <= 1280 && Math.max(od.w, od.h) === 1280);
      check('aspect preserved (1280×853 for 3:2)', od.w === 1280 && od.h === 853);
      check('downscale produced a temp file w/ cleanup', oversized.path !== big && typeof oversized.cleanup === 'function');
      oversized.cleanup?.();

      // A within-cap 800×600 JPEG passes through untouched (no spawn, same path).
      const small = join(dir, 'small.jpg');
      await Bun.spawn(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=800x600:duration=1:rate=1', '-frames:v', '1', small], { stdout: 'ignore', stderr: 'ignore' }).exited;
      const within = await ensure_jpeg_for_vl(small);
      check('within-cap image passes through (same path, no cleanup)', within.path === small && within.cleanup === undefined);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  console.log(`\n✅ smoke:image-cap — ${passed} checks passed`);
}

main();
