/**
 * connector_affordances — the ONE definition of "does this tool's
 * output_schema carry a structured recovery hint?"
 *
 * Two consumers, which MUST agree:
 *
 *   - Mariah's `audit_connector_affordances` — flags connectors whose
 *     output_schema can return `error` but offers the model nothing
 *     actionable (the fabrication trigger behind the Iris 2026-05-25
 *     EV incident).
 *
 *   - Beatrice's `propose_connector_recovery_hint` — REFUSES to file a
 *     proposal for a tool that already carries a recovery field. The
 *     instruction-only guard ("check the audit first") demonstrably
 *     failed: on 2026-06-09 a pending recommendation proposed adding
 *     `candidates` to `web_fetch_clean`, which has had `candidates`
 *     since 2026-05-25. Redundancy is a mechanical fact about the
 *     schema; the check belongs in code, not in the persona.
 *
 * Keeping the patterns + the key extraction here means a connector
 * enriched with a new recovery shape is recognized by both sides in
 * the same reload.
 */
import type { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

/**
 * Property keys that count as a recovery hint on a tool's output
 * schema. Exact match or prefix match (when entry ends in `_`). Add
 * to this list when a connector grows a new structured-recovery
 * shape — the patterns the scan looks for should match what the
 * fixes Beatrice ships actually produce.
 */
export const RECOVERY_HINT_PATTERNS: readonly string[] = [
  'candidates',
  'suggestions',
  'suggestion',
  'alternatives',
  'alternative',
  'recovery',
  'recovery_',       // recovery_action, recovery_hint, ...
  'available_',      // available_entities, available_models, ...
  'retry_with',
  'next_action',
  'next_actions',
  'hint',
  'hints',
  'matches',         // search-style "here's what looked close"
  'closest_matches',
];

export function is_recovery_hint(key: string): boolean {
  const k = key.toLowerCase();
  for (const pat of RECOVERY_HINT_PATTERNS) {
    if (pat.endsWith('_')) {
      if (k.startsWith(pat)) return true;
    } else if (k === pat) {
      return true;
    }
  }
  return false;
}

/**
 * Pull the top-level property keys of a Zod output schema via
 * zodToJsonSchema — robust across zod minor versions, doesn't
 * require touching `_def` directly. Returns [] when the schema isn't
 * an object shape (rare for tools — most return objects).
 */
export function output_keys(schema: z.ZodType): string[] {
  try {
    const json = zodToJsonSchema(schema, { $refStrategy: 'none' }) as {
      type?: string;
      properties?: Record<string, unknown>;
    };
    if (json.type !== 'object' || !json.properties) return [];
    return Object.keys(json.properties);
  } catch {
    return [];
  }
}

/** The recovery-hint keys already present on a tool's output schema. */
export function existing_recovery_fields(schema: z.ZodType): string[] {
  return output_keys(schema).filter(is_recovery_hint);
}
