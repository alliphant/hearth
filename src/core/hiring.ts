/**
 * Hiring packet — the shared shape of an agentic-hire proposal.
 *
 * Kate's `propose_hire` tool drafts one of these and files it as a
 * Proposal (kind `recommendation`, execution `manual`). When Jasper
 * approves the proposal, the hire route's `/from-packet` endpoint reads
 * the packet back and materializes the specialist.
 *
 * Keeping the schema here — not in the tool or the route — lets the
 * producer and the consumer validate against the exact same shape.
 */
import { z } from 'zod';

/** The Proposal kind a hiring packet rides on. */
export const HIRING_PROPOSAL_KIND = 'recommendation' as const;
/** The category-signature `kind` token that marks a hiring proposal. */
export const HIRING_SIGNATURE_KIND = 'hire';

/** Voice families — mirrors the SpecialistConfig schema's enum. */
export const VoiceEnum = z.enum([
  'warm',
  'warm-direct',
  'warm-precise',
  'warm-encyclopedic',
  'warm-archival',
  'warm-technical',
  'warm-vigilant',
]);

/**
 * Proactive cadence — a subset of SpecialistConfig.proactive.
 *
 * NOTE: no `.regex()` here. This schema feeds `propose_hire`'s tool
 * input_schema, and a regex on an array-of-string field makes
 * llama.cpp's JSON-schema→GBNF converter emit malformed grammar
 * (`\d` → literal `"\d"`), which fails the whole tool grammar. The
 * `deliberation_at` "HH:MM" shape is enforced in code (propose_hire's
 * execute) and again by the specialist-config schema on materialize.
 */
export const ProactiveSchema = z.object({
  mode: z.enum(['active', 'batched', 'reactive']),
  awareness_hz: z.coerce.number().positive().optional(),
  deliberation_at: z
    .array(z.string())
    .optional()
    .describe('Deliberation times as 24-hour "HH:MM" strings, e.g. "09:00".'),
  interrupt_threshold: z.enum(['low', 'medium', 'medium-high', 'high']).optional(),
});

/** True when every entry is a 24-hour "HH:MM" string. */
export function valid_deliberation_at(times: string[]): boolean {
  return times.every((t) => /^\d{2}:\d{2}$/.test(t));
}

/** Verdict from the persona shape gate — `reason` feeds logs + the retry nudge. */
export interface PersonaDraftVerdict {
  ok: boolean;
  reason?: string;
}

// The drafting contract is 150-300 words; the gate allows modest overrun
// before calling a draft a runaway. Reasoning dumps run far past this.
const PERSONA_MAX_WORDS = 450;
// Below this a "persona" is degenerate (a stub line, a refusal, a fragment).
const PERSONA_MIN_WORDS = 30;

/**
 * Deterministic shape gate on an LLM-drafted persona.
 *
 * The drafter roles run think-ON; when a model emits its reasoning as plain
 * prose (no `<think>` tags, so no provider-level strip applies), the whole
 * dump used to be stored verbatim as the persona — and would have gone live
 * as the new specialist's system prompt on approval (the Harper packet,
 * 2026-06-10: persona began "Here's a thinking process: 1. Analyze User
 * Input…"). The gate validates the POSITIVE drafting contract — warm
 * second-person prose that opens "You are <name> …" within the word budget —
 * rather than enumerating reasoning shapes.
 */
export function validate_persona_draft(text: string, name: string): PersonaDraftVerdict {
  const trimmed = text.trim();
  if (trimmed.length === 0) return { ok: false, reason: 'empty draft' };
  if (/<\/?think>/i.test(trimmed)) {
    return { ok: false, reason: 'contains a <think> reasoning tag' };
  }
  if (trimmed.includes('```')) {
    return { ok: false, reason: 'contains a fenced code block' };
  }
  // Strip leading markdown decoration (bold, headers, quotes) before the
  // opener check so "**You are Harper**…" still passes.
  const opening = trimmed.replace(/^[\s>#*_"'“”-]+/, '');
  if (!/^you\s+are\b|^you['’]re\b/i.test(opening)) {
    return {
      ok: false,
      reason: 'does not open with the second-person "You are …" contract',
    };
  }
  if (!trimmed.slice(0, 200).toLowerCase().includes(name.toLowerCase())) {
    return { ok: false, reason: `does not name ${name} in its opening` };
  }
  const words = trimmed.split(/\s+/).length;
  if (words < PERSONA_MIN_WORDS) {
    return { ok: false, reason: `too short to be a persona (${words} words)` };
  }
  if (words > PERSONA_MAX_WORDS) {
    return {
      ok: false,
      reason: `${words} words — far past the 300-word contract (reads like a reasoning dump)`,
    };
  }
  return { ok: true };
}

/** Corrective instruction for the one retry the drafting sites get. */
export function persona_retry_nudge(name: string, reason: string): string {
  return (
    `A previous draft was rejected by a deterministic shape check: ${reason}. ` +
    `Reply with ONLY the finished persona text — 150-300 words of warm ` +
    `second-person prose opening "You are ${name}, …". No reasoning, no ` +
    `numbered steps, no preamble, no closing commentary.`
  );
}

/**
 * Shared draft → validate → retry-once → fallback loop for every site that
 * stores LLM-drafted persona text. The `attempt` closure owns the actual
 * LLM call (direct drafter role, a Kate turn, …) and receives the corrective
 * nudge on the second attempt. A throwing attempt or two failed shape checks
 * land on the deterministic `fallback` template — never raw model output.
 */
export async function draft_persona_validated(opts: {
  name: string;
  attempt: (retry_nudge?: string) => Promise<string>;
  fallback: string;
  log_label: string;
}): Promise<string> {
  let nudge: string | undefined;
  for (let i = 0; i < 2; i++) {
    let text: string;
    try {
      text = (await opts.attempt(nudge)).trim();
    } catch (err) {
      console.error(`[${opts.log_label}] persona draft failed; using template:`, err);
      return opts.fallback;
    }
    const verdict = validate_persona_draft(text, opts.name);
    if (verdict.ok) return text;
    console.warn(
      `[${opts.log_label}] persona draft rejected (${verdict.reason}); ` +
        (i === 0 ? 'retrying once' : 'using the template fallback'),
    );
    nudge = persona_retry_nudge(opts.name, verdict.reason ?? 'failed the shape check');
  }
  return opts.fallback;
}

export const HiringPacketSchema = z.object({
  /** One-line headline for the proposal card. */
  headline: z.string().min(1),
  /** The drafted specialist — everything but their capabilities. */
  specialist: z.object({
    id: z.string().regex(/^[a-z][a-z0-9_]*$/, 'id must be lowercase snake_case'),
    name: z.string().min(1),
    role: z.string().min(1),
    voice: VoiceEnum,
    persona: z.string().min(1),
    knowledge_scope: z.array(z.string()),
    proactive: ProactiveSchema,
  }),
  /** Tier 1 — capabilities backed by existing tools, granted on hire. */
  day_1_capabilities: z.array(z.string()),
  /** Tier 2 — capabilities that need a tool built first. */
  build_queue: z.array(
    z.object({
      capability: z.string(),
      why: z.string(),
    }),
  ),
  /** Beatrice's full per-capability gap analysis, for the reviewer. */
  gap_analysis: z.array(
    z.object({
      capability: z.string(),
      status: z.string(),
      existing_tools: z.array(z.string()),
      note: z.string(),
    }),
  ),
});

export type HiringPacket = z.infer<typeof HiringPacketSchema>;
