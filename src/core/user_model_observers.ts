/**
 * user_model_observers — the AFFERENT feed for the unified per-user model
 * (src/core/user_model.ts, design doc Layer 1). Thin observers that mine the
 * exhaust the system already emits into cheap dated `record_observation` calls.
 * No LLM at intake; the only LLM cost is the nightly threshold-gated synthesis.
 *
 * Wired to the AppEventBus, mirroring LiveSynthesisDriver — one `attach`:
 *   - capture_received → cache capture_id → user_id (captures route a moment
 *     later; capture_routed itself carries no user).
 *   - capture_routed   → an INTERESTS observation for the capturing user. A
 *     routed capture is a sparse, already-derived signal of what they care
 *     about (they bothered to capture it; the classifier already picked the
 *     domain). Free — no inference here.
 *   - message_added (role=user) → a ROUTINES observation ("active <dow> <hh:mm>"
 *     in the user's tz). DEBOUNCED per conversation so a chat session yields one
 *     observation, not one per message — keeps it sparse, and keeps the common
 *     path a Map lookup (no DB) so the chat emit path isn't taxed.
 *
 * Contracts (all mirror the design's cheap disciplines):
 *   - DARK by default (HEARTH_USER_MODEL=1) — every handler early-returns when
 *     off, so the driver is a pure no-op (byte-identical to today).
 *   - FAIL-OPEN + ISOLATED — each handler is wrapped; a throw is swallowed and
 *     never propagates to the emitter (the bus also try/catches per listener).
 *   - CORDONED — an interests observation lands on the CAPTURING user; a routines
 *     observation on the conversation OWNER. No cross-user reach, ever.
 *   - DERIVED FACTS ONLY — a routing decision, an activity timestamp; never a
 *     raw stream.
 *
 * Dependency-injected (FacetStore + two lookups + a clock) so it's pure to test;
 * the orchestrator wires the real UserProfileStore, ConversationStore owner
 * lookup, and UserRegistry timezone resolver.
 */
import type { AppEventBus } from '@app/events';
import { record_observation, user_model_enabled, type FacetStore } from '@core/user_model';
import { local_dow, local_hhmm } from '@core/time';

function env_ms(name: string, def: number): number {
  const n = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : def;
}

export interface UserModelObserverDeps {
  facets: FacetStore;
  /** Owner user_id of a conversation, or null if unattributable. */
  conversation_owner: (conversation_id: string) => string | null;
  /** IANA timezone for a user (defaults to the household tz inside the impl). */
  timezone_for: (user_id: string) => string;
  /** Injectable clock for deterministic tests. */
  now?: () => Date;
}

/** Cap on the capture_id → user_id correlation cache (FIFO eviction). */
const CAPTURE_CACHE_MAX = 500;

export class UserModelObserverDriver {
  /** capture_id → capturing user_id, populated on capture_received. */
  private readonly capture_users = new Map<string, string>();
  /** conversation_id → last routines-observation epoch_ms (debounce). */
  private readonly last_routine = new Map<string, number>();
  private readonly routine_debounce_ms: number;
  private readonly now: () => Date;

  constructor(private readonly deps: UserModelObserverDeps) {
    this.now = deps.now ?? (() => new Date());
    this.routine_debounce_ms = env_ms('HEARTH_USER_MODEL_ROUTINE_DEBOUNCE_MS', 30 * 60_000);
  }

  /** Subscribe to the exhaust streams. Returns the unsubscribe fn. */
  attach(events: AppEventBus): () => void {
    return events.subscribe((e) => {
      try {
        if (e.type === 'capture_received') {
          this.remember_capture_user(e.capture_id, e.user_id);
        } else if (e.type === 'capture_routed') {
          this.observe_capture_interest(e.capture_id, e.specialist_ids, e.route_reason);
        } else if (e.type === 'message_added' && e.role === 'user') {
          this.observe_message_routine(e.conversation_id);
        }
      } catch {
        /* fail-open — an observer must never break the emit path */
      }
    });
  }

  private remember_capture_user(capture_id: string, user_id: string): void {
    if (!user_model_enabled()) return;
    if (!capture_id || !user_id) return;
    // Refresh recency: delete+set moves it to the tail (newest).
    this.capture_users.delete(capture_id);
    this.capture_users.set(capture_id, user_id);
    while (this.capture_users.size > CAPTURE_CACHE_MAX) {
      const oldest = this.capture_users.keys().next().value;
      if (oldest === undefined) break;
      this.capture_users.delete(oldest);
    }
  }

  private observe_capture_interest(
    capture_id: string,
    specialist_ids: string[],
    route_reason: string,
  ): void {
    if (!user_model_enabled()) return;
    // Below-threshold/triage captures (no specialist) carry no interest signal.
    if (!specialist_ids || specialist_ids.length === 0) return;
    const user_id = this.capture_users.get(capture_id);
    if (!user_id) return; // unattributable (e.g. cache miss after a restart)
    const reason = (route_reason ?? '').trim().replace(/\s+/g, ' ').slice(0, 200);
    const text = `captured something for ${specialist_ids.join(', ')}${reason ? `: ${reason}` : ''}`;
    record_observation(this.deps.facets, user_id, 'interests', text, this.now());
  }

  private observe_message_routine(conversation_id: string): void {
    if (!user_model_enabled()) return;
    if (!conversation_id) return;
    // Debounce by conversation BEFORE any DB work — the common case (another
    // message in an active session) is a Map lookup, no owner resolution.
    const now_ms = this.now().getTime();
    const last = this.last_routine.get(conversation_id) ?? 0;
    if (now_ms - last < this.routine_debounce_ms) return;
    const user_id = this.deps.conversation_owner(conversation_id);
    if (!user_id) return; // unattributable conversation — skip, never guess
    this.last_routine.set(conversation_id, now_ms);
    const now = this.now();
    const tz = this.deps.timezone_for(user_id);
    record_observation(
      this.deps.facets,
      user_id,
      'routines',
      `active ${local_dow(now, tz)} ${local_hhmm(now, tz)}`,
      now,
    );
  }
}
