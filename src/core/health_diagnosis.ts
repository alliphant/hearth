/**
 * health_diagnosis — the self-diagnosis + scored-fix engine (2026-06-20).
 *
 * The system-health monitor (system_health.ts) DETECTS a down dependency and
 * escalates ("Firecrawl down, 98% of calls failing") — but the escalation is
 * SHALLOW. A real diagnosis is the work a human does by hand: read the
 * container logs, find the actual crash (the live case was
 * `firecrawl-worker Exited (1) ELIFECYCLE`, visible only in the worker's
 * logs), reason about the root cause, and propose + score fixes. This module
 * automates that, ALL on the LOCAL deep model — no external LLM.
 *
 * The pipeline, mirroring Kate's deep-research runner (gather → reason →
 * adversarially verify) but for an INCIDENT instead of a subject:
 *
 *   1. gather_evidence_pack — read-only, all local: the actual ERROR SAMPLES
 *      from the audit log for the dep's backs_tools (strings, not just a rate),
 *      the reachability PROBE detail, the resolved CONFIG (base URLs), and the
 *      failing service's CONTAINER LOGS via the guarded ops-relay /logs.
 *   2. diagnose (local deep tier) — root-cause grounded ONLY in the evidence,
 *      then the shared fact critic drops any specific the evidence doesn't
 *      support (reuse of the deep-research grounding discipline, so the model
 *      can't fabricate a cause).
 *   3. score (local deep tier, adversarial) — a skeptical second pass rates
 *      each typed candidate fix on likelihood / risk / reversibility /
 *      blast-radius; a deterministic composite ranks them and picks one.
 *
 * Every fix carries an `apply_via` naming an EXISTING gated tool
 * (restart_service / apply_low_risk_fix / propose_code_edit / propose_code_change
 * / escalate / manual) — this module never applies anything itself, so there is
 * NO new privileged apply surface. The tool that wraps this
 * (diagnose_dependency) persists the diagnosis + files an owner proposal and
 * lets Beatrice apply through those existing gates.
 *
 * FAIL-OPEN + KILL-SWITCHED end to end: a logs/probe/model/critic outage
 * degrades (inconclusive diagnosis, neutral scores, an escalate fix), never
 * throws; HEARTH_HEALTH_DIAGNOSIS=0 disables it.
 */
import type { Database } from 'bun:sqlite';
import type { LLMRole, LLMRouter } from '@core/llm';
import {
  assess_system_health,
  type DependencyDef,
  type HealthStatus,
} from '@core/system_health';
import { HealthIncidentStore, down_duration_human } from '@memory/stores/system_health';
import { assess_factual_grounding } from '@core/fact_critic';
import { build_grounding_context, build_grounding_evidence } from '@core/provenance';
import { fetch_logs, type OpsLogsResult } from '@connectors/ops_relay';

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

export type FixType = 'restart' | 'config_change' | 'code_change' | 'escalate';

/** The EXISTING gated tool/path a fix is applied through — never a new one. */
export type ApplyVia =
  | 'restart_service'
  | 'apply_low_risk_fix'
  | 'propose_code_edit'
  | 'propose_code_change'
  | 'manual'
  | 'escalate';

/** The set of sanctioned apply paths. The smoke asserts every scored fix's
 *  apply_via is in here — there is no novel apply surface. */
export const EXISTING_GATES: ReadonlySet<ApplyVia> = new Set<ApplyVia>([
  'restart_service',
  'apply_low_risk_fix',
  'propose_code_edit',
  'propose_code_change',
  'manual',
  'escalate',
]);

export interface CandidateFix {
  type: FixType;
  /** Short imperative title. */
  title: string;
  /** Concrete, executable detail — what to actually do. */
  detail: string;
  /** Container name / env key / file path, or '' when N/A. */
  target: string;
  /** Which EXISTING gate applies it. */
  apply_via: ApplyVia;
}

export interface FixScore {
  /** 0..1 — how likely this fix actually resolves the root cause. */
  likelihood_to_resolve: number;
  risk: 'low' | 'medium' | 'high';
  reversibility: 'easy' | 'moderate' | 'hard';
  blast_radius: 'contained' | 'service' | 'broad';
  /** Deterministic composite of the above (0..1). The ranking key. */
  confidence: number;
  rationale: string;
}

export interface ScoredFix extends CandidateFix {
  score: FixScore;
}

export interface ErrorSample {
  ts: string;
  tool_name: string;
  message: string;
}

export interface EvidencePack {
  dependency: string;
  label: string;
  status: HealthStatus;
  impact: string;
  backs_tools: string[];
  restartable: boolean;
  restart_service: string | null;
  probe_reachable: boolean | null;
  probe_detail: string | null;
  error_rate: number | null;
  calls: number;
  errors: number;
  /** Resolved config the model may reason about (base URLs — no secrets). */
  config: Record<string, string>;
  error_samples: ErrorSample[];
  /** Demuxed container log tail, or null when the relay is unwired/failed. */
  container_logs: string | null;
  logs_source: 'relay' | 'unavailable';
  logs_note: string | null;
  incident: {
    id: string;
    first_seen: string;
    status: string;
    restart_attempts: number;
    down_for: string;
  } | null;
}

export interface Diagnosis {
  dependency: string;
  root_cause: string;
  /** 0..1 confidence in the diagnosis itself. */
  confidence: number;
  inconclusive: boolean;
  /** Ranked best-first. */
  fixes: ScoredFix[];
  /** Index into `fixes` of the recommended pick; -1 when there are none. */
  recommended_index: number;
  /** Specifics the grounding critic dropped from the narrative. */
  ungrounded_dropped: string[];
  evidence: EvidencePack;
  model: string;
}

/* ------------------------------------------------------------------ */
/* Tunables (read at call time — kill-switch idiom)                    */
/* ------------------------------------------------------------------ */

export function health_diagnosis_enabled(): boolean {
  return process.env.HEARTH_HEALTH_DIAGNOSIS !== '0';
}

function int_env(name: string, dflt: number, lo: number, hi: number): number {
  const raw = Number.parseInt(process.env[name] ?? '', 10);
  const v = Number.isFinite(raw) && raw > 0 ? raw : dflt;
  return Math.max(lo, Math.min(v, hi));
}

/** Error-sample lookback window (hours). */
function sample_window_hours(): number {
  return int_env('HEARTH_HEALTH_DIAGNOSIS_WINDOW_HOURS', 48, 1, 720);
}
/** Distinct error messages to keep. */
function max_error_samples(): number {
  return int_env('HEARTH_HEALTH_DIAGNOSIS_SAMPLES', 12, 1, 50);
}
/** Container-log tail lines requested. */
function logs_tail(): number {
  return int_env('HEARTH_HEALTH_DIAGNOSIS_LOG_TAIL', 200, 20, 2000);
}
/** Below this composite confidence the recommended pick is treated as weak —
 *  the tool steers toward escalation rather than auto-applying. */
export function recommend_floor(): number {
  const raw = Number(process.env.HEARTH_HEALTH_DIAGNOSIS_FLOOR);
  return Number.isFinite(raw) && raw > 0 && raw < 1 ? raw : 0.45;
}

const ERROR_MSG_CAP = 320;
const LOG_CHAR_CAP = 8_000;

/* ------------------------------------------------------------------ */
/* Engine deps + seams                                                 */
/* ------------------------------------------------------------------ */

export type CompleteRoleFn = (
  role: LLMRole,
  args: { system: string; user: string; temperature?: number; max_tokens?: number },
) => Promise<string | null>;

export interface DiagnosisEngineDeps {
  db: Database;
  llm?: LLMRouter;
  now?: Date;
  /** Smoke seams — all default to the real local-model / connector paths. */
  complete_role_fn?: CompleteRoleFn;
  verify_fn?: typeof assess_factual_grounding;
  assess_fn?: typeof assess_system_health;
  fetch_logs_fn?: (service: string, tail: number) => Promise<OpsLogsResult>;
  incidents?: HealthIncidentStore;
}

/** Default LLM call — one role, fail-open to null on any error. Used by the
 *  diagnosis + scoring passes (both deep-tier, think-off structured output). */
function default_complete(llm: LLMRouter | undefined): CompleteRoleFn {
  return async (role, opts) => {
    if (!llm) return null;
    let resolved;
    try {
      resolved = llm.for_role(role);
    } catch {
      return null;
    }
    try {
      const resp = await resolved.provider.complete({
        messages: [
          { role: 'system', content: opts.system },
          { role: 'user', content: opts.user },
        ],
        temperature: opts.temperature ?? 0.2,
        max_tokens: opts.max_tokens ?? 1400,
        think: false,
        ...resolved.defaults,
      });
      return resp.content;
    } catch {
      return null;
    }
  };
}

function strip_fence(s: string): string {
  const m = s.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
  return (m ? m[1]! : s).trim();
}

/* ------------------------------------------------------------------ */
/* 1. Evidence pack                                                    */
/* ------------------------------------------------------------------ */

/** Recent error STRINGS for a dep's backs_tools — the actual messages callers
 *  saw, from BOTH the `error` column and a connector's `{error}` inside
 *  execution_result (the silent-outage shape). Deduped by message, newest
 *  kept, capped. */
function error_samples(db: Database, tools: readonly string[], cutoff_iso: string): ErrorSample[] {
  if (tools.length === 0) return [];
  const placeholders = tools.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT ts, tool_name, error, execution_result
         FROM audit_log
        WHERE ts >= ? AND tool_name IN (${placeholders})
          AND (error IS NOT NULL
               OR (execution_result IS NOT NULL AND execution_result LIKE '%"error"%'))
        ORDER BY ts DESC
        LIMIT 400`,
    )
    .all(cutoff_iso, ...tools) as Array<{
    ts: string;
    tool_name: string;
    error: string | null;
    execution_result: string | null;
  }>;

  const out: ErrorSample[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    let msg = (r.error ?? '').trim();
    if (!msg && r.execution_result) {
      try {
        const parsed = JSON.parse(r.execution_result) as { error?: unknown };
        if (typeof parsed.error === 'string') msg = parsed.error.trim();
        else if (parsed.error != null) msg = JSON.stringify(parsed.error).slice(0, ERROR_MSG_CAP);
      } catch {
        // Not JSON — fall back to a raw slice around the "error" token.
        msg = r.execution_result.replace(/\s+/g, ' ').slice(0, ERROR_MSG_CAP);
      }
    }
    if (!msg) continue;
    msg = msg.slice(0, ERROR_MSG_CAP);
    const key = `${r.tool_name}::${msg.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ ts: r.ts, tool_name: r.tool_name, message: msg });
    if (out.length >= max_error_samples()) break;
  }
  return out;
}

export async function gather_evidence_pack(
  deps: DiagnosisEngineDeps,
  dep: DependencyDef,
): Promise<EvidencePack> {
  const now = deps.now ?? new Date();
  const assess = deps.assess_fn ?? assess_system_health;
  const incidents = deps.incidents ?? new HealthIncidentStore(deps.db);
  const cutoff = new Date(now.getTime() - sample_window_hours() * 3600_000).toISOString();

  // Probe + rate for THIS dep only (the assessor already reads both signals).
  let status: HealthStatus = 'down';
  let probe_reachable: boolean | null = null;
  let probe_detail: string | null = null;
  let error_rate: number | null = null;
  let calls = 0;
  let errors = 0;
  try {
    const snap = await assess(deps.db, { deps: [dep], now });
    const d = snap.dependencies[0];
    if (d) {
      status = d.status;
      probe_reachable = d.probe_reachable;
      probe_detail = d.probe_detail ?? null;
      error_rate = d.error_rate;
      calls = d.calls;
      errors = d.errors;
    }
  } catch {
    /* fail-open — the rest of the pack still assembles */
  }

  // Resolved config (base URLs the model may reason about — no secrets).
  const config: Record<string, string> = {};
  if (dep.probe) {
    const base = process.env[dep.probe.url_env] ?? dep.probe.default_url ?? '';
    if (base) config[dep.probe.url_env] = base;
  }
  if (dep.restart_service) config['restart_service'] = dep.restart_service;

  // Container logs via the guarded ops-relay (read-only) — fail-open.
  let container_logs: string | null = null;
  let logs_source: 'relay' | 'unavailable' = 'unavailable';
  let logs_note: string | null = null;
  const log_service = dep.restart_service ?? dep.name;
  if (dep.restartable && dep.restart_service) {
    const fetch_logs_fn = deps.fetch_logs_fn ?? ((svc, tail) => fetch_logs(svc, { tail }));
    try {
      const res = await fetch_logs_fn(log_service, logs_tail());
      if (res.ok && typeof res.logs === 'string') {
        container_logs = res.logs.slice(-LOG_CHAR_CAP);
        logs_source = 'relay';
      } else {
        logs_note =
          res.reason === 'relay_unavailable'
            ? 'container logs unavailable — ops-relay is not wired (set HEARTH_OPS_RELAY_URL to enable log-reading diagnosis)'
            : `container logs unavailable — ${res.reason}${res.detail ? `: ${res.detail}` : ''}`;
      }
    } catch (err) {
      logs_note = `container logs unavailable — ${err instanceof Error ? err.message : String(err)}`;
    }
  } else {
    logs_note = `${dep.label} is not a restartable container — no container logs to read (diagnose from error samples + probe)`;
  }

  const open = incidents.get_open(dep.name);

  return {
    dependency: dep.name,
    label: dep.label,
    status,
    impact: dep.impact,
    backs_tools: [...dep.backs_tools],
    restartable: dep.restartable,
    restart_service: dep.restart_service ?? null,
    probe_reachable,
    probe_detail,
    error_rate,
    calls,
    errors,
    config,
    error_samples: error_samples(deps.db, dep.backs_tools, cutoff),
    container_logs,
    logs_source,
    logs_note,
    incident: open
      ? {
          id: open.id,
          first_seen: open.first_seen,
          status: open.status,
          restart_attempts: open.restart_attempts,
          down_for: down_duration_human(open.first_seen, now),
        }
      : null,
  };
}

/** Render the evidence pack as the text the model diagnoses from AND the
 *  grounding corpus the critic checks against — so the diagnosis can only be
 *  grounded in what was actually gathered. */
export function render_evidence_text(pack: EvidencePack): string {
  const lines: string[] = [];
  lines.push(`DEPENDENCY: ${pack.label} (${pack.dependency})`);
  lines.push(`STATUS: ${pack.status}`);
  lines.push(`IMPACT: ${pack.impact}`);
  lines.push(`BACKS TOOLS: ${pack.backs_tools.join(', ') || '(none — probe-only)'}`);
  lines.push(
    `RESTARTABLE: ${pack.restartable ? `yes (container ${pack.restart_service})` : 'no'}`,
  );
  lines.push(
    `PROBE: ${
      pack.probe_reachable === null
        ? 'no probe configured'
        : pack.probe_reachable
          ? `reachable (${pack.probe_detail ?? 'ok'})`
          : `UNREACHABLE (${pack.probe_detail ?? 'connection failed'})`
    }`,
  );
  lines.push(
    `AUDIT ERROR RATE: ${
      pack.error_rate === null
        ? 'below volume floor'
        : `${Math.round(pack.error_rate * 100)}% of ${pack.calls} calls (${pack.errors} errors)`
    }`,
  );
  if (pack.incident) {
    lines.push(
      `INCIDENT: open since ${pack.incident.first_seen} (down for ${pack.incident.down_for}), ` +
        `${pack.incident.restart_attempts} restart attempt(s) so far`,
    );
  }
  lines.push('');
  lines.push('CONFIG:');
  const cfg_keys = Object.keys(pack.config);
  if (cfg_keys.length === 0) lines.push('  (none resolved)');
  else for (const k of cfg_keys) lines.push(`  ${k}=${pack.config[k]}`);
  lines.push('');
  lines.push(`ERROR SAMPLES (${pack.error_samples.length}):`);
  if (pack.error_samples.length === 0) lines.push('  (no error rows in the window)');
  else for (const s of pack.error_samples) lines.push(`  [${s.ts}] ${s.tool_name}: ${s.message}`);
  lines.push('');
  lines.push('CONTAINER LOGS:');
  if (pack.container_logs) lines.push(pack.container_logs);
  else lines.push(`  (${pack.logs_note ?? 'unavailable'})`);
  return lines.join('\n');
}

/* ------------------------------------------------------------------ */
/* 2. Diagnose (local deep tier, grounded)                             */
/* ------------------------------------------------------------------ */

const DIAGNOSE_SYSTEM =
  'You are an SRE diagnosing why an external dependency of a local household ' +
  'assistant is failing. You are given an EVIDENCE PACK gathered from the live ' +
  'system: the dependency status, the reachability PROBE, the resolved CONFIG ' +
  '(base URLs), recent ERROR SAMPLES (the actual error strings callers saw), and ' +
  "the failing service's CONTAINER LOGS.\n\n" +
  'Diagnose the ROOT CAUSE using ONLY this evidence. Rules:\n' +
  '- Ground every claim in the evidence. Quote the log line or error that shows ' +
  'the cause. If the logs/errors do NOT reveal a cause, set inconclusive=true and ' +
  'say what is missing — NEVER invent a cause, a config value, a log line, an ' +
  'error code, or a stack frame that is not in the evidence.\n' +
  '- Propose 1-4 CONCRETE, EXECUTABLE candidate fixes (not "investigate ' +
  'further"). Each fix has a type:\n' +
  '    "restart"       — restart the failing container (its name in target). ' +
  'apply_via "restart_service".\n' +
  '    "config_change" — change an env var or a config/*.yaml value (the exact ' +
  'key + value in detail/target). apply_via "apply_low_risk_fix" for a safe ' +
  'in-repo YAML toggle, else "manual" (an env/ops change the owner applies).\n' +
  '    "code_change"   — a source fix (the file + change in detail). apply_via ' +
  '"propose_code_edit".\n' +
  '    "escalate"      — hand to the owner with a SPECIFIC manual step (the step ' +
  'in detail). apply_via "escalate".\n' +
  '- A restart often does NOT fix a deeper fault — only propose it as the primary ' +
  'fix when the evidence points to a transient/wedged process.\n\n' +
  'Reply with ONLY this JSON, nothing else:\n' +
  '{"root_cause":"<grounded explanation>","confidence":0.0-1.0,' +
  '"inconclusive":true|false,"fixes":[{"type":"restart|config_change|code_change|' +
  'escalate","title":"<short>","detail":"<concrete what-to-do>","target":' +
  '"<container/env-key/file or empty>","apply_via":"restart_service|' +
  'apply_low_risk_fix|propose_code_edit|propose_code_change|manual|escalate"}]}';

const FIX_TYPES: ReadonlySet<FixType> = new Set<FixType>([
  'restart',
  'config_change',
  'code_change',
  'escalate',
]);

/** Coerce the model's apply_via to a sanctioned gate, defaulting by fix type so
 *  a garbled value can never name a novel apply surface. */
function normalize_apply_via(type: FixType, raw: unknown): ApplyVia {
  if (typeof raw === 'string' && EXISTING_GATES.has(raw as ApplyVia)) return raw as ApplyVia;
  switch (type) {
    case 'restart':
      return 'restart_service';
    case 'config_change':
      return 'apply_low_risk_fix';
    case 'code_change':
      return 'propose_code_edit';
    case 'escalate':
    default:
      return 'escalate';
  }
}

interface RawDiagnosis {
  root_cause: string;
  confidence: number;
  inconclusive: boolean;
  fixes: CandidateFix[];
}

/** The always-available escalate FLOOR — handing the call to a human who can
 *  see the live system is never wrong, so every diagnosis carries one. */
function default_escalate(pack: EvidencePack, reason?: string): CandidateFix {
  return {
    type: 'escalate',
    title: 'Escalate to the owner',
    detail:
      reason ??
      `Surface the diagnosis to Jasper so he can decide — ${pack.label} is ${pack.status} and a person can see the live deployment you can't.`,
    target: '',
    apply_via: 'escalate',
  };
}

/** A deterministic fail-open diagnosis when the model is unreachable/garbled —
 *  inconclusive, with a single safe fix derived from restartability. */
function fallback_diagnosis(pack: EvidencePack): RawDiagnosis {
  const fixes: CandidateFix[] = [];
  if (pack.restartable && pack.restart_service) {
    fixes.push({
      type: 'restart',
      title: `Restart ${pack.restart_service}`,
      detail: `Restart the ${pack.restart_service} container — a wedged process is the most common transient cause; the next health scan confirms whether it recovered.`,
      target: pack.restart_service,
      apply_via: 'restart_service',
    });
  }
  fixes.push(
    default_escalate(
      pack,
      `Could not diagnose ${pack.label} automatically (the local model was unavailable). A person should read the logs/config and act.`,
    ),
  );
  return {
    root_cause: `Automated diagnosis was unavailable; ${pack.label} is ${pack.status}. ${
      pack.error_samples[0]?.message ?? pack.probe_detail ?? 'See the evidence pack.'
    }`,
    confidence: 0.2,
    inconclusive: true,
    fixes,
  };
}

async function diagnose(
  deps: DiagnosisEngineDeps,
  pack: EvidencePack,
  complete: CompleteRoleFn,
): Promise<RawDiagnosis> {
  const evidence = render_evidence_text(pack);
  const content = await complete('research_extract', {
    system: DIAGNOSE_SYSTEM,
    user: `EVIDENCE PACK:\n\n${evidence}\n\nReply with ONLY the JSON.`,
    temperature: 0.2,
    max_tokens: 1600,
  });
  if (!content) return fallback_diagnosis(pack);
  try {
    const parsed = JSON.parse(strip_fence(content)) as {
      root_cause?: unknown;
      confidence?: unknown;
      inconclusive?: unknown;
      fixes?: Array<Record<string, unknown>>;
    };
    const root_cause =
      typeof parsed.root_cause === 'string' && parsed.root_cause.trim().length > 2
        ? parsed.root_cause.trim().slice(0, 4000)
        : fallback_diagnosis(pack).root_cause;
    const confidence =
      typeof parsed.confidence === 'number'
        ? Math.max(0, Math.min(1, parsed.confidence))
        : 0.5;
    const inconclusive = parsed.inconclusive === true;
    const fixes: CandidateFix[] = [];
    if (Array.isArray(parsed.fixes)) {
      for (const raw of parsed.fixes.slice(0, 4)) {
        const type = (typeof raw.type === 'string' ? raw.type : '') as FixType;
        if (!FIX_TYPES.has(type)) continue;
        const title = typeof raw.title === 'string' ? raw.title.trim().slice(0, 160) : '';
        const detail = typeof raw.detail === 'string' ? raw.detail.trim().slice(0, 1200) : '';
        if (!title && !detail) continue;
        fixes.push({
          type,
          title: title || type,
          detail: detail || title,
          target: typeof raw.target === 'string' ? raw.target.trim().slice(0, 200) : '',
          apply_via: normalize_apply_via(type, raw.apply_via),
        });
      }
    }
    if (fixes.length === 0) return { root_cause, confidence, inconclusive: true, fixes: fallback_diagnosis(pack).fixes };
    return { root_cause, confidence, inconclusive, fixes };
  } catch {
    return fallback_diagnosis(pack);
  }
}

/** Remove any line still asserting a dropped (ungrounded) specific — the same
 *  deterministic backstop the deep-research synthesizer uses. */
function scrub_dropped(narrative: string, dropped: string[]): string {
  if (dropped.length === 0) return narrative;
  const needles = dropped.map((d) => d.toLowerCase().trim()).filter((d) => d.length >= 3);
  if (needles.length === 0) return narrative;
  const kept = narrative
    .split('\n')
    .filter((line) => {
      const lc = line.toLowerCase();
      return !needles.some((n) => lc.includes(n));
    })
    .join('\n')
    .trim();
  return kept;
}

/* ------------------------------------------------------------------ */
/* 3. Score (local deep tier, adversarial) + rank                      */
/* ------------------------------------------------------------------ */

const SCORE_SYSTEM =
  'You are a SKEPTICAL SRE reviewer scoring proposed fixes for a dependency ' +
  'outage. You have the evidence pack, the diagnosed root cause, and the ' +
  'candidate fixes. Score each fix HONESTLY and conservatively — a restart ' +
  'often does NOT fix a deeper fault; a config guess is risky when you cannot ' +
  'see the live config; a code change is slow and high blast-radius. For each ' +
  'fix rate:\n' +
  '- likelihood_to_resolve: 0.0-1.0 — given the EVIDENCE, how likely this ' +
  'actually fixes the root cause. If the root cause is unknown/inconclusive, a ' +
  'restart is a coin flip (~0.4).\n' +
  '- risk: "low"|"medium"|"high" — chance it makes things worse / has side ' +
  'effects.\n' +
  '- reversibility: "easy"|"moderate"|"hard".\n' +
  '- blast_radius: "contained"|"service"|"broad".\n' +
  '- rationale: one short sentence.\n\n' +
  'Reply with ONLY this JSON, one entry per fix IN ORDER:\n' +
  '{"scores":[{"likelihood_to_resolve":0.0-1.0,"risk":"low|medium|high",' +
  '"reversibility":"easy|moderate|hard","blast_radius":"contained|service|broad",' +
  '"rationale":"<one sentence>"}]}';

const RISK_W = { low: 1, medium: 0.65, high: 0.35 } as const;
const REV_W = { easy: 1, moderate: 0.85, hard: 0.6 } as const;
const RISK_RANK = { low: 0, medium: 1, high: 2 } as const;
const TYPE_RANK: Record<FixType, number> = { restart: 0, config_change: 1, code_change: 2, escalate: 3 };

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

function composite(s: Pick<FixScore, 'likelihood_to_resolve' | 'risk' | 'reversibility'>): number {
  return clamp01(s.likelihood_to_resolve * RISK_W[s.risk] * REV_W[s.reversibility]);
}

/** Escalation is the stable FLOOR: always low-risk + easily reversible, with a
 *  fixed mid likelihood so a real fix only wins when it scores above it. Scored
 *  deterministically (never sent to the model). */
function escalate_score(): FixScore {
  const base = { likelihood_to_resolve: 0.5, risk: 'low' as const, reversibility: 'easy' as const, blast_radius: 'contained' as const };
  return { ...base, confidence: composite(base), rationale: 'Always available; hands the call to a human who can see the live system.' };
}

/** Neutral score for a fix the model didn't (or couldn't) rate — type-shaped so
 *  it isn't gamed: a code_change defaults riskier than a restart. */
function neutral_score(type: FixType): FixScore {
  const by_type: Record<FixType, Omit<FixScore, 'confidence' | 'rationale'>> = {
    restart: { likelihood_to_resolve: 0.4, risk: 'low', reversibility: 'easy', blast_radius: 'service' },
    config_change: { likelihood_to_resolve: 0.4, risk: 'medium', reversibility: 'moderate', blast_radius: 'service' },
    code_change: { likelihood_to_resolve: 0.4, risk: 'medium', reversibility: 'moderate', blast_radius: 'broad' },
    escalate: { likelihood_to_resolve: 0.5, risk: 'low', reversibility: 'easy', blast_radius: 'contained' },
  };
  const base = by_type[type];
  return { ...base, confidence: composite(base), rationale: 'Scoring unavailable — neutral default for this fix type.' };
}

interface RawScore {
  likelihood_to_resolve: number;
  risk: FixScore['risk'];
  reversibility: FixScore['reversibility'];
  blast_radius: FixScore['blast_radius'];
  rationale: string;
}

function parse_scores(content: string, n: number): (RawScore | null)[] {
  try {
    const parsed = JSON.parse(strip_fence(content)) as { scores?: Array<Record<string, unknown>> };
    if (!Array.isArray(parsed.scores)) return new Array(n).fill(null);
    const out: (RawScore | null)[] = [];
    for (const raw of parsed.scores.slice(0, n)) {
      const lk = typeof raw.likelihood_to_resolve === 'number' ? clamp01(raw.likelihood_to_resolve) : null;
      const risk = (['low', 'medium', 'high'] as const).includes(raw.risk as FixScore['risk'])
        ? (raw.risk as FixScore['risk'])
        : null;
      const rev = (['easy', 'moderate', 'hard'] as const).includes(raw.reversibility as FixScore['reversibility'])
        ? (raw.reversibility as FixScore['reversibility'])
        : null;
      const blast = (['contained', 'service', 'broad'] as const).includes(raw.blast_radius as FixScore['blast_radius'])
        ? (raw.blast_radius as FixScore['blast_radius'])
        : null;
      if (lk === null || risk === null || rev === null || blast === null) {
        out.push(null);
        continue;
      }
      out.push({
        likelihood_to_resolve: lk,
        risk,
        reversibility: rev,
        blast_radius: blast,
        rationale: typeof raw.rationale === 'string' ? raw.rationale.slice(0, 300) : '',
      });
    }
    while (out.length < n) out.push(null);
    return out;
  } catch {
    return new Array(n).fill(null);
  }
}

/**
 * Score every candidate fix and return them ranked best-first. Escalation
 * fixes are scored deterministically (the floor); everything else gets the
 * adversarial deep-model pass, falling back to a type-shaped neutral score on
 * any outage. Ranking is a pure, reproducible composite — given the scores the
 * order is deterministic.
 */
async function score_and_rank(
  pack: EvidencePack,
  diag: RawDiagnosis,
  complete: CompleteRoleFn,
): Promise<ScoredFix[]> {
  const real = diag.fixes.filter((f) => f.type !== 'escalate');
  let model_scores: (RawScore | null)[] = new Array(real.length).fill(null);
  if (real.length > 0) {
    const fix_list = real
      .map((f, i) => `${i + 1}. [${f.type}] ${f.title} — ${f.detail}${f.target ? ` (target: ${f.target})` : ''}`)
      .join('\n');
    const content = await complete('research_extract', {
      system: SCORE_SYSTEM,
      user:
        `EVIDENCE PACK:\n\n${render_evidence_text(pack)}\n\n` +
        `DIAGNOSED ROOT CAUSE: ${diag.root_cause}\n` +
        `(diagnosis ${diag.inconclusive ? 'INCONCLUSIVE' : 'conclusive'})\n\n` +
        `CANDIDATE FIXES:\n${fix_list}\n\nReply with ONLY the JSON.`,
      temperature: 0.2,
      max_tokens: 1200,
    });
    if (content) model_scores = parse_scores(content, real.length);
  }

  const scored: ScoredFix[] = [];
  let ri = 0;
  for (const f of diag.fixes) {
    if (f.type === 'escalate') {
      scored.push({ ...f, score: escalate_score() });
      continue;
    }
    const raw = model_scores[ri++];
    if (raw) {
      const { rationale, ...rest } = raw;
      scored.push({ ...f, score: { ...rest, confidence: composite(rest), rationale } });
    } else {
      scored.push({ ...f, score: neutral_score(f.type) });
    }
  }

  // Pure, deterministic rank: confidence desc, then lower risk, then cheaper
  // type (restart < config < code < escalate).
  scored.sort((a, b) => {
    if (b.score.confidence !== a.score.confidence) return b.score.confidence - a.score.confidence;
    if (RISK_RANK[a.score.risk] !== RISK_RANK[b.score.risk]) return RISK_RANK[a.score.risk] - RISK_RANK[b.score.risk];
    return TYPE_RANK[a.type] - TYPE_RANK[b.type];
  });
  return scored;
}

/* ------------------------------------------------------------------ */
/* Orchestrator                                                        */
/* ------------------------------------------------------------------ */

/**
 * Run the full diagnosis for one dependency: gather → diagnose (grounded) →
 * score → rank. The single entry point the diagnose_dependency tool calls.
 * Fail-open at every step; returns a usable (possibly inconclusive) Diagnosis.
 */
export async function run_diagnosis(
  deps: DiagnosisEngineDeps,
  dep: DependencyDef,
): Promise<Diagnosis> {
  const complete = deps.complete_role_fn ?? default_complete(deps.llm);
  const pack = await gather_evidence_pack(deps, dep);
  const diag = await diagnose(deps, pack, complete);

  // Guarantee the escalate FLOOR so a real fix only "wins" by scoring above it,
  // and there is always a safe recommendation.
  if (!diag.fixes.some((f) => f.type === 'escalate')) {
    diag.fixes.push(default_escalate(pack));
  }

  // Grounding discipline: drop any specific in the narrative that the gathered
  // evidence doesn't support, so the model can't fabricate a cause. Fail-open.
  const ungrounded_dropped: string[] = [];
  const verify = deps.verify_fn ?? assess_factual_grounding;
  if (deps.llm && !diag.inconclusive) {
    try {
      const evidence_parts = { tool_results: [render_evidence_text(pack)] };
      const res = await verify({
        reply: diag.root_cause,
        grounding: build_grounding_context(evidence_parts),
        evidence_text: build_grounding_evidence(evidence_parts),
        llm: deps.llm,
        self_identity: `Beatrice, the enterprise trainer, diagnosing the ${dep.label} dependency.`,
      });
      for (const u of res.unsupported) ungrounded_dropped.push(u.claim);
    } catch {
      /* fail-open — a critic outage never fabricates a drop */
    }
  }
  const root_cause = scrub_dropped(diag.root_cause, ungrounded_dropped) || diag.root_cause;
  // Dropping specifics lowers our confidence in the narrative.
  const confidence = clamp01(diag.confidence - Math.min(0.4, ungrounded_dropped.length * 0.15));

  const fixes = await score_and_rank(pack, diag, complete);
  const recommended_index =
    fixes.length === 0 ? -1 : 0; // ranked best-first; [0] is the pick

  return {
    dependency: dep.name,
    root_cause,
    confidence,
    inconclusive: diag.inconclusive,
    fixes,
    recommended_index,
    ungrounded_dropped,
    evidence: pack,
    model: deps.llm ? 'deep_consult' : 'fallback',
  };
}

/** A compact markdown rendering of a finished diagnosis — for the owner's
 *  proposal card and the persisted diagnosis_md. */
export function render_diagnosis_markdown(d: Diagnosis): string {
  const lines: string[] = [];
  lines.push(`# Diagnosis — ${d.evidence.label}`);
  lines.push('');
  lines.push(`**Status:** ${d.evidence.status}${d.evidence.incident ? ` (down for ${d.evidence.incident.down_for})` : ''}`);
  lines.push(`**Root cause** (confidence ${Math.round(d.confidence * 100)}%${d.inconclusive ? ', INCONCLUSIVE' : ''}):`);
  lines.push('');
  lines.push(d.root_cause);
  lines.push('');
  lines.push(`## Scored fixes (ranked)`);
  d.fixes.forEach((f, i) => {
    const pick = i === d.recommended_index ? ' ⭐ recommended' : '';
    lines.push(
      `${i + 1}. **${f.title}**${pick} — _${f.type}_, apply via \`${f.apply_via}\`\n` +
        `   - confidence ${Math.round(f.score.confidence * 100)}% · ` +
        `likelihood ${Math.round(f.score.likelihood_to_resolve * 100)}% · ` +
        `risk ${f.score.risk} · reversibility ${f.score.reversibility} · blast ${f.score.blast_radius}\n` +
        `   - ${f.detail}` +
        (f.score.rationale ? `\n   - _score rationale:_ ${f.score.rationale}` : ''),
    );
  });
  if (d.ungrounded_dropped.length > 0) {
    lines.push('');
    lines.push(`_Grounding critic dropped ${d.ungrounded_dropped.length} unsupported specific(s) from the narrative._`);
  }
  lines.push('');
  lines.push(
    `_Evidence: ${d.evidence.error_samples.length} error sample(s), ` +
      `container logs ${d.evidence.logs_source === 'relay' ? 'read' : 'unavailable'}, ` +
      `probe ${d.evidence.probe_reachable === null ? 'n/a' : d.evidence.probe_reachable ? 'reachable' : 'unreachable'}._`,
  );
  return lines.join('\n');
}
