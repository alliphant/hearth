/**
 * Smoke for the Krea 2 chat-image stack (workflow builder + generate_image
 * tool + the /api/media/generated serving route).
 *
 * Self-contained + GPU-free: the tool's ComfyUI call is the injected `run`
 * seam (no forza, no network); the route mounts an in-process Hono app with
 * an in-memory sqlite and a fake auth middleware.
 *
 * Asserts:
 *   - build_krea2_text2img emits the verified v0.28.2 template graph:
 *     UNETLoader(fp8) + CLIPLoader(type krea2) + Qwen-Image VAE, positive →
 *     ConditioningZeroOut negative, KSampler at steps=8 / cfg=1.0 /
 *     euler+simple, dims rounded to /16.
 *   - generate_image writes the PNG under <vault>/_attachments/generated/,
 *     returns ok + a verbatim-placeable markdown line pointing at
 *     /api/media/generated/, and sanitizes the alt text.
 *   - depict_self prepends the specialist's canonical `appearance`; absent
 *     appearance degrades to the raw prompt (still ok).
 *   - an engine failure returns ok:false with an honest "didn't come out"
 *     instruction and writes NOTHING.
 *   - unconfigured (no env, no injected run) reports itself unavailable.
 *   - the serving route: 401 unauthenticated, 200 + immutable cache for a
 *     real file when authed, 404 for traversal + missing files.
 */
import { Database } from 'bun:sqlite';
import { Hono } from 'hono';
import { mkdtempSync, writeFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build_krea2_text2img } from '../src/app/imagegen/workflows';
import { make_generate_image, GENERATED_MEDIA_REL } from '../src/tools/generate_image';
import { create_media_router } from '../src/app/routes/media';
import type { ToolContext } from '../src/core/tool';
import type { MemoryClient } from '../src/memory/client';

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) { console.log(`  ✓ ${name}`); passed++; }
  else { console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); failed++; }
}

// ── 1. workflow builder ─────────────────────────────────────────────────────
console.log('workflow builder:');
{
  const wf = build_krea2_text2img({ prompt: 'a cozy kitchen', width: 1000, height: 1030, seed: 7 });
  const nodes = Object.values(wf) as Array<{ class_type: string; inputs: Record<string, unknown> }>;
  const by_type = (t: string) => nodes.find((n) => n.class_type === t);
  check('UNETLoader loads the fp8 turbo checkpoint',
    by_type('UNETLoader')?.inputs.unet_name === 'krea2_turbo_fp8_scaled.safetensors');
  check('CLIPLoader is type krea2 on the Qwen3-VL encoder',
    by_type('CLIPLoader')?.inputs.type === 'krea2' &&
    by_type('CLIPLoader')?.inputs.clip_name === 'qwen3vl_4b_fp8_scaled.safetensors');
  check('VAE is qwen_image_vae', by_type('VAELoader')?.inputs.vae_name === 'qwen_image_vae.safetensors');
  check('prompt lands in CLIPTextEncode', by_type('CLIPTextEncode')?.inputs.text === 'a cozy kitchen');
  check('negative is ConditioningZeroOut of the positive', !!by_type('ConditioningZeroOut'));
  const ks = by_type('KSampler')?.inputs as Record<string, unknown>;
  check('turbo sampling: 8 steps, cfg 1.0, euler/simple, seed honored',
    ks.steps === 8 && ks.cfg === 1.0 && ks.sampler_name === 'euler' &&
    ks.scheduler === 'simple' && ks.seed === 7);
  const latent = by_type('EmptyLatentImage')?.inputs as Record<string, unknown>;
  check('dims rounded to /16', latent.width === 1008 && latent.height === 1024,
    `got ${latent.width}x${latent.height}`);
}

// ── 2–6. the tool ───────────────────────────────────────────────────────────
console.log('generate_image tool:');
const vault = mkdtempSync(join(tmpdir(), 'hearth-imagegen-'));
const log_calls: unknown[] = [];
const ctx = {
  memory: { log_action: (row: unknown) => { log_calls.push(row); } } as unknown as MemoryClient,
  llm: null as never,
  now: new Date('2026-07-20T12:00:00Z'),
  intent_id: 'int_test',
  specialist_id: 'kate',
  user: { id: 'jasper', tier: 'owner' as const },
} as unknown as ToolContext;

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
{
  const captured: Record<string, unknown>[] = [];
  const tool = make_generate_image({
    vault_root: vault,
    specialists: { get: () => ({ appearance: 'A late-30s woman with auburn hair.' }) as never },
    run: async (wf) => { captured.push(wf); return PNG; },
  });
  const out = await tool.execute({ prompt: 'reading [a book] by the fire\nat night' }, ctx);
  check('success returns ok', out.ok === true, out.error);
  check('markdown targets /api/media/generated/',
    !!out.markdown && /^!\[[^\]]*\]\(\/api\/media\/generated\/img-[0-9a-z]+\.png\)$/.test(out.markdown),
    out.markdown);
  check('alt text sanitized (no brackets/newlines)',
    !!out.markdown && !out.markdown.slice(2, out.markdown.indexOf(']')).match(/[\[\]\n]/));
  const dir = join(vault, GENERATED_MEDIA_REL);
  const files = existsSync(dir) ? readdirSync(dir) : [];
  check('PNG written under _attachments/generated', files.length === 1 && files[0]!.endsWith('.png'));
  check('audit row logged', log_calls.length === 1);

  // image_path closes the generate → inspect loop: it is the VAULT-RELATIVE
  // form analyze_image resolves against vault_root, as distinct from
  // image_url (an authenticated HTTP route the VL connector cannot read).
  // Both tools derive vault_root from HEARTH_VAULT_ROOT, so a relative path
  // handed straight from one to the other must land on the real file.
  check('image_path returned', typeof out.image_path === 'string' && out.image_path.length > 0,
    out.image_path);
  check('image_path is vault-relative, not a URL',
    !!out.image_path && out.image_path.startsWith(`${GENERATED_MEDIA_REL}/`) &&
      !out.image_path.startsWith('/api/'),
    out.image_path);
  check('image_path resolves to the PNG on disk',
    !!out.image_path && existsSync(join(vault, out.image_path)));
  check('image_path and image_url name the same file',
    !!out.image_path && !!out.image_url &&
      out.image_path.split('/').pop() === out.image_url.split('/').pop());
  check('note points at analyze_image', !!out.note && out.note.includes('analyze_image'));

  const wf_prompt = (Object.values(captured[0]!) as Array<{ class_type: string; inputs: Record<string, unknown> }>)
    .find((n) => n.class_type === 'CLIPTextEncode')!.inputs.text as string;
  check('plain prompt is NOT self-anchored', !wf_prompt.startsWith('A late-30s woman'));

  // depict_self prepends the canonical appearance
  const out2 = await tool.execute({ prompt: 'walking on a beach at sunset', depict_self: true }, ctx);
  const wf2_prompt = (Object.values(captured[1]!) as Array<{ class_type: string; inputs: Record<string, unknown> }>)
    .find((n) => n.class_type === 'CLIPTextEncode')!.inputs.text as string;
  check('depict_self prepends appearance', out2.ok === true &&
    wf2_prompt.startsWith('A late-30s woman with auburn hair.') &&
    wf2_prompt.includes('walking on a beach'));

  // self_appearance (the mid-conversation look) overrides the canonical
  const out2b = await tool.execute(
    { prompt: 'laughing in the rain', depict_self: true, self_appearance: 'A late-30s woman with auburn hair worn loose, in a yellow sundress.' },
    ctx,
  );
  const wf2b_prompt = (Object.values(captured[2]!) as Array<{ class_type: string; inputs: Record<string, unknown> }>)
    .find((n) => n.class_type === 'CLIPTextEncode')!.inputs.text as string;
  check('self_appearance replaces the canonical descriptor', out2b.ok === true &&
    wf2b_prompt.startsWith('A late-30s woman with auburn hair worn loose, in a yellow sundress.') &&
    !wf2b_prompt.includes('A late-30s woman with auburn hair. '));

  // self_appearance implies depict_self (small models forget the flag)
  const out2c = await tool.execute(
    { prompt: 'reading on a porch swing', self_appearance: 'A late-30s woman with auburn hair, in a cream cable-knit sweater.' },
    ctx,
  );
  const wf2c_prompt = (Object.values(captured[3]!) as Array<{ class_type: string; inputs: Record<string, unknown> }>)
    .find((n) => n.class_type === 'CLIPTextEncode')!.inputs.text as string;
  check('self_appearance implies depict_self', out2c.ok === true &&
    wf2c_prompt.startsWith('A late-30s woman with auburn hair, in a cream cable-knit sweater.'));

  // portrait aspect flows into the latent
  await tool.execute({ prompt: 'portrait framing test', aspect: 'portrait' }, ctx);
  const latent3 = (Object.values(captured[4]!) as Array<{ class_type: string; inputs: Record<string, unknown> }>)
    .find((n) => n.class_type === 'EmptyLatentImage')!.inputs as Record<string, unknown>;
  check('portrait aspect → 896x1152', latent3.width === 896 && latent3.height === 1152);
}
{
  // no appearance on the registry → raw prompt, still ok
  const captured: Record<string, unknown>[] = [];
  const tool = make_generate_image({
    vault_root: vault,
    specialists: { get: () => ({}) as never },
    run: async (wf) => { captured.push(wf); return PNG; },
  });
  const out = await tool.execute({ prompt: 'a quiet mountain lake', depict_self: true }, ctx);
  const wf_prompt = (Object.values(captured[0]!) as Array<{ class_type: string; inputs: Record<string, unknown> }>)
    .find((n) => n.class_type === 'CLIPTextEncode')!.inputs.text as string;
  check('missing appearance degrades to the raw prompt', out.ok === true && wf_prompt === 'a quiet mountain lake');
}
{
  // engine failure → honest error, nothing written
  const before = readdirSync(join(vault, GENERATED_MEDIA_REL)).length;
  const tool = make_generate_image({
    vault_root: vault,
    run: async () => { throw new Error('CUDA out of memory'); },
  });
  const out = await tool.execute({ prompt: 'this one will fail hard' }, ctx);
  check('engine failure returns ok:false with honesty instruction',
    out.ok === false && !!out.error?.includes("didn't come out"), out.error);
  check('failure writes nothing', readdirSync(join(vault, GENERATED_MEDIA_REL)).length === before);
}
{
  // unconfigured → honest unavailable
  const prev = process.env.HEARTH_IMAGEGEN_COMFYUI_URL;
  delete process.env.HEARTH_IMAGEGEN_COMFYUI_URL;
  const tool = make_generate_image({ vault_root: vault });
  const out = await tool.execute({ prompt: 'no engine configured' }, ctx);
  check('unconfigured reports unavailable',
    out.ok === false && !!out.error?.includes('HEARTH_IMAGEGEN_COMFYUI_URL'), out.error);
  if (prev !== undefined) process.env.HEARTH_IMAGEGEN_COMFYUI_URL = prev;
}

// ── 7. self-appearance system-prompt snippet ────────────────────────────────
console.log('self-appearance prompt snippet:');
{
  const { SpecialistRuntime } = await import('../src/core/specialist_runtime');
  const render = (SpecialistRuntime.prototype as unknown as Record<string, unknown>)
    .render_self_appearance_snippet as (this: null, s: unknown) => string;
  const snip = render.call(null, {
    granted: new Set(['generate_image']),
    appearance: 'A late-30s woman with auburn hair.',
  });
  check('snippet present for a holder with appearance',
    snip.includes('A late-30s woman with auburn hair.') && snip.includes('self_appearance'));
  check('snippet empty without the grant',
    render.call(null, { granted: new Set(), appearance: 'x' }) === '');
  check('snippet empty without a descriptor',
    render.call(null, { granted: new Set(['generate_image']) }) === '');
}

// ── 8. serving route ────────────────────────────────────────────────────────
console.log('/api/media/generated route:');
{
  const generated_root = join(vault, GENERATED_MEDIA_REL);
  writeFileSync(join(generated_root, 'img-known.png'), PNG);
  const db = new Database(':memory:');
  const make_app = (authed: boolean) => {
    const app = new Hono();
    if (authed) {
      app.use('*', async (c, next) => { c.set('user' as never, { id: 'jasper', tier: 'owner' } as never); await next(); });
    }
    app.route('/api/media', create_media_router({
      db,
      memory: { get_media_item: () => null } as unknown as MemoryClient,
      archive_root: vault,
      generated_root,
    }));
    return app;
  };
  const anon = make_app(false);
  const authed = make_app(true);

  const r401 = await anon.request('/api/media/generated/img-known.png');
  check('unauthenticated → 401', r401.status === 401);

  const r200 = await authed.request('/api/media/generated/img-known.png');
  const bytes = new Uint8Array(await r200.arrayBuffer());
  check('authed → 200 PNG bytes', r200.status === 200 && bytes.length === PNG.length);
  check('immutable cache header', (r200.headers.get('cache-control') ?? '').includes('immutable'));
  check('content-type png', r200.headers.get('content-type') === 'image/png');

  const r_trav = await authed.request('/api/media/generated/..%2F..%2Fetc%2Fpasswd');
  check('traversal → 404', r_trav.status === 404);
  const r_miss = await authed.request('/api/media/generated/img-nope.png');
  check('missing file → 404', r_miss.status === 404);
}

rmSync(vault, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
