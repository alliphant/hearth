/**
 * Kate-as-filter v0.1 — heuristic scorer + queue helpers.
 *
 * See `~/Projects/hearth-ios/BACKEND_FILTER_BRIEF.md` for the full
 * design. This file implements the minimum needed to make
 * `kate_filter_queue` useful:
 *
 *   1. `score_proposal()` — reads cheap context (Focus mode, in-meeting,
 *      time of day) and returns a `disposition` (deliver_now / batch /
 *      hold / drop), an `urgency_score` ∈ [0, 1], and a one-sentence
 *      user-facing `reason`.
 *
 *   2. `record_queue_entry()` — persists the row keyed by user / proposal.
 *      Called by `emit_for_proposal_created` so every legacy
 *      `proposal_created` emission also leaves an audit-able trail.
 *
 *   3. `surface_held()` — list / mutate held items for the
 *      `GET /api/kate/held` and `POST /api/kate/held/:id/action`
 *      endpoints.
 *
 * Phase 1 is **observe-only**: the queue records what Kate would have
 * done, but `proposal_created` still fires for every proposal. The
 * user sees everything; the "Held by Kate" surface is informational
 * (and the surface_now action re-fires nothing — the proposal is
 * already user-visible). This lets us audit scorer quality before
 * flipping the flag to actually suppress.
 *
 * The scorer is a **heuristic** for v0.1, not an LLM call — keeps the
 * proposal-creation hot path fast (~zero ms) and gives us a starting
 * baseline. Replacing with a small Kate-prompted LLM scoring call is
 * a future ship; the queue + endpoints don't change.
 */

import { ulid } from 'ulid';
import type { Database } from 'bun:sqlite';
import type { ProposalKind } from './proposals';
import { compute_focus_mode, compute_in_meeting } from '../app/routes/sensors';

export type FilterDisposition =
  | 'deliver_now'
  | 'batch'
  | 'hold'
  | 'drop'
  | 'precommit_pending';

export interface FilterDecision {
  disposition: FilterDisposition;
  urgency_score: number;        // 0–1
  reason: string;               // ≤1 sentence, user-readable
  category?: string;            // safety | social | finance | decision | …
}

export interface ScoreContext {
  user_id: string;
  specialist_id: string;
  kind: ProposalKind;
  payload: unknown;
  db: Database;
  vault_root: string;
}

// ── Scorer ───────────────────────────────────────────────────────────────
// Heuristic v0.1. Reads the cheapest available context signals and applies
// a short cascade of rules. Order matters: safety is unconditional;
// in-meeting beats Focus; Focus.sleep beats Focus.work; default is
// deliver_now.
//
// The reason strings are intentionally written in the user's voice so
// the "Held by Kate" UI can render them verbatim without massaging.

export function score_proposal(ctx: ScoreContext): FilterDecision {
  const category = derive_category(ctx);

  // Safety-critical always delivers, regardless of context.
  if (category === 'safety') {
    return {
      disposition: 'deliver_now',
      urgency_score: 1.0,
      reason: 'Safety-critical — bypasses every other gate.',
      category,
    };
  }

  // In-meeting → hold non-critical.
  const meeting = compute_in_meeting(ctx.db, ctx.vault_root, ctx.user_id);
  const meetingValue = (meeting.value as { value: boolean } | undefined)?.value;
  if (meetingValue === true) {
    return {
      disposition: 'hold',
      urgency_score: 0.35,
      reason: "You're in a meeting — surfacing after.",
      category,
    };
  }

  // Focus modes.
  const focus = compute_focus_mode(ctx.db, ctx.vault_root, ctx.user_id);
  const focusValue = (focus.value as { value: string | null } | undefined)?.value ?? null;

  if (focusValue === 'sleep') {
    return {
      disposition: 'hold',
      urgency_score: 0.2,
      reason: 'Sleep Focus — held for morning.',
      category,
    };
  }

  if (focusValue === 'driving') {
    // Driving = strongest contextual signal: hands occupied, eyes on
    // road. Hold visual-heavy categories; voice surface (CarPlay) is
    // not yet wired to consume the deliver_now lane.
    return {
      disposition: 'hold',
      urgency_score: 0.4,
      reason: "You're driving — held until you arrive.",
      category,
    };
  }

  if (focusValue === 'work' && (category === 'social' || ctx.kind === 'draft_message')) {
    return {
      disposition: 'hold',
      urgency_score: 0.45,
      reason: 'Work Focus — social held until your next break.',
      category,
    };
  }

  // Default: deliver_now. Score reflects "no negative signal" not
  // "high urgency" — useful gradient for future learning.
  return {
    disposition: 'deliver_now',
    urgency_score: 0.7,
    reason: 'Surfacing now — no quiet-context signal applies.',
    category,
  };
}

/**
 * Best-effort category derivation from the proposal kind + payload.
 * The brief enumerates categories (safety | decision | social | errand
 * | finance | health | system | chatter); for v0.1 we lean on the kind
 * field plus a couple payload sniffs. Returns undefined when nothing
 * matches — the scorer treats undefined as a generic non-safety item.
 */
function derive_category(ctx: ScoreContext): string | undefined {
  switch (ctx.kind) {
    case 'draft_message':   return 'social';
    case 'calendar_event':  return 'decision';
    case 'persona_tuning':  return 'system';
    case 'binding_proposal': return 'system';
    case 'briefing':        return 'chatter';
    default:                break;
  }

  // Payload heuristics — if a payload carries a `category: "safety"`
  // hint (e.g., Cassandra security alerts), honor it.
  if (
    typeof ctx.payload === 'object' &&
    ctx.payload !== null &&
    typeof (ctx.payload as { category?: unknown }).category === 'string'
  ) {
    return (ctx.payload as { category: string }).category;
  }
  return undefined;
}

// ── Queue persistence ────────────────────────────────────────────────────

export interface RecordEntryInput {
  user_id: string;
  proposal_id: string;
  specialist_id: string;
  kind: ProposalKind;
  payload: unknown;
  decision: FilterDecision;
  db: Database;
}

export function record_queue_entry(input: RecordEntryInput): void {
  // Use proposal_id as the queue row id when available — keeps the
  // queue 1:1 with proposals and lets a re-emit (idempotency dup)
  // overwrite the prior row instead of accumulating duplicates.
  const id = input.proposal_id || ulid();
  const now_iso = new Date().toISOString();
  try {
    input.db.prepare(
      `INSERT OR REPLACE INTO kate_filter_queue
         (id, user_id, specialist_id, kind, category, payload_json,
          created_at, urgency_score, disposition, disposition_reason)
       VALUES (@id, @u, @sid, @k, @c, @pl, @ts, @us, @disp, @reason)`,
    ).run({
      '@id': id,
      '@u': input.user_id,
      '@sid': input.specialist_id,
      '@k': input.kind,
      '@c': input.decision.category ?? null,
      '@pl': JSON.stringify(input.payload),
      '@ts': now_iso,
      '@us': input.decision.urgency_score,
      '@disp': input.decision.disposition,
      '@reason': input.decision.reason,
    });
  } catch (err) {
    // Filter queue writes are best-effort — a failure here must not
    // block the legacy proposal_created emission that happens
    // alongside. Log and move on.
    console.warn(
      `[kate_filter] queue write failed for ${input.proposal_id}: ${(err as Error).message}`,
    );
  }
}

// ── Held-surface queries ─────────────────────────────────────────────────

export interface HeldItem {
  id: string;
  specialist_id: string;
  kind: string;
  category: string | null;
  summary: string;              // first ~120 chars from payload, user-facing
  reason: string;
  held_since: string;
}

export interface DroppedSummary {
  specialist_id: string;
  kind: string;
  category: string | null;
  reason: string;
}

export interface HeldEndpointBody {
  held: HeldItem[];
  dropped_today: DroppedSummary[];
  batched_into_next_brief: number;
}

export function list_held(db: Database, user_id: string): HeldEndpointBody {
  const held_rows = db.prepare(
    `SELECT id, specialist_id, kind, category, payload_json, created_at, disposition_reason
     FROM kate_filter_queue
     WHERE user_id = @u
       AND disposition = 'hold'
       AND delivered_at IS NULL
     ORDER BY created_at DESC
     LIMIT 50`,
  ).all({ '@u': user_id }) as Array<{
    id: string;
    specialist_id: string;
    kind: string;
    category: string | null;
    payload_json: string;
    created_at: string;
    disposition_reason: string | null;
  }>;

  const today_start = new Date();
  today_start.setUTCHours(0, 0, 0, 0);

  const dropped_rows = db.prepare(
    `SELECT specialist_id, kind, category, disposition_reason
     FROM kate_filter_queue
     WHERE user_id = @u
       AND disposition = 'drop'
       AND created_at >= @since
     ORDER BY created_at DESC
     LIMIT 50`,
  ).all({ '@u': user_id, '@since': today_start.toISOString() }) as Array<{
    specialist_id: string;
    kind: string;
    category: string | null;
    disposition_reason: string | null;
  }>;

  const batched_row = db.prepare(
    `SELECT COUNT(*) as n FROM kate_filter_queue
     WHERE user_id = @u
       AND disposition = 'batch'
       AND delivered_at IS NULL`,
  ).get({ '@u': user_id }) as { n: number } | undefined;

  return {
    held: held_rows.map((r) => ({
      id: r.id,
      specialist_id: r.specialist_id,
      kind: r.kind,
      category: r.category,
      summary: summarize_payload(r.payload_json),
      reason: r.disposition_reason ?? '',
      held_since: r.created_at,
    })),
    dropped_today: dropped_rows.map((r) => ({
      specialist_id: r.specialist_id,
      kind: r.kind,
      category: r.category,
      reason: r.disposition_reason ?? '',
    })),
    batched_into_next_brief: batched_row?.n ?? 0,
  };
}

function summarize_payload(payload_json: string): string {
  // Cheap user-facing one-liner for the held card. Prefer well-known
  // fields (title, summary, body_md, draft_to); fall back to the first
  // ~120 chars of the JSON serialization. Never throw — a failure here
  // shouldn't make /api/kate/held 500.
  try {
    const obj = JSON.parse(payload_json) as Record<string, unknown>;
    for (const key of ['title', 'summary', 'body_md', 'rationale', 'rationale_md', 'draft_to']) {
      const v = obj[key];
      if (typeof v === 'string' && v.trim().length > 0) {
        return v.length > 120 ? `${v.slice(0, 117)}…` : v;
      }
    }
    const str = JSON.stringify(obj);
    return str.length > 120 ? `${str.slice(0, 117)}…` : str;
  } catch {
    return payload_json.slice(0, 120);
  }
}

// ── User actions on held items ───────────────────────────────────────────

export type HeldAction = 'surface_now' | 'dismiss' | 'always_drop_like_this';

export function apply_held_action(args: {
  db: Database;
  user_id: string;
  id: string;
  action: HeldAction;
}): { ok: boolean; error?: string } {
  const row = args.db.prepare(
    `SELECT user_id, disposition FROM kate_filter_queue WHERE id = @id`,
  ).get({ '@id': args.id }) as { user_id: string; disposition: string | null } | undefined;

  if (!row) return { ok: false, error: 'not found' };
  if (row.user_id !== args.user_id) return { ok: false, error: 'not yours' };

  const now_iso = new Date().toISOString();
  switch (args.action) {
    case 'surface_now':
      // Flip disposition + mark engaged. In Phase 1 the proposal_created
      // event already fired, so there's nothing to re-emit; we record
      // the user's choice for the future scorer learning loop.
      args.db.prepare(
        `UPDATE kate_filter_queue
         SET disposition = 'deliver_now',
             engaged_at = @ts,
             outcome = 're_elevated'
         WHERE id = @id`,
      ).run({ '@id': args.id, '@ts': now_iso });
      return { ok: true };

    case 'dismiss':
      args.db.prepare(
        `UPDATE kate_filter_queue
         SET engaged_at = @ts,
             outcome = 'dismissed'
         WHERE id = @id`,
      ).run({ '@id': args.id, '@ts': now_iso });
      return { ok: true };

    case 'always_drop_like_this':
      // Future learning signal — for v0.1 we record the engagement;
      // the trust ratchet that consumes it lands later.
      args.db.prepare(
        `UPDATE kate_filter_queue
         SET disposition = 'drop',
             engaged_at = @ts,
             outcome = 'dismissed'
         WHERE id = @id`,
      ).run({ '@id': args.id, '@ts': now_iso });
      return { ok: true };

    default:
      return { ok: false, error: 'unknown action' };
  }
}
