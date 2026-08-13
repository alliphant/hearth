/**
 * smoke:live-synthesis — the SELF-LIVE driver (event-driven re-distill).
 * Mock SynthesizeFn + a real AppEventBus + tiny debounce/interval windows;
 * asserts: debounce collapses a burst, distinct shelves each fire, the
 * capture_routed event nudges its destination shelves, the per-shelf rate
 * limit defers a too-soon re-fire, and the kill switch.
 */
import { AppEventBus } from '../src/app/events';
import { LiveSynthesisDriver } from '../src/core/live_synthesis';

let failures = 0;
function check(label: string, ok: boolean): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) failures++;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Mock distill — records each scoped run.
const runs: string[][] = [];
const synthesize = async (ids: string[]) => {
  runs.push(ids);
};

const DEBOUNCE = 15;
const MIN_INTERVAL = 120;

// ── debounce collapses a burst ──────────────────────────────────────────────
{
  const d = new LiveSynthesisDriver(synthesize, { debounce_ms: DEBOUNCE, min_interval_ms: MIN_INTERVAL });
  runs.length = 0;
  for (let i = 0; i < 5; i++) d.nudge('eleanor'); // a burst within the debounce window
  await sleep(DEBOUNCE + 20);
  check('debounce: a burst of nudges collapses to ONE distill', runs.length === 1 && runs[0]![0] === 'eleanor');
  d.stop();
}

// ── distinct shelves each fire ──────────────────────────────────────────────
{
  const d = new LiveSynthesisDriver(synthesize, { debounce_ms: DEBOUNCE, min_interval_ms: MIN_INTERVAL });
  runs.length = 0;
  d.nudge('vivian');
  d.nudge('anya');
  await sleep(DEBOUNCE + 20);
  check('distinct shelves each get a scoped distill', runs.length === 2 && runs.some((r) => r[0] === 'vivian') && runs.some((r) => r[0] === 'anya'));
  check('each distill is SCOPED to its one shelf', runs.every((r) => r.length === 1));
  d.stop();
}

// ── capture_routed event nudges destinations ────────────────────────────────
{
  const bus = new AppEventBus();
  const d = new LiveSynthesisDriver(synthesize, { debounce_ms: DEBOUNCE, min_interval_ms: MIN_INTERVAL });
  const off = d.attach(bus);
  runs.length = 0;
  bus.emit({ type: 'capture_routed', capture_id: 'c1', specialist_ids: ['maggie', 'iris'], confidence: 0.9, route_reason: 'x', clustered_with: [] });
  await sleep(DEBOUNCE + 20);
  check('capture_routed nudges every destination shelf', runs.length === 2 && runs.some((r) => r[0] === 'maggie') && runs.some((r) => r[0] === 'iris'));
  // a triage event (no destinations) is a no-op
  bus.emit({ type: 'capture_routed', capture_id: 'c2', specialist_ids: [], confidence: 0, route_reason: 'triage', clustered_with: [] });
  await sleep(DEBOUNCE + 20);
  check('a triage route (no destinations) fires nothing', runs.length === 2);
  off();
  d.stop();
}

// ── rate limit: a too-soon re-fire is deferred ──────────────────────────────
{
  const d = new LiveSynthesisDriver(synthesize, { debounce_ms: DEBOUNCE, min_interval_ms: MIN_INTERVAL });
  runs.length = 0;
  d.nudge('ruby');
  await sleep(DEBOUNCE + 20); // first run lands
  check('rate limit: first nudge runs', runs.length === 1);
  d.nudge('ruby'); // immediately again — within MIN_INTERVAL of the run
  await sleep(DEBOUNCE + 20);
  check('rate limit: a re-nudge within the interval is NOT run yet', runs.length === 1);
  await sleep(MIN_INTERVAL); // now past the interval
  check('rate limit: the deferred re-distill eventually runs', runs.length === 2);
  d.stop();
}

// ── kill switch ─────────────────────────────────────────────────────────────
{
  process.env.HEARTH_LIVE_SYNTHESIS = '0';
  const d = new LiveSynthesisDriver(synthesize, { debounce_ms: DEBOUNCE, min_interval_ms: MIN_INTERVAL });
  runs.length = 0;
  d.nudge('eleanor');
  await sleep(DEBOUNCE + 20);
  check('kill switch: nudge is a no-op', runs.length === 0);
  delete process.env.HEARTH_LIVE_SYNTHESIS;
  d.stop();
}

console.log(failures === 0 ? '\nsmoke:live-synthesis OK' : `\nsmoke:live-synthesis FAILED (${failures} check(s))`);
process.exit(failures === 0 ? 0 : 1);
