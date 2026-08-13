/**
 * tool_exemplars — worked-example tool calls mined from the audit log.
 *
 * Small models call tools far more accurately with ONE worked example in
 * front of them than with a schema alone (the empty-args / arg-spiral wall
 * is mostly a "what does a good call LOOK like" gap). Hand-written examples
 * drift as schemas evolve; the audit log doesn't — so each tool's example
 * is mined from its most recent SUCCESSFUL call and appended to the tool
 * description at serialization time. The docs teach from the roster's own
 * successful usage, automatically, forever.
 *
 * PRIVACY: call args can carry personal content (search queries, note
 * bodies), and a tool description is cross-surface prompt material — so
 * values are TYPE-AWARE SANITIZED before use: numbers/booleans/null kept;
 * token-like strings (ids, enum values, entity_ids, paths, URLs — no
 * whitespace) kept; every free-text string replaced with "…". The teaching
 * value is the SHAPE — which keys, what kinds of values — and that survives
 * sanitization. Arrays show one sanitized element; objects cap at 8 keys.
 *
 * Cached in-memory per tool (TTL 6h) so the per-turn cost is a Map lookup.
 * Kill switch: HEARTH_TOOL_EXEMPLARS=0.
 */
import type { Database } from 'bun:sqlite';

const TTL_MS = 6 * 3_600_000;
const MAX_EXEMPLAR_CHARS = 280;
const MAX_OBJECT_KEYS = 8;
/** No whitespace, bounded length — ids/enums/paths/URLs, never prose. */
const TOKENISH = /^[\w.\-:/@#?&=%]{1,48}$/;

export function exemplars_enabled(): boolean {
  return process.env.HEARTH_TOOL_EXEMPLARS !== '0';
}

export function sanitize_args(value: unknown, depth = 0): unknown {
  if (depth > 3) return '…';
  if (value === null || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'string') {
    return TOKENISH.test(value) ? value : '…';
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return [];
    return [sanitize_args(value[0], depth + 1)];
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    let n = 0;
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (n >= MAX_OBJECT_KEYS) break;
      out[k] = sanitize_args(v, depth + 1);
      n++;
    }
    return out;
  }
  return '…';
}

interface CacheEntry {
  exemplar: string | null;
  mined_at: number;
}

const _cache = new Map<string, CacheEntry>();

/**
 * The sanitized JSON of the tool's most recent successful call, or null
 * when nothing usable exists. Mines a handful of recent rows and takes the
 * first that survives sanitization as a non-empty object.
 */
export function exemplar_for(db: Database, tool_name: string): string | null {
  const hit = _cache.get(tool_name);
  const now = Date.now();
  if (hit && now - hit.mined_at < TTL_MS) return hit.exemplar;

  let exemplar: string | null = null;
  try {
    const rows = db
      .prepare(
        `SELECT tool_input FROM audit_log
          WHERE tool_name = @t
            AND (error IS NULL OR error = '')
            AND tool_input NOT IN ('{}', 'null', '')
          ORDER BY ts DESC LIMIT 5`,
      )
      .all({ '@t': tool_name }) as Array<{ tool_input: string }>;
    for (const r of rows) {
      try {
        const parsed = JSON.parse(r.tool_input) as unknown;
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
        const clean = sanitize_args(parsed) as Record<string, unknown>;
        if (Object.keys(clean).length === 0) continue;
        const json = JSON.stringify(clean);
        if (json.length > MAX_EXEMPLAR_CHARS) continue;
        exemplar = json;
        break;
      } catch {
        continue;
      }
    }
  } catch {
    // audit table unavailable (isolated smokes) — no exemplar, no error.
    exemplar = null;
  }
  _cache.set(tool_name, { exemplar, mined_at: now });
  return exemplar;
}

/** Test seam — clear the cache between smoke cases. */
export function _test_reset_exemplars(): void {
  _cache.clear();
}
