/**
 * smoke:critic-independence — the critic must not run on the author's model
 * (2026-07-31).
 *
 * Beatrice authors a change; Vera critiques it; Kate rules; the owner merges.
 * That chain is only worth its cost if the critic is INDEPENDENT — and until
 * this landed, `config/specialists/critic.yaml` carried no `llm_role`, so Vera
 * resolved the default `specialist` tier and critiqued on the **same 35B that
 * wrote the diff**. An author and its critic sharing weights share blind
 * spots; a second opinion from the same brain is barely a second opinion.
 *
 * The failure mode this guards is silent: delete one line from critic.yaml and
 * the review chain still runs, still produces critiques, still reports
 * success — it just stops being adversarial. Nothing else in the tree would
 * notice, which is the same shape as every other bug found on 2026-07-31.
 *
 * Config-level and self-contained — no network, no model, no db.
 */
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { load_extra_capabilities } from '../src/core/capabilities';
import { SpecialistConfigSchema } from '../src/core/specialist';
import { ConfigLLMRouter } from '../src/core/router';

let passed = 0, failed = 0;
const check = (n: string, c: boolean): void => {
  if (c) { console.log(`  ✓ ${n}`); passed++; } else { console.error(`  ✗ ${n}`); failed++; }
};

load_extra_capabilities('config/capabilities.yaml');

const env = {
  openai_api_key: 'test',
  openai_base_url: 'http://localhost:1/v1',
  ollama_base_url: 'http://localhost:2',
} as never;
const router = new ConfigLLMRouter('config/llm-roles.yaml', env);

/**
 * Model + think come from the REAL resolution path (what a turn actually
 * gets). Endpoint + concurrency come from the YAML, because `RoleResolution`
 * deliberately exposes only `provider / defaults / model /
 * context_window_tokens` — the base_url is the router's private business.
 * Reading them off the resolution returns `undefined` on both sides of a
 * comparison, which PASSES while asserting nothing; that vacuity is the
 * failure mode this helper exists to prevent.
 */
const ROLES = (parse(readFileSync('config/llm-roles.yaml', 'utf8')) as { roles: Record<string, Record<string, unknown>> }).roles;

const resolve = (role: string): { model: string; think?: boolean; max_concurrency?: number; base_url?: string } => {
  const r = router.for_role(role as never);
  const y = ROLES[role] ?? {};
  return {
    model: r.model,
    think: r.defaults.think,
    max_concurrency: y.max_concurrency as number | undefined,
    base_url: y.base_url as string | undefined,
  };
};

console.log('\nA. Vera is pinned to a role at all');
const critic = parse(readFileSync('config/specialists/critic.yaml', 'utf8')) as Record<string, unknown>;
const parsed = SpecialistConfigSchema.safeParse(critic);
check('critic.yaml validates', parsed.success);
if (!parsed.success) {
  console.error(JSON.stringify(parsed.error.issues.slice(0, 3), null, 2));
  console.log(`\n  passed=${passed}  failed=${failed}`);
  process.exit(1);
}
const critic_role = parsed.data.llm_role;
check('critic declares an llm_role (not the default tier)', typeof critic_role === 'string' && critic_role.length > 0);
if (!critic_role) {
  // Stop HERE with the diagnostic rather than letting `for_role(undefined)`
  // throw a stack trace. The whole point of this smoke is to say WHY the
  // review chain stopped being adversarial; a raw throw says nothing.
  console.error(
    '\n  critic.yaml has no llm_role, so Vera resolves the DEFAULT tier —\n' +
    '  the same model Beatrice authors on. The review chain still runs and\n' +
    '  still reports success; it is just no longer independent.\n' +
    '  Restore `llm_role: critic_review` (see config/llm-roles.yaml).',
  );
  console.log(`\n  passed=${passed}  failed=${failed}`);
  console.error('\n✗ CRITIC-INDEPENDENCE SMOKE FAILED');
  process.exit(1);
}

console.log('\nB. THE INVARIANT — the critic and the author are different brains');
const author = resolve('specialist');            // what Beatrice's turns resolve to
const reviewer = resolve(critic_role!);
console.log(`     author  (specialist)    → ${author.model}`);
console.log(`     critic  (${critic_role}) → ${reviewer.model}`);
check('the critic role resolves', typeof reviewer.model === 'string' && reviewer.model.length > 0);
check('the critic model DIFFERS from the author model', !!reviewer.model && reviewer.model !== author.model);

// Kate rules on the critique; if she shared the critic's model the ruling
// would re-correlate what the critique just decorrelated. Today she is on the
// default tier, which is the author's — that is FINE (she is the decider, not
// a second opinion) and is asserted only so a future change is deliberate.
const kate = resolve('specialist');
check('(recorded) Kate rules on the author tier, by design', kate.model === author.model);

console.log('\nC. the endpoint contract the role must not break');
check('the critic role declares a base_url at all', typeof reviewer.base_url === 'string');
check('  on the 122B judge endpoint (:8090)', (reviewer.base_url ?? '').includes('8090'));
const deep = resolve('deep_consult');
check('  which it SHARES with deep_consult', !!reviewer.base_url && reviewer.base_url === deep.base_url);
// The first role to resolve an endpoint fixes its mutex slot count, and the
// server is -np 2. A mismatch here either serializes the endpoint away or
// stampedes past its real slot count.
check('  so max_concurrency MATCHES deep_consult',
  reviewer.max_concurrency != null && reviewer.max_concurrency === deep.max_concurrency);
check('  and equals the server slot count (-np 2)', reviewer.max_concurrency === 2);

console.log('\nD. a critique is judgment, not derivation');
// The 2026-07-02 scrutiny bench found think-ON gave no accuracy gain on this
// family (30/33 vs 31/33 think-OFF) at 14x latency — which is why
// HEARTH_SCRUTINY_THINK stays unset. The critic role must not quietly re-enable it.
check('the critic role runs think:false', reviewer.think === false);
check('  matching the court judge seat', resolve('court_judge_deep').think === false);

console.log(`\n  passed=${passed}  failed=${failed}`);
if (failed > 0) { console.error('\n✗ CRITIC-INDEPENDENCE SMOKE FAILED'); process.exit(1); }
console.log('\n✓ CRITIC-INDEPENDENCE SMOKE OK');
process.exit(0);
