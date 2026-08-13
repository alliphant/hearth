/**
 * smoke:scout — self-contained test of Cordelia's scout_sources tool
 * (knowledge metabolism #4).
 *
 * Temp vault + db + registry; search is a stub, the judge is a fake
 * planner-role provider. Asserts: rostered + denied domains are excluded
 * before judging; the judge's verdict + score floor gate proposals;
 * proposal payloads carry suggested tier + cadence + scores on the
 * resolver's contract; the proposal cap holds; a throwing judge FAILS
 * OPEN (candidates reported unjudged, zero proposals, no throw); and the
 * unknown-specialist recovery path.
 */
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ulid } from 'ulid';
import { open_db } from '../src/memory/stores/structured';
import { MemoryClient } from '../src/memory/client';
import { SpecialistRegistry } from '../src/core/specialist';
import { ProposalsStore } from '../src/core/proposals';
import type { ToolContext } from '../src/core/tool';
import type {
  LLMProvider,
  LLMRequest,
  LLMResponse,
  LLMRouter,
  RoleResolution,
} from '../src/core/llm';
import { upsert_source, DENIALS_PATH } from '../src/specialists/cordelia/sources_store';
import { make_scout_sources } from '../src/specialists/cordelia/tools/scout_sources';

let failures = 0;
function check(label: string, ok: boolean): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) failures++;
}

const dir = mkdtempSync(join(tmpdir(), 'hearth-scout-'));
const db = open_db(join(dir, 'smoke.db'));
const memory = new MemoryClient({ vault_root: join(dir, 'vault'), db });
const proposals = new ProposalsStore(db);

const spec_dir = join(dir, 'specialists');
mkdirSync(spec_dir, { recursive: true });
writeFileSync(
  join(spec_dir, 'anya.yaml'),
  `id: anya
name: Anya
role: Veterinary care
voice: warm-precise
persona: |
  Test fixture persona for the scout smoke. Long enough to pass.
proactive:
  mode: reactive
trusted_sources:
  tier_1:
    - merckvetmanual.com
`,
);
const specialists = new SpecialistRegistry(spec_dir);

// A subscription roster entry + a denial, both must be excluded.
upsert_source(memory, {
  url: 'https://avma.org/resources',
  description: 'anya subscription',
  tags: [],
  specialist_id: 'anya',
  cadence: 'monthly',
  tier: 1,
});
memory.upsert_note(
  DENIALS_PATH,
  {},
  '- **2026-06-01T00:00:00Z** — `petblog.example.net` proposed for anya Tier 2, denied. Cordelia must not re-propose.\n',
);

class FakeJudge implements LLMProvider {
  name = 'fake-judge';
  calls = 0;
  constructor(
    public behavior: { kind: 'json'; body: string } | { kind: 'throw' } | { kind: 'garbage' },
  ) {}
  async complete(_req: LLMRequest): Promise<LLMResponse> {
    this.calls++;
    if (this.behavior.kind === 'throw') throw new Error('judge down');
    const content = this.behavior.kind === 'garbage' ? 'not json at all' : this.behavior.body;
    return {
      content,
      tool_calls: [],
      finish_reason: 'stop',
      cost: { tokens_in: 0, tokens_out: 0, ms: 0, model: 'fake' },
    };
  }
  capabilities() {
    return {
      supports_json_schema: false,
      supports_tool_calls: false,
      supports_thinking_mode: false,
      supports_vision: false,
      max_context: 8192,
      cost_per_1m_in_cents: 0,
      cost_per_1m_out_cents: 0,
    };
  }
}
class FakeRouter implements LLMRouter {
  constructor(public provider: FakeJudge) {}
  for_role(): RoleResolution {
    return { provider: this.provider, defaults: {}, model: 'fake' };
  }
}

const search_results = [
  // rostered (manifest) — excluded before judging
  { title: 'Merck CKD chapter', url: 'https://www.merckvetmanual.com/ckd', snippet: '' },
  // rostered (subscription) — excluded
  { title: 'AVMA resource', url: 'https://avma.org/ckd', snippet: '' },
  // denied — excluded
  { title: 'Pet blog post', url: 'https://petblog.example.net/ckd', snippet: '' },
  // genuine candidates
  { title: 'ISFM consensus', url: 'https://icatcare.org/ckd-guidelines', snippet: 'consensus statement' },
  { title: 'WSAVA nutrition toolkit', url: 'https://wsava.org/nutrition-toolkit', snippet: 'global guidance' },
  { title: 'SEO chum farm', url: 'https://bestcatfoods.example.net/top10', snippet: 'top 10 foods!!' },
];
const search_fn = async (): Promise<{
  query: string;
  results: typeof search_results;
  error?: string;
}> => ({ query: 'q', results: search_results });

const judge_body = JSON.stringify([
  {
    domain: 'icatcare.org',
    authority: 0.9,
    independence: 0.9,
    freshness: 0.8,
    fit: 0.95,
    propose: true,
    suggested_tier: 1,
    suggested_cadence: 'quarterly',
    reason: 'ISFM professional body, primary guidance',
  },
  {
    domain: 'wsava.org',
    authority: 0.85,
    independence: 0.9,
    freshness: 0.7,
    fit: 0.9,
    propose: true,
    suggested_tier: 1,
    suggested_cadence: 'quarterly',
    reason: 'global veterinary association',
  },
  {
    domain: 'bestcatfoods.example.net',
    authority: 0.1,
    independence: 0.2,
    freshness: 0.6,
    fit: 0.5,
    propose: false,
    suggested_tier: 2,
    suggested_cadence: 'monthly',
    reason: 'affiliate SEO content',
  },
]);

const ctx: ToolContext = {
  memory,
  llm: null as unknown as LLMRouter, // tool uses deps.llm, not ctx.llm
  now: new Date('2026-06-10T04:05:00Z'),
  intent_id: ulid(),
  specialist_id: 'cordelia',
  user: { id: 'jasper', tier: 'owner' },
};

// ------------------------------------------------------------------
// 1. Happy path
// ------------------------------------------------------------------
const judge = new FakeJudge({ kind: 'json', body: judge_body });
const tool = make_scout_sources({
  specialists,
  proposals,
  memory,
  llm: new FakeRouter(judge),
  search_fn: search_fn as never,
});
const run1 = await tool.execute(
  { topic: 'feline chronic kidney disease nutrition', specialist_id: 'anya', max_candidates: 6 },
  ctx,
);
check('no error on happy path', run1.error === undefined && run1.judge_error === undefined);
check('rostered domains excluded from candidates', !run1.candidates.some((c) => c.domain.includes('merckvetmanual') || c.domain.includes('avma')));
check('denied domain excluded from candidates', !run1.candidates.some((c) => c.domain.includes('petblog')));
check('3 genuine candidates judged', run1.candidates.length === 3 && run1.candidates.every((c) => c.judged));
check('worthy domains proposed (2), chum skipped', run1.proposals.length === 2 && !run1.proposals.some((p) => p.domain.includes('bestcatfoods')));
const chum = run1.candidates.find((c) => c.domain.includes('bestcatfoods'));
check('chum carries verdict=skip with scores', chum?.verdict === 'skip' && chum.scores !== undefined);
check('proposals carry suggested tier + cadence', run1.proposals.every((p) => p.suggested_tier === 1 && p.suggested_cadence === 'quarterly'));

const rows = db
  .prepare(`SELECT payload_json, user_id FROM proposals WHERE kind = 'trusted_source_addition' ORDER BY ts_created`)
  .all() as Array<{ payload_json: string; user_id: string | null }>;
check('2 proposal rows, owner-global (user_id NULL)', rows.length === 2 && rows.every((r) => r.user_id === null));
const p0 = JSON.parse(rows[0]!.payload_json) as Record<string, unknown>;
check(
  'payload matches resolver contract + scout extras',
  p0.target_specialist_id === 'anya' && (p0.tier === 1 || p0.tier === 2) &&
    typeof p0.domain === 'string' && typeof p0.suggested_cadence === 'string' &&
    typeof (p0.judge_scores as Record<string, unknown>).authority === 'number',
);
const audit1 = db
  .prepare(`SELECT COUNT(*) AS n FROM audit_log WHERE tool_name = 'scout_sources'`)
  .get() as { n: number };
check('scout audited', audit1.n === 1);

// ------------------------------------------------------------------
// 2. Fail-open: judge throws
// ------------------------------------------------------------------
const judge_down = new FakeJudge({ kind: 'throw' });
const tool_down = make_scout_sources({
  specialists,
  proposals,
  memory,
  llm: new FakeRouter(judge_down),
  search_fn: search_fn as never,
});
const run2 = await tool_down.execute(
  { topic: 'feline arthritis management', specialist_id: 'anya', max_candidates: 6 },
  ctx,
);
check('judge throw does not throw the tool', run2.judge_error !== undefined);
check('fail-open reports candidates unjudged', run2.candidates.length === 3 && run2.candidates.every((c) => !c.judged));
check('fail-open files ZERO proposals', run2.proposals.length === 0);

// 3. Fail-open: judge returns garbage
const judge_garbage = new FakeJudge({ kind: 'garbage' });
const tool_garbage = make_scout_sources({
  specialists,
  proposals,
  memory,
  llm: new FakeRouter(judge_garbage),
  search_fn: search_fn as never,
});
const run3 = await tool_garbage.execute(
  { topic: 'feline dental care', specialist_id: 'anya', max_candidates: 6 },
  ctx,
);
check('unparseable judge fails open too', run3.judge_error !== undefined && run3.proposals.length === 0);

// 4. Unknown specialist recovery
const run4 = await tool.execute(
  { topic: 'anything', specialist_id: 'nope', max_candidates: 6 },
  ctx,
);
check('unknown specialist returns recovery hint', run4.error !== undefined && (run4.known_specialist_ids ?? []).includes('anya'));

// 5. Proposal cap: a judge that proposes everything still caps at 3
const many_results = Array.from({ length: 8 }, (_, i) => ({
  title: `Candidate ${i}`,
  url: `https://cand-${i}.example.org/page`,
  snippet: '',
}));
const many_judge_body = JSON.stringify(
  Array.from({ length: 8 }, (_, i) => ({
    domain: `cand-${i}.example.org`,
    authority: 0.9,
    independence: 0.9,
    freshness: 0.9,
    fit: 0.9,
    propose: true,
    suggested_tier: 2,
    suggested_cadence: 'monthly',
    reason: 'fine',
  })),
);
const tool_many = make_scout_sources({
  specialists,
  proposals,
  memory,
  llm: new FakeRouter(new FakeJudge({ kind: 'json', body: many_judge_body })),
  search_fn: (async () => ({ query: 'q', results: many_results })) as never,
});
const run5 = await tool_many.execute(
  { topic: 'broad topic with many candidates', specialist_id: 'anya', max_candidates: 8 },
  ctx,
);
check('proposal cap holds at 3 per scout', run5.proposals.length === 3);

// 6. Output schema round-trip
check('output validates against output_schema', tool.output_schema.safeParse(run1).success);

// ------------------------------------------------------------------
// 7. Approval resolver: auto-subscribe on scouted approvals
// ------------------------------------------------------------------
// The resolver patches config/specialists/<id>.yaml relative to CWD —
// chdir into the temp tree so the real config is never touched.
const { trusted_source_addition_resolver } = await import('../src/app/routes/specialists');
const { read_sources } = await import('../src/specialists/cordelia/sources_store');
mkdirSync(join(dir, 'config', 'specialists'), { recursive: true });
writeFileSync(
  join(dir, 'config', 'specialists', 'anya.yaml'),
  `id: anya\nname: Anya\nrole: Veterinary care\nvoice: warm-precise\npersona: |\n  Fixture persona for the resolver smoke. Long enough to pass.\nproactive:\n  mode: reactive\ntrusted_sources:\n  tier_1:\n    - merckvetmanual.com\n`,
);
const fake_proposal = { id: 'p1' } as never;
const prev_cwd = process.cwd();
process.chdir(dir);
try {
  // Scout-shaped payload (suggested_cadence) → YAML patch + subscription.
  const approve = await trusted_source_addition_resolver({
    proposal: fake_proposal,
    action_id: 'add',
    payload: {
      target_specialist_id: 'anya',
      domain: 'icatcare.org',
      tier: 1,
      candidate_url: 'https://icatcare.org/ckd-guidelines',
      candidate_title: 'ISFM consensus',
      suggested_cadence: 'quarterly',
    },
    memory,
  });
  const patched = readFileSync(join(dir, 'config', 'specialists', 'anya.yaml'), 'utf-8');
  check('resolver patches the YAML manifest', patched.includes('icatcare.org'));
  const sub = read_sources(memory).find((e) => e.url === 'https://icatcare.org/ckd-guidelines');
  check(
    'approval auto-creates the subscription (cadence + tier + provenance)',
    (approve.subscription as Record<string, unknown>).created === true &&
      sub?.specialist_id === 'anya' && sub.cadence === 'quarterly' &&
      sub.tier === 1 && sub.seeded_by === 'scout-approval',
  );

  // tier_swap applies the FLIPPED tier to the subscription too.
  const swap = await trusted_source_addition_resolver({
    proposal: fake_proposal,
    action_id: 'tier_swap',
    payload: {
      target_specialist_id: 'anya',
      domain: 'wsava.org',
      tier: 1,
      candidate_url: 'https://wsava.org/nutrition-toolkit',
      suggested_cadence: 'monthly',
    },
    memory,
  });
  const swap_sub = read_sources(memory).find((e) => e.url.includes('wsava.org'));
  check('tier_swap subscription carries the applied (flipped) tier', (swap.subscription as Record<string, unknown>).created === true && swap_sub?.tier === 2);

  // Acquire-shaped payload (no suggested_cadence) → no subscription.
  const plain = await trusted_source_addition_resolver({
    proposal: fake_proposal,
    action_id: 'add',
    payload: {
      target_specialist_id: 'anya',
      domain: 'blog.example.net',
      tier: 2,
      candidate_url: 'https://blog.example.net/ev-rates',
    },
    memory,
  });
  check(
    'no suggested_cadence → manifest patch only, no subscription',
    (plain.subscription as Record<string, unknown>).created === false &&
      !read_sources(memory).some((e) => e.url.includes('blog.example.net')),
  );

  // URL already subscribed for ANOTHER specialist → left alone.
  const stolen = await trusted_source_addition_resolver({
    proposal: fake_proposal,
    action_id: 'add',
    payload: {
      target_specialist_id: 'anya',
      domain: 'avma.org',
      tier: 1,
      candidate_url: 'https://avma.org/resources', // subscribed for... anya actually
      suggested_cadence: 'monthly',
    },
    memory,
  });
  // avma.org/resources was seeded for anya herself — same specialist, so
  // the upsert refreshes rather than skips.
  check('same-specialist existing subscription refreshes (no steal logic triggered)', (stolen.subscription as Record<string, unknown>).created === true);
  // Now a cross-specialist collision: subs.example.org belongs to nobody here —
  // seed one for a different owner and try to claim it for anya.
  const { upsert_source: upsert2 } = await import('../src/specialists/cordelia/sources_store');
  upsert2(memory, { url: 'https://shared.example.org/feed', description: 'other rack', tags: [], specialist_id: 'eleanor', cadence: 'weekly', tier: 2 });
  const collide = await trusted_source_addition_resolver({
    proposal: fake_proposal,
    action_id: 'add',
    payload: {
      target_specialist_id: 'anya',
      domain: 'shared.example.org',
      tier: 2,
      candidate_url: 'https://shared.example.org/feed',
      suggested_cadence: 'monthly',
    },
    memory,
  });
  const still_eleanor = read_sources(memory).find((e) => e.url === 'https://shared.example.org/feed');
  check(
    "cross-specialist URL collision is skipped — never steals another rack's entry",
    (collide.subscription as Record<string, unknown>).created === false && still_eleanor?.specialist_id === 'eleanor',
  );

  // Reject path: denial recorded, no subscription, no YAML touch.
  const deny = await trusted_source_addition_resolver({
    proposal: fake_proposal,
    action_id: 'reject',
    payload: {
      target_specialist_id: 'anya',
      domain: 'chum.example.net',
      tier: 2,
      suggested_cadence: 'weekly',
    },
    memory,
  });
  check(
    'reject records denial, creates nothing',
    deny.action === 'denied' && !read_sources(memory).some((e) => e.url.includes('chum.example.net')),
  );
} finally {
  process.chdir(prev_cwd);
}

await specialists.close();
db.close();
rmSync(dir, { recursive: true, force: true });

console.log(
  failures === 0 ? '\nsmoke:scout OK' : `\nsmoke:scout FAILED (${failures} check(s))`,
);
process.exit(failures === 0 ? 0 : 1);
