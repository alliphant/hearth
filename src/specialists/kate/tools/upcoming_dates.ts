import { z } from 'zod';
import { createHash } from 'node:crypto';
import type { Tool, ToolContext } from '@core/tool';

const EventKind = z.enum(['birthday', 'anniversary']);

const InputSchema = z.object({
  days_ahead: z.number().int().positive().max(366).default(14),
  types: z.array(EventKind).optional(),
});

const DateEventSchema = z.object({
  kind: EventKind,
  person_id: z.string(),
  name: z.string(),
  note_path: z.string(),
  date: z.string(),
  days_until: z.number().int(),
  what: z.string().optional(),
});

const OutputSchema = z.object({
  events: z.array(DateEventSchema),
});

type Input = z.infer<typeof InputSchema>;
type Output = z.infer<typeof OutputSchema>;

export const upcoming_dates: Tool<Input, Output> = {
  name: 'upcoming_dates',
  description:
    'List upcoming birthdays and anniversaries from the people table within `days_ahead` days, sorted soonest first. Pass days_ahead=60 for the occasions sweep (gift lead time).',
  risk: 'read',
  // Cross-registered to specialists (Kate's social-secretary surface)
  // via the kate tools pack — same pattern as the Scribe person tools
  // below it in that pack. The /concierge/* route ignores this field.
  required_capabilities: ['read_vault'],
  input_schema: InputSchema,
  output_schema: OutputSchema,

  idempotency_key(input) {
    const h = createHash('sha256');
    h.update(String(input.days_ahead));
    h.update('\n');
    h.update((input.types ?? []).slice().sort().join(','));
    return `upcoming_dates:${h.digest('hex').slice(0, 16)}`;
  },

  async execute(input, ctx: ToolContext): Promise<Output> {
    const events = ctx.memory.upcoming_dates(input.days_ahead, input.types);
    return { events };
  },
};
