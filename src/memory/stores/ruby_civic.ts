/**
 * Ruby's civic-intelligence ledger — the money-and-interests side of the
 * Pleasantville record. The VOTES side already lives in the main DB
 * (`civic_votes` / `civic_members`, written via record_civic_vote /
 * upsert_civic_member); this store holds what those tables can't:
 *
 *   - `donations`        — campaign contributions per candidate/member,
 *                          lifted from city-clerk filings, TRACER (the
 *                          Colorado SoS campaign-finance system), and
 *                          credible local reporting. Exact amounts, donors,
 *                          dates — never vibes.
 *   - `finance_filings`  — per-committee filing-period summaries (raised /
 *                          spent / cash on hand).
 *   - `member_interests` — disclosed or reported ties: employer, business
 *                          ownership, board seats, property, clients.
 *   - `conflict_flags`   — DERIVED proximity records: a documented tie
 *                          (donation / interest) near a recorded vote. A
 *                          flag is a QUESTION with receipts, never an
 *                          accusation — the status machine (flagged →
 *                          reviewed → substantiated | cleared) is Ruby
 *                          doing the verification work before anything is
 *                          characterized to the household.
 *
 * Every row requires a `source_url` — same verification floor as
 * record_civic_vote: no claim enters the record without the document it
 * came from. Write-side plausibility gates reject misreads (a $0 or
 * $5,000,000 "contribution" is an extraction error, not a fact) and return
 * `{ stored, reason }` so callers count rejections instead of swallowing
 * them — the Kristi cost-engine pattern.
 *
 * Facts here are PUBLIC RECORD about PUBLIC officials (filings, minutes,
 * disclosures), not household data — so like Kristi's market cache the
 * store is global, not per-user, and lives in its OWN SQLite file beside
 * hearth.db (default `<dir of HEARTH_DB_PATH>/ruby_civic.db`, override
 * with HEARTH_RUBY_CIVIC_DB_PATH) so it never bloats the main DB.
 */

import { Database } from 'bun:sqlite';
import { dirname, resolve } from 'node:path';

// ── DB location ──────────────────────────────────────────────────────────────

function civic_db_path(): string {
  const override = process.env.HEARTH_RUBY_CIVIC_DB_PATH?.trim();
  if (override) return override;
  const main = process.env.HEARTH_DB_PATH ?? './data/hearth.db';
  return resolve(dirname(main), 'ruby_civic.db');
}

// ── enums (string unions, stored as TEXT) ────────────────────────────────────

export type DonorType =
  | 'individual'
  | 'business'
  | 'pac'
  | 'party'
  | 'union'
  | 'nonprofit'
  | 'self'
  | 'unknown';
export type Jurisdiction = 'city' | 'county' | 'state' | 'federal';
/** Where a money fact was read from. city_clerk = a Pleasantville campaign-
 *  finance filing; tracer = the Colorado SoS TRACER system; news = credible
 *  reporting (treat as needing corroboration against a filing). */
export type FinanceSourceKind = 'city_clerk' | 'tracer' | 'news' | 'other';
export type InterestKind =
  | 'employer'
  | 'business_ownership'
  | 'board_seat'
  | 'property'
  | 'client'
  | 'family'
  | 'investment'
  | 'other';
export type ConflictBasis = 'donation' | 'interest' | 'both';
export type ConflictSeverity = 'low' | 'medium' | 'high';
/** flagged = the deterministic scan (or Ruby) noticed proximity; reviewed =
 *  Ruby read the underlying documents; substantiated = the tie held up and
 *  is worth surfacing; cleared = innocent explanation found / tie debunked.
 *  A re-scan NEVER resurrects a cleared flag (status is preserved on
 *  upsert unless explicitly passed). */
export type ConflictStatus = 'flagged' | 'reviewed' | 'substantiated' | 'cleared';

export const DONOR_TYPES: ReadonlySet<string> = new Set([
  'individual', 'business', 'pac', 'party', 'union', 'nonprofit', 'self', 'unknown',
]);
export const JURISDICTIONS: ReadonlySet<string> = new Set(['city', 'county', 'state', 'federal']);
export const FINANCE_SOURCE_KINDS: ReadonlySet<string> = new Set(['city_clerk', 'tracer', 'news', 'other']);
export const INTEREST_KINDS: ReadonlySet<string> = new Set([
  'employer', 'business_ownership', 'board_seat', 'property', 'client', 'family', 'investment', 'other',
]);
export const CONFLICT_BASES: ReadonlySet<string> = new Set(['donation', 'interest', 'both']);
export const CONFLICT_SEVERITIES: ReadonlySet<string> = new Set(['low', 'medium', 'high']);
export const CONFLICT_STATUSES: ReadonlySet<string> = new Set(['flagged', 'reviewed', 'substantiated', 'cleared']);

/** The Politics Desk's non-local altitudes. Pleasantville items stay in the
 *  main DB's `civic_items` (corridor matching, the scan's meeting rows);
 *  these scopes are the promotion (2026-06-10 #2): Colorado, the nation,
 *  the world. */
export type PoliticsScope = 'state' | 'national' | 'world';
export type PoliticsItemKind =
  | 'bill'
  | 'election'
  | 'ruling'
  | 'executive'
  | 'policy'
  | 'event'
  | 'watching';
export const POLITICS_SCOPES: ReadonlySet<string> = new Set(['state', 'national', 'world']);
export const POLITICS_KINDS: ReadonlySet<string> = new Set([
  'bill', 'election', 'ruling', 'executive', 'policy', 'event', 'watching',
]);
/** Fact-kinds carry a citation floor (an url is required); 'watching' is
 *  Ruby's own radar and may not have one document yet. */
const POLITICS_FACT_KINDS: ReadonlySet<string> = new Set([
  'bill', 'election', 'ruling', 'executive', 'policy', 'event',
]);

/** Normalized join/dedup key for names (people, donors, orgs, items). */
export function civic_slug(s: string, max = 80): string {
  return s
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max);
}

// ── plausibility gates (write chokepoints) ───────────────────────────────────

/** Municipal/state contributions live in a known range. Pleasantville caps
 *  individual council contributions at the low hundreds; self-funding and
 *  state-level committees run larger. Outside (0, 250k] is an extraction
 *  misread (a "$X/mo" line, a cycle TOTAL read as one gift, a decimal
 *  shift), not a fact. */
const DONATION_MAX_USD = 250_000;
/** A filing-period total for a local/state committee. */
const FILING_TOTAL_MAX_USD = 50_000_000;

function valid_url(u: unknown): u is string {
  return typeof u === 'string' && /^https?:\/\//i.test(u) && u.length <= 500;
}

export interface WriteVerdict {
  stored: boolean;
  reason?: string;
  id?: number;
}

// ── row shapes ───────────────────────────────────────────────────────────────

export interface DonationInput {
  recipient: string;
  committee?: string;
  donor: string;
  donor_type?: string;
  employer?: string;
  occupation?: string;
  amount_usd: number;
  donated_at?: string;
  election_cycle?: string;
  in_kind?: boolean;
  jurisdiction?: string;
  source_kind?: string;
  source_url: string;
  notes?: string;
}

export interface DonationRow {
  id: number;
  recipient: string;
  recipient_slug: string;
  committee: string;
  donor: string;
  donor_slug: string;
  donor_type: DonorType;
  employer: string;
  occupation: string;
  amount_usd: number;
  donated_at: string;
  election_cycle: string;
  in_kind: number;
  jurisdiction: Jurisdiction;
  source_kind: FinanceSourceKind;
  source_url: string;
  notes: string;
  captured_at: string;
}

export interface DonorRollupRow {
  recipient: string;
  recipient_slug: string;
  donor: string;
  donor_slug: string;
  donor_type: string;
  n: number;
  total_usd: number;
  first_donated_at: string;
  last_donated_at: string;
  /** A representative citing filing URL from the group (for receipts). */
  source_url: string;
}

export interface FilingInput {
  candidate: string;
  committee?: string;
  period: string;
  total_raised_usd?: number | null;
  total_spent_usd?: number | null;
  cash_on_hand_usd?: number | null;
  jurisdiction?: string;
  source_url: string;
}

export interface FilingRow {
  id: number;
  candidate: string;
  candidate_slug: string;
  committee: string;
  period: string;
  total_raised_usd: number | null;
  total_spent_usd: number | null;
  cash_on_hand_usd: number | null;
  jurisdiction: Jurisdiction;
  source_url: string;
  captured_at: string;
}

export interface InterestInput {
  member: string;
  kind?: string;
  organization: string;
  description?: string;
  disclosed?: boolean;
  as_of?: string;
  source_url: string;
}

export interface InterestRow {
  id: number;
  member: string;
  member_slug: string;
  kind: InterestKind;
  organization: string;
  org_slug: string;
  description: string;
  disclosed: number;
  as_of: string;
  source_url: string;
  captured_at: string;
}

export interface ConflictFlagInput {
  member: string;
  item_title: string;
  meeting_date?: string;
  vote?: string;
  basis: string;
  counterparty: string;
  amount_usd?: number | null;
  evidence_md: string;
  severity?: string;
  /** Omit to PRESERVE an existing row's status (a re-scan must not
   *  resurrect a cleared flag). Pass explicitly to transition. */
  status?: string;
  source_urls: string[];
}

export interface ConflictFlagRow {
  id: number;
  member: string;
  member_slug: string;
  item_title: string;
  item_slug: string;
  meeting_date: string;
  vote: string;
  basis: ConflictBasis;
  counterparty: string;
  counterparty_slug: string;
  amount_usd: number | null;
  evidence_md: string;
  severity: ConflictSeverity;
  status: ConflictStatus;
  source_urls: string;
  first_flagged_at: string;
  last_seen_at: string;
}

export interface PoliticsItemInput {
  scope: PoliticsScope;
  kind?: string;
  title: string;
  summary?: string;
  /** Ruby's grounded view — sticky on re-record (an empty take never
   *  wipes an existing one). */
  take_md?: string;
  event_at?: string;
  url?: string;
  source?: string;
  interest_score?: number;
  dedup_key?: string;
}

export interface PoliticsItemRow {
  id: number;
  scope: PoliticsScope;
  kind: PoliticsItemKind;
  title: string;
  summary: string;
  take_md: string;
  event_at: string;
  url: string;
  source: string;
  interest_score: number;
  status: 'active' | 'dismissed' | 'expired';
  dedup_key: string;
  ts_created: string;
  ts_updated: string;
}

// ── the store ────────────────────────────────────────────────────────────────

export class RubyCivicStore {
  readonly db: Database;

  constructor(path: string = civic_db_path()) {
    this.db = new Database(path, { create: true });
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA synchronous = NORMAL;');
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS donations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        recipient TEXT NOT NULL,
        recipient_slug TEXT NOT NULL,
        committee TEXT NOT NULL DEFAULT '',
        donor TEXT NOT NULL,
        donor_slug TEXT NOT NULL,
        donor_type TEXT NOT NULL DEFAULT 'unknown',
        employer TEXT NOT NULL DEFAULT '',
        occupation TEXT NOT NULL DEFAULT '',
        amount_usd REAL NOT NULL,
        donated_at TEXT NOT NULL DEFAULT '',
        election_cycle TEXT NOT NULL DEFAULT '',
        in_kind INTEGER NOT NULL DEFAULT 0,
        jurisdiction TEXT NOT NULL DEFAULT 'city',
        source_kind TEXT NOT NULL DEFAULT 'other',
        source_url TEXT NOT NULL,
        notes TEXT NOT NULL DEFAULT '',
        captured_at TEXT NOT NULL,
        UNIQUE (recipient_slug, donor_slug, amount_usd, donated_at, in_kind)
      );
      CREATE INDEX IF NOT EXISTS idx_donations_recipient ON donations (recipient_slug, donated_at);
      CREATE INDEX IF NOT EXISTS idx_donations_donor ON donations (donor_slug);
      CREATE INDEX IF NOT EXISTS idx_donations_cycle ON donations (election_cycle);

      CREATE TABLE IF NOT EXISTS finance_filings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        candidate TEXT NOT NULL,
        candidate_slug TEXT NOT NULL,
        committee TEXT NOT NULL DEFAULT '',
        period TEXT NOT NULL,
        total_raised_usd REAL,
        total_spent_usd REAL,
        cash_on_hand_usd REAL,
        jurisdiction TEXT NOT NULL DEFAULT 'city',
        source_url TEXT NOT NULL,
        captured_at TEXT NOT NULL,
        UNIQUE (candidate_slug, committee, period)
      );
      CREATE INDEX IF NOT EXISTS idx_filings_candidate ON finance_filings (candidate_slug);

      CREATE TABLE IF NOT EXISTS member_interests (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        member TEXT NOT NULL,
        member_slug TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'other',
        organization TEXT NOT NULL,
        org_slug TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        disclosed INTEGER NOT NULL DEFAULT 0,
        as_of TEXT NOT NULL DEFAULT '',
        source_url TEXT NOT NULL,
        captured_at TEXT NOT NULL,
        UNIQUE (member_slug, kind, org_slug)
      );
      CREATE INDEX IF NOT EXISTS idx_interests_member ON member_interests (member_slug);

      CREATE TABLE IF NOT EXISTS conflict_flags (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        member TEXT NOT NULL,
        member_slug TEXT NOT NULL,
        item_title TEXT NOT NULL,
        item_slug TEXT NOT NULL,
        meeting_date TEXT NOT NULL DEFAULT '',
        vote TEXT NOT NULL DEFAULT '',
        basis TEXT NOT NULL,
        counterparty TEXT NOT NULL,
        counterparty_slug TEXT NOT NULL,
        amount_usd REAL,
        evidence_md TEXT NOT NULL,
        severity TEXT NOT NULL DEFAULT 'low',
        status TEXT NOT NULL DEFAULT 'flagged',
        source_urls TEXT NOT NULL DEFAULT '',
        first_flagged_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        UNIQUE (member_slug, counterparty_slug, item_slug)
      );
      CREATE INDEX IF NOT EXISTS idx_conflicts_member ON conflict_flags (member_slug, status);

      CREATE TABLE IF NOT EXISTS source_sync (
        source_key TEXT PRIMARY KEY,
        synced_at TEXT NOT NULL,
        content_hash TEXT
      );

      CREATE TABLE IF NOT EXISTS politics_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        scope TEXT NOT NULL
          CHECK (scope IN ('state','national','world')),
        kind TEXT NOT NULL DEFAULT 'event'
          CHECK (kind IN ('bill','election','ruling','executive','policy','event','watching')),
        title TEXT NOT NULL,
        summary TEXT NOT NULL DEFAULT '',
        take_md TEXT NOT NULL DEFAULT '',
        event_at TEXT NOT NULL DEFAULT '',
        url TEXT NOT NULL DEFAULT '',
        source TEXT NOT NULL DEFAULT '',
        interest_score REAL NOT NULL DEFAULT 0.5,
        status TEXT NOT NULL DEFAULT 'active'
          CHECK (status IN ('active','dismissed','expired')),
        dedup_key TEXT NOT NULL UNIQUE,
        ts_created TEXT NOT NULL,
        ts_updated TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_politics_scope_status
        ON politics_items (scope, status, interest_score DESC);
    `);
  }

  // ── donations ──────────────────────────────────────────────────────────────

  /** Validate + record a contribution. Idempotent on (recipient, donor,
   *  amount, date, in_kind) so re-reading the same filing refreshes rather
   *  than duplicates. Returns a verdict the caller must count. */
  record_donation(input: DonationInput): WriteVerdict {
    const amount = input.amount_usd;
    if (typeof amount !== 'number' || !Number.isFinite(amount)) {
      return { stored: false, reason: 'amount_usd is not a number' };
    }
    if (amount <= 0) return { stored: false, reason: `implausible amount $${amount} (<= 0)` };
    if (amount > DONATION_MAX_USD) {
      return { stored: false, reason: `implausible amount $${amount} (> ${DONATION_MAX_USD} — likely a misread or a cycle total)` };
    }
    if (!valid_url(input.source_url)) return { stored: false, reason: 'source_url must be an http(s) URL — no donation enters the record uncited' };
    if (!input.recipient.trim() || !input.donor.trim()) return { stored: false, reason: 'recipient and donor are required' };
    if (input.donated_at && Number.isNaN(Date.parse(input.donated_at))) {
      return { stored: false, reason: `unparseable donated_at "${input.donated_at}"` };
    }
    const now = new Date().toISOString();
    const donor_type = DONOR_TYPES.has(input.donor_type ?? '') ? input.donor_type! : 'unknown';
    const jurisdiction = JURISDICTIONS.has(input.jurisdiction ?? '') ? input.jurisdiction! : 'city';
    const source_kind = FINANCE_SOURCE_KINDS.has(input.source_kind ?? '') ? input.source_kind! : 'other';
    this.db
      .prepare(
        `INSERT INTO donations
           (recipient, recipient_slug, committee, donor, donor_slug, donor_type, employer,
            occupation, amount_usd, donated_at, election_cycle, in_kind, jurisdiction,
            source_kind, source_url, notes, captured_at)
         VALUES (@recipient, @recipient_slug, @committee, @donor, @donor_slug, @donor_type,
            @employer, @occupation, @amount_usd, @donated_at, @election_cycle, @in_kind,
            @jurisdiction, @source_kind, @source_url, @notes, @captured_at)
         ON CONFLICT(recipient_slug, donor_slug, amount_usd, donated_at, in_kind) DO UPDATE SET
            committee = excluded.committee, donor_type = excluded.donor_type,
            employer = excluded.employer, occupation = excluded.occupation,
            election_cycle = excluded.election_cycle, jurisdiction = excluded.jurisdiction,
            source_kind = excluded.source_kind, source_url = excluded.source_url,
            notes = excluded.notes, captured_at = excluded.captured_at`,
      )
      .run({
        '@recipient': input.recipient.trim().slice(0, 120),
        '@recipient_slug': civic_slug(input.recipient),
        '@committee': (input.committee ?? '').trim().slice(0, 160),
        '@donor': input.donor.trim().slice(0, 160),
        '@donor_slug': civic_slug(input.donor),
        '@donor_type': donor_type,
        '@employer': (input.employer ?? '').trim().slice(0, 160),
        '@occupation': (input.occupation ?? '').trim().slice(0, 120),
        '@amount_usd': amount,
        '@donated_at': (input.donated_at ?? '').slice(0, 10),
        '@election_cycle': (input.election_cycle ?? '').trim().slice(0, 24),
        '@in_kind': input.in_kind ? 1 : 0,
        '@jurisdiction': jurisdiction,
        '@source_kind': source_kind,
        '@source_url': input.source_url,
        '@notes': (input.notes ?? '').trim().slice(0, 500),
        '@captured_at': now,
      });
    return { stored: true };
  }

  list_donations(filter?: {
    recipient?: string;
    donor?: string;
    election_cycle?: string;
    limit?: number;
  }): DonationRow[] {
    const clauses: string[] = ['1=1'];
    const params: Record<string, string | number> = {};
    if (filter?.recipient) {
      clauses.push('recipient_slug = @r');
      params['@r'] = civic_slug(filter.recipient);
    }
    if (filter?.donor) {
      clauses.push('donor_slug = @d');
      params['@d'] = civic_slug(filter.donor);
    }
    if (filter?.election_cycle) {
      clauses.push('election_cycle = @c');
      params['@c'] = filter.election_cycle;
    }
    params['@limit'] = Math.min(Math.max(filter?.limit ?? 100, 1), 500);
    return this.db
      .prepare(
        `SELECT * FROM donations WHERE ${clauses.join(' AND ')}
          ORDER BY donated_at DESC, captured_at DESC LIMIT @limit`,
      )
      .all(params) as DonationRow[];
  }

  /** Per-(recipient, donor) totals — the "top donors" view. */
  donor_rollup(filter?: { recipient?: string; min_total_usd?: number; limit?: number }): DonorRollupRow[] {
    const clauses: string[] = ['1=1'];
    const params: Record<string, string | number> = {};
    if (filter?.recipient) {
      clauses.push('recipient_slug = @r');
      params['@r'] = civic_slug(filter.recipient);
    }
    params['@min'] = filter?.min_total_usd ?? 0;
    params['@limit'] = Math.min(Math.max(filter?.limit ?? 50, 1), 200);
    return this.db
      .prepare(
        `SELECT MAX(recipient) AS recipient, recipient_slug,
                MAX(donor) AS donor, donor_slug, MAX(donor_type) AS donor_type,
                COUNT(*) AS n, SUM(amount_usd) AS total_usd,
                MIN(donated_at) AS first_donated_at, MAX(donated_at) AS last_donated_at,
                MAX(source_url) AS source_url
           FROM donations WHERE ${clauses.join(' AND ')}
          GROUP BY recipient_slug, donor_slug
         HAVING SUM(amount_usd) >= @min
          ORDER BY total_usd DESC LIMIT @limit`,
      )
      .all(params) as DonorRollupRow[];
  }

  /** Per-recipient aggregate — coverage + pane fodder. */
  donations_by_recipient(): Array<{ recipient: string; recipient_slug: string; n: number; total_usd: number; donors: number }> {
    return this.db
      .prepare(
        `SELECT MAX(recipient) AS recipient, recipient_slug, COUNT(*) AS n,
                SUM(amount_usd) AS total_usd, COUNT(DISTINCT donor_slug) AS donors
           FROM donations GROUP BY recipient_slug ORDER BY total_usd DESC`,
      )
      .all() as Array<{ recipient: string; recipient_slug: string; n: number; total_usd: number; donors: number }>;
  }

  // ── finance filings ────────────────────────────────────────────────────────

  record_filing(input: FilingInput): WriteVerdict {
    const totals = [input.total_raised_usd, input.total_spent_usd, input.cash_on_hand_usd];
    if (totals.every((t) => t === null || t === undefined)) {
      return { stored: false, reason: 'a filing needs at least one of raised/spent/cash-on-hand' };
    }
    for (const t of totals) {
      if (t === null || t === undefined) continue;
      if (!Number.isFinite(t) || t < 0 || t > FILING_TOTAL_MAX_USD) {
        return { stored: false, reason: `implausible filing total $${t}` };
      }
    }
    if (!valid_url(input.source_url)) return { stored: false, reason: 'source_url must be an http(s) URL' };
    if (!input.candidate.trim() || !input.period.trim()) return { stored: false, reason: 'candidate and period are required' };
    this.db
      .prepare(
        `INSERT INTO finance_filings
           (candidate, candidate_slug, committee, period, total_raised_usd, total_spent_usd,
            cash_on_hand_usd, jurisdiction, source_url, captured_at)
         VALUES (@candidate, @candidate_slug, @committee, @period, @raised, @spent, @cash,
            @jurisdiction, @source_url, @captured_at)
         ON CONFLICT(candidate_slug, committee, period) DO UPDATE SET
            total_raised_usd = excluded.total_raised_usd,
            total_spent_usd = excluded.total_spent_usd,
            cash_on_hand_usd = excluded.cash_on_hand_usd,
            source_url = excluded.source_url, captured_at = excluded.captured_at`,
      )
      .run({
        '@candidate': input.candidate.trim().slice(0, 120),
        '@candidate_slug': civic_slug(input.candidate),
        '@committee': (input.committee ?? '').trim().slice(0, 160),
        '@period': input.period.trim().slice(0, 80),
        '@raised': input.total_raised_usd ?? null,
        '@spent': input.total_spent_usd ?? null,
        '@cash': input.cash_on_hand_usd ?? null,
        '@jurisdiction': JURISDICTIONS.has(input.jurisdiction ?? '') ? input.jurisdiction! : 'city',
        '@source_url': input.source_url,
        '@captured_at': new Date().toISOString(),
      });
    return { stored: true };
  }

  list_filings(candidate?: string): FilingRow[] {
    if (candidate) {
      return this.db
        .prepare(`SELECT * FROM finance_filings WHERE candidate_slug = @c ORDER BY period DESC`)
        .all({ '@c': civic_slug(candidate) }) as FilingRow[];
    }
    return this.db
      .prepare(`SELECT * FROM finance_filings ORDER BY candidate_slug, period DESC`)
      .all() as FilingRow[];
  }

  // ── member interests ───────────────────────────────────────────────────────

  upsert_interest(input: InterestInput): WriteVerdict {
    if (!input.member.trim() || !input.organization.trim()) {
      return { stored: false, reason: 'member and organization are required' };
    }
    if (!valid_url(input.source_url)) return { stored: false, reason: 'source_url must be an http(s) URL' };
    const kind = INTEREST_KINDS.has(input.kind ?? '') ? input.kind! : 'other';
    this.db
      .prepare(
        `INSERT INTO member_interests
           (member, member_slug, kind, organization, org_slug, description, disclosed,
            as_of, source_url, captured_at)
         VALUES (@member, @member_slug, @kind, @organization, @org_slug, @description,
            @disclosed, @as_of, @source_url, @captured_at)
         ON CONFLICT(member_slug, kind, org_slug) DO UPDATE SET
            description = excluded.description, disclosed = excluded.disclosed,
            as_of = excluded.as_of, source_url = excluded.source_url,
            captured_at = excluded.captured_at`,
      )
      .run({
        '@member': input.member.trim().slice(0, 120),
        '@member_slug': civic_slug(input.member),
        '@kind': kind,
        '@organization': input.organization.trim().slice(0, 160),
        '@org_slug': civic_slug(input.organization),
        '@description': (input.description ?? '').trim().slice(0, 500),
        '@disclosed': input.disclosed ? 1 : 0,
        '@as_of': (input.as_of ?? '').slice(0, 10),
        '@source_url': input.source_url,
        '@captured_at': new Date().toISOString(),
      });
    return { stored: true };
  }

  list_interests(member?: string): InterestRow[] {
    if (member) {
      return this.db
        .prepare(`SELECT * FROM member_interests WHERE member_slug = @m ORDER BY kind, organization`)
        .all({ '@m': civic_slug(member) }) as InterestRow[];
    }
    return this.db
      .prepare(`SELECT * FROM member_interests ORDER BY member_slug, kind, organization`)
      .all() as InterestRow[];
  }

  // ── conflict flags ─────────────────────────────────────────────────────────

  /** Upsert a conflict flag, idempotent on (member, counterparty, item).
   *  Status is PRESERVED on re-upsert unless explicitly passed — a weekly
   *  re-scan must never resurrect a cleared flag. Returns the row id and
   *  whether it was newly created. */
  upsert_conflict_flag(input: ConflictFlagInput): { stored: boolean; reason?: string; id?: number; created?: boolean } {
    if (!input.member.trim() || !input.item_title.trim() || !input.counterparty.trim()) {
      return { stored: false, reason: 'member, item_title, and counterparty are required' };
    }
    if (!CONFLICT_BASES.has(input.basis)) return { stored: false, reason: `basis must be one of donation|interest|both` };
    if ((input.evidence_md ?? '').trim().length < 10) {
      return { stored: false, reason: 'evidence_md is the receipts — name the donation/interest and the vote, with dates' };
    }
    const urls = (input.source_urls ?? []).filter((u) => valid_url(u));
    if (urls.length === 0) return { stored: false, reason: 'at least one valid source_url is required' };

    const member_slug = civic_slug(input.member);
    const counterparty_slug = civic_slug(input.counterparty);
    const item_slug = civic_slug(input.item_title, 60);
    const now = new Date().toISOString();
    const existing = this.db
      .prepare(
        `SELECT id, status FROM conflict_flags
          WHERE member_slug = @m AND counterparty_slug = @c AND item_slug = @i`,
      )
      .get({ '@m': member_slug, '@c': counterparty_slug, '@i': item_slug }) as
      | { id: number; status: string }
      | undefined;

    const status = CONFLICT_STATUSES.has(input.status ?? '')
      ? input.status!
      : existing?.status ?? 'flagged';
    const severity = CONFLICT_SEVERITIES.has(input.severity ?? '') ? input.severity! : 'low';

    if (existing) {
      this.db
        .prepare(
          `UPDATE conflict_flags SET
             member = @member, item_title = @item_title, meeting_date = @meeting_date,
             vote = @vote, basis = @basis, counterparty = @counterparty,
             amount_usd = @amount_usd, evidence_md = @evidence_md, severity = @severity,
             status = @status, source_urls = @source_urls, last_seen_at = @now
           WHERE id = @id`,
        )
        .run({
          '@id': existing.id,
          '@member': input.member.trim().slice(0, 120),
          '@item_title': input.item_title.trim().slice(0, 300),
          '@meeting_date': (input.meeting_date ?? '').slice(0, 10),
          '@vote': (input.vote ?? '').slice(0, 16),
          '@basis': input.basis,
          '@counterparty': input.counterparty.trim().slice(0, 160),
          '@amount_usd': input.amount_usd ?? null,
          '@evidence_md': input.evidence_md.trim().slice(0, 4_000),
          '@severity': severity,
          '@status': status,
          '@source_urls': urls.join('\n'),
          '@now': now,
        });
      return { stored: true, id: existing.id, created: false };
    }

    this.db
      .prepare(
        `INSERT INTO conflict_flags
           (member, member_slug, item_title, item_slug, meeting_date, vote, basis,
            counterparty, counterparty_slug, amount_usd, evidence_md, severity, status,
            source_urls, first_flagged_at, last_seen_at)
         VALUES (@member, @member_slug, @item_title, @item_slug, @meeting_date, @vote,
            @basis, @counterparty, @counterparty_slug, @amount_usd, @evidence_md,
            @severity, @status, @source_urls, @now, @now)`,
      )
      .run({
        '@member': input.member.trim().slice(0, 120),
        '@member_slug': member_slug,
        '@item_title': input.item_title.trim().slice(0, 300),
        '@item_slug': item_slug,
        '@meeting_date': (input.meeting_date ?? '').slice(0, 10),
        '@vote': (input.vote ?? '').slice(0, 16),
        '@basis': input.basis,
        '@counterparty': input.counterparty.trim().slice(0, 160),
        '@counterparty_slug': counterparty_slug,
        '@amount_usd': input.amount_usd ?? null,
        '@evidence_md': input.evidence_md.trim().slice(0, 4_000),
        '@severity': severity,
        '@status': status,
        '@source_urls': urls.join('\n'),
        '@now': now,
      });
    const row = this.db.prepare('SELECT last_insert_rowid() AS id').get() as { id: number };
    return { stored: true, id: row.id, created: true };
  }

  list_conflicts(filter?: { member?: string; status?: string; limit?: number }): ConflictFlagRow[] {
    const clauses: string[] = ['1=1'];
    const params: Record<string, string | number> = {};
    if (filter?.member) {
      clauses.push('member_slug = @m');
      params['@m'] = civic_slug(filter.member);
    }
    if (filter?.status && CONFLICT_STATUSES.has(filter.status)) {
      clauses.push('status = @s');
      params['@s'] = filter.status;
    }
    params['@limit'] = Math.min(Math.max(filter?.limit ?? 50, 1), 200);
    return this.db
      .prepare(
        `SELECT * FROM conflict_flags WHERE ${clauses.join(' AND ')}
          ORDER BY CASE severity WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END,
                   last_seen_at DESC
          LIMIT @limit`,
      )
      .all(params) as ConflictFlagRow[];
  }

  /** Open (not-cleared) conflict counts per member — coverage + pane. */
  conflicts_by_member(): Array<{ member: string; member_slug: string; n: number }> {
    return this.db
      .prepare(
        `SELECT MAX(member) AS member, member_slug, COUNT(*) AS n
           FROM conflict_flags WHERE status != 'cleared'
          GROUP BY member_slug ORDER BY n DESC`,
      )
      .all() as Array<{ member: string; member_slug: string; n: number }>;
  }

  interests_by_member(): Array<{ member: string; member_slug: string; n: number }> {
    return this.db
      .prepare(
        `SELECT MAX(member) AS member, member_slug, COUNT(*) AS n
           FROM member_interests GROUP BY member_slug ORDER BY n DESC`,
      )
      .all() as Array<{ member: string; member_slug: string; n: number }>;
  }

  // ── politics items (the Politics Desk's state / national / world tabs) ───

  /** Upsert by dedup_key (default `<scope>:<title slug>`). Fact-kinds
   *  require a citing url (the verification floor); 'watching' may not have
   *  a document yet. Status is PRESERVED on re-record — a dismissed item
   *  doesn't resurrect because the same headline resurfaced. */
  record_politics_item(input: PoliticsItemInput): WriteVerdict {
    if (!POLITICS_SCOPES.has(input.scope)) return { stored: false, reason: 'scope must be state|national|world (Pleasantville lives in civic_items)' };
    const kind = POLITICS_KINDS.has(input.kind ?? '') ? input.kind! : 'event';
    const title = input.title.trim();
    if (!title) return { stored: false, reason: 'title is required' };
    if (POLITICS_FACT_KINDS.has(kind) && !valid_url(input.url)) {
      return { stored: false, reason: `kind '${kind}' is a fact — it needs a citing url (use kind 'watching' for an uncited radar item)` };
    }
    if (input.event_at && Number.isNaN(Date.parse(input.event_at))) {
      return { stored: false, reason: `unparseable event_at "${input.event_at}"` };
    }
    const now = new Date().toISOString();
    const dedup_key = (input.dedup_key?.trim() || `${input.scope}:${civic_slug(title, 60)}`).slice(0, 120);
    const interest = Math.min(Math.max(input.interest_score ?? 0.5, 0), 1);
    this.db
      .prepare(
        `INSERT INTO politics_items
           (scope, kind, title, summary, take_md, event_at, url, source,
            interest_score, status, dedup_key, ts_created, ts_updated)
         VALUES (@scope, @kind, @title, @summary, @take_md, @event_at, @url, @source,
            @interest, 'active', @dedup_key, @now, @now)
         ON CONFLICT(dedup_key) DO UPDATE SET
            kind = excluded.kind, title = excluded.title, summary = excluded.summary,
            take_md = CASE WHEN excluded.take_md != '' THEN excluded.take_md ELSE politics_items.take_md END,
            event_at = excluded.event_at, url = excluded.url, source = excluded.source,
            interest_score = excluded.interest_score, ts_updated = excluded.ts_updated`,
      )
      .run({
        '@scope': input.scope,
        '@kind': kind,
        '@title': title.slice(0, 300),
        '@summary': (input.summary ?? '').trim().slice(0, 600),
        '@take_md': (input.take_md ?? '').trim().slice(0, 2_000),
        '@event_at': (input.event_at ?? '').slice(0, 25),
        '@url': valid_url(input.url) ? input.url! : '',
        '@source': (input.source ?? '').trim().slice(0, 120),
        '@interest': interest,
        '@dedup_key': dedup_key,
        '@now': now,
      });
    return { stored: true };
  }

  list_politics_items(filter?: {
    scope?: PoliticsScope;
    status?: 'active' | 'dismissed' | 'expired';
    limit?: number;
  }): PoliticsItemRow[] {
    const clauses: string[] = ['status = @status'];
    const params: Record<string, string | number> = { '@status': filter?.status ?? 'active' };
    if (filter?.scope && POLITICS_SCOPES.has(filter.scope)) {
      clauses.push('scope = @scope');
      params['@scope'] = filter.scope;
    }
    params['@limit'] = Math.min(Math.max(filter?.limit ?? 40, 1), 200);
    return this.db
      .prepare(
        `SELECT * FROM politics_items WHERE ${clauses.join(' AND ')}
          ORDER BY interest_score DESC, ts_updated DESC LIMIT @limit`,
      )
      .all(params) as PoliticsItemRow[];
  }

  /** Active counts per scope — the office tab badges. */
  politics_counts_by_scope(): Record<PoliticsScope, number> {
    const rows = this.db
      .prepare(`SELECT scope, COUNT(*) AS n FROM politics_items WHERE status = 'active' GROUP BY scope`)
      .all() as Array<{ scope: PoliticsScope; n: number }>;
    const out: Record<PoliticsScope, number> = { state: 0, national: 0, world: 0 };
    for (const r of rows) out[r.scope] = r.n;
    return out;
  }

  set_politics_item_status(dedup_key: string, status: 'active' | 'dismissed' | 'expired'): boolean {
    const res = this.db
      .prepare(`UPDATE politics_items SET status = @s, ts_updated = @t WHERE dedup_key = @k`)
      .run({ '@s': status, '@t': new Date().toISOString(), '@k': dedup_key });
    return res.changes > 0;
  }

  // ── per-source conditional-fetch bookkeeping (clone of Kristi's) ──────────

  get_source_sync(source_key: string): { source_key: string; synced_at: string; content_hash: string | null } | null {
    return (
      (this.db
        .prepare(`SELECT * FROM source_sync WHERE source_key = @k`)
        .get({ '@k': source_key }) as { source_key: string; synced_at: string; content_hash: string | null } | undefined) ?? null
    );
  }

  record_source_sync(source_key: string, opts?: { content_hash?: string | null }): void {
    this.db
      .prepare(
        `INSERT INTO source_sync (source_key, synced_at, content_hash)
         VALUES (@k, @t, @h)
         ON CONFLICT(source_key) DO UPDATE SET synced_at = excluded.synced_at,
            content_hash = excluded.content_hash`,
      )
      .run({ '@k': source_key, '@t': new Date().toISOString(), '@h': opts?.content_hash ?? null });
  }
}

// ── singleton access ─────────────────────────────────────────────────────────

let _store: RubyCivicStore | null = null;
export function get_ruby_civic_store(): RubyCivicStore {
  if (!_store) _store = new RubyCivicStore();
  return _store;
}
