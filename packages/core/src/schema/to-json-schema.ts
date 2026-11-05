import z from 'zod';
import type { FormatDescriptor } from './descriptor';
import type { JSONSchema, ToJSONSchemaOptions } from './json-schema';
import { resolveDescriptor } from './registry';
import { buildAnyValueSchema, usesSharedAnyDefinition } from './any-value';
import { buildCycleBreakerSchema } from './cycle-breaker';
import { describeOversizeEnum, enumEmittedValues, literalEmittedValues } from './enum-values';

/**
 * Context for recursive schema conversion
 */
interface ConversionContext {
  root: z.ZodType,
  descriptor: FormatDescriptor;
  definitions: Map<z.ZodType | z.core.$ZodType, [JSONSchema, string]>; // schema to [js, id]
  definitionSchemas: Map<string, JSONSchema>; // id to schema
  refCounter: number;
  path: string[];
  /**
   * IDs whose conversion is still on the stack — distinguishes a true cycle
   * (re-encounter while still converting) from a shared reference (re-encounter
   * after conversion completed). Used by `convert()` to break cycles for
   * descriptors with `supportsRecursion: false`.
   */
  inProgress: Set<string>;
}

/**
 * Converts a Zod schema to JSON Schema with support for different provider dialects.
 *
 * Accepts either a boolean (legacy: true = OPENAI_STRICT, false = LENIENT),
 * an options object `{ strict, format? }`, or a `FormatDescriptor` directly.
 *
 * @param schema - The Zod schema to convert
 * @param options - Configuration options for the conversion
 * @returns JSON Schema object compatible with the resolved dialect
 *
 * @example
 * ```typescript
 * const schema = z.object({
 *   name: z.string(),
 *   age: z.number().optional(),
 * });
 *
 * // For OpenAI strict mode
 * const jsonSchema = toJSONSchema(schema, { strict: true, format: 'openai' });
 *
 * // For Anthropic strict mode
 * const anthropic = toJSONSchema(schema, ANTHROPIC_STRICT);
 * ```
 */
export function toJSONSchema(
  schema: z.ZodType,
  options: ToJSONSchemaOptions | boolean | FormatDescriptor,
): JSONSchema {
  const descriptor = resolveDescriptor(options);

  const context: ConversionContext = {
    root: schema,
    descriptor,
    definitions: new Map(),
    definitionSchemas: new Map(),
    refCounter: 0,
    path: [],
    inProgress: new Set(),
  };

  const result = convert(schema, context);

  // Add definitions if any were created
  if (context.definitionSchemas.size > 0) {
    result.$defs = Object.fromEntries(context.definitionSchemas);
  }

  return result;
}

/**
 * Main recursive conversion function
 */
function convert(schema: z.ZodType | z.core.$ZodType, context: ConversionContext): JSONSchema {
  // For lazy schemas, we need to check by aid first to handle .describe()/.optional() wrappers
  // that create new objects but share the same lazy getter
  let cacheKey: z.ZodType | z.core.$ZodType = schema;
  let unwrappedSchema: z.ZodType | z.core.$ZodType = schema;

  // `z.any()` / `z.unknown()` under an INLINE any-encoding (`flat`,
  // `unconstrained`) must never travel through the definition cache: a second
  // use site of the SAME schema instance — common when a codegen layer hands
  // out one shared "any" node — would otherwise be emitted as
  // `$ref: '#/$defs/__schemaN'`, resurrecting the `$defs` entry the inline
  // encoding exists to avoid. Bypassing the cache re-inlines the (tiny,
  // keyword-free) shape at each site instead.
  const bypassCache = !usesSharedAnyDefinition(context.descriptor)
    && (schema instanceof z.ZodAny || schema instanceof z.ZodUnknown);

  // Check if this is a lazy schema and extract metadata early
  if (bypassCache) {
    // fall through to conversion with no cache read
  } else if (schema instanceof z.ZodLazy) {
    // Check cache FIRST before evaluating getter to prevent infinite recursion
    const [cachedJs, cachedId] = context.definitions.get(schema) || [];
    if (cachedJs && cachedId) {
      return emitCachedRef(schema, cachedJs, cachedId, context);
    }

    const metadata = (schema instanceof z.ZodType) ? schema.meta() : null;
    const aid = metadata?.aid;

    // If there's an aid, check if we've already seen this aid
    if (aid) {
      for (const [cachedSchema, [js, jsId]] of context.definitions.entries()) {
        if (cachedSchema instanceof z.ZodType) {
          const cachedMeta = cachedSchema.meta();
          if (cachedMeta?.aid === aid && jsId && js) {
            // Found a cached version with the same aid - use it
            return emitCachedRef(schema, js, jsId, context);
          }
        }
      }
    }

    unwrappedSchema = schema.def.getter();
  } else {
    // Check cache by object identity for non-lazy schemas
    const [js, jsId] = context.definitions.get(schema) || [];
    if (jsId && js) {
      return emitCachedRef(schema, js, jsId, context);
    }
  }

  // Capture metadata from the original schema
  const metadata: {
    id?: string;
    aid?: string;
    title?: string;
    description?: string;
    deprecated?: boolean;
    [x: string]: unknown;
  } = {};
  if (schema instanceof z.ZodType) {
    Object.assign(metadata, schema.meta() || {});
    if (!metadata.description && schema.description) {
      metadata.description = schema.description;
    }
  }

  // If the schema has an 'aid' or 'id' in meta, promote it to a definition.
  // A cache-bypassed "any" node is never promoted — naming a schema that
  // asserts nothing buys nothing, and the `$defs` entry is precisely what the
  // inline encoding is avoiding. A descriptor that forbids `$defs` outright
  // (`allowDefsRef: false` — Google strict) is never promoted to either: the id
  // is still computed, because the cycle-breaker's description names it, but
  // the definition is inlined at each use site, which is the only spelling that
  // dialect has for a shared node.
  const id = (metadata.aid ? String(metadata.aid) : 0) || metadata.id || `__schema${context.refCounter++}`;
  const save =
    !bypassCache
    && !!(metadata.aid || metadata.id)
    && context.root !== schema
    && context.descriptor.allowDefsRef;

  // A schema target - will hold either the converted schema or a $ref
  const target: JSONSchema = {};

  // Before converting, register this schema to handle recursion
  if (!bypassCache) {
    context.definitions.set(cacheKey, [target, id]);
  }
  context.inProgress.add(id);

  // Convert the unwrapped schema
  let result: JSONSchema;
  try {
    result = convertSchema(unwrappedSchema, context);
  } finally {
    context.inProgress.delete(id);
  }
  // A description the CONVERTER produced describes the EMITTED node, not the
  // source schema — today that is only the `maxEnumValues` widening, whose
  // description IS the value list that replaced the `enum` keyword. The source's
  // own `.describe()` must not silently replace it, or a model handed a widened
  // `{type:'string'}` is told nothing about which strings are legal. Keep both,
  // converter note last.
  const emittedNote = result.description;
  Object.assign(result, metadata);
  if (emittedNote !== undefined && metadata.description !== undefined && metadata.description !== emittedNote) {
    result.description = `${metadata.description} ${emittedNote}`;
  }
  delete result.aid;

  // Promote it because user requested it or it's recursive
  if (save || context.definitionSchemas.has(id)) {
    context.definitionSchemas.set(id, result);
    target.$ref = `#/$defs/${id}`;
  } else {
    // Inline schema
    Object.assign(target, result);
  }

  return target;
}

/**
 * Emit a `$ref` (or, for descriptors that don't support recursion, an inline
 * shape-aware placeholder) when the converter re-encounters a schema it's
 * already started or finished converting.
 *
 * Three cases:
 * 1. Re-encounter while still on the conversion stack (`inProgress.has(id)`)
 *    AND the descriptor cannot express the `$ref` this back-edge would need —
 *    emit a shape-aware placeholder via `buildCycleBreakerSchema()` (number
 *    stays number, array stays array, etc.) with a description naming the
 *    `$defs` entry it would have referenced. This breaks the cycle inline so
 *    providers like Anthropic don't reject the schema.
 *
 *    "Cannot express" is TWO flags, not one, because a back-edge is only ever
 *    spelled one of two ways: `{$ref: '#'}` at the root, or `{$ref:
 *    '#/$defs/X'}` anywhere else. `!supportsRecursion` rules out both.
 *    `!allowDefsRef` rules out the second — so a NON-ROOT cycle under a
 *    descriptor that forbids `$defs` (Google strict is exactly that:
 *    `supportsRecursion: true`, `allowRootRef: true`, `allowDefsRef: false`)
 *    must take the same bounded placeholder. Checking only `supportsRecursion`
 *    silently emitted the `$defs`/`$ref` pair the descriptor declares it cannot
 *    send — a schema the provider answers with HTTP 400.
 * 2. Re-encounter at root with `allowRootRef` — emit `{$ref: '#'}`.
 * 3. Otherwise — emit `{$ref: '#/$defs/<id>'}`, promoting the original
 *    target to a `$defs` entry on first share.
 */
function emitCachedRef(
  schema: z.ZodType | z.core.$ZodType,
  cachedJs: JSONSchema,
  cachedId: string,
  context: ConversionContext,
): JSONSchema {
  const descriptor = context.descriptor;
  const isCycle = context.inProgress.has(cachedId);
  const isRoot = schema === context.root;
  // The spelling this back-edge would need, and whether the descriptor has it.
  const backEdgeExpressible = isRoot ? descriptor.allowRootRef : descriptor.allowDefsRef;

  if (isCycle && (!descriptor.supportsRecursion || !backEdgeExpressible)) {
    // Replace the back-edge with a placeholder whose top-level shape matches
    // the recursive zod schema. The original `cachedJs` target keeps filling
    // in normally — once conversion completes the `$defs` entry exists; we
    // just don't reference it from here, since doing so would form the cycle
    // the provider rejects.
    return buildCycleBreakerSchema(schema, cachedId, descriptor);
  }

  if (isRoot && descriptor.allowRootRef) {
    return { $ref: `#` };
  }

  // A non-cyclic re-encounter under a descriptor with no `$defs`: INLINE the
  // already-converted shape instead of naming it. There is no third spelling in
  // that dialect — a shared node is either repeated or it is a `$ref` the
  // provider rejects. Safe and finite: `!isCycle` means this node's conversion
  // already completed, and any cycle BELOW it was replaced by the bounded
  // placeholder above, so the inlined value is a finite tree. The cost is
  // duplication in the emitted schema, which is what that dialect charges for
  // shared structure.
  //
  // On a schema the dialect can actually SEND that cost is negligible (measured
  // on the cases in `schema-google-defs.test.ts`: 497→435, 627→565, 280→322
  // bytes — inlining a leaf is often smaller than naming it). It is only large
  // on a heavily-shared recursive DAG — a gin `buildSchemas().Expr` renders
  // 44 KB with `$defs` and 1.36 MB without — and such a schema carries 1646
  // `anyOf`s, so `canExpress` already answers `false` for it and no provider
  // path reaches here. Paying size on a schema that must not be sent anyway is
  // the right side of the trade against emitting `$defs` the descriptor
  // declares it cannot send.
  if (!descriptor.allowDefsRef) {
    return { ...cachedJs };
  }

  if (!context.definitionSchemas.has(cachedId)) {
    context.definitionSchemas.set(cachedId, { ...cachedJs });
    for (const prop in cachedJs) {
      delete cachedJs[prop as keyof JSONSchema];
    }
    cachedJs.$ref = `#/$defs/${cachedId}`;
  }

  return { $ref: `#/$defs/${cachedId}` };
}

/**
 * Main conversion function
 */
function convertSchema(schema: z.ZodType | z.core.$ZodType, context: ConversionContext): JSONSchema {
  const descriptor = context.descriptor;

  // TODO: Map, Set, File, ReadOnly, Nan, Catch, Prefault, NonOptional, Transform, Function, Promise, Custom

  // Handle ZodOptional
  if (schema instanceof z.ZodOptional) {
    const innerSchema = schema.unwrap();
    const innerJson = convert(innerSchema, context);

    if (descriptor.optionalAsNullable) {
      // OpenAI-strict-style: optional fields become nullable on the wire.
      return makeNullable(innerJson, descriptor);
    } else {
      // Standard JSON Schema: optional fields are simply not in `required[]`.
      return innerJson;
    }
  }

  // Handle ZodNullable
  if (schema instanceof z.ZodNullable) {
    const innerSchema = schema.unwrap();
    const innerJson = convert(innerSchema, context);
    return makeNullable(innerJson, descriptor);
  }

  // Handle ZodObject
  if (schema instanceof z.ZodObject) {
    const properties: Record<string, JSONSchema> = {};
    const required: string[] = [];
    const shape = schema.shape;

    for (const key in shape) {
      const fieldSchema = shape[key];
      const isFieldRequired = descriptor.objectAllFieldsRequired || !isOptional(fieldSchema);

      properties[key] = convert(fieldSchema, context);

      if (isFieldRequired) {
        required.push(key);
      }
    }

    const result: JSONSchema = {
      type: 'object',
      properties,
      required,
    };

    if (descriptor.objectClosedByDefault || schema.def.catchall?._zod.def.type === "never") {
      result.additionalProperties = false;
    } else if (schema.def.catchall) {
      result.additionalProperties = convert(schema.def.catchall, context);
    }

    // Gemini 2.0 strict requires `propertyOrdering` so the model emits keys
    // in a deterministic order. Other dialects ignore this hint, so emitting
    // it under non-Google descriptors is harmless — but we gate it on the
    // descriptor flag to keep the JSON Schema minimal everywhere else.
    if (descriptor.emitPropertyOrdering) {
      result.propertyOrdering = Object.keys(properties);
    }

    return result;
  }

  // Handle ZodArray
  if (schema instanceof z.ZodArray) {
    const result: JSONSchema = {
      type: 'array',
      items: convert(schema.element, context),
    };
    if (descriptor.allowMinMaxItems) {
      const { minimum, maximum } = schema._zod.bag;
      if (typeof minimum === 'number') {
        result.minItems = minimum;
      }
      if (typeof maximum === 'number') {
        result.maxItems = maximum;
      }
    }
    return result;
  }

  // Handle ZodRecord
  if (schema instanceof z.ZodRecord) {
    if (descriptor.recordEncoding === 'array-of-pairs') {
      // Strict-mode workaround: records become arrays of {key, value} objects.
      return {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            key: convert(schema.keyType, context),
            value: convert(schema.valueType, context),
          },
          required: ['key', 'value'],
          additionalProperties: false,
        },
      };
    }

    // Standard: open record. `propertyNames` only when the key says more than
    // "a string": several grammar-compiling hosts reject the keyword outright
    // (`Unimplemented keys: ["propertyNames"]`, DeepInfra and Cloudflare via
    // OpenRouter, 2026-11-04), and for a plain string key it constrains nothing.
    const propertyNames = convert(schema.keyType, context);
    const additionalProperties = convert(schema.valueType, context);
    return Object.keys(propertyNames).some((key) => key !== 'type' && key !== 'description')
      ? { type: 'object', propertyNames, additionalProperties }
      : { type: 'object', additionalProperties };
  }

  // Handle ZodUnion
  if (schema instanceof z.ZodUnion) {
    const anyOf = schema.options.map(option => convert(option, context));
    return { anyOf };
  }

  // Handle ZodDiscriminatedUnion
  if (schema instanceof z.ZodDiscriminatedUnion) {
    const anyOf = schema.options.map(option => convert(option, context));
    return { anyOf };
  }

  // Handle ZodIntersection
  if (schema instanceof z.ZodIntersection) {
    const left = convert(schema.def.left, context);
    const right = convert(schema.def.right, context);
    const allOf = [
      ...(left.allOf && Object.keys(left).length === 1 ? left.allOf! : [left]),
      ...(right.allOf && Object.keys(right).length === 1 ? right.allOf! : [right]),
    ];

    // OpenAI strict bans allOf in some shapes; collapse to anyOf when the
    // descriptor disallows it.
    return descriptor.allowAllOf ? { allOf } : { anyOf: allOf };
  }

  // Handle ZodTuple
  if (schema instanceof z.ZodTuple) {
    const items = schema.def.items.map(item => convert(item, context));
    const rest = schema.def.rest ? convert(schema.def.rest, context) : undefined;

    // Object-numeric-keys encoding: per-position type preserved as object
    // properties. Variadic rests can't be represented this way — fall back to
    // a homogeneous array of (items ∪ rest) for that rare case.
    if (descriptor.tupleEncoding === 'object-numeric-keys' && !rest) {
      const properties: Record<string, JSONSchema> = {};
      const required: string[] = [];
      for (let i = 0; i < items.length; i++) {
        const k = String(i);
        properties[k] = isOptional(schema.def.items[i]) ? makeNullable(items[i]!, descriptor) : items[i]!;
        required.push(k);
      }
      return {
        type: 'object',
        properties,
        required,
        additionalProperties: false,
      };
    }

    const result: JSONSchema = { type: 'array' };

    if (descriptor.tupleEncoding === 'object-numeric-keys' && rest) {
      // Strict + rest fallback: every position fits one of the declared
      // types (positional info is lost — there's no way to express a
      // mixed-prefix-plus-rest array in strict-object form).
      items.push(rest);
    }

    // If all items are the same type, simplify to a single items schema
    if (items.length > 0 && items.every((item) => JSON.stringify(item) === JSON.stringify(items[0]))) {
      result.items = items[0];
    } else if (descriptor.tupleEncoding === 'prefix-items') {
      result.prefixItems = items;
    } else {
      // items-union or strict-mode-with-rest fallback: collapse to anyOf
      result.items = { anyOf: items };
    }

    if (descriptor.tupleEncoding === 'prefix-items' && rest) {
      result.additionalItems = rest;
    }
    if (!rest) {
      let minItems = items.length;
      while (minItems > 0 && isOptional(schema.def.items[minItems - 1])) {
        minItems--;
      }
      result.minItems = minItems;
      result.maxItems = items.length;
    }

    if (descriptor.allowMinMaxItems) {
      const { minimum, maximum } = schema._zod.bag;
      if (typeof minimum === 'number') {
        result.minItems = minimum;
      }
      if (typeof maximum === 'number') {
        result.maxItems = maximum;
      }
    }

    return result;
  }

  // Handle ZodEnum
  if (schema instanceof z.ZodEnum) {
    const values = enumEmittedValues(schema);
    // Over the dialect's cap the `enum` keyword is DROPPED and the node widens
    // to its plain scalar type, with every value listed in the description —
    // see `describeOversizeEnum` for why widening beats truncating.
    const oversize = describeOversizeEnum(values, descriptor);
    return {
      type: values.every((v) => typeof v === 'number')
        ? 'number'
        : values.every((v) => typeof v === 'string')
          ? 'string'
          : undefined,
      ...(oversize === undefined ? { enum: values } : { description: oversize }),
    };
  }

  // Handle ZodLiteral
  if (schema instanceof z.ZodLiteral) {
    const values = literalEmittedValues(schema);
    const types = Array.from(new Set(values.map(v => v === null ? 'null' : typeof v) as ('string' | 'number' | 'boolean' | 'null')[]));
    // A multi-value literal emits the SAME `enum` keyword as ZodEnum, so the
    // dialect cap applies identically — the provider sees no difference. The
    // single-value form emits `const`, which no cap can be exceeded by.
    const oversize = values.length === 1 ? undefined : describeOversizeEnum(values, descriptor);

    return {
      ...(types.length === 1 ? { type: types[0] } : {}),
      ...(values.length === 1
        ? { const: values[0] }
        : oversize === undefined ? { enum: values } : { description: oversize }),
    };
  }

  // Handle ZodDefault
  if (schema instanceof z.ZodDefault) {
    const innerJson = convert(schema.def.innerType, context);
    innerJson.default = JSON.parse(JSON.stringify(schema.def.defaultValue));
    return innerJson;
  }

  // Handle ZodLazy - don't unwrap here, let convert() handle caching
  if (schema instanceof z.ZodLazy) {
    throw new Error('ZodLazy should be handled in convert(), not convertSchema()');
  }

  // Handle ZodCodec
  if (schema instanceof z.ZodCodec) {
    return convert(schema.def.in, context);
  }

  // Handle ZodPipe (from preprocess)
  if (schema instanceof z.ZodPipe) {
    const innerType = schema.def.in._zod.def.type === "transform" ? schema.def.out : schema.def.in;
    return convert(innerType, context);
  }

  // Handle primitive types
  if (schema instanceof z.ZodString) {
    const result: JSONSchema = { type: 'string' };

    const { minimum, maximum, format, patterns, contentEncoding } = schema._zod.bag;

    // Format: emit only when allowed by the descriptor.
    if (typeof format === 'string' && emitsFormat(format, descriptor)) {
      result.format = format;
    }

    if (descriptor.allowMinMaxLength) {
      if (typeof minimum === 'number') {
        result.minLength = minimum;
      }
      if (typeof maximum === 'number') {
        result.maxLength = maximum;
      }
    }

    if (typeof contentEncoding === 'string' && descriptor.allowMinMaxLength) {
      // contentEncoding piggybacks on the lenient gate (it's not a strict-mode-safe field)
      result.contentEncoding = contentEncoding;
    }

    if (patterns && descriptor.allowPattern) {
      if (patterns.size === 1 || !descriptor.allowMultiplePatterns) {
        result.pattern = Array.from(patterns)[0].source;
      } else {
        result.allOf = Array.from(patterns).map((regex) => ({
          type: 'string',
          pattern: regex.source,
        }));
      }
    }

    return result;
  }

  if (schema instanceof z.ZodNumber) {
    const result: JSONSchema = { type: 'number' };

    const { minimum, maximum, format, multipleOf, exclusiveMaximum, exclusiveMinimum } = schema._zod.bag;
    if (typeof format === 'string' && format.includes("int")) {
      result.type = 'integer';
    }

    if (descriptor.allowMinimumMaximum) {
      if (typeof exclusiveMinimum === 'number') {
        result.exclusiveMinimum = exclusiveMinimum;
      } else if (typeof minimum === 'number') {
        result.minimum = minimum;
      }
      if (typeof exclusiveMaximum === 'number') {
        result.exclusiveMaximum = exclusiveMaximum;
      } else if (typeof maximum === 'number') {
        result.maximum = maximum;
      }
      if (typeof multipleOf === 'number') {
        result.multipleOf = multipleOf;
      }
    }

    return result;
  }

  if (schema instanceof z.ZodBoolean || schema instanceof z.ZodSuccess) {
    return { type: 'boolean' };
  }

  if (schema instanceof z.ZodBigInt) {
    return { type: 'integer' };
  }

  if (schema instanceof z.ZodDate || schema instanceof z.ZodISODateTime) {
    return stringWithFormat('date-time', descriptor);
  }

  if (schema instanceof z.ZodISODate) {
    return stringWithFormat('date', descriptor);
  }

  if (schema instanceof z.ZodISOTime) {
    return stringWithFormat('time', descriptor);
  }

  if (schema instanceof z.ZodISODuration) {
    return stringWithFormat('duration', descriptor);
  }

  if (schema instanceof z.ZodEmail) {
    return stringWithFormat('email', descriptor);
  }

  if (schema instanceof z.ZodIPv4) {
    return stringWithFormat('ipv4', descriptor);
  }

  if (schema instanceof z.ZodIPv6) {
    return stringWithFormat('ipv6', descriptor);
  }

  if (schema instanceof z.ZodUUID) {
    return stringWithFormat('uuid', descriptor);
  }

  if (schema instanceof z.ZodNull) {
    return { type: 'null' };
  }

  if (schema instanceof z.ZodTemplateLiteral) {
    return { type: 'string', pattern: schema._zod.pattern?.source };
  }

  if (schema instanceof z.ZodUndefined) {
    return { type: 'null' }; // Treat undefined as null in JSON
  }

  if (schema instanceof z.ZodAny || schema instanceof z.ZodUnknown) {
    // Bare `{}` would satisfy the meaning of "any" but OpenAI's strict
    // structured-output mode rejects schemas without a `type` key. For
    // descriptors with a recursive Any encoding, promote to a single shared
    // `$defs/Any` definition that covers every JSON value and return a
    // `$ref` — sharing keeps the output compact when `z.any()` appears many
    // times inside a big union. For descriptors with `flat` Any encoding
    // (e.g. Anthropic, which rejects recursive `$defs` graphs) or `unconstrained`
    // (Google, which rejects both `anyOf` and named `$defs`), inline the
    // permissive shape directly so the schema stays acyclic and `$defs`-free.
    if (!usesSharedAnyDefinition(descriptor)) {
      return buildAnyValueSchema(descriptor);
    }
    const id = 'Any';
    if (!context.definitionSchemas.has(id)) {
      // Seed a placeholder BEFORE building the body so recursive
      // `$ref: '#/$defs/Any'` references don't infinite-loop during
      // construction.
      context.definitionSchemas.set(id, {});
      context.definitionSchemas.set(id, buildAnyValueSchema(descriptor));
    }
    return { $ref: `#/$defs/${id}` };
  }

  if (schema instanceof z.ZodTransform) {
    return {}; // Transforms are not represented in JSON Schema
  }

  // Fallback for unknown types
  console.warn(`Unknown Zod schema type: ${schema.constructor.name}`);

  return {};
}

/**
 * Makes a JSON Schema nullable: `z.nullable()` under every dialect, and
 * `z.optional()` under one that spells optional as nullable (OpenAI strict).
 *
 * The null joins as an `anyOf` branch wherever the dialect has `anyOf`. A
 * `["T", "null"]` type array is the spelling of last resort: o3's strict
 * function validator rejects it ("schema must have a 'type' key", measured
 * 2026-11-05) where the `anyOf` form passes.
 */
function makeNullable(schema: JSONSchema, descriptor: FormatDescriptor): JSONSchema {
  // The empty schema already admits null
  if (Object.keys(schema).length === 0) {
    return schema;
  }

  if (schema.$ref) {
    return {
      anyOf: [
        { $ref: schema.$ref },
        { type: 'null' },
      ],
    };
  }

  if (schema.type) {
    const hasTypeSpecificProps =
      schema.items !== undefined ||
      schema.properties !== undefined ||
      schema.additionalProperties !== undefined ||
      schema.patternProperties !== undefined ||
      schema.minItems !== undefined ||
      schema.maxItems !== undefined ||
      schema.minProperties !== undefined ||
      schema.maxProperties !== undefined;

    if (hasTypeSpecificProps || (descriptor.allowAnyOf && !Array.isArray(schema.type) && schema.type !== 'null')) {
      const { type, description, ...rest } = schema;
      const baseType = Array.isArray(type) ? type[0] : type;

      return {
        anyOf: [
          { type: baseType, ...rest },
          { type: 'null' },
        ],
        ...(description ? { description } : {}),
      };
    }

    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.includes('null')) {
      return {
        ...schema,
        type: [...types, 'null'],
      };
    }
    return schema;
  }

  if (schema.anyOf) {
    const hasNull = schema.anyOf.some((s) => s.type === 'null');
    if (!hasNull) {
      return {
        ...schema,
        anyOf: [...schema.anyOf, { type: 'null' }],
      };
    }
    return schema;
  }

  return {
    anyOf: [
      schema,
      { type: 'null' },
    ],
  };
}

function isOptional(schema: z.ZodType | z.core.$ZodType): boolean {
  return schema._zod.optin !== undefined;
}

/**
 * The `format` values JSON Schema (2020-12) defines, which is what `'all'`
 * passes through. Zod's own check names (`regex` for `.regex()`, `cuid`,
 * `starts_with`, …) share the field but are not formats: a grammar-compiling
 * host rejects them (`Unknown format: regex`, DeepInfra via OpenRouter,
 * 2026-11-04), so they are never emitted.
 */
const JSON_SCHEMA_FORMATS = new Set([
  'date-time', 'date', 'time', 'duration', 'email', 'idn-email', 'hostname', 'idn-hostname',
  'ipv4', 'ipv6', 'uri', 'uri-reference', 'iri', 'iri-reference', 'uuid', 'uri-template',
  'json-pointer', 'relative-json-pointer',
]);

/**
 * Whether `format` may be emitted under the descriptor's whitelist.
 */
function emitsFormat(format: string, descriptor: FormatDescriptor): boolean {
  const formats = descriptor.supportedStringFormats;
  return formats === 'all' ? JSON_SCHEMA_FORMATS.has(format) : formats.has(format);
}

/**
 * Emit a `{ type: 'string', format: ... }` JSON Schema, dropping the format
 * when the descriptor's whitelist excludes it. The string type is always
 * preserved; only the format hint is gated.
 */
function stringWithFormat(format: string, descriptor: FormatDescriptor): JSONSchema {
  return emitsFormat(format, descriptor) ? { type: 'string', format } : { type: 'string' };
}
