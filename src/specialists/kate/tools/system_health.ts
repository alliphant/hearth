/**
 * system_health — Kate's "is everything working?" read (2026-06-20).
 *
 * Reads the open health-incident ledger (what the scan last flagged) so Kate
 * can answer the owner directly, with an honest "down for N days". Cheap — no
 * probing on the chat turn; it reflects the monitored state from the latest
 * scan_system_health run.
 */
import { z } from 'zod';
import type { Tool, ToolContext } from '@core/tool';
import type { ToolDeps } from '@core/tool_deps';
import { DEPENDENCIES } from '@core/system_health';
import { HealthIncidentStore, down_duration_human } from '@memory/stores/system_health';

const InputSchema = z.object({});
const IncidentSchema = z.object({
  dependency: z.string(),
  label: z.string(),
  status: z.string(),
  down_for: z.string(),
  reason: z.string().nullable(),
  impact: z.string(),
  restartable: z.boolean(),
  restart_attempts: z.number(),
});
const OutputSchema = z.object({
  all_ok: z.boolean(),
  open_incidents: z.array(IncidentSchema),
  summary: z.string(),
});

type Input = z.infer<typeof InputSchema>;
type Output = z.infer<typeof OutputSchema>;

export interface SystemHealthReadDeps {
  db: import('bun:sqlite').Database;
}

export function make_system_health(deps: SystemHealthReadDeps): Tool<Input, Output> {
  return {
    name: 'system_health',
    description:
      "Check whether Hearth's services are healthy — answers 'is everything working?'. Returns the dependencies currently flagged degraded/down (Firecrawl, SearXNG, the browser, embeddings, Home Assistant, …) with how long they've been down and what it affects. Use it when the owner asks if something's broken, or before you tell them a tool 'isn't working'.",
    risk: 'read',
    required_capabilities: ['monitor_system_health'],
    input_schema: InputSchema,
    output_schema: OutputSchema,
    volatile: true,

    idempotency_key() {
      return `system_health:${Math.floor(Date.now() / 60_000)}`;
    },

    async execute(_input, _ctx: ToolContext): Promise<Output> {
      const incidents = new HealthIncidentStore(deps.db);
      const open = incidents.list_open();
      const open_incidents = open.map((inc) => {
        const def = DEPENDENCIES.find((d) => d.name === inc.dependency);
        return {
          dependency: inc.dependency,
          label: def?.label ?? inc.dependency,
          status: inc.status,
          down_for: down_duration_human(inc.first_seen),
          reason: inc.reason,
          impact: def?.impact ?? '',
          restartable: def?.restartable ?? false,
          restart_attempts: inc.restart_attempts,
        };
      });
      const all_ok = open_incidents.length === 0;
      const summary = all_ok
        ? 'All monitored services look healthy as of the latest health scan.'
        : open_incidents
            .map((i) => `${i.label} is ${i.status} (${i.down_for}) — ${i.impact}`)
            .join('; ');
      return { all_ok, open_incidents, summary };
    },
  };
}

export function create(deps: ToolDeps): Tool {
  return make_system_health({ db: deps.db }) as Tool;
}
