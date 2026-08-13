/**
 * smoke:acquire — self-contained test of Cordelia's acquire_knowledge
 * sprint tool (knowledge metabolism #3).
 *
 * Temp vault + db + specialist registry; search/fetch are stubs, LLM
 * absent (quality gate structural-only). Asserts: in-roster candidates
 * (manifest AND subscription domains) fetch + shelve with the right
 * trust_tier and chunks_fts rows; a well-ranked OUT-of-roster candidate
 * files a trusted_source_addition proposal and is NEVER shelved; denied
 * domains are not re-proposed; the per-user cordon stamps private_to;
 * unknown-specialist and search-failure error paths return recovery
 * hints instead of throwing; empty-roster sprints point at
 * scout_sources.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ulid } from 'ulid';
import { open_db } from '../src/memory/stores/structured';
import { MemoryClient } from '../src/memory/client';
import { SpecialistRegistry } from '../src/core/specialist';
import { ProposalsStore } from '../src/core/proposals';
import type { ToolContext } from '../src/core/tool';
import type { LLMRouter } from '../src/core/llm';
import type { LibraryRoutesDeps } from '../src/app/routes/library';
import type { SpecialistRuntime } from '../src/core/specialist_runtime';
import type { ConversationStore } from '../src/memory/stores/conversations';
import type { FetchOutcome } from '../src/connectors/fetch_with_browser_fallback';
import { upsert_source, DENIALS_PATH } from '../src/specialists/cordelia/sources_store';
import { make_acquire_knowledge } from '../src/specialists/cordelia/tools/acquire_knowledge';

let failures = 0;
function check(label: string, ok: boolean): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) failures++;
}

const dir = mkdtempSync(join(tmpdir(), 'hearth-acquire-'));
const vault_root = join(dir, 'vault');
const db = open_db(join(dir, 'smoke.db'));
const memory = new MemoryClient({ vault_root, db });
const proposals = new ProposalsStore(db);

const spec_dir = join(dir, 'specialists');
mkdirSync(spec_dir, { recursive: true });
writeFileSync(
  join(spec_dir, 'iris.yaml'),
  `id: iris
name: Iris
role: EV and home automation
voice: warm-technical
persona: |
  Test fixture persona for the acquire smoke. Long enough to pass.
proactive:
  mode: reactive
trusted_sources:
  tier_1:
    - manifest.example.org
`,
);
const specialists = new SpecialistRegistry(spec_dir);

// Subscription roster extension: subs.example.org belongs to iris at tier 2.
upsert_source(memory, {
  url: 'https://subs.example.org/feed',
  description: 'iris subscription',
  tags: [],
  specialist_id: 'iris',
  cadence: 'monthly',
  tier: 2,
});

// A previously-denied domain for iris (the resolver's reject format).
memory.upsert_note(
  DENIALS_PATH,
  {},
  '# Denials\n\n- **2026-06-01T00:00:00Z** — `denied.example.net` proposed for iris Tier 2, denied. Cordelia must not re-propose.\n',
);

const library_deps: LibraryRoutesDeps = {
  db,
  vault_root,
  memory,
  specialists,
  runtime: null as unknown as SpecialistRuntime,
  conversations: null as unknown as ConversationStore,
  llm: undefined,
};

const para =
  'Time-of-day electricity pricing rewards shifting electric vehicle charging into overnight windows when grid demand is lowest. ' +
  'Utilities publish seasonal schedules, and most vehicles support departure-time charging that finishes just before the morning commute. ';
const good_markdown = `# Off-peak charging guide\n\n${para.repeat(5)}`;

type SearchResp = { query: string; results: Array<{ title: string; url: string; snippet: string }>; error?: string };
let search_resp: SearchResp = {
  query: 'q',
  results: [
    { title: 'Great blog take', url: 'https://blog.example.net/ev-rates', snippet: 'rates' },
    { title: 'Manifest doc', url: 'https://manifest.example.org/charging', snippet: 'official' },
    { title: 'Denied domain doc', url: 'https://denied.example.net/post', snippet: 'meh' },
    { title: 'Subscription doc', url: 'https://subs.example.org/rates-page', snippet: 'subscribed' },
    { title: 'Dup blog page', url: 'https://blog.example.net/another', snippet: 'same domain' },
  ],
};
const search_fn = async (): Promise<SearchResp> => search_resp;
const fetch_fn = async (url: string): Promise<FetchOutcome> => ({
  kind: 'firecrawl',
  markdown: good_markdown,
  title: 'Off-peak charging guide',
  source_url: url,
});

const tool = make_acquire_knowledge({
  specialists,
  proposals,
  library_deps,
  search_fn: search_fn as never,
  fetch_fn,
});
const ctx: ToolContext = {
  memory,
  llm: null as unknown as LLMRouter,
  now: new Date('2026-06-10T04:00:00Z'),
  intent_id: ulid(),
  specialist_id: 'cordelia',
  user: { id: 'jasper', tier: 'owner' },
};

// ------------------------------------------------------------------
// 1. Happy path: in-roster shelved, out-of-roster proposed, denied skipped
// ------------------------------------------------------------------
const run1 = await tool.execute(
  { topic: 'EV off-peak charging rates', specialist_id: 'iris', max_candidates: 5, silent: false },
  ctx,
);
check('no error on happy path', run1.error === undefined);
check('shelved both in-roster candidates', run1.shelved.length === 2);
const manifest_item = run1.shelved.find((s) => s.url.includes('manifest'));
const subs_item = run1.shelved.find((s) => s.url.includes('subs.example.org'));
check('manifest domain shelved at tier 1', manifest_item?.trust_tier === 1);
check('subscription domain shelved at tier 2', subs_item?.trust_tier === 2);
check('out-of-roster blog proposed, not shelved', run1.proposed.length === 1 && run1.proposed[0]!.domain === 'blog.example.net' && !run1.shelved.some((s) => s.url.includes('blog')));
check('denied domain skipped with reason', run1.skipped.some((s) => s.url.includes('denied.example.net') && s.reason.includes('denied')));
check('same out-of-roster domain not proposed twice', run1.proposed.length === 1);

const fts = db
  .prepare(`SELECT COUNT(*) AS n FROM chunks_fts WHERE note_path = ?`)
  .get(manifest_item!.wrapper_note_path) as { n: number };
check('shelved item indexed into chunks_fts', fts.n > 0);
const note1 = memory.read_note(manifest_item!.wrapper_note_path);
check('shelf-wide by default (no private_to)', (note1?.frontmatter as Record<string, unknown>).private_to === undefined);

const prop_row = db
  .prepare(`SELECT user_id, payload_json FROM proposals WHERE kind = 'trusted_source_addition'`)
  .get() as { user_id: string | null; payload_json: string } | null;
check('proposal row exists with system-kind NULL user_id', prop_row !== null && prop_row.user_id === null);
const payload = JSON.parse(prop_row!.payload_json) as Record<string, unknown>;
check('proposal payload matches the resolver contract', payload.target_specialist_id === 'iris' && payload.domain === 'blog.example.net' && payload.tier === 2);

const acq_audit = db
  .prepare(`SELECT COUNT(*) AS n FROM audit_log WHERE tool_name = 'acquire_knowledge' AND agent = 'cordelia'`)
  .get() as { n: number };
check('sprint audited', acq_audit.n === 1);

// ------------------------------------------------------------------
// 2. Per-user cordon: private_to_user_id stamps the wrapper
// ------------------------------------------------------------------
const run2 = await tool.execute(
  {
    topic: 'gluten free sourdough hydration',
    specialist_id: 'iris',
    max_candidates: 2,
    private_to_user_id: 'sam',
    silent: false,
  },
  ctx,
);
check('cordoned sprint still shelves in-roster', run2.shelved.length >= 1);
const note2 = memory.read_note(run2.shelved[0]!.wrapper_note_path);
check('wrapper cordoned to the demand user (private_to: sam)', (note2?.frontmatter as Record<string, unknown>).private_to === 'sam');

// ------------------------------------------------------------------
// 3. Recovery paths — no throws
// ------------------------------------------------------------------
const run3 = await tool.execute(
  { topic: 'anything at all', specialist_id: 'nonexistent', max_candidates: 5, silent: false },
  ctx,
);
check('unknown specialist returns error + known ids (no throw)', run3.error !== undefined && (run3.known_specialist_ids ?? []).includes('iris'));

search_resp = { query: 'q', results: [], error: 'SearXNG unreachable' };
const run4 = await tool.execute(
  { topic: 'totally new topic', specialist_id: 'iris', max_candidates: 5, silent: false },
  ctx,
);
check('search failure returns error + next_action', run4.error !== undefined && (run4.next_action ?? '').length > 10);

search_resp = {
  query: 'q',
  results: [
    // rank 9+ out-of-roster results only — below the proposal window
    ...Array.from({ length: 9 }, (_, i) => ({
      title: `filler ${i}`,
      url: `https://filler-${i}.example.net/x`,
      snippet: '',
    })),
    { title: 'late blog', url: 'https://late-blog.example.net/post', snippet: '' },
  ],
};
const run5 = await tool.execute(
  { topic: 'no roster coverage here', specialist_id: 'iris', max_candidates: 5, silent: false },
  ctx,
);
check(
  'empty sprint points at scout_sources (next_action) — low-rank junk capped at 2 proposals',
  run5.shelved.length === 0 && run5.proposed.length <= 2 &&
    (run5.proposed.length > 0 || (run5.next_action ?? '').includes('scout_sources')),
);

// Output schema round-trip.
check('output validates against output_schema', tool.output_schema.safeParse(run1).success);

await specialists.close();
db.close();
rmSync(dir, { recursive: true, force: true });

console.log(
  failures === 0 ? '\nsmoke:acquire OK' : `\nsmoke:acquire FAILED (${failures} check(s))`,
);
process.exit(failures === 0 ? 0 : 1);
