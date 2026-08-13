/**
 * smoke:ruby-civic — self-contained coverage for Ruby's civic-intelligence
 * ledger (2026-06-10): the money/interests/conflicts store, the pure
 * analysis math, and the tool contracts.
 *
 * No network, no LLM, no orchestrator. Temp vault + temp main db + temp
 * ruby_civic.db (via HEARTH_RUBY_CIVIC_DB_PATH, set before the singleton's
 * first touch). Exercises:
 *
 *   1. Store plausibility gates — implausible donation amounts, missing
 *      citations, unparseable dates REJECT with a reason; valid rows store
 *      idempotently; donor rollup math.
 *   2. Conflict-flag lifecycle — created → re-upsert preserves status →
 *      explicit transition → a cleared flag survives a re-scan CLEARED.
 *   3. civic_analysis — topic buckets, voting-record tallies, the
 *      alignment matrix (substantive votes only), deterministic conflict
 *      matching incl. the stopword guard and both-bases merge.
 *   4. scan_conflicts end-to-end — flags land with receipts, re-runs
 *      don't duplicate, review verdicts stick.
 *   5. The read tools (query_civic_finance / voting_record /
 *      council_alignment / member_dossier) return their contracts.
 *   6. apply_vote_rows — extracted rows converge on the SAME dedup rows
 *      as the manual record_civic_vote tool; junk rows skip.
 *   7. apply_finance_rows + parse_finance_extraction — fenced + truncated
 *      LLM JSON both record; gate rejections are counted.
 *   8. The official-host floor for the vote extractor.
 *
 * Extended 2026-07-28 when the beat became self-managing:
 *
 *   9. The derived watch lifecycle — a story opens, ages to going_quiet,
 *      ages off to dormant, closes explicitly (sticky, beats recency), and
 *      REVIVES on a new development, all with no sweep job and no stored
 *      topic state.
 *  10. query_civic_ledger's board rollup — finished work leaves the board
 *      but stays queryable; passing a topic still returns its arc.
 *  11. Campaigns — sticky field updates, investigation attach/dedup,
 *      typed date recovery, and won/lost/closed leaving the active set.
 *  12. The de-branded taxonomy — surveillance/traffic-safety/fiber/charter
 *      items bucket by CAPABILITY, so a vendor change can't strand the
 *      successor contract in `other`.
 *  13. The civic pane renders both derived sections, with finished work
 *      absent and an empty board degrading to a sentence.
 */

import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { mkdirSync, rmSync } from 'node:fs';

const ROOT = resolve(tmpdir(), `hearth-ruby-civic-smoke-${Date.now()}`);
mkdirSync(resolve(ROOT, 'data'), { recursive: true });
// Must be set BEFORE the store singleton's first construction (tools call
// get_ruby_civic_store() lazily inside execute, so top-of-process is safe).
process.env.HEARTH_RUBY_CIVIC_DB_PATH = resolve(ROOT, 'data', 'ruby_civic.db');

import { open_db } from '../src/memory/stores/structured';
import { MemoryClient } from '../src/memory/client';
import { ConfigLLMRouter } from '../src/core/router';
import type { ToolContext } from '../src/core/tool';
import { get_ruby_civic_store } from '../src/memory/stores/ruby_civic';
import {
  alignment_matrix,
  classify_civic_topic,
  conflict_severity,
  distinctive_tokens,
  is_official_civic_host,
  match_conflicts,
  normalize_for_quote,
  quote_in_evidence,
  summarize_watch_topics,
  voting_record_summary,
  type TieRecord,
  type VoteLike,
  type WatchEventLike,
} from '../src/specialists/ruby/civic_analysis';
import { campaign_list_field } from '../src/memory/client';
import { query_civic_ledger } from '../src/specialists/ruby/tools/query_civic_ledger';
import { record_civic_campaign } from '../src/specialists/ruby/tools/record_civic_campaign';
import { compose_pane } from '../src/core/specialist_pane';
import { record_civic_item } from '../src/specialists/ruby/tools/record_civic_item';
import {
  record_donation,
  record_member_interest,
  record_conflict_flag,
} from '../src/specialists/ruby/tools/record_finance_facts';
import { query_civic_finance } from '../src/specialists/ruby/tools/query_civic_finance';
import { record_politics_item, query_politics_desk } from '../src/specialists/ruby/tools/politics_desk';
import { voting_record, council_alignment } from '../src/specialists/ruby/tools/voting_analysis';
import { member_dossier } from '../src/specialists/ruby/tools/member_dossier';
import { scan_conflicts } from '../src/specialists/ruby/tools/scan_conflicts';
import { apply_vote_rows } from '../src/specialists/ruby/tools/extract_meeting_votes';
import {
  apply_finance_rows,
  parse_finance_extraction,
  source_kind_for,
} from '../src/specialists/ruby/tools/acquire_campaign_finance';
import { record_civic_vote as record_civic_vote_tool } from '../src/specialists/ruby/tools/record_civic_vote';

const USER = 'jasper';
const MINUTES_URL = 'https://www.citygov.com/cityclerk/minutes/2026-05-19.pdf';
const FILING_URL = 'https://www.citygov.com/cityclerk/campaign-finance/2025-q3-smith.pdf';

async function main(): Promise<void> {
  let pass = 0;
  const assert = (cond: boolean, msg: string): void => {
    if (!cond) throw new Error(msg);
  };

  const db = open_db(resolve(ROOT, 'data', 'smoke.db'));
  const memory = new MemoryClient({ vault_root: ROOT, db });
  const llm = new ConfigLLMRouter('./config/llm-roles.yaml', {
    ollama_base_url: 'http://localhost:11434',
  });
  const store = get_ruby_civic_store();
  const ctx: ToolContext = {
    memory,
    llm,
    now: new Date('2026-06-10T18:00:00Z'),
    intent_id: 'smoke-ruby-civic',
    specialist_id: 'ruby',
    user: { id: USER, tier: 'owner' },
  };

  try {
    // ── 1. donation gates + idempotency + rollup ──────────────────────────
    console.log('→ store: donation plausibility gates + idempotency + rollup math');
    assert(store.record_donation({ recipient: 'Alice Smith', donor: 'Brinkman Development LLC', amount_usd: 100, donated_at: '2025-09-12', election_cycle: '2025', source_kind: 'city_clerk', source_url: FILING_URL }).stored, 'valid donation should store');
    assert(!store.record_donation({ recipient: 'Alice Smith', donor: 'X', amount_usd: 0, source_url: FILING_URL }).stored, '$0 donation must reject');
    assert(!store.record_donation({ recipient: 'Alice Smith', donor: 'X', amount_usd: 2_000_000, source_url: FILING_URL }).stored, '$2M donation must reject (misread/cycle-total class)');
    assert(!store.record_donation({ recipient: 'Alice Smith', donor: 'X', amount_usd: 50, source_url: 'not-a-url' }).stored, 'uncited donation must reject');
    assert(!store.record_donation({ recipient: 'Alice Smith', donor: 'X', amount_usd: 50, donated_at: 'last tuesday', source_url: FILING_URL }).stored, 'unparseable date must reject');
    // idempotent re-record + two more rows for the rollup
    store.record_donation({ recipient: 'Alice Smith', donor: 'Brinkman Development LLC', amount_usd: 100, donated_at: '2025-09-12', election_cycle: '2025', source_kind: 'city_clerk', source_url: FILING_URL });
    store.record_donation({ recipient: 'Alice Smith', donor: 'Brinkman Development LLC', amount_usd: 150, donated_at: '2025-10-01', election_cycle: '2025', source_kind: 'city_clerk', source_url: FILING_URL });
    store.record_donation({ recipient: 'Alice Smith', donor: 'Jane Neighbor', donor_type: 'individual', amount_usd: 50, donated_at: '2025-10-02', source_url: FILING_URL });
    const dons = store.list_donations({ recipient: 'Alice Smith' });
    assert(dons.length === 3, `re-recording must not duplicate (expected 3 rows, got ${dons.length})`);
    const rollup = store.donor_rollup({ recipient: 'Alice Smith' });
    assert(rollup[0]?.donor === 'Brinkman Development LLC' && rollup[0]?.total_usd === 250 && rollup[0]?.n === 2, `rollup math wrong: ${JSON.stringify(rollup[0])}`);
    assert(!!rollup[0]?.source_url && /^https/.test(rollup[0].source_url), 'rollup must carry a citing source_url');
    console.log('  ✓ gates reject with reasons; idempotent; rollup totals correct');
    pass++;

    // ── 2. filings + interests ────────────────────────────────────────────
    console.log('→ store: filings + interests upserts');
    assert(!store.record_filing({ candidate: 'Alice Smith', period: '2025 Q3', source_url: FILING_URL }).stored, 'filing with no totals must reject');
    assert(store.record_filing({ candidate: 'Alice Smith', period: '2025 Q3', total_raised_usd: 4_200, total_spent_usd: 3_100, source_url: FILING_URL }).stored, 'valid filing should store');
    store.record_filing({ candidate: 'Alice Smith', period: '2025 Q3', total_raised_usd: 4_500, total_spent_usd: 3_100, source_url: FILING_URL });
    assert(store.list_filings('Alice Smith').length === 1, 'filing upsert must not duplicate');
    assert(store.list_filings('Alice Smith')[0]?.total_raised_usd === 4_500, 'filing upsert must refresh totals');
    assert(store.upsert_interest({ member: 'Alice Smith', kind: 'board_seat', organization: 'Brinkman Development LLC', disclosed: true, source_url: FILING_URL }).stored, 'interest should store');
    store.upsert_interest({ member: 'Alice Smith', kind: 'board_seat', organization: 'Brinkman Development LLC', disclosed: true, source_url: FILING_URL });
    assert(store.list_interests('Alice Smith').length === 1, 'interest upsert must not duplicate');
    console.log('  ✓ filings + interests upsert idempotently with refreshed fields');
    pass++;

    // ── 3. topic buckets ──────────────────────────────────────────────────
    console.log('→ civic_analysis: topic classification');
    assert(classify_civic_topic('Ordinance 067 — Inclusionary Housing amendments') === 'housing', 'housing bucket');
    assert(classify_civic_topic('CityBus route 14 frequency changes') === 'transport', 'transport bucket');
    assert(classify_civic_topic('2026 BFO budget adoption') === 'budget_tax', 'budget bucket');
    assert(classify_civic_topic('Flock license plate reader contract renewal') === 'police_safety', 'police bucket');
    assert(classify_civic_topic('North Reservoir reservoir water supply') === 'utilities', 'utilities bucket');
    assert(classify_civic_topic('Riverside Trail extension acquisition') === 'parks_natural_areas', 'parks bucket');
    assert(classify_civic_topic('Proclamation: Welcome Week') === 'other', 'other fallback');
    console.log('  ✓ 7 topic buckets classify as expected');
    pass++;

    // ── 4. alignment matrix (pure) ────────────────────────────────────────
    console.log('→ civic_analysis: alignment matrix over substantive votes');
    const V = (member: string, item: string, vote: string, date: string): VoteLike => ({
      member_name: member, item_title: item, vote, meeting_date: date,
    });
    const votes_fixture: VoteLike[] = [
      V('Alice Smith', 'Item One', 'aye', '2026-01-06'), V('Bob Jones', 'Item One', 'aye', '2026-01-06'), V('Cara Kim', 'Item One', 'nay', '2026-01-06'),
      V('Alice Smith', 'Item Two', 'aye', '2026-02-03'), V('Bob Jones', 'Item Two', 'aye', '2026-02-03'), V('Cara Kim', 'Item Two', 'absent', '2026-02-03'),
      V('Alice Smith', 'Item Three', 'nay', '2026-03-03'), V('Bob Jones', 'Item Three', 'aye', '2026-03-03'), V('Cara Kim', 'Item Three', 'nay', '2026-03-03'),
      V('Alice Smith', 'Item Four', 'aye', '2026-04-07'), V('Bob Jones', 'Item Four', 'aye', '2026-04-07'), V('Cara Kim', 'Item Four', 'nay', '2026-04-07'),
    ];
    const align = alignment_matrix(votes_fixture, 3);
    assert(align.items_counted === 4 && align.members.length === 3, 'matrix should see 4 items, 3 members');
    const ab = align.pairs.find((p) => p.a === 'Alice Smith' && p.b === 'Bob Jones');
    assert(ab?.shared === 4 && ab.agreements === 3 && ab.agreement_pct === 75, `A-B should be 3/4=75%, got ${JSON.stringify(ab)}`);
    const ac = align.pairs.find((p) => p.a === 'Alice Smith' && p.b === 'Cara Kim');
    assert(ac?.shared === 3 && ac.agreement_pct === 33, `A-C should be 1/3=33% over 3 shared (the absence is excluded), got ${JSON.stringify(ac)}`);
    assert(align.pairs[0]?.agreement_pct === 0, 'least-aligned pair (B-C 0%) sorts first');
    assert(align.contested.length === 3, `Items One/Three/Four are contested, got ${align.contested.length}`);
    const rec = voting_record_summary(votes_fixture, 'alice smith');
    assert(rec.total_votes === 4 && rec.aye === 3 && rec.nay === 1, 'voting_record_summary tallies + case-insensitive name match');
    console.log('  ✓ pairwise agreement, absence exclusion, contested items, tallies');
    pass++;

    // ── 5. conflict matching (pure) ───────────────────────────────────────
    console.log('→ civic_analysis: deterministic conflict matching');
    assert(distinctive_tokens('Friends of Pleasantville').length === 0, 'fully-generic name must yield no distinctive tokens');
    const conflict_votes: VoteLike[] = [
      V('Alice Smith', 'Rezoning request — Brinkman Development, 123 S College', 'aye', '2026-03-03'),
      V('Alice Smith', '2026 Budget adoption', 'aye', '2026-04-07'),
    ];
    const ties: TieRecord[] = [
      { member: 'Alice Smith', member_slug: 'alice-smith', counterparty: 'Brinkman Development LLC', counterparty_slug: 'brinkman-development-llc', basis: 'donation', amount_usd: 250, detail: 'donated $250 total across 2 gift(s) (2025-09-12 → 2025-10-01)', source_url: FILING_URL },
      { member: 'Alice Smith', member_slug: 'alice-smith', counterparty: 'Brinkman Development LLC', counterparty_slug: 'brinkman-development-llc', basis: 'interest', amount_usd: null, detail: 'board seat: Brinkman Development LLC (officially disclosed)', source_url: FILING_URL },
      { member: 'Alice Smith', member_slug: 'alice-smith', counterparty: 'Friends of Pleasantville', counterparty_slug: 'friends-of-fort-collins', basis: 'donation', amount_usd: 500, detail: 'donated $500', source_url: FILING_URL },
    ];
    const candidates = match_conflicts(conflict_votes, ties);
    assert(candidates.length === 1, `exactly one candidate (generic donor stopworded; budget item unmatched), got ${candidates.length}`);
    const c0 = candidates[0]!;
    assert(c0.basis === 'both' && c0.matched_tokens.includes('brinkman') && c0.evidence.length === 2, `both-bases merge with receipts, got ${JSON.stringify(c0)}`);
    assert(conflict_severity(c0) === 'high', 'both-basis candidate ranks high');
    console.log('  ✓ distinctive-token match; stopword guard; both-bases merge; severity');
    pass++;

    // ── 6. apply_vote_rows converges with the manual tool ─────────────────
    console.log('→ apply_vote_rows: extracted rows share dedup keys with record_civic_vote');
    const manual = await record_civic_vote_tool.execute(
      { member_name: 'Alice Smith', item_title: 'Rezoning request — Brinkman Development, 123 S College', vote: 'aye', meeting_date: '2026-03-03', source_url: MINUTES_URL } as Parameters<typeof record_civic_vote_tool.execute>[0],
      ctx,
    );
    assert(manual.ok === true, 'manual vote record should succeed');
    const applied = apply_vote_rows(
      [
        { item_title: 'Rezoning request — Brinkman Development, 123 S College', outcome: 'passed 5-2', meeting_date: '2026-03-03', votes: [{ member: 'Alice Smith', vote: 'aye' }, { member: 'Bob Jones', vote: 'nay' }] },
        { item_title: '2026 Budget adoption', meeting_date: '2026-04-07', votes: [{ member: 'Alice Smith', vote: 'aye' }, { member: 'Bob Jones', vote: 'yes-ish' }] },
        { item_title: '', votes: [{ member: 'X', vote: 'aye' }] },
      ],
      { memory, user_id: USER, source_url: MINUTES_URL },
    );
    assert(applied.items_found === 2 && applied.votes_recorded === 3 && applied.skipped === 2, `2 items, 3 valid votes, 2 skips (bad vote value + empty item), got ${JSON.stringify(applied)}`);
    assert(applied.members_added === 2, 'Alice + Bob auto-added to the roster');
    const alice_votes = memory.list_civic_votes(USER, { member_name: 'Alice Smith' });
    assert(alice_votes.length === 2, `manual + extracted rezoning vote must converge on ONE row (plus the budget vote) — got ${alice_votes.length}`);
    assert(alice_votes.every((v) => v.outcome !== null || v.item_title.includes('Budget')), 'extracted outcome refreshed the manual row');
    assert(memory.list_civic_members(USER, false).some((m) => m.name === 'Bob Jones'), 'roster upsert landed');
    console.log('  ✓ convergent dedup; junk rows skipped + counted; roster grows');
    pass++;

    // ── 7. scan_conflicts end-to-end + review stickiness ──────────────────
    console.log('→ scan_conflicts: flags with receipts; re-scan preserves review verdicts');
    const scan1 = await scan_conflicts.execute({ min_amount_usd: 100 } as Parameters<typeof scan_conflicts.execute>[0], ctx);
    assert(scan1.ok === true && scan1.new_flags === 1, `first scan should flag Brinkman↔rezoning once, got ${JSON.stringify(scan1)}`);
    let flags = store.list_conflicts({ member: 'Alice Smith' });
    assert(flags.length === 1 && flags[0]?.status === 'flagged' && flags[0].basis === 'both', 'flag lands status=flagged, basis=both (donation rollup + board seat)');
    assert(flags[0]!.evidence_md.includes('$250') && flags[0]!.evidence_md.includes('board seat'), 'evidence carries the money + the interest receipts');
    const scan2 = await scan_conflicts.execute({ min_amount_usd: 100 } as Parameters<typeof scan_conflicts.execute>[0], ctx);
    assert(scan2.new_flags === 0 && scan2.updated_flags === 1, 're-scan must update, not duplicate');
    const cleared = await record_conflict_flag.execute(
      { member: 'Alice Smith', item_title: flags[0]!.item_title, basis: 'both', counterparty: 'Brinkman Development LLC', evidence_md: 'Reviewed both filings: Brinkman donated to all seven members equally; board seat predates the term and was disclosed. Innocent explanation.', status: 'cleared', source_urls: [FILING_URL] } as Parameters<typeof record_conflict_flag.execute>[0],
      ctx,
    );
    assert(cleared.ok === true && cleared.created === false, 'review transition updates the existing flag');
    await scan_conflicts.execute({ min_amount_usd: 100 } as Parameters<typeof scan_conflicts.execute>[0], ctx);
    flags = store.list_conflicts({ member: 'Alice Smith' });
    assert(flags[0]?.status === 'cleared', 'a cleared flag must STAY cleared through a re-scan');
    console.log('  ✓ flag → review → cleared survives re-scan; no duplicates');
    pass++;

    // ── 8. read tools ─────────────────────────────────────────────────────
    console.log('→ read tools: query_civic_finance / voting_record / council_alignment / member_dossier');
    const cov = await query_civic_finance.execute({ section: 'coverage', limit: 40 } as Parameters<typeof query_civic_finance.execute>[0], ctx);
    assert(cov.ok && cov.rows.some((r) => r.member === 'Alice Smith' && (r.votes_recorded as number) === 2 && (r.donations_total_usd as number) === 300), `coverage joins votes × money, got ${JSON.stringify(cov.rows)}`);
    const dr = await query_civic_finance.execute({ section: 'donor_rollup', member: 'Alice Smith', limit: 10 } as Parameters<typeof query_civic_finance.execute>[0], ctx);
    assert(dr.ok && dr.count === 2, 'donor_rollup section returns both donors');
    const vr = await voting_record.execute({ member_name: 'alice smith', limit: 10 } as Parameters<typeof voting_record.execute>[0], ctx);
    assert(vr.ok && vr.total_votes === 2 && vr.recent.every((r) => typeof r.source_url === 'string') && !!vr.note, 'voting_record: tallies + citations + thin-record note');
    const ca = await council_alignment.execute({ min_shared: 1 } as Parameters<typeof council_alignment.execute>[0], ctx);
    assert(ca.ok && ca.pairs.length === 1 && ca.members.length === 2, `alignment over the recorded ledger (Alice/Bob share the rezoning), got ${JSON.stringify(ca.pairs)}`);
    const dossier = await member_dossier.execute({ member_name: 'Alice Smith' } as Parameters<typeof member_dossier.execute>[0], ctx);
    assert(dossier.ok && dossier.donations_total_usd === 300 && dossier.top_donors.length === 2 && dossier.interests.length === 1 && dossier.conflicts.length === 1 && dossier.recent_votes.length === 2, `dossier merges all five ledgers, got totals=${dossier.donations_total_usd}`);
    console.log('  ✓ all four read tools return their contracts');
    pass++;

    // ── 9. finance extraction parsing + gates ─────────────────────────────
    console.log('→ apply_finance_rows: fenced JSON, salvage, gate rejections counted');
    const fenced = '```json\n{"donations":[{"recipient":"Bob Jones","donor":"Acme Towing","donor_type":"business","amount_usd":200,"donated_at":"2025-09-30","source":"' + FILING_URL + '"},{"recipient":"Bob Jones","donor":"Bad Row","amount_usd":9999999}],"filings":[{"candidate":"Bob Jones","period":"2025 Q3","total_raised_usd":1200}]}\n```';
    const parsed = parse_finance_extraction(fenced);
    assert(parsed.donations.length === 2 && parsed.filings.length === 1, 'fenced object parses');
    const fin = apply_finance_rows(parsed, { store, default_source_url: FILING_URL, default_cycle: '2025' });
    assert(fin.donations_recorded === 1 && fin.rejected === 1 && fin.filings_recorded === 1, `gate must reject the $10M row and count it, got ${JSON.stringify(fin)}`);
    const truncated = '{"donations":[{"recipient":"Bob Jones","donor":"Salvage Donor","amount_usd":75,"donated_at":"2025-10-05","source":"' + FILING_URL + '"},{"recipient":"Bob Jo';
    const salvage = parse_finance_extraction(truncated);
    assert(salvage.donations.length === 1, 'truncated tail salvages the complete row');
    assert(source_kind_for(FILING_URL) === 'city_clerk' && source_kind_for('https://tracer.sos.colorado.gov/x') === 'tracer' && source_kind_for('https://herald.com/x') === 'news', 'source_kind derives from host in code');
    console.log('  ✓ tolerant parsing; plausibility gate counts rejects; provenance from host');
    pass++;

    // ── 10. the official-host floor ───────────────────────────────────────
    console.log('→ extract_meeting_votes: official-document floor');
    assert(is_official_civic_host('https://www.citygov.com/cityclerk/minutes.pdf'), 'citygov is official');
    assert(is_official_civic_host('https://pleasantville-co.municodemeetings.com/m/123'), 'municode portal is official');
    assert(is_official_civic_host('https://leg.colorado.gov/bills/sb26-101'), 'state legislature is official');
    assert(!is_official_civic_host('https://www.herald.com/story/news/2026/05/20/council-vote/'), 'news is NOT a vote source');
    assert(!is_official_civic_host('not a url'), 'garbage is not official');
    console.log('  ✓ votes only enter from government documents');
    pass++;

    // ── 11. the Politics Desk (promotion #2) ──────────────────────────────
    console.log('→ politics_items: citation floor, sticky takes, status preservation, scoped reads');
    const bill_url = 'https://leg.colorado.gov/bills/sb26-101';
    assert(!store.record_politics_item({ scope: 'state', kind: 'bill', title: 'SB26-101 Land Use Preemption' }).stored, 'a fact-kind without a url must reject');
    assert(store.record_politics_item({ scope: 'state', kind: 'watching', title: 'Special session rumblings' }).stored, "kind 'watching' may be uncited (radar, not fact)");
    // the tool path now runs the evidence-quote gate — seed this turn's
    // audited read so the cited bill records the way a real pass would
    memory.log_action({
      intent_id: ctx.intent_id, agent: 'ruby', tool_name: 'web_fetch_clean',
      tool_input: { url: bill_url },
      execution_result: { markdown: 'SB26-101 Land Use Preemption: a statewide override of local occupancy limits, introduced in the Senate.' },
    });
    const rec_pol = await record_politics_item.execute(
      { scope: 'state', kind: 'bill', title: 'SB26-101 Land Use Preemption', summary: 'Statewide override of local occupancy limits.', take_md: 'Preemption that FORCES what Pleasantville refused to do voluntarily — watch council squirm.', url: bill_url, source: 'leg.colorado.gov', interest_score: 0.8, evidence_quote: 'a statewide override of local occupancy limits' } as Parameters<typeof record_politics_item.execute>[0],
      ctx,
    );
    assert(rec_pol.ok === true, `record_politics_item tool should store a cited+quoted bill, got ${JSON.stringify(rec_pol)}`);
    // sticky take: a bare re-record (no take) must NOT wipe the written one
    store.record_politics_item({ scope: 'state', kind: 'bill', title: 'SB26-101 Land Use Preemption', summary: 'Amended in committee.', url: bill_url, interest_score: 0.9 });
    let state_items = store.list_politics_items({ scope: 'state' });
    const sb = state_items.find((i) => i.title.includes('SB26-101'));
    assert(!!sb && sb.take_md.includes('Preemption') && sb.summary === 'Amended in committee.' && sb.interest_score === 0.9, `re-record must refresh facts but keep the take, got ${JSON.stringify(sb)}`);
    // dismissed stays dismissed through a re-record
    assert(store.set_politics_item_status(sb!.dedup_key, 'dismissed'), 'status update lands');
    store.record_politics_item({ scope: 'state', kind: 'bill', title: 'SB26-101 Land Use Preemption', url: bill_url });
    assert(!store.list_politics_items({ scope: 'state' }).some((i) => i.title.includes('SB26-101')), 'a dismissed item must not resurrect on re-record');
    store.set_politics_item_status(sb!.dedup_key, 'active');
    // scoped reads + counts (the office tab badges)
    store.record_politics_item({ scope: 'national', kind: 'ruling', title: 'SCOTUS rules on agency deference', url: 'https://www.supremecourt.gov/opinions/op.pdf', interest_score: 0.7 });
    store.record_politics_item({ scope: 'world', kind: 'election', title: 'Coalition talks after the snap election', url: 'https://apnews.com/article/example', interest_score: 0.6 });
    const counts = store.politics_counts_by_scope();
    assert(counts.state === 2 && counts.national === 1 && counts.world === 1, `scope counts feed the tab badges, got ${JSON.stringify(counts)}`);
    const desk = await query_politics_desk.execute({ limit: 25 } as Parameters<typeof query_politics_desk.execute>[0], ctx);
    assert(desk.ok && desk.count === 4 && (desk.counts_by_scope.state as number) === 2, 'query_politics_desk returns all scopes + counts');
    const desk_state = await query_politics_desk.execute({ scope: 'state', limit: 25 } as Parameters<typeof query_politics_desk.execute>[0], ctx);
    assert(desk_state.ok && desk_state.count === 2 && desk_state.rows.every((r) => r.scope === 'state'), 'scope filter holds');
    assert(desk_state.rows[0]?.title === 'SB26-101 Land Use Preemption', 'highest-interest item leads (The Brief ordering)');
    console.log('  ✓ citation floor; sticky takes; dismissed stays dismissed; scoped reads + badges');
    pass++;

    // ── 12. the evidence-quote gate (the StreetMedia fabrication class) ───
    console.log('→ evidence_quote gate: claims must trace to something the turn actually read');
    // normalization survives markdown + JSON escaping + case
    assert(normalize_for_quote('**the clinic’s\\nSignage**, reviewed!') === 'csu s nsignage reviewed' || quote_in_evidence('the clinic Signage reviewed by the board', ['{"markdown":"...**the clinic**  signage \\n reviewed by the BOARD..."}']), 'normalization matches across markdown/JSON decoration');
    assert(!quote_in_evidence('June 16', ['a June 16 work session calendar page']), 'short scaffold tokens (< 12 normalized chars) can never count as evidence');

    const gate_ctx: ToolContext = { ...ctx, intent_id: 'smoke-gate-turn' };
    const claim = { kind: 'announcement', title: 'Council to review signage contracts June 16', summary: 'Per agenda.', interest_score: 0.7 };
    // (a) no quote at all → rejected with the recovery path
    const g1 = await record_civic_item.execute({ ...claim } as Parameters<typeof record_civic_item.execute>[0], gate_ctx);
    assert(g1.ok === false && !!g1.recovery_hint && /watching/.test(g1.recovery_hint), 'announcement without evidence_quote rejects, recovery names the watching escape');
    // (b) quote but NOTHING read this turn → rejected
    const g2 = await record_civic_item.execute({ ...claim, evidence_quote: 'Council will review the signage contracts at the June 16 work session' } as Parameters<typeof record_civic_item.execute>[0], gate_ctx);
    assert(g2.ok === false && /no source was read/.test(g2.error ?? ''), 'quote with zero reads this turn rejects');
    // (c) a read happened, but the quote is NOT in it (the StreetMedia shape) → rejected
    memory.log_action({
      intent_id: 'smoke-gate-turn', agent: 'ruby', tool_name: 'web_fetch_clean',
      tool_input: { url: 'https://www.pleasantville.gov/calendar' },
      execution_result: { url: 'https://www.pleasantville.gov/calendar', markdown: 'Council Agenda Planning Calendar. **June 16** work session: items TBD. Utilities rate review scheduled for July.' },
    });
    const g3 = await record_civic_item.execute({ ...claim, evidence_quote: 'the clinic digital signage contracts are listed as a potential topic for discussion' } as Parameters<typeof record_civic_item.execute>[0], gate_ctx);
    assert(g3.ok === false && /does not appear/.test(g3.error ?? ''), 'a quote the fetched page never said rejects — the exact 2026-06-05 fabrication is now structurally blocked');
    // (d) a verbatim quote from the actually-fetched page → stored
    const g4 = await record_civic_item.execute({ ...claim, title: 'Utilities rate review scheduled for July', evidence_quote: 'Utilities rate review scheduled for July' } as Parameters<typeof record_civic_item.execute>[0], gate_ctx);
    assert(g4.ok === true, `a claim the page actually states records fine, got ${JSON.stringify(g4)}`);
    // (e) non-claim kinds are NOT gated (corridor alerts, new-in-town, watching)
    const g5 = await record_civic_item.execute({ kind: 'watching', title: 'Rumor: signage fight heading to council', interest_score: 0.4 } as Parameters<typeof record_civic_item.execute>[0], gate_ctx);
    assert(g5.ok === true, 'watching stays the honest uncited home');
    // (f) the intake/scan paths (MemoryClient direct) bypass the tool gate by design
    const direct = memory.record_civic_item({ user_id: USER, kind: 'announcement', title: 'Photographed city flyer', summary: null, event_at: null, url: null, location_label: null, lat: null, lon: null, corridor_match: null, interest_score: 0.6, dedup_key: 'capture:smoke-1', source: 'cordelia_capture' });
    assert(typeof direct === 'string', 'capture-provenance writes through the client are unaffected');
    // (g) politics fact-kinds share the gate
    const p1 = await record_politics_item.execute({ scope: 'state', kind: 'bill', title: 'HB26-200 Transit funding', url: 'https://leg.colorado.gov/bills/hb26-200', interest_score: 0.6 } as Parameters<typeof record_politics_item.execute>[0], gate_ctx);
    assert(p1.ok === false && /evidence_quote/.test(p1.reason ?? ''), 'politics fact-kind without quote rejects');
    memory.log_action({
      intent_id: 'smoke-gate-turn', agent: 'ruby', tool_name: 'web_fetch_clean',
      tool_input: { url: 'https://leg.colorado.gov/bills/hb26-200' },
      execution_result: { markdown: 'HB26-200 Concerning transit funding passed second reading in the House on a 38-27 vote.' },
    });
    const p2 = await record_politics_item.execute({ scope: 'state', kind: 'bill', title: 'HB26-200 Transit funding', evidence_quote: 'passed second reading in the House on a 38-27 vote', url: 'https://leg.colorado.gov/bills/hb26-200', interest_score: 0.6 } as Parameters<typeof record_politics_item.execute>[0], gate_ctx);
    assert(p2.ok === true, `politics fact-kind with a verbatim quote records, got ${JSON.stringify(p2)}`);
    const p3 = await record_politics_item.execute({ scope: 'world', kind: 'watching', title: 'Coalition rumors ahead of the vote' } as Parameters<typeof record_politics_item.execute>[0], gate_ctx);
    assert(p3.ok === true, 'politics watching kind stays ungated');
    console.log('  ✓ fabricated claims rejected (no quote / no reads / quote-not-on-page); verbatim claims pass; intake + watching unaffected');
    pass++;

    // ── 9. the beat is self-managing — derived topic lifecycle ────────────
    // The failure this pins: watch events were append-only with a per-event
    // status nothing read, so a fight that ended in March looked identical
    // to one that broke this morning, forever. Liveness is now DERIVED from
    // when a story last moved, so stories age off with no sweep job and no
    // stored state to fall out of sync.
    console.log('→ watch board: derived lifecycle (open / going quiet / dormant / resolved / revive)');
    const NOW = '2026-06-10T18:00:00Z';
    const board_of = (rows: WatchEventLike[]) => summarize_watch_topics(rows, NOW);

    // (a) a story that moved yesterday is open; ones quiet past each window age.
    const aged = board_of([
      { topic: 'fresh-fight', headline: 'Council sets a hearing', event_at: '2026-06-09', status: 'open', why_tracked: 'vote scheduled; $2.1M contract' },
      { topic: 'slowing-fight', headline: 'Item tabled', event_at: '2026-04-20', status: 'open' },
      { topic: 'stale-fight', headline: 'Last anyone heard', event_at: '2026-01-05', status: 'open' },
    ]);
    const by_topic = new Map(aged.map((t) => [t.topic, t]));
    assert(by_topic.get('fresh-fight')?.status === 'open', 'a story that moved yesterday is open');
    assert(by_topic.get('slowing-fight')?.status === 'going_quiet', `51d quiet is going_quiet, got ${by_topic.get('slowing-fight')?.status}`);
    assert(by_topic.get('stale-fight')?.status === 'dormant', `156d quiet is dormant, got ${by_topic.get('stale-fight')?.status}`);
    assert(by_topic.get('stale-fight')?.active === false, 'a dormant story is OFF the active board');
    assert(by_topic.get('slowing-fight')?.active === true, 'going_quiet stays ON the board for a keep-or-close call');
    assert(by_topic.get('fresh-fight')?.why_tracked === 'vote scheduled; $2.1M contract', 'why_tracked surfaces on the board');

    // (b) an explicit close is sticky and beats recency — the exact case the
    //     rework exists for: a contract that ENDED must not read as live.
    const closed = board_of([
      { topic: 'surveillance-contract', headline: 'Pilot launched', event_at: '2026-02-01', status: 'open', why_tracked: 'city money; renewal vote pending' },
      { topic: 'surveillance-contract', headline: 'Council votes 6-1 to end the contract', event_at: '2026-06-09', status: 'resolved' },
    ]);
    assert(closed[0]?.status === 'resolved', 'newest event resolving closes the story even though it just moved');
    assert(closed[0]?.active === false, 'a resolved story leaves the active board');
    assert(closed[0]?.closed_by === 'Council votes 6-1 to end the contract', 'the closing headline is carried');
    assert(closed[0]?.event_count === 2, 'the full timeline is still counted — history is never dropped');
    assert(closed[0]?.why_tracked === 'city money; renewal vote pending', 'why_tracked comes from the EARLIEST event that stated one');

    // (c) revive — a new development on a dormant story brings it back with
    //     no sweep, no reopen call, nothing to keep in sync.
    const revived = board_of([
      { topic: 'stale-fight', headline: 'Last anyone heard', event_at: '2026-01-05', status: 'open' },
      { topic: 'stale-fight', headline: 'Successor contract appears on the agenda', event_at: '2026-06-08', status: 'open' },
    ]);
    assert(revived[0]?.status === 'open' && revived[0]?.active === true, 'a new development revives a dormant story automatically');

    // (d) a future-dated development (a scheduled hearing) never reads stale.
    const future = board_of([{ topic: 'upcoming', headline: 'Hearing scheduled', event_at: '2026-07-15', status: 'open' }]);
    assert(future[0]?.days_quiet === 0 && future[0]?.status === 'open', 'a future-dated event clamps to 0 days quiet');

    // (e) active work sorts above finished work.
    assert(aged[0]?.topic === 'fresh-fight' && aged[aged.length - 1]?.topic === 'stale-fight', 'board sorts active-first, newest-moved-first');
    console.log('  ✓ stories open, age out, close, and revive with no sweep job and no stored state');
    pass++;

    // ── 10. the board + campaigns read back through the tool ──────────────
    console.log('→ query_civic_ledger: board rollup, archived exclusion, campaigns');
    memory.record_watch_event({ user_id: USER, topic: 'live-story', headline: 'Rezoning hits first reading', event_at: '2026-06-09', status: 'open', why_tracked: 'pending vote on his block', source_url: MINUTES_URL, dedup_key: 'watch:live-story:2026-06-09:first-reading' });
    memory.record_watch_event({ user_id: USER, topic: 'ended-story', headline: 'Contract ended by council vote', event_at: '2026-06-01', status: 'resolved', source_url: MINUTES_URL, dedup_key: 'watch:ended-story:2026-06-01:ended' });
    const board = await query_civic_ledger.execute({ section: 'watch', include_archived: false, limit: 40 } as Parameters<typeof query_civic_ledger.execute>[0], ctx);
    assert(board.ok && board.count === 1 && (board.rows[0] as { topic: string }).topic === 'live-story', `board shows only live stories, got ${JSON.stringify(board.rows)}`);
    assert(board.archived_count === 1, 'the board reports what it left out, so an empty board is legible');
    const with_archived = await query_civic_ledger.execute({ section: 'watch', include_archived: true, limit: 40 } as Parameters<typeof query_civic_ledger.execute>[0], ctx);
    assert(with_archived.count === 2, 'closed stories stay queryable — history is never deleted');
    const timeline = await query_civic_ledger.execute({ section: 'watch', topic: 'live-story', include_archived: false, limit: 40 } as Parameters<typeof query_civic_ledger.execute>[0], ctx);
    assert(timeline.count === 1 && 'headline' in (timeline.rows[0] ?? {}), "passing a topic returns that story's timeline, not the board");
    // the why_tracked column round-trips through the real store
    assert((timeline.rows[0] as { why_tracked?: string }).why_tracked === 'pending vote on his block', 'why_tracked persists to the DB and reads back');
    console.log('  ✓ board excludes finished work but keeps it queryable; topic returns the arc');
    pass++;

    // ── 11. campaigns — sticky updates, attach, close ─────────────────────
    console.log('→ record_civic_campaign: open, sticky advance, investigation attach, close');
    const opened = await record_civic_campaign.execute({ slug: 'successor-contract', title: 'No successor surveillance contract', stake_md: 'City money and a standing data-sharing exposure.', position_md: 'Community first, privacy first.', talking_points_md: 'The department budget did not shrink.', targets: ['City Council', 'Councilmember Doe'], next_milestone: 'Second reading', next_milestone_at: '2026-07-14', watch_topic: 'live-story', status: 'active' } as Parameters<typeof record_civic_campaign.execute>[0], ctx);
    assert(opened.ok && opened.created === true, `campaign opens, got ${JSON.stringify(opened)}`);
    // advancing only the milestone must NOT wipe the position or points
    const advanced = await record_civic_campaign.execute({ slug: 'successor-contract', title: 'No successor surveillance contract', next_milestone: 'Third reading', next_milestone_at: '2026-08-04', status: 'active' } as Parameters<typeof record_civic_campaign.execute>[0], ctx);
    assert(advanced.ok && advanced.created === false, 'advancing an existing campaign upserts, never twins');
    const [camp] = memory.list_civic_campaigns(USER, { active_only: true });
    assert(camp?.position_md === 'Community first, privacy first.', 'position survives a milestone-only update (sticky fields)');
    assert(camp?.talking_points_md === 'The department budget did not shrink.', 'talking points survive too');
    assert(camp?.next_milestone === 'Third reading', 'the milestone did advance');
    assert(campaign_list_field(camp?.targets ?? null).length === 2, 'targets round-trip through the JSON column');
    // a bad date is a typed recovery message, not a thrown tool
    const bad_date = await record_civic_campaign.execute({ slug: 'successor-contract', title: 'x', next_milestone_at: 'next tuesday', status: 'active' } as Parameters<typeof record_civic_campaign.execute>[0], ctx);
    assert(bad_date.ok === false && /ISO date/.test(bad_date.error ?? ''), 'an unparseable milestone date returns a typed recovery message');
    // attaching an investigation adds without replacing
    assert(memory.attach_campaign_investigation(USER, 'successor-contract', 'inv_aaa'), 'attach returns true for a known campaign');
    memory.attach_campaign_investigation(USER, 'successor-contract', 'inv_bbb');
    memory.attach_campaign_investigation(USER, 'successor-contract', 'inv_aaa');
    const [camp2] = memory.list_civic_campaigns(USER, { active_only: true });
    assert(campaign_list_field(camp2?.investigation_ids ?? null).join(',') === 'inv_aaa,inv_bbb', 'investigations accrue, dedup, and never replace each other');
    assert(!memory.attach_campaign_investigation(USER, 'no-such-campaign', 'inv_zzz'), 'attaching to an unknown campaign reports false');
    // closing takes it off the active board but keeps it queryable
    await record_civic_campaign.execute({ slug: 'successor-contract', title: 'No successor surveillance contract', status: 'won', outcome_md: 'Council declined to renew.' } as Parameters<typeof record_civic_campaign.execute>[0], ctx);
    assert(memory.list_civic_campaigns(USER, { active_only: true }).length === 0, 'a decided campaign leaves the active board');
    assert(memory.list_civic_campaigns(USER).length === 1, 'a decided campaign stays queryable');
    const camps = await query_civic_ledger.execute({ section: 'campaigns', include_archived: true, limit: 40 } as Parameters<typeof query_civic_ledger.execute>[0], ctx);
    assert(camps.ok && camps.count === 1 && (camps.rows[0] as { outcome: string }).outcome === 'Council declined to renew.', 'campaigns read back with their outcome');
    console.log('  ✓ campaigns open, advance without clobbering, carry investigations, and close');
    pass++;

    // ── 12. the taxonomy keys on capability, not on this month's vendor ───
    // The regression guard for the actual bug: when the vendor changed, a
    // vendor-keyed bucket sent the successor contract to `other`.
    console.log('→ classify_civic_topic: durable categories survive a vendor change');
    for (const title of [
      'Resolution authorizing an automated license plate recognition contract',
      'Facial recognition policy for the police department',
      'Body camera retention schedule amendment',
      'Data sharing agreement with federal immigration enforcement',
    ]) {
      assert(classify_civic_topic(title) === 'police_safety', `"${title}" must bucket as police_safety, got ${classify_civic_topic(title)}`);
    }
    assert(classify_civic_topic('Traffic safety action plan crash data update') === 'transport', 'traffic-safety work buckets generically, not by program brand');
    assert(classify_civic_topic('Municipal broadband fiber buildout phase 4') === 'utilities', 'municipal fiber buckets by capability');
    assert(classify_civic_topic('Recall petition procedures under the city charter') === 'governance', 'recall/charter process is governance');
    console.log('  ✓ surveillance, traffic-safety, fiber, and charter items bucket without any vendor or program name');
    pass++;

    // ── 13. the office renders the dynamic set ────────────────────────────
    // The pane is what Jasper actually looks at, and both new sections are
    // DERIVED — so this pins that they compose, that finished work is
    // absent, and that an empty board degrades to a sentence instead of a
    // broken block.
    console.log('→ civic pane: Campaigns + Following render from the derived set');
    const pane = await compose_pane(
      { id: 'ruby', pane_kind: 'civic' } as unknown as Parameters<typeof compose_pane>[0],
      db,
      USER,
      { vault_root: ROOT, memory, llm, tool_registry: null as never },
    );
    assert(!!pane, 'the civic pane composes');
    const flat = JSON.stringify(pane);
    const titles = (pane?.blocks ?? []).flatMap((b) =>
      b.type === 'tabs' ? (b as { tabs: Array<{ blocks: Array<{ title?: string }> }> }).tabs.flatMap((t) => t.blocks.map((x) => x.title)) : [(b as { title?: string }).title],
    );
    assert(titles.includes('Campaigns'), `pane carries a Campaigns block, got ${JSON.stringify(titles)}`);
    assert(titles.includes('Following'), `pane carries a Following block, got ${JSON.stringify(titles)}`);
    // 'ended-story' resolved above, and the only campaign closed 'won' —
    // so neither may appear. This is the "drops off the board" guarantee,
    // asserted at the surface the household sees.
    assert(!flat.includes('ended-story'), 'a resolved story is absent from the office');
    assert(!flat.includes('No successor surveillance contract'), 'a decided campaign is absent from the office');
    assert(flat.includes('live-story'), 'a live story is present');
    assert(flat.includes('Nothing being worked right now'), 'an empty campaign board degrades to a sentence, not a broken block');
    console.log('  ✓ office renders both derived sections; finished work is gone, live work is shown');
    pass++;

    console.log(`\n✓ ${pass} checks passed. smoke:ruby-civic done.`);
  } catch (err) {
    console.error(`\n✗ smoke:ruby-civic failed (${pass} passed):`, err);
    process.exitCode = 1;
  } finally {
    try {
      db.close();
    } catch {
      /* ignore */
    }
    rmSync(ROOT, { recursive: true, force: true });
  }
}

// ConfigLLMRouter starts a config watcher that keeps the event loop alive;
// exit explicitly (mirrors smoke-ruby).
main()
  .then(() => process.exit(process.exitCode ?? 0))
  .catch((err) => {
    console.error('smoke:ruby-civic crashed:', err);
    process.exit(1);
  });
