import type { FormatDescriptor } from '../descriptor';
import { LENIENT } from './lenient';

const OPENAI_STRICT_FORMATS = new Set([
  'date-time', 'time', 'date', 'duration', 'email', 'hostname', 'ipv4', 'ipv6', 'uuid',
]);

/**
 * OpenAI strict. Records→pairs, tuples→numeric-keys, optional→nullable.
 *
 * Numeric bounds (`minimum`/`maximum`/`exclusive*`/`multipleOf`) and array
 * sizes (`minItems`/`maxItems`) are in the documented supported list
 * (developers.openai.com/api/docs/guides/structured-outputs, "Supported
 * properties", read 2026-10-30). `minLength`/`maxLength` are listed as
 * unsupported only for fine-tuned models; a strict `json_schema` carrying them
 * was accepted and honored by gpt-5.4-mini on 2026-10-30, as were the
 * numeric and array bounds, so all three are emitted.
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
  allowMinMaxLength: true,
  allowMinMaxItems: true,
  allowMinimumMaximum: true,
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
