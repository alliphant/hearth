/**
 * Pure civic-analysis helpers — Ruby's deterministic math over the voting
 * record and the money ledger. No DB, no LLM, no network: every function
 * here takes rows and returns analysis, so the smoke can pin the behavior
 * exactly (the Kristi cost_model.ts idiom).
 *
 *   - classify_civic_topic: keyword-bucket an agenda item so "how has X
 *     voted on housing, historically" is answerable without tagging
 *     anything at write time.
 *   - voting_record_summary: per-member tallies by topic over the
 *     recorded votes — the record, not the vibe.
 *   - alignment_matrix: pairwise agreement between members across items
 *     they BOTH cast a substantive vote on (aye/nay only — absences and
 *     abstentions say nothing about alignment), plus the contested items.
 *   - match_conflicts: deterministic donor/interest ↔ agenda-item
 *     proximity detection. Token-overlap on DISTINCTIVE name tokens only;
 *     generic civic words are stopworded so "Friends of Pleasantville"
 *     never "matches" the city budget. The output is a CANDIDATE with
 *     receipts — Ruby reviews it; the math never accuses anyone.
 */

// ── topics ───────────────────────────────────────────────────────────────────

export type CivicTopic =
  | 'housing'
  | 'land_use'
  | 'transport'
  | 'budget_tax'
  | 'police_safety'
  | 'utilities'
  | 'parks_natural_areas'
  | 'climate_energy'
  | 'governance'
  | 'other';

/**
 * Ordered — first bucket whose keyword hits wins, so the more specific
 * topics (housing) sit above the broader ones (land_use, governance).
 *
 * THE RULE FOR EDITING THIS TABLE: keywords name DURABLE CATEGORIES, never
 * the story of the month. A vendor ("flock"), a product, or a campaign
 * brand ("vision zero", "100x100") dates the taxonomy to whichever fight
 * happened to be live when someone typed it — and worse, it teaches the
 * classifier that surveillance means one company, so the successor
 * contract from a different vendor lands in `other`. Name the CAPABILITY
 * instead ("license plate", "facial recognition", "body camera") and the
 * bucket keeps working after the vendor changes. Permanent civic
 * institutions and infrastructure the city actually owns (citybus,
 * citypd, cityfiber, north-reservoir) are fair game — those aren't stories, they're
 * the furniture. (De-branded 2026-07-28 after the Flock contract ended and
 * the taxonomy still keyed on the vendor.)
 */
const TOPIC_KEYWORDS: Array<[CivicTopic, string[]]> = [
  ['housing', ['housing', 'affordable', 'adu', 'accessory dwelling', 'inclusionary', 'rental', 'tenant', 'homeless', 'shelter', 'missing middle', 'occupancy']],
  ['transport', ['transit', 'citybus', 'bus', 'bike', 'bicycle', 'pedestrian', 'sidewalk', 'street', 'road', 'highway', 'traffic', 'parking', 'rail', 'active modes', 'speed limit', 'traffic safety', 'crash', 'fatality', 'crosswalk']],
  ['parks_natural_areas', ['natural area', 'park', 'trail', 'open space', 'riverside', 'wildlife', 'recreation', 'golf']],
  ['utilities', ['utility', 'utilities', 'water', 'wastewater', 'stormwater', 'broadband', 'fiber', 'cityfiber', 'electric', 'light and power', 'light & power', 'sewer', 'north-reservoir', 'reservoir']],
  ['climate_energy', ['climate', 'renewable', 'solar', 'emissions', 'carbon', 'energy code', 'sustainability', 'efficiency', 'electrification']],
  ['police_safety', ['police', 'citypd', 'sheriff', 'surveillance', 'camera', 'license plate', 'automated license plate', 'alpr', 'facial recognition', 'body camera', 'data sharing', 'immigration', 'immigration enforcement', 'detainer', 'enforcement', 'public safety', 'use of force', 'jail', 'court']],
  ['budget_tax', ['budget', 'appropriation', 'tax', 'mill levy', 'bfo', 'fee', 'bond', 'revenue', 'fiscal', 'capital improvement', 'contract', 'procurement']],
  ['land_use', ['zoning', 'rezon', 'land use', 'annexation', 'development', 'plat', 'pud', 'metro district', 'density', 'height', 'variance', 'subdivision', 'site plan', 'signage']],
  ['governance', ['charter', 'ordinance', 'code of conduct', 'election', 'ballot', 'recall', 'board', 'commission', 'appointment', 'igr', 'iga', 'ethics']],
];

/** Word-boundary keyword test — plain substring matching mis-bucketed
 *  "Riverside TRAIL" via transport's "rail" and would hit "PARKing" via
 *  "park". Keywords match only at token starts ("zoning" still matches
 *  "rezoning" via the explicit "rezon" stem, not by accident). */
function keyword_hit(title_lower: string, keyword: string): boolean {
  const esc = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^a-z0-9])${esc}`, 'i').test(title_lower);
}

export function classify_civic_topic(item_title: string): CivicTopic {
  const t = item_title.toLowerCase();
  for (const [topic, keywords] of TOPIC_KEYWORDS) {
    if (keywords.some((k) => keyword_hit(t, k))) return topic;
  }
  return 'other';
}

// ── the watch board — a beat, not a watchlist ────────────────────────────────

/**
 * A tracked story's state is DERIVED from its timeline, never stored.
 *
 * The failure this replaces: `civic_watch_events` was append-only and
 * `status` lived on the EVENT, so nothing ever computed a topic-level
 * state and nothing ever aged a story out. A fight that resolved in March
 * looked exactly like a fight that broke this morning, forever — which is
 * why the beat had to be pinned in the persona to feel alive, and why it
 * stayed pinned long after the story closed.
 *
 * Deriving instead of storing is the whole trick: there is no sweep job to
 * run, no state to fall out of sync, and a dormant story REVIVES for free
 * the moment a new development lands (the newest event is recent again).
 * The office already self-cleans past-dated items on read the same way.
 *
 * Precedence, newest event first:
 *   1. newest event says `resolved`  → resolved (an explicit close is sticky)
 *   2. newest event says `dormant`   → dormant (Ruby closed it by hand)
 *   3. quiet longer than `dormant_days`     → dormant (aged off the board)
 *   4. quiet longer than `going_quiet_days` → going_quiet (still on the
 *      board, flagged for a keep-or-close call)
 *   5. otherwise                     → open
 */
export type WatchTopicStatus = 'open' | 'going_quiet' | 'dormant' | 'resolved';

/** The event fields the rollup needs — structurally satisfied by
 *  CivicWatchEventRow, so callers pass those rows straight through. */
export interface WatchEventLike {
  topic: string;
  headline: string;
  detail?: string | null;
  event_at: string;
  status?: string | null;
  source_url?: string | null;
  why_tracked?: string | null;
}

export interface WatchTopicSummary {
  topic: string;
  status: WatchTopicStatus;
  /** True while the topic belongs on the ACTIVE board (open | going_quiet). */
  active: boolean;
  /** Newest development's date, as recorded. */
  last_event_at: string;
  /** Whole days since the newest development (0 when it landed today). */
  days_quiet: number;
  event_count: number;
  latest_headline: string;
  /** First development's date — how long this has been a story. */
  first_event_at: string;
  /** Ruby's stated reason for tracking it, from the earliest event that
   *  carried one. This is what makes the board auditable: a topic whose
   *  reason no longer holds is one she should close. */
  why_tracked: string | null;
  /** Set on resolved/dormant topics — the headline that closed it. */
  closed_by: string | null;
  latest_source_url: string | null;
}

export interface WatchDormancyTunables {
  /** Quiet this long → flagged `going_quiet` for a keep-or-close call. */
  going_quiet_days: number;
  /** Quiet this long → off the active board (archived, never deleted). */
  dormant_days: number;
}

/**
 * Pleasantville council meets roughly twice a month and boards on monthly
 * cycles, so a live fight surfaces at least every few weeks; six weeks of
 * silence is a real signal, and three months without a development means
 * the story is over or Ruby stopped looking. Both are the honest defaults
 * for a MUNICIPAL cadence — a legislature in session moves faster, a
 * budget cycle slower.
 */
export const WATCH_DORMANCY_DEFAULTS: WatchDormancyTunables = {
  going_quiet_days: 45,
  dormant_days: 90,
};

const DAY_MS = 86_400_000;

/** Whole days between two ISO instants; negative spans clamp to 0 so a
 *  future-dated event (a scheduled hearing) never reads as stale. */
function days_between(from_iso: string, to_iso: string): number {
  const from = Date.parse(from_iso);
  const to = Date.parse(to_iso);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return 0;
  return Math.max(0, Math.floor((to - from) / DAY_MS));
}

/**
 * Roll a flat event stream up into one row per topic, newest-development
 * first. Pure: same rows + same `now` always give the same board, so the
 * smoke pins the lifecycle exactly.
 */
export function summarize_watch_topics(
  events: readonly WatchEventLike[],
  now_iso: string,
  tunables: WatchDormancyTunables = WATCH_DORMANCY_DEFAULTS,
): WatchTopicSummary[] {
  const by_topic = new Map<string, WatchEventLike[]>();
  for (const e of events) {
    const key = e.topic.trim().toLowerCase();
    if (!key) continue;
    const list = by_topic.get(key);
    if (list) list.push(e);
    else by_topic.set(key, [e]);
  }

  const out: WatchTopicSummary[] = [];
  for (const [topic, rows] of by_topic) {
    // Newest first. Ties break on the order they arrived so a same-day
    // correction (recorded second) wins over the entry it corrects.
    const sorted = [...rows].sort((a, b) => (a.event_at < b.event_at ? 1 : a.event_at > b.event_at ? -1 : 0));
    const newest = sorted[0]!;
    const oldest = sorted[sorted.length - 1]!;
    const days_quiet = days_between(newest.event_at, now_iso);

    let status: WatchTopicStatus;
    if (newest.status === 'resolved') status = 'resolved';
    else if (newest.status === 'dormant') status = 'dormant';
    else if (days_quiet >= tunables.dormant_days) status = 'dormant';
    else if (days_quiet >= tunables.going_quiet_days) status = 'going_quiet';
    else status = 'open';

    // The reason travels from the EARLIEST event that stated one — the
    // criterion she opened it under, not a later restatement.
    let why: string | null = null;
    for (let i = sorted.length - 1; i >= 0; i--) {
      const w = sorted[i]!.why_tracked?.trim();
      if (w) { why = w; break; }
    }

    out.push({
      topic,
      status,
      active: status === 'open' || status === 'going_quiet',
      last_event_at: newest.event_at,
      days_quiet,
      event_count: sorted.length,
      latest_headline: newest.headline,
      first_event_at: oldest.event_at,
      why_tracked: why,
      closed_by: status === 'resolved' || status === 'dormant' ? newest.headline : null,
      latest_source_url: newest.source_url ?? null,
    });
  }

  // Active stories first, then most-recently-moved — the board reads as a
  // newsroom budget line, not a database dump.
  const rank: Record<WatchTopicStatus, number> = { open: 0, going_quiet: 1, resolved: 2, dormant: 3 };
  out.sort((a, b) => rank[a.status] - rank[b.status] || (a.last_event_at < b.last_event_at ? 1 : -1));
  return out;
}

// ── voting record ────────────────────────────────────────────────────────────

/** The vote fields the analysis needs — structurally satisfied by the main
 *  DB's CivicVoteRow, so callers pass those rows straight through. */
export interface VoteLike {
  member_name: string;
  item_title: string;
  vote: string;
  meeting_id?: string | null;
  meeting_date?: string | null;
  outcome?: string | null;
  source_url?: string;
}

export interface TopicTally {
  topic: CivicTopic;
  aye: number;
  nay: number;
  abstain: number;
  recused: number;
  absent: number;
  /** Up to 3 newest item titles, for grounding the tally in examples. */
  sample_items: string[];
}

export interface VotingRecordSummary {
  member: string;
  total_votes: number;
  aye: number;
  nay: number;
  recused: number;
  by_topic: TopicTally[];
}

function norm_name(s: string): string {
  return s.toLowerCase().trim().replace(/\s+/g, ' ');
}

export function voting_record_summary(votes: VoteLike[], member: string): VotingRecordSummary {
  const key = norm_name(member);
  const mine = votes.filter((v) => norm_name(v.member_name) === key);
  const buckets = new Map<CivicTopic, TopicTally>();
  let aye = 0;
  let nay = 0;
  let recused = 0;
  for (const v of mine) {
    const topic = classify_civic_topic(v.item_title);
    let b = buckets.get(topic);
    if (!b) {
      b = { topic, aye: 0, nay: 0, abstain: 0, recused: 0, absent: 0, sample_items: [] };
      buckets.set(topic, b);
    }
    if (v.vote === 'aye') { b.aye++; aye++; }
    else if (v.vote === 'nay') { b.nay++; nay++; }
    else if (v.vote === 'abstain') b.abstain++;
    else if (v.vote === 'recused') { b.recused++; recused++; }
    else if (v.vote === 'absent') b.absent++;
    if (b.sample_items.length < 3 && !b.sample_items.includes(v.item_title)) {
      b.sample_items.push(v.item_title);
    }
  }
  const by_topic = [...buckets.values()].sort(
    (a, b) => b.aye + b.nay + b.abstain + b.recused + b.absent - (a.aye + a.nay + a.abstain + a.recused + a.absent),
  );
  return { member: mine[0]?.member_name ?? member, total_votes: mine.length, aye, nay, recused, by_topic };
}

// ── alignment ────────────────────────────────────────────────────────────────

export interface AlignmentPair {
  a: string;
  b: string;
  shared: number;
  agreements: number;
  agreement_pct: number;
}

export interface ContestedItem {
  item_title: string;
  meeting_date: string;
  ayes: string[];
  nays: string[];
}

export interface AlignmentResult {
  pairs: AlignmentPair[];
  contested: ContestedItem[];
  members: string[];
  items_counted: number;
}

function item_key(v: VoteLike): string {
  return `${v.meeting_id ?? v.meeting_date ?? 'na'}::${v.item_title.toLowerCase().trim()}`;
}

/**
 * Pairwise agreement over items where both members cast a SUBSTANTIVE vote
 * (aye/nay). Pairs below `min_shared` shared items are dropped — two votes
 * of overlap is noise, not a bloc. `contested` lists items with at least
 * one vote on each side, newest first — the splits that actually divide
 * the council.
 */
export function alignment_matrix(votes: VoteLike[], min_shared = 3): AlignmentResult {
  // item -> member -> aye|nay (last write wins; the record is idempotent upstream)
  const items = new Map<string, { title: string; date: string; stances: Map<string, 'aye' | 'nay'> }>();
  const display = new Map<string, string>();
  for (const v of votes) {
    if (v.vote !== 'aye' && v.vote !== 'nay') continue;
    const k = item_key(v);
    let it = items.get(k);
    if (!it) {
      it = { title: v.item_title, date: v.meeting_date ?? '', stances: new Map() };
      items.set(k, it);
    }
    const m = norm_name(v.member_name);
    display.set(m, v.member_name);
    it.stances.set(m, v.vote);
  }

  const pair_stats = new Map<string, { a: string; b: string; shared: number; agreements: number }>();
  const contested: ContestedItem[] = [];
  for (const it of items.values()) {
    const members = [...it.stances.keys()].sort();
    const ayes = members.filter((m) => it.stances.get(m) === 'aye');
    const nays = members.filter((m) => it.stances.get(m) === 'nay');
    if (ayes.length > 0 && nays.length > 0) {
      contested.push({
        item_title: it.title,
        meeting_date: it.date,
        ayes: ayes.map((m) => display.get(m) ?? m),
        nays: nays.map((m) => display.get(m) ?? m),
      });
    }
    for (let i = 0; i < members.length; i++) {
      for (let j = i + 1; j < members.length; j++) {
        const a = members[i]!;
        const b = members[j]!;
        const pk = `${a}|${b}`;
        let p = pair_stats.get(pk);
        if (!p) {
          p = { a: display.get(a) ?? a, b: display.get(b) ?? b, shared: 0, agreements: 0 };
          pair_stats.set(pk, p);
        }
        p.shared++;
        if (it.stances.get(a) === it.stances.get(b)) p.agreements++;
      }
    }
  }

  const pairs = [...pair_stats.values()]
    .filter((p) => p.shared >= min_shared)
    .map((p) => ({ ...p, agreement_pct: Math.round((p.agreements / p.shared) * 100) }))
    .sort((x, y) => x.agreement_pct - y.agreement_pct);
  contested.sort((x, y) => (x.meeting_date < y.meeting_date ? 1 : -1));
  return {
    pairs,
    contested: contested.slice(0, 20),
    members: [...display.values()].sort(),
    items_counted: items.size,
  };
}

// ── conflict matching ────────────────────────────────────────────────────────

/** A documented money/interest tie between a member and a counterparty,
 *  built by the caller from the donations + interests stores. */
export interface TieRecord {
  member: string;
  member_slug: string;
  counterparty: string;
  counterparty_slug: string;
  basis: 'donation' | 'interest';
  amount_usd?: number | null;
  /** Receipt line, e.g. "donated $500 total across 2 gifts (2025 cycle, city_clerk filing)". */
  detail: string;
  source_url: string;
}

export interface ConflictCandidate {
  member: string;
  member_slug: string;
  item_title: string;
  meeting_date: string;
  vote: string;
  counterparty: string;
  counterparty_slug: string;
  basis: 'donation' | 'interest' | 'both';
  amount_usd: number | null;
  matched_tokens: string[];
  evidence: string[];
  source_urls: string[];
}

/** Generic civic vocabulary that appears in BOTH donor/org names and agenda
 *  items without indicating any tie. Distinctiveness is the whole game:
 *  "Brinkman" matching a Brinkman rezoning is signal; "Pleasantville"
 *  matching anything is noise. */
const NAME_STOPWORDS = new Set([
  'fort', 'collins', 'colorado', 'city', 'county', 'county', 'north', 'south', 'east', 'west',
  'the', 'and', 'for', 'of', 'llc', 'inc', 'corp', 'company', 'group', 'committee', 'friends',
  'citizens', 'coalition', 'association', 'foundation', 'fund', 'pac', 'campaign', 'elect',
  'development', 'developments', 'properties', 'property', 'real', 'estate', 'homes', 'home',
  'builders', 'services', 'partners', 'holdings', 'enterprises', 'management', 'investments',
]);

/** Distinctive tokens of a name: length ≥ 4, not generic civic vocabulary. */
export function distinctive_tokens(name: string): string[] {
  return [...new Set(
    name
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((t) => t.length >= 4 && !NAME_STOPWORDS.has(t)),
  )];
}

function whole_word_hit(haystack_lower: string, token: string): boolean {
  const re = new RegExp(`(^|[^a-z0-9])${token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^a-z0-9])`, 'i');
  return re.test(haystack_lower);
}

/**
 * Cross-reference recorded votes against documented ties. A candidate fires
 * when a tie's counterparty has at least one DISTINCTIVE token appearing as
 * a whole word in an agenda item the member voted on. Ties with no
 * distinctive tokens (a fully-generic name) can never match — by design.
 * Duplicate (member, counterparty, item) hits across both bases merge into
 * one candidate with basis 'both'.
 */
export function match_conflicts(votes: VoteLike[], ties: TieRecord[]): ConflictCandidate[] {
  const by_key = new Map<string, ConflictCandidate>();
  const tokens_cache = new Map<string, string[]>();
  for (const tie of ties) {
    if (!tokens_cache.has(tie.counterparty_slug)) {
      tokens_cache.set(tie.counterparty_slug, distinctive_tokens(tie.counterparty));
    }
  }

  for (const v of votes) {
    const member_key = norm_name(v.member_name);
    const title_lower = v.item_title.toLowerCase();
    for (const tie of ties) {
      if (norm_name(tie.member) !== member_key) continue;
      const tokens = tokens_cache.get(tie.counterparty_slug) ?? [];
      const hits = tokens.filter((t) => whole_word_hit(title_lower, t));
      if (hits.length === 0) continue;

      const key = `${tie.member_slug}|${tie.counterparty_slug}|${v.item_title.toLowerCase().trim()}`;
      const existing = by_key.get(key);
      if (existing) {
        if (existing.basis !== tie.basis) existing.basis = 'both';
        if (tie.amount_usd != null) {
          existing.amount_usd = Math.max(existing.amount_usd ?? 0, tie.amount_usd);
        }
        if (!existing.evidence.includes(tie.detail)) existing.evidence.push(tie.detail);
        if (!existing.source_urls.includes(tie.source_url)) existing.source_urls.push(tie.source_url);
        for (const h of hits) if (!existing.matched_tokens.includes(h)) existing.matched_tokens.push(h);
      } else {
        by_key.set(key, {
          member: v.member_name,
          member_slug: tie.member_slug,
          item_title: v.item_title,
          meeting_date: v.meeting_date ?? '',
          vote: v.vote,
          counterparty: tie.counterparty,
          counterparty_slug: tie.counterparty_slug,
          basis: tie.basis,
          amount_usd: tie.amount_usd ?? null,
          matched_tokens: hits,
          evidence: [tie.detail],
          source_urls: [tie.source_url],
        });
      }
    }
  }
  return [...by_key.values()];
}

/** Deterministic severity for a candidate — bigger documented money and
 *  multi-basis ties rank higher. Review can always override via
 *  record_conflict_flag's explicit severity. */
export function conflict_severity(c: ConflictCandidate): 'low' | 'medium' | 'high' {
  if (c.basis === 'both') return 'high';
  if ((c.amount_usd ?? 0) >= 1_000) return 'high';
  if ((c.amount_usd ?? 0) >= 250 || c.basis === 'interest') return 'medium';
  return 'low';
}

// ── evidence-quote grounding (the write-side fabrication gate) ───────────────

// The two primitives moved to @core/quote_grounding 2026-07-31 so deep
// research's §3.5 quote-anchoring rung uses THIS check rather than growing a
// second dialect of "is this quote real". Re-exported here: every existing
// caller (and this module's smoke) is unchanged.
export { normalize_for_quote, quote_in_evidence } from '@core/quote_grounding';

/** The read tools whose audited results count as a turn's evidence
 *  substrate. Reads only — a prior WRITE echoing a claim back must never
 *  count as evidence for it. */
export const EVIDENCE_READ_TOOLS = [
  'web_fetch_clean',
  'browse_url',
  'fetch_council_meetings',
  'read_subreddit',
  'read_reddit_thread',
  'search_library',
  'read_note',
] as const;

/** Official-document floor for the vote extractor: roll-call votes enter
 *  the record ONLY from city/government documents, never from reporting.
 *  (News can prompt a look; the minutes are the record.) */
const OFFICIAL_CIVIC_HOSTS = [
  'pleasantville.gov',
  'citygov.com',
  'municodemeetings.com',
  'county.gov',
  'colorado.gov',
  'leg.colorado.gov',
];

export function is_official_civic_host(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return OFFICIAL_CIVIC_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
  } catch {
    return false;
  }
}

// ── member-name sanity (the polluted-roster fix, 2026-07-29) ─────────────────

/** Generic civic role/body words. A "name" made only of these is a heading
 *  the extractor scraped, not a person. */
const ROLE_WORDS = new Set([
  'councilmember', 'councilmembers', 'councilman', 'councilwoman', 'council',
  'city', 'mayor', 'pro', 'tem', 'protem', 'member', 'members', 'board',
  'commission', 'commissioner', 'staff', 'attorney', 'clerk', 'manager',
  'district', 'the', 'and', 'of', 'for', 'chair', 'vice', 'president',
]);

/**
 * Is this plausibly a PERSON's name rather than a scraped heading?
 *
 * The live roster accumulated exactly two rows — "Councilmember" and "City
 * Council" — with empty role/district/term, and 2 votes attributed to them.
 * `member_dossier("Chris Barrett")` therefore returned nothing and the whole
 * receipts ledger sat unbacked. The extractor was lifting agenda headings
 * into `member_name`.
 *
 * The rule: a person's name carries at least one token that is NOT generic
 * civic vocabulary. "Chris Barrett" passes; "Councilmember" and "City Council"
 * do not. Deliberately permissive about everything else — one-word surnames,
 * hyphens, apostrophes, accents and non-Latin scripts all pass, because
 * rejecting a real councilmember is worse than admitting a rare bad row.
 */
export function is_plausible_member_name(name: string): boolean {
  const trimmed = name.trim();
  if (trimmed.length < 2) return false;
  const tokens = trimmed
    .toLowerCase()
    .replace(/[.,]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  if (tokens.length === 0) return false;
  // At least one token must not be generic civic vocabulary, and must not be
  // a bare number or single initial.
  return tokens.some((t) => {
    const bare = t.replace(/[^\p{L}\p{N}'-]/gu, '');
    if (bare.length < 2) return false;
    if (/^\d+$/.test(bare)) return false;
    return !ROLE_WORDS.has(bare);
  });
}

// ── watching-lead expiry (the 71%-of-the-office fix, 2026-07-31) ─────────────

/**
 * The `watching` bucket is the escape hatch of the evidence-quote gate, and
 * without a lifetime it is a leak.
 *
 * `record_civic_item` requires a verified `evidence_quote` for the kinds that
 * ASSERT something (`announcement`, `agenda_item`) — and each of its three
 * rejection paths tells the model the same thing: *"or record it as kind
 * 'watching' instead."* That steer is correct; an unconfirmed lead should not
 * be filed as fact. But `watching` is the one kind with no gate, and nothing
 * ever aged one out, so every blocked claim accumulated there permanently:
 * 96 of the office's 136 active items — 71% — were unverified leads, some
 * two months old, including dated ones whose date had long passed ("Fort
 * Collins 2026 Fourth of July celebration planning", filed June 1).
 *
 * Expiry is what makes the escape hatch honest: a lead now either gets
 * verified (re-recorded as a real kind, with a quote) or it ages out.
 *
 * Two ways a lead dies, and they are deliberately different:
 *  - it was DATED and the date has passed → the thing happened; it is no
 *    longer something to watch for.
 *  - it was UNDATED and nobody touched it for `stale_days` → the lead never
 *    went anywhere. `ts_updated` (not `ts_created`) is the clock, so a lead
 *    Ruby re-records on a later pass keeps its life.
 *
 * Pure + `now`-parameterized (the repo's date-scan rule) so the sweep and the
 * smoke can ground on the same instant.
 */
export interface CivicExpiryConfig {
  /** Days after `event_at` before a dated lead is considered past. */
  event_grace_days: number;
  /** Days without an update before an undated lead is considered stale. */
  stale_days: number;
}

export const DEFAULT_CIVIC_EXPIRY: CivicExpiryConfig = {
  event_grace_days: 2,
  stale_days: 30,
};

/** The subset of a civic_items row the decision needs. */
export interface ExpiryCandidate {
  kind: string;
  status: string;
  event_at: string | null;
  ts_updated: string;
}

export type CivicExpiryVerdict =
  | { expire: false; reason: null }
  | { expire: true; reason: 'event_passed' | 'unverified_and_stale' };

const KEEP: CivicExpiryVerdict = { expire: false, reason: null };

/**
 * Should this item be archived?
 *
 * Only `watching` is subject to expiry. The other kinds are RECORDS backed by
 * an evidence quote or by the MuniCode feed, not leads — aging those out
 * would delete the office's actual reporting. And only `active` rows are
 * touched: `dismissed` is a human "no" and must stay dismissed (the existing
 * contract `smoke:ruby-civic` already pins), while `expired` is this
 * function's own verdict and re-deciding it is a no-op.
 */
export function civic_expiry_verdict(
  item: ExpiryCandidate,
  now: Date,
  cfg: CivicExpiryConfig = DEFAULT_CIVIC_EXPIRY,
): CivicExpiryVerdict {
  if (item.status !== 'active') return KEEP;
  if (item.kind !== 'watching') return KEEP;

  const now_ms = now.getTime();

  // A dated lead outlives its date by a short grace, then it is history.
  if (item.event_at) {
    const at = Date.parse(item.event_at);
    if (!Number.isNaN(at)) {
      if (now_ms - at > cfg.event_grace_days * 86_400_000) {
        return { expire: true, reason: 'event_passed' };
      }
      // Dated and still upcoming (or inside the grace) — keep it regardless
      // of age. A lead about a meeting three months out is not stale.
      return KEEP;
    }
    // An unparseable date is treated as undated rather than trusted: fall
    // through to the staleness rule.
  }

  const touched = Date.parse(item.ts_updated);
  if (Number.isNaN(touched)) return KEEP; // never guess from a bad timestamp
  if (now_ms - touched > cfg.stale_days * 86_400_000) {
    return { expire: true, reason: 'unverified_and_stale' };
  }
  return KEEP;
}
