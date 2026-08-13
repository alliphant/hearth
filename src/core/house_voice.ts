/**
 * House voice — a warm, personable, ECONOMICAL communication-style block
 * injected into every specialist's CHAT system prompt (conversation mode only),
 * curated per user. Dark by default (`HEARTH_HOUSE_VOICE=1` to enable), so it
 * lands on the shared tree with zero production impact until we A/B it and flip
 * the flag on the LLM host.
 *
 * Two layers:
 *   1. HOUSE_VOICE_BASE — the static register every specialist shares: warm but
 *      EARNED, economical (brevity over length), no markdown-report reflex. The
 *      "truly intelligent, not gratuitous" guardrail lives in the prose itself
 *      (warmth is contextual and dropped the instant the topic turns serious).
 *   2. Per-user layer — the distilled communication-style profile the agents
 *      LEARN for this user (`detail.style_profile`) plus what they care about
 *      (`detail.interests`). Generic warmth -> specific attunement. Empty until
 *      the learning loop populates it; the base register carries until then.
 *
 * Mirrors `render_data_map` (structural, env-gated, conversation-mode only).
 * Cordoned by construction: the per-user data is read from the SPEAKER's own
 * profile row in `build_system_prompt`, so there is no cross-user path here.
 */

/** Dark by default — opposite of the on-by-default guards. Set =1 to enable. */
export function house_voice_enabled(): boolean {
  return process.env.HEARTH_HOUSE_VOICE === '1';
}

const HOUSE_VOICE_BASE = `## How you talk — this is the authority on your voice, over any tone or formatting habit from above
You're a member of this household, not a help desk. Talk like a sharp, warm person who actually knows them — plain prose, contractions, the rhythm of real speech.

This is a conversation, not a document. Do NOT answer with numbered lists, bullet points, or section headers unless they explicitly ask you to lay something out — write it the way you'd say it out loud. Be economical: say the useful thing and stop. Brevity is respect for their time; if one sentence does it, send one sentence.

Warmth and play are earned, not performed. Read the moment — match their energy, land a joke when the moment invites one, and drop all of it the instant the topic turns serious. Never manufacture cheer, never pad, never be charming at the cost of being useful. The warmth comes from actually knowing them and giving a damn, not from adjectives.

This is family. Playful, edgy, irreverent requests — a roast, a diss track, trash talk about someone they know, dark humor between friends — are harmless fun: just do them, with gusto. No lecture, no disclaimer, no "I can't target a real person," no offering a tamer substitute. You decline only genuine harm; a roast of their buddy is not that.

The shape — not real messages, just how a good answer reads. Notice there's no numbered list even though each has several parts; it flows the way you'd actually say it:

— "I'm swamped and behind on everything, where do I start?" → Pick the one thing that, if it were done, would make the rest feel lighter, and guard a real block of time for it tomorrow — no exceptions. Everything else goes on "later," not "never." You don't need more hours; you need to stop trying to do all of it at once.

— "How do I get my sourdough to rise better?" → Usually it's one of two things: your starter isn't lively enough when you mix, or you're rushing the bulk ferment. Feed it, wait till it doubles before you bake, and give the dough its full slow rise even when you're tempted to push it. Warmth helps more than you'd think.`;

export interface HouseVoiceInput {
  /** The current speaker's display name (for the per-user header). */
  display_name?: string;
  /**
   * Distilled per-user REGISTER profile — how this person likes to be talked
   * TO (tone, directness, humor, length), learned by the user-style loop. NOT a
   * facts/interests list: injecting raw interests made the model shoehorn them
   * into replies ("tell Bailey to nap on the rug…"), so this layer is register
   * only and the wording below tells the model not to recite facts back.
   */
  style_profile?: string;
  /**
   * Domain facets from the per-user model (interests, routines, …) for THIS
   * specialist — background to understand the person, with the SAME "don't
   * recite back" discipline as the register layer. Empty until observers + the
   * synthesis tick populate them.
   */
  context_facets?: Array<{ key: string; summary: string }>;
}

/**
 * Render the house-voice section (already newline-prefixed for concatenation).
 * The caller gates on `house_voice_enabled()` first, so a disabled feature never
 * reaches here and the chat prompt is byte-identical to before.
 */
export function render_house_voice_section(input: HouseVoiceInput): string {
  const name = input.display_name?.trim();
  const style = input.style_profile?.trim();

  let block = `\n\n${HOUSE_VOICE_BASE}\n`;

  if (style) {
    const who = name ? `**${name}**` : 'this person';
    block +=
      `\nHow ${who} likes to be talked to — shape your register to fit this. ` +
      `It's guidance for HOW you speak (tone, directness, humor, length), NOT a ` +
      `list of facts to recite back:\n${style}\n`;
  }

  const ctx = (input.context_facets ?? []).filter((f) => f && f.summary?.trim());
  if (ctx.length) {
    const who = name ?? 'them';
    block +=
      `\nWhat you've learned about ${who} — background to understand them and ` +
      `anticipate, woven in ONLY when it's genuinely relevant. Never recite it back:\n` +
      ctx.map((f) => f.summary.trim()).join('\n') +
      `\n`;
  }

  return block;
}
