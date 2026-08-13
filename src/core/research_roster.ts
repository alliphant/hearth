/**
 * research_roster — loads config/research-sources.yaml (2026-07-31).
 *
 * The source-strategy layer for deep research is DATA. This module is the one
 * place that reads it, validates it, and hands typed structures to the
 * attribution gate, the jurisdiction resolver and the records investigator.
 *
 * Read fresh on every call behind an mtime cache, the `market-themes.yaml`
 * pattern — a hand edit is live on the next investigation with no restart.
 *
 * FAIL-OPEN with a floor. A missing, unreadable or malformed config must never
 * stop an investigation, but it must also never silently unlock the browser
 * path on a host the owner asked us to stay off. So the fallback is not "empty"
 * — it is BUILTIN_ATTRIBUTION, the enumerated identity-disclosing hosts
 * compiled in. Delete the YAML and LinkedIn is still refused.
 */
import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse as parse_yaml } from 'yaml';
import { z } from 'zod';

const CONFIG_PATH =
  process.env.HEARTH_RESEARCH_SOURCES_CONFIG ??
  resolve(import.meta.dir, '../../config/research-sources.yaml');

export type AttributionTier = 'passive' | 'attributable';

const AttributionHostSchema = z.object({
  host: z.string().min(1),
  tier: z.enum(['passive', 'attributable']),
  why: z.string().default(''),
});

const JurisdictionSourceSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  covers: z.array(z.string()).default([]),
  /** Query template. `{county}` and `{state}` are substituted. */
  discover: z.string().min(1),
  /** A discovered host must end with one of these to be treated as official. */
  official_host_suffixes: z.array(z.string()).default(['.gov', '.us']),
  why: z.string().default(''),
});

const NationalSourceSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  covers: z.array(z.string()).default([]),
  via: z.enum(['tool', 'url']).default('url'),
  tool: z.string().optional(),
  url: z.string().optional(),
  why: z.string().default(''),
});

const DemotedSchema = z.object({
  host: z.string().min(1),
  why: z.string().default(''),
});

const RosterSchema = z.object({
  attribution: z
    .object({
      default_browser_tier: z.enum(['passive', 'attributable']).default('passive'),
      hosts: z.array(AttributionHostSchema).default([]),
    })
    .default({ default_browser_tier: 'passive', hosts: [] }),
  records: z
    .object({
      national: z.array(NationalSourceSchema).default([]),
      jurisdiction: z.array(JurisdictionSourceSchema).default([]),
    })
    .default({ national: [], jurisdiction: [] }),
  demote: z.array(DemotedSchema).default([]),
});

export type ResearchRoster = z.infer<typeof RosterSchema>;
export type AttributionHostRule = z.infer<typeof AttributionHostSchema>;
export type JurisdictionSource = z.infer<typeof JurisdictionSourceSchema>;
export type NationalSource = z.infer<typeof NationalSourceSchema>;

/**
 * The compiled floor. If the YAML is gone or broken these rules still apply —
 * a config problem must not become a privacy problem. Kept deliberately short:
 * only hosts where a signed-in view is disclosed to the SUBJECT of the
 * research, which is the owner's actual worry.
 */
export const BUILTIN_ATTRIBUTION: AttributionHostRule[] = [
  {
    host: 'linkedin.com',
    tier: 'attributable',
    why: 'a signed-in view is logged and shown to the profile owner',
  },
  { host: 'facebook.com', tier: 'attributable', why: 'signed-in views feed mutual discovery' },
  { host: 'instagram.com', tier: 'attributable', why: 'signed-in story/profile views are shown to the owner' },
  { host: 'x.com', tier: 'attributable', why: 'signed-in session ties views to the household account' },
  { host: 'twitter.com', tier: 'attributable', why: 'legacy host for x.com' },
];

const FALLBACK: ResearchRoster = {
  attribution: { default_browser_tier: 'passive', hosts: BUILTIN_ATTRIBUTION },
  records: { national: [], jurisdiction: [] },
  demote: [],
};

let cached: { mtime_ms: number; roster: ResearchRoster } | null = null;
let warned_path = '';

/** The parsed roster. Fresh on edit; falls back to the compiled floor. */
export function research_roster(): ResearchRoster {
  let mtime_ms: number;
  try {
    mtime_ms = statSync(CONFIG_PATH).mtimeMs;
  } catch {
    if (warned_path !== CONFIG_PATH) {
      warned_path = CONFIG_PATH;
      console.warn(
        `[research-roster] ${CONFIG_PATH} not readable — using the compiled ` +
          `attribution floor (${BUILTIN_ATTRIBUTION.length} host(s)) and an empty records roster.`,
      );
    }
    return FALLBACK;
  }
  if (cached && cached.mtime_ms === mtime_ms) return cached.roster;

  try {
    const parsed = RosterSchema.parse(parse_yaml(readFileSync(CONFIG_PATH, 'utf8')));
    // Union the compiled floor in: a host the owner removed from YAML by
    // accident should not silently become fetchable. An explicit YAML entry for
    // the same host WINS, so a deliberate downgrade is still possible.
    const declared = new Set(parsed.attribution.hosts.map((h) => normalize_host(h.host)));
    const hosts = [
      ...parsed.attribution.hosts,
      ...BUILTIN_ATTRIBUTION.filter((b) => !declared.has(normalize_host(b.host))),
    ];
    const roster: ResearchRoster = {
      ...parsed,
      attribution: { ...parsed.attribution, hosts },
    };
    cached = { mtime_ms, roster };
    return roster;
  } catch (err) {
    console.error(
      `[research-roster] ${CONFIG_PATH} is malformed (${(err as Error).message}) — ` +
        `using the compiled attribution floor.`,
    );
    return FALLBACK;
  }
}

/** Lowercase, strip a leading `www.`, drop a trailing dot. */
export function normalize_host(host: string): string {
  return host.trim().toLowerCase().replace(/\.$/, '').replace(/^www\./, '');
}

/** Host of a URL, normalized. null when the URL will not parse. */
export function host_of(url: string): string | null {
  try {
    return normalize_host(new URL(url).hostname);
  } catch {
    return null;
  }
}

/**
 * Does `host` sit at or under `suffix`?
 *
 * Suffix-matched on LABEL boundaries, so `linkedin.com` matches
 * `www.linkedin.com` and `de.linkedin.com` but `notlinkedin.com` matches
 * nothing. Substring matching here would be a real bug: `x.com` would match
 * `netflix.com`.
 */
export function host_matches(host: string, suffix: string): boolean {
  const h = normalize_host(host);
  const s = normalize_host(suffix);
  return h === s || h.endsWith(`.${s}`);
}

/** The demoted-host entry for a URL, if any. */
export function demotion_for(url: string): { host: string; why: string } | null {
  const host = host_of(url);
  if (!host) return null;
  for (const d of research_roster().demote) {
    if (host_matches(host, d.host)) return { host: d.host, why: d.why };
  }
  return null;
}

/** Is this URL a demoted aggregator / SEO farm? */
export function is_demoted(url: string): boolean {
  return demotion_for(url) !== null;
}
