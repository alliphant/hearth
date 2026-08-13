/**
 * Smoke for the `dom_max` background-job schedule gate (2026-06-26).
 *
 * `dom_max` restricts a background job to the first N days of the month. Combined
 * with `dow`, it expresses "the first <weekday> of the month" — the monthly
 * emergency-alert drill is `dow:["mon"], dom_max:7` (a Monday on day ≤7 = the
 * FIRST Monday). Self-contained: schema acceptance + the date semantic the loop
 * matcher (`now.getDate() > job.dom_max`) encodes. No orchestrator.
 */
import { BackgroundJobSchema } from '../src/core/specialist';

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) { console.log(`  ✓ ${name}`); passed++; }
  else { console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); failed++; }
}

// ── schema acceptance ────────────────────────────────────────────────────────
console.log('→ BackgroundJobSchema accepts the monthly-drill shape');
{
  const drill = {
    name: 'monthly_emergency_drill',
    at: '12:00',
    dow: ['mon'],
    dom_max: 7,
    tool: 'test_emergency_alert',
    input: { tone: 'critical' },
  };
  const r = BackgroundJobSchema.safeParse(drill);
  check('drill job (dow+dom_max+input) parses', r.success, r.success ? '' : JSON.stringify(r.error.issues));

  check('a job WITHOUT dom_max still parses (back-compat)',
    BackgroundJobSchema.safeParse({ name: 'x', at: '*:10', tool: 'y' }).success);
  check('dom_max:0 rejected (min 1)', !BackgroundJobSchema.safeParse({ name: 'x', at: '12:00', tool: 'y', dom_max: 0 }).success);
  check('dom_max:32 rejected (max 31)', !BackgroundJobSchema.safeParse({ name: 'x', at: '12:00', tool: 'y', dom_max: 32 }).success);
  check('dom_max non-int rejected', !BackgroundJobSchema.safeParse({ name: 'x', at: '12:00', tool: 'y', dom_max: 3.5 }).success);
  check('an unknown field is rejected (strict)', !BackgroundJobSchema.safeParse({ name: 'x', at: '12:00', tool: 'y', bogus: 1 }).success);
}

// ── the date semantic: dow:mon + dom_max:7 == EXACTLY the first Monday ───────
console.log('\n→ "dow:[mon], dom_max:7" selects exactly the first Monday of each month');
{
  // Mirror the loop matcher's gate over every day of a real year (local date math).
  const DOM_MAX = 7;
  const MON = 1; // JS getDay(): 0=Sun … 1=Mon
  const fires_on = (d: Date): boolean => d.getDay() === MON && d.getDate() <= DOM_MAX;

  const fired: Array<{ month: number; date: number }> = [];
  for (let month = 0; month < 12; month++) {
    for (let day = 1; day <= 31; day++) {
      const d = new Date(2026, month, day);
      if (d.getMonth() !== month) break; // rolled into next month
      if (fires_on(d)) fired.push({ month, date: d.getDate() });
    }
  }
  check('fires exactly 12 times in 2026 (once per month)', fired.length === 12, `count=${fired.length}`);
  check('every fire is on a Monday', fired.every((f) => new Date(2026, f.month, f.date).getDay() === MON));
  check('every fire is on day ≤ 7 (first week)', fired.every((f) => f.date <= 7));

  // It is genuinely the FIRST Monday: no earlier Monday exists that month.
  const all_first = fired.every((f) => {
    for (let day = 1; day < f.date; day++) {
      if (new Date(2026, f.month, day).getDay() === MON) return false; // an earlier Monday → not first
    }
    return true;
  });
  check('each selected day is the FIRST Monday (no earlier Monday in its month)', all_first);

  // And the gate excludes the SECOND Monday (date > 7) — no double-fire.
  const second_mondays = [];
  for (let month = 0; month < 12; month++) {
    let mondays = 0;
    for (let day = 1; day <= 31; day++) {
      const d = new Date(2026, month, day);
      if (d.getMonth() !== month) break;
      if (d.getDay() === MON) { mondays++; if (mondays === 2) { second_mondays.push(d); break; } }
    }
  }
  check('the SECOND Monday of each month does NOT fire (date > 7)', second_mondays.every((d) => !fires_on(d)));
}

console.log(`\n  passed=${passed}  failed=${failed}`);
if (failed > 0) { console.error('\n✗ BACKGROUND-SCHEDULE SMOKE FAILED'); process.exit(1); }
console.log('\n✓ BACKGROUND-SCHEDULE SMOKE OK');
