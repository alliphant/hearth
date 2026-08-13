/**
 * smoke:ruby — self-contained coverage for Ruby's three fixes (2026-05-31).
 *
 * No network, no orchestrator, no LLM. Temp vault + db. Exercises the
 * backend mechanics behind the issues Jasper hit:
 *
 *   1. recent_trips reconstructs his trips out of the house from seeded iOS
 *      location events (Fix 1) — the honest "mode not recorded" note when no
 *      motion is present, and arrived_via when it is.
 *   2. record_civic_item PERSISTS when the turn carries a user, and rejects
 *      cleanly when it doesn't (Fix 2 — the bug that left the civic office
 *      pane empty: deliberation ran the tool user-less and every write
 *      no-op'd). The civic pane's own query (list_civic_items) then sees it.
 *
 * (Fix 3 — authoritative speaker identity — is covered in smoke:proactive.)
 */

import { tmpdir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { ulid } from 'ulid';
import { open_db } from '../src/memory/stores/structured';
import { MemoryClient } from '../src/memory/client';
import { ConfigLLMRouter } from '../src/core/router';
import { init_location_awareness } from '../src/core/location_awareness';
import type { ToolContext } from '../src/core/tool';
import { recent_trips } from '../src/specialists/ruby/tools/recent_trips';
import { record_civic_item } from '../src/specialists/ruby/tools/record_civic_item';

const USER = 'jasper';

type SeedEvent = {
  kind: string;
  lat: number;
  lng: number;
  ts: string;
  place_id?: string | null;
  horizontal_accuracy_m?: number;
  motion?: string;
};

async function main(): Promise<void> {
  let pass = 0;
  const assert = (cond: boolean, msg: string): void => {
    if (!cond) throw new Error(msg);
  };

  const vault_root = resolve(tmpdir(), `hearth-ruby-smoke-${Date.now()}`);
  mkdirSync(resolve(vault_root, 'data'), { recursive: true });
  const db = open_db(resolve(vault_root, 'data', 'smoke.db'));
  const memory = new MemoryClient({ vault_root, db });
  const llm = new ConfigLLMRouter('./config/llm-roles.yaml', {
    ollama_base_url: 'http://localhost:11434',
  });
  init_location_awareness(db, vault_root);

  const seed_location = (ev: SeedEvent): void => {
    const id = ulid();
    const rel_path = `Users/${USER}/sensors/location/${ev.ts.slice(0, 10)}/${ev.ts}-${id}.json`;
    const abs = resolve(vault_root, rel_path);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, JSON.stringify(ev, null, 2));
    db.prepare(
      `INSERT INTO sensor_packets
         (id, user_id, device_id, signal, captured_at, received_at, payload_path)
       VALUES (@id, @user_id, 'smoke-device', 'location', @captured_at, @received_at, @path)`,
    ).run({
      '@id': id,
      '@user_id': USER,
      '@captured_at': ev.ts,
      '@received_at': ev.ts,
      '@path': rel_path,
    });
  };

  const ctx: ToolContext = {
    memory,
    llm,
    now: new Date('2026-05-31T18:00:00Z'),
    intent_id: 'smoke-ruby',
    specialist_id: 'ruby',
    user: { id: USER, tier: 'owner' },
  };

  try {
    // ── Fix 1: recent_trips reconstructs visits; mode honestly omitted ────
    console.log('→ recent_trips: reconstructs visits, omits mode when not recorded');
    seed_location({ kind: 'visit_departure', lat: 39.72, lng: -104.97, ts: '2026-05-31T15:00:00Z', place_id: 'home' });
    seed_location({ kind: 'visit_arrival', lat: 39.74, lng: -104.99, ts: '2026-05-31T15:20:00Z', place_id: 'gym', horizontal_accuracy_m: 12 });
    seed_location({ kind: 'visit_departure', lat: 39.74, lng: -104.99, ts: '2026-05-31T16:05:00Z', place_id: 'gym' });
    seed_location({ kind: 'visit_arrival', lat: 39.76, lng: -104.95, ts: '2026-05-31T16:30:00Z', place_id: 'store' });

    const trips = await recent_trips.execute({ lookback_hours: 48, max_visits: 10 }, ctx);
    assert(trips.ok === true, 'recent_trips should succeed with a user + allowlisted specialist');
    assert((trips.visits?.length ?? 0) === 3, `expected 3 visits, got ${trips.visits?.length}`);
    const by = Object.fromEntries((trips.visits ?? []).map((v) => [v.place_label, v]));
    assert(by.store?.ongoing === true, 'store visit should be ongoing (no departure seen)');
    assert(by.gym?.duration_minutes === 45, `gym duration should be 45m, got ${by.gym?.duration_minutes}`);
    assert(by.home?.arrived_at === null, 'home visit should have unknown arrival (departure-only)');
    assert(trips.motion_available === false, 'motion should be unavailable (none seeded)');
    assert(!!trips.note && /not recorded/i.test(trips.note), 'note should say travel mode is not recorded');
    console.log('  ✓ 3 visits reconstructed; durations + ongoing correct; mode honestly omitted');
    pass++;

    // ── Fix 1b: arrived_via surfaces when iOS posted motion ───────────────
    console.log('→ recent_trips: surfaces arrived_via when motion present');
    seed_location({ kind: 'visit_arrival', lat: 39.77, lng: -104.94, ts: '2026-05-31T17:30:00Z', place_id: 'library', motion: 'cycling' });
    const trips2 = await recent_trips.execute({ lookback_hours: 48, max_visits: 10 }, ctx);
    assert(trips2.motion_available === true, 'motion should now be available');
    const lib = (trips2.visits ?? []).find((v) => v.place_label === 'library');
    assert(lib?.arrived_via === 'cycling', `library arrived_via should be cycling, got ${lib?.arrived_via}`);
    console.log('  ✓ arrived_via=cycling surfaced from a motion-bearing packet');
    pass++;

    // ── Fix 2: record_civic_item persists with a user, rejects without ────
    console.log('→ record_civic_item: persists with user context (the empty-pane fix)');
    const rec = await record_civic_item.execute(
      {
        kind: 'council_meeting',
        title: 'City Council — regular meeting',
        summary: 'Budget hearing on the agenda.',
        event_at: '2026-06-02T18:00:00Z',
        interest_score: 0.8,
        // council_meeting rows must be keyed meeting:<id> (the scan's
        // namespace) — the guard rejects hand-authored ones.
        dedup_key: 'meeting:smoke-4462',
      } as Parameters<typeof record_civic_item.execute>[0],
      ctx,
    );
    assert(rec.ok === true, `record_civic_item should succeed with a user, got: ${JSON.stringify(rec)}`);
    // The civic pane reads exactly this query — proving the pane will populate.
    const items = memory.list_civic_items(USER);
    assert(items.length === 1, `civic pane query should see 1 item, got ${items.length}`);
    assert(items[0]?.kind === 'council_meeting', 'persisted item should be the council meeting');
    console.log('  ✓ item persisted and visible to the civic pane query');
    pass++;

    console.log('→ record_civic_item: rejects cleanly when the turn has no user');
    const userless: ToolContext = { ...ctx, user: undefined };
    const rec2 = await record_civic_item.execute(
      { kind: 'announcement', title: 'no-user write', interest_score: 0.5 } as Parameters<
        typeof record_civic_item.execute
      >[0],
      userless,
    );
    assert(rec2.ok === false, 'record_civic_item must reject a user-less turn (not silently persist)');
    assert(memory.list_civic_items(USER).length === 1, 'no-user write must not add a row');
    console.log('  ✓ user-less write rejected with a typed error; no orphan row');
    pass++;

    // ── Dedup guard: a hand-authored council_meeting is rejected with a hint
    console.log('→ record_civic_item: rejects hand-authored council_meeting (scan owns meeting:<id>)');
    const before_guard = memory.list_civic_items(USER).length;
    const guarded = await record_civic_item.execute(
      { kind: 'council_meeting', title: 'City Council Work Session — hand typed', interest_score: 0.7 } as Parameters<
        typeof record_civic_item.execute
      >[0],
      ctx,
    );
    assert(guarded.ok === false, 'hand-authored council_meeting (non-meeting: key) must be rejected');
    assert(
      !!guarded.recovery_hint && /scan_council_meetings/.test(guarded.recovery_hint),
      'rejection must carry a recovery_hint pointing at the scan',
    );
    assert(memory.list_civic_items(USER).length === before_guard, 'rejected council_meeting must not add a row');
    console.log('  ✓ hand-authored council_meeting rejected with recovery_hint; no duplicate row');
    pass++;

    console.log(`\n✓ ${pass} checks passed. smoke:ruby done.`);
  } catch (err) {
    console.error(`\n✗ smoke:ruby failed (${pass} passed):`, err);
    process.exitCode = 1;
  } finally {
    try {
      db.close();
    } catch {
      /* ignore */
    }
    rmSync(vault_root, { recursive: true, force: true });
  }
}

// ConfigLLMRouter starts a config-file watcher that keeps the event loop
// alive; exit explicitly so the smoke doesn't hang (mirrors smoke-maps).
main()
  .then(() => process.exit(process.exitCode ?? 0))
  .catch((err) => {
    console.error('smoke:ruby crashed:', err);
    process.exit(1);
  });
