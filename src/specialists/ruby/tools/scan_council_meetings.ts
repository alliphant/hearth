/**
 * Ruby (#5) — REACTIVE meeting sweep. Pull the public meeting API and act
 * only on meetings that are NEW or whose agenda was REVISED since last seen
 * (diffed by the API's RevisionID, stashed in each council_meeting
 * civic_item's `source`). New/changed council meetings are written to the
 * City Desk office so the pane stays current; unchanged meetings are
 * skipped. Cheap + idempotent when nothing moved — meant to run often, so
 * the expensive deep-read only happens when there's actually something new.
 *
 * Runs as a background job (no user in ctx) — resolves the owner from
 * HEARTH_OWNER_USER_ID, matching the deliberation brief-user fallback.
 */
import { z } from 'zod';
import type { Tool, ToolContext } from '@core/tool';
import { local_iso_date } from '@core/time';
import { list_meetings } from '../civic_meetings_api';

const InputSchema = z
  .object({
    group_contains: z.string().max(80).default('council'),
    /**
     * URL-rot probe (2026-08-05). Config-supplied URLs (the job input in
     * ruby.yaml carries the list — the hardcoded fallbacks her prompts
     * name) are HEAD-probed each scan; a failing one is recorded as a
     * DATED `watching` item in her own office, so rot self-surfaces on
     * the board instead of silently arming the fabrication guard every
     * pass (the 2026-08-05 Herald `/news/local/` 404 blocked 12
     * record_civic_item calls in one day before anyone looked). Dated
     * items age out 2 days after the last failing probe, so recovery
     * self-cleans via the nightly expiry sweep.
     */
    probe_urls: z.array(z.string().url().max(500)).max(10).default([]),
  })
  .strict();

const Changed = z.object({
  meeting_id: z.string(),
  title: z.string(),
  date: z.string().nullable(),
});

const OutputSchema = z.object({
  ok: z.boolean(),
  new_meetings: z.array(Changed),
  changed_meetings: z.array(Changed),
  unchanged: z.number(),
  /** probe_urls results — present only when probes were requested. */
  url_probes: z
    .array(z.object({ url: z.string(), ok: z.boolean(), status: z.number().nullable() }))
    .optional(),
  error: z.string().optional(),
});

type Input = z.infer<typeof InputSchema>;
type Output = z.infer<typeof OutputSchema>;

const STALE_MS = 30 * 86_400_000; // don't backfill meetings older than 30d

export const scan_council_meetings: Tool<Input, Output> = {
  name: 'scan_council_meetings',
  description:
    "Reactive sweep of Pleasantville meetings: pull the public meeting API and record only meetings that are NEW or whose agenda was REVISED since last seen (diffed by RevisionID). New/changed council meetings land in the City Desk office (civic_items) so the pane stays current without redoing work each pass. Returns what changed — a non-empty new/changed list is the signal to open the agenda and record votes. Safe to run frequently; does nothing when nothing changed.",
  risk: 'write_internal',
  required_capabilities: ['write_vault_general'],
  input_schema: InputSchema,
  output_schema: OutputSchema,

  // Reporting-only: the fields are authoritative, but records only meetings not seen before; the council does not post new agendas most days.
  yield: { produced: ['new_meetings', 'changed_meetings'], armed: false },
  idempotency_key() {
    return 'scan_council_meetings:singleton';
  },

  async execute(input, ctx: ToolContext): Promise<Output> {
    const user_id = ctx.user?.id ?? process.env.HEARTH_OWNER_USER_ID ?? 'jasper';

    // URL-rot probes run FIRST and independently — a meeting-API outage must
    // not skip them (they exist to catch exactly that class of quiet rot).
    let url_probes: Array<{ url: string; ok: boolean; status: number | null }> | undefined;
    if (input.probe_urls.length > 0) {
      url_probes = [];
      for (const url of input.probe_urls) {
        let status: number | null = null;
        let probe_ok = false;
        try {
          let resp = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(10_000) });
          // Some hosts reject HEAD outright; a 405/501 says "ask differently",
          // not "the page is gone" — retry as a real GET before judging.
          if (resp.status === 405 || resp.status === 501) {
            resp = await fetch(url, { method: 'GET', signal: AbortSignal.timeout(10_000) });
          }
          status = resp.status;
          // 401/403/429 are BOT WALLS, not rot — the herald legitimately
          // blocks datacenter HEADs while serving the logged-in browser host
          // fine. Rot is "this page no longer exists": 404/410 and 5xx.
          probe_ok = resp.status < 400 || [401, 403, 429].includes(resp.status);
        } catch {
          probe_ok = false; // network error / timeout — status stays null
        }
        url_probes.push({ url, ok: probe_ok, status });
        if (!probe_ok) {
          const today = local_iso_date();
          ctx.memory.record_civic_item({
            user_id,
            kind: 'watching',
            title: `Config URL failing: ${url}`,
            summary:
              `Automated probe got ${status === null ? 'a network error/timeout' : `HTTP ${status}`} ` +
              `on ${today}. This URL is named in Ruby's config/prompts — a dead source silently ` +
              `arms the fabrication guard for the rest of any pass that fetches it. ` +
              `Find the successor URL and update the config, or drop the source.`,
            event_at: today,
            url,
            interest_score: 0.55,
            dedup_key: `urlrot:${url}`,
            source: 'scan_council_meetings:url_probe',
          });
        }
      }
    }

    const res = await list_meetings({ group_contains: input.group_contains });
    if (!res.ok) {
      return {
        ok: false,
        new_meetings: [],
        changed_meetings: [],
        unchanged: 0,
        ...(url_probes ? { url_probes } : {}),
        error: res.error,
      };
    }

    // What we've already recorded: council_meeting civic_items keyed
    // 'meeting:<id>', with the last-seen RevisionID stashed in `source`.
    const seen = new Map<string, string | null>();
    for (const it of ctx.memory.list_civic_items(user_id)) {
      if (it.kind === 'council_meeting' && it.dedup_key.startsWith('meeting:')) {
        seen.set(it.dedup_key.slice('meeting:'.length), it.source);
      }
    }

    const now = Date.now();
    const new_meetings: Array<z.infer<typeof Changed>> = [];
    const changed_meetings: Array<z.infer<typeof Changed>> = [];
    let unchanged = 0;

    for (const m of res.meetings) {
      if (m.date) {
        const t = Date.parse(m.date);
        if (!Number.isNaN(t) && t < now - STALE_MS) continue; // skip old historicals
      }
      const known = seen.has(m.meeting_id);
      const is_new = !known;
      const is_changed = known && (seen.get(m.meeting_id) ?? null) !== (m.revision_id ?? null);
      if (!is_new && !is_changed) {
        unchanged++;
        continue;
      }
      ctx.memory.record_civic_item({
        user_id,
        kind: 'council_meeting',
        title: m.title,
        summary: m.summary,
        event_at: m.date,
        interest_score: 0.6,
        dedup_key: `meeting:${m.meeting_id}`,
        source: m.revision_id,
      });
      (is_new ? new_meetings : changed_meetings).push({
        meeting_id: m.meeting_id,
        title: m.title,
        date: m.date,
      });
    }
    return {
      ok: true,
      new_meetings,
      changed_meetings,
      unchanged,
      ...(url_probes ? { url_probes } : {}),
    };
  },
};
