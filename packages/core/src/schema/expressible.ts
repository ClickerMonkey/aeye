import z from 'zod';
import type { FormatDescriptor } from './descriptor';
import { walkKey } from './walk-key';
import { analyzeSchema, checkSchemaSizeLimits } from './analyze';

/**
 * Decide whether `schema` can be expressed as structured output under
 * `descriptor`'s JSON-Schema dialect. Returns `false` when the schema uses a
 * construct the descriptor forbids, so the caller can DROP the wire schema and
 * deliver it as prompt text instead (see the ai-layer
 * `applySchemaDeliveryFallback`).
 *
 * Walks the Zod schema in the same style as `strictify`/`convert`, honoring:
 * - **unions** (`z.union` / `z.discriminatedUnion` → `anyOf`) when
 *   `!descriptor.allowAnyOf` (e.g. Gemini strict rejects `anyOf`);
 * - **intersections** (`z.intersection` → `allOf`) when `!descriptor.allowAllOf`;
 * - **recursion** (a self-referential `z.lazy` cycle → `$ref`): a cycle back to
 *   the ROOT is fine when `descriptor.allowRootRef && descriptor.supportsRecursion`
 *   (Gemini supports `$ref: '#'`); a non-root cycle needs
 *   `descriptor.allowDefsRef && descriptor.supportsRecursion`.
 *
 * `ZodNullable` / `ZodOptional` are transparent wrappers here (nullability is
 * NOT treated as a union), so only genuine `z.union(...)` trips `allowAnyOf`.
 * Non-combinator, non-recursive schemas (plain objects, arrays, primitives)
 * are always expressible. The structure mirrors the descriptor flags so more
 * feasibility checks are easy to add.
 *
 * Under a descriptor with `structuredOutputAlwaysStrict` the schema must also
 * fit the strict limits on its own — the per-schema size limits and the
 * per-request optional-parameter and union budgets — because that family has
 * no non-strict structured output to degrade to.
 */
export function canExpress(
  schema: z.ZodType | z.core.$ZodType,
  descriptor: FormatDescriptor,
): boolean {
  return expressible(schema, descriptor, /* cycleBreakerCounts */ false)
    && (!descriptor.structuredOutputAlwaysStrict || fitsStrictAlone(schema, descriptor));
}

/**
 * Whether `schema`, as the only strict schema in a request, stays inside the
 * descriptor's size limits and per-request budgets.
 */
function fitsStrictAlone(schema: z.ZodType | z.core.$ZodType, descriptor: FormatDescriptor): boolean {
  const features = analyzeSchema(schema);
  return checkSchemaSizeLimits(schema, descriptor).length === 0
    && features.optionalParameterCount <= (descriptor.maxStrictOptionalParams ?? Infinity)
    && features.unionTypeCount <= (descriptor.maxStrictUnionTypes ?? Infinity);
}

/**
 * `canExpress`, except that a cycle counts as EXPRESSIBLE whatever the
 * descriptor's ref flags say, because `emitCachedRef` replaces any back-edge
 * the descriptor cannot spell with the bounded `buildCycleBreakerSchema`
 * placeholder. The emitted schema is therefore always *sendable*; it is only
 * *looser* than the source at the back-edge.
 *
 * That distinction is the whole reason there are two predicates:
 * - `canExpress` answers "will the model be properly CONSTRAINED by this?",
 *   which is what a structured-OUTPUT delivery decision needs — a back-edge
 *   silently widened to "any" is a good reason to deliver the schema as prompt
 *   text instead (`applySchemaDeliveryFallback`), and
 *   `ANTHROPIC_STRICT`'s `supportsRecursion: false` is exactly that case.
 * - this one answers "will the provider REJECT this?", which is what a TOOL's
 *   strict allocation needs. A tool has no prompt-text fallback, so degrading a
 *   merely-loose schema to LENIENT would trade a real strict guarantee for
 *   nothing.
 *
 * The combinator half is shared and is the half that actually bites: nothing
 * rewrites a forbidden `anyOf`/`allOf` away, so a schema carrying one is a
 * provider 400 under a descriptor that forbids it.
 */
export function sendableUnder(
  schema: z.ZodType | z.core.$ZodType,
  descriptor: FormatDescriptor,
): boolean {
  return expressible(schema, descriptor, /* cycleBreakerCounts */ true);
}

function expressible(
  schema: z.ZodType | z.core.$ZodType,
  descriptor: FormatDescriptor,
  cycleBreakerCounts: boolean,
): boolean {
  // Keys, not objects — a rebuilt `z.lazy` getter defeats identity (see `walkKey`).
  const rootKey = walkKey(schema);
  // Nodes currently on the DFS stack — a re-encounter is a recursion cycle.
  const inProgress = new Set<z.ZodType | z.core.$ZodType | string>();
  // Completed nodes with their result, so shared (non-cyclic) sub-schemas
  // aren't re-walked (guards against exponential blow-up on DAG-shaped schemas).
  const completed = new Map<z.ZodType | z.core.$ZodType | string, boolean>();

  const walk = (s: z.ZodType | z.core.$ZodType): boolean => {
    const key = walkKey(s);
    if (inProgress.has(key)) {
      // Recursion cycle detected at `s`.
      if (cycleBreakerCounts) return true;
      if (key === rootKey) return descriptor.allowRootRef && descriptor.supportsRecursion;
      return descriptor.allowDefsRef && descriptor.supportsRecursion;
    }
    const cached = completed.get(key);
    if (cached !== undefined) return cached;

    inProgress.add(key);
    const result = walkNode(s);
    inProgress.delete(key);
    completed.set(key, result);
    return result;
  };

  const walkNode = (s: z.ZodType | z.core.$ZodType): boolean => {
    // ---- Transparent wrappers: recurse into the inner type ----
    if (s instanceof z.ZodOptional || s instanceof z.ZodNullable) return walk(s.unwrap());
    if (s instanceof z.ZodDefault) return walk(s._zod.def.innerType);
    if (s instanceof z.ZodPrefault) return walk(s._zod.def.innerType);
    if (s instanceof z.ZodCatch) return walk(s._zod.def.innerType);
    if (s instanceof z.ZodReadonly) return walk(s._zod.def.innerType);
    if (s instanceof z.ZodNonOptional) return walk(s._zod.def.innerType);
    if (s instanceof z.ZodLazy) return walk(s._zod.def.getter());
    // ZodCodec must be checked before ZodPipe (it's a ZodPipe subclass in v4).
    if (s instanceof z.ZodCodec) return walk(s._zod.def.in) && walk(s._zod.def.out);
    if (s instanceof z.ZodPipe) return walk(s._zod.def.in) && walk(s._zod.def.out);

    // ---- Combinators (the ones that actually bite) ----
    // ZodDiscriminatedUnion is a ZodUnion subclass in v4, so this covers both.
    if (s instanceof z.ZodUnion) {
      if (!descriptor.allowAnyOf) return false;
      return (s.options as readonly (z.ZodType | z.core.$ZodType)[]).every(walk);
    }
    if (s instanceof z.ZodIntersection) {
      if (!descriptor.allowAllOf) return false;
      return walk(s._zod.def.left) && walk(s._zod.def.right);
    }

    // ---- Containers: recurse so nested combinators/cycles are reached ----
    if (s instanceof z.ZodObject) {
      for (const key in s.shape) {
        if (!walk(s.shape[key])) return false;
      }
      return true;
    }
    if (s instanceof z.ZodArray) return walk(s._zod.def.element);
    if (s instanceof z.ZodTuple) {
      for (const item of s._zod.def.items) {
        if (!walk(item)) return false;
      }
      return s._zod.def.rest ? walk(s._zod.def.rest) : true;
    }
    if (s instanceof z.ZodRecord) return walk(s._zod.def.valueType);
    if (s instanceof z.ZodMap) return walk(s._zod.def.keyType) && walk(s._zod.def.valueType);
    if (s instanceof z.ZodSet) return walk(s._zod.def.valueType);

    // ---- Leaves / anything without forbidden substructure ----
    return true;
  };

  return walk(schema);
}
