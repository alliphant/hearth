/**
 * home_assistant_automation — read HA AUTOMATION configs (trigger /
 * condition / action YAML), the layer `ha_get_state` can't see.
 *
 * Shipped 2026-08-11 from approved binding proposal 01KY5SZ3BQNKCS0Y4XZ6VT6BTZ
 * (spec: Knowledge/Trainer/binding-proposals/ha-get-automation.md). The
 * original grantee was Cassandra; the security fold (2026-07-15) moved the
 * perimeter into Kate, so she holds the grant — the driving case is reading
 * the lightning-alert automations' mile-range thresholds, which live only in
 * the automation config, not in any entity state.
 *
 * Two modes, matching what HA's REST API actually exposes:
 *   - no `automation_id` → LIST mode. `/api/config/automation/config` has no
 *     list endpoint, so listing reads `/api/states` scoped to the
 *     `automation.` domain — each row carries the config-registry `id` in
 *     its attributes. That id (NOT the entity_id) keys the config fetch.
 *   - `automation_id` → `/api/config/automation/config/<id>` — the raw
 *     stored config object.
 *
 * Gated on `ha_automation_read` (config/capabilities.yaml), deliberately
 * NOT `read_home_assistant`: Kate lost broad HA reads on 2026-06-07 by
 * design, and automation configs are a much narrower surface than
 * whole-house entity state.
 */
import { z } from 'zod';
import { createHash } from 'node:crypto';
import type { Tool, ToolContext } from '@core/tool';
import { safe_fetch } from './_audit';
import { require_caller_tier } from '@core/tool_gates';

const HA_BASE_URL = process.env.HA_BASE_URL ?? 'http://homeassistant.local:8123';
const HA_TOKEN = process.env.HA_TOKEN ?? '';

function ha_headers(): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${HA_TOKEN}`,
  };
}

const GetAutomationInput = z.object({
  /** The automation's CONFIG id — the `id` attribute list mode returns —
   *  not the `automation.foo` entity_id. Omit to list all automations. */
  automation_id: z.string().min(1).optional(),
});

const AutomationListItem = z.object({
  /** Config-registry id — pass this back as `automation_id` to read the config. */
  automation_id: z.string().nullable(),
  entity_id: z.string(),
  alias: z.string().nullable(),
  state: z.string().nullable(),
});

const GetAutomationOutput = z.object({
  /** Single mode: the raw stored config (trigger/condition/action…). */
  automation_id: z.string().nullable(),
  config: z.record(z.string(), z.unknown()).nullable(),
  /** List mode: every automation entity with its config id. */
  automations: z.array(AutomationListItem).optional(),
  error: z.string().optional(),
});

export const ha_get_automation: Tool<
  z.infer<typeof GetAutomationInput>,
  z.infer<typeof GetAutomationOutput>
> = {
  name: 'ha_get_automation',
  description:
    'Read Home Assistant AUTOMATION configs — the trigger/condition/action definitions (e.g. lightning-alert mile-range thresholds) that entity state never shows. Call with no arguments to LIST all automations (returns each one\'s `automation_id`); then call again with that `automation_id` to get the raw stored config. The id is the config-registry id from the list, not the "automation.foo" entity_id.',
  risk: 'read',
  required_capabilities: ['ha_automation_read'],
  input_schema: GetAutomationInput,
  output_schema: GetAutomationOutput,

  idempotency_key(input) {
    return `ha_get_automation:${createHash('sha256')
      .update(input.automation_id ?? '*')
      .digest('hex')
      .slice(0, 16)}`;
  },

  async execute(input, ctx: ToolContext) {
    // Same tier policy as the other HA readers: automation configs can
    // reference owner-specific entities and locations.
    require_caller_tier(ctx, ['owner', 'household']);

    if (!HA_TOKEN) {
      return { automation_id: input.automation_id ?? null, config: null, error: 'HA_TOKEN not configured' };
    }
    const base = HA_BASE_URL.replace(/\/$/, '');

    if (input.automation_id) {
      const url = `${base}/api/config/automation/config/${encodeURIComponent(input.automation_id)}`;
      const res = await safe_fetch(url, { headers: ha_headers() });
      if (!res.ok) {
        return {
          automation_id: input.automation_id,
          config: null,
          error:
            res.status === 404
              ? `no automation config with id "${input.automation_id}" — call ha_get_automation with no arguments to list valid automation_ids`
              : (res.error ?? `HA HTTP ${res.status}: ${res.body.slice(0, 200)}`),
        };
      }
      try {
        return {
          automation_id: input.automation_id,
          config: JSON.parse(res.body) as Record<string, unknown>,
        };
      } catch (err) {
        return {
          automation_id: input.automation_id,
          config: null,
          error: `Failed to parse HA response: ${(err as Error).message}`,
        };
      }
    }

    // List mode — automation entities from /api/states; the config id rides
    // in attributes.id.
    const res = await safe_fetch(`${base}/api/states`, { headers: ha_headers() });
    if (!res.ok) {
      return {
        automation_id: null,
        config: null,
        error: res.error ?? `HA HTTP ${res.status}: ${res.body.slice(0, 200)}`,
      };
    }
    try {
      const arr = JSON.parse(res.body) as Array<{
        entity_id: string;
        state?: string;
        attributes?: { id?: string; friendly_name?: string };
      }>;
      const automations = arr
        .filter((e) => e.entity_id.startsWith('automation.'))
        .map((e) => ({
          automation_id: e.attributes?.id ?? null,
          entity_id: e.entity_id,
          alias: e.attributes?.friendly_name ?? null,
          state: e.state ?? null,
        }));
      return { automation_id: null, config: null, automations };
    } catch (err) {
      return {
        automation_id: null,
        config: null,
        error: `Failed to parse HA response: ${(err as Error).message}`,
      };
    }
  },
};
