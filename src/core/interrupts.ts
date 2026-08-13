/**
 * Interrupts (Prompt 6c).
 *
 * An interrupt is a high-severity signal raised by a specialist that
 * demands attention beyond a routine inbox FYI. The routing rule:
 *
 *   - originated by Kate            → routed_to='user' (the real thing)
 *   - originated by anyone else     → routed_to='kate' (she filters)
 *
 * Kate then absorbs (most cases) or promotes (re-raises with routed_to='user').
 *
 * Severity must clear the originating specialist's interrupt_threshold;
 * below-threshold signals downgrade to a `fyi` inbox message instead.
 *
 * For routed_to='user' interrupts: a `would_have_pushed` audit row is
 * logged, and the push pipeline (src/policy/push.ts) fans the alert out
 * to the user's registered iOS devices via APNs.
 */

import { ulid } from 'ulid';
import type { MemoryClient } from '@memory/client';
import type { InterruptStore, SpecialistInbox } from '@memory/stores/conversations';
import type { AppEventBus } from '../app/events';
import type { Severity } from './loops';

const SEVERITY_RANK: Record<Severity, number> = {
  low: 1,
  medium: 2,
  'medium-high': 3,
  high: 4,
};

export interface RaiseInterruptInput {
  originating_specialist_id: string;
  threshold: Severity;
  severity: Severity;
  summary: string;
  details_md: string;
  memory: MemoryClient;
  interrupts: InterruptStore;
  inbox: SpecialistInbox;
  events?: AppEventBus;
  /** Per-user cordon: the user whose session/capture raised this, or
   *  null = household/system-shared. Threaded into the interrupt row AND
   *  the Kate-bound flag so a household member's signal can't surface in
   *  the owner's brief. */
  originating_user_id?: string | null;
  /**
   * Force the triage route (2026-07-26). The default rule reads
   * "originated by Kate → straight to the user", which assumes anything Kate
   * raises has ALREADY been through her judgment. That assumption broke when
   * the security persona dissolved and its monitors became subsystems running
   * inside Kate's own awareness tick: those are raw DETECTIONS, not decisions,
   * and sending them straight to the owner's phone would skip exactly the
   * filter that keeps false positives from costing trust.
   *
   * A subsystem sets `'kate'` so the interrupt lands in her triage queue as a
   * promote/absorb decision, preserving the two-stage flow the perimeter had
   * when it was a separate specialist.
   */
  route_override?: 'user' | 'kate';
}

export async function raise_interrupt(input: RaiseInterruptInput): Promise<string | null> {
  if (SEVERITY_RANK[input.severity] < SEVERITY_RANK[input.threshold]) {
    if (input.originating_specialist_id !== 'kate') {
      input.inbox.push({
        from_specialist_id: input.originating_specialist_id,
        to_specialist_id: 'kate',
        kind: 'fyi',
        body_md: `Below-threshold signal (${input.severity} vs threshold ${input.threshold}): ${input.summary}`,
        originating_user_id: input.originating_user_id ?? null,
      });
    }
    return null;
  }

  const route =
    input.route_override ?? (input.originating_specialist_id === 'kate' ? 'user' : 'kate');
  const i = input.interrupts.create({
    originating_specialist_id: input.originating_specialist_id,
    severity: input.severity,
    summary: input.summary,
    details_md: input.details_md,
    routed_to: route,
    originating_user_id: input.originating_user_id ?? null,
  });

  input.events?.emit({
    type: 'interrupt_raised',
    interrupt_id: i.id,
    originating_specialist_id: input.originating_specialist_id,
    severity: input.severity,
    summary: input.summary,
  });

  if (route === 'kate') {
    input.inbox.push({
      from_specialist_id: input.originating_specialist_id,
      to_specialist_id: 'kate',
      kind: 'flag',
      body_md: `INTERRUPT (${input.severity}): ${input.summary}\n\n${input.details_md}`,
      related_interrupt_id: i.id,
      originating_user_id: input.originating_user_id ?? null,
    });
  } else {
    // User-bound: log a `would_have_pushed` audit row. The push pipeline
    // (src/policy/push.ts) delivers the alert to the user's iOS devices
    // via APNs.
    input.memory.log_action({
      intent_id: ulid(),
      agent: input.originating_specialist_id,
      tool_name: 'would_have_pushed',
      tool_input: {
        interrupt_id: i.id,
        severity: input.severity,
        summary: input.summary,
        reason: input.details_md,
      },
    });
  }

  return i.id;
}

export interface AcknowledgeInput {
  interrupts: InterruptStore;
  id: string;
  by: 'user' | string;
  memory: MemoryClient;
}

export function acknowledge_interrupt(input: AcknowledgeInput): boolean {
  const ok = input.interrupts.acknowledge(input.id);
  if (ok) {
    input.memory.log_action({
      intent_id: ulid(),
      agent: input.by === 'user' ? 'orchestrator' : input.by,
      tool_name: 'interrupt_acknowledged',
      tool_input: { interrupt_id: input.id, by: input.by },
    });
  }
  return ok;
}

/**
 * Kate's escalation: an interrupt she received from another specialist is
 * worth the user's attention after all. Creates a new interrupt row with
 * routed_to='user' and notes Kate's rationale in details_md.
 */
export interface PromoteInput {
  interrupts: InterruptStore;
  source_id: string;
  rationale: string;
  memory: MemoryClient;
  events?: AppEventBus;
}

export function promote_interrupt(input: PromoteInput): string | null {
  const list = input.interrupts.list();
  const src = list.find((i) => i.id === input.source_id);
  if (!src) return null;
  const promoted = input.interrupts.create({
    originating_specialist_id: 'kate',
    severity: src.severity,
    summary: `Kate promoted: ${src.summary}`,
    details_md: `${src.details_md ?? ''}\n\n---\nKate's rationale: ${input.rationale}`,
    routed_to: 'user',
  });
  input.memory.log_action({
    intent_id: ulid(),
    agent: 'kate',
    tool_name: 'promote_interrupt',
    tool_input: { source_id: input.source_id, rationale: input.rationale },
    execution_result: { new_interrupt_id: promoted.id },
  });
  input.memory.log_action({
    intent_id: ulid(),
    agent: 'kate',
    tool_name: 'would_have_pushed',
    tool_input: {
      interrupt_id: promoted.id,
      severity: promoted.severity,
      summary: promoted.summary,
      reason: promoted.details_md,
    },
  });
  input.events?.emit({
    type: 'interrupt_raised',
    interrupt_id: promoted.id,
    originating_specialist_id: 'kate',
    severity: promoted.severity,
    summary: promoted.summary,
  });
  return promoted.id;
}
