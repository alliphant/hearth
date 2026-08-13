/**
 * /api/users/* and /app/api/transcribe — small endpoints the /app web UI
 * depends on. (The Hermes-on-mint Telegram thin client these were
 * originally built for was retired 2026-06-14; the inbound /api/relay/message
 * route, the push-receiver status proxy, and the Telegram test-push were
 * removed with it. What remains is consumed by the web client.)
 *
 * /api/users/:id/active_specialist  read/write the user's active
 *                                   specialist preference.
 *
 * /api/users/specialist_aliases     return the slash-command alias map
 *                                   (built from config/specialists/*.yaml).
 *                                   Used by the web composer's @/ autocomplete.
 *
 * /api/users/quiet                  toggle/check quiet hours.
 *
 * /api/users/onboarding/status      onboarding state — owner sees the whole
 *                                   roster's flags, a non-owner only their own.
 * /api/users/onboarding/reset       re-open Kate-led onboarding for a user
 *                                   (self, or any user for the owner). Clears
 *                                   the onboarded flag so the playbook injects
 *                                   again; facets preserved unless clear_facets.
 *
 * /app/api/transcribe               forwards an audio blob to the speaches
 *                                   whisper STT and returns { transcript }.
 *
 * These routes assume v0 single-user — the first user in users.yaml is
 * treated as the default.
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
import { z } from 'zod';
import { ulid } from 'ulid';
import type { Database } from 'bun:sqlite';
import type { SpecialistRegistry } from '@core/specialist';
import type { SpecialistRuntime } from '@core/specialist_runtime';
import type {
  ConversationStore,
} from '@memory/stores/conversations';
import type { MemoryClient } from '@memory/client';
import type { AppEventBus } from '../events';
import { to_turn_user } from '@core/users';
import { UserRegistry, KvSettings } from '@core/users';
import { parse_quiet_arg, type ManualQuietState } from '@policy/quiet_hours';

// speaches whisper STT (OpenAI-compatible). Defaults match the deployed
// parakeet container; see ops/voice/prewarm.sh.
const SPEACHES_URL = process.env.SPEACHES_URL ?? 'http://localhost:8093';
const STT_MODEL =
  process.env.STT_MODEL ?? 'deepdml/faster-whisper-large-v3-turbo-ct2';

export interface RelayRoutesDeps {
  db: Database;
  memory: MemoryClient;
  specialists: SpecialistRegistry;
  runtime: SpecialistRuntime;
  conversations: ConversationStore;
  users: UserRegistry;
  kv: KvSettings;
  events?: AppEventBus;
}

async function read_json(c: Context): Promise<unknown | null> {
  try {
    return await c.req.json();
  } catch {
    return null;
  }
}

/**
 * Build a { alias: specialist_id } map from the loaded specialists. Each
 * specialist's id is registered, plus any aliases declared in their YAML
 * (via the `aliases` field — optional, see config/specialists/*.yaml).
 */
export function build_alias_map(specialists: SpecialistRegistry): Record<string, string> {
  const map: Record<string, string> = {};
  // subagent_only profiles are Kate's delegable staff, not chat targets —
  // keep them out of the composer's @/slash autocomplete.
  for (const s of specialists.list().filter((s) => !s.subagent_only)) {
    map[s.id.toLowerCase()] = s.id;
    for (const a of s.aliases ?? []) {
      map[a.toLowerCase()] = s.id;
    }
  }
  return map;
}

export function create_relay_router(deps: RelayRoutesDeps): Hono {
  const r = new Hono();

  // ── Specialist alias map ──────────────────────────────────────────

  r.get('/users/specialist_aliases', (c) => {
    return c.json({ map: build_alias_map(deps.specialists) });
  });

  // ── Active specialist read/write ──────────────────────────────────

  r.get('/users/:id/active_specialist', (c) => {
    const id = c.req.param('id');
    const user = deps.users.get(id);
    if (!user) return c.json({ error: `unknown user: ${id}` }, 404);
    return c.json({
      user_id: id,
      specialist_id: deps.users.get_active_specialist(id),
    });
  });

  const ActiveSchema = z.object({ specialist_id: z.string() });

  r.post('/users/:id/active_specialist', async (c) => {
    const id = c.req.param('id');
    const user = deps.users.get(id);
    if (!user) return c.json({ error: `unknown user: ${id}` }, 404);
    const body = await read_json(c);
    const parsed = ActiveSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);

    const sid = parsed.data.specialist_id;
    if (!deps.specialists.has(sid)) {
      return c.json({ error: `unknown specialist: ${sid}` }, 400);
    }
    if (!deps.users.is_specialist_allowed(user, sid)) {
      return c.json({ error: `specialist ${sid} not allowed for this user` }, 403);
    }
    deps.users.set_active_specialist(id, sid);
    deps.events?.emit({
      type: 'active_specialist_changed',
      user_id: id,
      specialist_id: sid,
    });

    // Produce a small greeting via a single specialist turn so the
    // confirmation sounds in voice. HEARTH_TEST_MODE short-circuits.
    let greeting: string;
    if (process.env.HEARTH_TEST_MODE === '1') {
      const spec = deps.specialists.get(sid)!;
      greeting = `Hi, it's ${spec.name}. What's on your mind?`;
    } else {
      try {
        const out = await deps.runtime.turn({
          specialist_id: sid,
          conversation_id: 'switch-greeting',
          message: {
            role: 'user',
            content:
              `(System: the user just switched their active context to you. ` +
              `Greet them briefly in your voice and ask what they need. ` +
              `One or two sentences.)`,
          },
          conversation_history: [],
          // Phase 2b — switch-greeting runs as the user doing the switch.
          user: to_turn_user(user, c.get('user_tz')),
        });
        greeting = out.message_text;
      } catch {
        const spec = deps.specialists.get(sid)!;
        greeting = `Hi, it's ${spec.name}.`;
      }
    }
    return c.json({ user_id: id, specialist_id: sid, greeting });
  });

  // ── Quiet hours ───────────────────────────────────────────────────

  const QuietSchema = z.object({
    user_id: z.string(),
    arg: z.string().default(''),
  });

  r.post('/users/quiet', async (c) => {
    const body = await read_json(c);
    const parsed = QuietSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    const user = deps.users.get(parsed.data.user_id);
    if (!user) return c.json({ error: `unknown user: ${parsed.data.user_id}` }, 404);

    const arg = parsed.data.arg.trim();

    if (arg === 'status' || arg === '?') {
      const state = deps.kv.get<ManualQuietState>(
        `manual_quiet_mode:${user.id}`,
      );
      const cfg = deps.users.get_notification_config(user.id);
      return c.json({
        manual: state,
        configured: cfg?.quiet_hours ?? null,
        message: state
          ? state.mode === 'on'
            ? 'Quiet mode is ON until you say /quiet off.'
            : `Quiet mode is ON until ${state.ts}.`
          : `Quiet hours: ${cfg?.quiet_hours.start ?? '?'} → ${cfg?.quiet_hours.end ?? '?'} (${cfg?.quiet_hours.timezone ?? '?'}).`,
      });
    }

    const next = parse_quiet_arg(arg, new Date(), user.timezone);
    if (next === null && arg !== 'off' && arg !== '') {
      return c.json({ error: `couldn't parse quiet arg: ${arg}` }, 400);
    }
    if (next === null) {
      deps.kv.delete(`manual_quiet_mode:${user.id}`);
      return c.json({ manual: null, message: 'Quiet mode cleared.' });
    }
    deps.kv.set(`manual_quiet_mode:${user.id}`, next);
    return c.json({
      manual: next,
      message:
        next.mode === 'on'
          ? 'Quiet mode ON until you say /quiet off.'
          : `Quiet mode ON until ${next.ts}.`,
    });
  });

  // ── Onboarding status + reset (2026-06-15) ─────────────────────────
  // The Kate-led onboarding playbook self-injects while a user is not
  // onboarded (Kate is default_landing). These let the owner (re)trigger it
  // for household members who never went through it, and let anyone redo
  // their own. Status: the OWNER sees the whole roster's onboarding flags (a
  // UX boolean, not personal data — useful to see who's still pending); a
  // non-owner sees only their own.

  r.get('/users/onboarding/status', (c) => {
    const caller = c.get('user') as { id: string; tier?: string } | undefined;
    if (!caller) return c.json({ error: 'unauthenticated' }, 401);
    const store = deps.memory.user_profiles;
    if (caller.tier === 'owner') {
      const roster = deps.users.list().map((u) => ({
        user_id: u.id,
        display_name: u.display_name,
        tier: u.tier,
        onboarded: store.is_onboarded(u.id),
      }));
      return c.json({ caller: caller.id, roster });
    }
    return c.json({
      caller: caller.id,
      roster: [{ user_id: caller.id, onboarded: store.is_onboarded(caller.id) }],
    });
  });

  const ResetSchema = z.object({
    user_id: z.string().optional(),
    clear_facets: z.boolean().optional(),
  });

  r.post('/users/onboarding/reset', async (c) => {
    const caller = c.get('user') as { id: string; tier?: string } | undefined;
    if (!caller) return c.json({ error: 'unauthenticated' }, 401);
    const parsed = ResetSchema.safeParse((await read_json(c)) ?? {});
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);

    const target = parsed.data.user_id ?? caller.id;
    // A user may reset their OWN onboarding; only the owner may reset another
    // user's (re-triggering their setup flow — it writes only a UX flag, never
    // reads their data, so it stays outside the personal-data cordon).
    if (target !== caller.id && caller.tier !== 'owner') {
      return c.json({ error: 'only the owner may reset another user’s onboarding' }, 403);
    }
    if (!deps.users.get(target)) {
      return c.json({ error: `unknown user: ${target}` }, 404);
    }

    const was_onboarded = deps.memory.user_profiles.reset_onboarding(target, {
      clear_facets: parsed.data.clear_facets ?? false,
    });
    deps.memory.log_action({
      intent_id: ulid(),
      agent: 'orchestrator',
      tool_name: 'onboarding_reset',
      tool_input: {
        target_user: target,
        by: caller.id,
        clear_facets: Boolean(parsed.data.clear_facets),
        was_onboarded,
      },
      execution_result: { onboarded: false },
      user_id: target,
    });
    return c.json({
      user_id: target,
      onboarded: false,
      was_onboarded,
      message: `Onboarding reset — ${target} will be welcomed through setup again on their next chat with Kate.`,
    });
  });

  return r;
}

// ── /app/api/transcribe ──────────────────────────────────────────────────

export function create_app_extras_router(): Hono {
  const r = new Hono();

  r.post('/transcribe', async (c) => {
    let form: FormData;
    try {
      form = await c.req.formData();
    } catch (err) {
      return c.json({ error: `multipart parse: ${(err as Error).message}` }, 400);
    }
    const file = form.get('file');
    if (!(file instanceof File)) {
      return c.json({ error: 'file field required' }, 400);
    }
    // Forward to the speaches whisper STT (OpenAI-compatible
    // /v1/audio/transcriptions) and adapt the `{ text }` response to the
    // `{ transcript }` shape the web composer expects.
    const forward = new FormData();
    forward.append('file', file, file.name || 'audio.webm');
    forward.append('model', STT_MODEL);
    const lang = form.get('language');
    if (typeof lang === 'string') forward.append('language', lang);

    try {
      const resp = await fetch(
        `${SPEACHES_URL.replace(/\/$/, '')}/v1/audio/transcriptions`,
        {
          method: 'POST',
          body: forward,
          signal: AbortSignal.timeout(120_000),
        },
      );
      if (!resp.ok) {
        return c.json({ error: `stt ${resp.status}: ${await resp.text()}` }, 502);
      }
      const j = (await resp.json().catch(() => ({}))) as {
        text?: string;
        transcript?: string;
      };
      return c.json({ transcript: j.transcript ?? j.text ?? '' });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 502);
    }
  });

  return r;
}
