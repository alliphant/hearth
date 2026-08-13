/**
 * smoke:weather-retry — the Pirate Weather transient-5xx retry in the weather
 * connector (src/connectors/weather.ts).
 *
 * Pirate Weather (free tier) returns transient 5xx blips; one 500 used to make
 * Kate report "I couldn't consult the weather" mid-turn though the service is up
 * (observed 2026-06-16). pirate_fetch now retries a 5xx with short backoff. 4xx
 * (bad key/coords) and transport timeouts (status 0) are NOT retried — a retry on
 * a 10s timeout would double a voice turn's latency. Pure: the fetch transport is
 * injected via _test_set_transport; no network.
 */
import { _test_set_transport, _test_pirate_fetch } from '../src/connectors/weather';

process.env.PIRATE_WEATHER_API_KEY = process.env.PIRATE_WEATHER_API_KEY || 'test-key';
process.env.PIRATE_WEATHER_MAX_RETRIES = '2'; // 1 initial + 2 retries = up to 3 calls

let checks = 0;
let fails = 0;
function check(name: string, ok: boolean): void {
  checks++;
  if (!ok) fails++;
  console.log((ok ? '  ✓ ' : '  ✗ ') + name);
}

const OK_BODY = JSON.stringify({
  latitude: 0,
  longitude: 0,
  timezone: 'America/Denver',
  currently: { temperature: 70 },
});

/** Transport returning statuses[i] for call i (last status repeats), counting calls. */
function transport_seq(statuses: number[]) {
  let i = 0;
  const calls: number[] = [];
  const fn = async (_url: string) => {
    const status = statuses[Math.min(i, statuses.length - 1)]!;
    i++;
    calls.push(status);
    const ok = status >= 200 && status < 300;
    return { ok, status, body: ok ? OK_BODY : `<html>${status}</html>`, error: ok ? undefined : `HTTP ${status}` };
  };
  return { fn, calls: () => calls };
}

async function main(): Promise<void> {
  // 1. 500 then 200 → one retry succeeds
  {
    const t = transport_seq([500, 200]);
    _test_set_transport(t.fn);
    const r = await _test_pirate_fetch(10.001, 20.001);
    check('500→200: succeeds after one retry', r.ok === true);
    check('500→200: exactly 2 transport calls', t.calls().length === 2);
  }
  // 2. 500,500,200 → succeeds at the 3rd (1 initial + 2 retries)
  {
    const t = transport_seq([500, 500, 200]);
    _test_set_transport(t.fn);
    const r = await _test_pirate_fetch(10.002, 20.002);
    check('500,500,200: succeeds within the retry budget', r.ok === true);
    check('500,500,200: exactly 3 transport calls', t.calls().length === 3);
  }
  // 3. persistent 500 → gives up after the budget, surfaces HTTP 500
  {
    const t = transport_seq([500]);
    _test_set_transport(t.fn);
    const r = await _test_pirate_fetch(10.003, 20.003);
    check('persistent 500: ok:false', r.ok === false);
    check('persistent 500: tried 1 + 2 retries = 3 calls', t.calls().length === 3);
    check('persistent 500: surfaces HTTP 500', r.ok === false && r.status === 500);
  }
  // 4. 4xx → NOT retried (bad key/coords won't recover on retry)
  {
    const t = transport_seq([403]);
    _test_set_transport(t.fn);
    const r = await _test_pirate_fetch(10.004, 20.004);
    check('403: not retried (single call)', t.calls().length === 1);
    check('403: ok:false', r.ok === false);
  }
  // 5. transport timeout (status 0) → NOT retried (avoid doubling voice latency)
  {
    const t = transport_seq([0]);
    _test_set_transport(t.fn);
    const r = await _test_pirate_fetch(10.005, 20.005);
    check('status 0 (timeout): not retried (single call)', t.calls().length === 1);
    check('status 0: ok:false', r.ok === false);
  }
  // 6. first-call 200 → no retry
  {
    const t = transport_seq([200]);
    _test_set_transport(t.fn);
    const r = await _test_pirate_fetch(10.006, 20.006);
    check('200 first try: ok:true, single call', r.ok === true && t.calls().length === 1);
  }

  console.log('─'.repeat(50));
  if (fails) {
    console.log(`  ${fails}/${checks} FAILED`);
    process.exit(1);
  }
  console.log(`  ✓ smoke:weather-retry PASSED (${checks} checks)`);
}

void main();
