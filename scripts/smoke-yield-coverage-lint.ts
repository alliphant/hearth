/**
 * smoke:yield-coverage-lint — every scheduled capability must have been TRIAGED.
 *
 * This is the piece that keeps the coverage gap closed. Annotating today's
 * roster is a one-time act; without a gate, the next background job someone
 * adds re-opens the hole silently — which is the whole failure mode this
 * subsystem exists to close, reappearing one level up.
 *
 * The rule: every tool named by a `background_jobs` entry in any specialist
 * YAML must carry a `Tool.yield` declaration — EITHER a real contract
 * (`{produced, considered}`) or an explicit exemption (`{none: true, reason}`).
 *
 * **Absence is not exemption.** That distinction is the point. An undeclared
 * tool means "nobody has looked at this yet"; `{none: true}` means "somebody
 * looked and this writes nothing by design." Only the second is a decision.
 * Allowing absence to pass would make the lint a no-op the day it shipped.
 *
 * It reads the YAMLs and the SOURCE (a regex over the tool object literal)
 * rather than booting the registry, so it stays fast, self-contained, and
 * runnable in the CI ring with no DB, no LLM and no network.
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parse } from 'yaml';

/**
 * The shrinking baseline — capabilities that predate the yield contract and
 * have not been triaged yet. Same idiom as `ci-ring.ts`'s EXCLUDED map: a
 * documented list, not a silent exemption.
 *
 * A tool ON this list may be undeclared. A tool NOT on it must be declared —
 * so a NEW background job cannot re-open the gap, which is the whole point.
 * When you triage one, DELETE its line. The lint fails if the baseline lists a
 * tool that is now declared, so the list cannot rot into a lie.
 *
 * Do not add to this list. Declare the tool instead.
 */
const UNTRIAGED_BASELINE: ReadonlySet<string> = new Set([
  'acquire_campaign_finance', 'acquire_pricing', 'acquire_quickspecs',
  'advance_research_commissions', 'advance_research_investigations',
  'assess_competitive_items', 'audit_specialist_expertise',
  'compose_news_takes', 'convene_proposal_court', 'council_alignment',
  'derive_swimlane_profiles', 'distill_house_day', 'distill_jasper_style',
  'drive_configurator', 'extract_workstation_layer', 'index_precedent_cases',
  'knowledge_fetch', 'learn_household_services', 'lookup_benchmark_scores',
  'lookup_commodity_market_prices', 'observe_jasper_voice',
  'reflect_household', 'refresh_market_radar', 'refresh_subscriptions',
  'research_commission_sweep', 'scan_calendar_followups',
  'scan_cross_signals', 'scan_expected_bills', 'scan_good_followups',
  'scan_life_events', 'scan_meeting_prep', 'scan_sources',
  'scan_specialist_authenticity', 'sweep_user_models', 'synthesize_shelves'
]);

const REPO = resolve(import.meta.dir, '..');
const SPECIALISTS_DIR = join(REPO, 'config', 'specialists');
const SEARCH_ROOTS = ['src/specialists', 'src/connectors', 'src/tools', 'src/agents'];

let failures = 0;
function assert(cond: unknown, msg: string): void {
  if (cond) console.log(`  ✓ ${msg}`);
  else {
    console.error(`  ✗ ${msg}`);
    failures++;
  }
}

/* ── 1. every tool a background job invokes ─────────────────────────────── */

interface JobRef {
  specialist: string;
  job: string;
  tool: string;
}

function scheduled_tools(): JobRef[] {
  const out: JobRef[] = [];
  for (const f of readdirSync(SPECIALISTS_DIR)) {
    if (!f.endsWith('.yaml')) continue;
    let doc: {
      id?: string;
      proactive?: { background_jobs?: Array<{ name?: string; tool?: string }> };
    };
    try {
      doc = parse(readFileSync(join(SPECIALISTS_DIR, f), 'utf8')) as typeof doc;
    } catch (err) {
      console.error(`  ✗ ${f} does not parse: ${(err as Error).message}`);
      failures++;
      continue;
    }
    for (const job of doc.proactive?.background_jobs ?? []) {
      if (job.tool) {
        out.push({ specialist: doc.id ?? f.replace(/\.yaml$/, ''), job: job.name ?? '?', tool: job.tool });
      }
    }
  }
  return out;
}

/* ── 2. find each tool's source + read its declaration ──────────────────── */

function walk(dir: string, acc: string[] = []): string[] {
  if (!existsSync(dir)) return acc;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, acc);
    else if (e.name.endsWith('.ts')) acc.push(p);
  }
  return acc;
}

const ALL_TS = SEARCH_ROOTS.flatMap((r) => walk(join(REPO, r)));

type Declared = 'contract' | 'inert_contract' | 'none' | 'absent' | 'tool_not_found';

/**
 * Locate `name: '<tool>'` and look for a `yield:` within the same tool object
 * literal. The window ends at the tool's `execute(` — every Tool in this repo
 * declares its metadata above `execute`, so that is a reliable terminator and
 * keeps a neighbouring tool's `yield:` in the same file from being miscounted.
 *
 * The property matcher is indentation-AGNOSTIC and requires the `{` of an
 * object literal. Both halves are load-bearing and were paid for: an earlier
 * version matched the literal string `'\n    yield:'`, which silently missed
 * every top-level connector (`export const foo: Tool = {…}` sits at two
 * spaces, not four) — it reported a declared tool as undeclared. Requiring
 * `{` keeps a mention of "yield:" inside a doc comment from counting as a
 * declaration, which would be the same bug in the opposite, worse direction.
 */
const YIELD_PROP = /^[ \t]*yield:\s*\{/m;

function declaration_for(tool: string): Declared {
  for (const file of ALL_TS) {
    const src = readFileSync(file, 'utf8');
    const at = src.indexOf(`name: '${tool}'`);
    if (at === -1) continue;
    const exec_at = src.indexOf('execute(', at);
    const window = src.slice(at, exec_at === -1 ? at + 6000 : exec_at);
    const m = YIELD_PROP.exec(window);
    if (!m) return 'absent';
    const after = window.slice(m.index, m.index + 400);
    if (/none\s*:\s*true/.test(after)) return 'none';
    // An ARMED contract with no `considered` can never escalate: `barren`
    // needs active_runs >= the floor, and a run counts as active only when
    // considered > 0. Eight consecutive zero-output runs verdict `idle`. A
    // declaration that silently does nothing is exactly the class this whole
    // subsystem exists to catch, so the lint refuses to let one ship unnamed.
    const armed_false = /armed\s*:\s*false/.test(after);
    const has_considered = /considered\s*:/.test(after);
    if (!armed_false && !has_considered) return 'inert_contract';
    return 'contract';
  }
  return 'tool_not_found';
}

/* ── 3. the lint ────────────────────────────────────────────────────────── */

console.log('\nyield coverage — every scheduled capability must be triaged\n');

const jobs = scheduled_tools();
const unique = [...new Set(jobs.map((j) => j.tool))].sort();
console.log(`  ${jobs.length} background job(s) across the roster → ${unique.length} distinct capability(ies)\n`);

const undeclared: string[] = [];
const missing_src: string[] = [];
const contracts: string[] = [];
const exempt: string[] = [];
const inert: string[] = [];

for (const tool of unique) {
  switch (declaration_for(tool)) {
    case 'contract':
      contracts.push(tool);
      break;
    case 'inert_contract':
      inert.push(tool);
      break;
    case 'none':
      exempt.push(tool);
      break;
    case 'absent':
      undeclared.push(tool);
      break;
    case 'tool_not_found':
      missing_src.push(tool);
      break;
  }
}

console.log(`  declared contract : ${contracts.length}`);
console.log(`  declared exempt   : ${exempt.length}`);
console.log(`  INERT contract    : ${inert.length}`);
console.log(`  UNDECLARED        : ${undeclared.length}`);
console.log(`  source not found  : ${missing_src.length}\n`);

if (inert.length > 0) {
  console.error('  INERT contracts — armed by default but structurally unable to escalate:');
  for (const t of inert) console.error(`    - ${t}`);
  console.error(
    '\n  `barren` requires active_runs >= the floor, and a run counts as active only\n' +
      '  when `considered > 0`. With no `considered` field, eight consecutive\n' +
      '  zero-output runs verdict `idle` — the declaration does nothing.\n' +
      '  Either add the field that says work arrived, or write `armed: false` to\n' +
      '  put reporting-only on the record.\n',
  );
}
assert(inert.length === 0, 'no armed contract is silently inert (a no-op declaration is the very bug being hunted)');

// Split the undeclared set against the shrinking baseline. Only a capability
// that is BOTH undeclared and NOT on the baseline is a failure — that is a new
// job re-opening the gap.
const new_gaps = undeclared.filter((t) => !UNTRIAGED_BASELINE.has(t));
const still_untriaged = undeclared.filter((t) => UNTRIAGED_BASELINE.has(t));

if (new_gaps.length > 0) {
  console.error('  NEW undeclared capabilities (not on the baseline — this is the regression):');
  for (const t of new_gaps) {
    const owners = jobs.filter((j) => j.tool === t).map((j) => `${j.specialist}/${j.job}`);
    console.error(`    - ${t}  (${owners.join(', ')})`);
  }
  console.error(
    '\n  Add ONE of these to the tool object, above execute():\n' +
      "    yield: { produced: ['<rows_written>'], considered: ['<work_available>'] }\n" +
      "    yield: { none: true, reason: '<why this writes nothing by design>' }\n" +
      '  Absence is NOT exemption — it means nobody has looked yet, which is the\n' +
      '  gap this lint exists to keep closed. Do NOT add it to the baseline.\n',
  );
}

assert(new_gaps.length === 0, 'no NEW scheduled capability is undeclared (the gap cannot re-open)');

// The baseline must not rot into a lie: a tool listed as untriaged that is now
// declared should be deleted from the list, or the backlog number stops meaning
// anything.
const stale_baseline = [...UNTRIAGED_BASELINE].filter(
  (t) => contracts.includes(t) || exempt.includes(t),
);
if (stale_baseline.length > 0) {
  console.error(`  Baseline lists tools that are now declared — delete these lines: ${stale_baseline.join(', ')}`);
}
assert(stale_baseline.length === 0, 'the untriaged baseline contains no already-declared tools');

console.log(`\n  backlog remaining: ${still_untriaged.length} untriaged capability(ies)`);

// A background job pointing at a tool whose source can't be found is its own
// bug (a renamed tool, a dead job entry) — surface it rather than pass silently.
if (missing_src.length > 0) {
  console.error(`  Source not found for: ${missing_src.join(', ')}`);
  console.error('  A background job naming a tool that does not exist will fail every run.\n');
}
assert(missing_src.length === 0, 'every background job names a tool that actually exists in the tree');

// Guard the guard: if the parser silently stopped matching anything, the lint
// would "pass" while checking nothing. extract_meeting_votes is the documented
// exemplar and carries a real contract.
assert(
  declaration_for('extract_meeting_votes') === 'contract',
  'the parser still detects a real contract (guards against a silently-passing lint)',
);
// Both indentation styles, because the first version of this parser only saw
// one of them and reported a declared connector as undeclared.
assert(
  declaration_for('query_audit_log') === 'none',
  'the parser detects an exemption on a TOP-LEVEL connector (2-space indent), not just a factory tool',
);
assert(
  declaration_for('scan_capability_yield') === 'contract',
  'and a contract on a factory-built tool (4-space indent)',
);
assert(unique.length > 20, `the roster scan found ${unique.length} capabilities — not silently empty`);

console.log(failures === 0 ? '\nsmoke:yield-coverage-lint OK' : `\nsmoke:yield-coverage-lint FAILED (${failures})`);
process.exit(failures === 0 ? 0 : 1);
