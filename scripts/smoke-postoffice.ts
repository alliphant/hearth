/**
 * smoke:postoffice — self-contained test of Kate's Post Office stack.
 *
 * No network, no live IMAP/SMTP, no real model. Covers:
 *   - mail_triage: derive_structural matrix, to_bucket mapping, triage_message
 *     fail-open (no LLM → safe default; verified reply → replies) + a mock-LLM
 *     judge path (emergent category → bucket).
 *   - MailAccounts: create, redaction (secrets never returned), set ('' password
 *     = keep), clear_secret, set_status, delete, cordon visibility.
 *   - MailStore: upsert idempotency on (account_id, uid), reply-threading
 *     (sent_ids_matching → is_reply_to_me), recent_sent_bodies (the style seam).
 *   - mail_ingest: sync_account through the _test_set_fetcher seam with canned
 *     MIME — a sent message + an inbound reply (→ replies), a list newsletter
 *     (→ fyi), a reservation (→ needs_you); idempotent re-sync.
 *   - the /api/specialists/:id/postoffice route in-process behind fake auth:
 *     owner GET (both accounts), household GET (cordon — owner account hidden),
 *     owner-only create (household → 403), unauth → 401, no read_mail → 404.
 *   - kill switch: mail_enabled() false unless HEARTH_MAIL=1.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { open_db } from '../src/memory/stores/structured';
import { SpecialistRegistry } from '../src/core/specialist';
import { load_extra_capabilities } from '../src/core/capabilities';
import { note_visible_to_caller } from '../src/memory/private_to';
import { MailAccounts } from '../src/memory/stores/mail_accounts';
import { MailStore } from '../src/memory/stores/mail';
import {
  derive_structural,
  to_bucket,
  triage_message,
  has_preheader_padding,
  type TriageInput,
} from '../src/core/mail_triage';
import type { LLMRouter as _LLMRouterT } from '../src/core/llm';
import { sync_account, ingest_one, _test_set_fetcher, type RawMessage } from '../src/core/mail_ingest';
import { MailOrders, advance_status } from '../src/memory/stores/mail_orders';
import { tracking_url_for, normalize_carrier } from '../src/core/mail_orders_extract';
import { mail_enabled } from '../src/core/mail_idle';
import { create_postoffice_router } from '../src/app/routes/postoffice';
import type { LLMRouter } from '../src/core/llm';
import type { MemoryClient } from '../src/memory/client';

let failures = 0;
function check(label: string, ok: boolean, detail?: string): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok || !detail ? '' : ` — ${detail}`}`);
  if (!ok) failures++;
}

load_extra_capabilities(join(import.meta.dir, '../config/capabilities.yaml'));
const dir = mkdtempSync(join(tmpdir(), 'hearth-postoffice-'));

// ── mock planner LLM for triage (deterministic by evidence) ─────────────
const mock_llm = {
  for_role() {
    return {
      defaults: {},
      provider: {
        async complete(req: { messages: { role: string; content: string }[] }) {
          const system = req.messages[0]?.content ?? '';
          const text = req.messages[req.messages.length - 1]?.content ?? '';
          // Order/shipment extractor prompt → return extracted order JSON.
          if (/Extract order/.test(system)) {
            if (/reservation|table for/i.test(text)) return { content: JSON.stringify({ is_order: false }) };
            const order_number = text.match(/ORD-\d+/)?.[0] ?? null;
            const tracking = text.match(/1Z[0-9A-Z]+/)?.[0] ?? null;
            if (!order_number && !tracking) return { content: JSON.stringify({ is_order: false }) };
            let kind = 'update';
            let status = 'unknown';
            if (/delivered/i.test(text)) { kind = 'delivery'; status = 'delivered'; }
            else if (/shipped|tracking/i.test(text)) { kind = 'shipment'; status = 'shipped'; }
            else if (/confirmed|placed/i.test(text)) { kind = 'confirmation'; status = 'ordered'; }
            return {
              content: JSON.stringify({
                is_order: true, kind, merchant: 'Amazon', order_number,
                order_total: text.match(/\$[\d.]+/)?.[0] ?? null,
                items: /shoes/i.test(text) ? 'Trail running shoes' : null,
                carrier: /UPS/.test(text) ? 'UPS' : null, tracking_number: tracking, tracking_url: null,
                status, expected_delivery: text.match(/Arriving ([^.\n]+)/)?.[1]?.trim() ?? null,
              }),
            };
          }
          // Otherwise: the triage judge (v2 evidence says bulk=yes/no, templated=yes/no).
          const bulk = /bulk=yes/.test(text);
          let v: Record<string, unknown>;
          if (bulk && /garden|announce|newsletter|opening/i.test(text)) {
            v = { category: 'subscription_informational', importance: 0.4, needs_action: false, summary: 'Community garden announcement.', suggested_action: 'review' };
          } else if (bulk) {
            v = { category: 'promotional', importance: 0.2, needs_action: false, summary: 'Marketing.', suggested_action: 'unsubscribe' };
          } else if (/order|shipped|delivered|tracking|reservation|confirmed|booking/i.test(text)) {
            v = { category: 'transactional', importance: 0.9, needs_action: true, summary: 'Order/reservation to confirm.', suggested_action: 'confirm' };
          } else {
            v = { category: 'authentic_personal', importance: 0.6, needs_action: false, summary: 'A person wrote you.', suggested_action: 'reply' };
          }
          return { content: JSON.stringify(v) };
        },
      },
    };
  },
} as unknown as LLMRouter;

// ── 1. structural pre-filter ────────────────────────────────────────────
console.log('\n→ derive_structural');
{
  const v = derive_structural({
    authentication_results: 'mx.google.com; spf=pass; dkim=pass; dmarc=pass',
    from_addr: 'a@example.com',
    return_path: 'a@example.com',
  });
  check('parses spf/dkim/dmarc=pass', v.spf === 'pass' && v.dkim === 'pass' && v.dmarc === 'pass');
  check('aligned on dmarc pass', v.aligned === true);
  check('not bulk without list headers', v.is_bulk === false);

  const bulk = derive_structural({
    authentication_results: 'spf=pass dkim=pass dmarc=pass',
    list_id: '<news.city.gov>',
    list_unsubscribe: '<mailto:unsub@city.gov>',
    precedence: 'bulk',
    from_addr: 'news@city.gov',
  });
  check('list headers → is_bulk', bulk.is_bulk === true && bulk.has_list_unsub === true);

  const spoof = derive_structural({
    authentication_results: 'spf=fail dkim=fail dmarc=fail',
    from_addr: 'ceo@yourbank.com',
    return_path: 'x@sketchy.ru',
  });
  check('dmarc fail + mismatched return-path → not aligned', spoof.dmarc === 'fail' && spoof.aligned === false);
}

// ── 2. to_bucket mapping ────────────────────────────────────────────────
console.log('\n→ to_bucket');
check('verified reply → replies', to_bucket('authentic_personal', 0.5, false, true) === 'replies');
check('junk → junk', to_bucket('junk_spam', 0.9, true, false) === 'junk');
check('phishing → junk', to_bucket('phishing', 0.9, false, false) === 'junk');
check('low promo → fyi', to_bucket('promotional', 0.2, false, false) === 'fyi');
check('pertinent subscription upgrades → needs_you', to_bucket('subscription_informational', 0.8, false, false) === 'needs_you');
check('actionable transactional → needs_you', to_bucket('transactional', 0.9, true, false) === 'needs_you');
check('routine new mail → new_mail', to_bucket('authentic_personal', 0.3, false, false) === 'new_mail');

// ── 3. triage_message fail-open + judge ─────────────────────────────────
console.log('\n→ triage_message');
{
  const base: TriageInput = {
    from_addr: 'x@y.com', from_name: 'X', subject: 'hi', snippet: 'hi', body_text: 'hi there',
    structural: derive_structural({ from_addr: 'x@y.com' }), is_reply_to_me: false,
  };
  const noLLM = await triage_message(base);
  check('no LLM → safe default (unknown/new_mail, visible)', noLLM.category === 'unknown' && noLLM.bucket === 'new_mail' && noLLM.used_llm === false);
  const reply = await triage_message({ ...base, is_reply_to_me: true });
  check('verified reply → replies, no LLM needed', reply.bucket === 'replies' && reply.used_llm === false);
  const judged = await triage_message(base, mock_llm);
  check('judge runs for non-reply', judged.used_llm === true && judged.category === 'authentic_personal');
  // Misdirected detection: given the account owner's name(s), a creditor notice
  // for a DIFFERENT person → not_me. Proves owner_names reach the judge.
  const misd = await triage_message(
    {
      ...base,
      from_addr: 'admin@halstedfinancialservices.com', from_name: 'Halsted Financial',
      subject: 'Re: Original Creditor: Snap Finance Llc',
      body_text: 'A creditor account for Jasper Fenwick requires immediate response.',
      owner_names: ['Jasper Doe', 'jasperdoe@me.com'],
    },
    mock_llm,
  );
  check('owner-mismatch creditor notice → not_me (deterministic, not the judge)', misd.suggested_action === 'not_me');
  // Precision: a notice for the owner's OWN full name (matching surname) is NOT
  // flagged — the deterministic check requires first-match + surname-mismatch.
  const mine = await triage_message(
    {
      ...base, from_addr: 'admin@bank.com', from_name: 'Bank',
      subject: 'Your statement', body_text: 'An account statement for Jasper Doe is ready.',
      owner_names: ['Jasper Doe', 'jasperdoe@me.com'],
    },
    mock_llm,
  );
  check("matching surname (owner's own name) → NOT not_me", mine.suggested_action !== 'not_me');
  // The REAL shape: the addressee LEADS ("Jasper Fenwick - Re: …", no preposition)
  // and the surname source is the MAILBOX address (display name is just "Jasper").
  const real = await triage_message(
    {
      ...base, from_addr: 'admin@connect.halstedfinancialservices.com', from_name: 'Halsted Financial',
      subject: 'Re: Original Creditor: Snap Finance Llc',
      body_text: 'Jasper Fenwick - (Re: Original Creditor: Snap Finance Llc) - response requested',
      owner_names: ['you@example.com', 'Jasper'],
    },
    mock_llm,
  );
  check('leading-name creditor notice (mailbox = surname source) → not_me', real.suggested_action === 'not_me');
  // Guard: with ONLY a bare first name (no surname source) we CANNOT tell a
  // misdirected "Jasper Fenwick" from his own "Jasper Doe" → do NOT flag.
  const bare = await triage_message(
    { ...base, subject: 'x', body_text: 'Jasper Fenwick - response requested', owner_names: ['Jasper'] },
    mock_llm,
  );
  check('bare first name only (no surname source) → NOT flagged (no false positive)', bare.suggested_action !== 'not_me');
  // Without owner_names the same mail is NOT flagged not_me (no false positives
  // when we don't know who the owner is).
  const no_owner = await triage_message(
    {
      ...base, from_addr: 'admin@halstedfinancialservices.com', from_name: 'Halsted Financial',
      subject: 'Re: Original Creditor: Snap Finance Llc',
      body_text: 'A creditor account for Jasper Fenwick requires immediate response.',
    },
    mock_llm,
  );
  check('no owner_names → no misdirected flag', no_owner.suggested_action !== 'not_me');
}

// ── 3b. triage v2 — bulk/templated/platform can never be personal ────────
console.log('\n→ triage v2 hardening');
{
  check('preheader padding flagged (zero-width run)', has_preheader_padding('Hi ‌ ‌ ‌ ‌ ‌ ‌ real') === true);
  check('normal text not flagged', has_preheader_padding('Hi, just checking in about Tuesday.') === false);

  // A credulous judge calls a mass send "personal"; the backstop coerces it.
  const always_personal = {
    for_role: () => ({
      defaults: {},
      provider: { async complete() { return { content: JSON.stringify({ category: 'authentic_personal', importance: 0.9, needs_action: true, summary: 'looks personal', suggested_action: 'reply' }) }; } },
    }),
  } as unknown as _LLMRouterT;

  // The Fetterman class: a political blast WITH List-Unsubscribe (is_bulk).
  const blastStruct = derive_structural({ from_addr: 'team@campaign.org', list_unsubscribe: '<https://campaign.org/unsub>', authentication_results: 'spf=pass dkim=pass dmarc=pass' });
  const blast = await triage_message({ from_addr: 'team@campaign.org', from_name: 'Team Fetterman', subject: "He's dangerous", snippet: '...', body_text: 'Chip in now.', structural: blastStruct, is_reply_to_me: false }, always_personal);
  check('list blast coerced off personal (not authentic_*)', blast.category !== 'authentic_personal' && blast.category !== 'authentic_reply');
  check('coerced blast is low importance (filtered)', blast.importance <= 0.3);
  check('coerced blast suggests unsubscribe', blast.suggested_action === 'unsubscribe');

  // The Vumedi class: a templated platform notification (no list header but padded).
  const tmpl = await triage_message({ from_addr: 'noreply@vumedi.com', from_name: 'Jeremie Calais', subject: 'New video', snippet: '...', body_text: 'Click here to view on Vumedi.', structural: derive_structural({ from_addr: 'noreply@vumedi.com' }), is_reply_to_me: false, looks_templated: true }, always_personal);
  check('templated platform note coerced off personal', tmpl.category !== 'authentic_personal');
}

// ── 4. MailAccounts ─────────────────────────────────────────────────────
console.log('\n→ MailAccounts');
const db = open_db(join(dir, 'smoke.db'));
const accounts = new MailAccounts(db);
const owner_acct = accounts.create({
  user_id: 'jasper', private_to: 'owner', display_name: 'Jasper iCloud', provider: 'icloud',
  imap_user: 'jasper@me.com', imap_password: 'app-pass-secret', smtp_user: 'jasper@me.com', smtp_password: 'smtp-secret',
});
check('preset filled imap_host', accounts.get(owner_acct)?.imap_host === 'imap.mail.me.com');
{
  const red = accounts.get_redacted(owner_acct)!;
  check('redacted has no secret values', !('imap_password' in red) && !('smtp_password' in red));
  check('redacted reports secrets set', red.imap_password_set === true && red.smtp_password_set === true);
}
{
  const changed = accounts.set(owner_acct, { display_name: 'Jasper Apple', imap_password: '' });
  check("set: '' password is kept, display changes", changed.includes('display_name') && !changed.includes('imap_password'));
  check('password still set after blank submit', accounts.get(owner_acct)?.imap_password === 'app-pass-secret');
}
accounts.clear_secret(owner_acct, 'smtp_password');
check('clear_secret removes it', accounts.get_redacted(owner_acct)?.smtp_password_set === false);
accounts.set_status(owner_acct, { connection_status: 'ok', last_synced_at: new Date().toISOString() });
check('set_status updates health', accounts.get(owner_acct)?.connection_status === 'ok');

const hh_acct = accounts.create({
  user_id: 'jasper', private_to: 'household', display_name: 'Family Gmail', provider: 'gmail',
  imap_user: 'family@gmail.com', imap_password: 'fam-pass',
});
// cordon
check('owner sees owner account', note_visible_to_caller('owner', { user_id: 'jasper', tier: 'owner' }));
check('household member cannot see owner account', !note_visible_to_caller('owner', { user_id: 'sam', tier: 'household' }));
check('household member sees household account', note_visible_to_caller('household', { user_id: 'sam', tier: 'household' }));

// ── Date seeds are SHIFTED to the present ────────────────────────────────
// The digest window is now−30d, so fixed calendar seeds rot out of it (this
// smoke went red on its own on 2026-07-19, failing every PR's ci-ring). A
// constant whole-day shift lands the "Jun 19/20 2026" fixture timeline 1-2
// days before the REAL now with every relative relationship (thread order,
// order cadence, sync cursors, digest recency) intact; whole days keep the
// HH:MM structure readable in failures.
const SHIFT_MS = Math.floor((Date.now() - Date.parse('2026-06-20T12:00:00Z')) / 86_400_000) * 86_400_000;
/** Shifted ISO instant (for date_utc / new Date sites). */
const siso = (iso: string): string => new Date(Date.parse(iso) + SHIFT_MS).toISOString();
/** Shifted RFC-822 Date header value (weekday recomputed correctly). */
const sdate = (iso: string): string => new Date(Date.parse(iso) + SHIFT_MS).toUTCString().replace(/GMT$/, '+0000');


// ── 5. MailStore threading + idempotency + style seam ───────────────────
console.log('\n→ MailStore');
const store = new MailStore(db);
store.upsert({
  direction: 'sent', account_id: owner_acct, user_id: 'jasper', private_to: 'owner', uid: 1,
  message_id: '<sent1@me.com>', in_reply_to: null, references: [], thread_key: '<sent1@me.com>',
  from_addr: 'jasper@me.com', from_name: 'Jasper', to: ['bob@corp.com'], subject: 'Question', date_utc: siso('2026-06-19T10:00:00Z'),
  snippet: 'hey bob', body_text: 'Hey Bob, can you send the doc when you get a sec? Thanks, Jasper',
  auth_spf: 'none', auth_dkim: 'none', auth_dmarc: 'none', is_bulk: false, aligned: true,
  triage_category: 'sent', triage_importance: 0, triage_reasons: [], triage_bucket: 'new_mail', is_reply_to_me: false,
  summary: '', suggested_action: 'dismiss', list_unsubscribe: null,
});
check('sent_ids_matching finds the sent id', store.sent_ids_matching('jasper', ['<sent1@me.com>', '<other@x>']).length === 1);
check('recent_sent_bodies feeds the style corpus', store.recent_sent_bodies('jasper', '2026-01-01T00:00:00Z', 10).some((m) => m.content_md.includes('Hey Bob')));
{
  const first = store.upsert({
    direction: 'inbound', account_id: owner_acct, user_id: 'jasper', private_to: 'owner', uid: 10,
    message_id: '<r1@corp.com>', in_reply_to: '<sent1@me.com>', references: ['<sent1@me.com>'], thread_key: '<sent1@me.com>',
    from_addr: 'bob@corp.com', from_name: 'Bob', to: ['jasper@me.com'], subject: 'Re: Question', date_utc: siso('2026-06-19T12:00:00Z'),
    snippet: 'sure', body_text: 'Sure, attached.', auth_spf: 'pass', auth_dkim: 'pass', auth_dmarc: 'pass',
    is_bulk: false, aligned: true, triage_category: 'authentic_reply', triage_importance: 0.75, triage_reasons: ['reply'],
    triage_bucket: 'replies', is_reply_to_me: true,
    summary: 'Bob replied.', suggested_action: 'reply', list_unsubscribe: null,
  });
  check('first insert is new', first.is_new === true);
  const again = store.upsert({
    direction: 'inbound', account_id: owner_acct, user_id: 'jasper', private_to: 'owner', uid: 10,
    message_id: '<r1@corp.com>', in_reply_to: '<sent1@me.com>', references: ['<sent1@me.com>'], thread_key: '<sent1@me.com>',
    from_addr: 'bob@corp.com', from_name: 'Bob', to: ['jasper@me.com'], subject: 'Re: Question', date_utc: siso('2026-06-19T12:00:00Z'),
    snippet: 'sure', body_text: 'Sure, attached.', auth_spf: 'pass', auth_dkim: 'pass', auth_dmarc: 'pass',
    is_bulk: false, aligned: true, triage_category: 'authentic_reply', triage_importance: 0.75, triage_reasons: ['reply'],
    triage_bucket: 'replies', is_reply_to_me: true,
    summary: 'Bob replied.', suggested_action: 'reply', list_unsubscribe: null,
  });
  check('re-upsert same (account,uid) is idempotent', again.is_new === false && again.id === first.id);
  check('thread() returns both sides oldest-first', store.thread('<sent1@me.com>').length === 2 && store.thread('<sent1@me.com>')[0]!.direction === 'sent');
}

// ── 6. mail_ingest via the fetcher seam ─────────────────────────────────
console.log('\n→ mail_ingest sync (seam)');
{
  const mime = (lines: string[], body: string) => `${lines.join('\r\n')}\r\n\r\n${body}`;
  const sent: RawMessage[] = [
    { uid: 100, source: mime(['From: Jasper <jasper@me.com>', 'To: Carol <carol@corp.com>', 'Subject: Project ping', 'Message-ID: <s100@me.com>', `Date: ${sdate('2026-06-19T09:00:00Z')}`], 'Carol — quick question on the timeline. — J') },
  ];
  const inbox: RawMessage[] = [
    { uid: 200, source: mime(['From: Carol <carol@corp.com>', 'To: jasper@me.com', 'Subject: Re: Project ping', 'Message-ID: <i200@corp.com>', 'In-Reply-To: <s100@me.com>', 'References: <s100@me.com>', 'Authentication-Results: mx; spf=pass; dkim=pass; dmarc=pass', `Date: ${sdate('2026-06-19T11:00:00Z')}`], "Sure — here's the timeline.") },
    { uid: 201, source: mime(['From: City of Pleasantville <news@citygov.com>', 'To: jasper@me.com', 'Subject: Mill Creek Gardens opening this weekend', 'Message-ID: <n201@citygov.com>', 'List-Id: <news.citygov.com>', 'List-Unsubscribe: <mailto:unsub@citygov.com>', 'Precedence: bulk', 'Authentication-Results: mx; spf=pass; dkim=pass; dmarc=pass', `Date: ${sdate('2026-06-19T08:00:00Z')}`], 'Join us for the seasonal garden opening at Mill Creek.') },
    { uid: 202, source: mime(['From: OpenTable <confirm@opentable.com>', 'To: jasper@me.com', 'Subject: Your reservation is confirmed', 'Message-ID: <c202@opentable.com>', 'Authentication-Results: mx; spf=pass; dkim=pass; dmarc=pass', `Date: ${sdate('2026-06-19T07:00:00Z')}`], 'Your booking for 2 on Saturday is confirmed.') },
  ];
  _test_set_fetcher(async () => ({ inbox, sent }));
  const r1 = await sync_account(accounts.get(hh_acct)!, accounts, { db, llm: mock_llm }, { now: new Date(Date.parse('2026-06-19T13:00:00Z') + SHIFT_MS) });
  check('sync ingested 3 inbound + 1 sent', r1.inbox_new === 3 && r1.sent_new === 1, JSON.stringify(r1));
  check('sync set status ok', r1.status === 'ok');

  const reply = store.list({ account_ids: [hh_acct], buckets: ['replies'], since: '2026-01-01T00:00:00Z' });
  check('reply threaded → replies + is_reply_to_me', reply.length === 1 && reply[0]!.is_reply_to_me === true);
  const fyi = store.list({ account_ids: [hh_acct], buckets: ['fyi'], since: '2026-01-01T00:00:00Z' });
  check('city newsletter → fyi (subscription)', fyi.length === 1 && fyi[0]!.from_addr === 'news@citygov.com');
  const needs = store.list({ account_ids: [hh_acct], buckets: ['needs_you'], since: '2026-01-01T00:00:00Z' });
  check('reservation → needs_you', needs.length === 1 && needs[0]!.from_addr === 'confirm@opentable.com');

  const r2 = await sync_account(accounts.get(hh_acct)!, accounts, { db, llm: mock_llm }, { now: new Date(Date.parse('2026-06-19T13:05:00Z') + SHIFT_MS) });
  check('re-sync is idempotent (0 new)', r2.inbox_new === 0 && r2.sent_new === 0, JSON.stringify(r2));
  _test_set_fetcher(null);
}

// ── 6b. Orders / Trackables ─────────────────────────────────────────────
console.log('\n→ orders / trackables');
{
  check('normalize_carrier maps UPS', normalize_carrier('UPS Ground') === 'ups');
  check('tracking_url_for synthesizes a UPS link', (tracking_url_for('UPS', '1Z999AA10123456784', null) ?? '').includes('ups.com') && (tracking_url_for('UPS', '1Z999AA10123456784', null) ?? '').includes('1Z999AA10123456784'));
  check('tracking_url_for prefers the email link', tracking_url_for('UPS', '1Z9', 'https://track.amazon.com/abc') === 'https://track.amazon.com/abc');
  check('advance_status never regresses', advance_status('shipped', 'ordered') === 'shipped' && advance_status('shipped', 'delivered') === 'delivered');

  // Pipeline: ingest a confirmation → shipment → delivery for one order on the
  // OWNER account (private_to owner) via the mock extractor; they MERGE.
  const mime = (lines: string[], body: string) => `${lines.join('\r\n')}\r\n\r\n${body}`;
  const acct = accounts.get(owner_acct)!;
  const deps = { db, llm: mock_llm };
  const now = new Date(Date.parse('2026-06-20T12:00:00Z') + SHIFT_MS);
  await ingest_one(mime(['From: Amazon <auto-confirm@amazon.com>', 'To: jasper@me.com', 'Subject: Your Amazon order ORD-123 is confirmed', 'Message-ID: <oc1@amazon.com>', 'Authentication-Results: mx; spf=pass; dkim=pass; dmarc=pass', `Date: ${sdate('2026-06-20T09:00:00Z')}`], 'Order ORD-123 confirmed. Trail running shoes. Total $84.20 charged today.'), acct, 300, 'inbound', deps, now);
  await ingest_one(mime(['From: Amazon <ship@amazon.com>', 'To: jasper@me.com', 'Subject: Your Amazon order ORD-123 has shipped', 'Message-ID: <os1@amazon.com>', 'Authentication-Results: mx; spf=pass; dkim=pass; dmarc=pass', `Date: ${sdate('2026-06-20T10:00:00Z')}`], 'Shipped via UPS. Tracking 1Z999AA10123456784. Arriving Tue Jun 24.'), acct, 301, 'inbound', deps, now);
  await ingest_one(mime(['From: Amazon <ship@amazon.com>', 'To: jasper@me.com', 'Subject: Your Amazon order ORD-123 was delivered', 'Message-ID: <od1@amazon.com>', 'Authentication-Results: mx; spf=pass; dkim=pass; dmarc=pass', `Date: ${sdate('2026-06-20T18:00:00Z')}`], 'Your package was delivered.'), acct, 302, 'inbound', deps, now);

  const orders = new MailOrders(db).list({ user_ids: ['jasper'] });
  const amz = orders.find((o) => o.order_number === 'ORD-123');
  check('three emails merged into ONE order', orders.length === 1 && !!amz, `n=${orders.length}`);
  check('order status advanced to delivered', amz?.status === 'delivered');
  check('order merchant + total + items extracted', amz?.merchant === 'Amazon' && amz?.order_total === '$84.20' && amz?.items === 'Trail running shoes');
  check('one shipment with UPS tracking + synthesized link', amz?.shipments.length === 1 && amz?.shipments[0]!.tracking_number === '1Z999AA10123456784' && (amz?.shipments[0]!.tracking_url ?? '').includes('ups.com'));
  check('all three source emails recorded', (amz?.source_message_ids.length ?? 0) === 3);
  check('order is cordoned private_to owner (from the account)', amz?.private_to === 'owner');
  check('reservation did NOT create an order (is_order false)', orders.every((o) => o.order_number === 'ORD-123'));
}

// ── 7. the route, in-process ────────────────────────────────────────────
console.log('\n→ /api/specialists/:id/postoffice');
const spec_dir = join(dir, 'specialists');
mkdirSync(spec_dir, { recursive: true });
writeFileSync(
  join(spec_dir, 'kate.yaml'),
  'id: kate\nname: Kate\nrole: Fixture\nvoice: warm\npersona: |\n  Fixture persona for the post office smoke. Long enough to pass.\nproactive:\n  mode: reactive\ncapabilities:\n  read_mail: true\n  ingest_mail: true\n',
);
writeFileSync(
  join(spec_dir, 'vivian.yaml'),
  'id: vivian\nname: Vivian\nrole: Fixture\nvoice: warm\npersona: |\n  Fixture persona without mail access for the post office smoke. Long enough.\nproactive:\n  mode: reactive\ncapabilities:\n  read_vault: true\n',
);
const specialists = new SpecialistRegistry(spec_dir);
const memory_stub = { log_action: () => 'audit_smoke' } as unknown as MemoryClient;

let current_user: { id: string; tier: string } | null = { id: 'jasper', tier: 'owner' };
const app = new Hono();
app.use('*', async (c, next) => {
  if (current_user) c.set('user', current_user as never);
  await next();
});
app.route('/api/specialists', create_postoffice_router({ db, memory: memory_stub, specialists, llm: mock_llm }));

const req = async (method: string, path: string, body?: unknown) => {
  const res = await app.request(path, {
    method,
    ...(body ? { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } } : {}),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};

{
  current_user = { id: 'jasper', tier: 'owner' };
  const { status, body } = await req('GET', '/api/specialists/kate/postoffice');
  check('owner GET 200', status === 200);
  check('owner sees both accounts', (body?.accounts ?? []).length === 2);
  check('GET exposes no secret values', JSON.stringify(body).includes('app-pass-secret') === false && JSON.stringify(body).includes('fam-pass') === false);
  check('owner can_configure', body?.can_configure === true);
  const bucketNames = (body?.buckets ?? []).map((b: { bucket: string }) => b.bucket);
  check('all five lanes present', ['needs_you', 'replies', 'new_mail', 'fyi', 'junk'].every((b) => bucketNames.includes(b)));
  check('owner orders[] includes the tracked order', (body?.orders ?? []).some((o: { order_number: string }) => o.order_number === 'ORD-123'));
  // v2 digest: the primary surface — what needs you, filtered, with summaries.
  const digest = body?.digest ?? [];
  check('digest present (the needs-you surface)', Array.isArray(digest));
  check('digest items carry summary + suggested_action', digest.every((m: Record<string, unknown>) => 'summary' in m && 'suggested_action' in m));
  check('digest EXCLUDES the bulk city newsletter (filtered, not dumped)', digest.every((m: { from: string }) => m.from !== 'news@citygov.com'));
  check('digest includes the reply', digest.some((m: { from: string }) => m.from === 'carol@corp.com'));
  check('filtered_count counts the bulk kept out', (body?.filtered_count ?? 0) >= 1);

  // Dismiss removes an item from the digest.
  const target = digest.find((m: { from: string }) => m.from === 'carol@corp.com');
  if (target) {
    // Open (read full) returns the body, cordon-checked.
    const opened = await req('GET', `/api/specialists/kate/postoffice/messages/${target.id}`);
    check('open message → 200 + body', opened.status === 200 && typeof opened.body?.body === 'string' && opened.body.from === 'carol@corp.com');
    // Cordon: a non-owner cannot open an OWNER-PRIVATE message.
    const owner_msg = digest.find((m: { account_id: string }) => m.account_id === owner_acct);
    if (owner_msg) {
      current_user = { id: 'kim', tier: 'household' };
      const stolen = await req('GET', `/api/specialists/kate/postoffice/messages/${owner_msg.id}`);
      check("non-owner can't open an owner-private message → 403 (cordon)", stolen.status === 403);
      current_user = { id: 'jasper', tier: 'owner' };
    }
    const dz = await req('POST', `/api/specialists/kate/postoffice/messages/${target.id}/handled`, { handled: true });
    check('dismiss → 200', dz.status === 200 && dz.body?.handled === true);
    const after = await req('GET', '/api/specialists/kate/postoffice');
    check('dismissed item drops from the digest', (after.body?.digest ?? []).every((m: { id: string }) => m.id !== target.id));
  } else {
    check('dismiss target found', false, 'no reply in digest to dismiss');
  }

  // "Not me" — a misdirected message: mark handled AND LEARN to suppress the
  // sender, so OTHER (and future) mail from them is filtered, not just the one
  // tapped. Seed a second, unhandled message from the same sender to prove it.
  store.upsert({
    direction: 'inbound', account_id: hh_acct, user_id: 'jasper', private_to: 'household', uid: 777,
    message_id: '<ot777@opentable.com>', in_reply_to: null, references: [], thread_key: '<ot777@opentable.com>',
    from_addr: 'confirm@opentable.com', from_name: 'OpenTable', to: ['jasper@me.com'], subject: 'Another reservation',
    date_utc: siso('2026-06-19T07:30:00Z'), snippet: 'booking', body_text: 'Your other booking is confirmed.',
    auth_spf: 'pass', auth_dkim: 'pass', auth_dmarc: 'pass', is_bulk: false, aligned: true,
    triage_category: 'transactional', triage_importance: 0.9, triage_reasons: [], triage_bucket: 'needs_you',
    is_reply_to_me: false, summary: 'Another booking.', suggested_action: 'confirm', list_unsubscribe: null,
  });
  const before_nm = await req('GET', '/api/specialists/kate/postoffice');
  const ot = (before_nm.body?.digest ?? []).find((m: { from: string }) => m.from === 'confirm@opentable.com');
  check('reservation sender present before Not me', !!ot);
  if (ot) {
    const nm = await req('POST', `/api/specialists/kate/postoffice/messages/${ot.id}/handled`, { handled: true, reason: 'not_me' });
    check('Not me → 200 + suppressed', nm.status === 200 && nm.body?.suppressed === true);
    const after_nm = await req('GET', '/api/specialists/kate/postoffice');
    check(
      'learned suppression filters ALL mail from that sender (not just the tapped one)',
      (after_nm.body?.digest ?? []).every((m: { from: string }) => m.from !== 'confirm@opentable.com'),
    );
  }

  // ── Real action links on the cards (the "Confirm just opens the email" fix) ─
  const upsert_inbound = (over: Record<string, unknown>) => store.upsert({
    direction: 'inbound', account_id: hh_acct, user_id: 'jasper', private_to: 'household',
    in_reply_to: null, references: [], to: ['jasper@me.com'],
    auth_spf: 'pass', auth_dkim: 'pass', auth_dmarc: 'pass', is_bulk: false, aligned: true,
    triage_reasons: [], is_reply_to_me: false, list_unsubscribe: null,
    ...over,
  } as unknown as Parameters<typeof store.upsert>[0]);
  upsert_inbound({ uid: 810, message_id: '<clinic810@x.com>', thread_key: '<clinic810@x.com>', from_addr: 'appts@clinic.com', from_name: 'Foothills Clinic', subject: 'Confirm your appointment', date_utc: siso('2026-06-19T06:00:00Z'), snippet: 'confirm', body_text: 'Please confirm your appointment here: https://clinic.com/confirm/abc123 — thanks.', triage_category: 'transactional', triage_importance: 0.9, triage_bucket: 'needs_you', summary: 'Appointment to confirm.', suggested_action: 'confirm' });
  upsert_inbound({ uid: 811, message_id: '<pm811@x.com>', thread_key: '<pm811@x.com>', from_addr: 'pat@friends.com', from_name: 'Pat', subject: 'lunch?', date_utc: siso('2026-06-19T06:05:00Z'), snippet: 'lunch', body_text: 'Want to grab lunch Thursday?', triage_category: 'authentic_personal', triage_importance: 0.6, triage_bucket: 'new_mail', summary: 'Pat wrote you.', suggested_action: 'reply' });
  upsert_inbound({ uid: 812, message_id: '<col812@x.com>', thread_key: '<col812@x.com>', from_addr: 'admin@halstedfinancialservices.com', from_name: 'Halsted Financial', subject: 'Re: Original Creditor: Snap Finance Llc', date_utc: siso('2026-06-19T06:10:00Z'), snippet: 'creditor', body_text: 'A creditor account for Jasper Fenwick requires immediate response.', triage_category: 'junk_spam', triage_importance: 0.3, triage_bucket: 'junk', summary: 'Looks misdirected.', suggested_action: 'not_me' });
  const acts = await req('GET', '/api/specialists/kate/postoffice');
  const dg = acts.body?.digest ?? [];
  const clinic = dg.find((m: { from: string }) => m.from === 'appts@clinic.com');
  check('confirm card carries a real confirm-LINK action (not just open)', clinic?.action?.kind === 'confirm' && /clinic\.com\/confirm/.test(clinic.action.url));
  const pat = dg.find((m: { from: string }) => m.from === 'pat@friends.com');
  check('reply card carries a mailto reply action', pat?.action?.kind === 'reply' && String(pat.action.url).startsWith('mailto:pat@friends.com'));
  const col = dg.find((m: { from: string }) => m.from === 'admin@halstedfinancialservices.com');
  check('misdirected (not_me) surfaces in the digest with the not_me lead', !!col && col.suggested_action === 'not_me');

  // Re-triage route runs (re-judges stored mail with current rules).
  const rt = await req('POST', '/api/specialists/kate/postoffice/retriage');
  check('retriage → 200', rt.status === 200 && Array.isArray(rt.body?.results));
}
{
  current_user = { id: 'sam', tier: 'household' };
  const { status, body } = await req('GET', '/api/specialists/kate/postoffice');
  check('household GET 200', status === 200);
  check('household sees ONLY the household account (cordon)', (body?.accounts ?? []).length === 1 && body.accounts[0].private_to === 'household');
  check('household CAN configure their own (self-service)', body?.can_configure === true);
  check('household cannot share household-wide (owner only)', body?.can_share_household === false);
  const reply = (body?.buckets ?? []).find((b: { bucket: string }) => b.bucket === 'replies');
  // The threaded reply lives on the OWNER's first account (private_to owner);
  // the seam ingest landed on the household account — both are household-visible
  // here only if private_to permits. The owner-account messages must be hidden.
  check('household reply lane excludes owner-account mail', (reply?.messages ?? []).every((m: { account_id: string }) => m.account_id === hh_acct));
  check('household orders[] excludes the owner-private order (cordon)', (body?.orders ?? []).every((o: { order_number: string }) => o.order_number !== 'ORD-123'));
}
{
  current_user = null;
  check('unauth GET → 401', (await req('GET', '/api/specialists/kate/postoffice')).status === 401);
  current_user = { id: 'jasper', tier: 'owner' };
  check('no read_mail specialist → 404', (await req('GET', '/api/specialists/vivian/postoffice')).status === 404);
}
{
  // Self-service setup: a household member adds their OWN inbox (no longer
  // owner-only). It's cordoned to them (private_to = their id, NOT household,
  // even though they asked) — the owner gets no god-view of it.
  current_user = { id: 'sam', tier: 'household' };
  const created = await req('POST', '/api/specialists/kate/postoffice/accounts', { display_name: 'Sam Gmail', provider: 'gmail', private_to: 'household', imap_user: 'sam@gmail.com', imap_password: 'sam-pass' });
  check('household self-service create → 200', created.status === 200);
  const sara_aid = created.body?.account?.id;
  check('member account cordoned to them (private_to = their id, not household)', created.body?.account?.private_to === 'sam');
  // Sam sees her own account; the owner does NOT (no god-view).
  const saraView = await req('GET', '/api/specialists/kate/postoffice');
  check('member sees their own new account', (saraView.body?.accounts ?? []).some((a: { id: string }) => a.id === sara_aid));
  current_user = { id: 'jasper', tier: 'owner' };
  const ownerView = await req('GET', '/api/specialists/kate/postoffice');
  check("owner has NO god-view of member's personal inbox", (ownerView.body?.accounts ?? []).every((a: { id: string }) => a.id !== sara_aid));
  // A member cannot manage someone else's account.
  current_user = { id: 'kim', tier: 'household' };
  const steal = await req('POST', `/api/specialists/kate/postoffice/accounts/${sara_aid}`, { delete: true });
  check("member can't delete another member's account → 403", steal.status === 403);
  // Owner create still works + stays redacted.
  current_user = { id: 'jasper', tier: 'owner' };
  const ok = await req('POST', '/api/specialists/kate/postoffice/accounts', { display_name: 'Work', provider: 'fastmail', private_to: 'owner', imap_user: 'j@fast.com', imap_password: 'secret2' });
  check('owner create → 200 + redacted account', ok.status === 200 && ok.body?.account?.imap_password_set === true && !('imap_password' in (ok.body?.account ?? {})));
}

// ── 8. kill switch ──────────────────────────────────────────────────────
console.log('\n→ kill switch');
check('mail_enabled() false unless HEARTH_MAIL=1', mail_enabled() === false);

rmSync(dir, { recursive: true, force: true });
console.log(failures === 0 ? '\nall green' : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
