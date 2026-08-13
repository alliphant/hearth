/**
 * HouseholdGraphDriver (2026-06-20) — the first SIGNAL SOURCE fan-out: turns an
 * `order_upserted` event into Household Knowledge Graph state and routes each
 * specialist's slice.
 *
 * Per Jasper: "should they go through Cordelia? — yes, via the shared router."
 * This is that router's first concrete source (the generic extraction is
 * Phase 2). The contract mirrors ReactiveInboxDriver: subscribe to a bus
 * event, gated + fail-open, never crash the producer.
 *
 * On each order:
 *   1. enrich → a typed `household_good` node (the shared, cordon-stamped truth)
 *   2. typed inference edges (owned-by / purchased-from) into knowledge_edges
 *   3. fan AWARENESS to each specialist's slice — Vivian (cost, every good),
 *      Luna (warranty/manual, durable goods only) — as inbox FYIs, cordoned
 *   4. emit `household_good_updated` (office refetch + learning signal)
 *
 * "Each reads their slice" without duplication: the GOOD is written once;
 * Vivian/Luna/Kate read it filtered to their domain (cost / appliances /
 * running picture) via query_household_goods. The FYI is the awareness ping.
 *
 * DARK behind HEARTH_HOUSEHOLD_GRAPH — off → attach() is a no-op, byte-identical
 * to today.
 */
import type { Database } from 'bun:sqlite';
import { ulid } from 'ulid';
import type { AppEventBus } from '@app/events';
import type { MemoryClient } from '@memory/client';
import type { SpecialistInbox } from '@memory/stores/conversations';
import type { UserRegistry } from '@core/users';
import { MailOrders } from '@memory/stores/mail_orders';
import { enrich_order_to_good } from './enrich';

export function household_graph_enabled(): boolean {
  return process.env.HEARTH_HOUSEHOLD_GRAPH === '1';
}

export interface HouseholdGraphDeps {
  events: AppEventBus;
  memory: MemoryClient;
  db: Database;
  inbox: SpecialistInbox;
  users: UserRegistry;
}

/** Map a good's cordon to an inbox originating_user_id: a real per-user scope
 *  carries the user; household/owner = shared (null). */
function cordon_user(private_to: string): string | null {
  return private_to === 'household' || private_to === 'owner' ? null : private_to;
}

export class HouseholdGraphDriver {
  private unsub?: () => void;

  constructor(private deps: HouseholdGraphDeps) {}

  attach(): void {
    if (!household_graph_enabled()) {
      console.log('[household-graph] disabled (HEARTH_HOUSEHOLD_GRAPH != 1) — no-op');
      return;
    }
    this.unsub = this.deps.events.subscribe((ev) => {
      if (ev.type === 'order_upserted') void this.on_order(ev.user_id, ev.order_key, ev.is_new);
    });
    console.log('[household-graph] attached — fanning orders into the knowledge graph');
  }

  detach(): void {
    this.unsub?.();
    this.unsub = undefined;
  }

  /** Fan one order into the graph. Public so a smoke / a future generic router
   *  can drive it directly without the event bus. Fail-open. */
  async on_order(user_id: string, order_key: string, is_new: boolean): Promise<void> {
    try {
      const order = new MailOrders(this.deps.db).get_by_key(user_id, order_key);
      if (!order) return;

      const buyer = this.deps.users.get(user_id);
      const enriched = enrich_order_to_good(
        {
          order_key: order.order_key,
          merchant: order.merchant,
          items: order.items,
          order_total: order.order_total,
          order_date: order.order_date,
          status: order.status,
          fulfillment: order.fulfillment,
          source_message_id: order.source_message_ids[0] ?? null,
        },
        { buyer_display_name: buyer?.display_name, private_to: order.private_to, now: new Date() },
      );

      // 1. The shared good node (cordon already stamped in the frontmatter).
      this.deps.memory.upsert_note(
        enriched.note_path,
        enriched.frontmatter as Record<string, unknown>,
        enriched.body,
      );

      // 2. Typed inference edges.
      for (const e of enriched.edges) this.deps.memory.knowledge_edges.upsert(e);

      // 3. Fan awareness to each specialist's slice (only on a NEW good — a
      //    later shipment/delivery merge updates the node without re-pinging).
      if (is_new) this._fan_to_specialists(enriched.frontmatter, order.private_to);

      // 4. Office refetch + learning signal.
      this.deps.events.emit({
        type: 'household_good_updated',
        good_id: enriched.id,
        note_path: enriched.note_path,
        private_to: order.private_to,
        user_id: cordon_user(order.private_to),
      });

      this.deps.memory.log_action({
        intent_id: `household_good:${enriched.id}`,
        agent: 'kate',
        tool_name: 'household_good_fanout',
        tool_input: { order_key, user_id, is_new },
        execution_result: {
          good_id: enriched.id,
          category: enriched.frontmatter.category,
          edges: enriched.edges.length,
        },
      });
    } catch (err) {
      console.error(`[household-graph] fan-out skip (order ${order_key}):`, err);
    }
  }

  private _fan_to_specialists(
    fm: { id: string; name: string; merchant?: string; cost?: number; currency?: string; warranty_until?: string; return_window_until?: string; category?: string },
    private_to: string,
  ): void {
    const ouid = cordon_user(private_to);
    const cost_str = fm.cost !== undefined ? ` (${fm.currency ?? 'USD'} ${fm.cost})` : '';

    // Vivian — cost. Every good has a spend dimension.
    this.deps.inbox.push({
      from_specialist_id: 'kate',
      to_specialist_id: 'vivian',
      kind: 'fyi',
      body_md:
        `New purchase tracked: **${fm.name}**${cost_str}` +
        `${fm.merchant ? ` from ${fm.merchant}` : ''}. It's in the household ` +
        `goods graph — the cost is yours to fold into the running spend picture.`,
      originating_user_id: ouid,
    });

    // Home inventory — warranty/manual, durable goods only (those with a
    // warranty window). Was Luna's slice; the house folded into Kate
    // (2026-07-04), so the FYI lands on her own inbox — her deliberation
    // folds it into the home-systems inventory ledger she now keeps.
    if (fm.warranty_until) {
      this.deps.inbox.push({
        from_specialist_id: 'kate',
        to_specialist_id: 'kate',
        kind: 'fyi',
        body_md:
          `New durable good for the home inventory: **${fm.name}**` +
          `${fm.merchant ? ` from ${fm.merchant}` : ''}. Warranty (est.) through ` +
          `${fm.warranty_until}` +
          `${fm.return_window_until ? `; return window through ${fm.return_window_until}` : ''}. ` +
          `Fold it into home-systems-inventory.md (update_luna_vault).`,
        originating_user_id: ouid,
      });
    }
  }
}
