/**
 * Maggie — band poster intake.
 *
 * The headline cross-reference case for the visual pipeline. Cordelia
 * picks Maggie when a capture looks like a band poster or concert
 * flyer. This handler:
 *
 *   1. Extracts a candidate artist from OCR text + VL salient objects
 *      (cheap regex — the actual classifier already picked the route).
 *   2. Looks up the artist in the user's music_context snapshot
 *      (iOS-posted MusicKit data; no server-side JWT). Computes
 *      affinity = the artist's play_count over the window's total.
 *   3. If affinity is high (>= 0.05) AND the OCR text mentions a
 *      date or venue, drops an `fyi` inbox flag with the affinity
 *      score; deliberation/Kate decide whether to propose a buy.
 *      We don't queue a Tier 2 proposal here — that's Maggie's
 *      next-deliberation call to make, and she has the context to
 *      know whether the user is currently in band-find mode.
 *   4. Always files a note onto Knowledge/Maggie/posters/.
 */

import type { IntakeHandler, IntakeHandlerInput } from '@core/reactive_inbox';
import {
  audit_intake,
  mark_intake_done,
  slug,
} from '../../_intake_helpers';
import type { MusicContextPayloadShape } from '@memory/client';

function pick_artist_candidate(
  ocr_text: string,
  salient: string[] | undefined,
): string | null {
  // Bands on a poster are usually the largest text and frequently appear
  // ALL-CAPS or Title Case at the start of a line. Take the first
  // 2-5 word line that's mostly letters and isn't a date or venue keyword.
  const skip = /^(LIVE|TICKETS?|TOUR|VENUE|DOORS|ALL AGES|18\+|21\+)$/i;
  for (const raw of ocr_text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.length === 0 || line.length > 60) continue;
    const words = line.split(/\s+/);
    if (words.length < 1 || words.length > 6) continue;
    if (skip.test(line)) continue;
    if (/^\d/.test(line)) continue; // date/time
    const letter_share = line.replace(/[^a-zA-Z]/g, '').length / line.length;
    if (letter_share < 0.6) continue;
    return line;
  }
  // Fall back to a salient object that's plausibly an artist name —
  // VL sometimes spells out the band on the poster.
  if (salient) {
    for (const s of salient) {
      if (s.length > 2 && s.length < 60 && /[A-Z]/.test(s)) return s;
    }
  }
  return null;
}

function affinity_for(artist: string, ctx: MusicContextPayloadShape): {
  play_count: number;
  share: number;
  matched: string | null;
} {
  const norm = artist.trim().toLowerCase();
  const total = ctx.top_artists.reduce((acc, t) => acc + t.play_count, 0) || 1;
  // Exact then substring match — band names on a poster sometimes
  // include extra words ("THE NATIONAL" vs "National").
  let matched: { artist: string; play_count: number } | null = null;
  for (const t of ctx.top_artists) {
    if (t.artist.toLowerCase() === norm) {
      matched = t;
      break;
    }
  }
  if (!matched) {
    for (const t of ctx.top_artists) {
      const tn = t.artist.toLowerCase();
      if (tn.includes(norm) || norm.includes(tn)) {
        matched = t;
        break;
      }
    }
  }
  if (!matched) return { play_count: 0, share: 0, matched: null };
  return {
    play_count: matched.play_count,
    share: matched.play_count / total,
    matched: matched.artist,
  };
}

const DATE_HINT = /\b(20\d{2})[-/.]?(\d{1,2})[-/.]?(\d{1,2})\b|\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+\d{1,2}\b/i;
const VENUE_HINT = /\b(theatre|theater|amphitheatre|ballroom|hall|lounge|garden|arena|stadium|stage|club|pavilion|fairgrounds)\b/i;

export const intake_band_poster: IntakeHandler = async (input: IntakeHandlerInput) => {
  const payload = input.decision.extracted_payload;
  const ocr_text = payload.ocr_text ?? '';
  const candidate = pick_artist_candidate(ocr_text, payload.vl_salient_objects);

  const ctx = input.memory.query_music_context(input.user_id);
  const aff = ctx && candidate ? affinity_for(candidate, ctx.payload) : { play_count: 0, share: 0, matched: null };

  const has_date = DATE_HINT.test(ocr_text);
  const has_venue = VENUE_HINT.test(ocr_text);

  const rel = `Knowledge/Maggie/posters/${input.capture_id}-${slug(candidate ?? 'poster')}.md`;
  const fm: Record<string, unknown> = {
    type: 'band_poster',
    source_capture_id: input.capture_id,
    source_capture_note: input.note_path,
    artist_candidate: candidate,
    artist_matched: aff.matched,
    affinity_play_count: aff.play_count,
    affinity_share: aff.share,
    has_date_hint: has_date,
    has_venue_hint: has_venue,
    music_context_present: Boolean(ctx),
    private_to: input.user_id,
  };

  const lines: string[] = [];
  lines.push(`# Poster — ${candidate ?? 'unidentified artist'}`);
  lines.push('');
  lines.push(`**Route reason**: ${input.decision.route_reason}`);
  if (candidate) lines.push(`**Artist candidate**: ${candidate}`);
  if (aff.matched) {
    lines.push(`**Music affinity**: matched as "${aff.matched}" with ${aff.play_count} plays in the window (${(aff.share * 100).toFixed(1)}%)`);
  } else if (ctx) {
    lines.push(`**Music affinity**: no match in the user's recent listening.`);
  } else {
    lines.push(`**Music affinity**: no music_context snapshot on file yet.`);
  }
  if (payload.vl_description) {
    lines.push('');
    lines.push('## VL description');
    lines.push(payload.vl_description);
  }
  if (ocr_text.length > 0) {
    lines.push('');
    lines.push('## OCR text');
    lines.push('');
    lines.push('```');
    lines.push(ocr_text);
    lines.push('```');
  }
  lines.push('');
  lines.push('## Source');
  lines.push(`Capture: [[${input.note_path}|original]]`);

  input.memory.upsert_note(rel, fm, lines.join('\n'));

  // High-affinity + has-date → FYI to Maggie's inbox; her deliberation
  // can decide on a ticket-buy proposal. Threshold deliberately low
  // because heavy rotation is rare and we'd rather over-flag than miss.
  let inbox_id: string | null = null;
  if (aff.share >= 0.05 && has_date) {
    inbox_id = input.inbox.push({
      from_specialist_id: 'cordelia',
      to_specialist_id: 'maggie',
      kind: 'fyi',
      body_md: [
        `Poster for **${aff.matched ?? candidate ?? 'an artist'}** — affinity ${(aff.share * 100).toFixed(1)}% (${aff.play_count} plays in window).`,
        `Date hint present, venue ${has_venue ? 'present' : 'unclear'}.`,
        `Wrapper: [[${input.note_path}]] · filed note: [[${rel}]]`,
      ].join('\n'),
      originating_user_id: input.user_id,
    });
  }

  mark_intake_done(input.memory, input.note_path, {
    handler: 'maggie.intake_band_poster',
    outcome: aff.share >= 0.05 && has_date ? 'proposed' : 'filed',
    artifact_path: rel,
    summary: candidate
      ? `Poster filed for ${candidate}${aff.matched ? ` (affinity ${(aff.share * 100).toFixed(1)}%)` : ''}`
      : 'Poster filed (no artist candidate)',
  });

  audit_intake(input, {
    handler: 'maggie.intake_band_poster',
    record_path: rel,
    artist_candidate: candidate,
    artist_matched: aff.matched,
    affinity_share: aff.share,
    inbox_id: inbox_id ?? undefined,
  });
};
