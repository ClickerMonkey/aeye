import type { FormatDescriptor } from '../descriptor';
import { LENIENT } from './lenient';

/**
 * Anthropic strict — Claude 4.5 and later (Opus 4.5–4.8, Sonnet 4.5/4.6,
 * Haiku 4.5, and the 5.x Opus, Sonnet, Haiku, Fable, and Mythos models). Strict
 * tools and `output_config.format` are GA with no beta header (re-read
 * 2026-10-30). Per Anthropic's structured-outputs docs:
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
 *   (`minLength`/`maxLength`) constraints are not supported and are dropped,
 *   as are array sizes (only `minItems` of 0 or 1 is accepted).
 * - `allOf` is supported except around a `$ref`.
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
