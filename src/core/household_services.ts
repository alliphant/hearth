/**
 * Household services & bills — the shared core behind the standing-facts
 * ledger (Phase A of Kate's executive-assistant endgame, 2026-07-04).
 *
 * The division of labor is LAW #1-clean:
 *   - CODE (this module): deterministic recurring-sender clustering over the
 *     mail exhaust (counts, cadence intervals, amount extraction), anchor
 *     normalization, due-date arithmetic, and the cordoned table reads the
 *     triage-grounding + bills surfaces use. Pure and testable without an LLM.
 *   - MODEL (one deep-tier call per learner run): decides which candidates
 *     are real household services and assigns vendor/category/cadence/amount/
 *     status — never a hard-coded vendor list, never an if-domain-then rule.
 *
 * Consumers:
 *   - src/specialists/kate/tools/learn_household_services.ts — the weekly
 *     background job (cluster → classify → upsert household_service notes).
 *   - src/specialists/kate/tools/household_services.ts — the comprehensive
 *     chat read ("lay out my bills", "do we have trash service?").
 *   - src/core/mail_ingest.ts — triage grounding: candidate service matches
 *     for a sender's domain ride the triage judge's evidence block (the
 *     Republic-Waste-bill-is-legitimate test case).
 *   - src/core/working_memory.ts — the "Bills & services" section.
 *
 * DARK behind HEARTH_HOUSEHOLD_SERVICES (read at call time so smokes can
 * flip it); off → the learner no-ops and triage grounding adds nothing.
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Database } from 'bun:sqlite';
import type { HouseholdServiceRow } from '@memory/client';
import { note_visible_to_caller, type Caller } from '@memory/private_to';
import type { LLMRouter } from './llm';
import { local_iso_date } from './time';

/** Kill switch — DARK by default (off). */
export function household_services_enabled(): boolean {
  return process.env.HEARTH_HOUSEHOLD_SERVICES === '1';
}

/** The classifier's tier — deep-tier extraction by default (the batch call is
 *  weekly + evidence-grounded; the 35B holds the numbered-candidate contract). */
export function household_services_tier(): string {
  return process.env.HEARTH_HOUSEHOLD_SERVICES_TIER || 'research_extract';
}

// ── domains & anchors ───────────────────────────────────────────────────

/** The domain of an email address ("billing@email.republicservices.com" →
 *  "email.republicservices.com"), lowercased; null when there isn't one. */
export function domain_of_addr(addr: string | null | undefined): string | null {
  if (!addr) return null;
  const m = addr.match(/@([^@>\s]+)/);
  return m && m[1] ? m[1].toLowerCase().replace(/[>)\s.]+$/, '') : null;
}

/** Registrable-ish root of a domain — the last two labels
 *  ("email.republicservices.com" → "republicservices.com"). Naive on
 *  country-code second-level domains (co.uk), which is fine at household
 *  scale; the anchor only has to be STABLE, not perfect. */
export function root_domain(domain: string | null | undefined): string | null {
  if (!domain) return null;
  const labels = domain.toLowerCase().split('.').filter(Boolean);
  if (labels.length < 2) return labels[0] ?? null;
  return labels.slice(-2).join('.');
}

/** Stable typed id from the vendor anchor (mirrors good_id_for). */
export function service_id_for(anchor: string): string {
  return `hs_${createHash('sha256').update(anchor).digest('hex').slice(0, 8)}`;
}

/** Vault note path for a service, keyed on the anchor so a re-run refreshes
 *  the same note (idempotent, never duplicates). */
export function service_note_path(anchor: string): string {
  const slug = anchor.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'service';
  return `Household/Services/${slug}.md`;
}

// ── deterministic evidence extraction ───────────────────────────────────

/** Money mentions in a text, as integer cents. Deterministic; implausible
 *  values (0 or ≥ $100k) are dropped. */
export function extract_amounts_cents(text: string): number[] {
  const out: number[] = [];
  for (const m of text.matchAll(/\$\s?(\d{1,3}(?:,\d{3})*(?:\.\d{2})?)\b/g)) {
    const raw = m[1];
    if (!raw) continue;
    const cents = Math.round(Number.parseFloat(raw.replace(/,/g, '')) * 100);
    if (Number.isFinite(cents) && cents > 0 && cents < 10_000_000) out.push(cents);
  }
  return out;
}

export function median(nums: number[]): number | null {
  if (nums.length === 0) return null;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  const lo = s[mid - 1];
  const hi = s[mid];
  if (s.length % 2 === 1) return hi ?? null;
  return lo !== undefined && hi !== undefined ? Math.round((lo + hi) / 2) : null;
}

/** The slice of a mail_messages row the clustering reads (structural typing so
 *  MailMessage satisfies it directly and smokes can hand-roll fixtures). */
export interface ServiceMailLike {
  id: string;
  from_addr: string;
  from_name: string;
  subject: string;
  snippet: string;
  /** Kate's triage one-liner, when present — high-signal for the classifier. */
  summary?: string;
  date_utc: string;
  triage_category?: string;
}

/** A recurring-sender candidate the model will judge. All fields are
 *  deterministic derivations from the messages — evidence, not verdicts. */
export interface ServiceCandidate {
  /** Root sender domain — the stable vendor anchor. */
  anchor: string;
  /** Full sender domains seen (subdomains preserved for the triage match). */
  domains: string[];
  sender_names: string[];
  message_count: number;
  first_date: string;
  last_date: string;
  /** Median gap between distinct message dates, days — a cadence HINT the
   *  model interprets; null under 2 distinct dates. */
  median_gap_days: number | null;
  /** How many of the group's messages the mail-triage judge already called
   *  `transactional` — the model's OWN prior verdicts, reused as the ranking
   *  signal (a monthly biller sends 3 messages/90d, a marketer 90; ranking by
   *  raw count anti-selects for bills — the 2026-07-04 live-fire lesson). */
  transactional_count: number;
  /** Triage-category histogram — rendered so the classifier sees "11/14
   *  transactional" vs "45/45 promotional" at a glance. */
  categories: Record<string, number>;
  amounts_cents: number[];
  typical_amount_cents: number | null;
  sample_subjects: string[];
  sample_summaries: string[];
  /** Provenance the note stores — mail:<message_id>, newest first, capped. */
  evidence_refs: string[];
}

const EVIDENCE_REF_CAP = 6;
const SAMPLE_SUBJECT_CAP = 3;
const SAMPLE_SUMMARY_CAP = 2;
/** A root-domain group with more distinct sender local-parts than this is too
 *  heterogeneous to be one vendor (freemail, many humans) — dropped. A
 *  structural signal, not a domain list. */
const MAX_LOCAL_PARTS = 4;

/**
 * Deterministic recurring-sender clustering: group inbound mail by root
 * sender domain and derive per-group evidence. No LLM — the same input
 * always yields the same candidates in the same order. Ranking for the
 * max_candidates cap leads with the group's TRANSACTIONAL triage count
 * (the triage judge's own stored verdicts), then total count, then anchor:
 * ranking by raw volume anti-selects for bills — a monthly biller sends 3
 * messages per 90d while a daily marketer sends 90, so the count-ranked
 * top-24 was all Nextdoor/promo noise on the live archive (2026-07-04)
 * while Cox/Progressive/Hyundai sat truncated below the cap.
 */
export function cluster_mail_candidates(
  messages: ServiceMailLike[],
  opts: { min_messages?: number; max_candidates?: number } = {},
): ServiceCandidate[] {
  const min_messages = opts.min_messages ?? 2;
  const max_candidates = opts.max_candidates ?? 24;

  const groups = new Map<string, ServiceMailLike[]>();
  for (const m of messages) {
    // A threading-verified human reply is structurally not vendor mail.
    if (m.triage_category === 'authentic_reply') continue;
    const root = root_domain(domain_of_addr(m.from_addr));
    if (!root) continue;
    const bucket = groups.get(root);
    if (bucket) bucket.push(m);
    else groups.set(root, [m]);
  }

  const candidates: ServiceCandidate[] = [];
  for (const [anchor, msgs] of groups) {
    if (msgs.length < min_messages) continue;
    const locals = new Set<string>();
    for (const m of msgs) {
      const lp = (m.from_addr.split('@')[0] ?? '').toLowerCase();
      if (lp) locals.add(lp);
    }
    if (locals.size > MAX_LOCAL_PARTS) continue; // too heterogeneous to be one vendor

    const sorted = [...msgs].sort((a, b) => a.date_utc.localeCompare(b.date_utc));
    const newest_first = [...sorted].reverse();
    const dates = [...new Set(sorted.map((m) => local_iso_date(new Date(m.date_utc))))];
    const gaps: number[] = [];
    for (let i = 1; i < dates.length; i++) {
      const prev = new Date(`${dates[i - 1]}T12:00:00Z`).getTime();
      const cur = new Date(`${dates[i]}T12:00:00Z`).getTime();
      gaps.push(Math.round((cur - prev) / 86_400_000));
    }
    const amounts = sorted.flatMap((m) =>
      extract_amounts_cents(`${m.subject}\n${m.snippet}\n${m.summary ?? ''}`),
    );
    const first = dates[0];
    const last = dates[dates.length - 1];
    if (!first || !last) continue;

    const categories: Record<string, number> = {};
    for (const m of msgs) {
      const cat = m.triage_category ?? 'untriaged';
      categories[cat] = (categories[cat] ?? 0) + 1;
    }

    candidates.push({
      anchor,
      domains: [...new Set(sorted.map((m) => domain_of_addr(m.from_addr)).filter((d): d is string => !!d))].sort(),
      sender_names: [...new Set(sorted.map((m) => m.from_name.trim()).filter(Boolean))].sort().slice(0, 4),
      message_count: msgs.length,
      first_date: first,
      last_date: last,
      median_gap_days: median(gaps),
      transactional_count: categories['transactional'] ?? 0,
      categories,
      amounts_cents: amounts,
      typical_amount_cents: median(amounts),
      sample_subjects: [...new Set(newest_first.map((m) => m.subject.trim()).filter(Boolean))].slice(0, SAMPLE_SUBJECT_CAP),
      sample_summaries: [...new Set(newest_first.map((m) => (m.summary ?? '').trim()).filter(Boolean))].slice(0, SAMPLE_SUMMARY_CAP),
      evidence_refs: newest_first.slice(0, EVIDENCE_REF_CAP).map((m) => `mail:${m.id}`),
    });
  }

  return candidates
    .sort(
      (a, b) =>
        b.transactional_count - a.transactional_count ||
        b.message_count - a.message_count ||
        a.anchor.localeCompare(b.anchor),
    )
    .slice(0, max_candidates);
}

// ── due-date arithmetic ─────────────────────────────────────────────────

const CADENCE_DAYS: Record<string, number> = {
  weekly: 7,
  biweekly: 14,
  monthly: 30,
  quarterly: 91,
  semiannual: 182,
  annual: 365,
  yearly: 365,
};

/** Per-month factor for the "lay out my bills" monthly-equivalent total. */
const CADENCE_MONTHLY_FACTOR: Record<string, number> = {
  weekly: 52 / 12,
  biweekly: 26 / 12,
  monthly: 1,
  quarterly: 1 / 3,
  semiannual: 1 / 6,
  annual: 1 / 12,
  yearly: 1 / 12,
};

/**
 * Deterministic next-due ESTIMATE: advance last_bill_date by the cadence
 * period until it lands today-or-later (in the caller's tz, anchored at noon
 * UTC so the calendar date is stable). Approximate by design — an estimate
 * for the bills radar, never asserted as a hard due date. Takes the caller's
 * `now`; irregular/unknown cadence → null.
 */
export function estimate_next_due(
  last_bill_date: string | null | undefined,
  cadence: string | null | undefined,
  now: Date,
  tz?: string,
): string | null {
  if (!last_bill_date) return null;
  const days = CADENCE_DAYS[(cadence ?? '').toLowerCase().trim()];
  if (!days) return null;
  const anchor = new Date(`${last_bill_date.slice(0, 10)}T12:00:00Z`);
  if (Number.isNaN(anchor.getTime())) return null;
  const today = local_iso_date(now, tz);
  let t = anchor.getTime();
  for (let i = 0; i < 60 && local_iso_date(new Date(t), tz) < today; i++) {
    t += days * 86_400_000;
  }
  return local_iso_date(new Date(t), tz);
}

/** Monthly-equivalent cost of a service in cents (null when unknowable). */
export function monthly_equivalent_cents(row: {
  typical_amount_cents: number | null;
  cadence: string | null;
}): number | null {
  if (row.typical_amount_cents == null) return null;
  const factor = CADENCE_MONTHLY_FACTOR[(row.cadence ?? '').toLowerCase().trim()];
  if (factor === undefined) return null;
  return Math.round(row.typical_amount_cents * factor);
}

export function format_cents(cents: number, currency = 'USD'): string {
  const sym = currency === 'USD' ? '$' : `${currency} `;
  return `${sym}${(cents / 100).toFixed(2)}`;
}

// ── the classifier (the model's half) ───────────────────────────────────

const ClassifiedServiceSchema = z.object({
  ref: z.number().int().positive(),
  vendor: z.string().min(1),
  category: z.string().optional(),
  cadence: z.string().optional(),
  typical_amount_cents: z.number().int().nonnegative().optional(),
  autopay: z.boolean().optional(),
  account_hint: z.string().optional(),
  status: z.enum(['active', 'lapsed', 'uncertain']).default('active'),
  confidence: z.number().min(0).max(1).default(0.6),
});

export type ClassifiedService = z.infer<typeof ClassifiedServiceSchema>;

const CLASSIFY_SYSTEM =
  "You maintain a household's SERVICES & BILLS ledger for its chief-of-staff. " +
  'You are given a NUMBERED list of recurring-sender candidates mined from the ' +
  "household's inbound email — each with its sender domain, sender names, message " +
  'count and date span, a cadence hint (median days between messages), money ' +
  'amounts mentioned, and sample subjects/summaries.\n\n' +
  'Decide which candidates are REAL household services: a standing vendor ' +
  'relationship that bills or provides service on a cadence — utilities, ' +
  'waste/recycling, insurance, mortgage/rent, telecom/internet, streaming and ' +
  'other subscriptions, lawn/cleaning/pest services, memberships, medical/dental ' +
  'billing, city services, and the like. NOT a service: marketing-only senders, ' +
  'newsletters, one-off order confirmations from a general retailer, platform ' +
  'notifications, job/social digests, personal correspondence.\n\n' +
  'Return ONLY a JSON array with one object PER SERVICE you identify:\n' +
  '{"ref":<candidate number>,"vendor":"<display name, e.g. Republic Services>",' +
  '"category":"<one short word: waste|utility|insurance|telecom|streaming|' +
  'mortgage|subscription|medical|membership|other — or a better fit>",' +
  '"cadence":"<weekly|biweekly|monthly|quarterly|semiannual|annual|irregular>",' +
  '"typical_amount_cents":<integer, from the amount evidence; omit if unclear>,' +
  '"autopay":<true only if the messages say so>,' +
  '"account_hint":"<short account identifier if one appears; omit otherwise>",' +
  '"status":"<active|lapsed|uncertain>","confidence":<0..1>}\n\n' +
  'Reference candidates ONLY by their [number] in "ref" — never invent ids. Base ' +
  'every field on the evidence given; never invent amounts or account numbers. ' +
  'Unsure whether the relationship is current? Use status "uncertain" with low ' +
  'confidence. Omit non-services entirely. JSON only, no prose.';

export function render_candidates(candidates: ServiceCandidate[]): string {
  return candidates
    .map((c, i) => {
      const gap = c.median_gap_days != null ? `~${c.median_gap_days}d between messages` : 'gap unknown';
      const amounts = c.amounts_cents.length
        ? `amounts seen: ${c.amounts_cents
            .slice(0, 6)
            .map((a) => format_cents(a))
            .join(', ')}${c.typical_amount_cents != null ? ` (median ${format_cents(c.typical_amount_cents)})` : ''}`
        : 'no amounts seen';
      const summaries = c.sample_summaries.length ? `\n    triage notes: ${c.sample_summaries.join(' | ')}` : '';
      const cats = Object.entries(c.categories)
        .sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]))
        .map(([k, n]) => `${n} ${k}`)
        .join(', ');
      return (
        `[${i + 1}] ${c.anchor} — ${c.sender_names.join(', ') || '(no sender name)'}\n` +
        `    ${c.message_count} messages (${cats}), ${c.first_date} → ${c.last_date}, ${gap}; ${amounts}\n` +
        `    subjects: ${c.sample_subjects.join(' | ') || '(none)'}${summaries}`
      );
    })
    .join('\n');
}

/** Fence-strip + array-extract + per-entry validation. Out-of-range refs and
 *  invalid entries are dropped, never fatal. Null = unparseable (fail-open). */
export function parse_service_classification(
  raw: string,
  candidate_count: number,
): ClassifiedService[] | null {
  const fence = raw.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
  const text = (fence ? fence[1]! : raw).trim();
  const arr_match = text.match(/\[[\s\S]*\]/);
  if (!arr_match) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(arr_match[0]);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const out: ClassifiedService[] = [];
  for (const entry of parsed) {
    const r = ClassifiedServiceSchema.safeParse(entry);
    if (!r.success) continue;
    if (r.data.ref > candidate_count) continue;
    out.push(r.data);
  }
  return out;
}

/**
 * ONE deep-tier call classifying the whole candidate batch. The existing
 * ledger rides along so the model refreshes coherently instead of re-deriving
 * from scratch. Fail-OPEN: any error → null (a missed week is recoverable —
 * the next weekly pass sees the same evidence).
 */
export async function classify_service_candidates(
  llm: LLMRouter | undefined,
  candidates: ServiceCandidate[],
  existing_ledger_lines: string[],
): Promise<ClassifiedService[] | null> {
  if (!llm || candidates.length === 0) return null;
  let role;
  try {
    role = llm.for_role(household_services_tier());
  } catch {
    return null;
  }
  const known = existing_ledger_lines.length
    ? `\n\nThe ledger already knows these services (refresh them when a candidate matches — same vendor, updated evidence):\n${existing_ledger_lines.map((l) => `  - ${l}`).join('\n')}`
    : '';
  try {
    const resp = await role.provider.complete({
      messages: [
        { role: 'system', content: CLASSIFY_SYSTEM },
        {
          role: 'user',
          content: `Candidates:\n${render_candidates(candidates)}${known}\n\nReply with ONLY the JSON array.`,
        },
      ],
      temperature: 0.1,
      max_tokens: 1600,
      think: false,
      ...role.defaults,
    });
    return parse_service_classification(resp.content ?? '', candidates.length);
  } catch {
    return null;
  }
}

// ── cordoned table reads (triage grounding + surfaces) ──────────────────

/**
 * Services whose sender domains share the given domain's root — the
 * triage-grounding match ("this bill is from a vendor the household actually
 * has"). Cordon-filtered; lapsed services excluded (a lapsed vendor's mail
 * shouldn't read as a live relationship). Full-scan of a small table.
 */
export function services_matching_domain(
  db: Database,
  from_domain: string | null | undefined,
  caller: Caller,
): HouseholdServiceRow[] {
  const root = root_domain(from_domain);
  if (!root) return [];
  const rows = db
    .prepare(`SELECT * FROM household_services WHERE status != 'lapsed' ORDER BY vendor ASC`)
    .all() as HouseholdServiceRow[];
  return rows.filter((r) => {
    if (!note_visible_to_caller(r.private_to ?? undefined, caller)) return false;
    if (root_domain(r.vendor_anchor) === root) return true;
    try {
      const domains = JSON.parse(r.sender_domains_json) as unknown;
      return Array.isArray(domains) && domains.some((d) => root_domain(String(d)) === root);
    } catch {
      return false;
    }
  });
}

/** One evidence line per matched service, for the triage judge's block. */
export function render_service_triage_lines(rows: HouseholdServiceRow[]): string[] {
  return rows.map((r) => {
    const parts: string[] = [];
    if (r.category) parts.push(r.category);
    if (r.typical_amount_cents != null) {
      parts.push(`~${format_cents(r.typical_amount_cents, r.currency)}${r.cadence ? ` ${r.cadence}` : ''}`);
    } else if (r.cadence) {
      parts.push(r.cadence);
    }
    if (r.autopay === 1) parts.push('autopay');
    if (r.status !== 'active') parts.push(`status ${r.status}`);
    if (r.last_bill_date) parts.push(`last bill ${r.last_bill_date}`);
    return `${r.vendor}${parts.length ? ` — ${parts.join(', ')}` : ''}`;
  });
}

// ── the bill probe (Phase C anticipation, 2026-07-04) ───────────────────
// Pure cadence math over the ledger: which services' bills are EXPECTED but
// missing this cycle, and which have gone quiet entirely. Deterministic by
// design (the scan_good_followups date-window shape) — no LLM; the numbers
// come from the household's own learned cadence, and every surface phrases
// the expected date as "usually lands around", never a hard due date.

/** Grace before a missing bill is worth mentioning: a fraction of the cadence
 *  interval, clamped — a monthly bill gets ~8 days, an annual one 21. */
const GRACE_FRACTION = 0.25;
const GRACE_MIN_DAYS = 4;
const GRACE_MAX_DAYS = 21;
/** Quiet for this many cadence intervals → the service looks lapsed. */
const LAPSE_CYCLES = 2.5;
/** Learner-graded rows below this confidence don't drive proposals (a
 *  null confidence — a hand-written note — is trusted, told-first). */
const BILL_CONFIDENCE_FLOOR = 0.5;
/** Vendor mail on/after (expected − lead) counts as heard-this-cycle —
 *  conservative suppression; a proactive surface must under-offer. */
const SUPPRESS_LEAD_DAYS = 10;

export interface BillEdgeMissing {
  kind: 'missing_bill';
  service_id: string;
  vendor: string;
  note_path: string;
  private_to: string | null;
  /** Cadence-derived ESTIMATE (last_bill + interval) — "around", never due. */
  expected_date: string;
  days_late: number;
  grace_days: number;
  cadence: string;
  typical_amount_cents: number | null;
  currency: string;
}

export interface BillEdgeLapsed {
  kind: 'lapsed';
  service_id: string;
  vendor: string;
  note_path: string;
  private_to: string | null;
  /** Newest of last_bill_date and any inbound vendor mail (YYYY-MM-DD). */
  last_heard: string;
  quiet_days: number;
  cycles_quiet: number;
  cadence: string;
}

export type BillEdge = BillEdgeMissing | BillEdgeLapsed;

function utc_ms(iso_date: string): number | null {
  const [y, m, d] = iso_date.slice(0, 10).split('-').map((s) => Number.parseInt(s, 10));
  if (!y || !m || !d) return null;
  return Date.UTC(y, m - 1, d, 12);
}

function days_between(from_date: string, to_date: string): number | null {
  const a = utc_ms(from_date);
  const b = utc_ms(to_date);
  if (a == null || b == null) return null;
  return Math.round((b - a) / 86_400_000);
}

function add_days_iso(iso_date: string, days: number): string | null {
  const ms = utc_ms(iso_date);
  if (ms == null) return null;
  return local_iso_date(new Date(ms + days * 86_400_000), 'UTC');
}

/** Reduce per-sender newest-inbound rows to newest date per ROOT domain. */
export function build_last_mail_by_root(
  rows: Array<{ from_addr: string; last_date: string }>,
): Map<string, string> {
  const out = new Map<string, string>();
  for (const r of rows) {
    const root = root_domain(domain_of_addr(r.from_addr));
    if (!root) continue;
    const d = (r.last_date ?? '').slice(0, 10);
    if (!d) continue;
    const prev = out.get(root);
    if (!prev || d > prev) out.set(root, d);
  }
  return out;
}

/** Every root domain a service is known by (anchor + learned sender domains). */
function service_roots(row: HouseholdServiceRow): string[] {
  const roots = new Set<string>();
  const anchor_root = root_domain(row.vendor_anchor);
  if (anchor_root) roots.add(anchor_root);
  try {
    const domains = JSON.parse(row.sender_domains_json) as unknown;
    if (Array.isArray(domains)) {
      for (const d of domains) {
        const r = root_domain(String(d));
        if (r) roots.add(r);
      }
    }
  } catch {
    /* malformed json — anchor root alone */
  }
  return [...roots];
}

/**
 * Detect the two anticipation edges over active ledger rows:
 *   - missing_bill — the cadence says a bill should have landed (past grace)
 *     and NO vendor mail has arrived this cycle. Fires from grace until the
 *     lapse boundary (one stable expected_date → one proposal anchor).
 *   - lapsed — nothing heard from the vendor for ≥ LAPSE_CYCLES intervals.
 * Skips: non-active status, low learner confidence (null = told-first,
 * trusted), unknown/irregular cadence, no date evidence at all.
 */
export function detect_bill_edges(
  services: HouseholdServiceRow[],
  last_mail_by_root: Map<string, string>,
  now: Date,
  tz?: string,
): BillEdge[] {
  const today = local_iso_date(now, tz);
  const out: BillEdge[] = [];
  for (const row of [...services].sort((a, b) => a.vendor.localeCompare(b.vendor))) {
    if (row.status !== 'active') continue;
    if (row.confidence != null && row.confidence < BILL_CONFIDENCE_FLOOR) continue;
    const interval = CADENCE_DAYS[(row.cadence ?? '').toLowerCase().trim()];
    if (!interval) continue;

    let last_mail: string | null = null;
    for (const root of service_roots(row)) {
      const d = last_mail_by_root.get(root);
      if (d && (!last_mail || d > last_mail)) last_mail = d;
    }
    const last_bill = row.last_bill_date ? row.last_bill_date.slice(0, 10) : null;
    const last_heard =
      last_bill && last_mail ? (last_bill > last_mail ? last_bill : last_mail) : (last_bill ?? last_mail);
    if (!last_heard) continue;

    const quiet_days = days_between(last_heard, today);
    if (quiet_days == null) continue;

    if (quiet_days >= LAPSE_CYCLES * interval) {
      out.push({
        kind: 'lapsed',
        service_id: row.id,
        vendor: row.vendor,
        note_path: row.note_path,
        private_to: row.private_to,
        last_heard,
        quiet_days,
        cycles_quiet: Math.round((quiet_days / interval) * 10) / 10,
        cadence: (row.cadence ?? '').toLowerCase().trim(),
      });
      continue;
    }

    if (!last_bill) continue;
    const expected = add_days_iso(last_bill, interval);
    if (!expected) continue;
    // Heard from the vendor this cycle (any inbound mail, on/after the lead
    // window) → the bill has likely arrived; the weekly learner will refresh
    // last_bill_date. Suppress — under-offering is the right bias.
    const suppress_from = add_days_iso(expected, -SUPPRESS_LEAD_DAYS);
    if (last_mail && suppress_from && last_mail >= suppress_from) continue;

    const days_late = days_between(expected, today);
    if (days_late == null) continue;
    const grace_days = Math.min(
      GRACE_MAX_DAYS,
      Math.max(GRACE_MIN_DAYS, Math.round(interval * GRACE_FRACTION)),
    );
    if (days_late < grace_days) continue;
    out.push({
      kind: 'missing_bill',
      service_id: row.id,
      vendor: row.vendor,
      note_path: row.note_path,
      private_to: row.private_to,
      expected_date: expected,
      days_late,
      grace_days,
      cadence: (row.cadence ?? '').toLowerCase().trim(),
      typical_amount_cents: row.typical_amount_cents,
      currency: row.currency,
    });
  }
  return out;
}
