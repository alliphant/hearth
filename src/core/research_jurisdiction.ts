/**
 * research_jurisdiction — which county actually holds the record?
 * (Deep Research v2, 2026-07-31.)
 *
 * ## The failure this exists for
 *
 * The brief asked whether a man owned property at a named Georgetown, Texas
 * address. The runner searched the open web for the phrase "Georgetown TX
 * property records" and fetched, in order: a LoopNet sitemap of commercial
 * listings, two 100-byte countyoffice.org SEO stubs, and — because the
 * HOUSEHOLD is in Pleasantville and the search engine helpfully localised —
 * 32KB about your county County, Colorado, a thousand miles from the subject.
 *
 * No amount of model quality fixes that. Georgetown property data is not on
 * the open web in any retrievable form; it is in the Williamson County
 * Appraisal District's parcel system. A records question is UNANSWERABLE until
 * the jurisdiction is known, and the jurisdiction is a fact to be resolved, not
 * a phrase to be searched.
 *
 * ## How it resolves
 *
 * Deterministic candidate generation → REAL geocoder verification. The same
 * shape as the fact critic: a regex may propose, only evidence disposes.
 *
 *   1. `extract_place_candidates` pulls "City, ST" / "City, State" / ZIP
 *      shapes out of the owner's anchor facts first, then the brief. Anchor
 *      facts win because the owner supplied them on purpose — they are the
 *      one place a private person's location is reliably stated.
 *   2. Each candidate goes to the household's own Nominatim (already deployed,
 *      already US-wide, `addressdetails=1`), which returns the county as DATA:
 *      "Georgetown, Texas" → `{city: Georgetown, county: Williamson County,
 *      state: Texas}`. Verified on the live instance while building this.
 *
 * Never an LLM guess about geography, and never a bare web search. If nothing
 * resolves, the answer is that the jurisdiction is unknown — which makes the
 * records facets honestly `unanswerable` with a reason the owner can fix by
 * supplying an address, instead of eighteen wrong fetches.
 *
 * Kill switch: HEARTH_RESEARCH_JURISDICTION=0 → resolution is skipped and the
 * runner behaves exactly as it did before this module.
 */
import { safe_fetch } from '@connectors/_audit';
import { host_of, host_matches, research_roster, type JurisdictionSource } from '@core/research_roster';
import { US_STATES } from '@core/research_identity';

const NOMINATIM_BASE_URL = process.env.NOMINATIM_BASE_URL ?? 'http://localhost:8989';
const TIMEOUT_MS = 12_000;

export function jurisdiction_enabled(): boolean {
  return process.env.HEARTH_RESEARCH_JURISDICTION !== '0';
}

export interface Jurisdiction {
  /** "Georgetown" */
  city: string | null;
  /** "Williamson County" — verbatim from the geocoder. */
  county: string | null;
  /** "Texas" */
  state: string | null;
  /** "TX", from the geocoder's ISO3166-2 code. */
  state_code: string | null;
  /** What resolved it, for the audit trail and the dossier. */
  resolved_from: string;
  /** "Georgetown, Williamson County, Texas, United States" */
  display: string;
}

/** The state table lives in research_identity (pure, no imports) so the anchor
 *  check and the jurisdiction resolver cannot drift apart. */
const STATES = US_STATES;

const STATE_CODES = new Set(STATES.map(([, code]) => code));

/**
 * Place-shaped strings in `text`, best-first.
 *
 * Pure and deliberately HIGH-RECALL — every candidate is verified against a
 * real geocoder before it is believed, so a false candidate costs one lookup
 * and a missed one costs the whole facet. Ordering matters more than
 * precision: a full street address resolves to a county most reliably, so it
 * leads.
 */
export function extract_place_candidates(text: string): string[] {
  const out: string[] = [];
  const push = (s: string) => {
    const v = s.replace(/\s+/g, ' ').trim().replace(/[.,;]+$/, '');
    if (v.length >= 4 && !out.some((o) => o.toLowerCase() === v.toLowerCase())) out.push(v);
  };

  // 1. Street address + city + state (+ ZIP). The strongest signal.
  const street =
    /\b(\d{1,6}\s+[A-Za-z0-9.'-]+(?:\s+[A-Za-z0-9.'-]+){0,4}),?\s+([A-Z][A-Za-z.'-]+(?:\s+[A-Z][A-Za-z.'-]+){0,2}),\s*([A-Z]{2})\b(?:\s+(\d{5}))?/g;
  for (const m of text.matchAll(street)) {
    if (!STATE_CODES.has(m[3]!)) continue;
    push(`${m[1]}, ${m[2]}, ${m[3]}${m[4] ? ` ${m[4]}` : ''}`);
  }

  // 2. "City, ST"
  const city_code = /\b([A-Z][A-Za-z.'-]+(?:\s+[A-Z][A-Za-z.'-]+){0,2}),\s*([A-Z]{2})\b/g;
  for (const m of text.matchAll(city_code)) {
    if (!STATE_CODES.has(m[2]!)) continue;
    push(`${m[1]}, ${m[2]}`);
  }

  // 3. "City, Statename" and bare "City Statename" (the "Georgetown TX" and
  //    "Georgetown Texas" shapes a brief is actually written in).
  //
  // The city group is deliberately case-SENSITIVE (no `i` flag): with one, the
  // greedy group happily swallows the preceding words and "he lives in
  // Georgetown Texas" yields the city "lives in Georgetown". Only the state
  // name tolerates either case, expressed per-character so the flag is not
  // needed at all.
  for (const [name, code] of STATES) {
    const state_pattern = name
      .split('')
      .map((ch) => (ch === ' ' ? '\\s+' : `[${ch.toUpperCase()}${ch}]`))
      .join('');
    const re = new RegExp(
      `\\b([A-Z][A-Za-z.'-]+(?:\\s+[A-Z][A-Za-z.'-]+){0,2}),?\\s+${state_pattern}\\b`,
      'g',
    );
    for (const m of text.matchAll(re)) {
      const city = m[1]!.trim();
      // Guard against swallowing the state name itself as the city
      // ("West Virginia" → city "West").
      if (STATES.some(([n]) => n.startsWith(city.toLowerCase()))) continue;
      push(`${city}, ${code}`);
    }
  }

  // 4. A bare ZIP is enough for a county on its own.
  for (const m of text.matchAll(/\b(\d{5})(?:-\d{4})?\b/g)) push(m[1]!);

  return out;
}

interface NominatimAddress {
  city?: string;
  town?: string;
  village?: string;
  hamlet?: string;
  county?: string;
  state?: string;
  'ISO3166-2-lvl4'?: string;
  country_code?: string;
}

/** Seam so the smoke can resolve without a Nominatim instance. */
export type GeocodeFn = (
  query: string,
) => Promise<{ address: NominatimAddress; display_name: string } | null>;

async function nominatim_lookup(
  query: string,
): Promise<{ address: NominatimAddress; display_name: string } | null> {
  const params = new URLSearchParams({
    q: query,
    format: 'jsonv2',
    limit: '1',
    addressdetails: '1',
    countrycodes: 'us',
  });
  const url = `${NOMINATIM_BASE_URL.replace(/\/$/, '')}/search?${params.toString()}`;
  const res = await safe_fetch(url, { headers: { 'User-Agent': 'hearth-research/1.0' } }, TIMEOUT_MS);
  if (!res.ok) return null;
  try {
    const rows = JSON.parse(res.body) as Array<{
      address?: NominatimAddress;
      display_name?: string;
    }>;
    const first = rows[0];
    if (!first?.address) return null;
    return { address: first.address, display_name: first.display_name ?? query };
  } catch {
    return null;
  }
}

function state_code_of(a: NominatimAddress): string | null {
  const iso = a['ISO3166-2-lvl4'];
  if (iso && iso.startsWith('US-')) return iso.slice(3);
  if (a.state) {
    const hit = STATES.find(([n]) => n === a.state!.toLowerCase());
    if (hit) return hit[1];
  }
  return null;
}

/**
 * Resolve the jurisdiction for a records investigation.
 *
 * `anchor_facts` are searched BEFORE `brief` — the owner supplies an address
 * precisely because the subject's location is otherwise unknowable, so it is
 * the highest-quality input in the system.
 *
 * Returns null when nothing resolves to a county. That is a real answer, and
 * the caller must report it rather than fall back to an open-web search: an
 * unresolved jurisdiction is exactly the state in which the eighteen-wrong-
 * sources failure happened.
 */
export async function resolve_jurisdiction(
  anchor_facts: readonly string[],
  brief: string,
  geocode: GeocodeFn = nominatim_lookup,
): Promise<Jurisdiction | null> {
  if (!jurisdiction_enabled()) return null;
  const candidates = [
    ...extract_place_candidates(anchor_facts.join('\n')),
    ...extract_place_candidates(brief),
  ];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const key = candidate.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    let hit: Awaited<ReturnType<GeocodeFn>>;
    try {
      hit = await geocode(candidate);
    } catch {
      continue; // fail-open per candidate; a dead geocoder just yields null overall
    }
    if (!hit) continue;
    const a = hit.address;
    // A county is the whole point — a hit that only resolves to a state cannot
    // route a records query, so keep looking.
    if (!a.county) continue;
    return {
      city: a.city ?? a.town ?? a.village ?? a.hamlet ?? null,
      county: a.county,
      state: a.state ?? null,
      state_code: state_code_of(a),
      resolved_from: candidate,
      display: hit.display_name,
    };
  }
  return null;
}

/**
 * A discovered host is official when it ends in one of the roster's declared
 * suffixes. This is the "official-host floor": it is what keeps
 * `countyoffice.org` — an SEO stub that impersonates a county record system —
 * from being read as the county record system.
 */
export function is_official_host(url: string, suffixes: readonly string[]): boolean {
  const host = host_of(url);
  if (!host) return false;
  return suffixes.some((s) => {
    const suffix = s.trim().toLowerCase();
    if (suffix.length === 0) return false;
    // Three deliberate forms, and the default is the SAFE one:
    //   ".gov"      — TLD-style tail match.
    //   "cad.org"   — a bare domain, matched on LABEL boundaries so it cannot
    //                 match "notcad.org". This is the default because loose
    //                 substring matching is how "x.com" comes to match
    //                 "netflix.com".
    //   "*cad.org"  — an EXPLICIT opt-in to loose tail matching, for real
    //                 families of official hosts that share no label boundary:
    //                 Texas appraisal districts are wcad.org (Williamson),
    //                 hcad.org (Harris), dcad.org (Dallas). The author has to
    //                 type the star, so the looseness is never accidental.
    if (suffix.startsWith('*')) return host.endsWith(suffix.slice(1));
    return suffix.startsWith('.') ? host.endsWith(suffix) : host_matches(host, suffix);
  });
}

/** Fill `{county}` / `{state}` in a roster discovery template. */
export function discovery_query(source: JurisdictionSource, j: Jurisdiction): string {
  return source.discover
    .replaceAll('{county}', j.county ?? '')
    .replaceAll('{state}', j.state ?? j.state_code ?? '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The jurisdiction-scoped record systems worth trying, from the roster. */
export function jurisdiction_sources(): JurisdictionSource[] {
  return research_roster().records.jurisdiction;
}

/** One line for the dossier and the log. */
export function render_jurisdiction(j: Jurisdiction | null): string {
  if (!j) {
    return (
      'Jurisdiction: NOT RESOLVED. No city/state or street address could be established ' +
      'for the subject, so county record systems (property, civil, divorce, liens) could ' +
      'not be searched — those are per-county and cannot be reached without one. ' +
      'Supplying an address or a city and state would unlock them.'
    );
  }
  const where = [j.city, j.county, j.state].filter(Boolean).join(', ');
  return `Jurisdiction: ${where} (resolved from "${j.resolved_from}").`;
}
