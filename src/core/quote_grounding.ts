/**
 * quote_grounding — "show me the sentence."
 *
 * The cheapest honest grounding check there is: a claim carries a VERBATIM span
 * from a source, and we confirm by string containment that the span is really
 * in that source. No LLM, no judgement, no way to be talked out of it.
 *
 * Lifted to core 2026-07-31 from `src/specialists/ruby/civic_analysis.ts`,
 * where it shipped as the write-side fabrication gate behind
 * `record_politics_item` / `record_civic_item`. Deep research's §3.5
 * quote-anchoring rung is the same check on a different surface, and the design
 * says to reuse it rather than grow a second dialect of "is this quote real".
 * `civic_analysis` re-exports these so Ruby's callers and her smoke are
 * unchanged.
 *
 * Both functions are PURE.
 */

/**
 * Collapse a string to a normalized token stream for quote matching:
 * lowercase, every non-alphanumeric run → one space. Survives markdown
 * decoration, JSON escaping (audit results are JSON-serialized), curly quotes,
 * and whitespace reflow — while keeping WORD ORDER exact, which is what makes
 * this a containment test rather than a bag-of-words similarity.
 */
export function normalize_for_quote(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/**
 * Does the quote appear verbatim (modulo normalization) in any of the evidence
 * payloads?
 *
 * Quotes shorter than 12 normalized chars are REJECTED — too easy to match by
 * accident. The 2026-06-10 StreetMedia fabrication had exactly that shape: real
 * scaffold tokens ("June 16"), invented claim. A short span that happens to
 * appear proves nothing, so it must not be allowed to certify anything.
 */
export function quote_in_evidence(quote: string, evidence: readonly string[]): boolean {
  const q = normalize_for_quote(quote);
  if (q.length < MIN_QUOTE_CHARS) return false;
  return evidence.some((e) => normalize_for_quote(e).includes(q));
}

/** Normalized-character floor below which a quote cannot certify anything. */
export const MIN_QUOTE_CHARS = 12;
