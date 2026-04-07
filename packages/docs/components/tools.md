# Tools

Tools are functions that AI models can call. They bridge the gap between natural language and your application's capabilities.

::: tip Two ways to create components
Most examples use `ai.tool()`, which binds the tool to an AI instance (auto-injects executor, context types, etc.):

```typescript
import { AI } from '@aeye/ai';
import { OpenAIProvider } from '@aeye/openai';

const ai = AI.with()
  .providers({ openai: new OpenAIProvider({ apiKey: process.env.OPENAI_API_KEY! }) })
  .create();

const myTool = ai.tool({ /* ... */ });
```

You can also create standalone tools directly from `@aeye/core` without an AI instance:

```typescript
import { Tool } from '@aeye/core';

const myTool = new Tool({ /* ... */ });
```

Standalone components work the same way but require you to provide an executor/streamer via context when running them. Using `ai.tool()` is recommended for most use cases.
:::

## Creating a Tool

```typescript
import z from 'zod';

const getWeather = ai.tool({
  name: 'getWeather',
  description: 'Get current weather for a city',
  schema: z.object({
    city: z.string().describe('City name, e.g. "San Francisco"'),
    units: z.enum(['celsius', 'fahrenheit']).default('celsius'),
  }),
  call: async ({ city, units }) => {
    const data = await fetchWeather(city, units);
    return { temperature: data.temp, condition: data.condition };
  },
});
```

## Tool Configuration

| Property | Type | Description |
|----------|------|-------------|
| `name` | `string` | Unique identifier used by the AI model |
| `description` | `string` | What the tool does (shown to the model) |
| `schema` | `ZodType` or `(ctx) => ZodType` | Input validation schema |
| `call` | `(input, refs, ctx) => output` | The function that runs when the tool is called |
| `instructions` | `string` | Handlebars template with usage guidance |
| `input` | `(ctx) => object` | Template variables for instructions |
| `strict` | `boolean` | Enforce strict JSON schema (default: `true`) |
| `refs` | `Component[]` | Other components this tool can use |
| `validate` | `(input, ctx) => void` | Custom validation after schema parsing |
| `applicable` | `(ctx) => boolean` | Context-based availability |
| `metadata` | `object` | Static metadata |
| `metadataFn` | `(input, ctx) => object` | Dynamic metadata |
| `descriptionFn` | `(ctx) => string` | Dynamic description |
| `instructionsFn` | `(ctx) => string` | Dynamic instructions |

## Instructions with Templates

Provide usage guidance to the AI model using Handlebars templates:

```typescript
const searchFiles = ai.tool({
  name: 'searchFiles',
  description: 'Search for files',
  instructions: 'Search for files matching "{{pattern}}" in the {{scope}} directory.',
  input: (ctx) => ({
    pattern: ctx.searchPattern || '*',
    scope: ctx.workingDirectory || 'current',
  }),
  schema: z.object({
    pattern: z.string(),
    directory: z.string().optional(),
  }),
  call: async ({ pattern, directory }) => { /* ... */ },
});
```

## Dynamic Schema

The schema can be a function that returns different schemas based on context:

```typescript
const queryData = ai.tool({
  name: 'queryData',
  description: 'Query the database',
  schema: (ctx) => {
    const tables = ctx.db.getTableNames();
    return z.object({
      table: z.enum(tables as [string, ...string[]]),
      limit: z.number().max(100).default(10),
    });
  },
  call: async ({ table, limit }, _refs, ctx) => {
    return ctx.db.query(`SELECT * FROM ${table} LIMIT ${limit}`);
  },
});
```

## Applicability

Control when a tool is available:

```typescript
const adminTool = ai.tool({
  name: 'deleteUser',
  description: 'Delete a user account',
  schema: z.object({ userId: z.string() }),
  applicable: (ctx) => ctx.user.role === 'admin',
  call: async ({ userId }) => { /* ... */ },
});
```

When `applicable` returns `false`, the tool is excluded from the prompt's tool list.

## Tool Interrupts

Interrupt tool execution to ask the user for confirmation:

```typescript
import { ToolInterrupt } from '@aeye/core';

const deleteTool = ai.tool({
  name: 'deleteFile',
  description: 'Delete a file',
  schema: z.object({ path: z.string() }),
  call: async ({ path }, _refs, ctx) => {
    if (!ctx.confirmed) {
      throw new ToolInterrupt(`Delete ${path}?`);
    }
    await fs.unlink(path);
    return { deleted: true };
  },
});
```

## Prompt Suspension

Suspend the entire prompt at a tool call point (for multi-turn workflows):

```typescript
import { PromptSuspend } from '@aeye/core';

const askUser = ai.tool({
  name: 'askUser',
  description: 'Ask the user a question and wait for response',
  schema: z.object({ question: z.string() }),
  call: async ({ question }) => {
    throw new PromptSuspend(question);
  },
});
```

## Running Tools Directly

Tools can be executed outside of a prompt:

```typescript
const result = await getWeather.run(
  { city: 'Paris', units: 'celsius' },
  ctx
);
console.log(result.temperature);
```

## Compiling for AI

Tools compile their schema and instructions into the format expected by AI models:

```typescript
const [instructions, definition] = await myTool.compile(ctx);
// instructions: rendered Handlebars template
// definition: { name, description, parameters, strict }
```

This is handled automatically when tools are attached to a [Prompt](/components/prompts).
