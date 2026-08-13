/**
 * Calendar owner attribution (2026-06-20, Phase 2) — "whose event is this?"
 *
 * The problem: in a shared household calendar, members label events generically
 * ("appointment", "meeting"), so the TITLE can't tell you who created it — and
 * assuming the owner is exactly the bug (Sam's generic events read as Jasper's).
 * The fix is signal FUSION + LEARNING: attribute from the signals the title
 * lacks, and remember the owner's answers so it gets better.
 *
 * Signals fused (deterministic, each a weighted vote per candidate member):
 *   - LEARNED — a prior confirmed attribution matching this event's fingerprint
 *     (title+location+weekday+hour, most-specific tier wins). The strongest, and
 *     the one that makes generic recurring events self-attribute over time.
 *   - CALENDAR — the sub-calendar carries a member's name/email ("Sam's Gmail").
 *   - ORGANIZER — the event organizer resolves to a member.
 *   - LOCATION — the place resolves to a member's place (e.g. her salon).
 *
 * Returns the best candidate + confidence + the signals that voted, or
 * `user_id: null` (uncertain) when nothing distinguishes — the caller then ASKS
 * rather than guessing, and records the answer via EventAttributions.record so
 * the next occurrence is automatic. Pure given its injected lookups.
 */
import { local_dow, local_hhmm } from '@core/time';
import {
  EventAttributions,
  type AttributionComponents,
  type MatchTier,
} from '@memory/stores/event_attributions';

export interface AttributionMember {
  id: string;
  display_name: string;
  email: string | null;
}

export interface CalendarEventForAttribution {
  title: string;
  location?: string | null;
  organizer?: string | null;
  calendar_name?: string | null;
  ts_start: string;
}

export interface AttributionDeps {
  /** Candidate members (owner + household; NOT friends — a friend doesn't own
   *  household-calendar events). */
  members: AttributionMember[];
  attributions: EventAttributions;
  /** location string → member id, via a Place tied to that member (the source
   *  wires this over the Places vault). Optional. */
  place_owner?: (location: string) => string | null;
  tz?: string;
}

export interface AttributionResult {
  /** The attributed member, or null when uncertain (the caller should ASK). */
  user_id: string | null;
  confidence: number; // 0..1
  signals: string[]; // human-readable reasons that voted
  components: AttributionComponents;
  /** Per-candidate scores, for debugging / the ask context. */
  scores: Record<string, number>;
}

const LEARNED_WEIGHT: Record<MatchTier, number> = {
  exact: 0.9,
  title_time: 0.65,
  title_location: 0.6,
  title: 0.35,
};
/** A confirmed CONTAINS rule ("Dana" → Sam) is nearly as strong as an exact
 *  learned match — it's an explicit owner statement, just phrased loosely. */
const SUBSTRING_WEIGHT = 0.85;
const CALENDAR_WEIGHT = 0.6;
const ORGANIZER_WEIGHT = 0.7;
const LOCATION_WEIGHT = 0.6;
/** Minimum top score to attribute; below this → uncertain → ask. */
const ATTRIBUTION_MIN = 0.6;
/** The top must beat the runner-up by this margin to be unambiguous. */
const ATTRIBUTION_MARGIN = 0.2;

export function normalize(s: string | null | undefined): string {
  return (s ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function compute_components(
  event: CalendarEventForAttribution,
  tz?: string,
): AttributionComponents {
  const d = new Date(event.ts_start);
  return {
    title_norm: normalize(event.title),
    location_norm: normalize(event.location ?? ''),
    weekday: local_dow(d, tz),
    hour: Number.parseInt(local_hhmm(d, tz).slice(0, 2), 10) || 0,
  };
}

function email_local(s: string): string | null {
  const m = s.match(/([a-z0-9._%+-]+)@/i);
  return m ? m[1]!.toLowerCase() : null;
}

export function attribute_event_owner(
  event: CalendarEventForAttribution,
  deps: AttributionDeps,
): AttributionResult {
  const components = compute_components(event, deps.tz);
  const scores: Record<string, number> = {};
  const signals: string[] = [];
  const add = (id: string, w: number) => {
    scores[id] = (scores[id] ?? 0) + w;
  };

  // 1. LEARNED — strongest; the path that makes generic events self-attribute.
  const learned = deps.attributions.best_match(components);
  if (learned && deps.members.some((m) => m.id === learned.user_id)) {
    add(learned.user_id, LEARNED_WEIGHT[learned.tier]);
    signals.push(`learned (${learned.tier}) → ${learned.user_id}`);
  }

  // 1b. SUBSTRING RULE — a confirmed CONTAINS rule (the owner said "Dana's are
  //     mine"); matches loosely-phrased real titles the exact tiers miss.
  const sub = deps.attributions.match_substring(components.title_norm);
  if (sub && deps.members.some((m) => m.id === sub.user_id)) {
    add(sub.user_id, SUBSTRING_WEIGHT);
    signals.push(`rule "${sub.phrase}" → ${sub.user_id}`);
  }

  // 2. CALENDAR — the sub-calendar names a member.
  const cal = normalize(event.calendar_name ?? '');
  if (cal) {
    for (const m of deps.members) {
      const name = normalize(m.display_name);
      const local = m.email ? email_local(m.email) : null;
      if ((name && cal.includes(name)) || (local && cal.includes(local))) {
        add(m.id, CALENDAR_WEIGHT);
        signals.push(`calendar "${event.calendar_name}" → ${m.id}`);
      }
    }
  }

  // 3. ORGANIZER — resolves to a member (email match, else name substring).
  const org = event.organizer ?? '';
  if (org.trim()) {
    const org_email = email_local(org);
    const org_norm = normalize(org);
    for (const m of deps.members) {
      const m_local = m.email ? email_local(m.email) : null;
      const name = normalize(m.display_name);
      if ((org_email && m_local && org_email === m_local) || (name && org_norm.includes(name))) {
        add(m.id, ORGANIZER_WEIGHT);
        signals.push(`organizer "${org}" → ${m.id}`);
      }
    }
  }

  // 4. LOCATION — a place tied to a member.
  if (event.location && deps.place_owner) {
    const owner = deps.place_owner(event.location);
    if (owner && deps.members.some((m) => m.id === owner)) {
      add(owner, LOCATION_WEIGHT);
      signals.push(`location "${event.location}" → ${owner}`);
    }
  }

  // Argmax with a margin check — an ambiguous tie stays uncertain (ask).
  const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  const top = ranked[0];
  const runner = ranked[1];
  let user_id: string | null = null;
  let confidence = 0;
  if (top && top[1] >= ATTRIBUTION_MIN && (!runner || top[1] - runner[1] >= ATTRIBUTION_MARGIN)) {
    user_id = top[0];
    confidence = Math.min(0.99, top[1]);
  } else if (top) {
    confidence = Math.min(0.99, top[1]); // surfaced for the ask context, but not attributed
  }

  return { user_id, confidence, signals, components, scores };
}
