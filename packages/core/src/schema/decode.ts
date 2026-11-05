import z from 'zod';
import type { FormatDescriptor } from './descriptor';
import { strictify } from './strictify';

// ============================================================================
// Wire → conceptual DECODE (symmetric with strictify's conceptual → wire ENCODE)
//
// `strictify` installs decode preprocesses (array-of-pairs → record,
// numeric-key object → tuple, null → undefined for optionals, …) that only
// run when Zod VALIDATES a value. A custom `parse` hook REPLACES Zod
// validation, so it never triggers those preprocesses — it would otherwise
// see the raw provider wire shape.
//
// `relaxValidation` turns a (strictified) schema into a NON-FAILING variant
// that KEEPS every transform but DROPS validation, so we can run it purely to
// execute the decode preprocesses and hand a custom parser the CONCEPTUAL
// value. `decodeWire` ties it together (strictify → relax → safeParse,
// best-effort).
// ============================================================================

/**
 * Rebuild a `ZodObject` for the relaxed decoder.
 *
 * - Recurses each field through `relax` (so nested transforms still run).
 * - `forceOptional`: when true every field becomes optional (max leniency —
 *   used everywhere EXCEPT union options). When false the field keeps its own
 *   optionality (used for union-option objects, where a required field is the
 *   discriminating signal that lets the union pick the right branch).
 * - `loose`: when true (default) unknown keys pass straight through; when
 *   false the object STRIPS unknown keys. Intersection sides use `false` so
 *   each half only claims its own keys and the two halves merge without an
 *   "unmergable intersection" conflict (a loose side would echo the other
 *   half's raw key and collide with that half's transformed value).
 */
function relaxObjectShape(
  schema: z.ZodObject,
  relax: (s: z.ZodType | z.core.$ZodType) => z.ZodType,
  forceOptional: boolean,
  loose = true,
): z.ZodType {
  const shape: Record<string, z.ZodType> = {};
  for (const key in schema.shape) {
    const relaxed = relax(schema.shape[key]);
    shape[key] = forceOptional ? relaxed.optional() : relaxed;
  }
  const obj = z.object(shape);
  return loose ? obj.loose() : obj;
}

/**
 * Relax one side of an intersection. Object sides are rebuilt STRIP (not
 * loose) so the two halves merge cleanly (see `relaxObjectShape`'s `loose`
 * note); everything else relaxes normally.
 */
function relaxIntersectionSide(
  schema: z.ZodType | z.core.$ZodType,
  relax: (s: z.ZodType | z.core.$ZodType) => z.ZodType,
): z.ZodType {
  if (schema instanceof z.ZodObject) {
    return relaxObjectShape(schema, relax, /* forceOptional */ true, /* loose */ false);
  }
  return relax(schema);
}

/**
 * Relax the options of a union (plain OR discriminated — the latter is a
 * subclass of `ZodUnion` in Zod v4, so a single path covers both).
 *
 * Object options are rebuilt with their ORIGINAL requiredness preserved
 * (`forceOptional: false`) so the union can discriminate by required-field
 * presence and run the matching option's decode transforms. Non-object
 * options are kept AS-IS: relaxing a leaf to `z.any()` would make it swallow
 * every value (the first branch would always win), so the strictified option
 * is left intact — it still discriminates by type and still carries any wire
 * transform it needs. Validation on those non-object branches is therefore
 * only best-effort, which is acceptable: `decodeWire` falls back to the
 * original value if nothing matches.
 */
function relaxUnionOptions(
  options: readonly (z.ZodType | z.core.$ZodType)[],
  relax: (s: z.ZodType | z.core.$ZodType) => z.ZodType,
): z.ZodType {
  const relaxed = options.map((opt) =>
    opt instanceof z.ZodObject ? relaxObjectShape(opt, relax, false) : (opt as z.ZodType),
  );
  return z.union(relaxed as [z.ZodType, z.ZodType, ...z.ZodType[]]);
}

/**
 * Per-node dispatch for `relaxValidation`. Mirrors the node coverage of
 * `strictifySimple` plus the extra wrappers/containers a strictified schema
 * can contain (`ZodMap`, `ZodSet`, `ZodCatch`, `ZodReadonly`, `ZodPrefault`,
 * `ZodNonOptional`, …). Unknown/leaf nodes bottom out at `z.any()`.
 */
function relaxNode(
  schema: z.ZodType | z.core.$ZodType,
  relax: (s: z.ZodType | z.core.$ZodType) => z.ZodType,
): z.ZodType {
  // ---- Wrappers: unwrap, relax inner, re-wrap ----
  if (schema instanceof z.ZodOptional) return relax(schema.unwrap()).optional();
  if (schema instanceof z.ZodNullable) return relax(schema.unwrap()).nullable();
  if (schema instanceof z.ZodDefault) {
    return relax(schema._zod.def.innerType).default(schema._zod.def.defaultValue);
  }
  if (schema instanceof z.ZodPrefault) {
    return relax(schema._zod.def.innerType).prefault(schema._zod.def.defaultValue);
  }
  if (schema instanceof z.ZodCatch) {
    return relax(schema._zod.def.innerType).catch(schema._zod.def.catchValue);
  }
  if (schema instanceof z.ZodReadonly) return relax(schema._zod.def.innerType).readonly();
  // NonOptional adds a "must be present" validation — drop it (we're relaxing).
  if (schema instanceof z.ZodNonOptional) return relax(schema._zod.def.innerType);

  // ---- Transforms: KEEP the transform so the decode still runs ----
  // ZodCodec must be checked before ZodPipe (it's a ZodPipe subclass in v4).
  if (schema instanceof z.ZodCodec) {
    return z.codec(
      relax(schema._zod.def.in),
      relax(schema._zod.def.out),
      { decode: schema._zod.def.transform, encode: schema._zod.def.reverseTransform },
    );
  }
  // A bare transform (the `in` of a `preprocess`, the `out` of a `.transform`)
  // carries no validation — keep it verbatim so the transform runs.
  if (schema instanceof z.ZodTransform) return schema as z.ZodType;
  if (schema instanceof z.ZodPipe) {
    return z.pipe(relax(schema._zod.def.in), relax(schema._zod.def.out));
  }

  // ---- Containers: recurse so nested transforms are reached ----
  if (schema instanceof z.ZodObject) return relaxObjectShape(schema, relax, /* forceOptional */ true);
  if (schema instanceof z.ZodArray) return z.array(relax(schema._zod.def.element));
  if (schema instanceof z.ZodTuple) {
    const items = schema._zod.def.items.map(relax) as [z.ZodType, ...z.ZodType[]];
    const rest = schema._zod.def.rest ? relax(schema._zod.def.rest) : undefined;
    return rest ? z.tuple(items, rest) : z.tuple(items);
  }
  if (schema instanceof z.ZodRecord) {
    // Accept any string key (records arrive with string-ish keys on the wire);
    // an exhaustive/enum key schema would reject partial records.
    return z.record(z.string(), relax(schema._zod.def.valueType));
  }
  if (schema instanceof z.ZodMap) {
    return z.map(relax(schema._zod.def.keyType), relax(schema._zod.def.valueType));
  }
  if (schema instanceof z.ZodSet) return z.set(relax(schema._zod.def.valueType));

  // ---- Combinators ----
  // ZodDiscriminatedUnion is a ZodUnion subclass in v4, so this one branch
  // covers both. Discrimination survives via required-field presence.
  if (schema instanceof z.ZodUnion) return relaxUnionOptions(schema.options, relax);
  if (schema instanceof z.ZodIntersection) {
    return z.intersection(
      relaxIntersectionSide(schema._zod.def.left, relax),
      relaxIntersectionSide(schema._zod.def.right, relax),
    );
  }

  // ---- Recursion: defer + memoize (see `relaxValidation`) ----
  if (schema instanceof z.ZodLazy) {
    return z.lazy(() => relax(schema._zod.def.getter()));
  }

  // ---- Validating leaves + anything unrecognized → accept everything ----
  return z.any();
}

/**
 * Produce a NON-FAILING variant of `schema` that keeps every transform
 * (`preprocess`, `codec`, `pipe`, `transform`) but drops validation. Parsing
 * a wire value through the result runs the decode preprocesses installed by
 * `strictify` (array-of-pairs → record, numeric-key object → tuple, null →
 * undefined) and yields the conceptual value, without ever rejecting.
 *
 * Recursion (`z.lazy` self-reference) is handled with a per-call memo map: an
 * in-flight node is recorded as a thunk and re-encounters resolve to
 * `z.lazy(thunk)`, so a self-referential schema relaxes in finite time and
 * never infinite-loops.
 */
export function relaxValidation(schema: z.ZodType): z.ZodType {
  // Per-call cycle map — same scheme as `strictifyWithDescriptor`: cache a
  // lazy thunk for in-flight schemas so recursive references resolve to a
  // `z.lazy(() => result)` instead of recursing forever.
  const map = new Map<z.ZodType | z.core.$ZodType, z.ZodType | (() => z.ZodType)>();

  const relax = (s: z.ZodType | z.core.$ZodType): z.ZodType => {
    const cached = map.get(s);
    if (cached) {
      return typeof cached === 'function' ? z.lazy(cached) : cached;
    }
    let result: z.ZodType;
    map.set(s, () => result);
    result = relaxNode(s, relax);
    map.set(s, result);
    return result;
  };

  return relax(schema);
}

/**
 * Module-scope cache for relaxed decoders. Mirrors `strictifyCache`: outer
 * WeakMap keyed by the SOURCE schema (gc'd with it), inner Map keyed by
 * descriptor id (small bounded set).
 */
const relaxDecodeCache = new WeakMap<z.ZodType | z.core.$ZodType, Map<string, z.ZodType>>();

/**
 * DECODE a model's wire `value` back to the conceptual shape a custom parser
 * expects — symmetric with how `strictify` ENCODEs the request for the wire.
 *
 * Runs the descriptor's decode transforms (via `relaxValidation(strictify(...))`)
 * without imposing validation, so array-of-pairs records, numeric-key tuples,
 * and null-for-optional fields are normalized before a provider-agnostic
 * custom parser sees them. Best-effort: NEVER throws — if the relaxed decoder
 * can't parse the value it is returned unchanged.
 *
 * @param schema - the PRE-strictify conceptual schema (strictify runs internally)
 * @param value - the model's raw wire value (already `JSON.parse`d)
 * @param descriptor - the wire dialect the request was encoded with
 */
export function decodeWire(schema: z.ZodType, value: unknown, descriptor: FormatDescriptor): unknown {
  let perSchema = relaxDecodeCache.get(schema);
  if (!perSchema) {
    perSchema = new Map();
    relaxDecodeCache.set(schema, perSchema);
  }
  let decoder = perSchema.get(descriptor.id);
  if (!decoder) {
    decoder = relaxValidation(strictify(schema, descriptor));
    perSchema.set(descriptor.id, decoder);
  }
  const result = decoder.safeParse(value);
  return result.success ? result.data : value;
}
