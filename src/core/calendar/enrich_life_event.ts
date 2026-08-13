/**
 * enrich_life_event (Phase 3, 2026-06-20) — the INFERENCE half of the Calendar
 * Knowledge Graph. Given an attributed calendar event (category already from the
 * classifier, owner already from attribution.ts), it types the event's
 * IMPLICATIONS, classifies it ACTIONABLE vs informational, names its
 * PARTICIPANTS, and emits typed knowledge_edges (participant `attending`,
 * place `located-at`) — the calendar twin of household_knowledge/enrich.ts.
 *
 * PURE given its injected lookups (find_person / find_place), so a smoke drives
 * it without a vault; fail-open (a throwing lookup degrades to "no edge", never
 * breaks the snapshot). The triggers date-scan the `actionable` flag + category;
 * the edges enrich the graph for Kate's reasoning. Deterministic — no LLM.
 */
import type { EdgeUpsert } from '@memory/stores/knowledge_edges';

/** Categories that imply a follow-up action (vs a purely informational entry). */
const ACTIONABLE_CATEGORIES = new Set(['vacation', 'trip', 'appointment', 'birthday', 'anniversary']);

/** Typed implications per category — what the event suggests Kate do. */
const IMPLICATIONS: Record<string, string[]> = {
  vacation: ['Ask for flight / travel details', 'Schedule a welcome-back reminder'],
  trip: ['Ask for travel details', 'Schedule a welcome-back reminder'],
  appointment: ['Prep the address + drive-time beforehand'],
  birthday: ['Plan a gift (~14 days out)'],
  anniversary: ['Plan a gift / something to mark it'],
};

export interface LifeEventForEnrich {
  title: string;
  category: string;
  /** The attributed owner (user_id), or null/undefined when uncertain. */
  owner?: string | null;
  location?: string | null;
  /** The life_event note's own path — the from_ref for the typed edges. */
  note_path: string;
  /** Visibility scope to stamp on every emitted edge (mirrors the node). */
  private_to: string;
}

export interface EnrichLifeEventDeps {
  /** name → a Person note, for matching a participant named in the title. Optional. */
  find_person?: (name: string) => { note_path: string; display: string } | null;
  /** location → a Place note, for the `located-at` edge. Optional. */
  find_place?: (location: string) => { note_path: string } | null;
}

export interface EnrichedLifeEvent {
  actionable: boolean;
  implications: string[];
  /** Display names / user ids of the people the event involves. */
  participants: string[];
  edges: EdgeUpsert[];
}

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

export function enrich_life_event(
  ev: LifeEventForEnrich,
  deps: EnrichLifeEventDeps = {},
): EnrichedLifeEvent {
  const category = ev.category || 'other';
  const actionable = ACTIONABLE_CATEGORIES.has(category);
  const implications = IMPLICATIONS[category] ?? [];
  const participants: string[] = [];
  const edges: EdgeUpsert[] = [];
  const conf = 0.9;

  // 1. The attributed owner is the primary participant (a typed `attending` edge
  //    to the member token — household members aren't always a Person note).
  if (ev.owner) {
    participants.push(ev.owner);
    edges.push({
      from_ref: ev.note_path,
      to_ref: `user:${ev.owner}`,
      kind: 'attending',
      confidence: conf,
      source: 'calendar_enrich',
      context: ev.title,
      private_to: ev.private_to,
    });
  }

  // 2. A Person named in the title (best-effort) — "Ann Kent", "Dinner w/ Dana".
  if (deps.find_person) {
    try {
      const title_norm = normalize(ev.title);
      // Try the whole title first (a bare "Ann Kent"), then each capitalized-ish token-pair.
      const candidates = new Set<string>([ev.title.trim()]);
      const words = ev.title.split(/\s+/).filter((w) => /^[A-Z][a-z]+$/.test(w));
      for (const w of words) candidates.add(w);
      for (const cand of candidates) {
        const p = deps.find_person(cand);
        if (p && !edges.some((e) => e.to_ref === p.note_path)) {
          // Only accept when the matched display name actually appears in the title
          // (find_person can fuzzy-match; we want a real mention).
          if (title_norm.includes(normalize(p.display)) || normalize(p.display).includes(normalize(cand))) {
            if (!participants.includes(p.display)) participants.push(p.display);
            edges.push({
              from_ref: ev.note_path,
              to_ref: p.note_path,
              kind: 'attending',
              confidence: 0.6,
              source: 'calendar_enrich',
              context: ev.title,
              private_to: ev.private_to,
            });
          }
        }
      }
    } catch {
      /* fail-open — a participant-match failure never breaks enrichment */
    }
  }

  // 3. The place (location → a Place note) — a typed `located-at` edge.
  if (ev.location && deps.find_place) {
    try {
      const place = deps.find_place(ev.location);
      if (place) {
        edges.push({
          from_ref: ev.note_path,
          to_ref: place.note_path,
          kind: 'located-at',
          confidence: 0.7,
          source: 'calendar_enrich',
          context: ev.location,
          private_to: ev.private_to,
        });
      }
    } catch {
      /* fail-open */
    }
  }

  return { actionable, implications, participants, edges };
}
