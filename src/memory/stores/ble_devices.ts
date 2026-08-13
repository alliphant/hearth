/**
 * BleDevicesStore — the device→person binding for the BLE room-presence layer
 * (Household Awareness Layer P3; design-ble-room-presence.md §5). The "grouping
 * into face/body identity": a row FKs a BLE device (the iPhone/Watch/tag, resolved
 * in Home Assistant) to an `enrolled_persons.id`, so BLE resolves to the SAME
 * person the face (CPAI) + body re-ID (P2) do.
 *
 * The IRK SECRET never lives here — it stays in HA's Private BLE Device integration.
 * This store holds only the resolved HA *entity* refs (the Bermuda area sensor +
 * the device_tracker) + a NON-secret IRK fingerprint for dedup/debug.
 *
 * Self-contained (CREATE TABLE IF NOT EXISTS in the ctor, like codeshop_settings /
 * presence_zones / home_map). Owner-scoped; never enters the cordon/RAG/search.
 */
import { Database } from 'bun:sqlite';
import { ulid } from 'ulid';

export type BleDeviceKind = 'phone' | 'watch' | 'tag';
export type BleReliability = 'primary' | 'best_effort';

export interface BleDeviceInput {
  user_id: string;
  enrolled_person_id: string;
  kind: BleDeviceKind;
  label?: string | null;
  /** The Bermuda per-device Area sensor entity_id (state = HA Area name). Read
   *  from HA Developer Tools after setup — the slug is partly user-determined. */
  ha_area_entity: string;
  /** The Private BLE Device device_tracker (home/away + distance), optional. */
  ha_tracker_entity?: string | null;
  /** A non-secret hash of the IRK (dedup/debug) — NEVER the IRK itself. */
  irk_fingerprint?: string | null;
  reliability?: BleReliability;
}

export interface BleDeviceRow {
  id: string;
  user_id: string;
  enrolled_person_id: string;
  kind: BleDeviceKind;
  label: string | null;
  ha_area_entity: string;
  ha_tracker_entity: string | null;
  irk_fingerprint: string | null;
  reliability: BleReliability;
  ts_created: string;
  ts_updated: string;
}

export class BleDevicesStore {
  constructor(private db: Database) {
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS ble_devices (
         id TEXT PRIMARY KEY,
         user_id TEXT NOT NULL,
         enrolled_person_id TEXT NOT NULL,
         kind TEXT NOT NULL CHECK (kind IN ('phone','watch','tag')),
         label TEXT,
         ha_area_entity TEXT NOT NULL,
         ha_tracker_entity TEXT,
         irk_fingerprint TEXT,
         reliability TEXT NOT NULL DEFAULT 'primary'
           CHECK (reliability IN ('primary','best_effort')),
         ts_created TEXT NOT NULL,
         ts_updated TEXT NOT NULL,
         UNIQUE (user_id, ha_area_entity)
       )`,
    );
    this.db.exec(
      `CREATE INDEX IF NOT EXISTS idx_ble_devices_person
         ON ble_devices (user_id, enrolled_person_id)`,
    );
  }

  /** Insert-or-update a device, idempotent on (user_id, ha_area_entity). */
  upsert(input: BleDeviceInput): string {
    const now = new Date().toISOString();
    const existing = this.db
      .prepare(`SELECT id FROM ble_devices WHERE user_id = @u AND ha_area_entity = @e`)
      .get({ '@u': input.user_id, '@e': input.ha_area_entity }) as { id: string } | undefined;
    const id = existing?.id ?? `bd_${ulid().toLowerCase().slice(-12)}`;
    this.db
      .prepare(
        `INSERT INTO ble_devices
           (id, user_id, enrolled_person_id, kind, label, ha_area_entity,
            ha_tracker_entity, irk_fingerprint, reliability, ts_created, ts_updated)
         VALUES (@id, @u, @p, @k, @l, @e, @t, @f, @r, @now, @now)
         ON CONFLICT(user_id, ha_area_entity) DO UPDATE SET
           enrolled_person_id = excluded.enrolled_person_id,
           kind = excluded.kind,
           label = COALESCE(excluded.label, ble_devices.label),
           ha_tracker_entity = COALESCE(excluded.ha_tracker_entity, ble_devices.ha_tracker_entity),
           irk_fingerprint = COALESCE(excluded.irk_fingerprint, ble_devices.irk_fingerprint),
           reliability = excluded.reliability,
           ts_updated = excluded.ts_updated`,
      )
      .run({
        '@id': id,
        '@u': input.user_id,
        '@p': input.enrolled_person_id,
        '@k': input.kind,
        '@l': input.label ?? null,
        '@e': input.ha_area_entity,
        '@t': input.ha_tracker_entity ?? null,
        '@f': input.irk_fingerprint ?? null,
        '@r': input.reliability ?? 'primary',
        '@now': now,
      });
    return id;
  }

  list(user_id: string): BleDeviceRow[] {
    return this.db
      .prepare(`SELECT * FROM ble_devices WHERE user_id = @u ORDER BY ts_updated DESC`)
      .all({ '@u': user_id }) as BleDeviceRow[];
  }

  list_for_person(user_id: string, enrolled_person_id: string): BleDeviceRow[] {
    return this.db
      .prepare(`SELECT * FROM ble_devices WHERE user_id = @u AND enrolled_person_id = @p`)
      .all({ '@u': user_id, '@p': enrolled_person_id }) as BleDeviceRow[];
  }

  delete(user_id: string, id: string): void {
    this.db.prepare(`DELETE FROM ble_devices WHERE user_id = @u AND id = @id`).run({ '@u': user_id, '@id': id });
  }
}
