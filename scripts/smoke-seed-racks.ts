/**
 * smoke:seed-racks — validates the authored seed data and exercises the
 * loader against a temp vault (knowledge metabolism #5).
 *
 * Data checks run against the REAL config/specialists dir (read-only):
 * every seed names an existing specialist, parses as a URL, carries a
 * valid tier + cadence, racks hold 4–8 sources, and URLs are globally
 * unique (the store keys one entry per URL). Loader checks run against
 * a temp vault: entries land as subscriptions with seeded_by stamped,
 * the summary note is written, and a re-run is idempotent (no dupes,
 * crawl state preserved).
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { open_db } from '../src/memory/stores/structured';
import { MemoryClient } from '../src/memory/client';
import { load_extra_capabilities } from '../src/core/capabilities';
import { load_specialists_dir } from '../src/core/specialist';
import {
  read_sources,
  write_sources,
  subscriptions_due,
  is_subscription,
} from '../src/specialists/cordelia/sources_store';
import {
  SEEDS,
  SEEDED_BY,
  SUMMARY_PATH,
  RETIRED_URLS,
  apply_seeds,
  retire_seeded_urls,
} from './seed-source-racks';

let failures = 0;
function check(label: string, ok: boolean): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) failures++;
}

// ------------------------------------------------------------------
// 1. Data validation against the real specialist roster
// ------------------------------------------------------------------
// Config-extended capability tokens must load BEFORE parsing the real
// specialist YAMLs (same boot order the orchestrator enforces).
load_extra_capabilities(resolve(import.meta.dir, '../config/capabilities.yaml'));
const real_ids = new Set(
  load_specialists_dir(resolve(import.meta.dir, '../config/specialists')).map((s) => s.id),
);
const seed_specs = new Set(SEEDS.map((s) => s.specialist_id));
// iris + anya were folded into Kate 2026-07-04 (YAMLs deleted); their seed
// racks were dropped with them, so they're no longer expected in the roster.
const EXPECTED = ['kate', 'ruby', 'vivian', 'eleanor', 'astrid', 'brigid', 'kristi', 'maggie', 'anna'];

check('all 9 target specialists seeded (incl. kate news rack)', EXPECTED.every((id) => seed_specs.has(id)));
check(
  'every seed names a REAL specialist',
  SEEDS.every((s) => real_ids.has(s.specialist_id)),
);
check(
  'every URL parses',
  SEEDS.every((s) => {
    try {
      new URL(s.url);
      return true;
    } catch {
      return false;
    }
  }),
);
check('every URL is https', SEEDS.every((s) => s.url.startsWith('https://')));
check(
  'tiers and cadences valid',
  SEEDS.every(
    (s) =>
      (s.tier === 1 || s.tier === 2) &&
      ['daily', 'weekly', 'monthly', 'quarterly'].includes(s.cadence),
  ),
);
{
  const counts = new Map<string, number>();
  for (const s of SEEDS) counts.set(s.specialist_id, (counts.get(s.specialist_id) ?? 0) + 1);
  // Racks are production-pruned (2026-06-10 burn): quality over count.
  // Lean racks (eleanor: 1) grow via scout_sources, never via re-padding
  // the seed list with unverified landing pages. Kate's News Desk rack
  // runs much larger by design (one feed per cloud category slot).
  // DAILY-cadence entries are NEWS feeds (Kate's desk, Vivian's market
  // rail — they ride Cordelia's separate daily budget and are
  // secondaries by definition), so the REFERENCE-rack cap and the
  // Tier-1 ratio below count only NON-daily entries.
  check(
    'every rack holds ≥1 source; kate (news desk) ≤ 40 total',
    Array.from(counts.entries()).every(
      ([id, n]) => n >= 1 && (id !== 'kate' || n <= 40),
    ),
  );
  const ref_counts = new Map<string, number>();
  for (const s of SEEDS) {
    if (s.cadence === 'daily') continue;
    ref_counts.set(s.specialist_id, (ref_counts.get(s.specialist_id) ?? 0) + 1);
  }
  check(
    'reference racks hold ≤10 non-daily sources (dailies are the news lane)',
    Array.from(ref_counts.entries()).every(([id, n]) => id === 'kate' || n <= 10),
  );
}
check('URLs globally unique (one entry per URL in the store)', new Set(SEEDS.map((s) => s.url)).size === SEEDS.length);
// Primary-source bias holds for the REFERENCE racks. Kate's News Desk
// and the daily news lanes are legitimately Tier-2-heavy (trades,
// criticism, market wires are secondaries by definition) and would
// drown the ratio.
{
  const ref = SEEDS.filter((s) => s.specialist_id !== 'kate' && s.cadence !== 'daily');
  check(
    'primary-source bias: ≥60% Tier 1 on reference racks',
    ref.filter((s) => s.tier === 1).length / ref.length >= 0.6,
  );
}
check('descriptions present', SEEDS.every((s) => s.description.length >= 10));

// ------------------------------------------------------------------
// 2. Loader against a temp vault
// ------------------------------------------------------------------
const dir = mkdtempSync(join(tmpdir(), 'hearth-seed-'));
const db = open_db(join(dir, 'smoke.db'));
const memory = new MemoryClient({ vault_root: join(dir, 'vault'), db });

const r1 = apply_seeds(memory);
check('first apply adds every seed', r1.added === SEEDS.length && r1.updated === 0);
const entries = read_sources(memory);
check('all entries are subscriptions with seeded_by stamped', entries.every((e) => is_subscription(e) && e.seeded_by === SEEDED_BY));
check('all seeds are immediately due (never crawled)', subscriptions_due(entries, new Date()).length === SEEDS.length);
const summary = memory.read_note(SUMMARY_PATH);
check('summary note written for Jasper to prune', summary !== null && summary.body.includes('## ruby') && summary.body.includes('## anna'));

// Idempotency: simulate one crawl, re-apply, state survives.
{
  const es = read_sources(memory);
  es[0]!.last_crawled_at = '2026-06-09T03:40:00Z';
  es[0]!.last_content_hash = 'abc123';
  write_sources(memory, es);
}
const r2 = apply_seeds(memory);
check(
  're-run is idempotent (all updates, no dupes)',
  // Fresh vault: retired URLs never existed here, so totals == SEEDS.
  r2.added === 0 && r2.updated === SEEDS.length && r2.total_sources === SEEDS.length,
);
const after = read_sources(memory);
check('crawl state survives a re-seed', after[0]!.last_content_hash === 'abc123');

// Retire mechanism: seeder-stamped entries at retired URLs are removed;
// hand-added entries (no/foreign seeded_by) at the same URL survive.
{
  const { upsert_source } = await import('../src/specialists/cordelia/sources_store');
  upsert_source(memory, {
    url: 'https://dud.example.org/landing',
    description: 'seeder dud',
    tags: [],
    specialist_id: 'iris',
    cadence: 'monthly',
    tier: 2,
    seeded_by: SEEDED_BY,
  });
  upsert_source(memory, {
    url: 'https://hand.example.org/page',
    description: 'hand-added by Jasper',
    tags: [],
    specialist_id: 'iris',
    cadence: 'monthly',
    tier: 2,
  });
  const n = retire_seeded_urls(memory, [
    'https://dud.example.org/landing',
    'https://hand.example.org/page', // not ours — must survive
    'https://never-existed.example.org/', // no-op
  ]);
  const remaining = read_sources(memory);
  check('retire removes only the seeder-stamped dud', n === 1 && !remaining.some((e) => e.url.includes('dud.example.org')));
  check('hand-added entry at a retired URL survives', remaining.some((e) => e.url.includes('hand.example.org')));
}
// Retired URLs must not also be (re)seeded — that would resurrect them.
check(
  'no RETIRED url is still in SEEDS',
  RETIRED_URLS.every((u) => !SEEDS.some((s) => s.url === u)),
);

db.close();
rmSync(dir, { recursive: true, force: true });

console.log(
  failures === 0 ? '\nsmoke:seed-racks OK' : `\nsmoke:seed-racks FAILED (${failures} check(s))`,
);
process.exit(failures === 0 ? 0 : 1);
