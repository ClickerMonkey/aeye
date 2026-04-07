# @aeye/core — Agent

The `Agent` class orchestrates multiple components (tools, prompts, other agents) with developer-defined logic.

## Constructor

```typescript
new Agent<TContext, TMetadata, TName, TInput, TOutput, TRefs>(input: AgentInput)
```

### `AgentInput`

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `name` | `string` | Yes | Unique agent name |
| `description` | `string` | Yes | What the agent does |
| `refs` | `Component[] as const` | Yes | Child components (typed tuple) |
| `call` | `(input, refs, ctx) => output` | Yes | Orchestration function |
| `applicable` | `(ctx) => boolean` | No | Availability check |
| `metadata` | `object` | No | Static metadata |
| `metadataFn` | `(input, ctx) => object` | No | Dynamic metadata |

## Properties

| Property | Type | Description |
|----------|------|-------------|
| `kind` | `'agent'` | Component kind |
| `name` | `TName` | Agent name |
| `description` | `string` | Agent description |
| `refs` | `TRefs` | Referenced components |
| `input` | `AgentInput` | Full configuration |

## Methods

### `run(input, ctx?)`

Execute the agent:

```typescript
const result = await agent.run({ query: 'search for files' }, ctx);
```

The `call` function receives:
1. `input` — the input passed to `run()`
2. `refs` — typed tuple of child components
3. `ctx` — the merged context

### `applicable(ctx?)`

Check if the agent is available.

### `metadata(input?, ctx?)`

Get agent metadata.

## Type Safety

Using `as const` on `refs` preserves individual component types:

```typescript
const agent = ai.agent({
  refs: [myTool, myPrompt, otherAgent] as const,
  call: async (input, [tool, prompt, agent], ctx) => {
    // tool: typeof myTool
    // prompt: typeof myPrompt
    // agent: typeof otherAgent
  },
});
```
