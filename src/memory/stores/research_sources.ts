/**
 * ResearchSourcesStore — the persisted BODIES of the sources a deep-research
 * investigation read (Deep Research v2 phase 1, 2026-07-29).
 *
 * Why this table is the keystone of v2. Until now a sub-investigator fetched
 * a page, fed 6,000 characters of it to the extractor, and threw the text
 * away. Only the url + title survived on the investigation row. Four things
 * were impossible as a direct consequence:
 *
 *   1. **Verification could not fail.** `verify_investigation` had no corpus
 *      to grade findings against, so it built one out of the findings — every
 *      claim was "supported by" itself. The 2026-07-28 Barrett dossier
 *      recorded `{"claims_checked":4,"verdicts":[]}` while carrying a plainly
 *      false claim.
 *   2. **Date provenance was unknowable.** A vote was recorded on the date
 *      its coverage was PUBLISHED rather than the date it happened, and
 *      nothing could compare the two because the page's own date was gone.
 *   3. **The synthesiser quoted from memory.** It had finding text, not
 *      source text, so a verbatim span could not be anchored.
 *   4. **Re-verification meant re-fetching.** Tuning a check against real
 *      dossiers required hitting the live web again.
 *
 * With bodies on disk, all four become ordinary reads. Phase 3 (verification
 * on bodies + quote anchoring) is built on THIS and nothing else.
 *
 * Contracts:
 *
 *   - **Cordoned exactly as the dossier is.** Every row carries the
 *     investigation's `private_to`; reads go through `note_visible_to_caller`.
 *     A source body is a copy of what one user's investigation read — the
 *     owner has NO god-view of a household member's evidence trail.
 *   - **Idempotent per (investigation, url).** A re-run of a phase re-reads
 *     the same pages; `record()` upserts so a resumed slice neither duplicates
 *     nor loses a body. This is what makes the runner's per-phase
 *     resumability safe to extend.
 *   - **Bodies are CAPPED, and truncation is recorded** (`truncated`), so a
 *     failed quote-containment check downstream can tell "the page does not
 *     say that" from "we only kept the first N characters".
 *   - **Bodies EXPIRE.** They are an evidence trail, but they are also a copy
 *     of the web on our disk. `prune_older_than` is called from the runner on
 *     every slice — self-maintaining, no new job. See RETENTION_DAYS below.
 *
 * Additive table; no SCHEMA_VERSION bump.
 */
import type { Database } from 'bun:sqlite';
import { createHash, randomBytes } from 'node:crypto';
import { note_visible_to_caller, type Caller } from '@memory/private_to';

/* ------------------------------------------------------------------ */
/* Tunables (read at call time — the kill-switch env idiom)            */
/* ------------------------------------------------------------------ */

function int_env(name: string, dflt: number, lo: number, hi: number): number {
  const raw = Number.parseInt(process.env[name] ?? '', 10);
  const v = Number.isFinite(raw) && raw > 0 ? raw : dflt;
  return Math.max(lo, Math.min(v, hi));
}

/**
 * Per-body character cap. 40k is deliberately generous relative to the 6k
 * the extractor actually sees, so a quote-anchoring check in phase 3 can
 * find a span the extractor cited, while staying small enough that a
 * hundred-source `exhaustive` investigation is a few megabytes.
 */
export function source_body_cap(): number {
  return int_env('HEARTH_RESEARCH_SOURCE_BODY_CAP', 40_000, 2_000, 400_000);
}

/**
 * How long a persisted body lives, counted from when it was FETCHED.
 *
 * ⚠ OPEN OWNER QUESTION (design doc §6.4): "How long do persisted source
 * bodies live? They are the evidence trail, but they are also a copy of the
 * web on our disk." 30 days is a deliberately CONSERVATIVE default, not an
 * answer: it comfortably outlives an investigation (minutes to hours) plus a
 * window in which the owner might question a dossier's grounding, and it
 * keeps total footprint bounded without the owner having to decide anything.
 * Raise it via env once the owner says how long the trail should be kept.
 */
export function source_retention_days(): number {
  return int_env('HEARTH_RESEARCH_SOURCE_RETENTION_DAYS', 30, 1, 3_650);
}

/* ------------------------------------------------------------------ */
/* Row shape                                                           */
/* ------------------------------------------------------------------ */

export interface ResearchSourceRow {
  id: string;
  investigation_id: string;
  /** The sub-question whose investigator read it (null = pre-column). */
  sub_question_id: string | null;
  url: string;
  fetched_at: string;
  title: string | null;
  /** The readable text, capped at source_body_cap(). */
  body_md: string;
  /** sha256 of the FULL fetched text (pre-truncation) — identifies the
   *  source content, so a re-fetch can be recognised as unchanged even if
   *  the cap moved between runs. */
  content_hash: string;
  /** Registrable host, `www.` stripped — deterministic, never inferred. */
  publisher: string | null;
  /** Best-effort YYYY-MM-DD parsed from the page itself; null when the page
   *  does not state one. NEVER a fetch date standing in for a publish date —
   *  conflating those is exactly failure F4. */
  published_at: string | null;
  /** True when the full text exceeded the cap and was cut. */
  truncated: boolean;
  /** Length of the STORED body. */
  body_chars: number;
  private_to: string | null;
}

interface RawRow {
  id: string;
  investigation_id: string;
  sub_question_id: string | null;
  url: string;
  fetched_at: string;
  title: string | null;
  body_md: string;
  content_hash: string;
  publisher: string | null;
  published_at: string | null;
  truncated: number;
  body_chars: number;
  private_to: string | null;
}

function to_row(raw: RawRow): ResearchSourceRow {
  return {
    id: raw.id,
    investigation_id: raw.investigation_id,
    sub_question_id: raw.sub_question_id,
    url: raw.url,
    fetched_at: raw.fetched_at,
    title: raw.title,
    body_md: raw.body_md,
    content_hash: raw.content_hash,
    publisher: raw.publisher,
    published_at: raw.published_at,
    truncated: raw.truncated === 1,
    body_chars: raw.body_chars,
    private_to: raw.private_to,
  };
}

/** Opaque 12-char id with the rs_ type prefix (mirrors ri_/rc_/ap_). */
function new_source_id(): string {
  const alphabet = 'abcdefghjkmnpqrstvwxyz0123456789';
  const bytes = randomBytes(12);
  let out = '';
  for (let i = 0; i < 12; i++) out += alphabet[bytes[i]! % alphabet.length];
  return `rs_${out}`;
}

/* ------------------------------------------------------------------ */
/* Deterministic metadata derivation (no LLM — see below)              */
/* ------------------------------------------------------------------ */

/**
 * Registrable host for a url, `www.` stripped. Deterministic and
 * uncontroversial: it is read off the url, never guessed about the outlet.
 */
export function publisher_for_url(url: string): string | null {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host.startsWith('www.') ? host.slice(4) : host || null;
  } catch {
    return null;
  }
}

const MONTH_NAMES = [
  'january', 'february', 'march', 'april', 'may', 'june', 'july',
  'august', 'september', 'october', 'november', 'december',
];

/** Chars from the top of a page searched for a dateline. */
const DATELINE_WINDOW = 2_500;

function ymd(year: number, month_0: number, day: number): string {
  return `${String(year).padStart(4, '0')}-${String(month_0 + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/**
 * Best-effort publication date parsed from the page's own leading text.
 *
 * Deliberately conservative and deliberately NOT an LLM call: this is
 * metadata derived inside a fetch the runner already performed, and a wrong
 * date is worse than no date (a null is honest; a guess re-creates F4 one
 * layer down). Rules:
 *
 *   - only the first DATELINE_WINDOW characters are searched — a dateline
 *     sits at the top of an article; a date deep in the body is as likely to
 *     be the date of an EVENT the page describes, which is the very
 *     distinction this field exists to preserve;
 *   - the first plausible match wins;
 *   - implausible years are rejected (before 1990, or more than a year past
 *     `now` — a page cannot have been published in 2031).
 *
 * Returns YYYY-MM-DD, or null. Pure — exported for the smoke.
 */
export function extract_published_at(body: string, now: Date): string | null {
  const head = body.slice(0, DATELINE_WINDOW);
  const min_year = 1990;
  const max_year = now.getUTCFullYear() + 1;

  const candidates: Array<{ at: number; iso: string }> = [];

  // ISO-ish: 2026-07-28 or 2026/07/28
  const iso_re = /\b(19|20)(\d{2})[-/](0?[1-9]|1[0-2])[-/](0?[1-9]|[12]\d|3[01])\b/g;
  let m: RegExpExecArray | null;
  while ((m = iso_re.exec(head)) !== null) {
    const year = Number(`${m[1]}${m[2]}`);
    const month = Number(m[3]) - 1;
    const day = Number(m[4]);
    if (year < min_year || year > max_year) continue;
    candidates.push({ at: m.index, iso: ymd(year, month, day) });
  }

  // "July 28, 2026" / "28 July 2026" / "Jul 28, 2026" (month name or its
  // 3-letter abbreviation, either side of the day). All twelve months have a
  // unique 3-letter prefix, so the abbreviation is never ambiguous.
  // ('sept' is listed too — the one abbreviation in common use that is not
  // three letters. Full names come first so the engine prefers them.)
  const names = [...MONTH_NAMES, 'sept', ...MONTH_NAMES.map((m) => m.slice(0, 3))].join('|');
  const md_re = new RegExp(
    String.raw`\b(?:(${names})\.?\s+(0?[1-9]|[12]\d|3[01])(?:st|nd|rd|th)?,?\s+((?:19|20)\d{2})` +
      String.raw`|(0?[1-9]|[12]\d|3[01])(?:st|nd|rd|th)?\s+(${names})\.?,?\s+((?:19|20)\d{2}))\b`,
    'gi',
  );
  while ((m = md_re.exec(head)) !== null) {
    const name = (m[1] ?? m[5] ?? '').toLowerCase();
    const day = Number(m[2] ?? m[4]);
    const year = Number(m[3] ?? m[6]);
    const month = MONTH_NAMES.findIndex((full) => full.startsWith(name.slice(0, 3)));
    if (month < 0 || !Number.isFinite(day) || !Number.isFinite(year)) continue;
    if (year < min_year || year > max_year) continue;
    candidates.push({ at: m.index, iso: ymd(year, month, day) });
  }

  if (candidates.length === 0) return null;
  candidates.sort((a, b) => a.at - b.at);
  return candidates[0]!.iso;
}

/* ------------------------------------------------------------------ */
/* Store                                                               */
/* ------------------------------------------------------------------ */

export interface RecordSourceInput {
  investigation_id: string;
  url: string;
  /** The full readable text as fetched. Capped + hashed by the store. */
  body: string;
  sub_question_id?: string | null;
  title?: string | null;
  private_to?: string | null;
  /** Injected for determinism in tests; defaults to now. */
  fetched_at?: Date;
}

export class ResearchSourcesStore {
  constructor(private db: Database) {}

  /**
   * Persist (or refresh) one source body. Idempotent per
   * (investigation_id, url) so a resumed phase that re-reads the same page
   * overwrites rather than duplicating.
   */
  record(input: RecordSourceInput): ResearchSourceRow {
    const full = input.body ?? '';
    const cap = source_body_cap();
    const body_md = full.length > cap ? full.slice(0, cap) : full;
    const truncated = full.length > cap;
    const content_hash = createHash('sha256').update(full).digest('hex');
    const fetched = input.fetched_at ?? new Date();
    const fetched_at = fetched.toISOString();
    const published_at = extract_published_at(full, fetched);

    // Keep the row's id stable across refreshes: reuse the existing one so
    // any downstream reference (a quote anchor in phase 3) survives a resume.
    const existing = this.db
      .prepare(
        `SELECT id FROM research_sources
          WHERE investigation_id = @iid AND url = @url`,
      )
      .get({ '@iid': input.investigation_id, '@url': input.url }) as { id: string } | null;
    const id = existing != null ? existing.id : new_source_id();

    this.db
      .prepare(
        `INSERT INTO research_sources
           (id, investigation_id, sub_question_id, url, fetched_at, title,
            body_md, content_hash, publisher, published_at, truncated,
            body_chars, private_to)
         VALUES (@id, @iid, @sqid, @url, @fetched_at, @title, @body, @hash,
                 @publisher, @published_at, @truncated, @chars, @private_to)
         ON CONFLICT(investigation_id, url) DO UPDATE SET
           sub_question_id = excluded.sub_question_id,
           fetched_at      = excluded.fetched_at,
           title           = excluded.title,
           body_md         = excluded.body_md,
           content_hash    = excluded.content_hash,
           publisher       = excluded.publisher,
           published_at    = excluded.published_at,
           truncated       = excluded.truncated,
           body_chars      = excluded.body_chars,
           private_to      = excluded.private_to`,
      )
      .run({
        '@id': id,
        '@iid': input.investigation_id,
        '@sqid': input.sub_question_id ?? null,
        '@url': input.url,
        '@fetched_at': fetched_at,
        '@title': input.title ?? null,
        '@body': body_md,
        '@hash': content_hash,
        '@publisher': publisher_for_url(input.url),
        '@published_at': published_at,
        '@truncated': truncated ? 1 : 0,
        '@chars': body_md.length,
        '@private_to': input.private_to ?? null,
      });

    const row = this.get_by_url(input.investigation_id, input.url);
    if (!row) {
      throw new Error(`research_sources: insert of ${input.url} not readable back`);
    }
    return row;
  }

  get_by_url(investigation_id: string, url: string): ResearchSourceRow | null {
    const raw = this.db
      .prepare(
        `SELECT * FROM research_sources
          WHERE investigation_id = @iid AND url = @url`,
      )
      .get({ '@iid': investigation_id, '@url': url }) as RawRow | null;
    return raw != null ? to_row(raw) : null;
  }

  /**
   * Every persisted body for an investigation, oldest fetch first (so [S#]
   * order is stable across reads). When `caller` is supplied the cordon is
   * enforced — the owner does NOT bypass it.
   */
  list_for_investigation(
    investigation_id: string,
    opts: { caller?: Caller; limit?: number } = {},
  ): ResearchSourceRow[] {
    const limit = Math.max(1, Math.min(opts.limit ?? 500, 2_000));
    const raws = this.db
      .prepare(
        `SELECT * FROM research_sources
          WHERE investigation_id = @iid
          ORDER BY fetched_at ASC, rowid ASC
          LIMIT @limit`,
      )
      .all({ '@iid': investigation_id, '@limit': limit }) as RawRow[];
    const rows = raws.map(to_row);
    if (!opts.caller) return rows;
    const caller = opts.caller;
    return rows.filter((r) => note_visible_to_caller(r.private_to ?? undefined, caller));
  }

  count_for_investigation(investigation_id: string): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS n FROM research_sources WHERE investigation_id = @iid`)
      .get({ '@iid': investigation_id }) as { n: number } | null;
    return row != null ? row.n : 0;
  }

  delete_for_investigation(investigation_id: string): number {
    const res = this.db
      .prepare(`DELETE FROM research_sources WHERE investigation_id = @iid`)
      .run({ '@iid': investigation_id });
    return Number(res.changes ?? 0);
  }

  /** Drop bodies fetched before `cutoff_iso`. Returns rows removed. */
  prune_older_than(cutoff_iso: string): number {
    const res = this.db
      .prepare(`DELETE FROM research_sources WHERE fetched_at < @cutoff`)
      .run({ '@cutoff': cutoff_iso });
    return Number(res.changes ?? 0);
  }

  /** Retention sweep: prune anything past source_retention_days(). */
  prune_expired(now: Date = new Date()): number {
    const cutoff = new Date(now.getTime() - source_retention_days() * 86_400_000);
    return this.prune_older_than(cutoff.toISOString());
  }
}
