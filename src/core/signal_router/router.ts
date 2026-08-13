/**
 * SignalRouter (2026-06-20, Phase 2) — the source-agnostic fan-out primitive.
 *
 * Phase 1 had each source (captures, mail orders) re-implement "deliver a
 * classified signal to a specialist": push a cordoned inbox flag, emit the SSE,
 * write the audit row. That's the genuinely shared core across EVERY source
 * (captures, mail, calendar, sightings) — so it lives here, once. Each source
 * still owns its OWN classify + its own persistence (capture_routes, a
 * household_good, a life_event); the router owns the delivery.
 *
 * `deliver()` is the one call: cordoned inbox flag + `inbox_message_added` SSE +
 * optional audit row, returning the inbox id. Pure plumbing — fail-surfacing is
 * the caller's (a source wraps its own try/catch), and the cordon is the
 * caller's `originating_user_id` (the signal's owner, never the reader).
 *
 * Cordelia's capture path delegates its push+emit+audit here (it's source #1);
 * the Calendar source (Phase 2c) is source #2. The intake-handler REGISTRY
 * stays in ReactiveInboxDriver — intake input is capture-decision-shaped, and
 * generalizing it across sources is a deeper refactor than the delivery it
 * shares here.
 */
import { ulid } from 'ulid';
import type { AppEventBus } from '@app/events';
import type { MemoryClient } from '@memory/client';
import type { SpecialistInbox } from '@memory/stores/conversations';
import type { Severity } from '@core/loops';
import type { InboxKind } from '@core/inbox';

export interface SignalRouterDeps {
  events: AppEventBus;
  memory: MemoryClient;
  inbox: SpecialistInbox;
}

export interface DeliverInput {
  /** The source that produced this signal — for the audit trail. */
  source: 'capture' | 'calendar' | 'mail_order' | 'mail' | 'sighting';
  from_specialist_id: string;
  to_specialist_id: string;
  kind: InboxKind;
  body_md: string;
  severity?: Severity;
  /** Per-user cordon: the user whose signal this is, or null for
   *  household/system-shared. The flag only surfaces in that user's brief. */
  originating_user_id?: string | null;
  related_proposal_id?: string;
  /** Optional audit row written alongside the delivery. */
  audit?: {
    tool_name: string;
    agent?: string;
    intent_id?: string;
    tool_input?: unknown;
    execution_result?: unknown;
  };
}

export class SignalRouter {
  constructor(private deps: SignalRouterDeps) {}

  /** Deliver a classified signal to a specialist: cordoned inbox flag + SSE +
   *  optional audit. Returns the inbox message id. */
  deliver(input: DeliverInput): string {
    const inbox_id = this.deps.inbox.push({
      from_specialist_id: input.from_specialist_id,
      to_specialist_id: input.to_specialist_id,
      kind: input.kind,
      body_md: input.body_md,
      originating_user_id: input.originating_user_id ?? null,
      ...(input.related_proposal_id ? { related_proposal_id: input.related_proposal_id } : {}),
    });
    this.deps.events.emit({
      type: 'inbox_message_added',
      message_id: inbox_id,
      from_specialist_id: input.from_specialist_id,
      to_specialist_id: input.to_specialist_id,
      kind: input.kind,
      severity: input.severity ?? 'medium',
    });
    if (input.audit) {
      this.deps.memory.log_action({
        intent_id: input.audit.intent_id ?? ulid(),
        agent: input.audit.agent ?? input.from_specialist_id,
        tool_name: input.audit.tool_name,
        tool_input: input.audit.tool_input,
        execution_result: input.audit.execution_result,
      });
    }
    return inbox_id;
  }
}
