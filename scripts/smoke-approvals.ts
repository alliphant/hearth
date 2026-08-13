/**
 * Smoke for the approval gateway end-to-end.
 *
 * Sequence:
 *   1. Inject a TEST_FORCE_APPROVE rule at the top of v0.yaml that
 *      auto-approves a known synthetic tool_name (test_smoke_approve),
 *      then call /test/reload_policy.
 *   2. POST /test/queue_action with that tool_name → expect HTTP 202
 *      + { approval_id, status: 'pending_approval' }.
 *   3. GET /approvals?status=open → assert the approval is present.
 *   4. POST /approvals/<id>/decide { verdict: 'approve', who: 'smoke' }
 *      → assert HTTP 200, status='approved', and execution result is
 *      the STUB dispatch payload (since test_smoke_approve isn't a
 *      registered tool).
 *   5. Re-POST the same decide payload — assert idempotent response.
 *   6. Verify an audit_log row exists for tool_name='approval_decision'.
 *   7. Restore v0.yaml.
 *
 * Cleanup is in a try/finally so a failed assertion still restores the
 * policy file.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Database } from 'bun:sqlite';

const ORCH_URL = process.env.HEARTH_URL ?? 'http://localhost:7700';
const POLICY_PATH = resolve(
  process.env.HEARTH_POLICY_PATH ?? './config/policies/v0.yaml',
);
const DB_PATH = process.env.HEARTH_DB_PATH ?? './data/hearth.db';

const TEST_TOOL_NAME = 'test_smoke_approve';
const TEST_RULE_NAME = 'TEST_FORCE_APPROVE';

const TEST_RULE_YAML = `
  # TEST FIXTURE — inserted by scripts/smoke-approvals.ts, removed after.
  - name: ${TEST_RULE_NAME}
    applies_when:
      tool_risk: send_external
    decision: approve
`;

interface QueueResp {
  intent_id?: string;
  audit_id?: string;
  approval_id?: string;
  status?: string;
  error?: string;
  matched_rule?: string;
}

interface ListResp {
  approvals?: Array<{ id: string; status: string; tool_call: { tool_name: string } }>;
}

interface DecideResp {
  approval_id?: string;
  status?: string;
  result?: unknown;
  exec_audit_id?: string;
  audit_id?: string;
  idempotent?: boolean;
  human_verdict?: unknown;
  error?: string;
}

async function main(): Promise<void> {
  const original_policy = readFileSync(POLICY_PATH, 'utf8');

  try {
    // ── 1. Inject the test rule ─────────────────────────────────────────
    // Add a "rules:" header detection — the rule needs to be the FIRST
    // entry under rules:. The seed file has `rules:` on its own line
    // followed by entries.
    const lines = original_policy.split('\n');
    const rules_idx = lines.findIndex((l) => /^rules:\s*$/.test(l));
    if (rules_idx === -1) {
      throw new Error('could not find "rules:" line in policy file');
    }
    const patched = [
      ...lines.slice(0, rules_idx + 1),
      ...TEST_RULE_YAML.split('\n').slice(1, -1),
      ...lines.slice(rules_idx + 1),
    ].join('\n');
    writeFileSync(POLICY_PATH, patched, 'utf8');

    // Force-reload — avoids racing the chokidar awaitWriteFinish timer.
    const reload_res = await fetch(`${ORCH_URL}/test/reload_policy`, {
      method: 'POST',
    });
    if (!reload_res.ok) {
      const body = await reload_res.text();
      throw new Error(`reload failed: ${reload_res.status} ${body}`);
    }
    const reload_json = (await reload_res.json()) as {
      policy?: { rule_names?: string[] };
    };
    const rule_names = reload_json.policy?.rule_names ?? [];
    if (!rule_names.includes(TEST_RULE_NAME)) {
      throw new Error(
        `reload didn't pick up ${TEST_RULE_NAME}: ${rule_names.join(', ')}`,
      );
    }
    console.log(`✓ injected ${TEST_RULE_NAME} as rule 1/${rule_names.length}`);

    // ── 2. Queue a synthetic send_external action ───────────────────────
    console.log(`\n→ POST /test/queue_action`);
    const q_res = await fetch(`${ORCH_URL}/test/queue_action`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tool_name: TEST_TOOL_NAME,
        risk: 'send_external',
        input: { recipient: 'smoke@test.local', body: 'hello from smoke' },
      }),
    });
    if (q_res.status !== 202) {
      const body = await q_res.text();
      throw new Error(`queue: expected 202, got ${q_res.status}: ${body}`);
    }
    const q_json = (await q_res.json()) as QueueResp;
    console.log('  RESPONSE:', JSON.stringify(q_json, null, 2));
    if (q_json.status !== 'pending_approval' || !q_json.approval_id) {
      throw new Error(
        `queue: missing pending_approval/approval_id (${JSON.stringify(q_json)})`,
      );
    }
    if (q_json.matched_rule !== TEST_RULE_NAME) {
      throw new Error(
        `queue: expected matched_rule=${TEST_RULE_NAME}, got ${q_json.matched_rule}`,
      );
    }
    const approval_id = q_json.approval_id;

    // ── 3. List shows it as open ────────────────────────────────────────
    console.log(`\n→ GET /approvals?status=open`);
    const l_res = await fetch(`${ORCH_URL}/approvals?status=open`);
    const l_json = (await l_res.json()) as ListResp;
    if (!l_json.approvals?.some((a) => a.id === approval_id)) {
      throw new Error(`approval ${approval_id} not found in open list`);
    }
    const this_approval = l_json.approvals.find((a) => a.id === approval_id)!;
    if (this_approval.tool_call.tool_name !== TEST_TOOL_NAME) {
      throw new Error(`tool_name mismatch: ${this_approval.tool_call.tool_name}`);
    }
    console.log(`  ✓ approval ${approval_id} present in open list`);

    // ── 4. Decide approve → execute → assert STUB payload ───────────────
    console.log(`\n→ POST /approvals/${approval_id}/decide (approve)`);
    const d_res = await fetch(`${ORCH_URL}/approvals/${approval_id}/decide`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ verdict: 'approve', who: 'smoke' }),
    });
    if (!d_res.ok) {
      const body = await d_res.text();
      throw new Error(`decide: ${d_res.status} ${body}`);
    }
    const d_json = (await d_res.json()) as DecideResp;
    console.log('  RESPONSE:', JSON.stringify(d_json, null, 2));
    if (d_json.status !== 'approved') {
      throw new Error(`decide: expected status=approved, got ${d_json.status}`);
    }
    const result = d_json.result as
      | { stub?: boolean; tool_name?: string }
      | undefined;
    if (!result?.stub || result.tool_name !== TEST_TOOL_NAME) {
      throw new Error(
        `decide: expected STUB execution for ${TEST_TOOL_NAME}, got ${JSON.stringify(result)}`,
      );
    }
    if (!d_json.exec_audit_id) {
      throw new Error('decide: missing exec_audit_id');
    }
    console.log(`  ✓ approved + executed (stub), exec_audit_id=${d_json.exec_audit_id}`);

    // ── 5. Idempotent re-decide ─────────────────────────────────────────
    console.log(`\n→ POST /approvals/${approval_id}/decide (replay)`);
    const r_res = await fetch(`${ORCH_URL}/approvals/${approval_id}/decide`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ verdict: 'approve', who: 'smoke' }),
    });
    const r_json = (await r_res.json()) as DecideResp;
    if (!r_json.idempotent || r_json.status !== 'approved') {
      throw new Error(
        `replay: expected idempotent=true status=approved, got ${JSON.stringify(r_json)}`,
      );
    }
    console.log(`  ✓ replay returned idempotent=true, status=approved`);

    // ── 6. Audit log row for approval_decision ──────────────────────────
    const db = new Database(DB_PATH, { readonly: true });
    const audit = db
      .prepare(
        `SELECT COUNT(*) as n FROM audit_log
         WHERE intent_id = @id AND tool_name = 'approval_decision'`,
      )
      .get({ '@id': approval_id }) as { n: number };
    db.close();
    if (audit.n < 1) {
      throw new Error(
        `audit_log: expected ≥1 approval_decision row for ${approval_id}, got ${audit.n}`,
      );
    }
    console.log(`  ✓ audit_log has approval_decision row for ${approval_id}`);

    console.log(`\n✓ APPROVALS SMOKE PASSED`);
  } finally {
    // ── 7. Restore policy ───────────────────────────────────────────────
    writeFileSync(POLICY_PATH, original_policy, 'utf8');
    await fetch(`${ORCH_URL}/test/reload_policy`, { method: 'POST' }).catch(
      () => undefined,
    );
    console.log(`\n→ restored ${POLICY_PATH}`);
  }
}

main().catch((err: unknown) => {
  console.error(
    `\n✗ APPROVALS SMOKE FAILED:`,
    err instanceof Error ? err.message : String(err),
  );
  process.exit(1);
});
