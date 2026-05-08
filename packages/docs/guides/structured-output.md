# Structured Output

@aeye can enforce that AI responses conform to a Zod schema, giving you type-safe structured data instead of free-form text.

## Basic Usage

```typescript
import z from 'zod';

const analyzer = ai.prompt({
  name: 'analyzer',
  description: 'Analyze text sentiment',
  content: 'Analyze the sentiment of: {{text}}',
  input: (input: { text: string }) => ({ text: input.text }),
  schema: z.object({
    sentiment: z.enum(['positive', 'negative', 'neutral']),
    confidence: z.number().min(0).max(1),
    keywords: z.array(z.string()),
  }),
});

const result = await analyzer.get('result', {
  text: 'This product is amazing!',
});

// result is fully typed:
// { sentiment: 'positive', confidence: 0.95, keywords: ['amazing'] }
```

## How It Works

1. The Zod schema is converted to JSON Schema
2. Sent as `responseFormat` to the AI model
3. The model generates JSON conforming to the schema
4. @aeye parses and validates the response with Zod
5. If validation fails, the prompt retries with an error message

## Strict Mode

`Prompt.strict` is `boolean | number` (default: `1`):

| Value | Meaning |
|---|---|
| `true` | Hard requirement — selection filters to strict-capable models. |
| `false` | Force lenient. Standard JSON Schema, no `strict` flag on the wire. |
| `number > 0` (default `1`) | Best-effort preference. Strict on models that support it, lenient fallback elsewhere. |

```typescript
const prompt = ai.prompt({
  schema: z.object({ /* ... */ }),
  // strict omitted → priority 1 (best-effort, default)
});

const strictPrompt = ai.prompt({
  schema: z.object({ /* ... */ }),
  strict: true,  // require a strict-capable model
});
```

`@aeye` reconciles each provider's strict-mode dialect (OpenAI / Anthropic / Google) so the same Zod schema works everywhere — see the [Strict Mode guide](./strict-mode.md) for format families, per-request budgets, the curated `strictSupport` overrides, and how to register a custom dialect.

## Dynamic Schema

The schema can change based on context:

```typescript
const dynamicPrompt = ai.prompt({
  name: 'extract',
  content: 'Extract data from: {{text}}',
  input: (input: { text: string }) => input,
  schema: (ctx) => {
    if (ctx.extractMode === 'simple') {
      return z.object({ summary: z.string() });
    }
    return z.object({
      summary: z.string(),
      entities: z.array(z.object({
        name: z.string(),
        type: z.string(),
      })),
      dates: z.array(z.string()),
    });
  },
});
```

Return `false` to disable structured output for that call:

```typescript
schema: (ctx) => {
  if (ctx.freeform) return false;
  return z.object({ /* ... */ });
},
```

## Output Validation

Add custom validation beyond the schema:

```typescript
const prompt = ai.prompt({
  schema: z.object({
    items: z.array(z.string()),
    count: z.number(),
  }),
  validate: (output, ctx) => {
    if (output.items.length !== output.count) {
      throw new Error(`Count ${output.count} doesn't match ${output.items.length} items`);
    }
  },
});
```

Validation errors trigger a retry with the error message sent to the model.

## Retry Behavior

When output parsing or validation fails:

1. The error is sent back to the model as a system message
2. The model tries again (up to `outputRetries` times, default: 2)
3. If all retries fail, the prompt throws an error

```typescript
const prompt = ai.prompt({
  schema: z.object({ /* ... */ }),
  outputRetries: 3, // try up to 3 times
});
```

## JSON Response Format

For simple JSON without schema validation, use `responseFormat`:

```typescript
const response = await ai.chat.get({
  messages: [{ role: 'user', content: 'List 3 colors as JSON' }],
  responseFormat: 'json',
});

const data = JSON.parse(response.content);
```

## Schema Utilities

@aeye provides utilities for working with Zod schemas and JSON Schema:

```typescript
import { toJSONSchema, strictify } from '@aeye/core';

// Convert Zod to JSON Schema
const jsonSchema = toJSONSchema(myZodSchema);

// Make a schema strict-mode compatible
const strictSchema = strictify(myZodSchema);
```
