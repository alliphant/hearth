/**
 * Public-figure reclassification (2026-07-29) — one-shot, idempotent,
 * DRY-RUN BY DEFAULT, and it will not touch a row you have not named.
 *
 * THE DEFECT (data, so the new code guards can't retroactively fix it):
 * research filed public officials into the household's PERSONAL relationship
 * graph. `People/Chris-Barrett.md` — a Pleasantville councilmember Jasper has
 * never met — sat there as `relationship: acquaintance`, `tone: warm`, with
 * empty gift_history / likes / important_dates, and his brief started naming
 * Barrett as though they were acquainted. Two 2026 CD-3 primary candidates
 * (Alex Kelloff, Kyle Doster) landed the same way, each with a note whose only
 * content is "Deep research found no grounded public details".
 *
 * Same notes also ACCRETED: Barrett's held FOUR near-identical
 * "## Deep research (…)" sections repeating the same four facts, because each
 * pass appended blindly.
 *
 * WHY THIS ASKS INSTEAD OF DECIDING. "Is this person in the household's life?"
 * is a semantic call, and the durable fix makes it the researching model's
 * (`subject_kind: 'public_figure'` → `relationship: 'public_figure'`). A
 * migration cannot re-run that judgment, and a hard-coded name list in a script
 * is the carve-out this repo bans. So the script DERIVES candidates
 * structurally — a research-created note with no contact surface — prints the
 * evidence for each, and reclassifies only the ids passed via `--ids`. A
 * massage therapist Jasper actually sees is structurally identical to a
 * councilmember he doesn't; only a human can tell them apart, so a human does.
 *
 * WHAT IT DOES, per named id:
 *   1. `relationship` → `public_figure` in the note's frontmatter. Everything
 *      else in the frontmatter is preserved byte-for-byte.
 *   2. Collapses repeated "## Deep research" sections to the LAST (newest) one,
 *      via the SAME `strip_body_sections` the tool now uses.
 *   3. Dismisses the research-driven `mention` observations for that person
 *      ("Came up in conversation: 'Give me the lowdown on Chris Barrett'") —
 *      a reversible flag flip, so the evidence survives.
 *
 * WHAT IT NEVER DOES: delete a note, a person row, an observation, a synthesis
 * row, or a research_investigations row. `research_investigations.person_id`
 * points at these people (6 rows live); the notes stay, so nothing orphans.
 * Reclassifying is enough — `is_non_contact` now excludes `public_figure` from
 * every relationship surface (brief occasions, gift loop, cadence nudges,
 * Friends tab, meeting prep, dossier synthesis, chat-fact enrichment), while
 * `who_is` still answers "who is Chris Barrett".
 *
 * The ingestor reprojects the changed notes within ~500ms (chokidar), so the
 * `people.relationship` column follows on its own. No rebuild needed.
 *
 * Usage (on the LLM host):
 *   docker exec -w /app hearth-orchestrator bun run scripts/migrate-public-figures.ts
 *   docker exec -w /app hearth-orchestrator bun run scripts/migrate-public-figures.ts \
 *     --ids=p_q0j94c,p_l23rqd,p_ehyon1 --apply
 */
import { Database } from 'bun:sqlite';
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import matter from 'gray-matter';
import { strip_body_sections } from '../src/agents/scribe/tools/upsert_person_note';

const DEEP_RESEARCH_HEADING = '## Deep research';

/** Frontmatter fields whose presence means a human (or a real interaction) has
 *  treated this person as a contact. Any one of them disqualifies a candidate —
 *  a public figure has no phone number you'd call and no gift you'd buy. */
const CONTACT_SURFACE_FIELDS = [
  'birthday',
  'contact_cadence',
  'last_contacted',
  'address',
  'how_we_met',
  'preferred_name',
] as const;

export interface FigureCandidate {
  id: string;
  name: string;
  note_path: string;
  relationship: string;
  /** Research investigations that produced this note. */
  investigations: number;
  /** Repeated "## Deep research" sections currently in the body. */
  deep_research_sections: number;
  /** Non-research body content, in characters — high means a human wrote here. */
  other_body_chars: number;
  /** Research-driven `mention` observations that would be dismissed. */
  dismissable_mentions: number;
  /** Why it is NOT a candidate, when it isn't. */
  disqualified_by: string[];
}

/** Count sections whose heading line starts with `heading`. */
export function count_sections(body: string, heading: string): number {
  return body.split('\n').filter((l) => l.startsWith(heading)).length;
}

/**
 * Derive candidates from the vault + DB. READ-ONLY and pure w.r.t. both, so the
 * dry run and the apply run agree by construction. A candidate is a person note
 * that (a) a research investigation created, (b) carries no contact surface, and
 * (c) whose body is essentially nothing but research output.
 */
export function plan_public_figures(db: Database, vault_root: string): FigureCandidate[] {
  const people_dir = resolve(vault_root, 'People');
  if (!existsSync(people_dir)) return [];

  const out: FigureCandidate[] = [];
  for (const file of readdirSync(people_dir).filter((f) => f.endsWith('.md'))) {
    const note_path = `People/${file}`;
    const parsed = matter(readFileSync(resolve(people_dir, file), 'utf8'));
    const fm = parsed.data as Record<string, unknown>;
    if (fm.type !== 'person' || typeof fm.id !== 'string') continue;

    const id = fm.id;
    const relationship = typeof fm.relationship === 'string' ? fm.relationship : '';
    const body = parsed.content;

    const investigations = (
      db
        .prepare(`SELECT COUNT(*) AS n FROM research_investigations WHERE person_id = ?`)
        .get(id) as { n: number }
    ).n;
    const deep_research_sections = count_sections(body, DEEP_RESEARCH_HEADING);
    const other_body_chars = strip_body_sections(body, DEEP_RESEARCH_HEADING).trim().length;
    // `person_observations` is created lazily by its store, not by open_db — a
    // db that has never run the observers legitimately has no such table.
    let dismissable_mentions = 0;
    try {
      dismissable_mentions = (
        db
          .prepare(
            `SELECT COUNT(*) AS n FROM person_observations
               WHERE person_id = ? AND kind = 'mention' AND dismissed = 0`,
          )
          .get(id) as { n: number }
      ).n;
    } catch {
      /* table absent — nothing to dismiss */
    }

    const disqualified_by: string[] = [];
    if (relationship === 'public_figure') disqualified_by.push('already public_figure');
    if (relationship === 'self') disqualified_by.push('the owner\'s own note');
    if ('gedcom_xref' in fm || /-ancestor\.md$/i.test(note_path)) {
      disqualified_by.push('genealogy import');
    }
    // A relationship a human deliberately chose is never second-guessed here;
    // `acquaintance` is the value the pre-fix writeback produced by default.
    if (!['acquaintance', ''].includes(relationship) && relationship !== 'public_figure') {
      disqualified_by.push(`relationship '${relationship}' was set deliberately`);
    }
    if (investigations === 0) disqualified_by.push('no research investigation created it');
    for (const f of CONTACT_SURFACE_FIELDS) {
      if (fm[f] !== undefined && fm[f] !== null && fm[f] !== '') {
        disqualified_by.push(`has ${f} — treated as a contact`);
      }
    }
    const contact = (fm.contact ?? {}) as Record<string, unknown>;
    const emails = Array.isArray(contact.email) ? contact.email.length : 0;
    const phones = Array.isArray(contact.phone) ? contact.phone.length : 0;
    if (emails + phones > 0) disqualified_by.push('has email/phone — treated as a contact');
    for (const f of ['gift_history', 'important_dates', 'anniversaries', 'pets'] as const) {
      if (Array.isArray(fm[f]) && (fm[f] as unknown[]).length > 0) {
        disqualified_by.push(`has ${f} — treated as a contact`);
      }
    }
    if (other_body_chars > 400) {
      disqualified_by.push(`${other_body_chars} chars of non-research body content`);
    }

    // Report every person note that research touched, candidate or not — the
    // dry run is an audit, and "why this one is NOT being changed" is the half
    // that makes the list reviewable.
    if (investigations > 0 || relationship === 'public_figure') {
      out.push({
        id, name: String(fm.name ?? file), note_path, relationship,
        investigations, deep_research_sections, other_body_chars,
        dismissable_mentions, disqualified_by,
      });
    }
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

export interface ApplyResult {
  reclassified: string[];
  sections_collapsed: number;
  mentions_dismissed: number;
  skipped: Array<{ id: string; why: string }>;
}

/** Apply to the NAMED ids only. Idempotent — a second run finds nothing to do. */
export function apply_public_figures(
  db: Database,
  vault_root: string,
  candidates: FigureCandidate[],
  ids: string[],
): ApplyResult {
  const res: ApplyResult = {
    reclassified: [], sections_collapsed: 0, mentions_dismissed: 0, skipped: [],
  };
  const by_id = new Map(candidates.map((c) => [c.id, c]));
  const now = new Date().toISOString();

  for (const id of ids) {
    const c = by_id.get(id);
    if (!c) {
      res.skipped.push({ id, why: 'not among the derived candidates' });
      continue;
    }
    if (c.disqualified_by.length > 0) {
      res.skipped.push({ id, why: c.disqualified_by.join('; ') });
      continue;
    }

    const abs = resolve(vault_root, c.note_path);
    const parsed = matter(readFileSync(abs, 'utf8'));
    const fm = { ...(parsed.data as Record<string, unknown>) };
    fm.relationship = 'public_figure';

    // Keep the LAST (newest) research section; strip the rest. Reuses the tool's
    // helper so the migration and the live writeback can't disagree on what a
    // section is.
    let body = parsed.content;
    if (c.deep_research_sections > 1) {
      const lines = body.split('\n');
      const starts = lines
        .map((l, i) => (l.startsWith(DEEP_RESEARCH_HEADING) ? i : -1))
        .filter((i) => i >= 0);
      const last = starts[starts.length - 1]!;
      const newest = lines.slice(last).join('\n').trimEnd();
      const kept = strip_body_sections(body, DEEP_RESEARCH_HEADING);
      body = `${kept ? `${kept}\n\n` : ''}${newest}\n`;
      res.sections_collapsed += c.deep_research_sections - 1;
    }
    writeFileSync(abs, matter.stringify(body, fm), 'utf8');
    res.reclassified.push(id);

    // Reversible: a flag, not a delete. The observation row (and its provenance)
    // survives for anyone auditing how a councilmember got here.
    try {
      const upd = db
        .prepare(
          `UPDATE person_observations SET dismissed = 1, ts = ?
             WHERE person_id = ? AND kind = 'mention' AND dismissed = 0`,
        )
        .run(now, id);
      res.mentions_dismissed += Number(upd.changes ?? 0);
    } catch {
      /* table absent — nothing to dismiss */
    }
  }
  return res;
}

if (import.meta.main) {
  const apply = process.argv.includes('--apply');
  const ids_arg = process.argv.find((a) => a.startsWith('--ids='));
  const ids = ids_arg
    ? ids_arg.slice('--ids='.length).split(',').map((s) => s.trim()).filter(Boolean)
    : [];
  const db_path = process.env.HEARTH_DB_PATH ?? './data/hearth.db';
  const vault_root =
    process.env.HEARTH_VAULT_ROOT ?? resolve(process.env.HOME ?? '.', 'vault-friday');

  // bun:sqlite rejects an explicit `{readonly: false}` with SQLITE_MISUSE —
  // read-write is the default and must be requested by OMITTING the option.
  const db = apply ? new Database(db_path) : new Database(db_path, { readonly: true });
  const candidates = plan_public_figures(db, vault_root);

  console.log(
    `public-figure reclassification — ${apply ? 'APPLY' : 'DRY RUN'}\n` +
      `  db:    ${db_path}\n  vault: ${vault_root}\n`,
  );
  if (candidates.length === 0) console.log('  no research-created person notes found');
  for (const c of candidates) {
    const ok = c.disqualified_by.length === 0;
    console.log(
      `  ${ok ? 'CANDIDATE' : 'skip     '}  ${c.id}  ${c.name}  (${c.relationship})\n` +
        `${' '.repeat(15)}${c.investigations} investigation(s), ` +
        `${c.deep_research_sections} research section(s), ` +
        `${c.other_body_chars} other body chars, ` +
        `${c.dismissable_mentions} mention obs\n` +
        (ok ? '' : `${' '.repeat(15)}not a candidate: ${c.disqualified_by.join('; ')}\n`),
    );
  }

  if (!apply) {
    console.log(
      'Dry run — nothing written. Review the CANDIDATE rows above, then re-run with\n' +
        '  --ids=<comma-separated ids you confirm are public figures> --apply\n' +
        'Nothing is deleted: notes are reclassified, duplicate research sections\n' +
        'collapse to the newest, and mention observations are dismissed (reversible).',
    );
  } else if (ids.length === 0) {
    console.log('--apply given with no --ids= — refusing to guess. Nothing written.');
  } else {
    const res = apply_public_figures(db, vault_root, candidates, ids);
    console.log(
      `\nApplied.\n` +
        `  reclassified:       ${res.reclassified.length} (${res.reclassified.join(', ') || '—'})\n` +
        `  sections collapsed: ${res.sections_collapsed}\n` +
        `  mentions dismissed: ${res.mentions_dismissed}`,
    );
    for (const s of res.skipped) console.log(`  skipped ${s.id}: ${s.why}`);
    console.log('\nThe ingestor reprojects the changed notes within ~500ms; no rebuild needed.');
  }
  db.close();
}
