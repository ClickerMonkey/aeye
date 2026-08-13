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
(sugar over JSON `parse`). Real signatures:

```ts
r.any(); r.void(); r.null();
r.bool(options?: { trueText?; falseText? });
r.num(options?: { min?; max?; whole?; minPrecision?; maxPrecision?; prefix?; suffix? });
r.text(options?: { minLength?; maxLength?; pattern?; flags? });

r.list<V>(item: Type<V>, options?: { minLength?; maxLength? });   // list<V>
r.map<K,V>(key: Type<K>, value: Type<V>);                          // map<K,V>
r.tuple([Type, Type, ...]);                                        // tuple<...>
r.obj({ name: { type: r.text() }, age: { type: r.optional(r.num()) } }); // optional field = optional<T>


r.optional<T>(inner);   // T or absent
r.nullable<T>(inner);   // T or null
r.not(excluded);
r.or([Type, ...]);      // union
r.and([Type, ...]);     // intersection — see "Intersections (`and`)"
r.enum(values: Record<string, V>, valueType: Type<V>);  // prints `enum<text>{low, medium}`
                                                        // when value === label — see Codegen
r.literal(inner: Type<T>, value: T);

r.date(options?: { min?; max?; utc? });
r.timestamp(options?: { min?; max?; utc?; precision?: 'ms'|'s'|'us' });
r.duration();
r.color(options?: { hasAlpha? });

// function type — NOTE: a single options object, not positional args
r.fn({ args: Type, returns?: Type, throws?: Type, generic?: Record<string,Type>, call?: Expr });

r.iface({ props?, get?, call? });   // structural interface
r.alias(name);                      // bare-name ref / generic placeholder
r.typ(constraint: Type);            // "a type that satisfies <constraint>"

// prop builders (cut boilerplate when defining a type's surface)
r.prop(type: Type, nativeId: string, docs?);
r.method(args: Record<string, Type>, returns: Type, nativeId: string,
         options?: { docs?; generic?: Record<string, Type> });
```

> Gotcha: `r.fn(...)` takes ONE options object (`{ args, returns? }`), and
> `r.method(args, ...)` takes `args` as a plain `Record<string, Type>` (each
> entry becomes an obj field) — not an obj type.

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

## Default values (`create`)

`type.create()` is a type's zero value — what `{ kind: 'new', type }` with no
`value` produces. It returns the **runtime** form (composites hold nested
`Value`s), and it honours the type's own constraints:

**`T.parse(T.create())` succeeds for every inhabitable `T`** — a type's
constructor never produces a value its own parser refuses. So
`num{max:-3}.create()` is `-3` (zero clamped into the range, not `0`),
`text{minLength:2}.create()` is two characters, `list{minLength:2}.create()`
has two items, and `and<num, num{min=3}>.create()` is `3`.

Two limits, both deliberate:

- **Uninhabitable types** — `not<any>`, `and<num, text>` — have no value to
  create, so `parse` refusing their `create()` is the correct answer.
- **No derivable witness** — a `pattern` regex has no general inverse, and a
  `fn` value is a JS function / Expr. `create()` returns a placeholder of the
  right JS type there; supply a real value yourself.

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
