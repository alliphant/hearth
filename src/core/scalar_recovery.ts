/**
 * scalar_recovery — schema-driven recovery for the "scalar-as-object" tool-call
 * class, shared by BOTH validation layers.
 *
 * The interactive 9B (and, less often, the deep 35B) emits a field a Zod schema
 * declares as a PRIMITIVE — a string, a number, an enum option, a date string —
 * as a nested OBJECT or ARRAY instead: a birthday as `{year:1994,month:4,day:16}`
 * or `{date:"1994-04-16"}`, a relationship as `{type:"friend"}`, a count as
 * `{value:42}` or `"42"`. Unfixed, `safeParse` rejects ("Expected string,
 * received object"), the model re-sends the identical object, and the turn dies
 * on DUPLICATE_TOOL_CALL → same_tool_spiral_exhaust (the live 2026-06-22 Ceci
 * birthday/address spiral).
 *
 * This is the GENERAL mechanism that replaced the per-field birthday/relationship
 * carve-out in upsert_person_note. It walks the schema to the failing field's
 * sub-schema, unwraps Optional/Default/Nullable/Effects, and does a TYPE-AWARE
 * extraction keyed on the leaf's Zod type:
 *   - ZodEnum / ZodNativeEnum / ZodLiteral → the value in the object/array that
 *     strictly equals an option ({type:"friend"} → "friend").
 *   - ZodNumber → numeric coercion from a numeric string or a wrapper/single
 *     value ({value:42} → 42, "42" → 42, [7] → 7).
 *   - ZodString, date-like value → assemble YYYY-MM-DD / MM-DD from
 *     {year,month,day} or pull the date string out of {date}/{iso}/{value:"…"}.
 *   - ZodString, UNCONSTRAINED (free-text) → extract a single obvious scalar, and
 *     only as a last resort JSON-stringify (the body_append/example_payload case).
 *   - ZodString, format-constrained (regex/email/url/…) and NOT date-like → fail
 *     honestly (no extraction).
 *
 * THE LOAD-BEARING INVARIANT: never blind-`JSON.stringify` a STRUCTURED field to
 * satisfy `z.string()`. That passes validation while STORING GARBAGE
 * (`birthday='{"year":1994}'`) — the exact fail-open-into-fabrication class this
 * codebase fights. Stringify is reserved for genuinely free-text strings (no
 * format check, identified from the schema). Type-aware extraction otherwise;
 * an ambiguous shape on a structured field becomes an honest error, never garbage.
 *
 * Used at the registry boundary ([tool_registry.ts](./tool_registry.ts)
 * `_recover_tool_args`, covering every tool's input_schema) AND at tool-internal
 * `safeParse` sites whose registry input is permissive (upsert_person_note's
 * `patch: z.record(...)` → PersonFrontmatter, via `recover_scalar_shapes`).
 */
import type { z } from 'zod';

// ── Zod v3 _def introspection ────────────────────────────────────────────────
// The repo is pinned to zod ^3.23 (3.25.x installed); `_def.typeName` and the
// per-type def fields below are stable internals (zod-to-json-schema, used at
// boot, depends on the same shapes). A schema we can't introspect resolves to
// `null` and simply gets no recovery — never an error.
interface ZDef {
  typeName?: string;
  innerType?: z.ZodTypeAny; // Optional / Nullable / Default / Readonly / Catch
  schema?: z.ZodTypeAny; // Effects (preprocess/refine/transform)
  type?: z.ZodTypeAny; // Array element / Branded
  getter?: () => z.ZodTypeAny; // Lazy
  values?: unknown; // Enum (array) / NativeEnum (object)
  value?: unknown; // Literal
  options?: z.ZodTypeAny[]; // Union / DiscriminatedUnion
  valueType?: z.ZodTypeAny; // Record
  shape?: () => Record<string, z.ZodTypeAny>; // Object
  items?: z.ZodTypeAny[]; // Tuple
  checks?: Array<{ kind?: string }>; // String / Number
}

function def_of(s: z.ZodTypeAny): ZDef {
  return (s as unknown as { _def?: ZDef })._def ?? {};
}

const WRAPPER_TYPES = new Set(['ZodOptional', 'ZodNullable', 'ZodDefault', 'ZodReadonly', 'ZodCatch']);

/** Strip the non-structural wrappers off a schema to reach its core type. */
function unwrap(schema: z.ZodTypeAny): z.ZodTypeAny {
  let cur = schema;
  for (let i = 0; i < 32; i++) {
    const d = def_of(cur);
    if (d.typeName && WRAPPER_TYPES.has(d.typeName) && d.innerType) {
      cur = d.innerType;
    } else if (d.typeName === 'ZodEffects' && d.schema) {
      cur = d.schema;
    } else if (d.typeName === 'ZodBranded' && d.type) {
      cur = d.type;
    } else if (d.typeName === 'ZodLazy' && typeof d.getter === 'function') {
      cur = d.getter();
    } else {
      break;
    }
  }
  return cur;
}

/**
 * Walk a schema along an issue `path` to the failing field's leaf sub-schema
 * (unwrapped). Handles Object / Array / Tuple / Record / Union. Returns null
 * when the path can't be resolved — the caller then falls back to value-shape
 * heuristics, so an unresolvable schema is never an error.
 */
export function resolve_leaf(
  schema: z.ZodTypeAny,
  path: readonly (string | number)[],
): z.ZodTypeAny | null {
  let cur: z.ZodTypeAny | null = schema;
  for (const seg of path) {
    if (!cur) return null;
    cur = unwrap(cur);
    const d = def_of(cur);
    switch (d.typeName) {
      case 'ZodObject': {
        const shape = typeof d.shape === 'function' ? d.shape() : undefined;
        cur = shape && typeof seg === 'string' ? shape[seg] ?? null : null;
        break;
      }
      case 'ZodArray':
        cur = d.type ?? null;
        break;
      case 'ZodTuple':
        cur = Array.isArray(d.items) && typeof seg === 'number' ? d.items[seg] ?? null : null;
        break;
      case 'ZodRecord':
        cur = d.valueType ?? null;
        break;
      case 'ZodUnion':
      case 'ZodDiscriminatedUnion': {
        let found: z.ZodTypeAny | null = null;
        for (const opt of d.options ?? []) {
          const sub = resolve_leaf(opt, [seg]);
          if (sub) {
            found = sub;
            break;
          }
        }
        cur = found;
        break;
      }
      default:
        return null;
    }
  }
  return cur ? unwrap(cur) : null;
}

/** Enum/native-enum/literal options, or null if the leaf isn't an enum-like. */
function enum_options(leaf: z.ZodTypeAny): unknown[] | null {
  const d = def_of(leaf);
  if (d.typeName === 'ZodEnum' && Array.isArray(d.values)) return d.values as unknown[];
  if (d.typeName === 'ZodNativeEnum' && d.values && typeof d.values === 'object') {
    return Object.values(d.values as Record<string, unknown>);
  }
  if (d.typeName === 'ZodLiteral' && 'value' in d) return [d.value];
  return null;
}

// A string check that constrains FORMAT (so a structured field) vs. one that
// merely bounds length / normalizes case (still free-text). Only the former
// disqualifies the JSON-stringify free-text fallback.
const STRING_FORMAT_CHECKS = new Set([
  'regex', 'email', 'url', 'uuid', 'cuid', 'cuid2', 'ulid', 'datetime', 'date',
  'time', 'duration', 'ip', 'cidr', 'emoji', 'base64', 'base64url', 'jwt',
  'nanoid', 'includes', 'startsWith', 'endsWith',
]);

function is_number_leaf(leaf: z.ZodTypeAny): boolean {
  return def_of(leaf).typeName === 'ZodNumber';
}

function is_string_leaf(leaf: z.ZodTypeAny): boolean {
  return def_of(leaf).typeName === 'ZodString';
}

/** A ZodString with NO format constraint — a genuine free-text field. */
function is_free_text_string(leaf: z.ZodTypeAny): boolean {
  const d = def_of(leaf);
  if (d.typeName !== 'ZodString') return false;
  const checks = Array.isArray(d.checks) ? d.checks : [];
  return !checks.some((c) => typeof c?.kind === 'string' && STRING_FORMAT_CHECKS.has(c.kind));
}

// ── value-shape extractors (pure) ────────────────────────────────────────────

function is_scalar(x: unknown): x is string | number | boolean {
  return typeof x === 'string' || typeof x === 'number' || typeof x === 'boolean';
}

function to_number(x: unknown): number | null {
  if (typeof x === 'number') return Number.isFinite(x) ? x : null;
  if (typeof x === 'string' && /^[+-]?\d+(\.\d+)?$/.test(x.trim())) {
    const n = Number(x.trim());
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function pad2(n: number): string {
  return String(Math.trunc(Math.abs(n))).padStart(2, '0');
}

// ISO-prefixed (`1994-04-16`, `1994-04-16T…`) or a bare `MM-DD` / `MM/DD/YYYY`.
const DATEISH = /^\d{4}-\d{1,2}-\d{1,2}|^\d{1,2}[/-]\d{1,2}([/-]\d{2,4})?$/;
const DATE_STRING_KEYS = ['date', 'iso', 'datetime', 'dob', 'birthday', 'value', 'on', 'when'];

/** Assemble a YYYY-MM-DD / MM-DD from a date-shaped object, else null. */
function try_assemble_date(v: unknown): string | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  for (const k of DATE_STRING_KEYS) {
    const s = o[k];
    if (typeof s === 'string' && DATEISH.test(s.trim())) {
      const t = s.trim();
      const iso = t.match(/^(\d{4}-\d{2}-\d{2})/);
      return iso ? iso[1]! : t;
    }
  }
  const month = to_number(o.month ?? o.m ?? o.mon ?? o.MM);
  const day = to_number(o.day ?? o.d ?? o.DD);
  const year = to_number(o.year ?? o.y ?? o.yr ?? o.YYYY);
  if (month !== null && day !== null) {
    const mmdd = `${pad2(month)}-${pad2(day)}`;
    return year !== null ? `${String(Math.trunc(Math.abs(year))).padStart(4, '0')}-${mmdd}` : mmdd;
  }
  return null;
}

/** Pull one obvious scalar out of a wrapper object/array, else null. */
function try_single_scalar(v: unknown): string | number | boolean | null {
  if (Array.isArray(v)) return v.length === 1 && is_scalar(v[0]) ? v[0] : null;
  if (v === null || typeof v !== 'object') return is_scalar(v) ? v : null;
  const o = v as Record<string, unknown>;
  if (is_scalar(o.value)) return o.value; // explicit {value: x} wrapper
  const keys = Object.keys(o);
  if (keys.length === 1 && is_scalar(o[keys[0]!])) return o[keys[0]!] as string | number | boolean;
  const string_keys = keys.filter((k) => typeof o[k] === 'string' && (o[k] as string).length > 0);
  if (string_keys.length === 1) return o[string_keys[0]!] as string;
  const scalar_keys = keys.filter((k) => is_scalar(o[k]));
  if (scalar_keys.length === 1) return o[scalar_keys[0]!] as string | number | boolean;
  return null;
}

/** Coerce a number out of a numeric string, a wrapper, or a single-element array. */
function extract_number(v: unknown): number | null {
  if (Array.isArray(v)) return v.length === 1 ? to_number(v[0]) : null;
  if (v !== null && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    for (const k of ['value', 'amount', 'number', 'n', 'count', 'qty', 'total']) {
      if (k in o) {
        const x = to_number(o[k]);
        if (x !== null) return x;
      }
    }
    const keys = Object.keys(o);
    if (keys.length === 1) return to_number(o[keys[0]!]);
    const nums = Object.values(o)
      .map(to_number)
      .filter((x): x is number => x !== null);
    return nums.length === 1 ? nums[0]! : null;
  }
  return to_number(v);
}

export interface ScalarRecovery {
  value: unknown;
  /** Short tag for the [tool-recovery] log (`enum-match`, `date-assembled`, …). */
  how: string;
}

/**
 * Type-aware extraction of a scalar from an object/array (or numeric string)
 * that was sent where a primitive is expected. `leaf` is the failing field's
 * unwrapped sub-schema (null when the registry couldn't resolve it — then we
 * fall back to value-shape heuristics, conservatively). Returns the recovered
 * value, or undefined to fail honestly (the invariant: no garbage on a
 * structured field). `value` is the current (rejected) value at the field.
 */
export function extract_scalar_for_leaf(
  leaf: z.ZodTypeAny | null,
  value: unknown,
  expected: string | undefined,
): ScalarRecovery | undefined {
  // ENUM / literal — the matching option present in the object/array.
  const opts = leaf ? enum_options(leaf) : null;
  if (opts) {
    const pool = Array.isArray(value)
      ? value
      : value && typeof value === 'object'
        ? Object.values(value as object)
        : [];
    const match = pool.find((x) => opts.includes(x));
    return match !== undefined ? { value: match, how: 'enum-match' } : undefined;
  }

  // NUMBER — from a numeric string or a wrapped/single value.
  const wants_number =
    (leaf && is_number_leaf(leaf)) || (!leaf && (expected === 'number' || expected === 'integer'));
  if (wants_number) {
    const n = extract_number(value);
    return n !== null ? { value: n, how: 'number-coerced' } : undefined;
  }

  // STRING — only the object/array case is meaningful here, and ONLY when the
  // target is genuinely a string. An array/tuple/object field (anniversaries,
  // coords) is not a scalar target — don't mine a scalar (or a date) out of it.
  if (value === null || typeof value !== 'object') return undefined;
  const string_target = leaf ? is_string_leaf(leaf) : expected === 'string';
  if (!string_target) return undefined;

  const date = try_assemble_date(value);
  if (date !== null) return { value: date, how: 'date-assembled' };

  if (leaf && is_free_text_string(leaf)) {
    const scalar = try_single_scalar(value);
    if (scalar !== null) return { value: String(scalar), how: 'single-scalar' };
    // The genuinely-free-text dump (example_payload / body_append shape): the
    // ONLY sanctioned JSON.stringify, gated on the schema saying "unconstrained".
    return { value: JSON.stringify(value), how: 'stringified-free-text' };
  }

  if (!leaf) {
    // Schema unknown: a single obvious scalar is safe (re-validation gates it);
    // never blind-stringify without the schema's blessing.
    const scalar = try_single_scalar(value);
    return scalar !== null ? { value: String(scalar), how: 'single-scalar' } : undefined;
  }

  // Format-constrained string (date regex, email, …) that isn't date-shaped:
  // fail honestly rather than store garbage.
  return undefined;
}

// ── ARRAY recovery ───────────────────────────────────────────────────────────
// The complement of the scalar case: the model sends a SCALAR (or a `{value:…}`
// wrapper, or `[{value:…}]`) where the schema wants an ARRAY — an email/phone as
// "x@y.com" not ["x@y.com"], a likes list as one string, etc. General + additive:
// it only fires on `expected: array` issues the scalar path ignores today, so it
// can never change existing scalar recovery.

function is_array_leaf(leaf: z.ZodTypeAny | null): boolean {
  return !!leaf && def_of(leaf).typeName === 'ZodArray';
}
function array_element_leaf(leaf: z.ZodTypeAny | null): z.ZodTypeAny | null {
  if (!leaf) return null;
  const d = def_of(leaf);
  return d.typeName === 'ZodArray' && d.type ? unwrap(d.type) : null;
}
/** Strip a single-key `{value: X}` wrapper, else return the value untouched. */
function unwrap_value_wrapper(x: unknown): unknown {
  if (x === null || typeof x !== 'object' || Array.isArray(x)) return x;
  const o = x as Record<string, unknown>;
  return 'value' in o && Object.keys(o).length === 1 ? o.value : x;
}

/**
 * Coerce a non-array value into the array the schema wants: unwrap a `{value:…}`
 * wrapper, wrap a lone scalar (or a lone object when the element schema is an
 * object), then per-element unwrap + scalar-recover ([{value:"x"}] → ["x"]).
 * Returns undefined (honest fail) when there's no sensible array to make.
 */
export function extract_array_for_leaf(
  leaf: z.ZodTypeAny | null,
  value: unknown,
): ScalarRecovery | undefined {
  const v = unwrap_value_wrapper(value);
  const elemLeaf = array_element_leaf(leaf);
  let arr: unknown[];
  if (Array.isArray(v)) arr = v;
  else if (is_scalar(v)) arr = [v];
  else if (v !== null && typeof v === 'object' && elemLeaf && def_of(elemLeaf).typeName === 'ZodObject') {
    arr = [v]; // a single object where the array wants objects (one pet → [pet])
  } else {
    return undefined;
  }
  const out = arr.map((el) => {
    const u = unwrap_value_wrapper(el);
    if (u !== null && typeof u === 'object' && !Array.isArray(u)) {
      const got = extract_scalar_for_leaf(elemLeaf, u, undefined);
      if (got) return got.value;
    }
    return u;
  });
  return { value: out, how: 'array-coerced' };
}

/** Structural view of the Zod issues we act on (kept local — zod-import-free). */
interface ScalarIssue {
  code?: string;
  path: (string | number)[];
  received?: string;
  expected?: string;
}

function get_at_path(obj: unknown, path: readonly (string | number)[]): unknown {
  let cur: unknown = obj;
  for (const k of path) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<PropertyKey, unknown>)[k];
  }
  return cur;
}

function set_at_path(obj: unknown, path: readonly (string | number)[], value: unknown): void {
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
 * Is this Zod issue a member of the scalar-as-object class we recover?
 * `invalid_type` where an object/array landed on a primitive (string/number/
 * enum — enum reports its joined options as `expected`, so we key on `received`),
 * OR a numeric string on a number field.
 */
function is_recoverable_issue(issue: ScalarIssue): boolean {
  if (issue.code !== 'invalid_type') return false;
  const recv = issue.received;
  if (recv === 'object' || recv === 'array') return true;
  if (issue.expected === 'array') return true; // a scalar/{value} where an array is wanted
  return (issue.expected === 'number' || issue.expected === 'integer') && recv === 'string';
}

/**
 * Apply schema-driven scalar recovery to `value` against `schema`. Returns a
 * recovered CLONE plus the change list (for `[tool-recovery]` logging); the
 * clone is byte-identical to the input when nothing was recoverable. Does NOT
 * re-validate — the caller decides (the registry re-parses once; coerce_patch
 * merges then validates). Issues may be supplied to avoid a redundant safeParse
 * on the error path.
 */
export function recover_scalar_shapes(
  schema: z.ZodTypeAny,
  value: unknown,
  issues?: readonly ScalarIssue[],
): { value: unknown; changes: string[] } {
  if (value === null || typeof value !== 'object') return { value, changes: [] };
  let probs = issues;
  if (!probs) {
    const p = schema.safeParse(value);
    if (p.success) return { value, changes: [] };
    probs = p.error.issues as unknown as ScalarIssue[];
  }
  if (probs.length === 0) return { value, changes: [] };

  const clone = structuredClone(value);
  const changes: string[] = [];
  for (const issue of probs) {
    if (!is_recoverable_issue(issue)) continue;
    const cur = get_at_path(clone, issue.path);
    if (issue.received === 'string') {
      if (typeof cur !== 'string') continue;
    } else if (cur === null || typeof cur !== 'object') {
      continue;
    }
    const leaf = resolve_leaf(schema, issue.path);
    const wants_array = is_array_leaf(leaf) || (!leaf && issue.expected === 'array');
    const got = wants_array
      ? extract_array_for_leaf(leaf, cur)
      : extract_scalar_for_leaf(leaf, cur, issue.expected);
    if (!got) continue;
    set_at_path(clone, issue.path, got.value);
    changes.push(`${issue.path.join('.') || '<root>'} (${got.how})`);
  }
  return { value: clone, changes };
}

/**
 * Drop-in for a tool-internal `schema.safeParse(value)` that adds scalar-shape
 * recovery: safeParse → on failure, recover the scalar-as-object fields →
 * re-validate ONCE. On still-failure returns the ORIGINAL honest error
 * (recovery never masks a genuinely wrong call). `changes` is non-empty only
 * when recovery produced a value that fully validated.
 */
export function safe_parse_with_recovery<Out>(
  schema: z.ZodType<Out, z.ZodTypeDef, unknown>,
  value: unknown,
): { parsed: z.SafeParseReturnType<unknown, Out>; changes: string[] } {
  const parsed = schema.safeParse(value);
  if (parsed.success) return { parsed, changes: [] };
  const { value: recovered, changes } = recover_scalar_shapes(
    schema as unknown as z.ZodTypeAny,
    value,
    parsed.error.issues as unknown as ScalarIssue[],
  );
  if (changes.length === 0) return { parsed, changes: [] };
  const reparsed = schema.safeParse(recovered);
  return reparsed.success ? { parsed: reparsed, changes } : { parsed, changes: [] };
}
