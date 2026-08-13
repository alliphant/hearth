/**
 * Zod → Swift codegen for hearth-ios DTOs.
 *
 * Walks a registry of Zod schemas exported from this repo and emits
 * matching Swift `Codable, Sendable` structs into the hearth-ios
 * package at `~/Projects/hearth-ios/HearthAPI/Sources/HearthAPI/DTOs/Generated.swift`.
 *
 * Why this exists
 * ────────────────────────────────────────────────────────────────────────
 * Cross-machine drift between backend Zod shapes and iOS hand-written
 * Codable structs was the highest-frequency source of bugs in the dual-
 * Claude workflow. Generating Swift from Zod makes the failure mode a
 * compile error instead of a runtime 400 (or worse, a silent decode-
 * failure swallowed by an optional).
 *
 * Scope (v0.1)
 * ────────────────────────────────────────────────────────────────────────
 * Handles:
 *   • z.object        → public struct, public properties, public init
 *   • z.string        → String
 *   • z.number        → Double (or Int when `.int()` check is present)
 *   • z.boolean       → Bool
 *   • z.enum([…])     → nested `public enum Field: String, Codable, Sendable`
 *   • z.literal(s)    → String (with default value, kept as `let` for
 *                       round-tripping the discriminator)
 *   • z.array(X)      → [X]
 *   • X.optional()    → X?
 *   • X.nullable()    → X?  (Codable handles JSON null OR absent for Optional)
 *   • X.default(v)    → unwrap, ignore default (Swift caller provides)
 *   • z.record(z.unknown()) / z.unknown() → JSONValue
 *
 * Skips:
 *   • Discriminated unions (CalendarPayload) — hand-written in iOS for
 *     now. Future iteration of this codegen can emit Swift enum-with-
 *     associated-values via a custom Decodable init.
 *   • Refinements (.refine()) — the Swift type is generated from the
 *     pre-refinement shape; iOS does no runtime check.
 *   • Unions other than nullable — surfaced as `JSONValue` until we
 *     need them.
 *
 * Run
 * ────────────────────────────────────────────────────────────────────────
 *   bun run codegen:swift
 *
 * Output is overwritten in full each run. Header at top notes the run
 * command + a list of source schemas so a reader can verify reality.
 */

import { z, type ZodTypeAny } from 'zod';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  FocusPayload,
  CalendarEdgePayload,
  CalendarSnapshotEvent,
  CalendarSnapshotPayload,
  CarplayPayload,
  LocationPayload,
  HealthkitPayload,
} from '../src/app/routes/sensors';
import { CalendarEventPayloadSchema } from '../src/core/proposals';

// ── Registry ─────────────────────────────────────────────────────────────
// (Zod schema, Swift struct name, source-of-truth comment).
// Add entries here when a new wire-shape needs an iOS Codable mirror.
//
// Naming convention: Swift name = the Zod export name with any "Schema"
// suffix stripped, so `CalendarEventPayloadSchema` → `CalendarEventPayload`
// to match the iOS reader's expectation.

interface RegistryEntry {
  schema: ZodTypeAny;
  swiftName: string;
  source: string;
}

const REGISTRY: RegistryEntry[] = [
  { schema: FocusPayload,             swiftName: 'FocusPayload',             source: 'src/app/routes/sensors.ts' },
  { schema: CalendarEdgePayload,      swiftName: 'CalendarEdgePayload',      source: 'src/app/routes/sensors.ts' },
  { schema: CalendarSnapshotEvent,    swiftName: 'CalendarSnapshotEvent',    source: 'src/app/routes/sensors.ts' },
  { schema: CalendarSnapshotPayload,  swiftName: 'CalendarSnapshotPayload',  source: 'src/app/routes/sensors.ts' },
  { schema: CarplayPayload,           swiftName: 'CarplayPayload',           source: 'src/app/routes/sensors.ts' },
  { schema: LocationPayload,          swiftName: 'LocationPayload',          source: 'src/app/routes/sensors.ts' },
  { schema: HealthkitPayload,         swiftName: 'HealthkitPayload',         source: 'src/app/routes/sensors.ts' },
  { schema: CalendarEventPayloadSchema, swiftName: 'CalendarEventPayload',   source: 'src/core/proposals.ts' },
];

const OUTPUT_PATH = resolve(
  process.env.HEARTH_IOS_PATH ?? `${process.env.HOME}/Projects/hearth-ios`,
  'HearthAPI/Sources/HearthAPI/DTOs/Generated.swift',
);

// ── Zod walking ──────────────────────────────────────────────────────────
// Zod stores everything on `._def`. We pattern-match on `_def.typeName`
// and recurse for wrappers (Optional, Nullable, Default, Array). The
// `unwrap` helper pops wrappers until it hits a concrete type and
// records what wrapper sequence it saw.

interface UnwrapResult {
  inner: ZodTypeAny;
  isOptional: boolean;  // optional() OR nullable() — both → Swift Optional
  hasDefault: boolean;
}

function unwrap(schema: ZodTypeAny): UnwrapResult {
  let cur: ZodTypeAny = schema;
  let isOptional = false;
  let hasDefault = false;
  while (true) {
    const def = cur._def as { typeName?: string; innerType?: ZodTypeAny };
    const name = def.typeName;
    if (name === 'ZodOptional' || name === 'ZodNullable') {
      isOptional = true;
      cur = def.innerType as ZodTypeAny;
      continue;
    }
    if (name === 'ZodDefault') {
      hasDefault = true;
      cur = def.innerType as ZodTypeAny;
      continue;
    }
    break;
  }
  return { inner: cur, isOptional, hasDefault };
}

interface NestedEnum {
  name: string;
  cases: string[];
}

interface SwiftField {
  swiftName: string;
  jsonName: string;
  swiftType: string;
  isOptional: boolean;
  // For literal-typed discriminators, the constant value we should
  // round-trip on encode + assign on init default.
  literalValue?: string;
}

interface SwiftStruct {
  name: string;
  source: string;
  fields: SwiftField[];
  nestedEnums: NestedEnum[];
}

function snakeToCamel(s: string): string {
  return s.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());
}

/** Map a Zod schema to a Swift type expression. Mutates `enums` when a
 *  nested enum is needed. `pathHint` is the parent struct + field path,
 *  used to name nested enums (e.g., FocusPayload.Mode). */
function zodToSwift(
  schema: ZodTypeAny,
  pathHint: { struct: string; field: string },
  enums: NestedEnum[],
): string {
  const { inner } = unwrap(schema);
  const def = inner._def as {
    typeName: string;
    values?: string[];
    value?: unknown;
    checks?: Array<{ kind: string }>;
    type?: ZodTypeAny;
  };

  switch (def.typeName) {
    case 'ZodString':
      return 'String';

    case 'ZodNumber': {
      const isInt = (def.checks ?? []).some((c) => c.kind === 'int');
      return isInt ? 'Int' : 'Double';
    }

    case 'ZodBoolean':
      return 'Bool';

    case 'ZodLiteral': {
      // For string literals we expose them as String fields; the value
      // is captured separately and used to seed the property's default.
      // Non-string literals (numbers, bools) are rare in our schemas;
      // fall through to JSONValue if we see one.
      if (typeof def.value === 'string') return 'String';
      return 'JSONValue';
    }

    case 'ZodArray': {
      const elem = zodToSwift(def.type!, pathHint, enums);
      return `[${elem}]`;
    }

    case 'ZodEnum': {
      const enumName = capitalize(snakeToCamel(pathHint.field));
      const cases = def.values ?? [];
      // Deduplicate: if a structurally-identical enum already exists,
      // re-use its name. Otherwise register a fresh nested enum.
      const existing = enums.find(
        (e) => e.name === enumName && sameArray(e.cases, cases),
      );
      if (!existing) {
        enums.push({ name: enumName, cases });
      }
      return enumName;
    }

    case 'ZodObject':
      // Inline objects (not top-level registry entries) become
      // `JSONValue` for now — making them their own nested struct is a
      // future iteration. Surfacing as JSONValue keeps the field
      // decodable without losing data.
      return 'JSONValue';

    case 'ZodRecord':
    case 'ZodUnknown':
    case 'ZodAny':
      return 'JSONValue';

    case 'ZodUnion':
    case 'ZodDiscriminatedUnion':
      // Skipped per scope. Fall through to a JSONValue placeholder so
      // codegen never aborts — caller writes a hand-written Swift type
      // in a separate file for these.
      return 'JSONValue';

    default:
      console.warn(
        `[codegen] unhandled Zod type "${def.typeName}" at ${pathHint.struct}.${pathHint.field} — emitting JSONValue`,
      );
      return 'JSONValue';
  }
}

function capitalize(s: string): string {
  return s.length === 0 ? s : s[0]!.toUpperCase() + s.slice(1);
}

function sameArray<T>(a: T[], b: T[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function generateStruct(entry: RegistryEntry): SwiftStruct {
  const { schema, swiftName, source } = entry;
  const def = schema._def as {
    typeName: string;
    shape?: () => Record<string, ZodTypeAny>;
  };
  if (def.typeName !== 'ZodObject') {
    throw new Error(`Registry entry "${swiftName}" is not a ZodObject (got ${def.typeName})`);
  }
  const shape = def.shape!();

  const fields: SwiftField[] = [];
  const nestedEnums: NestedEnum[] = [];

  for (const jsonName of Object.keys(shape)) {
    const fieldSchema = shape[jsonName]!;
    const { isOptional, inner } = unwrap(fieldSchema);
    const swiftField = snakeToCamel(jsonName);
    const swiftType = zodToSwift(fieldSchema, { struct: swiftName, field: jsonName }, nestedEnums);
    let literalValue: string | undefined;
    const innerDef = inner._def as { typeName: string; value?: unknown };
    if (innerDef.typeName === 'ZodLiteral' && typeof innerDef.value === 'string') {
      literalValue = innerDef.value;
    }
    fields.push({
      swiftName: swiftField,
      jsonName,
      swiftType,
      isOptional,
      literalValue,
    });
  }

  return { name: swiftName, source, fields, nestedEnums };
}

// ── Swift emission ───────────────────────────────────────────────────────

function emitStruct(s: SwiftStruct): string {
  const lines: string[] = [];
  lines.push(`// MARK: - ${s.name}`);
  lines.push(`/// Source: \`${s.source}\` → \`${s.name}\``);
  lines.push(`public struct ${s.name}: Codable, Hashable, Sendable {`);

  for (const f of s.fields) {
    const t = f.isOptional ? `${f.swiftType}?` : f.swiftType;
    lines.push(`    public let ${f.swiftName}: ${t}`);
  }

  if (s.nestedEnums.length > 0) {
    lines.push('');
    for (const e of s.nestedEnums) {
      lines.push(emitNestedEnum(e));
    }
  }

  // Public memberwise init — Swift generates a synthesized one but it's
  // internal-scoped on a public struct. Emit explicit public for callers
  // outside HearthAPI that construct fixtures (tests, mocks).
  lines.push('');
  const initParams = s.fields
    .map((f) => {
      const t = f.isOptional ? `${f.swiftType}?` : f.swiftType;
      const dflt = f.literalValue !== undefined
        ? ` = ${quoteSwiftString(f.literalValue)}`
        : f.isOptional ? ' = nil' : '';
      return `${f.swiftName}: ${t}${dflt}`;
    })
    .join(', ');
  lines.push(`    public init(${initParams}) {`);
  for (const f of s.fields) {
    lines.push(`        self.${f.swiftName} = ${f.swiftName}`);
  }
  lines.push(`    }`);

  // CodingKeys — only emit when at least one snake-case-vs-camel
  // mapping differs from the Swift identifier.
  const needsCodingKeys = s.fields.some((f) => f.swiftName !== f.jsonName);
  if (needsCodingKeys) {
    lines.push('');
    lines.push(`    enum CodingKeys: String, CodingKey {`);
    for (const f of s.fields) {
      if (f.swiftName === f.jsonName) {
        lines.push(`        case ${f.swiftName}`);
      } else {
        lines.push(`        case ${f.swiftName} = ${quoteSwiftString(f.jsonName)}`);
      }
    }
    lines.push(`    }`);
  }

  lines.push(`}`);
  lines.push('');
  return lines.join('\n');
}

function emitNestedEnum(e: NestedEnum): string {
  const lines: string[] = [];
  lines.push(`    public enum ${e.name}: String, Codable, Hashable, Sendable {`);
  for (const c of e.cases) {
    const swiftCase = snakeToCamel(c);
    if (swiftCase === c) {
      lines.push(`        case ${swiftCase}`);
    } else {
      lines.push(`        case ${swiftCase} = ${quoteSwiftString(c)}`);
    }
  }
  lines.push(`    }`);
  return lines.join('\n');
}

function quoteSwiftString(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function header(): string {
  const sources = Array.from(new Set(REGISTRY.map((r) => r.source))).sort();
  return [
    '// AUTO-GENERATED. DO NOT EDIT.',
    '//',
    '// Source: Zod schemas in hearth-backend.',
    '// Regenerate from hearth-backend with: bun run codegen:swift',
    '//',
    '// Inputs:',
    ...sources.map((s) => `//   - ${s}`),
    '//',
    '// Hand-written DTOs in this directory cover discriminated unions,',
    '// UI-local projections, and any shape the codegen does not yet',
    '// handle. Keep edits there, not here — this file is overwritten on',
    '// every regen.',
    '',
    'import Foundation',
    '',
  ].join('\n');
}

// ── Main ─────────────────────────────────────────────────────────────────

function main(): void {
  const structs = REGISTRY.map(generateStruct);
  const body = [header(), ...structs.map(emitStruct)].join('\n');
  writeFileSync(OUTPUT_PATH, body);
  console.log(`[codegen] wrote ${structs.length} structs → ${OUTPUT_PATH}`);
  for (const s of structs) {
    console.log(`           • ${s.name}  (${s.fields.length} fields, ${s.nestedEnums.length} nested enums)`);
  }
}

main();
