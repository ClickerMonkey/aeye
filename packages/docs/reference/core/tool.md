# @aeye/core — Tool

The `Tool` class represents a function that AI models can call.

## Constructor

```typescript
new Tool<TContext, TMetadata, TName, TParams, TOutput, TRefs>(input: ToolInput)
```

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
| `strict` | `boolean` | No | Strict JSON schema (default: `true`) |
| `refs` | `Component[]` | No | Referenced components |
| `validate` | `(input, ctx) => void` | No | Post-parse validation |
| `applicable` | `(ctx) => boolean` | No | Availability check |
| `metadata` | `object` | No | Static metadata |
| `metadataFn` | `(input, ctx) => object` | No | Dynamic metadata |
| `descriptionFn` | `(ctx) => string` | No | Dynamic description |

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
// definition: { name, description, parameters, strict }
```

Returns `undefined` if `applicable()` returns `false`.

### `metadata(input?, ctx?)`

Get tool metadata (static or dynamic).

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
