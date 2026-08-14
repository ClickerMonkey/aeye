# @aeye/gin — Codegen & diagnostics

gin renders programs and types two ways — TypeScript-flavored display and raw
JSON — and pairs each render with **spans** so validation `Problems` resolve to
compiler-style `^^^` underlines. See [overview](./aeye-gin.md).

## Rendering an expression

| Call | Returns | Use |
|---|---|---|
| `engine.toCode(expr, options?)` | `string` | Compact TS-flavored display. |
| `engine.toGinCode(expr, options?)` | `Code` | TS-flavored display **with spans**. |
| `engine.toJSONCode(expr, indent=2)` | `Code` | The literal JSON program **with spans**. |

`registry.toCode` / `registry.toGinCode` / `registry.toJSONCode` are the same,
without the engine. Types render too: `type.toCode()` → string,
`type.toGinCode()` → `Code`, `type.toJSONCode()` → `Code`, and
`type.toCodeDefinition()` → the full TS-style `type Name { ... }` block (this is
exactly what an LLM sees for each type in its prompt).

> Gotcha: `toCode` is a **string**; only `toGinCode` / `toJSONCode` carry spans.
> `formatProblem`/`formatProblems` need a `Code`, so feed them the latter.

> Rendering is **display-only**. gin has no parser for its printed code — a
> model authors `TypeDef` / `ExprDef` **JSON**, which `registry.parse` /
> `registry.parseExpr` consume. The round trip that matters is
> `registry.parse(type.toJSON())`, not `parse(print(t))`.

## `CodeOptions`

Every `toCode` / `toCodeDefinition` call takes the same options bag:

| Option | Default | Effect |
|---|---|---|
| `indent` | `'  '` | One level of indent. Applies to the definition body, wrapped parameter lists and every wrapped delimited form. |
| `includeComments` | `true` | When false, suppresses `/// docs` lines and inline `/* docs */`. |
| `expectsValue` | `false` | Expr-only — statement vs. value position. |

## `toCodeDefinition` — the layout a model reads

```
/// Everything a person is.
type todo_task extends obj {
  id: text
  title: text
  description?: text
  due_date?: timestamp
  priority?: enum<text>{low, medium, high}
  status?: enum<text>{todo, "in progress", done, blocked}

  /// Update one todo_task row, addressed by id.
  update(
    title?: text
    status?: enum<text>{todo, "in progress", done, blocked}
  ): QueryResult<obj{id: text}>
}
```

Four rules govern it:

**1. The body is line-oriented UNCONDITIONALLY.** One member per line, and a
method's parameters one per line whenever there is more than one — closing paren
on its own line, newline as the separator (no trailing commas). This is *not*
width-triggered: a definition is a declaration, so predictability beats
compactness and the print diffs cleanly when a type gains a field. A lone
parameter stays on the method's line however long it is.

Type **expressions** keep the width-triggered wrap (`joinAuto`), including `obj`
— `obj{id: text}` stays compact, and a long one breaks across lines.

**2. `extends <base>` names the base; it never inlines its structure.** The
clause is kept because inheritance is information — `obj` carries props the
extending type will never list. But an **anonymous** base (`obj`, `iface`) prints
as its bare class name and its declared members move into the body, ahead of the
type's own members (full order in rule 5). A **named** base prints as its name and
its members stay implicit under it:

```
type Derived extends Base {
  y: num          // Base's `x` is inherited, not re-listed
}
```

Option narrowing is not a member and stays on the clause: `type Email extends
text{pattern="^\\d+$"} {}`.

The hooks are `Type.toCodeRef()` (reference form) and `Type.refProps()` /
`refGet()` / `refCall()` (the members that form elides). A custom type overriding
`toCodeRef` participates automatically — whatever the clause hides, the body
shows.

**3. Docs render as `/// text`** — a doc line, distinct at a glance from an
ordinary `//` comment.

**4. Generic references render their binding.** See below.

**5. The body is everything this type ADDS — including its augmentations.**
Members attached with `registry.augment(<this type's name>, …)` print in the body
of a built-in and of a named Extension alike, between the base's recovered
members and the Extension's own local ones (`props()`' composition order; a local
member of the same name shadows the augmented one and prints once). `get` / `call`
/ `init` follow the same precedence they have at run time — local, then this
type's augmentation, then whatever the `extends` clause elided.

An augmentation registered against the **base's** name is *not* re-listed: it is
reachable under the base's own name, exactly like an inherited prop.

```ts
r.register(r.extend(r.obj({ id: { type: r.text() } }), { name: 'resource' }));
r.augment('resource', { props: { markdown: r.method({}, r.text(), 'resource.markdown') } });
r.lookup('resource')!.toCodeDefinition();
// type resource extends obj {
//   id: text
//   markdown(): text
// }
```

Fixed in **0.3.13** — before it the Extension arm dropped augmented members from
the print, so a type could answer `props()` with methods the definition a model
reads never mentioned. Augmentation remains registry-side surface: it is absent
from `toJSON()` and from `toValueSchema()` / `toNewSchema()`, which is what lets
a closed value contract (a handle parsed from a bare `{ id }`) carry methods at
all.

## Enum shorthand

An enum member whose **value equals its label** prints as the label alone:

```ts
r.enum({ low: 'low', medium: 'medium' }, r.text()).toCode()
// enum<text>{low, medium}

r.enum({ RED: 'red' }, r.text()).toCode()
// enum<text>{RED="red"}          ← they differ, so both halves are kept

r.enum({ 'in progress': 'in progress' }, r.text()).toCode()
// enum<text>{"in progress"}      ← quoted: not a bare identifier
```

`label="value"` is reserved for members where the two actually differ, which is
the only case where the second half carries information. On a realistic type
whose enums are all label-equals-value, this removes ~60% of the enum text.

The collapse is specific to `enum`. `optionsCode` — which renders `num{whole=true,
min=0}` and friends — is untouched: there a key and its value are different
facts, and collapsing them would be a lie.

## Generics at a use site

A named generic renders its **bindings** when it is specialized, and prints bare
when it is not:

```ts
const Row = r.alias('Row');
const QueryResult = r.extend('obj', {
  name: 'QueryResult',
  generic: { Row },
  props: { rows: { type: r.list(Row) } },
});
r.register(QueryResult);

QueryResult.toCode();                                   // 'QueryResult'
QueryResult.toCodeDefinition().split('\n')[0];          // 'type QueryResult<Row> extends obj {'

const bound = QueryResult.specialize({ Row: r.obj({ id: { type: r.text() } }) });
bound.toCode();                                         // 'QueryResult<obj{id: text}>'
```

`specialize(bindings)` returns a **clone** — the registered declaration is never
mutated, and two specializations of one generic coexist. Bindings for names that
are not declared parameters are ignored.

The binding is honoured, not merely printed: the clone carries a `LocalScope`
over its own scope, so the `AliasType` placeholders inside its props / call / get
resolve to the bound type through `valid`, `parse`, `props`, `call` and friends.

A wire reference carrying `generic` specializes too, so this survives JSON:

```ts
r.parse({ name: 'QueryResult', generic: { Row: { name: 'obj', props: { id: { type: { name: 'text' } } } } } })
  .toCode();                                            // 'QueryResult<obj{id: text}>'
```

## The `Code` value

`Code` is `{ text: string, spans: Span[] }`. A `Span` ties a character range
(`start`/`end`) to the validator `path` that produced it (plus optional `expr` /
`type` back-references). Builders exported from the package:

- `plain(text)` — `Code` with no spans.
- `span(inner, { path, expr?, type? })` — wrap with an outer span.
- `code\`...\`` — tagged template that interpolates strings and `Code`s, shifting
  child spans into place.
- `joinCode` / `joinLines` — combine multiple `Code`s.

Useful `Code` methods:
- `code.formatProblem(problem, opts?)` — render one problem, terse.
- `code.formatProblems(problems, opts?)` — render a `Problems` bag with sections.
- `code.spanFor(path)` — the most specific span whose path prefixes `path`.
- `code.toLines()` — split into per-line `Code` with re-anchored spans.
- `code.indent(prefix)` / `code.toString()`.

> `formatProblem` and `formatProblems` are **methods on `Code`**, not free
> functions. Call them as `engine.toGinCode(expr).formatProblems(problems)`.

## Validation → diagnostics

`engine.validate(expr)` returns a `Problems` bag. `Problems` has `.list`
(`Problem[]`), `.hasErrors`, and helpers (`.error`, `.warn`, `.at(...)`). Each
`Problem` is `{ path, code, message, severity: 'error'|'warning'|'info', source? }`
where `path` is the structural location (e.g. `['vars', 0, 'value']`).

```ts
import { createRegistry, createEngine } from '@aeye/gin';
const r = createRegistry();
const engine = createEngine(r);

const program = {
  kind: 'define',
  vars: [
    { name: 'x', type: { name: 'num' },
      value: { kind: 'new', type: { name: 'text' }, value: 'wrong' } },
  ],
  body: { kind: 'get', path: [{ prop: 'x' }] },
};

const expr     = r.parseExpr(program);
const problems = engine.validate(expr);
const code     = engine.toGinCode(expr);     // Code, has spans

console.log(code.formatProblem(problems.list[0]));
```

```text
const x: num = "wrong";
               ^^^^^^^
error: var 'x' value type 'text' not compatible with declared 'num'
```

### `formatProblems` — multi-problem with sections

```ts
console.log(code.formatProblems(problems));
```

Sections are contiguous line blocks containing problems plus a context buffer;
overlapping windows merge. Problems whose path resolves to no span fall through to
a plain `<severity>: <message> @ <path>` line.

`FormatProblemsOptions` (extends `FormatOptions { color?: boolean }`):

| Option | Default | Effect |
|---|---|---|
| `contextLines` | `2` | Lines of context around each problem. |
| `sectionHeaders` | `true` | `── lines N-M ──` separators. |
| `lineNumbers` | `true` | `N │ ` gutter. |
| `color` | `false` | ANSI color codes. |
| `maxProblems` | `Infinity` | Cap shown; remainder appended as a count. |

`formatProblem` defaults to the terse form (no headers, no line numbers, no
context).

## JSON-target diagnostics (for LLM editing)

When the model edits the program *as JSON*, point diagnostics at the JSON render
so the underline lands on the literal characters it wrote:

```ts
const jsonCode = engine.toJSONCode(expr);
console.log(jsonCode.formatProblems(problems));
```

```text
── lines 4-9 ───────────────────
  4 │     "vars": [
  5 │       {
  6 │         "name": "x",
  7 │         "type": { "name": "num" },
  8 │         "value": { "kind": "new", "type": { "name": "text" }, "value": "wrong" }
                        ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
                        error: var 'x' value type 'text' not compatible with declared 'num'
  9 │       }
```

Same problem, same path, different render target.

## Type-definition diagnostics

Types carry spans too, so an invalid type definition formats the same way. Run
`registry.validate(engine)` to sweep every registered/augmented type's surface,
or `type.validate(engine)` for one:

```ts
const problems = customType.validate(engine);
console.log(customType.toGinCode().formatProblems(problems));
```

This powers tools that let an LLM propose new types: an invalid constraint
(e.g. negative `min` on a whole num) is reported with a `^^` pointer at the
offending option rather than a structural breadcrumb.

## Effects (side-effect analysis)

`engine.validate` also surfaces effect-based smells (e.g. a `loop` whose body has
no effects). Each `Expr` reports `effects(): Effects`, a bitset:

```ts
import { Effects, combineEffects, hasEffects, formatEffects } from '@aeye/gin';

Effects.NONE; Effects.STATE; Effects.SYSTEM; Effects.EXTERNAL; // 0, 1, 2, 4
combineEffects(Effects.STATE, Effects.EXTERNAL);  // bitwise OR
hasEffects(e, Effects.SYSTEM);                     // membership test
formatEffects(e);                                  // "STATE|EXTERNAL" | "NONE"
```

`registry.setNative(id, impl, effects)` declares a native's effects so they
propagate up through the call sites that invoke it.

## Schema dumps

The package ships scripts (`npm run dump-schema`, `npm run dump-code`) that emit
the registry's full schema / rendered surface — handy for inspecting exactly what
an LLM sees. Programmatically, `buildSchemas(registry)` (see
[Registry & Engine](./aeye-gin-registry.md#schema-generation-for-llms)) is the
runtime equivalent.

## Read next

- [Overview](./aeye-gin.md)
- [Type system](./aeye-gin-types.md)
- [Expressions](./aeye-gin-expressions.md)
- [Registry & Engine](./aeye-gin-registry.md)
