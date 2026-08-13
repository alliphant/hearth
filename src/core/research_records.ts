/**
 * research_records — routing a records question to the system that holds the
 * record (Deep Research v2, 2026-07-31).
 *
 * ## The distinction this module encodes
 *
 * A TOPIC question is answered by reading the web. A RECORDS question is
 * answered by querying a specific government system, and the web is actively
 * hostile to it: search for "Georgetown TX property records" and the first page
 * of results is SEO farms that exist to rank for that exact phrase. The live
 * failure fetched four of them and a commercial-listings sitemap.
 *
 * So a records sub-question gets a different pipeline, not a better prompt:
 *
 *   1. **Queryable national systems first.** CourtListener/RECAP takes a party
 *      name and returns real dockets. This is the only part of the records
 *      stack that answers in one call, so it runs first and unconditionally.
 *   2. **Jurisdiction-scoped discovery.** Once the county is resolved, the
 *      roster's discovery templates find the REAL portal ("Williamson County
 *      Texas appraisal district property search"), and the official-host floor
 *      keeps `countyoffice.org` from being mistaken for it.
 *   3. **Demotion.** Aggregators never take a fetch slot ahead of a record
 *      system, in any investigation.
 *
 * ## What this honestly cannot do, stated up front
 *
 * Finding a county portal is not the same as querying it. Most are JS search
 * forms behind a session, and a meaningful number sit behind a CAPTCHA. **We do
 * not bypass CAPTCHAs — ever, under any framing.** So for the county tier the
 * realistic best outcome is often: *name the authoritative system, give the
 * direct link, and say plainly that the lookup itself needs a human.*
 *
 * That is not a consolation prize. "The record is at wcad.org and here is the
 * link" is strictly more useful than eighteen pages about the etymology of the
 * subject's first name, and it is honest about where the boundary is. When the
 * boundary is reached on a matter of personal safety, `SAFETY_ESCALATION_NOTE`
 * says the thing a person in that position actually needs to hear once.
 */
import { demotion_for, host_of, research_roster } from '@core/research_roster';
import {
  discovery_query,
  is_official_host,
  jurisdiction_sources,
  type Jurisdiction,
} from '@core/research_jurisdiction';

/** How a sub-question should be worked. The PLANNER assigns this. */
export type InvestigatorKind = 'records' | 'topic';

export const INVESTIGATOR_KINDS: readonly InvestigatorKind[] = ['records', 'topic'];

export function records_enabled(): boolean {
  return process.env.HEARTH_RESEARCH_RECORDS !== '0';
}

export interface RankableHit {
  title: string;
  url: string;
  snippet: string;
}

export interface RankOptions {
  kind: InvestigatorKind;
  jurisdiction: Jurisdiction | null;
}

/**
 * Reorder search hits so the fetch budget lands on record systems.
 *
 * Three bands, stable within each:
 *   1. official hosts (.gov / .us / a roster-declared records domain) — only
 *      promoted for a RECORDS question, because a .gov is not automatically
 *      the best source for "is this bike any good";
 *   2. everything undeclared;
 *   3. demoted aggregators and name-etymology sites.
 *
 * Demotion applies to EVERY kind. There is no question for which Spokeo's
 * "412 matches" paywall teaser is the best use of a fetch slot.
 *
 * Pure — the smoke pins it against the real hit list from the failed
 * investigation.
 */
export function rank_source_hits<T extends RankableHit>(hits: T[], opts: RankOptions): T[] {
  const band = (h: T): number => {
    if (demotion_for(h.url)) return 2;
    if (opts.kind === 'records' && is_official_records_host(h.url)) return 0;
    return 1;
  };
  // A stable sort by band preserves the engine's own relevance order inside
  // each band — we are re-prioritising source CLASSES, not second-guessing
  // relevance, which we have no basis to do.
  return hits
    .map((h, i) => ({ h, i, b: band(h) }))
    .sort((a, b) => (a.b !== b.b ? a.b - b.b : a.i - b.i))
    .map((x) => x.h);
}

/** Any suffix declared official by any jurisdiction source in the roster. */
export function is_official_records_host(url: string): boolean {
  const suffixes = new Set<string>();
  for (const src of jurisdiction_sources()) {
    for (const s of src.official_host_suffixes) suffixes.add(s);
  }
  if (suffixes.size === 0) {
    suffixes.add('.gov');
    suffixes.add('.us');
  }
  return is_official_host(url, [...suffixes]);
}

export interface RecordsQueryPlan {
  /** Searches to run, best-first. */
  queries: string[];
  /** Record systems we are trying to reach, for the dossier's honesty section. */
  targets: Array<{ id: string; label: string; query: string }>;
  /** Set when no county could be resolved — the queries are then subject-only. */
  jurisdiction_missing: boolean;
}

/**
 * Build the search plan for a records sub-question.
 *
 * With a jurisdiction: one discovery query per roster system, plus the
 * subject's name bound to the county so a stray result from the household's own
 * town cannot outrank it (that is precisely how a Pleasantville page ended up in
 * a Texas investigation).
 *
 * Without one: NO county queries at all. Guessing a county is how you read the
 * wrong state's records and believe them. The caller reports the gap instead.
 */
export function plan_records_queries(
  subject: string,
  question: string,
  jurisdiction: Jurisdiction | null,
  anchor_facts: readonly string[],
): RecordsQueryPlan {
  const targets: RecordsQueryPlan['targets'] = [];
  const queries: string[] = [];

  if (jurisdiction) {
    for (const src of jurisdiction_sources()) {
      const q = discovery_query(src, jurisdiction);
      if (q.length === 0) continue;
      targets.push({ id: src.id, label: src.label, query: q });
      queries.push(q);
    }
    const where = [jurisdiction.county, jurisdiction.state_code ?? jurisdiction.state]
      .filter(Boolean)
      .join(' ');
    if (where.length > 0) queries.unshift(`"${subject}" ${where} public records`);
  } else {
    // Subject-anchored only. Quoted, so the engine cannot drop a name token —
    // the fragmentation that produced a stranger's biography.
    queries.push(`"${subject}" public records`);
    const anchor = anchor_facts.find((f) => f.trim().length > 0);
    if (anchor) queries.push(`"${subject}" ${anchor.trim().slice(0, 80)}`);
  }

  return {
    queries: queries.slice(0, 6),
    targets,
    jurisdiction_missing: jurisdiction === null,
  };
}

/**
 * Is this page a CAPTCHA wall?
 *
 * Detected so the runner can STOP and say so. We do not solve them, we do not
 * route around them, and a page that asks for one is recorded as a hard
 * boundary — see the module header.
 */
export function looks_captcha_walled(body: string): boolean {
  const b = body.toLowerCase().slice(0, 4000);
  return (
    b.includes('recaptcha') ||
    b.includes('hcaptcha') ||
    b.includes('cf-turnstile') ||
    b.includes('are you a robot') ||
    b.includes('i am not a robot') ||
    (b.includes('captcha') && (b.includes('verify') || b.includes('complete')))
  );
}

/**
 * Is this page a search FORM rather than a result?
 *
 * A county portal fetched cold returns its search page. Reporting that as
 * "the record says nothing" would be a lie of the same family as the ones this
 * whole workstream exists to kill, so the runner labels it honestly.
 */
export function looks_like_search_form(body: string): boolean {
  const b = body.toLowerCase();
  if (b.length > 12_000) return false; // a real result set has bulk
  const form_signals = [
    'enter the owner name',
    'search by owner',
    'property search',
    'case search',
    'begin your search',
    'search criteria',
    'please enter',
  ];
  return form_signals.some((s) => b.includes(s));
}

/**
 * The one thing worth saying to someone researching a person who may be
 * stalking them, said once, when the records tier is genuinely unreachable.
 *
 * This is not a deflection — it is the accurate next step. A police report and
 * a licensed investigator have subpoena-adjacent and statutory access to
 * exactly the records a scraper is locked out of, and their output is
 * admissible toward a protective order in a way ours is not.
 */
export const SAFETY_ESCALATION_NOTE =
  'These records are not reachable from here, and that is a limit of public web ' +
  'access rather than a sign there is nothing to find. Two routes do reach them: a ' +
  'police report creates a file officers can attach records to, and a licensed private ' +
  'investigator can lawfully pull county, court and address history that is closed to ' +
  'automated access. If this concerns your safety, both also produce documentation a ' +
  'court will accept when applying for a protective order — which nothing gathered here can.';

/** The standing limits, stated in the dossier rather than only in the code. */
export function render_records_limits(opts: {
  jurisdiction: Jurisdiction | null;
  captcha_walled: string[];
  forms_only: string[];
  safety_relevant: boolean;
}): string {
  const lines: string[] = [];
  if (opts.jurisdiction === null) {
    lines.push(
      '- **No jurisdiction could be resolved**, so county systems (property, civil, ' +
        'divorce, liens) were not searched. They are per-county and cannot be reached ' +
        'without a city and state or an address. Supplying one unlocks this tier.',
    );
  }
  for (const url of opts.captcha_walled) {
    lines.push(
      `- **${host_of(url) ?? url} is CAPTCHA-walled.** Stopped there: we do not bypass ` +
        `CAPTCHAs. The record exists and is public — the lookup needs a person: ${url}`,
    );
  }
  for (const url of opts.forms_only) {
    lines.push(
      `- **${host_of(url) ?? url} is the authoritative system but serves a search form**, ` +
        `not results, to an automated fetch. This is the right place to look: ${url}`,
    );
  }
  if (lines.length === 0) return '';
  let out = `### Limits on the records search\n\n${lines.join('\n')}\n`;
  if (opts.safety_relevant) out += `\n${SAFETY_ESCALATION_NOTE}\n`;
  return out;
}

/** Sealed/expunged/paywalled classes, stated once where a reader will see it. */
export const STRUCTURAL_LIMITS_NOTE =
  'Sealed and expunged records are not visible to anyone without a court order, and ' +
  'paid aggregators are excluded deliberately — they resell scraped data behind a ' +
  'paywall without provenance, which is worse than no answer. Absence of a record here ' +
  'is not evidence that no record exists.';

/** Roster-declared national systems, for the planner's context. */
export function national_records_sources() {
  return research_roster().records.national;
}
