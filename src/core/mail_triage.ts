/**
 * Mail triage — authenticity + "pertinent to this person's life" classifier.
 *
 * Two-layer shape (like capture_quality.ts):
 *
 *   Layer 1 — structural pre-filter (deterministic, no LLM): AUTH headers
 *     (SPF/DKIM/DMARC), the LIST/BULK machinery (List-Id / List-Unsubscribe /
 *     Precedence / Auto-Submitted), preheader PADDING (zero-width runs — a
 *     mass-marketing tell), From↔Return-Path alignment, and the threading fact
 *     (does this reply to a message the user actually SENT). Two things are
 *     decided HERE, never by the model:
 *       • REPLY is structural. A message is a reply ONLY if it threads to one
 *         the user sent (`is_reply_to_me`). The judge can no longer *claim*
 *         "reply" — that's what let a political blast read as an "authentic
 *         human reply." The judge has no `authentic_reply` category.
 *       • BULK is never PERSONAL. A message carrying list/bulk headers, or
 *         preheader padding, was sent by an automated system to many people —
 *         it can be transactional/subscription/promotional/junk, but never
 *         `authentic_personal`. A judge verdict of personal-on-bulk is coerced.
 *
 *   Layer 2 — planner-LLM judge (the semantic core): for the non-reply mail,
 *     an EMERGENT category + an importance score + a one-line SUMMARY (Kate's
 *     take) + a SUGGESTED ACTION. Criteria are described in the prompt; never a
 *     hard-coded sender list.
 *
 * FAIL-OPEN: judge error / no router → a safe, visible default. Pure +
 * injectable (header parsing takes strings; judge takes an optional router).
 */
import { z } from 'zod';
import type { LLMRouter } from '@core/llm';
import type { AuthVerdict, MailBucket } from '@memory/stores/mail';

/** Emergent triage categories. `authentic_reply` is set ONLY structurally
 *  (is_reply_to_me) — it is NOT a judge option. */
export type MailCategory =
  | 'authentic_reply' // structural only — threads to a message the user sent
  | 'authentic_personal' // a real human typed this to the user specifically
  | 'transactional' // machine-sent but you-initiated/you-care (orders, receipts, security)
  | 'subscription_informational' // opted-in list mail carrying pertinent info
  | 'promotional' // legitimate sender, low-signal marketing
  | 'junk_spam' // unsolicited bulk / advocacy blasts / scams / content farms
  | 'phishing' // impersonation / credential-harvest / spoofed
  | 'unknown'; // triage unavailable — route for manual review

/** What Kate recommends doing with a message. `not_me` = misdirected (a notice
 *  for a DIFFERENT person than the account owner — a debt collector for someone
 *  who shares your first name, etc.); the digest leads with a "Not me" tap that
 *  suppresses the sender. */
export type SuggestedAction = 'reply' | 'review' | 'schedule' | 'confirm' | 'unsubscribe' | 'dismiss' | 'not_me';
const SUGGESTED_ACTIONS = ['reply', 'review', 'schedule', 'confirm', 'unsubscribe', 'dismiss', 'not_me'] as const;

export interface StructuralHeaders {
  authentication_results?: string | null;
  list_id?: string | null;
  list_unsubscribe?: string | null;
  precedence?: string | null;
  auto_submitted?: string | null;
  from_addr: string;
  return_path?: string | null;
}

export interface StructuralVerdict {
  spf: AuthVerdict;
  dkim: AuthVerdict;
  dmarc: AuthVerdict;
  /** List/bulk machinery present (List-*, Precedence:bulk, Auto-Submitted). */
  is_bulk: boolean;
  /** From-domain aligns with the authenticated/return-path domain. */
  aligned: boolean;
  has_list_unsub: boolean;
}

export interface TriageInput {
  from_addr: string;
  from_name: string;
  subject: string;
  snippet: string;
  body_text: string;
  structural: StructuralVerdict;
  /** Threading-verified: an id in In-Reply-To/References matches a Message-ID
   *  the user SENT. Strong authenticity — a spammer can't forge it. */
  is_reply_to_me: boolean;
  /** Preheader/zero-width padding in the body — a mass-marketing template tell
   *  (computed by the caller via `has_preheader_padding`). */
  looks_templated?: boolean;
  /** A short "about the recipient" blurb from the per-user model. */
  user_context?: string;
  /** The account owner's name(s) — so the judge can flag a message clearly
   *  addressed to / about a DIFFERENT person (misdirected → 'not_me'). Absent ⇒
   *  no misdirected detection (existing behavior). */
  owner_names?: string[];
  /** Verified household-service ledger lines matching this SENDER's domain
   *  (from the household_services projection — see src/core/household_services.ts).
   *  Evidence-shaping only: the household genuinely HAS these vendor
   *  relationships, so a bill from one reads transactional, not junk. The
   *  judge still decides. Absent/empty ⇒ existing behavior. */
  known_services?: string[];
  /** All household members' display names (config/users.yaml) — so the judge
   *  knows who this mailbox legitimately serves (mail about a household
   *  member is not misdirected). Absent ⇒ existing behavior. */
  household_names?: string[];
}

export interface TriageVerdict {
  category: MailCategory;
  /** 0..1 — how much this needs the recipient's attention. */
  importance: number;
  /** Does the message require the user to do/respond to something. */
  needs_action: boolean;
  bucket: MailBucket;
  /** Kate's one-line take: what it is + why it matters (or why it's noise). */
  summary: string;
  suggested_action: SuggestedAction;
  reasons: string[];
  used_llm: boolean;
}

// Tunable thresholds (tune from real data, never to rescue one message).
const NEEDS_YOU_IMPORTANCE = 0.5;
const FYI_UPGRADE_IMPORTANCE = 0.7;
const JUDGE_BODY_CHARS = 2500;

function norm_verdict(raw: string | undefined): AuthVerdict {
  if (!raw) return 'none';
  const v = raw.toLowerCase();
  if (v.startsWith('pass')) return 'pass';
  if (v.startsWith('fail') || v.startsWith('softfail') || v.startsWith('reject')) return 'fail';
  return 'none';
}

function domain_of(addr: string | null | undefined): string | null {
  if (!addr) return null;
  const m = addr.match(/@([^@>\s]+)/);
  return m && m[1] ? m[1].toLowerCase().replace(/[>)\s.]+$/, '') : null;
}

/** Mass-marketing "preheader padding": a run of zero-width / invisible chars
 *  (ZWNJ/ZWSP/ZWJ/BOM/soft-hyphen) or many non-breaking spaces, used by ESPs
 *  to pad the inbox preview. A human-typed email never has this. */
export function has_preheader_padding(body: string): boolean {
  if (!body) return false;
  const zerowidth = (body.match(/[​‌‍﻿­]/g) ?? []).length;
  if (zerowidth >= 5) return true;
  if (/[ ​‌‍﻿]{12,}/.test(body)) return true;
  return false;
}

/** Parse the structural/auth signals from header strings. Deterministic. */
export function derive_structural(h: StructuralHeaders): StructuralVerdict {
  const ar = (h.authentication_results ?? '').toLowerCase();
  const spf = norm_verdict(ar.match(/spf=([a-z]+)/)?.[1]);
  const dkim = norm_verdict(ar.match(/dkim=([a-z]+)/)?.[1]);
  const dmarc = norm_verdict(ar.match(/dmarc=([a-z]+)/)?.[1]);
  const has_list_unsub = !!(h.list_unsubscribe && h.list_unsubscribe.trim().length > 0);
  const precedence = (h.precedence ?? '').toLowerCase();
  const auto = (h.auto_submitted ?? '').toLowerCase();
  const is_bulk =
    !!(h.list_id && h.list_id.trim().length > 0) ||
    has_list_unsub ||
    /\b(bulk|list|junk)\b/.test(precedence) ||
    (auto.length > 0 && auto !== 'no');
  const from_dom = domain_of(h.from_addr);
  const rp_dom = domain_of(h.return_path);
  const aligned =
    dmarc === 'pass' ||
    (!!from_dom && !!rp_dom && (from_dom === rp_dom || rp_dom.endsWith(`.${from_dom}`) || from_dom.endsWith(`.${rp_dom}`)));
  return { spf, dkim, dmarc, is_bulk, aligned, has_list_unsub };
}

/** Map an emergent category + scores to one of the five lanes. (Buckets are
 *  internal grouping; the surfaced view is the digest, not these lanes.) */
export function to_bucket(
  category: MailCategory,
  importance: number,
  needs_action: boolean,
  is_reply_to_me: boolean,
): MailBucket {
  if (is_reply_to_me || category === 'authentic_reply') return 'replies';
  if (category === 'junk_spam' || category === 'phishing') return 'junk';
  if (category === 'subscription_informational' || category === 'promotional') {
    return importance >= FYI_UPGRADE_IMPORTANCE ? 'needs_you' : 'fyi';
  }
  if (needs_action && importance >= NEEDS_YOU_IMPORTANCE) return 'needs_you';
  if (category === 'authentic_personal' && importance >= FYI_UPGRADE_IMPORTANCE) return 'needs_you';
  return 'new_mail';
}

// The judge does NOT get 'authentic_reply' (structural) or 'unknown' (fail-open).
const JudgeSchema = z.object({
  category: z.enum([
    'authentic_personal',
    'transactional',
    'subscription_informational',
    'promotional',
    'junk_spam',
    'phishing',
  ]),
  importance: z.number().min(0).max(1),
  needs_action: z.boolean().default(false),
  summary: z.string().default(''),
  suggested_action: z.enum(SUGGESTED_ACTIONS).default('review'),
});

const JUDGE_SYSTEM =
  "You triage ONE inbound email for a busy person's chief-of-staff. You decide " +
  'how authentic it is, how much it actually matters, and what to do — so the ' +
  'person sees a short digest of what needs them, not a mail dump.\n\n' +
  'Pick exactly one category:\n' +
  '  - authentic_personal: a real human TYPED this to this person specifically. ' +
  'NOT a list, marketer, or platform. A genuine 1:1 note.\n' +
  '  - transactional: machine-sent but the person initiated it or it concerns ' +
  'them — order/booking/reservation/registration confirmations, receipts, ' +
  'shipping, appointment reminders, account & security notices. Keep these.\n' +
  '  - subscription_informational: opted-in list/newsletter with GENUINELY ' +
  'pertinent info or a real activity announcement (a community/city/program ' +
  'notice). Useful, but low-urgency.\n' +
  '  - promotional: legitimate sender, low-signal marketing/sales/offers.\n' +
  '  - junk_spam: unsolicited bulk; political/advocacy/fundraising mass mail; ' +
  'content farms; scams.\n' +
  '  - phishing: impersonation / credential-harvest / spoofed (weigh the auth ' +
  'verdict — DMARC fail + a claimed known sender is a strong signal).\n\n' +
  'CRITICAL RULES:\n' +
  '  1. If the evidence says bulk=yes (list/unsubscribe headers) or ' +
  'templated=yes (preheader padding), the message was sent by an automated ' +
  'system to MANY people. It is NOT authentic_personal — choose ' +
  'subscription_informational, promotional, or junk_spam.\n' +
  '  2. A PLATFORM notification sent on someone\'s behalf — "<name> posted / ' +
  'shared / commented / viewed", "<name> recommends…", "click here to view on ' +
  '<site>", with an unsubscribe footer — is NOT authentic_personal even though ' +
  'it names a real person. It is promotional or subscription_informational. ' +
  'Only an ACTUAL message a person wrote to this recipient counts as personal.\n' +
  '  3. Automated platform SUGGESTIONS (someone-you-may-know, "people viewed ' +
  'your profile", connection/recommendation prompts) are promotional. Only a ' +
  'real direct message from a person is authentic.\n' +
  '  4. Do not invent facts about the sender; judge from the evidence.\n' +
  '  5. MISDIRECTED MAIL: if an "Account owner" is given and the message is ' +
  'clearly addressed to / about a DIFFERENT specific person (a bill, debt ' +
  'collection, legal notice, or account for a named individual who is NOT the ' +
  'owner — e.g. addressed to "<First> <Different-Last>" when the owner is ' +
  '"<First> <Owner-Last>"), it is almost certainly mail for someone else who ' +
  'shares a name. Set suggested_action to "not_me" (and category junk_spam). Do ' +
  'NOT do this for legitimate mail to the owner, for household members, or when ' +
  'no owner name is given — only on a clear name mismatch.\n' +
  '  6. KNOWN HOUSEHOLD SERVICES: when the evidence lists verified services from ' +
  "this sender's domain, the household genuinely HAS that vendor relationship — " +
  'weigh a bill / statement / service notice from it as transactional (legitimate, ' +
  'keep; a due bill is usually needs_action). Authentication still wins: a ' +
  'DMARC-failing message CLAIMING a known vendor is MORE suspicious, not less. ' +
  '"Household members" names the people this mailbox legitimately serves — mail ' +
  'about one of them is not misdirected.\n\n' +
  'importance (0..1): how much it needs ATTENTION now. 0.85–1.0 = a person ' +
  'asking something, a confirmation/deadline/security alert. 0.4–0.7 = worth a ' +
  'glance. 0.0–0.2 = ignorable bulk/marketing/notification. Weigh the "About ' +
  'the recipient" notes — info that fits their life matters more.\n' +
  'needs_action: true only if the person must DO or REPLY to something.\n' +
  'summary: ONE short sentence in a calm assistant voice — what it is and why ' +
  'it matters (or why it\'s noise). No greeting, no fluff.\n' +
  'suggested_action: one of reply | review | schedule | confirm | unsubscribe | ' +
  'dismiss | not_me. (reply = a human wants a response; confirm = a booking/appt ' +
  'to confirm; schedule = it has a date to put on the calendar; unsubscribe = a ' +
  'list not worth keeping; dismiss = no action needed; review = just read it; ' +
  'not_me = misdirected, it is for a different person (rule 5).)\n\n' +
  'Reply with ONLY this JSON: {"category":"...","importance":<0..1>,' +
  '"needs_action":<bool>,"summary":"<one sentence>","suggested_action":"..."}';

function strip_fence(s: string): string {
  const m = s.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
  return (m ? m[1]! : s).trim();
}

function evidence_block(input: TriageInput): string {
  const s = input.structural;
  const auth =
    `spf=${s.spf} dkim=${s.dkim} dmarc=${s.dmarc} aligned=${s.aligned} ` +
    `bulk=${s.is_bulk ? 'yes' : 'no'} templated=${input.looks_templated ? 'yes' : 'no'}`;
  const body =
    input.body_text.length > JUDGE_BODY_CHARS
      ? input.body_text.slice(0, JUDGE_BODY_CHARS) + '\n[...truncated]'
      : input.body_text;
  return (
    `From: ${input.from_name} <${input.from_addr}>\n` +
    `Subject: ${input.subject}\n` +
    `Signals: ${auth}\n` +
    (input.owner_names && input.owner_names.length
      ? `Account owner (this mailbox belongs to): ${input.owner_names.join(', ')}\n`
      : '') +
    (input.household_names && input.household_names.length
      ? `Household members: ${input.household_names.join(', ')}\n`
      : '') +
    (input.known_services && input.known_services.length
      ? `Known household services from this sender's domain (VERIFIED ledger):\n${input.known_services.map((s) => `  - ${s}`).join('\n')}\n`
      : '') +
    (input.user_context ? `About the recipient: ${input.user_context}\n` : '') +
    `\nBody:\n${body || input.snippet}`
  );
}

async function judge(input: TriageInput, llm: LLMRouter): Promise<TriageVerdict | null> {
  let role;
  try {
    role = llm.for_role('planner');
  } catch {
    return null;
  }
  let resp;
  try {
    resp = await role.provider.complete({
      messages: [
        { role: 'system', content: JUDGE_SYSTEM },
        { role: 'user', content: evidence_block(input) + '\n\nReply with ONLY the JSON.' },
      ],
      temperature: 0.1,
      max_tokens: 320,
      think: false,
      ...role.defaults,
    });
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(strip_fence(resp.content));
  } catch {
    return null;
  }
  const r = JudgeSchema.safeParse(parsed);
  if (!r.success) return null;

  let category = r.data.category as MailCategory;
  let importance = r.data.importance;
  let suggested_action = r.data.suggested_action as SuggestedAction;
  const reasons: string[] = [];

  // BACKSTOP: a bulk/templated message can NEVER be personal, whatever the
  // judge said. Coerce it down + cap its importance so it can't sit in the
  // digest as a personal note (the Fetterman/Vumedi class).
  if (category === 'authentic_personal' && (input.structural.is_bulk || input.looks_templated)) {
    category = 'promotional';
    importance = Math.min(importance, 0.3);
    suggested_action = input.structural.has_list_unsub ? 'unsubscribe' : 'dismiss';
    reasons.push('bulk/automated send — not a personal message');
  }

  return {
    category,
    importance,
    needs_action: r.data.needs_action,
    bucket: to_bucket(category, importance, r.data.needs_action, input.is_reply_to_me),
    summary: r.data.summary.trim() || `${category.replace(/_/g, ' ')}`,
    suggested_action,
    reasons,
    used_llm: true,
  };
}

/** The safe default when the judge can't run — visible, never hidden. */
function safe_default(input: TriageInput): TriageVerdict {
  if (input.is_reply_to_me) {
    return {
      category: 'authentic_reply',
      importance: 0.7,
      needs_action: true,
      bucket: 'replies',
      summary: `Reply from ${input.from_name || input.from_addr}.`,
      suggested_action: 'reply',
      reasons: ['verified reply to a message you sent'],
      used_llm: false,
    };
  }
  return {
    category: 'unknown',
    importance: 0.5,
    needs_action: false,
    bucket: 'new_mail',
    summary: `From ${input.from_name || input.from_addr}: ${input.subject || '(no subject)'}.`,
    suggested_action: 'review',
    reasons: ['triage unavailable — routed for manual review'],
    used_llm: false,
  };
}

/**
 * Triage one message. Layer 1 hard-classifies a threading-verified reply (the
 * ONLY way to earn the reply lane — skip the model). Everything else goes to
 * the judge with the structural evidence. Fail-open to a safe, visible default.
 */
/** Owner identity tokens for misdirected detection: name words + email local
 *  parts (so "law" matches the surname inside jasperdoe@…). */
function owner_tokens(owner_names: string[]): { words: Set<string>; locals: string[] } {
  const words = new Set<string>();
  const locals: string[] = [];
  for (const n of owner_names) {
    if (n.includes('@')) {
      const lp = (n.split('@')[0] ?? '').toLowerCase().replace(/[^a-z]/g, '');
      if (lp) locals.push(lp);
    } else {
      for (const w of n.toLowerCase().split(/[^a-z]+/)) if (w.length >= 2) words.add(w);
    }
  }
  return { words, locals };
}
function owner_has(tok: string, t: { words: Set<string>; locals: string[] }): boolean {
  const x = tok.toLowerCase();
  if (t.words.has(x)) return true;
  return x.length >= 3 && t.locals.some((l) => l.includes(x));
}
/** Do we actually KNOW the owner's surname, so a mismatch is meaningful? A
 *  multi-word display name, or an email local that extends a first-name word
 *  (jasperdoe ⊃ jasper). With only a bare "Jasper" we can't tell his own "Jasper
 *  Law" from a misdirected "Jasper Fenwick" — so we DON'T detect (no false
 *  positives on his own mail). */
function has_surname_source(t: { words: Set<string>; locals: string[] }): boolean {
  if (t.words.size >= 2) return true;
  for (const l of t.locals) {
    if (t.words.size === 0) { if (l.length >= 6) return true; continue; }
    for (const w of t.words) if (l.startsWith(w) && l.length >= w.length + 2) return true;
  }
  return false;
}

/** Deterministic misdirected check — the reliable layer the small judge isn't.
 *  Flags mail naming someone who shares the owner's FIRST name but a DIFFERENT
 *  surname (the "another Jasper" / wrong-recipient case). Generic — a name-
 *  mismatch test, never a hardcoded name. Precise: only when the surname is
 *  KNOWN (else skip) AND the first name matches (so a random third party with a
 *  different first name is never flagged).
 *
 *  Scans per LINE (the addressee can lead a line: "Jasper Fenwick - Re: …") over
 *  OVERLAPPING adjacent capitalized-word pairs — a single regex with `\s+` would
 *  span the subject↔body newline and consume the first name into a junk pair
 *  ("Llc Jasper"), orphaning the surname. */
export function is_misdirected(input: { subject: string; body_text: string }, owner_names: string[]): boolean {
  const t = owner_tokens(owner_names);
  if (!has_surname_source(t)) return false;
  const hay = `${input.subject}\n${input.body_text}`.slice(0, 2000);
  for (const line of hay.split(/[\n\r]+/)) {
    const words = line.match(/[A-Z][a-z]+/g);
    if (!words) continue;
    for (let i = 0; i + 1 < words.length; i++) {
      if (owner_has(words[i]!, t) && !owner_has(words[i + 1]!, t)) return true;
    }
  }
  return false;
}

export async function triage_message(
  input: TriageInput,
  llm?: LLMRouter,
): Promise<TriageVerdict> {
  if (input.is_reply_to_me) {
    return {
      category: 'authentic_reply',
      importance: 0.78,
      needs_action: true,
      bucket: 'replies',
      summary: `${input.from_name || input.from_addr} replied to your message${input.subject ? ` "${input.subject.replace(/^re:\s*/i, '')}"` : ''}.`,
      suggested_action: 'reply',
      reasons: ['threaded reply to a message you sent'],
      used_llm: false,
    };
  }
  let verdict = !llm ? safe_default(input) : (await judge(input, llm)) ?? safe_default(input);
  // Deterministic misdirected override — reliable where the small judge isn't
  // (the 9B won't apply the name-mismatch rule consistently). A clear
  // wrong-recipient signal → 'not_me' regardless of the judge's verdict.
  if (input.owner_names && input.owner_names.length && is_misdirected(input, input.owner_names)) {
    verdict = {
      ...verdict,
      suggested_action: 'not_me',
      reasons: [...verdict.reasons, 'addressed to a different person than the account owner'],
    };
  }
  return verdict;
}
