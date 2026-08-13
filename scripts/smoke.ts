import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ORCH_URL = process.env.HEARTH_URL ?? 'http://localhost:7700';
const VAULT_ROOT =
  process.env.HEARTH_VAULT_ROOT ?? `${process.env.HOME}/vault-friday`;

interface StatusResp {
  service: string;
  version: string;
  vault_root: string;
  tools?: string[] | { scribe?: string[]; concierge?: string[] };
}

interface ToolResp<R = unknown> {
  intent_id?: string;
  audit_id?: string;
  result?: R;
  error?: string;
}

async function call_tool<R>(
  path: string,
  body: unknown,
): Promise<{ http_status: number; json: ToolResp<R> }> {
  const res = await fetch(`${ORCH_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as ToolResp<R>;
  return { http_status: res.status, json };
}

function assert_vault_file(rel_path: string, must_include?: string): string {
  const abs = resolve(VAULT_ROOT, rel_path);
  if (!existsSync(abs)) throw new Error(`Vault file missing: ${abs}`);
  if (must_include) {
    const content = readFileSync(abs, 'utf8');
    if (!content.includes(must_include)) {
      throw new Error(
        `Vault file ${rel_path} missing expected content:\n  want: ${must_include}\n  got:\n${content}`,
      );
    }
  }
  return abs;
}

function assert_audit(audit_id: string, today: string): void {
  const audit_path = resolve(VAULT_ROOT, `System/Audit/${today}.md`);
  if (!existsSync(audit_path)) {
    throw new Error(`Audit markdown missing: ${audit_path}`);
  }
  const audit_content = readFileSync(audit_path, 'utf8');
  if (!audit_content.includes(audit_id)) {
    throw new Error(`Audit ID ${audit_id} not found in ${audit_path}`);
  }
}

async function main() {
  const today = new Date().toISOString().slice(0, 10);

  // ── 1. Status ────────────────────────────────────────────────────────────
  console.log(`→ GET ${ORCH_URL}/status`);
  const status_res = await fetch(`${ORCH_URL}/status`);
  if (!status_res.ok) throw new Error(`Status check failed: ${status_res.status}`);
  const status = (await status_res.json()) as StatusResp;
  console.log('  STATUS:', JSON.stringify(status, null, 2));
  if (!status.service?.startsWith('hearth')) {
    throw new Error(`Unexpected service identity: ${status.service}`);
  }
  const expected_tools = [
    'append_journal_entry',
    'find_or_create_person',
    'upsert_person_note',
    'record_decision',
    'link_notes',
  ];
  const scribe_tools = Array.isArray(status.tools)
    ? status.tools
    : (status.tools?.scribe ?? []);
  for (const name of expected_tools) {
    if (!scribe_tools.includes(name)) {
      throw new Error(`/status missing expected scribe tool: ${name}`);
    }
  }
  console.log(`  ✓ all 5 scribe tools registered`);

  // ── 2. Legacy /intent ────────────────────────────────────────────────────
  const stamp = new Date().toISOString();
  const intent_text = `Smoke test ${stamp}: had coffee with Alex today; she's worried about her sister's recent diagnosis.`;
  console.log(`\n→ POST ${ORCH_URL}/intent`);
  const intent = await call_tool<{ note_path: string; date: string }>(
    '/intent',
    { text: intent_text },
  );
  console.log('  RESPONSE:', JSON.stringify(intent.json, null, 2));
  if (intent.http_status !== 200) {
    throw new Error(`/intent failed: ${intent.json.error ?? intent.http_status}`);
  }
  if (!intent.json.audit_id || !intent.json.result?.note_path) {
    throw new Error('/intent response missing audit_id or result.note_path');
  }
  assert_vault_file(`Journal/${today}.md`, intent_text);
  assert_audit(intent.json.audit_id, today);
  console.log(`  ✓ journal entry written, audit recorded`);

  // ── 3. /scribe/append_journal_entry ──────────────────────────────────────
  const aje_body = `direct append_journal_entry call at ${stamp}`;
  console.log(`\n→ POST /scribe/append_journal_entry`);
  const aje = await call_tool<{ note_path: string; date: string }>(
    '/scribe/append_journal_entry',
    { body: aje_body, tags: ['smoke'] },
  );
  console.log('  RESPONSE:', JSON.stringify(aje.json, null, 2));
  if (aje.http_status !== 200) {
    throw new Error(`append_journal_entry failed: ${aje.json.error}`);
  }
  assert_vault_file(`Journal/${today}.md`, aje_body);
  assert_audit(aje.json.audit_id!, today);
  console.log(`  ✓ journal append + audit`);

  // ── 4. /scribe/find_or_create_person (create path) ───────────────────────
  // Use a stable name so re-runs find the same person.
  const person_name = 'Smoke Test Person';
  console.log(`\n→ POST /scribe/find_or_create_person (name="${person_name}")`);
  const focp = await call_tool<{
    id: string;
    note_path: string;
    created: boolean;
  }>('/scribe/find_or_create_person', {
    name: person_name,
    hints: { relationship: 'acquaintance' },
  });
  console.log('  RESPONSE:', JSON.stringify(focp.json, null, 2));
  if (focp.http_status !== 200) {
    throw new Error(`find_or_create_person failed: ${focp.json.error}`);
  }
  const person_id = focp.json.result!.id;
  const person_note_path = focp.json.result!.note_path;
  if (!/^p_[a-z0-9]{6}$/.test(person_id)) {
    throw new Error(`Bad person id: ${person_id}`);
  }
  assert_vault_file(person_note_path, `id: ${person_id}`);
  assert_vault_file(person_note_path, 'type: person');
  assert_audit(focp.json.audit_id!, today);
  console.log(`  ✓ person ${person_id} at ${person_note_path} (created=${focp.json.result!.created})`);

  // ── 5. /scribe/find_or_create_person (find path, second call) ────────────
  console.log(`\n→ POST /scribe/find_or_create_person (find path)`);
  const focp2 = await call_tool<{
    id: string;
    note_path: string;
    created: boolean;
  }>('/scribe/find_or_create_person', { name: person_name });
  console.log('  RESPONSE:', JSON.stringify(focp2.json, null, 2));
  if (focp2.json.result?.id !== person_id) {
    throw new Error(
      `Second find_or_create_person returned different id: ${focp2.json.result?.id} vs ${person_id}`,
    );
  }
  if (focp2.json.result?.created !== false) {
    throw new Error(`Second call should report created=false`);
  }
  console.log(`  ✓ idempotent lookup returns same person, created=false`);

  // ── 6. /scribe/upsert_person_note ────────────────────────────────────────
  // Patch a clearly-non-date string field to avoid YAML→Date round-trip
  // (gray-matter+js-yaml parses ISO timestamps as Date objects, which
  // would break PersonFrontmatter.parse on re-read).
  const patch_marker = `smoke-body-append-${stamp}`;
  console.log(`\n→ POST /scribe/upsert_person_note (patch by id)`);
  const upn = await call_tool<{ id: string; note_path: string }>(
    '/scribe/upsert_person_note',
    {
      identifier: { id: person_id },
      patch: { preferred_name: 'Smokey' },
      body_append: patch_marker,
    },
  );
  console.log('  RESPONSE:', JSON.stringify(upn.json, null, 2));
  if (upn.http_status !== 200) {
    throw new Error(`upsert_person_note failed: ${upn.json.error}`);
  }
  assert_vault_file(person_note_path, 'preferred_name');
  assert_vault_file(person_note_path, 'Smokey');
  assert_vault_file(person_note_path, patch_marker);
  assert_audit(upn.json.audit_id!, today);
  console.log(`  ✓ person frontmatter patched + body appended`);

  // ── 7. /scribe/record_decision ───────────────────────────────────────────
  const chosen = `Bun runtime for Hearth (smoke ${stamp})`;
  console.log(`\n→ POST /scribe/record_decision`);
  const rd = await call_tool<{ id: string; note_path: string }>(
    '/scribe/record_decision',
    {
      domain: 'infra',
      options_considered: ['Node.js', 'Bun', 'Deno'],
      chosen,
      rationale: 'Smoke test rationale — exercising the route end-to-end.',
      reversible: true,
    },
  );
  console.log('  RESPONSE:', JSON.stringify(rd.json, null, 2));
  if (rd.http_status !== 200) {
    throw new Error(`record_decision failed: ${rd.json.error}`);
  }
  const decision_id = rd.json.result!.id;
  const decision_path = rd.json.result!.note_path;
  if (!/^d_[a-z0-9]{6}$/.test(decision_id)) {
    throw new Error(`Bad decision id: ${decision_id}`);
  }
  if (!decision_path.startsWith(`Decisions/${today}-`)) {
    throw new Error(`Decision path malformed: ${decision_path}`);
  }
  assert_vault_file(decision_path, `id: ${decision_id}`);
  assert_vault_file(decision_path, 'type: decision');
  assert_vault_file(decision_path, 'domain: infra');
  assert_audit(rd.json.audit_id!, today);
  console.log(`  ✓ decision ${decision_id} at ${decision_path}`);

  // ── 8. /scribe/link_notes ────────────────────────────────────────────────
  const link_context = `smoke-link-${stamp}`;
  console.log(`\n→ POST /scribe/link_notes (decision → person)`);
  const ln = await call_tool<{ from: string; to: string }>(
    '/scribe/link_notes',
    {
      from: decision_path,
      to: person_note_path,
      context: link_context,
    },
  );
  console.log('  RESPONSE:', JSON.stringify(ln.json, null, 2));
  if (ln.http_status !== 200) {
    throw new Error(`link_notes failed: ${ln.json.error}`);
  }
  const decision_content = readFileSync(
    resolve(VAULT_ROOT, decision_path),
    'utf8',
  );
  if (!/^## Related\b/m.test(decision_content)) {
    throw new Error(`link_notes did not add a "## Related" section`);
  }
  const expected_wikilink = `[[${person_note_path.split('/').pop()!.replace(/\.md$/, '')}]]`;
  if (!decision_content.includes(expected_wikilink)) {
    throw new Error(`link_notes did not insert ${expected_wikilink}`);
  }
  if (!decision_content.includes(link_context)) {
    throw new Error(`link_notes did not record context "${link_context}"`);
  }
  assert_audit(ln.json.audit_id!, today);
  console.log(`  ✓ wikilink + context appended under "## Related"`);

  console.log(`\n✓ SMOKE PASSED`);
  console.log(`  legacy /intent       → ${intent.json.result!.note_path}`);
  console.log(`  append_journal_entry → ${aje.json.result!.note_path}`);
  console.log(`  find_or_create_person → ${person_note_path} (${person_id})`);
  console.log(`  upsert_person_note    → patched ${person_note_path}`);
  console.log(`  record_decision       → ${decision_path} (${decision_id})`);
  console.log(`  link_notes            → ${decision_path} → ${person_note_path}`);
}

main().catch((err: unknown) => {
  console.error(
    `\n✗ SMOKE FAILED:`,
    err instanceof Error ? err.message : String(err),
  );
  process.exit(1);
});
