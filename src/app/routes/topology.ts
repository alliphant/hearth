/**
 * /app/api/topology — the live compute + model fleet map.
 *
 * Returns Hearth's hardware/model topology (boxes → GPU/CPU units →
 * model-serving services → the LLM roles each serves → a one-line
 * purpose) MERGED with live health: every service that declares a
 * `probe` is HTTP-pinged in parallel (3 s timeout) and tagged
 * up / degraded / down. llama.cpp (and vLLM, if one ever returns to the
 * fleet) services additionally get a cheap Prometheus `/metrics` scrape
 * (in-flight requests, tok/s, busy slots) when reachable.
 *
 * The structure is STATIC config (it changes only when the fleet is
 * re-tiered); the health is live. Results are cached for
 * `CACHE_TTL_MS` so a page full of 6-second pollers doesn't fan a probe
 * storm at the boxes.
 *
 * ⚠ Keep the box structure here in sync with the offline-fallback copy
 * baked into src/app/client/architecture.html (`FALLBACK` const). This
 * route is the source of truth; the page's copy only renders when this
 * endpoint is unreachable.
 *
 * Authoritative topology: config/llm-roles.yaml (its role → base_url map is
 * the source of truth for which lane serves which role) + the private dev log "The
 * inference tiers" + architecture.md "Inference topology". Reconciled against
 * the live boxes 2026-07-30, after the two-lane split (PR #208) and the vision
 * cutover (PR #210).
 */

import { Hono } from 'hono';

// ── Host resolution ─────────────────────────────────────────────────────────
// The orchestrator runs in a container on the LLM host. the LLM host's host-network GPU
// services are reachable at `host.docker.internal:<port>`, its docknet
// sidecars by container name; forza is a LAN box reached by IP.
const GLACIER = process.env.HEARTH_TOPO_GLACIER_HOST ?? 'host.docker.internal';
const FORZA = process.env.HEARTH_TOPO_FORZA_HOST ?? '192.168.0.188';
const AVALANCHE = process.env.AVALANCHE_HOST ?? '192.168.0.11';
/** forza's GPU ComfyUI — the only install since the LLM host's CPU FLUX one
 *  was retired 2026-07-30. */
const IMAGEGEN_COMFYUI = (
  process.env.HEARTH_IMAGEGEN_COMFYUI_URL ?? `http://${FORZA}:8188`
).replace(/\/$/, '');
const FRIGATE = (process.env.FRIGATE_BASE_URL ?? 'http://frigate:5000').replace(/\/$/, '');
const PLEX = (process.env.PLEX_URL ?? `http://${GLACIER}:32400`).replace(/\/$/, '');
const OCR_BASE = (process.env.HEARTH_OCR_BASE_URL ?? '').replace(/\/$/, '');

// ── Types ───────────────────────────────────────────────────────────────────

export type HealthStatus = 'up' | 'degraded' | 'down' | 'unknown';
type MetricsEngine = 'llamacpp' | 'vllm';

interface ProbeSpec {
  url: string;
  /** Optional Prometheus /metrics endpoint scraped on the side. */
  metrics?: { url: string; engine: MetricsEngine };
}

export interface ServiceDef {
  id: string;
  /** Engine / server name, e.g. "vLLM", "llama.cpp · beellama". */
  name: string;
  port?: number;
  /** Model id served. */
  model?: string;
  /** LLM roles (or capability tokens) this service backs. */
  roles?: string[];
  /** One-line purpose — what this service DOES for Hearth. */
  purpose: string;
  /** Short qualifier chip, e.g. "FP8 · hybrid-think". */
  badge?: string;
  probe?: ProbeSpec;
}

export interface UnitDef {
  id: string;
  kind: 'gpu' | 'cpu';
  /** Hardware label, e.g. "RTX 6000 Ada #1". */
  label: string;
  /** Tier name, e.g. "Interactive". */
  tier: string;
  /** Memory / bandwidth detail. */
  detail?: string;
  services: ServiceDef[];
}

export interface BoxDef {
  id: string;
  name: string;
  ip: string;
  /** One-line role of this box in the fleet. */
  role: string;
  kind: 'hub' | 'compute' | 'browser';
  hardware: string;
  units: UnitDef[];
}

export interface ServiceHealth {
  status: HealthStatus;
  latency_ms?: number;
  http_status?: number;
  metrics?: Record<string, number>;
  checked_at: string;
}

export interface TopologyPayload {
  generated_at: string;
  /** Wall-clock ms the parallel probe sweep took. */
  probe_ms: number;
  boxes: BoxDef[];
  /** Health keyed by service id, merged onto `boxes` by the client. */
  health: Record<string, ServiceHealth>;
  summary: { up: number; degraded: number; down: number; unknown: number; total: number };
}

// ── The fleet ───────────────────────────────────────────────────────────────

export const TOPOLOGY: BoxDef[] = [
  {
    id: 'glacier',
    name: 'the LLM host',
    ip: '<your-llm-host-ip>',
    role: 'The hub — always-on home stack: both LLM lanes, vision, RAG, speech',
    kind: 'hub',
    hardware: 'Xeon 678X · 96t · 125 GB RAM · 2× RTX 6000 Ada 48 GB',
    units: [
      {
        id: 'glacier-ada1',
        kind: 'gpu',
        label: 'RTX 6000 Ada #1',
        tier: 'Interactive + voice',
        detail: '48 GB · ~960 GB/s · GPU-6d06a9c8',
        services: [
          {
            id: 'interactive-35b',
            name: 'llama.cpp',
            port: 8200,
            model: 'Qwen3.6-35B-A3B Heretic Q5_K_M',
            roles: ['specialist', 'live', 'planner', 'arbiter', 'voice_realtime'],
            purpose:
              'Every latency-sensitive turn — typed chat, realtime voice, planning, the agent-room arbiter.',
            badge: '-np 4 · 49K/slot · think-OFF',
            probe: {
              url: `http://${GLACIER}:8200/v1/models`,
              metrics: { url: `http://${GLACIER}:8200/metrics`, engine: 'llamacpp' },
            },
          },
          {
            id: 'tts-laur',
            name: 'faster-qwen3-tts',
            port: 8023,
            model: 'Qwen3-TTS-1.7B · Laur clone',
            roles: ['voice TTS'],
            purpose:
              "The household's cloned voice — the HA speaker + the web/iOS voice path. Ported off forza 2026-07-02.",
            badge: 'VoiceClone',
            probe: { url: `http://${GLACIER}:8023/v1/models` },
          },
          {
            id: 'stt-parakeet',
            name: 'speaches · parakeet',
            port: 8093,
            model: 'faster-whisper-large-v3-turbo + Kokoro',
            roles: ['STT', 'TTS preset'],
            purpose:
              'Speech → text for voice turns (~150 ms), plus the Kokoro preset voice.',
            badge: 'STT ~150 ms',
            probe: { url: `http://${GLACIER}:8093/v1/models` },
          },
          {
            id: 'rag-infinity',
            name: 'infinity',
            port: 8091,
            model: 'bge-large-en-v1.5 + bge-reranker-v2-m3',
            roles: ['embeddings', 'reranker'],
            purpose:
              'Text → vectors + cross-encoder rerank — the RAG brain behind retrieve_hybrid.',
            badge: '1024-dim',
            probe: { url: `http://${GLACIER}:8091/health` },
          },
          {
            id: 'frigate',
            name: 'Frigate',
            port: 5000,
            model: 'TensorRT detector',
            roles: ['camera detection'],
            purpose:
              'Continuous camera object/person detection feeding household awareness — a GPU co-tenant, not an LLM.',
            badge: 'TensorRT',
            probe: { url: `${FRIGATE}/api/version` },
          },
          {
            id: 'plex',
            name: 'Plex',
            port: 32400,
            model: 'NVENC transcode',
            roles: ['media transcode'],
            purpose:
              'Media transcode — the other GPU co-tenant. Listed because it competes for this card, not because Hearth infers on it.',
            badge: 'NVENC',
            probe: { url: `${PLEX}/identity` },
          },
        ],
      },
      {
        id: 'glacier-ada2',
        kind: 'gpu',
        label: 'RTX 6000 Ada #2',
        tier: 'Deep + vision',
        detail: '48 GB · ~960 GB/s · GPU-510eee08',
        services: [
          {
            id: 'deep-35b',
            name: 'llama.cpp',
            port: 8201,
            model: 'Qwen3.6-35B-A3B Heretic Q5_K_M',
            roles: [
              'specialist_deliberation',
              'deep_consult',
              'specialist_thinking',
              'judgment',
              'research_extract',
              'librarian',
              'reflector',
              'scribe_writer',
              'specialist_drafter',
              'concierge_drafter',
              // vision joined this lane in the 2026-08-14 one-brain re-tier
              // (f16 mmproj on the same server; the :8203 VL unit retired).
              'vision',
            ],
            purpose:
              'The think tier — deliberation briefs, deep_consult escalation, research, the five LLM-judge guards, and (since 2026-08-14) the vision role via the f16 mmproj. Split off the interactive lane 2026-07-30 so a chat turn never queues behind a deliberation sweep.',
            badge: '-np 8 · 49K/slot',
            probe: {
              url: `http://${GLACIER}:8201/v1/models`,
              metrics: { url: `http://${GLACIER}:8201/metrics`, engine: 'llamacpp' },
            },
          },
          // vision-27b node removed 2026-08-15: the dedicated :8203 VL server
          // (llamacpp-27b-vl-glacier.service) retired in the 2026-08-14 one-brain
          // re-tier; `vision` now rides the deep lane above (:8201, f16 mmproj).
        ],
      },
      {
        id: 'glacier-cpu',
        kind: 'cpu',
        label: 'Xeon CPU',
        tier: 'OCR · status',
        detail: '96t · AMX BF16 · NUMA-pinned',
        services: [
          {
            id: 'status-flavor',
            name: 'llama.cpp · container',
            port: 8202,
            model: 'Qwen2.5-1.5B-Instruct Q4_K_M',
            roles: ['status_flavor'],
            purpose:
              'The one-line "thinking…" phrase under the typing bubble. Cosmetic + fail-open, in system RAM off both GPUs so it can never contend.',
            badge: 'CPU · RAM',
            // No metrics spec: this older llama.cpp container build serves none.
            probe: { url: `http://${GLACIER}:8202/v1/models` },
          },
          {
            id: 'ocr-paddle',
            name: 'hearth-ocr',
            model: 'PaddleOCR',
            roles: ['ocr'],
            purpose: 'OCR fallback when on-device Vision OCR comes back empty.',
            badge: 'fallback',
            // Probed only when configured — otherwise rendered informational.
            // `/health` specifically: the root path 404s, which the <500 rule
            // still scores as up, so any process answering on that host:port
            // would read as a healthy PaddleOCR. /health returns {"ok":true}.
            ...(OCR_BASE ? { probe: { url: `${OCR_BASE}/health` } } : {}),
          },
        ],
      },
    ],
  },
  {
    id: 'forza',
    name: 'forza',
    ip: '192.168.0.188',
    role: 'The big-judge lane — the 122B escalation target, plus GPU image gen',
    kind: 'compute',
    hardware: 'DGX Spark · GB10 · 128 GB unified · ~273 GB/s',
    units: [
      {
        id: 'forza-gb10',
        kind: 'gpu',
        label: 'GB10',
        tier: 'Deep judge · image gen',
        detail: '128 GB unified · ~273 GB/s',
        services: [
          {
            id: 'deep-judge-122b',
            name: 'llama.cpp',
            port: 8090,
            model: 'Qwen3.5-122B-A10B UD-Q4_K_XL (VL)',
            roles: ['deep_consult'],
            purpose:
              "consult_deep_model's escalation target — a chat turn hands off a hard sub-question and gets the big judge back, think-ON. Natively VL, so deep image work lands here too.",
            badge: '-np 2 · 32K ctx · think-ON',
            probe: {
              url: `http://${FORZA}:8090/v1/models`,
              metrics: { url: `http://${FORZA}:8090/metrics`, engine: 'llamacpp' },
            },
          },
          {
            id: 'imagegen-krea2',
            name: 'ComfyUI',
            port: 8188,
            model: 'Krea 2 Turbo',
            roles: ['generate_image'],
            purpose:
              'The generate_image chat tool, on GPU. The only forza service Hearth still calls — the deep tier left in 2026-06, vision in 2026-07.',
            badge: 'GPU',
            probe: { url: `${IMAGEGEN_COMFYUI}/system_stats` },
          },
        ],
      },
    ],
  },
  {
    id: 'avalanche',
    name: 'the workstation',
    ip: '192.168.0.11',
    role: 'Real-browser actions for hostile / JS-heavy pages',
    kind: 'browser',
    hardware: 'Browser host · agentd + warmed Firefox',
    units: [
      {
        id: 'avalanche-host',
        kind: 'cpu',
        label: 'Browser host',
        tier: 'Web actions',
        detail: 'agentd · Firefox',
        services: [
          {
            id: 'agentd',
            name: 'agentd',
            port: 4446,
            model: 'Firefox (warmed profile)',
            roles: ['browse_url'],
            purpose:
              'The browse_url escape hatch — drives a real warmed browser when web_fetch_clean fails. Wakes on demand.',
            badge: 'on-demand',
            probe: { url: `http://${AVALANCHE}:4446/health` },
          },
        ],
      },
    ],
  },
];

// ── Probing ─────────────────────────────────────────────────────────────────

const PROBE_TIMEOUT_MS = 3000;
const METRICS_TIMEOUT_MS = 2500;
const CACHE_TTL_MS = 5000;

/** Prometheus metric names we surface, per engine. */
const METRIC_ALLOW: Record<MetricsEngine, string[]> = {
  // Verified against a live llama-server /metrics 2026-07-30. NOT emitted by
  // this build (and so deliberately absent): `llamacpp:kv_cache_usage_ratio`,
  // which the allow-list carried for two months without ever matching a line.
  llamacpp: [
    'llamacpp:requests_processing',
    'llamacpp:requests_deferred',
    'llamacpp:predicted_tokens_seconds',
    'llamacpp:n_busy_slots_per_decode',
  ],
  vllm: [
    'vllm:num_requests_running',
    'vllm:num_requests_waiting',
    'vllm:gpu_cache_usage_perc',
  ],
};

function parse_prometheus(text: string, allow: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const line of text.split('\n')) {
    if (!line || line.charCodeAt(0) === 35 /* '#' */) continue;
    const m = line.match(/^([a-zA-Z_:][a-zA-Z0-9_:]*)(?:\{[^}]*\})?\s+([0-9.eE+-]+)/);
    if (!m || m[1] === undefined || m[2] === undefined) continue;
    if (!allow.includes(m[1])) continue;
    const val = Number(m[2]);
    if (!Number.isFinite(val)) continue;
    // Sum across label-sets (vLLM tags metrics by model_name).
    out[m[1]] = (out[m[1]] ?? 0) + val;
  }
  return out;
}

async function scrape_metrics(
  spec: NonNullable<ProbeSpec['metrics']>,
): Promise<Record<string, number> | undefined> {
  try {
    const res = await fetch(spec.url, { signal: AbortSignal.timeout(METRICS_TIMEOUT_MS) });
    if (!res.ok) return undefined;
    const text = await res.text();
    const parsed = parse_prometheus(text, METRIC_ALLOW[spec.engine]);
    return Object.keys(parsed).length > 0 ? parsed : undefined;
  } catch {
    return undefined;
  }
}

async function probe_service(svc: ServiceDef, checked_at: string): Promise<ServiceHealth> {
  if (!svc.probe) return { status: 'unknown', checked_at };
  const t0 = performance.now();
  try {
    const res = await fetch(svc.probe.url, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      redirect: 'manual',
    });
    const latency_ms = Math.round(performance.now() - t0);
    // Connection succeeded → the service is listening. A 5xx means it's
    // up but unhealthy (model still loading, OOM) → degraded; everything
    // else that resolved (2xx/3xx/4xx) counts as up.
    const status: HealthStatus = res.status >= 500 ? 'degraded' : 'up';
    const health: ServiceHealth = {
      status,
      latency_ms,
      http_status: res.status,
      checked_at,
    };
    if (status === 'up' && svc.probe.metrics) {
      const metrics = await scrape_metrics(svc.probe.metrics);
      if (metrics) health.metrics = metrics;
    }
    return health;
  } catch {
    // Timeout / connection refused / DNS → down.
    return { status: 'down', latency_ms: Math.round(performance.now() - t0), checked_at };
  }
}

let cache: { ts: number; payload: TopologyPayload } | null = null;

export async function build_topology(): Promise<TopologyPayload> {
  const now = Date.now();
  if (cache && now - cache.ts < CACHE_TTL_MS) return cache.payload;

  const checked_at = new Date().toISOString();
  const t0 = performance.now();

  const flat: ServiceDef[] = TOPOLOGY.flatMap((b) => b.units.flatMap((u) => u.services));
  const results = await Promise.all(flat.map((svc) => probe_service(svc, checked_at)));

  const health: Record<string, ServiceHealth> = {};
  const summary = { up: 0, degraded: 0, down: 0, unknown: 0, total: flat.length };
  flat.forEach((svc, i) => {
    const h = results[i] ?? { status: 'unknown' as const, checked_at };
    health[svc.id] = h;
    summary[h.status] += 1;
  });

  const payload: TopologyPayload = {
    generated_at: checked_at,
    probe_ms: Math.round(performance.now() - t0),
    boxes: TOPOLOGY,
    health,
    summary,
  };
  cache = { ts: now, payload };
  return payload;
}

// ── Router ──────────────────────────────────────────────────────────────────

export function create_topology_router(): Hono {
  const r = new Hono();
  r.get('/', async (c) => {
    const payload = await build_topology();
    return c.json(payload, 200, { 'Cache-Control': 'no-store' });
  });
  return r;
}
