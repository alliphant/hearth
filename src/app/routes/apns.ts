/**
 * APNs HTTP routes (iOS push direct from Hearth).
 *
 *   POST /api/apns/register                  iOS calls on cold launch + after auth
 *   POST /api/apns/unregister                iOS calls on sign-out
 *   POST /api/apns/test-push                 auth-gated canned push for verification
 *   POST /api/apns/live-activity/register    iOS calls when ActivityKit hands it
 *                                              a per-activity push token
 *
 * All routes require an authenticated session (handled by the auth
 * middleware mounted ahead of /api/*).
 *
 * See [src/policy/apns.ts](../../policy/apns.ts) for the JWT signer +
 * HTTP/2 client and per-token send pipeline.
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { ulid } from 'ulid';
import type { MemoryClient } from '@memory/client';
import {
  ApnsTokenStore,
  apns_configured,
  build_alert_payload,
  send_apns,
  audit_apns,
  type ApnsEnvironment,
} from '@policy/apns';

export interface ApnsRouterDeps {
  memory: MemoryClient;
  apns_tokens: ApnsTokenStore;
}

const RegisterSchema = z.object({
  deviceToken: z.string().regex(/^[0-9a-f]{16,256}$/i, 'expected hex device token'),
  environment: z.enum(['sandbox', 'production']),
  appBuild: z.string().min(1).max(32),
});

const UnregisterSchema = z.object({
  deviceToken: z.string().min(1).max(512),
});

const LiveActivityRegisterSchema = z.object({
  /** The device push token (already-registered) this activity belongs to. */
  deviceToken: z.string().regex(/^[0-9a-f]{16,256}$/i, 'expected hex device token'),
  environment: z.enum(['sandbox', 'production']),
  /** Identifier of the in-app Activity (matches Activity.id on iOS). */
  activityId: z.string().min(1).max(120).nullable(),
  /** ActivityKit push-update token (hex). Pass null to clear. */
  liveActivityPushToken: z
    .string()
    .regex(/^[0-9a-f]{16,512}$/i, 'expected hex push token')
    .nullable(),
});

const TestPushSchema = z.object({
  title: z.string().max(120).optional(),
  body: z.string().min(1).max(800),
  category: z.string().max(40).optional(),
  /** Optional override of the default APNS_TOPIC for diagnostics. */
  topic: z.string().max(120).optional(),
});

export function create_apns_router(deps: ApnsRouterDeps): Hono {
  const r = new Hono({ strict: false });

  // ── Register / refresh ─────────────────────────────────────────────────
  r.post('/register', async (c) => {
    const caller = c.get('user');
    if (!caller) return c.json({ error: 'authentication required' }, 401);
    let body: unknown;
    try {
      body = await c.req.json();
    } catch (err) {
      return c.json({ error: `invalid JSON: ${(err as Error).message}` }, 400);
    }
    const parsed = RegisterSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);

    deps.apns_tokens.upsert({
      user_id: caller.id,
      device_token: parsed.data.deviceToken.toLowerCase(),
      environment: parsed.data.environment as ApnsEnvironment,
      bundle_id: process.env.APNS_TOPIC ?? 'com.hearthcrew.app',
      app_build: parsed.data.appBuild,
    });
    const intent_id = ulid();
    deps.memory.log_action({
      intent_id,
      agent: 'orchestrator',
      tool_name: 'apns_register',
      tool_input: {
        environment: parsed.data.environment,
        app_build: parsed.data.appBuild,
        // Redact: store only the last 6 chars so the audit trail is
        // useful for forensics but doesn't expose the full token.
        token_tail: parsed.data.deviceToken.slice(-6),
      },
      execution_result: { ok: true },
      user_id: caller.id,
    });
    return c.json({
      ok: true,
      configured: apns_configured(),
      intent_id,
    });
  });

  // ── Unregister (sign-out) ──────────────────────────────────────────────
  r.post('/unregister', async (c) => {
    const caller = c.get('user');
    if (!caller) return c.json({ error: 'authentication required' }, 401);
    let body: unknown;
    try {
      body = await c.req.json();
    } catch (err) {
      return c.json({ error: `invalid JSON: ${(err as Error).message}` }, 400);
    }
    const parsed = UnregisterSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);

    deps.apns_tokens.unregister(caller.id, parsed.data.deviceToken.toLowerCase());
    deps.memory.log_action({
      intent_id: ulid(),
      agent: 'orchestrator',
      tool_name: 'apns_unregister',
      tool_input: { token_tail: parsed.data.deviceToken.slice(-6) },
      execution_result: { ok: true },
      user_id: caller.id,
    });
    return c.json({ ok: true });
  });

  // ── Live Activity push-token register ──────────────────────────────────
  r.post('/live-activity/register', async (c) => {
    const caller = c.get('user');
    if (!caller) return c.json({ error: 'authentication required' }, 401);
    let body: unknown;
    try {
      body = await c.req.json();
    } catch (err) {
      return c.json({ error: `invalid JSON: ${(err as Error).message}` }, 400);
    }
    const parsed = LiveActivityRegisterSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);

    deps.apns_tokens.set_live_activity_token({
      user_id: caller.id,
      device_token: parsed.data.deviceToken.toLowerCase(),
      environment: parsed.data.environment as ApnsEnvironment,
      live_activity_id: parsed.data.activityId,
      live_activity_push_token: parsed.data.liveActivityPushToken?.toLowerCase() ?? null,
    });
    deps.memory.log_action({
      intent_id: ulid(),
      agent: 'orchestrator',
      tool_name: 'apns_la_register',
      tool_input: {
        environment: parsed.data.environment,
        activity_id: parsed.data.activityId,
        la_token_tail: parsed.data.liveActivityPushToken?.slice(-6) ?? null,
      },
      execution_result: { ok: true },
      user_id: caller.id,
    });
    return c.json({ ok: true });
  });

  // ── Test push (auth-gated diagnostic) ──────────────────────────────────
  // Fires a canned alert to every APNs token registered for the caller.
  // The body is intentionally NOT logged — just the category + outcome.
  r.post('/test-push', async (c) => {
    const caller = c.get('user');
    if (!caller) return c.json({ error: 'authentication required' }, 401);
    if (!apns_configured()) {
      return c.json(
        {
          error:
            'APNs not configured. Set APNS_KEY_PATH, APNS_KEY_ID, APNS_TEAM_ID in .env.',
        },
        503,
      );
    }
    let body: unknown;
    try {
      body = await c.req.json();
    } catch (err) {
      return c.json({ error: `invalid JSON: ${(err as Error).message}` }, 400);
    }
    const parsed = TestPushSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);

    const payload = build_alert_payload({
      title: parsed.data.title ?? 'Hearth',
      body: parsed.data.body,
      category: parsed.data.category,
      hearth_route: { kind: 'today' },
    });
    const { attempts, delivered } = await send_apns({
      store: deps.apns_tokens,
      user_id: caller.id,
      topic: parsed.data.topic,
      push_type: 'alert',
      payload,
    });
    const audit_id = audit_apns(deps.memory, {
      user_id: caller.id,
      category: parsed.data.category ?? null,
      push_type: 'alert',
      attempts,
      reason: 'test_push',
    });
    return c.json({
      ok: true,
      delivered,
      audit_id,
      // Per-token outcomes with redacted tokens — same shape the audit row uses.
      attempts: attempts.map((a) => ({
        token_tail: a.device_token.slice(-6),
        environment: a.environment,
        status: a.status,
        reason: a.reason,
        ok: a.ok,
        purged: a.purged,
      })),
    });
  });

  return r;
}
