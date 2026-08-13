/**
 * smoke:research-sources — persisted source BODIES for deep research
 * (Deep Research v2 phase 1, 2026-07-29).
 *
 * Why it exists. A sub-investigator used to fetch a page, feed 6,000 characters
 * of it to the extractor, and throw the text away — only the url and title
 * survived. So `verify_investigation` had no corpus to grade findings against
 * and built one out of the findings themselves; every claim was "supported by"
 * itself. The 2026-07-28 Barrett dossier recorded
 * `{"claims_checked":4,"verdicts":[]}` while carrying a plainly false claim,
 * and the check could not have failed no matter what the dossier said. Three
 * more things were impossible for the same reason: comparing an event date
 * against the page's own PUBLICATION date, anchoring a verbatim quote, and
 * re-verifying without re-fetching the live web.
 *
 * This pins the store that makes the evidence exist: the round-trip, the
 * idempotency a resumed phase depends on, the cap + truncation flag a quote
 * check will need to interpret its own failures, the deterministic metadata
 * (publisher, publication date), the CORDON (a member's evidence trail is not
 * the owner's), and expiry.
 *
 * Self-contained: temp db, no network, no LLM, no live orchestrator.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { open_db } from '../src/memory/stores/structured';
import {
  ResearchSourcesStore,
  extract_published_at,
  publisher_for_url,
  source_body_cap,
} from '../src/memory/stores/research_sources';
import type { Caller } from '../src/memory/private_to';

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    console.log(`  ✓ ${name}`);
    passed++;
  } else {
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
    failed++;
  }
}

const dir = mkdtempSync(join(tmpdir(), 'hearth-research-sources-'));
const db = open_db(join(dir, 'smoke.db'));
const store = new ResearchSourcesStore(db);

const OWNER: Caller = { user_id: 'jasper', tier: 'owner' };
const SAM: Caller = { user_id: 'sam', tier: 'household' };
const FETCHED = new Date('2026-07-29T18:00:00Z');

/* ------------------------------------------------------------------ */
console.log('→ the body survives the fetch (the whole point)');
/* ------------------------------------------------------------------ */
{
  const body =
    '# Recall of elected officials\n\nPublished July 12, 2026\n\n' +
    'A recall petition must be signed by registered electors equal to at least ' +
    'twenty-five percent of the votes cast in the last election for that office.';
  const row = store.record({
    investigation_id: 'ri_alpha',
    sub_question_id: 'sq_2',
    url: 'https://library.municode.example/fort-collins/charter/art-IX',
    title: 'Pleasantville City Charter, Article IX',
    body,
    private_to: 'jasper',
    fetched_at: FETCHED,
  });
  check('the row comes back with an rs_ id', /^rs_[a-z0-9]{12}$/.test(row.id), row.id);
  check('body_md is the source text, not a summary', row.body_md === body);
  check(
    'the verifier can now read a corpus that is NOT the findings',
    store.list_for_investigation('ri_alpha')[0]?.body_md.includes('twenty-five percent') === true,
  );
  check('content_hash is sha256 of the full text', row.content_hash === createHash('sha256').update(body).digest('hex'));
  check('publisher comes off the url', row.publisher === 'library.municode.example');
  check('sub_question_id records which facet read it', row.sub_question_id === 'sq_2');
  check('fetched_at is recorded', row.fetched_at === FETCHED.toISOString());
  check('short bodies are not marked truncated', row.truncated === false && row.body_chars === body.length);
  check(
    "published_at is the PAGE's date, never the fetch date",
    row.published_at === '2026-07-12',
    String(row.published_at),
  );
}

/* ------------------------------------------------------------------ */
console.log('→ idempotent per (investigation, url) — a resumed phase re-reads');
/* ------------------------------------------------------------------ */
{
  const first = store.record({
    investigation_id: 'ri_beta',
    url: 'https://news.example/vote',
    title: 'Council ends contract',
    body: 'Council voted 6-1 on June 16, 2026 to end the contract.',
    fetched_at: FETCHED,
  });
  const again = store.record({
    investigation_id: 'ri_beta',
    url: 'https://news.example/vote',
    title: 'Council ends contract (updated)',
    body: 'Council voted 6-1 on June 16, 2026 to end the contract. Updated with reaction.',
    fetched_at: new Date('2026-07-29T19:00:00Z'),
  });
  check('a re-read does not duplicate the row', store.count_for_investigation('ri_beta') === 1);
  check('the id is STABLE across a refresh (anchors survive a resume)', again.id === first.id);
  check('the body is refreshed', again.body_md.includes('Updated with reaction'));
  check('the hash changes with the content', again.content_hash !== first.content_hash);
  check('the same url under a DIFFERENT investigation is its own row', (() => {
    store.record({ investigation_id: 'ri_gamma', url: 'https://news.example/vote', body: 'x'.repeat(200), fetched_at: FETCHED });
    return store.count_for_investigation('ri_gamma') === 1 && store.count_for_investigation('ri_beta') === 1;
  })());
}

/* ------------------------------------------------------------------ */
console.log('→ the cap, and truncation recorded so a failed quote check is readable');
/* ------------------------------------------------------------------ */
{
  process.env.HEARTH_RESEARCH_SOURCE_BODY_CAP = '2000';
  check('the env cap is honoured', source_body_cap() === 2000);
  const long = 'A'.repeat(5000) + 'NEEDLE_PAST_THE_CAP';
  const row = store.record({
    investigation_id: 'ri_long',
    url: 'https://long.example/doc',
    body: long,
    fetched_at: FETCHED,
  });
  check('the stored body is capped', row.body_chars === 2000 && row.body_md.length === 2000);
  check('truncation is RECORDED', row.truncated === true);
  check(
    'the hash still identifies the FULL text (so a re-fetch reads as unchanged)',
    row.content_hash === createHash('sha256').update(long).digest('hex'),
  );
  check('a quote past the cap is genuinely absent from what we kept', !row.body_md.includes('NEEDLE_PAST_THE_CAP'));
  delete process.env.HEARTH_RESEARCH_SOURCE_BODY_CAP;
}

/* ------------------------------------------------------------------ */
console.log('→ publisher derivation (read off the url, never guessed)');
/* ------------------------------------------------------------------ */
{
  check('www is stripped', publisher_for_url('https://www.herald.com/story/1') === 'herald.com');
  check('a subdomain is kept (it distinguishes the outlet)', publisher_for_url('https://library.municode.com/co') === 'library.municode.com');
  check('case is normalised', publisher_for_url('https://NYTimes.com/x') === 'nytimes.com');
  check('a junk url yields null, not a guess', publisher_for_url('not a url') === null);
}

/* ------------------------------------------------------------------ */
console.log('→ publication date: the F4 distinction (page date ≠ event date)');
/* ------------------------------------------------------------------ */
{
  const NOW = new Date('2026-07-29T00:00:00Z');
  const at = (b: string) => extract_published_at(b, NOW);
  check('ISO dateline', at('Posted 2026-07-12 by staff') === '2026-07-12');
  check('slashed ISO', at('2026/07/12 — Council notes') === '2026-07-12');
  check('"July 12, 2026"', at('Published July 12, 2026 at 4pm') === '2026-07-12');
  check('"12 July 2026"', at('12 July 2026 | Herald') === '2026-07-12');
  check('ordinal day', at('July 12th, 2026') === '2026-07-12');
  check('abbreviated month with a period', at('Jul. 12, 2026') === '2026-07-12');
  check('abbreviated month, no period', at('Jul 12, 2026 — Herald') === '2026-07-12');
  check('"Sept" (4-letter) still resolves to September', at('Sept 3, 2026') === '2026-09-03');
  check('a 3-letter prefix is not confused (Mar vs May)', at('Mar 4, 2026') === '2026-03-04' && at('May 4, 2026') === '2026-05-04');
  check('"March" is not truncated to "Mar" + junk', at('March 4, 2026') === '2026-03-04');
  check('no date at all → null (honest, not a guess)', at('Council notes with no date anywhere.') === null);
  check(
    'the EARLIEST-POSITIONED date wins (the dateline, not a date in the prose)',
    at('Published July 12, 2026. The vote took place on June 16, 2026.') === '2026-07-12',
  );
  check(
    'a date deep in the body is NOT taken as the publication date',
    at('Council notes.\n' + 'filler '.repeat(600) + 'The vote took place on June 16, 2026.') === null,
  );
  check('an impossible future year is rejected', at('Published July 12, 2031') === null);
  check('next year is allowed (a page can be dated slightly ahead)', at('Published January 5, 2027') === '2027-01-05');
  check('a pre-web year is rejected', at('Published July 12, 1889') === null);
  check('an invalid day is not accepted', at('Published July 47, 2026') === null);
  check('empty body → null', at('') === null);
}

/* ------------------------------------------------------------------ */
console.log('→ cordon: the owner has NO god-view of a member\'s evidence trail');
/* ------------------------------------------------------------------ */
{
  store.record({
    investigation_id: 'ri_sara',
    url: 'https://clinic.example/notes',
    body: "Sam's therapist's public profile and hours.".repeat(5),
    private_to: 'sam',
    fetched_at: FETCHED,
  });
  const unfiltered = store.list_for_investigation('ri_sara');
  check('the row exists', unfiltered.length === 1);
  check('Sam sees her own body', store.list_for_investigation('ri_sara', { caller: SAM }).length === 1);
  check(
    'the OWNER does not — same cordon as the dossier',
    store.list_for_investigation('ri_sara', { caller: OWNER }).length === 0,
  );
  check(
    'a household body is visible to both',
    (() => {
      store.record({ investigation_id: 'ri_hh', url: 'https://x.example/a', body: 'y'.repeat(200), private_to: 'household', fetched_at: FETCHED });
      return (
        store.list_for_investigation('ri_hh', { caller: OWNER }).length === 1 &&
        store.list_for_investigation('ri_hh', { caller: SAM }).length === 1
      );
    })(),
  );
  check(
    'an UNSTAMPED body fails CLOSED to owner-only',
    (() => {
      store.record({ investigation_id: 'ri_unstamped', url: 'https://x.example/b', body: 'z'.repeat(200), fetched_at: FETCHED });
      return (
        store.list_for_investigation('ri_unstamped', { caller: OWNER }).length === 1 &&
        store.list_for_investigation('ri_unstamped', { caller: SAM }).length === 0
      );
    })(),
  );
}

/* ------------------------------------------------------------------ */
console.log('→ retention: the trail expires (it is a copy of the web on our disk)');
/* ------------------------------------------------------------------ */
{
  process.env.HEARTH_RESEARCH_SOURCE_RETENTION_DAYS = '30';
  store.record({
    investigation_id: 'ri_old',
    url: 'https://old.example/a',
    body: 'q'.repeat(200),
    fetched_at: new Date('2026-01-01T00:00:00Z'),
  });
  store.record({
    investigation_id: 'ri_new',
    url: 'https://new.example/a',
    body: 'q'.repeat(200),
    fetched_at: new Date('2026-07-28T00:00:00Z'),
  });
  const removed = store.prune_expired(new Date('2026-07-29T00:00:00Z'));
  check('a body past the window is pruned', removed >= 1 && store.count_for_investigation('ri_old') === 0);
  check('a fresh body survives', store.count_for_investigation('ri_new') === 1);
  check('a second prune is a no-op', store.prune_expired(new Date('2026-07-29T00:00:00Z')) === 0);
  delete process.env.HEARTH_RESEARCH_SOURCE_RETENTION_DAYS;

  check('delete_for_investigation clears one investigation only', (() => {
    const n = store.delete_for_investigation('ri_new');
    return n === 1 && store.count_for_investigation('ri_new') === 0 && store.count_for_investigation('ri_alpha') === 1;
  })());
  check('an unknown investigation reads empty, never throws', store.list_for_investigation('ri_nope').length === 0);
  check('an unknown url reads null', store.get_by_url('ri_alpha', 'https://nope.example') === null);
}

db.close();
rmSync(dir, { recursive: true, force: true });

console.log(`\n  passed=${passed}  failed=${failed}`);
if (failed > 0) {
  console.error('\n✗ RESEARCH-SOURCES SMOKE FAILED');
  process.exit(1);
}
console.log('\n✓ RESEARCH-SOURCES SMOKE OK');
process.exit(0);
