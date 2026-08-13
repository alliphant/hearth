/**
 * GEDCOM converter — accepts .ged files dropped into the inbox or a
 * specialist's library. Stores the raw file as an attachment and
 * writes a wrapper note whose body is a human-readable roster
 * (header + individual list with dates).
 *
 * The wrapper note's path is then a valid `path` argument to
 * Marguerite's `import_gedcom` tool — she invokes that to actually
 * project the individuals into `People/<Name>-ancestor.md` notes.
 * Doing the import here automatically would conflate "stash this
 * source file" with "merge it into the family tree"; we keep those
 * deliberate.
 */

import type { Converter, ConversionInput, ConversionResult } from '../types';
import { parse_gedcom } from '@core/gedcom_parser';

export const gedcom_converter: Converter = {
  name: 'gedcom',

  matches(input) {
    const name = input.filename.toLowerCase();
    return (
      name.endsWith('.ged') ||
      name.endsWith('.gedcom') ||
      input.mime_type === 'application/x-gedcom' ||
      input.mime_type === 'text/vnd.familysearch.gedcom' ||
      input.mime_type === 'text/gedcom'
    );
  },

  async convert(input: ConversionInput): Promise<ConversionResult> {
    const bytes = input.bytes;
    const text =
      input.text ?? (bytes ? new TextDecoder().decode(bytes) : '');

    let title = input.filename.replace(/\.(ged|gedcom)$/i, '') || 'GEDCOM file';
    let individual_count = 0;
    let family_count = 0;
    let producer: string | undefined;
    let gedcom_version: string | undefined;
    const roster_lines: string[] = [];

    try {
      const tree = parse_gedcom(text);
      individual_count = tree.individuals.size;
      family_count = tree.families.size;
      producer = tree.header.source;
      gedcom_version = tree.header.gedcom_version;
      // Preview up to 50 individuals — the rest stay in the source
      // file for import_gedcom to walk. Sorting by name keeps it
      // human-readable; xref order is meaningless.
      const previews = Array.from(tree.individuals.values())
        .slice()
        .sort((a, b) => a.name.localeCompare(b.name))
        .slice(0, 50);
      for (const ind of previews) {
        const dates = [ind.birth?.date, ind.death?.date].filter(Boolean).join(' – ');
        roster_lines.push(
          `- **${ind.name}**${dates ? ` (${dates})` : ''}` +
            (ind.birth?.place ? ` — born ${ind.birth.place}` : ''),
        );
      }
    } catch (err) {
      // Bad GEDCOM — still store the file so Marguerite can debug it.
      roster_lines.push(
        `_(GEDCOM parse failed: ${err instanceof Error ? err.message : String(err)})_`,
      );
    }

    const body =
      `# GEDCOM source: ${title}\n\n` +
      `**Individuals**: ${individual_count}\n` +
      `**Families**: ${family_count}\n` +
      (producer ? `**Producer**: ${producer}\n` : '') +
      (gedcom_version ? `**GEDCOM version**: ${gedcom_version}\n` : '') +
      `\n## Roster (first 50)\n\n` +
      (roster_lines.join('\n') || '_(empty)_') +
      `\n\n---\n\n` +
      `> **Genealogy source, ready to import**: this is a GEDCOM ` +
      `source file. Whoever holds \`import_gedcom\` can call it with ` +
      `\`path\` set to **this wrapper note's path** (the .md file ` +
      `you're reading) — the tool will resolve the actual .ged ` +
      `attachment from the frontmatter automatically and project ` +
      `every individual into People/ + Knowledge/Genealogy/.\n`;

    const result: ConversionResult = {
      kind: 'gedcom',
      title,
      markdown_body: body,
      extracted_metadata: {
        byte_size: bytes?.length ?? text.length,
        individuals: individual_count,
        families: family_count,
        producer: producer ?? null,
        gedcom_version: gedcom_version ?? null,
      },
    };
    if (bytes) {
      result.attachment_bytes = bytes;
      result.attachment_filename = input.filename;
    }
    return result;
  },
};
