import { z } from 'zod';
import { createHash } from 'node:crypto';
import type { Tool, ToolContext } from '@core/tool';
import { local_iso_date } from '@core/time';
import {
  RELATES_TO,
  make_edge_source,
  type EntityKind,
} from '@core/person_relations';
import { find_or_create_person } from '@agents/scribe/tools/find_or_create_person';
import { upsert_person_note } from '@agents/scribe/tools/upsert_person_note';

/**
 * record_relationship — told-first authoring of a typed person↔person/place
 * tie into the Household Knowledge Graph (Phase 0 of the People reasoning
 * substrate, 2026-06-22).
 *
 * "Rosa is Sam's hairdresser" → `subject:"Sam", target:"Rosa Ito",
 * role:"hairdresser"`. "Rachel works at the salon" → `subject:"Rachel",
 * target:"the salon", role:"works at", target_kind:"place"`.
 *
 * It does TWO writes, both idempotent:
 *   1. The VAULT TRUTH — appends a structured `relations` entry to the subject's
 *      People/ note via upsert_person_note (so stamping + schema validation +
 *      Obsidian-visibility + git-tracking all apply). The ingestor re-projects
 *      this into knowledge_edges, so the graph stays correct even if the note is
 *      later edited by hand.
 *   2. The WARM EDGE — upserts the `relates-to` edge immediately, so the same
 *      turn's `who_is` sees it without waiting ~500ms for the chokidar pass. The
 *      projector reconciles to the identical row (same PK), so this never
 *      diverges from the vault truth.
 *
 * Provenance is `told` (the owner stated it). Flat string contract — the small
 * model produces subject/target/role reliably; `target_kind` defaults to person
 * and `user_id` is ambient (ctx.user), per the arg-spiral rules.
 */
const InputSchema = z.object({
  subject: z.string().min(1).max(200).describe('The person the tie is about (name), e.g. "Sam".'),
  target: z
    .string()
    .min(1)
    .max(200)
    .describe('The other person or place, e.g. "Rosa Ito" or "the salon".'),
  role: z
    .string()
    .min(1)
    .max(120)
    .describe('The role/tie from subject to target, e.g. "hairdresser", "daughter", "works at".'),
  target_kind: z
    .enum(['person', 'place'])
    .optional()
    .describe('Whether the target is a person (defaults to person) or a place/business.'),
});

const OutputSchema = z.object({
  recorded: z.boolean(),
  subject_id: z.string(),
  subject_note_path: z.string(),
  target: z.string(),
  target_ref: z.string(),
  role: z.string(),
  target_kind: z.enum(['person', 'place']),
});

type Input = z.infer<typeof InputSchema>;
type Output = z.infer<typeof OutputSchema>;

export const record_relationship: Tool<Input, Output> = {
  name: 'record_relationship',
  description:
    'Record a relationship/role between people (and places) so Kate understands the connection — ' +
    'e.g. "Rosa is Sam\'s hairdresser", "Rachel works at the salon". ' +
    'Use whenever the owner states who someone is to someone else, or where they go/work.',
  risk: 'write_internal',
  required_capabilities: ['write_vault_general'],
  input_schema: InputSchema,
  output_schema: OutputSchema,

  idempotency_key(input) {
    const h = createHash('sha256');
    h.update(input.subject.toLowerCase().trim());
    h.update('\n');
    h.update(input.target.toLowerCase().trim());
    h.update('\n');
    h.update(input.role.toLowerCase().trim());
    return `record_relationship:${h.digest('hex').slice(0, 16)}`;
  },

  async execute(input, ctx: ToolContext): Promise<Output> {
    const target_kind: EntityKind = input.target_kind ?? 'person';

    // 1. Resolve/create the subject person note.
    const subject = await find_or_create_person.execute({ name: input.subject }, ctx);

    // 2. Read existing relations off the subject note (don't clobber them).
    const lookup = ctx.memory.find_person({ id: subject.id });
    const existing = Array.isArray(lookup?.frontmatter?.relations)
      ? (lookup!.frontmatter!.relations as unknown[])
      : [];

    // 3. Append the new structured relation entry (the vault truth).
    const entry = {
      to: input.target,
      to_kind: target_kind,
      predicate: input.role.toLowerCase().trim(),
      provenance: 'told' as const,
      confidence: 1,
      source_ref: ctx.intent_id,
      ...(ctx.user?.id ? { asserted_by: ctx.user.id } : {}),
      asserted_at: local_iso_date(ctx.now ?? new Date(), undefined),
    };
    await upsert_person_note.execute(
      { identifier: { id: subject.id }, patch: { relations: [...existing, entry] } },
      ctx,
    );

    // 4. Warm the graph edge so this turn's who_is sees it (projector reconciles).
    const target_ref =
      target_kind === 'place'
        ? ctx.memory.find_place_by_name(input.target)?.note_path ?? input.target
        : ctx.memory.find_person({ name: input.target })?.note_path ?? input.target;
    const private_to =
      (typeof lookup?.frontmatter?.private_to === 'string' && lookup.frontmatter.private_to.trim()) ||
      'household';
    if (target_ref !== subject.note_path) {
      ctx.memory.knowledge_edges.upsert({
        from_ref: subject.note_path,
        to_ref: target_ref,
        kind: RELATES_TO,
        context: entry.predicate,
        confidence: 1,
        source: make_edge_source('told', ctx.intent_id),
        private_to,
      });
    }

    return {
      recorded: true,
      subject_id: subject.id,
      subject_note_path: subject.note_path,
      target: input.target,
      target_ref,
      role: entry.predicate,
      target_kind,
    };
  },
};
