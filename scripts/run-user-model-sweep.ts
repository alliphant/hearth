/**
 * Run the unified per-user model sweep out-of-band (manual / cron seed).
 *
 *   bun run scripts/run-user-model-sweep.ts [--bootstrap] [user_id ...]   (default: jasper)
 *
 * Calls the SHARED run_user_model_sweep engine — the exact same one Kate's 03:30
 * `sweep_user_models` background job uses: walk users × the facet taxonomy and
 * refresh only the threshold-crossed (cheap tier, refine-not-rebuild). During
 * normal operation the afferent observers (user_model_observers.ts) feed
 * interests/routines observations all day; the style facet pulls messages
 * directly. This is the explicit driver for an on-demand run or a fresh box.
 *
 *   --bootstrap  seed observation-source facets (interests/routines) from the
 *                user's recent messages FIRST, for a cold box that has no
 *                observer-collected data yet (interests ← message text;
 *                routines ← message timestamps). Omit once the observers have
 *                been collecting for a while.
 *
 * HEARTH_USER_MODEL is force-enabled for THIS process so the explicit driver
 * always runs (the env gate guards only the AUTOMATIC nightly sweep, not this).
 * Shares data/hearth.db via WAL. This also subsumes the retired
 * run-user-style-sweep.ts — `style` is just one facet in the taxonomy now.
 */
import { open_db } from '@memory/stores/structured';
import { MemoryClient } from '@memory/client';
import { ConversationStore } from '@memory/stores/conversations';
import { ConfigLLMRouter } from '@core/router';
import { local_dow, local_hhmm } from '@core/time';
import {
  record_observation,
  run_user_model_sweep,
  user_model_sweep_tier,
  FACET_REGISTRY,
  type ModelDeps,
} from '@core/user_model';
import {
  interest_signal_evidence,
  music_evidence,
  screen_evidence,
} from '@core/taste_sources';
import { MailStore } from '@memory/stores/mail';
import { fetch_screen_history_for_taste } from '../src/connectors/plex';

const VAULT_ROOT = process.env.HEARTH_VAULT_ROOT ?? `${process.env.HOME}/vault-friday`;
const DB_PATH = process.env.HEARTH_DB_PATH ?? './data/hearth.db';
const ROLES_PATH = process.env.HEARTH_ROLES_PATH ?? './config/llm-roles.yaml';
const LOOKBACK_MS = 14 * 24 * 3_600_000;

// The explicit driver always runs, regardless of the dark-toggle (which guards
// only the automatic nightly sweep). Set BEFORE importing the engine is enough
// since user_model_enabled() reads env at call time.
process.env.HEARTH_USER_MODEL = '1';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const bootstrap = args.includes('--bootstrap');
  const user_ids = args.filter((a) => !a.startsWith('--'));
  const ids = user_ids.length ? user_ids : ['jasper'];

  const db = open_db(DB_PATH);
  const memory = new MemoryClient({ vault_root: VAULT_ROOT, db });
  const conversations = new ConversationStore(db);
  const llm = new ConfigLLMRouter(ROLES_PATH, {
    ollama_base_url: process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434',
    openai_base_url: process.env.OPENAI_BASE_URL,
    openai_api_key: process.env.OPENAI_API_KEY,
  });
  const store = memory.user_profiles;
  const recent = (uid: string, since: string, max: number) =>
    conversations
      .list_user_messages_since(since, { limit: max, min_chars: 30, user_id: uid })
      .map((r) => ({ ts: r.ts, content_md: r.content_md }));

  // The same Phase B taste/interests sources the nightly job wires (see
  // sweep_user_models.ts) so an on-demand run matches the 03:30 sweep.
  const mail = new MailStore(db);
  const owner_id = process.env.HEARTH_OWNER_USER_ID ?? 'jasper';
  const deps: ModelDeps = {
    facets: store,
    llm,
    recent_user_messages: recent,
    tier: user_model_sweep_tier(),
    sources: {
      music: (uid) => music_evidence(memory.query_music_context(uid)),
      screen: async (uid) => {
        if (uid !== owner_id) return null;
        return screen_evidence(await fetch_screen_history_for_taste({}));
      },
      interest_signals: (uid) => {
        const since = new Date(Date.now() - 60 * 86_400_000).toISOString();
        const inbound = mail
          .list({ direction: 'inbound', since, limit: 500 })
          .filter((m) => m.user_id === uid && m.triage_bucket !== 'junk');
        const goods = memory.query_household_goods({
          caller: { user_id: uid, tier: uid === owner_id ? 'owner' : 'household' },
          limit: 40,
        });
        return interest_signal_evidence({ mail: inbound, goods });
      },
    },
  };

  for (const uid of ids) {
    const now = new Date();
    if (bootstrap) {
      const since = new Date(now.getTime() - LOOKBACK_MS).toISOString();
      const msgs = recent(uid, since, 40);
      // interests ← message text; routines ← derived activity timestamps (the
      // same shape the live observer records). Default tz is fine for a seed.
      for (const m of msgs) {
        record_observation(store, uid, 'interests', m.content_md, now);
        const t = new Date(m.ts);
        record_observation(store, uid, 'routines', `active ${local_dow(t)} ${local_hhmm(t)}`, now);
      }
      console.log(`[${uid}] bootstrap seeded ${msgs.length} recent msgs`);
    }
  }

  console.log(
    `user-model sweep: ${ids.join(', ')}  (db=${DB_PATH}, facets: ${Object.keys(FACET_REGISTRY).join(', ')}, tier: ${user_model_sweep_tier()})`,
  );
  const results = await run_user_model_sweep(ids, deps, { now: new Date() });
  for (const r of results) {
    console.log(`[${r.user_id}/${r.facet}] ${JSON.stringify(r)}`);
    if (r.updated) {
      const f = store.get_facet(r.user_id, r.facet);
      if (f?.summary) console.log(`  → ${f.summary}`);
    }
  }
}

main().catch((err) => {
  console.error('[fatal]', err);
  process.exit(1);
});
