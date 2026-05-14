# Type System

Every gin Type — built-in or user-defined — exposes up to four surfaces. These are the only knobs you have for shaping runtime behavior. Any type can opt into any combination: a single type can be callable, indexable, looped over, AND have named props. There's no inheritance hierarchy that gates this — `obj` doesn't have privileged status; nor does `function`. Whatever surfaces a type defines, the engine dispatches against them.

## The four surfaces

### `props` — named methods and fields

A type's `props` map is the static surface accessed by name. Each prop is one of:

- A **value-typed prop** — `length: num` on `text`, `r: num` on `color`. Read by walking a path step `{prop: 'length'}`.
- A **method** — `add(other: num): num` on `num`, `slice(start, end?): text` on `text`. A method is just a prop whose type is a `function`; invoking it via `[{prop: 'add'}, {args: {other: 3}}]` runs the underlying expression / native.

The same path step `{prop: 'name'}` works for both — a method just has a callable type, so you follow it with a `{args: ...}` step.

### `get` — keyed access (and looping)

When a type defines `get`, it supports `[key]` access. The `GetSet` spec carries:

- `key` — the type a key must satisfy (`num` for lists, the field-name union for `obj`, `text` for `map<text, V>`, ...).
- `value` — what indexed access produces.
- Optional `loop` expression — drives `loop` iteration. When present, the type is iterable via `{kind: 'loop', over: <this value>, body: ...}`. The loop expression runs with `this` (the iterable) and `yield` (a callable taking `{key, value}`) bound in scope, and calls `yield` once per pair.
- Optional `loopDynamic: true` — flags while-loop semantics (the `over` expression is re-evaluated each iteration). `bool` uses this.

### `call` — make the type callable

When a type defines `call`, values of that type can be invoked. The `Call` spec carries `args` (an obj-shaped type), `returns` (the result type), optional `throws`, and optional `get`/`set` expressions that implement the call. `function` is the obvious example, but augmentation can make any type callable.

### `init` — constructor for `new`

When `init` is defined, `{kind: 'new', type: T, value: <args>}` parses `<args>` against `init.args` and runs `init.run` with `{this, args}` in scope — `this` is a default-constructed value and `args` is the parsed input. The expression returns either a fresh value (if the run returns one) or the mutated `this`.

Without `init`, `new T(value)` just runs `T.parse(value)` directly. `duration` and `color` ship with `init` defined; the LLM can author `new color({r: 255, g: 0, b: 0})` and the constructor packs the channels into a 32-bit integer.

The `value` slot of a `new` expression automatically reflects `init.args` in the LLM-facing schema — you don't need to write per-type `toNewSchema` overrides for that case.

## Generics

A type can declare `generic` parameters — each entry's value is a **constraint**, not a default. Bare `{name: 'R'}` inside the signature is an unresolved placeholder (gin's `AliasType`); concrete resolution happens when a call site supplies a binding.

| Constraint | Meaning |
|---|---|
| `R: any` | No constraint. Any type accepted as a binding. |
| `R: text \| obj` | Bindings must be assignable to `text \| obj`. Anything else is rejected at the call site with a clear error. |
| `R: <interface>` | Structural constraint. Bindings must satisfy the interface. |
| `R: alias('R')` | Self-reference. Equivalent to "no constraint"; the satisfies check is skipped. |

Bindings are validated when a `CallStep` provides them. There is no implicit default — if you don't bind, the parameter stays a placeholder and downstream type checks against it are permissive.

Generics show up natively in:

- Function types (`<R: ...>(args): R`).
- Parameterized types (`list<V>`, `map<K, V>`, `optional<T>`).
- Methods that introduce their own type parameters (`list.map<R>(fn): list<R>`).

## Type compatibility

`a.compatible(b)` answers "every value of b is also a valid value of a" — i.e. `b` is assignable to `a`. Used by:

- **Path validation** — a method call's args must be compatible with the called fn's args type.
- **Structural interface satisfaction** — does this object have all the props an interface requires?
- **Edit safety** — can this new type definition replace the old one without breaking callers? Check both directions.

For `obj`: `a.compatible(b)` requires every required field of `a` to exist on `b` with a compatible per-field type. Optional fields on `a` may be absent from `b` (the missing field defaults to undefined, which optional accepts). Extra fields on `b` are ignored. `opts.exact` tightens this to exact field-set match.

For `function`: bivariant on args (matches TypeScript's default method-arg rule), covariant on returns. Most code wants the bivariant form; edit-compat tooling splits args + returns and checks each side directionally to enforce strict TS-style variance.

## Extensions

`registry.extend(base, { name, ... })` creates a **named subtype** that overlays additions on a base. Extensions can:

- **Add props** — new fields and methods.
- **Override `get` / `call` / `init`** — replace any of the base's surfaces.
- **Narrow options** — `Email` extending `text({pattern: ...})` carries the tighter pattern at runtime.
- **Add a constraint Expr** — a runtime predicate every value must satisfy. Evaluated on `engine.validateValue(v)`; runs with `this` bound to the value.
- **Declare `generic`** — extensions can have their own type params.

```typescript
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
```

Extensions delegate everything to the base via `Type.compatible`, `Type.props` composition, etc. `Email extends text` is a real subtype: every Email is a valid text; tighter tests pass on Email-only values.

## Augmentations

`registry.augment(name, { props?, get?, call?, init? })` adds to an **existing** type by name — works for built-ins (`'num'`, `'text'`, `'date'`, `'timestamp'`, ...) and registered named types. Augmentation is gentler than extension:

- `props` are MERGED into the type's existing props. Intrinsic names win on conflict — you can't override `num.add` by augmenting num.
- `get` / `call` / `init` are applied IFF the type has none of its own. Augmentation FILLS GAPS — give `date` a `get` so it iterates, make `timestamp` callable, give `text` a constructor — but never overrides what's already there.

```typescript
r.augment('num', {
  props: {
    clamp01: r.method({}, r.num({ min: 0, max: 1 }), 'num.clamp01'),
  },
  init: new Init({
    args: r.obj({ percent: { type: r.num({ min: 0, max: 100 }) } }),
    run: { kind: 'native', id: 'num.fromPercent' },
  }),
});
```

The augmented surface flows through every consumer: path-walks dispatch against augmented props; static analysis sees them; code rendering shows them. No subclassing or wrapper required.

When you want to genuinely REPLACE behavior (not just add), use an Extension — extensions own their entire surface and can override freely.

## Read next

- [Expressions](./expressions.md) — the 12 expression kinds.
- [Registry](./registry.md) — `extend` / `augment` / `register` / `setNative` patterns.
- [Built-in Types](./built-ins.md) — the catalog every program starts with.
