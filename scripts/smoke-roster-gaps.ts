/**
 * smoke:roster-gaps — self-contained test of the roster-gap miner
 * (src/core/roster_gaps.ts), the evidence side of Kate's staffing loop.
 *
 * Temp SQLite. Seeds Cordelia triage interrupts (the unclaimed-capture
 * signal), unattributed + attributed demand audit rows, and hiring-packet
 * proposals, then asserts: triage mining (marker + window + originator
 * filters), boilerplate stripping, unattributed-only demand inclusion,
 * deterministic clustering with the evidence floor, known-hire-packet
 * detection (pending + recently-denied, non-hire recommendations
 * excluded), prompt-section rendering, and determinism across runs.
 * No LLM, no network.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ulid } from 'ulid';
import { open_db } from '../src/memory/stores/structured';
import {
  known_hire_packets,
  mine_roster_gap_signals,
  mine_roster_gaps,
  render_roster_gap_section,
  triage_text,
} from '../src/core/roster_gaps';

let failures = 0;
function check(label: string, ok: boolean): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) failures++;
}

const dir = mkdtempSync(join(tmpdir(), 'hearth-roster-'));
const db = open_db(join(dir, 'smoke.db'));

const NOW = new Date('2026-06-10T12:00:00Z');
const ts = (days_ago: number): string =>
  new Date(NOW.getTime() - days_ago * 86_400_000).toISOString();

function seed_interrupt(row: {
  ts: string;
  originating_specialist_id: string;
  summary: string;
  details_md?: string;
  user_id?: string;
}): string {
  const id = ulid();
  db.prepare(
    `INSERT INTO interrupts (id, ts, originating_specialist_id, severity, summary, details_md, routed_to, status, originating_user_id)
     VALUES (@id, @ts, @orig, 'medium', @summary, @details, 'kate', 'pending', @user)`,
  ).run({
    '@id': id,
    '@ts': row.ts,
    '@orig': row.originating_specialist_id,
    '@summary': row.summary,
    '@details': row.details_md ?? null,
    '@user': row.user_id ?? null,
  });
  return id;
}

function seed_audit(row: {
  ts: string;
  agent: string;
  tool_name: string;
  tool_input: unknown;
  execution_result?: unknown;
  user_id?: string;
}): void {
  db.prepare(
    `INSERT INTO audit_log (id, ts, intent_id, agent, tool_name, tool_input, execution_result, user_id)
     VALUES (@id, @ts, @intent, @agent, @tool, @input, @exec, @user)`,
  ).run({
    '@id': ulid(),
    '@ts': row.ts,
    '@intent': ulid(),
    '@agent': row.agent,
    '@tool': row.tool_name,
    '@input': JSON.stringify(row.tool_input),
    '@exec':
      row.execution_result === undefined ? null : JSON.stringify(row.execution_result),
    '@user': row.user_id ?? null,
  });
}

function seed_proposal(row: {
  ts_created: string;
  kind: string;
  status: string;
  payload: unknown;
  specialist_id?: string;
}): string {
  const id = ulid();
  db.prepare(
    `INSERT INTO proposals (id, ts_created, specialist_id, kind, execution_kind, payload_json, rationale_md, status)
     VALUES (@id, @ts, @spec, @kind, 'manual', @payload, 'smoke', @status)`,
  ).run({
    '@id': id,
    '@ts': row.ts_created,
    '@spec': row.specialist_id ?? 'kate',
    '@kind': row.kind,
    '@payload': JSON.stringify(row.payload),
    '@status': row.status,
  });
  return id;
}

/* --- seed: a recurring sewing/tailoring triage theme (5 in window) --- */
const TRIAGE_DETAILS = (i: number): string =>
  [
    `Cordelia couldn't confidently route 1 capture(s).`,
    `Reason: sewing pattern photo matches no specialist domain (variant ${i})`,
    '',
    'OCR excerpt:',
    '',
    `Simplicity pattern 8260 size 12 seam allowance`,
    '',
    'VL description:',
    '',
    `a paper sewing pattern and fabric swatches on a table`,
  ].join('\n');

for (let i = 0; i < 5; i++) {
  seed_interrupt({
    ts: ts(i + 1),
    originating_specialist_id: 'cordelia',
    summary: `Capture c_smoke${i} below routing threshold — needs triage`,
    details_md: TRIAGE_DETAILS(i),
    user_id: 'jasper',
  });
}
// Excluded: not cordelia
seed_interrupt({
  ts: ts(2),
  originating_specialist_id: 'cassandra',
  summary: 'Capture c_other below routing threshold — needs triage',
  details_md: 'should never appear',
});
// Excluded: cordelia but not a triage interrupt
seed_interrupt({
  ts: ts(2),
  originating_specialist_id: 'cordelia',
  summary: 'Classifier crashed mid-cluster',
  details_md: 'should never appear either',
});
// Excluded: out of window
seed_interrupt({
  ts: ts(40),
  originating_specialist_id: 'cordelia',
  summary: 'Capture c_old below routing threshold — needs triage',
  details_md: TRIAGE_DETAILS(99),
});

/* --- seed: demand signals — unattributed in, attributed out --- */
seed_audit({
  ts: ts(3),
  agent: 'orchestrator', // unattributed → counts
  tool_name: 'search_library',
  tool_input: { query_preview: 'sewing pattern sizing simplicity 8260' },
  execution_result: { hits: 0 },
  user_id: 'jasper',
});
seed_audit({
  ts: ts(3),
  agent: 'kristi', // attributed → excluded from roster gaps
  tool_name: 'search_library',
  tool_input: { query_preview: 'xeon sapphire rapids workstation pricing' },
  execution_result: { hits: 0 },
});
// A lone unattributed signal on an unrelated theme — below the evidence
// floor on its own, must not surface as a topic.
seed_audit({
  ts: ts(4),
  agent: 'orchestrator',
  tool_name: 'rag_low_confidence',
  tool_input: { query_preview: 'kayak roof rack torque spec' },
});

/* --- seed: hiring packets --- */
seed_proposal({
  ts_created: ts(5),
  kind: 'recommendation',
  status: 'pending',
  payload: { headline: 'Hire Pippa as Tailor', specialist: { id: 'pippa' } },
});
seed_proposal({
  ts_created: ts(6),
  kind: 'recommendation',
  status: 'denied',
  payload: { headline: 'Hire Quinn as Sommelier', specialist: { id: 'quinn' } },
});
// Non-hire recommendation (no payload.specialist.id) — excluded.
seed_proposal({
  ts_created: ts(1),
  kind: 'recommendation',
  status: 'pending',
  payload: { headline: 'Add recovery hint to web_fetch_clean' },
});
// Old decided packet outside the window AND not pending — excluded.
seed_proposal({
  ts_created: ts(60),
  kind: 'recommendation',
  status: 'approved',
  payload: { headline: 'Hire Old as Archivist', specialist: { id: 'old' } },
});

const OPTS = { window_days: 21, now: NOW, max_topics: 5 };

/* --- 1. triage_text strips boilerplate --- */
const tt = triage_text(TRIAGE_DETAILS(0), 'fallback');
check('triage_text keeps the route reason', tt.includes('sewing pattern photo matches no specialist domain'));
check('triage_text keeps OCR/VL content', tt.includes('Simplicity pattern 8260') && tt.includes('paper sewing pattern'));
check('triage_text drops the boilerplate frame', !tt.includes("couldn't confidently route"));
check('triage_text falls back to summary when details empty', triage_text(null, 'the summary') === 'the summary');

/* --- 2. signal mining --- */
const signals = mine_roster_gap_signals(db, OPTS);
const triage_refs = signals.filter((s) => s.ref.startsWith('interrupt:'));
check('mines the 5 in-window cordelia triage interrupts', triage_refs.length === 5);
check('all signals are unattributed', signals.every((s) => s.specialist_id === null));
check(
  'includes unattributed demand, excludes attributed',
  signals.some((s) => s.text.includes('sewing pattern sizing')) &&
    !signals.some((s) => s.text.includes('xeon sapphire rapids')),
);
check('excluded interrupts never leak', !signals.some((s) => s.text.includes('should never appear')));
check('out-of-window triage excluded', signals.filter((s) => s.ref.startsWith('interrupt:')).length === 5);

/* --- 3. clustering + evidence floor --- */
const report = mine_roster_gaps(db, OPTS);
check('themed cluster clears the floor', report.topics.length >= 1);
const top = report.topics[0]!;
check('cluster merges triage + demand on the same theme', top.evidence_count >= 5);
check('topic refs cite interrupts', top.refs.some((r) => r.startsWith('interrupt:')));
check(
  'lone off-theme signal stays below the floor',
  !report.topics.some((t) => t.label.includes('kayak')),
);

/* --- 4. known hire packets --- */
const packets = known_hire_packets(db, OPTS);
const ids = packets.map((p) => p.specialist_id_proposed).sort();
check('pending + recently-denied packets found', ids.join(',') === 'pippa,quinn');
check(
  'non-hire recommendation and stale packet excluded',
  !packets.some((p) => p.headline.includes('recovery hint') || p.specialist_id_proposed === 'old'),
);

/* --- 5. rendering --- */
const section = render_roster_gap_section(report, packets, { window_days: 21 });
check('section names the topic + evidence', section.includes('Roster-gap report') && section.includes(`${top.evidence_count} signals`));
check('section lists known packets as do-not-refile', section.includes('pippa') && section.includes('quinn'));
check('section carries the propose_hire instructions', section.includes('propose_hire') && section.includes('flag_beatrice'));
check(
  'empty report renders nothing',
  render_roster_gap_section({ signals_scanned: 0, topics: [] }, packets, { window_days: 21 }) === '',
);

/* --- 6. determinism --- */
const again = mine_roster_gaps(db, OPTS);
check('same window → identical report', JSON.stringify(report) === JSON.stringify(again));

db.close();
rmSync(dir, { recursive: true, force: true });

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nsmoke:roster-gaps — all checks passed');
