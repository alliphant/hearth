/**
 * Domain packs (Durable-Truth Phase 1, 2026-05-30).
 *
 * A *domain pack* is a pre-pump: it gathers verified, sourced context for
 * a surface BEFORE the LLM turn, so the turn renders live state instead of
 * recalling it — and so its fresh readings become legitimate grounding
 * entries the provenance validator (src/core/provenance.ts) can check the
 * surface's output against. This is the generalization of the original
 * `pull_brief_context` (Kate's life-context pre-pump) into a reusable
 * shape: each pack contributes (1) a structured context object the prompt
 * builder injects, and (2) a `grounding_corpus()` string of its FRESH
 * readings only.
 *
 * `life_context` is the first and currently only pack (Kate's report-time
 * briefs). New packs — a finance pack for Vivian, a pet-medical pack for
 * Anya — follow the same two-method contract; wiring a pack's
 * grounding_corpus into a surface's provenance check is then a one-liner.
 */

export * from './life_context';

import type { VerifiedLifeContext } from './life_context';
import { life_context_grounding_corpus } from './life_context';

/**
 * The minimal contract a domain pack satisfies: it produces a context
 * object (shape is pack-specific) and can render that object's verified
 * readings as a grounding corpus. Kept structural rather than as a class
 * so existing puller functions (pull_brief_context) satisfy it without
 * refactoring — `grounding_corpus` is the only new surface.
 */
export interface DomainPack<Ctx> {
  /** Stable id, e.g. 'life_context'. */
  id: string;
  /** Render the FRESH readings of a context object as grounding text. */
  grounding_corpus(ctx: Ctx): string;
}

export const life_context_pack: DomainPack<VerifiedLifeContext> = {
  id: 'life_context',
  grounding_corpus: life_context_grounding_corpus,
};
