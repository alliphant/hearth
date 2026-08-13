/**
 * upsert_place tool — create or update a Places/<name>.md vault note.
 *
 * Symmetric with the People namespace: each place lives as a markdown
 * file with structured frontmatter; the ingestor projects to the
 * `places` table on disk-event. Kate, Iris, and Eleanor have the
 * `write_places` capability in the seed config.
 */

import { z } from 'zod';
import { createHash, randomBytes } from 'node:crypto';
import { ulid } from 'ulid';
import type { Tool, ToolContext } from '@core/tool';
import { geocode } from './maps';
import { stamp_private_to_if_needed } from '@memory/private_to';

const PointTuple = z.tuple([z.number(), z.number()]).nullable();

const UpsertInput = z.object({
  name: z.string().min(1).max(200),
  address: z.string().max(500).optional(),
  coords: PointTuple.optional(),
  category: z.string().max(100).optional(),
  parking_buffer_minutes: z.number().int().min(0).max(120).optional(),
  aliases: z.array(z.string().min(1).max(100)).max(20).optional(),
  ha_zone_name: z.string().nullable().optional(),
  notes: z.string().max(10_000).optional(),
  phone: z.string().max(50).optional(),
});

const UpsertOutput = z.object({
  id: z.string(),
  note_path: z.string(),
  created: z.boolean(),
});

type UpsertIn = z.infer<typeof UpsertInput>;
type UpsertOut = z.infer<typeof UpsertOutput>;

function gen_place_id(): string {
  // 6-char base32 lowercase (a-z, 2-7).
  const ALPHA = 'abcdefghijklmnopqrstuvwxyz234567';
  const bytes = randomBytes(6);
  let out = 'pl_';
  for (let i = 0; i < 6; i++) {
    out += ALPHA[bytes[i]! % 32];
  }
  return out;
}

function sanitize_filename(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9\s_-]/g, '')
      .trim()
      .replace(/\s+/g, '-')
      .slice(0, 80) || 'place'
  );
}

export const upsert_place: Tool<UpsertIn, UpsertOut> = {
  name: 'upsert_place',
  description:
    "Create or update a Places/<name>.md vault note for a significant location (a vet, a friend's house, a restaurant). Provide the address to have it geocoded automatically; or pass coords directly. Existing places (matched by name/alias) are updated rather than duplicated. Use this when you introduce a new place into the conversation that Jasper will visit again.",
  risk: 'write_internal',
  required_capabilities: ['write_places'],
  input_schema: UpsertInput,
  output_schema: UpsertOutput,

  idempotency_key(input) {
    const h = createHash('sha256');
    h.update(input.name.toLowerCase().trim());
    return `upsert_place:${h.digest('hex').slice(0, 16)}`;
  },

  async execute(input, ctx: ToolContext): Promise<UpsertOut> {
    const existing = ctx.memory.find_place_by_name(input.name);

    // Resolve coords if needed.
    let resolved_coords: [number, number] | null | undefined = input.coords;
    if ((resolved_coords == null) && input.address) {
      try {
        const g_out = await geocode.execute({ query: input.address }, ctx);
        if (g_out.results.length > 0 && g_out.results[0]) {
          const top = g_out.results[0];
          resolved_coords = [top.lat, top.lon];
        }
      } catch (err) {
        void err;
      }
    } else if (resolved_coords == null && existing?.lat != null && existing?.lon != null) {
      resolved_coords = [existing.lat, existing.lon];
    }

    // If ha_zone_name is unset but a zone with this name exists, link
    // automatically. We can't query HA without an HTTP call; the
    // pattern is "trust the name match" rather than reaching out.
    let ha_zone_name = input.ha_zone_name;
    if (ha_zone_name === undefined) {
      ha_zone_name = existing?.ha_zone_name ?? null;
    }

    const id = existing?.id ?? gen_place_id();
    const note_path = existing?.note_path ?? `Places/${sanitize_filename(input.name)}.md`;
    const created = !existing;

    const aliases = input.aliases ?? existing?.aliases ?? [];
    const category = input.category ?? existing?.category ?? undefined;
    const parking = input.parking_buffer_minutes ?? existing?.parking_buffer_minutes ?? 0;
    const phone = input.phone ?? existing?.phone ?? undefined;
    const address = input.address ?? existing?.address ?? undefined;
    const hours = existing?.hours ?? undefined;

    const fm: Record<string, unknown> = {
      type: 'place',
      id,
      name: input.name,
      aliases,
      parking_buffer_minutes: parking,
    };
    if (address) fm.address = address;
    if (resolved_coords) fm.coords = resolved_coords;
    if (category) fm.category = category;
    if (ha_zone_name !== null) fm.ha_zone_name = ha_zone_name;
    if (phone) fm.phone = phone;
    if (hours) fm.hours = hours;
    if (input.notes) fm.notes = input.notes;

    const body =
      created
        ? `# ${input.name}\n\n${input.notes ?? ''}`.trim() + '\n'
        : input.notes ?? '';

    // A Place is a shared household entity (the family's communal map);
    // owner/household writes scope to `household`, a friend's silo to them.
    const stamped = stamp_private_to_if_needed(
      fm,
      ctx.user ? { user_id: ctx.user.id, tier: ctx.user.tier } : undefined,
      'shared_entity',
    );

    ctx.memory.upsert_note(note_path, stamped, body);

    ctx.memory.log_action({
      intent_id: ctx.intent_id || ulid(),
      agent: 'maps_connector',
      tool_name: 'upsert_place',
      tool_input: { name: input.name, created, has_coords: Boolean(resolved_coords) },
      execution_result: { id, note_path, created },
    });

    return { id, note_path, created };
  },
};
