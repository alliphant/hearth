/**
 * kate_line — Kate authors the line (the last clinical surfaces, 2026-07-03).
 *
 * Push notifications arrive under Kate's name but are TEMPLATE STRINGS no
 * persona can touch — the "robotic/clinical" residue after the chat_style /
 * house-voice work. This is the voice pass at the ONE delivery funnel every
 * push flows through (`deliver_or_queue` in src/policy/push.ts): a
 * notification about to go out is rewritten into Kate's register by the deep
 * tier, with the SAFETY split done the only trustworthy way —
 *
 *   - the MODEL owns only the voice;
 *   - CODE owns the exemptions and the fact check.
 *
 * Deterministic exemptions (never voiced, byte-exact): severity 'high'
 * (dangerous-weather / air-quality / EAS-class — an alarm's wording is part
 * of its function), 'approval_request' (approve/deny semantics + amounts),
 * and 'test' pushes (must be recognizable as tests).
 *
 * Deterministic fact guard: every digit sequence in the original (times,
 * amounts, dates, counts) must appear VERBATIM in the rewrite, the rewrite
 * must stay notification-length, and any miss falls back to the original
 * template — so the worst case of a bad model day is the exact push you get
 * today. Fail-open everywhere; DARK behind HEARTH_KATE_LINES.
 */
import type { LLMRouter, LLMMessage } from './llm';

export function kate_lines_enabled(): boolean {
  return process.env.HEARTH_KATE_LINES === '1';
}

/** Kinds/severities that must NEVER be re-voiced. Exported for the smoke. */
export function is_voice_exempt(ctx: { kind?: string; severity?: string }): boolean {
  if (ctx.severity === 'high') return true;
  return ctx.kind === 'approval_request' || ctx.kind === 'test';
}

/** All digit runs (times, amounts, dates, counts) — the facts the rewrite
 *  must carry verbatim. "7:30", "55.04", "2026-07-10" each extract intact. */
function digit_runs(text: string): string[] {
  return text.match(/\d+(?:[.,:\/-]\d+)*/g) ?? [];
}

/** Deterministic acceptance check — CODE decides whether the model's rewrite
 *  is safe to ship. Exported for the smoke. */
export function rewrite_acceptable(original: string, rewrite: string): boolean {
  const r = rewrite.trim();
  if (r.length < 8) return false;
  if (r.length > Math.max(240, Math.ceil(original.length * 1.6))) return false;
  if (r.includes('```') || r.includes('\n#')) return false;
  for (const run of digit_runs(original)) {
    if (!r.includes(run)) return false;
  }
  return true;
}

function build_messages(text: string, display_name: string | undefined): LLMMessage[] {
  const who = display_name?.trim() || 'the owner';
  // NO "return verbatim if already fine" escape hatch: given a do-nothing
  // option the 35B takes it every time (live-verified 2026-07-03 — templates
  // came back byte-identical), and the fact guard already makes an
  // unnecessary rewrite harmless. Exemplar SHAPE pairs, not adjectives —
  // the register lesson from voice_style/chat_style, applied here.
  return [
    {
      role: 'system',
      content: [
        `You are Kate — the household's chief of staff: dry, warm, specific,`,
        `plain prose. A machine wrote the notification below; it is about to`,
        `be sent to ${who} under YOUR name. Rewrite it so it sounds like you`,
        `— a sharp person who runs the place, not a status console.`,
        '',
        'HARD RULES:',
        '- Keep every fact EXACTLY: every number, name, date, time, amount.',
        '  You may not add, drop, or alter a single fact.',
        '- Numbers stay as DIGITS exactly as written ("1 restart", not "one',
        '  restart"; "0%", not "zero percent").',
        '- Do NOT keep the machine\'s sentence structure — say it the way',
        '  you\'d actually text him.',
        '- One or two short sentences — it is a phone notification.',
        '- No emoji unless the original has one. No markdown. No preamble.',
        '',
        'The shape (machine line → your line):',
        '- "Package delivered: front porch, 3:42 PM." →',
        '  "Your package hit the porch at 3:42 PM."',
        '- "Dependency searxng recovered after 2 restarts." →',
        '  "Search engine\'s back — took 2 kicks, but it\'s behaving."',
        '- "Reminder: appointment tomorrow 9:00 AM." →',
        '  "Don\'t forget — you\'ve got the 9:00 AM tomorrow."',
        '',
        'Reply with ONLY the rewritten notification text.',
      ].join('\n'),
    },
    { role: 'user', content: text },
  ];
}

/**
 * The voice pass. Returns the text to actually deliver — the rewrite when the
 * gate is on, the context is non-exempt, and the rewrite passes the fact
 * guard; otherwise the ORIGINAL, always. Never throws.
 */
export async function apply_kate_voice(
  llm: LLMRouter | undefined,
  text: string,
  ctx: { kind?: string; severity?: string },
  display_name?: string,
): Promise<string> {
  if (!kate_lines_enabled()) return text;
  if (!llm) return text;
  const original = (text ?? '').trim();
  if (original.length < 12) return text; // too short to be worth a model call
  if (is_voice_exempt(ctx)) return text;

  let role;
  try {
    role = llm.for_role('planner');
  } catch {
    return text;
  }
  try {
    const resp = await role.provider.complete({
      messages: build_messages(original, display_name),
      ...role.defaults,
      temperature: 0.6,
      max_tokens: 220,
      think: false,
      signal: AbortSignal.timeout(8000),
    });
    const rewrite = (resp?.content ?? '').trim().replace(/^["'`]+|["'`]+$/g, '');
    return rewrite_acceptable(original, rewrite) ? rewrite : text;
  } catch {
    return text;
  }
}
