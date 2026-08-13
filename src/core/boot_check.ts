/**
 * Boot-crash check — the class tsc + the offline smokes can't see.
 *
 * `bun` runs TypeScript by stripping types, so a tsc error never crashes the
 * orchestrator at boot. The crashes that DO are runtime ones invisible to tsc:
 *   - a SQLite migration that references a column before its ALTER adds it
 *     (CREATE INDEX before ALTER → "no such column" at `open_db`);
 *   - a capabilities.yaml token that collides with a built-in, or is malformed
 *     (`load_extra_capabilities` throws);
 *   - a specialist YAML that's schema-invalid, duplicates an id, marks a second
 *     `default_landing`, or grants an undefined capability (the registry
 *     constructor throws — `granted_set` rejects unknown tokens);
 *   - a malformed llm-roles.yaml (parsed at router construction).
 *
 * `run_boot_check` exercises that exact boot sequence against a `:memory:` DB +
 * a config tree and reports a structured pass/fail. It MUTATES the process-global
 * extended-capability set (the registry's `granted_set` needs it populated to
 * recognize extended tokens), so it is **subprocess-only** — run via
 * `smoke:boot-check`, or spawned by Beatrice's `run_checks` in a worktree. Never
 * call it inside the live orchestrator process.
 *
 * Paths default to cwd-relative `config/...` (NOT the `HEARTH_*` env overrides),
 * so a worktree subprocess validates the worktree's config — the whole point of
 * the run_checks gate.
 */
import { existsSync, readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { open_db } from '@memory/stores/structured';
import { SpecialistRegistry } from '@core/specialist';
import { load_extra_capabilities } from '@core/capabilities';

export interface BootCheckResult {
  ok: boolean;
  checks: Array<{ name: string; ok: boolean; error?: string }>;
}

export interface BootCheckOpts {
  capabilities_path?: string;
  specialists_dir?: string;
  roles_path?: string;
}

export function run_boot_check(opts: BootCheckOpts = {}): BootCheckResult {
  const cap_path = opts.capabilities_path ?? 'config/capabilities.yaml';
  const spec_dir = opts.specialists_dir ?? 'config/specialists';
  const roles_path = opts.roles_path ?? 'config/llm-roles.yaml';

  const checks: BootCheckResult['checks'] = [];
  const record = (name: string, fn: () => void): boolean => {
    try {
      fn();
      checks.push({ name, ok: true });
      return true;
    } catch (err) {
      checks.push({ name, ok: false, error: err instanceof Error ? err.message : String(err) });
      return false;
    }
  };

  // 1. DB migrations — runs SCHEMA_SQL + every ALTER + CREATE INDEX against a
  //    throwaway in-memory DB. Catches the CREATE-INDEX-before-ALTER class.
  record('db migrations (open_db)', () => {
    open_db(':memory:').close();
  });

  // 2. Extended capability tokens — dup-with-builtin, malformed token, bad YAML.
  //    Populates the process-global set so the registry below sees them.
  const caps_ok = record('capabilities config (load_extra_capabilities)', () => {
    load_extra_capabilities(cap_path);
  });

  // 3. Specialist registry — schema-invalid config, duplicate id, a second
  //    default_landing, OR a grant of an undefined capability (granted_set
  //    throws in the constructor). Needs (2) to have populated the extended
  //    set, so skip on a caps failure rather than cascade a misleading error.
  if (caps_ok) {
    record('specialist registry (load + capability grants)', () => {
      new SpecialistRegistry(spec_dir).list();
    });
  } else {
    checks.push({
      name: 'specialist registry (load + capability grants)',
      ok: false,
      error: 'skipped — capabilities config failed to load',
    });
  }

  // 4. LLM roles file parses to a map (a malformed roles file crashes the
  //    ConfigLLMRouter constructor at boot).
  record('llm-roles config parses', () => {
    if (!existsSync(roles_path)) return;
    const parsed = parseYaml(readFileSync(roles_path, 'utf8')) as unknown;
    if (parsed != null && (typeof parsed !== 'object' || Array.isArray(parsed))) {
      throw new Error(`${roles_path}: expected a map (roles: {...})`);
    }
  });

  // 5. Every `deliberate_on_role` names a role that EXISTS (2026-08-05).
  //
  //    `deliberate_on_role` is schema-typed as a bare string and cast to
  //    LLMRole at the call site, so nothing checks it against llm-roles.yaml.
  //    `router.for_role()` throws on an unknown role — which means a typo does
  //    not silently demote the specialist, it kills that pass, every night,
  //    discoverable only by reading logs.
  //
  //    This matters most for exactly the case it was added for: kristi runs
  //    `specialist_deliberation_deep` (the 122B on forza, 65536/slot) because
  //    her workstation-market pass needs a window the 35B lane cannot give
  //    her. That is a deliberate placement, and a one-character slip in a YAML
  //    string should not be able to take it out. Boot is the right place to
  //    catch it — the whole point of this module is the class tsc and the
  //    offline smokes cannot see.
  if (caps_ok && existsSync(roles_path)) {
    record('deliberate_on_role names a real llm role', () => {
      const roles_doc = parseYaml(readFileSync(roles_path, 'utf8')) as Record<string, unknown>;
      const roles = (roles_doc?.roles ?? roles_doc ?? {}) as Record<string, unknown>;
      const bad: string[] = [];
      for (const s of new SpecialistRegistry(spec_dir).list()) {
        const named = s.proactive.deliberate_on_role;
        if (named && !(named in roles)) {
          bad.push(`${s.id} → "${named}"`);
        }
      }
      if (bad.length > 0) {
        throw new Error(
          `deliberate_on_role references a role not in ${roles_path}: ${bad.join(', ')}. ` +
            `Known roles: ${Object.keys(roles).sort().join(', ')}`,
        );
      }
    });
  }

  return { ok: checks.every((c) => c.ok), checks };
}
