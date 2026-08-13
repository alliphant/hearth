/**
 * Benchmark — tool-output compression Phase 1.
 *
 * Replays the LAST N real audit rows for the bulky connector tools
 * (`web_fetch_clean`, `browse_url`, `web_search`, `read_note`,
 * `search_library`) through the new smart truncator and compares
 * against the prior fixed-head behavior (4000-char slice). Reports
 * per-tool byte reduction, signal-line preservation, and aggregate
 * cumulative win across a research-turn-sized window.
 *
 * Read-only: opens hearth.db in readonly mode, never writes.
 *
 *   bun run bench:compaction
 */

import { Database } from 'bun:sqlite';
import {
  TOOL_RESULT_DEFAULT_BUDGET,
  compact_tool_result,
  project_tool_result_for_llm,
} from '@core/tool_result_compaction';
import { web_fetch_clean } from '@connectors/firecrawl';
import { browse_url } from '@connectors/avalanche';
import type { Tool } from '@core/tool';

interface AuditRow {
  tool_name: string;
  agent: string;
  execution_result: string;
  ts: string;
}

/**
 * Simulate the PRE-Phase-1 truncator: head-only slice to cap-240 with
 * a fixed marker appended. This was the exact behavior of the prior
 * `_compact_for_context` in specialist_runtime.ts.
 */
function legacy_compact(serialized: string, cap = 4000): string {
  if (serialized.length <= cap) return serialized;
  const hidden = serialized.length - (cap - 240);
  return (
    serialized.slice(0, cap - 240) +
    `\n\n[...truncated for context efficiency — ${hidden} chars hidden. ` +
    `If you need deeper detail from this result, the full body is in ` +
    `your audit log; ask the user to point you at the specific section ` +
    `or call a different tool that targets it.]`
  );
}

const TOOL_LOOKUP: Record<string, Tool | undefined> = {
  web_fetch_clean: web_fetch_clean as Tool,
  browse_url: browse_url as Tool,
  // The rest fall through to the default budget (no per-tool override).
  web_search: undefined,
  search_library: undefined,
  read_note: undefined,
};

function fmt_bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

function fmt_pct(part: number, whole: number): string {
  if (whole === 0) return '0.0%';
  return `${((1 - part / whole) * 100).toFixed(1)}%`;
}

async function main(): Promise<void> {
  const db = new Database('data/hearth.db', { readonly: true });
  const rows = db
    .query(
      `SELECT tool_name, agent, execution_result, ts
       FROM audit_log
       WHERE execution_result IS NOT NULL
         AND tool_name IN ('web_fetch_clean', 'browse_url', 'web_search',
                           'search_library', 'read_note')
       ORDER BY ts DESC
       LIMIT 500`,
    )
    .all() as AuditRow[];

  console.log(`Replaying ${rows.length} audit rows through both truncators.\n`);

  type Bucket = {
    n: number;
    raw_bytes: number;
    legacy_bytes: number;
    new_bytes: number;
    new_marker_count: number;
  };
  const per_tool = new Map<string, Bucket>();
  const totals: Bucket = {
    n: 0,
    raw_bytes: 0,
    legacy_bytes: 0,
    new_bytes: 0,
    new_marker_count: 0,
  };

  for (const r of rows) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(r.execution_result);
    } catch {
      parsed = r.execution_result;
    }
    const raw = JSON.stringify(parsed);
    const legacy = legacy_compact(raw, TOOL_RESULT_DEFAULT_BUDGET);
    const tool = TOOL_LOOKUP[r.tool_name];
    const new_out = project_tool_result_for_llm(parsed, tool);

    const bucket = per_tool.get(r.tool_name) ?? {
      n: 0,
      raw_bytes: 0,
      legacy_bytes: 0,
      new_bytes: 0,
      new_marker_count: 0,
    };
    bucket.n += 1;
    bucket.raw_bytes += raw.length;
    bucket.legacy_bytes += legacy.length;
    bucket.new_bytes += new_out.length;
    if (new_out.includes('[...truncated')) bucket.new_marker_count += 1;
    per_tool.set(r.tool_name, bucket);

    totals.n += 1;
    totals.raw_bytes += raw.length;
    totals.legacy_bytes += legacy.length;
    totals.new_bytes += new_out.length;
    if (new_out.includes('[...truncated')) totals.new_marker_count += 1;
  }

  console.log(
    'Per-tool — cumulative bytes fed to the LLM across all replayed calls:',
  );
  console.log(
    '┌──────────────────┬──────┬──────────────┬──────────────┬─────────────┬─────────────┐',
  );
  console.log(
    '│ tool             │   n  │     raw      │   legacy*    │     new     │ savings vs  │',
  );
  console.log(
    '│                  │      │              │              │             │   legacy    │',
  );
  console.log(
    '├──────────────────┼──────┼──────────────┼──────────────┼─────────────┼─────────────┤',
  );
  const sorted = Array.from(per_tool.entries()).sort(
    (a, b) => b[1].raw_bytes - a[1].raw_bytes,
  );
  for (const [name, b] of sorted) {
    console.log(
      `│ ${name.padEnd(16)} │ ${String(b.n).padStart(4)} │ ` +
        `${fmt_bytes(b.raw_bytes).padStart(12)} │ ` +
        `${fmt_bytes(b.legacy_bytes).padStart(12)} │ ` +
        `${fmt_bytes(b.new_bytes).padStart(11)} │ ` +
        `${fmt_pct(b.new_bytes, b.legacy_bytes).padStart(11)} │`,
    );
  }
  console.log(
    '└──────────────────┴──────┴──────────────┴──────────────┴─────────────┴─────────────┘',
  );
  console.log(
    `   * legacy = the prior fixed-head _compact_for_context (4000-char slice + marker)\n`,
  );

  console.log('Aggregate:');
  console.log(`  rows replayed:     ${totals.n}`);
  console.log(`  raw bytes:         ${fmt_bytes(totals.raw_bytes)}`);
  console.log(`  legacy bytes:      ${fmt_bytes(totals.legacy_bytes)}`);
  console.log(`  new bytes:         ${fmt_bytes(totals.new_bytes)}`);
  console.log(
    `  reduction (raw→new):    ${fmt_pct(totals.new_bytes, totals.raw_bytes)}`,
  );
  console.log(
    `  reduction (legacy→new): ${fmt_pct(totals.new_bytes, totals.legacy_bytes)}  ← Phase 1 target: ≥60%`,
  );
  console.log(`  truncation triggered:   ${totals.new_marker_count} / ${totals.n} rows`);

  // ── Worst-case single-fetch: how much did the largest result shrink?
  let worst: AuditRow | null = null;
  let worst_raw = 0;
  for (const r of rows) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(r.execution_result);
    } catch {
      parsed = r.execution_result;
    }
    const raw = JSON.stringify(parsed).length;
    if (raw > worst_raw) {
      worst_raw = raw;
      worst = r;
    }
  }
  if (worst) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(worst.execution_result);
    } catch {
      parsed = worst.execution_result;
    }
    const raw = JSON.stringify(parsed);
    const legacy = legacy_compact(raw, TOOL_RESULT_DEFAULT_BUDGET);
    const tool = TOOL_LOOKUP[worst.tool_name];
    const new_out = project_tool_result_for_llm(parsed, tool);
    console.log(`\nLargest single result in window:`);
    console.log(`  tool:          ${worst.tool_name} (${worst.agent})`);
    console.log(`  ts:            ${worst.ts}`);
    console.log(`  raw size:      ${fmt_bytes(raw.length)}`);
    console.log(`  legacy size:   ${fmt_bytes(legacy.length)}`);
    console.log(`  new size:      ${fmt_bytes(new_out.length)}`);
    console.log(
      `  ratio raw→new: ${(new_out.length / raw.length * 100).toFixed(2)}% of raw`,
    );
  }

  // ── Research-turn simulation: take the 8 largest bulky-tool rows
  // ──  (the rough shape of a Maggie research turn) and report the
  // ──  cumulative legacy vs new context bytes the LLM would see.
  const bulky = rows
    .filter((r) => r.tool_name === 'web_fetch_clean' || r.tool_name === 'browse_url')
    .slice()
    .sort((a, b) => b.execution_result.length - a.execution_result.length)
    .slice(0, 8);
  if (bulky.length > 0) {
    let sim_raw = 0;
    let sim_legacy = 0;
    let sim_new = 0;
    for (const r of bulky) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(r.execution_result);
      } catch {
        parsed = r.execution_result;
      }
      const raw = JSON.stringify(parsed);
      sim_raw += raw.length;
      sim_legacy += legacy_compact(raw, TOOL_RESULT_DEFAULT_BUDGET).length;
      sim_new += project_tool_result_for_llm(parsed, TOOL_LOOKUP[r.tool_name]).length;
    }
    console.log(`\nResearch-turn simulation (top-${bulky.length} bulky fetches, mimicking one Maggie turn):`);
    console.log(`  raw total:       ${fmt_bytes(sim_raw)}`);
    console.log(`  legacy total:    ${fmt_bytes(sim_legacy)}`);
    console.log(`  new total:       ${fmt_bytes(sim_new)}`);
    console.log(
      `  legacy→new win:  ${fmt_pct(sim_new, sim_legacy)} reduction in LLM-facing context`,
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
