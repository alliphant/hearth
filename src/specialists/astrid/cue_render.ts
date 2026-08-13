/**
 * Grounded LLM render for live workout cues (Live Ride Companion
 * Phase 1 — docs/design-astrid-live-companion.md §6.2).
 *
 * Takes a deterministic trigger hit + an evidence object and asks the
 * interactive tier to phrase ONE short spoken cue in Astrid's voice.
 * Two hard properties:
 *
 *   - FAIL-OPEN: any LLM error / timeout / over-length / empty result
 *     returns null and the caller falls back to the hit's deterministic
 *     template. A coaching beat is never missed because inference
 *     hiccuped.
 *   - NUMERIC GROUNDING: every number ≥ 16 in the rendered text must
 *     match a number derivable from the evidence (rounding-tolerant,
 *     unit-aware: meters→km, seconds→minutes, pace→km/h). A reply that
 *     fabricates a figure is rejected → fallback. Small integers (≤15)
 *     are exempt — HR zones, "2 more", "5 minutes" phrasing.
 *
 * The render prompt allows digits in the output (the TTS reads digits
 * naturally) precisely so this check stays deterministic.
 */

import type { LLMRouter } from '@core/llm';

export interface CueRenderInput {
  trigger: string;
  /** Trigger class — tints the register (effort pushes, care soothes,
   *  narrative paints, progress celebrates, wrap_up winds down). */
  cls?: string;
  user_display: string;
  workout_type: string;
  /** Live metrics at the moment of the cue. */
  snapshot: Record<string, number | string | null>;
  /** The detector's computed facts — why this moment matters. */
  facts: Record<string, unknown>;
  /** PR shelf values for this workout type, when present. */
  personal_records?: Record<string, unknown> | null;
  /** 30-day comparable-workout digest, when loaded. */
  last_30_days?: Record<string, unknown> | null;
  /** Per-10-min session curve (avg HR, speed, climb) — grounded color
   *  for "you've been building for half an hour"-class lines. */
  session_curve?: Array<Record<string, number | string | null>> | null;
  /** Stops so far this session ({count, total_min}). */
  stops?: Record<string, number> | null;
  /** Recognized route context ({times_ridden, best_min, name?}). */
  route?: Record<string, unknown> | null;
}

const CLASS_REGISTER: Record<string, string> = {
  effort: 'This is an EFFORT moment — punchy and direct, push them.',
  care: 'This is a CARE moment — gentle, practical, zero drama.',
  narrative: 'This is a NARRATIVE moment — one vivid, storyteller line.',
  progress: 'This is a PROGRESS moment — celebrate briefly, point forward.',
  wrap_up: 'This is a WRAP-UP moment — warm, proud, winding down.',
  presence: 'This is a PRESENCE beat — companionable and brief.',
};

const MAX_CUE_CHARS = 320;
const SMALL_NUMBER_EXEMPT = 15;

function system_prompt(input: CueRenderInput): string {
  const register = (input.cls && CLASS_REGISTER[input.cls]) || null;
  return [
    `You are Astrid — ${input.user_display}'s personal trainer. You are with them RIGHT NOW, mid-${input.workout_type}, speaking one quick voice note. Warm, blunt, economical — a coach over the radio, never a dashboard.`,
    '',
    'Write exactly one coaching cue for the moment described in the JSON. Hard rules:',
    '- One or two short sentences, under 220 characters total. It will be spoken aloud.',
    '- Plain prose only: no markdown, no emoji, no lists, no quotation marks, no headings.',
    '- Numbers as DIGITS ONLY (17.5, 142) — NEVER spell a number out in words.',
    '- Use ONLY facts present in the JSON. Never invent numbers, history, places, weather, or comparisons that are not in the data.',
    '- Vary your phrasing — never open the same way twice in a ride; the session_curve and stops are there for color when they help.',
    '- No greeting, no sign-off, no question that demands an answer. Never mention the data, JSON, sensors, or being an AI.',
    ...(register ? ['', register] : []),
    '',
    'Respond with the cue text only.',
  ].join('\n');
}

function sanitize(raw: string): string {
  let t = raw.trim();
  // Defensive markdown/quote strip — the prompt forbids these, but a
  // spoken surface can't afford a stray asterisk. Double quotes go
  // everywhere (they carry nothing audible); apostrophes stay
  // (contractions).
  t = t.replace(/[*_#`>"“”]/g, '');
  t = t.replace(/^['‘]+|['’]+$/g, '');
  t = t.replace(/\s+/g, ' ').trim();
  return t;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/** Collect every number in the evidence plus unit-aware derivations. */
export function collect_evidence_numbers(evidence: unknown): number[] {
  const out: number[] = [];
  const push = (n: number) => {
    if (Number.isFinite(n)) out.push(n);
  };
  const walk = (value: unknown, key: string): void => {
    if (typeof value === 'number') {
      push(value);
      push(Math.round(value));
      push(round1(value));
      const k = key.toLowerCase();
      if (k.endsWith('_m') || k.includes('distance_m')) {
        // Metric + imperial derivations both ride in the pool — the
        // facts are unit-correct already, but a model that converts on
        // its own ("about 14 miles") must not trip the check.
        push(round1(value / 1000));
        push(Math.round(value / 1000));
        push(round1(value / 1609.344)); // miles
        push(Math.round(value / 1609.344));
        push(Math.round(value * 3.28084)); // feet (elevation keys end _m too)
      }
      if (k.endsWith('_s') || k.includes('seconds')) {
        push(Math.round(value / 60));
        push(round1(value / 60));
      }
      if (k.includes('pace_s_per_km') && value > 0) {
        push(Math.floor(value / 60)); // minutes component of m:ss pace
        push(Math.round(value % 60)); // seconds component
        push(Math.round(3600 / value)); // km/h
        push(round1(3600 / value));
        push(Math.round(3600 / value / 1.609344)); // mph
        push(round1(3600 / value / 1.609344));
      }
      if ((k.endsWith('_mi') || k.endsWith('_mph') || k.endsWith('_ft')) && value > 0) {
        // Reverse derivations for unit-correct facts, so a model that
        // back-converts to metric stays grounded too.
        push(round1(value * 1.609344));
        push(Math.round(value * 1.609344));
        push(Math.round(value / 3.28084));
      }
      return;
    }
    if (Array.isArray(value)) {
      for (const v of value) walk(v, key);
      return;
    }
    if (value != null && typeof value === 'object') {
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) walk(v, k);
    }
  };
  walk(evidence, '');
  return out;
}

const NUMBER_WORDS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7,
  eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13,
  fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18,
  nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60,
  seventy: 70, eighty: 80, ninety: 90,
};

/**
 * Parse numbers SPELLED OUT IN WORDS ("one hundred seventy-point-five"
 * → 170.5). The 2026-06-12 ride-name incident: the model fabricated
 * "one hundred seventy-point-five miles" for a 17.5-mile ride, and the
 * digits-only extractor saw NO numbers, so grounding passed trivially.
 * Word-numbers are now first-class citizens of the check.
 */
export function extract_word_numbers(text: string): number[] {
  const tokens = text.toLowerCase().split(/[^a-z]+/).filter((t) => t.length > 0);
  const out: number[] = [];
  let cur: number | null = null;
  let frac: string | null = null;
  const flush = (): void => {
    if (cur != null) {
      out.push(frac && frac.length > 0 ? Number(`${Math.trunc(cur)}.${frac}`) : cur);
    }
    cur = null;
    frac = null;
  };
  for (const t of tokens) {
    if (t === 'point' && cur != null && frac == null) {
      frac = '';
      continue;
    }
    const unit = NUMBER_WORDS[t];
    if (unit != null) {
      if (frac != null) {
        frac += String(unit);
        continue;
      }
      cur = (cur ?? 0) + unit;
      continue;
    }
    if ((t === 'hundred' || t === 'thousand') && cur != null && frac == null) {
      cur = cur * (t === 'hundred' ? 100 : 1000);
      continue;
    }
    if (t === 'and' && cur != null && frac == null) continue;
    flush();
  }
  flush();
  return out;
}

export function extract_reply_numbers(text: string): number[] {
  const out: number[] = [];
  for (const m of text.matchAll(/\d+(?:\.\d+)?/g)) {
    const n = Number.parseFloat(m[0]);
    if (Number.isFinite(n)) out.push(n);
  }
  out.push(...extract_word_numbers(text));
  return out;
}

/** True when every load-bearing number in the reply is present in (or
 *  derivable from) the evidence. */
export function numbers_grounded(text: string, evidence: unknown): boolean {
  const reply_numbers = extract_reply_numbers(text);
  if (reply_numbers.length === 0) return true;
  const pool = collect_evidence_numbers(evidence);
  for (const n of reply_numbers) {
    if (n <= SMALL_NUMBER_EXEMPT) continue;
    const tolerance = (e: number) => Math.max(2, Math.abs(e) * 0.03);
    const matched = pool.some((e) => Math.abs(n - e) <= tolerance(e));
    if (!matched) return false;
  }
  return true;
}

/**
 * Render the cue. Returns the grounded spoken text, or null on ANY
 * failure (caller falls back to the deterministic template).
 */
export async function render_cue(llm: LLMRouter, input: CueRenderInput): Promise<string | null> {
  const evidence = {
    moment: input.trigger,
    why_now: input.facts,
    live: input.snapshot,
    workout_type: input.workout_type,
    ...(input.personal_records ? { personal_records: input.personal_records } : {}),
    ...(input.last_30_days ? { last_30_days: input.last_30_days } : {}),
    ...(input.session_curve && input.session_curve.length > 0 ? { session_curve: input.session_curve } : {}),
    ...(input.stops && (input.stops.count ?? 0) > 0 ? { stops: input.stops } : {}),
    ...(input.route ? { route: input.route } : {}),
  };
  try {
    const resolved = llm.for_role('live');
    const resp = await resolved.provider.complete({
      messages: [
        { role: 'system', content: system_prompt(input) },
        { role: 'user', content: JSON.stringify(evidence) },
      ],
      temperature: 0.7,
      max_tokens: 120,
      think: false,
    });
    const text = sanitize(resp.content);
    if (text.length === 0 || text.length > MAX_CUE_CHARS) return null;
    if (!numbers_grounded(text, evidence)) return null;
    return text;
  } catch {
    return null;
  }
}
