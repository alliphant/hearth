/**
 * scan_cross_signals — Kate's cross-signal "I noticed" fusion nudges (Piece 2,
 * 2026-06-21). The flagship of the proactivity arc: where two upcoming signals
 * COINCIDE in a way a single-domain scan can't see, Kate offers to act.
 *
 * Mirrors scan_calendar_followups EXACTLY (the proven "probe path" idiom): a
 * deterministic date-scan detects an edge and ACTS via a gated `action_proposal`
 * — the owner's tap is the floor, deciding accrues Trust-Ladder XP. Two
 * high-precision coincidence rules:
 *
 *   - visitor + their occasion (the flagship): an upcoming visit/trip/vacation
 *     whose participant (named in the title or its participants list) has a
 *     birthday/anniversary inside the visit window (± a pad). Kate offers to sort
 *     a gift (drawn from tracked likes within a LEARNED budget) and plan
 *     something while they're here. → ONE proposal anchored on person+occasion+
 *     visit, so it surfaces once.
 *   - double-booking: two TIMED life_events for the SAME owner whose times
 *     overlap → "heads up, your 2pm and 2:30 overlap."
 *
 * Deterministic coincidence detection (the math lives in
 * @core/calendar/cross_signals, smoke-testable without a vault); an optional
 * single planner call phrases the visitor nudge warmly (fail-open to a template,
 * never blocks). Each proposal is cordon-scoped to its SIGNAL's owner (the owner
 * has no god-view of a member's personal event). DARK behind HEARTH_CROSS_SIGNAL;
 * NOT on Kate's LLM surfaces — the background_jobs runner invokes it by name
 * (manual catch-up: POST /api/specialists/kate/fire_background_job?name=cross_signals).
 */
import { z } from 'zod';
import type { Tool, ToolContext } from '@core/tool';
import type { ToolDeps } from '@core/tool_deps';
import type { MemoryClient, LifeEventRow } from '@memory/client';
import type { ProposalsStore } from '@core/proposals';
import type { LLMRouter } from '@core/llm';
import { format_short_datetime } from '@core/time';
import {
  cross_signal_enabled,
  occasion_in_visit_window,
  timed_bounds,
  ranges_overlap,
  name_mentioned,
} from '@core/calendar/cross_signals';
import { compute_learned_gift_budget, format_gift_budget, type GiftHistoryEntry } from '@core/gift_budget';

const InputSchema = z.object({
  /** How far ahead to look for an upcoming visit/trip. */
  visit_within_days: z.number().int().positive().max(180).default(45),
  /** ± slack on the occasion vs the visit window (a birthday a few days off still counts). */
  occasion_pad_days: z.number().int().min(0).max(14).default(3),
  /** How far ahead to look for overlapping timed events. */
  conflict_within_days: z.number().int().positive().max(60).default(14),
});
const OutputSchema = z.object({
  enabled: z.boolean(),
  coincidences: z.number(),
  filed: z.number(),
  proposal_ids: z.array(z.string()),
});
type Input = z.infer<typeof InputSchema>;
type Output = z.infer<typeof OutputSchema>;

/** household/owner → owner-global proposal (null); a member's signal → that member. */
function cordon_user(private_to: string | null): string | null {
  if (!private_to || private_to === 'household' || private_to === 'owner') return null;
  return private_to;
}

/** Content-stable anchor — duplicate calendar notes for one real event collapse
 *  to one coincidence (keyed on title+date, not the per-note id). */
function content_anchor(title: string, due_date: string): string {
  return `${title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()}:${due_date}`;
}

/** A normalized title (whitespace/punct-folded) — the stable half of an event's
 *  content identity. */
function title_key(title: string): string {
  return (title ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/** Collapse duplicate life_event NOTES of ONE real event: a shared calendar
 *  surfaces the same event from two sub-calendars as two notes with distinct ids
 *  but identical title + start instant. Keyed on normalized title + the FULL
 *  start datetime (so two genuinely-distinct same-day events at different times
 *  survive), keeping the first. Without this the double-booking rule pairs an
 *  event with its own duplicate note. */
function dedupe_events(events: LifeEventRow[]): LifeEventRow[] {
  const seen = new Set<string>();
  const out: LifeEventRow[] = [];
  for (const ev of events) {
    const key = `${title_key(ev.title)}|${ev.event_date ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(ev);
  }
  return out;
}

/** A YYYY-MM-DD (or ISO datetime) → "M/D" for the nudge prose. Pure string math
 *  (no Date / wall-clock) so it's tz-free and guard-clean. */
function md(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso ?? '');
  if (!m) return iso;
  return `${parseInt(m[2]!, 10)}/${parseInt(m[3]!, 10)}`;
}

/** Categories / title cues that mark a life_event as "someone is visiting / away". */
const VISIT_CATEGORIES = new Set(['vacation', 'trip', 'visit', 'visitor']);
const VISIT_TITLE =
  /\b(?:visit|visiting|visits|in town|coming to town|comes? to (?:town|visit)|staying with|stay with|coming for)\b/i;

function is_visit_event(ev: LifeEventRow): boolean {
  if (ev.category && VISIT_CATEGORIES.has(ev.category.toLowerCase())) return true;
  return VISIT_TITLE.test(ev.title);
}

/** Participants named on the event (frontmatter participants array) + the title. */
function event_haystack(ev: LifeEventRow): string {
  let participants = '';
  try {
    const fm = JSON.parse(ev.frontmatter_json) as { participants?: unknown };
    if (Array.isArray(fm.participants)) participants = fm.participants.map((p) => String(p)).join(' ');
  } catch {
    /* frontmatter unparseable — the title alone still drives matching */
  }
  return `${ev.title} ${participants}`;
}

export interface ScanCrossSignalsDeps {
  memory: MemoryClient;
  proposals: ProposalsStore;
  llm?: LLMRouter;
}

/** Best-effort warm one-sentence phrasing of a coincidence nudge. Fail-open to
 *  `fallback` (an LLM outage / odd output never blocks the proposal). */
async function warm_phrase(llm: LLMRouter | undefined, context: string, fallback: string): Promise<string> {
  if (!llm) return fallback;
  try {
    const role = llm.for_role('planner');
    const resp = await role.provider.complete({
      messages: [
        {
          role: 'system',
          content:
            'You are Kate, a warm, concise chief of staff. Given a noticed coincidence, write ONE friendly ' +
            'sentence that points it out and offers to help. No preamble, no markdown headers, no quotes, ' +
            '≤ 240 characters. Output only the sentence.',
        },
        { role: 'user', content: context },
      ],
      temperature: 0.5,
    });
    const out = (resp.content ?? '').trim().replace(/^["']+|["']+$/g, '');
    return out.length >= 8 && out.length <= 280 ? out : fallback;
  } catch {
    return fallback;
  }
}

export function make_scan_cross_signals(deps: ScanCrossSignalsDeps): Tool<Input, Output> {
  return {
    name: 'scan_cross_signals',
    description:
      'Scan upcoming calendar signals for COINCIDENCES a single-domain scan misses — a visitor whose birthday/anniversary lands during their visit (→ gift + plan), or two of the owner\'s events whose times overlap (→ heads-up) — and, on the edge (once per coincidence), file a nudge action_proposal. Background job; not a chat tool.',
    risk: 'write_internal',
    required_capabilities: ['monitor_cross_signals'],
    input_schema: InputSchema,
    output_schema: OutputSchema,
    volatile: true,

    idempotency_key() {
      return `scan_cross_signals:${Math.floor(Date.now() / 60_000)}`;
    },

    async execute(input, ctx: ToolContext): Promise<Output> {
      if (!cross_signal_enabled()) {
        return { enabled: false, coincidences: 0, filed: 0, proposal_ids: [] };
      }
      const now = ctx.now ?? new Date();
      const proposal_ids: string[] = [];
      let coincidences = 0;

      // ── Rule 1 — visitor + their occasion (the flagship) ───────────────────
      const people = deps.memory.people_occasions();
      const visit_events = dedupe_events(
        deps.memory.upcoming_life_events_uncordoned(input.visit_within_days, now),
      ).filter(is_visit_event);

      for (const ev of visit_events) {
        if (!ev.event_date) continue;
        const haystack = event_haystack(ev);
        const visit_start = ev.event_date;
        const visit_end = ev.end_date ?? ev.event_date;

        for (const person of people) {
          if (person.relationship === 'self') continue; // not a "visitor"
          if (!name_mentioned(person.name, haystack)) continue;

          for (const occ of person.occasions) {
            const occ_iso = occasion_in_visit_window(occ.date, visit_start, visit_end, input.occasion_pad_days);
            if (!occ_iso) continue;
            coincidences++;

            const signature = {
              specialist_id: 'kate',
              kind: 'action_proposal',
              category: 'visitor_occasion',
              anchor: `${person.person_id}:${occ.kind}:${content_anchor(ev.title, visit_start.slice(0, 10))}`,
            };
            if (deps.proposals.exists_for_signature(signature)) continue;

            // Gift grounding (birthday/anniversary both warrant a gift) — likes +
            // a LEARNED per-person budget from the person's note. Fail-soft to a
            // bare offer when the note has neither.
            const note = deps.memory.read_note(person.note_path);
            const fm = note?.frontmatter ?? {};
            const likes = Array.isArray(fm.likes) ? (fm.likes as string[]) : [];
            const budget = compute_learned_gift_budget(fm.gift_history as GiftHistoryEntry[] | undefined);
            const budget_line = format_gift_budget(budget);
            const occ_label = occ.kind === 'anniversary' && occ.what ? occ.what : occ.kind;

            const lead =
              `**${person.name}** is around for "${ev.title}" (${md(visit_start)}` +
              `${visit_end !== visit_start ? `–${md(visit_end)}` : ''}), and their ${occ_label} ` +
              `lands ${md(occ_iso)} — right in the window.`;
            const likes_hint = likes.length > 0 ? ` They like: ${likes.join(', ')}.` : '';
            const fallback = `${lead}${likes_hint} Want me to sort a gift (${budget_line}) and plan something while they're here?`;
            const rationale = await warm_phrase(
              deps.llm,
              `Coincidence: ${person.name} is visiting for "${ev.title}" (${md(visit_start)}) and their ${occ_label} ` +
                `is ${md(occ_iso)}.${likes_hint} Budget: ${budget_line}. Offer to sort a gift and plan something.`,
              fallback,
            );

            try {
              const pid = deps.proposals.create({
                specialist_id: 'kate',
                kind: 'action_proposal',
                user_id: cordon_user(ev.private_to),
                execution_kind: 'none',
                payload: {
                  followup_kind: 'visitor_occasion',
                  person_id: person.person_id,
                  person_name: person.name,
                  person_note_path: person.note_path,
                  occasion_kind: occ.kind,
                  occasion_date: occ_iso,
                  event_id: ev.id,
                  event_name: ev.title,
                  note_path: ev.note_path,
                  visit_start,
                  visit_end,
                  budget: { amount: budget.amount, low: budget.low, high: budget.high, currency: budget.currency, basis: budget.basis },
                  likes,
                  verb: 'review',
                },
                rationale,
                signature,
              });
              proposal_ids.push(pid);
            } catch {
              /* fail-open — one bad coincidence never aborts the sweep */
            }
          }
        }
      }

      // ── Rule 2 — double-booking (same owner, overlapping timed events) ──────
      // A double-booking is two POINT-IN-TIME commitments that clash. A multi-day
      // trip/visit/vacation is a span, not a slot — two overlapping trips aren't a
      // conflict — so events longer than MAX_CONFLICT_DURATION_MS are excluded.
      const MAX_CONFLICT_DURATION_MS = 12 * 3_600_000;
      // Dedupe duplicate notes of one event FIRST, so a shared-calendar event
      // never pairs with its own twin note (the "Ann Kent ^ Ann Kent" artifact).
      const conflict_events = dedupe_events(
        deps.memory.upcoming_life_events_uncordoned(input.conflict_within_days, now),
      );
      const by_owner = new Map<string, Array<{ ev: LifeEventRow; bounds: { start_ms: number; end_ms: number } }>>();
      for (const ev of conflict_events) {
        if (!ev.owner) continue; // a conflict is meaningful only when it's ONE person's
        const bounds = timed_bounds(ev.event_date, ev.end_date);
        if (!bounds) continue; // all-day events don't double-book
        if (bounds.end_ms - bounds.start_ms > MAX_CONFLICT_DURATION_MS) continue; // a multi-day span isn't a slot clash
        const list = by_owner.get(ev.owner) ?? [];
        list.push({ ev, bounds });
        by_owner.set(ev.owner, list);
      }
      for (const list of by_owner.values()) {
        for (let i = 0; i < list.length; i++) {
          for (let j = i + 1; j < list.length; j++) {
            const a = list[i]!;
            const b = list[j]!;
            if (!ranges_overlap(a.bounds, b.bounds)) continue;
            // Anchor on title + FULL start instant so two distinct same-day events
            // stay distinct; a surviving twin note (same title+start) self-pairs
            // and is skipped (belt-and-suspenders after dedupe_events).
            const aa = `${title_key(a.ev.title)}:${a.ev.event_date ?? ''}`;
            const bb = `${title_key(b.ev.title)}:${b.ev.event_date ?? ''}`;
            if (aa === bb) continue; // the same event surfaced twice — not a conflict
            coincidences++;
            const pair = [aa, bb].sort().join('|');
            const signature = {
              specialist_id: 'kate',
              kind: 'action_proposal',
              category: 'double_booking',
              anchor: pair,
            };
            if (deps.proposals.exists_for_signature(signature)) continue;

            const a_when = format_short_datetime(a.ev.event_date!);
            const b_when = format_short_datetime(b.ev.event_date!);
            const rationale =
              `Heads up — **${a.ev.title}** (${a_when}) and **${b.ev.title}** (${b_when}) overlap. ` +
              `Want me to move one?`;
            try {
              const pid = deps.proposals.create({
                specialist_id: 'kate',
                kind: 'action_proposal',
                user_id: cordon_user(a.ev.private_to),
                execution_kind: 'none',
                payload: {
                  followup_kind: 'double_booking',
                  event_a: { id: a.ev.id, name: a.ev.title, note_path: a.ev.note_path, ts_start: a.ev.event_date },
                  event_b: { id: b.ev.id, name: b.ev.title, note_path: b.ev.note_path, ts_start: b.ev.event_date },
                  verb: 'review',
                },
                rationale,
                signature,
              });
              proposal_ids.push(pid);
            } catch {
              /* fail-open */
            }
          }
        }
      }

      deps.memory.log_action({
        intent_id: ctx.intent_id,
        agent: ctx.specialist_id ?? 'kate',
        tool_name: 'cross_signal_scan',
        tool_input: { ...input },
        execution_result: { coincidences, filed: proposal_ids.length },
      });

      return { enabled: true, coincidences, filed: proposal_ids.length, proposal_ids };
    },
  };
}

export function create(deps: ToolDeps): Tool {
  return make_scan_cross_signals({ memory: deps.memory, proposals: deps.proposals, llm: deps.llm }) as Tool;
}
