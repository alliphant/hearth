/**
 * ComfyUI workflow builders.
 *
 * Each builder returns the workflow JSON object that ComfyUI's /prompt
 * endpoint accepts; nodes are keyed by stringified integer ids.
 *
 * Only the Krea 2 Turbo graph remains. The FLUX text2img/img2img
 * builders lived here until 2026-07-30 to drive the CPU ComfyUI on
 * the LLM host (specialist avatars + banners); that instance was retired and
 * they went with it. If a FLUX path is ever wanted again, take it from
 * git history rather than reviving the CPU box — it rendered ~5 min an
 * image and produced nothing after 2026-06-10.
 */

/** Width/height must be divisible by 16. Round up to be safe. */
function round_to_16(n: number): number {
  return Math.max(64, Math.round(n / 16) * 16);
}

/**
 * Krea 2 Turbo — the GPU chat-image path (2026-07-20).
 *
 * Served by the ComfyUI instance on forza (DGX Spark GB10) — the sole
 * install since the LLM host's CPU one was retired 2026-07-30. The Comfy-Org
 * FP8-scaled checkpoint rides Blackwell's native FP8 tensor cores.
 * Turbo is the 8-step distilled
 * variant: cfg locked to 1.0 (unguided), euler/simple, ~1–2 MP output.
 * Krea 2's text stack is Qwen3-VL-4B via CLIPLoader type `krea2` with
 * the Qwen-Image VAE; the negative socket takes a ConditioningZeroOut
 * of the positive (the distilled model ignores real negative guidance).
 * Node graph verified against the bundled ComfyUI v0.28.2
 * `image_krea2_turbo_t2i` template.
 */
export const KREA2_TURBO_UNET = 'krea2_turbo_fp8_scaled.safetensors';
export const KREA2_TEXT_ENCODER = 'qwen3vl_4b_fp8_scaled.safetensors';
export const KREA2_VAE = 'qwen_image_vae.safetensors';

export interface Krea2Text2ImgOpts {
  prompt: string;
  width: number;
  height: number;
  seed?: number;
  /** Turbo is distilled for 8 steps; more buys little. */
  steps?: number;
  filename_prefix?: string;
  lora_name?: string;
  lora_strength?: number;
}

export function build_krea2_text2img(opts: Krea2Text2ImgOpts): Record<string, unknown> {
  const w = round_to_16(opts.width);
  const h = round_to_16(opts.height);
  const steps = opts.steps ?? 8;
  const seed = opts.seed ?? Math.floor(Math.random() * 0xffffffff);
  const prefix = opts.filename_prefix ?? 'hearth-krea2';
  const lora = opts.lora_name?.trim();
  const model_source: [string, number] = lora ? ['10', 0] : ['1', 0];
  return {
    ...(lora ? { '10': { class_type: 'LoraLoaderModelOnly', inputs: { model: ['1', 0], lora_name: lora, strength_model: opts.lora_strength ?? 1.0 } } } : {}),
    '1': {
      class_type: 'UNETLoader',
      inputs: { unet_name: KREA2_TURBO_UNET, weight_dtype: 'default' },
    },
    '2': {
      class_type: 'CLIPLoader',
      inputs: { clip_name: KREA2_TEXT_ENCODER, type: 'krea2', device: 'default' },
    },
    '3': { class_type: 'VAELoader', inputs: { vae_name: KREA2_VAE } },
    '4': { class_type: 'CLIPTextEncode', inputs: { text: opts.prompt, clip: ['2', 0] } },
    '5': { class_type: 'ConditioningZeroOut', inputs: { conditioning: ['4', 0] } },
    '6': {
      class_type: 'EmptyLatentImage',
      inputs: { width: w, height: h, batch_size: 1 },
    },
    '7': {
      class_type: 'KSampler',
      inputs: {
        model: model_source,
        positive: ['4', 0],
        negative: ['5', 0],
        latent_image: ['6', 0],
        seed,
        steps,
        cfg: 1.0,
        sampler_name: 'euler',
        scheduler: 'simple',
        denoise: 1.0,
      },
    },
    '8': { class_type: 'VAEDecode', inputs: { samples: ['7', 0], vae: ['3', 0] } },
    '9': {
      class_type: 'SaveImage',
      inputs: { images: ['8', 0], filename_prefix: prefix },
    },
  };
}
