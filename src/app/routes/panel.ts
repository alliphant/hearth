/**
 * Guest panel — `/app/panel/`.
 *
 * Hand a guest a phone and they get the handful of things worth doing in the
 * room they're standing in, plus the house facts a guest actually asks for.
 * Owns both its page and its API, the same shape as create_hvac_router.
 *
 * ⚠ THIS SURFACE IS UNAUTHENTICATED, AND THEREFORE LAN-ONLY.
 * A guest has no Hearth account, so requiring a login defeats the premise.
 * The trade is that every route here is gated on `require_lan` below — /app/ is
 * also served on the PUBLIC your-llm-host.your-tailnet.ts.net endpoint, and without
 * that gate anyone who learned the URL could turn on the lights from the
 * internet. Do not add a route to this router outside that gate.
 */
import { Hono, type Context } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { serve_static } from '../static';
import {
  fetch_ha_camera_snapshot,
  ha_call_service,
  type HAEntityState,
} from '@connectors/home_assistant';
import { stt_healthy, transcribe_audio } from '@connectors/stt';
import type { SpecialistRuntime } from '@core/specialist_runtime';
import {
  actuable_entities,
  compose_pane,
  get_snapshot,
  phase_now,
  room_list,
  suggest_room,
  type Phase,
} from '@core/panel/compose';
import { ask_kate } from '@core/panel/guest_turn';
import { DOORBELL } from '@core/panel/rooms';

export interface PanelRouterDeps {
  client_dir: string;
  canonical_path?: string;
  /** Present ⇒ the Kate button is live. Absent ⇒ it says so instead. */
  runtime?: SpecialistRuntime;
  /** Household timezone for the guest caller Kate sees. */
  timezone?: string;
}

const PHASES = new Set<Phase>(['morning', 'afternoon', 'evening', 'night']);

/** Scoped to the panel's own path, so it never rides along with /app requests. */
const GUEST_SESSION_COOKIE = 'hearth_panel_guest';

/**
 * Is this request from a device physically on the house LAN?
 *
 * nginx sets X-Real-IP to the real peer for both the LAN and the Tailscale
 * server blocks, so the peer address is the honest discriminator:
 *   - 192.168/10/172.16-31 + loopback → in the house
 *   - 100.64/10 → Tailscale CGNAT, i.e. someone off-site. REJECTED, even
 *     though it looks private-ish. This is the case the gate exists for.
 * The header is trusted only because nothing but nginx can reach :7700.
 */
function is_lan_address(ip: string): boolean {
  const v = ip.trim().replace(/^::ffff:/, '');
  if (v === '127.0.0.1' || v === '::1') return true;

  const m = v.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];

  // Tailscale CGNAT — private-looking, but not in the house.
  if (a === 100 && b >= 64 && b <= 127) return false;

  if (a === 10) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  return false;
}

function client_ip(c: Context): string {
  const real = c.req.header('x-real-ip');
  if (real) return real;
  // First hop of X-Forwarded-For is the original client.
  const fwd = c.req.header('x-forwarded-for');
  if (fwd) return fwd.split(',')[0] ?? '';
  return '';
}

function phase_param(c: Context): Phase {
  const p = c.req.query('phase') as Phase | undefined;
  return p && PHASES.has(p) ? p : phase_now();
}

// ── house facts ───────────────────────────────────────────────────────────
// FRIDAY's guest-facing house file: wi-fi, trash day, shutoffs, contacts, how
// to watch TV. Served by HA out of its www dir.

let house_cache: { at: number; data: Record<string, any> } | null = null;

async function house_facts(): Promise<Record<string, unknown> | null> {
  if (house_cache && Date.now() - house_cache.at < 60_000) return shape_house(house_cache.data);
  const base = (process.env.HA_BASE_URL ?? '').replace(/\/$/, '');
  if (!base) return null;
  try {
    const res = await fetch(`${base}/local/friday_intel/house_data.json`, {
      headers: { Authorization: `Bearer ${process.env.HA_TOKEN ?? ''}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    house_cache = { at: Date.now(), data: (await res.json()) as Record<string, any> };
    return shape_house(house_cache.data);
  } catch {
    return null;
  }
}

function shape_house(h: Record<string, any>): Record<string, unknown> {
  const guest_ssid = String(h?.wifi?.guest?.ssid ?? '').trim();
  return {
    wifi: {
      // There is no guest network configured, so the panel shows NOTHING
      // rather than quietly handing a visitor the main network's password.
      has_guest_network: guest_ssid.length > 0,
      ssid: guest_ssid || null,
      password: guest_ssid ? (h?.wifi?.guest?.password ?? null) : null,
      main_ssid: h?.wifi?.main?.ssid ?? null,
    },
    entertainment: h?.entertainment ?? {},
    trash: h?.trash ?? {},
    shutoffs: h?.house_info?.shutoffs ?? [],
    contacts: h?.contacts ?? {},
    updated: h?._updated ?? null,
  };
}

// ── doorbell ──────────────────────────────────────────────────────────────

function doorbell_state(states: Map<string, HAEntityState>): {
  active: boolean;
  reason: 'ring' | 'person' | null;
  since: string | null;
} {
  const ring = states.get(DOORBELL.button);
  const person = states.get(DOORBELL.person);

  const fresh = (s: HAEntityState | undefined): boolean => {
    if (!s || s.state !== 'on') return false;
    return true;
  };
  // A press is momentary — HA flips it back to "off" in about a second, so the
  // card also stays up for a linger window after the last change.
  const recently = (s: HAEntityState | undefined): boolean => {
    if (!s?.last_changed) return false;
    return Date.now() - new Date(s.last_changed).getTime() < DOORBELL.linger_ms;
  };

  if (fresh(ring) || (recently(ring) && ring?.state === 'on')) {
    return { active: true, reason: 'ring', since: ring?.last_changed ?? null };
  }
  if (fresh(person)) {
    return { active: true, reason: 'person', since: person?.last_changed ?? null };
  }
  return { active: false, reason: null, since: null };
}

export function create_panel_router(deps: PanelRouterDeps): Hono {
  const panel_dir = resolve(deps.client_dir, 'panel');
  const canonical = deps.canonical_path ?? '/app/panel/';

  const r = new Hono();

  // ⚠ The LAN gate, first and unconditional. See the file header.
  r.use('*', async (c, next) => {
    if (!is_lan_address(client_ip(c))) return c.text('not found', 404);
    await next();
  });

  // ⚠ ROUTE ORDER IS LOAD-BEARING (same trap as create_hvac_router): the page
  // handler below is registered on '/' AND '/*', and Hono resolves a wildcard
  // by REGISTRATION ORDER. Every specific route must come first.

  // ── Assets ──────────────────────────────────────────────────────────────
  r.get('/panel.css', (c) => serve_static(c, resolve(panel_dir, 'panel.css')));
  r.get('/panel.js', (c) => serve_static(c, resolve(panel_dir, 'panel.js')));

  // ── API ─────────────────────────────────────────────────────────────────

  r.get('/api/bootstrap', async (c) => {
    c.header('Cache-Control', 'no-store');
    return c.json({
      rooms: room_list(),
      phase: phase_now(),
      house: await house_facts(),
      // The button only claims to work when both halves are actually there.
      kate: { wired: !!deps.runtime, stt: deps.runtime ? await stt_healthy() : false },
    });
  });

  /**
   * Ask Kate. Accepts either recorded audio (multipart `audio`) or typed text
   * (`text`), because microphone capture needs a secure context and the panel
   * is reached over plain http on the LAN.
   *
   * Answers as a FRIEND-tier guest — see core/panel/guest_turn.ts for why that
   * tier is passed explicitly and never left to default.
   */
  r.post('/api/ask', async (c) => {
    if (!deps.runtime) return c.json({ error: 'kate is not wired on this server' }, 501);

    const ctype = c.req.header('content-type') ?? '';
    let question = '';
    let heard: string | null = null;

    if (ctype.includes('multipart/form-data')) {
      let form: FormData;
      try {
        form = await c.req.formData();
      } catch (err) {
        return c.json({ error: `multipart parse: ${(err as Error).message}` }, 400);
      }
      const audio = form.get('audio');
      if (!(audio instanceof File)) return c.json({ error: 'audio field required' }, 400);
      if (audio.size > 8_000_000) return c.json({ error: 'recording too long' }, 413);

      const said = await transcribe_audio(audio, 'en');
      if (!said.ok) return c.json({ error: said.reason }, said.status);
      if (!said.text) return c.json({ error: "didn't catch that" }, 422);
      question = said.text;
      heard = said.text;
    } else {
      let body: { text?: string; room?: string };
      try {
        body = (await c.req.json()) as { text?: string; room?: string };
      } catch {
        return c.json({ error: 'bad json' }, 400);
      }
      question = (body.text ?? '').trim();
    }

    if (!question) return c.json({ error: 'nothing to ask' }, 400);
    if (question.length > 2_000) question = question.slice(0, 2_000);

    const room = c.req.query('room') ?? room_list()[0]!;
    // One session per panel device, so a follow-up ("and the other one?")
    // works without a household account. Opaque and short-lived.
    let session = getCookie(c, GUEST_SESSION_COOKIE);
    if (!session || !/^[a-f0-9]{32}$/.test(session)) {
      session = randomBytes(16).toString('hex');
      setCookie(c, GUEST_SESSION_COOKIE, session, {
        path: canonical,
        httpOnly: true,
        sameSite: 'Lax',
        maxAge: 30 * 60,
      });
    }

    const answer = await ask_kate({
      runtime: deps.runtime,
      session_id: session,
      room,
      question,
      timezone: deps.timezone ?? 'America/Denver',
    });
    if (!answer.ok) return c.json({ error: answer.reason }, 502);

    c.header('Cache-Control', 'no-store');
    return c.json({ heard, reply: answer.reply });
  });

  r.get('/api/pane', async (c) => {
    const snap = await get_snapshot();
    if (!snap) return c.json({ error: 'home assistant unreachable' }, 503);

    const room = c.req.query('room') ?? room_list()[0]!;
    c.header('Cache-Control', 'no-store');
    try {
      return c.json({
        ...compose_pane(room, phase_param(c), snap),
        doorbell: doorbell_state(snap.states),
        // Where the house thinks this panel is. A SUGGESTION, never an
        // instruction: a carried panel that silently changes room under a
        // guest's thumb is worse than one that asks. Null unless Bermuda is
        // configured AND resolves to a room this panel actually has.
        suggested_room: suggest_room(snap),
      });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : 'bad room' }, 400);
    }
  });

  r.post('/api/action', async (c) => {
    const snap = await get_snapshot();
    if (!snap) return c.json({ error: 'home assistant unreachable' }, 503);

    let body: { entity_id?: string; on?: boolean };
    try {
      body = (await c.req.json()) as { entity_id?: string; on?: boolean };
    } catch {
      return c.json({ error: 'bad json' }, 400);
    }

    const entity_id = body.entity_id ?? '';
    // The allowlist IS the composition: if no room's pane offers it, a guest
    // cannot reach it.
    if (!actuable_entities(snap).has(entity_id)) return c.json({ error: 'not on any pane' }, 403);

    const domain = entity_id.split('.')[0]!;
    const service =
      domain === 'scene'
        ? 'turn_on'
        : domain === 'media_player'
          ? 'media_play_pause'
          : body.on === false
            ? 'turn_off'
            : body.on === true
              ? 'turn_on'
              : 'toggle';

    const res = await ha_call_service(domain, service, { entity_id });
    if (!res.ok) return c.json({ error: res.reason }, 502);
    return c.json({ ok: true, entity_id, service });
  });

  /**
   * The front door still, and ONLY while someone is actually at it. Outside a
   * ring or a person-detected window this 404s, so the panel cannot be used to
   * watch the door — the camera is an answer to "who's there", not a feed.
   */
  r.get('/api/doorbell/frame', async (c) => {
    const snap = await get_snapshot();
    if (!snap) return c.json({ error: 'home assistant unreachable' }, 503);
    if (!doorbell_state(snap.states).active) return c.json({ error: 'nobody at the door' }, 404);

    const shot = await fetch_ha_camera_snapshot(DOORBELL.camera);
    if (!shot.ok) return c.json({ error: shot.reason }, 502);
    return new Response(shot.bytes, {
      status: 200,
      headers: { 'Content-Type': shot.content_type, 'Cache-Control': 'no-store' },
    });
  });

  // ── The page — REGISTERED LAST (see the route-order note above) ──────────
  const page = (c: Context): Response => {
    const path = new URL(c.req.url).pathname;
    if (path === canonical) return serve_static(c, resolve(panel_dir, 'index.html'));
    if (`${path}/` === canonical) return c.redirect(canonical, 301);
    return c.text('not found', 404);
  };
  r.get('/', page);
  r.get('/*', page);

  return r;
}
