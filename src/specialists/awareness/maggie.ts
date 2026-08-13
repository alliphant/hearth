/**
 * Maggie's awareness handler.
 *
 * Watches the audit_log for fresh Tautulli plex_event rows since her
 * last run. When new plays land, returns an observation describing the
 * burst — so wake_on_flag specialists can pick it up, or the next
 * deliberation pass surfaces it.
 *
 * What this handler does NOT do: it doesn't itself decide whether a
 * play is interesting. The play has already been written to memory.md
 * by the webhook (see src/specialists/maggie/router.ts). This handler
 * just produces a structured observation so the loop driver knows
 * something happened and the deliberation context can include
 * "N new plays since the last pass."
 *
 * Severity is conservative — Maggie's whole job is "media isn't
 * urgent." Even a 5-episode binge gets `low` severity; she doesn't
 * interrupt Jasper mid-day to say "I see you finished Voyager S3 E14."
 * Aggregation across the deliberation slot is the right cadence.
 */

import type { AwarenessHandler, AwarenessHandlerDeps, AwarenessObservation } from '@core/loops';

export const maggie_awareness: AwarenessHandler = {
  specialist_id: 'maggie',
  async run(deps: AwarenessHandlerDeps): Promise<AwarenessObservation | null> {
    try {
      const now = new Date();
      const since = deps.last_run_at
        ? deps.last_run_at.toISOString()
        : new Date(now.getTime() - 60 * 60 * 1000).toISOString(); // 1h fallback on first run

      const events = deps.db
        .prepare(
          `SELECT
             tool_input,
             ts
           FROM audit_log
           WHERE ts >= @since
             AND agent = 'tautulli'
             AND tool_name = 'plex_event'
             AND error IS NULL
             AND execution_result NOT LIKE '%skipped%'
           ORDER BY ts DESC
           LIMIT 20`,
        )
        .all({ '@since': since }) as Array<{ tool_input: string; ts: string }>;

      if (events.length === 0) return null;

      // Group by media_type for the summary.
      const by_type = new Map<string, number>();
      const sample_titles: string[] = [];
      for (const e of events) {
        let parsed: { media_type?: string; title?: string; grandparent_title?: string } = {};
        try {
          parsed = JSON.parse(e.tool_input);
        } catch { /* skip */ }
        const mt = (parsed.media_type ?? 'unknown').toLowerCase();
        by_type.set(mt, (by_type.get(mt) ?? 0) + 1);
        if (sample_titles.length < 3) {
          const label =
            mt === 'episode' && parsed.grandparent_title
              ? `${parsed.grandparent_title}${parsed.title ? ` — ${parsed.title}` : ''}`
              : parsed.title ?? '';
          if (label && !sample_titles.includes(label)) sample_titles.push(label);
        }
      }
      const type_parts = [...by_type.entries()].map(([k, v]) => `${v} ${k}${v === 1 ? '' : 's'}`);
      const summary = `${events.length} new Plex play${events.length === 1 ? '' : 's'} since last pass: ${type_parts.join(' · ')}`;

      return {
        ts: now.toISOString(),
        summary,
        severity: 'low',
        details: {
          event_count: events.length,
          by_media_type: Object.fromEntries(by_type),
          sample: sample_titles,
          window_since: since,
        },
      };
    } catch (err) {
      return {
        ts: new Date().toISOString(),
        summary: 'maggie awareness handler error',
        severity: 'low',
        details: { error_message: err instanceof Error ? err.message : String(err) },
      };
    }
  },
};
