/**
 * scan_calendar_followups — Kate's cross-domain reactive followups on the EDGE
 * of a calendar event (Phase 3, 2026-06-20).
 *
 * The calendar twin of scan_good_followups (the codebase's "probe path" idiom:
 * a date-scanning background job that detects an edge and ACTS via a gated
 * proposal — the owner's tap is the floor, deciding accrues Trust-Ladder XP).
 * It scans three edges and files a cordon-scoped `action_proposal` per edge,
 * ONCE (exists_for_signature):
 *
 *   - birthday_minus_14d — a Person's birthday entering the ~14-day window →
 *     Kate proposes a gift, drawn from that person's tracked likes within a
 *     LEARNED per-person budget (compute_learned_gift_budget over gift_history;
 *     never hard-coded). With an LLM she brainstorms 2-3 concrete ideas; without
 *     one she names the budget + likes and offers to sort it out. (The flagship.)
 *   - vacation_added — an actionable vacation/trip life_event in window → offer
 *     to nail down flight details + schedule a welcome-back reminder.
 *   - appointment_soon — an actionable appointment within a few days → offer to
 *     check the address + drive-time.
 *
 * Why a deterministic background job rather than a wake_deliberation pass: edge
 * dedup must survive the multi-day window AND a restart, and a deliberation's
 * proposal signature is LLM-authored (unreliable for `exists_for_signature`).
 * The job sets the signature itself — exactly the proven scan_good_followups
 * shape. DARK behind HEARTH_CALENDAR_TRIGGERS; NOT on Kate's LLM surfaces — the
 * background_jobs runner invokes it by name (manual catch-up:
 * POST /api/specialists/kate/fire_background_job?name=calendar_followups).
 */
import { z } from 'zod';
import type { Tool, ToolContext } from '@core/tool';
import type { ToolDeps } from '@core/tool_deps';
import type { MemoryClient, LifeEventRow } from '@memory/client';
import type { ProposalsStore } from '@core/proposals';
import type { LLMRouter } from '@core/llm';
import { compute_learned_gift_budget, format_gift_budget, type GiftHistoryEntry } from '@core/gift_budget';

/** Kill switch — DARK by default (off); the autonomous edge-driven proposer. */
export function calendar_triggers_enabled(): boolean {
  return process.env.HEARTH_CALENDAR_TRIGGERS === '1';
}

const InputSchema = z.object({
  birthday_within_days: z.number().int().positive().max(90).default(14),
  vacation_within_days: z.number().int().positive().max(180).default(45),
  appointment_within_days: z.number().int().positive().max(30).default(3),
});
const OutputSchema = z.object({
  enabled: z.boolean(),
  due: z.number(),
  filed: z.number(),
  proposal_ids: z.array(z.string()),
});
type Input = z.infer<typeof InputSchema>;
type Output = z.infer<typeof OutputSchema>;

/** household/owner → owner-global proposal (null); a member's event → that member. */
function cordon_user(private_to: string | null): string | null {
  if (!private_to || private_to === 'household' || private_to === 'owner') return null;
  return private_to;
}

/** Content-stable anchor — a shared calendar surfaces the SAME event from two
 *  sub-calendars as two life_event notes (distinct ids). Keying the proposal
 *  signature on title+date (not the note id) collapses those into ONE followup. */
function content_anchor(title: string, due_date: string): string {
  return `${title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()}:${due_date}`;
}

export interface ScanCalendarFollowupsDeps {
  memory: MemoryClient;
  proposals: ProposalsStore;
  llm?: LLMRouter;
}

/** Best-effort 2-3 gift ideas from a person's likes within a budget. Fail-open
 *  to [] (the caller then files a likes+budget templated offer). */
async function brainstorm_gift_ideas(
  llm: LLMRouter | undefined,
  name: string,
  likes: string[],
  budget_line: string,
): Promise<string[]> {
  if (!llm || likes.length === 0) return [];
  try {
    const role = llm.for_role('planner');
    const resp = await role.provider.complete({
      messages: [
        {
          role: 'system',
          content:
            'You suggest gift ideas. Given a person, what they like, and a budget, return 2-3 SPECIFIC, ' +
            'concrete gift ideas (not categories) as a JSON array of short strings. Stay within budget. ' +
            'Output ONLY the JSON array, e.g. ["a Front Range trail guide","a Ritual Chocolate tasting box"].',
        },
        { role: 'user', content: `Person: ${name}\nLikes: ${likes.join(', ')}\n${budget_line}` },
      ],
      temperature: 0.4,
    });
    const raw = (resp.content ?? '').trim();
    const m = raw.match(/\[[\s\S]*\]/);
    if (!m) return [];
    const parsed = JSON.parse(m[0]) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.map((x) => String(x).trim()).filter(Boolean).slice(0, 3);
  } catch {
    return [];
  }
}

/**
 * The judgment gate (2026-07-20, Stage A of the autonomy ladder): the edges
 * below GATHER candidates on date arithmetic, but nothing files until ONE
 * model call judges what a good chief of staff would actually bring up —
 * the same fail-CLOSED contract as scan_life_events' triage. The scanners'
 * arithmetic finds the moment; the model decides whether the moment
 * deserves a card. This is the "stop filing trash" gate — pre-gate, these
 * scanners filed on set membership alone and the queue paid for it.
 * Returns the set of approved refs, or null on ANY failure (→ file nothing
 * this pass; the daily job retries tomorrow).
 */
async function judge_worth_owner_attention(
  llm: LLMRouter | undefined,
  lines: string[],
): Promise<Set<number> | null> {
  if (lines.length === 0) return new Set();
  if (!llm) return null;
  try {
    const role = llm.for_role(process.env.HEARTH_CALENDAR_GATE_TIER ?? 'planner');
    const resp = await role.provider.complete({
      messages: [
        {
          role: 'system',
          content:
            "You guard a busy owner's attention. Each numbered line is a calendar-driven " +
            'offer his assistant COULD make (arrange a gift, prep a trip, prep an ' +
            'appointment). Approve ONLY what a good chief of staff would actually bring ' +
            'up: genuinely timely, decision-shaped, worth an interruption. Routine noise ' +
            '(a trivial recurring appointment, a trip already handled) gets dropped. ' +
            'Reply with ONLY JSON: {"file":[refs]}',
        },
        { role: 'user', content: `Candidates:\n${lines.join('\n')}\n\nReply with ONLY the JSON.` },
      ],
      temperature: 0.2,
      max_tokens: 300,
      think: false,
    });
    const raw = (resp.content ?? '').replace(/```(?:json)?|```/g, '').trim();
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) return null;
    const parsed = JSON.parse(m[0]) as { file?: unknown };
    if (!Array.isArray(parsed.file)) return null;
    const out = new Set<number>();
    for (const r of parsed.file) {
      const n = Number.parseInt(String(r), 10);
      if (Number.isFinite(n)) out.add(n);
    }
    return out;
  } catch {
    return null; // fail-CLOSED — no judgment → no offers this pass
  }
}

export function make_scan_calendar_followups(deps: ScanCalendarFollowupsDeps): Tool<Input, Output> {
  return {
    name: 'scan_calendar_followups',
    description:
      'Scan the calendar graph for upcoming birthdays (→ gift), vacations (→ flights + welcome-back), and appointments (→ prep) and, on the edge (once per event), file a followup action_proposal so Kate offers to act. Background job; not a chat tool.',
    risk: 'write_internal',
    required_capabilities: ['monitor_calendar_followups'],
    input_schema: InputSchema,
    output_schema: OutputSchema,
    volatile: true,

    idempotency_key() {
      return `scan_calendar_followups:${Math.floor(Date.now() / 60_000)}`;
    },

    async execute(input, ctx: ToolContext): Promise<Output> {
      if (!calendar_triggers_enabled()) {
        return { enabled: false, due: 0, filed: 0, proposal_ids: [] };
      }
      const now = ctx.now ?? new Date();
      const proposal_ids: string[] = [];
      let due = 0;
      // Gather-then-gate (2026-07-20): each edge pushes a one-line summary +
      // a filing closure; NOTHING files until judge_worth_owner_attention
      // approves the ref. Expensive per-card work (gift brainstorming) moved
      // inside the closures so gated-out candidates cost zero model calls.
      const candidates: Array<{ line: string; file: () => Promise<string | null> }> = [];

      // ── 1. Birthdays → gift (the flagship) ─────────────────────────────────
      // Reads People (likes + gift_history), so the gift loop is grounded.
      for (const ev of deps.memory.birthdays_within(input.birthday_within_days, now)) {
        const note = deps.memory.read_note(ev.note_path);
        const fm = note?.frontmatter ?? {};
        if (fm.relationship === 'self') continue; // never propose gifting yourself
        due++;
        const target_date = new Date(now.getTime() + ev.days_until * 86_400_000)
          .toISOString()
          .slice(0, 10); // time-guard-ok: stable anchor key for the birthday occurrence
        const signature = {
          specialist_id: 'kate',
          kind: 'action_proposal',
          category: 'birthday_gift',
          anchor: `${ev.person_id}:${target_date}`,
        };
        if (deps.proposals.exists_for_signature(signature)) continue;

        candidates.push({
          line: `birthday gift: ${ev.name}, birthday in ${ev.days_until} day(s) (${ev.date})`,
          file: async () => {
            const likes = Array.isArray(fm.likes) ? (fm.likes as string[]) : [];
            const budget = compute_learned_gift_budget(fm.gift_history as GiftHistoryEntry[] | undefined);
            const budget_line = format_gift_budget(budget);
            const ideas = await brainstorm_gift_ideas(deps.llm, ev.name, likes, budget_line);

            const when = ev.days_until === 0 ? 'today' : `in ${ev.days_until} day${ev.days_until === 1 ? '' : 's'}`;
            const lead = `**${ev.name}**'s birthday is ${when} (${ev.date}). ${budget_line}.`;
            const body =
              ideas.length > 0
                ? `Ideas from what they like: ${ideas.join('; ')}.`
                : likes.length > 0
                  ? `They like: ${likes.join(', ')}.`
                  : `I don't have anything on what they like yet — tell me and I'll suggest something.`;
            try {
              return deps.proposals.create({
                specialist_id: 'kate',
                kind: 'action_proposal',
                user_id: null, // People are household-shared; gifting is the owner's to coordinate
                execution_kind: 'none',
                payload: {
                  followup_kind: 'birthday_gift',
                  person_id: ev.person_id,
                  person_name: ev.name,
                  note_path: ev.note_path,
                  birthday_date: ev.date,
                  days_until: ev.days_until,
                  budget: { amount: budget.amount, low: budget.low, high: budget.high, currency: budget.currency, basis: budget.basis },
                  likes,
                  ideas,
                  verb: 'review',
                },
                rationale: `${lead} ${body} Want me to sort out a gift?`,
                signature,
              });
            } catch {
              return null; /* fail-open — one bad person never aborts the sweep */
            }
          },
        });
      }

      // ── 2. Vacations → flights + welcome-back ──────────────────────────────
      for (const { event, due_date } of deps.memory.life_events_needing_followup(['vacation', 'trip'], input.vacation_within_days, now)) {
        due++;
        candidates.push({
          line: `trip prep: "${event.title}" starts ${due_date}`,
          file: async () =>
            file_event_followup(deps, event, {
              category: 'vacation_followup',
              anchor_suffix: 'flights',
              verb: 'review',
              rationale:
                `**${event.title}** starts ${due_date}${event.end_date ? ` (back ${event.end_date.slice(0, 10)})` : ''}. ` +
                `Want me to nail down the flight/travel details and set a welcome-back reminder?`,
              payload_kind: 'vacation_flights',
              due_date,
            }),
        });
      }

      // ── 3. Appointments → prep (address + drive-time) ──────────────────────
      for (const { event, due_date } of deps.memory.life_events_needing_followup(['appointment'], input.appointment_within_days, now)) {
        due++;
        candidates.push({
          line: `appointment prep: "${event.title}" on ${due_date}${event.location ? ` at ${event.location}` : ''}`,
          file: async () =>
            file_event_followup(deps, event, {
              category: 'appointment_followup',
              anchor_suffix: 'prep',
              verb: 'review',
              rationale:
                `**${event.title}** is ${due_date}${event.location ? ` at ${event.location}` : ''}. ` +
                `Want me to check the address + drive-time so you leave on time?`,
              payload_kind: 'appointment_prep',
              due_date,
            }),
        });
      }

      // ── The judgment gate — file only what clears it ───────────────────────
      const approved = await judge_worth_owner_attention(
        deps.llm,
        candidates.map((c, i) => `[${i}] ${c.line}`),
      );
      let gated_out = 0;
      if (approved !== null) {
        for (let i = 0; i < candidates.length; i++) {
          if (!approved.has(i)) {
            gated_out++;
            continue;
          }
          const pid = await candidates[i]!.file();
          if (pid) proposal_ids.push(pid);
        }
      }

      deps.memory.log_action({
        intent_id: ctx.intent_id,
        agent: ctx.specialist_id ?? 'kate',
        tool_name: 'calendar_followups_scan',
        tool_input: { ...input },
        execution_result: {
          due,
          filed: proposal_ids.length,
          gated_out,
          gate_failed: approved === null && candidates.length > 0,
        },
      });

      return { enabled: true, due, filed: proposal_ids.length, proposal_ids };
    },
  };
}

/** Shared filer for the life_event-backed edges (vacation/appointment). Returns
 *  the new proposal id, or null when already filed (edge dedup) / on error. */
function file_event_followup(
  deps: ScanCalendarFollowupsDeps,
  event: LifeEventRow,
  opts: {
    category: string;
    anchor_suffix: string;
    verb: string;
    rationale: string;
    payload_kind: string;
    due_date: string;
  },
): string | null {
  const signature = {
    specialist_id: 'kate',
    kind: 'action_proposal',
    category: opts.category,
    // Content-stable (title+date), so duplicate calendar notes for one real event
    // collapse to a single followup — not `${event.id}` (distinct per note).
    anchor: `${content_anchor(event.title, opts.due_date)}:${opts.anchor_suffix}`,
  };
  if (deps.proposals.exists_for_signature(signature)) return null;
  try {
    return deps.proposals.create({
      specialist_id: 'kate',
      kind: 'action_proposal',
      user_id: cordon_user(event.private_to),
      execution_kind: 'none',
      payload: {
        followup_kind: opts.payload_kind,
        event_id: event.id,
        event_name: event.title,
        note_path: event.note_path,
        due_date: opts.due_date,
        ...(event.location ? { location: event.location } : {}),
        verb: opts.verb,
      },
      rationale: opts.rationale,
      signature,
    });
  } catch {
    return null;
  }
}

export function create(deps: ToolDeps): Tool {
  return make_scan_calendar_followups({ memory: deps.memory, proposals: deps.proposals, llm: deps.llm }) as Tool;
}
