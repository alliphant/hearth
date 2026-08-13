/**
 * Self-contained smoke for Astrid's degenerate-session floors
 * (no orchestrator, no LLM, no push — temp vault only).
 *
 * Replays the 2026-06-10 incident class:
 *   - a phantom ~0-min session wrote a "0 min" cycling PR
 *     (2026-06-01), which read back as a 0-second duration baseline
 *     and made midpoint fire at elapsed=30s and final_push at ~60s
 *     during a real 106-minute ride;
 *   - a phantom walking session pushed "0-min walking done. 0 kcal."
 *
 * Asserts:
 *   1. update_shelf ignores degenerate sessions (write-side floor)
 *   2. shelf round-trips EXACT raw values via the frontmatter records
 *      block (the body display is rounded — "106 min" — and must no
 *      longer be the read path)
 *   3. legacy body-only shelves still parse (fallback)
 *   4. evaluate_triggers treats a sub-10-min duration baseline as
 *      absent — including the literal "0 min" legacy-shelf replay
 *   5. healthy baselines still fire midpoint / pr_in_reach
 *
 * Run: bun run smoke:astrid-floors
 */

import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import {
  update_shelf,
  read_shelf,
  is_meaningful_session,
  MIN_MEANINGFUL_SESSION_S,
} from '../src/specialists/astrid/pr_shelf';
import { evaluate_triggers } from '../src/specialists/astrid/live_throttle';
import type { ActiveWorkoutSession } from '../src/app/routes/workout';

let failures = 0;
let checks = 0;

function check(name: string, cond: boolean, detail?: string): void {
  checks += 1;
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failures += 1;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function make_session(overrides: Partial<ActiveWorkoutSession>): ActiveWorkoutSession {
  const now = Date.now();
  return {
    session_id: `S_${Math.random().toString(36).slice(2, 10)}`,
    user_id: 'jasper',
    workout_type: 'cycling',
    started_at: new Date(now - 30 * 1000).toISOString(),
    last_packet_at: new Date(now).toISOString(),
    elapsed_s: 30,
    active_kcal: 0,
    distance_m: null,
    current_hr: 142,
    current_hr_zone: 2,
    elevation_gain_m: null,
    paused: false,
    lat: null,
    lon: null,
    hr_zone_minutes: { z1: 0, z2: 0, z3: 0, z4: 0, z5: 0 },
    pushes_sent_at: [],
    prior_pr_metric: null,
    ...overrides,
  };
}

const vault = mkdtempSync(resolve(tmpdir(), 'astrid-floors-'));

try {
  console.log('— is_meaningful_session edges');
  check('0s is degenerate', !is_meaningful_session(0));
  check('NaN is degenerate', !is_meaningful_session(Number.NaN));
  check(`${MIN_MEANINGFUL_SESSION_S - 1}s is degenerate`, !is_meaningful_session(MIN_MEANINGFUL_SESSION_S - 1));
  check(`${MIN_MEANINGFUL_SESSION_S}s is meaningful`, is_meaningful_session(MIN_MEANINGFUL_SESSION_S));

  console.log('— write-side floor (update_shelf)');
  const phantom = update_shelf(vault, 'jasper', {
    workout_type: 'cycling',
    ended_at: '2026-06-01T04:12:13Z',
    duration_s: 20,
    active_kcal: 0,
    total_distance_m: null,
  });
  check('degenerate session breaks nothing', phantom.broken.length === 0);
  check(
    'degenerate session writes no shelf file',
    !existsSync(resolve(vault, 'users/jasper/astrid/records/cycling.md')),
  );
  check('degenerate session yields empty shelf', phantom.shelf.longest_seconds === null);

  console.log('— exact round-trip via frontmatter records');
  const ride = update_shelf(vault, 'jasper', {
    workout_type: 'cycling',
    ended_at: '2026-06-11T03:32:40Z',
    duration_s: 6324,
    active_kcal: 994.796083006442,
    total_distance_m: 36902.96767622624,
  });
  check('real session breaks 3 first-time records', ride.broken.length === 0 && ride.shelf.longest_seconds?.value === 6324);
  const reread = read_shelf(vault, 'jasper', 'cycling');
  check('longest_seconds round-trips exactly (6324, not "105 min" re-derived)', reread?.longest_seconds?.value === 6324);
  check('distance round-trips exactly', reread?.longest_distance_m?.value === 36902.96767622624);
  check('kcal round-trips exactly', reread?.highest_active_kcal?.value === 994.796083006442);

  const phantom_after = update_shelf(vault, 'jasper', {
    workout_type: 'cycling',
    ended_at: '2026-06-12T01:00:00Z',
    duration_s: 15,
    active_kcal: 1,
    total_distance_m: 10,
  });
  check('degenerate session after a real PR leaves the shelf untouched', phantom_after.shelf.longest_seconds?.value === 6324 && phantom_after.broken.length === 0);

  const bigger = update_shelf(vault, 'jasper', {
    workout_type: 'cycling',
    ended_at: '2026-06-13T01:00:00Z',
    duration_s: 7000,
    active_kcal: 1100,
    total_distance_m: 40000,
  });
  check('bigger real session breaks all 3', bigger.broken.length === 3);
  const reread2 = read_shelf(vault, 'jasper', 'cycling');
  check('prior_value carries the exact previous raw value', reread2?.longest_seconds?.prior_value === 6324);

  console.log('— legacy body-only shelf fallback');
  const legacy_dir = resolve(vault, 'users/jasper/astrid/records');
  mkdirSync(legacy_dir, { recursive: true });
  writeFileSync(
    resolve(legacy_dir, 'rowing.md'),
    [
      '---',
      'type: trainer_pr_shelf',
      'user_id: jasper',
      'workout_type: rowing',
      'updated: 2026-05-15T00:00:00Z',
      '---',
      '',
      '# rowing — Personal Records',
      '',
      '## Longest session',
      '- **78 min** on 2026-05-15',
      '- prior: 65 min on 2026-04-22',
      '',
      '## Highest active calories',
      '- **920 kcal** on 2026-05-15',
      '',
    ].join('\n'),
    'utf8',
  );
  const legacy = read_shelf(vault, 'jasper', 'rowing');
  check('legacy body parse still works (78 min → 4680s)', legacy?.longest_seconds?.value === 4680);
  check('legacy prior parses (65 min → 3900s)', legacy?.longest_seconds?.prior_value === 3900);
  check('legacy kcal parses', legacy?.highest_active_kcal?.value === 920);

  console.log('— baseline floor in evaluate_triggers');
  // The literal incident replay: a legacy shelf whose display says
  // "0 min" reads back as a 0-second baseline. Pre-fix this fired
  // midpoint at elapsed=30s.
  writeFileSync(
    resolve(legacy_dir, 'walking.md'),
    [
      '---',
      'type: trainer_pr_shelf',
      'user_id: jasper',
      'workout_type: walking',
      'updated: 2026-06-01T00:00:00Z',
      '---',
      '',
      '# walking — Personal Records',
      '',
      '## Longest session',
      '- **0 min** on 2026-06-01',
      '',
    ].join('\n'),
    'utf8',
  );
  const replay = evaluate_triggers(vault, make_session({ workout_type: 'walking', elapsed_s: 30 }));
  check('0-min legacy baseline fires NOTHING at elapsed=30s (the incident)', replay === null, `got ${JSON.stringify(replay?.trigger)}`);

  // A real-but-short prior (5 min) is also no pacing baseline.
  update_shelf(vault, 'jasper', {
    workout_type: 'erg',
    ended_at: '2026-06-09T01:00:00Z',
    duration_s: 300,
    active_kcal: 50,
    total_distance_m: 1200,
  });
  const short_mid = evaluate_triggers(vault, make_session({ workout_type: 'erg', elapsed_s: 200, active_kcal: 10 }));
  check('sub-10-min baseline: no midpoint at 200s', short_mid === null, `got ${JSON.stringify(short_mid?.trigger)}`);
  const short_final = evaluate_triggers(vault, make_session({ workout_type: 'erg', elapsed_s: 290, active_kcal: 10 }));
  check('sub-10-min baseline: no final_push at 290s', short_final === null, `got ${JSON.stringify(short_final?.trigger)}`);

  console.log('— healthy baselines still coach');
  const mid = evaluate_triggers(
    vault,
    make_session({ workout_type: 'cycling', elapsed_s: 3600, active_kcal: 500, started_at: new Date(Date.now() - 3600 * 1000).toISOString() }),
  );
  check('midpoint fires past half of a 7000s baseline', mid?.trigger === 'midpoint', `got ${JSON.stringify(mid?.trigger)}`);
  const pr = evaluate_triggers(
    vault,
    make_session({ workout_type: 'cycling', elapsed_s: 3000, active_kcal: 1000, started_at: new Date(Date.now() - 3000 * 1000).toISOString() }),
  );
  check('pr_in_reach fires at 91% of the kcal PR', pr?.trigger === 'pr_in_reach', `got ${JSON.stringify(pr?.trigger)}`);
} finally {
  rmSync(vault, { recursive: true, force: true });
}

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) {
  process.exit(1);
}
