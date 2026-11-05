import z from 'zod';
import type { FormatDescriptor } from './descriptor';
import { walkKey } from './expressible';
import { enumEmittedValues, literalEmittedValues } from './enum-values';

// ============================================================================
// Schema feature analysis + per-request strict allocation
// ============================================================================

/**
 * One emitted `enum` node's contribution to a dialect's size limits. A dialect
 * bounds the TOTAL number of enum values in a schema and, separately, the
 * character length of a SINGLE large enum — so the per-enum breakdown has to
 * survive the walk; a pair of totals cannot answer the second question
 * (two enums, one long-valued and one many-valued, would answer it wrongly).
 */
export interface EnumFeature {
  /** How many members the enum emits. */
  readonly valueCount: number;
  /**
   * Total character length of its STRING members. Non-string members
   * contribute nothing: the character rules are written for string values.
   */
  readonly stringValueChars: number;
}

/**
 * Structural feature counts for a Zod schema, used by the SchemaBudget to
 * decide whether an item fits a descriptor's per-request budget, whether it
 * fits the dialect's per-schema size limits, and whether the descriptor can
 * express it at all.
 */
export interface SchemaFeatures {
  /** True if the schema (or any subschema) uses `z.lazy` / self-recursion. */
  hasRecursion: boolean;
  /** Count of `z.optional()` leaves anywhere in the schema. */
  optionalParameterCount: number;
  /**
   * Count of union-shaped nodes — `z.union`, `z.discriminatedUnion`, plus
   * `z.nullable` (which on the wire under OpenAI strict becomes a type
   * array `[T, "null"]`, also counts toward Anthropic's union-type budget).
   */
  unionTypeCount: number;
  /** Count of `z.record` nodes. */
  recordCount: number;
  /** Count of `z.tuple` nodes. */
  tupleCount: number;

  // ---- Size, for `FormatDescriptor.schemaSizeLimits` ----
  /** One entry per emitted `enum` node, in walk order. */
  enums: readonly EnumFeature[];
  /**
   * Object properties the schema emits, summed over every nesting level. A
   * record counts as the 2 properties its widest encoding emits
   * (`{key, value}` pairs) and a tuple as one per item (numeric-key
   * encoding) — the count is descriptor-independent, so it takes the largest
   * encoding any dialect could choose (see `schemaSizeLimits`).
   */
  objectPropertyCount: number;
  /** Deepest container nesting below the root (an object of scalars is 1). */
  maxNestingDepth: number;
  /**
   * Total characters over property names plus `enum` and `const` string
   * values — the "total string size" a dialect bounds. `$defs` entry names are
   * NOT included: they are generated at emit time, are few, and are short
   * relative to a 120,000-character budget.
   */
  stringSizeChars: number;
}

const ZERO_FEATURES: SchemaFeatures = Object.freeze({
  hasRecursion: false,
  optionalParameterCount: 0,
  unionTypeCount: 0,
  recordCount: 0,
  tupleCount: 0,
  enums: Object.freeze([]),
  objectPropertyCount: 0,
  maxNestingDepth: 0,
  stringSizeChars: 0,
});

const featuresCache = new WeakMap<z.ZodType | z.core.$ZodType, SchemaFeatures>();

/**
 * Walk a Zod schema once and count its structural features. Result is
 * cached per schema in a WeakMap — second-and-subsequent calls are O(1) and
 * the entry is GC'd with the schema (same OOM-safe pattern as `strictify`).
 *
 * The walk is EAGER (it has to descend to count), so its cycle guard keys on
 * `walkKey`, not on object identity: a `z.lazy` that rebuilds its inner schema
 * per call would otherwise never re-enter the same object and the walk would
 * never terminate. That is not hypothetical — it is a measured, reproducible
 * heap-death, and this function is on the hot path of EVERY tool of EVERY
 * request to a strict-family model (`SchemaBudget.allocate`).
 */
export function analyzeSchema(schema: z.ZodType | z.core.$ZodType): SchemaFeatures {
  const cached = featuresCache.get(schema);
  if (cached) return cached;

  const visiting = new Set<z.ZodType | z.core.$ZodType | string>();
  const features: SchemaFeatures = { ...ZERO_FEATURES };
  // Collected mutably and frozen onto `features` at the end — `ZERO_FEATURES`
  // is a frozen singleton, so spreading it must not hand out its array.
  const enums: EnumFeature[] = [];

  /** Total characters of the string members of an emitted enum/const value set. */
  const stringChars = (values: readonly unknown[]): number =>
    values.reduce<number>((n, v) => n + (typeof v === 'string' ? v.length : 0), 0);

  /** Record the deepest container nesting reached. `depth` is the level of `s` itself. */
  const noteDepth = (depth: number): void => {
    if (depth > features.maxNestingDepth) features.maxNestingDepth = depth;
  };

  // `depth` counts CONTAINERS entered (an object of scalars is depth 1). Wrapper
  // nodes — optional, nullable, default, lazy, union arms — are transparent on
  // the wire and pass their own depth through, so `{a?: {b: string}}` is 2, the
  // same as `{a: {b: string}}`.
  function walk(s: z.ZodType | z.core.$ZodType | undefined | null, depth: number): void {
    if (!s) return;
    const key = walkKey(s);
    if (visiting.has(key)) return;
    visiting.add(key);
    try {
      // Recursion is detected via z.lazy: peek at the inner schema (but only
      // once — the visiting set bounds the walk).
      if (s instanceof z.ZodLazy) {
        features.hasRecursion = true;
        try {
          walk(s.def.getter(), depth);
        } catch { /* lazy getter may throw at analyze time; ignore */ }
        return;
      }

      if (s instanceof z.ZodOptional) {
        features.optionalParameterCount += 1;
        walk(s.unwrap(), depth);
        return;
      }

      if (s instanceof z.ZodNullable) {
        features.unionTypeCount += 1; // T|null counts as a union on the wire
        walk(s.unwrap(), depth);
        return;
      }

      if (s instanceof z.ZodUnion || s instanceof z.ZodDiscriminatedUnion) {
        features.unionTypeCount += 1;
        for (const opt of (s as z.ZodUnion).options) walk(opt, depth);
        return;
      }

      if (s instanceof z.ZodIntersection) {
        walk(s.def.left, depth);
        walk(s.def.right, depth);
        return;
      }

      if (s instanceof z.ZodObject) {
        noteDepth(depth + 1);
        for (const key in s.shape) {
          features.objectPropertyCount += 1;
          features.stringSizeChars += key.length;
          walk(s.shape[key], depth + 1);
        }
        if (s.def.catchall) walk(s.def.catchall, depth + 1);
        return;
      }

      if (s instanceof z.ZodArray) {
        noteDepth(depth + 1);
        walk(s.element, depth + 1);
        return;
      }

      if (s instanceof z.ZodRecord) {
        features.recordCount += 1;
        // Widest encoding wins (see `SchemaFeatures.objectPropertyCount`): the
        // array-of-pairs form is an array of `{key, value}` objects, so two
        // properties, two property names, and two levels of container.
        features.objectPropertyCount += 2;
        features.stringSizeChars += 'key'.length + 'value'.length;
        noteDepth(depth + 2);
        if (s.keyType) walk(s.keyType, depth + 2);
        walk(s.valueType, depth + 2);
        return;
      }

      if (s instanceof z.ZodTuple) {
        features.tupleCount += 1;
        // The numeric-key object encoding emits one property per item, named
        // "0", "1", … — one character each until there are ten of them, which
        // is close enough for a 120,000-character budget.
        features.objectPropertyCount += s.def.items.length;
        features.stringSizeChars += s.def.items.length;
        noteDepth(depth + 1);
        for (const item of s.def.items) walk(item, depth + 1);
        if (s.def.rest) walk(s.def.rest, depth + 1);
        return;
      }

      if (s instanceof z.ZodDefault) {
        walk(s.def.innerType, depth);
        return;
      }

      if (s instanceof z.ZodCodec || s instanceof z.ZodPipe) {
        walk(s.def.in, depth);
        walk(s.def.out, depth);
        return;
      }

      if (s instanceof z.ZodEnum) {
        const values = enumEmittedValues(s);
        const chars = stringChars(values);
        enums.push({ valueCount: values.length, stringValueChars: chars });
        features.stringSizeChars += chars;
        return;
      }

      if (s instanceof z.ZodLiteral) {
        const values = literalEmittedValues(s);
        const chars = stringChars(values);
        // One value emits `const`, several emit `enum` — only the latter is an
        // enum for the purpose of a dialect's enum-value budget, but both count
        // toward the total string size.
        if (values.length > 1) enums.push({ valueCount: values.length, stringValueChars: chars });
        features.stringSizeChars += chars;
        return;
      }

      // Primitives and unknown leaves contribute nothing.
    } finally {
      visiting.delete(key);
    }
  }

  walk(schema, 0);
  features.enums = Object.freeze(enums);
  Object.freeze(features);
  featuresCache.set(schema, features);
  return features;
}

/** Shared empty result, so the common "dialect publishes no size limits" path allocates nothing. */
const NO_SIZE_PROBLEMS: readonly string[] = Object.freeze([]);

/**
 * Report the ways ONE schema exceeds the descriptor's documented per-schema
 * size limits (`FormatDescriptor.schemaSizeLimits`). Empty means it fits, or
 * that the dialect publishes no limits.
 *
 * This is a FEASIBILITY question, not a budget one: the numbers bound a single
 * schema, so no other tool in the request can change the answer, and
 * `SchemaBudget.allocate` therefore treats a hit exactly like an
 * unrepresentable keyword — that item degrades to the family's non-strict
 * descriptor and the rest of the request is untouched.
 *
 * Exported because "why did my tool silently stop being strict?" needs an
 * answer a caller can print; each line names the bound and the measurement.
 *
 * @example
 * ```ts
 * checkSchemaSizeLimits(z.object({ pick: z.enum(tenThousandNames) }), OPENAI_STRICT);
 * //  → ['enum values 10000 exceed maxTotalEnumValues 1000']
 * ```
 */
export function checkSchemaSizeLimits(
  schema: z.ZodType | z.core.$ZodType,
  descriptor: FormatDescriptor,
): readonly string[] {
  const limits = descriptor.schemaSizeLimits;
  if (limits === undefined) return NO_SIZE_PROBLEMS;

  const features = analyzeSchema(schema);
  const problems: string[] = [];

  if (features.objectPropertyCount > limits.maxObjectProperties) {
    problems.push(`object properties ${features.objectPropertyCount} exceed maxObjectProperties ${limits.maxObjectProperties}`);
  }
  if (features.maxNestingDepth > limits.maxNestingDepth) {
    problems.push(`nesting depth ${features.maxNestingDepth} exceeds maxNestingDepth ${limits.maxNestingDepth}`);
  }
  if (features.stringSizeChars > limits.maxTotalStringChars) {
    problems.push(`total string characters ${features.stringSizeChars} exceed maxTotalStringChars ${limits.maxTotalStringChars}`);
  }
  const totalEnumValues = features.enums.reduce((n, e) => n + e.valueCount, 0);
  if (totalEnumValues > limits.maxTotalEnumValues) {
    problems.push(`enum values ${totalEnumValues} exceed maxTotalEnumValues ${limits.maxTotalEnumValues}`);
  }
  // The large-enum character rule is per-enum and conditional on that SAME
  // enum's value count, which is why the walk keeps the breakdown instead of
  // two totals.
  for (const e of features.enums) {
    if (e.valueCount > limits.largeEnumValueCount && e.stringValueChars > limits.maxLargeEnumStringChars) {
      problems.push(
        `an enum of ${e.valueCount} values (over largeEnumValueCount ${limits.largeEnumValueCount}) spends ` +
          `${e.stringValueChars} characters, over maxLargeEnumStringChars ${limits.maxLargeEnumStringChars}`,
      );
    }
  }
  return problems;
}
