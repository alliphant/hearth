/**
 * update_maggie_memory — Maggie's notebook.
 *
 * Append-only structured updates to Knowledge/Maggie/memory.md. Three
 * section kinds, each gets its own H2 heading the tool maintains
 * automatically; entries land timestamped under the appropriate
 * heading, newest first:
 *
 *   - `taste`    — Jasper mentioned media (watching X, saw Y, want to see
 *                  Z, "this is great," "this sucks"). One-line capture.
 *   - `research` — output of an upcoming-concerts research pass.
 *                  Multi-line is fine; structure as `- artist — venue —
 *                  date — link — why it matches Jasper's taste`.
 *   - `note`     — anything else worth remembering between turns.
 *
 * Section caps: 200 entries each, newest first. Older entries rotate
 * out (the file is bounded, not infinite). This is Maggie's working
 * memory, not an archive — for archival, file an action_proposal that
 * lands the research into the vault proper.
 *
 * Capability: write_vault_media. Path is hardcoded to her own
 * Knowledge/Maggie/memory.md so the capability grant can't be
 * misused to write elsewhere.
 */

import { z } from 'zod';
import { createHash } from 'node:crypto';
import { ulid } from 'ulid';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import type { Tool, ToolContext } from '@core/tool';
import type { ToolDeps } from '@core/tool_deps';

const SectionEnum = z.enum(['taste', 'research', 'note']);

const InputSchema = z.object({
  kind: SectionEnum.describe(
    "Section to append into. `taste` for media Jasper mentioned (one " +
      "line). `research` for a concert/event research pass output " +
      "(multi-line OK). `note` for everything else.",
  ),
  body: z
    .string()
    .min(1)
    .max(4000)
    .describe(
      'Markdown body. Will be appended under the matching H2 with a ' +
        "timestamped bullet. Keep `taste` entries to one tight " +
        'sentence; `research` entries should be a dash-prefixed list ' +
        "(`- <artist> — <venue> — <date> — <link> — <why it matches>`).",
    ),
});

const OutputSchema = z.object({
  rel_path: z.string(),
  section: z.string(),
  entries_after: z.number(),
});

type Input = z.infer<typeof InputSchema>;
type Output = z.infer<typeof OutputSchema>;

const MAX_PER_SECTION = 200;

const SECTION_TITLES: Record<z.infer<typeof SectionEnum>, string> = {
  taste: '## Jasper\'s media mentions',
  research: '## Concert + event research',
  note: '## Working notes',
};

const SECTION_INTRO = {
  taste:
    "One-line captures whenever Jasper mentions media — watching, " +
    "saw, want to see, loved, hated. Newest first.",
  research:
    "Outputs of scheduled upcoming-concerts research passes. Each " +
    "entry: timestamp, then a bulleted list of `- <artist> — " +
    "<venue> — <date> — <link> — <why it matches>`. Newest first.",
  note:
    "Anything else worth remembering between turns. Newest first.",
} as const;

function ensure_seeded(content: string): string {
  // Make sure all three sections exist, in canonical order, with their
  // intro lines under them. Missing sections get added; existing ones
  // are left alone (so user edits survive).
  let out = content;
  if (!out.includes(SECTION_TITLES.taste)) {
    out += (out.endsWith('\n') ? '' : '\n') +
      `\n${SECTION_TITLES.taste}\n\n_${SECTION_INTRO.taste}_\n`;
  }
  if (!out.includes(SECTION_TITLES.research)) {
    out += (out.endsWith('\n') ? '' : '\n') +
      `\n${SECTION_TITLES.research}\n\n_${SECTION_INTRO.research}_\n`;
  }
  if (!out.includes(SECTION_TITLES.note)) {
    out += (out.endsWith('\n') ? '' : '\n') +
      `\n${SECTION_TITLES.note}\n\n_${SECTION_INTRO.note}_\n`;
  }
  if (!out.startsWith('# ')) {
    out =
      `# Maggie's memory\n\n` +
      `Working memory for Hearth's Media & Collection Manager. ` +
      `Auto-maintained by the \`update_maggie_memory\` tool; ` +
      `Jasper can also edit by hand if he wants.\n\n` +
      out;
  }
  return out;
}

function insert_into_section(
  content: string,
  section_title: string,
  entry_md: string,
): { text: string; entries_after: number } {
  // Find the section heading, then insert the entry as the first
  // bullet AFTER any intro paragraph but BEFORE any existing entries.
  // Newest-first ordering — entries above older ones, all under the
  // same H2.
  const heading_idx = content.indexOf(section_title);
  if (heading_idx < 0) {
    // Shouldn't happen — ensure_seeded should have created it.
    return { text: content + `\n\n${section_title}\n\n${entry_md}\n`, entries_after: 1 };
  }
  // Find the end of this section: the next `## ` at column 0, or EOF.
  const section_start = heading_idx;
  const after_heading = content.indexOf('\n', section_start) + 1;
  const next_h2_match = content.slice(after_heading).search(/^## /m);
  const section_end =
    next_h2_match < 0 ? content.length : after_heading + next_h2_match;

  let section_body = content.slice(after_heading, section_end);
  // The intro paragraph is the first non-empty block of `_..._` italic
  // text. Skip it; insert AFTER intro but BEFORE entries.
  const intro_re = /^(\s*\n)?_[^_]+_\n/;
  const intro_match = section_body.match(intro_re);
  const intro_chunk = intro_match ? intro_match[0] : '';
  let entries_chunk = section_body.slice(intro_chunk.length);

  // Insert the new entry at the top of entries_chunk.
  if (!entries_chunk.startsWith('\n')) entries_chunk = '\n' + entries_chunk;
  entries_chunk = `\n${entry_md}\n` + entries_chunk;

  // Cap entries — count timestamped headers and drop the oldest if
  // we're over MAX_PER_SECTION. Each entry starts with `\n### `.
  const entry_headers = [...entries_chunk.matchAll(/^### /gm)];
  let entries_after = entry_headers.length;
  if (entry_headers.length > MAX_PER_SECTION) {
    // Find the cutoff position (start of the (MAX+1)th entry).
    const cutoff_match = entry_headers[MAX_PER_SECTION];
    if (cutoff_match && cutoff_match.index !== undefined) {
      entries_chunk = entries_chunk.slice(0, cutoff_match.index);
      entries_after = MAX_PER_SECTION;
    }
  }

  const new_section_body = intro_chunk + entries_chunk;
  const new_content =
    content.slice(0, after_heading) +
    new_section_body +
    content.slice(section_end);
  return { text: new_content, entries_after };
}

export function create(deps: ToolDeps): Tool<Input, Output> {
  return {
    name: 'update_maggie_memory',
    description:
      "Append a structured entry to Knowledge/Maggie/memory.md — Maggie's working notebook. Two args: `kind` (taste|research|note) selects the section; `body` is the markdown content. Use `taste` IMMEDIATELY whenever Jasper mentions watching/saw/want-to-see/loved/hated any media in chat — one tight line, who/what/his vibe on it. Use `research` after a concert-research pass — dash-list of matches. Use `note` for anything else worth carrying between turns. Append-only and newest-first; the file's bounded at 200 entries per section so old stuff rotates out. The path is hardcoded — this tool only writes Maggie's own memory.md.",
    risk: 'write_internal',
    required_capabilities: ['write_vault_media'],
    input_schema: InputSchema,
    output_schema: OutputSchema,

    idempotency_key(input) {
      const h = createHash('sha256');
      h.update(input.kind);
      h.update('\n');
      h.update(input.body);
      return `update_maggie_memory:${h.digest('hex').slice(0, 16)}`;
    },

    async execute(input, ctx: ToolContext): Promise<Output> {
      const rel_path = 'Knowledge/Maggie/memory.md';
      const abs = resolve(deps.vault_root, rel_path);
      mkdirSync(dirname(abs), { recursive: true });
      const existing = existsSync(abs) ? readFileSync(abs, 'utf8') : '';
      const seeded = ensure_seeded(existing);
      const ts = (ctx.now ?? new Date()).toISOString();
      const entry_md = `\n### ${ts}\n\n${input.body.trim()}\n`;
      const { text, entries_after } = insert_into_section(
        seeded,
        SECTION_TITLES[input.kind],
        entry_md,
      );
      writeFileSync(abs, text, 'utf8');

      ctx.memory.log_action({
        intent_id: ctx.intent_id || ulid(),
        agent: ctx.specialist_id ?? 'maggie',
        tool_name: 'update_maggie_memory',
        tool_input: { kind: input.kind, body_chars: input.body.length },
        execution_result: { rel_path, entries_after },
      });

      return { rel_path, section: input.kind, entries_after };
    },
  };
}
