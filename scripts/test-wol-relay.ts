/**
 * smoke:wol-relay — self-contained test for the host-network WoL relay
 * (ops/wol-relay/relay.ts) and the steamboat connector's relay path.
 *
 * No real LAN broadcast: the relay's UDP send is injected with a capture in
 * the handler tests, and the client-fallback test broadcasts to 127.0.0.1:9
 * (a dropped loopback datagram — no LAN side effect, no privileged bind).
 *
 *   bun run smoke:wol-relay
 */

import {
  buildMagicPacket,
  normalizeMac,
  makeHandler,
  configFromEnv,
  type RelayConfig,
} from '../ops/wol-relay/relay';
import { AvalancheClient } from '../src/connectors/avalanche';

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failures++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const STEAMBOAT_MAC = '02:00:00:00:00:2d';
const NORM = '6c0b5e4d162d';

// ─── 1. magic packet shape ───────────────────────────────────────────────────
console.log('magic packet');
{
  const p = buildMagicPacket(STEAMBOAT_MAC);
  check('packet is 102 bytes', p.length === 102, `got ${p.length}`);
  check('first 6 bytes are 0xFF', p.subarray(0, 6).every((b) => b === 0xff));
  check(
    'MAC repeats 16×',
    p.subarray(6, 12).toString('hex') === NORM &&
      p.subarray(96, 102).toString('hex') === NORM,
  );
  check('normalizeMac strips delimiters', normalizeMac(STEAMBOAT_MAC) === NORM);
  check('normalizeMac rejects short', normalizeMac('6c:0b') === null);
  let threw = false;
  try {
    buildMagicPacket('zz');
  } catch {
    threw = true;
  }
  check('buildMagicPacket throws on bad MAC', threw);
}

// ─── helper: start a relay server with an injected send-capture ───────────────
interface Sent {
  mac: string;
  broadcast: string;
  port: number;
}
function startTestRelay(overrides: Partial<RelayConfig>): {
  url: string;
  sent: Sent[];
  stop: () => void;
} {
  const sent: Sent[] = [];
  const cfg: RelayConfig = {
    token: 'test-token',
    defaultBroadcast: '255.255.255.255',
    allowedMacs: new Set<string>(),
    send: async (mac, broadcast, port) => {
      sent.push({ mac, broadcast, port });
    },
    ...overrides,
  };
  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: makeHandler(cfg) });
  return {
    url: `http://127.0.0.1:${server.port}`,
    sent,
    stop: () => server.stop(true),
  };
}

// ─── 2. relay handler behavior ───────────────────────────────────────────────
console.log('relay handler');
{
  const relay = startTestRelay({});
  try {
    const health = await fetch(`${relay.url}/health`);
    const hb = (await health.json()) as { ok: boolean; service: string };
    check('GET /health → ok', health.status === 200 && hb.ok && hb.service === 'wol-relay');

    const noAuth = await fetch(`${relay.url}/wake`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mac: STEAMBOAT_MAC }),
    });
    check('POST /wake without token → 401', noAuth.status === 401);

    const badAuth = await fetch(`${relay.url}/wake`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer wrong' },
      body: JSON.stringify({ mac: STEAMBOAT_MAC }),
    });
    check('POST /wake bad token → 401', badAuth.status === 401);

    const badMac = await fetch(`${relay.url}/wake`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-token' },
      body: JSON.stringify({ mac: 'nope' }),
    });
    check('POST /wake invalid mac → 400', badMac.status === 400);

    const ok = await fetch(`${relay.url}/wake`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-token' },
      body: JSON.stringify({ mac: STEAMBOAT_MAC, broadcast: '192.168.0.255' }),
    });
    const okb = (await ok.json()) as { ok: boolean; mac: string; broadcast: string };
    check('POST /wake good → 200 ok', ok.status === 200 && okb.ok);
    check('sent: normalized mac + provided broadcast + port 9',
      relay.sent.length === 1 &&
        relay.sent[0]!.mac === NORM &&
        relay.sent[0]!.broadcast === '192.168.0.255' &&
        relay.sent[0]!.port === 9);

    const dflt = await fetch(`${relay.url}/wake`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-token' },
      body: JSON.stringify({ mac: STEAMBOAT_MAC }),
    });
    await dflt.json();
    check('omitted broadcast → relay default',
      relay.sent.length === 2 && relay.sent[1]!.broadcast === '255.255.255.255');
  } finally {
    relay.stop();
  }
}

// ─── 3. allowlist + no-token refusal ─────────────────────────────────────────
console.log('relay allowlist + token guard');
{
  const relay = startTestRelay({ allowedMacs: new Set(['001122334455']) });
  try {
    const blocked = await fetch(`${relay.url}/wake`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-token' },
      body: JSON.stringify({ mac: STEAMBOAT_MAC }),
    });
    check('mac not in allowlist → 403', blocked.status === 403);
    check('blocked send not performed', relay.sent.length === 0);
  } finally {
    relay.stop();
  }

  const noTok = startTestRelay({ token: undefined });
  try {
    const res = await fetch(`${noTok.url}/wake`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer anything' },
      body: JSON.stringify({ mac: STEAMBOAT_MAC }),
    });
    check('relay without token configured → 503', res.status === 503);
  } finally {
    noTok.stop();
  }
}

// ─── 4. configFromEnv ────────────────────────────────────────────────────────
console.log('configFromEnv');
{
  const cfg = configFromEnv({
    AVALANCHE_WOL_RELAY_TOKEN: '  secret  ',
    AVALANCHE_WOL_BROADCAST: '192.168.0.255',
    AVALANCHE_WOL_ALLOWED_MACS: '02:00:00:00:00:2d, 00-11-22-33-44-55 , junk',
  });
  check('token trimmed', cfg.token === 'secret');
  check('default broadcast read', cfg.defaultBroadcast === '192.168.0.255');
  check('allowlist normalized + junk dropped',
    cfg.allowedMacs.has(NORM) && cfg.allowedMacs.has('001122334455') && cfg.allowedMacs.size === 2);
}

// ─── 5. client → relay integration + auth header ─────────────────────────────
console.log('AvalancheClient.sendWol via relay');
{
  const relay = startTestRelay({});
  try {
    const client = new AvalancheClient({
      host: '127.0.0.1',
      token: 'agentd-token',
      mac: STEAMBOAT_MAC,
      wolBroadcast: '192.168.0.255',
      wolRelayUrl: `${relay.url}/`, // trailing slash should be trimmed
      wolRelayToken: 'test-token',
    });
    check('trailing slash trimmed from relay url', client.wolRelayUrl === relay.url);
    await client.sendWol();
    check('client routed WoL through relay',
      relay.sent.length === 1 &&
        relay.sent[0]!.mac === NORM &&
        relay.sent[0]!.broadcast === '192.168.0.255',
      JSON.stringify(relay.sent));
  } finally {
    relay.stop();
  }
}

// ─── 6. fallback to direct broadcast when relay fails ────────────────────────
console.log('AvalancheClient.sendWol fallback');
{
  // Relay returns 500 → client must fall back to a direct broadcast without
  // throwing. Broadcast to loopback so there is no LAN side effect.
  const relay = startTestRelay({ send: async () => { throw new Error('boom'); } });
  try {
    const client = new AvalancheClient({
      host: '127.0.0.1',
      token: 'agentd-token',
      mac: STEAMBOAT_MAC,
      wolBroadcast: '127.0.0.1',
      wolRelayUrl: relay.url,
      wolRelayToken: 'test-token',
    });
    let threw = false;
    try {
      await client.sendWol();
    } catch {
      threw = true;
    }
    check('relay failure → sendWol falls back, does not throw', !threw);
  } finally {
    relay.stop();
  }

  // Unreachable relay URL → also graceful fallback.
  const client2 = new AvalancheClient({
    host: '127.0.0.1',
    token: 'agentd-token',
    mac: STEAMBOAT_MAC,
    wolBroadcast: '127.0.0.1',
    wolRelayUrl: 'http://127.0.0.1:1', // nothing listening
    wolRelayToken: 'test-token',
  });
  let threw2 = false;
  try {
    await client2.sendWol();
  } catch {
    threw2 = true;
  }
  check('unreachable relay → graceful fallback', !threw2);
}

console.log('');
if (failures > 0) {
  console.error(`FAILED: ${failures} check(s)`);
  process.exit(1);
}
console.log('wol-relay smoke: all checks passed');
