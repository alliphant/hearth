/**
 * Smoke test for the connector tools. Each step skips with a clear warning
 * when its dependency isn't configured — the connectors hit external
 * services and v0 deployments may not have them all set up.
 *
 * Each connector is invoked DIRECTLY here (no HTTP route exposes them yet —
 * specialists invoke them inside a turn). We import the tool modules and
 * call their execute() directly with a stub ToolContext.
 */

import { web_fetch_clean } from '../src/connectors/firecrawl';
import { web_search } from '../src/connectors/searxng';
import { ha_get_state } from '../src/connectors/home_assistant';
import type { ToolContext } from '../src/core/tool';

const SEARXNG_BASE_URL = process.env.SEARXNG_BASE_URL ?? 'http://localhost:8888';
const FIRECRAWL_BASE_URL = process.env.FIRECRAWL_BASE_URL ?? 'http://localhost:3002';
const HA_TOKEN = process.env.HA_TOKEN ?? '';
const TEST_HA_ENTITY_ID = process.env.TEST_HA_ENTITY_ID ?? 'sun.sun';

// A minimal ToolContext stub — connectors don't touch memory/llm in these
// tests (they just hit the remote service). Cast to ToolContext to satisfy
// typing without wiring a real MemoryClient.
const ctx = {
  now: new Date(),
  intent_id: 'smoke-connectors',
} as unknown as ToolContext;

async function reachable(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(2_000) });
    return res.status < 500;
  } catch {
    return false;
  }
}

async function main() {
  let passed = 0;
  let skipped = 0;
  let failed = 0;

  console.log('→ SearXNG (web_search)');
  if (!(await reachable(SEARXNG_BASE_URL))) {
    console.warn(`  ⚠ SearXNG not reachable at ${SEARXNG_BASE_URL} — skipping`);
    skipped++;
  } else {
    const out = await web_search.execute({ query: 'test', max_results: 5 }, ctx);
    if (out.error || !Array.isArray(out.results)) {
      console.error(`  ✗ ${out.error ?? 'no results array'}`);
      failed++;
    } else {
      console.log(`  ✓ ${out.results.length} results returned`);
      passed++;
    }
  }

  console.log('\n→ Firecrawl (web_fetch_clean) — example.com');
  if (!(await reachable(FIRECRAWL_BASE_URL))) {
    console.warn(`  ⚠ Firecrawl not reachable at ${FIRECRAWL_BASE_URL} — skipping`);
    skipped++;
  } else {
    const out = await web_fetch_clean.execute({ url: 'https://example.com/' }, ctx);
    if (out.error || out.markdown.length === 0) {
      console.error(`  ✗ ${out.error ?? 'empty markdown'}`);
      failed++;
    } else {
      console.log(`  ✓ ${out.markdown.length} chars of markdown returned`);
      passed++;
    }
  }

  console.log('\n→ Home Assistant (ha_get_state)');
  if (!HA_TOKEN) {
    console.warn('  ⚠ HA_TOKEN not set — skipping');
    skipped++;
  } else {
    const out = await ha_get_state.execute({ entity_id: TEST_HA_ENTITY_ID }, ctx);
    if (out.error) {
      console.error(`  ✗ ${out.error}`);
      failed++;
    } else {
      console.log(`  ✓ state=${out.state} for ${TEST_HA_ENTITY_ID}`);
      passed++;
    }
  }

  // CalDAV (caldav_upcoming) was retired 2026-06-14 — the HA-CalDAV
  // calendar read path is gone. Calendar reads now come from the iOS
  // calendar snapshot (sensor_calendar_* tools); see smoke:ev for the
  // snapshot read coverage.

  console.log(`\n  passed=${passed}  skipped=${skipped}  failed=${failed}`);
  if (failed > 0) {
    console.error('\n✗ CONNECTORS SMOKE FAILED');
    process.exit(1);
  }
  console.log('\n✓ CONNECTORS SMOKE OK');
}

main().catch((err: unknown) => {
  console.error(
    `\n✗ CONNECTORS SMOKE CRASHED:`,
    err instanceof Error ? err.message : String(err),
  );
  process.exit(1);
});
