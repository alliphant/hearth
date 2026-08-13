import { z } from 'zod';
import type { Tool, ToolContext } from '@core/tool';
import { safe_fetch } from './_audit';
import { require_caller_tier } from '@core/tool_gates';

// FRIDAY's health source is the watchdog's aggregate status endpoint
// (`GET /status` → `{ modules: [...] }` with per-module state, severity,
// heartbeat, and EV/yard/bridge health). It superseded the old Helix
// kiosk UI at `your-always-on-host.local:3000/api/status` when the FRIDAY mesh migrated
// to the LLM host (2026-05-29); the kiosk is a separate project and may be
// offline. The containerized deploy overrides this via FRIDAY_UI_STATUS_URL
// (host.docker.internal:8770); the default below is correct for a native
// same-host run. Env var name kept for backward compat.
const FRIDAY_UI_STATUS_URL =
  process.env.FRIDAY_UI_STATUS_URL ?? 'http://localhost:8770/status';

const InputSchema = z.object({}).strict();

const OutputSchema = z.object({
  reachable: z.boolean(),
  status: z.record(z.string(), z.unknown()).optional(),
  error: z.string().optional(),
  url: z.string(),
});

type Input = z.infer<typeof InputSchema>;
type Output = z.infer<typeof OutputSchema>;

export const friday_status: Tool<Input, Output> = {
  name: 'friday_status',
  description:
    'Read FRIDAY\'s health from the watchdog status endpoint — returns `modules[]`, each with state (HEALTHY/DEGRADED/FAILED), severity, last heartbeat, and EV/yard/bridge health. Returns reachable=false (not a thrown error) when the watchdog is restarting or unreachable, so callers stay functional during FRIDAY bounces.',
  risk: 'read',
  required_capabilities: ['read_friday_system'],
  input_schema: InputSchema,
  output_schema: OutputSchema,

  idempotency_key() {
    return 'friday_status:singleton';
  },

  async execute(_input: Input, ctx: ToolContext): Promise<Output> {
    // Phase 2b/4 — household tier OK (kiosk state is shared household
    // infra), friend tier blocked (system status isn't theirs to see).
    require_caller_tier(ctx, ['owner', 'household']);
    const res = await safe_fetch(FRIDAY_UI_STATUS_URL, { method: 'GET' }, 5_000);
    if (!res.ok) {
      return {
        reachable: false,
        error: res.error ?? `FRIDAY UI HTTP ${res.status}`,
        url: FRIDAY_UI_STATUS_URL,
      };
    }
    try {
      const status = JSON.parse(res.body) as Record<string, unknown>;
      return { reachable: true, status, url: FRIDAY_UI_STATUS_URL };
    } catch {
      // Some Helix builds return non-JSON; surface as reachable but unparsed.
      return {
        reachable: true,
        status: { raw: res.body.slice(0, 1000) },
        url: FRIDAY_UI_STATUS_URL,
      };
    }
  },
};
