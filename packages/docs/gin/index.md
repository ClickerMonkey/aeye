# gin

> A JSON-based programming language and type system designed for LLMs to author, validate, and execute typed programs at runtime.

`gin` is part of the `@aeye` family but it isn't a provider, a component framework, or a wrapper around an LLM. It's the **runtime an LLM authors programs against** — a real type system with proper generics, structural compatibility, and extension-based inheritance, plus an expression language serialized as plain JSON.

```bash
npm install @aeye/gin zod
```

## Why a separate language?

When an LLM produces "code" today, you get unstructured text that you `eval` (terrifying) or constrain with structured outputs (better, but the schema explodes for anything non-trivial). Neither approach gives you:

- **Compile-time validation before execution.** A gin program is parsed and type-checked against the registry; broken programs are rejected before they run.
- **Round-trippable JSON.** Programs survive `JSON.stringify` / `JSON.parse` losslessly. They can be persisted, indexed, edited, and replayed.
- **A real type system.** Generics, interfaces, structural subtyping, extensions, augmentations — the things that make TypeScript code reusable, available to the LLM at authoring time.
- **Pluggable native dispatch.** Methods on `num`, `text`, `list<V>`, `date`, etc. are gin methods whose implementations live in JS — you can register your own natives and the LLM calls them as if they were built in.

The result: you can ship an LLM tool that writes a typed function, tests it, persists it, and lets future calls invoke it directly. `@aeye/ginny` does exactly that as a CLI; `@aeye/gin` is the engine.

## Where it fits

```
┌──────────────────────────────────────────────┐
│  Your application                            │
│  ↓                                           │
│  @aeye/ai     ← tool-calling, model select   │
│  @aeye/core   ← Prompt / Tool / Agent        │
│  @aeye/gin    ← LLM-authorable runtime       │
│  ↓                                           │
│  Your registry of native fns + types         │
└──────────────────────────────────────────────┘
```

`@aeye/gin` is consumed two ways:

- **Standalone** — author programs from a TS host (or via an LLM elsewhere) and run them via `engine.run(expr)`.
- **Through `@aeye/ai`** — register a tool whose schema is `buildSchemas(registry)` (the LLM-facing schema for ExprDefs) and let the LLM author programs as tool arguments. `ginny` does this.

## Quick orientation

Three concepts to grasp:

1. **Types** — every value has a type; types describe shape, methods, equality, and how they parse JSON. Built-ins (`num`, `text`, `list<V>`, `obj`, `date`, `duration`, `color`, ...) ship with the registry; you add your own via `extend` (real subtyping) or `augment` (gap-filling on existing types).
2. **Expressions** — twelve `kind`s of `ExprDef` JSON nodes (`new`, `get`, `set`, `define`, `block`, `if`, `switch`, `loop`, `lambda`, `template`, `flow`, `native`). A program is a tree of these.
3. **The Registry** — the only class you really need. It owns the type catalog, native function bindings, expression-class dispatch, and parsing. `createRegistry()` ships with everything pre-registered.

## Read next

- [Type System](./types.md) — props / get / call / init, generics, compatibility, extensions, augmentations.
- [Expressions](./expressions.md) — the 12 kinds and what each carries.
- [Registry](./registry.md) — registration patterns, native bindings, schema generation for LLMs.
- [Built-in Types](./built-ins.md) — the catalog every program starts with.
- [Diagnostics](./diagnostics.md) — `formatProblem` / `formatProblems` for compiler-style errors against gin or JSON output.

For a complete application built on gin, see [`@aeye/ginny`](../examples/ginny.md).
