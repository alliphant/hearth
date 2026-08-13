/**
 * people_prep — "before you see them" assembly (People-engine Phase B, 2026-06-25).
 *
 * The synthesis pass DEEPENS the dossier; this SURFACES it at the right moment.
 * Given a person (and optionally an upcoming meeting with them), it assembles the
 * heads-up a chief of staff would hand you on the way in: what's OPEN with them,
 * what's worth BRINGING UP, and whether you're OVERDUE to connect.
 *
 * It is PURE ASSEMBLY of knowledge the system already produced — open loops from
 * the distill, the relationship narrative from the synthesis model, overdue from
 * the cadence — so there is no LLM here and nothing to fabricate (the dynamic-not-
 * hardcoded law is satisfied upstream, where the model decided what's a durable
 * theme / a real open loop; this just presents that knowledge). Cordon-correct:
 * it reads the owner-private observations + synthesis through `note_visible_to_caller`,
 * so a prep only ever contains what its viewer is allowed to see.
 *
 * Two surfaces share this one function: the proactive `scan_meeting_prep` job
 * (a calendar meeting with a known person → a briefing on the edge) and any
 * on-demand caller. Returns `has_content: false` when there's nothing to say, so
 * a caller can skip rather than surface an empty card.
 */
import type { Database } from 'bun:sqlite';
import type { Caller } from '@memory/private_to';
import { PersonObservations } from '@memory/stores/person_observations';
import { PersonSynthesisStore } from '@memory/stores/person_synthesis';
import { CADENCE_DAYS, days_since } from '@core/relationship_signals';
import { local_iso_date, format_short_datetime } from '@core/time';

export interface MeetingPrepInput {
  db: Database;
  person_id: string;
  person_name: string;
  /** The person's note frontmatter — for the cadence/overdue read. */
  fm: Record<string, unknown>;
  /** The viewer principal — gates the owner-private observations + synthesis. */
  caller: Caller;
  now: Date;
  /** Present for the proactive (meeting) surface; absent for an on-demand catch-up. */
  event?: { title: string; when_iso?: string | null };
  tz?: string;
}

export interface MeetingPrep {
  has_content: boolean;
  markdown: string;
  open_loops: string[];
  ask_about: string[];
  /** How they communicate (the synthesis `communication` portrait) — '' when the
   *  dossier hasn't learned their voice yet. Genuinely prep-shaped: knowing how
   *  someone opens and what lands with them is half of walking in prepared. */
  communication: string;
  overdue_days: number | null;
}

/** Drop the rendered observation prefixes so a loop/theme reads as a clean line. */
function strip_obs_prefix(s: string): string {
  return (s ?? '')
    .replace(/^(open loop\s*—\s*|life event\s*—\s*|talk about:\s*)/i, '')
    .trim();
}

function dedup_strings(items: string[], cap: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of items) {
    const v = (raw ?? '').trim();
    const key = v.toLowerCase();
    if (!v || seen.has(key)) continue;
    seen.add(key);
    out.push(v);
    if (out.length >= cap) break;
  }
  return out;
}

export function assemble_meeting_prep(input: MeetingPrepInput): MeetingPrep {
  const { db, person_id, person_name, fm, caller, now, tz } = input;

  // Recent, cordon-visible observations → open loops + life-event freshness.
  const observations = new PersonObservations(db).list_for_person(person_id, caller, { limit: 30 });
  const open_loops = dedup_strings(
    observations.filter((o) => o.kind === 'open_loop').map((o) => strip_obs_prefix(o.summary)),
    5,
  );
  const life_events = observations.filter((o) => o.kind === 'life_event').map((o) => strip_obs_prefix(o.summary));

  // The synthesis narrative — the curated "what to talk about" (themes lead; raw
  // un-decayed life events add freshness the themes may have abstracted away).
  const synthesis = new PersonSynthesisStore(db).get_for_person(person_id, caller);
  const themes = synthesis?.themes ?? [];
  const ask_about = dedup_strings([...themes, ...life_events], 5);
  const communication = (synthesis?.communication ?? '').trim();

  // Overdue to connect (cadence vs last_contacted).
  const cadence = typeof fm.contact_cadence === 'string' ? fm.contact_cadence : null;
  const last = typeof fm.last_contacted === 'string' ? fm.last_contacted : null;
  const since = days_since(last, local_iso_date(now, tz));
  const overdue_days =
    cadence && cadence in CADENCE_DAYS && since !== null && since > CADENCE_DAYS[cadence]! ? since : null;

  // The communication portrait is COLOUR, not a reason to surface a prep on its
  // own — a card that says only "here's how they text" is noise on the edge.
  const has_content = open_loops.length > 0 || ask_about.length > 0 || overdue_days !== null;

  const when = input.event?.when_iso ? format_short_datetime(input.event.when_iso, tz) : null;
  const header = input.event
    ? `**Seeing ${person_name}** — ${input.event.title}${when ? ` (${when})` : ''}`
    : `**${person_name}** — where things stand`;
  const overdue_line =
    overdue_days !== null ? `\n_Last connected ~${overdue_days}d ago — overdue for your ${cadence} cadence._` : '';
  const loops_block = open_loops.length
    ? `\n\n**Open with you:**\n${open_loops.map((l) => `- ${l}`).join('\n')}`
    : '';
  const ask_block = ask_about.length
    ? `\n\n**Worth bringing up:**\n${ask_about.map((a) => `- ${a}`).join('\n')}`
    : '';
  const comms_block = has_content && communication ? `\n\n**How they talk:** ${communication}` : '';

  return {
    has_content,
    markdown: `${header}${overdue_line}${loops_block}${ask_block}${comms_block}`,
    open_loops,
    ask_about,
    communication,
    overdue_days,
  };
}
