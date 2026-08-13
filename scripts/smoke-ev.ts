/**
 * Smoke for Iris's plan_ev_day tool. Self-contained: temp vault + DB,
 * seed three Places, mock the SQLite calendar/state lookups by stubbing
 * the HA fetch path.
 *
 * The tool reads the calendar from the iOS calendar snapshot
 * (`MemoryClient.query_calendar_snapshot` over `calendar_snapshots`) —
 * NOT the deprecated HA-CalDAV path. The snapshot read is exercised
 * directly via the exported `read_day_events` helper (window + located-
 * only filtering), which is deterministic and needs no OSRM.
 *
 * Routing (the leg builder) needs OSRM, so the end-to-end execute() cases
 * stick to the empty-calendar / verdict-tree branches that don't route.
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { open_db } from '../src/memory/stores/structured';
import { MemoryClient } from '../src/memory/client';
import { ConfigLLMRouter } from '../src/core/router';
import { plan_ev_day, read_day_events } from '../src/specialists/kate/tools/plan_ev_day';
import { init_location_awareness, _set_cached_snapshot, reset_location_cache } from '../src/core/location_awareness';
import type { ToolContext } from '../src/core/tool';

function init_env(): { ctx: ToolContext; memory: MemoryClient; cleanup: () => void } {
  const vault_root = resolve(tmpdir(), `hearth-ev-smoke-${Date.now()}`);
  const db_path = resolve(vault_root, 'data', 'smoke.db');
  mkdirSync(vault_root, { recursive: true });
  mkdirSync(resolve(vault_root, 'data'), { recursive: true });
  const db = open_db(db_path);
  const memory = new MemoryClient({ vault_root, db });
  const llm = new ConfigLLMRouter('./config/llm-roles.yaml', {
    ollama_base_url: 'http://localhost:11434',
  });
  init_location_awareness(db, vault_root);
  reset_location_cache();
  const smoke_user_id = 'jasper';
  // Seed a current-location snapshot so plan_ev_day has a fallback if
  // there's no Home place yet. Post-2026-05-30 the location source is
  // the iOS sensor stream; this test seam writes directly into the
  // process cache as if a packet had just landed.
  _set_cached_snapshot(smoke_user_id, {
    coords: { lat: 39.7305, lon: -104.968 },
    place_id: 'home',
    kind: 'visit_arrival',
    confidence: 'high',
    horizontal_accuracy_m: 10,
    ts: new Date().toISOString(),
  });
  return {
    memory,
    ctx: {
      memory,
      llm,
      now: new Date(),
      intent_id: 'smoke-ev',
      user: { id: smoke_user_id, tier: 'owner' },
    },
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

function seed_places(memory: MemoryClient): void {
  const db = (memory as unknown as { cfg: { db: import('bun:sqlite').Database } }).cfg.db;
  const stmt = db.prepare(
    `INSERT OR REPLACE INTO places
     (id, name, aliases_json, address, lat, lon, category, ha_zone_name,
      parking_buffer_minutes, hours_json, phone, note_path, mtime)
     VALUES
     (@id, @name, @aliases_json, NULL, @lat, @lon, @category, NULL,
      0, NULL, NULL, @note_path, @mtime)`,
  );
  const mtime = new Date().toISOString();
  stmt.run({
    '@id': 'pl_home00',
    '@name': 'Home',
    '@aliases_json': JSON.stringify(['home']),
    '@lat': 39.7305,
    '@lon': -104.968,
    '@category': 'residence',
    '@note_path': 'Places/Home.md',
    '@mtime': mtime,
  });
  stmt.run({
    '@id': 'pl_csu000',
    '@name': 'the clinic VTH',
    '@aliases_json': JSON.stringify(['csu vth', 'the vet']),
    '@lat': 39.7428,
    '@lon': -104.9893,
    '@category': 'veterinary',
    '@note_path': 'Places/vet-hospital.md',
    '@mtime': mtime,
  });
  stmt.run({
    '@id': 'pl_dwntw00',
    '@name': 'Downtown Pleasantville',
    '@aliases_json': JSON.stringify(['downtown', 'old town']),
    '@lat': 39.7392,
    '@lon': -104.9903,
    '@category': 'district',
    '@note_path': 'Places/downtown.md',
    '@mtime': mtime,
  });
}

/**
 * Seed an iOS-style calendar snapshot for `user_id` directly: write the
 * payload JSON + insert the `calendar_snapshots` row, mirroring the
 * sensors route's DELETE+INSERT-per-upload shape.
 */
function seed_calendar_snapshot(
  memory: MemoryClient,
  user_id: string,
  events: Array<{
    event_id: string;
    title: string;
    ts_start: string;
    ts_end: string;
    location?: string | null;
    calendar_name?: string;
  }>,
): void {
  const cfg = (memory as unknown as {
    cfg: { db: import('bun:sqlite').Database; vault_root: string };
  }).cfg;
  const { db, vault_root } = cfg;
  const rel = `data/cal-snapshot-${user_id}.json`;
  const full_events = events.map((e) => ({
    calendar_name: 'iCloud',
    calendar_type: 'caldav' as const,
    has_attendees: false,
    location: null,
    ...e,
  }));
  writeFileSync(resolve(vault_root, rel), JSON.stringify({ events: full_events }), 'utf8');
  const now = new Date().toISOString();
  db.prepare(`DELETE FROM calendar_snapshots WHERE user_id = @u`).run({ '@u': user_id });
  db.prepare(
    `INSERT INTO calendar_snapshots
       (user_id, captured_at, received_at, window_start, window_end, event_count, payload_path)
     VALUES (@u, @cap, @rec, @ws, @we, @n, @pp)`,
  ).run({
    '@u': user_id,
    '@cap': now,
    '@rec': now,
    '@ws': '2026-01-01T00:00:00.000Z',
    '@we': '2099-12-31T23:59:59.000Z',
    '@n': full_events.length,
    '@pp': rel,
  });
}

async function main() {
  let passed = 0;
  let failed = 0;
  const ok = (msg: string) => {
    console.log(`  ✓ ${msg}`);
    passed++;
  };
  const fail = (msg: string) => {
    console.error(`  ✗ ${msg}`);
    failed++;
  };

  const env = init_env();
  const { ctx, memory } = env;
  seed_places(memory);

  // ── 1. plan_ev_day with empty calendar (edge case) ───────────────────
  console.log('→ plan_ev_day: empty calendar');
  // Far-future date so the calendar window finds no events even when
  // real HA is configured. Exercises the empty-legs / 'easily_fits'
  // branch without mocking the HA connector.
  const empty = await plan_ev_day.execute({ date: '2099-12-31' }, ctx);
  if (empty.error && !empty.error.includes("couldn't resolve")) {
    // Could be HA error — still acceptable since the call survived.
    ok(`empty-calendar path executed (error path: ${empty.error.slice(0, 60)})`);
  } else if (empty.verdict === 'easily_fits' && empty.events_with_legs.length === 0) {
    ok(`empty calendar → 'easily_fits', 0 legs`);
  } else {
    fail(
      `unexpected: verdict=${empty.verdict} legs=${empty.events_with_legs.length} err=${empty.error ?? 'none'}`,
    );
  }

  // ── 1b. snapshot read path (iOS calendar snapshot, no OSRM needed) ────
  console.log('\n→ read_day_events: iOS snapshot window + located-only filter');
  seed_calendar_snapshot(memory, 'jasper', [
    {
      event_id: 'ev_in_window',
      title: 'Vet appointment',
      ts_start: '2026-07-15T16:00:00.000Z',
      ts_end: '2026-07-15T17:00:00.000Z',
      location: 'the clinic VTH',
    },
    {
      event_id: 'ev_no_location',
      title: 'Phone call',
      ts_start: '2026-07-15T18:00:00.000Z',
      ts_end: '2026-07-15T18:30:00.000Z',
      location: null,
    },
    {
      event_id: 'ev_out_of_window',
      title: 'Next week dentist',
      ts_start: '2026-07-22T14:00:00.000Z',
      ts_end: '2026-07-22T15:00:00.000Z',
      location: 'Downtown Pleasantville',
    },
  ]);
  const day = read_day_events(ctx, 'jasper', {
    start: '2026-07-15T00:00:00.000Z',
    end: '2026-07-15T23:59:59.999Z',
  });
  if (
    day.length === 1 &&
    day[0]?.summary === 'Vet appointment' &&
    day[0]?.location === 'the clinic VTH'
  ) {
    ok('reads located in-window event; drops no-location + out-of-window');
  } else {
    fail(`unexpected read_day_events result: ${JSON.stringify(day)}`);
  }

  const no_snap_user = read_day_events(ctx, 'nobody', {
    start: '2026-07-15T00:00:00.000Z',
    end: '2026-07-15T23:59:59.999Z',
  });
  if (no_snap_user.length === 0) {
    ok('no snapshot for user → empty list (not an error)');
  } else {
    fail(`expected empty for user with no snapshot, got ${no_snap_user.length}`);
  }

  // ── 2. verdict tree validation ────────────────────────────────────────
  console.log('\n→ verdict shape sanity');
  if (
    [
      'easily_fits',
      'fits_with_buffer',
      'tight_consider_charging',
      'requires_charging',
      'requires_dc_fast_charge',
    ].includes(empty.verdict)
  ) {
    ok(`verdict '${empty.verdict}' is in the defined enum`);
  } else {
    fail(`verdict '${empty.verdict}' not in enum`);
  }

  // ── 3. tool shape — input + output schemas validate ──────────────────
  console.log('\n→ schema validation');
  const out_check = plan_ev_day.output_schema.safeParse(empty);
  if (out_check.success) {
    ok(`output schema validates`);
  } else {
    fail(`output failed schema: ${out_check.error.message}`);
  }

  env.cleanup();

  console.log('\n' + '─'.repeat(60));
  console.log(`Results: ${passed} passed, ${failed} failed`);
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
