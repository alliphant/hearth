/**
 * taste_sources — deterministic evidence mappers for the TASTE & INTERESTS
 * facets of the per-user model (executive-assistant endgame Phase B,
 * 2026-07-04). Each mapper turns one signal store's raw shape into bounded,
 * enumerable evidence lines + a change cursor for the sweep's pull gate.
 *
 * The LAW #1 split: these mappers only EXTRACT and ENUMERATE evidence
 * deterministically (group, count, cap — never judge); what the person is
 * actually INTO is the synthesis model's call, at sweep time, over the
 * numbered lines. Sources are pluggable — music/screen/mail/purchases are
 * today's mappers, not the point; a new signal = a new mapper returning the
 * same PulledEvidence shape, wired into the sweep's `sources` map.
 *
 * Pure functions — no I/O, no clock, no env. A source with nothing to say
 * returns null and the facet self-gates to a no-op (the gift_budget shape),
 * so an unconfigured source needs no kill switch.
 */
import { createHash } from 'node:crypto';
import type { PulledEvidence } from '@core/user_model';
import type { MusicContextSnapshot } from '@memory/client';
import { domain_of_addr, root_domain } from '@core/household_services';

/** Deterministic change cursor over the derived lines — synthesis re-fires
 *  only when the evidence actually changed (and past the min-interval). */
function hash_cursor(lines: string[]): string {
  return createHash('sha256').update(lines.join('\n')).digest('hex').slice(0, 16);
}

function day(iso: string | null | undefined): string {
  return typeof iso === 'string' && iso.length >= 10 ? iso.slice(0, 10) : '';
}

// ── music (the daily iOS MediaPlayer snapshot) ──────────────────────────

const MUSIC_TOP_ARTISTS = 15;
const MUSIC_RECENT = 10;
const MUSIC_PLAYLISTS = 8;

/**
 * Evidence for the `music_taste` facet from the user's latest music-context
 * snapshot (`MemoryClient.query_music_context` — top artists, recently
 * played, library counts; full-state replace per upload). Cursor is the
 * snapshot's `captured_at`, so an unchanged snapshot never re-distills.
 */
export function music_evidence(snap: MusicContextSnapshot | null): PulledEvidence | null {
  if (!snap) return null;
  const p = snap.payload;
  const lines: string[] = [];
  for (const a of (p.top_artists ?? []).slice(0, MUSIC_TOP_ARTISTS)) {
    if (!a?.artist) continue;
    const last = day(a.last_played);
    lines.push(`top artist: ${a.artist} — ${a.play_count} plays${last ? ` (last ${last})` : ''}`);
  }
  for (const t of (p.recently_played ?? []).slice(0, MUSIC_RECENT)) {
    if (!t?.title || !t?.artist) continue;
    lines.push(`recently played: "${t.title}" — ${t.artist}${t.album ? ` (${t.album})` : ''}`);
  }
  for (const pl of (p.starred_playlists ?? []).slice(0, MUSIC_PLAYLISTS)) {
    if (pl) lines.push(`starred playlist: ${pl}`);
  }
  const lc = p.library_counts;
  if (lc) {
    lines.push(`library: ${lc.songs} songs, ${lc.albums} albums, ${lc.artists} artists, ${lc.playlists} playlists`);
  }
  if (lines.length === 0) return null;
  return { lines, cursor: snap.captured_at };
}

// ── screen (Tautulli watch history) ─────────────────────────────────────

/** One projected Tautulli history row (the plex.ts `get_history` shape,
 *  narrowed to what the mapper reads). */
export interface ScreenPlayRow {
  media_type: string;
  title: string;
  /** Show title for episode rows. */
  grandparent_title: string;
  /** ISO timestamp of the play ('' when unknown). */
  watched_at: string;
  /** 0–1 fraction of the item watched, when known. */
  watched_fraction: number | null;
}

const SCREEN_TOP_SHOWS = 12;
const SCREEN_TOP_MOVIES = 12;
/** A movie played past this fraction counts as watched, below it as sampled. */
const WATCHED_FRACTION = 0.7;

/**
 * Evidence for the `screen_taste` facet from raw watch-history rows:
 * episodes grouped into per-show play counts (returning to a show is the
 * durable signal), movies deduped with a watched-vs-sampled verdict.
 * Cursor is a hash of the derived lines.
 */
export function screen_evidence(rows: ScreenPlayRow[] | null): PulledEvidence | null {
  if (!rows || rows.length === 0) return null;
  const shows = new Map<string, { plays: number; last: string }>();
  const movies = new Map<string, { plays: number; last: string; watched: boolean }>();
  for (const r of rows) {
    if (r.media_type === 'episode' && r.grandparent_title) {
      const s = shows.get(r.grandparent_title) ?? { plays: 0, last: '' };
      s.plays += 1;
      if (r.watched_at > s.last) s.last = r.watched_at;
      shows.set(r.grandparent_title, s);
    } else if (r.media_type === 'movie' && r.title) {
      const m = movies.get(r.title) ?? { plays: 0, last: '', watched: false };
      m.plays += 1;
      if (r.watched_at > m.last) m.last = r.watched_at;
      if ((r.watched_fraction ?? 0) >= WATCHED_FRACTION) m.watched = true;
      movies.set(r.title, m);
    }
  }
  const by_plays = <T extends { plays: number }>(a: [string, T], b: [string, T]): number =>
    b[1].plays - a[1].plays || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);

  const lines: string[] = [];
  for (const [name, s] of [...shows.entries()].sort(by_plays).slice(0, SCREEN_TOP_SHOWS)) {
    const last = day(s.last);
    lines.push(`tv: ${name} — ${s.plays} episode${s.plays === 1 ? '' : 's'}${last ? `, last ${last}` : ''}`);
  }
  for (const [name, m] of [...movies.entries()].sort(by_plays).slice(0, SCREEN_TOP_MOVIES)) {
    const last = day(m.last);
    lines.push(
      `movie: ${name} — ${m.watched ? 'watched' : 'sampled'}${m.plays > 1 ? ` ×${m.plays}` : ''}${last ? `, ${last}` : ''}`,
    );
  }
  if (lines.length === 0) return null;
  return { lines, cursor: hash_cursor(lines) };
}

// ── interest signals (mail + purchases) ─────────────────────────────────

/** An inbound mail row, narrowed to the recurring-sender signal. Callers
 *  pre-filter to the ONE user's own non-junk mail (the cordon). */
export interface MailSignalRow {
  from_addr: string;
  from_name: string;
  triage_category: string;
}

/** A household-good purchase, narrowed to the interest signal. Callers read
 *  through the cordoned `query_household_goods`. */
export interface GoodSignalRow {
  name: string;
  category: string | null;
  merchant: string | null;
  purchase_date: string | null;
}

/** A sender becomes a "recurring" signal at this many messages in-window. */
const RECURRING_MIN = 3;
const INTEREST_SENDERS = 12;
const INTEREST_GOODS = 15;

/**
 * Supplemental evidence for the `interests` facet from what the user already
 * DOES: senders they receive recurringly (newsletters/subscriptions they
 * keep — grouped by root domain, one-off senders dropped) and recent
 * purchases. The model judges which of these are genuine interests at
 * synthesis; this only surfaces the candidates.
 */
export function interest_signal_evidence(input: {
  mail: MailSignalRow[];
  goods: GoodSignalRow[];
}): PulledEvidence | null {
  const lines: string[] = [];

  const by_root = new Map<string, { n: number; name: string; cats: Map<string, number> }>();
  for (const m of input.mail) {
    const root = root_domain(domain_of_addr(m.from_addr));
    if (!root) continue;
    const e = by_root.get(root) ?? { n: 0, name: '', cats: new Map<string, number>() };
    e.n += 1;
    if (!e.name && m.from_name) e.name = m.from_name;
    const cat = (m.triage_category ?? '').trim();
    if (cat && cat !== 'unknown') e.cats.set(cat, (e.cats.get(cat) ?? 0) + 1);
    by_root.set(root, e);
  }
  const recurring = [...by_root.entries()]
    .filter(([, e]) => e.n >= RECURRING_MIN)
    .sort((a, b) => b[1].n - a[1].n || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .slice(0, INTEREST_SENDERS);
  for (const [root, e] of recurring) {
    const cat = [...e.cats.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
    lines.push(`recurring mail: ${e.name || root} — ${e.n} messages${cat ? ` (${cat})` : ''}`);
  }

  const goods = [...input.goods]
    .sort((a, b) => ((a.purchase_date ?? '') < (b.purchase_date ?? '') ? 1 : -1))
    .slice(0, INTEREST_GOODS);
  for (const g of goods) {
    if (!g.name) continue;
    const bits = [g.category, g.merchant].filter(Boolean).join(', ');
    const d = day(g.purchase_date);
    lines.push(`purchased: ${g.name}${bits ? ` (${bits})` : ''}${d ? ` — ${d}` : ''}`);
  }

  if (lines.length === 0) return null;
  return { lines, cursor: hash_cursor(lines) };
}
