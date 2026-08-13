/**
 * Household context: the token substitution layer that lets persona YAMLs
 * ship generic (`{{user_name}}`, `{{pet_names}}`, etc.) and bind to the
 * running household at load time.
 *
 * Two things live here:
 *   - HouseholdSchema — the Zod shape that validates the `household:`
 *     block in config/users.yaml.
 *   - substitute() — a tiny Mustache-lite that walks persona text and
 *     replaces `{{token}}` or `{{token:default}}` from the context.
 *
 * Substitution is applied at persona load time in
 * src/core/specialist.ts — the YAML stays generic on disk, the running
 * specialist sees the bound text. That keeps the repo sanitized for the
 * public hearth-prod mirror while preserving per-household customization
 * via one file edit (config/users.yaml).
 */

import { z } from 'zod';

export const HouseholdSchema = z
  .object({
    /** Brand name displayed in UI + persona references. Defaults to "Hearth". */
    brand: z.string().min(1).default('Hearth'),
    /** Optional name for the home itself ("Westwood"). No default. */
    home_name: z.string().min(1).optional(),
    /** City the household lives in ("Pleasantville"). No default. */
    primary_city: z.string().min(1).optional(),
    /** State / region ("Colorado"). No default. */
    primary_region: z.string().min(1).optional(),
    /** USDA hardiness zone for the garden ("5b", "7a"). No default. */
    usda_growing_zone: z.string().min(1).optional(),
    /**
     * Secondary household member display name — the "you and ___" person.
     * Drives Brigid's per-household-member references. The shipped
     * persona uses `{{partner_name:Sam}}` so a default install renders
     * the placeholder "Sam"; users with an actual partner bind their
     * display name here.
     */
    partner_name: z.string().min(1).optional(),
    /** Pets in the household — name + species. Drives Anya's persona. */
    pets: z
      .array(
        z
          .object({
            name: z.string().min(1),
            species: z.string().optional(),
          })
          .strict(),
      )
      .default([]),
    /** Vehicles in the household — first is "primary" for Iris's plan_ev_day. */
    vehicles: z
      .array(
        z
          .object({
            make: z.string().min(1),
            model: z.string().min(1),
            kwh_per_mile: z.number().positive().optional(),
            usable_kwh: z.number().positive().optional(),
          })
          .strict(),
      )
      .default([]),
    /** Music / event venues within reasonable travel for Maggie's research. */
    nearby_venues: z.array(z.string().min(1)).default([]),
    /** Cities within Maggie's tour-research radius. */
    nearby_cities: z.array(z.string().min(1)).default([]),
  })
  .strict();

export type Household = z.infer<typeof HouseholdSchema>;

/**
 * Flat string map the substituter actually reads. Built from a Household
 * + admin user, with values pre-joined (pets → "Bailey and Mango", venues
 * → comma list, etc.) so persona authors don't have to think about it.
 */
export interface HouseholdContext {
  user_name: string;
  household_brand: string;
  home_name?: string;
  primary_city?: string;
  primary_region?: string;
  usda_growing_zone?: string;
  partner_name?: string;          // secondary household member display name
  pet_names?: string;             // joined naturally: "Bailey and Mango"
  pet_names_list?: string;        // comma-only: "Bailey, Mango"
  primary_vehicle?: string;       // "Ioniq 5"
  primary_vehicle_make?: string;  // "Hyundai"
  nearby_venues?: string;         // comma-joined
  nearby_cities?: string;         // comma-joined
  /**
   * The rendered staff paragraph (2026-07-26) — NOT a household fact but a
   * REGISTRY one, carried here because this context is the substitution
   * vehicle every persona already flows through. Composed per-turn in
   * `build_system_prompt` from the live specialist list (see
   * `core/staff_roster.ts`), which is why it's a deferred token: at
   * config-load time the full roster isn't known yet, and a specialist folded
   * after boot must not leave stale prose behind.
   */
  staff_roster?: string;
}

/** Join a list with Oxford-comma natural English. */
function natural_join(items: string[]): string {
  if (items.length === 0) return '';
  if (items.length === 1) return items[0]!;
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`;
}

export function build_context(
  household: Household | undefined,
  admin_display_name: string | undefined,
): HouseholdContext {
  const h = household ?? HouseholdSchema.parse({});
  const ctx: HouseholdContext = {
    user_name: admin_display_name ?? 'you',
    household_brand: h.brand,
  };
  if (h.home_name) ctx.home_name = h.home_name;
  if (h.primary_city) ctx.primary_city = h.primary_city;
  if (h.primary_region) ctx.primary_region = h.primary_region;
  if (h.usda_growing_zone) ctx.usda_growing_zone = h.usda_growing_zone;
  if (h.partner_name) ctx.partner_name = h.partner_name;

  if (h.pets.length > 0) {
    const names = h.pets.map((p) => p.name);
    ctx.pet_names = natural_join(names);
    ctx.pet_names_list = names.join(', ');
  }

  const primary = h.vehicles[0];
  if (primary) {
    ctx.primary_vehicle = `${primary.make} ${primary.model}`.trim();
    ctx.primary_vehicle_make = primary.make;
  }

  if (h.nearby_venues.length > 0) {
    ctx.nearby_venues = h.nearby_venues.join(', ');
  }
  if (h.nearby_cities.length > 0) {
    ctx.nearby_cities = h.nearby_cities.join(', ');
  }
  return ctx;
}

/**
 * The persona tokens whose binding is PER-USER, not household-global. Left as
 * literals in the `_template` copies at load (via `substitute(..., defer)`) so
 * the runtime resolves them per-speaker in `build_system_prompt` from the
 * speaker's profile (see `resolve_household_for_user`). `{{user_name}}` was the
 * original deferred token; the household tokens (2026-06-15) join it so Sam's
 * Iris doesn't reference Jasper's Ioniq and Sam's Anya doesn't claim his pets.
 * Everything else (brand, home_name, city, venues, growing zone) is genuinely
 * household-wide and stays substituted at load.
 */
export const DEFERRED_PERSONA_TOKENS: ReadonlySet<string> = new Set([
  'user_name',
  'primary_vehicle',
  'primary_vehicle_make',
  'pet_names',
  'pet_names_list',
  'partner_name',
  // Registry-derived, resolved per-turn from the live specialist list so a
  // fold takes effect on reload instead of waiting for someone to hand-edit
  // prose. See core/staff_roster.ts.
  'staff_roster',
]);

const DEFERRED_TOKEN_RE = new RegExp(
  `\\{\\{(?:${[...DEFERRED_PERSONA_TOKENS].join('|')})(?::[^}]*)?\\}\\}`,
  'g',
);

/**
 * Clear any STILL-LITERAL deferred persona token after per-user resolution —
 * a bare `{{pet_names}}` for a user who lacks the pets facet (no `:default` to
 * fall back to) would otherwise reach the model verbatim. Run at the tail of
 * the runtime's per-turn substitution. Tokens with a `:default` already
 * resolved to that default, so this only catches the fallback-less stragglers.
 */
export function strip_deferred_tokens(text: string): string {
  return text.replace(DEFERRED_TOKEN_RE, '');
}

/**
 * Mustache-lite substitution.
 *
 *   `{{user_name}}`         → ctx.user_name (or the literal `{{user_name}}` if unset)
 *   `{{pet_names:our pets}}` → ctx.pet_names if defined, else "our pets"
 *
 * Leaving the literal token visible on un-set + no-default is deliberate:
 * persona authors see immediately when they referenced a token nobody
 * configured. The alternative (silent empty) produces sentences like
 * "You care for  the way you'd care for…" which is worse.
 *
 * `defer` — keys to LEAVE as literal tokens regardless of the context (and
 * regardless of any `:default`), so a later pass can resolve them per-speaker.
 * This is how the `_template` copies keep `{{primary_vehicle:EV}}` intact: the
 * empty-string trick only works for fallback-less tokens like `{{user_name}}`,
 * but household tokens carry `:default`s that would otherwise collapse at load.
 */
export function substitute(
  text: string,
  ctx: HouseholdContext,
  defer?: ReadonlySet<string>,
): string {
  return text.replace(
    /\{\{([a-z_][a-z0-9_]*)(?::([^}]*))?\}\}/g,
    (match, key: string, fallback: string | undefined) => {
      if (defer?.has(key)) return match;
      const v = ctx[key as keyof HouseholdContext];
      if (typeof v === 'string' && v.length > 0) return v;
      if (fallback !== undefined) return fallback;
      return match;
    },
  );
}

// ── Module-level binding ────────────────────────────────────────────────
//
// The orchestrator calls set_household_context() once on boot before
// constructing SpecialistRegistry. Other code paths (smokes, tests) that
// load specialists without going through the full orchestrator boot get
// the default context — which leaves tokens visible, surfacing
// misconfiguration loudly.

let _ctx: HouseholdContext = { user_name: 'you', household_brand: 'Hearth' };

export function set_household_context(ctx: HouseholdContext): void {
  _ctx = ctx;
}

export function get_household_context(): HouseholdContext {
  return _ctx;
}
