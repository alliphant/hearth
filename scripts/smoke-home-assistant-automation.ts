/**
 * smoke-home-assistant-automation — offline contract checks for the
 * ha_get_automation connector (binding proposal 01KY5SZ3BQNKCS0Y4XZ6VT6BTZ).
 *
 * No live HA required: pins the tool's metadata (name / risk / capability
 * gate), the schema contract both modes share, and the fail-tagged
 * no-token behavior (HA_TOKEN unset must return a structured error, never
 * throw). Live-endpoint behavior is exercised by Kate's actual passes.
 *
 *   bun run scripts/smoke-home-assistant-automation.ts
 */
import assert from 'node:assert/strict';

// The module reads HA_TOKEN at import time — clear it BEFORE importing so
// the no-token path is what we exercise, regardless of the host env.
process.env.HA_TOKEN = '';
process.env.HA_BASE_URL = 'http://127.0.0.1:1'; // guaranteed-dead, never reached

const { ha_get_automation } = await import('@connectors/home_assistant_automation');
import type { ToolContext } from '@core/tool';

// ── metadata contract ──
assert.equal(ha_get_automation.name, 'ha_get_automation');
assert.equal(ha_get_automation.risk, 'read');
assert.deepEqual(ha_get_automation.required_capabilities, ['ha_automation_read']);

// ── input schema: id optional, list mode is the no-arg call ──
assert.ok(ha_get_automation.input_schema.safeParse({}).success);
assert.ok(ha_get_automation.input_schema.safeParse({ automation_id: 'abc123' }).success);
assert.ok(!ha_get_automation.input_schema.safeParse({ automation_id: '' }).success);

// ── idempotency keys distinguish list from single, stable per id ──
const k_list = ha_get_automation.idempotency_key!({});
const k_a = ha_get_automation.idempotency_key!({ automation_id: 'a' });
assert.notEqual(k_list, k_a);
assert.equal(k_a, ha_get_automation.idempotency_key!({ automation_id: 'a' }));

// ── no-token behavior: structured error, output-schema-valid, no throw ──
const ctx = {} as ToolContext; // no user → owner tier per require_caller_tier default
for (const input of [{}, { automation_id: 'abc123' }]) {
  const out = await ha_get_automation.execute(input, ctx);
  const parsed = ha_get_automation.output_schema.safeParse(out);
  assert.ok(parsed.success, `output schema rejected: ${JSON.stringify(out)}`);
  assert.equal(out.error, 'HA_TOKEN not configured');
  assert.equal(out.config, null);
}

console.log('smoke-home-assistant-automation: OK');
