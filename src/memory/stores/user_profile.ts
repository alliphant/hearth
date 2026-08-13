/**
 * UserProfileStore — the per-user "what this person has and cares about"
 * layer (2026-06-15).
 *
 * Hearth's data is already cordoned per user (private_to, per-user briefs,
 * per-user weather/calendar). What was missing is a structured record of
 * each user's FACETS — the slice of the household that is actually theirs:
 * does Sam have an EV? does she care about the garden? — so a brief, a
 * persona, or any future surface renders HER life, not Jasper's. Today every
 * household member's Kate brief carries a structural EV slot (owner-gated to
 * "no data") and every persona bakes in the global household block (Jasper's
 * Ioniq 5, his partner, his pets). Facets fix that at the source: a facet a
 * user lacks is simply absent, not "unavailable".
 *
 * Modeled on the single-row-merged-over-defaults idiom of
 * `codeshop_settings` / `presence_zones`: ONE row per user_id, a self-contained
 * table created in the constructor (CREATE TABLE IF NOT EXISTS — no central
 * SCHEMA_SQL edit, no SCHEMA_VERSION bump). Columns are additive.
 *
 * Two halves:
 *   - PERSISTENCE (this store): the stored facet set + per-facet detail +
 *     onboarding state. Dumb; no policy.
 *   - POLICY (pure functions below): `default_facets_for` (what a never-
 *     onboarded user implicitly has, by tier + household) and
 *     `effective_facets` (stored facets win once set; universals always on).
 *     `resolve_household_for_user` overlays a user's facets/detail over the
 *     global household context so persona tokens resolve per-speaker.
 *
 * The vault NARRATIVE (`users/<id>/profile.md`) is written separately by the
 * `update_user_profile` tool and stamped `private_to: <id>` — this store holds
 * only the structured facets the runtime reads on the hot path.
 */
import { Database } from 'bun:sqlite';
import type { Tier } from '@core/users';
import type { HouseholdContext } from '@core/household';

/**
 * The known facets. Extensible — the stored array may hold any string so a
 * future facet doesn't require a migration; these are the ones the runtime
 * understands today.
 *
 *   weather / calendar — UNIVERSAL (always on for everyone; listed for
 *                        documentation, never gated).
 *   ev                 — the user drives / tracks an EV (gates the brief's
 *                        EV block + the {{primary_vehicle}} persona token).
 *   pets               — shares the household animals (gates {{pet_names}}).
 *   garden / home_systems / finance / fitness / civic / music — domain
 *                        interests; reserved for future per-facet gating as
 *                        each specialist is extended. Stored now so onboarding
 *                        can capture them.
 */
export const KNOWN_FACETS = [
  'weather',
  'calendar',
  'ev',
  'pets',
  'garden',
  'home_systems',
  'finance',
  'fitness',
  'civic',
  'music',
] as const;
export type UserFacet = (typeof KNOWN_FACETS)[number];

/** Always-on facets — every user has weather + calendar regardless of tier. */
export const UNIVERSAL_FACETS: readonly UserFacet[] = ['weather', 'calendar'];

export interface StoredProfile {
  user_id: string;
  /** Explicitly-set facet list. Empty = never set (fall back to defaults). */
  facets: string[];
  /** Per-facet detail (e.g. { vehicles:[…], pets:[…], partner_name, interests }). */
  detail: Record<string, unknown>;
  /** ISO when the user completed Kate-led onboarding, else null. */
  onboarded_at: string | null;
  updated_at: string;
}

/** One facet of the unified per-user model (src/core/user_model.ts). */
export interface UserModelFacet {
  /** Short distilled prose — the read-at-context artifact. */
  summary: string;
  confidence: 'low' | 'med' | 'high';
  /** ISO of last synthesis. */
  last_refreshed: string;
  /** ISO of last read into a prompt (worth/decay signal; optional). */
  last_read?: string;
  /** Which exhaust streams fed it (provenance). */
  sources?: string[];
  /** New-observation count at last synthesis (the threshold-gate baseline). */
  count_at_refresh?: number;
  /** Raw dated observations for note-backed facets (capped/rotated). */
  observations?: Array<{ ts: string; text: string }>;
  /** Change cursor of the pulled evidence at last synthesis (taste facets) —
   *  the pull gate skips a re-distill while the source is unchanged. */
  pull_cursor?: string;
}

interface ProfileRow {
  user_id: string;
  facets_json: string;
  detail_json: string;
  onboarded_at: string | null;
  updated_at: string;
}

export class UserProfileStore {
  constructor(private db: Database) {
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS user_profiles (
         user_id TEXT PRIMARY KEY,
         facets_json TEXT NOT NULL DEFAULT '[]',
         detail_json TEXT NOT NULL DEFAULT '{}',
         onboarded_at TEXT,
         updated_at TEXT NOT NULL
       )`,
    );
  }

  /** The stored row for a user, or null if they have no row yet. */
  get(user_id: string): StoredProfile | null {
    const row = this.db
      .prepare(`SELECT * FROM user_profiles WHERE user_id = @uid`)
      .get({ '@uid': user_id }) as ProfileRow | undefined;
    if (!row) return null;
    return {
      user_id: row.user_id,
      facets: safe_json_array(row.facets_json),
      detail: safe_json_object(row.detail_json),
      onboarded_at: row.onboarded_at,
      updated_at: row.updated_at,
    };
  }

  /**
   * Replace the user's facet set and merge `detail` over any existing detail.
   * Pass the full intended facet list (the runtime treats a set list as
   * authoritative); universals are unioned in by `effective_facets`, so the
   * caller need not include them. Creates the row if absent.
   */
  set_facets(user_id: string, facets: string[], detail?: Record<string, unknown>): void {
    const current = this.get(user_id);
    const merged_detail = { ...(current?.detail ?? {}), ...(detail ?? {}) };
    const clean_facets = [...new Set(facets.map((f) => f.trim()).filter(Boolean))];
    this.db
      .prepare(
        `INSERT INTO user_profiles (user_id, facets_json, detail_json, onboarded_at, updated_at)
           VALUES (@uid, @facets, @detail, @onboarded, @now)
         ON CONFLICT(user_id) DO UPDATE SET
           facets_json = @facets, detail_json = @detail, updated_at = @now`,
      )
      .run({
        '@uid': user_id,
        '@facets': JSON.stringify(clean_facets),
        '@detail': JSON.stringify(merged_detail),
        '@onboarded': current?.onboarded_at ?? null,
        '@now': new Date().toISOString(),
      });
  }

  /**
   * Merge the distilled per-user communication-style profile into `detail`
   * (preserving facets + other detail). Written by the per-user style learning
   * loop; read every chat turn by the house-voice block (house_voice.ts).
   * Cordoned by construction — callers pass the SPEAKER's own user_id. Creates
   * the row if absent.
   */
  set_style_profile(user_id: string, style_profile: string): void {
    const current = this.get(user_id);
    const merged_detail = { ...(current?.detail ?? {}), style_profile };
    this.db
      .prepare(
        `INSERT INTO user_profiles (user_id, facets_json, detail_json, onboarded_at, updated_at)
           VALUES (@uid, @facets, @detail, @onboarded, @now)
         ON CONFLICT(user_id) DO UPDATE SET
           detail_json = @detail, updated_at = @now`,
      )
      .run({
        '@uid': user_id,
        '@facets': JSON.stringify(current?.facets ?? []),
        '@detail': JSON.stringify(merged_detail),
        '@onboarded': current?.onboarded_at ?? null,
        '@now': new Date().toISOString(),
      });
  }

  // ── The unified per-user model — facet substrate (2026-06-19) ─────────────
  // detail.user_model.facets[key] holds one Facet each; `summary` is the
  // read-at-context artifact. The 'style' facet mirrors to the legacy
  // detail.style_profile so the live house-voice read path is unbroken. See
  // src/core/user_model.ts for the engine + resolver. Cordoned by construction.

  get_user_model(user_id: string): { facets: Record<string, UserModelFacet> } {
    const um = this.get(user_id)?.detail?.['user_model'];
    const facets =
      um && typeof um === 'object' && 'facets' in um
        ? (um as { facets?: unknown }).facets
        : undefined;
    return {
      facets: (facets && typeof facets === 'object' ? facets : {}) as Record<string, UserModelFacet>,
    };
  }

  get_facet(user_id: string, key: string): UserModelFacet | null {
    return this.get_user_model(user_id).facets[key] ?? null;
  }

  /**
   * Upsert one facet, preserving every other facet + facets[] + detail. The
   * 'style' facet ALSO mirrors its summary to detail.style_profile (legacy
   * house-voice read path). Cordoned — callers pass the SPEAKER's own user_id.
   */
  set_facet(user_id: string, key: string, facet: UserModelFacet): void {
    const current = this.get(user_id);
    const detail = { ...(current?.detail ?? {}) };
    const um = (
      detail['user_model'] && typeof detail['user_model'] === 'object'
        ? { ...(detail['user_model'] as Record<string, unknown>) }
        : {}
    ) as { facets?: Record<string, UserModelFacet> };
    um.facets = { ...(um.facets ?? {}), [key]: facet };
    detail['user_model'] = um;
    if (key === 'style') detail['style_profile'] = facet.summary;
    this._write_detail(user_id, current, detail);
  }

  private _write_detail(
    user_id: string,
    current: StoredProfile | null,
    detail: Record<string, unknown>,
  ): void {
    this.db
      .prepare(
        `INSERT INTO user_profiles (user_id, facets_json, detail_json, onboarded_at, updated_at)
           VALUES (@uid, @facets, @detail, @onboarded, @now)
         ON CONFLICT(user_id) DO UPDATE SET
           detail_json = @detail, updated_at = @now`,
      )
      .run({
        '@uid': user_id,
        '@facets': JSON.stringify(current?.facets ?? []),
        '@detail': JSON.stringify(detail),
        '@onboarded': current?.onboarded_at ?? null,
        '@now': new Date().toISOString(),
      });
  }

  /** Stamp onboarding as complete (idempotent; first stamp wins). */
  mark_onboarded(user_id: string): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO user_profiles (user_id, facets_json, detail_json, onboarded_at, updated_at)
           VALUES (@uid, '[]', '{}', @now, @now)
         ON CONFLICT(user_id) DO UPDATE SET
           onboarded_at = COALESCE(user_profiles.onboarded_at, @now), updated_at = @now`,
      )
      .run({ '@uid': user_id, '@now': now });
  }

  is_onboarded(user_id: string): boolean {
    const row = this.db
      .prepare(`SELECT onboarded_at FROM user_profiles WHERE user_id = @uid`)
      .get({ '@uid': user_id }) as { onboarded_at: string | null } | undefined;
    return Boolean(row?.onboarded_at);
  }

  /**
   * Re-open onboarding: clear `onboarded_at` so the Kate-led playbook injects
   * again on the user's next chat. Facets/detail are PRESERVED — a reset
   * re-runs the interview from the user's current baseline, it doesn't wipe
   * their profile (pass `clear_facets` for a full fresh start). Idempotent: a
   * user with no row is already not-onboarded, so this is a no-op for them.
   * Returns true if a stored onboarding stamp was actually cleared.
   */
  reset_onboarding(user_id: string, opts: { clear_facets?: boolean } = {}): boolean {
    const current = this.get(user_id);
    const was_onboarded = Boolean(current?.onboarded_at);
    if (!current && !opts.clear_facets) return false;
    this.db
      .prepare(
        `INSERT INTO user_profiles (user_id, facets_json, detail_json, onboarded_at, updated_at)
           VALUES (@uid, @facets, @detail, NULL, @now)
         ON CONFLICT(user_id) DO UPDATE SET
           onboarded_at = NULL,
           facets_json = @facets,
           detail_json = @detail,
           updated_at = @now`,
      )
      .run({
        '@uid': user_id,
        '@facets': JSON.stringify(opts.clear_facets ? [] : (current?.facets ?? [])),
        '@detail': JSON.stringify(opts.clear_facets ? {} : (current?.detail ?? {})),
        '@now': new Date().toISOString(),
      });
    return was_onboarded;
  }
}

function safe_json_array(s: string): string[] {
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function safe_json_object(s: string): Record<string, unknown> {
  try {
    const v = JSON.parse(s);
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

// ── Facet policy (pure) ──────────────────────────────────────────────────

/**
 * What a NEVER-onboarded user implicitly has, derived from their tier and the
 * household block. The contract that keeps the owner byte-identical:
 *
 *   - owner    — universals + every facet the household block implies (ev if a
 *                vehicle is configured, pets if pets are, garden if a growing
 *                zone is) + home_systems. This reproduces today's behavior:
 *                Jasper's brief carries EV, his personas keep the Ioniq / pets.
 *   - household — universals + the SHARED-home facets (pets, garden,
 *                home_systems) they genuinely live with — but NOT `ev` (the
 *                owner's vehicle is not theirs) and NOT the personal/opt-in
 *                surfaces (finance/fitness/civic/music), which onboarding turns
 *                on. This is the "no EV for Sam" default.
 *   - friend   — universals only (scoped to one specialist; no household facets).
 *
 * `household` is the flat token context (`primary_vehicle`, `pet_names`,
 * `usda_growing_zone`) — present-keys signal which household facets exist.
 */
export function default_facets_for(tier: Tier, household: HouseholdContext): Set<string> {
  const facets = new Set<string>(UNIVERSAL_FACETS);
  const has_vehicle = Boolean(household.primary_vehicle);
  const has_pets = Boolean(household.pet_names);
  const has_garden = Boolean(household.usda_growing_zone);

  if (tier === 'owner') {
    if (has_vehicle) facets.add('ev');
    if (has_pets) facets.add('pets');
    if (has_garden) facets.add('garden');
    facets.add('home_systems');
  } else if (tier === 'household') {
    // Shared-home facets the household member genuinely lives with — but never
    // `ev` (not their vehicle) and never the personal opt-in surfaces.
    if (has_pets) facets.add('pets');
    if (has_garden) facets.add('garden');
    facets.add('home_systems');
  }
  // friend → universals only.
  return facets;
}

/**
 * The effective facets for a user: their explicitly-set facets if any have
 * been set (onboarding / dynamic learning is authoritative — "selected per
 * user initially, dynamic ever after"), else the tier+household defaults.
 * Universals are always unioned in.
 */
export function effective_facets(
  stored: StoredProfile | null,
  tier: Tier,
  household: HouseholdContext,
): Set<string> {
  const base =
    stored && stored.facets.length > 0
      ? new Set<string>(stored.facets)
      : default_facets_for(tier, household);
  for (const u of UNIVERSAL_FACETS) base.add(u);
  return base;
}

/** Convenience: does this user (resolved) have a given facet? */
export function user_has_facet(
  stored: StoredProfile | null,
  tier: Tier,
  household: HouseholdContext,
  facet: UserFacet,
): boolean {
  return effective_facets(stored, tier, household).has(facet);
}

/**
 * Overlay a user's facets + detail over the global household context, so the
 * deferred persona tokens (`{{primary_vehicle}}`, `{{pet_names}}`,
 * `{{partner_name}}`) resolve PER-SPEAKER at turn time instead of being baked
 * to the owner's household at load.
 *
 * Rules (the owner resolves to the global context unchanged):
 *   - `{{user_name}}` → the speaker's display name.
 *   - vehicle tokens → kept only when the user has the `ev` facet; a
 *     profile-supplied `detail.primary_vehicle` overrides. Without the facet
 *     they are blanked, so the persona's own `:default` fallback renders
 *     (e.g. Iris's `{{primary_vehicle:EV}}` → "EV"), never the owner's Ioniq.
 *   - pet tokens → kept only with the `pets` facet; `detail.pet_names`
 *     overrides.
 *   - `{{partner_name}}` → `detail.partner_name` if set, else the global value
 *     for the owner only, else blanked (falls to the persona default).
 *
 * Blanking (vs. substituting a value) lets the un-deferred persona default win;
 * `build_system_prompt` strips any still-literal deferred token afterward as a
 * final safety net.
 */
export function resolve_household_for_user(args: {
  base: HouseholdContext;
  tier: Tier;
  stored: StoredProfile | null;
  display_name?: string;
}): HouseholdContext {
  const { base, tier, stored } = args;
  const facets = effective_facets(stored, tier, base);
  const detail = stored?.detail ?? {};
  const out: HouseholdContext = { ...base };

  if (args.display_name) out.user_name = args.display_name;

  // Vehicle (EV) — facet-gated, detail-overridable.
  if (!facets.has('ev')) {
    delete out.primary_vehicle;
    delete out.primary_vehicle_make;
  } else if (typeof detail.primary_vehicle === 'string' && detail.primary_vehicle.length > 0) {
    out.primary_vehicle = detail.primary_vehicle;
    if (typeof detail.primary_vehicle_make === 'string') {
      out.primary_vehicle_make = detail.primary_vehicle_make;
    }
  }

  // Pets — facet-gated, detail-overridable.
  if (!facets.has('pets')) {
    delete out.pet_names;
    delete out.pet_names_list;
  } else if (typeof detail.pet_names === 'string' && detail.pet_names.length > 0) {
    out.pet_names = detail.pet_names;
    out.pet_names_list = detail.pet_names;
  }

  // Partner — relationship is directional; the global value is owner-centric.
  if (typeof detail.partner_name === 'string' && detail.partner_name.length > 0) {
    out.partner_name = detail.partner_name;
  } else if (tier !== 'owner') {
    delete out.partner_name;
  }

  return out;
}
