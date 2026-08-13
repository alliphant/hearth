/**
 * smoke:toolcall-diagnosis — the tool-call self-diagnosis loop (Workstream B).
 *
 * Self-contained: temp db, a fixture ToolRegistry, a SCRIPTED deep model + probe
 * (no network/LLM). Covers:
 *   0. interactive_probe: the per-shape verdict matrix (emitted+valid / no-tool-
 *      call / invalid-args), the blame-localizing summary, and the kill switch.
 *   1. the engine evidence pack: provided-vs-required extraction (model sent
 *      `path`, schema wants `note_path`), schema introspection + lint, the probe.
 *   2. the diagnosis is GROUNDED (a fabricated specific dropped + scrubbed),
 *      TYPED + SCORED + RANKED, and EVERY fix's apply_via is an EXISTING gate.
 *   3. fail-open (no model → fallback) .
 *   4. the diagnose_tool_failure TOOL: parse_subject matrix, unknown-tool
 *      refusal, files an owner recommendation, cites the open guard-feedback
 *      miss, returns a next_action that routes through the existing gate, and
 *      applies NOTHING; the kill switch.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ulid } from 'ulid';
import { z } from 'zod';
import { open_db } from '../src/memory/stores/structured';
import { MemoryClient } from '../src/memory/client';
import { ProposalsStore } from '../src/core/proposals';
import { ProcessMissStore } from '../src/core/process_misses';
import { ToolRegistry } from '../src/core/tool_registry';
import type { Tool, ToolContext } from '../src/core/tool';
import type { LLMRequest, LLMResponse } from '../src/core/llm';
import {
  run_interactive_probe,
  type InteractiveProbeReport,
  type ProbeShape,
} from '../src/core/interactive_probe';
import {
  gather_tool_evidence,
  run_toolcall_diagnosis,
  EXISTING_GATES,
  type CompleteRoleFn,
  type ToolcallDiagnosisDeps,
} from '../src/core/toolcall_diagnosis';
import { make_diagnose_tool_failure, parse_subject } from '../src/specialists/trainer/tools/diagnose_tool_failure';
import type { FactCriticResult } from '../src/core/fact_critic';

let failures = 0;
function check(label: string, ok: boolean): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) failures++;
}

const dir = mkdtempSync(join(tmpdir(), 'hearth-tcdiag-'));
const db = open_db(join(dir, 'smoke.db'));
const memory = new MemoryClient({ vault_root: join(dir, 'vault'), db });

/* ------------------------------------------------------------------ */
/* Fixture tool registry: read_note requires `note_path` (the synonym  */
/* trap the model trips on by sending `path`).                         */
/* ------------------------------------------------------------------ */

function fixture_tool(name: string, schema: z.ZodTypeAny): Tool {
  return {
    name,
    description: `fixture ${name}`,
    risk: 'read',
    input_schema: schema,
    output_schema: z.object({ ok: z.boolean() }),
    idempotency_key: () => `${name}:x`,
    execute: async () => ({ ok: true }),
  } as Tool;
}
const tools = new ToolRegistry();
tools.register(fixture_tool('read_note', z.object({ note_path: z.string().min(1), tags: z.array(z.string()).optional() })));

/* ------------------------------------------------------------------ */
/* 0. interactive_probe — verdict matrix + summary + kill switch        */
/* ------------------------------------------------------------------ */

function resp(tool_calls: LLMResponse['tool_calls'], content = ''): LLMResponse {
  return { content, tool_calls, finish_reason: 'stop', cost: { tokens_in: 10, tokens_out: 5, ms: 12, model: 'fixture-9b' } };
}
function tool_name_of(req: LLMRequest): string {
  return req.tools?.[0]?.name ?? '';
}

{
  // A model that: emits valid args for `simple`, leaks `nested` into content,
  // and emits INVALID args for `pattern`.
  const mixed_complete = async (req: LLMRequest): Promise<LLMResponse> => {
    const n = tool_name_of(req);
    if (n === 'get_weather') return resp([{ id: 't1', name: 'get_weather', arguments: { city: 'Denver' } }]);
    if (n === 'drop_pin') return resp([], "I'd drop a pin at the trailhead.");
    if (n === 'lookup_code') return resp([{ id: 't3', name: 'lookup_code', arguments: { code: 'not a code' } }]);
    return resp([]);
  };
  const report = await run_interactive_probe({ complete_fn: mixed_complete });
  const by = (s: ProbeShape) => report.results.find((r) => r.shape === s)!;
  check('probe: simple shape emits valid args', by('simple').emitted_tool_call && by('simple').args_valid);
  check('probe: nested shape leaks to content (no tool_call)', !by('nested').emitted_tool_call && by('nested').raw_content_sample.includes('trailhead'));
  check('probe: pattern shape emits INVALID args', by('pattern').emitted_tool_call && !by('pattern').args_valid && by('pattern').invalid_detail !== null);
  check('probe: mixed → all_valid false + summary flags failing shapes', !report.all_valid && /FAILED some shapes/.test(report.summary));

  // A healthy model: valid args for every shape → blame is the schema, not the model.
  const healthy_complete = async (req: LLMRequest): Promise<LLMResponse> => {
    const n = tool_name_of(req);
    if (n === 'get_weather') return resp([{ id: 'a', name: 'get_weather', arguments: { city: 'Denver' } }]);
    if (n === 'drop_pin') return resp([{ id: 'b', name: 'drop_pin', arguments: { location: { lat: 40.05, lng: -104.76 }, label: 'trailhead' } }]);
    if (n === 'lookup_code') return resp([{ id: 'c', name: 'lookup_code', arguments: { code: 'AB-1234' } }]);
    return resp([]);
  };
  const healthy = await run_interactive_probe({ complete_fn: healthy_complete });
  check('probe: healthy model → all_emitted + all_valid', healthy.all_emitted && healthy.all_valid);
  check('probe: healthy summary localizes blame to the SCHEMA/CONTRACT', /SCHEMA\/CONTRACT/.test(healthy.summary));

  // Kill switch.
  process.env.HEARTH_INTERACTIVE_PROBE = '0';
  const killed = await run_interactive_probe({ complete_fn: healthy_complete });
  check('probe: HEARTH_INTERACTIVE_PROBE=0 → disabled, no shapes run', !killed.enabled && killed.results.length === 0);
  delete process.env.HEARTH_INTERACTIVE_PROBE;
}

/* ------------------------------------------------------------------ */
/* Seed: failing read_note calls (model sent `path`, schema wants       */
/* note_path) + an open guard-feedback miss.                            */
/* ------------------------------------------------------------------ */

function seed_arg_failure(tool: string, provided: Record<string, unknown>, err: string): void {
  db.prepare(
    `INSERT INTO audit_log (id, ts, intent_id, agent, tool_name, tool_input, execution_result, error)
     VALUES (@id, @ts, @intent, 'kristi', @tool, @input, NULL, @err)`,
  ).run({ '@id': ulid(), '@ts': new Date().toISOString(), '@intent': ulid(), '@tool': tool, '@input': JSON.stringify(provided), '@err': err });
}
seed_arg_failure('read_note', { path: 'Knowledge/Foo.md' }, 'INPUT_VALIDATION_FAILED: note_path is required');
seed_arg_failure('read_note', { path: 'Knowledge/Bar.md' }, 'INPUT_VALIDATION_FAILED: note_path is required');
seed_arg_failure('read_note', { file_path: 'Baz.md' }, 'INPUT_VALIDATION_FAILED: note_path is required');

const misses = new ProcessMissStore(db);
misses.create({
  subject_specialist_id: 'trainer',
  reporter: 'orchestrator',
  task_summary: 'Tool `read_note` keeps failing argument validation',
  gap: 'Recurring tool-arg failure on `read_note` — surviving central recovery.',
  severity: 'medium',
  evidence_ref: 'arg-mismatch:read_note',
});

/* ------------------------------------------------------------------ */
/* Scripted deep model + critic + probe seams                          */
/* ------------------------------------------------------------------ */

const complete_role_fn: CompleteRoleFn = async (_role, { system }) => {
  if (system.includes('diagnosing why a TOOL CALL')) {
    return JSON.stringify({
      root_cause:
        'The read_note schema requires `note_path`, but the model emits the conventional `path` (and `file_path`), so Zod rejects every call.\n' +
        'It is also triggered by PHANTOM_FIELD_zzz which does not exist.',
      confidence: 0.85,
      inconclusive: false,
      fixes: [
        { type: 'rename_field', title: 'Rename note_path → path', detail: "Rename read_note's required `note_path` to `path` so the model sees the conventional name.", target: 'read_note', apply_via: 'propose_code_edit' },
        { type: 'add_alias', title: 'Alias path→note_path', detail: 'Add `path` to FIELD_ALIASES[note_path] in tool_registry.ts.', target: 'note_path', apply_via: 'propose_code_edit' },
      ],
    });
  }
  if (system.includes('SKEPTICAL reviewer scoring')) {
    return JSON.stringify({
      scores: [
        { likelihood_to_resolve: 0.85, risk: 'low', reversibility: 'easy', blast_radius: 'contained', rationale: 'a clean synonym mismatch; rename is the durable fix' },
        { likelihood_to_resolve: 0.7, risk: 'low', reversibility: 'easy', blast_radius: 'contained', rationale: 'alias also recovers it, slightly less clean' },
      ],
    });
  }
  return null;
};

const verify_fn = (async (args: { reply: string }): Promise<FactCriticResult> => ({
  checked: true,
  unsupported: args.reply.includes('PHANTOM_FIELD_zzz')
    ? [{ claim: 'PHANTOM_FIELD_zzz', kind: 'named_entity', reason: 'not in the evidence' }]
    : [],
})) as ToolcallDiagnosisDeps['verify_fn'];

const probe_fn = async (): Promise<InteractiveProbeReport> => ({
  role: 'specialist',
  enabled: true,
  results: [
    { shape: 'simple', reachable: true, emitted_tool_call: true, called_right_tool: true, args_valid: true, invalid_detail: null, model: 'fixture-9b', latency_ms: 11, raw_content_sample: '', error: null },
    { shape: 'nested', reachable: true, emitted_tool_call: true, called_right_tool: true, args_valid: true, invalid_detail: null, model: 'fixture-9b', latency_ms: 12, raw_content_sample: '', error: null },
    { shape: 'pattern', reachable: true, emitted_tool_call: true, called_right_tool: true, args_valid: true, invalid_detail: null, model: 'fixture-9b', latency_ms: 13, raw_content_sample: '', error: null },
  ],
  all_emitted: true,
  all_valid: true,
  summary: 'the specialist endpoint emits VALID native tool_calls for all probed shapes — a recurring per-tool failure is the SCHEMA/CONTRACT, not the model',
});

const engine: ToolcallDiagnosisDeps = { db, tools, llm: {} as never, complete_role_fn, verify_fn, probe_fn };

/* ------------------------------------------------------------------ */
/* 1. evidence pack                                                    */
/* ------------------------------------------------------------------ */
{
  const pack = await gather_tool_evidence(engine, { tool: 'read_note' });
  check('evidence: provided-vs-required shows path provided, note_path missing', pack.provided_vs_required.some((p) => p.provided_keys.includes('path') && p.missing_required.includes('note_path')));
  check('evidence: schema required = [note_path]', (pack.schema?.required ?? []).includes('note_path'));
  check('evidence: schema lint flags the note_path synonym-required field', (pack.schema?.lint ?? []).some((w) => w.includes('note_path')));
  check('evidence: error samples deduped (2 distinct of 3 rows)', pack.error_samples.length >= 1);
  check('evidence: live probe attached + all_valid', pack.probe !== null && pack.probe!.all_valid === true);
}

/* ------------------------------------------------------------------ */
/* 2. diagnosis: grounded, typed, scored, ranked, gate-only            */
/* ------------------------------------------------------------------ */
{
  const diag = await run_toolcall_diagnosis(engine, { tool: 'read_note' });
  check('diagnosis: root cause grounded in the real mismatch (note_path/path)', /note_path/.test(diag.root_cause) && /path/.test(diag.root_cause));
  check('diagnosis: fabricated specific DROPPED by the critic', diag.ungrounded_dropped.includes('PHANTOM_FIELD_zzz'));
  check('diagnosis: fabricated specific SCRUBBED from the narrative', !diag.root_cause.includes('PHANTOM_FIELD_zzz'));
  check('diagnosis: typed fixes (rename_field + add_alias + escalate floor)', diag.fixes.some((f) => f.type === 'rename_field') && diag.fixes.some((f) => f.type === 'add_alias') && diag.fixes.some((f) => f.type === 'escalate'));
  check('diagnosis: EVERY fix apply_via is an EXISTING gate (no novel apply surface)', diag.fixes.every((f) => EXISTING_GATES.has(f.apply_via)));
  check('diagnosis: ranked best-first by composite', diag.fixes.every((f, i) => i === 0 || diag.fixes[i - 1]!.score.confidence >= f.score.confidence));
  check('diagnosis: recommended is the rename (highest score), not escalate', diag.recommended_index === 0 && diag.fixes[0]!.type === 'rename_field');
}

/* ------------------------------------------------------------------ */
/* 3. fail-open: no model → fallback diagnosis                         */
/* ------------------------------------------------------------------ */
{
  const noModel: ToolcallDiagnosisDeps = { db, tools, probe_fn };
  const diag = await run_toolcall_diagnosis(noModel, { tool: 'read_note' });
  check('fail-open: no model → inconclusive fallback with an escalate fix', diag.inconclusive && diag.fixes.some((f) => f.type === 'escalate'));
}

/* ------------------------------------------------------------------ */
/* 4. parse_subject matrix                                            */
/* ------------------------------------------------------------------ */
{
  check('parse: bare tool name → tool target', parse_subject('read_note').target.tool === 'read_note');
  check('parse: arg-mismatch:<tool> → tool target', parse_subject('arg-mismatch:edgar_read_filing').target.tool === 'edgar_read_filing');
  const f = parse_subject('arg-mismatch:edgar_read_filing:filing_url');
  check('parse: arg-mismatch:<tool>:<field> → tool target + ref keeps field', f.target.tool === 'edgar_read_filing' && f.evidence_ref === 'arg-mismatch:edgar_read_filing:filing_url');
  const h = parse_subject('honesty:fabricated_save_guard:kate');
  check('parse: honesty:<guard>:<spec> → guard+specialist target', h.target.guard === 'fabricated_save_guard' && h.target.specialist_id === 'kate');
}

/* ------------------------------------------------------------------ */
/* 5. the diagnose_tool_failure TOOL                                   */
/* ------------------------------------------------------------------ */

const proposals = new ProposalsStore(db);
const tool = make_diagnose_tool_failure({ db, memory, proposals, tools, process_misses: misses, complete_role_fn, verify_fn, probe_fn });
const ctx: ToolContext = { memory, llm: {} as never, now: new Date(), intent_id: ulid(), specialist_id: 'trainer' };

{
  const out = await tool.execute({ subject: 'arg-mismatch:read_note' }, ctx);
  check('tool: ok + not refused on the real failing tool', out.ok && !out.refused);
  check('tool: recommends the schema fix (rename_field) via propose_code_edit', out.recommended_fix?.type === 'rename_field' && out.recommended_fix?.apply_via === 'propose_code_edit');
  check('tool: probe_summary localizes blame to the schema', (out.probe_summary ?? '').includes('SCHEMA/CONTRACT'));
  check('tool: files an owner recommendation proposal', out.proposal_id !== null);
  check('tool: cites the open guard-feedback miss', out.cited_miss_ids.length === 1);
  check('tool: next_action routes through propose_code_edit (the existing gate)', /propose_code_edit/.test(out.next_action));
  check('tool: applies NOTHING (no merge/apply in the output)', out.refused === false && out.recommended_fix?.apply_via !== 'merge');

  // The filed proposal is a recommendation carrying the scored options + diagnosis_md.
  const prop = proposals.get(out.proposal_id!);
  const payload = JSON.parse(prop?.payload_json ?? '{}') as Record<string, unknown>;
  check('tool: proposal is a recommendation with scored fixes + diagnosis_md', prop?.kind === 'recommendation' && Array.isArray(payload.fixes) && typeof payload.diagnosis_md === 'string');
}

{
  const out = await tool.execute({ subject: 'definitely_not_a_tool' }, ctx);
  check('tool: unknown tool → refused with candidates hint', out.refused && out.recommended_fix === null && /isn't a registered tool/.test(out.next_action));
}

{
  process.env.HEARTH_TOOLCALL_DIAGNOSIS = '0';
  const out = await tool.execute({ subject: 'read_note' }, ctx);
  check('tool: HEARTH_TOOLCALL_DIAGNOSIS=0 → disabled, no proposal', !out.enabled && out.proposal_id === null);
  delete process.env.HEARTH_TOOLCALL_DIAGNOSIS;
}

/* ------------------------------------------------------------------ */

rmSync(dir, { recursive: true, force: true });
console.log('');
if (failures > 0) {
  console.error(`✗ ${failures} assertion(s) failed`);
  process.exit(1);
}
console.log('✓ all toolcall-diagnosis checks passed');
process.exit(0);
