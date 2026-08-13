/**
 * /api/admin/* — household administration surface.
 *
 *   GET   /api/admin/users            list all users (admin-gated)
 *   PATCH /api/admin/users/:id        update allowed_specialists, pin_hash, tier, email
 *
 * Phase 2b — these routes power the Settings → Admin → Users panel.
 * Admin-gated by `c.get('user').role === 'admin'`. A non-admin caller
 * gets 403 (not 404 — the routes exist and the caller knows the surface
 * is here; we just refuse to surface or modify other users' data).
 *
 * The PATCH route is the right mechanism to re-enable Sam: pass
 * `{ pin_hash: '<sha256-of-pin>' }` and the YAML write-back fires.
 * Chokidar would also pick up direct YAML edits — this is the in-app
 * UI alternative, not a replacement for editing the file by hand.
 */
import { Hono } from 'hono';
import type { Context } from 'hono';
import { z } from 'zod';
import type { UserRegistry, Tier } from '@core/users';

export interface AdminRoutesDeps {
  users: UserRegistry;
}

/**
 * 403 the request if the caller isn't an admin. Returns the response
 * object on block, or null to continue.
 */
function _gate(c: Context): Response | null {
  const u = c.get('user');
  if (!u || u.role !== 'admin') {
    return c.json(
      { error: 'admin role required', current_role: u?.role ?? null },
      403,
    );
  }
  return null;
}

const UpdateUserSchema = z
  .object({
    allowed_specialists: z
      .union([z.literal('*'), z.array(z.string().min(1))])
      .optional(),
    // Empty string clears the PIN (disable login); 64-char hex sets a new
    // hash. The UI never sees the existing hash — read returns has_pin
    // boolean only.
    pin_hash: z
      .union([z.literal(''), z.string().regex(/^[a-f0-9]{64}$/)])
      .optional(),
    tier: z.enum(['owner', 'household', 'friend']).optional(),
    // Empty string clears the email (back to null / no login email); a
    // valid address sets it. The core update_user lowercases on write.
    email: z
      .union([z.literal(''), z.string().email().max(320)])
      .optional(),
  })
  .strict()
  .refine(
    (v) =>
      v.allowed_specialists !== undefined ||
      v.pin_hash !== undefined ||
      v.tier !== undefined ||
      v.email !== undefined,
    { message: 'at least one field is required' },
  );

const CreateUserSchema = z
  .object({
    id: z
      .string()
      .regex(/^[a-z][a-z0-9_]{0,63}$/,
        'id must be lowercase snake_case starting with a letter (max 64 chars)'),
    display_name: z.string().min(1).max(80),
    email: z.string().email().max(320),
    initial_password: z
      .string()
      .min(10, 'initial_password must be at least 10 characters')
      .max(1024),
    tier: z.enum(['owner', 'household', 'friend']).default('household'),
    allowed_specialists: z
      .union([z.literal('*'), z.array(z.string().min(1))])
      .default('*'),
    telegram_user_id: z.string().nullable().default(null),
    notification_config_ref: z.string().min(1).default('default'),
    timezone: z.string().min(1).default('America/Denver'),
    role: z.enum(['admin', 'user', 'guest']).default('user'),
    require_pin: z.boolean().default(true),
    theme: z.string().nullable().default(null),
  })
  .strict();

export function create_admin_router(deps: AdminRoutesDeps): Hono {
  const r = new Hono();

  r.get('/admin/users', (c) => {
    const blocked = _gate(c);
    if (blocked) return blocked;
    return c.json({ users: deps.users.list_for_admin() });
  });

  // ── POST /admin/users — create a new user with bootstrap flags ──────
  // Admin supplies id + display_name + email + initial_password (and
  // optional tier / role / allowed_specialists). Server hashes the
  // password, sets must_change_password + must_set_pin = true so the
  // user's first login routes through the change-password + set-pin
  // flow. The endpoint itself doesn't return the password back — admin
  // gave it; they communicate it to the user out-of-band.
  r.post('/admin/users', async (c) => {
    const blocked = _gate(c);
    if (blocked) return blocked;

    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch (err) {
      return c.json({ error: `invalid JSON: ${(err as Error).message}` }, 400);
    }
    const parsed = CreateUserSchema.safeParse(raw);
    if (!parsed.success) {
      return c.json({ error: parsed.error.message }, 400);
    }

    try {
      const created = await deps.users.create_user(parsed.data);
      return c.json(
        {
          ok: true,
          user: {
            id: created.id,
            display_name: created.display_name,
            email: created.email,
            has_pin: false,
            must_change_password: created.must_change_password,
            must_set_pin: created.must_set_pin,
            role: created.role,
            tier: created.tier,
            allowed_specialists: created.allowed_specialists,
          },
        },
        201,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Duplicate id / duplicate email / bad password → 409 (conflict).
      const status =
        msg.includes('already exists') || msg.includes('already belongs')
          ? 409
          : 400;
      return c.json({ error: msg }, status);
    }
  });

  r.patch('/admin/users/:id', async (c) => {
    const blocked = _gate(c);
    if (blocked) return blocked;
    const id = c.req.param('id');

    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch (err) {
      return c.json({ error: `invalid JSON: ${(err as Error).message}` }, 400);
    }
    const parsed = UpdateUserSchema.safeParse(raw);
    if (!parsed.success) {
      return c.json({ error: parsed.error.message }, 400);
    }

    // Guardrail: prevent the calling admin from locking themselves out
    // in a single PATCH. Clearing pin_hash for the calling user would
    // leave no admin able to sign in once they log out.
    const caller = c.get('user');
    if (parsed.data.pin_hash === '' && caller.id === id) {
      return c.json(
        {
          error:
            'refusing to clear your own pin_hash — pin yourself out and you ' +
            'cannot sign back in to re-enable. Have another admin do this, ' +
            'or edit users.yaml directly.',
        },
        409,
      );
    }
    // Same guardrail for downgrading own tier away from owner.
    if (parsed.data.tier && parsed.data.tier !== 'owner' && caller.id === id && caller.tier === 'owner') {
      return c.json(
        { error: "refusing to downgrade your own tier from 'owner'" },
        409,
      );
    }

    try {
      const patch: {
        allowed_specialists?: '*' | string[];
        pin_hash?: string;
        tier?: Tier;
        email?: string | null;
      } = {
        allowed_specialists: parsed.data.allowed_specialists,
        pin_hash: parsed.data.pin_hash,
        tier: parsed.data.tier,
      };
      // Empty string is the "clear it" sentinel → null; a real address
      // passes through (core update_user lowercases on write).
      if (parsed.data.email !== undefined) {
        patch.email = parsed.data.email === '' ? null : parsed.data.email;
      }
      const updated = deps.users.update_user(id, patch);
      return c.json({
        ok: true,
        user: {
          id: updated.id,
          display_name: updated.display_name,
          email: updated.email,
          has_pin: !!updated.pin_hash,
          role: updated.role,
          tier: updated.tier,
          allowed_specialists: updated.allowed_specialists,
          telegram_user_id: updated.telegram_user_id,
        },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // unknown user → 404; everything else → 400
      const status = msg.startsWith('unknown user') ? 404 : 400;
      return c.json({ error: msg }, status);
    }
  });

  return r;
}
