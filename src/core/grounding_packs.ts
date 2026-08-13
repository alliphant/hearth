/**
 * Chat grounding packs (Grounding engine Phase 1b, 2026-06-05).
 *
 * Turn-start auto-RAG (Phase 1a) grounds a chat turn in the specialist's prose
 * LIBRARY (chunks_fts + vectors). But the roster's most fabrication-prone
 * specialists answer from STRUCTURED data that RAG-over-prose never touches:
 * Ruby from the civic ledger (civic_items / civic_votes / civic_members), Anna
 * from the your county assessor parcel cache, Kristi from the workstation SKU
 * registry. The 14-day audit showed re-roll guards firing on ~31-62% of their
 * turns even though they're the heaviest tool-users — the grounding pipeline
 * couldn't SEE their authoritative rows because nothing put them in front of
 * the model before it answered.
 *
 * A grounding pack is a cheap, read-only, FAIL-OPEN pre-turn fetch of the
 * specialist's authoritative structured records relevant to the user's message.
 * Its output is injected two ways (both via the runtime):
 *   1. into the system prompt (so the model SEES the rows before answering), and
 *   2. into `GroundingParts.verified` (so the provenance check + fact critic
 *      COUNT them as grounding — see src/core/provenance.ts) — the same slot the
 *      brief's domain packs use. This is the chat-side analogue of the
 *      deliberation-path `DomainPack`/`life_context` mechanism, but purpose-built
 *      for chat (fetch + render in one cheap call, conservative, topic-gated).
 *
 * Design rules every pack follows:
 *   - FAIL-OPEN: never throw (the dispatcher catches anyway); a pack error must
 *     degrade to "no grounding," never break a turn.
 *   - CONSERVATIVE: only inject rows that clearly relate to the message; never
 *     dump a whole table (it bloats the prompt and over-anchors the model).
 *   - CHEAP: one to a few indexed local SQLite reads (~ms); no network, no LLM.
 *   - SMALL: cap rows and truncate text so the prompt stays lean.
 *   - CITED: render source URLs / record ids so the model can attribute.
 */

import type { MemoryClient, CivicVoteRow } from '@memory/client';
import {
  getCountyAssessorStore,
  type ParcelRecord,
} from '@memory/stores/assessor_county';
import { getPropertyHistoryStore } from '@memory/stores/property_history';
import {
  getKristiWorkstationsStore,
  type Vendor,
  type FormFactor,
} from '@memory/stores/kristi_workstations';
import { ScrumStore, LANES } from '@memory/stores/scrum';
import {
  read_calendar_from_snapshot,
  get_warm_life_context,
  type VerifiedCalendarEvent,
  type VerifiedReading,
} from './domain_packs/life_context';
import { working_memory_blocks } from './working_memory';
import type { Tier, UserRegistry } from './users';
import { resolve_mentioned_people, visible_people } from './entity_hydration';
import { resolve_household_locations } from './household_awareness';
import { PersonSynthesisStore } from '@memory/stores/person_synthesis';
import { PersonObservations } from '@memory/stores/person_observations';
import { parse_fm } from './relationship_signals';
import type { Caller } from '@memory/private_to';
import { local_day_start } from './time';

/**
 * What counts as a calendar question — the SINGLE definition, shared by the
 * pack (which decides whether to pre-inject the verified schedule on voice) and
 * `_PREINJECTED_LOOKUPS` in specialist_runtime (which decides whether to force
 * a tool call when that block is absent).
 *
 * It lives here, exported, because the 2026-08 voice grounding void was caused
 * precisely by these two guards holding SEPARATE ideas of the same question and
 * each assuming the other was covering it. One regex, imported by both, makes
 * that class of drift impossible: whatever the pack calls a calendar turn is
 * exactly what the backstop calls one.
 */
export const CALENDAR_INTENT_RE =
  /\b(calendar|schedule|agenda|appointment|meeting|booked|free|busy|tomorrow|today|tonight|this (?:week|morning|afternoon|evening)|what'?s on|coming up|plans)\b/i;

/** Everything a pack needs to fetch its records for a turn. */
export interface GroundingPackContext {
  /** The user's message — the query the pack keys off. */
  message: string;
  /** Main-DB client (Ruby civic reads are user-scoped methods on it). */
  memory: MemoryClient;
  /** Resolved caller id (civic data is per-user). */
  user_id: string;
  /** Turn clock (for "upcoming" filters). */
  now: Date;
  /** Caller's IANA timezone, for localizing calendar times; defaults to the
   *  household zone when absent. Threaded from SpecialistTurnInput.user. */
  timezone?: string;
  /** Working-memory opt-in (`proactive.situational_context` on the specialist
   *  YAML): when true AND HEARTH_WORKING_MEMORY=1, the fused household block
   *  (working_memory.ts) is appended after any per-specialist pack. */
  situational?: boolean;
  /** Caller tier for the working-memory cordon (defaults to owner-tier-safe
   *  'friend' when absent — the most restrictive read). */
  tier?: Tier;
  /** Which surface the turn runs on. 'voice' keeps the pack LEAN: only the
   *  topic-gated household/person/security blocks fire (they only appear when
   *  the question is actually about those), never the always-on calendar/
   *  weather/EV blocks — those stay tool-fetched on voice per the 2026-06-07
   *  latency reversal. Absent → 'chat'. */
  surface?: 'chat' | 'voice';
  /** UserRegistry for the household-presence join (who's-home block). Optional
   *  + fail-open: absent → the occupancy read degrades to sighting-only. */
  users?: UserRegistry;
}

type Pack = (c: GroundingPackContext) => Promise<string[]>;

// ── Dispatcher + registry ───────────────────────────────────────────────

const PACKS: Record<string, Pack> = {
  // Kate — today's REAL calendar (the iOS snapshot), pre-injected so a voice/
  // chat turn READS the schedule instead of fabricating it. The deterministic
  // fix for the omission-fabrication class: the 27B live tier stochastically
  // skipped `sensor_calendar_upcoming` and invented events with zero tool calls
  // (audit-proven). Per the 2026-06 tool-grounding research, don't let the model
  // DECIDE whether to look — put the record in front of it. 2026-06-06.
  kate: kate_pack,
  ruby: ruby_pack,
  anna: anna_pack,
  kristi: kristi_pack,
  // Beatrice (file/tool id 'trainer') — her scrum board state + her architect
  // self-model. The scrum block stops her confabulating "all epics scored"; the
  // architect block stops the OTHER confabulation — on the Q4/think-off chat
  // tier she's claimed both "I already shipped that" and "I'm just the lens, I
  // can't write code / file a PR / merge" (both false). The block injects her
  // real authority + the chat-vs-deliberation channel split.
  trainer: trainer_pack,
};

/**
 * Run the specialist's grounding pack (if any) and return rendered `verified`
 * blocks. Fail-open: any error → []. No pack for this specialist → [].
 */
export async function gather_grounding_packs(
  specialist_id: string,
  c: GroundingPackContext,
): Promise<string[]> {
  const blocks: string[] = [];
  const pack = PACKS[specialist_id];
  if (pack) {
    try {
      blocks.push(...(await pack(c)).filter((b) => b && b.trim().length > 0));
    } catch (err) {
      console.error(`[grounding-pack] ${specialist_id} failed (fail-open):`, err);
    }
  }
  // Working memory — the fused household situational block (working_memory.ts).
  // YAML opt-in per specialist + HEARTH_WORKING_MEMORY gate; cordoned to the
  // caller; fail-open inside working_memory_blocks. Appended AFTER the
  // per-specialist pack so authoritative domain rows lead.
  if (c.situational === true) {
    try {
      const db = (c.memory as unknown as { cfg: { db: import('bun:sqlite').Database } }).cfg.db;
      blocks.push(
        ...working_memory_blocks(
          { memory: c.memory, db },
          {
            user_id: c.user_id,
            tier: c.tier ?? 'friend',
            now: c.now,
            timezone: c.timezone,
          },
        ),
      );
    } catch (err) {
      console.error('[grounding-pack] working-memory append failed (fail-open):', err);
    }
  }
  return blocks;
}

/** Render the verified blocks into a system-prompt section ('' when empty). */
export function render_verified_section(blocks: string[]): string {
  if (blocks.length === 0) return '';
  return (
    '\n\n## Authoritative records — your own structured data (ground answers in these)\n\n' +
    blocks.join('\n\n') +
    "\n\nThese rows were pulled from your own records for this question. Treat " +
    'them as ground truth and cite them. If they do not cover what was asked, ' +
    'say so plainly and offer to pull more — do not fill the gap from memory.'
  );
}

// ── Ruby — civic ledger ─────────────────────────────────────────────────

async function ruby_pack(c: GroundingPackContext): Promise<string[]> {
  const blocks: string[] = [];
  const kws = keywords(c.message);
  const now_ms = c.now.getTime();

  const items = c.memory.list_civic_items(c.user_id);

  // Upcoming council meetings from the ledger (almost always relevant for Ruby).
  const meetings = items
    .filter(
      (it) =>
        it.kind === 'council_meeting' &&
        it.event_at != null &&
        Date.parse(it.event_at) >= now_ms,
    )
    .sort((a, b) => Date.parse(a.event_at ?? '') - Date.parse(b.event_at ?? ''))
    .slice(0, 3);
  if (meetings.length > 0) {
    blocks.push(
      '### Upcoming council meetings (your civic ledger)\n' +
        meetings
          .map(
            (m) =>
              `- ${fmt_date(m.event_at)} — ${m.title}` +
              (m.summary ? ` — ${truncate(m.summary, 160)}` : '') +
              (m.url ? ` (${m.url})` : ''),
          )
          .join('\n'),
    );
  }

  if (kws.length > 0) {
    // Civic items (non-meeting, active) matching the question.
    const matched = items
      .filter(
        (it) =>
          it.kind !== 'council_meeting' &&
          it.status === 'active' &&
          contains_any(`${it.title} ${it.summary ?? ''}`, kws),
      )
      .slice(0, 5);
    if (matched.length > 0) {
      blocks.push(
        '### Matching civic items (your ledger)\n' +
          matched
            .map(
              (it) =>
                `- ${it.title}` +
                (it.event_at ? ` [${fmt_date(it.event_at)}]` : '') +
                (it.summary ? ` — ${truncate(it.summary, 160)}` : '') +
                (it.url ? ` (${it.url})` : ''),
            )
            .join('\n'),
      );
    }

    // Recorded votes on matching items (each carries its required source_url).
    const seen = new Set<string>();
    const votes: CivicVoteRow[] = [];
    for (const kw of kws.slice(0, 3)) {
      for (const v of c.memory.list_civic_votes(c.user_id, { item_contains: kw })) {
        if (seen.has(v.id)) continue;
        seen.add(v.id);
        votes.push(v);
      }
      if (votes.length >= 6) break;
    }
    if (votes.length > 0) {
      blocks.push(
        '### Recorded votes on matching items (your ledger — cite the source)\n' +
          votes
            .slice(0, 6)
            .map(
              (v) =>
                `- ${v.member_name} voted ${v.vote} on "${truncate(v.item_title, 80)}"` +
                (v.outcome ? ` (outcome: ${v.outcome})` : '') +
                (v.meeting_date ? ` [${v.meeting_date}]` : '') +
                ` — ${v.source_url}`,
            )
            .join('\n'),
      );
    }
  }

  return blocks;
}

// ── Anna — your county assessor parcel cache ────────────────────────────────

// A street address: a house number then words ending in a street-type token.
const ADDRESS_RE =
  /\b\d{1,6}\s+[A-Za-z0-9.\s]{2,40}?\b(?:st|street|ave|avenue|rd|road|dr|drive|ln|lane|ct|court|blvd|boulevard|way|cir|circle|pl|place|ter|terrace|trl|trail|loop|pkwy|parkway|hwy|highway)\b/i;
// A your county account / schedule number (R-prefixed or a long bare numeric).
const ACCOUNT_RE = /\bR\d{6,}\b/i;

async function anna_pack(c: GroundingPackContext): Promise<string[]> {
  const store = getCountyAssessorStore();
  // Empty cache → nothing to ground on (mirrors lookup_parcel's guard).
  const parcels = store.sync_status().find((s) => s.table === 'parcels')?.row_count ?? 0;
  if (parcels === 0) return [];

  let parcel: ParcelRecord | null = null;
  const acct = c.message.match(ACCOUNT_RE)?.[0];
  const addr = c.message.match(ADDRESS_RE)?.[0];
  if (acct) parcel = store.get_by_account(acct);
  if (!parcel && addr) parcel = store.find_by_address(addr)[0] ?? null;
  if (!parcel) {
    // No address named → ground on the household's home parcel (the one with
    // the most recorded history).
    const home = getPropertyHistoryStore().most_active_account();
    if (home) parcel = store.get_by_account(home);
  }
  if (!parcel) return [];
  return [render_parcel(parcel)];
}

function render_parcel(p: ParcelRecord): string {
  const lines = ['### Parcel record (your county County assessor — authoritative)'];
  lines.push(`- Address: ${p.situs_address}, ${p.situs_city} ${p.situs_zip}`);
  lines.push(
    `- Account ${p.account_no} / schedule ${p.schedule_num}` +
      (p.subdivision_name ? `, ${p.subdivision_name}` : '') +
      ` (${p.acct_type})`,
  );
  if (p.actual_value_total != null) {
    lines.push(
      `- Actual value: ${usd(p.actual_value_total)} total ` +
        `(land ${usd(p.actual_value_land)}, improvement ${usd(p.actual_value_improvement)})` +
        (p.tax_year ? `, tax year ${p.tax_year}` : ''),
    );
  }
  if (p.total_mill_levy != null) lines.push(`- Mill levy: ${p.total_mill_levy}`);
  const im = p.improvement;
  if (im) {
    lines.push(
      `- Improvement: ${im.sf ?? '?'} sf, built ${im.year_built ?? '?'}, ` +
        `${im.bedroom_count ?? '?'}bd/${im.bath_count ?? '?'}ba` +
        (im.quality ? `, quality ${im.quality}` : '') +
        (im.condition ? `, condition ${im.condition}` : ''),
    );
  }
  if (p.owner_name) {
    lines.push(
      `- Owner: ${p.owner_name}` +
        (p.owner_occupied === true
          ? ' (owner-occupied)'
          : p.owner_occupied === false
            ? ' (not owner-occupied)'
            : ''),
    );
  }
  const sale = p.recent_sales?.[0];
  if (sale) {
    lines.push(
      `- Most recent sale: ${usd(sale.sale_price)} on ${sale.sale_date}` +
        (sale.deed_description || sale.deed_code
          ? ` (${sale.deed_description || sale.deed_code})`
          : ''),
    );
  }
  return lines.join('\n');
}

// ── Kristi — workstation SKU registry ───────────────────────────────────

const VENDOR_HINTS: Array<[RegExp, Vendor]> = [
  [/\bhp\b|hewlett[- ]?packard/i, 'hp'],
  [/\bdell\b/i, 'dell'],
  [/\blenovo\b|thinkstation/i, 'lenovo'],
  [/\bnvidia\b|dgx|grace\b|blackwell/i, 'nvidia'],
];
const FORM_FACTOR_HINTS: Array<[RegExp, FormFactor]> = [
  [/\btower\b/i, 'tower'],
  [/\brack(?:mount)?\b/i, 'rack'],
  [/\bedge\b/i, 'edge'],
  [/\bmobile\b|laptop/i, 'mobile'],
  [/\bsff\b|small[- ]form/i, 'sff'],
];
const FAMILY_HINT_RE =
  /^(z\d|zbook|precision|thinkstation|threadripper|xeon|epyc|dgx|spark|fury|workstation)/;

async function kristi_pack(c: GroundingPackContext): Promise<string[]> {
  const vendor = VENDOR_HINTS.find(([re]) => re.test(c.message))?.[1];
  const form_factor = FORM_FACTOR_HINTS.find(([re]) => re.test(c.message))?.[1];
  const kws = keywords(c.message);
  const familyish = kws.some((k) => FAMILY_HINT_RE.test(k));
  // Gate: only fetch when the message clearly references the workstation domain.
  // Otherwise we'd inject the catalog into an unrelated chat.
  if (!vendor && !form_factor && !familyish) return [];

  const store = getKristiWorkstationsStore();
  const filter: { vendor?: Vendor; form_factor?: FormFactor; limit: number } = { limit: 60 };
  if (vendor) filter.vendor = vendor;
  if (form_factor) filter.form_factor = form_factor;
  let rows = store.find_skus(filter);
  // Narrow by free keywords against model_name/family/model_id (no FTS exists).
  if (kws.length > 0) {
    const narrowed = rows.filter((r) =>
      contains_any(`${r.model_name} ${r.family} ${r.model_id}`, kws),
    );
    if (narrowed.length > 0) rows = narrowed;
  }
  rows = rows.slice(0, 6);
  if (rows.length === 0) return [];
  return [
    '### Matching workstation SKUs (your registry — authoritative)\n' +
      rows
        .map(
          (r) =>
            `- ${r.model_name} [${r.model_id}] — ${r.vendor} ${r.family}, ` +
            `${r.form_factor}, ${r.status}` +
            (r.swimlane ? `, swimlane ${r.swimlane}` : '') +
            (r.cpu_platform ? `, ${r.cpu_platform}` : '') +
            (r.source_url ? ` (${r.source_url})` : ''),
        )
        .join('\n'),
  ];
}

// ── Beatrice — scrum board state + architect self-model (anti-confabulation) ─

/** Beatrice's pack: scrum-board grounding + architect-authority grounding. */
async function trainer_pack(c: GroundingPackContext): Promise<string[]> {
  const blocks = await trainer_scrum_pack(c);
  blocks.push(...trainer_architect_blocks(c));
  return blocks;
}

// Architect/build language → inject her real authority + the chat↔deliberation
// channel split, so she neither denies it ("I can't write code / I'm the lens")
// nor over-claims it ("I already shipped that") on the Q4 chat tier.
const ARCHITECT_GATE_RE =
  /\b(architect|build|builds|building|built|author|authored|implement|implementing|coding|propose_code_change|pull[- ]?request|\bpr\b|merge|merging|refactor|self[- ]?modif|ship(?:ped)?(?: (?:a|the))? (?:fix|tool|change|feature)|write (?:me )?(?:a |the )?(?:new )?tool|new tool|scrum_groom)\b/i;

function trainer_architect_blocks(c: GroundingPackContext): string[] {
  if (!ARCHITECT_GATE_RE.test(c.message)) return [];
  return [
    '### Your architect authority (this is what you CAN do — do not deny or over-claim it)\n' +
      'You ARE Hearth’s architect. Authoring real code and config is YOUR job: `propose_code_change` ' +
      '(full file contents → an isolated `beatrice/*` PR) and `apply_low_risk_fix` (config) are tools ' +
      'you hold. You do NOT merge — Kate skeptic-reviews, then the owner approves the merge in your ' +
      'Code Shop office. So: "I can’t write code / file a PR / merge" is FALSE, and "I already shipped ' +
      'that" said from a chat turn is ALSO false — a chat turn cannot open a PR.\n\n' +
      'That build work runs in your DELIBERATION channel on the strong model, not in this chat turn. ' +
      'When the owner asks you to BUILD / author / change something here, do ONE of:\n' +
      '- File the proposal now (`write_binding_proposal` + `propose_action`, or `propose_persona_tuning` ' +
      '/ `propose_connector_recovery_hint`) so the owner can approve it — on approval it ships via your ' +
      'directed `propose_code_change` pass; OR\n' +
      '- If he wants it built right now, tell him to issue the directed build (the Code Shop “direct ' +
      'Beatrice” / `fire_deliberation` channel), which runs you on the strong model with ' +
      '`propose_code_change` in hand.\n' +
      'Answer structural QUESTIONS directly (read the codebase first; cite file:line). Never report a ' +
      'build as “done” from chat, and never deny the authority you actually hold.',
  ];
}

const SCRUM_GATE_RE =
  /\b(groom|grooming|board|backlog|sprint|epics?|scored?|unscored|commit|standup|roadmap|rank(?:ed)?)\b/i;

async function trainer_scrum_pack(c: GroundingPackContext): Promise<string[]> {
  // Only inject when the turn is actually about the board.
  if (!SCRUM_GATE_RE.test(c.message)) return [];
  const db = (c.memory as unknown as { cfg: { db: import('bun:sqlite').Database } }).cfg.db;
  const board = new ScrumStore(db).read_board();
  const all = LANES.flatMap((l) => board.lanes[l]);
  if (all.length === 0) return [];
  const unscored = all.filter((card) => card.unscored);
  const scored = all.length - unscored.length;

  const lines = [`Board right now: ${all.length} epics · ${scored} scored · ${unscored.length} UNSCORED.`];
  if (unscored.length === 0) {
    lines.push('Every epic is scored — the board is ranked and ready to groom/commit. ✓');
  } else {
    lines.push(
      `These ${unscored.length} epics are NOT scored (their size + value/severity are empty). ` +
        `Claiming the board is "already scored / ranked" is FALSE. To actually groom you MUST ` +
        `persist scores by CALLING scrum_epic_write(action:'score', items:[{epic_id, size, value (features) | severity (bugs)}, …]) ` +
        `— one batch call covers all of them. You cannot commit a sprint until they are scored (the commit is gated). ` +
        `The real unscored epic_ids:`,
    );
    for (const card of unscored.slice(0, 60)) {
      lines.push(`- ${card.id} [${card.type}] "${truncate(card.title, 48)}"`);
    }
    if (unscored.length > 60) lines.push(`- …and ${unscored.length - 60} more`);
  }
  return ['### Scrum board state (authoritative — pulled live this turn)\n' + lines.join('\n')];
}

// ── shared helpers ──────────────────────────────────────────────────────

const STOPWORDS = new Set([
  'what', 'whats', 'when', 'where', 'which', 'whom', 'whose', 'that', 'this',
  'these', 'those', 'there', 'here', 'with', 'from', 'your', 'yours', 'have',
  'has', 'had', 'will', 'would', 'should', 'could', 'about', 'into', 'over',
  'under', 'than', 'then', 'they', 'them', 'their', 'were', 'was', 'are', 'and',
  'the', 'for', 'you', 'can', 'did', 'does', 'done', 'tell', 'show', 'give',
  'need', 'want', 'know', 'please', 'hows', 'also', 'some', 'any', 'how', 'who',
  'why', 'whens', 'going', 'just', 'like', 'much', 'many', 'most',
]);

/**
 * Kate's pack: today's REAL calendar (the iOS-pushed snapshot), pre-injected so
 * a spoken/chat turn READS the schedule instead of fabricating it. The
 * deterministic grounding fix for the omission-fabrication class — the 27B live
 * tier stochastically skipped `sensor_calendar_upcoming` and invented events
 * ("Sam's birthday, day open") with zero tool calls (audit-proven). Per the
 * 2026-06 research: don't let the model DECIDE whether to look; put the record
 * in front of it. Calendar-only (weather/other tools stay model-fetched;
 * `tool_choice` forcing backstops those). FAIL-OPEN, and on a MISSING snapshot
 * it injects an explicit "can't see the calendar" block so she abstains instead
 * of inventing. Event times are already user-localized (sensor_calendar
 * contract) — sliced from the ISO string, never re-parsed through Date (which
 * would shift the zone).
 */
async function kate_pack(c: GroundingPackContext): Promise<string[]> {
  const blocks: string[] = [];

  // 0) HOUSEHOLD / PERSON / SECURITY — topic-gated, cordoned, all local reads
  // (Kate-as-the-house polish, 2026-07-28). These fire on BOTH chat and voice:
  // they only appear when the question is actually about the house or a
  // person, so the voice-latency rationale (don't grow every turn's prefill)
  // is preserved — a "who's home?" voice turn is exactly the turn that must
  // not be answered from vibes. Each block carries an explicit abstention
  // line when the data is missing, so silence never becomes an invitation.
  try {
    blocks.push(...(await kate_household_block(c)));
  } catch (err) {
    console.error('[grounding-pack] kate household block failed (fail-open):', err);
  }
  try {
    blocks.push(...kate_person_dossier_blocks(c));
  } catch (err) {
    console.error('[grounding-pack] kate person block failed (fail-open):', err);
  }
  try {
  } catch (err) {
    console.error('[grounding-pack] kate security block failed (fail-open):', err);
  }

  // 1) CALENDAR — live local read (SQLite snapshot, no network). Reuse the
  // brief's tz-correct, today/tomorrow-bucketed builder (read_calendar_from_snapshot
  // localizes via to_local_instant — the "farmers-market fix"), so a voice/chat
  // turn READS real LOCAL-time events instead of fabricating them or reading raw
  // UTC (15:00Z would be spoken as "3pm" when it's 9am Mountain).
  //
  // On VOICE this block is TOPIC-GATED (2026-08-03); on chat it stays always-on.
  //
  // The 2026-06-07 reversal skipped it on voice entirely, on the stated grounds
  // that "voice_style's GROUND FIRST + the forced round-0 lookup cover them".
  // Neither did: `_LOOKUP_INTENT_RE` never held a calendar term, so the forced
  // lookup could not fire for a calendar question, and the prompt line is soft
  // (measured 4/12 voice turns). That left voice with NO calendar grounding at
  // all, and the model filled the gap from its own transcript — on 2026-08-02
  // it spoke a real 6:00 PM "Dinner at little" back as "dinner at Little Hen at
  // 7 PM" and turned Sam's PTO into "your PTO meeting at 10 AM".
  //
  // Restoring it UNCONDITIONALLY would have broken the other half of the
  // reversal, which was right: an off-topic voice turn should carry no
  // always-on blocks at all. Gating on intent keeps voice lean for
  // "what's the capital of France" and grounded for "what's on my calendar" —
  // and CALENDAR_INTENT_RE is the SAME regex `_PREINJECTED_LOOKUPS` keys on, so
  // the pack and the forced-fetch backstop cannot disagree about what counts as
  // a calendar question.
  const want_calendar = c.surface !== 'voice' || CALENDAR_INTENT_RE.test(c.message);
  if (!want_calendar) return blocks;
  const tz = c.timezone ?? 'America/Denver';
  const cal = read_calendar_from_snapshot(c.memory, c.user_id, tz);
  if (cal.status === 'unavailable') {
    blocks.push(
      '### Calendar — UNAVAILABLE this turn\n' +
        'No iOS calendar snapshot has been received, so you CANNOT see the ' +
        'schedule. Do NOT state, guess, or recall any events — say plainly that ' +
        "you can't reach the calendar right now.",
    );
  } else {
    const render = (e: VerifiedCalendarEvent): string => {
      const loc = e.location ? ` @ ${truncate(e.location, 80)}` : '';
      return `- ${e.summary} — ${e.all_day ? 'all day' : e.start}${loc}`;
    };
    const today = cal.today.length
      ? cal.today.map(render).join('\n')
      : '(nothing scheduled today)';
    const tomorrow = cal.tomorrow.length
      ? cal.tomorrow.map(render).join('\n')
      : '(nothing scheduled tomorrow)';
    blocks.push(
      "### Calendar — VERIFIED (the user's REAL, localized schedule). These are the " +
        'ONLY real events. Speak from this list; do NOT add, rename, retime, or ' +
        'invent events, people, or locations. If it is not here, it is NOT on the ' +
        `calendar.\n**Today:**\n${today}\n\n**Tomorrow:**\n${tomorrow}`,
    );
  }

  // On voice the pack stops HERE — after the calendar block, before the
  // network-cache blocks (2026-08-03).
  //
  // The 2026-06-07 reversal put this return ABOVE the calendar read, on the
  // stated grounds that "voice_style's GROUND FIRST + the forced round-0 lookup
  // cover them". Neither did. `_LOOKUP_INTENT_RE` never contained a calendar
  // term, so the forced lookup could not fire for a calendar question, and the
  // prompt line is soft — it was measured at 4/12 voice turns. That left the
  // voice surface with NO calendar grounding of any kind, and the model filled
  // the gap from its own transcript: on 2026-08-02 it spoke a real 6:00 PM
  // "Dinner at little" back as "dinner at Little Hen at 7 PM", and turned
  // Sam's PTO into "your PTO meeting at 10 AM". Weather did the same on the
  // physical Satellite1 the same evening.
  //
  // The latency argument that motivated the reversal does not apply to this
  // block: it is a local SQLite read plus a JSON parse, no network. The blocks
  // BELOW are the ones that were actually at issue (the warm Pirate/HA cache),
  // and they stay behind the return. The `Calendar — UNAVAILABLE` branch above
  // is what a cold snapshot yields, so voice still gets an explicit
  // do-not-guess instruction rather than silence.
  if (c.surface === 'voice') return blocks;

  // 2) WEATHER + 3) HOME/EV — read from the WARM life-context cache only (the
  // background warmer in apps/orchestrator/server.ts keeps it hot; a chat/voice
  // turn must NOT make the Pirate/HA network calls inline). Cold/expired cache →
  // inject nothing for these signals; weather/EV stay model-fetched then (battery
  // is still in _LOOKUP_INTENT_RE as the forced-tool backstop). This is why the
  // warmer is a hard prerequisite for pre-injecting weather (see the directive).
  const warm = get_warm_life_context(c.user_id);
  if (warm) {
    const w = warm.weather;
    const wlines: string[] = [];
    const summary = fresh_value(w.forecast);
    if (summary) wlines.push(`- Today: ${summary}`);
    const hi = fresh_value(w.temperature_high_today);
    const lo = fresh_value(w.temperature_low_today);
    if (hi || lo) wlines.push(`- High / low: ${hi ?? '?'}°F / ${lo ?? '?'}°F`);
    const precip = fresh_value(w.precip_probability_today);
    if (precip !== null) {
      const pct = Math.round(Number(precip) * 100);
      if (Number.isFinite(pct)) wlines.push(`- Precip chance today: ${pct}%`);
    }
    const alerts = fresh_value(w.active_alert_count);
    if (alerts !== null) wlines.push(`- Active weather alerts: ${alerts}`);
    if (wlines.length > 0) {
      blocks.push(
        '### Weather — VERIFIED (your home, pre-fetched). Speak from these; do NOT ' +
          'invent a temperature, condition, or chance not listed.\n' +
          wlines.join('\n'),
      );
    }

    const elines: string[] = [];
    // `warm.ev` is omitted for a user without the `ev` facet (2026-06-15) —
    // guard so a no-EV user's pack carries no EV line at all.
    if (warm.ev) {
      const soc = fresh_value(warm.ev.soc_percent);
      if (soc !== null) elines.push(`- EV battery: ${soc}%`);
      const range = fresh_value(warm.ev.range_miles);
      if (range !== null) elines.push(`- EV range: ${range} mi`);
    }
    const indoor = fresh_value(w.indoor_temp);
    if (indoor !== null) elines.push(`- Indoor temperature: ${indoor}°F`);
    if (elines.length > 0) {
      blocks.push(
        '### Home & EV status — VERIFIED (pre-fetched). Speak from these; do NOT ' +
          'invent a charge level, range, or status not listed.\n' +
          elines.join('\n'),
      );
    }
  }

  return blocks;
}

// ── Kate — household / person / security blocks (2026-07-28) ────────────

// "Who's home?"-class questions. Deliberately tight: presence smalltalk
// ("how's the house?") shouldn't inject the occupancy ledger.
const HOUSEHOLD_GATE_RE =
  /\b(who'?s? (?:is )?(?:at )?home\b|anyone (?:home|here|at the house|in the house)|home alone|house (?:empty|occupied)|who(?:'s| is) (?:here|in the house|at the house)|occupancy)\b/i;

/** Household blocks are owner/household-tier only — in-home occupancy is
 *  exactly the data the friend-tier cordon exists to keep in. */
function household_tier_ok(c: GroundingPackContext): boolean {
  return c.tier === 'owner' || c.tier === 'household';
}

/** Who's home right now — enrolled people's latest camera sightings joined
 *  with phone home/away, plus active unknown clusters, plus what each member
 *  was wearing on camera TODAY (the day-scoped outfit read). */
async function kate_household_block(c: GroundingPackContext): Promise<string[]> {
  if (!household_tier_ok(c)) return [];
  if (!HOUSEHOLD_GATE_RE.test(c.message)) return [];

  const db = (c.memory as unknown as { cfg: { db: import('bun:sqlite').Database } }).cfg.db;
  let locations: Awaited<ReturnType<typeof resolve_household_locations>> = [];
  if (c.users) {
    try {
      locations = await resolve_household_locations(c.users, c.user_id, { db, now_ms: c.now.getTime() });
    } catch {
      locations = [];
    }
  }
  const occ = c.memory.get_household_occupancy(c.user_id, {
    window_minutes: 30,
    locations,
    now_ms: c.now.getTime(),
  });

  const lines: string[] = [];
  for (const o of occ.occupants) {
    const ago = o.seconds_ago != null ? `${Math.max(1, Math.round(o.seconds_ago / 60))} min ago` : 'recently';
    lines.push(`- ${o.name} — seen on camera (${o.zone ?? o.camera_name ?? 'unknown zone'}, ${ago})`);
  }
  for (const u of occ.unknown_present) {
    const appearance = u.appearance ? ` — ${truncate(u.appearance, 90)}` : '';
    lines.push(`- UNRECOGNIZED person — ${u.zone ?? u.camera_name ?? 'unknown zone'}${appearance}`);
  }
  for (const m of occ.household) {
    if (m.presence === 'home' || m.presence === 'away') {
      lines.push(`- ${m.display_name}'s phone: ${m.presence}${m.presence_as_of ? ` (as of ${m.presence_as_of.slice(11, 16)}Z)` : ''}`);
    }
  }

  if (lines.length === 0) {
    return [
      '### Who\'s home — NO DATA this turn\n' +
        'No phone presence fix and no BLE room reading. ' +
        'You do NOT know who is home right now — say so plainly, or take a live ' +
        'look (`household_occupancy`). Never guess.',
    ];
  }
  return [
    "### Who's home — VERIFIED (camera sightings + phone presence, pulled this turn)\n" +
      lines.join('\n') +
      '\nSpeak from these lines only. Someone not listed has simply not been ' +
      'seen in the window — that is "I haven\'t seen them", never "they\'re not home".',
  ];
}

/** Mentioned-person dossier digest — the People note facts + the nightly
 *  synthesis portrait + the camera appearance profile, so a question about a
 *  person starts from what Kate actually has instead of what sounds right. */
function kate_person_dossier_blocks(c: GroundingPackContext): string[] {
  const caller: Caller = { user_id: c.user_id, tier: (c.tier ?? 'friend') as Caller['tier'] };
  const people = visible_people(c.memory, caller);
  if (people.length === 0) return [];
  const mentioned = resolve_mentioned_people(c.message, people, 2);
  if (mentioned.length === 0) return [];

  const db = (c.memory as unknown as { cfg: { db: import('bun:sqlite').Database } }).cfg.db;
  const synthesis = new PersonSynthesisStore(db);
  const observations = new PersonObservations(db);
  const blocks: string[] = [];

  for (const p of mentioned) {
    const fm = parse_fm(p.frontmatter_json);
    const lines: string[] = [];
    const rel = typeof fm.relationship === 'string' ? fm.relationship : p.relationship;
    if (rel) lines.push(`- Relationship: ${rel}`);
    if (typeof fm.birthday === 'string' && fm.birthday) lines.push(`- Birthday: ${fm.birthday}`);
    const likes = Array.isArray(fm.likes) ? fm.likes.filter((x) => typeof x === 'string').slice(0, 5) : [];
    if (likes.length) lines.push(`- Likes: ${likes.join(', ')}`);

    const synth = synthesis.get_for_person(p.id, caller);
    if (synth?.summary) lines.push(`- Portrait (from your nightly synthesis): ${truncate(synth.summary, 320)}`);

    const obs = observations.list_for_person(p.id, caller, { limit: 16 });
    // Stable traits (build/hair) lead; recently-recurring clothing follows.
    const traits = obs.filter((o) => o.kind === 'appearance').slice(0, 3);
    const wear = obs.filter((o) => o.kind === 'appearance_wear').slice(0, 2);
    if (traits.length) {
      lines.push(`- On camera (build/hair): ${traits.map((o) => truncate(o.summary, 70)).join('; ')}`);
    }
    if (wear.length) {
      lines.push(`- Recently wearing: ${wear.map((o) => truncate(o.summary, 70)).join('; ')}`);
    }
    const recent = obs.filter((o) => !o.kind.startsWith('appearance')).slice(0, 3);
    for (const o of recent) lines.push(`- Noticed (${o.source_type}, ${o.observed_at.slice(0, 10)}): ${truncate(o.summary, 110)}`);

    const name = p.preferred_name || p.name;
    if (lines.length === 0) {
      blocks.push(
        `### ${name} — dossier check (pulled this turn)\n` +
          `${name} is on file but the dossier holds nothing beyond the name yet. ` +
          'Do NOT invent details about them; `who_is` has the full record, and say ' +
          'plainly when you don\'t know something.',
      );
    } else {
      blocks.push(
        `### ${name} — what you actually have on file (pulled this turn)\n` +
          lines.join('\n') +
          `\nBeyond these lines, nothing about ${name} is on file this turn — ` +
          'call `who_is` for more; never fill gaps from memory.',
      );
    }
  }
  return blocks;
}

/** A VerifiedReading's value as a string when fresh+present, else null. */
function fresh_value(r: VerifiedReading): string | null {
  if (r.status !== 'fresh' || r.value === null || r.value === undefined) return null;
  return String(r.value);
}

/** Lowercased content tokens worth matching on (len>=4, non-stopword, capped). */
function keywords(message: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of message.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < 4 || STOPWORDS.has(raw) || seen.has(raw)) continue;
    seen.add(raw);
    out.push(raw);
    if (out.length >= 8) break;
  }
  return out;
}

function contains_any(haystack: string, kws: string[]): boolean {
  const h = haystack.toLowerCase();
  return kws.some((k) => h.includes(k));
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1).trimEnd()}…`;
}

function usd(n: number | null): string {
  return n == null ? '?' : `$${Math.round(n).toLocaleString('en-US')}`;
}

function fmt_date(iso: string | null): string {
  if (!iso) return '?';
  return iso.length >= 10 ? iso.slice(0, 10) : iso;
}
