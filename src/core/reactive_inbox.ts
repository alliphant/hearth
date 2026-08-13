/**
 * Reactive inbox driver — the event-driven half of the proactive staff
 * loop. Where the deliberation loop runs on a slot schedule (07:00,
 * 12:30, etc.), the reactive driver runs *within seconds* of a Cordelia
 * capture landing.
 *
 * Pipeline:
 *
 *   capture_received event   (emitted by POST /api/cordelia/capture)
 *        │
 *        ▼
 *   CaptureCluster.enqueue   — first-in-bucket fires immediately,
 *        │                      follow-ups inside 5-min window
 *        │                      collapse into the bucket
 *        ▼
 *   classify_cluster         — Qwen 27B picks a specialist + payload
 *        │
 *        ▼
 *   write capture_routes row   (per decision)
 *   push to specialist inbox   (kind=flag, severity per confidence)
 *   emit capture_routed
 *        │
 *        ▼
 *   per-specialist intake handler (when registered AND opted in)
 *
 * Below-threshold decisions raise an interrupt to Kate via
 * `raise_interrupt` instead of routing — she picks where it goes.
 *
 * The driver carries no state of its own beyond the cluster buffer
 * (in-memory) and the AppEventBus subscription. Restart-safe: a
 * capture that lands during a restart still has a wrapper note and
 * a clippings projection row; the awareness loop and the deliberation
 * loop both back-stop the reactive path. The reactive path is the
 * fast path, not the only path.
 */

import { ulid } from 'ulid';
import type { Database } from 'bun:sqlite';
import type { LLMRouter } from '@core/llm';
import type { MemoryClient } from '@memory/client';
import type { SpecialistRegistry, LoadedSpecialist } from '@core/specialist';
import type { AppEventBus, AppEvent } from '@app/events';
import type {
  ConversationStore,
  InterruptStore,
  SpecialistInbox,
} from '@memory/stores/conversations';
import type { SpecialistRuntime } from '@core/specialist_runtime';
import type { UserRegistry } from '@core/users';
import { CaptureCluster, type CaptureClusterItem } from '@core/capture_cluster';
import {
  classify_cluster,
  type CordeliaRoutingDecision,
} from '../specialists/cordelia/classify';
import { raise_interrupt } from './interrupts';
import { patch_clipping_frontmatter } from '../specialists/cordelia/intake/_capture_io';
import { file_capture_to_library } from '../specialists/_intake_helpers';
import type { LibraryRoutesDeps } from '@app/routes/library';
import { SignalRouter } from './signal_router/router';

export type IntakeHandler = (input: IntakeHandlerInput) => Promise<void>;

export interface IntakeHandlerInput {
  capture_id: string;
  user_id: string;
  note_path: string;
  attachment_path: string | null;
  decision: CordeliaRoutingDecision;
  memory: MemoryClient;
  db: Database;
  llm: LLMRouter;
  events?: AppEventBus;
  inbox: SpecialistInbox;
  /** Lets a handler proactively start/append to the specialist's own
   *  conversation with the seller — e.g. Linda greeting + asking for the
   *  facts a photo can't supply, so a routed photo actually "wakes" her
   *  rather than sitting as a dormant inbox flag. */
  conversations: ConversationStore;
  /** Lets a handler run a real specialist TURN (not just post a canned
   *  message) — so Linda can look at the photo (analyze_image/ocr_image)
   *  and raise present_questions herself on a routed photo. */
  runtime: SpecialistRuntime;
  /** Resolve the capture's user_id → TurnUser for the turn's tier gate. */
  users: UserRegistry;
}

export interface ReactiveInboxDeps {
  db: Database;
  memory: MemoryClient;
  llm: LLMRouter;
  specialists: SpecialistRegistry;
  inbox: SpecialistInbox;
  interrupts: InterruptStore;
  events: AppEventBus;
  conversations: ConversationStore;
  runtime: SpecialistRuntime;
  users: UserRegistry;
  vault_root: string;
  /** RAG embedder (Pass 7) — threaded through so a routed capture filed
   *  onto a specialist's library shelf gets the same FTS + vector indexing
   *  as a human upload. Optional; FTS-only when absent. */
  embedder?: import('@core/embeddings').Embedder;
  /** Test override of the cluster window (ms). Production defaults to 5 min. */
  cluster_window_ms?: number;
}

export class ReactiveInboxDriver {
  private cluster: CaptureCluster;
  private intake_handlers = new Map<string, IntakeHandler>();
  /** Shared fan-out primitive — captures are source #1 (Phase 2). The cordoned
   *  inbox flag + SSE + audit on a routed capture goes through this, the same
   *  call the Calendar source uses. */
  private router: SignalRouter;
  private unsubscribe: (() => void) | null = null;
  /** Per-capture-id resolver — lets callers (the cordelia capture
   *  route) await the routing decision before responding to iOS. */
  private route_waiters = new Map<
    string,
    {
      resolve: (decisions: CordeliaRoutingDecision[]) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  // Capture decisions can complete before a waiter is registered (the
  // single-photo bypass path runs synchronously inside enqueue). Hold
  // a small TTL'd cache of recent decisions so a waiter registered
  // moments later still receives the result.
  private recent_decisions = new Map<
    string,
    { decisions: CordeliaRoutingDecision[]; ts_ms: number }
  >();
  private static readonly RECENT_TTL_MS = 5_000;

  constructor(private deps: ReactiveInboxDeps) {
    this.cluster = new CaptureCluster(deps.cluster_window_ms);
    this.cluster.on_flush((ready) => this.process_cluster(ready.user_id, ready.items));
    this.router = new SignalRouter({
      events: deps.events,
      memory: deps.memory,
      inbox: deps.inbox,
    });
  }

  register_intake(specialist_id: string, handler: IntakeHandler): void {
    this.intake_handlers.set(specialist_id, handler);
  }

  start(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = this.deps.events.subscribe((ev) => {
      if (ev.type === 'capture_received') this.on_capture_received(ev);
    });
  }

  stop(): void {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
    this.cluster.stop();
    for (const w of this.route_waiters.values()) clearTimeout(w.timer);
    this.route_waiters.clear();
    this.recent_decisions.clear();
  }

  /**
   * Used by the capture route to await the routing decision so the
   * 202 response can carry `routedTo` populated. Resolves with [] on
   * timeout — the iOS client treats null/empty as "still pending"
   * and refetches via /api/cordelia/recent.
   */
  await_route(capture_id: string, timeout_ms = 800): Promise<CordeliaRoutingDecision[]> {
    // Fast path: already resolved within the recency window.
    const recent = this.recent_decisions.get(capture_id);
    if (recent && Date.now() - recent.ts_ms <= ReactiveInboxDriver.RECENT_TTL_MS) {
      return Promise.resolve(recent.decisions);
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.route_waiters.delete(capture_id);
        resolve([]);
      }, timeout_ms);
      this.route_waiters.set(capture_id, { resolve, timer });
    });
  }

  private on_capture_received(ev: Extract<AppEvent, { type: 'capture_received' }>): void {
    const item: CaptureClusterItem = {
      capture_id: ev.capture_id,
      user_id: ev.user_id,
      kind: ev.kind,
      note_path: ev.note_path,
      attachment_path: ev.attachment_path,
      captured_at: ev.captured_at,
    };
    const verdict = this.cluster.enqueue(item);
    if (verdict === 'flush_now') {
      // Single-capture bypass: classify NOW, but don't pop the bucket —
      // a follow-up capture inside the 5-min window will still cluster
      // (the per-user bucket holds, only no second flush fires for this
      // already-classified item; see process_cluster's dedup guard).
      void this.process_cluster(item.user_id, [item]);
    }
  }

  private already_processed = new Set<string>();

  private async process_cluster(
    user_id: string,
    items: CaptureClusterItem[],
  ): Promise<void> {
    // Dedup: a flush_now item that later triggers a timer flush would
    // re-classify the same capture. The recent_decisions cache + this
    // set ensure each capture_id is classified exactly once.
    const fresh = items.filter((i) => !this.already_processed.has(i.capture_id));
    if (fresh.length === 0) return;
    for (const i of fresh) this.already_processed.add(i.capture_id);
    // Bounded; prune lazily — a 30-capture session shouldn't grow this
    // beyond a few hundred entries before the process restarts.
    if (this.already_processed.size > 5000) {
      const arr = Array.from(this.already_processed);
      this.already_processed = new Set(arr.slice(-2500));
    }

    // Routing honors the SAME access cordon as chat: a capture can only
    // route to a specialist its capturing user is allowed to reach. For the
    // owner (`allowed_specialists: '*'`) this is the full intake roster; for
    // a friend-tier user scoped to one specialist (e.g. Kim → Linda) it
    // collapses the candidate set to theirs, so content alone can't misroute
    // their capture to a specialist they can't even see (the ski-gear →
    // Vivian misroute). Kate stays the always-available triage fallback
    // (added unconditionally inside classify_cluster).
    // Kate sub-agents note (2026-07-03): subagent_only profiles STAY intake
    // candidates on purpose — a demotion hides CHAT surfaces (roster, alias
    // map), never the machine work. Anya's prescription extractor keeps
    // firing on a routed vet bill whether or not she's chat-reachable;
    // re-owning intake to Kate is Phase 3's fold-in, not the flag's job.
    const all_intake = this.deps.specialists
      .list()
      .filter((s) => s.proactive.intake_captures);
    const allowed = this.deps.users.get(user_id)?.allowed_specialists;
    const intake_specialists =
      allowed && allowed !== '*'
        ? all_intake.filter((s) => allowed.includes(s.id))
        : all_intake;
    let decisions: CordeliaRoutingDecision[];
    try {
      decisions = await classify_cluster(
        { cluster_id: ulid(), user_id, items: fresh },
        {
          llm: this.deps.llm,
          memory: this.deps.memory,
          vault_root: this.deps.vault_root,
          intake_specialists,
        },
      );
    } catch (err) {
      console.error('[reactive_inbox] classifier failed:', err);
      // Treat a classifier crash like a below-threshold result — route
      // every capture in the batch to Kate via interrupt so nothing
      // silently drops.
      decisions = [
        {
          capture_ids: fresh.map((i) => i.capture_id),
          specialist_id: 'kate',
          confidence: 0,
          route_reason: `classifier crashed: ${(err as Error).message.slice(0, 160)}`,
          extracted_payload: { track: 'unclassified' },
          below_threshold: true,
        },
      ];
    }

    for (const decision of decisions) {
      await this.apply_decision(decision, fresh);
    }

    // Stamp the wrapper note's frontmatter ONCE per capture with the
    // full aggregate of accepted routes. apply_decision deliberately no
    // longer touches frontmatter on the above-threshold path so a
    // multi-route fan-out (vet bill → Vivian + Anya) doesn't clobber
    // its own write — sequential single-element patches were silently
    // overwriting earlier routes. Triage / below-threshold paths still
    // stamp inside apply_decision because they short-circuit before
    // emitting capture_routes rows; aggregation here would miss them.
    const above_threshold = decisions.filter((d) => !d.below_threshold);
    if (above_threshold.length > 0) {
      const per_capture = new Map<
        string,
        { note_path: string; decisions: CordeliaRoutingDecision[] }
      >();
      for (const decision of above_threshold) {
        for (const cid of decision.capture_ids) {
          const item = fresh.find((i) => i.capture_id === cid);
          if (!item) continue;
          const entry = per_capture.get(cid) ?? {
            note_path: item.note_path,
            decisions: [],
          };
          entry.decisions.push(decision);
          per_capture.set(cid, entry);
        }
      }
      for (const { note_path, decisions: routes } of per_capture.values()) {
        // Sort routes high → low confidence so the primary lands first
        // in the array — downstream callers (iOS Library row, audit
        // pretty-print) treat routed_to[0] as the lead specialist.
        const sorted = routes.slice().sort((a, b) => b.confidence - a.confidence);
        patch_clipping_frontmatter(this.deps.memory, note_path, {
          routed_to: sorted.map((d) => d.specialist_id),
          routing_status: 'routed',
          routing_confidence: sorted.map((d) => d.confidence),
          routing_reason: sorted.map((d) => d.route_reason),
        });
      }
    }

    // Wake any await_route() waiters for captures in this batch.
    for (const item of fresh) {
      const relevant = decisions.filter((d) => d.capture_ids.includes(item.capture_id));
      this.recent_decisions.set(item.capture_id, {
        decisions: relevant,
        ts_ms: Date.now(),
      });
      const waiter = this.route_waiters.get(item.capture_id);
      if (waiter) {
        clearTimeout(waiter.timer);
        this.route_waiters.delete(item.capture_id);
        waiter.resolve(relevant);
      }
    }
    // Prune recent_decisions cache (keep the latest ~1000 — that's a
    // huge backlog for the iOS await window).
    if (this.recent_decisions.size > 1000) {
      const sorted = Array.from(this.recent_decisions.entries()).sort(
        (a, b) => b[1].ts_ms - a[1].ts_ms,
      );
      this.recent_decisions = new Map(sorted.slice(0, 500));
    }
  }

  private async apply_decision(
    decision: CordeliaRoutingDecision,
    items: CaptureClusterItem[],
  ): Promise<void> {
    const subject_items = items.filter((i) => decision.capture_ids.includes(i.capture_id));
    if (subject_items.length === 0) return;
    const first = subject_items[0]!;

    // BELOW THRESHOLD → Kate gets an interrupt for triage; no
    // capture_routes row, frontmatter stamped routed_to=['kate'] +
    // routing_status='triage'.
    if (decision.below_threshold) {
      await raise_interrupt({
        originating_specialist_id: 'cordelia',
        threshold: 'medium',
        severity: 'medium',
        summary: `Capture ${decision.capture_ids.join(', ')} below routing threshold — needs triage`,
        details_md: [
          `Cordelia couldn't confidently route ${decision.capture_ids.length} capture(s).`,
          `Reason: ${decision.route_reason}`,
          decision.extracted_payload.ocr_text
            ? `\nOCR excerpt:\n\n${decision.extracted_payload.ocr_text.slice(0, 400)}`
            : '',
          decision.extracted_payload.vl_description
            ? `\nVL description:\n\n${decision.extracted_payload.vl_description}`
            : '',
        ]
          .filter((s) => s.length > 0)
          .join('\n'),
        memory: this.deps.memory,
        interrupts: this.deps.interrupts,
        inbox: this.deps.inbox,
        events: this.deps.events,
        // Cordon: this triage flag carries the capturing user's content.
        originating_user_id: first.user_id,
      });
      for (const it of subject_items) {
        patch_clipping_frontmatter(this.deps.memory, it.note_path, {
          routed_to: ['kate'],
          routing_status: 'triage',
          routing_confidence: decision.confidence,
        });
      }
      this.emit_routed(first, decision, [], subject_items);
      return;
    }

    // ABOVE THRESHOLD → persist + push + fire intake handler if present.
    // Frontmatter is stamped by `process_cluster` AFTER all decisions in
    // the cluster apply, so a multi-route fan-out (vet bill → Vivian
    // AND Anya) writes the full aggregate once instead of having each
    // single-route patch clobber the previous one. See the per-capture
    // aggregation pass at the end of `process_cluster`.
    const route_id = `cr_${ulid().toLowerCase().slice(-12)}`;
    const now = new Date().toISOString();
    const newly_routed: CaptureClusterItem[] = [];
    for (const item of subject_items) {
      const res = this.deps.db
        .prepare(
          `INSERT OR IGNORE INTO capture_routes
           (id, capture_id, specialist_id, confidence, route_reason,
            extracted_payload_json, routed_at)
           VALUES (@id, @cap, @spec, @conf, @reason, @payload, @routed_at)`,
        )
        .run({
          '@id': `${route_id}_${item.capture_id.slice(-6)}`,
          '@cap': item.capture_id,
          '@spec': decision.specialist_id,
          '@conf': decision.confidence,
          '@reason': decision.route_reason,
          '@payload': JSON.stringify(decision.extracted_payload),
          '@routed_at': now,
        });
      if (res.changes > 0) newly_routed.push(item);
    }

    // Make the capture SEARCHABLE for the routed-to specialist: file it onto
    // their library shelf (Knowledge/<Target>/library/) through the same
    // chunk+embed pipeline human uploads use. Without this, a route is just
    // an inbox flag — the specialist's search_library / turn-RAG can't reach
    // the capture (its signal lives in frontmatter, and the Cordelia/Inbox
    // wrapper note is never chunked). Filing here also makes it visible to
    // Cordelia via her `Knowledge/*/library/**` scope, so she keeps a
    // searchable record of everything she routed. Gated on `newly_routed` so
    // a reclassify/re-route never duplicates the shelf note; best-effort, so
    // a filing failure leaves the durable inbox flag + capture_routes intact.
    const target_spec = this.deps.specialists.get(decision.specialist_id);
    if (target_spec && newly_routed.length > 0) {
      const library_deps: LibraryRoutesDeps = {
        db: this.deps.db,
        vault_root: this.deps.vault_root,
        memory: this.deps.memory,
        specialists: this.deps.specialists,
        runtime: this.deps.runtime,
        conversations: this.deps.conversations,
        llm: this.deps.llm,
        events: this.deps.events,
        embedder: this.deps.embedder,
      };
      for (const item of newly_routed) {
        try {
          await file_capture_to_library({
            library_deps,
            target: target_spec,
            capture_id: item.capture_id,
            user_id: item.user_id,
            source_note_path: item.note_path,
            attachment_path: item.attachment_path,
            vl_description: decision.extracted_payload.vl_description,
            ocr_text: decision.extracted_payload.ocr_text,
            user_note:
              typeof decision.extracted_payload.notes === 'string'
                ? decision.extracted_payload.notes
                : undefined,
            route_reason: decision.route_reason,
            tz: this.deps.users.get_timezone(item.user_id),
          });
        } catch (err) {
          console.error(
            `[reactive_inbox] library filing for ${decision.specialist_id} failed:`,
            err,
          );
        }
      }
    }

    // Push one inbox message per route (not per capture-in-route) so a
    // cluster lands as a single flag.
    const severity = decision.confidence >= 0.75 ? 'medium-high' : 'medium';
    // Phase 3 (2026-07-21): the librarian desk is dissolved into Kate, so the
    // capture flag speaks in HER voice. Only the human-visible copy + sender
    // move; the cordelia_route audit tool_name/intent_id below stay as internal
    // anchors (roster_gaps and the capture audit trail key on them).
    const body_lines: string[] = [
      `Routed ${decision.capture_ids.length} capture(s) to you (confidence ${decision.confidence.toFixed(2)}).`,
      decision.route_reason,
    ];
    // The user's own caption ("Linda, can you price these out?") — the
    // highest-signal instruction on the capture. Surface it first so the
    // specialist acts on what the user actually asked for.
    if (typeof decision.extracted_payload.notes === 'string' && decision.extracted_payload.notes.trim()) {
      body_lines.push('', `**User's note:** ${decision.extracted_payload.notes.trim()}`);
    }
    if (decision.extracted_payload.ocr_text) {
      body_lines.push('', '> ' + decision.extracted_payload.ocr_text.slice(0, 240).replace(/\n+/g, ' '));
    } else if (decision.extracted_payload.vl_description) {
      body_lines.push('', '> ' + decision.extracted_payload.vl_description.slice(0, 240).replace(/\n+/g, ' '));
    }
    body_lines.push('', `Wrapper note(s): ${subject_items.map((i) => i.note_path).join(', ')}`);

    // Deliver through the shared SignalRouter (Phase 2): cordoned inbox flag +
    // `inbox_message_added` SSE + the cordelia_route audit row, in one call —
    // the same primitive the Calendar source uses. Cordon: the routed capture
    // is this user's, so the flag only surfaces in their brief / their chat.
    this.router.deliver({
      source: 'capture',
      // Kate owns the capture surface post-consolidation. Guard the self-address
      // case: captures routed TO Kate would otherwise produce a from=kate/to=kate
      // row, which reads as nonsense and can confuse inbox dedup/office rendering
      // (the same trap review_routing avoids). Fall back to the orchestrator as
      // the neutral system sender for that leg.
      from_specialist_id: decision.specialist_id === 'kate' ? 'orchestrator' : 'kate',
      to_specialist_id: decision.specialist_id,
      kind: 'flag',
      body_md: body_lines.join('\n'),
      severity,
      originating_user_id: first.user_id,
      audit: {
        tool_name: 'cordelia_route',
        agent: 'cordelia',
        intent_id: `cordelia_route:${route_id}`,
        tool_input: {
          capture_ids: decision.capture_ids,
          specialist_id: decision.specialist_id,
          confidence: decision.confidence,
        },
        execution_result: {
          route_reason: decision.route_reason,
          track: decision.extracted_payload.track,
        },
      },
    });

    // Intake handler — fires inline; failures don't block the route
    // (the inbox flag is the durable record).
    const target = this.deps.specialists.get(decision.specialist_id);
    const handler = this.intake_handlers.get(decision.specialist_id);
    if (target && target.proactive.intake_captures && handler) {
      try {
        await handler({
          capture_id: first.capture_id,
          user_id: first.user_id,
          note_path: first.note_path,
          attachment_path: first.attachment_path,
          decision,
          memory: this.deps.memory,
          db: this.deps.db,
          llm: this.deps.llm,
          events: this.deps.events,
          inbox: this.deps.inbox,
          conversations: this.deps.conversations,
          runtime: this.deps.runtime,
          users: this.deps.users,
        });
      } catch (err) {
        console.error(
          `[reactive_inbox] intake handler for ${decision.specialist_id} failed:`,
          err,
        );
        this.deps.memory.log_action({
          intent_id: `intake_failed:${ulid()}`,
          agent: decision.specialist_id,
          tool_name: 'cordelia_intake_failed',
          tool_input: { capture_id: first.capture_id },
          error: (err as Error).message.slice(0, 200),
        });
      }
    }

    this.emit_routed(first, decision, [decision.specialist_id], subject_items);
  }

  private emit_routed(
    _first: CaptureClusterItem,
    decision: CordeliaRoutingDecision,
    specialist_ids: string[],
    items: CaptureClusterItem[],
  ): void {
    // One capture_routed event per (capture, decision) pair so the iOS
    // Library tab's per-row subscriber updates only the rows that
    // changed. With multi-route fan-out one capture can produce N
    // events (one per accepted route) — iOS coalesces by capture_id
    // and re-pulls the row's full state from /api/cordelia/recent.
    for (const item of items) {
      this.deps.events.emit({
        type: 'capture_routed',
        capture_id: item.capture_id,
        specialist_ids,
        confidence: decision.confidence,
        route_reason: decision.route_reason,
        clustered_with: items
          .filter((i) => i.capture_id !== item.capture_id)
          .map((i) => i.capture_id),
      });
    }
  }

  /** Test-only: force-flush any open bucket for a user RIGHT NOW. */
  async _test_flush_for(user_id: string): Promise<void> {
    await this.cluster.flush_now_for(user_id);
  }

  /** Currently-registered intake handler ids. */
  intake_ids(): string[] {
    return Array.from(this.intake_handlers.keys());
  }

  /** Helper for test/debug: did this driver process the given capture? */
  has_processed(capture_id: string): boolean {
    return (
      this.already_processed.has(capture_id) ||
      this.recent_decisions.has(capture_id)
    );
  }

  /** Reference to the cluster — used in smoke for visibility. */
  get cluster_buffer(): { open_count(): number } {
    return { open_count: () => this.cluster.open_count() };
  }

  /** Specialist ids whose intake handler will be invoked for routed captures.
   *  Includes subagent_only profiles — demotion hides chat surfaces, never
   *  intake work (see the candidate-set note in process_cluster). */
  intake_specialist_ids(): string[] {
    return this.deps.specialists
      .list()
      .filter((s) => s.proactive.intake_captures)
      .map((s) => s.id);
  }
}

export type { CordeliaRoutingDecision };
