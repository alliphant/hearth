/**
 * smoke:directed-task — the directed-build deliberation plumbing + the live PR
 * pipeline's Gitea push-auth, both offline.
 *
 * Two invariants this asserts (the parts verifiable without a live LLM or git):
 *
 *  1. The per-turn `tools_override` surfaces a GRANTED-but-curated-out tool in a
 *     deliberation turn. This is the fix that makes `propose_code_change`
 *     reachable: Beatrice holds `write_codebase_pr` but the tool is on NEITHER
 *     of her curated surfaces, so without the override a directed pass could
 *     never author code. With the override it appears; without it, it stays
 *     hidden (the standing surface is unchanged).
 *
 *  2. `gitea_auth_env` produces an HTTP-Basic `http.extraHeader` env from the
 *     gear's Gitea token (so the container can push to the private `origin`
 *     remote it has no ambient credential for), and returns `undefined` when no
 *     token is configured (falls back to ambient credentials / TEST_MODE).
 *
 * The full directed deliberation (prompt directive + the 80B authoring a PR) is
 * exercised live, not here — TEST_MODE short-circuits deliberation to fixtures.
 */
import { SpecialistRuntime, type SpecialistRuntimeDeps } from '@core/specialist_runtime';
import type { LoadedSpecialist } from '@core/specialist';
import { gitea_auth_env } from '../src/specialists/trainer/change_pipeline';
import type { GitConfig } from '../src/specialists/trainer/change_pipeline';

let failures = 0;
function check(label: string, ok: boolean): void {
  console.log(`${ok ? '✓' : '✗'} ${label}`);
  if (!ok) failures++;
}

// ── 1. tools_override surfaces a curated-out granted tool ──────────────────
// The constructor just stores deps; the seam calls a pure function that never
// touches them, so empty deps are safe for this assertion.
const runtime = new SpecialistRuntime({} as unknown as SpecialistRuntimeDeps);

// A Beatrice-shaped specialist: deliberation surface curates propose_code_change
// OUT (exactly the live trainer.yaml shape), but the capability IS granted.
const spec = {
  id: 'trainer',
  granted: new Set<string>(['write_codebase_pr', 'manage_scrum', 'read_audit_log']),
  proactive: {
    tools_for_deliberation: ['scrum_board_read', 'query_audit_log', 'read_codebase_file'],
    tools_for_chat: ['scrum_board_read'],
  },
} as unknown as LoadedSpecialist;

const available = [
  { name: 'scrum_board_read' },
  { name: 'query_audit_log' },
  { name: 'read_codebase_file' },
  { name: 'grep_codebase' },
  { name: 'propose_code_change' },
];

const standing = runtime._test_curate_tools_for_turn(available, spec, 'specialist_deliberation');
check(
  'standing deliberation surface EXCLUDES propose_code_change (curated out)',
  !standing.some((t) => t.name === 'propose_code_change'),
);
check(
  'standing deliberation surface keeps the curated list',
  standing.length === 3 && standing.every((t) => spec.proactive.tools_for_deliberation!.includes(t.name)),
);

const directed = runtime._test_curate_tools_for_turn(available, spec, 'specialist_deliberation', [
  'propose_code_change',
  'read_codebase_file',
  'grep_codebase',
]);
check(
  'tools_override SURFACES propose_code_change for the directed pass',
  directed.some((t) => t.name === 'propose_code_change'),
);
check(
  'tools_override replaces the curated list with exactly the override (∩ available)',
  directed.length === 3 &&
    ['propose_code_change', 'read_codebase_file', 'grep_codebase'].every((n) =>
      directed.some((t) => t.name === n),
    ),
);
check(
  'override naming an UNAVAILABLE tool is silently dropped (capability gate holds)',
  runtime
    ._test_curate_tools_for_turn(available, spec, 'specialist_deliberation', ['merge_approved_change'])
    .every((t) => t.name !== 'merge_approved_change'),
);

// ── 2. gitea_auth_env ──────────────────────────────────────────────────────
const base: GitConfig = {
  gitea_base_url: 'http://host.docker.internal:3010',
  gitea_owner: 'jasper',
  gitea_repo: 'hearth-private',
  gitea_token: '',
  base_branch: 'main',
  github_url: '',
  github_token: '',
  github_required: false,
  merge_method: 'merge',
};

check('gitea_auth_env returns undefined when no token (ambient fallback)', gitea_auth_env(base) === undefined);

const env = gitea_auth_env({ ...base, gitea_token: 'gt_secret123' });
check('gitea_auth_env returns a one-key http.extraHeader env when token set', !!env && env.GIT_CONFIG_COUNT === '1' && env.GIT_CONFIG_KEY_0 === 'http.extraHeader');
const header = env?.GIT_CONFIG_VALUE_0 ?? '';
check('header is HTTP Basic', header.startsWith('Authorization: Basic '));
const decoded = Buffer.from(header.replace('Authorization: Basic ', ''), 'base64').toString('utf-8');
check('Basic credential is owner:token', decoded === 'jasper:gt_secret123');

console.log(failures === 0 ? '\nsmoke:directed-task — all passed' : `\nsmoke:directed-task — ${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
