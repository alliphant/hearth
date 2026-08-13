/**
 * Shared helper: every connector tool audits its invocation. The calling
 * specialist id is passed in via ToolContext (set by SpecialistRuntime
 * before invocation); for fallback we record 'specialist' generically.
 */

import { ulid } from 'ulid';
import type { MemoryClient } from '@memory/client';

export interface ConnectorAuditCtx {
  memory: MemoryClient;
  agent: string;
  intent_id: string;
}

export function audit_connector(
  ctx: ConnectorAuditCtx,
  tool_name: string,
  input: unknown,
  result: unknown,
  error?: string,
): string {
  return ctx.memory.log_action({
    intent_id: ctx.intent_id || ulid(),
    agent: ctx.agent,
    tool_name,
    tool_input: input,
    execution_result: error ? undefined : result,
    error,
  });
}

const SECRET_KEYS = new Set([
  'token',
  'api_key',
  'apikey',
  'password',
  'secret',
  'authorization',
  'bearer',
  'cookie',
]);

/** Strip likely-secret keys from an object before audit. */
export function redact(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(redact);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (SECRET_KEYS.has(k.toLowerCase())) {
      out[k] = '[redacted]';
    } else {
      out[k] = redact(v);
    }
  }
  return out;
}

/**
 * Wrap fetch with a sensible timeout and structured error handling. Connectors
 * use this for every outbound call so a hung remote doesn't pin a turn.
 */
export async function safe_fetch(
  url: string,
  init: RequestInit = {},
  timeout_ms = 15_000,
): Promise<{ ok: boolean; status: number; body: string; error?: string }> {
  try {
    const res = await fetch(url, {
      ...init,
      signal: AbortSignal.timeout(timeout_ms),
    });
    const body = await res.text();
    return { ok: res.ok, status: res.status, body };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      body: '',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
