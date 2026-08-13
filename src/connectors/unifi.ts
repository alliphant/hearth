/**
 * UniFi controller connector. Read-only by design — talks to the local
 * UDM / Dream Machine / Cloud Key over the UniFi OS HTTPS proxy.
 *
 * Auth: POST /api/auth/login with username/password, captures the
 * TOKEN cookie, refreshes every ~25 minutes (UniFi OS cookies are
 * typically 30-90m TTL). On 401 we re-login once and retry.
 *
 * One cookie covers both Network (/proxy/network/...) and Protect
 * (/proxy/protect/...).
 *
 * The connector logs in lazily on first read. No login on module
 * load — that would crash the orchestrator if creds are missing.
 *
 * Audit redaction (post-2026-05-27): client MACs are reduced to the
 * OUI prefix + xx and IPs to /24 IN THE AUDIT LOG ROW only — the
 * tool RESULT carries full identifiers to the calling specialist.
 * Pre-fix this redaction was applied to the tool output itself,
 * which meant Cassandra (the perimeter watcher) couldn't see her
 * own LAN — a 2026-05-27 enumeration she ran surfaced the gap. The
 * `read_unifi` capability is the discretion boundary; once you've
 * earned that grant, you get real identifiers. Audit-log redaction
 * mirrors the maps connector's `redact_for_audit` pattern: privacy
 * lives at the audit boundary, not at the tool-return boundary, so
 * specialists can do their job and the log doesn't leak.
 */
import { z } from 'zod';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ulid } from 'ulid';
import type { Tool, ToolContext } from '@core/tool';
import { audit_connector, type ConnectorAuditCtx } from './_audit';

const UNIFI_HOST = (process.env.UNIFI_HOST ?? '').replace(/\/$/, '');
const UNIFI_USERNAME = process.env.UNIFI_USERNAME ?? '';
const UNIFI_PASSWORD = process.env.UNIFI_PASSWORD ?? '';
const UNIFI_SITE = process.env.UNIFI_SITE ?? 'default';
const UNIFI_INSECURE = process.env.UNIFI_INSECURE === '1';

const COOKIE_TTL_MS = 25 * 60 * 1000;
const FETCH_TIMEOUT_MS = 12_000;

let cached_cookie: string | null = null;
let cookie_expires_at = 0;
// CSRF token from the login response — UniFi OS requires it as an
// `X-CSRF-Token` header on POST requests through the proxy (GETs are
// cookie-only). Probed live 2026-06-10 on UDM Pro / Network 10.4.57:
// a v2 POST without it returns 403 Forbidden, with it 200.
let cached_csrf: string | null = null;

function fetch_opts(extra: RequestInit = {}): RequestInit {
  const opts: RequestInit & { tls?: { rejectUnauthorized: boolean } } = {
    ...extra,
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  };
  if (UNIFI_INSECURE) opts.tls = { rejectUnauthorized: false };
  return opts;
}

async function login(): Promise<void> {
  if (!UNIFI_HOST || !UNIFI_USERNAME || !UNIFI_PASSWORD) {
    throw new Error(
      'UNIFI_HOST / UNIFI_USERNAME / UNIFI_PASSWORD not configured',
    );
  }
  const res = await fetch(
    `${UNIFI_HOST}/api/auth/login`,
    fetch_opts({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: UNIFI_USERNAME,
        password: UNIFI_PASSWORD,
      }),
    }),
  );
  if (!res.ok) {
    throw new Error(`UniFi login failed: HTTP ${res.status}`);
  }
  const set_cookies = (res.headers as Headers & { getSetCookie?: () => string[] })
    .getSetCookie?.() ?? [];
  let token: string | null = null;
  for (const sc of set_cookies) {
    const m = /^TOKEN=([^;]+)/.exec(sc);
    if (m) {
      token = `TOKEN=${m[1]}`;
      break;
    }
  }
  if (!token) {
    throw new Error('UniFi login: no TOKEN cookie in response');
  }
  cached_cookie = token;
  cached_csrf = res.headers.get('x-csrf-token');
  cookie_expires_at = Date.now() + COOKIE_TTL_MS;
}

interface UnifiGetResult<T> {
  ok: boolean;
  status: number;
  data?: T;
  error?: string;
}

async function unifi_get<T = unknown>(path: string): Promise<UnifiGetResult<T>> {
  if (!cached_cookie || Date.now() > cookie_expires_at) {
    try {
      await login();
    } catch (err) {
      return {
        ok: false,
        status: 0,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
  const url = `${UNIFI_HOST}${path}`;
  const do_fetch = async () =>
    fetch(url, fetch_opts({ headers: { Cookie: cached_cookie! } }));

  let res: Response;
  try {
    res = await do_fetch();
  } catch (err) {
    return {
      ok: false,
      status: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
  if (res.status === 401) {
    try {
      await login();
      res = await do_fetch();
    } catch (err) {
      return {
        ok: false,
        status: 401,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
  if (!res.ok) {
    let body = '';
    try {
      body = await res.text();
    } catch {
      /* swallow */
    }
    return {
      ok: false,
      status: res.status,
      error: `HTTP ${res.status}: ${body.slice(0, 200)}`,
    };
  }
  try {
    const data = (await res.json()) as T;
    return { ok: true, status: res.status, data };
  } catch (err) {
    return {
      ok: false,
      status: res.status,
      error: `parse error: ${(err as Error).message}`,
    };
  }
}

/**
 * POST through the UniFi OS proxy. Same auth lifecycle as unifi_get,
 * plus the `X-CSRF-Token` header UniFi OS demands on proxied POSTs
 * (without it the Network app returns 403 even for read-shaped queries
 * like the v2 traffic-flows search). On 401 OR 403 we re-login once and
 * retry — a 403 here is more often a stale CSRF token than a role
 * problem, and the retry disambiguates: a permission 403 survives it.
 */
async function unifi_post<T = unknown>(
  path: string,
  body: unknown,
): Promise<UnifiGetResult<T>> {
  if (!cached_cookie || Date.now() > cookie_expires_at) {
    try {
      await login();
    } catch (err) {
      return {
        ok: false,
        status: 0,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
  const url = `${UNIFI_HOST}${path}`;
  const do_fetch = async () =>
    fetch(
      url,
      fetch_opts({
        method: 'POST',
        headers: {
          Cookie: cached_cookie!,
          'Content-Type': 'application/json',
          ...(cached_csrf ? { 'X-CSRF-Token': cached_csrf } : {}),
        },
        body: JSON.stringify(body),
      }),
    );

  let res: Response;
  try {
    res = await do_fetch();
  } catch (err) {
    return {
      ok: false,
      status: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
  if (res.status === 401 || res.status === 403) {
    try {
      await login();
      res = await do_fetch();
    } catch (err) {
      return {
        ok: false,
        status: res.status,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
  if (!res.ok) {
    let body_text = '';
    try {
      body_text = await res.text();
    } catch {
      /* swallow */
    }
    return {
      ok: false,
      status: res.status,
      error: `HTTP ${res.status}: ${body_text.slice(0, 200)}`,
    };
  }
  try {
    const data = (await res.json()) as T;
    return { ok: true, status: res.status, data };
  } catch (err) {
    return {
      ok: false,
      status: res.status,
      error: `parse error: ${(err as Error).message}`,
    };
  }
}

// ── Redaction ────────────────────────────────────────────────────────────

function redact_mac(mac: string | null | undefined): string {
  if (!mac) return '';
  const m = /^([0-9a-fA-F]{2}:[0-9a-fA-F]{2}:[0-9a-fA-F]{2}):/.exec(mac);
  return m ? `${m[1]}:xx:xx:xx` : mac;
}

function redact_ip(ip: string | null | undefined): string {
  if (!ip) return '';
  const m = /^(\d+\.\d+\.\d+)\.\d+$/.exec(ip);
  return m ? `${m[1]}.x` : ip;
}

// ── unifi_topology ───────────────────────────────────────────────────────

const TopologyInput = z.object({}).strict();

const DeviceSchema = z.object({
  name: z.string(),
  model: z.string().nullable(),
  type: z.string(),
  /** Full MAC. Redacted in the audit row only. */
  mac: z.string(),
  /** Full IP. Redacted in the audit row only. */
  ip: z.string().nullable(),
  state: z.string(),
  version: z.string().nullable(),
  uptime_s: z.number().nullable(),
  num_clients: z.number().nullable(),
  last_seen_iso: z.string().nullable(),
});

const ClientSummarySchema = z.object({
  hostname: z.string().nullable(),
  /** Full MAC. Redacted in the audit row only. */
  mac: z.string(),
  /** Full IP. Redacted in the audit row only. */
  ip: z.string().nullable(),
  is_wired: z.boolean(),
  uptime_s: z.number().nullable(),
  signal_dbm: z.number().nullable(),
  /** Full AP MAC. Redacted in the audit row only. */
  ap_mac: z.string().nullable(),
  vlan: z.number().nullable(),
  /** Cumulative-since-association byte counters from UDM's
   *  `/stat/sta` payload. Useful for spot questions ("who's currently
   *  pulling a lot?") — for windowed top-talker queries use
   *  `unifi_top_talkers` which hits UDM's built-in time-series. */
  rx_bytes: z.number().nullable(),
  tx_bytes: z.number().nullable(),
  /** Per-link instantaneous rate when UDM reports it. */
  rx_rate_kbps: z.number().nullable(),
  tx_rate_kbps: z.number().nullable(),
});

const TopologyOutput = z.object({
  fetched_at_iso: z.string(),
  site: z.string(),
  devices: z.array(DeviceSchema),
  clients_total: z.number(),
  clients_wired: z.number(),
  clients_wireless: z.number(),
  clients_sample: z.array(ClientSummarySchema),
  error: z.string().optional(),
});

interface RawDevice {
  name?: string;
  model?: string;
  type?: string;
  mac?: string;
  ip?: string;
  state?: number;
  version?: string;
  uptime?: number;
  num_sta?: number;
  last_seen?: number;
}

interface RawClient {
  hostname?: string;
  name?: string;
  mac?: string;
  ip?: string;
  is_wired?: boolean;
  uptime?: number;
  rssi?: number;
  signal?: number;
  ap_mac?: string;
  vlan?: number;
  // Bytes since association (wireless) / since connect (wired). UDM
  // exposes both `rx_bytes` (wireless) and `wired-rx_bytes` (wired);
  // we coalesce in the projector. Rates are best-effort — not every
  // firmware fills them.
  rx_bytes?: number;
  tx_bytes?: number;
  'wired-rx_bytes'?: number;
  'wired-tx_bytes'?: number;
  rx_rate?: number; // UDM units: kbit/s (older) or bps (newer)
  tx_rate?: number;
}

const DEVICE_STATE: Record<number, string> = {
  0: 'disconnected',
  1: 'connected',
  2: 'pending_adoption',
  4: 'upgrading',
  5: 'provisioning',
  6: 'heartbeat_missed',
  7: 'adopting',
  9: 'adoption_failed',
  11: 'isolated',
};

/** A currently-associated client, normalized for the WiFi-presence layer.
 *  `stat/sta` lists ACTIVE stations only — a device present here is connected to
 *  the home network right now (uptime_s = seconds since association). */
export interface ActiveClient {
  /** Lowercased MAC (a per-SSID Private Wi-Fi Address for modern iPhones —
   *  stable per network, so usable as an identity after a one-time capture). */
  mac: string;
  /** UniFi user-set friendly name (the controller alias, e.g. "Jasper's iPhone").
   *  Distinct from `hostname` (device-reported, often just "iPhone") and the
   *  PREFERRED identity — name a device once in UniFi and presence resolves it. */
  alias: string | null;
  hostname: string | null;
  ap_mac: string | null;
  is_wired: boolean;
  uptime_s: number | null;
}

/**
 * The currently-associated clients (stat/sta), normalized for presence. A device
 * PRESENT here is on the home network now. Returns [] on any error (fail-open) —
 * NOT a Tool; called directly by the WiFi-presence resolver (wifi_presence.ts),
 * so it carries no capability gate (an internal read, like get_current_location).
 */
export async function list_active_clients(): Promise<ActiveClient[]> {
  const path = `/proxy/network/api/s/${encodeURIComponent(UNIFI_SITE)}/stat/sta`;
  const res = await unifi_get<{ data?: RawClient[] }>(path);
  if (!res.ok || !Array.isArray(res.data?.data)) return [];
  return res.data.data
    .filter((c): c is RawClient & { mac: string } => typeof c.mac === 'string' && c.mac.length > 0)
    .map((c) => ({
      mac: c.mac.toLowerCase(),
      alias: c.name ?? null, // UniFi user-set name (the controller alias)
      hostname: c.hostname ?? null, // device-reported
      ap_mac: c.ap_mac ?? null,
      is_wired: Boolean(c.is_wired),
      uptime_s: typeof c.uptime === 'number' ? c.uptime : null,
    }));
}

export const unifi_topology: Tool<
  z.infer<typeof TopologyInput>,
  z.infer<typeof TopologyOutput>
> = {
  name: 'unifi_topology',
  description:
    "Live read of UniFi controller: APs, switches, gateway, and the full list of currently connected clients. Each client row carries hostname, full MAC + IP (you hold `read_unifi`; this is your perimeter), is_wired, signal_dbm, AP, VLAN, and cumulative byte counters (rx_bytes / tx_bytes since association) plus instantaneous rates when UDM reports them. Use this for current-state questions (\"who's connected?\", \"is this MAC on a guest VLAN?\", \"who's currently pulling traffic?\"). For windowed top-talker queries over an hour/day/week, use `unifi_top_talkers` — it hits UDM's built-in time-series and ranks by total bytes over the window without needing periodic snapshots.",
  risk: 'read',
  required_capabilities: ['read_unifi'],
  input_schema: TopologyInput,
  output_schema: TopologyOutput,

  idempotency_key() {
    return `unifi_topology:${UNIFI_SITE}`;
  },

  async execute(_input, ctx: ToolContext) {
    const audit: ConnectorAuditCtx = {
      memory: ctx.memory,
      agent: ctx.specialist_id ?? 'specialist',
      intent_id: ctx.intent_id,
    };
    const now = new Date().toISOString();
    const dev_path = `/proxy/network/api/s/${encodeURIComponent(UNIFI_SITE)}/stat/device`;
    const cli_path = `/proxy/network/api/s/${encodeURIComponent(UNIFI_SITE)}/stat/sta`;

    const [dev_res, cli_res] = await Promise.all([
      unifi_get<{ data?: RawDevice[] }>(dev_path),
      unifi_get<{ data?: RawClient[] }>(cli_path),
    ]);

    if (!dev_res.ok) {
      const result = {
        fetched_at_iso: now,
        site: UNIFI_SITE,
        devices: [],
        clients_total: 0,
        clients_wired: 0,
        clients_wireless: 0,
        clients_sample: [],
        error: dev_res.error ?? `HTTP ${dev_res.status}`,
      };
      audit_connector(audit, 'unifi_topology', { site: UNIFI_SITE }, result, result.error);
      return result;
    }

    const devices = (dev_res.data?.data ?? []).map((d): z.infer<typeof DeviceSchema> => ({
      name: d.name ?? '(unnamed)',
      model: d.model ?? null,
      type: d.type ?? 'unknown',
      mac: d.mac ?? '',
      ip: d.ip ?? null,
      state: DEVICE_STATE[d.state ?? -1] ?? `state_${d.state ?? '?'}`,
      version: d.version ?? null,
      uptime_s: typeof d.uptime === 'number' ? d.uptime : null,
      num_clients: typeof d.num_sta === 'number' ? d.num_sta : null,
      last_seen_iso:
        typeof d.last_seen === 'number'
          ? new Date(d.last_seen * 1000).toISOString()
          : null,
    }));

    const clients = cli_res.ok ? cli_res.data?.data ?? [] : [];
    const wired = clients.filter((c) => c.is_wired).length;
    const wireless = clients.length - wired;
    // Cap sample to 25 so payload stays bounded; if you need more,
    // use a future filtered tool (e.g. unifi_clients_search).
    const sample = clients.slice(0, 25).map((c): z.infer<typeof ClientSummarySchema> => ({
      hostname: c.hostname ?? c.name ?? null,
      mac: c.mac ?? '',
      ip: c.ip ?? null,
      is_wired: Boolean(c.is_wired),
      uptime_s: typeof c.uptime === 'number' ? c.uptime : null,
      signal_dbm:
        typeof c.rssi === 'number'
          ? c.rssi
          : typeof c.signal === 'number'
          ? c.signal
          : null,
      ap_mac: c.ap_mac ?? null,
      vlan: typeof c.vlan === 'number' ? c.vlan : null,
      // Coalesce wireless `rx_bytes` and wired `wired-rx_bytes`.
      // UDM uses different field names by link type; the tool result
      // just calls it `rx_bytes` regardless.
      rx_bytes:
        typeof c.rx_bytes === 'number'
          ? c.rx_bytes
          : typeof c['wired-rx_bytes'] === 'number'
          ? c['wired-rx_bytes']
          : null,
      tx_bytes:
        typeof c.tx_bytes === 'number'
          ? c.tx_bytes
          : typeof c['wired-tx_bytes'] === 'number'
          ? c['wired-tx_bytes']
          : null,
      rx_rate_kbps: typeof c.rx_rate === 'number' ? c.rx_rate : null,
      tx_rate_kbps: typeof c.tx_rate === 'number' ? c.tx_rate : null,
    }));

    const result = {
      fetched_at_iso: now,
      site: UNIFI_SITE,
      devices,
      clients_total: clients.length,
      clients_wired: wired,
      clients_wireless: wireless,
      clients_sample: sample,
    };
    // Audit-row redaction (mirrors src/connectors/maps.ts redact_for_audit):
    // raw identifiers stayed in `result` above for the specialist that
    // called us; the audit_log row gets the scrubbed shape. Includes a
    // summary count + a tiny redacted client preview so query_audit_log
    // is useful for "did Cassandra look at the network in the last
    // hour?" without leaking who was on it.
    audit_connector(
      audit,
      'unifi_topology',
      { site: UNIFI_SITE },
      {
        devices_count: devices.length,
        clients_total: clients.length,
        clients_wired: wired,
        clients_wireless: wireless,
        sample_redacted: sample.slice(0, 5).map((c) => ({
          hostname: c.hostname,
          mac_oui: redact_mac(c.mac),
          ip_subnet: c.ip ? redact_ip(c.ip) : null,
          is_wired: c.is_wired,
          vlan: c.vlan,
        })),
      },
    );
    return result;
  },
};

// ── unifi_top_talkers ────────────────────────────────────────────────────
//
// UDM exposes per-client DPI (Deep Packet Inspection) byte counters at
// `/proxy/network/api/s/<site>/stat/stadpi`. Each row is a client with
// `mac` + cumulative `by_app[]` (per-application bytes) + `by_cat[]`
// (per-category bytes). We fold per-client totals and rank.
//
// Probed against UDM Pro firmware 10.4.57 on 2026-05-27 — the legacy
// report endpoint (`/stat/report/{interval}.user`) returns shapeless
// rows on this firmware (just `{user, o, oid}` with no byte fields)
// AND POST to the .site variant 403s for the cassandra read account.
// `/stat/stadpi` is the documented per-station-DPI path and returns
// real data when DPI is enabled on the UDM (Settings → Internet →
// Advanced → Deep Packet Inspection).
//
// When DPI is disabled or the account lacks permission, the endpoint
// returns 200 with `data: []` — our "no data" hint cites the toggle.

const TopTalkersInput = z.object({
  /** How many ranked rows to return. DPI per-client typically covers
   *  10-200 clients on a small site; limit shapes the LLM-facing
   *  payload, not the underlying query. */
  limit: z.number().int().min(1).max(50).default(10),
}).strict();

const TopTalkerSchema = z.object({
  hostname: z.string().nullable(),
  mac: z.string(),
  total_bytes: z.number(),
  rx_bytes: z.number(),
  tx_bytes: z.number(),
  /** Top 3 application names by bytes for this client (DPI's
   *  per-app breakdown). Empty array when DPI's app dimension
   *  isn't populated for the client. */
  top_apps: z.array(z.object({ app: z.string(), bytes: z.number() })),
});

const TopTalkersOutput = z.object({
  fetched_at_iso: z.string(),
  site: z.string(),
  /** Total bytes ALL clients moved — baseline for "is anyone hogging"
   *  judgments. Semantics depend on `source`: `clients_v2` totals are
   *  the controller's long-lived cumulative usage per client (verified
   *  live 2026-06-10: months-scale, far exceeding the per-association
   *  rx/tx fields); `dpi_legacy` accumulates since DPI was enabled
   *  (UDM resets on DPI-restart). Neither is a clean time window —
   *  rank with it, don't window with it. */
  total_bytes_all: z.number(),
  /** Which controller store served the ranking: `clients_v2` (Network
   *  9/10.x active-clients traffic counters — no per-app breakdown) or
   *  `dpi_legacy` (older controllers' per-station DPI, with top_apps). */
  source: z.string().optional(),
  talkers: z.array(TopTalkerSchema),
  error: z.string().optional(),
  hint: z.string().optional(),
});

/** v2 active-clients row (Network 9/10.x). Only the fields we read. */
interface RawV2Client {
  mac?: string;
  name?: string;
  hostname?: string;
  display_name?: string;
  ip?: string;
  rx_bytes?: number;
  tx_bytes?: number;
  usage_bytes?: number;
}

interface RawDpiAppRow {
  app?: number;
  cat?: number;
  rx_bytes?: number;
  tx_bytes?: number;
  rx_packets?: number;
  tx_packets?: number;
}

interface RawDpiClientRow {
  mac?: string;
  by_app?: RawDpiAppRow[];
  by_cat?: Array<{ cat?: number; rx_bytes?: number; tx_bytes?: number }>;
}

// Per-app id → name. UniFi's DPI returns numeric app ids; the
// authoritative map is ~600 entries and lives in the controller
// firmware. We carry a minimal set of the highest-signal ones and
// fall back to "app_<id>" for the rest — names are nice but the
// numeric id is still useful as a stable identifier the LLM can
// quote.
const DPI_APP_NAMES: Record<number, string> = {
  // Common social / video / cloud bullies; the LLM can read these
  // names directly. For ids not in this table, the connector
  // returns "app_<id>" so the LLM at least has a token to anchor
  // on for follow-up queries (Cassandra can look up the number in
  // the UDM UI).
  0: 'unknown',
  7: 'http',
  133: 'apple',
  136: 'icloud',
  179: 'google',
  186: 'youtube',
  202: 'netflix',
  209: 'amazon',
  221: 'github',
  267: 'instagram',
  525: 'facebook',
};

function dpi_app_name(id: number | undefined): string {
  if (typeof id !== 'number') return 'unknown';
  return DPI_APP_NAMES[id] ?? `app_${id}`;
}

export const unifi_top_talkers: Tool<
  z.infer<typeof TopTalkersInput>,
  z.infer<typeof TopTalkersOutput>
> = {
  name: 'unifi_top_talkers',
  description:
    "Rank LAN clients by traffic volume. On modern controllers (Network 9/10.x) reads the v2 active-clients counters — `total_bytes` is the controller's long-lived cumulative usage per client (months-scale, NOT a time window, and often ≫ the per-association rx/tx also returned); no per-app breakdown there. Older controllers fall back to per-station DPI cumulative counters (with top-3 apps per client). Returns hostname + full MAC + rx/tx/total bytes per client plus the site-wide total and which `source` served it. Good for RELATIVE judgments (\"who's pulling the most?\" / \"is someone hogging?\"), not for \"how much this week\". For instantaneous rates use `unifi_topology`; for WAN-side connection attempts use `unifi_inbound_flows`.",
  risk: 'read',
  required_capabilities: ['read_unifi'],
  input_schema: TopTalkersInput,
  output_schema: TopTalkersOutput,

  idempotency_key(input) {
    return `unifi_top_talkers:${UNIFI_SITE}:${input.limit}`;
  },

  async execute(input, ctx: ToolContext) {
    const audit: ConnectorAuditCtx = {
      memory: ctx.memory,
      agent: ctx.specialist_id ?? 'specialist',
      intent_id: ctx.intent_id,
    };
    const now = Date.now();

    const baseline = {
      fetched_at_iso: new Date(now).toISOString(),
      site: UNIFI_SITE,
      total_bytes_all: 0,
      talkers: [] as Array<z.infer<typeof TopTalkerSchema>>,
    };

    // Modern path first: Network 9/10.x stopped populating the legacy
    // per-station DPI store (probed 2026-06-10 on 10.4.57: dpi.enabled
    // true, UI "Identification: Device and Traffic" on, stat/stadpi
    // still `data: []`). The v2 active-clients endpoint carries real
    // per-client rx/tx/usage counters instead.
    const v2_path =
      `/proxy/network/v2/api/site/${encodeURIComponent(UNIFI_SITE)}` +
      `/clients/active?includeTrafficUsage=true`;
    const v2 = await unifi_get<RawV2Client[]>(v2_path);
    if (v2.ok && Array.isArray(v2.data) && v2.data.length > 0) {
      const ranked_v2 = v2.data
        .filter((c) => c && typeof c.mac === 'string')
        .map((c): z.infer<typeof TopTalkerSchema> => {
          const rx = typeof c.rx_bytes === 'number' ? c.rx_bytes : 0;
          const tx = typeof c.tx_bytes === 'number' ? c.tx_bytes : 0;
          const usage = typeof c.usage_bytes === 'number' ? c.usage_bytes : rx + tx;
          return {
            hostname: c.name ?? c.hostname ?? c.display_name ?? null,
            mac: (c.mac ?? '').toLowerCase(),
            total_bytes: usage,
            rx_bytes: rx,
            tx_bytes: tx,
            top_apps: [],
          };
        })
        .sort((a, b) => b.total_bytes - a.total_bytes);
      const total_v2 = ranked_v2.reduce((s, r) => s + r.total_bytes, 0);
      const result = {
        ...baseline,
        total_bytes_all: total_v2,
        source: 'clients_v2',
        talkers: ranked_v2.slice(0, input.limit),
      };
      audit_connector(
        audit,
        'unifi_top_talkers',
        { limit: input.limit, source: 'clients_v2' },
        {
          talker_count: ranked_v2.length,
          total_bytes_all: total_v2,
          top5_redacted: ranked_v2.slice(0, 5).map((r) => ({
            hostname: r.hostname,
            mac_oui: redact_mac(r.mac),
            total_bytes: r.total_bytes,
          })),
        },
      );
      return result;
    }

    // Legacy path: per-station DPI counters (pre-9.x controllers).
    const path = `/proxy/network/api/s/${encodeURIComponent(UNIFI_SITE)}/stat/stadpi`;
    const res = await unifi_get<{ data?: RawDpiClientRow[] }>(path);

    if (!res.ok) {
      const result = {
        ...baseline,
        error: res.error ?? `HTTP ${res.status}`,
        hint:
          `unifi_top_talkers couldn't read the per-station DPI endpoint ` +
          `(${path}). Most likely the controller account lacks the right ` +
          `view-permission for DPI data — check the cassandra UDM user ` +
          `role under OS Settings → Admins. Falling back: ` +
          `\`unifi_topology\` carries cumulative-since-association byte ` +
          `counters per client (no DPI required) — good for the same ` +
          `class of "who is pulling traffic" question without DPI.`,
      };
      audit_connector(audit, 'unifi_top_talkers', { limit: input.limit }, result, result.error);
      return result;
    }

    const rows = (res.data?.data ?? []).filter((r) => r && typeof r.mac === 'string');

    if (rows.length === 0) {
      const result = {
        ...baseline,
        hint:
          `Both traffic stores came back empty: the v2 active-clients ` +
          `counters (Network 9/10.x) and the legacy per-station DPI ` +
          `endpoint. Either no clients are currently associated, or ` +
          `Traffic Identification is off — in the current UI that's ` +
          `Settings → ... → Identification, set to "Device and Traffic" ` +
          `(older UIs: Deep Packet Inspection). \`unifi_topology\` carries ` +
          `cumulative byte counters per client for a coarser "who is ` +
          `using what" picture in the meantime.`,
      };
      audit_connector(audit, 'unifi_top_talkers', { limit: input.limit }, { talker_count: 0, total_bytes_all: 0 });
      return result;
    }

    // Build per-client totals + top-3 apps.
    interface Acc {
      rx: number;
      tx: number;
      apps: Map<string, number>;
    }
    const by_mac = new Map<string, Acc>();
    for (const row of rows) {
      const mac = (row.mac ?? '').toLowerCase();
      if (!mac) continue;
      const prev = by_mac.get(mac) ?? { rx: 0, tx: 0, apps: new Map<string, number>() };
      for (const a of row.by_app ?? []) {
        const rx = typeof a.rx_bytes === 'number' ? a.rx_bytes : 0;
        const tx = typeof a.tx_bytes === 'number' ? a.tx_bytes : 0;
        prev.rx += rx;
        prev.tx += tx;
        const name = dpi_app_name(a.app);
        prev.apps.set(name, (prev.apps.get(name) ?? 0) + rx + tx);
      }
      by_mac.set(mac, prev);
    }

    // Backfill hostnames from /stat/sta — DPI doesn't carry them.
    const sta = await unifi_get<{ data?: RawClient[] }>(
      `/proxy/network/api/s/${encodeURIComponent(UNIFI_SITE)}/stat/sta`,
    );
    const hostname_by_mac = new Map<string, string>();
    if (sta.ok) {
      for (const c of sta.data?.data ?? []) {
        const m = (c.mac ?? '').toLowerCase();
        const name = c.hostname ?? c.name ?? null;
        if (m && name) hostname_by_mac.set(m, name);
      }
    }

    const ranked = [...by_mac.entries()]
      .map(([mac, v]): z.infer<typeof TopTalkerSchema> => ({
        hostname: hostname_by_mac.get(mac) ?? null,
        mac,
        total_bytes: v.rx + v.tx,
        rx_bytes: v.rx,
        tx_bytes: v.tx,
        top_apps: [...v.apps.entries()]
          .map(([app, bytes]) => ({ app, bytes }))
          .sort((a, b) => b.bytes - a.bytes)
          .slice(0, 3),
      }))
      .sort((a, b) => b.total_bytes - a.total_bytes);

    const total_bytes_all = ranked.reduce((s, r) => s + r.total_bytes, 0);
    const result = {
      ...baseline,
      total_bytes_all,
      source: 'dpi_legacy',
      talkers: ranked.slice(0, input.limit),
    };
    audit_connector(
      audit,
      'unifi_top_talkers',
      { limit: input.limit, source: 'dpi_legacy' },
      {
        talker_count: ranked.length,
        total_bytes_all,
        top5_redacted: ranked.slice(0, 5).map((r) => ({
          hostname: r.hostname,
          mac_oui: redact_mac(r.mac),
          total_bytes: r.total_bytes,
        })),
      },
    );
    return result;
  },
};

// ── unifi_inbound_flows ──────────────────────────────────────────────────
//
// The UDM's Flows log (v2 `traffic-flows`) is the connection-attempt
// ledger: every flow the gateway saw, with action (allowed/blocked),
// direction (incoming/outgoing/local), source ip + geo region, target
// port/service, protocol, and a risk grade. For the perimeter question
// "is anyone knocking from outside?" this is the primary source — on a
// typical WAN the incoming slice is thousands of blocked scanner probes
// a day (telnet, RDP, random high ports), which IS the honest answer.
//
// Probed live 2026-06-10 on UDM Pro / Network 10.4.57:
//   - POST only (GET → 405), and UniFi OS requires the X-CSRF-Token
//     header on proxied POSTs (unifi_post handles both).
//   - Filters are SINGULAR keys with ARRAY values: `direction:
//     ["incoming"]`, `action: ["blocked"]`. The plural forms are
//     silently ignored — easy trap, the response just looks unfiltered.
//   - Response is newest-first pages of 50 with `total_element_count`
//     display-capped at 10,000 — treat the total as ">= N" at the cap.
//
// Rollups (by action / top source regions / top target ports) are
// computed over the newest page, so they describe the freshest activity
// rather than the whole window — the description says so.

const FLOWS_PAGE_SIZE = 50;
const FLOWS_TOTAL_CAP = 10_000;

const InboundFlowsInput = z.object({
  /** Lookback window. */
  hours: z.number().int().min(1).max(168).default(24),
  /** Flow direction relative to the LAN. Default `incoming` — the
   *  "who's knocking from outside" slice. */
  direction: z.enum(['incoming', 'outgoing', 'local', 'all']).default('incoming'),
  /** Gateway verdict filter. Default `all` (blocked + allowed). */
  action: z.enum(['blocked', 'allowed', 'all']).default('all'),
  /** Max flow rows returned (newest first). */
  limit: z.number().int().min(1).max(50).default(20),
}).strict();

const FlowRowSchema = z.object({
  time_iso: z.string(),
  action: z.string(),
  direction: z.string(),
  src_ip: z.string().nullable(),
  /** ISO country code UniFi geo-tagged the source with (e.g. 'CN'). */
  src_region: z.string().nullable(),
  dst_ip: z.string().nullable(),
  dst_port: z.number().nullable(),
  service: z.string().nullable(),
  protocol: z.string().nullable(),
  risk: z.string().nullable(),
  /** UniFi's repeat counter for coalesced identical flows. */
  repeat_count: z.number().nullable(),
});

const InboundFlowsOutput = z.object({
  fetched_at_iso: z.string(),
  site: z.string(),
  window_hours: z.number(),
  direction: z.string(),
  action: z.string(),
  /** Matching flows in the window per the controller. Display-capped at
   *  10,000 — at the cap read it as "at least this many". */
  total_matching: z.number(),
  /** How many newest flows the rollups below were computed over. */
  analyzed: z.number(),
  by_action: z.record(z.string(), z.number()),
  top_source_regions: z.array(z.object({ region: z.string(), flows: z.number() })),
  top_target_ports: z.array(
    z.object({ port: z.number(), service: z.string(), flows: z.number() }),
  ),
  flows: z.array(FlowRowSchema),
  error: z.string().optional(),
  hint: z.string().optional(),
});

interface RawFlowEndpoint {
  ip?: string;
  port?: number;
  region?: string;
  domains?: string[];
  zone_name?: string;
}

interface RawFlow {
  action?: string;
  direction?: string;
  flow_end_time?: number;
  flow_start_time?: number;
  time?: number;
  source?: RawFlowEndpoint;
  destination?: RawFlowEndpoint;
  service?: string;
  protocol?: string;
  risk?: string;
  count?: number;
}

interface RawFlowsResponse {
  data?: RawFlow[];
  total_element_count?: number;
}

export const unifi_inbound_flows: Tool<
  z.infer<typeof InboundFlowsInput>,
  z.infer<typeof InboundFlowsOutput>
> = {
  name: 'unifi_inbound_flows',
  description:
    "Read the UDM's Flows log — the connection-attempt ledger. The default call ({} — all fields have defaults) answers \"is anyone knocking from outside?\": incoming WAN-side flows from the last 24h, each with source IP + country, target port + service, protocol, risk grade, and the gateway's verdict (blocked/allowed), plus rollups (counts by action, top source countries, top target ports) over the newest page. Thousands of blocked scanner probes per day is NORMAL on any WAN — the signal to escalate is allowed-incoming flows on unexpected ports, not the existence of blocked noise. Slice with `direction` ('incoming'|'outgoing'|'local'|'all'), `action` ('blocked'|'allowed'|'all'), `hours` (1-168). `total_matching` is display-capped at 10,000 by the controller. Requires UniFi Network 9.x+ (the Flows feature); for IDS/IPS signature alarms use `unifi_threat_events`.",
  risk: 'read',
  required_capabilities: ['read_unifi'],
  input_schema: InboundFlowsInput,
  output_schema: InboundFlowsOutput,

  idempotency_key(input) {
    return (
      `unifi_inbound_flows:${UNIFI_SITE}:${input.hours}:` +
      `${input.direction}:${input.action}:${input.limit}`
    );
  },

  async execute(input, ctx: ToolContext) {
    const audit: ConnectorAuditCtx = {
      memory: ctx.memory,
      agent: ctx.specialist_id ?? 'specialist',
      intent_id: ctx.intent_id,
    };
    const now = Date.now();
    const body: Record<string, unknown> = {
      start: now - input.hours * 3600 * 1000,
      end: now,
    };
    if (input.direction !== 'all') body.direction = [input.direction];
    if (input.action !== 'all') body.action = [input.action];

    const path =
      `/proxy/network/v2/api/site/${encodeURIComponent(UNIFI_SITE)}/traffic-flows`;
    const res = await unifi_post<RawFlowsResponse>(path, body);

    const baseline = {
      fetched_at_iso: new Date(now).toISOString(),
      site: UNIFI_SITE,
      window_hours: input.hours,
      direction: input.direction,
      action: input.action,
      total_matching: 0,
      analyzed: 0,
      by_action: {} as Record<string, number>,
      top_source_regions: [] as Array<{ region: string; flows: number }>,
      top_target_ports: [] as Array<{ port: number; service: string; flows: number }>,
      flows: [] as Array<z.infer<typeof FlowRowSchema>>,
    };

    if (!res.ok) {
      const result = {
        ...baseline,
        error: res.error ?? `HTTP ${res.status}`,
        hint:
          `unifi_inbound_flows couldn't read the v2 traffic-flows endpoint ` +
          `(${path}). Likely causes: (1) the controller predates the Flows ` +
          `feature (needs UniFi Network 9.x+) — fall back to ` +
          `\`unifi_threat_events\` for IDS/IPS signature alarms, which cover ` +
          `the malicious slice of inbound attempts; (2) a persistent 403 ` +
          `after the connector's re-login retry means the cassandra UDM ` +
          `account's role can't read Flows — check OS Settings → Admins.`,
      };
      audit_connector(
        audit,
        'unifi_inbound_flows',
        { hours: input.hours, direction: input.direction, action: input.action },
        result,
        result.error,
      );
      return result;
    }

    const raw_flows = (res.data?.data ?? []).filter((f) => f && typeof f === 'object');
    const total = res.data?.total_element_count ?? raw_flows.length;

    const by_action: Record<string, number> = {};
    const region_counts = new Map<string, number>();
    const port_counts = new Map<string, { port: number; service: string; flows: number }>();
    const rows: Array<z.infer<typeof FlowRowSchema>> = [];

    for (const f of raw_flows) {
      const action = f.action ?? 'unknown';
      by_action[action] = (by_action[action] ?? 0) + 1;
      const region = f.source?.region;
      if (region) region_counts.set(region, (region_counts.get(region) ?? 0) + 1);
      const port = f.destination?.port;
      if (typeof port === 'number') {
        const service = f.service ?? 'OTHER';
        const key = `${port}/${service}`;
        const prev = port_counts.get(key) ?? { port, service, flows: 0 };
        prev.flows += 1;
        port_counts.set(key, prev);
      }
      if (rows.length < input.limit) {
        const ts = f.flow_end_time ?? f.time ?? f.flow_start_time;
        rows.push({
          time_iso: typeof ts === 'number' ? new Date(ts).toISOString() : '',
          action,
          direction: f.direction ?? 'unknown',
          src_ip: f.source?.ip ?? null,
          src_region: f.source?.region ?? null,
          dst_ip: f.destination?.ip ?? null,
          dst_port: typeof port === 'number' ? port : null,
          service: f.service ?? null,
          protocol: f.protocol ?? null,
          risk: f.risk ?? null,
          repeat_count: typeof f.count === 'number' ? f.count : null,
        });
      }
    }

    const top_source_regions = [...region_counts.entries()]
      .map(([region, flows]) => ({ region, flows }))
      .sort((a, b) => b.flows - a.flows)
      .slice(0, 5);
    const top_target_ports = [...port_counts.values()]
      .sort((a, b) => b.flows - a.flows)
      .slice(0, 5);

    const result = {
      ...baseline,
      total_matching: total,
      analyzed: raw_flows.length,
      by_action,
      top_source_regions,
      top_target_ports,
      flows: rows,
      ...(total >= FLOWS_TOTAL_CAP
        ? {
            hint:
              `total_matching hit the controller's ${FLOWS_TOTAL_CAP} display ` +
              `cap — read it as "at least ${FLOWS_TOTAL_CAP}". Rollups cover ` +
              `the newest ${raw_flows.length} flows (page size ${FLOWS_PAGE_SIZE}).`,
          }
        : {}),
    };

    // Audit redaction: counts, regions, and ports only — no raw IPs and
    // no domains. Outgoing/local flows carry LAN client IPs + visited
    // domains, which stay in the tool RESULT (the read_unifi boundary)
    // and out of the audit log, mirroring the topology redaction split.
    audit_connector(
      audit,
      'unifi_inbound_flows',
      { hours: input.hours, direction: input.direction, action: input.action, limit: input.limit },
      {
        total_matching: total,
        analyzed: raw_flows.length,
        by_action,
        top_source_regions,
        top_target_ports,
      },
    );
    return result;
  },
};

// ── unifi_threat_events ──────────────────────────────────────────────────
//
// UDM's IDS / firewall alerts live at `/rest/alarm` on the firmware
// probed against (UDM Pro 10.4.57, 2026-05-27). The legacy `/stat/event`
// path returns 404 on this firmware. Each alarm row carries
// `time`, `key`, `subsystem`, `msg`, plus when IDS is on: `srcip`,
// `srcip_country`, `dstip`, `dstip_country`, `ips_id` /
// `event_type` (the threat signature), `severity`, `proto`. We surface
// those with country + signature aggregations so Cassandra can answer
// "anything from Russia/China today?" / "what triggered the IDS
// overnight?" deterministically.

const SEVERITY_VALUES = ['critical', 'major', 'minor', 'info'] as const;
const ThreatEventsInput = z.object({
  hours: z.number().int().min(1).max(24 * 7).default(24),
  severity: z.enum(SEVERITY_VALUES).optional(),
  /** ISO-3166 alpha-2 (e.g. "RU", "CN") — case-insensitive match
   *  against UniFi's `srcip_country` / `dstip_country` fields. */
  country_filter: z.string().min(2).max(2).optional(),
}).strict();

const ThreatEventSchema = z.object({
  ts_iso: z.string(),
  key: z.string(),
  msg: z.string(),
  /** Best-effort categorization derived from the UniFi key prefix:
   *  `ips` (IDS / threat-mgmt), `firewall` (FW_RULE drops), `gateway`
   *  (WAN-side events), or `other`. */
  category: z.enum(['ips', 'firewall', 'gateway', 'other']),
  severity: z.string().nullable(),
  src_ip: z.string().nullable(),
  src_country: z.string().nullable(),
  dst_ip: z.string().nullable(),
  dst_country: z.string().nullable(),
  /** UniFi's threat-name / signature when present (e.g. "ET POLICY ..."). */
  signature: z.string().nullable(),
});

const ThreatEventsOutput = z.object({
  fetched_at_iso: z.string(),
  site: z.string(),
  range_hours: z.number(),
  total_returned: z.number(),
  /** Bucketing for at-a-glance "is there a pattern?" — top 5 countries
   *  by event count, top 5 signatures by event count. Computed BEFORE
   *  any severity/country filter is applied so the LLM sees the full
   *  landscape and can decide whether to drill in. */
  countries_top: z.array(z.object({ country: z.string(), count: z.number() })),
  signatures_top: z.array(z.object({ signature: z.string(), count: z.number() })),
  events: z.array(ThreatEventSchema),
  error: z.string().optional(),
  hint: z.string().optional(),
});

interface RawAlarm {
  time?: number;
  /** Alarm key — typically `EVT_IPS_*`, `EVT_FW_*`, or controller
   *  subsystem alerts. Used for categorization. */
  key?: string;
  msg?: string;
  subsystem?: string;
  severity?: string;
  srcip?: string;
  /** UniFi enriches src/dst with country code when IDS is enabled
   *  and the IP is external. Field name on UDM firmware 10.4.x:
   *  `srcip_country`. May be absent for LAN-side IPs. */
  srcip_country?: string;
  dstip?: string;
  dstip_country?: string;
  /** IDS signature / threat name (e.g. "ET POLICY..."). UDM uses
   *  several field names across firmware: `ips_id`, `event_type`,
   *  `signature`, `app`. We read all four and fall back to the
   *  first non-empty. */
  ips_id?: string;
  event_type?: string;
  signature?: string;
  app?: string;
  proto?: string;
  archived?: boolean;
}

function categorize_alarm(key: string): 'ips' | 'firewall' | 'gateway' | 'other' {
  const k = key.toUpperCase();
  if (k.startsWith('EVT_IPS_') || k.includes('THREAT') || k.includes('IDS')) return 'ips';
  if (k.startsWith('EVT_FW_') || k.includes('FIREWALL')) return 'firewall';
  if (k.startsWith('EVT_GW_') || k.startsWith('EVT_WAN_')) return 'gateway';
  return 'other';
}

function alarm_signature(a: RawAlarm): string | null {
  const candidates = [a.ips_id, a.event_type, a.signature, a.app];
  for (const c of candidates) {
    if (typeof c === 'string' && c.length > 0) return c;
  }
  return null;
}

export const unifi_threat_events: Tool<
  z.infer<typeof ThreatEventsInput>,
  z.infer<typeof ThreatEventsOutput>
> = {
  name: 'unifi_threat_events',
  description:
    "Read the UDM alarms feed (`/rest/alarm`) filtered to security categories (IDS/IPS hits, firewall drops, gateway-level events). Requires Threat Management (IDS/IPS) enabled on the UDM — otherwise the IPS rows simply won't appear and you'll see only firewall/gateway events, or an empty feed entirely. Inputs: `hours` (1-168, default 24), optional `severity` filter, optional `country_filter` (ISO alpha-2 like 'RU' / 'CN' matched against UniFi's geo-enriched src/dst country fields). Output includes the matched events plus top-5 countries + top-5 signatures across the window (pre-filter) so the model can see the landscape before drilling.",
  risk: 'read',
  required_capabilities: ['read_unifi'],
  input_schema: ThreatEventsInput,
  output_schema: ThreatEventsOutput,

  idempotency_key(input) {
    return `unifi_threat_events:${UNIFI_SITE}:${input.hours}:${input.severity ?? '_'}:${input.country_filter?.toUpperCase() ?? '_'}`;
  },

  async execute(input, ctx: ToolContext) {
    const audit: ConnectorAuditCtx = {
      memory: ctx.memory,
      agent: ctx.specialist_id ?? 'specialist',
      intent_id: ctx.intent_id,
    };
    const now = Date.now();
    const within_ms = input.hours * 3600 * 1000;
    const start = now - within_ms;
    // `/rest/alarm` paginates via `_limit` / `_sort`; we cap at 500
    // for a 24h window. Sort newest-first so the slice we take is
    // the most-recent. The endpoint doesn't accept a `within` query
    // param — we filter by `time` client-side.
    const path =
      `/proxy/network/api/s/${encodeURIComponent(UNIFI_SITE)}/rest/alarm` +
      `?_limit=500&_sort=-time`;
    const res = await unifi_get<{ data?: RawAlarm[] }>(path);

    const baseline = {
      fetched_at_iso: new Date(now).toISOString(),
      site: UNIFI_SITE,
      range_hours: input.hours,
      total_returned: 0,
      countries_top: [] as Array<{ country: string; count: number }>,
      signatures_top: [] as Array<{ signature: string; count: number }>,
      events: [] as Array<z.infer<typeof ThreatEventSchema>>,
    };

    if (!res.ok) {
      const result = {
        ...baseline,
        error: res.error ?? `HTTP ${res.status}`,
        hint:
          `unifi_threat_events couldn't read the alarms feed at ${path}. ` +
          `Likely causes: (1) firmware endpoint shape differs — UDM 10.4.x ` +
          `serves alarms at /rest/alarm but older controllers used ` +
          `/stat/event; if this controller predates 10.x ask Beatrice to ` +
          `add a fallback. (2) controller credentials lack the right ` +
          `read-permission; check the cassandra UDM account role under ` +
          `OS Settings → Admins.`,
      };
      audit_connector(audit, 'unifi_threat_events', { hours: input.hours }, result, result.error);
      return result;
    }

    const all_alarms = res.data?.data ?? [];
    // Filter to security-shaped categories first.
    const security_only = all_alarms.filter((e) => {
      if (typeof e.key !== 'string') return false;
      const cat = categorize_alarm(e.key);
      return cat !== 'other';
    });
    // Filter by `start` (UDM's `within` param is sometimes inclusive
    // of partial events; clamp here to be safe).
    const in_window = security_only.filter((e) => {
      const t = typeof e.time === 'number' ? e.time : 0;
      return t >= start && t <= now;
    });

    // Aggregate top-5 countries + signatures over the full security
    // set BEFORE applying severity / country filters — so a
    // narrowed query still surfaces the landscape.
    const country_counts = new Map<string, number>();
    const signature_counts = new Map<string, number>();
    for (const e of in_window) {
      const src_c = (e.srcip_country ?? '').toUpperCase();
      const dst_c = (e.dstip_country ?? '').toUpperCase();
      if (src_c) country_counts.set(src_c, (country_counts.get(src_c) ?? 0) + 1);
      if (dst_c && dst_c !== src_c)
        country_counts.set(dst_c, (country_counts.get(dst_c) ?? 0) + 1);
      const sig = alarm_signature(e);
      if (sig) signature_counts.set(sig, (signature_counts.get(sig) ?? 0) + 1);
    }
    const countries_top = [...country_counts.entries()]
      .map(([country, count]) => ({ country, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5);
    const signatures_top = [...signature_counts.entries()]
      .map(([signature, count]) => ({ signature, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5);

    // Apply per-call filters.
    const country_match = input.country_filter?.toUpperCase() ?? null;
    const severity_match = input.severity ?? null;
    const filtered = in_window.filter((e) => {
      if (severity_match && e.severity !== severity_match) return false;
      if (country_match) {
        const src_c = (e.srcip_country ?? '').toUpperCase();
        const dst_c = (e.dstip_country ?? '').toUpperCase();
        if (src_c !== country_match && dst_c !== country_match) return false;
      }
      return true;
    });

    const events = filtered.slice(0, 50).map((e): z.infer<typeof ThreatEventSchema> => ({
      ts_iso: typeof e.time === 'number' ? new Date(e.time).toISOString() : '',
      key: e.key ?? 'EVT_UNKNOWN',
      msg: e.msg ?? '',
      category: categorize_alarm(e.key ?? ''),
      severity: e.severity ?? null,
      src_ip: e.srcip ?? null,
      src_country: (e.srcip_country ?? null)?.toUpperCase() ?? null,
      dst_ip: e.dstip ?? null,
      dst_country: (e.dstip_country ?? null)?.toUpperCase() ?? null,
      signature: alarm_signature(e),
    }));

    const result = {
      ...baseline,
      total_returned: events.length,
      countries_top,
      signatures_top,
      events,
      ...(in_window.length === 0
        ? {
            hint:
              `No security events in the last ${input.hours}h on this ` +
              `controller. Three legitimate explanations: (a) Threat ` +
              `Management (IDS/IPS) is enabled and nothing fired — ` +
              `this is the most common case on a quiet home network, ` +
              `and "0 events" IS the honest answer; (b) IDS is off ` +
              `(toggle at Settings → Security → Threat Management); ` +
              `(c) older alarms have aged out of UDM retention (~7-30 ` +
              `days depending on storage). Verify (b) once with the ` +
              `UI; after that "0 returned" is a real signal.`,
          }
        : {}),
    };
    audit_connector(
      audit,
      'unifi_threat_events',
      { hours: input.hours, severity: input.severity, country_filter: input.country_filter },
      {
        total_returned: events.length,
        countries_top,
        signatures_top,
        // Don't audit raw src_ip / dst_ip — those are external IPs but
        // we redact to /24 anyway to keep the audit-log discretion
        // boundary consistent across connectors.
        events_redacted: events.slice(0, 5).map((e) => ({
          ts_iso: e.ts_iso,
          key: e.key,
          category: e.category,
          severity: e.severity,
          src_country: e.src_country,
          dst_country: e.dst_country,
          src_subnet: e.src_ip ? redact_ip(e.src_ip) : null,
          dst_subnet: e.dst_ip ? redact_ip(e.dst_ip) : null,
        })),
      },
    );
    return result;
  },
};

// ── Protect bootstrap cache (camera id → name) ───────────────────────────
//
// /proxy/protect/api/bootstrap returns ~200KB of state including the full
// camera list. We cache the id→name map for 30 min — Protect cameras don't
// change names often, and re-fetching 200KB on every event query is wasteful.

interface ProtectCamera {
  id?: string;
  name?: string;
  state?: string;
  isConnected?: boolean;
  type?: string;
  mac?: string;
  // Non-empty when the camera has on-camera AI (G4+/AI line); empty/absent on
  // motion-only cameras (e.g. a G3 Instant).
  featureFlags?: { smartDetectTypes?: string[] };
}

type CameraInfo = { name: string; connected: boolean; has_smart_detect: boolean };
let camera_cache: Map<string, CameraInfo> | null = null;
let camera_cache_expires_at = 0;

async function get_camera_map(): Promise<Map<string, CameraInfo>> {
  if (camera_cache && Date.now() < camera_cache_expires_at) return camera_cache;
  const res = await unifi_get<{ cameras?: ProtectCamera[] }>('/proxy/protect/api/bootstrap');
  const map = new Map<string, CameraInfo>();
  if (res.ok && Array.isArray(res.data?.cameras)) {
    for (const c of res.data.cameras) {
      if (c.id) {
        map.set(c.id, {
          name: c.name ?? `(camera ${c.id.slice(0, 6)})`,
          connected: Boolean(c.isConnected),
          // On-camera smart (person/vehicle) detect — G4+/AI cams report a
          // non-empty smartDetectTypes; motion-only cams (G3 Instant) don't.
          has_smart_detect: (c.featureFlags?.smartDetectTypes?.length ?? 0) > 0,
        });
      }
    }
  }
  camera_cache = map;
  camera_cache_expires_at = Date.now() + 30 * 60 * 1000;
  return map;
}

/** Resolve a camera by id or case-insensitive name substring. Returns
 *  the canonical id + name, or null if no/ambiguous match. */
export async function resolve_camera(
  id_or_name: string,
): Promise<{ id: string; name: string; connected: boolean } | null> {
  const map = await get_camera_map();
  const direct = map.get(id_or_name);
  if (direct) return { id: id_or_name, name: direct.name, connected: direct.connected };
  const needle = id_or_name.toLowerCase();
  const hits = [...map.entries()].filter(([, v]) => v.name.toLowerCase().includes(needle));
  if (hits.length === 1) {
    const [hid, hv] = hits[0]!;
    return { id: hid, name: hv.name, connected: hv.connected };
  }
  return null;
}

/** Camera roster (id, name, connected) for the office + the camera_view
 *  tool's "did you mean" list on an ambiguous name. */
export async function list_cameras(): Promise<
  Array<{ id: string; name: string; connected: boolean }>
> {
  const map = await get_camera_map();
  return [...map.entries()].map(([id, v]) => ({ id, name: v.name, connected: v.connected }));
}

// ── Place-aware camera resolution (2026-07-30) ──────────────────────────────
//
// Born from a live failure: asked about the garage, Kate looked at both
// driveway cameras and asserted "the garage interior is blind" — while a
// connected Garage camera sat in Protect, Frigate AND home_map. Nothing in
// her turn carried the camera inventory, so a confident negative passed every
// guard (no evidence retrieved = nothing to contradict). These helpers make
// the inventory a first-class affordance of the tool itself: rosters come
// from the live call path, so they can never go stale. Pure functions —
// the tool passes live data in; smoke-camera-resolve pins the behavior.

export interface CameraRosterEntry {
  name: string;
  connected: boolean;
  /** home_map rooms this camera is assigned to cover ([] = unassigned). */
  rooms: string[];
}

type HomeMapRoomLite = { name: string; cameras?: string[] };

/** Join the Protect roster against the home_map overlay: what each camera
 *  covers, plus the mapped rooms with NO camera — the honest source for
 *  "do we have a camera in/on X?". */
export function camera_coverage(
  cameras: Array<{ name: string; connected: boolean }>,
  rooms: HomeMapRoomLite[],
): { roster: CameraRosterEntry[]; uncovered_rooms: string[] } {
  const roster = cameras.map((c) => ({
    name: c.name,
    connected: c.connected,
    rooms: rooms.filter((r) => (r.cameras ?? []).includes(c.name)).map((r) => r.name),
  }));
  const uncovered_rooms = rooms
    .filter((r) => (r.cameras ?? []).length === 0)
    .map((r) => r.name);
  return { roster, uncovered_rooms };
}

/** Resolve a free-text camera OR place query to a camera name. Ladder:
 *  exact/substring camera-name match (unique), then home_map room-name
 *  match → the room's assigned camera(s), preferring connected. Returns
 *  the winning camera, the candidate list when ambiguous, or null. */
export function resolve_place_to_camera(
  query: string,
  cameras: Array<{ name: string; connected: boolean }>,
  rooms: HomeMapRoomLite[],
): { camera: string } | { candidates: string[] } | null {
  const q = query.trim().toLowerCase();
  if (!q) return null;

  const name_hits = cameras.filter((c) => c.name.toLowerCase().includes(q));
  if (name_hits.length === 1) return { camera: name_hits[0]!.name };
  if (name_hits.length > 1) return { candidates: name_hits.map((c) => c.name) };

  const room_hits = rooms.filter((r) => {
    const rn = r.name.toLowerCase();
    return rn.includes(q) || q.includes(rn);
  });
  const assigned = new Set(room_hits.flatMap((r) => r.cameras ?? []));
  const known = cameras.filter((c) => assigned.has(c.name));
  if (known.length === 1) return { camera: known[0]!.name };
  if (known.length > 1) {
    const connected = known.filter((c) => c.connected);
    if (connected.length === 1) return { camera: connected[0]!.name };
    return { candidates: known.map((c) => c.name) };
  }
  return null;
}

export interface CameraSnapshot {
  ok: boolean;
  /** Absolute path to the saved JPEG on the orchestrator host (caller
   *  deletes it after the vision call). Null on error. */
  path: string | null;
  bytes: number;
  camera_id: string;
  camera_name: string;
  error?: string;
}

/**
 * Fetch a Protect camera's current JPEG to a temp file on the
 * orchestrator host and return its absolute path. The vision role takes
 * a host path (it transcodes/base64-encodes itself), so this is the
 * bridge between the camera feed and the VL model. Binary fetch — does
 * NOT go through `unifi_get` (that does res.json() and would corrupt the
 * image). The caller is responsible for deleting the temp file after the
 * vision call (a `finally` unlink, mirroring image_transcode's pattern).
 *
 * Probed live 2026-06-10 on UDM Pro: `cassandra` (view-only) pulls a
 * 640x360 image/jpeg from /proxy/protect/api/cameras/<id>/snapshot.
 */
export async function fetch_camera_snapshot(
  id_or_name: string,
  opts: { highQuality?: boolean } = {},
): Promise<CameraSnapshot> {
  const cam = await resolve_camera(id_or_name);
  if (!cam) {
    return {
      ok: false,
      path: null,
      bytes: 0,
      camera_id: '',
      camera_name: id_or_name,
      error: `no camera matched "${id_or_name}" (or the name was ambiguous)`,
    };
  }
  if (!cached_cookie || Date.now() > cookie_expires_at) {
    try {
      await login();
    } catch (err) {
      return {
        ok: false,
        path: null,
        bytes: 0,
        camera_id: cam.id,
        camera_name: cam.name,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
  // `?ts=` high-water defeats any edge cache; `force=true` asks Protect
  // for a fresh frame rather than the last-stored thumbnail. `highQuality`
  // requests the full-resolution still (the scene-grading callers leave it
  // off — 640x360 is plenty and cheaper; face enrollment turns it on for
  // the extra detail a recognizer needs).
  const url =
    `${UNIFI_HOST}/proxy/protect/api/cameras/${encodeURIComponent(cam.id)}` +
    `/snapshot?ts=${Date.now()}&force=true${opts.highQuality ? '&highQuality=true' : ''}`;
  let res: Response;
  try {
    res = await fetch(url, fetch_opts({ headers: { Cookie: cached_cookie! } }));
  } catch (err) {
    return {
      ok: false,
      path: null,
      bytes: 0,
      camera_id: cam.id,
      camera_name: cam.name,
      error: err instanceof Error ? err.message : String(err),
    };
  }
  if (!res.ok) {
    return {
      ok: false,
      path: null,
      bytes: 0,
      camera_id: cam.id,
      camera_name: cam.name,
      error: `snapshot HTTP ${res.status}`,
    };
  }
  const buf = Buffer.from(await res.arrayBuffer());
  const safe = cam.id.replace(/[^a-zA-Z0-9]/g, '').slice(0, 16);
  const path = join(tmpdir(), `hearth-cam-${safe}-${Date.now()}.jpg`);
  try {
    writeFileSync(path, buf);
  } catch (err) {
    return {
      ok: false,
      path: null,
      bytes: buf.length,
      camera_id: cam.id,
      camera_name: cam.name,
      error: `temp write failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  return { ok: true, path, bytes: buf.length, camera_id: cam.id, camera_name: cam.name };
}

/**
 * Fetch a Protect EVENT's keyframe — the frame captured AT the detection
 * moment — to a temp file. Unlike `fetch_camera_snapshot`, which pulls the
 * camera's CURRENT live frame, this returns what the camera saw when the
 * smart-detection fired, so a person who has since walked out of frame is
 * still present. That timing is the whole point for the face-sighting sweep:
 * a doorbell visitor is gone from the live frame by the time the 60s
 * awareness tick runs, but the event keyframe still holds their face.
 *
 * Protect renders a fixed-size thumbnail per event at
 * `/proxy/protect/api/events/<id>/thumbnail`. The `h` size param is honored
 * on some firmware and ignored on others (probed live 2026-06-15 on UDM Pro
 * 10.4.x: a fixed ~640px thumb regardless of `h`) — harmless either way.
 * Binary fetch — does NOT go through `unifi_get` (that does res.json() and
 * would corrupt the image). The caller deletes the temp file.
 *
 * Returns `ok:false` (so the caller falls back to the live snapshot) when the
 * event has no thumbnail yet, the body isn't an image, or the fetch fails —
 * it never throws.
 */
export async function fetch_event_keyframe(
  event_id: string,
  opts: { height?: number } = {},
): Promise<CameraSnapshot> {
  const fail = (error: string): CameraSnapshot => ({
    ok: false,
    path: null,
    bytes: 0,
    camera_id: '',
    camera_name: '',
    error,
  });
  if (!event_id) return fail('no event id');
  if (!cached_cookie || Date.now() > cookie_expires_at) {
    try {
      await login();
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  }
  const h = opts.height ?? 720;
  const url =
    `${UNIFI_HOST}/proxy/protect/api/events/${encodeURIComponent(event_id)}` +
    `/thumbnail?h=${h}`;
  let res: Response;
  try {
    res = await fetch(url, fetch_opts({ headers: { Cookie: cached_cookie! } }));
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
  if (!res.ok) return fail(`keyframe HTTP ${res.status}`);
  if (!(res.headers.get('content-type') ?? '').includes('image')) {
    return fail(`keyframe non-image (${res.headers.get('content-type') ?? '?'})`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length === 0) return fail('keyframe empty body');
  const safe = event_id.replace(/[^a-zA-Z0-9]/g, '').slice(0, 16);
  const path = join(tmpdir(), `hearth-kf-${safe}-${Date.now()}.jpg`);
  try {
    writeFileSync(path, buf);
  } catch (err) {
    return fail(`temp write failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  return { ok: true, path, bytes: buf.length, camera_id: '', camera_name: '' };
}

// ── unifi_protect_events ─────────────────────────────────────────────────

const ProtectEventsInput = z.object({
  /** ISO timestamp; default 24h ago. */
  since: z.string().optional(),
  /** Max events to return. */
  limit: z.coerce.number().int().positive().max(500).default(50),
  /** Filter by smart-detect type ("person","vehicle","package","animal"). */
  smart_type: z.string().min(1).optional(),
  /** Filter by camera name (case-insensitive substring). */
  camera_name_contains: z.string().min(1).optional(),
});

const ProtectEventSchema = z.object({
  id: z.string(),
  ts_iso: z.string(),
  end_iso: z.string().nullable(),
  type: z.string(),
  smart_types: z.array(z.string()),
  score: z.number().nullable(),
  camera_name: z.string(),
  camera_connected: z.boolean(),
  duration_s: z.number().nullable(),
});

const ProtectEventsOutput = z.object({
  fetched_at_iso: z.string(),
  window_start_iso: z.string(),
  events_count: z.number(),
  cameras_total: z.number(),
  cameras_offline: z.array(z.string()),
  events: z.array(ProtectEventSchema),
  error: z.string().optional(),
});

interface RawProtectEvent {
  id?: string;
  type?: string;
  start?: number;
  end?: number;
  score?: number;
  smartDetectTypes?: string[];
  camera?: string;
}

export const unifi_protect_events: Tool<
  z.infer<typeof ProtectEventsInput>,
  z.infer<typeof ProtectEventsOutput>
> = {
  name: 'unifi_protect_events',
  description:
    'Read the UniFi Protect detection timeline — motion, smart-detect (person/vehicle/package/animal), doorbell rings — across all cameras. This is the primary "what did the cameras see recently" feed for security review. Returns events newest-first since `since` (default 24h ago); optional `smart_type` and `camera_name_contains` filters. Also reports which cameras are currently offline.',
  risk: 'read',
  required_capabilities: ['read_unifi'],
  input_schema: ProtectEventsInput,
  output_schema: ProtectEventsOutput,

  idempotency_key(input) {
    const h = createHash('sha256');
    h.update(input.since ?? '');
    h.update(input.smart_type ?? '');
    h.update(input.camera_name_contains ?? '');
    h.update(String(input.limit));
    return `unifi_protect_events:${h.digest('hex').slice(0, 16)}`;
  },

  async execute(input, ctx: ToolContext) {
    const audit: ConnectorAuditCtx = {
      memory: ctx.memory,
      agent: ctx.specialist_id ?? 'specialist',
      intent_id: ctx.intent_id,
    };
    const now = new Date();
    const since_ms = input.since
      ? new Date(input.since).getTime()
      : now.getTime() - 24 * 60 * 60 * 1000;
    const window_start_iso = new Date(since_ms).toISOString();

    const cameras = await get_camera_map();
    const cameras_offline: string[] = [];
    for (const v of cameras.values()) {
      if (!v.connected) cameras_offline.push(v.name);
    }

    const params = new URLSearchParams({
      start: String(since_ms),
      limit: String(input.limit),
    });
    const res = await unifi_get<RawProtectEvent[]>(
      `/proxy/protect/api/events?${params}`,
    );
    if (!res.ok) {
      const result = {
        fetched_at_iso: now.toISOString(),
        window_start_iso,
        events_count: 0,
        cameras_total: cameras.size,
        cameras_offline,
        events: [],
        error: res.error ?? `HTTP ${res.status}`,
      };
      audit_connector(audit, 'unifi_protect_events', input, result, result.error);
      return result;
    }

    const raw_events = Array.isArray(res.data) ? res.data : [];
    const filter_lc = input.camera_name_contains?.toLowerCase();
    const smart_filter = input.smart_type?.toLowerCase();

    const events: z.infer<typeof ProtectEventSchema>[] = [];
    for (const ev of raw_events) {
      const cam = ev.camera ? cameras.get(ev.camera) : undefined;
      const camera_name = cam?.name ?? '(unknown camera)';
      if (filter_lc && !camera_name.toLowerCase().includes(filter_lc)) continue;
      const types = ev.smartDetectTypes ?? [];
      if (smart_filter && !types.map((t) => t.toLowerCase()).includes(smart_filter)) {
        continue;
      }
      const start = typeof ev.start === 'number' ? ev.start : 0;
      if (start < since_ms) continue;
      const end = typeof ev.end === 'number' ? ev.end : null;
      events.push({
        id: ev.id ?? '',
        ts_iso: new Date(start).toISOString(),
        end_iso: end ? new Date(end).toISOString() : null,
        type: ev.type ?? 'unknown',
        smart_types: types,
        score: typeof ev.score === 'number' ? ev.score : null,
        camera_name,
        camera_connected: cam?.connected ?? false,
        duration_s: end ? Math.round((end - start) / 1000) : null,
      });
    }

    const result = {
      fetched_at_iso: now.toISOString(),
      window_start_iso,
      events_count: events.length,
      cameras_total: cameras.size,
      cameras_offline,
      events,
    };
    audit_connector(audit, 'unifi_protect_events', input, {
      events_count: events.length,
      cameras_offline_count: cameras_offline.length,
    });
    return result;
  },
};

// ── unifi_security_snapshot ──────────────────────────────────────────────
//
// Synthesizes the readonly-accessible posture signals into one structured
// response: site health by subsystem, controller firmware + update
// availability, rogue-AP activity worth noticing (filtered to genuine
// flags, not the 300+ neighbor SSIDs), and bandwidth/latency snapshot.

const SnapshotInput = z.object({}).strict();

const SubsystemHealthSchema = z.object({
  subsystem: z.string(),
  status: z.string(),
  num_user: z.number().nullable(),
  num_guest: z.number().nullable(),
  num_iot: z.number().nullable(),
  wan_ip: z.string().nullable(),
  drops: z.number().nullable(),
  latency_ms: z.number().nullable(),
  uptime_s: z.number().nullable(),
});

const RogueApSchema = z.object({
  essid: z.string(),
  bssid_oui: z.string(),
  channel: z.number().nullable(),
  band: z.string().nullable(),
  signal_dbm: z.number().nullable(),
  security: z.string().nullable(),
  last_seen_iso: z.string().nullable(),
});

const SnapshotOutput = z.object({
  fetched_at_iso: z.string(),
  site: z.string(),
  controller: z.object({
    version: z.string().nullable(),
    console_version: z.string().nullable(),
    timezone: z.string().nullable(),
    update_available: z.boolean(),
    update_downloaded: z.boolean(),
    data_retention_days: z.number().nullable(),
  }),
  health: z.array(SubsystemHealthSchema),
  protect_cameras_total: z.number(),
  protect_cameras_offline: z.array(z.string()),
  rogue_aps_total: z.number(),
  rogue_aps_flagged: z.array(RogueApSchema),
  // UniFi dashboard reports cumulative bytes per 5-minute bucket;
  // we convert to Mbps. The raw byte counts are kept for callers
  // who want precision, but Mbps is what humans want to see.
  bandwidth: z.object({
    wan_rx_mbps_5min_avg: z.number().nullable(),
    wan_tx_mbps_5min_avg: z.number().nullable(),
    wan_rx_bytes_5min: z.number().nullable(),
    wan_tx_bytes_5min: z.number().nullable(),
    latency_avg_ms: z.number().nullable(),
    drop_rate_avg: z.number().nullable(),
  }),
  posture_findings: z.array(
    z.object({
      severity: z.enum(['low', 'medium', 'medium-high', 'high']),
      category: z.string(),
      summary: z.string(),
    }),
  ),
  error: z.string().optional(),
});

interface RawHealth {
  subsystem?: string;
  status?: string;
  num_user?: number;
  num_guest?: number;
  num_iot?: number;
  wan_ip?: string;
  drops?: number;
  latency?: number;
  uptime?: number;
}

interface RawSysinfo {
  version?: string;
  console_display_version?: string;
  timezone?: string;
  update_available?: boolean;
  update_downloaded?: boolean;
  data_retention_days?: number;
}

interface RawDashboardRow {
  'wan-rx_bytes'?: number;
  'wan-tx_bytes'?: number;
  latency_avg?: number;
  dropped_rate_avg?: number;
}

interface RawRogue {
  essid?: string;
  bssid?: string;
  channel?: number;
  band?: string;
  signal?: number;
  rssi?: number;
  security?: string;
  is_rogue?: boolean;
  last_seen?: number;
  age?: number;
}

export const unifi_security_snapshot: Tool<
  z.infer<typeof SnapshotInput>,
  z.infer<typeof SnapshotOutput>
> = {
  name: 'unifi_security_snapshot',
  description:
    'Synthesized network security snapshot: subsystem health (WAN/LAN/WLAN/VPN/WWW), controller firmware + update availability, rogue-AP detection (filtered to flagged ones, not neighbor noise), bandwidth/latency. Returns a posture_findings array of items worth surfacing. This is the primary periodic-sweep tool — call it on your awareness cadence to know "what is the current state of the network."',
  risk: 'read',
  required_capabilities: ['read_unifi'],
  input_schema: SnapshotInput,
  output_schema: SnapshotOutput,

  idempotency_key() {
    return `unifi_security_snapshot:${UNIFI_SITE}`;
  },

  async execute(_input, ctx: ToolContext) {
    const audit: ConnectorAuditCtx = {
      memory: ctx.memory,
      agent: ctx.specialist_id ?? 'specialist',
      intent_id: ctx.intent_id,
    };
    const now = new Date();
    const site = encodeURIComponent(UNIFI_SITE);

    const [health_res, sys_res, dash_res, rogue_res, cameras] = await Promise.all([
      unifi_get<{ data?: RawHealth[] }>(`/proxy/network/api/s/${site}/stat/health`),
      unifi_get<{ data?: RawSysinfo[] }>(`/proxy/network/api/s/${site}/stat/sysinfo`),
      unifi_get<{ data?: RawDashboardRow[] }>(`/proxy/network/api/s/${site}/stat/dashboard`),
      unifi_get<{ data?: RawRogue[] }>(`/proxy/network/api/s/${site}/stat/rogueap`),
      get_camera_map(),
    ]);

    const cameras_offline: string[] = [];
    for (const v of cameras.values()) {
      if (!v.connected) cameras_offline.push(v.name);
    }

    if (!health_res.ok) {
      const result = {
        fetched_at_iso: now.toISOString(),
        site: UNIFI_SITE,
        controller: {
          version: null,
          console_version: null,
          timezone: null,
          update_available: false,
          update_downloaded: false,
          data_retention_days: null,
        },
        health: [],
        protect_cameras_total: 0,
        protect_cameras_offline: [],
        rogue_aps_total: 0,
        rogue_aps_flagged: [],
        bandwidth: {
          wan_rx_mbps_5min_avg: null,
          wan_tx_mbps_5min_avg: null,
          wan_rx_bytes_5min: null,
          wan_tx_bytes_5min: null,
          latency_avg_ms: null,
          drop_rate_avg: null,
        },
        posture_findings: [],
        error: health_res.error ?? `HTTP ${health_res.status}`,
      };
      audit_connector(audit, 'unifi_security_snapshot', {}, result, result.error);
      return result;
    }

    const health = (health_res.data?.data ?? []).map((h): z.infer<typeof SubsystemHealthSchema> => ({
      subsystem: h.subsystem ?? 'unknown',
      status: h.status ?? 'unknown',
      num_user: typeof h.num_user === 'number' ? h.num_user : null,
      num_guest: typeof h.num_guest === 'number' ? h.num_guest : null,
      num_iot: typeof h.num_iot === 'number' ? h.num_iot : null,
      wan_ip: h.wan_ip ? redact_ip(h.wan_ip) : null,
      drops: typeof h.drops === 'number' ? h.drops : null,
      latency_ms: typeof h.latency === 'number' ? h.latency : null,
      uptime_s: typeof h.uptime === 'number' ? h.uptime : null,
    }));

    const sys = sys_res.data?.data?.[0] ?? {};
    const dash_rows = dash_res.data?.data ?? [];
    const latest_dash = dash_rows[dash_rows.length - 1] ?? {};

    // Filter rogue APs: only those flagged as rogue (UniFi's is_rogue
    // flag means "BSSID matches one of OURS but isn't ours" — the actual
    // security signal), AND only seen in the last 24h.
    const rogue_data = rogue_res.ok ? rogue_res.data?.data ?? [] : [];
    const day_ago_s = Date.now() / 1000 - 24 * 3600;
    const flagged_rogues = rogue_data
      .filter((r) => {
        if (!r.is_rogue) return false;
        const last = typeof r.last_seen === 'number' ? r.last_seen : 0;
        return last >= day_ago_s;
      })
      .slice(0, 20)
      .map((r): z.infer<typeof RogueApSchema> => ({
        essid: r.essid ?? '(hidden)',
        bssid_oui: redact_mac(r.bssid ?? ''),
        channel: typeof r.channel === 'number' ? r.channel : null,
        band: r.band ?? null,
        signal_dbm: typeof r.rssi === 'number' ? r.rssi : typeof r.signal === 'number' ? r.signal : null,
        security: r.security ?? null,
        last_seen_iso:
          typeof r.last_seen === 'number'
            ? new Date(r.last_seen * 1000).toISOString()
            : null,
      }));

    // Posture findings — synthesize from the data we have.
    const findings: z.infer<typeof SnapshotOutput>['posture_findings'] = [];
    if (sys.update_available) {
      findings.push({
        severity: 'medium',
        category: 'firmware_drift',
        summary: `Controller firmware update available (running ${sys.version ?? '?'})`,
      });
    }
    for (const h of health) {
      if (h.status === 'down' || h.status === 'error') {
        findings.push({
          severity: 'high',
          category: 'subsystem_down',
          summary: `Subsystem "${h.subsystem}" reports status="${h.status}"`,
        });
      } else if (h.status === 'warning') {
        findings.push({
          severity: 'medium',
          category: 'subsystem_warning',
          summary: `Subsystem "${h.subsystem}" reports status="warning"`,
        });
      }
    }
    if (flagged_rogues.length > 0) {
      findings.push({
        severity: 'medium-high',
        category: 'rogue_ap',
        summary: `${flagged_rogues.length} rogue AP(s) detected matching house BSSIDs in the last 24h`,
      });
    }
    if (cameras_offline.length > 0) {
      findings.push({
        severity: cameras_offline.length >= 2 ? 'medium-high' : 'medium',
        category: 'camera_offline',
        summary:
          cameras_offline.length === 1
            ? `Protect camera offline: ${cameras_offline[0]}`
            : `${cameras_offline.length} Protect cameras offline: ${cameras_offline.join(', ')}`,
      });
    }

    const result = {
      fetched_at_iso: now.toISOString(),
      site: UNIFI_SITE,
      controller: {
        version: sys.version ?? null,
        console_version: sys.console_display_version ?? null,
        timezone: sys.timezone ?? null,
        update_available: Boolean(sys.update_available),
        update_downloaded: Boolean(sys.update_downloaded),
        data_retention_days:
          typeof sys.data_retention_days === 'number' ? sys.data_retention_days : null,
      },
      health,
      protect_cameras_total: cameras.size,
      protect_cameras_offline: cameras_offline,
      rogue_aps_total: rogue_data.length,
      rogue_aps_flagged: flagged_rogues,
      bandwidth: (() => {
        const rx_bytes = typeof latest_dash['wan-rx_bytes'] === 'number' ? latest_dash['wan-rx_bytes'] : null;
        const tx_bytes = typeof latest_dash['wan-tx_bytes'] === 'number' ? latest_dash['wan-tx_bytes'] : null;
        // 5-min bucket = 300 seconds; bits/sec = bytes * 8 / 300; Mbps = / 1e6.
        const to_mbps = (b: number | null) =>
          b === null ? null : Math.round(((b * 8) / 300 / 1e6) * 10) / 10;
        return {
          wan_rx_mbps_5min_avg: to_mbps(rx_bytes),
          wan_tx_mbps_5min_avg: to_mbps(tx_bytes),
          wan_rx_bytes_5min: rx_bytes,
          wan_tx_bytes_5min: tx_bytes,
          latency_avg_ms: typeof latest_dash.latency_avg === 'number' ? latest_dash.latency_avg : null,
          drop_rate_avg: typeof latest_dash.dropped_rate_avg === 'number' ? latest_dash.dropped_rate_avg : null,
        };
      })(),
      posture_findings: findings,
    };
    audit_connector(audit, 'unifi_security_snapshot', {}, {
      health_count: health.length,
      cameras_offline_count: cameras_offline.length,
      rogue_aps_total: rogue_data.length,
      rogue_aps_flagged: flagged_rogues.length,
      findings_count: findings.length,
    });
    return result;
  },
};
