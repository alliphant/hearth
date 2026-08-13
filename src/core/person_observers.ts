/**
 * person_observers — the AFFERENT feed for the People reasoning substrate (A+D,
 * 2026-06-22). The sibling of user_model_observers, but the subject is OTHER
 * people: thin, cheap observers that mine the exhaust the system already emits
 * into provenance-stamped `person_observations`, so the Friends layer keeps each
 * person current on its own. No LLM at intake (a deterministic, conservative
 * name match); the distill-to-facts pass is a later, threshold-gated slice.
 *
 * Wired to the AppEventBus, mirroring UserModelObserverDriver — one `attach`:
 *   - capture_received → cache capture_id → user_id (capture_routed carries none).
 *   - capture_routed   → name-match the capturing user's visible people in the
 *                        route_reason → a 'capture' observation (best-effort: the
 *                        event carries only the short reason, not the full VL/OCR;
 *                        a richer capture-text matcher is a v2 seam).
 *   - message_added (role=user) → name-match the conversation OWNER's visible
 *                        people in the message → a 'mention' observation,
 *                        DEBOUNCED per (conversation, person). The mention must
 *                        CARRY something: it keeps the (capped) sentence the name
 *                        appeared in, and records nothing at all when that
 *                        sentence isn't substantive (2026-07-26 — it used to
 *                        write the contentless literal "mentioned in
 *                        conversation", which was 40% of the live observation
 *                        table and pure noise downstream). Because the summary
 *                        now quotes the user's own words it is cordoned to the
 *                        SPEAKER, not to the mentioned person's household cordon.
 *
 * Contracts (all mirror user_model_observers):
 *   - DARK by default (HEARTH_PERSON_OBSERVERS=1) — every handler early-returns
 *     when off → pure no-op, byte-identical to today.
 *   - FAIL-OPEN + ISOLATED — a throwing handler is swallowed, never propagates to
 *     the emitter.
 *   - CORDONED — a user's signal only ever matches people THAT user can see, and
 *     the observation inherits the matched person's `private_to`. No cross-user
 *     reach. 'self' notes + genealogy are excluded (you're not your own friend).
 *   - DERIVED, CONSERVATIVE MATCH — full name + preferred name always; a bare
 *     first name only when it's UNIQUE among the user's people (never guess).
 *
 * The richer signals where friendships actually live (iMessage via the macOS
 * app's chat.db, Discord, presence/face 'visited', calendar) drop in as
 * additional cases here — the engine is signal-agnostic; this is the seam.
 */
import type { AppEventBus } from '@app/events';
import type { MemoryClient, PersonRow } from '@memory/client';
import type { Tier } from '@core/users';
import { note_visible_to_caller, parse_private_to, type Caller } from '@memory/private_to';
import { parse_fm, is_non_contact } from '@core/relationship_signals';
import { PersonObservations } from '@memory/stores/person_observations';

export function person_observers_enabled(): boolean {
  return process.env.HEARTH_PERSON_OBSERVERS === '1';
}
function env_ms(name: string, def: number): number {
  const n = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : def;
}

export interface PersonObserverDeps {
  observations: PersonObservations;
  memory: Pick<MemoryClient, 'query_people'>;
  /** Owner user_id of a conversation, or null if unattributable. */
  conversation_owner: (conversation_id: string) => string | null;
  /** Tier for a user (for the visibility cordon). Defaults to 'friend' inside. */
  tier_for: (user_id: string) => Tier;
  now?: () => Date;
}

const CAPTURE_CACHE_MAX = 500;

function escape_re(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const MENTION_SNIPPET_MAX = 200;

/** Is this fragment worth keeping as a signal, or is it "ok" / a bare name? The
 *  same structural shape the iMessage distill uses to reject ephemeral chatter. */
function is_substantive_fragment(text: string): boolean {
  const t = text.trim();
  return t.length >= 25 || t.split(/\s+/).filter(Boolean).length >= 5;
}

/**
 * The sentence a person's name appeared in, when it actually carries context —
 * else null (record nothing). Derived + capped: a snippet, never the message.
 * Exported for the smoke test.
 */
export function mention_snippet(content_preview: string, name_re: RegExp): string | null {
  const text = (content_preview ?? '').replace(/\s+/g, ' ').trim();
  if (!text) return null;
  // Sentence-ish split; the name's own sentence is the tightest honest context.
  const sentences = text.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean);
  const hit = sentences.find((s) => name_re.test(s));
  const candidate = hit && is_substantive_fragment(hit) ? hit : is_substantive_fragment(text) ? text : null;
  if (!candidate) return null;
  return candidate.length > MENTION_SNIPPET_MAX
    ? `${candidate.slice(0, MENTION_SNIPPET_MAX - 1).trimEnd()}…`
    : candidate;
}

interface Matcher {
  row: PersonRow;
  re: RegExp;
  private_to: string;
}

export class PersonObserverDriver {
  private readonly capture_users = new Map<string, string>();
  private readonly last_mention = new Map<string, number>();
  private readonly mention_debounce_ms: number;
  private readonly now: () => Date;

  constructor(private readonly deps: PersonObserverDeps) {
    this.now = deps.now ?? (() => new Date());
    this.mention_debounce_ms = env_ms('HEARTH_PERSON_OBSERVER_MENTION_DEBOUNCE_MS', 30 * 60_000);
  }

  attach(events: AppEventBus): () => void {
    return events.subscribe((e) => {
      try {
        if (e.type === 'capture_received') {
          this.remember_capture_user(e.capture_id, e.user_id);
        } else if (e.type === 'capture_routed') {
          this.observe_capture(e.capture_id, e.specialist_ids, e.route_reason);
        } else if (e.type === 'message_added' && e.role === 'user') {
          this.observe_mention(e.conversation_id, e.content_preview);
        }
      } catch {
        /* fail-open — an observer must never break the emit path */
      }
    });
  }

  /** Conservative matchers over the people a user can SEE (cordon-filtered).
   *  Full + preferred name always; first name only when unique. Excludes the
   *  user's own 'self' note + genealogy imports. */
  private matchers_for(user_id: string): Matcher[] {
    const caller: Caller = { user_id, tier: this.deps.tier_for(user_id) };
    const people = this.deps.memory
      .query_people({})
      .filter((p) => !is_non_contact(p))
      .filter((p) => note_visible_to_caller(parse_private_to(parse_fm(p.frontmatter_json).private_to), caller));

    const first_counts = new Map<string, number>();
    for (const p of people) {
      const first = p.name.trim().split(/\s+/)[0]?.toLowerCase();
      if (first) first_counts.set(first, (first_counts.get(first) ?? 0) + 1);
    }
    const out: Matcher[] = [];
    for (const p of people) {
      const private_to = (parse_fm(p.frontmatter_json).private_to as string) || 'household';
      const names = new Set<string>();
      if (p.name.trim()) names.add(p.name.trim());
      if (p.preferred_name && p.preferred_name.trim()) names.add(p.preferred_name.trim());
      const first = p.name.trim().split(/\s+/)[0];
      if (first && (first_counts.get(first.toLowerCase()) ?? 0) === 1) names.add(first);
      for (const n of names) out.push({ row: p, re: new RegExp(`\\b${escape_re(n)}\\b`, 'i'), private_to });
    }
    return out;
  }

  private remember_capture_user(capture_id: string, user_id: string): void {
    if (!person_observers_enabled() || !capture_id || !user_id) return;
    this.capture_users.delete(capture_id);
    this.capture_users.set(capture_id, user_id);
    while (this.capture_users.size > CAPTURE_CACHE_MAX) {
      const oldest = this.capture_users.keys().next().value;
      if (oldest === undefined) break;
      this.capture_users.delete(oldest);
    }
  }

  private observe_mention(conversation_id: string, content_preview: string): void {
    if (!person_observers_enabled() || !conversation_id || !content_preview) return;
    const user_id = this.deps.conversation_owner(conversation_id);
    if (!user_id) return; // unattributable — never guess
    const now_ms = this.now().getTime();
    const matched = new Set<string>();
    for (const m of this.matchers_for(user_id)) {
      if (matched.has(m.row.id) || !m.re.test(content_preview)) continue;
      matched.add(m.row.id);
      // The mention must CARRY something. A bare name-regex hit used to record
      // the literal string "mentioned in conversation" — on the live box that was
      // 62 of 153 observations: rows with no content, which then competed for the
      // synthesis prompt's slots and polluted its recurrence token-clustering with
      // nothing. Keep the sentence the name appeared in when it's substantive;
      // otherwise record NOTHING (a name with no context is not a signal).
      const snippet = mention_snippet(content_preview, m.re);
      if (!snippet) continue;
      const key = `${conversation_id}:${m.row.id}`;
      const last = this.last_mention.get(key) ?? 0;
      if (now_ms - last < this.mention_debounce_ms) continue;
      this.last_mention.set(key, now_ms);
      this.deps.observations.record({
        person_id: m.row.id,
        user_id,
        kind: 'mention',
        summary: `Came up in conversation: "${snippet}"`,
        source_type: 'chat',
        source_ref: conversation_id,
        confidence: 0.6,
        // Cordoned to the SPEAKER, not the person's household cordon: the summary
        // now quotes the user's own words, and one user's chat content is not the
        // household's to read just because a shared contact was named in it. Same
        // reasoning as the iMessage distill's uploader stamp. (Contentless
        // mentions carried nothing, so their looser cordon leaked nothing.)
        private_to: user_id,
        observed_at: this.now().toISOString(),
      });
    }
  }

  private observe_capture(capture_id: string, specialist_ids: string[], route_reason: string): void {
    if (!person_observers_enabled() || !capture_id) return;
    if (!specialist_ids || specialist_ids.length === 0) return; // triage capture — no signal
    const user_id = this.capture_users.get(capture_id);
    if (!user_id) return; // cache miss (e.g. after a restart) — skip, never guess
    const reason = (route_reason ?? '').trim();
    if (!reason) return;
    const matched = new Set<string>();
    for (const m of this.matchers_for(user_id)) {
      if (matched.has(m.row.id) || !m.re.test(reason)) continue;
      matched.add(m.row.id);
      this.deps.observations.record({
        person_id: m.row.id,
        user_id,
        kind: 'capture',
        summary: `appeared in a capture: ${reason.replace(/\s+/g, ' ').slice(0, 160)}`,
        source_type: 'capture',
        source_ref: capture_id,
        confidence: 0.5,
        private_to: m.private_to,
        observed_at: this.now().toISOString(),
      });
    }
  }
}
