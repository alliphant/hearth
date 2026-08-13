/**
 * The media-archive cordon — the ONE definition of who an archived item belongs
 * to. Both the write path (the runner's filing phase) and the repair path
 * (`rescan_media_metadata` facet:'nsfw') read it from here; two copies of a
 * privacy rule is how a remediation sweep ends up enforcing the policy it was
 * written to retire.
 *
 * OWNER DIRECTIVE 2026-07-29 — *"Archive content should be specific to user that
 * has requested it be downloaded."* Every archived item silos to its requester,
 * SFW or not, whatever their tier. **Nothing archived is household-scoped any
 * more.**
 *
 * This replaced a tier-aware ternary whose SFW branch returned `'household'`.
 * That default was load-bearing in the wrong direction: it put the NSFW
 * classifier on the critical path of an *exposure*, so one fabricated `sfw`
 * verdict was enough to put explicit content in front of every household member
 * — which is exactly what happened to `mi_arxnmccn` on 2026-07-15. Siloing by
 * requester takes the classifier out of that blast radius: a wrong verdict now
 * costs a mis-shelved folder, not an exposure.
 *
 * The NSFW verdict still drives two other things, and this module is not one of
 * them: the storage folder (`Private/…` for anything not confirmed SFW, see
 * `apply_nsfw_cordon` in media_category.ts) and the `nsfw` flag projected onto
 * the `media_items` row, which the clients use as a per-session PAINT gate — don't
 * show explicit content until whoever is looking re-authenticates. That gate makes
 * no tier distinction and decides nobody's eligibility; this module does that, and
 * only this module.
 *
 * Scope values are `private_to` values — see `note_visible_to_caller` in
 * memory/private_to.ts for what each one admits.
 */

/**
 * Scope for an item whose requester we don't know: a runner slice fired by the
 * scheduler or a deliberation pass carries no user id. `'owner'` is owner-tier
 * only, which is the fail-closed reading of "we can't say whose this is".
 */
export const MEDIA_CORDON_FALLBACK = 'owner';

/** The one scope the retired policy handed out that is broader than a single user. */
const HOUSEHOLD_SCOPE = 'household';

/** The cordon an archived item gets: its requester, or the fail-closed fallback. */
export function media_cordon_for(requested_by: string | null | undefined): string {
  const id = (requested_by ?? '').trim();
  return id.length > 0 ? id : MEDIA_CORDON_FALLBACK;
}

/**
 * The cordon a REPAIR pass may write — tighten-only.
 *
 * A rescan exists to fix rows filed under the retired policy (or from a verdict
 * the classifier never actually produced), so it may only ever make an item more
 * private. Broadening one is an owner-intent decision this pass has no mandate
 * for, and the owner may have re-stamped `private_to` by hand since archiving,
 * which a background sweep must not silently undo.
 *
 * Since the write path never assigns `'household'` any more, "tighten-only"
 * reduces to: re-file a household-scoped item onto its requester, and leave
 * every already-narrow scope exactly as it is.
 *
 *  - `'household'` → the requester (the repair: owner + every household member
 *    → one user).
 *  - unset → `MEDIA_CORDON_FALLBACK`. Semantics-preserving, not a change of
 *    audience: an unset `private_to` already resolves owner-tier-only
 *    (fail-closed, private_to.ts) — this just says so out loud.
 *  - any other value (a user id, `'owner'`) → unchanged. A different user id is
 *    not *broader*, it is a different owner, and re-assigning one is not a
 *    repair.
 */
export function tighten_media_cordon(
  current: string | null | undefined,
  requested_by: string | null | undefined,
): string {
  const now = (current ?? '').trim();
  if (now === HOUSEHOLD_SCOPE) return media_cordon_for(requested_by);
  if (now.length === 0) return MEDIA_CORDON_FALLBACK;
  return now;
}

/**
 * True for a row still shelved under the retired household default — i.e. off
 * the 2026-07-29 policy and in need of re-filing, whether or not its NSFW
 * verdict was ever honest. This is what makes the sweep a repair tool for the
 * cordon change and not only for the fail-open verdict.
 */
export function is_off_policy_media_cordon(current: string | null | undefined): boolean {
  return (current ?? '').trim() === HOUSEHOLD_SCOPE;
}
