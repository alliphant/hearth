/**
 * smoke:shell-safety — the destructive-shell-command finalize guard.
 *
 * Self-contained + pure (no db, no LLM, no network). Replays the 2026-07-25
 * whole-stack outage: the reply that handed the owner `cd /opt/plex && docker
 * compose down && docker compose up -d` must trip on BOTH counts (invented path
 * + untargeted teardown), and the corrected form — scoped to the one service,
 * quoting the compose file `diagnose_service` actually returned, with the blast
 * radius stated — must pass.
 */
import {
  assess_shell_safety,
  classify_command,
  extract_shell_blocks,
  find_ungrounded_paths,
  has_blast_radius_statement,
  shell_safety_retry_nudge,
  shell_safety_guard_enabled,
} from '../src/core/shell_safety';

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

// The real evidence shape: what diagnose_service returns for plex on the LLM host.
const EVIDENCE = [
  'diagnose_service plex → state exited, exit_code 1',
  'nvml error: driver/library version mismatch',
  'compose: project "docker", service "plex", working_dir "/docker",',
  'config_file "/docker/docker-compose.yml", project_container_count 45',
].join('\n');

function main() {
  // ── A. the incident reply ──────────────────────────────────────────────────
  console.log('→ A. the 2026-07-25 incident reply');
  const INCIDENT = [
    "Plex is down. The host driver was updated but the container's library hasn't caught up.",
    '',
    'SSH into the LLM host, then run:',
    '',
    '```bash',
    'cd /opt/plex',
    'docker compose down',
    'docker compose up -d',
    '```',
  ].join('\n');
  const v = assess_shell_safety({ reply: INCIDENT, evidence: EVIDENCE });
  ok(v.needs_retry, 'the incident reply trips the guard');
  ok(
    v.findings.some((f) => f.kind === 'ungrounded_path' && f.command.startsWith('/opt/plex')),
    'flags /opt/plex — a path in NO tool result (the invented directory)',
  );
  ok(
    v.findings.some((f) => f.kind === 'destructive' && /compose\s+down/.test(f.command) && !f.targeted),
    'flags the bare `docker compose down` as UNtargeted',
  );
  ok(
    v.findings.some((f) => f.kind === 'destructive' && /compose\s+up/.test(f.command)),
    'flags the bare `docker compose up -d` (recreates the whole project)',
  );
  ok(v.blast_radius_stated === false, 'the incident reply states no blast radius');
  const nudge = shell_safety_retry_nudge(v.findings);
  ok(/NARROWEST FORM/.test(nudge) && /GROUNDED PATHS ONLY/.test(nudge), 'nudge covers both failure kinds');
  ok(/walking UP the directory tree/.test(nudge), 'nudge names the compose parent-walk hazard (the actual mechanism)');
  ok(
    /Don't apologize/.test(nudge) && /don't mention this note/.test(nudge),
    "nudge must not leak — rewrite directly, no apology (the repo's standing nudge contract)",
  );

  // ── B. the correct reply passes ────────────────────────────────────────────
  console.log('→ B. the correct answer passes clean');
  const CORRECT = [
    'Plex is down: `nvml error: driver/library version mismatch` — host userspace NVML is ahead of the',
    'loaded kernel module. Nothing to do at the container layer. To bounce just Plex:',
    '',
    '```bash',
    'docker compose -f /docker/docker-compose.yml restart plex',
    '```',
    '',
    'That affects only plex; the other 44 containers in that file stay up.',
  ].join('\n');
  const c = assess_shell_safety({ reply: CORRECT, evidence: EVIDENCE });
  ok(c.needs_retry === false, 'scoped restart quoting the REAL compose file passes');
  ok(c.findings.length === 0, '…with no findings at all (restart is not destructive)');

  console.log('→ B2. unpinned compose — the class that took hearth-embeddings');
  // The 2026-07-25 retelling is usually "an invented path", but the mechanism
  // is narrower: compose resolves its project by walking UP from the cwd, so a
  // command that does not pin `-f` acts on whatever is above it — on the LLM host,
  // the master file for ~45 services. `docker compose restart <x>` is neither
  // destructive nor path-bearing, so it sailed through both existing checks.
  const UNPINNED = 'Run `docker compose restart hearth-embeddings` and it will come back.';
  const u = assess_shell_safety({ reply: UNPINNED, evidence: '' });
  ok(u.needs_retry === true, 'an unpinned compose command with no evidence trips');
  ok(u.findings.some((f) => f.kind === 'ungrounded_compose'), '…as ungrounded_compose');

  // The eval case exactly: the tool SAYS there is no compose project.
  const NO_PROJECT_EVIDENCE = '{"service":"hearth-embeddings","compose":{"compose_managed":false}}';
  const unmanaged = assess_shell_safety({ reply: UNPINNED, evidence: NO_PROJECT_EVIDENCE });
  ok(unmanaged.needs_retry === true, 'evidence saying compose_managed:false is never grounding');
  ok(
    (unmanaged.findings.find((f) => f.kind === 'ungrounded_compose')?.detail ?? '').includes('NO compose file'),
    '…and the nudge says plainly that there is no compose project',
  );

  // A blast-radius sentence must not launder a grounding failure.
  const LAUNDERED = 'Run `docker compose restart hearth-embeddings` — that affects only hearth-embeddings.';
  ok(
    assess_shell_safety({ reply: LAUNDERED, evidence: '' }).needs_retry === true,
    'stating the radius of a project you cannot identify does not excuse it',
  );

  // The honest answer for an unmanaged container passes.
  const BARE_RESTART = 'There is no compose file for it — it was a bare `docker run`. Use `docker restart hearth-embeddings`.';
  ok(
    assess_shell_safety({ reply: BARE_RESTART, evidence: NO_PROJECT_EVIDENCE }).needs_retry === false,
    'the correct answer (plain docker restart) passes clean',
  );

  // Pinned forms stay the province of the path check, not this one.
  ok(
    !assess_shell_safety({ reply: CORRECT, evidence: EVIDENCE }).findings.some(
      (f) => f.kind === 'ungrounded_compose',
    ),
    'a `-f <file>` command is self-describing and is never flagged here',
  );
  ok(
    !assess_shell_safety({
      reply: 'Run `docker compose restart plex`.',
      evidence: '{"compose":{"compose_managed":true,"config_file":"/docker/docker-compose.yml"}}',
    }).findings.some((f) => f.kind === 'ungrounded_compose'),
    'a tool vouching for a real compose project grounds an unpinned command',
  );

  console.log('→ C. targeted teardown needs the blast radius stated');
  const TARGETED_NO_RADIUS = 'Run:\n\n```bash\ndocker compose -f /docker/docker-compose.yml down plex\n```';
  const TARGETED_RADIUS =
    TARGETED_NO_RADIUS + '\n\nThat stops and removes only the plex container — no other services are touched.';
  ok(
    assess_shell_safety({ reply: TARGETED_NO_RADIUS, evidence: EVIDENCE }).needs_retry,
    'targeted `down` with NO blast-radius statement still trips',
  );
  ok(
    assess_shell_safety({ reply: TARGETED_RADIUS, evidence: EVIDENCE }).needs_retry === false,
    'targeted `down` + an explicit blast-radius statement passes (the escape is real)',
  );

  // ── D. destructive-verb matrix ─────────────────────────────────────────────
  console.log('→ D. destructive verbs');
  const cases: Array<[string, boolean, string]> = [
    ['docker compose down', true, 'bare compose down'],
    ['docker-compose down', true, 'legacy docker-compose down'],
    ['docker compose down -v --remove-orphans', true, 'flags only → still untargeted'],
    ['docker compose --rmi all down', true, 'valued flag consumed, not read as a service'],
    ['docker compose down plex', true, 'targeted down is still a finding (needs blast radius)'],
    ['rm -rf /docker/plex', true, 'rm -rf'],
    ['rm -fr /docker/plex', true, 'rm -fr (flag order)'],
    ['sudo rm -rf /var/lib/x', true, 'sudo stripped before matching'],
    ['docker system prune -af', true, 'docker system prune'],
    ['docker volume prune', true, 'docker volume prune'],
    ['modprobe -r nvidia', true, 'modprobe -r'],
    ['rmmod nvidia_uvm', true, 'rmmod'],
    ['reboot', true, 'reboot'],
    ['sudo shutdown -r now', true, 'shutdown'],
    ['mkfs.ext4 /dev/sdb1', true, 'mkfs'],
    ['dd if=/dev/zero of=/dev/sdb', true, 'dd to a block device'],
    ['git reset --hard origin/main', true, 'git reset --hard'],
    ['docker stop $(docker ps -aq)', true, 'ps -aq expansion → every container'],
    ['docker rm plex', true, 'docker rm'],
    // Non-destructive — must NOT fire.
    ['docker compose -f /docker/docker-compose.yml restart plex', false, 'scoped restart'],
    ['docker compose up -d plex', false, 'targeted up'],
    ['docker restart plex', false, 'plain docker restart'],
    ['docker logs --tail=200 plex', false, 'logs'],
    ['systemctl status plexmediaserver', false, 'systemctl status'],
    ['nvidia-smi', false, 'a plain read command'],
    ['ls -la /docker', false, 'ls'],
  ];
  for (const [cmd, want, label] of cases) {
    ok((classify_command(cmd) !== null) === want, `${want ? 'flags' : 'ignores'}: ${label}`);
  }

  // ── E. extraction ──────────────────────────────────────────────────────────
  console.log('→ E. extraction');
  ok(extract_shell_blocks('```bash\ndocker ps\n```').length === 1, 'reads a ```bash fence');
  ok(extract_shell_blocks('```\ndocker ps\n```').length === 1, 'reads an untagged fence that looks like shell');
  ok(
    extract_shell_blocks('```\n{"a": 1}\n```').length === 0,
    'ignores an untagged fence that is NOT shell (a JSON block is not pasteable)',
  );
  ok(
    extract_shell_blocks('```json\n{"cmd":"rm -rf /"}\n```').length === 0,
    'ignores a json-tagged fence',
  );
  ok(
    assess_shell_safety({ reply: 'Just run `docker system prune -af` when you get a chance.' }).needs_retry,
    'an INLINE backtick command is caught too (equally pasteable)',
  );
  ok(
    assess_shell_safety({ reply: 'The stack came down and I had to restart everything.' }).needs_retry === false,
    'prose about a past teardown is not a command (no code span → clean)',
  );

  // ── F. path grounding ──────────────────────────────────────────────────────
  console.log('→ F. path grounding');
  const p = (block: string, ev: string) => find_ungrounded_paths([block], ev);
  ok(p('cd /opt/plex', EVIDENCE).length === 1, 'ungrounded /opt/plex flagged');
  ok(p('cd /docker', EVIDENCE).length === 0, 'grounded /docker not flagged');
  ok(
    p('cat /docker/docker-compose.yml', EVIDENCE).length === 0,
    'grounded compose file not flagged',
  );
  ok(
    p('ls /docker/plex/config', 'working_dir "/docker/plex"').length === 0,
    'descending into a GROUNDED parent is legitimate — not flagged',
  );
  ok(p('cat /etc/hosts', '').length === 0, 'standard system path (/etc) never flagged — noise floor');
  ok(p('rm /tmp/scratch.txt', '').length === 0, '/tmp never flagged');
  ok(p('echo hi > /var/log/x.log', '').length === 0, '/var/log never flagged');
  ok(p('cd /opt', EVIDENCE).length === 0, 'single-segment path not flagged (too weak a signal)');
  ok(p('curl https://example.com/opt/plex', EVIDENCE).length === 0, 'a URL path is not a filesystem path');
  ok(p('rm -rf /srv/*/cache', EVIDENCE).length === 0, 'a glob is not a checkable literal path');
  ok(
    p('cd /opt/plex\nls /opt/plex', EVIDENCE).length === 1,
    'the same ungrounded path twice reports once',
  );
  ok(
    assess_shell_safety({ reply: 'Its data lives in /opt/plex somewhere.', evidence: EVIDENCE }).needs_retry === false,
    'a path in PROSE is discussion, not an instruction — only command blocks are checked',
  );

  // ── G. blast-radius detection ──────────────────────────────────────────────
  console.log('→ G. blast-radius statements');
  ok(has_blast_radius_statement('That affects only plex.'), 'recognises "affects only"');
  ok(has_blast_radius_statement('This restarts just that container; nothing else on the box moves.'), 'recognises "nothing else on"');
  ok(has_blast_radius_statement('Blast radius: the whole media stack.'), 'recognises an explicit blast-radius line');
  ok(
    has_blast_radius_statement('This will take down every container in that compose file.'),
    'recognises an honest WIDE statement (stating it is what matters, not that it be small)',
  );
  ok(!has_blast_radius_statement('Run this and it should come back up.'), 'no scope statement → false');

  // ── H. kill switch + fail-open ─────────────────────────────────────────────
  console.log('→ H. kill switch');
  ok(shell_safety_guard_enabled() === true, 'guard is ON by default');
  process.env.HEARTH_SHELL_SAFETY_GUARD = '0';
  ok(shell_safety_guard_enabled() === false, 'HEARTH_SHELL_SAFETY_GUARD=0 disables it');
  delete process.env.HEARTH_SHELL_SAFETY_GUARD;
  ok(shell_safety_guard_enabled() === true, '…and re-arms when unset');
  ok(assess_shell_safety({ reply: '' }).needs_retry === false, 'empty reply → clean, no throw');
  ok(
    assess_shell_safety({ reply: 'No commands here at all.' }).findings.length === 0,
    'a reply with no shell content is a cheap no-op',
  );
  ok(
    assess_shell_safety({ reply: '```bash\ncd /opt/plex\n```' }).findings.length === 1,
    'missing evidence still works (everything ungrounded) — never throws',
  );

  console.log(`\n${failed === 0 ? '✓' : '✗'} smoke:shell-safety — ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main();
