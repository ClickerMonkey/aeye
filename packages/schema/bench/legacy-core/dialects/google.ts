import type { FormatDescriptor } from '../descriptor';
import { LENIENT } from './lenient';

/**
 * Google Gemini strict — per `ai.google.dev/gemini-api/docs/structured-output`
 * (re-read 2026-10-30, after Google's November 2025 JSON Schema expansion):
 *
 * - Supported keywords: types (including `["T", "null"]` arrays),
 *   `properties`, `required`, `additionalProperties`, `enum`, `format`
 *   (date-time/date/time), `minimum`, `maximum`, `items`, `prefixItems`,
 *   `minItems`, `maxItems`, `anyOf` (`oneOf` is read as `anyOf`), `$defs`,
 *   `$ref`, `title`, `description`, `propertyOrdering`.
 * - `allOf` is not supported and `pattern` is not listed; both stay off.
 *   Live on `google/gemini-3-flash-preview` via OpenRouter (2026-10-30) an
 *   `allOf` tool was accepted but not enforced and a `pattern` tool timed out,
 *   while `anyOf`, shared `$defs`, `prefixItems`, nullable type arrays, closed
 *   objects, and recursion through array items or optional properties all
 *   answered with valid tool calls.
 * - `minLength`/`maxLength` are stripped by the API, so they are not emitted.
 * - Key order is preserved from the schema on Gemini 2.5+, so
 *   `propertyOrdering` is only needed by older models; it is still emitted.
 * - `z.any()` / `z.unknown()` uses the `unconstrained` encoding. Gemini
 *   rejects ref loops through REQUIRED values: a self-referencing `$defs/Any`
 *   that recurses through `additionalProperties` fails with "ref loops are
 *   only supported if they include optional or nullable property values, or
 *   a potentially-zero-length array items" (reproduced 2026-10-30 after an
 *   interval in August 2026 when it was accepted), so the empty schema stays.
 *   Ordinary recursive models recurse through optional fields or arrays,
 *   which Gemini accepts.
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
  allowAnyOf: true,
  allowOneOf: false,
  allowRootRef: true,
  allowDefsRef: true,
  emitPropertyOrdering: true,
  supportedStringFormats: new Set(['date-time', 'date', 'time']),
  allowPattern: false,
  allowMultiplePatterns: false,
  allowMinMaxLength: false,
  allowMinMaxItems: true,
  allowMinimumMaximum: true,
  optionalAsNullable: false,
  // Not a recursive $defs/Any: Gemini rejects ref loops through required
  // values — see the descriptor doc above.
  anyEncoding: 'unconstrained',
  // No documented per-request slot limits. `maxEnumValues: 40` IS a measured
  // response to a real `400 INVALID_ARGUMENT` on this exact product's live
  // fn-catalog enum — see `FormatDescriptor.maxEnumValues` for the numbers,
  // the bisection, and why 40 is conservative rather than the measured edge.
  maxEnumValues: 40,
  supportsRecursion: true,
  // When a schema can't be expressed here (e.g. it needs `allOf`) it's
  // delivered as prompt text instead; this hint keeps the reply a single raw
  // JSON object.
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
