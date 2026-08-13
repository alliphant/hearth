/**
 * Per-note projection logic.
 *
 * Given an absolute path to a .md file in the vault, parse the
 * frontmatter, look up the appropriate Zod schema by `type`, validate,
 * and project a row into the matching SQLite table. Parse wikilinks
 * from the body and upsert / warn on graph_edges.
 *
 * All projection rows include `note_path` (relative to vault root) and
 * `mtime` (ISO timestamp of the file's last modification). Both the
 * watcher (apps/ingestor/server.ts) and the rebuild driver
 * (apps/ingestor/rebuild.ts) call into this module.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, relative, resolve } from 'node:path';
import matter from 'gray-matter';
import { ulid } from 'ulid';
import type { Database } from 'bun:sqlite';
import type { SqlBind } from '@memory/stores/structured';
import { ClippingFrontmatter } from '@memory/schemas/clipping';
import { DecisionFrontmatter } from '@memory/schemas/decision';
import { JournalEntryFrontmatter } from '@memory/schemas/journal_entry';
import { PersonFrontmatter } from '@memory/schemas/person';
import { PlaceFrontmatter } from '@memory/schemas/place';
import { HouseholdGoodFrontmatter } from '@memory/schemas/household_good';
import { MediaItemFrontmatter } from '@memory/schemas/media_item';
import { HouseholdServiceFrontmatter } from '@memory/schemas/household_service';
import { LifeEventFrontmatter } from '@memory/schemas/life_event';
import { is_auxiliary_note_type } from '@memory/schemas/note_types';
import { relation_edges_for, RELATES_TO, type EntityKind } from '@core/person_relations';
import type { MemoryClient } from '@memory/client';
import type { VaultIndex } from './vault_index';

export type ProjectOutcome =
  | { kind: 'projected'; type: string; note_path: string; ambiguous_links: string[] }
  | { kind: 'skipped'; note_path: string; reason: string }
  | { kind: 'failed'; note_path: string; error: string };

const WIKILINK_RE = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g;

/**
 * gray-matter + js-yaml coerce unquoted ISO timestamps into JS Date
 * objects on read, which then fail `z.string()` validation. Walk the
 * parsed frontmatter and convert Date instances back to ISO strings,
 * preserving date-only vs full-timestamp semantics heuristically.
 */
function coerce_dates(value: unknown): unknown {
  if (value instanceof Date) {
    const iso = value.toISOString();
    return iso.endsWith('T00:00:00.000Z') ? iso.slice(0, 10) : iso;
  }
  if (Array.isArray(value)) return value.map(coerce_dates);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = coerce_dates(v);
    }
    return out;
  }
  return value;
}

const SCHEMAS = {
  person: PersonFrontmatter,
  journal_entry: JournalEntryFrontmatter,
  decision: DecisionFrontmatter,
  clipping: ClippingFrontmatter,
  place: PlaceFrontmatter,
  household_good: HouseholdGoodFrontmatter,
  household_service: HouseholdServiceFrontmatter,
  life_event: LifeEventFrontmatter,
  media_item: MediaItemFrontmatter,
} as const;

type NoteType = keyof typeof SCHEMAS;

function is_known_type(t: unknown): t is NoteType {
  return typeof t === 'string' && t in SCHEMAS;
}

/**
 * Once-only validation logging. A persistently-invalid note used to
 * re-log `validation_failed` on EVERY projection pass — 36 notes were
 * producing 2,501 audit rows a week (measured 2026-06-09), drowning the
 * audit trail the meta-loop scans read. Key the log on (note_path,
 * content hash): a failure is logged when first seen and again only if
 * the file's CONTENT changes (an edit deserves a fresh verdict).
 * Process-local by design — a restart re-logs each failing file once,
 * which is the signal "still broken at boot," not noise.
 */
const _logged_validation_failures = new Map<string, string>();

function should_log_validation_failure(note_path: string, raw: string): boolean {
  const hash = createHash('sha256').update(raw).digest('hex').slice(0, 16);
  if (_logged_validation_failures.get(note_path) === hash) return false;
  _logged_validation_failures.set(note_path, hash);
  return true;
}

// ── Per-type projection writers ────────────────────────────────────────────

/**
 * Frontmatter values arrive typed `unknown` (gray-matter), but every value
 * bound below is a scalar by construction — the note has already been
 * validated against its Zod schema. This narrows the binding object so
 * bun:sqlite's parameter types accept it without a per-field cast.
 */
function binds(o: Record<string, unknown>): Record<string, SqlBind> {
  return o as Record<string, SqlBind>;
}

/**
 * The `address` frontmatter field accepts more than a flat string: the person
 * schema's `AddressValue` union also takes a structured object
 * (`{ street, city, state, zip, country, community }`), and specialists in the
 * wild also emit a `{ value: '…' }` wrapper. But the `people`/`places.address`
 * COLUMN is a flat, geocodable string, so coerce any object shape down to one
 * before binding — binding the raw object throws bun:sqlite's "Binding expected
 * string, …" and (pre-isolation) killed the entire boot rebuild. The 2026-06-01
 * schema change that began accepting object addresses never updated these two
 * projectors; this closes that gap.
 */
function address_to_string(v: unknown): string | null {
  if (v == null) return null;
  if (typeof v === 'string') return v;
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if (typeof o.value === 'string') return o.value;
    const parts = [o.street, o.city, o.state, o.zip, o.country, o.community]
      .filter((p): p is string => typeof p === 'string' && p.trim().length > 0);
    if (parts.length > 0) return parts.join(', ');
    try {
      return JSON.stringify(v);
    } catch {
      return null;
    }
  }
  return String(v);
}

function project_person(
  db: Database,
  note_path: string,
  fm: Record<string, unknown>,
  mtime: string,
): void {
  const coords = fm.coords as [number, number] | null | undefined;
  const lat = Array.isArray(coords) ? coords[0] : null;
  const lon = Array.isArray(coords) ? coords[1] : null;
  db.prepare(
    `INSERT OR REPLACE INTO people
     (id, name, preferred_name, relationship, birthday,
      contact_cadence, last_contacted, sensitive, friday_managed,
      do_not_contact, address, lat, lon,
      note_path, frontmatter_json, mtime)
     VALUES
     (@id, @name, @preferred_name, @relationship, @birthday,
      @contact_cadence, @last_contacted, @sensitive, @friday_managed,
      @do_not_contact, @address, @lat, @lon,
      @note_path, @frontmatter_json, @mtime)`,
  ).run(binds({
    '@id': fm.id,
    '@name': fm.name,
    '@preferred_name': (fm.preferred_name as string | undefined) ?? null,
    '@relationship': fm.relationship,
    '@birthday': (fm.birthday as string | undefined) ?? null,
    '@contact_cadence': (fm.contact_cadence as string | undefined) ?? null,
    '@last_contacted': (fm.last_contacted as string | undefined) ?? null,
    '@sensitive': fm.sensitive ? 1 : 0,
    '@friday_managed': fm.friday_managed ? 1 : 0,
    '@do_not_contact': fm.do_not_contact ? 1 : 0,
    '@address': address_to_string(fm.address),
    '@lat': lat,
    '@lon': lon,
    '@note_path': note_path,
    '@frontmatter_json': JSON.stringify(fm),
    '@mtime': mtime,
  }));
}

function project_place(
  db: Database,
  note_path: string,
  fm: Record<string, unknown>,
  mtime: string,
): void {
  const coords = fm.coords as [number, number] | null | undefined;
  const lat = Array.isArray(coords) ? coords[0] : null;
  const lon = Array.isArray(coords) ? coords[1] : null;
  db.prepare(
    `INSERT OR REPLACE INTO places
     (id, name, aliases_json, address, lat, lon, category,
      ha_zone_name, parking_buffer_minutes, hours_json, phone,
      note_path, mtime)
     VALUES
     (@id, @name, @aliases_json, @address, @lat, @lon, @category,
      @ha_zone_name, @parking_buffer_minutes, @hours_json, @phone,
      @note_path, @mtime)`,
  ).run(binds({
    '@id': fm.id,
    '@name': fm.name,
    '@aliases_json': JSON.stringify(fm.aliases ?? []),
    '@address': address_to_string(fm.address),
    '@lat': lat,
    '@lon': lon,
    '@category': (fm.category as string | undefined) ?? null,
    '@ha_zone_name': (fm.ha_zone_name as string | null | undefined) ?? null,
    '@parking_buffer_minutes': (fm.parking_buffer_minutes as number | undefined) ?? 0,
    '@hours_json': fm.hours ? JSON.stringify(fm.hours) : null,
    '@phone': (fm.phone as string | undefined) ?? null,
    '@note_path': note_path,
    '@mtime': mtime,
  }));
}

function project_journal_entry(
  db: Database,
  note_path: string,
  fm: Record<string, unknown>,
  mtime: string,
): void {
  // Phase 2b/5 — per-user journal paths (`Journal/<user_id>/<date>.md`)
  // are skipped at the structured-projection layer because the
  // `journal_entries` table keys by `date` alone. Sam's journal can
  // collide with Jasper's same-day entry on INSERT OR REPLACE. The file
  // itself still gets indexed by chunks_fts, so RAG retrieval through
  // `retrieve_scoped_chunks` (with its `private_to` filter) honors per-
  // user scope correctly — the structured projection is reserved for
  // owner journals, which power the Concierge's relationship-signal
  // queries that are Jasper-domain by definition today.
  //
  // Canonical owner path is `Journal/<date>.md` (no subdirectory). A
  // path that fits `Journal/<subdir>/<date>.md` is non-owner; skip.
  const segments = note_path.split('/');
  if (segments.length > 2 && segments[0] === 'Journal') return;

  db.prepare(
    `INSERT OR REPLACE INTO journal_entries
     (date, note_path, tags_json, mtime)
     VALUES (@date, @note_path, @tags_json, @mtime)`,
  ).run(binds({
    '@date': fm.date,
    '@note_path': note_path,
    '@tags_json': JSON.stringify(fm.tags ?? []),
    '@mtime': mtime,
  }));
}

function project_decision(
  db: Database,
  note_path: string,
  fm: Record<string, unknown>,
  mtime: string,
): void {
  db.prepare(
    `INSERT OR REPLACE INTO decisions
     (id, date, domain, chosen, reversible, note_path, frontmatter_json, mtime)
     VALUES
     (@id, @date, @domain, @chosen, @reversible, @note_path, @frontmatter_json, @mtime)`,
  ).run(binds({
    '@id': fm.id,
    '@date': fm.date,
    '@domain': fm.domain,
    '@chosen': fm.chosen,
    '@reversible': fm.reversible ? 1 : 0,
    '@note_path': note_path,
    '@frontmatter_json': JSON.stringify(fm),
    '@mtime': mtime,
  }));
}

function project_clipping(
  db: Database,
  note_path: string,
  fm: Record<string, unknown>,
  mtime: string,
): void {
  db.prepare(
    `INSERT OR REPLACE INTO clippings
     (id, kind, source, source_url, title, attachment_path,
      captured_at, reviewed, note_path, frontmatter_json, mtime, private_to)
     VALUES
     (@id, @kind, @source, @source_url, @title, @attachment_path,
      @captured_at, @reviewed, @note_path, @frontmatter_json, @mtime, @private_to)`,
  ).run(binds({
    '@id': fm.id,
    '@kind': fm.kind,
    '@source': fm.source,
    '@source_url': (fm.source_url as string | undefined) ?? null,
    '@title': fm.title,
    '@attachment_path': (fm.attachment_path as string | undefined) ?? null,
    '@captured_at': fm.captured_at,
    '@reviewed': fm.reviewed ? 1 : 0,
    '@note_path': note_path,
    '@frontmatter_json': JSON.stringify(fm),
    '@mtime': mtime,
    // Mirror the wrapper's visibility scope so the unified search can
    // filter vault hits via a JOIN (see src/app/routes/search.ts).
    '@private_to': (typeof fm.private_to === 'string' && fm.private_to.trim()) || null,
  }));
}

function project_household_good(
  db: Database,
  note_path: string,
  fm: Record<string, unknown>,
  mtime: string,
): void {
  db.prepare(
    `INSERT OR REPLACE INTO household_goods
     (id, name, category, merchant, owner, order_key, purchase_date, cost,
      currency, warranty_until, return_window_until, status, source,
      note_path, frontmatter_json, mtime, private_to)
     VALUES
     (@id, @name, @category, @merchant, @owner, @order_key, @purchase_date, @cost,
      @currency, @warranty_until, @return_window_until, @status, @source,
      @note_path, @frontmatter_json, @mtime, @private_to)`,
  ).run(binds({
    '@id': fm.id,
    '@name': fm.name,
    '@category': (fm.category as string | undefined) ?? null,
    '@merchant': (fm.merchant as string | undefined) ?? null,
    '@owner': (fm.owner as string | undefined) ?? null,
    '@order_key': (fm.order_key as string | undefined) ?? null,
    '@purchase_date': (fm.purchase_date as string | undefined) ?? null,
    '@cost': (fm.cost as number | undefined) ?? null,
    '@currency': (fm.currency as string | undefined) ?? 'USD',
    '@warranty_until': (fm.warranty_until as string | undefined) ?? null,
    '@return_window_until': (fm.return_window_until as string | undefined) ?? null,
    '@status': (fm.status as string | undefined) ?? 'active',
    '@source': (fm.source as string | undefined) ?? 'manual',
    '@note_path': note_path,
    '@frontmatter_json': JSON.stringify(fm),
    '@mtime': mtime,
    '@private_to': (typeof fm.private_to === 'string' && fm.private_to.trim()) || null,
  }));
}

function project_media_item(
  db: Database,
  note_path: string,
  fm: Record<string, unknown>,
  mtime: string,
): void {
  db.prepare(
    `INSERT OR REPLACE INTO media_items
     (id, name, media_kind, source_site, source_url, creator, genre, nsfw,
      duration_s, width, height, container, filesize, published_at, archived_at,
      nas_path, thumbnail_path, note_path, frontmatter_json, mtime, private_to)
     VALUES
     (@id, @name, @media_kind, @source_site, @source_url, @creator, @genre, @nsfw,
      @duration_s, @width, @height, @container, @filesize, @published_at, @archived_at,
      @nas_path, @thumbnail_path, @note_path, @frontmatter_json, @mtime, @private_to)`,
  ).run(binds({
    '@id': fm.id,
    '@name': fm.name,
    '@media_kind': (fm.media_kind as string | undefined) ?? null,
    '@source_site': (fm.source_site as string | undefined) ?? null,
    '@source_url': (fm.source_url as string | undefined) ?? null,
    '@creator': (fm.creator as string | undefined) ?? null,
    '@genre': (fm.genre as string | undefined) ?? null,
    '@nsfw': fm.nsfw ? 1 : 0,
    '@duration_s': (fm.duration_s as number | undefined) ?? null,
    '@width': (fm.width as number | undefined) ?? null,
    '@height': (fm.height as number | undefined) ?? null,
    '@container': (fm.container as string | undefined) ?? null,
    '@filesize': (fm.filesize as number | undefined) ?? null,
    '@published_at': (fm.published_at as string | undefined) ?? null,
    '@archived_at': (fm.archived_at as string | undefined) ?? null,
    '@nas_path': (fm.nas_path as string | undefined) ?? null,
    '@thumbnail_path': (fm.thumbnail_path as string | undefined) ?? null,
    '@note_path': note_path,
    '@frontmatter_json': JSON.stringify(fm),
    '@mtime': mtime,
    '@private_to': (typeof fm.private_to === 'string' && fm.private_to.trim()) || null,
  }));
}

function project_household_service(
  db: Database,
  note_path: string,
  fm: Record<string, unknown>,
  mtime: string,
): void {
  db.prepare(
    `INSERT OR REPLACE INTO household_services
     (id, vendor, vendor_anchor, category, cadence, typical_amount_cents,
      currency, autopay, account_hint, status, confidence, sender_domains_json,
      last_bill_date, next_due_estimate, source,
      note_path, frontmatter_json, mtime, private_to)
     VALUES
     (@id, @vendor, @vendor_anchor, @category, @cadence, @typical_amount_cents,
      @currency, @autopay, @account_hint, @status, @confidence, @sender_domains_json,
      @last_bill_date, @next_due_estimate, @source,
      @note_path, @frontmatter_json, @mtime, @private_to)`,
  ).run(binds({
    '@id': fm.id,
    '@vendor': fm.vendor,
    '@vendor_anchor': fm.vendor_anchor,
    '@category': (fm.category as string | undefined) ?? null,
    '@cadence': (fm.cadence as string | undefined) ?? null,
    '@typical_amount_cents': (fm.typical_amount_cents as number | undefined) ?? null,
    '@currency': (fm.currency as string | undefined) ?? 'USD',
    '@autopay': fm.autopay === undefined ? null : fm.autopay ? 1 : 0,
    '@account_hint': (fm.account_hint as string | undefined) ?? null,
    '@status': (fm.status as string | undefined) ?? 'active',
    '@confidence': (fm.confidence as number | undefined) ?? null,
    '@sender_domains_json': JSON.stringify(Array.isArray(fm.sender_domains) ? fm.sender_domains : []),
    '@last_bill_date': (fm.last_bill_date as string | undefined) ?? null,
    '@next_due_estimate': (fm.next_due_estimate as string | undefined) ?? null,
    '@source': (fm.source as string | undefined) ?? 'mail',
    '@note_path': note_path,
    '@frontmatter_json': JSON.stringify(fm),
    '@mtime': mtime,
    '@private_to': (typeof fm.private_to === 'string' && fm.private_to.trim()) || null,
  }));
}

function project_life_event(
  db: Database,
  note_path: string,
  fm: Record<string, unknown>,
  mtime: string,
): void {
  db.prepare(
    `INSERT OR REPLACE INTO life_events
     (id, title, category, event_date, end_date, location, owner,
      attribution_confidence, owner_uncertain, actionable, source,
      source_event_id, calendar_name, note_path, frontmatter_json, mtime, private_to)
     VALUES
     (@id, @title, @category, @event_date, @end_date, @location, @owner,
      @attribution_confidence, @owner_uncertain, @actionable, @source,
      @source_event_id, @calendar_name, @note_path, @frontmatter_json, @mtime, @private_to)`,
  ).run(binds({
    '@id': fm.id,
    '@title': fm.title,
    '@category': (fm.category as string | undefined) ?? null,
    '@event_date': (fm.event_date as string | undefined) ?? null,
    '@end_date': (fm.end_date as string | undefined) ?? null,
    '@location': (fm.location as string | undefined) ?? null,
    '@owner': (fm.owner as string | undefined) ?? null,
    '@attribution_confidence': (fm.attribution_confidence as number | undefined) ?? null,
    '@owner_uncertain': fm.owner_uncertain ? 1 : 0,
    '@actionable': fm.actionable ? 1 : 0,
    '@source': (fm.source as string | undefined) ?? 'calendar',
    '@source_event_id': (fm.source_event_id as string | undefined) ?? null,
    '@calendar_name': (fm.calendar_name as string | undefined) ?? null,
    '@note_path': note_path,
    '@frontmatter_json': JSON.stringify(fm),
    '@mtime': mtime,
    '@private_to': (typeof fm.private_to === 'string' && fm.private_to.trim()) || null,
  }));
}

const PROJECTORS = {
  person: project_person,
  journal_entry: project_journal_entry,
  decision: project_decision,
  clipping: project_clipping,
  place: project_place,
  household_good: project_household_good,
  household_service: project_household_service,
  life_event: project_life_event,
  media_item: project_media_item,
} as const;

// ── Wikilink graph projection ──────────────────────────────────────────────

function extract_wikilinks(body: string): string[] {
  const found = new Set<string>();
  for (const m of body.matchAll(WIKILINK_RE)) {
    const target = m[1]?.trim();
    if (target) found.add(target);
  }
  return [...found];
}

/**
 * Resolve each wikilink target to a single note_path via the vault
 * index. Returns the list of `to_paths` that were upserted and the
 * list of `(target, candidates)` pairs that couldn't be resolved.
 */
function project_wikilinks(
  db: Database,
  from_path: string,
  body: string,
  index: VaultIndex,
): { upserted: string[]; ambiguous: { target: string; candidates: string[] }[] } {
  const upserted: string[] = [];
  const ambiguous: { target: string; candidates: string[] }[] = [];

  for (const target of extract_wikilinks(body)) {
    const candidates = index.resolve(target);
    if (candidates.length === 1) {
      const to_path = candidates[0]!;
      if (to_path === from_path) continue; // ignore self-links
      db.prepare(
        `INSERT OR REPLACE INTO graph_edges (from_path, to_path, context)
         VALUES (@from_path, @to_path, NULL)`,
      ).run({ '@from_path': from_path, '@to_path': to_path });
      upserted.push(to_path);
    } else {
      ambiguous.push({ target, candidates });
    }
  }

  return { upserted, ambiguous };
}

// ── Relationship-graph projection ───────────────────────────────────────────

/**
 * Project a person note's `relations` frontmatter into typed `relates-to`
 * edges in the Household Knowledge Graph (knowledge_edges), resolving each
 * target to a vault note_path when it exists or leaving the raw name token
 * otherwise (the graph stores free refs). Idempotent: `replace_from` clears
 * this note's prior relation-edges first, so removing a relation removes its
 * edge. FAIL-OPEN — a malformed relation must never fail the note's projection
 * or crash the ingestor, so the whole pass is best-effort.
 */
function project_person_relations(
  ctx: ProjectContext,
  note_path: string,
  fm: Record<string, unknown>,
): void {
  try {
    const private_to = (typeof fm.private_to === 'string' && fm.private_to.trim()) || 'household';
    const resolve = (name: string, kind: EntityKind): string => {
      if (kind === 'place') return ctx.memory.find_place_by_name(name)?.note_path ?? name;
      return ctx.memory.find_person({ name })?.note_path ?? name;
    };
    const edges = relation_edges_for(fm, note_path, private_to, resolve);
    ctx.memory.knowledge_edges.replace_from(note_path, RELATES_TO, edges);
  } catch {
    /* fail-open: no relationship edges beats a broken projection pass */
  }
}

// ── Public entry points ────────────────────────────────────────────────────

export interface ProjectContext {
  vault_root: string;
  db: Database;
  memory: MemoryClient;
  index: VaultIndex;
  /**
   * 'per_note' (default) — every projected note writes a `project_note`
   * audit row and each unresolved wikilink an `ambiguous_link` row: the
   * right granularity for genuine watcher events (add/change during
   * steady state). 'bulk' — the full-vault rebuild path — suppresses
   * those per-note SUCCESS rows; the rebuild driver logs ONE
   * `rebuild_vault` summary row instead. A ~4.5k-note vault was emitting
   * ~4.5k `ingestor|project_note` rows (+ one daily-audit-markdown line
   * each) on EVERY ingestor restart, drowning the audit trail the
   * meta-loop scans read (measured 46,461 rows on 2026-07-16 vs a
   * ~10k/day all-system baseline). Failure rows (validation_failed /
   * projection_failed) log in BOTH modes — they're already content-hash
   * deduped and "still broken at boot" is signal, not noise.
   */
  audit_mode?: 'per_note' | 'bulk';
}

/**
 * Project a single note from disk. Returns a ProjectOutcome and (in
 * 'per_note' audit mode) writes one audit_log row (project_note |
 * validation_failed | unknown_type); ambiguous wikilinks emit additional
 * ambiguous_link audit rows. In 'bulk' mode only failure rows are
 * written — see ProjectContext.audit_mode.
 */
export function project_note(
  abs_path: string,
  ctx: ProjectContext,
): ProjectOutcome {
  const intent_id = ulid();
  let note_path: string;
  try {
    note_path = relative(ctx.vault_root, abs_path);
  } catch {
    return { kind: 'failed', note_path: abs_path, error: 'path outside vault' };
  }
  if (note_path.startsWith('..')) {
    return {
      kind: 'failed',
      note_path,
      error: `path outside vault root: ${abs_path}`,
    };
  }

  if (!existsSync(abs_path)) {
    return { kind: 'skipped', note_path, reason: 'file missing at read time' };
  }

  // A quarantined note is OUT of circulation by definition (2026-07-31). It is
  // kept on disk so the removal is reversible and auditable — not so it can be
  // projected straight back into the tables it was just pulled from. Without
  // this, `quarantine_note` de-indexes the old path and the watcher immediately
  // re-projects the file at its `_quarantine/` path, leaving a live row that
  // says the note is still shelved. (Ruby's four same-name-conflated Barrett
  // dossiers came back this way within seconds; Vivian's May smoke-test
  // quarantine has carried the same stray rows ever since.)
  if (/(^|\/)_quarantine\//.test(note_path)) {
    return { kind: 'skipped', note_path, reason: 'quarantined — out of circulation' };
  }

  let raw: string;
  let mtime: string;
  try {
    raw = readFileSync(abs_path, 'utf8');
    mtime = statSync(abs_path).mtime.toISOString();
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return { kind: 'failed', note_path, error: `read failed: ${error}` };
  }

  let parsed;
  try {
    parsed = matter(raw);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    ctx.memory.log_action({
      intent_id,
      agent: 'ingestor',
      tool_name: 'validation_failed',
      tool_input: { note_path },
      error: `frontmatter parse failed: ${error}`,
    });
    return { kind: 'failed', note_path, error: `frontmatter parse: ${error}` };
  }

  const coerced = coerce_dates(parsed.data) as Record<string, unknown>;
  const raw_type = coerced.type;

  if (!is_known_type(raw_type)) {
    // Notes without a `type` field (e.g. the audit markdown, ad-hoc
    // scratch notes) are intentionally skipped — not every .md in the
    // vault is meant for SQLite projection. Don't audit-spam these.
    if (raw_type === undefined) {
      return {
        kind: 'skipped',
        note_path,
        reason: 'no frontmatter.type — not a managed note',
      };
    }
    // Auxiliary types (pet_record, receipt, trainer_profile, …) are
    // legitimate specialist-owned notes that are deliberately NOT
    // structured-projected — skip them as silently as untyped notes.
    // The registry in @memory/schemas/note_types is the contract;
    // before it existed these logged `unknown frontmatter type` on
    // every pass (the 2,501-rows-a-week class).
    if (is_auxiliary_note_type(raw_type)) {
      return {
        kind: 'skipped',
        note_path,
        reason: `auxiliary type '${raw_type}' — specialist-owned, not structured-projected`,
      };
    }
    if (should_log_validation_failure(note_path, raw)) {
      ctx.memory.log_action({
        intent_id,
        agent: 'ingestor',
        tool_name: 'validation_failed',
        tool_input: { note_path, raw_type },
        error:
          `unknown frontmatter type: ${String(raw_type)} — not in the ` +
          `note-type registry (src/memory/schemas/note_types.ts). Add it ` +
          `there (auxiliary) or give it a schema + projector (projected).`,
      });
    }
    return {
      kind: 'skipped',
      note_path,
      reason: `unknown type: ${String(raw_type)}`,
    };
  }

  const schema = SCHEMAS[raw_type];
  const validated = schema.safeParse(coerced);
  if (!validated.success) {
    if (should_log_validation_failure(note_path, raw)) {
      ctx.memory.log_action({
        intent_id,
        agent: 'ingestor',
        tool_name: 'validation_failed',
        tool_input: { note_path, type: raw_type },
        error: validated.error.message,
      });
    }
    return {
      kind: 'failed',
      note_path,
      error: `schema validation: ${validated.error.message}`,
    };
  }

  const fm = validated.data as Record<string, unknown>;
  // Isolate the projection writer: a single note whose bind throws (e.g. a
  // frontmatter shape the column can't hold) must become one `failed` count,
  // never a process crash that takes down the whole boot rebuild and
  // crash-loops the ingestor.
  try {
    PROJECTORS[raw_type](ctx.db, note_path, fm, mtime);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    if (should_log_validation_failure(note_path, raw)) {
      ctx.memory.log_action({
        intent_id,
        agent: 'ingestor',
        tool_name: 'projection_failed',
        tool_input: { note_path, type: raw_type },
        error: `projection writer threw: ${error}`,
      });
    }
    return { kind: 'failed', note_path, error: `projection: ${error}` };
  }

  // Relationship graph: a person note's `relations` → typed relates-to edges.
  // Separate, fail-open step (never fails the structured projection above).
  if (raw_type === 'person') project_person_relations(ctx, note_path, fm);

  const { upserted, ambiguous } = project_wikilinks(
    ctx.db,
    note_path,
    parsed.content,
    ctx.index,
  );

  if (ctx.audit_mode !== 'bulk') {
    for (const { target, candidates } of ambiguous) {
      ctx.memory.log_action({
        intent_id,
        agent: 'ingestor',
        tool_name: 'ambiguous_link',
        tool_input: { from: note_path, target, candidates },
        error:
          candidates.length === 0
            ? `no vault note matches [[${target}]]`
            : `[[${target}]] matches ${candidates.length} notes`,
      });
    }

    ctx.memory.log_action({
      intent_id,
      agent: 'ingestor',
      tool_name: 'project_note',
      tool_input: { note_path, type: raw_type },
      execution_result: {
        rows_affected: 1,
        edges_upserted: upserted.length,
        ambiguous_links: ambiguous.length,
      },
    });
  }

  return {
    kind: 'projected',
    type: raw_type,
    note_path,
    ambiguous_links: ambiguous.map((a) => a.target),
  };
}

/**
 * Tear down a note's projection: remove the row from whichever table
 * holds it (by note_path), drop the RETRIEVAL index rows (chunks_fts +
 * chunk_embeddings), drop any graph_edges that reference it, and
 * audit-log the action.
 *
 * The retrieval teardown is load-bearing and NOT optional: a note whose
 * file is gone but whose chunks/vectors survive is still returned by
 * FTS and by vector RAG, so deleted content keeps grounding turns. It
 * also covers the AUXILIARY types (`_synthesis/` notes, memory files)
 * which never project a row into any table above — for those,
 * `removed_from` is null and these two deletes are the ENTIRE teardown.
 */
export function unproject_note(
  abs_path: string,
  ctx: Omit<ProjectContext, 'index'>,
): {
  removed_from: string | null;
  edges_removed: number;
  chunks_removed: number;
  embeddings_removed: number;
} {
  const note_path = relative(ctx.vault_root, abs_path);
  let removed_from: string | null = null;
  for (const table of ['people', 'journal_entries', 'decisions', 'clippings', 'places', 'household_goods', 'household_services', 'life_events', 'media_items'] as const) {
    const res = ctx.db
      .prepare(`DELETE FROM ${table} WHERE note_path = @note_path`)
      .run({ '@note_path': note_path });
    if (res.changes && res.changes > 0) {
      removed_from = table;
      break;
    }
  }

  // Retrieval index: FTS chunks + their mirrored vectors. Fail-open,
  // independently — a missing chunks_fts module must not strand the
  // vectors (they are the half RAG actually reads).
  let chunks_removed = 0;
  try {
    // COUNT first: `changes` on an FTS5 virtual table reports the index's
    // internal row churn (7 for a single chunk), not the logical rows.
    const before = ctx.db
      .prepare(`SELECT COUNT(*) AS n FROM chunks_fts WHERE note_path = @note_path`)
      .get({ '@note_path': note_path }) as { n: number } | null;
    ctx.db
      .prepare(`DELETE FROM chunks_fts WHERE note_path = @note_path`)
      .run({ '@note_path': note_path });
    chunks_removed = before?.n ?? 0;
  } catch (err) {
    console.error(`[unproject] chunks_fts delete failed for ${note_path}:`, err);
  }
  let embeddings_removed = 0;
  try {
    const res = ctx.db
      .prepare(`DELETE FROM chunk_embeddings WHERE note_path = @note_path`)
      .run({ '@note_path': note_path });
    embeddings_removed = res.changes ?? 0;
  } catch (err) {
    console.error(`[unproject] chunk_embeddings delete failed for ${note_path}:`, err);
  }

  const edge_res = ctx.db
    .prepare(
      `DELETE FROM graph_edges
       WHERE from_path = @note_path OR to_path = @note_path`,
    )
    .run({ '@note_path': note_path });

  // Drop the relationship edges this note authored (its OUTGOING relations).
  // Inbound relates-to edges belong to other notes and clear when those
  // reproject. Fail-open — teardown must not throw.
  try {
    ctx.memory.knowledge_edges.replace_from(note_path, RELATES_TO, []);
  } catch {
    /* best-effort */
  }

  ctx.memory.log_action({
    intent_id: ulid(),
    agent: 'ingestor',
    tool_name: 'unproject_note',
    tool_input: { note_path },
    execution_result: {
      removed_from,
      edges_removed: edge_res.changes ?? 0,
      chunks_removed,
      embeddings_removed,
    },
  });

  return {
    removed_from,
    edges_removed: edge_res.changes ?? 0,
    chunks_removed,
    embeddings_removed,
  };
}

// Re-exports so callers don't need to know the schema map.
export { SCHEMAS };
export type { NoteType };

// File-name helper used by VaultIndex.
export function note_basename(rel_path: string): string {
  return basename(rel_path).replace(/\.md$/, '');
}

// Resolve helper used in tests + rebuild driver.
export function abs_for(vault_root: string, rel_path: string): string {
  return resolve(vault_root, rel_path);
}
