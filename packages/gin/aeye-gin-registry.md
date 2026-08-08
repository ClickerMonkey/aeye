# @aeye/gin — Registry & Engine

The `Registry` is the central object — it owns the type catalog, native bindings,
expr-class dispatch, parsing, and the type builders (it implements `TypeBuilder`
and `TypeScope`). The `Engine` owns evaluation, validation, inference, and
rendering. Start with `createRegistry()` + `createEngine(r)`. See
[overview](./aeye-gin.md).

```ts
import { createRegistry, createEngine } from '@aeye/gin';
const r = createRegistry();           // all built-ins, natives, expr classes
const engine = createEngine(r);
```

## Registry — key methods

| Method | Purpose |
|---|---|
| `parse(def, scope?)` | `TypeDef` → `Type`. Refuses any key it would not read — see [strict parsing](./aeye-gin-types.md#the-typedef-wire-format-and-strict-parsing). |
| `parseExpr(def, scope?)` | `ExprDef` → `Expr` (idempotent on `Expr`; `undefined` passes through). |
| `parseValue(json, expectedType?, scope?)` | `{type,value}` envelope or raw → `Value`. |
| `lookup(name)` | `Type` by name (registered instance → built-in fallback). |
| `define(cls)` | Register a built-in Type **class** for JSON dispatch. Declare `optionKeys` / `genericKeys` on it to opt into strict parsing. |
| `register(type)` | Register a named Type **instance** (typically an Extension). |
| `extend(base, local)` | Create a named Extension (real subtype); `base` is a `Type` or name. |
| `augment(name, { props?, get?, call?, init? })` | Add to an existing type by name. |
| `augmentation(name)` | Read an augmentation back. |
| `setNative(id, impl, effects?)` | Wire a JS fn as a gin native (with declared effects). |
| `getNative(id)` / `nativeEffects(id)` | Read native impl / its effects. |
| `nativeExpr(id)` | Build a parsed `{kind:'native', id}` Expr. |
| `defineExpr(cls)` / `exprClass(kind)` | Register / look up an Expr class. |
| `like(type)` / `compatible(type)` | Pick registered type(s) compatible with a constraint. |
| `getTypesFor(ifaceName)` | All registered types satisfying an interface. |
| `validate(engine)` | Sweep & validate every registered/augmented type's surface. |
| `toCode` / `toGinCode` / `toJSONCode` | Render an expr (see codegen doc). |

Type builders (`r.num()`, `r.list(...)`, `r.obj({...})`, `r.fn({...})`, ...) are
documented in the [type system doc](./aeye-gin-types.md#building-types-programmatically-typebuilder).

## Engine — key methods

| Method | Returns | Purpose |
|---|---|---|
| `run(expr, extras?)` | `Promise<Value>` | Execute. Builds a fresh root scope per call. |
| `validate(expr, scope?, ctx?)` | `Problems` | Static analysis (unknown vars/props, type mismatches, misplaced flow, no-op loops). Never throws. |
| `typeOf(expr, scope?)` | `Type` | Static return-type inference (`any` on unknowns). Never throws. |
| `validateValue(value, scope?)` | `Promise<Problems>` | Run a value through its type's constraint chain. |
| `toCode(expr, options?)` | `string` | TS-flavored display source. |
| `toGinCode(expr, options?)` | `Code` | TS-flavored source **with spans**. |
| `toJSONCode(expr, indent=2)` | `Code` | JSON form **with spans**. |
| `registerGlobal(name, { type, value, docs? })` | `this` | Add a global to every root scope. |
| `getGlobal` / `getGlobals` / `globalTypeScope` | — | Read globals / their type scope. |
| `createRootScope(extras?)` | `Scope` | Root scope = globals + extras. |
| `evaluate(expr, scope)` | `Promise<Value>` | Parse-if-needed then dispatch. |

> Gotcha: `toCode` returns a **string**; `toGinCode` and `toJSONCode` return a
> **`Code`** (text + spans). Use the latter two when you need
> `code.formatProblems(problems)` underlines.

## Scopes, globals, and `extras`

A program runs in a `Scope`. Root-scope variables come from globals (registered
via `engine.registerGlobal`) plus per-call `extras`. Each sub-call (lambda body,
method invocation) creates a **child scope** — no implicit leaks between branches.
`extras` is `Record<string, Value>`:

```ts
const result = await engine.run(program, { one: r.num().parse(1) });
```

```ts
engine.registerGlobal('pi', { type: r.num(), value: 3.14159, docs: 'circle constant' });
```

The engine is stateless across runs; mutations live in the scope graph, not on
the engine or registry.

## Native functions

A native is a JS function registered by string id. It receives the runtime scope
and the registry:

```ts
import { val } from '@aeye/gin';

r.setNative('Email.domain', (scope, reg) => {
  const self = scope.get('this')!.raw as string;       // instance methods read `this`
  return val(reg.text(), self.split('@')[1] ?? '');
});
```

Inside a native:
- `scope.get('this')` — the receiver (instance methods).
- `scope.get('args')` — the args obj `Value` (callable types).
- `scope.get('key')` / `scope.get('value')` — index get/set.
- `scope.get('yield')` — loop iterators call this with each `(key, value)`.
- `val(type, raw)` — build a fresh `Value`.

`setNative(id, impl, effects?)` — `effects` defaults to the conservative
`STATE|SYSTEM|EXTERNAL` for *user* natives (assume worst case). Built-in pure
natives opt into `Effects.NONE`. Declare accurately so effect propagation /
no-op detection works.

## Schema generation for LLMs

`buildSchemas(registry, overrides?)` returns a `SchemaOptions` whose `.Type` and
`.Expr` are Zod schemas describing every valid `TypeDef` / `ExprDef` against
**this** registry — including extensions and augmentations. Hand `.Expr` to a tool
and the LLM can only author well-typed programs.

```ts
import { buildSchemas } from '@aeye/gin';
import { z } from 'zod';

const { Expr } = buildSchemas(r);          // regenerate AFTER registering custom types

// e.g. with @aeye/ai:
const writeProgram = ai.tool({
  name: 'write_program',
  schema: z.object({ program: Expr }),
  call: async ({ program }) => {
    const expr = r.parseExpr(program);
    const problems = engine.validate(expr);
    if (problems.hasErrors) {
      return { ok: false, errors: engine.toGinCode(expr).formatProblems(problems) };
    }
    const result = await engine.run(expr);
    return { ok: true, value: result.toJSON() };
  },
});
```

`BuildSchemasOverrides`: `{ types?: Type[], exprs?: Expr[], newStrict?: boolean }`.
- `types` / `exprs` surface specific instances as first-class union branches.
- `newStrict` locks `new`'s schema to a union over the provided `types`.

The schema is built lazily (`z.lazy`) so recursion resolves on demand; call
`buildSchemas` again after adding types/natives to capture additions.

## End-to-end example

```ts
import { createRegistry, createEngine, val, Init } from '@aeye/gin';

const r = createRegistry();

// 1. Extension — a real subtype of text.
const Email = r.extend(r.text({ pattern: '^[^@]+@[^@]+$', minLength: 3 }), {
  name: 'Email',
  props: { domain: r.method({}, r.text(), 'Email.domain') },
});
r.register(Email);
r.setNative('Email.domain', (scope, reg) =>
  val(reg.text(), (scope.get('this')!.raw as string).split('@')[1] ?? ''));

// 2. Augmentation — add a percent constructor to num.
r.augment('num', {
  init: new Init({
    args: r.obj({ percent: { type: r.num({ min: 0, max: 100 }) } }),
    run: r.nativeExpr('num.fromPercent'),
  }),
});
r.setNative('num.fromPercent', (scope, reg) => {
  const args = scope.get('args')!.raw as Record<string, { raw: number }>;
  return val(reg.num({ min: 0, max: 1 }), args.percent.raw / 100);
});

// 3. Run a program (here hand-written; usually authored by an LLM).
const engine = createEngine(r);
const program = {
  kind: 'define',
  vars: [
    { name: 'opacity', value: { kind: 'new', type: { name: 'num' }, value: { percent: 75 } } },
    { name: 'addr',    value: { kind: 'new', type: { name: 'Email' }, value: 'team@example.com' } },
  ],
  body: { kind: 'get', path: [{ prop: 'addr' }, { prop: 'domain' }, { args: {} }] },
};
const out = await engine.run(program);
console.log(out.raw); // 'example.com'
```

Augmentations and extensions live on the registry — pass that same registry to
`createEngine` AND to `buildSchemas` so the LLM sees the full surface.

## Read next

- [Type system](./aeye-gin-types.md)
- [Expressions](./aeye-gin-expressions.md)
- [Codegen & diagnostics](./aeye-gin-codegen.md)
