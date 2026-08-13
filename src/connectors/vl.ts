/**
 * Visual-language connector — wraps the deep-consult LLM role with a
 * vision attachment.
 *
 * As of 2026-05-26 the same the LLM host endpoint (`OPENAI_BASE_URL`) that
 * serves Qwen3.6-27B chat ALSO accepts the OpenAI vision content shape
 * via mmproj. So this connector no longer needs its own URL —
 * `analyze_image_direct` drives through the LLM router (deep_consult
 * role) with `request.vision = { image_path }`; the provider transcodes
 * HEIC → JPEG via ffmpeg and attaches the image to the user message.
 *
 * Two surfaces remain:
 *
 *   1. `analyze_image` — registry-loaded Tool, capability-gated to
 *      `analyze_image` (Cordelia only). Returns a STRUCTURED
 *      description suitable for the classifier's scene track.
 *
 *   2. `analyze_image_direct(opts, llm)` — internal function the
 *      classifier calls from the reactive driver. Same call, just
 *      bypasses the registry / capability hop.
 *
 * Stub-aware: when the OpenAI provider isn't configured (no
 * OPENAI_BASE_URL), or when `OPENAI_VISION_AVAILABLE=0`, the connector
 * returns `{available: false}`. The doc track of the classifier
 * (on-device OCR + planner-role Qwen 27B routing) still runs.
 */

import { isAbsolute, resolve as resolve_path } from 'node:path';
import { z } from 'zod';
import { createHash } from 'node:crypto';
import type { Tool, ToolContext } from '@core/tool';
import type { LLMRouter } from '@core/llm';

export function vl_available(): boolean {
  // Module-load proxy: OPENAI_BASE_URL set AND not explicitly disabled.
  // The real check happens through capabilities() at call time.
  return (
    (process.env.OPENAI_BASE_URL ?? '').length > 0 &&
    process.env.OPENAI_VISION_AVAILABLE !== '0'
  );
}

// Only LIVE, loaded specialists (2026-07-28 ghost purge — anya/iris/marguerite
// had no config files at all; their domains re-homed: pets + home-hardware →
// kate, archives/genealogy → cordelia's library shelves). Keep this list in
// step with config/specialists/ — a hint naming a nonexistent persona teaches
// the classifier (and Kate, who now holds analyze_image) to cite ghosts.
const SuggestedSpecialistHintEnum = z.enum([
  'anna',
  'brigid',
  'cordelia',
  'eleanor',
  'kate',
  'linda',
  'maggie',
  'vivian',
  // Catch-all when the description doesn't map cleanly.
  'unknown',
]);

export interface AnalyzeImageOpts {
  /** Absolute filesystem path OR a vault-relative path (resolved against vault_root). */
  image_path: string;
  /** Vault root for resolving vault-relative `image_path`. */
  vault_root: string;
  /** Extra context the classifier already has (OCR excerpt, iOS hint). */
  context?: string;
  /** Optional user-provided note carried with the capture. */
  user_note?: string;
}

export interface AnalyzeImageResult {
  available: boolean;
  description: string;
  /** Short list of the highest-signal nouns the VL saw — useful for the
   *  classifier prompt without re-reading the full description. */
  salient_objects: string[];
  /** VL's first-pass guess at which specialist's domain the image is in. */
  suggested_specialist_hint: string;
  /** 0.0-1.0 — VL's own confidence in the description. */
  confidence: number;
  error?: string;
}

const InputSchema = z.object({
  image_path: z.string().min(1),
  context: z.string().max(2000).optional(),
});

const OutputSchema = z.object({
  available: z.boolean(),
  description: z.string(),
  salient_objects: z.array(z.string()),
  suggested_specialist_hint: SuggestedSpecialistHintEnum.or(z.string()),
  confidence: z.number().min(0).max(1),
  error: z.string().optional(),
});

type Input = z.infer<typeof InputSchema>;
type Output = z.infer<typeof OutputSchema>;

const SYSTEM_PROMPT = `You are a vision assistant for a household chief-of-staff system. \
For each image, return a single JSON object with exactly these fields and nothing else:

{
  "description": "2-4 sentences. What is visible. Be specific about text, brands, dates, names if any.",
  "salient_objects": ["short", "noun", "list"],
  "suggested_specialist_hint": "anna | brigid | cordelia | eleanor | kate | linda | maggie | vivian | unknown",
  "confidence": 0.0-1.0
}

Specialist hint guide (pick ONE):
- anna:      property-tax and assessor documents, utility bills (kWh/therms/gallons)
- brigid:    food labels, recipes, ingredients, kitchen receipts, restaurant menus
- cordelia:  book covers, book spines, dust jackets, library cards, bookplates;
             ALSO old photographs, genealogy documents, archive scans, family heirlooms
- eleanor:   plants, garden beds, pests/disease on leaves, seed packets, soil tests
- kate:      paper mail, letters, business cards, household coordination items;
             pets and veterinary documents; EV chargers, home-automation
             hardware, breaker panels; ALSO security cameras, alarm panels,
             locks, unfamiliar people at the door
- linda:     goods staged for resale — clothing on hangers, price-tagged or
             product-shot items against plain backdrops
- maggie:    band posters, concert tickets, album art, vinyl, instruments
- vivian:    receipts, invoices, financial statements, tax forms, account statements
- unknown:   scene photos with no clear domain, ambiguous mixed content

Reply with ONLY the JSON object — no markdown fence, no preamble.`;

function resolve_image_path(image_path: string, vault_root: string): string {
  return isAbsolute(image_path) ? image_path : resolve_path(vault_root, image_path);
}

function parse_vl_json(content: string): {
  description: string;
  salient_objects: string[];
  suggested_specialist_hint: string;
  confidence: number;
} | null {
  const cleaned = content
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();
  try {
    const j = JSON.parse(cleaned) as Record<string, unknown>;
    const description = typeof j.description === 'string' ? j.description : '';
    const salient_objects = Array.isArray(j.salient_objects)
      ? j.salient_objects.filter((v): v is string => typeof v === 'string')
      : [];
    const suggested_specialist_hint =
      typeof j.suggested_specialist_hint === 'string'
        ? j.suggested_specialist_hint
        : 'unknown';
    const confidence =
      typeof j.confidence === 'number' && j.confidence >= 0 && j.confidence <= 1
        ? j.confidence
        : 0.5;
    if (description.length === 0) return null;
    return { description, salient_objects, suggested_specialist_hint, confidence };
  } catch {
    return null;
  }
}

/**
 * Direct call from the classifier — drives the deep-consult LLM role
 * with a vision attachment. The provider transcodes HEIC if needed.
 * Returns `available: false` when the provider isn't vision-capable.
 */
export async function analyze_image_direct(
  opts: AnalyzeImageOpts,
  llm: LLMRouter,
): Promise<AnalyzeImageResult> {
  // Classification is always a vision call → the dedicated `vision` role (the
  // VL model). The text deep tier (sparse 80B on forza) is text-only.
  const role = llm.for_role('vision');
  if (!role.provider.capabilities().supports_vision) {
    return {
      available: false,
      description: '',
      salient_objects: [],
      suggested_specialist_hint: 'unknown',
      confidence: 0,
      error: 'vl_unavailable',
    };
  }
  const abs_path = resolve_image_path(opts.image_path, opts.vault_root);
  const user_text =
    opts.context || opts.user_note
      ? `Image to classify.${opts.context ? ` Context: ${opts.context}` : ''}${opts.user_note ? ` User note: ${opts.user_note}` : ''}`
      : 'Image to classify.';
  try {
    const resp = await role.provider.complete({
      ...role.defaults,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: user_text },
      ],
      vision: { image_path: abs_path },
      temperature: 0.1,
      max_tokens: 400,
      think: false,
    });
    const parsed = parse_vl_json(resp.content);
    if (!parsed) {
      return {
        available: true,
        description: resp.content.slice(0, 800),
        salient_objects: [],
        suggested_specialist_hint: 'unknown',
        confidence: 0.3,
        error: 'vl_json_unparseable',
      };
    }
    return {
      available: true,
      description: parsed.description,
      salient_objects: parsed.salient_objects,
      suggested_specialist_hint: parsed.suggested_specialist_hint,
      confidence: parsed.confidence,
    };
  } catch (err) {
    return {
      available: true,
      description: '',
      salient_objects: [],
      suggested_specialist_hint: 'unknown',
      confidence: 0,
      error: `vl_call_failed: ${(err as Error).message}`,
    };
  }
}

let _test_transport: ((opts: AnalyzeImageOpts) => Promise<AnalyzeImageResult>) | null = null;
export function _test_set_vl_transport(
  fn: ((opts: AnalyzeImageOpts) => Promise<AnalyzeImageResult>) | null,
): void {
  _test_transport = fn;
}
/** The classifier's view of "is VL reachable?" — true when the OpenAI
 *  provider advertises vision OR a test transport is installed. */
export function vl_reachable_for_classifier(): boolean {
  return vl_available() || _test_transport !== null;
}
export async function analyze_image_for_classifier(
  opts: AnalyzeImageOpts,
  llm: LLMRouter,
): Promise<AnalyzeImageResult> {
  if (_test_transport) return _test_transport(opts);
  return analyze_image_direct(opts, llm);
}

export const analyze_image: Tool<Input, Output> = {
  name: 'analyze_image',
  description:
    'Hand an image (vault-relative path) to the vision-capable LLM for a structured description, salient-object list, and a first-pass specialist routing hint. Use when the iOS-side classifier is uncertain or the image is sparse on OCR-able text.',
  risk: 'read',
  required_capabilities: ['analyze_image'],
  input_schema: InputSchema,
  output_schema: OutputSchema,
  idempotency_key(input) {
    const h = createHash('sha256');
    h.update(input.image_path);
    if (input.context) h.update('\n').update(input.context);
    return `analyze_image:${h.digest('hex').slice(0, 16)}`;
  },
  async execute(input, ctx: ToolContext): Promise<Output> {
    const vault_root =
      process.env.HEARTH_VAULT_ROOT ?? `${process.env.HOME}/vault-friday`;
    return analyze_image_for_classifier(
      {
        image_path: input.image_path,
        vault_root,
        context: input.context,
      },
      ctx.llm,
    );
  },
};
