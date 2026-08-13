/**
 * The Hearth CI ring — the deterministic per-merge gate.
 *
 * Runs, in order:
 *   1. `tsc --noEmit`              (type correctness across the whole project)
 *   2. `bun run guard`            (time + encoding source-hygiene guards)
 *   3. the SELF-CONTAINED smoke subset (temp db/vault, mocked/scripted LLM,
 *      NO network, NO live orchestrator, NO GPU, NO external binaries)
 *
 * One command, one clean pass/fail, non-zero exit on ANY failure. This script
 * IS the ring; where it gets INVOKED is swappable — a `.githooks/pre-push`
 * hook (human sessions), a `.gitea/workflows/ci.yml` job (all PRs, once a
 * Gitea Actions runner is registered), and — as a follow-up — Beatrice's
 * `run_checks` autonomous-merge chokepoint, all just call this.
 *
 * Design contract (why the smoke set is what it is):
 *   - The set is CURATED here in version control, not discovered at runtime,
 *     so a new smoke joins the gate deliberately (with a green run behind it),
 *     never by accident. A smoke that needs the live orchestrator / network /
 *     a GPU / ffmpeg is EXCLUDED with a recorded reason (see EXCLUDED below) —
 *     a flaky gate is worse than no gate (it trains `--no-verify`).
 *   - Each smoke self-configures its own env (HEARTH_TEST_MODE / *_=0 flags
 *     are set INSIDE the script), so the ring just drives the package.json
 *     key: `bun run smoke:<name>`.
 *   - Every smoke runs in its own process with a hard timeout, so one hang is
 *     killed and reported, never wedges the ring.
 *
 * Usage:
 *   bun run ci               # full ring (tsc + guard + all self-contained smokes)
 *   bun run ci:fast          # tsc + guard + the sub-~1.5s smoke tier (pre-push)
 *   bun run scripts/ci-ring.ts --only=citations,complexity
 *   bun run scripts/ci-ring.ts --list
 *   bun run scripts/ci-ring.ts --candidates   # run the full CANDIDATE set (for
 *                                              # re-deriving the green list)
 */

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';

/** Resolve a `smoke:<key>` package.json script to its actual `.ts` file, so we
 *  spawn ONE process (`bun <file>`) instead of the `bun run` wrapper — a
 *  wrapper grandchild holds the stdio pipes open, so killing only the wrapper
 *  on timeout leaves the real smoke running and the `close` event never fires
 *  (this wedged the first calibration run for 28 min on a hanging smoke). */
const PKG = JSON.parse(readFileSync(resolvePath(process.cwd(), 'package.json'), 'utf8')) as {
  scripts: Record<string, string>;
};
function smoke_file(key: string): string | null {
  const cmd = PKG.scripts[`smoke:${key}`];
  if (!cmd) return null;
  const m = cmd.match(/(scripts\/[\w.-]+\.(?:ts|py))/);
  return m ? m[1]! : null;
}

// ── The curated self-contained smoke set ────────────────────────────────────
// Derived empirically (2026-07-06): the CANDIDATES list (the classifier's 185
// self-contained candidates) was run through this ring; anything that failed,
// hung, or needed an unavailable dependency is in EXCLUDED with a reason. The
// gate set SMOKES is COMPUTED (candidates minus exclusions), so the exclusions
// are explicit and a new self-contained smoke joins the gate automatically once
// it's green. Re-derive after a batch: `bun run scripts/ci-ring.ts --candidates`.

/**
 * The full self-contained CANDIDATE set (classifier output). `--candidates`
 * runs ALL of these to (re)derive the green gate. Keep this list in sync when a
 * new self-contained smoke lands.
 */
const CANDIDATES: string[] = [
  // 2026-08-05: eleven camera/vision smokes were dropped from CANDIDATES when the
  // Frigate/CV layer was removed end-to-end (c8ca50e1, c56a5af4). They had no
  // package.json script left, so the ring reported eleven 'no such smoke:<key>'
  // failures — a red gate that trains --no-verify, which is exactly what the
  // header above says a flaky gate must never become.
  'acquire', 'activity-pane', 'agent-rooms', 'room-separation', 'agentd-recovery', 'air-quality', 'alert-tones',
  'apns', 'astrid-floors', 'astrid-insight', 'attribution-rules', 'audit-chain',
  'auth-apple', 'autonomy-reload', 'background-schedule', 'beatrice-pipeline',
  'bills-office', 'bind-guard', 'ble-presence', 'boot-check', 'brain',
  'brain-pane', 'brief-critic', 'brigid', 'calendar-attribution',
  'calendar-triggers', 'capabilities', 'capture-quality',
  'case-driver', 'change-checks', 'citations', 'civic-meeting-docs',
  'civic-member-name', 'civic-watchlist-expiry', 'code-edit', 'code-teeth',
  'codeshop', 'compaction', 'complexity', 'consult-guard', 'cordelia-queue',
  'critic-independence', 'cross-signal', 'dangerous-weather', 'data-denial', 'deep-research',
  'delegate', 'deliberation-envelope', 'delivery-window', 'digestion',
  'directed-task', 'dispatch-journal', 'download-integrity', 'dynamic-tools', 'emergency-lights',
  'emergency-test', 'entity-hydration', 'escalation', 'ev', 'evals', 'expected-bills',
  'expertise-audit', 'fabricated-action', 'fabricated-save',
  'fact-critic', 'firecrawl-backpressure', 'firecrawl-failover',
  'flights', 'friends', 'gedcom', 'gift-loop', 'good-followups',
  'grounding-precedence', 'guard-feedback', 'health-diagnosis', 'hiring',
  'capability-yield', 'llm-role-override', 'change-windows', 'yield-coverage-lint',
  'home-map', 'home-office', 'host-diag', 'house-voice', 'household-graph',
  'household-services', 'hvac', 'imessage-observer', 'ingestor',
  'internal-action-gate', 'kate-line', 'kate-proposal-gate', 'kate-reflection',
  'knowledge-demand', 'knowledge-fetch', 'kristi-cost', 'kristi-leaks',
  'kristi-tiering', 'kristi-value', 'library', 'library-browser-retry',
  'library-quarantine',
  'library-pane', 'life-events', 'listening-pane', 'live-synthesis',
  'infra-service', 'llm-serializer', 'mail-shelf', 'manage-services', 'maps', 'market-data',
  'market-radar', 'market-radar-pane', 'market-themes', 'media-archive', 'media-captions', 'media-quality', 'media-serving', 'media-sharing', 'media-taxonomy', 'merge-reland',
  'message-user', 'multiuser', 'news-desk', 'news-query',
  'order-fanout', 'people-graph',
  'people-observers', 'person-enrichment', 'postoffice',
  'precedent', 'presence', 'present-questions', 'privacy', 'privacy-self-test',
  'proactive', 'process-misses', 'program-patterns', 'proposal-court',
  'proposal-critic', 'proposal-dedup', 'proposal-dispatch', 'proposal-inflow',
  'proposal-resolve', 'proposal-terminal', 'provenance', 'public-figures',
  'rag-vector',
  'reactive-triggers', 'recall-brain', 'record-intent', 'reddit-oauth', 'relationship-signals',
  'repair-decide', 'resale', 'research', 'research-coverage', 'research-office',
  'research-budget', 'research-identity-anchor', 'research-verify', 'research-sources',
  'research-teeth', 'research-topics', 'reveal-self',
  'revert-low-risk',
  'roicalc', 'roster-gaps', 'ruby', 'ruby-beats', 'ruby-civic', 'save-honesty', 'scout',
  'scrum', 'search-router', 'secroom-chip',
  'seed-racks', 'shelf-synthesis', 'skills', 'eval-diagnosis',
  'shell-safety', 'source-url',
  'signal-router', 'status-flavor', 'subscriptions', 'synthesis-heal',
  'system-health', 'taste-facets', 'tempest', 'tool-contracts', 'tool-exemplars',
  'tool-loader', 'tool-pattern-lint', 'tool-schema-grammar', 'toolcall-diagnosis', 'trust-teeth',
  'trust-xp', 'two-tier', 'tz', 'unsaved-claim', 'user-model', 'user-profile',
  'user-style', 'visual-pipeline', 'voice-coordinator-unit', 'voice-emotion',
  'voice-followup', 'voice-reuse', 'voice-stream', 'weather-brief', 'weather-retry',
  'wifi-presence', 'wol-relay', 'workbench', 'working-memory',
  // Config lints (2026-08-03): persona routing tables must stay callable.
  'tool-reflexes', 'folded-names', 'standing-duties', 'prompt-supply',
];

/**
 * Excluded from the gate, with the reason. These are NOT run by `ci` — they
 * need something a deterministic gate can't guarantee. Documented so the
 * exclusion is a decision, not an oversight.
 */
const EXCLUDED: Record<string, string> = {
  // Not self-contained — need something a deterministic gate can't provide.
  smoke: 'needs a live orchestrator on :7700 (+ auth)',
  inbox: 'needs a live orchestrator on :7700',
  'read-endpoints': 'needs a live orchestrator on :7700 (+ auth)',
  approvals: 'needs a live orchestrator on :7700',
  specialists: 'needs a live orchestrator on :7700 (HEARTH_TEST_MODE)',
  app: 'needs a live orchestrator on :7700 (HEARTH_TEST_MODE)',
  'voice-coordinator': 'needs the live voice-coordinator service',
  connectors: 'hits external services (SearXNG/Firecrawl/HA/CalDAV)',
  arr: 'needs Sonarr/Radarr/etc reachable on your-llm-host.local',
  'image-cap': 'spawns ffmpeg (not guaranteed in a CI env)',
  'alert-tones': 'python3 test — outside the bun ring',
  'voice-coordinator-unit': 'python3 test — outside the bun ring',
};

/** The gate set — the self-contained candidates that are proven green + exit
 *  cleanly. Computed so a new candidate joins automatically once it's not in
 *  EXCLUDED. 171 as of the 2026-07-06 calibration. */
const SMOKES: string[] = CANDIDATES.filter((c) => !(c in EXCLUDED));

/**
 * The `ci:fast` pre-push tier — a tight, high-signal smell test (all confirmed
 * <700ms green), NOT the full gate. Biased to the invariants that break most
 * often: honesty guards, cordon, tool contracts, boot, time. The full ring
 * (`bun run ci`, ~2.5 min) is the pre-merge gate.
 */
const FAST_SMOKES: string[] = [
  'citations', 'complexity', 'escalation', 'tz', 'bind-guard', 'boot-check', 'capabilities',
  'tool-contracts', 'tool-pattern-lint', 'tool-schema-grammar', 'tool-loader', 'tool-exemplars',
  // Config lint, same family as the three above: a persona's tool_reflexes must
  // name tools that exist and that the specialist can actually reach.
  'tool-reflexes', 'folded-names', 'standing-duties', 'prompt-supply',
  'privacy', 'privacy-self-test', 'multiuser', 'audit-chain', 'trust-xp',
  'proposal-critic', 'fact-critic', 'data-denial', 'save-honesty',
  'fabricated-save', 'fabricated-action', 'record-intent', 'internal-action-gate',
  'grounding-precedence', 'provenance', 'guard-feedback', 'deliberation-envelope',
  'dynamic-tools', 'delivery-window', 'ingestor',
].filter((c) => !(c in EXCLUDED));

const PER_SMOKE_TIMEOUT_MS = Number(process.env.HEARTH_CI_SMOKE_TIMEOUT_MS ?? 180_000);

type StageResult = { name: string; ok: boolean; ms: number; timed_out?: boolean; tail?: string };

function run(cmd: string, args: string[], timeout_ms: number, label?: string): Promise<StageResult> {
  const started = Date.now();
  return new Promise((resolvePromise) => {
    // detached:true → the child is its own process-group leader, so on timeout
    // we can kill the WHOLE group (child + any grandchildren it spawned) and a
    // hang can never wedge the ring.
    const child = spawn(cmd, args, { cwd: process.cwd(), env: process.env, detached: true });
    let out = '';
    const cap = (chunk: Buffer) => {
      out += chunk.toString();
      if (out.length > 200_000) out = out.slice(-200_000); // keep the tail
    };
    child.stdout?.on('data', cap);
    child.stderr?.on('data', cap);
    let timed_out = false;
    const kill_group = () => {
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL');
      } catch {
        try {
          child.kill('SIGKILL');
        } catch {
          /* already gone */
        }
      }
    };
    const timer = setTimeout(() => {
      timed_out = true;
      kill_group();
    }, timeout_ms);
    const name = label ?? `${cmd} ${args.join(' ')}`;
    child.on('close', (code) => {
      clearTimeout(timer);
      const ms = Date.now() - started;
      const ok = !timed_out && code === 0;
      resolvePromise({
        name,
        ok,
        ms,
        timed_out,
        tail: ok ? undefined : out.split('\n').slice(-40).join('\n'),
      });
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolvePromise({ name, ok: false, ms: Date.now() - started, tail: `spawn error: ${err.message}` });
    });
  });
}

function fmt_ms(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const flag = (name: string) => argv.includes(name);
  const only_arg = argv.find((a) => a.startsWith('--only='));

  if (flag('--list')) {
    console.log(`SMOKES (${SMOKES.length}):\n  ${SMOKES.join(' ')}`);
    console.log(`\nFAST_SMOKES (${FAST_SMOKES.length}):\n  ${FAST_SMOKES.join(' ')}`);
    console.log(`\nEXCLUDED (${Object.keys(EXCLUDED).length}):`);
    for (const [k, v] of Object.entries(EXCLUDED)) console.log(`  smoke:${k} — ${v}`);
    return;
  }

  let smoke_set: string[];
  let label: string;
  if (only_arg) {
    smoke_set = only_arg.slice('--only='.length).split(',').map((s) => s.trim()).filter(Boolean);
    label = 'targeted';
  } else if (flag('--candidates')) {
    smoke_set = CANDIDATES;
    label = 'CANDIDATE calibration';
  } else if (flag('--fast')) {
    smoke_set = FAST_SMOKES;
    label = 'fast';
  } else {
    smoke_set = SMOKES;
    label = 'full';
  }

  console.log(`\n━━━ Hearth CI ring (${label}) ━━━\n`);
  const results: StageResult[] = [];

  // Stage 1: tsc (unless smoke-only via --only)
  if (!only_arg) {
    process.stdout.write('  tsc --noEmit … ');
    const tsc = await run('bunx', ['tsc', '--noEmit'], 300_000);
    console.log(tsc.ok ? `PASS (${fmt_ms(tsc.ms)})` : `FAIL (${fmt_ms(tsc.ms)})`);
    results.push({ ...tsc, name: 'tsc --noEmit' });

    process.stdout.write('  guard (time + encoding) … ');
    const guard = await run('bun', ['run', 'guard'], 120_000);
    console.log(guard.ok ? `PASS (${fmt_ms(guard.ms)})` : `FAIL (${fmt_ms(guard.ms)})`);
    results.push({ ...guard, name: 'guard' });
  }

  // Stage 3: smokes
  console.log(`\n  smokes (${smoke_set.length}):`);
  for (const s of smoke_set) {
    process.stdout.write(`    smoke:${s} … `);
    const file = smoke_file(s);
    if (!file) {
      console.log('✗ FAIL (no such smoke:<key> in package.json)');
      results.push({ name: `smoke:${s}`, ok: false, ms: 0, tail: `no package.json script smoke:${s}` });
      continue;
    }
    // Spawn the script's file DIRECTLY (one process — no `bun run` wrapper
    // grandchild). Each smoke self-configures its own env inside the file.
    const [cmd, args] = file.endsWith('.py') ? ['python3', [file]] : ['bun', [file]];
    const r = await run(cmd, args, PER_SMOKE_TIMEOUT_MS, `smoke:${s}`);
    const mark = r.ok ? '✓' : r.timed_out ? '⌛ TIMEOUT' : '✗ FAIL';
    console.log(`${mark} (${fmt_ms(r.ms)})`);
    results.push(r);
  }

  // Summary
  const failures = results.filter((r) => !r.ok);
  const total_ms = results.reduce((a, r) => a + r.ms, 0);
  console.log(`\n━━━ ${results.length - failures.length}/${results.length} passed in ${fmt_ms(total_ms)} ━━━`);
  if (failures.length > 0) {
    console.log(`\n${failures.length} FAILURE(S):\n`);
    for (const f of failures) {
      console.log(`── ${f.name}${f.timed_out ? ' (TIMEOUT)' : ''} ──\n${f.tail ?? ''}\n`);
    }
    process.exit(1);
  }
  console.log('\n✓ CI ring green.\n');
}

void main();
