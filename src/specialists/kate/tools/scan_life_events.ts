/**
 * scan_life_events — Kate's proactive life-event offers (People-engine Phase C,
 * 2026-06-25).
 *
 * The afferent observers + the synthesis pass already TAG life events into the
 * `person_observations` stream (kind 'life_event': a friend's trip, a new job, an
 * engagement, a move, a loss). This scan is the GATE that turns a NEW, actionable
 * one into a proactive OFFER — the relationship-signal sibling of
 * scan_calendar_followups (which fires on PROJECTED calendar life_event NOTES:
 * vacations/appointments). Different source, no overlap.
 *
 * Mirrors the proven proactive-offer idiom (scan_cross_signals / scan_calendar_followups):
 * detect an edge → file a cordon-scoped `action_proposal` once (exists_for_signature)
 * → the owner's tap is the floor, deciding accrues Trust-Ladder XP. Two gates:
 *
 *   1. RECENCY (deterministic) — only life events observed within `within_days` are
 *      eligible, so an old milestone never back-fills a stale offer on first run.
 *   2. ACTIONABILITY (the model's judgment, the dynamic-not-hardcoded law) — one
 *      planner call decides, per event, whether it WARRANTS a proactive offer (a
 *      real current milestone: travel / new job / engagement / new baby / move /
 *      loss / a notable health event) vs not (a passing mention, a transient
 *      illness, an old standing condition), and writes Kate's short offer.
 *
 * Fail-CLOSED on the gate (unlike the substance filter's fail-open): a proactive
 * offer is user-facing, so an LLM outage / garbled output files NOTHING rather than
 * offering on noise. Edge-dedup is on the observation's stable source_ref, so a
 * re-observed event never re-offers. DARK behind HEARTH_LIFE_EVENT_OFFERS; NOT on
 * Kate's LLM surfaces — the background_jobs runner invokes it by name (manual
 * catch-up: POST /api/specialists/kate/fire_background_job?name=life_event_offers).
 */
import { z } from 'zod';
import type { Database } from 'bun:sqlite';
import type { Tool, ToolContext } from '@core/tool';
import type { ToolDeps } from '@core/tool_deps';
import type { MemoryClient } from '@memory/client';
import type { ProposalsStore, CategorySignature } from '@core/proposals';
import type { LLMRouter } from '@core/llm';
import { PersonObservations, type PersonObservation } from '@memory/stores/person_observations';
import { is_non_contact } from '@core/relationship_signals';

export function life_event_offers_enabled(): boolean {
  return process.env.HEARTH_LIFE_EVENT_OFFERS === '1';
}
function tier(): string {
  return process.env.HEARTH_LIFE_EVENT_OFFERS_TIER || 'planner';
}
function max_offers(): number {
  const n = Number.parseInt(process.env.HEARTH_LIFE_EVENT_OFFERS_MAX ?? '', 10);
  return Number.isFinite(n) && n >= 0 ? n : 6;
}

const InputSchema = z.object({
  /** Only life events observed within this many days are eligible (recency gate). */
  within_days: z.number().int().positive().max(90).default(21),
});
const OutputSchema = z.object({
  enabled: z.boolean(),
  candidates: z.number(),
  filed: z.number(),
  proposal_ids: z.array(z.string()),
});
type Input = z.infer<typeof InputSchema>;
type Output = z.infer<typeof OutputSchema>;

const LIFE_EVENT_KINDS = ['travel', 'new_job', 'engagement', 'new_baby', 'move', 'loss', 'health', 'other'] as const;
type LifeEventKind = (typeof LIFE_EVENT_KINDS)[number];

/** household/owner → owner-global proposal (null); a member's signal → that member. */
function cordon_user(private_to: string | null): string | null {
  if (!private_to || private_to === 'household' || private_to === 'owner') return null;
  return private_to;
}

function strip_fence(s: string): string {
  return s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();
}

/** The stored summary is "Life event — <body>"; the body alone reads as the nudge. */
export function strip_life_event_prefix(summary: string): string {
  return (summary ?? '').replace(/^life event\s*[—:–-]\s*/i, '').trim();
}

const TRIAGE_SYSTEM =
  'You are triaging life events someone NOTICED about people in their life, for a warm, ' +
  'proactive chief-of-staff (Kate) deciding whether to OFFER to help. For each life event, ' +
  'decide if it WARRANTS a proactive offer — a real, CURRENT milestone the user would want to ' +
  'acknowledge or act on: travel/a trip, a new job, an engagement or wedding, a new baby, a ' +
  'move, a loss/bereavement, or a notable health event worth a check-in. Do NOT offer on a ' +
  'passing or trivial mention, a transient illness that is already passing, an old long-standing ' +
  'condition, or routine logistics. For each that warrants one, classify its kind and write ' +
  "Kate's SHORT offer — what she could do, phrased as a verb phrase (e.g. \"wish them a great " +
  'trip and check their flights", "congratulate them and suggest a gift", "send a thoughtful ' +
  'check-in", "update their address on file"). Return ONLY this JSON: ' +
  '{"events":[{"ref":<number>,"warrants_offer":<bool>,"kind":"<one of: ' +
  'travel|new_job|engagement|new_baby|move|loss|health|other>","offer":"<short verb phrase>"}]}. ' +
  'Reference each event by its [number]. Ground ONLY in the text given; never invent. JSON only.';

interface Triage {
  ref: number;
  warrants_offer: boolean;
  kind: LifeEventKind;
  offer: string;
}

/** One planner call → per-event actionability + kind + offer. Returns null on any
 *  failure (fail-CLOSED: a proactive surface skips rather than offering on noise). */
async function triage_life_events(
  llm: LLMRouter | undefined,
  items: Array<{ ref: number; person_name: string; body: string }>,
): Promise<Triage[] | null> {
  if (!llm || items.length === 0) return null;
  let role;
  try {
    role = llm.for_role(tier());
  } catch {
    return null;
  }
  const lines = items.map((it) => `[${it.ref}] (${it.person_name}) ${it.body}`).join('\n');
  try {
    const resp = await role.provider.complete({
      messages: [
        { role: 'system', content: TRIAGE_SYSTEM },
        { role: 'user', content: `Life events:\n${lines}\n\nReply with ONLY the JSON.` },
      ],
      temperature: 0.2,
      max_tokens: 600,
      // The deep tier is hybrid-thinking; planner is think-off already, but pass it
      // explicitly so a tier override to the 35B doesn't return empty content.
      think: false,
    });
    const parsed = JSON.parse(strip_fence(resp.content || '')) as { events?: unknown };
    if (!parsed || !Array.isArray(parsed.events)) return null;
    const out: Triage[] = [];
    for (const e of parsed.events) {
      if (!e || typeof e !== 'object') continue;
      const rec = e as Record<string, unknown>;
      const ref = Number.parseInt(String(rec.ref ?? ''), 10);
      const offer = String(rec.offer ?? '').trim();
      if (!Number.isFinite(ref) || !offer) continue;
      const kind = (LIFE_EVENT_KINDS as readonly string[]).includes(String(rec.kind)) ? (rec.kind as LifeEventKind) : 'other';
      out.push({ ref, warrants_offer: rec.warrants_offer === true, kind, offer });
    }
    return out;
  } catch {
    return null; // fail-CLOSED — no triage → no offers
  }
}

export interface ScanLifeEventsDeps {
  db: Database;
  memory: MemoryClient;
  proposals: ProposalsStore;
  llm?: LLMRouter;
  now?: () => Date;
}

export async function run_scan_life_events(deps: ScanLifeEventsDeps, within_days: number): Promise<Output> {
  if (!life_event_offers_enabled()) return { enabled: false, candidates: 0, filed: 0, proposal_ids: [] };
  const now = (deps.now ?? (() => new Date()))();
  const observations = new PersonObservations(deps.db);
  const cutoff = new Date(now.getTime() - within_days * 86_400_000).toISOString();

  const people = deps.memory.query_people({});
  const person_by_id = new Map(people.map((p) => [p.id, p]));

  // Recency gate + edge-dedup: collect only un-offered recent life events.
  const sig_of = (obs: PersonObservation): CategorySignature => ({
    specialist_id: 'kate',
    kind: 'action_proposal',
    category: 'life_event_offer',
    anchor: `${obs.person_id}:${obs.source_ref ?? obs.id}`,
  });
  const pending: Array<{ obs: PersonObservation; person_name: string; body: string }> = [];
  for (const obs of observations.recent_life_events(cutoff)) {
    if (deps.proposals.exists_for_signature(sig_of(obs))) continue; // already offered
    const person = person_by_id.get(obs.person_id);
    if (!person) continue; // a deleted person — leave it for decay
    // No proactive offer about a non-contact (2026-07-29). The observers no
    // longer record for public figures, but rows written before that landed
    // are still in the window — an offer to act on a councilmember's "life
    // event" is exactly the category error this class exists to stop.
    if (is_non_contact(person)) continue;
    pending.push({ obs, person_name: person.name, body: strip_life_event_prefix(obs.summary) });
  }
  if (pending.length === 0) return { enabled: true, candidates: 0, filed: 0, proposal_ids: [] };

  // Actionability gate (the model decides; fail-closed).
  const triage = await triage_life_events(
    deps.llm,
    pending.map((p, i) => ({ ref: i + 1, person_name: p.person_name, body: p.body })),
  );
  const by_ref = new Map<number, Triage>((triage ?? []).map((t) => [t.ref, t]));

  const proposal_ids: string[] = [];
  for (let i = 0; i < pending.length; i++) {
    if (proposal_ids.length >= max_offers()) break;
    const t = by_ref.get(i + 1);
    if (!t || !t.warrants_offer) continue;
    const { obs, person_name, body } = pending[i]!;
    const person = person_by_id.get(obs.person_id)!;
    try {
      const pid = deps.proposals.create({
        specialist_id: 'kate',
        kind: 'action_proposal',
        user_id: cordon_user(obs.private_to),
        execution_kind: 'none',
        payload: {
          followup_kind: 'life_event',
          person_id: obs.person_id,
          person_name,
          note_path: person.note_path,
          observation_id: obs.id,
          life_event_kind: t.kind,
          summary: body,
          offer: t.offer,
          verb: 'review',
        },
        // Strip a trailing sentence-mark from the body so we don't get "…Korea.. Want me to…".
        rationale: `**${person_name}** — ${body.replace(/[.!?]+\s*$/, '')}. Want me to ${t.offer}?`,
        signature: sig_of(obs),
      });
      proposal_ids.push(pid);
    } catch {
      /* fail-open per event — one bad offer never aborts the scan */
    }
  }

  deps.memory.log_action({
    intent_id: `le_${now.getTime()}`,
    agent: 'kate',
    tool_name: 'life_event_offers_scan',
    tool_input: { within_days, candidates: pending.length },
    execution_result: { candidates: pending.length, filed: proposal_ids.length },
  });

  return { enabled: true, candidates: pending.length, filed: proposal_ids.length, proposal_ids };
}

export function create(deps: ToolDeps): Tool<Input, Output> {
  return {
    name: 'scan_life_events',
    description:
      "Scan the relationship life-event stream (a friend's trip / new job / engagement / move / loss) for a NEW, actionable milestone and, on the edge (once per event), file a proactive offer so Kate offers to help. Background job; not a chat tool.",
    risk: 'write_internal',
    required_capabilities: ['monitor_life_events'],
    input_schema: InputSchema,
    output_schema: OutputSchema,
    volatile: true,

    idempotency_key() {
      return `scan_life_events:${Math.floor(Date.now() / 60_000)}`;
    },

    async execute(input: Input, ctx: ToolContext): Promise<Output> {
      return run_scan_life_events(
        { db: deps.db, memory: ctx.memory, proposals: deps.proposals, llm: deps.llm, now: () => ctx.now },
        input.within_days,
      );
    },
  };
}
