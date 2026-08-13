/**
 * Ruby (#1) — discover Pleasantville council/board meetings from the city's
 * public MuniCode Meetings API, structured. Replaces blind HTML scraping of
 * the agendas page. Discovery only: agenda-item + vote detail aren't in the
 * API, so Ruby opens the agenda/minutes doc for those and records votes via
 * record_civic_vote.
 */
import { z } from 'zod';
import type { Tool, ToolContext } from '@core/tool';
import { list_meetings, type CivicMeeting } from '../civic_meetings_api';

const InputSchema = z
  .object({
    group_contains: z.string().max(80).default('council'),
    within_days: z.number().int().min(1).max(120).default(45),
    limit: z.number().int().min(1).max(50).default(20),
  })
  .strict();

const MeetingOut = z.object({
  meeting_id: z.string(),
  title: z.string(),
  group: z.string().nullable(),
  date: z.string().nullable(),
  summary: z.string().nullable(),
  when: z.enum(['upcoming', 'recent', 'undated']),
});

const OutputSchema = z.object({
  ok: z.boolean(),
  meetings: z.array(MeetingOut),
  error: z.string().optional(),
  note: z.string().optional(),
});

type Input = z.infer<typeof InputSchema>;
type Output = z.infer<typeof OutputSchema>;

export const fetch_council_meetings: Tool<Input, Output> = {
  name: 'fetch_council_meetings',
  description:
    "Discover Pleasantville council/board meetings from the city's public MuniCode Meetings API (structured: title, body, date, revision). Defaults to City Council; pass group_contains to target a board/commission (e.g. 'Planning and Zoning'). Returns upcoming + recent meetings within within_days. This is meeting DISCOVERY — agenda-item and vote detail are NOT in the API; open the agenda/minutes document for those, then record votes with record_civic_vote (which requires the document URL).",
  risk: 'read',
  required_capabilities: ['query_web'],
  input_schema: InputSchema,
  output_schema: OutputSchema,

  idempotency_key(input) {
    return `fetch_council_meetings:${input.group_contains}:${input.within_days}`;
  },

  async execute(input, _ctx: ToolContext): Promise<Output> {
    const res = await list_meetings({ group_contains: input.group_contains });
    if (!res.ok) {
      return {
        ok: false,
        meetings: [],
        error: res.error ?? 'meeting API unavailable',
        note: 'Fall back to browse_url on https://pleasantville-co.municodemeetings.com (the same MuniCode portal, human-readable) if this persists.',
      };
    }
    const now = Date.now();
    const horizon = input.within_days * 86_400_000;
    const keep = (m: CivicMeeting): boolean => {
      if (!m.date) return true; // undated/TBD meetings are real, just unscheduled
      const t = Date.parse(m.date);
      return Number.isNaN(t) || Math.abs(t - now) <= horizon;
    };
    const when = (m: CivicMeeting): 'upcoming' | 'recent' | 'undated' => {
      if (!m.date) return 'undated';
      const t = Date.parse(m.date);
      if (Number.isNaN(t)) return 'undated';
      return t >= now ? 'upcoming' : 'recent';
    };
    const rows = res.meetings.filter(keep).map((m) => ({
      meeting_id: m.meeting_id,
      title: m.title,
      group: m.group,
      date: m.date,
      summary: m.summary,
      when: when(m),
    }));
    const rank = (w: string) => (w === 'upcoming' ? 0 : w === 'recent' ? 1 : 2);
    rows.sort((a, b) => {
      const r = rank(a.when) - rank(b.when);
      if (r !== 0) return r;
      if (!a.date || !b.date) return 0;
      // upcoming: soonest first; recent: newest first.
      return a.when === 'upcoming' ? a.date.localeCompare(b.date) : b.date.localeCompare(a.date);
    });
    return { ok: true, meetings: rows.slice(0, input.limit) };
  },
};
