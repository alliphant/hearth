/**
 * citations — claim→source verification for research replies (2026-06-10).
 *
 * The chat-time critics work BACKWARDS: read a finished reply, guess which
 * claims are ungrounded, substring-match against a big evidence blob. This
 * module flips the contract for research-workload specialists: tool results
 * get stable [S1]/[S2]/… labels as they arrive, the prompt requires every
 * load-bearing specific to carry the marker of the source it came from, and
 * verification becomes MECHANICAL — a cited sentence's specifics must
 * actually appear in the cited source (else "mismatched"); a specific that
 * IS in some source but carries no marker is "uncited."
 *
 * What this deliberately does NOT judge: a specific found in NO source.
 * That's the semantic fact-critic's territory (stable-knowledge vs
 * volatile-claim is a judgment call); the citation layer stays
 * deterministic so its findings are near-zero false positive. Action is
 * the house style: ONE retry nudge, silent correction, fail-open
 * everywhere. Kill switch: HEARTH_CITATIONS=0.
 */
import { build_grounding_context, type GroundingContext } from './provenance';
import { unsourced_specifics } from './fact_critic';

export interface CitationSource {
  /** Stable label the model cites — "S1", "S2", … */
  id: string;
  tool: string;
  /** The rendered result text the model saw. */
  content: string;
}

export interface CitationFinding {
  claim: string;
  kind: 'mismatched' | 'uncited';
  /** The marker(s) the sentence carried, for 'mismatched'. */
  cited: string[];
  sentence_preview: string;
}

export function citations_enabled(): boolean {
  return process.env.HEARTH_CITATIONS !== '0';
}

const FINDINGS_CAP = 6;
const MARKER_RE = /\[S(\d+)\]/g;
const EMPTY_GROUNDING: GroundingContext = { text: '', squashed: '' };

/** Cheap sentence iterator — no lookbehind, markdown-tolerant. */
export function split_sentences(text: string): string[] {
  return (
    text
      .split(/\n+/)
      .flatMap((line) => line.match(/[^.!?]+[.!?]?/g) ?? [])
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
  );
}

function markers_in(sentence: string): string[] {
  const out = new Set<string>();
  MARKER_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = MARKER_RE.exec(sentence)) !== null) out.add(`S${m[1]}`);
  return [...out];
}

function present_in(specific: string, g: GroundingContext): boolean {
  const probe = build_grounding_context({ verified: [specific] });
  // Mirror provenance's two-form check: squashed substring for ids/codes,
  // normalized substring for phrases.
  return (
    (probe.squashed.length >= 4 && g.squashed.includes(probe.squashed)) ||
    (probe.text.length > 0 && g.text.includes(probe.text))
  );
}

/**
 * Verify a reply's citations against the turn's labeled sources.
 * Deterministic; returns at most FINDINGS_CAP findings.
 */
export function verify_citations(
  reply: string,
  sources: ReadonlyArray<CitationSource>,
): CitationFinding[] {
  if (sources.length === 0) return [];
  const by_id = new Map(sources.map((s) => [s.id, s]));
  const union = build_grounding_context({ tool_results: sources.map((s) => s.content) });
  const grounding_cache = new Map<string, GroundingContext>();
  const grounding_of = (ids: string[]): GroundingContext => {
    const key = ids.slice().sort().join(',');
    const hit = grounding_cache.get(key);
    if (hit) return hit;
    const g = build_grounding_context({
      tool_results: ids.map((id) => by_id.get(id)?.content ?? ''),
    });
    grounding_cache.set(key, g);
    return g;
  };

  const findings: CitationFinding[] = [];
  const seen_claims = new Set<string>();
  for (const sentence of split_sentences(reply)) {
    if (findings.length >= FINDINGS_CAP) break;
    // Strip markers before candidate extraction so "[S1]" never reads as
    // a code-shaped claim itself.
    const bare = sentence.replace(MARKER_RE, ' ');
    const candidates = unsourced_specifics(bare, EMPTY_GROUNDING);
    if (candidates.length === 0) continue;
    const cited = markers_in(sentence).filter((id) => by_id.has(id));

    for (const claim of candidates) {
      if (findings.length >= FINDINGS_CAP) break;
      const key = claim.toLowerCase();
      if (seen_claims.has(key)) continue;
      if (cited.length > 0) {
        if (present_in(claim, grounding_of(cited))) continue; // backed ✓
        if (present_in(claim, union)) {
          seen_claims.add(key);
          findings.push({
            claim,
            kind: 'mismatched',
            cited,
            sentence_preview: sentence.slice(0, 120),
          });
        }
        // In NO source → the semantic critic's call, not ours.
      } else {
        if (present_in(claim, union)) {
          seen_claims.add(key);
          findings.push({
            claim,
            kind: 'uncited',
            cited: [],
            sentence_preview: sentence.slice(0, 120),
          });
        }
      }
    }
  }
  return findings;
}

/** The one-retry nudge — house style: silent, direct correction. */
export function citation_retry_nudge(findings: CitationFinding[]): string {
  const lines = findings.map((f) =>
    f.kind === 'mismatched'
      ? `- "${f.claim}" — cited ${f.cited.map((c) => `[${c}]`).join('')}, but that source doesn't contain it. Cite the source that actually does, or drop the claim.`
      : `- "${f.claim}" — this IS in one of your sources but carries no [S#] marker. Add the marker of the source it came from.`,
  );
  return (
    `[CITATION CHECK — internal system note, not from the user]\n\n` +
    `Your sources this turn are labeled [S1], [S2], … on each tool result. ` +
    `These specifics have citation problems:\n${lines.join('\n')}\n\n` +
    `Re-roll the reply with every load-bearing specific (date, figure, name, ` +
    `price, quote) carrying the marker of the source it actually came from. ` +
    `Write the corrected answer DIRECTLY in your normal voice — no apology, ` +
    `no mention of this check. This is your one retry.`
  );
}

/**
 * The prompt rule injected for research specialists in conversation mode
 * (rides render_research_workload_block).
 */
export const CITATION_PROMPT_RULE =
  `**Cite sources inline.** Each tool result this turn is labeled [S1], ` +
  `[S2], … Every load-bearing specific you state — a date, figure, name, ` +
  `price, or quote — carries the marker of the source it came from, right ` +
  `after the claim ("…opens June 14 [S2]."). A specific you cannot mark ` +
  `with a source does not belong in the reply.`;
