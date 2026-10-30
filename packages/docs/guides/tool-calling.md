# Tool Calling

Tool calling lets AI models invoke functions in your application. @aeye handles the full lifecycle: schema compilation, argument parsing, execution, and result injection.

## Quick Example

```typescript
import z from 'zod';

const calculator = ai.tool({
  name: 'calculate',
  description: 'Perform a math calculation',
  schema: z.object({
    expression: z.string().describe('Math expression, e.g. "2 + 3 * 4"'),
  }),
  call: async ({ expression }) => {
    return { result: eval(expression) };
  },
});

const mathBot = ai.prompt({
  name: 'mathBot',
  content: 'You are a math tutor. Use the calculator to verify your work.',
  tools: [calculator],
});

const result = await mathBot.get('result', {});
```

## How It Works

1. The prompt compiles tool schemas and sends them to the AI model
2. The model decides to call tools and returns `ToolCall` objects
3. @aeye parses and validates arguments against the Zod schema
4. The tool's `call()` function is executed
5. Results are sent back to the model as tool result messages
6. The model generates its final response (or calls more tools)

## Tool Choice

Control whether and how the model uses tools:

```typescript
const prompt = ai.prompt({
  tools: [tool1, tool2],
  config: {
    toolChoice: 'auto',              // model decides (default)
    // toolChoice: 'required',       // must call at least one tool
    // toolChoice: 'none',           // don't call any tools
    // toolChoice: { tool: 'tool1' }, // must call this specific tool
    // toolChoice: { allowed: ['tool1'] },                 // may only call these tools
    // toolChoice: { allowed: ['tool1'], required: true }, // must call one of these tools
  },
});
```

### Allowed Tools

`{ allowed: [...] }` limits which tools the model may call while still sending every tool. Because the tool list doesn't change from one request to the next, the prompt stays cacheable, which matters when an agent narrows its tools step by step:

```typescript
const agent = ai.prompt({
  name: 'support',
  description: 'Answers customer questions',
  content: 'Help the customer.',
  tools: [lookupOrder, refund, escalate],
  config: {
    // Only let the model look the order up for now
    toolChoice: { allowed: ['lookupOrder'], required: true },
  },
});
```

With `required: true` the model must call one of the allowed tools; without it, it may also answer in text.

OpenAI sends this as `allowed_tools` (Chat Completions and Responses). OpenRouter and AWS Bedrock emulate it by sending only the allowed tools, because OpenRouter ignores `allowed_tools` and Bedrock has no equivalent. Emulation gives the same behavior but loses the caching benefit.

## Execution Modes

### Immediate (Default)

Tools execute as soon as their arguments are parsed:

```typescript
const prompt = ai.prompt({
  tools: [tool1, tool2],
  toolExecution: 'immediate',
});
```

### Sequential

Tools execute one at a time, in order:

```typescript
const prompt = ai.prompt({
  tools: [tool1, tool2],
  toolExecution: 'sequential',
});
```

### Parallel

All tool calls in a batch are collected, then executed concurrently:

```typescript
const prompt = ai.prompt({
  tools: [tool1, tool2],
  toolExecution: 'parallel',
});
```

## Tool Iterations

By default, prompts allow 3 rounds of tool calls. Increase for complex workflows:

```typescript
const prompt = ai.prompt({
  tools: [/* many tools */],
  toolIterations: 20,  // allow up to 20 rounds
  toolRetries: 3,      // retry failed tool calls up to 3 times
});
```

## Limiting Tool Calls

Cap the total number of successful tool calls:

```typescript
const prompt = ai.prompt({
  tools: [search, read],
  toolsMax: 5, // stop after 5 successful tool calls
});
```

## Tool-Only Mode

Generate only tool calls, no text output:

```typescript
const prompt = ai.prompt({
  tools: [extractEntity],
  toolsOnly: true,
});

const tools = await prompt.get('tools', input);
// tools is an array of { tool, result } objects
```

## Strict Mode

`Tool.strict` is `boolean | number` (default: `1`). When set, the LLM grammar-constrains tool arguments to your schema — no malformed args, no off-schema fields:

```typescript
const calc = ai.tool({
  name: 'calculate',
  schema: z.object({ expression: z.string() }),
  // strict omitted → priority 1 (best-effort, default)
  call: async ({ expression }) => ({ result: eval(expression) }),
});

const critical = ai.tool({
  name: 'transfer',
  schema: z.object({ amount: z.number(), to: z.string() }),
  strict: true,  // hard requirement — selection rejects non-strict-capable models
  call: async ({ amount, to }) => { /* ... */ },
});
```

`@aeye` reconciles each provider's strict-mode dialect (OpenAI / Anthropic / Google) and handles per-request budgets so a request with many strict tools degrades gracefully. See the [Strict Mode guide](./strict-mode.md) for the full picture, including the curated `strictSupport` overrides you'll want to wire into your `AI` config.

## Free-Text and Grammar Tools

Some tools are easier for a model to call with plain text than with JSON: a SQL query, a shell command, a patch. Set `format` to take the input as free text, optionally constrained by a grammar:

```typescript
import { TEXT_TOOL_SCHEMA } from '@aeye/core';

// Any text
const runShell = ai.tool({
  name: 'runShell',
  description: 'Run a shell command and return its output',
  schema: TEXT_TOOL_SCHEMA,
  format: { type: 'text' },
  call: async ({ input }) => exec(input),
});

// Text that matches a Lark grammar
const query = ai.tool({
  name: 'query',
  description: 'Run a read-only SQL query',
  schema: TEXT_TOOL_SCHEMA,
  format: {
    type: 'grammar',
    syntax: 'lark',
    definition: `
      start: "SELECT " columns " FROM " TABLE (" WHERE " condition)? ";"
      columns: "*" | COLUMN (", " COLUMN)*
      condition: COLUMN " = " VALUE
      TABLE: /orders|customers/
      COLUMN: /[a-z_]+/
      VALUE: /'[^']*'|[0-9]+/
    `,
  },
  call: async ({ input }) => db.query(input),
});

// Text that matches a regular expression
const setDate = ai.tool({
  name: 'setDate',
  description: 'Set the due date',
  schema: TEXT_TOOL_SCHEMA,
  format: { type: 'grammar', syntax: 'regex', definition: '\\d{4}-\\d{2}-\\d{2}' },
  call: async ({ input }) => ({ due: input }),
});
```

The text arrives as the `input` field, so a free-text tool's schema is always `{ input: string }`: use `TEXT_TOOL_SCHEMA`. Parsing, validation, and the prompt loop work as for any other tool.

On OpenAI these are Responses API custom tools, which constrain the model's output to the grammar. Elsewhere a free-text tool is sent as an ordinary function with one `input` field; on Chat Completions (OpenAI with `api: 'chat'`, and OpenRouter) the grammar is appended to the tool's description, so the model is asked, not forced, to follow it.

## Deferred Tools (Tool Search)

An agent with many tools pays for every tool's definition on every request. Mark rarely used tools `defer: true` and they are loaded only when the model searches for them:

```typescript
const exportReport = ai.tool({
  name: 'exportReport',
  description: 'Export a report as CSV, PDF, or XLSX',
  schema: z.object({ reportId: z.string(), format: z.enum(['csv', 'pdf', 'xlsx']) }),
  defer: true,
  call: async ({ reportId, format }) => reports.export(reportId, format),
});
```

On OpenAI, deferred tools are sent with `defer_loading` and @aeye adds the hosted `tool_search` tool, through the Responses API. Other providers send deferred tools as ordinary tools.

## Async Tools

Mark a slow tool `async: true` to let the model keep working while it runs; its result can arrive on a later turn:

```typescript
const renderVideo = ai.tool({
  name: 'renderVideo',
  description: 'Render the storyboard to a video file',
  schema: z.object({ storyboardId: z.string() }),
  async: true,
  call: async ({ storyboardId }) => renderer.render(storyboardId),
});
```

Async tools are an OpenAI Responses API feature. Other providers send them as ordinary tools.

## Provider Support

| Feature | OpenAI | OpenRouter | AWS Bedrock |
|---------|--------|------------|-------------|
| `toolChoice: { allowed }` | `allowed_tools` | Emulated (only the allowed tools are sent) | Emulated (only the allowed tools are sent) |
| `format: { type: 'text' }` | Custom tool (Responses) | One-field function | One-field function |
| `format: { type: 'grammar' }` | Custom tool with grammar (Responses) | One-field function, grammar in the description | One-field function |
| `defer` | Tool search (Responses) | Ordinary tool | Ordinary tool |
| `async` | Async tool (Responses) | Ordinary tool | Ordinary tool |

With the default `api: 'auto'`, any tool with `format`, `defer`, or `async` makes the OpenAI provider use the Responses API for that request.

## Error Handling

Tool errors are caught and reported back to the model, which can retry or adjust:

```typescript
const riskyTool = ai.tool({
  name: 'riskyOp',
  schema: z.object({ id: z.string() }),
  call: async ({ id }) => {
    const item = await db.find(id);
    if (!item) throw new Error(`Item ${id} not found`);
    return item;
  },
});

// The error message is sent to the model as a tool error result
// The model can try again with a different ID
```

## Custom Argument Parser (bring your own)

A tool can supply a `parse` function that **replaces Zod** for argument validation. It receives the raw `JSON.parse`-d args and fully owns turning them into the decoded value; **its return type drives what `call`/`validate` receive** (the trailing `TDecoded` type parameter). Return (or throw) an `Error` to reject the call — the error's `.message` flows back to the model instead of Zod's.

```typescript
const runQuery = ai.tool({
  name: 'runQuery',
  description: 'Run a structured query',
  schema: querySchema,                    // still required — drives the model wire format
  parse: (raw, ctx) => {
    const result = buildQuery(raw);        // your parser → a built, runnable object
    if (result.problems) return new Error(result.report); // compiler-style diagnostics
    return result.query;                   // decoded value; `call` receives this
  },
  call: async (query) => query.run(),      // `query` is the decoded type, not the wire args
});
```

The pipeline becomes `JSON.parse` → `parse` → `validate` (Zod skipped). `schema` is still required and still drives `compile()` / the model wire format. Absent ⇒ the unchanged Zod path. `@aeye/query`'s `buildQueryTool` uses this to surface engine diagnostics.

## Raw Tool Call API

Use tool calling at the Chat API level without prompts:

```typescript
const response = await ai.chat.get({
  messages: [{ role: 'user', content: 'What is the weather in Paris?' }],
  tools: [{
    name: 'getWeather',
    description: 'Get weather for a city',
    parameters: z.object({ city: z.string() }),
  }],
});

if (response.toolCalls) {
  for (const call of response.toolCalls) {
    console.log(call.name, JSON.parse(call.arguments));
  }
}
```
