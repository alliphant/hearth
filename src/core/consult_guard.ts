/**
 * Consult-spiral guard (2026-08-05) — structural bounds on the
 * consult_specialist GENERATING loop.
 *
 * On 2026-08-04 a process review put trainer and Ruby into a consult
 * ping-pong: 122 near-identical `question` rows plus 125 `consult_response`
 * rows from trainer into Ruby's inbox in one day, most of them inside an
 * eight-minute burst (21:31–21:39Z). Two structural holes made it possible:
 *
 *   1. `consult_specialist` is appended to EVERY turn's tool surface —
 *      including the consultee's ephemeral consult sub-turn — and
 *      `SpecialistRuntime.consult()` carried no depth, so A→B→A→B could
 *      recurse until something else died. Each level pushes two inbox rows,
 *      so a fast-failing chain floods the ledger in minutes.
 *   2. The consult dispatch path `continue`s BEFORE the per-turn
 *      (tool, input) dedup cache, so re-asking the identical question —
 *      what a context-trimmed consultor does naturally (trainer logged 78
 *      prompt_window_trimmed rows in the same 48h) — re-ran the full
 *      consult every time: sub-turn, GPU, and two more rows.
 *
 * The 2026-08-05 recipient-side fix (render duplicate collapse + the 12k
 * inbox budget in deliberation.ts) bounds the DAMAGE; this module bounds
 * the SOURCE. Three independent checks, all evaluated inside the consult
 * tool the model chose to call (LAW #1: determinism inside a chosen tool,
 * never special-casing around the model), all failing toward "answer from
 * what you already have" so the turn still completes:
 *
 *   - DEPTH: a consult sub-turn may consult further only while the chain
 *     is shallower than HEARTH_CONSULT_MAX_DEPTH (default 2). Depth 2
 *     keeps the legitimate relay (Kate → trainer → the domain owner)
 *     while making unbounded ping-pong impossible.
 *   - REPEAT: the identical (consultor, consultee, normalized question)
 *     within HEARTH_CONSULT_REPEAT_WINDOW_MIN (default 30) is served the
 *     PRIOR answer verbatim, clearly labeled — no sub-turn, no inbox rows.
 *     Only real answers are cached; a failed consult ("produced no
 *     answer") stays retryable, bounded by the rate cap below.
 *   - RATE: more than HEARTH_CONSULT_RATE_MAX (default 6) consults from
 *     one consultor to one consultee inside
 *     HEARTH_CONSULT_RATE_WINDOW_MIN (default 10) minutes — counting
 *     suppressed repeats, so a hammering loop escalates here — returns an
 *     instructive refusal. This is the content-agnostic backstop that
 *     catches NEAR-identical rewordings the hash can't.
 *
 * State is in-process and bounded (LRU-ish caps below): a restart clears
 * it, which is fine — the guard exists to stop minutes-scale spirals, not
 * to be a durable ledger. Kill switch: HEARTH_CONSULT_GUARD=0.
 */

import { createHash } from 'node:crypto';

function int_env(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/** Guard master switch. Skipped under HEARTH_TEST_MODE like the other
 *  turn guards — fixture-driven smokes don't ground their consults. */
export function consult_guard_enabled(): boolean {
  return (
    process.env.HEARTH_CONSULT_GUARD !== '0' &&
    process.env.HEARTH_TEST_MODE !== '1'
  );
}

export function consult_max_depth(): number {
  return int_env('HEARTH_CONSULT_MAX_DEPTH', 2);
}
export function consult_repeat_window_ms(): number {
  return int_env('HEARTH_CONSULT_REPEAT_WINDOW_MIN', 30) * 60_000;
}
export function consult_rate_max(): number {
  return int_env('HEARTH_CONSULT_RATE_MAX', 6);
}
export function consult_rate_window_ms(): number {
  return int_env('HEARTH_CONSULT_RATE_WINDOW_MIN', 10) * 60_000;
}

/** Bound on remembered pairs/answers — spiral state is small and recent by
 *  definition; when the maps outgrow this, the oldest entries fall off. */
const MAX_TRACKED = 512;

export type ConsultVerdict =
  | { kind: 'proceed' }
  | { kind: 'depth_exceeded'; depth: number; max: number }
  | { kind: 'repeat'; prior_answer: string; asked_min_ago: number }
  | { kind: 'rate_limited'; count: number; window_min: number };

/** Whitespace/case-insensitive question identity: the spiral's re-asks are
 *  verbatim or reflowed, and this catches both without pretending to do
 *  semantic matching (that's the rate cap's job). */
export function normalize_question(q: string): string {
  return q.toLowerCase().replace(/\s+/g, ' ').trim();
}

function qhash(consultor_id: string, consultee_id: string, question: string): string {
  return createHash('sha1')
    .update(`${consultor_id}\0${consultee_id}\0${normalize_question(question)}`)
    .digest('hex');
}

function pair_key(consultor_id: string, consultee_id: string): string {
  return `${consultor_id}\0${consultee_id}`;
}

function prune_oldest<K, V>(map: Map<K, V>, ts_of: (v: V) => number): void {
  if (map.size <= MAX_TRACKED) return;
  const entries = [...map.entries()].sort((a, b) => ts_of(a[1]) - ts_of(b[1]));
  for (const [k] of entries.slice(0, map.size - MAX_TRACKED)) map.delete(k);
}

export interface ConsultAttempt {
  consultor_id: string;
  consultee_id: string;
  question: string;
  /** Nesting depth of the turn making this consult: 0 = a normal chat or
   *  deliberation turn, 1 = inside one consult sub-turn, and so on. */
  depth: number;
  /** Clock injection for tests; defaults to Date.now(). */
  now?: number;
}

export class ConsultGuard {
  /** qhash → the last real answer for that exact question. */
  private answers = new Map<string, { ts: number; answer: string }>();
  /** consultor→consultee pair → attempt timestamps inside the rate window. */
  private attempts = new Map<string, number[]>();

  check(a: ConsultAttempt): ConsultVerdict {
    const now = a.now ?? Date.now();
    const max = consult_max_depth();
    if (a.depth >= max) {
      return { kind: 'depth_exceeded', depth: a.depth, max };
    }

    // Count EVERY attempt — including ones the repeat check will suppress —
    // so a loop that hammers one question escalates from cached replies to
    // the hard rate message instead of getting the cache forever.
    const pk = pair_key(a.consultor_id, a.consultee_id);
    const window = consult_rate_window_ms();
    const kept = (this.attempts.get(pk) ?? []).filter((t) => now - t < window);
    kept.push(now);
    this.attempts.set(pk, kept);
    prune_oldest(this.attempts, (v) => v[v.length - 1] ?? 0);
    if (kept.length > consult_rate_max()) {
      return {
        kind: 'rate_limited',
        count: kept.length,
        window_min: Math.round(window / 60_000),
      };
    }

    const hit = this.answers.get(qhash(a.consultor_id, a.consultee_id, a.question));
    if (hit && now - hit.ts <= consult_repeat_window_ms()) {
      return {
        kind: 'repeat',
        prior_answer: hit.answer,
        asked_min_ago: Math.max(1, Math.round((now - hit.ts) / 60_000)),
      };
    }
    return { kind: 'proceed' };
  }

  /** Cache a consult's REAL answer for the repeat check. Callers must skip
   *  this for empty/failed turns — a "[X produced no answer …]" diagnostic
   *  served from cache would turn one transient failure into a 30-minute
   *  outage for that question. */
  record_answer(a: Omit<ConsultAttempt, 'depth'> & { answer: string }): void {
    const now = a.now ?? Date.now();
    this.answers.set(qhash(a.consultor_id, a.consultee_id, a.question), {
      ts: now,
      answer: a.answer,
    });
    prune_oldest(this.answers, (v) => v.ts);
  }
}

/**
 * The tool-result string a blocked consult returns to the CALLING model.
 * Bracketed like the existing consult errors, and each variant ends in the
 * action that closes the loop — the guard's job is to end the spiral with
 * the model still able to finish its turn, not to strand it.
 */
export function consult_verdict_message(v: ConsultVerdict, consultee_name: string): string {
  switch (v.kind) {
    case 'proceed':
      return '';
    case 'depth_exceeded':
      return (
        `[consult error: consult chain too deep — this turn is already ${v.depth} ` +
        `consult${v.depth === 1 ? '' : 's'} deep (max ${v.max}). Do not consult further from here: ` +
        `answer from what this turn has already gathered, and if something is truly ` +
        `unknowable say so in your reply.]`
      );
    case 'repeat':
      return (
        `[repeat consult suppressed — you asked ${consultee_name} this exact question ` +
        `${v.asked_min_ago} min ago. Their answer is repeated below; act on it. ` +
        `Do NOT re-ask.]\n\n${v.prior_answer}`
      );
    case 'rate_limited':
      return (
        `[consult rate limit: ${v.count} consults from you to ${consultee_name} in the ` +
        `last ${v.window_min} min. Stop consulting ${consultee_name} — synthesize from ` +
        `the answers you already have, and finish your reply stating anything still ` +
        `unknown rather than asking again.]`
      );
  }
}
