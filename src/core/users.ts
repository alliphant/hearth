/**
 * User identity + per-user state.
 *
 * v0 is single-user but the shape is multi-user-ready. Identity is loaded
 * once from config/users.yaml at boot; per-user runtime state
 * (active_specialist, quiet-mode override) lives in the kv_settings
 * SQLite table so it survives restarts but doesn't pollute config files.
 *
 * The /app web client calls these via the HTTP routes mounted in
 * apps/orchestrator/server.ts — see /api/users/* for the surface.
 */

import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse as parse_yaml, parseDocument, isMap, isSeq } from 'yaml';
import type { Document, YAMLMap, YAMLSeq } from 'yaml';
import { z } from 'zod';
import type { Database } from 'bun:sqlite';
import {
  HouseholdSchema,
  build_context,
  type Household,
  type HouseholdContext,
} from './household';

/**
 * Per-user dietary profile read by Brigid (the cook). v0.5 carries this
 * inline on the user record so single-user infra stays single-user — the
 * real "household members" abstraction is a Phase 2.5+ concern. Optional
 * everywhere so a user record without a dietary block (e.g. a household
 * member you haven't profiled yet) still validates.
 */
/**
 * Per-macro daily gram targets. All fields optional so a member can carry
 * just the numbers they actually track. When unset, Brigid falls back to
 * `macro_priority` (the soft enum) for shape; when set, these are the
 * authoritative numbers she plans against.
 *
 * Semantic note: `protein_g`, `carbs_g`, `fat_g`, `fiber_g` are usually
 * targets (aim FOR these), while `net_carbs_g` is usually a ceiling.
 * Brigid is told this in her persona; the schema doesn't encode it
 * because real eating patterns vary (some people target fiber as a min,
 * some as an exact number).
 */
export const MacroTargetsSchema = z
  .object({
    protein_g: z.number().nonnegative().optional(),
    carbs_g: z.number().nonnegative().optional(),
    fat_g: z.number().nonnegative().optional(),
    fiber_g: z.number().nonnegative().optional(),
    net_carbs_g: z.number().nonnegative().optional(),
  })
  .strict();

export const DietaryProfileSchema = z
  .object({
    daily_calorie_target: z.number().int().positive().nullable().default(null),
    /** Hard daily ceiling. Brigid will not plan a day above this. */
    daily_calorie_max: z.number().int().positive().nullable().default(null),
    macro_priority: z
      .enum(['balanced', 'protein_high', 'low_carb', 'mediterranean'])
      .default('balanced'),
    /** Optional gram-level macro targets. Authoritative when present. */
    macro_targets: MacroTargetsSchema.optional(),
    restrictions: z.array(z.string().min(1)).default([]),
    favorites: z.array(z.string().min(1)).default([]),
    dislikes: z.array(z.string().min(1)).default([]),
    portion_factor: z.number().positive().max(5).default(1.0),
  })
  .strict();

/**
 * Per-user training/fitness profile read by Astrid (the trainer). All
 * fields optional so a household member without a fitness profile still
 * validates. Astrid persists her own running observations + per-workout
 * journals in the per-user vault namespace (users/<id>/astrid/**); this
 * block carries the few quantified knobs other specialists need at
 * planning time.
 *
 * `recovery_snack_threshold_kcal` is the active-calorie threshold
 * Astrid's awareness handler uses to decide whether a completed workout
 * warrants flagging Brigid for a recovery snack. Default 400 — covers a
 * solid 45-min cycling / running session but not casual walking. Set
 * higher for someone cutting and not wanting post-session nudges; set
 * lower for someone in a building phase wanting more frequent fueling.
 */
export const TrainingProfileSchema = z
  .object({
    recovery_snack_threshold_kcal: z.number().int().positive().nullable().default(null),
    // Live-cue cadence knobs (Live Ride Companion Phase 1 —
    // docs/design-astrid-live-companion.md §6.5). All nullable; the
    // runtime defaults are min_gap 5 min, session cap 12 cues,
    // milestone every 5 mi (imperial) / 10 km (metric), voice on.
    cue_min_gap_min: z.number().int().positive().nullable().default(null),
    cue_session_cap: z.number().int().positive().nullable().default(null),
    /** Distance-milestone interval in the USER'S display units (miles
     *  for imperial, km for metric — see the top-level `units` field).
     *  Renamed from cue_distance_milestone_km 2026-06-11, before any
     *  users.yaml carried it. */
    cue_distance_milestone: z.number().positive().nullable().default(null),
    /** 'off' = text-only pushes (voice clips skipped). */
    voice_cues: z.enum(['on', 'off']).nullable().default(null),
  })
  .strict();

/**
 * User access tier — drives discretion behavior across specialists.
 *
 * The household-OS framing:
 *   - `owner`     — captain of the ship; full visibility, default for
 *                   legacy code paths. Typically one per system.
 *   - `household` — crew member sharing physical resources (Sam,
 *                   future household members). Can see household-
 *                   wide state (garden, pets, diet); cannot see
 *                   owner-private state (finances, location, security).
 *   - `friend`    — invited guest scoped to a specific specialist set.
 *                   No household-internal state. Foundation for the
 *                   future invite-based friend onboarding (Phase 2c).
 *
 * Distinct from the `role` field (admin gating for the /admin
 * surface). A user can be `role: user` AND `tier: owner` (the
 * captain isn't always the admin), or `role: admin` AND `tier:
 * household` (a household member with admin powers). The two
 * axes are orthogonal by design.
 */
export const TierEnum = z.enum(['owner', 'household', 'friend']);
export type Tier = z.infer<typeof TierEnum>;

export const UserConfigSchema = z
  .object({
    id: z.string().min(1),
    display_name: z.string().min(1),
    telegram_user_id: z.string().nullable().default(null),
    telegram_chat_id: z.string().nullable().default(null),
    app_token: z.string().nullable().default(null),
    allowed_specialists: z.union([z.literal('*'), z.array(z.string())]),
    timezone: z.string().min(1),
    /** Display units for distance/speed/elevation across every surface
     *  that renders a measurement (Astrid's office, live cues, ride
     *  names, PR shelf). Storage stays metric; this is render-time
     *  only — see src/core/units.ts. Default imperial. */
    units: z.enum(['imperial', 'metric']).default('imperial'),
    notification_config_ref: z.string().min(1),
    dietary: DietaryProfileSchema.optional(),
    training: TrainingProfileSchema.optional(),
    // Multi-user auth (Phase 0+). pin_hash is the lowercase-hex
    // SHA-256 of the user's PIN — same format FRIDAY uses, so the
    // two systems can share an identity store via a one-line shim.
    // role gates the /admin surface; default 'user' keeps the rail
    // safe (admin must be explicit per profile).
    pin_hash: z.string().regex(/^[a-f0-9]{64}$/).nullable().default(null),
    // Email + password landed 2026-05-25 per hearth-ios
    // BACKEND_AUTH_BRIEF. email is lowercased for case-insensitive
    // login lookup; password_hash is argon2id (Bun.password). Both
    // nullable so legacy users (or YAML-edited additions) validate
    // without a credential, and set_credential CLI fills them in.
    email: z.string().email().toLowerCase().nullable().default(null),
    password_hash: z.string().nullable().default(null),
    password_updated_at: z.string().nullable().default(null),
    // Sign in with Apple — the stable Apple subject id (the identity
    // token's `sub`), bound to a pre-provisioned account via the
    // /api/auth/apple/link flow. An IDENTIFIER, not a secret (no more
    // sensitive than `email`), so it lives here in YAML, not SQLite.
    // We link by `sub`, never email: Hide-My-Email gives a
    // @privaterelay address that won't match a provisioned mailbox.
    apple_sub: z.string().nullable().default(null),
    // Bootstrap flags (2026-05-25). Admin creates a user via
    // POST /api/admin/users with an initial password; both flags
    // land true. On first login the response carries these so the
    // client routes to a setup screen. /auth/change_password and
    // /auth/set_pin clear them on success.
    must_change_password: z.boolean().default(false),
    must_set_pin: z.boolean().default(false),
    theme: z.string().nullable().default(null),
    role: z.enum(['admin', 'user', 'guest']).default('user'),
    // Phase 2b. Default 'household' is the safe choice for any new
    // user profile — the captain must be tagged explicitly. Specialist
    // discretion rules key off this field, not user.id.
    tier: TierEnum.default('household'),
    // Per-user home location — Pirate Weather connector keys per-user
    // queries off these. Optional: when absent, the weather connector
    // falls back to HEARTH_HOME_LAT/HEARTH_HOME_LON env (legacy global
    // owner default) so an unset value degrades to a clear
    // "unavailable" rather than a wrong-place forecast. `label` is a
    // friendly human-readable name shown in audit + UI ("Fort
    // Collins, CO"); coordinates are at full precision in the
    // canonical source (this file) and rounded to 3 decimals in audit
    // rows, matching the maps connector's pattern.
    home_location: z
      .object({
        lat: z.number().min(-90).max(90),
        lng: z.number().min(-180).max(180),
        label: z.string().nullable().default(null),
      })
      .strict()
      .nullable()
      .default(null),
  })
  .strict();

const UsersFileSchema = z
  .object({
    users: z.array(UserConfigSchema).default([]),
    // Optional household block — populated values drive persona token
    // substitution (see src/core/household.ts). Omitting it keeps every
    // token at its default ("you" for user_name, "Hearth" for brand,
    // empty for the rest).
    household: HouseholdSchema.optional(),
  })
  .strict();

export type MacroTargets = z.infer<typeof MacroTargetsSchema>;
export type DietaryProfile = z.infer<typeof DietaryProfileSchema>;
export type TrainingProfile = z.infer<typeof TrainingProfileSchema>;
export type UserConfig = z.infer<typeof UserConfigSchema>;

/**
 * The runtime-facing slice of a user — what `SpecialistTurnInput.user`
 * expects. Strips PIN hashes, telegram bindings, dietary blocks, and
 * other fields the SpecialistRuntime has no business seeing. Route
 * handlers call this on `c.get('user')` before passing into
 * `runtime.turn()` / `turn_streaming()`.
 *
 * Returns `undefined` for an absent user — the runtime treats absence
 * as the legacy owner default, preserving deliberation / scheduler /
 * internal-HTTP behavior.
 */
export interface TurnUser {
  id: string;
  display_name: string;
  tier: Tier;
  /** Stored IANA zone. Overridden per-request when X-User-Timezone is present. */
  timezone: string;
}

export function to_turn_user(u: UserConfig | null | undefined, tz_override?: string): TurnUser | undefined {
  if (!u) return undefined;
  return {
    id: u.id,
    display_name: u.display_name,
    tier: u.tier,
    timezone: tz_override || u.timezone || 'America/Denver',
  };
}

export interface NotificationConfig {
  quiet_hours: { start: string; end: string; timezone: string };
  push_thresholds: {
    during_quiet_hours: 'low' | 'medium' | 'medium-high' | 'high';
    outside_quiet_hours: 'low' | 'medium' | 'medium-high' | 'high';
  };
  user_messages_always_through: boolean;
}

const DEFAULT_USERS_PATH = resolve(
  process.env.HEARTH_USERS_PATH ?? './config/users.yaml',
);
const DEFAULT_NOTIFICATIONS_PATH = resolve(
  process.env.HEARTH_NOTIFICATIONS_PATH ?? './config/notifications.yaml',
);

export class UserRegistry {
  private users: UserConfig[] = [];
  private notif_configs: Record<string, NotificationConfig> = {};
  private _household: Household | undefined;

  constructor(
    private users_path: string = DEFAULT_USERS_PATH,
    private notifications_path: string = DEFAULT_NOTIFICATIONS_PATH,
    private db?: Database,
  ) {
    this.reload();
  }

  reload(): void {
    if (!existsSync(this.users_path)) {
      this.users = [];
      this._household = undefined;
    } else {
      let raw: unknown;
      try {
        raw = parse_yaml(readFileSync(this.users_path, 'utf-8')) ?? { users: [] };
      } catch (err) {
        console.error(
          `[users] users.yaml parse failed (keeping previous ${this.users.length} user(s)): ${(err as Error).message}`,
        );
        return;
      }
      const parsed = UsersFileSchema.safeParse(raw);
      if (!parsed.success) {
        console.error(
          `[users] users.yaml schema validation failed (keeping previous ${this.users.length} user(s)): ${parsed.error.message}`,
        );
        return;
      }
      this.users = parsed.data.users;
      this._household = parsed.data.household;
    }
    if (!existsSync(this.notifications_path)) {
      this.notif_configs = {};
    } else {
      const raw = parse_yaml(
        readFileSync(this.notifications_path, 'utf-8'),
      ) as Record<string, NotificationConfig> | null;
      this.notif_configs = raw ?? {};
    }
  }

  list(): UserConfig[] {
    return this.users.slice();
  }

  /** Raw household block as parsed from config/users.yaml; undefined if absent. */
  household(): Household | undefined {
    return this._household;
  }

  /**
   * Built persona-substitution context — flat string map with the admin
   * user's display name, household brand, joined pet names, primary
   * vehicle, etc. The orchestrator calls this once on boot and passes
   * it to set_household_context() so the persona loader can substitute
   * at YAML-load time.
   */
  household_context(): HouseholdContext {
    const admin = this.users.find((u) => u.role === 'admin') ?? this.users[0];
    return build_context(this._household, admin?.display_name);
  }

  get(id: string): UserConfig | null {
    return this.users.find((u) => u.id === id) ?? null;
  }

  /**
   * The household's primary owner — the first owner-tier user in config
   * order (users.yaml order is authoritative; the household has one).
   * System-context callers (a deliberation pass, the away-from-home
   * monitor) use this to key owner-scoped reads when no request user
   * exists — the "absent user = system context = allowed" convention
   * the camera tools already follow. Returns null on a roster with no
   * owner-tier user (fresh install mid-provisioning).
   */
  primary_owner(): UserConfig | null {
    return this.users.find((u) => u.tier === 'owner') ?? null;
  }

  /**
   * Per-user home coordinates for weather queries (Pirate Weather
   * connector + brief context puller). Resolution order:
   *
   *   1. Per-user `home_location` from config/users.yaml — the
   *      canonical source. Each household member can have their own
   *      home; Sam's brief reads weather at her place, not Jasper's.
   *   2. Process env `HEARTH_HOME_LAT` / `HEARTH_HOME_LON` — legacy
   *      single-owner default, preserved so a fresh-install the always-on host
   *      doesn't lose weather until users.yaml gets per-user coords.
   *   3. null — caller must surface an "unavailable" reading rather
   *      than fabricate a default location.
   *
   * `label` is the friendly name when known ("Pleasantville, CO");
   * absent when the source is the env fallback.
   */
  home_coords(user_id: string):
    | { lat: number; lng: number; label: string | null; source: 'user_config' | 'env_fallback' }
    | null {
    const u = this.get(user_id);
    if (u?.home_location) {
      return {
        lat: u.home_location.lat,
        lng: u.home_location.lng,
        label: u.home_location.label ?? null,
        source: 'user_config',
      };
    }
    const lat_raw = process.env.HEARTH_HOME_LAT;
    const lng_raw = process.env.HEARTH_HOME_LON;
    if (lat_raw && lng_raw) {
      const lat = Number.parseFloat(lat_raw);
      const lng = Number.parseFloat(lng_raw);
      if (
        Number.isFinite(lat) && Number.isFinite(lng) &&
        lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180
      ) {
        return { lat, lng, label: null, source: 'env_fallback' };
      }
    }
    return null;
  }

  /**
   * Look up a user by email (case-insensitive). The email field is
   * lowercased on schema parse + on YAML write, so a normalize-and-
   * compare here is belt-and-suspenders. Returns null when no user
   * matches OR no users have an email yet (legacy state).
   */
  resolve_by_email(email: string): UserConfig | null {
    const needle = email.trim().toLowerCase();
    if (!needle) return null;
    return this.users.find((u) => u.email === needle) ?? null;
  }

  /**
   * Look up a user by their linked Apple subject id (Sign in with Apple).
   * Returns null when no account is linked to that `sub` — the caller
   * (POST /api/auth/apple) turns that into a hard 409, which is what
   * enforces "provision the account first; Apple can only AUTHENTICATE an
   * already-linked one, never create one."
   */
  resolve_by_apple_sub(sub: string): UserConfig | null {
    const needle = sub.trim();
    if (!needle) return null;
    return this.users.find((u) => u.apple_sub === needle) ?? null;
  }

  /**
   * Argon2id password verify against the stored hash, with a constant-
   * time dummy verify when the user doesn't exist or has no password —
   * mitigates the "does this email exist?" timing oracle. Bun.password
   * verifies in O(memoryCost) which dominates either branch.
   *
   * Returns { ok: true, user } on success; { ok: false } for ANY
   * failure (unknown user, no password set, wrong password). Callers
   * surface a single "invalid credentials" message regardless of which.
   */
  async verify_password(
    email: string,
    password: string,
  ): Promise<{ ok: true; user: UserConfig } | { ok: false }> {
    const user = this.resolve_by_email(email);
    // Dummy hash to verify against when the user doesn't exist or
    // has no password yet — keeps the response timing flat. Generated
    // once at first call; static across the process lifetime is fine
    // (it isn't a real credential).
    const dummy_hash = await _dummy_password_hash();
    const hash = user?.password_hash ?? dummy_hash;
    let ok = false;
    try {
      ok = await Bun.password.verify(password, hash);
    } catch {
      ok = false;
    }
    if (!ok || !user || !user.password_hash) return { ok: false };
    return { ok: true, user };
  }

  /**
   * Resolve the IANA timezone for a user. Falls back to America/Denver
   * for an unknown user (the household default). Every `src/core/time.ts`
   * helper accepts an optional `tz` argument — callers with a `user_id`
   * in scope thread `users.get_timezone(user_id)` into the helper so
   * vault paths, dated headers, and display strings render for the
   * device's wall-clock instead of the server's.
   */
  get_timezone(user_id: string | null | undefined): string {
    if (!user_id) return 'America/Denver';
    const u = this.get(user_id);
    return u?.timezone || 'America/Denver';
  }

  get_notification_config(user_id: string): NotificationConfig | null {
    const u = this.get(user_id);
    if (!u) return null;
    return this.notif_configs[u.notification_config_ref] ?? null;
  }

  /** Default to Kate when no preference is recorded for the user. */
  get_active_specialist(user_id: string): string {
    if (!this.db) return 'kate';
    const row = this.db
      .prepare(`SELECT value_json FROM kv_settings WHERE key = @k`)
      .get({ '@k': `active_specialist:${user_id}` }) as
      | { value_json: string }
      | undefined;
    if (!row) return 'kate';
    try {
      const parsed = JSON.parse(row.value_json) as { value?: string };
      return parsed.value ?? 'kate';
    } catch {
      return 'kate';
    }
  }

  set_active_specialist(user_id: string, specialist_id: string): void {
    if (!this.db) return;
    const ts = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO kv_settings (key, value_json, ts_updated)
         VALUES (@k, @v, @ts)
         ON CONFLICT(key) DO UPDATE SET value_json = @v, ts_updated = @ts`,
      )
      .run({
        '@k': `active_specialist:${user_id}`,
        '@v': JSON.stringify({ value: specialist_id }),
        '@ts': ts,
      });
  }

  is_specialist_allowed(user: UserConfig, specialist_id: string): boolean {
    if (user.allowed_specialists === '*') return true;
    return user.allowed_specialists.includes(specialist_id);
  }

  /**
   * Public list of user identities for the login screen. Strips
   * pin_hash and any private profile bits — only what the tile UI
   * needs to render. Anyone who can hit the login screen sees the
   * roster of users (same threat model as FRIDAY's tile picker).
   */
  list_for_login(): Array<{
    id: string;
    display_name: string;
    has_pin: boolean;
    theme: string | null;
    role: 'admin' | 'user' | 'guest';
  }> {
    return this.users.map((u) => ({
      id: u.id,
      display_name: u.display_name,
      has_pin: !!u.pin_hash,
      theme: u.theme,
      role: u.role,
    }));
  }

  /**
   * Admin-facing roster. Includes the tier + allowed_specialists fields
   * the admin panel needs to curate; strips pin_hash (callers see only
   * `has_pin: boolean`). Phase 2b — this is what /api/admin/users feeds.
   */
  list_for_admin(): Array<{
    id: string;
    display_name: string;
    email: string | null;
    has_pin: boolean;
    role: 'admin' | 'user' | 'guest';
    tier: Tier;
    allowed_specialists: '*' | string[];
    telegram_user_id: string | null;
  }> {
    return this.users.map((u) => ({
      id: u.id,
      display_name: u.display_name,
      email: u.email,
      has_pin: !!u.pin_hash,
      role: u.role,
      tier: u.tier,
      allowed_specialists: u.allowed_specialists,
      telegram_user_id: u.telegram_user_id,
    }));
  }

  /**
   * Admin write path — patch a user's allowed_specialists and/or
   * pin_hash and persist to users.yaml. Uses the YAML Document API so
   * existing comments and field order survive the round-trip
   * (matches the pattern in update_household_diet.ts).
   *
   * `pin_hash` patches:
   *   - `''` (empty string) clears the hash (`pin_hash: null` in YAML).
   *     This is the disable-PIN path — the user's tile won't render on
   *     the login screen until a fresh hash is provided.
   *   - 64-char lowercase hex sets it.
   *   - omitted leaves it alone.
   *
   * `allowed_specialists` patches:
   *   - `'*'` opens to every specialist.
   *   - Array of specialist ids restricts to that set.
   *   - omitted leaves it alone.
   *
   * On success, returns the updated UserConfig and reloads in-memory
   * state. Chokidar would re-fire on the write but our reload is idem-
   * potent. Throws if the user doesn't exist or the YAML lacks the
   * expected `users:` structure.
   */
  /**
   * Append a new user to users.yaml. Used by POST /api/admin/users +
   * the CLI's --create flag. Admin supplies id, display_name, email,
   * initial_password (which we hash here), plus optional tier /
   * allowed_specialists. Both bootstrap flags land true so the user's
   * first login routes through the change-password + set-pin flow.
   *
   * Defensive: refuses duplicate id, refuses duplicate email,
   * validates id shape (snake_case) and password length. Writes via
   * the YAML Document API so comments above the `users:` sequence
   * survive. Reloads in-memory state on success.
   */
  async create_user(input: {
    id: string;
    display_name: string;
    email: string;
    initial_password: string;
    tier?: Tier;
    allowed_specialists?: '*' | string[];
    telegram_user_id?: string | null;
    notification_config_ref?: string;
    timezone?: string;
    theme?: string | null;
    role?: 'admin' | 'user' | 'guest';
    require_pin?: boolean;
  }): Promise<UserConfig> {
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(input.id)) {
      throw new Error(
        'id must be lowercase snake_case starting with a letter (max 64 chars)',
      );
    }
    if (this.get(input.id)) {
      throw new Error(`user "${input.id}" already exists`);
    }
    const email = input.email.trim().toLowerCase();
    if (this.resolve_by_email(email)) {
      throw new Error(`email "${email}" already belongs to another user`);
    }
    if (!input.initial_password || input.initial_password.length < 10) {
      throw new Error('initial_password must be at least 10 characters');
    }

    const password_hash = await Bun.password.hash(input.initial_password, {
      algorithm: 'argon2id',
      memoryCost: 65536,
      timeCost: 3,
    });
    const now_iso = new Date().toISOString();

    if (!existsSync(this.users_path)) {
      throw new Error(`users.yaml not found at ${this.users_path}`);
    }
    const text = readFileSync(this.users_path, 'utf-8');
    const doc = parseDocument(text);
    const seq = doc.get('users');
    if (!isSeq(seq)) {
      throw new Error(`users.yaml has no top-level 'users:' sequence`);
    }
    // Append the new user record. Order of fields here mirrors how
    // existing entries are laid out, keeping diffs human-readable.
    const new_record: Record<string, unknown> = {
      id: input.id,
      display_name: input.display_name,
      email,
      telegram_user_id: input.telegram_user_id ?? null,
      telegram_chat_id: null,
      app_token: null,
      allowed_specialists: input.allowed_specialists ?? '*',
      timezone: input.timezone ?? 'America/Denver',
      notification_config_ref: input.notification_config_ref ?? 'default',
      pin_hash: null,
      password_hash,
      password_updated_at: now_iso,
      must_change_password: true,
      // Default require_pin=true so onboarding picks up the PIN setup
      // step; admin can pass false for a passwordless-only user.
      must_set_pin: input.require_pin !== false,
      theme: input.theme ?? null,
      role: input.role ?? 'user',
      tier: input.tier ?? 'household',
    };
    seq.add(new_record);
    writeFileSync(this.users_path, doc.toString(), 'utf-8');
    this.reload();
    const created = this.get(input.id);
    if (!created) throw new Error(`user ${input.id} vanished after reload`);
    return created;
  }

  update_user(
    user_id: string,
    patch: {
      allowed_specialists?: '*' | string[];
      pin_hash?: string;
      tier?: Tier;
      email?: string | null;
      password_hash?: string | null;
      must_change_password?: boolean;
      must_set_pin?: boolean;
      timezone?: string;
      /** Sign in with Apple link key. null clears the link (disconnect). */
      apple_sub?: string | null;
    },
  ): UserConfig {
    if (!existsSync(this.users_path)) {
      throw new Error(`users.yaml not found at ${this.users_path}`);
    }
    const text = readFileSync(this.users_path, 'utf-8');
    const doc = parseDocument(text);
    const seq = doc.get('users');
    if (!isSeq(seq)) {
      throw new Error(`users.yaml has no top-level 'users:' sequence`);
    }
    const node = _find_user_node(seq, user_id);
    if (!node) throw new Error(`unknown user: ${user_id}`);

    let changed = false;
    if (patch.pin_hash !== undefined) {
      // '' clears, otherwise must be 64-char hex (caller's responsibility
      // to provide a real SHA-256 of a real PIN; we don't generate one).
      if (patch.pin_hash === '') {
        node.set('pin_hash', null);
      } else {
        if (!/^[a-f0-9]{64}$/.test(patch.pin_hash)) {
          throw new Error('pin_hash must be 64-char lowercase hex SHA-256 (or empty string to clear)');
        }
        node.set('pin_hash', patch.pin_hash);
      }
      changed = true;
    }
    if (patch.allowed_specialists !== undefined) {
      node.set('allowed_specialists', patch.allowed_specialists);
      changed = true;
    }
    if (patch.tier !== undefined) {
      node.set('tier', patch.tier);
      changed = true;
    }
    if (patch.email !== undefined) {
      node.set('email', patch.email === null ? null : patch.email.toLowerCase());
      changed = true;
    }
    if (patch.password_hash !== undefined) {
      node.set('password_hash', patch.password_hash);
      // Stamp the rotation marker whenever the hash itself changes
      // (set OR clear), so future "force-rotate every N days" can
      // read it without a separate write path.
      node.set('password_updated_at', new Date().toISOString());
      changed = true;
    }
    if (patch.must_change_password !== undefined) {
      node.set('must_change_password', patch.must_change_password);
      changed = true;
    }
    if (patch.must_set_pin !== undefined) {
      node.set('must_set_pin', patch.must_set_pin);
      changed = true;
    }
    if (patch.apple_sub !== undefined) {
      node.set('apple_sub', patch.apple_sub);
      changed = true;
    }
    if (patch.timezone !== undefined) {
      if (!_is_valid_iana_timezone(patch.timezone)) {
        throw new Error(`timezone must be a valid IANA zone (got "${patch.timezone}")`);
      }
      node.set('timezone', patch.timezone);
      changed = true;
    }

    if (changed) {
      writeFileSync(this.users_path, doc.toString(), 'utf-8');
      // Re-parse + re-validate the whole file so the in-memory state
      // matches disk. Chokidar would do this too if the registry
      // watched the file; today reload() is manual but cheap.
      this.reload();
    }
    const updated = this.get(user_id);
    if (!updated) throw new Error(`user ${user_id} disappeared after reload`);
    return updated;
  }

  /**
   * PIN verification with per-user rate limiting. PINs have ~13 bits
   * of entropy (10^4); without throttling a script can guess every
   * possible PIN in under a second. Limiter caps to 5 attempts per
   * user per 15 minutes; after the 5th miss the user is locked out
   * until the window slides. State persisted in kv_settings so the
   * limit survives orchestrator restarts (so an attacker can't just
   * restart-loop the process to reset). Returns a structured
   * result the route translates into the right HTTP status.
   */
  verify_pin(
    user_id: string,
    pin_sha256: string,
  ): { ok: true; user: UserConfig } | { ok: false; reason: 'rate_limited' | 'invalid'; retry_after_seconds?: number } {
    const user = this.get(user_id);
    // Rate limit BEFORE looking up the user so probing for valid ids
    // doesn't get extra attempts that a real failed attempt would.
    const limit = this._check_pin_rate(user_id);
    if (!limit.ok) {
      return { ok: false, reason: 'rate_limited', retry_after_seconds: limit.retry_after_seconds };
    }
    if (!user || !user.pin_hash) {
      this._record_pin_failure(user_id);
      return { ok: false, reason: 'invalid' };
    }
    // Constant-time-ish compare — bytes equal length, char-by-char xor.
    if (!_constant_time_equal(pin_sha256.toLowerCase(), user.pin_hash.toLowerCase())) {
      this._record_pin_failure(user_id);
      return { ok: false, reason: 'invalid' };
    }
    // Success — clear the failure window.
    if (this.db) {
      this.db
        .prepare(`DELETE FROM kv_settings WHERE key = @k`)
        .run({ '@k': `pin_failures:${user_id}` });
    }
    return { ok: true, user };
  }

  /** Reads recent failure window from kv_settings; opaque to callers. */
  private _check_pin_rate(user_id: string): { ok: true } | { ok: false; retry_after_seconds: number } {
    if (!this.db) return { ok: true };
    const row = this.db
      .prepare(`SELECT value_json FROM kv_settings WHERE key = @k`)
      .get({ '@k': `pin_failures:${user_id}` }) as
      | { value_json: string }
      | undefined;
    if (!row) return { ok: true };
    let parsed: { failures: number[] } = { failures: [] };
    try { parsed = JSON.parse(row.value_json); } catch { return { ok: true }; }
    const WINDOW_MS = 15 * 60 * 1000;
    const MAX_FAILURES = 5;
    const cutoff = Date.now() - WINDOW_MS;
    const recent = (parsed.failures || []).filter((t) => t > cutoff);
    if (recent.length >= MAX_FAILURES) {
      const oldest = Math.min(...recent);
      const retry_after_ms = oldest + WINDOW_MS - Date.now();
      return { ok: false, retry_after_seconds: Math.max(1, Math.ceil(retry_after_ms / 1000)) };
    }
    return { ok: true };
  }

  private _record_pin_failure(user_id: string): void {
    if (!this.db) return;
    const row = this.db
      .prepare(`SELECT value_json FROM kv_settings WHERE key = @k`)
      .get({ '@k': `pin_failures:${user_id}` }) as
      | { value_json: string }
      | undefined;
    let parsed: { failures: number[] } = { failures: [] };
    if (row) {
      try { parsed = JSON.parse(row.value_json); } catch { /* reset */ }
    }
    const WINDOW_MS = 15 * 60 * 1000;
    const cutoff = Date.now() - WINDOW_MS;
    const recent = (parsed.failures || []).filter((t) => t > cutoff);
    recent.push(Date.now());
    const ts = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO kv_settings (key, value_json, ts_updated)
         VALUES (@k, @v, @ts)
         ON CONFLICT(key) DO UPDATE SET value_json = @v, ts_updated = @ts`,
      )
      .run({
        '@k': `pin_failures:${user_id}`,
        '@v': JSON.stringify({ failures: recent }),
        '@ts': ts,
      });
  }
}

/** Locate the YAMLMap for a given user id inside the `users:` sequence
 *  of users.yaml. Used by `update_user` for comment-preserving edits. */
function _find_user_node(seq: YAMLSeq, user_id: string): YAMLMap | null {
  for (const item of seq.items) {
    if (!isMap(item)) continue;
    const id = item.get('id');
    if (id === user_id) return item;
  }
  return null;
}

/** Mitigate timing-leak on PIN compare. Both inputs are hex strings of
 *  the same length under our schema, so we can xor char-by-char. */
function _constant_time_equal(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Cheap IANA-zone validation. `Intl.DateTimeFormat` throws RangeError
 * on an unknown zone — round-trip the candidate through the constructor.
 * Caches the answer because IDN-format strings can show up on every
 * authenticated request (X-User-Timezone header).
 */
const _tz_validity_cache = new Map<string, boolean>();
function _is_valid_iana_timezone(tz: string): boolean {
  if (typeof tz !== 'string' || tz.length === 0 || tz.length > 64) return false;
  const cached = _tz_validity_cache.get(tz);
  if (cached !== undefined) return cached;
  let ok = false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz }); // time-guard-ok: probe to validate an IANA tz string (throws on invalid)
    ok = true;
  } catch {
    ok = false;
  }
  _tz_validity_cache.set(tz, ok);
  return ok;
}
export { _is_valid_iana_timezone as is_valid_iana_timezone };

/**
 * Lazy-built argon2id hash of a static throwaway string. Used by
 * verify_password() when the requested user doesn't exist OR has no
 * password set, so the verify call still costs ~argon2id-time and
 * the response timing doesn't leak which case was hit. Generated
 * once per process; the value is not a real credential.
 */
let _cached_dummy_hash: string | null = null;
async function _dummy_password_hash(): Promise<string> {
  if (_cached_dummy_hash) return _cached_dummy_hash;
  _cached_dummy_hash = await Bun.password.hash(
    'hearth-dummy-credential-do-not-match',
    { algorithm: 'argon2id', memoryCost: 65536, timeCost: 3 },
  );
  return _cached_dummy_hash;
}

/** kv_settings helper for arbitrary serialized state. */
export class KvSettings {
  constructor(private db: Database) {}

  get<T = unknown>(key: string): T | null {
    const row = this.db
      .prepare(`SELECT value_json FROM kv_settings WHERE key = @k`)
      .get({ '@k': key }) as { value_json: string } | undefined;
    if (!row) return null;
    try {
      return JSON.parse(row.value_json) as T;
    } catch {
      return null;
    }
  }

  set(key: string, value: unknown): void {
    const ts = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO kv_settings (key, value_json, ts_updated)
         VALUES (@k, @v, @ts)
         ON CONFLICT(key) DO UPDATE SET value_json = @v, ts_updated = @ts`,
      )
      .run({ '@k': key, '@v': JSON.stringify(value), '@ts': ts });
  }

  delete(key: string): void {
    this.db.prepare(`DELETE FROM kv_settings WHERE key = @k`).run({ '@k': key });
  }
}
