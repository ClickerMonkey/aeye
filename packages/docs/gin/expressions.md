# Expressions

A gin program is a tree of `Expr` JSON objects. Every node has `kind: '...'` plus the fields that kind declares. Twelve kinds total — `new`, `get`, `set`, `define`, `block`, `if`, `switch`, `loop`, `lambda`, `template`, `flow`, `native`.

## `new` — construct a value of a given type

```json
{ "kind": "new", "type": <TypeDef>, "value": <raw or args> }
```

If the type has `init`, `value` is parsed as `init.args` and the constructor runs. Otherwise `value` is parsed as `type` directly. With no `value`, returns `Value(type, type.create())` — the type's default.

## `get` — read through a path

```json
{ "kind": "get", "path": [<step>, <step>, ...] }
```

Steps walk left-to-right. Each step is one of:

- `{prop: 'name'}` — named access.
- `{args: {...}}` — call the previous step (used after a method or any callable).
- `{key: <Expr>}` — indexed access.

The first step is always `{prop: '<scopeVar>'}`. Result is the final step's value.

## `set` — write through a path

```json
{ "kind": "set", "path": [<step>, ...], "value": <Expr> }
```

Same path grammar as `get`, but the tail step writes. Returns `bool`: true on success, false if a safe-nav null/undefined short-circuited the walk.

## `define` — bind locals into a child scope

```json
{ "kind": "define", "vars": [{ "name": "x", "type": ..., "value": ... }, ...], "body": <Expr> }
```

Each var is added to scope BEFORE the next var's value is evaluated, so later vars can reference earlier ones. The body runs with all vars in scope; its result is the define's value.

## `block` — sequence of expressions

```json
{ "kind": "block", "lines": [<Expr>, ...] }
```

Lines run in order. Earlier lines are evaluated for their side effects (set, native calls, fns); the block's value is the LAST line's value. An empty block returns void.

## `if` — conditional branching

```json
{ "kind": "if", "ifs": [{ "condition": ..., "body": ... }, ...], "else": <Expr> }
```

Each condition must be `bool`-typed. First branch whose condition is true wins. Without an else, a no-match if-expression returns void.

## `switch` — value-based branching

```json
{ "kind": "switch", "value": <Expr>, "cases": [{ "equals": [<Expr>...], "body": <Expr> }], "else": <Expr> }
```

The case wins if `value` equals ANY one of `equals`. Cases are NOT fall-through; only the matching case's body runs.

## `loop` — iterate any iterable

```json
{ "kind": "loop", "over": <Expr>, "body": <Expr>, "key": "k", "value": "v", "parallel": {...} }
```

Two evaluation modes by `over`'s static type:

- **Iterable** (`get().loop` defined) — walked once. `key` / `value` bind to scope under those names (override defaults via the optional fields).
- **Bool while-loop** (`get().loopDynamic === true`) — `over` is RE-EVALUATED each iteration. The loop continues while truthy and exits the moment it becomes false. `bool` uses this.

Optional `parallel: { concurrent?, rate? }` fans body execution out: `concurrent` caps simultaneous bodies, `rate` paces start times. The native iterator just calls `yield(k, v)`; the parallel orchestration sits in `LoopExpr.evaluate` so every iterable inherits it for free.

Parallel composes with the dynamic mode: `bool over` plus `parallel: { concurrent: 3 }` fans the body out up to 3 in-flight, and `over` is re-evaluated against the outer scope every time a task COMPLETES (not when it starts). Accumulating side effects from the prior batch decide whether more tasks spawn.

## `lambda` — callable closure

```json
{ "kind": "lambda", "type": <fn TypeDef>, "body": <Expr>, "constraint": <Expr> }
```

Inside the body, `args` is the call-site arguments obj and `recurse` is this lambda (for self-calls). Optional `constraint` runs before the body each call (must return `bool`); throws on false.

## `template` — string interpolation

```json
{ "kind": "template", "template": "Hello {name}!", "params": <Expr returning obj> }
```

Each `{name}` placeholder in the string is replaced with the stringified `params.name`. Compiles to a JS template literal in `toCode` rendering when params is a `new obj` literal.

## `flow` — non-local control flow

```json
{ "kind": "flow", "action": "break" | "continue" | "return" | "exit" | "throw", "value": ..., "error": ... }
```

| Action | Effect |
|---|---|
| `break` / `continue` | Only valid inside a `loop`. |
| `return` | Unwinds to the enclosing lambda or fn body; `value` becomes the result. |
| `exit` | Unwinds all the way to `engine.run`; `value` becomes the program result. |
| `throw` | Raises `error`; caught by a path step's `catch:` handler. |

## `native` — escape hatch to a registered native impl

```json
{ "kind": "native", "id": "my.native.id", "type": <TypeDef> }
```

Calls into a JS/TS function registered via `registry.setNative(id, impl)`. Most natives are referenced indirectly — `num.add`'s prop type carries `{kind: 'native', id: 'num.add'}` as its get expression, so a path call to `.add` dispatches without any explicit `native` node in user code. You'd hand-write a `native` node when authoring a custom loop ExprDef or a method whose impl lives outside gin.

## Parsing

gin has TWO levels of parsing — they compose:

1. **JSON → runtime objects.** `registry.parse(typeDef)` turns a `TypeDef` JSON into a `Type` instance; `registry.parseExpr(exprDef, scope?)` turns an `ExprDef` into an `Expr`. Inverse: `type.toJSON()` / `expr.toJSON()`. Round-trips losslessly.
2. **Runtime data → typed values.** Once you have a `Type`, calling `type.parse(jsonData)` validates the data and returns a `Value<T>` — the runtime currency. A `Value` is a `{type, raw}` pair where `raw` is the JS storage shape. `value.toJSON()` produces the JSON shape; `type.encode(value.raw)` does the same at the type level.

Both levels are scope-aware. Generic placeholders (`AliasType`) resolve through the scope passed to parse — that's how a `CallStep`'s `generic: { R: <type> }` map flows into the called signature without rebuilding the type tree.

## Read next

- [Type System](./types.md) — the four surfaces (props / get / call / init), generics, extensions.
- [Registry](./registry.md) — registering types, natives, and ExprClasses.
- [Built-in Types](./built-ins.md) — what every program starts with.
