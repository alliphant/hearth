/**
 * WifiDevicesStore — the device→MEMBER binding for the WiFi-association presence
 * signal (Household Awareness; sibling of ble_devices.ts). Binds a household
 * member to a WiFi client (an iPhone / Apple Watch / laptop), so "this MAC is
 * associated to the home APs right now" resolves to "<member> is home."
 *
 * Identity is by MAC (precise — a per-SSID Private Wi-Fi Address is stable per
 * network, captured once) AND/OR a hostname substring (zero-capture fallback —
 * UniFi usually reports "Jasper's iPhone"). The WiFi-presence resolver matches a
 * device when EITHER hits.
 *
 * Maps to a household MEMBER `user_id` (presence is per-member), NOT an
 * enrolled_persons row — presence feeds resolve_household_locations, which is
 * member-keyed. (The face/body fusion is person-keyed; the two link by name.)
 *
 * Self-contained (CREATE TABLE IF NOT EXISTS in the ctor, like ble_devices /
 * home_map). Owner-scoped; never enters the cordon/RAG/search.
 */
import { Database } from 'bun:sqlite';
import { ulid } from 'ulid';

export type WifiDeviceKind = 'phone' | 'watch' | 'laptop' | 'tablet' | 'tag';
export type WifiReliability = 'primary' | 'best_effort';

export interface WifiDeviceInput {
  /** Owner scope (the household's data). */
  user_id: string;
  /** Which household member this device belongs to. */
  member_user_id: string;
  kind: WifiDeviceKind;
  label?: string | null;
  /** Lowercased MAC — the precise identity (the home-network Private Wi-Fi
   *  Address for an iPhone). Optional when matching by hostname only. */
  mac?: string | null;
  /** Lowercased substring matched against the client hostname (e.g. "iphone",
   *  "jasper" → matches "Jasons-iPhone"). The zero-capture fallback. */
  hostname_match?: string | null;
  /** phone = primary signal; watch = jumpy (WiFi radio usually off on BT). */
  reliability?: WifiReliability;
}

export interface WifiDeviceRow {
  id: string;
  user_id: string;
  member_user_id: string;
  kind: WifiDeviceKind;
  label: string | null;
  mac: string | null;
  hostname_match: string | null;
  reliability: WifiReliability;
  ts_created: string;
  ts_updated: string;
}

export class WifiDevicesStore {
  constructor(private db: Database) {
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS wifi_devices (
         id TEXT PRIMARY KEY,
         user_id TEXT NOT NULL,
         member_user_id TEXT NOT NULL,
         kind TEXT NOT NULL CHECK (kind IN ('phone','watch','laptop','tablet','tag')),
         label TEXT,
         mac TEXT,
         hostname_match TEXT,
         reliability TEXT NOT NULL DEFAULT 'primary'
           CHECK (reliability IN ('primary','best_effort')),
         ts_created TEXT NOT NULL,
         ts_updated TEXT NOT NULL,
         UNIQUE (user_id, member_user_id, kind)
       )`,
    );
    this.db.exec(
      `CREATE INDEX IF NOT EXISTS idx_wifi_devices_user ON wifi_devices (user_id)`,
    );
  }

  /** Insert-or-update, idempotent on (user_id, member_user_id, kind) — one phone
   *  + one watch per member. MAC is lowercased. */
  upsert(input: WifiDeviceInput): string {
    const now = new Date().toISOString();
    const existing = this.db
      .prepare(`SELECT id FROM wifi_devices WHERE user_id = @u AND member_user_id = @m AND kind = @k`)
      .get({ '@u': input.user_id, '@m': input.member_user_id, '@k': input.kind }) as { id: string } | undefined;
    const id = existing?.id ?? `wd_${ulid().toLowerCase().slice(-12)}`;
    this.db
      .prepare(
        `INSERT INTO wifi_devices
           (id, user_id, member_user_id, kind, label, mac, hostname_match, reliability, ts_created, ts_updated)
         VALUES (@id, @u, @m, @k, @l, @mac, @hn, @r, @now, @now)
         ON CONFLICT(user_id, member_user_id, kind) DO UPDATE SET
           label = COALESCE(excluded.label, wifi_devices.label),
           mac = COALESCE(excluded.mac, wifi_devices.mac),
           hostname_match = COALESCE(excluded.hostname_match, wifi_devices.hostname_match),
           reliability = excluded.reliability,
           ts_updated = excluded.ts_updated`,
      )
      .run({
        '@id': id,
        '@u': input.user_id,
        '@m': input.member_user_id,
        '@k': input.kind,
        '@l': input.label ?? null,
        '@mac': input.mac ? input.mac.toLowerCase() : null,
        '@hn': input.hostname_match ? input.hostname_match.toLowerCase() : null,
        '@r': input.reliability ?? 'primary',
        '@now': now,
      });
    return id;
  }

  list(user_id: string): WifiDeviceRow[] {
    return this.db
      .prepare(`SELECT * FROM wifi_devices WHERE user_id = @u ORDER BY ts_updated DESC`)
      .all({ '@u': user_id }) as WifiDeviceRow[];
  }

  delete(user_id: string, id: string): void {
    this.db.prepare(`DELETE FROM wifi_devices WHERE user_id = @u AND id = @id`).run({ '@u': user_id, '@id': id });
  }
}
