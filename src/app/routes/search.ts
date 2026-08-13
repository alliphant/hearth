/**
 * Unified search across chat history, vault chunks (when ingestor has
 * populated chunks_fts), and proposals_fts. Mirrors the shape the UI
 * search overlay expects: { chat, vault, proposals }.
 */

import { Hono } from 'hono';
import type { Database } from 'bun:sqlite';
import type { ConversationStore } from '@memory/stores/conversations';
import type { MemoryClient } from '@memory/client';

export interface SearchRoutesDeps {
  db: Database;
  conversations: ConversationStore;
  /** Resolves a vault hit's visibility from the LIVE note — see the vault
   *  branch below for why the old `clippings` join could not. */
  memory: MemoryClient;
}

interface ChatHit {
  message_id: string;
  conversation_id: string;
  ts: string;
  role: string;
  specialist_id: string | null;
  snippet: string;
}
interface VaultHit {
  note_path: string;
  snippet: string;
}
interface ProposalHit {
  proposal_id: string;
  specialist_id: string;
  ts_created: string;
  snippet: string;
  status: string;
  kind: string;
}

export function create_search_router(deps: SearchRoutesDeps): Hono {
  const r = new Hono();

  r.get('/', (c) => {
    const q = c.req.query('q');
    if (!q || q.length === 0) return c.json({ error: 'q required' }, 400);
    const scope = (c.req.query('scope') ?? 'all') as
      | 'all'
      | 'chat'
      | 'vault'
      | 'proposals'
      | 'library';
    const limit = Math.max(1, Math.min(50, parseInt(c.req.query('limit') ?? '20', 10) || 20));
    const escaped = q.replace(/"/g, '""');
    const ftq = `"${escaped}"`;

    const want = (s: typeof scope) => scope === 'all' || scope === s;

    // Per-user data cordon (2026-06-04): every source is filtered to what
    // the calling user may see. A user-less internal/unauth caller (no user
    // on the context) is treated as owner tier — it sees owner/household/
    // unset content but not another user's personal rows.
    const user = c.get('user');
    const caller = { user_id: user?.id, tier: user?.tier ?? ('owner' as const) };

    const out: {
      query: string;
      scope: string;
      chat: ChatHit[];
      vault: VaultHit[];
      proposals: ProposalHit[];
    } = { query: q, scope, chat: [], vault: [], proposals: [] };

    if (want('chat')) {
      // Over-fetch a little so per-conversation ownership filtering still
      // returns up to `limit` visible hits.
      const rows = deps.conversations.search_messages(q, limit * 4);
      const conv_owner = new Map<string, string | null>();
      const owner_of = (conv_id: string): string | null => {
        if (conv_owner.has(conv_id)) return conv_owner.get(conv_id) ?? null;
        const row = deps.db
          .prepare(`SELECT user_id FROM conversations WHERE id = @id`)
          .get({ '@id': conv_id }) as { user_id: string | null } | undefined;
        const owner = row?.user_id ?? null;
        conv_owner.set(conv_id, owner);
        return owner;
      };
      const chat_visible = (conv_id: string): boolean => {
        if (!user) return true; // internal/unauth caller
        const owner = owner_of(conv_id);
        // A conversation is personal. Legacy rows (user_id NULL) predate
        // multi-user and belong to the owner; show them to the owner only.
        if (owner == null) return caller.tier === 'owner';
        return owner === caller.user_id;
      };
      out.chat = rows
        .filter((m) => chat_visible(m.conversation_id))
        .slice(0, limit)
        .map((m) => ({
          message_id: m.id,
          conversation_id: m.conversation_id,
          ts: m.ts,
          role: m.role,
          specialist_id: m.specialist_id,
          snippet: m.content_md.slice(0, 300),
        }));
    }

    if (want('vault')) {
      try {
        const hits = deps.db
          .prepare(
            `SELECT f.note_path AS note_path, f.chunk_text AS chunk_text
             FROM chunks_fts f
             WHERE f MATCH @q
             ORDER BY f.rank LIMIT @lim`,
          )
          .all({ '@q': ftq, '@lim': limit * 4 }) as Array<{
          note_path: string;
          chunk_text: string;
        }>;
        // Visibility comes from the LIVE note, by the ONE rule (cordon OR named
        // `shared_with` grant) — the same source the RAG chunk gate uses, so
        // this overlay and `search_library` can never disagree about a hit.
        //
        // This replaced a `LEFT JOIN clippings` on the note_path, which was
        // wrong in BOTH directions once notes other than clippings got indexed:
        // a media_item note has no clippings row, so its `private_to` came back
        // NULL, which the cordon reads as unset → owner-only. That both LEAKED
        // a household member's own media chunk to the owner (unset admits owner
        // tier) and hid an item explicitly shared with a member from that
        // member. Cached per request because several chunks of one note is the
        // common case.
        const seen = new Map<string, boolean>();
        const visible = (note_path: string): boolean => {
          const hit = seen.get(note_path);
          if (hit !== undefined) return hit;
          const val = deps.memory.note_path_visible_to_caller(note_path, caller);
          seen.set(note_path, val);
          return val;
        };
        out.vault = hits
          .filter((h) => visible(h.note_path))
          .slice(0, limit)
          .map((h) => ({
            note_path: h.note_path,
            snippet: h.chunk_text.slice(0, 300),
          }));
      } catch {
        // chunks_fts may be empty / ingestor not populated; degrade gracefully
        out.vault = [];
      }
    }

    if (want('proposals')) {
      try {
        // System / self-improvement proposals (user_id NULL) are owner-
        // global; user-action proposals cordon to their user. A user-less
        // internal caller sees everything.
        const proposal_filter = user
          ? `AND (p.user_id IS NULL OR p.user_id = @uid)`
          : '';
        const hits = deps.db
          .prepare(
            `SELECT pfts.proposal_id, pfts.specialist_id, p.kind, p.status,
                    p.ts_created, p.rationale_md
             FROM proposals_fts pfts
             JOIN proposals p ON p.id = pfts.proposal_id
             WHERE proposals_fts MATCH @q ${proposal_filter}
             ORDER BY pfts.rank LIMIT @lim`,
          )
          .all({ '@q': ftq, '@lim': limit, ...(user ? { '@uid': user.id } : {}) }) as Array<{
          proposal_id: string;
          specialist_id: string;
          kind: string;
          status: string;
          ts_created: string;
          rationale_md: string;
        }>;
        out.proposals = hits.map((h) => ({
          proposal_id: h.proposal_id,
          specialist_id: h.specialist_id,
          ts_created: h.ts_created,
          status: h.status,
          kind: h.kind,
          snippet: h.rationale_md.slice(0, 300),
        }));
      } catch {
        out.proposals = [];
      }
    }

    return c.json(out);
  });

  return r;
}
