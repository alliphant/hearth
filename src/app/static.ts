/**
 * Static-file serving for the /app surface.
 *
 * Extracted from router.ts so sub-routers that own both their page and their
 * API (create_hvac_router is the first) can serve their own assets without
 * importing back from the router that mounts them — that would be circular.
 *
 * The MIME map is deliberately an allowlist: anything unrecognized falls back
 * to application/octet-stream rather than being guessed at.
 */

import type { Context } from 'hono';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { extname } from 'node:path';

export const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  // Web voice orb VAD runtime (onnxruntime-web). application/wasm is REQUIRED
  // for WebAssembly.instantiateStreaming; .onnx is an opaque model blob.
  '.wasm': 'application/wasm',
  '.onnx': 'application/octet-stream',
  // Vendored webfonts (the HVAC guide's local Fraunces / IBM Plex).
  '.woff2': 'font/woff2',
};

export function serve_static(c: Context, abs_path: string): Response {
  if (!existsSync(abs_path) || !statSync(abs_path).isFile()) {
    return c.text('not found', 404);
  }
  const ext = extname(abs_path).toLowerCase();
  const mime = MIME[ext] ?? 'application/octet-stream';
  const bytes = readFileSync(abs_path);
  // Long cache on hashed assets is for a future build step; for now keep
  // it short so changes to app.css / app.js show up on refresh.
  const headers: Record<string, string> = {
    'Content-Type': mime,
    'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=60',
  };
  return new Response(new Uint8Array(bytes), { status: 200, headers });
}
