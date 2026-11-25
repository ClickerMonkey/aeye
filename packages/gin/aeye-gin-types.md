# @aeye/gin — Type system

Every gin value is a `Value<T>` = a `{ type: Type, raw }` pair. The `Type` defines
behavior; `raw` is the JS storage shape (composites hold nested `Value`s so
per-element concrete types are preserved). See [overview](./aeye-gin.md).

## The four surfaces

A `Type` can opt into any combination of four surfaces. There is no privileged
hierarchy — `obj` is not special; whatever surfaces a type defines, the engine
dispatches against.

### `props` — named fields & methods

`type.props()` returns a `Record<string, Prop>`. A `Prop` is either:

- a **value prop** (`length: num`) — read by a `{ prop: 'length' }` path step;
- a **method** — a prop whose `type` is a `function`; invoked with
  `{ prop: 'add' }` then `{ args: { other: ... } }`.

Every type inherits a universal `toAny(): any` prop from the base `Type`.

### `get` — keyed access & looping

`type.get()` returns a `GetSet` when `[key]` access is supported. It carries:

- `key` — the type a key must satisfy (`num` for lists, `text` for `map<text,V>`).
- `value` — what indexed access produces.
- optional `loop` Expr — drives `loop` iteration; runs with `this` (the iterable)
  and `yield` (a callable taking `{key, value}`) in scope, calling `yield` per pair.
- optional `loopDynamic: true` — while-loop semantics; the loop's `over` expr is
  re-evaluated each iteration. `bool` uses this.

### `call` — make the type callable

`type.call()` returns a `Call` carrying `args` (an obj-shaped type), optional
`returns`, optional `throws`, optional call-local `types` aliases, and optional
`get`/`set` Exprs that implement the call. `function` is the obvious case;
augmentation can make any type callable.

### `init` — constructor for `new`

`type.init()` returns an `Init { args, run }`. When present,
`{ kind: 'new', type: T, value: <args> }` parses `<args>` against `init.args` and
runs `init.run` with `{ this, args }` in scope. Without `init`, `new T(value)`
just runs `T.parse(value)`. `duration` and `color` ship with `init`.

## Building types programmatically (`TypeBuilder`)

The `Registry` implements `TypeBuilder`; these return runtime `Type` instances
(sugar over JSON `parse`). **Every builder returns its concrete class carrying
the TypeScript value it describes**, so the gin type is the one source of truth
for the runtime contract AND the static one — change a field and every
TypeScript use of the inferred value follows:

```ts
import { createRegistry, type Infer } from '@aeye/gin';
const r = createRegistry();

const Read = r.obj({
  path: r.text({ minLength: 1 }),
  offset: r.optional(r.num({ min: 0, whole: true })),
  mode: r.field(r.enum(['text', 'bytes']), { docs: 'How to return the content.' }),
});
type Read = Infer<typeof Read>;
// { path: string; mode: 'text' | 'bytes'; offset?: number | undefined }

const args: Read = Read.parse({ path: 'a.txt', mode: 'text' }).toLogical();
```

| Builder | Returns | `Infer<…>` |
|---|---|---|
| `any()` / `void()` / `null()` | `AnyType` / `VoidType` / `NullType` | `any` / `void` / `null` |
| `bool(o?)` / `num(o?)` / `text(o?)` | `BoolType` / `NumType` / `TextType` | `boolean` / `number` / `string` |
| `date(o?)` / `timestamp(o?)` | `DateType` / `TimestampType` | `Date` |
| `duration()` / `color(o?)` | `DurationType` / `ColorType` | `number` (ms / packed rgb) |
| `list(item, o?)` | `ListType<V>` | `V[]` |
| `map(key, value)` | `MapType<K, V>` | `Map<K, V>` |
| `tuple([a, b, …])` | `TupleType<[A, B, …]>` | `[A, B, …]` |
| `obj({ k: field, … })` | `ObjType<…>` | `{ k: … }`; an `optional<T>` field is an optional key |
| `field(type, { docs?, default? })` | `FieldSpec<X>` | (a field of `obj` / `iface` / `extend`) |
| `optional(t)` / `nullable(t)` | `OptionalType<T>` / `NullableType<T>` | `T \| undefined` / `T \| null` |
| `or([a, b, …])` | `OrType<A \| B \| …>` | the union |
| `and([a, b, …])` | `AndType<A & B & …>` | the intersection (a `Type[]` of unknown length infers `any`) |
| `enum(['a', 'b'])` | `EnumType<'a' \| 'b', string>` | `'a' \| 'b'` — labels are their own values |
| `enum({ low: 1, high: 9 }, num())` | `EnumType<1 \| 9, number>` | `1 \| 9` |
| `literal('x')` / `literal(3)` / `literal(true)` | `LiteralType<'x', string>` … | the constant; the inner type is picked from it |
| `literal(inner, value)` | `LiteralType<V, B>` | `V` |
| `fn({ args, returns?, throws?, generic?, call? })` | `FnType<A, R, E>` | `FnValue<A, R>`; read the signature with `FnArgs` / `FnReturns` / `FnThrows` |
| `iface({ props?, get?, call? })` | `IfaceType<…>` | its **data** props (methods are surface on the satisfying type) |
| `alias<T = unknown>(name)` | `AliasType<T>` | `T` — a name resolves at use time, so say what it stands for |
| `typ(constraint)` | `TypType<T>` | `Type` (a type as a value) |
| `extend(base, { name, props?, … })` | `Extension<…>` | the base value plus the stored-data props added |
| `extend('text', { … })` | `Extension<string>` | a built-in class name types as that class; any other name is `unknown` |
| `prop(type, nativeId, docs?)` / `method(args, returns, nativeId, o?)` | `ComputedProp<…>` | (surface: a computed read / a method) |

Fields of `obj`, `iface` and `extend` may each be written three ways — a bare
`Type` (the shorthand), a `PropSpec` (`{ type, docs?, default?, get?, set? }`)
or a `Prop` — and `field(type, options)` is the PropSpec that keeps its exact
type. A `default` is an `Expr` / `ExprDef`, filled in by `new` when the payload
omits the field.

**Data and surface.** A field with a `get` expression, or whose type is a `fn`,
is SURFACE — computed or callable, never stored. It is left out of the inferred
value of an `iface` and of the fields an `extend` adds, matching what `parse`,
`valid` and the value schema (`toA`) do at run time.

```ts
const Customer = r.extend(r.obj({ id: r.text() }), {
  name: 'Customer',
  docs: 'A paying customer.',
  props: {
    email: r.text(),                                                 // data
    upgrade: r.method({ plan: r.text() }, r.bool(), 'Customer.upgrade'), // surface
  },
});
type Customer = Infer<typeof Customer>;   // { id: string; email: string }
```

**Everything else gin has is reachable from the same builder**: constraints are
each class's options (`num{min,max,whole,…}`, `text{minLength,maxLength,pattern,flags}`,
`list{minLength,maxLength}`, `date{min,max,utc}`, …) and an extension's
`constraint` Expr; defaults and per-field docs ride `field`; generics are a fn's
`generic` (declared, with `alias('T')` placeholders) and an extension's `generic`
(bound with `specialize`); methods are `method` props, on an extension or added
to any existing type with `r.augment(name, { props })`.

### Inference helpers

| Export | What it is |
|---|---|
| `Infer<X>` | The logical value of a `Type`. Read from a phantom slot (`ValueSlot`), never from the methods, so `JSONOf` / `RuntimeOf` never leak in. |
| `ObjValue<Fields>` | The value of `obj(fields)` for a fields record. |
| `DataFields<Fields>` / `IsSurfaceField<F>` / `IsOptionalField<F>` | The data / surface / optional split the builders use. |
| `TupleValue<E>` / `IntersectValues<V>` / `WithData<T, Fields>` / `NamedValue<N>` | The values of `tuple`, `and`, `extend` and a built-in class name. |
| `FnValue<A, R>`, `FnArgs<F>` / `FnReturns<F>` / `FnThrows<F>` | A fn value (a callable over `Value`s, a lambda `ExprDef`, or a native ref) and a fn type's signature. |

### Plain values: `Value.toLogical()`

`value.toLogical()` is the value as `Infer` describes it — plain JS, with every
nested `Value` cell unwrapped, a `map` as a `Map`, `date` / `timestamp` as
`Date`. It is the form to hand to code that consumes a value gin has checked:

```ts
const checked = registry.parseValue(json, Read).toLogical();   // Read's Infer
```

It differs from `encodeLogical()`, which is logical **JSON** (ISO strings for
timestamps, `[{key, value}]` for maps).

> Gotcha: `r.fn(...)` takes ONE options object (`{ args, returns? }`), and
> `r.method(args, ...)` takes `args` as a plain `Record<string, Type>` (each
> entry becomes an obj field) — not an obj type.

## Named type references (`references`, `closure`)

A def that names a type it does not define — `{name: 'Customer'}`,
`extends: 'Customer'`, `satisfies: ['Comparable']` — only parses to the intended
type where that name resolves. A process that receives defs from elsewhere asks
gin which names it needs, fetches those, binds them in a scope, and parses:

```ts
import { typeReferences, typeClosure } from '@aeye/gin';

typeReferences(def, registry);
// { refs: ['Customer', 'Order'], defines: [] }   — direct references

const { order, defs, missing } = typeClosure([def], registry, (name) => fetched[name]);
const scope = registry.scope();
for (const name of order) scope.bind(name, scope.parse(defs.get(name)!));   // dependencies first
const type = scope.parse(def);
```

On a live type, `type.references()` and `type.closure(scope = type.scope)` do the
same over `type.toDefinitionJSON()` — so a registered named type the type reaches
is reported as a reference, and its definition is resolved through the scope.

What counts:

- **References**: any name that is not a built-in class, in a type position
  (a bare or use-site name, `extends`, `satisfies`), anywhere in the def — field
  types, generic arguments, `options` child defs (`tuple`, `or`, `and`, `not`),
  `get` / `call` / `init` signatures, and types inside expressions (`new`,
  `lambda`, `define`, `native`, a call step's `generic`, a `typ` value).
- **Not references**: built-in class names; type parameters a fn or an extension
  declares (also inside their own constraints, so `R: R` is fine); a call's
  `types` aliases; names the def defines inline (`{name, extends, …}`), which are
  reported in `defines` instead; enum / literal constants and `new` payload keys.
- `typeClosure` follows each reference through the resolver. `order` lists the
  resolved names dependencies-first (a cycle keeps first-seen order — gin
  resolves the forward reference lazily); `missing` is what the resolver did not
  know.

Two `TypeClass` flags drive the walk without inspecting class names:
`declaresGenerics` (set on `fn`) and `valuesAreTypes` (set on `typ`).
`registry.typeClass(name)` returns the class registered under a name.

## The `TypeDef` wire format, and strict parsing

A serialized type is a `TypeDef`, and gin reads exactly eleven keys off it:

`name`, `docs`, `extends`, `satisfies`, `generic`, `options`, `init`, `props`,
`get`, `call`, `constraint`.

Three of those are slots with per-class contents, and putting a value in the
wrong one is the mistake that used to be expensive:

| Slot | Holds | Per class |
|---|---|---|
| `generic` | **type arguments**, by parameter name | `list`→`V`; `map`→`K`,`V`; `optional`/`nullable`/`literal`/`typ`→`T`; `enum`→`V`; `function` declares its own |
| `options` | **scalar constraints / payloads** | `num`→`min`,`max`,`whole`,`minPrecision`,`maxPrecision`,`prefix`,`suffix`; `text`→`minLength`,`maxLength`,`pattern`,`flags`; `bool`→`trueText`,`falseText`; `list`→`minLength`,`maxLength`; `color`→`hasAlpha`; `date`→`min`,`max`,`utc`; `timestamp`→ those plus `precision`; `tuple`→`elements`; `or`/`and`→`types`; `enum`→`values`; `literal`→`value`; `not`→`excluded`. Every other class takes none. |
| `props`/`get`/`call`/`init` | **surfaces** | `obj` consumes `props`; `interface` consumes `props`/`get`/`call`; `function` consumes `call`. On any other class these wrap the type in an Extension. |

**`parse` refuses any key outside those sets.** Every slot has a silent default
— a `list` with no `generic.V` is `list<any>`, a missing `options` is `{}` — so
a mis-keyed def used to parse to something plausible and wrong:

```ts
r.parse({ name: 'list', options: { item: userType } });      // was: list<any>, no error
r.parse({ name: 'text', options: { values: ['a', 'b'] } });  // was: plain text, accepting anything
```

Tolerating those was never forward compatibility. An unknown TOP-LEVEL key is
dropped, so the author's intent vanishes; an unknown `options` key is *kept*
through `toJSON` while constraining nothing, so the declaration reads back
correct and lies for as long as it exists. Both are errors now, and the error is
written to be acted on — it names the nearest valid key on a typo, points a
misplaced TypeDef at the `generic` parameter it belongs in, and respells a
closed set of constants as the `enum` it should have been:

```
registry.parse: type 'text' has unknown options key 'values' — a closed set of
constants is an `enum` in gin, not an option: {"name":"enum","generic":{"V":
{"name":"text"}},"options":{"values":{"todo":"todo","done":"done"}}}; valid
options for 'text': minLength, maxLength, pattern, flags
```

Two shapes are deliberately NOT key-checked, because their keys are not being
ignored: a def naming a **registered type** resolves to that instance by
identity, and `generic` on an **`extends`** def declares the extension's own
type parameters rather than binding a class's. A type class registered by a
third party via `define(...)` is likewise unchecked until it declares
`optionKeys` / `genericKeys` on its `TypeClass`.

### The nested shapes, and path steps

A `TypeDef` is not the only wire shape gin reads, and since **0.4.0** the same
refusal covers the shapes hanging off it — `props` (each a `PropDef`), `get`, `call`
and `init` — plus the steps of a `get`/`set` path. The identical mistake one
level down had the identical silent fate:

```ts
r.parse({ name: 'fn', call: { args, retruns: { name: 'num' } } });   // was: a fn with NO return type
r.parse({ name: 'obj', props: { a: { typ: { name: 'num' } } } });    // was: a prop with no type
```

| Shape | Keys |
|---|---|
| `PropDef` | `docs`, `type`, `get`, `default`, `set` |
| `GetSetDef` | `docs`, `key`, `value`, `get`, `set`, `loop`, `loopDynamic` |
| `CallDef` | `docs`, `types`, `args`, `returns`, `throws`, `get`, `set` |
| init | `docs`, `args`, `run` |
| path step | one of `{prop}` / `{args, generic?, catch?}` / `{key}` |

A **path step must name exactly ONE form.** The fused spelling below used to
parse as a bare prop read with the arguments dropped, and was then diagnosed as
`method 'announce' needs arguments` — about the arguments supplied in that very
step. It is refused now, with the split spelling written out:

```json
{ "prop": "announce", "args": { "note": … } }
→ gin.parse: path step names 2 forms ('prop' and 'args') —
  each is its own step: [{"prop":"announce"}, {"args":{…}}]
```

A fn's type parameters belong on the TYPE, not on the call (`{name:'fn',
generic:{T:…}, call:{…}}`), and the refusal for `call.generic` says so — that
one was live in gin's own rendering fixture, where it "worked" only because the
unbound `{name:'T'}` in the signature is a universal alias.

Only AUTHORED shapes are checked. Every `Prop.from` / `Call.from` also accepts
the in-memory instance it produced, and those carry gin's own fields by
construction — re-scanning them would spend a key scan per path-walk to police
shapes gin itself built.

## Intersections (`and`)

`and<A, B, …>` accepts a value iff every part accepts it. Because `parse` takes
the **authored** form while `valid` is a predicate over the **runtime** form
(composites hold nested `Value`s), an `and` cannot simply hand the JSON to each
part — it parses through the intersection's *effective* type first and then
checks each part against the resulting runtime value:

| parts | parses through | example |
|---|---|---|
| none | nothing — an empty `and` is universal | `and<>` accepts anything |
| one | that part | `and<num>` ≡ `num` |
| **all objects** | the **merged obj** — every part's declared fields, same-name fields intersected | `and<obj{a: text}, obj{b: num}>` ≡ `obj{a: text, b: num}` and accepts `{a:'x', b:1}` |
| anything else | the FIRST part; the rest act as constraints on the runtime value | `and<num, num{min=3}>` accepts `5`, refuses `1`; `and<list<text>, list<text>{maxLength=2}>` accepts `['a','b']`, refuses three items |

`simplify()` collapses the all-object case to that merged obj; a constraint
intersection has no single-type equivalent and stays an `and`. A part that
refuses the parsed value raises `and.constraint` naming the failing part.

## Generics

A type may declare `generic` parameters; each value is a **constraint**, not a
default. A bare `{ name: 'R' }` is an unresolved placeholder (`AliasType`);
resolution happens when a call site supplies a binding via a path step's
`generic: { R: <TypeDef> }`.

| Constraint | Meaning |
|---|---|
| `R: any` | No constraint. |
| `R: text \| obj` | Bindings must be assignable to the union. |
| `R: <interface>` | Structural constraint. |
| `R: alias('R')` | Self-reference ≈ no constraint. |

Generics appear in function types (`<R>(args): R`), parameterized types
(`list<V>`, `map<K,V>`, `optional<T>`), and methods that introduce their own
parameters (`list.map<R>(fn): list<R>`).

### Specializing a named generic, and reading through one

`extension.specialize({ T: <Type> })` returns the use-site form of a generic —
`HttpResponse<obj{USD: num, EUR: num}>`. The bindings ride a `LocalScope`
layered over the instance's own scope, which is what makes a bound instance
BEHAVE as the bound type rather than merely print like one. **A path read
resolves through that scope**, so a named envelope is usable for the reason it
exists:

```ts
const bound = httpResponse.specialize({ T: rates });
engine.typeOf({ kind: 'get', path: [{ prop: 'res' }, { prop: 'data' }] },
              new Map([['res', bound]]));            // obj{USD: num, EUR: num}
engine.validate({ kind: 'get', path: [{ prop: 'res' }, { prop: 'data' }, { prop: 'USD' }] },
                new Map([['res', bound]]));          // no problems
```

An UNSPECIALIZED generic still reads as its placeholder — the walk reads the
receiver's bindings, it does not guess.

At run time the walk has a second source: a composite's raw holds a `Value` per
slot, each with its own concrete type. **When the declared type has no such
prop, the walk consults the value's own slot** before reporting `no prop 'x' on
type '…'`. A value whose declared type is an unresolved placeholder but whose
raw holds typed cells is not an error — it is a value carrying more information
than its declaration. The declaration always gets first refusal.

**Changed in 0.4.1.** Before, the path walk honoured neither. `res.data`
inferred as `T` (an unresolved `AliasType`), `res.data.USD` as `any`, and
`validate` refused the whole path with `no prop 'USD' on type 'alias'` — while
the type printed its binding correctly and `valid` / `parse` / `encode` all
honoured it.

## Default values (`create`)

`type.create()` is a type's zero value — what `{ kind: 'new', type }` with no
`value` produces. It returns the **runtime** form (composites hold nested
`Value`s), and it honours the type's own constraints:

**`T.parse(T.create())` succeeds for every inhabitable `T`** — a type's
constructor never produces a value its own parser refuses. So
`num{max:-3}.create()` is `-3` (zero clamped into the range, not `0`),
`text{minLength:2}.create()` is two characters, `list{minLength:2}.create()`
has two items, and `and<num, num{min=3}>.create()` is `3`.

`fn` is included (**0.4.2**): `fn.create()` is the ExprDef
`{kind:'new', type: <returns>}` — a body constructing the declared return
type's own zero value, which is both `valid` and runnable. It used to be
`null`, which `fn.valid` rejects, making `fn` the one type whose constructor
produced a value its own predicate refused; that propagated to
`obj{m: fn}.valid(obj.create())` and made `list<fn>.parse([fn.create()])` throw
a *length constraint* error about a one-element list with no bounds declared.

Two limits, both deliberate:

- **Uninhabitable types** — `not<any>`, `and<num, text>` — have no value to
  create, so `parse` refusing their `create()` is the correct answer.
- **No derivable witness** — a `pattern` regex has no general inverse.
  `create()` returns a placeholder of the right JS type there; supply a real
  value yourself.

`parse` accepts a type's own runtime form as well as its authored JSON form, so
`create()` / `random()` output can be fed straight back in (a `map` takes both a
live `Map` and the `[{key, value}]` array).

## Compatibility

`a.compatible(b, opts?, scope?)` answers "is every value of `b` a valid `a`" —
i.e. `b` is assignable to `a`. Convenience wrappers:

- `a.accepts(b)` — strict (same class, structural).
- `a.exact(b)` — strict + no wrapper unwrapping, value-mode off.

`CompatOptions`: `{ strict?, value?, exact? }`.

- **obj**: every required field of `a` must exist on `b` with a compatible type;
  optional `a`-fields may be absent; extra `b`-fields ignored. `opts.exact`
  forces exact field-set match.
- **function**: bivariant on args, covariant on returns (matches TS default).
- **`or` on the RIGHT (0.4.4)**: descended for EVERY `a`, since a union is
  assignable exactly when all of its variants are —
  `a.compatible(or<X, Y>)` is `a.compatible(X) && a.compatible(Y)`.
- **`and` on the RIGHT**: when `a`'s own check does not recognise the
  intersection, it is assignable wherever ONE part is, or wherever its single
  equivalent is (`and<obj{a}, obj{b}>` → `obj{a, b}`). Before, no type — not even
  the same `and` re-parsed from its own JSON — accepted an `and`.

```ts
num.compatible(or<num, num>)    // true   — every value of the union IS a num
num.compatible(or<num, text>)   // false  — the text arm is not
list<num>.compatible(list<or<num, num>>)   // true — nested slots descend too
```

Concrete types implement `compatibleType(other, opts?, scope?)`, the per-class
half of the relation, which is guaranteed never to be handed a union.
`compatible` is the base-class method — call that one from anywhere asking the
semantic question, including from inside a `compatibleType` recursing into a
slot type.

## Value schemas (`toA`)

`type.toA(opts?)` is the `@aeye/schema` (`a`) schema of a **runtime value** of
the type — what a model writes when asked for one (a tool's args, a prompt's
output). It is what models get; render and decode it like any `a` schema.

| Kind | `toA()` |
|---|---|
| `text` / `num` / `bool` / `null` / `void` / `any` | `a.string()` (min/max/pattern+flags) / `a.number()` or `a.int()` (min/max) / `a.boolean()` / `a.null()` / `a.null()` / `a.unknown()` |
| `date` / `timestamp` | a string with gin's prefix / timestamp pattern |
| `duration` / `color` | milliseconds / a 32-bit integer (gin's dump forms) |
| `enum` / `literal` | `a.enum(values)` (number values: a union of literals) / `a.literal(v)` |
| `list<V>` / `tuple` | `a.array(V)` (min/max) / `a.tuple([...])` |
| `map<text, V>` | **`a.record(V)`** in the code shape; the renderer shows a model that can't write open objects `[{key, value}]` pairs and decodes them back |
| `map<K, V>` | `a.array(a.object({ key, value }))` |
| `obj` / `interface` | `a.object(props)` (optional props are optional keys; extra keys pass, `unknownKeys: 'refuse'` closes it) |
| `optional<T>` / `nullable<T>` | `a.optional(T)` / `a.nullable(T)` |
| `or` / `and` / `not` | `a.union` / `a.intersection` (objects merge) / `a.not(excluded)` |
| `typ` | `a.ref('TypeDef')` (narrowed to the fitting branches for `typ<T>`), then the def must parse |
| `fn` | `a.union([a.string(), a.ref('Expr')])`: a function's name or a program |
| a registered named type | `a.ref(name)`, defined once (`type.defineA()`) by the grammar module |

`typ`, `fn` and named types are refs into gin's grammar module (`GinGrammar`),
so a schema that has them is bound with the registry: `ginValue(type, opts?)`
returns it bound (named types also by name, memoized per type until the registry
changes), `ginValueBundle(type)` the bundle to bind yourself, and
`GinGrammar.result(a.object({ args: type.toA() }))` composes it. `toNewA(opts?)`
is the same for the value slot of a `new` (composites take Exprs, a plain field
its value or an Expr, a type with `init` its args). `override: (type) => schema | undefined`
supplies the caller's own schema for the types it names, at any depth (the
harness maps its fn-name texts to a per-prompt codec); `ginValue` doesn't
memoize with it.

| Option | Default | What it does |
|---|---|---|
| `includeDocs` | `'none'` | `'type'` describes each type with its `docs`; `'all'` also describes each field / prop. |
| `scope` | — | Type-name resolution scope, the same `TypeScope` `valid` / `parse` / `compatible` / `props` take. |
| `unknownKeys` | `'strip'` | `'refuse'` rejects a key the type does not declare (a strict object). |
| `override` | — | `(type) => schema | undefined`: the caller's own schema for the types it names. |

Compared with the zod value schema it replaced: `map<text, V>` is a record;
named types are refs (`$defs`), not inlined; a named type's definition always
carries its docs (`includeDocs: 'all'`, since it is shared); a `typ` value with
a key gin doesn't read is refused (zod stripped it before gin parsed the def);
an object passes an undeclared key through by default (gin's `parse` then drops
it), where zod stripped it.

A third-party type class that doesn't override `valueA()` takes any JSON value.

**The zod value schemas are gone.** `toValueSchema`, `toNewSchema`,
`toInstanceSchema`, the classes' static `toSchema` / `toNewSchema` and
`buildZodSchemas` were removed, and gin no longer depends on `zod`. For a
value check that isn't a model (an incoming payload, a settings bag, call
args), parse the bound value schema leniently:

```ts
import { LENIENT } from '@aeye/schema';
const res = ginValue(type, { unknownKeys: 'refuse' }).render(LENIENT).parse(value);
if (!res.ok) res.issues;   // [{ path, codePath, message }], res.message for a model
```

(`argProblems` does exactly this.) The frozen zod path lives on in
`packages/schema/bench/legacy-gin` only as the differential baseline for tests.

**`scope` (0.4.0).** A schema built for a type that NAMES another type is only
as good as the registry that resolved the name. A signature carrying
`{name:'Deployment'}` built where that name is unknown resolves to an unbound
alias, whose schema is any value — so a gate derived from it accepts everything,
silently. Pass the scope that knows the name:

```ts
const session = registry.scope({ Deployment: deploymentType });
ginValue(fnType.call()!.args, { scope: session });   // resolves; nested slots too
```

It rides the options bag rather than a positional argument because a value
schema recurses through slots that already thread `opts` verbatim — so every
nested list element, obj field and map value inherits it.

**`unknownKeys` (0.4.0).** The default lets an undeclared key through, which
is gin's own value semantics: `ObjType.parse` copies the declared fields and
nothing else, `valid` ignores extras, and `obj{a}` is `compatible` with
`obj{a, zz}`. A value carrying more than the type declares IS a value of that
type.

That is wrong at one specific kind of boundary, and it is measurable there: when
the payload was AUTHORED against the declared type — a settings bag, a config
object, an agent-supplied argument — an undeclared key is a typo, and dropping
it means a mis-spelt OPTIONAL knob disappears with no error at any layer. (A
required knob is safe; it fails as missing.)

```ts
ginValue(cfg).render(LENIENT).parse({ type: 'graph', charThreshold: 5000, bogus: 1 });
// → ok; cfg.parse(...) keeps { type: 'graph', charThreshold: 5000 }   `bogus` silently gone

ginValue(cfg, { unknownKeys: 'refuse' }).render(LENIENT).parse({ …, bogus: 1 });
// → issue at path ['bogus']: Unknown field "bogus".
```

So it is the CALLER's choice, per boundary, not gin's — which is the difference
between this and the wire side, where `registry.parse` refuses an unknown key
outright with no opt-out. A def is gin's own format and an ignored key there is
data loss; a value is yours. `'refuse'` reaches every nested object, an
`Extension`'s local props, and a map's `{key, value}` pairs; an
`interface`, which passes width through by default because a contract is
satisfied by a wider value, refuses under it too.

## Extensions — real subtypes

`r.extend(base, local)` (or JSON with `extends`) creates a **named subtype** that
overlays additions on a base. `base` may be a `Type` or a registered type name.

```ts
const Email = r.extend(
  r.text({ pattern: '^[^@]+@[^@]+$', minLength: 3 }),
  {
    name: 'Email',
    docs: 'A text value matching a basic email shape',
    props: { domain: r.method({}, r.text(), 'Email.domain') },
  },
);
r.register(Email);                 // make it lookup-able by name
```

Extensions can add props, override `get`/`call`/`init`, narrow options
(`Email` keeps the tighter pattern), declare their own `generic`, and add a
`constraint` Expr (a runtime predicate checked by `engine.validateValue(v)` with
`this` bound to the value). `Email extends text` is a true subtype.

### A local prop is DATA or SURFACE, and gin knows which

A local prop is **surface** when something else computes it — it has a `get`
expression, or its type is callable (a method carries its body in `get`).
Everything else is **stored data**: a field this type ADDS to its base, which
`parse` fills, `valid` requires, `encode` emits, `create` / `random` populate,
and the value schema (`toA`) demands.

```ts
const W = r.extend(r.obj({}), { name: 'W', props: { id: { type: r.text() } } });
W.parse({ id: 'i' }).encodeLogical();   // { id: 'i' }
W.valid({});                            // false — `id` is required
ginValue(W).render(LENIENT).parse({}).ok;   // false — and AGREES with parse

const Res = r.extend(r.obj({ id: { type: r.text() } }), {
  name: 'Res', props: { url: { type: r.fn({ args: r.obj({}), returns: r.text() }) } },
});
ginValue(Res).render(LENIENT).parse({ id: 'a' }).ok;   // true — a method is not data
Res.toCodeDefinition();                       // still prints `url(): text`
```

Only meaningful over a record-shaped base — an `Extension` over `text` has
nowhere to put an added field and does not try.

**Changed in 0.4.1.** Before, nothing drew the line, so every local prop was
surface to `parse`/`valid`/`encode` and shape to the value schema, and three
surfaces of one type disagreed: the schema told a model to emit `{id}`, `parse`
built that emission into a value with nothing in it (`.raw` was `{}`), and
`valid({})` called the result legal. Reading the prop through the engine
returned `undefined`. Conversely a type whose methods rode local props had a
value schema demanding every method on every value — which no caller can supply.

## Augmentations — gap-filling on existing types

`r.augment(name, { props?, get?, call?, init? })` adds to an **existing** type by
name (built-in or registered). Rules:

- `props` are **merged**; intrinsic names win on conflict (you cannot replace
  `num.add` by augmenting `num`). Repeated `augment` calls accumulate props.
- `get` / `call` / `init` apply **only if the type has none of its own** —
  augmentation fills gaps, never overrides. First-set wins.

```ts
import { Init } from '@aeye/gin';
r.augment('num', {
  props: { clamp01: r.method({}, r.num({ min: 0, max: 1 }), 'num.clamp01') },
  init: new Init({
    args: r.obj({ percent: { type: r.num({ min: 0, max: 100 }) } }),
    run: r.nativeExpr('num.fromPercent'),
  }),
});
```

To genuinely *replace* behavior, use an Extension; augmentations only add.
The augmented surface flows through every consumer: path-walks, static analysis,
and code rendering all see it — and so does the LLM via `buildSchemas`.

**Where it shows up in the print.** `toCodeDefinition()` lists augmented members
in the body of a built-in *and* of a named Extension, after the base's members
and before the Extension's own local ones (`props()`' composition order; a local
member of the same name shadows the augmented one and prints once). An
augmentation registered against the **base's** name stays implicit under the
`extends` clause — the body is always "what this type adds". Fixed in **0.3.13**;
before it, an Extension's augmented members were reachable at run time and absent
from the definition a model reads.

**Augmentation is registry-side surface, never wire shape** — it does not appear
in `toJSON()` and does not enter `toA()` / `toNewA()`. That makes
it the right slot for METHODS on a type whose value contract must stay closed: a
handle that must keep parsing from a bare `{ id }` cannot declare its methods as
local props (those land in the value schema), so it declares them here and they
still print.

## Built-in type catalog

`createRegistry()` registers these classes (`BUILTIN_TYPES`, in order):

`any`, `void`, `null`, `bool`, `num`, `text`, `list`, `map`, `tuple`, `obj`,
`optional`, `nullable`, `not`, `or`, `and`, `enum`, `literal`, `function` (`fn`),
`interface` (`iface`), `typ`, `date`, `timestamp`, `duration`, `color`.

Highlights of their surfaces (see each type's `toCodeDefinition()` for the full
LLM-facing signature):

- **num** — `add/sub/mul/div/mod/pow`, `abs/neg/sign/sqrt`, `min/max/clamp`,
  `floor/ceil/round`, comparisons, predicates, `toText(precision?)`.
- **text** — `length`, `contains/startsWith/endsWith`, `trim*`, `upper/lower`,
  `slice`, `replace`, `split`, `concat`, `repeat`, `indexOf`, `match`, `test`;
  indexed `text[i]` → single-char text.
- **list\<V>** — indexed by `num`; `length`, `at`, `push/pop/shift/unshift`,
  `insert/remove/clear`, `slice/concat/reverse/join`, `map/filter/find/reduce/
  some/every/sort`, `first?`/`last?`. Defines `loop`.
- **map\<K,V>** — indexed by `K`; `size`, `at`, `has`, `delete`, `clear`,
  `keys/values`. Defines `loop`.
- **obj** — `keys/values/entries`, `has`, `eq/neq`, `toText`.
- **optional\<T>** / **nullable\<T>** — `value`, `has()`/`isNull()`, `or(fallback)`, `map`.
- **bool** — boolean algebra; `loopDynamic` (while-loop semantics).
- **date / timestamp / duration / color** — temporal & visual types; `duration`
  and `color` ship with `init` constructors.

## Read next

- [Expressions](./aeye-gin-expressions.md)
- [Registry & Engine](./aeye-gin-registry.md)
- [Codegen & diagnostics](./aeye-gin-codegen.md)
