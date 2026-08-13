/**
 * Inferred spoken-emotion for TTS — maps a reply's intended tone to the Laur
 * fine-tune's `instruct` field (forza :8023 custom_voice_server).
 *
 * The live Laur voice is a Qwen3-TTS CustomVoice FINE-TUNE whose whole point was
 * emotion-instructability (the stock zero-shot clone couldn't be instructed). But
 * until now every TTS call sent `instruct:""` so Kate always synthesized neutral.
 * This is the cue layer that fills that hook: classify the reply's tone with a
 * tiny model and pass the matching `instruct` word.
 *
 * Mirrors status_flavor.ts: ONE tight call to the already-live `status_flavor`
 * role (Qwen2.5-1.5B on :8202, off both GPUs), constrained-enum output validated
 * in CODE, FAIL-OPEN to neutral ('') on every error path, never throws into the
 * turn. Dark unless HEARTH_VOICE_EMOTION=1.
 */

import type { LLMMessage, LLMRouter } from './llm';
import type { KvSettings } from './users';

/** Reads env at call time so the kill switch flips without a redeploy. */
export function voice_emotion_enabled(): boolean {
  return process.env.HEARTH_VOICE_EMOTION === '1';
}

/**
 * Master switch for the SETTABLE emotion on the gapless whole-reply path
 * (`/api/voice/stream` — the web voice orb + the native iOS/macOS orb). SEPARATE
 * from HEARTH_VOICE_EMOTION (which drives the Satellite1 coordinator's own
 * context-aware per-sentence path via /tts + /emotion) so flipping this can't
 * change the coordinator's behavior and vice-versa. Off ⇒ /stream is byte-
 * identical to the neutral web/iOS path (the owner's 2026-07-10 A/B default).
 */
export function voice_stream_emotion_enabled(): boolean {
  return process.env.HEARTH_VOICE_STREAM_EMOTION === '1';
}

/**
 * Tone enum → the `instruct` handed to the fine-tune. `neutral` maps to ''
 * (the server default), so a neutral classification costs nothing.
 *
 * RICH DESCRIPTIVE instructs, not bare words (2026-07-03): the original map
 * sent single words ("warm") on the theory the custom_voice_server only
 * accepted those — disproven by direct A/B clips against forza :8023 (same
 * sentence, instruct '' vs 'warm' vs a full descriptive phrase → three
 * measurably different renders; the descriptive phrase moved the delivery
 * the most). Qwen3-TTS instruct-following responds to description, so each
 * tone now carries a compact directing phrase. The CLASSIFIER enum stays
 * one-word (cheap + constrained for the 1.5B); only the mapped value grew.
 */
const TONE_INSTRUCT: Record<string, string> = {
  warm: 'speak warmly, with an affectionate smile in your voice',
  reassuring: 'speak gently and steadily — calm, confident, everything is handled',
  upbeat: 'speak with bright, delighted energy — good news you are excited to share',
  playful: 'speak with a wry, teasing smile — light playful banter, almost laughing',
  serious: 'speak in a lower, measured, serious tone — this matters',
  calm: 'speak slowly and evenly, soft and unhurried',
  // Intimate / character tones (2026-07-13). This is a PRIVATE single-household
  // assistant, so a warmer, more personal register is in scope — these are
  // delivery cues (HOW a line is spoken), not content. The fine-tune follows
  // descriptive phrases, so they're testable on forza's custom_voice_server; but
  // whether it renders each DISTINCTLY needs an A/B listen (the same discipline
  // that validated the tones above). The CLASSIFIER only ever reaches for them on
  // a genuinely personal/affectionate/bashful line — routine COS replies stay
  // neutral/warm — so they can't leak into "your 3pm moved."
  flirty: 'speak with a warm, teasing, flirtatious lilt — a smile and a wink in your voice',
  sultry: 'speak in a low, warm, slow register — intimate, close, and unhurried',
  tender: 'speak low and tenderly — affectionate, gentle, almost a whisper',
  shy: 'speak softly and a little bashfully — hesitant, self-conscious, a shy half-smile',
  neutral: '',
};

/** Exported for the smoke (assert mapping without duplicating the phrases). */
export const _TONE_INSTRUCT_FOR_TEST = TONE_INSTRUCT;

/**
 * Map a raw model reply → an instruct string, or '' (neutral) if no known tone
 * word appears. A word-scan (not equality) so "The tone is warm." still resolves
 * — the model occasionally pads a one-word answer. Order = match priority for the
 * rare multi-word reply; `neutral` is last so it only wins when said explicitly.
 */
export function instruct_for_tone(raw: string): string {
  const lc = (raw || '').toLowerCase();
  for (const tone of ['warm', 'reassuring', 'upbeat', 'playful', 'flirty', 'sultry', 'tender', 'shy', 'serious', 'calm', 'neutral']) {
    if (new RegExp(`\\b${tone}\\b`).test(lc)) return TONE_INSTRUCT[tone]!;
  }
  return '';
}

const SYSTEM = [
  'You label the emotional TONE a spoken assistant reply should be delivered in.',
  'Choose EXACTLY one word from this list (use no other words, not even synonyms):',
  '  warm — friendly good news, affection, gratitude, a welcome',
  '  reassuring — calming a stated worry, "don\'t worry, I\'ve handled it"',
  '  upbeat — excited, celebratory, energetic good news',
  '  playful — teasing, wry humor, banter, a cheeky aside, a joke landing',
  '  flirty — warm flirtation, a compliment with a wink, charm turned up',
  '  sultry — low and intimate, a private close moment, unhurried',
  '  tender — gentle affection, comfort, or care; a soft heartfelt line',
  '  shy — bashful, self-conscious, a little hesitant or caught off guard',
  '  serious — important, cautionary, a real problem, an alert',
  '  calm — steady and matter-of-fact, a gentle correction',
  '  neutral — plain information with no strong emotional color (the DEFAULT)',
  '',
  'Most replies are neutral — only pick another tone when the reply clearly carries it.',
  'Teasing, trash talk, or mock-outrage about a "bad" thing is playful, NOT serious —',
  'serious is reserved for genuine problems, warnings, and alerts.',
  'The intimate tones (flirty, sultry, tender, shy) are ONLY for a genuinely',
  'personal, affectionate, flirtatious, or bashful line — NEVER for routine',
  'information, scheduling, or logistics. When unsure, prefer warm or neutral.',
  'Examples:',
  '  "Great news — your order shipped early!" -> warm',
  '  "We did it — the release is live!" -> upbeat',
  '  "Handled. And I didn\'t even have to threaten anyone." -> playful',
  '  "Your team is losing to a twelve-year-old and I\'m never letting you forget it." -> playful',
  '  "It\'s 3 PM; you have two meetings today." -> neutral',
  '  "Your afternoon is clear." -> neutral',
  '  "Don\'t worry, I\'ve already rescheduled it for you." -> reassuring',
  '  "Heads up — your flight was just cancelled." -> serious',
  '  "Well aren\'t you charming today. Keep it up and I might blush." -> flirty',
  '  "Come here. It\'s just us — no meetings, no noise, just this." -> sultry',
  '  "Hey. I\'m proud of you. Truly — you carried a lot today." -> tender',
  '  "Oh — you noticed. I, um, wasn\'t sure you would." -> shy',
  '',
  'Reply with ONLY the one tone word. No punctuation, no explanation.',
].join('\n');

export function build_emotion_messages(reply_text: string, context?: string): LLMMessage[] {
  const ctx = (context || '').trim();
  // Context-aware per-sentence mode (2026-07-08): when the caller passes the FULL
  // reply as `context`, classify THIS sentence's tone GIVEN the whole reply. The
  // 1.5B misreads isolated fragments (a joke's punchline alone reads 'warm', its
  // setup 'serious'), so the surrounding reply is what disambiguates — the measured
  // fix for the per-sentence jitter. Falls back to the plain whole-reply prompt when
  // context is absent or identical to the text (turn-once / whole-reply callers).
  if (ctx && ctx !== reply_text.trim()) {
    return [
      { role: 'system', content: SYSTEM },
      {
        role: 'user',
        content:
          `The assistant's FULL spoken reply, for context only:\n${ctx.slice(0, 1200)}\n\n` +
          `Now label the delivery tone for THIS ONE sentence of that reply (judge it ` +
          `IN CONTEXT — a line can read differently alone than within the reply):\n` +
          `"${reply_text.slice(0, 400)}"\n\nTone (one word):`,
      },
    ];
  }
  return [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: `REPLY:\n${reply_text.slice(0, 600)}\n\nTone (one word):` },
  ];
}

/**
 * Classify `text`'s spoken tone → an `instruct` for the fine-tune, or '' on ANY
 * failure. UNGATED core — does NOT read HEARTH_VOICE_EMOTION, so a surface with
 * its OWN gate (the settable /stream path) can classify without the coordinator's
 * master switch being on. `infer_voice_emotion` is the gated wrapper.
 */
export async function classify_voice_emotion(
  text: string,
  llm: LLMRouter,
  context?: string,
): Promise<string> {
  const clean = (text || '').trim();
  if (!clean) return '';

  let role;
  try {
    role = llm.for_role('status_flavor');
  } catch {
    return '';
  }

  let resp;
  try {
    resp = await role.provider.complete({
      messages: build_emotion_messages(clean, context),
      // role.defaults FIRST so our low temperature wins — this is a deterministic
      // classification, not the status_flavor role's creative-phrase default (high temp).
      ...role.defaults,
      temperature: 0.1,
      max_tokens: 6,
      think: false,
      signal: AbortSignal.timeout(2500),
    });
  } catch {
    return '';
  }

  return instruct_for_tone(resp?.content ?? '');
}

/**
 * Gated wrapper (preserves the pre-refactor behavior of every existing caller —
 * /tts + /emotion, the Satellite1 coordinator path): '' unless HEARTH_VOICE_EMOTION
 * is on, otherwise the ungated classify.
 */
export async function infer_voice_emotion(
  text: string,
  llm: LLMRouter,
  context?: string,
): Promise<string> {
  if (!voice_emotion_enabled()) return '';
  return classify_voice_emotion(text, llm, context);
}

// ── Settable voice register (owner-chosen; /api/voice/stream + service mode) ──
//
// The owner can PIN Kate's spoken register (or leave it to the model) rather than
// only ever neutral. LAW #1: `auto` is the dynamic path (the model classifies each
// reply — once, from the joined sentences, the documented anti-jitter shape); a
// pinned tone is an explicit human choice, not the system working around the model.
// Persisted per-user in kv_settings under `voice_emotion:<user_id>`; default
// `neutral` (today's behavior). Read by `/api/voice/stream`; written by the web
// Settings picker and Kate's owner-only `set_voice_emotion` service-mode tool.

/** Every mode the backend accepts (the full tone set + neutral + auto). */
export const VOICE_EMOTION_MODES = [
  'neutral',
  'auto',
  'warm',
  'reassuring',
  'upbeat',
  'playful',
  'calm',
  'serious',
  'tender',
  'sultry',
  'flirty',
  'shy',
] as const;
export type VoiceEmotionMode = (typeof VOICE_EMOTION_MODES)[number];

/** The curated set surfaced in the pickers (owner A/B, 2026-07-14). Others stay
 *  accepted by the backend for a future picker expansion / a direct set. */
export const VOICE_EMOTION_PICKER: readonly VoiceEmotionMode[] = [
  'neutral',
  'auto',
  'warm',
  'playful',
  'tender',
  'sultry',
];

/** Intimate/character tones — owner-only to SET (defense-in-depth over the
 *  owner-gated write surfaces). Enforced in the setting route + the Kate tool. */
export const VOICE_EMOTION_INTIMATE: ReadonlySet<VoiceEmotionMode> = new Set([
  'tender',
  'sultry',
  'flirty',
  'shy',
]);

/** Human labels for the pickers. */
export const VOICE_EMOTION_LABELS: Record<VoiceEmotionMode, string> = {
  neutral: 'Neutral',
  auto: 'Auto — Kate reads the room',
  warm: 'Warm',
  reassuring: 'Reassuring',
  upbeat: 'Upbeat',
  playful: 'Playful',
  calm: 'Calm',
  serious: 'Serious',
  tender: 'Tender',
  sultry: 'Sultry',
  flirty: 'Flirty',
  shy: 'Shy',
};

export function is_voice_emotion_mode(v: unknown): v is VoiceEmotionMode {
  return typeof v === 'string' && (VOICE_EMOTION_MODES as readonly string[]).includes(v);
}

function voice_emotion_key(user_id: string): string {
  return `voice_emotion:${user_id}`;
}

/** The caller's pinned register, or 'neutral' (never throws — a bad row reads
 *  as neutral). `user_id` absent ⇒ neutral (no per-user pin to read). */
export function resolve_voice_emotion_mode(
  kv: KvSettings,
  user_id: string | undefined | null,
): VoiceEmotionMode {
  if (!user_id) return 'neutral';
  try {
    const row = kv.get<{ mode?: string }>(voice_emotion_key(user_id));
    const mode = row?.mode;
    return is_voice_emotion_mode(mode) ? mode : 'neutral';
  } catch {
    return 'neutral';
  }
}

/** Persist the caller's register. Validation/owner-gating is the caller's job. */
export function set_voice_emotion_mode(kv: KvSettings, user_id: string, mode: VoiceEmotionMode): void {
  kv.set(voice_emotion_key(user_id), { mode, updated: new Date().toISOString() });
}

/**
 * Resolve a mode → the ONE `instruct` applied to every segment of a reply
 * (never per-sentence — that's the jitter the 2026-07-10 A/B removed):
 *   - `neutral` (or anything unknown)     → '' (the fine-tune's neutral default)
 *   - a pinned tone                        → its rich descriptive instruct
 *   - `auto`                               → classify the WHOLE reply ONCE
 * `auto` needs `llm`; absent/failed ⇒ '' (fail-open to neutral).
 */
export async function instruct_for_mode(
  mode: VoiceEmotionMode,
  joined_reply: string,
  llm?: LLMRouter,
): Promise<string> {
  if (mode === 'neutral') return '';
  if (mode === 'auto') return llm ? classify_voice_emotion(joined_reply, llm) : '';
  return TONE_INSTRUCT[mode] ?? '';
}

/** Picker payload for the settings surfaces — the curated options, intimate ones
 *  filtered out for a non-owner so a non-owner can never even see/pick them. */
export function voice_emotion_options(is_owner: boolean): Array<{ value: VoiceEmotionMode; label: string; intimate: boolean }> {
  return VOICE_EMOTION_PICKER.filter((m) => is_owner || !VOICE_EMOTION_INTIMATE.has(m)).map((m) => ({
    value: m,
    label: VOICE_EMOTION_LABELS[m],
    intimate: VOICE_EMOTION_INTIMATE.has(m),
  }));
}
