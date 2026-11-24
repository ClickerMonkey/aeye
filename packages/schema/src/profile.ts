/**
 * A capability profile: what one model/provider/strict-mode combination can
 * read. It is the successor of core's `FormatDescriptor` — same facts, fewer
 * knobs, and every field is consulted by exactly one schema class when it
 * renders (see `render.ts`). Rendering, decoding, validation, error paths,
 * examples and descriptions ALL read the same profile, so they can never
 * disagree about the shape the model sees.
 */
export interface Profile {
  /** Stable id; the memo key for rendered schemas. */
  readonly id: string;
  /** Strict structured outputs (a compiled grammar). Informational for callers. */
  readonly strict: boolean;
  /**
   * How an optional object field is written.
   * - `omit`: the field may be left out (`required` lists only required fields).
   * - `null`: every field is required; an absent value is written `null`
   *   (OpenAI strict). Decoding turns that `null` back into an ABSENT key.
   */
  readonly optional: 'omit' | 'null';
  /** Emit `additionalProperties: false` on every object. */
  readonly closedObjects: boolean;
  /**
   * How `a.record(V)` is written.
   * - `open`: `{ type: 'object', additionalProperties: V }`.
   * - `pairs`: `[{ key, value }]` — for dialects with closed objects only.
   */
  readonly records: 'open' | 'pairs';
  /**
   * How `a.tuple([...])` is written.
   * - `prefixItems`: standard positional items.
   * - `object`: `{ "0": A, "1": B }` (OpenAI strict has no prefixItems).
   * - `array`: `items: anyOf[...]`, positions checked on decode only.
   */
  readonly tuples: 'prefixItems' | 'object' | 'array';
  /**
   * How unions are written.
   * - `anyOf`: JSON Schema `anyOf`.
   * - `tagged`: an object with one nullable field per option; exactly one is
   *   non-null. For dialects with no combinators at all.
   */
  readonly unions: 'anyOf' | 'tagged';
  /** Named types may go to `$defs` and be used by `$ref`. Off → inlined. */
  readonly defs: boolean;
  /** A `$ref` may point back into itself. Off → back-edges become JSON text (see `escape`). */
  readonly recursion: boolean;
  /**
   * How "any JSON value" (`a.unknown()` / `a.json()`) is written.
   * - `empty`: the empty schema `{}`.
   * - `json-text`: a string holding JSON text, parsed on decode.
   */
  readonly any: 'empty' | 'json-text';
  /** min/max/minLength/maxLength/pattern/minItems/maxItems are emitted (always validated either way). */
  readonly constraints: boolean;
  /** Where examples go: the `examples` keyword, the description text, or nowhere. */
  readonly examples: 'keyword' | 'description' | 'none';
  /** An enum with more values than this is widened to a string listing them (still validated). */
  readonly maxEnumValues?: number;
  /** Nesting deeper than this is written as JSON text (the escape hatch). */
  readonly maxDepth?: number;
  /**
   * Who reads the schema. Default `'model'`: `forPeople()` fields are left
   * out and `forModels(...)` variants are used. `'people'` renders the full
   * code shape (web forms, API docs, validating a person's input).
   */
  readonly audience?: 'model' | 'people';
}

/** No rewrites: what the code shape already is. Also the shape of JSON text inside an escape hatch. */
export const LENIENT: Profile = Object.freeze({
  id: 'lenient',
  strict: false,
  optional: 'omit',
  closedObjects: false,
  records: 'open',
  tuples: 'prefixItems',
  unions: 'anyOf',
  defs: true,
  recursion: true,
  any: 'empty',
  constraints: true,
  examples: 'keyword',
});

/** The full code shape, for people: every field, no rewrites. */
export const PEOPLE: Profile = Object.freeze({ ...LENIENT, id: 'people', audience: 'people' });

/** OpenAI structured outputs (strict). Ported from core `OPENAI_STRICT`. */
export const OPENAI_STRICT: Profile = Object.freeze({
  id: 'openai-strict',
  strict: true,
  optional: 'null',
  closedObjects: true,
  records: 'pairs',
  tuples: 'object',
  unions: 'anyOf',
  defs: true,
  recursion: true,
  any: 'json-text',
  constraints: true,
  examples: 'description',
  maxDepth: 10,
});

/** Anthropic strict tools. Ported from core `ANTHROPIC_STRICT`: no recursion, closed objects. */
export const ANTHROPIC_STRICT: Profile = Object.freeze({
  id: 'anthropic-strict',
  strict: true,
  optional: 'omit',
  closedObjects: true,
  records: 'pairs',
  tuples: 'array',
  unions: 'anyOf',
  defs: true,
  recursion: false,
  any: 'json-text',
  constraints: false,
  examples: 'description',
});

/** Google (Gemini). Ported from core `GOOGLE_STRICT`: open records, 40-value enum cap. */
export const GOOGLE_STRICT: Profile = Object.freeze({
  id: 'google-strict',
  strict: true,
  optional: 'omit',
  closedObjects: false,
  records: 'open',
  tuples: 'prefixItems',
  unions: 'anyOf',
  defs: true,
  recursion: true,
  any: 'empty',
  constraints: true,
  examples: 'description',
  maxEnumValues: 40,
});

/**
 * A deliberately poor dialect: no combinators, no `$defs`, no recursion,
 * closed objects, shallow. Used by tests to prove that ANY schema still has a
 * faithful rendering when almost nothing is supported.
 */
export const MINIMAL: Profile = Object.freeze({
  id: 'minimal',
  strict: true,
  optional: 'null',
  closedObjects: true,
  records: 'pairs',
  tuples: 'object',
  unions: 'tagged',
  defs: false,
  recursion: false,
  any: 'json-text',
  constraints: false,
  examples: 'description',
  maxDepth: 6,
  maxEnumValues: 8,
});

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

export function viewOf(profile: Profile): View {
  return {
    profile,
    records: profile.records,
    optional: profile.optional,
    recordWord: profile.records === 'pairs' ? 'a list of {key, value} entries' : 'an object',
  };
}
