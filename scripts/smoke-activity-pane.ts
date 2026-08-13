/**
 * Smoke for Astrid's Activity pane (Tier 1 #1 of the 2026-05-29 refresh).
 * Self-contained: temp vault + DB, seeded workout_sessions for live +
 * standby modes, seeded PR shelves + observations note.
 *
 * Covers:
 *   - new PaneBlock variants land typed (hero_metric, stacked_strip,
 *     load_chart)
 *   - LIVE mode fires when workout_sessions has an active row AND the
 *     in-memory tracker knows it (current HR, kcal, zone strip,
 *     silence-cues deep link)
 *   - LIVE-stub mode fires when SQL says active but the tracker is
 *     unaware (orchestrator-restart case) — pane still renders elapsed
 *     + a graceful "Astrid will reconnect" line
 *   - STANDBY mode fires when no active row — 7-day hero, daily
 *     load-chart points (pre-filled across the week), aggregated zone
 *     strip, PR top-3, recent sessions list
 *   - observations.md tail renders as a closing italic text block
 *   - empty-state fallbacks render the placeholder rows rather than
 *     dropping the section
 */

import { mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { open_db } from '../src/memory/stores/structured';
import { MemoryClient } from '../src/memory/client';
import { ConfigLLMRouter } from '../src/core/router';
import { ToolRegistry } from '../src/core/tool_registry';
import { compose_pane, type PaneBlock, type PaneDeps, type PaneDocument } from '../src/core/specialist_pane';
import { WorkoutSessionTracker, create_workout_router } from '../src/app/routes/workout';
import { AppEventBus } from '../src/app/events';
import { Hono } from 'hono';
import type { LoadedSpecialist } from '../src/core/specialist';

interface Env {
  vault_root: string;
  db: import('bun:sqlite').Database;
  memory: MemoryClient;
  llm: ConfigLLMRouter;
  registry: ToolRegistry;
  tracker: WorkoutSessionTracker;
  cleanup: () => void;
}

function init_env(): Env {
  const vault_root = resolve(tmpdir(), `hearth-activity-smoke-${Date.now()}`);
  const db_path = resolve(vault_root, 'data', 'smoke.db');
  mkdirSync(vault_root, { recursive: true });
  mkdirSync(resolve(vault_root, 'data'), { recursive: true });
  const db = open_db(db_path);
  const memory = new MemoryClient({ vault_root, db });
  const llm = new ConfigLLMRouter('./config/llm-roles.yaml', {
    ollama_base_url: 'http://localhost:11434',
  });
  const registry = new ToolRegistry();
  const tracker = new WorkoutSessionTracker();
  return {
    vault_root,
    db,
    memory,
    llm,
    registry,
    tracker,
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

function make_spec(): LoadedSpecialist {
  return {
    id: 'astrid',
    name: 'Astrid',
    role: 'Trainer',
    avatar: null,
    voice: 'warm-direct',
    aliases: [],
    persona: '',
    knowledge_scope: [],
    granted: new Set(),
    proactive: { mode: 'active', awareness_hz: 0.0167, interrupt_threshold: 'medium' },
    discretion: undefined,
    pane_kind: 'activity',
    max_tool_rounds: 10,
  } as unknown as LoadedSpecialist;
}

function pane_deps(env: Env, with_tracker = true): PaneDeps {
  return {
    vault_root: env.vault_root,
    memory: env.memory,
    llm: env.llm,
    tool_registry: env.registry,
    ...(with_tracker ? { workout_tracker: env.tracker } : {}),
  };
}

/**
 * Mount the REAL /api/workout router with an injected user so the smoke
 * exercises the production warm-write + rehydrate path, not a hand-rolled
 * INSERT. The pane's restart-survival depends on the route warming the
 * workout_sessions row on every heartbeat — driving the actual route is
 * the faithful test.
 */
function make_workout_app(env: Env, tracker: WorkoutSessionTracker = env.tracker): Hono {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('user', { id: 'jasper' } as never);
    await next();
  });
  app.route(
    '/api/workout',
    create_workout_router({
      db: env.db,
      vault_root: env.vault_root,
      memory: env.memory,
      events: new AppEventBus(),
      tracker,
    }),
  );
  return app;
}

async function post_workout(app: Hono, body: unknown): Promise<Response> {
  return app.fetch(
    new Request('http://localhost/api/workout', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

function days_ago_iso(days: number, hour = 18): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  d.setUTCHours(hour, 0, 0, 0);
  return d.toISOString();
}

function seed_completed_sessions(db: import('bun:sqlite').Database): void {
  const stmt = db.prepare(
    `INSERT INTO workout_sessions
       (session_id, user_id, workout_type, started_at, ended_at,
        total_active_kcal, total_duration_s, total_distance_m,
        avg_hr, max_hr, hr_zone_minutes_json, status, ride_name, elevation_gain_m)
     VALUES (@sid, 'jasper', @wt, @start, @end, @kcal, @dur, @dist,
             @avg, @max, @zones, 'completed', @name, @elev)`,
  );
  // Six completed sessions across the last 7 days.
  const sessions = [
    { sid: 's_1', wt: 'cycling',   day: 1, dur: 60 * 60,  kcal: 720, dist: 22000, avg: 142, max: 168, zones: { z1: 5,  z2: 25, z3: 20, z4: 8, z5: 2 } },
    { sid: 's_2', wt: 'cycling',   day: 3, dur: 75 * 60,  kcal: 890, dist: 28000, avg: 148, max: 174, zones: { z1: 6,  z2: 28, z3: 26, z4: 12, z5: 3 } },
    { sid: 's_3', wt: 'running',   day: 5, dur: 30 * 60,  kcal: 320, dist: 5000,  avg: 156, max: 178, zones: { z1: 3,  z2: 10, z3: 14, z4: 3,  z5: 0 } },
    { sid: 's_4', wt: 'strength',  day: 6, dur: 45 * 60,  kcal: 410, dist: 0,     avg: 122, max: 160, zones: { z1: 20, z2: 15, z3: 8,  z4: 2,  z5: 0 } },
    // day 6, not 7: a day-7 18:00 UTC seed sits ON the 7-day boundary
    // and drops out of the window when the smoke runs after 18:00 UTC
    // (time-of-day flake, surfaced 2026-06-11).
    { sid: 's_5', wt: 'yoga',      day: 6, dur: 50 * 60,  kcal: 230, dist: 0,     avg: 88,  max: 110, zones: { z1: 45, z2: 5,  z3: 0,  z4: 0,  z5: 0 } },
    { sid: 's_6', wt: 'cycling',   day: 0, dur: 40 * 60,  kcal: 480, dist: 14000, avg: 140, max: 170, zones: { z1: 4,  z2: 18, z3: 14, z4: 4,  z5: 0 } },
  ];
  for (const s of sessions) {
    stmt.run({
      '@sid': s.sid,
      '@wt': s.wt,
      '@start': days_ago_iso(s.day, 18),
      '@end': days_ago_iso(s.day, 19),
      '@kcal': s.kcal,
      '@dur': s.dur,
      '@dist': s.dist,
      '@avg': s.avg,
      '@max': s.max,
      '@zones': JSON.stringify(s.zones),
      '@name': null,
      '@elev': null,
    });
  }
  // One prior-week session so the delta arm is non-trivial.
  stmt.run({
    '@sid': 's_prev_1',
    '@wt': 'cycling',
    '@start': days_ago_iso(10, 18),
    '@end': days_ago_iso(10, 19),
    '@kcal': 600,
    '@dur': 45 * 60,
    '@dist': 17000,
    '@avg': 140,
    '@max': 165,
    '@zones': JSON.stringify({ z1: 3, z2: 22, z3: 14, z4: 5, z5: 1 }),
    '@name': null,
    '@elev': null,
  });
  // One OLD named ride (outside every weekly/30d window) — drives the
  // eBike tab's all-history records + lifetime line + named recent
  // rides without touching the This Week numbers.
  stmt.run({
    '@sid': 's_old_named',
    '@wt': 'cycling',
    '@start': days_ago_iso(45, 18),
    '@end': days_ago_iso(45, 20),
    '@kcal': 995,
    '@dur': 106 * 60,
    '@dist': 36900,
    '@avg': 139,
    '@max': 171,
    '@zones': JSON.stringify({ z1: 10, z2: 55, z3: 30, z4: 9, z5: 2 }),
    '@name': 'Ridgeline Loop',
    '@elev': 320,
  });
}

function seed_pr_shelves(vault_root: string): void {
  const dir = resolve(vault_root, 'users/jasper/astrid/records');
  mkdirSync(dir, { recursive: true });
  const cycling = [
    '---',
    'type: trainer_pr_shelf',
    'workout_type: cycling',
    'user_id: jasper',
    'updated: 2026-05-26T19:00:00Z',
    '---',
    '',
    '# cycling — Personal Records',
    '',
    '## Longest session',
    '- **78 min** on 2026-05-26',
    '- prior: 65 min on 2026-04-22',
    '',
    '## Highest active calories',
    '- **920 kcal** on 2026-05-26',
    '- prior: 810 kcal on 2026-04-22',
    '',
    '## Longest distance',
    '- **24.30 km** on 2026-05-26',
    '- prior: 19.80 km on 2026-04-22',
    '',
  ].join('\n');
  writeFileSync(resolve(dir, 'cycling.md'), cycling, 'utf8');

  const running = [
    '---',
    'type: trainer_pr_shelf',
    'workout_type: running',
    'user_id: jasper',
    'updated: 2026-05-24T19:00:00Z',
    '---',
    '',
    '# running — Personal Records',
    '',
    '## Longest distance',
    '- **5.00 km** on 2026-05-24',
    '- prior: 4.20 km on 2026-04-30',
    '',
    '## Highest active calories',
    '- **320 kcal** on 2026-05-24',
    '- prior: 280 kcal on 2026-04-30',
    '',
  ].join('\n');
  writeFileSync(resolve(dir, 'running.md'), running, 'utf8');
}

function seed_activity_ring(env: Env): void {
  // Latest daily Move-ring snapshot — a healthkit sensor packet whose
  // payload JSON carries the raw kcal the office Energy block reads.
  const rel = 'Users/jasper/sensors/healthkit/2026-ring-latest.json';
  const abs = resolve(env.vault_root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(
    abs,
    JSON.stringify({
      sample_type: 'activity_ring',
      ts_start: days_ago_iso(0, 0),
      ts_end: days_ago_iso(0, 12),
      value: {
        move_kcal: 430,
        move_goal_kcal: 600,
        move_percent: 72,
        exercise_min: 22,
        exercise_goal_min: 30,
        stand_hours: 9,
        stand_goal_hours: 12,
        stand_percent: 75,
      },
      source_device: 'iphone',
    }),
    'utf8',
  );
  env.db
    .prepare(
      `INSERT INTO sensor_packets (id, user_id, device_id, signal, captured_at, received_at, payload_path)
       VALUES ('pk_ring_1', 'jasper', NULL, 'healthkit', @cap, @rec, @path)`,
    )
    .run({ '@cap': days_ago_iso(0, 12), '@rec': days_ago_iso(0, 12), '@path': rel });
}

function seed_observations(vault_root: string): void {
  const dir = resolve(vault_root, 'users/jasper/astrid');
  mkdirSync(dir, { recursive: true });
  const md = [
    '# Observations',
    '',
    '- Rides hardest Tuesdays after work; tends to under-fuel beforehand — 2026-05-26',
    '- Strength volume drops in weeks with two long rides — 2026-05-19',
    '- Pushed back on PR-chasing during deload week — respect the call — 2026-05-12',
    '',
  ].join('\n');
  writeFileSync(resolve(dir, 'observations.md'), md, 'utf8');
}

/** Standby is tabbed (2026-06-11) — flatten through tabs so the
 *  per-block assertions keep reading naturally. Tab order puts the
 *  This Week blocks first, so "first block of type X" semantics hold
 *  for the original checks. */
function flatten_blocks(doc: PaneDocument): PaneBlock[] {
  const out: PaneBlock[] = [];
  for (const b of doc.blocks) {
    out.push(b);
    if (b.type === 'tabs') {
      for (const tab of b.tabs) out.push(...tab.blocks);
    }
  }
  return out;
}

function block_by_type<T extends PaneBlock['type']>(doc: PaneDocument, t: T): Extract<PaneBlock, { type: T }> | null {
  for (const b of flatten_blocks(doc)) {
    if (b.type === t) return b as Extract<PaneBlock, { type: T }>;
  }
  return null;
}

function blocks_by_type<T extends PaneBlock['type']>(doc: PaneDocument, t: T): Array<Extract<PaneBlock, { type: T }>> {
  return flatten_blocks(doc).filter((b) => b.type === t) as Array<Extract<PaneBlock, { type: T }>>;
}

function tab_blocks(doc: PaneDocument, tab_id: string): PaneBlock[] {
  const tabs = doc.blocks.find((b) => b.type === 'tabs');
  if (!tabs || tabs.type !== 'tabs') return [];
  return tabs.tabs.find((t) => t.id === tab_id)?.blocks ?? [];
}

async function main(): Promise<void> {
  let passed = 0;
  let failed = 0;
  const ok = (msg: string): void => {
    console.log(`  ✓ ${msg}`);
    passed++;
  };
  const fail = (msg: string, detail?: unknown): void => {
    console.log(`  ✗ ${msg}`, detail ?? '');
    failed++;
  };

  // ── STANDBY mode ─────────────────────────────────────────────────────
  {
    console.log('\n── STANDBY mode (no active workout) ────────────────────');
    const env = init_env();
    try {
      seed_completed_sessions(env.db);
      seed_pr_shelves(env.vault_root);
      seed_observations(env.vault_root);
      seed_activity_ring(env);
      const doc = await compose_pane(make_spec(), env.db, 'jasper', pane_deps(env));
      if (!doc) {
        fail('standby pane composed null');
        return;
      }
      doc.pane_kind === 'activity' ? ok('pane_kind=activity') : fail('pane_kind', doc.pane_kind);
      doc.title === 'Activity' ? ok('title="Activity"') : fail('title', doc.title);
      doc.subtitle === 'Training room' ? ok('subtitle="Training room"') : fail('subtitle', doc.subtitle);

      const hero = block_by_type(doc, 'hero_metric');
      if (!hero) {
        fail('no hero_metric block');
      } else {
        Number(hero.value) > 0 ? ok(`hero shows training minutes (${hero.value})`) : fail('hero value zero', hero.value);
        /(7 days)/.test(hero.label) ? ok('hero label mentions 7 days') : fail('hero label', hero.label);
        hero.delta ? ok(`hero carries delta (${hero.delta})`) : fail('hero delta missing');
      }

      const load = block_by_type(doc, 'load_chart');
      if (!load) {
        fail('no load_chart block');
      } else {
        load.points.length === 7 ? ok('load_chart has 7 points (one per day, pre-filled)') : fail('load_chart points', load.points.length);
        load.kind === 'bars' ? ok('load_chart kind=bars') : fail('load_chart kind', load.kind);
        load.points.every((p) => typeof p.y === 'number') ? ok('all load_chart y-values numeric') : fail('y values', load.points);
        load.points.some((p) => p.y > 0) ? ok('at least one day shows training minutes') : fail('all-zero load chart');
      }

      const strip = block_by_type(doc, 'stacked_strip');
      if (!strip) {
        fail('no stacked_strip block (zone aggregate)');
      } else {
        strip.segments.length === 5 ? ok('stacked_strip has 5 zone segments') : fail('strip segments', strip.segments.length);
        strip.segments.every((s) => ['z1', 'z2', 'z3', 'z4', 'z5'].includes(s.hue ?? '')) ? ok('every segment carries z1–z5 hue token') : fail('hue tokens', strip.segments);
        strip.segments.some((s) => s.value > 0) ? ok('at least one zone has non-zero minutes') : fail('all-zero zones');
      }

      const lists = blocks_by_type(doc, 'list');
      lists.length >= 2 ? ok(`pane has ≥2 list blocks (PRs + recent sessions); saw ${lists.length}`) : fail('list block count', lists.length);
      const pr_list = lists.find((l) => l.title?.includes('Personal records'));
      if (!pr_list) {
        fail('no Personal records list');
      } else {
        pr_list.items.length >= 2 ? ok(`PR list has ${pr_list.items.length} entries (cycling + running shelves)`) : fail('PR items', pr_list.items.length);
        pr_list.items.some((i) => i.title === 'cycling') ? ok('cycling PR row present') : fail('cycling PR missing');
        pr_list.items.some((i) => i.title === 'running') ? ok('running PR row present') : fail('running PR missing');
        // Freshest metric per shelf was longest_seconds for cycling (78 min) on 2026-05-26.
        pr_list.items.find((i) => i.title === 'cycling')?.subtitle?.includes('78 min') ? ok('cycling subtitle picks the freshest metric (78 min)') : fail('cycling subtitle wrong', pr_list.items.find((i) => i.title === 'cycling')?.subtitle);
      }
      const recent_list = lists.find((l) => l.title === 'Recent sessions');
      if (!recent_list) {
        fail('no Recent sessions list');
      } else {
        recent_list.items.length === 5 ? ok('recent sessions capped at 5') : fail('recent count', recent_list.items.length);
        recent_list.items[0]?.title?.includes('cycling') ? ok('newest recent is today\'s cycling') : fail('recent ordering', recent_list.items[0]);
      }

      const energy_list = lists.find((l) => l.title === 'Energy');
      if (!energy_list) {
        fail('no Energy list block (calorie surface)');
      } else {
        // Move ring: 430 kcal / 600 goal · 72% from the seeded ring packet.
        energy_list.items.some(
          (i) => i.subtitle?.includes('Move ring') && i.title.includes('430 kcal') && i.title.includes('600 goal'),
        )
          ? ok('Move-ring energy row shows kcal + goal')
          : fail('move-ring row', energy_list.items);
        // Week active-calorie total: 720+890+320+410+230+480 = 3050.
        energy_list.items.some((i) => i.title.includes('3050 kcal') && i.subtitle?.includes('workouts this week'))
          ? ok('week active-calorie total row (3050 kcal)')
          : fail('week kcal row', energy_list.items);
      }

      const tail = block_by_type(doc, 'text');
      if (!tail) {
        fail('no observations text block');
      } else {
        tail.body_md.includes('Tuesdays after work') ? ok('observations tail renders most-recent bullet') : fail('observations content', tail.body_md);
      }

      // ── Tabs: eBike + Training Log (2026-06-11) ────────────────────
      const tabs = doc.blocks.find((b) => b.type === 'tabs');
      if (!tabs || tabs.type !== 'tabs') {
        fail('standby pane is not tabbed');
      } else {
        tabs.tabs.map((t) => t.label).join('|') === 'This Week|eBike|Training Log'
          ? ok('three tabs: This Week | eBike | Training Log')
          : fail('tab labels', tabs.tabs.map((t) => t.label));
      }

      const ebike = tab_blocks(doc, 'ebike');
      const ebike_hero = ebike.find((b) => b.type === 'hero_metric');
      if (!ebike_hero || ebike_hero.type !== 'hero_metric') {
        fail('no eBike hero');
      } else {
        // 30-day window holds the three in-week rides (22+28+14 km) +
        // the prior-week ride (17 km) = 81 km = 50.3 mi; the 45-day-old
        // named ride stays out of the hero.
        ebike_hero.value === '50.3' ? ok(`eBike hero shows 30-day miles (${ebike_hero.value})`) : fail('eBike hero value', ebike_hero.value);
        ebike_hero.label.includes('mi ridden') && ebike_hero.label.includes('30 days') ? ok('eBike hero label is mi · 30-day window') : fail('eBike hero label', ebike_hero.label);
      }
      const ebike_lists = ebike.filter((b) => b.type === 'list');
      const recent_rides = ebike_lists.find((l) => l.type === 'list' && l.title === 'Recent rides');
      if (!recent_rides || recent_rides.type !== 'list') {
        fail('no Recent rides list on eBike tab');
      } else {
        recent_rides.items.length === 5 ? ok('eBike recent rides lists all 5 cycling sessions') : fail('recent rides count', recent_rides.items.length);
        recent_rides.items.some((i) => i.title.includes('Ridgeline Loop')) ? ok('named ride surfaces by name') : fail('named ride missing', recent_rides.items.map((i) => i.title));
        recent_rides.items.some((i) => i.subtitle?.includes('1050 ft climbed')) ? ok('ride subtitle carries elevation in feet') : fail('elevation missing', recent_rides.items.map((i) => i.subtitle));
        recent_rides.items.every((i) => i.deep_link?.startsWith('hearth://workout/session/')) ? ok('recent rides deep-link to the ride detail') : fail('recent ride deep_link missing', recent_rides.items.map((i) => i.deep_link));
      }
      const records = ebike_lists.find((l) => l.type === 'list' && l.title === 'Ride records');
      if (!records || records.type !== 'list') {
        fail('no Ride records list on eBike tab');
      } else {
        records.items.some((i) => i.title.includes('22.9 mi') && i.title.includes('Ridgeline Loop'))
          ? ok('farthest-ride record names the old ride (22.9 mi)')
          : fail('farthest record', records.items.map((i) => i.title));
        records.items.some((i) => i.title.includes('106 min')) ? ok('longest-ride record (106 min)') : fail('longest record', records.items.map((i) => i.title));
        records.items.some((i) => i.title.includes('1050 ft')) ? ok('biggest-climb record (1050 ft)') : fail('climb record', records.items.map((i) => i.title));
      }
      const lifetime = ebike.find((b) => b.type === 'text');
      lifetime && lifetime.type === 'text' && lifetime.body_md.includes('5 rides')
        ? ok('lifetime line counts all 5 rides on file')
        : fail('lifetime line', lifetime && lifetime.type === 'text' ? lifetime.body_md : lifetime);
      const ride_log_link = ebike.find((b) => b.type === 'link');
      ride_log_link && ride_log_link.type === 'link' && ride_log_link.deep_link === '/app/rides'
        ? ok('eBike tab links to the Ride Log')
        : fail('ride log link', ride_log_link);

      const log = tab_blocks(doc, 'log');
      const log_list = log.find((b) => b.type === 'list');
      if (!log_list || log_list.type !== 'list') {
        fail('no Training Log list');
      } else {
        log_list.items.length === 4 ? ok('Training Log has one row per exercise (4 types)') : fail('training log rows', log_list.items.map((i) => i.title));
        log_list.items[0]?.title === 'cycling · 5 sessions' ? ok('cycling rolls up all history (5 sessions, most first)') : fail('cycling rollup', log_list.items[0]?.title);
        log_list.items.find((i) => i.title.startsWith('cycling'))?.subtitle?.includes('longest 106 min')
          ? ok('per-exercise longest comes from full history')
          : fail('cycling longest', log_list.items.find((i) => i.title.startsWith('cycling'))?.subtitle);
        log_list.items.some((i) => i.title === 'yoga · 1 session') ? ok('singular session label') : fail('yoga row', log_list.items.map((i) => i.title));
      }
      const log_footer = log.find((b) => b.type === 'text');
      log_footer && log_footer.type === 'text' && log_footer.body_md.includes('8 sessions logged')
        ? ok('Training Log footer totals all 8 sessions')
        : fail('log footer', log_footer && log_footer.type === 'text' ? log_footer.body_md : log_footer);
    } finally {
      env.cleanup();
    }
  }

  // ── LIVE mode (driven through the REAL route) ───────────────────────
  {
    console.log('\n── LIVE mode (active workout in flight, via /api/workout) ──');
    const env = init_env();
    try {
      const app = make_workout_app(env);
      const started_at = new Date(Date.now() - 18 * 60 * 1000).toISOString();
      const start_res = await post_workout(app, {
        session_id: 's_live_1',
        kind: 'start',
        captured_at: started_at,
        payload: { workout_type: 'cycling' },
      });
      start_res.status === 200 ? ok('start packet accepted (200)') : fail('start status', start_res.status);

      const hb_res = await post_workout(app, {
        session_id: 's_live_1',
        kind: 'heartbeat',
        captured_at: new Date().toISOString(),
        payload: {
          elapsed_s: 18 * 60 + 32,
          active_kcal: 215,
          distance_m: 7200,
          current_hr: 152,
          current_hr_zone: 3,
          hr_zone_minutes_so_far: { z1: 1, z2: 6, z3: 9, z4: 2, z5: 0 },
        },
      });
      hb_res.status === 200 ? ok('heartbeat accepted (200)') : fail('heartbeat status', hb_res.status);

      // query_active_workout reads the WARM row the route just wrote.
      const snap = env.memory.query_active_workout('jasper');
      if (!snap) {
        fail('query_active_workout returned null after heartbeat');
      } else {
        snap.warm ? ok('query_active_workout: warm=true after heartbeat') : fail('snap not warm', snap);
        snap.session_id === 's_live_1' ? ok('query_active_workout: correct session_id') : fail('snap session', snap.session_id);
        snap.elapsed_s === 18 * 60 + 32 ? ok('query_active_workout: elapsed persisted (1112s)') : fail('snap elapsed', snap.elapsed_s);
        snap.current_hr === 152 ? ok('query_active_workout: current_hr persisted (152)') : fail('snap hr', snap.current_hr);
        snap.active_kcal === 215 ? ok('query_active_workout: active_kcal persisted (215)') : fail('snap kcal', snap.active_kcal);
        snap.hr_zone_minutes.z3 === 9 ? ok('query_active_workout: rolling z3 persisted (9)') : fail('snap z3', snap.hr_zone_minutes);
        snap.last_packet_at != null ? ok('query_active_workout: last_packet_at stamped') : fail('snap last_packet_at', snap.last_packet_at);
      }

      // RESTART-SURVIVES: compose the pane with NO tracker — the in-memory
      // tracker is what a restart wipes. The pane must still render live
      // readings from the warm row alone.
      const doc = await compose_pane(make_spec(), env.db, 'jasper', pane_deps(env, /* with_tracker */ false));
      if (!doc) {
        fail('live pane composed null (no tracker)');
        return;
      }
      doc.pane_kind === 'activity' ? ok('pane_kind=activity (restart, no tracker)') : fail('pane_kind', doc.pane_kind);
      doc.subtitle === 'Live · cycling' ? ok('subtitle reflects live mode (restart survives)') : fail('subtitle', doc.subtitle);

      const hero = block_by_type(doc, 'hero_metric');
      if (!hero) {
        fail('no hero block');
      } else {
        hero.value === '18:32' ? ok(`hero shows persisted MM:SS elapsed (${hero.value})`) : fail('hero elapsed', hero.value);
        hero.label.includes('Zone 3') ? ok('hero label carries persisted current zone') : fail('hero label', hero.label);
      }

      const strip = block_by_type(doc, 'stacked_strip');
      if (!strip) {
        fail('no zone strip');
      } else {
        strip.title?.includes('this session') ? ok('strip title says "this session"') : fail('strip title', strip.title);
        strip.segments.find((s) => s.hue === 'z3')?.value === 9 ? ok('z3 segment carries persisted 9 minutes') : fail('z3 minutes', strip.segments);
      }

      const lists = blocks_by_type(doc, 'list');
      const live_readings = lists.find((l) => l.title === 'Live readings');
      if (!live_readings) {
        fail('no Live readings list');
      } else {
        live_readings.items.some((i) => i.title.includes('152 bpm')) ? ok('current HR row renders from warm row') : fail('HR row', live_readings.items);
        live_readings.items.some((i) => i.title.includes('215 kcal')) ? ok('kcal row renders from warm row') : fail('kcal row', live_readings.items);
        live_readings.items.some((i) => i.title.includes('4.5 mi')) ? ok('distance row renders in miles from warm row') : fail('distance row', live_readings.items);
      }

      const link = doc.blocks.find((b) => b.type === 'link') as Extract<PaneBlock, { type: 'link' }> | undefined;
      link?.deep_link === 'hearth://astrid/cues/silence' ? ok('silence-cues deep link present') : fail('deep link', link?.deep_link);

      // REHYDRATE: simulate the orchestrator restart — a FRESH tracker
      // (empty) receives a heartbeat for the still-active session. The
      // route must re-open it from the warm row so live coaching resumes.
      const fresh_tracker = new WorkoutSessionTracker();
      fresh_tracker.get('s_live_1') == null ? ok('fresh tracker starts cold (no session)') : fail('fresh tracker not cold');
      const app2 = make_workout_app(env, fresh_tracker);
      const hb2 = await post_workout(app2, {
        session_id: 's_live_1',
        kind: 'heartbeat',
        captured_at: new Date().toISOString(),
        payload: { elapsed_s: 19 * 60, active_kcal: 230, current_hr: 150, current_hr_zone: 3 },
      });
      hb2.status === 200 ? ok('rehydrate heartbeat accepted (200)') : fail('rehydrate status', hb2.status);
      const rehydrated = fresh_tracker.get('s_live_1');
      rehydrated != null ? ok('rehydrate: fresh tracker re-opened the session from the warm row') : fail('tracker not rehydrated');
      rehydrated?.elapsed_s === 19 * 60 ? ok('rehydrate: tracker carries the new heartbeat values') : fail('rehydrate elapsed', rehydrated?.elapsed_s);
    } finally {
      env.cleanup();
    }
  }

  // ── LIVE-stub mode (start landed, no heartbeat yet → warm=false) ─────
  {
    console.log('\n── LIVE-stub mode (orchestrator restart edge case) ─────');
    const env = init_env();
    try {
      env.db.prepare(
        `INSERT INTO workout_sessions (session_id, user_id, workout_type, started_at, status)
         VALUES ('s_orphan', 'jasper', 'running', @start, 'active')`,
      ).run({ '@start': new Date(Date.now() - 10 * 60 * 1000).toISOString() });
      // Notice: tracker.open() NOT called — simulates the restart case.

      const doc = await compose_pane(make_spec(), env.db, 'jasper', pane_deps(env));
      if (!doc) {
        fail('stub pane composed null');
        return;
      }
      doc.subtitle === 'Live · running' ? ok('stub still flags live') : fail('stub subtitle', doc.subtitle);
      const hero = block_by_type(doc, 'hero_metric');
      hero?.label.includes('session in flight') ? ok('stub hero label notes session in flight') : fail('stub label', hero?.label);
      const tail = block_by_type(doc, 'text');
      tail?.body_md.includes('reconnect') ? ok('stub renders reconnect notice') : fail('stub notice', tail?.body_md);
    } finally {
      env.cleanup();
    }
  }

  // ── empty-state STANDBY (no sessions, no shelves) ───────────────────
  {
    console.log('\n── empty-state STANDBY (cold start) ────────────────────');
    const env = init_env();
    try {
      const doc = await compose_pane(make_spec(), env.db, 'jasper', pane_deps(env));
      if (!doc) {
        fail('empty pane composed null');
        return;
      }
      const hero = block_by_type(doc, 'hero_metric');
      hero?.value === '0' ? ok('hero shows zero minutes') : fail('zero hero', hero?.value);
      hero?.delta_kind === 'neutral' ? ok('zero week → neutral delta') : fail('neutral delta', hero?.delta_kind);
      const lists = blocks_by_type(doc, 'list');
      lists.some((l) => l.title === 'Personal records · top 3' && l.items.length === 1 && l.items[0]?.subtitle?.includes('No PRs')) ? ok('empty PR list renders placeholder') : fail('PR placeholder', lists);
      lists.some((l) => l.title === 'Recent sessions' && l.items.length === 1 && l.items[0]?.subtitle?.includes('No completed sessions')) ? ok('empty recent list renders placeholder') : fail('recent placeholder', lists);
      const week = tab_blocks(doc, 'week');
      week.some((b) => b.type === 'text')
        ? fail('stray observations block in This Week', week.find((b) => b.type === 'text'))
        : ok('no observations block when file absent');
      const ebike_empty = tab_blocks(doc, 'ebike').find((b) => b.type === 'text');
      ebike_empty && ebike_empty.type === 'text' && ebike_empty.body_md.includes('No rides on file')
        ? ok('empty eBike tab renders the no-rides state')
        : fail('eBike empty state', ebike_empty);
      const log_empty = tab_blocks(doc, 'log').find((b) => b.type === 'text');
      log_empty && log_empty.type === 'text' && log_empty.body_md.includes('Nothing logged yet')
        ? ok('empty Training Log renders the nothing-logged state')
        : fail('Training Log empty state', log_empty);
    } finally {
      env.cleanup();
    }
  }

  // Vault dir cleanup safety (sanity check).
  if (!existsSync(resolve(tmpdir()))) {
    fail('tmpdir gone — environmental, not a smoke regression');
  }

  console.log(`\n── result: ${passed} passed, ${failed} failed ────────`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error('smoke crashed:', err);
  process.exit(1);
});
