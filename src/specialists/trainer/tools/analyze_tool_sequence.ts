/**
 * analyze_tool_sequence — Beatrice's raw-signal lens on a specialist's
 * tool-calling behavior. Where analyze_systemic_pattern reads CURATED
 * process_misses, this reads the raw audit_log for one specialist and
 * surfaces the shapes that don't show up as a miss: path-guessing spirals,
 * duplicate calls, failure-guard markers, and whether the specialist
 * parallelizes independent lookups or strings them out one at a time.
 *
 * This is the tool that would have let Beatrice diagnose her OWN punt — a
 * turn with 13 tool calls, repeated reads of the same dead paths, and a
 * ghost_promise_guard marker is exactly a "same_tool_spiral" she can now see
 * and fix (grant a locate tool, add research_workload, tighten a persona).
 *
 * Read-only. Walks audit_log only; no writes.
 */
import { z } from 'zod';
import type { Database } from 'bun:sqlite';
import type { Tool, ToolContext } from '@core/tool';
import type { ToolDeps } from '@core/tool_deps';

// Audit rows that are runtime guards, not real tool calls. They are the
// canonical failure-shape signal — count them, don't treat them as work.
const MARKER_NAMES = new Set([
  'ghost_promise_guard',
  'same_tool_spiral_exhaust',
  'blank_turn_fallback',
  'duplicate_tool_call',
]);
// The per-turn LLM row (carries conversation_id); a turn boundary, not a tool.
const TURN_ROW = 'specialist_turn';
// Tool calls landing within this window of each other in one turn are treated
// as a parallel fan-out (the research_workload archetype's intended shape).
const PARALLEL_WINDOW_MS = 1500;

function is_marker(tool_name: string): boolean {
  return MARKER_NAMES.has(tool_name) || /(_guard|_spiral|_exhaust|fallback)/i.test(tool_name);
}

const InputSchema = z.object({
  specialist_id: z.string().min(1),
  hours_back: z.coerce.number().int().positive().max(720).default(24),
});

const NameCount = z.object({ name: z.string(), count: z.number() });

const HotTurn = z.object({
  intent_id: z.string(),
  tool_calls: z.number(),
  span_seconds: z.number(),
  duplicate_calls: z.number(),
  markers: z.array(z.string()),
});

const OutputSchema = z.object({
  specialist_id: z.string(),
  hours_back: z.number(),
  window_start: z.string(),
  total_rows: z.number(),
  turns: z.number(),
  tool_call_rows: z.number(),
  failure_rows: z.number(),
  parallel_clusters: z.number(),
  parallelized_calls: z.number(),
  sequential_calls: z.number(),
  duplicate_calls: z.number(),
  failure_markers: z.array(NameCount),
  top_tools: z.array(NameCount),
  hot_turns: z.array(HotTurn),
  summary: z.array(z.string()),
});

type Input = z.infer<typeof InputSchema>;
type Output = z.infer<typeof OutputSchema>;

interface Row {
  ts: string;
  intent_id: string;
  tool_name: string;
  tool_input: string | null;
  error: string | null;
}

function ms(ts: string): number {
  const t = new Date(ts).getTime();
  return Number.isFinite(t) ? t : 0;
}

export function make_analyze_tool_sequence(db: Database): Tool<Input, Output> {
  return {
    name: 'analyze_tool_sequence',
    description:
      "Read the raw audit_log for ONE specialist over the last N hours and report its tool-calling SHAPE: total tool calls, failures, duplicate calls (same tool+args repeated in a turn), failure-guard markers (ghost_promise_guard / same_tool_spiral_exhaust / blank_turn_fallback), how often it parallelizes independent lookups vs strings them out, the busiest 'hot' turns, and the most-called tools. Use this to diagnose a behavior that doesn't surface as a process_miss — a path-guessing spiral, a turn that exhausted its round budget, a tool nobody parallelizes. Args: specialist_id, hours_back (default 24). Read-only.",
    risk: 'read',
    required_capabilities: ['read_audit_log'],
    input_schema: InputSchema,
    output_schema: OutputSchema,

    idempotency_key(input) {
      return `analyze_tool_sequence:${input.specialist_id}:${input.hours_back}`;
    },

    async execute(input, _ctx: ToolContext): Promise<Output> {
      const window_start = new Date(Date.now() - input.hours_back * 3_600_000).toISOString();
      const rows = db
        .prepare(
          `SELECT ts, intent_id, tool_name, tool_input, error
           FROM audit_log
           WHERE agent = @agent AND ts >= @since
           ORDER BY ts ASC`,
        )
        .all({ '@agent': input.specialist_id, '@since': window_start }) as Row[];

      const by_turn = new Map<string, Row[]>();
      const tool_counts = new Map<string, number>();
      const marker_counts = new Map<string, number>();
      let tool_call_rows = 0;
      let failure_rows = 0;
      const turn_ids = new Set<string>();

      for (const r of rows) {
        if (r.tool_name === TURN_ROW) {
          turn_ids.add(r.intent_id);
          continue;
        }
        if (is_marker(r.tool_name)) {
          marker_counts.set(r.tool_name, (marker_counts.get(r.tool_name) ?? 0) + 1);
          continue;
        }
        tool_call_rows++;
        if (r.error && r.error.trim() !== '') failure_rows++;
        tool_counts.set(r.tool_name, (tool_counts.get(r.tool_name) ?? 0) + 1);
        turn_ids.add(r.intent_id);
        const arr = by_turn.get(r.intent_id) ?? [];
        arr.push(r);
        by_turn.set(r.intent_id, arr);
      }

      // Per-turn shape: duplicates + parallel clustering.
      let duplicate_calls = 0;
      let parallel_clusters = 0;
      let parallelized_calls = 0;
      const hot_turns: Output['hot_turns'] = [];

      for (const [intent_id, calls] of by_turn) {
        // Duplicates: same tool_name + tool_input seen more than once.
        const seen = new Map<string, number>();
        for (const c of calls) {
          const key = `${c.tool_name}|${c.tool_input ?? ''}`;
          const n = (seen.get(key) ?? 0) + 1;
          seen.set(key, n);
          if (n > 1) duplicate_calls++;
        }
        // Parallel clustering over ts (calls already globally ts-sorted).
        let i = 0;
        while (i < calls.length) {
          let j = i + 1;
          while (j < calls.length && ms(calls[j]!.ts) - ms(calls[j - 1]!.ts) <= PARALLEL_WINDOW_MS) {
            j++;
          }
          const size = j - i;
          if (size >= 2) {
            parallel_clusters++;
            parallelized_calls += size;
          }
          i = j;
        }
        const span_seconds =
          calls.length > 1 ? Math.round((ms(calls[calls.length - 1]!.ts) - ms(calls[0]!.ts)) / 1000) : 0;
        const turn_dups = [...seen.values()].filter((n) => n > 1).reduce((a, n) => a + (n - 1), 0);
        const turn_markers: string[] = [];
        for (const r of rows) {
          if (r.intent_id === intent_id && is_marker(r.tool_name)) turn_markers.push(r.tool_name);
        }
        hot_turns.push({
          intent_id,
          tool_calls: calls.length,
          span_seconds,
          duplicate_calls: turn_dups,
          markers: turn_markers,
        });
      }

      hot_turns.sort((a, b) => b.tool_calls - a.tool_calls);
      const top_hot = hot_turns.slice(0, 5);

      const sequential_calls = tool_call_rows - parallelized_calls;
      const top_tools = [...tool_counts.entries()]
        .map(([name, count]) => ({ name, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 10);
      const failure_markers = [...marker_counts.entries()]
        .map(([name, count]) => ({ name, count }))
        .sort((a, b) => b.count - a.count);

      // Human-readable diagnostic lines so Beatrice can cite specifics.
      const summary: string[] = [];
      summary.push(
        `${input.specialist_id}: ${tool_call_rows} tool calls across ${turn_ids.size} turns in the last ${input.hours_back}h` +
          (rows.length === 0 ? ' — no audit rows in window (tool never called, or wrong specialist_id).' : '.'),
      );
      if (failure_rows > 0) {
        const pct = Math.round((failure_rows / Math.max(1, tool_call_rows)) * 100);
        summary.push(`${failure_rows} calls errored (${pct}%).`);
      }
      if (duplicate_calls > 0) {
        summary.push(
          `${duplicate_calls} duplicate calls (same tool + args repeated within a turn) — a re-read/retry spiral; check for a missing locate/search affordance.`,
        );
      }
      if (failure_markers.length > 0) {
        summary.push(
          'failure markers: ' + failure_markers.map((m) => `${m.name}×${m.count}`).join(', ') + '.',
        );
      }
      if (tool_call_rows > 0) {
        const ppct = Math.round((parallelized_calls / tool_call_rows) * 100);
        summary.push(
          `${ppct}% of calls were parallelized (${parallel_clusters} fan-out clusters); ${sequential_calls} ran sequentially.`,
        );
      }
      const worst = top_hot[0];
      if (worst && worst.tool_calls >= 6) {
        summary.push(
          `hottest turn ${worst.intent_id.slice(0, 8)}: ${worst.tool_calls} calls over ${worst.span_seconds}s` +
            (worst.duplicate_calls > 0 ? `, ${worst.duplicate_calls} duplicates` : '') +
            (worst.markers.length > 0 ? `, markers: ${worst.markers.join('/')}` : '') +
            ' — inspect this turn for a spiral.',
        );
      }

      return {
        specialist_id: input.specialist_id,
        hours_back: input.hours_back,
        window_start,
        total_rows: rows.length,
        turns: turn_ids.size,
        tool_call_rows,
        failure_rows,
        parallel_clusters,
        parallelized_calls,
        sequential_calls,
        duplicate_calls,
        failure_markers,
        top_tools,
        hot_turns: top_hot,
        summary,
      };
    },
  };
}

/** ToolLoader entry point. */
export function create(deps: ToolDeps): Tool {
  return make_analyze_tool_sequence(deps.db) as Tool;
}
