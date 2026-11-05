import type { FormatDescriptor } from '../descriptor';
import { LENIENT } from './lenient';

const XAI_STRICT_FORMATS = new Set([
  'date', 'time', 'date-time', 'email', 'uuid', 'ipv4', 'ipv6', 'uri',
]);

/**
 * xAI (Grok) strict — per `docs.x.ai/docs/guides/structured-outputs`
 * (read 2026-10-30). Tool calls are always strict on Grok 4 models.
 *
 * - Supported: `anyOf` (`oneOf` behaves the same), non-circular `$ref` /
 *   `$defs`, `prefixItems` for tuples (array-form `items` is rejected),
 *   `enum`, `const`, string formats (below), `pattern` without
 *   backreferences or lookaround, and length / item / numeric bounds.
 * - `allOf` takes a single subschema only, so it stays off.
 * - Optional properties stay optional; `additionalProperties` defaults to
 *   `false`, and schema-valued records were accepted live.
 * - Circular references are documented as unsupported, so recursion goes
 *   through the cycle breaker. Every other keyword above was accepted live
 *   on `x-ai/grok-4.3` via OpenRouter on 2026-10-30.
 */
export const XAI_STRICT: FormatDescriptor = Object.freeze({
  id: 'xai-strict',
  family: 'xai',
  strict: true,
  objectAllFieldsRequired: false,
  objectClosedByDefault: true,
  recordEncoding: 'open-record',
  tupleEncoding: 'prefix-items',
  allowAllOf: false,
  allowAnyOf: true,
  allowOneOf: false,
  allowRootRef: false,
  allowDefsRef: true,
  emitPropertyOrdering: false,
  supportedStringFormats: XAI_STRICT_FORMATS,
  allowPattern: true,
  allowMultiplePatterns: false,
  allowMinMaxLength: true,
  allowMinMaxItems: true,
  allowMinimumMaximum: true,
  optionalAsNullable: false,
  anyEncoding: 'flat',
  supportsRecursion: false,
});

/** xAI non-strict — alias of LENIENT but tagged with the xai family. */
export const XAI_NON_STRICT: FormatDescriptor = Object.freeze({
  ...LENIENT,
  id: 'xai-non-strict',
  family: 'xai',
});
