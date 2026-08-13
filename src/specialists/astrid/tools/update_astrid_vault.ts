/**
 * update_astrid_vault — Astrid's vault writer.
 *
 * Five kinds, five destinations. v0.5 hardcodes user_id=jasper in the per-user
 * paths (mirrors the brigid pattern); the multi-user split will lift this
 * to a real per-user dispatch when Phase 2.5+ household work lands.
 *
 *   - `profile`       → users/jasper/astrid/profile.md
 *                       OVERWRITES. The cold-start interview answers
 *                       (training goals, history, coaching-style
 *                       preference, weekly target) + every re-calibration.
 *                       Mostly stable; new versions replace prior.
 *   - `observation`   → users/jasper/astrid/observations.md
 *                       Append-only running list of patterns Astrid
 *                       notices about Jasper ("rides hardest Tuesdays,
 *                       under-fuels beforehand"). Capped at 200 entries
 *                       between weekly compaction passes.
 *   - `session`       → users/jasper/astrid/sessions/<YYYY-MM-DD>-<slug>.md
 *                       One journal entry per observed workout. Her
 *                       *interpretation*, not raw HealthKit (raw data
 *                       lives in sensor_packets). Date and slug required.
 *   - `coaching_log`  → users/jasper/astrid/coaching-log.md
 *                       Every push she sent AND every push she chose NOT
 *                       to send. Trigger, decision, one-sentence why.
 *                       Capped at 500; makes "you nagged me too much"
 *                       debuggable and feeds Beatrice's persona tuning.
 *   - `memory`        → Knowledge/Astrid/memory.md
 *                       Household-level observations + Astrid's own
 *                       coaching-philosophy notes. Capped at 200.
 *
 * Capability: write_vault_astrid. Paths are hardcoded so the grant can't
 * be misused to scribble elsewhere in the vault.
 */

import { z } from 'zod';
import { createHash } from 'node:crypto';
import { ulid } from 'ulid';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import type { Tool, ToolContext } from '@core/tool';
import type { ToolDeps } from '@core/tool_deps';

const KindEnum = z.enum(['profile', 'observation', 'session', 'coaching_log', 'memory']);

const InputSchema = z.object({
  kind: KindEnum.describe(
    "Where to write. `profile` OVERWRITES users/jasper/astrid/profile.md with the user's training profile (cold-start interview answers + re-calibrations). `observation` appends a dated pattern to users/jasper/astrid/observations.md (capped 200). `session` writes one per-workout journal to users/jasper/astrid/sessions/<date>-<slug>.md (REQUIRES `date` and `slug`). `coaching_log` appends a push-decision row to users/jasper/astrid/coaching-log.md (capped 500). `memory` appends to Knowledge/Astrid/memory.md (household-level notes, capped 200).",
  ),
  body: z
    .string()
    .min(1)
    .max(10_000)
    .describe(
      "Markdown body. For `profile`, this is the full profile (goals, history, injuries, coaching-style preference, weekly target). For `observation` / `coaching_log` / `memory`, this is the content of one bullet — short and direct. For `session`, this is the journal entry interpreting the workout (NOT a raw stats dump; that's in sensor_packets).",
    ),
  // NOTE: no `.regex()` on `date`/`slug` — a tool input_schema becomes a GBNF
  // grammar on the interactive 9B, and llama.cpp's converter mistranslates a
  // regex `pattern` and SILENTLY disables the whole tool grammar. Both shapes
  // are validated in execute() (also a path-safety guard — they land in the
  // session filename).
  date: z
    .string()
    .optional()
    .describe('Required when `kind=session` — the workout date (YYYY-MM-DD), used in the filename.'),
  slug: z
    .string()
    .optional()
    .describe(
      "Required when `kind=session` — short lowercase-kebab slug for the workout type (e.g. 'ride', 'strength-upper', 'hiit'). Combined with date for the filename.",
    ),
  title: z
    .string()
    .max(200)
    .optional()
    .describe('Optional human title (overrides the auto-generated session header).'),
});

const OutputSchema = z.object({
  rel_path: z.string(),
  kind: z.string(),
  bytes_written: z.number(),
});

type Input = z.infer<typeof InputSchema>;
type Output = z.infer<typeof OutputSchema>;

const MEMORY_HEADER = `# Astrid's memory

Working notes from Astrid — Hearth's trainer. Household-level patterns,
coaching-philosophy reflections, things that apply across users (not
specific to one person — those live in per-user observations.md).
Newest first; capped at 200 entries.

<!-- entries below -->
`;

const OBSERVATIONS_HEADER = `# Astrid's running observations

Patterns Astrid is noticing about this user's training. Append-only
between weekly compactions; raw entries archive to observations.archive/
on compaction so nothing is lost. Newest first; capped at 200 live entries.

<!-- entries below -->
`;

const COACHING_LOG_HEADER = `# Astrid's coaching-decision log

Every push Astrid sent AND every push she chose NOT to send. Trigger,
decision, one-sentence why. Makes "you nagged me too much last week"
debuggable, and gives Beatrice concrete substrate for persona tuning.
Newest first; capped at 500 entries.

<!-- entries below -->
`;

const MAX_MEMORY_ENTRIES = 200;
const MAX_OBSERVATION_ENTRIES = 200;
const MAX_COACHING_LOG_ENTRIES = 500;

function append_with_cap(existing: string, header: string, entry: string, cap: number | null): string {
  let content = existing.length > 0 ? existing : header;
  if (!content.startsWith('# ')) content = header + '\n' + content;

  const marker = '<!-- entries below -->';
  const idx = content.indexOf(marker);
  const insert_at = idx >= 0 ? idx + marker.length : content.length;
  const prefix = content.slice(0, insert_at);
  const suffix = content.slice(insert_at);
  let next = `${prefix}\n\n${entry}\n${suffix}`;

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
    name: 'update_astrid_vault',
    description:
      "Write into Astrid's vault namespace. `kind=profile` OVERWRITES users/jasper/astrid/profile.md (the cold-start interview answers + re-calibrations — call after every interview pass). `kind=observation` appends a dated bullet to users/jasper/astrid/observations.md (capped 200; use for patterns you notice across sessions). `kind=session` writes one journal entry per workout to users/jasper/astrid/sessions/<date>-<slug>.md (REQUIRES `date` and `slug`; your interpretation, not raw stats). `kind=coaching_log` appends a push-decision row to users/jasper/astrid/coaching-log.md (capped 500; log BOTH pushes sent and pushes deliberately withheld). `kind=memory` appends to Knowledge/Astrid/memory.md (household-level / coaching-philosophy notes, capped 200).",
    risk: 'write_internal',
    required_capabilities: ['write_vault_astrid'],
    input_schema: InputSchema,
    output_schema: OutputSchema,

    idempotency_key(input) {
      const h = createHash('sha256');
      h.update(input.kind);
      h.update('\n');
      h.update(input.body);
      if (input.date) h.update(`\n${input.date}`);
      if (input.slug) h.update(`\n${input.slug}`);
      if (input.title) h.update(`\n${input.title}`);
      return `update_astrid_vault:${h.digest('hex').slice(0, 16)}`;
    },

    async execute(input, ctx: ToolContext): Promise<Output> {
      const ts = (ctx.now ?? new Date()).toISOString();
      let rel_path: string;
      let final_content: string;

      if (input.kind === 'profile') {
        rel_path = 'users/jasper/astrid/profile.md';
        const title = input.title ?? "Jasper's training profile";
        final_content =
          `---\ntype: trainer_profile\nuser_id: jasper\nupdated: ${ts}\n---\n\n` +
          `# ${title}\n\n_Updated ${ts} by Astrid._\n\n${input.body.trim()}\n`;
      } else if (input.kind === 'session') {
        if (!input.date || !input.slug) {
          throw new Error('update_astrid_vault: kind=session requires both `date` (YYYY-MM-DD) and `slug`.');
        }
        // Shape-check here (moved off the schema) — date + slug land in a file
        // path, so a malformed value is both wrong and a path-safety risk.
        if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date)) {
          throw new Error(`update_astrid_vault: \`date\` must be YYYY-MM-DD; got "${input.date}".`);
        }
        if (!/^[a-z0-9][a-z0-9-]{0,60}$/.test(input.slug)) {
          throw new Error(
            `update_astrid_vault: \`slug\` must be lowercase-kebab-case, 1-61 chars ` +
              `(e.g. "ride", "strength-upper"); got "${input.slug}".`,
          );
        }
        rel_path = `users/jasper/astrid/sessions/${input.date}-${input.slug}.md`;
        const title = input.title ?? `Session — ${input.date} ${input.slug}`;
        final_content =
          `---\ntype: trainer_session\nuser_id: jasper\ndate: ${input.date}\nworkout_slug: ${input.slug}\nlogged: ${ts}\n---\n\n` +
          `# ${title}\n\n${input.body.trim()}\n`;
      } else if (input.kind === 'observation') {
        rel_path = 'users/jasper/astrid/observations.md';
        const abs = resolve(deps.vault_root, rel_path);
        const existing = existsSync(abs) ? readFileSync(abs, 'utf8') : '';
        const entry = `### ${ts}\n\n${input.body.trim()}`;
        final_content = append_with_cap(existing, OBSERVATIONS_HEADER, entry, MAX_OBSERVATION_ENTRIES);
      } else if (input.kind === 'coaching_log') {
        rel_path = 'users/jasper/astrid/coaching-log.md';
        const abs = resolve(deps.vault_root, rel_path);
        const existing = existsSync(abs) ? readFileSync(abs, 'utf8') : '';
        const entry = `### ${ts}\n\n${input.body.trim()}`;
        final_content = append_with_cap(existing, COACHING_LOG_HEADER, entry, MAX_COACHING_LOG_ENTRIES);
      } else {
        rel_path = 'Knowledge/Astrid/memory.md';
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
        agent: ctx.specialist_id ?? 'astrid',
        tool_name: 'update_astrid_vault',
        tool_input: {
          kind: input.kind,
          rel_path,
          date: input.date,
          slug: input.slug,
          title: input.title,
          bytes: final_content.length,
        },
        execution_result: { rel_path, bytes_written: final_content.length },
      });

      return { rel_path, kind: input.kind, bytes_written: final_content.length };
    },
  };
}
