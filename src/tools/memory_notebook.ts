/**
 * remember / read_memory — the universal memory notebook (2026-07-17).
 *
 * Before this pair existed, most specialists had NO way to durably
 * remember anything: only Maggie/Astrid/Brigid had bespoke vault
 * writers, and everyone else's only write path was filing a PROPOSAL
 * and waiting for owner approval. The failure that motivated this:
 * Mariah, asked to remember a session preference, filed a proposal she
 * then couldn't even read back (see read_my_proposals), and
 * hallucinated its content from a truncated audit preview.
 *
 * Both tools are hard-scoped to the caller's OWN
 * `Knowledge/<Name>/memory.md` (per-user isolation included — non-Jasper
 * users write `memory_<user_id>.md`, matching deliberation's own
 * memory writes in src/core/memory_files.ts). The path is derived from
 * ctx.specialist_id, never from input, so no capability token is
 * needed: there is nothing a caller could reach beyond their own
 * notebook. Growth is bounded by the existing weekly compact_memory
 * maintenance (entries older than 30 days fold into the archive
 * summary), so unbounded remembering stays safe.
 *
 * risk: `remember` is write_internal (vault-only side effect,
 * auto-approved per the v0 gateway policy); `read_memory` is read.
 * Both ship in the BASE_TOOLSET floor (specialist_runtime.ts) so every
 * specialist has them on chat AND deliberation surfaces.
 */

import { z } from 'zod';
import { createHash } from 'node:crypto';
import { ulid } from 'ulid';
import type { Tool, ToolContext } from '@core/tool';
import {
  append_to_memory,
  memory_path,
  read_memory as read_memory_entries,
} from '@core/memory_files';

const RememberInput = z.object({
  /** The thing to remember, as durable prose. Written verbatim under a
   *  dated header — write it so future-you understands it cold. */
  note: z.string().min(3).max(8_000),
  /** Optional short tag rendered next to the entry's date header,
   *  e.g. "user preference", "open loop", "lesson". */
  context_tag: z.string().min(1).max(60).optional(),
});

const RememberOutput = z.object({
  saved: z.boolean(),
  memory_file: z.string().nullable(),
});

type RememberIn = z.infer<typeof RememberInput>;
type RememberOut = z.infer<typeof RememberOutput>;

export const remember: Tool<RememberIn, RememberOut> = {
  name: 'remember',
  description:
    "Durably remember something by appending a dated entry to YOUR OWN memory notebook (Knowledge/<You>/memory.md). Use this the moment you learn something worth keeping — a user preference, a decision, a lesson from a mistake, an open loop to revisit — instead of filing a proposal or hoping the conversation stays in context. Example: {note: \"Jasper prefers terse morning briefs — bullet points, no preamble.\", context_tag: \"user preference\"}. The entry is immediately visible to your future turns via read_memory and your deliberation passes. Writes only to your own notebook; no approval needed.",
  risk: 'write_internal',
  required_capabilities: [],
  input_schema: RememberInput,
  output_schema: RememberOutput,

  idempotency_key(input) {
    const h = createHash('sha256');
    h.update(input.note);
    h.update('\n');
    h.update(input.context_tag ?? '');
    return `remember:${h.digest('hex').slice(0, 16)}`;
  },

  async execute(input, ctx: ToolContext): Promise<RememberOut> {
    // Hard scope: the notebook path derives from ctx.specialist_id.
    // A call without one (dispatch contexts, smoke scripts) is a
    // silent no-op rather than an error, mirroring read_inbox.
    const sid = ctx.specialist_id;
    if (!sid) {
      return { saved: false, memory_file: null };
    }
    append_to_memory(
      ctx.memory,
      sid,
      input.note,
      input.context_tag,
      ctx.user?.id,
    );
    const file = memory_path(sid, ctx.user?.id);
    ctx.memory.log_action({
      intent_id: ctx.intent_id || ulid(),
      agent: sid,
      user_id: ctx.user?.id,
      tool_name: 'remember',
      tool_input: {
        note_preview: input.note.slice(0, 120),
        context_tag: input.context_tag,
      },
      execution_result: { memory_file: file },
    });
    return { saved: true, memory_file: file };
  },
};

const ReadMemoryInput = z.object({
  /** How many of the most recent entries to return. */
  last_n: z.coerce.number().int().min(1).max(200).default(30),
});

const ReadMemoryOutput = z.object({
  memory_file: z.string().nullable(),
  /** Newest-last dated entries, exactly as written. */
  entries: z.array(
    z.object({ date: z.string(), body: z.string() }),
  ),
  /** The compacted pre-archive summary block, if the notebook has one. */
  archive_summary: z.string().nullable(),
  total_returned: z.number(),
});

type ReadMemoryIn = z.infer<typeof ReadMemoryInput>;
type ReadMemoryOut = z.infer<typeof ReadMemoryOutput>;

export const read_memory: Tool<ReadMemoryIn, ReadMemoryOut> = {
  name: 'read_memory',
  description:
    'Read the most recent entries from YOUR OWN memory notebook (Knowledge/<You>/memory.md) — everything you previously saved with `remember`, plus your deliberation passes\' running notes and the compacted archive summary of older entries. Use it when you suspect past-you knew something relevant: a stated preference, a prior decision, an open loop. {last_n: 30} by default, up to 200. Reads only your own notebook.',
  risk: 'read',
  required_capabilities: [],
  input_schema: ReadMemoryInput,
  output_schema: ReadMemoryOutput,

  idempotency_key(input) {
    return `read_memory:${input.last_n}`;
  },

  async execute(input, ctx: ToolContext): Promise<ReadMemoryOut> {
    const sid = ctx.specialist_id;
    if (!sid) {
      return {
        memory_file: null,
        entries: [],
        archive_summary: null,
        total_returned: 0,
      };
    }
    const { archive, entries } = read_memory_entries(
      ctx.memory,
      sid,
      input.last_n,
      ctx.user?.id,
    );
    const rows = entries.map((e) => ({
      date: e.date_header.replace(/^## /, ''),
      body: e.body,
    }));
    ctx.memory.log_action({
      intent_id: ctx.intent_id || ulid(),
      agent: sid,
      user_id: ctx.user?.id,
      tool_name: 'read_memory',
      tool_input: { last_n: input.last_n },
      execution_result: { returned: rows.length, has_archive: !!archive },
    });
    return {
      memory_file: memory_path(sid, ctx.user?.id),
      entries: rows,
      archive_summary: archive ? archive.body : null,
      total_returned: rows.length,
    };
  },
};
