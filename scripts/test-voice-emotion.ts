/**
 * smoke:voice-emotion — the inferred spoken-emotion → `instruct` mapping that
 * makes Kate's Laur fine-tune actually use its emotion capability
 * (src/core/voice_emotion.ts).
 *
 * Contract: classify a reply's tone with the tiny status_flavor model → one of a
 * SMALL enum → the fine-tune's `instruct` word; `neutral`/unknown → '' (server
 * default). FAIL-OPEN to '' on every error (disabled, empty, role/endpoint down,
 * garbage). Pure: the LLM router is mocked, no forza.
 */
import {
  infer_voice_emotion,
  instruct_for_tone,
  build_emotion_messages,
  _TONE_INSTRUCT_FOR_TEST as TONES,
} from '../src/core/voice_emotion';
import type { LLMRouter } from '../src/core/llm';

let checks = 0;
let fails = 0;
function check(name: string, ok: boolean): void {
  checks++;
  if (!ok) fails++;
  console.log((ok ? '  ✓ ' : '  ✗ ') + name);
}

/** Mock router whose status_flavor provider returns `tone` (or throws per flags). */
function mock_llm(tone: string, opts?: { role_throws?: boolean; complete_throws?: boolean }): LLMRouter {
  return {
    for_role: (_r: string) => {
      if (opts?.role_throws) throw new Error('no such role');
      return {
        provider: {
          complete: async () => {
            if (opts?.complete_throws) throw new Error('endpoint down');
            return { content: tone };
          },
        },
        defaults: {},
      };
    },
  } as unknown as LLMRouter;
}

async function main(): Promise<void> {
  // ── instruct_for_tone (pure mapping — RICH phrases since 2026-07-03) ──────
  check('warm → the warm phrase', instruct_for_tone('warm') === TONES['warm'] && TONES['warm']!.length > 10);
  check('serious → the serious phrase', instruct_for_tone('serious') === TONES['serious'] && TONES['serious']!.length > 10);
  check('playful → the playful phrase (new tone)', instruct_for_tone('playful') === TONES['playful'] && TONES['playful']!.length > 10);
  // Intimate / character tones (2026-07-13) — shy/flirty/sultry/tender.
  for (const t of ['shy', 'flirty', 'sultry', 'tender']) {
    check(`${t} → its descriptive phrase`, instruct_for_tone(t) === TONES[t] && !!TONES[t] && TONES[t]!.length > 10);
  }
  check('shy classifies to the shy phrase', instruct_for_tone('The tone is shy.') === TONES['shy']);
  check('every non-neutral tone maps to a DESCRIPTIVE phrase (not a bare word)',
    Object.entries(TONES).filter(([k]) => k !== 'neutral').every(([, v]) => v.split(' ').length >= 4));
  check('neutral → "" (server default)', instruct_for_tone('neutral') === '');
  check('unknown word → ""', instruct_for_tone('sparkly') === '');
  check('padded "The tone is warm." → warm phrase', instruct_for_tone('The tone is warm.') === TONES['warm']);
  check('empty → ""', instruct_for_tone('') === '');

  // ── infer_voice_emotion (gated + fail-open) ───────────────────────────────
  delete process.env.HEARTH_VOICE_EMOTION;
  check('disabled → "" even with a live mock', (await infer_voice_emotion('great news!', mock_llm('warm'))) === '');

  process.env.HEARTH_VOICE_EMOTION = '1';
  check('enabled + "warm" → warm phrase', (await infer_voice_emotion('Your package shipped!', mock_llm('warm'))) === TONES['warm']);
  check('enabled + "upbeat" → upbeat phrase', (await infer_voice_emotion('We did it!', mock_llm('upbeat'))) === TONES['upbeat']);
  check('enabled + "playful" → playful phrase', (await infer_voice_emotion('Handled, no threats needed.', mock_llm('playful'))) === TONES['playful']);
  check('enabled + "neutral" → ""', (await infer_voice_emotion('It is 3pm.', mock_llm('neutral'))) === '');
  check('enabled + garbage → ""', (await infer_voice_emotion('hi', mock_llm('purple monkey'))) === '');
  check('enabled + empty text → "" (no LLM call)', (await infer_voice_emotion('   ', mock_llm('warm'))) === '');
  check('enabled + role unresolved → ""', (await infer_voice_emotion('hi', mock_llm('warm', { role_throws: true }))) === '');
  check('enabled + endpoint down → ""', (await infer_voice_emotion('hi', mock_llm('warm', { complete_throws: true }))) === '');

  // ── context-aware per-sentence mode (2026-07-08) ──────────────────────────
  {
    const plain = build_emotion_messages('Your afternoon is clear.');
    check('no context → plain REPLY: prompt', String(plain[1]!.content).startsWith('REPLY:'));
    const ctx = build_emotion_messages(
      'But here is what you can do.',
      "I don't have access to that. But here is what you can do.",
    );
    const u = String(ctx[1]!.content);
    check('with context → prompt carries the full reply', u.includes('FULL spoken reply') && u.includes("I don't have access to that."));
    check('with context → targets THIS sentence, in context', u.includes('But here is what you can do.') && u.includes('IN CONTEXT'));
    check('context === text → falls back to plain prompt',
      String(build_emotion_messages('same text', 'same text')[1]!.content).startsWith('REPLY:'));
    check('enabled + context passed through → still classifies',
      (await infer_voice_emotion('But here is what you can do.', mock_llm('reassuring'), 'the whole reply here')) === TONES['reassuring']);
  }

  delete process.env.HEARTH_VOICE_EMOTION;

  console.log('─'.repeat(50));
  if (fails) {
    console.log(`  ${fails}/${checks} FAILED`);
    process.exit(1);
  }
  console.log(`  ✓ smoke:voice-emotion PASSED (${checks} checks)`);
}

void main();
