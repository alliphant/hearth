/**
 * Per-specialist pane composer (Stage 2 of the Specialist-as-Room
 * shift — see `~/Projects/hearth-ios/SPECIALIST_AS_ROOM_BRIEF.md`).
 *
 * iOS fetches `GET /api/specialists/:id/pane` and renders the
 * returned document as the body of `SpecialistRoomView`. The
 * document is opaque to iOS in the same way briefs are: a typed
 * top-level wrapper around a list of blocks that map to existing
 * `HearthCardPrimitives`. Adding a new pane kind is a backend +
 * yaml + (sometimes) primitives edit; never a Swift edit per
 * specialist.
 *
 * Block types
 * -----------
 *
 *   - `text`     — markdown body. The fallback when nothing more
 *                  structured fits. Use sparingly — a pane that's
 *                  90% text is mis-shaped for a glanceable room.
 *   - `list`     — title + array of `{ title, subtitle?, deep_link? }`.
 *                  Reuses the existing list primitive.
 *   - `link`     — single-row tap target with title + subtitle +
 *                  deep_link. Used when one row would be silly to
 *                  wrap in a list.
 *   - `embed`    — iOS-side embedded view dispatched by `view`
 *                  (e.g. `library_recent`, `library_knowledge`).
 *                  Lets a pane include an entire existing surface
 *                  as a block without re-serializing its content.
 *
 * Future passes introduce richer blocks (`hero_metric`,
 * `hr_zone_strip`, `load_chart`). Each new block ships in
 * `HearthCardPrimitives` and is added here once.
 */

import type { Database } from 'bun:sqlite';
import type { LoadedSpecialist } from '@core/specialist';
import type { LLMRouter } from '@core/llm';
import type { MemoryClient } from '@memory/client';
import type { ToolRegistry } from '@core/tool_registry';
import type { Tool, ToolContext } from '@core/tool';
import { ulid } from 'ulid';
import matter from 'gray-matter';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { CivicItemRow, ActiveWorkoutSnapshot } from '@memory/client';
import { compose_library_pane } from './library_pane';
import type { Tier, UserRegistry } from './users';
import { compose_home_pane } from './home_pane';
import { resolve_household_locations } from './household_awareness';
import type { HouseholdLocation } from '@memory/client';
import { load_rows as load_artist_watchlist } from '@specialists/maggie/tools/manage_watchlist';
import type { WorkoutSessionTracker } from '@app/routes/workout';
import { type Units, dist_from_m, dist_unit, elev_from_m, elev_unit } from '@core/units';
import { ActivityRingValueSchema } from '@app/routes/sensors';
import { read_shelf } from '@specialists/astrid/pr_shelf';
import {
  get_ruby_civic_store,
  civic_slug,
  type PoliticsItemRow,
  type RubyCivicStore,
} from '@memory/stores/ruby_civic';
import { summarize_watch_topics, type WatchEventLike } from '@specialists/ruby/civic_analysis';
import { campaign_list_field } from '@memory/client';
import {
  getKristiWorkstationsStore,
  type AssessmentRow,
  type AssessmentSubject,
  type SwimlaneProfileRow,
  type WsClass,
} from '@memory/stores/kristi_workstations';
import { getPropertyHistoryStore } from '@memory/stores/property_history';
import { getCountyAssessorStore } from '@memory/stores/assessor_county';
import {
  ResaleItemsStore,
  compute_aging,
  type ResaleItemRow,
  type SalesMetrics,
  type AgingEntry,
} from '@memory/stores/resale_items';
import { format_short_date, local_iso_date, local_day_start } from './time';
import { ChangeRecordsStore, type ChangeRecord } from '@memory/stores/change_records';
import { CodeShopSettings } from '@memory/stores/codeshop_settings';
import {
  PresenceZonesStore,
  DEFAULT_PRESENCE_DEVICE_ID,
  type ZoneRect,
} from '@memory/stores/presence_zones';
import { get_presence_cache } from './presence_cache';
import { scrum_pane_tab } from './scrum_pane';
import { SpecialistInbox } from '@memory/stores/conversations';
import { ProcessMissStore } from './process_misses';
import { ProposalsStore, type ProposalAction } from './proposals';
import { compose_news_desk_tab } from './news_pane';
import { compose_market_radar_tab } from './market_radar_pane';
import { compose_research_room_tab } from './research_pane';

export type PaneKind =
  | 'library'
  | 'activity'
  | 'today'
  | 'listening'
  | 'fuel'
  | 'program'
  | 'civic'
  | 'competitive'
  | 'property'
  | 'resale'
  | 'codeshop'
  | 'briefing'
  | 'presence'
  | 'home';

export type PaneBlock =
  | { type: 'text'; body_md: string }
  | {
      type: 'list';
      title?: string;
      items: Array<{
        title: string;
        subtitle?: string;
        deep_link?: string;
        /** Cordelia capture id for a leading thumbnail image. Clients
         *  resolve it to `/api/cordelia/thumbnail/<id>` (iOS via
         *  `HearthClient.thumbnailURL`, web via a direct `<img>`). Linda's
         *  resale office uses it to put the item photo on each card.
         *  Presentation-free: just the id, never a built URL. */
        thumb_capture_id?: string;
        /** Security-event id for a leading camera-frame thumbnail. Clients
         *  resolve it to `/api/specialists/cassandra/security/frame/<id>`
         *  (owner-gated; 404s once the event's frame ages out). The Security
         *  tab's Flagged rows use it so a concern shows its actual frame.
         *  Same presentation-free contract as `thumb_capture_id`. */
        frame_event_id?: string;
        /** Markdown revealed on tap — a specialist's written detail/assessment
         *  of this row (Kristi's Recon Desk uses it for her per-item view).
         *  When present, the client shows a chevron and expands inline. */
        detail_md?: string;
        /** Optional time-series charts revealed on tap, BELOW `detail_md` —
         *  same `load_chart` shape (tappable points → value-on-tap, the build-53
         *  pattern). Kristi's commodity rows carry per-OEM + market price
         *  sparklines so a tap shows the price history and each datapoint's
         *  value. A row with `charts` but no `detail_md` still expands. */
        charts?: Array<{
          title?: string;
          points: Array<{ x: string; y: number; label?: string; detail?: string }>;
          kind: 'sparkline' | 'bars';
          height_hint?: 'sm' | 'md';
        }>;
      }>;
    }
  | {
      type: 'link';
      title: string;
      subtitle?: string;
      deep_link: string;
    }
  | {
      type: 'embed';
      view:
        /** Cordelia's Library tab content — Recent captures +
         *  Knowledge browser, segmented as today. Single embed
         *  rather than two separate `library_recent` /
         *  `library_knowledge` blocks because the segmented UI is
         *  the existing affordance and splitting it would force
         *  iOS to reimplement the segment picker per room. */
        | 'library'
        /** Kate's latest brief, rendered by iOS's existing
         *  `BriefDetailView` (it fetches `/api/briefs/latest` itself,
         *  same pattern as `library`). Lets Kate's office show the
         *  full brief in-room without the pane re-serializing every
         *  section — single source of truth stays the briefs table. */
        | 'brief';
    }
  /** Big number + label + optional delta. The pane's hero stat —
   *  what's the one thing the user wants to glance at first.
   *  Generalized so it's not Astrid-specific: Astrid (elapsed time /
   *  week training load), Iris (SoC %), Vivian (today / week spend),
   *  Brigid (calorie progress), Maggie (week Plex hours), Kate (next
   *  event countdown). `delta_kind` is the value-judgment hint — for
   *  spend, up is bad; for training load, up is good; for SoC,
   *  context-dependent so neutral. */
  | {
      type: 'hero_metric';
      value: string;
      label: string;
      delta?: string;
      delta_kind?: 'up_good' | 'down_good' | 'neutral';
    }
  /** Horizontal bar with N proportional segments, each labeled +
   *  colored. Generalized from HR zones so it's not Astrid-specific.
   *  Reuse: Astrid (HR-zone min), Brigid (macro kcal split), Cassandra
   *  (event severity counts), Vivian (category spend split). `hue` is
   *  an iOS-side semantic token (`z1`..`z5`, `protein`/`carbs`/`fat`,
   *  `critical`/`warn`/`info`, etc.) — iOS resolves to a concrete
   *  color from its theme palette so backend stays presentation-free. */
  | {
      type: 'stacked_strip';
      title?: string;
      segments: Array<{ label: string; value: number; hue?: string }>;
    }
  /** Small sparkline / micro-bar-chart of N points. Reuse: Astrid
   *  (week training load), Vivian (week spend trend), Iris (week
   *  kWh consumed), Eleanor (week garden rainfall). `kind` picks the
   *  rendering — sparkline for continuous trends, bars for discrete
   *  buckets. `height_hint` lets iOS pick a sensible default vertical
   *  footprint when the pane has other tall blocks. */
  | {
      type: 'load_chart';
      title?: string;
      /** `label` is the x-axis tick under each point; `detail` is the
       *  formatted value shown when the point's marker is tapped. */
      points: Array<{ x: string; y: number; label?: string; detail?: string }>;
      kind: 'sparkline' | 'bars';
      height_hint?: 'sm' | 'md';
    }
  /** Reusable segmented/tabbed group — a row of tabs at the top, each holding
   *  its OWN ordered list of blocks; the client renders a segmented control and
   *  shows the active tab's blocks. Recursive (a tab's blocks are PaneBlocks),
   *  so any primitive composes inside a tab. Kristi's Recon Desk uses it to
   *  toggle Desktop / Mobile / Rack / Edge-AI; generic so any paned specialist
   *  can segment a surface. `badge` is an optional count shown on the tab. */
  | {
      type: 'tabs';
      /** `native` (additive, optional) advertises that a client with a native
       *  implementation of this tab should swap it in for the server blocks
       *  (e.g. `security_room` — the Person Threads room). Old builds ignore
       *  the extra field and keep rendering `blocks`; deploy order stays free
       *  in both directions (the design-security-room-swift §1 contract). */
      tabs: Array<{ id: string; label: string; badge?: number; native?: string; blocks: PaneBlock[] }>;
    }
  /** A Kate recommendation card — a concern she couldn't settle herself,
   *  escalated to the user (owner-gated). Carries her recommendation
   *  (`note_md`), what she already tried (`attempt_md`), the context-sensitive
   *  action buttons (decided through `/api/proposals/:id/decide`, with PIN
   *  step-up when `requires_step_up`), and an inline ask-back (`ask_back`) that
   *  posts to `/api/proposals/:id/ask`. Decisions train the proposal's
   *  category signature toward Kate handling the class autonomously. */
  | {
      type: 'recommendation';
      proposal_id: string;
      title: string;
      /** Kate's recommendation, in her voice (the proposal rationale). */
      note_md: string;
      /** What she already tried before escalating, if provided. */
      attempt_md?: string;
      /** Originating peer specialist id, if any — clients render the name. */
      source_specialist_id?: string;
      /** Context-sensitive buttons (do_it / Not now / Dismiss). */
      actions: ProposalAction[];
      /** True if approving the primary action needs PIN step-up. */
      requires_step_up: boolean;
      /** Whether the inline "ask Kate a question" affordance is offered. */
      ask_back: boolean;
    }
  /** The warm "how's the team doing" glance for Kate's briefing office.
   *  Surfaces three signals the user picked: brief cadence + mood, the
   *  escalations that bubbled up to Kate today (how many she cleared
   *  herself vs. still open), and the stuck/failed work from Mariah's
   *  process-miss ledger. Owner-gated at compose time — household
   *  members never see internal team ops. iOS renders it cozily; the
   *  `pulse` is the one-glance RAG signal (calm/attentive/concerned). */
  | {
      type: 'team_health';
      pulse: 'calm' | 'attentive' | 'concerned';
      /** Kate-voiced one-liner, e.g. "All quiet — last brief read 40m ago." */
      headline: string;
      brief_cadence: {
        /** ISO 8601 of the latest brief. Null when none exists yet. */
        last_generated_at: string | null;
        consumed: boolean;
        /** The latest brief's mood (calm/attentive/concerned), or null. */
        mood: string | null;
        /** Most-recent-first moods for a tiny trend strip. */
        recent_moods: string[];
      };
      escalations: {
        /** Flags that bubbled up to Kate in the user's local day. */
        today_total: number;
        /** Of today's, how many Kate already actioned (cleared herself). */
        cleared_by_kate: number;
        /** Flags still awaiting Kate (actioned_at IS NULL), any age. */
        still_open: number;
      };
      /** Open process misses (stalled/failed work), most-severe first. */
      stuck_work: Array<{
        subject_specialist_id: string;
        task_summary: string;
        gap: string;
        severity: 'low' | 'medium' | 'high';
        status: string;
      }>;
    };

export interface PaneDocument {
  /** Echoes `specialist.pane_kind` for clarity at the wire level. */
  pane_kind: PaneKind;
  /** Header title (e.g. "Activity", "Library"). */
  title: string;
  /** Optional one-line subtitle under the title. */
  subtitle?: string;
  /** Ordered list of blocks to render. */
  blocks: PaneBlock[];
  /** ISO 8601 — when this document was composed. iOS uses it for
   *  "last refreshed" hints + cache invalidation. */
  generated_at: string;
}

/**
 * Subset of ToolDeps the composer needs. Threading the full deps bag
 * would couple the composer to fields it doesn't use; this keeps the
 * surface narrow.
 */
export interface PaneDeps {
  vault_root: string;
  memory: MemoryClient;
  llm: LLMRouter;
  tool_registry: ToolRegistry;
  /** Process-wide in-memory tracker for active workout sessions.
   *  Optional because legacy smoke wiring (and library/listening
   *  composers) don't need it; the activity composer falls back to
   *  standby mode when null. */
  workout_tracker?: WorkoutSessionTracker;
  /** The caller's household `nearby_cities`, proximity-ordered
   *  (nearest first) from config/users.yaml. The listening pane uses
   *  the order as the tie-breaker when one artist plays multiple
   *  in-range cities — it surfaces the nearest date and folds the rest
   *  into a "+N more dates" hint. Absent → fall back to soonest-date. */
  nearby_cities?: string[];
  /** Whether the viewing user is the owner tier. Kate's briefing office
   *  gates its internal team-ops blocks (team_health, and Phase 2's
   *  recommendation cards) on this so a friend-tier household member
   *  sees only their own brief, never the staff's escalations/misses.
   *  Defaults to false (least-privilege) when the route can't resolve
   *  a tier. */
  viewer_is_owner?: boolean;
  /** Display units for the viewing user (users.yaml `units`, default
   *  imperial). Storage stays metric; composers convert at render. */
  viewer_units?: Units;
  /** The viewing user's real tier — the household-shared `home` office uses it
   *  to EXCLUDE friend tier (the `viewer_is_owner` boolean collapses
   *  friend→household). Defaults to least-privilege when unresolved. */
  viewer_tier?: Tier;
  /** The user registry — the `home` office resolves the home owner + each
   *  member's home/away from it. Optional (legacy smoke wiring omits it). */
  users?: UserRegistry;
}

/**
// Cordelia's `library` pane — the composed "Knowledge Desk" — lives in
// its own file (library_pane.ts) so the sessions sharing THIS file don't
// fight over it; `compose_library_pane` is imported at the top. It now
// composes real sections (triage backlog, recently-filed, owner-only
// knowledge gaps) over the committed capture + demand stores, then keeps
// the library file-browser embed at the bottom.

// ── listening pane (Maggie) ─────────────────────────────────────────────

/**
 * Maggie's `listening` pane — validates the second specialist room
 * and the chat-as-footer pattern beyond Cordelia. Four sections:
 *
 *   1. Coming to town — upcoming_shows rows with non-sold-out
 *      ticket_status, ordered by show_date ascending, capped at 5.
 *      The structured source comes from `check_show_status` calls
 *      Maggie's deliberation passes make on confirmed (artist,
 *      venue, date) matches.
 *   2. On your radar — artist watchlist (Knowledge/Maggie/
 *      artist_watchlist.md), top by affinity, capped at 5.
 *   3. Hitting your Plex — Tautulli get_home_stats top_artists at
 *      30d, capped at 5. Read through `plex_heavy_rotation`.
 *   4. New in the library — recent imports across sonarr / radarr /
 *      lidarr, latest first, capped at 5. Read through
 *      `media_library?view=history` per app.
 *
 * Sections 3 + 4 do external HTTP. When the upstream is down or
 * unconfigured the section renders with a single italic "Couldn't
 * reach <service>" line instead of disappearing — the empty-state
 * signal matters because "no shows on the radar" reads very
 * differently from "Tautulli is down."
 */
async function compose_listening_pane(
  db: Database,
  user_id: string,
  deps: PaneDeps,
): Promise<PaneDocument> {
  const [coming, radar, worth, plex, library] = await Promise.all([
    load_coming_to_town(db, user_id, deps.nearby_cities),
    load_on_your_radar(deps.vault_root),
    load_worth_a_look(db, user_id),
    load_hitting_plex(deps),
    load_new_in_library(deps),
  ]);

  const blocks: PaneBlock[] = [];
  blocks.push(section_or_empty('Coming to town', coming, 'No shows on the radar yet — Maggie sweeps at 08:00 / 18:00.'));
  blocks.push(section_or_empty('On your radar', radar, 'No artists on the watchlist yet — tell Maggie what you\'re into.'));
  blocks.push(section_or_empty('Worth a look', worth, 'Nothing queued — Maggie\'s thematic picks land here after the 18:00 sweep.'));
  blocks.push(section_or_empty('Hitting your Plex · last 30 days', plex, 'Plex history quiet for the last 30 days.'));
  blocks.push(section_or_empty('New in the library', library, 'No recent imports across the *arr stack.'));

  return {
    pane_kind: 'listening',
    title: 'Listening',
    subtitle: 'Your music & shows',
    blocks,
    generated_at: new Date().toISOString(),
  };
}

interface ListItem {
  title: string;
  subtitle?: string;
  deep_link?: string;
  detail_md?: string;
}

interface SectionResult {
  ok: boolean;
  items: ListItem[];
  /** When ok=false, a one-line italic block replaces the list. */
  error?: string;
}

function section_or_empty(
  title: string,
  res: SectionResult,
  empty_msg: string,
): PaneBlock {
  if (!res.ok) {
    return {
      type: 'list',
      title,
      items: [{ title: '—', subtitle: res.error }],
    };
  }
  if (res.items.length === 0) {
    return {
      type: 'list',
      title,
      items: [{ title: '—', subtitle: empty_msg }],
    };
  }
  return { type: 'list', title, items: res.items };
}

// ── section loaders ─────────────────────────────────────────────────────

interface ShowRow {
  artist: string;
  venue: string;
  city: string | null;
  show_date: string;
  tickets_url: string | null;
  ticket_status: string;
}

function load_coming_to_town(
  db: Database,
  user_id: string,
  nearby_cities?: string[],
): SectionResult {
  const today = local_iso_date();
  // Pull a WIDE window (not just the top 5): future, non-sold-out,
  // non-resale-only, and NOT already marked as going (Jasper has tickets →
  // mark_show_going stamps going_marked_at). We collapse by artist below,
  // so we need every city a given artist plays before capping at 5.
  const rows = db
    .prepare(
      `SELECT artist, venue, city, show_date, tickets_url, ticket_status
         FROM upcoming_shows
        WHERE user_id = @uid
          AND show_date >= @today
          AND going_marked_at IS NULL
          AND ticket_status NOT IN ('sold_out', 'resale_only')
        ORDER BY show_date ASC
        LIMIT 50`,
    )
    .all({ '@uid': user_id, '@today': today }) as ShowRow[];

  // City proximity rank from the household's nearby_cities order (nearest
  // first). Lower = nearer. Unknown / null city sorts last-but-finite so
  // ties still break deterministically by date.
  const FAR = Number.MAX_SAFE_INTEGER;
  const rank_of = (city: string | null): number => {
    if (!city || !nearby_cities || nearby_cities.length === 0) return FAR;
    const i = nearby_cities.findIndex(
      (c) => c.trim().toLowerCase() === city.trim().toLowerCase(),
    );
    return i < 0 ? FAR : i;
  };

  // Collapse by artist: one row per artist, represented by its NEAREST
  // in-range date (tie → soonest, since rows are date-sorted). The other
  // dates fold into a "+N more dates" hint.
  interface Group {
    rep: ShowRow;
    rep_rank: number;
    count: number;
  }
  const groups = new Map<string, Group>();
  for (const r of rows) {
    const key = r.artist.trim().toLowerCase();
    const rank = rank_of(r.city);
    const existing = groups.get(key);
    if (!existing) {
      groups.set(key, { rep: r, rep_rank: rank, count: 1 });
      continue;
    }
    existing.count += 1;
    // Strictly-nearer city wins; equal rank keeps the earlier-seen
    // (soonest) row.
    if (rank < existing.rep_rank) {
      existing.rep = r;
      existing.rep_rank = rank;
    }
  }

  // Surface artists ordered by their representative date, capped at 5.
  const ordered = [...groups.values()].sort((a, b) =>
    a.rep.show_date < b.rep.show_date ? -1 : a.rep.show_date > b.rep.show_date ? 1 : 0,
  );
  const items = ordered.slice(0, 5).map((g): ListItem => {
    const r = g.rep;
    const date_label = format_show_date(r.show_date);
    const where = r.city ? `${r.venue}, ${r.city}` : r.venue;
    const status_label = format_status(r.ticket_status);
    const more = g.count - 1;
    const more_label = more > 0 ? ` · +${more} more date${more === 1 ? '' : 's'}` : '';
    const base = status_label
      ? `${date_label} · ${where} · ${status_label}`
      : `${date_label} · ${where}`;
    return {
      title: r.artist,
      subtitle: `${base}${more_label}`,
      ...(r.tickets_url ? { deep_link: r.tickets_url } : {}),
    };
  });
  return { ok: true, items };
}

/**
 * "Worth a look" — Maggie's thematic media recommendations, the
 * structured replacement for the old propose_action({kind:'recommendation'})
 * media path. Reads active (not dismissed / not yet acquired) rows the
 * suggest_media tool wrote, freshest first, capped at 5. Already-owned
 * titles never reach this table — suggest_media dedups against the *arr
 * library at write time.
 */
function load_worth_a_look(db: Database, user_id: string): SectionResult {
  type Row = {
    title: string;
    media_kind: string;
    rationale: string;
    profile_match: string | null;
    source_url: string | null;
  };
  const rows = db
    .prepare(
      `SELECT title, media_kind, rationale, profile_match, source_url
         FROM media_recommendations
        WHERE user_id = @uid AND status = 'active'
        ORDER BY last_seen_at DESC
        LIMIT 5`,
    )
    .all({ '@uid': user_id }) as Row[];
  const kind_label: Record<string, string> = {
    movie: 'Film',
    tv: 'TV',
    music: 'Music',
    book: 'Book',
  };
  const items = rows.map((r): ListItem => {
    const tag = kind_label[r.media_kind] ?? r.media_kind;
    const subtitle = r.profile_match
      ? `${tag} · ${r.rationale} — ${r.profile_match}`
      : `${tag} · ${r.rationale}`;
    return {
      title: r.title,
      subtitle,
      ...(r.source_url ? { deep_link: r.source_url } : {}),
    };
  });
  return { ok: true, items };
}

function load_on_your_radar(vault_root: string): SectionResult {
  try {
    const rows = load_artist_watchlist(vault_root)
      .slice()
      .sort((a, b) => b.affinity - a.affinity || a.artist.localeCompare(b.artist))
      .slice(0, 5);
    const items = rows.map((r): ListItem => {
      const last_show = r.past_shows.length > 0
        ? r.past_shows[r.past_shows.length - 1]
        : null;
      const subtitle = last_show
        ? `Affinity ${r.affinity} · last seen ${last_show}`
        : `Affinity ${r.affinity}`;
      return {
        title: r.artist,
        subtitle,
        ...(r.tour_page_url ? { deep_link: r.tour_page_url } : {}),
      };
    });
    return { ok: true, items };
  } catch (err) {
    return {
      ok: false,
      items: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function load_hitting_plex(deps: PaneDeps): Promise<SectionResult> {
  const tool = deps.tool_registry.get('plex_heavy_rotation');
  if (!tool) {
    return { ok: false, items: [], error: 'plex_heavy_rotation not registered' };
  }
  try {
    const ctx = make_system_ctx(deps);
    type HeavyOutput = {
      items: Array<{ title: string; parent_title: string; grandparent_title: string; plays: number | null }>;
      error?: string;
    };
    const res = (await tool.execute(
      { stat: 'top_artists', window_days: 30, count: 5, stat_type: 'plays' },
      ctx,
    )) as HeavyOutput;
    if (res.error) return { ok: false, items: [], error: 'Plex / Tautulli unavailable' };
    const items = res.items.slice(0, 5).map((r): ListItem => ({
      title: r.title || r.grandparent_title || r.parent_title || 'untitled',
      subtitle: r.plays != null ? `${r.plays} play${r.plays === 1 ? '' : 's'}` : undefined,
    }));
    return { ok: true, items };
  } catch (err) {
    return {
      ok: false,
      items: [],
      error: err instanceof Error ? err.message : 'Plex / Tautulli unavailable',
    };
  }
}

async function load_new_in_library(deps: PaneDeps): Promise<SectionResult> {
  const tool = deps.tool_registry.get('media_library');
  if (!tool) {
    return { ok: false, items: [], error: 'media_library not registered' };
  }
  // Pull the recent history from sonarr / radarr / lidarr in parallel.
  // Each is independent; one being down shouldn't hide the others.
  const apps: Array<'sonarr' | 'radarr' | 'lidarr'> = ['sonarr', 'radarr', 'lidarr'];
  type HistoryItem = { event: string; title: string; date: string };
  type HistoryOutput = { items: HistoryItem[]; error?: string };
  const ctx = make_system_ctx(deps);
  const settled = await Promise.allSettled(
    apps.map(async (app) => {
      const res = (await tool.execute({ app, view: 'history' }, ctx)) as HistoryOutput;
      return { app, res };
    }),
  );
  const combined: Array<{ app: string; title: string; date: string }> = [];
  let any_ok = false;
  for (const s of settled) {
    if (s.status !== 'fulfilled') continue;
    const { app, res } = s.value;
    if (res.error) continue;
    any_ok = true;
    for (const item of res.items) {
      // Only count imports — grabs aren't yet in the library, and
      // failures shouldn't surface as "new in the library."
      if (!/import/i.test(item.event)) continue;
      if (!item.title || !item.date) continue;
      combined.push({ app, title: item.title, date: item.date });
    }
  }
  if (!any_ok) {
    return { ok: false, items: [], error: '*arr stack unreachable' };
  }
  combined.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  const items = combined.slice(0, 5).map((r): ListItem => ({
    title: r.title,
    subtitle: `${r.app} · ${format_short_datetime(r.date)}`,
  }));
  return { ok: true, items };
}

// ── activity pane (Astrid) ──────────────────────────────────────────────

/**
 * Astrid's `activity` pane — third specialist room after Cordelia
 * (`library`) and Maggie (`listening`). Picks live vs. standby mode
 * by data: when `workout_sessions` carries an active row for the user
 * we render the in-flight session, otherwise we render a 7-day
 * rollup against PR shelves + recent sessions.
 *
 * No LLM calls. Pure structured reads. The "what does it mean" lives
 * in the chat thread (still available below the pane), not in the
 * glance — the room is for glanceable state.
 */
async function compose_activity_pane(
  db: Database,
  user_id: string,
  deps: PaneDeps,
): Promise<PaneDocument> {
  // Read the in-flight session through MemoryClient (the warm
  // workout_sessions row), not the in-memory tracker — so the live pane
  // survives an orchestrator restart. The route warms the row's rolling
  // columns on every heartbeat; `warm` is false only in the narrow
  // window after the start packet but before the first heartbeat.
  const live = deps.memory.query_active_workout(user_id);
  const units = deps.viewer_units ?? 'imperial';
  // A stale row is a dead stream (end packet never arrived) — present
  // standby, not a frozen "live" ride. The reaper finalizes the row.
  if (live && !live.stale) {
    if (live.warm) {
      return compose_activity_live(live, units);
    }
    // Active row exists but no heartbeat has warmed it yet — render
    // elapsed from started_at rather than fabricating zeros.
    return compose_activity_live_stub(live);
  }
  return compose_activity_standby(db, user_id, deps);
}

function compose_activity_live(live: ActiveWorkoutSnapshot, units: Units): PaneDocument {
  // Rolling fields are nominally nullable on the snapshot; on a warm row
  // elapsed/kcal are always present, but coalesce defensively so a sparse
  // packet (HR sensor not yet reporting) still renders a clean glance.
  const started_ms = Date.parse(live.started_at);
  const elapsed_s =
    live.elapsed_s ??
    (Number.isFinite(started_ms) ? Math.max(0, Math.floor((Date.now() - started_ms) / 1000)) : 0);
  const elapsed_label = format_elapsed(elapsed_s);
  const zone_label = live.paused
    ? 'Paused'
    : live.current_hr_zone != null
      ? `Zone ${live.current_hr_zone}`
      : 'Warming up';
  const blocks: PaneBlock[] = [
    {
      type: 'hero_metric',
      value: elapsed_label,
      label: `${live.workout_type} · ${zone_label}`,
      delta_kind: 'neutral',
    },
    {
      type: 'stacked_strip',
      title: 'Zones · minutes this session',
      segments: hr_zone_segments(live.hr_zone_minutes),
    },
    {
      type: 'list',
      title: 'Live readings',
      items: [
        {
          title: live.current_hr != null ? `${Math.round(live.current_hr)} bpm` : '— bpm',
          subtitle: 'heart rate',
        },
        {
          title: `${Math.round(live.active_kcal ?? 0)} kcal`,
          subtitle: 'active calories',
        },
        ...(live.distance_m != null
          ? [
            { title: `${dist_from_m(live.distance_m, units)} ${dist_unit(units)}`, subtitle: 'distance' },
            ...(live.elevation_gain_m != null && live.elevation_gain_m > 0
              ? [{ title: `${elev_from_m(live.elevation_gain_m, units)} ${elev_unit(units)}`, subtitle: 'climbed' }]
              : []),
          ]
          : []),
      ],
    },
    {
      type: 'link',
      title: 'Silence coaching cues',
      subtitle: 'mutes Astrid until the session ends',
      deep_link: 'hearth://astrid/cues/silence',
    },
  ];
  return {
    pane_kind: 'activity',
    title: 'Activity',
    subtitle: `Live · ${live.workout_type}`,
    blocks,
    generated_at: new Date().toISOString(),
  };
}

function compose_activity_live_stub(live: ActiveWorkoutSnapshot): PaneDocument {
  const started_ms = Date.parse(live.started_at);
  const elapsed_s = Number.isFinite(started_ms)
    ? Math.max(0, Math.floor((Date.now() - started_ms) / 1000))
    : 0;
  return {
    pane_kind: 'activity',
    title: 'Activity',
    subtitle: `Live · ${live.workout_type}`,
    blocks: [
      {
        type: 'hero_metric',
        value: format_elapsed(elapsed_s),
        label: `${live.workout_type} · session in flight`,
        delta_kind: 'neutral',
      },
      {
        type: 'text',
        body_md: '_Live readings unavailable — Astrid will reconnect on the next packet._',
      },
    ],
    generated_at: new Date().toISOString(),
  };
}

interface CompletedSession {
  session_id: string;
  workout_type: string;
  started_at: string;
  total_duration_s: number | null;
  total_active_kcal: number | null;
  hr_zone_minutes_json: string | null;
}

function compose_activity_standby(
  db: Database,
  user_id: string,
  deps: PaneDeps,
): PaneDocument {
  const units = deps.viewer_units ?? 'imperial';
  const since_iso = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const week_rows = db
    .prepare(
      `SELECT session_id, workout_type, started_at,
              total_duration_s, total_active_kcal, hr_zone_minutes_json
         FROM workout_sessions
        WHERE user_id = @uid
          AND status = 'completed'
          AND started_at >= @since
        ORDER BY started_at DESC`,
    )
    .all({ '@uid': user_id, '@since': since_iso }) as CompletedSession[];

  const prev_since_iso = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();
  const prev_week_rows = db
    .prepare(
      `SELECT total_duration_s
         FROM workout_sessions
        WHERE user_id = @uid
          AND status = 'completed'
          AND started_at >= @prev
          AND started_at <  @since`,
    )
    .all({ '@uid': user_id, '@prev': prev_since_iso, '@since': since_iso }) as Array<{ total_duration_s: number | null }>;

  const total_minutes = sum_minutes(week_rows.map((r) => r.total_duration_s));
  const prev_minutes = sum_minutes(prev_week_rows.map((r) => r.total_duration_s));
  const delta = describe_minutes_delta(total_minutes, prev_minutes);

  const week_zone_minutes = aggregate_zone_minutes(week_rows);

  const load_points = build_load_points(week_rows);

  const pr_items = load_pr_shelf_top(deps.vault_root, user_id, week_rows, units);

  const week_active_kcal = sum_active_kcal(week_rows);
  const ring_energy = read_latest_ring_energy(db, deps.vault_root, user_id);

  const recent_items: ListItem[] = week_rows.slice(0, 5).map((r) => ({
    title: `${r.workout_type} · ${format_session_date(r.started_at)}`,
    subtitle: describe_session_subtitle(r),
  }));

  const observation_text = read_recent_observation(deps.vault_root, user_id);

  const blocks: PaneBlock[] = [];
  blocks.push({
    type: 'hero_metric',
    value: `${total_minutes}`,
    label: 'training minutes · last 7 days',
    ...(delta.label ? { delta: delta.label } : {}),
    delta_kind: delta.kind,
  });
  blocks.push({
    type: 'load_chart',
    title: 'Daily training minutes',
    points: load_points,
    kind: 'bars',
    height_hint: 'sm',
  });
  if (week_zone_minutes.some((s) => s.value > 0)) {
    blocks.push({
      type: 'stacked_strip',
      title: 'Zones · minutes this week',
      segments: week_zone_minutes,
    });
  }
  // ── Energy ──────────────────────────────────────────────────────────
  // The calorie surface: today's Move-ring burn against goal, plus the
  // week's workout active-calorie total. Both render only when there's a
  // signal — a brand-new user with no ring snapshot and no sessions
  // doesn't get an empty calories card.
  const energy_items: ListItem[] = [];
  if (ring_energy && ring_energy.move_kcal != null) {
    const goal_part =
      ring_energy.move_goal_kcal != null
        ? ` / ${ring_energy.move_goal_kcal} goal${
            ring_energy.move_percent != null ? ` · ${ring_energy.move_percent}%` : ''
          }`
        : '';
    energy_items.push({
      title: `${ring_energy.move_kcal} kcal${goal_part}`,
      subtitle: "Move ring · today's active burn",
    });
  }
  if (week_active_kcal > 0) {
    energy_items.push({
      title: `${week_active_kcal} kcal`,
      subtitle: 'active calories · workouts this week',
    });
  }
  if (energy_items.length > 0) {
    blocks.push({ type: 'list', title: 'Energy', items: energy_items });
  }
  blocks.push({
    type: 'list',
    title: 'Personal records · top 3',
    items: pr_items.length > 0 ? pr_items : [{ title: '—', subtitle: 'No PRs on the shelf yet.' }],
  });
  blocks.push({
    type: 'list',
    title: 'Recent sessions',
    items: recent_items.length > 0 ? recent_items : [{ title: '—', subtitle: 'No completed sessions in the last 7 days.' }],
  });
  if (observation_text) {
    blocks.push({ type: 'text', body_md: `_${observation_text}_` });
  }

  // Standby is tabbed (2026-06-11): This Week keeps the original 7-day
  // rollup; eBike is the all-history cycling room; Training Log is the
  // per-exercise drill-down across everything ever recorded. Live mode
  // still takes over the whole pane untabbed.
  return {
    pane_kind: 'activity',
    title: 'Activity',
    subtitle: 'Training room',
    blocks: [
      {
        type: 'tabs',
        tabs: [
          { id: 'week', label: 'This Week', blocks },
          { id: 'ebike', label: 'eBike', blocks: compose_ebike_tab(db, user_id, units) },
          { id: 'log', label: 'Training Log', blocks: compose_training_log_tab(db, user_id, units) },
        ],
      },
    ],
    generated_at: new Date().toISOString(),
  };
}

// The eBike room reads cycling sessions only. One const so a future
// split (road vs gravel vs trainer workout_types) is a one-line change.
const EBIKE_WORKOUT_TYPE = 'cycling';

interface RideRow {
  session_id: string;
  ride_name: string | null;
  started_at: string;
  total_duration_s: number | null;
  total_distance_m: number | null;
  total_active_kcal: number | null;
  avg_hr: number | null;
  elevation_gain_m: number | null;
  avg_power_w: number | null;
}

function compose_ebike_tab(db: Database, user_id: string, units: Units): PaneBlock[] {
  const rows = db
    .prepare(
      `SELECT session_id, ride_name, started_at, total_duration_s, total_distance_m,
              total_active_kcal, avg_hr, elevation_gain_m, avg_power_w
         FROM workout_sessions
        WHERE user_id = @uid
          AND status = 'completed'
          AND workout_type = @wt
          AND COALESCE(total_duration_s, 0) >= 120
        ORDER BY started_at DESC`,
    )
    .all({ '@uid': user_id, '@wt': EBIKE_WORKOUT_TYPE }) as RideRow[];

  if (rows.length === 0) {
    return [{ type: 'text', body_md: '_No rides on file yet — the first one starts the log._' }];
  }

  const r1 = (n: number) => Math.round(n * 10) / 10;
  const du = dist_unit(units);
  const dist_of = (r: RideRow) => (r.total_distance_m != null ? r.total_distance_m : 0);
  const dsum = (rs: RideRow[]) => r1(dist_from_m(rs.reduce((a, r) => a + dist_of(r), 0), units));
  const now = Date.now();
  const ms30 = 30 * 24 * 60 * 60 * 1000;
  const started_ms = (r: RideRow) => Date.parse(r.started_at);

  // Hero: distance over the trailing 30 days, vs the 30 before.
  const d_30 = dsum(rows.filter((r) => started_ms(r) >= now - ms30));
  const d_prior = dsum(
    rows.filter((r) => started_ms(r) >= now - 2 * ms30 && started_ms(r) < now - ms30),
  );
  const d_diff = r1(d_30 - d_prior);
  const blocks: PaneBlock[] = [
    {
      type: 'hero_metric',
      value: `${d_30}`,
      label: `${du} ridden · last 30 days`,
      ...(d_prior > 0 || d_30 > 0
        ? { delta: `${d_diff >= 0 ? '+' : '−'}${Math.abs(d_diff)} ${du} vs prior 30` }
        : {}),
      delta_kind: d_diff > 0 ? 'up_good' : d_diff < 0 ? 'neutral' : 'neutral',
    },
  ];

  // Weekly distance, last 8 weeks (UTC buckets — trend shape, not a
  // wall-clock-keyed display string).
  const week_ms = 7 * 24 * 60 * 60 * 1000;
  const points: Array<{ x: string; y: number; label?: string }> = [];
  for (let w = 7; w >= 0; w -= 1) {
    const from = now - (w + 1) * week_ms;
    const to = now - w * week_ms;
    points.push({
      x: iso_day(new Date(from)),
      y: dsum(rows.filter((r) => started_ms(r) >= from && started_ms(r) < to)),
    });
  }
  blocks.push({
    type: 'load_chart',
    title: `Weekly distance · ${du} · last 8 weeks`,
    points,
    kind: 'bars',
    height_hint: 'sm',
  });

  // Recent rides — named, with the full subtitle telemetry.
  const ride_subtitle = (r: RideRow): string => {
    const parts: string[] = [];
    if (r.total_distance_m != null && r.total_distance_m > 0) parts.push(`${dist_from_m(r.total_distance_m, units)} ${du}`);
    if (r.total_duration_s != null) parts.push(`${Math.round(r.total_duration_s / 60)} min`);
    if (r.total_active_kcal != null && r.total_active_kcal > 0) parts.push(`${Math.round(r.total_active_kcal)} kcal`);
    if (r.avg_hr != null) parts.push(`${Math.round(r.avg_hr)} avg bpm`);
    if (r.elevation_gain_m != null && r.elevation_gain_m > 0) parts.push(`${elev_from_m(r.elevation_gain_m, units)} ${elev_unit(units)} climbed`);
    if (r.avg_power_w != null && r.avg_power_w > 0) parts.push(`${Math.round(r.avg_power_w)} W`);
    return parts.join(' · ');
  };
  blocks.push({
    type: 'list',
    title: 'Recent rides',
    items: rows.slice(0, 6).map((r) => ({
      title: `${r.ride_name ?? 'Ride'} · ${format_session_date(r.started_at)}`,
      subtitle: ride_subtitle(r),
      // Tap → the ride detail (GPS map + Astrid's cue timeline + the
      // session's stats). iOS resolves this to RideDetailView(sessionID:)
      // via openURL; web maps it to the Ride Log page (resolve_deep_link).
      deep_link: `hearth://workout/session/${r.session_id}`,
    })),
  });

  // Ride records — computed from the full history, each naming its ride.
  const record_of = (
    label: string,
    pick: (r: RideRow) => number | null,
    fmt: (v: number) => string,
  ): ListItem | null => {
    let best: RideRow | null = null;
    let best_v = 0;
    for (const r of rows) {
      const v = pick(r);
      if (v != null && v > best_v) {
        best = r;
        best_v = v;
      }
    }
    if (!best || best_v <= 0) return null;
    return {
      title: `${fmt(best_v)} — ${best.ride_name ?? format_session_date(best.started_at)}`,
      subtitle: `${label} · ${format_session_date(best.started_at)}`,
    };
  };
  const record_items = [
    record_of('farthest ride', (r) => r.total_distance_m, (v) => `${dist_from_m(v, units)} ${du}`),
    record_of('longest ride', (r) => r.total_duration_s, (v) => `${Math.round(v / 60)} min`),
    record_of('biggest climb', (r) => r.elevation_gain_m, (v) => `${elev_from_m(v, units)} ${elev_unit(units)}`),
    record_of('biggest burn', (r) => r.total_active_kcal, (v) => `${Math.round(v)} kcal`),
  ].filter((i): i is ListItem => i !== null);
  if (record_items.length > 0) {
    blocks.push({ type: 'list', title: 'Ride records', items: record_items });
  }

  // Lifetime line + the full Ride Log.
  const total_dist = dsum(rows);
  const total_h = r1(rows.reduce((a, r) => a + (r.total_duration_s ?? 0), 0) / 3600);
  const total_climb_m = rows.reduce((a, r) => a + (r.elevation_gain_m ?? 0), 0);
  const total_climb = elev_from_m(total_climb_m, units);
  blocks.push({
    type: 'text',
    body_md: `_${rows.length} ride${rows.length === 1 ? '' : 's'} on file · ${total_dist} ${du} · ${total_h} h${total_climb > 0 ? ` · ${total_climb} ${elev_unit(units)} climbed` : ''}._`,
  });
  blocks.push({
    type: 'link',
    title: 'Open the Ride Log',
    subtitle: 'every ride — elevation curve, splits, cues',
    deep_link: '/app/rides',
  });
  return blocks;
}

function compose_training_log_tab(db: Database, user_id: string, units: Units): PaneBlock[] {
  const rows = db
    .prepare(
      `SELECT workout_type,
              COUNT(*) AS n,
              SUM(COALESCE(total_duration_s, 0)) AS dur_s,
              SUM(COALESCE(total_distance_m, 0)) AS dist_m,
              SUM(COALESCE(total_active_kcal, 0)) AS kcal,
              MAX(COALESCE(total_duration_s, 0)) AS longest_s,
              MAX(started_at) AS last_at,
              MIN(started_at) AS first_at
         FROM workout_sessions
        WHERE user_id = @uid
          AND status = 'completed'
          AND COALESCE(total_duration_s, 0) >= 120
        GROUP BY workout_type
        ORDER BY n DESC, dur_s DESC`,
    )
    .all({ '@uid': user_id }) as Array<{
    workout_type: string;
    n: number;
    dur_s: number;
    dist_m: number;
    kcal: number;
    longest_s: number;
    last_at: string;
    first_at: string;
  }>;

  if (rows.length === 0) {
    return [{ type: 'text', body_md: '_Nothing logged yet — every session lands here automatically._' }];
  }

  const r1 = (n: number) => Math.round(n * 10) / 10;
  const items: ListItem[] = rows.map((r) => {
    const parts: string[] = [`${r1(r.dur_s / 3600)} h total`];
    if (r.dist_m > 0) parts.push(`${dist_from_m(r.dist_m, units)} ${dist_unit(units)}`);
    if (r.kcal > 0) parts.push(`${Math.round(r.kcal)} kcal`);
    parts.push(`longest ${Math.round(r.longest_s / 60)} min`);
    parts.push(`last ${format_session_date(r.last_at)}`);
    return {
      title: `${r.workout_type} · ${r.n} session${r.n === 1 ? '' : 's'}`,
      subtitle: parts.join(' · '),
    };
  });

  const total_n = rows.reduce((a, r) => a + r.n, 0);
  const first_overall = rows.map((r) => r.first_at).sort()[0];
  return [
    { type: 'list', title: 'Every exercise · all history', items },
    {
      type: 'text',
      body_md: `_${total_n} sessions logged${first_overall ? ` since ${format_session_date(first_overall)}` : ''}._`,
    },
  ];
}

// ── activity helpers ────────────────────────────────────────────────────

function format_elapsed(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const mm = Math.floor(s / 60);
  const ss = s % 60;
  if (mm < 60) return `${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
  const hh = Math.floor(mm / 60);
  const remm = mm % 60;
  return `${hh}:${String(remm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
}

function hr_zone_segments(z: { z1: number; z2: number; z3: number; z4: number; z5: number }): Array<{ label: string; value: number; hue: string }> {
  return (['z1', 'z2', 'z3', 'z4', 'z5'] as const).map((k) => ({
    label: k.toUpperCase(),
    value: Math.max(0, Math.round(z[k])),
    hue: k,
  }));
}

function sum_minutes(durations_s: Array<number | null>): number {
  let total_s = 0;
  for (const d of durations_s) {
    if (typeof d === 'number' && Number.isFinite(d)) total_s += d;
  }
  return Math.round(total_s / 60);
}

function describe_minutes_delta(
  current: number,
  prior: number,
): { label?: string; kind: 'up_good' | 'down_good' | 'neutral' } {
  if (prior === 0 && current === 0) return { kind: 'neutral' };
  if (prior === 0) return { label: `+${current} min vs prior week`, kind: 'up_good' };
  const diff = current - prior;
  if (diff === 0) return { label: 'flat vs prior week', kind: 'neutral' };
  const sign = diff > 0 ? '+' : '−';
  return { label: `${sign}${Math.abs(diff)} min vs prior week`, kind: diff > 0 ? 'up_good' : 'neutral' };
}

function aggregate_zone_minutes(rows: CompletedSession[]): Array<{ label: string; value: number; hue: string }> {
  const totals = { z1: 0, z2: 0, z3: 0, z4: 0, z5: 0 };
  for (const r of rows) {
    if (!r.hr_zone_minutes_json) continue;
    try {
      const parsed = JSON.parse(r.hr_zone_minutes_json) as Partial<typeof totals>;
      for (const k of Object.keys(totals) as Array<keyof typeof totals>) {
        const v = parsed[k];
        if (typeof v === 'number' && Number.isFinite(v)) totals[k] += v;
      }
    } catch {
      // Malformed JSON in a single row shouldn't poison the whole strip.
    }
  }
  return (['z1', 'z2', 'z3', 'z4', 'z5'] as const).map((k) => ({
    label: k.toUpperCase(),
    value: Math.round(totals[k]),
    hue: k,
  }));
}

function build_load_points(rows: CompletedSession[]): Array<{ x: string; y: number; label?: string }> {
  // Bucket by UTC day for the last 7 days inclusive. Pre-fill so a
  // quiet day renders as a zero-height bar rather than disappearing.
  const buckets = new Map<string, number>();
  for (let i = 6; i >= 0; i--) {
    const d = new Date(Date.now() - i * 24 * 60 * 60 * 1000);
    buckets.set(iso_day(d), 0);
  }
  for (const r of rows) {
    const d = new Date(r.started_at);
    if (Number.isNaN(d.getTime())) continue;
    const key = iso_day(d);
    if (!buckets.has(key)) continue;
    const minutes = (r.total_duration_s ?? 0) / 60;
    buckets.set(key, (buckets.get(key) ?? 0) + minutes);
  }
  return Array.from(buckets.entries()).map(([key, value]) => ({
    x: key,
    y: Math.round(value),
    label: short_day_label(new Date(`${key}T00:00:00Z`)),
  }));
}

function iso_day(d: Date): string {
  return local_iso_date(d);
}

function short_day_label(d: Date): string {
  return d.toLocaleString('en-US', { weekday: 'short', timeZone: 'UTC' });
}

function load_pr_shelf_top(
  vault_root: string,
  user_id: string,
  week_rows: CompletedSession[],
  units: Units,
): ListItem[] {
  // The PR shelves live one file per workout-type. Read every shelf
  // that exists for this user, score by "best metric per shelf," and
  // return the top 3 by recency of update. Week_rows tells us which
  // shelves are relevant first (this week's workout types), with a
  // fallback to scanning the records dir for users who haven't
  // worked out this week.
  const records_root = resolve(vault_root, `users/${user_id}/astrid/records`);
  if (!existsSync(records_root)) return [];

  const workout_types_this_week = Array.from(new Set(week_rows.map((r) => r.workout_type)));
  let all_types: string[];
  try {
    all_types = readdirSync(records_root)
      .filter((f) => f.endsWith('.md'))
      .map((f) => f.replace(/\.md$/, ''));
  } catch {
    return [];
  }
  const ordered = [
    ...workout_types_this_week.filter((t) => all_types.includes(t)),
    ...all_types.filter((t) => !workout_types_this_week.includes(t)),
  ];

  const items: ListItem[] = [];
  for (const workout_type of ordered) {
    const shelf = read_shelf(vault_root, user_id, workout_type);
    if (!shelf) continue;
    const best = pick_best_metric(shelf, units);
    if (!best) continue;
    items.push({
      title: workout_type,
      subtitle: `${best.metric_label} ${best.value_label} · ${shelf.updated.slice(0, 10)}`,
    });
    if (items.length >= 3) break;
  }
  return items;
}

interface BestMetric {
  metric_label: string;
  value_label: string;
}

function pick_best_metric(shelf: {
  longest_seconds: { value: number; date: string } | null;
  longest_distance_m: { value: number; date: string } | null;
  highest_active_kcal: { value: number; date: string } | null;
}, units: Units): BestMetric | null {
  // Pick the freshest metric on the shelf — that's the one Astrid
  // most recently said was a PR, which is the most representative
  // "what'd you just hit" glance.
  type Candidate = { date: string; metric: BestMetric };
  const candidates: Candidate[] = [];
  if (shelf.longest_seconds) {
    candidates.push({
      date: shelf.longest_seconds.date,
      metric: { metric_label: 'longest', value_label: `${Math.round(shelf.longest_seconds.value / 60)} min` },
    });
  }
  if (shelf.longest_distance_m) {
    candidates.push({
      date: shelf.longest_distance_m.date,
      metric: { metric_label: 'distance', value_label: `${dist_from_m(shelf.longest_distance_m.value, units)} ${dist_unit(units)}` },
    });
  }
  if (shelf.highest_active_kcal) {
    candidates.push({
      date: shelf.highest_active_kcal.date,
      metric: { metric_label: 'kcal', value_label: `${Math.round(shelf.highest_active_kcal.value)} kcal` },
    });
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  return candidates[0]!.metric;
}

function format_session_date(iso: string): string {
  return format_short_date(iso) ?? iso.slice(0, 10);
}

function describe_session_subtitle(r: CompletedSession): string {
  const minutes = r.total_duration_s != null ? Math.round(r.total_duration_s / 60) : null;
  const kcal = r.total_active_kcal != null ? Math.round(r.total_active_kcal) : null;
  const parts: string[] = [];
  if (minutes != null) parts.push(`${minutes} min`);
  if (kcal != null) parts.push(`${kcal} kcal`);
  if (parts.length === 0) return 'completed';
  return parts.join(' · ');
}

interface RingEnergy {
  move_kcal: number | null;
  move_goal_kcal: number | null;
  move_percent: number | null;
}

/**
 * Latest daily Move-ring energy for the office's energy block. The ring
 * lands as a `healthkit` sensor packet with `sample_type: 'activity_ring'`
 * inside the payload JSON, so we scan the most-recent healthkit packets
 * (cap 60 — a few days of daily snapshots) for the newest ring and parse
 * its raw kcal. Returns null when no ring packet exists or the latest is
 * an older percent-only packet without raw kcal.
 */
function read_latest_ring_energy(
  db: Database,
  vault_root: string,
  user_id: string,
): RingEnergy | null {
  const rows = db
    .prepare(
      `SELECT payload_path FROM sensor_packets
        WHERE user_id = @uid AND signal = 'healthkit'
        ORDER BY captured_at DESC
        LIMIT 60`,
    )
    .all({ '@uid': user_id }) as Array<{ payload_path: string }>;
  for (const row of rows) {
    const abs = resolve(vault_root, row.payload_path);
    if (!existsSync(abs)) continue;
    let payload: { sample_type?: string; value?: unknown };
    try {
      payload = JSON.parse(readFileSync(abs, 'utf8')) as typeof payload;
    } catch {
      continue;
    }
    if (payload.sample_type !== 'activity_ring') continue;
    const parsed = ActivityRingValueSchema.safeParse(payload.value);
    if (!parsed.success) return null;
    const r = parsed.data;
    if (r.move_kcal == null && r.move_percent == null) return null;
    return {
      move_kcal: r.move_kcal != null ? Math.round(r.move_kcal) : null,
      move_goal_kcal: r.move_goal_kcal != null ? Math.round(r.move_goal_kcal) : null,
      move_percent: r.move_percent != null ? Math.round(r.move_percent) : null,
    };
  }
  return null;
}

function sum_active_kcal(rows: CompletedSession[]): number {
  let total = 0;
  for (const r of rows) {
    if (typeof r.total_active_kcal === 'number' && Number.isFinite(r.total_active_kcal)) {
      total += r.total_active_kcal;
    }
  }
  return Math.round(total);
}

function read_recent_observation(vault_root: string, user_id: string): string | null {
  // Per-user observations file, per Astrid's persona writeup. The
  // file is markdown bullet-shaped; we pull the FIRST non-empty
  // bullet that survives a trim — that's the most recent observation
  // since Astrid prepends.
  const abs = resolve(vault_root, `users/${user_id}/astrid/observations.md`);
  if (!existsSync(abs)) return null;
  let text: string;
  try {
    text = readFileSync(abs, 'utf8');
  } catch {
    return null;
  }
  // Skip any frontmatter.
  const body = text.startsWith('---\n')
    ? text.slice(text.indexOf('\n---\n') + 5)
    : text;
  for (const line of body.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith('#')) continue;
    const without_bullet = trimmed.replace(/^[-*]\s*/, '').trim();
    if (without_bullet) return without_bullet.slice(0, 280);
  }
  return null;
}

// ── helpers ─────────────────────────────────────────────────────────────

function format_show_date(iso_date: string): string {
  // "2026-09-12" → "Sep 12". Year omitted when it's the current year;
  // appended when the show is in a future year so the glance carries
  // enough context.
  const d = new Date(`${iso_date}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return iso_date;
  const month = d.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' });
  const day = d.getUTCDate(); // time-guard-ok: rendering a UTC-anchored date-only value (no wall-clock component)
  const yr = d.getUTCFullYear();
  const now_yr = new Date().getUTCFullYear();
  return yr === now_yr ? `${month} ${day}` : `${month} ${day}, ${yr}`;
}

function format_short_datetime(iso: string): string {
  return format_short_date(iso) ?? iso.slice(0, 10);
}

function format_status(status: string): string | null {
  switch (status) {
    case 'available':
      return 'Tickets available';
    case 'low':
      return 'Tickets low';
    case 'unknown':
      return null;
    case 'sold_out':
      return 'Sold out';
    case 'resale_only':
      return 'Resale only';
    default:
      return null;
  }
}

function make_system_ctx(deps: PaneDeps): ToolContext {
  // System-initiated invocation — no specialist, no user attribution.
  // The connector tools the pane invokes are read-only and audit via
  // their own safe_fetch helper, so a stub ctx is sufficient.
  return {
    memory: deps.memory,
    llm: deps.llm,
    now: new Date(),
    intent_id: ulid(),
  };
}

// ── program pane (Mariah) ───────────────────────────────────────────────

/**
 * Mariah's `program` pane — the program-manager office. The thesis
 * Jasper named when requesting this on 2026-05-29: the system SHOULD
 * heal itself as Beatrice + Mariah close systemic gaps; the pane
 * makes that motion visible. "Hits should go up, misses down, in
 * theory, right?" — yes, that's the visual the pane is built to
 * communicate.
 *
 * Reads from `process_misses` (the closed-loop ledger) +
 * `category_signatures` (autonomy graduation state). Pure structured
 * reads, no LLM calls — the pane is for glanceable state; the chat
 * thread (still available below) is where "what does it mean"
 * happens.
 *
 * Blocks, top to bottom:
 *   1. Hero metric — open process_misses count, with delta vs 7d
 *      ago (down_good when fewer, up_bad when more).
 *   2. Load chart bars — misses opened per day, last 14 days.
 *   3. Load chart bars — misses closed per day, last 14 days. Two
 *      single-series charts (not a new dual variant) keeps the
 *      primitives clean; the "closed >= opened week-over-week" story
 *      reads visually when the second bar trends higher.
 *   4. Stacked strip — autonomy posture across signatures
 *      (tier1 / tier2a / tier2b / tier2c / tier3 distribution).
 *      System is "leveling up" when bars shift right over time.
 *   5. List · Top open patterns — open misses grouped by `gap`, top 3.
 *   6. List · Recently closed — last 5 closures (ordered by ts_updated).
 *   7. List · Leverage targets — specialists with the most open
 *      misses, top 3 — these are the "fix this one thing, N misses
 *      close" anchors.
 */
function compose_program_pane(
  db: Database,
  _user_id: string,
  _deps: PaneDeps,
): PaneDocument {
  const blocks: PaneBlock[] = [];

  // ── 1. Hero — open misses count + week-over-week delta ────────────────
  const open_now = (db
    .prepare(`SELECT COUNT(*) AS n FROM process_misses WHERE status != 'closed'`)
    .get() as { n: number } | undefined)?.n ?? 0;
  // "Open 7 days ago" = created on or before (now - 7d) AND
  // (status is still open now OR was closed AFTER that cutoff).
  // Approximation that's cheap + close enough for the trend line.
  const cutoff_iso = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const open_then = (db
    .prepare(
      `SELECT COUNT(*) AS n FROM process_misses
        WHERE ts_created <= @cutoff
          AND (status != 'closed' OR ts_updated > @cutoff)`,
    )
    .get({ '@cutoff': cutoff_iso }) as { n: number } | undefined)?.n ?? 0;
  const delta_n = open_now - open_then;
  const delta_label =
    delta_n === 0 ? 'flat vs last week'
    : delta_n > 0 ? `up ${delta_n} from last week`
    : `down ${-delta_n} from last week`;
  blocks.push({
    type: 'hero_metric',
    value: `${open_now}`,
    label: 'open process misses',
    delta: delta_label,
    // Hits up, misses down: fewer open = good direction.
    delta_kind: delta_n < 0 ? 'down_good' : delta_n > 0 ? 'up_good' : 'neutral',
  });

  // ── 2. + 3. Opened / closed bars over 14 days ─────────────────────────
  const opened_points = load_misses_per_day(db, 'opened');
  const closed_points = load_misses_per_day(db, 'closed');
  blocks.push({
    type: 'load_chart',
    title: 'Misses opened · 14 days',
    points: opened_points,
    kind: 'bars',
    height_hint: 'sm',
  });
  blocks.push({
    type: 'load_chart',
    title: 'Misses closed · 14 days',
    points: closed_points,
    kind: 'bars',
    height_hint: 'sm',
  });

  // ── 4. Autonomy posture across category_signatures ────────────────────
  type AutonomyRow = { autonomy_status: string; n: number };
  const tier_rows = db
    .prepare(
      `SELECT autonomy_status, COUNT(*) AS n
         FROM category_signatures
        GROUP BY autonomy_status`,
    )
    .all() as AutonomyRow[];
  const tier_counts = new Map<string, number>();
  for (const r of tier_rows) tier_counts.set(r.autonomy_status, r.n);
  const tier_order = ['tier1', 'tier2a', 'tier2b', 'tier2c', 'tier3'] as const;
  const tier_labels: Record<(typeof tier_order)[number], string> = {
    tier1: 'T1',
    tier2a: 'T2a',
    tier2b: 'T2b',
    tier2c: 'T2c',
    tier3: 'T3',
  };
  // iOS-side semantic hues — these read left-to-right cool→warm so a
  // graduation shift visually reads as "moving up the gradient."
  const tier_hues: Record<(typeof tier_order)[number], string> = {
    tier1: 'z1',
    tier2a: 'z2',
    tier2b: 'z3',
    tier2c: 'z4',
    tier3: 'z5',
  };
  const segments = tier_order
    .map((t) => ({ label: tier_labels[t], value: tier_counts.get(t) ?? 0, hue: tier_hues[t] }))
    .filter((s) => s.value > 0);
  if (segments.length > 0) {
    blocks.push({
      type: 'stacked_strip',
      title: 'Autonomy posture',
      segments,
    });
  }

  // ── 5. Top open patterns (group by gap) ───────────────────────────────
  type GapRow = { gap: string; n: number };
  const pattern_rows = db
    .prepare(
      `SELECT gap, COUNT(*) AS n
         FROM process_misses
        WHERE status != 'closed'
        GROUP BY gap
        ORDER BY n DESC, gap ASC
        LIMIT 3`,
    )
    .all() as GapRow[];
  blocks.push({
    type: 'list',
    title: 'Top open patterns',
    items: pattern_rows.length > 0
      ? pattern_rows.map((r) => ({
          title: r.gap,
          subtitle: `${r.n} miss${r.n === 1 ? '' : 'es'}`,
        }))
      : [{ title: '—', subtitle: 'No open patterns. The system is calm.' }],
  });

  // ── 6. Recently closed misses ─────────────────────────────────────────
  type ClosedRow = {
    task_summary: string;
    subject_specialist_id: string;
    ts_updated: string;
  };
  const closed_rows = db
    .prepare(
      `SELECT task_summary, subject_specialist_id, ts_updated
         FROM process_misses
        WHERE status = 'closed'
        ORDER BY ts_updated DESC
        LIMIT 5`,
    )
    .all() as ClosedRow[];
  blocks.push({
    type: 'list',
    title: 'Recently closed',
    items: closed_rows.length > 0
      ? closed_rows.map((r) => ({
          title: r.task_summary,
          subtitle: `${r.subject_specialist_id} · closed ${format_short_datetime(r.ts_updated)}`,
        }))
      : [{ title: '—', subtitle: 'Nothing closed yet.' }],
  });

  // ── 7. Leverage targets (most-impacted specialists) ───────────────────
  type LeverageRow = { subject_specialist_id: string; n: number };
  const leverage_rows = db
    .prepare(
      `SELECT subject_specialist_id, COUNT(*) AS n
         FROM process_misses
        WHERE status != 'closed'
        GROUP BY subject_specialist_id
        ORDER BY n DESC, subject_specialist_id ASC
        LIMIT 3`,
    )
    .all() as LeverageRow[];
  blocks.push({
    type: 'list',
    title: 'Leverage targets',
    items: leverage_rows.length > 0
      ? leverage_rows.map((r) => ({
          title: r.subject_specialist_id,
          subtitle: `${r.n} open miss${r.n === 1 ? '' : 'es'} — fix the root cause, close them as a cluster`,
        }))
      : [{ title: '—', subtitle: 'No clusters to target right now.' }],
  });

  // ── 8. Grounding health — the fabrication backstop's fire-rate ────────
  // fact_critic fires when a reply states load-bearing specifics not
  // grounded in the turn's context; a healthy system fires rarely.
  // librarian_lane counts the async fetch-and-verify escalations
  // (HEARTH_ASYNC_LIBRARIAN). Reads the same audit_log the dashboard
  // already mines. A `list` block — an existing PaneBlock type, so iOS
  // renders it with no client change.
  const gh_cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const gh = (sql: string): number =>
    (db.prepare(sql).get({ '@c': gh_cutoff }) as { n: number } | undefined)?.n ?? 0;
  const critic_fires = gh(
    `SELECT COUNT(*) AS n FROM audit_log WHERE tool_name = 'fact_critic' AND ts > @c`,
  );
  // 1b read-failure honesty guard — the demand-side backstop's fire-rate.
  // Same "healthy = fires rarely" reading as fact_critic; a spike here means
  // the guard is over-firing (tune via the ack-regex) OR reads are genuinely
  // failing a lot (a connector regression). Either way Mariah should see it.
  const read_failure_fires = gh(
    `SELECT COUNT(*) AS n FROM audit_log WHERE tool_name = 'read_failure_guard' AND ts > @c`,
  );
  const chat_turns = gh(
    `SELECT COUNT(*) AS n FROM audit_log WHERE tool_name = 'specialist_turn' AND ts > @c`,
  );
  const lane_fires = gh(
    `SELECT COUNT(*) AS n FROM audit_log
       WHERE tool_name = 'fact_critic'
         AND json_extract(execution_result, '$.librarian_lane') = 1 AND ts > @c`,
  );
  const rate_pct = chat_turns > 0 ? ((critic_fires / chat_turns) * 100).toFixed(1) : '0.0';
  blocks.push({
    type: 'list',
    title: 'Grounding health · 24h',
    items: [
      {
        title: `fact_critic fired ${critic_fires}×`,
        subtitle: `${rate_pct}% of ${chat_turns} chat turn${chat_turns === 1 ? '' : 's'} — the fabrication backstop; lower is calmer`,
      },
      {
        title: `read_failure_guard fired ${read_failure_fires}×`,
        subtitle: `${
          chat_turns > 0 ? ((read_failure_fires / chat_turns) * 100).toFixed(1) : '0.0'
        }% of turns — caught a reply answering over an unrecovered read; a spike = over-firing or a flaky connector`,
      },
      {
        title: `librarian lane: ${lane_fires} verification${lane_fires === 1 ? '' : 's'}`,
        subtitle:
          lane_fires > 0
            ? 'async fetch-and-verify escalations on the A4000'
            : 'no async-verify escalations (lane off or unneeded)',
      },
    ],
  });

  return {
    pane_kind: 'program',
    title: 'Program',
    subtitle: 'Hits up, misses down',
    blocks,
    generated_at: new Date().toISOString(),
  };
}

/**
 * Build the 14-day daily count of misses by their ts_created (opened)
 * or ts_updated (closed) date. Returns points in chronological order
 * left-to-right, with 0-filled gaps so the bar chart shows the full
 * 14-day surface even when a day has no activity.
 */
function load_misses_per_day(
  db: Database,
  kind: 'opened' | 'closed',
): Array<{ x: string; y: number; label?: string }> {
  const since_iso = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();
  const filter = kind === 'opened'
    ? `ts_created >= @since`
    : `status = 'closed' AND ts_updated >= @since`;
  const ts_col = kind === 'opened' ? 'ts_created' : 'ts_updated';
  type Row = { day: string; n: number };
  const rows = db
    .prepare(
      `SELECT substr(${ts_col}, 1, 10) AS day, COUNT(*) AS n
         FROM process_misses
        WHERE ${filter}
        GROUP BY day
        ORDER BY day ASC`,
    )
    .all({ '@since': since_iso }) as Row[];
  const map = new Map<string, number>();
  for (const r of rows) map.set(r.day, r.n);
  // 0-fill the 14-day window so the chart's x-axis is continuous.
  const out: Array<{ x: string; y: number; label?: string }> = [];
  const today_ms = Date.now();
  for (let i = 13; i >= 0; i--) {
    const d = new Date(today_ms - i * 24 * 60 * 60 * 1000);
    const day = local_iso_date(d);
    out.push({ x: day, y: map.get(day) ?? 0 });
  }
  return out;
}

// ── civic pane (Ruby) ───────────────────────────────────────────────────

/** interest_score at/above which a civic item is "at a glance"; below it
 *  the item drops to the scrollable "Also watching" outskirts. */
const CIVIC_GLANCE_THRESHOLD = 0.5;

/**
 * Ruby's `civic` pane — Pleasantville city desk. At-a-glance up top, the
 * outskirts scrollable below (the user's exact ask):
 *
 *   1. Hero — next City Council meeting (nearest future, dated) + countdown.
 *   2. List · On the agenda — high-interest agenda items.
 *   3. List · New in town — restaurants / stores / events.
 *   4. List · Your corridors — traffic / construction on Jasper's learned
 *      routes (corridor-matched items sort first).
 *   5. List · From FCGOV — big city announcements.
 *   6. List · Also watching — the outskirts: low-interest items + anything
 *      Ruby flagged as 'watching'.
 *
 * Pure structured reads from `civic_items` (via MemoryClient) — Ruby's
 * deliberation populates it through `record_civic_item`. No LLM, no
 * external HTTP at view time; the office stays glance-cheap.
 */
function compose_civic_pane(
  _db: Database,
  user_id: string,
  deps: PaneDeps,
): PaneDocument {
  const now_iso = new Date().toISOString();
  // Drop dated items whose moment has passed (a council meeting that
  // already happened, an agenda item from last week) so the office
  // self-cleans on read — no stale "next meeting" lingering.
  const active = deps.memory
    .list_civic_items(user_id)
    .filter((i) => i.status === 'active')
    .filter(
      (i) =>
        !(
          i.event_at &&
          i.event_at < now_iso &&
          (i.kind === 'council_meeting' || i.kind === 'agenda_item')
        ),
    );
  const blocks: PaneBlock[] = [];

  // 1. Hero — next council meeting.
  const next_meeting = active
    .filter((i) => i.kind === 'council_meeting' && i.event_at && i.event_at >= now_iso)
    .sort((a, b) => ((a.event_at ?? '') < (b.event_at ?? '') ? -1 : 1))[0];
  if (next_meeting?.event_at) {
    blocks.push({
      type: 'hero_metric',
      value: format_short_datetime(next_meeting.event_at),
      label: 'next city council meeting',
      delta: relative_until(next_meeting.event_at),
      delta_kind: 'neutral',
    });
  } else {
    blocks.push({
      type: 'hero_metric',
      value: '—',
      label: 'no council meeting on the calendar yet',
      delta_kind: 'neutral',
    });
  }

  const glance = (kind: CivicItemRow['kind']): CivicItemRow[] =>
    active
      .filter((i) => i.kind === kind && i.interest_score >= CIVIC_GLANCE_THRESHOLD)
      .sort(civic_sort)
      .slice(0, 5);

  // ── Pleasantville tab — the whole pre-promotion City Desk ────────────────
  const fc_blocks: PaneBlock[] = [];

  // The fights the household is actually working, and the stories still
  // moving. Both are DERIVED sets — a campaign leaves when it's decided, a
  // story leaves when it stops moving — so this section shrinks on its own
  // and never becomes a museum of old crusades (2026-07-28).
  const campaigns = deps.memory.list_civic_campaigns(user_id, { active_only: true }).slice(0, 5);
  fc_blocks.push({
    type: 'list',
    title: 'Campaigns',
    items:
      campaigns.length > 0
        ? campaigns.map((c) => {
            const bits: string[] = [];
            if (c.status !== 'active') bits.push(c.status);
            if (c.next_milestone) {
              bits.push(
                c.next_milestone_at
                  ? `${c.next_milestone} · ${format_short_datetime(c.next_milestone_at)}`
                  : c.next_milestone,
              );
            }
            const targets = campaign_list_field(c.targets);
            if (targets.length > 0) bits.push(targets.slice(0, 3).join(', '));
            const running = campaign_list_field(c.investigation_ids).length;
            if (running > 0) bits.push(`${running} investigation${running === 1 ? '' : 's'}`);
            const detail = [c.stake_md, c.position_md, c.talking_points_md]
              .filter(Boolean)
              .join('\n\n');
            return {
              title: c.title,
              subtitle: bits.join(' · ').slice(0, 160) || undefined,
              ...(detail ? { detail_md: detail } : {}),
            };
          })
        : [{ title: '—', subtitle: 'Nothing being worked right now — a campaign opens when a fight is still winnable and someone reachable decides it.' }],
  });

  // The board. Liveness is computed from each story's timeline, so a fight
  // that ended or went quiet is simply absent — nothing sweeps it.
  const watch_board = summarize_watch_topics(
    deps.memory.list_watch_events(user_id) as unknown as WatchEventLike[],
    now_iso,
  );
  const following = watch_board.filter((t) => t.active).slice(0, 8);
  fc_blocks.push({
    type: 'list',
    title: 'Following',
    items:
      following.length > 0
        ? following.map((t) => {
            const bits: string[] = [];
            bits.push(
              t.days_quiet === 0
                ? 'moved today'
                : t.days_quiet === 1
                  ? 'moved yesterday'
                  : `${t.days_quiet}d since it moved`,
            );
            if (t.status === 'going_quiet') bits.push('going quiet');
            bits.push(`${t.event_count} development${t.event_count === 1 ? '' : 's'}`);
            if (t.latest_headline) bits.push(t.latest_headline);
            return {
              title: t.topic,
              subtitle: bits.join(' · ').slice(0, 160),
              ...(t.why_tracked ? { detail_md: `**Why this is tracked** — ${t.why_tracked}` } : {}),
              ...(t.latest_source_url ? { deep_link: t.latest_source_url } : {}),
            };
          })
        : [{ title: '—', subtitle: 'No stories moving right now. Ones that resolved or went quiet stay queryable in the ledger.' }],
  });

  fc_blocks.push(civic_block('On the agenda', glance('agenda_item'), 'Nothing hot on the next agenda yet.'));
  fc_blocks.push(civic_block('New in town', glance('new_in_town'), 'No new spots or events flagged yet.'));
  fc_blocks.push(civic_block('Your corridors', glance('corridor_alert'), 'No traffic or construction on your routes.'));
  fc_blocks.push(civic_block('From FCGOV', glance('announcement'), 'No big city announcements lately.'));

  // The desk's own store (receipts ledger + the state/national/world
  // items). A store hiccup degrades to the FC-only office, never a broken
  // pane.
  let civic_store: RubyCivicStore | null = null;
  try {
    civic_store = get_ruby_civic_store();
  } catch {
    civic_store = null;
  }

  // The receipts ledger (2026-06-10): per-member coverage from the voting
  // record + the money-and-interests store, and the conflict flags worth a
  // glance. Pure store reads.
  let conflict_flags_block: PaneBlock | null = null;
  let has_open_flags = false;
  try {
    if (!civic_store) throw new Error('store unavailable');
    const members = deps.memory.list_civic_members(user_id, false);
    const vote_counts = new Map<string, number>();
    for (const v of deps.memory.list_civic_votes(user_id)) {
      const k = civic_slug(v.member_name);
      vote_counts.set(k, (vote_counts.get(k) ?? 0) + 1);
    }
    const donations = new Map(civic_store.donations_by_recipient().map((d) => [d.recipient_slug, d]));
    const interests = new Map(civic_store.interests_by_member().map((i) => [i.member_slug, i.n]));
    const open_conflicts = new Map(civic_store.conflicts_by_member().map((c) => [c.member_slug, c.n]));

    const ledger_items = members.slice(0, 8).map((m) => {
      const slug = civic_slug(m.name);
      const d = donations.get(slug);
      const bits = [
        `${vote_counts.get(slug) ?? 0} votes on record`,
        d ? `$${Math.round(d.total_usd).toLocaleString('en-US')} from ${d.donors} donor${d.donors === 1 ? '' : 's'}` : 'no finance data',
      ];
      const ints = interests.get(slug) ?? 0;
      if (ints > 0) bits.push(`${ints} interest${ints === 1 ? '' : 's'}`);
      const flags_n = open_conflicts.get(slug) ?? 0;
      if (flags_n > 0) bits.push(`${flags_n} flag${flags_n === 1 ? '' : 's'} open`);
      return {
        title: m.role ? `${m.name} — ${m.role}` : m.name,
        subtitle: bits.join(' · ').slice(0, 160),
      };
    });
    fc_blocks.push({
      type: 'list',
      title: 'Council ledger',
      items: ledger_items.length > 0
        ? ledger_items
        : [{ title: '—', subtitle: 'No roster yet — the ledger builds itself from minutes (votes) and filings (money).' }],
    });

    const flags = civic_store
      .list_conflicts({ limit: 20 })
      .filter((f) => f.status !== 'cleared')
      .slice(0, 5);
    has_open_flags = flags.length > 0;
    conflict_flags_block = {
      type: 'list',
      title: 'Money & conflicts watch',
      items: has_open_flags
        ? flags.map((f) => ({
            title: `${f.member} ↔ ${f.counterparty}`,
            subtitle: [
              f.severity,
              f.status,
              f.basis === 'donation' && f.amount_usd ? `$${Math.round(f.amount_usd).toLocaleString('en-US')}` : f.basis,
              `${f.vote ? `voted ${f.vote} on ` : ''}${f.item_title}`,
            ]
              .filter(Boolean)
              .join(' · ')
              .slice(0, 160),
          }))
        : [{ title: '—', subtitle: 'No conflicts flagged — the weekly scan cross-references donors and interests against the voting record.' }],
    };
    fc_blocks.push(conflict_flags_block);
  } catch {
    /* the FC tab renders without the ledger rather than failing */
  }

  // Outskirts — explicit 'watching' items + anything below the glance bar
  // (the council meeting is already the hero, so exclude it).
  const outskirts = active
    .filter(
      (i) =>
        i.kind !== 'council_meeting' &&
        (i.kind === 'watching' || i.interest_score < CIVIC_GLANCE_THRESHOLD),
    )
    .sort(civic_sort)
    .slice(0, 10);
  fc_blocks.push(civic_block('Also watching', outskirts, 'Nothing on the outskirts right now.'));

  // ── The promotion (2026-06-10 #2): Colorado / Nation & World tabs + The
  // Brief rollup. Items come from the scoped politics_items ledger; each
  // carries Ruby's take_md as a tap-to-expand detail (the Kristi
  // assessments pattern) so the office leads with her grounded read, not a
  // bare headline.
  const SCOPE_TAG: Record<PoliticsItemRow['scope'], string> = {
    state: 'CO', national: 'US', world: 'World',
  };
  const politics_li = (p: PoliticsItemRow, tag_scope: boolean) => {
    const bits: string[] = [];
    if (p.kind !== 'event' && p.kind !== 'watching') bits.push(p.kind);
    if (p.event_at) bits.push(p.event_at.slice(0, 10));
    if (p.summary) bits.push(p.summary);
    if (p.source) bits.push(p.source);
    return {
      title: tag_scope ? `${SCOPE_TAG[p.scope]} · ${p.title}` : p.title,
      subtitle: bits.join(' · ').slice(0, 160) || undefined,
      ...(p.url ? { deep_link: p.url } : {}),
      ...(p.take_md
        ? { detail_md: `**Ruby's take** — ${p.take_md}${p.url ? `\n\n_Source: ${p.url}_` : ''}` }
        : {}),
    };
  };
  const politics_list = (title: string, items: PoliticsItemRow[], empty_msg: string): PaneBlock => ({
    type: 'list',
    title,
    items: items.length > 0
      ? items.map((p) => politics_li(p, false))
      : [{ title: '—', subtitle: empty_msg }],
  });

  const brief_blocks: PaneBlock[] = [];
  const state_blocks: PaneBlock[] = [];
  const world_blocks: PaneBlock[] = [];
  let badge_state = 0;
  let badge_world = 0;
  try {
    if (!civic_store) throw new Error('store unavailable');
    const counts = civic_store.politics_counts_by_scope();
    badge_state = counts.state;
    badge_world = counts.national + counts.world;

    state_blocks.push(
      politics_list(
        'Colorado desk',
        civic_store.list_politics_items({ scope: 'state', limit: 12 }),
        'Nothing tracked at the state level yet — bills, rulings, and races land here as Ruby reads.',
      ),
    );
    world_blocks.push(
      politics_list(
        'Nation',
        civic_store.list_politics_items({ scope: 'national', limit: 10 }),
        'Nothing tracked nationally yet.',
      ),
    );
    world_blocks.push(
      politics_list(
        'World',
        civic_store.list_politics_items({ scope: 'world', limit: 10 }),
        'Nothing tracked internationally yet.',
      ),
    );

    // The Brief — the rollup tab: the highest-interest items across every
    // altitude, scope-tagged, takes tap-to-expand; FC's hottest agenda /
    // announcement items ride along so the rollup really is ALL of it.
    const pol_top = civic_store.list_politics_items({ limit: 12 });
    const fc_top = active
      .filter((i) => (i.kind === 'agenda_item' || i.kind === 'announcement') && i.interest_score >= CIVIC_GLANCE_THRESHOLD)
      .sort(civic_sort)
      .slice(0, 4);
    const merged = [
      ...pol_top.map((p) => ({ score: p.interest_score, li: politics_li(p, true) })),
      ...fc_top.map((i) => ({
        score: i.interest_score,
        li: {
          title: `FC · ${i.title}`,
          subtitle: (i.summary ?? '').slice(0, 160) || undefined,
          ...(i.url ? { deep_link: i.url } : {}),
        },
      })),
    ]
      .sort((a, b) => b.score - a.score)
      .slice(0, 8)
      .map((m) => m.li);
    brief_blocks.push({
      type: 'list',
      title: "Ruby's brief",
      items: merged.length > 0
        ? merged
        : [{ title: '—', subtitle: 'The desk is warming up — takes land here as Ruby reads the day.' }],
    });
    // Receipts ride the rollup only when there's actually something open.
    if (conflict_flags_block && has_open_flags) brief_blocks.push(conflict_flags_block);
  } catch {
    brief_blocks.push({
      type: 'list',
      title: "Ruby's brief",
      items: [{ title: '—', subtitle: 'The politics ledger is unavailable right now — the Pleasantville tab still has the local desk.' }],
    });
  }

  blocks.push({
    type: 'tabs',
    tabs: [
      { id: 'brief', label: 'The Brief', blocks: brief_blocks },
      { id: 'fc', label: 'Pleasantville', blocks: fc_blocks },
      { id: 'state', label: 'Colorado', ...(badge_state > 0 ? { badge: badge_state } : {}), blocks: state_blocks },
      { id: 'world', label: 'Nation & World', ...(badge_world > 0 ? { badge: badge_world } : {}), blocks: world_blocks },
    ],
  });

  return {
    pane_kind: 'civic',
    title: 'Politics Desk',
    subtitle: 'Pleasantville → Colorado → the nation & world',
    blocks,
    generated_at: new Date().toISOString(),
  };
}

function civic_sort(a: CivicItemRow, b: CivicItemRow): number {
  // Corridor-matched first, then interest, then most-recently updated.
  const am = a.corridor_match ? 1 : 0;
  const bm = b.corridor_match ? 1 : 0;
  if (am !== bm) return bm - am;
  if (b.interest_score !== a.interest_score) return b.interest_score - a.interest_score;
  return a.ts_updated < b.ts_updated ? 1 : -1;
}

function civic_block(title: string, items: CivicItemRow[], empty_msg: string): PaneBlock {
  if (items.length === 0) {
    return { type: 'list', title, items: [{ title: '—', subtitle: empty_msg }] };
  }
  // "New since you last looked" proxy: items Ruby recorded in the last
  // 24h get a leading marker so the genuinely-fresh stuff announces
  // itself. A 24h recency window sidesteps the visit-timestamp timing
  // (the pane is fetched on the same visit that would update it).
  const fresh_cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  return {
    type: 'list',
    title,
    items: items.map((i) => {
      const bits: string[] = [];
      if (i.event_at) bits.push(format_short_datetime(i.event_at));
      if (i.corridor_match) bits.push(`on ${i.corridor_match}`);
      if (i.summary) bits.push(i.summary);
      const subtitle = bits.filter(Boolean).join(' · ').slice(0, 160);
      const is_new = i.ts_created > fresh_cutoff;
      return {
        title: is_new ? `• ${i.title}` : i.title,
        ...(subtitle ? { subtitle } : {}),
        ...(i.url ? { deep_link: i.url } : {}),
      };
    }),
  };
}

/** Coarse "in N days" countdown for the council-meeting hero delta. */
function relative_until(iso: string): string {
  const ms = new Date(iso).getTime() - Date.now();
  if (Number.isNaN(ms)) return '';
  const days = Math.round(ms / (24 * 60 * 60 * 1000));
  if (days <= 0) return 'today';
  if (days === 1) return 'tomorrow';
  if (days < 14) return `in ${days} days`;
  return `in ${Math.round(days / 7)} weeks`;
}

// ── fuel pane (Vivian) ──────────────────────────────────────────────────

/**
 * Vivian's `fuel` pane — Jasper's personal finances at a glance. Vivian
 * stays the fiduciary she's designed to be; this office surfaces HER work,
 * not speculative trades:
 *
 *   1. Hero — month-to-date *tracked* spend (from photographed receipts;
 *      "tracked" because there's no Plaid yet — it's what Cordelia routed
 *      to Vivian, not a bank-complete total) + delta vs last month.
 *   2. List · Recent receipts.
 *   3. Hero — portfolio total + holding count (from the
 *      Knowledge/Finance/holdings.md snapshot Jasper maintains).
 *   4. List · Concentration — single positions over 5% of the portfolio,
 *      computed locally (pure math, exactly as Vivian's persona frames it).
 *
 * Reads are self-contained (receipt markdown + the holdings snapshot); no
 * external HTTP at view time. Macro frame (FRED), expense-ratio audit, and
 * subscription-drift surfacing remain chat-time / deliberation work for now
 * — see PLAN.md.
 */
async function compose_fuel_pane(
  db: Database,
  _user_id: string,
  deps: PaneDeps,
): Promise<PaneDocument> {
  const blocks: PaneBlock[] = [];

  // 1. Hero — month-to-date tracked spend.
  const receipts = read_receipts(deps.vault_root);
  const month_prefix = local_iso_date().slice(0, 7); // YYYY-MM (local)
  const prev_prefix = prev_month_prefix(month_prefix);
  const mtd_total = sum_totals(receipts.filter((r) => (r.date ?? '').startsWith(month_prefix)));
  const prev_total = sum_totals(receipts.filter((r) => (r.date ?? '').startsWith(prev_prefix)));
  const delta = mtd_total - prev_total;
  blocks.push({
    type: 'hero_metric',
    value: usd(mtd_total),
    label: 'tracked spend this month',
    delta:
      prev_total > 0
        ? `${delta >= 0 ? '+' : '−'}${usd(Math.abs(delta))} vs last month`
        : 'first month tracked',
    // For spend, less is the good direction.
    delta_kind: 'down_good',
  });

  // 2. Spend trend — last 14 days of tracked daily spend (glanceable).
  const spend_points = daily_spend_points(receipts, 14);
  if (spend_points.some((p) => p.y > 0)) {
    blocks.push({
      type: 'load_chart',
      title: 'Tracked spend · 14 days',
      points: spend_points,
      kind: 'bars',
      height_hint: 'sm',
    });
  }

  // 3. Macro frame — Vivian's one-line read (FRED). Degrades silently
  //    when FRED isn't configured / unreachable (no empty row).
  const macro = await load_macro_frame(deps);
  if (macro.length) {
    blocks.push({ type: 'list', title: 'Macro', items: macro });
  }

  // 4. Recent receipts.
  const recent = receipts
    .filter((r) => r.date)
    .sort((a, b) => ((a.date ?? '') < (b.date ?? '') ? 1 : -1))
    .slice(0, 6);
  blocks.push({
    type: 'list',
    title: 'Recent receipts',
    items: recent.length
      ? recent.map((r) => ({
          title: r.store || 'Receipt',
          subtitle: `${r.total != null ? usd(r.total) : '—'} · ${r.date}`,
        }))
      : [{ title: '—', subtitle: 'No receipts captured yet — snap one and Cordelia routes it to Vivian.' }],
  });

  // 5–7. Portfolio from the holdings snapshot.
  const holdings = read_holdings(deps.vault_root);
  if (holdings && holdings.length) {
    const total = holdings.reduce((a, h) => a + h.market_value, 0);
    blocks.push({
      type: 'hero_metric',
      value: usd(total),
      label: `portfolio · ${holdings.length} holding${holdings.length === 1 ? '' : 's'}`,
      delta_kind: 'neutral',
    });
    const concentrated = holdings
      .map((h) => ({ ...h, pct: total > 0 ? h.market_value / total : 0 }))
      .filter((h) => h.pct > 0.05)
      .sort((a, b) => b.pct - a.pct)
      .slice(0, 6);
    blocks.push({
      type: 'list',
      title: 'Concentration · positions over 5%',
      items: concentrated.length
        ? concentrated.map((h) => ({
            title: h.symbol,
            subtitle: `${(h.pct * 100).toFixed(1)}% of portfolio · ${usd(h.market_value)}`,
          }))
        : [{ title: '—', subtitle: 'No single position over 5%. Well diversified.' }],
    });
    // Expense-ratio audit — Vivian's highest-Sharpe operational catch.
    const er = await load_expense_ratio_flags(deps, holdings);
    if (er.length) {
      blocks.push({ type: 'list', title: 'Expense ratios worth a look', items: er });
    }
  } else {
    blocks.push({
      type: 'list',
      title: 'Portfolio',
      items: [
        {
          title: '—',
          subtitle:
            'Add Knowledge/Finance/holdings.md (holdings: symbol · market_value · asset_class) to see portfolio health.',
        },
      ],
    });
  }

  // 8. Subscription drift — only when the maintained snapshot exists +
  //    something actually drifted up (no clutter otherwise).
  const subs = read_subscription_drift(deps.vault_root);
  if (subs.length) {
    blocks.push({ type: 'list', title: 'Subscription drift', items: subs });
  }

  // TABBED via the server `tabs` primitive (the Cordelia Brain pattern):
  // Finances | Market Radar. The Radar tab is a SERVER-composed summary of
  // the latest theme-momentum run, so it renders on iOS/macOS natively; the
  // web UNWRAPS the primitive and shows its richer themed-grid canvas (app.js).
  // Owner-only. No snapshot run yet → null → flat fuel pane (pre-Radar shape).
  const radar_tab = deps.viewer_is_owner ? compose_market_radar_tab(db) : null;
  const final_blocks: PaneBlock[] = radar_tab
    ? [
        {
          type: 'tabs',
          tabs: [
            { id: 'fuel', label: 'Finances', blocks },
            radar_tab,
          ],
        },
      ]
    : blocks;

  return {
    pane_kind: 'fuel',
    title: 'Finances',
    subtitle: 'Your money at a glance',
    blocks: final_blocks,
    generated_at: new Date().toISOString(),
  };
}

/** Last `days` of tracked daily spend, 0-filled, for the fuel sparkline. */
function daily_spend_points(
  receipts: ReceiptRow[],
  days: number,
): Array<{ x: string; y: number }> {
  const map = new Map<string, number>();
  for (const r of receipts) {
    if (!r.date || r.total == null) continue;
    const day = r.date.slice(0, 10);
    map.set(day, (map.get(day) ?? 0) + r.total);
  }
  const out: Array<{ x: string; y: number }> = [];
  const today_ms = Date.now();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today_ms - i * 24 * 60 * 60 * 1000);
    const day = local_iso_date(d);
    out.push({ x: day, y: Math.round(map.get(day) ?? 0) });
  }
  return out;
}

/** FRED macro one-liner (10-yr Treasury + unemployment), most-recent
 *  value with a tiny delta arrow. Best-effort; empty on any failure. */
async function load_macro_frame(
  deps: PaneDeps,
): Promise<Array<{ title: string; subtitle?: string }>> {
  const tool = deps.tool_registry.get('fred_observations');
  if (!tool) return [];
  const ctx = make_system_ctx(deps);
  const series = [
    { id: 'DGS10', label: '10-yr Treasury', unit: '%' },
    { id: 'UNRATE', label: 'Unemployment', unit: '%' },
  ];
  type Obs = { observations: Array<{ date: string; value: number | null }>; error?: string };
  const out: Array<{ title: string; subtitle?: string }> = [];
  for (const s of series) {
    try {
      const res = (await tool.execute({ series_id: s.id, limit: 2 }, ctx)) as Obs;
      if (res.error) continue;
      const obs = res.observations.filter((o) => o.value != null);
      if (obs.length === 0) continue;
      const latest = obs[0]!;
      const prior = obs[1];
      let sub = `${latest.value}${s.unit} · ${latest.date}`;
      if (prior && prior.value != null) {
        const d = latest.value! - prior.value;
        const arrow = d > 0 ? '▲' : d < 0 ? '▼' : '→';
        sub = `${latest.value}${s.unit} ${arrow}${Math.abs(d).toFixed(2)} · ${latest.date}`;
      }
      out.push({ title: s.label, subtitle: sub });
    } catch {
      continue;
    }
  }
  return out;
}

/** Expense-ratio audit flags via the audit_expense_ratios tool. Best-
 *  effort; empty on failure or when nothing's flagged. */
async function load_expense_ratio_flags(
  deps: PaneDeps,
  holdings: Holding[],
): Promise<Array<{ title: string; subtitle?: string }>> {
  const tool = deps.tool_registry.get('audit_expense_ratios');
  if (!tool) return [];
  const ctx = make_system_ctx(deps);
  type Finding = {
    symbol: string;
    flagged: boolean;
    current_er_bp: number | null;
    suggested_swap: string | null;
    annual_fee_drag_dollars: number | null;
    compounded_savings_dollars: number | null;
  };
  type ER = { findings?: Finding[]; error?: string };
  try {
    const res = (await tool.execute(
      {
        holdings: holdings.map((h) => ({
          symbol: h.symbol,
          market_value: h.market_value,
          asset_class: h.asset_class,
        })),
      },
      ctx,
    )) as ER;
    if (res.error || !res.findings) return [];
    return res.findings
      .filter((f) => f.flagged)
      .slice(0, 5)
      .map((f) => {
        const bits: string[] = [];
        if (f.current_er_bp != null) bits.push(`${(f.current_er_bp / 100).toFixed(2)}% ER`);
        if (f.annual_fee_drag_dollars != null) bits.push(`${usd(f.annual_fee_drag_dollars)}/yr drag`);
        if (f.compounded_savings_dollars != null) bits.push(`~${usd(f.compounded_savings_dollars)} saved/30y`);
        if (f.suggested_swap) bits.push(`→ ${f.suggested_swap}`);
        return { title: f.symbol, subtitle: bits.join(' · ') || undefined };
      });
  } catch {
    return [];
  }
}

/** Subscriptions that went up, from a Jasper-maintained
 *  Knowledge/Finance/subscriptions.md (frontmatter `subscriptions:` list
 *  of {name, amount, prev_amount?}). Empty when the file is absent or
 *  nothing drifted up. */
function read_subscription_drift(
  vault_root: string,
): Array<{ title: string; subtitle?: string }> {
  const abs = resolve(vault_root, 'Knowledge/Finance/subscriptions.md');
  if (!existsSync(abs)) return [];
  try {
    const raw = (matter(readFileSync(abs, 'utf8')).data as Record<string, unknown>).subscriptions;
    if (!Array.isArray(raw)) return [];
    const out: Array<{ title: string; subtitle?: string }> = [];
    for (const s of raw) {
      if (!s || typeof s !== 'object') continue;
      const r = s as Record<string, unknown>;
      const name = typeof r.name === 'string' ? r.name : null;
      const amount = typeof r.amount === 'number' ? r.amount : null;
      const prev = typeof r.prev_amount === 'number' ? r.prev_amount : null;
      if (!name || amount == null || prev == null || amount <= prev) continue;
      const pct = prev > 0 ? ((amount - prev) / prev) * 100 : 0;
      out.push({
        title: name,
        subtitle: `$${prev.toFixed(2)} → $${amount.toFixed(2)}${pct ? ` (+${pct.toFixed(0)}%)` : ''}`,
      });
    }
    return out;
  } catch {
    return [];
  }
}

interface ReceiptRow {
  store: string;
  total: number | null;
  date: string | null;
  currency: string | null;
}

function safe_readdir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/** Read photographed-receipt notes under Knowledge/Vivian/receipts/<date>/<store>.md. */
function read_receipts(vault_root: string): ReceiptRow[] {
  const root = resolve(vault_root, 'Knowledge/Vivian/receipts');
  if (!existsSync(root)) return [];
  const out: ReceiptRow[] = [];
  for (const date_dir of safe_readdir(root)) {
    const dir_abs = resolve(root, date_dir);
    for (const f of safe_readdir(dir_abs)) {
      if (!f.endsWith('.md')) continue;
      try {
        const fm = matter(readFileSync(resolve(dir_abs, f), 'utf8')).data as Record<string, unknown>;
        if (fm.type !== 'receipt') continue;
        // gray-matter may coerce an unquoted ISO date to a Date — handle both.
        const td = fm.transaction_date;
        const date =
          typeof td === 'string'
            ? td
            : td instanceof Date
              ? td.toISOString().slice(0, 10) // time-guard-ok: coerce a gray-matter Date back to its YYYY-MM-DD frontmatter form
              : date_dir; // the folder name is the filing date — sound fallback
        out.push({
          store: typeof fm.store === 'string' ? fm.store : 'Receipt',
          total: typeof fm.total === 'number' ? fm.total : null,
          date,
          currency: typeof fm.currency === 'string' ? fm.currency : null,
        });
      } catch {
        continue;
      }
    }
  }
  return out;
}

interface Holding {
  symbol: string;
  market_value: number;
  asset_class: string;
  sector?: string;
}

/** Read the holdings snapshot Jasper maintains (frontmatter `holdings:` list). */
function read_holdings(vault_root: string): Holding[] | null {
  const abs = resolve(vault_root, 'Knowledge/Finance/holdings.md');
  if (!existsSync(abs)) return null;
  try {
    const raw = (matter(readFileSync(abs, 'utf8')).data as Record<string, unknown>).holdings;
    if (!Array.isArray(raw)) return null;
    const out: Holding[] = [];
    for (const h of raw) {
      if (!h || typeof h !== 'object') continue;
      const r = h as Record<string, unknown>;
      const symbol = typeof r.symbol === 'string' ? r.symbol : null;
      const mv = typeof r.market_value === 'number' ? r.market_value : null;
      if (!symbol || mv == null) continue;
      out.push({
        symbol,
        market_value: mv,
        asset_class: typeof r.asset_class === 'string' ? r.asset_class : 'other',
        ...(typeof r.sector === 'string' ? { sector: r.sector } : {}),
      });
    }
    return out;
  } catch {
    return null;
  }
}

function sum_totals(rows: ReceiptRow[]): number {
  return rows.reduce((a, r) => a + (r.total ?? 0), 0);
}

function usd(n: number): string {
  return `$${Math.round(n).toLocaleString('en-US')}`;
}

/** Previous YYYY-MM given a YYYY-MM prefix. Pure arithmetic on the prefix. */
function prev_month_prefix(ym: string): string {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(Date.UTC(y ?? 1970, (m ?? 1) - 2, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

// ── competitive pane (Kristi) ───────────────────────────────────────────

/**
 * Kristi's `competitive` pane — the Recon Desk. Pure structured reads from
 * the `kristi_workstations` store (no LLM, no HTTP at view time), so the room
 * stays glance-cheap. Ten sections:
 *
 *   1. Hero — unmatched cert-registry leaks (the pre-launch radar count).
 *   2. List · Leak radar — the actual unidentified certified model-strings.
 *   3. List · HP Z leads — specs where HP's best beats the best rival.
 *   4. List · HP Z gaps — specs where a rival leads HP.
 *   5. List · Swimlanes — capability-envelope clusters (cross-OEM equivalents).
 *   6. List · Latest moves — newest leaked/announced SKUs.
 *   7. List · Threat & disruptor radar — workstation-adjacent threats + new players.
 *   8. List · Commodity price spread — per-OEM component pricing.
 *   9. List · Projected next gen — clearly-labeled next-gen inferences.
 *  10. List · ISV / GeForce watch — recent ISV certs, flagging GeForce mentions.
 *
 * Soft empty-state until her first scans + deliberation passes fill the
 * store — by design.
 */
// Clean display name for a SKU. model_name already carries the brand
// ("Dell Pro Precision 9 T4", "NVIDIA DGX Spark", "workstation-class machine"), so
// prepending vendor.toUpperCase() doubled it ("DELL Dell …", "NVIDIA NVIDIA …").
// Show the model name as-is when it's already brand-prefixed; otherwise prepend
// a properly-cased brand label (not ALLCAPS).
const _VENDOR_LABEL: Record<string, string> = { hp: 'HP', dell: 'Dell', lenovo: 'Lenovo', nvidia: 'NVIDIA' };
function display_model(vendor: string, model_name: string): string {
  const mn = (model_name || '').trim();
  if (/^(hp|dell|lenovo|nvidia)\b/i.test(mn)) return mn; // already brand-prefixed
  const lbl = _VENDOR_LABEL[(vendor || '').toLowerCase()] || (vendor ? vendor.toUpperCase() : '');
  return lbl ? `${lbl} ${mn}` : mn;
}

/** Format a gap-view metric value WITH its unit so a bare number is never
 *  ambiguous ("3072 GB", "1700 W", "8 GPUs"). The unit comes from the metric
 *  label — a parenthetical (e.g. "Max memory (GB)" → GB, "PSU (W)" → W) or the
 *  trailing quantity noun for the unitless counts. */
function gap_value(metric: string, value: number | null): string {
  if (value == null) return '—';
  const paren = metric.match(/\(([^)]+)\)/);
  let unit = paren?.[1] ?? '';
  if (!unit) {
    if (/cores/i.test(metric)) unit = 'cores';
    else if (/threads/i.test(metric)) unit = 'threads';
    else if (/gpus/i.test(metric)) unit = 'GPUs';
    else if (/lanes/i.test(metric)) unit = 'lanes';
    else if (/sockets/i.test(metric)) unit = 'sockets';
  }
  return unit ? `${value.toLocaleString()} ${unit}` : value.toLocaleString();
}

/** Render a lane's persona / ICP / UCP profiles as the "Who it's for" tap-down,
 *  appended under the swimlane's assessment in its `detail_md`. Grouped by kind,
 *  terse; a UCP shows its disqualifier + redirect. Empty string when the lane
 *  has no derived profiles yet (so the assessment stands alone during backfill). */
function swimlane_profiles_md(rows: SwimlaneProfileRow[]): string {
  if (!rows || rows.length === 0) return '';
  const conf = (c: string): string => (c && c !== 'medium' ? ` _(${c} confidence)_` : '');
  const personas = rows.filter((r) => r.profile_kind === 'persona');
  const icps = rows.filter((r) => r.profile_kind === 'icp');
  const ucps = rows.filter((r) => r.profile_kind === 'ucp');
  const out: string[] = ["\n\n---\n\n### Who it's for"];
  if (personas.length) {
    out.push('\n**Personas**');
    for (const p of personas) {
      const tags = [p.segment, p.geforce_vs_pro, p.best_fit_by_oem].filter(Boolean).join(' · ');
      out.push(`- **${p.title}** — ${p.body_md}${tags ? `\n  _${tags}_` : ''}${conf(p.confidence)}`);
    }
  }
  if (icps.length) {
    out.push('\n**Ideal customer (ICP)**');
    for (const p of icps) {
      out.push(`- **${p.title}** — ${p.body_md}${p.segment ? `\n  _${p.segment}_` : ''}${conf(p.confidence)}`);
    }
  }
  if (ucps.length) {
    out.push('\n**Unideal customer (UCP)**');
    for (const p of ucps) {
      const redirect = p.redirect_swimlane
        ? ` → belongs in **${p.redirect_swimlane}**${p.redirect_reason ? `: ${p.redirect_reason}` : ''}`
        : '';
      out.push(`- **${p.title}** — ${p.body_md}${p.disqualifier ? ` _(${p.disqualifier})_` : ''}${redirect}${conf(p.confidence)}`);
    }
  }
  return out.join('\n');
}

/** $-format a price for a chart tap-value / subtitle. */
function _money(n: number): string {
  return '$' + Math.round(n).toLocaleString();
}
/** YYYY-MM-DD → "M/D" x-axis tick. */
function _short_day(iso: string): string {
  const p = (iso || '').split('-');
  return p.length === 3 ? `${Number(p[1])}/${Number(p[2])}` : iso;
}
/** Build a tappable price-history sparkline from a daily series (≥2 points, or
 *  null — a single point isn't a trend). Each point's `detail` is the value
 *  shown on tap; `label` is the x-axis tick. Capped to the last 12 points. */
function _price_chart(
  title: string,
  series: Array<{ date: string; price: number }>,
): { title: string; points: Array<{ x: string; y: number; label: string; detail: string }>; kind: 'sparkline'; height_hint: 'sm' } | null {
  if (series.length < 2) return null;
  const pts = series.slice(-12);
  return {
    title,
    points: pts.map((p) => ({ x: p.date, y: p.price, label: _short_day(p.date), detail: `${_money(p.price)} · ${_short_day(p.date)}` })),
    kind: 'sparkline',
    height_hint: 'sm',
  };
}

/** Order swimlanes low→high by capability tier, read from the lane LABEL the
 *  clustering assigned (entry → entry-mid → mid → mid-high → expert), tie-broken
 *  by the max GPU count in the label. No model numbers — just the envelope words.
 *  So a class tab reads bottom-of-stack → top-of-stack (Z1/Z2-class → Z8-class). */
function _lane_rank(label: string): number {
  const s = (label || '').toLowerCase();
  let tier = 2; // default: mid
  if (/\bentry[\s-]*mid\b/.test(s)) tier = 1;
  else if (/\bentry\b|\bcompact\b|\bmini\b|\bsff\b|\btiny\b/.test(s)) tier = 0;
  else if (/\bmid[\s-]*high\b/.test(s)) tier = 3;
  else if (/\bexpert\b|\bfury\b|\bflagship\b|\btop\b/.test(s)) tier = 4;
  else if (/\bhigh\b/.test(s)) tier = 3;
  else if (/\bmid\b/.test(s)) tier = 2;
  const m = s.match(/(\d+)(?:\s*-\s*(\d+))?\s*gpu/);
  const gpu = m ? Math.max(Number(m[1]), Number(m[2] ?? m[1])) : 0;
  return tier * 100 + gpu;
}

function compose_competitive_pane(): PaneDocument {
  const store = getKristiWorkstationsStore();
  const since_week = new Date(Date.now() - 7 * 86_400_000).toISOString();
  const blocks: PaneBlock[] = [];

  const list_or_empty = (
    title: string,
    items: Array<{ title: string; subtitle?: string; deep_link?: string; detail_md?: string }>,
    empty: string,
  ): PaneBlock =>
    items.length > 0
      ? { type: 'list', title, items }
      : { type: 'list', title, items: [{ title: empty }] };

  // Kristi's per-item assessments → the tap-through `detail_md`. Pulled once
  // per subject type; each row resolves its own key. Full assessment when
  // present, else the short fallback line (+ source link) so the row is useful
  // during backfill and visibly upgrades once the assessor job writes its view.
  const A: Record<AssessmentSubject, Map<string, AssessmentRow>> = {
    sku: store.assessments_for('sku'),
    radar_item: store.assessments_for('radar_item'),
    projection: store.assessments_for('projection'),
    swimlane: store.assessments_for('swimlane'),
    hp_gap: store.assessments_for('hp_gap'),
    commodity: store.assessments_for('commodity'),
    leak: store.assessments_for('leak'),
  };
  const sources_footer = (srcs: Array<{ title?: string; url: string }>): string => {
    const s = srcs.filter((x) => x && x.url);
    return s.length ? '\n\n**Sources**\n' + s.map((x) => `- [${x.title || x.url}](${x.url})`).join('\n') : '';
  };
  const detail = (
    type: AssessmentSubject,
    key: string,
    fallback?: { text: string; sources?: Array<{ title?: string; url: string }> },
  ): string | undefined => {
    const a = A[type].get(key);
    if (a && a.assessment_md) {
      let srcs: Array<{ title?: string; url: string }> = [];
      try { srcs = JSON.parse(a.sources_json || '[]'); } catch { srcs = []; }
      return a.assessment_md + sources_footer(srcs);
    }
    if (fallback && fallback.text) return fallback.text + sources_footer(fallback.sources ?? []);
    return undefined;
  };

  // Component street price rows — each commodity's OBSERVED market street/MSRP
  // (the base beneath every OEM configurator markup), tracked over time. Tap a
  // row → its price-history sparkline (value-on-tap) + Kristi's blurb. Shared by
  // the per-class tab section (class-scoped names) and the cross-class remnant.
  // Mechanical RECEIPTS for a commodity's street price: the recent observation
  // log (date · price · source link), appended AFTER the detail body so it
  // rides whether the body is Kristi's written assessment or the fallback —
  // proof must never be displaced by prose.
  const street_proof = (name: string): string => {
    const obs = store.standalone_observations(name, 6);
    if (obs.length === 0) return '';
    const host_of = (u: string): string => { try { return new URL(u).host.replace(/^www\./, ''); } catch { return u; } };
    return (
      '\n\n**Observed street prices**\n' +
      obs.map((o) => `- ${o.captured_date} · ${_money(o.price)} · [${host_of(o.url)}](${o.url})`).join('\n')
    );
  };

  const street_price_items = (names: string[]) =>
    names.map((name) => {
      const chg = store.commodity_change(name, { price_kind: 'standalone' });
      const chart = _price_chart('Market street price', store.price_series(name, { price_kinds: ['standalone'], limit: 12 }));
      const mom = chg.mom_pct != null ? ` · ${chg.mom_pct > 0 ? '▲' : chg.mom_pct < 0 ? '▼' : '◦'} ${Math.abs(chg.mom_pct)}% m/m` : '';
      // Fitted drift (when the series supports one) — the squeeze as a rate,
      // not just a point-to-point delta.
      const fit = store.commodity_trend(name).fit;
      const drift_line = fit
        ? `\n\n**Fitted drift** ${fit.monthly_pct > 0 ? '+' : ''}${fit.monthly_pct}%/mo over ${fit.span_days}d (${fit.n} points, r²=${fit.r2}) — an observed rate on the recorded series, not a forecast.`
        : '';
      return {
        title: name,
        subtitle: chg.latest != null ? `${_money(chg.latest)}${mom}` : 'no market price yet',
        detail_md:
          (detail('commodity', name, {
            text:
              `**${name}** — street price (observed market/MSRP)${chg.latest != null ? ` ≈ ${_money(chg.latest)}` : ' not yet recorded'}` +
              `${chg.latest_date ? ` _(as of ${chg.latest_date})_` : ''}. ` +
              `This is the part's own price beneath every OEM's configurator markup — tracked over time so the NAND / DRAM / VRAM supply squeeze is visible directly.` +
              drift_line,
          }) ?? '') + street_proof(name),
        ...(chart ? { charts: [chart] } : {}),
      };
    });

  // Base unit cost rows — the workstation PLATFORM (chassis + PSU + motherboard +
  // base margin), isolated by backing the base config's commodities OUT of the
  // OEM base/starting price at street. An estimate that leans high (OEMs mark
  // base commodities up over street); the cross-OEM comparison — the platform
  // tax — is the insight. Filled by record_base_unit when Kristi drives a config.
  // A base unit IS a SKU, so it's class-scoped per tab.
  const base_unit_items = (ws_class: WsClass) => {
    // 6-month deterministic cost outlook per platform (commodity drift
    // compounded over the residual) — computed once for the tab, joined by
    // model_id below.
    const outlook = store.cost_outlook({ ws_class, horizons_months: [6] });
    const outlook_by_model = new Map(outlook.platforms.map((p) => [p.model_id, p]));
    const host_of = (u: string): string => { try { return new URL(u).host.replace(/^www\./, ''); } catch { return u; } };
    return store.base_unit_view(ws_class).map((b) => {
      const known = b.base_unit != null;
      // Every backed-out line carries its RECEIPT: the street anchor's
      // provenance (median of N observations, source host + date, linked).
      const lines = b.backed_out
        .map((c) =>
          c.street != null
            ? `- ${c.commodity} _(${c.commodity_class})_ − ${_money(c.street)} _(median of ${c.street_n_obs} obs${c.street_url ? `; [${host_of(c.street_url)}](${c.street_url})` : ''}${c.street_date ? `, ${c.street_date}` : ''})_`
            : `- ${c.commodity} _(${c.commodity_class})_ — street not yet priced`,
        )
        .join('\n');
      const p6 = outlook_by_model.get(b.model_id)?.projections.find((p) => p.months === 6);
      const outlook_line =
        p6 && p6.delta_abs !== 0
          ? `\n\n**Outlook (6 mo, if observed commodity drift holds)** base config ≈ ${_money(p6.projected_base_config)} ` +
            `(${p6.delta_abs > 0 ? '+' : ''}${_money(p6.delta_abs)}, ${p6.delta_pct > 0 ? '+' : ''}${p6.delta_pct}%; range ${_money(p6.low)}–${_money(p6.high)}) — ` +
            `a labeled extrapolation of the recorded street series, platform residual held constant.`
          : '';
      const flag_lines = b.flags.length ? `\n\n${b.flags.map((f) => `⚠ _${f}_`).join('\n')}` : '';
      // HISTORY: the observed base-config price series + the DERIVED platform
      // residual over time (components backed out at street as-of each day).
      const series = store.base_unit_series(b.model_id, 30);
      const charts = [
        _price_chart('Base config price (observed)', series.map((s) => ({ date: s.date, price: s.base_price }))),
        _price_chart('Platform residual (derived)', series.map((s) => ({ date: s.date, price: s.residual }))),
      ].filter((x): x is NonNullable<typeof x> => x !== null);
      const history_note =
        series.length >= 2
          ? `\n\n**History** — ${series.length} daily points since ${series[0]!.date}; the residual series backs components out at each day's street anchor (early points may back out fewer parts — they lean higher).`
          : series.length === 1
            ? `\n\n**History** — first observation ${series[0]!.date}; the over-time series builds daily as the configurator drive records the base price.`
            : '';
      return {
        title: display_model(b.vendor, b.model_id),
        subtitle: known
          ? `${_money(b.base_unit as number)} platform${b.missing.length ? ` · est. (${b.missing.length} unpriced)` : ''}`
          : 'base config price not yet recorded',
        detail_md:
          `**${display_model(b.vendor, b.model_id)} — base unit cost** ≈ ${known ? _money(b.base_unit as number) : 'n/a'} ` +
          `— the platform: chassis + PSU + motherboard + base margin.\n\n` +
          `Base config ${b.base_config_price != null ? _money(b.base_config_price) : 'n/a'} _(captured ${b.captured_date || 'n/a'}${b.source_url ? `; [${host_of(b.source_url)}](${b.source_url})` : ''})_, commodities backed out at street:\n${lines || '- none recorded'}\n\n` +
          `${b.missing.length ? `_Leans high — ${b.missing.join(', ')} not yet street-priced, so still inside the residual._\n\n` : ''}` +
          `_Estimate: OEMs mark their base commodities up over street, so the residual leans high; the value is comparing it across OEMs._${b.note ? ` ${b.note}` : ''}` +
          history_note +
          outlook_line +
          flag_lines +
          sources_footer(b.source_url ? [{ url: b.source_url }] : []),
        ...(charts.length ? { charts } : {}),
      };
    });
  };

  // 1. Hero — pre-launch leak radar.
  const leaks = store.leak_radar(8);
  const price_moves = store.count_price_moves(since_week);
  blocks.push({
    type: 'hero_metric',
    value: leaks.length > 0 ? String(leaks.length) : '—',
    label: leaks.length === 1 ? 'pre-launch leak on the radar' : 'pre-launch leaks on the radar',
    delta: `${price_moves} price ${price_moves === 1 ? 'move' : 'moves'} this week`,
    delta_kind: 'neutral',
  });

  // 2 + 3 + 4. CLASS TABS — Desktop / Mobile / Rack / Edge-AI. Each tab LEADS
  // with that class's swimlanes (the capability-envelope anchor), then its leak
  // radar, HP gap framing, pricing, and threat radar — so the user toggles the
  // whole competitive picture by workstation class. Only the GPU/ISV cert watch
  // and the unclassed-parts remnant stay genuinely cross-class, below the tabs.
  const CLASS_TABS: Array<{ id: WsClass; label: string }> = [
    { id: 'dtws', label: 'Desktop' },
    { id: 'mws', label: 'Mobile' },
    { id: 'rws', label: 'Rack' },
    { id: 'edge_ai', label: 'Edge·AI' },
  ];
  const leakCounts = store.leak_counts_by_class();
  blocks.push({
    type: 'tabs',
    tabs: CLASS_TABS.map((t) => {
      const classLeaks = store.leak_radar(8, t.id);
      const classGaps = store.hp_z_gap_view(t.id);
      const laneProfiles = store.profiles_by_lane(t.id);
      const leads = classGaps.filter((g) => (g.lead ?? 0) > 0).slice(0, 6);
      const behind = classGaps.filter((g) => (g.lead ?? 0) < 0).slice(0, 6);
      const tabBlocks: PaneBlock[] = [
        // Swimlanes FIRST — the capability-envelope lanes are the anchor for
        // each class tab (cross-OEM equivalents in this class); everything else
        // (leaks, gaps, pricing, radar) hangs off the lanes below.
        list_or_empty(
          'Swimlanes',
          store
            .swimlane_view(t.id)
            .filter((l) => l.swimlane)
            .sort((a, b) => _lane_rank(a.swimlane) - _lane_rank(b.swimlane))
            .map((l) => {
              const base =
                detail('swimlane', l.swimlane, {
                  text: `Capability-envelope peers in this lane: ${l.members.map((m) => display_model(m.vendor, m.model_name)).join(', ')}.`,
                }) ?? '';
              const profiles = laneProfiles.get(l.swimlane) ?? [];
              const detail_md = (base + swimlane_profiles_md(profiles)) || undefined;
              return {
                title: l.swimlane,
                subtitle:
                  l.members.map((m) => display_model(m.vendor, m.model_name)).join(' · ') +
                  (profiles.length ? " · who-it's-for ▸" : ''),
                ...(detail_md ? { detail_md } : {}),
              };
            }),
          'No swimlanes derived yet — Kristi clusters once SKUs are recorded.',
        ),
        list_or_empty(
          'Leak radar',
          classLeaks.map((l) => ({
            title: l.cert_model_string,
            subtitle:
              `${l.registry.toUpperCase()} · ${l.vendor_guess || 'vendor TBD'} · seen ${format_short_date(l.first_seen)}` +
              (l.market_checked_at ? ` · verified ${format_short_date(l.market_checked_at)}` : ''),
            ...(l.raw_url ? { deep_link: l.raw_url } : {}),
            detail_md: detail('leak', l.cert_model_string, {
              text:
                `VERIFIED pre-launch cert string on ${l.registry.toUpperCase()}${l.vendor_guess ? ` — likely ${l.vendor_guess}` : ''}: ` +
                `web cross-reference found no announced or shipping retail product behind it` +
                `${l.market_checked_at ? ` (as of ${format_short_date(l.market_checked_at)}; re-verified on a cadence so it retires itself at launch)` : ''}.` +
                `${l.market_reason ? ` ${l.market_reason}` : ''}`,
              sources: [
                ...(l.raw_url ? [{ url: l.raw_url }] : []),
                ...(l.evidence_url && l.evidence_url !== l.raw_url ? [{ url: l.evidence_url }] : []),
              ],
            }),
          })),
          // Proof-of-life empty state: an empty radar means "all clear", not
          // "dead feature" — show what it's WATCHING so the coverage is visible.
          (() => {
            const w = store.cert_watch_counts(t.id);
            const pending = w.pending > 0 ? ` ${w.pending} new sighting${w.pending === 1 ? '' : 's'} awaiting verification.` : '';
            return w.watching > 0
              ? `✓ No verified pre-launch leaks — watching ${w.watching} certified model${w.watching === 1 ? '' : 's'} in this class; ${w.accounted} accounted for as known/shipping.${pending} The radar lights up the moment an unannounced cert is verified.`
              : 'No cert-registry sightings in this class yet — fills once the registry sweeps run.';
          })(),
        ),
        list_or_empty(
          'HP — where it leads',
          leads.map((g) => ({
            title: `${g.swimlane} · ${g.spec_key}`,
            subtitle: `HP ${gap_value(g.spec_key, g.hp_best)} (${g.hp_model}) vs ${gap_value(g.spec_key, g.rival_best)} (${g.rival_model})`,
            detail_md: detail('hp_gap', `${g.ws_class}::${g.swimlane}::${g.spec_key}`, {
              text:
                `In the ${g.ws_class.toUpperCase()} class, **${g.swimlane}** lane, HP leads on ${g.spec_key}: HP ${g.hp_model} (${g.hp_platform}) ${gap_value(g.spec_key, g.hp_best)} vs ${g.rival_model} (${g.rival_platform}) ${gap_value(g.spec_key, g.rival_best)}.` +
                (g.meaning ? `\n\n**Why it matters:** ${g.meaning}` : '') +
                (g.suspect ? `\n\n_⚠ A same-lane value looked implausible and was dropped before comparing — recorded specs worth a re-check._` : ''),
            }),
          })),
          'No HP advantages computed yet — needs comparable same-class same-lane specs.',
        ),
        list_or_empty(
          'HP — gaps to close',
          behind.map((g) => ({
            title: `${g.swimlane} · ${g.spec_key}`,
            subtitle: `${g.rival_model} ${gap_value(g.spec_key, g.rival_best)} vs HP ${gap_value(g.spec_key, g.hp_best)} (${g.hp_model})`,
            detail_md: detail('hp_gap', `${g.ws_class}::${g.swimlane}::${g.spec_key}`, {
              text:
                `In the ${g.ws_class.toUpperCase()} class, **${g.swimlane}** lane, ${g.rival_model} (${g.rival_platform}) leads on ${g.spec_key}: ` +
                `${gap_value(g.spec_key, g.rival_best)} vs HP ${g.hp_model} (${g.hp_platform}) ${gap_value(g.spec_key, g.hp_best)}. ` +
                `Same-class, same-lane comparison — platforms shown so a cross-generation gap is explicit.` +
                (g.meaning ? `\n\n**Why it matters:** ${g.meaning}` : '') +
                (g.suspect ? `\n\n_⚠ A same-lane value looked implausible and was dropped before comparing — recorded specs worth a re-check._` : ''),
            }),
          })),
          'No HP gaps computed yet — needs comparable same-class same-lane specs.',
        ),
        list_or_empty(
          'Commodity price spread',
          store.commodity_spread(6, t.id).map((c) => {
            // One tappable price-history sparkline per OEM that has ≥2 points,
            // so a tap shows each vendor's price over time (value-on-tap).
            const charts = (['hp', 'dell', 'lenovo'] as const)
              .map((v) =>
                _price_chart(
                  v.toUpperCase(),
                  store.price_series(c.commodity, { vendor: v, price_kinds: ['config_delta', 'addon'], limit: 12 }),
                ),
              )
              .filter((x): x is NonNullable<typeof x> => x !== null);
            // RECEIPTS: each OEM's latest observation with capture date +
            // source link, appended after the body so it survives an
            // assessment override.
            const host_of = (u: string): string => { try { return new URL(u).host.replace(/^www\./, ''); } catch { return u; } };
            const proof =
              '\n\n**Latest observations**\n' +
              store
                .commodity_compare(c.commodity)
                .filter((r) => r.price != null)
                .map((r) => `- ${r.vendor.toUpperCase()}${r.model_id ? ` (${r.model_id})` : ''} · $${(r.price as number).toLocaleString()} · ${r.captured_date}${r.url ? ` · [${host_of(r.url)}](${r.url})` : ''}`)
                .join('\n');
            return {
              title: c.commodity,
              subtitle: c.vendors
                .map((v) => `${v.vendor.toUpperCase()} ${v.price != null ? '$' + v.price.toLocaleString() : '—'}`)
                .join(' · '),
              detail_md:
                (detail('commodity', c.commodity, {
                  text: `Per-OEM pricing for ${c.commodity}: ${c.vendors
                    .map((v) => `${v.vendor.toUpperCase()} ${v.price != null ? '$' + v.price.toLocaleString() : '—'}`)
                    .join(', ')}.`,
                }) ?? '') + proof,
              ...(charts.length ? { charts } : {}),
            };
          }),
          'No per-OEM commodity prices recorded for this class yet.',
        ),
        list_or_empty(
          'Component cost vs OEM markup',
          store.premium_view(8, t.id).map((c) => {
            const arr = (pct: number | null): string =>
              pct == null ? '' : pct > 0 ? ` ▲ ${pct}%` : pct < 0 ? ` ▼ ${Math.abs(pct)}%` : ' ◦ flat';
            // Tappable market-street-price history (the base unit cost beneath
            // every OEM markup) + each OEM's delta trend, revealed on tap.
            const charts = [
              _price_chart('Market street price', store.price_series(c.commodity, { price_kinds: ['standalone'], limit: 12 })),
              ...(['hp', 'dell', 'lenovo'] as const).map((v) =>
                _price_chart(`${v.toUpperCase()} markup`, store.price_series(c.commodity, { vendor: v, price_kinds: ['config_delta', 'addon'], limit: 12 })),
              ),
            ].filter((x): x is NonNullable<typeof x> => x !== null);
            return {
              title: `${c.commodity}${c.market_price != null ? ` · market ~$${c.market_price.toLocaleString()}${arr(c.market_wow_pct ?? c.market_mom_pct)}${c.market_source ? ` (${c.market_source})` : ''}` : ''}`,
              subtitle: c.oem_deltas.length
                ? c.oem_deltas.map((d) => `${d.vendor.toUpperCase()} +$${d.delta.toLocaleString()}`).join(' · ') +
                  (c.cheapest_oem ? ` · ${c.cheapest_oem.toUpperCase()} cheapest` : '')
                : 'no OEM configurator delta yet',
              detail_md:
                (detail('commodity', c.commodity, {
                  text:
                    `**${c.commodity}** — open-market street ≈ ${c.market_price != null ? '$' + c.market_price.toLocaleString() : 'n/a'}` +
                    `${c.market_source ? ` _(${c.market_url ? `[${c.market_source}](${c.market_url})` : c.market_source}${c.market_date ? `, as of ${c.market_date}` : ''})_` : ''}` +
                    `${c.market_mom_pct != null ? ` — ${c.market_mom_pct > 0 ? '▲' : c.market_mom_pct < 0 ? '▼' : '◦'} ${Math.abs(c.market_mom_pct)}% m/m` : ''}.\n\n` +
                    `Configurator add-over-base:\n${c.oem_deltas.map((d) => `- ${d.vendor.toUpperCase()} +$${d.delta.toLocaleString()} _(${d.source || 'configurator'}, ${d.date})_`).join('\n') || '- none'}` +
                    `${c.cheapest_oem ? `\n\n**${c.cheapest_oem.toUpperCase()} undercuts** on this part.` : ''}\n\n` +
                    `_Market is the observed street/MSRP absolute (source + date above); each OEM figure is its configurator delta over the included base, with its own source + capture date — the gap is the OEM premium._`,
                }) ?? '') + street_proof(c.commodity),
              ...(charts.length ? { charts } : {}),
            };
          }),
          'No market-vs-OEM comparison for this class yet.',
        ),
        // Component street price — observed market/MSRP per part, scoped to
        // commodities priced within a model of THIS class (a desktop RDIMM never
        // leaks under the Mobile tab). The class-agnostic remnant — parts not yet
        // tied to any catalogued SKU — surfaces in a clearly cross-class section
        // below the tabs.
        list_or_empty(
          'Component street price',
          street_price_items(store.standalone_commodities(12, t.id)),
          'No market street prices for this class yet — runs once lookup_market_prices has data for its parts.',
        ),
        // Base unit cost — the platform residual, per SKU in this class.
        list_or_empty(
          'Base unit cost',
          base_unit_items(t.id),
          'No base-unit costs for this class yet — Kristi records these (record_base_unit) when she drives an OEM configurator.',
        ),
        // Latest moves — newest leaked/announced SKUs in this class.
        list_or_empty(
          'Latest moves',
          [
            ...store.find_skus({ status: 'leaked', ws_class: t.id, limit: 5 }),
            ...store.find_skus({ status: 'announced', ws_class: t.id, limit: 5 }),
          ]
            .slice(0, 8)
            .map((s) => ({
              title: display_model(s.vendor, s.model_name),
              subtitle: `${s.status} · ${s.form_factor}`,
              ...(s.source_url ? { deep_link: s.source_url } : {}),
              detail_md: detail('sku', s.model_id, {
                text: `${display_model(s.vendor, s.model_name)} — ${s.status}, ${s.form_factor}, ${s.cpu_platform}.${s.notes ? ' ' + s.notes : ''}`,
                sources: s.source_url ? [{ title: s.model_name, url: s.source_url }] : [],
              }),
            })),
          'No new SKUs recorded yet — Kristi sweeps daily.',
        ),
        // Threat & disruptor radar — this class's threats + net-new players, plus
        // genuinely cross-class ('all') items.
        list_or_empty(
          'Threat & disruptor radar',
          store.radar({ ws_class: t.id, limit: 8 }).map((r) => ({
            title: `${r.name}${r.severity === 'high' ? ' ⚠' : ''}`,
            subtitle: `${r.kind.replace('_', ' ')} · ${r.summary}`.slice(0, 140),
            ...(r.source_url ? { deep_link: r.source_url } : {}),
            detail_md: detail('radar_item', `${r.kind}:${r.name}`, {
              text: r.thesis ? `${r.summary}\n\n**Why it matters:** ${r.thesis}` : r.summary,
              sources: r.source_url ? [{ url: r.source_url }] : [],
            }),
          })),
          'No threats or net-new players on the radar yet.',
        ),
        // Projected next gen — labeled inference, scoped to this class's lanes.
        // Two flavors per lane: tech-push (next-gen lineage) and market-pull
        // (where the lane NEEDS to go, from demand + analyst/market signals).
        list_or_empty(
          'Projected next gen',
          store
            .list_projections({ ws_class: t.id })
            .slice(0, 12)
            .map((p) => {
              const market_pull = p.projection_kind === 'market_pull';
              const kind_label = market_pull ? 'Market-pull' : 'Tech-push';
              return {
                title: market_pull ? `🧭 ${p.projected_label}` : p.projected_label,
                subtitle: `${kind_label} · ${p.vendor.toUpperCase()} · ${p.cpu_platform} · ${p.confidence} confidence`,
                detail_md: detail('projection', `${p.vendor}:${p.swimlane}:${p.projection_kind}`, {
                  text: `**Labeled inference — ${kind_label.toLowerCase()}** (${p.confidence} confidence).\n\n**${market_pull ? 'Demand targets' : 'Projected deltas'}:** ${p.key_deltas}\n\n${p.rationale_md}\n\n**Falsifier:** ${p.falsifier}`,
                  sources: (p.source_urls || '').split('\n').filter(Boolean).map((url) => ({ url })),
                }),
              };
            }),
          'No next-gen projections recorded yet.',
        ),
      ];
      return { id: t.id, label: t.label, badge: leakCounts[t.id] || undefined, blocks: tabBlocks };
    }),
  });

  // Per-class sections now live INSIDE each class tab above — Swimlanes, Latest
  // moves, Threat & disruptor radar, Projected next gen (each filtered by the
  // tab's ws_class), AND the cost cluster: Commodity spread, Component cost vs
  // OEM markup, Component street price, Base unit cost. Every row under a class
  // tab is relevant to THAT class. The threat radar also pulls genuinely
  // cross-class ('all') items into every tab. Only the GPU/ISV certification
  // watch (spans every class) and the unclassed-parts remnant stay shared below.

  // ISV / GeForce watch — GPU certification spans every workstation class, so it
  // stays a single shared section.
  const isv = store.isv_certs_for().slice(0, 6);
  blocks.push(
    list_or_empty(
      'ISV / GeForce watch',
      isv.map((c) => ({
        title: `${c.isv_name} (${c.isv_category})`,
        subtitle: c.mentions_geforce ? 'mentions GeForce/consumer GPU' : c.gpu_support_note || 'pro-GPU certified',
      })),
      'No ISV certifications recorded yet.',
    ),
  );

  // Performance per dollar — benchmark score ÷ robust street, the value axis.
  // Components span classes (the same RTX rides desktop and rack), so this is a
  // shared section. Hidden until the benchmark lookup job has scored parts.
  const ppd = store.perf_per_dollar({ limit: 10 }).filter((p) => p.score_per_dollar != null);
  if (ppd.length > 0) {
    blocks.push({
      type: 'list',
      title: 'Performance per dollar',
      items: ppd.map((p) => ({
        title: p.component,
        subtitle: `${p.benchmark_label} ${Math.round(p.score).toLocaleString()} ÷ ${_money(p.street as number)} = ${p.score_per_dollar} pts/$`,
        detail_md:
          `**${p.component}** — ${p.benchmark_label} **${Math.round(p.score).toLocaleString()}** at a robust street price of ` +
          `${_money(p.street as number)}${p.street_date ? ` _(as of ${p.street_date})_` : ''} → **${p.score_per_dollar} points per dollar**.\n\n` +
          `_A synthetic, single-benchmark value signal — comparable only within ${p.benchmark_label}; real workloads (viewport vs solver vs render) weight silicon differently._` +
          (p.score_url ? `\n\n**Sources**\n- [${p.benchmark_label}](${p.score_url})` : ''),
      })),
    });
  }

  // Component street price — cross-class remnant. ONLY the standalone parts not
  // yet priced within any catalogued SKU (so they can't be classed onto a tab).
  // Class-tied street prices live in each tab's "Component street price" above;
  // this section is explicitly labelled class-agnostic so nothing is lost and
  // nothing leaks into the wrong class. Hidden entirely when there's no remnant.
  const unclassed_street = store.standalone_commodities(12, 'unclassed');
  if (unclassed_street.length > 0) {
    blocks.push({
      type: 'list',
      title: 'Component street price · cross-class (unclassed parts)',
      items: street_price_items(unclassed_street),
    });
  }

  return {
    pane_kind: 'competitive',
    title: 'Recon Desk',
    subtitle: 'Workstation market — leaks, gaps, pricing',
    blocks,
    generated_at: new Date().toISOString(),
  };
}

/**
 * Anna's `property` office — the home's value over time + market position +
 * owner-reported improvements. Resolves the household parcel from the
 * property store's most-active account (self-configuring). Synthesizes a
 * display value-series from the recorded points UNION the county's current
 * value and its recent sales, so the sparkline has depth on day one without
 * any manual seeding.
 */
function compose_property_pane(): PaneDocument {
  const ph = getPropertyHistoryStore();
  const assessor = getCountyAssessorStore();
  const blocks: PaneBlock[] = [];
  const fmt$ = (n: number) => '$' + Math.round(n).toLocaleString();
  const src_label = (s: string): string =>
    s === 'county' ? 'County appraised'
    : s === 'zillow_zestimate' ? 'Zillow Zestimate'
    : s === 'redfin' ? 'Redfin estimate'
    : s === 'sale' ? 'Sale'
    : s === 'anna_estimate' ? "Anna's estimate"
    : s;

  const account = ph.most_active_account();
  if (!account) {
    blocks.push({
      type: 'text',
      body_md:
        "No property on file yet. Tell Anna your address (she'll run `lookup_parcel`), or mention an upgrade you've made — your home's value history, market position, and improvements will appear here.",
    });
    return { pane_kind: 'property', title: 'Property', subtitle: 'Home value & market position', blocks, generated_at: new Date().toISOString() };
  }

  const parcel = assessor.get_by_account(account);
  const address = parcel?.situs_address ?? account;
  const county = parcel?.actual_value_total ?? null;

  // Display series: recorded points ∪ synthesized county-current + sales.
  type Pt = { as_of_date: string; source: string; value: number };
  const recorded = ph.list_value_history(account) as Pt[];
  const seen = new Set(recorded.map((p) => `${p.source}|${p.as_of_date}`));
  const synth: Pt[] = [];
  if (county != null && parcel?.tax_year) {
    const k = `county|${parcel.tax_year}-06-30`;
    if (!seen.has(k)) synth.push({ as_of_date: `${parcel.tax_year}-06-30`, source: 'county', value: county });
  }
  // Sales BEFORE the home was built are land/lot transfers (developer
  // acquisitions), not house sales — exclude them so the value trend starts
  // at the first real home sale.
  const year_built = parcel?.improvement?.year_built ?? null;
  for (const s of parcel?.recent_sales ?? []) {
    if (s.sale_price && s.sale_date) {
      if (year_built && Number(s.sale_date.slice(0, 4)) < year_built) continue;
      const k = `sale|${s.sale_date}`;
      if (!seen.has(k)) synth.push({ as_of_date: s.sale_date, source: 'sale', value: s.sale_price });
    }
  }
  const series = [...recorded, ...synth].sort((a, b) => a.as_of_date.localeCompare(b.as_of_date));

  const latest = (src: string) => series.filter((p) => p.source === src).at(-1) ?? null;
  const market =
    latest('anna_estimate') ?? latest('zillow_zestimate') ?? latest('redfin') ?? latest('sale') ?? latest('county');

  // 1. Hero — current best value + delta vs county.
  if (market) {
    let delta: string | undefined;
    let dk: 'up_good' | 'down_good' | 'neutral' = 'neutral';
    if (county != null && market.source !== 'county') {
      const d = market.value - county;
      const pct = county > 0 ? (d / county) * 100 : 0;
      delta = `${d >= 0 ? '+' : '−'}${fmt$(Math.abs(d))} (${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%) vs county`;
      dk = d >= 0 ? 'up_good' : 'down_good';
    }
    blocks.push({
      type: 'hero_metric',
      value: fmt$(market.value),
      label: `est. value · ${src_label(market.source)} ${market.as_of_date.slice(0, 7)}`,
      delta,
      delta_kind: dk,
    });
  }

  // 2. Per-source sparklines (any source with ≥2 points).
  for (const src of ['anna_estimate', 'zillow_zestimate', 'county', 'redfin', 'sale'] as const) {
    const pts = series.filter((p) => p.source === src);
    if (pts.length >= 2) {
      blocks.push({
        type: 'load_chart',
        title: `${src_label(src)} — trend`,
        kind: 'sparkline',
        height_hint: 'sm',
        // label = the YEAR (x-axis tick); detail = the $ value (shown when the
        // point marker is tapped). Exact values also live in the list below.
        points: pts.map((p) => ({ x: p.as_of_date, y: p.value, label: p.as_of_date.slice(0, 4), detail: fmt$(p.value) })),
      });
    }
  }

  // 3. Value history list (newest first).
  if (series.length) {
    blocks.push({
      type: 'list',
      title: 'Value history',
      items: [...series].reverse().map((p) => ({ title: fmt$(p.value), subtitle: `${src_label(p.source)} · ${p.as_of_date}` })),
    });
  }

  // 4. Market-health summary (data-driven; deeper research on request).
  const mh: string[] = [];
  if (county != null) mh.push(`**County appraised:** ${fmt$(county)} (${parcel?.tax_year ?? 'current'} cycle).`);
  if (market && county != null && market.source !== 'county') {
    const d = market.value - county;
    const pct = county > 0 ? (d / county) * 100 : 0;
    mh.push(`**Market vs county:** the market reads ${d >= 0 ? 'above' : 'below'} the county by ${fmt$(Math.abs(d))} (${Math.abs(pct).toFixed(1)}%).`);
  }
  if (parcel?.subdivision_name) mh.push(`**Neighborhood:** ${parcel.subdivision_name}.`);
  mh.push("_Ask Anna for a deeper market-health read — she can browse Zillow/Redfin (via the workstation) and research what's driving your neighborhood and the wider Pleasantville market._");
  blocks.push({ type: 'text', body_md: mh.join('\n\n') });

  // 5. Improvements (+ total value uplift).
  const imps = ph.list_improvements(account);
  const uplift = ph.sum_value_add(account);
  if (imps.length) {
    blocks.push({
      type: 'list',
      title: uplift > 0 ? `Improvements (+${fmt$(uplift)} value)` : 'Improvements',
      items: imps.map((i) => ({
        title: i.title,
        subtitle: [i.category, i.est_value_add != null ? `+${fmt$(i.est_value_add)}` : null, i.status === 'planned' ? 'planned' : null].filter(Boolean).join(' · ') || undefined,
      })),
    });
  } else {
    blocks.push({
      type: 'list',
      title: 'Improvements',
      items: [{ title: "None recorded yet — tell Anna what you've upgraded (finished basement, new HVAC, solar…) and she'll factor it into your home's value." }],
    });
  }

  return {
    pane_kind: 'property',
    title: 'Property',
    subtitle: address,
    blocks,
    generated_at: new Date().toISOString(),
  };
}

// ── resale pane (Linda) ─────────────────────────────────────────────────

const RESALE_PLATFORM_LABEL: Record<string, string> = {
  ebay: 'eBay',
  poshmark: 'Poshmark',
  facebook: 'Facebook',
  other: 'Other',
};

// iOS-side semantic hue tokens (resolved to palette colors client-side) so
// the per-platform revenue strip reads as distinct bands. Reuses the same
// z1..z5 token space the other strips use.
const RESALE_PLATFORM_HUE: Record<string, string> = {
  ebay: 'z2',
  poshmark: 'z4',
  facebook: 'z1',
  other: 'z3',
};

function resale_money(n: number): string {
  return '$' + Math.round(n).toLocaleString();
}

function resale_days_ago(iso: string | null): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Math.floor((Date.now() - t) / (24 * 60 * 60 * 1000)));
}

function resale_days_between(a: string | null, b: string | null): number | null {
  if (!a || !b) return null;
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  if (!Number.isFinite(ta) || !Number.isFinite(tb)) return null;
  return Math.max(0, Math.round((tb - ta) / (24 * 60 * 60 * 1000)));
}

/** One tracked-item card: title, optional photo thumbnail, lifecycle subtitle. */
function resale_card(r: ResaleItemRow): {
  title: string;
  subtitle?: string;
  thumb_capture_id?: string;
} {
  const platform = r.platform ? RESALE_PLATFORM_LABEL[r.platform] ?? r.platform : null;
  const parts: string[] = [];
  if (r.status === 'sold') {
    if (r.sold_price != null) parts.push(`sold ${resale_money(r.sold_price)}`);
    const dts = resale_days_between(r.listed_at, r.sold_at);
    if (dts != null) parts.push(`${dts}d to sell`);
    if (platform) parts.push(platform);
  } else {
    if (platform) parts.push(platform);
    if (r.list_price != null) parts.push(resale_money(r.list_price));
    const ago = resale_days_ago(r.listed_at);
    if (ago != null) parts.push(`listed ${ago}d ago`);
    if (r.price_drops.length > 0) {
      parts.push(`${r.price_drops.length} drop${r.price_drops.length === 1 ? '' : 's'}`);
    }
  }
  return {
    title: r.item_title,
    ...(parts.length > 0 ? { subtitle: parts.join(' · ') } : {}),
    ...(r.source_capture_id ? { thumb_capture_id: r.source_capture_id } : {}),
  };
}

/** One aging-radar row: which item, how overdue, and the suggested markdown. */
function resale_aging_card(e: AgingEntry): {
  title: string;
  subtitle?: string;
  thumb_capture_id?: string;
} {
  const parts: string[] = [];
  if (e.severity === 'stale') parts.push('stale');
  parts.push(`live ${e.days_live}d`);
  if (e.benchmark_source === 'category') {
    parts.push(`these sell in ~${e.benchmark_days}d`);
  } else if (e.benchmark_source === 'overall') {
    parts.push(`you sell in ~${e.benchmark_days}d`);
  }
  if (e.current_price != null && e.suggested_price != null) {
    parts.push(`drop ${resale_money(e.current_price)} → ${resale_money(e.suggested_price)}`);
  }
  return {
    title: e.item.item_title,
    ...(parts.length > 0 ? { subtitle: parts.join(' · ') } : {}),
    ...(e.item.source_capture_id ? { thumb_capture_id: e.item.source_capture_id } : {}),
  };
}

/**
 * Linda's `resale` office — the outcome board over her listing drafts.
 * Reads the per-user sales ledger (`resale_items`) and renders, top→bottom:
 *   1. hero_metric — total revenue + N sold; delta = net profit/margin
 *      when cost data exists.
 *   2. load_chart — revenue by week, last 8 weeks (bars).
 *   3. stacked_strip — revenue split per platform.
 *   4. list "Performance" — sell-through, avg days-to-sell, avg discount +
 *      drops, profit/margin.
 *   5. list "Active listings" — the tracked cards (thumbnail + brief).
 *   6. list "Recently sold" — closed cards.
 *
 * Pure structured reads; no LLM. A brand-new seller (no sales, nothing
 * active) gets a clean invitation instead of a wall of zeros.
 */
function compose_resale_pane(
  db: Database,
  user_id: string,
  _deps: PaneDeps,
): PaneDocument {
  const store = new ResaleItemsStore(db);
  const m: SalesMetrics = store.sales_metrics(user_id);
  const active = store.list_active(user_id, 12);
  const sold = store.list_recent_sold(user_id, 8);
  // Aging radar — active listings overdue vs how fast comparable items sell.
  const aging = compute_aging(active, store.days_to_sell_benchmarks(user_id));

  // The office always renders its full shape — every section is pre-created
  // with a graceful empty state so a brand-new seller sees what the room will
  // become, not a near-blank card. Sections fill in as items are listed + sold.
  const empty_office = m.total_sales === 0 && active.length === 0;
  const blocks: PaneBlock[] = [];

  // 1. Hero — total revenue + count; profit/margin as the delta line.
  const delta =
    m.net_profit != null
      ? `${resale_money(m.net_profit)} profit${
          m.margin_pct != null ? ` · ${Math.round(m.margin_pct)}% margin` : ''
        }`
      : undefined;
  const hero_label = empty_office
    ? 'your resale board — fills in as you list & sell'
    : `revenue · ${m.total_sales} sold` + (m.active_count > 0 ? ` · ${m.active_count} active` : '');
  blocks.push({
    type: 'hero_metric',
    value: resale_money(m.total_revenue),
    label: hero_label,
    ...(delta ? { delta } : {}),
    delta_kind: empty_office ? 'neutral' : 'up_good',
  });

  // 1b. Aging radar — the call to action, right under the hero. Active
  // listings sitting longer than the seller's comparable items take to sell,
  // each with a charm-priced markdown suggestion (cap 5). Only shown when
  // there ARE active listings — an aging alert with nothing to age is noise.
  if (active.length > 0) {
    blocks.push({
      type: 'list',
      title: 'Time to nudge the price',
      items:
        aging.length > 0
          ? aging.slice(0, 5).map(resale_aging_card)
          : [{ title: '—', subtitle: 'Nothing overdue — your active listings are still within their usual sell window.' }],
    });
  }

  // 2. Revenue-by-week — always, so the chart's shape is visible from day one
  // (all-zero bars for a new seller). `md` height gives it presence in the pane.
  blocks.push({
    type: 'load_chart',
    title: 'Revenue · last 8 weeks',
    points: m.revenue_by_week.map((w) => ({
      x: w.week_start,
      y: Math.round(w.revenue),
      label: format_short_date(w.week_start) ?? w.week_start.slice(5),
      detail: resale_money(w.revenue),
    })),
    kind: 'bars',
    height_hint: 'md',
  });

  // 3. Per-platform revenue split — strip once there are sales, else a
  // placeholder row naming what it'll show.
  if (m.by_platform.length > 0) {
    blocks.push({
      type: 'stacked_strip',
      title: 'Revenue by platform',
      segments: m.by_platform.map((p) => ({
        label: RESALE_PLATFORM_LABEL[p.platform] ?? p.platform,
        value: Math.round(p.revenue),
        hue: RESALE_PLATFORM_HUE[p.platform] ?? 'z3',
      })),
    });
  } else {
    blocks.push({
      type: 'list',
      title: 'Revenue by platform',
      items: [{ title: '—', subtitle: 'Splits across eBay / Poshmark / Facebook as items sell.' }],
    });
  }

  // 4. Performance metrics — always; placeholder until the first sale.
  const perf: Array<{ title: string; subtitle?: string }> = [];
  if (m.total_sales > 0) {
    if (m.sell_through_pct != null) {
      perf.push({ title: `${Math.round(m.sell_through_pct)}% sell-through`, subtitle: 'sold ÷ items listed' });
    }
    if (m.avg_days_to_sell != null) {
      perf.push({ title: `${Math.round(m.avg_days_to_sell)} days`, subtitle: 'avg time to sell' });
    }
    if (m.avg_discount_pct != null) {
      perf.push({
        title: `${Math.round(m.avg_discount_pct)}% off list`,
        subtitle:
          m.avg_drops != null
            ? `avg discount · ${m.avg_drops.toFixed(1)} drops to close`
            : 'avg discount to close',
      });
    }
    if (m.net_profit != null) {
      perf.push({
        title: resale_money(m.net_profit),
        subtitle: m.margin_pct != null ? `net profit · ${Math.round(m.margin_pct)}% margin` : 'net profit',
      });
    }
  }
  blocks.push({
    type: 'list',
    title: 'Performance',
    items:
      perf.length > 0
        ? perf
        : [{ title: '—', subtitle: 'Sell-through, days-to-sell, discount & margin appear after your first sale.' }],
  });

  // 5. Active listing cards — always.
  blocks.push({
    type: 'list',
    title: 'Active listings',
    items:
      active.length > 0
        ? active.map(resale_card)
        : [{ title: '—', subtitle: 'Nothing active yet — tell Linda when you list an item and it lands here.' }],
  });

  // 6. Recently sold cards — always.
  blocks.push({
    type: 'list',
    title: 'Recently sold',
    items:
      sold.length > 0
        ? sold.map(resale_card)
        : [{ title: '—', subtitle: 'Your sales show here with final price and days-to-sell.' }],
  });

  return {
    pane_kind: 'resale',
    title: 'Resale Desk',
    subtitle: 'Your listings & sales',
    blocks,
    generated_at: new Date().toISOString(),
  };
}

// ── dispatch ────────────────────────────────────────────────────────────

/**
 * Dispatch by pane_kind. Returns null when the specialist has no
 * pane configured OR the pane kind isn't implemented yet. The
 * route returns 404 in that case so iOS falls back to chat-first.
 */
// ── Code Shop (Beatrice's self-modification cockpit) ────────────────────────

function _days_ago_iso(n: number): string {
  return new Date(Date.now() - n * 86_400_000).toISOString();
}
function _is_summer_month(m: number): boolean {
  return m >= 6 && m <= 9; // Xcel CO summer season ~Jun–Sep
}

/** Compact green/red automated-checks badge for the Code Shop. `null` (legacy /
 *  not recorded) renders nothing so old rows don't show a misleading state. */
function _checks_badge(c: ChangeRecord): string {
  if (c.checks_passed === true) return '✅ checks';
  if (c.checks_passed === false) return '⛔ checks failed';
  return '';
}

function _codeshop_change_card(c: ChangeRecord, web_base: string): {
  title: string;
  subtitle?: string;
  detail_md?: string;
} {
  const langs = c.languages.join('/') || '—';
  const tps = c.gen_tok_per_sec ? ` · ⚡${Math.round(c.gen_tok_per_sec)} tok/s` : '';
  const target = c.target_specialist_id ? ` · ${c.target_specialist_id}` : '';
  const verdict = c.kate_verdict ? `Kate: ${c.kate_verdict.replace(/_/g, ' ')}` : 'awaiting Kate';
  const badge = _checks_badge(c);
  // A stable, human-scannable handle so sibling/twin cards are distinguishable
  // at a glance: the PR number when known, else the short change id.
  const ref = c.pr_number ? `PR #${c.pr_number}` : c.id.slice(-8);
  // The stored pr_url carries Gitea's container-internal host (host.docker.internal),
  // which a browser can't resolve — swap scheme+host for the browser-facing base.
  const view_url = c.pr_url ? c.pr_url.replace(/^https?:\/\/[^/]+/, web_base) : '';
  // On failure, surface the truncated check output in the detail so the owner
  // sees WHY before approving (a green change shows just the badge).
  const checks_detail =
    c.checks_passed === false && c.checks_summary
      ? `\n\n**Automated checks FAILED:**\n\`\`\`\n${c.checks_summary.slice(0, 1500)}\n\`\`\``
      : c.checks_passed === true
        ? '\n\n_Automated checks passed (tsc --noEmit + guard)._'
        : '';
  const detail =
    `**${ref} · ${c.change_kind}${target}** · ${verdict}${badge ? ` · ${badge}` : ''}` +
    `\n\n_branch:_ \`${c.branch}\`` +
    (c.kate_reasons_md ? `\n\n> ${c.kate_reasons_md}` : '') +
    (c.files.length ? `\n\n**Files:** ${c.files.map((f) => '`' + f + '`').join(', ')}` : '') +
    checks_detail +
    (view_url ? `\n\n[View PR](${view_url})` : '') +
    (c.diff_summary ? `\n\n\`\`\`diff\n${c.diff_summary.slice(0, 2000)}\n\`\`\`` : '');
  return {
    title: `${ref} · ${(c.rationale_md || c.branch).slice(0, 72)}`,
    subtitle: `+${c.lines_added}/−${c.lines_removed} · ${langs}${tps} · ${verdict}${badge ? ` · ${badge}` : ''} · ${c.branch}`,
    detail_md: detail,
  };
}

function _codeshop_metrics_block(
  db: Database,
  settings: ReturnType<CodeShopSettings['get_redacted']>,
): PaneBlock {
  // Net LOC merged per day (last 14d).
  const loc_rows = db
    .prepare(
      `SELECT substr(merged_at,1,10) d, SUM(lines_added) a, SUM(lines_removed) r, COUNT(*) n
         FROM beatrice_changes WHERE status='merged' AND merged_at >= @since GROUP BY d ORDER BY d`,
    )
    .all({ '@since': _days_ago_iso(14) }) as Array<{ d: string; a: number; r: number; n: number }>;
  const loc_points = loc_rows.map((x) => ({
    x: x.d,
    y: (x.a ?? 0) - (x.r ?? 0),
    label: x.d.slice(5),
    detail: `+${x.a}/−${x.r} (${x.n} merged)`,
  }));

  // Beatrice's generation tokens by hour-of-day (7d).
  const tok_rows = db
    .prepare(
      `SELECT substr(ts,12,2) h, SUM(COALESCE(json_extract(cost,'$.tokens_out'),0)) o
         FROM audit_log WHERE agent='trainer' AND ts >= @since AND cost IS NOT NULL GROUP BY h`,
    )
    .all({ '@since': _days_ago_iso(7) }) as Array<{ h: string; o: number }>;
  const tok_by_hour = new Array(24).fill(0) as number[];
  for (const row of tok_rows) {
    const h = Number.parseInt(row.h, 10);
    if (h >= 0 && h < 24) tok_by_hour[h] = row.o ?? 0;
  }
  const total_tokens = tok_by_hour.reduce((a, b) => a + b, 0);
  const tok_points = tok_by_hour.map((y, h) => ({ x: String(h), y, label: `${h}`, detail: `${y.toLocaleString()} tok` }));

  // Estimated electricity $ by hour = tokens × kWh/1k × Pleasantville TOU $/kWh.
  const summer = _is_summer_month(new Date().getMonth() + 1);
  const est_points = tok_by_hour.map((tok, h) => {
    const rate = settings.tou_rates.find((t) => t.hour === h);
    const usd = (tok / 1000) * settings.kwh_per_ktoken * (rate ? (summer ? rate.summer : rate.winter) : 0.12);
    return { x: String(h), y: Math.round(usd * 1000) / 1000, label: `${h}`, detail: `$${usd.toFixed(3)} est.` };
  });
  const total_est = est_points.reduce((a, p) => a + p.y, 0);

  // Cumulative code stats.
  const totals = db
    .prepare(
      `SELECT
         SUM(CASE WHEN status='merged' THEN 1 ELSE 0 END) merged_n,
         SUM(CASE WHEN status='merged' THEN lines_added-lines_removed ELSE 0 END) net_loc,
         SUM(CASE WHEN status='denied_by_kate' THEN 1 ELSE 0 END) denied_n,
         COUNT(*) total_n
       FROM beatrice_changes`,
    )
    .get() as { merged_n: number | null; net_loc: number | null; denied_n: number | null; total_n: number | null };

  return {
    type: 'list',
    title: '📊 Dev metrics — tap to expand',
    items: [
      {
        title: `Code shipped — ${totals.merged_n ?? 0} merged · ${totals.net_loc ?? 0} net LOC`,
        subtitle: `${totals.total_n ?? 0} changes total · ${totals.denied_n ?? 0} denied by Kate`,
        detail_md: `Net lines merged per day (last 14 days). Lifetime: **${totals.merged_n ?? 0}** merged, **${totals.denied_n ?? 0}** denied by Kate, **${totals.total_n ?? 0}** total changes.`,
        charts: loc_points.length
          ? [{ title: 'Net LOC merged / day', points: loc_points, kind: 'bars', height_hint: 'md' }]
          : undefined,
      },
      {
        title: `Tokens to generate — ${total_tokens.toLocaleString()} (7d)`,
        subtitle: 'Beatrice generation tokens by hour of day',
        detail_md: "Output tokens Beatrice's turns generated over the last 7 days, bucketed by hour of day (from the audit log).",
        charts: [{ title: 'Tokens by hour of day', points: tok_points, kind: 'bars', height_hint: 'sm' }],
      },
      {
        title: `Est. electricity — $${total_est.toFixed(2)} (7d, est.)`,
        subtitle: 'Estimated cost of her dev compute, by hour',
        detail_md:
          `**Estimate, not a bill.** Beatrice's compute runs on your local the LLM host/forza hardware (not separately metered), and Hearth has no hourly grid data — so this is tokens-by-hour × **${settings.kwh_per_ktoken} kWh / 1k tokens** × the Pleasantville ${summer ? 'summer' : 'winter'} Xcel time-of-use $/kWh for that hour. Tune both constants in the gear.`,
        charts: [{ title: `Est. $/hour (${summer ? 'summer' : 'winter'} TOU)`, points: est_points, kind: 'bars', height_hint: 'sm' }],
      },
    ],
  };
}

export function compose_codeshop_pane(db: Database): PaneDocument {
  const store = new ChangeRecordsStore(db);
  // Redacted config only — the pane must never have a token in scope.
  const settings = new CodeShopSettings(db).get_redacted();
  const blocks: PaneBlock[] = [];

  const pending_merge = store.list({ status: 'pending_owner_merge', limit: 20 });
  const in_review = store.list({ status: 'pending_kate_review', limit: 20 });
  const merged = store.list({ status: 'merged', limit: 10 });

  if (pending_merge.length > 0) {
    const next = pending_merge[0]!;
    blocks.push({
      type: 'hero_metric',
      value: `${pending_merge.length} awaiting your merge`,
      label: `${next.pr_number ? `PR #${next.pr_number} · ` : ''}${(next.rationale_md || next.branch).slice(0, 52)}`,
      delta: next.kate_verdict ? `Kate ${next.kate_verdict.replace(/_/g, ' ')}` : undefined,
      delta_kind: 'up_good',
    });
    // One approve-link per pending change — the web client turns a
    // `codeshop:merge:<proposal_id>` deep link into the inline Approve & merge button.
    for (const c of pending_merge) {
      if (!c.related_proposal_id) continue;
      const link_badge = _checks_badge(c);
      blocks.push({
        type: 'link',
        title: `✓ Approve & merge — ${c.pr_number ? `PR #${c.pr_number} · ` : ''}${(c.rationale_md || c.branch).slice(0, 48)}`,
        subtitle: `+${c.lines_added}/−${c.lines_removed} · ${c.languages.join('/') || '—'} · Kate ${c.kate_verdict ?? '—'}${link_badge ? ` · ${link_badge}` : ''}`,
        deep_link: `codeshop:merge:${c.related_proposal_id}`,
      });
    }
  } else {
    blocks.push({
      type: 'hero_metric',
      value: settings.paused ? 'Paused' : 'All clear',
      label: settings.paused ? 'Beatrice is paused by you' : 'Nothing awaiting your merge',
      delta_kind: 'neutral',
    });
  }

  blocks.push(_codeshop_metrics_block(db, settings));

  const card = (c: ChangeRecord) => _codeshop_change_card(c, settings.gitea_web_base_url);
  if (pending_merge.length) blocks.push({ type: 'list', title: 'Awaiting your merge', items: pending_merge.map(card) });
  if (in_review.length) blocks.push({ type: 'list', title: "In Kate's review", items: in_review.map(card) });
  if (merged.length) blocks.push({ type: 'list', title: 'Recently merged', items: merged.map(card) });

  // Beatrice's office is tabbed: "Office" (this change-pipeline view) +
  // "Scrum" (her dev-board — feature/bug grooming for building Hearth). The
  // Scrum tab is composed from existing primitives in scrum_pane.ts; chat
  // remains the room's own surface below the pane.
  const scrum = scrum_pane_tab(db);
  return {
    pane_kind: 'codeshop',
    title: 'Code Shop',
    subtitle: "Beatrice's changes, metrics & merges",
    blocks: [
      {
        type: 'tabs',
        tabs: [
          { id: 'office', label: 'Office', blocks },
          scrum,
        ],
      },
    ],
    generated_at: new Date().toISOString(),
  };
}

// ── briefing pane (Kate) ────────────────────────────────────────────────

const SEVERITY_RANK: Record<string, number> = { high: 3, medium: 2, low: 1 };

/**
 * Kate's `briefing` office — the Chief of Staff's warm front room.
 *
 * Three things in one cozy surface:
 *   1. Her latest brief, embedded (iOS renders it with the existing
 *      BriefDetailView — single source of truth stays the briefs table).
 *   2. (Phase 2) "Needs you" recommendation cards — the concerns Kate
 *      couldn't resolve herself, each with her note + context-sensitive
 *      action buttons + an inline ask-back.
 *   3. The team-health glance — brief cadence/mood, the escalations that
 *      bubbled up to Kate today, and the stuck/failed work from Mariah's
 *      process-miss ledger.
 *
 * Blocks 2–3 are internal team ops and render ONLY for the owner; a
 * friend-tier household member sees just their own brief.
 */
async function compose_briefing_pane(
  spec: LoadedSpecialist,
  db: Database,
  user_id: string,
  deps: PaneDeps,
): Promise<PaneDocument> {
  const briefing_blocks: PaneBlock[] = [];

  // 1. The brief, in-room. iOS fetches /api/briefs/latest itself.
  briefing_blocks.push({ type: 'embed', view: 'brief' });

  // 2–3. Internal team ops — owner only.
  if (deps.viewer_is_owner) {
    // 2. "Needs you" — the concerns Kate couldn't settle herself, each with
    //    her recommendation + action buttons + inline ask-back.
    const recs = compose_recommendation_blocks(db, spec.id);
    if (recs.length > 0) {
      briefing_blocks.push({ type: 'text', body_md: '### Needs you' });
      briefing_blocks.push(...recs);
    }
    // 3. The team-health glance.
    briefing_blocks.push(compose_team_health_block(db, user_id));
  }

  // 4. The office is TABBED via the server `tabs` primitive (the Ruby
  //    Politics Desk pattern, 2026-06-10): Briefing | News Desk. The
  //    News Desk tab (own file — news_pane.ts; this pane file is shared
  //    across session lanes) carries Kate's lead take with tappable
  //    numbered citations + the freshest headlines grouped by beat.
  //    iOS renders the segmented tabs natively; the WEB office UNWRAPS
  //    the primitive and drives its own tab bar, because its News Desk
  //    tab is the richer interactive /api/news surface (app.js).
  //    Household-visible — news is shelf-wide material, same gate as
  //    GET /api/news/desk. Empty desk → no tabs, flat briefing (as before).
  const news_tab = compose_news_desk_tab(db);
  // Research tab (2026-07-29) — the deep-research room. Gated on the
  // `deep_research` CAPABILITY, not on `spec.id === 'kate'`: Ruby holds the
  // same grant and files her own investigations, so the day her office grows a
  // tabbed surface the room comes with it. Cordoned per requester (the tab
  // reads list_for_user, so the owner has no god-view of a household member's
  // research) and NOT owner-gated — a household member's own investigations are
  // theirs to watch. Fail-open like the security tab: a store hiccup must never
  // take the whole office down.
  let research_tab: ReturnType<typeof compose_research_room_tab> = null;
  if (spec.granted.has('deep_research')) {
    try {
      research_tab = compose_research_room_tab(db, {
        user_id,
        // Least-privilege when the route couldn't resolve a tier, which is what
        // `viewer_tier` documents itself as defaulting to. Not
        // `viewer_is_owner ? 'owner' : …`: re-deriving a tier from a boolean is
        // how a real tier and a guessed one drift, and it would be the only
        // place in this file that does it. The cordon barely notices either way —
        // `list_for_user` matches on `requested_by` first, so a viewer always
        // sees their OWN research; tier only widens visibility to `private_to`
        // markers, and widening on a guess is the wrong direction.
        tier: deps.viewer_tier ?? 'friend',
      });
    } catch {
      research_tab = null;
    }
  }
  const extra_tabs = [
    ...(news_tab ? [news_tab] : []),
    ...(research_tab ? [research_tab] : []),
  ];
  const blocks: PaneBlock[] =
    extra_tabs.length > 0
      ? [
          {
            type: 'tabs',
            tabs: [{ id: 'briefing', label: 'Briefing', blocks: briefing_blocks }, ...extra_tabs],
          },
        ]
      : briefing_blocks;

  return {
    pane_kind: 'briefing',
    title: "Kate's Office",
    subtitle: 'Your brief, the team, and the perimeter',
    blocks,
    generated_at: new Date().toISOString(),
  };
}

/**
 * Pending recommendation cards the office's specialist has filed (via
 * `recommend_to_user`) for concerns she couldn't resolve herself. Newest first.
 * Each renders her recommendation + what she tried + the context-sensitive
 * buttons; the buttons decide through the normal proposal pipeline (so the
 * decision trains the autonomy signature), and PIN step-up is flagged from the
 * payload.
 *
 * ⚠ The kind filter MUST be SQL-side (2026-07-29 fix). This read used to take
 * `limit: 10` and THEN `.filter(kind === 'recommendation')` in JS — so twelve
 * pending `face_enrollment` cards pushed the single real recommendation to rank
 * 14, the page-10 window never contained it, and "Needs you" rendered empty on
 * iOS AND on web while the card sat pending in the queue. The store's `kind`
 * filter is applied before LIMIT, which is the only ordering that can't be
 * starved by an unrelated card class.
 */
function compose_recommendation_blocks(
  db: Database,
  specialist_id: string,
): Array<Extract<PaneBlock, { type: 'recommendation' }>> {
  const rows = new ProposalsStore(db).list({
    status: 'pending',
    specialist_id,
    kind: 'recommendation',
    limit: 10,
  });
  const threshold_cents = parseInt(process.env.HEARTH_STEP_UP_AMOUNT_CENTS ?? '5000', 10);
  return rows.map((r) => {
    let payload: Record<string, unknown> = {};
    try {
      payload = JSON.parse(r.payload_json) as Record<string, unknown>;
    } catch {
      /* malformed payload — render with title + rationale + actions only */
    }
    const attempt = typeof payload.attempt_md === 'string' ? payload.attempt_md : undefined;
    const source =
      typeof payload.source_specialist === 'string' ? payload.source_specialist : undefined;
    const amount = typeof payload.amount_cents === 'number' ? payload.amount_cents : null;
    const requires_step_up =
      payload.requires_step_up === true || (amount !== null && amount > threshold_cents);
    return {
      type: 'recommendation' as const,
      proposal_id: r.id,
      title: r.title ?? 'Recommendation',
      note_md: r.rationale_md,
      ...(attempt ? { attempt_md: attempt } : {}),
      ...(source ? { source_specialist_id: source } : {}),
      actions: r.actions,
      requires_step_up,
      ask_back: true,
    };
  });
}

interface BriefCadenceRow {
  ts_generated: string;
  mood: string;
  consumed_at: string | null;
}

function compose_team_health_block(
  db: Database,
  user_id: string,
): Extract<PaneBlock, { type: 'team_health' }> {
  // Brief cadence + mood — latest few briefs for this user (or the
  // owner-global NULL-user briefs that pre-date per-user rows).
  const brief_rows = db
    .prepare(
      `SELECT ts_generated, mood, consumed_at FROM briefs
        WHERE user_id = @uid OR user_id IS NULL
        ORDER BY ts_generated DESC LIMIT 5`,
    )
    .all({ '@uid': user_id }) as BriefCadenceRow[];
  const latest = brief_rows[0];
  const brief_cadence = {
    last_generated_at: latest?.ts_generated ?? null,
    consumed: latest ? latest.consumed_at !== null : false,
    mood: latest?.mood ?? null,
    recent_moods: brief_rows.map((b) => b.mood).filter((m): m is string => Boolean(m)),
  };

  // Escalations that bubbled up to Kate. today_total + cleared use the
  // user's local day; still_open is any-age unactioned. The `ts` column
  // is a UTC ISO string, so compare against the local-midnight instant
  // rendered back to ISO (lexicographic order == chronological order).
  const day_start = local_day_start().toISOString();
  const count = (sql: string, params: Record<string, string> = {}): number => {
    const row = db.prepare(sql).get(params) as { n: number } | undefined;
    return row?.n ?? 0;
  };
  const today_total = count(
    `SELECT COUNT(*) AS n FROM specialist_inboxes
      WHERE to_specialist_id = 'kate' AND kind = 'flag' AND ts >= @ds`,
    { '@ds': day_start },
  );
  const cleared_by_kate = count(
    `SELECT COUNT(*) AS n FROM specialist_inboxes
      WHERE to_specialist_id = 'kate' AND kind = 'flag'
        AND ts >= @ds AND actioned_at IS NOT NULL`,
    { '@ds': day_start },
  );
  const still_open = count(
    `SELECT COUNT(*) AS n FROM specialist_inboxes
      WHERE to_specialist_id = 'kate' AND kind = 'flag' AND actioned_at IS NULL`,
  );

  // Stuck/failed work — open process misses, most-severe first, capped.
  const stuck_work = new ProcessMissStore(db)
    .list({ open_only: true })
    .sort((a, b) => (SEVERITY_RANK[b.severity] ?? 0) - (SEVERITY_RANK[a.severity] ?? 0))
    .slice(0, 5)
    .map((m) => ({
      subject_specialist_id: m.subject_specialist_id,
      task_summary: m.task_summary,
      gap: m.gap,
      severity: (SEVERITY_RANK[m.severity] ? m.severity : 'low') as 'low' | 'medium' | 'high',
      status: m.status,
    }));

  // Pulse — start from the brief's own mood, escalate on open ops.
  const mood_level =
    brief_cadence.mood === 'concerned' ? 2 : brief_cadence.mood === 'attentive' ? 1 : 0;
  const has_high_miss = stuck_work.some((m) => m.severity === 'high');
  const has_med_miss = stuck_work.some((m) => m.severity === 'medium');
  const ops_level =
    has_high_miss || still_open >= 2
      ? 2
      : still_open >= 1 || has_med_miss || stuck_work.length > 0
        ? 1
        : 0;
  const level = Math.max(mood_level, ops_level);
  const pulse: 'calm' | 'attentive' | 'concerned' =
    level >= 2 ? 'concerned' : level === 1 ? 'attentive' : 'calm';

  return {
    type: 'team_health',
    pulse,
    headline: compose_team_health_headline(pulse, still_open, stuck_work.length, brief_cadence),
    brief_cadence,
    escalations: { today_total, cleared_by_kate, still_open },
    stuck_work,
  };
}

function compose_team_health_headline(
  pulse: 'calm' | 'attentive' | 'concerned',
  still_open: number,
  stuck_count: number,
  cadence: { last_generated_at: string | null; consumed: boolean },
): string {
  // Tonal, not a count dump — the numbers live in the rows below, so the
  // headline just sets the mood in Kate's voice. One short sentence.
  if (still_open === 0 && stuck_count === 0) {
    if (!cadence.last_generated_at) return 'All quiet on the team.';
    return cadence.consumed
      ? 'All quiet — your brief’s read and nothing’s stuck.'
      : 'All quiet — your brief is waiting up top.';
  }
  return pulse === 'concerned'
    ? 'A few things need you below.'
    : 'Mostly handled — a couple of things for you below.';
}

// ── presence pane (LD2450 office) ───────────────────────────────────────

/**
 * The non-canvas furniture for the presence office. The live top-down room
 * canvas (FOV cone, range arcs, target dots, draggable zone rects) is a
 * CLIENT-rendered surface keyed off `pane_kind === 'presence'` in app.js —
 * exactly as the Code Shop's settings modal is client logic keyed off
 * `pane_kind === 'codeshop'`. This composer frames that canvas: a glanceable
 * presence hero (kept honest by the `presence_targets` SSE), the room + zone
 * summary, the write-lifecycle status, and the zone list with per-row detail.
 *
 * Reads the per-device zone config (PresenceZonesStore) + the latest live
 * snapshot (the ephemeral PresenceLiveCache). Pure structured reads, no LLM.
 * Owner-global per device; v1 the single Satellite1. Degrades clearly — never
 * crashes — when the coordinator isn't holding the device (HA owns it; §8).
 */
function compose_presence_pane(db: Database): PaneDocument {
  const device_id = DEFAULT_PRESENCE_DEVICE_ID;
  const cfg = new PresenceZonesStore(db).get(device_id);
  const cache = get_presence_cache();
  const live = cache.is_live(device_id);
  const snap = cache.get(device_id);

  const blocks: PaneBlock[] = [];

  if (live && snap) {
    const nearest =
      snap.nearest_mm != null
        ? `${(snap.nearest_mm / 1000).toFixed(1)} m · nearest target`
        : 'someone in view';
    blocks.push({
      type: 'hero_metric',
      value: snap.present ? 'Present' : 'Empty',
      label: snap.present ? nearest : 'no one in view',
      delta: `${snap.moving} moving · ${snap.still} still`,
      delta_kind: 'neutral',
    });
  } else {
    blocks.push({
      type: 'hero_metric',
      value: 'Standby',
      label: 'Live presence is owned by Home Assistant — the viewer is read-only until Hearth holds the device.',
      delta_kind: 'neutral',
    });
  }

  const count_type = (t: ZoneRect['type']) => cfg.zones.filter((z) => z.type === t).length;
  const summary_bits: string[] = [];
  if (count_type('Detection')) summary_bits.push(`${count_type('Detection')} detection`);
  if (count_type('Filter')) summary_bits.push(`${count_type('Filter')} filter`);
  const summary = summary_bits.length ? summary_bits.join(' · ') : 'no active zones';
  blocks.push({
    type: 'text',
    body_md: `**${cfg.room_name}** · ${cfg.zones.length} zones · ${summary}`,
  });

  if (cfg.status === 'pending') {
    blocks.push({
      type: 'text',
      body_md: '_⟳ A zone change is queued — the coordinator applies it when it holds the device._',
    });
  } else if (cfg.reboot_required) {
    blocks.push({
      type: 'text',
      body_md: '_⟳ Reboot needed to persist the last zone change (custom firmware)._',
    });
  } else if (cfg.status === 'error' && cfg.last_error) {
    blocks.push({ type: 'text', body_md: `_⚠ Last zone write failed: ${cfg.last_error}_` });
  }

  blocks.push({ type: 'list', title: 'Detection zones', items: cfg.zones.map(_presence_zone_row) });

  return {
    pane_kind: 'presence',
    title: 'Presence',
    subtitle: `${device_id} · ${cfg.room_name}`,
    blocks,
    generated_at: new Date().toISOString(),
  };
}

function _presence_zone_row(z: ZoneRect): { title: string; subtitle: string; detail_md: string } {
  const w_mm = Math.abs(z.x2_mm - z.x1_mm);
  const d_mm = Math.abs(z.y2_mm - z.y1_mm);
  const drawn = w_mm > 0 && d_mm > 0;
  const size = drawn ? `${(w_mm / 1000).toFixed(1)} m × ${(d_mm / 1000).toFixed(1)} m` : 'not drawn';
  return {
    title: z.name,
    subtitle: `${z.type} · ${size}`,
    detail_md: drawn
      ? `**${z.name}** — ${z.type}\n\nX ${z.x1_mm}…${z.x2_mm} mm · Y ${z.y1_mm}…${z.y2_mm} mm`
      : `**${z.name}** — ${z.type}\n\nNo region drawn yet. Open **Edit zones** in the office to draw it on the room.`,
  };
}

export async function compose_pane(
  spec: LoadedSpecialist,
  db: Database,
  user_id: string,
  deps: PaneDeps,
): Promise<PaneDocument | null> {
  if (!spec.pane_kind) return null;
  switch (spec.pane_kind) {
    case 'library':
      return compose_library_pane(db, user_id, deps);
    case 'listening':
      return compose_listening_pane(db, user_id, deps);
    case 'activity':
      return compose_activity_pane(db, user_id, deps);
    case 'program':
      return compose_program_pane(db, user_id, deps);
    case 'fuel':
      return compose_fuel_pane(db, user_id, deps);
    case 'civic':
      return compose_civic_pane(db, user_id, deps);
    case 'competitive':
      return compose_competitive_pane();
    case 'property':
      return compose_property_pane();
    case 'resale':
      return compose_resale_pane(db, user_id, deps);
    case 'codeshop':
      return compose_codeshop_pane(db);
    case 'briefing':
      return compose_briefing_pane(spec, db, user_id, deps);
    case 'presence':
      // Presence-in-the-home is owner-private (§11). The office lives on a
      // household-reachable specialist (Iris), so gate the pane itself on owner
      // tier — a non-owner gets null → 404 → the room falls back to chat-first
      // (Iris's normal surface), never the presence office.
      return deps.viewer_is_owner ? compose_presence_pane(db) : null;
    case 'home':
      // The household-shared occupancy map (§9.2): the NAMED "who is where" map
      // is household-tier (mutual transparency); friend tier is excluded.
      // Unknowns + crops stay owner-only on Cassandra's security office.
      return deps.viewer_tier === 'friend' ? null : compose_home_pane(db, user_id, deps);
    case 'today':
      // Reserved but not yet implemented — `today` is a future pass.
      // iOS sees a 404 and falls back to chat-first.
      return null;
    default: {
      // Exhaustiveness check — TS catches a new pane_kind that
      // didn't get a case here.
      const _exhaustive: never = spec.pane_kind;
      return _exhaustive;
    }
  }
}

// Re-export for callers that previously imported `Tool` from here as a
// side effect. Keeps the surface stable; no behavioral change.
export type { Tool };
