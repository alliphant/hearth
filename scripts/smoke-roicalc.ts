// scripts/smoke-roicalc.ts — self-contained smoke for the local-vs-cloud
// LLM ROI calculator (src/roicalc/). Covers:
//   • compute_roi math against hand-computed expectations (dedicated +
//     shared duty modes, zero workload, over-capacity flag)
//   • run_bench against a scripted fake OpenAI-compat SSE server with
//     controlled prefill delay + inter-token spacing (tolerant bounds —
//     setTimeout granularity drifts upward)
//   • the stream_options-rejected fallback (estimated token counts)
//   • the Ollama unload path (fake /api/version + /api/generate)
//   • the HTTP routes in-process (UI served, calc, presets, models proxy,
//     validation 400s, unreachable-endpoint 502)
// No live LLM, no network beyond localhost.

import { BenchInputSchema, run_bench } from '../src/roicalc/bench';
import { compute_roi, RoiInputSchema } from '../src/roicalc/calc';
import { create_roicalc_app } from '../src/roicalc/server';

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}
function approx(actual: number, expected: number, tol_pct: number): boolean {
  if (expected === 0) return Math.abs(actual) < 1e-9;
  return Math.abs(actual - expected) / Math.abs(expected) <= tol_pct / 100;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── 1. compute_roi — dedicated mode, hand-computed ──────────────────────────
console.log('compute_roi:');
{
  const input = RoiInputSchema.parse({
    bench: { prefill_tps: 5000, gen_tps: 50 },
    workload: { prompt_mtok_month: 10, output_mtok_month: 1 },
    local: {
      hardware_cost_usd: 2000,
      power_load_w: 400,
      power_idle_w: 50,
      electricity_usd_per_kwh: 0.15,
      dedicated_24_7: true,
      misc_monthly_usd: 0,
    },
    cloud: { input_usd_per_mtok: 2, output_usd_per_mtok: 8 },
  });
  const r = compute_roi(input);
  // busy = 10e6/5000 + 1e6/50 = 22_000 s = 6.1111 h
  check('busy hours', approx(r.busy_hours_month, 6.1111, 0.1), `got ${r.busy_hours_month}`);
  check('utilization ~0.84%', approx(r.utilization_pct, 0.8372, 0.5), `got ${r.utilization_pct}`);
  check('capacity ok', r.capacity === 'ok');
  // energy = 400W×6.1111h + 50W×723.889h = 2.4444 + 36.1944 = 38.6389 kWh
  check('energy kWh', approx(r.energy_kwh_month, 38.6389, 0.1), `got ${r.energy_kwh_month}`);
  check('energy cost', approx(r.energy_cost_month_usd, 5.7958, 0.1), `got ${r.energy_cost_month_usd}`);
  check('cloud $/mo = 28', approx(r.cloud_cost_month_usd, 28, 0.01));
  check('cloud $/Mtok blended', approx(r.cloud_usd_per_mtok ?? 0, 28 / 11, 0.01));
  // breakeven = 2000 / (28 − 5.7958) = 90.07
  check('breakeven ~90.1 mo', approx(r.breakeven_months ?? 0, 90.07, 0.5), `got ${r.breakeven_months}`);
  check('4 horizon rows', r.rows.length === 4 && r.rows[0]?.months === 12 && r.rows[3]?.months === 48);
  const h12 = r.rows[0];
  check('12mo local total', approx(h12?.local_total_usd ?? 0, 2069.55, 0.1), `got ${h12?.local_total_usd}`);
  check('12mo cloud total', approx(h12?.cloud_total_usd ?? 0, 336, 0.01));
  check('12mo savings negative', (h12?.savings_usd ?? 0) < 0);
  check('12mo roi ~−86.7%', approx(h12?.roi_pct ?? 0, -86.677, 0.5), `got ${h12?.roi_pct}`);
  // local $/Mtok @12: (2000/12 + 5.7958) / 11 = 15.679
  check('12mo local $/Mtok', approx(h12?.local_usd_per_mtok ?? 0, 15.679, 0.5), `got ${h12?.local_usd_per_mtok}`);
}

// ── 2. compute_roi — shared mode + misc ─────────────────────────────────────
{
  const input = RoiInputSchema.parse({
    bench: { prefill_tps: 5000, gen_tps: 50 },
    workload: { prompt_mtok_month: 10, output_mtok_month: 1 },
    local: {
      hardware_cost_usd: 2000,
      power_load_w: 400,
      power_idle_w: 50,
      electricity_usd_per_kwh: 0.15,
      dedicated_24_7: false,
      misc_monthly_usd: 5,
    },
    cloud: { input_usd_per_mtok: 2, output_usd_per_mtok: 8 },
  });
  const r = compute_roi(input);
  // energy = load only = 2.4444 kWh → $0.3667; opex = 5.3667
  check('shared-mode energy', approx(r.energy_kwh_month, 2.4444, 0.1), `got ${r.energy_kwh_month}`);
  check('shared-mode opex', approx(r.local_opex_month_usd, 5.3667, 0.1), `got ${r.local_opex_month_usd}`);
  check('shared-mode breakeven', approx(r.breakeven_months ?? 0, 2000 / (28 - 5.3667), 0.5));
}

// ── 2b. compute_roi — flat subscription on the cloud side ───────────────────
{
  const base = {
    bench: { prefill_tps: 5000, gen_tps: 50 },
    workload: { prompt_mtok_month: 10, output_mtok_month: 1 },
    local: {
      hardware_cost_usd: 2000,
      power_load_w: 400,
      power_idle_w: 50,
      electricity_usd_per_kwh: 0.15,
      dedicated_24_7: false,
    },
  };
  const with_sub = compute_roi(
    RoiInputSchema.parse({
      ...base,
      cloud: { input_usd_per_mtok: 2, output_usd_per_mtok: 8, subscription_usd_month: 100 },
    }),
  );
  // 10×2 + 1×8 + 100 = 128
  check('subscription adds to cloud bill', approx(with_sub.cloud_cost_month_usd, 128, 0.01));
  check('subscription in blended $/Mtok', approx(with_sub.cloud_usd_per_mtok ?? 0, 128 / 11, 0.01));

  const sub_only = compute_roi(
    RoiInputSchema.parse({
      ...base,
      cloud: { input_usd_per_mtok: 0, output_usd_per_mtok: 0, subscription_usd_month: 20 },
    }),
  );
  check('subscription-only cloud bill', approx(sub_only.cloud_cost_month_usd, 20, 0.01));

  const omitted = compute_roi(
    RoiInputSchema.parse({
      ...base,
      cloud: { input_usd_per_mtok: 2, output_usd_per_mtok: 8 },
    }),
  );
  check('subscription defaults to 0', approx(omitted.cloud_cost_month_usd, 28, 0.01));
}

// ── 3. compute_roi — zero workload + over-capacity ──────────────────────────
{
  const zero = compute_roi(
    RoiInputSchema.parse({
      bench: { prefill_tps: 5000, gen_tps: 50 },
      workload: { prompt_mtok_month: 0, output_mtok_month: 0 },
      local: {
        hardware_cost_usd: 2000,
        power_load_w: 400,
        power_idle_w: 50,
        electricity_usd_per_kwh: 0.15,
        dedicated_24_7: true,
      },
      cloud: { input_usd_per_mtok: 2, output_usd_per_mtok: 8 },
    }),
  );
  check('zero workload: no breakeven', zero.breakeven_months === null);
  check('zero workload: null $/Mtok', zero.cloud_usd_per_mtok === null && zero.rows[0]?.local_usd_per_mtok === null);
  check('zero workload: utilization 0', zero.utilization_pct === 0);

  const over = compute_roi(
    RoiInputSchema.parse({
      bench: { prefill_tps: 5000, gen_tps: 50 },
      workload: { prompt_mtok_month: 0, output_mtok_month: 200 }, // 4e6 s busy ≫ month
      local: {
        hardware_cost_usd: 2000,
        power_load_w: 400,
        power_idle_w: 50,
        electricity_usd_per_kwh: 0.15,
        dedicated_24_7: false,
      },
      cloud: { input_usd_per_mtok: 2, output_usd_per_mtok: 8 },
    }),
  );
  check('over-capacity flagged', over.capacity === 'over', `got ${over.capacity} at ${over.utilization_pct}%`);
}

// ── fake OpenAI-compat server ────────────────────────────────────────────────
const sse = (obj: unknown) => `data: ${JSON.stringify(obj)}\n\n`;
let reject_stream_options = false;
let act_as_ollama = false;
let unload_calls = 0;

const fake = Bun.serve({
  port: 0,
  idleTimeout: 0,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === '/api/version') {
      return act_as_ollama
        ? Response.json({ version: '0.0.0-fake' })
        : new Response('not ollama', { status: 404 });
    }
    if (url.pathname === '/api/generate') {
      unload_calls++;
      return Response.json({ done: true });
    }
    if (url.pathname === '/v1/models') {
      return Response.json({ data: [{ id: 'fake-model' }] });
    }
    if (url.pathname !== '/v1/chat/completions') return new Response('nf', { status: 404 });
    const body = (await req.json()) as Record<string, unknown>;
    if (reject_stream_options && body.stream_options) {
      return Response.json({ error: { message: 'stream_options unsupported' } }, { status: 400 });
    }
    const is_measured = JSON.stringify(body).includes('Filler');
    const with_usage = Boolean(body.stream_options);
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const enc = new TextEncoder();
        const send = (s: string) => controller.enqueue(enc.encode(s));
        if (!is_measured) {
          send(sse({ choices: [{ delta: { content: 'ready' } }] }));
          send(sse({ choices: [{ delta: { content: '.' } }] }));
        } else {
          // role-only delta arrives early; must NOT count as first token
          send(sse({ choices: [{ delta: { role: 'assistant' } }] }));
          await sleep(250); // scripted "prefill" of 1000 tokens → ~4000 tok/s
          send(sse({ choices: [{ delta: { content: '1' } }] }));
          for (let i = 2; i <= 20; i++) {
            await sleep(10); // 19 intervals × ~10ms → ~100 tok/s nominal
            send(sse({ choices: [{ delta: { content: String(i) } }] }));
          }
          if (with_usage) {
            send(sse({ choices: [], usage: { prompt_tokens: 1000, completion_tokens: 20 } }));
          }
        }
        send('data: [DONE]\n\n');
        controller.close();
      },
    });
    return new Response(stream, { headers: { 'content-type': 'text/event-stream' } });
  },
});
const fake_base = `http://localhost:${fake.port}/v1`;

// ── 4. run_bench — happy path with usage ────────────────────────────────────
console.log('run_bench:');
{
  const r = await run_bench(
    BenchInputSchema.parse({
      base_url: fake_base,
      model: 'fake-model',
      prompt_tokens: 1024,
      max_output_tokens: 64,
      timeout_ms: 30_000,
    }),
  );
  check('bench ok', r.ok === true, r.ok ? '' : r.error);
  if (r.ok) {
    check('usage source', r.usage_source === 'usage');
    check('prompt tokens from usage', r.prompt_tokens === 1000);
    check('completion tokens from usage', r.completion_tokens === 20);
    check('ttft ~250ms', r.ttft_ms >= 240 && r.ttft_ms <= 360, `got ${r.ttft_ms}`);
    check('prefill ~4000 tok/s', r.prefill_tps >= 2700 && r.prefill_tps <= 4300, `got ${r.prefill_tps}`);
    check('gen ~100 tok/s', r.gen_tps >= 50 && r.gen_tps <= 115, `got ${r.gen_tps}`);
    check('warmup ran', r.warmup_ms !== null);
  }
}

// ── 5. run_bench — stream_options rejected → estimated counts ───────────────
{
  reject_stream_options = true;
  const r = await run_bench(
    BenchInputSchema.parse({
      base_url: fake_base,
      model: 'fake-model',
      prompt_tokens: 512,
      max_output_tokens: 64,
      timeout_ms: 30_000,
    }),
  );
  reject_stream_options = false;
  check('fallback bench ok', r.ok === true, r.ok ? '' : r.error);
  if (r.ok) {
    check('fallback estimated', r.usage_source === 'estimated');
    check('fallback completion = chunk count', r.completion_tokens === 20);
    check('fallback noted', r.notes.some((n) => n.includes('stream_options')));
  }
}

// ── 6. run_bench — Ollama unload path ───────────────────────────────────────
{
  act_as_ollama = true;
  const r = await run_bench(
    BenchInputSchema.parse({
      base_url: fake_base,
      model: 'fake-model',
      prompt_tokens: 512,
      max_output_tokens: 64,
      unload_after: true,
      timeout_ms: 30_000,
    }),
  );
  act_as_ollama = false;
  check('unload bench ok', r.ok === true, r.ok ? '' : r.error);
  check('unload was called', unload_calls === 1, `got ${unload_calls}`);
  if (r.ok) check('unload noted', r.notes.some((n) => n.includes('unloaded')));
}

// ── 7. run_bench — unreachable endpoint is a structured error ───────────────
{
  const r = await run_bench(
    BenchInputSchema.parse({
      base_url: 'http://127.0.0.1:9/v1', // discard port; nothing listens
      model: 'x',
      timeout_ms: 10_000,
    }),
  );
  check('unreachable → ok:false', r.ok === false);
  if (!r.ok) check('unreachable has message', r.error.length > 0, r.error);
}

// ── 8. HTTP routes in-process ───────────────────────────────────────────────
console.log('routes:');
{
  const app = create_roicalc_app();
  const ui = await app.request('/');
  const ui_text = await ui.text();
  check('GET / serves UI', ui.status === 200 && ui_text.includes('ROI calculator'));

  const presets = await app.request('/api/presets');
  const presets_body = (await presets.json()) as { presets: unknown[] };
  check('GET /api/presets', presets.status === 200 && presets_body.presets.length > 0);

  const models = await app.request(`/api/models?base_url=${encodeURIComponent(fake_base)}`);
  const models_body = (await models.json()) as { models?: string[] };
  check('GET /api/models proxies', models.status === 200 && models_body.models?.[0] === 'fake-model');

  const calc = await app.request('/api/calc', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      bench: { prefill_tps: 5000, gen_tps: 50 },
      workload: { prompt_mtok_month: 10, output_mtok_month: 1 },
      local: {
        hardware_cost_usd: 2000,
        power_load_w: 400,
        power_idle_w: 50,
        electricity_usd_per_kwh: 0.15,
        dedicated_24_7: true,
      },
      cloud: { input_usd_per_mtok: 2, output_usd_per_mtok: 8 },
    }),
  });
  const calc_body = (await calc.json()) as { rows?: unknown[]; cloud_cost_month_usd?: number };
  check('POST /api/calc', calc.status === 200 && calc_body.rows?.length === 4 && calc_body.cloud_cost_month_usd === 28);

  const bad_calc = await app.request('/api/calc', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ bench: { prefill_tps: -1 } }),
  });
  check('POST /api/calc validates', bad_calc.status === 400);

  const bad_bench = await app.request('/api/bench', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ base_url: 'not-a-url', model: '' }),
  });
  check('POST /api/bench validates', bad_bench.status === 400);

  const dead_bench = await app.request('/api/bench', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ base_url: 'http://127.0.0.1:9/v1', model: 'x', timeout_ms: 10_000 }),
  });
  check('POST /api/bench unreachable → 502', dead_bench.status === 502);
}

fake.stop(true);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
