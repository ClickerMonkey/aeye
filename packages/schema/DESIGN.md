# @aeye/schema: design

## Phil's request (verbatim)

> I want a zod alternate in a new aeye/schema package. Much of the logic from core schema logic would move to this. I want a solution with basically no data copying or as little as possible no matter what the model being used is. It should be as type safe as zod but designed for llms and parts of the schema that are dynamic. Like tool args and prompt structured output would change from an optional function to always one of these static instances but with dynamic parts. The code of the different types should be implemented using classes. Gin will need to be converted to generate these. These will be very similar, but the goal of this is to perfectly represent any schema to a model no matter what is supported. It generates correct json schema based on what's supported on demand. It should be first class to have named types and be able to use them. There should be an a export that is like z for zod. It should let you define the types (if named types are desired) with some that have a lazy definition. a.ref is used and resolved in later chain. Then the types that weren't defined in the chain can be dynamically be defined with a dynamic function that accepts any args but returns an object with the remaining refs to be defined. This makes it support query schemas or Ginny's which can be based on ctx. And finally whatever the result type should be, whether it's a ref to an object or a new object definition. Even with all of this complexity it should have a well defined return type. In every scenario. This will be complex typescript code to satisfy these requirements. Do a poc and prove it will work - mainly I'm interested in the interfaces and function signatures showing how it will be used and proving the type system will work. Show it to me in hitl when ready for review

> Make sure it's crystal clear that the schemas in the harness, gin, query, etc should all be representable in this static but partially dynamic schema builder. It needs to cover all use cases.

After the POC review:

> - we'll want a handlebars function for instructions and prompt that takes a json value and passes it through the schema of the args or prompt. Also the Fn version of those should have function to encoded where just the value is required
> - some profile stuff is complex because there are request wide restrictions so the schema that's finally determined per schema in a request needs to match what's used in the profile
> - "strict models still see pairs" that applies for gpt models but not all, make sure that's understood
> - make sure this is fully made and unit tested with all the examples we have across these packages and projects and sure each of those scenarios are tested for every piece of functionality including producing the expected type. The most complex example I can think of is in the 'product" repo the query builder has varying levels of strictness. I'm pretty sure that's in there - it's quite extensive. Create the new package and let me know when it's done and then we can integrate it into core and generate unit tests there as well. Then after that's good we'll integrate it with gin and query and test it. Then harness. I want notes on performance and memory usage etc. ideally comparing zod. I want this all feel native and meant to be together with the other libraries.

During pass 2:

> Let's make sure if too many tools request strict or anything about a request can't be supported we have proper degradation and not errors. Sometimes the tools are not known ahead of time and error when we don't have to is not good

### Pass 4: errors for the model

> Oh yeah that's one thing I didn't explicitly state... But zods errors are terrible. I love what I have in gin and query where it outputs json with markers and did you mean support etc. let's have those same options specifiable so we feed back to the llm meaningful errors that are super clear and not huge even if the schema is huge. There should be an error format with options so on the tool and prompt definition they dev can specify how detailed they want the schema error feedback to the llm.

Pass 3's benchmarks time the invalid-answer path (checking a wrong answer and building the message the model gets back) and record the message sizes, as the baseline for this pass (PERFORMANCE.md, "Errors").

## Status

Four passes after the POC review:

1. **The package (done).** Complete and production-quality, no longer a POC: request-wide budgets, an accurate per-provider profile table chosen from model capabilities, the Handlebars `{{encode}}` helper and value-only encoders, the remaining types (intersections, `not`, if/then/else, sibling-typed values, extra keys), `{input}`-wrapped roots, auto-repair, error classes, docs (`aeye-schema.md`, `README.md`) and tests for each. In the root workspaces, still `private`.
2. **Every example ported as tests (done).** `src/__tests__/corpus/`: faithful ports of the real schemas of @aeye/query, product's query kind, gin, ginny, core, cletus and the other @aeye packages, and the harness — each checked for its static type, rendering on every profile family, decoding model-shaped answers with copy counts, errors with both paths, encoding and `{{encode}}`, examples and request budgets; query, product, gin and ginny are also checked value-for-value against the real zod/gin schemas. Plus Phil's request-degradation change (below).
3. **Performance and memory notes vs zod (done).** `bench/` and PERFORMANCE.md; summary below.
4. **Errors for the model (done).** gin's and query's diagnostics (the model's JSON with markers, "did you mean") as the native error output of every decode, with a detail level and a size cap set on the tool / prompt definition; below.

Then integration: core (with core's own tests), gin and query, then the harness.

### Pass 1 decisions

- **Request budget API.** `profileFor(model).request(items)` returns a `RenderedRequest`. Each `RequestEntry` records the exact profile it was rendered with (a memoized variant of the model's profile, e.g. `anthropic-strict[optional=null]`), its `adjustments`, `reasons`, `strict` and `delivery`. `parse`, `encode`, examples and the template helpers all go through the entry's one `Rendered`, so they match the JSON sent by construction. The fitting ladder (as is, then optionals as null, then widened enums, then deep nesting as JSON text, then not strict or prompt text) generalises core's `SchemaBudget`, measured on the emitted JSON instead of estimated from zod.
- **Pairs.** Records are pairs only where the dialect forbids a schema-valued `additionalProperties` (OpenAI strict, Anthropic strict, Gemini's OpenAPI subset), not on every strict model: xAI strict and Gemini's JSON Schema mode see open objects. Tested per profile.
- **OpenAI's size limits are per schema**, as OpenAI documents them. The request-level limits that exist are Anthropic's three totals and OpenAI's 128 tools. `RequestLimits.totals` takes any `SchemaLimits` field, so a provider that sums sizes over a request is one profile entry away.
- **Profiles from capabilities.** `profileFor` mirrors `@aeye/ai`'s `resolveStrictFormat` and `buildSchemaBudget` on a structural `ModelLike` (no dependency on `@aeye/ai`).
- **Handlebars.** `{{encode value [path= pretty= tool= output=]}}` and `{{schema}}`, supplied per render (`helpers: entry.helpers()`) or registered once (`registerSchemaHelpers` + `data: schemaData(entry)`). The value-only encoder for function-form instructions is `entry.encoder`.
- **Open questions settled:** 1 (budgets: option (a), on the emitted JSON), 2 (`.dependent(key, on, fn)`, the sibling typed), 4 (and becomes a merged object or an intersection, not a rule, iface an open object), 6 (repair on by default, counted, `repair: false` turns it off), 7 (wrap as `{input}` when the profile needs an object root; tool parameters always), 8 (all four imported), 9 (kept: an optional nullable keeps `null` under null-for-absent; documented and tested). Still open: 3 (async codecs), 5 (`newStrict` size, now measurable), 10, 11.

### Pass 2 decisions

**Requests degrade, never error** (Phil, above). `profile.request(items)` always returns a request that can be sent:

- `strict: true` is the strongest preference, not a guarantee. Past Anthropic's 20 strict slots or the 24-optional / 16-union totals, the lowest-priority schemas take the fitting ladder and then go non-strict. Each records why (`adjustments`, `reasons`). A non-strict tool is still validated on decode by the same schema; only the model isn't constrained.
- More tools than the provider takes (OpenAI 128): the highest-priority `limit - 1` stay tools. The rest go behind one dispatcher tool, `run_tool({ tool, args })`, built with `a.dispatch` / `DispatchType`:
  - `tool` is an enum of their names, listing their descriptions;
  - `args` is the union of their own argument schemas, or one nullable field per tool on a dialect without unions;
  - decoding picks the tool by name and decodes `args` with that tool's own node.
  - `req.decodeCall(name, args)` returns the original tool's name and typed args. `req.encodeCall(tool, value)` writes a call either way. Each dispatched tool keeps an entry (`delivery: 'dispatched'`, `via`).
  - If two dispatched tools have different named types under the same name, the second takes JSON args and is checked against its own schema on decode.
- Duplicate names are renamed (`x_2`, `requestedName` keeps the original). A taken dispatcher name gets a suffix too.
- `problems` became `degradations`: informative, never thrown. Opting in to an error is `req.assertNoDegradation()` or `request(items, { failOnDegrade: true })`.
- `src/__tests__/request-degrade.test.ts` covers:
  - 0 / 1 / 7 / 129 / 300 tools on 10 targets (OpenAI, Claude strict, Claude 3 without structured output, Gemini, Gemini OpenAPI, Grok, Ollama, lenient, and capped MINIMAL / OpenAI profiles);
  - mixed and all-`strict: true` lists;
  - huge enums, 30 optionals, 11 levels of nesting, recursive bundles, `any`, unions, tuples and records;
  - a huge strict output.

  Every case must send at most the cap, obey the dialect, validate every encoded call against the JSON sent, and decode every call back to its original tool, without ever throwing.

**Library changes the ports forced** (each started as an `it.fails` gap in a corpus file; all now pass):

| Found by | Change |
|---|---|
| query (`z.never`, `enumOf([])`) | `a.never()`; an empty `a.enum([])` is never. Unions drop never options; a list of never must be empty; an optional never field is hidden from the model. |
| query (typed fns with no required param: args optional on the wire, required in query's `ExprDef`) | `.default(v)` / `a.default(s, v)`: optional on the wire, required in code, written in on decode. ginny and harness use zod's `.default` too. |
| query (`SchemaCache`'s `Fields_<Type>` / `Args_<sig>` named after runtime data) | `a.refOf<Out>(name)`: a ref whose name is runtime data, typed by the caller, checked at bind. |
| query, product, harness (runtime-built enums and unions) | `a.enum(list)`, `a.union(list)`, `a.discriminatedUnion(tag, list or refs)` take runtime lists, typed by the element. |
| query (`Query` union errors at the root) | Unions whose options carry a literal field with distinct values are discriminated automatically. An unmatched union reports the errors of the one option whose literals, or else keys, fit. Errors now land inside the option, e.g. `query.fields[0].expr.field`. |
| query on Gemini OpenAPI (`string \| Expr` where Expr is JSON text) | A JSON-text option in a union is written `{"json": "…"}`; a pairs record next to a list option is `{"entries": [...]}`. A union whose options are all JSON text is one JSON text. |
| query on Anthropic / xAI (2.9 MB of schema) | Escapes name their type; the `type X = …` definitions are written once, in the root description. Now 111 KB. |
| query on Gemini OpenAPI / MINIMAL (160 MB, 3.2 s) | Without `$defs`, a compile that passes 4,000 nodes restarts in "inline once" mode: each recursive named type is written out once and later uses are JSON text. Now 129 KB in 28 ms. |
| query (`encodeAt('query.order.*')`) | `encodeAt` goes through unions (the option is picked by the value). |
| product (a tool's ctx vs the module's `(catalog, options)`) | `bundle.adapt((ctx) => [args...])`. |
| gin | `fromGin` now matches gin's `toValueSchema` value-for-value: duration is ms, color an int, tuple `options.elements`, `interface`, date as a prefix regex, timestamp gin's regex, text `flags`, registered types' `extends` definitions (stored props only), generic named types instantiated with `fromGin(def, { named })`, constraints described, a non-literal def typed `AnySchema`, `GinSchema` for numeric enums. String `flags` added. |
| gin (MINIMAL) | A `null` option of a tagged union is a `true` flag. A nullable is never wrapped twice (no `anyOf` around a type array). |
| ginny (`edit_type`) | On a closed-object dialect, a value with keys the tag-picked option lacks goes to the fallback option sharing the tag. |
| harness | `.refine` may return several messages (zod's `superRefine`). `gt` / `lt` / `positive` / `negative` (exclusive bounds). `$ref` is JSON-pointer escaped (`shop~1Product`). `forModels` works on an optional wrapper. A pairs record sent as an object or a JSON string of one is repaired, its values read in the code shape. `fromGin` takes harness `record<V>`. `fromJSONSchema` imports `{type: 'object'}` as any object and reports missing `$ref`s. |

**Faithfulness is measured, not claimed.**
- query: for 24 depth/preset/selector/budget configurations over query's own fixtures (plus a capability-free registry and the PostGIS operator registry), every probe value gets the same verdict from the `a` port as from `@aeye/query`'s zod `buildSchemas`.
- product: the same check for `query_set` (`strict: true` + `maxEnumSize` 100 / 3 / 1, prefed and progressive catalogs) and for the open `type_compute` expr.
- gin: every `TypeDef` kind against `registry.parse(def).toValueSchema()`, and the full grammar against `buildSchemas` with `newStrict` / `namedRefs`.

### Pass 4 decisions: errors for the model

**Studied first.** gin and query share two pieces (query's are owned copies of gin's):

- `Code.formatProblems` (`code.ts`, `json-source.ts`): the JSON is pretty-printed with a span per value, each problem's path resolves to its span, and the output is compiler-style: the lines around it, `^^^` under the value, `error: <message>` below, sections merged when their context overlaps, an optional line-number gutter, `maxProblems` with "… (N more problems suppressed)". Problems whose path matches no span fall back to a plain line.
- `aids.ts`: `didYouMean` / `nearest` (Levenshtein, case-insensitive, a budget of `floor(len/3)` edits clamped to 1..3, ties by exact case then order), `expected <label>, got <kind>`, enum messages listing the values plus the suggestion, and `unknown <noun> kind \`x\` — did you mean \`y\`? (available: …)` for discriminators.

**Built.** `src/feedback.ts` (the format) and `src/suggest.ts` (the ranking, ported algorithm-identical and tested against gin's and query's own exports). It is the native output of `Rendered.parse` / `parseText`, `RequestEntry.parse`, `RenderedRequest.decodeCall` and `SchemaParseError`:

- **The model's shape.** The echo is the value the model sent: on failure the in-place decode is undone (a log of in-place writes, kept only when the format echoes; key order restored too), `parseText` re-reads its text. Paths are wire paths (`headers[1].key` of a pairs record, `body → JSON text → kind`), JSON text is shown parsed under `/* JSON text */`, a dispatcher call is labelled as the original tool (`the arguments of search_docs (called through run_tool)`).
- **Trimmed.** Only the paths to problems are expanded. Siblings are kept up to `context` (short ones first) and summarized (`{… 4 keys}`, `[… 1000 items]`, `… 3 more keys`, `/* 999 */` before an item after a gap). A problem deeper than `depth` levels is echoed from there, under a header with its path; its marker names the rest (`….body.kind`).
- **Grouped.** The same message at like paths (indexes aside) is one problem: `(the same at rows[3].id, rows[5].id and 997 more places)`. A misspelt key on a closed object (unknown + missing) is told once.
- **Expected types.** From the JSON Schema the model was given at that spot (`{ key: string; value: Expr }[]`, `"table" | "compact" | "cards"`, `PathStep[]`), or the TypeScript type of a JSON-text spot; only where the message doesn't already say it.
- **Did you mean** for enum values, literals and discriminator tags (also a string sent to a union of enums), unknown keys, a missing key the model misspelt (`Required — you wrote \`pth\`; did you mean \`path\`?`), the dispatcher's `tool`, and a tool name `decodeCall` doesn't know.
- **A hard size cap.** `maxChars` (default 2000) is never exceeded. Steps, each tried also "terse" (value lists become a count, `one of 12 values — did you mean \`define\`?`; repeat paths become a count) before the next: no expected types, no context, fewer levels, fewer problems, `list`, fewer problems, `summary`; only then is the text cut.

**Options** (`ErrorFormat`, or a detail level as shorthand) on the definition (`ToolItem.errorFormat`, `OutputItem.errorFormat`; core's `Tool` / `Prompt` in `proposal/core-api.ts`), the request (`RequestOptions.errorFormat`) and the call (`ParseOptions.errorFormat`); request < definition < call. `detail` (`'summary'` · `'list'` · `'markers'` · `'full'`, default `'full'`), `maxErrors` (5), `maxChars` (2000), `suggestions` (true), `expected` (on for `'full'`), `context` (3), `depth` (6), `header` (true). Documented in aeye-schema.md, "Errors for the model".

**Decisions.**
- The default is `'full'`: the richest message that fits 2000 characters. A tool that wants less says so (`errorFormat: 'summary'`).
- `Issue` stays `{ path, codePath, message }` with the bare message (no suggestion in it); what a problem was about is kept beside it (`issueKind`, `suggestionFor`). `formatIssues` (the old `- at <path>: <message>` lines) stays for logs; tests that check paths and messages use it (`src/__tests__/_lines.ts`).
- Enum and tag messages list at most 30 values (`… (170 more)`); "Did not match any of" is cut at 300 characters.
- A pairs entry without its `key` is `Required.` (was `Expected a string, got undefined.`).
- A dispatched tool called directly by its own name is decoded (its args are written as inside the dispatcher) rather than refused.
- With `'summary'` / `'list'` nothing is logged, so a failed in-place decode may leave the value half-decoded (as before pass 4); echoing formats always leave it as sent.
- The happy path does no new work but the undo log (echoing formats only: one entry per in-place write, ~0.3 µs on the MCP config on OpenAI strict). The failing node is found as the run unwinds (it claims its new issues), not tracked per value. Decoding valid answers got 0–19% faster than pass 3, because `Node.run` now skips the refinement step for schemas without refinements (PERFORMANCE.md).

**Invalid-path cost kept bounded.** Union option trials no longer build issues at all (a count-only dry context: no path copies, no issue objects); suggestions and expected types are computed only for the problems shown; JSON texts are parsed once per message. `npm run bench:errors` times reject + message at each level next to zod's message size (PERFORMANCE.md, "Errors for the model").

**The timing test.** `perf.test.ts` "encoding time is linear" timed wall clock and flaked under the full suite. It now counts work: node visits (`Node.prototype.encode` calls), compiles (must be 0) and allocations (`CopyStats`), which must grow exactly linearly with the rows (f(1000) − f(100) = 9 · (f(200) − f(100))). A second check does the same for a rejected answer's node runs, and that its message stays the same size.

### Pass 3: performance and memory

`bench/` (`npm run bench`, `bench:memory`, `bench:equivalence`) compares `@aeye/schema` with today's zod path: strictify / toJSONSchema / safeParse over gin's `toValueSchema` and `buildSchemas` and query's `buildSchemas`. It runs on the corpus schemas, on OpenAI strict, Anthropic strict, Gemini and lenient. Every compared pair first gives the same verdict on the same wire value. The numbers and method are in PERFORMANCE.md.

**Faster:**
- Rendering again for the next request is memoized: ~0 µs. The zod path recomputes it every request: 10 µs for a small tool, 0.1–0.2 s for query, 2–3 s for query on Anthropic.
- First renders are 2–20× faster, and 100–270× for query on Anthropic.
- Big recursive answers decode 6–500× faster.
- A wrong answer costs about the same as a right one, with a one-line message (41–185 characters). zod's message is the whole tree of failed union options: megabytes for query, and past V8's string limit for a 1k-row insert.

**Slower:**
- Small flat decodes are about 2× zod (0.5 µs against 0.25 µs). 1k flat rows take ~200 µs against ~75 µs, because zod 4 compiles a parser per shape.
- Encoding into the strict wire shape is 2–10× `JSON.stringify`. The zod path has no wire encoder at all.
- Small schemas keep 1.3–2× zod's memory once rendered: the memoized JSON and the nodes.

**Fixed:**
- `Rendered.nodeFor` recompiled on every call. Union encoding grew the compiler per value: 1k query rows never finished, and now take 3 ms.
- Cached ref-free nodes kept the bind that first compiled them alive. They now compile in a per-profile shared compiler.
- Decoding allocated per value. The path stacks are now indexed by depth, and 1k chart rows dropped from 817 KB to 260 KB of garbage.

**Watch:**
- A query bind on 4 profiles keeps 8.8 MB (closures per node). With the port's `cacheSize: 16` that can reach ~140 MB, so choose the integration's default with that in mind.

**Outside this package:**
- @aeye/query's `sharedIdRegistry` leaks ~2 MB per `buildSchemas` call, and product calls it per turn.
- Core's `toJSONSchema` grows the heap per call on query schemas: ~2 MB on OpenAI and Gemini, ~250 MB on Anthropic.

## Summary

- **`a`** works like zod's `z`. Every type is a class (`ObjectType<Shape>`, `RecordType<V>`, `RefType<Name>`, …). Static inference uses `a.infer<typeof X>`, and the inferred types match zod's exactly, recursion included. "Optional" means the key is absent (`?:`), never `undefined`.
- **The chain** runs `a.define(...)` → `.define(...)` → `.declare<{...}>()` → `.dynamic((...args) => ({ remaining refs }))` → `.result('Name' | a.object(...))`. The steps from the second `define` onward are optional.
  - It produces a `Bundle<Out, Args>`, a static instance built once.
  - `Out` is fully resolved in every scenario. `Args` is whatever the dynamic step needs.
  - Mistakes are compile errors: an undefined ref, a dynamic step that misses a ref, a wrong declared shape, a result naming an unknown type, redefining a name, or a ctx that doesn't supply the dynamic args. 20 `@ts-expect-error` proofs cover these.
- **Rendering on demand** uses `bound.render(profile)`. A *profile* is a model's capabilities: core's `FormatDescriptor`, slimmed down. From one profile we get:
  - the model's JSON schema;
  - one pass that both checks and decodes the answer, in place;
  - errors at the path the model wrote, plus the path the code sees;
  - examples and descriptions in the model's shape.
  
  What a dialect can't express gets a faithful fallback, never a silent loss:
  - recursion, depth limits and "any JSON" become JSON text, validated by the same schema;
  - unions become a tagged object when the dialect has no combinators;
  - an enum over the dialect's cap is widened to a plain string, with the values listed in the description, and still enforced;
  - constraints the dialect lacks are written as words.
- **Copying.** A subtree that doesn't change shape is checked and returned as the same reference, with zero allocations. The only allocations are real shape changes: one object per record sent as pairs, one array per tuple sent as an object, and one parse per piece of JSON text. The copy table below lists them, and tests assert the counts.
- **Coverage.** Every real schema in @aeye/query, product's query kind, gin, ginny, core, cletus, the other @aeye packages and the harness is ported to `src/__tests__/corpus/` and tested for every piece of functionality. See the coverage table.
- **Proof.**
  - `npm test` in `packages/schema` runs vitest (983 runtime tests after pass 3; 980 after pass 2; 156 after pass 1; 34 in the POC) and `tsc -p tsconfig.typetest.json`, which type-checks everything under `exactOptionalPropertyTypes` and `noUncheckedIndexedAccess`.
  - The package is `private: true` (in the root workspaces since pass 1), so nothing publishes.

## Concepts

| Concept | What it is |
|---|---|
| **Schema class** | An immutable instance describing a code-shape value. It carries phantom `_out` (the code type) and `_refs` (the ref names used below it). It owns its model-facing logic in `compile(compiler)`. |
| **Ref** | `a.ref('Name')` is a use of a named type defined somewhere in the chain. Until the chain ends, `_out` holds a `RefMarker<'Name'>` placeholder. |
| **Chain / Module** | Collects named types. Static ones come from `define`. Typed promises come from `declare`. Runtime ones come from `dynamic`. |
| **Bundle<Out, Args>** | A finished chain, built once at module scope. `bind(...args)` supplies the dynamic part and returns a `Bound<Out>`. It is cached by `key`. |
| **Bound<Out>** | Every ref resolved. `render(profile)` gives a `Rendered<Out>`, memoized per profile. |
| **Profile** | A model's capabilities: optional as `omit` or `null`, closed objects, records as `open` or `pairs`, tuples, unions as `anyOf` or `tagged`, `$defs`, recursion, "any" spelling, constraints, where examples go, enum cap, max depth, audience. Built in (the table is in aeye-schema.md): `LENIENT`, `PEOPLE`, `OPENAI_STRICT`/`_NON_STRICT`/`_FINETUNED_STRICT`, `ANTHROPIC_STRICT`/`_NON_STRICT`, `GOOGLE_STRICT`/`_NON_STRICT`/`_OPENAPI`, `XAI_STRICT`/`_NON_STRICT`, `OLLAMA`, `MINIMAL`. Chosen by `profileFor(model)`. |
| **Rendered<Out>** | Holds `jsonSchema`, `measure`, `parse(wire)`, `parseText(text)`, `parseOrThrow`, `encode(codeValue)`, `encodeText`, `encoder` and `typescript()`. It holds nodes (proportional to schema size), never data. |
| **RenderedRequest / RequestEntry** | Every schema of one request fitted together; each entry records its profile, adjustments and reasons, and is the one codec for that schema. |
| **Node** | A compiled (schema, profile) unit with `json()`, `run()` (check + decode), `encode()` and `needs` (does decoding change this subtree?). |
| **Escape hatch** | For what a profile can't express: a string holding JSON text in the code shape. It is described with a TypeScript type and validated by the LENIENT rendering of the same schema. |

## Class hierarchy

```
Schema<Out, Refs>                      abstract: describe/title/example/refine/brand/forPeople/forModels/optional/nullable/bind/render
├─ StringType          string          min/max/pattern/format
├─ NumberType          number          int/min/max
├─ BooleanType         boolean
├─ NullType            null
├─ LiteralType<V>      V
├─ EnumType<V[]>       V[number]       widened past profile.maxEnumValues
├─ AnyType<Out>        unknown | JsonValue   {} or JSON text
├─ ArrayType<E>        Out<E>[]        min/max
├─ TupleType<[...]>    [Out<A>, Out<B>]  prefixItems | {"0":…} | items-anyOf
├─ ObjectType<Shape>   {required} & {optional?}   strict()/extend(); people-only fields hidden
├─ RecordType<V, K>    Record<K, Out<V>>  open object | [{key, value}]
├─ UnionType<[...]>    Out<A> | Out<B>  (discriminated with a tag)  anyOf | tagged object
├─ OptionalType<T>     key absent (in objects) / undefined (elsewhere)
├─ NullableType<T>     Out<T> | null
├─ RefType<N>          RefMarker<N> → resolved by the chain
└─ CodecType<W, Out>   model writes W, code holds Out (fn names, ids)
```

`AnySchema` is a structural interface, not `Schema<any, any>`. That way class methods returning `this` never make one class look "incompatible" with the base during deep comparison. `SchemaOf<Out>` is `AnySchema & { _out: Out }`.

## The `a` builder

```ts
import { a } from '@aeye/schema';

a.string() a.number() a.int() a.boolean() a.null() a.literal('x') a.enum(['a', 'b'])
a.unknown() a.json()
a.object({ ... }) a.array(T) a.tuple([A, B]) a.record(V) a.record(a.enum([...]), V)
a.union([A, B]) a.discriminatedUnion('kind', [A, B]) a.optional(T) a.nullable(T)
a.ref('Name') a.codec(wire, { decode, encode })
a.define({...}) a.declare<{...}>() a.module() a.fromJSONSchema(json)
type T = a.infer<typeof X>;

.describe('text' | (view) => `… as ${view.recordWord}`)  // prose that matches the wire shape
.example(codeValue)        // typed in the code shape; rendered in each model's shape
.refine(fn, 'rule')        // enforced after decoding; the rule text is shown to the model
.brand<'Zone'>()           // nominal type only
.forPeople()               // field hidden from and refused from models
.forModels(narrower)       // what a model sees instead (e.g. an enum minus people-only members)
.optional() .nullable()
```

## The chain: every scenario

```ts
// 1. All refs static, lazy (used before defined), recursive. Result is a ref.
const Tree = a
  .define({ Node: a.object({ value: a.number(), children: a.array(a.ref('Node')), leaf: a.ref('Leaf').optional() }) })
  .define({ Leaf: a.object({ label: a.string() }) })   // Node used Leaf before it existed
  .result('Node');
type Tree = a.infer<typeof Tree>;  // { value: number; children: Tree[]; leaf?: { label: string } }, really recursive

// 2. Result is an inline object that uses refs.
const Forest = a.define({ Node: ... }).result(a.object({ roots: a.array(a.ref('Node')), count: a.int() }));

// 3. Some refs dynamic. The dynamic step's own return type types them.
const Query = a
  .define({ Filter: a.object({ field: a.ref('Field'), equals: a.string(), and: a.array(a.ref('Filter')).optional() }) })
  .dynamic((ctx: Ctx) => ({ Field: a.enum(ctx.fields) }), { key: (ctx) => ctx.registryVersion })
  .result(a.object({ where: a.ref('Filter'), limit: a.int().optional() }));
Query.bind(ctx)   // Args = [ctx: Ctx]; cached by key

// 4. `declare` pins a dynamic ref's code type. The step must produce it (checked again after resolving refs).
const EditType = a
  .declare<{ Type: TypeDef }>()
  .dynamic((registry: Reg) => ({ Type: a.object({ name: a.enum(registry.names), props: a.record(a.object({ type: a.ref('Type') })).optional() }) }))
  .result(a.object({ name: a.string(), def: a.ref('Type') }));   // a.infer → { name: string; def: TypeDef }

// 5. Dynamic types may reference static named types (Row → Money).
// 6. One module, many results: GinModule.result('Expr'), GinModule.result(a.object({ name, def: a.ref('TypeDef') })).
```

**Compile errors.** All are proven in `src/__tests__/chain.types.ts`.

| Mistake | Error |
|---|---|
| `.result('Node')` while Node uses an undefined `Ghost` | `"Node" & SchemaError<"unresolved ref", "Ghost">` |
| `.result(a.object({ x: a.ref('Nope') }))` | `… SchemaError<"unresolved ref", "Nope">` |
| `.result('Nope')` | not assignable to the names defined |
| `.define({ A })` twice | `SchemaError<"already defined", "A">` |
| `.dynamic(() => ({ Field }))` while `Op` is missing | `Property 'Op' is missing` |
| a declared `Type: TypeDef`, but the step returns `a.number()` | `NumberType` not assignable to `SchemaOf<AllowRefs<TypeDef>>` |
| a declared type that only mismatches after resolving refs | `SchemaError<"declared type does not match", "Type">` at `result` |
| the dynamic step redefines a static name | `NumberType` not assignable to `never` |
| `declare` with no `dynamic` | `SchemaError<"unresolved ref", "Type">` |
| `loose.bind()` or passing a schema with a free ref to a tool | `this`/`Bindable` mismatch |
| `Query.bind()`, `Query.bind({ fields: 'a' })` | arity or argument type |
| a tool whose ctx lacks what the bundle's dynamic step needs | `Bindable.bind` is a property, so it is checked contravariantly |

**How the return type is computed** (`types.ts`, `module.ts`):

1. Each class computes `_out` from its children. For example, `ObjectType<S>` gives `{required} & {optional?}`, flattened. `RefType<N>` gives `RefMarker<N>`. `_refs` is the union of the children's ref names.
2. The chain accumulates `D`, the named types (`Merge` per step, so later definitions win). It also accumulates `Decl`, the declared types.
   - `Missing<D, Decl>` is the refs used or declared minus the names defined.
   - `dynamic` constrains its return type to `{ [K in Missing]: K in Decl ? SchemaOf<AllowRefs<Decl[K]>> : AnySchema } & { [K in keyof D]?: never }`.
3. `result(root)` checks `Exclude<root refs, keyof D> | Missing` is `never`. It also checks every declared ref, once resolved, matches its declaration. It then returns `Bundle<Resolve<RootOut, EnvOf<D>>, Args>`.
4. `Resolve<T, Env>` swaps each `RefMarker<N>` for `Resolve<Env[N], Env>`. Mapped types are evaluated lazily per property, so recursive named types become finite, cyclic types. They are real types, not `any`; this is proven with `not.toBeAny()` and `toEqualTypeOf<Tree>()` on `Tree['children'][number]`.
5. A schema typed loosely as `AnySchema` has `_refs: any`, for example args built from runtime data. It contributes no static refs, and `Bound` checks it at bind time.

## Rendering and decoding

`bound.render(profile)` compiles each schema into a node. It is memoized:

- **Per `Bound`, per profile.** Each Bound keeps a small map keyed by profile id.
- **Ref-free subtrees, per schema instance, per profile.** This is a global `WeakMap`, so a schema's nodes go when the schema goes. It means re-binding a dynamic bundle rebuilds only the nodes that touch a ref. The test checks that the primitive `TypeDef` branch's JSON is `===` across two registry versions.
- **Keyed binds.** `dynamic(..., { key })` keeps the last few binds (default 4). With an equal key, the dynamic function doesn't run again and the rendering is reused.

Nothing holds model answers. Binds without a key are owned by the caller (one per request), so no large graphs are retained.

**Measured** on BagEnd, using the reduced gin grammar with 200 registered named types:

| Step | Time |
|---|---|
| First render (OpenAI strict) | 4.3 ms |
| Cached bind + render | 0.7 µs |
| New registry version | 0.66 ms (the ref-free grammar is reused) |
| A second result from the same module | 1.0 ms |
| Parsing a 500-line program | 6.5 ms |

Today, rebuilding the zod schemas costs about 130 ms per call, but that is the full grammar, so the comparison is indicative, not like for like.

### One place for shape, prose, examples and errors

`RecordType.compile` decides pairs or open from `profile.records`. The same node:

- emits the JSON (pairs or `additionalProperties`);
- adds the hint ("A map written as a list of {key, value} entries; each key at most once.");
- encodes examples (`{food: 200}` becomes `[{"key":"food","value":200}]`);
- decodes (pairs become one record);
- reports errors at `limits[0].value`, with the code path `limits.food`.

User prose gets the same view: `.describe((v) => \`… as ${v.recordWord}\`)` reads "a list of {key, value} entries" for strict models and "an object" for others. The description can't say "object" while the wire says pairs.

### Copy table

| Situation | Allocation | Counter |
|---|---|---|
| A subtree with `needs === false` (no shape change below it) | none; checked, same reference returned | — |
| A whole non-strict answer with no rewrites | none; `parse(x).value === x` (tested on 1,000 rows) | 0 |
| Optional written as `null` (strict) | none; the key is **deleted** in place | `edits` |
| A child whose decoded value differs (in place, the default) | none; written back into the parent | `edits` |
| A record sent as `[{key, value}]` | **one new object** per record; values are moved by reference, not copied | `objects` |
| A tuple sent as `{"0":…}` | **one new array** per tuple; items moved | `arrays` |
| JSON text (escape hatch, `a.json()` on strict) | one `JSON.parse`; the result is then decoded in place | `parsed` |
| A tagged union (`MINIMAL`) | none; the wrapper is dropped, the chosen value returned | — |
| Codec (fn names) | whatever `decode` returns | — |
| `parse(x, { inPlace: false })` (copy-on-write) | the first change inside a container clones **that** container once; untouched siblings and subtrees are shared | `objects` / `arrays` |
| Union option selection | none; options are tried dry (no writes), or picked by tag with no trial at all | — |
| Unknown keys | left in place (zod copies to strip them); `.strict()` makes them errors | — |

Example from the tests: an OpenAI strict `{ owner, limits: [2 pairs], note: null }` decodes to the same top object, with `{objects: 1, arrays: 0, edits: 2}`.

### Errors

Each `Issue` has:

- `path`: where the model wrote it, e.g. `['limits', 0, 'value']`, `['children', 0, '(json)', 'value']` or `['call', 'args', 'text']`;
- `codePath`: where the code sees it, e.g. `['limits', 'food']`;
- `message`.

`rendered.parse(...).message` is the re-prompt text, for example `- at limits[0].value: Must be at least 0.`. Discriminated unions report at the tag. Refinements report at their node. Rules with a message are also shown to the model as `Rules: …`.

## Tool / Prompt API change

The proposal is in `src/proposal/core-api.ts`. These are types plus a small working compile/parse path.

```ts
// before
schema: Fn<ZodType<TParams> | undefined, [ctx]>                 // Tool
schema?: Fn<ZodType<TOutput> | false, [input, ctx]>             // Prompt
// after
schema: Bindable<TParams, [ctx: Context<TContext>]>              // always one static `a` instance
schema?: Bindable<TOutput, [ctx: Context<TContext>, input: TInput]>
applicable?: (ctx) => boolean | Promise<boolean>                 // was: schema fn returning undefined/false
```

- `Bindable<Out, A>` is `{ _out: Out; _refs: never; bind: (...args: A) => Bound<Out> }`. A plain `a.object(...)` is a `Bindable` with no args. A chain's args are its dynamic step's args, and `TParams` is inferred from it.
- Per request:
  1. `bound = tool.schema.bind(ctx)` (cached by key);
  2. `rendered = bound.render(profileFor(model))` (memoized);
  3. `parameters = rendered.jsonSchema`.
  
  The answer is parsed with the **same** `rendered` (`compileTool`/`runToolCall`), so the wire shape, decoding and errors can't drift.
- Prompt dynamic args are ordered `(ctx, input)`, so a ctx-only bundle also fits a prompt.
- `parse` hooks and `decodeWire` go away. Code-shape mapping lives on the schema (`a.codec`, `.refine`). Strictify becomes rendering.
- The budget (`SchemaBudget`) keeps its job: choosing a profile per tool per request (strict or degraded). It reads the counts from the rendered node tree instead of zod.

## Gin → `a`

The converter is in `src/gin/from-gin.ts`. In the real migration it becomes `Type.toA()` in @aeye/gin.

- **Type level.** `GinSchema<T>` maps a `const` TypeDef literal to the exact class. `a.infer<typeof fromGin(def)>` is the gin value's code shape. This is tested for text, num, bool, list, `map<text,V>` (record), `map<K,V>` (pairs), optional, nullable, enum, literal and named types.
- **Runtime.** `text`, `num`, `bool`, `null`/`void`, `any`, `date`/`timestamp`/`duration`/`color`, `list`, `map`, `optional`, `nullable`, `obj` (with docs), `enum`, `literal`, `or` and `tuple` map directly.
  - `typ` becomes `a.ref('TypeDef')` and `fn` becomes `a.ref('Expr')`, refs into the grammar module.
  - Any other name is a registered named type and becomes `a.ref(name)`.
  - `and`, `not` and `iface` are open questions; for now they become any JSON with a description.
- **Registries.** `ginNamedTypes<{Task: Task}>(registry)` returns the registry's named types as defs for a dynamic step. The caller states the names its code relies on, and `Bound` checks they exist.
- **The grammar.** In `src/__tests__/corpus/gin-grammar.ts`, gin's `buildSchemas` (`opts.Type`/`opts.Expr`) becomes one module: a static TypeDef + Expr + PathStep + PropDef grammar, with a dynamic `NamedType` enum keyed by registry version. Tools pick results from it, and no `keptLazy` workaround is needed (a ref is not a lazy getter).
- **Differences from `toValueSchema`.**
  - `map<text,V>` is a **record** in the code shape. Pairs are now a rendering choice, so gin's runtime reads records. Only dialects that forbid an open `additionalProperties` (OpenAI strict, Anthropic strict, Gemini OpenAPI) show the model pairs; xAI strict and Gemini show an object.
  - Named types are `$defs` refs, not `z.lazy` + `aid`.

## Coverage table

Every row is a faithful port of the real schemas, written with `a`. Files are under `packages/schema/src/__tests__/corpus/`: `<area>.ts` holds the schemas and their `expectTypeOf` proofs (compiled by `test:types` under `exactOptionalPropertyTypes` + `noUncheckedIndexedAccess`), and `<area>.test.ts` holds the runtime tests (vitest).

Every schema is put through the same checks:

- **Type:** the static type.
- **Profiles:** `profileProblems` on all 13 built-in profiles. This covers dialect conformance (`dialectProblems`), encoding samples, validating the wire against the JSON sent with an independent validator, decoding back in place and copy-on-write, and confirming a LENIENT decode copies nothing.
- **Decoding:** model-shaped answers with copy counts, plus repairs.
- **Errors:** both paths and the message.
- **Encoding:** `encode` / `encodeAt` / `encoder` and `{{encode}}`.
- **Examples:** shown per profile.
- **Requests:** request budgets where they apply.

| Source (read-only) | Corpus file → tests | What is ported | Checked against the original |
|---|---|---|---|
| @aeye/query `llm/schemas.ts`, `schema-build.ts`, every `exprs/*.toSchema`, `field-types/*` `toValueSchema` | `query.ts`, `query-fixtures.ts` → `query.test.ts` (29) | The full grammar as one module: static grammar plus a dynamic step over a catalog adapted from a real registry. All 5 depth axes at every level, presets, `strict` sugar, `maxEnumSize` ladders, function selectors, the capability gate, `SchemaCache` fragments as named types, typed INSERT/SET rows, ON CONFLICT, sorter, set ops, CTEs, `querySchema` / `shouldUseStringSchema`. Code type is query's own `QueryDef` / `ExprDef`. | Value-for-value against `buildSchemas` (zod) on query's own fixtures: 24 configs × 49 probes, a capability-free registry, the PostGIS operator registry. |
| product `core/src/kinds/query.ts`, `shared.ts`, `flow-decl.ts`, `type.ts`, `type-configure.ts` | `product.ts` → `product.test.ts` (22) | `query_set` (`strict: true` + `maxEnumSize`, prefed vs progressive catalogs, absent conditions), `query_test`, `query_return` create/edit, `system_set`, `dbfn_load`, search, flow args (search/load/reuse/failures/decline), `type_compute` / `populate` (open Expr), the finished query fn's args (`querySignature`), the whole query-agent request on OpenAI / Claude / Gemini. | `query_set` against product's own `buildSchemas(engine, { strict: true, maxEnumSize })` on product-shaped types (read-only core types with admin-only and computed fields, closed-set business types, relations); `type_compute` against the open Expr. |
| @aeye/gin `types/*`, `schemas.ts` `buildSchemas`, `exprs/*` | `gin-values.ts`, `gin-grammar.ts`, `gin-fixtures.ts` → `gin-values.test.ts` (51), `gin-grammar.test.ts` (48) | Every TypeDef kind via `fromGin` (with `GinSchema<T>` types), registered and generic named types, method args. The full grammar: 24 type classes, 12 expr kinds, PathStep, PropDef, `New_*`, `newStrict`, `namedRefs`, extensions. | `toValueSchema` per kind; `buildSchemas` (+ `newStrict` / `namedRefs`) on gin's own fixture programs and TypeDefs. |
| ginny `tools/*`, `prompts/*` | `ginny.ts` → `ginny.test.ts` (46) | Every tool and prompt schema (programmer, architect, dba with `create_var` typed by `.dependent`, designer, researcher), `applicable(ctx)`, `compileTool` / `runToolCall`, the programmer tool set as one request. | Through the gin grammar above. |
| @aeye/core README/docs/src/tests (Tool + Prompt), `core/src/schema/*` tests | `core-tools.ts`, `core-schema.ts` → `core-tools.test.ts` (96), `core-schema-strictify` (70), `-dialects` (91), `-budget` (41) | Every distinct Tool/Prompt schema (the ~200 trivial ones as a sourced table), function forms as chains + `applicable`, custom `parse` as codecs, and core's strictify / decode / dialect / budget / canExpress expectations. | Core's own expected wire shapes and decoded values; differences marked DELIBERATE. |
| cletus `tools/*`, `helpers/type.ts` | `cletus-tools.ts`, `cletus-dba.ts`, `cletus-ops.ts` → 83 / 20 / 20 | All 58 tools: the DBA query grammar and `query_fixer` / `query_builder`, type_extractor, type-based dynamic schemas. | — |
| @aeye/ai, openai, openrouter, aws; test-integration | `ai-providers.ts`, `test-integration.ts` → 26 / 28 | The providers' test schemas (union / allOf fallbacks, `api_signature` catchall, recursive `walkTree`, converse output), the live-schema fixtures and the strictness table. | The fixtures' expectations (DELIBERATE where `a` does better). |
| harness `sdk` zod-gin / model-names / widget-schema, `hub` catalog / modes / structured, `systems/*` | `harness-fns.ts`, `harness-run.ts`, `harness-grammar.ts`, `harness-schedule.ts`, `harness-authoring.ts`, `harness-database.ts`, `harness-mcp.ts` → 33 / 18 / 15 / 14 / 10 / 12 | Model names (codec), people-only + `forModels`, zod-gin fixtures, catalog `signature()`, `structuredAnswer`, static-mode `run` / `run_query` / `test` / fleet `on` (args typed by the fn via `.dependent`), schedule `When` (every rule) / `SchedulePayload`, code/api/widget/input/database drafts, enrichment, saved-query args, MCP tools and elicitation via `fromJSONSchema`. | The harness tests' fixtures and expected verdicts. |
| (all of the above, unknown tool lists) | `request-degrade.test.ts` (67) | Phil's degradation rule: 0 / 1 / 7 / 129 / 300 tools × 10 targets, all-strict, huge, recursive, unsupported features, the dispatcher. | — |

The pass-1 feature tests (`src/__tests__/{render,profiles,types,encode,request,template,import,measure}.test.ts`, `chain.types.ts`, `features.types.ts`, `gin/gin.test.ts`) remain. The POC's `src/coverage/` sketches are gone, replaced by the corpus.

### Remaining gaps

These are still open; each is an `it.fails` or `@ts-expect-error GAP` in the corpus and starts failing when it is fixed.

- **A string output takes the raw reply** (core `schema: z.string().min(5)`; core-tools). Today an output root that isn't an object is wrapped `{input}`. A text output mode, with no response format and the raw text parsed as the string, is not built.
- **`Prompt` `applicable`** is missing from `proposal/core-api.ts` (core `schema: () => false`). This belongs to the core integration.
- **A broken JSON-text container's message** says "Expected an object, got string" instead of naming the JSON parse failure (core-tools).
- **A `key` option turns an optional dynamic arg required** in `bind`'s parameters (type level, core-tools).
- **Claude output with `strict: false`** is sent as non-strict structured output, which Claude doesn't have. It should be prompt text (core-schema-budget).
- **A homogeneous tuple on Anthropic strict** repeats the same branch in `items.anyOf`, spending union budget (core-schema-dialects).
- **Unused `$defs`:**
  - a recursive root that is inlined, with JSON-text back-edges, still leaves its def;
  - a non-recursive root ref is emitted twice (core-schema-dialects, cletus).
- **Numeric enums:**
  - a union of number literals is N single-value branches, never one `enum`, and never widened (core-schema-dialects);
  - a nullable 8-value enum on MINIMAL goes over the cap (cletus).
- **No consistency check for custom profiles** (a cap of 0, "any" without `$defs`).
- **Under null-for-absent, encode leaves a key out** when no plain optional sits beside it (core-schema-strictify).
- **An optional tuple element** (`[string, number?]`) is not modelled (core-schema-strictify).
- **The ladder widens enums for a depth-only overflow** too (cletus-dba).
- **Type level:**
  - `.rest(V)` with a non-`V` named field is unsatisfiable;
  - a `declare`-pinned union;
  - `AllowRefs` turns tuples into arrays.
- **`g.fnName()` in `fromGin`:** it should become the per-prompt FnName codec, which needs the harness's naming context (harness-fns).
- **A union-of-objects tool root** is sent `{input: anyOf}`. `toolArgsOf` flattens it to plain args (lossy on the wire), which is kept deliberately exact here for now (harness-fns).
- **A sibling-typed value** (`.dependent`) is checked in the code shape only (harness-run).
- **`render(profile)` is raw:** only `request()` fits a schema to the provider's size limits, so a direct OpenAI render of gin's TypeDef has 14 levels (gin-grammar). This is deliberate: fitting is a per-request decision.
- **Not modelled:**
  - registry-declared zod refinements on query field types (the `declaredRefinement` intersection);
  - `a.templateLiteral`;
  - `.omit` / `.partial` / `.keyof`;
  - a `.transform` with no inverse (the harness ports these by hand).

## What moves from core/schema

| core/schema file | Where it goes |
|---|---|
| `descriptor.ts`, `dialects/*`, `registry.ts`, `consistency.ts` | `profile.ts`: `Profile` + built-ins. The registry of custom profiles moves too. `consistency` becomes checks on profile combinations (e.g. `any: 'json-text'` needs nothing). |
| `strictify.ts`, `decode.ts`, `walk-key.ts`, `check-bag.ts` | each class's `compile()` (render.ts + schema.ts). There is no second zod schema per dialect. |
| `to-json-schema.ts`, `json-schema.ts`, `enum-values.ts`, `any-value.ts`, `cycle-breaker.ts` | node `json()` + `Compiler.ref/escape` + `decorate` |
| `analyze.ts` (features, size limits), `expressible.ts` (`canExpress`) | `measure.ts`: exact counts on the emitted JSON, per profile |
| `budget.ts` (`SchemaBudget`) | `request.ts` (`planRequest`, `RenderedRequest`): the whole request fitted at once, the choices recorded per schema |
| `Tool.parse` / `Prompt` output parsing (strictify + decodeWire + repair) | `rendered.parse/parseText` |

## Migration steps

1. Land `@aeye/schema` with full profile parity:
   - port xai and the size-limit/feature analysis onto nodes;
   - add the root `workspaces` entry and `tsconfig.base` path;
   - drop `private`.
2. Core accepts both forms. `Tool.schema` / `Prompt.schema` take `Bindable | Fn<ZodType>`. Zod inputs are adapted by a temporary `fromZod` (via `z.toJSONSchema` → `fromJSONSchema`), and the request path uses `bind/render/parse`.
3. Gin: `Type.toA()` beside `toValueSchema`. `buildSchemas` gets an `a` module twin (as in gin-grammar.ts, full grammar). Query's `buildSchemas` likewise.
4. Harness: `ginAs`/`toolArgsOf` produce `a`; the catalog's `signature()` caches bundles; static-mode `run` becomes the dynamic `fn` union. Remove `withFnNameDocs`, `arg-repair` for records, and `keptLazy`.
5. Ginny, cletus and the rest: move function-form schemas to chains.
6. Remove zod from core's public API, then from gin/query, and delete strictify/decode.

## Open questions

Settled since they were written: 1, 2, 4, 6, 7, 8 and 9 in pass 1. In pass 2, 10 became `a.refOf<T>(name)` plus `ginNamedTypes<T>` (names checked at bind), and very large `run` catalogs are covered by the request dispatcher. Still open: 3 (async codecs), 5 (`newStrict` size, now measurable in corpus/gin-grammar), 11 (default cache keys).

1. **Whole-schema size budgets.** These are OpenAI's 5000 properties / 10 levels / 120k characters / 1000 enum values, and very large fn catalogs in `run`. Options:
   - (a) measure on the node tree and let `SchemaBudget` degrade the profile, as today;
   - (b) add a profile `maxSize` that switches the largest union to a two-step "pick fn, then args".
   
   Recommended: (a) first.
2. **A value typed by a sibling's value in the same answer.** For example, `create_var {type: TypeDef, value}`, where `value` must match the `type` the model just wrote. JSON Schema can't say this. `a` can check it on decode with a refinement that builds a schema from the decoded `type`. Should that be a first-class `a.dependent('type', (t) => schema)` node?
3. **Async codecs.** The fn-name registry is async and learns names. Should codecs be allowed to return promises, making `parse` async when any codec is? Or should the registry be resolved into the dynamic step (sync) first?
4. **Gin `and` / `not` / `iface`.** These have no strict-dialect JSON Schema. Options: convert `and` of objects to a merged object; describe `iface` by its members; for `not`, refinement only.
5. **Gin `newStrict`.** Today this is a per-named-type `value` union, which multiplies schema size. In `a` it is a dynamic discriminated union per type, but its size makes it a prime candidate for open question 1.
6. **Repairs.** Should "record or object sent as a JSON string" and "double-encoded draft" auto-unwrap? This could be a profile quirk, `jsonStringObjects: true`, recorded in stats. Today the POC errors at that path.
7. **Non-object roots for tools.** Should `render` wrap a non-object root as `{input}` automatically, with decode unwrapping it? This would be zero-copy, since it only picks the field.
8. **`fromJSONSchema` gaps.** `allOf` with more than one member, `if`/`then`/`else`, `not` and `patternProperties` are reported in `ImportReport.unsupported` and fall back to any JSON with a description. Should they become refinements?
9. **Optional + nullable under strict.** A `null` is ambiguous here, and the POC keeps it as `null`. Core has the same rule. Alternative: render as optional-with-sentinel.
10. **Static vs dynamic names.** When a dynamic step returns a `Record<string, …>` (a whole registry), refs to the registry's names can't be checked at compile time. The caller lists the names it relies on (`ginNamedTypes<{Task: Task}>`) and `Bound` checks them at bind time. Is that acceptable?
11. **Caching keys.** `key` is opt-in. Should a bundle without a key cache on the identity of its first argument (a WeakMap) by default?

## Files

| File | What |
|---|---|
| `src/a.ts` | the `a` builder |
| `src/schema.ts` | the classes and their compile logic |
| `src/module.ts` | chain types, `Bundle`, `Bound`, `Bindable` |
| `src/types.ts` | `RefMarker`, `Resolve`, `AllowRefs`, `SchemaError` |
| `src/render.ts` | Compiler, Node, Cx (copy accounting), Rendered, escape hatch |
| `src/profile.ts` | profiles |
| `src/json-schema.ts` | `fromJSONSchema` |
| `src/gin/from-gin.ts` | gin converter + `GinSchema<T>` |
| `src/model.ts` | `ModelLike`, `familyOf`, `profileFor`, `ModelProfile` |
| `src/request.ts` | `planRequest`, `RenderedRequest`, `RequestEntry` |
| `src/measure.ts` | measuring an emitted schema against limits |
| `src/template.ts` | Handlebars helpers (`encode`, `schema`) |
| `src/errors.ts` | `SchemaDefinitionError`, `SchemaParseError`, `RequestLimitError` |
| `src/feedback.ts` | pass 4: errors for the model (`ErrorFormat`, `formatErrors`, the echo, expected types) |
| `src/suggest.ts` | pass 4: "did you mean", gin's / query's ranking |
| `src/proposal/core-api.ts` | the Tool/Prompt proposal |
| `src/__tests__/chain.types.ts` | the type proofs |
| `src/__tests__/render.test.ts` | the record example end to end + profiles |
| `src/__tests__/{profiles,types,encode,request,template,import}.test.ts` | pass 1: the profile table, the new types, encoding copies, request budgets, Handlebars, JSON Schema import |
| `src/__tests__/features.types.ts` | pass 1 type proofs |
| `src/__tests__/corpus/*` | pass 2: the ported real schemas, one area per file (see the coverage table); `_check.ts` holds the shared per-profile checks and the independent JSON Schema validator |
| `src/__tests__/request-degrade.test.ts` | pass 2: requests always degrade, never error |
| `src/__tests__/feedback.test.ts` | pass 4: errors for the model on the real corpus, every level, vs zod |
| `bench/errors.ts` | pass 4: message size and reject time per level, vs zod (`npm run bench:errors`) |

Run with `npm test` (vitest + `tsc -p tsconfig.typetest.json`) from `packages/schema`, using node 22. User docs: `aeye-schema.md`.
