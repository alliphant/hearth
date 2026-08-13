/**
 * /api/imessage — the macOS iMessage observer's ingest surface (2026-06-22).
 *
 * The native macOS Hearth app reads ~/Library/Messages/chat.db (Full Disk
 * Access), resolves each handle → a Hearth person, and uploads raw 1:1 message
 * windows for OPTED-IN contacts here. This route is the machine boundary:
 *   - GET  /opt_in  — the app's upload allowlist (which person_ids are opted in).
 *   - POST /ingest  — stage raw windows (opt-in + cordon gated) for the nightly
 *                     distill, which keeps only the distillate and drops the raw.
 *
 * The opt-in TOGGLE itself lives on the Friends card (the D trust surface);
 * Hearth OWNS + ENFORCES the registry here regardless, so a misbehaving or
 * stale client can never stage a not-opted contact's messages. Owner-tier only
 * for v1 (the owner's Mac). NEW top-level /api namespace → needs the nginx
 * /api/(...) alternation edit on the LLM host (see the private dev log / the design doc).
 *
 * Auth is the global middleware (c.get('user')); DARK until
 * HEARTH_IMESSAGE_OBSERVER=1 (ingest then accept-but-noops so the client
 * doesn't error).
 */
import { Hono } from 'hono';
import { z } from 'zod';
import type { Database } from 'bun:sqlite';
import type { MemoryClient } from '@memory/client';
import { parse_fm } from '@core/relationship_signals';
import { note_visible_to_caller, parse_private_to, type Caller } from '@memory/private_to';
import { ImessageStaging, ImessageOptIn } from '@memory/stores/imessage_staging';
import { imessage_observer_enabled } from '@core/imessage_distill';

const MessageSchema = z.object({
  text: z.string(),
  ts: z.string(), // ISO 8601 UTC — the macOS app converts Apple's epoch before upload.
  from_me: z.boolean().default(false),
});
const WindowSchema = z.object({
  person_id: z.string().min(1),
  chat_guid: z.string().optional(),
  window_start: z.string().optional(),
  window_end: z.string().optional(),
  messages: z.array(MessageSchema).min(1).max(2000),
});
const IngestSchema = z.object({
  windows: z.array(WindowSchema).min(1).max(200),
});

type OwnerCaller = { user_id: string; tier: Caller['tier'] };

export interface ImessageRouterDeps {
  db: Database;
  memory: MemoryClient;
}

export function create_imessage_router(deps: ImessageRouterDeps): Hono {
  const r = new Hono();
  const staging = new ImessageStaging(deps.db);
  const opt_in = new ImessageOptIn(deps.db);

  const owner_of = (
    c: { get: (k: 'user') => { id?: string; tier?: string } | undefined },
  ): OwnerCaller | null => {
    const user = c.get('user');
    if (!user || !user.id) return null;
    const tier = (user.tier ?? 'friend') as Caller['tier'];
    if (tier !== 'owner') return null; // v1: the owner's Mac only
    return { user_id: user.id, tier };
  };

  // Cordon: never stage a window for a person_id the uploader can't see.
  const visible_person = (caller: Caller, pid: string): boolean => {
    const row = deps.memory.query_people({}).find((p) => p.id === pid);
    if (!row) return false;
    const fm = parse_fm(row.frontmatter_json);
    return note_visible_to_caller(parse_private_to(fm.private_to), caller);
  };

  // ── GET /opt_in — the macOS upload allowlist (per-person contact handles) ────
  // The macOS app matches each chat.db handle (phone/email) against these to
  // resolve a 1:1 chat → a Hearth person_id, then uploads that person's windows.
  // Handles are the raw `contact.phone` + `contact.email` from the person note;
  // the client normalizes both sides for matching (phones → digits, etc.).
  r.get('/opt_in', (c) => {
    const caller = owner_of(c);
    if (!caller) return c.json({ error: 'owner authentication required' }, 401);
    const people = deps.memory.query_people({});
    const enabled: Array<{ person_id: string; name: string; handles: string[] }> = [];
    for (const pid of opt_in.enabled_set(caller)) {
      const row = people.find((p) => p.id === pid);
      if (!row) continue;
      const fm = parse_fm(row.frontmatter_json);
      if (!note_visible_to_caller(parse_private_to(fm.private_to), caller)) continue; // cordon
      const contact = (fm.contact && typeof fm.contact === 'object' ? fm.contact : {}) as {
        phone?: unknown;
        email?: unknown;
      };
      const handles = [
        ...(Array.isArray(contact.phone) ? contact.phone : []),
        ...(Array.isArray(contact.email) ? contact.email : []),
      ].filter((h): h is string => typeof h === 'string' && h.trim().length > 0);
      enabled.push({ person_id: pid, name: row.name, handles });
    }
    return c.json({ enabled });
  });

  // ── POST /ingest — stage raw windows for opted-in contacts ──────────────────
  r.post('/ingest', async (c) => {
    const caller = owner_of(c);
    if (!caller) return c.json({ error: 'owner authentication required' }, 401);
    // DARK: accept-but-noop so the client doesn't error while the feature is off.
    if (!imessage_observer_enabled()) {
      return c.json({ ok: true, enabled: false, staged: 0, skipped: 0 });
    }
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch (e) {
      return c.json({ error: `invalid JSON: ${(e as Error).message}` }, 400);
    }
    const parsed = IngestSchema.safeParse(raw);
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);

    let staged = 0;
    let skipped = 0;
    for (const w of parsed.data.windows) {
      // Opt-in + cordon gates (defense-in-depth — the Mac should already filter,
      // but Hearth is the enforcer of the per-contact opt-in).
      if (!opt_in.is_enabled_for(w.person_id, caller.user_id)) {
        skipped += 1;
        continue;
      }
      if (!visible_person(caller, w.person_id)) {
        skipped += 1;
        continue;
      }
      const res = staging.stage({
        person_id: w.person_id,
        user_id: caller.user_id,
        private_to: caller.user_id, // raw is the uploader's, owner-only, transient
        chat_guid: w.chat_guid,
        window_start: w.window_start,
        window_end: w.window_end,
        messages: w.messages,
      });
      if (res.is_new) staged += 1;
      else skipped += 1; // retry of an identical window — collapsed
    }
    return c.json({ ok: true, enabled: true, staged, skipped });
  });

  return r;
}
