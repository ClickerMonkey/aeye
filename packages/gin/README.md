# gin

> A JSON-based programming language and type system designed for LLMs to author, validate, and execute typed programs at runtime.

`gin` gives an LLM a real type system with proper generics, structural
compatibility, and extension-based inheritance — plus an expression
language serialized as plain JSON. Programs survive round-trips through
`JSON.stringify` / `JSON.parse`, can be introspected and validated
without running them, and can be executed in-process against a
pluggable registry of native functions.

```bash
npm install @aeye/gin zod
```

## Why gin?

LLMs are good at JSON. They're less good at language grammars with
balanced parens, significant whitespace, and rule-based parsers. gin
inverts the traditional approach:

- **Programs are JSON trees.** Every expression has a `kind` discriminator.
  Every type has a `name`. Serialization is free.
- **Types are first-class values.** A `typ<T>` slot accepts any registry
  type compatible with `T` — including user-defined extensions — and
  narrows its ExprDef schema so the LLM only sees valid choices.
- **Structural + extension typing.** `Task extends obj` inherits obj's
  shape and methods while adding new props, constraint predicates, and
  overrides. Compatibility is decided by structure, not name.
- **Per-class Zod schemas at every layer.** `toSchema()` schemas the
  TypeDef JSON. `toValueSchema()` schemas runtime data. `toNewSchema()`
  schemas `new` expressions. `toInstanceSchema()` schemas narrow-match
  TypeDef JSON for containers that constrain registered types. The LLM
  always gets a tight Zod union of exactly what's valid at that slot.
- **Native functions.** Register any JS/TS function as a `fn<...>` type;
  calls from gin programs dispatch to your implementation.

## Quick start

`createRegistry()` ships with every built-in type and native
implementation pre-registered. `createEngine(r).run(expr)` evaluates a
program.

### 1. `let x = 2; return x.add(3)` → `5`

```ts
import { createRegistry, createEngine } from '@aeye/gin';

const r = createRegistry();
const engine = createEngine(r);

const program = {
  kind: 'define',
  vars: [
    { name: 'x', value: { kind: 'new', type: { name: 'num' }, value: 2 } },
  ],
  body: {
    kind: 'get',
    path: [
      { prop: 'x' },                    // read x from scope
      { prop: 'add' },                  // num's `.add` method
      { args: { other: { kind: 'new', type: { name: 'num' }, value: 3 } } },
    ],
  },
};

const result = await engine.run(program);
console.log(result.raw);     // 5
console.log(result.type.name); // 'num'
```

### 2. Extension types + lambdas + collection methods

Count completed tasks in a typed `list<Task>`:

```ts
import { createRegistry, createEngine } from '@aeye/gin';

const r = createRegistry();

// Declare Task as an obj extension with two typed fields.
const Task = r.extend(r.obj({
  title: { type: r.text({ minLength: 1 }) },
  done:  { type: r.bool() },
}), { name: 'Task', docs: 'An action item in a to-do list' });
r.register(Task);

const engine = createEngine(r);

// tasks.filter(t => t.done).length
const program = {
  kind: 'define',
  vars: [{
    name: 'tasks',
    value: {
      kind: 'new',
      type: { name: 'list', generic: { V: { name: 'Task' } } },
      value: [
        { title: 'ship it',    done: true  },
        { title: 'write docs', done: false },
        { title: 'deploy',     done: true  },
      ],
    },
  }],
  body: {
    kind: 'get',
    path: [
      { prop: 'tasks' },
      { prop: 'filter' },
      {
        args: {
          fn: {
            kind: 'lambda',
            type: {
              name: 'function',
              call: { args: { name: 'object' }, returns: { name: 'bool' } },
            },
            body: {
              // `args.value` is the current Task (filter passes {value, index}).
              kind: 'get',
              path: [{ prop: 'args' }, { prop: 'value' }, { prop: 'done' }],
            },
          },
        },
      },
      { prop: 'length' },
    ],
  },
};

const result = await engine.run(program);
console.log(result.raw); // 2
```

Everything above round-trips through `JSON.stringify`/`JSON.parse` —
the program, the Task type, every intermediate value. An LLM can
produce the same shape directly.

### 3. Native functions

Hook any JS/TS function into gin's call system by id:

```ts
import { val } from '@aeye/gin';

// Override `num.sqrt` so it does the obvious thing.
r.setNative('num.sqrt', (scope, registry) =>
  val(registry.num(), Math.sqrt((scope.get('this')!.raw as number))),
);

const sqrt16 = {
  kind: 'get',
  path: [
    { prop: 'n' },
    { prop: 'sqrt' },
    { args: {} },
  ],
};
const result = await engine.run(sqrt16, { n: val(r.num(), 16) });
console.log(result.raw); // 4
```

## Core concepts

### `Type`

A `Type` describes the shape of values and exposes the operations on
them. Every type implements:

| Method | Purpose |
|---|---|
| `valid(raw, scope?)` | Runtime type guard over the raw value |
| `parse(json, scope?)` | JSON → `Value<T>` (throws on mismatch) |
| `encode(raw, scope?)` | raw → JSON envelope (round-trip-safe) |
| `compatible(other, opts?, scope?)` | structural compatibility check |
| `like(other, scope?)` | narrow self by `other`, recursing through children |
| `simplify(scope?)` | collapse trivial wrappers; AliasType resolves through `scope` |
| `props(scope?)` / `get(scope?)` / `call(scope?)` / `init(scope?)` | expose fields, index access, call signatures, constructors |
| `toCode()` / `toCodeDefinition()` | render TypeScript-like source for the LLM |
| `toSchema(opts)` | Zod schema for the TypeDef JSON |
| `toValueSchema(opts)` | Zod schema for the runtime VALUE |
| `toNewSchema(opts)` | Zod schema for the value side of `{kind:'new'}` |
| `toInstanceSchema()` | Zod schema that narrow-matches TypeDef JSON (used by `typ<T>`) |
| `toJSON()` | serialize the Type itself to a TypeDef |

### `Value`

A `Value<T>` pairs a type with a runtime raw payload:

```ts
class Value<T> {
  readonly type: Type<T>;
  readonly raw: RuntimeOf<T>;
  toJSON(): JSONValue<T>;   // { type: TypeDef, value: JSONOf<T> }
}
```

Composites store `Value`-wrapped children so per-element concrete types
survive JSON round-trips — a `Dog` stored in a `list<Animal>` comes
back as a `Dog`, not widened to `Animal`.

### `Expr`

The expression AST. Every node has a `kind` and serializes to
`ExprDef`. The built-in kinds:

| Kind | Purpose |
|---|---|
| `new` | Construct a value of a specific type |
| `get` | Read a path (`{prop}`, `{args}`, `{key}`) from scope |
| `set` | Write a path target |
| `define` | Bind local variables in a child scope |
| `block` | Sequence expressions; last value wins |
| `if` | Multi-arm conditional with optional else |
| `switch` | Value discrimination with `equals` patterns |
| `loop` | Body + condition + end/step (supports `break`/`continue`) |
| `lambda` | Inline function value |
| `template` | Handlebars-powered string interpolation |
| `flow` | `return` / `break` / `continue` / `throw` signals |
| `native` | Direct call into a registered native implementation |

### `Registry`

Central authority:

1. Maps `name → Type class` for JSON parse dispatch.
2. Maps `name → Type instance` for user-registered named types.
3. Maps `id → NativeImpl` for native-function overrides.
4. Implements `TypeBuilder` — the factory for constructing types
   (`r.num()`, `r.list(r.text())`, `r.fn(args, returns)`, ...).

```ts
const r = createRegistry();
r.register(r.extend(r.num(), { name: 'Positive', constraint: /* ... */ }));
r.setNative('my.op', (scope, registry) => val(registry.text(), 'ok'));
```

### `Engine`

Stateless across runs. Each `run()` builds a fresh root scope seeded
with registered globals plus per-call extras:

```ts
const engine = createEngine(r);
engine.registerGlobal('PI', { type: r.num(), value: 3.14 });
const result = await engine.run(expr, { userInput: val(r.text(), 'hello') });
```

Also exposes `engine.typeOf(expr)` (static type inference) and
`engine.validate(expr)` (structural problem collection) for tooling
that wants to analyze a program without running it.

## Type system

### Leaves

| Type | Options |
|---|---|
| `any` | top type — accepts anything |
| `void` / `null` | bottom-ish unit types |
| `bool` | `{}` |
| `num` | `min`, `max`, `whole`, `minPrecision`, `maxPrecision`, `prefix`, `suffix` |
| `text` | `minLength`, `maxLength`, `pattern`, `flags` |
| `date` / `timestamp` | `min`, `max`, `utc`, (timestamp) `precision` |
| `duration` | milliseconds |
| `color` | `hasAlpha` |
| `literal<T>` | exact-value constraint over inner type |

All leaves enforce their options at `parse()` time and carry them
through to `toValueSchema()`.

### Containers

| Type | Description |
|---|---|
| `list<V>` | ordered collection; `minLength`/`maxLength` |
| `map<K,V>` | typed entry list — LLM-friendly shape `[{key,value}]` |
| `tuple<A,B,...>` | fixed-arity positional |
| `obj{prop: Type, ...}` | structural record with declared fields |
| `optional<T>` | `T ∣ undefined` |
| `nullable<T>` | `T ∣ null` |
| `fn<args,R,E?>` | callable with obj args, return R, optional throws E |
| `iface{props, get, call}` | contract a value must satisfy structurally |
| `enum<V>` | constrained set of values |
| `or<A,B,...>` / `and<A,B,...>` / `not<T>` | type algebra |
| `ref<Name>` | lazy reference to a registered named type (enables recursion) |
| `generic<Name>` | type-parameter placeholder |
| `typ<T>` | values ARE Types; T constrains which Types are acceptable |

### Extensions

```ts
const Task = r.extend(r.obj({
  title: { type: r.text({ minLength: 1 }) },
  done:  { type: r.bool() },
}), {
  name: 'Task',
  docs: 'An action item in a to-do list',
  props: {
    isOverdue: r.method({}, r.bool(), 'task.isOverdue'),
  },
});
r.register(Task);
```

An `Extension` wraps a base type, adds local options / fields / methods
/ constraint predicates, and preserves structural compatibility with
the base. Multi-level extension is supported — every layer's props
compose.

### Recursive types & generics — both ride the same `AliasType`

Bare-name TypeDefs (`{name: 'X'}` with no other peers) parse as
`AliasType('X')`. That single class covers what used to be two
distinct concepts:

- **Lazy reference** to a named type registered with the registry —
  the target doesn't need to exist at construction time, so mutual
  cycles work:

  ```ts
  const Task = r.extend(r.obj({
    title:   { type: r.text() },
    creator: { type: r.alias('User') },
  }), { name: 'Task' });
  r.register(Task);

  const User = r.extend(r.obj({
    name:  { type: r.text() },
    tasks: { type: r.list(r.alias('Task')) },
  }), { name: 'User' });
  r.register(User);
  ```

- **Generic placeholder** — the same builder. Type-parameterized
  types (`list<V>`, `map<K,V>`, `typ<T>`) store their parameters in a
  `generic: Record<string, Type>` map; the placeholders inside are
  AliasTypes captured against the enclosing local scope.

`AliasType.resolve(extra?)` walks an optional caller-supplied
TypeScope first, then its captured scope. That's the only resolution
mechanism — no `bind()` / `substitute()` / type-tree rebuilding.
Pre-resolution, an unresolved alias acts as a maximally permissive
placeholder.

Function types support **method-level generics**:

```ts
// list.map<R>(fn: (value:V, index:num) => R): list<R>
const listT = r.list(r.alias('V'));
listT.toCodeDefinition();
// type list<V> {
//   map<R>(fn: (value: V, index: num): R): list<R>
//   ...
// }
```

#### Specializing generics at call sites — `TypeScope`

Resolution-touching methods on `Type` (`parse`, `valid`, `compatible`,
`props`, `prop`, `get`, `call`, `init`, `follow`, `like`, `simplify`)
take an optional `scope?: TypeScope`. Pass a `LocalScope` of bindings
to override `R` (etc.) without rebuilding anything:

```ts
import { LocalScope } from '@aeye/gin';

// fn map<R>(fn: (value: V, index: num) => R): list<R>
const mapFn = r.fn(
  r.obj({ fn: { type: r.fn(r.obj({ value: { type: V } /*…*/ }), r.alias('R')) } }),
  r.list(r.alias('R')),
  undefined,
  { R: r.any() },
);

const local = new LocalScope(r, { R: r.num() });
mapFn.call(local).returns!.simplify(local).name === 'list';        // list<num>
```

Path-step `generic` bindings (`[..., {args, generic: {R: numDef}}]`)
work the same way: `CallStep.callSiteScope(calledType)` builds the
`LocalScope` once per call and threads it into the type's resolution
methods. The fn type itself is never cloned.

### `typ<T>` — types-as-values

Sometimes you want a program to receive a *type* as an argument — e.g.
"parse this HTTP response as `T`". `typ<T>` does that:

```ts
// fn fetch<R = text>(args: { url: text, output?: typ<R> }): R
const fetchFn = r.fn(
  r.obj({
    url:    { type: r.text() },
    output: { type: r.optional(r.typ(r.alias('R'))) },
  }),
  r.alias('R'),
  undefined,
  { R: r.text() },
);
```

`typ<num>`'s runtime `.raw` is a `Type` instance (one-shot parsed from
TypeDef JSON). Its `toValueSchema()` emits a Zod union of every
registry type compatible with `num` — `{name:'num'}`, `{name:'Positive'}`
(if registered), etc. — plus an inline-Extension branch whose `extends`
enum is narrowed to compatible bases. The LLM sees exactly the valid
choices.

## Schema layers

gin produces four distinct Zod schemas, each for a different purpose:

| Method | What it validates |
|---|---|
| `static TypeClass.toSchema(opts)` | The TypeDef JSON shape for this class. Used by `buildSchemas` to union every registered type. |
| `type.toValueSchema(opts)` | A runtime value of this type (a number for `num`, `{x,y}` for an obj). Feeds LLM structured-output modes. |
| `type.toNewSchema(opts)` | The `value:` side of a `{kind:'new'}` expression. For composites, each slot is `opts.Expr` (any expression). |
| `type.toInstanceSchema()` | Narrow-match against this specific instance's TypeDef JSON. Used by `typ<T>` to emit the compatible-types union. |

`buildSchemas(registry, overrides?)` composes the recursive
`opts.Type` / `opts.Expr` schemas the LLM uses to author programs. Pass
`{ newStrict: true }` to get a discriminated union per registered type
instead of the loose class-level fallback.

## Native functions

```ts
r.setNative('num.add', (scope, registry) => {
  const self = scope.get('this')!.raw as number;
  const other = (scope.get('args')!.raw as any).other.raw as number;
  return val(registry.num(), self + other);
});
```

Built-in natives for every leaf/container method are registered by
`registerBuiltinNatives(registry)`. User code can override any of them
by id to inject instrumentation or swap implementations.

## Analysis without running

- `engine.typeOf(expr)` returns the inferred `Type` of an expression
  under a given `TypeScope`. Never throws — unknowns fall through to `any`.
- `engine.validate(expr)` walks the AST collecting `Problems` — unknown
  vars, unknown natives, out-of-place `break`/`return`, etc. Useful
  for warning the LLM before wasting a full run.

## Testing

```bash
npm test                  # 615+ tests covering every type, expression, and edge
npm run dump-schema       # emit a sample opts.Type/opts.Expr union
npm run dump-code         # emit toCodeDefinition() for every built-in
```

## Use cases

- **Typed tool outputs for LLM agents.** Have the LLM produce an
  ExprDef the agent can statically validate, execute, and trust the
  return shape of.
- **Runtime-authored programs.** Let users (or models) define
  pipelines, transformations, or DSLs without shipping a parser.
- **Structured-output schema generation.** Produce Zod schemas from
  typed user-input definitions and pass them straight to
  `ai.chat.get({responseFormat})`-style APIs.
- **Cross-session persistence.** Every Type and Expr is JSON — write
  it to disk, load it later, execute against the same registry.
- **Sandboxed execution.** Programs only see what you registered as
  natives and globals; no filesystem, no network unless you wire it.

## Related packages

- **[`@aeye/ginny`](../ginny)** — a CLI that turns natural-language
  requests into executable gin programs. Uses the type system and
  expression engine described here as its runtime.

## License

GPL-3.0
