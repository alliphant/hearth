/**
 * media_archive_status — Kate's window into the Media Archive pipeline so she
 * reports the TRUTH about a download instead of guessing "still downloading."
 *
 * Two jobs, one all-encompassing tool (the all-encompassing-tools rule):
 *   • STATUS  — no args (or a job_id/url) → read the media_archive_jobs
 *     ledger and report each job's real phase + any error. This is what she
 *     calls when Jasper asks "did that download finish?" — a failed job reads
 *     `failed`, not `downloading`.
 *   • DIAGNOSE — `diagnose: true` on a failed/stuck job → explain WHY (the probe
 *     error, classified: site-block vs unsupported vs gated vs format-selection)
 *     AND look at what is actually there, from two angles that fail differently:
 *     the page's own HTML (og:video / <video>/<source> / .m3u8 / .mp4 / JSON-LD
 *     VideoObject, sized via a HEAD on the top candidates) and `yt-dlp -F`, the
 *     format table the extractor sees TODAY (`formats_now`). Gives her a concrete
 *     next step ("re-run archive_url — it now retries with browser impersonation"
 *     / "this one needs logged-in cookies" / "nothing satisfied the -f expression
 *     — here is what was on offer").
 *
 *     `formats_now` is asked LIVE rather than read out of the stored error on
 *     purpose. The error is a record of one moment; a row that failed before the
 *     download path began recording the format table (every row before
 *     2026-08-11) has no such record at all, and the whole point of a diagnosis
 *     is that it works on the failures you already have.
 *
 * Read-only over the ledger; the diagnose page-fetch is a plain GET, and the
 * `-F` read downloads no media — both of a URL Jasper already asked to archive.
 * Kate-only (manage_media_archive).
 */
import { z } from 'zod';
import type { Tool, ToolContext } from '@core/tool';
import type { ToolDeps } from '@core/tool_deps';
import type { Caller } from '@memory/private_to';
import type { MediaJobRow } from '@memory/stores/media_jobs';
import { looks_blocked } from '@connectors/media_probe';
import { list_formats } from '@connectors/media_download';

const InputSchema = z.object({
  job_id: z.string().optional().describe('A specific job id (ma_…) to report on.'),
  url: z
    .string()
    .optional()
    .describe('Report on the most recent job for this URL (alternative to job_id).'),
  diagnose: z
    .boolean()
    .optional()
    .describe(
      'For a failed/stuck job: explain WHY it failed and scan the page for the likely ' +
        'media (video/source tags, .m3u8/.mp4, og:video, JSON-LD) with sizes, plus a next step.',
    ),
  limit: z.number().int().min(1).max(25).optional().describe('Max jobs when listing (default 8).'),
});

const CandidateSchema = z.object({
  where: z.string(),
  url: z.string(),
  kind: z.string(),
  bytes: z.number().optional(),
});

const JobViewSchema = z.object({
  job_id: z.string(),
  url: z.string(),
  status: z.string(),
  phase: z.string(),
  error: z.string().nullable(),
  media_item_id: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});

const OutputSchema = z.object({
  jobs: z.array(JobViewSchema),
  report: z.string(),
  diagnosis: z
    .object({
      job_id: z.string(),
      why: z.string(),
      classification: z.string(),
      candidates: z.array(CandidateSchema),
      /**
       * `yt-dlp -F` asked LIVE, not read out of the failure. The stored error is
       * a record of one moment; this is the site as it is now — and it is the
       * only evidence available at all for a row that failed before the download
       * path started recording the format table.
       */
      formats_now: z.string().nullable(),
      next_step: z.string(),
    })
    .optional(),
});

type Input = z.infer<typeof InputSchema>;
type Output = z.infer<typeof OutputSchema>;

const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0 Safari/537.36';

function phase_of(row: MediaJobRow): string {
  switch (row.status) {
    case 'pending':
    case 'probing':
      return 'reading the page';
    case 'classifying':
      return 'figuring out what it is';
    case 'downloading':
      return 'downloading';
    case 'filing':
    case 'indexing':
      return 'filing it into the library';
    case 'done':
      return 'done — in the library';
    case 'failed':
      return 'failed';
    case 'cancelled':
      return 'cancelled';
    default:
      return row.status;
  }
}

function view(row: MediaJobRow) {
  return {
    job_id: row.id,
    url: row.url,
    status: row.status,
    phase: phase_of(row),
    error: row.error,
    media_item_id: row.media_item_id,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/** Classify a probe/download error into an actionable bucket. */
function classify_error(err: string): { classification: string; why: string; next_step: string } {
  // Format selection — the download path attaches the two facts yt-dlp's own line
  // omits (`selector:` + `formats offered:`), so quote them WHOLE rather than
  // slicing a fixed head off the front. This bucket is checked first because its
  // message body is a yt-dlp format table, which can incidentally contain any of
  // the words the buckets below key on.
  if (/requested format is not available/i.test(err)) {
    const detail = err.slice(err.search(/selector:/i));
    return {
      classification: 'format-selection (the -f expression matched no format)',
      why:
        'yt-dlp had the media but nothing satisfied the format expression we asked for — ' +
        'not a block, not a gate, and retrying as-is will fail identically. ' +
        (/selector:/i.test(err)
          ? detail.slice(0, 900)
          : 'This row failed before the download path recorded the selector and format table, ' +
            'so what it asked for is lost — read `formats_now` instead: that is the same ' +
            'question asked of the site just now.'),
      next_step:
        'Re-run archive_url — the height cap now tolerates a format that declares no height ' +
        '(`height<=?N`) and falls back to uncapped best, which is what a generic/HTML5 extractor ' +
        'single-format page needs. If it fails again, the format table above is the ground truth: ' +
        'pass quality:"best" to drop the cap entirely.',
    };
  }
  if (looks_blocked(err)) {
    return {
      classification: 'site-block (403 / bot wall)',
      why: `The site blocked the extractor: ${err.slice(0, 200)}`,
      next_step:
        'Re-run archive_url on this URL — the pipeline now retries with browser impersonation ' +
        '(curl_cffi), which clears most 403s. If it still fails, the site needs a logged-in ' +
        'cookies file.',
    };
  }
  if (/unsupported url|no video formats|no media/i.test(err)) {
    return {
      classification: 'unsupported / no extractable media',
      why: `The extractor has no handler for this URL, or found no downloadable media: ${err.slice(0, 200)}`,
      next_step:
        'Use the candidates below — pass the direct media URL (an .mp4 or .m3u8) to archive_url ' +
        'instead of the page URL.',
    };
  }
  // `age` was unanchored here, so "page", "image", "storage", "message" and
  // "package" all read as an age gate — a confidently wrong "this needs a cookies
  // file" on errors that had nothing to do with one. Gate words must be words.
  if (/\b(private|members?[- ]only|subscri\w*|paywall|log[- ]?in|sign[- ]?in|age[- ]?(gate|restrict\w*|verif\w*))\b/i.test(err)) {
    return {
      classification: 'gated (login / age / paywall)',
      why: `The media is behind a gate: ${err.slice(0, 200)}`,
      next_step: 'This one needs a logged-in cookies file for the site to reach the media.',
    };
  }
  return {
    classification: 'other',
    why: err.slice(0, 300),
    next_step:
      'Re-run archive_url once (transient failures self-heal on retry); if it fails again, ' +
      'use the candidates below.',
  };
}

/** Fetch the page HTML and locate likely media URLs — the "where in the source is
 *  the media" scan. Regex-based (no DOM dep); fail-soft. */
async function scan_page(pageUrl: string): Promise<z.infer<typeof CandidateSchema>[]> {
  let html = '';
  try {
    const res = await fetch(pageUrl, {
      headers: { 'User-Agent': BROWSER_UA, Accept: 'text/html,application/xhtml+xml' },
      redirect: 'follow',
      signal: AbortSignal.timeout(15000),
    });
    html = (await res.text()).slice(0, 2_000_000); // cap 2 MB
  } catch {
    return [];
  }

  const seen = new Set<string>();
  const out: z.infer<typeof CandidateSchema>[] = [];
  const push = (where: string, url: string | undefined, kind: string) => {
    if (!url) return;
    const u = url.trim().replace(/&amp;/g, '&');
    if (!/^https?:\/\//i.test(u) || seen.has(u)) return;
    seen.add(u);
    out.push({ where, url: u, kind });
  };

  const grab = (re: RegExp, where: string, kind: string) => {
    for (const m of html.matchAll(re)) push(where, m[1], kind);
  };

  grab(/<meta[^>]+property=["']og:video(?::(?:url|secure_url))?["'][^>]+content=["']([^"']+)["']/gi, 'og:video meta', 'video');
  grab(/<video[^>]+src=["']([^"']+)["']/gi, '<video src>', 'video');
  grab(/<source[^>]+src=["']([^"']+\.(?:mp4|m3u8|webm)[^"']*)["']/gi, '<source src>', 'video');
  grab(/["'](https?:\/\/[^"']+\.m3u8[^"']*)["']/gi, 'inline .m3u8 (HLS)', 'hls');
  grab(/["'](https?:\/\/[^"']+\.mp4[^"']*)["']/gi, 'inline .mp4', 'video');
  grab(/"contentUrl"\s*:\s*"([^"]+)"/gi, 'JSON-LD contentUrl', 'video');

  // Size the top few via HEAD (bounded — the "based on size" signal).
  const ranked = out
    .sort((a, b) => rank_kind(a.kind) - rank_kind(b.kind))
    .slice(0, 8);
  await Promise.all(
    ranked.slice(0, 4).map(async (c) => {
      try {
        const h = await fetch(c.url, {
          method: 'HEAD',
          headers: { 'User-Agent': BROWSER_UA },
          redirect: 'follow',
          signal: AbortSignal.timeout(8000),
        });
        const len = Number(h.headers.get('content-length'));
        if (Number.isFinite(len) && len > 0) c.bytes = len;
      } catch {
        /* size is best-effort */
      }
    }),
  );
  // Largest-first among sized candidates is the strongest "likely target" signal.
  return ranked.sort((a, b) => (b.bytes ?? 0) - (a.bytes ?? 0));
}

function rank_kind(kind: string): number {
  return kind === 'hls' ? 0 : kind === 'video' ? 1 : 2;
}

export function make_media_archive_status(): Tool<Input, Output> {
  return {
    name: 'media_archive_status',
    description:
      "Check the real status of a media download you started with archive_url, and troubleshoot a stuck/failed one. Call it whenever Jasper asks whether a download finished or why it hasn't — report the ACTUAL phase (a failed job is 'failed', never 'still downloading'). With diagnose:true on a failed job you get WHY it failed (site-block vs unsupported vs gated vs format-selection, the last one quoting the -f expression we asked for against the format table yt-dlp actually had) plus a scan of the page for the likely media (video/source tags, .m3u8/.mp4, og:video, JSON-LD) with sizes, `formats_now` — the format table yt-dlp sees on that URL right now, asked live, which is the only evidence available for a job that failed before we started recording it — and a concrete next step. No args = list your recent jobs.",
    risk: 'read',
    required_capabilities: ['manage_media_archive'],
    input_schema: InputSchema,
    output_schema: OutputSchema,

    // Read-only, but the ToolLoader's duck-type check requires this to be a
    // function or the tool is silently skipped. Key on the query so identical
    // status checks in one turn collapse.
    idempotency_key(input) {
      return `media_archive_status:${input.job_id ?? input.url ?? 'list'}:${input.diagnose ? 'dx' : ''}`;
    },

    async execute(input, ctx: ToolContext): Promise<Output> {
      const caller: Caller = {
        user_id: ctx.user?.id,
        tier: ctx.user?.tier ?? 'friend',
      };
      const store = ctx.memory.media_jobs;

      // Resolve the target job(s).
      let rows: MediaJobRow[];
      if (input.job_id) {
        const r = store.get(input.job_id);
        rows = r && (r.requested_by === caller.user_id || r.private_to == null) ? [r] : [];
      } else {
        rows = store.list_for_user(caller, { limit: input.limit ?? 8 });
        if (input.url) rows = rows.filter((r) => r.url === input.url);
      }

      const jobs = rows.map(view);

      let report: string;
      if (jobs.length === 0) {
        report = input.job_id || input.url ? 'No matching archive job found.' : 'No archive jobs yet.';
      } else {
        report = jobs
          .map((j) => {
            const base = `• ${j.url} — ${j.phase}`;
            // One bullet per job — flatten the error to a single line first, since
            // a download failure now carries a multi-line format table underneath
            // its verdict line (the whole table is in `diagnosis`, not here).
            const one_line = j.error?.split('\n')[0]?.trim() ?? '';
            return j.status === 'failed' && one_line ? `${base} (${one_line.slice(0, 160)})` : base;
          })
          .join('\n');
      }

      const out: Output = { jobs, report };

      // Diagnose the first failed/stuck job when asked.
      if (input.diagnose) {
        const target =
          rows.find((r) => r.status === 'failed') ??
          rows.find((r) => r.status !== 'done' && r.status !== 'cancelled') ??
          rows[0];
        if (target) {
          const err = target.error ?? 'no error recorded (may still be running)';
          const cls = classify_error(err);
          // Both live reads answer "what is actually there", from the two angles
          // that disagree in different ways — the page's own HTML, and what the
          // extractor makes of it. Independent and both fail-soft, so run them
          // together rather than paying for one after the other.
          const [candidates, formats_now] = await Promise.all([
            target.status === 'done' ? Promise.resolve([]) : scan_page(target.url),
            target.status === 'done' ? Promise.resolve(null) : list_formats(target.url),
          ]);
          out.diagnosis = {
            job_id: target.id,
            why: cls.why,
            classification: cls.classification,
            candidates,
            formats_now,
            next_step:
              candidates.length > 0
                ? `${cls.next_step} Likely media on the page: ${candidates
                    .slice(0, 3)
                    .map((c) => `${c.kind}${c.bytes ? ` ~${(c.bytes / 1e6).toFixed(1)}MB` : ''} (${c.where})`)
                    .join('; ')}.`
                : cls.next_step,
          };
        }
      }

      return out;
    },
  };
}

export function create(_deps: ToolDeps): Tool {
  return make_media_archive_status() as Tool;
}
