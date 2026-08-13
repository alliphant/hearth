/**
 * your county County assessor cache — the local mirror Anna (Property & Land
 * Specialist) runs comps against.
 *
 * The your county Assessor publishes the full county roll as clean CSVs on
 * Google Cloud Storage (no auth, no bot protection):
 *   https://storage.googleapis.com/lc-public/asr/assessor-public-*.csv
 * They are large (account/value/improvement ~44MB each, sales ~96MB), so
 * `sync_county_assessor_data` STREAMS them in as a background job and bulk-
 * loads them here; the per-turn tools (lookup_parcel / find_comps) then query
 * this cache instantly. Per-cycle refresh is a clean full rebuild.
 *
 * This cache lives in its OWN SQLite file beside hearth.db (default
 * `<dir of HEARTH_DB_PATH>/assessor_county.db`, override with
 * HEARTH_ASSESSOR_DB_PATH) so ~227MB of county data never bloats the main
 * application DB or its backups.
 *
 * Join key across every table is SCHEDULENUM (the assessor schedule number);
 * ACCOUNTNO (the "R…" number) and PARCELNO are also carried. Source columns
 * are the your county CSV headers verbatim — see the per-table ingest mappers.
 */

import { Database } from 'bun:sqlite';
import { dirname, resolve } from 'node:path';

// ── cache DB location ────────────────────────────────────────────────────────

function cache_db_path(): string {
  const override = process.env.HEARTH_ASSESSOR_DB_PATH?.trim();
  if (override) return override;
  const main = process.env.HEARTH_DB_PATH ?? './data/hearth.db';
  return resolve(dirname(main), 'assessor_county.db');
}

// ── public row shapes ────────────────────────────────────────────────────────

export interface ParcelRecord {
  schedule_num: string;
  account_no: string;
  parcel_no: string;
  situs_address: string;
  situs_city: string;
  situs_zip: string;
  subdivision_name: string;
  sub_no: string;
  acct_type: string;
  land_gross_acres: number | null;
  land_gross_sf: number | null;
  total_mill_levy: number | null;
  tax_year: number | null;
  // joined/aggregated
  actual_value_total: number | null;
  actual_value_land: number | null;
  actual_value_improvement: number | null;
  improvement: ImprovementRecord | null;
  recent_sales: SaleRecord[];
  owner_name: string | null;
  /** Heuristic: mailing address matches the situs (owner-occupied → likely
   *  homestead/senior-exemption eligible). null when owner data isn't loaded. */
  owner_occupied: boolean | null;
}

export interface ImprovementRecord {
  property_type: string;
  occ_description: string;
  sf: number | null;
  bsmnt_sf: number | null;
  bsmnt_fin_sf: number | null;
  gar_sf: number | null;
  condition: string;
  quality: string;
  room_count: number | null;
  bedroom_count: number | null;
  bath_count: number | null;
  year_built: number | null;
  adjusted_year_built: number | null;
  class_description: string;
}

export interface SaleRecord {
  schedule_num: string;
  account_no: string;
  sale_price: number;
  sale_date: string; // ISO-ish "YYYY-MM-DD"
  deed_code: string;
  deed_description: string;
  grantor: string;
  grantee: string;
}

/** A comp = a sale joined to the selling parcel's characteristics. */
export interface CompRecord extends SaleRecord {
  situs_address: string;
  subdivision_name: string;
  acct_type: string;
  sf: number | null;
  bedroom_count: number | null;
  bath_count: number | null;
  year_built: number | null;
  quality: string;
  condition: string;
  finished_basement_sf: number | null;
  price_per_sf: number | null;
}

// ── numeric coercion helpers (CSV values arrive as strings) ──────────────────

function num(v: string | undefined): number | null {
  if (v === undefined) return null;
  const t = v.trim();
  if (t === '') return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}
function int(v: string | undefined): number | null {
  const n = num(v);
  return n === null ? null : Math.round(n);
}
/** your county dates come as "YYYY-MM-DD HH:MM:SS"; keep the date part. */
function date_only(v: string | undefined): string {
  if (!v) return '';
  return v.trim().split(' ')[0] ?? '';
}

// Street-type full words → the county's abbreviations (its situs uses ST/CT/AVE…).
const STREET_TYPES: Record<string, string> = {
  STREET: 'ST', AVENUE: 'AVE', COURT: 'CT', DRIVE: 'DR', ROAD: 'RD',
  LANE: 'LN', BOULEVARD: 'BLVD', PLACE: 'PL', CIRCLE: 'CIR', TRAIL: 'TRL',
  TERRACE: 'TER', PARKWAY: 'PKWY', HIGHWAY: 'HWY', POINT: 'PT', COVE: 'CV',
  SQUARE: 'SQ', CROSSING: 'XING', WALK: 'WALK', BEND: 'BND', LOOP: 'LOOP',
};

/**
 * Normalize a human-typed address toward the county's stored situs form:
 * uppercase, strip punctuation, drop unit designators (UNIT/APT/#/STE — the
 * county appends the bare unit number, e.g. "820 SCHLAGEL ST 1"), and
 * abbreviate full street-type words ("STREET"→"ST", "COURT"→"CT").
 */
export function normalize_address(s: string): string {
  let t = ` ${s.toUpperCase().replace(/[.,#]/g, ' ')} `;
  t = t.replace(/\b(UNIT|APT|APARTMENT|STE|SUITE|NO|NUMBER)\b/g, ' ');
  t = t.replace(/\b([A-Z]+)\b/g, (w) => STREET_TYPES[w] ?? w);
  return t.replace(/\s+/g, ' ').trim();
}

// ── store ────────────────────────────────────────────────────────────────────

export class CountyAssessorStore {
  readonly db: Database;

  constructor(path: string = cache_db_path()) {
    this.db = new Database(path, { create: true });
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA synchronous = NORMAL;');
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS parcels (
        schedule_num        TEXT PRIMARY KEY,
        account_no          TEXT,
        parcel_no           TEXT,
        situs_address       TEXT,
        situs_city          TEXT,
        situs_zip           TEXT,
        subdivision_name    TEXT,
        sub_no              TEXT,
        acct_type           TEXT,
        land_gross_acres    REAL,
        land_gross_sf       REAL,
        total_mill_levy     REAL,
        tax_year            INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_parcels_addr ON parcels(situs_address);
      CREATE INDEX IF NOT EXISTS idx_parcels_sub  ON parcels(subdivision_name);
      CREATE INDEX IF NOT EXISTS idx_parcels_acct ON parcels(account_no);

      CREATE TABLE IF NOT EXISTS parcel_values (
        schedule_num   TEXT,
        value_type     TEXT,
        classification TEXT,
        actual_value   REAL,
        lg_asd_value   REAL,
        tax_year       INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_values_sched ON parcel_values(schedule_num);

      CREATE TABLE IF NOT EXISTS improvements (
        schedule_num        TEXT,
        imp_no              INTEGER,
        property_type       TEXT,
        occ_description     TEXT,
        sf                  REAL,
        bsmnt_sf            REAL,
        bsmnt_fin_sf        REAL,
        gar_sf              REAL,
        condition           TEXT,
        quality             TEXT,
        room_count          INTEGER,
        bedroom_count       INTEGER,
        bath_count          REAL,
        year_built          INTEGER,
        adjusted_year_built INTEGER,
        class_description   TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_imp_sched ON improvements(schedule_num);

      CREATE TABLE IF NOT EXISTS sales (
        schedule_num     TEXT,
        account_no       TEXT,
        sale_price       REAL,
        sale_date        TEXT,
        deed_code        TEXT,
        deed_description TEXT,
        grantor          TEXT,
        grantee          TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_sales_sched ON sales(schedule_num);
      CREATE INDEX IF NOT EXISTS idx_sales_date  ON sales(sale_date);

      CREATE TABLE IF NOT EXISTS owners (
        schedule_num TEXT PRIMARY KEY,
        name1        TEXT,
        name2        TEXT,
        mail_address TEXT,
        mail_city    TEXT,
        mail_state   TEXT,
        mail_zip     TEXT
      );

      CREATE TABLE IF NOT EXISTS sync_meta (
        table_name   TEXT PRIMARY KEY,
        row_count    INTEGER,
        synced_at    TEXT,
        etag         TEXT
      );
    `);
    // Forward-compat: add etag to a cache that predates conditional fetch.
    try { this.db.exec('ALTER TABLE sync_meta ADD COLUMN etag TEXT;'); } catch { /* column exists */ }
  }

  /** Drop + recreate a table's rows for a clean per-cycle rebuild. */
  truncate(table: 'parcels' | 'parcel_values' | 'improvements' | 'sales' | 'owners'): void {
    this.db.exec(`DELETE FROM ${table};`);
  }

  record_sync(table: string, row_count: number, etag: string | null = null): void {
    this.db
      .prepare(
        `INSERT INTO sync_meta (table_name, row_count, synced_at, etag)
         VALUES (@t, @c, @ts, @e)
         ON CONFLICT(table_name) DO UPDATE SET
           row_count=excluded.row_count, synced_at=excluded.synced_at, etag=excluded.etag`,
      )
      .run({ '@t': table, '@c': row_count, '@ts': new Date().toISOString(), '@e': etag });
  }

  /** The ETag stored from the last successful sync of a table, for conditional fetch. */
  get_etag(table: string): string | null {
    const r = this.db
      .prepare(`SELECT etag FROM sync_meta WHERE table_name=@t`)
      .get({ '@t': table }) as { etag: string | null } | undefined;
    return r?.etag ?? null;
  }

  sync_status(): { table: string; row_count: number; synced_at: string }[] {
    return this.db
      .prepare(`SELECT table_name AS "table", row_count, synced_at FROM sync_meta`)
      .all() as { table: string; row_count: number; synced_at: string }[];
  }

  // ── bulk ingest ────────────────────────────────────────────────────────────
  // Each ingest_* takes an array of header-keyed record objects (the streaming
  // parser yields these) and inserts them in one transaction. Callers batch.

  ingest_accounts(rows: Record<string, string>[]): number {
    const stmt = this.db.prepare(
      `INSERT OR REPLACE INTO parcels
        (schedule_num, account_no, parcel_no, situs_address, situs_city,
         situs_zip, subdivision_name, sub_no, acct_type, land_gross_acres,
         land_gross_sf, total_mill_levy, tax_year)
       VALUES (@sched,@acct,@parcel,@addr,@city,@zip,@sub,@subno,@atype,
               @acres,@sf,@mill,@ty)`,
    );
    const tx = this.db.transaction((rs: Record<string, string>[]) => {
      for (const r of rs) {
        stmt.run({
          '@sched': r.SCHEDULENUM ?? '',
          '@acct': r.ACCOUNTNO ?? '',
          '@parcel': r.PARCELNO ?? '',
          '@addr': (r.SITUSADDRESS ?? '').trim().toUpperCase(),
          '@city': r.SITUSCITY ?? '',
          '@zip': r.SITUSZIPCODE ?? '',
          '@sub': r.SUBDIVISIONNAME ?? '',
          '@subno': r.SUBNO ?? '',
          '@atype': r.ACCTTYPE ?? '',
          '@acres': num(r.LANDGROSSACRES),
          '@sf': num(r.LANDGROSSSF),
          '@mill': num(r.TOTALMILLLEVY),
          '@ty': int(r.TAXYEAR),
        });
      }
    });
    tx(rows);
    return rows.length;
  }

  ingest_values(rows: Record<string, string>[]): number {
    const stmt = this.db.prepare(
      `INSERT INTO parcel_values
        (schedule_num, value_type, classification, actual_value, lg_asd_value, tax_year)
       VALUES (@sched,@vtype,@class,@actual,@asd,@ty)`,
    );
    const tx = this.db.transaction((rs: Record<string, string>[]) => {
      for (const r of rs) {
        stmt.run({
          '@sched': r.SCHEDULENUM ?? '',
          '@vtype': r.VALUETYPE ?? '',
          '@class': r.CLASSIFICATIONDESCRIPTION ?? '',
          '@actual': num(r.ACTUALVALUE),
          '@asd': num(r.LG_ASDVALUE),
          '@ty': int(r.TAXYEAR),
        });
      }
    });
    tx(rows);
    return rows.length;
  }

  ingest_improvements(rows: Record<string, string>[]): number {
    const stmt = this.db.prepare(
      `INSERT INTO improvements
        (schedule_num, imp_no, property_type, occ_description, sf, bsmnt_sf,
         bsmnt_fin_sf, gar_sf, condition, quality, room_count, bedroom_count,
         bath_count, year_built, adjusted_year_built, class_description)
       VALUES (@sched,@impno,@ptype,@occ,@sf,@bsf,@bfsf,@gsf,@cond,@qual,
               @rooms,@beds,@baths,@yb,@ayb,@class)`,
    );
    const tx = this.db.transaction((rs: Record<string, string>[]) => {
      for (const r of rs) {
        stmt.run({
          '@sched': r.SCHEDULENUM ?? '',
          '@impno': int(r.IMPNO),
          '@ptype': r.PROPERTYTYPE ?? '',
          '@occ': r.OCCDESCRIPTION ?? '',
          '@sf': num(r.SF),
          '@bsf': num(r.BSMNTSF),
          '@bfsf': num(r.BSMNTFINSF),
          '@gsf': num(r.GARSF),
          '@cond': r.IMPCONDITIONTYPE ?? '',
          '@qual': r.IMPQUALITY ?? '',
          '@rooms': int(r.ROOMCOUNT),
          '@beds': int(r.BEDROOMCOUNT),
          '@baths': num(r.BATHCOUNT),
          '@yb': int(r.BLTASYEARBUILT),
          '@ayb': int(r.ADJUSTEDYEARBUILT),
          '@class': r.CLASSDESCRIPTION ?? '',
        });
      }
    });
    tx(rows);
    return rows.length;
  }

  ingest_sales(rows: Record<string, string>[]): number {
    const stmt = this.db.prepare(
      `INSERT INTO sales
        (schedule_num, account_no, sale_price, sale_date, deed_code,
         deed_description, grantor, grantee)
       VALUES (@sched,@acct,@price,@date,@dcode,@ddesc,@gr,@ge)`,
    );
    const tx = this.db.transaction((rs: Record<string, string>[]) => {
      for (const r of rs) {
        stmt.run({
          '@sched': r.SCHEDULENUM ?? '',
          '@acct': r.ACCOUNTNO ?? '',
          '@price': num(r.SALEPRICE) ?? 0,
          '@date': date_only(r.SALEDATE),
          '@dcode': r.DEEDCODE ?? '',
          '@ddesc': r.DEEDDESCRIPTION ?? '',
          '@gr': r.GRANTOR ?? '',
          '@ge': r.GRANTEE ?? '',
        });
      }
    });
    tx(rows);
    return rows.length;
  }

  ingest_owners(rows: Record<string, string>[]): number {
    const stmt = this.db.prepare(
      `INSERT OR REPLACE INTO owners
        (schedule_num, name1, name2, mail_address, mail_city, mail_state, mail_zip)
       VALUES (@sched,@n1,@n2,@addr,@city,@state,@zip)`,
    );
    const tx = this.db.transaction((rs: Record<string, string>[]) => {
      for (const r of rs) {
        // The county puts the street line in MAILADDRESS2 (MAILADDRESS1 is
        // often a name-cont / blank); prefer whichever is non-empty.
        const addr = (r.MAILADDRESS2 ?? '').trim() || (r.MAILADDRESS1 ?? '').trim();
        stmt.run({
          '@sched': r.SCHEDULENUM ?? '',
          '@n1': (r.NAME1 ?? '').trim(),
          '@n2': (r.NAME2 ?? '').trim(),
          '@addr': addr.toUpperCase(),
          '@city': (r.MAILCITY ?? '').trim().toUpperCase(),
          '@state': (r.MAILSTATE ?? '').trim().toUpperCase(),
          '@zip': (r.MAILZIPCODE ?? '').trim(),
        });
      }
    });
    tx(rows);
    return rows.length;
  }

  // ── queries ──────────────────────────────────────────────────────────────

  /** The primary residential improvement for a parcel = the largest by SF. */
  private primary_improvement(schedule_num: string): ImprovementRecord | null {
    const r = this.db
      .prepare(
        `SELECT * FROM improvements WHERE schedule_num=@s ORDER BY sf DESC NULLS LAST LIMIT 1`,
      )
      .get({ '@s': schedule_num }) as Record<string, unknown> | undefined;
    if (!r) return null;
    return {
      property_type: (r.property_type as string) ?? '',
      occ_description: (r.occ_description as string) ?? '',
      sf: (r.sf as number) ?? null,
      bsmnt_sf: (r.bsmnt_sf as number) ?? null,
      bsmnt_fin_sf: (r.bsmnt_fin_sf as number) ?? null,
      gar_sf: (r.gar_sf as number) ?? null,
      condition: (r.condition as string) ?? '',
      quality: (r.quality as string) ?? '',
      room_count: (r.room_count as number) ?? null,
      bedroom_count: (r.bedroom_count as number) ?? null,
      bath_count: (r.bath_count as number) ?? null,
      year_built: (r.year_built as number) ?? null,
      adjusted_year_built: (r.adjusted_year_built as number) ?? null,
      class_description: (r.class_description as string) ?? '',
    };
  }

  private values_for(schedule_num: string): {
    total: number | null;
    land: number | null;
    improvement: number | null;
  } {
    const rows = this.db
      .prepare(
        `SELECT value_type, SUM(actual_value) AS av FROM parcel_values
          WHERE schedule_num=@s GROUP BY value_type`,
      )
      .all({ '@s': schedule_num }) as { value_type: string; av: number }[];
    let land: number | null = null;
    let imp: number | null = null;
    let total = 0;
    let any = false;
    for (const row of rows) {
      const v = row.av ?? 0;
      total += v;
      any = true;
      if (/land/i.test(row.value_type)) land = (land ?? 0) + v;
      else if (/improv/i.test(row.value_type)) imp = (imp ?? 0) + v;
    }
    return { total: any ? total : null, land, improvement: imp };
  }

  private recent_sales(schedule_num: string, limit = 5): SaleRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM sales WHERE schedule_num=@s ORDER BY sale_date DESC LIMIT @lim`,
      )
      .all({ '@s': schedule_num, '@lim': limit }) as Record<string, unknown>[];
    return rows.map((r) => ({
      schedule_num: (r.schedule_num as string) ?? '',
      account_no: (r.account_no as string) ?? '',
      sale_price: (r.sale_price as number) ?? 0,
      sale_date: (r.sale_date as string) ?? '',
      deed_code: (r.deed_code as string) ?? '',
      deed_description: (r.deed_description as string) ?? '',
      grantor: (r.grantor as string) ?? '',
      grantee: (r.grantee as string) ?? '',
    }));
  }

  /** Owner name + an owner-occupancy heuristic (mailing street matches situs). */
  private owner_for(
    schedule_num: string,
    situs_address: string,
    situs_city: string,
  ): { name: string | null; occupied: boolean | null } {
    const o = this.db
      .prepare(`SELECT name1, name2, mail_address, mail_city FROM owners WHERE schedule_num=@s`)
      .get({ '@s': schedule_num }) as
      | { name1: string; name2: string; mail_address: string; mail_city: string }
      | undefined;
    if (!o) return { name: null, occupied: null };
    const name = [o.name1, o.name2].filter(Boolean).join(' & ') || null;
    // Loose match: same street number + first street word, same city. Handles
    // "820 SCHLAGEL ST UNIT 1" (mail) vs "820 SCHLAGEL ST 1" (situs).
    const key = (s: string) => (s || '').toUpperCase().split(/\s+/).slice(0, 2).join(' ');
    const occupied =
      !!o.mail_address &&
      key(o.mail_address) === key(situs_address) &&
      (o.mail_city || '').toUpperCase() === (situs_city || '').toUpperCase();
    return { name, occupied };
  }

  private hydrate_parcel(row: Record<string, unknown>): ParcelRecord {
    const sched = (row.schedule_num as string) ?? '';
    const vals = this.values_for(sched);
    const owner = this.owner_for(
      sched,
      (row.situs_address as string) ?? '',
      (row.situs_city as string) ?? '',
    );
    return {
      schedule_num: sched,
      account_no: (row.account_no as string) ?? '',
      parcel_no: (row.parcel_no as string) ?? '',
      situs_address: (row.situs_address as string) ?? '',
      situs_city: (row.situs_city as string) ?? '',
      situs_zip: (row.situs_zip as string) ?? '',
      subdivision_name: (row.subdivision_name as string) ?? '',
      sub_no: (row.sub_no as string) ?? '',
      acct_type: (row.acct_type as string) ?? '',
      land_gross_acres: (row.land_gross_acres as number) ?? null,
      land_gross_sf: (row.land_gross_sf as number) ?? null,
      total_mill_levy: (row.total_mill_levy as number) ?? null,
      tax_year: (row.tax_year as number) ?? null,
      actual_value_total: vals.total,
      actual_value_land: vals.land,
      actual_value_improvement: vals.improvement,
      improvement: this.primary_improvement(sched),
      recent_sales: this.recent_sales(sched),
      owner_name: owner.name,
      owner_occupied: owner.occupied,
    };
  }

  get_by_account(account_no: string): ParcelRecord | null {
    const row = this.db
      .prepare(`SELECT * FROM parcels WHERE account_no=@a OR schedule_num=@a LIMIT 1`)
      .get({ '@a': account_no.trim() }) as Record<string, unknown> | undefined;
    return row ? this.hydrate_parcel(row) : null;
  }

  /**
   * Address match, tolerant of human input ("820 Maplewood Street Unit 1" →
   * the county's "820 SCHLAGEL ST 1"). Tries, in order: exact on the
   * normalized form; normalized prefix (a street with no unit returns all
   * its units); then a loose "<number> <first street word>" prefix so a
   * wrong street-type or missing unit still finds the parcel.
   */
  find_by_address(address: string, limit = 10): ParcelRecord[] {
    const norm = normalize_address(address);
    const run = (sql: string, a: string): Record<string, unknown>[] =>
      this.db.prepare(sql).all({ '@a': a, '@lim': limit }) as Record<string, unknown>[];

    let rows = run(`SELECT * FROM parcels WHERE situs_address=@a LIMIT @lim`, norm);
    if (rows.length === 0) {
      rows = run(`SELECT * FROM parcels WHERE situs_address LIKE @a ORDER BY situs_address LIMIT @lim`, `${norm}%`);
    }
    if (rows.length === 0) {
      // Loose: street number + first name word (drops type/unit mismatches).
      const m = norm.match(/^(\d+)\s+([A-Z0-9]+)/);
      if (m) {
        rows = run(
          `SELECT * FROM parcels WHERE situs_address LIKE @a ORDER BY situs_address LIMIT @lim`,
          `${m[1]} ${m[2]}%`,
        );
      }
    }
    return rows.map((r) => this.hydrate_parcel(r));
  }

  /**
   * Comparable sales for a subject parcel: arms-length sales in the date
   * window, within the same subdivision, of like-kind residential parcels,
   * joined to the selling parcel's characteristics. Ranked by SF proximity
   * then year-built proximity to the subject.
   */
  find_comps(opts: {
    subject: ParcelRecord;
    window_start: string; // ISO date inclusive
    window_end: string; // ISO date inclusive
    limit?: number;
    min_price?: number;
  }): CompRecord[] {
    const subj = opts.subject;
    const limit = opts.limit ?? 8;
    const min_price = opts.min_price ?? 1000; // exclude $0 / nominal transfers
    const subj_sf = subj.improvement?.sf ?? null;
    const subj_year = subj.improvement?.year_built ?? null;

    // Arms-length deed types — warranty / special warranty. Exclude
    // quitclaim, administrator, treasurer, correction, etc.
    const rows = this.db
      .prepare(
        `SELECT s.schedule_num, s.account_no, s.sale_price, s.sale_date,
                s.deed_code, s.deed_description, s.grantor, s.grantee,
                p.situs_address, p.subdivision_name, p.acct_type
           FROM sales s
           JOIN parcels p ON p.schedule_num = s.schedule_num
          WHERE p.subdivision_name = @sub
            AND p.subdivision_name <> ''
            AND s.schedule_num <> @self
            AND s.sale_price >= @minp
            AND s.sale_date >= @ws
            AND s.sale_date <= @we
            AND (s.deed_description LIKE '%Warranty%')
            AND p.acct_type = @atype
          ORDER BY s.sale_date DESC`,
      )
      .all({
        '@sub': subj.subdivision_name,
        '@self': subj.schedule_num,
        '@minp': min_price,
        '@ws': opts.window_start,
        '@we': opts.window_end,
        '@atype': subj.acct_type,
      }) as Record<string, unknown>[];

    const comps: CompRecord[] = rows.map((r) => {
      const sched = (r.schedule_num as string) ?? '';
      const imp = this.primary_improvement(sched);
      const price = (r.sale_price as number) ?? 0;
      const sf = imp?.sf ?? null;
      return {
        schedule_num: sched,
        account_no: (r.account_no as string) ?? '',
        sale_price: price,
        sale_date: (r.sale_date as string) ?? '',
        deed_code: (r.deed_code as string) ?? '',
        deed_description: (r.deed_description as string) ?? '',
        grantor: (r.grantor as string) ?? '',
        grantee: (r.grantee as string) ?? '',
        situs_address: (r.situs_address as string) ?? '',
        subdivision_name: (r.subdivision_name as string) ?? '',
        acct_type: (r.acct_type as string) ?? '',
        sf,
        bedroom_count: imp?.bedroom_count ?? null,
        bath_count: imp?.bath_count ?? null,
        year_built: imp?.year_built ?? null,
        quality: imp?.quality ?? '',
        condition: imp?.condition ?? '',
        finished_basement_sf: imp?.bsmnt_fin_sf ?? null,
        price_per_sf: sf && sf > 0 ? Math.round((price / sf) * 100) / 100 : null,
      };
    });

    // Outlier filter: keep only comps with a usable $/sqft, then drop ones
    // whose $/sqft is wildly off the set median (non-arms-length transfers
    // that still carry a "warranty" deed — builder bulk sales, family
    // transfers — e.g. a $1.8M deed on a $480k home). Needs >=4 to bother.
    const withPsf = comps.filter((c) => c.price_per_sf && c.price_per_sf > 0);
    let kept = withPsf;
    if (withPsf.length >= 4) {
      const sorted = withPsf.map((c) => c.price_per_sf!).sort((a, b) => a - b);
      const med = sorted[Math.floor(sorted.length / 2)]!;
      kept = withPsf.filter((c) => c.price_per_sf! >= 0.4 * med && c.price_per_sf! <= 2.2 * med);
    }
    comps.length = 0;
    comps.push(...kept);

    // Rank by similarity to the subject (SF first, then year built).
    comps.sort((a, b) => {
      const sfa = subj_sf && a.sf ? Math.abs(a.sf - subj_sf) : Number.MAX_SAFE_INTEGER;
      const sfb = subj_sf && b.sf ? Math.abs(b.sf - subj_sf) : Number.MAX_SAFE_INTEGER;
      if (sfa !== sfb) return sfa - sfb;
      const ya = subj_year && a.year_built ? Math.abs(a.year_built - subj_year) : 9999;
      const yb = subj_year && b.year_built ? Math.abs(b.year_built - subj_year) : 9999;
      return ya - yb;
    });

    return comps.slice(0, limit);
  }
}

// Module-level singleton so every Anna tool shares one connection.
let _store: CountyAssessorStore | null = null;
export function getCountyAssessorStore(): CountyAssessorStore {
  if (!_store) _store = new CountyAssessorStore();
  return _store;
}
