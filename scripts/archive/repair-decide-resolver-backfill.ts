/**
 * repair-decide-resolver-backfill.ts — one-time repair for the historical
 * damage left by the decide-route hole fixed in a0c5249 ("owner taps
 * actually run kind resolvers"): before that fix, deciding a composite/
 * manual proposal never invoked KIND_RESOLVERS, so the decision was
 * recorded on the proposal row but its effects never landed. Three
 * damage classes, each repaired idempotently:
 *
 *   A. `trusted_source_addition` rows decided 'add'/'tier_swap' that never
 *      patched the target specialist's YAML (nor auto-subscribed). Repair:
 *      re-run `trusted_source_addition_resolver` from the stored
 *      payload_json — the resolver is internally idempotent (an
 *      already-present domain is a no-op append; the subscription is an
 *      upsert) — then `record_execution` so the row honestly reads
 *      'executed' instead of parking at 'acknowledged'.
 *   B. `book_candidate` rows decided while the Cordelia queue note still
 *      says `status: awaiting_decision`. Repair: patch the note
 *      frontmatter with the resolver's status mapping (acquire→queued,
 *      file_only→filed_for_reference, skip→skipped), `decided_at` stamped
 *      from the row's ts_decided. Notes already past awaiting_decision
 *      are never touched.
 *   C. `trusted_source_addition` rows decided 'reject' whose denial line
 *      never landed in Knowledge/Cordelia/trusted_source_denials.md — so
 *      "denials are forever" had no entries and Cordelia could re-propose
 *      them. Repair: backfill one line per row in the reject resolver's
 *      exact format (domain + target + tier), stamped with the row's
 *      ts_decided, deduped via `denied_domains_for` so re-runs and
 *      post-fix denials never double-write. After writing, the script
 *      re-reads the file through `denied_domains_for` and fails loudly if
 *      any backfilled domain doesn't parse back (format-drift canary).
 *
 * SAFETY: default is DRY-RUN (prints the per-row repair plan, writes
 * nothing). Pass `--apply` to write. Pass `--skip-sources` to leave
 * class A untouched (the approved sources are weeks stale — the owner
 * may no longer want them).
 *
 * Run it on the box, inside the orchestrator container, AFTER the fix
 * deploys. cwd must be the repo root — the resolver resolves
 * `config/specialists/<id>.yaml` from process.cwd() — and the container
 * env already carries HEARTH_DB_PATH / HEARTH_VAULT_ROOT:
 *
 *   docker exec -w /app hearth-orchestrator bun run scripts/repair-decide-resolver-backfill.ts
 *   docker exec -w /app hearth-orchestrator bun run scripts/repair-decide-resolver-backfill.ts --apply
 *
 * A class-A apply patches the box's config/specialists/<id>.yaml (the
 * same live write every approval performs); SpecialistRegistry hot-reloads
 * it. No restart needed.
 */
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { parseDocument } from 'yaml';
import { ulid } from 'ulid';
import { open_db } from '@memory/stores/structured';
import { MemoryClient } from '@memory/client';
import { ProposalsStore, type ProposalRow } from '@core/proposals';
import { trusted_source_addition_resolver } from '../../src/app/routes/specialists';
import {
  read_clipping_frontmatter,
  patch_clipping_frontmatter,
} from '../../src/specialists/cordelia/intake/_capture_io';
import { DENIALS_PATH, denied_domains_for } from '@specialists/cordelia/sources_store';

const APPLY = process.argv.includes('--apply');
const SKIP_SOURCES = process.argv.includes('--skip-sources');
const REPAIR_TAG = 'repair-decide-resolver-backfill';

const VAULT_ROOT = resolve(
  process.env.HEARTH_VAULT_ROOT ?? join(homedir(), 'vault-friday'),
);
const DB_PATH = process.env.HEARTH_DB_PATH ?? './data/hearth.db';

const db = open_db(DB_PATH);
const memory = new MemoryClient({ vault_root: VAULT_ROOT, db });
// Default autonomy config is fine — the store is used only for
// get()/record_execution(), never for create()/graduation.
const proposals = new ProposalsStore(db);

let errors = 0;

function proposal_ids(sql: string): string[] {
  return (db.prepare(sql).all() as Array<{ id: string }>).map((r) => r.id);
}

function parse_payload(row: ProposalRow): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(row.payload_json) as unknown;
    return parsed && typeof parsed === 'object'
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** Read the target specialist's trusted_sources tiers for the dry-run
 *  report (proper YAML parse — a substring check would false-positive on
 *  domains embedded in longer ones). */
function yaml_tier_domains(spec_id: string): { tier_1: string[]; tier_2: string[] } | null {
  const yaml_path = resolve(process.cwd(), `config/specialists/${spec_id}.yaml`);
  if (!existsSync(yaml_path)) return null;
  try {
    const js = parseDocument(readFileSync(yaml_path, 'utf-8')).toJS() as Record<
      string,
      unknown
    > | null;
    const ts = (js?.trusted_sources ?? {}) as Record<string, unknown>;
    const as_strings = (v: unknown): string[] =>
      Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
    return { tier_1: as_strings(ts.tier_1), tier_2: as_strings(ts.tier_2) };
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* A. approved trusted_source_addition rows that never ran the resolver */
/* ------------------------------------------------------------------ */

async function repair_unapplied_sources(): Promise<{ repaired: number; skipped: number }> {
  // The damage class exactly: an approve-family decision whose resolver
  // never ran leaves the row at 'approved' (later triaged to
  // 'acknowledged'). A row the resolver DID handle was moved to
  // 'executed'/'failed' by record_execution, so it never matches here.
  const ids = proposal_ids(
    `SELECT id FROM proposals
      WHERE kind = 'trusted_source_addition'
        AND action_taken IN ('add', 'tier_swap')
        AND status IN ('approved', 'acknowledged')
      ORDER BY ts_decided`,
  );
  console.log(`\n[A] approved-but-never-applied trusted_source_addition: ${ids.length} row(s)`);
  let repaired = 0;
  let skipped = 0;
  for (const id of ids) {
    const row = proposals.get(id);
    if (!row || !row.action_taken) {
      console.log(`  [A] ${id} — row vanished or has no action_taken; skipping`);
      skipped++;
      continue;
    }
    const payload = parse_payload(row);
    const domain = typeof payload?.domain === 'string' ? payload.domain : null;
    const target =
      typeof payload?.target_specialist_id === 'string'
        ? payload.target_specialist_id
        : null;
    const tier = payload?.tier === 1 || payload?.tier === 2 ? payload.tier : null;
    if (!payload || !domain || !target || !tier) {
      console.log(`  [A] ${id} — payload_json missing domain/target/tier; skipping`);
      errors++;
      skipped++;
      continue;
    }
    const tiers = yaml_tier_domains(target);
    const present =
      tiers !== null && (tiers.tier_1.includes(domain) || tiers.tier_2.includes(domain));
    const cadence =
      typeof payload.suggested_cadence === 'string' ? payload.suggested_cadence : null;
    const desc =
      `${id} ${row.action_taken} \`${domain}\` → ${target} tier ${tier}` +
      `${cadence ? ` (+ subscribe ${cadence})` : ''}` +
      ` [YAML now: ${tiers === null ? 'unreadable' : present ? 'already present' : 'missing'}]` +
      ` decided ${row.ts_decided ?? '?'}`;
    if (!APPLY) {
      console.log(`  [A] would re-run resolver: ${desc}`);
      repaired++;
      continue;
    }
    try {
      const outcome = await trusted_source_addition_resolver({
        proposal: row,
        action_id: row.action_taken,
        payload,
        memory,
      });
      // Flip acknowledged→executed with the real outcome so the row (and
      // the iOS timeline) honestly reads as applied, tagged as a repair.
      proposals.record_execution(id, {
        ...outcome,
        repaired_by: REPAIR_TAG,
        original_ts_decided: row.ts_decided,
      });
      console.log(`  [A] repaired: ${desc}`);
      repaired++;
    } catch (err) {
      console.error(`  [A] FAILED (row left untouched, re-run after fixing): ${desc}`);
      console.error(`      ${(err as Error).message}`);
      errors++;
      skipped++;
    }
  }
  return { repaired, skipped };
}

/* ------------------------------------------------------------------ */
/* B. decided book_candidate rows whose queue note never got patched    */
/* ------------------------------------------------------------------ */

// Mirrors book_candidate_resolver's status map (specialists.ts).
const BOOK_STATUS_MAP: Record<string, string> = {
  acquire: 'queued',
  file_only: 'filed_for_reference',
  skip: 'skipped',
};

function repair_book_notes(): { repaired: number; skipped: number } {
  const ids = proposal_ids(
    `SELECT id FROM proposals
      WHERE kind = 'book_candidate' AND action_taken IS NOT NULL
      ORDER BY ts_decided`,
  );
  console.log(`\n[B] decided book_candidate rows: ${ids.length} row(s)`);
  let repaired = 0;
  let skipped = 0;
  for (const id of ids) {
    const row = proposals.get(id);
    if (!row || !row.action_taken) {
      skipped++;
      continue;
    }
    const new_status = BOOK_STATUS_MAP[row.action_taken];
    if (!new_status) {
      // e.g. a denied row — the resolver never runs on those; the note
      // legitimately stays awaiting_decision. Not this repair's damage.
      console.log(`  [B] ${id} — action '${row.action_taken}' has no note status; skipping`);
      skipped++;
      continue;
    }
    const payload = parse_payload(row);
    const note_path =
      typeof payload?.queue_note_path === 'string' ? payload.queue_note_path : null;
    if (!note_path) {
      console.log(`  [B] ${id} — payload_json missing queue_note_path; skipping`);
      errors++;
      skipped++;
      continue;
    }
    const fm = read_clipping_frontmatter(memory, note_path);
    if (!fm) {
      console.log(`  [B] ${id} — queue note missing/unreadable (${note_path}); skipping`);
      skipped++;
      continue;
    }
    if (fm.status !== 'awaiting_decision') {
      console.log(`  [B] ${id} — note already at status '${String(fm.status)}'; ok`);
      skipped++;
      continue;
    }
    const patch = {
      status: new_status,
      decided_at: row.ts_decided ?? new Date().toISOString(),
      decided_action: row.action_taken,
    };
    if (!APPLY) {
      console.log(
        `  [B] would patch ${note_path}: status awaiting_decision → ${new_status} (${id})`,
      );
      repaired++;
      continue;
    }
    patch_clipping_frontmatter(memory, note_path, patch);
    console.log(`  [B] patched ${note_path}: status → ${new_status} (${id})`);
    repaired++;
  }
  return { repaired, skipped };
}

/* ------------------------------------------------------------------ */
/* C. denied trusted_source_addition rows missing their denial line     */
/* ------------------------------------------------------------------ */

function repair_denials(): { repaired: number; skipped: number } {
  const ids = proposal_ids(
    `SELECT id FROM proposals
      WHERE kind = 'trusted_source_addition' AND status = 'denied'
      ORDER BY ts_decided`,
  );
  console.log(`\n[C] denied trusted_source_addition rows: ${ids.length} row(s)`);
  // denied_domains_for is per-target; cache the read so 22 rows don't
  // re-parse the file 22 times.
  const denied_cache = new Map<string, Set<string>>();
  const denied_for = (target: string): Set<string> => {
    let set = denied_cache.get(target);
    if (!set) {
      set = denied_domains_for(memory, target);
      denied_cache.set(target, set);
    }
    return set;
  };
  const lines: string[] = [];
  const backfilled: Array<{ domain: string; target: string }> = [];
  let skipped = 0;
  for (const id of ids) {
    const row = proposals.get(id);
    const payload = row ? parse_payload(row) : null;
    const domain = typeof payload?.domain === 'string' ? payload.domain : null;
    const target =
      typeof payload?.target_specialist_id === 'string'
        ? payload.target_specialist_id
        : null;
    if (!row || !payload || !domain || !target) {
      console.log(`  [C] ${id} — payload_json missing domain/target; skipping`);
      errors++;
      skipped++;
      continue;
    }
    if (denied_for(target).has(domain.toLowerCase())) {
      console.log(`  [C] ${id} — \`${domain}\` (${target}) already in denials file; ok`);
      skipped++;
      continue;
    }
    const tier = payload.tier === 1 || payload.tier === 2 ? payload.tier : '?';
    const stamp = row.ts_decided ?? row.ts_created;
    // EXACT format the reject resolver appends — sources_store's
    // DENIAL_LINE_RE parses it back for denied_domains_for.
    lines.push(
      `- **${stamp}** — \`${domain}\` proposed for ${target} Tier ${tier}, ` +
        `denied. Cordelia must not re-propose.`,
    );
    backfilled.push({ domain, target });
    // Keep the cache honest for duplicate rows within this run.
    denied_for(target).add(domain.toLowerCase());
    console.log(
      `  [C] ${APPLY ? 'backfilling' : 'would backfill'}: \`${domain}\` (${target}) denied ${stamp} (${id})`,
    );
  }
  if (APPLY && lines.length > 0) {
    const file_exists = memory.read_note(DENIALS_PATH) !== null;
    const header = file_exists
      ? ''
      : 'Domains denied as trusted sources — one line per denial, in the ' +
        "format the trusted_source_addition 'reject' resolver appends. " +
        'Every proposal-filing acquisition path skips these forever; ' +
        'remove a line to lift a denial.\n\n';
    memory.append_to_note(DENIALS_PATH, header + lines.join('\n'));
    // Format-drift canary: everything just written must parse back.
    const missing = backfilled.filter(
      ({ domain, target }) => !denied_domains_for(memory, target).has(domain.toLowerCase()),
    );
    for (const { domain, target } of missing) {
      console.error(
        `  [C] CANARY: \`${domain}\` (${target}) did not parse back via denied_domains_for — ` +
          `denial line format drifted from sources_store's DENIAL_LINE_RE`,
      );
      errors++;
    }
  }
  return { repaired: lines.length, skipped };
}

/* ------------------------------------------------------------------ */

async function main(): Promise<void> {
  console.log(
    `${REPAIR_TAG} — ${APPLY ? 'APPLY' : 'DRY RUN'}` +
      `${SKIP_SOURCES ? ' (sources skipped)' : ''}\n` +
      `  db:    ${DB_PATH}\n  vault: ${VAULT_ROOT}\n  cwd:   ${process.cwd()}`,
  );

  const a = SKIP_SOURCES
    ? { repaired: 0, skipped: 0 }
    : await repair_unapplied_sources();
  if (SKIP_SOURCES) console.log('\n[A] skipped (--skip-sources)');
  const b = repair_book_notes();
  const c = repair_denials();

  console.log(
    `\nSummary (${APPLY ? 'applied' : 'dry-run'}): ` +
      `A sources=${a.repaired} B book-notes=${b.repaired} C denials=${c.repaired} ` +
      `(skipped/ok: ${a.skipped}/${b.skipped}/${c.skipped}; errors: ${errors})`,
  );
  if (!APPLY) {
    console.log('DRY RUN — nothing written. Re-run with --apply to repair.');
  } else {
    memory.log_action({
      intent_id: ulid(),
      agent: 'orchestrator',
      tool_name: REPAIR_TAG,
      tool_input: { apply: true, skip_sources: SKIP_SOURCES },
      execution_result: {
        sources_repaired: a.repaired,
        book_notes_patched: b.repaired,
        denials_backfilled: c.repaired,
        errors,
      },
    });
  }
  if (errors > 0) process.exit(1);
}

await main();
