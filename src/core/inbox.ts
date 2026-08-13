/**
 * Inbox API (Prompt 6c) — thin functional layer over SpecialistInbox.
 *
 * The store layer (src/memory/stores/conversations.ts) handles raw INSERT/
 * SELECT. This module adds the bits that need to know about ULIDs, SSE
 * emission, severity mapping, and the lightweight "FYI vs flag" mapping
 * used by the awareness-driven inbox path. Keep this layer small and
 * pure — richer reasoning belongs in deliberation, not here.
 */

import type { SpecialistInbox, SpecialistInboxRow } from '@memory/stores/conversations';
import type { AppEventBus } from '@app/events';
import type { Severity } from './loops';

export type InboxKind = 'flag' | 'question' | 'fyi' | 'consult_response';

export interface NewInboxMessage {
  from_specialist_id: string;
  to_specialist_id: string;
  kind: InboxKind;
  body_md: string;
  related_proposal_id?: string;
  related_interrupt_id?: string;
}

export interface InboxClientDeps {
  inbox: SpecialistInbox;
  events?: AppEventBus;
}

export function severity_to_kind(sev: Severity): InboxKind {
  switch (sev) {
    case 'low':
    case 'medium':
      return 'fyi';
    case 'medium-high':
    case 'high':
      return 'flag';
  }
}

export class InboxClient {
  constructor(private deps: InboxClientDeps) {}

  create(msg: NewInboxMessage, severity: Severity = 'low'): string {
    const id = this.deps.inbox.push(msg);
    this.deps.events?.emit({
      type: 'inbox_message_added',
      message_id: id,
      from_specialist_id: msg.from_specialist_id,
      to_specialist_id: msg.to_specialist_id,
      kind: msg.kind,
      severity,
    });
    return id;
  }

  read(specialist_id: string, unread_only = false, limit = 50): SpecialistInboxRow[] {
    return unread_only
      ? this.deps.inbox.unread_for(specialist_id, limit)
      : this.deps.inbox.list_for(specialist_id, limit);
  }

  mark_read(message_id: string): void {
    this.deps.inbox.mark_read([message_id]);
  }

  mark_actioned(message_id: string): void {
    this.deps.inbox.mark_actioned(message_id);
  }
}
