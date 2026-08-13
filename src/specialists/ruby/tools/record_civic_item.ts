/**
 * Ruby — record a civic finding into the structured `civic_items` store
 * that backs her `civic` office pane.
 *
 * Ruby's deliberation passes (06:30 / 17:00 + Sunday deep-builds) sweep
 * citygov.com, r/Pleasantville, the Herald, etc. Free-form notes still go
 * to memory.md; the items she wants the office to surface get captured
 * here so the pane reads them with cheap SQL and ranks by interest_score.
 *
 * Idempotent per (user, dedup_key) — re-capturing the same agenda item
 * across passes refreshes it rather than duplicating. When the item
 * carries coordinates (Ruby geocodes a construction / event location via
 * the maps `geocode` tool first, then passes lat/lon), the item is scored
 * against Jasper's learned location corridors: on-corridor items get their
 * interest boosted and a `corridor_match` label, which is what lets the
 * office promote "construction on a road you actually drive."
 */

import { z } from 'zod';
import { createHash } from 'node:crypto';
import type { Tool, ToolContext } from '@core/tool';
import { score_corridors } from '@core/geo';
import { EVIDENCE_READ_TOOLS, quote_in_evidence } from '../civic_analysis';

const InputSchema = z.object({
  kind: z.enum([
    'council_meeting',
    'agenda_item',
    'new_in_town',
    'corridor_alert',
    'announcement',
    'watching',
  ]),
  title: z.string().min(1).max(200),
  summary: z.string().max(2_000).optional(),
  /** ISO 8601 when the meeting / agenda / event happens, if dated. */
  event_at: z.string().max(40).optional(),
  url: z.string().url().max(500).optional(),
  /** REQUIRED for announcement / agenda_item: a verbatim sentence from the
   *  page you read THIS TURN that states the claim. The gate checks it
   *  against the turn's actual fetched content — a claim no page contains
   *  is rejected, not recorded. */
  evidence_quote: z.string().max(800).optional(),
  location_label: z.string().max(200).optional(),
  lat: z.number().min(-90).max(90).optional(),
  lon: z.number().min(-180).max(180).optional(),
  /** 0..1 — how strongly Jasper would care. Drives the at-a-glance vs.
   *  "also watching" split in the office. */
  interest_score: z.number().min(0).max(1).default(0.5),
  /** Stable key for idempotent re-capture; derived from kind+title when omitted. */
  dedup_key: z.string().min(1).max(200).optional(),
  source: z.string().max(200).optional(),
});

const OutputSchema = z.object({
  ok: z.boolean(),
  id: z.string().optional(),
  corridor_match: z.string().nullable().optional(),
  effective_interest_score: z.number().optional(),
  error: z.string().optional(),
  recovery_hint: z.string().optional(),
});

type Input = z.infer<typeof InputSchema>;
type Output = z.infer<typeof OutputSchema>;

export const record_civic_item: Tool<Input, Output> = {
  name: 'record_civic_item',
  description:
    "Record a Pleasantville civic finding (council meeting, hot agenda item, new-in-town spot, corridor traffic/construction alert, FCGOV announcement, or a lower-priority 'watching' item) into Ruby's office. For announcement and agenda_item — claims about what the city/council is doing — you MUST pass evidence_quote: a verbatim sentence from a page you read this turn stating the claim (the gate verifies it against what you actually fetched; read the source first if you haven't). Use kind 'watching' for an unconfirmed lead. Pass lat/lon (geocode the location first) for traffic/construction so it can be matched to Jasper's routes. interest_score 0..1 ranks it.",
  risk: 'write_internal',
  required_capabilities: ['write_vault_general'],
  input_schema: InputSchema,
  output_schema: OutputSchema,

  idempotency_key(input) {
    const h = createHash('sha256');
    h.update(input.dedup_key ?? `${input.kind}:${input.title.toLowerCase()}`);
    return `record_civic_item:${h.digest('hex').slice(0, 16)}`;
  },

  async execute(input, ctx: ToolContext): Promise<Output> {
    const user_id = ctx.user?.id;
    if (!user_id) {
      return {
        ok: false,
        error:
          'record_civic_item must run within a user-scoped turn (no user in context).',
      };
    }

    const dedup_key =
      input.dedup_key ??
      `${input.kind}:${input.title.toLowerCase().replace(/\s+/g, '-').slice(0, 120)}`;

    // Council MEETINGS are owned by the hourly scan_council_meetings job,
    // which writes them from the MuniCode API keyed `meeting:<id>` (the
    // authoritative feed). Hand-authoring a council_meeting here forks a
    // duplicate row under a different key — the dedup bug. Let the scan own
    // the meeting row; surface meeting DETAIL through the enrichment tools.
    if (input.kind === 'council_meeting' && !dedup_key.startsWith('meeting:')) {
      return {
        ok: false,
        error:
          'council_meeting rows are maintained by the scan_council_meetings job, not record_civic_item.',
        recovery_hint:
          'The hourly scan_council_meetings job records every Pleasantville council meeting from the MuniCode API (keyed meeting:<id>) and owns the office hero + countdown. To add DETAIL to a meeting, use record_civic_vote (a recorded vote, with its source_url) or record_watch_event (a development). If a meeting is missing from the office, run fetch_council_meetings / scan_council_meetings to pull it from the API. Use record_civic_item for the other kinds: agenda_item, new_in_town, corridor_alert, announcement, watching.',
      };
    }

    // Evidence-quote gate (2026-06-10, the StreetMedia fabrication class):
    // announcement / agenda_item are CLAIMS about what the city/council is
    // doing, and the reply-side critics never see tool arguments — so the
    // claim must trace, HERE, to something this turn actually read. The
    // quote is checked against the turn's audited read results (the audit
    // log stores every fetch verbatim; no re-fetch needed). Intake- and
    // scan-written items call the MemoryClient directly with their own
    // provenance (the photographed artifact, the MuniCode feed) and never
    // hit this gate.
    if (input.kind === 'announcement' || input.kind === 'agenda_item') {
      const quote = (input.evidence_quote ?? '').trim();
      if (quote.length < 12) {
        return {
          ok: false,
          error: `kind '${input.kind}' asserts a civic fact and requires evidence_quote — a verbatim sentence from the page that states it.`,
          recovery_hint:
            "Quote the exact sentence from the page you read this turn (web_fetch_clean / browse_url / fetch_council_meetings / search_library) that states this claim, and re-record with it as evidence_quote. If you haven't read a source for this claim this turn, fetch it first — or record it as kind 'watching' (an unconfirmed lead) instead.",
        };
      }
      const evidence = ctx.memory.audit_evidence_for_intent(ctx.intent_id, EVIDENCE_READ_TOOLS);
      if (evidence.length === 0) {
        return {
          ok: false,
          error: 'no source was read this turn, so the claim cannot be verified.',
          recovery_hint:
            "Fetch the source first (web_fetch_clean the page you're citing), then re-record with evidence_quote — or use kind 'watching' for an unconfirmed lead.",
        };
      }
      if (!quote_in_evidence(quote, evidence)) {
        return {
          ok: false,
          error: 'evidence_quote does not appear in anything read this turn — the claim is unverified.',
          recovery_hint:
            "The quote must be VERBATIM from a page you actually fetched this turn — copy the exact sentence, don't paraphrase. If no page states this claim, it doesn't go in the office as fact: record it as kind 'watching' or drop it.",
        };
      }
    }

    // Corridor-affinity: when the item is geolocated, score it against
    // Jasper's learned corridors. On-corridor items are promoted (the
    // music-affinity pattern applied to geography).
    let corridor_match: string | null = null;
    let effective = input.interest_score;
    if (input.lat != null && input.lon != null) {
      const corridors = ctx.memory.list_location_corridors(user_id);
      const match = score_corridors(input.lat, input.lon, corridors);
      if (match) {
        corridor_match = match.label;
        effective = Math.min(1, input.interest_score + 0.25 * match.affinity);
      }
    }

    const id = ctx.memory.record_civic_item({
      user_id,
      kind: input.kind,
      title: input.title,
      summary: input.summary ?? null,
      event_at: input.event_at ?? null,
      url: input.url ?? null,
      location_label: input.location_label ?? null,
      lat: input.lat ?? null,
      lon: input.lon ?? null,
      corridor_match,
      interest_score: effective,
      dedup_key,
      source: input.source ?? null,
    });

    ctx.memory.log_action({
      intent_id: ctx.intent_id,
      agent: 'ruby',
      tool_name: 'record_civic_item',
      tool_input: { kind: input.kind, title: input.title, has_coords: input.lat != null },
      execution_result: { id, corridor_match, effective_interest_score: effective },
      user_id,
    });

    return { ok: true, id, corridor_match, effective_interest_score: effective };
  },
};
