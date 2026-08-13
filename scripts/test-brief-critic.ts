/**
 * Self-contained test for the deliberation brief critic
 * (src/core/brief_critic.ts) — Durable-Truth Phase 1.5, deliberation arm.
 *
 * Kate's morning brief is the dashboard hero card. Pre-fix the
 * deliberation surface had NO Phase-1 enforcement — a recalled date or
 * invented agenda item that slipped past the prompt-level HARD RULE
 * shipped to the user. This test reproduces a brief that states an
 * ungrounded date + figure against a verified context that doesn't
 * contain them, and asserts the critic (1) detects them and (2)
 * re-prompts tool-free to a grounded rewrite — while a fully-grounded
 * brief is left untouched and every error path fails OPEN to the
 * original brief.
 *
 * The LLM is a scripted mock that plays BOTH roles: the auditor (flags
 * candidates absent from evidence) and the editor (returns a corrected
 * sections JSON). No network.
 *
 *   bun run smoke:brief-critic
 */

import {
  critique_and_correct_brief,
  render_brief_claims,
  type BriefSections,
} from '@core/brief_critic';
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

function assert(c: unknown, m: string): asserts c {
  if (!c) throw new Error(`assert: ${m}`);
}
let checks = 0;
const ok = (l: string) => {
  checks++;
  console.log(`  ✓ ${l}`);
};

// Mock LLM playing both the auditor and the editor role, branching on
// the system prompt. `corrector` lets a test override the rewrite, and
// `throw_in` forces a fail-open path on a chosen role.
function make_mock_llm(opts: {
  corrector?: (sections: BriefSections) => unknown;
  throw_in?: 'auditor' | 'editor';
  raw_editor?: string;
} = {}): LLMRouter {
  const provider: LLMProvider = {
    name: 'mock',
    capabilities: () => ({
      supports_json_schema: false,
      supports_tool_calls: true,
      supports_thinking_mode: false,
      supports_vision: false,
      max_context: 8192,
      cost_per_1m_in_cents: 0,
      cost_per_1m_out_cents: 0,
    }),
    async complete(req: LLMRequest): Promise<LLMResponse> {
      const sys = req.messages.find((m) => m.role === 'system')?.content ?? '';
      const user = req.messages.find((m) => m.role === 'user')?.content ?? '';
      const is_auditor = sys.includes('auditor');
      if (opts.throw_in === (is_auditor ? 'auditor' : 'editor')) {
        throw new Error('mock outage');
      }
      let content: string;
      if (is_auditor) {
        const evidence =
          user.split('EVIDENCE:')[1]?.split('REPLY:')[0]?.toLowerCase() ?? '';
        const cand = user.split('CANDIDATES (not literally in evidence):')[1]?.split(
          '\n\nReply',
        )[0] ?? '';
        const flagged: Array<{ claim: string; kind: string; reason: string }> = [];
        for (const line of cand.split('\n')) {
          const m = line.match(/^\s*\d+\.\s*\[(\w+)\]\s*(.+?)\s*$/);
          if (!m) continue;
          if (evidence.includes(m[2]!.toLowerCase())) continue;
          flagged.push({ claim: m[2]!, kind: m[1]!, reason: 'not in evidence' });
        }
        content = JSON.stringify({ flagged });
      } else {
        // Editor role.
        content =
          opts.raw_editor ??
          JSON.stringify(
            opts.corrector
              ? opts.corrector(GROUNDED_REWRITE_INPUT)
              : GROUNDED_REWRITE,
          );
      }
      return {
        content,
        tool_calls: [],
        finish_reason: 'stop',
        cost: { tokens_in: 0, tokens_out: 0, ms: 0, model: 'mock' },
      };
    },
  };
  const res: RoleResolution = { provider, defaults: {}, model: 'mock' };
  return { for_role: () => res };
}

const GROUNDED_REWRITE_INPUT = {} as BriefSections;
// The editor's grounded rewrite — the fabricated date/figure dropped.
const GROUNDED_REWRITE = {
  noticed:
    "It's a calm morning. I don't have the council agenda confirmed yet.",
  attention_today: [
    {
      title: 'Trail walk',
      body: 'Nice weather for the Mill Creek Trail.',
      urgency: 'today' as const,
    },
  ],
  watching: 'Nothing pressing.',
};

function g(parts: GroundingParts) {
  return {
    grounding: build_grounding_context(parts),
    evidence_text: build_grounding_evidence(parts),
  };
}

// A brief with fabricated specifics: a recalled meeting date + a figure
// that appear in NO verified context.
const FABRICATED_BRIEF: BriefSections = {
  noticed:
    'The next City Council meeting is Tuesday, June 2, 2026, and the Ioniq 5 is at 97%.',
  attention_today: [
    {
      title: 'Budget Work Session',
      body: 'Council reviews the FY2027 Budget today.',
      urgency: 'today',
    },
  ],
  ready_for_review: [{ proposal_id: 'p_abc', one_line_summary: 'Approve X' }],
  watching: 'The Strategic Trails Plan vote.',
};

async function main() {
  console.log('brief_critic — deliberation brief grounding\n');

  // 1. render_brief_claims pulls the load-bearing prose, skips ready_for_review.
  {
    const text = render_brief_claims(FABRICATED_BRIEF);
    assert(text.includes('June 2, 2026'), 'render includes noticed');
    assert(text.includes('Budget Work Session'), 'render includes attention title');
    assert(text.includes('FY2027'), 'render includes attention body');
    assert(!text.includes('Approve X'), 'render excludes ready_for_review summary');
    ok('render_brief_claims extracts prose, excludes ready_for_review');
  }

  // 2. The reproducing case: empty verified context → fabrications
  //    detected AND a grounded rewrite applied.
  {
    const { grounding, evidence_text } = g({
      verified: [JSON.stringify({ now: '2026-05-31', slot: '07:00' })],
    });
    const res = await critique_and_correct_brief({
      sections: FABRICATED_BRIEF,
      grounding,
      evidence_text,
      llm: make_mock_llm(),
    });
    assert(res.findings.length > 0, 'detected unsupported specifics');
    assert(res.corrected, 'applied a tool-free correction');
    const newtext = render_brief_claims(res.sections);
    assert(!newtext.includes('June 2, 2026'), 'corrected brief dropped the fabricated date');
    assert(!newtext.includes('97%'), 'corrected brief dropped the fabricated figure');
    assert(
      res.sections.ready_for_review.length === 1 &&
        res.sections.ready_for_review[0]!.proposal_id === 'p_abc',
      'ready_for_review preserved untouched',
    );
    ok(`fabricated brief → ${res.findings.length} flagged + grounded rewrite, ready_for_review intact`);
  }

  // 3. Control: a brief fully grounded by the verified context → no
  //    findings, no correction.
  {
    const grounded_brief: BriefSections = {
      noticed: 'Calm morning. SoC is 64%.',
      attention_today: [],
      ready_for_review: [],
      watching: 'Nothing pressing.',
    };
    const { grounding, evidence_text } = g({
      verified: [
        JSON.stringify({
          verified_life_context: { ev: { soc_percent: { value: 64, status: 'fresh' } } },
          note: 'Calm morning. SoC is 64%. Nothing pressing.',
        }),
      ],
    });
    const res = await critique_and_correct_brief({
      sections: grounded_brief,
      grounding,
      evidence_text,
      llm: make_mock_llm(),
    });
    assert(res.findings.length === 0, `grounded brief → 0 findings (got ${res.findings.map((f) => f.claim).join(', ')})`);
    assert(!res.corrected, 'no correction on a grounded brief');
    ok('fully-grounded brief → 0 findings, untouched');
  }

  // 4. Fail-open: editor (correction) throws → findings reported but
  //    ORIGINAL sections preserved (corrected:false).
  {
    const { grounding, evidence_text } = g({ verified: [JSON.stringify({ slot: '07:00' })] });
    const res = await critique_and_correct_brief({
      sections: FABRICATED_BRIEF,
      grounding,
      evidence_text,
      llm: make_mock_llm({ throw_in: 'editor' }),
    });
    assert(res.findings.length > 0, 'still detected the fabrications');
    assert(!res.corrected, 'correction failed → corrected:false');
    assert(
      render_brief_claims(res.sections).includes('June 2, 2026'),
      'original brief preserved on correction failure (fail-open)',
    );
    ok('correction outage → findings reported, original brief preserved (fail-open)');
  }

  // 5. Fail-open: malformed editor output → original preserved.
  {
    const { grounding, evidence_text } = g({ verified: [JSON.stringify({ slot: '07:00' })] });
    const res = await critique_and_correct_brief({
      sections: FABRICATED_BRIEF,
      grounding,
      evidence_text,
      llm: make_mock_llm({ raw_editor: 'sorry, the brief looks fine to me' }),
    });
    assert(!res.corrected, 'malformed correction → corrected:false');
    assert(
      render_brief_claims(res.sections).includes('June 2, 2026'),
      'original brief preserved on malformed correction',
    );
    ok('malformed correction output → fail-open, original preserved');
  }

  // 6. Absent router → no findings, no throw.
  {
    const { grounding, evidence_text } = g({ verified: [JSON.stringify({ slot: '07:00' })] });
    const res = await critique_and_correct_brief({
      sections: FABRICATED_BRIEF,
      grounding,
      evidence_text,
      llm: undefined,
    });
    assert(res.findings.length === 0 && !res.corrected, 'absent router → skip');
    ok('absent LLM router → skip, no throw');
  }

  console.log(`\n✓ all ${checks} checks passed`);
}

main().catch((e) => {
  console.error('\n✗ FAILED:', e.message);
  process.exit(1);
});
