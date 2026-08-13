/**
 * smoke:library-browser-retry — the quality gate's browser-rescue path.
 *
 * Self-contained (temp vault + db + registry; `_test_set_browser_fetch`
 * injects a fake browser fetch — no Firecrawl, no the workstation box). A URL
 * capture rejected as a paywall / nav-chrome shell is retried ONCE through
 * the warmed Firefox; on success the body is swapped in and re-assessed.
 * Covers: rescue (shell → browser prose → saved), fail-open (browser can't
 * help → still rejected), browser throw (caught → rejected), and the gate
 * scoping (a plain `thin` reject and a `file` source never trigger the retry).
 *
 * Verdicts are deterministic via the structural gate alone (no LLM): a short
 * link-heavy body is `nav_chrome` (< HARD_REJECT_LEN, link_ratio > 0.4); a
 * long low-link prose body hard-accepts (≥ HARD_ACCEPT_LEN, ≥ 5 sentences).
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { open_db } from '../src/memory/stores/structured';
import { MemoryClient } from '../src/memory/client';
import { SpecialistRegistry } from '../src/core/specialist';
import type { Embedder } from '../src/core/embeddings';
import type { SpecialistRuntime } from '../src/core/specialist_runtime';
import type { ConversationStore } from '../src/memory/stores/conversations';
import {
  save_library_item,
  _test_set_browser_fetch,
  type LibraryRoutesDeps,
} from '../src/app/routes/library';
import type { FetchOutcome } from '../src/connectors/fetch_with_browser_fallback';

let failures = 0;
function check(name: string, cond: boolean): void {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`);
  if (!cond) failures++;
}

const dir = mkdtempSync(join(tmpdir(), 'hearth-lib-browser-'));
const vault_root = join(dir, 'vault');
const db = open_db(join(dir, 'smoke.db'));
const memory = new MemoryClient({ vault_root, db });

const spec_dir = join(dir, 'specialists');
mkdirSync(spec_dir, { recursive: true });
writeFileSync(
  join(spec_dir, 'cordelia.yaml'),
  `id: cordelia
name: Cordelia
role: Librarian
voice: warm-archival
persona: |
  Test fixture persona for the browser-retry smoke. Long enough to pass.
knowledge_scope:
  - "Knowledge/Cordelia/**"
proactive:
  mode: reactive
`,
);
const specialists = new SpecialistRegistry(spec_dir);
const spec = specialists.get('cordelia')!;

const fake_embedder: Embedder = {
  enabled: true,
  model: 'fake',
  async embed(texts) { return texts.map(() => [0.1, 0.2, 0.3]); },
  async rerank() { return []; },
};

const deps: LibraryRoutesDeps = {
  db,
  vault_root,
  memory,
  specialists,
  runtime: null as unknown as SpecialistRuntime,
  conversations: null as unknown as ConversationStore,
  llm: undefined, // structural-only — verdicts are deterministic
  embedder: fake_embedder,
};

// A short, link-heavy body → nav_chrome (< 200 chars, link_ratio > 0.4).
const SHELL =
  '[Home](/) [About](/about) [Login](/login) [Subscribe](/subscribe) [Sign in](/signin)';
// A plain short body, few links → `thin` (NOT retried).
const THIN = 'Just a sentence. And another short one here.';
// Long, link-free prose → hard-accept (≥ 1200 chars, ≥ 5 sentences).
const PROSE = (
  'The article opens with a clear thesis and develops it across several paragraphs. ' +
  'It cites primary sources, contextualizes the finding against prior work, and weighs ' +
  'competing interpretations before settling on a measured conclusion. ' +
  'Each section advances the argument with concrete evidence rather than assertion. ' +
  'The prose is dense with real information and free of navigation chrome. ' +
  'A reader finishes with a genuine understanding of the subject and its open questions. '
).repeat(3);

function mdInput(body: string) {
  return { filename: 'capture.md', mime_type: 'text/markdown', bytes: new TextEncoder().encode(body) };
}

let browser_calls: string[] = [];
function setBrowser(outcome: (url: string) => FetchOutcome | Promise<FetchOutcome>): void {
  _test_set_browser_fetch((async (url: string) => {
    browser_calls.push(url);
    return outcome(url);
  }) as never);
}

async function main(): Promise<void> {
  const URL = 'https://paywalled.example.com/article';

  // 1. Rescue: nav_chrome shell → browser returns substantive prose → saved.
  browser_calls = [];
  setBrowser((url) => ({ kind: 'browser', markdown: PROSE, title: 'Rescued', source_url: url }));
  const rescued = await save_library_item(deps, mdInput(SHELL), spec, { source: 'url', source_url: URL });
  check('rescue: saved (not rejected)', !('rejected' in rescued));
  check('rescue: browser was tried once with the source url', browser_calls.length === 1 && browser_calls[0] === URL);
  const fts = db.prepare(`SELECT COUNT(*) AS n FROM chunks_fts WHERE chunks_fts MATCH 'thesis'`).get() as { n: number };
  check('rescue: rescued prose was chunked into the shelf', fts.n > 0);

  // 2. Fail-open: browser can't rescue (deferred) → still rejected, tried once.
  browser_calls = [];
  setBrowser((url) => ({ kind: 'deferred', reason: 'box asleep', source_url: url }));
  const deferred = await save_library_item(deps, mdInput(SHELL), spec, { source: 'url', source_url: URL });
  check('fail-open: rejected when browser cannot rescue', 'rejected' in deferred);
  check('fail-open: browser was tried', browser_calls.length === 1);

  // 3. Browser throws → caught, still rejected, no crash.
  browser_calls = [];
  setBrowser(() => { throw new Error('agentd unreachable'); });
  const threw = await save_library_item(deps, mdInput(SHELL), spec, { source: 'url', source_url: URL });
  check('throw: rejection (browser error caught)', 'rejected' in threw);

  // 4. Scope — a `thin` reject does NOT trigger the browser retry.
  browser_calls = [];
  setBrowser((url) => ({ kind: 'browser', markdown: PROSE, title: 't', source_url: url }));
  const thin = await save_library_item(deps, mdInput(THIN), spec, { source: 'url', source_url: URL });
  check('scope: thin reject is not browser-retried', 'rejected' in thin && browser_calls.length === 0);

  // 5. Scope — a `file` source is never browser-retried (only url captures).
  browser_calls = [];
  const fileRes = await save_library_item(deps, mdInput(SHELL), spec, { source: 'file' });
  check('scope: file source is not browser-retried', 'rejected' in fileRes && browser_calls.length === 0);
}

main()
  .catch((err) => {
    console.error(err);
    failures++;
  })
  .finally(() => {
    _test_set_browser_fetch(null); // restore the real fetch
    db.close();
    rmSync(dir, { recursive: true, force: true });
    console.log(failures === 0 ? '\nsmoke:library-browser-retry OK' : `\nsmoke:library-browser-retry FAILED (${failures})`);
    process.exit(failures === 0 ? 0 : 1);
  });
