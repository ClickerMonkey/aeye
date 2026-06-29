# @aeye/cletus

**Purpose:** Cletus is an interactive CLI/browser demo application that showcases the `@aeye` AI stack end to end. It is a personal AI assistant with file management, shell execution, a custom data-type system, semantic knowledge base, image generation/analysis, web access, and autonomous multi-step task execution — all driven by an *adaptive tool-selection* engine built on `@aeye/ai`, `@aeye/core`, and the provider packages.

Unlike the other `@aeye/*` packages, Cletus is **an end-user app, not a library**. It is published with a `bin` (`cletus`) and is meant to be installed globally and run, or studied as a reference implementation of how to assemble the `@aeye` primitives into a real product.

```jsonc
// package.json (excerpt)
"name": "@aeye/cletus",
"bin": { "cletus": "dist/index.js" }
```

## When to use it

- You want a working reference for building a multi-toolset agent on `@aeye/ai` (provider setup, model selection by capability/weights, adaptive tool selection via embeddings, operation approval flows, autonomous loops).
- You want to try the `@aeye` stack interactively from a terminal (Ink TUI) or a browser (React + WebSocket UI).
- You are studying how `@aeye/core` `Tool`/`Prompt` components, `@aeye/models`, and the provider packages (`openai`, `openrouter`, `replicate`, `aws`) fit together in a non-trivial app.

It is **not** a dependency you import. Nothing here is a stable public API; treat the source as a demo.

## Run / launch

Cletus requires API keys for at least one AI provider. Embeddings run locally (via `fastembed`, in a worker thread) and need no key.

```bash
# Global install (publishes dist/ + dist-browser/)
npm i -g @aeye/cletus
cletus                       # launch the interactive CLI (Ink TUI)

# From source (monorepo) — packages/cletus/
npm install
npm run build                # esbuild bundles CLI (dist/) + browser app (dist-browser/)
npm link                     # expose `cletus` on PATH
cletus
```

Dev / source-run scripts (no build step; uses `tsx`):

```bash
npm run dev      # tsx watch src/index.tsx   (hot reload)
npm run start    # tsx --conditions=source src/index.tsx
npm run typecheck
npm test         # jest
```

### Command-line flags

Parsed in `src/index.tsx` (`parseArgs`). These are the **only** real flags:

| Flag | Meaning |
|------|---------|
| `--profile=NAME` / `--profile NAME` | Use an isolated config profile. Data is stored under `~/.cletus/profiles/NAME/` instead of `~/.cletus/`. |
| `--browser` | Start the browser server instead of the CLI. |
| `--port=N` / `--port N` | Port for browser mode (default `3000`). |

```bash
cletus --profile work                 # isolated config/chats/data
cletus --browser --port 8080          # browser UI at http://localhost:8080
```

On first run (no `~/.cletus/config.json`) the CLI shows an interactive **init wizard** (`InkInitWizard`) to collect your name/pronouns, providers, and API keys, then writes `~/.cletus/config.json`.

## Two front ends, one engine

Both clients run the **same** agent engine; only the presentation differs. The shared engine is `client`-aware via `CletusContext.client: 'cli' | 'browser'` (`src/ai.ts`), and tools can restrict themselves to one client via metadata `onlyClient`.

- **CLI** (`src/index.tsx` → `components/Ink*.tsx`): React + Ink terminal UI. Views: `loading → init → main menu → chat`. Streams responses, renders markdown, shows operation approval prompts, model selection, the `ask` multiple-choice UI.
- **Browser** (`--browser` → `src/browser/server.ts`): Node `http` server serving the prebuilt SPA from `dist-browser/`, plus a `ws` WebSocket server for all chat traffic. The React app lives in `src/browser/` and adds rich viewers (charts via `echarts`, diagrams via `mermaid`, image preview, KaTeX math, syntax highlighting). See [`aeye-cletus-browser.md`](./aeye-cletus-browser.md).

## How the agent works (high level)

1. **`createCletusAI(configFile, client)`** (`src/ai.ts`) builds an `AI.with<CletusContext, CletusMetadata>()` instance, wiring up only the *enabled* providers from config, the `@aeye/models` registry (+ `strictSupport` overrides, + synthetic "custom" provider models), usage/cost accumulation hooks, and a Handlebars **user prompt** (date, user memories, assistant persona, chat mode, agent mode, todos, custom data types, prompt-file content).
2. **`initTools(ai)`** + **`createToolsets(ai)`** (`src/agents/`) instantiate all toolsets and register every tool's instructions in the global **`ToolRegistry`** (`src/tool-registry.ts`), embedding each tool's instructions for semantic search.
3. **`createChatAgent(ai)`** builds the main `cletus_chat` prompt (`src/agents/chat-agent.ts`). It declares all tools but uses a dynamic **`retool`** callback to expose only the *active* tools per turn — either a manually-selected toolset, or an adaptive top-N selected by cosine similarity between recent user messages and tool-instruction embeddings.
4. **`runChatOrchestrator(...)`** (`src/agents/chat-orchestrator.ts`) drives the autonomous loop: it streams the agent, emits events (`pendingUpdate`, `update`, `complete`, `error`, `usage`, `status`), persists messages, and re-invokes the agent up to `autonomous.maxIterations` / `autonomous.timeout` while todos remain and no approval is pending.
5. **Operations** (`src/operations/*.tsx`) are the side-effecting implementations behind tools. Each tool's `call` does `ctx.ops.handle({ type, input }, ctx)`. The `OperationManager` decides — based on **chat mode** vs the operation's required **mode** — whether to execute immediately or return an *analysis* for user approval.

## Adaptive tooling & toolsets

There are 50+ tools grouped into 8 domain toolsets plus a `utility` set. To avoid overwhelming the model, Cletus exposes only ~14 tools per turn (`config.user.adaptiveTools`, default 14):

- **Adaptive mode (default):** embeds the last few user messages and selects the most semantically similar tools.
- **Specific toolset:** the model (or user) calls `retool` to pin one toolset (`planner`, `librarian`, `clerk`, `secretary`, `architect`, `artist`, `internet`, `dba`).
- **Always-visible** utility tools (`retool`, `about`, `ask`, `hypothetical`, `getOperationOutput`) are present every turn.

Tool/operation names in source are **snake_case** (`file_read`, `web_search`, `todos_add`, `chart_display`); the README's camelCase names (`fileRead`) are friendly aliases, not the wire names. The two exceptions are the utility tools `getOperationOutput`/`about`/`retool`/`hypothetical`/`ask` which are registered as written. Full catalog: [`aeye-cletus-operations.md`](./aeye-cletus-operations.md).

## Documentation index

| File | Covers |
|------|--------|
| [`aeye-cletus-operations.md`](./aeye-cletus-operations.md) | Every toolset and operation (clerk, librarian, dba, architect, artist, internet, planner, secretary, utility), chat modes vs operation modes, the operation/approval lifecycle, and the `@aeye` packages each relies on. |
| [`aeye-cletus-browser.md`](./aeye-cletus-browser.md) | Browser mode: the HTTP + WebSocket server, message protocol, multi-client broadcast, rich viewers, and how it differs from the CLI. |
| [`aeye-cletus-config.md`](./aeye-cletus-config.md) | `~/.cletus/` layout, `config.json` schema, providers, env-var / AWS auto-detection, model selection by use-case, profiles, prompt files, autonomous & reasoning settings. |

## Key `@aeye` dependencies

- **`@aeye/ai`** — `AI.with(...).providers(...).create(...)`; the chat/image/embedding facade, model registry search, hooks, context building. (`src/ai.ts`)
- **`@aeye/core`** — `Tool`/`Prompt`/`Agent` types, `Usage`/`accumulateUsage`, `Message`, `toJSONSchema`, `ToolInterrupt`, `resolveFn`. Used throughout tools and the orchestrator.
- **`@aeye/models`** — the `models` catalog, `strictSupport` overrides, `replicateTransformers`.
- **`@aeye/openai` / `@aeye/openrouter` / `@aeye/replicate` / `@aeye/aws`** — provider implementations, only instantiated when enabled in config. (Note: these are in `devDependencies` because the published bundle is self-contained via esbuild.)

## Gotchas

- **Provider deps are bundled, not runtime deps.** `@aeye/*` packages live in `devDependencies`; the published artifact is the esbuild bundle (`dist/`, `dist-browser/`). Running `dist/index.js` directly works; importing the package as a library does not give you those modules.
- **Embeddings need the local model.** Adaptive tool selection, knowledge search, and data/image indexing all depend on the `fastembed` worker (`src/embed.ts`, `src/embed-worker.ts`). The model is cached under `~/.cletus/local_cache/`; first run downloads it. If embedding fails, adaptive selection falls back to "first N tools."
- **`puppeteer` is optional.** `web_get_page` uses it; it's an `optionalDependency`, so page fetching may be unavailable if it didn't install.
- **Web search needs Tavily.** `web_search` requires `config.tavily.apiKey`.
- **Browser mode binds to `127.0.0.1` only** and serves the *prebuilt* SPA from `dist-browser/` — you must `npm run build` (or install the published package) before `--browser` works. Operations keep running even after a client disconnects.
- **Config concurrency.** `~/.cletus/config.json` and chat files use timestamp-based optimistic locking (`JsonFile`); a "Concurrent update detected" error means another process/profile modified the file.
- **No public API / unstable.** This is a demo; file layout and tool names change between versions.
