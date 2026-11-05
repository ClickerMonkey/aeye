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
export type DescriptorFamily = 'openai' | 'anthropic' | 'google' | 'xai' | (string & {});

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
  /** Whitelist of `format:` values to emit, or `'all'` for every format JSON Schema defines. */
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

  /**
   * True when the family's structured output is always compiled to a grammar,
   * so there is no non-strict `json_schema` to degrade an output to. Anthropic:
   * `output_config.format` is strict by definition, and OpenRouter adds the
   * structured-outputs flag to every `json_schema` bound for Claude — a
   * "non-strict" output with 30 optional fields still earns "Schemas contains
   * too many optional parameters (30) … (limit: 24)" (measured 2026-11-04).
   *
   * A schema over the strict limits then cannot go out as structured output at
   * all: `canExpress` answers `false`, so it is delivered as prompt text, and
   * `SchemaBudget` never degrades an output to the non-strict variant.
   */
  readonly structuredOutputAlwaysStrict?: boolean;

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
