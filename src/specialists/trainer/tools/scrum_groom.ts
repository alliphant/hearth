import { z } from 'zod';
import { createHash } from 'node:crypto';
import { ulid } from 'ulid';
import type { Tool, ToolContext } from '@core/tool';
import { ScrumStore, LANES } from '@memory/stores/scrum';

function db_of(ctx: ToolContext): import('bun:sqlite').Database {
  return (ctx.memory as unknown as { cfg: { db: import('bun:sqlite').Database } }).cfg.db;
}

const InputSchema = z.object({
  project_slug: z.string().optional(),
});

const ItemSchema = z.object({
  epic_id: z.string(),
  size: z.enum(['S', 'M', 'L']),
  value: z.enum(['S', 'M', 'L']).optional(),
  severity: z.enum(['critical', 'high', 'medium', 'low']).optional(),
});

const OutputSchema = z.object({
  scored: z.number(),
  unscored_remaining: z.number(),
  items: z.array(ItemSchema),
});

type Input = z.infer<typeof InputSchema>;
type Output = z.infer<typeof OutputSchema>;

const SYS = `You are a senior product manager scoring a software backlog. For each epic assign:
- size (S/M/L) = effort
- for a feature: value (S/M/L) = user-facing impact
- for a bug: severity = critical/high/medium/low
Reply with STRICT JSON ONLY: an array of objects with keys epic_id, size, and either value (features) or severity (bugs). No prose, no markdown.`;

export const scrum_groom: Tool<Input, Output> = {
  name: 'scrum_groom',
  description:
    'Score every UNSCORED epic on the dev-board: ask the deep model to size + value/severity each, then persist via ScrumStore.score_epics. Returns how many were scored and how many remain.',
  risk: 'write_internal',
  required_capabilities: ['manage_scrum'],
  input_schema: InputSchema,
  output_schema: OutputSchema,

  idempotency_key(input) {
    return `scrum_groom:${createHash('sha256').update(JSON.stringify(input)).digest('hex').slice(0, 16)}`;
  },

  async execute(input: Input, ctx: ToolContext): Promise<Output> {
    const store = new ScrumStore(db_of(ctx));
    const board = store.read_board();
    let unscored = LANES.flatMap((l) => board.lanes[l]).filter((c) => c.unscored);
    if (input.project_slug) {
      unscored = unscored.filter((c) => c.project_slug === input.project_slug);
    }
    if (unscored.length === 0) {
      return { scored: 0, unscored_remaining: 0, items: [] };
    }

    const user = unscored
      .map((c) => `${c.id} [${c.type}] "${c.title}" — ${c.description ?? ''}`)
      .join('\n');

    const resolved = ctx.llm.for_role('deep_consult');
    const resp = await resolved.provider.complete({
      ...resolved.defaults,
      messages: [
        { role: 'system', content: SYS },
        { role: 'user', content: user },
      ],
    });
    const text = resp.content;

    const m = text.match(/\[[\s\S]*\]/);
    if (!m) {
      throw new Error(`scrum_groom: deep model returned no JSON array: ${text.slice(0, 200)}`);
    }
    const raw = JSON.parse(m[0]);
    const unscored_ids = new Set(unscored.map((c) => c.id));
    const validated = z
      .array(ItemSchema)
      .parse(raw)
      .filter((it) => unscored_ids.has(it.epic_id));

    const { scored } = store.score_epics(
      validated.map((it) => ({
        epic_id: it.epic_id,
        size: it.size,
        value: it.value,
        severity: it.severity,
      })),
    );

    const after = store.read_board();
    let rem = LANES.flatMap((l) => after.lanes[l]).filter((c) => c.unscored);
    if (input.project_slug) {
      rem = rem.filter((c) => c.project_slug === input.project_slug);
    }

    ctx.memory.log_action({
      intent_id: ctx.intent_id || ulid(),
      agent: ctx.specialist_id ?? 'trainer',
      tool_name: 'scrum_groom',
      tool_input: { project_slug: input.project_slug ?? null, candidates: unscored.length },
      execution_result: { scored, unscored_remaining: rem.length },
    });

    return { scored, unscored_remaining: rem.length, items: validated };
  },
};
