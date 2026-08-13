/**
 * Seed Cordelia's "Specialist Craft" shelf — the reusable META-knowledge of
 * what makes ANY specialist excellent (domain-coverage completeness, source-tier
 * discipline, grounded-with-falsifier claims, the two-layer scan→extract→
 * synthesize + own-store shape, capability-envelope swimlanes, leak/pre-launch
 * signal, confirmed-vs-announced-vs-leaked labeling, demand-side persona/ICP/UCP
 * grounding). Re-runnable (overwrites the same notes by id).
 *
 *   docker compose exec hearth-orchestrator bun run scripts/seed-cordelia-craft.ts
 *
 * Writes `type: clipping` notes (specialist_scope: cordelia) under
 * $HEARTH_VAULT_ROOT/Knowledge/Cordelia/craft/. The ingestor's chokidar watcher
 * indexes them → Cordelia's search_library / read_note (her knowledge_scope
 * already covers Knowledge/Cordelia/**) find them. This shelf IS the thing
 * Cordelia is an expert in: she reasons FROM it when she audits or deepens a
 * peer's expertise (NEXT.md 15c part A; design at
 * docs/design-cordelia-specialist-excellence.md).
 *
 * The first worked example distilled here is the 2026-06-03 Kristi build (her
 * two-layer workstation-intel store, grounded projections, demand-side
 * persona/ICP/UCP) plus Anna's solar/HVAC corpus — the manual run of the loop
 * this shelf generalizes. These notes are PRESCRIPTIVE craft, not domain data:
 * they tell Cordelia how to recognize and close an expertise gap in any domain.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { homedir } from 'node:os';

const VAULT = process.env.HEARTH_VAULT_ROOT ?? resolve(homedir(), 'vault-friday');
const CAPTURED = '2026-06-03T00:00:00Z';
const PREAMBLE =
  '> **Specialist Craft — reusable meta-knowledge.** This is not domain data; ' +
  'it is the playbook for what separates an expert specialist from a brochure-' +
  "reader, in ANY domain. Cordelia reasons from this shelf when she audits or " +
  'deepens a peer. Worked examples cite the specialists we have already made ' +
  'excellent (Kristi, Anna); the craft generalizes past them.';

interface Note { path: string; id: string; title: string; tags: string[]; refs: string[]; body: string }

const notes: Note[] = [
  {
    path: 'Knowledge/Cordelia/craft/00-rubric-what-makes-a-specialist-expert.md',
    id: 'c_craftindex',
    title: 'The expertise rubric — what makes a specialist an expert',
    tags: ['craft', 'rubric', 'expertise', 'index'],
    refs: [
      'docs/design-cordelia-specialist-excellence.md',
      'config/specialists/kristi.yaml',
      'config/specialists/anna.yaml',
      'scripts/seed-kristi-knowledge.ts',
    ],
    body: `
${PREAMBLE}

This is the index note. The other Craft notes each go deep on one axis; this one
is the **scoring rubric** you carry into an expertise audit, and the **operating
model** an excellent specialist is built on.

## The nine axes of specialist excellence

Score a specialist against each. A gap on any one is what an \`expertise_gap\`
finding names; the fix is research → curate onto their shelf → (if the spec
itself is thin) a \`propose_action\` for the YAML delta.

1. **Domain-coverage completeness** — does the shelf + persona cover the WHOLE
   territory, including the counter-positioning lanes the obvious vendor/source
   wants ignored? (A workstation analyst who only talks NVIDIA is brochure-level
   on the most important axis.) → [[c_craftcover]]
2. **Source-tier discipline** — tier_1 (peer-reviewed / primary / registry /
   non-captured government) vs tier_2 (directional / professional-body /
   vendor), an explicit \`trusted_sources\` manifest, and a propose-on-unlisted
   gate so shelves don't rot. → [[c_craftsourc]]
3. **Grounded-with-falsifier claims** — every load-bearing claim traces to a
   source AND carries a falsifier (the observation that would prove it wrong).
   A claim you can't falsify is a vibe. → [[c_craftgrnd0]]
4. **Confirmed / announced / leaked labeling** — three different epistemic
   states, never collapsed; forward dates tagged as projections; vendor
   peak/marketing figures de-rated on sight. → [[c_craftgrnd0]]
5. **The two-layer architecture** — scan→extract→synthesize over sources into an
   OWN structured store (SQLite projection), with a validated write chokepoint,
   then grounded read projections on top. Not "search the web each turn." →
   [[c_crafttwol0]]
6. **Capability-envelope grouping (swimlanes)** — compare like-for-like by
   capability envelope, NOT by vendor name or marketing tier. → [[c_craftlanes]]
7. **Pre-launch / leak signal** — a real expert sees it coming: registries,
   cert matrices, driver release notes, filings show up BEFORE the announcement.
   → [[c_craftlanes]]
8. **Recurring-question flags** — the small set of questions that actually
   decide every answer in the domain, surfaced as standing flags the specialist
   asks first. → [[c_craftlanes]]
9. **Demand-side grounding (persona / ICP / UCP)** — who the thing is FOR,
   derived backwards from a real workflow's demand to the capability driver to
   the buyer; including who looks like a fit but should buy elsewhere. →
   [[c_craftdmnd0]]

## The operating model an excellent specialist runs on

Excellence is not "knows more facts." It is a SHAPE the specialist's tools +
persona + shelf enforce:

- **A structured store of its own**, not ad-hoc web reads. The store is the
  memory; the web is where you go to fill it. (Kristi's \`kristi_workstations\`
  store; Anna's seeded solar/HVAC corpus + the household's own system facts.)
- **A scan → extract → synthesize pipeline** that lands normalized rows through
  a validated chokepoint, so one mis-read figure can't poison every downstream
  comparison.
- **Grounded projections** computed from the store, each carrying its provenance
  and a falsifier — never a bare assertion.
- **A demand-side layer** (persona/ICP/UCP) so the specialist reasons about who
  the answer is for, not just what the answer is.

## How an audit reads (Beatrice judges, Cordelia curates)

The seam: **Beatrice's audit emits the \`expertise_gap\` finding** (which
specialist is below bar, on which axis); **Cordelia fills it** — researches the
advanced, non-obvious knowledge that closes the gap, curates it onto the
target's shelf via \`curate_for_specialist\`, and files a \`propose_action\` for
any spec-level delta (a new source tier, a new persona discipline, a new store
layer) that needs Jasper's sign-off because it edits the YAML. Cordelia stays the
authority on the craft and how to close the gap; she does not duplicate
Beatrice's audit machinery. Read a spec with \`read_specialist_spec\` to audit the
DEFINITION (persona / tools / trusted_sources / knowledge_scope), not just the
shelf.
`,
  },
  {
    path: 'Knowledge/Cordelia/craft/01-domain-coverage-completeness.md',
    id: 'c_craftcover',
    title: 'Domain-coverage completeness — map the whole territory, not the brochure',
    tags: ['craft', 'coverage', 'counter-positioning', 'completeness'],
    refs: [
      'config/specialists/kristi.yaml',
      'Knowledge/Kristi/reference/counter-positioning-silicon.md',
      'config/specialists/anna.yaml',
    ],
    body: `
${PREAMBLE}

The first thing that separates an expert from a brochure-reader is **coverage of
the whole domain** — especially the parts the most obvious source wants ignored.

## The counter-positioning blind spot (the highest-value gap to find)

Every domain has an incumbent whose marketing IS most of the freely available
material. A specialist trained on that material is fluent and WRONG on the most
important axis — the alternatives.

- **Worked example (Kristi).** Her first research draft was ~95% NVIDIA. For a
  *competitive*-intelligence analyst that is a blind spot, not a focus. The fix
  made AMD (Radeon PRO, Instinct MI300X/MI325X), Intel (Arc Pro / Battlematrix),
  and Apple (M3 Ultra / MLX) first-class counter-positioning lanes. The recurring
  question per lane — "does the workload's ISV stack actually PERMIT the
  non-incumbent path, or is it cert/CUDA-locked?" — is what the analysis turns
  on. See \`Knowledge/Kristi/reference/counter-positioning-silicon.md\`.
- **The general rule.** When you audit coverage, ask: *who is the incumbent, and
  is the shelf able to argue the alternatives on their own terms?* If the
  specialist can only describe the leader, the shelf is incomplete by definition.

## Map the sub-territories — and don't fuse distinct ones

A domain that looks like one thing is usually several distinct buyers/profiles
with different drivers. Fusing them is a coverage failure that reads as expertise.

- **Worked example (Kristi / AEC).** "AEC" is three distinct profiles, never to
  be fused: the BIM editor (single-thread CPU + RAM), the viz layer (GPU/RT/
  VRAM), and reality capture (parallel CPU + huge RAM + fast NVMe). One spec axis
  that "explains" all three is the tell that the model is wrong.
- **Worked example (Anna / utility territory).** Solar/HVAC advice is wrong if it
  fuses utility territories — FC Utilities vs Xcel vs PVREA have different rebate
  menus. "Confirm the utility first" is a sub-territory the shelf must keep
  distinct.

## Name the named players

Coverage includes the actual named entities, not just categories. Kristi names
Vizrt / Ross Video / Avigilon / Pelco / Hanwha by name; Anna names REC Alpha
Pure-R, Efficiency Works, the specific FC rebate program. A shelf that only has
categories ("broadcast graphics vendors", "solar incentives") can't answer a
real question. When you deepen a shelf, push it from categories toward named
entities with their distinguishing facts.

## Scope discipline — owned beat vs context

Completeness is NOT "cover everything." It is "cover the OWNED beat fully and
mark the rest as context." Kristi owns the silicon/compute-sizing angle of every
vertical; vendor business-strategy / market-share / TAM is *context, not owned* —
tracked only where it gates a hardware decision. An audit checks both halves: is
the owned beat fully covered, AND is the boundary to context drawn explicitly so
the specialist doesn't drift into a beat it can't ground?
`,
  },
  {
    path: 'Knowledge/Cordelia/craft/02-source-tier-discipline.md',
    id: 'c_craftsourc',
    title: 'Source-tier discipline — tier_1 vs tier_2, the manifest, and the propose gate',
    tags: ['craft', 'sources', 'trust-tier', 'provenance'],
    refs: [
      'src/core/specialist.ts',
      'src/connectors/curate_for_specialist.ts',
      'config/specialists/kristi.yaml',
    ],
    body: `
${PREAMBLE}

An expert is precise about *where a claim comes from*. The mechanism is an
explicit, tiered \`trusted_sources\` manifest on the specialist's YAML, and the
curation discipline that keeps it honest.

## The two tiers (and the implicit third)

- **tier_1 — auto-ingest.** Peer-reviewed, primary documents, registries, and
  non-captured government / top-tier professional bodies. The actual research
  apparatus, not the recommendation surface. Curation ingests these with
  \`trust_tier: 1\` stamped into frontmatter. (Note the deliberate move in the
  schema: PubMed/PMC stay tier_1, but recommendation surfaces like cdc.gov /
  health.gov drop to tier_2 — the index is primary, the advice is directional.)
- **tier_2 — ingest with attribution.** High-quality but with provenance
  disclosure: professional-body guidance, vendor docs, reputable trade press.
  Stamped \`trust_tier: 2\`; the specialist cites when leaning on it.
- **tier_3 (implicit) — the propose gate.** An unlisted high-quality candidate is
  NOT silently ingested. \`curate_for_specialist\` files a \`trusted_source_addition\`
  proposal (Tier 2 the safe default; reviewer can promote to Tier 1). This is how
  a manifest grows without rotting — Jasper ratifies new sources, the shelf never
  silently absorbs a blog. See \`resolve_trust_tier()\` in \`src/core/specialist.ts\`.

## Every load-bearing claim traces to a URL

Kristi's remit: "every claim traces to a URL." Each seeded note carries a Source
Radar / Sources block; vendor TOPS/peak/sparse figures are tagged for de-rating
right next to the source. When you audit source discipline, check that the shelf's
claims are *anchored*, not floating — a note full of confident numbers with no
source block is a rot risk regardless of whether the numbers are right today.

## Free-first access is part of the craft

Cost is not the reflexive answer. An expert librarian finds the free or
open-access route (DOAJ, PMC, arXiv/preprints, Unpaywall/OpenAlex, the author's
green-OA copy, libraries/ILL, public-domain & publicly-funded output) BEFORE ever
quoting a price, and says so plainly when there genuinely is no free copy. Reject
blogspam and AI-generated SEO chum outright — if the only source is junk, say so
and recommend deferring rather than poisoning a shelf.

## What "thin sources" looks like in an audit

A source-tier gap shows up as: an empty or near-empty \`trusted_sources\` manifest;
a manifest that's all one vendor (couples to the coverage blind spot —
[[c_craftcover]]); tier_1 entries that are actually recommendation surfaces or
marketing; or a shelf whose claims don't trace back to any listed domain. The fix
is a curate pass scoped to the right tier_1 domains, plus proposing the additions
the manifest is missing.
`,
  },
  {
    path: 'Knowledge/Cordelia/craft/03-grounded-claims-and-labeling.md',
    id: 'c_craftgrnd0',
    title: 'Grounded claims, falsifiers, and confirmed/announced/leaked labeling',
    tags: ['craft', 'falsifier', 'grounding', 'projection', 'de-rate'],
    refs: [
      'Knowledge/Kristi/reference/future-compute-roadmap.md',
      'Knowledge/Kristi/reference/demand-side-method.md',
      'src/specialists/kristi/tools/query_workstations.ts',
    ],
    body: `
${PREAMBLE}

A claim an expert makes is *grounded* (traces to evidence), *falsifiable*
(carries the observation that would disprove it), and *epistemically labeled*
(you know whether it is confirmed, announced, or leaked). Three disciplines.

## Grounded-with-falsifier

Every load-bearing claim should carry the thing that would prove it wrong. A
falsifier is what turns an assertion into analysis.

- **Worked example (Kristi).** Her projections each carry a \`falsifier\` field:
  "if ROCm/oneAPI cert coverage reaches parity on the top-5 pro apps, NVIDIA's
  software moat is breached." The persona-derivation method is the same shape:
  "a persona you can't tie to a workflow's compute demand is a GUESS — mark it
  low-confidence with a falsifier."
- **The general rule.** When you audit grounding, look for the falsifier. A shelf
  of confident claims with no falsifiers is brittle: nothing tells the specialist
  when reality has moved.

## Confirmed vs announced vs leaked — never collapse them

These are three different epistemic states. An expert keeps them distinct and
labels every forward-looking claim:

- **Confirmed** — settled fact with a primary citation. (DGX Spark's ~273 GB/s
  weight bandwidth is confirmed; the "900 GB/s" figure is NVLink-C2C internal —
  state the precise claim so an easy correction can't land.)
- **Announced** — the vendor said it; real but not yet shipping. Tag with the
  as-of date.
- **Leaked** — registry/cert/filing/rumor-tier. NEVER quote as fact. Kristi's
  roadmap note tags Diamond-Rapids-class items "LEAK-GRADE (do not quote as
  fact)" inline. Forward dates are tagged as projections, as-of the seed date.

## De-rate vendor peak figures on sight

Marketing numbers are peak / sparse / best-case. An expert de-rates them the way
mobile GPUs get de-rated to sustained-thermal reality. Kristi tags every vendor
TOPS/peak/sparse figure "de-rate-on-sight" right at the source. When you seed a
shelf, carry the de-rate reminder next to the number, not in a footnote.

## Time-series, not constants

Some "facts" are actually points on a curve — prices, supply, roadmap dates. Tag
them with an as-of date and treat them as a tracked series, never a constant.
(GDDR7 16 GB ~$65-80 mid-2025 → >$200 early-2026 is *directional, volatile* — a
leading indicator, not a fixed price.) A shelf that states a volatile quantity as
a bare constant will lie the moment the curve moves.

## The seeding split: directional framing vs verified spec

When you SEED a shelf from research, be explicit about which half it is. Kristi's
reference corpus is labeled "Directional research brief — framing, not verified
spec" with a standing instruction: *verify any specific number against the primary
sources before recording a spec/price row into the structured store.* Framing
helps the specialist reason about fit and bottlenecks; only verified specifics
earn a row in the store. Conflating the two is how a plausible-but-wrong figure
becomes load-bearing.
`,
  },
  {
    path: 'Knowledge/Cordelia/craft/04-two-layer-architecture.md',
    id: 'c_crafttwol0',
    title: 'The two-layer architecture — scan→extract→synthesize over an own store',
    tags: ['craft', 'architecture', 'store', 'pipeline', 'chokepoint'],
    refs: [
      'src/memory/stores/kristi_workstations.ts',
      'src/specialists/kristi/spec_metrics.ts',
      'src/specialists/kristi/tools/query_workstations.ts',
      'config/specialists/kristi.yaml',
    ],
    body: `
${PREAMBLE}

The deepest structural difference between an expert specialist and a
search-the-web-each-turn one is that the expert has **a structured store of its
own**, fed by a disciplined pipeline, read through grounded projections. This is
the shape Cordelia recommends when a specialist's whole knowledge is "whatever the
last web search returned."

## The two layers

1. **Acquisition / fidelity layer — scan → extract → synthesize.** Scan trusted
   sources, extract the load-bearing specifics verbatim, synthesize into
   normalized rows. The output is DATA, not prose. (Kristi: \`scan_sources\` →
   \`extract_layer\` / \`acquire_quickspecs\` → \`record_facts\` into the
   \`kristi_workstations\` store.)
2. **Reasoning / projection layer — grounded reads.** Tools that compute answers
   FROM the store, each carrying provenance and a falsifier: comparisons,
   histories, gap views, demand-side profiles. (Kristi: \`compare_configs\`,
   \`price_history\`, \`hp_z_gaps\`, \`swimlane_profiles\`.) The reasoning never
   re-derives from raw web text mid-answer; it reads the store the acquisition
   layer curated.

The split mirrors the Cordelia capture pipeline's own rule — *VL is the routing
layer; OCR is the fidelity layer*. Here: synthesis is the reasoning layer; the
store is the fidelity layer. Don't let the reasoning layer decide what to LOOK at
based on a fidelity-layer shortcut (that was the Dunkin'-cup misroute).

## The validated write chokepoint

Every write into the store passes ONE validated chokepoint, so a single mis-read
figure can't poison every downstream comparison. Kristi's \`validateSpec\` rejects
absurd comparable values (a "4 TB" mis-parsed to 4.2M GB, a CPU model number read
as a core count) at the \`record_facts\` boundary and surfaces them to Beatrice —
permissive on context fields, strict on the numeric specs that feed comparisons.
When you audit a store-backed specialist, check that writes are gated: an
ungated store rots silently and every projection inherits the rot.

## Grounded projections, not bare assertions

The read layer's output is grounded: each row says what it's computed from. A
projection is "clearly-labeled inference, not fact," with confidence + falsifier +
the lineage/roadmap sources it extrapolates from. This is what lets a specialist
say something forward-looking without fabricating.

## When to recommend this shape

Not every specialist needs a SQLite store — Anna's seeded markdown corpus +
search_library is right for a knowledge domain that's read, not computed-over.
Recommend the structured-store shape when the domain is **comparative and
quantitative** (specs, prices, certs, time-series) — where the value is
like-for-like comparison and trend, which prose can't hold. An audit gap here
reads as: a specialist answering quantitative/comparative questions from prose
notes or live web reads, with no store to ground or compare against.
`,
  },
  {
    path: 'Knowledge/Cordelia/craft/05-swimlanes-leak-signal-recurring-questions.md',
    id: 'c_craftlanes',
    title: 'Capability-envelope swimlanes, pre-launch signal, and recurring-question flags',
    tags: ['craft', 'swimlanes', 'leak-radar', 'recurring-questions', 'comparison'],
    refs: [
      'src/specialists/kristi/tools/cluster_swimlanes.ts',
      'Knowledge/Kristi/reference/isv-workflow-physics.md',
      'src/specialists/kristi/tools/scan_cert_registries.ts',
    ],
    body: `
${PREAMBLE}

Three linked disciplines that turn a pile of facts into expert comparison: group
by capability not naming, see the launch coming, and know the few questions that
decide every answer.

## Group by capability envelope, not by vendor or naming

A novice compares by brand and marketing tier ("the HP Z6 vs the Dell"). An
expert compares **like-for-like by capability envelope** — clustering on the axes
that actually determine fit (max GPU / memory / PSU-chassis / socket-CPU tier),
across vendors. Kristi's swimlanes are derived by \`cluster_swimlanes\` on
capability envelope, NOT vendor or naming — so an HP Z6 sits in one lane with the
Lenovo P7/P8 and the Dell 7875, and a comparison never pairs an expert-lane
prev-gen part against a mid-lane current-gen rival. When you audit comparison
quality, check the grouping axis: capability-envelope grouping is the tell of
expertise; brand/tier grouping is the tell of a brochure.

The same anti-fusion rule applies to the seats themselves: don't put a
local-AI appliance (Apple M3 Ultra, DGX Spark) in a "tower" lane just because it
sits on a desk — its capability envelope and ISV-cert story are different, so it
is a different lane. Definition discipline keeps lanes honest.

## Pre-launch / leak signal — see it coming

A real expert isn't surprised by launches; the signal is public before the
announcement. The craft is knowing WHERE it leaks in your domain:

- **Worked example (Kristi).** Cards appear in ISV cert matrices and pro-driver
  Production-Branch release notes BEFORE they're announced; certification
  registries (DMTF / ENERGY STAR / TCO) list model-strings pre-launch. Her
  \`scan_cert_registries\` + \`leak_radar\` surface "certified-but-not-yet-matched-
  to-a-known-SKU" sightings — pre-launch leaks worth researching.
- **The general rule.** Every domain has a leading indicator: filings, registries,
  cert matrices, release notes, preprints, permit records. An expert shelf has a
  standing scan of it. A specialist that only knows what's announced is always a
  step behind; finding that gap and wiring the leading-indicator scan is a real
  deepening.

## Recurring-question flags — the few questions that decide every answer

Most domains have a small set of questions whose answers determine everything
else. An expert surfaces them as standing flags and asks them FIRST.

- Kristi: "what's the gating resource by workload PHASE?" (never compare on raw
  core count across phases); "does the ISV stack permit the non-NVIDIA path?";
  "usable at what context / batch / engine?" (never bare param count).
- Anna: "which utility territory?" (decides the whole rebate menu) before quoting
  any incentive.

When you audit a specialist, look for these flags. If the persona launches into
answers without first asking the question that actually decides them, the
recurring-question layer is missing — and that's often the single highest-leverage
thing to add, because it corrects a whole class of answers at once.
`,
  },
  {
    path: 'Knowledge/Cordelia/craft/06-demand-side-persona-icp-ucp.md',
    id: 'c_craftdmnd0',
    title: 'Demand-side grounding — persona, ICP, and UCP derived from the workflow',
    tags: ['craft', 'persona', 'icp', 'ucp', 'demand-side'],
    refs: [
      'Knowledge/Kristi/reference/demand-side-method.md',
      'src/specialists/kristi/tools/derive_swimlane_profiles.ts',
      'config/specialists/kristi.yaml',
    ],
    body: `
${PREAMBLE}

Supply-side expertise (what the things ARE) is only half. The other half is
**demand-side**: who each thing is FOR, derived rigorously rather than guessed.
This is the axis most specialists are thinnest on, and the one the Kristi build
added last as a distinct capability (\`derive_swimlane_profiles\` →
persona / ICP / UCP).

## The grounding chain — derive every profile BACKWARDS

Never start from "who might buy this." Start from the workflow and walk forward:

> a real workflow's **compute demand** → the **capability driver** that makes
> THIS envelope the right one → the **buyer**.

Put the workflow in \`grounded_on\`, the spec in \`capability_drivers\`. A persona
you can't tie back to a workflow's actual demand is a guess — mark it
low-confidence with a falsifier. This is the same grounded-with-falsifier
discipline ([[c_craftgrnd0]]) applied to the demand side.

## The three profiles

- **Persona — the human seat.** The bottleneck implies the seat: clock-bound
  single-thread → a modeling/author seat; multi-core+RAM solver → an analyst
  seat; VRAM+inference-stack → an ML/AI-dev seat. The bottleneck is the entry
  point, not a closed list.
- **ICP — the ideal customer org.** Map the persona to the organization that has
  the workflow that justifies the envelope: segment, seat count, refresh cadence,
  which licenses/gates they hold. The org with the justifying workflow is the ICP.
- **UCP — the UN-ideal customer + the redirect.** The honest, vendor-won't-say-it
  call. Three shapes: the **over-buyer** (demand fits a lighter lane, reaching
  for a heavier one — redirect DOWN), the **under-buyer** (workload starves in
  too light a lane — redirect UP), and the **wrong-class** (a mobile/field
  workflow buying desktop; an inference workload that belongs in edge-AI, not a
  tower). **A UCP without a real redirect lane is a complaint, not analysis** —
  always name the lane they belong in.

## Why this is a first-class axis, not a nicety

A specialist that can describe the supply side perfectly but can't say who should
(and shouldn't) buy it gives answers that are technically right and practically
useless. The demand-side layer is what makes the specialist's output decision-
grade. When you audit it, check that profiles are *grounded* (tied to a workflow,
not asserted), that the UCP exists at all (most thin shelves only have the
flattering persona), and that every UCP names a redirect.
`,
  },
];

let written = 0;
for (const n of notes) {
  const abs = resolve(VAULT, n.path);
  mkdirSync(dirname(abs), { recursive: true });
  const fm =
    `---\n` +
    `type: clipping\n` +
    `id: ${n.id}\n` +
    `kind: text\n` +
    `source: file\n` +
    `title: ${JSON.stringify(n.title)}\n` +
    `captured_at: ${CAPTURED}\n` +
    `reviewed: true\n` +
    `specialist_scope: cordelia\n` +
    `tags: [${n.tags.join(', ')}]\n` +
    `---\n`;
  const refs = n.refs.length
    ? `\n\n## Worked examples & references\n${n.refs.map((r) => `- \`${r}\``).join('\n')}`
    : '';
  writeFileSync(abs, `${fm}\n# ${n.title}\n${n.body.trimEnd()}${refs}\n`, 'utf8');
  console.log(`  + ${n.path}`);
  written++;
}
console.log(
  `\nSeeded ${written} Specialist Craft notes (specialist_scope: cordelia) into ${VAULT}/Knowledge/Cordelia/craft/.`,
);
