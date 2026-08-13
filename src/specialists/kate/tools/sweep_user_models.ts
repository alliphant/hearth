/**
 * sweep_user_models — the unified per-user model's nightly tick (2026-06-20).
 *
 * Kate's 03:30 background job (NOT on any LLM surface — the job IS the trigger;
 * manual catch-up via `fire_background_job?name=sweep_user_models`). Walks the
 * active roster × the facet taxonomy and refreshes only the facets that have
 * crossed their new-observation threshold — `synthesize_facet` skips the rest
 * with no LLM call, so a quiet night is mostly SQLite counts. Runs on a CHEAP
 * tier (HEARTH_USER_MODEL_TIER, default `planner` = the idle-at-3am 9B), refine-
 * not-rebuild. This is the EFFERENT-enabling half: the afferent observers
 * (user_model_observers.ts) feed observations all day; this distills them at
 * night so the resolver has fresh facets to inject.
 *
 * DARK by default (HEARTH_USER_MODEL=1 → enabled:false, touches nothing) and
 * FAIL-OPEN per user/facet (run_user_model_sweep isolates each). Generalizes the
 * jasper-only observe/distill style jobs to ANY user and ALL facets.
 */
import { z } from 'zod';
import type { Tool, ToolContext } from '@core/tool';
import type { ToolDeps } from '@core/tool_deps';
import {
  run_user_model_sweep,
  user_model_enabled,
  user_model_sweep_tier,
  type ModelDeps,
} from '@core/user_model';
import {
  interest_signal_evidence,
  music_evidence,
  screen_evidence,
} from '@core/taste_sources';
import type { StyleLLM, StyleMessage } from '@core/user_style';
import { MailStore } from '@memory/stores/mail';
import { fetch_screen_history_for_taste } from '../../../connectors/plex';

const InputSchema = z.object({
  user_ids: z
    .array(z.string())
    .optional()
    .describe('Optional explicit user list; defaults to the active roster.'),
});
const OutputSchema = z.object({
  enabled: z.boolean(),
  users: z.number(),
  /** "<user_id>/<facet>" for each facet actually re-distilled this run. */
  refreshed: z.array(z.string()),
  /** Facets walked but left untouched (below threshold / no signal / error). */
  skipped: z.number(),
});

type Input = z.infer<typeof InputSchema>;
type Output = z.infer<typeof OutputSchema>;

export function make_sweep_user_models(deps: ToolDeps): Tool<Input, Output> {
  return {
    name: 'sweep_user_models',
    description:
      'Off-peak background job: walk active users × the per-user-model facet ' +
      'taxonomy and refresh only the threshold-crossed facets (cheap tier, ' +
      'refine-not-rebuild). Not a chat tool.',
    risk: 'write_internal',
    required_capabilities: ['maintain_user_model'],
    input_schema: InputSchema,
    output_schema: OutputSchema,
    volatile: true,

    idempotency_key() {
      return `sweep_user_models:${Math.floor(Date.now() / 60_000)}`;
    },

    async execute(input: Input, ctx: ToolContext): Promise<Output> {
      if (!user_model_enabled()) {
        return { enabled: false, users: 0, refreshed: [], skipped: 0 };
      }
      const user_ids =
        input.user_ids && input.user_ids.length > 0
          ? input.user_ids
          : (deps.users?.list().map((u) => u.id) ?? [
              process.env.HEARTH_OWNER_USER_ID ?? 'jasper',
            ]);

      // The 'style' facet (source:'messages') learns the user's register. Feed
      // it BOTH chat messages AND the higher-signal corpus of email they've
      // actually SENT (the Post Office stores Sent rows). Fail-open: no mail /
      // mail off ⇒ recent_sent_bodies returns [] ⇒ chat-only, unchanged. This
      // is the "Jasper writing style" utilization the Post Office begins.
      const mail = new MailStore(deps.db);
      const recent = (uid: string, since: string, max: number): StyleMessage[] => {
        const chat = deps.conversations
          .list_user_messages_since(since, { limit: max, min_chars: 30, user_id: uid })
          .map((r) => ({ ts: r.ts, content_md: r.content_md }));
        let sent: StyleMessage[] = [];
        try {
          sent = mail.recent_sent_bodies(uid, since, max);
        } catch {
          /* mail store absent / disabled — chat-only */
        }
        return [...chat, ...sent]
          .sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0))
          .slice(0, max);
      };

      // Phase B taste & interests evidence sources (2026-07-04) — pluggable
      // deterministic mappers (taste_sources.ts); the synthesis model judges.
      // Each returns null on no data, so an unconfigured source is a facet
      // no-op, never an error (and synthesize_facet catches a throw the same
      // way). Cordon: every read below is keyed to the ONE user being swept.
      const owner_id = process.env.HEARTH_OWNER_USER_ID ?? 'jasper';
      const tier_of = (uid: string) =>
        deps.users?.list().find((u) => u.id === uid)?.tier ?? ('household' as const);

      const model_deps: ModelDeps = {
        facets: ctx.memory.user_profiles,
        llm: ctx.llm as unknown as StyleLLM,
        recent_user_messages: recent,
        tier: user_model_sweep_tier(),
        sources: {
          // music_taste ← the user's own daily iOS MediaPlayer snapshot.
          music: (uid) => music_evidence(ctx.memory.query_music_context(uid)),
          // screen_taste ← Tautulli watch history. The Tautulli identity map
          // covers the owner today (PLEX_USER); other members return null
          // until per-user Plex usernames exist. Fail-open when unconfigured.
          screen: async (uid) => {
            if (uid !== owner_id) return null;
            return screen_evidence(await fetch_screen_history_for_taste({}));
          },
          // interests supplement ← the user's OWN inbound non-junk mail
          // (recurring senders) + purchases visible to them (cordoned read).
          interest_signals: (uid) => {
            const since = new Date(ctx.now.getTime() - 60 * 86_400_000).toISOString();
            const inbound = mail
              .list({ direction: 'inbound', since, limit: 500 })
              .filter((m) => m.user_id === uid && m.triage_bucket !== 'junk');
            const goods = ctx.memory.query_household_goods({
              caller: { user_id: uid, tier: tier_of(uid) },
              limit: 40,
            });
            return interest_signal_evidence({ mail: inbound, goods });
          },
        },
      };

      const results = await run_user_model_sweep(user_ids, model_deps, { now: ctx.now });
      const refreshed = results
        .filter((r) => r.updated)
        .map((r) => `${r.user_id}/${r.facet}`);
      return {
        enabled: true,
        users: user_ids.length,
        refreshed,
        skipped: results.length - refreshed.length,
      };
    },
  };
}

export function create(deps: ToolDeps): Tool {
  return make_sweep_user_models(deps) as Tool;
}
