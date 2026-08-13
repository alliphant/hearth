/**
 * /api/specialists/:id/research — the Research office tab's data feed
 * (Kate's office, 2026-06-19) + the cancel verb (2026-07-29).
 *
 * Serves the caller's deep-research investigations: the in-flight ones with
 * live status + per-sub-question progress (the office's live bar, patched on
 * the research_investigation_updated SSE event), and the recent finished
 * dossiers (links to the shelved note). A drill-in returns one
 * investigation's full findings + dossier.
 *
 * Generic by capability, not by name: any specialist GRANTED deep_research
 * serves a Research office (a future research front gets it for free);
 * everyone else 404s. PER-REQUESTER cordon (NOT owner-only): a caller sees
 * only their own investigations — the owner has NO god-view of a household
 * member's, mirroring note_visible_to_caller. A drill-in miss returns 404
 * (never 403) so it can't leak that someone else's exists.
 *
 * POST …/research/:rid/cancel stops an investigation the requester no longer
 * wants. `'cancelled'` has been in the status enum since the store was written
 * ("the column exists so an operator UPDATE is honest state, not a deleted
 * row") but nothing could REACH it — a mis-filed investigation burned its way
 * through eight slices of real search + fetch + deep-tier budget with no stop.
 * The runner honours the flag at its phase boundaries (see `set_status` in
 * research_investigation_runner.ts — EVERY status write goes through it,
 * terminal ones included, so a finishing slice cannot write `done` over a cancel
 * that landed while it was synthesizing). A phase already in flight completes,
 * so a cancel during synthesis still shelves the composed dossier rather than
 * dropping a fragment; it just doesn't announce it. No new job system: the
 * cancel is a status write, and the existing detached loop + nightly sweep both
 * already skip anything not in OPEN_INVESTIGATION_STATUSES.
 *
 * Mounted at app.route('/api/specialists', …) — an EXISTING /api namespace,
 * so no nginx alternation change is needed (unlike /api/news, /api/presence).
 */
import { Hono } from 'hono';
import type { Database } from 'bun:sqlite';
import type { SpecialistRegistry } from '@core/specialist';
import type { AppEventBus } from '@app/events';
import { note_visible_to_caller, type Caller } from '@memory/private_to';
import { coverage_summary_line } from '@core/research_coverage';
import {
  ResearchInvestigationStore,
  OPEN_INVESTIGATION_STATUSES,
  type InvestigationRow,
  type InvestigationStatus,
} from '@memory/stores/research_investigations';

export interface ResearchRouterDeps {
  db: Database;
  specialists: SpecialistRegistry;
  /** Optional — a cancel emits `research_investigation_updated` so the
   *  office's live progress bar clears without a refresh. Omitted in the
   *  smoke harness. */
  events?: AppEventBus;
}

/** Coarse 0..1 progress for the office's live bar, derived from status.
 *  Exported so the Research Room pane tab (core/research_pane.ts) reads
 *  progress from the SAME function this route serves — two implementations
 *  would eventually disagree about how far along a run is.
 *
 *  Active-vs-recent reads NEEDS_ATTENTION below, not OPEN_INVESTIGATION_STATUSES
 *  directly — see the note there for why the two deliberately differ. */
export function progress_of(status: InvestigationStatus): number {
  switch (status) {
    case 'pending':
    case 'planning':
      return 0.1;
    case 'investigating':
      return 0.45;
    case 'verifying':
      return 0.7;
    case 'synthesizing':
      return 0.9;
    // A partial report exists; the remaining facets are going back through the
    // fan-out — nearly there, but explicitly not finished.
    case 'incomplete':
      return 0.8;
    // Stopped partway and waiting on a decision. It must NOT fall through to
    // the default of 1: a stalled run rendered as 100% complete is the same
    // false-reassurance this subsystem exists to kill — the owner would read a
    // finished bar and wait for a report that is never coming.
    case 'stalled':
      return 0.8;
    default:
      return 1;
  }
}

/** Answered-vs-planned angles. Exported for the same reason as progress_of. */
export function sub_question_progress(row: InvestigationRow): { answered: number; total: number } {
  const total = row.plan?.sub_questions.length ?? 0;
  const answered = row.findings.filter((f) => f.findings.length > 0).length;
  return { answered, total };
}

/** The coverage ledger, in the shape the office tab renders. */
function coverage_view(row: InvestigationRow) {
  const facets = row.coverage?.facets ?? [];
  return {
    coverage_summary: facets.length > 0 ? coverage_summary_line(row.coverage) : null,
    coverage: facets.map((f) => ({
      question: f.question,
      status: f.status,
      reason: f.reason ?? null,
      findings: f.finding_count,
      sources: f.source_count,
    })),
    unattempted: facets.filter((f) => f.status === 'not_attempted').length,
  };
}

function active_view(row: InvestigationRow) {
  const sq = sub_question_progress(row);
  return {
    investigation_id: row.id,
    subject: row.subject,
    subject_kind: row.subject_kind,
    status: row.status,
    progress: progress_of(row.status),
    sub_questions_total: sq.total,
    sub_questions_answered: sq.answered,
    findings: row.findings.reduce((n, f) => n + f.findings.length, 0),
    ...coverage_view(row),
    log: (row.state.log ?? []).slice(-6),
    created_at: row.created_at,
  };
}

function recent_view(row: InvestigationRow) {
  return {
    investigation_id: row.id,
    subject: row.subject,
    subject_kind: row.subject_kind,
    status: row.status,
    findings: row.findings.reduce((n, f) => n + f.findings.length, 0),
    dropped: row.verification?.dropped_claims.length ?? 0,
    ...coverage_view(row),
    dossier_note_path: row.dossier_note_path,
    completed_at: row.completed_at,
  };
}

/**
 * What the office shows as ACTIVE.
 *
 * Deliberately NOT the same set as OPEN_INVESTIGATION_STATUSES, and the
 * difference is the whole point of `stalled`. The runner's OPEN set answers
 * "may the sweep advance this?" — and it must say NO for a stalled run, or a
 * stall silently becomes an infinite resume loop. The office answers a
 * different question, "does this still need the owner?", and there the answer
 * is emphatically YES: a stalled run is waiting on a decision. Filing it under
 * `recent` alongside finished dossiers is how it would be lost.
 */
export const NEEDS_ATTENTION: readonly InvestigationStatus[] = [
  ...OPEN_INVESTIGATION_STATUSES,
  'stalled',
];

export function create_research_router(deps: ResearchRouterDeps): Hono {
  const r = new Hono();
  const store = new ResearchInvestigationStore(deps.db);

  const caller_of = (c: { get: (k: 'user') => { id?: string; tier?: string } | undefined }):
    | Caller
    | null => {
    const user = c.get('user');
    if (!user) return null;
    return { user_id: user.id, tier: (user.tier ?? 'friend') as Caller['tier'] };
  };

  // List — the caller's investigations, active + recent (cordon-filtered).
  r.get('/:id/research', (c) => {
    const user = c.get('user');
    if (!user) return c.json({ error: 'unauthenticated' }, 401);
    const id = c.req.param('id');
    const specialist = deps.specialists.get(id);
    if (!specialist || !specialist.granted.has('deep_research')) {
      return c.json({ error: 'no research office for this specialist' }, 404);
    }
    const caller: Caller = { user_id: user.id, tier: (user.tier ?? 'friend') as Caller['tier'] };
    const rows = store.list_for_user(caller, { limit: 60 });
    const active = rows
      .filter((row) => NEEDS_ATTENTION.includes(row.status))
      .map(active_view);
    const recent = rows
      .filter((row) => !NEEDS_ATTENTION.includes(row.status))
      .slice(0, 15)
      .map(recent_view);
    return c.json({
      generated_at: new Date().toISOString(),
      active,
      recent,
    });
  });

  // Drill-in — one investigation's full findings + dossier (cordon: 404 on miss).
  r.get('/:id/research/:rid', (c) => {
    const caller = caller_of(c);
    if (!caller) return c.json({ error: 'unauthenticated' }, 401);
    const id = c.req.param('id');
    const specialist = deps.specialists.get(id);
    if (!specialist || !specialist.granted.has('deep_research')) {
      return c.json({ error: 'no research office for this specialist' }, 404);
    }
    const row = store.get(c.req.param('rid'));
    const visible =
      row !== null &&
      (row.requested_by === caller.user_id ||
        note_visible_to_caller(row.private_to ?? undefined, caller));
    if (!row || !visible) {
      // Never leak existence — same 404 as an unknown id.
      return c.json({ error: 'not found' }, 404);
    }
    return c.json({
      investigation_id: row.id,
      subject: row.subject,
      subject_kind: row.subject_kind,
      brief: row.brief,
      status: row.status,
      progress: progress_of(row.status),
      ...coverage_view(row),
      sub_questions: row.findings.map((f) => ({
        question: f.question,
        status: f.status,
        findings: f.findings.map((finding) => ({
          text: finding.text,
          sources: finding.source_indices
            .map((i) => f.sources[i - 1])
            .filter((s): s is NonNullable<typeof s> => s !== undefined)
            .map((s) => ({ url: s.url, title: s.title })),
        })),
        note: f.note ?? null,
      })),
      dossier_md: row.dossier_md,
      dossier_note_path: row.dossier_note_path,
      dropped_claims: row.verification?.dropped_claims ?? [],
      // The verifier FLAGS rather than drops (design §7), which made
      // `dropped_claims` permanently empty — so without this the office showed
      // a reader nothing about a claim that failed checking. 2026-07-31.
      verdicts: (row.verification?.verdicts ?? []).map((v) => ({
        claim: v.claim,
        verdict: v.verdict,
        reason: v.reason,
      })),
      log: row.state.log ?? [],
      created_at: row.created_at,
      completed_at: row.completed_at,
    });
  });

  // Cancel — stop an investigation the requester no longer wants. Gated
  // IDENTICALLY to the reads above (capability + per-requester cordon, 404 on a
  // miss so it can't probe for someone else's row) because the ability to STOP
  // work is the same information as the ability to see it.
  r.post('/:id/research/:rid/cancel', (c) => {
    const caller = caller_of(c);
    if (!caller) return c.json({ error: 'unauthenticated' }, 401);
    const id = c.req.param('id');
    const specialist = deps.specialists.get(id);
    if (!specialist || !specialist.granted.has('deep_research')) {
      return c.json({ error: 'no research office for this specialist' }, 404);
    }
    const row = store.get(c.req.param('rid'));
    const visible =
      row !== null &&
      (row.requested_by === caller.user_id ||
        note_visible_to_caller(row.private_to ?? undefined, caller));
    if (!row || !visible) return c.json({ error: 'not found' }, 404);

    // Terminal already? Say so honestly and change nothing — including for a
    // repeat cancel, which must be idempotent (a double-tap, or a client
    // retrying a request whose response it lost, must not read as an error).
    if (!OPEN_INVESTIGATION_STATUSES.includes(row.status)) {
      return c.json({
        investigation_id: row.id,
        status: row.status,
        cancelled: row.status === 'cancelled',
        note:
          row.status === 'cancelled'
            ? 'already cancelled'
            : `already ${row.status} — nothing to cancel`,
      });
    }

    // WHO stopped it, and from which phase — the only record of that, so it
    // goes in before the status flip: an in-flight slice re-reads `status` to
    // decide whether to stand down, and it must never observe `'cancelled'`
    // without the reason already durable. `append_log` (not an `update`) because
    // the runner is the other writer of this column — see its docblock; writing
    // a whole `state` from either side deletes the other side's lines, which is
    // precisely how this line used to disappear on the runner's next persist.
    store.append_log(row.id, `cancelled by ${caller.user_id} while ${row.status}`);
    store.update(row.id, { status: 'cancelled' });
    deps.events?.emit({
      type: 'research_investigation_updated',
      investigation_id: row.id,
      // The FILING specialist, matching the runner's own emit — a Ruby
      // investigation must not clear a bar in Kate's office.
      specialist_id: row.agent_id ?? 'kate',
      subject: row.subject,
      status: 'cancelled',
      user_id: row.requested_by,
    });
    return c.json({
      investigation_id: row.id,
      status: 'cancelled',
      cancelled: true,
      // A slice mid-flight stops at its next phase boundary; one already
      // inside synthesis finishes composing rather than shelving a fragment.
      note: 'cancelled — the runner stops at its next phase boundary',
    });
  });

  return r;
}
