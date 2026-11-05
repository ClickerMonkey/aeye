import z from 'zod';
import type { FormatDescriptor } from './descriptor';
import { LENIENT } from './dialects/lenient';
import { OPENAI_STRICT } from './dialects/openai';

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
* Transfer description and metadata from source Zod schema to target Zod schema.
*
* A declared `id` moves to `aid`: zod's global registry refuses a second schema
* with the same `id` ("ID X already exists in the registry"), and the clone is
* that second schema. `aid` names the same definition everywhere an `id` does.
*/
function transferMetadata(target: z.ZodType, source: z.ZodType) {
  if (source.description) {
    target = target.describe(source.description);
  }
  const meta = source.meta();
  if (meta) {
    const { id, ...rest } = meta;
    target = target.meta(id === undefined ? meta : { ...rest, aid: rest.aid ?? id });
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
