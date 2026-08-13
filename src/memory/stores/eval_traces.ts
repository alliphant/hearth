/**
 * EvalTracesStore — the evidence a failing eval leaves behind (2026-08-03).
 *
 * `eval_runs.detail` answers *what* broke, in 1000 chars, for a human skimming
 * a nightly summary. It cannot answer *why*, and "why" is the only thing a fix
 * can honestly be grounded in — which is why the loop has always stopped here
 * and waited for a person: a regression files a `process_miss` and sits.
 *
 * The runtime already produces everything needed. `SpecialistTurnOutput.
 * tool_calls_made` carries each call's NAME, ARGS, RESULT, ERROR, and any
 * recovery `candidates` the tool offered. The harness was projecting all of
 * that down to `{name, errored}` and dropping the rest on the floor. This
 * table keeps it, for failures only.
 *
 * FAILURES ONLY, deliberately. A green trace has no consumer, and writing the
 * whole suite nightly would grow this table by ~150 rows a day to store
 * evidence about things that are working. `record()` is called from the
 * failure branch and nowhere else.
 *
 * Results are PREVIEWED, args are kept whole. A wrong argument is usually the
 * bug and it is almost always small; a tool result is usually incidental and
 * can be enormous. Keeping the asymmetry here means the diagnosis prompt gets
 * the discriminating half at full fidelity.
 */
import { Database } from 'bun:sqlite';
import { ulid } from 'ulid';

/** Per-call evidence, in the shape the runtime already emits. */
export interface TraceCall {
  name: string;
  /** The args the model actually produced — kept WHOLE; this is usually the bug. */
  input: unknown;
  /** Truncated — incidental to most diagnoses and potentially enormous. */
  result_preview?: string;
  error?: string;
  /** Recovery hints the tool offered on failure (`InvokeOutcome.candidates`).
   *  Their ABSENCE is itself a finding: a tool that fails with no actionable
   *  next step is the `grounding_fix` class. */
  candidates?: string[];
}

export interface EvalTrace {
  id: string;
  ts: string;
  task_id: string;
  specialist_id: string;
  /** The harness's own assertion failures, verbatim — the ground truth about
   *  what "wrong" meant here. Never the model's account of itself. */
  failed_assertions: string[];
  reply: string;
  calls: TraceCall[];
  model: string | null;
}

const RESULT_PREVIEW_CHARS = 600;
const REPLY_CHARS = 4_000;

/** Shrink a live tool-call list into storable evidence. */
export function to_trace_calls(
  calls: ReadonlyArray<{ name: string; input?: unknown; result?: unknown; error?: string; candidates?: string[] }>,
): TraceCall[] {
  return calls.map((c) => {
    let preview: string | undefined;
    if (c.result !== undefined) {
      let s: string;
      try {
        s = typeof c.result === 'string' ? c.result : JSON.stringify(c.result);
      } catch {
        s = '(unserializable result)';
      }
      preview = (s ?? '').slice(0, RESULT_PREVIEW_CHARS);
    }
    return {
      name: c.name,
      input: c.input,
      ...(preview !== undefined ? { result_preview: preview } : {}),
      ...(c.error ? { error: String(c.error).slice(0, 1_000) } : {}),
      ...(c.candidates && c.candidates.length > 0 ? { candidates: c.candidates.slice(0, 8) } : {}),
    };
  });
}

function hydrate(r: {
  id: string;
  ts: string;
  task_id: string;
  specialist_id: string;
  failed_assertions_json: string;
  reply: string;
  calls_json: string;
  model: string | null;
}): EvalTrace {
  const parse = <T>(s: string, fallback: T): T => {
    try {
      return JSON.parse(s) as T;
    } catch {
      return fallback;
    }
  };
  return {
    id: r.id,
    ts: r.ts,
    task_id: r.task_id,
    specialist_id: r.specialist_id,
    failed_assertions: parse<string[]>(r.failed_assertions_json, []),
    reply: r.reply,
    calls: parse<TraceCall[]>(r.calls_json, []),
    model: r.model,
  };
}

export class EvalTracesStore {
  constructor(private db: Database) {}

  record(t: Omit<EvalTrace, 'id' | 'ts'>, now = new Date()): string {
    const id = `et_${ulid().toLowerCase().slice(-12)}`;
    this.db
      .prepare(
        `INSERT INTO eval_traces
           (id, ts, task_id, specialist_id, failed_assertions_json, reply, calls_json, model)
         VALUES (@id, @ts, @task, @spec, @fa, @reply, @calls, @model)`,
      )
      .run({
        '@id': id,
        '@ts': now.toISOString(),
        '@task': t.task_id,
        '@spec': t.specialist_id,
        '@fa': JSON.stringify(t.failed_assertions),
        '@reply': t.reply.slice(0, REPLY_CHARS),
        '@calls': JSON.stringify(t.calls),
        '@model': t.model,
      });
    return id;
  }

  /** Most recent traces for one task, newest first. */
  recent_for_task(task_id: string, limit = 3): EvalTrace[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM eval_traces WHERE task_id = @t ORDER BY ts DESC LIMIT @lim`,
        )
        .all({ '@t': task_id, '@lim': Math.min(Math.max(limit, 1), 20) }) as Parameters<typeof hydrate>[0][]
    ).map(hydrate);
  }

  latest_for_task(task_id: string): EvalTrace | null {
    return this.recent_for_task(task_id, 1)[0] ?? null;
  }
}
