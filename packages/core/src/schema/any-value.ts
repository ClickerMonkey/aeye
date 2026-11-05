import type { FormatDescriptor } from './descriptor';
import type { JSONSchema } from './json-schema';

/**
 * True when the descriptor's "any" encoding is a self-referencing definition,
 * i.e. it has to be hoisted into `$defs/Any` and referenced by `$ref`. The
 * non-recursive encodings (`flat`, `unconstrained`) are inlined at each use
 * site instead, so no `$defs` entry is ever created for them.
 */
export function usesSharedAnyDefinition(descriptor: FormatDescriptor): boolean {
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
export function buildAnyValueSchema(descriptor: FormatDescriptor): JSONSchema {
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
