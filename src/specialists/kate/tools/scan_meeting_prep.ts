/**
 * scan_meeting_prep — "before you see them" proactive prep (People-engine Phase B,
 * 2026-06-25).
 *
 * The payoff of the sensing + deepening work: at the right moment (an upcoming
 * calendar meeting with a known person), Kate hands you the heads-up — what's
 * OPEN with them, what's worth BRINGING UP, whether you're OVERDUE. The
 * relationship counterpart of scan_calendar_followups (which fires on the
 * calendar's OWN concerns — birthdays/vacations/appointments); this one fires
 * when an event NAMES someone in your contact graph, and fills the card from the
 * dossier the synthesis pass deepened.
 *
 * Mirrors the proven proactive idiom: detect the edge (an upcoming event naming a
 * known person), assemble (pure, grounded — see [people_prep.ts](src/core/people_prep.ts)),
 * and file a `briefing` ONCE per (person, event). A briefing is the right kind: an
 * FYI heads-up that SELF-EXPIRES (a prep for a past meeting shouldn't linger) and
 * dedups on topic+for_event. The ACTIONABLE items already have their own
 * action_proposals (Phase A open-loop followups / Phase C life-event offers); this
 * is the read-in, not a second action surface. No LLM (pure assembly of model-
 * produced knowledge — nothing to fabricate). DARK behind HEARTH_MEETING_PREP; NOT
 * on Kate's LLM surfaces — the background_jobs runner invokes it by name (manual
 * catch-up: POST /api/specialists/kate/fire_background_job?name=meeting_prep).
 */
import { z } from 'zod';
import type { Tool, ToolContext } from '@core/tool';
import type { ToolDeps } from '@core/tool_deps';
import type { Database } from 'bun:sqlite';
import type { MemoryClient, PersonRow } from '@memory/client';
import type { ProposalsStore, CategorySignature } from '@core/proposals';
import type { UserRegistry } from '@core/users';
import type { LLMRouter } from '@core/llm';
import type { Caller } from '@memory/private_to';
import { is_non_contact } from '@core/relationship_signals';
import { assemble_meeting_prep } from '@core/people_prep';

export function meeting_prep_enabled(): boolean {
  return process.env.HEARTH_MEETING_PREP === '1';
}
function tier(): string {
  return process.env.HEARTH_MEETING_PREP_TIER || 'planner';
}
function max_preps(): number {
  const n = Number.parseInt(process.env.HEARTH_MEETING_PREP_MAX ?? '', 10);
  return Number.isFinite(n) && n >= 0 ? n : 8;
}

const InputSchema = z.object({
  /** How far ahead to prep — meeting prep is right-moment, so a short window. */
  within_days: z.number().int().positive().max(14).default(2),
});
const OutputSchema = z.object({
  enabled: z.boolean(),
  meetings: z.number(),
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

/** Content-stable anchor — duplicate calendar notes for one real event collapse. */
function content_anchor(title: string, when: string): string {
  return `${title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()}:${when.slice(0, 10)}`;
}

/** Participants named on the event frontmatter + the title — the match haystack. */
function event_haystack(title: string, frontmatter_json: string): string {
  let participants = '';
  try {
    const fm = JSON.parse(frontmatter_json) as { participants?: unknown };
    if (Array.isArray(fm.participants)) participants = fm.participants.map((p) => String(p)).join(' ');
  } catch {
    /* title alone still drives matching */
  }
  return `${title} ${participants}`;
}

function resolve_owner_id(users?: UserRegistry): string | undefined {
  return users?.list().find((u) => u.tier === 'owner')?.id;
}

function escape_re(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Build name → person matchers for the contact graph. Full name + preferred name
 *  always; a first name ONLY when it's unique among the candidates (so a real
 *  calendar — which says "Beer with Heather", not the full name — matches, without
 *  guessing between two people who share a first name). Mirrors person_enrichment's
 *  build_matchers. Genealogy + self are excluded by the caller. */
function build_person_matchers(people: PersonRow[]): Array<{ row: PersonRow; re: RegExp }> {
  const first_counts = new Map<string, number>();
  for (const p of people) {
    const first = p.name.trim().split(/\s+/)[0]?.toLowerCase();
    if (first) first_counts.set(first, (first_counts.get(first) ?? 0) + 1);
  }
  const out: Array<{ row: PersonRow; re: RegExp }> = [];
  for (const p of people) {
    const names = new Set<string>();
    if (p.name.trim()) names.add(p.name.trim());
    if (p.preferred_name && p.preferred_name.trim()) names.add(p.preferred_name.trim());
    const first = p.name.trim().split(/\s+/)[0];
    if (first && (first_counts.get(first.toLowerCase()) ?? 0) === 1) names.add(first);
    for (const n of names) out.push({ row: p, re: new RegExp(`\\b${escape_re(n)}\\b`, 'i') });
  }
  return out;
}

/** Birthday/anniversary events are a DATE concern (the gift + cross-signal scans
 *  own them), not a meeting — don't prep on them even when they name the person. */
function is_meeting_event(category: string | null): boolean {
  const c = (category ?? '').toLowerCase();
  return c !== 'birthday' && c !== 'anniversary';
}

function strip_fence(s: string): string {
  return s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();
}

const MEETING_GATE_SYSTEM =
  'You decide, for each upcoming calendar event, whether it is a social MEETING or ' +
  'VISIT *with* the named person — the user will actually SEE or spend time with them ' +
  '(e.g. "Coffee with Kim", "Dinner with Sam", "Kim coming to visit", "lunch w/ ' +
  'Casey"). It is NOT a meeting-with-them when the event merely MENTIONS their name ' +
  'for another reason: a payday/bill/reminder ("Sam Payday"), an appointment ABOUT ' +
  'them but not with them, a task, a date marker. Return ONLY this JSON: ' +
  '{"results":[{"ref":<number>,"is_meeting":<bool>}]}. Reference each by its [number]. ' +
  'JSON only.';

/** The model decides which name-matched events are real meetings WITH the person
 *  (high-recall first-name matching alone catches "Sam Payday"). Returns the set
 *  of 1-based refs that ARE meetings. Fail-CLOSED: any LLM/parse error → empty set
 *  (a proactive surface skips rather than prepping noise). The judgment is the
 *  model's (the dynamic-not-hardcoded law); the assembly downstream stays pure. */
async function gate_meetings(
  llm: LLMRouter | undefined,
  items: Array<{ ref: number; title: string; person: string }>,
): Promise<Set<number>> {
  if (!llm || items.length === 0) return new Set();
  let role;
  try {
    role = llm.for_role(tier());
  } catch {
    return new Set();
  }
  const lines = items.map((it) => `[${it.ref}] event "${it.title}" — with ${it.person}?`).join('\n');
  try {
    const resp = await role.provider.complete({
      messages: [
        { role: 'system', content: MEETING_GATE_SYSTEM },
        { role: 'user', content: `${lines}\n\nReply with ONLY the JSON.` },
      ],
      temperature: 0.1,
      max_tokens: 500,
      think: false,
    });
    const parsed = JSON.parse(strip_fence(resp.content || '')) as { results?: unknown };
    if (!parsed || !Array.isArray(parsed.results)) return new Set();
    const ok = new Set<number>();
    for (const r of parsed.results) {
      if (!r || typeof r !== 'object') continue;
      const rec = r as Record<string, unknown>;
      const ref = Number.parseInt(String(rec.ref ?? ''), 10);
      if (Number.isFinite(ref) && rec.is_meeting === true) ok.add(ref);
    }
    return ok;
  } catch {
    return new Set(); // fail-CLOSED
  }
}

export interface ScanMeetingPrepDeps {
  db: Database;
  memory: MemoryClient;
  proposals: ProposalsStore;
  users?: UserRegistry;
  llm?: LLMRouter;
  now?: () => Date;
}

interface MeetingCandidate {
  ev: ReturnType<MemoryClient['upcoming_life_events_uncordoned']>[number];
  row: PersonRow;
  signature: CategorySignature;
}

export async function run_scan_meeting_prep(deps: ScanMeetingPrepDeps, within_days: number): Promise<Output> {
  if (!meeting_prep_enabled()) return { enabled: false, meetings: 0, filed: 0, proposal_ids: [] };
  const now = (deps.now ?? (() => new Date()))();
  const owner_id = resolve_owner_id(deps.users);

  // Candidates = the real contact graph, with first-name-when-unique matchers so
  // a real calendar ("Beer with Heather") matches. The exclusion set (self,
  // genealogy, public figures) comes from the SHARED predicate — this used to
  // re-derive `relationship !== 'self' && !is_genealogy(...)` inline, which is
  // how it silently missed public figures when that class was added.
  const contacts = deps.memory.query_people({}).filter((row) => !is_non_contact(row));
  const matchers = build_person_matchers(contacts);
  const events = deps.memory.upcoming_life_events_uncordoned(within_days, now);

  // 1) Collect name-matched candidates (high recall, deterministic), un-offered only.
  const candidates: MeetingCandidate[] = [];
  for (const ev of events) {
    if (!ev.event_date || !is_meeting_event(ev.category)) continue;
    const haystack = event_haystack(ev.title, ev.frontmatter_json);
    for (const { row, re } of matchers) {
      if (!re.test(haystack)) continue;
      const signature: CategorySignature = {
        specialist_id: 'kate',
        kind: 'briefing',
        category: 'meeting_prep',
        anchor: `${row.id}:${content_anchor(ev.title, ev.event_date)}`,
      };
      if (deps.proposals.exists_for_signature(signature)) continue;
      candidates.push({ ev, row, signature });
    }
  }
  const meetings = candidates.length;

  // 2) The model decides which are real meetings WITH the person ("Sam Payday" is
  //    a name match but not a meeting). Fail-CLOSED — no LLM → no preps.
  const confirmed = await gate_meetings(
    deps.llm,
    candidates.map((c, i) => ({ ref: i + 1, title: c.ev.title, person: c.row.name })),
  );

  // 3) Assemble (pure) + file a briefing for each confirmed meeting.
  const proposal_ids: string[] = [];
  for (let i = 0; i < candidates.length; i++) {
    if (!confirmed.has(i + 1)) continue;
    if (proposal_ids.length >= max_preps()) break;
    const { ev, row, signature } = candidates[i]!;

    const viewer_id = ev.owner ?? cordon_user(ev.private_to) ?? owner_id;
    const caller: Caller = { user_id: viewer_id, tier: (deps.users?.get(viewer_id ?? '')?.tier ?? 'owner') as Caller['tier'] };

    const note = deps.memory.read_note(row.note_path);
    const prep = assemble_meeting_prep({
      db: deps.db,
      person_id: row.id,
      person_name: row.name,
      fm: note?.frontmatter ?? {},
      caller,
      now,
      event: { title: ev.title, when_iso: ev.event_date! },
    });
    if (!prep.has_content) continue; // nothing to say → no card

    const for_event = content_anchor(ev.title, ev.event_date!);
    try {
      const pid = deps.proposals.create({
        specialist_id: 'kate',
        kind: 'briefing',
        user_id: cordon_user(ev.private_to),
        execution_kind: 'none',
        payload: {
          // briefing dedup keys on topic+for_event (proposal-inflow supersession).
          topic: `prep:${row.name}`,
          for_event,
          title: `Prep — seeing ${row.name}`,
          person_id: row.id,
          person_name: row.name,
          note_path: row.note_path,
          event_id: ev.id,
          event_name: ev.title,
          event_when: ev.event_date,
          open_loops: prep.open_loops,
          ask_about: prep.ask_about,
          overdue_days: prep.overdue_days,
        },
        rationale: prep.markdown,
        signature,
      });
      proposal_ids.push(pid);
    } catch {
      /* fail-open — one bad meeting never aborts the scan */
    }
  }

  deps.memory.log_action({
    intent_id: `mp_${now.getTime()}`,
    agent: 'kate',
    tool_name: 'meeting_prep_scan',
    tool_input: { within_days },
    execution_result: { meetings, filed: proposal_ids.length },
  });

  return { enabled: true, meetings, filed: proposal_ids.length, proposal_ids };
}

export function create(deps: ToolDeps): Tool<Input, Output> {
  return {
    name: 'scan_meeting_prep',
    description:
      "Scan upcoming calendar meetings for ones naming a person in your contact graph and, on the edge (once per meeting), file a \"before you see them\" briefing — what's open with them, what's worth bringing up, whether you're overdue. Background job; not a chat tool.",
    risk: 'write_internal',
    required_capabilities: ['monitor_meeting_prep'],
    input_schema: InputSchema,
    output_schema: OutputSchema,
    volatile: true,

    idempotency_key() {
      return `scan_meeting_prep:${Math.floor(Date.now() / 60_000)}`;
    },

    async execute(input: Input, ctx: ToolContext): Promise<Output> {
      return run_scan_meeting_prep(
        { db: deps.db, memory: ctx.memory, proposals: deps.proposals, users: deps.users, llm: deps.llm, now: () => ctx.now },
        input.within_days,
      );
    },
  };
}
