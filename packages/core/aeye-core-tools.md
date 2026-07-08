# @aeye/core — Tool & Agent

Both are `Component`s. A **Tool** is a single callable function exposed to the model (or invoked directly). An **Agent** is plain orchestration code that composes other components — no LLM loop of its own.

## Tool

```typescript
class Tool<TContext = {}, TMetadata = {}, TName extends string = string,
  TParams extends object = {}, TOutput = string,
  TRefs extends Tuple<ComponentCompatible<TContext, TMetadata>> = [],
  TDecoded extends unknown = TParams>
  implements Component<...>
```

`TDecoded` is the decoded type a custom `parse` produces from the raw wire args — **any** value (a built class instance, a number, a `Date`, …), not just an object; it types `call`, `validate`, and `metadataFn`. It defaults to the wire `TParams` when no custom `parse` is supplied — `schema` always stays the wire type.

### `ToolInput` (constructor config)

| Field | Type | Notes |
|------|------|-------|
| `name` | `TName` | Shown to the model; unique per request. |
| `description` | `string` | Shown to the model. |
| `descriptionFn?` | `Fn<string, [ctx]>` | Refine description from context. |
| `instructions?` | `string` | Handlebars usage instructions. |
| `instructionsFn?` | `Fn<string, [ctx]>` | Context-derived instructions. |
| `input?` | `Fn<Record<string,any>, [ctx]>` | Variables for the instructions template. |
| `schema` | `Fn<ZodType<TParams> \| undefined, [ctx]>` | **Required.** Param schema; may depend on ctx. `undefined` ⇒ unavailable. |
| `strict?` | `boolean \| number` | Strict-mode policy, default `1`. See [schema doc](./aeye-core-schema.md). |
| `refs?` | `TRefs` | Components passed positionally to `call`. |
| `call` | `(input: TParams, refs: TRefs, ctx) => TOutput` | **Required.** Implementation (sync or async). |
| `validate?` | `(input, ctx) => void \| Promise<void>` | Runs after Zod parse; throw to re-prompt. |
| `maxArgsLength?` | `number` | Reject raw args string over N chars before `JSON.parse` (guards against providers that corrupt large tool args). |
| `applicable?` | `(ctx) => boolean \| Promise<boolean>` | Availability check. |
| `metadata?` / `metadataFn?` | `TMetadata` / fn | Execution metadata. |

### Methods

```typescript
run(input?: TParams, ctx?: Context): TOutput                 // call directly
compile(ctx): Promise<readonly [string, ToolDefinition] | undefined>  // build AI tool def
parse(ctx, args, schema?, descriptor?, onRepairAttempt?): Promise<...> // validate raw JSON args
applicable(ctx?): Promise<boolean>
metadata(input?, ctx?): TMetadata | Promise<TMetadata>
```

`compile` returns `undefined` when the tool isn't applicable / has no schema for the context. `parse` validates the model's JSON `arguments` string against the (descriptor-strictified) schema and runs `validate`; it tolerates one provider misbehavior — top-level JSON-stringified fields are re-parsed and `onRepairAttempt` fires for telemetry.

### Basic tool

```typescript
import { Tool } from '@aeye/core';
import z from 'zod';

const getWeather = new Tool({
  name: 'getWeather',
  description: 'Get current weather for a location',
  instructions: 'Use this to look up weather for {{location}}.',
  schema: z.object({
    location: z.string().describe('City name'),
    units: z.enum(['celsius', 'fahrenheit']).default('celsius'),
  }),
  call: async (input, _refs, _ctx) => {
    const data = await fetchWeather(input.location, input.units);
    return { temperature: data.temp, condition: data.condition };
  },
});

// Direct invocation (no model needed):
const w = await getWeather.run({ location: 'Paris' }, {});
```

### Context-aware schema & applicability

```typescript
const manageData = new Tool({
  name: 'manageData',
  description: 'Manage data records',
  schema: (ctx: Context<MyCtx, {}>) =>
    ctx.userRole === 'admin'
      ? z.object({ action: z.enum(['read', 'write', 'delete']) })
      : z.object({ action: z.enum(['read']) }),
  applicable: (ctx) => ctx.isAuthenticated,
  call: async (input, _refs, ctx) => ({ action: input.action, by: ctx.userRole }),
});
```

### Business-logic validation

```typescript
const placeOrder = new Tool({
  name: 'placeOrder',
  description: 'Place a product order',
  schema: z.object({ itemId: z.string(), quantity: z.number().int().min(1) }),
  validate: async (input) => {
    const inStock = await checkInventory(input.itemId);
    if (inStock < input.quantity) throw new Error(`Only ${inStock} available.`);
  },
  call: async (input) => ({ orderId: crypto.randomUUID(), ...input }),
});
```

### Control-flow errors

- `ToolInterrupt(message?)` — stop the prompt loop and return control to the caller. With `toolsComplete` a synthetic `[interrupted]` result is paired so the next round-trip is valid.
- `PromptSuspend(message?)` — suspend without writing a tool result, for human-in-the-loop. See [prompts doc](./aeye-core-prompts.md#suspend--resume-human-in-the-loop). Never auto-paired.

```typescript
import { PromptSuspend } from '@aeye/core';

call: async (input, _refs, ctx) => {
  if (await needsApproval(input)) throw new PromptSuspend('awaiting approval');
  return performAction(input);
}
```

Also exported: `AnyTool`, `ToolCompatible<TContext, TMetadata>`.

## Agent

```typescript
class Agent<TContext = {}, TMetadata = {}, TName extends string = string,
  TInput extends object = {}, TOutput = string,
  TRefs extends Tuple<ComponentCompatible<TContext, TMetadata>> = []>
  implements Component<...>
```

An Agent is just typed orchestration — its `call` receives the resolved `refs` tuple positionally and wires components together however you like.

### `AgentInput`

| Field | Type | Notes |
|------|------|-------|
| `name` | `TName` | Identifier. |
| `description` | `string` | Informational. |
| `refs` | `TRefs` | **Required.** Components this agent uses. |
| `call` | `(input: TInput, refs: TRefs, ctx) => TOutput` | **Required.** Orchestration logic. |
| `applicable?` | `(ctx) => boolean \| Promise<boolean>` | Defaults to "any ref is applicable" (or `true` when no refs). |
| `metadata?` / `metadataFn?` | `TMetadata` / fn | Execution metadata. |

### Methods

```typescript
run(input?: TInput, ctx?: Context): TOutput
applicable(ctx?): Promise<boolean>
metadata(input?, ctx?): TMetadata | Promise<TMetadata>
```

### Example

```typescript
import { Agent } from '@aeye/core';

const researchAgent = new Agent({
  name: 'researcher',
  description: 'Researches a topic',
  refs: [searchTool, summarizePrompt, analyzePrompt] as const,
  call: async (input: { topic: string }, [search, summarize, analyze], ctx) => {
    const results = await search.run({ query: input.topic, limit: 5 }, ctx);
    const summaries: string[] = [];
    for (const r of results.items) {
      const s = await summarize.get('result', { text: r.content }, ctx);
      summaries.push(s?.summary ?? '');
    }
    return await analyze.get('result', { topic: input.topic, sources: summaries }, ctx);
  },
});

const out = await researchAgent.run({ topic: 'Quantum Computing' }, { execute, messages: [] });
```

## Gotchas

- Pass `refs` `as const` to keep the tuple's element types (so destructuring is correctly typed).
- An Agent does **no** AI on its own — any model calls come from the prompts/tools it invokes, which need `execute`/`stream` on the forwarded `ctx`.
- Tool `schema` returning `undefined` (or `applicable` false) excludes the tool from `compile()` output, so the model never sees it for that context.
- `call` can be sync or async; `TOutput` flows through `Resolved<>` where the framework awaits it (e.g. tool results in prompt events).
- A tool's return value is what the model sees by default (strings verbatim, otherwise `JSON.stringify`-d). To transform per-prompt what a tool result looks like to the model without changing the tool, use the prompt's [`onToolResult`](./aeye-core-prompts.md#tool-result-transformer) transformer (model-facing only; the raw result stays on `get('tools')`/`streamTools`).
