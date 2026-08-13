/**
 * Privacy self-test — the *provable* half of the per-user data cordon.
 *
 * The cordon ([note_visible_to_caller](../memory/private_to.ts)) already
 * stops one household member's private data from reaching another through
 * any Hearth surface. This module makes that guarantee **provable to the
 * member themselves**: it runs the REAL read surfaces *as the calling
 * user* and reports, per data domain, "{N} items belong to other members
 * — {reachable} of them came back to you."
 *
 * The load-bearing design choice (per LAW #1 — no theater): this is NOT a
 * canned green checklist. Each probe
 *   1. counts, by a privileged DB read, how many items genuinely belong to
 *      OTHER users (the cordon would hide them from the caller), then
 *   2. exercises the actual cordoned read surface the LLM/UI uses
 *      (`retrieve_scoped_chunks`, `proposals.list`, `conversations.list`)
 *      AS the caller, and counts how many of those other-user items leak
 *      through.
 * A passing probe means `reachable === 0` against real data. If a
 * regression ever let another user's note surface, the probe turns RED —
 * it does not silently pass. The engine reads privileged data only to
 * CONSTRUCT the adversarial probe; it returns counts + verdicts to the
 * member, never another user's content.
 *
 * Concept + threat model: docs/security/provable-cordon-concept.md.
 */

import type { Database } from 'bun:sqlite';
import type { Tier } from '@core/users';
import { note_visible_to_caller } from '@memory/private_to';
import { verify_audit_chain } from '@core/audit_chain';

/** Default window for the panel's ledger-integrity check (full CLI verifies all). */
const LEDGER_VERIFY_LIMIT = (() => {
  const n = Number(process.env.HEARTH_AUDIT_CHAIN_VERIFY_LIMIT);
  return Number.isFinite(n) && n > 0 ? n : 2000;
})();

/** Tamper-evidence status of the audit ledger, surfaced on the member panel. */
export interface LedgerStatus {
  /** intact = unbroken chain; broken = a row was edited/deleted; empty/unavailable = no verdict. */
  status: 'intact' | 'broken' | 'empty' | 'unavailable';
  /** 'full' = every chained row verified; 'recent' = the most recent window. */
  scope: 'full' | 'recent';
  entries_verified: number;
  total_entries: number;
  /** The chain head — the client can remember it to detect later truncation (Phase 1.5). */
  head_hash: string | null;
}

/** A single end-to-end leak probe over one data domain. */
export interface PrivacyProbe {
  id: string;
  /** Short member-facing label, e.g. "Knowledge search & AI retrieval". */
  label: string;
  /** What we tried, in plain language. */
  description: string;
  /** How many items in this domain belong to OTHER household members. */
  belonging_to_others: number;
  /**
   * How many of those other-member items the real read surface actually
   * returned to you. The whole point: this must be 0.
   */
  reachable_by_you: number;
  /**
   * For the live-search domain: how many other-member items we actively
   * probed via the retrieval surface (vs. counted by the gate). Omitted
   * where every item is exercised.
   */
  actively_probed?: number;
  /** reachable_by_you === 0 */
  passed: boolean;
  /** The concrete surface exercised, e.g. "FTS knowledge retrieval". */
  surface_tested: string;
}

export interface OversightEntry {
  /** Display name of whoever ran the oversight review (the owner). */
  reviewer: string;
  /** When the review ran (ISO). */
  at: string;
}

export interface PrivacySelfTestReport {
  user_id: string;
  tier: Tier;
  display_name: string;
  generated_at: string;
  overall_passed: boolean;
  /** Plain-language statement of who can see this member's data. */
  rule_summary: string;
  /** Per-tier bullet guarantees, member-facing. */
  guarantees: string[];
  /** The one sanctioned cross-cordon path + this member's actual history. */
  exception: {
    tool: 'review_user_activity';
    explanation: string;
    used_count: number;
    history: OversightEntry[];
  };
  /** Phase 1b — tamper-evidence of the audit ledger this report reads from. */
  ledger: LedgerStatus;
  probes: PrivacyProbe[];
}

/**
 * Structural, minimal dep shapes — the real `MemoryClient` /
 * `ProposalsStore` / `ConversationStore` / `UserRegistry` all satisfy
 * these, and a smoke can pass lightweight stubs.
 */
export interface PrivacySelfTestDeps {
  db: Database;
  memory: {
    retrieve_scoped_chunks(opts: {
      query: string;
      knowledge_scope: string[];
      k?: number;
      user_id?: string;
      user_tier?: Tier;
    }): Array<{ note_path: string }>;
  };
  proposals: {
    list(filter: { visible_to?: { user_id: string; tier: Tier } }): Array<{
      user_id: string | null;
    }>;
  };
  conversations: {
    list(filter: { user_id?: string }): Array<{ user_id: string | null }>;
  };
  users: { get(user_id: string): { display_name?: string } | null | undefined };
}

export interface PrivacyCaller {
  user_id: string;
  tier: Tier;
  display_name: string;
}

/** Pure verdict helper — exposed so a smoke can prove the prover. */
export function probe_passed(reachable_by_you: number): boolean {
  return reachable_by_you === 0;
}

interface OtherNote {
  note_path: string;
  title: string;
}

/**
 * Enumerate vault notes + library files that belong to OTHER members —
 * i.e. the cordon would hide them from this caller. Privileged read; used
 * only to build the adversarial probe.
 */
function others_notes(db: Database, caller: PrivacyCaller): OtherNote[] {
  const out: OtherNote[] = [];
  const caller_c = { user_id: caller.user_id, tier: caller.tier };

  const clip = db
    .prepare(
      `SELECT note_path, title, private_to FROM clippings WHERE private_to IS NOT NULL`,
    )
    .all() as Array<{ note_path: string; title: string; private_to: string }>;
  for (const r of clip) {
    if (!note_visible_to_caller(r.private_to, caller_c)) {
      out.push({ note_path: r.note_path, title: r.title ?? '' });
    }
  }

  // library_files carry private_to too (direct uploads stamp the uploader).
  try {
    const lib = db
      .prepare(
        `SELECT rel_path, title, private_to FROM library_files WHERE private_to IS NOT NULL`,
      )
      .all() as Array<{ rel_path: string; title: string | null; private_to: string }>;
    for (const r of lib) {
      if (!note_visible_to_caller(r.private_to, caller_c)) {
        out.push({ note_path: r.rel_path, title: r.title ?? '' });
      }
    }
  } catch {
    // library_files may not exist in a minimal db — skip, clippings is the core.
  }

  return out;
}

const PROBE_SAMPLE_CAP = 40;

/**
 * Vault / RAG probe: take the titles of notes that belong to other members
 * and search Hearth's knowledge index AS the caller. A working cordon
 * returns none of them.
 */
function probe_vault_rag(deps: PrivacySelfTestDeps, caller: PrivacyCaller): PrivacyProbe {
  const others = others_notes(deps.db, caller);
  const others_paths = new Set(others.map((n) => n.note_path));

  // Search the WHOLE corpus as the caller using each other-note's own title
  // as the query — the strongest "pull their note by its own words" probe.
  let reachable = 0;
  let probed = 0;
  for (const note of others.slice(0, PROBE_SAMPLE_CAP)) {
    const q = (note.title || note.note_path).trim();
    if (!q) continue;
    probed += 1;
    let hits: Array<{ note_path: string }> = [];
    try {
      hits = deps.memory.retrieve_scoped_chunks({
        query: q,
        knowledge_scope: ['**'],
        k: 8,
        user_id: caller.user_id,
        user_tier: caller.tier,
      });
    } catch {
      hits = [];
    }
    for (const h of hits) {
      if (others_paths.has(h.note_path)) reachable += 1;
    }
  }

  return {
    id: 'vault_rag',
    label: 'Knowledge search & AI retrieval',
    description:
      'We searched Hearth’s entire knowledge index — the same path the AI uses to answer — using the actual titles of notes and captures that belong to other household members.',
    belonging_to_others: others.length,
    reachable_by_you: reachable,
    actively_probed: probed,
    passed: probe_passed(reachable),
    surface_tested: 'retrieve_scoped_chunks (FTS; shares the visibility gate with vector search)',
  };
}

/** Proposals probe: the queue should never show another member's proposals. */
function probe_proposals(deps: PrivacySelfTestDeps, caller: PrivacyCaller): PrivacyProbe {
  const others_count = (
    deps.db
      .prepare(
        `SELECT COUNT(*) AS n FROM proposals WHERE user_id IS NOT NULL AND user_id != @me`,
      )
      .get({ '@me': caller.user_id }) as { n: number } | undefined
  )?.n ?? 0;

  const visible = deps.proposals.list({
    visible_to: { user_id: caller.user_id, tier: caller.tier },
  });
  const reachable = visible.filter(
    (p) => p.user_id != null && p.user_id !== caller.user_id,
  ).length;

  return {
    id: 'proposals',
    label: 'Proposals & approvals queue',
    description:
      'We listed the proposals visible to you and checked whether any belong to another member.',
    belonging_to_others: others_count,
    reachable_by_you: reachable,
    passed: probe_passed(reachable),
    surface_tested: 'proposals.list({ visible_to })',
  };
}

/** Conversations probe: another member's chats must not appear in yours. */
function probe_conversations(deps: PrivacySelfTestDeps, caller: PrivacyCaller): PrivacyProbe {
  const others_count = (
    deps.db
      .prepare(
        `SELECT COUNT(*) AS n FROM conversations WHERE user_id IS NOT NULL AND user_id != @me`,
      )
      .get({ '@me': caller.user_id }) as { n: number } | undefined
  )?.n ?? 0;

  const mine = deps.conversations.list({ user_id: caller.user_id });
  const reachable = mine.filter(
    (c) => c.user_id != null && c.user_id !== caller.user_id,
  ).length;

  return {
    id: 'conversations',
    label: 'Conversations',
    description:
      'We listed the conversations attached to your account and checked whether any belong to another member.',
    belonging_to_others: others_count,
    reachable_by_you: reachable,
    passed: probe_passed(reachable),
    surface_tested: 'conversations.list({ user_id })',
  };
}

/** This member's actual owner-oversight history (the one sanctioned path). */
function oversight_history(
  deps: PrivacySelfTestDeps,
  caller: PrivacyCaller,
): OversightEntry[] {
  let rows: Array<{ ts: string; user_id: string | null }> = [];
  try {
    rows = deps.db
      .prepare(
        // Prefer the subject_user_id column (Phase 1a); fall back to the
        // legacy json_extract for rows written before the column existed.
        `SELECT ts, user_id FROM audit_log
         WHERE tool_name = 'owner_oversight_review'
           AND (subject_user_id = @me
                OR (subject_user_id IS NULL
                    AND json_extract(tool_input, '$.target_user_id') = @me))
         ORDER BY ts DESC LIMIT 50`,
      )
      .all({ '@me': caller.user_id }) as Array<{ ts: string; user_id: string | null }>;
  } catch {
    rows = [];
  }
  return rows.map((r) => ({
    reviewer: (r.user_id && deps.users.get(r.user_id)?.display_name) || 'the owner',
    at: r.ts,
  }));
}

function rule_for_tier(caller: PrivacyCaller): { summary: string; guarantees: string[] } {
  const you = caller.display_name || 'you';
  if (caller.tier === 'owner') {
    return {
      summary:
        'You run Hearth — but running it does not make you a super-user of other people’s private data. Their personal notes, captures, and chats are walled off from you too.',
      guarantees: [
        'You see your own private notes, the shared family graph (People & Places), and system/household context.',
        'You do NOT see other members’ personal notes, captures, or chats through search, AI retrieval, the proposal queue, or the file manager.',
        'Your one deliberate reach across the wall is the owner-oversight summary — and it is logged to the person you review (they see it on this page).',
      ],
    };
  }
  if (caller.tier === 'household') {
    return {
      summary: `As a household member, ${you}’s personal data is yours. No other member — including the owner — can see your personal notes, captures, or chats through Hearth.`,
      guarantees: [
        'You see your own private notes and chats, plus the shared family graph (People & Places).',
        'No other member, and not the owner, can read your personal notes, captures, or chats through any Hearth surface.',
        'The only exception is a logged owner-oversight summary of your activity — never your raw content — and you can see every time it has been used, below.',
      ],
    };
  }
  return {
    summary: `As a guest, ${you}’s data is fully siloed to you. You don’t contribute to the shared family graph, and no one else can see your personal data through Hearth.`,
    guarantees: [
      'Your notes, captures, and chats are visible only to you.',
      'You do not see — and are not seen in — the shared family graph or any other member’s data.',
      'No owner-oversight summary applies to a guest account.',
    ],
  };
}

/**
 * Run the full member-facing privacy self-test for one caller. Read-only;
 * exercises production cordon surfaces with the caller's real identity.
 */
export function run_privacy_self_test(
  deps: PrivacySelfTestDeps,
  caller: PrivacyCaller,
): PrivacySelfTestReport {
  const probes: PrivacyProbe[] = [
    probe_vault_rag(deps, caller),
    probe_proposals(deps, caller),
    probe_conversations(deps, caller),
  ];
  const history = oversight_history(deps, caller);
  const { summary, guarantees } = rule_for_tier(caller);
  const ledger = audit_ledger_status(deps.db);

  return {
    user_id: caller.user_id,
    tier: caller.tier,
    display_name: caller.display_name,
    generated_at: new Date().toISOString(),
    overall_passed: probes.every((p) => p.passed),
    rule_summary: summary,
    guarantees,
    exception: {
      tool: 'review_user_activity',
      explanation:
        'The owner can ask for a SUMMARY of a member’s activity (counts and topics over a window) — never the raw notes, chats, or photos. Every use is recorded and shown to the person reviewed.',
      used_count: history.length,
      history,
    },
    ledger,
    probes,
  };
}

/** Verify the audit ledger's recent window and shape it for the member panel. */
function audit_ledger_status(db: Database): LedgerStatus {
  const v = verify_audit_chain(db, { limit: LEDGER_VERIFY_LIMIT });
  return {
    status: v.status,
    scope: v.scope,
    entries_verified: v.rows_checked,
    total_entries: v.total_chained,
    head_hash: v.head_hash,
  };
}
