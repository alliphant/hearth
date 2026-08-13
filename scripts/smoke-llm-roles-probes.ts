/**
 * smoke-llm-roles-probes — the probe-outlives-endpoint guard.
 *
 * Twice now a health probe kept watching an LLM endpoint after its role
 * moved (forza :8096 on 2026-07-30; the retired :8203 VL unit on
 * 2026-08-14 — a night of manufactured DOWN alerts and an owner
 * escalation for a healthy tier). system_health.ts's own doctrine says
 * "when you move a role's endpoint, move its DependencyDef in the same
 * change" — this smoke makes that doctrine a failing check instead of a
 * comment.
 *
 * Contract:
 *   1. Every LLM-TIER DependencyDef (LLM_TIER_DEPS below) whose probe
 *      targets host.docker.internal:<port> must point at a port some
 *      llm-roles.yaml base_url actually uses. A probe on a port no role
 *      references = the registry is watching a retired node → FAIL.
 *   2. Every distinct llm-roles base_url port with NO covering probe is
 *      printed as a warning (coverage gap, not an error — some lanes are
 *      deliberately audit-only).
 *
 *   bun run scripts/smoke-llm-roles-probes.ts
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { DEPENDENCIES } from '@core/system_health';

// Deps that watch an LLM inference lane. Add the name here when a new
// tier gains a DependencyDef — that opts it into check 1.
const LLM_TIER_DEPS = new Set(['vision']);

const roles_path = resolve(
  process.cwd(),
  process.env.HEARTH_LLM_ROLES_PATH ?? 'config/llm-roles.yaml',
);
const roles_raw = parseYaml(readFileSync(roles_path, 'utf-8')) as Record<
  string,
  unknown
>;

// Collect host.docker.internal ports per ROLE NAME (the object key whose
// value carries the base_url), walking generically so nesting shape
// changes don't blind us.
const role_ports = new Set<string>();
const port_by_role = new Map<string, string>();
(function walk(node: unknown, key: string | null): void {
  if (Array.isArray(node)) return node.forEach((v) => walk(v, key));
  if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (k === 'base_url' && typeof v === 'string') {
        const m = v.match(/^https?:\/\/host\.docker\.internal:(\d+)/);
        if (m) {
          role_ports.add(m[1]!);
          if (key) port_by_role.set(key, m[1]!);
        }
      } else walk(v, k);
    }
  }
})(roles_raw, null);
assert.ok(role_ports.size > 0, `no host.docker.internal base_urls found in ${roles_path}`);

// Check 1 — each LLM-tier probe must match its role. When a role with the
// same NAME exists, the probe port must EQUAL that role's port (the exact
// contract that failed twice); otherwise fall back to "some role uses it".
const failures: string[] = [];
const probed_ports = new Set<string>();
for (const dep of DEPENDENCIES) {
  const url = dep.probe?.default_url ?? '';
  const m = url.match(/^https?:\/\/host\.docker\.internal:(\d+)/);
  if (!m) continue;
  probed_ports.add(m[1]!);
  if (!LLM_TIER_DEPS.has(dep.name)) continue;
  const named_port = port_by_role.get(dep.name);
  if (named_port !== undefined) {
    if (named_port !== m[1]) {
      failures.push(
        `DependencyDef '${dep.name}' probes :${m[1]} but the '${dep.name}' role's base_url is :${named_port} — ` +
          `the probe and the role disagree. Move the DependencyDef with the role.`,
      );
    }
  } else if (!role_ports.has(m[1]!)) {
    failures.push(
      `DependencyDef '${dep.name}' probes :${m[1]} but no llm-roles base_url uses that port — ` +
        `the probe outlived its endpoint. Move the DependencyDef with the role.`,
    );
  }
}
assert.ok(failures.length === 0, failures.join('\n'));

// Check 2 — roles without any probe coverage (warning only).
for (const port of role_ports) {
  if (!probed_ports.has(port)) {
    console.warn(
      `warn: llm-roles references host.docker.internal:${port} with no DependencyDef probe — ` +
        `tier outages there surface only via audit error-rates.`,
    );
  }
}

console.log(
  `smoke-llm-roles-probes: OK (${role_ports.size} role port(s), ${LLM_TIER_DEPS.size} tier probe(s) verified)`,
);
