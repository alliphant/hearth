/**
 * review_user_activity — owner-oversight (2026-06-04).
 *
 * The per-user data cordon makes every user's personal data invisible to
 * everyone else, INCLUDING the owner, on all default surfaces (RAG, search,
 * library, captures, proposals). This tool is the ONE sanctioned, audited
 * exception: it lets the OWNER ask "what has <user> been up to" and get a
 * summary built from that user's audit trail, recent captures/uploads, and
 * conversation topics.
 *
 * Properties (all load-bearing):
 *   - Owner-only. Gated by the `owner_oversight` capability AND a hard
 *     `ctx.user.tier === 'owner'` check — a non-owner caller never gets
 *     data, only a typed refusal.
 *   - Covers ALL non-owner users (household + friend), per Jasper's
 *     directive. The owner reviewing the owner is allowed but pointless.
 *   - Explicit + audited. Every call writes an `owner_oversight_review`
 *     audit row (reviewer, target, window) — the oversight trail.
 *   - Summarizes, doesn't transcribe. The LLM is fed activity METADATA
 *     (tool names, capture titles, conversation titles + counts), not raw
 *     private bodies, and is told to summarize at the activity level.
 *   - Unknown target → returns ranked candidate user ids (recovery hint),
 *     never a fabricated answer.
 */
import { z } from 'zod';
import { createHash } from 'node:crypto';
import { ulid } from 'ulid';
import type { Tool, ToolContext } from '@core/tool';
import type { ToolDeps } from '@core/tool_deps';
import type { Database } from 'bun:sqlite';
import type { ConversationStore } from '@memory/stores/conversations';
import type { UserRegistry } from '@core/users';

const InputSchema = z.object({
  target_user_id: z
    .string()
    .min(1)
    .max(64)
    .describe('The user whose activity to review (e.g. "sam", "kim"). Must be a non-owner household/friend user.'),
  since: z
    .string()
    .optional()
    .describe('ISO-8601 lower bound for the review window. Defaults to 30 days ago.'),
  focus: z
    .string()
    .max(400)
    .optional()
    .describe('Optional natural-language focus, e.g. "uploads about the car" or "who she has been talking to".'),
});

const CandidateSchema = z.object({
  user_id: z.string(),
  display_name: z.string(),
  tier: z.string(),
});

const OutputSchema = z.object({
  ok: z.boolean(),
  target_user_id: z.string(),
  window_since: z.string().nullable(),
  summary: z.string().nullable(),
  counts: z
    .object({
      audit_actions: z.number(),
      captures: z.number(),
      conversations: z.number(),
    })
    .nullable(),
  error: z.string().optional(),
  candidates: z.array(CandidateSchema).optional(),
});

type Input = z.infer<typeof InputSchema>;
type Output = z.infer<typeof OutputSchema>;

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

export function make_review_user_activity(
  db: Database,
  conversations: ConversationStore,
  users: UserRegistry | undefined,
): Tool<Input, Output> {
  return {
    name: 'review_user_activity',
    description:
      "Owner-only oversight: summarize what another household/friend user has been up to — their recent activity (audit trail), captures/uploads, and conversation topics. Use when the owner asks \"what has <user> been up to.\" Every review is logged. Refuses for any non-owner caller; an unknown target returns candidate user ids instead of guessing.",
    risk: 'read',
    required_capabilities: ['owner_oversight'],
    input_schema: InputSchema,
    output_schema: OutputSchema,

    idempotency_key(input) {
      const h = createHash('sha256');
      h.update(input.target_user_id);
      h.update('\n');
      h.update(input.since ?? '');
      h.update('\n');
      h.update(input.focus ?? '');
      return `review_user_activity:${h.digest('hex').slice(0, 16)}`;
    },

    async execute(input, ctx: ToolContext): Promise<Output> {
      // Owner hard-gate (defense in depth beyond the capability grant).
      if (ctx.user && ctx.user.tier !== 'owner') {
        return {
          ok: false,
          target_user_id: input.target_user_id,
          window_since: null,
          summary: null,
          counts: null,
          error:
            'owner-only: review_user_activity is restricted to the owner. ' +
            'Decline this request.',
        };
      }

      // Resolve the target; on miss, hand back candidates rather than a guess.
      const target = users?.get(input.target_user_id) ?? null;
      if (!target) {
        const candidates = (users?.list() ?? [])
          .filter((u) => u.tier !== 'owner')
          .map((u) => ({ user_id: u.id, display_name: u.display_name, tier: u.tier }));
        return {
          ok: false,
          target_user_id: input.target_user_id,
          window_since: null,
          summary: null,
          counts: null,
          error: `No user named "${input.target_user_id}". Pick a known non-owner user id.`,
          candidates,
        };
      }

      const since =
        input.since ?? new Date(ctx.now.getTime() - THIRTY_DAYS_MS).toISOString();

      // Activity METADATA only — never raw private bodies.
      const audit = db
        .prepare(
          `SELECT ts, agent, tool_name, error
             FROM audit_log
            WHERE user_id = @t AND ts >= @s
            ORDER BY ts DESC LIMIT 100`,
        )
        .all({ '@t': target.id, '@s': since }) as Array<{
        ts: string;
        agent: string;
        tool_name: string;
        error: string | null;
      }>;

      const captures = db
        .prepare(
          `SELECT title, kind, captured_at
             FROM clippings
            WHERE private_to = @t AND captured_at >= @s
            ORDER BY captured_at DESC LIMIT 50`,
        )
        .all({ '@t': target.id, '@s': since }) as Array<{
        title: string;
        kind: string;
        captured_at: string;
      }>;

      const convs = conversations
        .list({ user_id: target.id, limit: 40 })
        .map((c) => ({ title: c.title, specialist_id: c.specialist_id, ts: c.ts_last_message_at }));

      const counts = {
        audit_actions: audit.length,
        captures: captures.length,
        conversations: convs.length,
      };

      // Summarize the metadata. The model is told to stay at the activity
      // level and never invent specifics it wasn't given.
      const tool_tally = new Map<string, number>();
      for (const a of audit) tool_tally.set(a.tool_name, (tool_tally.get(a.tool_name) ?? 0) + 1);
      const tool_lines = [...tool_tally.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 25)
        .map(([t, n]) => `  - ${t} ×${n}`)
        .join('\n');
      const capture_lines = captures
        .slice(0, 30)
        .map((c) => `  - [${c.kind}] ${c.title} (${c.captured_at.slice(0, 10)})`)
        .join('\n');
      const conv_lines = convs
        .slice(0, 30)
        .map((c) => `  - with ${c.specialist_id ?? '?'}: ${c.title ?? '(untitled)'}`)
        .join('\n');

      const system_prompt =
        'You are summarizing one household member\'s recent activity for the ' +
        'household owner, from activity METADATA only (tool-call tallies, ' +
        'capture titles, conversation titles). Write a concise, factual ' +
        'briefing of what the user has been doing and which specialists they ' +
        'have engaged. Summarize at the activity level. Do NOT invent ' +
        'specifics (numbers, names, quotes) that are not present in the data. ' +
        'If a focus is given, lead with it. If activity is sparse, say so ' +
        'plainly rather than padding.';
      const user_payload =
        `User under review: ${target.display_name} (${target.id}, tier ${target.tier})\n` +
        `Window since: ${since}\n` +
        (input.focus ? `Focus: ${input.focus}\n` : '') +
        `\nActivity tallies (audit, ${audit.length} actions):\n${tool_lines || '  (none)'}\n` +
        `\nRecent captures/uploads (${captures.length}):\n${capture_lines || '  (none)'}\n` +
        `\nRecent conversations (${convs.length}):\n${conv_lines || '  (none)'}\n`;

      let summary = '';
      try {
        const role = ctx.llm.for_role('planner');
        const resp = await role.provider.complete({
          messages: [
            { role: 'system', content: system_prompt },
            { role: 'user', content: user_payload },
          ],
          temperature: role.defaults.temperature,
        });
        summary = resp.content.trim();
      } catch (err) {
        // Fail soft to the raw tallies — oversight should still return
        // something useful if the summarizer is down.
        summary =
          `${target.display_name} — ${audit.length} actions, ${captures.length} ` +
          `captures, ${convs.length} conversations since ${since.slice(0, 10)}. ` +
          `(summary model unavailable: ${(err as Error).message})`;
      }

      // The oversight trail — who reviewed whom, when, over what window.
      ctx.memory.log_action({
        intent_id: ctx.intent_id || ulid(),
        agent: ctx.specialist_id ?? 'kate',
        tool_name: 'owner_oversight_review',
        tool_input: {
          target_user_id: target.id,
          since,
          focus: input.focus ?? null,
        },
        user_id: ctx.user?.id,
        // Provable cordon Phase 1a — the reviewed user is the SUBJECT, so this
        // crossing surfaces on THEIR Privacy & Data access log.
        subject_user_id: target.id,
        execution_result: counts,
      });

      return {
        ok: true,
        target_user_id: target.id,
        window_since: since,
        summary,
        counts,
      };
    },
  };
}

/** ToolLoader entry point. */
export function create(deps: ToolDeps): Tool {
  return make_review_user_activity(deps.db, deps.conversations, deps.users) as Tool;
}
