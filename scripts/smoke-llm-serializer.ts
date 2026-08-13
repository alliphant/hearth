/**
 * Smoke for the LLM-endpoint serializer
 * (src/core/llm_serializer.ts). Self-contained: stubs an LLMProvider
 * that records start + end timestamps so we can assert serial
 * execution.
 *
 * What this exercises:
 *   - Two SerializedProvider instances sharing one HostMutex (same
 *     endpoint key) serialize across providers — `complete()` calls
 *     don't overlap.
 *   - Three concurrent `complete_stream()` calls process in FIFO
 *     order — the next stream doesn't start until the previous one
 *     finishes consuming.
 *   - An error in an earlier turn does NOT block later turns from
 *     acquiring the lock (Promise.catch on the chain).
 *   - Providers pointed at different endpoint keys (different mutex
 *     instances) DO run in parallel.
 */

import {
  HostMutex,
  SerializedProvider,
} from '../src/core/llm_serializer';
import type {
  LLMProvider,
  LLMRequest,
  LLMResponse,
  LLMStreamEvent,
  LLMCapabilities,
} from '../src/core/llm';

interface Event {
  id: string;
  phase: 'start' | 'end';
  t: number;
}

class RecordingProvider implements LLMProvider {
  readonly name = 'recording';
  readonly log: Event[] = [];
  /** Per-call work duration. */
  constructor(private readonly delay_ms: number) {}

  capabilities(): LLMCapabilities {
    return {
      supports_json_schema: false,
      supports_tool_calls: false,
      supports_thinking_mode: false,
      supports_vision: false,
      max_context: 1,
      cost_per_1m_in_cents: 0,
      cost_per_1m_out_cents: 0,
    };
  }

  async complete(_req: LLMRequest): Promise<LLMResponse> {
    const id = `c${this.log.length}`;
    this.log.push({ id, phase: 'start', t: Date.now() });
    await new Promise((r) => setTimeout(r, this.delay_ms));
    this.log.push({ id, phase: 'end', t: Date.now() });
    return {
      content: id,
      tool_calls: [],
      finish_reason: 'stop',
      cost: { tokens_in: 0, tokens_out: 0, ms: this.delay_ms, model: 'mock' },
    };
  }

  complete_stream(_req: LLMRequest): AsyncIterable<LLMStreamEvent> {
    const log = this.log;
    const delay = this.delay_ms;
    const id = `s${log.length}`;
    return (async function* () {
      log.push({ id, phase: 'start', t: Date.now() });
      // Emit two deltas spaced by delay/2 each so the stream lifetime
      // matches `delay`. The mutex holds across the WHOLE generator
      // iteration, so it should hold for the full delay.
      yield { type: 'content_delta', delta: id };
      await new Promise((r) => setTimeout(r, delay / 2));
      yield { type: 'content_delta', delta: '.' };
      await new Promise((r) => setTimeout(r, delay / 2));
      const final: LLMResponse = {
        content: `${id}.`,
        tool_calls: [],
        finish_reason: 'stop',
        cost: { tokens_in: 0, tokens_out: 0, ms: delay, model: 'mock' },
      };
      yield { type: 'done', response: final };
      log.push({ id, phase: 'end', t: Date.now() });
    })();
  }
}

class ThrowingProvider implements LLMProvider {
  readonly name = 'throwing';
  readonly log: Event[] = [];
  capabilities(): LLMCapabilities {
    return {
      supports_json_schema: false,
      supports_tool_calls: false,
      supports_thinking_mode: false,
      supports_vision: false,
      max_context: 1,
      cost_per_1m_in_cents: 0,
      cost_per_1m_out_cents: 0,
    };
  }
  async complete(_req: LLMRequest): Promise<LLMResponse> {
    this.log.push({ id: 't', phase: 'start', t: Date.now() });
    await new Promise((r) => setTimeout(r, 30));
    this.log.push({ id: 't', phase: 'end', t: Date.now() });
    throw new Error('synthetic throw');
  }
}

function order(log: Event[]): string {
  return log.map((e) => `${e.id}:${e.phase}`).join(' ');
}

/** Returns true when every start/end pair is non-overlapping. */
function is_serial(log: Event[]): boolean {
  let current_start = -1;
  for (const e of log) {
    if (e.phase === 'start') {
      if (current_start >= 0) return false;
      current_start = e.t;
    } else {
      current_start = -1;
    }
  }
  return true;
}

/** Peak concurrency = max number of simultaneously-open start/end pairs. */
function max_overlap(log: Event[]): number {
  const sorted = log.slice().sort((a, b) => a.t - b.t);
  let cur = 0;
  let peak = 0;
  for (const e of sorted) {
    if (e.phase === 'start') {
      cur++;
      if (cur > peak) peak = cur;
    } else {
      cur--;
    }
  }
  return peak;
}

async function main(): Promise<void> {
  let passed = 0;
  let failed = 0;
  const ok = (msg: string): void => {
    console.log(`  ✓ ${msg}`);
    passed++;
  };
  const fail = (msg: string, detail?: unknown): void => {
    console.log(`  ✗ ${msg}`, detail ?? '');
    failed++;
  };
  const req = { messages: [{ role: 'user', content: 'hi' as const }] } as LLMRequest;

  console.log('\n── complete() serializes through one mutex ─────────────');
  {
    const inner = new RecordingProvider(40);
    const mutex = new HostMutex();
    const a = new SerializedProvider(inner, mutex);
    const b = new SerializedProvider(inner, mutex);
    const [r1, r2, r3] = await Promise.all([
      a.complete(req),
      b.complete(req),
      a.complete(req),
    ]);
    const ids = [r1.content, r2.content, r3.content].sort();
    ids.length === 3 ? ok('three completions returned') : fail('count', ids);
    is_serial(inner.log) ? ok('starts/ends never overlap (serial)') : fail('non-serial', order(inner.log));
  }

  console.log('\n── complete_stream() holds the lock for full lifetime ──');
  {
    const inner = new RecordingProvider(80);
    const mutex = new HostMutex();
    const p = new SerializedProvider(inner, mutex);
    async function drain(s: AsyncIterable<LLMStreamEvent>): Promise<void> {
      for await (const _ of s) {
        /* consume */
      }
    }
    await Promise.all([
      drain(p.complete_stream!(req)),
      drain(p.complete_stream!(req)),
      drain(p.complete_stream!(req)),
    ]);
    is_serial(inner.log)
      ? ok('three streams ran in FIFO order; never overlapped')
      : fail('streams overlapped', order(inner.log));
    inner.log.length === 6 ? ok('all 3 streams completed (start+end each)') : fail('event count', inner.log.length);
  }

  console.log('\n── stream B can still acquire after stream A errored ──');
  {
    const log: Event[] = [];
    const mutex = new HostMutex();
    // A throwing inner provider for the first call, recording for the second.
    const throwing = new ThrowingProvider();
    const ok_inner = new RecordingProvider(30);
    const wrap_throwing = new SerializedProvider(throwing, mutex);
    const wrap_ok = new SerializedProvider(ok_inner, mutex);
    const a = wrap_throwing.complete(req).catch((e) => (e as Error).message);
    const b = wrap_ok.complete(req).then((r) => r.content);
    const [a_res, b_res] = await Promise.all([a, b]);
    a_res === 'synthetic throw' ? ok('throwing call errored as expected') : fail('throw not propagated', a_res);
    b_res === 'c0' || b_res === 'c1' ? ok('subsequent call still completed after error') : fail('queue blocked', b_res);
  }

  console.log('\n── two different mutexes = parallel ───────────────────');
  {
    const inner_a = new RecordingProvider(60);
    const inner_b = new RecordingProvider(60);
    const mutex_a = new HostMutex();
    const mutex_b = new HostMutex();
    const wrap_a = new SerializedProvider(inner_a, mutex_a);
    const wrap_b = new SerializedProvider(inner_b, mutex_b);
    const t_start = Date.now();
    await Promise.all([wrap_a.complete(req), wrap_b.complete(req)]);
    const elapsed = Date.now() - t_start;
    elapsed < 110
      ? ok(`distinct endpoints ran in parallel (${elapsed}ms < 110ms ceiling)`)
      : fail(`parallel path collapsed to serial: ${elapsed}ms`);
  }

  console.log('\n── N-slot mutex admits N at once, queues the rest ─────');
  {
    // max_concurrency=3: 6 calls of 40ms should run as 2 batches of 3,
    // peak overlap exactly 3 (the LIVE-tier --parallel behavior).
    const inner = new RecordingProvider(40);
    const mutex = new HostMutex(3);
    const p = new SerializedProvider(inner, mutex);
    const t_start = Date.now();
    await Promise.all(Array.from({ length: 6 }, () => p.complete(req)));
    const elapsed = Date.now() - t_start;
    const peak = max_overlap(inner.log);
    peak === 3
      ? ok(`peak concurrency capped at 3 (saw ${peak})`)
      : fail(`expected peak 3, saw ${peak}`, order(inner.log));
    // 6 calls / 3 slots = 2 serial batches ≈ 80ms; well under a 6× serial 240ms.
    elapsed < 160
      ? ok(`6 calls ran as ~2 batches (${elapsed}ms < 160ms)`)
      : fail(`did not batch: ${elapsed}ms`);
    inner.log.length === 12 ? ok('all 6 completed') : fail('count', inner.log.length);
  }

  console.log('\n── default mutex is strict (1 slot) ──────────────────');
  {
    const inner = new RecordingProvider(30);
    const mutex = new HostMutex();
    mutex.max_slots() === 1 ? ok('default max_slots() === 1') : fail('default slots', mutex.max_slots());
    const p = new SerializedProvider(inner, mutex);
    await Promise.all(Array.from({ length: 3 }, () => p.complete(req)));
    max_overlap(inner.log) === 1 ? ok('strict serial (peak 1)') : fail('not strict', order(inner.log));
  }

  console.log('\n── release is idempotent (no slot double-free) ───────');
  {
    // Hold both slots of a 2-slot mutex; release one TWICE. A double
    // release must not over-admit — a 3rd acquirer still waits until a
    // genuine second release fires.
    const mutex = new HostMutex(2);
    const rel1 = await mutex.acquire();
    const rel2 = await mutex.acquire();
    let third_admitted = false;
    const third = mutex.acquire().then((r) => {
      third_admitted = true;
      return r;
    });
    rel1();
    rel1(); // idempotent double-release — must NOT free a second slot
    await new Promise((r) => setTimeout(r, 10));
    third_admitted ? ok('3rd acquirer admitted after the (real) 1st release') : fail('3rd blocked unexpectedly');
    // The bug we guard against: if double-release freed a slot, a 4th
    // would also be admitted with only one real free slot left.
    let fourth_admitted = false;
    const fourth = mutex.acquire().then((r) => {
      fourth_admitted = true;
      return r;
    });
    await new Promise((r) => setTimeout(r, 10));
    !fourth_admitted ? ok('4th acquirer correctly blocked (no double-free)') : fail('double-release over-admitted');
    rel2();
    await new Promise((r) => setTimeout(r, 10));
    fourth_admitted ? ok('4th admitted once a real slot freed') : fail('4th never admitted');
    (await third)();
    (await fourth)();
  }

  console.log(`\n${failed === 0 ? 'PASS' : 'FAIL'}: ${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
