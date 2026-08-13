import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import matter from 'gray-matter';
import type { Database } from 'bun:sqlite';
import type { SqlBind } from '@memory/stores/structured';
import { ulid } from 'ulid';
import type { AuditRecord, NoteType } from '@core/types';
import type { Tier } from '@core/users';
import type { LocationEvent, MotionMode } from '@core/location_awareness';
import {
  note_frontmatter_visible_to_caller,
  note_visible_to_caller,
  parse_shared_with,
  type Caller,
} from './private_to';
import { UserProfileStore, type StoredProfile } from './stores/user_profile';
import { KnowledgeEdges } from './stores/knowledge_edges';
import { MediaArchiveJobStore } from './stores/media_jobs';
import { CapabilityDemandStore } from './stores/capability_demand';
import { HomeMapStore } from './stores/home_map';
import { local_iso_date } from '@core/time';
// Type-only cycle back to this module (relationship_signals imports
// `type MemoryClient`), erased at compile — no runtime import cycle.
import { is_non_contact } from '@core/relationship_signals';
import { is_known_note_type, known_note_types } from './schemas/note_types';
import { pack_f32, unpack_f32, cosine, norm } from '@core/embeddings';
import {
  audit_chain_enabled,
  chain_row_hash,
  GENESIS_HASH,
  type AuditChainFields,
} from '@core/audit_chain';

export interface MemoryClientConfig {
  vault_root: string; // absolute path
  db: Database;
}

/**
 * One retrieved chunk, returned by both the lexical (`retrieve_scoped_chunks`)
 * and vector (`vector_search`) paths so the RRF fuser can merge them on a
 * single `(note_path, chunk_idx)` key. `score` is FTS rank (lexical) or
 * cosine (vector); callers treat it only as a within-list ranking signal.
 */
export interface ScopedChunkHit {
  note_path: string;
  chunk_idx: number;
  chunk_text: string;
  score: number;
  /**
   * Trust tier read from the note's wrapper frontmatter (Slice A/B of the
   * Cordelia knowledge-curation arc — 2026-05-30). Tier 1 = peer-reviewed /
   * professional body / non-captured govt; Tier 2 = clinical-grade lay
   * synthesis / evidence-based practitioner; null = no trust stamp.
   */
  trust_tier: 1 | 2 | null;
  /** Wrapper note title from frontmatter when present. */
  title: string | null;
  /**
   * When this content is FROM — frontmatter `captured_at`/`date`, falling
   * back to the note file's mtime. ISO string; null when nothing resolves.
   * Drives the age label on retrieved excerpts ("as of <date> — Nd old")
   * so the model qualifies stale facts instead of presenting last month's
   * reading as current state (2026-06-10).
   */
  as_of: string | null;
  /**
   * Cross-encoder relevance for THIS query, set only when the rerank step
   * ran (see retrieve_hybrid). Sigmoid-normalized [0,1]; undefined on the
   * FTS-only path. Drives the low-confidence gate at the auto-RAG call
   * sites — weak evidence invites blend-with-memory fabrication, so
   * below-bar retrievals are suppressed rather than injected.
   */
  rerank_score?: number;
}

export interface RetrieveParams {
  query: string;
  k?: number;
  filters?: {
    types?: NoteType[];
    relationship?: string;
    friday_managed?: boolean;
    [field: string]: unknown;
  };
  include_neighbors?: boolean;
}

export interface RetrieveHit {
  note_path: string;
  chunk_text: string;
  score: number;
  frontmatter: Record<string, unknown>;
}

export interface PersonFilter {
  relationship?: string;
  friday_managed?: boolean;
  do_not_contact?: boolean;
}

export interface PersonLookup {
  id: string;
  note_path: string;
  frontmatter: Record<string, unknown>;
}

export interface DateEvent {
  kind: 'birthday' | 'anniversary';
  person_id: string;
  name: string;
  note_path: string;
  date: string; // YYYY-MM-DD or MM-DD as stored
  days_until: number;
  what?: string; // anniversaries only
}

function days_until(date_str: string, today: Date): number | null {
  // Accept YYYY-MM-DD (anchored) or MM-DD (year-agnostic).
  const full = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date_str);
  const partial = /^(\d{2})-(\d{2})$/.exec(date_str);
  let month: number;
  let day: number;
  if (full) {
    month = parseInt(full[2]!, 10);
    day = parseInt(full[3]!, 10);
  } else if (partial) {
    month = parseInt(partial[1]!, 10);
    day = parseInt(partial[2]!, 10);
  } else {
    return null;
  }
  // Resolve to this year first; if past, roll to next year.
  let target = new Date(today.getFullYear(), month - 1, day);
  target.setHours(0, 0, 0, 0);
  if (target < today) {
    target = new Date(today.getFullYear() + 1, month - 1, day);
    target.setHours(0, 0, 0, 0);
  }
  const ms = target.getTime() - today.getTime();
  return Math.round(ms / (1000 * 60 * 60 * 24));
}

export interface PlaceRow {
  id: string;
  name: string;
  aliases: string[];
  address: string | null;
  lat: number | null;
  lon: number | null;
  category: string | null;
  ha_zone_name: string | null;
  parking_buffer_minutes: number;
  hours: Record<string, string> | null;
  phone: string | null;
  note_path: string;
  mtime: string;
}

interface PlaceDbRow {
  id: string;
  name: string;
  aliases_json: string;
  address: string | null;
  lat: number | null;
  lon: number | null;
  category: string | null;
  ha_zone_name: string | null;
  parking_buffer_minutes: number;
  hours_json: string | null;
  phone: string | null;
  note_path: string;
  mtime: string;
}

function place_row_from_db(r: PlaceDbRow): PlaceRow {
  let aliases: string[] = [];
  try {
    aliases = JSON.parse(r.aliases_json) as string[];
  } catch {
    aliases = [];
  }
  let hours: Record<string, string> | null = null;
  if (r.hours_json) {
    try {
      hours = JSON.parse(r.hours_json) as Record<string, string>;
    } catch {
      hours = null;
    }
  }
  return {
    id: r.id,
    name: r.name,
    aliases,
    address: r.address,
    lat: r.lat,
    lon: r.lon,
    category: r.category,
    ha_zone_name: r.ha_zone_name,
    parking_buffer_minutes: r.parking_buffer_minutes,
    hours,
    phone: r.phone,
    note_path: r.note_path,
    mtime: r.mtime,
  };
}

export interface PersonRow {
  id: string;
  name: string;
  preferred_name: string | null;
  relationship: string;
  birthday: string | null;
  contact_cadence: string | null;
  last_contacted: string | null;
  sensitive: 0 | 1;
  friday_managed: 0 | 1;
  do_not_contact: 0 | 1;
  note_path: string;
  frontmatter_json: string;
  mtime: string;
}

/** A row of the household_goods projection (Household Knowledge Graph). */
export interface HouseholdGoodRow {
  id: string;
  name: string;
  category: string | null;
  merchant: string | null;
  owner: string | null;
  order_key: string | null;
  purchase_date: string | null;
  cost: number | null;
  currency: string;
  warranty_until: string | null;
  return_window_until: string | null;
  status: string;
  source: string;
  note_path: string;
  frontmatter_json: string;
  mtime: string;
  private_to: string | null;
}

/** A row of the media_items projection (Media Archive, 2026-07-11). */
export interface MediaItemRow {
  id: string;
  name: string;
  media_kind: string | null;
  source_site: string | null;
  source_url: string | null;
  creator: string | null;
  genre: string | null;
  nsfw: number; // 0 | 1
  duration_s: number | null;
  width: number | null;
  height: number | null;
  container: string | null;
  filesize: number | null;
  published_at: string | null;
  archived_at: string | null;
  nas_path: string | null;
  thumbnail_path: string | null;
  note_path: string;
  frontmatter_json: string;
  mtime: string;
  private_to: string | null;
}

/** A row of the household_services projection (Services & Bills ledger, 2026-07-04). */
export interface HouseholdServiceRow {
  id: string;
  vendor: string;
  vendor_anchor: string;
  category: string | null;
  cadence: string | null;
  typical_amount_cents: number | null;
  currency: string;
  autopay: number | null;
  account_hint: string | null;
  status: string;
  confidence: number | null;
  sender_domains_json: string;
  last_bill_date: string | null;
  next_due_estimate: string | null;
  source: string;
  note_path: string;
  frontmatter_json: string;
  mtime: string;
  private_to: string | null;
}

/** A row of the life_events projection (Calendar Knowledge Graph, Phase 3). */
export interface LifeEventRow {
  id: string;
  title: string;
  category: string | null;
  event_date: string | null;
  end_date: string | null;
  location: string | null;
  owner: string | null;
  attribution_confidence: number | null;
  owner_uncertain: number;
  actionable: number;
  source: string;
  source_event_id: string | null;
  note_path: string;
  frontmatter_json: string;
  mtime: string;
  private_to: string | null;
}

export class MemoryClient {
  constructor(private cfg: MemoryClientConfig) {}

  // ── Writes ──────────────────────────────────────────────────────────────

  /**
   * Paths already warned about an unregistered note type — warn ONCE per
   * path per process, not on every re-write of the same note.
   */
  private _unknown_type_warned = new Set<string>();

  // ── Per-user profile / facets ────────────────────────────────────────────
  // Lazily-constructed (self-contained table) so callers reach it via
  // `memory.user_profiles` without threading a new store through wiring. The
  // facet POLICY lives in the store module (pure fns); MemoryClient just holds
  // the handle + a convenience read for the hot path (pull_brief_context).
  private _user_profiles?: UserProfileStore;

  /** The per-user profile/facets store (created on first access). */
  get user_profiles(): UserProfileStore {
    return (this._user_profiles ??= new UserProfileStore(this.cfg.db));
  }

  private _home_map?: HomeMapStore;

  /** The house geometry + camera/BLE overlay store (created on first
   *  access). Read path for tools that resolve places to cameras
   *  (unifi_camera_view); writes stay on the /home_map routes. */
  get home_map(): HomeMapStore {
    return (this._home_map ??= new HomeMapStore(this.cfg.db));
  }

  /** The stored per-user profile row, or null if the user has none yet. */
  get_user_profile(user_id: string): StoredProfile | null {
    return this.user_profiles.get(user_id);
  }

  // ── Household Knowledge Graph (2026-06-20) ────────────────────────────────
  // The typed/inferred edge store (owned-by, purchased-from, …). The good
  // NODES live as projected household_good vault notes (people/places pattern);
  // these are the EDGES the enricher derives. Lazy, self-contained table.
  private _knowledge_edges?: KnowledgeEdges;

  /** The typed Household Knowledge Graph edge store (created on first access). */
  get knowledge_edges(): KnowledgeEdges {
    return (this._knowledge_edges ??= new KnowledgeEdges(this.cfg.db));
  }

  // ── Media Archive (2026-07-11) ────────────────────────────────────────────
  private _media_jobs?: MediaArchiveJobStore;

  /** The Media Archive runner ledger (created on first access). */
  get media_jobs(): MediaArchiveJobStore {
    return (this._media_jobs ??= new MediaArchiveJobStore(this.cfg.db));
  }

  // ── Capability demand (2026-07-14) ────────────────────────────────────────
  // The tool-surface miss ledger — the runtime records forbidden/unknown/
  // load_tools misses here (best-effort) and Kate reads the clustered gap
  // report via read_capability_demand. Lazy, self-contained table.
  private _capability_demand?: CapabilityDemandStore;

  /** The capability-demand miss ledger (created on first access). */
  get capability_demand(): CapabilityDemandStore {
    return (this._capability_demand ??= new CapabilityDemandStore(this.cfg.db));
  }

  /**
   * Household goods visible to the caller, newest-purchase first. Reads the
   * `household_goods` projection (populated by the ingestor from household_good
   * notes). Cordon-filtered — the owner has NO god-view of a member's personal
   * good.
   */
  query_household_goods(opts: {
    caller: Caller;
    status?: 'active' | 'returned' | 'retired';
    limit?: number;
  }): HouseholdGoodRow[] {
    const clauses: string[] = [];
    const params: Record<string, SqlBind> = {};
    if (opts.status) {
      clauses.push('status = @status');
      params['@status'] = opts.status;
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = this.cfg.db
      .prepare(`SELECT * FROM household_goods ${where} ORDER BY purchase_date DESC, mtime DESC`)
      .all(params) as HouseholdGoodRow[];
    return rows
      .filter((r) => note_visible_to_caller(r.private_to ?? undefined, opts.caller))
      .slice(0, opts.limit ?? 100);
  }

  /**
   * `shared_with` for a projected note row (media sharing, 2026-07-29). Two
   * sources:
   *
   *   - `'projected'` — the row's own `frontmatter_json`. Free (already in
   *     memory), but it only reflects the ingestor's last reproject, so it
   *     lags BOTH directions of a share edit.
   *   - `'live'` — the note on disk (the source of truth the share verb
   *     writes). One file read, always current.
   *
   * Never used as a grant on its own: see `note_row_visible_to_caller` for how
   * the two are combined (projected = candidate, live = the authority).
   */
  private _shared_with_of(
    note_path: string,
    frontmatter_json: string | null | undefined,
    source: 'projected' | 'live',
  ): string[] {
    try {
      const fm =
        source === 'live'
          ? this.read_note(note_path)?.frontmatter
          : (JSON.parse(frontmatter_json ?? 'null') as Record<string, unknown> | null);
      return parse_shared_with(fm?.shared_with);
    } catch {
      return []; // unreadable/unparseable → no grants (never a wider grant)
    }
  }

  /**
   * THE visibility rule for a note identified only by its path, answered from
   * the LIVE note on disk: cordon OR named grant, both fields read together so
   * a share (or a revoke) written a moment ago is honoured on the very next
   * call with no reprojection in between.
   *
   * This is the same source `_chunk_gates` picked for RAG, and deliberately so:
   * a path-only caller has no projected row to use as a cheap candidate filter,
   * so there is nothing to trade the file read against — and picking the
   * projection here would make a revoke lag on a surface where the RAG gate
   * beside it does not. An unreadable note resolves owner-only (fail-closed),
   * identical to an unstamped one.
   */
  note_path_visible_to_caller(note_path: string, caller: Caller): boolean {
    let fm: Record<string, unknown> | undefined;
    try {
      fm = this.read_note(note_path)?.frontmatter as Record<string, unknown> | undefined;
    } catch {
      fm = undefined; // unreadable → fail-closed via the unset-cordon default
    }
    return note_frontmatter_visible_to_caller(fm, caller);
  }

  /**
   * THE visibility rule for a PROJECTED row (a `media_items` / `clippings` /…
   * row carrying `private_to` + `frontmatter_json`), for the LIST reads:
   * candidate-then-confirm.
   *
   * **A grant may lag; a REVOCATION may not.** The share verb writes the note;
   * the projection is rewritten asynchronously by the ingestor. So the
   * projection is only ever consulted as a free CANDIDATE filter, and the grant
   * it claims is then CONFIRMED against the live note before it is honoured.
   * That keeps the perf property a list read needs — the file read is paid only
   * for the rows the projection already claims are shared with this caller, not
   * for every row the cordon rejected — while making an unshare authoritative
   * the instant it is written, even if the ingestor is slow, down, or disabled.
   *
   * The residual asymmetry is deliberate: a NEW grant reaches a list read on
   * the ingestor's next reproject (seconds), because a candidate set that
   * doesn't name you has nothing to confirm. Erring that way costs a few
   * seconds of latency; erring the other way is an exposure. Single-item reads
   * don't pay it at all — they use `note_path_visible_to_caller` (or
   * `source: 'live'`), one row, one read, instant.
   */
  note_row_visible_to_caller(
    row: { note_path: string; private_to?: string | null; frontmatter_json?: string | null },
    caller: Caller,
  ): boolean {
    if (note_visible_to_caller(row.private_to ?? undefined, caller)) return true;
    // A named grant can only ever match an identified caller — skip the
    // frontmatter read entirely for a user-less system pass.
    if (!caller.user_id) return false;
    if (
      !this._shared_with_of(row.note_path, row.frontmatter_json, 'projected')
        .includes(caller.user_id)
    ) {
      return false; // the projection doesn't even claim a grant → nothing to confirm
    }
    return note_visible_to_caller(
      row.private_to ?? undefined,
      caller,
      this._shared_with_of(row.note_path, row.frontmatter_json, 'live'),
    );
  }

  /**
   * The media visibility rule — the same one rule as everywhere else, with the
   * source chosen per surface:
   *
   *   - `'projected'` → `note_row_visible_to_caller` (candidate-then-confirm):
   *     the LIST reads (browse/recent), which walk every row.
   *   - `'live'` → the SINGLE-item reads (item/stream/thumb/captions/progress
   *     and the RAG note_path join). One row, so skip the candidate step and
   *     read the note directly: a share works the instant it lands, with no
   *     reprojection at all.
   *
   * Both branches end at `note_visible_to_caller`, so the rule itself lives in
   * exactly one place. See `note_row_visible_to_caller` for why a grant may lag
   * a list read while a revocation may never lag anything.
   */
  private _media_visible(row: MediaItemRow, caller: Caller, source: 'projected' | 'live'): boolean {
    if (source === 'projected') return this.note_row_visible_to_caller(row, caller);
    if (note_visible_to_caller(row.private_to ?? undefined, caller)) return true;
    // A named grant can only ever match an identified caller — skip the
    // frontmatter read entirely for a user-less system pass.
    if (!caller.user_id) return false;
    return note_visible_to_caller(
      row.private_to ?? undefined,
      caller,
      this._shared_with_of(row.note_path, row.frontmatter_json, 'live'),
    );
  }

  /**
   * Media items visible to the caller, newest-archived first. Reads the
   * media_items projection (populated from media_item notes). Cordon-filtered —
   * the owner has NO god-view; an NSFW item stamped private_to the owner is
   * invisible to a household member. An item explicitly `shared_with` the
   * caller is visible once the projection has caught up, and stops being
   * visible the moment the grant is revoked (candidate-then-confirm — see
   * `_media_visible`).
   */
  query_media_items(opts: { caller: Caller; kind?: string; limit?: number }): MediaItemRow[] {
    const clauses: string[] = [];
    const params: Record<string, SqlBind> = {};
    if (opts.kind) {
      clauses.push('media_kind = @kind');
      params['@kind'] = opts.kind;
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = this.cfg.db
      .prepare(`SELECT * FROM media_items ${where} ORDER BY archived_at DESC, mtime DESC`)
      .all(params) as MediaItemRow[];
    return rows
      .filter((r) => this._media_visible(r, opts.caller, 'projected'))
      .slice(0, opts.limit ?? 200);
  }

  /** A single media item by id, cordon-checked (returns null when not visible → 404-shape). */
  get_media_item(id: string, caller: Caller): MediaItemRow | null {
    const row = this.cfg.db
      .prepare('SELECT * FROM media_items WHERE id = @id')
      .get({ '@id': id }) as MediaItemRow | undefined;
    if (row == null) return null;
    return this._media_visible(row, caller, 'live') ? row : null;
  }

  /** A media item by its wrapper note_path, cordon-checked (used to join RAG hits). */
  get_media_item_by_note_path(note_path: string, caller: Caller): MediaItemRow | null {
    const row = this.cfg.db
      .prepare('SELECT * FROM media_items WHERE note_path = @note_path')
      .get({ '@note_path': note_path }) as MediaItemRow | undefined;
    if (row == null) return null;
    return this._media_visible(row, caller, 'live') ? row : null;
  }

  /** Active goods whose RETURN window closes within `within_days` (today..+N),
   *  cordon-filtered. Powers the return-window-closing reactive trigger. */
  goods_with_return_window_closing(
    within_days: number,
    caller: Caller,
    now: Date = new Date(),
    tz?: string,
  ): HouseholdGoodRow[] {
    return this._goods_in_date_window('return_window_until', within_days, caller, now, tz);
  }

  /** Active goods whose WARRANTY expires within `within_days` (today..+N),
   *  cordon-filtered. Powers the warranty-expiring reactive trigger. */
  goods_with_warranty_expiring(
    within_days: number,
    caller: Caller,
    now: Date = new Date(),
    tz?: string,
  ): HouseholdGoodRow[] {
    return this._goods_in_date_window('warranty_until', within_days, caller, now, tz);
  }

  /**
   * SYSTEM scan (uncordoned) for goods whose return window OR warranty closes
   * within `within_days` — for Kate's background followup job, which then files
   * a proposal PER GOOD scoped to that good's own cordon. Returns one entry per
   * (good, kind). Not for user-facing reads — use the cordoned `goods_with_*`
   * methods there.
   */
  goods_needing_followup(
    within_days: number,
    now: Date = new Date(),
    tz?: string,
  ): Array<{ good: HouseholdGoodRow; kind: 'return_window' | 'warranty'; due_date: string }> {
    const today = local_iso_date(now, tz);
    const until = local_iso_date(new Date(now.getTime() + within_days * 86_400_000), tz);
    const out: Array<{ good: HouseholdGoodRow; kind: 'return_window' | 'warranty'; due_date: string }> = [];
    for (const col of ['return_window_until', 'warranty_until'] as const) {
      const rows = this.cfg.db
        .prepare(
          `SELECT * FROM household_goods
           WHERE status = 'active' AND ${col} IS NOT NULL
             AND ${col} >= @today AND ${col} <= @until
           ORDER BY ${col} ASC`,
        )
        .all({ '@today': today, '@until': until }) as HouseholdGoodRow[];
      for (const good of rows) {
        const due = col === 'return_window_until' ? good.return_window_until : good.warranty_until;
        if (due) out.push({ good, kind: col === 'return_window_until' ? 'return_window' : 'warranty', due_date: due });
      }
    }
    return out;
  }

  private _goods_in_date_window(
    column: 'return_window_until' | 'warranty_until',
    within_days: number,
    caller: Caller,
    now: Date,
    tz?: string,
  ): HouseholdGoodRow[] {
    const today = local_iso_date(now, tz);
    const until = local_iso_date(new Date(now.getTime() + within_days * 86_400_000), tz);
    // Column is an ISO date string (YYYY-MM-DD) → lexicographic compare is correct.
    const rows = this.cfg.db
      .prepare(
        `SELECT * FROM household_goods
         WHERE status = 'active' AND ${column} IS NOT NULL
           AND ${column} >= @today AND ${column} <= @until
         ORDER BY ${column} ASC`,
      )
      .all({ '@today': today, '@until': until }) as HouseholdGoodRow[];
    return rows.filter((r) => note_visible_to_caller(r.private_to ?? undefined, caller));
  }

  // ── Services & Bills ledger (2026-07-04) ──────────────────────────────────
  // The household_services projection (populated by the ingestor from
  // household_service notes Kate's weekly learner writes). Mirrors the
  // household_goods query surface.

  /**
   * Household services visible to the caller. Reads the `household_services`
   * projection. Cordon-filtered — the owner has NO god-view of a member's
   * personal (friend-siloed) service.
   */
  query_household_services(opts: {
    caller: Caller;
    status?: 'active' | 'lapsed' | 'uncertain';
    category?: string;
    limit?: number;
  }): HouseholdServiceRow[] {
    const clauses: string[] = [];
    const params: Record<string, SqlBind> = {};
    if (opts.status) {
      clauses.push('status = @status');
      params['@status'] = opts.status;
    }
    if (opts.category) {
      clauses.push('category = @category');
      params['@category'] = opts.category;
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = this.cfg.db
      .prepare(`SELECT * FROM household_services ${where} ORDER BY vendor ASC, mtime DESC`)
      .all(params) as HouseholdServiceRow[];
    return rows
      .filter((r) => note_visible_to_caller(r.private_to ?? undefined, opts.caller))
      .slice(0, opts.limit ?? 100);
  }

  /**
   * Active services whose estimated next bill lands within `within_days`
   * (today..+N), cordon-filtered, soonest first. Powers the working-memory
   * "Bills & services" section + the household_services read tool's bills
   * picture. Takes the caller's `now` (never the host clock) so scans and
   * smokes ground deterministically.
   */
  services_with_upcoming_bills(
    within_days: number,
    caller: Caller,
    now: Date = new Date(),
    tz?: string,
  ): HouseholdServiceRow[] {
    const today = local_iso_date(now, tz);
    const until = local_iso_date(new Date(now.getTime() + within_days * 86_400_000), tz);
    // Column is an ISO date string (YYYY-MM-DD) → lexicographic compare is correct.
    const rows = this.cfg.db
      .prepare(
        `SELECT * FROM household_services
         WHERE status = 'active' AND next_due_estimate IS NOT NULL
           AND next_due_estimate >= @today AND next_due_estimate <= @until
         ORDER BY next_due_estimate ASC`,
      )
      .all({ '@today': today, '@until': until }) as HouseholdServiceRow[];
    return rows.filter((r) => note_visible_to_caller(r.private_to ?? undefined, caller));
  }

  /**
   * SYSTEM scan (uncordoned) over ACTIVE ledger rows for the expected-bills
   * probe — mirrors goods_needing_followup: the background job sees every
   * service and scopes each derived proposal to the row's OWN cordon. Not
   * for user-facing reads — those go through query_household_services.
   */
  services_for_bill_scan(): HouseholdServiceRow[] {
    return this.cfg.db
      .prepare(`SELECT * FROM household_services WHERE status = 'active' ORDER BY vendor ASC`)
      .all() as HouseholdServiceRow[];
  }

  // ── Calendar Knowledge Graph (Phase 3, 2026-06-20) ────────────────────────
  // The life_events projection (populated by the ingestor from life_event vault
  // notes the CalendarSource writes). Mirrors the household_goods query surface.

  /**
   * List life_events matching the filter, cordon-filtered for the caller. Used
   * by the running-picture reads (NOT the followup scan, which is uncordoned).
   */
  query_life_events(opts: {
    caller: Caller;
    category?: string;
    owner?: string;
    /** event_date >= this ISO date (inclusive). */
    since?: string;
    /** event_date <= this ISO date (inclusive). */
    until?: string;
    actionable?: boolean;
  }): LifeEventRow[] {
    const clauses: string[] = [];
    const binds: Record<string, SqlBind> = {};
    if (opts.category) { clauses.push('category = @category'); binds['@category'] = opts.category; }
    if (opts.owner) { clauses.push('owner = @owner'); binds['@owner'] = opts.owner; }
    if (opts.since) { clauses.push('event_date >= @since'); binds['@since'] = opts.since; }
    if (opts.until) { clauses.push('event_date <= @until'); binds['@until'] = opts.until; }
    if (opts.actionable !== undefined) { clauses.push('actionable = @actionable'); binds['@actionable'] = opts.actionable ? 1 : 0; }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    return (this.cfg.db
      .prepare(`SELECT * FROM life_events ${where} ORDER BY event_date ASC, mtime DESC`)
      .all(binds) as LifeEventRow[])
      .filter((r) => note_visible_to_caller(r.private_to ?? undefined, opts.caller));
  }

  /** Upcoming life_events within [today, today+within_days], cordon-filtered. */
  events_within(
    within_days: number,
    caller: Caller,
    now: Date = new Date(),
    tz?: string,
  ): LifeEventRow[] {
    const today = local_iso_date(now, tz);
    const until = local_iso_date(new Date(now.getTime() + within_days * 86_400_000), tz);
    // event_date may be a full ISO datetime; compare on the date prefix.
    const rows = this.cfg.db
      .prepare(
        `SELECT * FROM life_events
         WHERE event_date IS NOT NULL
           AND substr(event_date, 1, 10) >= @today AND substr(event_date, 1, 10) <= @until
         ORDER BY event_date ASC`,
      )
      .all({ '@today': today, '@until': until }) as LifeEventRow[];
    return rows.filter((r) => note_visible_to_caller(r.private_to ?? undefined, caller));
  }

  /**
   * SYSTEM scan (uncordoned) for actionable life_events whose START falls within
   * `within_days` of now, of the given categories — for Kate's calendar-followup
   * background job, which then files a proposal PER EVENT scoped to that event's
   * own cordon (the owner has no god-view of a member's personal event). Returns
   * one entry per matching event. Birthdays are NOT here — they come from the
   * people table via `upcoming_dates` (the gift loop reads likes/budget there).
   */
  life_events_needing_followup(
    categories: string[],
    within_days: number,
    now: Date = new Date(),
    tz?: string,
  ): Array<{ event: LifeEventRow; due_date: string }> {
    if (categories.length === 0) return [];
    const today = local_iso_date(now, tz);
    const until = local_iso_date(new Date(now.getTime() + within_days * 86_400_000), tz);
    const placeholders = categories.map((_, i) => `@c${i}`).join(', ');
    const binds: Record<string, SqlBind> = { '@today': today, '@until': until };
    categories.forEach((c, i) => { binds[`@c${i}`] = c; });
    const rows = this.cfg.db
      .prepare(
        `SELECT * FROM life_events
         WHERE actionable = 1 AND category IN (${placeholders})
           AND event_date IS NOT NULL
           AND substr(event_date, 1, 10) >= @today AND substr(event_date, 1, 10) <= @until
         ORDER BY event_date ASC`,
      )
      .all(binds) as LifeEventRow[];
    return rows
      .filter((r) => r.event_date)
      .map((event) => ({ event, due_date: local_iso_date(new Date(event.event_date!), tz) }));
  }

  /**
   * People whose birthday falls within [today, today+within_days], computed
   * against the provided `now` — DETERMINISTIC, unlike `upcoming_dates`, which
   * reads the host clock. Powers the birthday→gift reactive trigger (the scan
   * needs ctx.now, and a smoke needs a fixed clock). Year-agnostic on MM-DD.
   *
   * NON-CONTACTS ARE EXCLUDED (2026-07-29). This feeds the GIFT loop, so an
   * ancestor's or a public figure's birthday reaching it would offer to buy a
   * present for someone the household has no relationship with. `is_non_contact`
   * is the shared predicate the Friends tab and the brief already use — it was
   * simply never applied here.
   */
  birthdays_within(
    within_days: number,
    now: Date = new Date(),
  ): Array<{ person_id: string; name: string; note_path: string; date: string; days_until: number }> {
    const today = new Date(now);
    today.setHours(0, 0, 0, 0); // local-day anchor for year-agnostic birthday math (mirrors upcoming_dates)
    const rows = this.cfg.db
      .prepare(
        `SELECT id, name, relationship, birthday, frontmatter_json, note_path
           FROM people WHERE birthday IS NOT NULL`,
      )
      .all() as Array<{
      id: string;
      name: string;
      relationship: string;
      birthday: string | null;
      frontmatter_json: string;
      note_path: string;
    }>;
    const out: Array<{ person_id: string; name: string; note_path: string; date: string; days_until: number }> = [];
    for (const r of rows) {
      if (!r.birthday) continue;
      if (is_non_contact(r)) continue;
      const d = days_until(r.birthday, today);
      if (d !== null && d >= 0 && d <= within_days) {
        out.push({ person_id: r.id, name: r.name, note_path: r.note_path, date: r.birthday, days_until: d });
      }
    }
    out.sort((a, b) => a.days_until - b.days_until);
    return out;
  }

  /**
   * SYSTEM scan (uncordoned): ALL life_events whose START falls within
   * [today, today+within_days], regardless of `actionable` or cordon — for
   * Kate's cross-signal scan, which applies its OWN category/overlap logic and
   * files each proposal scoped to the event's own cordon. The owner has no
   * god-view; this is a system read, not a user-facing one (mirrors
   * `life_events_needing_followup` / `goods_needing_followup`).
   */
  upcoming_life_events_uncordoned(
    within_days: number,
    now: Date = new Date(),
    tz?: string,
  ): LifeEventRow[] {
    const today = local_iso_date(now, tz);
    const until = local_iso_date(new Date(now.getTime() + within_days * 86_400_000), tz);
    return this.cfg.db
      .prepare(
        `SELECT * FROM life_events
         WHERE event_date IS NOT NULL
           AND substr(event_date, 1, 10) >= @today AND substr(event_date, 1, 10) <= @until
         ORDER BY event_date ASC`,
      )
      .all({ '@today': today, '@until': until }) as LifeEventRow[];
  }

  /**
   * All People with their occasion dates (birthday from the column +
   * anniversaries from frontmatter), for the cross-signal coincidence scan.
   * Uncordoned (People are the household-shared graph). Year-agnostic dates as
   * stored (YYYY-MM-DD or MM-DD).
   *
   * NON-CONTACTS ARE EXCLUDED (2026-07-29), same reason as `birthdays_within`:
   * the coincidence scan turns an occasion into a gift/plan offer, and an
   * ancestor or a public figure has no occasion the household observes.
   */
  people_occasions(): Array<{
    person_id: string;
    name: string;
    note_path: string;
    relationship: string;
    occasions: Array<{ kind: 'birthday' | 'anniversary'; date: string; what?: string }>;
  }> {
    const rows = this.cfg.db
      .prepare(`SELECT id, name, relationship, birthday, frontmatter_json, note_path FROM people`)
      .all() as Array<{
      id: string;
      name: string;
      relationship: string;
      birthday: string | null;
      frontmatter_json: string;
      note_path: string;
    }>;
    const out: Array<{
      person_id: string;
      name: string;
      note_path: string;
      relationship: string;
      occasions: Array<{ kind: 'birthday' | 'anniversary'; date: string; what?: string }>;
    }> = [];
    for (const r of rows) {
      if (is_non_contact(r)) continue;
      const occasions: Array<{ kind: 'birthday' | 'anniversary'; date: string; what?: string }> = [];
      if (r.birthday) occasions.push({ kind: 'birthday', date: r.birthday });
      try {
        const fm = JSON.parse(r.frontmatter_json) as {
          anniversaries?: Array<{ date?: string; what?: string }>;
        };
        for (const ann of fm.anniversaries ?? []) {
          if (ann?.date) occasions.push({ kind: 'anniversary', date: ann.date, what: ann.what });
        }
      } catch {
        /* frontmatter unparseable — birthday (column) still counts */
      }
      if (occasions.length > 0) {
        out.push({ person_id: r.id, name: r.name, note_path: r.note_path, relationship: r.relationship, occasions });
      }
    }
    return out;
  }

  /**
   * Persist the distilled per-user REGISTER profile (how they like to be talked
   * to) into the profile row's detail. Read every chat turn by the house-voice
   * block; written by the user-style learning loop (src/core/user_style.ts).
   * Merges — preserves facets + other detail.
   */
  set_user_style_profile(user_id: string, style_profile: string): void {
    this.user_profiles.set_style_profile(user_id, style_profile);
  }

  /** Create or update a note with the given frontmatter and body. */
  upsert_note(
    rel_path: string,
    frontmatter: Record<string, unknown>,
    body: string,
  ): void {
    // Contract check, warn-only: a `type:` outside the note-type
    // registry still writes (a vault write must never be lost to a
    // missing registry line), but it surfaces ONCE as an audit row so
    // the new type gets a deliberate registry decision instead of
    // becoming the next silent writer/projector drift (the 2,501
    // validation_failed rows/week class, 2026-06-09).
    const note_type = frontmatter.type;
    if (
      typeof note_type === 'string' &&
      !is_known_note_type(note_type) &&
      !this._unknown_type_warned.has(rel_path)
    ) {
      this._unknown_type_warned.add(rel_path);
      try {
        this.log_action({
          intent_id: ulid(),
          agent: 'orchestrator',
          tool_name: 'unknown_note_type_write',
          tool_input: { note_path: rel_path, note_type },
          error:
            `frontmatter type '${note_type}' is not in the note-type ` +
            `registry (src/memory/schemas/note_types.ts). The write ` +
            `succeeded, but the ingestor will not project it. Known types: ` +
            `${known_note_types().join(', ')}.`,
        });
      } catch {
        // Best-effort — never block a vault write on audit plumbing.
      }
    }

    const abs_path = this.resolve_vault_path(rel_path);
    mkdirSync(dirname(abs_path), { recursive: true });

    if (existsSync(abs_path)) {
      const parsed = matter(readFileSync(abs_path, 'utf8'));
      const merged_fm = { ...parsed.data, ...frontmatter };
      const new_body = body || parsed.content;
      writeFileSync(abs_path, matter.stringify(new_body, merged_fm), 'utf8');
    } else {
      writeFileSync(abs_path, matter.stringify(body, frontmatter), 'utf8');
    }
  }

  /** Append text to the body of an existing note (or create with empty frontmatter). */
  append_to_note(rel_path: string, body_append: string): void {
    const abs_path = this.resolve_vault_path(rel_path);
    if (!existsSync(abs_path)) {
      mkdirSync(dirname(abs_path), { recursive: true });
      writeFileSync(abs_path, matter.stringify(body_append, {}), 'utf8');
      return;
    }
    // O(1) append — never read-modify-write. Appending to the end of the
    // file IS appending to the body (frontmatter lives at the top), so the
    // gray-matter round-trip is unnecessary — and on `log_action`'s daily
    // audit file it was catastrophic: every audit event re-parsed and
    // re-serialized the whole multi-MB file, and the ingestor's startup
    // rebuild (one audit line per projected note × 4.5k notes) churned
    // allocations faster than GC reclaimed them, OOMing the host once the
    // day file crossed ~4 MB (2026-07-16 incident).
    appendFileSync(abs_path, `\n${body_append}\n`, 'utf8');
  }

  /** Delete a note's vault file (idempotent — absent file is a no-op). The
   *  ingestor unprojects on the unlink event; callers that need the office to
   *  reflect it immediately also clear the projection synchronously (see
   *  purge_person). The single vault-owning delete path — never unlink from a tool. */
  delete_note(rel_path: string): void {
    rmSync(this.resolve_vault_path(rel_path), { force: true });
  }

  // ── Audit ───────────────────────────────────────────────────────────────

  /** Append a record to both the SQLite audit_log and the daily markdown audit file. */
  log_action(record: Omit<AuditRecord, 'id' | 'ts'>): string {
    const id = ulid();
    const ts = new Date().toISOString();
    const full: AuditRecord = { id, ts, ...record };

    // The exact AS-STORED column values — used for BOTH the row_hash and the
    // binds, so the verifier (reading these columns back) recomputes the
    // identical hash.
    const fields: AuditChainFields = {
      id: full.id,
      ts: full.ts,
      intent_id: full.intent_id,
      agent: full.agent,
      tool_name: full.tool_name,
      tool_input: JSON.stringify(full.tool_input),
      gate_decision: full.gate_decision ? JSON.stringify(full.gate_decision) : null,
      execution_result:
        full.execution_result !== undefined ? JSON.stringify(full.execution_result) : null,
      human_verdict: full.human_verdict ? JSON.stringify(full.human_verdict) : null,
      cost: full.cost ? JSON.stringify(full.cost) : null,
      error: full.error ?? null,
      user_id: full.user_id ?? null,
      subject_user_id: full.subject_user_id ?? null,
    };

    // 1. SQLite — tamper-evident chained insert, fail-open to a plain insert.
    this._insert_audit_row(fields);

    // 2. Daily markdown audit file
    const day = full.ts.slice(0, 10);
    const audit_rel = `System/Audit/${day}.md`;
    const outcome = full.error
      ? `ERROR: ${full.error}`
      : (full.gate_decision?.decision ?? 'executed');
    const line = `- **${full.ts}** \`${full.agent}/${full.tool_name}\` → ${outcome} _(audit_id: ${full.id})_`;
    this.append_to_note(audit_rel, line);

    return id;
  }

  /**
   * Insert one audit row, hash-chained when enabled (Phase 1b). The chain is
   * computed inside a `BEGIN IMMEDIATE` transaction so the head-read + insert
   * are atomic across the orchestrator / ingestor / scheduler processes that
   * share this DB. **Fail-open is absolute:** any chain error falls through to
   * the original plain insert — an audit row is never lost or blocked on chain
   * logic. (When already inside a caller's transaction we skip BEGIN/COMMIT;
   * cross-process atomicity in that rare nested case is best-effort, and a
   * resulting fork is reported by the verifier, never crashes a write.)
   */
  private _insert_audit_row(f: AuditChainFields): void {
    const db = this.cfg.db;
    const run_insert = (prev_hash: string | null, row_hash: string | null): void => {
      db.prepare(
        `INSERT INTO audit_log
         (id, ts, intent_id, agent, tool_name, tool_input, gate_decision,
          execution_result, human_verdict, cost, error, user_id, subject_user_id,
          prev_hash, row_hash)
         VALUES
         (@id, @ts, @intent_id, @agent, @tool_name, @tool_input, @gate_decision,
          @execution_result, @human_verdict, @cost, @error, @user_id, @subject_user_id,
          @prev_hash, @row_hash)`,
      ).run({
        '@id': f.id,
        '@ts': f.ts,
        '@intent_id': f.intent_id,
        '@agent': f.agent,
        '@tool_name': f.tool_name,
        '@tool_input': f.tool_input,
        '@gate_decision': f.gate_decision,
        '@execution_result': f.execution_result,
        '@human_verdict': f.human_verdict,
        '@cost': f.cost,
        '@error': f.error,
        '@user_id': f.user_id,
        '@subject_user_id': f.subject_user_id,
        '@prev_hash': prev_hash,
        '@row_hash': row_hash,
      });
    };

    if (audit_chain_enabled()) {
      const already = db.inTransaction;
      try {
        if (!already) db.exec('BEGIN IMMEDIATE');
        try {
          const head = db
            .prepare(
              `SELECT row_hash FROM audit_log WHERE row_hash IS NOT NULL ORDER BY rowid DESC LIMIT 1`,
            )
            .get() as { row_hash: string } | undefined;
          const prev = head?.row_hash ?? GENESIS_HASH;
          run_insert(prev, chain_row_hash(prev, f));
          if (!already) db.exec('COMMIT');
          return;
        } catch (e) {
          if (!already) {
            try {
              db.exec('ROLLBACK');
            } catch {
              /* ignore */
            }
          }
          throw e;
        }
      } catch {
        // Fail-open — fall through to the plain insert below. The failed
        // chained attempt inserted nothing (INSERT is atomic), so this is clean.
      }
    }
    run_insert(null, null);
  }

  /**
   * Raw `execution_result` payloads from THIS turn's audited calls to the
   * named (read) tools — the evidence substrate for write-side grounding
   * gates. A claim-shaped write (Ruby's `record_civic_item`
   * announcement/agenda_item, `record_politics_item` fact-kinds) must
   * carry a verbatim `evidence_quote`, and the gate checks it appears in
   * something the turn ACTUALLY read — the audit log already stores every
   * fetch's full result, so the check is deterministic and costs no
   * re-fetch. (The 2026-06-10 StreetMedia fabrication: a degraded pass
   * recorded a "June 16 work session review" announcement whose cited page
   * — fetched that same turn, stored verbatim here — contained no such
   * thing. The reply-side critics never see tool ARGUMENTS; this read is
   * what lets the write chokepoint see the turn's evidence.)
   */
  audit_evidence_for_intent(intent_id: string, tool_names: readonly string[]): string[] {
    if (tool_names.length === 0) return [];
    const placeholders = tool_names.map((_, i) => `@t${i}`).join(', ');
    const params: Record<string, string> = { '@i': intent_id };
    tool_names.forEach((t, i) => {
      params[`@t${i}`] = t;
    });
    const rows = this.cfg.db
      .prepare(
        `SELECT execution_result FROM audit_log
          WHERE intent_id = @i AND tool_name IN (${placeholders})
            AND execution_result IS NOT NULL
          ORDER BY ts LIMIT 200`,
      )
      .all(params) as Array<{ execution_result: string }>;
    return rows.map((r) => r.execution_result);
  }

  // ── Retrieval (stubs until Pass 4 ingestor) ─────────────────────────────

  retrieve(_params: RetrieveParams): Promise<RetrieveHit[]> {
    throw new Error(
      'retrieve() requires the ingestor — not yet implemented in v0 vertical slice (Pass 4)',
    );
  }

  /**
   * Lightweight scoped FTS retrieval — the "hot path" for turn-time
   * RAG. Runs an FTS5 MATCH against `chunks_fts`, filters results to
   * paths matching the supplied glob scope, and returns top-K by
   * relevance.
   *
   * The query is sanitized for FTS5 (dropping bareword operators) so
   * user messages can flow through directly without crashing the
   * parser. Returns [] on syntax error rather than throwing —
   * retrieval is opportunistic, not load-bearing.
   *
   * Embedding-based retrieval + RRF rerank is the eventual Pass-7
   * upgrade; this gets us 80% of the value today.
   */
  retrieve_scoped_chunks(opts: {
    query: string;
    knowledge_scope: string[];
    k?: number;
    /**
     * Phase 2b — the calling user's id and tier. Together with the
     * note's `private_to` frontmatter, these determine visibility via
     * the pure cordon in `note_visible_to_caller` (no owner bypass):
     *
     *   - `private_to` unset → owner-only (fail-closed default since the
     *     2026-06-04 backfill; a forgotten stamp hides, never leaks).
     *   - `'owner'`     → owner tier only.
     *   - `'household'` → owner + household.
     *   - `<user_id>`   → that user only — STRICTLY, even the owner does
     *     not see another user's personal note through retrieval.
     *
     * The owner's "what has <user> been up to" reach is NOT here; it is
     * the explicit, audited `review_user_activity` oversight tool.
     *
     * `bypass_private: true` is for **system/product reads only** — e.g.
     * Kristi's product-catalog shelf tools, which read curated
     * non-personal data and must ignore per-note scoping. It is NOT a
     * specialist privilege (Kate no longer uses it); never set it on a
     * path that retrieves users' personal notes.
     */
    user_id?: string;
    user_tier?: Tier;
    bypass_private?: boolean;
  }): ScopedChunkHit[] {
    const k = opts.k ?? 5;
    const tokens = _sanitize_fts_tokens(opts.query);
    if (tokens.length === 0) return [];

    const { in_scope, visible_to_user, meta_for } = this._chunk_gates(opts);

    // Try AND first (most precise). If that returns zero in-scope
    // results, fall back to OR (BM25-ranked by how many tokens hit
    // and how rare they are). The AND-first / OR-fallback hybrid
    // beats either alone: AND when keywords are crisp, OR when the
    // user's natural-language question doesn't word-match the doc.
    const try_query = (
      q: string,
    ): Array<{ note_path: string; chunk_idx: number; chunk_text: string; rank: number }> => {
      try {
        return this.cfg.db
          .prepare(
            `SELECT note_path, chunk_idx, chunk_text, rank
             FROM chunks_fts
             WHERE chunks_fts MATCH @q
             ORDER BY rank
             LIMIT @lim`,
          )
          .all({ '@q': q, '@lim': k * 4 }) as Array<{
          note_path: string;
          chunk_idx: number;
          chunk_text: string;
          rank: number;
        }>;
      } catch {
        return [];
      }
    };

    const collect = (
      rows: Array<{ note_path: string; chunk_idx: number; chunk_text: string; rank: number }>,
    ): ScopedChunkHit[] => {
      const out: ScopedChunkHit[] = [];
      for (const r of rows) {
        if (!in_scope(r.note_path)) continue;
        if (!visible_to_user(r.note_path)) continue;
        const meta = meta_for(r.note_path);
        out.push({
          note_path: r.note_path,
          chunk_idx: r.chunk_idx,
          chunk_text: r.chunk_text,
          score: -r.rank,
          trust_tier: meta.trust_tier,
          title: meta.title,
          as_of: meta.as_of,
        });
        if (out.length >= k) break;
      }
      return out;
    };

    // Pass 1: AND (implicit).
    const and_hits = collect(try_query(tokens.join(' ')));
    if (and_hits.length > 0) return and_hits;

    // Pass 2: OR — quote each token to defang FTS5 column-prefix
    // parsing (a bare token "is:" would be interpreted as a column
    // filter and crash).
    const or_query = tokens.map((t) => `"${t}"`).join(' OR ');
    return collect(try_query(or_query));
  }

  /**
   * Scope + visibility + frontmatter-meta gates for chunk retrieval, shared
   * by the FTS path (`retrieve_scoped_chunks`) and the vector path
   * (`vector_search`) so the load-bearing `private_to` cordon is defined
   * exactly ONCE. Returns memoized closures (frontmatter is read per note at
   * most once per query).
   */
  private _chunk_gates(opts: {
    knowledge_scope: string[];
    user_id?: string;
    user_tier?: Tier;
    bypass_private?: boolean;
  }): {
    in_scope: (note_path: string) => boolean;
    visible_to_user: (note_path: string) => boolean;
    meta_for: (note_path: string) => {
      trust_tier: 1 | 2 | null;
      title: string | null;
      as_of: string | null;
    };
  } {
    const matchers = opts.knowledge_scope.map(_glob_to_regex);
    const in_scope = (path: string): boolean =>
      matchers.length === 0 || matchers.some((m) => m.test(path));

    const caller_tier: Tier = opts.user_tier ?? 'owner';
    const note_visibility_cache = new Map<string, boolean>();
    // Frontmatter cache reused for private_to + trust_tier/title — reading
    // the wrapper note is the expensive part; cache by note_path.
    const note_meta_cache = new Map<
      string,
      { trust_tier: 1 | 2 | null; title: string | null; as_of: string | null }
    >();
    const meta_for = (note_path: string) => {
      const hit = note_meta_cache.get(note_path);
      if (hit) return hit;
      let trust_tier: 1 | 2 | null = null;
      let title: string | null = null;
      let as_of: string | null = null;
      try {
        const note = this.read_note(note_path);
        const tt = note?.frontmatter?.trust_tier;
        if (tt === 1 || tt === 2) trust_tier = tt;
        const t = note?.frontmatter?.title;
        if (typeof t === 'string') title = t;
        // When the content is FROM: explicit capture/date frontmatter wins,
        // file mtime is the fallback. Powers the age label on retrieved
        // excerpts so stale facts get qualified, not presented as current.
        const cap = note?.frontmatter?.captured_at ?? note?.frontmatter?.date;
        if (typeof cap === 'string' && cap.length >= 8) {
          as_of = cap;
        } else {
          try {
            as_of = statSync(this.resolve_vault_path(note_path)).mtime.toISOString();
          } catch { /* unreadable — leave null */ }
        }
      } catch { /* opportunistic */ }
      const meta = { trust_tier, title, as_of };
      note_meta_cache.set(note_path, meta);
      return meta;
    };
    // The note's cordon value AND its explicit `shared_with` grants (media
    // sharing, 2026-07-29) — read together from the LIVE note by the ONE rule
    // (`note_path_visible_to_caller`), so a share written a moment ago re-gates
    // this note's chunks on the very next retrieval with no reprojection in
    // between. Cached per call because a query routinely hits several chunks of
    // the same note and reading the wrapper is the expensive part.
    const visible_to_user = (note_path: string): boolean => {
      if (opts.bypass_private) return true;
      const hit = note_visibility_cache.get(note_path);
      if (hit !== undefined) return hit;
      const val = this.note_path_visible_to_caller(note_path, {
        user_id: opts.user_id,
        tier: caller_tier,
      });
      note_visibility_cache.set(note_path, val);
      return val;
    };
    return { in_scope, visible_to_user, meta_for };
  }

  /**
   * Brute-force cosine vector search over `chunk_embeddings`, returning the
   * same `ScopedChunkHit` shape as the FTS path (chunk_text fetched from
   * chunks_fts for the top candidates; `score` is cosine in [-1, 1]).
   *
   * The same `_chunk_gates` cordon applies — a vector hit on another user's
   * private note is dropped exactly as a lexical hit would be. Rows whose
   * stored `dim` ≠ the query vector's length are skipped (a model swap must
   * never score mismatched vectors).
   *
   * Adequate at vault scale (a few ms over thousands of chunks); if the
   * corpus ever outgrows brute force, this is the one method to swap for an
   * ANN index (sqlite-vec / a cache) — the callers are unaffected.
   */
  vector_search(
    query_embedding: number[] | Float32Array,
    opts: {
      knowledge_scope: string[];
      k?: number;
      user_id?: string;
      user_tier?: Tier;
      bypass_private?: boolean;
    },
  ): ScopedChunkHit[] {
    const k = opts.k ?? 5;
    const q = query_embedding instanceof Float32Array
      ? query_embedding
      : Float32Array.from(query_embedding);
    const q_norm = norm(q);
    if (q.length === 0 || q_norm === 0) return [];

    const { in_scope, visible_to_user, meta_for } = this._chunk_gates(opts);

    // Load candidate embeddings. Pre-filter by a LIKE prefix when the scope
    // globs reduce to simple directory prefixes (the common case —
    // `Knowledge/Astrid/**`), so we don't deserialize the whole corpus per
    // query; otherwise load all and filter in JS via `in_scope`.
    const prefixes = _scope_to_like_prefixes(opts.knowledge_scope);
    let rows: Array<{ note_path: string; chunk_idx: number; dim: number; embedding: Uint8Array }>;
    if (prefixes) {
      const where = prefixes.map((_, i) => `note_path LIKE @p${i}`).join(' OR ');
      const params: Record<string, SqlBind> = {};
      prefixes.forEach((p, i) => { params[`@p${i}`] = p; });
      rows = this.cfg.db
        .prepare(`SELECT note_path, chunk_idx, dim, embedding FROM chunk_embeddings WHERE ${where}`)
        .all(params) as typeof rows;
    } else {
      rows = this.cfg.db
        .prepare(`SELECT note_path, chunk_idx, dim, embedding FROM chunk_embeddings`)
        .all() as typeof rows;
    }

    // Cosine-score every in-scope, dimension-matched candidate.
    const scored: Array<{ note_path: string; chunk_idx: number; score: number }> = [];
    for (const r of rows) {
      if (r.dim !== q.length) continue;
      if (!in_scope(r.note_path)) continue;
      const vec = unpack_f32(r.embedding);
      scored.push({
        note_path: r.note_path,
        chunk_idx: r.chunk_idx,
        score: cosine(q, vec, q_norm),
      });
    }
    scored.sort((a, b) => b.score - a.score);

    // Materialize the top candidates: visibility gate + fetch chunk_text +
    // meta. Over-fetch (k*4) before the visibility cut so private drops
    // don't starve the result.
    const text_stmt = this.cfg.db.prepare(
      `SELECT chunk_text FROM chunks_fts WHERE note_path = @p AND chunk_idx = @i LIMIT 1`,
    );
    const out: ScopedChunkHit[] = [];
    for (const s of scored) {
      if (out.length >= k) break;
      if (!visible_to_user(s.note_path)) continue;
      const trow = text_stmt.get({ '@p': s.note_path, '@i': s.chunk_idx }) as
        | { chunk_text: string }
        | undefined;
      if (!trow) continue; // embedding orphaned (chunk_fts row gone) — skip
      const meta = meta_for(s.note_path);
      out.push({
        note_path: s.note_path,
        chunk_idx: s.chunk_idx,
        chunk_text: trow.chunk_text,
        score: s.score,
        trust_tier: meta.trust_tier,
        title: meta.title,
        as_of: meta.as_of,
      });
    }
    return out;
  }

  /**
   * Replace all embedding rows for a note (idempotent re-index). Pass an
   * empty `rows` to just clear. Mirrors the chunks_fts DELETE+INSERT in
   * library.ts `index_chunks`.
   */
  upsert_chunk_embeddings(
    note_path: string,
    rows: Array<{ chunk_idx: number; embedding: number[] | Float32Array }>,
    model: string,
  ): void {
    const ts = new Date().toISOString();
    const del = this.cfg.db.prepare(`DELETE FROM chunk_embeddings WHERE note_path = @p`);
    del.run({ '@p': note_path });
    if (rows.length === 0) return;
    const ins = this.cfg.db.prepare(
      `INSERT INTO chunk_embeddings (note_path, chunk_idx, model, dim, embedding, ts_created)
       VALUES (@p, @i, @m, @d, @e, @t)`,
    );
    for (const r of rows) {
      const f = r.embedding instanceof Float32Array
        ? r.embedding
        : Float32Array.from(r.embedding);
      ins.run({
        '@p': note_path,
        '@i': r.chunk_idx,
        '@m': model,
        '@d': f.length,
        '@e': pack_f32(f),
        '@t': ts,
      });
    }
  }

  /** Drop all embedding rows for a note (called alongside chunks_fts delete). */
  delete_chunk_embeddings(note_path: string): void {
    this.cfg.db.prepare(`DELETE FROM chunk_embeddings WHERE note_path = @p`).run({
      '@p': note_path,
    });
  }

  // ── Synthesis retrieval usage (the Second Brain WORTH axis, loop Phase B) ──
  // A synthesis that's actually retrieved into turns is VALUED; one that never
  // is, is dead weight. `record_synthesis_retrievals` bumps a per-note counter
  // each time it lands in a retrieval top-k; `get_synthesis_usage` feeds
  // score_synthesis's `retrieval_hits` (so worth stops being neutral) and the
  // heal pass's disuse prune. Best-effort: a usage-write failure must never
  // break a turn, so the caller wraps this in a try/catch.

  record_synthesis_retrievals(note_paths: string[], at_iso: string): void {
    if (note_paths.length === 0) return;
    const stmt = this.cfg.db.prepare(
      `INSERT INTO synthesis_usage (note_path, hits, last_retrieved_at)
         VALUES (@p, 1, @at)
       ON CONFLICT(note_path) DO UPDATE SET
         hits = hits + 1,
         last_retrieved_at = @at`,
    );
    for (const p of note_paths) stmt.run({ '@p': p, '@at': at_iso });
  }

  get_synthesis_usage(
    note_paths: string[],
  ): Map<string, { hits: number; last_retrieved_at: string | null }> {
    const out = new Map<string, { hits: number; last_retrieved_at: string | null }>();
    if (note_paths.length === 0) return out;
    const stmt = this.cfg.db.prepare(
      `SELECT hits, last_retrieved_at FROM synthesis_usage WHERE note_path = @p`,
    );
    for (const p of note_paths) {
      const row = stmt.get({ '@p': p }) as
        | { hits: number; last_retrieved_at: string | null }
        | undefined;
      if (row) out.set(p, { hits: row.hits, last_retrieved_at: row.last_retrieved_at });
    }
    return out;
  }

  delete_synthesis_usage(note_path: string): void {
    this.cfg.db.prepare(`DELETE FROM synthesis_usage WHERE note_path = @p`).run({
      '@p': note_path,
    });
  }

  // ── Structured queries against the SQLite projection ───────────────────

  query_people(filter: PersonFilter): PersonRow[] {
    const clauses: string[] = [];
    const params: Record<string, SqlBind> = {};
    if (filter.relationship !== undefined) {
      clauses.push('relationship = @relationship');
      params['@relationship'] = filter.relationship;
    }
    if (filter.friday_managed !== undefined) {
      clauses.push('friday_managed = @friday_managed');
      params['@friday_managed'] = filter.friday_managed ? 1 : 0;
    }
    if (filter.do_not_contact !== undefined) {
      clauses.push('do_not_contact = @do_not_contact');
      params['@do_not_contact'] = filter.do_not_contact ? 1 : 0;
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    return this.cfg.db
      .prepare(`SELECT * FROM people ${where} ORDER BY name`)
      .all(params) as PersonRow[];
  }

  // ── Places ──────────────────────────────────────────────────────────────

  find_place_by_id(id: string): PlaceRow | null {
    const row = this.cfg.db
      .prepare(`SELECT * FROM places WHERE id = @id`)
      .get({ '@id': id }) as PlaceDbRow | undefined;
    return row ? place_row_from_db(row) : null;
  }

  /** Case-insensitive substring match on name OR any alias. Returns the first match. */
  find_place_by_name(name_or_alias: string): PlaceRow | null {
    const needle = name_or_alias.toLowerCase().trim();
    if (!needle) return null;
    const rows = this.cfg.db
      .prepare(`SELECT * FROM places`)
      .all() as PlaceDbRow[];
    for (const r of rows) {
      if (r.name.toLowerCase().includes(needle)) return place_row_from_db(r);
      try {
        const aliases = JSON.parse(r.aliases_json) as string[];
        if (aliases.some((a) => a.toLowerCase().includes(needle))) {
          return place_row_from_db(r);
        }
      } catch {
        /* skip */
      }
    }
    return null;
  }

  /** Spatial lookup: any place within `radius_m` of the point. */
  find_place_by_coords(
    lat: number,
    lon: number,
    radius_m: number,
  ): PlaceRow | null {
    // 1 degree latitude ≈ 111_320 m; longitude shrinks by cos(lat).
    const dlat = radius_m / 111_320;
    const dlon = radius_m / (111_320 * Math.cos((lat * Math.PI) / 180) || 1);
    const rows = this.cfg.db
      .prepare(
        `SELECT * FROM places
         WHERE lat IS NOT NULL AND lon IS NOT NULL
           AND lat BETWEEN @lat_min AND @lat_max
           AND lon BETWEEN @lon_min AND @lon_max`,
      )
      .all({
        '@lat_min': lat - dlat,
        '@lat_max': lat + dlat,
        '@lon_min': lon - dlon,
        '@lon_max': lon + dlon,
      }) as PlaceDbRow[];
    for (const r of rows) {
      if (r.lat == null || r.lon == null) continue;
      const a = { lat, lon };
      const b = { lat: r.lat, lon: r.lon };
      const R = 6_371_000;
      const dLat = ((b.lat - a.lat) * Math.PI) / 180;
      const dLon = ((b.lon - a.lon) * Math.PI) / 180;
      const lat1 = (a.lat * Math.PI) / 180;
      const lat2 = (b.lat * Math.PI) / 180;
      const h =
        Math.sin(dLat / 2) ** 2 +
        Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
      const d = 2 * R * Math.asin(Math.sqrt(h));
      if (d <= radius_m) return place_row_from_db(r);
    }
    return null;
  }

  /** Update only the coords of an existing place (geocode writeback). */
  update_place_coords(id: string, lat: number, lon: number): void {
    this.cfg.db
      .prepare(
        `UPDATE places SET lat = @lat, lon = @lon WHERE id = @id`,
      )
      .run({ '@id': id, '@lat': lat, '@lon': lon });
    // Also update the underlying .md so the vault stays the source of truth.
    const row = this.cfg.db
      .prepare(`SELECT note_path FROM places WHERE id = @id`)
      .get({ '@id': id }) as { note_path: string } | undefined;
    if (row) {
      const parsed = this.read_note(row.note_path);
      if (parsed) {
        const fm = { ...parsed.frontmatter, coords: [lat, lon] };
        this.upsert_note(row.note_path, fm, parsed.body);
      }
    }
  }

  /**
   * Look up a person note by id or name (case-insensitive). Scans the vault
   * People/ directory directly so this works before the ingestor lands and
   * projects rows into the people SQLite table. Returns the first match.
   */
  find_person(criteria: { id?: string; name?: string }): PersonLookup | null {
    if (!criteria.id && !criteria.name) return null;
    const people_dir = resolve(this.cfg.vault_root, 'People');
    if (!existsSync(people_dir)) return null;

    const want_name = criteria.name?.toLowerCase().trim();
    const files = readdirSync(people_dir).filter((f) => f.endsWith('.md'));
    for (const file of files) {
      const abs = resolve(people_dir, file);
      const parsed = matter(readFileSync(abs, 'utf8'));
      const fm = parsed.data as Record<string, unknown>;
      if (fm.type !== 'person') continue;

      if (criteria.id && fm.id === criteria.id) {
        return {
          id: criteria.id,
          note_path: `People/${file}`,
          frontmatter: fm,
        };
      }
      if (
        want_name &&
        typeof fm.name === 'string' &&
        fm.name.toLowerCase().trim() === want_name
      ) {
        return {
          id: String(fm.id ?? ''),
          note_path: `People/${file}`,
          frontmatter: fm,
        };
      }
    }
    return null;
  }

  /** Read a note's parsed frontmatter and body. Returns null if missing. */
  read_note(
    rel_path: string,
  ): { frontmatter: Record<string, unknown>; body: string } | null {
    const abs = this.resolve_vault_path(rel_path);
    if (!existsSync(abs)) return null;
    const parsed = matter(readFileSync(abs, 'utf8'));
    return { frontmatter: parsed.data, body: parsed.content };
  }

  /**
   * True if `rel_path` matches any glob in `knowledge_scope`. Used by
   * tools that gate file access by the caller's declared scope (e.g.
   * read_note checks the caller can read what they asked for).
   */
  path_in_scope(rel_path: string, knowledge_scope: readonly string[]): boolean {
    if (knowledge_scope.length === 0) return false;
    const matchers = knowledge_scope.map(_glob_to_regex);
    return matchers.some((re) => re.test(rel_path));
  }

  /**
   * Upcoming birthdays and anniversaries within `horizon_days`.
   * Birthdays come from the people table's `birthday` column (YYYY-MM-DD
   * or MM-DD). Anniversaries are pulled out of `frontmatter_json` at
   * query time — they're an array of { date, what, with? } objects.
   *
   * MM-DD values are treated as year-agnostic: we resolve to this year
   * if still ahead, otherwise next year.
   *
   * `today_iso` (YYYY-MM-DD) anchors the window to a caller-chosen calendar
   * day instead of the host clock — `compute_relationship_signals` passes its
   * own `today_iso` so the brief's occasion window and its day math agree
   * (and so the pinned-date smokes are deterministic). Omitted → today.
   */
  upcoming_dates(
    horizon_days: number,
    types?: Array<'birthday' | 'anniversary'>,
    today_iso?: string,
  ): DateEvent[] {
    const include_b = !types || types.includes('birthday');
    const include_a = !types || types.includes('anniversary');
    const rows = this.cfg.db
      .prepare(
        `SELECT id, name, birthday, frontmatter_json, note_path
         FROM people`,
      )
      .all() as Array<{
      id: string;
      name: string;
      birthday: string | null;
      frontmatter_json: string;
      note_path: string;
    }>;

    const anchor = today_iso ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(today_iso) : null;
    const today = anchor
      ? new Date(Number(anchor[1]), Number(anchor[2]) - 1, Number(anchor[3]))
      : new Date();
    today.setHours(0, 0, 0, 0);
    const events: DateEvent[] = [];

    for (const row of rows) {
      if (include_b && row.birthday) {
        const days = days_until(row.birthday, today);
        if (days !== null && days <= horizon_days) {
          events.push({
            kind: 'birthday',
            person_id: row.id,
            name: row.name,
            note_path: row.note_path,
            date: row.birthday,
            days_until: days,
          });
        }
      }
      if (include_a) {
        let fm: { anniversaries?: Array<{ date: string; what: string; with?: string }> };
        try {
          fm = JSON.parse(row.frontmatter_json);
        } catch {
          continue;
        }
        for (const ann of fm.anniversaries ?? []) {
          if (!ann?.date) continue;
          const days = days_until(ann.date, today);
          if (days !== null && days <= horizon_days) {
            events.push({
              kind: 'anniversary',
              person_id: row.id,
              name: row.name,
              note_path: row.note_path,
              date: ann.date,
              what: ann.what,
              days_until: days,
            });
          }
        }
      }
    }
    events.sort((a, b) => a.days_until - b.days_until);
    return events;
  }

  /** Insert (or replace) a row in graph_edges. */
  add_edge(from: string, to: string, context?: string): void {
    this.cfg.db
      .prepare(
        `INSERT OR REPLACE INTO graph_edges (from_path, to_path, context)
         VALUES (@from_path, @to_path, @context)`,
      )
      .run({
        '@from_path': from,
        '@to_path': to,
        '@context': context ?? null,
      });
  }

  // ── Music context (device-as-sensor snapshot) ──────────────────────────

  /**
   * Latest music-context snapshot for a user — iOS posts via
   * POST /api/sensors/music_context, this reader hands the parsed
   * payload back to intake handlers (Maggie's intake_band_poster
   * scores artist affinity against the top_artists list).
   *
   * Returns null when no snapshot has landed yet for this user.
   * The schema mirrors `MusicContextPayload` in
   * src/app/routes/sensors.ts — kept loose here so a future
   * payload-field addition doesn't break the reader.
   */
  /**
   * Latest calendar snapshot for a user — iOS posts via
   * POST /api/sensors/calendar (kind=snapshot). Reader for backend
   * consumers that want the full event window (e.g. Kate's brief
   * context puller composing today + tomorrow events; Iris's
   * plan_ev_day reading the day's locations) without going through
   * the deprecated HA-CalDAV integration.
   *
   * Returns null when no snapshot has landed yet for this user. The
   * caller is responsible for distinguishing "iOS hasn't pushed yet"
   * (degraded but recoverable) from "iOS pushed but events array is
   * empty" (Jasper has a clear calendar — a real signal).
   *
   * Shape is duck-typed against `CalendarSnapshotPayload` in
   * src/app/routes/sensors.ts — kept loose here so additive payload
   * fields don't break this reader.
   */
  query_calendar_snapshot(user_id: string): CalendarSnapshotResult | null {
    const row = this.cfg.db
      .prepare(
        `SELECT captured_at, received_at, window_start, window_end,
                event_count, payload_path
         FROM calendar_snapshots WHERE user_id = @u`,
      )
      .get({ '@u': user_id }) as
        | {
            captured_at: string;
            received_at: string;
            window_start: string;
            window_end: string;
            event_count: number;
            payload_path: string;
          }
        | undefined;
    if (!row) return null;
    const abs = resolve(this.cfg.vault_root, row.payload_path);
    if (!existsSync(abs)) return null;
    try {
      const raw = JSON.parse(readFileSync(abs, 'utf8')) as {
        events?: CalendarSnapshotEventShape[];
      };
      if (!Array.isArray(raw.events)) return null;
      return {
        user_id,
        captured_at: row.captured_at,
        received_at: row.received_at,
        window_start: row.window_start,
        window_end: row.window_end,
        event_count: row.event_count,
        events: raw.events,
      };
    } catch {
      return null;
    }
  }

  /**
   * Latest iOS-pushed location packet for a user — read from the
   * append-only `sensor_packets` stream (signal='location'). The
   * weather connector + brief context puller use this to anchor
   * "where is the user RIGHT NOW" for live weather routing.
   *
   * Returns null when no packet has landed yet for this user (iOS
   * location sensor feeder not shipped, or permission not yet
   * granted). Callers fall through to anchor (config/users.yaml
   * home_location) or env fallback in that case.
   *
   * Shape is duck-typed against `LocationPayload` in
   * src/app/routes/sensors.ts. The wire format includes
   * `horizontal_accuracy_m` for confidence weighting.
   */
  query_latest_location_packet(user_id: string): LocationPacketResult | null {
    const row = this.cfg.db
      .prepare(
        `SELECT captured_at, received_at, payload_path
         FROM sensor_packets
         WHERE user_id = @u AND signal = 'location'
         ORDER BY captured_at DESC LIMIT 1`,
      )
      .get({ '@u': user_id }) as
        | { captured_at: string; received_at: string; payload_path: string }
        | undefined;
    if (!row) return null;
    const abs = resolve(this.cfg.vault_root, row.payload_path);
    if (!existsSync(abs)) return null;
    try {
      const payload = JSON.parse(readFileSync(abs, 'utf8')) as LocationPacketPayloadShape;
      if (
        typeof payload.lat !== 'number' ||
        typeof payload.lng !== 'number' ||
        !Number.isFinite(payload.lat) ||
        !Number.isFinite(payload.lng)
      ) {
        return null;
      }
      return {
        user_id,
        captured_at: row.captured_at,
        received_at: row.received_at,
        payload,
      };
    } catch {
      return null;
    }
  }

  query_music_context(user_id: string): MusicContextSnapshot | null {
    const row = this.cfg.db
      .prepare(
        `SELECT captured_at, received_at, snapshot_json
         FROM music_context WHERE user_id = @u`,
      )
      .get({ '@u': user_id }) as
        | { captured_at: string; received_at: string; snapshot_json: string }
        | undefined;
    if (!row) return null;
    try {
      const payload = JSON.parse(row.snapshot_json) as MusicContextPayloadShape;
      return {
        user_id,
        captured_at: row.captured_at,
        received_at: row.received_at,
        payload,
      };
    } catch {
      return null;
    }
  }

  // ── Workouts (Astrid's office) ───────────────────────────────────────────

  /**
   * The latest in-flight workout session for a user, read from the warm
   * `workout_sessions` row (status='active'). This is the restart-proof
   * read path: the /api/workout heartbeat handler warms the rolling
   * columns every packet, so the Activity pane + get_workout_state can
   * rehydrate from the DB even when the in-memory WorkoutSessionTracker
   * is cold (post-restart). Returns null when the user has no active
   * session.
   *
   * `warm` is false when only the start packet has landed (rolling
   * columns still NULL) — the caller renders a "reconnecting" stub in
   * that narrow window rather than zeros. Once any heartbeat has warmed
   * the row, `warm` is true and the rolling values are authoritative.
   */
  query_active_workout(user_id: string): ActiveWorkoutSnapshot | null {
    const row = this.cfg.db
      .prepare(
        `SELECT session_id, workout_type, started_at, last_packet_at,
                elapsed_s, active_kcal, distance_m, current_hr,
                current_hr_zone, hr_zone_minutes_json, paused, elevation_gain_m
           FROM workout_sessions
          WHERE user_id = @u AND status = 'active'
          ORDER BY started_at DESC
          LIMIT 1`,
      )
      .get({ '@u': user_id }) as
        | {
            session_id: string;
            workout_type: string;
            started_at: string;
            last_packet_at: string | null;
            elapsed_s: number | null;
            active_kcal: number | null;
            distance_m: number | null;
            current_hr: number | null;
            current_hr_zone: number | null;
            hr_zone_minutes_json: string | null;
            paused: number | null;
            elevation_gain_m: number | null;
          }
        | undefined;
    if (!row) return null;
    const zones = { z1: 0, z2: 0, z3: 0, z4: 0, z5: 0 };
    if (row.hr_zone_minutes_json) {
      try {
        const parsed = JSON.parse(row.hr_zone_minutes_json) as Partial<typeof zones>;
        for (const k of Object.keys(zones) as Array<keyof typeof zones>) {
          const v = parsed[k];
          if (typeof v === 'number' && Number.isFinite(v)) zones[k] = v;
        }
      } catch {
        /* malformed JSON → leave zeros */
      }
    }
    return {
      session_id: row.session_id,
      user_id,
      workout_type: row.workout_type,
      started_at: row.started_at,
      last_packet_at: row.last_packet_at,
      elapsed_s: row.elapsed_s,
      active_kcal: row.active_kcal,
      distance_m: row.distance_m,
      current_hr: row.current_hr,
      current_hr_zone: row.current_hr_zone,
      hr_zone_minutes: zones,
      paused: row.paused === 1,
      elevation_gain_m: row.elevation_gain_m,
      warm: row.last_packet_at != null,
      // A live ride heartbeats every 30s; a row whose last packet is
      // minutes old is a dead stream whose `end` never arrived (app
      // killed at teardown, lost relay). `stale` lets the pane + chat
      // tool stop presenting it as live WITHOUT a destructive write —
      // if packets resume, the row refreshes and stale clears. The
      // reaper (workout.ts) finalizes truly-dead rows separately.
      stale: (() => {
        const lp = row.last_packet_at != null ? Date.parse(row.last_packet_at) : null;
        if (lp == null || !Number.isFinite(lp)) return false;
        const stale_min = Number(process.env.HEARTH_WORKOUT_STALE_MIN ?? '15');
        return Date.now() - lp > stale_min * 60_000;
      })(),
    };
  }

  /**
   * Completed workouts for a user over a 7d / 30d window, read from the
   * `healthkit` sensor packets (sample_type='workout'). This is the
   * superset source — both live-streamed sessions (mirrored into
   * sensor_packets on session-end by the /api/workout route) AND
   * post-hoc Apple-Health workouts land here, so it never misses a ride
   * that didn't stream live. Centralizes the read that get_health_summary
   * used to build inline. Newest first, capped at `limit` (default 20).
   * Payload is duck-typed (no Zod import) to keep @memory free of a
   * route-layer dependency.
   */
  query_workouts(user_id: string, window: '7d' | '30d', limit = 20): WorkoutSummaryRow[] {
    const days = window === '7d' ? 7 : 30;
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    const rows = this.cfg.db
      .prepare(
        `SELECT payload_path FROM sensor_packets
          WHERE user_id = @u AND signal = 'healthkit' AND captured_at >= @since
          ORDER BY captured_at ASC`,
      )
      .all({ '@u': user_id, '@since': since }) as Array<{ payload_path: string }>;
    const out: WorkoutSummaryRow[] = [];
    for (const r of rows) {
      const abs = resolve(this.cfg.vault_root, r.payload_path);
      if (!existsSync(abs)) continue;
      let payload: { sample_type?: string; ts_end?: string; value?: unknown };
      try {
        payload = JSON.parse(readFileSync(abs, 'utf8')) as typeof payload;
      } catch {
        continue;
      }
      if (payload.sample_type !== 'workout') continue;
      const v = payload.value;
      if (typeof v !== 'object' || v === null) continue;
      const w = v as Record<string, unknown>;
      const workout_type = typeof w.workout_type === 'string' ? w.workout_type : null;
      const duration_s = typeof w.duration_s === 'number' ? w.duration_s : null;
      const active_kcal = typeof w.active_kcal === 'number' ? w.active_kcal : null;
      if (workout_type == null || duration_s == null || active_kcal == null) continue;
      const avg_hr = typeof w.avg_hr === 'number' ? Math.round(w.avg_hr) : null;
      const max_hr = typeof w.max_hr === 'number' ? Math.round(w.max_hr) : null;
      const min_hr = typeof w.min_hr === 'number' ? Math.round(w.min_hr) : null;
      const dist_m = typeof w.total_distance_m === 'number' ? w.total_distance_m : null;
      const elev_m = typeof w.elevation_gain_m === 'number' ? Math.round(w.elevation_gain_m) : null;
      const recovery =
        typeof w.recovery_hr_drop_1min_bpm === 'number'
          ? Math.round(w.recovery_hr_drop_1min_bpm * 10) / 10
          : null;
      out.push({
        date: (payload.ts_end ?? '').slice(0, 10),
        workout_type,
        duration_min: Math.round(duration_s / 60),
        active_kcal: Math.round(active_kcal),
        avg_hr,
        max_hr,
        min_hr,
        total_distance_km: dist_m != null ? Math.round((dist_m / 1000) * 100) / 100 : null,
        elevation_gain_m: elev_m,
        recovery_hr_drop_1min_bpm: recovery,
        _end_ms: Date.parse(payload.ts_end ?? '') || 0,
      } as WorkoutSummaryRow & { _end_ms: number });
    }

    // Merge-dedup (2026-06-12): every ride reaches sensor_packets 2-3
    // times — the live session's end-packet dual-write (kcal real,
    // zone minutes null) AND the HealthKit post-hoc sync (zone minutes
    // real, kcal often 0), occasionally doubled again by a retry. The
    // duplicates made Astrid report phantom extra rides AND "no
    // calories" depending on which twin she read. Group near-identical
    // rides (same type, ends within 10 min, durations within ~12%) and
    // take the BEST value per field — the merged row is strictly more
    // complete than any single source row.
    const merged: Array<WorkoutSummaryRow & { _end_ms: number }> = [];
    for (const cand of out as Array<WorkoutSummaryRow & { _end_ms: number }>) {
      const dup = merged.find(
        (m) =>
          m.workout_type === cand.workout_type &&
          Math.abs(m._end_ms - cand._end_ms) <= 10 * 60 * 1000 &&
          Math.abs(m.duration_min - cand.duration_min) <=
            Math.max(2, Math.round(0.12 * Math.max(m.duration_min, cand.duration_min))),
      );
      if (!dup) {
        merged.push({ ...cand });
        continue;
      }
      dup.duration_min = Math.max(dup.duration_min, cand.duration_min);
      dup.active_kcal = Math.max(dup.active_kcal, cand.active_kcal);
      dup.avg_hr = dup.avg_hr ?? cand.avg_hr;
      dup.max_hr =
        dup.max_hr != null || cand.max_hr != null ? Math.max(dup.max_hr ?? 0, cand.max_hr ?? 0) : null;
      dup.total_distance_km =
        dup.total_distance_km != null || cand.total_distance_km != null
          ? Math.max(dup.total_distance_km ?? 0, cand.total_distance_km ?? 0)
          : null;
      dup.min_hr = dup.min_hr ?? cand.min_hr;
      dup.elevation_gain_m =
        dup.elevation_gain_m != null || cand.elevation_gain_m != null
          ? Math.max(dup.elevation_gain_m ?? 0, cand.elevation_gain_m ?? 0)
          : null;
      // The HK-sync twin is the one that carries recovery — prefer any
      // non-null over the dual-write twin's absence.
      dup.recovery_hr_drop_1min_bpm = dup.recovery_hr_drop_1min_bpm ?? cand.recovery_hr_drop_1min_bpm;
    }
    const deduped: WorkoutSummaryRow[] = merged.map(({ _end_ms, ...row }) => row);
    deduped.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
    deduped.splice(limit);
    return deduped;
  }

  // ── Civic items (Ruby's office) ──────────────────────────────────────────

  /**
   * Upsert a civic finding into `civic_items`. Idempotent per
   * (user_id, dedup_key) — re-capturing the same item across deliberation
   * passes refreshes its fields + ts_updated rather than duplicating.
   * ts_created is preserved on update (not in the conflict SET list).
   * Returns the row id (existing id on update).
   */
  record_civic_item(input: CivicItemInput): string {
    const now = new Date().toISOString();
    const existing = this.cfg.db
      .prepare(`SELECT id FROM civic_items WHERE user_id = @u AND dedup_key = @k`)
      .get({ '@u': input.user_id, '@k': input.dedup_key }) as { id: string } | undefined;
    const id = existing?.id ?? `civ_${ulid().slice(-12).toLowerCase()}`;
    this.cfg.db
      .prepare(
        `INSERT INTO civic_items
           (id, user_id, kind, title, summary, event_at, url, location_label,
            lat, lon, corridor_match, interest_score, status, dedup_key, source,
            ts_created, ts_updated)
         VALUES
           (@id, @user_id, @kind, @title, @summary, @event_at, @url, @location_label,
            @lat, @lon, @corridor_match, @interest_score, 'active', @dedup_key, @source,
            @ts_created, @ts_updated)
         ON CONFLICT(user_id, dedup_key) DO UPDATE SET
            kind = excluded.kind,
            title = excluded.title,
            summary = excluded.summary,
            event_at = excluded.event_at,
            url = excluded.url,
            location_label = excluded.location_label,
            lat = excluded.lat,
            lon = excluded.lon,
            corridor_match = excluded.corridor_match,
            interest_score = excluded.interest_score,
            source = excluded.source,
            -- DISMISSED stays dismissed — that is a human "no", and the
            -- hourly re-scan must never overturn it.
            --
            -- EXPIRED is different in kind: it is the sweep's own machine
            -- judgment that a lead went cold, and re-recording an item IS
            -- fresh evidence that it did not. Reviving here is what keeps
            -- expiry an archive rather than a graveyard — a story that goes
            -- quiet for a month and then moves again comes back on its own,
            -- with its original ts_created and history intact.
            status = CASE WHEN civic_items.status = 'expired'
                          THEN 'active' ELSE civic_items.status END,
            ts_updated = excluded.ts_updated`,
      )
      .run({
        '@id': id,
        '@user_id': input.user_id,
        '@kind': input.kind,
        '@title': input.title,
        '@summary': input.summary ?? null,
        '@event_at': input.event_at ?? null,
        '@url': input.url ?? null,
        '@location_label': input.location_label ?? null,
        '@lat': input.lat ?? null,
        '@lon': input.lon ?? null,
        '@corridor_match': input.corridor_match ?? null,
        '@interest_score': input.interest_score,
        '@dedup_key': input.dedup_key,
        '@source': input.source ?? null,
        '@ts_created': now,
        '@ts_updated': now,
      });
    return id;
  }

  /**
   * Archive `watching` leads that have gone cold. Returns what it retired.
   *
   * ARCHIVES, never deletes — the rows keep their evidence, their source and
   * their `ts_created`, and stay queryable for "what were we watching in
   * June?". Re-recording one revives it (see the CASE in
   * `record_civic_item`'s upsert), so this is reversible by new evidence
   * rather than a one-way drop.
   *
   * The VERDICT is injected rather than imported: what counts as a cold lead
   * is Ruby's domain judgment and lives in her `civic_analysis` module, and
   * `src/memory` must not depend on `src/specialists` (the dependency runs
   * the other way). This method owns only the read, the write and the tally.
   *
   * `now` is a parameter so the job and the smoke ground on one instant.
   */
  expire_stale_civic_items(
    user_id: string,
    now: Date,
    decide: (row: {
      kind: string;
      status: string;
      event_at: string | null;
      ts_updated: string;
    }) => { expire: boolean; reason: string | null },
  ): { expired: number; by_reason: Record<string, number> } {
    const rows = this.cfg.db
      .prepare(
        `SELECT id, kind, status, event_at, ts_updated FROM civic_items
          WHERE user_id = @u AND status = 'active' AND kind = 'watching'`,
      )
      .all({ '@u': user_id }) as Array<{
      id: string;
      kind: string;
      status: string;
      event_at: string | null;
      ts_updated: string;
    }>;

    const by_reason: Record<string, number> = {};
    const stmt = this.cfg.db.prepare(
      `UPDATE civic_items SET status = 'expired', ts_updated = @t WHERE id = @id`,
    );
    const stamped = now.toISOString();
    let expired = 0;
    for (const row of rows) {
      const verdict = decide(row);
      if (!verdict.expire) continue;
      stmt.run({ '@id': row.id, '@t': stamped });
      const key = verdict.reason ?? 'unspecified';
      by_reason[key] = (by_reason[key] ?? 0) + 1;
      expired++;
    }
    return { expired, by_reason };
  }

  /** Active civic items for a user, highest interest first. The `civic`
   *  pane composer reads through this so the SQL lives in one place. */
  list_civic_items(user_id: string): CivicItemRow[] {
    return this.cfg.db
      .prepare(
        `SELECT * FROM civic_items
          WHERE user_id = @u AND status = 'active'
          ORDER BY interest_score DESC, ts_updated DESC`,
      )
      .all({ '@u': user_id }) as CivicItemRow[];
  }

  // ── Face-enrollment roster (Cassandra's People room) ──────────────────────
  //
  // Roster metadata only; the biometric embedding lives in the CPAI server,
  // keyed by cpai_userid. Owner-scoped by user_id; never enters the cordon.

  /** Insert-or-update a roster row, idempotent on (user_id, cpai_userid). On
   *  conflict, ADDS `add_image_count` to the running tally (re-enrolling the
   *  same person adds reference shots) and preserves created_at. */
  upsert_enrolled_person(input: EnrolledPersonInput): string {
    const now = new Date().toISOString();
    const existing = this.cfg.db
      .prepare(`SELECT id FROM enrolled_persons WHERE user_id = @u AND cpai_userid = @c`)
      .get({ '@u': input.user_id, '@c': input.cpai_userid }) as { id: string } | undefined;
    const id = existing?.id ?? `ep_${ulid().slice(-12).toLowerCase()}`;
    this.cfg.db
      .prepare(
        `INSERT INTO enrolled_persons
           (id, user_id, cpai_userid, display_name, relationship, image_count,
            photo_rel_dir, created_at, last_recognized_at, ts_updated, person_ref)
         VALUES
           (@id, @user_id, @cpai_userid, @display_name, @relationship, @add,
            @photo_rel_dir, @created_at, NULL, @ts_updated, @person_ref)
         ON CONFLICT(user_id, cpai_userid) DO UPDATE SET
            display_name = excluded.display_name,
            relationship = COALESCE(excluded.relationship, enrolled_persons.relationship),
            image_count = enrolled_persons.image_count + excluded.image_count,
            photo_rel_dir = COALESCE(excluded.photo_rel_dir, enrolled_persons.photo_rel_dir),
            person_ref = COALESCE(excluded.person_ref, enrolled_persons.person_ref),
            ts_updated = excluded.ts_updated`,
      )
      .run({
        '@id': id,
        '@user_id': input.user_id,
        '@cpai_userid': input.cpai_userid,
        '@display_name': input.display_name,
        '@relationship': input.relationship ?? null,
        '@add': input.add_image_count ?? 0,
        '@photo_rel_dir': input.photo_rel_dir ?? null,
        '@created_at': now,
        '@ts_updated': now,
        '@person_ref': input.person_ref ?? null,
      });
    return id;
  }

  /** The owner's enrolled people, newest-touched first. */
  list_enrolled_persons(user_id: string): EnrolledPersonRow[] {
    return this.cfg.db
      .prepare(`SELECT * FROM enrolled_persons WHERE user_id = @u ORDER BY ts_updated DESC`)
      .all({ '@u': user_id }) as EnrolledPersonRow[];
  }

  /** Drop a roster row; returns its cpai_userid + photo_rel_dir so the caller
   *  can delete the CPAI embedding + the owner-private photos. Null if absent. */
  delete_enrolled_person(
    user_id: string,
    id: string,
  ): { cpai_userid: string; photo_rel_dir: string | null } | null {
    const row = this.cfg.db
      .prepare(`SELECT cpai_userid, photo_rel_dir FROM enrolled_persons WHERE user_id = @u AND id = @id`)
      .get({ '@u': user_id, '@id': id }) as
      | { cpai_userid: string; photo_rel_dir: string | null }
      | undefined;
    if (!row) return null;
    this.cfg.db.prepare(`DELETE FROM enrolled_persons WHERE user_id = @u AND id = @id`).run({
      '@u': user_id,
      '@id': id,
    });
    return row;
  }


  /** Write a raw image byte buffer to a vault-relative path. Deliberately NOT
   *  a markdown note — no frontmatter, so the ingestor/RAG/search never index
   *  it. Owner-private enrollment photos live this way (bytes on disk + a
   *  SQLite roster row, never a clipping). */
  write_face_photo(rel_path: string, bytes: Uint8Array): void {
    const abs_path = this.resolve_vault_path(rel_path);
    mkdirSync(dirname(abs_path), { recursive: true });
    writeFileSync(abs_path, bytes);
  }

  /** Read raw bytes from a vault-relative path (face crops/photos). Null if absent. */
  read_face_photo(rel_path: string): Uint8Array | null {
    try {
      return new Uint8Array(readFileSync(this.resolve_vault_path(rel_path)));
    } catch {
      return null;
    }
  }

  /** Vault-relative paths of the image files in a face-photo dir (enrollment
   *  crops / sighting crops), newest-name last. The filename convention varies
   *  (`0.jpg` for enroll-from-upload, `<ulid>.jpg` for label-from-sighting), so
   *  callers must NOT assume a name — the person-track ArcFace backfill globs
   *  this. Returns [] on a missing/unreadable dir. */
  list_face_photos(rel_dir: string): string[] {
    try {
      return readdirSync(this.resolve_vault_path(rel_dir))
        .filter((f) => /\.(jpe?g|png)$/i.test(f))
        .sort()
        .map((f) => `${rel_dir}/${f}`);
    } catch {
      return [];
    }
  }

  /** Best-effort removal of an enrolled person's photo dir on delete. */
  remove_face_photos(rel_dir: string): void {
    try {
      rmSync(this.resolve_vault_path(rel_dir), { recursive: true, force: true });
    } catch {
      /* already gone / not ours — fine */
    }
  }

  // ── Household awareness P1: derived "who's home & where" occupancy ─────────

  /**
   * Derive the household occupancy view.
   *
   * ── 2026-08-04: the camera half is GONE ────────────────────────────────
   * This used to join `face_sightings` x `face_clusters` to answer "who is in
   * which room", plus an unknown-cluster list for the concern signal. Both
   * tables were dropped with the camera/vision layer, so the sighting-derived
   * halves are removed rather than left querying tables that do not exist.
   *
   * What remains is the shape, deliberately: `household` still carries every
   * member's home/away (WiFi/BLE + iOS location, pre-resolved by the caller),
   * and `occupants` is returned EMPTY for the BLE room layer to fill —
   * `augment_occupancy_with_ble` in core/ble_presence.ts is the live producer
   * of in-room presence now, and it appends to exactly this array. Callers and
   * the wire shape are unchanged; `unknown_present` is permanently empty
   * because identifying an unknown person required face recognition.
   *
   * Sync + DB-only so it stays in the MemoryClient idiom. Owner-scoped,
   * outside the cordon — occupancy never enters RAG/search/cross-specialist
   * sharing.
   */
  get_household_occupancy(
    owner_user_id: string,
    opts: {
      window_minutes?: number;
      /** Per-household-member home/away, pre-resolved by the caller. */
      locations?: HouseholdLocation[];
      /** Test seam — pin "now" so recency windowing is deterministic. */
      now_ms?: number;
      /** Camera→room map. Still threaded through (BLE areas and the UniFi
       *  place-aware camera resolution both use `home_map`), but no longer
       *  read here now that sightings are gone. */
      zone_map?: Record<string, string>;
    } = {},
  ): HouseholdOccupancy {
    const window_minutes = opts.window_minutes ?? 30;
    const now_ms = opts.now_ms ?? Date.now();
    const locations = opts.locations ?? [];

    // Empty for the BLE layer to populate; see the note above.
    const occupants: OccupancyOccupant[] = [];
    const unknown_present: OccupancyUnknown[] = [];

    const household: HouseholdMemberPresence[] = locations.map((l) => ({
      user_id: l.user_id,
      display_name: l.display_name,
      presence: l.presence,
      presence_confidence: l.presence_confidence,
      presence_as_of: l.as_of,
      last_zone: null,
      last_seen_at: null,
    }));

    return {
      generated_at: new Date(now_ms).toISOString(),
      window_minutes,
      occupants,
      unknown_present,
      household,
    };
  }

  // ── Civic intelligence: members, votes, watch timeline (Ruby) ─────────────

  /** Upsert a council member, idempotent on (user_id, dedup_key). */
  upsert_civic_member(input: CivicMemberInput): string {
    const now = new Date().toISOString();
    const existing = this.cfg.db
      .prepare(`SELECT id FROM civic_members WHERE user_id = @u AND dedup_key = @k`)
      .get({ '@u': input.user_id, '@k': input.dedup_key }) as { id: string } | undefined;
    const id = existing?.id ?? `cmem_${ulid().slice(-12).toLowerCase()}`;
    this.cfg.db
      .prepare(
        `INSERT INTO civic_members
           (id, user_id, name, role, district, term, active, notes, source_url,
            dedup_key, ts_created, ts_updated)
         VALUES
           (@id, @user_id, @name, @role, @district, @term, @active, @notes, @source_url,
            @dedup_key, @ts, @ts)
         ON CONFLICT(user_id, dedup_key) DO UPDATE SET
            name = excluded.name, role = excluded.role, district = excluded.district,
            term = excluded.term, active = excluded.active, notes = excluded.notes,
            source_url = excluded.source_url, ts_updated = excluded.ts_updated`,
      )
      .run({
        '@id': id, '@user_id': input.user_id, '@name': input.name,
        '@role': input.role ?? null, '@district': input.district ?? null,
        '@term': input.term ?? null, '@active': input.active === false ? 0 : 1,
        '@notes': input.notes ?? null, '@source_url': input.source_url ?? null,
        '@dedup_key': input.dedup_key, '@ts': now,
      });
    return id;
  }

  list_civic_members(user_id: string, active_only = true): CivicMemberRow[] {
    return this.cfg.db
      .prepare(
        `SELECT * FROM civic_members WHERE user_id = @u ${active_only ? 'AND active = 1' : ''}
          ORDER BY name`,
      )
      .all({ '@u': user_id }) as CivicMemberRow[];
  }

  /** Record a council vote, idempotent on (user_id, dedup_key). source_url
   *  is required by the schema — the caller must pass the citing document. */
  record_civic_vote(input: CivicVoteInput): string {
    const now = new Date().toISOString();
    const existing = this.cfg.db
      .prepare(`SELECT id FROM civic_votes WHERE user_id = @u AND dedup_key = @k`)
      .get({ '@u': input.user_id, '@k': input.dedup_key }) as { id: string } | undefined;
    const id = existing?.id ?? `cvote_${ulid().slice(-12).toLowerCase()}`;
    this.cfg.db
      .prepare(
        `INSERT INTO civic_votes
           (id, user_id, member_id, member_name, meeting_id, meeting_date, item_title,
            vote, outcome, source_url, dedup_key, ts_created, ts_updated)
         VALUES
           (@id, @user_id, @member_id, @member_name, @meeting_id, @meeting_date, @item_title,
            @vote, @outcome, @source_url, @dedup_key, @ts, @ts)
         ON CONFLICT(user_id, dedup_key) DO UPDATE SET
            member_id = excluded.member_id, member_name = excluded.member_name,
            meeting_id = excluded.meeting_id, meeting_date = excluded.meeting_date,
            item_title = excluded.item_title, vote = excluded.vote,
            outcome = excluded.outcome, source_url = excluded.source_url,
            ts_updated = excluded.ts_updated`,
      )
      .run({
        '@id': id, '@user_id': input.user_id, '@member_id': input.member_id ?? null,
        '@member_name': input.member_name, '@meeting_id': input.meeting_id ?? null,
        '@meeting_date': input.meeting_date ?? null, '@item_title': input.item_title,
        '@vote': input.vote, '@outcome': input.outcome ?? null,
        '@source_url': input.source_url, '@dedup_key': input.dedup_key, '@ts': now,
      });
    return id;
  }

  /** Votes for a user, optionally filtered by member name or item substring. */
  list_civic_votes(
    user_id: string,
    filter?: { member_name?: string; item_contains?: string; meeting_id?: string },
  ): CivicVoteRow[] {
    const clauses = ['user_id = @u'];
    const params: Record<string, string> = { '@u': user_id };
    if (filter?.member_name) {
      clauses.push('member_name = @m');
      params['@m'] = filter.member_name;
    }
    if (filter?.item_contains) {
      clauses.push('item_title LIKE @i');
      params['@i'] = `%${filter.item_contains}%`;
    }
    // The votes↔office join key (2026-08-05): a council_meeting civic_item is
    // keyed `meeting:<MuniCode MeetingID>` and every extracted vote carries
    // that same MeetingID — 589/591 live rows joined when this was verified.
    // Title-matching between the two ledgers never worked and never needed
    // to; this filter is the structural read.
    if (filter?.meeting_id) {
      clauses.push('meeting_id = @g');
      params['@g'] = filter.meeting_id;
    }
    return this.cfg.db
      .prepare(
        `SELECT * FROM civic_votes WHERE ${clauses.join(' AND ')}
          ORDER BY meeting_date DESC, ts_updated DESC`,
      )
      .all(params) as CivicVoteRow[];
  }

  /** Append a dated event to a watched-issue timeline. Idempotent per key. */
  record_watch_event(input: CivicWatchEventInput): string {
    const now = new Date().toISOString();
    const existing = this.cfg.db
      .prepare(`SELECT id FROM civic_watch_events WHERE user_id = @u AND dedup_key = @k`)
      .get({ '@u': input.user_id, '@k': input.dedup_key }) as { id: string } | undefined;
    const id = existing?.id ?? `cwatch_${ulid().slice(-12).toLowerCase()}`;
    this.cfg.db
      .prepare(
        `INSERT INTO civic_watch_events
           (id, user_id, topic, headline, detail, event_at, status, why_tracked,
            source_url, dedup_key, ts_created, ts_updated)
         VALUES
           (@id, @user_id, @topic, @headline, @detail, @event_at, @status, @why_tracked,
            @source_url, @dedup_key, @ts, @ts)
         ON CONFLICT(user_id, dedup_key) DO UPDATE SET
            topic = excluded.topic, headline = excluded.headline, detail = excluded.detail,
            event_at = excluded.event_at, status = excluded.status,
            -- Sticky, like a politics take: re-recording a development
            -- without restating the reason keeps the reason it opened under.
            why_tracked = COALESCE(excluded.why_tracked, civic_watch_events.why_tracked),
            source_url = excluded.source_url, ts_updated = excluded.ts_updated`,
      )
      .run({
        '@id': id, '@user_id': input.user_id, '@topic': input.topic,
        '@headline': input.headline, '@detail': input.detail ?? null,
        '@event_at': input.event_at, '@status': input.status ?? 'open',
        '@why_tracked': input.why_tracked ?? null,
        '@source_url': input.source_url ?? null, '@dedup_key': input.dedup_key, '@ts': now,
      });
    return id;
  }

  /** Watch-timeline events, newest first, optionally for one topic. */
  list_watch_events(user_id: string, topic?: string): CivicWatchEventRow[] {
    const clauses = ['user_id = @u'];
    const params: Record<string, string> = { '@u': user_id };
    if (topic) {
      clauses.push('topic = @t');
      params['@t'] = topic;
    }
    return this.cfg.db
      .prepare(
        `SELECT * FROM civic_watch_events WHERE ${clauses.join(' AND ')}
          ORDER BY event_at DESC`,
      )
      .all(params) as CivicWatchEventRow[];
  }

  // ── Civic campaigns (the household acting on a story) ─────────────────────

  /**
   * Upsert a campaign, keyed on its slug. Field updates are STICKY: a
   * later call that only moves the milestone keeps the position and
   * talking points already written (the politics `take_md` rule). Passing
   * an explicit empty string is not how you clear a field — close the
   * campaign instead; that's what `status` is for.
   */
  upsert_civic_campaign(input: CivicCampaignInput): { id: string; created: boolean } {
    const now = new Date().toISOString();
    const dedup_key = `campaign:${input.slug}`;
    const existing = this.cfg.db
      .prepare(`SELECT id FROM civic_campaigns WHERE user_id = @u AND dedup_key = @k`)
      .get({ '@u': input.user_id, '@k': dedup_key }) as { id: string } | undefined;
    const id = existing?.id ?? `ccamp_${ulid().slice(-12).toLowerCase()}`;
    const nz = (v: string | null | undefined): string | null => {
      const t = v?.trim();
      return t ? t : null;
    };
    const list = (v: string[] | null | undefined): string | null =>
      v && v.length > 0 ? JSON.stringify([...new Set(v.map((s) => s.trim()).filter(Boolean))]) : null;

    this.cfg.db
      .prepare(
        `INSERT INTO civic_campaigns
           (id, user_id, slug, title, stake_md, position_md, talking_points_md,
            targets, next_milestone, next_milestone_at, watch_topic,
            investigation_ids, status, outcome_md, dedup_key, ts_created, ts_updated)
         VALUES
           (@id, @user_id, @slug, @title, @stake_md, @position_md, @talking_points_md,
            @targets, @next_milestone, @next_milestone_at, @watch_topic,
            @investigation_ids, @status, @outcome_md, @dedup_key, @ts, @ts)
         ON CONFLICT(user_id, dedup_key) DO UPDATE SET
            title = excluded.title,
            stake_md = COALESCE(excluded.stake_md, civic_campaigns.stake_md),
            position_md = COALESCE(excluded.position_md, civic_campaigns.position_md),
            talking_points_md = COALESCE(excluded.talking_points_md, civic_campaigns.talking_points_md),
            targets = COALESCE(excluded.targets, civic_campaigns.targets),
            next_milestone = COALESCE(excluded.next_milestone, civic_campaigns.next_milestone),
            next_milestone_at = COALESCE(excluded.next_milestone_at, civic_campaigns.next_milestone_at),
            watch_topic = COALESCE(excluded.watch_topic, civic_campaigns.watch_topic),
            investigation_ids = COALESCE(excluded.investigation_ids, civic_campaigns.investigation_ids),
            status = excluded.status,
            outcome_md = COALESCE(excluded.outcome_md, civic_campaigns.outcome_md),
            ts_updated = excluded.ts_updated`,
      )
      .run({
        '@id': id, '@user_id': input.user_id, '@slug': input.slug, '@title': input.title,
        '@stake_md': nz(input.stake_md), '@position_md': nz(input.position_md),
        '@talking_points_md': nz(input.talking_points_md), '@targets': list(input.targets),
        '@next_milestone': nz(input.next_milestone), '@next_milestone_at': nz(input.next_milestone_at),
        '@watch_topic': nz(input.watch_topic), '@investigation_ids': list(input.investigation_ids),
        '@status': input.status ?? 'active', '@outcome_md': nz(input.outcome_md),
        '@dedup_key': dedup_key, '@ts': now,
      });
    return { id, created: !existing };
  }

  /** Campaigns, most-recently-moved first. `active_only` keeps the board
   *  to what's actually being worked; closed ones stay queryable. */
  list_civic_campaigns(user_id: string, opts?: { active_only?: boolean }): CivicCampaignRow[] {
    const clauses = ['user_id = @u'];
    if (opts?.active_only) clauses.push(`status IN ('active','paused')`);
    return this.cfg.db
      .prepare(
        `SELECT * FROM civic_campaigns WHERE ${clauses.join(' AND ')}
          ORDER BY ts_updated DESC`,
      )
      .all({ '@u': user_id }) as CivicCampaignRow[];
  }

  /** Attach a deep_research investigation to a campaign without disturbing
   *  the ones already running. Returns false when the campaign is unknown. */
  attach_campaign_investigation(user_id: string, slug: string, investigation_id: string): boolean {
    const row = this.cfg.db
      .prepare(`SELECT investigation_ids FROM civic_campaigns WHERE user_id = @u AND dedup_key = @k`)
      .get({ '@u': user_id, '@k': `campaign:${slug}` }) as { investigation_ids: string | null } | undefined;
    if (!row) return false;
    const ids = campaign_list_field(row.investigation_ids);
    if (ids.includes(investigation_id)) return true;
    ids.push(investigation_id);
    this.cfg.db
      .prepare(
        `UPDATE civic_campaigns SET investigation_ids = @ids, ts_updated = @ts
          WHERE user_id = @u AND dedup_key = @k`,
      )
      .run({ '@ids': JSON.stringify(ids), '@ts': new Date().toISOString(), '@u': user_id, '@k': `campaign:${slug}` });
    return true;
  }

  // ── Location corridors (Ruby's corridor-affinity loop) ────────────────────

  list_location_corridors(user_id: string): LocationCorridor[] {
    return this.cfg.db
      .prepare(
        `SELECT * FROM location_corridors WHERE user_id = @u
          ORDER BY visit_count DESC`,
      )
      .all({ '@u': user_id }) as LocationCorridor[];
  }

  /** Full-replace a user's corridors. The clustering job recomputes the
   *  whole set each run, so delete+insert keeps it simple and prevents
   *  stale corridors from lingering when Jasper's patterns shift. */
  replace_location_corridors(
    user_id: string,
    corridors: Array<Omit<LocationCorridor, 'id' | 'user_id' | 'ts_updated'>>,
  ): void {
    const now = new Date().toISOString();
    const tx = this.cfg.db.transaction(() => {
      this.cfg.db.prepare(`DELETE FROM location_corridors WHERE user_id = @u`).run({ '@u': user_id });
      const stmt = this.cfg.db.prepare(
        `INSERT INTO location_corridors
           (id, user_id, label, center_lat, center_lon, radius_m, visit_count, last_seen_at, ts_updated)
         VALUES (@id, @u, @label, @lat, @lon, @r, @vc, @ls, @ts)`,
      );
      for (const c of corridors) {
        stmt.run({
          '@id': `cor_${ulid().slice(-12).toLowerCase()}`,
          '@u': user_id,
          '@label': c.label,
          '@lat': c.center_lat,
          '@lon': c.center_lon,
          '@r': c.radius_m,
          '@vc': c.visit_count,
          '@ls': c.last_seen_at ?? null,
          '@ts': now,
        });
      }
    });
    tx();
  }

  /**
   * Read location sensor packets since `since_iso`, loading each packet's
   * payload JSON off disk and extracting coordinates for corridor
   * clustering. Packets whose payload is missing / unparseable / lacks
   * coords are skipped. Returns points chronologically. The coordinate
   * extraction is defensive about envelope shape (top-level lat/lng, or
   * nested under `location` / `coords` / `payload`) so it survives a
   * sensor-payload format tweak without silently reading nothing.
   */
  list_location_points(
    user_id: string,
    since_iso: string,
  ): Array<{ lat: number; lon: number; ts: string; place_id: string | null }> {
    type Row = { captured_at: string; payload_path: string };
    const rows = this.cfg.db
      .prepare(
        `SELECT captured_at, payload_path FROM sensor_packets
          WHERE user_id = @u AND signal = 'location' AND captured_at >= @since
          ORDER BY captured_at ASC`,
      )
      .all({ '@u': user_id, '@since': since_iso }) as Row[];
    const out: Array<{ lat: number; lon: number; ts: string; place_id: string | null }> = [];
    for (const r of rows) {
      try {
        const abs = this.resolve_vault_path(r.payload_path);
        if (!existsSync(abs)) continue;
        const json = JSON.parse(readFileSync(abs, 'utf8')) as Record<string, unknown>;
        const coords = extract_latlon(json);
        if (!coords) continue;
        const place_id =
          typeof json.place_id === 'string' ? (json.place_id as string) : null;
        out.push({ lat: coords.lat, lon: coords.lon, ts: r.captured_at, place_id });
      } catch {
        continue;
      }
    }
    return out;
  }

  /**
   * Like list_location_points but preserves the fields a trip
   * reconstruction needs — `kind` (visit_arrival / departure / region
   * enter-exit / significant_change) and `motion` (CMMotionActivity, when
   * iOS posted it) — which list_location_points drops. Feeds
   * summarize_recent_trips(). Rows with no resolvable lat/lon or an
   * unrecognized kind are skipped (defensive against malformed payloads).
   */
  list_location_events(user_id: string, since_iso: string): LocationEvent[] {
    type Row = { captured_at: string; payload_path: string };
    const KINDS = new Set([
      'visit_arrival',
      'visit_departure',
      'region_enter',
      'region_exit',
      'significant_change',
      'foreground_fix',
    ]);
    const MOTIONS = new Set([
      'automotive',
      'cycling',
      'walking',
      'running',
      'stationary',
      'unknown',
    ]);
    const rows = this.cfg.db
      .prepare(
        `SELECT captured_at, payload_path FROM sensor_packets
          WHERE user_id = @u AND signal = 'location' AND captured_at >= @since
          ORDER BY captured_at ASC`,
      )
      .all({ '@u': user_id, '@since': since_iso }) as Row[];
    const out: LocationEvent[] = [];
    for (const r of rows) {
      try {
        const abs = this.resolve_vault_path(r.payload_path);
        if (!existsSync(abs)) continue;
        const json = JSON.parse(readFileSync(abs, 'utf8')) as Record<string, unknown>;
        const coords = extract_latlon(json);
        if (!coords) continue;
        if (typeof json.kind !== 'string' || !KINDS.has(json.kind)) continue;
        const place_id = typeof json.place_id === 'string' ? json.place_id : null;
        const accuracy =
          typeof json.horizontal_accuracy_m === 'number' ? json.horizontal_accuracy_m : null;
        const motion =
          typeof json.motion === 'string' && MOTIONS.has(json.motion)
            ? (json.motion as MotionMode)
            : null;
        const ts = typeof json.ts === 'string' ? json.ts : r.captured_at;
        out.push({
          kind: json.kind as LocationEvent['kind'],
          lat: coords.lat,
          lon: coords.lon,
          ts,
          place_id,
          horizontal_accuracy_m: accuracy,
          motion,
        });
      } catch {
        continue;
      }
    }
    return out;
  }

  // ── Utilities ──────────────────────────────────────────────────────────

  private resolve_vault_path(rel_path: string): string {
    const cleaned = rel_path.replace(/^[/\\]+/, '');
    return resolve(this.cfg.vault_root, cleaned);
  }

  /** Public: absolute filesystem path for a vault-relative path. Lets intake
   *  handlers read a capture's attachment bytes (e.g. a PDF utility bill). */
  abs_path(rel_path: string): string {
    return this.resolve_vault_path(rel_path);
  }
}

export interface MusicContextPayloadShape {
  window_start: string;
  window_end: string;
  top_artists: Array<{
    artist: string;
    play_count: number;
    last_played?: string | null;
  }>;
  recently_played: Array<{
    title: string;
    artist: string;
    album?: string | null;
    played_at: string;
  }>;
  starred_playlists: string[];
  library_counts?: {
    songs: number;
    albums: number;
    artists: number;
    playlists: number;
  };
}

export interface MusicContextSnapshot {
  user_id: string;
  captured_at: string;
  received_at: string;
  payload: MusicContextPayloadShape;
}

/** Restart-proof view of an in-flight workout, read from the warm
 *  `workout_sessions` row by `query_active_workout`. Rolling fields are
 *  nullable because only the start packet may have landed (`warm` false);
 *  once a heartbeat warms the row they're authoritative. */
export interface ActiveWorkoutSnapshot {
  session_id: string;
  user_id: string;
  workout_type: string;
  started_at: string;
  last_packet_at: string | null;
  elapsed_s: number | null;
  active_kcal: number | null;
  distance_m: number | null;
  current_hr: number | null;
  current_hr_zone: number | null;
  hr_zone_minutes: { z1: number; z2: number; z3: number; z4: number; z5: number };
  /** Device autopause state from the latest heartbeat. */
  paused: boolean;
  /** Cumulative barometric climb (m) from the latest heartbeat. */
  elevation_gain_m: number | null;
  warm: boolean;
  /** True when the last packet is older than HEARTH_WORKOUT_STALE_MIN
   *  (default 15) — a dead stream that should not present as live. */
  stale: boolean;
}

/** One completed workout, as returned by `query_workouts`. Mirrors the
 *  WorkoutSummary shape get_health_summary surfaces. */
export interface WorkoutSummaryRow {
  date: string;
  workout_type: string;
  duration_min: number;
  active_kcal: number;
  avg_hr: number | null;
  max_hr: number | null;
  min_hr: number | null;
  total_distance_km: number | null;
  /** Total barometric climb for the session (m), when reported. */
  elevation_gain_m: number | null;
  /** HR drop one minute after the workout ended (bpm) — the HealthKit
   *  sync computes it; negative values are sensor noise, pass through. */
  recovery_hr_drop_1min_bpm: number | null;
}

export interface CalendarSnapshotEventShape {
  event_id: string;
  title: string;
  ts_start: string;
  ts_end: string;
  location?: string | null;
  is_all_day?: boolean;
  calendar_name: string;
  calendar_type:
    | 'caldav'
    | 'exchange'
    | 'local'
    | 'subscription'
    | 'birthday'
    | 'unknown';
  organizer?: string | null;
  has_attendees: boolean;
  notes_preview?: string | null;
}

export interface CalendarSnapshotResult {
  user_id: string;
  captured_at: string;
  received_at: string;
  window_start: string;
  window_end: string;
  event_count: number;
  events: CalendarSnapshotEventShape[];
}

export interface LocationPacketPayloadShape {
  kind:
    | 'visit_arrival'
    | 'visit_departure'
    | 'region_enter'
    | 'region_exit'
    | 'significant_change'
    | 'foreground_fix';
  lat: number;
  lng: number;
  horizontal_accuracy_m?: number;
  place_id?: string | null;
  ts: string;
}

export interface LocationPacketResult {
  user_id: string;
  captured_at: string;
  received_at: string;
  payload: LocationPacketPayloadShape;
}

// ── FTS / glob helpers (used by retrieve_scoped_chunks) ───────────────────

const _FTS_RESERVED = new Set(['AND', 'OR', 'NOT', 'NEAR']);

/**
 * English stopwords that almost never carry retrieval signal but
 * crash AND-matching when they appear in a user's natural-language
 * query. Without this, "did the Doe GEDCOM file land in your
 * library?" requires the chunk to contain ALL of did/the/your/in
 * — which our wrapper notes don't have, returning zero hits when
 * the user is asking the obvious question. Stopping out "did/your"
 * leaves "doe gedcom file land library" which actually matches.
 */
const _STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'if', 'of', 'at', 'by', 'for',
  'with', 'about', 'against', 'between', 'into', 'through', 'during',
  'before', 'after', 'above', 'below', 'to', 'from', 'up', 'down', 'in',
  'out', 'on', 'off', 'over', 'under', 'again', 'further', 'then',
  'once', 'here', 'there', 'when', 'where', 'why', 'how', 'all', 'any',
  'both', 'each', 'few', 'more', 'most', 'other', 'some', 'such', 'no',
  'nor', 'only', 'own', 'same', 'so', 'than', 'too', 'very', 'can',
  'will', 'just', 'don', 'should', 'now', 'i', 'me', 'my', 'myself',
  'we', 'our', 'ours', 'you', 'your', 'yours', 'he', 'him', 'his',
  'she', 'her', 'hers', 'it', 'its', 'they', 'them', 'their', 'what',
  'which', 'who', 'whom', 'this', 'that', 'these', 'those', 'am', 'is',
  'are', 'was', 'were', 'be', 'been', 'being', 'have', 'has', 'had',
  'do', 'does', 'did', 'doing', 'would', 'could', 'should', 'might',
  'must', 'shall', 'may', 'as', 'because', 'while', 'although', 'though',
]);

/**
 * Tokenize a user message into FTS5-safe terms. Drops reserved
 * operators, stopwords, and very short fragments. Callers compose
 * the actual MATCH expression (AND-join, OR-join, phrase quotes).
 */
function _sanitize_fts_tokens(raw: string): string[] {
  if (!raw) return [];
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9\s']/g, ' ')
    .split(/\s+/)
    .filter(
      (t) =>
        t.length >= 2 &&
        !_FTS_RESERVED.has(t.toUpperCase()) &&
        !_STOPWORDS.has(t),
    )
    .slice(0, 12);
}

/**
 * Convert a knowledge_scope glob (e.g. `Knowledge/Anya/**`,
 * `Animals/**`) into a regex that matches relative note paths.
 * Supports `**` (any number of segments) and `*` (any chars in a
 * single segment). Treats `**` as the everything-glob.
 */
function _glob_to_regex(glob: string): RegExp {
  if (glob === '**' || glob === '**/*' || glob === '') return /.*/;
  const re = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '__DOUBLESTAR__')
    .replace(/\*/g, '[^/]*')
    .replace(/__DOUBLESTAR__/g, '.*');
  return new RegExp('^' + re + '$');
}

/**
 * Best-effort: reduce a scope glob set to SQL `LIKE` prefixes for a cheap
 * pre-filter in `vector_search` (so a `Knowledge/Astrid/**` scope reads only
 * that subtree's embeddings, not the whole corpus). Returns null when any
 * glob can't be expressed as a leading prefix (`**` alone, a `*` mid-path,
 * an embedded `?`) — the caller then loads all rows and relies on the exact
 * `in_scope` regex. The LIKE is a SUPERSET filter only; `in_scope` remains
 * the authority on what's actually in scope.
 */
function _scope_to_like_prefixes(scope: string[]): string[] | null {
  if (scope.length === 0) return null;
  const out: string[] = [];
  for (const g of scope) {
    if (g === '**' || g === '**/*' || g === '') return null; // matches everything
    const star = g.search(/[*?]/);
    // The fixed prefix is everything before the first wildcard.
    const prefix = star === -1 ? g : g.slice(0, star);
    if (prefix.length === 0) return null;
    // Append `%` WITHOUT escaping LIKE metacharacters. This is a deliberate
    // SUPERSET pre-filter: a literal `_` in a path (e.g. `_archive`) acting
    // as a LIKE single-char wildcard only BROADENS the match, and `in_scope`
    // (the exact glob regex) is the authority on membership. Escaping would
    // need an ESCAPE clause and risk UNDER-matching — silently dropping
    // valid candidates — which a perf-only prefilter must never do.
    out.push(prefix + '%');
  }
  return out;
}

// ── Civic items + location corridors (Ruby's office) ──────────────────────

export type CivicItemKind =
  | 'council_meeting'
  | 'agenda_item'
  | 'new_in_town'
  | 'corridor_alert'
  | 'announcement'
  | 'watching';

export interface CivicItemInput {
  user_id: string;
  kind: CivicItemKind;
  title: string;
  summary?: string | null;
  /** ISO 8601 when the meeting / agenda / event happens, if dated. */
  event_at?: string | null;
  url?: string | null;
  location_label?: string | null;
  lat?: number | null;
  lon?: number | null;
  /** Label of the matched location corridor, set by corridor scoring. */
  corridor_match?: string | null;
  /** 0..1 — splits at-a-glance items from the "also watching" outskirts. */
  interest_score: number;
  /** Stable key for idempotent re-capture across deliberation passes. */
  dedup_key: string;
  source?: string | null;
}

export interface CivicItemRow {
  id: string;
  user_id: string;
  kind: CivicItemKind;
  title: string;
  summary: string | null;
  event_at: string | null;
  url: string | null;
  location_label: string | null;
  lat: number | null;
  lon: number | null;
  corridor_match: string | null;
  interest_score: number;
  status: 'active' | 'dismissed' | 'expired';
  dedup_key: string;
  source: string | null;
  ts_created: string;
  ts_updated: string;
}

export interface EnrolledPersonInput {
  user_id: string;
  /** Slug CPAI stores the embedding under (lowercase, collision-suffixed). */
  cpai_userid: string;
  display_name: string;
  relationship?: string | null;
  /** Reference photos added in THIS call (added to the running tally). */
  add_image_count?: number;
  /** Vault-relative dir holding the owner-private enrollment photos. */
  photo_rel_dir?: string | null;
  /** The People-graph person this enrollment is BONDED to (`p_…` id) — the
   *  identity spine (2026-07-24). Visual learnings (appearance observations,
   *  the widen-only prior) bind through this ref instead of name matching.
   *  Omitted → an existing ref is KEPT (never cleared by a photo bump). */
  person_ref?: string | null;
}
export interface EnrolledPersonRow {
  id: string;
  user_id: string;
  cpai_userid: string;
  display_name: string;
  relationship: string | null;
  image_count: number;
  photo_rel_dir: string | null;
  created_at: string;
  last_recognized_at: string | null;
  ts_updated: string;
  person_ref: string | null;
}

export interface FaceSightingInput {
  user_id: string;
  cpai_userid: string;
  camera_name?: string | null;
  crop_rel_path: string;
  confidence?: number | null;
  captured_at: string;
  /** VL appearance description for the frame this face was seen in (clothing,
   *  hair, build, carried items). Usually set post-hoc via
   *  set_sighting_appearance after the bounded VL describe; null when no VL
   *  ran (fail-open). The same-day re-ID thread the occupancy view reads. */
  appearance?: string | null;
}
export interface FaceSightingRow {
  id: string;
  user_id: string;
  cluster_id: string;
  camera_name: string | null;
  crop_rel_path: string;
  confidence: number | null;
  captured_at: string;
  ts_created: string;
  appearance: string | null;
}
export interface FaceClusterRow {
  id: string;
  user_id: string;
  cpai_userid: string;
  label: string | null;
  enrolled_person_id: string | null;
  status: 'unknown' | 'named' | 'dismissed';
  sighting_count: number;
  rep_sighting_id: string | null;
  first_seen_at: string | null;
  last_seen_at: string | null;
  ts_updated: string;
  /** Person Threads T1 — the thread-vocabulary projection of status /
   *  enrolled_person_id ('unknown' reads as 'unnamed'), maintained in
   *  lockstep by every cluster mutation; the cluster id IS the thread id. */
  thread_status: 'unnamed' | 'named' | 'dismissed';
  person_id: string | null;
}

// ── Household Awareness Layer P1 — derived occupancy ("who's home & where").
// Owner-scoped, outside the cordon (derived security data, never user content);
// the occupancy state never enters RAG/search/cross-specialist sharing.

export type Presence = 'home' | 'away' | 'unknown';
export type PresenceConfidence = 'high' | 'medium' | 'low';

/** One household member's home/away, pre-resolved by the caller from the iOS
 *  location packet + the home anchor (resolve_household_locations). The input
 *  to the location join in get_household_occupancy. */
export interface HouseholdLocation {
  user_id: string;
  display_name: string;
  presence: Presence;
  presence_confidence: PresenceConfidence | null;
  /** ISO timestamp of the location fix this presence derives from. */
  as_of: string | null;
}

/** An enrolled person seen on a camera within the recency window, joined with
 *  their iOS home/away when they map to a household member by name. */
export interface OccupancyOccupant {
  kind: 'known';
  person_id: string;
  name: string;
  relationship: string | null;
  cluster_id: string;
  rep_sighting_id: string | null;
  /** Friendly zone (camera name today; a camera→room map slots in here at P3). */
  zone: string | null;
  camera_name: string | null;
  last_seen_at: string | null;
  seconds_ago: number | null;
  appearance: string | null;
  sighting_confidence: number | null;
  /** Set when this enrolled person maps to a household member (else null = a
   *  recognized non-member like a neighbor; no presence to join). */
  household_user_id: string | null;
  presence: Presence | null;
  presence_confidence: PresenceConfidence | null;
  presence_as_of: string | null;
}

/** An active unknown cluster (recent sighting, no name) — the concern signal. */
export interface OccupancyUnknown {
  kind: 'unknown';
  cluster_id: string;
  rep_sighting_id: string | null;
  zone: string | null;
  camera_name: string | null;
  last_seen_at: string | null;
  seconds_ago: number | null;
  appearance: string | null;
  sighting_count: number;
  first_seen_at: string | null;
}

/** Every household member + their home/away (+ last camera zone if seen). Lets
 *  a consumer say "Sam's home but not on a camera recently." */
export interface HouseholdMemberPresence {
  user_id: string;
  display_name: string;
  presence: Presence;
  presence_confidence: PresenceConfidence | null;
  presence_as_of: string | null;
  last_zone: string | null;
  last_seen_at: string | null;
}

export interface HouseholdOccupancy {
  generated_at: string;
  window_minutes: number;
  /** Enrolled people seen on a camera in-window, newest first. */
  occupants: OccupancyOccupant[];
  /** Active unrecognized clusters in-window, newest first. */
  unknown_present: OccupancyUnknown[];
  /** Full household roster with home/away (empty when no locations passed). */
  household: HouseholdMemberPresence[];
}

export interface CivicMemberInput {
  user_id: string;
  name: string;
  role?: string | null;
  district?: string | null;
  term?: string | null;
  active?: boolean;
  notes?: string | null;
  source_url?: string | null;
  dedup_key: string;
}
export interface CivicMemberRow {
  id: string;
  user_id: string;
  name: string;
  role: string | null;
  district: string | null;
  term: string | null;
  active: number;
  notes: string | null;
  source_url: string | null;
  dedup_key: string;
  ts_created: string;
  ts_updated: string;
}

export type CivicVote = 'aye' | 'nay' | 'abstain' | 'absent' | 'recused';
export interface CivicVoteInput {
  user_id: string;
  member_id?: string | null;
  member_name: string;
  meeting_id?: string | null;
  meeting_date?: string | null;
  item_title: string;
  vote: CivicVote;
  outcome?: string | null;
  /** Required — the agenda/minutes document the vote was read from. */
  source_url: string;
  dedup_key: string;
}
export interface CivicVoteRow {
  id: string;
  user_id: string;
  member_id: string | null;
  member_name: string;
  meeting_id: string | null;
  meeting_date: string | null;
  item_title: string;
  vote: CivicVote;
  outcome: string | null;
  source_url: string;
  dedup_key: string;
  ts_created: string;
  ts_updated: string;
}

export type CivicWatchStatus = 'open' | 'resolved' | 'dormant';
export interface CivicWatchEventInput {
  user_id: string;
  topic: string;
  headline: string;
  detail?: string | null;
  event_at: string;
  status?: CivicWatchStatus;
  why_tracked?: string | null;
  source_url?: string | null;
  dedup_key: string;
}
export interface CivicWatchEventRow {
  id: string;
  user_id: string;
  topic: string;
  headline: string;
  detail: string | null;
  event_at: string;
  status: CivicWatchStatus;
  why_tracked: string | null;
  source_url: string | null;
  dedup_key: string;
  ts_created: string;
  ts_updated: string;
}

/** A campaign closes like a story does — the board can't accumulate dead
 *  crusades. 'won'/'lost' are outcomes; 'closed' is "we stopped working
 *  it" (moot, overtaken, no longer ours to fight). */
export type CivicCampaignStatus = 'active' | 'paused' | 'won' | 'lost' | 'closed';
export interface CivicCampaignInput {
  user_id: string;
  slug: string;
  title: string;
  stake_md?: string | null;
  position_md?: string | null;
  talking_points_md?: string | null;
  targets?: string[] | null;
  next_milestone?: string | null;
  next_milestone_at?: string | null;
  watch_topic?: string | null;
  investigation_ids?: string[] | null;
  status?: CivicCampaignStatus;
  outcome_md?: string | null;
}
export interface CivicCampaignRow {
  id: string;
  user_id: string;
  slug: string;
  title: string;
  stake_md: string | null;
  position_md: string | null;
  talking_points_md: string | null;
  /** JSON-encoded string[] as stored; use `campaign_targets` to read. */
  targets: string | null;
  next_milestone: string | null;
  next_milestone_at: string | null;
  watch_topic: string | null;
  /** JSON-encoded string[] as stored; use `campaign_investigations` to read. */
  investigation_ids: string | null;
  status: CivicCampaignStatus;
  outcome_md: string | null;
  dedup_key: string;
  ts_created: string;
  ts_updated: string;
}

/** Decode a campaign's JSON list column. Tolerant: a malformed or legacy
 *  value reads as empty rather than throwing inside a pane render. */
export function campaign_list_field(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

export interface LocationCorridor {
  id: string;
  user_id: string;
  label: string;
  center_lat: number;
  center_lon: number;
  radius_m: number;
  visit_count: number;
  last_seen_at: string | null;
  ts_updated: string;
}

/**
 * Pull a {lat, lon} pair out of a location sensor payload, tolerant of
 * envelope shape. iOS posts `{ kind, lat, lng, ... }`; older / nested
 * shapes put coords under `location` / `coords` / `payload`. Accepts
 * `lng` or `lon`. Returns null when no finite pair is present.
 */
function extract_latlon(obj: unknown): { lat: number; lon: number } | null {
  const candidates: unknown[] = [];
  if (obj && typeof obj === 'object') {
    const o = obj as Record<string, unknown>;
    candidates.push(o, o.location, o.coords, o.payload);
  }
  for (const c of candidates) {
    if (!c || typeof c !== 'object') continue;
    const r = c as Record<string, unknown>;
    const lat = typeof r.lat === 'number' ? r.lat : undefined;
    const lonRaw = typeof r.lng === 'number' ? r.lng : typeof r.lon === 'number' ? r.lon : undefined;
    if (lat != null && lonRaw != null && Number.isFinite(lat) && Number.isFinite(lonRaw)) {
      return { lat, lon: lonRaw };
    }
  }
  return null;
}
