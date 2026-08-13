/**
 * smoke:host-diag — open-ended host diagnostics with a bounded environment.
 *
 * Self-contained (injected fns, no docker/network/LLM). The security model here
 * is the SANDBOX SPEC, not a list of blessed commands — so this smoke's main job
 * is to assert every wall of `build_diag_spec` individually. If a wall is ever
 * silently dropped, this is what catches it.
 *
 * Also covers: the cordon shadowing (vault/library/db read as absent, so a raw
 * filesystem read can't bypass `private_to`), the secret-redaction net, the
 * relay endpoint's auth + fail-closed-when-unconfigured behaviour, and the
 * tool's owner gate + read-only intent check + audit contract.
 */
import {
  build_diag_spec,
  redact_secrets,
  makeHandler,
  DEFAULT_DIAG_DENY,
  type RelayConfig,
} from '../ops/ops-relay/relay';
import { make_host_diag_tools } from '../src/specialists/kate/tools/host_diag';

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string) {
  if (cond) {
    passed++;
    console.log('  ✓ ' + msg);
  } else {
    failed++;
    console.error('  ✗ ' + msg);
  }
}

async function main() {
  // ── A. the sandbox spec — every wall ───────────────────────────────────────
  console.log('→ A. sandbox walls (the actual security model)');
  const spec = build_diag_spec('cat /host/proc/driver/nvidia/version', {
    image: 'hearth:latest',
    deny: DEFAULT_DIAG_DENY,
  });
  const hc = spec.HostConfig as Record<string, any>;

  ok(hc.NetworkMode === 'none' && spec.NetworkDisabled === true, 'no network — nothing read can be exfiltrated');
  ok(hc.ReadonlyRootfs === true, 'container rootfs is read-only');
  ok((hc.Binds as string[]).includes('/:/host:ro'), 'host filesystem bound READ-ONLY at /host');
  ok(
    (hc.Binds as string[]).every((b) => b.endsWith(':ro')),
    'EVERY bind is :ro — no writable path into the host',
  );
  ok(Array.isArray(hc.CapDrop) && hc.CapDrop.includes('ALL'), 'all capabilities dropped');
  ok((hc.SecurityOpt as string[]).includes('no-new-privileges'), 'no-new-privileges set');
  ok(spec.User === '65534:65534', 'runs as nobody — Unix perms deny the whole credential surface');
  ok(hc.Memory === 512 * 1024 * 1024 && hc.PidsLimit === 256, 'memory + pid caps set');
  ok(hc.AutoRemove === false, 'AutoRemove off — logs are read BEFORE the container is removed');
  ok(Array.isArray(spec.Env) && (spec.Env as string[]).length === 0, 'no env passed in (no token leaks inward)');
  ok(
    Array.isArray(spec.Cmd) && (spec.Cmd as string[])[0] === '/bin/sh' && (spec.Cmd as string[])[2]!.includes('nvidia'),
    'command runs through a shell — pipes/globs work, which is what makes it open-ended',
  );

  console.log('  cordon shadowing (the denylist that matters)');
  const tmpfs = hc.Tmpfs as Record<string, string>;
  ok('/host/docker/hearth/vault' in tmpfs, 'vault shadowed — Sam/Kim private notes read as absent');
  ok('/host/docker/hearth/library' in tmpfs, 'library shadowed');
  ok('/host/docker/hearth/data' in tmpfs, 'data dir (hearth.db: audit log + conversations) shadowed');
  ok('/tmp' in tmpfs, 'a writable /tmp exists so a shell can actually run');
  const withFile = build_diag_spec('x', { image: 'i', deny: ['/docker/hearth/hearth.env'] });
  ok(
    ((withFile.HostConfig as any).Binds as string[]).includes('/dev/null:/host/docker/hearth/hearth.env:ro'),
    'a denied FILE is shadowed with /dev/null (dirs get tmpfs, files get /dev/null)',
  );
  const extended = build_diag_spec('x', { image: 'i', deny: [...DEFAULT_DIAG_DENY, '/srv/private'] });
  ok(
    '/host/srv/private' in ((extended.HostConfig as any).Tmpfs as Record<string, string>),
    'denylist is extendable without a code change (HEARTH_OPS_DIAG_DENY)',
  );
  ok(
    !('/hostrelative' in ((build_diag_spec('x', { image: 'i', deny: ['relative/path'] }).HostConfig as any).Tmpfs)),
    'a non-absolute deny entry is ignored, never mis-mounted',
  );

  // ── B. redaction net ───────────────────────────────────────────────────────
  console.log('→ B. secret redaction (catches what the mounts miss)');
  ok(!redact_secrets('token=ghp_abcdefghijklmnopqrstuvwxyz012345').includes('ghp_abcdefgh'), 'GitHub token redacted');
  ok(!redact_secrets('key: sk-abcdefghijklmnopqrstuvwx').includes('sk-abcdefghijkl'), 'sk- API key redacted');
  ok(redact_secrets('AKIAIOSFODNN7EXAMPLE').includes('[REDACTED aws key]'), 'AWS key id redacted');
  ok(
    redact_secrets('-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----').includes(
      '[REDACTED private key]',
    ),
    'PEM private key block redacted',
  );
  ok(
    redact_secrets('HEARTH_OPS_RELAY_TOKEN=s3cr3tvalue').includes('[REDACTED]') &&
      !redact_secrets('HEARTH_OPS_RELAY_TOKEN=s3cr3tvalue').includes('s3cr3tvalue'),
    'env-file KEY=VALUE shapes redacted by key name',
  );
  ok(
    redact_secrets('eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r').includes(
      '[REDACTED jwt]',
    ),
    'JWT redacted',
  );
  const benign = 'nvidia driver 580.173.02 / module 580.159.03\nfilesystem 12% used';
  ok(redact_secrets(benign) === benign, 'ordinary diagnostic output passes through untouched');

  // ── C. the relay endpoint ──────────────────────────────────────────────────
  console.log('→ C. relay endpoint');
  const base: RelayConfig = {
    token: 'secret',
    allowedServices: new Set(['radarr']),
    dockerSocket: '/tmp/fake.sock',
  };
  const post = (h: (r: Request) => Promise<Response>, body: unknown, auth = true) =>
    h(
      new Request('http://x/diag', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(auth ? { authorization: 'Bearer secret' } : {}) },
        body: JSON.stringify(body),
      }),
    );

  const offHandler = makeHandler(base); // no diag + no diagImage ⇒ disabled
  ok((await post(offHandler, { command: 'ls' })).status === 503, 'FAIL-CLOSED: no diag image configured → 503');

  let seen = '';
  const onHandler = makeHandler({
    ...base,
    diag: async (cmd) => ((seen = cmd), { ok: true, status: 200, output: 'DRIVER 580', exit_code: 0 }),
  });
  ok((await post(onHandler, { command: 'ls' }, false)).status === 401, 'no bearer → 401');
  const good = await post(onHandler, { command: 'cat /host/proc/driver/nvidia/version' });
  const goodBody = (await good.json()) as any;
  ok(good.status === 200 && goodBody.output === 'DRIVER 580' && goodBody.exit_code === 0, 'authed diag → output');
  ok(seen === 'cat /host/proc/driver/nvidia/version', 'command passed through verbatim (no rewriting)');
  ok((await post(onHandler, { command: '   ' })).status === 400, 'empty command → 400');
  ok((await post(onHandler, { command: 'x'.repeat(2500) })).status === 400, 'over-long command → 400');
  ok(
    (await post(onHandler, { command: 'ls' })).status === 200 &&
      (await (await post(makeHandler({ ...base, diag: async () => ({ ok: false, status: 500, error: 'boom' }) }), { command: 'ls' })).json() as any).error === 'boom',
    'a failing diag surfaces its error, not a crash',
  );
  const toHandler = makeHandler({
    ...base,
    diag: async () => ({ ok: false, status: 200, output: 'partial', timed_out: true }),
  });
  const toBody = (await (await post(toHandler, { command: 'sleep 999' })).json()) as any;
  ok(toBody.timed_out === true && toBody.output === 'partial', 'timeout returns partial output + timed_out flag');
  // /diag must not have widened the OTHER endpoints' gates.
  const restartRes = await onHandler(
    new Request('http://x/restart', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer secret' },
      body: JSON.stringify({ service: 'plex' }),
    }),
  );
  ok(restartRes.status === 403, 'restart is STILL allowlist-gated — /diag did not widen writes');

  // ── D. the tool ────────────────────────────────────────────────────────────
  console.log('→ D. diagnose_host tool');
  const audits: any[] = [];
  const memory = { log_action: (r: any) => (audits.push(r), 'a') };
  const ctx = (user: any) => ({ intent_id: 'i', specialist_id: 'kate', user, memory }) as any;
  const OWNER = { id: 'jasper', tier: 'owner' };
  const NON = { id: 'sam', tier: 'household' };

  let ran = '';
  const T = make_host_diag_tools({
    diag_fn: async (cmd: string) => ((ran = cmd), { ok: true, reason: 'ok' as const, output: 'NVRM 580.159.03', exit_code: 0 }),
    configured_fn: () => true,
  })[0]! as any;

  ok(T.name === 'diagnose_host' && T.risk === 'read', 'declared read-tier');
  ok(T.required_capabilities?.includes('service_mode_infra') === true, 'gated by service_mode_infra (no new token)');
  ok(T.volatile === true, 'volatile — a re-check must actually re-run');
  ok((await T.execute({ command: 'ls' }, ctx(NON))).owner_only === true, 'non-owner refused');

  const good2 = await T.execute({ command: 'cat /host/proc/driver/nvidia/version' }, ctx(OWNER));
  ok(good2.ok === true && good2.output === 'NVRM 580.159.03', 'owner gets the real output');
  ok(ran === 'cat /host/proc/driver/nvidia/version', 'the model\'s command reaches the relay unmodified');
  const arow = audits.find((a) => a.tool_name === 'diagnose_host');
  ok(arow?.tool_input?.command === 'cat /host/proc/driver/nvidia/version', 'command is audited');
  ok(
    typeof arow?.execution_result?.output_chars === 'number' && !('output' in (arow?.execution_result ?? {})),
    'OUTPUT is NOT audited (only its size) — the audit log is durable plaintext',
  );

  console.log('  read-only intent check (defense-in-depth)');
  for (const cmd of ['rm -rf /host/docker', 'docker compose down', 'reboot', 'modprobe -r nvidia']) {
    const r = await T.execute({ command: cmd }, ctx(OWNER));
    ok(r.refused === true && r.ok === false, `refuses a state-changing command: ${cmd.slice(0, 24)}`);
  }
  for (const cmd of ['cat /host/proc/meminfo', 'df -h /host', 'dmesg | tail -40', 'ls -l /host/usr/lib', 'systemctl status plex']) {
    const r = await T.execute({ command: cmd }, ctx(OWNER));
    ok(r.ok === true, `allows an observation: ${cmd.slice(0, 26)}`);
  }
  ok(
    audits.some((a) => a.execution_result?.refused === true),
    'a refusal is audited too (intent is on the record)',
  );

  console.log('  honest degradation');
  const unwired = make_host_diag_tools({ configured_fn: () => false })[0]! as any;
  ok((await unwired.execute({ command: 'ls' }, ctx(OWNER))).ok === false, 'no relay → honest failure, not a crash');
  const notEnabled = make_host_diag_tools({
    diag_fn: async () => ({ ok: false, reason: 'not_enabled' as const }),
    configured_fn: () => true,
  })[0]! as any;
  const ne = await notEnabled.execute({ command: 'ls' }, ctx(OWNER));
  ok(ne.ok === false && /switched off/i.test(ne.message), 'relay without diag enabled → says so plainly');
  const thrower = make_host_diag_tools({
    diag_fn: async () => ({ ok: false, reason: 'relay_unavailable' as const, detail: 'ECONNREFUSED' }),
    configured_fn: () => true,
  })[0]! as any;
  ok((await thrower.execute({ command: 'ls' }, ctx(OWNER))).ok === false, 'unreachable relay → honest failure');

  console.log(`\n${failed === 0 ? '✓' : '✗'} smoke:host-diag — ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main();
