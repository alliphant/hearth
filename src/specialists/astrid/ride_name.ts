/**
 * Ride naming — every meaningful workout gets a one-sentence name
 * (Live Ride Companion Phase 2.5, "three sprinkles of magic").
 *
 * Same contract discipline as cue_render.ts:
 *
 *   - FAIL-OPEN: any LLM error / over-length / grounding failure falls
 *     back to a deterministic name built from the same evidence — a
 *     session is never left nameless because inference hiccuped.
 *   - NUMERIC GROUNDING: every number ≥ 16 in the rendered name must be
 *     derivable from the evidence (reuses cue_render's checker). A name
 *     that invents "42 km" for a 36.9 km ride is rejected.
 *
 * The render is asked for ~10–15 words, "the first line of a very short
 * story about this exact ride" — grounded in metrics, elevation, power
 * band, time of day, weather, and route descriptors when iOS shipped
 * them (road/place NAMES only; coordinates never reach the server).
 */

import type { LLMRouter } from '@core/llm';
import { numbers_grounded } from './cue_render';

export interface RideNameInput {
  user_display: string;
  workout_type: string;
  /** Local wall-clock start, e.g. "Wednesday 18:42" (already tz-resolved). */
  local_start: string;
  /** dawn / morning / midday / afternoon / golden hour / dusk / night. */
  time_of_day: string;
  duration_min: number;
  /** Distance/speed/elevation arrive ALREADY converted to the user's
   *  display units; the *_unit labels ride into the LLM evidence so
   *  the name speaks the rider's language ("a 23-mile dusk loop"). */
  distance: number | null;
  distance_unit: 'mi' | 'km';
  avg_speed: number | null;
  speed_unit: 'mph' | 'km/h';
  active_kcal: number;
  avg_hr: number | null;
  max_hr: number | null;
  elevation_gain: number | null;
  elevation_unit: 'ft' | 'm';
  avg_power_w: number | null;
  /** Derived label for avg_power_w — "endurance", "tempo", … */
  power_band: string | null;
  hr_zone_minutes: Record<string, number> | null;
  weather: {
    current_temperature_f: number | null;
    current_condition: string | null;
    forecast_summary: string | null;
  } | null;
  route_notes: string[] | null;
  records_broken: string[];
  /** Route-learning context when this ride matched a known route. */
  route_history?: { times_ridden: number; best_min: number | null } | null;
}

const MAX_NAME_CHARS = 170;
const MIN_NAME_WORDS = 6;
const MAX_NAME_WORDS = 20;

/** Rough recreational power bands for the Watch's estimated cycling
 *  power. Labels feed the name's vocabulary; the raw watts ride along
 *  for grounding. */
export function power_band_label(avg_power_w: number | null): string | null {
  if (avg_power_w == null || avg_power_w <= 0) return null;
  if (avg_power_w < 90) return 'easy spin';
  if (avg_power_w < 140) return 'endurance';
  if (avg_power_w < 190) return 'tempo';
  if (avg_power_w < 240) return 'threshold work';
  return 'hammering';
}

/** Local-hour bucket with the golden hours called out — the names live
 *  or die on light. */
export function time_of_day_label(hour: number): string {
  if (hour < 5) return 'night';
  if (hour < 7) return 'dawn';
  if (hour < 11) return 'morning';
  if (hour < 14) return 'midday';
  if (hour < 17) return 'afternoon';
  if (hour < 19) return 'golden hour';
  if (hour < 21) return 'dusk';
  return 'night';
}

function system_prompt(input: RideNameInput): string {
  return [
    `You are Astrid — ${input.user_display}'s personal trainer — naming a finished ${input.workout_type} for their training log.`,
    '',
    'Write exactly ONE sentence of roughly 10–15 words that names this workout: the first line of a very short story about this exact ride. Hard rules:',
    '- Ground everything in the JSON — numbers, roads, weather, light, effort. NEVER invent a fact that is not in the data.',
    '- Concrete, alive, a little magic. One vivid image drawn from the data beats three adjectives.',
    '- No corporate fitness-speak ("crushed", "smashed", "beast mode"), no hashtags, no emoji, no quotation marks, no markdown.',
    '- Numbers as DIGITS ONLY (17.5, not "seventeen point five") — NEVER spell a number out in words. Use at most three numbers — the ones that made THIS ride itself.',
    '- If route names are present you may use at most one, naturally.',
    '- Never mention what the data lacks — no "unnamed", "without a name", "no route". Absent data simply does not exist.',
    '- No greeting, no sign-off. Return the sentence only.',
  ].join('\n');
}

function sanitize(raw: string): string {
  let t = raw.trim();
  t = t.replace(/[*_#`>"“”]/g, '');
  t = t.replace(/^['‘]+|['’]+$/g, '');
  t = t.replace(/\s+/g, ' ').trim();
  return t;
}

function word_count(t: string): number {
  return t.split(/\s+/).filter((w) => w.length > 0).length;
}

/** Deterministic fallback — honest, compact, never wrong. */
export function fallback_ride_name(input: RideNameInput): string {
  const parts: string[] = [];
  if (input.distance != null && input.distance > 0) parts.push(`${input.distance} ${input.distance_unit}`);
  parts.push(`${input.duration_min} min`);
  // Elevation floor ≈ 10 m, expressed in the display unit.
  const elev_floor = input.elevation_unit === 'ft' ? 33 : 10;
  if (input.elevation_gain != null && input.elevation_gain >= elev_floor) {
    parts.push(`${Math.round(input.elevation_gain)} ${input.elevation_unit} up`);
  }
  parts.push(`${Math.round(input.active_kcal)} kcal`);
  const tod = input.time_of_day.charAt(0).toUpperCase() + input.time_of_day.slice(1);
  return `${tod} ${input.workout_type} — ${parts.join(', ')}`;
}

/**
 * Name the ride. Always resolves to a usable name; `rendered` says
 * whether the LLM's sentence survived grounding (false ⇒ fallback).
 */
export async function generate_ride_name(
  llm: LLMRouter | undefined,
  input: RideNameInput,
): Promise<{ name: string; rendered: boolean }> {
  const evidence = {
    workout_type: input.workout_type,
    local_start: input.local_start,
    time_of_day: input.time_of_day,
    duration_min: input.duration_min,
    [`distance_${input.distance_unit}`]: input.distance,
    [`avg_speed_${input.speed_unit === 'mph' ? 'mph' : 'kmh'}`]: input.avg_speed,
    active_kcal: input.active_kcal,
    avg_hr: input.avg_hr,
    max_hr: input.max_hr,
    [`elevation_gain_${input.elevation_unit}`]: input.elevation_gain,
    avg_power_w: input.avg_power_w,
    power_band: input.power_band,
    hr_zone_minutes: input.hr_zone_minutes,
    weather: input.weather,
    route_names: input.route_notes,
    records_broken: input.records_broken,
    ...(input.route_history ? { route_history: input.route_history } : {}),
  };
  if (llm) {
    try {
      const resolved = llm.for_role('live');
      const resp = await resolved.provider.complete({
        messages: [
          { role: 'system', content: system_prompt(input) },
          { role: 'user', content: JSON.stringify(evidence) },
        ],
        // Hotter than the cue render — a name wants more sparkle than a
        // mid-ride radio call; the grounding check keeps it honest.
        temperature: 0.9,
        max_tokens: 80,
        think: false,
      });
      const text = sanitize(resp.content);
      const words = word_count(text);
      if (
        text.length > 0 &&
        text.length <= MAX_NAME_CHARS &&
        words >= MIN_NAME_WORDS &&
        words <= MAX_NAME_WORDS &&
        numbers_grounded(text, evidence)
      ) {
        return { name: text, rendered: true };
      }
    } catch {
      // fall through to the deterministic name
    }
  }
  return { name: fallback_ride_name(input), rendered: false };
}
