/**
 * Brief fact critic — the deliberation-surface arm of Durable Truth
 * Phase 1.5 (2026-05-31).
 *
 * The chat fact critic (src/core/fact_critic.ts) runs at chat finalize.
 * Deliberation never had Phase-1 enforcement at all — Kate's morning
 * brief is the hero card on every cold launch, and the only thing
 * standing between it and a fabricated date/agenda/figure was the
 * prompt-level HARD RULE block. This module adds the same semantic
 * check to the brief.
 *
 * Why this can't just reuse the chat path: a deliberation turn creates
 * proposals via tool calls DURING the turn, so re-running the whole
 * deliberation to "retry" would double-create them. So the critic runs
 * at the ENVELOPE level (after the turn returns, before the brief is
 * stored) and its correction is a SINGLE TOOL-FREE planner call — the
 * model re-does only the brief's prose, grounded in the same verified
 * context it already had, with the unsupported specifics named. No
 * tools fire, so there are no side effects to double. This is the
 * faithful deliberation analog of the chat nudge-retry, not a regex
 * redaction (the model self-corrects given the evidence).
 *
 * FAIL-OPEN throughout. Detector finds nothing / correction errors /
 * correction comes back malformed → the ORIGINAL brief ships unchanged.
 * The critic is only ever allowed to make the brief MORE grounded, never
 * to break it.
 */

import { z } from 'zod';
import { judgment_role, type LLMRouter } from './llm';
import {
  assess_factual_grounding,
  type FactFinding,
} from './fact_critic';
import { type GroundingContext } from './provenance';

/** The shape of a Kate morning_brief's sections (mirrors the
 *  DeliberationEnvelope.morning_brief.sections type). */
export interface BriefSections {
  noticed: string;
  attention_today: Array<{
    title: string;
    body: string;
    urgency: 'now' | 'today' | 'this_week';
    source_specialist_id?: string;
  }>;
  ready_for_review: Array<{ proposal_id: string; one_line_summary: string }>;
  watching: string;
}

/**
 * The load-bearing prose of a brief — the fields where Kate states
 * facts the user acts on. `ready_for_review` is excluded: it references
 * real proposal IDs created this pass, grounded by construction.
 */
export function render_brief_claims(sections: BriefSections): string {
  const parts: string[] = [];
  if (sections.noticed) parts.push(sections.noticed);
  for (const a of sections.attention_today ?? []) {
    if (a.title) parts.push(a.title);
    if (a.body) parts.push(a.body);
  }
  if (sections.watching) parts.push(sections.watching);
  return parts.join('\n');
}

const CorrectionSchema = z.object({
  noticed: z.string().default(''),
  attention_today: z
    .array(
      z.object({
        title: z.string().default(''),
        body: z.string().default(''),
        urgency: z.enum(['now', 'today', 'this_week']).default('today'),
        source_specialist_id: z.string().optional(),
      }),
    )
    .default([]),
  watching: z.string().default(''),
});

function strip_fence(s: string): string {
  const m = s.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
  return (m ? m[1]! : s).trim();
}

function build_correction_prompt(
  sections: BriefSections,
  findings: FactFinding[],
  evidence_text: string,
): string {
  const flagged = findings
    .map((f) => `- ${f.kind}: "${f.claim}"${f.reason ? ` — ${f.reason}` : ''}`)
    .join('\n');
  const current = JSON.stringify(
    {
      noticed: sections.noticed,
      attention_today: sections.attention_today,
      watching: sections.watching,
    },
    null,
    2,
  );
  return (
    `VERIFIED CONTEXT (the only facts you may state):\n${evidence_text.slice(0, 6000)}\n\n` +
    `CURRENT BRIEF SECTIONS:\n${current}\n\n` +
    `These specifics in the brief are NOT supported by the verified ` +
    `context — they were recalled from memory, which is fabrication:\n${flagged}\n\n` +
    `Rewrite the sections so each flagged specific is either (a) restated ` +
    `using ONLY what the verified context supports, or (b) dropped / ` +
    `softened to a non-specific phrasing ("I don't have the agenda ` +
    `confirmed yet"). Leave everything else EXACTLY as written — do not ` +
    `add new claims, do not embellish. Keep the same structure.\n\n` +
    `Reply with ONLY this JSON:\n` +
    `{"noticed": "...", "attention_today": [{"title":"...","body":"...",` +
    `"urgency":"now|today|this_week","source_specialist_id":"..."}], ` +
    `"watching": "..."}`
  );
}

const CORRECTION_SYSTEM =
  'You are a fact-grounding editor for a daily brief. You remove or ' +
  'soften ONLY the specifics that are not supported by the verified ' +
  'context you are given, and you change nothing else. You never add a ' +
  'new claim. You reply with ONLY the requested JSON.';

export interface BriefCritiqueResult {
  sections: BriefSections;
  findings: FactFinding[];
  /** True when the correction call ran AND produced a usable rewrite. */
  corrected: boolean;
}

/**
 * Detect unsupported specifics in a brief and, if any, re-prompt the
 * model (tool-free) to produce a grounded rewrite of the prose fields.
 * Returns the (possibly corrected) sections plus the findings for audit.
 * Fail-open: any error / malformed correction → original sections,
 * `corrected:false`.
 */
export async function critique_and_correct_brief(args: {
  sections: BriefSections;
  grounding: GroundingContext;
  evidence_text: string;
  llm?: LLMRouter;
  /** Kate's structural identity + staff roster — see
   *  assess_factual_grounding.self_identity. A brief saying "Beatrice
   *  flagged X" is routing, not fabrication. */
  self_identity?: string;
}): Promise<BriefCritiqueResult> {
  const { sections, grounding, evidence_text, llm } = args;
  const claims_text = render_brief_claims(sections);
  if (!claims_text || !llm) {
    return { sections, findings: [], corrected: false };
  }

  const { unsupported } = await assess_factual_grounding({
    reply: claims_text,
    grounding,
    evidence_text,
    llm,
    ...(args.self_identity ? { self_identity: args.self_identity } : {}),
  });
  if (unsupported.length === 0) {
    return { sections, findings: [], corrected: false };
  }

  // Unsupported specifics found — re-prompt the model tool-free to
  // ground or drop them.
  let role;
  try {
    role = judgment_role(llm);
  } catch {
    return { sections, findings: unsupported, corrected: false };
  }

  let resp;
  try {
    resp = await role.provider.complete({
      messages: [
        { role: 'system', content: CORRECTION_SYSTEM },
        {
          role: 'user',
          content: build_correction_prompt(sections, unsupported, evidence_text),
        },
      ],
      ...role.defaults,
      // pins AFTER the spread so a yaml regression can't flip them (llm.ts depth-tier note)
      temperature: 0.1,
      max_tokens: 1200,
      think: false,
    });
  } catch {
    return { sections, findings: unsupported, corrected: false };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(strip_fence(resp.content));
  } catch {
    return { sections, findings: unsupported, corrected: false };
  }
  const r = CorrectionSchema.safeParse(parsed);
  if (!r.success) {
    return { sections, findings: unsupported, corrected: false };
  }

  // Merge: replace only the prose fields; ready_for_review (real
  // proposal ids) is preserved untouched.
  const corrected_sections: BriefSections = {
    noticed: r.data.noticed,
    attention_today: r.data.attention_today,
    ready_for_review: sections.ready_for_review,
    watching: r.data.watching,
  };
  return { sections: corrected_sections, findings: unsupported, corrected: true };
}
