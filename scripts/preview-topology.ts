/**
 * Dev-only preview harness for the fleet map (/app/architecture).
 *
 * Serves the real page + app.css and a DEMO /app/api/topology that injects a
 * mix of up/degraded/down/unknown statuses + sample metrics — so the visuals
 * (every dot colour, the metric chips, the freshness ticker) can be iterated
 * locally with the browser-preview tools WITHOUT reaching the LLM host/forza.
 *
 * Run via the "topology-preview" config in .claude/launch.json, or:
 *   bun run scripts/preview-topology.ts            (PORT defaults to 7799)
 *
 * The topology STRUCTURE is imported from the live route so the preview can't
 * drift from production; only the health is synthetic here.
 */
import { resolve } from 'node:path';
import { TOPOLOGY, type ServiceHealth } from '../src/app/routes/topology';

const PORT = Number(process.env.PORT ?? 7799);
const CLIENT = resolve(import.meta.dir, '../src/app/client');

// Deterministic demo health so every visual state is exercised. Keys are
// service ids from TOPOLOGY — an id that no longer exists silently degrades
// its service to 'unknown' here, which is how this map went stale through two
// re-tiers. The vLLM metric labels are unexercised on purpose: no vLLM server
// remains in the fleet (the client keeps the labels for if one returns).
const DEMO: Record<string, Partial<ServiceHealth>> = {
  'interactive-35b': {
    status: 'up', latency_ms: 22,
    metrics: {
      'llamacpp:requests_processing': 1,
      'llamacpp:predicted_tokens_seconds': 47,
      'llamacpp:n_busy_slots_per_decode': 1.4,
    },
  },
  'tts-laur': { status: 'up', latency_ms: 25 },
  'stt-parakeet': { status: 'up', latency_ms: 31 },
  'rag-infinity': { status: 'up', latency_ms: 14 },
  'frigate': { status: 'up', latency_ms: 9 },
  'plex': { status: 'up', latency_ms: 6 },
  'deep-35b': {
    status: 'up', latency_ms: 41,
    metrics: {
      'llamacpp:requests_processing': 2,
      'llamacpp:requests_deferred': 1,
      'llamacpp:predicted_tokens_seconds': 38,
      'llamacpp:n_busy_slots_per_decode': 2.6,
    },
  },
  'vision-27b': { status: 'degraded', latency_ms: 80, http_status: 503 },
  'status-flavor': { status: 'up', latency_ms: 4 },
  'ocr-paddle': { status: 'unknown' },
  'deep-judge-122b': {
    status: 'up', latency_ms: 58,
    metrics: {
      'llamacpp:requests_processing': 1,
      'llamacpp:predicted_tokens_seconds': 14,
      'llamacpp:n_busy_slots_per_decode': 1.0,
    },
  },
  'imagegen-krea2': { status: 'up', latency_ms: 63 },
  'agentd': { status: 'down', latency_ms: 3000 },
};

function demo_payload() {
  const checked_at = new Date().toISOString();
  const flat = TOPOLOGY.flatMap((b) => b.units.flatMap((u) => u.services));
  const health: Record<string, ServiceHealth> = {};
  const summary = { up: 0, degraded: 0, down: 0, unknown: 0, total: flat.length };
  for (const svc of flat) {
    const h: ServiceHealth = { status: 'unknown', checked_at, ...DEMO[svc.id] };
    health[svc.id] = h;
    summary[h.status] += 1;
  }
  return { generated_at: checked_at, probe_ms: 137, boxes: TOPOLOGY, health, summary };
}

Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    const p = url.pathname;
    if (p === '/app/api/topology') {
      return Response.json(demo_payload(), { headers: { 'cache-control': 'no-store' } });
    }
    if (p === '/' || p === '/app/architecture') {
      return new Response(Bun.file(resolve(CLIENT, 'architecture.html')), {
        headers: { 'content-type': 'text/html; charset=utf-8' },
      });
    }
    if (p === '/app/app.css') {
      return new Response(Bun.file(resolve(CLIENT, 'app.css')), {
        headers: { 'content-type': 'text/css; charset=utf-8' },
      });
    }
    // Fall through: serve any other /app/ static asset if it exists.
    if (p.startsWith('/app/')) {
      const f = Bun.file(resolve(CLIENT, p.slice('/app/'.length)));
      if (await f.exists()) return new Response(f);
    }
    return new Response('not found', { status: 404 });
  },
});

console.log(`[preview] fleet map at http://localhost:${PORT}/app/architecture`);
