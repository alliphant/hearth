/**
 * Single source of truth for which AppEvents fire when a proposal lands.
 *
 * Historically the emission lived inline at each call site: the deliberation
 * loop, three call sites in specialist_runtime, etc. Adding a second event
 * tied to specific proposal kinds (e.g. `calendar_event_proposed` for the
 * iOS-as-CalDAV-adapter flow) means every site needs the same fan-out
 * logic; that's bug-prone the moment a new emission site lands.
 *
 * This helper centralizes:
 *   • the canonical `proposal_created` event
 *   • per-kind sibling events (currently `calendar_event_proposed`)
 *
 * Call sites that previously emitted `proposal_created` directly should
 * pass the relevant fields to `emit_for_proposal_created` instead.
 */

import { z } from 'zod';
import type { Database } from 'bun:sqlite';
import type { AppEvent } from '../app/events';
import { CalendarEventPayloadSchema, type ProposalKind } from './proposals';
import { record_queue_entry, score_proposal } from './kate_filter';

export interface ProposalCreatedSummary {
  proposal_id: string;
  specialist_id: string;
  kind: ProposalKind;
  /** Short user-readable summary used for the `title_preview` field of
   *  the legacy `proposal_created` event. */
  title_preview: string;
  /** The raw proposal payload, used to derive sibling-event fields when
   *  the kind has one. Untyped here because each kind owns its own shape;
   *  per-kind validators below pull what they need. */
  payload: unknown;
  /** When supplied, the helper also writes a `kate_filter_queue` row
   *  recording the scorer's disposition for this proposal. v0.1 is
   *  observe-only — the legacy event still fires for every proposal,
   *  the queue is informational. Skipping these (passing undefined) is
   *  safe; tests and code paths that don't have the deps just get the
   *  legacy AppEvent emission. */
  filter_ctx?: {
    db: Database;
    vault_root: string;
    user_id: string;
  };
}

export function emit_for_proposal_created(
  // Structural — only `.emit` is used here. Accepts both the full
  // AppEventBus (deliberation) and the runtime's narrow `{ emit }` dep.
  events: { emit: (e: AppEvent) => void } | undefined,
  s: ProposalCreatedSummary,
): void {
  // Filter-queue side-effect runs first so a downstream emit failure
  // can't prevent the audit row from being written. Best-effort —
  // record_queue_entry logs and continues on its own errors.
  if (s.filter_ctx) {
    const decision = score_proposal({
      user_id: s.filter_ctx.user_id,
      specialist_id: s.specialist_id,
      kind: s.kind,
      payload: s.payload,
      db: s.filter_ctx.db,
      vault_root: s.filter_ctx.vault_root,
    });
    record_queue_entry({
      user_id: s.filter_ctx.user_id,
      proposal_id: s.proposal_id,
      specialist_id: s.specialist_id,
      kind: s.kind,
      payload: s.payload,
      decision,
      db: s.filter_ctx.db,
    });
  }

  if (!events) return;

  // Always: the legacy event every existing client already handles.
  events.emit({
    type: 'proposal_created',
    proposal_id: s.proposal_id,
    specialist_id: s.specialist_id,
    kind: s.kind,
    title_preview: s.title_preview,
  });

  // Per-kind sibling events.
  if (s.kind === 'calendar_event') {
    const parsed = CalendarEventPayloadSchema.safeParse(s.payload);
    if (!parsed.success) {
      // Don't lose the legacy event over a bad payload — proposal still
      // exists and downstream UIs can still render it via the generic
      // proposal_created. Surface the shape mismatch on stderr so it's
      // caught in dev, not silently swallowed.
      console.warn(
        `[proposal_events] calendar_event payload failed schema: ` +
          parsed.error.issues.map((i) => i.message).join('; '),
      );
      return;
    }
    events.emit({
      type: 'calendar_event_proposed',
      proposal_id: s.proposal_id,
      specialist_id: s.specialist_id,
      title: parsed.data.title,
      ts_start: parsed.data.ts_start,
      ts_end: parsed.data.ts_end,
      location: parsed.data.location ?? null,
      calendar_hint: parsed.data.calendar_hint ?? null,
      replaces_event_id: parsed.data.replaces_event_id ?? null,
      is_all_day: parsed.data.is_all_day ?? false,
    });
  }
}

/** Re-export the payload schema so call sites that construct a
 *  `calendar_event` proposal can validate before creating the row.
 *  Future per-kind payload schemas should follow the same convention. */
export { CalendarEventPayloadSchema };
export type { CalendarEventPayload } from './proposals';

// Type-only import; keeps z imported as a value reference for the
// .safeParse call above. Without this dummy use, some linters flag z
// as unused.
void z;
