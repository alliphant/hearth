export {};
/**
 * smoke:proposal-resolve — the decide ROUTE actually runs kind resolvers.
 *
 * Regression guard for the June-2026 hole: `decide()`'s `should_execute`
 * covered only `dispatch` | `web_action`, so an owner tap on a
 * `composite` book_candidate or a trusted_source_addition flipped the
 * proposal to `acknowledged` WITHOUT running the KIND_RESOLVERS block —
 * no queue-note mutation, no YAML patch, no auto-subscription, and (on
 * reject) no denial-note entry. Live evidence: 6 approved "add" taps +
 * 1 book "skip" all acknowledged with ZERO `proposal_resolver` audit
 * rows; Kristi's YAML never got the approved domains. The prior smokes
 * (smoke-visual-pipeline, smoke-scout) exercise the resolvers DIRECTLY
 * and so could never catch this — this smoke drives the real HTTP route.
 *
 * Self-contained: temp vault + db + specialist registry, the real
 * specialists router mounted in-process. The trusted_source_addition
 * resolver patches config/specialists/<id>.yaml relative to CWD, so the
 * smoke chdirs into the temp tree (the smoke-scout pattern).
 *
 *   bun run smoke:proposal-resolve
 */
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import matter from 'gray-matter';
import { Hono } from 'hono';
import { open_db } from '@memory/stores/structured';
import { MemoryClient } from '@memory/client';
import { SpecialistRegistry } from '@core/specialist';
import { SpecialistRuntime } from '@core/specialist_runtime';
import { ToolRegistry } from '@core/tool_registry';
import { ProposalsStore } from '@core/proposals';
import { ConversationStore, InterruptStore, SpecialistInbox } from '@memory/stores/conversations';
import { ConfigLLMRouter } from '@core/router';
import { load_extra_capabilities } from '@core/capabilities';
import { AppEventBus } from '@app/events';
import { create_specialists_router } from '@app/routes/specialists';
import { read_sources } from '@specialists/cordelia/sources_store';

process.env.HEARTH_TEST_MODE = '1';
process.env.HEARTH_DISABLE_LOOPS = '1';

let failures = 0;
function check(name: string, cond: boolean): void {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`);
  if (!cond) failures++;
}

async function call(
  router: Hono,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await router.fetch(
    new Request(`http://test.local${path}`, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    }),
  );
  const text = await res.text();
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    /* leave empty */
  }
  return { status: res.status, body: parsed };
}

// ── setup ────────────────────────────────────────────────────────────────
const root = mkdtempSync(resolve(tmpdir(), 'hearth-resolve-smoke-'));
const vault = resolve(root, 'vault');
mkdirSync(vault, { recursive: true });
const db = open_db(resolve(root, 'hearth.db'));
const memory = new MemoryClient({ vault_root: vault, db });

// Registry: cordelia (the filer of both resolver kinds) from the seed
// configs. Extended capability tokens must load before the registry
// compiles grants.
const specialists_dir = resolve(root, 'specialists');
mkdirSync(specialists_dir, { recursive: true });
const seed_dir = resolve(import.meta.dir, '..', 'config', 'specialists');
writeFileSync(
  resolve(specialists_dir, 'cordelia.yaml'),
  readFileSync(resolve(seed_dir, 'cordelia.yaml'), 'utf8'),
  'utf8',
);
load_extra_capabilities(resolve(import.meta.dir, '..', 'config', 'capabilities.yaml'));
const specialists = new SpecialistRegistry(specialists_dir);

// The resolver patches config/specialists/<id>.yaml relative to CWD —
// stand up a fixture target and chdir so the real config is never touched.
mkdirSync(resolve(root, 'config', 'specialists'), { recursive: true });
const anya_yaml = resolve(root, 'config', 'specialists', 'anya.yaml');
writeFileSync(
  anya_yaml,
  `id: anya\nname: Anya\nrole: Veterinary care\ntrusted_sources:\n  tier_1:\n    - merckvetmanual.com\n`,
  'utf8',
);

const proposals = new ProposalsStore(db);
const conversations = new ConversationStore(db);
const interrupts = new InterruptStore(db);
const inbox = new SpecialistInbox(db);
const tools = new ToolRegistry();
const events = new AppEventBus();
const roles_path = resolve(root, 'roles.yaml');
writeFileSync(
  roles_path,
  `roles:\n  specialist:\n    provider: ollama\n    model: test\n    temperature: 0.7\n`,
  'utf8',
);
const llm = new ConfigLLMRouter(roles_path, { ollama_base_url: 'http://localhost:11434' });
const runtime = new SpecialistRuntime({ specialists, llm, memory, tools, proposals, inbox, events });

const router = new Hono({ strict: false });
router.route(
  '/api',
  create_specialists_router({
    db,
    memory,
    specialists,
    runtime,
    proposals,
    conversations,
    interrupts,
    inbox,
    tools,
    llm,
    events,
  }),
);

const resolver_audit_count = (): number =>
  (
    db
      .prepare(`SELECT COUNT(*) AS c FROM audit_log WHERE tool_name = 'proposal_resolver'`)
      .get() as { c: number }
  ).c;

const queue_note = (slug: string): string => {
  const rel = `Knowledge/Cordelia/queue/2026-07-03-${slug}.md`;
  memory.upsert_note(
    rel,
    {
      type: 'book_candidate',
      status: 'awaiting_decision',
      private_to: 'jasper',
    },
    `# Book candidate — ${slug}`,
  );
  return rel;
};
const note_fm = (rel: string): Record<string, unknown> =>
  matter(readFileSync(resolve(vault, rel), 'utf8')).data as Record<string, unknown>;

const book = (slug: string, rel: string): string =>
  proposals.create({
    specialist_id: 'cordelia',
    kind: 'book_candidate',
    user_id: 'jasper',
    execution_kind: 'composite',
    payload: { queue_note_path: rel, title_candidate: slug, author_candidate: null },
    rationale: `book candidate ${slug}`,
    signature: {
      specialist_id: 'cordelia',
      kind: 'book_candidate',
      category: 'library_acquisition',
      anchor: rel,
    },
  });

const source = (domain: string, tier: 1 | 2, cadence?: string): string =>
  proposals.create({
    specialist_id: 'cordelia',
    kind: 'trusted_source_addition',
    execution_kind: 'composite',
    payload: {
      target_specialist_id: 'anya',
      domain,
      tier,
      candidate_url: `https://${domain}/guide`,
      candidate_title: `${domain} guide`,
      justification: 'smoke fixture',
      ...(cadence ? { suggested_cadence: cadence } : {}),
    },
    rationale: `add ${domain} for anya`,
    signature: {
      specialist_id: 'cordelia',
      kind: 'trusted_source_addition',
      category: 'knowledge_curation',
      anchor: `anya:${domain}`,
    },
  });

const prev_cwd = process.cwd();
process.chdir(root);

async function main(): Promise<void> {
  // ── 1. composite book_candidate: acquire runs the resolver ──────────────
  const rel_a = queue_note('book-a');
  const p1 = book('book-a', rel_a);
  const r1 = await call(router, 'POST', `/api/proposals/${p1}/decide`, { action_id: 'acquire' });
  check('acquire → HTTP 200', r1.status === 200);
  check('acquire → response status executed', r1.body.status === 'executed');
  check('acquire → queue note flipped to queued', note_fm(rel_a).status === 'queued');
  check('acquire → decided_action stamped on the note', note_fm(rel_a).decided_action === 'acquire');
  check('acquire → proposal row executed', proposals.get(p1)?.status === 'executed');
  check('acquire → proposal_resolver audit row', resolver_audit_count() === 1);

  // ── 2. the live incident: skip must mutate the note ─────────────────────
  const rel_b = queue_note('book-b');
  const p2 = book('book-b', rel_b);
  const r2 = await call(router, 'POST', `/api/proposals/${p2}/decide`, { action_id: 'skip' });
  check('skip → executed', r2.status === 200 && r2.body.status === 'executed');
  check('skip → queue note flipped to skipped', note_fm(rel_b).status === 'skipped');

  // ── 3. trusted_source_addition: add patches the YAML + subscribes ───────
  const p3 = source('icatcare.org', 1, 'quarterly');
  const r3 = await call(router, 'POST', `/api/proposals/${p3}/decide`, { action_id: 'add' });
  check('add → executed', r3.status === 200 && r3.body.status === 'executed');
  const yaml_after_add = readFileSync(anya_yaml, 'utf8');
  check('add → domain landed in the YAML', yaml_after_add.includes('icatcare.org'));
  const sub = read_sources(memory).find((e) => e.url === 'https://icatcare.org/guide');
  check(
    'add → auto-subscription created (specialist + cadence + tier)',
    sub?.specialist_id === 'anya' && sub.cadence === 'quarterly' && sub.tier === 1,
  );
  check('add → proposal row executed', proposals.get(p3)?.status === 'executed');

  // ── 4. tier_swap is reachable and lands in the OTHER tier ───────────────
  const p4 = source('wsava.org', 1);
  const r4 = await call(router, 'POST', `/api/proposals/${p4}/decide`, { action_id: 'tier_swap' });
  check('tier_swap → executed', r4.status === 200 && r4.body.status === 'executed');
  const yaml_after_swap = readFileSync(anya_yaml, 'utf8');
  const tier2_block = yaml_after_swap.slice(yaml_after_swap.indexOf('tier_2'));
  check('tier_swap → domain landed under tier_2', tier2_block.includes('wsava.org'));

  // ── 5. reject records the denial (durable "never re-propose") ───────────
  const before_reject = resolver_audit_count();
  const p5 = source('contentmill.example', 2);
  const r5 = await call(router, 'POST', `/api/proposals/${p5}/decide`, { action_id: 'reject' });
  check('reject → HTTP 200', r5.status === 200);
  check('reject → proposal denied', proposals.get(p5)?.status === 'denied');
  const denials_rel = 'Knowledge/Cordelia/trusted_source_denials.md';
  const denials_abs = resolve(vault, denials_rel);
  check(
    'reject → denial note carries the domain',
    existsSync(denials_abs) && readFileSync(denials_abs, 'utf8').includes('contentmill.example'),
  );
  check(
    'reject → YAML untouched',
    !readFileSync(anya_yaml, 'utf8').includes('contentmill.example'),
  );
  check('reject → resolver audited', resolver_audit_count() === before_reject + 1);

  // ── 6. manual advisory kinds still acknowledge without a resolver ───────
  const before_manual = resolver_audit_count();
  const p6 = proposals.create({
    specialist_id: 'kate',
    kind: 'recommendation',
    execution_kind: 'manual',
    payload: { note: 'advisory only' },
    rationale: 'a manual advisory recommendation',
    signature: { specialist_id: 'kate', kind: 'recommendation', category: 'test', anchor: 'adv' },
  });
  const r6 = await call(router, 'POST', `/api/proposals/${p6}/decide`, { verdict: 'approve' });
  check('manual approve → HTTP 200', r6.status === 200);
  check('manual approve → acknowledged, not executed', proposals.get(p6)?.status === 'acknowledged');
  check('manual approve → no resolver ran', resolver_audit_count() === before_manual);
  const stub_rows = (
    db
      .prepare(`SELECT COUNT(*) AS c FROM audit_log WHERE tool_name = 'would_have_executed'`)
      .get() as { c: number }
  ).c;
  check('manual approve → no stub execution recorded', stub_rows === 0);

  // ── 7. legacy verdict-deny on a kind with no reject action is safe ───────
  const before_legacy = resolver_audit_count();
  const rel_c = queue_note('book-c');
  const p7 = book('book-c', rel_c);
  const r7 = await call(router, 'POST', `/api/proposals/${p7}/decide`, { verdict: 'deny' });
  check('legacy deny on book_candidate → HTTP 200', r7.status === 200);
  check('legacy deny → proposal denied', proposals.get(p7)?.status === 'denied');
  check('legacy deny → queue note untouched', note_fm(rel_c).status === 'awaiting_decision');
  check('legacy deny → resolver NOT invoked', resolver_audit_count() === before_legacy);
}

main()
  .catch((err) => {
    console.error(err);
    failures++;
  })
  .finally(() => {
    process.chdir(prev_cwd);
    db.close();
    rmSync(root, { recursive: true, force: true });
    console.log(
      failures === 0
        ? '\nsmoke:proposal-resolve OK'
        : `\nsmoke:proposal-resolve FAILED (${failures})`,
    );
    process.exit(failures === 0 ? 0 : 1);
  });
