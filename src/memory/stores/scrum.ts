/**
 * Beatrice's scrum / dev-board store — the persistence + ranking layer behind
 * the `scrum` office pane and Beatrice's grooming/standup ceremonies.
 *
 * Adapted from the scrum-starter-kit blueprint (`~/Downloads/scrum-starter-kit`)
 * with two refinements baked into the schema (see structured.ts): epics carry a
 * `type` (feature | bug) and bugs a `severity`, and the `board` partition is
 * repurposed to backend|ios — the two Hearth repos — over ONE sprint and ONE
 * capacity pool. The blueprint's "decision queue" is NOT here: a blocking
 * judgment call is filed as a `scrum_decision` proposal (one "awaiting you"
 * queue, with push + step-up), so this store owns projects/epics/sprints/
 * retros/notes and the lane-transition event log only.
 *
 * Tables live in the shared hearth.db (structured.ts SCHEMA_SQL); this class
 * takes that db handle and queries them — the same pattern as
 * `ResaleItemsStore`. System-global (no user_id): owner-only internal dev work.
 *
 * Ranking is deterministic and lives here so the read tool and the pane
 * composer share one ordering (no LLM in the sort — Beatrice's reasoning is for
 * grooming JUDGMENT, not the sort): roi = value/effort for features; bugs map
 * severity → a synthetic value so high/medium/low bugs interleave with features
 * by roi, while a CRITICAL bug always tops the list. Unscored epics are flagged,
 * never silently ranked (the blueprint's rule).
 */

import { ulid } from 'ulid';
import type { Database } from 'bun:sqlite';

export type ScrumBoard = 'backend' | 'ios';
export type ScrumLane =
  | 'product_backlog'
  | 'sprint_backlog'
  | 'in_progress'
  | 'review'
  | 'done';
export type ScrumEpicType = 'feature' | 'bug';
export type ScrumSize = 'S' | 'M' | 'L';
export type ScrumSeverity = 'critical' | 'high' | 'medium' | 'low';

export const LANES: ScrumLane[] = [
  'product_backlog',
  'sprint_backlog',
  'in_progress',
  'review',
  'done',
];

export const LANE_LABELS: Record<ScrumLane, string> = {
  product_backlog: 'Backlog',
  sprint_backlog: 'Sprint',
  in_progress: 'In Progress',
  review: 'Review',
  done: 'Done',
};

export interface ScrumProjectRow {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  board: ScrumBoard;
  sort_order: number;
  archived: number;
  ts_created: string;
}

export interface ScrumSprintRow {
  id: string;
  label: string;
  start_date: string;
  end_date: string;
  capacity_pts: number;
  committed_ids: string[];
  committed_at: string | null;
  closed_at: string | null;
  notes: string | null;
  ts_created: string;
}

export interface ScrumEpicRow {
  id: string;
  project_id: string;
  title: string;
  type: ScrumEpicType;
  size: ScrumSize | null;
  value: ScrumSize | null;
  value_note: string | null;
  severity: ScrumSeverity | null;
  description: string | null;
  lane: ScrumLane;
  board: ScrumBoard | null;
  sprint_id: string | null;
  position: number;
  source_key: string | null;
  /** 1 = soft-archived (removed from the board, kept in the DB). Filtered from every board read by default. */
  archived: number;
  ts_created: string;
  ts_updated: string;
}

interface RawSprint extends Omit<ScrumSprintRow, 'committed_ids'> {
  committed_ids: string | null;
}

// ── ranking (deterministic) ──────────────────────────────────────────────────

const SIZE_PTS: Record<ScrumSize, number> = { S: 1, M: 3, L: 5 };
const BUG_VALUE_PTS: Record<ScrumSeverity, number> = {
  critical: 9, // above any feature's max value (L=5); also short-circuited to the top below
  high: 5,
  medium: 3,
  low: 1,
};

/** Effort points (S/M/L → 1/3/5). Null when unsized. */
export function effort_pts(e: Pick<ScrumEpicRow, 'size'>): number | null {
  return e.size ? SIZE_PTS[e.size] : null;
}

/** Impact points — feature `value`, or a bug's severity mapped onto the same scale. */
export function value_pts(
  e: Pick<ScrumEpicRow, 'type' | 'value' | 'severity'>,
): number | null {
  if (e.type === 'bug') return e.severity ? BUG_VALUE_PTS[e.severity] : null;
  return e.value ? SIZE_PTS[e.value] : null;
}

/** ROI = value / effort. Null when either factor is unscored. */
export function roi(
  e: Pick<ScrumEpicRow, 'type' | 'value' | 'severity' | 'size'>,
): number | null {
  const v = value_pts(e);
  const eff = effort_pts(e);
  if (v == null || eff == null) return null;
  return v / eff;
}

/** True when the epic can't be ranked yet (missing the score it needs). */
export function is_unscored(e: ScrumEpicRow): boolean {
  if (e.type === 'bug') return !e.severity || !e.size;
  return !e.value || !e.size;
}

/**
 * Sort key (descending). A CRITICAL bug always tops the list; everything else
 * (features and high/medium/low bugs) ranks by ROI so a high-severity bug
 * interleaves with high-ROI features. Unscored epics sink (flagged separately).
 */
export function rank_score(e: ScrumEpicRow): number {
  if (e.type === 'bug' && e.severity === 'critical') return 1_000;
  const r = roi(e);
  return r == null ? -1 : r;
}

/** The blueprint's grooming quadrant (features) / severity label (bugs). */
export function quadrant(e: ScrumEpicRow): string {
  if (e.type === 'bug') return e.severity ? `${e.severity} bug` : 'unscored bug';
  if (!e.value || !e.size) return 'Unscored';
  if (e.value === 'L' && e.size === 'S') return 'Quick Win';
  if (e.value === 'L') return 'Strategic';
  if (e.size === 'S') return 'Fill-in';
  return 'Drop';
}

/** Effective board for an epic — per-epic override falls back to its project's. */
export function effective_board(
  epic: Pick<ScrumEpicRow, 'board'>,
  project: Pick<ScrumProjectRow, 'board'>,
): ScrumBoard {
  return epic.board ?? project.board;
}

// ── board read shape ─────────────────────────────────────────────────────────

/** One ranked card as the board surfaces it. */
export interface ScrumCard {
  id: string;
  title: string;
  type: ScrumEpicType;
  size: ScrumSize | null;
  value: ScrumSize | null;
  severity: ScrumSeverity | null;
  board: ScrumBoard;
  lane: ScrumLane;
  roi: number | null;
  quadrant: string;
  unscored: boolean;
  description: string | null;
  value_note: string | null;
  project_slug: string;
  project_name: string;
}

export interface SayDo {
  committed: number; // points committed at planning
  shipped: number; // committed points that reached `done`
  pct: number | null; // shipped / committed, 0..100; null when nothing committed
}

export interface ScrumBoardView {
  sprint: {
    label: string;
    start_date: string;
    end_date: string;
    capacity_pts: number;
    committed_at: string | null;
    day: number; // 1-based day within the sprint window (clamped)
    total: number; // total days in the window
  } | null;
  /** Cards per lane, each lane already rank-sorted. */
  lanes: Record<ScrumLane, ScrumCard[]>;
  say_do: SayDo;
  /** Committed points split across the two repos. */
  split: { backend: number; ios: number };
  generated_at: string;
}

// ── store ─────────────────────────────────────────────────────────────────────

const SIZE_VALUES: ScrumSize[] = ['S', 'M', 'L'];
const SEVERITY_VALUES: ScrumSeverity[] = ['critical', 'high', 'medium', 'low'];

export class ScrumStore {
  constructor(private db: Database) {}

  // — projects —

  create_project(input: {
    name: string;
    slug: string;
    description?: string | null;
    board?: ScrumBoard;
    sort_order?: number;
  }): ScrumProjectRow {
    const ts = new Date().toISOString();
    const id = `scp_${ulid().toLowerCase().slice(-12)}`;
    this.db
      .prepare(
        `INSERT INTO scrum_projects (id, name, slug, description, board, sort_order, archived, ts_created)
         VALUES (@id, @name, @slug, @desc, @board, @sort, 0, @ts)`,
      )
      .run({
        '@id': id,
        '@name': input.name,
        '@slug': input.slug,
        '@desc': input.description ?? null,
        '@board': input.board ?? 'backend',
        '@sort': input.sort_order ?? 100,
        '@ts': ts,
      });
    return this.get_project(id)!;
  }

  get_project(id: string): ScrumProjectRow | null {
    return (
      (this.db
        .prepare(`SELECT * FROM scrum_projects WHERE id = @id`)
        .get({ '@id': id }) as ScrumProjectRow | undefined) ?? null
    );
  }

  project_by_slug(slug: string): ScrumProjectRow | null {
    return (
      (this.db
        .prepare(`SELECT * FROM scrum_projects WHERE slug = @slug`)
        .get({ '@slug': slug }) as ScrumProjectRow | undefined) ?? null
    );
  }

  list_projects(): ScrumProjectRow[] {
    return this.db
      .prepare(
        `SELECT * FROM scrum_projects WHERE archived = 0 ORDER BY sort_order, name`,
      )
      .all() as ScrumProjectRow[];
  }

  // — sprints —

  /** The single open (not-yet-closed) sprint, if any. */
  open_sprint(): ScrumSprintRow | null {
    const r = this.db
      .prepare(
        `SELECT * FROM scrum_sprints WHERE closed_at IS NULL ORDER BY ts_created DESC LIMIT 1`,
      )
      .get() as RawSprint | undefined;
    return r ? hydrate_sprint(r) : null;
  }

  get_sprint(id: string): ScrumSprintRow | null {
    const r = this.db
      .prepare(`SELECT * FROM scrum_sprints WHERE id = @id`)
      .get({ '@id': id }) as RawSprint | undefined;
    return r ? hydrate_sprint(r) : null;
  }

  /** Single-open-sprint invariant: refuse if one is already open. */
  create_sprint(input: {
    label: string;
    start_date: string;
    end_date: string;
    capacity_pts?: number;
  }): ScrumSprintRow {
    if (this.open_sprint()) {
      throw new Error(
        'A sprint is already open — close it (scrum_sprint_write close) before creating a new one.',
      );
    }
    const ts = new Date().toISOString();
    const id = `ssp_${ulid().toLowerCase().slice(-12)}`;
    this.db
      .prepare(
        `INSERT INTO scrum_sprints (id, label, start_date, end_date, capacity_pts, ts_created)
         VALUES (@id, @label, @sd, @ed, @cap, @ts)`,
      )
      .run({
        '@id': id,
        '@label': input.label,
        '@sd': input.start_date,
        '@ed': input.end_date,
        '@cap': input.capacity_pts ?? 10,
        '@ts': ts,
      });
    return this.get_sprint(id)!;
  }

  /**
   * Commit a set of epics to the open sprint: stamp committed_ids + committed_at,
   * stamp sprint_id on each epic, and move each into `sprint_backlog` (writing
   * the lane-transition event). Never call without explicit human approval — the
   * grooming ceremony routes this through a `scrum_decision` proposal.
   */
  commit_sprint(epic_ids: string[], actor = 'beatrice'): ScrumSprintRow {
    const sprint = this.open_sprint();
    if (!sprint) throw new Error('No open sprint to commit to.');
    // Deterministic gate: you cannot commit an unscored backlog. This blocks the
    // tool, the API, AND the scrum_decision dispatch — regardless of what the
    // model claims about the board's state. (Beatrice has confabulated "all
    // scored" while the board was 0/55; this makes that claim un-actable.)
    const unscored = epic_ids
      .map((id) => this.get_epic(id))
      .filter((e): e is ScrumEpicRow => !!e && is_unscored(e));
    if (unscored.length > 0) {
      throw new Error(
        `Cannot commit ${unscored.length} UNSCORED epic(s) — score them first ` +
          `(size + value for features, size + severity for bugs) via ` +
          `scrum_epic_write(action:'score', items:[...]). Unscored: ` +
          unscored.map((e) => `${e.id} "${e.title.slice(0, 40)}"`).join('; '),
      );
    }
    const ts = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE scrum_sprints SET committed_ids = @ids, committed_at = @ts WHERE id = @id`,
      )
      .run({
        '@ids': JSON.stringify(epic_ids),
        '@ts': ts,
        '@id': sprint.id,
      });
    for (const eid of epic_ids) {
      const epic = this.get_epic(eid);
      if (!epic) continue;
      this.db
        .prepare(`UPDATE scrum_epics SET sprint_id = @sid WHERE id = @id`)
        .run({ '@sid': sprint.id, '@id': eid });
      if (epic.lane === 'product_backlog') {
        this.move_epic(eid, 'sprint_backlog', actor);
      }
    }
    return this.get_sprint(sprint.id)!;
  }

  close_sprint(notes?: string | null, actor = 'beatrice'): ScrumSprintRow {
    const sprint = this.open_sprint();
    if (!sprint) throw new Error('No open sprint to close.');
    const ts = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE scrum_sprints SET closed_at = @ts, notes = COALESCE(@notes, notes) WHERE id = @id`,
      )
      .run({ '@ts': ts, '@notes': notes ?? null, '@id': sprint.id });
    void actor;
    return this.get_sprint(sprint.id)!;
  }

  // — epics —

  get_epic(id: string): ScrumEpicRow | null {
    return (
      (this.db
        .prepare(`SELECT * FROM scrum_epics WHERE id = @id`)
        .get({ '@id': id }) as ScrumEpicRow | undefined) ?? null
    );
  }

  list_epics(filter?: {
    project_id?: string;
    lane?: ScrumLane;
    board?: ScrumBoard;
    /** Include soft-archived epics (default false — archived rows are hidden from the board). */
    include_archived?: boolean;
  }): ScrumEpicRow[] {
    const where: string[] = [];
    const params: Record<string, string> = {};
    if (!filter?.include_archived) where.push('archived = 0');
    if (filter?.project_id) {
      where.push('project_id = @pid');
      params['@pid'] = filter.project_id;
    }
    if (filter?.lane) {
      where.push('lane = @lane');
      params['@lane'] = filter.lane;
    }
    const sql =
      `SELECT * FROM scrum_epics` +
      (where.length ? ` WHERE ${where.join(' AND ')}` : '') +
      ` ORDER BY position`;
    let rows = this.db.prepare(sql).all(params) as ScrumEpicRow[];
    if (filter?.board) {
      const projects = new Map(this.list_projects().map((p) => [p.id, p]));
      rows = rows.filter((e) => {
        const proj = projects.get(e.project_id);
        return proj ? effective_board(e, proj) === filter.board : false;
      });
    }
    return rows;
  }

  /**
   * Keyword search across epics — substring match on title + description, so a
   * specific epic can be resolved to its `id` from a distinctive word in its
   * name (e.g. "Satellite1 wake-word") WITHOUT a human pasting `sep_xxxxxx`.
   * This is the targeted-lookup counterpart to the capped canvas render (which
   * deliberately shows only the top cards per lane): a backlog of 60 epics has
   * no other way to reach #30 by name.
   *
   * Multi-term: the query is whitespace-split and EVERY term must match (in
   * either field), so word order and any invisible characters BETWEEN words
   * (the copy/paste-from-the-board case) don't break the match — search a couple
   * of distinctive words, not the whole pasted string. LIKE metacharacters in
   * the query are escaped, so a literal `_`/`%` matches itself rather than
   * acting as a wildcard. Newest-touched first; capped at `limit` (default 25,
   * max 100). Optional project/lane scoping. A blank query returns `[]` (never a
   * full dump). Match is ASCII case-insensitive (SQLite LIKE default).
   */
  search_epics(
    query: string,
    filter?: { project_id?: string; lane?: ScrumLane; limit?: number },
  ): ScrumEpicRow[] {
    const terms = query
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    if (terms.length === 0) return [];

    const where: string[] = [];
    const params: Record<string, string | number> = {};
    terms.forEach((term, i) => {
      const key = `@t${i}`;
      // Escape LIKE wildcards so the term matches itself literally.
      params[key] = `%${term.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
      where.push(`(title LIKE ${key} ESCAPE '\\' OR description LIKE ${key} ESCAPE '\\')`);
    });
    where.push('archived = 0');
    if (filter?.project_id) {
      where.push('project_id = @pid');
      params['@pid'] = filter.project_id;
    }
    if (filter?.lane) {
      where.push('lane = @lane');
      params['@lane'] = filter.lane;
    }
    params['@limit'] = Math.min(Math.max(filter?.limit ?? 25, 1), 100);

    const sql =
      `SELECT * FROM scrum_epics WHERE ${where.join(' AND ')} ` +
      `ORDER BY ts_updated DESC LIMIT @limit`;
    return this.db.prepare(sql).all(params) as ScrumEpicRow[];
  }

  create_epic(input: {
    project_id: string;
    title: string;
    type?: ScrumEpicType;
    size?: ScrumSize | null;
    value?: ScrumSize | null;
    value_note?: string | null;
    severity?: ScrumSeverity | null;
    description?: string | null;
    lane?: ScrumLane;
    board?: ScrumBoard | null;
    source_key?: string | null;
  }): ScrumEpicRow {
    const ts = new Date().toISOString();
    const id = `sep_${ulid().toLowerCase().slice(-12)}`;
    const lane = input.lane ?? 'product_backlog';
    // Insert at the bottom of the lane (max position + 1024).
    const max = (
      this.db
        .prepare(
          `SELECT MAX(position) AS m FROM scrum_epics WHERE project_id = @pid AND lane = @lane`,
        )
        .get({ '@pid': input.project_id, '@lane': lane }) as { m: number | null }
    ).m;
    const position = (max ?? 64512) + 1024;
    this.db
      .prepare(
        `INSERT INTO scrum_epics
           (id, project_id, title, type, size, value, value_note, severity,
            description, lane, board, sprint_id, position, source_key, ts_created, ts_updated)
         VALUES (@id, @pid, @title, @type, @size, @value, @vnote, @sev,
                 @desc, @lane, @board, NULL, @pos, @skey, @ts, @ts)`,
      )
      .run({
        '@id': id,
        '@pid': input.project_id,
        '@title': input.title,
        '@type': input.type ?? 'feature',
        '@size': input.size ?? null,
        '@value': input.value ?? null,
        '@vnote': input.value_note ?? null,
        '@sev': input.severity ?? null,
        '@desc': input.description ?? null,
        '@lane': lane,
        '@board': input.board ?? null,
        '@pos': position,
        '@skey': input.source_key ?? null,
        '@ts': ts,
      });
    // The create itself is the first lane event (from nothing → its lane).
    this.log_event(id, null, lane, 'beatrice');
    return this.get_epic(id)!;
  }

  /** Find an epic by its importer dedup key (e.g. 'next:0d'). */
  get_epic_by_source(source_key: string): ScrumEpicRow | null {
    return (
      (this.db
        .prepare(`SELECT * FROM scrum_epics WHERE source_key = @k`)
        .get({ '@k': source_key }) as ScrumEpicRow | undefined) ?? null
    );
  }

  /**
   * Upsert an epic keyed by `source_key` — the re-runnable importer path. First
   * import creates it in `product_backlog` (board inferred by the caller); a
   * re-import updates only CONTENT (title/type/description) and deliberately
   * does NOT touch lane, board, size, or value — so any grooming/scoring the
   * human or Beatrice applied survives a re-run. Returns `{ epic, created }`.
   */
  upsert_epic_by_source(
    source_key: string,
    input: {
      project_id: string;
      title: string;
      type?: ScrumEpicType;
      description?: string | null;
      board?: ScrumBoard | null;
    },
  ): { epic: ScrumEpicRow; created: boolean } {
    const existing = this.get_epic_by_source(source_key);
    if (existing) {
      const epic = this.update_epic(existing.id, {
        title: input.title,
        type: input.type,
        description: input.description,
      });
      return { epic, created: false };
    }
    const epic = this.create_epic({
      project_id: input.project_id,
      title: input.title,
      type: input.type ?? 'feature',
      description: input.description ?? null,
      board: input.board ?? null,
      lane: 'product_backlog',
      source_key,
    });
    return { epic, created: true };
  }

  update_epic(
    id: string,
    fields: Partial<
      Pick<
        ScrumEpicRow,
        | 'title'
        | 'type'
        | 'size'
        | 'value'
        | 'value_note'
        | 'severity'
        | 'description'
        | 'board'
        | 'archived'
      >
    >,
  ): ScrumEpicRow {
    const epic = this.get_epic(id);
    if (!epic) throw new Error(`No such epic: ${id}`);
    const sets: string[] = [];
    const params: Record<string, string | number | null> = { '@id': id };
    const set = (col: string, key: string, val: string | number | null) => {
      sets.push(`${col} = ${key}`);
      params[key] = val;
    };
    if (fields.title !== undefined) set('title', '@title', fields.title);
    if (fields.type !== undefined) set('type', '@type', fields.type);
    if (fields.size !== undefined) set('size', '@size', fields.size);
    if (fields.value !== undefined) set('value', '@value', fields.value);
    if (fields.value_note !== undefined) set('value_note', '@vnote', fields.value_note);
    if (fields.severity !== undefined) set('severity', '@sev', fields.severity);
    if (fields.description !== undefined) set('description', '@desc', fields.description);
    if (fields.board !== undefined) set('board', '@board', fields.board);
    if (fields.archived !== undefined) set('archived', '@arch', fields.archived);
    if (sets.length === 0) return epic;
    set('ts_updated', '@ts', new Date().toISOString());
    this.db.prepare(`UPDATE scrum_epics SET ${sets.join(', ')} WHERE id = @id`).run(params);
    return this.get_epic(id)!;
  }

  /** Move an epic to a lane — ALWAYS writes a lane-transition event. */
  move_epic(id: string, to_lane: ScrumLane, actor = 'beatrice', position?: number): ScrumEpicRow {
    const epic = this.get_epic(id);
    if (!epic) throw new Error(`No such epic: ${id}`);
    const from_lane = epic.lane;
    const ts = new Date().toISOString();
    let pos = position;
    if (pos === undefined) {
      const max = (
        this.db
          .prepare(
            `SELECT MAX(position) AS m FROM scrum_epics WHERE project_id = @pid AND lane = @lane`,
          )
          .get({ '@pid': epic.project_id, '@lane': to_lane }) as { m: number | null }
      ).m;
      pos = (max ?? 64512) + 1024;
    }
    this.db
      .prepare(`UPDATE scrum_epics SET lane = @lane, position = @pos, ts_updated = @ts WHERE id = @id`)
      .run({ '@lane': to_lane, '@pos': pos, '@ts': ts, '@id': id });
    if (from_lane !== to_lane) this.log_event(id, from_lane, to_lane, actor);
    return this.get_epic(id)!;
  }

  /**
   * Soft-archive an epic — remove it from the board (junk / obsolete / wrong)
   * without a destructive delete, so it's recoverable and history survives.
   * Idempotent. Refuses an epic committed to the OPEN sprint (archiving it would
   * silently distort say/do); move it out of the sprint first. The audit row is
   * written by the caller (route / tool).
   */
  archive_epic(id: string): ScrumEpicRow {
    const epic = this.get_epic(id);
    if (!epic) throw new Error(`No such epic: ${id}`);
    if (epic.archived) return epic;
    const sprint = this.open_sprint();
    if (sprint && sprint.committed_ids.includes(id)) {
      throw new Error(
        `Cannot archive ${id}: it's committed to the open sprint '${sprint.label}'. Move it out of the sprint first.`,
      );
    }
    this.db
      .prepare(`UPDATE scrum_epics SET archived = 1, ts_updated = @ts WHERE id = @id`)
      .run({ '@ts': new Date().toISOString(), '@id': id });
    return this.get_epic(id)!;
  }

  /** Restore a soft-archived epic back onto the board (in whatever lane it held). Idempotent. */
  unarchive_epic(id: string): ScrumEpicRow {
    const epic = this.get_epic(id);
    if (!epic) throw new Error(`No such epic: ${id}`);
    if (!epic.archived) return epic;
    this.db
      .prepare(`UPDATE scrum_epics SET archived = 0, ts_updated = @ts WHERE id = @id`)
      .run({ '@ts': new Date().toISOString(), '@id': id });
    return this.get_epic(id)!;
  }

  /** The archive — soft-archived epics, newest-touched first (for an "archived" view / restore picker). */
  list_archived(): ScrumEpicRow[] {
    return this.db
      .prepare(`SELECT * FROM scrum_epics WHERE archived = 1 ORDER BY ts_updated DESC`)
      .all() as ScrumEpicRow[];
  }

  /**
   * Batch-score epics in one call — the grooming primitive. Each item sets any
   * of size / value (features) / severity (bugs) / value_note on one epic; only
   * provided fields are written (undefined is left untouched). This is what lets
   * a specialist score a whole backlog without one tool-round per epic. Returns
   * the count scored + any ids that didn't exist.
   */
  score_epics(
    items: Array<{
      epic_id: string;
      size?: ScrumSize | null;
      value?: ScrumSize | null;
      severity?: ScrumSeverity | null;
      value_note?: string | null;
    }>,
  ): { scored: number; not_found: string[] } {
    let scored = 0;
    const not_found: string[] = [];
    for (const it of items) {
      if (!this.get_epic(it.epic_id)) {
        not_found.push(it.epic_id);
        continue;
      }
      this.update_epic(it.epic_id, {
        ...(it.size !== undefined ? { size: it.size } : {}),
        ...(it.value !== undefined ? { value: it.value } : {}),
        ...(it.severity !== undefined ? { severity: it.severity } : {}),
        ...(it.value_note !== undefined ? { value_note: it.value_note } : {}),
      });
      scored++;
    }
    return { scored, not_found };
  }

  private log_event(
    epic_id: string,
    from_lane: ScrumLane | null,
    to_lane: ScrumLane,
    actor: string,
  ): void {
    const sprint = this.open_sprint();
    this.db
      .prepare(
        `INSERT INTO scrum_epic_events (id, epic_id, from_lane, to_lane, sprint_id, actor, ts_created)
         VALUES (@id, @eid, @from, @to, @sid, @actor, @ts)`,
      )
      .run({
        '@id': `sev_${ulid().toLowerCase().slice(-12)}`,
        '@eid': epic_id,
        '@from': from_lane,
        '@to': to_lane,
        '@sid': sprint?.id ?? null,
        '@actor': actor,
        '@ts': new Date().toISOString(),
      });
  }

  // — retros + notes —

  add_retro(input: {
    sprint_id?: string | null;
    went_well?: string | null;
    slipped?: string | null;
    lessons?: string | null;
  }): void {
    const sprint_id = input.sprint_id ?? this.open_sprint()?.id;
    if (!sprint_id) throw new Error('No sprint to attach a retro to.');
    this.db
      .prepare(
        `INSERT INTO scrum_retros (id, sprint_id, went_well, slipped, lessons, ts_created)
         VALUES (@id, @sid, @ww, @sl, @le, @ts)`,
      )
      .run({
        '@id': `srt_${ulid().toLowerCase().slice(-12)}`,
        '@sid': sprint_id,
        '@ww': input.went_well ?? null,
        '@sl': input.slipped ?? null,
        '@le': input.lessons ?? null,
        '@ts': new Date().toISOString(),
      });
  }

  add_note(input: {
    project_id?: string | null;
    body: string;
    kind?: 'fyi' | 'progress' | 'observation';
    pinned?: boolean;
  }): void {
    this.db
      .prepare(
        `INSERT INTO scrum_notes (id, project_id, body, kind, pinned, ts_created)
         VALUES (@id, @pid, @body, @kind, @pinned, @ts)`,
      )
      .run({
        '@id': `snt_${ulid().toLowerCase().slice(-12)}`,
        '@pid': input.project_id ?? null,
        '@body': input.body,
        '@kind': input.kind ?? 'fyi',
        '@pinned': input.pinned ? 1 : 0,
        '@ts': new Date().toISOString(),
      });
  }

  // — board read —

  /** The full board, lanes rank-sorted, with say/do + the backend/ios split. */
  read_board(): ScrumBoardView {
    const projects = new Map(this.list_projects().map((p) => [p.id, p]));
    const epics = this.list_epics();
    const lanes = empty_lanes();
    for (const e of epics) {
      const proj = projects.get(e.project_id);
      if (!proj) continue;
      lanes[e.lane].push(to_card(e, proj));
    }
    for (const lane of LANES) {
      lanes[lane].sort((a, b) => rank_for_card(b) - rank_for_card(a));
    }

    const sprint = this.open_sprint();
    let say_do: SayDo = { committed: 0, shipped: 0, pct: null };
    let split = { backend: 0, ios: 0 };
    let sprintView: ScrumBoardView['sprint'] = null;
    if (sprint) {
      const committed_ids = sprint.committed_ids;
      const committed_epics = committed_ids
        .map((id) => epics.find((e) => e.id === id))
        .filter((e): e is ScrumEpicRow => !!e);
      const pts = (e: ScrumEpicRow) => effort_pts(e) ?? 0;
      const committed = committed_epics.reduce((s, e) => s + pts(e), 0);
      const shipped = committed_epics
        .filter((e) => e.lane === 'done')
        .reduce((s, e) => s + pts(e), 0);
      say_do = {
        committed,
        shipped,
        pct: committed > 0 ? Math.round((shipped / committed) * 100) : null,
      };
      for (const e of committed_epics) {
        const proj = projects.get(e.project_id);
        if (!proj) continue;
        split[effective_board(e, proj)] += pts(e);
      }
      const { day, total } = sprint_day(sprint);
      sprintView = {
        label: sprint.label,
        start_date: sprint.start_date,
        end_date: sprint.end_date,
        capacity_pts: sprint.capacity_pts,
        committed_at: sprint.committed_at,
        day,
        total,
      };
    }

    return {
      sprint: sprintView,
      lanes,
      say_do,
      split,
      generated_at: new Date().toISOString(),
    };
  }

  /**
   * Burndown points for the open sprint: committed points still NOT done, per
   * elapsed day. Cheap reconstruction from the event log — for each day in the
   * window, count committed epics whose LAST move on/before that day wasn't into
   * `done`. Returns `{ x: 'd1', remaining }` buckets, oldest first.
   */
  burndown(): Array<{ x: string; remaining: number }> {
    const sprint = this.open_sprint();
    if (!sprint) return [];
    const committed_ids = sprint.committed_ids;
    if (committed_ids.length === 0) return [];
    const placeholders = committed_ids.map((_, i) => `@e${i}`).join(',');
    const params: Record<string, string> = {};
    committed_ids.forEach((id, i) => (params[`@e${i}`] = id));
    const epics = this.db
      .prepare(`SELECT * FROM scrum_epics WHERE id IN (${placeholders})`)
      .all(params) as ScrumEpicRow[];
    const total_pts = epics.reduce((s, e) => s + (effort_pts(e) ?? 0), 0);
    const events = this.db
      .prepare(
        `SELECT epic_id, to_lane, ts_created FROM scrum_epic_events
          WHERE epic_id IN (${placeholders}) ORDER BY ts_created`,
      )
      .all(params) as Array<{ epic_id: string; to_lane: ScrumLane; ts_created: string }>;
    const pts_of = new Map(epics.map((e) => [e.id, effort_pts(e) ?? 0]));

    const { total } = sprint_day(sprint);
    const start = Date.parse(`${sprint.start_date}T00:00:00`);
    const out: Array<{ x: string; remaining: number }> = [];
    for (let d = 1; d <= total; d++) {
      const cutoff = start + d * 24 * 60 * 60 * 1000;
      const done_at_cutoff = new Map<string, boolean>();
      for (const ev of events) {
        if (Date.parse(ev.ts_created) <= cutoff) {
          done_at_cutoff.set(ev.epic_id, ev.to_lane === 'done');
        }
      }
      let done_pts = 0;
      for (const [eid, isDone] of done_at_cutoff) if (isDone) done_pts += pts_of.get(eid) ?? 0;
      out.push({ x: `d${d}`, remaining: Math.max(0, total_pts - done_pts) });
    }
    return out;
  }

  /**
   * GitHub-style contribution heatmap data — daily counts of lane-transition
   * events (creates + moves) over the trailing `weeks` window ending today.
   * Dense (one entry per day, oldest first) so the client just lays them into
   * Sunday-aligned week columns. The board's activity pulse.
   */
  activity_heatmap(weeks = 53): {
    days: Array<{ date: string; count: number }>;
    max: number;
    total: number;
  } {
    const today = new Date();
    const end = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()); // time-guard-ok: UTC calendar-day grid for a GitHub-style heatmap; tz-independent by design
    const span = weeks * 7;
    const startMs = end - (span - 1) * 86400000;
    const startIso = new Date(startMs).toISOString().slice(0, 10); // time-guard-ok: UTC day-bucket key matched against substr(ts_created,1,10) UTC dates
    const rows = this.db
      .prepare(
        `SELECT substr(ts_created, 1, 10) AS d, COUNT(*) AS n
           FROM scrum_epic_events
          WHERE substr(ts_created, 1, 10) >= @start
          GROUP BY d`,
      )
      .all({ '@start': startIso }) as Array<{ d: string; n: number }>;
    const counts = new Map(rows.map((r) => [r.d, r.n]));
    const days: Array<{ date: string; count: number }> = [];
    let max = 0;
    let total = 0;
    for (let i = 0; i < span; i++) {
      const date = new Date(startMs + i * 86400000).toISOString().slice(0, 10); // time-guard-ok: dense UTC day grid, oldest-first; client lays into Sunday-aligned columns
      const count = counts.get(date) ?? 0;
      days.push({ date, count });
      if (count > max) max = count;
      total += count;
    }
    return { days, max, total };
  }

  /**
   * Shipped history — the "roadmap / work done" view. Every epic in the `done`
   * lane, stamped with when it shipped (its last transition into `done`, from
   * the event log) and which sprint it rode. Newest first. This is what a Claude
   * session queries to understand what's already been built (the replacement for
   * scanning the shipped-YYYY-MM.md logs).
   */
  shipped_history(limit = 100): Array<{
    id: string;
    title: string;
    type: ScrumEpicType;
    size: ScrumSize | null;
    board: ScrumBoard | null;
    project_slug: string | null;
    sprint_label: string | null;
    shipped_at: string | null;
  }> {
    const projects = new Map(this.list_projects().map((p) => [p.id, p]));
    const sprints = new Map(
      (this.db.prepare(`SELECT id, label FROM scrum_sprints`).all() as Array<{
        id: string;
        label: string;
      }>).map((s) => [s.id, s.label]),
    );
    const rows = this.db
      .prepare(
        `SELECT e.*,
                (SELECT MAX(ev.ts_created) FROM scrum_epic_events ev
                  WHERE ev.epic_id = e.id AND ev.to_lane = 'done') AS shipped_at
           FROM scrum_epics e
          WHERE e.lane = 'done' AND e.archived = 0
          ORDER BY shipped_at DESC NULLS LAST
          LIMIT @lim`,
      )
      .all({ '@lim': limit }) as Array<ScrumEpicRow & { shipped_at: string | null }>;
    return rows.map((r) => {
      const proj = projects.get(r.project_id);
      return {
        id: r.id,
        title: r.title,
        type: r.type,
        size: r.size,
        board: proj ? effective_board(r, proj) : r.board,
        project_slug: proj?.slug ?? null,
        sprint_label: r.sprint_id ? sprints.get(r.sprint_id) ?? null : null,
        shipped_at: r.shipped_at,
      };
    });
  }

  /**
   * Token-budgeted standup précis (the blueprint's `/llm-context.json` analog).
   * Shaped for Beatrice's standup/grooming reasoning — small on purpose.
   */
  standup_precis(): {
    sprint: { label: string; day: number; total: number } | null;
    say_do: SayDo;
    split: { backend: number; ios: number };
    in_progress: Array<{ title: string; board: ScrumBoard }>;
    next_up: Array<{ title: string; size: ScrumSize | null; board: ScrumBoard; roi: number | null }>;
    unscored: number;
    generated_at: string;
  } {
    const board = this.read_board();
    const next_up = [...board.lanes.product_backlog]
      .slice(0, 5)
      .map((c) => ({ title: c.title, size: c.size, board: c.board, roi: c.roi }));
    const in_progress = board.lanes.in_progress.map((c) => ({ title: c.title, board: c.board }));
    const unscored = LANES.flatMap((l) => board.lanes[l]).filter((c) => c.unscored).length;
    return {
      sprint: board.sprint
        ? { label: board.sprint.label, day: board.sprint.day, total: board.sprint.total }
        : null,
      say_do: board.say_do,
      split: board.split,
      in_progress,
      next_up,
      unscored,
      generated_at: board.generated_at,
    };
  }
}

// ── hydration + helpers ───────────────────────────────────────────────────────

function hydrate_sprint(r: RawSprint): ScrumSprintRow {
  let committed: string[] = [];
  if (r.committed_ids) {
    try {
      const parsed = JSON.parse(r.committed_ids) as unknown;
      if (Array.isArray(parsed)) committed = parsed.filter((x): x is string => typeof x === 'string');
    } catch {
      committed = [];
    }
  }
  return { ...r, committed_ids: committed };
}

function empty_lanes(): Record<ScrumLane, ScrumCard[]> {
  return {
    product_backlog: [],
    sprint_backlog: [],
    in_progress: [],
    review: [],
    done: [],
  };
}

function to_card(e: ScrumEpicRow, proj: ScrumProjectRow): ScrumCard {
  const r = roi(e);
  return {
    id: e.id,
    title: e.title,
    type: e.type,
    size: e.size,
    value: e.value,
    severity: e.severity,
    board: effective_board(e, proj),
    lane: e.lane,
    roi: r,
    quadrant: quadrant(e),
    unscored: is_unscored(e),
    description: e.description,
    value_note: e.value_note,
    project_slug: proj.slug,
    project_name: proj.name,
  };
}

/** Rank a hydrated card (mirrors rank_score on the row). */
function rank_for_card(c: ScrumCard): number {
  if (c.type === 'bug' && c.severity === 'critical') return 1_000;
  return c.roi == null ? -1 : c.roi;
}

/** 1-based current day within a sprint window + total days. Clamped to the window. */
function sprint_day(s: Pick<ScrumSprintRow, 'start_date' | 'end_date'>): {
  day: number;
  total: number;
} {
  const start = Date.parse(`${s.start_date}T00:00:00`);
  const end = Date.parse(`${s.end_date}T23:59:59`);
  const now = Date.now();
  const dayMs = 24 * 60 * 60 * 1000;
  const total = Math.max(1, Math.round((end - start) / dayMs));
  const elapsed = Math.floor((now - start) / dayMs) + 1;
  return { day: Math.min(Math.max(1, elapsed), total), total };
}

/** Validate a size token at the tool boundary. */
export function is_size(x: unknown): x is ScrumSize {
  return typeof x === 'string' && SIZE_VALUES.includes(x as ScrumSize);
}

/** Validate a severity token at the tool boundary. */
export function is_severity(x: unknown): x is ScrumSeverity {
  return typeof x === 'string' && SEVERITY_VALUES.includes(x as ScrumSeverity);
}
