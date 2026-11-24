# @aeye/schema

The LLM-first schema builder for the @aeye framework: `a` is to aeye what `z` is to zod, built for
tool arguments and structured outputs.

## Features

- **Typed like zod**: `a.infer<typeof X>` is the exact code type, recursion included
- **Named, lazy and dynamic types**: `a.define(...).dynamic((ctx) => ...).result(...)`, checked at compile time in every case
- **Rendered per model**: records as pairs only where the dialect needs it, `null` for absent on OpenAI strict, JSON text where recursion or "any" can't be said — chosen from the model's capabilities
- **Request-wide budgets**: every schema of one request fitted together (Anthropic's 20 strict tools / 24 optional / 16 unions, OpenAI's size limits, 128 tools), each choice recorded
- **One rendering for everything**: the JSON sent, decoding, error paths, examples and `{{encode value}}` in instructions all agree
- **Copy-light decoding**: validated and decoded in one pass, in place; untouched subtrees are the same references
- **Errors where the model wrote them**, plus the path the code sees
- **Imports** JSON Schema (MCP, OpenAPI) and gin types

## Installation

Not yet published (`private`); used from the monorepo workspace.

## Quick Start

```ts
import { a, profileFor } from '@aeye/schema';

const SetBudget = a.object({
  owner: a.string(),
  limits: a.record(a.number().min(0)).describe((v) => `Limit per category, as ${v.recordWord}.`),
  note: a.string().optional(),
});

const req = profileFor(model).request([{ kind: 'tool', name: 'set_budget', schema: SetBudget }]);
const tool = req.get('set_budget');

send({ parameters: tool.jsonSchema, strict: tool.strict });
const res = tool.parseText(rawArgs);
if (res.ok) console.log(res.value.limits.food);
else reprompt(res.message);   // "- at limits[0].value: Must be at least 0."
```

In instructions:

```hbs
Example: {{encode example}}
```

```ts
instructions(vars, { helpers: tool.helpers() });
```

See [aeye-schema.md](./aeye-schema.md) for the full reference and [DESIGN.md](./DESIGN.md) for
the design and its history.

## Scripts

```bash
npm test             # vitest + type tests (tsc -p tsconfig.typetest.json)
npm run typecheck
npm run build        # tsup → dist
```
