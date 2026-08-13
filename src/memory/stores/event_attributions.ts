/**
 * EventAttributions (2026-06-20, Phase 2) — the LEARNED "whose event is this"
 * memory for a shared household calendar.
 *
 * A joint calendar where everyone labels generically ("appointment", "meeting")
 * gives no reliable owner signal from the title. So we LEARN: once the owner
 * tells Kate (or answers her ask) "the Tuesday 2pm haircut is Sam's", that
 * answer is recorded against a fingerprint of the event's stable shape —
 * normalized title + location + weekday + hour — and future occurrences match
 * automatically. `best_match` resolves from most-specific to least so a learned
 * exact match wins, with title+time / title+location / title-only fallbacks.
 *
 * Self-contained additive table (CREATE IF NOT EXISTS in the ctor); the learned
 * attribution is household-shared knowledge (it answers "who", not "what they
 * did"), so no per-row cordon here — the life_event note it informs carries the
 * cordon to the attributed user.
 */
import { Database } from 'bun:sqlite';

export interface AttributionComponents {
  title_norm: string;
  location_norm: string; // '' when none
  weekday: string; // 'mon'..'sun' (local)
  hour: number; // 0-23 (local)
}

export type MatchTier = 'exact' | 'title_time' | 'title_location' | 'title';

export interface AttributionMatch {
  user_id: string;
  tier: MatchTier;
  hits: number;
}

interface Row {
  fingerprint: string;
  user_id: string;
  title_norm: string;
  location_norm: string;
  weekday: string;
  hour: number;
  hits: number;
  created_at: string;
  updated_at: string;
}

export function fingerprint_of(c: AttributionComponents): string {
  return `${c.title_norm}|${c.location_norm}|${c.weekday}|${c.hour}`;
}

export class EventAttributions {
  constructor(private db: Database) {
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS event_attributions (
         fingerprint TEXT PRIMARY KEY,
         user_id TEXT NOT NULL,
         title_norm TEXT NOT NULL DEFAULT '',
         location_norm TEXT NOT NULL DEFAULT '',
         weekday TEXT NOT NULL DEFAULT '',
         hour INTEGER NOT NULL DEFAULT 0,
         hits INTEGER NOT NULL DEFAULT 1,
         created_at TEXT NOT NULL,
         updated_at TEXT NOT NULL
       )`,
    );
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_evattr_title ON event_attributions(title_norm)`);
    // Substring RULES (Phase 3 ops): an exact-fingerprint match only fires when
    // the owner's phrasing equals the calendar title. People say "Dana" but the
    // event is "Appointment with Dana Marsh, LMT" — so we ALSO support a
    // contains-rule (`match_mode='substring'`, `title_norm` holds the phrase).
    // Additive column on the existing table; default 'exact' keeps old rows.
    const cols = this.db.prepare(`PRAGMA table_info(event_attributions)`).all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === 'match_mode')) {
      this.db.exec(`ALTER TABLE event_attributions ADD COLUMN match_mode TEXT NOT NULL DEFAULT 'exact'`);
    }
  }

  /** Record (or reinforce) a learned attribution from a confirmed answer. */
  record(c: AttributionComponents, user_id: string): void {
    const fp = fingerprint_of(c);
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO event_attributions
           (fingerprint, user_id, title_norm, location_norm, weekday, hour, hits, created_at, updated_at)
         VALUES (@fp, @uid, @t, @l, @w, @h, 1, @now, @now)
         ON CONFLICT(fingerprint) DO UPDATE SET
           user_id = @uid, hits = hits + 1, updated_at = @now`,
      )
      .run({ '@fp': fp, '@uid': user_id, '@t': c.title_norm, '@l': c.location_norm, '@w': c.weekday, '@h': c.hour, '@now': now });
  }

  /** Minimum phrase length for a substring rule — guards against an over-broad
   *  rule ("a", "dr") matching everything. */
  static readonly MIN_PHRASE = 3;

  /** Record a CONTAINS rule: any event whose title mentions `phrase_norm`
   *  attributes to `user_id`. The retroactive + forward answer to casual
   *  phrasing ("Dana" → "Appointment with Dana Marsh, LMT"). No-op on a too-
   *  short phrase (would over-match). */
  record_substring(phrase_norm: string, user_id: string): boolean {
    const p = phrase_norm.trim();
    if (p.length < EventAttributions.MIN_PHRASE) return false;
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO event_attributions
           (fingerprint, user_id, title_norm, location_norm, weekday, hour, hits, match_mode, created_at, updated_at)
         VALUES (@fp, @uid, @t, '', '', 0, 1, 'substring', @now, @now)
         ON CONFLICT(fingerprint) DO UPDATE SET
           user_id = @uid, hits = hits + 1, updated_at = @now`,
      )
      .run({ '@fp': `sub:${p}`, '@uid': user_id, '@t': p, '@now': now });
    return true;
  }

  /** Resolve a CONTAINS rule for an event title — the LONGEST matching phrase
   *  wins (most specific), so "becca sagall" beats "becca". Null when none. */
  match_substring(title_norm: string): { user_id: string; phrase: string } | null {
    const t = title_norm.trim();
    if (!t) return null;
    const rules = this.db
      .prepare(`SELECT title_norm AS phrase, user_id FROM event_attributions WHERE match_mode = 'substring'`)
      .all() as Array<{ phrase: string; user_id: string }>;
    let best: { user_id: string; phrase: string } | null = null;
    for (const r of rules) {
      if (r.phrase && t.includes(r.phrase) && (!best || r.phrase.length > best.phrase.length)) {
        best = { user_id: r.user_id, phrase: r.phrase };
      }
    }
    return best;
  }

  /** Resolve the learned owner for an event's components, most-specific tier
   *  first. Returns null when nothing has been learned that matches. */
  best_match(c: AttributionComponents): AttributionMatch | null {
    // 1. exact fingerprint
    const exact = this.db
      .prepare(`SELECT user_id, hits FROM event_attributions WHERE fingerprint = @fp`)
      .get({ '@fp': fingerprint_of(c) }) as { user_id: string; hits: number } | null;
    if (exact) return { user_id: exact.user_id, tier: 'exact', hits: exact.hits };

    if (c.title_norm.length === 0) return null;

    // 2. title + weekday + hour (a recurring slot, location-agnostic)
    const tt = this._top(
      `SELECT user_id, SUM(hits) AS hits FROM event_attributions
         WHERE match_mode = 'exact' AND title_norm = @t AND weekday = @w AND hour = @h GROUP BY user_id ORDER BY hits DESC LIMIT 1`,
      { '@t': c.title_norm, '@w': c.weekday, '@h': c.hour },
    );
    if (tt) return { ...tt, tier: 'title_time' };

    // 3. title + location (a recurring place)
    if (c.location_norm.length > 0) {
      const tl = this._top(
        `SELECT user_id, SUM(hits) AS hits FROM event_attributions
           WHERE match_mode = 'exact' AND title_norm = @t AND location_norm = @l GROUP BY user_id ORDER BY hits DESC LIMIT 1`,
        { '@t': c.title_norm, '@l': c.location_norm },
      );
      if (tl) return { ...tl, tier: 'title_location' };
    }

    // 4. title only (weakest)
    const t = this._top(
      `SELECT user_id, SUM(hits) AS hits FROM event_attributions
         WHERE match_mode = 'exact' AND title_norm = @t GROUP BY user_id ORDER BY hits DESC LIMIT 1`,
      { '@t': c.title_norm },
    );
    if (t) return { ...t, tier: 'title' };

    return null;
  }

  private _top(sql: string, params: Record<string, string | number>): { user_id: string; hits: number } | null {
    const r = this.db.prepare(sql).get(params) as { user_id: string; hits: number } | null;
    return r ?? null;
  }

  /** All learned rows (debug / smoke). */
  all(): Row[] {
    return this.db.prepare(`SELECT * FROM event_attributions ORDER BY updated_at DESC`).all() as Row[];
  }
}
