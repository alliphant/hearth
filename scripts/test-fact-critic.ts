/**
 * Self-contained test for the semantic fact critic
 * (src/core/fact_critic.ts) — Durable-Truth Phase 1.5.
 *
 * The load-bearing case is Ruby's council-agenda fabrication (2026-05-30):
 * asked "when's the next council meeting and what's the agenda?" with NO
 * tool call, she invented a date + a full agenda ("Budget Work Session:
 * FY2027 Budget", "Strategic Plan Update"). That reply carries no docket
 * identifier and no quoted string, so the regex provenance layer is blind
 * to it. This test reproduces that reply against an empty grounding
 * context and asserts the semantic critic flags the invented specifics —
 * and, critically, that the same reply against a grounding context that
 * DOES contain the agenda yields nothing (no false positive), and that a
 * judge outage fails OPEN.
 *
 * The LLM is a scripted mock — deterministic, no network. It emulates a
 * reasonable judge: it flags candidates that don't appear in the evidence
 * it was handed, leaves stable place names alone, and can be told to throw
 * to exercise the fail-open path.
 *
 *   bun run smoke:fact-critic
 */

import {
  assess_factual_grounding,
  fact_critic_retry_nudge,
  unsourced_specifics,
} from '@core/fact_critic';
import {
  build_grounding_context,
  build_grounding_evidence,
  type GroundingParts,
} from '@core/provenance';
import type {
  LLMRouter,
  LLMProvider,
  LLMRequest,
  LLMResponse,
  RoleResolution,
} from '@core/llm';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`assert: ${message}`);
}

let checks = 0;
function ok(label: string): void {
  checks++;
  console.log(`  ✓ ${label}`);
}

// ── A scripted judge ────────────────────────────────────────────────────
//
// Emulates the real judge cheaply: parse the CANDIDATES block from the
// prompt, flag every candidate whose text is NOT a substring of the
// EVIDENCE block, EXCEPT a small allowlist of stable place names (the
// "bucket (b)" the real judge is told to spare). This lets us assert the
// wiring + the candidate/grounding plumbing without a model.

const STABLE_ALLOW = ['Mill Creek Trail', 'Riverside River Trail', 'Pleasantville'];

function make_mock_llm(opts: { throw_on_call?: boolean; raw?: string } = {}): LLMRouter {
  const provider: LLMProvider = {
    name: 'mock',
    capabilities() {
      return {
        supports_json_schema: false,
        supports_tool_calls: true,
        supports_thinking_mode: false,
        supports_vision: false,
        max_context: 8192,
        cost_per_1m_in_cents: 0,
        cost_per_1m_out_cents: 0,
      };
    },
    async complete(req: LLMRequest): Promise<LLMResponse> {
      if (opts.throw_on_call) throw new Error('judge outage');
      const user = req.messages.find((m) => m.role === 'user')?.content ?? '';
      const evidence =
        user.split('EVIDENCE:')[1]?.split('REPLY:')[0]?.toLowerCase() ?? '';
      const cand_block =
        user.split('CANDIDATES (not literally in evidence):')[1]?.split(
          '\n\nReply',
        )[0] ?? '';
      const flagged: Array<{ claim: string; kind: string; reason: string }> = [];
      for (const line of cand_block.split('\n')) {
        const m = line.match(/^\s*\d+\.\s*\[(\w+)\]\s*(.+?)\s*$/);
        if (!m) continue;
        const kind = m[1]!;
        const claim = m[2]!;
        if (STABLE_ALLOW.some((s) => s.toLowerCase() === claim.toLowerCase()))
          continue; // bucket (b) — stable knowledge
        if (evidence.includes(claim.toLowerCase())) continue; // bucket (a)
        flagged.push({ claim, kind, reason: 'not in evidence' });
      }
      const content =
        opts.raw ?? JSON.stringify({ flagged });
      return {
        content,
        tool_calls: [],
        finish_reason: 'stop',
        cost: { tokens_in: 0, tokens_out: 0, ms: 0, model: 'mock' },
      };
    },
  };
  const resolution: RoleResolution = {
    provider,
    defaults: {},
    model: 'mock',
  };
  return { for_role: () => resolution };
}

function grounding_for(parts: GroundingParts) {
  return {
    grounding: build_grounding_context(parts),
    evidence_text: build_grounding_evidence(parts),
  };
}

// Ruby's actual fabrication shape (no tool call backed it).
const RUBY_FABRICATION =
  '[Sat 2:42 PM] The next City Council meeting is Tuesday, June 2, 2026. ' +
  'It is a Work Session. Agenda Highlights: 1. Budget Work Session: ' +
  'Discussion of the FY2027 Budget framework. 2. Strategic Plan Update: ' +
  'Review of progress on the Strategic Trails Plan.';

async function main() {
  console.log('fact_critic — semantic grounding of named-entity fabrications\n');

  // 1. The reproducing case: empty grounding, no tool result → fabricated
  //    agenda specifics must be flagged.
  {
    const { grounding, evidence_text } = grounding_for({
      user_message: "When's the next council meeting? What's the agenda?",
    });
    const res = await assess_factual_grounding({
      reply: RUBY_FABRICATION,
      grounding,
      evidence_text,
      llm: make_mock_llm(),
    });
    assert(res.checked, 'judge ran (pre-filter found ungrounded candidates)');
    const claims = res.unsupported.map((f) => f.claim);
    assert(
      res.unsupported.length > 0,
      'flagged at least one unsupported specific',
    );
    assert(
      claims.some((c) => /Budget Work Session/i.test(c)),
      'flagged the invented "Budget Work Session" agenda item',
    );
    assert(
      claims.some((c) => /Strategic Trails Plan/i.test(c)),
      'flagged the invented "Strategic Trails Plan"',
    );
    ok(`empty grounding → ${res.unsupported.length} fabrications flagged: ${claims.join(', ')}`);
  }

  // 2. Control — grounding DOES contain the agenda (she actually fetched
  //    it) → nothing flagged. No false positive on a grounded reply.
  {
    // A faithful fetch of the agenda page would contain the same terms the
    // reply uses — so every candidate the pre-filter extracts is grounded.
    const tool_result =
      'citygov.com — City Council. The next City Council meeting is Tuesday, ' +
      'June 2, 2026. It is a Work Session. Agenda Highlights: 1. Budget Work ' +
      'Session: Discussion of the FY2027 Budget framework. 2. Strategic Plan ' +
      'Update: Review of progress on the Strategic Trails Plan.';
    const { grounding, evidence_text } = grounding_for({
      tool_results: [tool_result],
      user_message: "When's the next council meeting? What's the agenda?",
    });
    const res = await assess_factual_grounding({
      reply: RUBY_FABRICATION,
      grounding,
      evidence_text,
      llm: make_mock_llm(),
    });
    assert(
      res.unsupported.length === 0,
      `grounded reply yields no flags (got ${res.unsupported.map((f) => f.claim).join(', ')})`,
    );
    ok('grounded reply (agenda in tool result) → 0 flags, no false positive');
  }

  // 3. Stable knowledge is not flagged even when absent from evidence.
  {
    const { grounding, evidence_text } = grounding_for({
      user_message: 'Tell me about the trail network',
    });
    const res = await assess_factual_grounding({
      reply:
        'The Mill Creek Trail and the Riverside River Trail are the two ' +
        'main paved corridors in Pleasantville.',
      grounding,
      evidence_text,
      llm: make_mock_llm(),
    });
    assert(
      res.unsupported.length === 0,
      `stable place names not flagged (got ${res.unsupported.map((f) => f.claim).join(', ')})`,
    );
    ok('stable place names (Mill Creek / Riverside River Trail) → not flagged');
  }

  // 4. Pre-filter skip: a reply with no extractable specifics never calls
  //    the model (checked:false) — the common low-latency path.
  {
    const { grounding, evidence_text } = grounding_for({ user_message: 'hi' });
    const res = await assess_factual_grounding({
      reply: 'Sure — happy to help. What would you like to look into?',
      grounding,
      evidence_text,
      llm: make_mock_llm(),
    });
    assert(!res.checked, 'pre-filter skipped the judge (no specifics)');
    assert(res.unsupported.length === 0, 'no findings on a no-specifics reply');
    ok('no-specifics reply → judge skipped (checked:false), 0 findings');
  }

  // 5. Fail-open: judge throws → no findings, reply is never blocked.
  {
    const { grounding, evidence_text } = grounding_for({
      user_message: "When's the next council meeting?",
    });
    const res = await assess_factual_grounding({
      reply: RUBY_FABRICATION,
      grounding,
      evidence_text,
      llm: make_mock_llm({ throw_on_call: true }),
    });
    assert(res.unsupported.length === 0, 'judge outage → 0 findings (fail-open)');
    ok('judge outage → fail-open (0 findings, reply not blocked)');
  }

  // 6. Fail-open: unparseable judge output → no findings.
  {
    const { grounding, evidence_text } = grounding_for({
      user_message: "When's the next council meeting?",
    });
    const res = await assess_factual_grounding({
      reply: RUBY_FABRICATION,
      grounding,
      evidence_text,
      llm: make_mock_llm({ raw: 'I think the agenda looks fine to me!' }),
    });
    assert(res.unsupported.length === 0, 'garbage judge output → 0 findings');
    ok('unparseable judge output → fail-open (0 findings)');
  }

  // 7. Absent router → no findings, no throw.
  {
    const { grounding, evidence_text } = grounding_for({
      user_message: 'anything',
    });
    const res = await assess_factual_grounding({
      reply: RUBY_FABRICATION,
      grounding,
      evidence_text,
      llm: undefined,
    });
    assert(!res.checked && res.unsupported.length === 0, 'absent router → skip');
    ok('absent LLM router → skip, no throw');
  }

  // 8. The retry nudge names the specifics and demands fetch-or-drop.
  {
    const nudge = fact_critic_retry_nudge([
      { claim: 'Budget Work Session', kind: 'named_entity', reason: 'not in evidence' },
      { claim: 'June 2, 2026', kind: 'date', reason: 'not in evidence' },
    ]);
    assert(nudge.includes('Budget Work Session'), 'nudge names the entity');
    assert(nudge.includes('June 2, 2026'), 'nudge names the date');
    assert(/one retry/i.test(nudge), 'nudge states it is the one retry');
    ok('retry nudge names every unsourced specific + demands fetch-or-drop');
  }

  // 9. Markdown structure (headers / bold labels) is NOT extracted as a
  //    named-entity candidate — the workstation-desk false-positive class.
  //    A real entity in the PROSE still gets checked. (2026-06-08)
  {
    const { grounding, evidence_text } = grounding_for({
      user_message: 'did you reclassify the box?',
    });
    const res = await assess_factual_grounding({
      reply:
        '### Summary of Actions Taken\n\n' +
        '**Previous Form Factor**: sff. **New Form Factor**: edge.\n\n' +
        'Done — the Lenovo ThinkStation PGX is now Edge·AI.\n\n' +
        '```python\nprint("ran a check")\n```',
      grounding,
      evidence_text,
      llm: make_mock_llm(),
    });
    const claims = res.unsupported.map((f) => f.claim);
    assert(
      !claims.some((c) => /Summary of Actions Taken|Form Factor/i.test(c)),
      `markdown header/label NOT flagged (got ${claims.join(', ')})`,
    );
    assert(
      !claims.some((c) => /ran a check|print/i.test(c)),
      'fenced code content NOT flagged',
    );
    ok('markdown headers/labels + code fences → not extracted as candidates');
  }

  // 10. Self-identity grounding: a specialist naming its OWN office ("Recon
  //     Desk") is not flagged — the system prompt that carries it is excluded
  //     from turn evidence, so without self_identity it reads as a fabrication.
  {
    const { grounding, evidence_text } = grounding_for({
      user_message: 'where did you file it?',
    });
    const reply = 'I filed the update on the Recon Desk.';
    // Control: WITHOUT self_identity, the office name is an ungrounded
    // candidate and the judge flags it.
    const without = await assess_factual_grounding({
      reply, grounding, evidence_text, llm: make_mock_llm(),
    });
    assert(
      without.unsupported.some((f) => /Recon Desk/i.test(f.claim)),
      'control: without self_identity, "Recon Desk" IS flagged',
    );
    // Treatment: WITH self_identity, it grounds → 0 candidates → judge never
    // runs (throw_on_call proves it: a call would throw → checked:true).
    const withSelf = await assess_factual_grounding({
      reply, grounding, evidence_text,
      llm: make_mock_llm({ throw_on_call: true }),
      self_identity:
        'You are Kristi, Workstation Analyst. Your office/workspace is called "Recon Desk". Tools you hold: update_sku, lookup_workstation.',
    });
    assert(!withSelf.checked, 'self_identity grounded the only candidate → judge not called');
    assert(withSelf.unsupported.length === 0, 'self-reference "Recon Desk" not flagged');
    ok('self-identity grounds the specialist’s own office name (no false flag)');
  }

  // 11. The retry nudge tells the model NOT to leak the correction to the
  //     user — no apology, no "I fabricated", no narrating the reset.
  {
    const nudge = fact_critic_retry_nudge([
      { claim: 'Recon Desk', kind: 'named_entity', reason: 'x' },
    ]);
    assert(/do NOT apologize/i.test(nudge), 'nudge forbids apologizing');
    assert(/never sees this note/i.test(nudge), 'nudge says the user never sees it');
    assert(/fabricated/i.test(nudge) && /do NOT/i.test(nudge), 'nudge forbids the "I fabricated" leak');
    ok('retry nudge instructs a silent, direct correction (no machinery leak)');
  }

  // 12. Candidate-extractor precision (2026-06-09 live false positives):
  //     sentence-initial common words don't start entities ("Flagged to
  //     Beatrice"), date/time edge tokens don't form them ("PM Friday",
  //     "Tuesday Winds") — while real entities still extract.
  {
    const empty = { text: '', squashed: '' };
    const flagged = unsourced_specifics(
      "Flagged to Beatrice — she'll come back with a proposal.",
      empty,
    );
    assert(
      !flagged.some((c) => /Flagged/i.test(c)),
      `sentence-initial "Flagged to Beatrice" not a candidate (got ${flagged.join(', ')})`,
    );
    const pm_friday = unsourced_specifics(
      "I'll move the lunch with Quincy to 1:00 PM Friday.",
      empty,
    );
    assert(
      !pm_friday.some((c) => /PM Friday/i.test(c)),
      '"PM Friday" time fragment not a candidate',
    );
    const winds = unsourced_specifics(
      'Winds up to 30 mph expected Tuesday Winds advisory in effect.',
      empty,
    );
    assert(
      !winds.some((c) => /Tuesday Winds/i.test(c)),
      '"Tuesday Winds" date-glued fragment not a candidate',
    );
    const real = unsourced_specifics(
      'The Mill Creek Trail repaving was approved at the Budget Work Session.',
      empty,
    );
    assert(
      real.some((c) => /Mill Creek Trail/.test(c)) &&
        real.some((c) => /Budget Work Session/.test(c)),
      `real entities still extract (got ${real.join(', ')})`,
    );
    ok('extractor precision: positional/datetime fragments out, real entities in');
  }

  console.log(`\n✓ all ${checks} checks passed`);
}

main().catch((err) => {
  console.error('\n✗ FAILED:', err.message);
  process.exit(1);
});
