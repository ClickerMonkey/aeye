# @aeye/core — Schemas, strict mode and requests

Tool arguments and prompt outputs are **`@aeye/schema` (`a`) schemas**: one static instance per tool or prompt, built at module scope, whose dynamic parts (a registry, a catalog, the caller's role) are bound per call. Core plans every schema of a request together for the model it goes to, and decodes every answer through that same plan. The schema builder itself — types, named types and the chain, profiles, decoding, errors for the model — is documented in `@aeye/schema`'s `aeye-schema.md`; this page is how core uses it.

```ts
import { a, Tool, Prompt } from '@aeye/core';   // `a` is re-exported from @aeye/schema
```

## Schemas on tools and prompts

```ts
// Static: the common case.
const search = new Tool({
  name: 'search',
  description: 'Search the docs',
  schema: a.object({ query: a.string(), filters: a.record(a.string()).optional() }),
  call: (input) => find(input.query, input.filters),    // input: { query: string; filters?: Record<string, string> }
});

// Dynamic: the shape depends on ctx. The bundle is built once; its dynamic step
// runs per bind, cached by `key`. The ctx type is checked against the tool's.
const Classify = a
  .declare<{ Category: string }>()
  .dynamic((ctx: Context<{ categories: string[] }, {}>) => ({ Category: a.enum(ctx.categories) }), { key: (ctx) => ctx.categories.join() })
  .result(a.object({ category: a.ref('Category'), score: a.number() }));

// Prompt outputs bind with (ctx, input).
const summarize = new Prompt({ name: 'summarize', description: '…', content: 'Summarize {{text}}', schema: a.object({ summary: a.string() }) });
```

| Was (zod) | Now |
|---|---|
| `schema: z.object(...)` | `schema: a.object(...)` |
| `schema: (ctx) => z...` | a bundle with `.dynamic((ctx) => ({ ...named types }), { key })` |
| `schema: (input, ctx) => z...` on a prompt | `.dynamic((ctx, input) => ...)` |
| `schema: () => undefined` / `() => false` | `applicable: (ctx) => false` |
| `schema: z.string().min(5)` on a prompt | `schema: a.string().min(5)` — the answer is the model's **text**, checked against it (no response format is sent) |
| custom `parse` hooks | `a.codec(wire, { decode, encode })` / `.refine(...)` on the schema (`decode` may return an `Error` or a `Rejection` of issues at paths) |
| `strictify` / `toJSONSchema` / `decodeWire` | the request's plan (below) |

The value `call` (and a prompt's result) receives is always in the **code shape**: records are records, an optional left out is absent (never `undefined`, never a `null` the model wrote for it), JSON text is parsed, whatever the model's dialect made it write.

## The `strict` policy (tri-state)

`Tool.strict` and `Prompt.strict` (and `ToolDefinition.strict` / `ResponseFormat.strict`) are `boolean | number`:

| Value | Meaning |
|------|---------|
| `true` | The strongest preference. `@aeye/ai` filters model selection to strict-capable models. In a request it is fitted first — but if the provider's limits run out it goes non-strict and says why (requests never error). |
| `false` | Not strict: the family's loose rendering, no `strict: true` on the wire. (Claude has no non-strict structured output, so a `strict: false` output goes as prompt text.) |
| `number > 0` (default `1`) | Prefer strict. Higher numbers are fitted first. |

A schema that isn't sent strict is still validated by the same schema when the answer is decoded; only the model isn't constrained.

## One request, planned as a whole

Providers limit the **request**, not just each schema: Anthropic takes 20 strict tools, 24 optional parameters and 16 union-typed parameters per request; OpenAI 128 tools and per-schema size limits. So the rendering of one schema depends on the others. A provider plans every request for its model:

```ts
const sent = await prepareRequest(request, model, { speaks: new Set(['openai']) });
sentTools(sent);   // [{ name, description, parameters (JSON Schema), strict, definition, entry }]
sentOutput(sent);  // { schema, strict, entry } | undefined (prompt-text delivery)
sent.plan;         // the RenderedRequest: entries, degradations, dispatcher, …
```

`prepareRequest(request, model, opts)` (`model` is `@aeye/ai`'s `ModelInfo`, or any `{ id, provider, strictFormat?, capabilities? }`):

1. **Plans** with `profileFor(model, { speaks }).request([...tools, output])`. The profiles come from the model's capabilities (`strictFormat`, the provider, an OpenRouter `vendor/` id prefix; `'toolsStrict'`, `'structured'`, `'json'`); a family the provider doesn't `speak` gets lenient schemas. Each schema takes the first rendering that fits its own and the request's limits: as is → optionals as `null` → large enums widened → deep nesting as JSON text → not strict. Past the tool cap the least wanted tools go behind **one dispatcher tool**, `run_tool({ tool, args })`, which the prompt decodes back to the original tool. Every compromise is recorded (`plan.degradations`, each entry's `adjustments` and `reasons`); nothing throws.
2. **Pins** the plan on each `ToolDefinition.plan` and on the response format's `plan`, so the prompt decodes each answer through the exact rendering the model was shown.
3. **Renders templates** that show schema values (`{{encode}}`, `{{schema}}`, an encoder in a function-form instruction) for this model (see below).
4. **Delivers an output as prompt text** when the plan says so (`schemaDelivery: 'json' | 'prompt'`, a model without structured output, Claude with `strict: false`): the system prompt gets `The response must be JSON of this type:` with the TypeScript-like shape and the family's JSON instruction, and the response format becomes JSON mode or plain text.

Without a provider that plans (a test executor), the prompt plans lenient: the code shape.

| Function | What |
|---|---|
| `prepareRequest(request, model, { speaks?, dispatcherName? })` | The request as a provider sends it (above). Async (templates may run instruction functions). |
| `planRequest(request, model?, opts?)` | Just the plan, pinned (sync). Without a model: lenient. |
| `requestPlan(request)` | The pinned plan, or a lenient one. |
| `sentTools(request)` / `sentOutput(request)` | What to put on the wire. |
| `deliverSchema(request, delivery?)` | Move the output into the system prompt (providers without structured output: `deliverSchema(request, 'prompt')`). |
| `outputInstructions(entry)` | That system text. |
| `hasStrictFamily(family)` | Whether a family has a strict profile (built in: openai, anthropic, google, xai; or `registerProfile`). |
| `mapSchemaArgs(schema, map)` | A schema whose bind arguments are mapped (async) from the caller's — `@aeye/ai` binds with the full AI context. |
| `TEXT_TOOL_SCHEMA` | `a.object({ input: a.string() })`, a free-text tool's schema. |

What each provider family is sent (pairs vs open records, `null` vs omitted optionals, recursion, `$defs`, constraints, size limits) is the profile table in `aeye-schema.md`. Custom dialects: `registerProfile(profile)` from `@aeye/schema`.

## Errors for the model

When arguments or an output don't fit, the model is told in its own shape: its JSON echoed back, trimmed, with a marker under each mistake, "did you mean" for misspelt names, and the expected type — within a hard size cap.

```
Error parsing tool arguments: 1 problem in the arguments of manageData:

{
  "action": "write"
            ^^^^^^^ action: Expected one of: read.
}
```

`errorFormat` sets how much (a detail level `'summary' | 'list' | 'markers' | 'full'`, or `{ detail, maxErrors, maxChars, suggestions, expected, context, depth }`):

| Level | Where |
|---|---|
| request | `ctx.errorFormat` (every tool and output in the prompt's requests) |
| definition | `ToolInput.errorFormat`, `PromptInput.errorFormat` — wins over the request |
| call | `tool.parse(ctx, args, plan, onRepair, { errorFormat })` — wins over both |

Default `'full'` within 2000 characters. A tool call is answered `Error parsing tool arguments: <message>`; an output retry sends the message as the user turn. Invalid JSON is still `The output was not valid JSON: …` (and drives the runtime prompt-text fallback).

## Values in instructions and prompts

A value written into a template as plain JSON is in the code shape; a strict model may write the same record as pairs or an absent optional as `null`. Core registers two Handlebars helpers for the templates it compiles (tool `instructions`, prompt `content`):

```hbs
Call it like {{encode example}}.               {{!-- a tool's own args; the output in a prompt --}}
Search takes {{encode q tool="search"}}.      {{!-- another schema of the request --}}
The shape: {{schema}}                          {{!-- as TypeScript --}}
```

Function forms get a value-only encoder: `instructionsFn: (ctx, encode) => \`Call like ${encode(example)}\``, tool `input: (ctx, encode) => ...`, prompt `input: (input, ctx, encode) => ...`; also `await tool.encoder(ctx, plan?)`. Text that uses them is rendered once in the code shape and again for the model when the request is planned (so an instruction function runs twice); text that doesn't is rendered once. A template variable named `encode` or `schema` still wins over the helper.

## Repairs

A top-level field sent as a JSON string (Claude does this with large arguments) is parsed back; the prompt emits `toolArgRepairAttempt { fields, success }` either way. A string of JSON text that doesn't parse is told as such ("send the value itself, not as a string").

## zod

Core takes no zod (its `zod` dependency is gone). The step-1 bridge that walked a zod schema into `a` (`fromZod`, `isZodSchema`, the function forms, the custom `parse` hooks) was removed in step 2, once @aeye/gin and @aeye/query produce `a` schemas: gin's grammar is `GinGrammar` / `buildSchemas` (binds) and `Type.toA()`, query's is `buildSchemas` (binds) and `buildQueryTool`, whose codec decodes the arguments into a runnable `Query`.

## Gotchas

- Build schemas at module scope. Renderings are memoized per schema instance and profile; a schema rebuilt per call renders per call. Give a dynamic step a `key`.
- `ToolDefinition.parameters` / `ResponseFormat.type` are `Bound`s (`schema.bind()`), not JSON.
- A request is re-planned on every send (cheap: renderings are memoized), so a schema fallback (`non-strict`, `json`, `text`) takes effect on the retry.
- Per-package `tsc` resolves sibling packages through their built `dist`; until the stack is rebuilt (step 3), type-check against sources.
