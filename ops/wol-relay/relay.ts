/**
 * hearth-wol-relay — a tiny host-network Wake-on-LAN relay.
 *
 * WHY THIS EXISTS
 * ---------------
 * The Hearth orchestrator runs in a Docker *bridge* network (docknet). A
 * Wake-on-LAN magic packet it broadcasts to 255.255.255.255 (or even the
 * LAN directed broadcast) never crosses the bridge onto the physical LAN
 * — the kernel does not forward directed broadcasts off a bridge without
 * a host-wide `net.ipv4.conf.<if>.bc_forwarding` sysctl, and the LLM host has
 * no host sudo to set (let alone persist) one. So `browse_url` could send
 * the packet "successfully" yet the workstation never woke from S3 suspend
 * (see architecture.md "Browser specialist surface (the workstation)").
 *
 * This relay runs with `network_mode: host`, so it shares the host's
 * network namespace: a broadcast it sends egresses the real LAN interface
 * directly — the exact path that wakes the box when a packet is sent from
 * the the LLM host host by hand (verified: that wakes the workstation in seconds).
 * The orchestrator's avalanche connector POSTs here instead of trying to
 * broadcast from inside the bridge. Modular by construction: any future
 * cross-subnet / container→LAN WoL need uses the same relay.
 *
 * ENDPOINTS
 * ---------
 *   GET  /health                         → { ok: true, service: 'wol-relay' }   (no auth)
 *   POST /wake  { mac, broadcast?, port? } (Bearer token)  → sends the magic packet
 *
 * ENV
 * ---
 *   AVALANCHE_WOL_RELAY_TOKEN    REQUIRED shared secret (Bearer). Unset ⇒ every /wake is refused.
 *   AVALANCHE_WOL_RELAY_PORT     listen port (default 9099)
 *   AVALANCHE_WOL_RELAY_BIND     listen address (default 0.0.0.0)
 *   AVALANCHE_WOL_BROADCAST      default broadcast target (default 255.255.255.255)
 *   AVALANCHE_WOL_ALLOWED_MACS   optional comma-separated MAC allowlist (normalized; empty ⇒ any)
 *
 * The relay is intentionally dependency-free (node:dgram + Bun.serve only)
 * and self-contained so it can run as a bare `bun run ops/wol-relay/relay.ts`
 * off the same bind-mounted repo + image the orchestrator uses — no new
 * build, no app import graph.
 */

import { createSocket } from 'node:dgram';

// ─── magic packet ────────────────────────────────────────────────────────────

/** Normalize a MAC to 12 lowercase hex chars, or null if malformed. */
export function normalizeMac(mac: string): string | null {
  const hex = mac.replace(/[^0-9a-fA-F]/g, '').toLowerCase();
  return hex.length === 12 ? hex : null;
}

/** Build the 102-byte WoL magic packet (6×0xFF + 16×MAC). `mac` may be
 *  colon/dash-delimited or bare hex. Throws on a malformed MAC. */
export function buildMagicPacket(mac: string): Buffer {
  const hex = normalizeMac(mac);
  if (!hex) throw new Error(`invalid MAC: ${mac}`);
  const macBytes = Buffer.from(hex, 'hex');
  const packet = Buffer.alloc(6 + 16 * 6);
  packet.fill(0xff, 0, 6);
  for (let i = 0; i < 16; i++) macBytes.copy(packet, 6 + i * 6);
  return packet;
}

/** Send one magic packet for `mac` to `broadcast:port` with SO_BROADCAST. */
export function sendMagicPacket(
  mac: string,
  broadcast: string,
  port = 9,
): Promise<void> {
  const packet = buildMagicPacket(mac);
  return new Promise<void>((resolve, reject) => {
    const sock = createSocket('udp4');
    sock.once('error', (err) => {
      try {
        sock.close();
      } catch {
        /* already closed */
      }
      reject(err);
    });
    sock.bind(0, () => {
      sock.setBroadcast(true);
      sock.send(packet, port, broadcast, (err) => {
        sock.close();
        if (err) reject(err);
        else resolve();
      });
    });
  });
}

// ─── relay config + handler ──────────────────────────────────────────────────

export interface RelayConfig {
  token: string | undefined;
  defaultBroadcast: string;
  /** Lowercase, normalized MAC allowlist. Empty ⇒ any MAC allowed. */
  allowedMacs: Set<string>;
  /** Injectable for tests; defaults to the real UDP send. */
  send?: (mac: string, broadcast: string, port: number) => Promise<void>;
}

export function configFromEnv(env: Record<string, string | undefined>): RelayConfig {
  const allow = (env.AVALANCHE_WOL_ALLOWED_MACS ?? '')
    .split(',')
    .map((m) => normalizeMac(m))
    .filter((m): m is string => m != null);
  return {
    token: env.AVALANCHE_WOL_RELAY_TOKEN?.trim() || undefined,
    defaultBroadcast: env.AVALANCHE_WOL_BROADCAST?.trim() || '255.255.255.255',
    allowedMacs: new Set(allow),
  };
}

function bearer(req: Request): string | null {
  const h = req.headers.get('authorization') ?? '';
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m ? m[1]!.trim() : null;
}

/** Constant-time-ish string compare (length-leaking but timing-flat on body). */
function tokenEq(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Build the request handler for a given config. Pure of process state so
 *  the test can drive it directly. */
export function makeHandler(cfg: RelayConfig) {
  const send = cfg.send ?? sendMagicPacket;
  return async function handle(req: Request): Promise<Response> {
    const url = new URL(req.url);

    if (req.method === 'GET' && url.pathname === '/health') {
      return Response.json({ ok: true, service: 'wol-relay' });
    }

    if (req.method === 'POST' && url.pathname === '/wake') {
      // A relay that can power on a machine must be authenticated, even on
      // a trusted LAN — it binds 0.0.0.0 in the host namespace.
      if (!cfg.token) {
        return Response.json(
          { ok: false, error: 'relay has no token configured; refusing' },
          { status: 503 },
        );
      }
      const presented = bearer(req);
      if (!presented || !tokenEq(presented, cfg.token)) {
        return Response.json({ ok: false, error: 'unauthorized' }, { status: 401 });
      }

      let body: { mac?: unknown; broadcast?: unknown; port?: unknown };
      try {
        body = (await req.json()) as typeof body;
      } catch {
        return Response.json({ ok: false, error: 'invalid JSON body' }, { status: 400 });
      }

      const mac = typeof body.mac === 'string' ? normalizeMac(body.mac) : null;
      if (!mac) {
        return Response.json({ ok: false, error: 'missing or invalid mac' }, { status: 400 });
      }
      if (cfg.allowedMacs.size > 0 && !cfg.allowedMacs.has(mac)) {
        return Response.json({ ok: false, error: 'mac not in allowlist' }, { status: 403 });
      }

      const broadcast =
        typeof body.broadcast === 'string' && body.broadcast.trim()
          ? body.broadcast.trim()
          : cfg.defaultBroadcast;
      const port =
        typeof body.port === 'number' && Number.isInteger(body.port) && body.port > 0
          ? body.port
          : 9;

      try {
        await send(mac, broadcast, port);
        console.log(
          `[wol-relay] sent magic packet mac=${mac} broadcast=${broadcast}:${port}`,
        );
        return Response.json({ ok: true, mac, broadcast, port });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[wol-relay] send failed mac=${mac} broadcast=${broadcast}: ${msg}`);
        return Response.json({ ok: false, error: msg }, { status: 502 });
      }
    }

    return Response.json({ ok: false, error: 'not found' }, { status: 404 });
  };
}

// ─── server bootstrap (only when run directly) ───────────────────────────────

export function startRelay(
  env: Record<string, string | undefined> = process.env,
): { port: number; stop: () => void } {
  const cfg = configFromEnv(env);
  const port = Number(env.AVALANCHE_WOL_RELAY_PORT ?? '9099');
  const hostname = env.AVALANCHE_WOL_RELAY_BIND ?? '0.0.0.0';
  const handle = makeHandler(cfg);
  const server = Bun.serve({ port, hostname, fetch: handle });
  console.log(
    `[wol-relay] listening on ${hostname}:${server.port} ` +
      `(token=${cfg.token ? 'set' : 'MISSING — /wake disabled'}, ` +
      `default_broadcast=${cfg.defaultBroadcast}, ` +
      `allowlist=${cfg.allowedMacs.size || 'any'})`,
  );
  return { port: server.port ?? port, stop: () => server.stop(true) };
}

if (import.meta.main) {
  startRelay();
}
