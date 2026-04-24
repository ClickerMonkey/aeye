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

## First run

```bash
$ cd my-new-project
$ ginny

Created /path/to/my-new-project/config.json
Added config.json to .gitignore

Populate the file before re-running:
  OPENAI_API_KEY / OPENROUTER_API_KEY / AWS_ACCESS_KEY_ID — at least one required
  TAVILY_API_KEY — optional, enables web_search tool
  GIN_PROVIDER — optional, preferred provider (openai | openrouter | aws)
  GIN_MODEL — optional, specific model id
  GIN_SEARCH_THRESHOLD — optional, corpus size below which search returns all (default 20)

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
  ┌─────────────┐ ┌──────────────┐ ┌──────────────┐ ┌──────────┐
  │    type     │ │   function   │ │     vars     │ │   web    │
  │  designer   │ │   designer   │ │    manager   │ │ (search, │
  │             │ │              │ │              │ │   page)  │
  └─────────────┘ └──────┬───────┘ └──────────────┘ └──────────┘
                         │
                         ▼ (recursive spin-up)
                    programmer
```

- **programmer** — writes a gin `ExprDef`, calls `test()` against it,
  and calls `finish()` when a test passes. Has `write / test / finish`
  build tools plus the three find-or-create tools for pulling in
  catalog items.
- **type designer** — searches `./types/*.json` by keyword (top-10
  above a configurable threshold, or all entries below); returns
  existing types or authors new ones.
- **function designer** — same pattern over `./fns/*.json`; can
  recursively spin up the programmer to implement a brand-new function
  body.
- **vars manager** — same pattern over `./vars/*.json` (typed named
  values the user or agent can read/write).

## Persistence

Every catalog entry is one JSON file per name. The filename IS the
identity. All four directories are relative to your current working
directory:

```
./types/Task.json           # the Task type
./fns/factorial.json        # the factorial function
./vars/apiBaseUrl.json      # a persistent var (type + value + docs)
./programs/<slug>.json      # finalized programs from past requests
```

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
descriptor. `./fns/<name>.json` is a `{type, body}` pair where `type`
is a `function` TypeDef and `body` is an `ExprDef`. See the
[gin README](../gin#core-concepts) for what TypeDef and ExprDef look
like.

You can hand-edit any of these between sessions. The next run picks up
your changes. Drop a new file into any of the four directories by hand
and ginny discovers it on the next search.

## Built-in globals

Programs always have access to:

- **`fns.fetch<R = text>({ url, method?, headers?, body?, output?: typ<R> }): R`**
  HTTP fetch. When `output` is a gin Type, the response body is parsed
  through it — type-safe HTTP in one call.

- **`fns.llm<R = text>({ prompt, tools?, output?: typ<R> }): R`**
  LLM invocation. Pass a gin Type as `output` to get structured,
  typed output.

- **`vars.<name>`** — any var you've created or imported.

## The write / test / finish loop

```
> compute the factorial of 6

• (programmer calls find_or_create_functions "factorial function")
• (fn designer spins up new programmer → writes recursive gin program)
• (programmer calls write(program))
• (programmer calls test() → SUCCESS: 720)
• (programmer calls finish())

720
```

The programmer can set `expectError: true` on `test()` to verify a
program raises — useful for "divide 1 by 0 and tell me what happens".

## Configuration

Config values can come from `config.json` in the current working
directory, or from environment variables (env wins on conflict):

| Key | Purpose |
|---|---|
| `OPENAI_API_KEY` | enables OpenAI provider |
| `OPENROUTER_API_KEY` | enables OpenRouter provider |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` / `AWS_REGION` | enables AWS Bedrock |
| `TAVILY_API_KEY` | enables the `web_search` tool |
| `GIN_PROVIDER` | preferred provider (openai \| openrouter \| aws) |
| `GIN_MODEL` | pin a specific model id |
| `GIN_SEARCH_THRESHOLD` | corpus size below which catalog search returns all entries (default 20) |

At least one provider must be configured. Tavily is optional — without
it the programmer still has `web_get_page` (fetch + strip HTML).

## Example sessions

```
> fetch the title of example.com
  → reads web_get_page, extracts <title>, returns the text.

> remember my api base url is https://api.example.com as 'apiBaseUrl'
  → vars manager creates ./vars/apiBaseUrl.json

> print my api base url
  → programmer reads vars.apiBaseUrl, returns the string.

> define a Task type with title, done, due
  → type designer creates ./types/Task.json (extending obj with props).

> create a program that counts done tasks from a list of tasks
  → programmer emits a list.filter + .length program using Task.
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
- the sub-agent orchestration (type / fn / vars designers, programmer)
- the CWD-relative catalog (types / fns / vars / programs directories)
- the REPL and one-shot CLI entry point

If you want to embed the same capabilities in your own application
rather than use a CLI, use `@aeye/gin` directly — everything ginny
does is a thin layer of tool definitions over gin's public API.

## License

GPL-3.0
