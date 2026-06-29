# Cletus — Toolsets & Operations

This document catalogs the tools Cletus exposes to the model and the operation lifecycle behind them. Tools live in `src/tools/*.ts`; their side-effecting implementations live in `src/operations/*.tsx` and are aggregated in `src/operations/types.ts` (`Operations`). Toolsets are assembled in `src/agents/toolsets.ts` and registered in `src/agents/chat-agent.ts`.

## Tool → operation pattern

Most tools are thin wrappers that hand off to the `OperationManager`:

```typescript
const fileRead = ai.tool({
  name: 'file_read',                 // snake_case = the real wire name
  description: '...',
  instructions: '... {{modeInstructions}}',  // used for embedding + the model
  schema: z.object({ /* ... */ }),
  input: getOperationInput('file_read'),     // injects modeInstructions
  call: async (input, _, ctx) => ctx.ops.handle({ type: 'file_read', input }, ctx),
});
```

Each operation (`src/operations/*.tsx`, via `operationOf(...)`) declares:

- `mode` — the **operation mode** it requires: `local | none | read | create | update | delete` (a function or constant).
- `analyze(op, ctx)` → `{ analysis, doable, done?, output?, cache? }` — describes/validates the action; for read-only ops can return the result directly (`done: true`).
- `do(op, ctx)` → output — performs the side effect.
- `signature` — a one-line signature shown to the model in the system prompt.
- optional `render`, `content`, `instructions`, `inputFormat`/`outputFormat`.

## Chat mode vs operation mode (approval)

The **chat mode** (`ChatMeta.mode`, set per chat) determines how much runs automatically. Ordering: `local(0) < none(1) < read(2) < create(3) < update(4) < delete(5)` (`OperationModeOrder`). An operation executes automatically iff `chatModeOrder >= operationModeOrder`; otherwise the model only gets an *analysis* and the user is prompted to approve/reject.

| Chat mode | Auto-executes |
|-----------|---------------|
| `none` (default) | All AI operations require approval. |
| `read` | Read AI operations auto; others need approval. |
| `create` | Read + create auto; update/delete need approval. |
| `update` | Read/create/update auto; delete needs approval. |
| `delete` | Everything auto. |

`local`-mode operations always run without approval. The `hypothetical` utility lets the model temporarily drop to a *more* restrictive mode to preview actions without performing them.

**Agent mode** (`ChatMeta.agentMode`): `default` (all toolsets) or `plan` (planner only; in plan mode only `local`/`read` operations are exposed — see `getActiveTools` in `chat-agent.ts`).

## Toolsets

Descriptions come from `getToolsetDescription` in `src/agents/chat-agent.ts`. Names below are the actual tool `name` values.

### planner — `src/tools/planner.ts`
Task/todo management for breaking complex requests into steps. Todos are Cletus-internal (stored on `ChatMeta.todos`), not user-facing data.

`todos_list`, `todos_add`, `todos_done`, `todos_get`, `todos_remove`, `todos_replace`, `todos_clear`

### librarian — `src/tools/librarian.ts`
Semantic knowledge base (vector store in `~/.cletus/knowledge.json`).

`knowledge_search` (semantic search), `knowledge_sources` (list sources), `knowledge_add` (store user memories/notes), `knowledge_delete` (remove a source)

### clerk — `src/tools/clerk.ts`
Filesystem operations and shell. The largest toolset.

`file_search` (glob), `file_summary` (AI summary), `file_index` (embed into knowledge base), `file_read`, `file_edit` (find/replace), `file_create`, `file_copy`, `file_move`, `file_delete`, `file_stats`, `file_attach` (attach to message), `text_search` (regex over contents), `dir_create`, `dir_summary`, `shell` (execute shell commands)

### secretary — `src/tools/secretary.ts`
User memory and assistant-persona management.

`assistant_switch`, `assistant_update`, `assistant_add`, `memory_list`, `memory_update`

### architect — `src/tools/architect.ts`
Custom data-type (schema) definitions. Types are stored in `config.types`; the `dba` toolset operates on the *records* of these types.

`type_list`, `type_info`, `type_create`, `type_update`, `type_delete`, `type_import` (from JSON schema)

### artist — `src/tools/artist.ts`
Image generation/analysis plus chart and diagram rendering.

`image_generate`, `image_edit`, `image_analyze` (vision), `image_describe`, `image_find` (search generated images), `image_attach`, `chart_display` (ECharts), `diagram_show` (Mermaid)

> `chart_display` and `diagram_show` are real operations (in `OperationKindSchema`) not listed in the README; their output is rendered richly in the browser UI.

### internet — `src/tools/internet.ts`
Web access.

`web_search` (Tavily — needs `config.tavily.apiKey`), `web_get_page` (fetch/extract via puppeteer — optional dep), `web_api_call` (arbitrary REST: methods, headers, json/text/binary), `web_download` (download a URL to a local path, auto-detects extension)

> `web_download` is a real operation not listed in the README's web section.

### dba — `src/tools/dba.ts`
Record management for custom data types.

`data_index` (embed records), `data_import` (from files), `data_search` (semantic), `data_get`, `query` (filter/sort/group — see `src/helpers/query.ts`, `src/helpers/dba.ts`)

### utility — `src/tools/utility.ts` (always available)
Registered with `metadata.alwaysVisible: true`, so present every turn regardless of toolset/adaptive selection.

| Tool | Purpose |
|------|---------|
| `getOperationOutput` | Retrieve the full output of an operation message that was truncated in context (by message `id` + `operation` index). |
| `about` | Returns embedded `ABOUT.md` describing Cletus/@aeye/author. |
| `retool` | Switch to a specific toolset or pass `null` to re-enable adaptive selection. |
| `hypothetical` | Temporarily switch the chat to a more restrictive mode to preview actions without executing. Only offered when a more restrictive mode exists. |
| `ask` | Present the user a structured multiple-choice / multi-select questionnaire (special UI). Throws `ToolInterrupt` to pause the loop until the user answers. |

## The operation lifecycle

Operation `status` (`OperationStatusSchema`): `created → analyzing → analyzed | analyzedBlocked | analyzeError → doing → done | doneError`, or `rejected`.

1. The model calls a tool; `ctx.ops.handle(...)` runs `analyze`.
2. If the chat mode permits auto-execution (or the op is `local`), `do` runs immediately and the result is returned to the model.
3. Otherwise the operation is left in `analyzed` state and surfaced to the UI. The orchestrator breaks the loop when any operation `needs approval`.
4. The user approves/rejects in the UI. Approved ops are executed (CLI: in `InkChatView`; browser: `handle_operations` in `server.ts`), then the orchestrator resumes.

The **orchestrator** (`src/agents/chat-orchestrator.ts`) loops up to `autonomous.maxIterations` (default 10) within `autonomous.timeout` (default 5 min), re-invoking the agent with no new user message as long as todos remain and nothing awaits approval. It accumulates `Usage`/cost (`@aeye/core` `accumulateUsage`) and emits streaming events consumed by both clients.

## Operation output truncation

Operation messages fed back to the model are truncated past `CONSTS.OPERATION_MESSAGE_TRUNCATE_LIMIT` (2000 chars); the model recovers the full text with `getOperationOutput`. Pagination helpers (`paginateText`, `CONSTS.MAX_CHARACTERS` 64k / `MAX_LINES` 1000) live in `src/shared.ts`.

## `@aeye` usage per toolset

- **clerk / artist / dba / librarian** call AI facades for summaries, image gen/analyze, and embeddings: `summarize`, `describe`, `transcribe` in `src/ai.ts` use `ai.chat.get` and `ai.image.analyze.get`; embeddings use the local `embed()` worker, not a provider.
- **Model selection per call** uses `@aeye/ai` metadata: e.g. `summarize` passes `metadata.weights {cost, speed}` and `contextWindow.min` so the registry picks a capable model when the user hasn't pinned one (`config.user.models.summary`, etc.).
- All tools are `@aeye/core` `Tool` components; context-aware schemas (`schema: (ctx) => ...`) and `instructionsFn` are resolved with `resolveFn`.
