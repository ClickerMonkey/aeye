# Diagnostics

When `engine.validate(expr)` finds a type error, you get a `Problems` list with structural paths like `['vars', 0, 'value', 'ifs', 0, 'condition']`. That's the validator's view. To produce a human-readable error pointing at the offending source line, gin pairs each rendered output with a span list — every character range in the rendered text traces back to the validator path that produced it.

The result: compiler-style underlines, against either gin's TypeScript-flavored display or against the raw JSON program.

## Two render targets

| Target | Builder | What you get |
|---|---|---|
| Display (TS-flavored) | `engine.toCode(expr)` | Compact, readable form. Best for showing problems to humans or in LLM-facing prompts. |
| JSON (raw program) | `engine.toJSONCode(expr)` | The literal `JSON.stringify`-style form. Best when the LLM needs to edit the program tree by character offset. |

Both produce a `Code` instance — `{ text: string, spans: Span[] }` — with spans tying every range back to a path. `formatProblem(code, problem)` and `formatProblems(code, problems)` resolve the path and emit the underlined output.

## `formatProblem` — single problem, terse

```typescript
import { createRegistry, createEngine, formatProblem } from '@aeye/gin';

const r = createRegistry();
const engine = createEngine(r);

const program = {
  kind: 'define',
  vars: [
    { name: 'x', type: { name: 'num' }, value: { kind: 'new', type: { name: 'text' }, value: 'wrong' } },
  ],
  body: { kind: 'get', path: [{ prop: 'x' }] },
};

const problems = engine.validate(r.parseExpr(program));
const code = engine.toCode(r.parseExpr(program));

console.log(formatProblem(code, problems.list[0]));
```

Output:

```text
const x: num = "wrong";
               ^^^^^^^
error: var 'x' value type 'text' not compatible with declared 'num'
```

Single-problem renders default to no section headers and no line numbers — terse, one issue at a time.

## `formatProblems` — multi-problem with sections

```typescript
import { formatProblems } from '@aeye/gin';

console.log(formatProblems(code, problems));
```

Output (with defaults):

```text
── lines 5-7 ───────────────────
  5 │ const x: num = "wrong";
                     ^^^^^^^
                     error: var 'x' value type 'text' not compatible with declared 'num'
  6 │ x;
  7 │ }

── lines 12-14 ──────────────────
 12 │ if (1) {
            ^
            warning: if condition should be bool, got 'num'
 13 │   x;
 14 │ }
```

Sections are contiguous blocks of lines containing one or more problems plus a configurable buffer of surrounding context (default 2 lines). Sections whose context windows overlap are merged so problems near each other share their surrounding code instead of repeating it.

Options:

| Option | Default | Effect |
|---|---|---|
| `contextLines` | `2` | Lines of code shown around each problem. |
| `sectionHeaders` | `true` | Show `── lines N-M ──` separators. |
| `lineNumbers` | `true` | Emit `N │ ` line-number gutter. |
| `color` | `false` | ANSI color codes for terminal output. |
| `maxProblems` | `Infinity` | Cap total problems shown; remainder appended as a count. |

Problems whose path resolves to no span (e.g. validator errors at a node that didn't render visibly) fall through to a plain `<severity>: <message> @ <path>` line appended after the sections.

## JSON-target problem formatting

When the LLM is editing the program as JSON (e.g. `ginny`'s `programmer` sub-agent), point it at JSON output instead:

```typescript
const jsonCode = engine.toJSONCode(r.parseExpr(program));
console.log(formatProblems(jsonCode, problems));
```

Output:

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

Same problem, same path, different render target. Useful for LLM workflows where the agent's wire format IS the JSON — telling it "the error is at character offset 247" is far more actionable than handing it a structural path it has to walk itself.

## Type definitions also have spans

`Type.toCode()` and `Type.toJSONCode()` produce `Code` for type definitions, with spans that match the validator's paths into TypeDef structures. So validation errors against extensions / augmentations / new types format the same way:

```typescript
const customType = r.parseObj({
  name: 'BadType',
  props: {
    age: { type: { name: 'num', options: { min: -1, max: 100 } } },  // negative min
  },
});

const problems = customType.validate();
console.log(formatProblems(customType.toCode(), problems));
```

Output:

```text
type BadType {
  age: num{min=-1, max=100}
              ^^
              error: invalid-option: min cannot be negative for whole-mode num
}
```

This is what powers `ginny`'s `architect` sub-agent — when an LLM proposes a new type with an invalid constraint, the agent gets back a compiler-style error pointing at the offending option, not a structural path it has to interpret.

## A complex example — recursive Fibonacci

A complete program that defines a recursive lambda, computes Fibonacci via memoization, and uses several built-in surfaces. Hand-written here for clarity; in practice these come from an LLM:

```typescript
import { createRegistry, createEngine } from '@aeye/gin';

const r = createRegistry();
const engine = createEngine(r);

// (1) A type for the memo: map<num, num>.
// (2) A lambda fib(n: num): num that closes over `cache`.
// (3) Walk 0..15 and print each (n, fib(n)).

const program = {
  kind: 'define',
  vars: [
    {
      name: 'cache',
      // map<num, num> — keys are inputs, values are computed results.
      value: {
        kind: 'new',
        type: { name: 'map', generic: { K: { name: 'num' }, V: { name: 'num' } } },
      },
    },
    {
      name: 'fib',
      value: {
        kind: 'lambda',
        // (n: num): num
        type: {
          name: 'function',
          options: {
            args: { name: 'obj', props: { n: { type: { name: 'num' } } } },
            returns: { name: 'num' },
          },
        },
        body: {
          kind: 'if',
          ifs: [
            // base case: n < 2 → n
            {
              condition: {
                kind: 'get',
                path: [
                  { prop: 'args' },
                  { prop: 'n' },
                  { prop: 'lt' },
                  { args: { other: { kind: 'new', type: { name: 'num' }, value: 2 } } },
                ],
              },
              body: { kind: 'get', path: [{ prop: 'args' }, { prop: 'n' }] },
            },
            // memo hit: cache.has(n) → cache[n]
            {
              condition: {
                kind: 'get',
                path: [
                  { prop: 'cache' },
                  { prop: 'has' },
                  { args: { key: { kind: 'get', path: [{ prop: 'args' }, { prop: 'n' }] } } },
                ],
              },
              body: {
                kind: 'get',
                path: [
                  { prop: 'cache' },
                  { key: { kind: 'get', path: [{ prop: 'args' }, { prop: 'n' }] } },
                ],
              },
            },
          ],
          // recursive case: result = fib(n-1) + fib(n-2); cache it; return.
          else: {
            kind: 'define',
            vars: [
              {
                name: 'result',
                value: {
                  kind: 'get',
                  path: [
                    { prop: 'recurse' },
                    { args: { n: {
                      kind: 'get',
                      path: [
                        { prop: 'args' }, { prop: 'n' }, { prop: 'sub' },
                        { args: { other: { kind: 'new', type: { name: 'num' }, value: 1 } } },
                      ],
                    } } },
                    { prop: 'add' },
                    { args: { other: {
                      kind: 'get',
                      path: [
                        { prop: 'recurse' },
                        { args: { n: {
                          kind: 'get',
                          path: [
                            { prop: 'args' }, { prop: 'n' }, { prop: 'sub' },
                            { args: { other: { kind: 'new', type: { name: 'num' }, value: 2 } } },
                          ],
                        } } },
                      ],
                    } } },
                  ],
                },
              },
            ],
            body: {
              kind: 'block',
              lines: [
                // cache[n] = result
                {
                  kind: 'set',
                  path: [
                    { prop: 'cache' },
                    { key: { kind: 'get', path: [{ prop: 'args' }, { prop: 'n' }] } },
                  ],
                  value: { kind: 'get', path: [{ prop: 'result' }] },
                },
                // return result
                { kind: 'get', path: [{ prop: 'result' }] },
              ],
            },
          },
        },
      },
    },
  ],
  // body: collect 16 Fibonacci numbers via list.map.
  body: {
    kind: 'get',
    path: [
      // list of 0..15
      { prop: 'list' },  // (would come from a global helper; left as a sketch)
      // .map(n => fib(n))
      { prop: 'map' },
      { args: {
        fn: {
          kind: 'lambda',
          type: { name: 'function', options: {
            args: { name: 'obj', props: { value: { type: { name: 'num' } } } },
            returns: { name: 'num' },
          } },
          body: {
            kind: 'get',
            path: [
              { prop: 'fib' },
              { args: { n: { kind: 'get', path: [{ prop: 'args' }, { prop: 'value' }] } } },
            ],
          },
        },
      } },
    ],
  },
};

const result = await engine.run(r.parseExpr(program));
console.log(result.raw);
// [0, 1, 1, 2, 3, 5, 8, 13, 21, 34, 55, 89, 144, 233, 377, 610]
```

What this exercises:

- **`define` with closure semantics** — `cache` is captured by `fib`'s lambda body. Recursive calls via `recurse` (the lambda's self-reference) hit the same closed-over cache.
- **`if` with multiple branches** — base case, memo hit, recursive fallthrough.
- **`map` with `[key]` get and `set`** — `cache[n]` reads and writes through the map's defined `get` + `set`.
- **Nested `get` paths with multiple `args` steps** — chained method calls on `num` (`.sub(1).add(...)`) reduce to a sequence of path steps.
- **`list.map` with a lambda argument** — passing a callable into a method whose generic `R` resolves to `num`.

In a real workflow, `engine.toCode(program)` renders this to compact TypeScript-flavored display, `engine.validate(program)` static-checks it before running, and `formatProblems(engine.toCode(program), problems)` shows compiler-style errors. If the LLM authored a typo (e.g. forgot `recurse`'s args), the path-to-span resolution lands the underline exactly under the offending node rather than a structural breadcrumb.

## Read next

- [Type System](./types.md) — what's being validated.
- [Expressions](./expressions.md) — what nodes the spans point at.
- [Registry](./registry.md) — `engine.toCode` / `engine.toJSONCode` / `engine.validate`.
