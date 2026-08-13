/**
 * smoke:curate-relevance — curate_for_specialist's per-result relevance
 * gate on off-manifest trusted_source_addition proposals.
 *
 * Self-contained (temp vault + db + registry; search + fetch are stubs,
 * the judge is a fake planner-role provider). Regression for the
 * 2026-08-04 incident: www.ign.com ("Bleecker Street Media Movies - IGN")
 * keyword-collided with the focus area "Street Media Group the clinic revenue
 * reporting" and slipped through the per-QUERY `scope_held` gate into the
 * proposal queue (01KZ7A79DMKW6KRS90N40CEGSZ, denied).
 *
 * Asserts: an off-manifest result the judge deems relevant is proposed
 * (rationale cites the judge); a keyword-collision result is judged
 * irrelevant and NOT proposed; verdicts are cached per (area, host);
 * denied domains and no-scope queries never reach the judge; a throwing
 * or garbage judge fails CLOSED (zero proposals, no throw); dry_run runs
 * the judge so the preview is faithful but files nothing.
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
import type { SpecialistRuntime } from '../src/core/specialist_runtime';
import type { ConversationStore } from '../src/memory/stores/conversations';
import type {
  LLMProvider,
  LLMRequest,
  LLMResponse,
  LLMRouter,
  RoleResolution,
} from '../src/core/llm';
import type { FetchOutcome } from '../src/connectors/fetch_with_browser_fallback';
import { DENIALS_PATH } from '../src/specialists/cordelia/sources_store';
import { make_curate_for_specialist } from '../src/connectors/curate_for_specialist';

let failures = 0;
function check(label: string, ok: boolean): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) failures++;
}

const dir = mkdtempSync(join(tmpdir(), 'hearth-curate-rel-'));
const db = open_db(join(dir, 'smoke.db'));
const memory = new MemoryClient({ vault_root: join(dir, 'vault'), db });
const proposals = new ProposalsStore(db);

const spec_dir = join(dir, 'specialists');
mkdirSync(spec_dir, { recursive: true });
writeFileSync(
  join(spec_dir, 'maggie.yaml'),
  `id: maggie
name: Maggie
role: Business finance & reporting
voice: warm-precise
persona: |
  Test fixture persona for the curate relevance smoke. Long enough to pass.
proactive:
  mode: reactive
trusted_sources:
  tier_1:
    - sec.gov
`,
);
const specialists = new SpecialistRegistry(spec_dir);

// A prior denial — must be skipped BEFORE the judge ever sees it.
memory.upsert_note(
  DENIALS_PATH,
  {},
  '- **2026-07-01T00:00:00Z** — `spamfarm.example.net` proposed for maggie Tier 2, denied. Cordelia must not re-propose.\n',
);

// The judge is keyed off request content: anything mentioning ign.com /
// Bleecker is the keyword-collision case → not relevant.
type JudgeBehavior = 'verdict' | 'throw' | 'garbage';
class FakeJudge implements LLMProvider {
  name = 'fake-judge';
  calls = 0;
  constructor(public behavior: JudgeBehavior) {}
  async complete(req: LLMRequest): Promise<LLMResponse> {
    this.calls++;
    if (this.behavior === 'throw') throw new Error('judge down');
    let content = 'not json at all';
    if (this.behavior === 'verdict') {
      // Only the USER message names the candidate — the system prompt
      // itself cites the Bleecker/IGN incident as an example.
      const user = req.messages.filter((m) => m.role === 'user').map((m) => m.content).join('\n');
      const collision = user.includes('ign.com') || user.includes('Bleecker');
      content = JSON.stringify(
        collision
          ? { relevant: false, reason: 'movie coverage; keyword collision with "Street Media"' }
          : { relevant: true, reason: 'the clinic revenue analysis on-topic for the focus area' },
      );
    }
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

const FOCUS = 'Street Media Group the clinic revenue reporting';
const scoped_results = [
  // In-manifest hit — proves the site: scope held for the query. Fetch is
  // stubbed to fail so nothing is ingested (no network in this smoke).
  { title: 'Street Media Group 10-Q', url: 'https://www.sec.gov/filing/street-media-10q', snippet: 'quarterly report' },
  // Genuinely relevant off-manifest candidate → should be proposed.
  { title: 'Street Media Group the clinic revenue breakdown', url: 'https://csuanalytics.example.org/street-media-revenue', snippet: 'per-the clinic revenue analysis' },
  // The 2026-08-04 incident shape: keyword collision → judged irrelevant.
  { title: 'Bleecker Street Media Movies - IGN', url: 'https://www.ign.com/movies/bleecker-street-media', snippet: 'movie reviews and trailers' },
  // Second page from the same collision host + area → cached verdict, no extra judge call.
  { title: 'Bleecker Street Media - IGN page 2', url: 'https://www.ign.com/movies/bleecker-street-media/2', snippet: 'more movie coverage' },
  // Previously denied domain → skipped before judging.
  { title: 'Street media listicle', url: 'https://spamfarm.example.net/street-media-top10', snippet: 'top 10!!' },
];
const open_web_results = [
  // No in-manifest hit anywhere → scope not held → nothing judged/proposed.
  { title: 'Random blog', url: 'https://blog.example.net/street-media', snippet: '' },
  { title: 'Video farm', url: 'https://videofarm.example.net/street', snippet: '' },
];

function make_tool(judge: FakeJudge, results: typeof scoped_results) {
  return make_curate_for_specialist({
    specialists,
    proposals,
    library_deps: {
      db,
      vault_root: join(dir, 'vault'),
      memory,
      specialists,
      runtime: null as unknown as SpecialistRuntime,
      conversations: null as unknown as ConversationStore,
      llm: new FakeRouter(judge),
    },
    search_fn: (async (input: { query: string }) => ({
      query: input.query,
      results,
    })) as never,
    fetch_fn: async (url: string): Promise<FetchOutcome> => ({
      kind: 'failed',
      reason: 'stubbed: no network in smoke',
      source_url: url,
    }),
  });
}

const ctx: ToolContext = {
  memory,
  llm: null as unknown as LLMRouter, // tool uses deps.library_deps.llm
  now: new Date('2026-08-10T04:05:00Z'),
  intent_id: ulid(),
  specialist_id: 'cordelia',
  user: { id: 'jasper', tier: 'owner' },
};

function proposal_domains(): string[] {
  return (
    db
      .prepare(`SELECT payload_json FROM proposals WHERE kind = 'trusted_source_addition' AND status = 'pending'`)
      .all() as Array<{ payload_json: string }>
  ).map((r) => (JSON.parse(r.payload_json) as { domain: string }).domain);
}

// ------------------------------------------------------------------
// 1. Live pass: relevant proposed, collision skipped, cache + pre-gates hold
// ------------------------------------------------------------------
const judge = new FakeJudge('verdict');
const run1 = await make_tool(judge, scoped_results).execute(
  { target_specialist_id: 'maggie', focus_areas: [FOCUS], max_sources_per_area: 2, dry_run: false },
  ctx,
);
check('relevant off-manifest domain proposed', run1.proposed.length === 1 && run1.proposed[0]!.domain === 'csuanalytics.example.org');
check('REGRESSION: ign.com keyword collision NOT proposed', !proposal_domains().includes('www.ign.com'));
const ign_skips = run1.skipped.filter((s) => s.url.includes('ign.com'));
check('collision skipped with judged-not-relevant reason', ign_skips.length === 2 && ign_skips.every((s) => s.reason.includes('judged not relevant')));
check('verdict cached per (area, host) — 2 judge calls for 3 off-manifest URLs', judge.calls === 2);
check('denied domain skipped before judging', run1.skipped.some((s) => s.url.includes('spamfarm') && s.reason.includes('previously denied')));
check('in-manifest hit took the ingest path (stub fetch failed, not judged)', run1.skipped.some((s) => s.url.includes('sec.gov') && s.reason.includes('stubbed')));
const row = db
  .prepare(`SELECT rationale_md, payload_json FROM proposals WHERE kind = 'trusted_source_addition'`)
  .get() as { rationale_md: string; payload_json: string };
check('rationale cites the relevance check, not engine rank', row.rationale_md.includes('passed the relevance check'));
check('payload justification carries the judge reason', (JSON.parse(row.payload_json) as { justification: string }).justification.includes('relevance-judged'));
check('output validates against output_schema', make_tool(judge, scoped_results).output_schema.safeParse(run1).success);

// ------------------------------------------------------------------
// 2. scope_held=false: open-web results never reach the judge
// ------------------------------------------------------------------
const judge2 = new FakeJudge('verdict');
const run2 = await make_tool(judge2, open_web_results as typeof scoped_results).execute(
  { target_specialist_id: 'maggie', focus_areas: ['some area with zero manifest coverage'], max_sources_per_area: 2, dry_run: false },
  ctx,
);
check('no in-manifest hit → zero judge calls', judge2.calls === 0);
check('no in-manifest hit → zero proposals', run2.proposed.length === 0 && run2.skipped.every((s) => !s.url || s.reason.includes('scope not honored')));

// ------------------------------------------------------------------
// 3. Judge down / garbage: fails CLOSED — no proposals, no throw
// ------------------------------------------------------------------
for (const behavior of ['throw', 'garbage'] as const) {
  const before = proposal_domains().length;
  const run = await make_tool(new FakeJudge(behavior), scoped_results).execute(
    { target_specialist_id: 'maggie', focus_areas: [`${FOCUS} (${behavior})`], max_sources_per_area: 2, dry_run: false },
    ctx,
  );
  check(`judge ${behavior} → zero proposals, candidates skipped as judge-unavailable`,
    run.proposed.length === 0 &&
      proposal_domains().length === before &&
      run.skipped.some((s) => s.reason.includes('relevance judge unavailable')));
}

// ------------------------------------------------------------------
// 4. dry_run: judge runs (faithful preview), nothing filed
// ------------------------------------------------------------------
const judge4 = new FakeJudge('verdict');
const before_dry = proposal_domains().length;
const run4 = await make_tool(judge4, scoped_results).execute(
  { target_specialist_id: 'maggie', focus_areas: [`${FOCUS} (dry)`], max_sources_per_area: 2, dry_run: true },
  ctx,
);
check('dry_run runs the judge for a faithful preview', judge4.calls === 2);
check('dry_run: would-propose only the relevant domain', run4.skipped.some((s) => s.reason.includes('would propose csuanalytics.example.org')) &&
  !run4.skipped.some((s) => s.reason.includes('would propose www.ign.com')));
check('dry_run files nothing', run4.proposed.length === 0 && proposal_domains().length === before_dry);

await specialists.close();
db.close();
rmSync(dir, { recursive: true, force: true });

console.log(
  failures === 0 ? '\nsmoke:curate-relevance OK' : `\nsmoke:curate-relevance FAILED (${failures} check(s))`,
);
process.exit(failures === 0 ? 0 : 1);
