/**
 * Smoke: hit the UniFi controller via the connector tools.
 * Validates auth, cookie cache, and all five tools end-to-end.
 *
 * Requires UNIFI_HOST / UNIFI_USERNAME / UNIFI_PASSWORD / UNIFI_SITE
 * in the environment (the systemd unit override has them; for
 * standalone runs, source the conf).
 *
 * Output policy (post-2026-05-27): the tool RESULTS carry full
 * identifiers (this is a debugging smoke for the human running it,
 * not for the audit_log) — privacy lives at the audit boundary, not
 * at the tool-return boundary, so Cassandra and any other read_unifi
 * holder gets real hostnames + MACs + IPs in chat. The smoke also
 * inspects the audit_log row written for unifi_topology and asserts
 * the redacted shape there.
 */
import { open_db } from '@memory/stores/structured';
import { MemoryClient } from '@memory/client';
import {
  unifi_topology,
  unifi_protect_events,
  unifi_security_snapshot,
  unifi_top_talkers,
  unifi_threat_events,
  unifi_inbound_flows,
} from '@connectors/unifi';

const DB_PATH = process.env.HEARTH_DB_PATH ?? './data/hearth.db';
const VAULT_ROOT =
  process.env.HEARTH_VAULT_ROOT ?? `${process.env.HOME}/vault-friday`;

const db = open_db(DB_PATH);
const memory = new MemoryClient({ vault_root: VAULT_ROOT, db });

const ctx = {
  memory,
  llm: null as unknown as never,
  now: new Date(),
  intent_id: 'smoke-unifi',
  specialist_id: 'cassandra',
};

async function main() {
  console.log(`UNIFI_HOST=${process.env.UNIFI_HOST}  USER=${process.env.UNIFI_USERNAME}  SITE=${process.env.UNIFI_SITE ?? 'default'}  INSECURE=${process.env.UNIFI_INSECURE ?? '(unset)'}`);
  console.log('');

  console.log('── unifi_topology ─────────────────────────────────');
  const t = await unifi_topology.execute({}, ctx);
  if (t.error) console.error('FAIL:', t.error);
  else {
    console.log(`  ${t.devices.length} devices, ${t.clients_total} clients (${t.clients_wired}W/${t.clients_wireless}wifi)`);
    for (const d of t.devices) {
      console.log(`    ${d.name.padEnd(24)} ${(d.model ?? '?').padEnd(8)} ${d.state.padEnd(12)} v${d.version ?? '?'} ${d.num_clients ?? '-'}cl`);
    }
    console.log(`  clients_sample (${t.clients_sample.length}):`);
    for (const c of t.clients_sample.slice(0, 10)) {
      const ident = (c.hostname ?? '(no hostname)').padEnd(22);
      const link = c.is_wired ? 'wired ' : 'wifi  ';
      const rx_mb = c.rx_bytes !== null ? (c.rx_bytes / 1_000_000).toFixed(1) : '-';
      const tx_mb = c.tx_bytes !== null ? (c.tx_bytes / 1_000_000).toFixed(1) : '-';
      console.log(`    ${ident} ${link} mac=${c.mac} ip=${c.ip ?? '-'} rx=${rx_mb}MB tx=${tx_mb}MB`);
    }
    // Redaction split assertion: tool result must NOT be redacted; the
    // audit row written for this call MUST be. Check the latest
    // audit_log entry the connector wrote.
    const audit_row = db
      .prepare(
        `SELECT tool_input, execution_result FROM audit_log
         WHERE tool_name = 'unifi_topology'
         ORDER BY ts DESC LIMIT 1`,
      )
      .get() as { tool_input: string; execution_result: string } | undefined;
    if (audit_row && t.clients_sample.length > 0) {
      const raw_mac = t.clients_sample[0]!.mac;
      const audit_blob = audit_row.tool_input + '\n' + audit_row.execution_result;
      const tool_has_full = raw_mac.length === 17 && raw_mac.includes(':') && !raw_mac.includes('xx');
      const audit_has_full = audit_blob.includes(raw_mac);
      console.log(
        `  redaction: tool_result=${tool_has_full ? 'FULL' : 'redacted'} ` +
          `audit_log=${audit_has_full ? 'LEAKS RAW' : 'redacted'} ` +
          `(want: tool=FULL audit=redacted)`,
      );
      if (!tool_has_full || audit_has_full) {
        console.error('  ✗ redaction layer is wrong — see assertion line above');
      } else {
        console.log('  ✓ redaction split correct: raw to caller, scrubbed to audit_log');
      }
    }
  }
  console.log('');

  console.log('── unifi_security_snapshot ────────────────────────');
  const s = await unifi_security_snapshot.execute({}, ctx);
  if (s.error) console.error('FAIL:', s.error);
  else {
    console.log(`  controller v${s.controller.version} console v${s.controller.console_version} tz=${s.controller.timezone} update=${s.controller.update_available} retention=${s.controller.data_retention_days}d`);
    console.log(`  health:`);
    for (const h of s.health) {
      console.log(`    ${h.subsystem.padEnd(6)} status=${h.status.padEnd(8)} wan_ip=${h.wan_ip ?? '-'}  users=${h.num_user ?? '-'}  guest=${h.num_guest ?? '-'}  drops=${h.drops ?? '-'}  latency=${h.latency_ms ?? '-'}ms`);
    }
    console.log(`  rogue_aps_total=${s.rogue_aps_total} flagged=${s.rogue_aps_flagged.length}`);
    for (const r of s.rogue_aps_flagged.slice(0, 5)) {
      console.log(`    ${r.essid.padEnd(20)} ${r.bssid_oui} ch=${r.channel} sig=${r.signal_dbm}dbm sec=${r.security ?? '-'}`);
    }
    console.log(`  bandwidth: rx=${s.bandwidth.wan_rx_mbps_5min_avg}mbps tx=${s.bandwidth.wan_tx_mbps_5min_avg}mbps latency=${s.bandwidth.latency_avg_ms}ms drop_rate=${s.bandwidth.drop_rate_avg}`);
    console.log(`  posture_findings (${s.posture_findings.length}):`);
    for (const f of s.posture_findings) {
      console.log(`    [${f.severity}] (${f.category}) ${f.summary}`);
    }
  }
  console.log('');

  console.log('── unifi_top_talkers (top 10 by DPI cumulative) ──');
  const tt = await unifi_top_talkers.execute({ limit: 10 }, ctx);
  if (tt.error) console.error('FAIL:', tt.error, tt.hint ? `\n  hint: ${tt.hint}` : '');
  else {
    const total_gb = (tt.total_bytes_all / 1_000_000_000).toFixed(2);
    console.log(`  ${tt.talkers.length} talkers ranked; site total ${total_gb} GB (cumulative since DPI enabled)`);
    for (const r of tt.talkers) {
      const total_mb = (r.total_bytes / 1_000_000).toFixed(1);
      const rx_mb = (r.rx_bytes / 1_000_000).toFixed(1);
      const tx_mb = (r.tx_bytes / 1_000_000).toFixed(1);
      const apps = r.top_apps.map((a) => `${a.app}=${(a.bytes / 1_000_000).toFixed(1)}MB`).join(', ');
      console.log(`    ${(r.hostname ?? r.mac).padEnd(28)} total=${total_mb}MB rx=${rx_mb}MB tx=${tx_mb}MB`);
      if (apps) console.log(`      top apps: ${apps}`);
    }
    if (tt.hint) console.log(`  hint: ${tt.hint}`);
  }
  console.log('');

  console.log('── unifi_threat_events (last 24h) ────────────────');
  const te = await unifi_threat_events.execute({ hours: 24 }, ctx);
  if (te.error) console.error('FAIL:', te.error, te.hint ? `\n  hint: ${te.hint}` : '');
  else {
    console.log(`  ${te.total_returned} threat-shaped events in last ${te.range_hours}h`);
    if (te.countries_top.length) {
      console.log('  countries_top:', te.countries_top.map((c) => `${c.country}=${c.count}`).join(', '));
    }
    if (te.signatures_top.length) {
      console.log('  signatures_top:');
      for (const s of te.signatures_top) console.log(`    ${s.count}x ${s.signature}`);
    }
    for (const ev of te.events.slice(0, 10)) {
      const route = `${ev.src_ip ?? '-'} (${ev.src_country ?? '-'}) → ${ev.dst_ip ?? '-'} (${ev.dst_country ?? '-'})`;
      console.log(`    ${ev.ts_iso} [${ev.category}/${ev.severity ?? '-'}] ${ev.key}  ${route}`);
      if (ev.signature) console.log(`      sig: ${ev.signature}`);
    }
    if (te.hint) console.log(`  hint: ${te.hint}`);
  }
  console.log('');

  console.log('── unifi_inbound_flows (last 24h, incoming) ──────');
  const fl = await unifi_inbound_flows.execute(
    { hours: 24, direction: 'incoming', action: 'all', limit: 10 },
    ctx,
  );
  if (fl.error) console.error('FAIL:', fl.error, fl.hint ? `\n  hint: ${fl.hint}` : '');
  else {
    console.log(
      `  ${fl.total_matching} matching flows in ${fl.window_hours}h ` +
        `(rollups over newest ${fl.analyzed}); by_action: ` +
        Object.entries(fl.by_action).map(([a, n]) => `${a}=${n}`).join(', '),
    );
    if (fl.top_source_regions.length) {
      console.log('  top_source_regions:', fl.top_source_regions.map((r) => `${r.region}=${r.flows}`).join(', '));
    }
    if (fl.top_target_ports.length) {
      console.log('  top_target_ports:', fl.top_target_ports.map((p) => `${p.port}/${p.service}=${p.flows}`).join(', '));
    }
    for (const f of fl.flows) {
      console.log(
        `    ${f.time_iso} ${f.action.padEnd(8)} ${(f.src_ip ?? '-').padEnd(16)} ` +
          `${(f.src_region ?? '-').padEnd(3)} → :${f.dst_port ?? '-'} ${f.service ?? '-'} risk=${f.risk ?? '-'}`,
      );
    }
    if (fl.hint) console.log(`  hint: ${fl.hint}`);
    // Audit redaction assertion: the audit row must carry rollups only —
    // never a raw flow IP (outgoing/local flows would leak LAN clients).
    const flow_audit = db
      .prepare(
        `SELECT tool_input, execution_result FROM audit_log
         WHERE tool_name = 'unifi_inbound_flows'
         ORDER BY ts DESC LIMIT 1`,
      )
      .get() as { tool_input: string; execution_result: string } | undefined;
    const first_ip = fl.flows.find((f) => f.src_ip)?.src_ip;
    if (flow_audit && first_ip) {
      const audit_blob = flow_audit.tool_input + '\n' + flow_audit.execution_result;
      if (audit_blob.includes(first_ip)) {
        console.error('  ✗ audit row leaks a raw flow IP — redaction is wrong');
      } else {
        console.log('  ✓ redaction split correct: raw flows to caller, rollups-only to audit_log');
      }
    }
  }
  console.log('');

  console.log('── unifi_protect_events (last 24h, up to 25) ─────');
  const e = await unifi_protect_events.execute({ limit: 25 }, ctx);
  if (e.error) console.error('FAIL:', e.error);
  else {
    console.log(`  ${e.events_count} events; ${e.cameras_total} cameras total, ${e.cameras_offline.length} offline`);
    if (e.cameras_offline.length) console.log(`  offline cameras: ${e.cameras_offline.join(', ')}`);
    for (const ev of e.events.slice(0, 25)) {
      const types = ev.smart_types.length ? ` [${ev.smart_types.join('+')}]` : '';
      console.log(`    ${ev.ts_iso} ${ev.type.padEnd(20)} ${ev.camera_name.padEnd(22)} score=${ev.score ?? '-'} dur=${ev.duration_s ?? '-'}s${types}`);
    }
  }

  db.close();
}

main().catch((err) => { console.error('smoke crashed:', err); process.exit(1); });
