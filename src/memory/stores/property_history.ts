/**
 * property_history — Anna's longitudinal property store: the value-over-time
 * series behind her office sparkline, plus the owner-reported home
 * improvements that feed value reassessment.
 *
 * Small structured data, so it lives in the MAIN hearth.db (unlike the
 * 168MB assessor cache, which has its own file) — the pane composer and
 * peer specialists (Vivian for cost) can read it without a second handle.
 *
 * Two tables:
 *   property_value_history — one row per (account, source, as-of date):
 *     the multi-source value series. source ∈ county | zillow_zestimate |
 *     redfin | sale | anna_estimate. UNIQUE(account_no, source, as_of_date)
 *     so re-recording the same datum updates in place.
 *   property_improvements — owner-reported features/upgrades that add value:
 *     title, category, cost, est_value_add, status (planned|done).
 */

import { Database } from 'bun:sqlite';
import { dirname, resolve } from 'node:path';
import { mkdirSync } from 'node:fs';
import { ulid } from 'ulid';

export type ValueSource =
  | 'county'
  | 'zillow_zestimate'
  | 'redfin'
  | 'sale'
  | 'anna_estimate';

export interface ValuePoint {
  id: string;
  account_no: string | null;
  address: string | null;
  as_of_date: string; // YYYY-MM-DD
  source: ValueSource;
  value: number;
  note: string | null;
  ts_created: string;
}

export interface Improvement {
  id: string;
  account_no: string | null;
  address: string | null;
  date_done: string | null; // YYYY-MM-DD
  title: string;
  category: string | null;
  cost: number | null;
  est_value_add: number | null;
  status: 'planned' | 'done';
  note: string | null;
  ts_created: string;
}

function db_path(): string {
  const main = process.env.HEARTH_DB_PATH ?? './data/hearth.db';
  return resolve(main);
}

export class PropertyHistoryStore {
  private readonly db: Database;

  constructor(path = db_path()) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.init();
  }

  private init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS property_value_history (
        id          TEXT PRIMARY KEY,
        account_no  TEXT,
        address     TEXT,
        as_of_date  TEXT NOT NULL,
        source      TEXT NOT NULL,
        value       REAL NOT NULL,
        note        TEXT,
        ts_created  TEXT NOT NULL,
        UNIQUE(account_no, source, as_of_date)
      );
      CREATE INDEX IF NOT EXISTS idx_pvh_acct ON property_value_history(account_no, as_of_date);

      CREATE TABLE IF NOT EXISTS property_improvements (
        id            TEXT PRIMARY KEY,
        account_no    TEXT,
        address       TEXT,
        date_done     TEXT,
        title         TEXT NOT NULL,
        category      TEXT,
        cost          REAL,
        est_value_add REAL,
        status        TEXT NOT NULL DEFAULT 'done',
        note          TEXT,
        ts_created    TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_pimp_acct ON property_improvements(account_no);
    `);
  }

  /** Insert/update one value datapoint; idempotent on (account, source, date). */
  record_value_point(p: {
    account_no?: string | null;
    address?: string | null;
    as_of_date: string;
    source: ValueSource;
    value: number;
    note?: string | null;
  }): ValuePoint {
    const now = new Date().toISOString();
    const row: ValuePoint = {
      id: ulid(),
      account_no: p.account_no ?? null,
      address: p.address ?? null,
      as_of_date: p.as_of_date,
      source: p.source,
      value: p.value,
      note: p.note ?? null,
      ts_created: now,
    };
    this.db
      .query(
        `INSERT INTO property_value_history
           (id, account_no, address, as_of_date, source, value, note, ts_created)
         VALUES ($id, $account_no, $address, $as_of_date, $source, $value, $note, $ts_created)
         ON CONFLICT(account_no, source, as_of_date)
         DO UPDATE SET value = excluded.value, note = excluded.note, address = excluded.address`,
      )
      .run({
        $id: row.id,
        $account_no: row.account_no,
        $address: row.address,
        $as_of_date: row.as_of_date,
        $source: row.source,
        $value: row.value,
        $note: row.note,
        $ts_created: row.ts_created,
      });
    return row;
  }

  /** All value points for a parcel, oldest → newest. */
  list_value_history(account_no: string): ValuePoint[] {
    return this.db
      .query(
        `SELECT * FROM property_value_history
         WHERE account_no = $a
         ORDER BY as_of_date ASC, source ASC`,
      )
      .all({ $a: account_no }) as ValuePoint[];
  }

  add_improvement(p: {
    account_no?: string | null;
    address?: string | null;
    date_done?: string | null;
    title: string;
    category?: string | null;
    cost?: number | null;
    est_value_add?: number | null;
    status?: 'planned' | 'done';
    note?: string | null;
  }): Improvement {
    const now = new Date().toISOString();
    const row: Improvement = {
      id: ulid(),
      account_no: p.account_no ?? null,
      address: p.address ?? null,
      date_done: p.date_done ?? null,
      title: p.title,
      category: p.category ?? null,
      cost: p.cost ?? null,
      est_value_add: p.est_value_add ?? null,
      status: p.status ?? 'done',
      note: p.note ?? null,
      ts_created: now,
    };
    this.db
      .query(
        `INSERT INTO property_improvements
           (id, account_no, address, date_done, title, category, cost, est_value_add, status, note, ts_created)
         VALUES ($id, $account_no, $address, $date_done, $title, $category, $cost, $est_value_add, $status, $note, $ts_created)`,
      )
      .run({
        $id: row.id,
        $account_no: row.account_no,
        $address: row.address,
        $date_done: row.date_done,
        $title: row.title,
        $category: row.category,
        $cost: row.cost,
        $est_value_add: row.est_value_add,
        $status: row.status,
        $note: row.note,
        $ts_created: row.ts_created,
      });
    return row;
  }

  list_improvements(account_no: string): Improvement[] {
    return this.db
      .query(
        `SELECT * FROM property_improvements
         WHERE account_no = $a
         ORDER BY (date_done IS NULL), date_done DESC, ts_created DESC`,
      )
      .all({ $a: account_no }) as Improvement[];
  }

  /**
   * The household's home parcel — the account with the most recorded
   * activity (value points + improvements). Self-configuring so the office
   * pane needs no hardcoded address; returns null when nothing's recorded.
   */
  most_active_account(): string | null {
    const row = this.db
      .query(
        `SELECT account_no, COUNT(*) AS n FROM (
           SELECT account_no FROM property_value_history WHERE account_no IS NOT NULL
           UNION ALL
           SELECT account_no FROM property_improvements WHERE account_no IS NOT NULL
         ) GROUP BY account_no ORDER BY n DESC LIMIT 1`,
      )
      .get() as { account_no: string; n: number } | null;
    return row?.account_no ?? null;
  }

  /** Sum of est_value_add for completed improvements — the reassessment uplift. */
  sum_value_add(account_no: string, only_done = true): number {
    const row = this.db
      .query(
        `SELECT COALESCE(SUM(est_value_add), 0) AS s
         FROM property_improvements
         WHERE account_no = $a AND est_value_add IS NOT NULL
         ${only_done ? "AND status = 'done'" : ''}`,
      )
      .get({ $a: account_no }) as { s: number };
    return row?.s ?? 0;
  }
}

let _shared: PropertyHistoryStore | null = null;
export function getPropertyHistoryStore(): PropertyHistoryStore {
  if (!_shared) _shared = new PropertyHistoryStore();
  return _shared;
}
