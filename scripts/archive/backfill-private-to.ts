/**
 * backfill-private-to.ts — one-time vault sweep that stamps `private_to`
 * onto legacy notes so the per-user data cordon (2026-06-04) covers
 * content written before the per-tool stamping landed.
 *
 * The cordon treats an UNSET `private_to` as "visible to everyone." That
 * is safe only while the vault is the owner's single-user history; the
 * instant household/friend users read it, every unstamped personal note
 * leaks. This script closes that gap by classifying each note by path and
 * stamping a scope:
 *
 *   - per-user paths (Journal/<uid>/, users/<uid>/, memory_<uid>.md) → <uid>
 *   - shared household entities (People/, Places/)                  → household
 *     (a note flagged `sensitive: true` → owner)
 *   - owner style profile (Knowledge/Kate/jasper_style*)             → owner
 *   - system/meta (Knowledge/Trainer/**, notes with no `type`)      → LEFT NULL
 *   - everything else that carries a `type` (legacy = the owner's)  → owner id
 *
 * Notes that already declare `private_to` are never touched (explicit
 * scope wins). The write preserves the rest of the frontmatter and body
 * via gray-matter; the ingestor's `coerce_dates` walker handles any YAML
 * timestamps on re-projection.
 *
 * SAFETY: default is DRY-RUN (prints a classification report, writes
 * nothing). Pass `--apply` to write. BACK UP THE VAULT FIRST. After
 * applying, the ingestor re-projects on chokidar; or run
 * `bun run ingestor:rebuild` to reproject deterministically.
 *
 * Usage:
 *   bun run scripts/backfill-private-to.ts            # dry-run report
 *   bun run scripts/backfill-private-to.ts --apply    # write the stamps
 *   HEARTH_OWNER_USER_ID=jasper bun run scripts/backfill-private-to.ts
 */
import { readdirSync, statSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import matter from 'gray-matter';

const VAULT_ROOT =
  process.env.HEARTH_VAULT_ROOT ?? join(process.env.HOME ?? '', 'vault-friday');
const OWNER = process.env.HEARTH_OWNER_USER_ID ?? 'jasper';
const APPLY = process.argv.includes('--apply');

type Scope = string | null; // a private_to value, or null = leave unstamped

function walk(dir: string): string[] {
  const out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (name.startsWith('.')) continue; // skip dotfiles / .obsidian / .git
    if (name === '_attachments' || name === 'node_modules') continue;
    const abs = join(dir, name);
    let st;
    try {
      st = statSync(abs);
    } catch {
      continue;
    }
    if (st.isDirectory()) out.push(...walk(abs));
    else if (name.endsWith('.md')) out.push(abs);
  }
  return out;
}

/** First path segment after a known prefix, when it looks like a user id. */
function user_seg_after(rel: string, prefix: string): string | null {
  if (!rel.startsWith(prefix)) return null;
  const rest = rel.slice(prefix.length);
  const seg = rest.split('/')[0];
  if (!seg) return null;
  // user ids are snake_case lowercase; reject date-shaped journal files
  if (/^\d{4}-\d{2}-\d{2}/.test(seg)) return null;
  if (!/^[a-z][a-z0-9_]*$/.test(seg)) return null;
  return seg;
}

function classify(rel: string, fm: Record<string, unknown>): Scope {
  // Explicit scope always wins — never touch it.
  const existing = typeof fm.private_to === 'string' ? fm.private_to.trim() : '';
  if (existing.length > 0) return '__skip__';

  // Per-user namespaces.
  const ju = user_seg_after(rel, 'Journal/');
  if (ju) return ju;
  const uu = user_seg_after(rel, 'users/');
  if (uu) return uu;
  const mem = rel.match(/(?:^|\/)memory_([a-z][a-z0-9_]*)\.md$/);
  if (mem) return mem[1]!;

  // System / meta — left owner-global (NULL).
  if (rel.startsWith('Knowledge/Trainer/')) return null;
  // A note with no `type` isn't projected as user content (memory.md,
  // logs, scratch). Leave it; it isn't RAG-filtered by private_to.
  if (typeof fm.type !== 'string') return null;

  // Owner-sensitive style profile.
  if (rel.startsWith('Knowledge/Kate/jasper_style')) return 'owner';

  // Shared household entities.
  if (rel.startsWith('People/') || rel.startsWith('Places/')) {
    return fm.sensitive === true ? 'owner' : 'household';
  }

  // Everything else that carries real content predates multi-user and was
  // the owner's — cordon it to the owner.
  return OWNER;
}

function main(): void {
  const files = walk(VAULT_ROOT);
  const tally = new Map<string, number>();
  const changes: Array<{ rel: string; scope: string }> = [];
  let skipped_existing = 0;
  let left_null = 0;
  let parse_errors = 0;

  for (const abs of files) {
    const rel = relative(VAULT_ROOT, abs);
    let parsed;
    try {
      parsed = matter(readFileSync(abs, 'utf8'));
    } catch {
      parse_errors++;
      continue;
    }
    const fm = parsed.data as Record<string, unknown>;
    const scope = classify(rel, fm);

    if (scope === '__skip__') {
      skipped_existing++;
      continue;
    }
    if (scope === null) {
      left_null++;
      continue;
    }

    const bucket = scope === OWNER ? `owner(${OWNER})` : scope === 'household' ? 'household' : scope === 'owner' ? 'owner-sensitive' : `user(${scope})`;
    tally.set(bucket, (tally.get(bucket) ?? 0) + 1);
    changes.push({ rel, scope });

    if (APPLY) {
      parsed.data.private_to = scope;
      writeFileSync(abs, matter.stringify(parsed.content, parsed.data), 'utf8');
    }
  }

  console.log(`\nbackfill-private-to — ${APPLY ? 'APPLY' : 'DRY-RUN'}`);
  console.log(`vault: ${VAULT_ROOT}`);
  console.log(`owner id: ${OWNER}`);
  console.log(`scanned: ${files.length} .md files`);
  console.log(`already scoped (skipped): ${skipped_existing}`);
  console.log(`left unstamped (system/no-type): ${left_null}`);
  if (parse_errors) console.log(`parse errors (skipped): ${parse_errors}`);
  console.log(`\nwould stamp ${changes.length}:`);
  for (const [bucket, n] of [...tally.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${bucket}: ${n}`);
  }
  if (!APPLY) {
    console.log(`\nsample (first 20):`);
    for (const c of changes.slice(0, 20)) console.log(`  ${c.scope}\t${c.rel}`);
    console.log(`\nDRY-RUN — nothing written. Re-run with --apply (back up the vault first).`);
  } else {
    console.log(`\nApplied. Re-project: chokidar picks it up, or run \`bun run ingestor:rebuild\`.`);
  }
}

main();
