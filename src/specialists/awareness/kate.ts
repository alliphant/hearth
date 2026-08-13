/**
 * Kate's awareness handler (Prompt 6c).
 *
 * Reads:
 *   - specialist_inboxes WHERE to='kate' AND read_at IS NULL (staff flags)
 *   - proposals WHERE status='pending' AND ts_created > 24h ago (queue depth)
 *   - interrupts WHERE status='pending' AND ts > 1h ago
 *   - audit_log for recent specialist_turn entries (who's been active)
 *
 * Emits an observation when any of:
 *   - >0 unread inbox messages — severity matches the highest unread severity
 *   - pending proposal count > 8 — severity low (queue getting deep)
 *   - >0 pending interrupts — severity matches the interrupt
 *   - a proactive specialist has been silent >24h (degradation signal)
 *
 * No LLM. Cheap signal detection only.
 *
 * ── The perimeter, removed (2026-08-04) ─────────────────────────────────────
 * Kate used to drive the house's perimeter watch here — the away-from-home
 * camera monitor, face-discovery sweeps, and visitor ask-back. That whole
 * camera/vision layer was torn out with Frigate.
 *
 * What SURVIVES from that subsystem is the audit-signal watch (2026-08-05):
 * deny bursts, external error clusters, and drifted approved spends read
 * audit_log/proposals, not cameras — they were deleted as collateral in the
 * Frigate teardown and are reinstated below as `security_signals`.
 */

import type { AwarenessHandler, AwarenessHandlerDeps, AwarenessObservation, Severity } from '@core/loops';
import { severity_max } from '@core/loops';

const KIND_SEVERITY: Record<string, Severity> = {
  flag: 'medium-high',
  question: 'medium',
  fyi: 'low',
  consult_response: 'low',
};

const QUEUE_DEPTH_THRESHOLD = 8;

export const kate_awareness: AwarenessHandler = {
  specialist_id: 'kate',
  async run(deps: AwarenessHandlerDeps): Promise<AwarenessObservation | null> {
    return merge_observations(security_signals(deps), chief_of_staff_signals(deps));
  },
};

/**
 * The audit-signal watch — the surviving, camera-free half of the old
 * perimeter subsystem (`@specialists/awareness/perimeter`, deleted with the
 * Frigate teardown). Three cheap SQL reads per tick:
 *   - clustered gateway DENIES (misbehaving caller or a probe) —
 *     5+ in 15m → high + interrupt (triage-routed to Kate, never straight
 *     to the owner) + escalation so Kate judges SCOPE
 *   - EXTERNAL error clusters in audit_log → medium-high at 10+/15m
 *   - approved-but-unexecuted spend proposals sitting >24h → low (drift)
 * Fail-open: a throw here must never cost Kate her chief-of-staff signals.
 */
function security_signals(deps: AwarenessHandlerDeps): AwarenessObservation | null {
  try {
    const now = new Date();
    const fifteen_min_ago = new Date(now.getTime() - 15 * 60 * 1000).toISOString();
    const day_ago = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();

    // Errors in recent activity — EXTERNAL signal only. Filter out internal
    // specialist / runtime errors (Kate's failed tool args, Beatrice's
    // input-validation failures, the ingestor) because counting our OWN
    // immune-response noise creates a feedback loop: Kate fails → row logged
    // → escalation to Kate → Kate's deliberation fires → Kate fails again →
    // unbounded spiral. A failed tool call inside the house is a
    // system-health signal, not a security signal.
    // Reference: feedback_hearth_deliberation_spiral.md (the 106K-token
    // Lemonade orphan that drove this fix).
    //
    // 'cassandra' STAYS in this list (2026-07-26). The persona is dissolved
    // and writes no new rows, but years of historical rows carry
    // agent='cassandra'; dropping the id would reclassify that whole backlog
    // as EXTERNAL error signal and light up a false security cluster.
    const errors = (deps.db
      .prepare(
        `SELECT COUNT(*) as n FROM audit_log
         WHERE ts >= @t
           AND error IS NOT NULL
           AND agent NOT IN (
             'kate','cassandra','iris','eleanor','anya','vivian',
             'marguerite','cordelia','trainer','ingestor',
             'orchestrator','scribe','concierge'
           )`,
      )
      .get({ '@t': fifteen_min_ago }) as { n: number } | undefined)?.n ?? 0;

    // Gateway denies — look for clustered denials, a hallmark of either
    // a misbehaving caller or a probe.
    const denies = (deps.db
      .prepare(
        `SELECT COUNT(*) as n FROM audit_log
         WHERE ts >= @t AND gate_decision LIKE '%"deny"%'`,
      )
      .get({ '@t': fifteen_min_ago }) as { n: number } | undefined)?.n ?? 0;

    // Approved-but-unexecuted spend proposals sitting >24h — drift signal.
    const drifted_spends = (deps.db
      .prepare(
        `SELECT COUNT(*) as n FROM proposals
         WHERE status = 'approved'
           AND execution_kind IN ('dispatch','web_action')
           AND ts_decided IS NOT NULL
           AND ts_executed IS NULL
           AND ts_decided <= @t`,
      )
      .get({ '@t': day_ago }) as { n: number } | undefined)?.n ?? 0;

    if (errors === 0 && denies === 0 && drifted_spends === 0) return null;

    let severity: Severity = 'low';
    let suggests_interrupt = false;

    // Threshold logic: heavy clustering tips into medium-high → interrupt.
    if (denies >= 5) {
      severity = 'high';
      suggests_interrupt = true;
    } else if (errors >= 10 || denies >= 2) {
      severity = 'medium-high';
    } else if (drifted_spends > 0) {
      severity = 'low';
    }

    const summary_parts: string[] = [];
    if (errors > 0) summary_parts.push(`${errors} errors in last 15m`);
    if (denies > 0) summary_parts.push(`${denies} gateway denies in last 15m`);
    if (drifted_spends > 0) summary_parts.push(`${drifted_spends} approved-but-not-executed spends`);

    const obs: AwarenessObservation = {
      ts: now.toISOString(),
      summary: summary_parts.join(' · '),
      severity,
      details: {
        error_count_15m: errors,
        deny_count_15m: denies,
        drifted_spends_24h: drifted_spends,
      },
    };
    if (suggests_interrupt) {
      obs.suggests_interrupt = true;
      // A deny cluster is a signal for Kate to judge, not a push to fire at
      // the owner unfiltered.
      obs.interrupt_route = 'kate';
    }

    // Escalate on security-shaped clusters. The interrupt-to-owner and the
    // escalation are complementary: the owner gets the ping for high-severity
    // events; the escalation makes Kate spin up to judge SCOPE (is this a
    // probe, a runaway tool, a legitimate spike?). Dedupe by a 15-minute
    // bucket so a sustained pattern doesn't re-fire every tick.
    const bucket = Math.floor(now.getTime() / (15 * 60 * 1000));
    if (denies >= 5) {
      obs.escalate_to_kate = {
        dedupe_key: `perimeter-denies-cluster-${bucket}`,
        reason:
          `Gateway denied ${denies} actions in the last 15m. Could be a misbehaving tool or a probe. ` +
          `Worth an investigation.`,
        suggested_action:
          `Pull the gate_decision='deny' rows yourself with \`query_audit_log\` and judge whether ` +
          `it's a probe or one tool failing in a loop.`,
        source_label: 'the security-signal watch',
      };
    } else if (errors >= 10) {
      obs.escalate_to_kate = {
        dedupe_key: `perimeter-errors-cluster-${bucket}`,
        reason:
          `${errors} errors logged in the last 15m — well above baseline. Likely a tool or connector ` +
          `regression, not security-shaped, but worth knowing.`,
        suggested_action:
          `Group by tool_name with \`query_audit_log\`; if one tool dominates, that's your lead.`,
        source_label: 'the security-signal watch',
      };
    }
    return obs;
  } catch (err) {
    console.error('[kate] security-signal checks error (non-fatal):', err);
    return null;
  }
}

/**
 * Kate's own chief-of-staff signal scan — inbox backlog, proposal queue depth,
 * pending interrupts, and specialists that have gone quiet. Synchronous:
 * every read is a cheap indexed query.
 */
function chief_of_staff_signals(deps: AwarenessHandlerDeps): AwarenessObservation | null {
    try {
      const now = new Date();
      const day_ago = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
      const hour_ago = new Date(now.getTime() - 60 * 60 * 1000).toISOString();

      const unread_rows = deps.db
        .prepare(
          `SELECT kind FROM specialist_inboxes
           WHERE to_specialist_id = 'kate' AND read_at IS NULL`,
        )
        .all() as Array<{ kind: string }>;

      const pending_count = (deps.db
        .prepare(
          `SELECT COUNT(*) as n FROM proposals
           WHERE status = 'pending' AND ts_created >= @t`,
        )
        .get({ '@t': day_ago }) as { n: number } | undefined)?.n ?? 0;

      const pending_interrupts = deps.db
        .prepare(
          `SELECT id, severity FROM interrupts
           WHERE status = 'pending' AND ts >= @t`,
        )
        .all({ '@t': hour_ago }) as Array<{ id: string; severity: Severity }>;

      // Find proactive specialists silent for >24h (active/batched mode only).
      const silent: string[] = [];
      for (const s of deps.specialists.list()) {
        if (s.proactive.mode === 'reactive' || s.id === 'kate') continue;
        const last = (deps.db
          .prepare(
            `SELECT MAX(ts) as ts FROM audit_log
             WHERE agent = @sid AND tool_name IN ('specialist_turn','deliberation_pass','awareness_observation')`,
          )
          .get({ '@sid': s.id }) as { ts: string | null } | undefined)?.ts;
        if (!last || last < day_ago) silent.push(s.id);
      }

      const unread_count = unread_rows.length;

      if (
        unread_count === 0 &&
        pending_count <= QUEUE_DEPTH_THRESHOLD &&
        pending_interrupts.length === 0 &&
        silent.length === 0
      ) {
        return null;
      }

      let severity: Severity = 'low';
      for (const r of unread_rows) {
        const s = KIND_SEVERITY[r.kind] ?? 'low';
        severity = severity_max(severity, s);
      }
      for (const i of pending_interrupts) {
        severity = severity_max(severity, i.severity);
      }
      if (pending_count > QUEUE_DEPTH_THRESHOLD) {
        severity = severity_max(severity, 'low');
      }

      const summary_parts: string[] = [];
      if (unread_count > 0) summary_parts.push(`${unread_count} unread inbox`);
      if (pending_count > QUEUE_DEPTH_THRESHOLD) summary_parts.push(`${pending_count} pending proposals`);
      if (pending_interrupts.length > 0) summary_parts.push(`${pending_interrupts.length} pending interrupt(s)`);
      if (silent.length > 0) summary_parts.push(`silent: ${silent.join(', ')}`);

      const obs: AwarenessObservation = {
        ts: now.toISOString(),
        summary: summary_parts.join(' · '),
        severity,
        details: {
          unread_inbox: unread_count,
          pending_proposals_24h: pending_count,
          pending_interrupts_1h: pending_interrupts.length,
          silent_specialists: silent,
        },
      };
      // Kate self-escalation. She doesn't post to her own inbox
      // (that's circular); she just sets the flag so LoopDriver fires
      // her deliberation off-schedule. Triggers:
      //   - any pending interrupt (Jasper should be told NOW, but
      //     Kate's deliberation decides framing / which channel)
      //   - 3+ unread flags from any combination of specialists —
      //     enough signal that scope-of-response matters
      // Dedupe key uses a 15-minute bucket so sustained backlog
      // doesn't refire every tick.
      const bucket = Math.floor(now.getTime() / (15 * 60 * 1000));
      if (pending_interrupts.length > 0) {
        obs.escalate_to_kate = {
          dedupe_key: `kate-pending-interrupts-${bucket}`,
          reason: `${pending_interrupts.length} pending interrupt(s) in the last hour need decisioning.`,
          interrupt_ids: pending_interrupts.map((i) => i.id),
        };
      } else if (unread_count >= 3) {
        obs.escalate_to_kate = {
          dedupe_key: `kate-inbox-backlog-${bucket}`,
          reason: `${unread_count} unread inbox flag(s) accumulated. Triage.`,
        };
      }
      return obs;
    } catch (err) {
      return safe_mode_obs('kate', err);
    }
}

/**
 * Fold the security watch's observation together with Kate's own signals into
 * the ONE observation a tick may emit: summaries and details merge, severity
 * takes the max.
 *
 * The single `escalate_to_kate` slot goes to the security half when both want
 * it: an external-facing cluster outranks an internal backlog. Nothing is lost
 * by that choice — an escalation only exists to wake Kate's deliberation
 * off-schedule, and that triggered pass reads EVERY unread flag and pending
 * interrupt regardless of which condition woke it. Kate's own escalation
 * conditions are persistent (interrupts stay pending, unread stays unread) and
 * re-evaluate next tick anyway.
 */
function merge_observations(
  security: AwarenessObservation | null,
  own: AwarenessObservation | null,
): AwarenessObservation | null {
  if (!security) return own;
  if (!own) return security;

  return {
    ts: security.ts,
    summary: [security.summary, own.summary].filter((s) => s.length > 0).join(' · '),
    severity: severity_max(security.severity, own.severity),
    suggests_interrupt: security.suggests_interrupt || own.suggests_interrupt || undefined,
    // The security watch's detections must stay behind Kate's triage filter;
    // her own signals keep the default route.
    interrupt_route: security.interrupt_route ?? own.interrupt_route,
    details: { ...own.details, ...security.details },
    escalate_to_kate: security.escalate_to_kate ?? own.escalate_to_kate,
    // Neither half sets `wake_self` today; carried so adding one later can't
    // be silently swallowed by this merge.
    wake_self: security.wake_self ?? own.wake_self,
  };
}

function safe_mode_obs(sid: string, err: unknown): AwarenessObservation {
  return {
    ts: new Date().toISOString(),
    summary: `${sid} awareness handler error`,
    severity: 'low',
    details: { error_message: err instanceof Error ? err.message : String(err) },
  };
}
