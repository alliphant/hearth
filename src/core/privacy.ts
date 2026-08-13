/**
 * Privacy posture for spatial data. Loads config/privacy.yaml on first
 * access, hot-reloads via chokidar if the file changes.
 *
 * The config is a small allowlist plus three booleans. Location data is
 * the most privileged data in the system — adding a specialist to the
 * allowlist should be a deliberate edit, not a side effect of granting
 * the read_my_location capability.
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { watch } from 'chokidar';
import { parse as parse_yaml } from 'yaml';

const PRIVACY_PATH = resolve(
  process.env.HEARTH_PRIVACY_PATH ?? './config/privacy.yaml',
);

interface PrivacyConfig {
  location: {
    audit_redaction: boolean;
    journal_to_vault: boolean;
    snapshot_ttl_minutes: number;
  };
  browse: {
    audit_redaction: boolean;
  };
  cross_specialist_sharing: {
    read_my_location_granted_to: string[];
  };
}

const DEFAULTS: PrivacyConfig = {
  location: {
    audit_redaction: true,
    journal_to_vault: false,
    snapshot_ttl_minutes: 5,
  },
  browse: {
    audit_redaction: true,
  },
  cross_specialist_sharing: {
    read_my_location_granted_to: ['kate', 'iris', 'cassandra'],
  },
};

let _config: PrivacyConfig | null = null;
let _watcher_started = false;

function load_config(): PrivacyConfig {
  if (!existsSync(PRIVACY_PATH)) return DEFAULTS;
  try {
    const raw = readFileSync(PRIVACY_PATH, 'utf8');
    const parsed = parse_yaml(raw) as Partial<PrivacyConfig>;
    return {
      location: {
        audit_redaction:
          parsed.location?.audit_redaction ?? DEFAULTS.location.audit_redaction,
        journal_to_vault:
          parsed.location?.journal_to_vault ?? DEFAULTS.location.journal_to_vault,
        snapshot_ttl_minutes:
          parsed.location?.snapshot_ttl_minutes ?? DEFAULTS.location.snapshot_ttl_minutes,
      },
      browse: {
        audit_redaction:
          parsed.browse?.audit_redaction ?? DEFAULTS.browse.audit_redaction,
      },
      cross_specialist_sharing: {
        read_my_location_granted_to:
          parsed.cross_specialist_sharing?.read_my_location_granted_to ??
          DEFAULTS.cross_specialist_sharing.read_my_location_granted_to,
      },
    };
  } catch (err) {
    console.error('[privacy] failed to load config:', err);
    return DEFAULTS;
  }
}

function ensure_loaded(): PrivacyConfig {
  if (_config) return _config;
  _config = load_config();
  if (!_watcher_started) {
    try {
      const w = watch(PRIVACY_PATH, { ignoreInitial: true });
      w.on('change', () => {
        _config = load_config();
      });
      w.on('add', () => {
        _config = load_config();
      });
      _watcher_started = true;
    } catch (err) {
      void err;
    }
  }
  return _config;
}

export function audit_redaction_enabled(): boolean {
  return ensure_loaded().location.audit_redaction;
}

export function browse_audit_redaction_enabled(): boolean {
  return ensure_loaded().browse.audit_redaction;
}

export function journal_to_vault_enabled(): boolean {
  return ensure_loaded().location.journal_to_vault;
}

export function snapshot_ttl_ms(): number {
  return ensure_loaded().location.snapshot_ttl_minutes * 60 * 1000;
}

export function location_specialist_allowed(specialist_id: string): boolean {
  const list = ensure_loaded().cross_specialist_sharing.read_my_location_granted_to;
  return list.includes(specialist_id);
}

/** Test-only: force a config reload (useful when smokes mutate the file). */
export function reset_privacy_cache(): void {
  _config = null;
}
