# @aeye/ginny — LLM Reference (Overview & Index)

> Audience: an LLM (or an agent) that needs to understand, run, or reason
> about `@aeye/ginny`. Everything here is verified against the source in
> `packages/ginny/src`. Do not invent flags, env vars, or APIs beyond
> what these files document.

## What ginny is

`@aeye/ginny` is a **CLI that turns natural-language requests into
executable [gin](../gin) programs**. You type a request in plain English;
ginny writes a gin program (a JSON expression tree) to satisfy it, tests
it against sample inputs, and returns the result. Types, functions, and
vars the agent creates are persisted as JSON files in the current working
directory, so a typed catalog of reusable code grows across sessions.

- Package name: `@aeye/ginny`
- Binary: `ginny` (maps to `dist/index.js`, an ESM file with a Node shebang)
- License: GPL-3.0
- Node engine: `>=18.0.0`
- It is an **application/CLI, not a library** — see
  [aeye-ginny-api.md](./aeye-ginny-api.md) for what that means for
  programmatic use.

## When to use ginny

Use ginny when you want to:

- Generate, test, and persist small typed programs from natural language
  without writing gin `ExprDef` JSON by hand.
- Build a reusable, CWD-local catalog of typed functions / types / vars
  that survives across sessions and is hand-editable.
- Call HTTP APIs with typed response parsing, invoke an LLM with
  structured typed output, or prompt the user interactively — all from
  inside generated programs (`fns.fetch`, `fns.llm`, `fns.ask`).
- Study a reference embedding of `@aeye/gin` + `@aeye/ai`: a recursive
  multi-sub-agent system with strict-mode tool schemas and multi-provider
  model selection.

Do **not** use ginny as an importable library — importing its entry
module runs the CLI. To embed the same capabilities, use `@aeye/gin`
directly.

## Quick start

```bash
npm install -g @aeye/ginny
cd my-project
ginny                       # interactive REPL
ginny "add 2 and 3"         # one-shot (single positional arg)
```

On the **first run in a directory**, ginny scaffolds a `config.json`
template, adds `config.json` and `ginny.log` to `.gitignore`, prints
setup instructions, and exits. Populate at least one provider key and
re-run. Full details: [aeye-ginny-cli.md](./aeye-ginny-cli.md).

## How it works (one-paragraph pipeline)

The REPL/one-shot entry point appends your request to a conversation
history and streams the **programmer** sub-agent. The programmer writes a
gin program via the `write` tool, runs it via `test`, and persists it via
`finish`. When it needs types, reusable functions, or named vars not
already in scope, it delegates to specialist sub-agents — **architect**
(types), **designer** (functions), **dba** (vars), and **researcher**
(web) — each of which searches the on-disk catalog and creates new
entries when nothing matches. The designer authors a new function body by
**recursively spawning another programmer** (bounded to 3 levels deep).
Everything is typed end-to-end inside gin's type system, and structured
outputs are produced through Zod schemas so the model cannot emit invalid
expressions. See [aeye-ginny-architecture.md](./aeye-ginny-architecture.md).

## Relationship to other @aeye packages

- **`@aeye/gin`** — the typed-program runtime ginny builds on: the type
  system, the expression engine (`engine.run`), and the Zod schema
  generation the agents use to author valid programs. ginny is a thin
  layer of tool/prompt definitions over gin's public API.
- **`@aeye/core`** — the prompt / tool / agent primitives (`ai.prompt`,
  `ai.tool`, `Message`, `ToolInterrupt`, prompt-event streaming) that
  every ginny sub-agent is built from.
- **`@aeye/ai`** — the `AI` instance: provider registration, model
  selection, metadata, and hooks.
- **`@aeye/openai`, `@aeye/openrouter`, `@aeye/aws`** — the three
  providers ginny can enable.
- **`@aeye/models`** — the model registry plus `strictSupport`, which
  opts strict-capable model families into grammar-constrained tool inputs.

## Index of detailed docs

| File | Covers |
|---|---|
| [aeye-ginny-cli.md](./aeye-ginny-cli.md) | Running the CLI, REPL vs one-shot, interrupts, first-run scaffold, config.json, all environment variables, persistence/catalog layout, logging, building from source. |
| [aeye-ginny-architecture.md](./aeye-ginny-architecture.md) | The sub-agent council, each agent's tools, the write/test/finish loop, recursive function authoring, depth cap, complexity/warning gates, catalog search behavior. |
| [aeye-ginny-api.md](./aeye-ginny-api.md) | Built-in program globals (`fns.fetch` / `fns.llm` / `fns.log` / `fns.ask`, `vars.*`, saved fns), on-disk JSON shapes, programmatic-use note, gotchas. |

## Source map (for deeper reading)

- `src/index.ts` — CLI entry: REPL loop, one-shot, ESC/Ctrl+C interrupts, startup banner.
- `src/ai.ts` — AI instance, provider probing, hooks, native wiring (`fns.*`).
- `src/config.ts` — `config.json` load/scaffold, `.gitignore` management, env hydration.
- `src/model-selection.ts` — per-sub-agent model resolution, tool-iteration cap.
- `src/store.ts` — CWD-relative catalog read/write/search.
- `src/context.ts` — the `Ctx` shared across sub-agents; `MAX_PROGRAMMER_DEPTH`.
- `src/prompts/*` — the sub-agent definitions (programmer, architect, designer, dba, researcher).
- `src/tools/*` — `write`, `test`, `finish`, `research`, `find-or-create-*`, `edit-type`, `ask`, web tools, etc.
- `src/natives/*` — `fns.fetch`, `fns.llm`, `fns.log`, `fns.ask` implementations.
- `src/consumer.ts` — interactive type-walker behind `fns.ask`.
- `src/progress.ts`, `src/event-display.ts`, `src/logger.ts` — terminal/log output.
