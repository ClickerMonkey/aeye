/**
 * Profiles: what one model can read, for one kind of schema (tool arguments
 * or structured output), strict or not.
 *
 * A profile is the successor of core's `FormatDescriptor`: the same facts,
 * fewer knobs, and every field is read by exactly one place in rendering.
 * Rendering, decoding, validation, error paths, examples, descriptions and
 * the request budget ALL read the same profile, so they can never disagree
 * about the shape the model sees.
 *
 * The built-in table below is sourced from each provider's own docs (the
 * short keys, e.g. [OAI-SO], are the URLs in `docs/plans/schema-dialects-2026.md`,
 * read 2026-11-04) and from what aeye's providers measured live
 * (`packages/core/src/schema/dialects/*`, `packages/test-integration`
 * live-schema run 2026-11-04/05). Pick one with `profileFor(model)`, which
 * reads the model's `@aeye/models` capabilities; never hard-code a profile
 * at a call site.
 *
 * "Strict models see pairs" is NOT a rule of strictness. A record is written
 * as `[{key, value}]` only where the dialect forbids a schema-valued
 * `additionalProperties`: OpenAI strict and Anthropic strict (both require
 * `additionalProperties: false` [OAI-SO, ANT-SO]) and Gemini's OpenAPI
 * subset (no `additionalProperties` at all [GEM-REF]). xAI strict and
 * Gemini's JSON Schema mode are strict and still take open records
 * [XAI-SO, GEM-SO], so their models see plain objects.
 */

// ============================================================================
// Shape of a profile
// ============================================================================

/** Provider family of a profile. Any string is allowed for custom profiles. */
export type ProfileFamily = 'lenient' | 'people' | 'openai' | 'anthropic' | 'google' | 'xai' | 'ollama' | (string & {});

/** Which constraint keywords the dialect accepts. Anything it lacks is said in words and still validated. */
export interface ConstraintSupport {
  /** `minLength` / `maxLength`. */
  readonly length: boolean;
  /** `minimum` / `maximum`. */
  readonly range: boolean;
  /** `minItems` / `maxItems`: all, only `minItems` of 0 or 1 (Anthropic), or none. */
  readonly items: 'all' | 'min-0-1' | 'none';
  /**
   * `pattern`: any regex (`full`), the common subset only (`basic`: no
   * lookaround, backreferences, `\b`, `\p{…}` or large `{n,m}`), or none.
   * A pattern outside the subset is said in words.
   */
  readonly pattern: 'full' | 'basic' | 'none';
}

/**
 * Documented ceilings on the SIZE of one schema. Used per schema
 * (`Profile.limits`) and, where a provider sums them over the whole request,
 * as request totals (`RequestLimits.totals`).
 */
export interface SchemaLimits {
  /** Object properties, summed over every level (a pairs record counts its `key` and `value`). */
  readonly maxProperties?: number;
  /** Levels of nested objects/arrays below the root. */
  readonly maxDepth?: number;
  /** Characters over property names, `$defs` names, enum values and const values. */
  readonly maxStringChars?: number;
  /** Enum values summed over every enum. */
  readonly maxEnumValues?: number;
  /** An enum with more values than this is a "large enum"... */
  readonly largeEnumValues?: number;
  /** ...whose string values may total at most this many characters. */
  readonly maxLargeEnumChars?: number;
  /** Optional properties (not in `required`), summed. */
  readonly maxOptional?: number;
  /** Schema nodes with a union type (`anyOf`, or a `type` array), summed. */
  readonly maxUnions?: number;
}

/** Limits a provider applies to a whole request, across every schema in it. */
export interface RequestLimits {
  /** Tools in one request, strict or not. */
  readonly maxTools?: number;
  /** Tools sent with `strict: true`. */
  readonly maxStrictTools?: number;
  /** Totals over every STRICT schema in the request (tools and the output). */
  readonly totals?: SchemaLimits;
}

export interface Profile {
  /** Stable id; the memo key for rendered schemas. */
  readonly id: string;
  readonly family: ProfileFamily;
  /** The schema is compiled into a grammar (sent with `strict: true` / as strict structured output). */
  readonly strict: boolean;
  /**
   * How an optional object field is written.
   * - `omit`: it may be left out (`required` lists the required ones).
   * - `null`: every field is required and an absent value is written `null`
   *   (OpenAI strict: "every property must be listed" [OAI-SO]). Decoding
   *   turns that `null` back into an ABSENT key.
   */
  readonly optional: 'omit' | 'null';
  /** Emit `additionalProperties: false` on every object. */
  readonly closedObjects: boolean;
  /**
   * How `a.record(V)` is written: an open object
   * (`additionalProperties: V`) or `[{key, value}]` pairs, for dialects that
   * forbid a schema-valued `additionalProperties`.
   */
  readonly records: 'open' | 'pairs';
  /**
   * How `a.tuple([...])` is written: `prefixItems`; `object` (`{"0": A, "1": B}`,
   * OpenAI strict has no `prefixItems`); or `array` (`items: anyOf`, positions
   * checked on decode).
   */
  readonly tuples: 'prefixItems' | 'object' | 'array';
  /** `anyOf`, or `tagged` (one nullable field per option) for dialects with no combinators. */
  readonly unions: 'anyOf' | 'tagged';
  /**
   * How `T | null` is spelled: a `type` array (`["string","null"]`), `anyOf`
   * with `{type:"null"}` (o3 rejects type arrays in strict tools, measured
   * 2026-11-04), or OpenAPI's `nullable: true` (Gemini `responseSchema`).
   */
  readonly nulls: 'type-array' | 'anyOf' | 'nullable';
  /** `allOf` is accepted. Without it an intersection of objects is merged; anything else is said in words. */
  readonly allOf: boolean;
  /** `not` and `if`/`then`/`else` are accepted. Without them they are said in words (and always validated). */
  readonly conditionals: boolean;
  /** `patternProperties` is accepted. */
  readonly patternProperties: boolean;
  /** Named types may go to `$defs` and be used by `$ref`. Off → inlined. */
  readonly defs: boolean;
  /**
   * Whether a `$ref` may carry a description, title or examples beside it. `false` (OpenAI strict: "$ref cannot have
   * keywords {'description'}", which fails the whole request) → the ref is wrapped, `{ anyOf: [{ $ref }], description }`,
   * so the field keeps its words. Unset means allowed.
   */
  readonly refSiblings?: boolean;
  /**
   * Whether a `$ref` may point back into itself:
   * - `true`: anywhere;
   * - `'guarded'`: only through an optional or nullable field, or an array
   *   or record that may be empty (Gemini: "avoid recursing through required
   *   properties or arrays with minItems greater than zero" [GEM-SO, GEM-FC]);
   * - `false`: never.
   * A back-edge the dialect can't take becomes JSON text (the escape hatch).
   */
  readonly recursion: boolean | 'guarded';
  /**
   * How "any JSON value" (`a.unknown()` / `a.json()`) is written: the empty
   * schema `{}`; a flat `anyOf` of the JSON types (xAI, which rejects
   * recursive `$defs`); or a string of JSON text, parsed on decode.
   */
  readonly any: 'empty' | 'flat' | 'json-text';
  /** Constraint keywords the dialect accepts. */
  readonly constraints: ConstraintSupport;
  /** String `format` values the dialect accepts, or `'all'`. Others are said in words. */
  readonly formats: 'all' | ReadonlySet<string>;
  /** Where examples go: the `examples` keyword, the description text, or nowhere. */
  readonly examples: 'keyword' | 'description' | 'none';
  /** Emit `propertyOrdering` on objects (Gemini `responseSchema` orders keys alphabetically without it [VTX]). */
  readonly propertyOrdering: boolean;
  /** An enum with more values than this is widened to a string listing them (still validated). */
  readonly maxEnumValues?: number;
  /** Nesting deeper than this is written as JSON text (the escape hatch). */
  readonly maxDepth?: number;
  /**
   * The root must be a plain object (tool parameters everywhere; OpenAI
   * structured output: "root must be `type: object`, not `anyOf`" [OAI-SO]).
   * Any other root is wrapped as `{ input: … }` and unwrapped on decode.
   */
  readonly rootObject: boolean;
  /** Size limits of ONE schema under this profile. */
  readonly limits?: SchemaLimits;
  /** Limits across the whole request (see `ModelProfile.request`). */
  readonly request?: RequestLimits;
  /** The same family, not strict: what an item that can't be strict is rendered with. */
  readonly loose?: Profile;
  /** Structured output is always compiled (no non-strict output to fall back to): an unfitting output goes as prompt text. */
  readonly alwaysStrictOutput?: boolean;
  /** Appended after a schema delivered as prompt text. */
  readonly jsonInstruction?: string;
  /**
   * Who reads the schema. `'model'` (default): `forPeople()` fields are left
   * out and `forModels(...)` variants are used. `'people'` renders the full
   * code shape (web forms, API docs, validating a person's input).
   */
  readonly audience?: 'model' | 'people';
}

export const DEFAULT_JSON_INSTRUCTION =
  'Return ONLY a single raw JSON object conforming to the schema above: no markdown code fences, no prose, and do NOT echo the schema itself.';

const ALL_CONSTRAINTS: ConstraintSupport = Object.freeze({ length: true, range: true, items: 'all', pattern: 'full' });
const NO_CONSTRAINTS: ConstraintSupport = Object.freeze({ length: false, range: false, items: 'none', pattern: 'none' });

// ============================================================================
// Built-ins
// ============================================================================

/** No rewrites: the code shape as it is. Also the shape of JSON text inside an escape hatch. */
export const LENIENT: Profile = Object.freeze({
  id: 'lenient',
  family: 'lenient',
  strict: false,
  optional: 'omit',
  closedObjects: false,
  records: 'open',
  tuples: 'prefixItems',
  unions: 'anyOf',
  nulls: 'type-array',
  allOf: true,
  conditionals: true,
  patternProperties: true,
  defs: true,
  recursion: true,
  any: 'empty',
  constraints: ALL_CONSTRAINTS,
  formats: 'all',
  examples: 'keyword',
  propertyOrdering: false,
  rootObject: false,
});

/** The full code shape, for people: every field, no rewrites. */
export const PEOPLE: Profile = Object.freeze({ ...LENIENT, id: 'people', family: 'people', audience: 'people' });

// ---- OpenAI ------------------------------------------------------------------

/** OpenAI non-strict tools / `json_schema` with `strict: false`: any JSON Schema, best effort [OAI-FC]. */
export const OPENAI_NON_STRICT: Profile = Object.freeze({
  ...LENIENT,
  id: 'openai',
  family: 'openai',
  rootObject: true,
  // Chat Completions `tools`: "A max of 128 functions are supported" (API reference).
  request: Object.freeze({ maxTools: 128 }),
});

const OPENAI_FORMATS = new Set(['date-time', 'time', 'date', 'duration', 'email', 'hostname', 'ipv4', 'ipv6', 'uuid']);

/**
 * OpenAI Structured Outputs (strict tools and strict `json_schema`) [OAI-SO, OAI-FC]:
 * every property required (optional → null), `additionalProperties: false`
 * everywhere (so records are pairs), no `prefixItems` (tuples are numeric-key
 * objects), `anyOf` but no `allOf`/`oneOf`/`not`/`if`, `$defs` and recursion,
 * formats below, `pattern`, numeric and array bounds. `minLength`/`maxLength`
 * are listed as unsupported only for fine-tuned models and were honoured by
 * gpt-5.4-mini (2026-10-30). Nullable is spelled `anyOf` (o3 rejects type
 * arrays, 2026-11-04). The size limits are PER SCHEMA ("A schema may have up
 * to 5000 object properties total, with up to 10 levels of nesting", 120,000
 * characters, 1,000 enum values, 15,000 characters for a >250-value enum;
 * raised July 2025 — the older 100/15,000/500/7,500 figures are stale). No
 * per-request strict budget is documented.
 */
export const OPENAI_STRICT: Profile = Object.freeze({
  id: 'openai-strict',
  family: 'openai',
  strict: true,
  optional: 'null',
  closedObjects: true,
  records: 'pairs',
  tuples: 'object',
  unions: 'anyOf',
  nulls: 'anyOf',
  allOf: false,
  conditionals: false,
  patternProperties: false,
  defs: true,
  refSiblings: false,
  recursion: true,
  // OpenAI's own "any" would be a recursive $defs/Any with pairs, which can't
  // be told apart from a real list of {key, value}; JSON text is exact.
  any: 'json-text',
  constraints: Object.freeze({ length: true, range: true, items: 'all', pattern: 'basic' }),
  formats: OPENAI_FORMATS,
  examples: 'description',
  propertyOrdering: false,
  maxDepth: 10,
  rootObject: true,
  limits: Object.freeze({
    maxProperties: 5000,
    maxDepth: 10,
    maxStringChars: 120_000,
    maxEnumValues: 1000,
    largeEnumValues: 250,
    maxLargeEnumChars: 15_000,
  }),
  request: Object.freeze({ maxTools: 128 }),
  loose: OPENAI_NON_STRICT,
});

/**
 * OpenAI fine-tuned models, strict: as `OPENAI_STRICT`, minus every keyword
 * fine-tuned models reject ("minLength, maxLength, pattern, format, minimum,
 * maximum, multipleOf, patternProperties, minItems, maxItems" [OAI-SO]).
 */
export const OPENAI_FINETUNED_STRICT: Profile = Object.freeze({
  ...OPENAI_STRICT,
  id: 'openai-finetuned-strict',
  constraints: NO_CONSTRAINTS,
  formats: new Set<string>(),
});

// ---- Anthropic ---------------------------------------------------------------

/** Anthropic non-strict tools: any JSON Schema, not grammar-enforced [ANT-SO]. Tool `input_schema` must be an object. */
export const ANTHROPIC_NON_STRICT: Profile = Object.freeze({
  ...LENIENT,
  id: 'anthropic',
  family: 'anthropic',
  rootObject: true,
});

/**
 * Anthropic strict tools and `output_config.format` (Claude 4.5 and later)
 * [ANT-SO]: `additionalProperties` may only be `false` (so records are
 * pairs, although optional fields may be omitted), `anyOf`, `allOf` (not with
 * `$ref`, so intersections are merged), non-circular `$defs` only (back-edges
 * become JSON text), no `prefixItems` (tuples are `items: anyOf`), no
 * length/range bounds, `minItems` only 0 or 1, the closed format list below,
 * the basic regex subset, and no spelling for "any" (`{}`, a typeless schema
 * and `additionalProperties: true` are all rejected, measured 2026-11-04) —
 * JSON text instead. Limits across EVERY strict schema in the request: 20
 * strict tools, 24 optional parameters, 16 parameters with union types
 * (`anyOf` or type arrays). Structured output is always compiled (OpenRouter
 * adds the beta header for every `json_schema` bound for Claude), so an
 * output that doesn't fit goes as prompt text.
 */
export const ANTHROPIC_STRICT: Profile = Object.freeze({
  id: 'anthropic-strict',
  family: 'anthropic',
  strict: true,
  optional: 'omit',
  closedObjects: true,
  records: 'pairs',
  tuples: 'array',
  unions: 'anyOf',
  nulls: 'type-array',
  allOf: false,
  conditionals: false,
  patternProperties: false,
  defs: true,
  recursion: false,
  any: 'json-text',
  constraints: Object.freeze({ length: false, range: false, items: 'min-0-1', pattern: 'basic' }),
  formats: new Set(['date-time', 'time', 'date', 'duration', 'email', 'hostname', 'uri', 'ipv4', 'ipv6', 'uuid']),
  examples: 'description',
  propertyOrdering: false,
  rootObject: true,
  request: Object.freeze({ maxStrictTools: 20, totals: Object.freeze({ maxOptional: 24, maxUnions: 16 }) }),
  loose: ANTHROPIC_NON_STRICT,
  alwaysStrictOutput: true,
});

// ---- Google Gemini -------------------------------------------------------------

const GEMINI_JSON_INSTRUCTION =
  'Return ONLY a single raw JSON object that conforms to the schema above. Do NOT wrap it in markdown code fences, do NOT add any prose before or after it, and do NOT echo the schema itself: emit only the JSON instance.';

/**
 * Gemini, no `VALIDATED` mode (`responseJsonSchema` / `parametersJsonSchema`):
 * permissive, but Gemini compiles a grammar whenever a call is forced, so the
 * dialect's own rules stay: the empty schema for "any" (a recursive
 * `$defs/Any` is rejected), guarded recursion, and the measured 40-value enum
 * cap (a real 98-name enum 400'd; 90 passed, 93 failed, 2026-08-23).
 */
export const GOOGLE_NON_STRICT: Profile = Object.freeze({
  ...LENIENT,
  id: 'google',
  family: 'google',
  recursion: 'guarded',
  maxEnumValues: 40,
  rootObject: true,
  jsonInstruction: GEMINI_JSON_INSTRUCTION,
});

/**
 * Gemini structured output / `VALIDATED` function calling with the JSON
 * Schema fields [GEM-SO, GEM-FC, GEM-BLOG]: types incl. type arrays,
 * `properties`/`required`/`additionalProperties` (open records are fine),
 * `enum`, formats date-time/date/time, `minimum`/`maximum`, `items`,
 * `prefixItems`, `minItems`/`maxItems`, `anyOf`, `$defs`/`$ref`, recursion
 * only through optional/nullable values. `minLength`/`maxLength` are silently
 * stripped and `pattern` is undocumented (a pattern tool timed out live), so
 * both are said in words. No published size numbers; the 40-value enum cap
 * is measured (see `GOOGLE_NON_STRICT`). No per-tool `strict` flag: strictness
 * is the request's `function_calling_config.mode: VALIDATED`.
 */
export const GOOGLE_STRICT: Profile = Object.freeze({
  id: 'google-strict',
  family: 'google',
  strict: true,
  optional: 'omit',
  closedObjects: false,
  records: 'open',
  tuples: 'prefixItems',
  unions: 'anyOf',
  nulls: 'type-array',
  allOf: false,
  conditionals: false,
  patternProperties: false,
  defs: true,
  recursion: 'guarded',
  any: 'empty',
  constraints: Object.freeze({ length: false, range: true, items: 'all', pattern: 'none' }),
  formats: new Set(['date-time', 'date', 'time']),
  examples: 'description',
  propertyOrdering: false,
  maxEnumValues: 40,
  rootObject: true,
  loose: GOOGLE_NON_STRICT,
  jsonInstruction: GEMINI_JSON_INSTRUCTION,
});

/**
 * Gemini's OpenAPI-subset `Schema` (`responseSchema` / `parameters`, also
 * Vertex) [GEM-REF, VTX]: `type` + `nullable: true`, `properties`,
 * `required`, `enum` (strings), `format`, `minimum`/`maximum`,
 * `minLength`/`maxLength`, `pattern`, `items`, `minItems`/`maxItems`,
 * `anyOf`, `propertyOrdering`. No `additionalProperties` (records are pairs),
 * no `$defs`/`$ref` (named types are inlined, recursion is JSON text), no
 * `prefixItems`, and no empty schema (any is JSON text).
 */
export const GOOGLE_OPENAPI: Profile = Object.freeze({
  id: 'google-openapi',
  family: 'google',
  strict: true,
  optional: 'omit',
  closedObjects: false,
  records: 'pairs',
  tuples: 'array',
  unions: 'anyOf',
  nulls: 'nullable',
  allOf: false,
  conditionals: false,
  patternProperties: false,
  defs: false,
  recursion: false,
  any: 'json-text',
  constraints: Object.freeze({ length: true, range: true, items: 'all', pattern: 'basic' }),
  formats: new Set(['date-time', 'date', 'time', 'duration']),
  examples: 'description',
  propertyOrdering: true,
  maxEnumValues: 40,
  maxDepth: 10,
  rootObject: true,
  loose: GOOGLE_NON_STRICT,
  jsonInstruction: GEMINI_JSON_INSTRUCTION,
});

// ---- xAI -----------------------------------------------------------------------

const XAI_FORMATS = new Set(['date', 'time', 'date-time', 'email', 'uuid', 'ipv4', 'ipv6', 'uri']);

/**
 * xAI Grok 4 [XAI-SO]: tool calls are ALWAYS strict ("the strict flag is
 * implicitly always true"). `anyOf` and `oneOf`, single-subschema `allOf`
 * only (so intersections are merged), non-circular `$defs` (back-edges are
 * JSON text), `prefixItems` (array-form `items` is a 400), formats below, the
 * basic regex subset, length/item/numeric bounds, and `additionalProperties`
 * defaulting to `false` — open records must say so and are accepted, so
 * records stay open objects. "Any" is the flat `anyOf` (recursive `$defs`
 * are rejected); empty `enum`/`anyOf` are 400s and never emitted.
 */
export const XAI_STRICT: Profile = Object.freeze({
  id: 'xai-strict',
  family: 'xai',
  strict: true,
  optional: 'omit',
  closedObjects: true,
  records: 'open',
  tuples: 'prefixItems',
  unions: 'anyOf',
  nulls: 'type-array',
  allOf: false,
  conditionals: false,
  patternProperties: false,
  defs: true,
  recursion: false,
  any: 'flat',
  constraints: Object.freeze({ length: true, range: true, items: 'all', pattern: 'basic' }),
  formats: XAI_FORMATS,
  examples: 'description',
  propertyOrdering: false,
  rootObject: true,
});

/** xAI structured output without `strict` (best effort): xAI's rules, not grammar-compiled. */
export const XAI_NON_STRICT: Profile = Object.freeze({ ...XAI_STRICT, id: 'xai', strict: false });

// ---- Ollama --------------------------------------------------------------------

/**
 * Ollama: `format` takes a JSON Schema that llama.cpp compiles to a grammar
 * (ollama.com/blog/structured-outputs; github.com/ollama/ollama docs/api.md
 * "format"), and tools are best effort. aeye's Ollama provider extends the
 * OpenAI one and resolves no strict family, so it is never sent `strict`
 * (packages/ollama). Local `$ref`s, recursion and the usual keywords are
 * understood, so it renders the code shape.
 */
export const OLLAMA: Profile = Object.freeze({ ...LENIENT, id: 'ollama', family: 'ollama', rootObject: true });

/**
 * A deliberately poor dialect: no combinators, no `$defs`, no recursion,
 * closed objects, shallow. Used by tests to prove that ANY schema still has a
 * faithful rendering when almost nothing is supported.
 */
export const MINIMAL: Profile = Object.freeze({
  id: 'minimal',
  family: 'minimal',
  strict: true,
  optional: 'null',
  closedObjects: true,
  records: 'pairs',
  tuples: 'object',
  unions: 'tagged',
  nulls: 'type-array',
  allOf: false,
  conditionals: false,
  patternProperties: false,
  defs: false,
  recursion: false,
  any: 'json-text',
  constraints: NO_CONSTRAINTS,
  formats: new Set<string>(),
  examples: 'description',
  propertyOrdering: false,
  maxDepth: 6,
  maxEnumValues: 8,
  rootObject: true,
});

// ============================================================================
// Registry and variants
// ============================================================================

const BY_ID = new Map<string, Profile>();
const BY_FAMILY = new Map<string, { strict?: Profile; loose?: Profile }>();

/**
 * Make a profile addressable by id and by `(family, strict)`. The built-ins
 * are registered at load; register your own for a new dialect.
 */
export function registerProfile(profile: Profile): void {
  BY_ID.set(profile.id, profile);
  const slot = BY_FAMILY.get(profile.family) ?? {};
  if (profile.strict) slot.strict ??= profile;
  else slot.loose ??= profile;
  BY_FAMILY.set(profile.family, slot);
}

for (const p of [
  LENIENT, PEOPLE, OPENAI_NON_STRICT, OPENAI_STRICT, OPENAI_FINETUNED_STRICT, ANTHROPIC_NON_STRICT, ANTHROPIC_STRICT,
  GOOGLE_NON_STRICT, GOOGLE_STRICT, GOOGLE_OPENAPI, XAI_STRICT, XAI_NON_STRICT, OLLAMA, MINIMAL,
]) registerProfile(p);

/** A profile by id (`undefined` when unknown). Variants made by `variant` resolve too. */
export function getProfile(id: string): Profile | undefined {
  return BY_ID.get(id);
}

/** The family's strict profile (its loose one when it has none) or its loose one; `LENIENT` for an unknown family. */
export function familyProfile(family: ProfileFamily, strict: boolean): Profile {
  const slot = BY_FAMILY.get(family);
  return (strict ? slot?.strict : undefined) ?? slot?.loose ?? LENIENT;
}

/** The changes the request budget may make to a profile for one schema. */
export interface ProfileAdjustment {
  /** Widen enums with more values than this (fewer enum values and characters on the wire). */
  readonly maxEnumValues?: number;
  /** Write nesting below this depth as JSON text (fewer levels and properties). */
  readonly maxDepth?: number;
  /** Write absent optionals as `null` (moves optional parameters into union types). */
  readonly optionalAsNull?: boolean;
  /** Wrap a non-object root as `{ input }`. */
  readonly rootObject?: boolean;
}

/**
 * A profile with adjustments applied, memoized so the same adjustments give
 * the same instance (and id), which keeps every rendering memo stable.
 */
export function variant(base: Profile, adj: ProfileAdjustment): Profile {
  const tags: string[] = [];
  const patch: { -readonly [K in keyof Profile]?: Profile[K] } = {};
  if (adj.maxEnumValues !== undefined && adj.maxEnumValues < (base.maxEnumValues ?? Infinity)) {
    patch.maxEnumValues = adj.maxEnumValues;
    tags.push(`enum<=${adj.maxEnumValues}`);
  }
  if (adj.maxDepth !== undefined && adj.maxDepth < (base.maxDepth ?? Infinity)) {
    patch.maxDepth = adj.maxDepth;
    tags.push(`depth<=${adj.maxDepth}`);
  }
  if (adj.optionalAsNull && base.optional !== 'null') {
    patch.optional = 'null';
    tags.push('optional=null');
  }
  if (adj.rootObject && !base.rootObject) {
    patch.rootObject = true;
    tags.push('root=object');
  }
  if (!tags.length) return base;
  const id = `${base.id}[${tags.join(',')}]`;
  let p = BY_ID.get(id);
  if (!p) {
    p = Object.freeze({ ...base, ...patch, id });
    BY_ID.set(id, p);
  }
  return p;
}

// ============================================================================
// The view description callbacks see
// ============================================================================

/** What a description callback sees, so prose can match the model-facing shape. */
export interface View {
  readonly profile: Profile;
  /** `'pairs'` when records are written as `[{key, value}]`. */
  readonly records: Profile['records'];
  /** `'null'` when an absent optional is written as `null`. */
  readonly optional: Profile['optional'];
  /** How to say "a record" in prose: `"a list of {key, value} entries"` or `"an object"`. */
  readonly recordWord: string;
}

const views = new WeakMap<Profile, View>();

export function viewOf(profile: Profile): View {
  let v = views.get(profile);
  if (!v) {
    v = Object.freeze({
      profile,
      records: profile.records,
      optional: profile.optional,
      recordWord: profile.records === 'pairs' ? 'a list of {key, value} entries' : 'an object',
    });
    views.set(profile, v);
  }
  return v;
}
