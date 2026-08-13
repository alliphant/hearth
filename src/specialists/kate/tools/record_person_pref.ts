/**
 * record_person_pref — THE all-encompassing "record a fact about a person" tool.
 *
 * When the owner tells Kate ANYTHING durable about a person — pronouns,
 * relationship, birthday, address, how they met, pets, important dates, likes,
 * dislikes, dietary needs, sizes, a gift, contact info, or any other fact — she
 * records it onto THAT person's People note. One tool, every fact, so nothing
 * scatters: a contact's fact never lands in the owner's profile
 * (update_user_profile) and a pet/home never becomes a Place (upsert_place).
 *
 * It resolves the person SMARTLY (a bare "Casey" finds "Casey Winslow" via
 * resolve_person_for_write) and creates a minimal note only on a genuine miss.
 * List-shaped facts (likes/pets/dates/…) ACCRETE (dedup + merge) so re-stating a
 * fact never duplicates it. A `note` catch-all appends any fact with no field.
 *
 * Like set_event_owner, calling this is the ONLY thing that makes the knowledge
 * stick — a small model otherwise just SAYS "noted" and records nothing (a
 * fabricated save). The chat_addendum carries the "call it, don't acknowledge" +
 * the routing rule (person fact → here; owner fact → update_user_profile; venue →
 * upsert_place).
 *
 * People are SHARED household entities: a new person stamps `private_to: household`
 * (a friend's contact silos to them); an existing note keeps its prior scope.
 */
import { z } from 'zod';
import { createHash, randomBytes } from 'node:crypto';
import type { Tool, ToolContext } from '@core/tool';
import { PersonFrontmatter } from '@memory/schemas/person';
import { stamp_private_to_if_needed, type Caller } from '@memory/private_to';
import { resolve_person_for_write } from '@core/entity_hydration';
import { coerce_address, to_str_array, to_obj_array } from '@agents/scribe/tools/_person_record';
import {
  accrete_string_list,
  accrete_gift_history,
  type GiftHistoryEntry,
} from '@core/gift_budget';
import { record_observation, user_model_enabled } from '@core/user_model';
import { local_iso_date } from '@core/time';

// List-field coercion (to_str_array / to_obj_array) + the flat-contact fold live
// in _person_record, shared by BOTH person writers so every field lands the same
// way no matter which tool the model picks. "x" / {value:"x"} / [{value:"x"}] → ["x"].
const StrArray = (desc: string) =>
  z.preprocess(to_str_array, z.array(z.string())).optional().describe(desc);

const PetInput = z.object({
  name: z.string().min(1),
  species: z.string().optional(),
  breed: z.string().optional(),
  notes: z.string().optional(),
});
const DateInput = z.object({
  date: z.string().describe('YYYY-MM-DD or MM-DD.'),
  what: z.string(),
  recurring: z.boolean().optional(),
});
const GiftInput = z.object({
  what: z.string().min(1).describe('What the gift was, e.g. "noise-cancelling headphones".'),
  cost: z.number().nonnegative().optional().describe('What it cost (a number), so the per-person budget can be learned.'),
  occasion: z.string().optional().describe('The occasion, e.g. "birthday", "Christmas".'),
  date: z.string().optional().describe('ISO date it was given; defaults to today.'),
  reception: z.string().optional().describe('How it landed, e.g. "loved it".'),
});

const InputSchema = z.object({
  person: z.string().min(1).describe('The person — their name (e.g. "Casey") or person id (p_xxxxxx).'),
  // ── Identity ──
  pronouns: z.string().optional().describe('Pronouns exactly as stated, e.g. "she/her", "they/them" — so they are never misgendered.'),
  preferred_name: z.string().optional().describe('What they go by, if different from their name.'),
  relationship: z
    .enum(['family', 'friend', 'colleague', 'acquaintance', 'service'])
    .optional()
    .describe('How they relate to the household.'),
  birthday: z.string().optional().describe('Birthday — YYYY-MM-DD or MM-DD.'),
  how_we_met: z.string().optional().describe('How the household knows them.'),
  // Coerced to a clean flat STRING (the model garbles this into nested
  // {street:{value:…}} / {value:…} shapes that break note projection — see
  // coerce_address). Accepts a plain string or any object shape.
  address: z
    .preprocess(coerce_address, z.string())
    .optional()
    .describe('Their HOME/mailing address (a plain string is fine, e.g. "10 Example Lane, Exeter NH 03833"). A contact\'s address belongs HERE on their note, never as a Place.'),
  // ── Contact — FLAT slots (the model fills flat fields reliably but skips /
  // garbles a nested `contact` object; assembled into `contact` in execute) ──
  email: StrArray('Email address(es), e.g. "sam@example.com".'),
  phone: StrArray('Phone number(s), e.g. "(555) 014-2266".'),
  preferred_channel: z
    .enum(['email', 'sms', 'imessage', 'card', 'call'])
    .optional()
    .describe('Best way to reach them.'),
  // ── Accreted facts (dedup + merge; re-stating never duplicates) ──
  likes: StrArray('Things they like / are into (each a short phrase).'),
  dislikes: StrArray('Things they dislike / avoid.'),
  dietary: StrArray('Dietary restrictions / allergies — drives what gets cooked when they visit.'),
  sizes: z.record(z.string(), z.string()).optional().describe('Sizes, e.g. { shirt: "L", shoe: "10" }.'),
  pets: z
    .preprocess(to_obj_array, z.array(PetInput))
    .optional()
    .describe('Their pets — each { name, species?, breed?, notes? }. A horse/dog/cat belongs HERE on the person, NOT as a Place.'),
  important_dates: z
    .preprocess(to_obj_array, z.array(DateInput))
    .optional()
    .describe('Dates to remember — each { date, what, recurring? } (an anniversary, surgery, a move, a graduation).'),
  gift: GiftInput.optional().describe('A gift you gave them, to add to their gift history.'),
  // ── Catch-all ──
  note: z
    .string()
    .optional()
    .describe('Any OTHER durable fact about them with no field above — appended to their note. Use this rather than routing a person-fact anywhere else.'),
});
const OutputSchema = z.object({
  ok: z.boolean(),
  note_path: z.string().optional(),
  person_id: z.string().optional(),
  created: z.boolean().optional(),
  applied: z.array(z.string()),
  note: z.string(),
});
type Input = z.infer<typeof InputSchema>;
type Output = z.infer<typeof OutputSchema>;

interface Pet {
  name: string;
  species?: string;
  breed?: string;
  notes?: string;
}
interface ImportantDate {
  date: string;
  what: string;
  recurring?: boolean;
}

/** Accrete pets by name (case-insensitive): merge provided fields, append distinct notes. */
function accrete_pets(existing: unknown, incoming: Pet[]): Pet[] {
  const out: Pet[] = Array.isArray(existing) ? (existing as Pet[]).map((p) => ({ ...p })) : [];
  for (const p of incoming) {
    const i = out.findIndex((e) => (e.name ?? '').toLowerCase() === p.name.toLowerCase());
    if (i >= 0) {
      const merged: Pet = { ...out[i]!, ...Object.fromEntries(Object.entries(p).filter(([, v]) => v != null && v !== '')) } as Pet;
      const old_notes = out[i]!.notes;
      if (p.notes && old_notes && !old_notes.includes(p.notes)) merged.notes = `${old_notes}; ${p.notes}`;
      out[i] = merged;
    } else {
      out.push(p);
    }
  }
  return out;
}
/** Accrete important dates, dedup by (date, what) case-insensitive. */
function accrete_dates(existing: unknown, incoming: ImportantDate[]): ImportantDate[] {
  const out: ImportantDate[] = Array.isArray(existing) ? (existing as ImportantDate[]).map((d) => ({ ...d })) : [];
  for (const d of incoming) {
    const dup = out.some((e) => e.date === d.date && (e.what ?? '').toLowerCase() === (d.what ?? '').toLowerCase());
    if (!dup) out.push(d);
  }
  return out;
}

const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';
function generate_person_id(): string {
  const bytes = randomBytes(6);
  let id = '';
  for (const b of bytes) id += ID_ALPHABET[b % 36];
  return `p_${id}`;
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

export const record_person_pref: Tool<Input, Output> = {
  name: 'record_person_pref',
  description:
    'Record ANY durable fact about a person onto their People note — THE one tool for everything you learn about someone: pronouns, relationship, birthday, address, how you met, pets, important dates, likes, dislikes, dietary needs, sizes, gifts, contact info, or any other fact (use `note`). ' +
    'CALL THIS whenever the owner states a fact about a person — "Casey\'s birthday is Feb 26", "she has a horse named Halo", "her address is 10 Example Lane", "Sam\'s email is sam@example.com", "his phone is (555) 014-2266", "Kim is she/her", "my dad hates surprises", "I gave Kim a $60 speaker". ' +
    'A fact about a PERSON lives here (not update_user_profile, which is the owner\'s own profile; not upsert_place, which is for venues — never pets or a person\'s home). Resolves the person by name (a first name is fine) and creates the note if new. Saying "noted" without calling this records NOTHING.',
  risk: 'write_internal',
  required_capabilities: ['write_vault_general'],
  input_schema: InputSchema,
  output_schema: OutputSchema,

  idempotency_key(input) {
    const h = createHash('sha256');
    h.update(input.person.toLowerCase().trim());
    h.update('\n');
    h.update(
      JSON.stringify({
        pronouns: input.pronouns,
        preferred_name: input.preferred_name,
        relationship: input.relationship,
        birthday: input.birthday,
        how_we_met: input.how_we_met,
        address: input.address,
        email: input.email,
        phone: input.phone,
        preferred_channel: input.preferred_channel,
        likes: input.likes,
        dislikes: input.dislikes,
        dietary: input.dietary,
        sizes: input.sizes,
        pets: input.pets,
        important_dates: input.important_dates,
        gift: input.gift,
        note: input.note,
      }),
    );
    return `record_person_pref:${h.digest('hex').slice(0, 16)}`;
  },

  async execute(input, ctx: ToolContext): Promise<Output> {
    // Resolve smartly (exact id/name, then the salient existing person) so a bare
    // "Casey" updates "Casey Winslow" instead of creating a duplicate; create
    // only when there's genuinely no match (mirrors find_or_create_person).
    const caller: Caller = { user_id: ctx.user?.id, tier: (ctx.user?.tier ?? 'friend') as Caller['tier'] };
    const existing = resolve_person_for_write(ctx.memory, input.person, caller);
    let note_path: string;
    let person_id: string;
    let created = false;
    let fm: Record<string, unknown>;

    if (existing) {
      note_path = existing.note_path;
      person_id = existing.id;
      fm = { ...existing.frontmatter };
    } else {
      person_id = generate_person_id();
      note_path = `People/${sanitize_filename(input.person)}.md`;
      const base = PersonFrontmatter.parse({
        type: 'person',
        id: person_id,
        name: input.person,
        relationship: input.relationship ?? 'acquaintance',
        friday_managed: false,
      });
      fm = stamp_private_to_if_needed(
        base as unknown as Record<string, unknown>,
        ctx.user ? { user_id: ctx.user.id, tier: ctx.user.tier } : undefined,
        'shared_entity',
      );
      created = true;
    }

    const applied: string[] = [];
    const set_str = (key: string, val: string | undefined, label: string): void => {
      if (typeof val === 'string' && val.trim()) {
        fm[key] = val.trim();
        applied.push(label);
      }
    };
    set_str('pronouns', input.pronouns, 'pronouns');
    set_str('preferred_name', input.preferred_name, 'preferred name');
    set_str('relationship', input.relationship, 'relationship');
    set_str('birthday', input.birthday, 'birthday');
    set_str('how_we_met', input.how_we_met, 'how we met');
    if (input.address) {
      // Already coerced to a clean string by the schema preprocess.
      fm.address = input.address;
      applied.push('address');
    }
    // Contact — assembled from the FLAT email/phone/preferred_channel slots into
    // the stored `contact` object (what the Friends card + who_is read).
    if (input.email?.length || input.phone?.length || input.preferred_channel) {
      const c: Record<string, unknown> = fm.contact && typeof fm.contact === 'object' ? { ...(fm.contact as Record<string, unknown>) } : {};
      if (input.email?.length) c.email = accrete_string_list(c.email as string[] | undefined, input.email);
      if (input.phone?.length) c.phone = accrete_string_list(c.phone as string[] | undefined, input.phone);
      if (input.preferred_channel) c.preferred_channel = input.preferred_channel;
      fm.contact = c;
      const bits = [
        input.email?.length ? 'email' : null,
        input.phone?.length ? 'phone' : null,
        input.preferred_channel ? 'channel' : null,
      ].filter(Boolean);
      applied.push(`contact (${bits.join('/')})`);
    }
    if (input.likes?.length) {
      fm.likes = accrete_string_list(fm.likes as string[] | undefined, input.likes);
      applied.push(`likes (+${input.likes.length})`);
    }
    if (input.dislikes?.length) {
      fm.dislikes = accrete_string_list(fm.dislikes as string[] | undefined, input.dislikes);
      applied.push(`dislikes (+${input.dislikes.length})`);
    }
    if (input.dietary?.length) {
      fm.dietary = accrete_string_list(fm.dietary as string[] | undefined, input.dietary);
      applied.push(`dietary (+${input.dietary.length})`);
    }
    if (input.sizes && Object.keys(input.sizes).length) {
      fm.sizes = { ...(fm.sizes as Record<string, string> | undefined), ...input.sizes };
      applied.push('sizes');
    }
    if (input.pets?.length) {
      fm.pets = accrete_pets(fm.pets, input.pets as Pet[]);
      applied.push(`pets (+${input.pets.length})`);
    }
    if (input.important_dates?.length) {
      fm.important_dates = accrete_dates(fm.important_dates, input.important_dates as ImportantDate[]);
      applied.push(`dates (+${input.important_dates.length})`);
    }
    if (input.gift) {
      const date = input.gift.date ?? local_iso_date(ctx.now ?? new Date());
      const entry: GiftHistoryEntry = {
        date,
        what: input.gift.what,
        ...(input.gift.cost !== undefined ? { cost: input.gift.cost } : {}),
        ...(input.gift.occasion ? { occasion: input.gift.occasion } : {}),
        ...(input.gift.reception ? { reception: input.gift.reception } : {}),
      };
      fm.gift_history = accrete_gift_history(fm.gift_history as GiftHistoryEntry[] | undefined, entry);
      applied.push('gift');

      // Afferent learning loop: feed the owner's gift_budget facet (dark unless
      // the per-user model is armed). The figure stays DERIVED from gift_history.
      if (user_model_enabled() && ctx.user?.id && input.gift.cost !== undefined) {
        try {
          record_observation(
            ctx.memory.user_profiles,
            ctx.user.id,
            'gift_budget',
            `Gave ${input.person}${input.gift.occasion ? ` (${input.gift.occasion})` : ''} a ${input.gift.what} for $${input.gift.cost}${input.gift.reception ? ` — ${input.gift.reception}` : ''}.`,
            ctx.now ?? new Date(),
          );
        } catch {
          /* fail-open — the facet feed never blocks the person write */
        }
      }
    }
    const note_text = input.note?.trim();
    if (note_text) applied.push('note');

    if (applied.length === 0) {
      return { ok: false, applied: [], note: 'Nothing to record — give at least one fact (pronouns / relationship / birthday / address / pets / dates / likes / dislikes / dietary / sizes / contact / gift / note).' };
    }

    ctx.memory.upsert_note(note_path, fm, '');
    // Free-text fact → body append (after the frontmatter write, which preserves
    // the existing body). Dated for provenance.
    if (note_text) {
      ctx.memory.append_to_note(note_path, `- ${local_iso_date(ctx.now ?? new Date())}: ${note_text}`);
    }
    const display_name = typeof fm.name === 'string' ? (fm.name as string) : input.person;
    ctx.memory.log_action({
      intent_id: ctx.intent_id,
      agent: ctx.specialist_id ?? 'kate',
      user_id: ctx.user?.id,
      tool_name: 'record_person_pref',
      tool_input: { person: input.person, applied },
      execution_result: { note_path, created },
    });

    return {
      ok: true,
      note_path,
      person_id,
      created,
      applied,
      note: `Recorded ${applied.join(', ')} for ${display_name}${created ? ' (new person note)' : ''}.`,
    };
  },
};
