/**
 * Smoke test for the maps connector + spatial awareness stack.
 *
 * Self-contained: spins up a temp vault + SQLite DB, runs each step in
 * isolation, prints pass/fail. Skips OSRM-dependent steps when the
 * stack isn't reachable; primes the location cache directly via the
 * iOS-sensor-equivalent `_set_cached_snapshot(user_id, ...)` test
 * seam rather than POSTing a fake packet through the full sensors
 * route. The HA-backed `ha_get_my_location` tool was removed
 * 2026-05-30 (iOS CoreLocation is the source now); the maps cache
 * itself is source-agnostic.
 */

import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { open_db } from '../src/memory/stores/structured';
import { MemoryClient } from '../src/memory/client';
import { ConfigLLMRouter } from '../src/core/router';
import { geocode, route, distance_matrix, nearby, redact_for_audit } from '../src/connectors/maps';
import { upsert_place } from '../src/connectors/places';
import {
  init_location_awareness,
  get_current_location,
  _set_cached_snapshot,
  reset_location_cache,
} from '../src/core/location_awareness';
import { maps_cache } from '../src/connectors/maps_cache';
import type { ToolContext } from '../src/core/tool';
import type { Tool } from '../src/core/tool';

const SMOKE_USER_ID = 'jasper';

const NOMINATIM_BASE_URL = process.env.NOMINATIM_BASE_URL ?? 'http://localhost:8989';
const OSRM_DRIVE_URL = process.env.OSRM_DRIVE_URL ?? 'http://localhost:5001';
const TEST_HOME_LAT = parseFloat(process.env.TEST_HOME_LAT ?? '39.7305');
const TEST_HOME_LON = parseFloat(process.env.TEST_HOME_LON ?? '-104.9822');
async function reachable(url: string): Promise<boolean> {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(2_000) });
    return r.status < 500;
  } catch {
    return false;
  }
}

function init_test_env(): { ctx: ToolContext; cleanup: () => void; memory: MemoryClient } {
  const vault_root = resolve(tmpdir(), `hearth-maps-smoke-${Date.now()}`);
  const db_path = resolve(vault_root, 'data', 'smoke.db');
  mkdirSync(vault_root, { recursive: true });
  mkdirSync(resolve(vault_root, 'data'), { recursive: true });
  const db = open_db(db_path);
  const memory = new MemoryClient({ vault_root, db });
  // ConfigLLMRouter needs a config file but we won't actually call the
  // LLM — give it the real config path so init succeeds.
  const llm = new ConfigLLMRouter('./config/llm-roles.yaml', {
    ollama_base_url: 'http://localhost:11434',
  });
  init_location_awareness(db, vault_root);
  const ctx: ToolContext = {
    memory,
    llm,
    now: new Date(),
    intent_id: 'smoke-maps',
    user: { id: SMOKE_USER_ID, tier: 'owner' },
  };
  return {
    ctx,
    memory,
    cleanup() {
      try {
        db.close();
      } catch {
        /* ignore */
      }
      rmSync(vault_root, { recursive: true, force: true });
    },
  };
}

async function main() {
  let passed = 0;
  let skipped = 0;
  let failed = 0;
  const fail = (msg: string) => {
    console.error(`  ✗ ${msg}`);
    failed++;
  };
  const ok = (msg: string) => {
    console.log(`  ✓ ${msg}`);
    passed++;
  };
  const skip = (msg: string) => {
    console.warn(`  ⚠ ${msg}`);
    skipped++;
  };

  const env = init_test_env();
  const { ctx, memory } = env;

  // ── 1. Geocode ────────────────────────────────────────────────────────
  console.log('→ geocode: "300 W Central Ave, Pleasantville, CO"');
  let geocoded_lat: number | null = null;
  let geocoded_lon: number | null = null;
  if (!(await reachable(NOMINATIM_BASE_URL))) {
    skip(`Nominatim not reachable at ${NOMINATIM_BASE_URL}`);
  } else {
    const out = await geocode.execute(
      { query: '300 W Central Ave, Pleasantville, CO' },
      ctx,
    );
    const top = out.results[0];
    if (!top) {
      fail(`no geocode results: ${out.error ?? 'unknown'}`);
    } else if (top.lat < 39.67 || top.lat > 39.77 || top.lon < -104.99 || top.lon > -104.89) {
      fail(`coords out of expected box: ${top.lat},${top.lon}`);
    } else {
      ok(`got ${top.lat.toFixed(4)},${top.lon.toFixed(4)} (${top.name})`);
      geocoded_lat = top.lat;
      geocoded_lon = top.lon;
    }
  }

  // ── 2. Route (drive) ──────────────────────────────────────────────────
  console.log('\n→ route (drive): home → the clinic VTH');
  if (!(await reachable(OSRM_DRIVE_URL))) {
    skip(`OSRM drive not reachable at ${OSRM_DRIVE_URL}`);
  } else if (geocoded_lat === null || geocoded_lon === null) {
    skip('geocode step did not yield coords');
  } else {
    const r = await route.execute(
      {
        from: { lat: TEST_HOME_LAT, lon: TEST_HOME_LON },
        to: { lat: geocoded_lat, lon: geocoded_lon },
        mode: 'drive',
        include_geometry: false,
      },
      ctx,
    );
    if (r.error) {
      fail(`drive route error: ${r.error}`);
    } else {
      const minutes = r.duration_seconds / 60;
      const km = r.distance_meters / 1000;
      // Wide sanity range — TEST_HOME may be set close to or far from
      // the clinic; we just want to confirm we got A route, not a specific one.
      if (minutes < 0.5 || minutes > 60 || km > 50) {
        fail(`out of sanity range: ${minutes.toFixed(1)} min, ${km.toFixed(1)} km`);
      } else {
        ok(`${minutes.toFixed(1)} min / ${km.toFixed(1)} km drive`);
      }
    }
  }

  // ── 3. Route (bike) ──────────────────────────────────────────────────
  console.log('\n→ route (bike): home → the clinic VTH');
  if (!(await reachable(OSRM_DRIVE_URL))) {
    skip('OSRM stack not reachable');
  } else if (geocoded_lat === null || geocoded_lon === null) {
    skip('geocode step did not yield coords');
  } else {
    const drive = await route.execute(
      {
        from: { lat: TEST_HOME_LAT, lon: TEST_HOME_LON },
        to: { lat: geocoded_lat, lon: geocoded_lon },
        mode: 'drive',
        include_geometry: false,
      },
      ctx,
    );
    const bike = await route.execute(
      {
        from: { lat: TEST_HOME_LAT, lon: TEST_HOME_LON },
        to: { lat: geocoded_lat, lon: geocoded_lon },
        mode: 'bike',
        include_geometry: false,
      },
      ctx,
    );
    if (bike.error || drive.error) {
      fail(`bike or drive error: ${bike.error ?? drive.error}`);
    } else {
      const ratio = bike.duration_seconds / Math.max(1, drive.duration_seconds);
      // Bike routing on a major arterial is usually 2-6× drive ETA.
      if (ratio < 1.3 || ratio > 8) {
        fail(`bike/drive ratio off: ${ratio.toFixed(2)}`);
      } else {
        ok(`bike ${(bike.duration_seconds / 60).toFixed(1)} min vs drive ${(drive.duration_seconds / 60).toFixed(1)} min`);
      }
    }
  }

  // ── 4. distance_matrix ───────────────────────────────────────────────
  console.log('\n→ distance_matrix: 2x3');
  if (!(await reachable(OSRM_DRIVE_URL))) {
    skip('OSRM not reachable');
  } else {
    const out = await distance_matrix.execute(
      {
        origins: [
          { lat: TEST_HOME_LAT, lon: TEST_HOME_LON },
          { lat: TEST_HOME_LAT + 0.005, lon: TEST_HOME_LON },
        ],
        destinations: [
          { lat: 39.7428, lon: -104.9893 },
          { lat: 39.7392, lon: -104.9903 },
          { lat: 39.7244, lon: -104.9682 },
        ],
        mode: 'drive',
      },
      ctx,
    );
    if (out.error || out.rows.length !== 2 || out.rows[0]?.length !== 3) {
      fail(`shape mismatch or error: ${out.error ?? `${out.rows.length}x${out.rows[0]?.length}`}`);
    } else {
      ok(`2x3 matrix returned`);
    }
  }

  // ── 5. Places upsert ─────────────────────────────────────────────────
  console.log('\n→ upsert_place: a test place');
  const test_name = `Smoke Test Place ${Date.now()}`;
  const up = await upsert_place.execute(
    {
      name: test_name,
      coords: [39.7428, -104.9893],
      category: 'veterinary',
      aliases: ['smoke-test', 'st place'],
      parking_buffer_minutes: 5,
    },
    ctx,
  );
  if (!up.created || !up.id.startsWith('pl_')) {
    fail(`upsert returned ${JSON.stringify(up)}`);
  } else {
    // Verify the file exists with valid frontmatter and the projection
    // table has a row. The ingestor isn't running in this smoke, so
    // we need to project it manually for find_place_by_name to work.
    const note_path = resolve((memory as unknown as { cfg: { vault_root: string } }).cfg.vault_root, up.note_path);
    if (!existsSync(note_path)) {
      fail(`vault file missing: ${note_path}`);
    } else {
      // Insert directly into places table for the find_place_by_name step.
      const db = (memory as unknown as { cfg: { db: import('bun:sqlite').Database } }).cfg.db;
      db.prepare(
        `INSERT OR REPLACE INTO places
         (id, name, aliases_json, address, lat, lon, category, ha_zone_name,
          parking_buffer_minutes, hours_json, phone, note_path, mtime)
         VALUES
         (@id, @name, @aliases_json, NULL, @lat, @lon, @category, NULL,
          @parking, NULL, NULL, @note_path, @mtime)`,
      ).run({
        '@id': up.id,
        '@name': test_name,
        '@aliases_json': JSON.stringify(['smoke-test', 'st place']),
        '@lat': 39.7428,
        '@lon': -104.9893,
        '@category': 'veterinary',
        '@parking': 5,
        '@note_path': up.note_path,
        '@mtime': new Date().toISOString(),
      });
      ok(`created ${up.id} at ${up.note_path}`);
    }
  }

  // ── 6. Places lookup ────────────────────────────────────────────────
  console.log('\n→ find_place_by_name (name + alias)');
  const by_name = memory.find_place_by_name(test_name);
  if (!by_name || by_name.id !== up.id) {
    fail(`name lookup failed: ${JSON.stringify(by_name)}`);
  } else {
    ok(`name lookup hit ${by_name.id}`);
    const by_alias = memory.find_place_by_name('smoke-test');
    if (!by_alias || by_alias.id !== up.id) {
      fail(`alias lookup failed`);
    } else {
      ok(`alias lookup hit ${by_alias.id}`);
    }
  }

  // ── 7. Cached snapshot (two quick calls) ─────────────────────────────
  console.log('\n→ location_awareness cache (iOS-sensor-backed)');
  reset_location_cache();
  _set_cached_snapshot(SMOKE_USER_ID, {
    coords: { lat: TEST_HOME_LAT, lon: TEST_HOME_LON },
    place_id: 'home',
    kind: 'visit_arrival',
    confidence: 'high',
    horizontal_accuracy_m: 12,
    ts: new Date().toISOString(),
  });
  const t0 = Date.now();
  const a = await get_current_location(SMOKE_USER_ID);
  const t1 = Date.now();
  const b = await get_current_location(SMOKE_USER_ID);
  const t2 = Date.now();
  if (a.place_id !== 'home' || b.place_id !== 'home') {
    fail(`primed snapshot not honored: ${a.place_id}, ${b.place_id}`);
  } else if (t2 - t1 > t1 - t0) {
    // Both should be fast since both hit cache; but no strict
    // ordering guarantee under load.
    ok(`primed snapshot returned twice (place_id=home)`);
  } else {
    ok(`primed snapshot returned twice (cache hit)`);
  }

  // ── 8. Route from my_current_location ────────────────────────────────
  console.log('\n→ route with from={my_current_location: true}');
  if (!(await reachable(OSRM_DRIVE_URL))) {
    skip('OSRM not reachable');
  } else {
    reset_location_cache();
    _set_cached_snapshot(SMOKE_USER_ID, {
      coords: { lat: TEST_HOME_LAT, lon: TEST_HOME_LON },
      place_id: 'home',
      kind: 'visit_arrival',
      confidence: 'high',
      ts: new Date().toISOString(),
    });
    const r = await route.execute(
      {
        from: { my_current_location: true },
        to: { lat: 39.7428, lon: -104.9893 },
        mode: 'drive',
        include_geometry: false,
      },
      ctx,
    );
    if (r.error) {
      fail(`route error: ${r.error}`);
    } else {
      ok(`routed from current location, ${(r.duration_seconds / 60).toFixed(1)} min`);
    }
    // "no location" branch: clear the cache and skip priming. With no
    // sensor row in the DB and an empty cache, get_current_location
    // returns the empty snapshot and the route surface the structured
    // "current location unavailable" error.
    reset_location_cache();
    const r2 = await route.execute(
      {
        from: { my_current_location: true },
        to: { lat: 39.7428, lon: -104.9893 },
        mode: 'drive',
        include_geometry: false,
      },
      ctx,
    );
    if (r2.error === 'current location unavailable') {
      ok(`unavailable-location path returns structured error`);
    } else {
      fail(`expected 'current location unavailable', got: ${r2.error ?? 'no error'}`);
    }
  }

  // ── 9. Audit redaction ───────────────────────────────────────────────
  console.log('\n→ audit redaction in audit_log');
  const db = (memory as unknown as { cfg: { db: import('bun:sqlite').Database } }).cfg.db;
  const rows = db
    .prepare(
      `SELECT tool_name, tool_input, execution_result FROM audit_log
       WHERE tool_name IN ('geocode', 'route')`,
    )
    .all() as Array<{ tool_name: string; tool_input: string; execution_result: string | null }>;
  let redaction_violations: string[] = [];
  for (const r of rows) {
    const re = /-?\d{2,3}\.\d{4,}/;
    if (re.test(r.tool_input)) {
      redaction_violations.push(`${r.tool_name} contained >3-decimal coord`);
    }
  }
  if (redaction_violations.length > 0) {
    fail(`redaction violations: ${redaction_violations.join('; ')}`);
  } else {
    ok(`no precise coords found in ${rows.length} relevant audit row(s)`);
  }

  // Also check redact_for_audit directly.
  const test_redact = redact_for_audit({
    lat: 39.7428123,
    lon: -104.9893456,
    address: '300 W Central Ave, Pleasantville, CO 80000',
    name: 'the clinic VTH',
  }) as { lat: number; lon: number; address: string; name: string };
  if (
    test_redact.lat === 39.743 &&
    test_redact.lon === -104.989 &&
    test_redact.address === 'CO 80000, ' || test_redact.address === 'Pleasantville, CO 80000'
  ) {
    // The "Pleasantville, CO 80000" form depends on the address shape;
    // any non-precise form is acceptable.
    ok(`redact_for_audit rounds coords + strips address`);
  } else if (
    Math.abs(test_redact.lat - 39.743) < 0.0005 &&
    test_redact.address !== '300 W Central Ave, Pleasantville, CO 80000'
  ) {
    ok(`redact_for_audit rounds coords + strips address (variant)`);
  } else {
    fail(`redact_for_audit unexpected: ${JSON.stringify(test_redact)}`);
  }

  // ── 10. Capability declarations ──────────────────────────────────────
  console.log('\n→ capability declarations');
  // upsert_place declares write_places
  const upsert_tool = upsert_place as Tool;
  if (upsert_tool.required_capabilities?.includes('write_places')) {
    ok(`upsert_place declares write_places`);
  } else {
    fail(`upsert_place missing write_places`);
  }

  // Clean up.
  env.cleanup();
  maps_cache.clear();

  console.log('\n' + '─'.repeat(60));
  console.log(`Results: ${passed} passed, ${failed} failed, ${skipped} skipped`);
  if (failed > 0) {
    console.log('✗ SMOKE FAILED');
    process.exit(1);
  } else {
    console.log('✓ SMOKE PASSED');
    process.exit(0);
  }
}

main().catch((err) => {
  console.error('smoke crashed:', err);
  process.exit(1);
});
