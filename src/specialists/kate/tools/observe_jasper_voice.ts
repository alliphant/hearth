import { z } from 'zod';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import type { Tool, ToolContext } from '@core/tool';
import type { ConversationStore } from '@memory/stores/conversations';
import { append_style_observations } from '@specialists/kate/style/append_observations';

const InputSchema = z.object({
  lookback_hours: z.number().positive().max(24 * 30).optional(),
  since_iso: z.string().datetime().optional(),
  max_messages: z.number().positive().max(500).optional(),
  min_chars: z.number().nonnegative().optional(),
});

const OutputSchema = z.object({
  messages_scanned: z.number(),
  observations_emitted: z.number(),
  observations_appended: z.number(),
  entries_after: z.number(),
  rotated: z.number(),
  model: z.string(),
  window_start_iso: z.string(),
});

type Input = z.infer<typeof InputSchema>;
type Output = z.infer<typeof OutputSchema>;

const DEFAULT_LOOKBACK_HOURS = 24 * 7;
const DEFAULT_MAX_MESSAGES = 200;
const DEFAULT_MIN_CHARS = 30;
const MAX_PROMPT_CHARS = 50_000;

interface ObserveResponse {
  observations: string[];
}

function build_user_payload(
  messages: { ts: string; content_md: string }[],
): string {
  const parts: string[] = [];
  let total = 0;
  for (const m of messages) {
    const block = `## turn ${m.ts}\n${m.content_md.trim()}\n\n`;
    if (total + block.length > MAX_PROMPT_CHARS) break;
    parts.push(block);
    total += block.length;
  }
  return parts.join('');
}

function parse_observations(raw: string): string[] {
  let text = raw.trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fence) text = fence[1]!.trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return [];
  try {
    const parsed = JSON.parse(text.slice(start, end + 1)) as ObserveResponse;
    if (!parsed || !Array.isArray(parsed.observations)) return [];
    return parsed.observations
      .filter((o): o is string => typeof o === 'string')
      .map((o) => o.trim())
      .filter((o) => o.length > 0);
  } catch {
    return [];
  }
}

export function make_observe_jasper_voice(
  vault_root: string,
  conversations: ConversationStore,
): Tool<Input, Output> {
  return {
    name: 'observe_jasper_voice',
    description:
      "Scan recent messages Jasper wrote (across all his conversations) and emit 0-N style observations into Knowledge/Kate/jasper_style.md. Filters out typos and grammar slips he'd correct on a reread; captures intentional voice (register, idiom, rhythm). Idempotent: re-running the same window won't duplicate observations. Defaults: last 7 days, up to 200 messages, min 30 chars per message.",
    risk: 'write_internal',
    required_capabilities: ['write_vault_general', 'read_vault'],
    input_schema: InputSchema,
    output_schema: OutputSchema,

    idempotency_key(input) {
      const h = createHash('sha256');
      h.update(String(input.lookback_hours ?? DEFAULT_LOOKBACK_HOURS));
      h.update('\n');
      h.update(input.since_iso ?? '');
      h.update('\n');
      h.update(new Date().toISOString().slice(0, 13)); // hour-resolution
      return `observe_voice:${h.digest('hex').slice(0, 12)}`;
    },

    async execute(input, ctx: ToolContext): Promise<Output> {
      const lookback_hours = input.lookback_hours ?? DEFAULT_LOOKBACK_HOURS;
      const since_iso =
        input.since_iso ??
        new Date(ctx.now.getTime() - lookback_hours * 3_600_000).toISOString();
      const max_messages = input.max_messages ?? DEFAULT_MAX_MESSAGES;
      const min_chars = input.min_chars ?? DEFAULT_MIN_CHARS;

      const rows = conversations.list_user_messages_since(since_iso, {
        limit: max_messages,
        min_chars,
      });

      if (rows.length === 0) {
        return {
          messages_scanned: 0,
          observations_emitted: 0,
          observations_appended: 0,
          entries_after: 0,
          rotated: 0,
          model: '',
          window_start_iso: since_iso,
        };
      }

      const prompts_dir = process.env.HEARTH_PROMPTS_DIR ?? './config/prompts';
      const prompt_path = resolve(prompts_dir, 'kate_observe_voice.md');
      if (!existsSync(prompt_path)) {
        throw new Error(`kate_observe_voice.md prompt missing at ${prompt_path}`);
      }
      const system_prompt = readFileSync(prompt_path, 'utf8');
      const user_payload = build_user_payload(rows);

      // Runs on the interactive 9B (`planner`), NOT the deep tier. This is an
      // hourly style-skim, not deep reasoning — and on the deep 35B
      // (`reflector`) it timed out 54× in 14 days (~16% of hourly runs),
      // wasting deep-tier slots that chat/voice/briefs contend for. A plain
      // summarization completion is well within the 9B. `reflector` stays on
      // the deep tier for the task that needs it (Mariah's pattern scan).
      const role = ctx.llm.for_role('planner');
      const resp = await role.provider.complete({
        messages: [
          { role: 'system', content: system_prompt },
          { role: 'user', content: user_payload },
        ],
        temperature: role.defaults.temperature,
      });

      const observations = parse_observations(resp.content);
      const append = append_style_observations(
        ctx.memory,
        vault_root,
        observations,
        ctx.now,
        ctx.user?.timezone,
      );

      return {
        messages_scanned: rows.length,
        observations_emitted: observations.length,
        observations_appended: append.appended,
        entries_after: append.entries_after,
        rotated: append.rotated,
        model: resp.cost.model,
        window_start_iso: since_iso,
      };
    },
  };
}
