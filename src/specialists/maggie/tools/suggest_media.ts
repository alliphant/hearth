/**
 * suggest_media — Maggie's thematic media recommendation surface.
 *
 * This is the structured REPLACEMENT for the old
 * `propose_action({ kind: 'recommendation', body: "<title> — … ask
 * Cordelia to add via sonarr" })` pattern. That path was wrong-shaped on
 * three counts: (1) it shoved a purely advisory FYI — one with no
 * execution affordance, since Maggie surfaces and Cordelia acquires —
 * through the Approve/Edit/Deny proposal rail; (2) the `recommendation`
 * proposal kind's renderer was built for Beatrice's connector-recovery
 * payloads, so a media body rendered as a truncated raw-rationale title;
 * (3) nothing checked whether Jasper already OWNED the title before
 * recommending it (he kept getting recommended things already in Plex).
 *
 * suggest_media fixes all three: the pick lands in the Listening pane's
 * "Worth a look" section (Maggie's office, not the inbox), and BEFORE it
 * is stored the tool dedups against the live *arr/Plex library via
 * `media_search` — if the title is already in the matching app's library
 * (Sonarr/Radarr/Lidarr/Readarr, which is what feeds Plex), the
 * recommendation is suppressed and never surfaces.
 *
 * High-value picks still reach the daily brief, but via Maggie informing
 * Kate (consult_specialist), NOT via a proposal — see the persona's
 * thematic-recommendation workflow.
 *
 * Side effects:
 *   1. READ: media_search against the kind's *arr app to resolve the
 *      `in_library` flag for dedup. Fail-open — if the *arr stack is
 *      unreachable we surface the rec anyway (advisory; better than a
 *      dead pane) and record that dedup was unverified.
 *   2. UPSERT into `media_recommendations` keyed by (user_id, dedup_key)
 *      where dedup_key = media_kind + normalized title. A re-suggest
 *      refreshes last_seen_at + content but never resurrects a row Jasper
 *      dismissed or already had Cordelia acquire.
 *   3. One audit row carrying the dedup outcome + whether it surfaced.
 *
 * Capability: `recommend_media` (the advise-only surface) + `manage_media`
 * (the media_search dedup read). Risk: `write_internal`.
 */

import { z } from 'zod';
import { createHash } from 'node:crypto';
import { ulid } from 'ulid';
import type { Database } from 'bun:sqlite';
import type { Tool, ToolContext } from '@core/tool';
import type { ToolDeps } from '@core/tool_deps';
import { media_search } from '@connectors/arr';

const MediaKind = z.enum(['movie', 'tv', 'music', 'book']);
type MediaKindT = z.infer<typeof MediaKind>;

/** media_kind → the *arr app whose library is authoritative for dedup. */
const KIND_TO_APP: Record<MediaKindT, 'sonarr' | 'radarr' | 'lidarr' | 'readarr'> = {
  tv: 'sonarr',
  movie: 'radarr',
  music: 'lidarr',
  book: 'readarr',
};

const InputSchema = z.object({
  title: z
    .string()
    .min(1)
    .max(200)
    .describe(
      'The work being recommended — a show / film / artist / author name. ' +
        'Use the canonical title (what media_search would find), not a ' +
        'descriptive phrase.',
    ),
  media_kind: MediaKind.describe(
    'What kind of thing this is. Picks the library the dedup check hits: ' +
      'tv=Sonarr, movie=Radarr, music=Lidarr, book=Readarr.',
  ),
  rationale: z
    .string()
    .min(1)
    .max(400)
    .describe(
      'One or two sentences — the thematic reason this matches Jasper\'s ' +
        'taste. Surfaced as the "Worth a look" row subtitle. Do NOT include ' +
        '"ask Cordelia to add it" boilerplate; the office already frames ' +
        'these as advisory.',
    ),
  profile_match: z
    .string()
    .max(200)
    .optional()
    .describe(
      'Optional one-line quote/pattern from the taste profile this pick ' +
        'matched (e.g. "institutional sci-fi with a slow burn"). Provenance ' +
        'for the recommendation.',
    ),
  source_url: z
    .string()
    .url()
    .optional()
    .describe('Optional link — a trailer, review, or release page.'),
});

const OutputSchema = z.object({
  surfaced: z
    .boolean()
    .describe('True if the rec landed in the pane; false if suppressed.'),
  reason: z.enum(['surfaced', 'already_in_library', 'already_recommended']),
  id: z.string().nullable(),
  was_inserted: z.boolean(),
  dedup_checked: z
    .boolean()
    .describe('Whether the *arr library dedup check actually ran (false = unreachable).'),
  library_match: z.string().nullable(),
});

type Input = z.infer<typeof InputSchema>;
type Output = z.infer<typeof OutputSchema>;

/** Normalize a title for dedup/matching: lowercase, strip a leading
 *  article, collapse whitespace + punctuation noise. Deterministic. */
function normalize_title(raw: string): string {
  return raw
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/^\s*the\s+/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

interface DedupOutcome {
  /** True only when the check ran AND a same-title result is in_library. */
  owned: boolean;
  /** True when the *arr query succeeded (regardless of result). */
  checked: boolean;
  /** The matched library title (for the audit/return), if owned. */
  match: string | null;
}

/**
 * Ask the relevant *arr app whether Jasper already owns this title.
 * Conservative match: a search result counts as "the same work" only when
 * its normalized title equals the recommendation's normalized title — so a
 * near-name (a different show sharing a word) never false-suppresses, and a
 * genuine owned title (Severance already in Sonarr → Plex) always does.
 * Fail-open: any error leaves owned=false, checked=false.
 */
async function check_library(
  input: Input,
  ctx: ToolContext,
): Promise<DedupOutcome> {
  const app = KIND_TO_APP[input.media_kind];
  const want = normalize_title(input.title);
  try {
    const res = await media_search.execute({ app, term: input.title }, ctx);
    if (res.error) return { owned: false, checked: false, match: null };
    for (const r of res.results) {
      if (normalize_title(r.title) === want && r.in_library) {
        return { owned: true, checked: true, match: r.title };
      }
    }
    return { owned: false, checked: true, match: null };
  } catch {
    return { owned: false, checked: false, match: null };
  }
}

interface UpsertResult {
  id: string;
  was_inserted: boolean;
  status: string;
}

function upsert_recommendation(
  db: Database,
  user_id: string,
  input: Input,
  dedup_key: string,
  now_iso: string,
): UpsertResult {
  type ExistingRow = { id: string; status: string };
  const existing = db
    .prepare(
      `SELECT id, status FROM media_recommendations
        WHERE user_id = @uid AND dedup_key = @dedup_key`,
    )
    .get({ '@uid': user_id, '@dedup_key': dedup_key }) as ExistingRow | undefined;
  if (existing) {
    // Refresh content + recency, but NEVER flip status — a dismissed or
    // already-added pick stays out of the pane even if Maggie re-derives it.
    db.prepare(
      `UPDATE media_recommendations
          SET last_seen_at = @now,
              rationale = @rationale,
              profile_match = COALESCE(@profile_match, profile_match),
              source_url = COALESCE(@source_url, source_url)
        WHERE id = @id`,
    ).run({
      '@id': existing.id,
      '@now': now_iso,
      '@rationale': input.rationale,
      '@profile_match': input.profile_match ?? null,
      '@source_url': input.source_url ?? null,
    });
    return { id: existing.id, was_inserted: false, status: existing.status };
  }
  const id = ulid();
  db.prepare(
    `INSERT INTO media_recommendations (
       id, user_id, title, media_kind, rationale, profile_match,
       source_url, status, dedup_key, first_seen_at, last_seen_at
     ) VALUES (
       @id, @user_id, @title, @media_kind, @rationale, @profile_match,
       @source_url, 'active', @dedup_key, @now, @now
     )`,
  ).run({
    '@id': id,
    '@user_id': user_id,
    '@title': input.title,
    '@media_kind': input.media_kind,
    '@rationale': input.rationale,
    '@profile_match': input.profile_match ?? null,
    '@source_url': input.source_url ?? null,
    '@dedup_key': dedup_key,
    '@now': now_iso,
  });
  return { id, was_inserted: true, status: 'active' };
}

export function create(deps: ToolDeps): Tool<Input, Output> {
  return {
    name: 'suggest_media',
    description:
      "Surface a thematic media recommendation into Jasper's Listening room " +
      '("Worth a look"). Use this INSTEAD OF propose_action for media picks — ' +
      'a recommendation is advisory (you surface, Cordelia acquires), so it ' +
      'belongs in your office, not his decision queue. Required: title, ' +
      'media_kind (movie/tv/music/book), rationale (the thematic reason). ' +
      'Optional: profile_match (the taste-profile pattern it hit), ' +
      'source_url. Before storing, this checks the *arr library and ' +
      'SUPPRESSES anything Jasper already owns — so never worry about ' +
      'recommending something already in Plex. For a standout pick that ' +
      'deserves the daily brief, ALSO consult_specialist Kate (inform); ' +
      'this tool only populates the office.',
    risk: 'write_internal',
    required_capabilities: ['recommend_media', 'manage_media'],
    input_schema: InputSchema,
    output_schema: OutputSchema,

    idempotency_key(input) {
      const h = createHash('sha256');
      h.update(input.media_kind);
      h.update('\n');
      h.update(normalize_title(input.title));
      return `suggest_media:${h.digest('hex').slice(0, 16)}`;
    },

    async execute(input, ctx: ToolContext): Promise<Output> {
      const now_iso = (ctx.now ?? new Date()).toISOString();
      const user_id = ctx.user?.id ?? 'jasper';
      const dedup_key = `${input.media_kind}:${normalize_title(input.title)}`;

      const dedup = await check_library(input, ctx);

      let result: Output;
      if (dedup.owned) {
        // Already in the library — do not surface, do not store.
        result = {
          surfaced: false,
          reason: 'already_in_library',
          id: null,
          was_inserted: false,
          dedup_checked: dedup.checked,
          library_match: dedup.match,
        };
      } else {
        const up = upsert_recommendation(deps.db, user_id, input, dedup_key, now_iso);
        // A pick the user already dismissed/added is upserted (recency
        // refreshed) but reports as not surfaced — the pane filters to
        // status='active', so a non-active row is effectively suppressed.
        const surfaced = up.status === 'active';
        result = {
          surfaced,
          reason: surfaced ? 'surfaced' : 'already_recommended',
          id: up.id,
          was_inserted: up.was_inserted,
          dedup_checked: dedup.checked,
          library_match: null,
        };
      }

      ctx.memory.log_action({
        intent_id: ctx.intent_id || ulid(),
        agent: ctx.specialist_id ?? 'maggie',
        tool_name: 'suggest_media',
        tool_input: {
          title: input.title,
          media_kind: input.media_kind,
          has_profile_match: input.profile_match != null,
        },
        execution_result: {
          surfaced: result.surfaced,
          reason: result.reason,
          dedup_checked: result.dedup_checked,
          library_match: result.library_match,
        },
      });

      return result;
    },
  };
}
