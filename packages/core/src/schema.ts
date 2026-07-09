import z from 'zod';

/**
 * Provider family for a `FormatDescriptor`. The three known wire dialects
 * (`'openai'`, `'anthropic'`, `'google'`) are autocomplete hints; any string
 * is accepted so users can register custom descriptors via
 * `registerDescriptor` and reference them by family name in
 * `ModelInfo.strictFormat`. `'lenient'` is the no-rewrite catch-all and is
 * not registerable as a custom family.
 *
 * Use this type wherever you need to talk about a descriptor family —
 * registry functions, model declarations, etc.
 */
export type DescriptorFamily = 'openai' | 'anthropic' | 'google' | (string & {});

/**
 * Format descriptor — describes the JSON Schema dialect of a target.
 *
 * Each provider/strict combination is represented by one descriptor. The
 * descriptor controls both how `strictify` rewrites a Zod schema (preprocesses
 * for record-as-array, tuple-as-object, etc.) and how `toJSONSchema` emits the
 * matching JSON Schema. Every `if (strict)` decision in the conversion
 * pipeline dispatches off a descriptor field, so adding a new dialect is a
 * matter of declaring a new `FormatDescriptor` and registering it.
 */
export interface FormatDescriptor {
  /** Stable id used as the cache key inside `strictify`. */
  readonly id: string;
  /**
   * Provider family for this descriptor. The three built-in wire dialects
   * are `'openai'` / `'anthropic'` / `'google'`; `'lenient'` is the
   * no-rewrite catch-all. Custom descriptors registered via
   * `registerDescriptor` may use any string here — the family is the
   * lookup key used by `getDescriptor(family, strict)`.
   */
  readonly family: DescriptorFamily | 'lenient';
  /** True if this descriptor represents the strict variant for its family. */
  readonly strict: boolean;

  // ---- Object encoding ----
  /** When true, every object field appears in `required[]` (OpenAI strict). */
  readonly objectAllFieldsRequired: boolean;
  /** When true, every object emits `additionalProperties: false`. */
  readonly objectClosedByDefault: boolean;

  // ---- Record encoding ----
  /** How to encode `z.record(K, V)`. */
  readonly recordEncoding: 'array-of-pairs' | 'open-record';

  // ---- Tuple encoding ----
  /**
   * How to encode `z.tuple([...])`.
   * - `object-numeric-keys`: OpenAI-strict workaround (`{ "0": A, "1": B, ... }`)
   * - `prefix-items`: standard JSON Schema `prefixItems` (Anthropic / Google)
   * - `items-union`: collapse to homogeneous `items: { anyOf: [...] }` (last-resort)
   */
  readonly tupleEncoding: 'object-numeric-keys' | 'prefix-items' | 'items-union';

  // ---- Combinators ----
  readonly allowAllOf: boolean;
  readonly allowAnyOf: boolean;
  readonly allowOneOf: boolean;

  // ---- Refs ----
  /** Whether `{ $ref: '#' }` self-reference is permitted. */
  readonly allowRootRef: boolean;
  readonly allowDefsRef: boolean;
  /** Reserved: emit Google-style `propertyOrdering` hints. */
  readonly emitPropertyOrdering: boolean;

  // ---- String formats ----
  /** Whitelist of `format:` values to emit, or `'all'` to pass through. */
  readonly supportedStringFormats: ReadonlySet<string> | 'all';
  readonly allowPattern: boolean;
  readonly allowMultiplePatterns: boolean;

  // ---- Length / numeric constraints ----
  readonly allowMinMaxLength: boolean;
  readonly allowMinMaxItems: boolean;
  readonly allowMinimumMaximum: boolean;

  // ---- Optional → nullable rewrite ----
  /** When true, `optional` becomes `T|null` (because every prop must be required). */
  readonly optionalAsNullable: boolean;

  // ---- "Any" schema encoding ----
  /**
   * How `z.any()` / `z.unknown()` is encoded.
   * - `recursive-strict`: self-referencing $defs/Any with array-of-pairs records
   *   (OpenAI strict has no open-object support)
   * - `recursive-open`: $defs/Any with `additionalProperties: <self>` records
   * - `flat`: a non-recursive `anyOf` over the JSON value types
   *   (`string`/`number`/`boolean`/`null`/`array`/open-`object`). Used by
   *   descriptors that reject recursive `$defs/Any` definitions (Anthropic
   *   strict). Equivalent to TypeScript `any` — accepts every JSON value
   *   without imposing any structural constraints.
   */
  readonly anyEncoding: 'recursive-strict' | 'recursive-open' | 'flat';

  // ---- Per-request strict-mode budget ----
  // Limits enforced by the API across ALL strict tools + structured-output
  // schemas in a single request. `undefined` means no documented cap. The
  // SchemaBudget tracks remaining slots and degrades over-budget items to
  // LENIENT silently rather than failing the whole call.
  /** Maximum number of tools that can carry `strict: true` in one request. */
  readonly maxStrictTools?: number;
  /** Maximum total optional parameters across all strict schemas in one request. */
  readonly maxStrictOptionalParams?: number;
  /** Maximum total union-type parameters across all strict schemas in one request. */
  readonly maxStrictUnionTypes?: number;

  // ---- Schema-feature feasibility ----
  /**
   * Whether the descriptor can express recursive `$ref` schemas (`$ref: '#'`
   * to root, or any `$ref: '#/$defs/X'` whose target transitively references
   * itself). OpenAI / Google strict / Lenient: true. Anthropic strict: false
   * — Anthropic's tool `input_schema` validator explicitly rejects circular
   * `$defs` graphs.
   *
   * When `false`, the JSON-Schema emitter detects cycles in the source
   * schema and replaces the offending back-edge with the descriptor's flat
   * "any" shape (see `anyEncoding`) carrying a description that names the
   * `$defs` entry it would otherwise have referenced. Non-cyclic shared
   * `$ref` reuse is unaffected — those still emit as a `$ref` to a `$defs`
   * entry.
   */
  readonly supportsRecursion: boolean;

  // ---- Prompt-text schema-delivery fallback ----
  /**
   * Instruction appended after the schema text when a Prompt's/Tool's schema
   * can't be expressed as this descriptor's structured output and is instead
   * delivered to the model as PROMPT TEXT (see `canExpress` and the ai-layer
   * `applySchemaDeliveryFallback`). Steers the model to emit a single raw JSON
   * object rather than echoing the schema or wrapping it in prose/fences.
   *
   * Optional — descriptors that omit it fall back to
   * `DEFAULT_JSON_FALLBACK_INSTRUCTION` via `getJsonFallbackInstruction`.
   */
  readonly jsonFallbackInstruction?: string;
}

/**
 * Default instruction used when a `FormatDescriptor` omits
 * `jsonFallbackInstruction`. Appended after the schema text when a schema is
 * delivered as prompt text instead of as structured output.
 */
export const DEFAULT_JSON_FALLBACK_INSTRUCTION =
  'Return ONLY a single raw JSON object conforming to the schema above — no markdown code fences, no prose, and do NOT echo the schema itself.';

/**
 * Resolve the prompt-text fallback instruction for a descriptor, falling back
 * to `DEFAULT_JSON_FALLBACK_INSTRUCTION` when the descriptor doesn't declare
 * one of its own.
 */
export function getJsonFallbackInstruction(descriptor: FormatDescriptor): string {
  return descriptor.jsonFallbackInstruction ?? DEFAULT_JSON_FALLBACK_INSTRUCTION;
}

const OPENAI_STRICT_FORMATS = new Set([
  'date-time', 'time', 'date', 'duration', 'email', 'hostname', 'ipv4', 'ipv6', 'uuid',
]);

/** Lenient descriptor — no rewrites, no closure, formats pass through. Default for unsupported models. */
export const LENIENT: FormatDescriptor = Object.freeze({
  id: 'lenient',
  family: 'lenient',
  strict: false,
  objectAllFieldsRequired: false,
  objectClosedByDefault: false,
  recordEncoding: 'open-record',
  tupleEncoding: 'prefix-items',
  allowAllOf: true,
  allowAnyOf: true,
  allowOneOf: true,
  allowRootRef: true,
  allowDefsRef: true,
  emitPropertyOrdering: false,
  supportedStringFormats: 'all',
  allowPattern: true,
  allowMultiplePatterns: true,
  allowMinMaxLength: true,
  allowMinMaxItems: true,
  allowMinimumMaximum: true,
  optionalAsNullable: false,
  anyEncoding: 'recursive-open',
  supportsRecursion: true,
});

/**
 * OpenAI strict — current behavior verbatim. Records→pairs,
 * tuples→numeric-keys, optional→nullable.
 *
 * No documented per-request slot limit (max strict tools / optional params /
 * union types). The SchemaBudget treats those caps as `undefined` (no limit)
 * for OpenAI; OpenAI's own ~5000-property and ~5-level-depth schema caps
 * aren't enforced here either — they're rare in practice and produce a
 * server-side rejection that the user can react to.
 */
export const OPENAI_STRICT: FormatDescriptor = Object.freeze({
  id: 'openai-strict',
  family: 'openai',
  strict: true,
  objectAllFieldsRequired: true,
  objectClosedByDefault: true,
  recordEncoding: 'array-of-pairs',
  tupleEncoding: 'object-numeric-keys',
  allowAllOf: false,
  allowAnyOf: true,
  allowOneOf: false,
  allowRootRef: true,
  allowDefsRef: true,
  emitPropertyOrdering: false,
  supportedStringFormats: OPENAI_STRICT_FORMATS,
  allowPattern: true,
  allowMultiplePatterns: false,
  allowMinMaxLength: false,
  allowMinMaxItems: false,
  allowMinimumMaximum: false,
  optionalAsNullable: true,
  anyEncoding: 'recursive-strict',
  supportsRecursion: true,
});

/** OpenAI non-strict — alias of LENIENT but tagged with the openai family. */
export const OPENAI_NON_STRICT: FormatDescriptor = Object.freeze({
  ...LENIENT,
  id: 'openai-non-strict',
  family: 'openai',
});

/**
 * Anthropic strict — Claude 4.5+ only (Opus 4.7/4.6/4.5, Sonnet 4.6/4.5,
 * Haiku 4.5). Per Anthropic's structured-outputs docs:
 *
 * - `additionalProperties` may **only** be `false` (no schema-valued open
 *   records), so `z.record(...)` falls back to the OpenAI-style
 *   array-of-pairs workaround.
 * - Non-cyclic `$ref` / `$defs` reuse is supported and used freely — only
 *   *circular* `$defs` graphs are rejected by the API
 *   (`Circular reference detected in schema definitions: …`). The emitter
 *   sets `supportsRecursion: false` so the cycle-breaker replaces the
 *   offending back-edge with the flat "any" shape (see `anyEncoding`) and
 *   leaves shared non-cyclic `$ref`s alone. Root self-reference (`$ref: '#'`)
 *   is always cyclic by definition, so `allowRootRef` stays `false`.
 * - Numerical (`minimum`/`maximum`/`multipleOf`) and string-length
 *   (`minLength`/`maxLength`) constraints are not supported and are dropped.
 * - `prefixItems` and other positional tuple keywords are not in the
 *   supported list, so tuples collapse to a homogeneous `items: anyOf`.
 * - Supported formats include `uri` (unlike OpenAI strict). We pass all
 *   formats through and let Anthropic ignore unknowns.
 */
export const ANTHROPIC_STRICT: FormatDescriptor = Object.freeze({
  id: 'anthropic-strict',
  family: 'anthropic',
  strict: true,
  objectAllFieldsRequired: false,
  objectClosedByDefault: true,
  recordEncoding: 'array-of-pairs',
  tupleEncoding: 'items-union',
  allowAllOf: true,
  allowAnyOf: true,
  allowOneOf: false,
  allowRootRef: false,
  allowDefsRef: true,
  emitPropertyOrdering: false,
  supportedStringFormats: 'all',
  allowPattern: true,
  allowMultiplePatterns: false,
  allowMinMaxLength: false,
  allowMinMaxItems: false,
  allowMinimumMaximum: false,
  optionalAsNullable: false,
  // Anthropic rejects recursive `$defs/Any` definitions, so encode `z.any()`
  // as a flat `anyOf` over every JSON value — equivalent to TypeScript `any`.
  anyEncoding: 'flat',
  // Anthropic-documented per-request limits (apply across ALL strict tool
  // schemas + JSON output schemas in one request).
  // Source: https://platform.claude.com/docs/en/build-with-claude/structured-outputs
  maxStrictTools: 20,
  maxStrictOptionalParams: 24,
  maxStrictUnionTypes: 16,
  // Recursive `$ref` graphs are rejected by Anthropic's tool input_schema
  // validator. The toJSONSchema emitter detects cycles and replaces the
  // back-edge with an inline flat "any" shape (see `anyEncoding`); shared
  // non-cyclic `$ref`s are still emitted normally.
  supportsRecursion: false,
});

export const ANTHROPIC_NON_STRICT: FormatDescriptor = Object.freeze({
  ...LENIENT,
  id: 'anthropic-non-strict',
  family: 'anthropic',
});

/**
 * Google Gemini strict — per `ai.google.dev/gemini-api/docs/structured-output`:
 *
 * - Supported keywords: types, `properties`, `required`, `additionalProperties`,
 *   `enum`, `format` (date-time/date/time only), `minimum`, `maximum`, `items`,
 *   `prefixItems`, `minItems`, `maxItems`, `title`, `description`,
 *   `propertyOrdering`. Recursion via `$ref: "#"` (root self-ref).
 * - Combinators (`allOf`, `anyOf`, `oneOf`) are NOT in the supported list;
 *   we conservatively flag them off so unions degrade to a representable form
 *   rather than emit something Gemini ignores.
 * - String constraints (`minLength`, `maxLength`, `pattern` formats beyond the
 *   three documented) are not supported.
 * - `propertyOrdering` is REQUIRED for Gemini 2.0 strict; we always emit it
 *   on object schemas under this descriptor.
 */
export const GOOGLE_STRICT: FormatDescriptor = Object.freeze({
  id: 'google-strict',
  family: 'google',
  strict: true,
  objectAllFieldsRequired: false,
  objectClosedByDefault: false,
  recordEncoding: 'open-record',
  tupleEncoding: 'prefix-items',
  allowAllOf: false,
  allowAnyOf: false,
  allowOneOf: false,
  allowRootRef: true,
  allowDefsRef: false,
  emitPropertyOrdering: true,
  supportedStringFormats: new Set(['date-time', 'date', 'time']),
  allowPattern: false,
  allowMultiplePatterns: false,
  allowMinMaxLength: false,
  allowMinMaxItems: true,
  allowMinimumMaximum: true,
  optionalAsNullable: false,
  anyEncoding: 'recursive-open',
  // No documented per-request slot limits.
  supportsRecursion: true,
  // Gemini's structured-output endpoint rejects `anyOf`/`$defs` schemas
  // (HTTP 400). When a schema can't be expressed here it's delivered as
  // prompt text instead; this hint keeps the reply a single raw JSON object.
  jsonFallbackInstruction:
    'Return ONLY a single raw JSON object that conforms to the schema above. Do NOT wrap it in markdown code fences, do NOT add any prose before or after it, and do NOT echo the schema itself — emit only the JSON instance.',
});

export const GOOGLE_NON_STRICT: FormatDescriptor = Object.freeze({
  ...LENIENT,
  id: 'google-non-strict',
  family: 'google',
  jsonFallbackInstruction:
    'Return ONLY a single raw JSON object that conforms to the schema above. Do NOT wrap it in markdown code fences, do NOT add any prose before or after it, and do NOT echo the schema itself — emit only the JSON instance.',
});

// ============================================================================
// Descriptor registry — mutable lookup tables for built-in + user-registered
// descriptors. `registerDescriptor` adds to both maps; `getDescriptor` /
// `getDescriptorById` consult them on every lookup so newly-registered
// descriptors are immediately addressable by family or id.
// ============================================================================

const DESCRIPTORS_BY_ID = new Map<string, FormatDescriptor>();
// Keyed by family name. Each family slot holds its strict and lenient variants.
// `'lenient'` always points to `LENIENT` for both keys.
const DESCRIPTORS_BY_FAMILY = new Map<string, { strict?: FormatDescriptor; lenient?: FormatDescriptor }>();

function indexDescriptor(d: FormatDescriptor): void {
  DESCRIPTORS_BY_ID.set(d.id, d);
  const slot = DESCRIPTORS_BY_FAMILY.get(d.family) ?? {};
  if (d.strict) slot.strict = d;
  else slot.lenient = d;
  DESCRIPTORS_BY_FAMILY.set(d.family, slot);
}

// Seed the registry with built-ins.
for (const d of [
  LENIENT,
  OPENAI_STRICT, OPENAI_NON_STRICT,
  ANTHROPIC_STRICT, ANTHROPIC_NON_STRICT,
  GOOGLE_STRICT, GOOGLE_NON_STRICT,
]) {
  indexDescriptor(d);
}

/**
 * Register a custom `FormatDescriptor` so it can be looked up by `id` or
 * by `(family, strict)`. Useful for adding support for a new provider
 * dialect or for registering a tweaked variant of an existing family.
 *
 * The descriptor's `id` and `family` become the lookup keys. If a
 * descriptor with the same id is already registered, the new one
 * replaces it. The family slot tracks one strict and one lenient
 * variant; registering a third variant overwrites the matching slot.
 *
 * Built-in descriptors (`OPENAI_STRICT`, `LENIENT`, etc.) are seeded at
 * module load — you don't need to register them manually. They CAN be
 * overridden by registering a same-id descriptor afterwards, but doing
 * so is generally a sign that you should pick a different id.
 *
 * @example
 * ```ts
 * import { registerDescriptor, OPENAI_STRICT } from '@aeye/core';
 *
 * // A tighter OpenAI-flavored descriptor: same wire shape but with
 * // pattern support disabled (some downstream tools choke on regex).
 * registerDescriptor({
 *   ...OPENAI_STRICT,
 *   id: 'openai-no-regex',
 *   family: 'openai-no-regex',
 *   allowPattern: false,
 *   allowMultiplePatterns: false,
 * });
 *
 * // Now resolvable:
 * getDescriptor('openai-no-regex', true);   // → the registered descriptor
 * getDescriptorById('openai-no-regex');     // → same
 * ```
 */
export function registerDescriptor(descriptor: FormatDescriptor): void {
  indexDescriptor(descriptor);
}

/**
 * Resolve a descriptor by family + strictness.
 *
 * Built-in families (`'openai'`, `'anthropic'`, `'google'`) always
 * resolve. Custom families registered via `registerDescriptor` resolve
 * once they're registered. Unknown families fall back to `LENIENT`
 * (safe default — strict mode silently degrades for unrecognized models).
 *
 * @param family - provider family (built-in or registered)
 * @param strict - whether the strict variant is wanted
 */
export function getDescriptor(family: DescriptorFamily, strict: boolean): FormatDescriptor {
  if (!strict) {
    const slot = DESCRIPTORS_BY_FAMILY.get(family);
    return slot?.lenient ?? LENIENT;
  }
  const slot = DESCRIPTORS_BY_FAMILY.get(family);
  return slot?.strict ?? LENIENT;
}

/**
 * Look up a descriptor by id. Returns LENIENT for unknown ids (safe default).
 * Custom descriptors registered via `registerDescriptor` are reachable here
 * by their `id`.
 */
export function getDescriptorById(id: string | undefined): FormatDescriptor {
  if (!id) return LENIENT;
  return DESCRIPTORS_BY_ID.get(id) ?? LENIENT;
}

/**
 * True if `family` has at least one registered descriptor (strict or
 * lenient). Used by `@aeye/ai`'s `resolveStrictFormat` fallback chain to
 * decide whether a model id prefix or provider name is a recognized
 * dialect.
 */
export function hasDescriptorFamily(family: string | undefined): boolean {
  if (family === undefined) return false;
  return DESCRIPTORS_BY_FAMILY.has(family);
}

/**
 * Resolve descriptor from various input shapes (boolean, options object, or descriptor).
 * Used by `toJSONSchema` to support its overloaded signature.
 */
export function resolveDescriptor(
  input: FormatDescriptor | ToJSONSchemaOptions | boolean | undefined,
): FormatDescriptor {
  if (input === undefined) return OPENAI_STRICT;
  if (typeof input === 'boolean') return input ? OPENAI_STRICT : LENIENT;
  if ('id' in input && 'family' in input) return input as FormatDescriptor;
  const opts = input as ToJSONSchemaOptions;
  return getDescriptor(opts.format ?? 'openai', opts.strict);
}

/**
 * Decide whether `schema` can be expressed as structured output under
 * `descriptor`'s JSON-Schema dialect. Returns `false` when the schema uses a
 * construct the descriptor forbids, so the caller can DROP the wire schema and
 * deliver it as prompt text instead (see the ai-layer
 * `applySchemaDeliveryFallback`).
 *
 * Walks the Zod schema in the same style as `strictify`/`convert`, honoring:
 * - **unions** (`z.union` / `z.discriminatedUnion` → `anyOf`) when
 *   `!descriptor.allowAnyOf` (e.g. Gemini strict rejects `anyOf`);
 * - **intersections** (`z.intersection` → `allOf`) when `!descriptor.allowAllOf`;
 * - **recursion** (a self-referential `z.lazy` cycle → `$ref`): a cycle back to
 *   the ROOT is fine when `descriptor.allowRootRef && descriptor.supportsRecursion`
 *   (Gemini supports `$ref: '#'`); a non-root cycle needs
 *   `descriptor.allowDefsRef && descriptor.supportsRecursion`.
 *
 * `ZodNullable` / `ZodOptional` are transparent wrappers here (nullability is
 * NOT treated as a union), so only genuine `z.union(...)` trips `allowAnyOf`.
 * Non-combinator, non-recursive schemas (plain objects, arrays, primitives)
 * are always expressible. The structure mirrors the descriptor flags so more
 * feasibility checks are easy to add.
 */
export function canExpress(schema: z.ZodType, descriptor: FormatDescriptor): boolean {
  const root: z.ZodType | z.core.$ZodType = schema;
  // Nodes currently on the DFS stack — a re-encounter is a recursion cycle.
  const inProgress = new Set<z.ZodType | z.core.$ZodType>();
  // Completed nodes with their result, so shared (non-cyclic) sub-schemas
  // aren't re-walked (guards against exponential blow-up on DAG-shaped schemas).
  const completed = new Map<z.ZodType | z.core.$ZodType, boolean>();

  const walk = (s: z.ZodType | z.core.$ZodType): boolean => {
    if (inProgress.has(s)) {
      // Recursion cycle detected at `s`.
      if (s === root) return descriptor.allowRootRef && descriptor.supportsRecursion;
      return descriptor.allowDefsRef && descriptor.supportsRecursion;
    }
    const cached = completed.get(s);
    if (cached !== undefined) return cached;

    inProgress.add(s);
    const result = walkNode(s);
    inProgress.delete(s);
    completed.set(s, result);
    return result;
  };

  const walkNode = (s: z.ZodType | z.core.$ZodType): boolean => {
    // ---- Transparent wrappers: recurse into the inner type ----
    if (s instanceof z.ZodOptional || s instanceof z.ZodNullable) return walk(s.unwrap());
    if (s instanceof z.ZodDefault) return walk(s._zod.def.innerType);
    if (s instanceof z.ZodPrefault) return walk(s._zod.def.innerType);
    if (s instanceof z.ZodCatch) return walk(s._zod.def.innerType);
    if (s instanceof z.ZodReadonly) return walk(s._zod.def.innerType);
    if (s instanceof z.ZodNonOptional) return walk(s._zod.def.innerType);
    if (s instanceof z.ZodLazy) return walk(s._zod.def.getter());
    // ZodCodec must be checked before ZodPipe (it's a ZodPipe subclass in v4).
    if (s instanceof z.ZodCodec) return walk(s._zod.def.in) && walk(s._zod.def.out);
    if (s instanceof z.ZodPipe) return walk(s._zod.def.in) && walk(s._zod.def.out);

    // ---- Combinators (the ones that actually bite) ----
    // ZodDiscriminatedUnion is a ZodUnion subclass in v4, so this covers both.
    if (s instanceof z.ZodUnion) {
      if (!descriptor.allowAnyOf) return false;
      return (s.options as readonly (z.ZodType | z.core.$ZodType)[]).every(walk);
    }
    if (s instanceof z.ZodIntersection) {
      if (!descriptor.allowAllOf) return false;
      return walk(s._zod.def.left) && walk(s._zod.def.right);
    }

    // ---- Containers: recurse so nested combinators/cycles are reached ----
    if (s instanceof z.ZodObject) {
      for (const key in s.shape) {
        if (!walk(s.shape[key])) return false;
      }
      return true;
    }
    if (s instanceof z.ZodArray) return walk(s._zod.def.element);
    if (s instanceof z.ZodTuple) {
      for (const item of s._zod.def.items) {
        if (!walk(item)) return false;
      }
      return s._zod.def.rest ? walk(s._zod.def.rest) : true;
    }
    if (s instanceof z.ZodRecord) return walk(s._zod.def.valueType);
    if (s instanceof z.ZodMap) return walk(s._zod.def.keyType) && walk(s._zod.def.valueType);
    if (s instanceof z.ZodSet) return walk(s._zod.def.valueType);

    // ---- Leaves / anything without forbidden substructure ----
    return true;
  };

  return walk(schema);
}

type StrictTransformer = (schema: z.ZodType | z.core.$ZodType) => z.ZodType;

/**
 * Module-scope cache. Per-source-schema entry survives only as long as the
 * source schema does — the WeakMap entry is gc'd with it, so all per-format
 * strictified clones go with it. The inner Map is keyed by descriptor.id
 * (small bounded set) so it cannot grow unboundedly.
 */
const strictifyCache = new WeakMap<z.ZodType | z.core.$ZodType, Map<string, z.ZodType>>();

/**
 * Recursively transforms a Zod schema to a target dialect.
 *
 * For LENIENT, returns the input schema unchanged (no rewrites). For strict
 * descriptors, installs preprocesses that accept the dialect's wire shape
 * (e.g. array-of-pairs records, numeric-key tuple objects) and normalize them
 * back to the natural Zod shape before validation.
 *
 * Repeated calls with the same `(schema, descriptor)` return the cached
 * transformed schema. Different descriptors share the same outer entry but
 * map to different inner values — bounded by the small descriptor count.
 *
 * @param schema - input Zod schema
 * @param descriptor - target dialect descriptor (defaults to OPENAI_STRICT)
 */
export function strictify<S extends z.ZodType>(schema: S, descriptor: FormatDescriptor = OPENAI_STRICT): S {
  // LENIENT is a no-op: same reference, no cache entry needed.
  if (descriptor.id === LENIENT.id) return schema;

  let perSchema = strictifyCache.get(schema);
  if (!perSchema) {
    perSchema = new Map();
    strictifyCache.set(schema, perSchema);
  }
  const cached = perSchema.get(descriptor.id);
  if (cached) return cached as S;

  const result = strictifyWithDescriptor(schema, descriptor);
  perSchema.set(descriptor.id, result);
  return result as S;
}

function strictifyWithDescriptor<S extends z.ZodType>(schema: S, descriptor: FormatDescriptor): S {
  // Per-call cycle map. Same scheme as before: cache lazy-thunks for in-flight
  // schemas so recursive references emit a `z.lazy(() => result)` rather than
  // recursing forever.
  const map = new Map<z.ZodType | z.core.$ZodType, z.ZodType | (() => z.ZodType)>();

  const transform: StrictTransformer = (s) => {
    const cached = map.get(s);
    if (cached) {
      if (typeof cached === 'function') {
        return z.lazy(cached);
      } else {
        return cached;
      }
    }
    let result: z.ZodType;
    map.set(s, () => result);
    result = strictifySimple(s, transform, descriptor);
    map.set(s, result);
    return result;
  };

  return transform(schema) as S;
}

/**
* Transfer description and metadata from source Zod schema to target Zod schema
*/
function transferMetadata(target: z.ZodType, source: z.ZodType) {
  if (source.description) {
    target = target.describe(source.description);
  }
  const meta = source.meta();
  if (meta) {
    target = target.meta(meta);
  }
  return target;
}

/**
 * Per-node strictify dispatch. Each branch consults the descriptor to decide
 * whether to install the dialect-specific preprocess.
 */
function strictifySimple(
  schema: z.ZodType | z.core.$ZodType,
  transform: StrictTransformer,
  descriptor: FormatDescriptor,
): z.ZodType {
  // Handle ZodOptional
  if (schema instanceof z.ZodOptional) {
    const innerSchema = schema.unwrap();
    const transformed = transform(innerSchema);

    // Only install the null→undefined preprocess for dialects that rewrite
    // optional to nullable on the wire (OpenAI strict). For other dialects,
    // optional stays optional and the preprocess is unnecessary.
    if (!descriptor.optionalAsNullable) {
      return transferMetadata(transformed.optional() as z.ZodType, schema);
    }

    const isNullable = innerSchema instanceof z.ZodNullable;
    return transferMetadata(
      z.preprocess(
        (val) => (!isNullable && val === null) ? undefined : val,
        transformed.optional()
      ),
      schema
    );
  }

  // Handle ZodObject
  if (schema instanceof z.ZodObject) {
    const transformedShape: Record<string, z.ZodType> = {};
    for (const key in schema.shape) {
      transformedShape[key] = transform(schema.shape[key]);
    }
    return transferMetadata(
      z.object(transformedShape),
      schema
    );
  }

  // Handle ZodCodec
  if (schema instanceof z.ZodCodec) {
    return transferMetadata(
      z.codec(
        transform(schema.def.in),
        transform(schema.def.out),
        {
          decode: schema.def.transform,
          encode: schema.def.reverseTransform,
        }
      ),
      schema
    );
  }

  // Handle ZodPipe
  if (schema instanceof z.ZodPipe) {
    return transferMetadata(
      z.pipe(
        transform(schema.def.in),
        transform(schema.def.out),
      ),
      schema
    );
  }

  // Handle ZodNullable
  if (schema instanceof z.ZodNullable) {
    return transferMetadata(
      transform(schema.unwrap()).nullable(),
      schema
    );
  }

  // Handle ZodArray
  if (schema instanceof z.ZodArray) {
    return transferMetadata(
      z.array(transform(schema.element)),
      schema
    );
  }

  // Handle ZodRecord
  // Strict-mode JSON Schema represents records as `array of {key, value}` —
  // OpenAI's structured outputs has no native pattern for open records, so
  // we rewrite. Previously this used `z.codec(arrayIn, recordOut, decode)`,
  // but z.codec proved fragile inside recursive lazy unions: the inner
  // codec's transform doesn't always run when validation traverses a
  // sibling branch, leaving the data in array form when later code expects
  // record form (and vice-versa) — surfacing as "expected array, received
  // object" union failures.
  //
  // `z.preprocess` is more robust here: it normalizes the input to record
  // shape BEFORE the record schema sees it. Either array-of-pairs (from a
  // strict-mode model) or already-a-record (when the schema is reused
  // outside strict context) is accepted; both arrive at the record schema
  // as a record.
  //
  // Only installed when the descriptor wants the array-of-pairs encoding.
  if (schema instanceof z.ZodRecord) {
    const keyTransformed = schema.keyType ? transform(schema.keyType) as z.ZodType<PropertyKey, PropertyKey> : z.string();
    const valueTransformed = transform(schema.valueType);

    if (descriptor.recordEncoding !== 'array-of-pairs') {
      return transferMetadata(
        z.record(keyTransformed, valueTransformed),
        schema,
      );
    }

    return transferMetadata(
      z.preprocess(
        (val) => {
          if (Array.isArray(val)) {
            const record: Record<PropertyKey, any> = {};
            for (const entry of val) {
              if (entry && typeof entry === 'object' && 'key' in entry && 'value' in entry) {
                record[(entry as { key: PropertyKey }).key] = (entry as { value: unknown }).value;
              }
            }
            return record;
          }
          return val;
        },
        z.record(keyTransformed, valueTransformed),
      ),
      schema
    );
  }

  // Handle ZodUnion
  if (schema instanceof z.ZodUnion) {
    return transferMetadata(
      z.union(schema.options.map(transform) as [z.ZodType, ...z.ZodType[]]),
      schema
    );
  }

  // Handle ZodDiscriminatedUnion
  if (schema instanceof z.ZodDiscriminatedUnion) {
    return transferMetadata(
      z.discriminatedUnion(schema.def.discriminator, schema.options.map(transform) as [any, ...any[]]),
      schema
    );
  }

  // Handle ZodIntersection
  if (schema instanceof z.ZodIntersection) {
    return transferMetadata(
      z.intersection(transform(schema.def.left), transform(schema.def.right)),
      schema
    );
  }

  // Handle ZodTuple
  // Strict-mode JSON Schema represents tuples as an object with numeric
  // string keys (`{"0": <T0>, "1": <T1>, ...}`) — OpenAI's structured
  // outputs has no positional `prefixItems` support and would otherwise
  // collapse a `[string, number, bool]` to an array of `(string|number|bool)`,
  // losing the per-position type. Encoding as an object preserves it.
  // The strictified schema accepts EITHER form: an object with "0".."n-1"
  // keys (what a strict-mode model produces) or an array (what a callsite
  // outside strict context would pass). Both arrive at the tuple schema as
  // an array.
  //
  // Only installed when the descriptor wants the numeric-keys encoding.
  if (schema instanceof z.ZodTuple) {
    const items = schema.def.items.map(transform) as [z.ZodType, ...z.ZodType[]];
    const rest = schema.def.rest ? transform(schema.def.rest) : undefined;
    const tupleSchema = rest ? z.tuple(items, rest) : z.tuple(items);

    if (descriptor.tupleEncoding !== 'object-numeric-keys') {
      return transferMetadata(tupleSchema, schema);
    }

    return transferMetadata(
      z.preprocess(
        (val) => {
          if (val && typeof val === 'object' && !Array.isArray(val)) {
            const obj = val as Record<string, unknown>;
            const keys = Object.keys(obj);
            if (keys.length > 0 && keys.every((k) => /^\d+$/.test(k))) {
              const indices = keys.map((k) => parseInt(k, 10));
              const len = Math.max(...indices) + 1;
              const arr: unknown[] = new Array(len);
              for (const k of keys) arr[parseInt(k, 10)] = obj[k];
              return arr;
            }
          }
          return val;
        },
        tupleSchema,
      ),
      schema,
    );
  }

  // Handle ZodDefault
  if (schema instanceof z.ZodDefault) {
     return z.preprocess(
      (val) => val === null ? undefined : val,
      transferMetadata(
        transform(schema.def.innerType).default(schema.def.defaultValue),
        schema
      ),
    );
  }

  // Handle ZodLazy
  if (schema instanceof z.ZodLazy) {
    return transferMetadata(
      z.lazy(() => transform(schema.def.getter())),
      schema
    );
  }

  // For all other types (primitives, etc.), return as-is
  return schema as z.ZodType;
}

// ============================================================================
// Wire → conceptual DECODE (symmetric with strictify's conceptual → wire ENCODE)
//
// `strictify` installs decode preprocesses (array-of-pairs → record,
// numeric-key object → tuple, null → undefined for optionals, …) that only
// run when Zod VALIDATES a value. A custom `parse` hook REPLACES Zod
// validation, so it never triggers those preprocesses — it would otherwise
// see the raw provider wire shape.
//
// `relaxValidation` turns a (strictified) schema into a NON-FAILING variant
// that KEEPS every transform but DROPS validation, so we can run it purely to
// execute the decode preprocesses and hand a custom parser the CONCEPTUAL
// value. `decodeWire` ties it together (strictify → relax → safeParse,
// best-effort).
// ============================================================================

/**
 * Rebuild a `ZodObject` for the relaxed decoder.
 *
 * - Recurses each field through `relax` (so nested transforms still run).
 * - `forceOptional`: when true every field becomes optional (max leniency —
 *   used everywhere EXCEPT union options). When false the field keeps its own
 *   optionality (used for union-option objects, where a required field is the
 *   discriminating signal that lets the union pick the right branch).
 * - `loose`: when true (default) unknown keys pass straight through; when
 *   false the object STRIPS unknown keys. Intersection sides use `false` so
 *   each half only claims its own keys and the two halves merge without an
 *   "unmergable intersection" conflict (a loose side would echo the other
 *   half's raw key and collide with that half's transformed value).
 */
function relaxObjectShape(
  schema: z.ZodObject,
  relax: (s: z.ZodType | z.core.$ZodType) => z.ZodType,
  forceOptional: boolean,
  loose = true,
): z.ZodType {
  const shape: Record<string, z.ZodType> = {};
  for (const key in schema.shape) {
    const relaxed = relax(schema.shape[key]);
    shape[key] = forceOptional ? relaxed.optional() : relaxed;
  }
  const obj = z.object(shape);
  return loose ? obj.loose() : obj;
}

/**
 * Relax one side of an intersection. Object sides are rebuilt STRIP (not
 * loose) so the two halves merge cleanly (see `relaxObjectShape`'s `loose`
 * note); everything else relaxes normally.
 */
function relaxIntersectionSide(
  schema: z.ZodType | z.core.$ZodType,
  relax: (s: z.ZodType | z.core.$ZodType) => z.ZodType,
): z.ZodType {
  if (schema instanceof z.ZodObject) {
    return relaxObjectShape(schema, relax, /* forceOptional */ true, /* loose */ false);
  }
  return relax(schema);
}

/**
 * Relax the options of a union (plain OR discriminated — the latter is a
 * subclass of `ZodUnion` in Zod v4, so a single path covers both).
 *
 * Object options are rebuilt with their ORIGINAL requiredness preserved
 * (`forceOptional: false`) so the union can discriminate by required-field
 * presence and run the matching option's decode transforms. Non-object
 * options are kept AS-IS: relaxing a leaf to `z.any()` would make it swallow
 * every value (the first branch would always win), so the strictified option
 * is left intact — it still discriminates by type and still carries any wire
 * transform it needs. Validation on those non-object branches is therefore
 * only best-effort, which is acceptable: `decodeWire` falls back to the
 * original value if nothing matches.
 */
function relaxUnionOptions(
  options: readonly (z.ZodType | z.core.$ZodType)[],
  relax: (s: z.ZodType | z.core.$ZodType) => z.ZodType,
): z.ZodType {
  const relaxed = options.map((opt) =>
    opt instanceof z.ZodObject ? relaxObjectShape(opt, relax, false) : (opt as z.ZodType),
  );
  return z.union(relaxed as [z.ZodType, z.ZodType, ...z.ZodType[]]);
}

/**
 * Per-node dispatch for `relaxValidation`. Mirrors the node coverage of
 * `strictifySimple` plus the extra wrappers/containers a strictified schema
 * can contain (`ZodMap`, `ZodSet`, `ZodCatch`, `ZodReadonly`, `ZodPrefault`,
 * `ZodNonOptional`, …). Unknown/leaf nodes bottom out at `z.any()`.
 */
function relaxNode(
  schema: z.ZodType | z.core.$ZodType,
  relax: (s: z.ZodType | z.core.$ZodType) => z.ZodType,
): z.ZodType {
  // ---- Wrappers: unwrap, relax inner, re-wrap ----
  if (schema instanceof z.ZodOptional) return relax(schema.unwrap()).optional();
  if (schema instanceof z.ZodNullable) return relax(schema.unwrap()).nullable();
  if (schema instanceof z.ZodDefault) {
    return relax(schema._zod.def.innerType).default(schema._zod.def.defaultValue);
  }
  if (schema instanceof z.ZodPrefault) {
    return relax(schema._zod.def.innerType).prefault(schema._zod.def.defaultValue);
  }
  if (schema instanceof z.ZodCatch) {
    return relax(schema._zod.def.innerType).catch(schema._zod.def.catchValue);
  }
  if (schema instanceof z.ZodReadonly) return relax(schema._zod.def.innerType).readonly();
  // NonOptional adds a "must be present" validation — drop it (we're relaxing).
  if (schema instanceof z.ZodNonOptional) return relax(schema._zod.def.innerType);

  // ---- Transforms: KEEP the transform so the decode still runs ----
  // ZodCodec must be checked before ZodPipe (it's a ZodPipe subclass in v4).
  if (schema instanceof z.ZodCodec) {
    return z.codec(
      relax(schema._zod.def.in),
      relax(schema._zod.def.out),
      { decode: schema._zod.def.transform, encode: schema._zod.def.reverseTransform },
    );
  }
  // A bare transform (the `in` of a `preprocess`, the `out` of a `.transform`)
  // carries no validation — keep it verbatim so the transform runs.
  if (schema instanceof z.ZodTransform) return schema as z.ZodType;
  if (schema instanceof z.ZodPipe) {
    return z.pipe(relax(schema._zod.def.in), relax(schema._zod.def.out));
  }

  // ---- Containers: recurse so nested transforms are reached ----
  if (schema instanceof z.ZodObject) return relaxObjectShape(schema, relax, /* forceOptional */ true);
  if (schema instanceof z.ZodArray) return z.array(relax(schema._zod.def.element));
  if (schema instanceof z.ZodTuple) {
    const items = schema._zod.def.items.map(relax) as [z.ZodType, ...z.ZodType[]];
    const rest = schema._zod.def.rest ? relax(schema._zod.def.rest) : undefined;
    return rest ? z.tuple(items, rest) : z.tuple(items);
  }
  if (schema instanceof z.ZodRecord) {
    // Accept any string key (records arrive with string-ish keys on the wire);
    // an exhaustive/enum key schema would reject partial records.
    return z.record(z.string(), relax(schema._zod.def.valueType));
  }
  if (schema instanceof z.ZodMap) {
    return z.map(relax(schema._zod.def.keyType), relax(schema._zod.def.valueType));
  }
  if (schema instanceof z.ZodSet) return z.set(relax(schema._zod.def.valueType));

  // ---- Combinators ----
  // ZodDiscriminatedUnion is a ZodUnion subclass in v4, so this one branch
  // covers both. Discrimination survives via required-field presence.
  if (schema instanceof z.ZodUnion) return relaxUnionOptions(schema.options, relax);
  if (schema instanceof z.ZodIntersection) {
    return z.intersection(
      relaxIntersectionSide(schema._zod.def.left, relax),
      relaxIntersectionSide(schema._zod.def.right, relax),
    );
  }

  // ---- Recursion: defer + memoize (see `relaxValidation`) ----
  if (schema instanceof z.ZodLazy) {
    return z.lazy(() => relax(schema._zod.def.getter()));
  }

  // ---- Validating leaves + anything unrecognized → accept everything ----
  return z.any();
}

/**
 * Produce a NON-FAILING variant of `schema` that keeps every transform
 * (`preprocess`, `codec`, `pipe`, `transform`) but drops validation. Parsing
 * a wire value through the result runs the decode preprocesses installed by
 * `strictify` (array-of-pairs → record, numeric-key object → tuple, null →
 * undefined) and yields the conceptual value, without ever rejecting.
 *
 * Recursion (`z.lazy` self-reference) is handled with a per-call memo map: an
 * in-flight node is recorded as a thunk and re-encounters resolve to
 * `z.lazy(thunk)`, so a self-referential schema relaxes in finite time and
 * never infinite-loops.
 */
export function relaxValidation(schema: z.ZodType): z.ZodType {
  // Per-call cycle map — same scheme as `strictifyWithDescriptor`: cache a
  // lazy thunk for in-flight schemas so recursive references resolve to a
  // `z.lazy(() => result)` instead of recursing forever.
  const map = new Map<z.ZodType | z.core.$ZodType, z.ZodType | (() => z.ZodType)>();

  const relax = (s: z.ZodType | z.core.$ZodType): z.ZodType => {
    const cached = map.get(s);
    if (cached) {
      return typeof cached === 'function' ? z.lazy(cached) : cached;
    }
    let result: z.ZodType;
    map.set(s, () => result);
    result = relaxNode(s, relax);
    map.set(s, result);
    return result;
  };

  return relax(schema);
}

/**
 * Module-scope cache for relaxed decoders. Mirrors `strictifyCache`: outer
 * WeakMap keyed by the SOURCE schema (gc'd with it), inner Map keyed by
 * descriptor id (small bounded set).
 */
const relaxDecodeCache = new WeakMap<z.ZodType | z.core.$ZodType, Map<string, z.ZodType>>();

/**
 * DECODE a model's wire `value` back to the conceptual shape a custom parser
 * expects — symmetric with how `strictify` ENCODEs the request for the wire.
 *
 * Runs the descriptor's decode transforms (via `relaxValidation(strictify(...))`)
 * without imposing validation, so array-of-pairs records, numeric-key tuples,
 * and null-for-optional fields are normalized before a provider-agnostic
 * custom parser sees them. Best-effort: NEVER throws — if the relaxed decoder
 * can't parse the value it is returned unchanged.
 *
 * @param schema - the PRE-strictify conceptual schema (strictify runs internally)
 * @param value - the model's raw wire value (already `JSON.parse`d)
 * @param descriptor - the wire dialect the request was encoded with
 */
export function decodeWire(schema: z.ZodType, value: unknown, descriptor: FormatDescriptor): unknown {
  let perSchema = relaxDecodeCache.get(schema);
  if (!perSchema) {
    perSchema = new Map();
    relaxDecodeCache.set(schema, perSchema);
  }
  let decoder = perSchema.get(descriptor.id);
  if (!decoder) {
    decoder = relaxValidation(strictify(schema, descriptor));
    perSchema.set(descriptor.id, decoder);
  }
  const result = decoder.safeParse(value);
  return result.success ? result.data : value;
}

/**
 * Format specification for JSON Schema generation
 */
/**
 * Family name for `ToJSONSchemaOptions.format`. Alias of `DescriptorFamily`
 * — the three built-in dialects (`'openai'`, `'anthropic'`, `'google'`)
 * plus any string registered via `registerDescriptor`.
 *
 * @deprecated Prefer `DescriptorFamily`. Both refer to the same widened type.
 */
export type JSONSchemaFormat = DescriptorFamily;

/**
 * Options for toJSONSchema
 */
export interface ToJSONSchemaOptions {
  /**
   * Whether to use strict mode (all fields required, additionalProperties: false)
   */
  strict: boolean;
  /**
   * The target format for the JSON Schema. Resolves to a named FormatDescriptor.
   * Built-in (`'openai'` / `'anthropic'` / `'google'`) or any string
   * registered via `registerDescriptor`.
   */
  format?: DescriptorFamily;
}

export type JSONSchemaType = 'string' | 'number' | 'boolean' | 'array' | 'object' | 'null' | 'integer';

/**
 * JSON Schema type definition
 */
export interface JSONSchema {
  type?: JSONSchemaType | JSONSchemaType[];
  properties?: Record<string, JSONSchema>;
  items?: JSONSchema;
  prefixItems?: JSONSchema[];
  required?: string[];
  additionalProperties?: boolean | JSONSchema;
  propertyNames?: JSONSchema;
  enum?: any[];
  anyOf?: JSONSchema[];
  allOf?: JSONSchema[];
  additionalItems?: boolean | JSONSchema;
  not?: JSONSchema;
  $ref?: string;
  description?: string;
  default?: any;
  pattern?: string;
  format?: string;
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  exclusiveMaximum?: number;
  multipleOf?: number;
  minItems?: number;
  maxItems?: number;
  const?: any;
  title?: string;
  $defs?: Record<string, JSONSchema>;
  /** Gemini-specific: deterministic property emission order for strict mode. */
  propertyOrdering?: string[];
  [metadata: string]: unknown;
}

/**
 * Context for recursive schema conversion
 */
interface ConversionContext {
  root: z.ZodType,
  descriptor: FormatDescriptor;
  definitions: Map<z.ZodType | z.core.$ZodType, [JSONSchema, string]>; // schema to [js, id]
  definitionSchemas: Map<string, JSONSchema>; // id to schema
  refCounter: number;
  path: string[];
  /**
   * IDs whose conversion is still on the stack — distinguishes a true cycle
   * (re-encounter while still converting) from a shared reference (re-encounter
   * after conversion completed). Used by `convert()` to break cycles for
   * descriptors with `supportsRecursion: false`.
   */
  inProgress: Set<string>;
}

/**
 * Converts a Zod schema to JSON Schema with support for different provider dialects.
 *
 * Accepts either a boolean (legacy: true = OPENAI_STRICT, false = LENIENT),
 * an options object `{ strict, format? }`, or a `FormatDescriptor` directly.
 *
 * @param schema - The Zod schema to convert
 * @param options - Configuration options for the conversion
 * @returns JSON Schema object compatible with the resolved dialect
 *
 * @example
 * ```typescript
 * const schema = z.object({
 *   name: z.string(),
 *   age: z.number().optional(),
 * });
 *
 * // For OpenAI strict mode
 * const jsonSchema = toJSONSchema(schema, { strict: true, format: 'openai' });
 *
 * // For Anthropic strict mode
 * const anthropic = toJSONSchema(schema, ANTHROPIC_STRICT);
 * ```
 */
export function toJSONSchema(
  schema: z.ZodType,
  options: ToJSONSchemaOptions | boolean | FormatDescriptor,
): JSONSchema {
  const descriptor = resolveDescriptor(options);

  const context: ConversionContext = {
    root: schema,
    descriptor,
    definitions: new Map(),
    definitionSchemas: new Map(),
    refCounter: 0,
    path: [],
    inProgress: new Set(),
  };

  const result = convert(schema, context);

  // Add definitions if any were created
  if (context.definitionSchemas.size > 0) {
    result.$defs = Object.fromEntries(context.definitionSchemas);
  }

  return result;
}

/**
 * Main recursive conversion function
 */
function convert(schema: z.ZodType | z.core.$ZodType, context: ConversionContext): JSONSchema {
  // For lazy schemas, we need to check by aid first to handle .describe()/.optional() wrappers
  // that create new objects but share the same lazy getter
  let cacheKey: z.ZodType | z.core.$ZodType = schema;
  let unwrappedSchema: z.ZodType | z.core.$ZodType = schema;

  // Check if this is a lazy schema and extract metadata early
  if (schema instanceof z.ZodLazy) {
    // Check cache FIRST before evaluating getter to prevent infinite recursion
    const [cachedJs, cachedId] = context.definitions.get(schema) || [];
    if (cachedJs && cachedId) {
      return emitCachedRef(schema, cachedJs, cachedId, context);
    }

    const metadata = (schema instanceof z.ZodType) ? schema.meta() : null;
    const aid = metadata?.aid;

    // If there's an aid, check if we've already seen this aid
    if (aid) {
      for (const [cachedSchema, [js, jsId]] of context.definitions.entries()) {
        if (cachedSchema instanceof z.ZodType) {
          const cachedMeta = cachedSchema.meta();
          if (cachedMeta?.aid === aid && jsId && js) {
            // Found a cached version with the same aid - use it
            return emitCachedRef(schema, js, jsId, context);
          }
        }
      }
    }

    unwrappedSchema = schema.def.getter();
  } else {
    // Check cache by object identity for non-lazy schemas
    const [js, jsId] = context.definitions.get(schema) || [];
    if (jsId && js) {
      return emitCachedRef(schema, js, jsId, context);
    }
  }

  // Capture metadata from the original schema
  const metadata: {
    id?: string;
    aid?: string;
    title?: string;
    description?: string;
    deprecated?: boolean;
    [x: string]: unknown;
  } = {};
  if (schema instanceof z.ZodType) {
    Object.assign(metadata, schema.meta() || {});
    if (!metadata.description && schema.description) {
      metadata.description = schema.description;
    }
  }

  // If the schema has an 'aid' or 'id' in meta, promote it to a definition
  const id = (metadata.aid ? String(metadata.aid) : 0) || metadata.id || `__schema${context.refCounter++}`;
  const save = !!(metadata.aid || metadata.id) && context.root !== schema;

  // A schema target - will hold either the converted schema or a $ref
  const target: JSONSchema = {};

  // Before converting, register this schema to handle recursion
  context.definitions.set(cacheKey, [target, id]);
  context.inProgress.add(id);

  // Convert the unwrapped schema
  let result: JSONSchema;
  try {
    result = convertSchema(unwrappedSchema, context);
  } finally {
    context.inProgress.delete(id);
  }
  Object.assign(result, metadata);
  delete result.aid;

  // Promote it because user requested it or it's recursive
  if (save || context.definitionSchemas.has(id)) {
    context.definitionSchemas.set(id, result);
    target.$ref = `#/$defs/${id}`;
  } else {
    // Inline schema
    Object.assign(target, result);
  }

  return target;
}

/**
 * Emit a `$ref` (or, for descriptors that don't support recursion, an inline
 * shape-aware placeholder) when the converter re-encounters a schema it's
 * already started or finished converting.
 *
 * Three cases:
 * 1. Re-encounter while still on the conversion stack (`inProgress.has(id)`)
 *    AND the descriptor rejects recursive `$ref`s — emit a shape-aware
 *    placeholder via `buildCycleBreakerSchema()` (number stays number, array
 *    stays array, etc.) with a description naming the `$defs` entry it would
 *    have referenced. This breaks the cycle inline so providers like
 *    Anthropic don't reject the schema.
 * 2. Re-encounter at root with `allowRootRef` — emit `{$ref: '#'}`.
 * 3. Otherwise — emit `{$ref: '#/$defs/<id>'}`, promoting the original
 *    target to a `$defs` entry on first share.
 */
function emitCachedRef(
  schema: z.ZodType | z.core.$ZodType,
  cachedJs: JSONSchema,
  cachedId: string,
  context: ConversionContext,
): JSONSchema {
  const descriptor = context.descriptor;
  const isCycle = context.inProgress.has(cachedId);

  if (isCycle && !descriptor.supportsRecursion) {
    // Replace the back-edge with a placeholder whose top-level shape matches
    // the recursive zod schema. The original `cachedJs` target keeps filling
    // in normally — once conversion completes the `$defs` entry exists; we
    // just don't reference it from here, since doing so would form the cycle
    // the provider rejects.
    return buildCycleBreakerSchema(schema, cachedId, descriptor);
  }

  if (schema === context.root && descriptor.allowRootRef) {
    return { $ref: `#` };
  }

  if (!context.definitionSchemas.has(cachedId)) {
    context.definitionSchemas.set(cachedId, { ...cachedJs });
    for (const prop in cachedJs) {
      delete cachedJs[prop as keyof JSONSchema];
    }
    cachedJs.$ref = `#/$defs/${cachedId}`;
  }

  return { $ref: `#/$defs/${cachedId}` };
}

/**
 * Build the inline placeholder used in place of a cyclic `$ref` for
 * descriptors with `supportsRecursion: false`. Inspects the recursive zod
 * `schema` and emits a JSON-Schema node whose top-level shape matches it
 * (number → `{type: 'number'}`, array → `{type: 'array', items: ...}`, union
 * → `{anyOf: [...]}`, etc.) so the LLM still knows what JSON value to send
 * at the cycle position. One level of structural fidelity, then bottoms out
 * at the descriptor's flat "any" encoding.
 */
function buildCycleBreakerSchema(
  schema: z.ZodType | z.core.$ZodType,
  refId: string,
  descriptor: FormatDescriptor,
): JSONSchema {
  const placeholder = genericize(schema, descriptor, 1);
  return {
    ...placeholder,
    description: `Would recursively reference #/$defs/${refId}`,
  };
}

/**
 * Reduce a zod schema to a JSON-Schema node carrying its top-level shape
 * class (string / number / array / object / union / …) without nested
 * constraints. Used by the cycle-breaker so the placeholder at a recursive
 * position matches the JSON value the LLM is supposed to emit.
 *
 * `depth` controls how far structural fidelity flows into the *recursive*
 * containers (arrays of arrays, unions of unions). Closed-form schemas
 * (primitives, objects, tuples) ignore depth — they have no further
 * substructure to walk and are always safe to emit verbatim.
 * - `depth >= 1`: arrays carry their `items`, unions carry their branches,
 *   each recursing at `depth - 1`.
 * - `depth === 0`: arrays collapse to bare `{type: 'array'}`, unions
 *   collapse to the descriptor's flat any encoding. Stops the walk before
 *   it can re-traverse the cycle that triggered the call.
 *
 * Depth is hardcoded to 1 by `buildCycleBreakerSchema`. That's enough for
 * "a list of objects should be a list of records" and prevents infinite
 * recursion on `Array<Array<Self>>` / `Union<Union<Self>>` shapes.
 */
function genericize(
  schema: z.ZodType | z.core.$ZodType,
  descriptor: FormatDescriptor,
  depth: number,
): JSONSchema {
  // Unwrap transparent wrappers — recurse at the same depth because the
  // wrapper itself doesn't add a structural level.
  if (schema instanceof z.ZodLazy) {
    return genericize(schema.def.getter(), descriptor, depth);
  }
  if (schema instanceof z.ZodOptional || schema instanceof z.ZodNullable) {
    return genericize(schema.unwrap(), descriptor, depth);
  }
  if (schema instanceof z.ZodDefault) {
    return genericize(schema.def.innerType, descriptor, depth);
  }
  if (schema instanceof z.ZodCodec) {
    return genericize(schema.def.in, descriptor, depth);
  }
  if (schema instanceof z.ZodPipe) {
    return genericize(schema.def.in, descriptor, depth);
  }

  // Primitive leaves and string-flavored types — no substructure, depth
  // irrelevant. The LLM gets a precise type signal.
  if (schema instanceof z.ZodString) return { type: 'string' };
  if (schema instanceof z.ZodNumber) return { type: 'number' };
  if (schema instanceof z.ZodBigInt) return { type: 'number' };
  if (schema instanceof z.ZodBoolean) return { type: 'boolean' };
  if (schema instanceof z.ZodNull) return { type: 'null' };
  if (schema instanceof z.ZodUndefined) return { type: 'null' };
  if (
    schema instanceof z.ZodDate ||
    schema instanceof z.ZodISODateTime ||
    schema instanceof z.ZodISODate ||
    schema instanceof z.ZodISOTime ||
    schema instanceof z.ZodISODuration ||
    schema instanceof z.ZodEmail ||
    schema instanceof z.ZodIPv4 ||
    schema instanceof z.ZodIPv6 ||
    schema instanceof z.ZodUUID ||
    schema instanceof z.ZodTemplateLiteral
  ) {
    return { type: 'string' };
  }

  if (schema instanceof z.ZodLiteral) {
    // ZodLiteral can carry one or more values; pick the first that maps to
    // a JSON primitive type, else fall back to flat any.
    const v = Array.from(schema.values).find(
      (x) => x === null || typeof x === 'string' || typeof x === 'number' || typeof x === 'boolean',
    );
    if (v === null) return { type: 'null' };
    if (typeof v === 'string') return { type: 'string' };
    if (typeof v === 'number') return { type: 'number' };
    if (typeof v === 'boolean') return { type: 'boolean' };
    return buildAnyValueSchema(descriptor);
  }

  if (schema instanceof z.ZodEnum) {
    const numericValues = Object.values(schema.def.entries).filter((v) => typeof v === 'number');
    const values = Object.entries(schema.def.entries)
      .filter(([k]) => numericValues.indexOf(+k) === -1)
      .map(([, v]) => v);
    if (values.every((v) => typeof v === 'string')) return { type: 'string' };
    if (values.every((v) => typeof v === 'number')) return { type: 'number' };
    return buildAnyValueSchema(descriptor);
  }

  // Closed-form containers — no nested schema to walk, safe at any depth.
  if (
    schema instanceof z.ZodObject ||
    schema instanceof z.ZodRecord ||
    schema instanceof z.ZodIntersection
  ) {
    return { type: 'object', additionalProperties: true };
  }
  if (schema instanceof z.ZodTuple) {
    // Heterogeneous positional shape — drop items, keep array hint.
    return { type: 'array' };
  }

  // Recursive containers — depth gates further structural fidelity.
  if (schema instanceof z.ZodArray) {
    if (depth <= 0) return { type: 'array' };
    return { type: 'array', items: genericize(schema.element, descriptor, depth - 1) };
  }
  if (schema instanceof z.ZodUnion || schema instanceof z.ZodDiscriminatedUnion) {
    if (depth <= 0) return buildAnyValueSchema(descriptor);
    const options = (schema as z.ZodUnion).options as readonly (z.ZodType | z.core.$ZodType)[];
    const branches = options.map((opt) => genericize(opt, descriptor, depth - 1));
    const unique = uniqueByJSON(branches);
    return unique.length === 1 ? unique[0] : { anyOf: unique };
  }

  // ZodAny / ZodUnknown / ZodTransform / anything we don't recognize —
  // emit the descriptor's any encoding. Safer than guessing.
  return buildAnyValueSchema(descriptor);
}

/**
 * Dedupe an array of JSONSchema nodes by structural (JSON-stringified)
 * equality. Order-preserving: the first occurrence wins. Used by
 * `genericize` to collapse `union<T, T>` placeholders into a single branch.
 */
function uniqueByJSON(nodes: JSONSchema[]): JSONSchema[] {
  const seen = new Set<string>();
  const out: JSONSchema[] = [];
  for (const node of nodes) {
    const key = JSON.stringify(node);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(node);
  }
  return out;
}

/**
 * Main conversion function
 */
function convertSchema(schema: z.ZodType | z.core.$ZodType, context: ConversionContext): JSONSchema {
  const descriptor = context.descriptor;

  // TODO: Map, Set, File, ReadOnly, Nan, Catch, Prefault, NonOptional, Transform, Function, Promise, Custom

  // Handle ZodOptional
  if (schema instanceof z.ZodOptional) {
    const innerSchema = schema.unwrap();
    const innerJson = convert(innerSchema, context);

    if (descriptor.optionalAsNullable) {
      // OpenAI-strict-style: optional fields become nullable on the wire.
      return makeNullable(innerJson, descriptor);
    } else {
      // Standard JSON Schema: optional fields are simply not in `required[]`.
      return innerJson;
    }
  }

  // Handle ZodNullable
  if (schema instanceof z.ZodNullable) {
    const innerSchema = schema.unwrap();
    const innerJson = convert(innerSchema, context);
    return makeNullable(innerJson, descriptor);
  }

  // Handle ZodObject
  if (schema instanceof z.ZodObject) {
    const properties: Record<string, JSONSchema> = {};
    const required: string[] = [];
    const shape = schema.shape;

    for (const key in shape) {
      const fieldSchema = shape[key];
      const isFieldRequired = descriptor.objectAllFieldsRequired || !isOptional(fieldSchema);

      properties[key] = convert(fieldSchema, context);

      if (isFieldRequired) {
        required.push(key);
      }
    }

    const result: JSONSchema = {
      type: 'object',
      properties,
      required,
    };

    if (descriptor.objectClosedByDefault || schema.def.catchall?._zod.def.type === "never") {
      result.additionalProperties = false;
    } else if (schema.def.catchall) {
      result.additionalProperties = convert(schema.def.catchall, context);
    }

    // Gemini 2.0 strict requires `propertyOrdering` so the model emits keys
    // in a deterministic order. Other dialects ignore this hint, so emitting
    // it under non-Google descriptors is harmless — but we gate it on the
    // descriptor flag to keep the JSON Schema minimal everywhere else.
    if (descriptor.emitPropertyOrdering) {
      result.propertyOrdering = Object.keys(properties);
    }

    return result;
  }

  // Handle ZodArray
  if (schema instanceof z.ZodArray) {
    const result: JSONSchema = {
      type: 'array',
      items: convert(schema.element, context),
    };
    if (descriptor.allowMinMaxItems) {
      const { minimum, maximum } = schema._zod.bag;
      if (typeof minimum === 'number') {
        result.minItems = minimum;
      }
      if (typeof maximum === 'number') {
        result.maxItems = maximum;
      }
    }
    return result;
  }

  // Handle ZodRecord
  if (schema instanceof z.ZodRecord) {
    if (descriptor.recordEncoding === 'array-of-pairs') {
      // Strict-mode workaround: records become arrays of {key, value} objects.
      return {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            key: convert(schema.keyType, context),
            value: convert(schema.valueType, context),
          },
          required: ['key', 'value'],
          additionalProperties: false,
        },
      };
    }

    // Standard: open record with propertyNames + additionalProperties.
    return {
      type: 'object',
      propertyNames: convert(schema.keyType, context),
      additionalProperties: convert(schema.valueType, context),
    };
  }

  // Handle ZodUnion
  if (schema instanceof z.ZodUnion) {
    const anyOf = schema.options.map(option => convert(option, context));
    return { anyOf };
  }

  // Handle ZodDiscriminatedUnion
  if (schema instanceof z.ZodDiscriminatedUnion) {
    const anyOf = schema.options.map(option => convert(option, context));
    return { anyOf };
  }

  // Handle ZodIntersection
  if (schema instanceof z.ZodIntersection) {
    const left = convert(schema.def.left, context);
    const right = convert(schema.def.right, context);
    const allOf = [
      ...(left.allOf && Object.keys(left).length === 1 ? left.allOf! : [left]),
      ...(right.allOf && Object.keys(right).length === 1 ? right.allOf! : [right]),
    ];

    // OpenAI strict bans allOf in some shapes; collapse to anyOf when the
    // descriptor disallows it.
    return descriptor.allowAllOf ? { allOf } : { anyOf: allOf };
  }

  // Handle ZodTuple
  if (schema instanceof z.ZodTuple) {
    const items = schema.def.items.map(item => convert(item, context));
    const rest = schema.def.rest ? convert(schema.def.rest, context) : undefined;

    // Object-numeric-keys encoding: per-position type preserved as object
    // properties. Variadic rests can't be represented this way — fall back to
    // a homogeneous array of (items ∪ rest) for that rare case.
    if (descriptor.tupleEncoding === 'object-numeric-keys' && !rest) {
      const properties: Record<string, JSONSchema> = {};
      const required: string[] = [];
      for (let i = 0; i < items.length; i++) {
        const k = String(i);
        properties[k] = isOptional(schema.def.items[i]) ? makeNullable(items[i]!, descriptor) : items[i]!;
        required.push(k);
      }
      return {
        type: 'object',
        properties,
        required,
        additionalProperties: false,
      };
    }

    const result: JSONSchema = { type: 'array' };

    if (descriptor.tupleEncoding === 'object-numeric-keys' && rest) {
      // Strict + rest fallback: every position fits one of the declared
      // types (positional info is lost — there's no way to express a
      // mixed-prefix-plus-rest array in strict-object form).
      items.push(rest);
    }

    // If all items are the same type, simplify to a single items schema
    if (items.length > 0 && items.every((item) => JSON.stringify(item) === JSON.stringify(items[0]))) {
      result.items = items[0];
    } else if (descriptor.tupleEncoding === 'prefix-items') {
      result.prefixItems = items;
    } else {
      // items-union or strict-mode-with-rest fallback: collapse to anyOf
      result.items = { anyOf: items };
    }

    if (descriptor.tupleEncoding === 'prefix-items' && rest) {
      result.additionalItems = rest;
    }
    if (!rest) {
      let minItems = items.length;
      while (minItems > 0 && isOptional(schema.def.items[minItems - 1])) {
        minItems--;
      }
      result.minItems = minItems;
      result.maxItems = items.length;
    }

    if (descriptor.allowMinMaxItems) {
      const { minimum, maximum } = schema._zod.bag;
      if (typeof minimum === 'number') {
        result.minItems = minimum;
      }
      if (typeof maximum === 'number') {
        result.maxItems = maximum;
      }
    }

    return result;
  }

  // Handle ZodEnum
  if (schema instanceof z.ZodEnum) {
    const numericValues = Object.values(schema.def.entries).filter((v) => typeof v === "number");
    const values = Object.entries(schema.def.entries)
        .filter(([k, _]) => numericValues.indexOf(+k) === -1)
        .map(([_, v]) => v);
    return {
      type: values.every((v) => typeof v === 'number')
        ? 'number'
        : values.every((v) => typeof v === 'string')
          ? 'string'
          : undefined,
      enum: values,
    };
  }

  // Handle ZodLiteral
  if (schema instanceof z.ZodLiteral) {
    const values = Array.from(schema.values).filter(v => v !== undefined && typeof v !== 'function' && typeof v !== 'symbol' && typeof v !== 'bigint');
    const types = Array.from(new Set(values.map(v => v === null ? 'null' : typeof v) as ('string' | 'number' | 'boolean' | 'null')[]));

    return {
      ...(types.length === 1 ? { type: types[0] } : {}),
      ...(values.length === 1 ? { const: values[0] } : { enum: values }),
    };
  }

  // Handle ZodDefault
  if (schema instanceof z.ZodDefault) {
    const innerJson = convert(schema.def.innerType, context);
    innerJson.default = JSON.parse(JSON.stringify(schema.def.defaultValue));
    return innerJson;
  }

  // Handle ZodLazy - don't unwrap here, let convert() handle caching
  if (schema instanceof z.ZodLazy) {
    throw new Error('ZodLazy should be handled in convert(), not convertSchema()');
  }

  // Handle ZodCodec
  if (schema instanceof z.ZodCodec) {
    return convert(schema.def.in, context);
  }

  // Handle ZodPipe (from preprocess)
  if (schema instanceof z.ZodPipe) {
    const innerType = schema.def.in._zod.def.type === "transform" ? schema.def.out : schema.def.in;
    return convert(innerType, context);
  }

  // Handle primitive types
  if (schema instanceof z.ZodString) {
    const result: JSONSchema = { type: 'string' };

    const { minimum, maximum, format, patterns, contentEncoding } = schema._zod.bag;

    // Format: emit only when allowed by the descriptor.
    if (typeof format === 'string') {
      const formats = descriptor.supportedStringFormats;
      if (formats === 'all' || formats.has(format)) {
        result.format = format;
      }
    }

    if (descriptor.allowMinMaxLength) {
      if (typeof minimum === 'number') {
        result.minLength = minimum;
      }
      if (typeof maximum === 'number') {
        result.maxLength = maximum;
      }
    }

    if (typeof contentEncoding === 'string' && descriptor.allowMinMaxLength) {
      // contentEncoding piggybacks on the lenient gate (it's not a strict-mode-safe field)
      result.contentEncoding = contentEncoding;
    }

    if (patterns && descriptor.allowPattern) {
      if (patterns.size === 1 || !descriptor.allowMultiplePatterns) {
        result.pattern = Array.from(patterns)[0].source;
      } else {
        result.allOf = Array.from(patterns).map((regex) => ({
          type: 'string',
          pattern: regex.source,
        }));
      }
    }

    return result;
  }

  if (schema instanceof z.ZodNumber) {
    const result: JSONSchema = { type: 'number' };

    const { minimum, maximum, format, multipleOf, exclusiveMaximum, exclusiveMinimum } = schema._zod.bag;
    if (typeof format === 'string' && format.includes("int")) {
      result.type = 'integer';
    }

    if (descriptor.allowMinimumMaximum) {
      if (typeof exclusiveMinimum === 'number') {
        result.exclusiveMinimum = exclusiveMinimum;
      } else if (typeof minimum === 'number') {
        result.minimum = minimum;
      }
      if (typeof exclusiveMaximum === 'number') {
        result.exclusiveMaximum = exclusiveMaximum;
      } else if (typeof maximum === 'number') {
        result.maximum = maximum;
      }
      if (typeof multipleOf === 'number') {
        result.multipleOf = multipleOf;
      }
    }

    return result;
  }

  if (schema instanceof z.ZodBoolean || schema instanceof z.ZodSuccess) {
    return { type: 'boolean' };
  }

  if (schema instanceof z.ZodBigInt) {
    return { type: 'integer' };
  }

  if (schema instanceof z.ZodDate || schema instanceof z.ZodISODateTime) {
    return stringWithFormat('date-time', descriptor);
  }

  if (schema instanceof z.ZodISODate) {
    return stringWithFormat('date', descriptor);
  }

  if (schema instanceof z.ZodISOTime) {
    return stringWithFormat('time', descriptor);
  }

  if (schema instanceof z.ZodISODuration) {
    return stringWithFormat('duration', descriptor);
  }

  if (schema instanceof z.ZodEmail) {
    return stringWithFormat('email', descriptor);
  }

  if (schema instanceof z.ZodIPv4) {
    return stringWithFormat('ipv4', descriptor);
  }

  if (schema instanceof z.ZodIPv6) {
    return stringWithFormat('ipv6', descriptor);
  }

  if (schema instanceof z.ZodUUID) {
    return stringWithFormat('uuid', descriptor);
  }

  if (schema instanceof z.ZodNull) {
    return { type: 'null' };
  }

  if (schema instanceof z.ZodTemplateLiteral) {
    return { type: 'string', pattern: schema._zod.pattern?.source };
  }

  if (schema instanceof z.ZodUndefined) {
    return { type: 'null' }; // Treat undefined as null in JSON
  }

  if (schema instanceof z.ZodAny || schema instanceof z.ZodUnknown) {
    // Bare `{}` would satisfy the meaning of "any" but OpenAI's strict
    // structured-output mode rejects schemas without a `type` key. For
    // descriptors with a recursive Any encoding, promote to a single shared
    // `$defs/Any` definition that covers every JSON value and return a
    // `$ref` — sharing keeps the output compact when `z.any()` appears many
    // times inside a big union. For descriptors with `flat` Any encoding
    // (e.g. Anthropic, which rejects recursive `$defs` graphs), inline the
    // permissive shape directly so the schema stays acyclic.
    if (descriptor.anyEncoding === 'flat') {
      return buildAnyValueSchema(descriptor);
    }
    const id = 'Any';
    if (!context.definitionSchemas.has(id)) {
      // Seed a placeholder BEFORE building the body so recursive
      // `$ref: '#/$defs/Any'` references don't infinite-loop during
      // construction.
      context.definitionSchemas.set(id, {});
      context.definitionSchemas.set(id, buildAnyValueSchema(descriptor));
    }
    return { $ref: `#/$defs/${id}` };
  }

  if (schema instanceof z.ZodTransform) {
    return {}; // Transforms are not represented in JSON Schema
  }

  // Fallback for unknown types
  console.warn(`Unknown Zod schema type: ${schema.constructor.name}`);

  return {};
}

/**
 * Builds the body of the "any value" schema — an `anyOf` covering every JSON
 * value (string, number, boolean, null, array, object).
 *
 * Encoding modes:
 * - `recursive-strict` (OpenAI strict): self-referencing `$defs/Any` with
 *   array-of-pairs records (no open-object support in strict mode).
 * - `recursive-open` (Lenient / Google): self-referencing `$defs/Any` with
 *   `additionalProperties: <self>` records.
 * - `flat` (Anthropic strict): non-recursive — array branch has no `items`
 *   constraint, object branch is `additionalProperties: true`. Equivalent
 *   to TypeScript `any`; safe under descriptors that reject cyclic `$defs`.
 */
function buildAnyValueSchema(descriptor: FormatDescriptor): JSONSchema {
  const isFlat = descriptor.anyEncoding === 'flat';
  const selfRef: JSONSchema = isFlat ? {} : { $ref: '#/$defs/Any' };
  const arrayBranch: JSONSchema = isFlat
    ? { type: 'array' }
    : { type: 'array', items: selfRef };
  const branches: JSONSchema[] = [
    { type: 'string' },
    { type: 'number' },
    { type: 'boolean' },
    { type: 'null' },
    arrayBranch,
  ];
  if (descriptor.anyEncoding === 'recursive-strict') {
    branches.push({
      type: 'array',
      items: {
        type: 'object',
        properties: {
          key: { type: 'string' },
          value: selfRef,
        },
        required: ['key', 'value'],
        additionalProperties: false,
      },
    });
  } else if (descriptor.anyEncoding === 'recursive-open') {
    branches.push({
      type: 'object',
      additionalProperties: selfRef,
    });
  } else {
    // flat
    branches.push({
      type: 'object',
      additionalProperties: true,
    });
  }
  return { anyOf: branches };
}

/**
 * Makes a JSON Schema nullable.
 *
 * For descriptors where optional becomes nullable on the wire (OpenAI strict),
 * this rewrites the schema to either include `null` in `type` or wrap in
 * `anyOf: [..., {type: 'null'}]`. For other descriptors this is a no-op (the
 * caller handles optional via the `required[]` list instead).
 */
function makeNullable(schema: JSONSchema, descriptor: FormatDescriptor): JSONSchema {
  // Lenient/standard dialects don't rewrite — optional is expressed via
  // required[] omission, not via type-union with null.
  if (!descriptor.optionalAsNullable) {
    return schema;
  }

  if (schema.$ref) {
    return {
      anyOf: [
        { $ref: schema.$ref },
        { type: 'null' },
      ],
    };
  }

  if (schema.type) {
    const hasTypeSpecificProps =
      schema.items !== undefined ||
      schema.properties !== undefined ||
      schema.additionalProperties !== undefined ||
      schema.patternProperties !== undefined ||
      schema.minItems !== undefined ||
      schema.maxItems !== undefined ||
      schema.minProperties !== undefined ||
      schema.maxProperties !== undefined;

    if (hasTypeSpecificProps) {
      const { type, description, ...rest } = schema;
      const baseType = Array.isArray(type) ? type[0] : type;

      return {
        anyOf: [
          { type: baseType, ...rest },
          { type: 'null' },
        ],
        ...(description ? { description } : {}),
      };
    }

    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.includes('null')) {
      return {
        ...schema,
        type: [...types, 'null'],
      };
    }
    return schema;
  }

  if (schema.anyOf) {
    const hasNull = schema.anyOf.some((s) => s.type === 'null');
    if (!hasNull) {
      return {
        ...schema,
        anyOf: [...schema.anyOf, { type: 'null' }],
      };
    }
    return schema;
  }

  return {
    anyOf: [
      schema,
      { type: 'null' },
    ],
  };
}

function isOptional(schema: z.ZodType | z.core.$ZodType): boolean {
  return schema._zod.optin !== undefined;
}

/**
 * Emit a `{ type: 'string', format: ... }` JSON Schema, dropping the format
 * when the descriptor's whitelist excludes it. The string type is always
 * preserved; only the format hint is gated.
 */
function stringWithFormat(format: string, descriptor: FormatDescriptor): JSONSchema {
  const formats = descriptor.supportedStringFormats;
  if (formats === 'all' || formats.has(format)) {
    return { type: 'string', format };
  }
  return { type: 'string' };
}

// ============================================================================
// Schema feature analysis + per-request strict allocation
// ============================================================================

/**
 * Structural feature counts for a Zod schema, used by the SchemaBudget to
 * decide whether an item fits a descriptor's per-request budget and whether
 * the descriptor can express it at all.
 */
export interface SchemaFeatures {
  /** True if the schema (or any subschema) uses `z.lazy` / self-recursion. */
  hasRecursion: boolean;
  /** Count of `z.optional()` leaves anywhere in the schema. */
  optionalParameterCount: number;
  /**
   * Count of union-shaped nodes — `z.union`, `z.discriminatedUnion`, plus
   * `z.nullable` (which on the wire under OpenAI strict becomes a type
   * array `[T, "null"]`, also counts toward Anthropic's union-type budget).
   */
  unionTypeCount: number;
  /** Count of `z.record` nodes. */
  recordCount: number;
  /** Count of `z.tuple` nodes. */
  tupleCount: number;
}

const ZERO_FEATURES: SchemaFeatures = Object.freeze({
  hasRecursion: false,
  optionalParameterCount: 0,
  unionTypeCount: 0,
  recordCount: 0,
  tupleCount: 0,
});

const featuresCache = new WeakMap<z.ZodType | z.core.$ZodType, SchemaFeatures>();

/**
 * Walk a Zod schema once and count its structural features. Result is
 * cached per schema in a WeakMap — second-and-subsequent calls are O(1) and
 * the entry is GC'd with the schema (same OOM-safe pattern as `strictify`).
 */
export function analyzeSchema(schema: z.ZodType | z.core.$ZodType): SchemaFeatures {
  const cached = featuresCache.get(schema);
  if (cached) return cached;

  const visiting = new Set<z.ZodType | z.core.$ZodType>();
  const features: SchemaFeatures = { ...ZERO_FEATURES };

  function walk(s: z.ZodType | z.core.$ZodType | undefined | null): void {
    if (!s) return;
    if (visiting.has(s)) return;
    visiting.add(s);
    try {
      // Recursion is detected via z.lazy: peek at the inner schema (but only
      // once — the visiting set bounds the walk).
      if (s instanceof z.ZodLazy) {
        features.hasRecursion = true;
        try {
          walk(s.def.getter());
        } catch { /* lazy getter may throw at analyze time; ignore */ }
        return;
      }

      if (s instanceof z.ZodOptional) {
        features.optionalParameterCount += 1;
        walk(s.unwrap());
        return;
      }

      if (s instanceof z.ZodNullable) {
        features.unionTypeCount += 1; // T|null counts as a union on the wire
        walk(s.unwrap());
        return;
      }

      if (s instanceof z.ZodUnion || s instanceof z.ZodDiscriminatedUnion) {
        features.unionTypeCount += 1;
        for (const opt of (s as z.ZodUnion).options) walk(opt);
        return;
      }

      if (s instanceof z.ZodIntersection) {
        walk(s.def.left);
        walk(s.def.right);
        return;
      }

      if (s instanceof z.ZodObject) {
        for (const key in s.shape) walk(s.shape[key]);
        if (s.def.catchall) walk(s.def.catchall);
        return;
      }

      if (s instanceof z.ZodArray) {
        walk(s.element);
        return;
      }

      if (s instanceof z.ZodRecord) {
        features.recordCount += 1;
        if (s.keyType) walk(s.keyType);
        walk(s.valueType);
        return;
      }

      if (s instanceof z.ZodTuple) {
        features.tupleCount += 1;
        for (const item of s.def.items) walk(item);
        if (s.def.rest) walk(s.def.rest);
        return;
      }

      if (s instanceof z.ZodDefault) {
        walk(s.def.innerType);
        return;
      }

      if (s instanceof z.ZodCodec || s instanceof z.ZodPipe) {
        walk(s.def.in);
        walk(s.def.out);
        return;
      }

      // Primitives and unknown leaves contribute nothing.
    } finally {
      visiting.delete(s);
    }
  }

  walk(schema);
  Object.freeze(features);
  featuresCache.set(schema, features);
  return features;
}

/**
 * Per-request strict-mode allocator.
 *
 * Constructed once per outgoing request with the chosen model's strictest
 * descriptor. Tracks remaining slots (strict tools, optional parameters,
 * union types) against the descriptor's documented per-request limits and
 * decides per-tool / per-output whether to emit strict or fall back to
 * LENIENT.
 *
 * Selection guarantees that any tool with `strict: true` (hard requirement)
 * has a model that supports the family — `allocate` therefore always grants
 * strict for `requested === true` (subject only to feasibility, not budget;
 * if `true` items overflow the budget the API call will fail, which is the
 * correct behavior for hard requirements).
 *
 * Numeric `strict: <priority>` items are allocated greedily after `true`
 * items have consumed their share of the budget. Caller is expected to
 * pre-sort by descending priority before iterating.
 */
export class SchemaBudget {
  private readonly descriptor: FormatDescriptor;
  private remainingTools: number;
  private remainingOptionalParams: number;
  private remainingUnionTypes: number;

  constructor(descriptor: FormatDescriptor) {
    this.descriptor = descriptor;
    this.remainingTools = descriptor.maxStrictTools ?? Infinity;
    this.remainingOptionalParams = descriptor.maxStrictOptionalParams ?? Infinity;
    this.remainingUnionTypes = descriptor.maxStrictUnionTypes ?? Infinity;
  }

  /**
   * Decide the effective descriptor for a tool's parameter schema given the
   * dev's strict request, the schema's features, and the remaining budget.
   *
   * Returns `LENIENT` when:
   * - `requested === false`
   * - the schema uses a feature the descriptor can't represent
   * - the descriptor has slot limits and the budget is exhausted (only
   *   applies to `requested` being a positive number; `true` always wins
   *   subject to feasibility)
   *
   * Returns the strict descriptor (and decrements the budget) otherwise.
   */
  allocateTool(
    schema: z.ZodType | z.core.$ZodType,
    requested: boolean | number | undefined,
  ): FormatDescriptor {
    return this.allocate(schema, requested, /* isTool */ true);
  }

  /**
   * Same as `allocateTool` but for the request's structured-output schema.
   * The output schema doesn't consume a tool slot but it does count toward
   * the optional-parameter and union-type budgets — descriptors document
   * those limits as "across all strict schemas in one request".
   */
  allocateOutput(
    schema: z.ZodType | z.core.$ZodType,
    requested: boolean | number | undefined,
  ): FormatDescriptor {
    return this.allocate(schema, requested, /* isTool */ false);
  }

  /** Snapshot of remaining budget. Useful for telemetry / debug logs. */
  remaining(): { strictTools: number; optionalParams: number; unionTypes: number } {
    return {
      strictTools: this.remainingTools,
      optionalParams: this.remainingOptionalParams,
      unionTypes: this.remainingUnionTypes,
    };
  }

  private allocate(
    schema: z.ZodType | z.core.$ZodType,
    requested: boolean | number | undefined,
    isTool: boolean,
  ): FormatDescriptor {
    // strict: false → always lenient, no budget movement.
    if (requested === false) return LENIENT;
    // Descriptor itself is lenient → nothing to allocate.
    if (!this.descriptor.strict) return LENIENT;

    const features = analyzeSchema(schema);
    const isHardRequired = requested === true;
    const isPreferredNumeric = typeof requested === 'number' && requested > 0;

    if (!isHardRequired && !isPreferredNumeric) {
      // requested is undefined or 0 — treat as no preference; default to
      // lenient so callers explicitly opt into strict.
      return LENIENT;
    }

    // Soft-priority items must fit the budget. Hard-required items skip
    // budget checks because selection already promised the model can take
    // them — if there are too many, that's a request-construction bug we
    // surface via API error rather than degrading silently.
    if (isPreferredNumeric) {
      if (isTool && this.remainingTools <= 0) return LENIENT;
      if (this.remainingOptionalParams - features.optionalParameterCount < 0) return LENIENT;
      if (this.remainingUnionTypes - features.unionTypeCount < 0) return LENIENT;
    }

    // Allocation succeeded — decrement.
    if (isTool) this.remainingTools -= 1;
    this.remainingOptionalParams -= features.optionalParameterCount;
    this.remainingUnionTypes -= features.unionTypeCount;

    return this.descriptor;
  }
}

/**
 * Compare two descriptors and return the one with the tighter per-request
 * budget. Used by providers to pick a single descriptor for a SchemaBudget
 * shared between `convertTools` and `convertResponseFormat` — Anthropic's
 * documented limits apply across the whole request, so the strictest
 * descriptor wins.
 */
export function strictestOf(a: FormatDescriptor, b: FormatDescriptor): FormatDescriptor {
  // LENIENT is the loosest — pick the strict side if either is strict.
  if (a.strict && !b.strict) return a;
  if (b.strict && !a.strict) return b;
  if (!a.strict && !b.strict) return a;
  // Both strict — pick the one with the smallest documented limits.
  const score = (d: FormatDescriptor): number =>
    (d.maxStrictTools ?? Infinity) +
    (d.maxStrictOptionalParams ?? Infinity) +
    (d.maxStrictUnionTypes ?? Infinity);
  return score(a) <= score(b) ? a : b;
}

/**
 * Convert a `boolean | number | undefined` strict request into a numeric
 * priority for sorting. Used by providers to allocate strict slots in
 * descending priority order.
 *
 * - `true` → `+Infinity` (hard requirement; always first in line)
 * - `false` → `-Infinity` (always lenient; never wants strict)
 * - `number > 0` → the number itself
 * - `number <= 0` or `undefined` → `0` (no preference)
 */
export function strictPriority(requested: boolean | number | undefined): number {
  if (requested === true) return Infinity;
  if (requested === false) return -Infinity;
  if (typeof requested === 'number') return requested > 0 ? requested : 0;
  return 0;
}
