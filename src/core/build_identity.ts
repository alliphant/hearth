/**
 * Who RUNS a build vs. what the build ledger is FILED under.
 *
 * The 2026-07-21 Beatrice consolidation dissolved Beatrice's user-facing role
 * into Kate: a Kate turn is now the build intake. But Beatrice's id ('trainer')
 * stays alive as a DATA ANCHOR — deleting or re-stamping it breaks the merge
 * authority, the Code Shop office, and the change ledger.
 *
 * Keeping these two ids as named constants (instead of three hardcoded
 * 'trainer' string literals across the fire sites) makes the retarget
 * reviewable, reversible, and forces the actor-vs-anchor distinction to be
 * explicit in code rather than tribal knowledge.
 */

/**
 * The specialist whose deliberation pass ACTUALLY RUNS a directed build.
 * Consumed by the three fire sites in apps/orchestrator/server.ts.
 *
 * NOTE: directed builds are chained on `${id}:build` (src/core/loops.ts) so a
 * long build never starves this specialist's scheduled passes.
 */
export const BUILD_AGENT_ID = 'kate';

/**
 * The id the build LEDGER is filed under — deliberately NOT moved.
 *
 * Load-bearing, do not "clean up":
 *  - `review_change.ts` stamps the merge card with this id, and
 *    `execute_approved_proposal` dispatches `merge_approved_change` using THAT
 *    specialist's grants. Only 'trainer' holds `merge_codebase_pr`, so
 *    re-stamping the card to Kate turns every owner merge tap into a
 *    forbidden-capability denial.
 *  - `beatrice_changes` (bchg_*), `audit_log agent='trainer'`, the Code Shop
 *    office (pane_kind: codeshop), codeshop_settings, and the `beatrice/*`
 *    branch convention all key on it.
 *  - `config/specialists/trainer.yaml` must stay a loadable registry entry:
 *    `fire_deliberation_now` NO-OPs on an unknown id, and the merge dispatch
 *    500s with "specialist trainer not loaded".
 */
export const BUILD_LEDGER_ID = 'trainer';
