/**
 * PersonSynthesis — the durable, cordoned relationship NARRATIVE distilled from
 * the observation stream (the synthesis/promotion pass, 2026-06-24).
 *
 * The afferent `person_observations` log (A+D) is decaying WORKING MEMORY — a
 * flat, ever-growing stream of what Hearth noticed. The nightly synthesis pass
 * (src/core/people_synthesis.ts) PROMOTES the durable signal out of that stream:
 *   - communal FACTS (pets, interests, dates) → the People note via merge_facts,
 *   - and the relationship NARRATIVE (a portrait + recurring themes) → HERE.
 *
 * Why a dedicated store and not the People-note frontmatter: the narrative is
 * distilled from `person_observations`, which are stamped `private_to` = the
 * uploader (owner-only) precisely because the distillate of someone's private
 * correspondence is theirs to see, not the household's. The People note is a
 * household-shared entity; writing the narrative there would LEAK it. So the
 * narrative carries the SAME cordon as its source observations — one row per
 * (person_id, user_id), read through `note_visible_to_caller`, the owner has NO
 * god-view of a synthesis siloed to another user. (The communal facts that DO
 * graduate to the household note are exactly the ones safe to share — the same
 * two-tier cordon the iMessage distill already enforces.)
 *
 * Self-contained additive table (CREATE IF NOT EXISTS in the ctor; no SCHEMA_SQL
 * edit, no SCHEMA_VERSION bump) — the PersonObservations / MailStore pattern.
 * Named-sigil binds (the open_db guard). The `meta` k/v backs the sweep's
 * cadence cursor.
 *
 * REFINE, NOT REBUILD (the depth pass, 2026-07-26). The row was originally a
 * blind overwrite: each night's synthesis rewrote the narrative from whatever
 * observations happened to be active, so a dossier could never be deeper than
 * one night's window (a live one read `source_observation_count: 4` after weeks
 * of correspondence). The sweep now reads the prior row back via
 * `get_for_refine` and hands the model its own portrait as the anchor — the
 * discipline `docs/design-per-user-model.md` names, and the one Kate's own
 * `distill_jasper_style` loop has always followed via `read_prior_profile`.
 * `revision` counts the refinements; `communication` is the relational sibling
 * of the user's style profile (how THEY talk, not what happened to them).
 */
import { Database } from 'bun:sqlite';
import { ulid } from 'ulid';
import { note_visible_to_caller, type Caller } from '@memory/private_to';

export interface PersonSynthesis {
  id: string;
  person_id: string;
  /** The uploader/observer principal whose private signal this distills. */
  user_id: string;
  /** A 1-3 sentence relationship portrait. */
  summary: string;
  /** Durable narrative bullets: recurring concerns, relationship texture, their
   *  network of people, life trajectory. */
  themes: string[];
  /** A 1-3 sentence portrait of HOW they communicate — register, what they open
   *  with, what they ask about, cadence, humor, what lands. The relational
   *  sibling of the user's own style profile. '' until there's evidence. */
  communication: string;
  /** How many observations the latest synthesis drew on (for the card + audit). */
  source_observation_count: number;
  /** The newest observation `observed_at` this synthesis consumed — the cursor
   *  the sweep's dirty-check compares against to skip an unchanged person. */
  last_observation_ts: string | null;
  /** How many synthesis passes have REFINED this dossier. The dossier is
   *  refine-not-rebuild (each pass anchors on the prior one), so revision is a
   *  depth signal: rev 1 is a first impression, rev 20 is a portrait. */
  revision: number;
  private_to: string;
  updated_at: string;
}

export interface SynthesisInput {
  person_id: string;
  user_id: string;
  summary: string;
  themes: string[];
  communication: string;
  source_observation_count: number;
  last_observation_ts: string | null;
  private_to: string;
}

interface Row {
  id: string;
  person_id: string;
  user_id: string;
  summary: string;
  themes_json: string;
  communication: string;
  source_observation_count: number;
  last_observation_ts: string | null;
  revision: number;
  private_to: string;
  updated_at: string;
}

function hydrate(r: Row): PersonSynthesis {
  let themes: string[] = [];
  try {
    const parsed = JSON.parse(r.themes_json || '[]');
    if (Array.isArray(parsed)) themes = parsed.filter((x): x is string => typeof x === 'string');
  } catch {
    /* legacy/garbled → empty, never throw */
  }
  return {
    id: r.id,
    person_id: r.person_id,
    user_id: r.user_id,
    summary: r.summary,
    themes,
    communication: r.communication ?? '',
    source_observation_count: r.source_observation_count,
    last_observation_ts: r.last_observation_ts,
    revision: r.revision ?? 0,
    private_to: r.private_to,
    updated_at: r.updated_at,
  };
}

/** Additive column migration for DBs created before a field existed. ALTER has no
 *  IF NOT EXISTS on older SQLite, so swallow exactly the duplicate-column error —
 *  the structured.ts `add_column_if_missing` pattern, inlined for a self-contained
 *  store (this table is created here, not in SCHEMA_SQL). */
function add_column_if_missing(db: Database, table: string, column: string, type_sql: string): void {
  try {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type_sql}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes('duplicate column name')) throw err;
  }
}

export class PersonSynthesisStore {
  constructor(private db: Database) {
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS person_synthesis (
         id TEXT PRIMARY KEY,
         person_id TEXT NOT NULL,
         user_id TEXT NOT NULL,
         summary TEXT NOT NULL DEFAULT '',
         themes_json TEXT NOT NULL DEFAULT '[]',
         communication TEXT NOT NULL DEFAULT '',
         source_observation_count INTEGER NOT NULL DEFAULT 0,
         last_observation_ts TEXT,
         revision INTEGER NOT NULL DEFAULT 0,
         private_to TEXT NOT NULL DEFAULT 'owner',
         updated_at TEXT NOT NULL,
         UNIQUE(person_id, user_id)
       )`,
    );
    // Live DBs predate `communication` + `revision` (the depth pass) — backfill
    // them additively so an existing dossier keeps its narrative and starts
    // counting refinements from where it is.
    add_column_if_missing(this.db, 'person_synthesis', 'communication', `TEXT NOT NULL DEFAULT ''`);
    add_column_if_missing(this.db, 'person_synthesis', 'revision', 'INTEGER NOT NULL DEFAULT 0');
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_psyn_person ON person_synthesis(person_id)`);
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS person_synthesis_meta (
         key TEXT PRIMARY KEY,
         value TEXT NOT NULL
       )`,
    );
  }

  /** Write the refined (person, user) dossier. The narrative REPLACES the prior
   *  one (the synthesis pass anchors on it and hands back the refined whole, so
   *  this is a refinement landing, not a blind overwrite) and `revision`
   *  increments — the depth counter the card reads. */
  upsert(input: SynthesisInput): void {
    const now = new Date().toISOString();
    const existing = this.db
      .prepare(`SELECT id FROM person_synthesis WHERE person_id = @p AND user_id = @u`)
      .get({ '@p': input.person_id, '@u': input.user_id }) as { id: string } | undefined;
    const themes_json = JSON.stringify(input.themes ?? []);
    if (existing) {
      this.db
        .prepare(
          `UPDATE person_synthesis SET summary = @summary, themes_json = @themes,
             communication = @communication, source_observation_count = @count,
             last_observation_ts = @cursor, revision = revision + 1,
             private_to = @private_to, updated_at = @updated WHERE id = @id`,
        )
        .run({
          '@id': existing.id,
          '@summary': input.summary,
          '@themes': themes_json,
          '@communication': input.communication ?? '',
          '@count': input.source_observation_count,
          '@cursor': input.last_observation_ts ?? null,
          '@private_to': input.private_to,
          '@updated': now,
        });
      return;
    }
    this.db
      .prepare(
        `INSERT INTO person_synthesis
           (id, person_id, user_id, summary, themes_json, communication, source_observation_count,
            last_observation_ts, revision, private_to, updated_at)
         VALUES
           (@id, @person_id, @user_id, @summary, @themes, @communication, @count, @cursor, 1, @private_to, @updated)`,
      )
      .run({
        '@id': `psyn_${ulid().toLowerCase().slice(-16)}`,
        '@person_id': input.person_id,
        '@user_id': input.user_id,
        '@summary': input.summary,
        '@themes': themes_json,
        '@communication': input.communication ?? '',
        '@count': input.source_observation_count,
        '@cursor': input.last_observation_ts ?? null,
        '@private_to': input.private_to,
        '@updated': now,
      });
  }

  /** The EXACT (person, user) dossier, UNCORDONED — the refine-not-rebuild anchor
   *  the sweep feeds back into the next synthesis. Engine-only: the sweep already
   *  owns the cordon (it partitions observations by user_id and writes back under
   *  that same principal). User surfaces read through `get_for_person`. */
  get_for_refine(person_id: string, user_id: string): PersonSynthesis | null {
    const row = this.db
      .prepare(`SELECT * FROM person_synthesis WHERE person_id = @p AND user_id = @u`)
      .get({ '@p': person_id, '@u': user_id }) as Row | undefined;
    return row ? hydrate(row) : null;
  }

  /** The sweep's dirty-check cursor for a (person, user) — null if never synthesized. */
  get_cursor(person_id: string, user_id: string): string | null {
    const row = this.db
      .prepare(`SELECT last_observation_ts FROM person_synthesis WHERE person_id = @p AND user_id = @u`)
      .get({ '@p': person_id, '@u': user_id }) as { last_observation_ts: string | null } | undefined;
    return row?.last_observation_ts ?? null;
  }

  /** The freshest cordon-visible synthesis for a person (the drill-in view). */
  get_for_person(person_id: string, caller: Caller): PersonSynthesis | null {
    const rows = this.db
      .prepare(`SELECT * FROM person_synthesis WHERE person_id = @p ORDER BY updated_at DESC`)
      .all({ '@p': person_id }) as Row[];
    for (const r of rows) {
      const v = hydrate(r);
      if (note_visible_to_caller(v.private_to, caller)) return v;
    }
    return null;
  }

  /** Map of person_id → cordon-visible synthesis for the list view. */
  by_person(person_ids: string[], caller: Caller): Map<string, PersonSynthesis> {
    const out = new Map<string, PersonSynthesis>();
    for (const pid of person_ids) {
      const s = this.get_for_person(pid, caller);
      if (s) out.set(pid, s);
    }
    return out;
  }

  /** Remove all synthesis rows for a person (purge_person parity). Returns rows removed. */
  delete_for_person(person_id: string): number {
    return this.db.prepare(`DELETE FROM person_synthesis WHERE person_id = @p`).run({ '@p': person_id }).changes ?? 0;
  }

  get_meta(key: string): string | null {
    const row = this.db.prepare(`SELECT value FROM person_synthesis_meta WHERE key = @k`).get({ '@k': key }) as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  }

  set_meta(key: string, value: string): void {
    this.db
      .prepare(
        `INSERT INTO person_synthesis_meta (key, value) VALUES (@k, @v)
         ON CONFLICT(key) DO UPDATE SET value = @v`,
      )
      .run({ '@k': key, '@v': value });
  }
}
