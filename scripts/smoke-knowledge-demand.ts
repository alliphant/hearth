/**
 * smoke:knowledge-demand — self-contained test of the demand ledger
 * (src/core/knowledge_demand.ts + Cordelia's knowledge_demand_report).
 *
 * Temp vault + temp SQLite. Seeds the four signal shapes the miner reads
 * (rag_low_confidence / empty search_library / eval_runs failure /
 * citation_guard) and asserts: signal extraction, deterministic token
 * clustering, per-specialist grouping, evidence refs, the max_topics cap,
 * the sole-user cordon hint, and that non-signals (search with hits>0,
 * passing evals, out-of-window rows) are excluded. No LLM, no network.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ulid } from 'ulid';
import { open_db } from '../src/memory/stores/structured';
import { MemoryClient } from '../src/memory/client';
import {
  mine_demand_signals,
  cluster_demand,
  mine_knowledge_demand,
  type DemandSignal,
} from '../src/core/knowledge_demand';
import { make_knowledge_demand_report } from '../src/specialists/cordelia/tools/knowledge_demand_report';
import type { ToolContext } from '../src/core/tool';
import type { LLMRouter } from '../src/core/llm';

let failures = 0;
function check(label: string, ok: boolean): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) failures++;
}

const dir = mkdtempSync(join(tmpdir(), 'hearth-demand-'));
const db = open_db(join(dir, 'smoke.db'));
const memory = new MemoryClient({ vault_root: join(dir, 'vault'), db });

const NOW = new Date('2026-06-10T12:00:00Z');
const ts = (days_ago: number): string =>
  new Date(NOW.getTime() - days_ago * 86_400_000).toISOString();

function audit(row: {
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
    '@exec': row.execution_result === undefined ? null : JSON.stringify(row.execution_result),
    '@user': row.user_id ?? null,
  });
}

// --- Seed: an "EV charging" demand cluster on iris (3 signals, 2 kinds) ---
audit({
  ts: ts(1),
  agent: 'iris',
  tool_name: 'rag_low_confidence',
  tool_input: { query_preview: 'EV scheduled charging off-peak rates Pleasantville' },
  execution_result: { candidates: 4, top_score: 0.04 },
  user_id: 'jasper',
});
audit({
  ts: ts(2),
  agent: 'iris',
  tool_name: 'search_library',
  tool_input: { query_preview: 'off-peak EV charging rate schedule', k: 5 },
  execution_result: { hits: 0, paths: [] },
  user_id: 'jasper',
});
audit({
  ts: ts(3),
  agent: 'iris',
  tool_name: 'citation_guard',
  tool_input: { round: 1, findings: ['uncited:EV off-peak charging window 10pm'] },
  execution_result: { retry_triggered: true },
  user_id: 'jasper',
});

// --- Seed: a single-user (non-owner) cluster on brigid ---
audit({
  ts: ts(1),
  agent: 'brigid',
  tool_name: 'rag_low_confidence',
  tool_input: { query_preview: 'gluten free sourdough starter hydration' },
  execution_result: { candidates: 2, top_score: 0.02 },
  user_id: 'sam',
});
audit({
  ts: ts(2),
  agent: 'brigid',
  tool_name: 'search_library',
  tool_input: { query_preview: 'sourdough starter gluten free flour', k: 5 },
  execution_result: { hits: 0, paths: [] },
  user_id: 'sam',
});

// --- Seed: NON-signals that must be excluded ---
audit({
  ts: ts(1),
  agent: 'iris',
  tool_name: 'search_library',
  tool_input: { query_preview: 'EV manual scheduled charging', k: 5 },
  execution_result: { hits: 3, paths: ['a.md', 'b.md', 'c.md'] }, // non-empty → not demand
  user_id: 'jasper',
});
audit({
  ts: ts(40),
  agent: 'iris',
  tool_name: 'rag_low_confidence',
  tool_input: { query_preview: 'ancient out-of-window query about EV tires' },
  execution_result: { candidates: 1, top_score: 0.01 },
  user_id: 'jasper',
}); // outside 14d window

// --- Seed: legacy unattributed search row (agent='orchestrator') ---
audit({
  ts: ts(4),
  agent: 'orchestrator',
  tool_name: 'search_library',
  tool_input: { query_preview: 'county county mill levy history', k: 5 },
  execution_result: { hits: 0, paths: [] },
  user_id: 'jasper',
});

// --- Seed: eval_runs — one failure (signal), one pass (not) ---
db.prepare(
  `INSERT INTO eval_runs (id, ts, task_id, specialist_id, passed, detail, model)
   VALUES (@id, @ts, @task, @spec, @passed, @detail, @model)`,
).run({
  '@id': ulid(),
  '@ts': ts(2),
  '@task': 'iris-ev-grounding',
  '@spec': 'iris',
  '@passed': 0,
  '@detail': 'fabricated charging window; no source on shelf',
  '@model': 'fake',
});
db.prepare(
  `INSERT INTO eval_runs (id, ts, task_id, specialist_id, passed, detail, model)
   VALUES (@id, @ts, @task, @spec, @passed, @detail, @model)`,
).run({
  '@id': ulid(),
  '@ts': ts(2),
  '@task': 'kate-brief',
  '@spec': 'kate',
  '@passed': 1,
  '@detail': 'all assertions held',
  '@model': 'fake',
});

// ------------------------------------------------------------------
// 1. Signal mining
// ------------------------------------------------------------------
const signals = mine_demand_signals(db, { window_days: 14, now: NOW });
check('mines 7 in-window signals (3 iris audit + 2 brigid + 1 legacy + 1 eval)', signals.length === 7);
check('excludes non-empty search_library rows', !signals.some((s) => s.text.includes('EV manual')));
check('excludes out-of-window rows', !signals.some((s) => s.text.includes('ancient')));
check('excludes passing eval runs', !signals.some((s) => s.text.includes('kate-brief')));
check(
  'legacy orchestrator row mined but unattributed',
  signals.some((s) => s.text.includes('mill levy') && s.specialist_id === null),
);
check(
  'eval failure attributed to iris with eval: ref',
  signals.some((s) => s.kind === 'eval_failure' && s.specialist_id === 'iris' && s.ref.startsWith('eval:')),
);
check(
  'audit signals carry audit: refs',
  signals.filter((s) => s.ref.startsWith('audit:')).length === 6,
);

// ------------------------------------------------------------------
// 2. Clustering
// ------------------------------------------------------------------
const topics = cluster_demand(signals, { max_topics: 12 });
const iris_ev = topics.find(
  (t) => t.specialist_id === 'iris' && t.label.includes('charging'),
);
check('iris EV signals cluster into one topic', iris_ev !== undefined && iris_ev.evidence_count >= 3);
check(
  'iris EV cluster spans signal kinds',
  iris_ev !== undefined && Object.keys(iris_ev.kinds).length >= 2,
);
check(
  'iris EV cluster carries refs',
  iris_ev !== undefined && iris_ev.refs.length >= 3 && iris_ev.refs.every((r) => /^(audit|eval):/.test(r)),
);
const brigid_topic = topics.find((t) => t.specialist_id === 'brigid');
check('brigid cluster exists with sole_user_id=sam', brigid_topic?.sole_user_id === 'sam');
check(
  'iris cluster sole_user_id=jasper (single user)',
  iris_ev?.sole_user_id === 'jasper',
);
check('topics sorted by evidence desc', topics.length >= 2 && topics[0]!.evidence_count >= topics[topics.length - 1]!.evidence_count);

const capped = cluster_demand(signals, { max_topics: 1 });
check('max_topics cap respected', capped.length === 1);

// Determinism: same inputs → same output
const again = mine_knowledge_demand(db, { window_days: 14, now: NOW, max_topics: 12 });
check(
  'deterministic re-run (same labels, same order)',
  JSON.stringify(again.topics.map((t) => t.label)) === JSON.stringify(topics.map((t) => t.label)),
);

// ------------------------------------------------------------------
// 3. The tool wrapper (private_to_hint + audit row)
// ------------------------------------------------------------------
const tool = make_knowledge_demand_report({ db });
const ctx: ToolContext = {
  memory,
  llm: null as unknown as LLMRouter, // tool never touches the LLM
  now: NOW,
  intent_id: ulid(),
  specialist_id: 'cordelia',
  user: { id: 'jasper', tier: 'owner' },
};
const out = await tool.execute({ window_days: 14, max_topics: 12 }, ctx);
check('tool returns mined topics', out.topics.length === topics.length);
const tool_brigid = out.topics.find((t) => t.specialist_id === 'brigid');
check('non-owner sole user surfaces as private_to_hint', tool_brigid?.private_to_hint === 'sam');
const tool_iris = out.topics.find((t) => t.specialist_id === 'iris' && t.label.includes('charging'));
check('owner-only evidence yields NO private_to_hint', tool_iris?.private_to_hint === null);
const audit_row = db
  .prepare(`SELECT COUNT(*) AS n FROM audit_log WHERE tool_name = 'knowledge_demand_report' AND agent = 'cordelia'`)
  .get() as { n: number };
check('tool writes its own audit row', audit_row.n === 1);

// Output schema round-trip (the registry validates this shape).
const parsed = tool.output_schema.safeParse(out);
check('output validates against output_schema', parsed.success);
check(
  'report topics carry a trend_direction',
  out.topics.every((t) => ['growing', 'steady', 'declining', 'new'].includes(t.trend_direction)),
);

// ------------------------------------------------------------------
// 4. Trend split — recent half vs older half of the window
// ------------------------------------------------------------------
// Window 14d, now 2026-06-14 → midpoint 2026-06-07. Each topic is a
// distinct token set + specialist so they cluster separately.
const T_NOW = new Date('2026-06-14T00:00:00Z');
const mk = (sid: string, text: string, ts: string): DemandSignal => ({
  kind: 'search_empty',
  specialist_id: sid,
  text,
  user_id: null,
  ref: `audit:${ulid()}`,
  ts,
});
const trend_signals: DemandSignal[] = [
  // growing: 3 recent, 1 prior
  mk('x', 'alpha widget alpha widget', '2026-06-12T00:00:00Z'),
  mk('x', 'alpha widget alpha widget', '2026-06-11T00:00:00Z'),
  mk('x', 'alpha widget alpha widget', '2026-06-10T00:00:00Z'),
  mk('x', 'alpha widget alpha widget', '2026-06-02T00:00:00Z'),
  // new: 2 recent, 0 prior
  mk('y', 'beta gadget beta gadget', '2026-06-12T00:00:00Z'),
  mk('y', 'beta gadget beta gadget', '2026-06-11T00:00:00Z'),
  // declining: 1 recent, 3 prior
  mk('z', 'gamma sprocket gamma sprocket', '2026-06-10T00:00:00Z'),
  mk('z', 'gamma sprocket gamma sprocket', '2026-06-03T00:00:00Z'),
  mk('z', 'gamma sprocket gamma sprocket', '2026-06-02T00:00:00Z'),
  mk('z', 'gamma sprocket gamma sprocket', '2026-06-01T00:00:00Z'),
  // steady: 1 recent, 1 prior
  mk('w', 'delta cog delta cog', '2026-06-10T00:00:00Z'),
  mk('w', 'delta cog delta cog', '2026-06-02T00:00:00Z'),
];
const trended = cluster_demand(trend_signals, { max_topics: 12, now: T_NOW, window_days: 14 });
const ts_of = (sid: string): string | undefined =>
  trended.find((t) => t.specialist_id === sid)?.trend_direction;
check('growing gap detected (3 recent vs 1 prior)', ts_of('x') === 'growing');
check('new gap detected (all recent)', ts_of('y') === 'new');
check('declining gap detected (1 recent vs 3 prior)', ts_of('z') === 'declining');
check('steady gap detected (1 recent vs 1 prior)', ts_of('w') === 'steady');
check(
  'recent + prior == evidence_count',
  trended.every((t) => t.recent_evidence + t.prior_evidence === t.evidence_count),
);
// No window context supplied → trend not computed → steady.
const no_window = cluster_demand(trend_signals, { max_topics: 12 });
check('no window context → steady', no_window.every((t) => t.trend_direction === 'steady'));

db.close();
rmSync(dir, { recursive: true, force: true });

console.log(
  failures === 0
    ? '\nsmoke:knowledge-demand OK'
    : `\nsmoke:knowledge-demand FAILED (${failures} check(s))`,
);
process.exit(failures === 0 ? 0 : 1);
