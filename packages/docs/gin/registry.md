# Registry

The `Registry` is the only class you really need to construct. Every other class (`Type`, `Expr`, `Engine`, `Value`, `Path`, ...) is reachable through it. `createRegistry()` ships with every built-in type, native, and Expr class pre-registered — start there.

## Key methods

| Method | Purpose |
|---|---|
| `parse(def)` / `parseExpr(def, scope?)` | TypeDef / ExprDef → runtime |
| `define(cls)` | Register a built-in Type class for JSON dispatch |
| `register(type)` | Register a named Type instance (typically an Extension) |
| `lookup(name)` | Look up a Type by name (registered → built-in fallback) |
| `setNative(id, impl)` | Wire a JS function as a gin native |
| `getNative(id)` | Read a native back |
| `defineExpr(cls)` | Register an ExprClass (12 ship; you rarely add more) |
| `extend(base, { name, ... })` | Create a named Extension (real subtype) |
| `augment(name, { props?, get?, call?, init? })` | Add to an existing type by name |
| `augmentation(name)` | Read augmentation back |
| `like(type)` | Pick a registered concrete type compatible with a constraint |

## Builder methods

The builder methods construct runtime types without going through JSON. They're sugar for `parse`:

```typescript
r.num()                                 // num
r.num({ min: 0, max: 100, whole: true }) // num with constraints
r.text()                                // text
r.text({ minLength: 1, pattern: '...' }) // constrained text
r.list(r.num())                         // list<num>
r.map(r.text(), r.num())                // map<text, num>
r.obj({ name: { type: r.text() }, age: { type: r.num(), optional: true } })
r.fn(args, returns)                     // function type
r.fn(args, returns, throws)             // with throws
r.fn(args, returns, throws, generic)    // with generics
r.iface({ ... })                        // structural interface
r.method(args, returns, nativeId)       // method whose impl is a native
r.prop(type, nativeId)                  // value prop with native getter
```

Pass them around as values; combine them. Most user code that builds types programmatically uses the builders rather than hand-writing TypeDef JSON.

## The Engine

`createEngine(registry)` builds an Engine that owns evaluation, validation, and type-inference walks:

| Method | Purpose |
|---|---|
| `engine.run(expr, extras?)` | Execute a program. Returns `Value<T>`. |
| `engine.validate(expr)` | Static analysis. Returns `Problems` (validation errors / warnings). |
| `engine.typeOf(expr)` | Static type inference. Returns `Type` or undefined. |
| `engine.toCode(expr)` | Render to a TypeScript-flavored display string. |
| `engine.toJSONCode(expr)` | Render to JSON Code with span tracking (see [Diagnostics](./diagnostics.md)). |

Programs run in a scope. Scope variables come from `extras` plus globals registered via `engine.registerGlobal(name, { type, value })`. Each sub-call (lambda body, fn invocation) creates a child scope — no implicit leaks between branches.

## Native functions

Natives are JS/TS functions registered against a string id and called via `{ kind: 'native', id: '...' }` expressions OR indirectly through method props whose `get` expression is a native call.

```typescript
r.setNative('Email.domain', (scope, reg) => {
  const self = scope.get('this')!.raw as string;
  return val(reg.text(), self.split('@')[1] ?? '');
});
```

Inside a native:

- `scope.get(name)` returns a `Value` for a scoped binding (or undefined).
- `scope.get('this')` for instance methods.
- `scope.get('args')` for callable types — the args obj `Value`.
- `val(type, raw)` constructs a fresh `Value`.

Most natives feel mechanical: read inputs from scope, do the work, return `val(type, result)`. The interesting ones are loops and async natives, which use the same shape but read `yield` from scope and call it with `(key, value)` pairs.

## Schema generation for LLMs

`buildSchemas(registry)` returns a Zod schema describing every valid `ExprDef` against THIS registry — including augmentations and extensions. Pass that schema as a Tool's parameter and the LLM can only produce well-typed gin programs:

```typescript
import { buildSchemas } from '@aeye/gin';

const writeProgram = ai.tool({
  name: 'write_program',
  schema: z.object({
    program: buildSchemas(registry).expr,  // any ExprDef the LLM authors must validate
  }),
  call: async ({ program }, _, ctx) => {
    const expr = registry.parseExpr(program);
    const result = await engine.run(expr);
    return { value: result.toJSON(), type: result.type.toCodeDefinition() };
  },
});
```

`buildSchemas` regenerates if you add types or natives at runtime — call it after registration to capture additions.

## Putting it together

```typescript
import { createRegistry, createEngine, val, Init } from '@aeye/gin';

const r = createRegistry();

// 1. Extension — real subtype with its own surface.
const Email = r.extend(
  r.text({ pattern: '^[^@]+@[^@]+$', minLength: 3 }),
  {
    name: 'Email',
    docs: 'A text value matching a basic email shape',
    props: {
      domain: r.method({}, r.text(), 'Email.domain'),
    },
  },
);
r.register(Email);

// 2. Native — implements Email.domain.
r.setNative('Email.domain', (scope, reg) => {
  const self = scope.get('this')!.raw as string;
  return val(reg.text(), self.split('@')[1] ?? '');
});

// 3. Augmentation — adds clamp01 + a percent-based constructor to num.
r.augment('num', {
  props: {
    clamp01: r.method({}, r.num({ min: 0, max: 1 }), 'num.clamp01'),
  },
  init: new Init({
    args: r.obj({ percent: { type: r.num({ min: 0, max: 100 }) } }),
    run: { kind: 'native', id: 'num.fromPercent' },
  }),
});
r.setNative('num.clamp01', (scope, reg) => {
  const n = scope.get('this')!.raw as number;
  return val(reg.num({ min: 0, max: 1 }), Math.max(0, Math.min(1, n)));
});
r.setNative('num.fromPercent', (scope, reg) => {
  const args = scope.get('args')!.raw as Record<string, any>;
  return val(reg.num({ min: 0, max: 1 }), (args.percent.raw as number) / 100);
});

// 4. Run a program. (Hand-written here; usually authored by an LLM.)
const engine = createEngine(r);

const program = {
  kind: 'block',
  lines: [
    {
      kind: 'define',
      vars: [
        // `new num({percent: 75})` — augmented init runs; result is 0.75.
        { name: 'opacity', value: { kind: 'new', type: { name: 'num' }, value: { percent: 75 } } },
        { name: 'address', value: { kind: 'new', type: { name: 'Email' }, value: 'team@example.com' } },
      ],
      body: {
        kind: 'block',
        lines: [
          { kind: 'get', path: [{ prop: 'opacity' }, { prop: 'clamp01' }, { args: {} }] },
          { kind: 'get', path: [{ prop: 'address' }, { prop: 'domain' }, { args: {} }] },
        ],
      },
    },
  ],
};

const result = await engine.run(program);
console.log(result.raw); // 'example.com'
```

What this exercises:

- `r.extend(...)` produces `Email`, a real subtype of `text`. Static analysis treats Email as text everywhere text is expected; tighter tests pass on Email-only values.
- `r.augment('num', ...)` adds `clamp01` AND `init` to the canonical `num` type. Every num — including extensions over num — picks them up. `new num({percent: 75})` flows through the augmented init.
- `r.setNative(id, impl)` wires the JS implementations. Any path call referencing those native ids dispatches through them.
- `engine.run(program)` evaluates the JSON tree, validating types as it walks.

Augmentations and extensions live on the registry. Pass that registry to the engine — and to any prompt schema generator (`buildSchemas(r)`) — so the LLM authoring programs sees the full surface.

## Read next

- [Built-in Types](./built-ins.md) — the catalog every program starts with.
- [Diagnostics](./diagnostics.md) — `formatProblem` / `formatProblems` and the JSON Code span model.
