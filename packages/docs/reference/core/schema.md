# @aeye/core — Schema Utilities

Utilities for working with Zod schemas and JSON Schema conversion.

## `toJSONSchema(schema, options?)`

Convert a Zod schema to JSON Schema:

```typescript
import { toJSONSchema } from '@aeye/core';
import z from 'zod';

const schema = z.object({
  name: z.string().describe('User name'),
  age: z.number().min(0).max(150),
  role: z.enum(['admin', 'user']),
});

const jsonSchema = toJSONSchema(schema);
// {
//   type: 'object',
//   properties: {
//     name: { type: 'string', description: 'User name' },
//     age: { type: 'number' },
//     role: { type: 'string', enum: ['admin', 'user'] },
//   },
//   required: ['name', 'age', 'role'],
// }
```

### Options

```typescript
interface ToJSONSchemaOptions {
  format?: JSONSchemaFormat; // 'openai' for OpenAI-compatible output
}
```

Pass `true` as a shorthand for `{ format: 'openai' }`.

## `strictify(schema)`

Transform a Zod schema for strict JSON Schema compliance (required by OpenAI's structured outputs):

```typescript
import { strictify } from '@aeye/core';

const strict = strictify(z.object({
  name: z.string(),
  bio: z.string().optional(),
}));

// In strict mode:
// - All properties become required
// - Optional properties get default values
// - additionalProperties: false is set
```

This is applied automatically when `strict: true` (default) on prompts.

## `transferMetadata(target, source)`

Transfer Zod schema metadata (description, etc.) from one schema to another:

```typescript
const withDesc = z.string().describe('A name');
const plain = z.string();
const result = transferMetadata(plain, withDesc);
// result has the description from withDesc
```

## JSON Schema Types

```typescript
type JSONSchemaFormat = 'openai';

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
