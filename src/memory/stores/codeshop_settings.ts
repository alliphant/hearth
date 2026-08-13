/**
 * CodeShopSettings — owner-configurable settings for Beatrice's Code Shop.
 *
 * Holds the git/Gitea/GitHub credentials + repo config that make Beatrice's
 * merge actually work (they are UNSET in env today, so PR/merge throw until the
 * owner fills these in via the gear), the safety toggles, the merge defaults,
 * and the metric-estimate calibration. Owner-global (one row).
 *
 * SECRET-SAFE: this table is read ONLY by the git-config resolver, the pane
 * composer, and the owner-gated gear endpoints — NEVER by an LLM tool. Tokens
 * live here (SQLite, not in git, not in any LLM prompt or audit row). The GET
 * endpoint returns `get_redacted()` (tokens collapsed to a boolean), never the
 * values.
 *
 * The table is created in this store's constructor (CREATE TABLE IF NOT EXISTS),
 * not the central SCHEMA_SQL — self-contained, same pattern as the Kristi store.
 */
import { Database } from 'bun:sqlite';

/** Per-hour $/kWh (Pleasantville / Xcel CO time-of-use, summer vs winter). */
export interface TouRate {
  hour: number; // 0–23
  summer: number; // $/kWh
  winter: number; // $/kWh
}

export interface CodeShopConfig {
  // Repo + endpoints
  gitea_base_url: string;
  // Browser-facing Gitea base for PR display LINKS. gitea_base_url above is
  // container-reachable (host.docker.internal) for push/merge and does NOT
  // resolve in a browser; this is what the Code Shop renders as the PR link.
  gitea_web_base_url: string;
  gitea_owner: string;
  gitea_repo: string;
  base_branch: string;
  github_url: string;
  // Secrets (never returned by the GET endpoint)
  gitea_token: string;
  github_token: string;
  // Merge defaults
  github_required: boolean;
  merge_method: 'merge' | 'squash' | 'rebase';
  // Safety toggles
  paused: boolean;
  require_pin_code_merge: boolean;
  auto_pull_config_merges: boolean;
  // Metric-estimate calibration
  kwh_per_ktoken: number; // estimated kWh per 1,000 generated tokens
  tou_rates: TouRate[]; // 24 entries
}

/** Approximate Pleasantville / Xcel CO residential TOU schedule ($/kWh). The
 *  owner tunes these in the gear; they only drive the LABELED estimate. */
function default_tou_rates(): TouRate[] {
  const on_peak = (h: number) => h >= 15 && h < 19; // 3–7pm
  const mid_peak = (h: number) => (h >= 13 && h < 15) || (h >= 19 && h < 21);
  return Array.from({ length: 24 }, (_, hour) => {
    if (on_peak(hour)) return { hour, summer: 0.28, winter: 0.2 };
    if (mid_peak(hour)) return { hour, summer: 0.16, winter: 0.14 };
    return { hour, summer: 0.1, winter: 0.09 };
  });
}

export const CODESHOP_DEFAULTS: CodeShopConfig = {
  gitea_base_url: 'http://localhost:3010',
  gitea_web_base_url: 'http://your-llm-host.local:3010',
  gitea_owner: 'jasper',
  gitea_repo: 'hearth-private',
  base_branch: 'main',
  github_url: 'https://github.com/alliphant/hearth-private.git',
  gitea_token: '',
  github_token: '',
  github_required: false,
  merge_method: 'merge',
  paused: false,
  require_pin_code_merge: true,
  auto_pull_config_merges: false,
  kwh_per_ktoken: 0.001,
  tou_rates: default_tou_rates(),
};

const SECRET_KEYS: (keyof CodeShopConfig)[] = ['gitea_token', 'github_token'];

/** What the GET endpoint returns: every non-secret field, plus a boolean flag
 *  per secret indicating whether it is set — never the secret value. */
export type RedactedConfig = Omit<CodeShopConfig, 'gitea_token' | 'github_token'> & {
  gitea_token_set: boolean;
  github_token_set: boolean;
};

export class CodeShopSettings {
  constructor(private db: Database) {
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS codeshop_settings (
         id INTEGER PRIMARY KEY CHECK (id = 1),
         config_json TEXT NOT NULL,
         updated_at TEXT NOT NULL
       )`,
    );
  }

  /** Full config (stored values merged over defaults). Includes secrets — only
   *  callers that need them (resolver) should use this; endpoints use redacted. */
  get(): CodeShopConfig {
    const row = this.db
      .prepare(`SELECT config_json FROM codeshop_settings WHERE id = 1`)
      .get() as { config_json: string } | undefined;
    if (!row) return { ...CODESHOP_DEFAULTS };
    try {
      const stored = JSON.parse(row.config_json) as Partial<CodeShopConfig>;
      return { ...CODESHOP_DEFAULTS, ...stored };
    } catch {
      return { ...CODESHOP_DEFAULTS };
    }
  }

  get_redacted(): RedactedConfig {
    const c = this.get();
    const { gitea_token, github_token, ...rest } = c;
    return { ...rest, gitea_token_set: gitea_token.length > 0, github_token_set: github_token.length > 0 };
  }

  /** Merge a partial update over the current config. Omitted keys are left as-is;
   *  an empty-string token is treated as "leave unchanged" (clearing requires an
   *  explicit `clear_gitea_token`/`clear_github_token` flag, handled by the route).
   *  Returns the changed keys (secrets reported by name only). */
  set(patch: Partial<CodeShopConfig>): string[] {
    const current = this.get();
    const next: CodeShopConfig = { ...current };
    const changed: string[] = [];
    for (const [k, v] of Object.entries(patch) as [keyof CodeShopConfig, unknown][]) {
      if (v === undefined) continue;
      // Don't overwrite a stored secret with an empty string (the GET never
      // returns it, so a form re-submit shouldn't blank it).
      if (SECRET_KEYS.includes(k) && (v === '' || v === null)) continue;
      (next as unknown as Record<string, unknown>)[k] = v;
      changed.push(k);
    }
    this.db
      .prepare(
        `INSERT INTO codeshop_settings (id, config_json, updated_at)
           VALUES (1, @json, @now)
         ON CONFLICT(id) DO UPDATE SET config_json = @json, updated_at = @now`,
      )
      .run({ '@json': JSON.stringify(next), '@now': new Date().toISOString() });
    return changed;
  }

  /** Explicitly clear a secret (the form's "remove" affordance). */
  clear_secret(key: 'gitea_token' | 'github_token'): void {
    const next = { ...this.get(), [key]: '' };
    this.db
      .prepare(
        `INSERT INTO codeshop_settings (id, config_json, updated_at)
           VALUES (1, @json, @now)
         ON CONFLICT(id) DO UPDATE SET config_json = @json, updated_at = @now`,
      )
      .run({ '@json': JSON.stringify(next), '@now': new Date().toISOString() });
  }
}
