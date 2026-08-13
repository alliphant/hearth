/**
 * scan_system_health — Kate's dependency health sweep (2026-06-20).
 *
 * The closed-loop detection half of "when something isn't working, help solve
 * it." Runs as Kate's background job (deterministic, no LLM, mirrors Mariah's
 * scan_program_health): assess every dependency, drive the incident ledger,
 * and on a flip-to-degraded/down EDGE escalate ONCE — file a process-miss for
 * Beatrice (who fixes), flag her inbox (wakes her), and push the owner. On a
 * recovery edge, close the incident. Idempotent: the incident store dedupes
 * (only a new edge escalates) and the miss evidence_ref collapses recurrences.
 *
 * NOT on Kate's LLM surfaces — the job is the trigger; manual catch-up via
 * POST /api/specialists/kate/fire_background_job?name=system_health_scan.
 */
import { z } from 'zod';
import type { Tool, ToolContext } from '@core/tool';
import type { ToolDeps } from '@core/tool_deps';
import type { MemoryClient } from '@memory/client';
import type { SpecialistInbox } from '@memory/stores/conversations';
import type { AppEventBus } from '@app/events';
import type { ProcessMissStore } from '@core/process_misses';
import {
  assess_system_health,
  DEPENDENCIES,
  type ProbeFn,
  type SystemHealthSnapshot,
} from '@core/system_health';
import { HealthIncidentStore, down_duration_human } from '@memory/stores/system_health';
import {
  restart_service as relay_restart_impl,
  ops_relay_configured as relay_configured_impl,
} from '@connectors/ops_relay';
import { push_text } from '@policy/push';
import { ulid } from 'ulid';

export interface ScanHealthDeps {
  db: import('bun:sqlite').Database;
  memory: MemoryClient;
  inbox?: SpecialistInbox;
  events?: AppEventBus;
  process_misses?: ProcessMissStore;
  /** Smoke seam. */
  probe_fn?: ProbeFn;
  assess_fn?: typeof assess_system_health;
  /** Smoke seams for the auto-restart reflex. */
  relay_restart_fn?: typeof relay_restart_impl;
  relay_configured_fn?: typeof relay_configured_impl;
}

function health_enabled(): boolean {
  return process.env.HEARTH_SYSTEM_HEALTH !== '0';
}

/** Auto-restart reflex kill switch (default ON). A restartable dependency the
 *  scan finds DOWN gets the cheap restart automatically (breaker-capped),
 *  instead of waiting for Beatrice's diagnosis — which mis-fired during the
 *  2026-06-24 firecrawl-worker outage (ranked restart last; worker sat dead 2
 *  days). HEARTH_HEALTH_AUTO_RESTART=0 reverts to flag-Beatrice-only. */
function auto_restart_enabled(): boolean {
  return process.env.HEARTH_HEALTH_AUTO_RESTART !== '0';
}
/** Lifetime restart cap per OPEN incident — the same knob restart_service uses,
 *  so the auto reflex and Beatrice's manual restarts share one budget. */
function max_restarts(): number {
  const v = Number(process.env.HEARTH_OPS_MAX_RESTARTS);
  return Number.isFinite(v) && v > 0 ? v : 2;
}
/** Don't re-fire within this window of the last restart (guards rapid manual
 *  re-scans; the hourly cadence + the breaker are the real bounds). */
const AUTO_RESTART_COOLDOWN_MS = 5 * 60_000;
function restarted_recently(last_restart_at: string | null, now_ms: number): boolean {
  if (!last_restart_at) return false;
  const t = new Date(last_restart_at).getTime();
  return Number.isFinite(t) && now_ms - t < AUTO_RESTART_COOLDOWN_MS;
}
/** The long error-rate window in ms — the post-recovery re-open suppression
 *  holds for this long after a recovery (after which the long window has decayed
 *  past the recovery, so a still-down signal is real again). Mirrors the
 *  assessor's HEARTH_HEALTH_WINDOW_HOURS (default 24h). */
function window_ms(): number {
  const v = Number(process.env.HEARTH_HEALTH_WINDOW_HOURS);
  return (Number.isFinite(v) && v > 0 ? v : 24) * 3600_000;
}
/** ALERT hysteresis: how many consecutive down-scans an incident must survive
 *  before the scan PAGES the owner (files the Beatrice miss + flag + owner
 *  push). The ledger opens + the auto-restart reflex still fire on scan 1; only
 *  the human-facing escalation waits. Default 2 — at the hourly cadence that's
 *  "still down ~an hour later," so firecrawl's nightly self-healing blip (down
 *  ~50 min, recovered by the next scan) never reaches the threshold and never
 *  alerts. A per-dependency `alert_after_scans` overrides this (voice_coordinator
 *  = 1, safety-critical). HEARTH_HEALTH_ALERT_AFTER_SCANS=1 reverts to
 *  escalate-on-first-edge globally. */
function default_alert_after_scans(): number {
  const v = Number(process.env.HEARTH_HEALTH_ALERT_AFTER_SCANS);
  return Number.isFinite(v) && v >= 1 ? Math.floor(v) : 2;
}

const InputSchema = z.object({});
const OutputSchema = z.object({
  enabled: z.boolean(),
  checked: z.number(),
  unhealthy: z.array(z.string()),
  new_incidents: z.array(z.string()),
  recovered: z.array(z.string()),
  auto_restarted: z.array(z.string()),
  escalated: z.number(),
});

type Input = z.infer<typeof InputSchema>;
type Output = z.infer<typeof OutputSchema>;

export function make_scan_system_health(deps: ScanHealthDeps): Tool<Input, Output> {
  return {
    name: 'scan_system_health',
    description:
      'Assess every external dependency (probe + audit-log error rate), drive the health-incident ledger, and on a new degraded/down edge file a process-miss for Beatrice, flag her, and push the owner. Background job; not a chat tool.',
    risk: 'write_internal',
    required_capabilities: ['monitor_system_health'],
    input_schema: InputSchema,
    output_schema: OutputSchema,
    volatile: true,

    yield: { none: true, reason: 'a detector — `unhealthy: []` after probing every dependency is the GOOD outcome, not a defect' },
    idempotency_key() {
      return `scan_system_health:${Math.floor(Date.now() / 60_000)}`;
    },

    async execute(_input, ctx: ToolContext): Promise<Output> {
      if (!health_enabled()) {
        return { enabled: false, checked: 0, unhealthy: [], new_incidents: [], recovered: [], auto_restarted: [], escalated: 0 };
      }
      const incidents = new HealthIncidentStore(deps.db);
      const assess = deps.assess_fn ?? assess_system_health;
      const snapshot: SystemHealthSnapshot = await assess(deps.db, {
        ...(deps.probe_fn ? { probe_fn: deps.probe_fn } : {}),
      });

      const new_incidents: string[] = [];
      const recovered: string[] = [];
      const auto_restarted: string[] = [];
      let escalated = 0;
      const do_relay_restart = deps.relay_restart_fn ?? relay_restart_impl;
      const relay_configured = deps.relay_configured_fn ?? relay_configured_impl;
      const by_name = new Map(snapshot.dependencies.map((d) => [d.name, d]));

      // 1. degraded/down dependencies → open/update incident; escalate on edge.
      //    A dep that's recovered_recent (healthy on the recent window) is on the
      //    mend — skip it here so we never open/escalate a fresh incident that
      //    step 2 would immediately close.
      for (const dep of snapshot.dependencies) {
        if (dep.status === 'ok' || dep.recovered_recent) continue;

        // Post-recovery re-open suppression: a dep that recently RECOVERED reads
        // status=down here only because the long error-rate window still holds
        // its pre-recovery failures (firecrawl after a worker restart: the 24h
        // rate stays ≥ down for hours while the worker serves fine). Don't
        // re-open + re-alert + auto-restart on that stale signal — only on
        // CURRENT failure (recently_failing, or a down probe). The suppression
        // lifts once the long window decays past the recovery (window_ms).
        if (dep.recently_failing !== true && dep.probe_reachable !== false) {
          const last_recov = incidents.last_recovered_at(dep.name);
          if (last_recov && Date.now() - new Date(last_recov).getTime() < window_ms()) {
            continue;
          }
        }

        const { incident } = incidents.open_or_update(
          dep.name,
          dep.status,
          dep.reason,
          { error_rate: dep.error_rate, calls: dep.calls, probe: dep.probe_detail ?? null },
        );
        const dep_def = DEPENDENCIES.find((d) => d.name === dep.name);

        // ALERT hysteresis — the ledger opened above and the auto-restart fires
        // below regardless, but PAGING THE OWNER waits until the incident has
        // survived `alert_after` consecutive scans. A blip that self-heals
        // before then (firecrawl recovering within the hour) never crosses the
        // threshold, so it never files a Beatrice miss, flags her, or pushes
        // Jasper — it just opens, auto-restarts, and closes silently. We escalate
        // at most once per incident (alerted_at latches it).
        const alert_after = dep_def?.alert_after_scans ?? default_alert_after_scans();
        const already_alerted = incident.alerted_at !== null;
        const should_escalate = !already_alerted && incident.observations >= alert_after;

        // Deterministic auto-restart reflex — a restartable dependency the scan
        // finds DOWN gets the cheap restart automatically (breaker-capped via
        // restart_attempts), instead of waiting for Beatrice to reason her way
        // there. Her diagnosis mis-fired during the 2026-06-24 firecrawl-worker
        // outage: the worker's log showed "Job done" (draining a backlog) while
        // every NEW fetch timed out, so she ranked restart LAST at 0.1 conf and
        // the worker sat dead 2 days. Runs every scan it's down (not just on the
        // edge, so a re-death recovers), capped + cooled-down + relay-gated; the
        // escalation below still hands Jasper the after-the-cap case.
        const restart_def = dep_def;
        if (
          auto_restart_enabled() &&
          dep.status === 'down' &&
          // CURRENT failure only — a down probe OR a recent window actively
          // erroring. Never auto-restart on a stale 24h window (e.g. a dep just
          // fixed out-of-band, with no recent failures); the suppression above
          // already skips most of these — this is defense-in-depth.
          (dep.probe_reachable === false || dep.recently_failing === true) &&
          restart_def?.restartable &&
          restart_def.restart_service &&
          incident.restart_attempts < max_restarts() &&
          !restarted_recently(incident.last_restart_at, Date.now()) &&
          relay_configured()
        ) {
          try {
            const res = await do_relay_restart(restart_def.restart_service);
            incidents.record_restart(dep.name);
            deps.memory.log_action({
              intent_id: ctx.intent_id,
              agent: ctx.specialist_id ?? 'kate',
              tool_name: 'restart_service',
              tool_input: { dependency: dep.name, auto: true },
              execution_result: {
                action: res.ok ? 'restarted' : 'restart_failed',
                auto: true,
                attempt: incident.restart_attempts + 1,
                ...(res.ok ? {} : { reason: res.detail ?? res.reason }),
              },
            });
            if (res.ok) {
              auto_restarted.push(dep.name);
              // Only narrate the restart to the owner once the incident has
              // crossed the alert threshold (or already did) — a silent restart
              // of a self-healing blip shouldn't page. The restart itself still
              // ran; the next scan closes the incident silently if it worked.
              if (should_escalate || already_alerted) {
                try {
                  await push_text(
                    `🔧 ${dep.label} looked down — auto-restarted \`${restart_def.restart_service}\` ` +
                      `(attempt ${incident.restart_attempts + 1}/${max_restarts()}). The next scan confirms recovery.`,
                    deps.memory,
                    ctx.intent_id ?? ulid(),
                    'system_health',
                  );
                } catch {
                  /* fail-open */
                }
              }
            }
          } catch {
            /* fail-open — a restart attempt must never sink the scan */
          }
        }

        // Below the confirmation threshold (or already escalated once) → stay
        // silent. The incident is open + (maybe) restarting; we just don't page.
        if (!should_escalate) continue;
        // Latch the escalation so a still-down incident on later scans never
        // re-pages — the one-alert-per-incident contract.
        incidents.mark_alerted(dep.name);
        new_incidents.push(dep.name);

        const sev = dep.status === 'down' ? 'high' : 'medium';

        // a) process-miss for Beatrice (she owns the fix).
        try {
          deps.process_misses?.create({
            subject_specialist_id: 'trainer',
            reporter: 'kate',
            task_summary: `Keep ${dep.label} healthy`,
            gap: `${dep.label} is ${dep.status}: ${dep.reason}. Affects ${dep.impact}.`,
            severity: sev,
            evidence_ref: `dependency:${dep.name}:health`,
          });
        } catch {
          /* fail-open */
        }

        // b) flag Beatrice (wakes her deliberation).
        if (deps.inbox) {
          try {
            const restart_line = dep.restartable && dep.restart_service
              ? `Restartable container \`${dep.restart_service}\` — try \`restart_service\`, then let the next scan confirm recovery; if a restart doesn't fix it, escalate to Jasper.`
              : `Not auto-restartable — diagnose + fix via your change pipeline, or escalate to Jasper.`;
            const inbox_id = deps.inbox.push({
              from_specialist_id: 'kate',
              to_specialist_id: 'trainer',
              kind: 'flag',
              body_md:
                `**Dependency ${dep.status.toUpperCase()}: ${dep.label}**\n\n` +
                `${dep.reason}. Affects: ${dep.impact}.\n\n${restart_line}`,
            });
            deps.events?.emit({
              type: 'inbox_message_added',
              message_id: inbox_id,
              from_specialist_id: 'kate',
              to_specialist_id: 'trainer',
              kind: 'flag',
              severity: 'high',
            });
          } catch {
            /* fail-open */
          }
        }

        // c) push the owner (severity high punches quiet hours).
        try {
          await push_text(
            `⚠️ ${dep.label} looks ${dep.status} — ${dep.reason}. (${dep.impact})`,
            deps.memory,
            ctx.intent_id ?? ulid(),
            'system_health',
          );
        } catch {
          /* fail-open */
        }
        escalated++;
      }

      // 2. recovery: open incidents whose dependency is now ok → close. Also
      //    close on recovered_recent — the dep is healthy on the recent window
      //    even though the long error-rate window (which still holds the
      //    outage's failures) hasn't decayed yet. Closing resets the restart
      //    breaker: the next genuine crash opens a fresh incident at attempts=0.
      for (const open of incidents.list_open()) {
        const cur = by_name.get(open.dependency);
        if (cur && (cur.status === 'ok' || cur.recovered_recent)) {
          const closed = incidents.close(open.dependency);
          if (closed) {
            recovered.push(open.dependency);
            // Only announce recovery for an incident we actually PAGED about.
            // A self-healing blip that never crossed the alert threshold
            // (alerted_at still null) closes silently — no ⚠️ went out, so a ✅
            // would be noise about a problem the owner never saw.
            if (open.alerted_at !== null) {
              try {
                await push_text(
                  `✅ ${open.dependency} recovered (was ${open.status} for ${down_duration_human(open.first_seen)}).`,
                  deps.memory,
                  ctx.intent_id ?? ulid(),
                  'system_health',
                );
              } catch {
                /* fail-open */
              }
            }
          }
        }
      }

      deps.memory.log_action({
        intent_id: ctx.intent_id,
        agent: ctx.specialist_id ?? 'kate',
        tool_name: 'system_health_scan',
        tool_input: {},
        execution_result: {
          unhealthy: snapshot.unhealthy,
          new_incidents,
          recovered,
          auto_restarted,
          escalated,
        },
      });

      return {
        enabled: true,
        checked: snapshot.dependencies.length,
        unhealthy: snapshot.unhealthy,
        new_incidents,
        recovered,
        auto_restarted,
        escalated,
      };
    },
  };
}

export function create(deps: ToolDeps): Tool {
  return make_scan_system_health({
    db: deps.db,
    memory: deps.memory,
    ...(deps.inbox ? { inbox: deps.inbox } : {}),
    ...(deps.events ? { events: deps.events } : {}),
    ...(deps.process_misses ? { process_misses: deps.process_misses } : {}),
  }) as Tool;
}
