/**
 * Smoke for the programmatic read endpoints. Exercises the three routes
 * directly via fetch.
 *
 *   POST /memory/query_people    → 200 with { people: [] | [...] }
 *   POST /memory/retrieve        → 501 with { error }
 *   GET  /agents/concierge/brief → 404 (Concierge retired, 2.0 P0 2026-07-06)
 */

const ORCH_URL = process.env.HEARTH_URL ?? 'http://localhost:7700';

interface QueryPeopleResp {
  intent_id?: string;
  audit_id?: string;
  people?: unknown;
  error?: string;
}

interface StubResp {
  intent_id?: string;
  audit_id?: string;
  error?: string;
}

async function main() {
  // ── 1. /memory/query_people ──────────────────────────────────────────────
  console.log(`→ POST ${ORCH_URL}/memory/query_people`);
  const qp_res = await fetch(`${ORCH_URL}/memory/query_people`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  const qp_json = (await qp_res.json()) as QueryPeopleResp;
  console.log('  RESPONSE:', JSON.stringify(qp_json, null, 2));
  if (qp_res.status !== 200) {
    throw new Error(
      `query_people: expected 200, got ${qp_res.status} (${qp_json.error ?? ''})`,
    );
  }
  if (!Array.isArray(qp_json.people)) {
    throw new Error(
      `query_people: response.people is not an array: ${typeof qp_json.people}`,
    );
  }
  if (!qp_json.audit_id) {
    throw new Error(`query_people: response missing audit_id`);
  }
  console.log(
    `  ✓ 200, people is array (length=${qp_json.people.length}), audit_id=${qp_json.audit_id}`,
  );

  // ── 2. /memory/retrieve (501 stub) ───────────────────────────────────────
  console.log(`\n→ POST ${ORCH_URL}/memory/retrieve`);
  const r_res = await fetch(`${ORCH_URL}/memory/retrieve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: 'x' }),
  });
  const r_json = (await r_res.json()) as StubResp;
  console.log('  RESPONSE:', JSON.stringify(r_json, null, 2));
  if (r_res.status !== 501) {
    throw new Error(`retrieve: expected 501, got ${r_res.status}`);
  }
  if (!r_json.error || !/ingestor|embedding|Pass 4/i.test(r_json.error)) {
    throw new Error(
      `retrieve: expected error mentioning ingestor/embeddings/Pass 4, got: ${r_json.error}`,
    );
  }
  if (!r_json.audit_id) {
    throw new Error(`retrieve: response missing audit_id`);
  }
  console.log(`  ✓ 501, error="${r_json.error}", audit_id=${r_json.audit_id}`);

  // ── 3. /agents/concierge/brief — RETIRED (2.0 P0, 2026-07-06) ──────────
  // The fixed-persona Concierge agent is gone (Kate's deliberation briefs are
  // the product; upcoming_dates re-homed to Kate's pack). Assert the route
  // stays gone so a regression re-mounting it is caught.
  console.log(`\n→ GET ${ORCH_URL}/agents/concierge/brief?days=14 (expect 404)`);
  const b_res = await fetch(`${ORCH_URL}/agents/concierge/brief?days=14`);
  console.log('  RESPONSE STATUS:', b_res.status);
  if (b_res.status !== 404) {
    throw new Error(`brief: expected 404 (Concierge retired 2026-07-06), got ${b_res.status}`);
  }
  console.log(`  ✓ 404 (retired route stays gone)`);

  console.log(`\n✓ READ-ENDPOINTS SMOKE PASSED`);
}

main().catch((err: unknown) => {
  console.error(
    `\n✗ READ-ENDPOINTS SMOKE FAILED:`,
    err instanceof Error ? err.message : String(err),
  );
  process.exit(1);
});
