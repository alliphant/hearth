/**
 * Tolerant LLM-JSON-array parsing — shared by Kristi's catalog extractor
 * (extract_layer.ts) and lane clusterer (cluster_swimlanes.ts).
 *
 * The local research-extract model truncates at the token cap (→ "Unterminated
 * string") and occasionally emits a stray non-JSON token mid-array (→ "Property
 * name must be a string literal"). A single `JSON.parse` throws away the WHOLE
 * pass on either — which silently zeroed both the catalog passes and the
 * clustering (recorded:0 / assigned:0) on 2026-06-04. These helpers degrade
 * gracefully instead: a truncated tail or one malformed row drops, not the batch.
 */

/** Strip a ```json … ``` fence if the model wrapped its JSON. */
export function strip_fence(s: string): string {
  const m = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  return (m?.[1] ?? s).trim();
}

/**
 * Parse the model's JSON array of row objects tolerantly: strip the fence,
 * isolate the outer array, fast-path parse, and on failure SALVAGE — walk
 * balanced top-level `{…}` objects and parse each independently, keeping the
 * ones that parse. A truncated final object or one bad row is dropped, never the
 * whole batch.
 */
export function parse_rows_tolerant(raw: string): Record<string, unknown>[] {
  const s = strip_fence(raw);
  const start = s.indexOf('[');
  const body = start >= 0 ? s.slice(start) : s;
  try {
    const v = JSON.parse(body) as unknown;
    if (Array.isArray(v)) return v as Record<string, unknown>[];
    if (Array.isArray((v as { rows?: unknown })?.rows)) return (v as { rows: Record<string, unknown>[] }).rows;
  } catch {
    /* fall through to object-by-object salvage */
  }
  const rows: Record<string, unknown>[] = [];
  let depth = 0;
  let objStart = -1;
  let inStr = false;
  let esc = false;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') {
      if (depth === 0) objStart = i;
      depth++;
    } else if (c === '}') {
      depth--;
      if (depth === 0 && objStart >= 0) {
        try {
          rows.push(JSON.parse(body.slice(objStart, i + 1)) as Record<string, unknown>);
        } catch {
          /* skip a malformed object, keep the rest */
        }
        objStart = -1;
      }
    }
  }
  return rows;
}
