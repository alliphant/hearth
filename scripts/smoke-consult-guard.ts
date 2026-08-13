/**
 * Smoke for the consult-spiral guard (2026-08-05) — the structural bounds on
 * the consult GENERATING loop plus the inbox-push duplicate backstop.
 *
 * The 2026-08-04 trainer↔Ruby spiral filed 256 near-identical inbox rows in
 * one day (an eight-minute 21:31–21:39Z burst): no consult depth, no repeat
 * dedupe, no rate bound, and the store inserted every verbatim copy. These
 * pin the three ConsultGuard checks (depth / repeat / rate), the
 * failure-not-cached rule, and the SpecialistInbox.push exact-duplicate
 * collapse — including the cases that must NOT trip them.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ConsultGuard,
  consult_verdict_message,
  normalize_question,
} from '../src/core/consult_guard';
import { open_db } from '../src/memory/stores/structured';
import { SpecialistInbox } from '../src/memory/stores/conversations';

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) { console.log(`  ✓ ${name}`); passed++; }
  else { console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); failed++; }
}

const T0 = Date.parse('2026-08-04T21:31:00Z');
const MIN = 60_000;

console.log('→ question identity is whitespace/case-insensitive, not semantic');
check(
  'reflowed + recased question normalizes equal',
  normalize_question('Track the  the clinic StreetMedia\nbillboard?') ===
    normalize_question('track the csu streetmedia billboard?'),
);
check(
  'a reworded question stays distinct',
  normalize_question('track the billboard') !== normalize_question('track that billboard'),
);

console.log('→ depth: a chain can relay once, but never ping-pong');
{
  const g = new ConsultGuard();
  const at_depth = (depth: number) =>
    g.check({ consultor_id: 'kate', consultee_id: 'trainer', question: `q${depth}`, depth, now: T0 });
  check('depth 0 (a normal turn) proceeds', at_depth(0).kind === 'proceed');
  check('depth 1 (inside one consult) proceeds', at_depth(1).kind === 'proceed');
  const v = at_depth(2);
  check('depth 2 is cut (default max 2)', v.kind === 'depth_exceeded');
  check(
    'depth verdict tells the model to answer from what it has',
    consult_verdict_message(v, 'Beatrice').includes('answer from what this turn has already gathered'),
  );
}

console.log('→ repeat: an identical re-ask inside the window is served the prior answer');
{
  const g = new ConsultGuard();
  const ask = (now: number, q = 'Is the the clinic StreetMedia billboard tracked?') =>
    g.check({ consultor_id: 'trainer', consultee_id: 'ruby', question: q, depth: 0, now });
  check('first ask proceeds', ask(T0).kind === 'proceed');
  g.record_answer({
    consultor_id: 'trainer', consultee_id: 'ruby',
    question: 'Is the the clinic StreetMedia billboard tracked?',
    answer: 'Yes — watch-board item bb-csu, updated daily.', now: T0,
  });
  const rep = ask(T0 + 3 * MIN, 'is the  csu streetmedia\nbillboard tracked?');
  check('reflowed identical re-ask 3 min later → repeat', rep.kind === 'repeat');
  check(
    'repeat carries the prior answer verbatim',
    rep.kind === 'repeat' && rep.prior_answer.includes('bb-csu'),
  );
  check(
    'repeat message forbids re-asking and embeds the answer',
    consult_verdict_message(rep, 'Ruby').includes('Do NOT re-ask') &&
      consult_verdict_message(rep, 'Ruby').includes('bb-csu'),
  );
  check('a genuinely different question still proceeds', ask(T0 + 4 * MIN, 'What did council vote last night?').kind === 'proceed');
  check('the same question past the 30-min window proceeds again', ask(T0 + 31 * MIN).kind === 'proceed');
}

console.log('→ failures are NOT cached: a transient dead consult stays retryable');
{
  const g = new ConsultGuard();
  const ask = (now: number) =>
    g.check({ consultor_id: 'kate', consultee_id: 'ruby', question: 'status?', depth: 0, now });
  check('first ask proceeds', ask(T0).kind === 'proceed');
  // consult() skips record_answer when the sub-turn produced no text.
  check('re-ask after an uncached failure proceeds (bounded by rate, not repeat)', ask(T0 + 1 * MIN).kind === 'proceed');
}

console.log('→ rate: the content-agnostic backstop catches reworded hammering');
{
  const g = new ConsultGuard();
  // Six DIFFERENT questions in two minutes — the hash can't tie them, the
  // pair rate cap must.
  let last = g.check({ consultor_id: 'trainer', consultee_id: 'ruby', question: 'q1', depth: 0, now: T0 });
  for (let i = 2; i <= 6; i++) {
    last = g.check({ consultor_id: 'trainer', consultee_id: 'ruby', question: `q${i}`, depth: 0, now: T0 + i * 20_000 });
  }
  check('consults 1–6 inside the window all proceed', last.kind === 'proceed');
  const v7 = g.check({ consultor_id: 'trainer', consultee_id: 'ruby', question: 'q7', depth: 0, now: T0 + 2 * MIN });
  check('the 7th consult to the same peer in 10 min is rate-limited', v7.kind === 'rate_limited');
  check(
    'rate message says to stop and synthesize',
    consult_verdict_message(v7, 'Ruby').includes('Stop consulting Ruby'),
  );
  check(
    'a DIFFERENT pair is untouched (per-pair, not global)',
    g.check({ consultor_id: 'trainer', consultee_id: 'kate', question: 'q1', depth: 0, now: T0 + 2 * MIN }).kind === 'proceed',
  );
  check(
    'attempts age out: the same pair proceeds once the window slides',
    g.check({ consultor_id: 'trainer', consultee_id: 'ruby', question: 'q8', depth: 0, now: T0 + 13 * MIN }).kind === 'proceed',
  );
}

console.log('→ suppressed repeats still count toward rate (hammering escalates)');
{
  const g = new ConsultGuard();
  const ask = (now: number) =>
    g.check({ consultor_id: 'trainer', consultee_id: 'ruby', question: 'same q', depth: 0, now });
  check('first ask proceeds', ask(T0).kind === 'proceed');
  g.record_answer({ consultor_id: 'trainer', consultee_id: 'ruby', question: 'same q', answer: 'the answer', now: T0 });
  let v = ask(T0 + 1 * MIN);
  for (let i = 2; i <= 5; i++) v = ask(T0 + i * MIN);
  check('asks 2–6 are served the cache', v.kind === 'repeat');
  check('ask 7 escalates from cache to the hard rate limit', ask(T0 + 6 * MIN).kind === 'rate_limited');
}

console.log('→ inbox push: an exact duplicate inside the window collapses onto the existing row');
{
  const tmp = mkdtempSync(join(tmpdir(), 'smoke-consult-guard-'));
  const db = open_db(join(tmp, 'test.db'));
  const inbox = new SpecialistInbox(db);
  const msg = {
    from_specialist_id: 'trainer',
    to_specialist_id: 'ruby',
    kind: 'question' as const,
    body_md: 'Is the the clinic StreetMedia billboard tracked?',
  };
  const first = inbox.push(msg);
  const second = inbox.push(msg);
  check('verbatim re-push returns the ORIGINAL id', second === first);
  const rows = inbox.list_for('ruby', 50).filter((r) => r.kind === 'question');
  check('…and inserts no second row', rows.length === 1, `rows=${rows.length}`);

  const different = inbox.push({ ...msg, body_md: 'Is the the clinic StreetMedia billboard tracked? (second look)' });
  check('any textual difference still inserts', different !== first);
  const other_kind = inbox.push({ ...msg, kind: 'flag' as const });
  check('same body under a different kind still inserts', other_kind !== first);
  const other_recipient = inbox.push({ ...msg, to_specialist_id: 'kate' });
  check('same body to a different recipient still inserts', other_recipient !== first);

  process.env.HEARTH_INBOX_DUP_WINDOW_MIN = '0';
  const disabled = inbox.push(msg);
  check('HEARTH_INBOX_DUP_WINDOW_MIN=0 disables the collapse', disabled !== first);
  delete process.env.HEARTH_INBOX_DUP_WINDOW_MIN;
}

console.log('→ env knobs override the defaults');
{
  process.env.HEARTH_CONSULT_MAX_DEPTH = '1';
  process.env.HEARTH_CONSULT_RATE_MAX = '2';
  const g = new ConsultGuard();
  check(
    'HEARTH_CONSULT_MAX_DEPTH=1 cuts at depth 1',
    g.check({ consultor_id: 'a', consultee_id: 'b', question: 'x', depth: 1, now: T0 }).kind === 'depth_exceeded',
  );
  g.check({ consultor_id: 'a', consultee_id: 'b', question: 'x1', depth: 0, now: T0 });
  g.check({ consultor_id: 'a', consultee_id: 'b', question: 'x2', depth: 0, now: T0 });
  check(
    'HEARTH_CONSULT_RATE_MAX=2 blocks the 3rd',
    g.check({ consultor_id: 'a', consultee_id: 'b', question: 'x3', depth: 0, now: T0 }).kind === 'rate_limited',
  );
  delete process.env.HEARTH_CONSULT_MAX_DEPTH;
  delete process.env.HEARTH_CONSULT_RATE_MAX;
}

console.log('');
if (failed > 0) {
  console.error(`${failed} check(s) FAILED (${passed} passed)`);
  process.exit(1);
}
console.log(`all ${passed} checks passed`);
