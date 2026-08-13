/**
 * extract_meeting_votes — Ruby's FOCUSED roll-call extractor (the Kristi
 * acquire-pattern applied to council minutes).
 *
 * The voting record only grows when someone actually reads the minutes,
 * and the discretionary deliberation pass proved unreliable at that — a
 * flaky fetch or a busy news morning starves the deep agenda read and the
 * `civic_votes` ledger stays thin. This fuses discovery + extraction into
 * ONE bounded pass that can't spiral:
 *
 *   1. discover official minutes/agenda documents (an explicit `url`, or
 *      search-first via SearXNG restricted to OFFICIAL government hosts —
 *      citygov.com / pleasantville.gov / the MuniCode portal). The official-
 *      host floor is enforced IN CODE: roll-call votes enter the record
 *      only from the government document, never from reporting. News can
 *      prompt a look; the minutes are the record.
 *   2. fetch each document once (Firecrawl → the workstation browser fallback),
 *      file the SAME markdown onto Ruby's shelf (no second fetch) so
 *      search_library can cite it later;
 *   3. ONE bounded LLM call lifts per-item roll calls
 *      ({item, outcome, votes[{member, vote}]}), and `apply_vote_rows`
 *      records them through the SAME MemoryClient writes — and the SAME
 *      dedup keys — as the manual record_civic_vote / upsert_civic_member
 *      tools, so hand-recorded and extracted votes converge on one row.
 *
 * Scheduled as a nightly background job (input {}); also directly
 * invocable with a `url` when Ruby is reading a specific meeting.
 */
import { z } from 'zod';
import type { Tool, ToolContext } from '@core/tool';
import type { ToolDeps } from '@core/tool_deps';
import type { MemoryClient } from '@memory/client';
import { make_ingest_to_library } from '@connectors/ingest_to_library';
import { fetch_document, type FetchDocSeams } from '@core/research_fetch';
import { convert } from '@inbox/pipeline';
import { parse_rows_tolerant } from '@specialists/kristi/tools/_json_rows';
import { is_official_civic_host , is_plausible_member_name } from '../civic_analysis';
import {
  best_vote_document,
  chunk_for_extraction,
  discover_recent_meetings,
  merge_extracted_rows,
  parse_roll_call_roster,
  resolve_meeting_documents,
  type PageFetch,
  type RollCallMember,
} from '../civic_meeting_docs';
import type { list_meetings } from '../civic_meetings_api';
import { get_ruby_civic_store } from '@memory/stores/ruby_civic';

const DEFAULT_MAX_DOCS = 2;
/** Council meets weekly-ish; 45 days covers a gap plus the minutes-approval lag. */
const DEFAULT_WITHIN_DAYS = 45;
const DEFAULT_MIN_INTERVAL_HOURS = 20; // a daily run skips a same-day re-read
const MAX_EXTRACT_CHARS = 26_000;

const VOTE_VALUES = new Set(['aye', 'nay', 'abstain', 'absent', 'recused']);

const InputSchema = z
  .object({
    url: z
      .string()
      .url()
      .optional()
      .describe('A specific agenda/minutes document to read. MUST be an official government host (citygov.com / pleasantville.gov / municodemeetings.com).'),
    meeting_id: z.string().max(40).optional(),
    meeting_date: z.string().max(20).optional(),
    within_days: z
      .number()
      .int()
      .min(1)
      .max(180)
      .default(DEFAULT_WITHIN_DAYS)
      .describe('How far back to look for meetings that have already happened (auto mode only).'),
    group_contains: z
      .string()
      .max(80)
      .default('council')
      .describe("Meeting body to read, matched against the portal's group name (auto mode only)."),
    max_docs: z.number().int().min(1).max(4).default(DEFAULT_MAX_DOCS),
    force: z.boolean().default(false).describe('Re-read a document fetched recently.'),
  })
  .strict();
type Input = z.infer<typeof InputSchema>;

const OutputSchema = z.object({
  ok: z.boolean(),
  docs_fetched: z.number(),
  items_found: z.number(),
  votes_recorded: z.number(),
  members_added: z.number(),
  /** Rows the validator refused (bad vote value, unusable member/item). */
  skipped: z.number(),
  failed: z.array(z.object({ url: z.string(), error: z.string() })),
  error: z.string().optional(),
  recovery_hint: z.string().optional(),
});
type Output = z.infer<typeof OutputSchema>;

/** Mirrors record_civic_vote's local slug so both writers converge on the
 *  same dedup key for the same vote. */
function vote_slug(s: string, max = 60): string {
  return s.toLowerCase().trim().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '').slice(0, max);
}

/** Mirrors upsert_civic_member's member_key — normalized name, NOT a slug. */
function member_key(name: string): string {
  return name.toLowerCase().trim().replace(/\s+/g, ' ');
}

const EXTRACTION_INSTRUCTION =
  'You are a municipal-minutes VOTE extractor. From the provided official meeting document, ' +
  'extract every agenda item that has an ACTUAL RECORDED VOTE. Reply with ONLY a JSON array ' +
  '(no prose, no fence). Each element:\n' +
  '{"item_title":"<the agenda item as written, e.g. \\"Ordinance 067, 2026 — Inclusionary Housing amendments, Second Reading\\">",' +
  '"outcome":"<as written, e.g. \\"adopted 5-2\\" or \\"failed 3-4\\">",' +
  '"meeting_date":"<YYYY-MM-DD if the document states it, else empty>",' +
  '"votes":[{"member":"<full council member name>","vote":"aye|nay|abstain|absent|recused"}]}\n\n' +
  'DISCIPLINE — this feeds a citable voting record:\n' +
  '- Attribute a vote to a member ONLY when the document supports it: a named roll call; a named ' +
  'dissent ("passed 6-1, Councilmember X dissenting") where the rest of the members the document ' +
  'lists as present voted the prevailing side; or a unanimous result attributed to exactly the ' +
  'members the document lists as present and voting.\n' +
  '- Members absent or recused per the document get "absent"/"recused", never an inferred vote.\n' +
  '- Skip items with no vote (presentations, staff reports, discussion-only work-session items).\n' +
  '- NEVER invent a member name, a vote, or an outcome not printed in the document.';

export interface VoteRowsResult {
  items_found: number;
  votes_recorded: number;
  members_added: number;
  skipped: number;
}

/**
 * Validate + record extracted roll-call rows. Exported pure-of-network so
 * the smoke can pin the convergence contract (same dedup keys as the
 * manual tools) without a live LLM or fetch.
 */
export function apply_vote_rows(
  rows: Array<Record<string, unknown>>,
  opts: {
    memory: MemoryClient;
    user_id: string;
    source_url: string;
    fallback_meeting_id?: string;
    fallback_meeting_date?: string;
  },
): VoteRowsResult {
  const result: VoteRowsResult = { items_found: 0, votes_recorded: 0, members_added: 0, skipped: 0 };
  const roster = new Map<string, { id: string; name: string }>(
    opts.memory.list_civic_members(opts.user_id, false).map((m) => [member_key(m.name), { id: m.id, name: m.name }]),
  );

  for (const row of rows) {
    const item_title = String(row.item_title ?? '').trim().slice(0, 300);
    const votes = Array.isArray(row.votes) ? (row.votes as Array<Record<string, unknown>>) : [];
    if (!item_title || votes.length === 0) {
      result.skipped++;
      continue;
    }
    result.items_found++;
    const meeting_date =
      (String(row.meeting_date ?? '').match(/^\d{4}-\d{2}-\d{2}/)?.[0] ?? opts.fallback_meeting_date) || undefined;
    const outcome = String(row.outcome ?? '').trim().slice(0, 200) || undefined;

    for (const v of votes) {
      const member_name = String(v.member ?? '').trim().replace(/\s+/g, ' ').slice(0, 120);
      const vote = String(v.vote ?? '').trim().toLowerCase();
      // A usable member name has letters, isn't a sentence fragment, and is a
      // PERSON rather than a role heading. The heading check is what was
      // missing: "Councilmember" and "City Council" both cleared the old
      // filter and became roster rows with 2 votes attached, which is why
      // member_dossier came back empty for a real councilmember.
      if (
        member_name.length < 2 ||
        member_name.length > 80 ||
        !/[a-z]/i.test(member_name) ||
        !is_plausible_member_name(member_name) ||
        !VOTE_VALUES.has(vote)
      ) {
        result.skipped++;
        continue;
      }
      let member = roster.get(member_key(member_name));
      if (!member) {
        // Same dedup convention as the upsert_civic_member tool, so a later
        // manual upsert refreshes this row instead of forking a duplicate.
        const id = opts.memory.upsert_civic_member({
          user_id: opts.user_id,
          name: member_name,
          role: null,
          district: null,
          term: null,
          active: true,
          notes: null,
          source_url: opts.source_url,
          dedup_key: member_key(member_name),
        });
        member = { id, name: member_name };
        roster.set(member_key(member_name), member);
        result.members_added++;
      }
      // Same dedup convention as the record_civic_vote tool.
      const dedup_key = `vote:${vote_slug(member_name, 30)}:${opts.fallback_meeting_id ?? meeting_date ?? 'na'}:${vote_slug(item_title, 60)}`;
      opts.memory.record_civic_vote({
        user_id: opts.user_id,
        member_id: member.id ?? null,
        member_name,
        meeting_id: opts.fallback_meeting_id ?? null,
        meeting_date: meeting_date ?? null,
        item_title,
        vote: vote as 'aye' | 'nay' | 'abstain' | 'absent' | 'recused',
        outcome: outcome ?? null,
        source_url: opts.source_url,
        dedup_key,
      });
      result.votes_recorded++;
    }
  }
  return result;
}

/**
 * Record the meeting's attendance roll call as roster rows.
 *
 * The roll call is the ONLY place the document states who the members are;
 * everywhere else they appear mid-sentence ("Councilmember Barrett
 * dissenting"), which is how a heading like "Councilmember" became a roster
 * row with votes attached. Seeding from the roll call means the roster is
 * built from a list of people rather than reconstructed from prose.
 *
 * Idempotent via the same `member_key` dedup the manual `upsert_civic_member`
 * uses, so re-reading a meeting refreshes rather than forks. Returns the
 * number of members NEWLY added.
 */
export function seed_roster_from_roll_call(
  roster: readonly RollCallMember[],
  opts: { memory: MemoryClient; user_id: string; source_url: string },
): number {
  if (roster.length === 0) return 0;
  const known = new Set(
    opts.memory.list_civic_members(opts.user_id, false).map((m) => member_key(m.name)),
  );
  let added = 0;
  for (const r of roster) {
    // The same person gate the vote path uses — a title that survived the
    // split must not become a member.
    if (!is_plausible_member_name(r.name)) continue;
    const key = member_key(r.name);
    if (known.has(key)) continue;
    opts.memory.upsert_civic_member({
      user_id: opts.user_id,
      name: r.name,
      role: r.role,
      district: null,
      term: null,
      active: true,
      notes: null,
      source_url: opts.source_url,
      dedup_key: key,
    });
    known.add(key);
    added++;
  }
  return added;
}

/** Test seams — the smoke injects these so no network is touched. */
export interface ExtractVotesSeams {
  list_fn?: typeof list_meetings;
  fetch_page?: PageFetch;
  fetch_seams?: FetchDocSeams;
}

export function create(deps: ToolDeps, seams: ExtractVotesSeams = {}): Tool<Input, Output> {
  const deps_list_fn = seams.list_fn;
  const page_fetch = seams.fetch_page;
  const fetch_seams: FetchDocSeams = seams.fetch_seams ?? {};
  const ingest = make_ingest_to_library({
    library_deps: {
      db: deps.db,
      vault_root: deps.vault_root,
      memory: deps.memory,
      specialists: deps.specialists,
      runtime: deps.runtime,
      conversations: deps.conversations,
      llm: deps.llm,
      events: deps.events,
      embedder: deps.embedder,
    },
    specialists: deps.specialists,
    users: deps.users,
  });

  return {
    name: 'extract_meeting_votes',
    description:
      "Read official Pleasantville council minutes/agenda documents and record every roll-call vote into the structured voting ledger (civic_votes) with the document as source_url — one bounded extraction pass, can't spiral. Pass `url` to read a specific document (official government hosts ONLY — citygov.com / pleasantville.gov / municodemeetings.com; the floor is enforced); omit it to search-discover recent minutes. Also runs nightly as a background job. Idempotent with record_civic_vote, so re-reading minutes refreshes rather than duplicates.",
    risk: 'write_internal',
    required_capabilities: ['query_web', 'browse_web', 'write_vault_general', 'write_vault_any_library'],
    weight: 'heavy',
    input_schema: InputSchema,
    output_schema: OutputSchema,
    // Yield contract (2026-08-01). This tool IS the documented exemplar of the
    // zero-output class: it ran 59 times over two months, fetched 82 documents,
    // recorded 3 votes, and returned ok:true every run while every detector
    // called it healthy. Declaring the contract is what arms
    // scan_capability_yield to escalate on it — a convention-read zero is only
    // ever reported, because a detector's correct output is also zero.
    // `votes_recorded` is the point of the tool; `docs_fetched` proves work
    // arrived, which is what separates barren from honestly idle.
    yield: { produced: ['votes_recorded', 'members_added'], considered: ['docs_fetched'] },

    idempotency_key(input) {
      const hour = new Date().toISOString().slice(0, 13);
      return `extract_meeting_votes:${input.url ?? `auto:${input.group_contains}:${input.within_days}`}:${hour}`;
    },

    async execute(input, ctx: ToolContext): Promise<Output> {
      const store = get_ruby_civic_store();
      const user_id = ctx.user?.id ?? process.env.HEARTH_OWNER_USER_ID ?? 'jasper';
      const min_ms = DEFAULT_MIN_INTERVAL_HOURS * 3_600_000;
      const now = Date.now();
      const failed: Output['failed'] = [];

      // ── 1. discover document URLs ─────────────────────────────────────────
      // Discovery walks the portal's own meeting list, NOT a web search. A
      // search returns whatever it indexed with no relation to recency: the
      // live 07-30 and 07-31 runs both read the meeting of October 17, 2023,
      // which is why 59 runs produced 3 votes while reporting success. The
      // API knows which meeting happened most recently; ask it.
      let urls: string[] = [];
      const meeting_of = new Map<string, { meeting_id: string; day: string }>();
      if (input.url) {
        if (!is_official_civic_host(input.url)) {
          return {
            ok: false,
            docs_fetched: 0, items_found: 0, votes_recorded: 0, members_added: 0, skipped: 0,
            failed,
            error: `votes enter the record only from official government documents; ${new URL(input.url).hostname} is not one`,
            recovery_hint:
              'Find the meeting on https://pleasantville-co.municodemeetings.com or citygov.com/cityclerk and pass that agenda/minutes URL. If the claim came from reporting, record the story via record_watch_event and verify the vote in the minutes.',
          };
        }
        urls = [input.url];
      } else {
        const found = await discover_recent_meetings({
          now: new Date(now),
          within_days: input.within_days,
          group_contains: input.group_contains,
          ...(deps_list_fn ? { list_fn: deps_list_fn } : {}),
        });
        if (!found.ok) {
          failed.push({ url: 'municode:meeting/list', error: found.error ?? 'meeting API unavailable' });
        }
        for (const m of found.meetings) {
          if (urls.length >= input.max_docs) break;
          // Resolve MeetingID → page → the document that can carry a vote.
          // An agenda-only meeting yields null: the meeting either hasn't
          // happened or its minutes aren't approved, and reading a
          // pre-meeting agenda for votes is how fabrications start.
          const resolved = await resolve_meeting_documents(m.meeting_id, {
            ...(page_fetch ? { fetch_page: page_fetch } : {}),
          });
          if (!resolved.ok) {
            failed.push({ url: `municode:node/${m.meeting_id}`, error: resolved.error ?? 'unresolved' });
            continue;
          }
          const doc = best_vote_document(resolved.documents);
          if (!doc) continue;
          if (!is_official_civic_host(doc.url)) continue;
          if (!input.force) {
            const prior = store.get_source_sync(doc.url);
            if (prior && now - Date.parse(prior.synced_at) < min_ms) continue;
          }
          meeting_of.set(doc.url, { meeting_id: m.meeting_id, day: m.day });
          urls.push(doc.url);
        }
      }

      if (urls.length === 0) {
        return {
          ok: true,
          docs_fetched: 0, items_found: 0, votes_recorded: 0, members_added: 0, skipped: 0,
          failed,
          recovery_hint:
            failed.length > 0
              ? 'The meeting portal did not answer. Retry later, or pass an explicit `url` to a minutes/action-agenda document on pleasantville-co.municodemeetings.com.'
              : 'Every recent meeting is already read, or has published only a pre-meeting agenda (minutes are approved at a later meeting, so the newest meeting often has none yet). Retry with force:true to re-read, or widen within_days.',
        };
      }

      // ── 2 + 3. fetch each doc, extract once, record ───────────────────────
      let docs_fetched = 0;
      const totals: VoteRowsResult = { items_found: 0, votes_recorded: 0, members_added: 0, skipped: 0 };
      for (const url of urls) {
        let markdown: string;
        try {
          // The record is a PDF (`2026-06-16_minutes.pdf`), so this rides the
          // binary-aware fetcher, not the page fetcher. A page-only fetch is
          // why the old path could only ever see the index page's links.
          const fetched = await fetch_document(fetch_seams, ctx, url);
          if (fetched.kind === 'document') {
            const converted = await convert({
              filename: fetched.filename,
              mime_type: fetched.mime,
              bytes: fetched.bytes,
            });
            markdown = converted.markdown_body;
          } else if (fetched.kind === 'markdown') {
            markdown = fetched.markdown;
          } else {
            failed.push({ url, error: `${fetched.kind}: ${fetched.reason}` });
            continue;
          }
          if (markdown.trim().length < 200) {
            failed.push({ url, error: 'document produced almost no text (scanned image PDF?)' });
            continue;
          }
          store.record_source_sync(url, { content_hash: null });
          // File the SAME markdown onto Ruby's shelf so search_library can
          // cite the minutes later (best-effort; never blocks extraction).
          try {
            await ingest.execute(
              { target_specialist_id: 'ruby', markdown: markdown.slice(0, 200_000), title_hint: `Council minutes — ${url}` },
              ctx,
            );
          } catch {
            /* shelf-filing is non-critical */
          }
        } catch (err) {
          failed.push({ url, error: err instanceof Error ? err.message : String(err) });
          continue;
        }
        docs_fetched++;

        // The minutes open with the attendance roll call — the authoritative
        // roster, and the reason `civic_members` holds two scraped headings
        // instead of seven people. Seed it BEFORE extraction so the roll-call
        // names are already known when votes resolve against them.
        const roster = parse_roll_call_roster(markdown);
        const roster_added = seed_roster_from_roll_call(roster, {
          memory: ctx.memory,
          user_id,
          source_url: url,
        });
        totals.members_added += roster_added;

        // The roll call sits at the TOP of the document but attribution is
        // needed in every window, so the roster preamble rides each one.
        const preamble =
          roster.length > 0
            ? `MEMBERS PRESENT per this document's roll call: ${roster
                .filter((r) => r.present)
                .map((r) => r.name)
                .join(', ')}.\n` +
              `MEMBERS ABSENT: ${
                roster.filter((r) => !r.present).map((r) => r.name).join(', ') || 'none stated'
              }.\n` +
              'Use these EXACT names when attributing a vote; never a title alone.\n\n'
            : '';

        try {
          const role = deps.llm.for_role('research_extract');
          // Windowed, not truncated. A single 26k window over the 42k
          // 2026-06-16 minutes kept 1 of 5 motions and dropped the only
          // contested one — see chunk_for_extraction's note.
          const windows = chunk_for_extraction(markdown, { size: MAX_EXTRACT_CHARS });
          const batches: Array<Array<Record<string, unknown>>> = [];
          for (const [i, window] of windows.entries()) {
            const resp = await role.provider.complete({
              messages: [
                { role: 'system', content: EXTRACTION_INSTRUCTION },
                {
                  role: 'user',
                  content:
                    preamble +
                    (windows.length > 1
                      ? `NOTE: this is part ${i + 1} of ${windows.length} of the document. Extract only what THIS part records; parts overlap, so a repeated item is expected.\n\n`
                      : '') +
                    `DOCUMENT (${url}):\n${window}`,
                },
              ],
              max_tokens: 4096,
              think: false,
            });
            batches.push(parse_rows_tolerant(resp.content));
          }
          const rows = merge_extracted_rows(batches);
          const meeting_ref = meeting_of.get(url);
          const applied = apply_vote_rows(rows, {
            memory: ctx.memory,
            user_id,
            source_url: url,
            ...(input.meeting_id ?? meeting_ref?.meeting_id
              ? { fallback_meeting_id: input.meeting_id ?? meeting_ref!.meeting_id }
              : {}),
            ...(input.meeting_date ?? meeting_ref?.day
              ? { fallback_meeting_date: input.meeting_date ?? meeting_ref!.day }
              : {}),
          });
          totals.items_found += applied.items_found;
          totals.votes_recorded += applied.votes_recorded;
          totals.members_added += applied.members_added;
          totals.skipped += applied.skipped;
        } catch (err) {
          failed.push({ url, error: `extraction: ${err instanceof Error ? err.message : String(err)}` });
        }
      }

      ctx.memory.log_action({
        intent_id: ctx.intent_id,
        agent: ctx.specialist_id ?? 'ruby',
        tool_name: 'extract_meeting_votes',
        tool_input: {
          url: input.url,
          group_contains: input.group_contains,
          within_days: input.within_days,
          max_docs: input.max_docs,
        },
        execution_result: { ok: true, docs_fetched, ...totals, failed_n: failed.length },
      });
      return { ok: true, docs_fetched, ...totals, failed };
    },
  };
}
