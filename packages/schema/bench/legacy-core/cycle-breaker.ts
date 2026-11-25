import z from 'zod';
import type { FormatDescriptor } from './descriptor';
import type { JSONSchema } from './json-schema';
import { buildAnyValueSchema } from './any-value';

/**
 * Build the inline placeholder used in place of a cyclic `$ref` for
 * descriptors with `supportsRecursion: false`. Inspects the recursive zod
 * `schema` and emits a JSON-Schema node whose top-level shape matches it
 * (number → `{type: 'number'}`, array → `{type: 'array', items: ...}`, union
 * → `{anyOf: [...]}`, etc.) so the LLM still knows what JSON value to send
 * at the cycle position. One level of structural fidelity, then bottoms out
 * at the descriptor's flat "any" encoding.
 */
export function buildCycleBreakerSchema(
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
