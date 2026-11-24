# @aeye/schema

**The LLM-first schema builder** for the `@aeye` stack. `a` is to aeye what `z` is to zod:
you describe a value once, in its CODE shape, and get the exact TypeScript type. Then, for
whichever model a request goes to, `@aeye/schema` renders the JSON Schema that model can read,
decodes its answer back into the code shape in one pass (copying almost nothing), reports
mistakes where the model made them, and shows values in instructions exactly as the model
writes them.

It is built for what LLM schemas need and zod doesn't have:

- **Named types, refs and dynamic parts** — a chain of `define` / `declare` / `dynamic` /
  `result`, fully typed in every case, so tool args and structured outputs are static instances
  whose dynamic parts (a registry, a DB catalog, a ctx) are bound per call.
- **Per-model rendering** — the same schema becomes records-as-pairs for OpenAI strict, open
  objects for Gemini, JSON text where recursion isn't allowed, and so on, from the model's
  capabilities.
- **Request-wide budgets** — every schema of one request is fitted together, because providers
  limit the request (20 strict tools, 24 optional parameters…), not just each schema.
- **One rendering for everything** — the JSON sent, decoding, error paths, examples and values
  in instructions all come from the same rendering, so they can't disagree.

> `private: true` for now: built and tested in the monorepo, not yet published. Integration into
> `@aeye/core`, `@aeye/gin`, `@aeye/query` and the harness follows.

## Install / import

```ts
import { a, profileFor } from '@aeye/schema';
```

One entry point. No runtime dependencies.

## Quick start

```ts
import { a, profileFor } from '@aeye/schema';

const Budget = a.object({
  owner: a.string().describe('Who owns the budget.'),
  limits: a.record(a.number().min(0)).describe((v) => `Spending limit per category, as ${v.recordWord}.`),
  note: a.string().optional(),
});
type Budget = a.infer<typeof Budget>;
// { owner: string; limits: Record<string, number>; note?: string }

// Per request: the model's profiles come from its capabilities (@aeye/models).
const req = profileFor(model).request([
  { kind: 'tool', name: 'set_budget', schema: Budget },
  { kind: 'output', schema: Report },
]);

const tool = req.get('set_budget');
tool.jsonSchema;                      // send as the tool's parameters (strict: tool.strict)
const res = tool.parseText(rawArgs);  // decode the model's answer
if (res.ok) res.value;                // Budget, in the code shape
else res.message;                     // "- at limits[0].value: Must be at least 0." → re-prompt
```

On OpenAI strict the model sees `limits` as `[{key, value}]` and `note` as `string | null`; on
Gemini it sees an open object and an optional field. `res.value` is a `Budget` either way.

## The builder

```ts
a.string() a.number() a.int() a.boolean() a.null() a.literal('x') a.enum(['a', 'b'])
a.unknown()   // any JSON value, typed unknown
a.json()      // any JSON value, typed JsonValue
a.object({ ... })  a.array(T)  a.tuple([A, B])  a.record(V)  a.record(a.enum([...]), V)
a.union([A, B])  a.discriminatedUnion('kind', [A, B])  a.optional(T)  a.nullable(T)
a.intersection([A, B])           // allOf / gin and: objects merge
a.not(excluded, base?)           // gin not / JSON Schema not
a.conditional(base, { if, then, else })
a.dependent(on, schemaFor, base?)  // a value typed by a sibling field
a.ref('Name')  a.codec(wire, { decode, encode })
a.define({...}) a.declare<{...}>() a.module() a.fromJSONSchema(json)
type T = a.infer<typeof X>;
```

Modifiers (every class; all immutable — build schemas once, at module scope):

| Modifier | What it does |
|---|---|
| `.describe(text \| (view) => text)` | Description. The function form sees the model-facing view (`view.recordWord`, `view.optional`), so prose matches the wire shape. |
| `.title(t)` | Title. |
| `.example(...values)` | Examples in the CODE shape, checked against the schema; each profile shows them in its own wire shape. |
| `.refine(fn, message?, { visible })` | A rule the types can't say. Runs on the decoded value; with a message it is shown to the model as `Rules: …`. |
| `.brand<'Zone'>()` | Nominal type only. |
| `.forPeople()` | Never shown to or accepted from a model (web forms, API callers see it). |
| `.forModels(narrower)` | What a model sees instead (e.g. an enum minus people-only members). |
| `.optional()` `.nullable()` | Optional means the key is ABSENT after decoding, never `undefined`. |

Type-specific: `string().min/max/pattern/format`, `number().int/min/max`, `array().min/max`,
`object().strict()` (unknown keys are errors), `.extend(shape)`, `.rest(V)` (extra keys, zod's
`catchall`), `.patterns({ '^x-': V })` (`patternProperties`), `.dependent(key, on, fn, base?)`.

### Values typed by a sibling

```ts
const CreateVar = a.object({ name: a.string(), type: TypeDef })
  .dependent('value', 'type', (type) => schemaOfType(type));   // `type` is typed from the sibling
```

The model sees `value` as any JSON (JSON text on strict dialects) with "Its type is given by
"type"."; decoding checks the value against the schema built from the `type` it just wrote,
in the code shape. `schemaFor` may name the bind's own types (`a.ref(name)`).

## Named types and the chain

```ts
const Tree = a
  .define({ Node: a.object({ value: a.number(), children: a.array(a.ref('Node')) }) })
  .result('Node');                      // a.infer<typeof Tree> is a real recursive type

const Query = a
  .define({ Filter: a.object({ field: a.ref('Field'), equals: a.string() }) })
  .dynamic((ctx: Ctx) => ({ Field: a.enum(ctx.fields) }), { key: (ctx) => ctx.version })
  .result(a.object({ where: a.ref('Filter') }));
const bound = Query.bind(ctx);          // cached by key
```

Every mistake is a compile error: an undefined ref, a dynamic step that misses a ref, a wrong
declared shape, redefining a name, a ctx that doesn't supply the dynamic args. `declare<{ Type:
TypeDef }>()` pins the code type of a ref the dynamic step will supply. A bound schema is
`Bound<Out>`; a ref-free schema is its own bound (`schema.bind()`, `schema.render(profile)`).

## Profiles

A **profile** is what one model reads, for one kind of schema, strict or not. Every field is
read by exactly one place in rendering. Pick profiles with `profileFor(model)` — never by hand at
a call site.

### What each provider gets

| Profile | Records | Optional | Tuples | Null | Any | Recursion | Constraints | Notes |
|---|---|---|---|---|---|---|---|---|
| `OPENAI_STRICT` | pairs | `null` | `{"0":…}` | `anyOf` | JSON text | yes | all; basic regex; 9 formats | root object; 5,000 props / 10 levels / 120k chars / 1,000 enum values per schema; 128 tools |
| `OPENAI_FINETUNED_STRICT` | pairs | `null` | `{"0":…}` | `anyOf` | JSON text | yes | none, no formats | fine-tunes reject every constraint keyword |
| `OPENAI_NON_STRICT` | open | omit | prefixItems | type array | `{}` | yes | all | best effort |
| `ANTHROPIC_STRICT` | pairs | omit | `items: anyOf` | type array | JSON text | **no** (JSON text) | none but `minItems` 0/1; basic regex; 10 formats | 20 strict tools, 24 optional, 16 union-typed params **per request**; output always strict |
| `ANTHROPIC_NON_STRICT` | open | omit | prefixItems | type array | `{}` | yes | all | tool input_schema root is an object |
| `GOOGLE_STRICT` | open | omit | prefixItems | type array | `{}` | guarded | range, items; no length, no pattern; date/time formats | enum cap 40 (measured) |
| `GOOGLE_NON_STRICT` | open | omit | prefixItems | type array | `{}` | guarded | all | enum cap 40 |
| `GOOGLE_OPENAPI` | pairs | omit | `items: anyOf` | `nullable: true` | JSON text | no (no `$defs`) | all; basic regex | Gemini `responseSchema`; `propertyOrdering` |
| `XAI_STRICT` | **open** | omit | prefixItems | type array | flat `anyOf` | no (JSON text) | all; basic regex; 8 formats | tools are always strict |
| `OLLAMA` | open | omit | prefixItems | type array | `{}` | yes | all | llama.cpp grammar; never sent `strict` |
| `LENIENT` / `PEOPLE` | open | omit | prefixItems | type array | `{}` | yes | all | the code shape; `PEOPLE` shows people-only fields |
| `MINIMAL` | pairs | `null` | `{"0":…}` | type array | JSON text | no | none | test dialect: no combinators (tagged unions), no `$defs`, depth 6, enum cap 8 |

"Guarded" recursion: a `$ref` may point back only through an optional or nullable value, or an
array/record that may be empty (Gemini rejects ref loops through required values). Any other
back-edge becomes JSON text.

**"Strict models see pairs" is a dialect rule, not a strictness rule.** A record is written as
`[{key, value}]` only where the dialect forbids a schema-valued `additionalProperties`: OpenAI
strict and Anthropic strict (`additionalProperties` must be `false`) and Gemini's OpenAPI subset
(no `additionalProperties`). xAI strict and Gemini's JSON Schema mode are strict and take open
records, so their models see plain objects.

Sources: each provider's docs (OpenAI Structured Outputs + function calling, Anthropic structured
outputs, Gemini structured output + function calling + `Schema` reference, xAI structured
outputs, OpenRouter structured outputs + provider routing, Ollama structured outputs), read
2026-11-04 and listed in `docs/plans/schema-dialects-2026.md`; plus aeye's live measurements
(core `dialects/*`, the 2026-11-04/05 live-schema run). Each profile's doc comment cites its facts.

### `profileFor(model)`

```ts
profileFor(model: ModelLike, opts?: { speaks?: ReadonlySet<string> }): ModelProfile
// ModelProfile { tool: Profile; output: Profile; outputDelivery: 'structured' | 'prompt'; request(items) }
```

`ModelLike` is `{ id, provider, strictFormat?, capabilities? }` — `@aeye/ai`'s `ModelInfo` fits
as it is.

- The family comes from `strictFormat` (pinned by `@aeye/models`' `strictSupport`; `'none'` opts
  out), else the provider (`openai`, `anthropic`, `google`, `xai`, `ollama`; Bedrock Claude ids
  → `anthropic`), else the `vendor/` id prefix — routers like OpenRouter pass the schema through
  to the upstream family. Open-weight models under a vendor prefix (`openai/gpt-oss-*`,
  `google/gemma-*`) are served by other hosts and stay lenient.
- Tools are strict with the `'toolsStrict'` capability; xAI tools always are.
- Output is strict with `'structured'`. Without it, the output is delivered as prompt text when
  the family has no non-strict structured output (Anthropic, Bedrock) or the model has no `'json'`.
- OpenAI fine-tunes (`ft:` ids) get `OPENAI_FINETUNED_STRICT`.
- `speaks`: families the provider can send; anything else is `LENIENT`.

Custom dialects: `registerProfile(profile)` (lookup by id with `getProfile`, by family with
`familyProfile(family, strict)`).

## Requests: fitting every schema together

```ts
const req = profileFor(model).request([
  { kind: 'tool', name: 'search', schema: Search, strict: 2 },
  { kind: 'tool', name: 'rows', schema: Rows.bind(catalog) },   // dynamic bundles are bound first
  { kind: 'output', schema: Report },                            // name defaults to 'output'
]);
req.get('search');   // RequestEntry<a.infer<typeof Search>> — typed by name
req.problems;        // limits no choice could fix (too many tools, hard-strict overflow)
req.assertFits();    // throws RequestLimitError when problems isn't empty
```

`strict` is core's tri-state: `true` requires, `false` refuses, a number > 0 prefers (default `1`).
Items are fitted in priority order (`true` first, then higher numbers), so the most wanted
schemas spend the budget first. For each schema the first choice that fits its per-schema limits
AND what is left of the request's limits wins:

1. the model's profile for its kind, as is;
2. absent optionals written as `null` (Anthropic: trades optional parameters for union types);
3. large enums widened to a string listing the values (fewer enum values and characters; still
   enforced on decode);
4. deep nesting written as JSON text (fewer levels and properties);
5. not strict: the family's loose profile — or, for an output whose family is always strict
   (Claude), prompt-text delivery.

`strict: true` is never degraded for the BUDGET — an overflow goes in `problems` — only for a
per-schema limit no request could meet. Tool parameters are always an object: a non-object root
is wrapped as `{ input: … }` and unwrapped on decode (no copy).

### `RequestEntry`

| Member | What |
|---|---|
| `name`, `kind`, `requested` | the item |
| `base` | the profile the model offers for this kind |
| `profile` | exactly what the schema was rendered with (`base` + adjustments; a memoized variant like `anthropic-strict[optional=null]`) |
| `strict` | send with `strict: true` / as strict structured output |
| `delivery` | `'structured'` or `'prompt'` |
| `adjustments` | `optional-as-null`, `enums-widened {maxEnumValues}`, `depth-limited {maxDepth}`, `root-wrapped`, `not-strict {reason}`, `prompt-text {reason}` |
| `reasons` | the limits that ruled out the earlier choices |
| `jsonSchema` | the schema to send (`undefined` for prompt delivery) |
| `promptText` | the schema as TypeScript-like text plus the family's JSON instruction |
| `measure` | what it counts toward the limits (properties, depth, characters, enum values, optionals, unions) |
| `parse` / `parseText` / `parseOrThrow` | decode the answer — through the same rendering |
| `encode` / `encodeText` / `encoder` | code value → this model's wire shape |
| `helpers()` | Handlebars helpers for this schema |

`RenderedRequest` also has `entries` (in the order given), `tools`, `output`, `used` (the strict
totals), `strictTools`, `limits`, `helpers(defaultName)`.

## Values in instructions and prompts

A value written into a template as plain JSON is in the CODE shape; a strict model may write the
same record as pairs or an absent optional as `null`. `{{encode value}}` writes it in the shape
of the schema the model actually has, for its profile, in this request.

```hbs
Call it like: {{encode example}}
The current limits are {{encode limits path="limits"}}.
Return something like {{encode sample output=true pretty=true}}.
Search takes {{encode query tool="search"}}.
The shape: {{schema}}
```

| Option | Meaning |
|---|---|
| `path="a.b"` | the value is the part at this code path (`*` for any element/key) |
| `pretty=true` / `pretty=2` | indent the JSON |
| `tool="name"` / `output=true` | another schema of the request (request helpers only) |

Two ways to supply them (both work with core's `noEscape: true`, and without it — the JSON is
never HTML-escaped):

```ts
// per render
template(vars, { helpers: req.helpers('search') });      // or entry.helpers(), schemaHelpers(rendered)

// once
registerSchemaHelpers(Handlebars);                       // names: { encode?, schema? }
template(vars, { data: schemaData(req, 'search') });
```

Function-form instructions use the entry's **encoder**, which needs only the value (the profile
and bind come from the entry):

```ts
const encode = req.get('search').encoder;
encode({ query: 'x' });                      // JSON text in the model's shape
encode({ kind: 'note' }, { path: 'filters' });
encode.wire({ query: 'x' });                 // the same, as a JSON value
```

## Decoding

```ts
rendered.parse(wire, { inPlace?: true, repair?: true }): ParseResult<Out>
rendered.parseText(text)        // JSON.parse, then decode in place
rendered.parseOrThrow(wire)     // throws SchemaParseError
```

`ParseResult` is `{ ok: true, value, stats } | { ok: false, issues, message, stats }`. Each
`Issue` has `path` (where the MODEL wrote it, e.g. `['limits', 0, 'value']` or
`['children', 0, '(json)', 'value']`), `codePath` (where the code sees it, `['limits', 'food']`)
and `message`. `message` is the re-prompt text.

**Repair** (default on): a container sent as a string of JSON text (also double-encoded) is
parsed, and a value sent directly where JSON text was asked for is taken as is. Each repair is
counted in `stats.repaired`.

### Copies

| Situation | Allocation | Counter |
|---|---|---|
| A subtree whose wire shape is its code shape | none; checked and returned as the same reference | — |
| A whole non-strict answer with no rewrites | none; `parse(x).value === x` | — |
| Optional written as `null` (strict) | none; the key is deleted in place | `edits` |
| A child whose decoded value differs (in place) | none; written back into the parent | `edits` |
| A record sent as `[{key, value}]` | one new object per record; values moved by reference | `objects` |
| A tuple sent as `{"0":…}` | one new array per tuple; items moved | `arrays` |
| JSON text (escape hatch, `any` on strict) | one `JSON.parse`, then decoded in place | `parsed` |
| A container sent as a JSON string | one `JSON.parse` | `repaired` |
| `parse(x, { inPlace: false })` | the first change in a container clones that container once; siblings shared | `objects` / `arrays` |
| A tagged union (no combinators) | none; the wrapper is dropped | — |
| A `{input}`-wrapped root | none; the field is picked | — |

Encoding never mutates the code value: where the wire shape is the code shape it returns the
value itself; otherwise only containers on the path to a change are new (`encode(value, stats)`
counts them).

## Errors

| Error | When |
|---|---|
| `SchemaParseError` | `parseOrThrow` failed; `issues` has both paths |
| `SchemaDefinitionError` | the code's own mistake the types couldn't catch: a missing ref at bind time, a dynamic step redefining a name, an example that doesn't fit its schema, encoding at a path that doesn't exist |
| `RequestLimitError` | `RenderedRequest.assertFits()` with `problems` |

Model mistakes are never thrown by `parse`; they come back as issues for a re-prompt.

## Importing outside schemas

`fromJSONSchema(json, report?)` turns an MCP tool's `inputSchema`, an elicitation form or an
OpenAPI body into a bundle: `$defs`/`definitions` become named types and `$ref`s refs (recursion
stays recursion), `allOf` an intersection (objects merge), `not` and `if`/`then`/`else` rules,
`patternProperties` and a schema-valued `additionalProperties` next to `properties` extra keys.
A type-less schema whose keywords imply a type (`{ minLength: 2 }`) is read as that type.
`dependentSchemas`, `dependentRequired` and external `$ref`s are reported in
`report.unsupported` and left unchecked.

## Gin

`fromGin(typeDef)` converts a gin `TypeDef` (and `GinSchema<T>` types it): `text`, `num`, `bool`,
`list`, `map` (a record; pairs are the profile's job), `obj`, `optional`, `nullable`, `enum`,
`literal`, `or`, `tuple`, `and` (merged objects), `not`, `iface` (an open object with its props),
`date`/`timestamp`/`duration`/`color`, `typ` → `a.ref('TypeDef')`, `fn` → `a.ref('Expr')`, and any
other name → `a.ref(name)`. `ginNamedTypes(registry)` gives a registry's named types as the defs
of a dynamic step.

## Gotchas

- Build schemas once at module scope. Renderings are memoized per (schema instance, profile);
  a schema rebuilt per call renders per call.
- A `dynamic` step without `key` runs on every `bind`. Give it a key (a registry version).
- Under a `null`-for-absent profile, an optional NULLABLE field keeps `null` as `null`: absent is
  never produced for it (the two can't be told apart on the wire).
- Unknown keys are left in place on decode (no copy to strip them) unless the object is
  `.strict()`; encoding keeps them too, except people-only fields, which are dropped.
- `schemaFor` of a sibling-typed value should return cached schemas: a new instance is compiled
  on first use.
