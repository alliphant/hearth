/**
 * Per-user style learning loop — the "curated per user" half of the house voice
 * (house_voice.ts). Generalizes Kate's jasper-only observe/distill loop to ANY
 * user, produces a REGISTER profile (how they like to be talked TO — tone,
 * directness, humor, length), and stores it where the chat prompt reads it.
 *
 * Register, NOT facts: the A/B showed that injecting raw interests made the
 * model shoehorn them into replies. So the distill prompt is hard-scoped to
 * communication register; salient topics may inform register ("he's deep in
 * home-automation, so technical detail lands") but never as a list to recite.
 *
 * Contracts:
 *   - DARK by default (HEARTH_USER_STYLE_LEARN=1). The sweep is a no-op when off.
 *   - FAIL-OPEN everywhere: no messages, an LLM error, or an empty distill =>
 *     the prior profile is preserved and the turn is never blocked.
 *   - CORDONED: writes the distilled profile to the user's OWN profile row (DB,
 *     for hot-path injection) + a `users/<id>/style_profile.md` note stamped
 *     `private_to` that user. Callers pass the subject's own user_id.
 *
 * Dependency-injected (StyleMemory / StyleLLM / message source) so it's pure to
 * test; the orchestrator wires the real MemoryClient, LLM router, and the
 * per-user message query (conversations.list_user_messages_since with user_id).
 */

export function user_style_learning_enabled(): boolean {
  return process.env.HEARTH_USER_STYLE_LEARN === '1';
}

export interface StyleMessage {
  ts: string;
  content_md: string;
}

interface StyleLLMRole {
  provider: {
    complete(req: {
      messages: Array<{ role: string; content: string }>;
      temperature?: number;
    }): Promise<{ content: string; cost?: { model?: string } }>;
  };
  defaults: { temperature?: number };
}
export interface StyleLLM {
  for_role(role: string): StyleLLMRole;
}

export interface StyleMemory {
  get_user_profile(user_id: string): { detail?: Record<string, unknown> } | null;
  set_user_style_profile(user_id: string, style_profile: string): void;
  upsert_note(rel_path: string, frontmatter: Record<string, unknown>, body: string): void;
}

export interface UserStyleDeps {
  /** Recent messages THIS user wrote since the given instant. */
  recent_user_messages: (user_id: string, since_iso: string, max: number) => StyleMessage[];
  memory: StyleMemory;
  llm: StyleLLM;
}

export interface LearnOptions {
  now: Date;
  lookback_hours?: number;
  max_messages?: number;
  min_chars?: number;
}

export interface LearnResult {
  user_id: string;
  messages_scanned: number;
  updated: boolean;
  profile_chars: number;
  reason?: 'no_messages' | 'llm_error' | 'empty_profile';
  model?: string;
}

const DEFAULT_LOOKBACK_HOURS = 24 * 14;
const DEFAULT_MAX_MESSAGES = 200;
const DEFAULT_MIN_CHARS = 30;
const MAX_PROMPT_CHARS = 40_000;
const MAX_PROFILE_CHARS = 1_200;

const DISTILL_SYSTEM = `You distill how a specific person likes to be COMMUNICATED WITH, from a sample of messages they wrote. Output a short profile (3–6 sentences, plain prose, no headers, no lists) that a teammate could read and instantly adjust their tone.

Describe their RECEIVING preferences only: directness vs. cushioning, how terse or expansive they want replies, humor/playfulness (dry? none? profanity-comfortable?), formality, and emotional register. A salient topic may inform register (e.g. "deep in a technical project, so detail lands") but is context for HOW to talk — never a list of facts or interests to mention back.

Rules:
- Infer only from evidence in the sample. If it's thin, say what little is supported and stop. Never invent.
- This is about register, not content. Do not output things-they-like as items to recite.
- A prior profile may be given; refine it, don't discard what still holds.
- Output ONLY the profile prose — no preamble, no "Here is", no markdown fences.`;

function build_payload(messages: StyleMessage[], prior: string): string {
  const parts: string[] = [];
  parts.push('## prior_profile');
  parts.push(prior.trim().length > 0 ? prior.trim() : '(empty — first run)');
  parts.push('');
  parts.push('## messages_they_wrote');
  let total = 0;
  for (const m of messages) {
    const block = `- ${m.content_md.trim()}\n`;
    if (total + block.length > MAX_PROMPT_CHARS) break;
    parts.push(block);
    total += block.length;
  }
  return parts.join('\n');
}

/** Strip code fences / "Here is..." preambles a small model sometimes adds. */
function sanitize_profile(raw: string): string {
  let text = (raw ?? '').trim();
  const fence = text.match(/```(?:\w+)?\s*([\s\S]*?)\s*```/);
  if (fence) text = fence[1]!.trim();
  text = text.replace(/^(here(?:'s| is)[^\n:]*:?\s*)/i, '').trim();
  if (text.length > MAX_PROFILE_CHARS) text = text.slice(0, MAX_PROFILE_CHARS).trim() + '…';
  return text;
}

/**
 * Learn (or refine) one user's register profile and persist it. FAIL-OPEN: any
 * shortfall (no messages, LLM error, empty distill) leaves the prior profile
 * untouched and returns a `reason` instead of throwing.
 */
export async function learn_user_style(
  user_id: string,
  deps: UserStyleDeps,
  opts: LearnOptions,
): Promise<LearnResult> {
  const lookback = opts.lookback_hours ?? DEFAULT_LOOKBACK_HOURS;
  const since = new Date(opts.now.getTime() - lookback * 3_600_000).toISOString();
  const max = opts.max_messages ?? DEFAULT_MAX_MESSAGES;
  const min_chars = opts.min_chars ?? DEFAULT_MIN_CHARS;

  let msgs: StyleMessage[];
  try {
    msgs = deps.recent_user_messages(user_id, since, max);
  } catch {
    msgs = [];
  }
  msgs = (msgs ?? []).filter((m) => (m?.content_md ?? '').trim().length >= min_chars);
  if (msgs.length === 0) {
    return { user_id, messages_scanned: 0, updated: false, profile_chars: 0, reason: 'no_messages' };
  }

  let prior = '';
  try {
    const sp = deps.memory.get_user_profile(user_id)?.detail?.['style_profile'];
    if (typeof sp === 'string') prior = sp;
  } catch {
    /* prior is best-effort */
  }

  let content: string;
  let model: string | undefined;
  try {
    const role = deps.llm.for_role('planner');
    const resp = await role.provider.complete({
      messages: [
        { role: 'system', content: DISTILL_SYSTEM },
        { role: 'user', content: build_payload(msgs, prior) },
      ],
      temperature: role.defaults.temperature,
    });
    content = resp.content ?? '';
    model = resp.cost?.model;
  } catch {
    return { user_id, messages_scanned: msgs.length, updated: false, profile_chars: 0, reason: 'llm_error' };
  }

  const profile = sanitize_profile(content);
  if (!profile) {
    return { user_id, messages_scanned: msgs.length, updated: false, profile_chars: 0, reason: 'empty_profile' };
  }

  // DB row (hot-path read) — source of truth for chat-turn injection.
  deps.memory.set_user_style_profile(user_id, profile);
  // Cordoned narrative note — best-effort; the DB write above already landed.
  try {
    deps.memory.upsert_note(
      `users/${user_id}/style_profile.md`,
      { private_to: user_id, type: 'user_profile', last_distilled: opts.now.toISOString(), model: model ?? '' },
      profile,
    );
  } catch {
    /* note is best-effort; DB is what the prompt reads */
  }

  return { user_id, messages_scanned: msgs.length, updated: true, profile_chars: profile.length, model };
}

/**
 * Sweep a set of users (e.g. the active roster), refreshing each register
 * profile. No-op when the feature is off. Per-user failures are isolated — one
 * user's error never aborts the sweep.
 */
export async function run_user_style_sweep(
  user_ids: string[],
  deps: UserStyleDeps,
  opts: LearnOptions,
): Promise<LearnResult[]> {
  if (!user_style_learning_enabled()) return [];
  const out: LearnResult[] = [];
  for (const uid of [...new Set(user_ids.filter(Boolean))]) {
    try {
      out.push(await learn_user_style(uid, deps, opts));
    } catch {
      out.push({ user_id: uid, messages_scanned: 0, updated: false, profile_chars: 0, reason: 'llm_error' });
    }
  }
  return out;
}
