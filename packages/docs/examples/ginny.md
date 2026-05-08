# ginny — Natural-Language → Typed Programs

Ginny is a CLI agent built on `@aeye` that turns natural-language requests into executable [gin](../gin/) programs. Every type, function, and var the LLM creates is persisted as JSON in your project, building a typed catalog that grows with your codebase.

```bash
npm install -g @aeye/ginny
cd my-project
ginny                       # opens an interactive REPL
ginny "add 2 and 3"         # one-shot
```

[View source on GitHub](https://github.com/ClickerMonkey/aeye/tree/main/packages/ginny)

## What it demonstrates

| Feature | How ginny uses it |
|---|---|
| **Multi-provider** | OpenAI + OpenRouter + AWS Bedrock; credentials probed via standard SDK chain (env, `aws sso login`, IAM role, `~/.aws/credentials`). |
| **Sub-agents** | Five specialized agents (programmer / architect / designer / dba / researcher), each with their own toolset. The programmer recursively spins up new programmers when designing fn bodies. |
| **Adaptive tool selection** | Catalog searches use embedding-based filtering when corpus size exceeds a threshold; small catalogs return everything. |
| **Structured output** | Sub-agents produce typed gin `ExprDef` / `TypeDef` JSON via Zod schemas — the LLM literally cannot return invalid expressions. |
| **Strict mode** | Wires in [`strictSupport`](../guides/strict-mode.md) from `@aeye/models` so gpt-4o / claude 4.5+ / gemini 2.0+ get grammar-constrained tool inputs. |
| **Prompt files** | Loads `cletus.md` / `agents.md` / `claude.md` from the working directory as system context. |
| **Context management** | Per-sub-agent context with run-state isolation; usage and cost accumulate across the session. |
| **Hooks** | Provider-level request/response logging with payload-size tracking; AI-level model-selection logging. |

## Architecture

A small council of sub-agents, each with one job:

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

- **programmer** — writes a draft gin program, calls `test()` against sample args, calls `finish()` when a test passes. Uses `find_or_create_*` tools to pull in catalog entries; uses `edit_type` / `edit_fn` for backwards-compatible edits.
- **architect / designer / dba** — search-and-create patterns over `./types/*.json`, `./fns/*.json`, `./vars/*.json`.
- **researcher** — wraps `web_search` (Tavily) + `web_get_page`, returns `{ answer, sources }`.

Each sub-agent is an `@aeye` Prompt with its own toolset; when the programmer needs a new function, it asks the designer, which spawns *another* programmer to author the body. Recursion is a first-class workflow primitive.

## Persistence

Catalog entries are one JSON file per name, in three CWD-relative directories:

```
./types/Task.json           # the Task type
./fns/factorial.json        # the factorial function
./vars/apiBaseUrl.json      # a persistent var (type + value + docs)
```

Filenames are identity. You can hand-edit any file between sessions; ginny picks up changes on the next run. Drop a new file in by hand — discovered on next search.

## Key patterns from the source

### AI wiring (`packages/ginny/src/ai.ts`)

Multi-provider setup with `strictSupport` wired in so strict-capable model families auto-engage strict mode:

```typescript
import { models, strictSupport } from '@aeye/models';

const ai = AI.with<Ctx, Meta>()
  .providers(enabledProviders)
  .create({
    defaultContext: { /* ... */ },
    defaultMetadata: { providers: providersMeta },
    models,
    modelOverrides: [...strictSupport],
  })
  .withHooks({
    onModelSelected: async (ctx, request, selected) => {
      logger.log(`model selected: ${selected.model.id}`);
      return selected;
    },
  });
```

### Per-sub-agent model override (`packages/ginny/src/registry.ts`)

Each sub-agent reads its model from a dedicated env var (`GIN_PROGRAMMER_MODEL`, `GIN_DESIGNER_MODEL`, ...) and passes it through metadata. Sub-agents can run on different tiers:

```bash
GIN_PROGRAMMER_MODEL=gpt-5     # heavy lifting
GIN_DBA_MODEL=gpt-4o-mini      # cheap, just file IO
GIN_RESEARCHER_MODEL=...
```

### Strict tool schemas (`packages/gin/src/schemas.ts`)

The build / test / finish loop schemas use `strict: true` because malformed gin expressions are unrecoverable — the agent must produce valid `ExprDef` JSON or fail loudly. With `strictSupport` wired in, selection only considers strict-capable models for these prompts.

## When to look at ginny

- **You're building a sub-agent system.** Ginny's recursive spin-up pattern (programmer asks designer asks programmer) is hard to find documented elsewhere.
- **You want a CWD-relative typed catalog.** The types / fns / vars-as-files pattern is reusable; ginny's catalog code is small.
- **You're integrating gin into your own tool.** Ginny is the reference embedding — everything it does is a thin layer of tool definitions over [`@aeye/gin`](../gin/).
- **You want to see strict mode + multi-provider in production.** The `ai.ts` file is ~330 lines covering provider probing, retry/hook wiring, payload-size logging, and strict-support integration.

## Running from source

```bash
git clone https://github.com/ClickerMonkey/aeye.git
cd aeye
npm install
cd packages/ginny
npm run start              # dev (tsx --conditions=source)
npm run build              # bundled dist/index.js with shebang
```

## Related

- [`@aeye/gin`](../gin/) — the typed-program runtime ginny is built on.
- [Cletus example](./cletus.md) — another full-CLI agent built on `@aeye`, with adaptive tool selection.
- [Strict Mode guide](../guides/strict-mode.md) — what `strictSupport` engages.
