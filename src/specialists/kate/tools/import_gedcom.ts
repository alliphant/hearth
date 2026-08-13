/**
 * import_gedcom — Marguerite's bulk genealogy import.
 *
 * Accepts either:
 *   - `path`: a vault-relative path to a .ged file (e.g. one she
 *     uploaded to her library), OR
 *   - `gedcom_text`: the raw GEDCOM text as a string (small files).
 *
 * Projects:
 *   1. Each INDI → `People/<Name> (ancestor).md` with `type: person`
 *      frontmatter, relationship: family, friday_managed: true. The
 *      filename includes "ancestor" so the file matches Marguerite's
 *      `People/*-ancestor*.md` knowledge_scope glob.
 *   2. Family relationships (FAM) become wikilinks between people
 *      notes (spouse-of, parent-of, child-of) in the body.
 *   3. An import summary note at `Knowledge/Genealogy/imports/<date>-<source>.md`
 *      with counts + a roster.
 *
 * Cited sources (GEDCOM SOUR records) are preserved as `sources:` in
 * each person's frontmatter — Marguerite's citation discipline says
 * every claim ties to a source, and the GEDCOM import is no exception.
 *
 * Idempotent: re-running over the same GEDCOM matches by xref (stored
 * as `gedcom_xref` in frontmatter) and updates rather than duplicating.
 */

import { z } from 'zod';
import { createHash, randomBytes } from 'node:crypto';
import {
  existsSync,
  readFileSync,
  readdirSync,
} from 'node:fs';
import { resolve } from 'node:path';
import matter from 'gray-matter';
import { local_iso_date } from '@core/time';
import { ulid } from 'ulid';
import type { Tool, ToolContext } from '@core/tool';
import { stamp_private_to_if_needed } from '@memory/private_to';
import { parse_gedcom, type GedIndividual, type GedFamily } from '@core/gedcom_parser';

const InputSchema = z
  .object({
    path: z.string().optional(),
    gedcom_text: z.string().optional(),
    /** Filename label to use in the import summary (cosmetic only). */
    source_label: z.string().optional(),
    /** Cap on individuals imported in one pass (safety against huge trees). */
    limit: z.coerce.number().int().positive().max(5000).default(2000),
  })
  .refine((d) => Boolean(d.path) !== Boolean(d.gedcom_text), {
    message: 'Provide exactly one of `path` or `gedcom_text`.',
  });

const OutputSchema = z.object({
  individuals_imported: z.number(),
  individuals_updated: z.number(),
  families_processed: z.number(),
  summary_note_path: z.string(),
  notes_written: z.array(z.string()),
  warnings: z.array(z.string()),
});

type Input = z.infer<typeof InputSchema>;
type Output = z.infer<typeof OutputSchema>;

function gen_person_id(): string {
  // p_xxxxxx — 6 chars base32 lowercase, matching the rest of the
  // codebase's typed-id convention.
  const ALPHA = 'abcdefghijklmnopqrstuvwxyz234567';
  const bytes = randomBytes(6);
  let out = 'p_';
  for (let i = 0; i < 6; i++) out += ALPHA[bytes[i]! % 32];
  return out;
}

function sanitize_filename(name: string): string {
  const cleaned = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-zA-Z0-9 _-]/g, '')
    .trim()
    .replace(/\s+/g, '-');
  return cleaned || 'unnamed';
}

function ancestor_note_path(name: string): string {
  // Convention: `People/<Sanitized-Name>-ancestor.md` to match
  // Marguerite's `People/*-ancestor*.md` scope glob.
  return `People/${sanitize_filename(name)}-ancestor.md`;
}

interface ExistingMatch {
  note_path: string;
  frontmatter: Record<string, unknown>;
}

/**
 * Look for an existing People note with the same GEDCOM xref OR the
 * same display name. Match by xref first (most precise), then name
 * fall-through. Returns null if the People folder doesn't exist yet.
 */
function find_existing(
  vault_root: string,
  xref: string,
  name: string,
): ExistingMatch | null {
  const dir = resolve(vault_root, 'People');
  if (!existsSync(dir)) return null;
  const target_name = name.toLowerCase().trim();
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.md')) continue;
    const abs = resolve(dir, file);
    let parsed;
    try {
      parsed = matter(readFileSync(abs, 'utf8'));
    } catch {
      continue;
    }
    const fm = parsed.data as Record<string, unknown>;
    if (fm.gedcom_xref === xref) {
      return { note_path: `People/${file}`, frontmatter: fm };
    }
    if (typeof fm.name === 'string' && fm.name.toLowerCase().trim() === target_name) {
      return { note_path: `People/${file}`, frontmatter: fm };
    }
  }
  return null;
}

/**
 * Build the body markdown for an individual. Includes a "Family"
 * section with wikilinks to spouses + children + parents (resolved
 * via the family map). Wikilinks use the OTHER person's note basename
 * so Obsidian + Hearth's vault_index both find them.
 */
function render_body(
  ind: GedIndividual,
  families: Map<string, GedFamily>,
  xref_to_path: Map<string, string>,
): string {
  const lines: string[] = [];
  lines.push(`# ${ind.name}`);
  lines.push('');
  if (ind.given || ind.surname || ind.sex || ind.birth || ind.death) {
    if (ind.given && ind.surname) lines.push(`**Born**: ${ind.given} ${ind.surname}`);
    if (ind.sex) lines.push(`**Sex**: ${ind.sex}`);
    if (ind.birth?.date || ind.birth?.place) {
      const b: string[] = [];
      if (ind.birth.date) b.push(ind.birth.date);
      if (ind.birth.place) b.push(`in ${ind.birth.place}`);
      lines.push(`**Birth**: ${b.join(' ')}`);
    }
    if (ind.death?.date || ind.death?.place) {
      const d: string[] = [];
      if (ind.death.date) d.push(ind.death.date);
      if (ind.death.place) d.push(`in ${ind.death.place}`);
      lines.push(`**Death**: ${d.join(' ')}`);
    }
    lines.push('');
  }

  // Family relationships — wikilinks to other ancestor notes.
  const link = (xref: string): string | null => {
    const path = xref_to_path.get(xref);
    if (!path) return null;
    const base = path.replace(/^People\//, '').replace(/\.md$/, '');
    return `[[${base}]]`;
  };

  const parents: string[] = [];
  for (const famc of ind.child_of) {
    const fam = families.get(famc);
    if (!fam) continue;
    if (fam.husband && fam.husband !== ind.xref) {
      const l = link(fam.husband);
      if (l) parents.push(l);
    }
    if (fam.wife && fam.wife !== ind.xref) {
      const l = link(fam.wife);
      if (l) parents.push(l);
    }
  }

  const spouses: string[] = [];
  const children: string[] = [];
  for (const fams of ind.spouse_in) {
    const fam = families.get(fams);
    if (!fam) continue;
    const spouse_xref =
      fam.husband === ind.xref ? fam.wife : fam.wife === ind.xref ? fam.husband : undefined;
    if (spouse_xref) {
      const l = link(spouse_xref);
      if (l) spouses.push(l);
    }
    for (const child_xref of fam.children) {
      const l = link(child_xref);
      if (l) children.push(l);
    }
  }

  if (parents.length || spouses.length || children.length) {
    lines.push('## Family');
    lines.push('');
    if (parents.length) lines.push(`**Parents**: ${parents.join(', ')}`);
    if (spouses.length) lines.push(`**Spouse(s)**: ${spouses.join(', ')}`);
    if (children.length) lines.push(`**Children**: ${children.join(', ')}`);
    lines.push('');
  }

  if (ind.notes.length) {
    lines.push('## Notes from GEDCOM');
    lines.push('');
    for (const n of ind.notes) lines.push(`- ${n}`);
    lines.push('');
  }

  if (ind.sources.length) {
    lines.push('## Sources');
    lines.push('');
    for (const s of ind.sources) lines.push(`- ${s}`);
    lines.push('');
  }

  return lines.join('\n');
}

export const import_gedcom: Tool<Input, Output> = {
  name: 'import_gedcom',
  description:
    "Bulk-import a GEDCOM (.ged) genealogy file into the vault. Each individual becomes a People/<Name>-ancestor.md note with structured frontmatter (gedcom_xref, birth/death, sex), wikilinks for parents/spouses/children, and any sources preserved. Idempotent: re-running matches by gedcom_xref. Pass either `path` (vault-relative to a .ged file you've uploaded — typically under Knowledge/Marguerite/library/) OR `gedcom_text` (small inline content). Returns counts + path to a summary note under Knowledge/Genealogy/imports/.",
  risk: 'write_internal',
  required_capabilities: ['write_vault_genealogy'],
  input_schema: InputSchema,
  output_schema: OutputSchema,

  idempotency_key(input) {
    const h = createHash('sha256');
    h.update(input.path ?? '');
    h.update(input.gedcom_text ? input.gedcom_text.slice(0, 4096) : '');
    return `import_gedcom:${h.digest('hex').slice(0, 16)}`;
  },

  async execute(input, ctx: ToolContext): Promise<Output> {
    const warnings: string[] = [];
    const vault_root = (ctx.memory as unknown as { cfg: { vault_root: string } }).cfg.vault_root;

    // Resolve content. If `path` points at a wrapper .md note from
    // the library upload (kind: clipping, has attachment_path in
    // frontmatter), automatically use the attached .ged. Lets the
    // specialist pass either the wrapper note path she sees in
    // retrieval OR the raw .ged attachment path.
    let text: string;
    if (input.gedcom_text) {
      text = input.gedcom_text;
    } else {
      const rel = input.path!.replace(/^[/\\]+/, '');
      let abs = resolve(vault_root, rel);
      if (rel.endsWith('.md') && existsSync(abs)) {
        const parsed = matter(readFileSync(abs, 'utf8'));
        const fm = parsed.data as Record<string, unknown>;
        const att = typeof fm.attachment_path === 'string' ? fm.attachment_path : undefined;
        if (att && (att.toLowerCase().endsWith('.ged') || att.toLowerCase().endsWith('.gedcom'))) {
          abs = resolve(vault_root, att.replace(/^[/\\]+/, ''));
        }
      }
      if (!existsSync(abs)) {
        throw new Error(`GEDCOM file not found: ${input.path}`);
      }
      text = readFileSync(abs, 'utf8');
    }

    const tree = parse_gedcom(text);
    const individuals = Array.from(tree.individuals.values()).slice(0, input.limit);
    if (tree.individuals.size > input.limit) {
      warnings.push(
        `GEDCOM contains ${tree.individuals.size} individuals; capped at ${input.limit}. ` +
          `Re-invoke with a higher \`limit\` to import more.`,
      );
    }

    // First pass: resolve xref → note_path for every individual we'll
    // write (or that already exists). This lets the body renderer
    // produce correct wikilinks even for not-yet-written notes.
    const xref_to_path = new Map<string, string>();
    for (const ind of individuals) {
      const existing = find_existing(vault_root, ind.xref, ind.name);
      xref_to_path.set(
        ind.xref,
        existing?.note_path ?? ancestor_note_path(ind.name),
      );
    }

    let imported = 0;
    let updated = 0;
    const notes_written: string[] = [];

    for (const ind of individuals) {
      const existing = find_existing(vault_root, ind.xref, ind.name);
      const note_path = xref_to_path.get(ind.xref)!;
      const existing_fm = existing?.frontmatter ?? {};
      const id = (existing_fm.id as string | undefined) ?? gen_person_id();

      const fm: Record<string, unknown> = {
        ...existing_fm,
        type: 'person',
        id,
        name: ind.name,
        relationship: 'family',
        friday_managed: true,
        gedcom_xref: ind.xref,
      };
      if (ind.sex) fm.sex = ind.sex;
      if (ind.given) fm.given_name = ind.given;
      if (ind.surname) fm.surname = ind.surname;
      if (ind.birth?.date) fm.birth_date = ind.birth.date;
      if (ind.birth?.place) fm.birth_place = ind.birth.place;
      if (ind.death?.date) fm.death_date = ind.death.date;
      if (ind.death?.place) fm.death_place = ind.death.place;
      if (ind.sources.length) fm.sources = ind.sources;

      const body = render_body(ind, tree.families, xref_to_path);
      // Genealogy is personal research — each user's family tree silos to
      // them, not the shared household contact graph. Existing `private_to`
      // (from `...existing_fm`) is preserved by the helper.
      const stamped = stamp_private_to_if_needed(
        fm,
        ctx.user ? { user_id: ctx.user.id, tier: ctx.user.tier } : undefined,
      );
      ctx.memory.upsert_note(note_path, stamped, body);
      notes_written.push(note_path);
      if (existing) updated++;
      else imported++;
    }

    // Summary note under Knowledge/Genealogy/imports/.
    const today = local_iso_date();
    const label = input.source_label
      ? sanitize_filename(input.source_label)
      : input.path
        ? sanitize_filename(input.path.split('/').pop()!.replace(/\.ged$/i, ''))
        : `inline-${ulid().toLowerCase().slice(-6)}`;
    const summary_path = `Knowledge/Genealogy/imports/${today}-${label}.md`;
    const summary_fm: Record<string, unknown> = {
      type: 'genealogy_import',
      source: input.path ?? '(inline)',
      imported_at: new Date().toISOString(),
      individuals_imported: imported,
      individuals_updated: updated,
      families_processed: tree.families.size,
      gedcom_header_source: tree.header.source ?? null,
      gedcom_version: tree.header.gedcom_version ?? null,
    };
    const roster_lines: string[] = [];
    roster_lines.push(`# GEDCOM import: ${label}`);
    roster_lines.push('');
    roster_lines.push(`- Source: ${input.path ?? '(inline)'}`);
    roster_lines.push(`- Imported: ${imported} new, ${updated} updated, ${tree.families.size} families`);
    if (tree.header.source) roster_lines.push(`- Producer: ${tree.header.source}`);
    if (warnings.length) {
      roster_lines.push('');
      roster_lines.push('## Warnings');
      for (const w of warnings) roster_lines.push(`- ${w}`);
    }
    roster_lines.push('');
    roster_lines.push('## Roster');
    roster_lines.push('');
    for (const ind of individuals) {
      const path = xref_to_path.get(ind.xref);
      if (!path) continue;
      const base = path.replace(/^People\//, '').replace(/\.md$/, '');
      const dates =
        [ind.birth?.date, ind.death?.date].filter(Boolean).join(' – ') || '(dates unknown)';
      roster_lines.push(`- [[${base}|${ind.name}]] (${dates})`);
    }
    const stamped_summary = stamp_private_to_if_needed(
      summary_fm,
      ctx.user ? { user_id: ctx.user.id, tier: ctx.user.tier } : undefined,
    );
    ctx.memory.upsert_note(summary_path, stamped_summary, roster_lines.join('\n') + '\n');

    ctx.memory.log_action({
      intent_id: ctx.intent_id || ulid(),
      // Attribute to the calling specialist — Kate owns genealogy since the
      // 2026-07-03 fold-in; 'marguerite' survives as the legacy fallback.
      agent: ctx.specialist_id ?? 'marguerite',
      tool_name: 'import_gedcom',
      tool_input: {
        path: input.path,
        source_label: input.source_label,
        text_chars: input.gedcom_text?.length,
        limit: input.limit,
      },
      execution_result: {
        individuals_imported: imported,
        individuals_updated: updated,
        families_processed: tree.families.size,
        summary_note_path: summary_path,
      },
    });

    return {
      individuals_imported: imported,
      individuals_updated: updated,
      families_processed: tree.families.size,
      summary_note_path: summary_path,
      notes_written,
      warnings,
    };
  },
};
