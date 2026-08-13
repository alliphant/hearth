/**
 * Process misses — the closed-loop accountability ledger (Part B).
 *
 * A process miss is opened when a specialist's work fell short of what
 * the program needed: an approved proposal that failed, a promised
 * follow-up never delivered, a consult re-asked because the answer
 * didn't land. Mariah, the program manager, owns the ledger — she
 * routes each miss, drives a redo, verifies the redo, and closes it.
 *
 * A miss is its own entity, deliberately not a Proposal (there is
 * nothing to approve or deny) and not an Interrupt (it carries a real
 * multi-step lifecycle, not a one-shot attention grab):
 *
 *   open -> routed -> redo_dispatched -> verified -> closed
 *
 * A failed verification re-dispatches (redo_dispatched again). When a
 * specialist misses the same class of work repeatedly, the fix is not
 * another redo — the miss is `escalated` to Beatrice for a persona or
 * tool change. `escalated` and `closed` are the terminal-ish states.
 */
import { ulid } from 'ulid';
import type { Database } from 'bun:sqlite';
import type { SpecialistInbox } from '@memory/stores/conversations';
import type { AppEventBus } from '@app/events';

export type ProcessMissStatus =
  | 'open'
  | 'routed'
  | 'redo_dispatched'
  | 'verified'
  | 'closed'
  | 'escalated';

/**
 * The verbs that drive a miss forward — what a caller asks for, as
 * opposed to ProcessMissStatus, which is where the miss lands.
 */
export type ProcessMissAction =
  | 'route'
  | 'dispatch_redo'
  | 'verify'
  | 'close'
  | 'escalate';

export const MISS_ACTIONS: readonly ProcessMissAction[] = [
  'route',
  'dispatch_redo',
  'verify',
  'close',
  'escalate',
];

/** The status a miss lands in once a given action is applied. */
export const MISS_ACTION_STATUS: Record<ProcessMissAction, ProcessMissStatus> = {
  route: 'routed',
  dispatch_redo: 'redo_dispatched',
  verify: 'verified',
  close: 'closed',
  escalate: 'escalated',
};

export type ProcessMissSeverity = 'low' | 'medium' | 'high';

/** Allowed status transitions — a miss may only move along these edges. */
export const MISS_TRANSITIONS: Record<ProcessMissStatus, ProcessMissStatus[]> = {
  open: ['routed', 'escalated', 'closed'],
  routed: ['redo_dispatched', 'escalated', 'closed'],
  redo_dispatched: ['verified', 'redo_dispatched', 'escalated'],
  verified: ['closed', 'redo_dispatched'],
  escalated: ['closed'],
  closed: [],
};

export interface NewProcessMiss {
  /** The specialist whose work fell short. */
  subject_specialist_id: string;
  /** Who opened the miss (a specialist id — usually 'mariah' or 'kate'). */
  reporter: string;
  /** What the subject was supposed to do. */
  task_summary: string;
  /** What was missing or wrong. */
  gap: string;
  severity: ProcessMissSeverity;
  /** Optional pointer to the work — a conversation_id, proposal id, etc. */
  evidence_ref?: string;
}

export interface ProcessMissRow {
  id: string;
  ts_created: string;
  ts_updated: string;
  subject_specialist_id: string;
  reporter: string;
  task_summary: string;
  gap: string;
  severity: string;
  status: ProcessMissStatus;
  routed_to: string | null;
  evidence_ref: string | null;
  notes_md: string;
}

export interface MissListFilter {
  status?: ProcessMissStatus;
  subject_specialist_id?: string;
  /** When true, exclude closed misses. */
  open_only?: boolean;
}

function note_line(
  from: ProcessMissStatus | 'new',
  to: ProcessMissStatus,
  text: string,
): string {
  return `- [${new Date().toISOString()}] ${from} -> ${to}: ${text}`;
}

/**
 * Collapse a gap description to its DEFECT CLASS — what went wrong, with the
 * particulars of this occurrence stripped out.
 *
 * The ledger already dedups by `evidence_ref`, which keys on the specific
 * conversation/scan that produced the miss. That is instance identity, and it
 * is the right key for "is this the same event?". It is the wrong key for "is
 * this the same PROBLEM?" — every recurrence of a defect arrives on a fresh
 * consult id, so instance dedup files a brand-new row every time and the
 * ledger reads as 13 unrelated incidents rather than one unfixed bug.
 *
 * Purely mechanical: drop digits, quoted strings, parentheticals and
 * tool-call detail after the first delimiter, then collapse whitespace. No
 * keyword list, no classification model — the shape of the sentence IS the
 * class, so a new defect class needs no code change to be grouped.
 *
 *   "Beatrice answered a consult with 1 unrecovered read failure(s) in the
 *    same turn: read_note() → not found at "Knowledge/Mariah/persona.md""
 *   → "answered a consult with unrecovered read failure s in the same turn"
 */
export function gap_signature(gap: string): string {
  const head = (gap ?? '').split(/[:.]\s/)[0] ?? '';
  return head
    .toLowerCase()
    .replace(/"[^"]*"/g, ' ')
    .replace(/'[^']*'/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\d+/g, ' ')
    .replace(/[^a-z ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}

/** One defect class seen repeatedly for one specialist. */
export interface RecurringMissClass {
  subject_specialist_id: string;
  signature: string;
  /** Distinct ledger rows in the window — the recurrence count. */
  count: number;
  /** A representative gap, for the human reading the escalation. */
  sample_gap: string;
  first_ts: string;
  last_ts: string;
  /** Newest-first, capped — the evidence trail. */
  ids: string[];
}

export class ProcessMissStore {
  constructor(private readonly db: Database) {}

  /**
   * Open a new miss at status `open`. Returns the id.
   *
   * CHOKEPOINT DEDUP (2026-06-09): one ledger row per `evidence_ref`,
   * ever. Every scan keeps its own `tracked` pre-check, but this is the
   * safety net none of them can drift past:
   *
   *   - ref already on a LIVE miss (open/routed/redo_dispatched/
   *     escalated) → annotate the recurrence on that row, return its
   *     id. No second row. (The runtime's weekly round-ceiling key
   *     relies on this: every exhaustion in a week lands on ONE row
   *     whose note history is the occurrence count.)
   *   - ref on a CLOSED/VERIFIED miss → REOPEN that row (status back to
   *     `open`, recurrence note, routed_to cleared). The loop thought
   *     the gap was fixed and reality disagreed — that history belongs
   *     on the same row, not split across fragments the dashboard can't
   *     connect. This is the one sanctioned exception to "closed is
   *     terminal" in MISS_TRANSITIONS, and it only happens here.
   *   - no evidence_ref → always a fresh row (nothing to key on).
   */
  create(m: NewProcessMiss): string {
    const now = new Date().toISOString();
    if (m.evidence_ref) {
      const existing = this.db
        .prepare(
          `SELECT * FROM process_misses WHERE evidence_ref = @ref
            ORDER BY ts_created DESC LIMIT 1`,
        )
        .get({ '@ref': m.evidence_ref }) as ProcessMissRow | undefined;
      if (existing) {
        const recurred =
          existing.status === 'closed' || existing.status === 'verified';
        const note = recurred
          ? note_line(
              existing.status,
              'open',
              `reopened by ${m.reporter} — recurred: ${m.gap.slice(0, 300)}`,
            )
          : note_line(
              existing.status,
              existing.status,
              `recurred (reported by ${m.reporter})`,
            );
        this.db
          .prepare(
            `UPDATE process_misses
                SET status = @status,
                    ts_updated = @ts,
                    routed_to = CASE WHEN @reopen = 1 THEN NULL ELSE routed_to END,
                    notes_md = notes_md || char(10) || @note
              WHERE id = @id`,
          )
          .run({
            '@status': recurred ? 'open' : existing.status,
            '@ts': now,
            '@reopen': recurred ? 1 : 0,
            '@note': note,
            '@id': existing.id,
          });
        return existing.id;
      }
    }
    const id = `pm_${ulid().toLowerCase().slice(-12)}`;
    const opening = note_line('new', 'open', `opened by ${m.reporter}: ${m.gap}`);
    this.db
      .prepare(
        `INSERT INTO process_misses
           (id, ts_created, ts_updated, subject_specialist_id, reporter,
            task_summary, gap, severity, status, routed_to, evidence_ref, notes_md)
         VALUES (@id, @ts, @ts, @subject, @reporter, @task, @gap, @severity,
                 'open', NULL, @evidence, @notes)`,
      )
      .run({
        '@id': id,
        '@ts': now,
        '@subject': m.subject_specialist_id,
        '@reporter': m.reporter,
        '@task': m.task_summary,
        '@gap': m.gap,
        '@severity': m.severity,
        '@evidence': m.evidence_ref ?? null,
        '@notes': opening,
      });
    return id;
  }

  get(id: string): ProcessMissRow | null {
    const row = this.db
      .prepare(`SELECT * FROM process_misses WHERE id = @id`)
      .get({ '@id': id }) as ProcessMissRow | undefined;
    return row ?? null;
  }

  list(filter: MissListFilter = {}): ProcessMissRow[] {
    const where: string[] = [];
    const params: Record<string, string> = {};
    if (filter.status) {
      where.push('status = @status');
      params['@status'] = filter.status;
    }
    if (filter.subject_specialist_id) {
      where.push('subject_specialist_id = @subject');
      params['@subject'] = filter.subject_specialist_id;
    }
    if (filter.open_only) {
      where.push("status != 'closed'");
    }
    const sql =
      `SELECT * FROM process_misses` +
      (where.length > 0 ? ` WHERE ${where.join(' AND ')}` : '') +
      ` ORDER BY ts_created DESC`;
    return this.db.prepare(sql).all(params) as ProcessMissRow[];
  }

  /**
   * Defect classes a specialist has hit repeatedly inside the window,
   * REGARDLESS of whether each occurrence was promptly closed.
   *
   * This is the blind spot in the accountability loop as built. Every other
   * reader here filters to live misses, because the assumption is that a
   * closed miss is a finished one. Throughput says otherwise: 934 misses were
   * opened and 933 closed, nearly all same-day, and zero were ever escalated
   * — while the identical defect re-opened 13 times in 18 days. A redo fixes
   * the OUTPUT of one turn; it never touches the thing that made the turn go
   * wrong, so the loop can run at a perfect close rate and still learn
   * nothing. Recurrence, not staleness, is the signal that a redo is the
   * wrong remedy.
   *
   * Counts DISTINCT rows: the evidence_ref chokepoint already folds true
   * repeats of one event onto a single row, so every row here is an
   * independent occurrence.
   */
  recurring_classes(opts: { window_days: number; min_count: number }): RecurringMissClass[] {
    const cutoff = new Date(Date.now() - opts.window_days * 86_400_000).toISOString();
    const rows = this.db
      .prepare(`SELECT * FROM process_misses WHERE ts_created >= @cut ORDER BY ts_created DESC`)
      .all({ '@cut': cutoff }) as ProcessMissRow[];
    const groups = new Map<string, RecurringMissClass>();
    for (const row of rows) {
      const signature = gap_signature(row.gap);
      if (signature.length < 8) continue; // too generic to act on
      const key = `${row.subject_specialist_id}\x00${signature}`;
      const existing = groups.get(key);
      if (existing) {
        existing.count++;
        if (existing.ids.length < 10) existing.ids.push(row.id);
        if (row.ts_created < existing.first_ts) existing.first_ts = row.ts_created;
        if (row.ts_created > existing.last_ts) existing.last_ts = row.ts_created;
      } else {
        groups.set(key, {
          subject_specialist_id: row.subject_specialist_id,
          signature,
          count: 1,
          sample_gap: row.gap,
          first_ts: row.ts_created,
          last_ts: row.ts_created,
          ids: [row.id],
        });
      }
    }
    return [...groups.values()]
      .filter((g) => g.count >= opts.min_count)
      .sort((a, b) => b.count - a.count);
  }

  /**
   * Append a marker note to a miss WITHOUT changing its status (Case
   * Driver, 2026-07-02) — the durable record for driver actions that
   * must not re-fire every run (nudge cooldowns, escalate-once). Does
   * NOT bump ts_updated: the driver's own marker must not reset the
   * staleness clock it measures with.
   */
  annotate(id: string, text: string): void {
    const current = this.get(id);
    if (!current) throw new Error(`process miss not found: ${id}`);
    const notes = `${current.notes_md}\n${note_line(current.status, current.status, text)}`;
    this.db
      .prepare(`UPDATE process_misses SET notes_md = @notes WHERE id = @id`)
      .run({ '@notes': notes, '@id': id });
  }

  /**
   * Move a miss to a new status, appending `note` to its history. Throws
   * if the id is unknown or the transition is not allowed. `routed_to`
   * is recorded when supplied (typically on the move into `routed`).
   */
  update_status(
    id: string,
    to: ProcessMissStatus,
    note: string,
    routed_to?: string,
  ): ProcessMissRow {
    const current = this.get(id);
    if (!current) {
      throw new Error(`process miss not found: ${id}`);
    }
    const allowed = MISS_TRANSITIONS[current.status];
    if (!allowed.includes(to)) {
      throw new Error(
        `invalid process-miss transition ${current.status} -> ${to} ` +
          `(allowed: ${allowed.join(', ') || 'none — terminal'})`,
      );
    }
    const now = new Date().toISOString();
    const notes = `${current.notes_md}\n${note_line(current.status, to, note)}`;
    this.db
      .prepare(
        `UPDATE process_misses
            SET status = @status,
                ts_updated = @ts,
                notes_md = @notes,
                routed_to = COALESCE(@routed, routed_to)
          WHERE id = @id`,
      )
      .run({
        '@status': to,
        '@ts': now,
        '@notes': notes,
        '@routed': routed_to ?? null,
        '@id': id,
      });
    const updated = this.get(id);
    if (!updated) {
      throw new Error(`process miss vanished mid-update: ${id}`);
    }
    return updated;
  }
}

export interface ApplyMissActionInput {
  misses: ProcessMissStore;
  inbox: SpecialistInbox;
  miss_id: string;
  action: ProcessMissAction;
  /** Why, in one or two sentences — recorded in the miss history. */
  note: string;
  /** Who is applying the action — usually 'mariah', sometimes 'kate'. */
  reporter: string;
  /**
   * Bus to emit `inbox_message_added` events on after a redo/escalate
   * push lands. The orchestrator's wake-on-flag listener forwards
   * severity≥medium events into `LoopDriver.wake_deliberation`, so
   * passing this is what makes an escalation actually wake Beatrice
   * (and a redo wake Kate) instead of waiting until the next
   * scheduled deliberation slot. Optional for the same reason every
   * other site keeps it optional — test paths and direct callers
   * that don't care about realtime wake can omit it.
   */
  events?: AppEventBus;
}

/**
 * Apply one action to a miss: the lifecycle transition plus its routing
 * side effects. `dispatch_redo` drops a redo flag in the subject
 * specialist's inbox; `escalate` flags Beatrice (the trainer) for a
 * structural fix. The lifecycle guard in `update_status` rejects an
 * out-of-order action.
 *
 * This is the single source of truth for advancing a miss — both the
 * `advance_process_miss` tool (consult-driven) and Mariah's deliberation
 * pass (autonomous) route through it, so the two paths can never drift.
 */
export function apply_miss_action(input: ApplyMissActionInput): ProcessMissRow {
  const { misses, inbox, miss_id, action, note, reporter, events } = input;
  const before = misses.get(miss_id);
  if (!before) {
    // Recovery-hint pattern, applied to the meta tools themselves: an
    // unknown id is usually the model composing one ("pm_14_of_35" from
    // a rendered ordinal) rather than copying. Name the real open ids
    // so the caller's retry can succeed instead of fabricating again.
    const open_ids = misses
      .list({ open_only: true })
      .slice(0, 15)
      .map((m) => `${m.id} (${m.subject_specialist_id}, ${m.status})`);
    throw new Error(
      `apply_miss_action: no process miss with id "${miss_id}". Ids are ` +
        `opaque \`pm_…\` strings — copy them verbatim from the ledger, never ` +
        `compose one. Open misses right now: ${
          open_ids.length > 0 ? open_ids.join('; ') : '(none)'
        }`,
    );
  }
  const to = MISS_ACTION_STATUS[action];
  // `route` parks the miss with whoever's driving it; `escalate` hands
  // it to Beatrice. The row's routed_to is the queryable owner — the
  // inbox flag below is the wake signal. Without the trainer
  // assignment here, the misses dashboard showed escalations as still
  // owned by the prior reporter and Beatrice never appeared in any
  // routed_to aggregate, even though her inbox carried the flag.
  const routed_to =
    action === 'route'
      ? reporter
      : action === 'escalate'
      ? 'trainer'
      : undefined;
  const after = misses.update_status(miss_id, to, note, routed_to);

  if (action === 'dispatch_redo') {
    const inbox_id = inbox.push({
      from_specialist_id: reporter,
      to_specialist_id: before.subject_specialist_id,
      kind: 'flag',
      body_md:
        `**Redo requested** by ${reporter} — process miss ${before.id}.\n\n` +
        `**Task:** ${before.task_summary}\n` +
        `**What was missing:** ${before.gap}\n\n` +
        `${note}\n\nRedo the work and close the gap — with ACTIONS, not prose. ` +
        `The pass this flag wakes must end in a concrete step: the redone work ` +
        `itself, a fix through your build tools (opencode_build / propose_code_edit ` +
        `if you hold them), or a write_binding_proposal naming exactly what blocks ` +
        `you. A reply with zero tool calls does not close a redo — it IS the miss, ` +
        `repeated (the 2026-07-21 web_search redo burned a full wake on a ` +
        `two-sentence reply).`,
    });
    events?.emit({
      type: 'inbox_message_added',
      message_id: inbox_id,
      from_specialist_id: reporter,
      to_specialist_id: before.subject_specialist_id,
      kind: 'flag',
      severity: 'medium',
    });
  } else if (action === 'escalate') {
    const inbox_id = inbox.push({
      from_specialist_id: reporter,
      to_specialist_id: 'trainer',
      kind: 'flag',
      body_md:
        `**Recurring process miss** — ${before.id}, escalated by ${reporter}.\n\n` +
        `**Specialist:** ${before.subject_specialist_id}\n` +
        `**Task:** ${before.task_summary}\n` +
        `**Gap:** ${before.gap}\n\n` +
        `${note}\n\nThis keeps recurring — it needs a structural ` +
        `fix (persona or tooling), not another redo. End your pass in a ` +
        `concrete step: diagnose (diagnose_tool_failure / diagnose_dependency), ` +
        `then FIX via opencode_build or propose_code_edit, or file the ` +
        `write_binding_proposal that names the blocker. A zero-tool-call ` +
        `reply leaves the recurrence running.`,
    });
    events?.emit({
      type: 'inbox_message_added',
      message_id: inbox_id,
      from_specialist_id: reporter,
      to_specialist_id: 'trainer',
      kind: 'flag',
      severity: 'high',
    });
  }

  // Closing a miss retires the escalation/redo flags it raised — otherwise the
  // flag outlives the resolved miss as a permanent ghost in the recipient's
  // inbox (the close path raises no flag of its own, so nothing cleared them
  // before; 145 such stale flags had piled up by 2026-06-04).
  if (to === 'closed') {
    inbox.mark_actioned_for_miss(miss_id);
  }

  return after;
}
