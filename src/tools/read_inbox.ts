/**
 * read_inbox — let a specialist read their own inbox during a chat turn.
 *
 * Before this tool existed, only deliberation passes received the unread
 * inbox bodies (injected by deliberation.ts → inbox.unactioned_for(...)).
 * A chat-turn specialist only saw the *count* via awareness observations;
 * if Jasper asked "what's in your inbox?" they had nothing to actually
 * look at and had to confabulate or admit the gap. This tool closes it.
 *
 * Scope is hard: the SQL filter pins `to_specialist_id` to the calling
 * specialist's id from ctx.specialist_id. There is no way to read another
 * specialist's inbox through this tool; cross-specialist visibility goes
 * through `query_audit_log` (which itself is gated on `read_audit_log`).
 *
 * Capability: `read_inbox` (config/capabilities.yaml). Grant on every
 * specialist's `capabilities` block, and add to their `tools_for_chat`
 * curated set so it surfaces in chat turns specifically.
 *
 * Ships from Beatrice's binding proposal 01KS9E6C4771HH64A8AV8ZMPTM
 * (approved 2026-05-22). Authored by Claude rather than Beatrice because
 * her deliberation tool surface lacks a write-to-disk tool — see the
 * audit-finding file under Knowledge/Trainer/audit-findings/.
 */

import { z } from 'zod';
import { createHash } from 'node:crypto';
import { ulid } from 'ulid';
import type { Tool, ToolContext } from '@core/tool';
import type { ToolDeps } from '@core/tool_deps';
import type { SqlBind } from '@memory/stores/structured';

const InboxKindEnum = z.enum(['flag', 'question', 'fyi', 'consult_response']);

const InputSchema = z.object({
  /**
   * When true (default) only rows with `actioned_at IS NULL` are
   * returned — i.e. work the specialist still owes a response on.
   * Set false to see everything in scope of the other filters.
   */
  only_unactioned: z.coerce.boolean().default(true),
  /** Filter by sender (exact specialist id, e.g. "kate"). */
  from_specialist_id: z.string().optional(),
  /** Filter by inbox kind. */
  kind: InboxKindEnum.optional(),
  /** Newest first. Default 20, max 100. */
  limit: z.coerce.number().int().positive().max(100).default(20),
});

const Row = z.object({
  id: z.string(),
  ts: z.string(),
  from_specialist_id: z.string(),
  kind: z.string(),
  body_md: z.string(),
  related_proposal_id: z.string().nullable(),
  related_interrupt_id: z.string().nullable(),
  read_at: z.string().nullable(),
  actioned_at: z.string().nullable(),
});

const OutputSchema = z.object({
  rows: z.array(Row),
  total_matched: z.number(),
});

type Input = z.infer<typeof InputSchema>;
type Output = z.infer<typeof OutputSchema>;

export function create(deps: ToolDeps): Tool<Input, Output> {
  return {
    name: 'read_inbox',
    description:
      "Read your own inbox — the messages other specialists (and the system) sent you. By default returns only items you haven't yet actioned (the work you still owe a response on). Filters: from_specialist_id (exact sender id), kind ('flag'|'question'|'fyi'|'consult_response'), only_unactioned (default true), limit (default 20, max 100). Returns each row's id, ts, from_specialist_id, kind, body_md, related_proposal_id, related_interrupt_id, read_at, actioned_at — newest first. Scope is per-specialist: you can only ever read inbox rows addressed to you.",
    risk: 'read',
    required_capabilities: ['read_inbox'],
    input_schema: InputSchema,
    output_schema: OutputSchema,

    idempotency_key(input) {
      const h = createHash('sha256');
      h.update(JSON.stringify(input));
      return `read_inbox:${h.digest('hex').slice(0, 16)}`;
    },

    async execute(input, ctx: ToolContext): Promise<Output> {
      // Hard scope: pin to_specialist_id from ctx. A tool call that
      // lands here without a specialist_id (dispatch contexts, smoke
      // scripts) gets nothing — silent empty result instead of an
      // error so a malformed context doesn't blow up the turn.
      const sid = ctx.specialist_id;
      if (!sid) {
        return { rows: [], total_matched: 0 };
      }

      const clauses: string[] = ['to_specialist_id = @sid'];
      const params: Record<string, SqlBind> = { '@sid': sid };
      if (input.only_unactioned) {
        clauses.push('actioned_at IS NULL');
      }
      if (input.from_specialist_id) {
        clauses.push('from_specialist_id = @from');
        params['@from'] = input.from_specialist_id;
      }
      if (input.kind) {
        clauses.push('kind = @kind');
        params['@kind'] = input.kind;
      }
      const where = clauses.join(' AND ');

      const rows = deps.db
        .prepare(
          `SELECT id, ts, from_specialist_id, kind, body_md,
                  related_proposal_id, related_interrupt_id,
                  read_at, actioned_at
           FROM specialist_inboxes
           WHERE ${where}
           ORDER BY ts DESC
           LIMIT @lim`,
        )
        .all({ ...params, '@lim': input.limit }) as Array<{
        id: string;
        ts: string;
        from_specialist_id: string;
        kind: string;
        body_md: string;
        related_proposal_id: string | null;
        related_interrupt_id: string | null;
        read_at: string | null;
        actioned_at: string | null;
      }>;

      const total_row = deps.db
        .prepare(`SELECT COUNT(*) AS n FROM specialist_inboxes WHERE ${where}`)
        .get(params) as { n: number };

      // Mark the rows we returned as read (read_at) but NOT actioned —
      // reading is not the same as acting. The runtime still sees these
      // as unactioned and they keep appearing in unactioned_for() until
      // the specialist files a response or otherwise closes them out.
      if (rows.length > 0) {
        const ids = rows.filter((r) => r.read_at === null).map((r) => r.id);
        if (ids.length > 0) {
          deps.inbox.mark_read(ids);
        }
      }

      ctx.memory.log_action({
        intent_id: ctx.intent_id || ulid(),
        agent: sid,
        tool_name: 'read_inbox',
        tool_input: {
          only_unactioned: input.only_unactioned,
          from_specialist_id: input.from_specialist_id,
          kind: input.kind,
          limit: input.limit,
        },
        execution_result: {
          returned: rows.length,
          total_matched: total_row.n,
        },
      });

      return { rows, total_matched: total_row.n };
    },
  };
}
