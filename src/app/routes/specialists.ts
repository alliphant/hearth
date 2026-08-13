/**
 * Specialist runtime HTTP routes, mounted by the orchestrator at /api.
 *
 *   GET  /api/specialists                  list all specialists
 *   GET  /api/specialists/:id              one specialist (no persona text)
 *   POST /api/conversations                start a new conversation
 *   GET  /api/conversations                list conversations
 *   GET  /api/conversations/:id/messages   paged history
 *   POST /api/conversations/:id/messages   send user message → specialist reply
 *   POST /api/conversations/:id/switch     switch active specialist
 *   GET  /api/proposals                    queue of proposals
 *   POST /api/proposals/:id/decide         approve / deny / modify
 *   POST /api/proposals/:id/snooze         snooze until ISO timestamp
 *   GET  /api/interrupts                   queue of interrupts
 *   POST /api/interrupts/:id/acknowledge   acknowledge an interrupt
 *   GET  /api/search                       unified FTS5 search
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
import { z } from 'zod';
import { ulid } from 'ulid';
import type { Database } from 'bun:sqlite';
import type { SqlBind } from '@memory/stores/structured';
import type { SpecialistRegistry } from '@core/specialist';
import type { SpecialistRuntime } from '@core/specialist_runtime';
import type { ProposalsStore, ProposalRow } from '@core/proposals';
import { BUILD_AGENT_ID, BUILD_LEDGER_ID } from '@core/build_identity';
import { trust_xp_enabled } from '@core/trust_xp';
import { HiringPacketSchema, HIRING_PROPOSAL_KIND } from '@core/hiring';
import { to_turn_user } from '@core/users';
import { CodeShopSettings } from '@memory/stores/codeshop_settings';
import type {
  ConversationStore,
  InterruptStore,
  SpecialistInbox,
} from '@memory/stores/conversations';
import type { MemoryClient } from '@memory/client';
import type { ToolRegistry } from '@core/tool_registry';
import type { LLMRouter } from '@core/llm';
import { build_followup_trigger } from '@core/followups';
import type { DeliverFollowupContext } from '@core/followups';
import { try_speak_followup } from '@core/voice_announce';
import { strip_markdown_for_speech } from '@core/voice_text';
import { push_text } from '@policy/push';
import {
  PendingQuestionsStore,
  type AnswerValue,
  type PendingQuestionRow,
} from '@memory/stores/pending_questions';
import { ListingDraftsStore } from '@memory/stores/listing_drafts';
import { DelegationStore } from '@memory/stores/delegations';
import { SwarmReviewStore } from '@memory/stores/swarm_reviews';
import { compute_active_status } from '@core/specialist_active_status';
import { units_for } from '@core/units';
import { compose_pane } from '@core/specialist_pane';

export interface SpecialistRoutesDeps {
  db: Database;
  memory: MemoryClient;
  specialists: SpecialistRegistry;
  runtime: SpecialistRuntime;
  proposals: ProposalsStore;
  conversations: ConversationStore;
  interrupts: InterruptStore;
  inbox: SpecialistInbox;
  tools: ToolRegistry;
  llm: LLMRouter;
  /** Absolute path to the user's vault root. Threaded so the pane
   *  composer can read Maggie's artist watchlist for the Listening
   *  pane without duplicating the env-resolution logic that lives in
   *  the orchestrator. Optional only so legacy/smoke wiring that
   *  didn't construct a pane-bearing specialist can keep working —
   *  the listening pane returns 404 cleanly when this is absent. */
  vault_root?: string;
  /** Process-wide in-memory tracker for active workout sessions.
   *  Astrid's activity pane reads it for live-mode rendering; when
   *  absent the composer falls back to standby mode (still useful —
   *  the post-restart edge case where SQL says active but the
   *  in-memory state was lost). */
  workout_tracker?: import('./workout').WorkoutSessionTracker;
  events?: { emit: (e: import('../events').AppEvent) => void };
  /** 2026-05-25 BACKEND_AUTH_BRIEF. When wired, /proposals/:id/decide
   *  gates approvals on signature.extras.amount_cents > threshold on
   *  step-up. Absent ⇒ no step-up enforcement (legacy / smoke). */
  step_up?: import('@core/step_up').StepUpStore;
  /** Optional — enables Phase 2a per-user access checks. Auth middleware
   *  attaches the user to ctx, this lets the route check
   *  allowed_specialists / cross-user conversation gating. Absent in
   *  smoke-test wiring; the route degrades to single-user behavior. */
  users?: import('@core/users').UserRegistry;
  /**
   * Dispatch an owner-directed BUILD for an approved Beatrice proposal — runs
   * her deliberation on the strong model with `propose_code_change` /
   * `propose_code_edit` in hand (those tools exist on NO standing surface, so
   * a plain wake can't author code). Wired in server.ts to
   * `loop_driver.fire_deliberation_now('trainer', 'build', directed_task)`.
   * Optional so smoke/legacy wiring that lacks a LoopDriver degrades to the
   * inbox-flag notification only. Fire-and-forget: a build runs for minutes,
   * far longer than the decide response should block.
   */
  fireDirectedBuild?: (proposal: ProposalRow) => void;
}

async function read_json(c: Context): Promise<{ ok: true; body: unknown } | { ok: false; error: string }> {
  try {
    return { ok: true, body: await c.req.json() };
  } catch (err) {
    return { ok: false, error: `Invalid JSON: ${(err as Error).message}` };
  }
}

/**
 * Resolve a specialist's avatar to a vault-relative path that the
 * DTO can carry. iOS gates avatar fetching on `Specialist.avatar !==
 * nil` (Specialist.swift:72 — `guard avatar != nil else { return
 * nil }`), so a specialist whose yaml omits the `avatar:` field but
 * has a real PNG on disk under `Knowledge/<Capitalized>/avatar.png`
 * was silently invisible on iOS. Mariah hit this 2026-05-27 — her
 * file existed, the `/api/avatars/mariah` route served it cleanly
 * via its own fallback scan, but iOS never asked because the DTO
 * said null.
 *
 * This helper mirrors `existing_avatar_path` in
 * src/app/routes/avatars.ts: prefer the yaml-declared path when
 * present and extant, otherwise probe `Knowledge/<Capitalized>/
 * avatar.{png,jpg,webp,svg,gif}` and return the first extant one.
 * Returns null only when truly no file exists (in which case iOS's
 * skip is correct — there's nothing to fetch). Path returned is
 * vault-relative so the DTO carries the same shape it already had
 * for yaml-declared specialists.
 */
const _AVATAR_EXTENSIONS = ['.png', '.jpg', '.webp', '.svg', '.gif'] as const;
const _BANNER_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp'] as const;
function resolve_avatar_relpath(
  memory: MemoryClient,
  declared: string | undefined,
  spec_id: string,
): string | null {
  const vault_root = (memory as unknown as { cfg: { vault_root: string } }).cfg.vault_root;
  const { existsSync } = require('node:fs') as typeof import('node:fs');
  const { resolve } = require('node:path') as typeof import('node:path');
  if (declared) {
    if (existsSync(resolve(vault_root, declared))) return declared;
  }
  const capitalized = spec_id.charAt(0).toUpperCase() + spec_id.slice(1);
  for (const ext of _AVATAR_EXTENSIONS) {
    const rel = `Knowledge/${capitalized}/avatar${ext}`;
    if (existsSync(resolve(vault_root, rel))) return rel;
  }
  return null;
}

/**
 * Return the mtime of the resolved avatar PNG as an ISO-8601 string,
 * or null when no avatar exists. Lets iOS's AvatarCache fold the
 * content version into its disk-cache key so a re-rolled portrait
 * auto-invalidates client-side without a manual refresh — the cache
 * was previously keyed on `(id, path)` only, and the path is stable
 * across re-rolls (`Knowledge/<Spec>/avatar.png`), so swapping the
 * bytes left clients serving the old image forever. Mirrors the
 * `resolve_avatar_relpath` probe shape: declared path first, then
 * the conventional fallback scan.
 */
function resolve_avatar_modified_at(
  memory: MemoryClient,
  declared: string | undefined,
  spec_id: string,
): string | null {
  const vault_root = (memory as unknown as { cfg: { vault_root: string } }).cfg.vault_root;
  const { existsSync, statSync } = require('node:fs') as typeof import('node:fs');
  const { resolve } = require('node:path') as typeof import('node:path');
  const candidates: string[] = [];
  if (declared) candidates.push(resolve(vault_root, declared));
  const capitalized = spec_id.charAt(0).toUpperCase() + spec_id.slice(1);
  for (const ext of _AVATAR_EXTENSIONS) {
    candidates.push(resolve(vault_root, `Knowledge/${capitalized}/avatar${ext}`));
  }
  for (const abs of candidates) {
    if (!existsSync(abs)) continue;
    try {
      return statSync(abs).mtime.toISOString();
    } catch {
      // ignore — fall through to the next candidate
    }
  }
  return null;
}

/**
 * Same as `resolve_avatar_modified_at` but for the banner. Banner has
 * no `declared` path on `SpecialistConfig` — it's always probed by
 * convention at `Knowledge/<Capitalized>/banner.{png,jpg,jpeg,webp}`
 * — so the candidate list is purely the fallback scan. Mirrors the
 * `banner_candidates` helper in `routes/banners.ts` so any future
 * extension addition (`.heic`, etc.) lands in one obvious place.
 */
function resolve_banner_modified_at(
  memory: MemoryClient,
  spec_id: string,
): string | null {
  const vault_root = (memory as unknown as { cfg: { vault_root: string } }).cfg.vault_root;
  const { existsSync, statSync } = require('node:fs') as typeof import('node:fs');
  const { resolve } = require('node:path') as typeof import('node:path');
  const capitalized = spec_id.charAt(0).toUpperCase() + spec_id.slice(1);
  for (const ext of _BANNER_EXTENSIONS) {
    const abs = resolve(vault_root, `Knowledge/${capitalized}/banner${ext}`);
    if (!existsSync(abs)) continue;
    try {
      return statSync(abs).mtime.toISOString();
    } catch {
      // ignore — fall through
    }
  }
  return null;
}

// ── Per-kind proposal resolvers ──────────────────────────────────────────
//
// A resolver turns an `execute`-effect action into a concrete backend
// write that doesn't fit the generic `dispatch_tool` pattern. The
// decide handler invokes the resolver registered for the proposal's
// kind (if any) BEFORE falling back to the dispatch_tool path.
//
// Resolvers receive the proposal row, the resolved action_id (e.g.
// `'acquire' | 'file_only' | 'skip'` for book_candidate), the parsed
// payload, and a MemoryClient handle. They return an object that
// goes straight into `proposals.record_execution(id, outcome)` —
// shape is free-form but ought to include enough to render in the
// audit-log timeline iOS reads.

interface KindResolverInput {
  proposal: import('@core/proposals').ProposalRow;
  action_id: string;
  payload: Record<string, unknown>;
  memory: MemoryClient;
  /** The queue itself — resolvers whose effect retires SIBLING cards (e.g.
   *  face_enrollment expiring other asks about the same cluster) use it.
   *  Optional so bench/court/smoke callers without a store still resolve;
   *  sibling retirement then falls to the nightly retire_stale_cards. */
  proposals?: ProposalsStore;
  /** Person Threads T3 — lets the face_enrollment resolver run the post-naming
   *  harvest/claim/profile steps. Optional; absent → pre-T3 enroll only. */
  db?: import('bun:sqlite').Database;
}
type KindResolver = (input: KindResolverInput) => Promise<Record<string, unknown>>;

/**
 * `book_candidate` resolver — mutates the queue note's
 * `status` field directly, no LLM, no chat turn. Closes the
 * fabrication path Cordelia hit on the present_questions resume
 * (where her persona claimed she'd mutated the note but called no
 * tool). Now the answer-to-action chain is pure backend code.
 *
 * Payload contract: `{ queue_note_path, title_candidate, author_candidate }`.
 * Status mapping:
 *   - `acquire`     → `status: 'queued'`     (04:00 pass picks it up)
 *   - `file_only`   → `status: 'filed_for_reference'`
 *   - `skip`        → `status: 'skipped'`
 */
const book_candidate_resolver: KindResolver = async ({ action_id, payload, memory }) => {
  const queue_note_path = typeof payload.queue_note_path === 'string'
    ? payload.queue_note_path
    : null;
  if (!queue_note_path) {
    throw new Error('book_candidate payload missing queue_note_path');
  }
  const status_map: Record<string, 'queued' | 'filed_for_reference' | 'skipped'> = {
    acquire: 'queued',
    file_only: 'filed_for_reference',
    skip: 'skipped',
  };
  const new_status = status_map[action_id];
  if (!new_status) {
    throw new Error(`book_candidate: unknown action_id ${action_id}`);
  }
  // Read existing frontmatter + body, patch the status field, write back.
  // Reuses the same helper the intake handlers use for clipping
  // wrapper notes — gray-matter parse → merge → write.
  const { patch_clipping_frontmatter } = await import(
    '../../specialists/cordelia/intake/_capture_io'
  );
  patch_clipping_frontmatter(memory, queue_note_path, {
    status: new_status,
    decided_at: new Date().toISOString(),
    decided_action: action_id,
  });
  return {
    queue_note_path,
    new_status,
    action_id,
  };
};

/**
 * `trusted_source_addition` resolver (Slice B — 2026-05-30) — patches
 * a specialist's YAML `trusted_sources.tier_1` or `tier_2` list to
 * include a Cordelia-proposed domain. Uses the YAML Document API
 * (parseDocument → mutate → toString → writeFileSync) so comments
 * and key order survive the round-trip — same pattern Beatrice's
 * `apply_low_risk_fix` and the user-update path use.
 *
 * Action map:
 *   - `add`        → append to the proposed tier's list (idempotent)
 *   - `tier_swap`  → append to the OPPOSITE tier (1↔2). Used when
 *                    the reviewer agrees the domain is trustworthy
 *                    but disagrees with Cordelia's tier judgment.
 *   - `reject`     → no YAML patch. Records the denial in
 *                    `Knowledge/Cordelia/trusted_source_denials.md`
 *                    so Cordelia stops proposing it.
 *
 * SpecialistRegistry's chokidar watcher fires on the YAML write, the
 * new domain is live in seconds, and the next curate-pass pulls
 * sources from the patched manifest.
 *
 * Auto-subscribe (2026-06-10): when the payload carries a
 * `suggested_cadence` (only scout_sources proposals do), an approval
 * ALSO creates the source subscription (sources_store upsert with
 * specialist_id + cadence + the applied tier) so the nightly refresh
 * picks the new domain up immediately — the playbook used to tell
 * Cordelia to `add_trusted_source` "next pass," which drifted.
 * Best-effort: a subscription failure never fails the approval, and a
 * URL already subscribed for a DIFFERENT specialist is left alone
 * (one entry per URL — never steal another rack's entry).
 *
 * Exported for `smoke:scout` (the decide route is the production
 * entry; the smoke exercises the resolver directly against a temp
 * cwd + vault).
 */
export const trusted_source_addition_resolver: KindResolver = async ({
  action_id,
  payload,
  memory,
}) => {
  const target_specialist_id = typeof payload.target_specialist_id === 'string'
    ? payload.target_specialist_id
    : null;
  const domain = typeof payload.domain === 'string' ? payload.domain : null;
  const proposed_tier = payload.tier === 1 || payload.tier === 2
    ? (payload.tier as 1 | 2)
    : null;
  if (!target_specialist_id || !domain || !proposed_tier) {
    throw new Error(
      'trusted_source_addition payload missing target_specialist_id / domain / tier',
    );
  }

  if (action_id === 'reject') {
    const denial_path = 'Knowledge/Cordelia/trusted_source_denials.md';
    const stamp = new Date().toISOString();
    const entry =
      `\n- **${stamp}** — \`${domain}\` proposed for ${target_specialist_id} Tier ${proposed_tier}, ` +
      `denied. Cordelia must not re-propose.\n`;
    memory.append_to_note(denial_path, entry);
    return { target_specialist_id, domain, action: 'denied' };
  }

  // Tier resolves from action: 'add' keeps Cordelia's proposed tier;
  // 'tier_swap' flips to the other one.
  const apply_tier: 1 | 2 = action_id === 'tier_swap'
    ? proposed_tier === 1 ? 2 : 1
    : proposed_tier;

  const { resolve, dirname } = await import('node:path');
  const { readFileSync, writeFileSync, existsSync, mkdirSync } = await import('node:fs');
  const { parseDocument, isMap, isSeq } = await import('yaml');
  const tier_key = apply_tier === 1 ? 'tier_1' : 'tier_2';
  const { trusted_source_overlay_path } = await import('@core/specialist');
  const overlay_path = trusted_source_overlay_path();
  let already = false;
  if (overlay_path) {
    // Learned-source overlay (2026-08-05): approvals land in the DATA-side
    // overlay file the loader merges at load, NOT in the deploy checkout's
    // git-tracked YAML — a checkout write is un-committed learning that the
    // next `git pull --ff-only` refuses over (and a force-pull destroys;
    // 11 of Ruby's learned domains nearly went that way). The registry
    // watches this file, so the approval still hot-applies.
    mkdirSync(dirname(overlay_path), { recursive: true });
    const overlay_doc = existsSync(overlay_path)
      ? parseDocument(readFileSync(overlay_path, 'utf-8'))
      : parseDocument('{}\n');
    const current = (overlay_doc.toJS() ?? {}) as Record<
      string,
      { tier_1?: string[]; tier_2?: string[] }
    >;
    const entry = current[target_specialist_id] ?? {};
    const list = entry[tier_key] ?? [];
    already = list.includes(domain);
    if (!already) list.push(domain);
    entry[tier_key] = list;
    current[target_specialist_id] = entry;
    writeFileSync(
      overlay_path,
      `# Learned trusted-source additions — approved trusted_source_addition\n` +
        `# proposals land here (merged over config/specialists/*.yaml at load).\n` +
        `# Managed by the orchestrator; hand-prune freely.\n` +
        parseDocument(JSON.stringify(current)).toString(),
      'utf-8',
    );
  } else {
    // Legacy path (no overlay dir configured): write the repo YAML.
    const yaml_path = resolve(
      process.cwd(),
      `config/specialists/${target_specialist_id}.yaml`,
    );
    if (!existsSync(yaml_path)) {
      throw new Error(`specialist YAML not found: ${yaml_path}`);
    }
    const text = readFileSync(yaml_path, 'utf-8');
    const doc = parseDocument(text);
    // Ensure trusted_sources.<tier_key> exists. Values must go in as REAL
    // YAML nodes (doc.createNode) — a plain `[]` via map.set stores a bare
    // JS array that fails isSeq and has no .items, which crashed the
    // append below whenever the target tier list was absent (latent since
    // Slice B; surfaced by the tier_swap-into-missing-tier_2 smoke case).
    let ts_node = doc.get('trusted_sources');
    if (!isMap(ts_node)) {
      doc.set('trusted_sources', doc.createNode({ tier_1: [], tier_2: [] }));
      ts_node = doc.get('trusted_sources');
    }
    if (isMap(ts_node) && !isSeq(ts_node.get(tier_key))) {
      ts_node.set(doc.createNode(tier_key), doc.createNode([]));
    }
    const tier_list = isMap(ts_node) ? ts_node.get(tier_key) : null;
    // Idempotency — don't append if already present.
    already = isSeq(tier_list)
      ? tier_list.items.some((it) => {
          const v = typeof it === 'string' ? it : (it as { value?: string })?.value;
          return v === domain;
        })
      : false;
    if (!already && isSeq(tier_list)) {
      tier_list.add(doc.createNode(domain));
    }
    writeFileSync(yaml_path, doc.toString(), 'utf-8');
  }

  // Auto-subscribe on scouted approvals (see doc comment). Best-effort:
  // the YAML patch above is the approval's contract; this is the
  // follow-through that keeps the nightly refresh in sync.
  let subscription: Record<string, unknown> = { created: false };
  const suggested_cadence =
    payload.suggested_cadence === 'daily' ||
    payload.suggested_cadence === 'weekly' ||
    payload.suggested_cadence === 'monthly' ||
    payload.suggested_cadence === 'quarterly'
      ? payload.suggested_cadence
      : null;
  if (suggested_cadence) {
    try {
      const { read_sources, upsert_source } = await import(
        '@specialists/cordelia/sources_store'
      );
      const candidate_url =
        typeof payload.candidate_url === 'string' ? payload.candidate_url : null;
      let sub_url = `https://${domain}/`;
      if (candidate_url) {
        try {
          new URL(candidate_url);
          sub_url = candidate_url;
        } catch {
          /* fall back to the domain root */
        }
      }
      const existing = read_sources(memory).find((e) => e.url === sub_url);
      if (existing?.specialist_id && existing.specialist_id !== target_specialist_id) {
        subscription = {
          created: false,
          skipped: `url already subscribed for ${existing.specialist_id}`,
        };
      } else {
        const title =
          typeof payload.candidate_title === 'string' ? payload.candidate_title : null;
        upsert_source(memory, {
          url: sub_url,
          description: title ?? `Scouted source for ${target_specialist_id}`,
          tags: ['scouted'],
          specialist_id: target_specialist_id,
          cadence: suggested_cadence,
          tier: apply_tier,
          seeded_by: 'scout-approval',
        });
        subscription = { created: true, url: sub_url, cadence: suggested_cadence };
      }
    } catch (err) {
      console.error(
        '[proposals] trusted_source_addition auto-subscribe failed (approval unaffected):',
        err,
      );
      subscription = { created: false, error: (err as Error).message };
    }
  }

  return {
    target_specialist_id,
    domain,
    applied_tier: apply_tier,
    proposed_tier,
    swapped: action_id === 'tier_swap',
    already_present: already === true,
    // Where the addition physically landed: the data-side overlay when
    // configured, else the legacy in-checkout YAML.
    yaml_path:
      overlay_path ?? resolve(process.cwd(), `config/specialists/${target_specialist_id}.yaml`),
    subscription,
  };
};

const KIND_RESOLVERS: Record<string, KindResolver> = {
  book_candidate: book_candidate_resolver,
  trusted_source_addition: trusted_source_addition_resolver,
  // Future: draft_message.send, calendar_event.add, persona_tuning.apply,
  // binding_proposal.open_pr, etc. — when their flow lands. Today
  // those still flow through dispatch_tool or stub paths below.
};

/**
 * Is this approved proposal a Beatrice (trainer) build — one that should be
 * implemented as code/config via a directed build?
 *
 * The clean signal is `specialist_id==='trainer'` + a build kind. But the weak
 * chat tier mis-stamps both: the 2026-06-07 `update_workstation_sku` proposals
 * landed as `kind:'action_proposal'` AND `specialist_id:'kate'` (the chat the
 * user was in), so the narrow gate missed them. So we ALSO sniff the parsed
 * payload for the build signals the chat model can't drop: a binding-proposal
 * markdown path, a `propose_code_change`/`propose_code_edit` dispatch, or an
 * embedded category_signature owned by trainer. Structured field checks — not
 * a stringified-payload match — so it stays explainable.
 */
export function is_beatrice_build_proposal(p: ProposalRow): boolean {
  const BUILD_KINDS = new Set(['recommendation', 'binding_proposal', 'persona_tuning']);

  let payload: Record<string, unknown> | null = null;
  try {
    const parsed = JSON.parse(p.payload_json) as unknown;
    payload = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    payload = null;
  }

  // A MERGE CARD IS NOT A BUILD REQUEST. review_change files the owner's merge
  // card as kind:'recommendation' + specialist_id:'trainer', which satisfies the
  // build fast-path below — so approving a merge fell through into the directed-
  // build fan-out and fired a SPURIOUS second build for a change that was just
  // merged. Latent before the consolidation (the stray build ran as 'trainer');
  // after it, that build runs on the build agent's chain. Excluded first, before
  // any other signal, so neither the id fast-path nor the dispatch sniff can
  // re-admit it.
  const dispatchRaw = payload?.dispatch_tool as unknown;
  const dispatchTool =
    typeof dispatchRaw === 'string'
      ? dispatchRaw
      : ((dispatchRaw as { action?: string; name?: string; tool?: string } | undefined)?.action ??
        (dispatchRaw as { name?: string } | undefined)?.name ??
        (dispatchRaw as { tool?: string } | undefined)?.tool);
  if (dispatchTool === 'merge_approved_change') return false;

  // The build actor is Kate post-consolidation (2026-07-21) but historical and
  // ledger-filed specs are still stamped 'trainer', so BOTH ids are build
  // authors. Without the 'kate' arm, approving one of her own specs silently
  // stops dispatching — it falls to the catch-all mark_acknowledged and just
  // looks "handled" while nothing is ever built.
  if (
    (p.specialist_id === BUILD_LEDGER_ID || p.specialist_id === BUILD_AGENT_ID) &&
    BUILD_KINDS.has(p.kind)
  )
    return true;

  if (!payload) return false;

  const sig = payload.category_signature as { specialist_id?: string } | undefined;
  if (sig && typeof sig === 'object' && sig.specialist_id === 'trainer') return true;

  // dispatchTool was already normalized above for the merge-card exclusion.
  if (dispatchTool === 'propose_code_change' || dispatchTool === 'propose_code_edit') return true;

  const slug = payload.slug as { rel_path?: string } | undefined;
  const relPath = (typeof slug === 'object' ? slug?.rel_path : undefined) ?? (payload.rel_path as string | undefined);
  if (typeof relPath === 'string' && relPath.includes('binding-proposals/')) return true;

  return false;
}

/**
 * A hiring packet (Kate's propose_hire) is a `recommendation`-kind proposal
 * whose payload is a full HiringPacket. Its `approved` status is a meaningful
 * INTERMEDIATE state — `/from-packet` materializes the specialist and only
 * then stamps the proposal `executed` — so the decide route's terminal
 * acknowledgment MUST skip it, or `/from-packet` would refuse a packet it
 * just acknowledged out from under itself.
 */
function is_hiring_packet_proposal(p: ProposalRow): boolean {
  if (p.kind !== HIRING_PROPOSAL_KIND) return false;
  try {
    return HiringPacketSchema.safeParse(JSON.parse(p.payload_json)).success;
  } catch {
    return false;
  }
}

/** Caps on the inlined build context. The payload/spec are the WORK ORDER, so
 *  they get real room; the caps only stop a pathological payload from eating
 *  the pass's whole context window. Overflow is labeled, and
 *  `read_proposal_by_id` covers anything past the cap. */
const INLINE_PAYLOAD_CAP = 6_000;
const INLINE_SPEC_CAP = 10_000;
const INLINE_RATIONALE_CAP = 3_000;

function _capped(text: string, cap: number, label: string): string {
  if (text.length <= cap) return text;
  return text.slice(0, cap) + `\n…[${label} truncated at ${cap} chars — read_proposal_by_id has the rest]`;
}

/**
 * The directive handed to Beatrice's directed build when the owner approves
 * one of her build proposals. Front-loads the existence check (skipping it is
 * exactly what produced the update_workstation_sku duplicate) before any
 * authoring. `{{user_name}}` is substituted by the deliberation runtime.
 *
 * INLINES the proposal payload + rationale + any binding-proposal markdown
 * (2026-08-11 postmortem): the old text said "re-read the proposal", but
 * `read_my_proposals` can't see foreign-authored or terminal proposals — the
 * proposal is `acknowledged` by the time the build fires — so every stock
 * build burned rounds hunting for a record it could not reach, then blanked.
 * The directive IS the work order; it carries its own content (the pattern
 * the hand-fired recovery builds proved out). This is task handoff, not
 * pre-injection: the model still does all discovery/design/authoring with
 * its tools, and `read_proposal_by_id` covers anything beyond the inline
 * caps.
 */
export function directed_build_instruction(
  p: ProposalRow,
  opts: { vault_root?: string } = {},
): string {
  const titled = p.title ? `: "${p.title}"` : '';

  // Pretty-print the payload when it parses; fall back to the raw JSON.
  let payload_block = p.payload_json;
  let payload: Record<string, unknown> | null = null;
  try {
    const parsed = JSON.parse(p.payload_json) as unknown;
    if (parsed && typeof parsed === 'object') {
      payload = parsed as Record<string, unknown>;
      payload_block = JSON.stringify(parsed, null, 2);
    }
  } catch {
    /* raw string stands */
  }

  // Binding-proposal spec markdown, when the payload names one and it exists
  // under the vault. Best-effort + fail-open: an unreadable spec degrades to
  // the payload alone, never a throw (this renders inside approve/court paths).
  let spec_section = '';
  const slug = payload?.slug as { rel_path?: string } | undefined;
  const rel_path =
    (typeof slug === 'object' ? slug?.rel_path : undefined) ??
    (typeof payload?.rel_path === 'string' ? (payload.rel_path as string) : undefined);
  if (rel_path && rel_path.includes('binding-proposals/') && opts.vault_root) {
    try {
      const { existsSync, readFileSync } = require('node:fs') as typeof import('node:fs');
      const { resolve, normalize } = require('node:path') as typeof import('node:path');
      const normalized = normalize(rel_path);
      if (!normalized.startsWith('..') && !normalized.includes('/../')) {
        const abs = resolve(opts.vault_root, normalized);
        if (abs.startsWith(resolve(opts.vault_root)) && existsSync(abs)) {
          spec_section =
            `\n## The binding-proposal spec (\`${normalized}\`, inlined)\n\n` +
            _capped(readFileSync(abs, 'utf-8'), INLINE_SPEC_CAP, 'spec') +
            `\n`;
        }
      }
    } catch (err) {
      console.warn(`[directed-build] could not inline spec ${rel_path}:`, err);
    }
  }

  return [
    `{{user_name}} just APPROVED your ${p.kind} proposal \`${p.id}\`${titled}.`,
    `This pass runs on your strong model with your authoring tools`,
    `(propose_code_edit / propose_code_change) in hand — implement it.`,
    ``,
    `Everything you need is INLINED below — the proposal record is already`,
    `terminal (acknowledged), so read_my_proposals will NOT show it. Do not`,
    `spend rounds hunting for it; if you need a field past a truncation`,
    `marker, call read_proposal_by_id with id '${p.id}'.`,
    ``,
    `## The approved proposal (inlined)`,
    ``,
    `### Rationale`,
    ``,
    _capped(p.rationale_md || '(none recorded)', INLINE_RATIONALE_CAP, 'rationale'),
    ``,
    `### Payload`,
    ``,
    '```json',
    _capped(payload_block, INLINE_PAYLOAD_CAP, 'payload'),
    '```',
    spec_section,
    `## How to proceed`,
    ``,
    `STEP 1 — VERIFY IT ISN'T ALREADY BUILT (mandatory; skipping this is what`,
    `produced the update_workstation_sku duplicate of the existing update_sku).`,
    `Search by FUNCTION, not the proposed name: grep_codebase for the behavior`,
    `and the store method, read_codebase_file the relevant store/tool to confirm`,
    `the gap is real, and run analyze_capability_gaps on any named capability`,
    `token. If a tool already does this (possibly under a DIFFERENT name), STOP —`,
    `do not build a duplicate; reply that it already exists (and if it just needs`,
    `surfacing/granting, file apply_low_risk_fix instead).`,
    ``,
    `STEP 2 — If the gap is genuinely real, implement it. The payload + spec`,
    `above are the work order — implement what THEY say, not a paraphrase.`,
    `MODIFY an existing file with propose_code_edit (read it first`,
    `so each old_string is byte-exact); CREATE a new file with`,
    `propose_code_change (full contents). Use branch_name 'beatrice/<slug>', a`,
    `pr_title/pr_body linking the proposal, and related_proposal_id: '${p.id}'.`,
    `If the checks gate rejects your PR, fix exactly what the error names and`,
    `re-file with propose_code_edit — never re-submit identical input (the`,
    `second identical failure ends the pass).`,
    ``,
    `STEP 3 — Once the PR opens you are DONE. Kate's list_changes_for_review`,
    `surfaces it automatically for her skeptic review; {{user_name}} merges from`,
    `the Code Shop. Do not re-file the proposal.`,
  ].join('\n');
}

/**
 * The execution side effects for an APPROVED proposal — the exact machinery
 * the owner's tap runs after `ProposalsStore.decide()` reports
 * `should_execute` (extracted from the decide route 2026-07-02 so the
 * trust-teeth auto-executor runs the SAME path, never a parallel one).
 * Three paths in priority order, each writing its own audit rows +
 * `record_execution` exactly as the route always did:
 *
 *   1. `resolver` — the kind's registered KIND_RESOLVER (a deterministic
 *      backend write that doesn't fit the dispatch_tool pattern).
 *   2. `dispatch` — payload carries `{dispatch_tool, dispatch_input}`;
 *      the tool registry runs it as the author specialist.
 *   3. `stub` — neither; `would_have_executed` is recorded.
 */
export interface ProposalEffectsDeps {
  proposals: ProposalsStore;
  memory: MemoryClient;
  specialists: SpecialistRegistry;
  tools: ToolRegistry;
  llm: LLMRouter;
  /** Person Threads T3 — forwarded to the face_enrollment resolver for the
   *  post-naming harvest/claim/profile steps. Optional; absent → enroll only. */
  db?: Database;
}

export type ProposalExecutionOutcome =
  | { path: 'resolver'; ok: true; outcome: Record<string, unknown> }
  | { path: 'resolver'; ok: false; error: string }
  | { path: 'dispatch'; ok: boolean; error?: string }
  | { path: 'stub' };

export async function execute_approved_proposal(
  deps: ProposalEffectsDeps,
  id: string,
  resolved_action_id: string,
): Promise<ProposalExecutionOutcome> {
  const proposal = deps.proposals.get(id);
  let payload: Record<string, unknown> = {};
  if (proposal) {
    try {
      payload = JSON.parse(proposal.payload_json) as Record<string, unknown>;
    } catch {
      /* ignore */
    }
  }

  // (1) Kind-specific resolver — handles the effect for kinds whose
  // decision produces a deterministic backend write that doesn't fit
  // the dispatch_tool pattern.
  const kind_resolver = KIND_RESOLVERS[proposal?.kind ?? ''];
  if (proposal && kind_resolver) {
    try {
      const outcome = await kind_resolver({
        proposal,
        action_id: resolved_action_id,
        payload,
        memory: deps.memory,
        proposals: deps.proposals,
        db: deps.db,
      });
      deps.memory.log_action({
        intent_id: ulid(),
        agent: 'orchestrator',
        tool_name: 'proposal_resolver',
        tool_input: {
          proposal_id: id,
          kind: proposal.kind,
          action_id: resolved_action_id,
        },
        execution_result: outcome,
      });
      deps.proposals.record_execution(id, outcome);
      return { path: 'resolver', ok: true, outcome };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      deps.memory.log_action({
        intent_id: ulid(),
        agent: 'orchestrator',
        tool_name: 'proposal_resolver',
        tool_input: {
          proposal_id: id,
          kind: proposal.kind,
          action_id: resolved_action_id,
        },
        error: msg,
      });
      deps.proposals.record_execution(id, { error: msg }, msg);
      return { path: 'resolver', ok: false, error: msg };
    }
  }

  const dispatch_tool = typeof payload.dispatch_tool === 'string' ? payload.dispatch_tool : null;
  const dispatch_input = (payload.dispatch_input ?? {}) as Record<string, unknown>;

  if (dispatch_tool && proposal) {
    const specialist = deps.specialists.get(proposal.specialist_id);
    if (!specialist) {
      deps.proposals.record_execution(
        id,
        { error: `specialist ${proposal.specialist_id} not loaded` },
        `specialist not loaded`,
      );
      return { path: 'dispatch', ok: false, error: 'specialist not loaded' };
    }
    const intent_id = ulid();
    const tool_ctx = {
      memory: deps.memory,
      llm: deps.llm,
      now: new Date(),
      intent_id,
    };
    try {
      const outcome = await deps.tools.invoke(
        dispatch_tool,
        dispatch_input,
        tool_ctx,
        specialist.granted,
        specialist.id,
      );
      deps.memory.log_action({
        intent_id,
        agent: specialist.id,
        tool_name: 'proposal_dispatch',
        tool_input: { proposal_id: id, dispatch_tool, dispatch_input },
        execution_result: outcome.ok ? outcome.result : undefined,
        error: outcome.error,
      });
      if (outcome.ok) {
        deps.proposals.record_execution(id, outcome.result);
        return { path: 'dispatch', ok: true };
      }
      deps.proposals.record_execution(
        id,
        { error: outcome.error, reason: outcome.reason },
        outcome.error ?? 'dispatch failed',
      );
      return { path: 'dispatch', ok: false, error: outcome.error };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      deps.memory.log_action({
        intent_id,
        agent: specialist.id,
        tool_name: 'proposal_dispatch',
        tool_input: { proposal_id: id, dispatch_tool, dispatch_input },
        error: msg,
      });
      deps.proposals.record_execution(id, { error: msg }, msg);
      return { path: 'dispatch', ok: false, error: msg };
    }
  }

  // No dispatch_tool in payload — legacy stub path.
  deps.memory.log_action({
    intent_id: ulid(),
    agent: 'orchestrator',
    tool_name: 'would_have_executed',
    tool_input: { proposal_id: id, execution_kind: proposal?.execution_kind ?? null },
    execution_result: {
      stub: true,
      reason: 'proposal has no dispatch_tool payload — legacy path',
    },
  });
  deps.proposals.record_execution(id, {
    stub: true,
    reason: 'no dispatch_tool in payload',
  });
  return { path: 'stub' };
}

export function create_specialists_router(deps: SpecialistRoutesDeps): Hono {
  const r = new Hono();

  // Per-conversation cancel controllers. While a specialist turn is
  // in flight for a conversation, the AbortController is registered
  // here so /conversations/:id/cancel can interrupt it — both
  // user-initiated message turns and scheduler-driven follow-ups.
  // Cleared in `finally` after the turn settles (success or abort).
  const active_turns = new Map<string, AbortController>();

  // Per-conversation FIFO serialization. New turns for the SAME
  // conversation wait for the prior turn to complete instead of
  // aborting it. Pre-2026-05-27 the chat route did
  // `active_turns.get(id)?.abort(); active_turns.set(id, controller)` —
  // "newer wins" — which produced the user-visible bug where typing
  // "??" mid-turn cancelled the in-flight reply and persisted
  // "(stopped)" as the specialist message. With this queue, the
  // nudge is processed AFTER the original turn lands its reply.
  // Different conversations still run concurrently (they get
  // independent entries). The cancel endpoint still works on the
  // currently-running turn — explicit user-initiated cancel is the
  // ONLY legitimate path to a "(stopped)" message now.
  const turn_queues = new Map<string, Promise<unknown>>();

  /**
   * Serialize work per conversation. Awaits any prior in-flight or
   * queued work for the same conversation_id, runs the supplied
   * thunk, then surrenders the tail. Errors from prior callers
   * don't block us — each caller's promise carries its own error
   * to its own awaiter.
   */
  async function serialize_per_conversation<T>(
    conversation_id: string,
    work: () => Promise<T>,
  ): Promise<T> {
    const prior = turn_queues.get(conversation_id);
    let resolve_mine!: () => void;
    const mine = new Promise<void>((r) => {
      resolve_mine = r;
    });
    turn_queues.set(conversation_id, mine);
    try {
      if (prior) {
        if (process.env.HEARTH_DEBUG_TURN_QUEUE === '1') {
          console.log(
            `[turn-queue] ${conversation_id}: waiting for prior turn`,
          );
        }
        await prior.catch(() => {});
      }
      return await work();
    } finally {
      resolve_mine();
      if (turn_queues.get(conversation_id) === mine) {
        turn_queues.delete(conversation_id);
      }
    }
  }

  // ── Specialists ──────────────────────────────────────────────────────

  r.get('/specialists', (c) => {
    // Look up each specialist's last_visited and any unread-since-visit count.
    const visits = new Map<string, string>();
    const rows = deps.db
      .prepare(`SELECT specialist_id, ts_last_visited FROM specialist_visits`)
      .all() as Array<{ specialist_id: string; ts_last_visited: string }>;
    for (const r of rows) visits.set(r.specialist_id, r.ts_last_visited);

    // Authenticity scores from the most recent scan_specialist_authenticity
    // run (rows are upserted, so the row IS the latest). Specialists with
    // no scan history yet → null score, rendered as a neutral pill.
    const scores = new Map<string, { score: number; ts: string; turns: number }>();
    const score_rows = deps.db
      .prepare(
        `SELECT specialist_id, score, ts_computed, turns_in_window
           FROM authenticity_scores`,
      )
      .all() as Array<{
      specialist_id: string;
      score: number;
      ts_computed: string;
      turns_in_window: number;
    }>;
    for (const sr of score_rows) {
      scores.set(sr.specialist_id, {
        score: sr.score,
        ts: sr.ts_computed,
        turns: sr.turns_in_window,
      });
    }

    // Phase 2a: filter to the user's allowed_specialists. '*' = full
    // roster (admin / primary user). An empty array shows none, but
    // the empty-state in the staff rail is friendlier than a 403.
    const user = c.get('user');
    const allowed = user && deps.users
      ? (u => u.allowed_specialists)(user)
      : '*';

    // Per-user UI prefs (favorites + sort_order). One query, looked
    // up per row below. Absent row = not favorited, no explicit
    // position — iOS falls back to alphabetic via the existing tail
    // sort. See structured.ts `specialist_prefs` table.
    const prefs_map = new Map<string, { favorited: boolean; sort_order: number | null }>();
    if (user) {
      const prefs_rows = deps.db
        .prepare(
          `SELECT specialist_id, favorited, sort_order
             FROM specialist_prefs WHERE user_id = @uid`,
        )
        .all({ '@uid': user.id }) as Array<{
        specialist_id: string;
        favorited: number;
        sort_order: number | null;
      }>;
      for (const p of prefs_rows) {
        prefs_map.set(p.specialist_id, {
          favorited: p.favorited === 1,
          sort_order: p.sort_order,
        });
      }
    }

    const list = deps.specialists.list()
      // Kate sub-agents: a subagent_only profile is delegable staff, not a
      // user-facing roster entry — hide it from the /app + iOS rosters.
      .filter((s) => !s.subagent_only)
      .filter((s) => allowed === '*' || allowed.includes(s.id))
      .map((s) => {
      const ts_last_visited = visits.get(s.id) ?? null;
      // Unread = USER-FACING chat messages from this specialist
      // since the caller last opened their thread. Counts the
      // `messages` table where role='specialist' and
      // specialist_id = @sid; joins conversations to scope by
      // user_id so a household member's badge reflects THEIR
      // unread, not the whole house's.
      //
      // **Important contract:** this is the badge surface for iOS
      // Staff roster / Today / app icon. It MUST NOT include
      // specialist↔specialist coordination (consults, FYIs, flags
      // in `specialist_inboxes`) — that traffic is internal and
      // surfaces on the specialist's profile sheet, never on a
      // badge. The prior query against `specialist_inboxes`
      // inflated this count with internal-only activity and
      // produced the "badge with no chat content" symptom:
      // Maggie consults Kate → Kate's roster row badges → user
      // opens Kate's chat → nothing there. See
      // [[hearth-inbox-vs-chat-architecture]] in user-memory and
      // hearth-ios/IOS_REFINEMENT_PASS.md #1.
      const since_clause = ts_last_visited
        ? `AND m.ts > @since`
        : '';
      const user_clause = user ? `AND c.user_id = @uid` : '';
      const params: Record<string, SqlBind> = { '@sid': s.id };
      if (ts_last_visited) params['@since'] = ts_last_visited;
      if (user) params['@uid'] = user.id;
      const unread = (deps.db
        .prepare(
          // Voice-call replies are excluded from the badge: when the user
          // is live on a voice call they've already heard the reply,
          // so counting it as "unread" is wrong — but it still belongs in
          // the transcript (list_messages returns every surface). The
          // `surface IS NULL OR != 'voice'` form is needed because in
          // SQLite `'voice' != NULL` is NULL (not true), so a plain
          // `!= 'voice'` would drop legacy null-surface rows.
          `SELECT COUNT(*) as n
             FROM messages m
             JOIN conversations c ON c.id = m.conversation_id
            WHERE m.specialist_id = @sid
              AND m.role = 'specialist'
              AND (m.surface IS NULL OR m.surface != 'voice')
              ${user_clause}
              ${since_clause}`,
        )
        .get(params) as { n: number } | undefined)?.n ?? 0;
      const sc = scores.get(s.id) ?? null;
      return {
        id: s.id,
        name: s.name,
        role: s.role,
        // Probe the filesystem for the actual file — yaml-declared
        // path OR the conventional Knowledge/<Capitalized>/avatar.*
        // fallback. iOS gates the avatar fetch on this field being
        // non-null, so a real PNG-on-disk without a yaml declaration
        // used to be invisible (Mariah, 2026-05-27).
        avatar: resolve_avatar_relpath(deps.memory, s.avatar, s.id),
        // Content-version of the on-disk avatar / banner files.
        // iOS folds these into AvatarCache + BannerCache disk-cache
        // keys so a re-rolled portrait auto-invalidates without a
        // manual refresh button. nil when the file doesn't exist —
        // iOS reduces to the path-only key in that case (back-compat
        // with builds that pre-date this field).
        avatar_modified_at: resolve_avatar_modified_at(deps.memory, s.avatar, s.id),
        banner_modified_at: resolve_banner_modified_at(deps.memory, s.id),
        voice: s.voice,
        default_landing: s.default_landing,
        knowledge_scope: s.knowledge_scope,
        proactive: s.proactive,
        ts_last_visited,
        unread_since_visit: unread,
        authenticity: sc
          ? { score: sc.score, ts_computed: sc.ts, turns_in_window: sc.turns }
          : null,
        // Stage 0 of the Specialist-as-Room shift — see
        // ~/Projects/hearth-ios/SPECIALIST_AS_ROOM_BRIEF.md. Derived
        // on demand from each producer's existing data source
        // (workout_sessions / music_context / audit_log / briefs).
        // null collapses to "Quiet" on the iOS card.
        active_status: user
          ? compute_active_status(deps.db, s.id, user.id)
          : null,
        // Stage 2 of Specialist-as-Room. When non-null, iOS routes
        // the bento / roster tap to SpecialistRoomView which
        // fetches /api/specialists/:id/pane. Null keeps the legacy
        // chat-first tap behavior.
        pane_kind: s.pane_kind ?? null,
        // Per-user UI prefs. Absent fields = unset; iOS treats nil
        // favorited as false and nil sort_order as "alphabetic tail."
        // See POST /specialists/:id/favorite + POST /specialists/order
        // below for the mutations.
        favorited: prefs_map.get(s.id)?.favorited ?? false,
        sort_order: prefs_map.get(s.id)?.sort_order ?? null,
      };
    });
    // Sort by sort_order (NULLS LAST), then alphabetic by name. The
    // SAME order applies to Today (filtered to favorited) and Staff
    // (full list) — per the "one shared sort_order" design decision.
    list.sort((a, b) => {
      const ao = a.sort_order;
      const bo = b.sort_order;
      if (ao != null && bo != null) {
        if (ao !== bo) return ao - bo;
        return a.name.localeCompare(b.name);
      }
      if (ao != null) return -1;
      if (bo != null) return 1;
      return a.name.localeCompare(b.name);
    });
    return c.json({ specialists: list });
  });

  /**
   * Toggle a specialist as favorited / unfavorited for the caller.
   * Idempotent upsert; the iOS star button POSTs the desired state
   * (not a delta) so retries are safe. Emits `specialist_prefs_changed`
   * so other surfaces re-sort without a full roster refetch.
   * Falls back to a 401 if no user is on the request — favorites are
   * inherently per-user; there is no anonymous default.
   */
  r.post('/specialists/:id/favorite', async (c) => {
    const id = c.req.param('id');
    if (!deps.specialists.has(id)) return c.json({ error: `unknown specialist: ${id}` }, 404);
    const user = c.get('user');
    if (!user) return c.json({ error: 'authentication required' }, 401);
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }
    const parsed = z.object({ favorited: z.boolean() }).safeParse(body);
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    const favorited = parsed.data.favorited ? 1 : 0;
    const now = new Date().toISOString();
    deps.db
      .prepare(
        `INSERT INTO specialist_prefs (user_id, specialist_id, favorited, sort_order, updated_at)
         VALUES (@uid, @sid, @fav, NULL, @ts)
         ON CONFLICT(user_id, specialist_id) DO UPDATE SET
           favorited = @fav,
           updated_at = @ts`,
      )
      .run({ '@uid': user.id, '@sid': id, '@fav': favorited, '@ts': now });
    deps.events?.emit({
      type: 'specialist_prefs_changed',
      user_id: user.id,
      specialist_id: id,
      kind: 'favorited',
    });
    return c.json({ specialist_id: id, favorited: favorited === 1 });
  });

  /**
   * Replace the caller's full specialist ordering. Body carries the
   * complete ordered id list — assignment is positional (index 0
   * gets sort_order = 0, etc.). Atomic via a single transaction.
   * Unknown specialist ids are rejected (400) rather than silently
   * dropped so a stale client doesn't end up with a phantom sort
   * key. Specialists absent from the payload have their sort_order
   * cleared back to NULL (alphabetic tail), preserving their
   * favorited flag.
   */
  r.post('/specialists/order', async (c) => {
    const user = c.get('user');
    if (!user) return c.json({ error: 'authentication required' }, 401);
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }
    const parsed = z
      .object({ specialist_ids: z.array(z.string().min(1)).max(64) })
      .safeParse(body);
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    const unknown_ids = parsed.data.specialist_ids.filter((id) => !deps.specialists.has(id));
    if (unknown_ids.length > 0) {
      return c.json({ error: `unknown specialist ids: ${unknown_ids.join(', ')}` }, 400);
    }
    const now = new Date().toISOString();
    const tx = deps.db.transaction((ids: string[]) => {
      // Clear sort_order for everyone (preserves favorited).
      deps.db
        .prepare(
          `UPDATE specialist_prefs SET sort_order = NULL, updated_at = @ts WHERE user_id = @uid`,
        )
        .run({ '@uid': user.id, '@ts': now });
      // Upsert the new positional order. Index becomes sort_order.
      const stmt = deps.db.prepare(
        `INSERT INTO specialist_prefs (user_id, specialist_id, favorited, sort_order, updated_at)
         VALUES (@uid, @sid, 0, @ord, @ts)
         ON CONFLICT(user_id, specialist_id) DO UPDATE SET
           sort_order = @ord,
           updated_at = @ts`,
      );
      for (let i = 0; i < ids.length; i++) {
        const sid = ids[i] as string;
        stmt.run({ '@uid': user.id, '@sid': sid, '@ord': i, '@ts': now });
      }
    });
    tx(parsed.data.specialist_ids);
    deps.events?.emit({
      type: 'specialist_prefs_changed',
      user_id: user.id,
      kind: 'reordered',
    });
    return c.json({ count: parsed.data.specialist_ids.length });
  });

  r.post('/specialists/:id/visited', (c) => {
    const id = c.req.param('id');
    if (!deps.specialists.has(id)) return c.json({ error: `unknown specialist: ${id}` }, 404);
    const ts = new Date().toISOString();
    deps.db
      .prepare(
        `INSERT INTO specialist_visits (specialist_id, ts_last_visited)
         VALUES (@sid, @ts)
         ON CONFLICT(specialist_id) DO UPDATE SET ts_last_visited = @ts`,
      )
      .run({ '@sid': id, '@ts': ts });
    deps.events?.emit({
      type: 'specialist_visited',
      specialist_id: id,
      ts_last_visited: ts,
    });
    return c.json({ specialist_id: id, ts_last_visited: ts });
  });

  // Hearth rank badge — the specialist's copper→diamond standing + level + XP
  // bar, for the chat-header + office badge. Specialist-global (not per-user —
  // a rank is the specialist's standing, not the caller's data), so no cordon.
  // Gated by HEARTH_TRUST_XP: off → { enabled: false } and the client hides it.
  r.get('/specialists/:id/rank', (c) => {
    const id = c.req.param('id');
    if (!deps.specialists.has(id)) return c.json({ error: `unknown specialist: ${id}` }, 404);
    if (!trust_xp_enabled()) return c.json({ enabled: false });
    return c.json({ enabled: true, specialist_id: id, ...deps.proposals.specialist_rank(id) });
  });

  // Live-subagents tray (2026-07-14): the specialist's recent delegations,
  // cordoned per caller by the store's own read (a household member sees only
  // delegations their own asks originated; the owner also sees system ones).
  // The SSE delegation_* events are content-free triggers; THIS is where the
  // GUI fetches task text + digest previews under auth.
  r.get('/specialists/:id/delegations', (c) => {
    const id = c.req.param('id');
    if (!deps.specialists.has(id)) return c.json({ error: `unknown specialist: ${id}` }, 404);
    const user = c.get('user');
    const limit_raw = Number(c.req.query('limit') ?? '15');
    const limit = Number.isFinite(limit_raw) ? limit_raw : 15;
    const rows = new DelegationStore(deps.db).list_recent(
      id,
      { user_id: user?.id ?? null, is_owner: !user || user.tier === 'owner' },
      limit,
    );
    return c.json({
      specialist_id: id,
      delegations: rows.map((r) => ({
        id: r.id,
        profile_id: r.profile_id,
        profile_name: deps.specialists.get(r.profile_id)?.name ?? r.profile_id,
        task: r.task.slice(0, 240),
        status: r.status,
        mode: r.mode,
        conversation_id: r.conversation_id,
        created_at: r.created_at,
        completed_at: r.completed_at,
        digest_preview: r.digest_md ? r.digest_md.slice(0, 500) : null,
        error: r.error,
      })),
    });
  });

  // Review swarm (2026-07-21) — the bee icon / web Code Shop panel's foreground
  // catch-up: runs in flight (or judged in the last window) with their findings.
  // Reviews are global (over code changes, not per-specialist), so :id is
  // ignored — the client hits /api/specialists/trainer/swarm/active.
  r.get('/specialists/:id/swarm/active', (c) => {
    const reviews = new SwarmReviewStore(deps.db).list_active();
    return c.json({
      reviews: reviews.map((rv) => ({
        review_id: rv.id,
        change_id: rv.change_id,
        title: rv.title,
        status: rv.status,
        verdict: rv.verdict,
        // 'bench' vs 'higher_court' + the review being appealed — lets a client
        // that reconnects mid-case group the appeal under its bench instead of
        // rendering it as an unrelated second review.
        tier: rv.tier,
        escalated_from: rv.escalated_from,
        started_at: rv.started_at,
        judged_at: rv.judged_at,
        // Coarse per-seat phase — live phase rides the SSE events; the refetch
        // only needs running-vs-done for reconnect reconciliation.
        seats: rv.bench.map((b) => ({
          seat_id: b.seat_id,
          role: b.role,
          phase: rv.verdict ? 'done' : 'working',
          summary: null,
        })),
        findings: rv.findings.map((f) => ({
          seat_id: f.seat_id,
          severity: f.severity,
          summary: f.summary,
          refuted: f.refuted,
        })),
      })),
    });
  });

  r.get('/specialists/:id', (c) => {
    const id = c.req.param('id');
    const s = deps.specialists.get(id);
    if (!s) return c.json({ error: 'specialist not found' }, 404);
    const user = c.get('user');
    // Recent work surface — three rails merged into one timeline so
    // the iOS profile sheet (and any other consumer) can render the
    // "what is this specialist actually doing" view without making
    // three separate calls. This is the home for specialist↔specialist
    // coordination (consults, flags, FYIs) — that traffic must
    // NEVER drive user-facing badges (see the unread_since_visit
    // SQL on `/api/specialists`); the profile is the legitimate
    // surface for it.
    //
    // Sources merged (sorted by timestamp desc, capped at 20):
    //   - `specialist_inboxes` for items to/from this specialist
    //     (kind=inbox_received / inbox_sent; status from
    //     actioned_at: null → pending, non-null → completed)
    //   - `proposals` authored by this specialist (status from
    //     the row's status column directly)
    //   - `briefs` generated by this specialist (status: completed
    //     if consumed_at present, else pending)
    type RecentWorkRow = {
      id: string;
      kind: string;
      status: string;
      title: string;
      timestamp: string;
      related_id: string | null;
    };
    const recent_work: RecentWorkRow[] = [];

    // Per-user cordon (mirrors the proposals cordon below): an owner sees
    // this specialist's system/shared traffic (originating_user_id NULL) plus
    // their own; a non-owner sees only their own. WITHOUT this, the profile's
    // recent-activity rail leaked a friend's routed-capture flags (e.g.
    // "Cordelia routed 4 ski captures to Vivian", originating_user_id = a
    // friend) into the OWNER's view — the per-user cordon must hold on every
    // surface that reads user-scoped rows, not just retrieval/brief.
    const rw_user = c.get('user');
    const inbox_cordon = rw_user
      ? rw_user.tier === 'owner'
        ? 'AND (originating_user_id IS NULL OR originating_user_id = @uid)'
        : 'AND originating_user_id = @uid'
      : 'AND originating_user_id IS NULL';
    const inbox_rows = deps.db
      .prepare(
        `SELECT id, ts, from_specialist_id, to_specialist_id, kind,
                substr(body_md, 1, 140) AS body_preview,
                actioned_at, related_proposal_id
           FROM specialist_inboxes
          WHERE (to_specialist_id = @sid OR from_specialist_id = @sid) ${inbox_cordon}
          ORDER BY ts DESC
          LIMIT 20`,
      )
      .all({ '@sid': id, ...(rw_user ? { '@uid': rw_user.id } : {}) }) as Array<{
      id: string;
      ts: string;
      from_specialist_id: string;
      to_specialist_id: string;
      kind: string;
      body_preview: string;
      actioned_at: string | null;
      related_proposal_id: string | null;
    }>;
    for (const row of inbox_rows) {
      const direction = row.to_specialist_id === id ? 'inbox_received' : 'inbox_sent';
      const peer = row.to_specialist_id === id ? row.from_specialist_id : row.to_specialist_id;
      const peer_name = deps.specialists.get(peer)?.name ?? peer;
      const title =
        direction === 'inbox_received'
          ? `${row.kind} from ${peer_name}: ${row.body_preview.trim()}`
          : `${row.kind} to ${peer_name}: ${row.body_preview.trim()}`;
      recent_work.push({
        id: row.id,
        kind: direction,
        status: row.actioned_at ? 'completed' : 'pending',
        title,
        timestamp: row.ts,
        related_id: row.related_proposal_id ?? row.id,
      });
    }

    // Per-user cordon: an owner sees this specialist's system proposals
    // (user_id NULL) plus their own; a non-owner sees only their own.
    // (rw_user resolved above for the inbox cordon.)
    const rw_cordon = rw_user
      ? rw_user.tier === 'owner'
        ? 'AND (user_id IS NULL OR user_id = @uid)'
        : 'AND user_id = @uid'
      : '';
    const proposal_rows = deps.db
      .prepare(
        `SELECT id, ts_created, status, kind,
                COALESCE(title, substr(rationale_md, 1, 140)) AS title
           FROM proposals
          WHERE specialist_id = @sid ${rw_cordon}
          ORDER BY ts_created DESC
          LIMIT 20`,
      )
      .all({ '@sid': id, ...(rw_user ? { '@uid': rw_user.id } : {}) }) as Array<{
      id: string;
      ts_created: string;
      status: string;
      kind: string;
      title: string | null;
    }>;
    for (const row of proposal_rows) {
      recent_work.push({
        id: row.id,
        kind: `proposal:${row.kind}`,
        status: row.status,
        title: (row.title ?? row.kind).trim().slice(0, 200),
        timestamp: row.ts_created,
        related_id: row.id,
      });
    }

    const brief_rows = deps.db
      .prepare(
        `SELECT id, ts_generated, kind, consumed_at
           FROM briefs
          WHERE generated_by_specialist_id = @sid
          ORDER BY ts_generated DESC
          LIMIT 10`,
      )
      .all({ '@sid': id }) as Array<{
      id: string;
      ts_generated: string;
      kind: string;
      consumed_at: string | null;
    }>;
    for (const row of brief_rows) {
      recent_work.push({
        id: row.id,
        kind: 'brief',
        status: row.consumed_at ? 'completed' : 'pending',
        title: `${row.kind} brief`,
        timestamp: row.ts_generated,
        related_id: row.id,
      });
    }

    recent_work.sort((a, b) => (a.timestamp < b.timestamp ? 1 : a.timestamp > b.timestamp ? -1 : 0));
    const recent_work_top = recent_work.slice(0, 20);

    // Strip persona text (load-bearing for the LLM, not a user-facing field).
    return c.json({
      specialist: {
        id: s.id,
        name: s.name,
        role: s.role,
        // Same filesystem probe as the list endpoint — see
        // resolve_avatar_relpath above for the rationale.
        avatar: resolve_avatar_relpath(deps.memory, s.avatar, s.id),
        // See list endpoint — iOS folds these into the avatar /
        // banner cache keys so re-rolled portraits auto-invalidate.
        avatar_modified_at: resolve_avatar_modified_at(deps.memory, s.avatar, s.id),
        banner_modified_at: resolve_banner_modified_at(deps.memory, s.id),
        voice: s.voice,
        knowledge_scope: s.knowledge_scope,
        capabilities: Array.from(s.granted),
        proactive: s.proactive,
        default_landing: s.default_landing,
        // See /specialists list endpoint — Stage 0 active_status.
        active_status: user ? compute_active_status(deps.db, s.id, user.id) : null,
        // Stage 2 of Specialist-as-Room — pane_kind on the DTO.
        pane_kind: s.pane_kind ?? null,
      },
      recent_work: recent_work_top,
      memory_summary: null,
    });
  });

  // ── Specialist pane (Stage 2 of Specialist-as-Room) ──────────────────
  //
  // Returns the layout document the iOS `SpecialistRoomView` renders
  // when `Specialist.pane_kind != nil`. Document shape lives in
  // `src/core/specialist_pane.ts`; each `pane_kind` maps to a
  // composer there. 404 when the specialist exists but has no pane
  // configured — iOS treats 404 as "fall back to chat-first" so
  // legacy specialists keep working unchanged.

  r.get('/specialists/:id/pane', async (c) => {
    const id = c.req.param('id');
    const spec = deps.specialists.get(id);
    if (!spec) return c.json({ error: 'specialist not found' }, 404);
    const user = c.get('user');
    if (user && deps.users && !deps.users.is_specialist_allowed(user, id)) {
      // Same shape as the conversation gate above — silent 404 so a
      // disallowed specialist's existence isn't leaked.
      return c.json({ error: 'specialist not found' }, 404);
    }
    if (!deps.vault_root) {
      // Pane composer needs vault_root for the artist-watchlist read
      // and as a stable base path. Absent in legacy smoke wiring; the
      // 404 falls through to chat-first which is the correct degrade.
      return c.json({ error: 'pane not configured' }, 404);
    }
    // Household nearby_cities (proximity-ordered) lets the listening pane
    // collapse one artist's multi-city dates to the nearest, folding the
    // rest into a "+N more dates" hint. Absent → pane falls back to soonest.
    const nearby_cities = deps.users?.household()?.nearby_cities;
    const doc = await compose_pane(spec, deps.db, user?.id ?? 'jasper', {
      vault_root: deps.vault_root,
      memory: deps.memory,
      llm: deps.llm,
      tool_registry: deps.tools,
      // Kate's briefing office gates its internal team-ops blocks
      // (team_health, recommendation cards) on owner tier so a
      // friend-tier household member sees only their own brief.
      viewer_is_owner: user?.tier === 'owner',
      // The household-shared `home` office needs the REAL tier (to exclude
      // friend, which viewer_is_owner collapses into household) + the user
      // registry (home owner + each member's home/away resolution).
      viewer_tier: user?.tier ?? 'friend',
      ...(deps.users ? { users: deps.users } : {}),
      // Display units for measurements (Astrid's office) — per-user
      // from users.yaml, default imperial.
      viewer_units: units_for(user),
      ...(deps.workout_tracker ? { workout_tracker: deps.workout_tracker } : {}),
      ...(nearby_cities && nearby_cities.length > 0 ? { nearby_cities } : {}),
    });
    if (!doc) return c.json({ error: 'pane not configured' }, 404);
    return c.json(doc);
  });

  // ── Code Shop settings (Beatrice's gear) — OWNER ONLY ──────────────────
  // Repo + credentials (the gitea token that actually makes merge work),
  // safety toggles, merge defaults, and the metric-estimate calibration.
  // Tokens are write-only: GET returns a boolean "set/unset", never the value.
  r.get('/codeshop/settings', async (c) => {
    const user = c.get('user');
    if (!user || user.tier !== 'owner') return c.json({ error: 'owner only' }, 403);
    return c.json(new CodeShopSettings(deps.db).get_redacted());
  });

  const CodeShopPatchSchema = z.object({
    gitea_base_url: z.string().optional(),
    gitea_owner: z.string().optional(),
    gitea_repo: z.string().optional(),
    base_branch: z.string().optional(),
    github_url: z.string().optional(),
    gitea_token: z.string().optional(),
    github_token: z.string().optional(),
    github_required: z.boolean().optional(),
    merge_method: z.enum(['merge', 'squash', 'rebase']).optional(),
    paused: z.boolean().optional(),
    require_pin_code_merge: z.boolean().optional(),
    auto_pull_config_merges: z.boolean().optional(),
    kwh_per_ktoken: z.number().nonnegative().optional(),
    tou_rates: z
      .array(z.object({ hour: z.number().int().min(0).max(23), summer: z.number().nonnegative(), winter: z.number().nonnegative() }))
      .length(24)
      .optional(),
    clear_gitea_token: z.boolean().optional(),
    clear_github_token: z.boolean().optional(),
  });

  r.post('/codeshop/settings', async (c) => {
    const user = c.get('user');
    if (!user || user.tier !== 'owner') return c.json({ error: 'owner only' }, 403);
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch (err) {
      return c.json({ error: `Invalid JSON: ${(err as Error).message}` }, 400);
    }
    const parsed = CodeShopPatchSchema.safeParse(raw);
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    const store = new CodeShopSettings(deps.db);
    const { clear_gitea_token, clear_github_token, ...patch } = parsed.data;
    if (clear_gitea_token) store.clear_secret('gitea_token');
    if (clear_github_token) store.clear_secret('github_token');
    const changed = store.set(patch);
    // Audit the FACT of the change (which keys), never the secret values.
    deps.memory.log_action({
      intent_id: ulid(),
      agent: 'orchestrator',
      tool_name: 'codeshop_settings_update',
      tool_input: { changed, by: user.id },
    });
    return c.json({ ok: true, changed, config: store.get_redacted() });
  });

  // ── Conversations ────────────────────────────────────────────────────

  const NewConvSchema = z.object({
    specialist_id: z.string(),
    // Opt-in continuity: when true, rejoin the caller's most recent thread
    // with this specialist if it's within the live-session window, else
    // create fresh. The voice path (Pipecat) sets this so a WebRTC reconnect
    // mid-call resumes the same conversation instead of minting an empty one
    // (which presented as the voice specialist re-greeting "Hey Jasper, what's up" after a
    // consult). Chat clients omit it and keep the create-every-time behavior.
    reuse: z.boolean().optional(),
    // Origin surface for the resolved thread (2026-06-06). With reuse:true,
    // resolve_for_user scopes reuse to conversations whose ACTIVE surface
    // matches — so the voice shim gets a DEDICATED voice thread and never
    // rejoins (and parrots the markdown of) a recent typed-chat conversation.
    surface: z.enum(['web', 'telegram', 'voice']).optional(),
  });
  // Live-session reuse window for `reuse: true`. A reconnect happens within
  // seconds; this also lets a quick call-back continue the same thread. Kept
  // far tighter than the 24h cross-surface window so a genuinely new call
  // doesn't resume a stale thread. Override via env if a household wants a
  // longer continuity window.
  //
  // 30 min → 5 min (2026-08-03). The comment above always said "a reconnect
  // happens within seconds"; the constant said half an hour, and that gap was
  // load-bearing. On voice one ungrounded answer enters the thread's history
  // and every later turn in the window re-narrates it — the 2026-08-02
  // "Little Hen" reply was parroted verbatim across four consecutive turns and
  // only stopped once a tool call finally landed. The grounding fixes remove
  // the source of the first bad answer; this bounds how far one travels if
  // another ever appears. Still far longer than a reconnect or a call-back;
  // HEARTH_VOICE_REUSE_MS restores the old value.
  const VOICE_REUSE_MS = Number(process.env.HEARTH_VOICE_REUSE_MS ?? 5 * 60 * 1000);

  r.post('/conversations', async (c) => {
    const j = await read_json(c);
    if (!j.ok) return c.json({ error: j.error }, 400);
    const parsed = NewConvSchema.safeParse(j.body);
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    if (!deps.specialists.has(parsed.data.specialist_id)) {
      return c.json({ error: `unknown specialist: ${parsed.data.specialist_id}` }, 400);
    }
    const user = c.get('user');
    // Specialist visibility gate — Phase 2a. A user without access to
    // this specialist gets a clean 403 instead of being able to back
    // into a conversation by guessing the id.
    if (user && deps.users && !deps.users.is_specialist_allowed(user, parsed.data.specialist_id)) {
      return c.json({ error: `specialist ${parsed.data.specialist_id} not allowed for ${user.id}` }, 403);
    }
    if (parsed.data.reuse && user?.id) {
      const { conversation } = deps.conversations.resolve_for_user(
        user.id,
        parsed.data.specialist_id,
        VOICE_REUSE_MS,
        parsed.data.surface,
      );
      return c.json(conversation);
    }
    const conv = deps.conversations.create(parsed.data.specialist_id, undefined, user?.id);
    return c.json(conv);
  });

  r.get('/conversations', (c) => {
    const sid = c.req.query('specialist_id') ?? undefined;
    const user = c.get('user');
    // Hide list clutter (2026-06-15): empty "new chat" rows and threads for a
    // FIRED specialist (e.g. Hazel) — their history stays in the db, it just
    // doesn't fill the thread list. Both filters apply in SQL so the limit
    // counts only live threads.
    const rows = deps.conversations.list({
      ...(sid ? { specialist_id: sid } : {}),
      ...(user ? { user_id: user.id } : {}),
      exclude_empty: true,
      known_specialist_ids: deps.specialists.list().map((s) => s.id),
    });
    return c.json({ conversations: rows });
  });

  /**
   * Context-window fill indicator. The "claude-style" donut next to
   * the New-Conversation button. Reads the most-recent specialist_turn
   * audit row for this conv and returns tokens_in / max_context, so
   * the client can render a percentage and trigger a "near full"
   * warning before a turn fails.
   *
   * Cap defaults to the the LLM host beellama deployment (96k —
   * QWEN3.6-27B context window). Override per-deploy via the
   * HEARTH_CONTEXT_MAX env var so a future Ollama / different-model
   * swap doesn't require a code change.
   */
  r.get('/conversations/:id/context_usage', (c) => {
    const conv_id = c.req.param('id');
    const conv = deps.conversations.get(conv_id);
    if (!conv) return c.json({ error: 'conversation not found' }, 404);
    // Phase 2a per-user gate.
    const user = c.get('user');
    if (user) {
      const conv_owner = conv.user_id ?? 'jasper';
      if (conv_owner !== user.id) return c.json({ error: 'conversation not found' }, 404);
    }
    const max_tokens = parseInt(process.env.HEARTH_CONTEXT_MAX ?? '96000', 10);
    // The latest specialist_turn for this conv. The audit row stashes
    // conversation_id inside tool_input (JSON) — SQLite's json_extract
    // does the lookup without us pulling every row into JS first.
    const row = deps.db
      .prepare(
        `SELECT execution_result, ts
           FROM audit_log
          WHERE tool_name = 'specialist_turn'
            AND json_extract(tool_input, '$.conversation_id') = @cid
          ORDER BY ts DESC
          LIMIT 1`,
      )
      .get({ '@cid': conv_id }) as { execution_result: string | null; ts: string } | undefined;
    let tokens_used = 0;
    let model: string | null = null;
    if (row?.execution_result) {
      try {
        const er = JSON.parse(row.execution_result) as {
          cost?: { tokens_in?: number; model?: string };
        };
        tokens_used = er.cost?.tokens_in ?? 0;
        model = er.cost?.model ?? null;
      } catch { /* leave zero */ }
    }
    const ratio = max_tokens > 0 ? Math.min(1, tokens_used / max_tokens) : 0;
    return c.json({
      conversation_id: conv_id,
      tokens_used,
      max_tokens,
      ratio,
      model,
      last_turn_at: row?.ts ?? null,
    });
  });

  r.get('/conversations/:id/messages', (c) => {
    const id = c.req.param('id');
    const limit_raw = c.req.query('limit');
    const limit = limit_raw ? Math.max(1, Math.min(200, parseInt(limit_raw, 10) || 50)) : 50;
    const before = c.req.query('before') ?? undefined;
    const conv = deps.conversations.get(id);
    if (!conv) return c.json({ error: 'conversation not found' }, 404);
    // Access check — Phase 2a. user_id NULL = pre-migration row owned
    // by jasper by convention; other users get 404 (don't leak existence).
    const user = c.get('user');
    if (user) {
      const conv_owner = conv.user_id ?? 'jasper';
      if (conv_owner !== user.id) {
        return c.json({ error: 'conversation not found' }, 404);
      }
    }
    const messages = deps.conversations.list_messages(id, { limit, before });
    return c.json({ conversation_id: id, messages });
  });

  // Hard output ceiling for the VOICE surface. A spoken reply you can't
  // skim should stay a sentence or two; this is a ceiling, not a target
  // (the slim voice prompt already keeps Kate terse). Caps a runaway from
  // turning into a minute of monologue and bounds turn latency — output
  // length is the dominant cost. See the 2026-06-05 voice-latency review.
  const VOICE_MAX_OUTPUT_TOKENS = 200;

  const SendMessageSchema = z.object({
    content: z.string().min(1).max(20_000),
    // Origin surface for this turn. The Pipecat voice loop passes
    // `surface: 'voice'` so the persisted rows are distinguishable from
    // typed web turns — that's what lets voice-call messages stay in the
    // transcript but stay OUT of the unread badge count (see the unread
    // query in GET /api/specialists). Defaults to null (web) for the
    // typed chat surface, matching prior behavior.
    surface: z.enum(['web', 'telegram', 'voice']).optional(),
    // Tier hint (2026-05-31). `'live'` routes this turn to the
    // LIVE/CONCURRENT tier (IQ2_M on the A4000) when the specialist
    // hasn't pinned a role — for a turn that must run WHILE the user is
    // mid-conversation on the 27B (Astrid coaching during an active
    // workout; any latency-sensitive concurrent turn the client flags).
    // The CLIENT declares the situation; the runtime maps it to the
    // role/GPU. Omitted → the normal DEEP path. See
    // docs/design-two-tier-inference.md §3.
    tier: z.enum(['deep', 'live']).optional(),
  });

  r.post('/conversations/:id/messages', async (c) => {
    const id = c.req.param('id');
    const conv = deps.conversations.get(id);
    if (!conv) return c.json({ error: 'conversation not found' }, 404);

    // Phase 2a: only the conv owner can post to it.
    const user = c.get('user');
    if (user) {
      const conv_owner = conv.user_id ?? 'jasper';
      if (conv_owner !== user.id) {
        return c.json({ error: 'conversation not found' }, 404);
      }
    }

    const j = await read_json(c);
    if (!j.ok) return c.json({ error: j.error }, 400);
    const parsed = SendMessageSchema.safeParse(j.body);
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);

    const specialist = deps.specialists.get(conv.specialist_id);
    if (!specialist) {
      return c.json({ error: `specialist ${conv.specialist_id} not loaded` }, 500);
    }

    // Persist the user message immediately — visible in chat right
    // away even if the specialist's turn is queued behind a prior
    // turn for the same conversation.
    const user_msg = deps.conversations.append_message({
      conversation_id: id,
      role: 'user',
      content_md: parsed.data.content,
      surface: parsed.data.surface,
    });
    deps.events?.emit({
      type: 'message_added',
      conversation_id: id,
      message_id: user_msg.id,
      role: 'user',
      content_preview: parsed.data.content.slice(0, 200),
    });

    // Queue this turn behind any in-flight turn for the SAME
    // conversation. Different conversations run concurrently (each
    // has its own `turn_queues` entry). Same conversation, FIFO —
    // typing "??" mid-turn now waits for the original reply instead
    // of aborting it and persisting "(stopped)".
    const result = await serialize_per_conversation(id, async () => {
      // Snapshot history INSIDE the queue so a queued turn sees the
      // prior turn's reply (which only landed after we waited).
      const history_rows = deps.conversations.list_messages(id, { limit: 20 });

      // Register a cancel controller for THIS turn only. The cancel
      // endpoint still works — it aborts whatever's currently
      // running; queued turns behind it run normally afterwards.
      // Explicit cancel is the only legitimate path to "(stopped)".
      const controller = new AbortController();
      active_turns.set(id, controller);

      // VOICE surface (Satellite1 → openai_shim → here) runs a LEAN turn.
      // The slim `voice_realtime` prompt mode skips turn-start RAG, the
      // structured grounding packs, the provenance retry, and the
      // fact-critic second pass, and curates to Kate's chat tools — a
      // spoken receptionist escalates (consult) rather than running the
      // full research scaffold, which is what made voice turns ~11.5s.
      // It runs on the SAME endpoint as her typed chat (`provider_role:
      // 'live'`, i.e. wherever `for_role('live')` resolves) so it tracks
      // the interactive tier with no second endpoint to keep in sync, and
      // caps output low so a spoken reply stays short. The behavior comes
      // from `llm_role`; the GPU from `provider_role`. See the 2026-06-05
      // voice-latency review.
      const is_voice = parsed.data.surface === 'voice';

      // Interactive chat runs on the concurrent LIVE tier so it never
      // queues behind background deliberation / consults on the single-slot
      // DEEP endpoint — the root cause of "I message a specialist and
      // nothing streams." Honor a client-declared tier; otherwise default
      // to 'live'. 'specialist' and 'live' are the same think-off chat role
      // on different GPUs, so an explicit `llm_role: specialist` pin still
      // moves; a genuine non-chat pin is preserved.
      const chat_tier: 'deep' | 'live' | undefined =
        parsed.data.tier
        ?? (specialist.llm_role && specialist.llm_role !== 'specialist'
          ? undefined
          : 'live');

      let out;
      try {
        out = await deps.runtime.turn_streaming({
          specialist_id: conv.specialist_id,
          conversation_id: id,
          message: { role: 'user', content: parsed.data.content },
          conversation_history: history_rows
            .filter((m) => m.id !== user_msg.id)
            .map((m) => ({
              role: m.role,
              content: m.content_md,
              specialist_id: m.specialist_id ?? undefined,
              ts: m.ts,
            })),
          // Phase 2b — passing the caller tier through activates the
          // per-tier discretion gate. Undefined (unauthed) collapses to
          // legacy owner behavior inside the runtime.
          user: to_turn_user(user, c.get('user_tz')),
          signal: controller.signal,
          // Thread the origin surface so a spoken turn ALSO gets the
          // speakable-output overlay (the specialist's `voice_style`) —
          // composed on top of the lean voice routing below, and what keeps
          // sentence-streaming from chunking markdown into the TTS. Omitted /
          // web / telegram ≡ unchanged. See SpecialistTurnInput.surface.
          surface: parsed.data.surface,
          // Voice → lean voice-mode behavior on the live chat endpoint with
          // a tight output cap. Otherwise interactive chat defaults to the
          // LIVE tier unless the client declared one or the specialist pins
          // a non-chat role. Runtime owns role/tier→GPU.
          ...(is_voice
            ? {
                llm_role: 'voice_realtime',
                provider_role: 'live',
                max_tokens_override: VOICE_MAX_OUTPUT_TOKENS,
              }
            : chat_tier
            ? { tier: chat_tier }
            : {}),
        });
      } finally {
        if (active_turns.get(id) === controller) active_turns.delete(id);
      }

      const spec_msg = deps.conversations.append_message({
        conversation_id: id,
        role: 'specialist',
        specialist_id: conv.specialist_id,
        content_md: out.message_text,
        tool_calls: out.tool_calls_made,
        proposals_created: out.proposals_created,
        reasoning_trace: out.reasoning_trace || undefined,
        // Stamp the specialist reply with the same surface as the turn
        // that triggered it, so a voice reply is counted as voice (and
        // thus excluded from the unread badge) while still living in the
        // transcript.
        surface: parsed.data.surface,
      });
      deps.events?.emit({
        type: 'message_added',
        conversation_id: id,
        message_id: spec_msg.id,
        role: 'specialist',
        specialist_id: conv.specialist_id,
        content_preview: out.message_text.slice(0, 200),
      });
      return { spec_msg, out };
    });

    return c.json({
      message: result.spec_msg,
      tool_calls_made: result.out.tool_calls_made,
      proposals_created: result.out.proposals_created,
      consulted_specialists: result.out.consulted_specialists,
      cost: result.out.cost,
    });
  });

  // ── Cancel an in-flight turn ─────────────────────────────────────────
  //
  // POST /api/conversations/:id/cancel — abort the AbortController for
  // a conversation with a turn in flight. The provider fetch to Ollama
  // is cancelled at the socket; the runtime catches the AbortError,
  // writes "(stopped)" as the final message, and emits the normal
  // `message_added` + `specialist_thinking finished` SSE events so
  // the UI returns to idle.
  //
  // **This is the ONLY path that produces a "(stopped)" message.**
  // Pre-2026-05-27 the chat-send path also produced one — sending a
  // second message on the same conversation aborted the in-flight
  // turn and persisted "(stopped)" as the reply. With the per-
  // conversation FIFO queue (`turn_queues`), that second message
  // now waits its turn instead. Only explicit user-initiated cancel
  // reaches this path. Any queued turns behind the cancelled one
  // still run normally afterwards.
  r.post('/conversations/:id/cancel', (c) => {
    const id = c.req.param('id');
    const controller = active_turns.get(id);
    if (!controller) {
      return c.json({ cancelled: false, reason: 'no turn in flight' });
    }
    controller.abort();
    deps.memory.log_action({
      intent_id: ulid(),
      agent: 'orchestrator',
      tool_name: 'conversation_cancel',
      tool_input: { conversation_id: id },
    });
    return c.json({ cancelled: true });
  });

  // ── Follow-up delivery ───────────────────────────────────────────────
  //
  // POSTed by the scheduler when a `promise_followup` task fires. Runs a
  // fresh specialist turn with a synthetic trigger message (not persisted
  // to the conversation), then appends the specialist's reply as a normal
  // message — same as if the user had asked again. The SSE message_added
  // event makes it appear live in the client.

  const DeliverFollowupSchema = z.object({
    conversation_id: z.string().min(1),
    specialist_id: z.string().min(1),
    summary: z.string().min(1),
    scope: z.string().min(1),
    promised_at_iso: z.string().min(1),
    followup_id: z.string().optional(),
  });

  r.post('/specialists/deliver-followup', async (c) => {
    const j = await read_json(c);
    if (!j.ok) return c.json({ error: j.error }, 400);
    const parsed = DeliverFollowupSchema.safeParse(j.body);
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);

    const ctx_body: DeliverFollowupContext = parsed.data;
    const conv = deps.conversations.get(ctx_body.conversation_id);
    if (!conv) return c.json({ error: 'conversation not found' }, 404);
    if (!deps.specialists.has(ctx_body.specialist_id)) {
      return c.json({ error: `unknown specialist: ${ctx_body.specialist_id}` }, 400);
    }

    // The conversation may have moved on or even switched specialists.
    // We still deliver, but tag with the specialist who originally promised.
    //
    // Was this followup PROMISED on the voice surface? The promise is tied to
    // the dedicated voice thread (resolve_for_user surface:'voice'), so a
    // voice-surfaced message on the conversation is the reliable signal — the
    // followup context can't carry surface (ToolContext doesn't expose it). A
    // voice followup keeps its full chat tools (the work may need web_search
    // etc.) but the reply gets shaped for the ear (for_voice) and is delivered
    // via the Satellite1 if the user is present (the speak-or-push block below).
    const is_voice_followup =
      (deps.db
        .prepare(
          `SELECT 1 FROM messages
            WHERE conversation_id = @cid AND surface = 'voice' LIMIT 1`,
        )
        .get({ '@cid': ctx_body.conversation_id }) as Record<string, unknown> | undefined) != null;
    const trigger = build_followup_trigger(ctx_body, new Date(), { for_voice: is_voice_followup });
    // Phase 2b — followup runs as the conversation's original owner
    // (the scheduler that triggered this has no session). undefined
    // when users registry isn't wired → owner default.
    const conv_user = deps.users?.get(conv.user_id ?? 'jasper') ?? null;

    // Queue the followup turn behind any in-flight chat turn for
    // this conversation. Pre-2026-05-27 this aborted the chat turn —
    // a scheduler-fired followup landing while the user was mid-
    // turn would persist "(stopped)" as the chat reply. Now the
    // followup waits its turn.
    const result = await serialize_per_conversation(ctx_body.conversation_id, async () => {
      const history_rows = deps.conversations.list_messages(ctx_body.conversation_id, {
        limit: 30,
      });
      const controller = new AbortController();
      active_turns.set(ctx_body.conversation_id, controller);
      let out;
      try {
        out = await deps.runtime.turn({
          specialist_id: ctx_body.specialist_id,
          conversation_id: ctx_body.conversation_id,
          message: { role: 'user', content: trigger },
          conversation_history: history_rows.map((m) => ({
            role: m.role,
            content: m.content_md,
            specialist_id: m.specialist_id ?? undefined,
            ts: m.ts,
          })),
          user: to_turn_user(conv_user, c.get('user_tz')),
          signal: controller.signal,
        });
      } finally {
        if (active_turns.get(ctx_body.conversation_id) === controller) {
          active_turns.delete(ctx_body.conversation_id);
        }
      }

      const spec_msg = deps.conversations.append_message({
        conversation_id: ctx_body.conversation_id,
        role: 'specialist',
        specialist_id: ctx_body.specialist_id,
        content_md: out.message_text,
        tool_calls: out.tool_calls_made,
        proposals_created: out.proposals_created,
        reasoning_trace: out.reasoning_trace || undefined,
      });
      deps.events?.emit({
        type: 'message_added',
        conversation_id: ctx_body.conversation_id,
        message_id: spec_msg.id,
        role: 'specialist',
        specialist_id: ctx_body.specialist_id,
        content_preview: out.message_text.slice(0, 200),
      });
      if (ctx_body.followup_id) {
        deps.events?.emit({
          type: 'followup_delivered',
          conversation_id: ctx_body.conversation_id,
          specialist_id: ctx_body.specialist_id,
          followup_id: ctx_body.followup_id,
          message_id: spec_msg.id,
        });
      }
      return { spec_msg, out };
    });

    // Voice followup delivery (2026-06-15) — speak it on the Satellite1 if the
    // user is present right now, else push. The reply is already appended to the
    // thread above, so this is purely "how does he find out", never load-bearing:
    // try_speak_followup fails open to a push at every error path.
    let voice_delivery: { spoken: boolean; pushed: boolean; reason: string } | undefined;
    if (is_voice_followup) {
      const speakable = strip_markdown_for_speech(result.out.message_text).trim();
      if (speakable) {
        const intent_id = `voicefollowup:${ctx_body.followup_id ?? ctx_body.conversation_id}`;
        voice_delivery = await try_speak_followup({
          text: speakable,
          conversation_id: ctx_body.conversation_id,
          summary: ctx_body.summary,
          coordinator_url: process.env.HEARTH_VOICE_COORDINATOR_URL,
          bearer: process.env.HEARTH_INTERNAL_BEARER,
          // queued counts as pushed — the pending_pushes sweep delivers it.
          push: (t) =>
            push_text(t, deps.memory, intent_id, 'voice_followup').then(
              (r) => r.delivered || r.via === 'queued',
            ),
        }).catch((e) => ({ spoken: false, pushed: false, reason: `error:${String(e)}` }));
        deps.memory.log_action({
          intent_id,
          agent: 'orchestrator',
          tool_name: 'voice_followup_deliver',
          tool_input: { conversation_id: ctx_body.conversation_id, summary: ctx_body.summary },
          execution_result: voice_delivery,
        });
      }
    }

    return c.json({
      ok: true,
      message_id: result.spec_msg.id,
      followup_for: ctx_body.summary,
      tool_calls_made: result.out.tool_calls_made,
      proposals_created: result.out.proposals_created,
      ...(voice_delivery ? { voice_delivery } : {}),
    });
  });

  // ── Present-questions form ──────────────────────────────────────────
  //
  // GET  /api/present-questions/:id              — fetch one question set
  // GET  /api/conversations/:id/pending-questions — list pending for conv
  // POST /api/present-questions/:id/answer        — submit answers,
  //                                                  fires a resume turn
  //
  // The `present_questions` tool persists rows here; the web pane reads
  // them via the GET routes and POSTs answers back. On answer, we
  // synthesize a user message ("[FORM ANSWERED — your present_questions
  // set <id> is in: ...]") into the linked conversation (or, for a
  // brief-attached set, Kate's most-recent conversation) and run a
  // fresh specialist turn so the specialist actually responds to the
  // choices instead of leaving them to rot.

  const pending_questions = new PendingQuestionsStore(deps.db);

  function strip_row(row: PendingQuestionRow) {
    return {
      id: row.id,
      ts_created: row.ts_created,
      ts_answered: row.ts_answered,
      specialist_id: row.specialist_id,
      conversation_id: row.conversation_id,
      brief_id: row.brief_id,
      intro_md: row.intro_md,
      questions: row.questions,
      answers: row.answers,
      status: row.status,
    };
  }

  r.get('/present-questions/:id', (c) => {
    const row = pending_questions.get(c.req.param('id'));
    if (!row) return c.json({ error: 'question set not found' }, 404);
    return c.json(strip_row(row));
  });

  r.get('/conversations/:id/pending-questions', (c) => {
    const id = c.req.param('id');
    if (!deps.conversations.get(id)) return c.json({ error: 'conversation not found' }, 404);
    return c.json({
      conversation_id: id,
      pending_questions: pending_questions
        .list_pending_for_conversation(id)
        .map(strip_row),
    });
  });

  // ── Linda's listing drafts ───────────────────────────────────────────
  // The web client fetches these on `listing_draft_created` and renders the
  // copy-ready listing card. Scoped to the authenticated user when present
  // (a friend-tier seller's drafts are private to them); serves at
  // /api/listing-drafts/:id (add `listing-drafts` to the nginx alternation
  // on the always-on host for the iOS client, same as present-questions/library).
  const listing_drafts = new ListingDraftsStore(deps.db);

  r.get('/listing-drafts/:id', (c) => {
    const user = c.get('user');
    const row = listing_drafts.get(c.req.param('id'), user?.id);
    if (!row) return c.json({ error: 'listing draft not found' }, 404);
    return c.json(row);
  });

  r.get('/conversations/:id/listing-drafts', (c) => {
    const id = c.req.param('id');
    if (!deps.conversations.get(id)) return c.json({ error: 'conversation not found' }, 404);
    return c.json({
      conversation_id: id,
      listing_drafts: listing_drafts.list_for_conversation(id),
    });
  });

  const AnswerSchema = z.object({
    answers: z.record(z.string(), z.union([z.string(), z.array(z.string())])),
  });

  /**
   * Render Jasper's choices in two voices:
   *   - `user_visible`: what lands in the chat timeline as a normal
   *     `user`-role message. Short, human-readable, no LLM-priming
   *     prose. This is what Jasper sees in his history forever.
   *   - `trigger`: the full briefing passed into `runtime.turn()` as
   *     the synthetic incoming message. NOT persisted to the
   *     conversation — mirrors the `promise_followup` pattern where
   *     the synthetic trigger is invisible to Jasper but load-bearing
   *     for the specialist's resume turn.
   */
  function format_answers_for_specialist(
    row: PendingQuestionRow,
    answers: Record<string, AnswerValue>,
  ): { user_visible: string; trigger: string } {
    const choice_lines: string[] = [];
    for (const q of row.questions) {
      const raw = answers[q.id];
      if (raw === undefined) {
        choice_lines.push(`- ${q.text} — *(skipped)*`);
        continue;
      }
      const values = Array.isArray(raw) ? raw : [raw];
      const human = values
        .map((v) => {
          const opt = q.options.find((o) => o.value === v);
          return opt ? opt.label : `"${v}"`;
        })
        .join(', ');
      choice_lines.push(`- ${q.text} → **${human}**`);
    }
    const user_visible = choice_lines.join('\n');

    const trigger_lines: string[] = [
      `[FORM ANSWERED — Jasper just submitted your present_questions set \`${row.id}\`.`,
      `Quote his actual selections in your reply (don't re-narrate the prompt) and then DO the work the choices imply.`,
      `If he tapped "Other" the value is the free-text string he typed.`,
      `If he skipped a question that question is absent from this map.`,
      ``,
    ];
    if (row.intro_md) trigger_lines.push(`Original intro: ${row.intro_md.trim()}`);
    for (const q of row.questions) {
      const raw = answers[q.id];
      if (raw === undefined) {
        trigger_lines.push(`- ${q.text}\n    (skipped)`);
        continue;
      }
      const values = Array.isArray(raw) ? raw : [raw];
      const human = values
        .map((v) => {
          const opt = q.options.find((o) => o.value === v);
          return opt ? `${opt.label} (\`${v}\`)` : `Other: "${v}"`;
        })
        .join(', ');
      trigger_lines.push(`- ${q.text}\n    → ${human}`);
    }
    trigger_lines.push(
      '',
      `Now respond in your voice — confirm what you heard, then take the action(s) the answers imply (call tools, schedule, draft). Do not call present_questions again for the same set.`,
    );
    return { user_visible, trigger: trigger_lines.join('\n') };
  }

  /**
   * Find or create a conversation for a brief-attached question set so
   * Kate can resume in chat after Jasper answers the form embedded in
   * her right-rail brief. We prefer the most-recent existing
   * conversation for the specialist (so the answers land in the
   * thread Jasper was already using) and fall back to a fresh one.
   */
  function ensure_conv_for_brief(specialist_id: string): string {
    const recent = deps.conversations.list({
      specialist_id,
    });
    if (recent.length > 0 && recent[0]) return recent[0].id;
    return deps.conversations.create(specialist_id).id;
  }

  r.post('/present-questions/:id/answer', async (c) => {
    const id = c.req.param('id');
    const row = pending_questions.get(id);
    if (!row) return c.json({ error: 'question set not found' }, 404);
    if (row.status !== 'pending') {
      return c.json(
        { error: `question set already ${row.status}`, status: row.status },
        409,
      );
    }
    const j = await read_json(c);
    if (!j.ok) return c.json({ error: j.error }, 400);
    const parsed = AnswerSchema.safeParse(j.body);
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);

    const updated = pending_questions.answer(id, parsed.data.answers);
    if (!updated) {
      return c.json({ error: 'question set could not be marked answered' }, 409);
    }

    deps.events?.emit({
      type: 'questions_answered',
      question_set_id: id,
      specialist_id: updated.specialist_id,
      conversation_id: updated.conversation_id,
      brief_id: updated.brief_id,
    });

    // Resume the specialist. Brief-attached sets fall back to the
    // specialist's most-recent conversation so the answer lands in
    // the chat where Jasper can read the follow-up.
    const conv_id = updated.conversation_id ?? ensure_conv_for_brief(updated.specialist_id);
    if (!deps.specialists.has(updated.specialist_id)) {
      return c.json({
        ok: true,
        question_set_id: id,
        specialist_id: updated.specialist_id,
        resume: { skipped: true, reason: 'specialist not loaded' },
        answers: parsed.data.answers,
      });
    }

    const { user_visible, trigger } = format_answers_for_specialist(
      updated,
      parsed.data.answers,
    );

    // Persist a SHORT, human-readable user message so Jasper's chat
    // history shows what he picked ("- Question → **Choice**"). The
    // full LLM-priming trigger is NOT persisted — same shape as
    // promise_followup's deliver-followup path, where the synthetic
    // wake-up message is invisible to Jasper and only Kate sees it.
    const user_msg = deps.conversations.append_message({
      conversation_id: conv_id,
      role: 'user',
      content_md: user_visible,
    });
    deps.events?.emit({
      type: 'message_added',
      conversation_id: conv_id,
      message_id: user_msg.id,
      role: 'user',
      content_preview: user_visible.slice(0, 200),
    });

    // Phase 2b — resume turn runs as the user who answered (the
    // questioner's session).
    const user = c.get('user');

    // Serialize behind any in-flight turn on this conversation —
    // present-questions resume is a user-driven turn that must
    // wait its place in line rather than racing the prior reply.
    const { spec_msg, out } = await serialize_per_conversation(conv_id, async () => {
      const history_rows = deps.conversations.list_messages(conv_id, { limit: 30 });
      const out = await deps.runtime.turn({
        specialist_id: updated.specialist_id,
        conversation_id: conv_id,
        // Trigger carries the priming prose; conversation_history holds
        // the visible record. The specialist sees both — the trigger as
        // the "incoming" message, history as what Jasper actually sees.
        message: { role: 'user', content: trigger },
        conversation_history: history_rows
          .filter((m) => m.id !== user_msg.id)
          .map((m) => ({
            role: m.role,
            content: m.content_md,
            specialist_id: m.specialist_id ?? undefined,
          })),
        user: to_turn_user(user, c.get('user_tz')),
      });

      const spec_msg = deps.conversations.append_message({
        conversation_id: conv_id,
        role: 'specialist',
        specialist_id: updated.specialist_id,
        content_md: out.message_text,
        tool_calls: out.tool_calls_made,
        proposals_created: out.proposals_created,
        reasoning_trace: out.reasoning_trace || undefined,
      });
      deps.events?.emit({
        type: 'message_added',
        conversation_id: conv_id,
        message_id: spec_msg.id,
        role: 'specialist',
        specialist_id: updated.specialist_id,
        content_preview: out.message_text.slice(0, 200),
      });
      return { spec_msg, out };
    });

    return c.json({
      ok: true,
      question_set_id: id,
      specialist_id: updated.specialist_id,
      conversation_id: conv_id,
      answers: parsed.data.answers,
      resume: {
        user_message_id: user_msg.id,
        specialist_message_id: spec_msg.id,
        tool_calls_made: out.tool_calls_made,
        proposals_created: out.proposals_created,
      },
    });
  });

  const SwitchSchema = z.object({ specialist_id: z.string() });

  r.post('/conversations/:id/switch', async (c) => {
    const id = c.req.param('id');
    const j = await read_json(c);
    if (!j.ok) return c.json({ error: j.error }, 400);
    const parsed = SwitchSchema.safeParse(j.body);
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    if (!deps.specialists.has(parsed.data.specialist_id)) {
      return c.json({ error: `unknown specialist: ${parsed.data.specialist_id}` }, 400);
    }
    const changed = deps.conversations.set_specialist(id, parsed.data.specialist_id);
    if (!changed) return c.json({ error: 'conversation not found' }, 404);
    return c.json({ conversation_id: id, specialist_id: parsed.data.specialist_id });
  });

  // ── Proposals ────────────────────────────────────────────────────────

  r.get('/proposals', (c) => {
    const status = c.req.query('status') ?? undefined;
    const sid = c.req.query('specialist_id') ?? undefined;
    // Per-user cordon: an owner sees system/self-improvement proposals
    // (user_id NULL) plus their own; a household/friend user sees only
    // their own action proposals. A user-less internal caller gets the
    // unfiltered set.
    const user = c.get('user');
    const rows = deps.proposals.list({
      status: status as never,
      specialist_id: sid,
      ...(user ? { visible_to: { user_id: user.id, tier: user.tier } } : {}),
    });
    return c.json({ proposals: rows });
  });

  // Court scorecard (trust-teeth Phase 1, 2026-07-02) — court-vs-owner
  // agreement over the window: per-lens + overall rates, reversals, the
  // signature backtest, and the documented HEARTH_TRUST_TEETH arming gate
  // (`meets_target`). Owner-only: the court adjudicates the owner's queue,
  // so its report card is his. Derived read — no writes.
  r.get('/proposals/court_scorecard', async (c) => {
    const user = c.get('user');
    if (user && user.tier !== 'owner') {
      return c.json({ error: 'owner only' }, 403);
    }
    const raw_days = Number(c.req.query('window_days') ?? 30);
    const { gather_court_scorecard } = await import('@core/court_scorecard');
    return c.json(gather_court_scorecard(deps.db, { window_days: raw_days }));
  });

  // Ask the authoring specialist a question about one of their proposal cards,
  // inline — the user types a question, the specialist answers in a scoped turn,
  // and the reply renders on the card without leaving the office. Mirrors the
  // present-questions resume: persist the question to the specialist's
  // conversation, run ONE turn with the proposal as context, return the answer
  // synchronously. Powers Kate's recommendation-card "ask Kate" affordance.
  const AskSchema = z.object({ question: z.string().min(1).max(2000) });
  r.post('/proposals/:id/ask', async (c) => {
    const id = c.req.param('id');
    const proposal = deps.proposals.get(id);
    if (!proposal) return c.json({ error: 'proposal not found' }, 404);
    // Owner-gate system proposals (user_id NULL — recommendations included), the
    // same cordon decide applies.
    const user = c.get('user');
    if (user && proposal.user_id === null && user.tier !== 'owner') {
      return c.json({ error: 'not your proposal' }, 403);
    }
    if (user && proposal.user_id !== null && proposal.user_id !== user.id) {
      return c.json({ error: 'not your proposal' }, 403);
    }
    const j = await read_json(c);
    if (!j.ok) return c.json({ error: j.error }, 400);
    const parsed = AskSchema.safeParse(j.body);
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);

    const spec_id = proposal.specialist_id;
    if (!deps.specialists.has(spec_id)) {
      return c.json({ error: 'specialist not loaded' }, 409);
    }
    const conv_id = ensure_conv_for_brief(spec_id);
    const question = parsed.data.question.trim();

    // Visible user message — the question, lightly anchored to the card so the
    // thread reads sensibly later.
    const user_visible = `_(re: ${proposal.title ?? 'your recommendation'})_\n\n${question}`;
    const user_msg = deps.conversations.append_message({
      conversation_id: conv_id,
      role: 'user',
      content_md: user_visible,
    });
    deps.events?.emit({
      type: 'message_added',
      conversation_id: conv_id,
      message_id: user_msg.id,
      role: 'user',
      content_preview: question.slice(0, 200),
    });

    // Trigger — the recommendation context + the question. Priming prose; NOT
    // persisted (mirrors the present-questions trigger).
    let ask_payload: Record<string, unknown> = {};
    try {
      ask_payload = JSON.parse(proposal.payload_json) as Record<string, unknown>;
    } catch {
      /* render with what we have */
    }
    const attempt_line =
      typeof ask_payload.attempt_md === 'string' ? ask_payload.attempt_md : '(not recorded)';
    const trigger =
      `[RECOMMENDATION FOLLOW-UP] Jasper is asking about a recommendation you filed for him.\n\n` +
      `Concern: ${proposal.title ?? ''}\n` +
      `What you told him you tried: ${attempt_line}\n` +
      `Your recommendation: ${proposal.rationale_md}\n\n` +
      `His question: "${question}"\n\n` +
      `Answer concisely in your voice (2–4 sentences). If he's steering you toward a ` +
      `different course, say plainly what you'll do — you may adjust your approach. ` +
      `Don't re-file the recommendation; just respond.`;

    const user_tz = c.get('user_tz');
    const { spec_msg, out } = await serialize_per_conversation(conv_id, async () => {
      const history_rows = deps.conversations.list_messages(conv_id, { limit: 30 });
      const out = await deps.runtime.turn({
        specialist_id: spec_id,
        conversation_id: conv_id,
        message: { role: 'user', content: trigger },
        conversation_history: history_rows
          .filter((m) => m.id !== user_msg.id)
          .map((m) => ({
            role: m.role,
            content: m.content_md,
            specialist_id: m.specialist_id ?? undefined,
          })),
        user: to_turn_user(user, user_tz),
      });
      const spec_msg = deps.conversations.append_message({
        conversation_id: conv_id,
        role: 'specialist',
        specialist_id: spec_id,
        content_md: out.message_text,
        tool_calls: out.tool_calls_made,
        proposals_created: out.proposals_created,
        reasoning_trace: out.reasoning_trace || undefined,
      });
      deps.events?.emit({
        type: 'message_added',
        conversation_id: conv_id,
        message_id: spec_msg.id,
        role: 'specialist',
        specialist_id: spec_id,
        content_preview: out.message_text.slice(0, 200),
      });
      return { spec_msg, out };
    });

    return c.json({
      ok: true,
      answer_md: out.message_text,
      conversation_id: conv_id,
      message_id: spec_msg.id,
    });
  });

  // Decide body accepts EITHER the legacy `verdict: 'approve' | 'deny'`
  // OR the new `action_id`. At least one must be present; both is
  // allowed (`action_id` wins). Legacy iOS builds + the cookie/PWA
  // flow still POST `{verdict}` and keep working unchanged.
  const DecideSchema = z
    .object({
      verdict: z.enum(['approve', 'deny']).optional(),
      action_id: z.string().min(1).max(80).optional(),
      modifications: z.record(z.string(), z.unknown()).optional(),
      user_feedback: z.string().optional(),
    })
    .refine((d) => d.verdict || d.action_id, {
      message: 'decide body requires verdict or action_id',
    });

  r.post('/proposals/:id/decide', async (c) => {
    const id = c.req.param('id');
    const j = await read_json(c);
    if (!j.ok) return c.json({ error: j.error }, 400);
    const parsed = DecideSchema.safeParse(j.body);
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);

    // Per-user cordon: a system/self-improvement proposal (user_id NULL)
    // may be decided only by the owner; a user-action proposal only by its
    // originating user. A user-less internal caller (no auth) is allowed.
    const decider = c.get('user');
    if (decider) {
      const target = deps.proposals.get(id);
      if (!target) return c.json({ error: 'proposal not found' }, 404);
      const allowed =
        target.user_id === null
          ? decider.tier === 'owner'
          : target.user_id === decider.id;
      if (!allowed) {
        return c.json({ error: 'not your proposal to decide' }, 403);
      }
    }

    // Resolve action_id ↔ verdict + effect. We accept either field on
    // the wire (the decide schema enforces at-least-one) and reduce
    // both shapes to a single (verdict, action_id, effect) triple
    // before any side effect runs. Legacy `verdict: 'approve'` is
    // equivalent to `action_id: 'approve'` (effect=execute);
    // `verdict: 'deny'` to `action_id: 'reject'` (effect=reject).
    // Custom action_ids are looked up against the proposal's own
    // action set so a malformed client request fails loud (400)
    // rather than silently dropping into a default branch.
    const existing_for_action = deps.proposals.get(id);
    if (!existing_for_action) return c.json({ error: 'proposal not found' }, 404);

    let resolved_verdict: 'approve' | 'deny';
    let resolved_action_id: string;
    let resolved_effect: import('@core/proposals').ActionEffect;

    if (parsed.data.action_id) {
      const action = existing_for_action.actions.find((a) => a.id === parsed.data.action_id);
      if (!action) {
        return c.json(
          {
            error: `unknown action_id "${parsed.data.action_id}" for proposal kind "${existing_for_action.kind}"`,
            valid_action_ids: existing_for_action.actions.map((a) => a.id),
          },
          400,
        );
      }
      resolved_action_id = action.id;
      resolved_effect = action.effect;
      resolved_verdict = action.effect === 'reject' ? 'deny' : 'approve';
    } else {
      // Legacy shape — verdict is required by schema refinement when
      // action_id is absent.
      resolved_verdict = parsed.data.verdict!;
      resolved_action_id = resolved_verdict === 'approve' ? 'approve' : 'reject';
      resolved_effect = resolved_verdict === 'approve' ? 'execute' : 'reject';
    }

    // 2026-05-25 BACKEND_AUTH_BRIEF: approvals on proposals whose
    // signature carries amount_cents above the threshold require PIN
    // step-up. Threshold default $50 (5000 cents); env-tunable. iOS
    // catches the 403/step_up_required shape and prompts for PIN.
    // Cookie/PWA path also routes through here uniformly. Only
    // execute-effect actions are gated — modify / defer / reject /
    // noop don't move money.
    if (deps.step_up && resolved_effect === 'execute') {
      const threshold_cents = parseInt(
        process.env.HEARTH_STEP_UP_AMOUNT_CENTS ?? '5000',
        10,
      );
      let amount_cents: number | null = null;
      // A payload may demand step-up regardless of amount — e.g. a Beatrice
      // CODE merge (merge_approved_change), where the risk is the code landing
      // on main, not money. The flag is set by review_change for code changes.
      let explicit_step_up = false;
      try {
        const payload = JSON.parse(existing_for_action.payload_json) as Record<string, unknown>;
        if (typeof payload.amount_cents === 'number') {
          amount_cents = payload.amount_cents;
        }
        if (payload.requires_step_up === true) explicit_step_up = true;
      } catch { /* unparseable payload — no gate */ }
      const needs_step_up = explicit_step_up || (amount_cents !== null && amount_cents > threshold_cents);
      if (needs_step_up) {
        const { require_step_up } = await import('@core/step_up');
        const gate = require_step_up(
          { step_up: deps.step_up },
          { session_id: c.get('session_id'), device_id: c.get('device_id') },
        );
        if (!gate.ok) {
          deps.memory.log_action({
            intent_id: ulid(),
            agent: 'orchestrator',
            tool_name: 'proposal_decide_step_up_required',
            tool_input: {
              proposal_id: id,
              amount_cents,
              threshold_cents,
              explicit_step_up,
            },
          });
          return c.json(gate.response, 403);
        }
      }
    }

    // `effect: 'defer'` — snooze 24h, no status flip beyond that.
    // Short-circuit before the regular decide() so we don't move the
    // signature counts on a defer.
    if (resolved_effect === 'defer') {
      const until = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
      const ok = deps.proposals.snooze(id, until);
      deps.memory.log_action({
        intent_id: ulid(),
        agent: 'orchestrator',
        tool_name: 'proposal_defer',
        tool_input: { proposal_id: id, action_id: resolved_action_id, until },
        execution_result: { ok },
      });
      return c.json({
        ok,
        status: 'snoozed',
        action_taken: resolved_action_id,
        snoozed_until: until,
      });
    }

    const result = deps.proposals.decide(
      id,
      resolved_verdict,
      parsed.data.modifications,
      parsed.data.user_feedback,
      resolved_action_id,
    );
    if (!result) return c.json({ error: 'proposal not found' }, 404);

    deps.memory.log_action({
      intent_id: ulid(),
      agent: 'orchestrator',
      tool_name: 'proposal_decide',
      tool_input: {
        proposal_id: id,
        verdict: resolved_verdict,
        action_id: resolved_action_id,
        effect: resolved_effect,
        modified: Boolean(parsed.data.modifications),
      },
      human_verdict: {
        who: 'user',
        verdict: resolved_verdict,
        modified: Boolean(parsed.data.modifications),
      },
      execution_result: result,
    });

    // `effect: 'modify'` and `effect: 'noop'` — no side effect to
    // run; the user's intent is captured in `action_taken` + status
    // (modify ⇒ approved with the modify marker; noop ⇒ approved
    // with no dispatch). The kind's author specialist can read the
    // action_taken in a follow-up turn if they want to revise +
    // re-file. v0.1 doesn't auto-resubmit on modify — that flow
    // lands when there's a draft_message edit sheet.
    if (resolved_effect === 'modify' || resolved_effect === 'noop') {
      deps.memory.log_action({
        intent_id: ulid(),
        agent: 'orchestrator',
        tool_name: resolved_effect === 'modify' ? 'proposal_modify' : 'proposal_ack',
        tool_input: {
          proposal_id: id,
          action_id: resolved_action_id,
          kind: existing_for_action.kind,
        },
      });
      // Acknowledge/modify is the terminal action for these — there's no
      // execution to run, so move the row off `approved` to the terminal
      // `acknowledged` state (else it sits forever, indistinguishable from a
      // pending execution — the stuck-approved bug).
      deps.proposals.mark_acknowledged(id);
      return c.json({
        ok: true,
        status: 'acknowledged',
        action_taken: resolved_action_id,
        effect: resolved_effect,
      });
    }

    // A kind resolver also owns its REJECT side effect — e.g.
    // trusted_source_addition's reject branch appends the domain to
    // Knowledge/Cordelia/trusted_source_denials.md so Cordelia never
    // re-proposes it. decide() already flipped the row to `denied`, so
    // the resolver outcome here is audit-only: record_execution would
    // wrongly flip a denied row to `executed`, and a resolver failure
    // must not un-record the user's denial. Gated on the picked action
    // being a DECLARED reject action of this proposal, so a legacy
    // `verdict:'deny'` on a kind with no reject action (book_candidate)
    // never reaches a resolver that can't handle it.
    if (resolved_verdict === 'deny' && resolved_effect === 'reject') {
      const declared_reject = existing_for_action.actions.some(
        (a) => a.id === resolved_action_id && a.effect === 'reject',
      );
      const kind_resolver = declared_reject
        ? KIND_RESOLVERS[existing_for_action.kind]
        : undefined;
      if (kind_resolver) {
        let payload: Record<string, unknown> = {};
        try {
          payload = JSON.parse(existing_for_action.payload_json) as Record<string, unknown>;
        } catch {
          /* ignore */
        }
        try {
          const outcome = await kind_resolver({
            proposal: existing_for_action,
            action_id: resolved_action_id,
            payload,
            memory: deps.memory,
            proposals: deps.proposals,
          });
          deps.memory.log_action({
            intent_id: ulid(),
            agent: 'orchestrator',
            tool_name: 'proposal_resolver',
            tool_input: {
              proposal_id: id,
              kind: existing_for_action.kind,
              action_id: resolved_action_id,
            },
            execution_result: outcome,
          });
        } catch (err) {
          deps.memory.log_action({
            intent_id: ulid(),
            agent: 'orchestrator',
            tool_name: 'proposal_resolver',
            tool_input: {
              proposal_id: id,
              kind: existing_for_action.kind,
              action_id: resolved_action_id,
            },
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }

    // Dispatch execution — `execute_approved_proposal` (module-level, shared
    // with the trust-teeth auto-executor) runs the three paths in priority
    // order: kind resolver → generic dispatch_tool → legacy stub, each
    // writing its own audit rows + record_execution. Resolvers reach here on
    // approve because their kinds file `execution_kind: 'composite'`, which
    // decide() includes in `should_execute`; the reject effect runs through
    // the audit-only block above. Only the resolver path is terminal for the
    // HTTP request (it always was): a successful resolver returns the
    // execution result; a throwing one 500s. Dispatch and stub fall through
    // to the fan-out + terminal stamp below.
    if (result.should_execute) {
      const exec = await execute_approved_proposal(deps, id, resolved_action_id);
      if (exec.path === 'resolver') {
        if (exec.ok) {
          return c.json({
            ok: true,
            status: 'executed',
            action_taken: resolved_action_id,
            effect: resolved_effect,
            execution_result: exec.outcome,
          });
        }
        return c.json({ ok: false, error: exec.error }, 500);
      }
    }

    // Beatrice's advisory proposals — `recommendation`,
    // `binding_proposal`, `persona_tuning` — describe a structural fix
    // in markdown but execution_kind='manual', so the dispatch block
    // above never fires for them. Until this fan-out shipped, an
    // approved advisory sat at status='approved' forever and Beatrice
    // had no signal to convert it into a PR via `propose_code_change`.
    // She re-deliberated the next day, saw the same open process_miss
    // (because no code shipped), and filed the same recommendation
    // again — the loop never closed.
    //
    // Push a high-severity inbox flag to trainer carrying the proposal
    // id and naming the next tool to call. The orchestrator's
    // wake-on-flag listener forwards this into LoopDriver, so Beatrice
    // wakes off-schedule and acts in minutes instead of waiting for
    // her 03:00 slot.
    if (resolved_verdict === 'approve') {
      const decided_proposal = deps.proposals.get(id);
      if (decided_proposal && is_beatrice_build_proposal(decided_proposal)) {
        // Approved Beatrice build → dispatch a DIRECTED build (strong model with
        // propose_code_change / propose_code_edit in hand). Those tools exist on
        // NO standing surface, so the prior inbox-flag wake could never author
        // the code — it woke a toolless standing deliberation that spiralled and
        // bailed (the recommendation 01KTDF3… on 2026-06-07 got the flag and
        // still produced no PR). The directed build opens the PR; it lands in the
        // Code Shop for Kate's review, then the owner merges. We record an inbox
        // FYI for the office trail, but DON'T emit the realtime `flag` wake event
        // — that would fire a second, redundant, toolless deliberation alongside
        // the build.
        const body_md =
          `**Approved — build dispatched.** Jasper approved your ` +
          `${decided_proposal.kind} proposal \`${decided_proposal.id}\`` +
          (decided_proposal.title ? `: "${decided_proposal.title}".` : '.') +
          `\n\n` +
          `A directed build (strong model, with your propose_code_change / ` +
          `propose_code_edit tools) was dispatched to implement it — the PR will ` +
          `land in your Code Shop for Kate's review. This is an FYI: do NOT author ` +
          `code in a standing/wake pass (you can't from there), and do NOT re-file ` +
          `the proposal — just acknowledge it.`;
        const inbox_id = deps.inbox.push({
          from_specialist_id: 'orchestrator',
          to_specialist_id: 'trainer',
          kind: 'fyi',
          body_md,
          related_proposal_id: decided_proposal.id,
        });
        deps.memory.log_action({
          intent_id: ulid(),
          agent: 'orchestrator',
          tool_name: 'proposal_build_dispatched',
          tool_input: {
            proposal_id: decided_proposal.id,
            kind: decided_proposal.kind,
            specialist_id: decided_proposal.specialist_id,
            inbox_message_id: inbox_id,
            dispatched: Boolean(deps.fireDirectedBuild),
          },
        });
        deps.fireDirectedBuild?.(decided_proposal);
      }
    }

    // Catch-all terminal stamp: an `approve` that produced no system
    // execution (a manual/advisory kind — recommendation, persona_tuning,
    // briefing FYI, a draft the user sends themselves — or a Beatrice build
    // whose work moved to a beatrice_changes PR via the fan-out above) is
    // still sitting at `approved`. Move it to the terminal `acknowledged`
    // state so it doesn't stall the queue. `mark_acknowledged` is guarded on
    // `status='approved'`, so a row the dispatch block already flipped to
    // `executed`/`failed`, or a `deny`, is untouched.
    const post = deps.proposals.get(id);
    if (post?.status === 'approved' && !is_hiring_packet_proposal(post)) {
      deps.proposals.mark_acknowledged(id);
      result.status = 'acknowledged';
    }

    deps.events?.emit({
      type: 'proposal_decided',
      proposal_id: id,
      verdict: resolved_verdict,
    });

    return c.json({ proposal_id: id, action_taken: resolved_action_id, ...result });
  });

  const SnoozeSchema = z.object({ until: z.string().datetime() });

  r.post('/proposals/:id/snooze', async (c) => {
    const id = c.req.param('id');
    const j = await read_json(c);
    if (!j.ok) return c.json({ error: j.error }, 400);
    const parsed = SnoozeSchema.safeParse(j.body);
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    const ok = deps.proposals.snooze(id, parsed.data.until);
    if (!ok) return c.json({ error: 'proposal not snoozable' }, 404);
    return c.json({ proposal_id: id, status: 'snoozed', until: parsed.data.until });
  });

  // ── Interrupts ───────────────────────────────────────────────────────

  r.get('/interrupts', (c) => {
    const status = c.req.query('status') as 'pending' | undefined;
    return c.json({ interrupts: deps.interrupts.list({ status }) });
  });

  r.post('/interrupts/:id/acknowledge', (c) => {
    const id = c.req.param('id');
    const ok = deps.interrupts.acknowledge(id);
    if (!ok) return c.json({ error: 'interrupt not found or not pending' }, 404);
    return c.json({ interrupt_id: id, status: 'acknowledged' });
  });

  // ── Unified search ───────────────────────────────────────────────────

  r.get('/search', (c) => {
    const q = c.req.query('q');
    if (!q || q.length === 0) return c.json({ error: 'q required' }, 400);
    const scope = (c.req.query('scope') ?? 'all') as
      | 'messages'
      | 'vault'
      | 'proposals'
      | 'all';
    const out: Record<string, unknown> = { q, scope };

    // Per-user cordon (2026-06-04): filter every source to what the caller
    // may see. A user-less internal caller is treated as owner tier.
    const su = c.get('user');
    const su_caller = { user_id: su?.id, tier: su?.tier ?? ('owner' as const) };

    if (scope === 'messages' || scope === 'all') {
      const msgs = deps.conversations.search_messages(q, 80);
      const owner_cache = new Map<string, string | null>();
      const conv_visible = (conv_id: string): boolean => {
        if (!su) return true;
        let owner = owner_cache.get(conv_id);
        if (owner === undefined) {
          const row = deps.db
            .prepare(`SELECT user_id FROM conversations WHERE id = @id`)
            .get({ '@id': conv_id }) as { user_id: string | null } | undefined;
          owner = row?.user_id ?? null;
          owner_cache.set(conv_id, owner);
        }
        if (owner == null) return su_caller.tier === 'owner';
        return owner === su_caller.user_id;
      };
      out.messages = msgs
        .filter((m) => conv_visible(m.conversation_id))
        .slice(0, 20)
        .map((m) => ({
          message_id: m.id,
          conversation_id: m.conversation_id,
          ts: m.ts,
          role: m.role,
          specialist_id: m.specialist_id,
          snippet: m.content_md.slice(0, 300),
        }));
    }

    if (scope === 'vault' || scope === 'all') {
      // FTS5 on the chunks_fts table (populated by the ingestor when running).
      const escaped = q.replace(/"/g, '""');
      const hits = deps.db
        .prepare(
          `SELECT f.note_path AS note_path, f.chunk_text AS chunk_text
           FROM chunks_fts f
           WHERE f MATCH @q
           ORDER BY f.rank LIMIT 80`,
        )
        .all({ '@q': `"${escaped}"` }) as Array<{
        note_path: string;
        chunk_text: string;
      }>;
      // Visibility from the LIVE note by the ONE rule (cordon OR named grant) —
      // identical to /api/search's vault branch and to the RAG chunk gate. The
      // `LEFT JOIN clippings` this replaced resolved NULL for every non-clipping
      // note (media_item included), which the cordon reads as unset → owner-only:
      // it leaked a member's own media chunk to the owner AND hid an explicitly
      // shared one from its grantee.
      const vault_seen = new Map<string, boolean>();
      const vault_visible = (note_path: string): boolean => {
        const hit = vault_seen.get(note_path);
        if (hit !== undefined) return hit;
        const val = deps.memory.note_path_visible_to_caller(note_path, su_caller);
        vault_seen.set(note_path, val);
        return val;
      };
      out.vault = hits
        .filter((h) => vault_visible(h.note_path))
        .slice(0, 20)
        .map((h) => ({
          note_path: h.note_path,
          snippet: h.chunk_text.slice(0, 300),
        }));
    }

    if (scope === 'proposals' || scope === 'all') {
      // Simple LIKE search across rationale and payload.
      const like = `%${q.replace(/[%_]/g, '')}%`;
      const prop_cordon = su
        ? su.tier === 'owner'
          ? 'AND (user_id IS NULL OR user_id = @uid)'
          : 'AND user_id = @uid'
        : '';
      const rows = deps.db
        .prepare(
          `SELECT id, specialist_id, kind, rationale_md, ts_created
           FROM proposals
           WHERE (rationale_md LIKE @q OR payload_json LIKE @q) ${prop_cordon}
           ORDER BY ts_created DESC LIMIT 20`,
        )
        .all({ '@q': like, ...(su ? { '@uid': su.id } : {}) }) as Array<{
        id: string;
        specialist_id: string;
        kind: string;
        rationale_md: string;
        ts_created: string;
      }>;
      out.proposals = rows;
    }

    return c.json(out);
  });

  return r;
}
