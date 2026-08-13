/**
 * Self-contained test for grounding precedence (src/core/grounding_precedence.ts)
 * — Person-record grounding integrity #2.
 *
 * No LLM, no DB. Drives the pure precedence engine + the runtime bridge
 * directly, and proves the result against the REAL grounding check
 * (src/core/provenance.ts) the fact critic uses.
 *
 * The load-bearing case is the 2026-06-03 address-fabrication loop: Ruby seeded
 * a `reviewed:false` clipping with "2450 Parkfield Drive" (the the clinic vet-lab's
 * letterhead, mistaken for Jasper's home). That clipping then OUTRANKED both
 * Jasper's correction ("3215 Westwood Ct") and his master
 * People/Jasper-Doe.md record in grounding checks, so the CORRECT address
 * read as a "fabrication" for two days. This test reproduces that evidence and
 * asserts the clipping address can't win: it is scrubbed from the grounding
 * evidence, the master/user address survives, and — via the actual provenance
 * grounding check — the correct address now grounds while the wrong one no
 * longer does.
 *
 *   bun run smoke:grounding-precedence
 */

import {
  apply_grounding_precedence,
  gather_person_precedence,
  canonical_address,
  has_address,
  stringify_address,
  AUTHORITY_RANK,
  PRECEDENCE_SCRUB_MARKER,
  type EvidenceSource,
  type PersonRosterEntry,
  type ClippingMeta,
} from '@core/grounding_precedence';
import { build_grounding_context, is_grounded } from '@core/provenance';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`assert: ${message}`);
}

let checks = 0;
function ok(label: string): void {
  checks++;
  console.log(`  ✓ ${label}`);
}

const RIGHT = '3215 Westwood Ct';
const WRONG = '2450 Parkfield Drive';

/** Does an address-shaped claim resolve against this evidence? (the fact-check) */
function grounds(addr: string, evidence: string[]): boolean {
  const ctx = build_grounding_context({ verified: evidence });
  return is_grounded({ kind: 'named_entity' as const, text: addr, token: addr, index: 0 }, ctx);
}

function main(): void {
  // ── 1. Address canonicalization: agree across abbreviations, differ across
  //       streets (the equality test the conflict rule rests on) ─────────────
  assert(
    canonical_address('3215 Westwood Ct') === canonical_address('3215 Westwood Court'),
    'Ct and Court must canonicalize equal',
  );
  assert(
    canonical_address('3215 Westwood Ct, Pleasantville CO 80000') ===
      canonical_address('3215 Westwood Ct'),
    'a city/zip suffix must not change the canonical core',
  );
  assert(
    canonical_address(RIGHT) !== canonical_address(WRONG),
    'two different streets must canonicalize differently',
  );
  ok('canonical_address: abbreviation-equal, suffix-stable, street-distinct');

  assert(has_address(`his place is ${WRONG} per the report`), 'has_address detects an address');
  assert(!has_address('what is his phone number?'), 'has_address ignores non-addresses');
  ok('has_address gates correctly');

  // ── 2. PURE ENGINE — master record beats a reviewed:false clipping ─────────
  const master_vs_clip: EvidenceSource[] = [
    {
      tier: 'master_record',
      subject: 'Jasper Doe',
      text: `Jasper Doe — address: ${RIGHT}`,
      ref: 'People/Jasper-Doe.md',
    },
    {
      tier: 'derived_clipping',
      text: `Notes on Jasper — his home address is ${WRONG} (from the lab report).`,
      ref: 'Knowledge/Ruby/library/2026-05-31-jasper.md',
    },
  ];
  const r1 = apply_grounding_precedence(master_vs_clip, { subjects: ['Jasper Doe'] });
  assert(r1.excluded.length === 1, `expected 1 exclusion, got ${r1.excluded.length}`);
  assert(r1.excluded[0]!.value === WRONG, 'the WRONG address must be the excluded value');
  assert(r1.excluded[0]!.beaten_by === 'master_record', 'the master record must be the winner');
  const clip_after = r1.sources.find((s) => s.tier === 'derived_clipping')!;
  assert(!clip_after.text.includes(WRONG), `the clipping must no longer contain ${WRONG}`);
  assert(clip_after.text.includes(PRECEDENCE_SCRUB_MARKER), 'the scrub marker must replace it');
  // The input must be untouched (pure).
  assert(master_vs_clip[1]!.text.includes(WRONG), 'the engine must not mutate its input');
  ok('pure engine: master record scrubs a conflicting reviewed:false clipping address');

  // The grounding evidence built from the result: WRONG gone, RIGHT present.
  const evidence1 = r1.sources.map((s) => s.text);
  assert(grounds(RIGHT, evidence1), 'the correct address must ground after precedence');
  assert(!grounds(WRONG, evidence1), 'the wrong address must NOT ground after precedence');
  ok('grounding evidence: RIGHT grounds, WRONG does not (the fabrication-loop fix)');

  // ── 3. PURE ENGINE — a direct USER STATEMENT beats the clipping (no master) ─
  const user_vs_clip: EvidenceSource[] = [
    { tier: 'user_statement', text: `No, Jasper's home address is ${RIGHT}.`, ref: 'user message' },
    {
      tier: 'derived_clipping',
      text: `Jasper lives at ${WRONG} according to my note.`,
      ref: 'Knowledge/Ruby/library/2026-05-31-jasper.md',
    },
  ];
  const r2 = apply_grounding_precedence(user_vs_clip, { subjects: ['Jasper Doe', 'Jasper'] });
  assert(
    r2.excluded.length === 1 && r2.excluded[0]!.beaten_by === 'user_statement',
    'a user statement must beat the clipping',
  );
  assert(!r2.sources[1]!.text.includes(WRONG), 'the clipping address must be scrubbed by the user statement');
  ok('pure engine: a direct user statement outranks the clipping');

  // ── 4. NEGATIVE — agreeing addresses are NOT scrubbed ──────────────────────
  const agree: EvidenceSource[] = [
    { tier: 'master_record', subject: 'Jasper Doe', text: `Jasper Doe — address: ${RIGHT}`, ref: 'People/Jasper-Doe.md' },
    { tier: 'derived_clipping', text: `Jasper's address: 3215 Westwood Court.`, ref: 'Knowledge/Ruby/library/x.md' },
  ];
  const r3 = apply_grounding_precedence(agree, { subjects: ['Jasper Doe'] });
  assert(r3.excluded.length === 0, 'an agreeing clipping (Court vs Ct) must NOT be scrubbed');
  assert(r3.sources[1]!.text.includes('Westwood Court'), 'the agreeing clipping text must survive');
  ok('negative: a clipping that AGREES with the master record is preserved');

  // ── 5. NEGATIVE — a DIFFERENT person is untouched (subject isolation) ───────
  const other_person: EvidenceSource[] = [
    { tier: 'master_record', subject: 'Jasper Doe', text: `Jasper Doe — address: ${RIGHT}`, ref: 'People/Jasper-Doe.md' },
    { tier: 'derived_clipping', text: `Maria Gonzalez lives at ${WRONG}.`, ref: 'Knowledge/Ruby/library/maria.md' },
  ];
  const r4 = apply_grounding_precedence(other_person, { subjects: ['Jasper Doe', 'Maria Gonzalez'] });
  assert(r4.excluded.length === 0, "another person's address must not be scrubbed by Jasper's master record");
  assert(r4.sources[1]!.text.includes(WRONG), "Maria's clipping address must survive");
  ok('negative: a different-subject clipping is isolated (no over-scrub)');

  // ── 6. NEGATIVE — a clipping with NO authoritative counterpart is untouched ─
  const lonely: EvidenceSource[] = [
    { tier: 'derived_clipping', text: `Jasper might live around ${WRONG}.`, ref: 'Knowledge/Ruby/library/x.md' },
  ];
  const r5 = apply_grounding_precedence(lonely, { subjects: ['Jasper Doe'] });
  assert(r5.excluded.length === 0, 'with no authoritative source, nothing is scrubbed');
  ok('negative: a clipping with no master/user counterpart is left intact');

  // ── 7. Authority ranks: user > master > tool > reviewed > derived ──────────
  assert(
    AUTHORITY_RANK.user_statement > AUTHORITY_RANK.master_record &&
      AUTHORITY_RANK.master_record > AUTHORITY_RANK.tool_result &&
      AUTHORITY_RANK.tool_result > AUTHORITY_RANK.reviewed_clipping &&
      AUTHORITY_RANK.reviewed_clipping > AUTHORITY_RANK.derived_clipping,
    'authority ranks must be strictly ordered',
  );
  ok('authority ranks are strictly ordered (user > master > tool > reviewed > derived)');

  // ── 8. address stringification (string + structured object) ────────────────
  assert(stringify_address(RIGHT) === RIGHT, 'a string address passes through');
  assert(
    stringify_address({ street: '3215 Westwood Ct', city: 'Pleasantville', state: 'CO', zip: '80000' }) ===
      '3215 Westwood Ct, Pleasantville, CO, 80000',
    'a structured address is joined into a comparable string',
  );
  assert(stringify_address(undefined) === null && stringify_address({}) === null, 'empty/absent → null');
  ok('stringify_address handles string + structured + empty');

  // ── 9. RUNTIME BRIDGE — Ruby's turn, end to end ────────────────────────────
  // Reproduce the live shape: turn-RAG surfaced ONLY Ruby's own reviewed:false
  // clipping (the master People record is outside her knowledge_scope), and the
  // user asks for the address. The bridge must inject the master block AND scrub
  // the wrong address from the rendered RAG section.
  const roster: PersonRosterEntry[] = [
    { name: 'Jasper Doe', preferred_name: 'Jasper', address: RIGHT, note_path: 'People/Jasper-Doe.md', is_self: true },
    { name: 'Maria Gonzalez', preferred_name: null, address: '88 Mountain Ave', note_path: 'People/Maria-Gonzalez.md' },
  ];
  const clip_path = 'Knowledge/Ruby/library/2026-05-31-jasper.md';
  const clipping_meta = (note_path: string): ClippingMeta | null =>
    note_path === clip_path ? { is_clipping: true, reviewed: false } : { is_clipping: false, reviewed: false };

  const retrieved = [
    {
      note_path: clip_path,
      chunk_text: `Jasper — vet visit. Address on the report: ${WRONG}. Dog: Biscuit.`,
    },
  ];
  const rag_section =
    '\n\n## Relevant material from your library\n\n' +
    `### 1. ${clip_path} — Jasper\n\n${retrieved[0]!.chunk_text}`;

  const out = gather_person_precedence(
    { roster: () => roster, clipping_meta },
    {
      retrieved,
      rag_section,
      message: "what's Jasper's home address?",
      history: [],
    },
  );
  assert(out.applied, 'the bridge must engage on an address turn that names a known person');
  assert(
    out.master_blocks.some((b) => b.includes(RIGHT) && b.includes('Jasper Doe')),
    'the master block must carry the authoritative address',
  );
  assert(!out.rag_section.includes(WRONG), `the rendered RAG section must be scrubbed of ${WRONG}`);
  assert(out.rag_section.includes('Biscuit'), 'the rest of the clipping (Biscuit) must survive the scrub');
  assert(out.excluded.some((e) => e.value === WRONG && e.from_ref === clip_path), 'the exclusion is audited');
  ok('bridge: injects the master block + scrubs the wrong clipping address from RAG');

  // The full turn grounding (RAG section + master blocks) — the exact evidence
  // the fact critic would see: RIGHT grounds, WRONG does not.
  const turn_evidence = [out.rag_section, ...out.master_blocks];
  assert(grounds(RIGHT, turn_evidence), 'turn evidence: the correct address grounds');
  assert(!grounds(WRONG, turn_evidence), 'turn evidence: the wrong address no longer grounds');
  ok('bridge: assembled turn evidence grounds the correct address, not the wrong one');

  // ── 10. BRIDGE no-op safety — no address in the turn → untouched ───────────
  const noop = gather_person_precedence(
    { roster: () => roster, clipping_meta },
    { retrieved: [], rag_section: '', message: 'how are you today?', history: [] },
  );
  assert(!noop.applied && noop.rag_section === '' && noop.master_blocks.length === 0, 'a no-address turn is a clean no-op');
  // Empty roster → no-op even with an address present.
  const noRoster = gather_person_precedence(
    { roster: () => [], clipping_meta },
    { retrieved, rag_section, message: `where is ${WRONG}?`, history: [] },
  );
  assert(!noRoster.applied, 'an empty roster is a clean no-op');
  ok('bridge: address-gated + roster-gated no-ops are clean');

  console.log(`\n✓ GROUNDING-PRECEDENCE TEST PASSED (${checks} checks)`);
}

try {
  main();
} catch (err) {
  console.error(
    '\n✗ GROUNDING-PRECEDENCE TEST FAILED:',
    err instanceof Error ? err.message : String(err),
  );
  process.exit(1);
}
