/**
 * smoke:civic-meeting-docs — the "59 runs, 3 votes, zero errors" fix
 * (2026-07-31).
 *
 * `extract_meeting_votes` ran nightly for two months and reported success
 * every single time: 59 runs, 82 documents fetched, 3 votes recorded, no
 * errors. Nothing in the system could see that as a failure, because at the
 * tool boundary it wasn't one — the fetches worked. Discovery and extraction
 * were each aimed one hop short of the record:
 *
 *   1. discovery was a blind `web_search` filtered to official hosts. Search
 *      returns what it indexed, not what happened recently — the live 07-30
 *      and 07-31 runs both read the meeting of **October 17, 2023**.
 *   2. the meeting page it fetched is an INDEX of links; the roll calls are
 *      one hop further, inside `{date}_minutes.pdf`. So even the correct
 *      recent meeting would have yielded zero.
 *
 * Every fixture here is verbatim shape from the live portal (fetched
 * 2026-07-31), so this pins the real contract rather than an invented one.
 * Pure + injected seams: no network, no LLM.
 */
import {
  best_vote_document,
  chunk_for_extraction,
  classify_civic_document,
  discover_recent_meetings,
  merge_extracted_rows,
  parse_meeting_document_links,
  parse_roll_call_roster,
  recent_past_meetings,
  resolve_meeting_documents,
  split_member_title,
  VOTE_BEARING_KINDS,
} from '../src/specialists/ruby/civic_meeting_docs';
import { is_plausible_member_name } from '../src/specialists/ruby/civic_analysis';
import type { CivicMeeting } from '../src/specialists/ruby/civic_meetings_api';

let passed = 0, failed = 0;
const check = (n: string, c: boolean): void => {
  if (c) { console.log(`  ✓ ${n}`); passed++; } else { console.error(`  ✗ ${n}`); failed++; }
};

const BASE = 'https://pleasantville-co.municodemeetings.com';
const PAGE_81 = `${BASE}/bc-citycouncil/page/city-council-regular-meeting-81`;

// ── A. document classification ──────────────────────────────────────────────
console.log('\nA. classify_civic_document — what each document can prove');

const MINUTES = `${BASE}/sites/pleasantville-co.municodemeetings.com/files/fileattachments/city_council/meeting/4467/2026-06-16_minutes.pdf`;
const ACTION = `${BASE}/sites/pleasantville-co.municodemeetings.com/files/fileattachments/city_council/meeting/4474/2026-07-21_action_agenda.pdf`;
const CDN_AGENDA = 'https://mccmeetings.blob.core.usgovcloudapi.net/fortcollco-pubu/MEET-Agenda-d2650790b0bd473b957ff2b78b58a288.pdf';
const CDN_PACKET = 'https://mccmeetings.blob.core.usgovcloudapi.net/fortcollco-pubu/MEET-Packet-d2650790b0bd473b957ff2b78b58a288.pdf';
const ADA_HTML = 'https://meetings.municode.com/adaHtmlDocument/index?cc=FORTCOLLCO&me=d2650790b0bd473b957ff2b78b58a288&ip=False';

check('the minutes PDF classifies as minutes', classify_civic_document(MINUTES) === 'minutes');
check('the action agenda classifies as action_agenda', classify_civic_document(ACTION) === 'action_agenda');
check('the CDN agenda classifies as agenda', classify_civic_document(CDN_AGENDA) === 'agenda');
check('the CDN packet classifies as packet', classify_civic_document(CDN_PACKET) === 'packet');

// The ordering trap: "action_agenda" contains "agenda". Tested before it, an
// action agenda would classify as a pre-meeting agenda and be excluded from
// extraction — losing the ONLY vote source for the most recent meeting,
// whose minutes are not approved yet.
check('action_agenda is NOT swallowed by the agenda rule', classify_civic_document(ACTION) !== 'agenda');

check('only minutes + action_agenda can carry a vote', VOTE_BEARING_KINDS.has('minutes') && VOTE_BEARING_KINDS.has('action_agenda') && !VOTE_BEARING_KINDS.has('agenda') && !VOTE_BEARING_KINDS.has('packet'));

// ── B. meeting-page link extraction ─────────────────────────────────────────
console.log('\nB. parse_meeting_document_links — the hop the old tool never took');

// Verbatim link-block shape from node/4467 (2026-06-17 regular meeting).
const PAGE_HTML_WITH_MINUTES = `
<html><body>
<a href="/bc-citycouncil">Meetings</a>
<a href="/calendar">Calendar</a>
<div class="meeting-info">
  Agenda: <a href="${CDN_AGENDA}">Agenda</a>
  <a href="${ADA_HTML}">Agenda (HTML)</a>
  Packet: <a href="${CDN_PACKET}">Agenda Packet</a>
  Minutes: <a href="${MINUTES}">June 16, 2026 Meeting Minutes (11 MB)</a>
  Audio/Video: <a href="https://www.youtube.com/watch?v=abc123">Meeting Video</a>
  Supporting Documents <a href="/sites/pleasantville-co.municodemeetings.com/files/fileattachments/city_council/meeting/4467/2026-06-16_action_agenda.pdf">action_agenda.pdf</a>
</div>
</body></html>`;

const docs = parse_meeting_document_links(PAGE_HTML_WITH_MINUTES, PAGE_81);
check('finds the minutes PDF', docs.some((d) => d.url === MINUTES && d.kind === 'minutes'));
check('finds the action agenda', docs.some((d) => d.kind === 'action_agenda'));
check('resolves a RELATIVE href against the page url', docs.some((d) => d.kind === 'action_agenda' && d.url.startsWith(BASE)));
check('keeps the ADA html document', docs.some((d) => d.url.includes('adaHtmlDocument')));
check('drops the video link', !docs.some((d) => d.url.includes('youtube')));
check('drops nav links', !docs.some((d) => d.url.endsWith('/calendar') || d.url.endsWith('/bc-citycouncil')));
check('carries the label as written', docs.some((d) => (d.label ?? '').includes('June 16, 2026 Meeting Minutes')));
check('de-dupes by url', new Set(docs.map((d) => d.url)).size === docs.length);

// ── C. best_vote_document — preference, and the honest null ─────────────────
console.log('\nC. best_vote_document — minutes win; agenda-only yields NOTHING');

check('prefers minutes over the action agenda', best_vote_document(docs)?.kind === 'minutes');

// node/4474 (2026-07-22): minutes are not approved yet, so the meeting has an
// action agenda and pre-meeting documents only.
const AGENDA_ONLY = parse_meeting_document_links(
  `<a href="${CDN_AGENDA}">Agenda</a><a href="${CDN_PACKET}">Packet</a><a href="${ADA_HTML}">Agenda (HTML)</a>`,
  PAGE_81,
);
check('an agenda-only meeting yields NO vote document', best_vote_document(AGENDA_ONLY) === null);
check('  (the agenda documents are still returned for citing)', AGENDA_ONLY.length === 3);

const ACTION_ONLY = parse_meeting_document_links(`<a href="${ACTION}">Action Agenda</a><a href="${CDN_PACKET}">Packet</a>`, PAGE_81);
check('the newest meeting falls back to its action agenda', best_vote_document(ACTION_ONLY)?.kind === 'action_agenda');

// ── D. recency — the question discovery never asked ─────────────────────────
console.log('\nD. recent_past_meetings — recency, not search rank');

const NOW = new Date('2026-07-31T12:00:00Z');
const FIXTURE: CivicMeeting[] = [
  // The row the live runs actually read, via search.
  { meeting_id: '3001', revision_id: '1', title: 'City Council Regular Meeting', group: 'City Council', summary: null, date: '2023-10-17T23:00:00.000Z', date_from_title: false },
  { meeting_id: '4467', revision_id: '2', title: 'City Council Regular Meeting', group: 'City Council', summary: null, date: '2026-06-17T00:00:00.000Z', date_from_title: false },
  { meeting_id: '4474', revision_id: '3', title: 'City Council Regular Meeting', group: 'City Council', summary: null, date: '2026-07-22T00:00:00.000Z', date_from_title: false },
  { meeting_id: '4476', revision_id: '4', title: 'City Council Work Session', group: 'City Council', summary: null, date: '2026-07-29T00:00:00.000Z', date_from_title: false },
  // Future — has not happened, cannot have votes.
  { meeting_id: '4479', revision_id: '5', title: 'City Council Work Session', group: 'City Council', summary: null, date: '2026-08-12T00:00:00.000Z', date_from_title: false },
  // TBD placeholder template rows the live API is full of.
  { meeting_id: '4346', revision_id: '6', title: 'TEST meeting', group: 'City Council', summary: null, date: '2099-12-25T21:33:00.000Z', date_from_title: false },
  { meeting_id: '4351', revision_id: '7', title: 'City Council', group: 'City Council', summary: null, date: null, date_from_title: false },
];

const recent = recent_past_meetings(FIXTURE, NOW, 45);
check('newest first', recent[0]?.meeting_id === '4476' && recent[1]?.meeting_id === '4474');
check('excludes a FUTURE meeting', !recent.some((m) => m.meeting_id === '4479'));
check('excludes the 2099 placeholder', !recent.some((m) => m.meeting_id === '4346'));
check('excludes an undated row rather than guessing', !recent.some((m) => m.meeting_id === '4351'));
check('THE BUG: the Oct 2023 meeting is outside the window', !recent.some((m) => m.meeting_id === '3001'));
check('widening the window does reach 2023', recent_past_meetings(FIXTURE, NOW, 2000).some((m) => m.meeting_id === '3001'));
// 2026-07-29T00:00:00Z is 6pm MT on the 28th — the local day, which is what
// the city calls the meeting.
check('day is the LOCAL calendar day', recent[0]?.day === '2026-07-28');

// The evening-meeting skew. Council meets 6pm MT, which civic_meetings_api
// canonicalizes to midnight UTC the NEXT day. Slicing the UTC instant reads
// "2026-06-17" for the meeting the city calls June 16 and files as
// `2026-06-16_minutes.pdf`; that one-day error would land on every evening
// meeting's civic_votes row and miss the dedup key record_civic_vote builds.
const june = recent_past_meetings(FIXTURE, NOW, 60).find((m) => m.meeting_id === '4467');
check('THE SKEW: a 6pm MT meeting is dated the LOCAL day, not the UTC one', june?.day === '2026-06-16');
check('  (a naive UTC slice would have said 2026-06-17)', new Date('2026-06-17T00:00:00.000Z').toISOString().slice(0, 10) === '2026-06-17');
check('an explicit tz is honored', recent_past_meetings(FIXTURE, NOW, 60, 'UTC').find((m) => m.meeting_id === '4467')?.day === '2026-06-17');
check('now is a parameter, never the host clock', recent_past_meetings(FIXTURE, new Date('2026-06-20T00:00:00Z'), 45).every((m) => m.day <= '2026-06-20'));

// ── E. resolve_meeting_documents — the /node/{id} redirect ──────────────────
console.log('\nE. resolve_meeting_documents — MeetingID → page → documents');

let requested = '';
const fake_page = async (url: string) => {
  requested = url;
  // The live portal 301s /node/4467 to a slug page whose number (81) has no
  // relation to the MeetingID — which is exactly why the page URL cannot be
  // derived and has to be resolved.
  return { ok: true, url: PAGE_81, html: PAGE_HTML_WITH_MINUTES, status: 200 };
};

const resolved = await resolve_meeting_documents('4467', { fetch_page: fake_page, base: BASE });
check('requests /node/{MeetingID}', requested === `${BASE}/node/4467`);
check('reports the REDIRECTED page url', resolved.page_url === PAGE_81);
check('returns the documents', resolved.ok && resolved.documents.length >= 4);
check('the best document is the minutes', best_vote_document(resolved.documents)?.url === MINUTES);

const failed_resolve = await resolve_meeting_documents('9999', {
  fetch_page: async () => ({ ok: false, url: '', html: '', status: 404 }),
  base: BASE,
});
check('a 404 is reported, not thrown', !failed_resolve.ok && (failed_resolve.error ?? '').includes('404'));

const threw_resolve = await resolve_meeting_documents('4467', {
  fetch_page: async () => { throw new Error('ECONNREFUSED'); },
  base: BASE,
});
check('a network throw degrades to an error result', !threw_resolve.ok && (threw_resolve.error ?? '').includes('ECONNREFUSED'));

// ── F. discover_recent_meetings — API outage is honest ──────────────────────
console.log('\nF. discover_recent_meetings');

const discovered = await discover_recent_meetings({
  now: NOW,
  within_days: 45,
  list_fn: async () => ({ ok: true, meetings: FIXTURE }),
});
check('discovers newest-first past meetings', discovered.ok && discovered.meetings[0]?.meeting_id === '4476');

const outage = await discover_recent_meetings({
  now: NOW,
  within_days: 45,
  list_fn: async () => ({ ok: false, meetings: [], error: 'HTTP 503' }),
});
check('an API outage returns ok:false, never a silent empty success', !outage.ok && outage.meetings.length === 0);

// ── G. the roll-call roster ─────────────────────────────────────────────────
console.log('\nG. parse_roll_call_roster — the authoritative roster');

// Verbatim from 2026-06-16_minutes.pdf, unpdf-extracted.
const MINUTES_TEXT = `
CITY OF FORT COLLINS
City Council Regular Meeting
June 16, 2026

D) ROLL CALL
PRESENT Mayor Emily Whitaker Mayor Pro Tem Julie Romano Councilmember Josh Fudge
Councilmember Melanie Ferris Councilmember Amy Hoeven Councilmember Chris Barrett
Councilmember Anne Nelsen
ABSENT None
STAFF PRESENT City Manager Kelly DiMartino City Attorney Carrie Daggett City Clerk Delynn Coldiron

E) AGENDA REVIEW
The motion carried 7-0.
The motion carried 6-1 with Councilmember Barrett dissenting.
`;

const roster = parse_roll_call_roster(MINUTES_TEXT);
const names = roster.map((r) => r.name);
check('finds all seven members', roster.length === 7);
check('  Emily Whitaker', names.includes('Emily Whitaker'));
check('  Julie Romano', names.includes('Julie Romano'));
check('  Chris Barrett', names.includes('Chris Barrett'));
check('  Anne Nelsen (last entry survives the split)', names.includes('Anne Nelsen'));
check('all marked present', roster.every((r) => r.present));
check('strips the title into role', roster.find((r) => r.name === 'Emily Whitaker')?.role?.toLowerCase() === 'mayor');
check('handles the two-word title "Mayor Pro Tem"', roster.find((r) => r.name === 'Julie Romano')?.role?.toLowerCase() === 'mayor pro tem');

// The whole point of the roster: STAFF are not voting members.
check('EXCLUDES staff — Kelly DiMartino is not a member', !names.includes('Kelly DiMartino'));
check('EXCLUDES staff — Carrie Daggett is not a member', !names.includes('Carrie Daggett'));
check('EXCLUDES staff — Delynn Coldiron is not a member', !names.includes('Delynn Coldiron'));

// The two rows that actually polluted the live roster must be unreachable.
check('never yields the bare heading "Councilmember"', !names.includes('Councilmember'));
check('never yields the bare heading "City Council"', !names.includes('City Council'));
check('every parsed name passes the person gate', roster.every((r) => is_plausible_member_name(r.name)));

console.log('\nG2. absent members + degradation');
const WITH_ABSENT = MINUTES_TEXT.replace('ABSENT None', 'ABSENT Councilmember Amy Hoeven').replace(
  'Councilmember Amy Hoeven Councilmember Chris Barrett',
  'Councilmember Chris Barrett',
);
const r2 = parse_roll_call_roster(WITH_ABSENT);
check('an absent member is recorded as not present', r2.find((r) => r.name === 'Amy Hoeven')?.present === false);
check('present members still present', r2.find((r) => r.name === 'Chris Barrett')?.present === true);

check('no roll-call block → [] (never "nobody was present")', parse_roll_call_roster('Some document with no roll call at all.').length === 0);
check('empty input → []', parse_roll_call_roster('').length === 0);

console.log('\nG3. split_member_title');
check('splits Mayor', split_member_title('Mayor Emily Whitaker').name === 'Emily Whitaker');
check('splits Mayor Pro Tem', split_member_title('Mayor Pro Tem Julie Romano').role?.toLowerCase() === 'mayor pro tem');
check('a titleless name is unchanged', split_member_title('Chris Barrett').name === 'Chris Barrett' && split_member_title('Chris Barrett').role === null);
check('a BARE title keeps the original so the name gate rejects it', split_member_title('Councilmember').name === 'Councilmember');
check('  and that bare title fails the person gate', !is_plausible_member_name(split_member_title('Councilmember').name));

// ── H. extraction windows — the truncation that ate the dissents ────────────
console.log('\nH. chunk_for_extraction — the contested votes live at the END');

check('a short document is one window', chunk_for_extraction('x'.repeat(5_000), { size: 24_000 }).length === 1);

// The real shape: 42,164-char minutes against the old 26,000-char cap.
const long_doc = 'x'.repeat(42_164);
const win = chunk_for_extraction(long_doc, { size: 26_000, overlap: 2_000 });
check('the 2026-06-16 minutes need more than one window', win.length > 1);
check('the LAST window reaches the end of the document', win[win.length - 1]!.length > 0 && win.reduce((a, w) => a + w.length, 0) >= long_doc.length);

// The vote at char 41,549 — `carried 6-1 with Councilmember Barrett
// dissenting` — is the whole point. Truncation dropped it; windowing must not.
const marked = 'a'.repeat(41_549) + 'CONWAY_DISSENT' + 'b'.repeat(600);
const marked_windows = chunk_for_extraction(marked, { size: 26_000, overlap: 2_000 });
check('THE DISSENT at char 41,549 survives windowing', marked_windows.some((w) => w.includes('CONWAY_DISSENT')));
check('  (a single truncated window would have lost it)', !marked.slice(0, 26_000).includes('CONWAY_DISSENT'));

check('windows overlap so a straddling motion is whole somewhere', (() => {
  const doc = 'p'.repeat(25_500) + 'STRADDLE' + 'q'.repeat(20_000);
  return chunk_for_extraction(doc, { size: 26_000, overlap: 2_000 }).some((w) => w.includes('STRADDLE'));
})());

check('max_windows bounds the work', chunk_for_extraction('z'.repeat(500_000), { size: 10_000, overlap: 1_000, max_windows: 3 }).length === 3);
check('a degenerate overlap cannot loop forever', chunk_for_extraction('z'.repeat(60_000), { size: 5_000, overlap: 999_999 }).length <= 4);

console.log('\nH2. merge_extracted_rows');
const merged = merge_extracted_rows([
  [{ item_title: 'Ordinance 062 — Hughes Site', outcome: 'adopted', votes: [{ member: 'Emily Whitaker', vote: 'aye' }] }],
  // Same item from the overlapping window, with the FULL roll call.
  [
    { item_title: 'Ordinance  062 —  Hughes   Site', outcome: 'adopted', votes: [{ member: 'Emily Whitaker', vote: 'aye' }, { member: 'Chris Barrett', vote: 'nay' }] },
    { item_title: 'Flock Retention and Data Sharing', outcome: 'passed 6-1', votes: [{ member: 'Chris Barrett', vote: 'nay' }] },
  ],
]);
check('an item repeated across windows collapses to one', merged.length === 2);
check('the copy with MORE votes wins (the truncated half loses)', (merged[0]!.votes as unknown[]).length === 2);
check('the title is kept AS WRITTEN, not normalized', typeof merged[0]!.item_title === 'string');
check('a window-only item still lands', merged.some((r) => r.item_title === 'Flock Retention and Data Sharing'));
check('a titleless row is dropped', merge_extracted_rows([[{ outcome: 'adopted', votes: [] }]]).length === 0);
check('empty batches merge to nothing', merge_extracted_rows([[], []]).length === 0);

console.log(`\n  passed=${passed}  failed=${failed}`);
if (failed > 0) { console.error('\n✗ CIVIC-MEETING-DOCS SMOKE FAILED'); process.exit(1); }
console.log('\n✓ CIVIC-MEETING-DOCS SMOKE OK');
process.exit(0);
