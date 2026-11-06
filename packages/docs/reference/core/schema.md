# @aeye/core — Schema Utilities

Utilities for converting Zod schemas to each provider's JSON Schema dialect. Most apps never call these: `@aeye/ai` picks a `FormatDescriptor` per request from the chosen model. See the [Strict Mode guide](/guides/strict-mode) for the dialects.

## `toJSONSchema(schema, options)`

Convert a Zod schema to JSON Schema under a dialect. `options` is a `FormatDescriptor`, a `{ strict, format? }` object, or a boolean (`true` ⇒ `OPENAI_STRICT`, `false` ⇒ `LENIENT`):

```typescript
import { toJSONSchema, LENIENT, ANTHROPIC_STRICT } from '@aeye/core';
import z from 'zod';

const schema = z.object({
  name: z.string().describe('User name'),
  age: z.number().min(0).max(150),
  role: z.enum(['admin', 'user']),
  nickname: z.string().nullable(),
});

toJSONSchema(schema, LENIENT);
// {
//   type: 'object',
//   properties: {
//     name: { type: 'string', description: 'User name' },
//     age: { type: 'number', minimum: 0, maximum: 150 },
//     role: { type: 'string', enum: ['admin', 'user'] },
//     nickname: { anyOf: [{ type: 'string' }, { type: 'null' }] },
//   },
//   required: ['name', 'age', 'role', 'nickname'],
// }

toJSONSchema(schema, ANTHROPIC_STRICT);
// same, but `age` loses its bounds and the object gets additionalProperties: false
```

Under every dialect:

- `z.nullable()` admits `null`, as an `anyOf` branch where the dialect has `anyOf`.
- Only formats JSON Schema defines are emitted (`date-time`, `email`, `uri`, …), filtered by the dialect's whitelist. Zod's check names such as `regex` (from `.regex()`) are never emitted as a `format`.
- An open record with a plain string key has no `propertyNames`.

### Options

```typescript
interface ToJSONSchemaOptions {
  strict: boolean;
  format?: DescriptorFamily; // 'openai' | 'anthropic' | 'google' | 'xai' | any registered family
}
```

## `strictify(schema, descriptor?)`

Rewrite a Zod schema so it accepts the dialect's wire shape (array-of-pairs records, numeric-key tuples, `null` for optionals) and normalizes it back to the natural shape. `descriptor` defaults to `OPENAI_STRICT`; `LENIENT` returns the schema unchanged. Results are cached per `(schema, descriptor)`.

```typescript
import { strictify, OPENAI_STRICT } from '@aeye/core';

const wire = strictify(z.object({
  name: z.string(),
  bio: z.string().optional(),   // accepts null on the wire, parses to undefined
}), OPENAI_STRICT);
```

A schema named with `.meta({ id })` works: the clone carries the id as `aid`, which names the same `$defs` entry (zod's registry refuses a second schema with the same `id`).

Providers apply this automatically, so the validator sees the shape the model was sent.

## `canExpress(schema, descriptor)`

Whether `schema` can go out as structured output under `descriptor`. With `schemaDelivery: 'auto'`, a schema that can't is sent as prompt text instead. Under Anthropic strict this is `false` for `z.any()`, `z.unknown()`, recursion, and a schema over the strict limits on its own (Anthropic compiles every structured output).

## Descriptors

`OPENAI_STRICT`, `ANTHROPIC_STRICT`, `GOOGLE_STRICT`, `XAI_STRICT`, `LENIENT` and the non-strict family variants, plus `getDescriptor(family, strict)`, `getDescriptorById(id)`, `registerDescriptor(descriptor)`, `analyzeSchema(schema)`, `checkSchemaSizeLimits(schema, descriptor)` and `SchemaBudget`. See the [`@aeye/core` README](https://github.com/ClickerMonkey/aeye/blob/main/packages/core/README.md#strict-mode).

## JSON Schema Types

```typescript
type JSONSchemaFormat = DescriptorFamily;

type JSONSchemaType = 'string' | 'number' | 'integer' | 'boolean' |
                      'array' | 'object' | 'null';

interface JSONSchema {
  type?: JSONSchemaType | JSONSchemaType[];
  properties?: Record<string, JSONSchema>;
  required?: string[];
  items?: JSONSchema;
  enum?: any[];
  const?: any;
  description?: string;
  default?: any;
  additionalProperties?: boolean | JSONSchema;
  oneOf?: JSONSchema[];
  anyOf?: JSONSchema[];
  allOf?: JSONSchema[];
  // ... and more
}
```
