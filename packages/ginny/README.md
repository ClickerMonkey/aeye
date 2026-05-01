# ginny

> A CLI that turns natural-language requests into executable
> [gin](../gin) programs. Types, functions, and vars accumulate across
> sessions as JSON on disk — the LLM builds a living catalog of
> reusable code that grows with your project.

```bash
npm install -g @aeye/ginny
cd my-project
ginny                       # opens an interactive REPL
ginny "add 2 and 3"         # one-shot
```

## What ginny does

You describe what you want. A **programmer** sub-agent writes a gin
program to do it, tests it against sample inputs, and returns the
result. If it needs types, reusable functions, or named vars, it asks
specialist sub-agents that search the local catalog and create new
entries when nothing matches.

Everything is typed end-to-end. Every write/test/finish cycle happens
inside gin's type system — the agent can't produce invalid expressions,
and the structured output you get back carries full type information.

For complex requests (multiple types and functions, ambiguous scope,
"build me a small system…") the programmer pauses to ask clarifying
questions, writes a plan listing the types/fns/vars it intends to
create, and waits for your approval before any code is written. Simple
requests like "add 2 and 3" skip the dance.

## First run

```bash
$ cd my-new-project
$ ginny

Created /path/to/my-new-project/config.json
Added config.json + ginny.log to .gitignore

Populate the file before re-running:
  At least one AI provider:
    - OPENAI_API_KEY (openai)
    - OPENROUTER_API_KEY (openrouter)
    - AWS Bedrock — any valid AWS credential source works (env vars,
      `aws sso login`, IAM role, ~/.aws/credentials, etc.). Ginny
      probes the credential chain at startup; AWS_REGION optional.
  TAVILY_API_KEY — optional, enables web_search tool
  GIN_PROVIDER — optional, preferred provider (openai | openrouter | aws)
  GIN_MODEL — optional, specific model id
  GIN_SEARCH_THRESHOLD — optional, corpus size below which search returns all (default 20)
  GIN_TOOL_ITERATIONS — optional, max tool-call iterations per prompt run (default 100)

Environment variables still win over config.json values.
```

Edit `config.json`, set at least one provider key, and re-run:

```json
{
  "OPENAI_API_KEY": "sk-...",
  "GIN_PROVIDER": "openai",
  "GIN_MODEL": "gpt-4o-mini",
  "TAVILY_API_KEY": "tvly-..."
}
```

## Architecture

ginny is a small council of sub-agents, each specialized:

```
                          ┌─────────────┐
       user request  ──▶  │  programmer │
                          └──────┬──────┘
         ┌────────────────┬──────┴──────┬────────────────┐
         ▼                ▼             ▼                ▼
  ┌─────────────┐ ┌──────────────┐ ┌──────────────┐ ┌──────────────┐
  │  architect  │ │   designer   │ │     dba      │ │  researcher  │
  │   (types)   │ │    (fns)     │ │    (vars)    │ │  (web search │
  │             │ │              │ │              │ │   + pages)   │
  └─────────────┘ └──────┬───────┘ └──────────────┘ └──────────────┘
                         │
                         ▼ (recursive spin-up)
                    programmer
```

- **programmer** — writes a gin `ExprDef`, calls `test()` against it,
  and `finish()` when a test passes. Has the build tools
  (`write` / `test` / `finish`), the find-or-create tools for pulling
  in catalog items, an `edit_type` tool for backwards-compatible type
  edits, and a `research` tool for factual lookups.
- **architect** — searches `./types/*.json` by keyword (top-N when the
  catalog grows past the threshold, or all entries below); returns
  existing types or designs new ones.
- **designer** — same pattern over `./fns/*.json`. Has both
  `create_new_fn` (new function from scratch — recursively spawns a
  programmer to author the body) and `edit_fn` (backwards-compatible
  signature change + fresh body). The compat checker accepts widening
  edits and rejects breaking ones.
- **dba** — same pattern over `./vars/*.json` (typed named values the
  user or agent can read/write).
- **researcher** — wraps `web_search` + `web_get_page`; answers a
  natural-language question iteratively and returns
  `{ answer, sources }`.

## Persistence

Every catalog entry is one JSON file per name. The filename IS the
identity. The three directories are relative to your current working
directory:

```
./types/Task.json           # the Task type
./fns/factorial.json        # the factorial function
./vars/apiBaseUrl.json      # a persistent var (type + value + docs)
```

You can hand-edit any of these between sessions. The next run picks up
your changes. Drop a new file into any of the three directories by
hand and ginny discovers it on the next search.

### Example: `./vars/apiBaseUrl.json`

A var is a `{type, value, docs}` triple — the simplest on-disk shape:

```json
{
  "type":  { "name": "text", "options": { "pattern": "^https?://" } },
  "value": "https://api.example.com",
  "docs":  "production API root"
}
```

Loaded at use time, `vars.apiBaseUrl` shows up in scope as a typed
`text` value that any program can read.

### Types and functions

`./types/<Name>.json` is a `TypeDef` — gin's serialized type
descriptor. `./fns/<name>.json` is a `function`-typed `TypeDef` whose
body lives at `call.get` (gin's native callable shape — see
[gin/src/path.ts](../gin/src/path.ts) for how the path walker
dispatches). The top-level `docs` field is the function's description.

See the [gin README](../gin#core-concepts) for what TypeDef and ExprDef
look like.

## Built-in globals

Programs always have access to:

- **`fns.fetch<R: any>({ url, method?, headers?, body?, output?: typ<R> }): R`**
  HTTP fetch. When `output` is a gin Type, the response body is parsed
  through it — type-safe HTTP in one call.

- **`fns.llm<R: text | obj>({ prompt, tools?, output?: typ<R> }): R`**
  LLM invocation. Pass a gin Type as `output` to get structured, typed
  output. The `<R: text | obj>` constraint says R must be either a
  text-shaped reply or an obj-shaped structured output — chosen at the
  call site.

- **`fns.log({ message: any }): void`**
  Print a runtime message to the user (stderr). Use for progress
  narration, intermediate values, or debug breadcrumbs. Distinct from
  the program's return value.

- **`fns.ask<R: any>({ title: text, details: text, output?: typ<R> }): optional<R>`**
  Pause the program and prompt the user. With `output` set the
  consumer walks the user through any complex shape (obj fields, list
  items, choices, optionals) — every (sub)type's `docs` field becomes
  the user-facing label. Returns `null` (`optional<R>`) if the user
  cancels, so the program must handle that branch explicitly.

- **`vars.<name>`** — any var you've created or imported.

### Generics are constraints, not defaults

`<R: text | obj>` declares the constraint a binding for R must
satisfy. The model picks a concrete R at the call site (via the
CallStep's `generic: { R: <type> }` map); there's no implicit default.
Bindings that don't satisfy the constraint are rejected at call time.

## The write / test / finish loop

```
> compute the factorial of 6

• (programmer calls find_or_create_functions "factorial function")
• (designer spins up a fresh programmer → writes the recursive gin program)
• (programmer calls write(program))
• (programmer calls test() → SUCCESS: 720)
• (programmer calls finish())

720
```

`test()` runs the draft program against sample args. The programmer
can set `expectError: true` to verify a program raises — useful for
"divide 1 by 0 and tell me what happens".

`finish()` accepts an optional `saveAs: '<camelCaseName>'` to persist
the program as a reusable function — every saved fn becomes a
callable global, so subsequent runs can invoke it directly.

## Editing existing types and functions

Two tools cover backwards-compatible edits:

- **`edit_type({ name, def })`** (programmer) — replace a saved type's
  definition. Allowed: add OPTIONAL fields, widen existing field
  types, loosen constraints. Rejected: remove fields, add required
  fields, narrow field types, change the type class.
- **`edit_fn({ name, args, returns, body })`** (designer) — change a
  saved function's signature and body. Args may add optional params
  or widen existing param types; returns may NARROW. The body is
  rewritten from scratch by an inner programmer.

Both tools enforce backwards-compat at parse time and reject breaking
changes with a structured error. If a change is genuinely incompatible
the right move is usually to create a new type / fn under a different
name so existing callers keep working.

## Configuration

Config values can come from `config.json` in the current working
directory, or from environment variables (env wins on conflict):

| Key | Purpose |
|---|---|
| `OPENAI_API_KEY` | enables OpenAI provider |
| `OPENROUTER_API_KEY` | enables OpenRouter provider |
| `AWS_REGION` | region for AWS Bedrock (default `us-east-1`) |
| `TAVILY_API_KEY` | enables the `web_search` tool |
| `GIN_PROVIDER` | preferred provider (openai \| openrouter \| aws) |
| `GIN_MODEL` | pin a specific model id (fallback for any sub-agent without an override) |
| `GIN_PROGRAMMER_MODEL` | model id for the programmer sub-agent |
| `GIN_DESIGNER_MODEL` | model id for the designer (fns) sub-agent |
| `GIN_ARCHITECT_MODEL` | model id for the architect (types) sub-agent |
| `GIN_DBA_MODEL` | model id for the dba (vars) sub-agent |
| `GIN_RESEARCHER_MODEL` | model id for the researcher sub-agent |
| `GIN_LLM_MODEL` | model id for the in-program `fns.llm` calls |
| `GIN_SEARCH_THRESHOLD` | corpus size below which catalog search returns all entries (default 20) |
| `GIN_TOOL_ITERATIONS` | max tool-call iterations per prompt run (default 100) |

### AWS Bedrock

AWS isn't behind a single env var. Ginny probes the AWS SDK's standard
credential chain at startup — if it can call `ListFoundationModels`,
Bedrock is added as a provider. That means **any** of these work
without extra config:

- `aws sso login` (SSO profile active in the current shell)
- `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY` env vars
- IAM role attached to the EC2/ECS/Lambda/etc. instance
- `~/.aws/credentials` with a default profile
- Container credential provider

At startup ginny prints a line like:

```
ginny: providers enabled → openai, aws + web_search (tavily)
       skipped → openrouter (OPENROUTER_API_KEY unset)
```

At least one provider must resolve. Tavily is optional — without it
the programmer still has `web_get_page` (fetch + strip HTML).

## Logging

Each session writes a verbose timeline to `./ginny.log` (truncated on
startup). Tool inputs and outputs, full validation problems, full
zod parse errors, and stack traces all land in the log; the terminal
view stays compact (one line per error, capped at 200–4096 chars
depending on context). When something goes sideways, `ginny.log` is
where to look.

## Example sessions

```
> fetch the title of example.com
  → reads web_get_page, extracts <title>, returns the text.

> remember my api base url is https://api.example.com as 'apiBaseUrl'
  → vars manager creates ./vars/apiBaseUrl.json

> print my api base url
  → programmer reads vars.apiBaseUrl, returns the string.

> define a Task type with title, done, due
  → architect creates ./types/Task.json (extending obj with props).

> create a program that counts done tasks from a list of tasks
  → programmer emits a list.filter + .length program using Task.

> add an `assignee` field to Task (optional)
  → programmer calls edit_type — backwards-compatible widening accepted.
```

## Building from source

```bash
git clone https://github.com/ClickerMonkey/aeye.git
cd aeye
npm install
cd packages/ginny
npm run start              # dev (tsx --conditions=source)
npm run build              # bundled dist/index.js with shebang
```

The production build is a single ESM file with a Node shebang — the
global install (`npm i -g @aeye/ginny`) links `ginny` straight to it.

## How it relates to gin

ginny is an application built on top of [`@aeye/gin`](../gin). gin
provides:

- the type system (`num`, `list<V>`, `typ<T>`, user extensions, ...)
- the expression engine (`engine.run(expr)`)
- the Zod schema generation the LLM uses to author valid programs

ginny provides:

- the AI wiring (provider selection, model override, per-request context)
- the sub-agent orchestration (architect / designer / dba / researcher / programmer)
- the CWD-relative catalog (types / fns / vars directories)
- the REPL and one-shot CLI entry point

If you want to embed the same capabilities in your own application
rather than use a CLI, use `@aeye/gin` directly — everything ginny
does is a thin layer of tool definitions over gin's public API.

## License

GPL-3.0
