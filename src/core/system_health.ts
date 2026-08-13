/**
 * system_health — the dependency health assessor (2026-06-20).
 *
 * Firecrawl's worker died 8 days ago and nothing noticed: every agent's web
 * research silently degraded and the only evidence was thousands of
 * `web_fetch_clean` timeouts in the audit log that nobody read. This module is
 * the smoke detector — it assesses every external dependency two complementary
 * ways, so both "down" and "silently erroring" are caught:
 *
 *   1. ENDPOINT PROBE — a light reachability check (any HTTP response = up; a
 *      connection failure/timeout = down). Catches a service nobody happened to
 *      call. (Lifted from scripts/doctor.ts's probe idea.)
 *   2. AUDIT-LOG ERROR RATE — per connector-tool error rate over a window,
 *      reading BOTH `audit_log.error` (runtime errors) AND a connector tool's
 *      `{error}` inside `execution_result` (which is where web_fetch_clean's
 *      failures land — the column is NULL, so the naive query misses them).
 *      Catches a service that's reachable but failing every call (Firecrawl).
 *
 * The assessor is a pure read over the DB + the probes; it never writes and
 * never throws (a probe error degrades that one dependency to `down`). The
 * incident edges, escalation, and remediation live in the scan tool + the
 * incident store; this just answers "what's the state right now."
 */
import { safe_fetch } from '@connectors/_audit';
import type { Database } from 'bun:sqlite';

export type HealthStatus = 'ok' | 'degraded' | 'down';

/** One dependency's probe definition. Reachability only — a 401/403/404 still
 *  means the service answered, so it's "up" for health purposes. */
export interface ProbeSpec {
  /** Env var holding the base URL. */
  url_env: string;
  default_url?: string;
  /** Health path appended to the base (e.g. '/health', '/'). */
  health_path: string;
}

export interface DependencyDef {
  name: string;
  label: string;
  /** Optional reachability probe (some deps are audit-only, e.g. browse_url). */
  probe?: ProbeSpec;
  /** Optional FUNCTIONAL probe — actively exercises the dependency (e.g. firecrawl
   *  scrapes a test URL) so health is accurate + immediate + TRAFFIC-INDEPENDENT,
   *  not inferred from a reachability GET or organic error-rate. Takes precedence
   *  over `probe`; the smoke seam (opts.probe_fn) still overrides both. */
  health_probe?: () => Promise<{ reachable: boolean; detail: string }>;
  /** Audit tool_names whose failures attribute to this dependency. */
  backs_tools: string[];
  /** How many consecutive down-scans before the scan PAGES the owner (alert
   *  hysteresis). The incident ledger opens + the auto-restart reflex fires on
   *  scan 1 regardless; this gates only the owner push / Beatrice flag /
   *  process-miss, so a dependency that self-heals within the confirmation
   *  window stays silent. Defaults to HEARTH_HEALTH_ALERT_AFTER_SCANS (2). Set
   *  to 1 for a safety-critical dep that should escalate on the first edge. */
  alert_after_scans?: number;
  /** Can the ops-relay restart it? (The relay's allowlist is the real gate.) */
  restartable: boolean;
  /** Docker container to restart — the ACTUAL failing piece (for Firecrawl that's
   *  firecrawl-worker, not firecrawl). */
  restart_service?: string;
  /** One-line note on what breaks for the household when this is down. */
  impact: string;
}

/**
 * Functional health probe for Firecrawl: actually scrape a stable URL and
 * confirm markdown comes back. A reachability GET /health returns 404 ("up")
 * even when the worker is dead and every scrape times out — the silent-outage
 * hole that hid the 8-day outage. This scrapes for real, so it catches a
 * FUNCTIONAL outage AND does so without waiting for organic web_fetch_clean
 * traffic: a low-/zero-volume outage is detected immediately (no "too few calls
 * to tell" blind spot). One retry absorbs a transient blip before declaring
 * down. Fail-SAFE: any error → down (the assessor itself never throws).
 */
/**
 * Functional health probe for SearXNG: run a REAL query and require results.
 *
 * The old probe hit `/`, which serves the search homepage — HTTP 200 from a
 * SearXNG whose every engine is rate-limited, CAPTCHA'd, or misconfigured, and
 * which returns zero results for everything. Verified against a live instance:
 * `/` answered 200 in the same minute the instance returned 0 results for 7 of
 * 8 queries. So a total search outage looked GREEN on the board while every
 * specialist experienced it as "the web has nothing on this" — a confident,
 * sourceless answer with nothing logged. That is the failure this closes.
 *
 * The query is deliberately a high-frequency term that any working general
 * engine answers, so zero results means the ENGINES are broken, not that the
 * query was obscure. `unresponsive_engines` is reported in the detail string so
 * the operator sees WHICH engines died, not just that search is down.
 *
 * One retry absorbs a transient blip. Fail-SAFE: any error → down.
 */
export async function searxng_search_probe(): Promise<{ reachable: boolean; detail: string }> {
  const base = (process.env.SEARXNG_BASE_URL ?? 'http://searxng:8080').replace(/\/$/, '');
  const attempt = async (): Promise<{ ok: boolean; detail: string }> => {
    const res = await safe_fetch(
      `${base}/search?q=wikipedia&format=json`,
      { method: 'GET' },
      20_000,
    );
    if (res.status === 0) return { ok: false, detail: res.error ?? 'unreachable' };
    try {
      const j = JSON.parse(res.body) as {
        results?: unknown[];
        unresponsive_engines?: unknown[];
      };
      const n = j.results?.length ?? 0;
      const dead = (j.unresponsive_engines ?? [])
        .map((e) => (Array.isArray(e) ? e.join(': ') : String(e)))
        .join('; ');
      if (n > 0) {
        // Healthy, but still surface partial engine failure — that is the early
        // warning before every engine is dead.
        return { ok: true, detail: dead ? `${n} results (degraded: ${dead})` : `${n} results` };
      }
      return {
        ok: false,
        detail: dead
          ? `0 results; engines failing: ${dead}`
          : '0 results for a control query (all engines returning nothing)',
      };
    } catch {
      return { ok: false, detail: `unparseable response (HTTP ${res.status})` };
    }
  };
  let r = await attempt();
  if (!r.ok) r = await attempt();
  return { reachable: r.ok, detail: r.detail };
}

export async function firecrawl_scrape_probe(): Promise<{ reachable: boolean; detail: string }> {
  const base = (process.env.FIRECRAWL_BASE_URL ?? 'http://firecrawl:3002').replace(/\/$/, '');
  const key = process.env.FIRECRAWL_API_KEY ?? '';
  const attempt = async (): Promise<{ ok: boolean; detail: string }> => {
    const res = await safe_fetch(
      `${base}/v1/scrape`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) },
        body: JSON.stringify({ url: 'https://example.com', formats: ['markdown'] }),
      },
      20_000,
    );
    if (res.status === 0) return { ok: false, detail: res.error ?? 'unreachable' };
    try {
      const j = JSON.parse(res.body) as { success?: boolean; data?: { markdown?: string } };
      if (j.success && (j.data?.markdown ?? '').length > 0) return { ok: true, detail: 'scrape ok' };
      return { ok: false, detail: `scrape failed (HTTP ${res.status})` };
    } catch {
      return { ok: false, detail: `unparseable response (HTTP ${res.status})` };
    }
  };
  let r = await attempt();
  if (!r.ok) r = await attempt(); // one retry absorbs a transient blip
  return { reachable: r.ok, detail: r.detail };
}

/**
 * The STT probe's audio payload, synthesized in memory (no bundled binary):
 * 0.5 s of 440 Hz sine at 16 kHz mono 16-bit PCM in a standard 44-byte-header
 * RIFF/WAVE container. Deterministic; exported for the smoke.
 */
export function build_stt_probe_wav(): Uint8Array<ArrayBuffer> {
  const sample_rate = 16_000;
  const n = sample_rate / 2; // 0.5 s
  const data_bytes = n * 2;
  const buf = new ArrayBuffer(44 + data_bytes);
  const view = new DataView(buf);
  const ascii = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
  };
  ascii(0, 'RIFF');
  view.setUint32(4, 36 + data_bytes, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sample_rate, true);
  view.setUint32(28, sample_rate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits/sample
  ascii(36, 'data');
  view.setUint32(40, data_bytes, true);
  for (let i = 0; i < n; i++) {
    const s = Math.sin((2 * Math.PI * 440 * i) / sample_rate) * 0.3;
    view.setInt16(44 + i * 2, Math.round(s * 32767), true);
  }
  return new Uint8Array(buf);
}

/**
 * Functional health probe for the speaches STT (the standalone `parakeet`
 * container on the LLM host :8093): POST a tiny synthesized WAV to the REAL
 * /v1/audio/transcriptions endpoint and confirm a transcription JSON comes
 * back. A reachability GET (/v1/models) lies for GPU services: on 2026-07-18
 * the container lost GPU access mid-life (nvidia-container-toolkit cgroup
 * revocation → NVML "Unknown Error") and /v1/models kept returning 200 while
 * every real transcription 500'd with "no CUDA-capable device is detected" —
 * every voice surface was deaf for ~21h with all health checks green. Only a
 * request that exercises the CUDA inference path can see that failure mode.
 * Resolves the SAME env the /app/api/transcribe relay uses, so the probe
 * grounds on the exact URL + model the live voice path depends on. One retry
 * absorbs a transient blip; fail-SAFE (any error → down).
 */
export async function stt_transcribe_probe(): Promise<{ reachable: boolean; detail: string }> {
  const base = (process.env.SPEACHES_URL ?? 'http://localhost:8093').replace(/\/$/, '');
  const model = process.env.STT_MODEL ?? 'deepdml/faster-whisper-large-v3-turbo-ct2';
  const attempt = async (): Promise<{ ok: boolean; detail: string }> => {
    const form = new FormData();
    form.append('file', new Blob([build_stt_probe_wav()], { type: 'audio/wav' }), 'health-probe.wav');
    form.append('model', model);
    // Force the encoder to run even though the probe tone isn't speech — with
    // VAD filtering, a no-speech clip can short-circuit to 200 without ever
    // touching CUDA, which is exactly the blind spot this probe closes.
    // (Servers without the param ignore unknown form fields.)
    form.append('vad_filter', 'false');
    // 30 s: a warm model answers in <1 s; the generous cap lets the first
    // probe after a container restart absorb the lazy model (re)load instead
    // of reading a recovering service as still-down.
    const res = await safe_fetch(`${base}/v1/audio/transcriptions`, { method: 'POST', body: form }, 30_000);
    if (res.status === 0) return { ok: false, detail: res.error ?? 'unreachable' };
    if (res.status !== 200) {
      // Surface the body — this is where the CUDA error lands, and it rides
      // the incident reason straight to the owner push / Beatrice flag.
      return { ok: false, detail: `transcription failed (HTTP ${res.status}: ${res.body.slice(0, 200)})` };
    }
    try {
      const j = JSON.parse(res.body) as { text?: unknown; transcript?: unknown };
      if (typeof j.text === 'string' || typeof j.transcript === 'string') {
        return { ok: true, detail: 'transcription ok' };
      }
      return { ok: false, detail: 'no text in transcription response' };
    } catch {
      return { ok: false, detail: `unparseable response (HTTP ${res.status})` };
    }
  };
  let r = await attempt();
  if (!r.ok) r = await attempt(); // one retry absorbs a transient blip
  return { reachable: r.ok, detail: r.detail };
}

/**
 * The critical-dependency registry. Extend this — don't special-case a check
 * elsewhere. Restart targets are the actual failing container (the relay
 * allowlist still has the final say).
 */
export const DEPENDENCIES: readonly DependencyDef[] = [
  {
    name: 'firecrawl',
    label: 'Firecrawl (web page fetch)',
    // FUNCTIONAL probe + probe-only (no backs_tools): the scrape test IS the
    // health signal, so detection is accurate, immediate, and independent of how
    // much anyone happened to browse — no "low-volume outage" blind spot, and no
    // 24h-error-rate lag/oscillation. A reachability GET returned 404 = "up" even
    // with a dead worker (the silent 8-day outage). A real outage → probe down →
    // the auto-restart reflex fires regardless of traffic volume.
    health_probe: firecrawl_scrape_probe,
    backs_tools: [],
    restartable: true,
    restart_service: 'firecrawl-worker',
    impact: 'all web-page reading — deep research, library subscriptions/commissions, every web_fetch_clean',
  },
  {
    name: 'searxng',
    label: 'SearXNG (free engines; Brave is the router-level last resort)',
    probe: { url_env: 'SEARXNG_BASE_URL', default_url: 'http://searxng:8080', health_path: '/' },
    // A real query, not a reachability GET — `/` returns 200 from an instance
    // whose every engine is dead. See searxng_search_probe.
    health_probe: searxng_search_probe,
    backs_tools: ['web_search'],
    restartable: true,
    restart_service: 'searxng',
    impact: 'all web search across every specialist',
  },
  {
    name: 'vision',
    label: 'Vision tier (Qwen3.8-27B deep+vision lane, the LLM host :8201)',
    // 2026-08-15: follows the `vision` role onto the consolidated deep+vision
    // lane (:8201, llamacpp-qwen38-deep-glacier.service — Qwen3.8-27B UD-Q6_K_XL
    // + f16 mmproj, the 2026-08-14 one-brain re-tier). The dedicated :8203 VL
    // unit (llamacpp-27b-vl-glacier.service) is retired-disabled. This is the
    // SECOND time this probe outlived its endpoint — 2026-07-30 it was the last
    // consumer of forza :8096, SSH-restarting a 28.75 GiB checkpoint twice a day
    // for a tier nothing called; 2026-08-14 it spent a night flagging the
    // retired :8203 DOWN and had Kate escalating a healthy tier to the owner.
    // A health registry that watches a retired node is not merely stale: it
    // manufactures work against it. When you move a role's endpoint, move its
    // DependencyDef in the same change.
    //
    // llama.cpp's /health returns 200 only once the model is loaded + serving
    // (503 "loading model" before that), so a plain reachability probe is an
    // accurate up/loaded signal — no functional probe needed. The tier is
    // low-volume (~250 calls/day), so the audit error-rate is a weak signal and
    // the probe is authoritative.
    probe: { url_env: 'HEARTH_VISION_HEALTH_URL', default_url: 'http://host.docker.internal:8201', health_path: '/health' },
    backs_tools: ['analyze_image', 'analyze_image_direct'],
    // NOT relay-restartable: the deep+vision lane is a systemd --user unit
    // (llamacpp-qwen38-deep-glacier.service), not a container, so the ops-relay's
    // Docker Engine API can't reach it. Escalate to the owner instead — the same
    // shape as `browser`. Don't re-add a restart_service ref without a relay path
    // that can actually action it (a ref the relay can't honor is a restart Kate
    // is told she can do and can't).
    restartable: false,
    impact: 'all image understanding — capture routing/classification, the away-monitor scene descriptions, consult_deep_model with images',
  },
  {
    name: 'browser',
    label: 'the workstation warmed-Firefox (bot-walled fetch)',
    // No probe — it WoL-sleeps; its failures land in browse_url audit rows.
    backs_tools: ['browse_url'],
    restartable: false, // a separate WoL box, not a container — escalate / WoL
    impact: 'reading bot-protected sites (Yelp, social, login-gated) when Firecrawl is blocked',
  },
  {
    name: 'embeddings',
    label: 'infinity embeddings + reranker (RAG)',
    probe: { url_env: 'HEARTH_EMBEDDINGS_HEALTH_URL', default_url: 'http://host.docker.internal:8091/health', health_path: '' },
    backs_tools: [], // used internally by RAG/SearchRouter — no tool_name; probe-only
    restartable: false,
    impact: 'vector retrieval + search reranking (degrades to FTS / unranked)',
  },
  {
    name: 'home_assistant',
    label: 'Home Assistant',
    probe: { url_env: 'HA_BASE_URL', default_url: 'http://homeassistant.local:8123', health_path: '/api/' },
    // PROBE-ONLY (no backs_tools). ha_get_state's "errors" are dominated by
    // entity-not-found 404s — a specialist guessing a candidate entity name
    // that doesn't exist (Iris's ioniq_5 charge sensors, Eleanor's soil-moisture
    // variants) while the real names succeed. HA ANSWERED every time (it's up;
    // the successful reads prove auth works) — the caller just asked for a
    // missing entity, and ha_get_state's `candidates` affordance hands back the
    // right names to retry. Counting those misses as HA-health failures marked
    // HA "degraded" on normal exploration (2026-06-26). A real HA outage is
    // connection-refused, which the probe catches; an entity-miss is a caller
    // concern, not a dependency one. (Unlike firecrawl, whose tool errors —
    // timeouts — genuinely mean the dependency is down.)
    backs_tools: [],
    restartable: false,
    impact: 'smart-home state reads',
  },
  {
    // The Satellite1 voice coordinator — backs Kate SPEAKING on the device:
    // dangerous-weather alerts, the emergency-alert drill, and spoken followups.
    // Probe-only (no tool_name); a /health probe catches a dead coordinator so
    // the AUTOMATED side of the emergency system surfaces a broken voice path
    // BEFORE a real alert needs it, not during.
    name: 'voice_coordinator',
    label: 'Satellite1 voice coordinator (Kate speaks)',
    probe: { url_env: 'HEARTH_VOICE_COORDINATOR_URL', default_url: 'http://host.docker.internal:8094', health_path: '/health' },
    backs_tools: [],
    // Safety-critical — it carries dangerous-weather + emergency alerts, so a
    // broken voice path must surface on the FIRST down-scan, not after the
    // confirmation window. The other deps (firecrawl, searxng, …) are research
    // surfaces where a self-healing blip shouldn't page; this one isn't.
    alert_after_scans: 1,
    restartable: true,
    restart_service: 'hearth-voice-coordinator',
    impact: 'Kate speaking on the Satellite1 — emergency alerts, the alert drill, and spoken followups (push still works)',
  },
  {
    // The speaches STT (the standalone `parakeet` docker-run container on
    // the LLM host :8093) — backs Kate HEARING: every voice surface transcribes
    // through it (the Satellite1 coordinator, the web /app mic, iOS voice).
    // FUNCTIONAL probe + probe-only (no backs_tools): transcription rides
    // relay/coordinator HTTP paths, not Tool calls, so there are no audit
    // rows to mine — and the 2026-07-18 outage proved reachability lies for a
    // GPU service (GPU access revoked mid-life; /v1/models stayed 200 while
    // every transcription 500'd with a CUDA error for ~21h, all checks
    // green). The probe transcribes for real, so a GPU-dead-but-listening
    // container reads DOWN.
    name: 'stt',
    label: 'speaches STT (parakeet — voice transcription)',
    health_probe: stt_transcribe_probe,
    backs_tools: [],
    // Voice-critical like the coordinator: with STT dead the household cannot
    // SPEAK to Kate anywhere, so escalate on the first down-scan.
    alert_after_scans: 1,
    restartable: true,
    // A docker restart re-runs the nvidia runtime hooks, which is the cure
    // for the cgroup-revocation failure mode. `parakeet` must be on
    // HEARTH_OPS_RESTART_ALLOWED for the relay to honor it.
    restart_service: 'parakeet',
    impact: 'all speech-to-text — Satellite1 voice turns, the web/app mic, iOS voice capture (Kate can speak but not hear)',
  },
];

export interface DependencyHealth {
  name: string;
  label: string;
  status: HealthStatus;
  /** Reachability: true=answered, false=unreachable, null=no probe configured. */
  probe_reachable: boolean | null;
  probe_detail?: string;
  /** Audit error rate over the window (0..1), null when below the volume floor. */
  error_rate: number | null;
  calls: number;
  errors: number;
  restartable: boolean;
  restart_service?: string;
  impact: string;
  /** Human reason for the status, for the alert/brief. */
  reason: string;
  /** Recovery hysteresis: the dep looks healthy RIGHT NOW on a short recent
   *  window (probe reachable-or-absent + enough recent calls, mostly clean),
   *  even if the longer error-rate window still holds the outage's failures.
   *  The scan closes an open incident on this so the restart breaker resets (a
   *  fresh incident starts at restart_attempts=0) before the 24h window decays.
   *  Optional: a hand-built snapshot without it degrades to the status-only close. */
  recovered_recent?: boolean;
  /** The recent window is FAILING (enough recent calls, mostly erroring) — the
   *  dep is actively broken NOW, not merely stale-elevated over the long window
   *  by old failures. The scan uses it to (a) gate the auto-restart reflex and
   *  (b) decide whether to RE-OPEN a freshly-recovered dep: a stale 24h window
   *  alone won't re-open it; only CURRENT failure (this, or a down probe) will. */
  recently_failing?: boolean;
}

export interface SystemHealthSnapshot {
  generated_at: string;
  dependencies: DependencyHealth[];
  /** Names of dependencies that are down or degraded (the ones that matter). */
  unhealthy: string[];
}

/* ------------------------------------------------------------------ */
/* Tunables (read at call time)                                        */
/* ------------------------------------------------------------------ */

function num_env(name: string, dflt: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v >= 0 ? v : dflt;
}
/** Error-rate window. */
function window_hours(): number {
  return num_env('HEARTH_HEALTH_WINDOW_HOURS', 24);
}
/** Below this many calls in the window, error rate isn't meaningful. */
function min_calls(): number {
  return num_env('HEARTH_HEALTH_MIN_CALLS', 5);
}
/** error_rate ≥ this ⇒ down. */
function down_rate(): number {
  return num_env('HEARTH_HEALTH_DOWN_RATE', 0.8);
}
/** error_rate ≥ this ⇒ degraded. */
function degraded_rate(): number {
  return num_env('HEARTH_HEALTH_DEGRADED_RATE', 0.3);
}
/** Recovery-hysteresis window (hours): a SHORT recent window whose clean signal
 *  closes an open incident even while the longer error-rate window is still
 *  elevated. Fast-recover / slow-trip — the firecrawl-worker case where a
 *  restart works but the 24h window stays full of the outage's failures. */
function recovery_window_hours(): number {
  return num_env('HEARTH_HEALTH_RECOVERY_HOURS', 0.5);
}
/** Minimum recent calls before a clean recent window counts as recovered, so a
 *  single lucky call can't close an incident prematurely. */
function min_recovery_calls(): number {
  return num_env('HEARTH_HEALTH_RECOVERY_MIN_CALLS', 3);
}

/* ------------------------------------------------------------------ */
/* Probe + audit signals                                               */
/* ------------------------------------------------------------------ */

/** Injectable probe — default hits the real endpoint. Returns reachability:
 *  any HTTP response (even 404/401) = reachable; a connection error/timeout =
 *  not reachable. */
export type ProbeFn = (url: string) => Promise<{ reachable: boolean; detail: string }>;

const default_probe: ProbeFn = async (url) => {
  const res = await safe_fetch(url, { method: 'GET' }, 8000);
  // status 0 + error = could not connect; any status code = the service answered.
  if (res.status > 0) return { reachable: true, detail: `HTTP ${res.status}` };
  return { reachable: false, detail: res.error ?? 'unreachable' };
};

function probe_url(spec: ProbeSpec): string {
  const base = (process.env[spec.url_env] ?? spec.default_url ?? '').replace(/\/$/, '');
  return base + spec.health_path;
}

interface ToolErrorStat {
  calls: number;
  errors: number;
}

/**
 * Per-tool {calls, errors} over the window. An error is EITHER a populated
 * `error` column (runtime/system error) OR a connector tool that returned
 * `{error}` inside its `execution_result` (the column stays NULL). The second
 * clause is what makes a silent connector outage visible.
 */
function tool_error_stats(db: Database, tools: readonly string[], cutoff_iso: string): Map<string, ToolErrorStat> {
  const out = new Map<string, ToolErrorStat>();
  if (tools.length === 0) return out;
  const placeholders = tools.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT tool_name,
              COUNT(*) AS calls,
              SUM(
                CASE WHEN error IS NOT NULL
                       OR (execution_result IS NOT NULL AND execution_result LIKE '%"error"%')
                     THEN 1 ELSE 0 END
              ) AS errors
         FROM audit_log
        WHERE ts >= ? AND tool_name IN (${placeholders})
        GROUP BY tool_name`,
    )
    .all(cutoff_iso, ...tools) as Array<{ tool_name: string; calls: number; errors: number }>;
  for (const r of rows) out.set(r.tool_name, { calls: r.calls, errors: r.errors ?? 0 });
  return out;
}

function worst(a: HealthStatus, b: HealthStatus): HealthStatus {
  const rank = { ok: 0, degraded: 1, down: 2 } as const;
  return rank[a] >= rank[b] ? a : b;
}

/* ------------------------------------------------------------------ */
/* Assess                                                              */
/* ------------------------------------------------------------------ */

export async function assess_system_health(
  db: Database,
  opts: { probe_fn?: ProbeFn; now?: Date; deps?: readonly DependencyDef[] } = {},
): Promise<SystemHealthSnapshot> {
  const now = opts.now ?? new Date();
  const deps = opts.deps ?? DEPENDENCIES;
  const cutoff = new Date(now.getTime() - window_hours() * 3600_000).toISOString();
  const recent_cutoff = new Date(now.getTime() - recovery_window_hours() * 3600_000).toISOString();

  // One audit query covering every backs_tool across all deps, plus a tighter
  // recent-window pass that powers recovery hysteresis (close-on-recent-recovery).
  const all_tools = [...new Set(deps.flatMap((d) => d.backs_tools))];
  const stats = tool_error_stats(db, all_tools, cutoff);
  const recent_stats = tool_error_stats(db, all_tools, recent_cutoff);

  const out: DependencyHealth[] = [];
  for (const dep of deps) {
    // ── error-rate signal ──
    let calls = 0;
    let errors = 0;
    for (const t of dep.backs_tools) {
      const s = stats.get(t);
      if (s) {
        calls += s.calls;
        errors += s.errors;
      }
    }
    const rate = calls >= min_calls() ? errors / calls : null;
    let err_status: HealthStatus = 'ok';
    if (rate !== null) {
      if (rate >= down_rate()) err_status = 'down';
      else if (rate >= degraded_rate()) err_status = 'degraded';
    }

    // ── probe signal (functional health_probe > reachability probe) ──
    let probe_reachable: boolean | null = null;
    let probe_detail: string | undefined;
    let probe_status: HealthStatus = 'ok';
    if (dep.probe || dep.health_probe) {
      try {
        // opts.probe_fn (smoke seam) overrides everything — a functional-only dep
        // gets a synthetic `functional:<name>` url so the seam can match it. Else
        // the dep's own functional health_probe (firecrawl's active scrape); else
        // the default reachability GET.
        const r = opts.probe_fn
          ? await opts.probe_fn(dep.probe ? probe_url(dep.probe) : `functional:${dep.name}`)
          : dep.health_probe
            ? await dep.health_probe()
            : await default_probe(probe_url(dep.probe!));
        probe_reachable = r.reachable;
        probe_detail = r.detail;
        if (!r.reachable) probe_status = 'down';
      } catch (err) {
        // A throwing probe must never sink the whole assessment.
        probe_reachable = false;
        probe_detail = err instanceof Error ? err.message : String(err);
        probe_status = 'down';
      }
    }

    // ── recovery-hysteresis signal: does the dep look healthy on the recent
    //    window? (probe reachable-or-absent + enough recent calls, mostly clean) ──
    let recent_calls = 0;
    let recent_errors = 0;
    for (const t of dep.backs_tools) {
      const s = recent_stats.get(t);
      if (s) {
        recent_calls += s.calls;
        recent_errors += s.errors;
      }
    }
    const recovered_recent =
      probe_status === 'ok' &&
      recent_calls >= min_recovery_calls() &&
      recent_errors / recent_calls < degraded_rate();
    // Symmetric signal: the recent window is actively failing (enough recent
    // calls, ≥ the down rate erroring). Distinguishes a CURRENT outage from a
    // stale 24h window kept elevated only by old, pre-recovery failures.
    const recently_failing =
      recent_calls >= min_recovery_calls() &&
      recent_errors / recent_calls >= down_rate();

    const status = worst(err_status, probe_status);
    const reason =
      status === 'ok'
        ? 'healthy'
        : [
            probe_status !== 'ok' ? `unreachable (${probe_detail})` : null,
            rate !== null && err_status !== 'ok'
              ? `${Math.round(rate * 100)}% of ${calls} calls failing`
              : null,
          ]
            .filter(Boolean)
            .join('; ') || 'degraded';

    out.push({
      name: dep.name,
      label: dep.label,
      status,
      probe_reachable,
      ...(probe_detail !== undefined ? { probe_detail } : {}),
      error_rate: rate,
      calls,
      errors,
      restartable: dep.restartable,
      ...(dep.restart_service ? { restart_service: dep.restart_service } : {}),
      impact: dep.impact,
      reason,
      recovered_recent,
      recently_failing,
    });
  }

  return {
    generated_at: now.toISOString(),
    dependencies: out,
    unhealthy: out.filter((d) => d.status !== 'ok').map((d) => d.name),
  };
}
