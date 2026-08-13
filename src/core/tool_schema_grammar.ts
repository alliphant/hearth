/**
 * tool_schema_grammar — drain the grammar-hostile keyword class out of the
 * JSON Schema a tool's `parameters` presents to the LLM.
 *
 * WHY THIS EXISTS.  Every tool's Zod `input_schema` is converted to a JSON
 * Schema and shipped to the model as the function's `parameters` (see
 * `to_tooldef` in specialist_runtime.ts).  On the interactive/deep tier
 * (llama.cpp with `--jinja`) that JSON Schema is compiled into a GBNF grammar
 * that CONSTRAINS the tool-call output.  A handful of JSON-Schema keywords
 * translate badly through that compiler, in two silent-to-the-author ways:
 *
 *   1. `pattern` / `format` are MISTRANSLATED and silently disable the whole
 *      tool grammar — the server then generates unconstrained and returns
 *      200 OK with no error (llama.cpp #22314 / #19051).  This is the class the
 *      `smoke:tool-pattern-lint` gate already watches.
 *
 *   2. Length / range / item bounds (`minLength`, `maxLength`, `minimum`,
 *      `maxItems`, …) emit a per-property length-repetition rule whose NAME is
 *      derived from the property KEY.  When two sibling objects repeat a key
 *      with DIFFERENT bounds — e.g. `draft_listing`'s ebay/poshmark/facebook
 *      each carry a `title` / `description` / `condition` with different
 *      max-lengths — the compiler emits two COLLIDING definitions for the same
 *      rule name, producing an invalid grammar.  llama.cpp then answers the
 *      whole request with `HTTP 400 "Failed to initialize samplers: failed to
 *      parse grammar"`, killing the specialist's entire turn.
 *
 * Root-caused 2026-07-13: the `:8200` tier swapped to the Qwen3.6-35B-A3B
 * "Heretic" GGUF, whose embedded Qwen3-VL chat template routes tool-calls
 * through the strict per-parameter grammar path — which is what first exposed
 * (2) as a hard 400 (Linda, the tool with the most repeated cross-sibling
 * property names, was the visible casualty).
 *
 * WHY STRIPPING IS CORRECT, NOT A WORKAROUND.  None of these bounds usefully
 * constrain a model's generation, and — critically — the tool's Zod
 * `input_schema` STILL enforces every one of them at execute() time
 * (`ToolRegistry` parses/recovers against the Zod schema, not this stripped
 * copy).  So the shape the model needs (types, enum/const, required, nesting,
 * descriptions) is preserved while the grammar-hostile constraints are dropped
 * from the LLM-facing schema only.  This is exactly the remedy the pattern-lint
 * already prescribes ("drop it and validate in execute()"), generalized to the
 * full keyword class and applied automatically instead of by author discipline.
 *
 * Pure + dependency-free so both the runtime and the regression smoke can share
 * one definition of the class.
 */

/** JSON-Schema keywords the GBNF compiler mistranslates or collides on. */
export const GRAMMAR_HOSTILE_KEYWORDS: ReadonlySet<string> = new Set([
  // string
  'minLength',
  'maxLength',
  'pattern',
  'format',
  // number / integer
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  // array
  'minItems',
  'maxItems',
  'uniqueItems',
  // object
  'minProperties',
  'maxProperties',
]);

// Keyword positions whose VALUE is a name→subschema map. Their keys are
// property/definition NAMES (never JSON-Schema keywords), so a property that
// happens to be named "format" or "pattern" must be preserved — only the
// subschema VALUES are sanitized.
const SUBSCHEMA_MAP_KEYWORDS: ReadonlySet<string> = new Set([
  'properties',
  'patternProperties',
  'definitions',
  '$defs',
]);

// Keyword positions whose VALUE is an array of subschemas.
const SUBSCHEMA_LIST_KEYWORDS: ReadonlySet<string> = new Set(['allOf', 'anyOf', 'oneOf']);

// Keyword positions whose VALUE is a single subschema (or, for `items`, a
// subschema OR an array of subschemas — both handled by recursion).
const SUBSCHEMA_VALUE_KEYWORDS: ReadonlySet<string> = new Set([
  'items',
  'additionalItems',
  'additionalProperties',
  'contains',
  'propertyNames',
  'not',
  'if',
  'then',
  'else',
]);

/**
 * Return a deep copy of `schema` with every grammar-hostile keyword removed
 * from schema-keyword positions, leaving structure and property NAMES intact.
 * Schema-aware: a property literally named "format"/"minimum"/… under a
 * `properties` map survives; only the keyword occurrences are dropped.
 */
export function sanitize_tool_schema_for_grammar(schema: unknown): unknown {
  if (Array.isArray(schema)) {
    return schema.map((s) => sanitize_tool_schema_for_grammar(s));
  }
  if (!schema || typeof schema !== 'object') return schema;

  const src = schema as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(src)) {
    if (GRAMMAR_HOSTILE_KEYWORDS.has(key)) continue; // drop the keyword

    if (SUBSCHEMA_MAP_KEYWORDS.has(key) && value && typeof value === 'object' && !Array.isArray(value)) {
      const mapped: Record<string, unknown> = {};
      for (const [name, sub] of Object.entries(value as Record<string, unknown>)) {
        mapped[name] = sanitize_tool_schema_for_grammar(sub);
      }
      out[key] = mapped;
    } else if (SUBSCHEMA_LIST_KEYWORDS.has(key) && Array.isArray(value)) {
      out[key] = value.map((s) => sanitize_tool_schema_for_grammar(s));
    } else if (SUBSCHEMA_VALUE_KEYWORDS.has(key)) {
      out[key] = sanitize_tool_schema_for_grammar(value);
    } else {
      // Scalar/opaque keyword value the compiler is fine with: type, enum,
      // const, required, description, title, default, etc. Kept verbatim.
      out[key] = value;
    }
  }
  return out;
}

/**
 * Collect the dotted paths at which a grammar-hostile keyword still appears at
 * a schema-keyword position. Empty ⇒ the schema is grammar-safe. Used by the
 * regression smoke to assert the class stays drained across every tool.
 */
export function find_grammar_hostile_positions(schema: unknown, path = ''): string[] {
  const hits: string[] = [];
  const walk = (node: unknown, at: string): void => {
    if (Array.isArray(node)) {
      node.forEach((n, i) => walk(n, `${at}[${i}]`));
      return;
    }
    if (!node || typeof node !== 'object') return;
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (GRAMMAR_HOSTILE_KEYWORDS.has(key)) {
        hits.push(at ? `${at}.${key}` : key);
        continue;
      }
      if (SUBSCHEMA_MAP_KEYWORDS.has(key) && value && typeof value === 'object' && !Array.isArray(value)) {
        for (const [name, sub] of Object.entries(value as Record<string, unknown>)) {
          walk(sub, `${at}.${key}.${name}`);
        }
      } else if (SUBSCHEMA_LIST_KEYWORDS.has(key) && Array.isArray(value)) {
        value.forEach((s, i) => walk(s, `${at}.${key}[${i}]`));
      } else if (SUBSCHEMA_VALUE_KEYWORDS.has(key)) {
        walk(value, `${at}.${key}`);
      }
    }
  };
  walk(schema, path);
  return hits;
}
