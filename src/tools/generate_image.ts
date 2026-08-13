/**
 * generate_image — a specialist makes a real image and hands it to the
 * conversation (2026-07-20).
 *
 * Backed by Krea 2 Turbo (12.9B DiT, 8-step distilled, FP8) on the forza
 * DGX Spark's ComfyUI — NOT the CPU FLUX instance on the LLM host that renders
 * avatars/banners. The split is deliberate: chat images must land in
 * seconds (GPU), while the imagery script's styled portrait pipeline keeps
 * its own dedicated CPU path + prompts. `HEARTH_IMAGEGEN_COMFYUI_URL`
 * points at the GPU instance; unset ⇒ the tool reports itself unavailable
 * honestly instead of silently rerouting to the (incompatible) CPU box.
 *
 * Delivery is markdown-by-reference, not a new message schema: the tool
 * writes the PNG under `<vault>/_attachments/generated/`, the file is
 * served at `/api/media/generated/:filename` (authenticated), and the tool
 * returns the exact `![…](…)` line for the specialist to place in its
 * reply — the same `content_md` pipeline every surface already renders
 * (web `render_md`; iOS MarkdownUI image provider). That composes for
 * free with `message_user` (a proactive image is just that markdown in
 * the message body) and deliberation-authored briefs.
 *
 * Self-depiction: when `depict_self` is set, the specialist's canonical
 * `appearance:` descriptor (config/specialists/<id>.yaml) is prepended to
 * the prompt so their self-portraits stay on-model with their avatar
 * imagery — the scene/outfit/mood in `prompt` then styles THIS image.
 */
import { z } from 'zod';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { ulid } from 'ulid';
import type { Tool, ToolContext } from '@core/tool';
import type { ToolDeps } from '@core/tool_deps';
import type { SpecialistRegistry } from '@core/specialist';
import { ComfyUIClient } from '@connectors/comfyui';
import { build_krea2_text2img } from '@app/imagegen/workflows';

const InputSchema = z.object({
  prompt: z
    .string()
    .min(8)
    .max(2000)
    .describe(
      'What the image shows, in concrete visual language — subject, setting, ' +
        'lighting, mood, medium (photo / illustration / watercolor …). ' +
        'Write it like a caption of the finished image, not an instruction.',
    ),
  depict_self: z
    .boolean()
    .optional()
    .describe(
      'Set true when the image is OF YOU. Your canonical appearance is ' +
        'prepended automatically, so describe only the scene, outfit, pose, ' +
        'and mood — no need to re-describe your face or hair.',
    ),
  self_appearance: z
    .string()
    .max(1200)
    .optional()
    .describe(
      'Self-depictions only — your look RIGHT NOW when it differs from your ' +
        'canonical appearance (an outfit or hairstyle changed earlier in this ' +
        'conversation, a scene you are in). Describe your FULL current look, ' +
        'keeping your stable features (face, hair color, age) so you still ' +
        'look like yourself; this replaces the canonical descriptor for this ' +
        'image. Omit to use your canonical look. Providing it implies ' +
        'depict_self.',
    ),
  aspect: z
    .enum(['square', 'portrait', 'landscape'])
    .optional()
    .describe('Framing. Defaults to square; portrait suits people, landscape suits scenes.'),
});

const OutputSchema = z.object({
  ok: z.boolean(),
  markdown: z.string().optional(),
  image_url: z.string().optional(),
  /**
   * Vault-relative path to the PNG — the form `analyze_image` resolves, so a
   * specialist can LOOK at what it just made. `image_url` can't do this: it's
   * an authenticated HTTP route, while the VL connector reads from disk. The
   * two are different addresses for the same bytes, and only this one closes
   * the generate → inspect loop.
   */
  image_path: z.string().optional(),
  note: z.string().optional(),
  error: z.string().optional(),
});

type Input = z.infer<typeof InputSchema>;
type Output = z.infer<typeof OutputSchema>;

const ASPECT_SIZES: Record<string, { width: number; height: number }> = {
  square: { width: 1024, height: 1024 },
  portrait: { width: 896, height: 1152 },
  landscape: { width: 1152, height: 896 },
};

const TIMEOUT_MS = Number(process.env.HEARTH_IMAGEGEN_TIMEOUT_MS ?? 150_000);

/** Where generated chat images live, relative to the vault root. Served
 *  by `/api/media/generated/:filename` (see src/app/routes/media.ts). */
export const GENERATED_MEDIA_REL = '_attachments/generated';

export interface GenerateImageDeps {
  vault_root: string;
  specialists?: Pick<SpecialistRegistry, 'get'>;
  /** Injectable for smokes; production builds a client against
   *  HEARTH_IMAGEGEN_COMFYUI_URL per call (env is hot-reload friendly). */
  run?: (workflow: Record<string, unknown>, timeout_ms: number) => Promise<Uint8Array>;
}

export function make_generate_image(deps: GenerateImageDeps): Tool<Input, Output> {
  return {
    name: 'generate_image',
    description:
      'Create a real image with the house image model (Krea 2) and send it in ' +
      'your reply. Returns a `markdown` line — include that line VERBATIM in ' +
      'your response (or in a message_user body) and the image renders in the ' +
      'chat on every device. Use it whenever a picture lands better than ' +
      'words: something the user asks you to visualize, a mood or scene worth ' +
      'sharing, a moment where showing yourself (`depict_self`) says more than ' +
      'telling. Takes ~10–30 seconds. One image per call. Also returns ' +
      '`image_path` — hand that to `analyze_image` to SEE what was actually ' +
      'drawn, which is the only way to know the render matched your prompt.',
    risk: 'write_internal',
    required_capabilities: ['generate_image'],
    // Generation is not idempotent: `build_krea2_text2img` draws a fresh
    // random seed per call, so the same prompt twice is TWO different
    // images — which is exactly what "make me another one" means. Without
    // this flag the runtime's per-turn duplicate-call cache serves the
    // first image back for every identical re-call, the specialist sees
    // nothing changed and asks again, and the turn spirals while the user
    // watches the same picture reappear.
    volatile: true,
    input_schema: InputSchema,
    output_schema: OutputSchema,

    idempotency_key(input) {
      const h = createHash('sha256');
      h.update(input.prompt);
      h.update('\n');
      h.update(input.aspect ?? 'square');
      h.update(input.depict_self ? '\nself' : '');
      // A changed outfit/look is a different image even at the same
      // prompt — omitting this collapsed those to one key.
      h.update(input.self_appearance ? `\n${input.self_appearance}` : '');
      return `generate_image:${h.digest('hex').slice(0, 16)}`;
    },

    async execute(input, ctx: ToolContext): Promise<Output> {
      // Bind the runner up front: the injected one (tests) needs no
      // endpoint, the real one cannot exist without a configured
      // `HEARTH_IMAGEGEN_COMFYUI_URL`. Resolving it here — rather than
      // re-testing the same two conditions at the call site — is what
      // makes "no endpoint, no client" structural. It also removes the
      // last way this tool could reach the retired CPU ComfyUI: the
      // client no longer carries a default base_url to fall back to.
      const base_url = process.env.HEARTH_IMAGEGEN_COMFYUI_URL;
      const run =
        deps.run ??
        (base_url
          ? (wf: Record<string, unknown>, t: number) =>
              new ComfyUIClient(base_url).run_workflow(wf, t)
          : null);
      if (!run) {
        return {
          ok: false,
          error:
            'The image engine is not configured (HEARTH_IMAGEGEN_COMFYUI_URL is unset). ' +
            'Tell the user you cannot make images right now.',
        };
      }

      // Self-depiction: anchor on the specialist's look so self-portraits
      // match the face the user knows. `self_appearance` (the look as it
      // has EVOLVED in this conversation — an outfit change, hair down)
      // takes precedence over the canonical YAML descriptor, which is the
      // default, not a constraint. Passing self_appearance implies
      // depict_self — small models forget the flag; honor the intent.
      let prompt = input.prompt.trim();
      const specialist_id = ctx.specialist_id;
      const self_appearance = input.self_appearance?.trim();
      if (input.depict_self || self_appearance) {
        const appearance =
          self_appearance ||
          (specialist_id ? deps.specialists?.get(specialist_id)?.appearance?.trim() : undefined);
        if (appearance) {
          prompt = `${appearance} ${prompt}`;
        }
      }

      const size = ASPECT_SIZES[input.aspect ?? 'square'] ?? ASPECT_SIZES.square!;
      const workflow = build_krea2_text2img({
        prompt,
        width: size.width,
        height: size.height,
        filename_prefix: 'hearth-chat',
        lora_name: process.env.HEARTH_IMAGEGEN_LORA,
        lora_strength: Number(process.env.HEARTH_IMAGEGEN_LORA_STRENGTH ?? 1),
      });

      let bytes: Uint8Array;
      try {
        bytes = await run(workflow, TIMEOUT_MS);
      } catch (err) {
        const msg = (err as Error).message;
        ctx.memory.log_action({
          intent_id: ctx.intent_id,
          agent: specialist_id ?? 'system',
          user_id: ctx.user?.id,
          tool_name: 'generate_image',
          tool_input: { prompt: input.prompt.slice(0, 200), aspect: input.aspect },
          execution_result: null,
          error: msg,
        });
        return {
          ok: false,
          error:
            `Image generation failed (${msg.slice(0, 160)}). Tell the user it ` +
            `didn't come out rather than describing an image that doesn't exist.`,
        };
      }

      const filename = `img-${ulid().toLowerCase()}.png`;
      const rel = `${GENERATED_MEDIA_REL}/${filename}`;
      try {
        const abs = resolve(deps.vault_root, rel);
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, bytes);
      } catch (err) {
        return { ok: false, error: `image write failed: ${(err as Error).message}` };
      }

      const image_url = `/api/media/generated/${filename}`;
      // Alt text stays short — it's what screen readers + notification
      // previews see, not a place to restate the whole prompt.
      const alt = input.prompt.replace(/[\[\]\n]/g, ' ').slice(0, 80).trim();
      const markdown = `![${alt}](${image_url})`;

      ctx.memory.log_action({
        intent_id: ctx.intent_id,
        agent: specialist_id ?? 'system',
        user_id: ctx.user?.id,
        tool_name: 'generate_image',
        tool_input: {
          prompt: input.prompt.slice(0, 200),
          aspect: input.aspect,
          depict_self: input.depict_self ?? false,
          self_styled: !!self_appearance,
        },
        execution_result: { image_url, bytes: bytes.length },
      });

      return {
        ok: true,
        markdown,
        image_url,
        image_path: rel,
        note:
          'Place the `markdown` line on its own paragraph in your reply — ' +
          'verbatim, exactly once. Do not wrap it in a code block. You have ' +
          'NOT seen this image: you wrote the prompt, the model drew its own ' +
          'interpretation, and the two can differ a lot. To actually look at ' +
          'it, call `analyze_image` with `image_path` — worth doing before you ' +
          'describe what is in it, or when it matters that the render matched ' +
          'what was asked for.',
      };
    },
  };
}

/** ToolLoader entry — wires the production dependency bag. */
export function create(deps: ToolDeps): Tool {
  return make_generate_image({
    vault_root: deps.vault_root,
    specialists: deps.specialists,
  }) as Tool;
}
