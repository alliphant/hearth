/**
 * CalendarSource (2026-06-20, Phase 2) — the calendar SIGNAL SOURCE, the second
 * real source on the generic SignalRouter (captures are #1).
 *
 * iOS pushes the EventKit calendar as a diffable snapshot (POST /api/sensors/
 * calendar → `sensor_packet_received { signal:'calendar' }`). On each snapshot
 * this finds the NEW events (idempotent via the per-event life_event note),
 * ATTRIBUTES each to a household member (the fusion engine — calendar/organizer/
 * location/learned signals; see attribution.ts), writes an attributed
 * `life_event` note cordon-stamped to the owner, and delivers ONE batched
 * calendar FYI to Kate (her running picture) via the SignalRouter — listing any
 * events it couldn't attribute so she can ask (and learn via set_event_owner).
 *
 * DARK behind HEARTH_CALENDAR_GRAPH; fail-open (a throwing snapshot is logged +
 * skipped, never breaks the event bus). Owner-attribution UNCERTAINTY is
 * surfaced, never guessed — an unattributed event defaults to the snapshot owner
 * for the note's cordon but is flagged "whose is this?" so the title-less truth
 * gets learned instead of assumed.
 */
import { createHash } from 'node:crypto';
import type { Database } from 'bun:sqlite';
import type { AppEventBus } from '@app/events';
import type { MemoryClient } from '@memory/client';
import type { SpecialistInbox } from '@memory/stores/conversations';
import type { UserRegistry } from '@core/users';
import type { CalendarSnapshotEventShape } from '@memory/client';
import { parse_private_to } from '@memory/private_to';
import { local_iso_date } from '@core/time';
import { SignalRouter } from '@core/signal_router/router';
import { EventAttributions } from '@memory/stores/event_attributions';
import { enrich_life_event } from './enrich_life_event';
import {
  attribute_event_owner,
  normalize,
  type AttributionMember,
  type AttributionResult,
} from './attribution';

export function calendar_graph_enabled(): boolean {
  return process.env.HEARTH_CALENDAR_GRAPH === '1';
}

export interface CalendarSourceDeps {
  events: AppEventBus;
  memory: MemoryClient;
  db: Database;
  inbox: SpecialistInbox;
  users: UserRegistry;
}

/** Deterministic category classifier — a tunable keyword pass (no LLM). */
function classify_category(ev: CalendarSnapshotEventShape): string {
  const t = `${ev.title}`.toLowerCase();
  if (ev.calendar_type === 'birthday' || /\bbirthday\b/.test(t)) return 'birthday';
  if (/\banniversary\b/.test(t)) return 'anniversary';
  if (/\b(vacation|holiday|getaway)\b/.test(t)) return 'vacation';
  if (/\b(trip|flight|travel|drive to|visit)\b/.test(t)) return 'trip';
  if (/\b(dr\.?|doctor|dentist|appt|appointment|checkup|salon|haircut|vet)\b/.test(t)) return 'appointment';
  if (/\b(meeting|standup|sync|1:1|call|review)\b/.test(t)) return 'meeting';
  return 'other';
}

function le_id_for(event_id: string): string {
  return `le_${createHash('sha256').update(event_id).digest('hex').slice(0, 8)}`;
}
function le_path_for(event_id: string): string {
  return `Household/Calendar/${le_id_for(event_id)}.md`;
}

export class CalendarSource {
  private router: SignalRouter;
  private unsub?: () => void;

  constructor(private deps: CalendarSourceDeps) {
    this.router = new SignalRouter({ events: deps.events, memory: deps.memory, inbox: deps.inbox });
  }

  attach(): void {
    if (!calendar_graph_enabled()) {
      console.log('[calendar-source] disabled (HEARTH_CALENDAR_GRAPH != 1) — no-op');
      return;
    }
    this.unsub = this.deps.events.subscribe((ev) => {
      if (ev.type === 'sensor_packet_received' && ev.signal === 'calendar') {
        void this.on_snapshot(ev.user_id);
      }
    });
    console.log('[calendar-source] attached — attributing + routing new calendar events');
  }

  detach(): void {
    this.unsub?.();
    this.unsub = undefined;
  }

  /** Member candidates for attribution: owner + household (NOT friends). */
  private members(): AttributionMember[] {
    return this.deps.users
      .list()
      .filter((u) => u.tier !== 'friend')
      .map((u) => ({ id: u.id, display_name: u.display_name, email: u.email ?? null }));
  }

  /** location → member id, via a Place whose note is private_to that member. */
  private place_owner(location: string): string | null {
    try {
      const place = this.deps.memory.find_place_by_name(location);
      if (!place) return null;
      const note = this.deps.memory.read_note(place.note_path);
      const pt = parse_private_to(note?.frontmatter?.private_to);
      if (pt && pt !== 'household' && pt !== 'owner') return pt;
      return null;
    } catch {
      return null;
    }
  }

  /** Process a fresh calendar snapshot. Public so a smoke can drive it. */
  async on_snapshot(user_id: string): Promise<void> {
    try {
      const snap = this.deps.memory.query_calendar_snapshot(user_id);
      if (!snap || snap.events.length === 0) return;
      const members = this.members();
      const attributions = new EventAttributions(this.deps.db);
      const tz = this.deps.users.get_timezone(user_id);

      const fresh: Array<{ ev: CalendarSnapshotEventShape; attr: AttributionResult }> = [];
      for (const ev of snap.events) {
        const path = le_path_for(ev.event_id);
        if (this.deps.memory.read_note(path)) continue; // already processed (idempotent)
        if (ev.calendar_type === 'birthday') {
          // Birthday-calendar entries are noise for attribution; still record the
          // node so we don't reconsider it, but don't surface/attribute.
          this._write_life_event(ev, null, user_id, user_id, tz);
          continue;
        }
        const attr = attribute_event_owner(
          { title: ev.title, location: ev.location, organizer: ev.organizer, calendar_name: ev.calendar_name, ts_start: ev.ts_start },
          { members, attributions, place_owner: (l) => this.place_owner(l), tz },
        );
        const owner_id = attr.user_id ?? user_id; // default cordon to the snapshot owner when uncertain
        this._write_life_event(ev, attr, owner_id, owner_id, tz);
        fresh.push({ ev, attr });
      }

      if (fresh.length > 0) this._deliver_batch(fresh, user_id, tz);
    } catch (err) {
      console.error(`[calendar-source] snapshot processing failed (user ${user_id}):`, err);
    }
  }

  private _write_life_event(
    ev: CalendarSnapshotEventShape,
    attr: AttributionResult | null,
    owner_id: string,
    cordon: string,
    tz: string,
  ): void {
    const category = classify_category(ev);
    const note_path = le_path_for(ev.event_id);
    // Phase 3 inference — type implications, actionable-ness, participants +
    // typed knowledge_edges. Deterministic + fail-open (a throwing lookup just
    // yields fewer edges). Birthday-calendar entries (attr === null) are noise
    // we record but never surface, so skip enriching them.
    const enriched = attr
      ? enrich_life_event(
          { title: ev.title, category, owner: attr.user_id, location: ev.location, note_path, private_to: cordon },
          {
            find_person: (name) => {
              const p = this.deps.memory.find_person({ name });
              return p ? { note_path: p.note_path, display: String(p.frontmatter?.name ?? name) } : null;
            },
            find_place: (loc) => {
              const pl = this.deps.memory.find_place_by_name(loc);
              return pl ? { note_path: pl.note_path } : null;
            },
          },
        )
      : null;
    const fm: Record<string, unknown> = {
      type: 'life_event',
      id: le_id_for(ev.event_id),
      title: ev.title,
      category,
      event_date: ev.ts_start,
      end_date: ev.ts_end,
      source: 'calendar',
      source_event_id: ev.event_id,
      calendar_name: ev.calendar_name,
      ...(ev.location ? { location: ev.location } : {}),
      ...(attr?.user_id ? { owner: attr.user_id, attribution_confidence: Number(attr.confidence.toFixed(2)) } : {}),
      ...(attr && !attr.user_id ? { owner_uncertain: true } : {}),
      ...(enriched ? { actionable: enriched.actionable, implications: enriched.implications, participants: enriched.participants } : {}),
      private_to: cordon,
    };
    const day = local_iso_date(new Date(ev.ts_start), tz);
    const who = attr?.user_id ? `Attributed to **${attr.user_id}**` : attr ? 'Owner uncertain — ask.' : '';
    const body = [
      `# ${ev.title}`,
      '',
      `${day}${ev.location ? ` · ${ev.location}` : ''} · ${ev.calendar_name}`,
      who,
      attr?.signals?.length ? `\nSignals: ${attr.signals.join('; ')}` : '',
    ]
      .filter(Boolean)
      .join('\n');
    this.deps.memory.upsert_note(note_path, fm, body);
    // Typed inference edges (participant `attending`, place `located-at`) into
    // the knowledge_edges store — best-effort, never blocks the note write.
    if (enriched) {
      for (const e of enriched.edges) {
        try {
          this.deps.memory.knowledge_edges.upsert(e);
        } catch {
          /* fail-open */
        }
      }
    }
    void owner_id;
  }

  private _deliver_batch(
    fresh: Array<{ ev: CalendarSnapshotEventShape; attr: AttributionResult }>,
    user_id: string,
    tz: string,
  ): void {
    const lines: string[] = [`${fresh.length} new calendar event(s):`];
    const uncertain: string[] = [];
    for (const { ev, attr } of fresh) {
      const day = local_iso_date(new Date(ev.ts_start), tz);
      if (attr.user_id) {
        lines.push(`- "${ev.title}" (${day}) → **${attr.user_id}**`);
      } else {
        lines.push(`- "${ev.title}" (${day}) → _whose is this?_`);
        uncertain.push(`"${normalize(ev.title) || ev.title}"`);
      }
    }
    if (uncertain.length > 0) {
      lines.push(
        '',
        `I couldn't tell whose ${uncertain.length} event(s) ${uncertain.join(', ')} are. ` +
          `Tell me and I'll remember (set_event_owner) so future ones attribute automatically.`,
      );
    }
    // The owner's calendar is the household picture (null = owner-global); a
    // member's snapshot is cordoned to them.
    const tier = this.deps.users.get(user_id)?.tier;
    this.router.deliver({
      source: 'calendar',
      from_specialist_id: 'kate',
      to_specialist_id: 'kate',
      kind: 'fyi',
      body_md: lines.join('\n'),
      severity: uncertain.length > 0 ? 'medium' : 'low',
      originating_user_id: tier === 'owner' ? null : user_id,
      audit: {
        tool_name: 'calendar_signal',
        agent: 'kate',
        tool_input: { user_id, new_events: fresh.length, uncertain: uncertain.length },
      },
    });
  }
}
