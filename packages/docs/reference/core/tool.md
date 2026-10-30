# @aeye/core — Tool

The `Tool` class represents a function that AI models can call.

## Constructor

```typescript
new Tool<TContext, TMetadata, TName, TParams, TOutput, TRefs, TDecoded = TParams>(input: ToolInput)
```

`TDecoded` is the decoded type a custom `parse` produces from the raw wire args (e.g. a built class instance); it types `call`, `validate`, and `metadataFn`. It defaults to the wire `TParams` when no custom `parse` is supplied — `schema` always stays the wire type.

### `ToolInput`

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `name` | `string` | Yes | Unique tool name |
| `description` | `string` | Yes | Description shown to AI model |
| `schema` | `ZodType \| (ctx) => ZodType` | Yes | Input parameter schema |
| `call` | `(input, refs, ctx) => output` | Yes | Implementation function |
| `instructions` | `string` | No | Handlebars template for usage guidance |
| `instructionsFn` | `(ctx) => string` | No | Dynamic instructions |
| `input` | `(ctx) => object` | No | Template variables for instructions |
| `strict` | `boolean \| number` | No | Strict tool inputs: `true` requires, `false` disables, a number is a preference priority (default: `1`) |
| `refs` | `Component[]` | No | Referenced components |
| `validate` | `(input, ctx) => void` | No | Post-parse validation |
| `applicable` | `(ctx) => boolean` | No | Availability check |
| `metadata` | `object` | No | Static metadata |
| `metadataFn` | `(input, ctx) => object` | No | Dynamic metadata |
| `descriptionFn` | `(ctx) => string` | No | Dynamic description |
| `format` | `ToolTextFormat` | No | Take the input as free text (`{ type: 'text' }`) or text matching a grammar (`{ type: 'grammar', syntax: 'lark' \| 'regex', definition }`). The text arrives as `input`; use `TEXT_TOOL_SCHEMA` as the schema. |
| `defer` | `boolean` | No | Load the tool only when the model searches for it (OpenAI tool search) |
| `async` | `boolean` | No | The model keeps working while the tool runs (OpenAI Responses) |

## Properties

| Property | Type | Description |
|----------|------|-------------|
| `kind` | `'tool'` | Component kind |
| `name` | `TName` | Tool name |
| `description` | `string` | Tool description |
| `refs` | `TRefs` | Referenced components |
| `input` | `ToolInput` | Full configuration |

## Methods

### `run(input, ctx?)`

Execute the tool directly.

```typescript
const result = await tool.run({ city: 'Paris' }, ctx);
```

### `applicable(ctx?)`

Check if the tool is available in the given context.

```typescript
const available = await tool.applicable(ctx);
```

### `parse(ctx, args, schema?)`

Parse and validate raw arguments against the schema.

```typescript
const parsed = await tool.parse(ctx, '{"city": "Paris"}');
```

### `compile(ctx)`

Compile instructions and schema for AI model consumption.

```typescript
const [instructions, definition] = await tool.compile(ctx);
// instructions: rendered template string
// definition: { name, description, parameters, strict, format, defer, async }
```

Returns `undefined` if `applicable()` returns `false`.

### `metadata(input?, ctx?)`

Get tool metadata (static or dynamic).

## Helpers

### `TEXT_TOOL_SCHEMA`

The schema of a free-text tool, `z.object({ input: z.string() })`. A tool with `format` set receives its text as `input`:

```typescript
import { TEXT_TOOL_SCHEMA } from '@aeye/core';

const runShell = ai.tool({
  name: 'runShell',
  description: 'Run a shell command',
  schema: TEXT_TOOL_SCHEMA,
  format: { type: 'text' },
  call: async ({ input }) => exec(input),
});
```

### `forcesTool(choice)`

Whether a `ToolChoice` makes the model call a tool: `'required'`, `{ tool }`, or `{ allowed, required: true }`.

```typescript
forcesTool({ allowed: ['a'], required: true }); // true
forcesTool({ allowed: ['a'] });                 // false
```

### `withAllowedTools(request)`

The request with only its allowed tools, for providers that can't limit which tools a model calls while sending them all. A `{ allowed, required }` choice becomes `'required'` or `'auto'`; any other choice returns the request unchanged. The OpenRouter and AWS Bedrock providers use it.

```typescript
const narrowed = withAllowedTools({ messages, tools, toolChoice: { allowed: ['search'] } });
// narrowed.tools holds only `search`; narrowed.toolChoice is 'auto'
```

## Special Error Classes

### `ToolInterrupt`

Interrupt tool execution to surface a message (e.g., for user confirmation):

```typescript
import { ToolInterrupt } from '@aeye/core';

throw new ToolInterrupt('Are you sure you want to delete this?');
```

### `PromptSuspend`

Suspend the entire prompt at this tool call point:

```typescript
import { PromptSuspend } from '@aeye/core';

throw new PromptSuspend('Waiting for user input');
```
