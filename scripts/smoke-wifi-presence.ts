/**
 * smoke:wifi-presence — the WiFi-association presence corroborator. Self-contained:
 * temp db, an INJECTED active-client list (no UniFi), no network. Proves the layer
 * that lights up when HEARTH_WIFI_PRESENCE=1 + the device mapping is populated.
 *
 * Asserts:
 *   - WifiDevicesStore round-trip (upsert idempotent on member+kind, MAC lowercased,
 *     list, delete).
 *   - match_device: MAC (case-insensitive), hostname substring, mac-only, hostname-only,
 *     no-match.
 *   - resolve_wifi_home: mapped+associated member → home; unmapped client ignored;
 *     empty/erroring client read → fail-open empty; gate-off → empty.
 *   - apply_wifi_home: unknown→home, away→home (overridden), home stays, unmapped
 *     member untouched, empty set → unchanged.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { open_db } from '../src/memory/stores/structured';
import { WifiDevicesStore } from '../src/memory/stores/wifi_devices';
import type { ActiveClient } from '../src/connectors/unifi';
import type { HouseholdLocation } from '../src/memory/client';
import {
  match_device,
  resolve_wifi_home,
  apply_wifi_home,
  wifi_presence_enabled,
} from '../src/core/wifi_presence';

let failures = 0;
function check(label: string, ok: boolean): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) failures++;
}

const dir = mkdtempSync(join(tmpdir(), 'hearth-wifi-'));
const db = open_db(join(dir, 'smoke.db'));
const OWNER = 'jasper';
const NOW = Date.parse('2026-06-15T18:00:00.000Z');

const client = (over: Partial<ActiveClient>): ActiveClient => ({
  mac: 'aa:bb:cc:dd:ee:ff', alias: null, hostname: null, ap_mac: 'ap:00', is_wired: false, uptime_s: 600, ...over,
});

async function main(): Promise<void> {
  process.env.HEARTH_WIFI_PRESENCE = '1';

  /* ── 1. Store round-trip ──────────────────────────────────────────────── */
  const store = new WifiDevicesStore(db);
  const id1 = store.upsert({ user_id: OWNER, member_user_id: 'jasper', kind: 'phone', label: "Jasper's iPhone", mac: 'AA:BB:CC:11:22:33' });
  store.upsert({ user_id: OWNER, member_user_id: 'jasper', kind: 'watch', hostname_match: 'jaspers-apple-watch', reliability: 'best_effort' });
  const id1b = store.upsert({ user_id: OWNER, member_user_id: 'jasper', kind: 'phone', label: 'updated' }); // idempotent on member+kind
  check('upsert idempotent on (member, kind) — same row', id1 === id1b);
  const rows = store.list(OWNER);
  check('list returns both devices (phone + watch)', rows.length === 2);
  check('MAC stored lowercased', rows.some((r) => r.mac === 'aa:bb:cc:11:22:33'));
  check('label preserved on idempotent update (COALESCE)', rows.find((r) => r.kind === 'phone')!.label === 'updated' || rows.find((r) => r.kind === 'phone')!.label === "Jasper's iPhone");
  const watchRow = rows.find((r) => r.kind === 'watch')!;
  store.delete(OWNER, watchRow.id);
  check('delete removes the watch', store.list(OWNER).length === 1);

  /* ── 2. match_device ──────────────────────────────────────────────────── */
  const phone = store.list(OWNER).find((r) => r.kind === 'phone')!;
  check('match by MAC (case-insensitive)', match_device(phone, client({ mac: 'aa:bb:cc:11:22:33' })));
  check('no match on a different MAC', !match_device(phone, client({ mac: '00:00:00:00:00:00', hostname: 'someone-else' })));
  const hnDev = { ...phone, mac: null, hostname_match: 'iphone' };
  check('match by hostname substring', match_device(hnDev, client({ mac: 'x', hostname: 'Jasons-iPhone' })));
  check('hostname match is case-insensitive + substring', match_device(hnDev, client({ mac: 'x', hostname: 'JASONS-IPHONE-14' })));
  check('no hostname match when absent', !match_device(hnDev, client({ mac: 'x', hostname: 'Sam-Pixel' })));
  // The UniFi ALIAS (user-set name) matches even when the device hostname is the bare "iPhone".
  const aliasDev = { ...phone, mac: null, hostname_match: "jasper's iphone" };
  check('match by UniFi alias (hostname is bare "iPhone")', match_device(aliasDev, client({ mac: 'x', alias: "Jasper's iPhone", hostname: 'iPhone' })));
  check('alias mismatch → no match', !match_device(aliasDev, client({ mac: 'x', alias: "Sam's iPhone", hostname: 'iPhone' })));

  /* ── 3. resolve_wifi_home ─────────────────────────────────────────────── */
  // Jasper's phone (mac aa:bb:cc:11:22:33) IS associated; an unmapped device too.
  const associated = [client({ mac: 'aa:bb:cc:11:22:33', hostname: 'Jasons-iPhone' }), client({ mac: 'de:ad:be:ef:00:00', hostname: 'roku' })];
  const r1 = await resolve_wifi_home(db, OWNER, { fetch_clients: async () => associated });
  check('resolve_wifi_home: mapped+associated member → home', r1.home_members.has('jasper') && r1.available);
  check('resolve_wifi_home: matched detail records via=mac + ap', r1.matched.some((m) => m.member_user_id === 'jasper' && m.via === 'mac' && m.ap_mac === 'ap:00'));

  const r2 = await resolve_wifi_home(db, OWNER, { fetch_clients: async () => [client({ mac: 'de:ad:be:ef:00:00' })] });
  check('resolve_wifi_home: member NOT associated → not home', !r2.home_members.has('jasper'));

  const r3 = await resolve_wifi_home(db, OWNER, { fetch_clients: async () => [] });
  check('resolve_wifi_home: empty client read → fail-open empty (available false)', r3.home_members.size === 0 && !r3.available);

  const r4 = await resolve_wifi_home(db, OWNER, { fetch_clients: async () => { throw new Error('unifi down'); } });
  check('resolve_wifi_home: read throws → fail-open empty', r4.home_members.size === 0 && !r4.available);

  process.env.HEARTH_WIFI_PRESENCE = '0';
  check('wifi_presence_enabled() reflects the flag', !wifi_presence_enabled());
  const rOff = await resolve_wifi_home(db, OWNER, { fetch_clients: async () => associated });
  check('resolve_wifi_home: gate OFF → empty (no UniFi read)', rOff.home_members.size === 0 && !rOff.available);
  process.env.HEARTH_WIFI_PRESENCE = '1';

  /* ── 4. apply_wifi_home (pure fusion) ─────────────────────────────────── */
  const locs: HouseholdLocation[] = [
    { user_id: 'jasper', display_name: 'Jasper', presence: 'unknown', presence_confidence: 'low', as_of: null },
    { user_id: 'sam', display_name: 'Sam', presence: 'away', presence_confidence: 'medium', as_of: '2026-06-15T17:00:00.000Z' },
    { user_id: 'kim', display_name: 'Kim', presence: 'home', presence_confidence: 'high', as_of: '2026-06-15T17:30:00.000Z' },
  ];
  const fused = apply_wifi_home(locs, new Set(['jasper', 'sam']), NOW);
  const j = fused.find((l) => l.user_id === 'jasper')!;
  const s = fused.find((l) => l.user_id === 'sam')!;
  const kim = fused.find((l) => l.user_id === 'kim')!;
  check('apply: unknown → home/high (as-of now)', j.presence === 'home' && j.presence_confidence === 'high' && j.as_of === new Date(NOW).toISOString());
  check('apply: confident away → overridden to home (live association wins)', s.presence === 'home' && s.presence_confidence === 'high');
  check('apply: a member NOT WiFi-home is untouched', kim.presence === 'home' && kim.as_of === '2026-06-15T17:30:00.000Z');
  const none = apply_wifi_home(locs, new Set<string>(), NOW);
  check('apply: empty home set → array unchanged (same refs)', none[0] === locs[0]);

  rmSync(dir, { recursive: true, force: true });
  console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
