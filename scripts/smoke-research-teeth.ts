/**
 * smoke:research-teeth — attribution tiers, jurisdiction routing, records
 * strategy and the identity anchor (2026-07-31).
 *
 * Pinned to TWO real investigations whose persisted bodies are on the box.
 *
 * ## ri_3kq84nfd4mz0 — "Daniel Ray Torres"
 *
 * The household is researching someone apparently stalking them. The brief
 * asked for property at a named Georgetown, Texas address, Williamson and
 * Bastrop county court records, and divorce/debt history. It answered zero of
 * six facets in 10,074 characters of elaborated absence, having read eighteen
 * sources of which SEVENTEEN never named him. The real fetch list, with the
 * byte counts from `research_sources`, is the fixture below: a Wikipedia page
 * about the NAME "Jonathan", a baby-name site, a Bible dictionary, a Honda
 * tuning forum, a GitHub webcompat bug, a Spokeo teaser for a different
 * Daniel Torres in VIRGINIA, a LoopNet sitemap, two ~110-byte
 * countyoffice.org stubs — and 32KB about Pleasantville, Colorado, because the
 * search engine localised to the HOUSEHOLD rather than the subject.
 *
 * The root cause is architectural: it answered a records question by searching
 * the words "property records" instead of querying the county system that
 * holds the record. Georgetown property data is in the Williamson County
 * Appraisal District and nowhere else.
 *
 * ## The LinkedIn attribution path — measured, not hypothetical
 *
 * The persisted LinkedIn body from that same investigation is 549 characters
 * of `Sign Up | LinkedIn` — the logged-out guest wall. `THIN_MARKDOWN_MIN` is
 * 900, so that body is a THIN SHELL, and a thin shell escalates to the warmed
 * Firefox on the browser host, which keeps signed-in profiles. LinkedIn shows
 * the subject who viewed them. The escalation built to defeat bot walls is
 * exactly what would tell a stalker he is being investigated.
 *
 * ## ri_gzd46bpsys59 — "Josie Kim Reyes"
 *
 * Covered by smoke:research-identity-anchor. What is NEW here is the anchor:
 * the name gate cannot separate same-NAME from same-PERSON, and "Jonathan
 * Torres" is common enough that sources genuinely DO name him.
 *
 * Self-contained: pure functions and a scripted geocoder. No db, no network,
 * no LLM.
 */
import {
  attribution_of,
  fetch_permitted,
  render_attribution_note,
} from '../src/core/research_attribution';
import {
  BUILTIN_ATTRIBUTION,
  host_matches,
  host_of,
  is_demoted,
  research_roster,
} from '../src/core/research_roster';
import {
  discovery_query,
  extract_place_candidates,
  is_official_host,
  render_jurisdiction,
  resolve_jurisdiction,
  type GeocodeFn,
} from '../src/core/research_jurisdiction';
import {
  looks_captcha_walled,
  looks_like_search_form,
  plan_records_queries,
  rank_source_hits,
  SAFETY_ESCALATION_NOTE,
  render_records_limits,
} from '../src/core/research_records';
import {
  anchor_from_facts,
  source_corroborates_anchor,
  source_mentions_subject,
} from '../src/core/research_identity';
import { map_hit, to_cl_date } from '../src/connectors/courtlistener';
import { verify_drops_enabled } from '../src/specialists/kate/research_investigation_runner';

let failures = 0;
let checks = 0;
function check(name: string, cond: boolean, detail?: string): void {
  checks++;
  if (cond) {
    console.log(`PASS  ${name}`);
  } else {
    failures++;
    console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}
function section(t: string): void {
  console.log(`\n── ${t} ──`);
}

/* ================================================================== */
section('A. Attribution — the LinkedIn escalation path, closed');
/* ================================================================== */

const LINKEDIN = 'https://www.linkedin.com/in/jonathanfustegarcia/';

check(
  'an anonymous fetch is passive even of an identity-disclosing host',
  attribution_of(LINKEDIN, 'anonymous').tier === 'passive',
);
check(
  'the SAME url through the household browser is attributable',
  attribution_of(LINKEDIN, 'household_browser').tier === 'attributable',
);
check(
  '…and says why, in words the owner would recognise',
  /notif|logged|shown|view/i.test(attribution_of(LINKEDIN, 'household_browser').why),
  attribution_of(LINKEDIN, 'household_browser').why,
);
check(
  'an undeclared host through the browser stays passive (a logged-out render discloses nothing)',
  attribution_of('https://wcad.org/property-search', 'household_browser').tier === 'passive',
);

// The rule the owner stated: a PERSON investigation never uses an attributable path.
const capped = fetch_permitted(LINKEDIN, 'household_browser', 'passive');
check('a person investigation REFUSES the browser path to LinkedIn', !capped.allowed);
check(
  '…and the refusal explains it as a choice, not a failure',
  /traceable|being researched|capped/i.test(capped.reason),
  capped.reason,
);
check(
  'the anonymous path to the same url is still permitted',
  fetch_permitted(LINKEDIN, 'anonymous', 'passive').allowed,
);
check(
  'an UNCAPPED (topic) investigation may still use the browser',
  fetch_permitted(LINKEDIN, 'household_browser', undefined).allowed,
);
check(
  'a county portal is never blocked by the cap',
  fetch_permitted('https://wcad.org/search', 'household_browser', 'passive').allowed,
);

// Suffix matching must be label-wise: substring matching would make `x.com`
// match `netflix.com`, silently refusing an unrelated host.
check('host suffix matches a subdomain', host_matches('www.linkedin.com', 'linkedin.com'));
check('…and a country subdomain', host_matches('de.linkedin.com', 'linkedin.com'));
check('…but NOT a lookalike domain', !host_matches('notlinkedin.com', 'linkedin.com'));
check('…and x.com does not match netflix.com', !host_matches('netflix.com', 'x.com'));

// Fail-safe floor: the config can be deleted or broken; the refusal cannot.
check(
  'the compiled floor covers LinkedIn even with no config',
  BUILTIN_ATTRIBUTION.some((r) => r.host === 'linkedin.com' && r.tier === 'attributable'),
);
check(
  'the roster unions the floor in so an accidental YAML deletion cannot unblock it',
  research_roster().attribution.hosts.some((h) => h.host === 'linkedin.com'),
);

// The kill switch must restore byte-identical prior behaviour.
process.env.HEARTH_RESEARCH_ATTRIBUTION = '0';
check(
  'kill switch permits everything again',
  fetch_permitted(LINKEDIN, 'household_browser', 'passive').allowed,
);
delete process.env.HEARTH_RESEARCH_ATTRIBUTION;
check(
  're-armed after the kill switch is cleared',
  !fetch_permitted(LINKEDIN, 'household_browser', 'passive').allowed,
);

const note = render_attribution_note([{ url: LINKEDIN, reason: capped.reason }]);
check('the dossier note names the url', note.includes(LINKEDIN));
check(
  '…and frames it as deliberately not read',
  /deliberately not read|left alone/i.test(note),
);
check('an empty refusal list renders nothing', render_attribution_note([]) === '');

/* ================================================================== */
section('B. Jurisdiction — Georgetown TX resolves to Williamson County');
/* ================================================================== */

check(
  'a bare "City, ST" is a candidate',
  extract_place_candidates('property at a Georgetown, TX address').includes('Georgetown, TX'),
);
check(
  '"City Statename" is a candidate too (how a brief is actually written)',
  extract_place_candidates('he lives in Georgetown Texas now').some((c) =>
    c.toLowerCase().startsWith('georgetown'),
  ),
);
check(
  'a full street address leads the candidates',
  extract_place_candidates('1204 Rivery Blvd, Georgetown, TX 78628')[0]?.includes('Rivery') === true,
);
check('a bare ZIP is a candidate', extract_place_candidates('lives in 78628').includes('78628'));
check(
  'a state name is not mistaken for a city',
  !extract_place_candidates('somewhere in West Virginia').some((c) => c.startsWith('West,')),
);
check(
  'prose with no place yields nothing',
  extract_place_candidates('he drives a silver sedan and works nights').length === 0,
);

/**
 * The REAL response shape from the household's own Nominatim, captured live:
 * "Georgetown, Texas" → address.county "Williamson County".
 */
const scripted_geocode: GeocodeFn = async (q) => {
  if (/georgetown/i.test(q)) {
    return {
      address: {
        city: 'Georgetown',
        county: 'Williamson County',
        state: 'Texas',
        'ISO3166-2-lvl4': 'US-TX',
      },
      display_name: 'Georgetown, Williamson County, Texas, United States',
    };
  }
  // A state-only hit must NOT satisfy the resolver — it cannot route a records
  // query, and accepting it is how you search the wrong county with confidence.
  if (/texas/i.test(q)) {
    return { address: { state: 'Texas', 'ISO3166-2-lvl4': 'US-TX' }, display_name: 'Texas' };
  }
  return null;
};

const j = await resolve_jurisdiction(
  ['He lives in Georgetown, TX'],
  'Does he own property at the Georgetown address?',
  scripted_geocode,
);
check('the county resolves', j?.county === 'Williamson County', String(j?.county));
check('the state resolves', j?.state === 'Texas');
check('the postal code resolves', j?.state_code === 'TX');
check('the city resolves', j?.city === 'Georgetown');
check('it records what resolved it', (j?.resolved_from ?? '').toLowerCase().includes('georgetown'));

const unresolvable = await resolve_jurisdiction([], 'find out about him', scripted_geocode);
check('no place anywhere → null, never a guess', unresolvable === null);
check(
  'a state-only geocode does NOT satisfy it',
  (await resolve_jurisdiction(['somewhere in Texas'], '', scripted_geocode)) === null,
);
check(
  'a dead geocoder fails open to null rather than throwing',
  (await resolve_jurisdiction(['Georgetown, TX'], '', async () => {
    throw new Error('nominatim down');
  })) === null,
);
check(
  'the unresolved line tells the owner how to fix it',
  /address|city and state/i.test(render_jurisdiction(null)),
);
check('the resolved line names the county', render_jurisdiction(j).includes('Williamson County'));

/* ================================================================== */
section('C. Records routing — the eighteen wrong sources');
/* ================================================================== */

/** The REAL fetch list from ri_3kq84nfd4mz0, byte counts from the box. */
const REAL_HITS = [
  { title: 'Pleasantville Arrest and Public Records | Colorado.StateRecords.org', url: 'https://colorado.staterecords.org/county/pleasantville', snippet: '' },
  { title: 'Public Records City of Pleasantville', url: 'https://www.citygov.com/publicrecords/', snippet: '' },
  { title: 'Jonathan Name Meaning: Origin, Popularity & Nicknames', url: 'https://momlovesbest.com/jonathan-name-meaning', snippet: '' },
  { title: 'Free 1GIG Kingston Flash Drive', url: 'https://mmsports.org/forum/showthread.php?tid=6627', snippet: '' },
  { title: 'Daniel Torres, Virginia (412 matches) - Spokeo', url: 'https://www.spokeo.com/Jonathan-Torres/Virginia', snippet: '' },
  { title: 'www.erome.com - video doesn\'t play · web-bugs · GitHub', url: 'https://github.com/webcompat/web-bugs/issues/116674', snippet: '' },
  { title: 'Jonathan (name) - Wikipedia', url: 'https://en.wikipedia.org/wiki/Jonathan_(name)', snippet: '' },
  { title: 'Jonathan: Biblical Meaning and Origin', url: 'https://bibledictionarytoday.com/biblical-names/jonathan/', snippet: '' },
  { title: 'Georgetown Property Records by Address - LoopNet.com', url: 'https://www.loopnet.com/sitemap/property-records/texas/georgetown/7/', snippet: '' },
  { title: 'Sign Up | LinkedIn', url: LINKEDIN, snippet: '' },
  { title: 'Access to this page has been denied', url: 'https://www.zoominfo.com/p/Jonathan-Torres/7026340087', snippet: '' },
  { title: 'Georgetown, TX Property Records - CountyOffice.org', url: 'https://www.countyoffice.org/georgetown-tx-property-records/', snippet: '' },
  // The one source that would have been worth reading.
  { title: 'Williamson Central Appraisal District — Property Search', url: 'https://www.wcad.org/property-search/', snippet: '' },
];

const ranked = rank_source_hits(REAL_HITS, { kind: 'records', jurisdiction: j });
check(
  'the county appraisal district is ranked FIRST for a records facet',
  ranked[0]?.url.includes('wcad.org') === true,
  ranked[0]?.url,
);
check(
  'the city .gov records page also rises above the aggregators',
  ranked.findIndex((h) => h.url.includes('citygov.com')) <
    ranked.findIndex((h) => h.url.includes('spokeo.com')),
);
for (const host of ['spokeo.com', 'zoominfo.com', 'countyoffice.org', 'staterecords.org', 'momlovesbest.com', 'bibledictionarytoday.com', 'loopnet.com']) {
  const idx = ranked.findIndex((h) => h.url.includes(host));
  check(
    `${host} is demoted below the appraisal district`,
    idx > ranked.findIndex((h) => h.url.includes('wcad.org')),
  );
}
check(
  'demotion applies to a TOPIC facet too — Spokeo is never the best use of a fetch slot',
  rank_source_hits(REAL_HITS, { kind: 'topic', jurisdiction: null }).at(-1)?.url !== undefined &&
    rank_source_hits(REAL_HITS, { kind: 'topic', jurisdiction: null })
      .slice(-7)
      .every((h) => is_demoted(h.url)),
);
check(
  'ranking is a REORDER — no hit is lost',
  ranked.length === REAL_HITS.length &&
    REAL_HITS.every((h) => ranked.some((r) => r.url === h.url)),
);
check(
  'engine order is preserved WITHIN a band (we re-prioritise classes, not relevance)',
  ranked.findIndex((h) => h.url.includes('momlovesbest')) <
    ranked.findIndex((h) => h.url.includes('bibledictionarytoday')),
);

// The official-host floor is what stops countyoffice.org impersonating a county.
check(
  'wcad.org clears the official-host floor',
  is_official_host('https://www.wcad.org/property-search/', ['.gov', '.us', '*cad.org']),
);
check(
  'a .gov clears it',
  is_official_host('https://www.wilcotx.gov/clerk', ['.gov', '.us', '*cad.org']),
);
check(
  'countyoffice.org does NOT clear it, however county-shaped the name',
  !is_official_host('https://www.countyoffice.org/georgetown-tx-property-records/', ['.gov', '.us', '*cad.org']),
);
check(
  'a bare-domain suffix matches on label boundaries only — never a lookalike',
  !is_official_host('https://notcad.org/x', ['cad.org']),
);
check(
  'the star form is what opts INTO the appraisal-district family',
  is_official_host('https://hcad.org/x', ['*cad.org']) &&
    is_official_host('https://dcad.org/x', ['*cad.org']),
);

// The query plan.
const plan = plan_records_queries(
  'Daniel Ray Torres',
  'does he own property at the Georgetown address',
  j,
  ['He lives in Georgetown, TX'],
);
check('with a jurisdiction, county systems are targeted', plan.targets.length > 0);
check(
  'the appraisal district is one of them',
  plan.targets.some((t) => t.id === 'county_appraisal_district'),
);
check(
  'the discovery query names the resolved county, not the household one',
  plan.queries.some((q) => q.includes('Williamson County')) &&
    !plan.queries.some((q) => /county|fort collins/i.test(q)),
);
check('jurisdiction_missing is false when resolved', !plan.jurisdiction_missing);

const blind = plan_records_queries('Daniel Ray Torres', 'court records', null, []);
check('with NO jurisdiction it flags the gap', blind.jurisdiction_missing);
check('…and targets no county system rather than guessing one', blind.targets.length === 0);
check(
  '…and quotes the full name so the engine cannot drop a token',
  blind.queries[0]?.includes('"Daniel Ray Torres"') === true,
);

/* ================================================================== */
section('D. Hard limits — CAPTCHA, forms, and the honest next step');
/* ================================================================== */

check(
  'a reCAPTCHA wall is detected',
  looks_captcha_walled('<div class="g-recaptcha" data-sitekey="x"></div>'),
);
check('an hCaptcha wall is detected', looks_captcha_walled('please complete the hCaptcha to continue'));
check('a Cloudflare Turnstile is detected', looks_captcha_walled('<div class="cf-turnstile">'));
check(
  'a page merely discussing captchas is not a wall',
  !looks_captcha_walled('Our research covers accessibility of visual puzzles on the web.'),
);
check(
  'a portal search FORM is recognised as not-results',
  looks_like_search_form('Property Search\nEnter the owner name to begin your search.'),
);
check(
  'a bulky real result set is not a form',
  !looks_like_search_form(`Property Search ${'owner record parcel valuation '.repeat(600)}`),
);

const limits = render_records_limits({
  jurisdiction: null,
  captcha_walled: ['https://search.wcad.org/'],
  forms_only: ['https://www.wilcotx.gov/clerk'],
  safety_relevant: true,
});
check('the limits section states the unresolved jurisdiction', /No jurisdiction/i.test(limits));
check('…names the CAPTCHA wall and refuses to bypass it', /CAPTCHA/i.test(limits) && /do not bypass/i.test(limits));
check('…points at the authoritative form as the right place', /authoritative/i.test(limits));
check('…and carries the safety escalation when records are closed', limits.includes(SAFETY_ESCALATION_NOTE));
check(
  'the escalation names a police report AND a licensed PI',
  /police report/i.test(SAFETY_ESCALATION_NOTE) && /private investigator/i.test(SAFETY_ESCALATION_NOTE),
);
check(
  '…and frames them as reaching what we cannot, not as a brush-off',
  /protective order/i.test(SAFETY_ESCALATION_NOTE),
);
check(
  'nothing unreachable → no limits section at all',
  render_records_limits({ jurisdiction: j, captcha_walled: [], forms_only: [], safety_relevant: false }) === '',
);

/* ================================================================== */
section('E. Identity anchor — same NAME is not same PERSON');
/* ================================================================== */

const anchor = anchor_from_facts([
  'He lives in Georgetown, TX',
  'Drives a silver Honda Civic',
]);
check('anchor registers the state', anchor.states.includes('TX'));
check('anchor keeps every owner fact as an attribute', anchor.attributes.length === 2);
check(
  'the place fact is typed as a place',
  anchor.attributes.some((a) => a.kind === 'place'),
);
check('owner facts are marked authoritative', anchor.attributes.every((a) => a.source === 'owner'));

// The Spokeo page: names him, 412 times, in the WRONG STATE. The name gate
// passes it. Only the anchor refuses it — and this is the page that would have
// supplied a stranger's address history.
const spokeo_body = `Daniel Torres in Virginia. We found 412 people named Daniel Torres
in Virginia. View Daniel Torres's phone number, address, email and more.
Virginia records for Daniel Torres. Richmond, Virginia. Norfolk, Virginia.
Daniel Torres Virginia Beach. Arlington Virginia. Daniel Torres, Virginia.`;

check(
  'the NAME gate passes the Spokeo page (it genuinely names him)',
  source_mentions_subject(spokeo_body, 'Daniel Torres').mentions,
);
const spokeo_anchor = source_corroborates_anchor(spokeo_body, anchor);
check('…but the ANCHOR refuses it', spokeo_anchor.verdict === 'conflicting');
check(
  '…naming the wrong state and the anchored one',
  /virginia/i.test(spokeo_anchor.reason) && /TX/.test(spokeo_anchor.reason),
  spokeo_anchor.reason,
);

const right_body = `Daniel Ray Torres of Georgetown, TX. Property owner record.
Williamson County. Georgetown TX 78628.`;
const good = source_corroborates_anchor(right_body, anchor);
check('a source corroborating the anchor is confirmed', good.verdict === 'confirmed');
check('…and reports which fact it corroborated', good.corroborated.length > 0);

const thin = source_corroborates_anchor('Daniel Torres is listed in the directory.', anchor);
check(
  'a thin entry that corroborates nothing is UNCONFIRMED, not refused',
  thin.verdict === 'unconfirmed',
);
check(
  'no anchor facts supplied → unconfirmed, never conflicting (nothing to conflict with)',
  source_corroborates_anchor(spokeo_body, anchor_from_facts([])).verdict === 'unconfirmed',
);
check(
  'a single passing mention of another state is NOT a conflict',
  source_corroborates_anchor(
    'Daniel Ray Torres, Georgetown TX. He once visited Virginia.',
    anchor,
  ).verdict !== 'conflicting',
);

/* ================================================================== */
section('F. Verification drops are opt-in, and the switch is live');
/* ================================================================== */

// Phase 3 gave the verifier a real corpus (the persisted bodies) instead of
// grading findings against themselves, so it can finally FAIL a claim — and
// therefore finally fail one wrongly. `dropped_claims` feeds a scrubber that
// DELETES dossier lines, so the shipped default is to flag. This pins that the
// opt-in path exists and is reachable rather than being dead code.
check('drops are OFF by default', !verify_drops_enabled());
process.env.HEARTH_RESEARCH_VERIFY_DROP = '1';
check('…and the env var turns them on', verify_drops_enabled());
delete process.env.HEARTH_RESEARCH_VERIFY_DROP;
check('…and clearing it restores flag-only', !verify_drops_enabled());

/* ================================================================== */
section('G. CourtListener — real records, honest coverage');
/* ================================================================== */

/** A REAL v4 hit, captured live from the API while building this. */
const real_hit = {
  caseName: 'JONATHAN GARCIA CRUZ',
  court: 'United States Bankruptcy Court, D. Arizona',
  court_id: 'arb',
  docketNumber: '2:26-bk-04777',
  dateFiled: '2026-05-13',
  chapter: '7',
  party: ['JONATHAN GARCIA CRUZ'],
  docket_absolute_url: '/docket/73339904/jonathan-garcia-cruz/',
  recap_documents: [{ snippet: '' }, { snippet: 'Certificate of Mailing' }],
};
const mapped = map_hit(real_hit, 'https://www.courtlistener.com');
check('case name maps', mapped.case_name === 'JONATHAN GARCIA CRUZ');
check('court maps', mapped.court.includes('Arizona'));
check('docket number maps', mapped.docket_number === '2:26-bk-04777');
check('filing date maps', mapped.date_filed === '2026-05-13');
check('bankruptcy chapter maps (the debt-history signal)', mapped.chapter === '7');
check('parties map', mapped.parties.includes('JONATHAN GARCIA CRUZ'));
check(
  'a relative docket url is absolutised',
  mapped.url === 'https://www.courtlistener.com/docket/73339904/jonathan-garcia-cruz/',
);
check(
  'the first NON-EMPTY recap snippet is used',
  mapped.snippet === 'Certificate of Mailing',
);
check(
  'an upstream shape change degrades to fewer fields, never a throw',
  map_hit({}, 'https://x').case_name === '(unnamed case)',
);

check('ISO date converts to the API format', to_cl_date('2015-01-01') === '01/01/2015');
check('a non-ISO date is rejected rather than mangled', to_cl_date('Jan 2015') === null);

check('host_of normalises www away', host_of('https://www.Spokeo.com/x') === 'spokeo.com');
check('an unparseable url yields no host rather than throwing', host_of('not a url') === null);

/* ================================================================== */
console.log(
  `\n${failures === 0 ? 'smoke:research-teeth OK' : `smoke:research-teeth FAILED`} — ` +
    `${checks - failures}/${checks} checks passed`,
);
process.exit(failures === 0 ? 0 : 1);
