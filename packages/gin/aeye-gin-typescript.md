# @aeye/gin — Export to runnable TypeScript

`engine.toTypeScript(expr)` compiles a gin expression to TypeScript that does what
`engine.run` does, plus a declaration for every non-native type the code names.
Compile it with `tsc` and run the JavaScript — no gin at run time. Or hand the type
declarations to someone (or a model) who writes TypeScript against them. See
[overview](./aeye-gin.md).

```ts
import { createRegistry, createEngine, joinTypeScript, renderTypeScriptFile, renderTypeScriptTypes } from '@aeye/gin';

const out = engine.toTypeScript(lambdaDef, { name: 'score', export: true });
out.code      // 'export async function score(args: { p: Person }): Promise<number> { … }'
out.types     // Map { 'Person' => '/** … */\nexport type Person = { … };' }
out.helpers   // Map { 'makePerson' => 'export function makePerson(…)', '$listGet' => … }

const all = joinTypeScript([a, b, c]);   // each type / helper once
renderTypeScriptFile(all);               // types + helpers + code: one file for tsc
renderTypeScriptTypes(all);              // the types alone — type-checks on its own
```

| Export | What it does |
|---|---|
| `engine.toTypeScript(expr, options?)` / `toTypeScript(engine, expr, options?)` | One expression → `{ code, types, helpers }`. Throws `TypeScriptExportError` (with `.problems`) listing every construct with no TypeScript form. |
| `joinTypeScript(outputs)` | Merge outputs: code in order, every type and helper once. The same name declared two different ways throws. |
| `renderTypeScriptFile(output)` | Types, then helpers, then code. |
| `renderTypeScriptTypes(output)` | The type declarations alone. |
| `PRELUDE` | The helper sources (see below), keyed by name. |

## What a function looks like

A `lambda` becomes a function of one `args` object — gin's calling convention, kept
1:1, so optional arguments, defaults and generics need no translation:

```ts
export async function total(args: { items: LineItem[]; discount?: number }, ctx: TotalCtx): Promise<number> { … }
```

Any other expression is a program: `function main(ctx)`.

- **`ctx`** carries the free variables the code reads: engine globals
  (`registerGlobal`) and run extras (declare their types with
  `options.scope`, since extras only exist at `run`). Its type — only the variables
  actually read — goes in `types` as `<Name>Ctx`. With none, there is no `ctx`.
- **Methods on a value take one args object too**: `p.greet({ greeting: 'hi' })`.
  A method with no arguments is called `p.fullName()`.
- **`recurse`** is the function's own name.

## Types

Types TypeScript already has are written in place; only named gin types are declared.
Only `type`, never `interface`.

| gin | TypeScript |
|---|---|
| `num`, `duration` (ms), `color` (0xRRGGBBAA) | `number` |
| `text` · `bool` · `void` · `null` · `any` | `string` · `boolean` · `void` · `null` · `any` |
| `date`, `timestamp` | `Date` |
| `list<V>` · `map<K, V>` · `tuple<A, B>` | `V[]` · `Map<K, V>` · `[A, B]` |
| `obj{a: T, b?: U}` | `{ a: T; b?: U }` |
| `optional<T>` · `nullable<T>` | `T \| undefined` · `T \| null` |
| `or<…>` · `and<…>` | union · intersection |
| `enum<text>{low, high}` · `literal` | `"low" \| "high"` · the literal |
| `fn(args): R` | `(args: {…}) => Promise<R>` (see [async](#async)) |
| `not<…>` · `typ<…>` | `unknown` |
| a named type (`Person`, `QueryResult<Row>`) | a `type` declaration in `types`, generics as `<Row = any>` |

A named type's declaration lists what the gin definition shows
(`toCodeDefinition`): data fields, methods as function-typed properties, computed
props as `readonly` properties, a call signature. A named base is an intersection
(`type Derived = Base & { … }`); a scalar extension is an alias (`type Email = string`).
Docs become `/** … */`, and constraints a TypeScript type cannot state become doc
text: `/** gin: num{min=0, whole=true} */ age: number`. A namespaced name
(`fs/Entry`) becomes an identifier (`fs_Entry`).

**Every type the code reaches is declared**, transitively: argument and return types,
`define` annotations, `new` types, and the static type of every receiver a path walks
through — so a file of the declarations is the whole contract.

## Members: what the value carries

A member is a property ON THE VALUE — the compiled code calls `p.fullName()`, it does
not look anything up.

- **Written in gin** (a prop whose `get` is a gin expression): the type gets a
  `makeX(data)` helper that attaches the compiled bodies. A `new Person{…}` in gin
  compiles to `makePerson({…})`; a host builds values the same way. Its parameter is
  `Omit<Person, <the gin-written members>>`, and a derived type's maker calls its
  base's. Method bodies see `this`, `args` and `recurse` only.
- **Host natives** (`r.method(…, 'Customer.upgrade')`): the value must carry them
  — whoever builds a `Customer` attaches `upgrade`.
- **Built-in natives** (`num.add`, `text.split`, `list.map`, …): inline TypeScript
  (`a + b`, `s.split(sep)`), or a prelude helper where the one-liner would differ
  from gin.

## The prelude

Helpers in `PRELUDE` mirror gin natives that have no faithful one-expression form.
Each is plain TypeScript with no import; an output includes only the ones it reaches,
with their dependencies. Examples: `$listGet` (indexing throws out of range, as in
gin), `$numEq` (`num.eq` within `epsilon`), `$mapAsync` / `$filter` / … (callbacks
run one at a time, in order), `$date` / `$duration` / `$color` (UTC dates, ms
durations, packed colors), `$deepEq` (`obj.eq`), `$parallel` (`parallel` loops),
`$Exit` / `$Throw` (flow signals).

`is<T>()` / `as<T>()` compile to a generated structural guard (`$isPerson(v)`, or
`$is_<hash>` for an anonymous type).

## Control flow

gin is expression-oriented, TypeScript is not. An `if` whose branches are plain values
becomes a ternary; one that needs statements becomes an if-chain into a `let`.
`define` becomes `let`; a `block`'s value is its last line. Statements a value needs
are hoisted in front of it, never wrapped in an IIFE, so `break` / `continue` /
`return` keep their meaning. Evaluation order is gin's: when a later argument needs
statements or has effects, everything before it is spilled to a temp first.

| gin | TypeScript |
|---|---|
| `loop` over a list / tuple / text / map / num / obj | `for` loops (an obj loops over its declared fields, like gin) |
| `loop` over a `bool` (while) | `for (…; ; …)` re-reading `over` each round |
| `loop` with `parallel` | `await $parallel(entries, concurrent, rate, async (k, v) => …)` |
| `flow: break` / `continue` / `return` | `break` / `continue` / `return` (`continue` in a parallel body is `return`) |
| `flow: throw` · a call step's `catch` | `throw new $Throw(error)` · `try { … } catch` that handles only `$Throw` |
| `flow: exit` | `throw new $Exit(value)`, caught by the exported function, which returns it |
| `switch` | an `if` chain on `===` |
| `template` | a template literal (a template computed at run time uses `$template`) |
| lambda `constraint` | `if (… !== true) throw new Error('lambda constraint failed: …')` |

## Async

gin evaluation is async — a host native may hit a database. `options.async`:

- **`'always'`** (default): every function is `async`; every call to a function
  value, a host method or a gin-written method is awaited; every function type is
  `(…) => Promise<R>`. Simple, and always correct.
- **`'auto'`**: a function is `async` only when it awaits something. A host native
  is async when its declared effects include `EXTERNAL` or `SYSTEM`; a function value
  of unknown origin is typed `R | Promise<R>` and awaited. Pure code compiles to plain
  synchronous TypeScript (`$map` instead of `await $mapAsync`).

Outputs joined together should use the same mode: a type's declaration depends on it.

## Options

| Option | Default | Effect |
|---|---|---|
| `name` | `'main'` | The function's name. |
| `types` | `'referenced'` | `'none'`: no declarations (the code still names them). |
| `includeComments` | `true` | gin docs as `/** … */`, expression comments as `//`. |
| `prelude` | `'separate'` | `'inline'`: helpers prepended to `code` (then `joinTypeScript` cannot dedupe them). |
| `async` | `'always'` | See [async](#async). |
| `export` | `false` | `export` on the function, the types and the `makeX` helpers. |
| `scope` | `{}` | Types of run extras (free variables that are not engine globals). |

## What is refused

Each is a `TypeScriptExportError` problem rather than a guess:

- Method dispatch on a value whose STATIC type does not have the member (gin
  dispatches on the run-time type; the export reads the static one). Narrow first
  (`as<T>`) or type the variable.
- A custom `loop` / `get` / `set` / `init` / call surface written in gin, a gin
  setter (`set` on a prop), assigning through a method call, `super`.
- Members written in gin on a non-object type, or reading anything but `this` /
  `args` / `recurse` inside one.
- `break` / `return` inside a `parallel` loop body, a parallel while-loop.
- A `native` expression used directly, a host native added to a BUILT-IN type by
  augmentation (a string cannot carry it).

## Testing it

`src/__tests__/typescript-export.test.ts` compiles every output with the TypeScript
compiler (`strict`), runs the JavaScript, and compares the result with `engine.run`
on the same arguments. It also checks that `renderTypeScriptTypes` type-checks alone
and that a hand-written function against those types runs with the exported helpers.

## Read next

- [Overview](./aeye-gin.md)
- [Codegen & diagnostics](./aeye-gin-codegen.md) — gin's own (display-only) render.
