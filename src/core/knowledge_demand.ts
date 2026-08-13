/**
 * knowledge_demand — the demand ledger (Cordelia knowledge metabolism #1,
 * 2026-06-10).
 *
 * Mines the audit trail for the signals that mean "a specialist needed
 * knowledge the shelves didn't have" and clusters them into demand topics
 * per specialist, so Cordelia's acquisition budget chases REAL demand
 * instead of speculative pre-fetching. Four signal sources, all already
 * written by the runtime (no new instrumentation):
 *
 *   - `rag_low_confidence` audit rows — turn-start retrieval whose best
 *     rerank score fell below HEARTH_RAG_MIN_RERANK and was suppressed
 *     (src/core/specialist_runtime.ts). The strongest signal: the user
 *     asked, the shelf had nothing relevant enough to show.
 *   - `search_library` audit rows with `execution_result.hits === 0` —
 *     an explicit mid-turn lookup that came back empty.
 *   - `eval_runs` failures — a golden-task regression often traces to a
 *     grounding gap (the fixture's knowledge wasn't on the shelf).
 *   - `citation_guard` audit rows — claims that couldn't be matched to a
 *     source at finalize; the reply wanted evidence the turn never had.
 *
 * Clustering is DETERMINISTIC token-overlap grouping (no LLM): normalize
 * each signal's text to an informative-token set, then greedily merge
 * signals whose token sets overlap. Good enough at household scale, and
 * it keeps the report reproducible — the same window always yields the
 * same topics, which matters because audit_refs from this report feed
 * acquisition sprints and we want a re-run to verify, not reshuffle.
 *
 * Per-user cordon: every signal keeps its originating `user_id`. A topic
 * whose evidence comes entirely from ONE user exposes `sole_user_id` so
 * the consumer (acquire_knowledge) can shelve the resulting material at
 * that user's visibility instead of shelf-wide — a non-owner household
 * member's questions must not turn into owner-visible-only OR
 * everyone-visible shelves by accident (see the private dev log "per-user data
 * cordon").
 */

import type { Database } from 'bun:sqlite';

export type DemandSignalKind =
  | 'rag_low_confidence'
  | 'search_empty'
  | 'eval_failure'
  | 'citation_gap';

export interface DemandSignal {
  kind: DemandSignalKind;
  /** Specialist the demand belongs to. `null` when the audit row could
   *  not be attributed (legacy `search_library` rows logged
   *  agent='orchestrator' before the 2026-06-10 attribution fix). */
  specialist_id: string | null;
  /** The demand text — query preview, failing-eval detail, or uncited
   *  claim list. Already truncated by the writers (~120 chars). */
  text: string;
  /** Originating user, when the signal row carried one. */
  user_id: string | null;
  /** Stable reference back to the evidence: `audit:<id>` or `eval:<id>`. */
  ref: string;
  ts: string;
}

export interface DemandTopic {
  /** `null` = unattributed (legacy rows) — render as team-wide. */
  specialist_id: string | null;
  /** Short deterministic label built from the cluster's top tokens. */
  label: string;
  evidence_count: number;
  /** Signal-kind breakdown, e.g. { rag_low_confidence: 3, search_empty: 1 }. */
  kinds: Partial<Record<DemandSignalKind, number>>;
  /** Up to 3 distinct raw signal texts, newest first. */
  sample_texts: string[];
  /** Up to 8 evidence refs (audit:<id> / eval:<id>), newest first. */
  refs: string[];
  /** Distinct non-null user ids across the evidence. */
  user_ids: string[];
  /** Set iff EVERY user-attributed signal in the cluster came from one
   *  user — the cordon hint for acquisition (see module doc). */
  sole_user_id: string | null;
  first_seen: string;
  last_seen: string;
  /** Evidence in the recent half of the window (`ts >= window midpoint`). */
  recent_evidence: number;
  /** Evidence in the older half of the window. */
  prior_evidence: number;
  /**
   * Direction of the gap over the window — recent half vs older half:
   * `growing` (recent > prior), `declining` (recent < prior), `steady`
   * (equal), or `new` (all evidence in the recent half — a just-emerged
   * gap). `steady` when no window context was supplied (the trend can't
   * be computed). Lets a consumer prioritize an accruing gap over a
   * stale one of equal raw count.
   */
  trend_direction: 'growing' | 'steady' | 'declining' | 'new';
}

export interface MineOptions {
  window_days: number;
  now: Date;
}

export interface ClusterOptions {
  /** Cap on returned topics (after sorting by evidence_count desc). */
  max_topics: number;
  /**
   * Window context for the per-topic trend split (recent half vs older
   * half). Both flow from `MineOptions` through `mine_knowledge_demand`,
   * so the convenience entry computes trends for free; a direct
   * `cluster_demand` caller that omits them gets `trend_direction:
   * 'steady'` (the trend is simply not computed).
   */
  now?: Date;
  window_days?: number;
}

/* ------------------------------------------------------------------ */
/* Signal mining                                                       */
/* ------------------------------------------------------------------ */

interface AuditRow {
  id: string;
  ts: string;
  agent: string | null;
  tool_input: string;
  execution_result: string | null;
  user_id: string | null;
}

function safe_parse_json(s: string | null): Record<string, unknown> | null {
  if (!s) return null;
  try {
    const v = JSON.parse(s) as unknown;
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      return v as Record<string, unknown>;
    }
  } catch {
    /* opportunistic */
  }
  return null;
}

/** Agents that mean "no specialist attribution" on legacy audit rows. */
const UNATTRIBUTED_AGENTS = new Set(['orchestrator', 'specialist', 'ingestor']);

function attribute(agent: string | null): string | null {
  if (!agent) return null;
  return UNATTRIBUTED_AGENTS.has(agent) ? null : agent;
}

/**
 * Pull the window's demand signals out of audit_log + eval_runs.
 * Read-only; deterministic for a fixed (db, window, now).
 */
export function mine_demand_signals(db: Database, opts: MineOptions): DemandSignal[] {
  const cutoff_iso = new Date(
    opts.now.getTime() - opts.window_days * 86_400_000,
  ).toISOString();
  const out: DemandSignal[] = [];

  const typed_rows = db
    .prepare(
      `SELECT id, ts, agent, tool_name, tool_input, execution_result, user_id
         FROM audit_log
        WHERE tool_name IN ('rag_low_confidence', 'search_library', 'citation_guard')
          AND ts >= @cutoff
        ORDER BY ts DESC`,
    )
    .all({ '@cutoff': cutoff_iso }) as Array<AuditRow & { tool_name: string }>;

  for (const r of typed_rows) {
    const inp = safe_parse_json(r.tool_input);
    const exec = safe_parse_json(r.execution_result);
    const specialist_id = attribute(r.agent);
    if (r.tool_name === 'rag_low_confidence') {
      const text =
        typeof inp?.query_preview === 'string' ? inp.query_preview.trim() : '';
      if (!text) continue;
      out.push({
        kind: 'rag_low_confidence',
        specialist_id,
        text,
        user_id: r.user_id,
        ref: `audit:${r.id}`,
        ts: r.ts,
      });
    } else if (r.tool_name === 'search_library') {
      const hits = typeof exec?.hits === 'number' ? exec.hits : null;
      if (hits !== 0) continue; // only EMPTY results are demand signals
      const text =
        typeof inp?.query_preview === 'string' ? inp.query_preview.trim() : '';
      if (!text) continue;
      out.push({
        kind: 'search_empty',
        specialist_id,
        text,
        user_id: r.user_id,
        ref: `audit:${r.id}`,
        ts: r.ts,
      });
    } else {
      // citation_guard — findings are ["mismatched:<claim>", "uncited:<claim>", …]
      const findings = Array.isArray(inp?.findings)
        ? (inp.findings as unknown[]).filter((f): f is string => typeof f === 'string')
        : [];
      if (findings.length === 0) continue;
      const text = findings
        .map((f) => f.replace(/^(mismatched|uncited):/, '').trim())
        .filter((f) => f.length > 0)
        .join(' ; ')
        .slice(0, 240);
      if (!text) continue;
      out.push({
        kind: 'citation_gap',
        specialist_id,
        text,
        user_id: r.user_id,
        ref: `audit:${r.id}`,
        ts: r.ts,
      });
    }
  }

  const eval_rows = db
    .prepare(
      `SELECT id, ts, task_id, specialist_id, detail
         FROM eval_runs
        WHERE passed = 0 AND ts >= @cutoff
        ORDER BY ts DESC`,
    )
    .all({ '@cutoff': cutoff_iso }) as Array<{
    id: string;
    ts: string;
    task_id: string;
    specialist_id: string;
    detail: string;
  }>;
  for (const r of eval_rows) {
    const text = `${r.task_id} ${r.detail}`.trim().slice(0, 240);
    if (!text) continue;
    out.push({
      kind: 'eval_failure',
      specialist_id: r.specialist_id || null,
      text,
      user_id: null,
      ref: `eval:${r.id}`,
      ts: r.ts,
    });
  }

  // Newest first across all sources, stable on ref for determinism.
  out.sort((a, b) => (a.ts === b.ts ? (a.ref < b.ref ? 1 : -1) : a.ts < b.ts ? 1 : -1));
  return out;
}

/* ------------------------------------------------------------------ */
/* Deterministic clustering                                            */
/* ------------------------------------------------------------------ */

const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'what', 'when', 'where',
  'which', 'who', 'whom', 'why', 'how', 'can', 'could', 'should', 'would',
  'about', 'are', 'was', 'were', 'have', 'has', 'had', 'does', 'did',
  'not', 'but', 'all', 'any', 'you', 'your', 'his', 'her', 'its', 'our',
  'their', 'them', 'they', 'there', 'here', 'from', 'into', 'onto', 'out',
  'over', 'under', 'than', 'then', 'too', 'very', 'just', 'like', 'get',
  'got', 'best', 'top', 'near', 'nearby', 'need', 'needs', 'want', 'tell',
  'show', 'find', 'look', 'looking', 'know', 'will', 'one', 'two',
]);

/** Normalize a signal text into its informative-token set. */
export function demand_tokens(text: string): Set<string> {
  const toks = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t));
  return new Set(toks);
}

/** Overlap coefficient: |a∩b| / min(|a|,|b|). Forgiving on short queries. */
function overlap(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const t of small) if (large.has(t)) inter++;
  return inter / small.size;
}

const OVERLAP_THRESHOLD = 0.5;

interface Cluster {
  specialist_id: string | null;
  signals: DemandSignal[];
  token_counts: Map<string, number>;
  tokens: Set<string>;
}

function label_of(cluster: Cluster): string {
  const ranked = Array.from(cluster.token_counts.entries()).sort((a, b) =>
    a[1] === b[1] ? (a[0] < b[0] ? -1 : 1) : b[1] - a[1],
  );
  return ranked
    .slice(0, 4)
    .map(([t]) => t)
    .join(' ');
}

/**
 * Greedy deterministic clustering: signals are visited newest-first
 * (the order mine_demand_signals returns); each joins the first cluster
 * for the same specialist whose token set overlaps ≥ OVERLAP_THRESHOLD,
 * else starts a new one.
 */
export function cluster_demand(
  signals: DemandSignal[],
  opts: ClusterOptions,
): DemandTopic[] {
  const clusters: Cluster[] = [];
  for (const sig of signals) {
    const toks = demand_tokens(sig.text);
    if (toks.size === 0) continue;
    let home: Cluster | null = null;
    for (const c of clusters) {
      if (c.specialist_id !== sig.specialist_id) continue;
      if (overlap(toks, c.tokens) >= OVERLAP_THRESHOLD) {
        home = c;
        break;
      }
    }
    if (!home) {
      home = {
        specialist_id: sig.specialist_id,
        signals: [],
        token_counts: new Map(),
        tokens: new Set(),
      };
      clusters.push(home);
    }
    home.signals.push(sig);
    for (const t of toks) {
      home.token_counts.set(t, (home.token_counts.get(t) ?? 0) + 1);
      home.tokens.add(t);
    }
  }

  // Window midpoint as an ISO string — signals carry UTC ISO `ts`, so a
  // lexicographic compare splits recent half (>= midpoint) from older.
  const midpoint_iso =
    opts.now && opts.window_days
      ? new Date(
          opts.now.getTime() - (opts.window_days * 86_400_000) / 2,
        ).toISOString()
      : null;

  const topics: DemandTopic[] = clusters.map((c) => {
    const kinds: Partial<Record<DemandSignalKind, number>> = {};
    const user_ids = new Set<string>();
    const sample_texts: string[] = [];
    const refs: string[] = [];
    let first_seen = c.signals[0]?.ts ?? '';
    let last_seen = c.signals[0]?.ts ?? '';
    let recent_evidence = 0;
    let prior_evidence = 0;
    for (const s of c.signals) {
      kinds[s.kind] = (kinds[s.kind] ?? 0) + 1;
      if (s.user_id) user_ids.add(s.user_id);
      if (sample_texts.length < 3 && !sample_texts.includes(s.text)) {
        sample_texts.push(s.text);
      }
      if (refs.length < 8) refs.push(s.ref);
      if (s.ts < first_seen) first_seen = s.ts;
      if (s.ts > last_seen) last_seen = s.ts;
      if (midpoint_iso !== null) {
        if (s.ts >= midpoint_iso) recent_evidence++;
        else prior_evidence++;
      }
    }
    let trend_direction: DemandTopic['trend_direction'];
    if (midpoint_iso === null) trend_direction = 'steady';
    else if (prior_evidence === 0 && recent_evidence > 0) trend_direction = 'new';
    else if (recent_evidence > prior_evidence) trend_direction = 'growing';
    else if (recent_evidence < prior_evidence) trend_direction = 'declining';
    else trend_direction = 'steady';
    const distinct_users = Array.from(user_ids).sort();
    return {
      specialist_id: c.specialist_id,
      label: label_of(c),
      evidence_count: c.signals.length,
      kinds,
      sample_texts,
      refs,
      user_ids: distinct_users,
      sole_user_id: distinct_users.length === 1 ? distinct_users[0]! : null,
      first_seen,
      last_seen,
      recent_evidence,
      prior_evidence,
      trend_direction,
    };
  });

  topics.sort((a, b) =>
    a.evidence_count === b.evidence_count
      ? a.label < b.label
        ? -1
        : 1
      : b.evidence_count - a.evidence_count,
  );
  return topics.slice(0, opts.max_topics);
}

/** Convenience: mine + cluster in one call. */
export function mine_knowledge_demand(
  db: Database,
  opts: MineOptions & ClusterOptions,
): { signals_scanned: number; topics: DemandTopic[] } {
  const signals = mine_demand_signals(db, opts);
  return {
    signals_scanned: signals.length,
    topics: cluster_demand(signals, opts),
  };
}
