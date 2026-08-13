/**
 * ToolDeps — the dependency bag handed to tool factories.
 *
 * A tool module that needs runtime services exports
 *
 *   export function create(deps: ToolDeps): Tool | Tool[]
 *
 * and the ToolLoader calls it with this bag at load time. Plain tools
 * that need nothing export the Tool object(s) directly instead, and the
 * loader discovers them by shape.
 *
 * Every import here is type-only, so this module adds no runtime edge to
 * the import graph — it can't introduce a cycle through specialist_runtime.
 */
import type { Database } from 'bun:sqlite';
import type { MemoryClient } from '@memory/client';
import type { AppEventBus } from '@app/events';
import type {
  ConversationStore,
  InterruptStore,
  SpecialistInbox,
} from '@memory/stores/conversations';
import type { LLMRouter } from './llm';
import type { ProcessMissStore } from './process_misses';
import type { ProposalsStore } from './proposals';
import type { SpecialistRegistry } from './specialist';
import type { SpecialistRuntime } from './specialist_runtime';
import type { ToolRegistry } from './tool_registry';
import type { LibraryStore } from '@library/store';
import type { UserRegistry } from './users';

/**
 * The superset of services any tool factory might need. A factory pulls
 * the fields it uses and ignores the rest; the orchestrator populates
 * every field once, at wiring time.
 */
export interface ToolDeps {
  db: Database;
  vault_root: string;
  memory: MemoryClient;
  llm: LLMRouter;
  proposals: ProposalsStore;
  inbox: SpecialistInbox;
  interrupts: InterruptStore;
  conversations: ConversationStore;
  specialists: SpecialistRegistry;
  runtime: SpecialistRuntime;
  events: AppEventBus;
  process_misses: ProcessMissStore;
  /**
   * The live tool registry — for tools that need to enumerate the
   * tooling landscape (capability gap analysis) or invoke a peer
   * specialist's tool (Kate's propose_hire consulting Beatrice).
   */
  tool_registry: ToolRegistry;
  /**
   * The categorized file store at ~/hearth-library/ — Cordelia's
   * download_to_library tool writes fetched files (and their index
   * rows) through it. See src/library/store.ts.
   */
  library: LibraryStore;
  /**
   * The per-user identity store (config/users.yaml). Tools that read
   * per-user state (home weather coords, timezone, allowed
   * specialists) resolve through this rather than reaching for
   * process env. Connectors that span multiple users (weather,
   * calendar) thread `user_id` through input + look up coords here.
   *
   * Optional so unit smokes that exercise a single tool can construct
   * a partial deps bag without faking a full UserRegistry. Production
   * boot wires it through unconditionally; tools that need it should
   * degrade to an actionable "unavailable" with a recovery hint when
   * the registry is absent, never crash.
   */
  users?: UserRegistry;
  /**
   * RAG embedder (2026-06-10). Tools that shelve library content through
   * `save_library_item` (curate_for_specialist, refresh_subscriptions,
   * acquire_knowledge) thread this into their LibraryRoutesDeps so
   * embed-at-ingest works on the tool path exactly like the upload
   * routes — without it, tool-shelved items wait for the embeddings
   * backfill to become vector-searchable. Optional: a NoopEmbedder (or
   * absence) degrades to FTS-only, never breaks a shelve.
   */
  embedder?: import('./embeddings').Embedder;
  /**
   * Scoped-deliberation waker (Case Driver, 2026-07-02) —
   * LoopDriver.wake_deliberation_scoped bound at wiring time, for driver
   * tools whose model steps are DIRECTED wakes (never wake-and-hope). The
   * wake rides the spine's debounce + min-interval; the `think` field
   * follows the S4 scrutiny resolution. Optional: partial runtimes / unit
   * smokes without a LoopDriver leave it unset and holders degrade to an
   * honest no-op.
   */
  wake_scoped?: (
    specialist_id: string,
    opts: {
      task: string;
      reason: string;
      dedupe_key: string;
      think?: boolean;
      min_interval_ms?: number;
    },
  ) => void;
  /**
   * Directed-build fire (2026-07-20, conversion teeth) — the SAME detached
   * trainer build the owner decide route fires on an approved Beatrice
   * spec (PR #95), bound at wiring time so the Proposal Court's approve
   * path can convert its approvals into WORK instead of only flagging
   * (two court-approved specs sat unbuilt through three standing passes).
   * Optional: partial runtimes / smokes leave it unset and holders keep
   * the flag-only legacy behavior.
   */
  fire_directed_build?: (proposal: import('./proposals').ProposalRow) => void;
}
