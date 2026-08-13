# Design — the self-governing synthesis-health loop

Status: **foundation built** (2026-06-14, the deterministic score); office + scan
+ quorum proposed. Owner: Cordelia (content) · Mariah (program) · Beatrice
(mechanism) · Kate (quorum). Builds on the consolidation cycle
([design-cordelia-consolidation-cycle.md](design-cordelia-consolidation-cycle.md)).

## The problem

Two questions, one feature: **can we peer into the second brain, and does it get
scored on health + worthiness — managed automatically by the meta-agents, with
Kate as a quorum tiebreak?** The live first run proved both halves are needed:
peering in by hand (ssh + sqlite) is what caught the `_quarantine/` selection
bug, and 2 of 12 syntheses had the distiller reach past its sources. A household
brain that accretes syntheses needs to *see* itself and *shed rot* on its own.

The good news, and the design's spine: this is **not a new subsystem.** It wires
the synthesis layer into the closed-loop machinery Hearth already runs — the
`process_miss` ledger, the proposal / autonomy-graduation flow, Beatrice's change
pipeline, and Kate's existing review seat.

## The score — the spine ([synthesis_health.ts](../src/core/synthesis_health.ts))

Everything ranks/detects/gates on one deterministic score. Two axes, scored
separately because they drive different actions:

- **HEALTH = is it sound, or rotting?** grounding verdict (clean > corrected >
  reduced) · source breadth · source trust tiers · freshness/staleness ·
  integrity (do its cited sources still exist). Low health → a **re-synthesize /
  drop** candidate.
- **WORTH = is it valued, or dead weight?** retrieval usage — is anyone
  retrieving + citing it. Low worth → a **prune** candidate. Until the usage
  instrument lands (Phase B) `retrieval_hits` is undefined and worth is **neutral
  (0.5)** — we never penalize a note for usage we can't yet measure.

Deterministic + pure (no LLM, no clock — the caller passes `age_days`), so a
re-scan verifies rather than drifts. An LLM "worthiness judge" was rejected:
expensive, non-reproducible. The dangerous quadrant is **high-worth + low-health**
(a popular but decaying note); health is weighted above worth (0.7) so a
heavily-used rotting synthesis can't score itself clean. Grades: `strong` /
`sound` / `weak` / `rotting` (an integrity collapse forces `rotting` regardless).

**Built now:** the scorer + write-time stamping — every synthesis carries
`health_score`, `health_grade`, and `health_reasons` in its frontmatter, so the
brain is already self-scoring and peer-in-able via search / the note itself.

## The loop — measure → detect → act → arbitrate → verify

| Step | Owner | Rides | What |
|---|---|---|---|
| **Measure** | Cordelia | the scorer (built) | score each synthesis at write; Mariah re-scores existing notes with real age + source-existence at scan time |
| **Detect** | Mariah | `process_misses` (new `scan_synthesis_health`) | mine scores + `synthesis_grounding` rows + usage into misses: a shelf perpetually reducing, dead-weight never-retrieved notes, rotting (deleted-source) notes, the gate over/under-firing, demand-coverage gaps |
| **Act — content** | Cordelia | her `write_vault_any_library` authority | re-synthesize a rotting note (idempotent + gate-protected); flag a thin topic into her demand ledger; archive-with-grace a prune |
| **Act — mechanism** | Beatrice | her change pipeline (PR → Kate review → owner merge) | tune the cluster threshold / gate strictness / `min_items` / add a health signal |
| **Arbitrate** | Kate | the proposal + review flow | the quorum tiebreak on contested/destructive actions; surface the loop in the morning brief |
| **Verify** | Mariah | `verify_fix_landed` | re-run the scan; auto-close the miss when the signal recovers |

## The quorum (Kate as tiebreak)

Most actions are deterministic and inside one agent's safe envelope → they just
happen. The quorum fires **only** for the **contested** (signals conflict) or
**destructive** (prune) subset, and rides the proposal+review flow rather than a
bespoke voting engine: the surfacing agent files the action carrying each
meta-agent's assessment (Cordelia: worth keeping? Mariah: systemic or one-off?
Beatrice: really a mechanism bug?). Converge → it executes. Diverge → **Kate
casts the deciding vote** (final below a discretion ceiling; owner above it —
mass-prune, anything irreversible, a new capability). Kate already arbitrates
Beatrice's changes; this is the same below-owner judgment seat.

## The autonomy envelope — **bounded-auto** (owner's call, 2026-06-14)

```
AUTO (no human):           score · flag · re-synthesize · archive-with-grace
KATE QUORUM (disagree OR   hard-prune · conflicting health-vs-worth signals
  destructive):
OWNER (ceiling):           mass-prune · irreversible · new capability
BEATRICE → KATE → OWNER:   threshold / gate / heuristic changes
```

**Reversibility makes this safe:** a "prune" is **archive-with-grace** — the note
moves to `_synthesis/_archive/` with a recovery window (mirroring the library's
existing `_archive/` + 30-day purge), so even an automated prune is recoverable;
only the *hard purge* after the window is a harder gate. This is the answer to the
system's standing "well-meaning automation overstepping" threat model.

## Load-bearing constraints

- **Cordon.** The office is owner-gated AND cordon-filtered — even the owner sees
  only owner/household/their-own syntheses, never another user's private ones.
  System-health stats (counts, %clean) can be aggregate without exposing private
  content. Re-scoring/pruning a `private_to: <user>` synthesis acts on metadata,
  never surfaces content cross-cordon.
- **Determinism.** The score and the scan stay LLM-free and reproducible (the
  demand-ledger philosophy) so a re-scan verifies. The only LLM in the loop is the
  re-synthesis itself (which the grounding gate already guards).
- **Fail-open.** Every step degrades safely — a scan outage opens no miss, a
  re-synthesis outage leaves the old note, the score is best-effort metadata.

## Phasing

- **Phase A — Measure + peer-in.** ✅ the deterministic scorer + write-time
  stamping (built 2026-06-14). ▶ next: the Cordelia **synthesis-office pane**
  (`pane_kind: synthesis`, owner-gated + cordon-filtered, ranks by the score,
  tappable synthesis→sources) — deferred while `specialist_pane.ts` is
  cross-session contended.
- **Phase B — Detect + drive.** Mariah `scan_synthesis_health` → `process_misses`;
  the retrieval-usage instrument (the one genuinely-new piece — attribute
  retrieval hits to synthesis vs raw notes, feeding `worth`); Cordelia auto-handles
  the safe actions (re-synthesize, archive-with-grace).
- **Phase C — Govern.** The quorum for destructive/contested actions; Kate
  arbitration + owner ceiling; Beatrice mechanism-tuning via her pipeline. The
  full self-management.

## Open decisions

1. **Worth before usage exists** — until Phase B's instrument, `worth` is neutral,
   so the score is health-led. Confirm pruning never fires on `worth` alone before
   the usage signal is real (else a brand-new unread synthesis looks prune-worthy).
2. **Re-score cadence** — Mariah re-scores on her scan tick; how often? (decay is
   slow — weekly is likely enough.)
3. **Quorum surface** — reuse a proposal `kind` + Kate `review`, or a dedicated
   council artifact? (Lean reuse — the proposal flow already carries assessments +
   Kate resolution.)
