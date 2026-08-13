/**
 * smoke:revert-low-risk — the inverse-patch logic of revert_low_risk_fix.
 *
 * Pure-function test of `invert_change` over a realistic specialist YAML:
 * each apply kind's inverse is a surgical one-line splice that re-parses,
 * removes/flips exactly the target, leaves same-named items on other
 * surfaces intact, and no-ops cleanly when there's nothing to revert.
 */
import { parseDocument } from 'yaml';
import { invert_change } from '../src/specialists/trainer/tools/revert_low_risk_fix';
import type { LowRiskChange } from '../src/specialists/trainer/tools/apply_low_risk_fix';

let failures = 0;
function check(name: string, cond: boolean): void {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`);
  if (!cond) failures++;
}

// A specialist YAML with `web_search` present on BOTH surfaces (the scope
// trap), an opt-in already ON, and a granted safe-set capability — comments
// interleaved, as real configs have.
const YAML = `id: testspec
name: Test
role: tester
capabilities:
  read_vault: true
  # a previously self-applied grant
  read_audit_log: true
proactive:
  mode: active
  # additive opt-in flipped on by a prior apply
  research_workload: true
  tools_for_chat:
    - search_library
    - web_search
  tools_for_deliberation:
    - read_inbox
    - web_search
    - query_audit_log
persona: |
  hi
`;

function reparse_ok(src: string): boolean {
  return parseDocument(src).errors.length === 0;
}
function line_count(src: string): number {
  return src.split('\n').length;
}

const orig_lines = line_count(YAML);

// 1. Remove a tool from the CHAT surface — the deliberation copy survives.
{
  const change: LowRiskChange = { kind: 'add_tool_to_chat_surface', tool_name: 'web_search' };
  const r = invert_change(YAML, change);
  check('chat-surface removal applied', r.applied && !!r.next_src);
  const doc = parseDocument(r.next_src ?? '');
  const chat = (doc.getIn(['proactive', 'tools_for_chat']) as { items: Array<{ value: string }> }).items.map((i) => i.value);
  const delib = (doc.getIn(['proactive', 'tools_for_deliberation']) as { items: Array<{ value: string }> }).items.map((i) => i.value);
  check('web_search gone from tools_for_chat', !chat.includes('web_search'));
  check('web_search SURVIVES on tools_for_deliberation (scope)', delib.includes('web_search'));
  check('chat removal is a one-line diff', line_count(r.next_src ?? '') === orig_lines - 1);
  check('chat removal re-parses', reparse_ok(r.next_src ?? ''));
}

// 2. Remove a tool from the DELIBERATION surface — chat copy survives.
{
  const change: LowRiskChange = { kind: 'add_tool_to_deliberation_surface', tool_name: 'web_search' };
  const r = invert_change(YAML, change);
  const doc = parseDocument(r.next_src ?? '');
  const chat = (doc.getIn(['proactive', 'tools_for_chat']) as { items: Array<{ value: string }> }).items.map((i) => i.value);
  const delib = (doc.getIn(['proactive', 'tools_for_deliberation']) as { items: Array<{ value: string }> }).items.map((i) => i.value);
  check('web_search gone from tools_for_deliberation', !delib.includes('web_search'));
  check('web_search SURVIVES on tools_for_chat', chat.includes('web_search'));
}

// 3. Remove a granted capability.
{
  const change: LowRiskChange = { kind: 'grant_capability', capability: 'read_audit_log' };
  const r = invert_change(YAML, change);
  check('capability removal applied', r.applied);
  const doc = parseDocument(r.next_src ?? '');
  check('read_audit_log no longer granted', doc.getIn(['capabilities', 'read_audit_log']) !== true);
  check('read_vault untouched', doc.getIn(['capabilities', 'read_vault']) === true);
  check('cap removal is a one-line diff', line_count(r.next_src ?? '') === orig_lines - 1);
}

// 4. Flip an opt-in back to false (NOT removed — flipped, so line count holds).
{
  const change: LowRiskChange = { kind: 'enable_optin', field: 'research_workload' };
  const r = invert_change(YAML, change);
  check('opt-in flip applied', r.applied);
  const doc = parseDocument(r.next_src ?? '');
  check('research_workload is now false', doc.getIn(['proactive', 'research_workload']) === false);
  check('opt-in flip keeps line count', line_count(r.next_src ?? '') === orig_lines);
  check('opt-in flip re-parses', reparse_ok(r.next_src ?? ''));
}

// 5. No-ops: nothing to revert → applied false with a reason, no mutation.
{
  const missing_tool = invert_change(YAML, { kind: 'add_tool_to_chat_surface', tool_name: 'not_present' });
  check('missing tool → no-op', !missing_tool.applied && /not in proactive/.test(missing_tool.reason ?? ''));

  const missing_cap = invert_change(YAML, { kind: 'grant_capability', capability: 'read_calendar' });
  check('absent capability → no-op', !missing_cap.applied);

  // An opt-in that isn't `true` in this YAML (intake_captures absent).
  const off_optin = invert_change(YAML, { kind: 'enable_optin', field: 'intake_captures' });
  check('opt-in not-true → no-op', !off_optin.applied);
}

console.log(failures === 0 ? '\nsmoke:revert-low-risk OK' : `\nsmoke:revert-low-risk FAILED (${failures})`);
process.exit(failures === 0 ? 0 : 1);
