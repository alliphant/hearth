/**
 * push_coaching_note — Astrid sends a short live-mode coaching push.
 *
 * Two things in one call:
 *   1. Sends the message via APNs through the existing `push_text`
 *      infra (src/policy/push.ts) — same path Kate's briefs and
 *      proposal pushes use. Bypasses quiet hours because the user
 *      is actively working out (an active-session check inside
 *      push_text would be cleaner — deferred to a future hardening
 *      pass; for v1 Astrid just sends and the throttle subscriber
 *      gates the cadence upstream).
 *   2. Appends a row to users/<user_id>/astrid/coaching-log.md so
 *      the decision is audit-able (the "you nagged me too much"
 *      debuggability promise from the Pass 1 design).
 *
 * Also records the push timestamp on the in-memory session so the
 * throttle subscriber's 10-min hard cap and 15-min check-in budget
 * stay accurate.
 *
 * Capability: write_vault_astrid. The push side reuses existing
 * push_text infra (which already has its own internal config gates).
 */

import { z } from 'zod';
import { createHash } from 'node:crypto';
import { ulid } from 'ulid';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import type { Tool, ToolContext } from '@core/tool';
import type { ToolDeps } from '@core/tool_deps';
import type { WorkoutSessionTracker } from '../../../app/routes/workout';
import { push_text } from '../../../policy/push';

const TriggerEnum = z.enum([
  'pr_in_reach',
  'hr_zone_drift',
  'midpoint',
  'final_push',
  'check_in',
  'session_start',
  'session_end',
  'manual',
]);

const InputSchema = z.object({
  user_id: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Omit — defaults to the conversation's user (resolved from context). Only set it to explicitly target a different household member.",
    ),
  session_id: z
    .string()
    .min(1)
    .nullable()
    .optional()
    .describe(
      'Active workout session id from get_workout_state. When provided, the push is recorded against the session for throttle accounting. Null/omitted when sending an out-of-session note (rare; coaching is usually scoped to live sessions).',
    ),
  message: z
    .string()
    .min(1)
    .max(180)
    .describe(
      'The coaching note — short, voice-on, actionable. Lock-screen capped: aim under 120 chars to render cleanly without truncation across watch + phone. Astrid voice: warm-blunt + dry. ("12 min in. Cadence is steady. You\'ve got this.")',
    ),
  trigger: TriggerEnum.describe(
    'Why Astrid pushed (or chose to push). Logged to coaching-log for tuning + future audit; the throttle subscriber sets this when the auto-trigger fires.',
  ),
  rationale: z
    .string()
    .max(400)
    .optional()
    .describe(
      'One sentence on why this push at this moment. Goes into the coaching log for transparency.',
    ),
});

const OutputSchema = z.object({
  delivered: z.boolean(),
  via: z.string().nullable(),
  log_rel_path: z.string(),
  bytes_logged: z.number(),
  error: z.string().nullable(),
});

type Input = z.infer<typeof InputSchema>;
type Output = z.infer<typeof OutputSchema>;

let _tracker: WorkoutSessionTracker | null = null;

export function register_tracker(tracker: WorkoutSessionTracker): void {
  _tracker = tracker;
}

const COACHING_LOG_HEADER = `# Astrid's coaching-decision log

Every push Astrid sent AND every push she chose NOT to send. Trigger,
decision, one-sentence why. Makes "you nagged me too much last week"
debuggable, and gives Beatrice concrete substrate for persona tuning.
Newest first; capped at 500 entries.

<!-- entries below -->
`;

const MAX_LOG_ENTRIES = 500;

function append_capped(existing: string, header: string, entry: string, cap: number): string {
  let content = existing.length > 0 ? existing : header;
  if (!content.startsWith('# ')) content = header + '\n' + content;
  const marker = '<!-- entries below -->';
  const idx = content.indexOf(marker);
  const insert_at = idx >= 0 ? idx + marker.length : content.length;
  const prefix = content.slice(0, insert_at);
  const suffix = content.slice(insert_at);
  let next = `${prefix}\n\n${entry}\n${suffix}`;
  const headers = [...next.matchAll(/^### /gm)];
  if (headers.length > cap) {
    const cutoff = headers[cap];
    if (cutoff && cutoff.index !== undefined) {
      next = next.slice(0, cutoff.index);
    }
  }
  return next;
}

export function create(deps: ToolDeps): Tool<Input, Output> {
  return {
    name: 'push_coaching_note',
    description:
      "Send a short coaching push to the user mid-workout (or at session end) AND log the decision to Astrid's coaching-log. Use sparingly — the live-mode throttle subscriber decides when to invoke this; Astrid's persona shouldn't reach for it on every packet. Auto-records the push timestamp against the session for throttle accounting.",
    risk: 'send_external', // pushing to a user's device is an external action
    required_capabilities: ['write_vault_astrid'],
    input_schema: InputSchema,
    output_schema: OutputSchema,

    idempotency_key(input) {
      const h = createHash('sha256');
      h.update(input.user_id ?? '');
      h.update('\n');
      h.update(input.message);
      h.update('\n');
      h.update(input.trigger);
      if (input.session_id) h.update(`\n${input.session_id}`);
      return `push_coaching_note:${h.digest('hex').slice(0, 16)}`;
    },

    async execute(input, ctx: ToolContext): Promise<Output> {
      const ts = (ctx.now ?? new Date()).toISOString();
      const intent_id = ctx.intent_id || ulid();
      // user_id is ambient — the conversation's user, not a value the model
      // can know. Resolve from context; the optional input arg is an explicit
      // override only. Removes the persona-advertised 2-arg call from spiraling
      // on a missing user_id (or fabricating "jasper").
      const user_id = input.user_id ?? ctx.user?.id;
      if (!user_id) {
        throw new Error(
          'push_coaching_note: no user on ToolContext and no user_id override — cannot resolve whose coaching-log to write.',
        );
      }

      // Send the push. push_text resolves the default user from the
      // UserRegistry — for v1 single-user that's Jasper; multi-user
      // fan-out (Sam) lands when the per-user push routing matures.
      const push_result = await push_text(
        input.message,
        ctx.memory,
        intent_id,
        `astrid:coaching:${input.trigger}`,
      );

      // Record against the session for throttle accounting.
      if (input.session_id && _tracker) {
        _tracker.record_push(input.session_id, ts);
      }

      // Append to coaching-log either way (sent or failed). The log
      // is for Astrid's decision audit, not just for successful pushes.
      const rel_path = `users/${user_id}/astrid/coaching-log.md`;
      const abs_path = resolve(deps.vault_root, rel_path);
      const existing = existsSync(abs_path) ? readFileSync(abs_path, 'utf8') : '';
      const entry = [
        `### ${ts}`,
        '',
        `**Trigger**: ${input.trigger} · **Delivered**: ${push_result.delivered ? 'yes' : 'no'}${push_result.via ? ` (via ${push_result.via})` : ''}`,
        '',
        `> ${input.message}`,
        '',
        input.rationale ? `_${input.rationale}_` : '',
        input.session_id ? `_session: ${input.session_id}_` : '',
      ].filter((s) => s.length > 0).join('\n');
      const final_content = append_capped(existing, COACHING_LOG_HEADER, entry, MAX_LOG_ENTRIES);
      mkdirSync(dirname(abs_path), { recursive: true });
      writeFileSync(abs_path, final_content, 'utf8');

      ctx.memory.log_action({
        intent_id,
        agent: ctx.specialist_id ?? 'astrid',
        tool_name: 'push_coaching_note',
        tool_input: {
          trigger: input.trigger,
          session_id: input.session_id ?? null,
          message_chars: input.message.length,
          rationale_chars: input.rationale?.length ?? 0,
        },
        execution_result: {
          delivered: push_result.delivered,
          via: push_result.via ?? null,
          log_rel_path: rel_path,
        },
      });

      return {
        delivered: push_result.delivered,
        via: push_result.via ?? null,
        log_rel_path: rel_path,
        bytes_logged: final_content.length,
        error: push_result.error ?? null,
      };
    },
  };
}
