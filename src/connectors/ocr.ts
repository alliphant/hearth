/**
 * OCR connector — CPU fallback for captures where the iOS-side
 * Vision OCR result is empty (non-English doc, the device failed,
 * non-iOS upload source). PaddleOCR sidecar at `HEARTH_OCR_BASE_URL`,
 * spec lives at `ops/ocr/`.
 *
 * Stub-aware like the VL connector: if `HEARTH_OCR_BASE_URL` is unset
 * or `HEARTH_OCR_FALLBACK_ENABLED=0`, returns
 * `{available: false, text: ''}` and the classifier proceeds with
 * whatever text it already has (which for iOS captures is usually
 * everything it needs).
 */

import { readFileSync } from 'node:fs';
import { resolve as resolve_path } from 'node:path';
import { z } from 'zod';
import { createHash } from 'node:crypto';
import type { Tool, ToolContext } from '@core/tool';

const OCR_BASE_URL = (process.env.HEARTH_OCR_BASE_URL ?? '').replace(/\/$/, '');
const OCR_FALLBACK_ENABLED = process.env.HEARTH_OCR_FALLBACK_ENABLED !== '0';
const OCR_TIMEOUT_MS = Number(process.env.HEARTH_OCR_TIMEOUT_MS ?? '30000');

export function ocr_available(): boolean {
  return OCR_BASE_URL.length > 0 && OCR_FALLBACK_ENABLED;
}

export interface OcrImageOpts {
  image_path: string;
  vault_root: string;
  language_hint?: string;
}

export interface OcrImageResult {
  available: boolean;
  text: string;
  /** 0.0-1.0 mean confidence across detected blocks; 0 when nothing detected. */
  confidence: number;
  error?: string;
}

const InputSchema = z.object({
  image_path: z.string().min(1),
  language_hint: z.string().max(20).optional(),
});

const OutputSchema = z.object({
  available: z.boolean(),
  text: z.string(),
  confidence: z.number().min(0).max(1),
  error: z.string().optional(),
});

type Input = z.infer<typeof InputSchema>;
type Output = z.infer<typeof OutputSchema>;

function read_bytes(image_path: string, vault_root: string): Uint8Array {
  const abs = image_path.startsWith('/')
    ? image_path
    : resolve_path(vault_root, image_path);
  return new Uint8Array(readFileSync(abs));
}

/** Direct call from the classifier — no Tool/registry overhead. */
export async function ocr_image_direct(opts: OcrImageOpts): Promise<OcrImageResult> {
  if (!ocr_available()) {
    return { available: false, text: '', confidence: 0, error: 'ocr_unavailable' };
  }
  let bytes: Uint8Array;
  try {
    bytes = read_bytes(opts.image_path, opts.vault_root);
  } catch (err) {
    return {
      available: true,
      text: '',
      confidence: 0,
      error: `read_image_failed: ${(err as Error).message}`,
    };
  }
  // PaddleOCR sidecar contract (see ops/ocr/README.md): POST a
  // multipart with `image` field; respond
  // `{ text: string, mean_confidence: number, blocks: [...] }`.
  const form = new FormData();
  // Wrap the bytes in a Blob with a mime hint; copy through a fresh
  // ArrayBuffer so the Blob constructor accepts it cleanly under TS
  // strict mode (ArrayBufferLike → ArrayBuffer narrowing).
  const buf = new ArrayBuffer(bytes.length);
  new Uint8Array(buf).set(bytes);
  form.append('image', new Blob([buf], { type: 'application/octet-stream' }), 'capture');
  if (opts.language_hint) form.append('language', opts.language_hint);

  let res: Response;
  try {
    res = await fetch(`${OCR_BASE_URL}/ocr`, {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(OCR_TIMEOUT_MS),
    });
  } catch (err) {
    return {
      available: true,
      text: '',
      confidence: 0,
      error: `ocr_fetch_failed: ${(err as Error).message}`,
    };
  }
  if (!res.ok) {
    return { available: true, text: '', confidence: 0, error: `ocr_http_${res.status}` };
  }
  try {
    const json = (await res.json()) as { text?: string; mean_confidence?: number };
    return {
      available: true,
      text: typeof json.text === 'string' ? json.text : '',
      confidence:
        typeof json.mean_confidence === 'number'
          ? Math.max(0, Math.min(1, json.mean_confidence))
          : 0,
    };
  } catch (err) {
    return {
      available: true,
      text: '',
      confidence: 0,
      error: `ocr_parse_failed: ${(err as Error).message}`,
    };
  }
}

let _test_transport: ((opts: OcrImageOpts) => Promise<OcrImageResult>) | null = null;
export function _test_set_ocr_transport(
  fn: ((opts: OcrImageOpts) => Promise<OcrImageResult>) | null,
): void {
  _test_transport = fn;
}
export function ocr_reachable_for_classifier(): boolean {
  return ocr_available() || _test_transport !== null;
}
export async function ocr_image_for_classifier(opts: OcrImageOpts): Promise<OcrImageResult> {
  if (_test_transport) return _test_transport(opts);
  return ocr_image_direct(opts);
}

export const ocr_image: Tool<Input, Output> = {
  name: 'ocr_image',
  description:
    'Extract text from an image via the local PaddleOCR sidecar. Only call when the iOS-side Vision OCR text was empty or non-English; iOS already OCRs English images on-device.',
  risk: 'read',
  required_capabilities: ['ocr_image'],
  input_schema: InputSchema,
  output_schema: OutputSchema,
  idempotency_key(input) {
    const h = createHash('sha256');
    h.update(input.image_path);
    if (input.language_hint) h.update('\n').update(input.language_hint);
    return `ocr_image:${h.digest('hex').slice(0, 16)}`;
  },
  async execute(input, _ctx: ToolContext): Promise<Output> {
    const vault_root =
      process.env.HEARTH_VAULT_ROOT ?? `${process.env.HOME}/vault-friday`;
    return ocr_image_for_classifier({
      image_path: input.image_path,
      vault_root,
      language_hint: input.language_hint,
    });
  },
};
