/**
 * Specialist capabilities — the security boundary between what a specialist
 * could in principle do and what they're actually permitted to do.
 *
 * Tools declare `required_capabilities`. Specialists declare a granted set
 * (from their YAML config). The runtime denies a tool invocation if the
 * calling specialist's granted set does not satisfy the tool's requirements.
 *
 * The capability is intrinsic to the tool's effect, not the route — adding
 * a capability to a specialist is a deliberate act. Reading a specialist's
 * config should answer "what can this specialist do to my life?"
 */

import { existsSync, readFileSync } from 'node:fs';
import chokidar, { type FSWatcher } from 'chokidar';
import { parse as parseYaml } from 'yaml';

export const CAPABILITIES = [
  // Reading (low-risk)
  'read_vault',
  'read_calendar',
  'read_weather',
  'read_home_assistant',
  'read_my_location',
  'read_audit_log',
  // Owner-oversight: review ANY non-owner user's activity (audit trail,
  // recent captures/uploads, conversation topics) via review_user_activity.
  // This is the ONE sanctioned path that crosses the per-user cordon — it
  // is owner-only (the tool also hard-checks `ctx.user.tier === 'owner'`)
  // and every review writes an `owner_oversight_review` audit row. Granted
  // to Kate so the owner can ask her "what has <user> been up to."
  'owner_oversight',
  'read_friday_system',
  'read_finance_signals',
  'query_web',
  // Drive a real warmed Firefox session on the workstation via the
  // browse_url tool — the escape hatch for sites that Firecrawl
  // (web_fetch_clean) can't get past (Cloudflare, PerimeterX, JS-only
  // event calendars). Browsing history is recorded host-only by
  // default; see config/privacy.yaml `browse.audit_redaction`.
  'browse_web',
  'query_maps',
  // FRIDAY/Helix app reads — read-only projection over friday-writer's
  // pets_data.json / yard tables / house_data.json / etc. Per-app caps
  // give Anya only pets, Eleanor only yard+house, etc. Kate gets the
  // cross-app grants. See src/connectors/friday/.
  'read_friday_pets',
  'read_friday_house',
  'read_friday_yard',
  'read_friday_energy',
  'read_friday_maintenance',
  // Read aggregated health/fitness data — for Astrid. Queries the
  // `sensor_packets` table for signal='health' (daily HealthKit
  // snapshots: steps, sleep, HR, calories, body composition synced
  // from Withings via Apple Health) and signal='workout' (per-session
  // Apple Watch workout streams). No raw sample bytes are exposed —
  // the get_health_summary tool returns windowed aggregates.
  'read_health',
  // Read the iOS-posted music snapshot (top artists, recently played,
  // library counts) for Maggie. Backs the read_music_context tool.
  // Replaces the deprecated `read_music_listening` capability that
  // gated the server-side MusicKit JWT path in src/connectors/listening.ts.
  'read_music_context',
  // UniFi controller (Network + Protect) read access — for Cassandra.
  // Lets her query the UDM directly: topology, event timeline,
  // admin posture, Protect health/events. All tools are read-only;
  // separate cap from read_home_assistant because it's a different
  // credential boundary and the controller has its own audit story.
  'read_unifi',

  // Writing internal (medium-risk)
  'write_vault_finance',
  'write_vault_animals',
  'write_vault_garden',
  'write_vault_homeauto',
  'write_vault_genealogy',
  'write_vault_general',
  'write_vault_trainer',
  'write_vault_librarian',
  // Astrid's vault writer — profile, observations, per-session
  // journals, coaching-log, memory. Per-user namespace at
  // users/<user_id>/astrid/** plus her own Knowledge/Astrid/memory.md.
  'write_vault_astrid',
  // Maggie's structured backing for the Listening pane's Coming-to-
  // town section. The check_show_status tool upserts upcoming_shows
  // rows + writes ticket-status fields. Granted to Maggie only.
  // Distinct from write_vault_media (markdown vault writes for taste
  // log / watchlist) because the storage shape and read surface (the
  // pane composer) are different — narrowing the cap keeps the
  // structured store from being a backdoor for vault-shaped writes.
  'track_upcoming_shows',
  // Beatrice's code-execution surface. read_codebase = inspect repo
  // files before proposing. write_codebase_pr = open a draft PR
  // implementing approved proposals. Only Beatrice has these; the
  // review gate is the PR itself, NOT this capability.
  'read_codebase',
  'write_codebase_pr',
  // merge_codebase_pr = MERGE a change to main. Trainer-only, distinct from
  // write_codebase_pr (opening a PR ≠ merging one). The tool that requires it
  // (merge_approved_change) is dispatch_only — never on the LLM surface — so a
  // merge happens ONLY via an owner-approved proposal dispatch. The non-
  // bypassable gate is Kate's review + the owner approval, not this token.
  'merge_codebase_pr',
  // review_beatrice_change = Kate's skeptic review of a Beatrice change
  // (list_changes_for_review / review_change). Kate-only; her approval is the
  // required pre-gate before a change can reach the owner's merge approval.
  'review_beatrice_change',
  // Cross-shelf write — Cordelia (Master Librarian) and only her,
  // by current household design. Lets her ingest authoritative
  // sources into any specialist's Knowledge/<Id>/library/ shelf
  // when consulted ("find me the Ioniq 5 owner's manual for 2024"
  // → fetch + ingest into Knowledge/Iris/library/). The
  // ingest_to_library tool is the only thing that requires this.
  'write_vault_any_library',
  'write_places',
  'write_proposals',
  'write_caldav',
  'citation_tracker',

  // Acting externally (high-risk; gated by approval gateway)
  'send_email',
  'send_sms',
  'write_home_assistant',
  'web_action',
  'spend_money',
] as const;

/**
 * A capability token. The built-in set is enumerated for editor
 * autocomplete and compile-time hints on first-party tools; `(string &
 * {})` keeps the type open so a tool loaded from a merged PR can declare
 * a capability that lives only in config/capabilities.yaml. Runtime
 * validity is the union of both — see is_capability().
 */
export type Capability = (typeof CAPABILITIES)[number] | (string & {});

const CAP_SET: ReadonlySet<string> = new Set(CAPABILITIES);

/**
 * Capability tokens added after the built-in CAPABILITIES list was
 * frozen — loaded from config/capabilities.yaml at boot and hot-reloaded
 * on change. This is what lets a tool shipped in a merged PR introduce a
 * new capability with no enum edit, recompile, or restart. Maps the
 * token to a human description so a specialist's powers stay readable.
 */
const _extra_caps = new Map<string, string>();

/** Capability tokens are lowercase snake_case, like the built-ins. */
const CAP_TOKEN_RE = /^[a-z][a-z0-9_]*$/;

export function is_capability(token: string): token is Capability {
  return CAP_SET.has(token) || _extra_caps.has(token);
}

/**
 * Returns the first capability from `required` that is NOT in `granted`,
 * or null if every required capability is granted.
 */
export function missing_capability(
  required: readonly Capability[],
  granted: ReadonlySet<Capability>,
): Capability | null {
  for (const cap of required) {
    if (!granted.has(cap)) return cap;
  }
  return null;
}

/**
 * Convenience: build a granted-set from an array (e.g. as parsed from YAML).
 * Unknown tokens are rejected so config typos fail loudly at boot.
 */
export function granted_set(tokens: readonly string[]): Set<Capability> {
  const out = new Set<Capability>();
  for (const t of tokens) {
    if (!is_capability(t)) {
      throw new Error(`unknown capability token: "${t}"`);
    }
    out.add(t);
  }
  return out;
}

/** Every valid capability token — built-in plus config-extended. */
export function all_capabilities(): string[] {
  return [...CAPABILITIES, ..._extra_caps.keys()];
}

/**
 * Load (or reload) config-extended capability tokens from a YAML file
 * mapping `token: description`. A missing file is fine — it just means
 * no extensions. Malformed tokens and collisions with built-ins are
 * rejected loudly; catching config typos is still the point.
 */
/**
 * Validate config/capabilities.yaml WITHOUT mutating the process-global
 * `_extra_caps` — the non-mutating sibling of `load_extra_capabilities`,
 * used by the boot-check so it can validate a (worktree's) config in-process
 * without clobbering the live orchestrator's capability set. Returns the
 * parsed `[token, description]` entries on success, or a structured error
 * with the same messages `load_extra_capabilities` would have thrown.
 */
export function validate_extra_capabilities(
  path: string,
): { ok: true; entries: Array<[string, string]> } | { ok: false; error: string } {
  if (!existsSync(path)) return { ok: true, entries: [] };
  let raw: unknown;
  try {
    raw = parseYaml(readFileSync(path, 'utf8'));
  } catch (err) {
    return {
      ok: false,
      error: `capabilities config ${path}: invalid YAML — ${(err as Error).message}`,
    };
  }
  if (raw == null) return { ok: true, entries: [] };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: `capabilities config ${path}: expected a map of token: description` };
  }
  const entries: Array<[string, string]> = [];
  for (const [token, desc] of Object.entries(raw as Record<string, unknown>)) {
    if (!CAP_TOKEN_RE.test(token)) {
      return {
        ok: false,
        error: `capabilities config ${path}: invalid token "${token}" — want lowercase snake_case`,
      };
    }
    if (CAP_SET.has(token)) {
      return {
        ok: false,
        error: `capabilities config ${path}: "${token}" is already a built-in capability`,
      };
    }
    entries.push([token, typeof desc === 'string' ? desc : '']);
  }
  return { ok: true, entries };
}

export function load_extra_capabilities(path: string): void {
  const result = validate_extra_capabilities(path);
  if (!result.ok) throw new Error(result.error);
  _extra_caps.clear();
  for (const [token, desc] of result.entries) _extra_caps.set(token, desc);
  console.log(
    `[capabilities] ${_extra_caps.size} config-extended capability token(s)` +
      (_extra_caps.size > 0 ? `: ${[..._extra_caps.keys()].join(', ')}` : ''),
  );
}

/**
 * Watch the capabilities config; on change, reload the extended tokens
 * and invoke `on_reload` — the orchestrator re-validates specialist
 * configs so a YAML that grants a freshly-added capability stops
 * failing. A bad edit keeps the previous set.
 */
export function watch_extra_capabilities(
  path: string,
  on_reload: () => void,
): FSWatcher {
  const watcher = chokidar.watch(path, {
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 50 },
  });
  const handler = (): void => {
    try {
      load_extra_capabilities(path);
      on_reload();
    } catch (err) {
      console.error(
        `[capabilities] reload failed (keeping previous set): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  };
  watcher.on('add', handler);
  watcher.on('change', handler);
  watcher.on('unlink', handler);
  return watcher;
}
