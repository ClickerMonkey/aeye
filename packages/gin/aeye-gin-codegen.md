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
