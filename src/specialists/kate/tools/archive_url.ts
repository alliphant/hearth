/**
 * archive_url — Kate's front for the Media Archive (design-media-archival.md).
 *
 * Jasper hands Kate a URL; this ONE all-encompassing tool files a
 * media_archive_jobs row and KICKS the detached MediaArchiveRunner (probe →
 * NSFW classify → categorize → compat download → context .md → index →
 * report-back), returning IMMEDIATELY with a next_action that steers Kate to say
 * "on it, I'll report back" and NOT do the work in-turn. Named optional slots
 * (quality_override / note / audio_only) extend it without new narrow tools (the
 * all-encompassing-tools rule).
 *
 * RETIRED 2026-07-29: `force_owner_only` ("archive privately (owner-only cordon)
 * regardless of the NSFW classification"). The owner directive of that date made
 * the cordon unconditional — `private_to` is the requester for EVERY item, safe or
 * not (@core/media/cordon) — so the slot promised Kate a privacy effect it could
 * no longer have. What it actually still reached was the `media_archived` event's
 * `nsfw` flag, and nothing else: not the cordon, not the note's `nsfw`
 * frontmatter, not the `Private/` folder. So it made the event disagree with the
 * note and row it projects while buying no privacy at all.
 *
 * It was RETIRED rather than re-founded on the explicit axis ("file under Private/
 * regardless of the classifier") on purpose. That axis is evidence-backed by
 * design: a `nsfw` flag is `nsfw_flag_for(verdict)` and a verdict may only ever
 * come from an actual classifier read, which is why `rescan_media_metadata`
 * facet:'nsfw' treats `frames_scored: 0` as proof that a verdict was fabricated.
 * A hand-forced flag would BE such a fabrication: it would leave the row looking
 * permanently never-classified, get re-swept every remediation pass, and be
 * silently overwritten by the classifier the sweep then runs. Giving the owner
 * that lever honestly means adding forced-verdict provenance to the note and
 * teaching the sweep to respect it — a real feature, not a description fix, and
 * nobody has asked for it. The cordon already gives him the privacy he asked for.
 */
import { z } from 'zod';
import { createHash } from 'node:crypto';
import { ulid } from 'ulid';
import type { Tool, ToolContext } from '@core/tool';
import type { ToolDeps } from '@core/tool_deps';
import { emit_job_progress, job_from_media_row } from '@core/jobs';
import {
  media_archive_deps_from,
  media_archive_enabled,
  kick_media_archive_detached,
  type MediaArchiveRunnerDeps,
} from '../media_archive_runner';

const InputSchema = z.object({
  url: z
    .string()
    .url()
    .describe(
      'The URL to archive — YouTube or any yt-dlp-supported site (video/audio), ' +
        'or an image gallery. The runner downloads it at highest quality within ' +
        'reason, categorizes it, and files it onto the archive.',
    ),
  quality_override: z
    .string()
    .optional()
    .describe(
      'Override the default (best within 4K / ~20 GB). e.g. "2160"/"4k", "1080", ' +
        '"audio" (rip audio only), "best". Only when Jasper specifies.',
    ),
  note: z
    .string()
    .optional()
    .describe('Why he wants it / a caption — high-signal for how it gets categorized.'),
  audio_only: z
    .boolean()
    .optional()
    .describe('Rip audio only (music / podcast) even for a video source.'),
});

const OutputSchema = z.object({
  job_id: z.string().optional(),
  url: z.string(),
  status: z.string().optional(),
  already_running: z.boolean(),
  enabled: z.boolean(),
  next_action: z.string(),
});

type Input = z.infer<typeof InputSchema>;
type Output = z.infer<typeof OutputSchema>;

export function make_archive_url(runner_deps: MediaArchiveRunnerDeps): Tool<Input, Output> {
  return {
    name: 'archive_url',
    description:
      "Archive a URL to Jasper's media library: download it (highest quality within reason — best up to 4K / ~20 GB), figure out what it is (music vs video, genre, the artist/creator, and SFW vs NSFW), and file it onto the archive with a rich metadata note so it's searchable + streamable in the app. Every archived item is filed PRIVATELY to whoever asked for it — nobody else can see it, safe or explicit — so there is no privacy option to pass and nothing to promise about discretion beyond that. Use whenever Jasper hands you a link to save/download/archive/rip. Runs in the BACKGROUND and reports back — you do NOT download or describe the content in this turn. Optional: quality_override ('2160'/'1080'/'audio'/'best'), note (a caption/why — helps categorization), audio_only (rip just the audio).",
    risk: 'write_internal',
    required_capabilities: ['manage_media_archive'],
    input_schema: InputSchema,
    output_schema: OutputSchema,

    idempotency_key(input) {
      const h = createHash('sha256');
      h.update(input.url);
      h.update('\n');
      h.update(input.quality_override ?? '');
      h.update('\n');
      h.update(input.audio_only ? 'audio' : 'av');
      return `archive_url:${h.digest('hex').slice(0, 16)}`;
    },

    async execute(input, ctx: ToolContext): Promise<Output> {
      const enabled = media_archive_enabled();
      const requested_by = ctx.user?.id ?? null;
      const store = ctx.memory.media_jobs;

      // Re-file collapse: an OPEN job for the same url + requester → return it.
      const existing = store.find_open_for_url(input.url, requested_by);
      if (existing) {
        // Re-drive a possibly-stranded job — the detached kick otherwise fires
        // only at creation, so a re-request is a natural resume trigger.
        if (enabled) kick_media_archive_detached(runner_deps, existing.id, ctx.specialist_id ?? 'kate');
        return {
          job_id: existing.id,
          url: input.url,
          status: existing.status,
          already_running: true,
          enabled,
          next_action: `Already archiving that (${existing.status}). Tell Jasper it's in progress and you'll report back when it's filed — don't re-fetch it.`,
        };
      }

      const row = store.create({
        url: input.url,
        requested_by,
        private_to: requested_by, // the job belongs to its requester; no owner god-view
        conversation_id: ctx.conversation_id ?? null,
        user_note: input.note ?? null,
        quality_override: input.quality_override ?? null,
        audio_only: input.audio_only ?? false,
      });

      ctx.memory.log_action({
        intent_id: ctx.intent_id || ulid(),
        agent: ctx.specialist_id ?? 'kate',
        tool_name: 'archive_url',
        tool_input: {
          url: input.url,
          quality_override: input.quality_override,
          audio_only: input.audio_only,
        },
        execution_result: { job_id: row.id },
        ...(requested_by ? { user_id: requested_by } : {}),
      });

      // Put the row on the wall BEFORE the runner starts, not after its first
      // phase lands. The pipeline's first slice takes seconds (4.1 s on the
      // 2026-07-29 job), and that is precisely the window where the user has
      // just asked and is looking for a sign that anything happened. Emitting
      // here means "Queued" appears the instant Kate accepts the request — the
      // whole point of the pane is that the answer is never a question.
      emit_job_progress(runner_deps.events, job_from_media_row(row));

      if (enabled) {
        kick_media_archive_detached(runner_deps, row.id, ctx.specialist_id ?? 'kate');
      }

      return {
        job_id: row.id,
        url: input.url,
        status: 'pending',
        already_running: false,
        enabled,
        next_action: enabled
          ? "On it — say you're downloading and filing it now and will let Jasper know when it's in his library. Do NOT try to fetch, watch, or describe the content in this turn."
          : 'Media archiving is turned off (HEARTH_MEDIA_ARCHIVE=0). The request is filed and will run when it is re-enabled — tell Jasper it is queued.',
      };
    },
  };
}

export function create(deps: ToolDeps): Tool {
  return make_archive_url(media_archive_deps_from(deps)) as Tool;
}
