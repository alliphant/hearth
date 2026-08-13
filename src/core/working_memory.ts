/**
 * Working memory — the fused household situational block (2026-07-01).
 *
 * The fusion scans (good_followups, calendar_followups, cross_signals,
 * meeting_prep, life_event_offers) REASON over the household's signals on a
 * morning cadence and file proposals — but at ANSWER time (a 2pm chat turn,
 * Kate's brief) the model saw only today's calendar + RAG. The signals lived
 * in six stores and Kate couldn't SEE them while reasoning; every read was
 * tool-gated on the interactive tier, whose tool-calling is the known-flaky
 * layer. This module is the read-side fix: ONE cordoned, per-user, fused
 * digest composed from the stores that already exist — no new write path, no
 * duplicated stream, nothing to drift.
 *
 * Sections (each an independent, fail-open read; all capped + truncated):
 *   - Mail needing you        (MailStore — significant non-bulk, unhandled)
 *   - People — what's live    (person life-event observations + birthdays)
 *   - Coming up               (life_events beyond the calendar pack's
 *                              today/tomorrow window)
 *   - Purchases & follow-ups  (household goods: closing return windows /
 *                              expiring warranties)
 *   - Bills & services        (household_services: bills whose cadence-derived
 *                              due estimate lands soon — the Services & Bills
 *                              ledger, 2026-07-04)
 *   - Awaiting your decision  (pending proposals visible to this user)
 *
 * Design rules (the grounding-pack contract, see grounding_packs.ts):
 *   - FAIL-OPEN per section: a throwing store read drops THAT section only;
 *     the composer never throws.
 *   - CHEAP: local SQLite reads only (~ms); no network, no LLM. The
 *     intelligence that FILLED these stores already ran upstream (triage
 *     judge, iMessage distill, calendar enricher); this is convergence, not
 *     inference.
 *   - CORDONED: every read is per-caller. Stores that cordon in-method get
 *     the Caller; MailStore rows are post-filtered via note_visible_to_caller
 *     (its documented contract). Birthdays (communal People graph, no
 *     private_to column) are household-tier knowledge: owner + household see
 *     them, a friend-tier caller gets NO people section at all.
 *   - SMALL: hard caps per section so the block stays ~500–800 tokens.
 *
 * Injection (both surfaces reuse existing mechanisms — nothing bespoke):
 *   - Chat: gather_grounding_packs appends these blocks as `verified`
 *     evidence for any specialist with `proactive.situational_context: true`
 *     (YAML opt-in, Kate first). The fact critic counts them as grounding.
 *   - Deliberation: deliberation.ts adds the rendered block to the ctx JSON
 *     (`situational_signals`) next to verified_life_context.
 *   - Voice: deliberately NOT injected — the voice surface is the lean-
 *     prefill path by design (see "Voice skips grounding packs", the private dev log).
 *
 * DARK by default: HEARTH_WORKING_MEMORY=1 enables (read at call time so
 * smokes can flip it); off → both surfaces are byte-identical to today.
 */

import type { Database } from 'bun:sqlite';
import type { MemoryClient, LifeEventRow, HouseholdGoodRow, HouseholdServiceRow } from '@memory/client';
import { note_visible_to_caller, type Caller } from '@memory/private_to';
import { MailStore, type MailMessage } from '@memory/stores/mail';
import { PersonObservations, type PersonObservation } from '@memory/stores/person_observations';
import { is_significant_non_bulk } from './mail_shelf';
import { ProposalsStore, type ProposalRow } from './proposals';
import { local_iso_date } from './time';

export function working_memory_enabled(): boolean {
  return process.env.HEARTH_WORKING_MEMORY === '1';
}

/** Everything the composer needs. `mail` / `observations` / `proposals` are
 *  injectable for tests (throwing fakes prove per-section fail-open); default
 *  construction from `db` is cheap (CREATE IF NOT EXISTS, idempotent). */
export interface WorkingMemoryDeps {
  memory: MemoryClient;
  db: Database;
  mail?: Pick<MailStore, 'recent_inbound'>;
  observations?: Pick<PersonObservations, 'recent_life_events'>;
  proposals?: Pick<ProposalsStore, 'list'>;
}

export interface ComposeOpts {
  user_id: string;
  tier: Caller['tier'];
  now?: Date;
  timezone?: string;
}

export interface WorkingMemoryResult {
  /** Rendered markdown sub-blocks, one per non-empty section. */
  sections: string[];
  /** Per-section item counts (for the audit row / smoke assertions). */
  counts: { mail: number; people: number; calendar: number; goods: number; bills: number; proposals: number };
}

// Caps — the block must stay lean (~500–800 tokens all-in).
const MAIL_CAP = 5;
const MAIL_WINDOW_DAYS = 7;
const PEOPLE_OBS_CAP = 4;
const PEOPLE_OBS_WINDOW_DAYS = 7;
const BIRTHDAY_CAP = 3;
const BIRTHDAY_WINDOW_DAYS = 14;
const CALENDAR_CAP = 5;
const CALENDAR_WINDOW_DAYS = 14;
const GOODS_CAP = 4;
const BILLS_CAP = 4;
const BILLS_WINDOW_DAYS = 14;
const PROPOSAL_CAP = 3;
const LINE_TRUNC = 120;

/**
 * Compose the fused block for one user. Never throws; a store outage
 * degrades to fewer sections (and zero sections → '' at render).
 */
export function compose_working_memory(
  deps: WorkingMemoryDeps,
  opts: ComposeOpts,
): WorkingMemoryResult {
  const now = opts.now ?? new Date();
  const caller: Caller = { user_id: opts.user_id, tier: opts.tier };
  const sections: string[] = [];
  const counts = { mail: 0, people: 0, calendar: 0, goods: 0, bills: 0, proposals: 0 };

  // ── Mail needing you ────────────────────────────────────────────────
  try {
    const mail = deps.mail ?? new MailStore(deps.db);
    const since = new Date(now.getTime() - MAIL_WINDOW_DAYS * 86_400_000).toISOString();
    const rows = mail
      .recent_inbound({ since, limit: 100 })
      .filter((m) => note_visible_to_caller(m.private_to, caller))
      .filter((m) => is_significant_non_bulk(m) && !m.handled)
      .sort((a, b) => b.triage_importance - a.triage_importance);
    counts.mail = rows.length;
    if (rows.length > 0) {
      const lines = rows.slice(0, MAIL_CAP).map(mail_line);
      if (rows.length > MAIL_CAP) lines.push(`- …and ${rows.length - MAIL_CAP} more in the digest`);
      sections.push(`**Mail needing you (last ${MAIL_WINDOW_DAYS}d):**\n${lines.join('\n')}`);
    }
  } catch (err) {
    console.error('[working-memory] mail section failed (fail-open):', err);
  }

  // ── People — what's live ────────────────────────────────────────────
  // Communal People-graph knowledge (household tier); a friend-tier caller
  // gets no people section at all.
  if (opts.tier === 'owner' || opts.tier === 'household') {
    try {
      const obs_store = deps.observations ?? new PersonObservations(deps.db);
      const since = new Date(now.getTime() - PEOPLE_OBS_WINDOW_DAYS * 86_400_000).toISOString();
      const obs = obs_store
        .recent_life_events(since)
        .filter((o) => note_visible_to_caller(o.private_to, caller))
        .slice(0, PEOPLE_OBS_CAP);
      const birthdays = deps.memory
        .birthdays_within(BIRTHDAY_WINDOW_DAYS, now)
        .slice(0, BIRTHDAY_CAP);
      counts.people = obs.length + birthdays.length;
      if (counts.people > 0) {
        const lines = [
          ...obs.map(obs_line),
          ...birthdays.map(
            (b) => `- ${b.name}'s birthday in ${b.days_until}d (${b.date})`,
          ),
        ];
        sections.push(`**People — what's live:**\n${lines.join('\n')}`);
      }
    } catch (err) {
      console.error('[working-memory] people section failed (fail-open):', err);
    }
  }

  // ── Coming up (beyond the calendar pack's today/tomorrow) ───────────
  try {
    const tz = opts.timezone;
    const wide = deps.memory.events_within(CALENDAR_WINDOW_DAYS, caller, now, tz);
    // The chat calendar grounding pack already carries today + tomorrow;
    // exclude that near window by ID using the store's own tz-correct math
    // rather than re-deriving local dates here.
    const near = new Set(deps.memory.events_within(1, caller, now, tz).map((e) => e.id));
    const upcoming = wide
      .filter((e) => !near.has(e.id))
      .sort(by_event_date)
      .slice(0, CALENDAR_CAP);
    counts.calendar = upcoming.length;
    if (upcoming.length > 0) {
      sections.push(
        `**Coming up (next ${CALENDAR_WINDOW_DAYS}d):**\n${upcoming.map(event_line).join('\n')}`,
      );
    }
  } catch (err) {
    console.error('[working-memory] calendar section failed (fail-open):', err);
  }

  // ── Purchases & follow-ups ──────────────────────────────────────────
  try {
    const tz = opts.timezone;
    const returns = deps.memory.goods_with_return_window_closing(7, caller, now, tz);
    const warranties = deps.memory.goods_with_warranty_expiring(14, caller, now, tz);
    const seen = new Set<string>();
    const lines: string[] = [];
    for (const g of returns) {
      if (seen.has(g.id) || lines.length >= GOODS_CAP) break;
      seen.add(g.id);
      lines.push(good_line(g, 'return window closes', g.return_window_until));
    }
    for (const g of warranties) {
      if (seen.has(g.id) || lines.length >= GOODS_CAP) continue;
      seen.add(g.id);
      lines.push(good_line(g, 'warranty expires', g.warranty_until));
    }
    counts.goods = lines.length;
    if (lines.length > 0) {
      sections.push(`**Purchases & follow-ups:**\n${lines.join('\n')}`);
    }
  } catch (err) {
    console.error('[working-memory] goods section failed (fail-open):', err);
  }

  // ── Bills & services (the Services & Bills ledger, 2026-07-04) ──────
  try {
    const bills = deps.memory.services_with_upcoming_bills(
      BILLS_WINDOW_DAYS,
      caller,
      now,
      opts.timezone,
    );
    counts.bills = bills.length;
    if (bills.length > 0) {
      const lines = bills.slice(0, BILLS_CAP).map(bill_line);
      if (bills.length > BILLS_CAP) lines.push(`- …and ${bills.length - BILLS_CAP} more due in the window`);
      sections.push(
        `**Bills & services (due estimates, next ${BILLS_WINDOW_DAYS}d):**\n${lines.join('\n')}`,
      );
    }
  } catch (err) {
    console.error('[working-memory] bills section failed (fail-open):', err);
  }

  // ── Awaiting your decision ──────────────────────────────────────────
  try {
    const proposals = deps.proposals ?? new ProposalsStore(deps.db);
    const rows = proposals.list({
      status: 'pending',
      limit: 25,
      visible_to: { user_id: opts.user_id, tier: opts.tier },
    });
    counts.proposals = rows.length;
    if (rows.length > 0) {
      const lines = rows.slice(0, PROPOSAL_CAP).map(proposal_line);
      if (rows.length > PROPOSAL_CAP) lines.push(`- …and ${rows.length - PROPOSAL_CAP} more in the queue`);
      sections.push(`**Awaiting your decision:**\n${lines.join('\n')}`);
    }
  } catch (err) {
    console.error('[working-memory] proposals section failed (fail-open):', err);
  }

  return { sections, counts };
}

/**
 * Render the composed sections as ONE prompt block ('' when empty). The
 * framing mirrors the verified-evidence contract: these are real cordoned
 * reads, absence is not proof of absence, drill in with tools.
 */
export function render_working_memory_block(result: WorkingMemoryResult): string {
  if (result.sections.length === 0) return '';
  return (
    '### Household pulse — fused signals (VERIFIED, pulled live this turn)\n' +
    result.sections.join('\n\n') +
    '\n\nThese lines are real cordoned reads from your own stores (mail digest, ' +
    'people graph, calendar, orders, proposal queue) — lead with what matters ' +
    'from them when relevant. They are CAPPED summaries: absence here is not ' +
    'proof of absence — drill in with your tools before asserting something is ' +
    'not happening.'
  );
}

/** Chat-surface convenience: compose + render in one guarded call. */
export function working_memory_blocks(
  deps: WorkingMemoryDeps,
  opts: ComposeOpts,
): string[] {
  if (!working_memory_enabled()) return [];
  try {
    const block = render_working_memory_block(compose_working_memory(deps, opts));
    return block ? [block] : [];
  } catch (err) {
    console.error('[working-memory] compose failed (fail-open):', err);
    return [];
  }
}

// ── line renderers ──────────────────────────────────────────────────────

function mail_line(m: MailMessage): string {
  const who = m.from_name || m.from_addr;
  const gist = m.summary || m.snippet;
  const action = m.suggested_action ? ` [${m.suggested_action}]` : '';
  return truncate(`- ${who} — "${m.subject}" — ${gist}`, LINE_TRUNC) + action;
}

function obs_line(o: PersonObservation): string {
  return truncate(`- ${o.summary}`, LINE_TRUNC);
}

function event_line(e: LifeEventRow): string {
  // local_iso_date, not slice(0,10): a stored UTC instant's date shifts a day
  // for evening events — the same class as the sensor_calendar relative-when fix.
  const date = e.event_date ? local_iso_date(e.event_date) : '(undated)';
  const owner = e.owner ? ` (${e.owner})` : '';
  const flag = e.actionable === 1 ? ' [actionable]' : '';
  return truncate(`- ${date} — ${e.title}${owner}`, LINE_TRUNC) + flag;
}

function good_line(g: HouseholdGoodRow, what: string, when: string | null): string {
  const merchant = g.merchant ? ` (${g.merchant})` : '';
  return truncate(`- ${what} ${when ? when.slice(0, 10) : 'soon'} — ${g.name}${merchant}`, LINE_TRUNC);
}

function bill_line(s: HouseholdServiceRow): string {
  const cat = s.category ? ` (${s.category})` : '';
  const amount =
    s.typical_amount_cents != null ? ` — ~$${(s.typical_amount_cents / 100).toFixed(2)}` : '';
  const autopay = s.autopay === 1 ? ' [autopay]' : '';
  return truncate(`- ~${s.next_due_estimate ?? 'soon'} — ${s.vendor}${cat}${amount}`, LINE_TRUNC) + autopay;
}

function proposal_line(p: ProposalRow): string {
  const label = p.title || p.summary || payload_gist(p.payload_json) || p.kind;
  return truncate(`- ${label} (from ${p.specialist_id})`, LINE_TRUNC);
}

/** Best-effort human line from a proposal payload (description/topic), '' otherwise. */
function payload_gist(payload_json: string): string {
  try {
    const p = JSON.parse(payload_json) as Record<string, unknown>;
    for (const key of ['description', 'topic', 'title'] as const) {
      const v = p[key];
      if (typeof v === 'string' && v.trim()) return v.trim();
    }
  } catch {
    /* unparseable payload → fall through to the kind */
  }
  return '';
}

function by_event_date(a: LifeEventRow, b: LifeEventRow): number {
  return (a.event_date ?? '9999').localeCompare(b.event_date ?? '9999');
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1).trimEnd()}…`;
}
