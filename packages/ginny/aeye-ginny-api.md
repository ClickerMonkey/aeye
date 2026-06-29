# @aeye/ginny — Program Globals, File Shapes & Gotchas

Part of the [@aeye/ginny LLM reference](./aeye-ginny.md).

## Programmatic use (read this first)

`@aeye/ginny` is a **CLI application, not a consumable library**. Its
package `main`/`bin` both point at `dist/index.js`, whose top-level code
runs `main()` (the REPL / one-shot loop). Importing it executes the CLI;
it does not export a stable API surface for embedding.

The source module `src/ai.ts` does export internal bindings (`ai`,
`registry`, `engine`, `store`, `features`, `aiInfo`) but these are
implementation details of the CLI, not a published API. **To build your
own application with the same capabilities, depend on `@aeye/gin`
directly** (the engine, type system, and schema generation) plus
`@aeye/ai` for provider/model orchestration — ginny itself is a thin
layer of tool and prompt definitions over those.

## Built-in program globals

Generated gin programs always have these in scope. The four natives live
under the `fns.*` namespace (wired in `src/ai.ts`, implemented in
`src/natives/*`); saved user functions and vars live at the **top level**.

### `fns.fetch` — typed HTTP

```
fns.fetch<R: any>({
  url: text,
  method?: text,
  headers?: map/obj,
  body?: any,
  convert?: "markdown" | "raw",   // default "markdown"
  output: typ<R>                  // REQUIRED
}): R
```

- `output` is **required** so the generic `R` is always bound at the call
  site (an unbound `R` trips `define.var.type-mismatch`).
- `output: typ<text>` — content mode. `convert: "markdown"` (default)
  renders HTML (with headless-browser SPA support), PDF, DOCX, XLSX as
  markdown and wraps JSON/CSV/source in fenced text. `convert: "raw"`
  returns the literal response body. This already gives you readable text
  — there is no need to write helpers that strip HTML or parse PDFs.
- `output: typ<<obj/list>>` — JSON-API mode. The body is JSON-parsed and
  type-parsed against the type; `convert` is ignored.

### `fns.llm` — LLM with typed output

```
fns.llm<R: any>({ prompt: text, tools?: list<any>, output?: typ<R> }): R
```

- Omit `output` (or pass `text`) for a plain-string reply.
- Pass an `obj` type to use the structured-output channel. Other types
  (enum/num/bool/list/tuple) are auto-wrapped as `{ value }` over the wire
  and unwrapped before parse, so callers see the inner value.
- Bind `R` explicitly via a call-site `generic: { R: ... }` when you want
  the return to read as a specific named type.
- Uses the `GIN_LLM_MODEL` (then `GIN_MODEL`) model selection.

### `fns.log` — runtime narration

```
fns.log({ message: any }): void
```

Prints a runtime message to the user (stderr). For progress narration,
intermediate values, or debug breadcrumbs. Distinct from the program's
return value.

### `fns.ask` — interactive user prompt

```
fns.ask<R: any>({ title: text, details: text, output?: typ<R> }): optional<R>
```

Pauses the program and prompts the human. With `output` set, the
interactive **consumer** (`src/consumer.ts`) walks the user through any
shape — obj fields, list items (add-another loop), map entries, tuples,
enum/or choices, optionals/nullables — re-prompting on parse errors.
**Each (sub)type's `docs` field becomes the user-facing label** (a prop's
`docs` wins over the type's `docs` for that field). Returns `null`
(`optional<R>`) if the user cancels, so a program must handle that branch.

### `vars.*` and saved functions

- `vars.<name>` reads a persisted typed value; assigning via a `set`
  expression writes it back (and the write is persisted after a
  successful `test`).
- Every fn saved via `finish({ saveAs })` (or created by the designer) is
  registered as a **top-level global** under its bare name — call it as
  `<name>({ ...args })`, **not** `fns.<name>`. The `fns` namespace holds
  only the four built-in natives above.

## On-disk file shapes

All three catalogs are CWD-relative. The filename (without `.json`) is the
entry's name.

### `./vars/<name>.json` — a var

A `{ type, value, docs }` triple:

```json
{
  "type":  { "name": "text", "options": { "pattern": "^https?://" } },
  "value": "https://api.example.com",
  "docs":  "production API root"
}
```

### `./types/<Name>.json` — a type

A gin `TypeDef` (serialized type descriptor). For example a `Task` obj
type extends `obj` with props. Inspect any saved type with `get_type`
(architect) — it renders the full `toCodeDefinition()`.

### `./fns/<name>.json` — a function

A `function`-typed `TypeDef` whose **body lives at `call.get`** — gin's
native callable shape. The path walker dispatches invocation, argument
binding, and `recurse` with no ginny-side wrapping. The top-level `docs`
field is the function's description (what `search_fns` surfaces). When the
designer declared `call.types` aliases, they are preserved verbatim so the
saved fn keeps its compact form.

```
{
  "name": "fn",
  "docs": "compute the factorial of n",
  "call": {
    "args":    { "name": "obj", "props": { "n": { "type": { "name": "num" } } } },
    "returns": { "name": "num" },
    "get":     { /* the ExprDef body */ }
  }
}
```

## Worked examples (REPL transcripts)

```
> add 2 and 3
  → simple mode: write → test (SUCCESS: 5) → finish.  5

> compute the factorial of 6
  → find_or_create_functions("factorial") → designer spawns a programmer
    that writes the recursive body → test (720) → finish(saveAs).  720

> fetch the title of example.com
  → fns.fetch(url, output: typ<text>) returns markdown → extract title.

> remember my api base url is https://api.example.com as 'apiBaseUrl'
  → dba creates ./vars/apiBaseUrl.json.

> print my api base url
  → program reads vars.apiBaseUrl.

> define a Task type with title, done, due
  → architect creates ./types/Task.json (obj extension with props).

> add an `assignee` field to Task (optional)
  → edit_type — backwards-compatible widening accepted.
```

## Gotchas

- **`output` is mandatory on `fns.fetch`.** Omitting it leaves `R`
  unbound and downstream type checks fail.
- **Saved fns are top-level, not under `fns.*`.** Call `summarizePage({…})`,
  not `fns.summarizePage({…})`.
- **Catalog search is keyword matching, not semantic/embedding search.**
  Below `GIN_SEARCH_THRESHOLD` (20) entries it returns everything; above,
  it counts literal keyword occurrences. Pick keywords that actually
  appear in names/docs.
- **`finish` can reject a save** even after a passing test: too many
  warnings (`GIN_MAX_WARNINGS`, default 5), any errors, or complexity over
  `GIN_MAX_COMPLEXITY` (default 400). The fix is decomposition into helper
  functions.
- **Edits are one-directional.** `edit_type`/`edit_fn` accept widening
  (and narrowing returns for fns) but reject breaking changes; create a
  new name instead.
- **The deepest programmer (depth 2 of 3) cannot delegate** — it must
  write any needed function inline. `MAX_PROGRAMMER_DEPTH = 3`.
- **Web tools require Tavily.** Without `TAVILY_API_KEY`, `research`,
  `web_search`, and `web_get_page` are not exposed. (Generated programs
  can still fetch + convert content directly via `fns.fetch`.)
- **First run exits without doing work** — it only scaffolds `config.json`
  and `.gitignore`. Re-run after adding credentials.
- **`fns.ask` returns `optional<R>`** — programs must handle the cancel
  (`null`) branch; put `docs` on every field of the output type or the
  user sees raw field names instead of labels.
