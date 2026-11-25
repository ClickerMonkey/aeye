# @aeye/core — Tool & Agent

Both are `Component`s. A **Tool** is a single callable function exposed to the model (or invoked directly). An **Agent** is plain orchestration code that composes other components — no LLM loop of its own.

## Tool

```typescript
class Tool<TContext = {}, TMetadata = {}, TName extends string = string,
  TParams extends object = {}, TOutput = string,
  TRefs extends Tuple<ComponentCompatible<TContext, TMetadata>> = []>
  implements Component<...>
```

`TParams` is the schema's code-shape type: with `a.codec` **any** value (a built class instance, a number, a `Date`, …); it types `call`, `validate` and `metadataFn`.

### `ToolInput` (constructor config)

| Field | Type | Notes |
|------|------|-------|
| `name` | `TName` | Shown to the model; unique per request. |
| `description` | `string` | Shown to the model. |
| `descriptionFn?` | `Fn<string, [ctx]>` | Refine description from context. |
| `instructions?` | `string` | Handlebars usage instructions. Optional: a tool without them is still offered (from its description and schema) and adds nothing to the prompt's tools section. |
| `instructionsFn?` | `Fn<string, [ctx]>` | Context-derived instructions. |
| `input?` | `Fn<Record<string,any>, [ctx]>` | Variables for the instructions template. |
| `schema` | `a` schema or bundle (`Bindable<TParams, [ctx]>`) | **Required.** One static schema; a bundle's dynamic step takes the ctx (cached by its `key`). `TParams` is inferred. Use `applicable` for "not here". |
| `errorFormat?` | `ErrorFormatInput` | How bad arguments are told to the model (`'summary' \| 'list' \| 'markers' \| 'full'` or options). Wins over `ctx.errorFormat`. |
| `strict?` | `boolean \| number` | Strict-mode policy, default `1`. See [schema doc](./aeye-core-schema.md). |
| `refs?` | `TRefs` | Components passed positionally to `call`. |
| `call` | `(input: TParams, refs: TRefs, ctx) => TOutput` | **Required.** Implementation (sync or async). |
| `validate?` | `(input, ctx) => void \| Promise<void>` | Runs after decoding; throw to re-prompt. |
| `maxArgsLength?` | `number` | Reject raw args string over N chars before `JSON.parse` (guards against providers that corrupt large tool args). |
| `applicable?` | `(ctx) => boolean \| Promise<boolean>` | Availability check. |
| `metadata?` / `metadataFn?` | `TMetadata` / fn | Execution metadata. |
| `parallelClaims?` | `Fn<ToolClaims \| undefined, [input, ctx]>` | What a call operates on (e.g. `` (i) => [`file:${i.path}`] ``), from the decoded input and the call's ctx (with `toolCallId`). Under `parallel`/`immediate`, a call whose claims conflict with an earlier call in the batch waits for it, then runs; others stay concurrent. Exact string equality; `'*'` (`ALL_CLAIMS`) runs alone; none ⇒ conflicts only with `'*'`. A throw fails that call (`ToolExecutionError`). The rule is exported as `claimsConflict` / `claimWaits` (`claims.ts`). |

### Methods

```typescript
run(input?: TParams, ctx?: Context): TOutput                 // call directly
compile(ctx): Promise<readonly [string, ToolDefinition] | undefined>  // build AI tool def
parse(ctx, args, schema?, descriptor?, onRepairAttempt?): Promise<...> // validate raw JSON args
applicable(ctx?): Promise<boolean>
metadata(input?, ctx?): TMetadata | Promise<TMetadata>
claims(input, ctx): Promise<ToolClaims>                      // resolve parallelClaims ([] when none)
hasParallelClaims: boolean                                   // whether parallelClaims is declared
```

`parse(ctx, args, plan?, onRepairAttempt?, { name?, errorFormat? })` decodes the model's JSON `arguments` through the request's plan — from the shape that model was given (pairs, `null` for absent, JSON text, a call through the `run_tool` dispatcher) into the code shape — and runs `validate`; a mismatch throws a `SchemaParseError` whose message is what the model is told. Top-level fields sent as JSON strings are repaired and `onRepairAttempt` fires for telemetry. `definition(ctx)` gives the request's `ToolDefinition` (`parameters` is the bound schema), `instructionsFor(ctx, plan)` the instructions for a plan, `encoder(ctx, plan?)` a value-only encoder. Mapping into another value (a class, a runnable query) is a codec on the schema; its `decode` returning an `Error` / `Rejection` is told to the model like any mismatch.

A tool with `format` (free text, optionally grammar-constrained) takes `TEXT_TOOL_SCHEMA` (`{ input: string }`). Providers without free-text tools send it as that one-field function and use `describeTool(definition)` for its description, which appends the grammar for a `{ type: 'grammar' }` format.

### Basic tool

```typescript
import { Tool } from '@aeye/core';

const getWeather = new Tool({
  name: 'getWeather',
  description: 'Get current weather for a location',
  instructions: 'Use this to look up weather for {{location}}.',
  schema: a.object({
    location: a.string().describe('City name'),
    units: a.enum(['celsius', 'fahrenheit']).default('celsius'),
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
  // One static bundle; the dynamic step runs per role (cached by the key).
  schema: a
    .declare<{ Action: 'read' | 'write' | 'delete' }>()
    .dynamic((ctx: Context<MyCtx, {}>) => ({ Action: ctx.userRole === 'admin' ? a.enum(['read', 'write', 'delete']) : a.enum(['read']) }), { key: (ctx) => ctx.userRole })
    .result(a.object({ action: a.ref('Action') })),
  applicable: (ctx) => ctx.isAuthenticated,
  call: async (input, _refs, ctx) => ({ action: input.action, by: ctx.userRole }),
});
```

### Business-logic validation

```typescript
const placeOrder = new Tool({
  name: 'placeOrder',
  description: 'Place a product order',
  schema: a.object({ itemId: a.string(), quantity: a.int().min(1) }),
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
