# @aeye/schema: design (POC)

## Phil's request (verbatim)

> I want a zod alternate in a new aeye/schema package. Much of the logic from core schema logic would move to this. I want a solution with basically no data copying or as little as possible no matter what the model being used is. It should be as type safe as zod but designed for llms and parts of the schema that are dynamic. Like tool args and prompt structured output would change from an optional function to always one of these static instances but with dynamic parts. The code of the different types should be implemented using classes. Gin will need to be converted to generate these. These will be very similar, but the goal of this is to perfectly represent any schema to a model no matter what is supported. It generates correct json schema based on what's supported on demand. It should be first class to have named types and be able to use them. There should be an a export that is like z for zod. It should let you define the types (if named types are desired) with some that have a lazy definition. a.ref is used and resolved in later chain. Then the types that weren't defined in the chain can be dynamically be defined with a dynamic function that accepts any args but returns an object with the remaining refs to be defined. This makes it support query schemas or Ginny's which can be based on ctx. And finally whatever the result type should be, whether it's a ref to an object or a new object definition. Even with all of this complexity it should have a well defined return type. In every scenario. This will be complex typescript code to satisfy these requirements. Do a poc and prove it will work - mainly I'm interested in the interfaces and function signatures showing how it will be used and proving the type system will work. Show it to me in hitl when ready for review

> Make sure it's crystal clear that the schemas in the harness, gin, query, etc should all be representable in this static but partially dynamic schema builder. It needs to cover all use cases.

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
- **Coverage.** Every schema use case in aeye core, gin, query, ginny and the harness is expressed in `src/coverage/`. Each compiles with type tests, and the hard ones have render/decode tests. See the coverage table.
- **Proof.**
  - `npm test` in `packages/schema` runs vitest (34 runtime tests) and `tsc -p tsconfig.typetest.json`, which type-checks everything under `exactOptionalPropertyTypes` and `noUncheckedIndexedAccess`.
  - The package is `private: true` and not yet in the root workspaces, so nothing publishes.

## Concepts

| Concept | What it is |
|---|---|
| **Schema class** | An immutable instance describing a code-shape value. It carries phantom `_out` (the code type) and `_refs` (the ref names used below it). It owns its model-facing logic in `compile(compiler)`. |
| **Ref** | `a.ref('Name')` is a use of a named type defined somewhere in the chain. Until the chain ends, `_out` holds a `RefMarker<'Name'>` placeholder. |
| **Chain / Module** | Collects named types. Static ones come from `define`. Typed promises come from `declare`. Runtime ones come from `dynamic`. |
| **Bundle<Out, Args>** | A finished chain, built once at module scope. `bind(...args)` supplies the dynamic part and returns a `Bound<Out>`. It is cached by `key`. |
| **Bound<Out>** | Every ref resolved. `render(profile)` gives a `Rendered<Out>`, memoized per profile. |
| **Profile** | A model's capabilities: optional as `omit` or `null`, closed objects, records as `open` or `pairs`, tuples, unions as `anyOf` or `tagged`, `$defs`, recursion, "any" spelling, constraints, where examples go, enum cap, max depth, audience. Built in: `LENIENT`, `PEOPLE`, `OPENAI_STRICT`, `ANTHROPIC_STRICT`, `GOOGLE_STRICT`, `MINIMAL`. |
| **Rendered<Out>** | Holds `jsonSchema`, `parse(wire)`, `parseText(text)`, `encode(codeValue)` and `typescript()`. It holds nodes (proportional to schema size), never data. |
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
- **The grammar.** In `src/coverage/gin-grammar.ts`, gin's `buildSchemas` (`opts.Type`/`opts.Expr`) becomes one module: a static TypeDef + Expr + PathStep + PropDef grammar, with a dynamic `NamedType` enum keyed by registry version. Tools pick results from it, and no `keptLazy` workaround is needed (a ref is not a lazy getter).
- **Differences from `toValueSchema`.**
  - `map<text,V>` is a **record** in the code shape. Pairs are now a rendering choice, so gin's runtime reads records and strict models still see pairs.
  - Named types are `$defs` refs, not `z.lazy` + `aid`.

## Coverage table

"Proven by" names files in `packages/schema/src`. `T` means type tests (compiled by `test:types`); `R` means runtime tests (vitest).

| Use case | Where it lives today | How `a` expresses it | Proven by | Gaps |
|---|---|---|---|---|
| Core Tool args, static | core `tool.ts` `schema: ZodType` | `schema: a.object(...)` (a Bindable with no args) | coverage/core-tools.ts T | — |
| Core Tool args from ctx; tool unavailable | `schema: (ctx) => z… \| undefined` | `.dynamic((ctx) => …, {key})` + `applicable(ctx)` | coverage/core-tools.ts T (incl. the ctx mismatch error) | — |
| Core Prompt structured output, static / `(input, ctx)` / `false` | core `prompt.ts` | `Bindable<Out, [ctx, input]>`; `false` → no schema or `applicable` | coverage/core-tools.ts T | — |
| strictify: records → pairs, tuples → numeric keys, optional → nullable, default null | core `strictify.ts` | `profile.records/tuples/optional` in each class's `compile` | __tests__/render.test.ts R | — |
| decodeWire / relaxValidation / custom `parse` | core `decode.ts`, `Tool.parse` | `rendered.parse` (one pass, in place); `a.codec` | render.test.ts R (copy counts) | — |
| Dialects (openai, anthropic, google, xai, lenient), enum cap 40, size limits | core `dialects/*`, `descriptor.ts` | `Profile` + built-ins; enum widening; `maxDepth` → escape | render.test.ts R | xai profile not ported; per-schema size counts (5000 props, 120k chars) not yet measured from nodes (see open questions) |
| Recursion where unsupported (Anthropic), `$defs`, cycle breaker | core `cycle-breaker.ts`, `to-json-schema.ts` | DFS back-edge → JSON-text escape with a TS type, validated by LENIENT | render.test.ts R, coverage.test.ts R | — |
| "Any" encodings | core `any-value.ts` | `profile.any`: `{}` or JSON text | render.test.ts R | core's `recursive-strict` $defs/Any not ported (JSON text instead) |
| Per-request strict budget, `canExpress`, prompt-text fallback | core `budget.ts`, `expressible.ts` | stays in core and picks the profile; `rendered.typescript()` gives prompt text | — | not ported (open question 1) |
| Gin value types (every TypeDef kind) | gin `types/*` `toValueSchema` | `fromGin` / `GinSchema<T>` | gin/gin.test.ts R+T | `and`, `not`, `iface` (open question 4) |
| Gin named/registered types, generics `list<V>`, `map<V>` | gin registry, `alias.ts` z.lazy | `a.ref(name)` + `ginNamedTypes` in a dynamic step | gin/gin.test.ts R+T | — |
| Gin grammar: TypeDef + Expr programs (recursive, registry leaves) | gin `buildSchemas` (`opts.Type`, `opts.Expr`, `aid`) | one module, many results; dynamic `NamedType` | coverage/gin-grammar.ts T, coverage.test.ts R | the reduced grammar models 11 expr kinds + TypeDef by class; `newStrict` per-type `value` (open question 5) |
| Query schemas from DB tables (Source, paired FieldRef, filters, subqueries) | query `llm/schemas.ts`, `schema-build.ts` | static grammar + dynamic `Source`/`FieldRef` (discriminated union per table) | coverage/query.ts T, coverage.test.ts R | depth axes (`refs`/`functions` open vs typed) become variants of the dynamic step, not shown individually |
| Query size fallback (`shouldUseStringSchema`, `maxEnumSize`) | query `llm/schemas.ts` | profile enum widening; `maxDepth` escape | coverage.test.ts R (60 tables on Google) | whole-schema size budget (open question 1) |
| Saved query args from the compiled query | harness database `argsTypeOf` | dynamic step whose input is the saved query | coverage/query.ts T | — |
| Ginny tools/prompts `schema: (ctx) => …` (write, edit_type, test, dba, architect, designer) | ginny `tools/*`, `prompts/*` | gin module results; `(ctx, input)` prompt bundles | coverage/gin-grammar.ts T, core-tools.ts T | `create_var` value typed by the sibling `type` (open question 2) |
| Harness fn args/returns via gin (`ginAs`, `ginOf`, `toolArgsOf`, catalog `signature()`) | sdk `zod-gin.ts`, hub `catalog.ts` | `fromGin` straight to `a`; no zod middle step, no marker-by-description | coverage/harness-fns.ts T, coverage.test.ts R | — |
| `g.fnName()` model-name fields (two-way) | core `model-names.ts`, hub `readArgs` | `a.codec(a.string().pattern(…), {decode, encode})` | render.test.ts R, coverage.test.ts R | an async name registry that learns names (open question 3) |
| `record<V>` | core `gin-record.ts` | `a.record(V)`; the profile picks pairs | render.test.ts R | `arg-repair` of records sent as JSON strings (open question 6) |
| People-only fields, `forModels` narrower enums | core `people-only.ts` | `.forPeople()`, `.forModels(s)`; the `PEOPLE` profile for web | render.test.ts R, coverage.test.ts R | — |
| Union-of-objects args (`toolArgsOf` flattening, `{input}` wrap) | sdk `zod-gin.ts` | the union stays a union inside an object field; anyOf or tagged per profile | coverage/harness-fns.ts T | a non-object root is still wrapped by the caller (open question 7) |
| Static-mode `run({fn, args, on})`, `run_query {fn, args}`, `test` tools | hub `contextor/modes.ts` | dynamic discriminated union on `fn`, each option with that fn's args; codec for names; dynamic `on` enum | coverage/run-args.ts T, coverage.test.ts R | very large catalogs (open question 1) |
| Fleet `on` instance enum | hub `modes.ts` `fleetArgs` | dynamic ref `Instance` | coverage/run-args.ts T | — |
| Authoring drafts: code, api, schedule, program signature | sdk `authoring.ts`, `program/runtime.ts` `schemas()` | results of the gin module; session parts in the dynamic step | coverage/authoring.ts T | double-encoded drafts (open question 6) |
| Input forms (a TypeDef subset, recursive) | `systems/input` | a small static module; no lazy workaround | coverage/authoring.ts T | — |
| Widgets: per-call enums, per-arg plans, `checkWidget` rule | sdk `widget-schema.ts` | dynamic `Column`/`Visual`/`Plans` + `.refine` with a message | coverage/authoring.ts T, coverage.test.ts R | — |
| Schedule `When` (≈20 rules + superRefine), `Zone` brand, `SchedulePayload.args` program | `systems/schedule` | `.strict().refine(…)` ×3, `.refine().brand<'Zone'>()`, `a.ref('Expr')` | coverage/authoring.ts T, coverage.test.ts R | — |
| Database tables-as-types, DDL `typ<obj>` rows, `EnrichmentAnswer`, `ResultData` | `systems/database` | `fromGin` of the table types; `a.ref('TypeDef')` for DDL | coverage/query.ts T (shape), gin.test.ts | not modelled one by one: same constructs as above |
| MCP tool input/output schemas, elicitation forms | `systems/mcp/server/schema.ts` | `fromJSONSchema(json)` → a bundle (`$defs` → named types); unsupported keywords reported | coverage/mcp.ts T, coverage.test.ts R | `allOf` (more than one member), `if`/`then`/`else`, `not`, `patternProperties` (open question 8) |
| Hub structured outputs (`structuredAnswer`) | hub `models/structured.ts` | plain static objects | coverage/harness-fns.ts T | — |
| MCP-out (the hub as an MCP server) | sdk `server/mcp.ts` | `bound.render(LENIENT).jsonSchema` | — | trivial; not separately tested |
| Injected context | hub `injections.ts` | only people-only `inject` + fn-name spelling (covered above) | — | — |

## What moves from core/schema

| core/schema file | Where it goes |
|---|---|
| `descriptor.ts`, `dialects/*`, `registry.ts`, `consistency.ts` | `profile.ts`: `Profile` + built-ins. The registry of custom profiles moves too. `consistency` becomes checks on profile combinations (e.g. `any: 'json-text'` needs nothing). |
| `strictify.ts`, `decode.ts`, `walk-key.ts`, `check-bag.ts` | each class's `compile()` (render.ts + schema.ts). There is no second zod schema per dialect. |
| `to-json-schema.ts`, `json-schema.ts`, `enum-values.ts`, `any-value.ts`, `cycle-breaker.ts` | node `json()` + `Compiler.ref/escape` + `decorate` |
| `analyze.ts` (features, size limits), `expressible.ts` (`canExpress`) | a walk over the rendered node tree, giving exact counts per profile instead of zod-side estimates. Not ported in the POC. |
| `budget.ts` (`SchemaBudget`) | stays in core and decides which profile each tool/output gets |
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
| `src/proposal/core-api.ts` | the Tool/Prompt proposal |
| `src/__tests__/chain.types.ts` | the type proofs |
| `src/__tests__/render.test.ts` | the record example end to end + profiles |
| `src/coverage/*` | the use-case inventory, as code |

Run with `npm test` (vitest + `tsc -p tsconfig.typetest.json`) from `packages/schema`, using node 22.
