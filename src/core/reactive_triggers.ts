/**
 * reactive_triggers — event-driven specialist waking (2026-06-18).
 *
 * Specialists react to the world on a fixed clock today (`deliberation_at`):
 * ~28 scheduled deep-tier passes/day, most of them domain *polls* that fire as
 * a 07:00 burst. This layer lets a deliberation fire on the EDGE of a real
 * state change instead — a location flip, a routed capture, a domain threshold
 * crossing — so the system reacts the moment something happens.
 *
 * It generalizes the existing `LoopDriver.wake_deliberation` (today only
 * inbox-flag-driven) the same way `LiveSynthesisDriver` generalized the nightly
 * distill: subscribe to the `AppEventBus`, and on a matching event fire a
 * debounced, rate-limited, deep-tier scoped wake.
 *
 * Shape:
 *  - A `TriggerDef` owns the typed matching + EDGE detection for one kind of
 *    world change (no YAML expression eval). It runs ONCE per event (the edge is
 *    a world fact); the wake then fans out to every specialist whose YAML
 *    `proactive.triggers` subscribes to that def — each with its own scoped
 *    `task`. So two specialists subscribing to `home_arrival` share one edge but
 *    get two scoped passes.
 *  - The driver holds per-def edge state (the predicate's last value) so a level
 *    (still-true) doesn't re-fire. The per-(specialist, key) debounce +
 *    min-interval backstop lives in `wake_deliberation_scoped`.
 *
 * Fail-open: a throwing def is logged and skipped, never propagated (the
 * LiveSynthesis contract). Kill switch HEARTH_REACTIVE_TRIGGERS=0 → `attach` is
 * a no-op → byte-identical to today. Triggers default to `[]`, so the whole
 * roster is unchanged until a YAML opts in.
 */
import type { AppEvent, AppEventBus } from '@app/events';
import type { MemoryClient } from '@memory/client';
import type { SpecialistRegistry } from './specialist';
import { classify_home_transition, type HomeAnchorResolver } from './home_anchor';

export function reactive_triggers_enabled(): boolean {
  return process.env.HEARTH_REACTIVE_TRIGGERS !== '0';
}

/** What a TriggerDef may read to evaluate an edge. Kept minimal on purpose —
 *  a def reads stores it needs (the location packet, a ledger), nothing more. */
export interface TriggerDeps {
  memory: MemoryClient;
  /**
   * Resolves a user's home coordinates (`UserRegistry.home_coords`). REQUIRED,
   * not optional: the home defs decide home-ness from coordinates, and an
   * optional dep is exactly how the original `place_id`-only bug stayed
   * invisible for a month — every construction site should have to think about
   * the anchor. Return null when a user genuinely has none; the defs then fall
   * back to the `place_id` geofence path and log the degradation once.
   */
  home_anchor: HomeAnchorResolver;
}

/** The fire mechanism the driver depends on. `LoopDriver` satisfies it; tests
 *  pass a spy. Decouples the driver from the LoopDriver for testability (the
 *  `SynthesizeFn` pattern in live_synthesis.ts). */
export interface ScopedWaker {
  wake_deliberation_scoped(
    specialist_id: string,
    opts: {
      task: string;
      reason: string;
      dedupe_key: string;
      debounce_ms?: number;
      min_interval_ms?: number;
    },
  ): void;
}

export interface TriggerFire {
  /** Scopes the wake (and its min-interval key), e.g. `home_arrival:<user>`. */
  dedupe_key: string;
  /** Human-readable edge description; becomes the woken pass's "What happened". */
  reason: string;
}

export interface TriggerDef {
  /** Matches a specialist subscription's `def:`. */
  name: string;
  /** Which bus events this def inspects. */
  event_types: ReadonlyArray<AppEvent['type']>;
  /**
   * Detect whether this event causes a false→true WORLD edge for this def.
   * Returns a TriggerFire on the edge, else null. MUST edge-detect using
   * `state` (the def's own persistent map) so a level — a condition that stays
   * true — does not re-fire. Pure given (event, deps, state). Runs once per
   * event regardless of how many specialists subscribe.
   */
  detect(event: AppEvent, deps: TriggerDeps, state: Map<string, unknown>): TriggerFire | null;
}

export interface ReactiveTriggerDriverDeps {
  specialists: SpecialistRegistry;
  waker: ScopedWaker;
  trigger_deps: TriggerDeps;
  /** TriggerDefs to register. Defaults to BUILTIN_TRIGGER_DEFS. */
  defs?: ReadonlyArray<TriggerDef>;
}

export class ReactiveTriggerDriver {
  private readonly defs_by_event = new Map<string, TriggerDef[]>();
  private readonly state_by_def = new Map<string, Map<string, unknown>>();

  constructor(private readonly deps: ReactiveTriggerDriverDeps) {
    for (const def of deps.defs ?? BUILTIN_TRIGGER_DEFS) {
      this.state_by_def.set(def.name, new Map());
      for (const et of def.event_types) {
        const arr = this.defs_by_event.get(et) ?? [];
        arr.push(def);
        this.defs_by_event.set(et, arr);
      }
    }
  }

  /**
   * Subscribe to the event bus. Returns the unsubscribe fn. When the kill
   * switch is off, this is a no-op (returns a no-op unsubscribe) so the system
   * is byte-identical to pre-trigger behavior.
   */
  attach(events: AppEventBus): () => void {
    if (!reactive_triggers_enabled()) {
      console.log('[reactive-triggers] disabled (HEARTH_REACTIVE_TRIGGERS=0) — no triggers attached');
      return () => {};
    }
    // Self-evidencing boot line: confirm the driver is wired and how much it's
    // watching (registered defs + how many specialist subscriptions reference
    // them), mirroring the loop driver's per-loop boot logs.
    const def_names = [...this.state_by_def.keys()];
    const sub_count = this.deps.specialists
      .list()
      .reduce((n, s) => n + (s.proactive.triggers?.length ?? 0), 0);
    console.log(
      `[reactive-triggers] attached: ${def_names.length} def(s) [${def_names.join(', ')}], ` +
        `${sub_count} subscription(s) across the roster`,
    );
    return events.subscribe((e) => this.on_event(e));
  }

  /**
   * Process one event: for each def inspecting this event type, detect the
   * world edge ONCE, then fan the wake out to every specialist subscribed to
   * that def with that specialist's scoped task. Fail-open at both layers — a
   * throwing def or waker is logged and skipped, never propagated to the bus.
   */
  private on_event(event: AppEvent): void {
    const defs = this.defs_by_event.get(event.type);
    if (!defs || defs.length === 0) return;
    for (const def of defs) {
      let fired: TriggerFire | null = null;
      try {
        fired = def.detect(event, this.deps.trigger_deps, this.state_by_def.get(def.name)!);
      } catch (err) {
        console.error(`[reactive-triggers] def ${def.name} detect threw:`, err);
        continue;
      }
      if (!fired) continue;
      for (const s of this.deps.specialists.list()) {
        for (const sub of s.proactive.triggers ?? []) {
          if (sub.def !== def.name) continue;
          try {
            this.deps.waker.wake_deliberation_scoped(s.id, {
              task: sub.task,
              reason: fired.reason,
              dedupe_key: fired.dedupe_key,
              ...(sub.debounce_ms ? { debounce_ms: sub.debounce_ms } : {}),
              ...(sub.min_interval_ms ? { min_interval_ms: sub.min_interval_ms } : {}),
            });
          } catch (err) {
            console.error(`[reactive-triggers] wake ${s.id} via ${def.name} failed:`, err);
          }
        }
      }
    }
  }
}

// ── Built-in TriggerDefs ────────────────────────────────────────────────────

/**
 * Shared home/away edge detector for the location-driven triggers. iOS posts a
 * location packet (signal=location) on a region/visit transition; the driver
 * re-reads the latest packet (the bus carries only a pointer) and hands it to
 * `classify_home_transition` — the ONE definition of home-ness, shared with
 * `compute_is_home` (sensors.ts) and `resolve_presence` (delivery_window.ts).
 *
 * Home-ness is decided from the packet's COORDINATES against the user's
 * configured home anchor, with the geofence `place_id` as a fast path. It used
 * to be decided from `place_id` alone, which live iOS payloads never send — so
 * this detector could not fire, ever (see home_anchor.ts for the full autopsy).
 *
 * Each def owns its own per-def `state` map, so arrival and departure track
 * home/away independently; `want` selects which edge this def fires on. Always
 * records the current state (so the opposite edge re-arms) and fires only on a
 * transition INTO `want`.
 */
function detect_home_edge(
  event: AppEvent,
  deps: TriggerDeps,
  state: Map<string, unknown>,
  want: 'home' | 'away',
): TriggerFire | null {
  if (event.type !== 'sensor_packet_received') return null;
  if (event.signal !== 'location') return null;
  const user_id = event.user_id;
  const packet = deps.memory.query_latest_location_packet(user_id);
  if (!packet) return null;

  const anchor = deps.home_anchor(user_id);
  if (!anchor) warn_anchor_missing_once(state, user_id);

  const t = classify_home_transition(packet.payload, anchor);
  if (!t) return null; // significant_change / a departure from elsewhere — no transition

  const state_key = `home:${user_id}`;
  const prev = state.get(state_key) as 'home' | 'away' | undefined;
  state.set(state_key, t.presence); // always track current state (the other edge re-arms)
  if (t.presence !== want || prev === want) return null; // not our edge, or a level not an edge

  const who = user_id.charAt(0).toUpperCase() + user_id.slice(1);
  const how = t.via === 'place_id' ? t.event_kind : `${t.event_kind}, ${Math.round(t.distance_m ?? 0)}m from home`;
  if (want === 'home') {
    return { dedupe_key: `home_arrival:${user_id}`, reason: `${who} just arrived home (${how}).` };
  }
  // Word the departure honestly: an arrival somewhere ELSE also means the house
  // is now empty, but saying "just left home" about it would be a fabrication.
  const reason =
    t.cause === 'arrived_elsewhere'
      ? `${who} is away from home — arrived somewhere else (${how}).`
      : `${who} just left home (${how}).`;
  return { dedupe_key: `home_departure:${user_id}`, reason };
}

/**
 * Log ONCE per user when a home def runs with no configured anchor. Without an
 * anchor the defs silently degrade to the `place_id`-only path — i.e. back to
 * the exact dead behavior this fix removed — so the degradation must be loud
 * rather than invisible. Keyed in the def's own state map (no extra plumbing).
 */
function warn_anchor_missing_once(state: Map<string, unknown>, user_id: string): void {
  const key = `anchor_warned:${user_id}`;
  if (state.get(key)) return;
  state.set(key, true);
  console.warn(
    `[reactive-triggers] no home anchor for user ${user_id} — home edges fall back to ` +
      `place_id only, which live iOS payloads do not send. Set home_location in config/users.yaml.`,
  );
}

/** `home_arrival` — the flagship: an away→home location flip wakes the
 *  subscriber (Kate) for a quick house-systems read. */
export const home_arrival_trigger: TriggerDef = {
  name: 'home_arrival',
  event_types: ['sensor_packet_received'],
  detect: (event, deps, state) => detect_home_edge(event, deps, state, 'home'),
};

/** `home_departure` — the symmetric partner: a home→away flip wakes the
 *  subscriber (Kate) for a "is the house secured" pass (doors/locks/garage,
 *  lights/HVAC for an empty house). Same event source as home_arrival. */
export const home_departure_trigger: TriggerDef = {
  name: 'home_departure',
  event_types: ['sensor_packet_received'],
  detect: (event, deps, state) => detect_home_edge(event, deps, state, 'away'),
};

export const BUILTIN_TRIGGER_DEFS: ReadonlyArray<TriggerDef> = [
  home_arrival_trigger,
  home_departure_trigger,
];
