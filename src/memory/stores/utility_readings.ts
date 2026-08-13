/**
 * UtilityReadingsStore — Anna's energy/water time series, parsed from uploaded
 * utility bills by intake_utility_bill (Cordelia → Anna). Lives in the shared
 * hearth.db (NOT a separate file) on purpose: Anna analyses usage + benchmarks
 * the household, Vivian reads the cost trend. Idempotent on (user_id, dedup_key)
 * so re-uploading the same bill upserts in place.
 */
import { ulid } from 'ulid';
import type { Database } from 'bun:sqlite';

export interface UtilityReadingRow {
  id: string;
  user_id: string;
  utility_provider: string | null;
  service: string | null;
  period_start: string | null;
  period_end: string | null;
  electric_kwh: number | null;
  gas_therms: number | null;
  water_gallons: number | null;
  electric_cost: number | null;
  gas_cost: number | null;
  water_cost: number | null;
  total_cost: number | null;
  currency: string;
  account_number: string | null;
  source_capture_id: string | null;
  source_note_path: string | null;
  extractor_confidence: number | null;
  dedup_key: string;
  ts_created: string;
}

export interface UtilityReadingInput {
  user_id: string;
  utility_provider?: string | null;
  service?: string | null;
  period_start?: string | null;
  period_end?: string | null;
  electric_kwh?: number | null;
  gas_therms?: number | null;
  water_gallons?: number | null;
  electric_cost?: number | null;
  gas_cost?: number | null;
  water_cost?: number | null;
  total_cost?: number | null;
  currency?: string;
  account_number?: string | null;
  source_capture_id?: string | null;
  source_note_path?: string | null;
  extractor_confidence?: number | null;
  dedup_key: string;
}

export class UtilityReadingsStore {
  constructor(private db: Database) {}

  upsert(input: UtilityReadingInput): UtilityReadingRow {
    const existing = this.db
      .prepare(`SELECT id, ts_created FROM utility_readings WHERE user_id=@u AND dedup_key=@dk`)
      .get({ '@u': input.user_id, '@dk': input.dedup_key }) as
      | { id: string; ts_created: string }
      | undefined;
    const id = existing?.id ?? `util_${ulid().toLowerCase().slice(-12)}`;
    const ts_created = existing?.ts_created ?? new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO utility_readings
          (id, user_id, utility_provider, service, period_start, period_end,
           electric_kwh, gas_therms, water_gallons, electric_cost, gas_cost,
           water_cost, total_cost, currency, account_number, source_capture_id,
           source_note_path, extractor_confidence, dedup_key, ts_created)
         VALUES (@id,@u,@prov,@svc,@ps,@pe,@ek,@gt,@wg,@ec,@gc,@wc,@tot,@cur,
                 @acct,@cap,@note,@conf,@dk,@tc)
         ON CONFLICT(user_id, dedup_key) DO UPDATE SET
           utility_provider=excluded.utility_provider, service=excluded.service,
           period_start=excluded.period_start, period_end=excluded.period_end,
           electric_kwh=excluded.electric_kwh, gas_therms=excluded.gas_therms,
           water_gallons=excluded.water_gallons, electric_cost=excluded.electric_cost,
           gas_cost=excluded.gas_cost, water_cost=excluded.water_cost,
           total_cost=excluded.total_cost, currency=excluded.currency,
           account_number=excluded.account_number,
           source_capture_id=excluded.source_capture_id,
           source_note_path=excluded.source_note_path,
           extractor_confidence=excluded.extractor_confidence`,
      )
      .run({
        '@id': id, '@u': input.user_id, '@prov': input.utility_provider ?? null,
        '@svc': input.service ?? null, '@ps': input.period_start ?? null,
        '@pe': input.period_end ?? null, '@ek': input.electric_kwh ?? null,
        '@gt': input.gas_therms ?? null, '@wg': input.water_gallons ?? null,
        '@ec': input.electric_cost ?? null, '@gc': input.gas_cost ?? null,
        '@wc': input.water_cost ?? null, '@tot': input.total_cost ?? null,
        '@cur': input.currency ?? 'USD', '@acct': input.account_number ?? null,
        '@cap': input.source_capture_id ?? null, '@note': input.source_note_path ?? null,
        '@conf': input.extractor_confidence ?? null, '@dk': input.dedup_key, '@tc': ts_created,
      });
    return this.get(id)!;
  }

  get(id: string): UtilityReadingRow | null {
    return (this.db.prepare(`SELECT * FROM utility_readings WHERE id=@id`).get({ '@id': id }) as
      | UtilityReadingRow
      | undefined) ?? null;
  }

  /** Most recent readings for a user, newest service-period first. */
  list_for_user(user_id: string, limit = 36): UtilityReadingRow[] {
    return this.db
      .prepare(
        `SELECT * FROM utility_readings WHERE user_id=@u
          ORDER BY COALESCE(period_end, ts_created) DESC LIMIT @lim`,
      )
      .all({ '@u': user_id, '@lim': limit }) as UtilityReadingRow[];
  }
}
