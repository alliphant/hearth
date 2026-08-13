/**
 * MailShelfDriver (2026-06-20) — shelve SIGNIFICANT non-bulk mail into the
 * library / second brain, resolving the SHELVING TODO in mail_ingest.ts.
 *
 * Today mail lives only in the `mail_messages` SQLite projection (LIKE search,
 * never RAG). This makes digest-worthy mail — real replies, personal mail,
 * actionable transactional — a markdown vault note + chunks_fts + embeddings via
 * Cordelia's `save_library_item`, so it's RAG-searchable AND feeds the household
 * knowledge graph cross-specialist. **Cordon: stamped `private_to` the account
 * OWNER (msg.user_id), the strictest scope — mail must never leak cross-user via
 * RAG, even from a household-shared account.**
 *
 * Event-driven (subscribes to `mail_message_triaged`, mirrors the
 * HouseholdGraphDriver / ReactiveInboxDriver pattern), idempotent (the
 * `shelved_at` stamp — re-triage/re-ingest never re-shelves), gated + fail-open.
 * The actual `save_library_item` call is INJECTED (`shelve`) so src/core stays
 * free of an @app value import and the smoke can drive it with no library/db.
 *
 * DARK behind `HEARTH_MAIL_SHELVE` (opt-in) — off → attach() is a no-op.
 */
import type { Database } from 'bun:sqlite';
import type { AppEventBus } from '@app/events';
import { MailStore, type MailMessage } from '@memory/stores/mail';

export function mail_shelve_enabled(): boolean {
  return process.env.HEARTH_MAIL_SHELVE === '1';
}

/**
 * The "significant, non-bulk" predicate — what's worth a second-brain note.
 * Replies + personal mail (digest-worthy human contact) and actionable
 * transactional always; opted-in subscription info only when it rose to
 * importance; bulk / promo / junk / phishing never.
 */
export function is_significant_non_bulk(msg: MailMessage): boolean {
  if (msg.direction !== 'inbound') return false; // sent mail feeds the style facet, not RAG
  if (msg.is_bulk) return false;
  const c = msg.triage_category;
  if (c === 'junk_spam' || c === 'phishing' || c === 'promotional') return false;
  if (msg.is_reply_to_me || c === 'authentic_reply' || c === 'authentic_personal') return true;
  if (c === 'transactional') return true;
  if (c === 'subscription_informational' && msg.triage_importance >= 0.6) return true;
  return false;
}

/** Compose the markdown note body for a shelved message. H1 = subject so the
 *  library title resolves cleanly; provenance footer for traceability. */
export function compose_mail_markdown(msg: MailMessage): string {
  const day = msg.date_utc.slice(0, 10);
  return [
    `# ${msg.subject || '(no subject)'}`,
    '',
    `From: **${msg.from_name || msg.from_addr}** <${msg.from_addr}> · ${day}`,
    msg.summary ? `\n_${msg.summary}_` : '',
    '',
    '---',
    '',
    msg.body_text || msg.snippet || '',
    '',
    `---`,
    `_Shelved from the Post Office (${msg.triage_category}). Source message ${msg.id}._`,
  ]
    .filter((l) => l !== null && l !== undefined)
    .join('\n');
}

/** What the driver hands the orchestrator's shelve callback. */
export interface ShelveMailInput {
  message_id: string;
  /** The account owner — the cordon the library item is stamped to. */
  user_id: string;
  subject: string;
  markdown: string;
  filename: string;
}

/** Injected at wiring time — composes save_library_item over LibraryRoutesDeps.
 *  Returns true when the item was shelved (false on a quality rejection). */
export type ShelveMailFn = (input: ShelveMailInput) => Promise<boolean>;

export interface MailShelfDeps {
  events: AppEventBus;
  db: Database;
  shelve: ShelveMailFn;
}

export class MailShelfDriver {
  private unsub?: () => void;

  constructor(private deps: MailShelfDeps) {}

  attach(): void {
    if (!mail_shelve_enabled()) {
      console.log('[mail-shelf] disabled (HEARTH_MAIL_SHELVE != 1) — no-op');
      return;
    }
    this.unsub = this.deps.events.subscribe((ev) => {
      if (ev.type === 'mail_message_triaged') void this.on_triaged(ev.message_id);
    });
    console.log('[mail-shelf] attached — shelving significant mail to the second brain');
  }

  detach(): void {
    this.unsub?.();
    this.unsub = undefined;
  }

  /** Shelve one triaged message if it qualifies. Public so a smoke / a future
   *  backfill can drive it directly. Fail-open. */
  async on_triaged(message_id: string): Promise<void> {
    try {
      const store = new MailStore(this.deps.db);
      const msg = store.get(message_id);
      if (!msg) return;
      if (store.is_shelved(msg.id)) return; // idempotent
      if (!is_significant_non_bulk(msg)) return;

      const ok = await this.deps.shelve({
        message_id: msg.id,
        user_id: msg.user_id, // strict cordon — account owner, never 'household'
        subject: msg.subject,
        markdown: compose_mail_markdown(msg),
        filename: `mail-${msg.id}.md`,
      });
      if (ok) store.mark_shelved(msg.id, new Date().toISOString());
    } catch (err) {
      console.error(`[mail-shelf] shelve skip (msg ${message_id}):`, err);
    }
  }
}
