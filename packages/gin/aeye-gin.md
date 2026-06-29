# @aeye/gin

> A JSON-based type & expression system that LLMs author, validate, and execute programs against at runtime.

`@aeye/gin` is a real type system (generics, structural subtyping, extension-based
inheritance) plus an expression language serialized as plain JSON. It is the
**runtime an LLM writes programs for** — not a model wrapper, not a prompt library.

```bash
npm install @aeye/gin zod      # zod 4.x is a peer/runtime dependency
```

```ts
import { createRegistry, createEngine, val } from '@aeye/gin';
```

## Why it exists

When an LLM emits "code" you either `eval` untrusted text or constrain it with a
structured-output schema that explodes for anything non-trivial. gin gives you a
third option:

- **Validate before execution.** A program is parsed and type-checked against the
  registry; broken programs are rejected before they run.
- **Round-trippable JSON.** Programs survive `JSON.stringify` / `JSON.parse`
  losslessly — persist, index, edit, replay.
- **A real type system.** Generics, interfaces, structural subtyping, extensions,
  augmentations — available to the LLM at authoring time.
- **Pluggable native dispatch.** Methods on `num`, `text`, `list<V>`, `date`,
  etc. are gin methods whose JS implementations you register; the LLM calls them
  as if built in.
- **An LLM-facing schema.** `buildSchemas(registry)` produces a Zod schema for
  every valid program against *this* registry; hand it to a tool and the model
  can only author well-typed programs.

## When to use it

- You want an LLM to author a typed function/program that you then test, persist,
  and re-invoke deterministically (this is what `@aeye/ginny` does).
- You need a sandboxed, statically-checked computation layer driven by model output.
- You need compiler-style diagnostics (`^^^` underlines) pointing at the exact
  offending node in the model's output.

Do **not** reach for it when a plain structured-output schema or a single tool call
suffices — gin is a whole language runtime.

## The three concepts

1. **Types** — every value has a `Type` describing its shape and four behavior
   *surfaces* (`props`, `get`, `call`, `init`). Built-ins (`num`, `text`,
   `list<V>`, `obj`, `date`, `color`, ...) ship pre-registered. You add your own
   via `extend` (real subtyping) or `augment` (gap-filling on an existing type).
2. **Expressions** — twelve `kind`s of `ExprDef` JSON nodes (`new`, `get`, `set`,
   `define`, `block`, `if`, `switch`, `loop`, `lambda`, `template`, `flow`,
   `native`). A program is a tree of these.
3. **The Registry** — the central object. It owns the type catalog, native
   bindings, expression-class dispatch, parsing, and the type builders.
   `createRegistry()` ships with everything pre-registered.

## Hello, gin

```ts
import { createRegistry, createEngine } from '@aeye/gin';

const r = createRegistry();
const engine = createEngine(r);

// (1 + 2) * 3  — authored as an ExprDef JSON tree
const program = {
  kind: 'get',
  path: [
    { prop: 'one' },                 // first step = a scope variable
    { prop: 'add' },
    { args: { other: { kind: 'new', type: { name: 'num' }, value: 2 } } },
    { prop: 'mul' },
    { args: { other: { kind: 'new', type: { name: 'num' }, value: 3 } } },
  ],
};

const result = await engine.run(program, {
  one: r.num().parse(1),            // seed a scope variable as a Value
});
console.log(result.raw); // 9
```

Key shapes to internalize:
- A `get` path **always starts** with a `{ prop: '<scopeVar>' }` step.
- A method call is two steps: `{ prop: 'add' }` then `{ args: { ... } }`.
- A literal is `{ kind: 'new', type: <TypeDef>, value: <raw> }`.
- `engine.run` returns a `Value` — a `{ type, raw }` pair. Read `.raw` for the JS
  value, `.toJSON()` for the `{type, value}` wire envelope.

## Public API at a glance

| Export | What it is |
|---|---|
| `createRegistry(): Registry` | Registry pre-loaded with all built-in types, natives, expr classes. |
| `createEngine(registry): Engine` | Evaluation / validation / inference / rendering. |
| `Registry` | Implements `TypeBuilder` (`r.num()`, `r.list(...)`, ...) + parsing + registration. |
| `Engine` | `run`, `validate`, `typeOf`, `toCode`, `toGinCode`, `toJSONCode`, `validateValue`. |
| `buildSchemas(registry, overrides?)` | Zod schemas (`.Type`, `.Expr`) describing valid programs for an LLM. |
| `Value<T>`, `val(type, raw)` | Runtime typed value; constructor helper. |
| `Type`, `Prop`, `GetSet`, `Call`, `Init` | Type-system runtime classes. |
| `Expr` + `NewExpr` ... `NativeExpr` | Abstract expr base + the 12 concrete classes. |
| `Code`, `code`, `span`, `plain` | Rendered-source container with span tracking. |
| `Effects`, `combineEffects`, `hasEffects`, `formatEffects` | Side-effect classification bitset. |
| `Problems`, `Problem` | Validation diagnostics bag. |
| `Path`, `PathStep`, `walkPath` | Path-walking primitives. |
| `registerBuiltinNatives(registry)` | (Re)register the built-in native impls. |

## Read next

- [Type system](./aeye-gin-types.md) — the four surfaces, generics, compatibility, extend vs augment, built-in catalog.
- [Expressions](./aeye-gin-expressions.md) — the 12 kinds, path grammar, parsing model.
- [Registry & Engine](./aeye-gin-registry.md) — builders, natives, scopes, globals, schema generation.
- [Codegen & diagnostics](./aeye-gin-codegen.md) — `toCode` / `toGinCode` / `toJSONCode`, `Code`, `formatProblems`.

For a full application built on gin, see `@aeye/ginny`.
