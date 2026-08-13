/**
 * Central registry of tools available to specialists.
 *
 * Tools register against capabilities; the runtime denies invocation if the
 * calling specialist's granted set is missing any of the tool's required
 * capabilities. The error surfaces to the LLM so it can recover by either
 * delegating to a specialist who DOES have the capability, or telling the
 * user it can't do this.
 *
 * Scribe/Concierge tools (the existing pattern) intentionally bypass this
 * registry — they belong to fixed-persona agents and route via /scribe/*
 * and /concierge/*. The registry exists to serve specialists.
 */

import { zodToJsonSchema } from 'zod-to-json-schema';
import type { z } from 'zod';
import type { Tool, ToolContext } from './tool';
import type { Capability } from './capabilities';
import { missing_capability } from './capabilities';
import { resolve_leaf, extract_scalar_for_leaf } from './scalar_recovery';

/**
 * Qwen 3.6's tool-call emitter is creative in ways that aren't its fault —
 * it stringifies nested objects, wraps the whole arg block under a
 * "parameters" key, and sends numbers as strings ("500"). Most of these
 * could fail individual tool schemas in ways that look like real bugs.
 * This normalizer fixes the three most common quirks before the tool
 * sees the input. Tool-specific schemas can still add their own
 * preprocess for finer-grained tolerance.
 */
function _normalize_qwen_tool_args(input: unknown): unknown {
  if (input === null || typeof input !== 'object') return input;

  // Pattern: {"parameters": "<json-string>"} or {"input": "..."} or
  // {"arguments": "..."} — single-key wrap of the entire arg block.
  const keys = Object.keys(input as Record<string, unknown>);
  if (keys.length === 1) {
    const k = keys[0]!;
    if (k === 'parameters' || k === 'input' || k === 'arguments') {
      const v = (input as Record<string, unknown>)[k];
      if (typeof v === 'string') {
        const s = v.trim();
        if (s.startsWith('{') && s.endsWith('}')) {
          try {
            return _normalize_qwen_tool_args(JSON.parse(s));
          } catch {
            /* fall through */
          }
        }
      }
      // If unwrapped value is already an object, descend into it.
      if (v && typeof v === 'object') {
        return _normalize_qwen_tool_args(v);
      }
    }
  }

  // Pattern: per-field stringified objects {"point": "{\"lat\":...}"}.
  // Parse any string that looks like a JSON object or array.
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (typeof v === 'string') {
      const s = v.trim();
      if ((s.startsWith('{') && s.endsWith('}')) || (s.startsWith('[') && s.endsWith(']'))) {
        try {
          out[k] = JSON.parse(s);
          continue;
        } catch {
          /* fall through to raw */
        }
      }
    }
    out[k] = v;
  }
  return out;
}

/** Structural view of the Zod issues we recover from — kept local so this
 *  module stays zod-import-free. */
type ValidationIssue = {
  code: string;
  path: (string | number)[];
  options?: unknown[];
  received?: unknown;
  expected?: string;
  maximum?: number;
  minimum?: number;
  type?: string;
  keys?: string[];
};

function _get_path(obj: unknown, path: readonly (string | number)[]): unknown {
  let cur: unknown = obj;
  for (const k of path) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<PropertyKey, unknown>)[k];
  }
  return cur;
}

function _set_path(obj: unknown, path: readonly (string | number)[], value: unknown): void {
  if (path.length === 0) return;
  let cur: unknown = obj;
  for (let i = 0; i < path.length - 1; i++) {
    if (cur === null || typeof cur !== 'object') return;
    cur = (cur as Record<PropertyKey, unknown>)[path[i]!];
  }
  if (cur !== null && typeof cur === 'object') {
    (cur as Record<PropertyKey, unknown>)[path[path.length - 1]!] = value;
  }
}

/**
 * Conventional field-name synonyms the small model NATURALLY emits, keyed by
 * the CANONICAL (schema-required) field. When a required field is missing AND
 * the model provided one of its synonyms instead, we move the value over.
 *
 * This is the highest-volume tool-call failure class measured in the audit log
 * (2026-06-22): the model says the conventional `path`/`url`, the schema demands
 * a synonym (`note_path`/`filing_url`), Zod rejects, and the turn arg-spirals.
 * The model is being SENSIBLE; the schema is being gratuitously specific. We
 * meet the model where it is. Extend this from the `[tool-recovery]` logs —
 * a frequent alias is also a signal to rename the schema field outright (so the
 * tool def the model SEES uses the conventional name; see read_note/edgar).
 */
const FIELD_ALIASES: Record<string, readonly string[]> = {
  note_path: ['path', 'file_path', 'filepath', 'notepath'],
  filing_url: ['url', 'link', 'href', 'uri', 'filing', 'filing_link'],
  source_url: ['url', 'link', 'source', 'source_link'],
  commodity_class: ['commodity', 'commodity_type'],
  query: ['q', 'search', 'search_query'],
  // flag_beatrice: the model dumps the whole flag into one free-text field
  // under a variety of names instead of `what_went_wrong` (audit 2026-06-22).
  // Safe because only flag_beatrice has `what_went_wrong` as a required field,
  // so this remap can only fire there.
  what_went_wrong: ['flag', 'flag_md', 'body_md', 'body', 'message', 'description', 'issue'],
};

/**
 * Central tool-arg recovery — ONE conservative pass that meets a small model
 * where it is, then lets the caller re-validate ONCE. Each sub-recovery fires
 * only on its specific Zod issue and only when the correction is unambiguous,
 * so a genuinely wrong call still fails honestly. Returns the corrected clone
 * plus a human-readable change list (logged for observability), or null when
 * nothing was correctable (skip the re-parse). Covers every tool centrally —
 * no per-tool schema change. The members (all derived from real audit-log
 * failures):
 *   (a) enum whitespace — `"route\n "` → `"route"` (the original recovery).
 *   (b) field-name aliases — a missing required field whose conventional
 *       synonym the model DID provide (`path`→`note_path`, `url`→`filing_url`).
 *   (c) scalar-as-object — a scalar field (string/number/enum/date) the model
 *       emitted as a nested OBJECT or ARRAY (a birthday as `{year,month,day}`, a
 *       relationship as `{type:"friend"}`, a count as `{value:42}`/`"42"`).
 *       SCHEMA-DRIVEN, type-aware extraction (scalar_recovery) — replaces the
 *       old blind object→string JSON.stringify: an enum yields the matching
 *       option, a date object yields YYYY-MM-DD, a number wrapper yields the
 *       number; a STRUCTURED field that can't be cleanly extracted fails
 *       HONESTLY rather than storing a garbage stringified value. Stringify
 *       survives only for genuinely free-text (unconstrained) strings
 *       (`example_payload`). The general mechanism that subsumed the
 *       per-field birthday/relationship carve-out in upsert_person_note.
 *   (d) number clamp — a value past the schema's max/min, clamped to the bound
 *       (`search_library` limit > 20).
 *   (e) unrecognized-key strip — spurious top-level keys a strict schema
 *       rejects (`swimlanes` `ws_class`); runs AFTER (b) so a remapped alias is
 *       never stripped.
 */
function _recover_tool_args(
  input: unknown,
  issues: readonly ValidationIssue[],
  schema?: z.ZodType<unknown, z.ZodTypeDef, unknown>,
): { value: unknown; changes: string[] } | null {
  if (input === null || typeof input !== 'object') return null;
  const clone = structuredClone(input) as Record<string, unknown>;
  const changes: string[] = [];
  const field = (p: readonly (string | number)[]): string => p.join('.') || '<root>';

  // (a) enum whitespace.
  for (const issue of issues) {
    if (issue.code !== 'invalid_enum_value') continue;
    const cur = _get_path(clone, issue.path);
    if (typeof cur !== 'string') continue;
    const trimmed = cur.trim();
    if (trimmed === cur) continue;
    if (Array.isArray(issue.options) && !issue.options.includes(trimmed)) continue;
    _set_path(clone, issue.path, trimmed);
    changes.push(`trimmed enum ${field(issue.path)}`);
  }

  // (b) field-name aliases (top-level only).
  for (const issue of issues) {
    const missing =
      issue.code === 'invalid_type' &&
      issue.received === 'undefined' &&
      issue.path.length === 1 &&
      typeof issue.path[0] === 'string';
    if (!missing) continue;
    const canonical = issue.path[0] as string;
    if (canonical in clone && clone[canonical] !== undefined) continue;
    const aliases = FIELD_ALIASES[canonical];
    if (!aliases) continue;
    for (const alias of aliases) {
      if (alias in clone && clone[alias] !== undefined) {
        clone[canonical] = clone[alias];
        delete clone[alias]; // avoid an unrecognized-key error on strict schemas
        changes.push(`aliased ${alias}→${canonical}`);
        break;
      }
    }
  }

  // (c) scalar-as-object/array (or numeric string) → schema-driven, type-aware
  // extraction. Keyed on `received` (an enum reports its joined options as
  // `expected`, never the bare "string"). The leaf sub-schema decides the
  // extraction; an unresolved leaf falls back to value-shape heuristics. A
  // structured field that can't be cleanly extracted is left untouched and
  // fails honestly below — NEVER blind-stringified into garbage.
  for (const issue of issues) {
    if (issue.code !== 'invalid_type') continue;
    const recv = issue.received;
    const eligible =
      recv === 'object' ||
      recv === 'array' ||
      ((issue.expected === 'number' || issue.expected === 'integer') && recv === 'string');
    if (!eligible) continue;
    const cur = _get_path(clone, issue.path);
    if (recv === 'string') {
      if (typeof cur !== 'string') continue;
    } else if (cur === null || typeof cur !== 'object') {
      continue;
    }
    const leaf = schema ? resolve_leaf(schema as z.ZodTypeAny, issue.path) : null;
    const got = extract_scalar_for_leaf(leaf, cur, issue.expected);
    if (!got) continue;
    _set_path(clone, issue.path, got.value);
    changes.push(`recovered ${field(issue.path)} (${got.how})`);
  }

  // (d) number past the schema bound → clamp.
  for (const issue of issues) {
    if (issue.type !== 'number') continue;
    const cur = _get_path(clone, issue.path);
    if (typeof cur !== 'number') continue;
    if (issue.code === 'too_big' && typeof issue.maximum === 'number' && cur > issue.maximum) {
      _set_path(clone, issue.path, issue.maximum);
      changes.push(`clamped ${field(issue.path)} to max ${issue.maximum}`);
    } else if (issue.code === 'too_small' && typeof issue.minimum === 'number' && cur < issue.minimum) {
      _set_path(clone, issue.path, issue.minimum);
      changes.push(`clamped ${field(issue.path)} to min ${issue.minimum}`);
    }
  }

  // (e) strip spurious top-level keys a strict schema rejected (after aliasing).
  for (const issue of issues) {
    if (issue.code !== 'unrecognized_keys' || !Array.isArray(issue.keys)) continue;
    for (const k of issue.keys) {
      if (typeof k === 'string' && k in clone) {
        delete clone[k];
        changes.push(`stripped unknown key ${k}`);
      }
    }
  }

  return changes.length > 0 ? { value: clone, changes } : null;
}

/**
 * Walk a JSON-schema (the form the model actually sees as a tool def) and
 * collect the field paths that carry a regex `pattern`. A `pattern` is the
 * silent-fail-open trap: llama.cpp's JSON-Schema→GBNF converter mistranslates
 * PCRE shorthands (`\d`/`\w`/`\s`) and FAILS the whole tool grammar, after
 * which the server generates UNCONSTRAINED and returns 200 OK (llama.cpp
 * #22314/#19051, confirmed 2026-06-22). There's no validation error to recover
 * from — so the only defense is catching it at authoring time. Validate shape
 * in execute() instead.
 */
function _collect_patterns(node: unknown, path: string): string[] {
  if (node === null || typeof node !== 'object') return [];
  const n = node as Record<string, unknown>;
  const out: string[] = [];
  if (typeof n.pattern === 'string') out.push(path || '<root>');
  if (n.properties && typeof n.properties === 'object') {
    for (const [k, v] of Object.entries(n.properties as Record<string, unknown>)) {
      out.push(..._collect_patterns(v, path ? `${path}.${k}` : k));
    }
  }
  if (n.items) out.push(..._collect_patterns(n.items, `${path}[]`));
  for (const key of ['anyOf', 'oneOf', 'allOf'] as const) {
    const arr = n[key];
    if (Array.isArray(arr)) for (const sub of arr) out.push(..._collect_patterns(sub, path));
  }
  return out;
}

export interface ToolLintWarning {
  tool: string;
  warnings: string[];
}

export interface InvokeOutcome {
  ok: boolean;
  result?: unknown;
  error?: string;
  /** 'forbidden' when capability check failed; 'execute' for any other failure. */
  reason?: 'forbidden' | 'input' | 'output' | 'execute';
  missing_capability?: Capability;
  /**
   * Recovery hints for a FAILED call — concrete values the caller can
   * retry with (close-match note paths, alternative entity ids, …).
   *
   * The soft-fail half of this already existed: a connector that RETURNS
   * `{ error, candidates }` gets `_recovery_nudge_for` appended to its
   * result by the runtime (see `connector_affordances.is_recovery_hint`).
   * A connector that THROWS had no such channel — this catch used to keep
   * only `err.message` and drop every other property on the floor, so
   * `(err as any).candidates = [...]` was silently discarded. That gap is
   * why the "add candidates to <tool> on error path" proposal family
   * (79 filed across 28 tools since 2026-05-25, one executed) could never
   * close the process_misses it kept citing as justification: the fix
   * shipped, the specialist still saw a bare error, the miss recurred,
   * and the recommendation was filed again.
   *
   * Attach via `with_candidates(err, [...])` — never by hand.
   */
  candidates?: string[];
}

/** Max recovery hints carried out of a throw. Enough to be useful, small
 *  enough that it can't crowd out the error itself in the model's context. */
const MAX_CANDIDATES = 15;

/**
 * Attach retry candidates to an Error so `ToolRegistry.invoke` carries them
 * into the failure envelope (and from there into the model-visible tool
 * result). The sanctioned way for a connector to say "this failed, but here
 * are real values you could retry with".
 *
 * Callers MUST pass values the caller is allowed to see — a candidate list
 * is an existence oracle. `read_note`, for example, sources its candidates
 * through the same per-user cordon its "not found" answer uses, so the hint
 * can't confirm the existence of a note the caller couldn't otherwise read.
 */
export function with_candidates(err: Error, candidates: readonly string[]): Error {
  const clean = sanitize_candidates(candidates);
  if (clean.length > 0) (err as Error & { candidates?: string[] }).candidates = clean;
  return err;
}

/** Defensive read of an untrusted `candidates` property: strings only,
 *  trimmed, de-duped, non-empty, capped. A connector (or a hot-loaded tool)
 *  cannot inject objects or unbounded text into the model's context here. */
export function sanitize_candidates(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const v of raw) {
    if (typeof v !== 'string') continue;
    const t = v.trim();
    if (t.length === 0 || t.length > 400 || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
    if (out.length >= MAX_CANDIDATES) break;
  }
  return out;
}

export class ToolRegistry {
  private tools = new Map<string, Tool>();

  /**
   * Register a tool, replacing any existing tool of the same name.
   * Replace-on-conflict (rather than throw) is what makes hot reload
   * work: the ToolLoader re-registers a tool when its source file
   * changes. Detecting a genuine cross-file name collision is the
   * loader's job — it warns when two different modules claim a name.
   */
  register(tool: Tool): void {
    this.tools.set(tool.name, tool);
  }

  /**
   * Remove a tool by name. Used by the ToolLoader when a tool's source
   * file is deleted or stops exporting it. Returns true if a tool was
   * removed, false if the name wasn't registered.
   */
  unregister(name: string): boolean {
    return this.tools.delete(name);
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  list(): Tool[] {
    return Array.from(this.tools.values());
  }

  /**
   * Lint registered tool schemas for shapes that fight a small model (the
   * "born-aligned" gate). Returns a warning per offending tool — call at boot
   * and log them so a NEW tool can't quietly reintroduce the failure classes we
   * just drained. Warn-only by design (never throws / blocks a tool): the
   * central recovery + verify-before-claim are the runtime safety net; this is
   * authoring-time guidance. Flags:
   *   - a regex `pattern` (the GBNF silent-fail-open trap — see _collect_patterns);
   *   - a required field whose conventional synonym the model emits instead
   *     (recovered by the alias layer, but a rename is cleaner);
   *   - an over-wide required-field set (the arg-spiral risk).
   */
  lint(): ToolLintWarning[] {
    const out: ToolLintWarning[] = [];
    for (const t of this.tools.values()) {
      let json: Record<string, unknown>;
      try {
        json = zodToJsonSchema(t.input_schema as Parameters<typeof zodToJsonSchema>[0], {
          $refStrategy: 'none',
        }) as Record<string, unknown>;
      } catch {
        continue; // a schema we can't introspect isn't a lint failure
      }
      const warnings: string[] = [];
      for (const p of _collect_patterns(json, '')) {
        warnings.push(
          `field \`${p}\` uses a regex \`pattern\` — llama.cpp's GBNF converter ` +
            `mistranslates it and silently disables the tool grammar; drop the ` +
            `pattern and validate in execute()`,
        );
      }
      const required = Array.isArray(json.required) ? (json.required as string[]) : [];
      for (const r of required) {
        const aliases = FIELD_ALIASES[r];
        if (aliases) {
          warnings.push(
            `required field \`${r}\` — the model naturally emits \`${aliases[0]}\`; ` +
              `the central alias layer recovers it, but renaming the field to the ` +
              `conventional name avoids the round-trip`,
          );
        }
      }
      if (required.length > 6) {
        warnings.push(
          `${required.length} required fields — a small model fumbles wide required ` +
            `contracts; make derivable fields optional and fill them in execute()`,
        );
      }
      if (warnings.length > 0) out.push({ tool: t.name, warnings });
    }
    return out;
  }

  /** Tools the specialist's granted capabilities satisfy AND that aren't
   *  dispatch-only (those run only via proposal approval, not direct LLM calls). */
  list_for_capabilities(granted: ReadonlySet<Capability>): Tool[] {
    return this.list().filter((t) => {
      if (t.dispatch_only) return false;
      const req = t.required_capabilities ?? [];
      return req.every((c) => granted.has(c));
    });
  }

  /** Pure capability check — no execution. Returns the first missing cap or null. */
  check(name: string, granted: ReadonlySet<Capability>): Capability | null {
    const tool = this.tools.get(name);
    if (!tool) return null; // unknown tool is reported by invoke()
    return missing_capability(tool.required_capabilities ?? [], granted);
  }

  /** Validate input, check capabilities, execute, validate output. */
  async invoke(
    name: string,
    input: unknown,
    ctx: ToolContext,
    granted: ReadonlySet<Capability>,
    specialist_id: string,
  ): Promise<InvokeOutcome> {
    const tool = this.tools.get(name);
    if (!tool) {
      return {
        ok: false,
        reason: 'execute',
        error: `unknown tool: ${name}`,
      };
    }

    const missing = missing_capability(tool.required_capabilities ?? [], granted);
    if (missing) {
      return {
        ok: false,
        reason: 'forbidden',
        missing_capability: missing,
        // Redirect, don't just deny: a bare "lacks capability" tells the model
        // what's wrong but not what to do, so it retries the same call into a
        // DUPLICATE_TOOL_CALL → same_tool_spiral_exhaust → blank turn (the
        // Maggie/ha_calendar_query spiral, 2026-06-15). Point at the right next
        // move — consult the teammate who owns it, or proceed without it — and
        // tell it NOT to retry, so a hallucinated/ungranted call costs one round,
        // not the whole turn.
        error:
          `'${name}' is not available to you — it needs the '${missing}' ` +
          `capability, which you don't hold. Do NOT call '${name}' again; ` +
          `retrying will keep failing. If you need what it does, use ` +
          `consult_specialist to ask the teammate who owns it, or continue ` +
          `without it.` +
          // Capability acquisition (2026-07-14): a holder of write_proposals
          // (Kate) can turn a recurring miss into a reviewed Beatrice build
          // instead of a permanent apology. Capability-driven, not
          // identity-driven, so the nudge follows the grant.
          (granted.has('write_proposals')
            ? ` If this need keeps recurring (read_capability_demand shows the ` +
              `pattern), file_build_request turns it into a build spec Beatrice ` +
              `implements — review + owner-merge gated.`
            : ''),
      };
    }

    // Normalize Qwen's tool-call quirks before validation — see
    // _normalize_qwen_tool_args for the patterns.
    const normalized = _normalize_qwen_tool_args(input);
    let parsed_in = tool.input_schema.safeParse(normalized);
    if (!parsed_in.success) {
      // Central recovery pass — meet the model where it is. Remaps conventional
      // field-name synonyms (path→note_path, url→filing_url), JSON-stringifies an
      // object sent where a string is expected, clamps an over-cap number, trims
      // enum whitespace, strips spurious strict-schema keys — then re-validates
      // ONCE. Conservative by construction (only the failing fields, only
      // unambiguous corrections); a genuinely wrong call still fails honestly.
      // See _recover_tool_args.
      const rec = _recover_tool_args(
        normalized,
        parsed_in.error.issues as readonly ValidationIssue[],
        tool.input_schema,
      );
      if (rec !== null) {
        const reparsed = tool.input_schema.safeParse(rec.value);
        if (reparsed.success) {
          parsed_in = reparsed;
          // Observability: log every remap so the synonym map + the schemas stay
          // informed by real usage (grep "[tool-recovery]"). A frequent alias is
          // the signal to rename the schema field outright.
          console.warn(`[tool-recovery] ${name}: ${rec.changes.join('; ')}`);
        }
      }
    }
    if (!parsed_in.success) {
      // Build an LLM-friendly error message. The raw Zod error is a
      // JSON-stringified array of issues; Qwen treats it as
      // unstructured noise and retries the same empty call. A direct
      // imperative ("you called X with no arguments; the required
      // fields are A, B, C — try again with all three filled")
      // produces actionable retries.
      const issues = parsed_in.error.issues ?? [];
      const missing_required = issues
        .filter(
          (i) =>
            i.code === 'invalid_type' &&
            (i as { received?: string }).received === 'undefined',
        )
        .map((i) => i.path.join('.'))
        .filter((p) => p.length > 0);
      // Enum violations (e.g. `kind: 'binding_proposal'` when the enum
      // doesn't include it). The 35B Heretic, told only "read the
      // schema and re-call," typically gives up or pivots rather than
      // retrying with a corrected value. Naming the valid options
      // turns this into a one-shot recovery.
      const enum_issues = issues.filter(
        (i) => i.code === 'invalid_enum_value',
      );
      const got_keys = Object.keys((normalized as object) ?? {});
      let msg: string;
      if (missing_required.length > 0) {
        const got_clause =
          got_keys.length === 0
            ? 'you called it with NO arguments (empty object)'
            : `you provided only: [${got_keys.join(', ')}]`;
        msg =
          `INPUT_VALIDATION_FAILED: \`${name}\` requires these arguments: ` +
          `[${missing_required.join(', ')}]. ${got_clause}. ` +
          `Re-call \`${name}\` ONCE with EVERY required field filled with a ` +
          `real value derived from the conversation context. Empty strings ` +
          `or placeholders are not acceptable. Do not call the tool again ` +
          `until you have values for all required fields.`;
      } else if (enum_issues.length > 0) {
        const parts = enum_issues.map((i) => {
          const ii = i as {
            path: (string | number)[];
            received?: unknown;
            options?: unknown[];
          };
          const field = ii.path.join('.') || '<root>';
          const received = JSON.stringify(ii.received);
          const options = Array.isArray(ii.options)
            ? `[${ii.options.map((o) => JSON.stringify(o)).join(', ')}]`
            : '(schema did not enumerate options)';
          return `field \`${field}\`: you passed ${received}, valid values are ${options}`;
        });
        msg =
          `INPUT_VALIDATION_FAILED: \`${name}\` rejected one or more enum ` +
          `fields. ${parts.join('. ')}. Re-call \`${name}\` ONCE with the ` +
          `field(s) set to one of the listed valid values. Do not pivot to a ` +
          `different tool or pass the value as a nested object — the field ` +
          `must be a top-level string equal to one of the enum options.`;
      } else {
        // Type/shape mismatch on a PRESENT field — e.g. an address passed as a
        // nested object where a string is expected, or a Date where YYYY-MM-DD
        // is. The bare ZodError dump here is what the model re-sent verbatim
        // until DUPLICATE_TOOL_CALL killed it (the 2026-06-03 fabrication-loop
        // shape). Name each field + what was received + what's expected so the
        // retry differs. Covers every tool centrally.
        const type_issues = issues.filter(
          (i) =>
            i.code === 'invalid_type' &&
            (i as { received?: string }).received !== 'undefined',
        );
        if (type_issues.length > 0) {
          const parts = type_issues.map((i) => {
            const ii = i as {
              path: (string | number)[];
              expected?: string;
              received?: string;
            };
            const field = ii.path.join('.') || '<root>';
            return `field \`${field}\`: you passed a ${ii.received ?? 'value'} but it expects a ${ii.expected ?? 'different type'}`;
          });
          msg =
            `INPUT_VALIDATION_FAILED: \`${name}\` rejected one or more fields ` +
            `for being the wrong type. ${parts.join('. ')}. Re-call \`${name}\` ` +
            `ONCE with those field(s) re-shaped to the expected type — do NOT ` +
            `resend the same values.`;
        } else {
          msg =
            `INPUT_VALIDATION_FAILED for \`${name}\`: ${parsed_in.error.message}. ` +
            `Read the tool's schema and re-call with valid arguments.`;
        }
      }
      return { ok: false, reason: 'input', error: msg };
    }

    try {
      const result = await tool.execute(parsed_in.data, ctx);
      const parsed_out = tool.output_schema.safeParse(result);
      if (!parsed_out.success) {
        return {
          ok: false,
          reason: 'output',
          result,
          error: `output validation failed for ${name}: ${parsed_out.error.message}`,
        };
      }
      return { ok: true, result: parsed_out.data };
    } catch (err) {
      // Carry recovery candidates out of the throw (see `with_candidates`).
      // Read defensively: `err` is whatever the tool threw, and a hot-loaded
      // tool is not trusted to have used the helper.
      const candidates = sanitize_candidates(
        (err as { candidates?: unknown } | null)?.candidates,
      );
      return {
        ok: false,
        reason: 'execute',
        error: err instanceof Error ? err.message : String(err),
        ...(candidates.length > 0 ? { candidates } : {}),
      };
    }
  }
}
