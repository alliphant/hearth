/**
 * Bootstrap the namespace structure for the seven specialists in the vault.
 * Idempotent — won't overwrite existing files. Run via `bun run init:vault`.
 *
 * Creates:
 *   ~/vault-friday/
 *     Knowledge/
 *       Kate/                   memory.md + jasper_style.md + skills/
 *       Vivian/                 memory.md + skills/
 *       Anya/                   memory.md + skills/
 *       Eleanor/                memory.md + skills/
 *       Marguerite/             memory.md + skills/
 *       Iris/                   memory.md + skills/
 *       Cassandra/              memory.md + skills/
 *       Finance/                (Vivian's library)
 *       Veterinary/             (Anya's library)
 *       Garden/ Cooking/        (Eleanor's libraries)
 *       Genealogy/              (Marguerite's library)
 *       HomeAuto/ EV/           (Iris's libraries)
 *       Security/               (Cassandra's library)
 *     Animals/
 *       Bailey.md, Mango.md      (seed files for Anya)
 *
 * Avatars are not created — user adds avatar.png to each Knowledge/<Name>/
 * manually. The UI falls back to initials if missing.
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const VAULT_ROOT =
  process.env.HEARTH_VAULT_ROOT ?? `${process.env.HOME}/vault-friday`;

interface Specialist {
  id: string;
  display: string;
  role: string;
  libraries: string[];
}

const STAFF: Specialist[] = [
  { id: 'kate', display: 'Kate', role: 'Chief of Staff', libraries: [] },
  { id: 'vivian', display: 'Vivian', role: 'Finance Officer', libraries: ['Finance'] },
  { id: 'anya', display: 'Anya', role: 'Veterinarian', libraries: ['Veterinary'] },
  {
    id: 'eleanor',
    display: 'Eleanor',
    role: 'Master Gardener',
    libraries: ['Garden', 'Cooking'],
  },
  {
    id: 'marguerite',
    display: 'Marguerite',
    role: 'Family Historian',
    libraries: ['Genealogy'],
  },
  {
    id: 'iris',
    display: 'Iris',
    role: 'EV & Home Automation Specialist',
    libraries: ['HomeAuto', 'EV'],
  },
  {
    id: 'cassandra',
    display: 'Cassandra',
    role: 'Security Officer',
    libraries: ['Security'],
  },
  {
    id: 'brigid',
    display: 'Brigid',
    role: 'Cook',
    libraries: [],
  },
  {
    id: 'astrid',
    display: 'Astrid',
    role: 'Trainer',
    libraries: [],
  },
  {
    id: 'ruby',
    display: 'Ruby',
    role: 'Pleasantville Civic Correspondent',
    // Her per-member tracker files land in Knowledge/Ruby/council/.
    // The broader civic library (council agenda PDFs, budget docs,
    // ballot guides) lands in Knowledge/Pleasantville/ and a few
    // adjacent civic folders, which the libraries[] field below
    // scaffolds.
    libraries: ['Pleasantville', 'Civic'],
  },
  {
    id: 'kristi',
    display: 'Kristi',
    role: 'Workstation Competitive-Intelligence Analyst',
    // Her ingested clippings + synthesis notes land in Knowledge/Kristi/library
    // (scaffolded by the per-specialist library folder); her structured data
    // lives in the separate kristi_workstations.db, not the vault.
    libraries: [],
  },
];

function ensure_dir(abs: string): void {
  if (!existsSync(abs)) {
    mkdirSync(abs, { recursive: true });
    console.log(`  mkdir ${abs}`);
  }
}

function write_if_missing(abs: string, content: string): void {
  if (existsSync(abs)) return;
  ensure_dir(dirname(abs));
  writeFileSync(abs, content, 'utf8');
  console.log(`  write ${abs}`);
}

function memory_header(name: string): string {
  return (
    `# ${name}'s memory\n\n` +
    `This file accumulates ${name}'s long-term observations about Jasper\n` +
    `and her domain. She writes to it via her memory-write tool. Entries\n` +
    `are dated. You may edit or curate freely; ${name} respects this file\n` +
    `as her canonical long-term notes and won't overwrite older content.\n\n` +
    `<!-- entries below -->\n`
  );
}

function jasper_style_header(): string {
  return (
    `# Jasper's communication style — Kate's notes\n\n` +
    `Dated bullets. Kate appends after seeing how Jasper edits her drafts.\n` +
    `Cap: 200 entries; oldest rotates out.\n\n` +
    `<!-- entries below -->\n`
  );
}

function animal_frontmatter(name: string, kind: string): string {
  return (
    `---\n` +
    `type: animal\n` +
    `name: ${name}\n` +
    `species: ${kind}\n` +
    `friday_managed: true\n` +
    `---\n\n` +
    `# ${name}\n\n` +
    `Seed file created by init-staff-vault. Anya writes here; Jasper\n` +
    `edits freely. Add medications, conditions, vet visits, and any\n` +
    `notes worth keeping over time.\n`
  );
}

function main(): void {
  console.log(`Bootstrapping staff namespaces under ${VAULT_ROOT}`);
  ensure_dir(VAULT_ROOT);
  ensure_dir(resolve(VAULT_ROOT, 'Knowledge'));
  ensure_dir(resolve(VAULT_ROOT, 'Animals'));

  for (const s of STAFF) {
    const home = resolve(VAULT_ROOT, 'Knowledge', s.display);
    ensure_dir(home);
    ensure_dir(resolve(home, 'skills'));
    write_if_missing(resolve(home, 'memory.md'), memory_header(s.display));
    if (s.id === 'kate') {
      write_if_missing(resolve(home, 'jasper_style.md'), jasper_style_header());
    }
    for (const lib of s.libraries) {
      ensure_dir(resolve(VAULT_ROOT, 'Knowledge', lib));
    }
  }

  // Anya's primary write target: per-dog files.
  write_if_missing(resolve(VAULT_ROOT, 'Animals', 'Bailey.md'), animal_frontmatter('Bailey', 'dog'));
  write_if_missing(resolve(VAULT_ROOT, 'Animals', 'Mango.md'), animal_frontmatter('Mango', 'dog'));

  // Brigid's per-user namespace (v0.5 prototype for household-shared
  // specialists) — plans/ folder + a seeded backlog.md so her writer
  // tool doesn't have to handle a missing parent on first save.
  const brigid_user = resolve(VAULT_ROOT, 'users', 'jasper', 'brigid');
  ensure_dir(brigid_user);
  ensure_dir(resolve(brigid_user, 'plans'));
  write_if_missing(
    resolve(brigid_user, 'backlog.md'),
    `# Brigid's recipe backlog\n\n` +
      `URLs Jasper sent to save for later, not scheduled into a specific week.\n` +
      `When a fresh week is being drafted, Brigid pulls candidates from this\n` +
      `file. Entries are timestamped; remove ones that get scheduled.\n\n` +
      `<!-- entries below -->\n`,
  );

  // Astrid's per-user namespace — sessions/ folder + seeded
  // observations.md and coaching-log.md so her writer tool has
  // somewhere to land on first append. profile.md is NOT seeded; its
  // absence is the cold-start signal that triggers the interview flow.
  const astrid_user = resolve(VAULT_ROOT, 'users', 'jasper', 'astrid');
  ensure_dir(astrid_user);
  ensure_dir(resolve(astrid_user, 'sessions'));
  write_if_missing(
    resolve(astrid_user, 'observations.md'),
    `# Astrid's running observations\n\n` +
      `Patterns Astrid is noticing about this user's training. Append-only\n` +
      `between weekly compactions; raw entries archive to observations.archive/\n` +
      `on compaction so nothing is lost. Newest first; capped at 200 live entries.\n\n` +
      `<!-- entries below -->\n`,
  );
  write_if_missing(
    resolve(astrid_user, 'coaching-log.md'),
    `# Astrid's coaching-decision log\n\n` +
      `Every push Astrid sent AND every push she chose NOT to send. Trigger,\n` +
      `decision, one-sentence why. Makes "you nagged me too much last week"\n` +
      `debuggable, and gives Beatrice concrete substrate for persona tuning.\n` +
      `Newest first; capped at 500 entries.\n\n` +
      `<!-- entries below -->\n`,
  );

  console.log('Done.');
}

main();
