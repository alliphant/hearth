/**
 * backfill-life-event-enrichment.ts — one-time sweep that applies the Phase 3
 * calendar inference (enrich_life_event) to life_event notes written BEFORE the
 * enricher shipped (2026-06-20). Those notes carry no `actionable` flag, so the
 * `scan_calendar_followups` trigger (which scans `actionable=1`) skips them even
 * though they're real upcoming vacations/appointments.
 *
 * For each life_event note it computes actionable / implications / participants
 * and merges them into the frontmatter (additive; idempotent — re-running
 * recomputes the same values). The vault note is the source of truth; re-project
 * afterwards (`ingestor:rebuild`) so the life_events table picks up the flags.
 *
 *   bun run scripts/backfill-life-event-enrichment.ts            # dry-run report
 *   bun run scripts/backfill-life-event-enrichment.ts --apply    # write the enrichment
 */
import { readdirSync, statSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import matter from 'gray-matter';
import { enrich_life_event } from '@core/calendar/enrich_life_event';

const VAULT_ROOT =
  process.env.HEARTH_VAULT_ROOT ?? join(process.env.HOME ?? '', 'vault-friday');
const APPLY = process.argv.includes('--apply');

function walk(dir: string): string[] {
  const out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (name.startsWith('.')) continue;
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

function main(): void {
  const files = walk(VAULT_ROOT);
  let scanned = 0;
  let enriched = 0;
  let actionable = 0;
  const by_cat: Record<string, number> = {};

  for (const abs of files) {
    let parsed: matter.GrayMatterFile<string>;
    try {
      parsed = matter(readFileSync(abs, 'utf8'));
    } catch {
      continue;
    }
    const fm = parsed.data as Record<string, unknown>;
    if (fm.type !== 'life_event') continue;
    scanned++;

    const category = typeof fm.category === 'string' ? fm.category : 'other';
    const result = enrich_life_event({
      title: typeof fm.title === 'string' ? fm.title : '',
      category,
      owner: typeof fm.owner === 'string' ? fm.owner : null,
      location: typeof fm.location === 'string' ? fm.location : null,
      note_path: abs,
      private_to: typeof fm.private_to === 'string' ? fm.private_to : 'household',
    });

    // Only rewrite if something actually changes (idempotent / minimal churn).
    const changed =
      fm.actionable !== result.actionable ||
      JSON.stringify(fm.implications ?? []) !== JSON.stringify(result.implications) ||
      JSON.stringify(fm.participants ?? []) !== JSON.stringify(result.participants);
    if (!changed) continue;

    enriched++;
    if (result.actionable) actionable++;
    by_cat[category] = (by_cat[category] ?? 0) + 1;

    if (APPLY) {
      const next = {
        ...fm,
        actionable: result.actionable,
        implications: result.implications,
        participants: result.participants,
      };
      writeFileSync(abs, matter.stringify(parsed.content, next), 'utf8');
    }
  }

  console.log(`life_event notes scanned:      ${scanned}`);
  console.log(`${APPLY ? 'enriched' : 'would enrich'}:               ${enriched}`);
  console.log(`  of which actionable:         ${actionable}`);
  console.log(`  by category:                 ${JSON.stringify(by_cat)}`);
  console.log(
    APPLY
      ? `\n✅ applied — now re-project: bun run ingestor:rebuild`
      : `\n(dry run — pass --apply to write, then re-project with ingestor:rebuild)`,
  );
}

main();
