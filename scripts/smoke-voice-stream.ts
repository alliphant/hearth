/**
 * smoke:voice-stream — the web voice orb's GAPLESS synthesis proxy
 * (POST /api/voice/stream in src/app/routes/voice.ts), in-process.
 *
 * Contract (the fix for the web orb's inter-sentence pause + "horrible" emotion):
 *   - the WHOLE reply's sentences → ONE call to the Laur server's gapless
 *     /v1/audio/stream (response_format:'pcm', trim_silence, inter_segment_ms),
 *     streamed straight back as raw PCM with an x-sample-rate header;
 *   - NEUTRAL by default (flag off / kv absent) — NO `instruct` on any segment
 *     (owner A/B pick 2026-07-10). This is the invariant the smoke guards: if
 *     the DEFAULT ever becomes non-neutral, this fails.
 *   - SETTABLE register (2026-07-14, HEARTH_VOICE_STREAM_EMOTION=1): the caller's
 *     per-user kv mode → ONE instruct applied to EVERY segment (never per-
 *     sentence). Plus the GET/POST /emotion_setting picker route (owner-only
 *     intimate tones).
 *
 * Self-contained: a throwaway Bun.serve upstream stands in for forza :8023, a
 * Map-backed fake kv, and a scripted fake LLM for `auto` (no network/GPU/LLM).
 */
import { Hono } from 'hono';
import { create_voice_router } from '../src/app/routes/voice';
import { set_voice_emotion_mode, _TONE_INSTRUCT_FOR_TEST } from '../src/core/voice_emotion';

let checks = 0;
let fails = 0;
function check(name: string, ok: boolean): void {
  checks++;
  if (!ok) fails++;
  console.log((ok ? '  ✓ ' : '  ✗ ') + name);
}

// ── throwaway upstream: records the last /v1/audio/stream body, returns PCM ──
let last_body: any = null;
let upstream_mode: 'ok' | 'err' | 'slow' = 'ok';
let slow_cancelled = false; // set when the barge-in abort reaches the fixture
const FAKE_PCM = new Uint8Array([1, 0, 2, 0, 3, 0, 4, 0]); // 4 int16 samples
const upstream = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === '/v1/audio/stream' && req.method === 'POST') {
      last_body = await req.json().catch(() => null);
      if (upstream_mode === 'err') return new Response('boom', { status: 500 });
      if (upstream_mode === 'slow') {
        // A long synthesis: trickle PCM until the client goes away. Both
        // disconnect signals (request abort + body-stream cancel) set the flag.
        req.signal.addEventListener('abort', () => {
          slow_cancelled = true;
        });
        let timer: ReturnType<typeof setInterval> | undefined;
        const trickle = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(FAKE_PCM);
            timer = setInterval(() => {
              try {
                controller.enqueue(FAKE_PCM);
              } catch {
                if (timer) clearInterval(timer);
              }
            }, 10);
          },
          cancel() {
            slow_cancelled = true;
            if (timer) clearInterval(timer);
          },
        });
        return new Response(trickle, { status: 200, headers: { 'content-type': 'audio/pcm' } });
      }
      return new Response(FAKE_PCM, { status: 200, headers: { 'content-type': 'audio/pcm' } });
    }
    return new Response('not found', { status: 404 });
  },
});
const tts_url = `http://localhost:${upstream.port}`;

// ── fakes for the settable-register path ──────────────────────────────────
// Map-backed kv (only get/set/delete are exercised).
const kv_store = new Map<string, unknown>();
const fake_kv = {
  get<T = unknown>(k: string): T | null {
    return (kv_store.has(k) ? (kv_store.get(k) as T) : null);
  },
  set(k: string, v: unknown): void {
    kv_store.set(k, v);
  },
  delete(k: string): void {
    kv_store.delete(k);
  },
};
// Scripted LLM for `auto`: for_role('status_flavor').provider.complete → 'playful'.
let auto_tone = 'playful';
const fake_llm = {
  for_role: () => ({
    defaults: {},
    provider: { complete: async () => ({ content: auto_tone }) },
  }),
} as any;

// Simulated /api auth: the middleware sets c.get('user') the way the real mount
// does. `test_user` is mutated per case to model owner / non-owner / anonymous.
let test_user: { id?: string; tier?: string } | undefined;
const app = new Hono();
app.use('*', async (c, next) => {
  if (test_user) (c as any).set('user', test_user);
  await next();
});
app.route('/api/voice', create_voice_router({ tts_url, kv: fake_kv as any, llm: fake_llm }));
const call = (body: unknown) =>
  app.request('/api/voice/stream', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
const get_setting = () => app.request('/api/voice/emotion_setting', { method: 'GET' });
const set_setting = (body: unknown) =>
  app.request('/api/voice/emotion_setting', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

async function main(): Promise<void> {
  // ── happy path: whole reply → neutral segments → PCM back ─────────────────
  upstream_mode = 'ok';
  last_body = null;
  const res = await call({ sentences: ['Morning, Jasper.', "Your afternoon is clear."] });
  check('valid sentences → 200', res.status === 200);
  check('content-type is raw octet-stream', res.headers.get('content-type') === 'application/octet-stream');
  check('x-sample-rate header = 24000', res.headers.get('x-sample-rate') === '24000');
  const back = new Uint8Array(await res.arrayBuffer());
  check('upstream PCM streamed straight back (bytes intact)',
    back.length === FAKE_PCM.length && back.every((b, i) => b === FAKE_PCM[i]));

  // upstream request shape
  check('upstream got ONE call to /v1/audio/stream', last_body !== null);
  check('response_format = pcm', last_body?.response_format === 'pcm');
  check('trim_silence on', last_body?.trim_silence === true);
  check('inter_segment_ms = 140 (one even breath)', last_body?.inter_segment_ms === 140);
  check('segments carry BOTH sentences, in order',
    Array.isArray(last_body?.segments) &&
      last_body.segments.length === 2 &&
      last_body.segments[0].text === 'Morning, Jasper.' &&
      last_body.segments[1].text === 'Your afternoon is clear.');
  // THE invariant: neutral — no instruct anywhere.
  check('NO instruct on any segment (neutral web path)',
    last_body.segments.every((s: any) => s.instruct === undefined || s.instruct === null));
  check('no top-level instruct either', last_body.instruct === undefined || last_body.instruct === null);

  // ── whitespace-only sentences are dropped; empty request → 400 ────────────
  last_body = null;
  const trimmed = await call({ sentences: ['  Hi there.  ', '   '] });
  check('whitespace-only sentence dropped, real one kept',
    trimmed.status === 200 && last_body?.segments?.length === 1 && last_body.segments[0].text === 'Hi there.');

  const empty = await call({ sentences: [] });
  check('empty sentences array → 400 (schema)', empty.status === 400);
  const noField = await call({ voice: 'EN_F_Laur' });
  check('missing sentences → 400', noField.status === 400);

  // ── custom voice passes through ───────────────────────────────────────────
  last_body = null;
  await call({ sentences: ['Hello.'], voice: 'EN_F_Other' });
  check('voice passed through to upstream', last_body?.voice === 'EN_F_Other');
  last_body = null;
  await call({ sentences: ['Hello.'] });
  check('default voice EN_F_Laur when omitted', last_body?.voice === 'EN_F_Laur');

  // ── upstream failure → 502 (never a partial/garbage stream) ───────────────
  upstream_mode = 'err';
  const bad = await call({ sentences: ['Hello.'] });
  check('upstream 500 → 502', bad.status === 502);

  // ── barge-in: cancelling the downstream body aborts the upstream fetch ────
  // The iOS/web orb cancels the PCM download mid-reply on barge-in; the route
  // must propagate that to the Laur server so it stops synthesizing (this
  // crosses a real localhost HTTP hop, exercising the actual fetch abort).
  upstream_mode = 'slow';
  slow_cancelled = false;
  const barged = await call({ sentences: ['A very long reply that keeps synthesizing.'] });
  check('slow upstream → 200 streaming', barged.status === 200 && barged.body !== null);
  if (barged.body) {
    const pcm = barged.body.getReader();
    const first = await pcm.read();
    check('first PCM chunk arrives before the barge', !first.done && (first.value?.length ?? 0) > 0);
    await pcm.cancel('barge-in');
    const t0 = Date.now();
    while (!slow_cancelled && Date.now() - t0 < 2000) await new Promise((r) => setTimeout(r, 10));
    check('downstream cancel aborts the upstream TTS request (no wasted synthesis)', slow_cancelled);
  }

  // ── SETTABLE register (HEARTH_VOICE_STREAM_EMOTION) ───────────────────────
  upstream_mode = 'ok';
  const eq_all = (segs: any[], instruct: string | undefined) =>
    Array.isArray(segs) && segs.length > 0 && segs.every((s) => s.instruct === instruct);

  // Flag OFF gates the whole thing: a pinned register is ignored → neutral.
  delete process.env.HEARTH_VOICE_STREAM_EMOTION;
  test_user = { id: 'jasper', tier: 'owner' };
  set_voice_emotion_mode(fake_kv as any, 'jasper', 'warm');
  last_body = null;
  await call({ sentences: ['Hi.'] });
  check('flag OFF → neutral even with a pinned register', eq_all(last_body?.segments, undefined));

  // Flag ON.
  process.env.HEARTH_VOICE_STREAM_EMOTION = '1';

  set_voice_emotion_mode(fake_kv as any, 'jasper', 'neutral');
  last_body = null;
  await call({ sentences: ['One.', 'Two.'] });
  check('flag ON + neutral → no instruct', eq_all(last_body?.segments, undefined));

  set_voice_emotion_mode(fake_kv as any, 'jasper', 'warm');
  last_body = null;
  await call({ sentences: ['One.', 'Two.', 'Three.'] });
  check(
    'flag ON + warm → the SAME warm instruct on every segment',
    last_body?.segments?.length === 3 && eq_all(last_body.segments, _TONE_INSTRUCT_FOR_TEST.warm),
  );

  set_voice_emotion_mode(fake_kv as any, 'jasper', 'auto');
  auto_tone = 'playful';
  last_body = null;
  await call({ sentences: ['A.', 'B.'] });
  check('flag ON + auto → the classified instruct on every segment', eq_all(last_body?.segments, _TONE_INSTRUCT_FOR_TEST.playful));

  // Per-user isolation: an unpinned user is neutral even with the flag on.
  test_user = { id: 'sam', tier: 'household' };
  last_body = null;
  await call({ sentences: ['Hey.'] });
  check('flag ON + unpinned user → neutral', eq_all(last_body?.segments, undefined));

  // ── /emotion_setting picker route ─────────────────────────────────────────
  test_user = { id: 'jasper', tier: 'owner' };
  const g_owner = await (await get_setting()).json();
  check('GET owner: intimate tone (sultry) is offered', (g_owner.options || []).some((o: any) => o.value === 'sultry'));
  check('GET reflects current mode (auto)', g_owner.mode === 'auto');
  check('GET enabled reflects the flag', g_owner.enabled === true);

  test_user = { id: 'sam', tier: 'household' };
  const g_member = await (await get_setting()).json();
  check('GET non-owner: NO intimate tones', (g_member.options || []).every((o: any) => o.intimate !== true));
  check(
    'GET non-owner: neutral + auto + warm still offered',
    ['neutral', 'auto', 'warm'].every((v) => g_member.options.some((o: any) => o.value === v)),
  );

  test_user = { id: 'jasper', tier: 'owner' };
  check('POST owner warm → 200', (await set_setting({ mode: 'warm' })).status === 200);
  check('POST persisted (GET reflects warm)', (await (await get_setting()).json()).mode === 'warm');
  check('POST owner sultry (intimate) → 200', (await set_setting({ mode: 'sultry' })).status === 200);

  test_user = { id: 'sam', tier: 'household' };
  check('POST non-owner sultry (intimate) → 403', (await set_setting({ mode: 'sultry' })).status === 403);
  check('POST non-owner warm (curated) → 200', (await set_setting({ mode: 'warm' })).status === 200);
  check('POST invalid mode → 400', (await set_setting({ mode: 'zesty' })).status === 400);

  test_user = undefined;
  check('POST anonymous → 401', (await set_setting({ mode: 'warm' })).status === 401);

  delete process.env.HEARTH_VOICE_STREAM_EMOTION;

  upstream.stop(true);
  console.log('─'.repeat(50));
  if (fails) {
    console.log(`  ${fails}/${checks} FAILED`);
    process.exit(1);
  }
  console.log(`  ✓ smoke:voice-stream PASSED (${checks} checks)`);
}

void main();
