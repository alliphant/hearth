/**
 * smoke:firecrawl-backpressure — the global Firecrawl scrape concurrency limiter
 * (2026-06-28, the Cordelia-nightly-burst root-cause fix).
 *
 * Two layers, no network beyond a throwaway fixture server:
 *   1. the Semaphore primitive (FIFO, idempotent release, depth/queued, with_slot)
 *   2. the integration: N concurrent web_fetch_clean calls against a fixture
 *      Firecrawl that counts in-flight requests NEVER exceed the cap (backpressure),
 *      and the kill switch (max=0) runs unbounded.
 */
// FIRECRAWL_BASE_URL is read at module load → set before importing the connector.
const PORT = 8799;
process.env.FIRECRAWL_BASE_URL = `http://localhost:${PORT}`;
process.env.HEARTH_FIRECRAWL_MAX_CONCURRENCY = '3';

import { Semaphore } from '../src/core/semaphore';
import type { ToolContext } from '../src/core/tool';
// DYNAMIC import: a static import hoists ABOVE the env assignment above, so the
// connector would load with the default base URL. Import it after env is set.
const { web_fetch_clean, firecrawl_limiter_stats, _reset_firecrawl_limiter } =
  await import('../src/connectors/firecrawl');

let failures = 0;
function check(label: string, ok: boolean): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) failures++;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ */
/* 1. Semaphore primitive                                              */
/* ------------------------------------------------------------------ */
{
  const s = new Semaphore(2);
  check('semaphore: max_slots reflects ctor', s.max_slots() === 2);
  const r1 = await s.acquire();
  const r2 = await s.acquire();
  check('semaphore: 2 slots taken, none queued', s.current_depth() === 2 && s.queued() === 0);
  const flag = { third_ran: false }; // object holder — CFA won't narrow across the closure
  const p3 = s.acquire().then((rel) => { flag.third_ran = true; return rel; });
  await sleep(5);
  check('semaphore: 3rd acquire parks (queued=1, not run)', flag.third_ran === false && s.queued() === 1);
  r1(); // free a slot → hands it to the waiter
  const r3 = await p3;
  check('semaphore: release hands the slot to the FIFO waiter', flag.third_ran === true);
  r1(); // idempotent double-release must NOT over-admit
  check('semaphore: double-release is idempotent', s.current_depth() === 2);
  r2(); r3();
  check('semaphore: all released → depth 0', s.current_depth() === 0);

  // with_slot releases on throw.
  const s1 = new Semaphore(1);
  await s1.with_slot(async () => {}).catch(() => {});
  try { await s1.with_slot(async () => { throw new Error('boom'); }); } catch { /* expected */ }
  check('semaphore: with_slot releases on throw (slot reusable)', s1.current_depth() === 0);
  const ranFlag = { ran: false };
  await s1.with_slot(async () => { ranFlag.ran = true; });
  check('semaphore: with_slot runs after a thrown holder', ranFlag.ran === true);
}

/* ------------------------------------------------------------------ */
/* 2. Integration — concurrent web_fetch_clean never exceeds the cap   */
/* ------------------------------------------------------------------ */
let active = 0;
let max_seen = 0;
const server = Bun.serve({
  port: PORT,
  async fetch() {
    active += 1;
    max_seen = Math.max(max_seen, active);
    await sleep(40); // hold the "scrape" open so concurrency is observable
    active -= 1;
    return new Response(
      JSON.stringify({ success: true, data: { markdown: '# ok\n\nbody text here', metadata: { title: 'T' } } }),
      { headers: { 'content-type': 'application/json' } },
    );
  },
});

const ctx = { } as unknown as ToolContext;
const fire = (n: number) =>
  Promise.all(Array.from({ length: n }, (_, i) => web_fetch_clean.execute({ url: `https://example.com/${i}` }, ctx)));

{
  _reset_firecrawl_limiter();
  max_seen = 0;
  const results = await fire(20);
  check('integration: all 20 concurrent fetches succeed', results.length === 20 && results.every((r) => r.markdown.length > 0 && !r.error));
  check('integration: in-flight NEVER exceeded the cap of 3', max_seen <= 3 && max_seen > 0);
  check('integration: limiter drains to idle afterward', firecrawl_limiter_stats().inflight === 0 && firecrawl_limiter_stats().max === 3);
}

/* ------------------------------------------------------------------ */
/* 3. Kill switch — max=0 runs unbounded                               */
/* ------------------------------------------------------------------ */
{
  process.env.HEARTH_FIRECRAWL_MAX_CONCURRENCY = '0';
  _reset_firecrawl_limiter();
  max_seen = 0;
  active = 0;
  const results = await fire(10);
  check('kill switch: all 10 succeed', results.length === 10 && results.every((r) => !r.error));
  check('kill switch: unbounded → more than 3 in flight at once', max_seen > 3);
  check('kill switch: stats report max=0 (off)', firecrawl_limiter_stats().max === 0);
  process.env.HEARTH_FIRECRAWL_MAX_CONCURRENCY = '3';
}

server.stop(true);
console.log('');
console.log(failures === 0 ? 'smoke:firecrawl-backpressure OK' : `smoke:firecrawl-backpressure FAILED (${failures} check(s))`);
process.exit(failures === 0 ? 0 : 1);
