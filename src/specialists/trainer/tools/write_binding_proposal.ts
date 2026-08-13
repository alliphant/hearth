/**
 * write_binding_proposal — Beatrice's missing tool.
 *
 * Her persona at config/specialists/trainer.yaml:109-110 instructs her to:
 *   1. write a binding proposal markdown to
 *      `Knowledge/Trainer/binding-proposals/<slug>.md`
 *   2. call `propose_action` with kind: 'binding_proposal'.
 *
 * Step 2 has a tool. Step 1 did not — `write_vault_trainer` was granted
 * as a *capability* but no tool was gated on it. The first audited
 * deliberation pass (2026-05-22) confirmed the gap: she produced
 * markdown content and stuffed it into the proposal payload, but no
 * file landed in `Knowledge/Trainer/binding-proposals/`. This tool
 * closes that gap.
 *
 * Workflow now matches her persona literally:
 *   write_binding_proposal({ slug, markdown }) → returns { rel_path }
 *   propose_action({ kind: 'binding_proposal', payload: { slug, rel_path, summary }, ... })
 *
 * Idempotency: deterministic slug → deterministic path. A second call
 * with the same slug overwrites. Slug shape is enforced lowercase
 * kebab-case so the filesystem doesn't accumulate variants.
 *
 * Capability: write_vault_trainer (built-in enum, already on Beatrice).
 */

import { z } from 'zod';
import { createHash } from 'node:crypto';
import { ulid } from 'ulid';
import { resolve } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import type { Tool, ToolContext } from '@core/tool';
import type { ToolDeps } from '@core/tool_deps';
import { scan_existing_tools } from '../existing_tool_scan';

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const InputSchema = z.object({
  /**
   * Filename slug, lowercase-kebab-case. Lands at
   * Knowledge/Trainer/binding-proposals/<slug>.md.
   */
  // NOTE: no `.regex()` — a tool input_schema becomes a GBNF grammar on the
  // interactive 9B, and llama.cpp's converter mistranslates a regex `pattern`
  // and SILENTLY disables the whole tool grammar. The slug shape is validated
  // in execute() against SLUG (also a path-safety guard — it lands in the
  // proposal filename).
  slug: z.string().min(2).max(80).describe('Filename slug, lowercase-kebab-case (e.g. "read-inbox-tool").'),
  /**
   * Full markdown body of the binding proposal. Should include the
   * sections Beatrice's persona prescribes: rationale (with cited
   * audit rows), affected files, capability + tool name, schema
   * sketch, YAML grant diff.
   */
  markdown: z.string().min(50),
});

const OutputSchema = z.object({
  rel_path: z.string(),
  abs_path: z.string(),
  bytes_written: z.number(),
  /**
   * Existing tools whose function overlaps this proposal — a duplicate-guard.
   * Populated when the registry scan finds near-matches by name/description.
   * If one already provides the capability, do NOT propose a new tool.
   */
  possible_duplicates: z
    .array(z.object({ name: z.string(), description: z.string() }))
    .optional(),
  notice: z.string().optional(),
});

type Input = z.infer<typeof InputSchema>;
type Output = z.infer<typeof OutputSchema>;

export function create(deps: ToolDeps): Tool<Input, Output> {
  return {
    name: 'write_binding_proposal',
    description:
      "Write a Trainer binding-proposal markdown to Knowledge/Trainer/binding-proposals/<slug>.md. The first half of Beatrice's structural-gap workflow: write the spec to disk, then call propose_action with kind='binding_proposal' and the slug + rel_path in the payload. Args: slug (lowercase-kebab-case, e.g. 'read-inbox-tool') and markdown (the full body — rationale with cited audit rows, affected files, capability/tool name, schema sketch, YAML grant diff). Returns the relative + absolute paths. Idempotent on slug: a second call with the same slug overwrites.",
    risk: 'write_internal',
    required_capabilities: ['write_vault_trainer'],
    input_schema: InputSchema,
    output_schema: OutputSchema,

    idempotency_key(input) {
      const h = createHash('sha256');
      h.update(input.slug);
      h.update('\n');
      h.update(input.markdown);
      return `write_binding_proposal:${h.digest('hex').slice(0, 16)}`;
    },

    async execute(input, ctx: ToolContext): Promise<Output> {
      // Slug-shape check moved off the schema (a regex `pattern` silently
      // disables the 9B's tool grammar). It's also a path-safety guard — the
      // slug lands in the proposal filename.
      if (!SLUG.test(input.slug)) {
        throw new Error(
          `slug must be lowercase-kebab-case — lowercase letters/digits separated ` +
            `by single hyphens (e.g. "read-inbox-tool"); got "${input.slug}".`,
        );
      }
      const rel = `Knowledge/Trainer/binding-proposals/${input.slug}.md`;
      const abs = resolve(deps.vault_root, rel);
      const dir = resolve(deps.vault_root, 'Knowledge/Trainer/binding-proposals');
      mkdirSync(dir, { recursive: true });
      writeFileSync(abs, input.markdown, 'utf8');

      ctx.memory.log_action({
        intent_id: ctx.intent_id || ulid(),
        agent: ctx.specialist_id ?? 'trainer',
        tool_name: 'write_binding_proposal',
        tool_input: { slug: input.slug, markdown_bytes: input.markdown.length },
        execution_result: { rel_path: rel, bytes_written: input.markdown.length },
      });

      // Duplicate-guard: scan the live registry for a tool that already does
      // this (by function, not just token). Surfaced in-band so Beatrice
      // confronts an existing tool BEFORE filing a "build new tool" proposal —
      // the structural fix for the update_sku/update_workstation_sku ghost.
      const dupes = scan_existing_tools(
        deps.tool_registry,
        `${input.slug} ${input.markdown.slice(0, 1200)}`,
        { limit: 4, min_score: 4 },
      );

      return {
        rel_path: rel,
        abs_path: abs,
        bytes_written: input.markdown.length,
        ...(dupes.length > 0
          ? {
              possible_duplicates: dupes.map((d) => ({
                name: d.name,
                description: d.description,
              })),
              notice:
                `Wrote the spec, but ${dupes.length} EXISTING tool(s) may already ` +
                `do this: ${dupes.map((d) => d.name).join(', ')}. Before filing this ` +
                `as a "build a new tool" proposal, read their descriptions above and ` +
                `VERIFY none already provides the capability. If one does, do NOT ` +
                `build a duplicate — use it, or grant/surface it to the specialist ` +
                `via apply_low_risk_fix, or just say it already exists. Only ` +
                `proceed with a new tool if this is genuinely novel.`,
            }
          : {}),
      };
    },
  };
}
