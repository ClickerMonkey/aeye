import z from 'zod';


type StrictTransformer = (schema: z.ZodType | z.core.$ZodType) => z.ZodType;

/**
* Recursively transforms a Zod schema to support strict mode.
*
* @param schema - input Zod schema
* @returns transformed Zod schema
*/
export function strictify<S extends z.ZodType>(schema: S): S {
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
    result = strictifySimple(s, transform);
    map.set(s, result);
    return result;
  };

  return transform(schema) as S;
}

/**
* Transfer description and metadata from source Zod schema to target Zod schema
* 
* @param target - target Zod schema
* @param source - source Zod schema
* @returns 
*/
function transferMetadata(target: z.ZodType, source: z.ZodType) {
  if (source.description) {
    target = target.describe(source.description);
  }
  const meta = source.meta();
  if (meta) {
    target = target.meta(meta);
  }
  return target;
}

/**
 * Extracts the input schema from a transformed schema (codec or preprocess).
 * For preprocess with optional, we need the nullable version for strict mode input.
 * This is needed when building input schemas that contain transformed fields.
 */
function getInputSchema(schema: z.ZodType): z.ZodType {
  if (schema instanceof z.ZodCodec) {
    return schema.def.in as z.ZodType;
  }
  // For ZodPipe (which preprocess creates), check if the output is optional
  // If so, we need to return a nullable version for the input schema
  if (schema instanceof z.ZodPipe) {
    const outputSchema = schema.def.out;
    if (outputSchema instanceof z.ZodOptional) {
      // The input from preprocess is already set up to handle null->undefined conversion
      // So we just need to make sure the base type accepts null
      return z.nullable(outputSchema.unwrap());
    }
  }
  return schema;
}

/**
* Recursively transforms a Zod schema to support strict mode.
* 
* @param schema - input Zod schema
* @returns transformed Zod schema
*/
function strictifySimple(
  schema: z.ZodType | z.core.$ZodType,
  transform: StrictTransformer,
): z.ZodType {
  // Handle ZodOptional - get the inner schema and make it optional
  if (schema instanceof z.ZodOptional) {
    const innerSchema = schema.unwrap();
    const transformed = transform(innerSchema);

    // Check if the inner schema is nullable
    // If it's nullable, don't convert null to undefined
    const isNullable = innerSchema instanceof z.ZodNullable;

    // Use a preprocess to convert null to undefined only for non-nullable schemas
    // This avoids issues with codec output validation in recursive schemas
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
    return transferMetadata(
      z.object(transformedShape), 
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
  if (schema instanceof z.ZodRecord) {
    const keyTransformed = schema.keyType ? transform(schema.keyType) as z.ZodType<PropertyKey, PropertyKey> : z.string();
    const valueTransformed = transform(schema.valueType);

    // For the input schema (array of {key, value}), use the input side of any codecs
    const key = getInputSchema(keyTransformed);
    const value = getInputSchema(valueTransformed);

    return transferMetadata(
      z.codec(
        z.array(z.object({ key, value })),
        z.record(keyTransformed, valueTransformed),
        {
          decode: (arr) => {
            const record: Record<PropertyKey, any> = {};
            for (const { key, value } of arr) {
              record[key as PropertyKey] = value;
            }
            return record;
          },
          encode: (rec) => Object.entries(rec).map(
            ([key, value]) => ({ key, value })
          ),
        }
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
  if (schema instanceof z.ZodTuple) {
    return transferMetadata(
      z.tuple(schema.def.items.map(transform) as [z.ZodType, ...z.ZodType[]]), 
      schema
    );
  }
  
  // Handle ZodEffects (transforms, refines, etc.)
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

/**
 * Format specification for JSON Schema generation
 */
export type JSONSchemaFormat = 'openai';

/**
 * Options for toJSONSchemaV2
 */
export interface ToJSONSchemaOptions {
  /**
   * Whether to use strict mode (all fields required, additionalProperties: false)
   */
  strict: boolean;
  /**
   * The target format for the JSON Schema. Currently only 'openai' is supported.
   * Different formats may have different constraints and supported features.
   */
  format?: JSONSchemaFormat;
}

export type JSONSchemaType = 'string' | 'number' | 'boolean' | 'array' | 'object' | 'null' | 'integer';

/**
 * JSON Schema type definition
 */
export interface JSONSchema {
  type?: JSONSchemaType | JSONSchemaType[];
  properties?: Record<string, JSONSchema>;
  items?: JSONSchema;
  prefixItems?: JSONSchema[];
  required?: string[];
  additionalProperties?: boolean | JSONSchema;
  propertyNames?: JSONSchema;
  enum?: any[];
  anyOf?: JSONSchema[];
  allOf?: JSONSchema[];
  additionalItems?: boolean | JSONSchema;
  not?: JSONSchema;
  $ref?: string;
  description?: string;
  default?: any;
  pattern?: string;
  format?: string;
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  exclusiveMaximum?: number;
  multipleOf?: number;
  minItems?: number;
  maxItems?: number;
  const?: any;
  title?: string;
  $defs?: Record<string, JSONSchema>;
  [metadata: string]: unknown;
}

/**
 * Context for recursive schema conversion
 */
interface ConversionContext {
  root: z.ZodType,
  strict: boolean;
  format: JSONSchemaFormat;
  definitions: Map<z.ZodType | z.core.$ZodType, [JSONSchema, string]>; // schema to [js, id]
  definitionSchemas: Map<string, JSONSchema>; // id to schema
  refCounter: number;
  path: string[];
}

/**
 * Converts a Zod schema to JSON Schema V2 with support for different provider formats.
 *
 * This is a custom implementation that recursively inspects Zod schemas and converts them
 * to JSON Schema following the pattern of strictify/strictifySimple.
 *
 * @param schema - The Zod schema to convert
 * @param options - Configuration options for the conversion
 * @returns JSON Schema object compatible with the specified format
 *
 * @example
 * ```typescript
 * const schema = z.object({
 *   name: z.string(),
 *   age: z.number().optional(),
 * });
 *
 * // For OpenAI strict mode
 * const strictSchema = strictify(schema);
 * const jsonSchema = toJSONSchemaV2(strictSchema, { strict: true, format: 'openai' });
 * ```
 */
export function toJSONSchema(
  schema: z.ZodType, 
  options: ToJSONSchemaOptions | boolean 
): JSONSchema {
  const resolvedOptions = typeof options === 'boolean' ? { strict: options } : options;
  const { strict, format = 'openai' } = resolvedOptions;

  // Currently only OpenAI format is supported
  if (format !== 'openai') {
    throw new Error(`Unsupported format: ${format}. Currently only 'openai' is supported.`);
  }

  const context: ConversionContext = {
    root: schema,
    strict,
    format,
    definitions: new Map(),
    definitionSchemas: new Map(),
    refCounter: 0,
    path: [],
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

  // Check if this is a lazy schema and extract metadata early
  if (schema instanceof z.ZodLazy) {
    // Check cache FIRST before evaluating getter to prevent infinite recursion
    const [cachedJs, cachedId] = context.definitions.get(schema) || [];
    if (cachedJs && cachedId) {
      if (schema === context.root) {
        return { $ref: `#` };
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

    const metadata = (schema instanceof z.ZodType) ? schema.meta() : null;
    const aid = metadata?.aid;

    // If there's an aid, check if we've already seen this aid
    if (aid) {
      for (const [cachedSchema, [js, jsId]] of context.definitions.entries()) {
        if (cachedSchema instanceof z.ZodType) {
          const cachedMeta = cachedSchema.meta();
          if (cachedMeta?.aid === aid && jsId && js) {
            // Found a cached version with the same aid - use it
            if (schema === context.root) {
              return { $ref: `#` };
            }

            if (!context.definitionSchemas.has(jsId)) {
              context.definitionSchemas.set(jsId, { ...js });
              for (const prop in js) {
                delete js[prop as keyof JSONSchema];
              }
              js.$ref = `#/$defs/${jsId}`;
            }

            return { $ref: `#/$defs/${jsId}` };
          }
        }
      }
    }

    unwrappedSchema = schema.def.getter();
  } else {
    // Check cache by object identity for non-lazy schemas
    const [js, jsId] = context.definitions.get(schema) || [];
    if (jsId && js) {
      if (schema === context.root) {
        return { $ref: `#` };
      }

      if (!context.definitionSchemas.has(jsId)) {
        context.definitionSchemas.set(jsId, { ...js });
        for (const prop in js) {
          delete js[prop as keyof JSONSchema];
        }
        js.$ref = `#/$defs/${jsId}`;
      }

      return { $ref: `#/$defs/${jsId}` };
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

  // If the schema has an 'aid' or 'id' in meta, promote it to a definition
  const id = (metadata.aid ? String(metadata.aid) : 0) || metadata.id || `__schema${context.refCounter++}`;
  const save = !!(metadata.aid || metadata.id) && context.root !== schema;

  // A schema target - will hold either the converted schema or a $ref
  const target: JSONSchema = {};

  // Before converting, register this schema to handle recursion
  context.definitions.set(cacheKey, [target, id]);

  // Convert the unwrapped schema
  const result = convertSchema(unwrappedSchema, context);
  Object.assign(result, metadata);
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
 * Main conversion function
 */
function convertSchema(schema: z.ZodType | z.core.$ZodType, context: ConversionContext): JSONSchema {
  // TODO: Map, Set, File, ReadOnly, Nan, Catch, Prefault, NonOptional, Transform, Function, Promise, Custom

  // Handle ZodOptional
  if (schema instanceof z.ZodOptional) {
    const innerSchema = schema.unwrap();
    const innerJson = convert(innerSchema, context);

    if (context.strict) {
      // In strict mode, optional fields become nullable
      return makeNullable(innerJson);
    } else {
      // In non-strict mode, optional fields are just not required
      return innerJson;
    }
  }

  // Handle ZodNullable
  if (schema instanceof z.ZodNullable) {
    const innerSchema = schema.unwrap();
    const innerJson = convert(innerSchema, context);
    return makeNullable(innerJson);
  }

  // Handle ZodObject
  if (schema instanceof z.ZodObject) {
    const properties: Record<string, JSONSchema> = {};
    const required: string[] = [];
    const shape = schema.shape;

    for (const key in shape) {
      const fieldSchema = shape[key];
      const isRequired = context.strict || !isOptional(fieldSchema);
      
      properties[key] = convert(fieldSchema, context);

      if (isRequired) {
        required.push(key);
      }
    }

    const result: JSONSchema = {
      type: 'object',
      properties,
      required,
    };

    if (context.strict || schema.def.catchall?._zod.def.type === "never") {
      result.additionalProperties = false;
    } else if (schema.def.catchall) {
      result.additionalProperties = convert(schema.def.catchall, context);
    }

    return result;
  }

  // Handle ZodArray
  if (schema instanceof z.ZodArray) {
    const result: JSONSchema = {
      type: 'array',
      items: convert(schema.element, context),
    };
    const { minimum, maximum } = schema._zod.bag;
    if (typeof minimum === 'number') {
      result.minItems = minimum;
    }
    if (typeof maximum === 'number') {
      result.maxItems = maximum;
    }
    return result;
  }

  // Handle ZodRecord - convert to array of {key, value} pairs in strict mode
  if (schema instanceof z.ZodRecord) {
    if (context.strict) {
      // In strict mode, records become arrays of {key, value} objects
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
    } else {
      // In non-strict mode, use additionalProperties
      return {
        type: 'object',
        propertyNames: convert(schema.keyType, context),
        additionalProperties: convert(schema.valueType, context),
      };
    }
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

  // Handle ZodIntersection - not supported in OpenAI strict mode, convert to anyOf
  if (schema instanceof z.ZodIntersection) {
    const left = convert(schema.def.left, context);
    const right = convert(schema.def.right, context);
    const allOf = [
      ...(left.allOf && Object.keys(left).length === 1 ? left.allOf! : [left]),
      ...(right.allOf && Object.keys(right).length === 1 ? right.allOf! : [right]),
    ];

    // TODO merge types to support allOf directly for strict mode
    return context.strict ? { anyOf: allOf } : { allOf };
  }

  // Handle ZodTuple
  if (schema instanceof z.ZodTuple) {
    // Tuples in JSON Schema can be represented as arrays with prefixItems
    // For simplicity, we'll use an array type
    const items = schema.def.items.map(item => convert(item, context));
    const rest = schema.def.rest ? convert(schema.def.rest, context) : undefined;
    const result: JSONSchema = { type: 'array' };

    if (context.strict && rest) {
      items.push(rest);
    }

    // If all items are the same type, simplify to a single items schema
    if (items.length > 0 && items.every((item) => JSON.stringify(item) === JSON.stringify(items[0]))) {
      result.items = items[0];
    } else {
      if (context.strict) {
        result.items = { anyOf: items };
      } else {
        result.prefixItems = items;
      }
    }

    if (!context.strict && rest) {
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

    const { minimum, maximum } = schema._zod.bag;
    if (typeof minimum === 'number') {
      result.minItems = minimum;
    }
    if (typeof maximum === 'number') {
      result.maxItems = maximum;
    }

    return result;
  }

  // Handle ZodEnum
  if (schema instanceof z.ZodEnum) {
    const numericValues = Object.values(schema.def.entries).filter((v) => typeof v === "number");
    const values = Object.entries(schema.def.entries)
        .filter(([k, _]) => numericValues.indexOf(+k) === -1)
        .map(([_, v]) => v);
    return {
      type: values.every((v) => typeof v === 'number') 
        ? 'number' 
        : values.every((v) => typeof v === 'string') 
          ? 'string' 
          : undefined,
      enum: values,
    };
  }

  // Handle ZodLiteral
  if (schema instanceof z.ZodLiteral) {
    const values = Array.from(schema.values).filter(v => v !== undefined && typeof v !== 'function' && typeof v !== 'symbol' && typeof v !== 'bigint');
    const types = Array.from(new Set(values.map(v => v === null ? 'null' : typeof v) as ('string' | 'number' | 'boolean' | 'null')[]));
    
    return {
      ...(types.length === 1 ? { type: types[0] } : {}),
      ...(values.length === 1 ? { const: values[0] } : { enum: values }),
    };
  }

  // Handle ZodDefault
  if (schema instanceof z.ZodDefault) {
    const innerJson = convert(schema.def.innerType, context);
    innerJson.default = JSON.parse(JSON.stringify(schema.def.defaultValue));
    return innerJson;
  }

  // Handle ZodLazy - don't unwrap here, let convert() handle caching
  // Just return empty schema since ZodLazy should be handled at convert() level
  if (schema instanceof z.ZodLazy) {
    // This shouldn't be reached because convert() handles ZodLazy before calling convertSchema
    throw new Error('ZodLazy should be handled in convert(), not convertSchema()');
  }

  // Handle ZodCodec
  if (schema instanceof z.ZodCodec) {
    // For codecs, use the input schema for JSON Schema generation
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

    if (context.strict) {
      const strictFormats = ['date-time', 'time', 'date', 'duration', 'email', 'hostname', 'ipv4', 'ipv6', 'uuid'];
      if (typeof format === 'string' && strictFormats.includes(format)) {
        result.format = format;
      }

      if (patterns && patterns.size > 0) {
        result.pattern = Array.from(patterns)[0].source;
      }  
    } else {
      if (typeof minimum === 'number') {
        result.minLength = minimum;
      }
      if (typeof maximum === 'number') {
        result.maxLength = maximum;
      }
      if (typeof format === 'string') {
        result.format = format;
      }
      if (typeof contentEncoding === 'string') {
        result.contentEncoding = contentEncoding;
      }
      if (patterns) {
        if (patterns.size === 1) {
          result.pattern = Array.from(patterns)[0].source;
        } else {
          result.allOf = Array.from(patterns).map((regex) => ({
            type: 'string',
            pattern: regex.source,
          }));
        }
      }
    }

    return result;
  }

  if (schema instanceof z.ZodNumber) {
    const result: JSONSchema = { type: 'number' };

    // Add number constraints if present
    const { minimum, maximum, format, multipleOf, exclusiveMaximum, exclusiveMinimum } = schema._zod.bag;
    if (typeof format === 'string' && format.includes("int")) {
      result.type = 'integer';
    }
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

    return result;
  }

  if (schema instanceof z.ZodBoolean || schema instanceof z.ZodSuccess) {
    return { type: 'boolean' };
  }

  if (schema instanceof z.ZodBigInt) {
    return { type: 'integer' };
  }

  if (schema instanceof z.ZodDate || schema instanceof z.ZodISODateTime) {
    return { type: 'string', format: 'date-time' };
  }

  if (schema instanceof z.ZodISODate) {
    return { type: 'string', format: 'date' };
  }

  if (schema instanceof z.ZodISOTime) {
    return { type: 'string', format: 'time' };
  }

  if (schema instanceof z.ZodISODuration) {
    return { type: 'string', format: 'duration' };
  }

  if (schema instanceof z.ZodEmail) {
    return { type: 'string', format: 'email' };
  }

  if (schema instanceof z.ZodIPv4) {
    return { type: 'string', format: 'ipv4' };
  }

  if (schema instanceof z.ZodIPv6) {
    return { type: 'string', format: 'ipv6' };
  }

  if (schema instanceof z.ZodUUID) {
    return { type: 'string', format: 'uuid' };
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
    // structured-output mode rejects schemas without a `type` key. Instead,
    // promote to a single shared `$defs/Any` definition that covers every
    // JSON value in a strict-mode-compatible way, and return a `$ref` to it.
    // Sharing via `$defs` also keeps the output compact when `z.any()`
    // appears many times inside a big union (avoids schema explosion).
    const id = 'Any';
    if (!context.definitionSchemas.has(id)) {
      // Seed a placeholder BEFORE building the body so recursive
      // `$ref: '#/$defs/Any'` references don't infinite-loop during
      // construction.
      context.definitionSchemas.set(id, {});
      context.definitionSchemas.set(id, buildAnyValueSchema(context.strict));
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
 * Builds the body of the shared `$defs/Any` schema — a self-recursive
 * `anyOf` covering every JSON value in a strict-mode-compatible way.
 *
 * In strict mode, open-ended objects (`additionalProperties` anything
 * other than `false`) are rejected by OpenAI's structured-output
 * validator, so "arbitrary object" is represented as an array of
 * `{key, value}` pairs — the same workaround already used for
 * `ZodRecord` in strict mode. Non-strict mode gets the more intuitive
 * open-record shape.
 */
function buildAnyValueSchema(strict: boolean): JSONSchema {
  const selfRef: JSONSchema = { $ref: '#/$defs/Any' };
  const branches: JSONSchema[] = [
    { type: 'string' },
    { type: 'number' },
    { type: 'boolean' },
    { type: 'null' },
    { type: 'array', items: selfRef },
  ];
  if (strict) {
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
  } else {
    branches.push({
      type: 'object',
      additionalProperties: selfRef,
    });
  }
  return { anyOf: branches };
}

/**
 * Makes a JSON Schema nullable by adding null to the type
 */
function makeNullable(schema: JSONSchema): JSONSchema {
  if (schema.$ref) {
    // If it's a reference, wrap in anyOf with null
    return {
      anyOf: [
        { $ref: schema.$ref },
        { type: 'null' },
      ],
    };
  }

  if (schema.type) {
    // Check if schema has type-specific properties that require anyOf structure
    // Arrays have 'items', objects have 'properties', etc.
    const hasTypeSpecificProps =
      schema.items !== undefined ||
      schema.properties !== undefined ||
      schema.additionalProperties !== undefined ||
      schema.patternProperties !== undefined ||
      schema.minItems !== undefined ||
      schema.maxItems !== undefined ||
      schema.minProperties !== undefined ||
      schema.maxProperties !== undefined;

    // If there are type-specific properties, must use anyOf to separate type schemas
    if (hasTypeSpecificProps) {
      // Extract type-specific properties based on the type
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

    // For simple types without type-specific properties, can use array notation
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
    // Already has anyOf, add null option if not present
    const hasNull = schema.anyOf.some((s) => s.type === 'null');
    if (!hasNull) {
      return {
        ...schema,
        anyOf: [...schema.anyOf, { type: 'null' }],
      };
    }
    return schema;
  }

  // For complex schemas without type, wrap in anyOf
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