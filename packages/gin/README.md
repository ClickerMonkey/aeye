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

---

## The type system

Every Type — built-in or developer-defined — exposes up to four
surfaces. These are the only knobs you have for shaping runtime
behavior:

### `props` — named methods and fields

A type's `props` map is the static surface accessed by name. Each prop
is one of:

- A **value-typed prop** — `length: num` on `text`, `r: num` on `color`.
  Read by walking a path step `{prop: 'length'}`.
- A **method** — `add(other: num): num` on `num`, `slice(start, end?): text`
  on `text`. A method is just a prop whose type is a `function` —
  invoking it via `[{prop: 'add'}, {args: {other: 3}}]` runs the
  underlying expression / native.

The same path step `{prop: 'name'}` works for both — a method just has
a callable type, so you follow it with a `{args: ...}` step.

### `get` — keyed access (and looping)

When a type defines `get`, it supports `[key]` access. The `GetSet`
spec carries:

- `key` — the type a key must satisfy (`num` for lists, the field-name
  union for `obj`, `text` for `map<text, V>`, ...).
- `value` — what indexed access produces.
- Optional `loop` expression — drives `loop` iteration. When present, the
  type is iterable via `{kind: 'loop', over: <this value>, body: ...}`.
  The loop expression runs with `this` (the iterable) and `yield` (a
  callable taking `{key, value}`) bound in scope, and calls `yield`
  once per pair. Native loops live in `gin/src/natives/*.ts`; you can
  register custom ones via augmentation.
- Optional `loopDynamic: true` — flags while-loop semantics (the
  `over` expression is re-evaluated each iteration). `bool` uses this.

### `call` — make the type callable

When a type defines `call`, values of that type can be invoked. The
`Call` spec carries `args` (an obj-shaped type), `returns` (the
result type), optional `throws`, and optional `get`/`set` expressions
that implement the call. `function` is the obvious example, but
augmentation can make any type callable.

### `init` — constructor for `new`

When `init` is defined, `{kind: 'new', type: T, value: <args>}` parses
`<args>` against `init.args` and runs `init.run` with `{this, args}`
in scope — `this` is a default-constructed value and `args` is the
parsed input. The expression returns either a fresh value (if the run
returns one) or the mutated `this`. Without `init`, `new T(value)`
just runs `T.parse(value)` directly. `duration` and `color` ship with
init defined; the LLM authors `new color({r: 255, g: 0, b: 0})` and
the constructor packs the channels into a 32-bit integer.

The `value` slot of a `new` expression automatically reflects
`init.args` in the LLM-facing schema — devs don't write per-type
`toNewSchema` overrides for that case.

---

## Generics

A type can declare `generic` parameters — each entry's value is a
**constraint**, not a default. Bare `{name: 'R'}` inside the
signature is an unresolved placeholder (gin's `AliasType`); concrete
resolution happens when a call site supplies a binding.

- `R: any` — no constraint. Any type accepted as a binding.
- `R: text | obj` — bindings must be assignable to `text | obj`.
  Anything else is rejected at the call site with a clear error.
- `R: <interface>` — structural constraint. Bindings must satisfy
  the interface (every prop / get / call the interface declares
  exists on the binding with a compatible type).
- `R: alias('R')` — self-reference. Equivalent to "no constraint";
  the satisfies check is skipped.

Bindings are validated when a `CallStep` provides them. There is no
implicit default — if you don't bind, the parameter stays a
placeholder and downstream type checks against it are permissive.

Generics show up natively in fn types (`<R: ...>(args): R`), in
parameterized types (`list<V>`, `map<K, V>`, `optional<T>`), and on
methods that introduce their own type parameters (`list.map<R>(fn): list<R>`).

---

## Type compatibility

`a.compatible(b)` answers "every value of b is also a valid value of
a" — i.e. `b` is assignable to `a`. Used by:

- **path validation** — a method call's args must be compatible with
  the called fn's args type.
- **structural interface satisfaction** — does this object have all
  the props an interface requires?
- **edit safety** — can this new type definition replace the old one
  without breaking callers? Check both directions.

For obj specifically: `a.compatible(b)` requires every required
field of `a` to exist on `b` with a compatible per-field type.
Optional fields on `a` may be absent from `b` (the missing field
defaults to undefined, which optional accepts). Extra fields on `b`
are ignored. `opts.exact` tightens this to exact field-set match.

For fn: bivariant on args (matches TypeScript's default method-arg
rule), covariant on returns. Most code wants the bivariant form;
edit-compat tooling splits args + returns and checks each side
directionally to enforce strict TS-style variance.

---

## Extensions

`registry.extend(base, { name, ... })` creates a named type that
overlays additions on a base. Extensions can:

- **Add props** — new fields and methods.
- **Override `get` / `call` / `init`** — replace any of the base's
  surfaces.
- **Narrow options** — `Email` extending `text({pattern: ...})`
  carries the tighter pattern at runtime.
- **Add a constraint Expr** — a runtime predicate every value must
  satisfy. Evaluated on `engine.validateValue(v)`; runs with `this`
  bound to the value.
- **Declare `generic`** — extensions can have their own type params.

Extensions delegate everything to the base via `Type.compatible`,
`Type.props` composition, etc. `Email extends text` is a real
subtype: every Email is a valid text; tighter tests pass on
Email-only values.

---

## Augmentations

`registry.augment(name, { props?, get?, call?, init? })` adds to an
EXISTING type by name — works for built-ins (`'num'`, `'text'`,
`'date'`, `'timestamp'`, ...) and registered named types. Augmentation
is gentler than extension:

- `props` are MERGED into the type's existing props. Intrinsic names
  win on conflict — you can't override `num.add` by augmenting num.
- `get` / `call` / `init` are applied IFF the type has none of its
  own. Augmentation FILLS GAPS — give `date` a `get` so it iterates,
  make `timestamp` callable, give `text` a constructor — but never
  overrides what's already there.

The augmented surface flows through every consumer: path-walks
dispatch against augmented props; static analysis sees them; code
rendering shows them — in the `toCodeDefinition` body of a built-in
AND of a named Extension, alongside that Extension's own members
(0.3.13 fixed the Extension arm, which used to drop them from the
print). No subclassing or wrapper required.

Augmentation is REGISTRY-SIDE surface, never wire shape: it stays out
of `toJSON()` and out of `toValueSchema()` / `toNewSchema()`. So it is
the slot for methods on a type whose VALUE contract must stay closed —
a `resource` handle that must keep parsing from a bare `{ id }` gets
its `markdown()` / `url()` here, not as local props.

When you want to genuinely REPLACE behavior (not just add), use an
Extension — extensions own their entire surface and can override
freely.

---

## The 12 expression kinds

A gin program is a tree of `Expr` JSON objects. Every node has
`kind: '...'` plus the fields that kind declares.

### `new` — construct a value of a given type

`{ kind: 'new', type: <TypeDef>, value?: <raw or args> }`

If the type has `init`, `value` is parsed as `init.args` and the
constructor runs. Otherwise `value` is parsed as `type` directly. With
no `value`, returns `Value(type, type.create())` — the type's default.
`create()` honours the type's own constraints, so `T.parse(T.create())`
succeeds for every inhabitable `T` (`num{max:-3}.create()` is `-3`,
`text{minLength:2}.create()` is two chars, `and<num,num{min=3}>` is `3`).
The exceptions are uninhabitable types (`not<any>`, `and<num,text>`) and
constraints with no derivable witness (a regex `pattern`, a `fn` value).

### `get` — read through a path

`{ kind: 'get', path: [<step>, <step>, ...] }`

Steps walk left-to-right. Each step is `{prop: 'name'}` (named
access), `{args: {...}}` (call the previous step — used after a
method or any callable), or `{key: <Expr>}` (indexed access). The
first step is always `{prop: '<scopeVar>'}`. Result is the final
step's value.

### `set` — write through a path

`{ kind: 'set', path: [<step>, ...], value: <Expr> }`

Same path grammar as `get`, but the tail step writes. Returns `bool`:
true on success, false if a safe-nav null/undefined short-circuited
the walk.

### `define` — bind locals into a child scope

`{ kind: 'define', vars: [{ name, type?, value }, ...], body: <Expr> }`

Each var is added to scope BEFORE the next var's value is evaluated,
so later vars can reference earlier ones. The body runs with all
vars in scope; its result is the define's value.

### `block` — sequence of expressions

`{ kind: 'block', lines: [<Expr>, ...] }`

Lines run in order. Earlier lines are evaluated for their side
effects (set, native calls, fns); the block's value is the LAST
line's value. An empty block returns void.

### `if` — conditional branching

`{ kind: 'if', ifs: [{ condition, body }, ...], else?: <Expr> }`

Each condition must be `bool`-typed. First branch whose condition is
true wins. Without an else, a no-match if-expression returns void.

### `switch` — value-based branching

`{ kind: 'switch', value: <Expr>, cases: [{ equals: [<Expr>...], body }], else?: <Expr> }`

The case wins if `value` equals ANY one of `equals`. Cases are NOT
fall-through; only the matching case's body runs.

### `loop` — iterate any iterable

`{ kind: 'loop', over: <Expr>, body: <Expr>, key?: string, value?: string, parallel?: {...} }`

Two evaluation modes by `over`'s static type:
- **Iterable** (`get().loop` defined): walked once. `key` / `value`
  bind to scope under those names (override defaults via the optional
  fields).
- **Bool while-loop** (`get().loopDynamic === true`): `over` is
  RE-EVALUATED each iteration. The loop continues while truthy and
  exits the moment it becomes false. `bool` uses this.

Optional `parallel: { concurrent?, rate? }` fans body execution out:
`concurrent` caps simultaneous bodies, `rate` paces start times. The
native iterator just calls `yield(k, v)`; the parallel orchestration
sits in `LoopExpr.evaluate` so every iterable inherits it for free.

Parallel composes with the dynamic mode too: `bool over` plus
`parallel: { concurrent: 3 }` fans the body out up to 3 in-flight,
and `over` is re-evaluated against the outer scope every time a task
COMPLETES (not when it starts). So accumulating side effects from
the prior batch decide whether more tasks spawn.

### `lambda` — callable closure over the lexical scope

`{ kind: 'lambda', type: <fn TypeDef>, body: <Expr>, constraint?: <Expr> }`

Inside the body, `args` is the call-site arguments obj and `recurse`
is this lambda (for self-calls). Optional `constraint` runs before
the body each call (must return `bool`); throws on false.

### `template` — string interpolation

`{ kind: 'template', template: '<string>', params: <Expr returning obj> }`

Each `{name}` placeholder in the string is replaced with the
stringified `params.name`. Compiles to a JS template literal in
`toCode` rendering when params is a `new obj` literal.

### `flow` — non-local control flow

`{ kind: 'flow', action: 'break' | 'continue' | 'return' | 'exit' | 'throw', value?, error? }`

- `break` / `continue` — only valid inside a `loop`.
- `return` — unwinds to the enclosing lambda or fn body; `value`
  becomes the result.
- `exit` — unwinds all the way to `engine.run`; `value` becomes the
  program result.
- `throw` — raises `error`; caught by a path step's `catch:` handler.

### `native` — escape hatch to a registered native impl

`{ kind: 'native', id: '<nativeId>', type?: <TypeDef> }`

Calls into a JS/TS function registered via `registry.setNative(id,
impl)`. Most natives are referenced indirectly — `num.add`'s prop
type carries `{kind: 'native', id: 'num.add'}` as its get expression,
so a path call to `.add` dispatches without any explicit `native`
node in user code. You'd hand-write a `native` node when authoring a
custom loop ExprDef or a method whose impl lives outside gin.

---

## Parsing

gin has TWO levels of parsing — they compose:

1. **JSON → runtime objects.** `registry.parse(typeDef)` turns a
   `TypeDef` JSON into a `Type` instance; `registry.parseExpr(exprDef,
   scope?)` turns an `ExprDef` into an `Expr`. Inverse:
   `type.toJSON()` / `expr.toJSON()`. Round-trips losslessly.

   `parse` is STRICT about keys. A `TypeDef` may carry only `name`,
   `docs`, `extends`, `satisfies`, `generic`, `options`, `init`,
   `props`, `get`, `call`, `constraint`, and each class declares what
   may appear inside its `generic` and its `options`. Anything else is
   an error rather than an ignored key, because every slot has a
   silent default: `{name:'list', options:{item: T}}` — the element
   type belongs in `generic.V` — would otherwise parse to `list<any>`
   without complaint. The error names the offending key and, where it
   can, the construct that was meant: the nearest valid key on a typo,
   the `generic` parameter a stray TypeDef belongs in, or the `enum` a
   closed set of constants should have been.

2. **Runtime data → typed values.** Once you have a `Type`, calling
   `type.parse(jsonData)` validates the data and returns a `Value<T>`
   — the runtime currency. A `Value` is a `{type, raw}` pair where
   `raw` is the JS storage shape. `value.toJSON()` produces the JSON
   shape; `type.encode(value.raw)` does the same at the type level.

Both levels are scope-aware. Generic placeholders (`AliasType`)
resolve through the scope passed to parse — that's how a `CallStep`'s
`generic: { R: <type> }` map flows into the called signature without
rebuilding the type tree.

---

## The Registry — the only class you really need

`Registry` is your interface. Every other class (`Type`, `Expr`,
`Engine`, `Value`, `Path`, ...) is reachable through it. You'll rarely
construct one yourself — `createRegistry()` ships with every built-in
type, native, and Expr class pre-registered.

Key methods:

| Method | Purpose |
|---|---|
| `parse(def)` / `parseExpr(def, scope?)` | TypeDef / ExprDef → runtime |
| `define(cls)` | Register a built-in Type class for JSON dispatch |
| `register(type)` | Register a named Type instance (typically an Extension) |
| `lookup(name)` | Look up a Type by name (registered → built-in fallback) |
| `setNative(id, impl)` | Wire a JS function as a gin native |
| `getNative(id)` | Read it back |
| `defineExpr(cls)` | Register an ExprClass (12 ship; you rarely add more) |
| `extend(base, { name, ... })` | Create a named Extension |
| `augment(name, { props?, get?, call?, init? })` | Add to an existing type by name |
| `augmentation(name)` | Read augmentation back |
| `like(type)` | Pick a registered concrete type compatible with a constraint |

The builder methods (`r.num()`, `r.text()`, `r.list(item)`, `r.obj({...})`,
`r.fn(args, returns, throws?, generic?)`, `r.iface({...})`,
`r.method(args, returns, nativeId)`, `r.prop(type, nativeId)`, ...) are
sugar for parse — they construct runtime types without going through
JSON.

`createEngine(registry)` builds an Engine that owns evaluation,
validation, and type-inference walks. Programs run via `engine.run(expr,
extras?)`; static analysis via `engine.validate(expr)` /
`engine.typeOf(expr)`.

---

## Built-in type catalog

Below is what `createRegistry()` ships with — the surface every gin
program starts with. Each type's section is the same `toCodeDefinition`
output an LLM sees in its prompt.

```
type any {
  toAny(): any
  typeOf(): text
  is<T>(): bool
  as<T>(): optional<T>
  toText(): text
  toBool(): bool
  eq(other: any): bool
  neq(other: any): bool
}

type void {
  toAny(): any
  toText(): text
  toBool(): bool
}

type null {
  toAny(): any
  toText(): text
  toBool(): bool
}

type bool {
  [key: num{whole=true, min=0}]: bool
  toAny(): any
  eq(other: bool): bool
  neq(other: bool): bool
  and(other: bool): bool
  or(other: bool): bool
  xor(other: bool): bool
  not(): bool
  toText(): text
  toNum(): num
}

type num {
  [key: num{whole=true, min=0}]: num
  toAny(): any
  eq(other: num, epsilon?: num): bool
  neq(other: num, epsilon?: num): bool
  lt(other: num): bool
  lte(other: num): bool
  gt(other: num): bool
  gte(other: num): bool
  add(other: num): num
  sub(other: num): num
  mul(other: num): num
  div(other: num): num
  mod(other: num): num
  pow(other: num): num
  abs(): num
  neg(): num
  sign(): num
  sqrt(): num
  min(other: num): num
  max(other: num): num
  clamp(min: num, max: num): num
  floor(): num
  ceil(): num
  round(): num
  isZero(): bool
  isPositive(): bool
  isNegative(): bool
  isInteger(): bool
  isEven(): bool
  isOdd(): bool
  toText(precision?: num): text
  toBool(): bool
}

type text {
  [key: num]: text{minLength=1, maxLength=1}
  toAny(): any
  length: num
  eq(other: text): bool
  neq(other: text): bool
  contains(search: text): bool
  startsWith(prefix: text): bool
  endsWith(suffix: text): bool
  trim(): text
  trimStart(): text
  trimEnd(): text
  upper(): text
  lower(): text
  slice(start: num, end?: num): text
  replace(search: text, replacement: text): text
  split(separator: text): list<text>
  concat(other: text): text
  repeat(count: num): text
  indexOf(search: text, from?: num): num
  lastIndexOf(search: text, from?: num): num
  match(pattern: text): list<text>
  test(pattern: text): bool
  isEmpty(): bool
  isNotEmpty(): bool
  toNum(): num
  toBool(): bool
}

type list<V> {
  [key: num{whole=true, min=0}]: V
  length: num
  at(index: num): optional<V>
  push(value: V): void
  pop(): optional<V>
  shift(): optional<V>
  unshift(value: V): void
  insert(index: num, value: V): void
  remove(index: num): V
  clear(): void
  slice(start?: num, end?: num): list<V>
  concat(other: list<V>): list<V>
  reverse(): list<V>
  join(separator?: text): text
  indexOf(value: V): num
  contains(value: V): bool
  unique(): list<V>
  duplicates(): list<V>
  map<R>(fn: (value: V, index: num): R): list<R>
  filter(fn: (value: V, index: num): bool): list<V>
  find(fn: (value: V, index: num): bool): optional<V>
  reduce<R>(fn: (acc: R, value: V, index: num): R, initial: R): R
  some(fn: (value: V, index: num): bool): bool
  every(fn: (value: V, index: num): bool): bool
  sort(fn?: (a: V, b: V): num): list<V>
  isEmpty(): bool
  isNotEmpty(): bool
  first?: V
  last?: V
}

type map<K, V> {
  [key: K]: V
  size: num
  at(key: K): optional<V>
  has(key: K): bool
  delete(key: K): bool
  clear(): void
  keys(): list<K>
  values(): list<V>
  isEmpty(): bool
  isNotEmpty(): bool
}

type tuple<...elements> {
  [key: num]: <element-union>
  length: num
  first: <head>
  last: <tail>
  toList(): list<element-union>
}

type obj {
  keys(): list<text>
  values(): list<any>
  entries(): list<tuple<text, any>>
  has(key: text): bool
  eq(other: any): bool
  neq(other: any): bool
  toText(): text
}

type optional<T> {
  value: T
  has(): bool
  or(fallback: T): T
  map<R>(fn: (value: T): R): optional<R>
}

type nullable<T> {
  value: T
  isNull(): bool
  or(fallback: T): T
  map<R>(fn: (value: T): R): nullable<R>
}

type or<...variants>      // union; props/get/call when ALL variants share them
type and<...parts>        // intersection; props from ANY part. ALL-object parts
                          //   merge (and<obj{a},obj{b}> ≡ obj{a,b}); otherwise
                          //   the first part parses and the rest constrain.
type not<excluded>        // any value EXCEPT one matching excluded
type literal<T>           // one specific constant value of T
type enum<V>              // named constants of value type V
type function             // see "call" — args/returns/throws/generic
type interface            // structural contract; props/get/call only
type typ<T>               // a value that IS a Type, constrained by T
type alias                // bare-name reference / generic placeholder

type date {
  year, month, day, dayOfWeek, dayOfYear   // num
  eq, neq, before, after                    // (other: date) → bool
  addDays/Months/Years, diffDays/Months/Years
  toText(format?): text
}

type timestamp {
  year..millisecond                         // num
  eq, before, after                         // (other: timestamp) → bool
  addDuration, subDuration, diff
  toDate(): date
  toEpoch(): num
  toText(format?): text
}

type duration {
  new(days?, hours?, minutes?, seconds?, ms?)
  totalSeconds, totalMinutes, totalHours, totalDays
  days, hours, minutes, seconds, ms
  toText(format?): text
}

type color {
  new(r, g, b, a?)
  r, g, b, a, hue, saturation, lightness    // num
  eq, neq                                    // (other: color) → bool
  lighten, darken, saturate, desaturate, opacity, invert, mix, complement
  toHex, toRgb, toHsl, toText               // → text
}
```

---

## Putting it together

A single example demonstrating the four developer-facing surfaces:

```ts
import { createRegistry, createEngine, GetSet, Init, val, Value } from '@aeye/gin';

const r = createRegistry();

// 1. Extension — a real subtype with its own surface.
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

// 2. Native — the JS implementation of Email.domain. Natives access
//    `this` via scope.get('this').
r.setNative('Email.domain', (scope, reg) => {
  const self = scope.get('this')!.raw as string;
  return val(reg.text(), self.split('@')[1] ?? '');
});

// 3. Augmentation — give the existing `num` type a `clamp01` method,
//    AND a constructor so `new num({percent})` produces a 0–1 num.
r.augment('num', {
  props: {
    clamp01: r.method({}, r.num({ min: 0, max: 1 }), 'num.clamp01'),
  },
  init: new Init({
    args: r.obj({ percent: { type: r.num({ min: 0, max: 100 }) } }) as any,
    run: { kind: 'native', id: 'num.fromPercent' },
  }),
});

r.setNative('num.clamp01', (scope, reg) => {
  const n = scope.get('this')!.raw as number;
  return val(reg.num({ min: 0, max: 1 }), Math.max(0, Math.min(1, n)));
});
r.setNative('num.fromPercent', (scope, reg) => {
  const args = scope.get('args')!.raw as Record<string, Value>;
  const pct = args['percent']!.raw as number;
  return val(reg.num({ min: 0, max: 1 }), pct / 100);
});

// 4. Run a program. (Programs are JSON — typically authored by an LLM,
//    not hand-written. Here we hand-write one for illustration.)
const engine = createEngine(r);

const program = {
  kind: 'block',
  lines: [
    {
      kind: 'define',
      vars: [
        // `new num({percent: 75})` — augmented init runs; result is 0.75.
        { name: 'opacity', value: {
          kind: 'new',
          type: { name: 'num' },
          value: { percent: 75 },
        } },
        { name: 'address', value: {
          kind: 'new',
          type: { name: 'Email' },
          value: 'team@example.com',
        } },
      ],
      body: {
        kind: 'block',
        lines: [
          // Augmented method: opacity.clamp01() — already in [0,1].
          { kind: 'get', path: [{ prop: 'opacity' }, { prop: 'clamp01' }, { args: {} }] },
          // Extension method: address.domain() → 'example.com'.
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

- `r.extend(...)` produces `Email`, a real subtype of `text` with a
  custom prop. Static analysis treats Email as text everywhere text
  is expected.
- `r.augment('num', ...)` adds `clamp01` AND `init` to the canonical
  `num` type. Every num — including extensions over num — picks them
  up. `new num({percent: 75})` flows through the augmented init.
- `r.setNative(id, impl)` wires the JS implementations. Any path call
  that references those native ids dispatches through them.
- `engine.run(program)` evaluates the JSON tree, validating types as
  it walks.

Augmentations and extensions live on the registry. Pass that registry
to the engine — and to any prompt schema generator (`buildSchemas(r)`)
— so the LLM authoring programs sees the full surface.

---

## License

GPL-3.0
