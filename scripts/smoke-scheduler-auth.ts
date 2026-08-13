/**
 * Smoke for the scheduler's outbound auth headers (2026-07-20).
 *
 * The folded scheduler fires against its OWN orchestrator, which is behind the
 * auth wall. It sent NO Authorization header, so every fire 401'd from
 * 2026-05-26 — the golden evals + promise-followup delivery ran dead ~55 days.
 * The fix attaches HEARTH_INTERNAL_BEARER (the DeviceStore-backed service
 * token). This locks the header policy: bearer present → Authorization: Bearer;
 * a task's own headers still override; bearer absent → no Authorization (and a
 * loud console.error, not a silent 401).
 */
import { build_scheduler_fire_headers } from '../src/core/scheduled_tasks_tick';

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) { console.log(`  ✓ ${name}`); passed++; }
  else { console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); failed++; }
}

console.log('→ bearer present → the fire authenticates');
{
  const h = build_scheduler_fire_headers('task_abc', undefined, 'svc-token-123');
  check('Authorization is Bearer <token>', h.Authorization === 'Bearer svc-token-123');
  check('User-Agent still set', h['User-Agent']?.startsWith('hearth-scheduler') === true);
  check('X-Scheduler-Fire carries the task id', h['X-Scheduler-Fire'] === 'task_abc');
}

console.log('→ a task can override the principal deliberately (ctx.headers win)');
{
  const h = build_scheduler_fire_headers(
    'task_abc',
    { Authorization: 'Bearer task-owned' },
    'svc-token-123',
  );
  check('task-supplied Authorization overrides the service bearer', h.Authorization === 'Bearer task-owned');
}

console.log('→ bearer ABSENT → no Authorization (fails visibly, not silently)');
{
  const orig = console.error;
  let warned = false;
  console.error = (...a: unknown[]) => { if (String(a[0]).includes('HEARTH_INTERNAL_BEARER')) warned = true; };
  const h = build_scheduler_fire_headers('task_abc', undefined, undefined);
  console.error = orig;
  check('no Authorization header is emitted', !('Authorization' in h));
  check('a missing-bearer misconfig is logged loudly', warned);
}

console.log(`\n  passed=${passed}  failed=${failed}`);
if (failed > 0) { console.error('\n✗ SCHEDULER-AUTH SMOKE FAILED'); process.exit(1); }
console.log('\n✓ SCHEDULER-AUTH SMOKE OK');
