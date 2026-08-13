/**
 * code_teeth — trust teeth for Beatrice's CODE merges (2026-07-05,
 * owner-decided after the evidence read: 7/7 of his historical merge taps
 * approved Kate-cleared changes — the tap was latency, not safety).
 *
 * The shape mirrors proposal trust-teeth exactly: a Kate-APPROVED (clean
 * approve, never approve_with_concerns), checks-green change whose files
 * all clear the PROTECTED-PATH FLOOR files its owner merge card WITHOUT
 * step-up and ARMS for auto-execution after an undo window
 * (`HEARTH_CODE_UNDO_MINUTES`, default 120). The push names the change and
 * the cancel affordance; the owner's deny in the queue cancels; the
 * trust_autoexec sweep executes survivors through the SAME decide() +
 * merge_approved_change path the owner tap uses. DARK behind
 * `HEARTH_CODE_TEETH`.
 *
 * THE FLOOR IS THE POINT — the human circuit breaker on a self-modifying
 * system. A change touching ANY protected path keeps owner + PIN forever:
 * the policy gateway, guards/runtime, capability grants, the audit chain +
 * cordon, auth, alert/safety drivers, the autonomy machinery, the merge
 * pipeline itself (Beatrice can never auto-merge changes to her own gates),
 * and the composition root. Widen via HEARTH_CODE_PROTECTED_EXTRA
 * (comma-separated prefixes); the built-in list only ever grows in code,
 * with review.
 */

export function code_teeth_enabled(): boolean {
  return process.env.HEARTH_CODE_TEETH === '1';
}

export function code_undo_minutes(): number {
  const n = Number(process.env.HEARTH_CODE_UNDO_MINUTES ?? 120);
  return Number.isFinite(n) && n >= 5 ? n : 120;
}

/** Path PREFIXES (repo-relative) that always keep owner + PIN. */
export const PROTECTED_CODE_PATHS: readonly string[] = [
  // Who's-in-control surfaces: policy gateway, approvals, push, auth.
  'src/policy/',
  'src/app/routes/auth',
  'src/app/auth_middleware',
  'src/app/routes/admin',
  // Capability + policy config: what anyone is ALLOWED to do.
  'src/core/capabilities.ts',
  'config/capabilities.yaml',
  'config/policies/',
  'config/users.yaml',
  'config/specialists/', // grants live in specialist YAMLs
  // The cordon + the tamper-evident ledger.
  'src/memory/private_to',
  'src/core/audit_chain',
  // The honesty guards + turn machinery.
  'src/core/specialist_runtime',
  'src/core/provenance',
  'src/core/fact_critic',
  'src/core/data_denial',
  // Autonomy machinery: the court, the teeth, the proposals chokepoint.
  'src/core/proposals.ts',
  'src/core/proposal_court',
  'src/core/trust_teeth',
  'src/memory/stores/trust_autoexec',
  // The merge pipeline + THIS floor (never self-editable into autonomy).
  'src/specialists/trainer/change_pipeline',
  'src/specialists/trainer/merge_recovery',
  'src/specialists/trainer/code_teeth',
  'src/specialists/kate/tools/review_change',
  // Safety alert drivers (the EAS-class paths).
  'src/core/dangerous_weather',
  'src/core/indoor_air_quality',
  'src/core/emergency',
  // Composition root + deps + ops (relay allowlists, deploy machinery).
  'apps/orchestrator/server.ts',
  'package.json',
  'ops/',
  'scripts/guard-',
  '.githooks/',
];

function extra_protected(): string[] {
  return (process.env.HEARTH_CODE_PROTECTED_EXTRA ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** True when ANY changed file touches a protected prefix. Fail-CLOSED:
 *  an empty/unknown file list is treated as protected — autonomy needs
 *  positive evidence of a clear floor. */
export function is_protected_code_change(files: readonly string[]): boolean {
  if (!files || files.length === 0) return true;
  const prefixes = [...PROTECTED_CODE_PATHS, ...extra_protected()];
  return files.some((f) => {
    const rel = f.replace(/^\.\//, '');
    return prefixes.some((p) => rel === p || rel.startsWith(p));
  });
}
