/**
 * Hearth → user push pipeline.
 *
 * iOS pushes go Hearth → Apple Push Notification service → device
 * (src/policy/apns.ts). The model is:
 *
 *   - A push resolves the recipient user, fans out to every APNs token
 *     registered for that user, and reports delivery.
 *   - Quiet hours gate pushes by severity. Below-threshold pushes (and
 *     pushes raised while APNs has no live token yet) go into
 *     pending_pushes and are retried by the 60s sweep loop.
 *   - If APNs isn't configured at all, the push is recorded audit-only —
 *     there's no other delivery channel, so it isn't queued forever.
 *
 * Every push attempt produces an audit row with the source_context so
 * the trail of "what did the system actually push, and why" is
 * inspectable later.
 *
 * History: the deprecated Hermes-on-mint / Telegram bridge (push receiver
 * on :8765, direct Telegram Bot API fallback, inbound /api/relay) was
 * removed 2026-06-14 to shrink attack surface — see the ship log. APNs +
 * pending_pushes is the only path now.
 */

import { ulid } from 'ulid';
import type { Database } from 'bun:sqlite';
import type { ApprovalRow } from './approvals';
import type { MemoryClient } from '@memory/client';
import type { AppEventBus } from '../app/events';
import type { LLMRouter } from '@core/llm';
import { apply_kate_voice } from '@core/kate_line';
import {
  should_dispatch_now,
  type Severity,
  type ManualQuietState,
} from './quiet_hours';
import {
  delivery_window_enabled,
  should_deliver_now,
  resolve_presence,
  AWAITED_GRACE_MS,
  type Presence,
  type DeferReason,
} from '@core/delivery_window';
import { get_current_location } from '@core/location_awareness';
import {
  UserRegistry,
  KvSettings,
  type UserConfig,
} from '@core/users';
import {
  ApnsTokenStore,
  apns_configured,
  audit_apns,
  build_alert_payload,
  send_apns,
} from './apns';

export type PushSourceKind =
  | 'brief'
  | 'interrupt'
  | 'approval_request'
  | 'proposal_ready'
  | 'flag_from_specialist'
  | 'ad_hoc'
  | 'test';

export interface PushSourceContext {
  kind: PushSourceKind;
  originating_specialist_id?: string;
  severity?: Severity;
  related_id?: string;
  /** A location-triggered nudge (welcome-home) — exempt from the delivery
   *  window's presence-away deferral (it's FOR the moment the user gets home). */
  is_location_nudge?: boolean;
  /**
   * This notice COMPLETES work the user explicitly asked for — a media download,
   * a research dossier. It bypasses the read-the-room deferrals on BOTH gates
   * below (and quiet hours while the request is still fresh), because the second
   * half of the user's own turn is not an interruption of it. Set by the runners'
   * report-back; see core/delivery_window.ts `is_awaited_bypass`.
   */
  is_awaited?: boolean;
  /** ms since the user's request — feeds the awaited freshness test. */
  awaited_age_ms?: number;
}

export interface PushResult {
  delivered: boolean;
  message_id?: string;
  queued?: boolean;
  pending_id?: string;
  via?: 'apns' | 'queued' | 'audit_only';
  error?: string;
}

/** The shape persisted in pending_pushes.payload_json. Keyed on the
 *  recipient user_id (resolved to APNs tokens at dispatch time) — NOT a
 *  chat id; the Telegram bridge that used chat ids is gone. */
interface QueuedPush {
  user_id: string;
  text: string;
  source_context: PushSourceContext;
}

type QueueReason =
  | 'quiet_hours'
  | 'manual_quiet_mode'
  | 'below_threshold'
  | 'snoozed'
  | 'apns_unavailable'
  // delivery-window deferrals (Piece 5) — the read-the-room gate.
  | 'in_meeting'
  | 'presence_away'
  | 'recency';

interface PushDeps {
  memory: MemoryClient;
  db: Database;
  users: UserRegistry;
  kv: KvSettings;
  events?: AppEventBus;
  /** iOS push fan-out. When set, pushes dispatch to every APNs token
   *  registered for the recipient user. APNs send is conditional on
   *  `apns_configured()` at send time, so leaving APNS_KEY_PATH unset is
   *  a clean no-op for deployments that haven't enabled iOS push. */
  apns_tokens?: ApnsTokenStore;
  /** Kate-authors-the-line (kate_line.ts, DARK behind HEARTH_KATE_LINES):
   *  when set, non-exempt notifications get a Kate-register rewrite at the
   *  deliver_or_queue funnel — fact-guarded in code, fail-open to the
   *  template. Unset ⇒ byte-identical pushes. */
  llm?: LLMRouter;
}

// Top-level module state used by both the sweep and the public dispatch
// helpers. Initialized once by start_push_sweep() at boot.
let module_deps: PushDeps | null = null;
let sweep_timer: ReturnType<typeof setInterval> | null = null;

export function configure_push(deps: PushDeps): void {
  module_deps = deps;
}

export function start_push_sweep(deps: PushDeps): void {
  configure_push(deps);
  if (sweep_timer) clearInterval(sweep_timer);
  sweep_timer = setInterval(() => {
    void sweep_pending_pushes();
  }, 60_000);
  // Fire one immediately so a backlog from before boot drains promptly.
  void sweep_pending_pushes();
}

export function stop_push_sweep(): void {
  if (sweep_timer) {
    clearInterval(sweep_timer);
    sweep_timer = null;
  }
}

function queue_pending(
  deps: PushDeps,
  user_id: string,
  text: string,
  ctx: PushSourceContext,
  reason: QueueReason,
  not_before?: string,
): string {
  const id = `pp_${ulid().slice(-12).toLowerCase()}`;
  const ts = new Date().toISOString();
  const payload: QueuedPush = { user_id, text, source_context: ctx };
  deps.db
    .prepare(
      // `user_chat_id` is a legacy column name; it now holds the recipient
      // user_id (the Telegram chat-id era is over). payload_json is the
      // authoritative copy.
      `INSERT INTO pending_pushes
       (id, ts_queued, user_chat_id, payload_json, queued_reason, not_before)
       VALUES (@id, @ts, @uid, @p, @r, @nb)`,
    )
    .run({
      '@id': id,
      '@ts': ts,
      '@uid': user_id,
      '@p': JSON.stringify(payload),
      '@r': reason,
      '@nb': not_before ?? null,
    });
  return id;
}

function audit_push(
  deps: PushDeps,
  user_id: string,
  text: string,
  ctx: PushSourceContext,
  result: PushResult,
): void {
  deps.memory.log_action({
    intent_id: ulid(),
    agent: 'orchestrator',
    tool_name: 'push_notify',
    tool_input: {
      kind: ctx.kind,
      severity: ctx.severity,
      originating_specialist_id: ctx.originating_specialist_id,
      related_id: ctx.related_id,
      preview: text.slice(0, 200),
    },
    execution_result: {
      delivered: result.delivered,
      via: result.via,
      queued: result.queued,
      pending_id: result.pending_id,
    },
    error: result.error,
    user_id,
  });
  deps.events?.emit({
    type: 'push_dispatched',
    push_id: result.pending_id,
    kind: ctx.kind,
    severity: ctx.severity,
    delivered: result.delivered,
    via: result.via ?? 'audit_only',
  });
}

function get_manual_quiet(deps: PushDeps, user_id: string): ManualQuietState {
  return deps.kv.get<ManualQuietState>(`manual_quiet_mode:${user_id}`) ?? null;
}

/**
 * Read-the-room gate, then dispatch. The single internal entry point for a
 * (user, text, context) push.
 *
 * The quiet-hours decision is resolved ONCE (the existing should_dispatch_now
 * gate). When the delivery-window gate is armed (HEARTH_DELIVERY_WINDOW), that
 * quiet result is FED INTO a unified read-the-room decision that ALSO defers for
 * an active meeting, the user being away (non-location nudges only), and recency
 * — queuing with a not_before so the 60s sweep re-airs it, never dropping it. The
 * gate is fail-open: any resolution error falls through to the legacy
 * quiet-hours-only behavior below, which is ALSO the (byte-identical) flag-off path.
 */
async function deliver_or_queue(
  deps: PushDeps,
  user: UserConfig,
  text: string,
  ctx: PushSourceContext,
): Promise<PushResult> {
  // Kate authors the line (kate_line.ts, DARK behind HEARTH_KATE_LINES) —
  // the ONE funnel every push flows through, so voicing here covers every
  // caller. Runs BEFORE the queue decision so a deferred push re-airs the
  // voiced text. Deterministic exemptions (severity high / approval / test)
  // + a code-side fact guard live in the helper; any miss returns the
  // original template, so the flag-off and worst-case paths are byte-equal.
  text = await apply_kate_voice(deps.llm, text, ctx, user.display_name);

  // Quiet-hours decision (the existing gate) — resolved once, used by both the
  // delivery-window gate and the legacy fallback below.
  let quiet_decision: { allowed: boolean; reason?: QueueReason; queue_until?: string } = { allowed: true };
  if (ctx.severity) {
    const cfg = deps.users.get_notification_config(user.id);
    if (cfg) {
      const d = should_dispatch_now({
        severity: ctx.severity,
        cfg,
        manual: get_manual_quiet(deps, user.id),
      });
      quiet_decision = { allowed: d.allowed, reason: d.reason as QueueReason | undefined, queue_until: d.queue_until };
    }
  }

  // The delivery-window gate (Piece 5, DARK). Adds meeting / presence-away /
  // recency deferral on top of quiet hours. Fail-open → legacy path on any error.
  if (delivery_window_enabled()) {
    try {
      const signals = await resolve_delivery_signals(deps, user, ctx);
      const win = should_deliver_now(
        {
          severity: ctx.severity,
          kind: ctx.kind,
          is_location_nudge: ctx.is_location_nudge,
          is_awaited: ctx.is_awaited,
          ...(ctx.awaited_age_ms !== undefined ? { awaited_age_ms: ctx.awaited_age_ms } : {}),
          quiet: !quiet_decision.allowed,
          quiet_until: quiet_decision.queue_until ?? null,
          ...signals,
        },
        new Date(),
      );
      if (!win.deliver) {
        const pending_id = queue_pending(
          deps,
          user.id,
          text,
          ctx,
          defer_to_queue_reason(win.defer_reason),
          win.not_before ?? undefined,
        );
        const result: PushResult = { delivered: false, queued: true, pending_id, via: 'queued' };
        audit_push(deps, user.id, text, ctx, result);
        return result;
      }
      return dispatch_now(deps, user, text, ctx);
    } catch {
      /* fail-open — fall through to the legacy quiet-hours-only gate below */
    }
  }

  // Legacy quiet-hours-only gate (the flag-off path AND the fail-open fallback).
  // Awaited work skips it while the request is fresh, for the same reason the
  // window gate above lets it through: parking "your download is filed" until
  // 06:00 makes Kate's "I'll let you know" a lie. This is the ONE deliberate
  // divergence from byte-identical flag-off behavior — it has to live on both
  // gates, or the fix disappears whenever HEARTH_DELIVERY_WINDOW is off or the
  // signal resolution throws.
  const awaited_fresh =
    ctx.is_awaited === true &&
    (ctx.awaited_age_ms ?? 0) <= AWAITED_GRACE_MS;
  if (!quiet_decision.allowed && !awaited_fresh) {
    const pending_id = queue_pending(
      deps,
      user.id,
      text,
      ctx,
      quiet_decision.reason ?? 'quiet_hours',
      quiet_decision.queue_until,
    );
    const result: PushResult = { delivered: false, queued: true, pending_id, via: 'queued' };
    audit_push(deps, user.id, text, ctx, result);
    return result;
  }
  return dispatch_now(deps, user, text, ctx);
}

/** Map a delivery-window defer reason to the pending_pushes queue reason. */
function defer_to_queue_reason(reason: DeferReason | undefined): QueueReason {
  return (reason ?? 'quiet_hours') as QueueReason;
}

/**
 * Best-effort resolution of the live "is now a good moment" signals for the
 * delivery window. Every sub-read is fail-open (a throw / missing source leaves
 * that signal undefined → the pure gate treats it as "no defer for that
 * reason"). Reads the user's calendar snapshot (active meeting), location cache
 * (presence), and the audit log (last push, for recency).
 */
async function resolve_delivery_signals(
  deps: PushDeps,
  user: UserConfig,
  _ctx: PushSourceContext,
): Promise<{ in_meeting?: boolean; meeting_ends?: string | null; presence?: Presence; last_push_ms_ago?: number }> {
  const out: { in_meeting?: boolean; meeting_ends?: string | null; presence?: Presence; last_push_ms_ago?: number } = {};
  const now_iso = new Date().toISOString();

  // Active meeting / focus block, from the iOS calendar snapshot.
  try {
    const snap = deps.memory.query_calendar_snapshot(user.id);
    if (snap) {
      const active = snap.events.find(
        (e) => e.ts_start && e.ts_end && e.ts_start <= now_iso && e.ts_end >= now_iso,
      );
      out.in_meeting = Boolean(active);
      out.meeting_ends = active?.ts_end ?? null;
    }
  } catch {
    /* no snapshot → in_meeting unknown */
  }

  // Presence (home/away), from the location cache.
  try {
    const loc = await get_current_location(user.id);
    // Coords + the home anchor are what actually decide home/away — live iOS
    // payloads carry no `place_id`, so a place_id-only read is always 'unknown'.
    out.presence = resolve_presence(
      { available: loc.available, kind: loc.kind, place_id: loc.place_id, coords: loc.coords },
      deps.users.home_coords(user.id),
    );
  } catch {
    /* presence unknown */
  }

  // Recency — the last push to this user, from the audit log.
  try {
    const row = deps.db
      .prepare(`SELECT MAX(ts) AS last_ts FROM audit_log WHERE tool_name = 'push_notify' AND user_id = @u`)
      .get({ '@u': user.id }) as { last_ts: string | null } | undefined;
    if (row?.last_ts) {
      const ms = Date.now() - Date.parse(row.last_ts);
      if (Number.isFinite(ms) && ms >= 0) out.last_push_ms_ago = ms;
    }
  } catch {
    /* recency unknown */
  }

  return out;
}

async function dispatch_now(
  deps: PushDeps,
  user: UserConfig,
  text: string,
  ctx: PushSourceContext,
): Promise<PushResult> {
  const delivered = await dispatch_apns_for(user, text, ctx);
  if (delivered) {
    const result: PushResult = { delivered: true, via: 'apns' };
    audit_push(deps, user.id, text, ctx, result);
    return result;
  }
  // No iOS device received it. If APNs isn't configured at all there's no
  // channel to retry on, so record audit-only rather than queue forever.
  if (!apns_configured()) {
    const result: PushResult = {
      delivered: false,
      via: 'audit_only',
      error: 'no delivery channel (APNs not configured)',
    };
    audit_push(deps, user.id, text, ctx, result);
    return result;
  }
  // Configured but no token delivered yet (e.g. device not registered) —
  // queue for the sweep to retry.
  const pending_id = queue_pending(deps, user.id, text, ctx, 'apns_unavailable');
  const result: PushResult = {
    delivered: false,
    queued: true,
    pending_id,
    via: 'queued',
  };
  audit_push(deps, user.id, text, ctx, result);
  return result;
}

/**
 * Background sweep: dispatch any pending pushes whose quiet-hours or
 * snooze window has passed. Idempotent — already-dispatched rows are
 * skipped via the ts_dispatched IS NULL filter.
 */
export async function sweep_pending_pushes(): Promise<void> {
  const deps = module_deps;
  if (!deps) return;
  const now_iso = new Date().toISOString();
  const due = deps.db
    .prepare(
      `SELECT id, payload_json, not_before, attempt_count
       FROM pending_pushes
       WHERE ts_dispatched IS NULL
         AND (not_before IS NULL OR not_before <= @now)
       ORDER BY ts_queued ASC LIMIT 25`,
    )
    .all({ '@now': now_iso }) as Array<{
    id: string;
    payload_json: string;
    not_before: string | null;
    attempt_count: number;
  }>;
  for (const row of due) {
    let payload: QueuedPush;
    try {
      payload = JSON.parse(row.payload_json) as QueuedPush;
    } catch {
      deps.db
        .prepare(
          `UPDATE pending_pushes SET ts_dispatched = @ts, last_error = 'invalid payload' WHERE id = @id`,
        )
        .run({ '@id': row.id, '@ts': now_iso });
      continue;
    }
    // Resolve the recipient. A legacy (pre-2026-06-14) row whose payload
    // carried a Telegram chat id instead of a user_id won't resolve — mark
    // it done-with-error so it doesn't loop forever.
    const user = payload.user_id ? deps.users.get(payload.user_id) : null;
    if (!user) {
      deps.db
        .prepare(
          `UPDATE pending_pushes SET ts_dispatched = @ts, last_error = 'recipient not resolvable' WHERE id = @id`,
        )
        .run({ '@id': row.id, '@ts': new Date().toISOString() });
      continue;
    }
    const result = await dispatch_now(deps, user, payload.text, payload.source_context);
    if (result.delivered) {
      deps.db
        .prepare(`UPDATE pending_pushes SET ts_dispatched = @ts WHERE id = @id`)
        .run({ '@id': row.id, '@ts': new Date().toISOString() });
    } else {
      const attempts = row.attempt_count + 1;
      // Cap attempts at 10 — beyond that we mark dispatched-with-error
      // so the row doesn't loop forever.
      if (attempts >= 10) {
        deps.db
          .prepare(
            `UPDATE pending_pushes
             SET ts_dispatched = @ts, attempt_count = @a, last_error = @err
             WHERE id = @id`,
          )
          .run({
            '@id': row.id,
            '@ts': new Date().toISOString(),
            '@a': attempts,
            '@err': result.error ?? 'dispatch failed',
          });
      } else {
        deps.db
          .prepare(
            `UPDATE pending_pushes SET attempt_count = @a, last_error = @err WHERE id = @id`,
          )
          .run({ '@id': row.id, '@a': attempts, '@err': result.error ?? 'dispatch failed' });
      }
    }
  }
}

// ── Adapters used by existing call sites ──────────────────────────────────

function format_approval(approval: ApprovalRow): string {
  const call = approval.tool_call;
  const input_preview = JSON.stringify(call.input).slice(0, 240);
  const rule =
    approval.gate_decision.decision !== 'deny'
      ? approval.gate_decision.matched_rule
      : 'unknown';
  return (
    `🔔 FRIDAY brain wants to ${call.tool_name}\n` +
    `${input_preview}\n\n` +
    `(rule: ${rule} · id: ${approval.id})`
  );
}

/**
 * Map a PushSourceContext to the APNs `aps.category` identifier the
 * iOS app registered (PushCoordinator.categories). The category lets
 * iOS apply per-category UI (custom action buttons later, banner
 * sound choice, etc.) and lets the Settings → Notifications surface
 * gate each category independently.
 */
function apns_category_for(ctx: PushSourceContext): string {
  switch (ctx.kind) {
    case 'brief':
      return 'kate.brief';
    case 'interrupt':
      // Tier-3 specialists raising an interrupt are urgent by definition;
      // anything else degrades to a household-level alert.
      return ctx.severity === 'high' ? 'kate.urgent' : 'kate.household';
    case 'approval_request':
      return ctx.severity === 'high'
        ? 'proposal.urgent'
        : 'proposal.pending';
    case 'proposal_ready':
      return 'proposal.pending';
    case 'flag_from_specialist':
      return 'specialist.update';
    case 'ad_hoc':
    case 'test':
      return 'specialist.update';
  }
}

/** Best-effort APNs fan-out. Never throws — failures are audit-only so a
 *  missing iOS token never crashes a push. Returns true when at least one
 *  iOS device received the push. */
async function dispatch_apns_for(
  recipient: UserConfig,
  text: string,
  ctx: PushSourceContext,
): Promise<boolean> {
  const deps = module_deps;
  if (!deps?.apns_tokens) return false;
  if (!apns_configured()) return false;
  const payload = build_alert_payload({
    title: ctx.originating_specialist_id
      ? capitalize(ctx.originating_specialist_id)
      : 'Hearth',
    body: text,
    category: apns_category_for(ctx),
    thread_id: ctx.related_id ?? undefined,
    hearth_route: route_for(ctx),
  });
  try {
    const { attempts, delivered } = await send_apns({
      store: deps.apns_tokens,
      user_id: recipient.id,
      push_type: 'alert',
      priority: ctx.severity === 'high' ? 10 : 5,
      payload,
    });
    if (attempts.length === 0) return false;
    audit_apns(deps.memory, {
      user_id: recipient.id,
      category: apns_category_for(ctx),
      push_type: 'alert',
      attempts,
      reason: ctx.kind,
    });
    return delivered;
  } catch (err) {
    deps.memory.log_action({
      intent_id: ulid(),
      agent: 'orchestrator',
      tool_name: 'apns_dispatch',
      tool_input: { user_id: recipient.id, reason: ctx.kind },
      execution_result: null,
      error: err instanceof Error ? err.message : String(err),
      user_id: recipient.id,
    });
    return false;
  }
}

function route_for(ctx: PushSourceContext): { kind: string; id?: string } {
  switch (ctx.kind) {
    case 'brief':
      return { kind: 'brief' };
    case 'approval_request':
    case 'proposal_ready':
      return ctx.related_id
        ? { kind: 'proposal', id: ctx.related_id }
        : { kind: 'today' };
    case 'interrupt':
    case 'flag_from_specialist':
      return ctx.originating_specialist_id
        ? { kind: 'specialist', id: ctx.originating_specialist_id }
        : { kind: 'today' };
    default:
      return { kind: 'today' };
  }
}

function capitalize(s: string): string {
  return s.length === 0 ? s : s[0]!.toUpperCase() + s.slice(1);
}

/**
 * Approval-prompt push. Used by the approval gateway. Keeps the older
 * call shape `push_approval(approval, memory)` so the gateway flow does
 * not need to know about the pipeline; the recipient is the default user.
 */
export async function push_approval(
  approval: ApprovalRow,
  _memory: MemoryClient,
): Promise<PushResult> {
  const deps = module_deps;
  if (!deps) return { delivered: false, error: 'push module not configured' };
  const user = deps.users.list()[0];
  if (!user) return { delivered: false, error: 'no default user configured' };
  const text = format_approval(approval);
  return deliver_or_queue(deps, user, text, {
    kind: 'approval_request',
    severity: 'medium-high',
    related_id: approval.id,
  });
}

/**
 * Plain-text push used by the brief scheduler and other non-approval
 * surfaces. Delivers to the default user.
 */
export async function push_text(
  text: string,
  _memory: MemoryClient,
  _intent_id: string,
  reason: string,
): Promise<PushResult> {
  const deps = module_deps;
  if (!deps) return { delivered: false, error: 'push module not configured' };
  const user = deps.users.list()[0];
  if (!user) return { delivered: false, error: 'no default user configured' };
  return deliver_or_queue(deps, user, text, {
    kind: reason.includes('brief') ? 'brief' : 'ad_hoc',
    severity: 'medium',
  });
}

/**
 * Plain-text push to a SPECIFIC user (not the default) — the
 * specialist→user messaging path (the `message_user` tool, 2026-06-16).
 * Unlike `push_text` (which delivers to the default user), this resolves
 * the named recipient and fans out to THEIR devices. Quiet-hours and
 * notification-threshold gating apply via `deliver_or_queue` exactly as
 * for any other push; a miss queues to `pending_pushes` keyed on the
 * recipient's id. Returns a structured "no user" error rather than
 * throwing when the id doesn't resolve.
 */
export async function push_text_to_user(
  user_id: string,
  text: string,
  ctx: PushSourceContext,
): Promise<PushResult> {
  const deps = module_deps;
  if (!deps) return { delivered: false, error: 'push module not configured' };
  const user = deps.users.get(user_id);
  if (!user) return { delivered: false, error: `no user "${user_id}"` };
  return deliver_or_queue(deps, user, text, ctx);
}

export { format_approval };
