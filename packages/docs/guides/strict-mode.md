# Strict Mode

Strict mode is the LLM provider feature that grammar-constrains tool inputs and structured output to your JSON Schema — the model can't return malformed arguments or off-schema fields. `@aeye` reconciles each provider's flavor of strict (OpenAI, Anthropic, Google) under one config knob so the same Zod schema works everywhere.

## The `strict` flag

`Tool.strict` and `Prompt.strict` are `boolean | number`:

| Value | Meaning |
|---|---|
| `true` | **Require** strict. Selection filters out models that don't declare strict support — request fails if none qualify. |
| `false` | **Force** lenient. Standard JSON Schema, no `strict: true` on the wire. |
| `number > 0` (default `1`) | **Prefer** strict, accept fallback. The number is a priority — used when there are more strict-requesting items than the model's per-request budget allows. |
| omitted | Treated as `1`. |

```typescript
import { Tool } from '@aeye/core';
import z from 'zod';

new Tool({
  name: 'lookup',
  description: 'Look up a record by id',
  schema: z.object({ id: z.string() }),
  // strict omitted → priority 1 (best-effort)
  call: async (args) => fetch(`/api/${args.id}`).then(r => r.json()),
});

new Tool({
  name: 'critical-action',
  schema: z.object({ /* ... */ }),
  strict: true,  // hard requirement
  call: async (args) => { /* ... */ },
});

new Tool({
  name: 'optional-tool',
  schema: z.object({ /* ... */ }),
  strict: 100,  // very high preference — wins budget allocation
  call: async (args) => { /* ... */ },
});

new Tool({
  name: 'experimental',
  schema: z.object({ /* ... */ }).passthrough(),
  strict: false,  // never strict; tolerate extra fields
  call: async (args) => { /* ... */ },
});
```

The default of `1` means existing callers get strict where the chosen model supports it and lenient elsewhere — without changing anything. Set `true` only when strict is non-negotiable.

## How `strict: <number>` differs from `strict: true`

`true` participates in **selection**: a request with `strict: true` on any tool will only run against a strict-tool-capable model. If you've configured a mix of strict-capable and non-strict-capable providers and selection picks the wrong one, `strict: true` is the corrective lever.

`<number>` participates in **scoring** but never filters. Selection prefers strict-capable models but accepts any. At request build time, the chosen model determines the wire format:

- Model supports strict → emitted strict, with the number used as priority for slot allocation when budget is tight.
- Model doesn't support strict → emitted lenient, silent fallback.

For most apps `strict: 1` (the default) is correct. Reach for `strict: true` when a tool must validate, and for higher priority numbers when you have many strict-flagged tools and want to control which ones win the budget on a tight provider like Anthropic.

## Per-request budgets

Some providers cap the per-request strict load. Anthropic's documented limits:

- 20 strict tools per request.
- 24 total optional parameters across all strict schemas.
- 16 union-type parameters across all strict schemas.

When a request exceeds budget, `@aeye` walks tools in **descending priority order** (`true` → ∞, then numbers high-to-low) and degrades the over-budget tail silently — rather than failing the API call. A degraded item is emitted through its own family's **non-strict** descriptor (`OPENAI_NON_STRICT`, `GOOGLE_NON_STRICT`, …), never the family-blind `LENIENT`: some dialect rules outlive strict mode, and Google's `z.any()` encoding is one of them.

```typescript
// 25 tools all wanting strict, against an Anthropic model:
const tools = Array.from({ length: 25 }, (_, i) => new Tool({
  name: `tool-${i}`,
  schema: z.object({ /* ... */ }),
  strict: i < 5 ? 100 : 1,   // first 5 high-priority, rest default
  call: async () => {/*...*/},
}));

// Wire result:
// - Tools 0-4 (priority 100): all 5 ship strict.
// - Tools 5-19 (priority 1): 15 more ship strict (budget = 20 total).
// - Tools 20-24: ship lenient.
// - API call succeeds; the lenient tools just don't have grammar enforcement.
```

OpenAI doesn't publish hard caps, so its budget is unbounded. Google Gemini also has no documented per-request cap.

## Per-schema size limits

Separate from the per-request budget, a dialect may bound how big ONE schema can be. OpenAI documents four such limits for Structured Outputs, and `OPENAI_STRICT` declares them (`FormatDescriptor.schemaSizeLimits`):

| Bound | Limit |
|---|---|
| object properties, summed over every nesting level | 5,000 |
| levels of nesting | 10 |
| characters over all property names + enum values + const values | 120,000 |
| enum values summed across every enum property | 1,000 |
| characters of ONE enum's string values, when that enum has more than 250 | 15,000 |

Because each is a sum over a single schema, no other tool in the request can change the verdict — so an over-size tool is degraded on its own (to `OPENAI_NON_STRICT`) **even when it asked for `strict: true`**, and the rest of the request stays strict. `checkSchemaSizeLimits(schema, descriptor)` returns one line per bound broken, which is the answer to "why did my tool silently stop being strict?".

Anthropic and Google publish no equivalent size ceilings, so their descriptors declare none.

## Format families

A model's strict-mode JSON Schema dialect is one of three families. Each provider's strict mode is its own beast — the dialects are NOT interchangeable:

| Family | What's distinctive |
|---|---|
| `openai` | Records → array-of-pairs, tuples → numeric-key objects, `optional → T \| null`, all fields required. |
| `anthropic` | Closed objects + all-required honored, but no recursive schemas, no length / numeric constraints, per-request slot budgets. |
| `google` | Standard `prefixItems`, `$ref: '#'` recursion, `propertyOrdering` emitted, restricted format whitelist (date-time / date / time only). No combinators and no named `$defs`, so `z.any()` emits the empty schema `{}` rather than an `anyOf` union. |

`@aeye/core` ships seven `FormatDescriptor` constants encoding all this: `OPENAI_STRICT`, `ANTHROPIC_STRICT`, `GOOGLE_STRICT`, `LENIENT`, plus three non-strict family aliases. See the [`@aeye/core` README](https://github.com/ClickerMonkey/aeye/blob/main/packages/core/README.md#strict-mode) for the full descriptor table and how to register a custom one.

## Wiring up the curated table

`@aeye/models` ships `strictSupport` — a hand-maintained `ModelOverride[]` listing the model families known to support strict (gpt-4o+, claude 4.5+, gemini 2.0+). Splat it into your `AI` config:

```typescript
import { models, strictSupport } from '@aeye/models';

const ai = AI.with()
  .providers({ openai, anthropic, google })
  .create({
    models,
    modelOverrides: [...strictSupport],
  });
```

Without it, models default to lenient even when their underlying API supports strict. With it:

- `gpt-4o`, `gpt-4.1`, `gpt-5`, `o1`/`o3`/`o4` get the OpenAI dialect.
- AWS Bedrock + Claude 4.5 / Sonnet 4 / Haiku 4 / Opus 4 get the Anthropic dialect.
- OpenRouter `openai/*`, `anthropic/*`, `google/gemini-2+` get their respective dialects, for **tool** schemas as well as `response_format`. (Before 0.4.x only `response_format` was family-aware on OpenRouter; tool schemas silently fell back to LENIENT for every non-OpenAI model, which is how Gemini ended up receiving a recursive `$defs/Any` it answers `400 INVALID_ARGUMENT` to whenever a tool call is forced.)

You can mix it with your own overrides:

```typescript
modelOverrides: [
  ...strictSupport,
  // Your overrides:
  { modelPattern: /gpt-4/, overrides: { tier: 'flagship' } },
  // Mark a custom model as strict-capable:
  { provider: 'my-provider', modelId: 'flagship', overrides: { strictFormat: 'openai' } },
],
```

## Auto-resolution and `strictFormat`

Each `ModelInfo` has a `strictFormat?: 'openai' | 'anthropic' | 'google' | 'none'` field:

- Set to a family name → opts the model into strict (auto-derives the `'toolsStrict'` capability) and pins the dialect.
- Set to `'none'` → explicitly opts out, even if some upstream source had marked the model strict-capable.
- Unset → the dialect is auto-resolved at request-build time via `resolveStrictFormat(model)`:
  1. `model.provider` if it matches a family name (covers direct `openai` / `anthropic` / `google` providers).
  2. The `[family]/...` prefix of `model.id` (covers `openai/gpt-4o` on OpenRouter).

The fallback resolves the *dialect* but does **not** auto-add the `'toolsStrict'` capability. The capability comes from explicit `strictFormat` (or from a scraper that sets it directly). This avoids the failure mode where every legacy gpt-3.5-turbo silently gets treated as strict-capable and crashes against a real strict request.

## Validation roundtrip

When a strict-capable model returns its dialect's wire shape (e.g. an array-of-pairs record from OpenAI), the Prompt's validator needs to accept that shape. `@aeye` handles this transparently — the chosen descriptor id is pinned on the request before it's sent, and the same descriptor's `strictify` rewrite is applied to the schema during validation. The cache makes both calls hit the same Zod object reference.

You don't have to do anything for this to work — but if you're authoring a custom Prompt validator or post-processing tool args yourself, use `strictify(schema, descriptor)` from `@aeye/core` to get the matching shape. See the [core README](https://github.com/ClickerMonkey/aeye/blob/main/packages/core/README.md#strict-mode) for the schema utility reference.

## When to override

| Situation | What to do |
|---|---|
| You want every tool strict, no fallback. | `strict: true` on each tool, and add a strict-capable model to your config. |
| You have many tools and Anthropic is in the mix. | Default `strict: 1` plus `strict: <higher>` on the most-important ones. The budget allocator picks the right ones to ship strict. |
| You want NO strict on a tool that has a recursive schema. | `strict: false` — Anthropic strict can't represent recursion, and you'd rather opt out explicitly than rely on silent fallback. |
| A model in your config supports strict but isn't in `strictSupport`. | Add a custom override: `{ provider, modelId, overrides: { strictFormat: 'openai' } }`. |
| `strictSupport` marks a model as strict-capable but it's actually broken. | Override with `strictFormat: 'none'` to clear the capability. |

## Related

- [`@aeye/core` strict mode](https://github.com/ClickerMonkey/aeye/blob/main/packages/core/README.md#strict-mode) — the descriptor / schema-utility layer.
- [Tool Calling guide](./tool-calling.md) — strict applies to tool input schemas.
- [Structured Output guide](./structured-output.md) — strict applies to response schemas too.
- [Models concept](../concepts/models.md) — `strictSupport` and the curated table.
