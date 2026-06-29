# @aeye/ginny — Architecture: Sub-Agents & the Build Loop

Part of the [@aeye/ginny LLM reference](./aeye-ginny.md).

## The pipeline

```
                          ┌─────────────┐
       user request  ──▶  │  programmer │
                          └──────┬──────┘
         ┌────────────────┬──────┴──────┬────────────────┐
         ▼                ▼             ▼                ▼
  ┌─────────────┐ ┌──────────────┐ ┌──────────────┐ ┌──────────────┐
  │  architect  │ │   designer   │ │     dba      │ │  researcher  │
  │   (types)   │ │    (fns)     │ │    (vars)    │ │  (web)       │
  └─────────────┘ └──────┬───────┘ └──────────────┘ └──────────────┘
                         │
                         ▼ (recursive spin-up)
                    programmer
```

The CLI entry (`src/index.ts`) appends the user's text to a `Message[]`
history and streams the **programmer** prompt (`programmer.get('stream',
…)`). Each `message` event is captured into history so the next REPL turn
has full context. A shared `originalRequest` and a `programmerDepth`
(starting at 0) are threaded down through every recursive sub-agent.

Each sub-agent is an `ai.prompt(...)` (from `@aeye/core` via the
`@aeye/ai` instance in `src/ai.ts`) with its own tool list. Sub-agents
other than the programmer set `excludeMessages: true` — they take their
task through a `{{description}}` / `{{question}}` template variable rather
than inheriting the parent's conversation, which avoids forwarding a
half-finished `tool_calls` assistant message to the provider.

## The five sub-agents and their tools

All tool names below are the literal `name` fields the model sees.

### programmer (`gin_programmer`)

The orchestrator. Writes, tests, and finalizes gin programs; delegates to
the others when it needs catalog items. `dynamic: true`,
`toolIterations` from `GIN_TOOL_ITERATIONS`. Tools:

- `find_or_create_types` → delegates to **architect**
- `find_or_create_functions` → delegates to **designer**
- `find_or_create_vars` → delegates to **dba**
- `research` → delegates to **researcher** (only present when Tavily is configured)
- `write`, `test`, `finish` — the build loop (below)
- `edit_type` — backwards-compatible edit of a saved type
- `search_fns`, `search_vars`, `print_fn` — inspect the catalog (lookups also register a saved fn into the engine so it becomes callable)
- `ask` — prompt the human user

The programmer's system prompt embeds: the full method surface of every
registered type, a names-only preview of the on-disk catalog, and the
signatures of fns already loaded this session. It distinguishes three
response modes — informational answers, simple one-shot computations
(straight to write/test/finish), and complex requests (a
**plan-and-approve** workflow: ask clarifying questions, present a written
plan of types/fns/vars, iterate until the user approves, then implement).

### architect (types)

Designs or picks gin types. Tools: `search_types`, `get_type`, `ask`.
Returns structured `{ use: string[], create: TypeDef[] }`.

### designer (functions)

Finds or authors reusable functions. Tools: `search_fns`, `get_fn`,
`print_fn`, `create_new_fn`, `edit_fn`, `ask`. Returns structured
`{ use: string[], created: string[] }`, and **validates** that every named
fn is actually readable on disk (re-prompts the model if it hallucinates).

- `create_new_fn` — the designer decides the signature (`args`, `returns`,
  optional `types` aliases) and then **recursively spawns a programmer**
  to author the body. Backwards behavior is enforced by the inner
  programmer reaching a passing test and calling `finish({ saveAs })`.
- `edit_fn` — change a saved fn's signature + body. The new signature is
  compat-checked **before** spawning the inner programmer: args may widen
  (add optional params, widen types); returns may **narrow**. Removing
  required args, narrowing arg types, or widening returns is rejected.

### dba (vars)

Curates `vars.*`. Tools: `search_vars`, `get_var`, `create_var`, `ask`.
For credentials/external parameters the user hasn't supplied, it creates
the var with a placeholder value and **setup instructions in the var's
`docs`** rather than halting to ask.

### researcher (web)

Only wired into the programmer when `ctx.features.webSearch` is true
(Tavily configured). Tools: `web_search` (Tavily; `query`, optional
`maxResults` default 5), `web_get_page` (`url`; renders HTML via headless
Puppeteer, parses PDF/DOCX/XLSX to markdown, output capped ~16k chars),
and `ask`. Returns structured `{ answer, sources }`.

## Recursion and the depth cap

Function authoring is recursive: programmer → `find_or_create_functions`
→ designer → `create_new_fn` → a fresh programmer that writes the body.

- `MAX_PROGRAMMER_DEPTH = 3` (in `src/context.ts`).
- `ctx.programmerDepth` increments by 1 on each `create_new_fn` /
  `edit_fn`.
- `find_or_create_functions`, `create_new_fn`, and `edit_fn` set
  `applicable` to require depth `< MAX_PROGRAMMER_DEPTH - 1`. The deepest
  programmer **cannot** delegate further — it must write the function body
  inline.
- When a programmer is authoring a specific fn body, `ctx.targetFn` is set
  (the designer-designed signature). `find_or_create_functions` is
  withheld in that case so the programmer can't respawn a designer for the
  same task and recurse uncontrolled.
- A `programmerChain` records the ancestry so a deep programmer sees which
  caller needs its output and what the original user request was.

## The write / test / finish loop

This is the programmer's core cycle (`src/tools/write.ts`, `test.ts`,
`finish.ts`):

1. **`write({ program: <ExprDef> })`** — stores the draft. It renders the
   program back as TypeScript-like pseudocode (via `toCode`), runs static
   validation, and reports:
   - **ERRORS** (must be fixed before `test`),
   - **WARNINGS** (advisory; too many block `finish`),
   - a **complexity** figure vs the cap (continuous feedback so the model
     decomposes before it's rejected).
   Full problem detail (with underlined spans, in both TS and JSON form)
   goes to `ginny.log` under a grep id; the tool result keeps the compact
   TS form.

2. **`test({ args?, expectError? })`** — runs the draft. When a `targetFn`
   is in scope the draft is wrapped in a lambda and invoked through gin's
   call machinery (so `args` and `recurse` resolve like the saved fn
   will); otherwise it runs via `engine.run`. `args` schema is auto-built
   from the function's args type. Set `expectError: true` to treat a
   runtime error as success (e.g. "divide by zero and tell me what
   happens"). Var mutations from the run are persisted via dirty-tracking.

3. **`finish({ saveAs?, docs? })`** — finalize after a passing test.
   - Without `saveAs`: returns the one-shot result; nothing is persisted.
   - With `saveAs`: re-validates the draft and **rejects the save** if
     warnings exceed `GIN_MAX_WARNINGS` (default 5), if any errors are
     present, or if structural complexity exceeds `GIN_MAX_COMPLEXITY`
     (default 400 — decompose into helper fns to reduce it; each helper
     call costs 1 at the call site regardless of its body size). On
     success it writes `./fns/<saveAs>.json` and registers the fn as a
     callable top-level global.

"Everything is a function": there is no separate programs concept. A
finished one-shot computation is just a `fn() => T` whose `call.get` is
the program body.

## Catalog search behavior

`src/store.ts` implements search per directory. Important and easy to get
wrong: **search is keyword text-match scoring, not embeddings.**

- If a directory has at most `GIN_SEARCH_THRESHOLD` (default 20) entries,
  **or** no keywords are given, search returns all entries (up to the
  limit) with score 0.
- Above the threshold, each entry's searchable text (name, docs,
  `extends`, prop names, etc.) is scored by counting keyword occurrences;
  entries with score 0 are dropped; the top-N (default limit 10) are
  returned.

The programmer's prompt also embeds a names-only preview (capped at 20 per
category with a `+N more` suffix) so the model can skip blind `search_*`
calls when an obviously-named entry already exists.

## Editing existing types

- `edit_type({ name, def })` (programmer tool) — replace a saved type's
  definition. Allowed: add **optional** fields, widen existing field
  types, loosen constraints. Rejected: remove fields, add required fields,
  narrow field types, change the type class. The compat check runs at
  parse time. If a change is genuinely breaking, the right move is to
  create a new type/fn under a different name so existing callers keep
  working.
