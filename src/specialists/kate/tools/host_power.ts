/**
 * Host power control (2026-07-28) — Kate wakes and sleeps household machines
 * when the owner asks ("wake the workstation", "put the workstation back to sleep").
 *
 * Owner-only. Allowlisted to the machines in config/power_hosts.yaml; there is
 * no "any host" path, so a machine that is not listed cannot be touched through
 * Kate however she is asked.
 *
 * WAKE reuses the host-network WoL relay (ops/wol-relay/relay.ts) that
 * browse_url already depends on — a magic packet from inside the orchestrator's
 * docknet bridge never reaches the physical LAN, which is why the relay exists.
 *
 * SLEEP goes through the target's OWN agentd `POST /suspend`. Putting it there
 * rather than here is deliberate: agentd already owns the suspend contract on
 * its box, so the two guards that matter — never suspend an always-on host,
 * never suspend mid-session — are enforced ON THE TARGET and cannot be bypassed
 * by this or any future caller.
 *
 * WHY THIS EXISTS: a box woken by WoL that never received a `/wake-ack` has no
 * wake marker, and agentd's invariant #1 is "no marker → no auto-suspend,
 * ever." So it stays awake indefinitely. Observed on the workstation the day this
 * shipped: idle 3h25m after one browse session, burning workstation power the
 * whole time. Automatic sleep is deliberately conservative; this is the manual
 * counterpart, not a replacement for it.
 */
import { z } from 'zod';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parse_yaml } from 'yaml';
import type { Tool, ToolContext } from '@core/tool';

const OWNER_ONLY_MSG =
  "Powering household machines on and off is owner-only — I don't do that for anyone but you.";

function is_owner(ctx: ToolContext): boolean {
  // Absent user = legacy owner-default (system / deliberation context).
  return !ctx.user || ctx.user.tier === 'owner';
}

interface PowerHost {
  label: string;
  mac?: string;
  health_host: string;
  session_host?: string;
  agentd_port?: number;
  wakeable?: boolean;
  sleepable?: boolean;
  notes?: string;
}

let _hosts: Record<string, PowerHost> | null = null;

/** Parsed once. A malformed or missing file yields an EMPTY registry, which
 *  fails closed — no host is controllable — rather than throwing per call. */
function hosts(): Record<string, PowerHost> {
  if (_hosts) return _hosts;
  try {
    const path = join(process.env.HEARTH_CONFIG_DIR ?? 'config', 'power_hosts.yaml');
    const doc = parse_yaml(readFileSync(path, 'utf8')) as { hosts?: Record<string, PowerHost> };
    _hosts = doc?.hosts ?? {};
  } catch {
    _hosts = {};
  }
  return _hosts;
}

/** Test seam. */
export function _reset_power_hosts(next?: Record<string, PowerHost>): void {
  _hosts = next ?? null;
}

async function host_reachable(host: PowerHost, timeout_ms = 4000): Promise<boolean> {
  const port = host.agentd_port ?? 4446;
  try {
    const res = await fetch(`http://${host.health_host}:${port}/health`, {
      signal: AbortSignal.timeout(timeout_ms),
    });
    return res.ok;
  } catch {
    return false;
  }
}


/** Power actions are keyed per host on a 5-MINUTE bucket. A tighter key would
 *  wedge a legitimate "wake it again later"; no key at all would let a double
 *  fire send two suspends (the second landing after resume, putting the box
 *  straight back down). Five minutes is comfortably longer than the 90s wake
 *  budget and shorter than any real re-request. */
function power_idempotency(action: string, host: string): string {
  const bucket = Math.floor(Date.now() / 300_000);
  return `${action}:${host.trim().toLowerCase()}:${bucket}`;
}

const HostInput = z.object({
  host: z.string().min(1).describe('Which machine, by name (see list_power_hosts).'),
});

const WakeOutput = z.object({
  host: z.string(),
  already_awake: z.boolean(),
  awake: z.boolean(),
  waited_seconds: z.number().nullable(),
  note: z.string(),
});

export const wake_host: Tool<z.infer<typeof HostInput>, z.infer<typeof WakeOutput>> = {
  name: 'wake_host',
  description:
    'Power on a household machine with Wake-on-LAN and wait until it answers (owner-only). ' +
    'Only the machines in the power-host allowlist can be woken. Waking a workstation ' +
    'costs real power and heat, so do it when asked, not speculatively. Use ' +
    'list_power_hosts to see what exists and what state it is in.',
  risk: 'write_internal',
  required_capabilities: ['manage_host_power'],
  weight: 'heavy',
  input_schema: HostInput,
  output_schema: WakeOutput,

  idempotency_key(input) {
    return power_idempotency('wake_host', input.host);
  },

  async execute(input, ctx) {
    const name = input.host.trim().toLowerCase();
    const host = hosts()[name];
    if (!host) {
      return {
        host: name,
        already_awake: false,
        awake: false,
        waited_seconds: null,
        note: `I don't control a machine called "${input.host}". Known: ${Object.keys(hosts()).join(', ') || '(none configured)'}.`,
      };
    }
    if (!is_owner(ctx)) {
      return { host: name, already_awake: false, awake: false, waited_seconds: null, note: OWNER_ONLY_MSG };
    }
    if (host.wakeable === false || !host.mac) {
      return {
        host: name,
        already_awake: true,
        awake: true,
        waited_seconds: null,
        note: `${host.label} is always on — there's nothing to wake.`,
      };
    }

    if (await host_reachable(host)) {
      return {
        host: name,
        already_awake: true,
        awake: true,
        waited_seconds: 0,
        note: `${host.label} is already awake.`,
      };
    }

    const relay_url = process.env.AVALANCHE_WOL_RELAY_URL;
    const relay_token = process.env.AVALANCHE_WOL_RELAY_TOKEN;
    if (!relay_url || !relay_token) {
      return {
        host: name,
        already_awake: false,
        awake: false,
        waited_seconds: null,
        note: 'The Wake-on-LAN relay is not configured, so I cannot send the magic packet from here.',
      };
    }

    try {
      const res = await fetch(`${relay_url.replace(/\/+$/, '')}/wake`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${relay_token}` },
        body: JSON.stringify({
          mac: host.mac,
          broadcast: process.env.AVALANCHE_WOL_BROADCAST,
        }),
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) throw new Error(`relay returned ${res.status}`);
    } catch (e) {
      return {
        host: name,
        already_awake: false,
        awake: false,
        waited_seconds: null,
        note: `I couldn't send the wake packet: ${(e as Error).message}`,
      };
    }

    // Poll the health NIC — copper answers within a second of resume, so a
    // miss across the whole budget means the box genuinely didn't power on.
    const budget_ms = 90_000;
    const started = Date.now();
    while (Date.now() - started < budget_ms) {
      await new Promise((r) => setTimeout(r, 3000));
      if (await host_reachable(host, 2500)) {
        const secs = Math.round((Date.now() - started) / 1000);
        return {
          host: name,
          already_awake: false,
          awake: true,
          waited_seconds: secs,
          note: `${host.label} is up (took ${secs}s).`,
        };
      }
    }
    return {
      host: name,
      already_awake: false,
      awake: false,
      waited_seconds: Math.round(budget_ms / 1000),
      note: `I sent the wake packet but ${host.label} never answered within 90s — that's a WoL or BIOS problem, not a slow boot.`,
    };
  },
};

const SleepOutput = z.object({
  host: z.string(),
  slept: z.boolean(),
  already_asleep: z.boolean(),
  note: z.string(),
});

export const sleep_host: Tool<z.infer<typeof HostInput>, z.infer<typeof SleepOutput>> = {
  name: 'sleep_host',
  description:
    'Put a household machine to sleep (owner-only). Only allowlisted machines can be slept, ' +
    'and always-on hosts refuse — the household stack must never be suspended. Refuses while ' +
    'a browser session is running on the target. Useful because a machine woken without a ' +
    'wake-marker never auto-sleeps and will otherwise sit idle burning power.',
  risk: 'write_internal',
  required_capabilities: ['manage_host_power'],
  weight: 'heavy',
  input_schema: HostInput,
  output_schema: SleepOutput,

  idempotency_key(input) {
    return power_idempotency('sleep_host', input.host);
  },

  async execute(input, ctx) {
    const name = input.host.trim().toLowerCase();
    const host = hosts()[name];
    if (!host) {
      return {
        host: name,
        slept: false,
        already_asleep: false,
        note: `I don't control a machine called "${input.host}". Known: ${Object.keys(hosts()).join(', ') || '(none configured)'}.`,
      };
    }
    if (!is_owner(ctx)) {
      return { host: name, slept: false, already_asleep: false, note: OWNER_ONLY_MSG };
    }
    if (host.sleepable === false) {
      return {
        host: name,
        slept: false,
        already_asleep: false,
        note: `I won't sleep ${host.label}. ${host.notes ?? 'It has to stay up.'}`,
      };
    }

    if (!(await host_reachable(host))) {
      return {
        host: name,
        slept: false,
        already_asleep: true,
        note: `${host.label} is already asleep (or off the network).`,
      };
    }

    const port = host.agentd_port ?? 4446;
    // The suspend command goes to the SESSION host when one is split out: the
    // health NIC stays powered through S3 and would answer either way, but the
    // daemon is the same process on both, so either works. Prefer health_host
    // for consistency with the reachability probe above.
    try {
      const res = await fetch(`http://${host.health_host}:${port}/suspend`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Agentd-Auth': read_agentd_token(),
        },
        body: JSON.stringify({ reason: 'owner_request_via_kate' }),
        signal: AbortSignal.timeout(10_000),
      });
      const body = (await res.json().catch(() => ({}))) as { reason?: string; message?: string };
      if (res.status === 409) {
        return {
          host: name,
          slept: false,
          already_asleep: false,
          note: `${host.label} refused: ${body.message ?? body.reason ?? 'busy'}.`,
        };
      }
      if (!res.ok) throw new Error(`agentd returned ${res.status}`);
    } catch (e) {
      return {
        host: name,
        slept: false,
        already_asleep: false,
        note: `I couldn't reach ${host.label}'s daemon to suspend it: ${(e as Error).message}`,
      };
    }

    return {
      host: name,
      slept: true,
      already_asleep: false,
      note: `${host.label} is going to sleep.`,
    };
  },
};

function read_agentd_token(): string {
  const path = process.env.AVALANCHE_TOKEN_PATH ?? '/secrets/agentd-token';
  return readFileSync(path, 'utf8').trim();
}

const ListOutput = z.object({
  hosts: z.array(
    z.object({
      name: z.string(),
      label: z.string(),
      awake: z.boolean(),
      wakeable: z.boolean(),
      sleepable: z.boolean(),
      notes: z.string().nullable(),
    }),
  ),
});

export const list_power_hosts: Tool<Record<string, never>, z.infer<typeof ListOutput>> = {
  name: 'list_power_hosts',
  description:
    'List the household machines that can be powered on or put to sleep, with their current ' +
    'up/down state. Use before wake_host / sleep_host so you answer from real state.',
  risk: 'read',
  required_capabilities: ['manage_host_power'],
  input_schema: z.object({}),
  output_schema: ListOutput,

  idempotency_key() {
    return `list_power_hosts:${Math.floor(Date.now() / 30_000)}`;
  },

  async execute(_input, ctx) {
    if (!is_owner(ctx)) return { hosts: [] };
    const entries = Object.entries(hosts());
    const out = await Promise.all(
      entries.map(async ([name, h]) => ({
        name,
        label: h.label,
        awake: await host_reachable(h, 3000),
        wakeable: h.wakeable !== false,
        sleepable: h.sleepable !== false,
        notes: h.notes ?? null,
      })),
    );
    return { hosts: out };
  },
};
