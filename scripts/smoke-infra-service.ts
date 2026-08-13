/**
 * smoke:infra-service — Phase B infra service mode.
 *
 * Three halves, all self-contained (injected fns, no docker/network/LLM):
 *  A. the ops-relay handler's READ-ANY / write-narrow split — list/inspect/logs
 *     are bearer-only (work for a NON-allowlisted name), restart stays allowlisted.
 *  B. Kate's owner-gated list_services / diagnose_service / restart_container.
 *  C. PATH GROUNDING (2026-07-25, the /opt/plex incident): every read carries the
 *     container's REAL compose origin from its own Docker labels, so an ops
 *     answer quotes a file that exists instead of inventing a directory — and a
 *     container with no compose labels says so instead of getting a guess.
 */
import { composeOriginFromLabels, makeHandler, type RelayConfig } from '../ops/ops-relay/relay';
import {
  derive_compose_grounding,
  make_infra_service_tools,
} from '../src/specialists/kate/tools/infra_service';

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
  // ── A. relay handler: read-any reads, allowlist-narrow writes ──────────────
  console.log('→ A. ops-relay READ-ANY / write-narrow');
  const cfg: RelayConfig = {
    token: 'secret',
    allowedServices: new Set(['radarr']), // ONLY radarr is restartable
    dockerSocket: '/tmp/fake.sock',
    list: async () => ({ ok: true, status: 200, containers: [{ name: 'plex', image: 'plex', state: 'running', status: 'Up 1h' }] }),
    inspect: async (s) => ({ ok: true, status: 200, detail: { name: s, image: 'x', state: 'exited', exit_code: 1 } }),
    fetchLogs: async () => ({ ok: true, status: 200, logs: 'LOGLINE\n' }),
    restart: async () => ({ ok: true, status: 204 }),
  };
  const handle = makeHandler(cfg);
  const auth = { authorization: 'Bearer secret' };
  const req = (path: string, init: RequestInit = {}) => handle(new Request('http://x' + path, init));

  ok((await (await req('/health')).json()).ok === true, '/health is open (no auth)');
  ok((await req('/containers')).status === 401, '/containers without a token → 401');
  ok((await req('/containers', { headers: { authorization: 'Bearer wrong' } })).status === 401, 'bad token → 401');
  const listRes = await req('/containers', { headers: auth });
  ok(listRes.status === 200 && (await listRes.json()).containers?.[0]?.name === 'plex', '/containers with bearer → 200 inventory');
  // plex is NOT on the allowlist — read-any means inspect + logs still work
  ok((await req('/inspect/plex', { headers: auth })).status === 200, '/inspect of a NON-allowlisted container → 200 (read-any)');
  ok((await req('/logs/plex?tail=10', { headers: auth })).status === 200, '/logs of a NON-allowlisted container → 200 (read-any)');
  ok((await req('/inspect/plex')).status === 401, '/inspect still needs a bearer');
  // restart stays NARROW
  const restartBody = (svc: string) => ({ method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ service: svc }) });
  ok((await req('/restart', restartBody('plex'))).status === 403, 'restart of a non-allowlisted container → 403 (write stays narrow)');
  ok((await req('/restart', restartBody('radarr'))).status < 400, 'restart of an ALLOWLISTED container → allowed');

  // ── B. Kate tools ──────────────────────────────────────────────────────────
  console.log('→ B. Kate infra tools');
  const audits: any[] = [];
  const memory = { log_action: (r: any) => (audits.push(r), 'a') };
  const ctx = (user: any, extra: any = {}) => ({ intent_id: 'i', specialist_id: 'kate', user, memory, ...extra }) as any;
  const OWNER = { id: 'jasper', tier: 'owner' };
  const NON = { id: 'sam', tier: 'household' };

  // The REAL the LLM host shape: plex is one of 45 services in /docker/docker-compose.yml;
  // parakeet was started with a bare `docker run` and has no compose labels at all.
  const PLEX_COMPOSE = {
    project: 'docker',
    service: 'plex',
    working_dir: '/docker',
    config_files: ['/docker/docker-compose.yml'],
  };
  const inspectByName: Record<string, any> = {
    plex: { ok: true, reason: 'ok', detail: { name: 'plex', image: 'p', state: 'exited', exit_code: 1, oom_killed: false, compose: PLEX_COMPOSE } },
    parakeet: { ok: true, reason: 'ok', detail: { name: 'parakeet', image: 'speaches', state: 'running', compose: null } },
    radarr: { ok: true, reason: 'ok', detail: { name: 'radarr', image: 'r', state: 'running', health: 'healthy' } },
    sonarr: { ok: true, reason: 'ok', detail: { name: 'sonarr', image: 's', state: 'running', health: 'unhealthy' } },
    lidarr: { ok: true, reason: 'ok', detail: { name: 'lidarr', image: 'l', state: 'restarting', restart_count: 7 } },
    ghost: { ok: false, reason: 'failed', extra: 'no such container "ghost"' },
  };
  const tools = make_infra_service_tools({
    list_fn: async () => ({ ok: true, reason: 'ok', containers: [
      { name: 'plex', image: 'p', state: 'exited', status: 'Exited (1)', compose: PLEX_COMPOSE },
      { name: 'radarr', image: 'r', state: 'running', status: 'Up 2h', compose: { ...PLEX_COMPOSE, service: 'radarr' } },
      { name: 'parakeet', image: 'speaches', state: 'running', status: 'Up 3d', compose: null },
    ] }),
    inspect_fn: async (s: string) => inspectByName[s] ?? inspectByName.ghost,
    logs_fn: async () => ({ ok: true, reason: 'ok', logs: 'panic: boom\n' }),
    restart_fn: async (s: string) => (s === 'radarr' ? { ok: true, reason: 'restarted' } : { ok: false, reason: 'not_allowed' }),
    configured_fn: () => true,
  });
  const T = Object.fromEntries(tools.map((t) => [t.name, t])) as Record<string, any>;

  console.log('  contract');
  ok(T.list_services!.required_capabilities?.includes('service_mode_infra') === true, 'list_services gated by service_mode_infra');
  ok(T.diagnose_service!.risk === 'read' && T.restart_container!.risk === 'write_internal', 'diagnose=read, restart=write_internal');

  console.log('  owner gate');
  ok((await T.list_services!.execute({}, ctx(NON))).owner_only === true, 'non-owner refused (list)');
  ok((await T.diagnose_service!.execute({ service: 'plex' }, ctx(NON))).owner_only === true, 'non-owner refused (diagnose)');
  ok((await T.restart_container!.execute({ service: 'plex' }, ctx(NON))).owner_only === true, 'non-owner refused (restart)');

  console.log('  list_services');
  const ls = await T.list_services!.execute({}, ctx(OWNER));
  ok(ls.available === true && ls.total === 3 && ls.running === 2 && ls.not_running === 1, 'inventory + running/not-running counts');

  console.log('  diagnose_service (headlines from real state)');
  ok((await T.diagnose_service!.execute({ service: 'plex' }, ctx(OWNER))).headline === 'DOWN — exited (code 1)', 'exited → DOWN headline');
  ok((await T.diagnose_service!.execute({ service: 'radarr' }, ctx(OWNER))).headline === 'up and healthy', 'running+healthy headline');
  ok((await T.diagnose_service!.execute({ service: 'sonarr' }, ctx(OWNER))).headline === 'running but UNHEALTHY', 'unhealthy headline');
  ok(/RESTART-LOOPING \(7/.test((await T.diagnose_service!.execute({ service: 'lidarr' }, ctx(OWNER))).headline ?? ''), 'restart-loop headline w/ count');
  const dplex = await T.diagnose_service!.execute({ service: 'plex' }, ctx(OWNER));
  ok(/panic: boom/.test(dplex.log_tail ?? ''), 'returns the REAL log tail for Kate to reason over');
  const dghost = await T.diagnose_service!.execute({ service: 'ghost' }, ctx(OWNER));
  ok(/no container named/.test(dghost.message ?? ''), 'unknown container → honest "no such container"');

  console.log('  restart_container (owner + allowlist at the relay)');
  ok((await T.restart_container!.execute({ service: 'radarr' }, ctx(OWNER))).ok === true, 'allowlisted restart succeeds');
  const rn = await T.restart_container!.execute({ service: 'plex' }, ctx(OWNER));
  ok(rn.ok === false && /allowlist/i.test(rn.message), 'non-allowlisted restart → honest allowlist message (write stays narrow)');

  console.log('  unwired relay degrades honestly');
  const unwired = make_infra_service_tools({ configured_fn: () => false });
  const U = Object.fromEntries(unwired.map((t) => [t.name, t])) as Record<string, any>;
  ok((await U.list_services!.execute({}, ctx(OWNER))).available === false, 'unwired → available:false, not a crash');

  // ── C. path grounding (the /opt/plex incident) ─────────────────────────────
  console.log('→ C. path grounding');

  console.log('  label parsing');
  ok(
    composeOriginFromLabels({
      'com.docker.compose.project': 'docker',
      'com.docker.compose.service': 'plex',
      'com.docker.compose.project.working_dir': '/docker',
      'com.docker.compose.project.config_files': '/docker/docker-compose.yml',
    })?.config_files?.[0] === '/docker/docker-compose.yml',
    'compose labels → the real config file path',
  );
  ok(
    composeOriginFromLabels({
      'com.docker.compose.project': 'p',
      'com.docker.compose.project.config_files': '/a/x.yml,/a/override.yml',
    })?.config_files?.length === 2,
    'multiple config_files split on comma (compose stamps them joined)',
  );
  ok(composeOriginFromLabels({ 'org.label-schema.name': 'x' }) === null, 'non-compose labels → null (bare docker run)');
  ok(composeOriginFromLabels(null) === null && composeOriginFromLabels(undefined) === null, 'no labels at all → null, no throw');

  console.log('  derive_compose_grounding');
  const g = derive_compose_grounding('plex', PLEX_COMPOSE, 45);
  ok(g.compose_managed === true && g.config_file === '/docker/docker-compose.yml', 'managed → the real compose file');
  ok(g.project_container_count === 45 && /45 containers/.test(g.blast_radius ?? ''), 'blast radius states the REAL container count');
  ok(
    g.commands.restart === 'docker compose -f /docker/docker-compose.yml restart plex',
    'restart command is scoped to the one service and names the file',
  );
  ok(
    Object.values(g.commands).every((c) => !/\bdown\b/.test(c)) && !!g.commands.recreate,
    'offers restart/recreate — never a teardown',
  );
  ok(
    Object.values(g.commands).every((c) => !/^cd\b|&&/.test(c)) && /walking UP/.test(g.note),
    'no `cd &&` form, and the note names the compose parent-walk hazard',
  );
  const bare = derive_compose_grounding('parakeet', null, null);
  ok(bare.compose_managed === false, 'no labels → compose_managed:false');
  ok(
    /bare `docker run`/.test(bare.note) && /no compose project and no compose file/.test(bare.note),
    'says explicitly that NO compose file exists — never a blank or a guess',
  );
  ok(bare.commands.restart === 'docker restart parakeet' && !bare.commands.recreate, 'unmanaged → plain docker restart only');
  const nofile = derive_compose_grounding('x', { project: 'p', service: 'x' }, 3);
  ok(nofile.commands.restart === 'docker restart x', 'compose project but no config_file → falls back to the plain verb, no invented path');

  console.log('  tools surface it');
  const dpx = await T.diagnose_service!.execute({ service: 'plex' }, ctx(OWNER));
  ok(dpx.compose?.config_file === '/docker/docker-compose.yml', 'diagnose_service returns the governing compose file');
  ok(dpx.compose?.project_container_count === 2, 'sibling count comes from the LIVE inventory (2 of 3 share the project)');
  const dpk = await T.diagnose_service!.execute({ service: 'parakeet' }, ctx(OWNER));
  ok(dpk.compose?.compose_managed === false, 'diagnose_service reports an unmanaged container honestly');
  ok(
    ls.compose_projects?.[0]?.project === 'docker' && ls.compose_projects?.[0]?.container_count === 2,
    'list_services groups by real compose project with counts',
  );
  ok(
    ls.compose_projects?.[0]?.config_file === '/docker/docker-compose.yml',
    'list_services carries each project\'s real compose file',
  );
  ok(ls.unmanaged_containers?.includes('parakeet') === true, 'list_services names the bare-`docker run` containers');
  ok(/no compose file/i.test(ls.path_grounding ?? ''), 'list_services path_grounding warns about the unmanaged set');

  console.log('  a REFUSED restart hands over a grounded command');
  const rn2 = await T.restart_container!.execute({ service: 'plex' }, ctx(OWNER));
  ok(
    rn2.manual_command === 'docker compose -f /docker/docker-compose.yml restart plex',
    'not-allowed → the real scoped command (the exact moment a path used to get invented)',
  );
  ok(/docker-compose\.yml/.test(rn2.message), '…and the message quotes it, so the reply has a grounded path to use');
  const unmanagedRestart = make_infra_service_tools({
    inspect_fn: async (s: string) => inspectByName[s] ?? inspectByName.ghost,
    restart_fn: async () => ({ ok: false, reason: 'not_allowed' as const }),
    configured_fn: () => true,
  });
  const RU = Object.fromEntries(unmanagedRestart.map((t) => [t.name, t])) as Record<string, any>;
  const rpk = await RU.restart_container!.execute({ service: 'parakeet' }, ctx(OWNER));
  ok(rpk.manual_command === 'docker restart parakeet', 'unmanaged refusal → `docker restart`, never a compose command');
  const brokenInspect = make_infra_service_tools({
    inspect_fn: async () => { throw new Error('relay down'); },
    restart_fn: async () => ({ ok: false, reason: 'not_allowed' as const }),
    configured_fn: () => true,
  });
  const BI = Object.fromEntries(brokenInspect.map((t) => [t.name, t])) as Record<string, any>;
  const rb = await BI.restart_container!.execute({ service: 'plex' }, ctx(OWNER));
  ok(rb.ok === false && rb.manual_command === 'docker restart plex', 'a THROWING inspect fails open to the safe plain verb');

  console.log(`\n${failed === 0 ? '✓' : '✗'} smoke:infra-service — ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main();
