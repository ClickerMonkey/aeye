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
 * Documented ceilings on how BIG one strict schema may be, as opposed to which
 * keywords it may use. Every limit here is a SUM taken over a single schema —
 * one tool's `parameters`, or one structured-output schema — not a per-request
 * allowance shared between them (that is `maxStrictTools` and friends, which
 * the `SchemaBudget` spends across the whole request).
 *
 * A schema that exceeds one of these is a guaranteed provider rejection under
 * strict mode, so `SchemaBudget.allocate` treats it like any other
 * infeasibility and degrades that ONE item to the family's non-strict
 * descriptor, where no size rule applies. The rest of the request is
 * unaffected.
 *
 * Declared as one object rather than six optional fields on purpose: a
 * provider documents these together, and the object being present is what says
 * "this dialect publishes size limits". Adding a rule here is then a compile
 * error at every descriptor that declares the group, which is the point
 * (a missed limit is invisible until a 400).
 */
export interface SchemaSizeLimits {
  /** Maximum object properties in one schema, summed over every nesting level. */
  readonly maxObjectProperties: number;
  /** Maximum levels of nested containers below the schema root. */
  readonly maxNestingDepth: number;
  /**
   * Maximum total characters over the schema's property names, `enum` values
   * and `const` values together.
   */
  readonly maxTotalStringChars: number;
  /** Maximum `enum` values summed across every enum property in one schema. */
  readonly maxTotalEnumValues: number;
  /**
   * The single-enum value count above which `maxLargeEnumStringChars` starts
   * to apply. A smaller enum is bounded only by the two totals above.
   */
  readonly largeEnumValueCount: number;
  /**
   * Maximum total characters of ONE enum's string values, applied only to an
   * enum carrying more than `largeEnumValueCount` values.
   */
  readonly maxLargeEnumStringChars: number;
}

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
   *   (OpenAI strict has no open-object support). REQUIRES `allowAnyOf` and
   *   `allowDefsRef`.
   * - `recursive-open`: $defs/Any with `additionalProperties: <self>` records.
   *   REQUIRES `allowAnyOf` and `allowDefsRef`.
   * - `flat`: a non-recursive `anyOf` over the JSON value types
   *   (`string`/`number`/`boolean`/`null`/`array`/open-`object`). Used by
   *   descriptors that reject recursive `$defs/Any` definitions (Anthropic
   *   strict). Equivalent to TypeScript `any` — accepts every JSON value
   *   without imposing any structural constraints. REQUIRES `allowAnyOf`
   *   (no `$defs` needed).
   * - `unconstrained`: the empty schema `{}` (plus any `description`). Per
   *   JSON Schema, a schema with no assertion keywords validates EVERY
   *   instance — which is exactly what "any JSON value" means — and it
   *   introduces no keyword a restrictive dialect could reject. REQUIRES
   *   NOTHING, so it's the only encoding available to a dialect that forbids
   *   both combinators and named `$defs`/`$ref` (Google — see `GOOGLE_STRICT`).
   *
   * The `REQUIRES` notes above are enforced by `checkDescriptorConsistency`,
   * which `registerDescriptor` runs so a self-contradictory descriptor is
   * caught at declaration time rather than as a provider HTTP 400.
   */
  readonly anyEncoding: 'recursive-strict' | 'recursive-open' | 'flat' | 'unconstrained';

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

  // ---- Per-SCHEMA strict size limits ----
  /**
   * Documented ceilings on the SIZE of one strict schema (properties, nesting,
   * total string bytes, enum values), or `undefined` when the dialect
   * publishes none. See {@link SchemaSizeLimits} for what each bound counts and
   * why it is per-schema rather than per-request.
   *
   * Only a STRICT descriptor declares these: they are Structured-Outputs rules
   * — the API compiles the schema into a decoder and rejects one it cannot —
   * and a non-strict schema is a best-effort hint the API does not compile. So
   * degrading the offending item to the family's non-strict descriptor is both
   * the fix and the reason the limits stop applying to it
   * (`SchemaBudget.allocate`, `checkSchemaSizeLimits`).
   *
   * The measurement is taken from the ZOD schema, not from the emitted JSON,
   * so it is deliberately CONSERVATIVE where an encoding is descriptor-
   * dependent (a record counts as its widest encoding, a tuple as its
   * numeric-key one). Over-counting costs strictness on a schema that would
   * have fit; under-counting costs an HTTP 400, so the round goes up.
   */
  readonly schemaSizeLimits?: SchemaSizeLimits;

  // ---- Enum cardinality ----
  /**
   * Maximum number of values ONE emitted `enum` may carry, or `undefined`
   * (the default) for no cap.
   *
   * This is deliberately NOT one of the per-request budget fields above. Those
   * are strict-mode allowances the SchemaBudget spends across a whole request,
   * degrading an item that no longer fits to the family's non-strict
   * descriptor; this one is a property of the dialect itself — it fires whatever the strictness — so it is enforced
   * structurally at the point an `enum` is emitted (`convertSchema`), where
   * the cardinality is actually known.
   *
   * Over the cap the emitter **widens** rather than truncates: it drops the
   * `enum` keyword entirely, emits the node's plain scalar `type`
   * (`{type: 'string'}` for a string enum), and puts EVERY value into the
   * node's `description`. Nothing becomes unreachable — the model still has
   * the complete list and can name any member — and the cardinality the
   * dialect could not compile is simply no longer on the wire.
   *
   * The trade this makes is enforcement: a widened node no longer rejects a
   * value structurally, so whatever validates the model's output afterwards
   * has to. `Tool.parse` does, against the ORIGINAL zod schema — the enum is
   * still there, only the emitted JSON Schema widened — so a hallucinated
   * member comes back as a normal, re-promptable validation error.
   *
   * **`GOOGLE_STRICT`/`GOOGLE_NON_STRICT` declare 40. Every other built-in
   * declares no cap.** Two earlier rounds of live measurement against
   * `google/gemini-3-flash-preview` through OpenRouter (2026-08-23) — single
   * enums up to 2048 SYNTHETIC values, 20 tools each with a 96-value enum, and
   * an eleven-tool roster modelled on a real kind-authoring agent — all
   * returned HTTP 200 and concluded there was no reproducible limit. **That
   * conclusion was wrong, because none of those enums used the CONTENT of a
   * real session.** A third round replayed the exact wire bytes of a real
   * product request — `fn_load`'s `names` array, enum-constrained to the
   * session's actual 98 known component/fn names (`default_renderer`,
   * `QueryWidget`, `ConfirmPrompt`, `list_widget_types`, …) — and it 400'd,
   * reproducibly, twice, byte-for-byte identical to what the provider was
   * actually sent. Bisecting that same real value list: 90 values passes, 93
   * fails. Bisecting what changes between the passing synthetic probes and the
   * failing real one: 98 SHORT synthetic values (`n0`..`n97`, 284 chars) pass;
   * 206 short values matching the REAL list's total character count (714
   * chars) also pass; only the REAL, longer, dictionary-like/identifier-shaped
   * values fail, and only past ~92 of them. So the limit tracks neither raw
   * member count nor total character/byte budget — most likely actual
   * tokenized grammar-state count, which short repetitive synthetic strings
   * compress far below what real identifier text does at the same count or
   * character budget. This is why the first two rounds' synthetic and
   * lightly-realistic probes never tripped it.
   *
   * **The widen-to-string fallback this field triggers was verified against
   * the exact failing real schema**: dropping `enum` and putting the same 98
   * values into the `description` of a plain string field returned HTTP 200
   * with the expected tool call — confirming the fallback mechanism actually
   * fixes the failure it exists for, not just a synthetic stand-in.
   *
   * **40 is not a measured edge — it is a conservative floor with roughly 2x
   * margin under the real one (90 passes / 93 fails) measured on this one real
   * value set.** Given the failure tracks content, not just count, a different
   * session's actual name list could plausibly fail at a different count; 40
   * was also the cap this exact product ran under in production for months
   * before a since-reverted attempt to remove it, which is corroborating
   * evidence it holds in practice, not just in this one measurement.
   *
   * The reliability comparison from the earlier rounds still stands and is
   * why a cap is preferable to leaving every enum uncapped "to be safe" at a
   * much lower number: `enum` vs plain-string-with-full-list, 10 trials each
   * over confusable near-duplicate names at 96 and 512 values, scored 10/10
   * on-target with zero off-list answers for BOTH encodings. So there is no
   * reliability cost to raising this cap later if a higher safe value is
   * measured — only downside risk to leaving it too high.
   *
   * One trap for whoever measures this next: with `max_tokens` at 64, a
   * forced-tool probe can come back `finish_reason: 'length'` with no tool
   * call and empty content, which reads exactly like a grammar that produced
   * nothing. It usually is not — this model spends reasoning tokens first.
   * Give a forced-tool probe room before calling an empty completion a
   * failure.
   *
   * So: set this only where a provider is MEASURED to reject a large enum
   * using the SESSION'S OWN real content, not synthetic stand-ins, and set it
   * conservatively below the measured edge until more value sets are tested.
   * An `enum` that fits is the more correct encoding, because it is the one
   * the model cannot answer outside of.
   */
  readonly maxEnumValues?: number;

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
 * union types) — the SchemaBudget treats those caps as `undefined` for OpenAI.
 *
 * OpenAI DOES document per-SCHEMA size limits for Structured Outputs, and they
 * are declared below (`schemaSizeLimits`). Verified against
 * developers.openai.com/api/docs/guides/structured-outputs on 2026-08-23,
 * section "Supported schemas": *"A schema may have up to 5000 object
 * properties total, with up to 10 levels of nesting"*, *"total string length of
 * all property names, definition names, enum values, and const values cannot
 * exceed 120,000 characters"*, *"A schema may have up to 1000 enum values
 * across all enum properties"*, and *"For a single enum property with string
 * values, the total string length of all enum values cannot exceed 15,000
 * characters when there are more than 250 enum values"*. Every one of those
 * numbers was raised in July 2025 (100→5000 properties, 15,000→120,000
 * characters, 500→1000 enum values, 7,500→15,000 for the >250-value enum) —
 * the pre-raise figures are still widely quoted secondhand, so they are named
 * here to keep a future reader from "correcting" these downward.
 *
 * Scope is Structured Outputs, i.e. a tool carrying `strict: true` or a
 * `json_schema` response format — the function-calling guide defines strict
 * mode as "leveraging our structured outputs feature", and non-strict function
 * calling is best-effort with no compiled decoder. That is exactly why
 * degrading the over-size item to `OPENAI_NON_STRICT` is a complete answer.
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
  // Every number is quoted from OpenAI's own "Supported schemas" section — see
  // the descriptor doc above for the exact sentences and the date they were
  // read. Frozen because `Object.freeze` on the descriptor is shallow.
  schemaSizeLimits: Object.freeze({
    maxObjectProperties: 5000,
    maxNestingDepth: 10,
    maxTotalStringChars: 120_000,
    maxTotalEnumValues: 1000,
    largeEnumValueCount: 250,
    maxLargeEnumStringChars: 15_000,
  }),
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
 * - `z.any()` / `z.unknown()` uses the `unconstrained` encoding. Every other
 *   "any" encoding needs `anyOf` and/or a named `$defs/Any` — both of which
 *   this descriptor forbids two lines below — so the recursive `$defs/Any`
 *   this descriptor used to declare was a schema it says it cannot emit.
 *   Gemini compiles the tool schemas into a decoding grammar whenever the
 *   caller forces a tool call (`toolChoice: 'required'` → Google's function
 *   calling mode `ANY`), and a self-referencing `$defs/Any` failed that
 *   compile with `400 INVALID_ARGUMENT` — the same request succeeded under
 *   `toolChoice: 'auto'`, where no grammar is built. Reported against
 *   `google/gemini-3-flash-preview` via OpenRouter as 100% reproducible.
 *
 *   **That 400 no longer reproduces (re-measured 2026-08-23)** and the
 *   encoding stays anyway. Same model, same route, upstream pinned to Google
 *   AI Studio with fallbacks off, `tool_choice` forced to one named tool: the
 *   hand-built recursive `$defs/Any` tool, and the product's real 32 KB gin
 *   `api_set` schema carrying nine `#/$defs/Any` references, both answered
 *   HTTP 200 with a valid tool call. So the upstream either fixed or now
 *   sanitizes it. The descriptor still declares what this dialect's own
 *   documented keyword list supports; depending on a provider's current
 *   leniency for a shape we say it cannot express is how the first version of
 *   this descriptor shipped a guaranteed 400 in the first place.
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
  // The ONLY encoding expressible under `allowAnyOf: false` +
  // `allowDefsRef: false` — see the descriptor doc above.
  anyEncoding: 'unconstrained',
  // No documented per-request slot limits. `maxEnumValues: 40` IS a measured
  // response to a real `400 INVALID_ARGUMENT` on this exact product's live
  // fn-catalog enum — see `FormatDescriptor.maxEnumValues` for the numbers,
  // the bisection, and why 40 is conservative rather than the measured edge.
  maxEnumValues: 40,
  supportsRecursion: true,
  // Gemini's structured-output endpoint rejects `anyOf`/`$defs` schemas
  // (HTTP 400). When a schema can't be expressed here it's delivered as
  // prompt text instead; this hint keeps the reply a single raw JSON object.
  jsonFallbackInstruction:
    'Return ONLY a single raw JSON object that conforms to the schema above. Do NOT wrap it in markdown code fences, do NOT add any prose before or after it, and do NOT echo the schema itself — emit only the JSON instance.',
});

/**
 * Google Gemini non-strict — LENIENT's permissive rules EXCEPT for the "any"
 * encoding.
 *
 * Gemini rejects a self-referencing `$defs/Any` when it has to build a
 * decoding grammar, and it builds one whenever a tool call is forced —
 * independent of any per-tool `strict` flag, which Google's function-calling
 * API doesn't even have. So the `unconstrained` encoding is a property of the
 * DIALECT, not of strict mode, and belongs on both Google descriptors.
 *
 * Everything else stays LENIENT deliberately: the restrictions on
 * `GOOGLE_STRICT` come from the documented structured-output keyword list,
 * which is a grammar-mode concern, and tightening them here would push
 * ordinary Gemini schemas onto the prompt-text delivery fallback for no
 * measured reason.
 */
export const GOOGLE_NON_STRICT: FormatDescriptor = Object.freeze({
  ...LENIENT,
  id: 'google-non-strict',
  family: 'google',
  anyEncoding: 'unconstrained',
  // Same measured enum-cardinality limit as GOOGLE_STRICT — it fires whatever
  // the strictness (see FormatDescriptor.maxEnumValues), so a tool degraded
  // to this descriptor still needs it.
  maxEnumValues: 40,
  jsonFallbackInstruction:
    'Return ONLY a single raw JSON object that conforms to the schema above. Do NOT wrap it in markdown code fences, do NOT add any prose before or after it, and do NOT echo the schema itself — emit only the JSON instance.',
});

// ============================================================================
// Descriptor self-consistency
// ============================================================================

/**
 * JSON-Schema keywords each `anyEncoding` has to emit. Single source of truth
 * for both `buildAnyValueSchema` (which produces the shape) and
 * `checkDescriptorConsistency` (which checks the descriptor is allowed to).
 */
const ANY_ENCODING_REQUIREMENTS: Readonly<Record<
  FormatDescriptor['anyEncoding'],
  { readonly anyOf: boolean; readonly defsRef: boolean }
>> = Object.freeze({
  'recursive-strict': { anyOf: true, defsRef: true },
  'recursive-open': { anyOf: true, defsRef: true },
  'flat': { anyOf: true, defsRef: false },
  'unconstrained': { anyOf: false, defsRef: false },
});

/**
 * Report the ways a `FormatDescriptor` contradicts itself — settings that ask
 * the emitter to produce a keyword the same descriptor forbids, or a limit
 * that would quietly strip every constraint it governs. Returns one
 * human-readable line per problem; an empty array means the descriptor is
 * internally consistent.
 *
 * This exists because a contradiction here is invisible until a provider
 * answers HTTP 400: `GOOGLE_STRICT` shipped with `allowAnyOf: false` +
 * `allowDefsRef: false` AND `anyEncoding: 'recursive-open'` (which needs
 * both), so every `z.any()` in a Gemini tool schema emitted exactly the
 * `anyOf` + `$defs/Any` shape the descriptor declared unrepresentable.
 * Nothing checked, so nothing caught it.
 *
 * Called by `registerDescriptor` (which warns) and asserted over every
 * built-in by the test suite.
 *
 * @example
 * ```ts
 * checkDescriptorConsistency(GOOGLE_STRICT);   // → []
 * checkDescriptorConsistency({ ...GOOGLE_STRICT, anyEncoding: 'flat' });
 * //  → ["anyEncoding 'flat' emits `anyOf`, but allowAnyOf is false"]
 * ```
 */
export function checkDescriptorConsistency(descriptor: FormatDescriptor): string[] {
  const problems: string[] = [];
  const needs = ANY_ENCODING_REQUIREMENTS[descriptor.anyEncoding];
  if (needs === undefined) {
    problems.push(`anyEncoding '${descriptor.anyEncoding}' is not a known encoding`);
    return problems;
  }
  if (needs.anyOf && !descriptor.allowAnyOf) {
    problems.push(`anyEncoding '${descriptor.anyEncoding}' emits \`anyOf\`, but allowAnyOf is false`);
  }
  if (needs.defsRef && !descriptor.allowDefsRef) {
    problems.push(`anyEncoding '${descriptor.anyEncoding}' emits a self-referencing \`$defs/Any\`, but allowDefsRef is false`);
  }
  if (needs.defsRef && !descriptor.supportsRecursion) {
    problems.push(`anyEncoding '${descriptor.anyEncoding}' emits a self-referencing \`$defs/Any\`, but supportsRecursion is false`);
  }
  // `maxEnumValues` is an independent scalar — there is no other field it can
  // contradict — but a cap below 1 widens EVERY enum the dialect ever emits
  // (including a two-member one), and a fractional cap reads as a threshold
  // nobody intended. Both are silent: the schema stays valid, it just stops
  // constraining anything, which is the "invisible until you read the wire"
  // class this function exists to catch. Only reachable through
  // `registerDescriptor`; the built-ins are asserted clean by the test suite.
  const cap = descriptor.maxEnumValues;
  if (cap !== undefined && (!Number.isInteger(cap) || cap < 1)) {
    problems.push(`maxEnumValues must be a positive integer, got ${cap}`);
  }
  problems.push(...schemaSizeLimitProblems(descriptor));
  return problems;
}

/**
 * The ways a `schemaSizeLimits` group contradicts itself or the descriptor
 * carrying it. Split out only to keep `checkDescriptorConsistency` readable;
 * it is part of the same contract.
 *
 * The failures below are all SILENT: a non-positive bound degrades every
 * schema to lenient (strict mode simply stops happening, with no error
 * anywhere), a threshold above the total makes the large-enum rule
 * unreachable, and limits on a non-strict descriptor describe a rule the API
 * does not apply — each one is a rule that reads as enforced and is not.
 */
function schemaSizeLimitProblems(descriptor: FormatDescriptor): string[] {
  const limits = descriptor.schemaSizeLimits;
  if (limits === undefined) return [];
  const problems: string[] = [];
  if (!descriptor.strict) {
    problems.push('schemaSizeLimits is declared on a non-strict descriptor, but the size rules bound Structured Outputs only');
  }
  // Keyed off the interface, so a bound added to `SchemaSizeLimits` is checked
  // here without an edit — `satisfies` makes a missed key a compile error.
  const bounds = {
    maxObjectProperties: limits.maxObjectProperties,
    maxNestingDepth: limits.maxNestingDepth,
    maxTotalStringChars: limits.maxTotalStringChars,
    maxTotalEnumValues: limits.maxTotalEnumValues,
    largeEnumValueCount: limits.largeEnumValueCount,
    maxLargeEnumStringChars: limits.maxLargeEnumStringChars,
  } satisfies Record<keyof SchemaSizeLimits, number>;
  for (const [name, value] of Object.entries(bounds)) {
    if (!Number.isInteger(value) || value < 1) {
      problems.push(`schemaSizeLimits.${name} must be a positive integer, got ${value}`);
    }
  }
  if (limits.largeEnumValueCount >= limits.maxTotalEnumValues) {
    problems.push(
      `schemaSizeLimits.largeEnumValueCount (${limits.largeEnumValueCount}) is not below maxTotalEnumValues ` +
        `(${limits.maxTotalEnumValues}), so the large-enum character rule can never apply`,
    );
  }
  return problems;
}

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
 *
 * A descriptor that contradicts itself (see `checkDescriptorConsistency`) is
 * still registered — the caller may know something we don't — but each
 * problem is warned once at registration, because the alternative is finding
 * out from a provider's HTTP 400.
 */
export function registerDescriptor(descriptor: FormatDescriptor): void {
  for (const problem of checkDescriptorConsistency(descriptor)) {
    console.warn(`FormatDescriptor '${descriptor.id}' is inconsistent: ${problem}`);
  }
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
 * The key an EAGER walk's cycle guard must use for `s`.
 *
 * Object identity alone is a broken guard, because a `z.lazy` is only required
 * to return *a* schema — not the *same* schema object — from its getter. A
 * codegen layer that derives zod from a live type registry rebuilds the subtree
 * on every call (`@aeye/gin`'s `buildSchemas` does), so each re-entry into a
 * recursive node is a FRESH object: an identity guard never fires, the walk
 * descends forever, and because every level allocates a whole new subtree
 * (measured ~9.4 KB/level) the process dies of heap exhaustion —
 * `FATAL ERROR: Ineffective mark-compacts near heap limit` — rather than
 * overflowing the stack. `convert()` already survives this by matching a cached
 * definition on the `aid` such a layer stamps on the node (see its `ZodLazy`
 * branch), so the eager walkers key on the SAME identity: a declared
 * `aid`/`id` names the definition, and only an unnamed node falls back to
 * object identity.
 *
 * The two IDs are read in `convert()`'s own precedence (`aid` then `id`), and
 * carry the same meaning here that they do there: two nodes sharing one
 * declared id ARE one definition.
 */
function walkKey(s: z.ZodType | z.core.$ZodType): z.ZodType | z.core.$ZodType | string {
  if (!(s instanceof z.ZodType)) return s;
  const meta = s.meta();
  const declared = meta?.aid ?? meta?.id;
  // Prefixed so a declared id can never be mistaken for anything else in the
  // guard's key space (the alternative member is an object, so this is belt +
  // braces against a future string-keyed member).
  return typeof declared === 'string' ? `id:${declared}` : s;
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
export function canExpress(
  schema: z.ZodType | z.core.$ZodType,
  descriptor: FormatDescriptor,
): boolean {
  return expressible(schema, descriptor, /* cycleBreakerCounts */ false);
}

/**
 * `canExpress`, except that a cycle counts as EXPRESSIBLE whatever the
 * descriptor's ref flags say, because `emitCachedRef` replaces any back-edge
 * the descriptor cannot spell with the bounded `buildCycleBreakerSchema`
 * placeholder. The emitted schema is therefore always *sendable*; it is only
 * *looser* than the source at the back-edge.
 *
 * That distinction is the whole reason there are two predicates:
 * - `canExpress` answers "will the model be properly CONSTRAINED by this?",
 *   which is what a structured-OUTPUT delivery decision needs — a back-edge
 *   silently widened to "any" is a good reason to deliver the schema as prompt
 *   text instead (`applySchemaDeliveryFallback`), and
 *   `ANTHROPIC_STRICT`'s `supportsRecursion: false` is exactly that case.
 * - this one answers "will the provider REJECT this?", which is what a TOOL's
 *   strict allocation needs. A tool has no prompt-text fallback, so degrading a
 *   merely-loose schema to LENIENT would trade a real strict guarantee for
 *   nothing.
 *
 * The combinator half is shared and is the half that actually bites: nothing
 * rewrites a forbidden `anyOf`/`allOf` away, so a schema carrying one is a
 * provider 400 under a descriptor that forbids it.
 */
function sendableUnder(
  schema: z.ZodType | z.core.$ZodType,
  descriptor: FormatDescriptor,
): boolean {
  return expressible(schema, descriptor, /* cycleBreakerCounts */ true);
}

function expressible(
  schema: z.ZodType | z.core.$ZodType,
  descriptor: FormatDescriptor,
  cycleBreakerCounts: boolean,
): boolean {
  // Keys, not objects — a rebuilt `z.lazy` getter defeats identity (see `walkKey`).
  const rootKey = walkKey(schema);
  // Nodes currently on the DFS stack — a re-encounter is a recursion cycle.
  const inProgress = new Set<z.ZodType | z.core.$ZodType | string>();
  // Completed nodes with their result, so shared (non-cyclic) sub-schemas
  // aren't re-walked (guards against exponential blow-up on DAG-shaped schemas).
  const completed = new Map<z.ZodType | z.core.$ZodType | string, boolean>();

  const walk = (s: z.ZodType | z.core.$ZodType): boolean => {
    const key = walkKey(s);
    if (inProgress.has(key)) {
      // Recursion cycle detected at `s`.
      if (cycleBreakerCounts) return true;
      if (key === rootKey) return descriptor.allowRootRef && descriptor.supportsRecursion;
      return descriptor.allowDefsRef && descriptor.supportsRecursion;
    }
    const cached = completed.get(key);
    if (cached !== undefined) return cached;

    inProgress.add(key);
    const result = walkNode(s);
    inProgress.delete(key);
    completed.set(key, result);
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
    // Carry the catchall through. `z.object(shape)` alone DROPS it, so every
    // `.catchall(...)` / `z.looseObject(...)` / `z.strictObject(...)` schema
    // silently lost its open (or explicitly closed) tail the moment a strict
    // dialect was selected — while `toJSONSchema` kept emitting that same
    // catchall as `additionalProperties` and `analyzeSchema` kept walking it.
    // strictify and the emitter were describing different schemas, and the
    // mismatch surfaced only as keys stripped at validation time.
    //
    // Dialects that close objects (`objectClosedByDefault`: OpenAI/Anthropic
    // strict) still emit `additionalProperties: false` regardless, so no wire
    // shape changes for them — this restores the open tail exactly where the
    // dialect permits one (Google).
    const catchall = schema.def.catchall;
    return transferMetadata(
      catchall
        ? z.object(transformedShape).catchall(transform(catchall))
        : z.object(transformedShape),
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

  // `z.any()` / `z.unknown()` under an INLINE any-encoding (`flat`,
  // `unconstrained`) must never travel through the definition cache: a second
  // use site of the SAME schema instance — common when a codegen layer hands
  // out one shared "any" node — would otherwise be emitted as
  // `$ref: '#/$defs/__schemaN'`, resurrecting the `$defs` entry the inline
  // encoding exists to avoid. Bypassing the cache re-inlines the (tiny,
  // keyword-free) shape at each site instead.
  const bypassCache = !usesSharedAnyDefinition(context.descriptor)
    && (schema instanceof z.ZodAny || schema instanceof z.ZodUnknown);

  // Check if this is a lazy schema and extract metadata early
  if (bypassCache) {
    // fall through to conversion with no cache read
  } else if (schema instanceof z.ZodLazy) {
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

  // If the schema has an 'aid' or 'id' in meta, promote it to a definition.
  // A cache-bypassed "any" node is never promoted — naming a schema that
  // asserts nothing buys nothing, and the `$defs` entry is precisely what the
  // inline encoding is avoiding. A descriptor that forbids `$defs` outright
  // (`allowDefsRef: false` — Google strict) is never promoted to either: the id
  // is still computed, because the cycle-breaker's description names it, but
  // the definition is inlined at each use site, which is the only spelling that
  // dialect has for a shared node.
  const id = (metadata.aid ? String(metadata.aid) : 0) || metadata.id || `__schema${context.refCounter++}`;
  const save =
    !bypassCache
    && !!(metadata.aid || metadata.id)
    && context.root !== schema
    && context.descriptor.allowDefsRef;

  // A schema target - will hold either the converted schema or a $ref
  const target: JSONSchema = {};

  // Before converting, register this schema to handle recursion
  if (!bypassCache) {
    context.definitions.set(cacheKey, [target, id]);
  }
  context.inProgress.add(id);

  // Convert the unwrapped schema
  let result: JSONSchema;
  try {
    result = convertSchema(unwrappedSchema, context);
  } finally {
    context.inProgress.delete(id);
  }
  // A description the CONVERTER produced describes the EMITTED node, not the
  // source schema — today that is only the `maxEnumValues` widening, whose
  // description IS the value list that replaced the `enum` keyword. The source's
  // own `.describe()` must not silently replace it, or a model handed a widened
  // `{type:'string'}` is told nothing about which strings are legal. Keep both,
  // converter note last.
  const emittedNote = result.description;
  Object.assign(result, metadata);
  if (emittedNote !== undefined && metadata.description !== undefined && metadata.description !== emittedNote) {
    result.description = `${metadata.description} ${emittedNote}`;
  }
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
 *    AND the descriptor cannot express the `$ref` this back-edge would need —
 *    emit a shape-aware placeholder via `buildCycleBreakerSchema()` (number
 *    stays number, array stays array, etc.) with a description naming the
 *    `$defs` entry it would have referenced. This breaks the cycle inline so
 *    providers like Anthropic don't reject the schema.
 *
 *    "Cannot express" is TWO flags, not one, because a back-edge is only ever
 *    spelled one of two ways: `{$ref: '#'}` at the root, or `{$ref:
 *    '#/$defs/X'}` anywhere else. `!supportsRecursion` rules out both.
 *    `!allowDefsRef` rules out the second — so a NON-ROOT cycle under a
 *    descriptor that forbids `$defs` (Google strict is exactly that:
 *    `supportsRecursion: true`, `allowRootRef: true`, `allowDefsRef: false`)
 *    must take the same bounded placeholder. Checking only `supportsRecursion`
 *    silently emitted the `$defs`/`$ref` pair the descriptor declares it cannot
 *    send — a schema the provider answers with HTTP 400.
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
  const isRoot = schema === context.root;
  // The spelling this back-edge would need, and whether the descriptor has it.
  const backEdgeExpressible = isRoot ? descriptor.allowRootRef : descriptor.allowDefsRef;

  if (isCycle && (!descriptor.supportsRecursion || !backEdgeExpressible)) {
    // Replace the back-edge with a placeholder whose top-level shape matches
    // the recursive zod schema. The original `cachedJs` target keeps filling
    // in normally — once conversion completes the `$defs` entry exists; we
    // just don't reference it from here, since doing so would form the cycle
    // the provider rejects.
    return buildCycleBreakerSchema(schema, cachedId, descriptor);
  }

  if (isRoot && descriptor.allowRootRef) {
    return { $ref: `#` };
  }

  // A non-cyclic re-encounter under a descriptor with no `$defs`: INLINE the
  // already-converted shape instead of naming it. There is no third spelling in
  // that dialect — a shared node is either repeated or it is a `$ref` the
  // provider rejects. Safe and finite: `!isCycle` means this node's conversion
  // already completed, and any cycle BELOW it was replaced by the bounded
  // placeholder above, so the inlined value is a finite tree. The cost is
  // duplication in the emitted schema, which is what that dialect charges for
  // shared structure.
  //
  // On a schema the dialect can actually SEND that cost is negligible (measured
  // on the cases in `schema-google-defs.test.ts`: 497→435, 627→565, 280→322
  // bytes — inlining a leaf is often smaller than naming it). It is only large
  // on a heavily-shared recursive DAG — a gin `buildSchemas().Expr` renders
  // 44 KB with `$defs` and 1.36 MB without — and such a schema carries 1646
  // `anyOf`s, so `canExpress` already answers `false` for it and no provider
  // path reaches here. Paying size on a schema that must not be sent anyway is
  // the right side of the trade against emitting `$defs` the descriptor
  // declares it cannot send.
  if (!descriptor.allowDefsRef) {
    return { ...cachedJs };
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
  // The description is MODEL-FACING, so it must not point at a `$defs` entry
  // this dialect never emits — under `allowDefsRef: false` there is no `$defs`
  // section at all, and telling the model to look at one is a lie about the
  // document it was handed. Name the recursion instead.
  const description = descriptor.allowDefsRef
    ? `Would recursively reference #/$defs/${refId}`
    : `Recursive reference to '${refId}' — repeat this shape here`;
  return { ...placeholder, description };
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
 * The values a `z.enum` actually EMITS as JSON-Schema `enum` members.
 *
 * A numeric TypeScript enum compiles to a two-way map (`{A: 0, 0: 'A'}`), so
 * the reverse-mapping keys have to be dropped or every value appears twice.
 * Shared with `analyzeSchema` deliberately: the size budget counts what goes on
 * the wire, and "what goes on the wire" must have ONE definition (a second
 * copy of this filter would drift from the emitter it is supposed to measure).
 */
function enumEmittedValues(schema: z.ZodEnum): unknown[] {
  const numericValues = Object.values(schema.def.entries).filter((v) => typeof v === 'number');
  return Object.entries(schema.def.entries)
    .filter(([k]) => numericValues.indexOf(+k) === -1)
    .map(([, v]) => v);
}

/**
 * The values a `z.literal` emits — one for the `const` form, several for the
 * multi-value form that emits `enum`. Types JSON Schema cannot carry
 * (functions, symbols, bigints, `undefined`) are dropped, matching the
 * emitter. Shared with `analyzeSchema` for the same reason as above.
 */
function literalEmittedValues(schema: z.ZodLiteral): unknown[] {
  return Array.from(schema.values).filter(
    (v) => v !== undefined && typeof v !== 'function' && typeof v !== 'symbol' && typeof v !== 'bigint',
  );
}

/**
 * Decide whether a set of values may be emitted as a JSON-Schema `enum` under
 * this descriptor, per `maxEnumValues`.
 *
 * Under the cap (or with no cap declared) the caller emits its `enum` as
 * normal. Over it, the caller emits NO `enum` — just the widened `type` — and
 * attaches `note`, which lists EVERY value in prose.
 *
 * Widening rather than truncating is the deliberate choice, and the two differ
 * in what the model can still say. A truncated `enum` makes the values past the
 * cap **unreachable**: the wire schema constrains them away, so a caller whose
 * 96 values are all legitimately selectable loses 56 of them. Widening removes
 * the wire-level constraint that the dialect can't compile in the first place
 * and moves the full list into the `description`, so the model retains complete
 * information and can name any of the 96. Nothing is hidden — it is described
 * instead of enforced, and enforcement moves to whatever validates the value
 * afterwards (`Tool.parse` against the ORIGINAL zod schema still rejects a name
 * that was never in the enum, with a message the model can act on).
 *
 * The note is deliberately DOMAIN-NEUTRAL. This library has no idea what the
 * values mean; whichever caller relies on the cap (a session's known-name enum,
 * a country list, anything) reads its own semantics into them.
 */
function describeOversizeEnum(values: readonly unknown[], descriptor: FormatDescriptor): string | undefined {
  const cap = descriptor.maxEnumValues;
  if (cap === undefined || values.length <= cap) return undefined;
  // A flat comma-separated list: it is how an enum reads in prose anyway, and
  // the values are single tokens by construction (they were `enum` members).
  return `One of these ${values.length} values: ${values.map((v) => String(v)).join(', ')}`;
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
    const values = enumEmittedValues(schema);
    // Over the dialect's cap the `enum` keyword is DROPPED and the node widens
    // to its plain scalar type, with every value listed in the description —
    // see `describeOversizeEnum` for why widening beats truncating.
    const oversize = describeOversizeEnum(values, descriptor);
    return {
      type: values.every((v) => typeof v === 'number')
        ? 'number'
        : values.every((v) => typeof v === 'string')
          ? 'string'
          : undefined,
      ...(oversize === undefined ? { enum: values } : { description: oversize }),
    };
  }

  // Handle ZodLiteral
  if (schema instanceof z.ZodLiteral) {
    const values = literalEmittedValues(schema);
    const types = Array.from(new Set(values.map(v => v === null ? 'null' : typeof v) as ('string' | 'number' | 'boolean' | 'null')[]));
    // A multi-value literal emits the SAME `enum` keyword as ZodEnum, so the
    // dialect cap applies identically — the provider sees no difference. The
    // single-value form emits `const`, which no cap can be exceeded by.
    const oversize = values.length === 1 ? undefined : describeOversizeEnum(values, descriptor);

    return {
      ...(types.length === 1 ? { type: types[0] } : {}),
      ...(values.length === 1
        ? { const: values[0] }
        : oversize === undefined ? { enum: values } : { description: oversize }),
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
    // (e.g. Anthropic, which rejects recursive `$defs` graphs) or `unconstrained`
    // (Google, which rejects both `anyOf` and named `$defs`), inline the
    // permissive shape directly so the schema stays acyclic and `$defs`-free.
    if (!usesSharedAnyDefinition(descriptor)) {
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
 * True when the descriptor's "any" encoding is a self-referencing definition,
 * i.e. it has to be hoisted into `$defs/Any` and referenced by `$ref`. The
 * non-recursive encodings (`flat`, `unconstrained`) are inlined at each use
 * site instead, so no `$defs` entry is ever created for them.
 */
function usesSharedAnyDefinition(descriptor: FormatDescriptor): boolean {
  return descriptor.anyEncoding === 'recursive-strict'
    || descriptor.anyEncoding === 'recursive-open';
}

/**
 * Builds the body of the "any value" schema — for most dialects an `anyOf`
 * covering every JSON value (string, number, boolean, null, array, object).
 *
 * Encoding modes:
 * - `recursive-strict` (OpenAI strict): self-referencing `$defs/Any` with
 *   array-of-pairs records (no open-object support in strict mode).
 * - `recursive-open` (Lenient): self-referencing `$defs/Any` with
 *   `additionalProperties: <self>` records.
 * - `flat` (Anthropic strict): non-recursive — array branch has no `items`
 *   constraint, object branch is `additionalProperties: true`. Equivalent
 *   to TypeScript `any`; safe under descriptors that reject cyclic `$defs`.
 * - `unconstrained` (Google): the empty schema `{}`. A schema with no
 *   assertion keywords validates every instance, so this says "any JSON
 *   value" using zero keywords — the only option for a dialect that forbids
 *   `anyOf` AND named `$defs`/`$ref`. The caller re-attaches `description`
 *   from the source schema's metadata, so the model still gets the prose.
 */
function buildAnyValueSchema(descriptor: FormatDescriptor): JSONSchema {
  if (descriptor.anyEncoding === 'unconstrained') {
    return {};
  }
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
 * One emitted `enum` node's contribution to a dialect's size limits. A dialect
 * bounds the TOTAL number of enum values in a schema and, separately, the
 * character length of a SINGLE large enum — so the per-enum breakdown has to
 * survive the walk; a pair of totals cannot answer the second question
 * (two enums, one long-valued and one many-valued, would answer it wrongly).
 */
export interface EnumFeature {
  /** How many members the enum emits. */
  readonly valueCount: number;
  /**
   * Total character length of its STRING members. Non-string members
   * contribute nothing: the character rules are written for string values.
   */
  readonly stringValueChars: number;
}

/**
 * Structural feature counts for a Zod schema, used by the SchemaBudget to
 * decide whether an item fits a descriptor's per-request budget, whether it
 * fits the dialect's per-schema size limits, and whether the descriptor can
 * express it at all.
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

  // ---- Size, for `FormatDescriptor.schemaSizeLimits` ----
  /** One entry per emitted `enum` node, in walk order. */
  enums: readonly EnumFeature[];
  /**
   * Object properties the schema emits, summed over every nesting level. A
   * record counts as the 2 properties its widest encoding emits
   * (`{key, value}` pairs) and a tuple as one per item (numeric-key
   * encoding) — the count is descriptor-independent, so it takes the largest
   * encoding any dialect could choose (see `schemaSizeLimits`).
   */
  objectPropertyCount: number;
  /** Deepest container nesting below the root (an object of scalars is 1). */
  maxNestingDepth: number;
  /**
   * Total characters over property names plus `enum` and `const` string
   * values — the "total string size" a dialect bounds. `$defs` entry names are
   * NOT included: they are generated at emit time, are few, and are short
   * relative to a 120,000-character budget.
   */
  stringSizeChars: number;
}

const ZERO_FEATURES: SchemaFeatures = Object.freeze({
  hasRecursion: false,
  optionalParameterCount: 0,
  unionTypeCount: 0,
  recordCount: 0,
  tupleCount: 0,
  enums: Object.freeze([]),
  objectPropertyCount: 0,
  maxNestingDepth: 0,
  stringSizeChars: 0,
});

const featuresCache = new WeakMap<z.ZodType | z.core.$ZodType, SchemaFeatures>();

/**
 * Walk a Zod schema once and count its structural features. Result is
 * cached per schema in a WeakMap — second-and-subsequent calls are O(1) and
 * the entry is GC'd with the schema (same OOM-safe pattern as `strictify`).
 *
 * The walk is EAGER (it has to descend to count), so its cycle guard keys on
 * `walkKey`, not on object identity: a `z.lazy` that rebuilds its inner schema
 * per call would otherwise never re-enter the same object and the walk would
 * never terminate. That is not hypothetical — it is a measured, reproducible
 * heap-death, and this function is on the hot path of EVERY tool of EVERY
 * request to a strict-family model (`SchemaBudget.allocate`).
 */
export function analyzeSchema(schema: z.ZodType | z.core.$ZodType): SchemaFeatures {
  const cached = featuresCache.get(schema);
  if (cached) return cached;

  const visiting = new Set<z.ZodType | z.core.$ZodType | string>();
  const features: SchemaFeatures = { ...ZERO_FEATURES };
  // Collected mutably and frozen onto `features` at the end — `ZERO_FEATURES`
  // is a frozen singleton, so spreading it must not hand out its array.
  const enums: EnumFeature[] = [];

  /** Total characters of the string members of an emitted enum/const value set. */
  const stringChars = (values: readonly unknown[]): number =>
    values.reduce<number>((n, v) => n + (typeof v === 'string' ? v.length : 0), 0);

  /** Record the deepest container nesting reached. `depth` is the level of `s` itself. */
  const noteDepth = (depth: number): void => {
    if (depth > features.maxNestingDepth) features.maxNestingDepth = depth;
  };

  // `depth` counts CONTAINERS entered (an object of scalars is depth 1). Wrapper
  // nodes — optional, nullable, default, lazy, union arms — are transparent on
  // the wire and pass their own depth through, so `{a?: {b: string}}` is 2, the
  // same as `{a: {b: string}}`.
  function walk(s: z.ZodType | z.core.$ZodType | undefined | null, depth: number): void {
    if (!s) return;
    const key = walkKey(s);
    if (visiting.has(key)) return;
    visiting.add(key);
    try {
      // Recursion is detected via z.lazy: peek at the inner schema (but only
      // once — the visiting set bounds the walk).
      if (s instanceof z.ZodLazy) {
        features.hasRecursion = true;
        try {
          walk(s.def.getter(), depth);
        } catch { /* lazy getter may throw at analyze time; ignore */ }
        return;
      }

      if (s instanceof z.ZodOptional) {
        features.optionalParameterCount += 1;
        walk(s.unwrap(), depth);
        return;
      }

      if (s instanceof z.ZodNullable) {
        features.unionTypeCount += 1; // T|null counts as a union on the wire
        walk(s.unwrap(), depth);
        return;
      }

      if (s instanceof z.ZodUnion || s instanceof z.ZodDiscriminatedUnion) {
        features.unionTypeCount += 1;
        for (const opt of (s as z.ZodUnion).options) walk(opt, depth);
        return;
      }

      if (s instanceof z.ZodIntersection) {
        walk(s.def.left, depth);
        walk(s.def.right, depth);
        return;
      }

      if (s instanceof z.ZodObject) {
        noteDepth(depth + 1);
        for (const key in s.shape) {
          features.objectPropertyCount += 1;
          features.stringSizeChars += key.length;
          walk(s.shape[key], depth + 1);
        }
        if (s.def.catchall) walk(s.def.catchall, depth + 1);
        return;
      }

      if (s instanceof z.ZodArray) {
        noteDepth(depth + 1);
        walk(s.element, depth + 1);
        return;
      }

      if (s instanceof z.ZodRecord) {
        features.recordCount += 1;
        // Widest encoding wins (see `SchemaFeatures.objectPropertyCount`): the
        // array-of-pairs form is an array of `{key, value}` objects, so two
        // properties, two property names, and two levels of container.
        features.objectPropertyCount += 2;
        features.stringSizeChars += 'key'.length + 'value'.length;
        noteDepth(depth + 2);
        if (s.keyType) walk(s.keyType, depth + 2);
        walk(s.valueType, depth + 2);
        return;
      }

      if (s instanceof z.ZodTuple) {
        features.tupleCount += 1;
        // The numeric-key object encoding emits one property per item, named
        // "0", "1", … — one character each until there are ten of them, which
        // is close enough for a 120,000-character budget.
        features.objectPropertyCount += s.def.items.length;
        features.stringSizeChars += s.def.items.length;
        noteDepth(depth + 1);
        for (const item of s.def.items) walk(item, depth + 1);
        if (s.def.rest) walk(s.def.rest, depth + 1);
        return;
      }

      if (s instanceof z.ZodDefault) {
        walk(s.def.innerType, depth);
        return;
      }

      if (s instanceof z.ZodCodec || s instanceof z.ZodPipe) {
        walk(s.def.in, depth);
        walk(s.def.out, depth);
        return;
      }

      if (s instanceof z.ZodEnum) {
        const values = enumEmittedValues(s);
        const chars = stringChars(values);
        enums.push({ valueCount: values.length, stringValueChars: chars });
        features.stringSizeChars += chars;
        return;
      }

      if (s instanceof z.ZodLiteral) {
        const values = literalEmittedValues(s);
        const chars = stringChars(values);
        // One value emits `const`, several emit `enum` — only the latter is an
        // enum for the purpose of a dialect's enum-value budget, but both count
        // toward the total string size.
        if (values.length > 1) enums.push({ valueCount: values.length, stringValueChars: chars });
        features.stringSizeChars += chars;
        return;
      }

      // Primitives and unknown leaves contribute nothing.
    } finally {
      visiting.delete(key);
    }
  }

  walk(schema, 0);
  features.enums = Object.freeze(enums);
  Object.freeze(features);
  featuresCache.set(schema, features);
  return features;
}

/** Shared empty result, so the common "dialect publishes no size limits" path allocates nothing. */
const NO_SIZE_PROBLEMS: readonly string[] = Object.freeze([]);

/**
 * Report the ways ONE schema exceeds the descriptor's documented per-schema
 * size limits (`FormatDescriptor.schemaSizeLimits`). Empty means it fits, or
 * that the dialect publishes no limits.
 *
 * This is a FEASIBILITY question, not a budget one: the numbers bound a single
 * schema, so no other tool in the request can change the answer, and
 * `SchemaBudget.allocate` therefore treats a hit exactly like an
 * unrepresentable keyword — that item degrades to the family's non-strict
 * descriptor and the rest of the request is untouched.
 *
 * Exported because "why did my tool silently stop being strict?" needs an
 * answer a caller can print; each line names the bound and the measurement.
 *
 * @example
 * ```ts
 * checkSchemaSizeLimits(z.object({ pick: z.enum(tenThousandNames) }), OPENAI_STRICT);
 * //  → ['enum values 10000 exceed maxTotalEnumValues 1000']
 * ```
 */
export function checkSchemaSizeLimits(
  schema: z.ZodType | z.core.$ZodType,
  descriptor: FormatDescriptor,
): readonly string[] {
  const limits = descriptor.schemaSizeLimits;
  if (limits === undefined) return NO_SIZE_PROBLEMS;

  const features = analyzeSchema(schema);
  const problems: string[] = [];

  if (features.objectPropertyCount > limits.maxObjectProperties) {
    problems.push(`object properties ${features.objectPropertyCount} exceed maxObjectProperties ${limits.maxObjectProperties}`);
  }
  if (features.maxNestingDepth > limits.maxNestingDepth) {
    problems.push(`nesting depth ${features.maxNestingDepth} exceeds maxNestingDepth ${limits.maxNestingDepth}`);
  }
  if (features.stringSizeChars > limits.maxTotalStringChars) {
    problems.push(`total string characters ${features.stringSizeChars} exceed maxTotalStringChars ${limits.maxTotalStringChars}`);
  }
  const totalEnumValues = features.enums.reduce((n, e) => n + e.valueCount, 0);
  if (totalEnumValues > limits.maxTotalEnumValues) {
    problems.push(`enum values ${totalEnumValues} exceed maxTotalEnumValues ${limits.maxTotalEnumValues}`);
  }
  // The large-enum character rule is per-enum and conditional on that SAME
  // enum's value count, which is why the walk keeps the breakdown instead of
  // two totals.
  for (const e of features.enums) {
    if (e.valueCount > limits.largeEnumValueCount && e.stringValueChars > limits.maxLargeEnumStringChars) {
      problems.push(
        `an enum of ${e.valueCount} values (over largeEnumValueCount ${limits.largeEnumValueCount}) spends ` +
          `${e.stringValueChars} characters, over maxLargeEnumStringChars ${limits.maxLargeEnumStringChars}`,
      );
    }
  }
  return problems;
}

/**
 * Per-request strict-mode allocator.
 *
 * Constructed once per outgoing request with the chosen model's strictest
 * descriptor. Tracks remaining slots (strict tools, optional parameters,
 * union types) against the descriptor's documented per-request limits and
 * decides per-tool / per-output whether to emit strict or fall back to the
 * SAME FAMILY's non-strict descriptor (`degraded` — never the family-blind
 * `LENIENT`, which would undo dialect rules that outlive strict mode).
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
  /**
   * What an item that does NOT get strict is emitted through: the descriptor's
   * own family, non-strict.
   *
   * It is deliberately NOT the family-blind `LENIENT`. A dialect restriction
   * can belong to the DIALECT rather than to strict mode — `GOOGLE_NON_STRICT`
   * exists for exactly one such rule, the `unconstrained` encoding of
   * `z.any()`, because Gemini builds a decoding grammar whenever a tool call is
   * forced, with no per-tool strict flag involved. Degrading to `LENIENT` put
   * the self-referencing `$defs/Any` that encoding was created to avoid back on
   * the Google wire — and it did so for every gin/query-style recursive `anyOf`
   * schema, i.e. the schemas that ALWAYS degrade, since `GOOGLE_STRICT` cannot
   * express `anyOf` at all (measured: the product's real `api_set` tool schema
   * allocates to `lenient` under `GOOGLE_STRICT`, and its emitted JSON carries
   * nine `#/$defs/Any` references).
   *
   * For the other families this is behaviour-neutral by construction:
   * `OPENAI_NON_STRICT` and `ANTHROPIC_NON_STRICT` are `LENIENT` with a family
   * tag, and a family with no registered non-strict variant resolves to
   * `LENIENT` (`getDescriptor`). Only the pinned `descriptor` id on the tool
   * changes, which round-trips through `getDescriptorById`.
   */
  private readonly degraded: FormatDescriptor;
  private remainingTools: number;
  private remainingOptionalParams: number;
  private remainingUnionTypes: number;

  constructor(descriptor: FormatDescriptor) {
    this.descriptor = descriptor;
    // An already-non-strict budget degrades to itself: there is nothing looser
    // in its family, and `LENIENT`'s own family has no other variant.
    this.degraded = descriptor.strict ? getDescriptor(descriptor.family, false) : descriptor;
    this.remainingTools = descriptor.maxStrictTools ?? Infinity;
    this.remainingOptionalParams = descriptor.maxStrictOptionalParams ?? Infinity;
    this.remainingUnionTypes = descriptor.maxStrictUnionTypes ?? Infinity;
  }

  /**
   * Decide the effective descriptor for a tool's parameter schema given the
   * dev's strict request, the schema's features, and the remaining budget.
   *
   * Returns the family's NON-STRICT descriptor (`LENIENT` for a family that
   * registers none) when:
   * - `requested === false`
   * - the schema uses a feature the descriptor can't represent
   * - the schema exceeds the dialect's per-schema size limits
   *   (`checkSchemaSizeLimits`)
   * - the descriptor has slot limits and the budget is exhausted (only
   *   applies to `requested` being a positive number; `true` always wins
   *   subject to feasibility and size)
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
    // strict: false → always non-strict, no budget movement.
    if (requested === false) return this.degraded;
    // Descriptor itself is lenient → nothing to allocate.
    if (!this.descriptor.strict) return this.degraded;

    const isHardRequired = requested === true;
    const isPreferredNumeric = typeof requested === 'number' && requested > 0;

    if (!isHardRequired && !isPreferredNumeric) {
      // requested is undefined or 0 — treat as no preference; default to
      // non-strict so callers explicitly opt into strict. Decided BEFORE any
      // walk of `schema`: analysing a schema whose verdict is already
      // non-strict is pure waste on the hot path of every tool of every request.
      return this.degraded;
    }

    // FEASIBILITY, before budget — the second clause of this method's contract,
    // and the one that was documented but never implemented. Emitting a strict
    // schema carrying a combinator the descriptor forbids is a guaranteed
    // provider 400, not a degradation: `GOOGLE_STRICT` forbids `anyOf`, and the
    // recursive union a gin/query codegen layer produces is nothing but.
    // Degrading to the family's non-strict descriptor is the documented answer
    // for a TOOL (unlike a structured OUTPUT, a tool schema has no prompt-text
    // delivery to fall back to — `applySchemaDeliveryFallback` covers
    // `responseFormat` only), and it is also what keeps the API-level
    // `strict: true` flag off the wire, since providers set it from
    // `descriptor.strict`.
    //
    // `sendableUnder`, not `canExpress`: a cycle is always sendable (the
    // emitter's bounded placeholder), only looser — see that function's note on
    // why the two questions are different.
    if (!sendableUnder(schema, this.descriptor)) return this.degraded;

    // SIZE, still before budget and still regardless of priority: these bounds
    // are per-SCHEMA (see `checkSchemaSizeLimits`), so no other item in the
    // request can make this one fit, and a hard `strict: true` cannot force a
    // schema the API will refuse to compile.
    if (checkSchemaSizeLimits(schema, this.descriptor).length > 0) return this.degraded;

    const features = analyzeSchema(schema);

    // Soft-priority items must fit the budget. Hard-required items skip
    // budget checks because selection already promised the model can take
    // them — if there are too many, that's a request-construction bug we
    // surface via API error rather than degrading silently.
    if (isPreferredNumeric) {
      if (isTool && this.remainingTools <= 0) return this.degraded;
      if (this.remainingOptionalParams - features.optionalParameterCount < 0) return this.degraded;
      if (this.remainingUnionTypes - features.unionTypeCount < 0) return this.degraded;
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
 *
 * `schemaSizeLimits` deliberately does NOT participate. Those bounds are
 * per-schema, so they are evaluated against whichever descriptor this returns
 * rather than shared between the two — and every provider here passes two
 * descriptors resolved from the SAME family, so there is nothing to break the
 * tie on. Ranking six size bounds against three slot budgets would be an
 * invented ordering, not a documented one.
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
