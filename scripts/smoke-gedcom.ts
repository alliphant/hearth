export {};
/**
 * smoke:gedcom — proves the GEDCOM import path end-to-end.
 *
 * Self-contained: temp vault + temp DB, no orchestrator dependency.
 * Builds a tiny GEDCOM string covering the cases Marguerite cares
 * about (multi-generation, French names with diacritics, missing
 * fields, FAMC/FAMS cross-references), runs `import_gedcom`, and
 * asserts:
 *   - Each individual landed as a People/<name>-ancestor.md note
 *   - Frontmatter has gedcom_xref, dates, sources
 *   - Wikilinks connect parents → children correctly
 *   - The summary note exists at Knowledge/Genealogy/imports/<date>-<label>.md
 *   - Re-running is idempotent (same xref → update, not duplicate)
 */

import { mkdtempSync, mkdirSync, readFileSync, rmSync, readdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { open_db } from '@memory/stores/structured';
import { MemoryClient } from '@memory/client';
import { ConfigLLMRouter } from '@core/router';
import { import_gedcom } from '@specialists/kate/tools/import_gedcom';
import type { ToolContext } from '@core/tool';
import matter from 'gray-matter';

const tests: Array<[string, boolean]> = [];
function check(label: string, ok: boolean): void {
  tests.push([label, ok]);
  console.log(`  ${ok ? '✓' : '✗'} ${label}`);
}

const TINY_GEDCOM = `0 HEAD
1 SOUR Hearth-smoke
1 GEDC
2 VERS 5.5.1
1 CHAR UTF-8
0 @I1@ INDI
1 NAME Jean-Baptiste /Tremblay/
1 SEX M
1 BIRT
2 DATE 1820
2 PLAC Sainte-Anne-de-Beaupré, Québec
1 DEAT
2 DATE 1890
2 PLAC Québec
1 FAMS @F1@
1 SOUR BAnQ parish register, 1820, p.45
0 @I2@ INDI
1 NAME Alex /Côté/
1 SEX F
1 BIRT
2 DATE 1825
2 PLAC Beauport
1 FAMS @F1@
0 @I3@ INDI
1 NAME Louis /Tremblay/
1 SEX M
1 BIRT
2 DATE 1850
2 PLAC Québec
1 FAMC @F1@
1 FAMS @F2@
0 @I4@ INDI
1 NAME Élise /Lavoie/
1 SEX F
1 FAMS @F2@
0 @I5@ INDI
1 NAME Pierre /Tremblay/
1 SEX M
1 BIRT
2 DATE 1875
1 FAMC @F2@
0 @F1@ FAM
1 HUSB @I1@
1 WIFE @I2@
1 CHIL @I3@
1 MARR
2 DATE 1848
0 @F2@ FAM
1 HUSB @I3@
1 WIFE @I4@
1 CHIL @I5@
0 TRLR
`;

async function main() {
  const root = mkdtempSync(resolve(tmpdir(), 'hearth-gedcom-'));
  const vault = resolve(root, 'vault');
  mkdirSync(vault, { recursive: true });
  const db = open_db(resolve(root, 'hearth.db'));
  const memory = new MemoryClient({ vault_root: vault, db });
  const llm = new ConfigLLMRouter('./config/llm-roles.yaml', {
    ollama_base_url: 'http://127.0.0.1:1', // unused — tool doesn't call LLM
  });
  const ctx: ToolContext = { memory, llm, now: new Date(), intent_id: 'smoke' };

  console.log('→ #1 — Inline GEDCOM import');
  const r1 = await import_gedcom.execute(
    { gedcom_text: TINY_GEDCOM, source_label: 'tremblay-tree', limit: 2000 },
    ctx,
  );
  check(
    `Imported 5 individuals (got ${r1.individuals_imported})`,
    r1.individuals_imported === 5,
  );
  check(
    `Updated 0 on first run (got ${r1.individuals_updated})`,
    r1.individuals_updated === 0,
  );
  check(
    `Processed 2 families (got ${r1.families_processed})`,
    r1.families_processed === 2,
  );
  check(
    `Summary note path correct (got ${r1.summary_note_path})`,
    r1.summary_note_path.startsWith('Knowledge/Genealogy/imports/') &&
      r1.summary_note_path.includes('tremblay-tree'),
  );

  console.log('\n→ #2 — Individual notes land at People/<name>-ancestor.md');
  const people_dir = resolve(vault, 'People');
  const files = existsSync(people_dir) ? readdirSync(people_dir) : [];
  const ancestor_files = files.filter((f) => f.endsWith('-ancestor.md'));
  check(
    `5 ancestor files in People/ (got ${ancestor_files.length})`,
    ancestor_files.length === 5,
  );

  console.log('\n→ #3 — Frontmatter preserves GEDCOM data + sources');
  const jb_path = ancestor_files.find((f) =>
    f.toLowerCase().includes('jean') && f.toLowerCase().includes('tremblay'),
  );
  check(`Jean-Baptiste's note exists (matched: ${jb_path ?? 'none'})`, Boolean(jb_path));
  if (jb_path) {
    const parsed = matter(readFileSync(resolve(people_dir, jb_path), 'utf8'));
    const fm = parsed.data as Record<string, unknown>;
    check(`gedcom_xref preserved (got ${fm.gedcom_xref})`, fm.gedcom_xref === '@I1@');
    check(`birth_date preserved (got ${fm.birth_date})`, fm.birth_date === '1820');
    check(`birth_place preserves diacritics (got ${fm.birth_place})`, typeof fm.birth_place === 'string' && (fm.birth_place as string).includes('Sainte-Anne'));
    check(
      `sources captured (got ${JSON.stringify(fm.sources)})`,
      Array.isArray(fm.sources) && (fm.sources as string[]).some((s) => s.includes('BAnQ')),
    );
    check(
      `relationship=family + friday_managed=true`,
      fm.relationship === 'family' && fm.friday_managed === true,
    );
  }

  console.log("\n→ #4 — Wikilinks connect Louis (child) to his parents");
  const louis_path = ancestor_files.find((f) =>
    f.toLowerCase().includes('louis') && f.toLowerCase().includes('tremblay'),
  );
  if (louis_path) {
    const body = readFileSync(resolve(people_dir, louis_path), 'utf8');
    const has_parents = body.includes('**Parents**');
    const has_jb_link =
      body.includes('Jean-Baptiste') &&
      /\[\[[^\]]*Jean[^\]]*\]\]/.test(body);
    const has_marie_link =
      body.includes('Alex') &&
      /\[\[[^\]]*Alex[^\]]*\]\]/.test(body);
    check(
      `Louis's note has a Parents section (got ${has_parents})`,
      has_parents,
    );
    check(
      `Wikilinks to Jean-Baptiste + Alex (jb=${has_jb_link}, marie=${has_marie_link})`,
      has_jb_link && has_marie_link,
    );
    const has_son_link = /\[\[[^\]]*Pierre[^\]]*\]\]/.test(body);
    check(
      `Wikilink to son Pierre (got ${has_son_link})`,
      has_son_link,
    );
  } else {
    check('Louis note missing', false);
  }

  console.log('\n→ #5 — Summary note has roster + counts');
  const summary_abs = resolve(vault, r1.summary_note_path);
  if (existsSync(summary_abs)) {
    const summary_body = readFileSync(summary_abs, 'utf8');
    check(
      `Summary mentions 5 imported`,
      summary_body.includes('5 new'),
    );
    check(
      `Roster includes Jean-Baptiste`,
      summary_body.includes('Jean-Baptiste'),
    );
  } else {
    check('Summary note exists', false);
  }

  console.log('\n→ #6 — Idempotent re-import (xref match → update, not duplicate)');
  const r2 = await import_gedcom.execute(
    { gedcom_text: TINY_GEDCOM, source_label: 'tremblay-tree', limit: 2000 },
    ctx,
  );
  check(
    `Second run: 0 new imports (got ${r2.individuals_imported})`,
    r2.individuals_imported === 0,
  );
  check(
    `Second run: 5 updated (got ${r2.individuals_updated})`,
    r2.individuals_updated === 5,
  );
  const ancestor_after = readdirSync(people_dir).filter((f) =>
    f.endsWith('-ancestor.md'),
  );
  check(
    `Still 5 ancestor files (got ${ancestor_after.length}) — no duplicates`,
    ancestor_after.length === 5,
  );

  // cleanup
  db.close();
  rmSync(root, { recursive: true, force: true });

  console.log('\n' + '─'.repeat(60));
  const passed = tests.filter(([, ok]) => ok).length;
  const failed = tests.filter(([, ok]) => !ok).length;
  console.log(`Results: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log('✗ SMOKE FAILED');
    process.exit(1);
  } else {
    console.log('✓ SMOKE PASSED');
    process.exit(0);
  }
}

main().catch((err) => {
  console.error('smoke crashed:', err);
  process.exit(1);
});
