/**
 * Display units — the one place metric↔imperial conversion lives.
 *
 * STORAGE STAYS METRIC everywhere (meters in workout_sessions, the PR
 * shelf frontmatter, heartbeat packets); units are a DISPLAY concern
 * resolved per user at render time. `users.yaml` carries an optional
 * `units:` per user (default imperial — this is a Colorado household);
 * every Astrid-facing surface (pane tabs, live readings, cue facts +
 * fallbacks, ride naming, PR shelf body render) converts through these
 * helpers. Don't hand-roll `/1000` or `/1609` at a call site.
 */

export type Units = 'imperial' | 'metric';

export const M_PER_MI = 1609.344;
export const FT_PER_M = 3.28084;

export function units_for(user?: { units?: string | null } | null): Units {
  return user?.units === 'metric' ? 'metric' : 'imperial';
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/** Meters → display distance (mi or km), 1 decimal. */
export function dist_from_m(m: number, units: Units): number {
  return round1(units === 'imperial' ? m / M_PER_MI : m / 1000);
}

export function dist_unit(units: Units): 'mi' | 'km' {
  return units === 'imperial' ? 'mi' : 'km';
}

/** Spoken form for cue text — TTS reads "miles", not "mi". */
export function dist_unit_spoken(units: Units): 'miles' | 'k' {
  return units === 'imperial' ? 'miles' : 'k';
}

/** Display-distance interval (e.g. a 5-mile milestone) → meters. */
export function dist_to_m(value: number, units: Units): number {
  return units === 'imperial' ? value * M_PER_MI : value * 1000;
}

/** Pace (s/km, the internal pace unit) → display speed (mph or km/h), 1 decimal. */
export function speed_from_pace_s_per_km(pace_s_per_km: number, units: Units): number {
  const kmh = 3600 / pace_s_per_km;
  return round1(units === 'imperial' ? kmh / 1.609344 : kmh);
}

export function speed_unit(units: Units): 'mph' | 'km/h' {
  return units === 'imperial' ? 'mph' : 'km/h';
}

/** Meters of elevation → display elevation (ft or m), whole numbers. */
export function elev_from_m(m: number, units: Units): number {
  return Math.round(units === 'imperial' ? m * FT_PER_M : m);
}

export function elev_unit(units: Units): 'ft' | 'm' {
  return units === 'imperial' ? 'ft' : 'm';
}

/** Spoken form for cue text. */
export function elev_unit_spoken(units: Units): 'feet' | 'meters' {
  return units === 'imperial' ? 'feet' : 'meters';
}
