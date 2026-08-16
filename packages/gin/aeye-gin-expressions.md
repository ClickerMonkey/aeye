# @aeye/gin — Expressions

A gin program is a tree of `ExprDef` JSON objects. Every node has `kind: '...'`
plus that kind's fields, and an optional `comment` string. Twelve kinds total.
Parse JSON into a runtime `Expr` with `registry.parseExpr(def, scope?)`; the
inverse is `expr.toJSON()`. See [overview](./aeye-gin.md).

## `new` — construct a value

```json
{ "kind": "new", "type": <TypeDef>, "value": <raw or init-args> }
```

- If the type has `init`, `value` is parsed as `init.args` and the constructor
  runs.
- Otherwise `value` is parsed against `type` directly.
- With no `value`, returns the type's default (`type.create()`).

```json
{ "kind": "new", "type": { "name": "num" }, "value": 2 }
{ "kind": "new", "type": { "name": "list", "generic": { "V": { "name": "num" } } },
  "value": [ {"kind":"new","type":{"name":"num"},"value":1} ] }
```

### An embedded Expr fills any slot, at any depth

The payload is shaped by the type: an `obj` takes a field map, a `list` an
element array, a `map` an entry array, a `tuple` a positional array. **Any slot
may hold an `ExprDef` instead of a literal, and it is evaluated at construction
time** — mixing static and computed parts freely, and recursively:

```json
{ "kind": "new",
  "type": { "name": "list", "generic": { "V": { "name": "HttpHeader" } } },
  "value": [ { "key": "Authorization",
               "value": { "kind": "template", "template": "Bearer ${key}" } } ] }
```

Slots evaluate **sequentially, in authored order** — a slot's Expr may carry
`STATE` effects, so the payload's meaning does not depend on scheduling.

**Changed in 0.4.1.** Before, only an `obj`'s OWN fields were filled, one level.
An Expr inside a list element, a map key or value, a tuple position or a NESTED
obj was handed to `Type.parse` as data, and met one of two fates: a strict slot
type threw at run (`text.parse: expected string, got object`), and a
**permissive one — `any`, or anything extending it — accepted the raw
`{"kind":"get",…}` node AS THE VALUE.** A program reading a credential into a
`list<any>` param shipped the expression instead of what it evaluates to. Both
are fixed by one shared, type-driven traversal (`Type.forEachNewSlot` /
`Type.newFill`), which `newEffects`, `newComplexity` and `validate` also run on
— so the analyses and the evaluator can no longer disagree about what a payload
contains.

### `validate` walks the payload

`engine.validate` reports an unresolvable variable anywhere inside a `new`
payload, and an `new.slot.type` error where a slot's Expr produces a type the
slot's declared type cannot accept:

```
new.slot.type — this slot is declared `text` but the expression here produces `num`
```

A genuine subtype is accepted (a `Dog` in a `list<Animal>`), and a permissive
slot stays quiet — nothing is known there to contradict.

**Changed in 0.4.1.** Before, `validate` did not look inside a `new` at all:
`new obj{a: <get missing>}` reported nothing and then threw at run. Every read
an authoring agent writes lives inside some `new`, so this was the difference
between an actionable refusal and a run-time surprise.

### An expression is not a value envelope

`{"kind":"new", "type":…, "value":…}` and a `JSONValue` envelope
(`{"type":…, "value":…}`) are the same JSON shape but different things. A
`Type.parse` outside a program has no engine and cannot evaluate one, so since
0.4.1 it says so rather than reading the node as a literal of whatever type it
names:

```
registry.parseValue: this node is an EXPRESSION (kind:'new'), not a value envelope
  — an Expr only evaluates inside a program (`Engine.run`/`Engine.evaluate`); a
  bare `parse` takes data. Drop the `kind` to mean the literal {"name":"num"} value.
```

## `get` — read through a path

```json
{ "kind": "get", "path": [<step>, <step>, ...] }
```

Steps walk left-to-right; the result is the final step's value. Step grammar:

- `{ "prop": "name" }` — named access. **The first step is always a scope
  variable name.** Later steps read props/methods of the previous value.
- `{ "args": { ...argName: <Expr> }, "generic"?: {...}, "catch"?: <Expr> }` —
  call the previous step (a method or any callable). Args are evaluated in the
  caller scope and bound as `args` inside the call body. Optional `generic` binds
  type parameters; optional `catch` handles a throw (thrown value bound as `error`).
- `{ "key": <Expr> }` — indexed `[key]` access for types with a `get` surface.

A method call is two steps: `{ prop: 'add' }` then `{ args: { other: ... } }`.

**A step names exactly one of the three forms.** Fusing them —
`{ "prop": "announce", "args": {…} }` — is refused since **0.4.0**; before that
gin took the prop and dropped the arguments, then reported `method 'announce'
needs arguments` about the arguments three lines above it. A step carrying a key
outside its form, or none of the three selecting keys, is refused the same way
with the nearest one named.

## `set` — write through a path

```json
{ "kind": "set", "path": [<step>, ...], "value": <Expr> }
```

Same path grammar as `get`, but the tail writes. Effect category: `STATE`.

## `define` — bind locals into a child scope

```json
{ "kind": "define",
  "vars": [{ "name": "x", "type"?: <TypeDef>, "value": <Expr> }, ...],
  "body": <Expr> }
```

Each var is added to scope **before** the next var's value is evaluated (later
vars can reference earlier ones). The body runs with all vars in scope; its value
is the define's value. `type` is optional; when present the value must be
compatible with it (validation reports a problem otherwise).

## `block` — sequence

```json
{ "kind": "block", "lines": [<Expr>, ...] }
```

Lines run in order for their side effects; the block's value is the **last**
line's value. An empty block returns void.

## `if` — conditional branching

```json
{ "kind": "if",
  "ifs": [{ "condition": <Expr bool>, "body": <Expr> }, ...],
  "else"?: <Expr> }
```

Conditions must be `bool`. First true branch wins. No-match without `else`
returns void.

## `switch` — value branching

```json
{ "kind": "switch", "value": <Expr>,
  "cases": [{ "equals": [<Expr>, ...], "body": <Expr> }],
  "else"?: <Expr> }
```

A case wins if `value` equals **any** of its `equals` entries. No fall-through.

## `loop` — iterate any iterable

```json
{ "kind": "loop", "over": <Expr>, "body": <Expr>,
  "key"?: "k", "value"?: "v", "parallel"?: { "concurrent"?: num, "rate"?: num } }
```

Two modes, selected by `over`'s static type:

- **Iterable** (the type defines `get().loop`) — walked once; `key`/`value` bind
  into scope (default names overridable).
- **Dynamic / while** (`get().loopDynamic === true`, e.g. `bool`) — `over` is
  **re-evaluated each iteration**; the loop runs while truthy.

Optional `parallel` fans body execution out: `concurrent` caps simultaneous
bodies, `rate` paces start times. With dynamic mode, `over` is re-evaluated each
time a task **completes**.

> Gotcha: a `loop` whose body has no effects (`effects() === NONE`) is flagged a
> no-op by static analysis — loops discard their body's value.

## `lambda` — callable closure

```json
{ "kind": "lambda", "type": <fn TypeDef>, "body": <Expr>, "constraint"?: <Expr> }
```

Inside the body, `args` is the call-site arguments obj and `recurse` is this
lambda (for self-calls). Optional `constraint` runs before the body each call and
must return `bool` (throws on false). A `flow: 'return'` inside the body unwinds
to the lambda boundary.

## `template` — string interpolation

```json
{ "kind": "template", "template": "Hello {name}!", "params": <Expr returning obj> }
```

Each `{name}` placeholder is replaced with the stringified `params.name`.

## `flow` — non-local control flow

```json
{ "kind": "flow", "action": "break"|"continue"|"return"|"exit"|"throw",
  "value"?: <Expr>, "error"?: <Expr> }
```

| Action | Effect |
|---|---|
| `break` / `continue` | Valid only inside a `loop`. |
| `return` | Unwinds to the enclosing lambda / fn body; `value` is the result. |
| `exit` | Unwinds all the way to `engine.run`; `value` becomes the program result. |
| `throw` | Raises `error`; caught by a call step's `catch` handler. |

Validation reports out-of-place flow (`break` outside a loop, `return` outside a
lambda) via the `ValidateContext` carried through the walk.

## `native` — escape hatch to a JS impl

```json
{ "kind": "native", "id": "my.native.id", "type"?: <TypeDef> }
```

Calls a function registered via `registry.setNative(id, impl)`. Most natives are
referenced **indirectly** — e.g. `num.add`'s prop carries `nativeExpr('num.add')`
as its `get`, so a `.add` path call dispatches without any explicit `native` node.
You hand-write a `native` node only when authoring a custom method/loop impl.
Helper: `registry.nativeExpr(id)` builds a parsed `NativeExpr`.

## Parsing — two composing levels

1. **JSON → runtime objects.** `registry.parse(typeDef, scope?)` → `Type`;
   `registry.parseExpr(exprDef, scope?)` → `Expr`. Inverse: `type.toJSON()` /
   `expr.toJSON()`. Round-trips losslessly.
2. **Runtime data → typed values.** `type.parse(jsonData, scope?)` validates data
   and returns a `Value<T>`. `value.encode()` / `value.toJSON()` go back to JSON.

Both levels are scope-aware: generic placeholders (`AliasType`) resolve through
the `TypeScope` threaded into parse, so a call step's `generic: { R: <type> }`
flows into the signature without rebuilding the type tree.

## Effects & complexity

Every `Expr` implements `effects(): Effects` and `complexity(): number`.

- `Effects` is a bitset: `NONE`, `STATE`, `SYSTEM`, `EXTERNAL` (exported as
  `Effects`; combine with `combineEffects`, test with `hasEffects`, label with
  `formatEffects`). `set` and `flow` are `STATE`; container exprs OR their
  children; `lambda` is `NONE` (declaring a closure has no effect until called).
- `complexity()` is a "how hard to author/test" proxy used to cap program size
  (loops add a flat penalty, lambdas a base cost, helper-fn calls cost ~1 + args).

## Adding a custom expression kind

Subclass `Expr` with `static KIND` and `static from(json, scope)`, implement the
abstract methods (`evaluate`, `typeOf`, `validateWalk`, `toJSON`, `clone`,
`effects`, `complexity`, `toSchema`), then `registry.defineExpr(YourExpr)`. The 12
built-ins cover essentially all program authoring; you rarely need this.

## Read next

- [Type system](./aeye-gin-types.md)
- [Registry & Engine](./aeye-gin-registry.md)
- [Codegen & diagnostics](./aeye-gin-codegen.md)
