/**
 * update_brigid_vault — Brigid's vault writer.
 *
 * Three kinds, three destinations under the per-user namespace
 * `users/jasper/brigid/` (prototype for the future household / per-user
 * split — v0.5 hardcodes jasper because only Jasper talks to her):
 *
 *   - `plan`    → users/jasper/brigid/plans/<date>.md
 *                 Overwrites: a redrafted week replaces the previous file
 *                 for the same start_date. `body` is the full markdown
 *                 summary; `date` is the plan's start_date (YYYY-MM-DD).
 *   - `backlog` → users/jasper/brigid/backlog.md
 *                 Appends a timestamped bullet. Used when Jasper saves a
 *                 recipe URL "for later" instead of scheduling it now.
 *   - `memory`  → Knowledge/Brigid/memory.md
 *                 Append-only working notes (taste calls, "Jasper doesn't
 *                 love fennel after all", "Sam has been doing
 *                 Wednesday late shifts"). Newest first, capped at 200.
 *
 * Capability: write_vault_brigid. Paths are hardcoded so the grant can't
 * be misused.
 */

import { z } from 'zod';
import { createHash } from 'node:crypto';
import { ulid } from 'ulid';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import type { Tool, ToolContext } from '@core/tool';
import type { ToolDeps } from '@core/tool_deps';

const KindEnum = z.enum(['plan', 'backlog', 'memory']);

const InputSchema = z.object({
  kind: KindEnum.describe(
    "Where to write. `plan` writes a full weekly summary to users/jasper/brigid/plans/<date>.md (overwrites a redrafted week). `backlog` appends to users/jasper/brigid/backlog.md. `memory` appends to Knowledge/Brigid/memory.md (working notes).",
  ),
  body: z
    .string()
    .min(1)
    .max(10_000)
    .describe(
      "Markdown body. For `plan`, this is the full plan summary (intro + the 7-night list + notes). For `backlog` or `memory`, this is the content of one bullet — short and direct.",
    ),
  // NOTE: no `.regex()` — a tool input_schema becomes a GBNF grammar on the
  // interactive 9B, and llama.cpp's converter mistranslates a regex `pattern`
  // and SILENTLY disables the whole tool grammar. The YYYY-MM-DD shape is
  // validated in execute() (it's also a path-safety guard — `date` lands in the
  // plan filename).
  date: z
    .string()
    .optional()
    .describe(
      "Required when `kind=plan` — the start_date of the week, used in the filename. Ignored for backlog/memory.",
    ),
  title: z
    .string()
    .max(200)
    .optional()
    .describe('Optional title for a plan or backlog entry (e.g. the recipe name being backlogged).'),
  source_url: z
    .string()
    .url()
    .optional()
    .describe('Optional source URL — backlog entries usually have one.'),
});

const OutputSchema = z.object({
  rel_path: z.string(),
  kind: z.string(),
  bytes_written: z.number(),
});

type Input = z.infer<typeof InputSchema>;
type Output = z.infer<typeof OutputSchema>;

const MEMORY_HEADER = `# Brigid's memory

Working notes from Brigid — Hearth's cook. Tastes, schedule patterns,
constraint discoveries. Newest first; capped at 200 entries.

<!-- entries below -->
`;

const BACKLOG_HEADER = `# Brigid's recipe backlog

URLs Jasper sent to save for later, not scheduled into a specific week.
When a fresh week is being drafted, Brigid pulls candidates from this
file. Entries are timestamped; remove ones that get scheduled.

<!-- entries below -->
`;

const MAX_MEMORY_ENTRIES = 200;

function append_with_cap(existing: string, header: string, entry: string, cap: number | null): string {
  let content = existing.length > 0 ? existing : header;
  if (!content.startsWith('# ')) content = header + '\n' + content;

  // Insert entry directly after the `<!-- entries below -->` marker, or
  // at the end of the file if the marker is missing.
  const marker = '<!-- entries below -->';
  const idx = content.indexOf(marker);
  const insert_at = idx >= 0 ? idx + marker.length : content.length;
  const prefix = content.slice(0, insert_at);
  const suffix = content.slice(insert_at);
  let next = `${prefix}\n\n${entry}\n${suffix}`;

  // Apply cap (entry headers are `### ` lines). Drop the oldest.
  if (cap !== null) {
    const headers = [...next.matchAll(/^### /gm)];
    if (headers.length > cap) {
      const cutoff = headers[cap];
      if (cutoff && cutoff.index !== undefined) {
        next = next.slice(0, cutoff.index);
      }
    }
  }
  return next;
}

export function create(deps: ToolDeps): Tool<Input, Output> {
  return {
    name: 'update_brigid_vault',
    description:
      "Write into Brigid's vault namespace. `kind=plan` saves a full weekly dinner summary to users/jasper/brigid/plans/<date>.md (date = the week's start_date — REQUIRED for plan; overwrites a redrafted week). `kind=backlog` appends a timestamped bullet to users/jasper/brigid/backlog.md (URLs Jasper chose to save for later instead of scheduling). `kind=memory` appends to Knowledge/Brigid/memory.md (capped at 200, newest first). Use after mealie_set_meal_plan returns success, OR after a recipe-import flow when Jasper picks 'save to backlog'.",
    risk: 'write_internal',
    required_capabilities: ['write_vault_brigid'],
    input_schema: InputSchema,
    output_schema: OutputSchema,

    idempotency_key(input) {
      const h = createHash('sha256');
      h.update(input.kind);
      h.update('\n');
      h.update(input.body);
      if (input.date) h.update(`\n${input.date}`);
      if (input.title) h.update(`\n${input.title}`);
      if (input.source_url) h.update(`\n${input.source_url}`);
      return `update_brigid_vault:${h.digest('hex').slice(0, 16)}`;
    },

    async execute(input, ctx: ToolContext): Promise<Output> {
      const ts = (ctx.now ?? new Date()).toISOString();
      let rel_path: string;
      let final_content: string;

      if (input.kind === 'plan') {
        if (!input.date) {
          throw new Error('update_brigid_vault: kind=plan requires `date` (YYYY-MM-DD).');
        }
        // Shape-check here (moved off the schema) — `date` lands in a file path,
        // so a malformed value is both wrong and a path-safety risk.
        if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date)) {
          throw new Error(`update_brigid_vault: \`date\` must be YYYY-MM-DD; got "${input.date}".`);
        }
        rel_path = `users/jasper/brigid/plans/${input.date}.md`;
        // Plans overwrite — a redrafted week REPLACES the previous file.
        // The body is expected to be the full summary; we just stamp a
        // small header with the generation timestamp for traceability.
        const title = input.title ?? `Dinner plan — week of ${input.date}`;
        final_content =
          `# ${title}\n\n_Generated ${ts} by Brigid._\n\n${input.body.trim()}\n`;
      } else if (input.kind === 'backlog') {
        rel_path = 'users/jasper/brigid/backlog.md';
        const abs = resolve(deps.vault_root, rel_path);
        const existing = existsSync(abs) ? readFileSync(abs, 'utf8') : '';
        const heading_bits = [
          input.title ? `**${input.title}**` : null,
          input.source_url ? `<${input.source_url}>` : null,
        ].filter((s): s is string => s !== null);
        const heading = heading_bits.length > 0 ? heading_bits.join(' — ') : '_(untitled save)_';
        const entry = `### ${ts}\n\n${heading}\n\n${input.body.trim()}`;
        final_content = append_with_cap(existing, BACKLOG_HEADER, entry, null);
      } else {
        rel_path = 'Knowledge/Brigid/memory.md';
        const abs = resolve(deps.vault_root, rel_path);
        const existing = existsSync(abs) ? readFileSync(abs, 'utf8') : '';
        const entry = `### ${ts}\n\n${input.body.trim()}`;
        final_content = append_with_cap(existing, MEMORY_HEADER, entry, MAX_MEMORY_ENTRIES);
      }

      const abs = resolve(deps.vault_root, rel_path);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, final_content, 'utf8');

      ctx.memory.log_action({
        intent_id: ctx.intent_id || ulid(),
        agent: ctx.specialist_id ?? 'brigid',
        tool_name: 'update_brigid_vault',
        tool_input: {
          kind: input.kind,
          rel_path,
          date: input.date,
          title: input.title,
          source_url: input.source_url,
          bytes: final_content.length,
        },
        execution_result: { rel_path, bytes_written: final_content.length },
      });

      return { rel_path, kind: input.kind, bytes_written: final_content.length };
    },
  };
}
