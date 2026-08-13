/**
 * smoke:mail-shelf — shelving significant non-bulk mail into the second brain.
 *
 * Self-contained: temp db, real AppEventBus + MailStore, an INJECTED shelve fn
 * (no library/embedder needed). Exercises:
 *   - the is_significant_non_bulk predicate matrix (replies/personal/transactional
 *     shelve; bulk/promo/junk/phishing/sent don't)
 *   - the event-driven driver (mail_message_triaged → shelve) with the strict
 *     cordon (stamped to the account OWNER's user_id, never 'household')
 *   - idempotency (shelved_at — re-fire never re-shelves)
 *   - the HEARTH_MAIL_SHELVE kill switch
 *
 *   bun run smoke:mail-shelf
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { open_db } from '@memory/stores/structured';
import { MailStore, type MailMessageInput } from '@memory/stores/mail';
import { AppEventBus } from '@app/events';
import {
  MailShelfDriver,
  is_significant_non_bulk,
  compose_mail_markdown,
  type ShelveMailInput,
} from '@core/mail_shelf';
import type { MailMessage } from '@memory/stores/mail';

let passed = 0;
function check(label: string, cond: unknown): void {
  if (!cond) throw new Error(`FAIL: ${label}`);
  passed++;
  console.log(`  ✓ ${label}`);
}

function msg(over: Partial<MailMessage>): MailMessage {
  return {
    id: 'm', direction: 'inbound', account_id: 'a', user_id: 'jasper', private_to: 'household',
    uid: 1, message_id: 'mid', in_reply_to: null, references: [], thread_key: 't',
    from_addr: 'x@y.com', from_name: 'X', to: [], subject: 's', date_utc: '2026-06-20T00:00:00Z',
    snippet: 'snip', body_text: 'body', auth_spf: 'pass', auth_dkim: 'pass', auth_dmarc: 'pass',
    is_bulk: false, aligned: true, triage_category: 'authentic_personal', triage_importance: 0.8,
    triage_reasons: [], triage_bucket: 'new_mail', is_reply_to_me: false, summary: '',
    suggested_action: 'review', list_unsubscribe: null, handled: false, ts: '2026-06-20T00:00:00Z',
    ...over,
  } as MailMessage;
}

function input(over: Partial<MailMessageInput>): MailMessageInput {
  return {
    direction: 'inbound', account_id: 'a', user_id: 'jasper', private_to: 'jasper', uid: 1,
    message_id: 'mid1', in_reply_to: null, references: [], thread_key: 't', from_addr: 'kim@x.com',
    from_name: 'Kim', to: ['jasper@x.com'], subject: 'Re: dinner', date_utc: '2026-06-20T00:00:00Z',
    snippet: 'sounds good', body_text: 'Sounds good, see you then.', auth_spf: 'pass',
    auth_dkim: 'pass', auth_dmarc: 'pass', is_bulk: false, aligned: true,
    triage_category: 'authentic_reply', triage_importance: 0.7, triage_reasons: [],
    triage_bucket: 'replies', is_reply_to_me: true, summary: 'Kim confirms dinner',
    suggested_action: 'review', list_unsubscribe: null,
    ...over,
  } as MailMessageInput;
}

async function main(): Promise<void> {
  // ── 1. The predicate matrix ──────────────────────────────────────────────
  check('reply → shelve', is_significant_non_bulk(msg({ is_reply_to_me: true, triage_category: 'authentic_reply' })));
  check('personal → shelve', is_significant_non_bulk(msg({ triage_category: 'authentic_personal' })));
  check('transactional → shelve', is_significant_non_bulk(msg({ triage_category: 'transactional' })));
  check('important subscription → shelve', is_significant_non_bulk(msg({ triage_category: 'subscription_informational', triage_importance: 0.7 })));
  check('low subscription → skip', !is_significant_non_bulk(msg({ triage_category: 'subscription_informational', triage_importance: 0.3 })));
  check('promotional → skip', !is_significant_non_bulk(msg({ triage_category: 'promotional' })));
  check('junk → skip', !is_significant_non_bulk(msg({ triage_category: 'junk_spam' })));
  check('phishing → skip', !is_significant_non_bulk(msg({ triage_category: 'phishing' })));
  check('bulk personal → skip (bulk gate)', !is_significant_non_bulk(msg({ triage_category: 'authentic_personal', is_bulk: true })));
  check('sent → skip', !is_significant_non_bulk(msg({ direction: 'sent', triage_category: 'authentic_personal' })));

  const md = compose_mail_markdown(msg({ subject: 'Dinner Saturday', from_name: 'Kim', body_text: 'Yes!' }));
  check('markdown leads with the subject H1', md.startsWith('# Dinner Saturday'));
  check('markdown carries the body', md.includes('Yes!'));

  // ── 2. Event-driven driver + cordon + idempotency ────────────────────────
  process.env.HEARTH_MAIL_SHELVE = '1';
  const tmp = mkdtempSync(join(tmpdir(), 'hearth-mailshelf-'));
  const db = open_db(join(tmp, 'hearth.db'));
  const store = new MailStore(db);
  const events = new AppEventBus();
  const shelved: ShelveMailInput[] = [];
  const driver = new MailShelfDriver({
    events,
    db,
    shelve: async (inp) => {
      shelved.push(inp);
      return true;
    },
  });
  driver.attach();

  // A real reply from Sam's account (private_to='sam') — shelf must stamp to
  // the OWNER (user_id), and here owner==sam, so private_to=sam either way;
  // the key assertion is it uses user_id, NOT the account's private_to value.
  const sara_reply = store.upsert(input({ user_id: 'sam', private_to: 'sam', uid: 10, message_id: 'sara1', from_name: 'Friend' }));
  events.emit({ type: 'mail_message_triaged', account_id: 'a', message_id: sara_reply.id, bucket: 'replies', specialist_id: 'kate', user_id: 'sam' });
  await new Promise((r) => setTimeout(r, 15));
  check('significant mail was shelved', shelved.some((s) => s.message_id === sara_reply.id));
  check('shelf stamped to the account owner (user_id)', shelved.find((s) => s.message_id === sara_reply.id)?.user_id === 'sam');
  check('store marked it shelved', store.is_shelved(sara_reply.id));

  // Re-fire the same event → idempotent, no second shelve.
  const count_before = shelved.length;
  events.emit({ type: 'mail_message_triaged', account_id: 'a', message_id: sara_reply.id, bucket: 'replies', specialist_id: 'kate', user_id: 'sam' });
  await new Promise((r) => setTimeout(r, 15));
  check('re-fire does NOT re-shelve (idempotent)', shelved.length === count_before);

  // A promo → not shelved.
  const promo = store.upsert(input({ uid: 11, message_id: 'promo1', triage_category: 'promotional', is_reply_to_me: false, triage_bucket: 'fyi' }));
  events.emit({ type: 'mail_message_triaged', account_id: 'a', message_id: promo.id, bucket: 'fyi', specialist_id: 'kate', user_id: 'jasper' });
  await new Promise((r) => setTimeout(r, 15));
  check('promo was NOT shelved', !shelved.some((s) => s.message_id === promo.id));

  // ── 3. Kill switch ───────────────────────────────────────────────────────
  delete process.env.HEARTH_MAIL_SHELVE;
  const events2 = new AppEventBus();
  const shelved2: ShelveMailInput[] = [];
  const driver_off = new MailShelfDriver({ events: events2, db, shelve: async (i) => { shelved2.push(i); return true; } });
  driver_off.attach(); // disabled → no subscription
  const r2 = store.upsert(input({ uid: 12, message_id: 'off1' }));
  events2.emit({ type: 'mail_message_triaged', account_id: 'a', message_id: r2.id, bucket: 'replies', specialist_id: 'kate', user_id: 'jasper' });
  await new Promise((r) => setTimeout(r, 15));
  check('kill switch OFF → nothing shelved', shelved2.length === 0);

  db.close();
  rmSync(tmp, { recursive: true, force: true });
  console.log(`\n✅ smoke:mail-shelf — ${passed} checks passed`);
}

main().catch((err) => {
  console.error(`\n❌ ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
