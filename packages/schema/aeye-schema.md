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

> `private: true` for now: built and tested in the monorepo, not yet published. `@aeye/core` takes
> `a` schemas (step 1, done; core re-exports `a`); `@aeye/gin`, `@aeye/query` and the harness follow.

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
a.refOf<Out>(name)               // a ref whose NAME is runtime data (`Fields_${table}`), typed by you, checked at bind
a.never()                        // no value: an empty runtime list, a list that must stay empty
a.default(T, value)              // = T.default(value): optional on the wire, required in code, filled in on decode
a.dispatch([{ name, schema }])   // { tool, args }: args typed by tool, picked by name (the request dispatcher)
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
| `.default(value)` | zod's `.default`: the model may leave it out (or write `null` where absent is null); the code type is required and the default is written in. The description says `Default when left out: …`. |

`a.enum(list)`, `a.union(list)` and `a.discriminatedUnion(tag, list)` also take lists built at
runtime (typed by the element; an empty list is `never`). A union whose options all carry a
literal field with distinct values (a `kind`) is discriminated by it even when not declared so;
errors land inside the chosen option. `.refine` may return several messages (zod's `superRefine`).

Type-specific: `string().min/max/pattern(re, flags?)/format`, `number().int/min/max/gt/lt/positive/negative/nonnegative`, `array().min/max`,
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
  { kind: 'tool', name: 'search', schema: Search, strict: 2, errorFormat: 'list' },
  { kind: 'tool', name: 'rows', schema: Rows.bind(catalog) },   // dynamic bundles are bound first
  { kind: 'output', schema: Report },                            // name defaults to 'output'
]);
req.get('search');   // RequestEntry<a.infer<typeof Search>> — typed by name
req.sent;            // what to send: the direct tools (and the dispatcher, if any)
req.decodeCall(name, args);   // { ok, tool, value } — a dispatcher call comes back as the original tool
                              // { ok: false, tool, issues, message } — message speaks of the original tool
req.encodeCall(tool, value);  // { name, args } as this model would call it
req.degradations;    // everything that was degraded to fit, readable (informative, never thrown)
req.assertNoDegradation();    // opt-in: throws RequestLimitError if anything was degraded
profileFor(model).request(items, { failOnDegrade: true });       // the same, at planning time
```

**A request always comes back sendable**, whatever its tools: tools are often not known ahead of
time, and an error where a degradation works is worse than the degradation. Nothing is thrown by
default; each compromise is recorded on its entry and listed in `degradations`.

`strict` is core's tri-state: `true` is the strongest preference (not a guarantee), `false`
refuses, a number > 0 prefers (default `1`).
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

When the strict tool slots or the totals run out, the lowest-priority schemas go non-strict (the
model isn't constrained; the answer is still validated by the same schema), each with its reason.
Two items with one name: the second is renamed `name_2` (`requestedName` keeps the original).
More tools than the provider takes (OpenAI 128): the highest-priority ones stay tools and the rest
go behind ONE dispatcher tool, `run_tool({ tool, args })`, whose `tool` lists them (with their
`description`s) and whose `args` are their own argument schemas (one nullable field per tool on a
dialect without unions). `decodeCall('run_tool', args)` returns the original tool's name and
decoded args; each dispatched tool keeps its own entry (`delivery: 'dispatched'`, `via`).
Tool parameters are always an object: a non-object root is wrapped as `{ input: … }` and
unwrapped on decode (no copy).

### `RequestEntry`

| Member | What |
|---|---|
| `name`, `kind`, `requested` | the item |
| `base` | the profile the model offers for this kind |
| `profile` | exactly what the schema was rendered with (`base` + adjustments; a memoized variant like `anthropic-strict[optional=null]`) |
| `strict` | send with `strict: true` / as strict structured output |
| `delivery` | `'structured'`, `'prompt'` or `'dispatched'` (reached through `via`, the dispatcher) |
| `adjustments` | `optional-as-null`, `enums-widened {maxEnumValues}`, `depth-limited {maxDepth}`, `root-wrapped`, `not-strict {reason}`, `prompt-text {reason}`, `renamed {from}`, `dispatched {via, reason}` |
| `reasons` | the limits that ruled out the earlier choices |
| `jsonSchema` | the schema to send (`undefined` for prompt delivery) |
| `promptText` | the schema as TypeScript-like text plus the family's JSON instruction |
| `measure` | what it counts toward the limits (properties, depth, characters, enum values, optionals, unions) |
| `parse` / `parseText` / `parseOrThrow` | decode the answer — through the same rendering; a failure's `message` in the entry's `errorFormat` |
| `errorFormat`, `label` | how a bad answer is told to the model (the request's format, then the item's), and what it is called |
| `encode` / `encodeText` / `encoder` | code value → this model's wire shape |
| `helpers()` | Handlebars helpers for this schema |

`RenderedRequest` also has `entries` (in the order given), `tools`, `sent`, `output`, `dispatcher`,
`used` (the strict totals), `strictTools`, `limits`, `degradations`, `helpers(defaultName)`.

A bundle whose dynamic step takes other arguments than a tool's ctx is adapted:
`QueryModule.result(...).adapt((ctx: Ctx) => [ctx.catalog, { strict: true }])`.

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

### Deferred values: text written before the plan

Text made before the request it goes in is planned can't encode yet: a relaying provider forwards the request to the
one that plans it, or an application assembles a prompt (tool descriptions, a system message, a message) before its
provider plans. It holds a **deferred value** instead: the code-shape value and the schema it is written with.

```ts
const text = `Example args: ${deferEncode({ tool: 'search', value: { query: 'x', limits: { food: 3 } } })}`;
fillDeferred(text, plan);   // written through the plan's `search` entry: pairs on OpenAI strict, …
plainDeferred(text);        // before a plan: the fallback, else the code shape (estimates, logs, people)
```

| `DeferredSpec` | Meaning |
|---|---|
| `tool` / `output` | which schema of the request writes it |
| `value`, `path`, `pretty` | as `encodeText` (a part at a code path) |
| `pick` | write the whole value, then show this part of what was written (a wire path: `{ fn, args }`, pick `args`) |
| `schema`, `strict` | for a tool the request may not have (offered in a later step): its lenient JSON Schema, planned alone for the request's model |
| `fallback` | what to show where the plan can't write it (no such tool, no plan, a value that doesn't fit); else the code shape |
| `type: true` (`deferSchema`) | the schema as TypeScript-like text (`{{schema}}`) |

A whole value must read back as itself through the schema it was written for, or it is shown as its fallback: a
stale example is never dressed up as if it fitted. A value with no `tool` is written as it is (text already in the
model's shape, kept from later processing). The form is `⟦encode {…}⟧`; `DEFERRED_SPAN` splits a text around them.
`deferredRequest(plan, known?)` is a stand-in plan whose encoders and helpers write deferred values: render templates
for it and they carry every `{{encode}}`, `{{schema}}` and encoder value to where the request is planned (core's
`deferRequest`; core's `prepareRequest` fills every deferred value of a request it plans).

## Decoding

```ts
rendered.parse(wire, { inPlace?: true, repair?: true, errorFormat?, label? }): ParseResult<Out>
rendered.parseText(text)        // JSON.parse, then decode in place
rendered.parseOrThrow(wire)     // throws SchemaParseError
```

`ParseResult` is `{ ok: true, value, stats } | { ok: false, issues, message, stats }`. Each
`Issue` has `path` (where the MODEL wrote it, e.g. `['limits', 0, 'value']` or
`['children', 0, '(json)', 'value']`), `codePath` (where the code sees it, `['limits', 'food']`)
and `message`. The result's `message` is the re-prompt text, in the call's `errorFormat` (below,
"Errors for the model").

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

## Errors for the model

When an answer doesn't fit, `message` is what the model is told. It follows gin's and query's
diagnostics (`Code.formatProblems`, `aids.ts`): the model's own JSON echoed back, trimmed around
the problems, with a marker under each bad spot, the message at the marker, and "did you mean" for
names it misspelt. It is always in the model's shape: the paths and JSON are what it wrote (pairs,
`null` for absent, JSON text, a call through the dispatcher), never the code shape, and the
expected type is read from the JSON Schema it was given.

```
2 problems in the arguments of web_api_call:

{
  "url": "https://api.example.com/v1/items",
  "method": "PUTT",
            ^^^^^^ method: Expected one of: GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS — did you mean `PUT`?
  "headers": [
    {
    ^ headers[0].key: Required.
      expected: string
      "name": "X-Id",
      "value": "1"
    }
  ],
  "body": null,
  "requestType": null,
  … 1 more key
}
```

### `errorFormat`

Set on a tool or prompt definition (`ToolItem.errorFormat`, `OutputItem.errorFormat`; core's
`Tool` / `Prompt` take the same), for a whole request (`request(items, { errorFormat })`), or for
one call (`parse(wire, { errorFormat })`, `decodeCall(name, args, { errorFormat })`). Later wins:
request < definition < call. A detail level alone is shorthand: `errorFormat: 'summary'`.

| Option | Default | What |
|---|---|---|
| `detail` | `'full'` | `'summary'`: one line, the first problem and how many more · `'list'`: one line per problem · `'markers'`: the echo with markers · `'full'`: markers plus the expected type |
| `maxErrors` | `5` | distinct problems shown; the same mistake repeated counts once (`(the same at rows[3].id, rows[5].id and 997 more places)`); the rest are counted |
| `maxChars` | `2000` | a hard cap. Detail is dropped step by step until it fits: expected types, context, levels, problems shown, then value lists become counts (`one of 12 values`, the suggestion kept), then `list`, then `summary`, and only then is the text cut |
| `suggestions` | `true` | "did you mean" for enum values, literal and discriminator tags, unknown keys, a missing key the model misspelt (`Required — you wrote \`titel\`…`), tool names |
| `expected` | on for `'full'` | a short TypeScript-like type of just that spot (`{ key: string; value: Expr }[]`), only where the message doesn't already say it |
| `context` | `3` | sibling keys / items shown next to a bad spot (short ones first); the rest are summarized (`{… 4 keys}`, `[… 1000 items]`, `… 3 more keys`) |
| `depth` | `6` | levels shown above a bad spot; a deeper one is echoed from there, under a header with its path (`at program.ifs[0]…:`), its marker naming the rest (`….body.kind`) |
| `header` | `true` | the first line: how many problems, in what (`the arguments of search`, `your answer`) |

`label` (a parse option) names what the model wrote; request entries set it (`the arguments of
search`, `the arguments of search (called through run_tool)`, `your answer`).

The ranking of "did you mean" is gin's and query's, ported algorithm-identical (`suggest.ts`;
tested against both): Levenshtein, case-insensitive, within `floor(len / 3)` edits (1 to 3), ties
by exact case then order. It fires on genuine typos only: a transposition is two edits, so `opne`
is too far from `open` for a four-letter word.

A misspelt key on a closed object is one mistake, told once (at the missing key). A tool name the
request doesn't have gets the nearest name (`No tool named "serach_docs" in this request — did you
mean \`search_docs\`?`), else the list; a tool behind the dispatcher called by its own name is
decoded, not refused.

On failure the answer is put back as the model sent it (in-place writes are logged and undone,
key order included), so the echo is the wire. With `'summary'` or `'list'` nothing is logged and
the value may be left half-decoded, as before. `parseText` re-reads its text instead.

Cost: nothing on the happy path but, for an echoing format, one log entry per in-place write.
On a failure, union option trials record nothing (count only), and suggestions and expected
types are computed only for the problems shown.

Lower level: `formatErrors(issues, wire, format, label)` formats any issues; `issueKind(issue)`
(`'type'`, `'required'`, `'unknown-key'`, `'enum'`, `'tag'`, `'tool'`, `'rule'`, …) and
`suggestionFor(issue)` read what an issue was about; `formatIssues(issues)` is the bare
`- at <path>: <message>` list (logs, `SchemaParseError` without a format).

## Errors

| Error | When |
|---|---|
| `SchemaParseError` | `parseOrThrow` failed; `issues` has both paths, `message` is the model's message |
| `SchemaDefinitionError` | the code's own mistake the types couldn't catch: a missing ref at bind time, a dynamic step redefining a name, an example that doesn't fit its schema, encoding at a path that doesn't exist |
| `RequestLimitError` | only on request: `assertNoDegradation()` / `{ failOnDegrade: true }`, with `problems` listing the degradations |

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
- Where a union option is written as JSON text (an escape, or `a.json()` on a strict dialect) it
  is sent as `{ "json": "…" }`, and a record written as pairs next to a list option as
  `{ "entries": [...] }`, so neither can pass for another option.
- JSON-text escapes name their type (`… JSON text of this TypeScript type: Expr …`); the
  `type X = …` definitions are written once, in the description of the whole schema.
- Without `$defs` (Gemini OpenAPI, MINIMAL) a big recursive grammar is written out once per
  recursive named type, its later uses as JSON text (rather than inlined exponentially).
- `render(profile)` is the raw rendering; only `request()` fits a schema to the provider's size
  limits (a deep grammar can render past OpenAI's 10 levels on its own).
- A record sent as an object (or a JSON string of one) where pairs were asked for is repaired:
  its values are read in the code shape.

## Migrating from zod

Core's `Tool` and `Prompt` take `a` schemas. Most code moves one-for-one:

| zod | `a` |
|---|---|
| `import { z } from 'zod'` | `import { a } from '@aeye/schema'` (or from `@aeye/core`) |
| `z.object / string / number / boolean / array / enum / literal / union / tuple / null` | the same names on `a` |
| `z.number().int()`, `z.int()` | `a.int()` (or `a.number().int()`) |
| `z.record(z.string(), V)` | `a.record(V)`; `z.record(z.enum([...]), V)` → `a.record(a.enum([...]), V)` (keys optional) |
| `z.any()` / `z.unknown()` | `a.unknown()` (or `a.json()` typed `JsonValue`) |
| `z.string().email()` / `.url()` / `z.iso.date()` | `a.string().format('email' \| 'uri' \| 'date')` |
| `.optional()`, `.nullable()`, `.default(v)`, `.describe()`, `.min/.max`, `.refine` | the same (`.optional().default(v)` → `.default(v)`); optional means the key is ABSENT after decoding, never `undefined` |
| `.transform(fn)` | `a.codec(wire, { decode, encode })` — both directions, so values can be shown to the model |
| `z.lazy(() => Node)` | a named type: `a.define({ Node: a.object({ kids: a.array(a.ref('Node')) }) }).result('Node')` |
| `z.infer<typeof X>` | `a.infer<typeof X>` |
| `schema: (ctx) => z...` (Tool) | a bundle: `a.declare<{ T: … }>().dynamic((ctx) => ({ T: … }), { key }).result(…)` — build it once, at module scope |
| `schema: (input, ctx) => z...` (Prompt) | `.dynamic((ctx, input) => …)` — note the order |
| `schema: () => undefined` / `() => false` | `applicable: (ctx) => false` |
| `schema: z.string()` on a Prompt | `a.string()`: the answer is the model's text, checked |
| a custom `parse` hook | `a.codec` / `.refine` on the schema (the hook still works, deprecated) |
| `toJSONSchema(strictify(s, d), d)` in a provider | `await prepareRequest(request, model, { speaks })`, then `sentTools` / `sentOutput` (core) |

Things that read differently on purpose: the value a tool receives is the code shape on every model (no `null` for left-out optionals, records are records); errors are the model's JSON with markers, not zod issue lists; `ToolDefinition.parameters` is a `Bound` (`schema.bind()`). Until @aeye/gin and @aeye/query produce `a` (step 2), core also accepts their zod schemas through a temporary bridge — new code shouldn't rely on it.
