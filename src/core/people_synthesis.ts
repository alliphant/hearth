/**
 * people_synthesis — the synthesis/promotion pass that turns the flat, decaying
 * observation STREAM into a deepening, durable per-contact DOSSIER (2026-06-24).
 *
 * The afferent observers (iMessage especially, plus chat mentions) reliably
 * SENSE — they distill conversations into `person_observations` (open_loop /
 * life_event / topic / mention). But nothing flowed FROM that stream INTO the
 * durable dossier, and the stream never decayed: it piled up as noise while the
 * People-note stayed thin. "What Hearth noticed" was really decaying working
 * memory read as if it were the dossier.
 *
 * This nightly per-person sweep closes that gap with three moves, the first of
 * which is the LLM's judgment and the rest deterministic bookkeeping over its
 * decisions (the dynamic-not-hardcoded law — the model decides what's durable;
 * the code only applies the decision):
 *
 *   1. PROMOTE durable/recurring stream signal UP into the dossier:
 *        - communal FACTS (interests/dietary/pets/dates/relations) → the People
 *          note via the SHARED grounded merge_facts engine (union-dedup, idempotent,
 *          household-visible — exactly as if typed into the card);
 *        - the relationship NARRATIVE (a portrait + recurring themes: concerns,
 *          texture, their network of people, life trajectory) → the CORDONED
 *          PersonSynthesis store (owner-only, since it distills owner-private
 *          observations — the household note would leak it).
 *   2. DECAY the ephemeral: dismiss the observations the model judges resolved /
 *      trivial, PLUS a deterministic per-kind TTL age-out backstop, so the
 *      "noticed" surface stays a recent glance — and convert genuinely actionable
 *      open loops into Kate followup action_proposals (the calendar-followup idiom).
 *   3. GATE on durability + importance — a SECOND gate beyond the extraction-time
 *      substance filter: "would this still matter about them in 6-12 months / does
 *      it tell me who they are or shape the relationship?" This is the synthesis
 *      prompt's job; promote_facts + themes only carry what passes, decay carries
 *      what doesn't. The recurrence hint is a deterministic SIGNAL into that
 *      judgment, not a substitute for it.
 *
 * DEPTH PASS (2026-07-26) — the dossier used to be structurally incapable of
 * getting deeper, for two reasons that only show up in the live data:
 *
 *   - It REBUILT instead of refining. The pass got the People-note facts and the
 *     active observations but never its own prior narrative, then overwrote the
 *     row — so a portrait could never exceed one night's window (Sam Reed's
 *     live dossier read `source_observation_count: 4` after weeks of real
 *     correspondence). It now anchors on the prior summary/themes/communication
 *     (`get_for_refine`) and REFINES: keep what still holds, revise what changed,
 *     deepen with new evidence, and never drop a durable line just because this
 *     window didn't happen to re-mention it. This is the discipline the design
 *     doc names ("refine, not rebuild") and the one Kate's own style loop has
 *     always followed via `read_prior_profile`.
 *   - DECAY OUTRAN ACCUMULATION. Retirement is aggressive (a live table: 137
 *     dismissed / 16 active) and the pass only ever saw active rows, so the
 *     evidence was gone before it could compound. It now also reads a bounded
 *     tail of already-decayed observations (`history_for_person`) as CONTEXT —
 *     unnumbered, so it can inform the portrait but can never be re-promoted as
 *     fresh signal, re-decayed, or turned into a followup. A retention prune
 *     keeps that corpus bounded.
 *
 * It also learns the thing the observation kinds never carried: WHO THEY ARE TO
 * TALK TO. `communication` is the relational sibling of the user's own style
 * profile — register, what they open with, what they ask about, cadence, humor,
 * what lands — synthesized from `style` observations the distill now extracts
 * from the transcript (the only place the raw voice is ever visible).
 *
 * Disciplines (mirroring imessage_distill / person_enrichment — every one a contract):
 *   - DARK by default (HEARTH_PEOPLE_SYNTHESIS=1) — the sweep no-ops when off.
 *   - DEEP tier (HEARTH_PEOPLE_SYNTHESIS_TIER, default research_extract = the 35B,
 *     think:false) — synthesis is nuanced judgment + narrative, not the cheap
 *     planner's job; but it's a nightly batch, so per-person + dirty-gated for cost.
 *   - CADENCE-GATED (HEARTH_PEOPLE_SYNTHESIS_MIN_INTERVAL_H, default 20h) — the
 *     distill clock and the synthesis clock are decoupled (set 168 for weekly).
 *   - DIRTY-GATED — a person is re-synthesized only when a NEW observation post-
 *     dates the last synthesis cursor, so an unchanged contact costs no LLM call.
 *   - GROUNDED + FAIL-OPEN — extraction returns ONLY what's stated; any LLM/parse
 *     error degrades to "synthesize nothing for this person," never a wrong fact.
 *   - CORDONED — observations carry the uploader's cordon; the narrative inherits
 *     it (PersonSynthesis.private_to = the owner); facts that graduate to the
 *     household note are the safe-to-share tier (the iMessage two-tier cordon).
 *   - IDEMPOTENT — facts union-dedup, the narrative overwrites, followups edge-
 *     dedup on the observation's source_ref, decay is set-once.
 */
import type { Database } from 'bun:sqlite';
import { ulid } from 'ulid';
import type { ToolContext } from '@core/tool';
import type { LLMRouter } from '@core/llm';
import type { MemoryClient } from '@memory/client';
import type { UserRegistry } from '@core/users';
import type { ProposalsStore, CategorySignature, NewProposal } from '@core/proposals';
import { parse_fm, is_non_contact } from '@core/relationship_signals';
import { upsert_person_note } from '@agents/scribe/tools/upsert_person_note';
import {
  merge_facts,
  sanitize_facts,
  type ExtractedFacts,
  type EnrichLLM,
} from '@core/person_enrichment';
import { PersonObservations, type PersonObservation } from '@memory/stores/person_observations';
import { PersonSynthesisStore, type PersonSynthesis } from '@memory/stores/person_synthesis';

// ── env knobs ────────────────────────────────────────────────────────────────

export function people_synthesis_enabled(): boolean {
  return process.env.HEARTH_PEOPLE_SYNTHESIS === '1';
}
function synthesis_tier(): string {
  return process.env.HEARTH_PEOPLE_SYNTHESIS_TIER || 'research_extract';
}
/** Followup action_proposals are the one user-facing side effect — on within the
 *  dark feature, but independently disableable for a themes/facts-only run. */
function followups_enabled(): boolean {
  return process.env.HEARTH_PEOPLE_SYNTHESIS_FOLLOWUPS !== '0';
}
function min_interval_ms(): number {
  const h = Number.parseFloat(process.env.HEARTH_PEOPLE_SYNTHESIS_MIN_INTERVAL_H ?? '');
  return Number.isFinite(h) && h >= 0 ? h * 60 * 60 * 1000 : 20 * 60 * 60 * 1000;
}
function max_followups_per_person(): number {
  const n = Number.parseInt(process.env.HEARTH_PEOPLE_SYNTHESIS_MAX_FOLLOWUPS ?? '', 10);
  return Number.isFinite(n) && n >= 0 ? n : 3;
}
/** Per-kind TTL (days) for the deterministic decay backstop. A kind absent here
 *  (or set 0) never auto-decays. `mention` is contentless chat noise → fast;
 *  `topic` medium; `open_loop` slow (it's a commitment); `life_event` slowest
 *  (a milestone — it should have promoted, but don't yank it early). Each tunable. */
function decay_ttls(): Record<string, number> {
  const knob = (name: string, d: number): number => {
    const n = Number.parseInt(process.env[name] ?? '', 10);
    return Number.isFinite(n) && n >= 0 ? n : d;
  };
  return {
    mention: knob('HEARTH_PEOPLE_DECAY_MENTION_DAYS', 7),
    topic: knob('HEARTH_PEOPLE_DECAY_TOPIC_DAYS', 30),
    open_loop: knob('HEARTH_PEOPLE_DECAY_OPEN_LOOP_DAYS', 60),
    life_event: knob('HEARTH_PEOPLE_DECAY_LIFE_EVENT_DAYS', 120),
    // How someone talks is the slowest-changing signal there is — it should
    // promote into `communication` and then age out unhurriedly.
    style: knob('HEARTH_PEOPLE_DECAY_STYLE_DAYS', 180),
    // Camera appearance, two clocks (owner directive 2026-07-28). The nightly
    // refresh re-bumps observed_at for every descriptor STILL distilled from
    // recent sightings, so these TTLs measure "days since it stopped recurring
    // on camera", not days since first seen. Body/traits (`appearance`: build,
    // height, hair) are durable identity — a long horizon that only retires a
    // trait the cameras genuinely stopped seeing (a haircut). Clothing
    // (`appearance_wear`) ages out ~2 days after it leaves the pattern; fresh
    // recurrence resurrects it (record() resurrect in person_appearance).
    appearance: knob('HEARTH_PEOPLE_DECAY_APPEARANCE_DAYS', 120),
    appearance_wear: knob('HEARTH_PEOPLE_DECAY_APPEARANCE_WEAR_DAYS', 2),
  };
}
/** How many already-decayed observations ride along as refinement CONTEXT. */
function history_in_prompt(): number {
  const n = Number.parseInt(process.env.HEARTH_PEOPLE_SYNTHESIS_HISTORY ?? '', 10);
  return Number.isFinite(n) && n >= 0 ? n : 60;
}
/** Retention floor under the history corpus (days); 0 keeps dismissed rows forever. */
function observation_retention_days(): number {
  const n = Number.parseInt(process.env.HEARTH_PEOPLE_OBS_RETENTION_DAYS ?? '', 10);
  return Number.isFinite(n) && n >= 0 ? n : 365;
}

const LAST_SYNTHESIS_KEY = 'last_synthesis_at';
const MAX_OBSERVATIONS_IN_PROMPT = 24;

function strip_fence(s: string): string {
  return s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();
}

// ── deterministic recurrence hint (a SIGNAL into the model's judgment) ─────────

const RECUR_STOPWORDS = new Set([
  'open', 'loop', 'talk', 'about', 'life', 'event', 'between', 'owe', 'owes', 'with',
  'their', 'them', 'they', 'that', 'this', 'your', 'youre', 'have', 'has', 'and', 'the',
  'for', 'from', 'into', 'over', 'when', 'what', 'will', 'wants', 'want', 'need', 'needs',
  'asks', 'asked', 'owner', 'contact', 'still', 'some', 'after', 'before', 'once', 'around',
]);

/** Token-cluster the summaries (the demand-ledger idiom — deterministic, no LLM)
 *  so the model SEES which concerns recur across conversations. Returns lines like
 *  `"dog" — seen in [2], [5], [7]"`, recurrence (count ≥ 2) only, strongest first. */
export function recurring_token_threads(observations: PersonObservation[]): string[] {
  const by_token = new Map<string, Set<number>>();
  observations.forEach((o, i) => {
    const seen = new Set<string>();
    for (const raw of (o.summary ?? '').toLowerCase().split(/[^a-z]+/)) {
      const t = raw.trim();
      if (t.length < 4 || RECUR_STOPWORDS.has(t) || seen.has(t)) continue;
      seen.add(t);
      const set = by_token.get(t) ?? new Set<number>();
      set.add(i + 1); // 1-based to match the [n] labels in the prompt
      by_token.set(t, set);
    }
  });
  return [...by_token.entries()]
    .filter(([, idxs]) => idxs.size >= 2)
    .sort((a, b) => b[1].size - a[1].size)
    .slice(0, 8)
    .map(([t, idxs]) => `"${t}" — seen in ${[...idxs].sort((x, y) => x - y).map((n) => `[${n}]`).join(', ')}`);
}

// ── the synthesis LLM call (the GATE lives here) ───────────────────────────────

export interface SynthesisResult {
  summary: string;
  themes: string[];
  communication: string;
  facts: ExtractedFacts;
  followups: Array<{ ref: number; action: string; due_hint?: string }>;
  decay: number[];
}

export function synthesis_system(person_name: string): string {
  return (
    `You curate a durable relationship DOSSIER about ${person_name} for a personal ` +
    `chief-of-staff who wants to genuinely keep up with them. You are given the ` +
    `dossier AS IT STANDS (a portrait built up over previous passes), what the ` +
    `household note already knows, older observations kept as background, and a ` +
    `numbered list of recent OBSERVATIONS the system noticed (each is working ` +
    `memory — open loops, life events, topics, notes on how they communicate). Your ` +
    `job is to REFINE the dossier: decide what is durable enough to PROMOTE into it, ` +
    `and what is ephemeral enough to let DECAY.\n\n` +
    `REFINE, DO NOT REBUILD — this is the most important instruction. The existing ` +
    `portrait is the anchor. Carry forward everything in it that still holds, even ` +
    `when this window's observations don't mention it; a durable line about ` +
    `${person_name} does not stop being true because they didn't text about it this ` +
    `week. Revise a line when new evidence genuinely changes it, retire one only ` +
    `when it is contradicted or clearly finished, and add what's newly earned. Each ` +
    `pass should read as the same portrait, deepened — never a fresh first ` +
    `impression. Return the FULL refreshed dossier (it replaces the prior one), not ` +
    `a diff.\n\n` +
    `THE GATE — promote something ONLY if it would still matter about ${person_name} ` +
    `in 6-12 months, OR it tells you who they are / shapes the relationship. A one-off ` +
    `errand, a logistics ping, a passing reaction, a same-day plan, a transient ` +
    `illness → do NOT promote it; let it decay. RECURRENCE is the strongest promote ` +
    `signal: a concern, topic, or person that shows up across several observations is ` +
    `durable — surface it as a theme.\n\n` +
    `Return ONLY a JSON object with these keys:\n` +
    `  summary:  a 1-3 sentence portrait of who ${person_name} is and the texture of ` +
    `the relationship, grounded in the observations + known facts. "" if too little.\n` +
    `  themes:   string[] — durable narrative lines: recurring concerns, relationship ` +
    `texture, ${person_name}'s network of people, their life trajectory. Each a short ` +
    `sentence naming ${person_name}; [] if nothing durable yet.\n` +
    `  communication: a 1-3 sentence portrait of HOW ${person_name} communicates and ` +
    `what talking with them is actually like — their register and warmth, what they ` +
    `open with, what they ask you about, how they handle a serious subject, their ` +
    `humor, how fast and how fully they reply, what lands with them and what doesn't. ` +
    `This describes THEM, never the owner. Refine the existing one rather than ` +
    `restating it; "" if there is not yet evidence of how they talk.\n` +
    `  facts:    { interests:[], dislikes:[], dietary:[], pets:[{name,species}], ` +
    `important_dates:[{date,what}], relations:[{name,relation}] } — durable STRUCTURED ` +
    `facts EXPLICITLY stated about ${person_name}. A date must be YYYY-MM-DD or MM-DD ` +
    `(omit if you don't have it). Omit a key or use [] when nothing applies.\n` +
    `  followups: [{ref, action, due_hint}] — ONLY open-loop observations that are ` +
    `genuinely worth a reminder days later (a real commitment or thing to do/ask), ` +
    `NEVER a trivial same-day errand. ref is the observation's [number]; action is a ` +
    `short imperative ("remind you to book daycare for Mango"); due_hint is any time ` +
    `reference, else omit. Keep this to AT MOST a few — most loops need no reminder.\n` +
    `  decay:    [number] — the [numbers] of observations that are resolved, trivial, ` +
    `or no longer worth surfacing; they'll be cleared from the noticed list.\n\n` +
    `Reference observations by their [number] ONLY — never invent ids, and never ` +
    `reference the unnumbered background section (those are already retired; they ` +
    `are there to inform the portrait, and cannot be decayed or turned into a ` +
    `followup). Include ONLY what is explicitly present; never infer, never guess, ` +
    `never carry over generic knowledge about a famous name. JSON only, no prose.`
  );
}

/** Compact view of what the dossier ALREADY holds, so the model writes a coherent
 *  narrative and doesn't re-promote known facts. */
function render_known_facts(fm: Record<string, unknown>): string {
  const lines: string[] = [];
  const arr = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
  const rel = typeof fm.relationship === 'string' ? fm.relationship : undefined;
  if (rel) lines.push(`relationship: ${rel}`);
  if (arr(fm.likes).length) lines.push(`likes: ${arr(fm.likes).join(', ')}`);
  if (arr(fm.dislikes).length) lines.push(`dislikes: ${arr(fm.dislikes).join(', ')}`);
  if (arr(fm.dietary).length) lines.push(`dietary: ${arr(fm.dietary).join(', ')}`);
  if (Array.isArray(fm.pets) && fm.pets.length) {
    lines.push(`pets: ${fm.pets.map((p) => (p && typeof p === 'object' ? String((p as Record<string, unknown>).name ?? '') : '')).filter(Boolean).join(', ')}`);
  }
  if (Array.isArray(fm.relations) && fm.relations.length) {
    lines.push(`relations: ${fm.relations.map((rrec) => {
      const o = (rrec && typeof rrec === 'object' ? rrec : {}) as Record<string, unknown>;
      const nm = String(o.name ?? o.to ?? '');
      const rl = String(o.relation ?? o.predicate ?? '');
      return nm ? (rl ? `${nm} (${rl})` : nm) : '';
    }).filter(Boolean).join(', ')}`);
  }
  if (typeof fm.how_we_met === 'string' && fm.how_we_met.trim()) lines.push(`how we met: ${fm.how_we_met.trim()}`);
  return lines.length ? lines.join('\n') : '(the dossier is currently thin — little known yet)';
}

function render_observations(observations: PersonObservation[]): string {
  return observations
    .map((o, i) => `[${i + 1}] (${o.kind}, ${(o.observed_at ?? '').slice(0, 10)}) ${o.summary}`)
    .join('\n');
}

/** Already-decayed observations as UNNUMBERED background. Deliberately not [n]-
 *  labelled: the decay/followup contracts index into the active list, so anything
 *  numbered here could be mistaken for a live row and re-promoted or re-decayed. */
function render_history(observations: PersonObservation[]): string {
  return observations
    .map((o) => `- (${o.kind}, ${(o.observed_at ?? '').slice(0, 10)}) ${o.summary}`)
    .join('\n');
}

/** The prior dossier, rendered as the refinement anchor. */
function render_prior(prior: PersonSynthesis | null): string {
  if (!prior) return '';
  const lines: string[] = [];
  if (prior.summary.trim()) lines.push(`Portrait: ${prior.summary.trim()}`);
  if (prior.themes.length) lines.push(`Themes:\n${prior.themes.map((t) => `- ${t}`).join('\n')}`);
  if (prior.communication.trim()) lines.push(`How they communicate: ${prior.communication.trim()}`);
  return lines.join('\n');
}

function norm_str_arr(v: unknown): string[] {
  return Array.isArray(v) ? v.map((x) => String(x ?? '').trim()).filter(Boolean) : [];
}

export async function synthesize_person(
  llm: EnrichLLM,
  person_name: string,
  known_facts: string,
  observations: PersonObservation[],
  recurrence_hint: string[],
  prior: PersonSynthesis | null = null,
  history: PersonObservation[] = [],
): Promise<SynthesisResult | null> {
  if (observations.length === 0) return null;
  let role;
  try {
    role = llm.for_role(synthesis_tier());
  } catch {
    return null;
  }
  const hint_block = recurrence_hint.length
    ? `\n\nRecurring threads (a deterministic hint — recurrence is a strong promote signal):\n${recurrence_hint.join('\n')}`
    : '';
  const prior_text = render_prior(prior);
  const prior_block = prior_text
    ? `The dossier as it stands (revision ${prior?.revision ?? 0}) — REFINE this, don't restart it:\n${prior_text}\n\n`
    : 'The dossier has no portrait yet — this is the first pass.\n\n';
  const history_block = history.length
    ? `\n\nBackground (older observations, already retired — context for the portrait ` +
      `ONLY; do not decay these, do not make followups from them, do not number them):\n${render_history(history)}`
    : '';
  try {
    const resp = await role.provider.complete({
      messages: [
        { role: 'system', content: synthesis_system(person_name) },
        {
          role: 'user',
          content:
            `Contact: ${person_name}\n\n${prior_block}The household note already knows:\n${known_facts}\n\n` +
            `Recent observations:\n${render_observations(observations)}${hint_block}${history_block}\n\nReply with ONLY the JSON.`,
        },
      ],
      temperature: 0.2,
      // Headroom for the FULL refreshed dossier (the refine contract returns the
      // whole thing, not a diff) plus the communication portrait.
      max_tokens: 1600,
      // The 35B deep tier is hybrid-thinking: without think:false it spends max_tokens
      // on reasoning_content and returns empty content → JSON.parse('') throws → fail-open.
      think: false,
    });
    const parsed = JSON.parse(strip_fence(resp.content || '')) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object') return null;

    const facts_raw = (parsed.facts && typeof parsed.facts === 'object' ? parsed.facts : {}) as Record<string, unknown>;
    const facts: ExtractedFacts = sanitize_facts({
      interests: norm_str_arr(facts_raw.interests),
      dislikes: norm_str_arr(facts_raw.dislikes),
      dietary: norm_str_arr(facts_raw.dietary),
      // Build optional fields ONLY when present — an `undefined` leaf propagates
      // into the merged frontmatter and js-yaml THROWS on dump ("unacceptable kind
      // of an object to dump [object Undefined]"), which silently lost a pet whose
      // species the model omitted (the live 2026-06-24 Sam/Bailey/Mango miss).
      pets: Array.isArray(facts_raw.pets)
        ? facts_raw.pets
            .filter((p): p is Record<string, unknown> => !!p && typeof p === 'object')
            .map((p) => {
              const pet: { name: string; species?: string; notes?: string } = { name: String(p.name ?? '').trim() };
              if (typeof p.species === 'string' && p.species.trim()) pet.species = p.species.trim();
              if (typeof p.notes === 'string' && p.notes.trim()) pet.notes = p.notes.trim();
              return pet;
            })
            .filter((p) => p.name)
        : [],
      important_dates: Array.isArray(facts_raw.important_dates)
        ? facts_raw.important_dates
            .filter((d): d is Record<string, unknown> => !!d && typeof d === 'object')
            .map((d) => {
              const e: { date: string; what: string; recurring?: boolean } = { date: String(d.date ?? '').trim(), what: String(d.what ?? '').trim() };
              if (d.recurring === true) e.recurring = true;
              return e;
            })
            .filter((d) => d.date && d.what)
        : [],
      relations: Array.isArray(facts_raw.relations)
        ? facts_raw.relations
            .filter((rrec): rrec is Record<string, unknown> => !!rrec && typeof rrec === 'object')
            .map((rrec) => ({ name: String(rrec.name ?? '').trim(), relation: String(rrec.relation ?? '').trim() }))
            .filter((rrec) => rrec.name)
        : [],
    });

    const followups: SynthesisResult['followups'] = [];
    if (Array.isArray(parsed.followups)) {
      for (const f of parsed.followups) {
        if (!f || typeof f !== 'object') continue;
        const rec = f as Record<string, unknown>;
        const ref = Number.parseInt(String(rec.ref ?? ''), 10);
        const action = String(rec.action ?? '').trim();
        if (!Number.isFinite(ref) || !action) continue;
        const due = typeof rec.due_hint === 'string' && rec.due_hint.trim() ? rec.due_hint.trim() : undefined;
        followups.push(due ? { ref, action, due_hint: due } : { ref, action });
      }
    }

    const decay = Array.isArray(parsed.decay)
      ? parsed.decay.map((n) => Number.parseInt(String(n), 10)).filter((n) => Number.isFinite(n))
      : [];

    return {
      summary: String(parsed.summary ?? '').trim().slice(0, 800),
      themes: norm_str_arr(parsed.themes).map((t) => t.slice(0, 280)).slice(0, 12),
      communication: String(parsed.communication ?? '').trim().slice(0, 800),
      facts,
      followups,
      decay,
    };
  } catch {
    return null; // fail-open: no synthesis beats a wrong one
  }
}

// ── the sweep ──────────────────────────────────────────────────────────────────

export interface PeopleSynthesisDeps {
  db: Database;
  memory: MemoryClient;
  llm: EnrichLLM;
  proposals?: Pick<ProposalsStore, 'create' | 'exists_for_signature'>;
  users?: UserRegistry;
  now?: () => Date;
}

export interface PeopleSynthesisResult {
  enabled: boolean;
  skipped: boolean;
  people: number;
  facts: number;
  themes: number;
  followups: number;
  decayed: number;
  /** Dismissed observations hard-deleted by the retention floor. */
  pruned: number;
}

const ZERO: Omit<PeopleSynthesisResult, 'enabled' | 'skipped'> = {
  people: 0,
  facts: 0,
  themes: 0,
  followups: 0,
  decayed: 0,
  pruned: 0,
};

/** household/owner → owner-global proposal (null); a member's signal → that member. */
function cordon_user(private_to: string | null): string | null {
  if (!private_to || private_to === 'household' || private_to === 'owner') return null;
  return private_to;
}

/** Refinement can only ADD depth, never erase it. A refine pass that comes back
 *  thin (a flaky deep-tier turn, a window of pure noise) must not blank a portrait
 *  the dossier spent revisions earning — an empty field falls back to the prior.
 *  A non-empty field always wins: that IS the refinement. */
export function merge_refinement(
  prior: PersonSynthesis | null,
  result: SynthesisResult,
): { summary: string; themes: string[]; communication: string } {
  return {
    summary: result.summary.trim() || prior?.summary || '',
    themes: result.themes.length ? result.themes : (prior?.themes ?? []),
    communication: result.communication.trim() || prior?.communication || '',
  };
}

/** The newest `observed_at` across a set of observations — the dirty-check cursor. */
function newest_observed(observations: PersonObservation[]): string {
  let max = '';
  for (const o of observations) if (typeof o.observed_at === 'string' && o.observed_at > max) max = o.observed_at;
  return max;
}

/** The nightly synthesis sweep. Returns counts; never throws (fail-open per person). */
export async function run_people_synthesis_sweep(deps: PeopleSynthesisDeps): Promise<PeopleSynthesisResult> {
  if (!people_synthesis_enabled()) return { enabled: false, skipped: false, ...ZERO };
  const now = (deps.now ?? (() => new Date()))();
  const observations = new PersonObservations(deps.db);
  const synthesis = new PersonSynthesisStore(deps.db);

  // Cadence gate — decouple the synthesis clock from the distill clock.
  const last = synthesis.get_meta(LAST_SYNTHESIS_KEY);
  if (last) {
    const elapsed = now.getTime() - new Date(last).getTime();
    if (Number.isFinite(elapsed) && elapsed >= 0 && elapsed < min_interval_ms()) {
      return { enabled: true, skipped: true, ...ZERO };
    }
  }

  // One-shot repair (2026-07-28): earlier sweeps let the LLM decay `appearance`
  // rows — deterministic engine-owned derived counts it had no business judging
  // — and record() never resurrects a dismissed row, so the camera appearance
  // profiles were permanently dark while the nightly refresh kept bumping the
  // corpses. Appearance rows are now excluded from model decay (below); this
  // resurrects the ones already killed. Runs once, keyed in synthesis meta.
  try {
    if (!synthesis.get_meta('appearance_resurrect_v1')) {
      const n =
        deps.db
          .prepare(`UPDATE person_observations SET dismissed = 0 WHERE dismissed = 1 AND kind LIKE 'appearance%'`)
          .run().changes ?? 0;
      synthesis.set_meta('appearance_resurrect_v1', now.toISOString());
      if (n > 0) console.log(`[people-synthesis] appearance_resurrect_v1: revived ${n} appearance row(s)`);
    }
  } catch (e) {
    console.error('[people-synthesis] appearance resurrect failed (fail-open):', e);
  }

  // Deterministic decay backstop runs first, over the whole table — cheap, cordon-
  // free (the system aging out its OWN working memory), independent of the LLM.
  // (`appearance`/`appearance_wear` TTLs measure days since the descriptor last
  // RECURRED — the nightly refresh re-bumps whatever is still distilled, and
  // record()'s resurrect revives a retired row that starts recurring again.)
  let decayed = 0;
  try {
    decayed += observations.decay_stale(now, decay_ttls());
  } catch (e) {
    console.error('[people-synthesis] decay_stale failed (fail-open):', e);
  }

  // Retention floor under the history corpus. Decay retires an observation from
  // the "noticed" surface; this is what eventually forgets it. Without it,
  // keeping decayed rows as refinement context would grow unbounded — and the
  // iMessage boundary is that Hearth holds a distillate, not an archive.
  let pruned = 0;
  try {
    pruned += observations.prune_dismissed(now, observation_retention_days());
  } catch (e) {
    console.error('[people-synthesis] prune_dismissed failed (fail-open):', e);
  }

  let people = 0;
  let facts = 0;
  let themes = 0;
  let followups = 0;

  const all_people = deps.memory.query_people({});
  const person_by_id = new Map(all_people.map((p) => [p.id, p]));

  for (const person_id of observations.person_ids_with_active()) {
    const person = person_by_id.get(person_id);
    if (!person) continue; // observation for a deleted person — leave decay to age it
    // A dossier is a RELATIONSHIP portrait — open loops, themes, how to talk to
    // them (2026-07-29). A public figure has no relationship to portray, and
    // synthesizing one would read as though Jasper knows them. Pre-fix
    // observations still exist for a few; decay ages them out.
    if (is_non_contact(person)) continue;

    // Partition this person's active observations by the OWNER principal, and
    // synthesize per (person, owner) so each owner gets their own cordoned narrative.
    const active = observations.all_active_for_person(person_id);
    const by_owner = new Map<string, PersonObservation[]>();
    for (const o of active) {
      const arr = by_owner.get(o.user_id) ?? [];
      arr.push(o);
      by_owner.set(o.user_id, arr);
    }

    for (const [owner_id, owner_obs] of by_owner) {
      try {
        // Dirty-gate: skip a (person, owner) whose newest observation hasn't moved
        // past the last synthesis cursor — an unchanged contact costs no LLM call.
        const newest = newest_observed(owner_obs);
        const cursor = synthesis.get_cursor(person_id, owner_id);
        if (cursor && newest && newest <= cursor) continue;

        const ordered = owner_obs.slice(0, MAX_OBSERVATIONS_IN_PROMPT); // already newest-first
        const fm = parse_fm(person.frontmatter_json);
        // The refine anchor + the decayed-observation corpus (see the header):
        // the dossier compounds instead of being re-derived from one night's window.
        const prior = synthesis.get_for_refine(person_id, owner_id);
        const history = observations
          .history_for_person(person_id, history_in_prompt() * 2)
          .filter((o) => o.user_id === owner_id) // stay inside this owner's cordon
          .slice(0, history_in_prompt());
        const result = await synthesize_person(
          deps.llm,
          person.name,
          render_known_facts(fm),
          ordered,
          recurring_token_threads(ordered),
          prior,
          history,
        );
        if (!result) continue;
        const refined = merge_refinement(prior, result);

        const caller_tier = deps.users?.get(owner_id)?.tier ?? 'owner';
        const ctx: ToolContext = {
          memory: deps.memory,
          llm: deps.llm as unknown as LLMRouter,
          now,
          intent_id: ulid(),
          user: { id: owner_id, tier: caller_tier },
        };

        // 1) PROMOTE durable facts → the People note (communal, union-dedup).
        try {
          const { patch, added } = merge_facts(parse_fm(person.frontmatter_json), result.facts);
          if (added.length) {
            await upsert_person_note.execute({ identifier: { id: person.id }, patch }, ctx);
            facts += added.length;
          }
        } catch (e) {
          console.error(`[people-synthesis] facts step failed for ${person_id}:`, e);
        }

        // 2) PROMOTE the refined narrative → the cordoned synthesis store (owner-only).
        synthesis.upsert({
          person_id: person.id,
          user_id: owner_id,
          summary: refined.summary,
          themes: refined.themes,
          communication: refined.communication,
          // The evidence base is what the pass actually reasoned over — the live
          // window PLUS the retired corpus behind it, which is the honest depth
          // number now that the dossier compounds.
          source_observation_count: ordered.length + history.length,
          last_observation_ts: newest || null,
          private_to: owner_id, // the narrative inherits the observations' cordon
        });
        themes += refined.themes.length;
        people += 1;

        // 3a) DECAY — dismiss the observations the model judged resolved/trivial.
        // `appearance`/`appearance_wear` rows are exempt (2026-07-28): they're
        // deterministic engine-derived counts the nightly camera refresh owns —
        // the model judging them "trivial" is how the appearance profiles went
        // dark. Their lifecycle is the per-kind TTL + recurrence-resurrect;
        // only the owner's explicit dismiss retires them early.
        if (result.decay.length) {
          const ids = result.decay
            .map((n) => ordered[n - 1]) // [n] is 1-based over `ordered`
            .filter((o): o is PersonObservation => o != null && !o.kind.startsWith('appearance'))
            .map((o) => o.id);
          try {
            decayed += observations.dismiss_many(ids);
          } catch (e) {
            console.error(`[people-synthesis] decay step failed for ${person_id}:`, e);
          }
        }

        // 3b) FOLLOWUPS — actionable open loops → a Kate followup action_proposal.
        if (deps.proposals && followups_enabled() && result.followups.length) {
          let filed = 0;
          for (const f of result.followups) {
            if (filed >= max_followups_per_person()) break;
            const obs = ordered[f.ref - 1];
            if (!obs || obs.kind !== 'open_loop' || !obs.source_ref) continue; // only real open loops
            const signature: CategorySignature = {
              specialist_id: 'kate',
              kind: 'action_proposal',
              category: 'open_loop_followup',
              anchor: `${person.id}:${obs.source_ref}`, // stable across re-distills → edge-dedup
            };
            try {
              if (deps.proposals.exists_for_signature(signature)) continue;
              const due = f.due_hint ? ` (${f.due_hint})` : '';
              const proposal: NewProposal = {
                specialist_id: 'kate',
                kind: 'action_proposal',
                user_id: cordon_user(obs.private_to),
                execution_kind: 'none',
                payload: {
                  followup_kind: 'open_loop',
                  person_id: person.id,
                  person_name: person.name,
                  note_path: person.note_path,
                  observation_id: obs.id,
                  action: f.action,
                  ...(f.due_hint ? { due_hint: f.due_hint } : {}),
                  verb: 'review',
                },
                rationale: `Open loop with **${person.name}**${due}: ${f.action}. Want me to handle this?`,
                signature,
              };
              deps.proposals.create(proposal);
              followups += 1;
              filed += 1;
            } catch {
              /* fail-open — one bad followup never aborts the person */
            }
          }
        }

        deps.memory.log_action({
          intent_id: ctx.intent_id,
          agent: 'kate',
          tool_name: 'people_synthesis',
          tool_input: { person_id, owner_id },
          execution_result: {
            facts: result.facts ? Object.keys(result.facts).length : 0,
            themes: refined.themes.length,
            followups: result.followups.length,
            decay: result.decay.length,
            // Depth observability: which revision this pass produced, how much
            // evidence it stood on, and whether the communication portrait exists.
            revision: (prior?.revision ?? 0) + 1,
            history: history.length,
            has_communication: refined.communication.length > 0,
          },
        });
      } catch (err) {
        console.error(`[people-synthesis] (${person_id}, ${owner_id}) failed (fail-open):`, err);
      }
    }
  }

  synthesis.set_meta(LAST_SYNTHESIS_KEY, now.toISOString());
  return { enabled: true, skipped: false, people, facts, themes, followups, decayed, pruned };
}
