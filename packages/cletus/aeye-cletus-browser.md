# Cletus — Browser mode

Cletus can run as a local web app instead of (or alongside) the terminal UI. The same agent engine, toolsets, and config are used; only the front end and transport differ.

```bash
cletus --browser                 # http://localhost:3000
cletus --browser --port 8080
```

`src/index.tsx` detects `--browser` and calls `startBrowserServer(port)` from `src/browser/server.ts` instead of rendering the Ink app.

## Server architecture (`src/browser/server.ts`)

- A Node `http` server:
  - `GET /file?path=<encoded>` — serves an arbitrary local file (for image/file previews); content-type by extension; guards `ENOENT`/`EACCES`.
  - everything else — serves the **prebuilt SPA** from `dist-browser/` (`serveStaticFile`), with directory-traversal protection. Defaults to `index.html`.
- A `ws` `WebSocketServer` attached to the same HTTP server handles **all** chat traffic (no REST for chat).
- Binds to **`127.0.0.1`** only (local). Press Ctrl+C for graceful shutdown (aborts operations, notifies clients, closes sockets, force-exits after 1s).

Server-level shared state (one per process, across all connections):

| Component | File | Role |
|-----------|------|------|
| `ConnectionRegistry` | `src/browser/connection-registry.ts` | Tracks WebSocket connections and which chat each is viewing. |
| `ChatOperationManager` | `src/browser/chat-operation-manager.ts` | Per-chat `AbortController`s so multiple chats/clients can run concurrently; periodic cleanup. |
| `BroadcastManager` | `src/browser/broadcast-manager.ts` | Fan-out of events to every client subscribed to a chat. |
| chat file cache | (in `server.ts`) | `Map<chatId, ChatFile>` with 1-hour expiry, cleaned every 15 min. |

Per-connection state (config, `CletusAI`, chat agent) is lazily created: `ensureConfig()` loads `~/.cletus/config.json`; `ensureAI()` calls `createCletusAI(config, 'browser')`, `initTools(ai)`, `createChatAgent(ai)`.

## WebSocket protocol

Message shapes are typed in `src/browser/websocket-types.ts` (`ClientMessage` / `ServerMessage`). Client → server message `type`s handled in `server.ts`:

`get_config`, `create_chat`, `get_messages`, `send_message`, `cancel`, `subscribe_chat`, `unsubscribe_chat`, `get_models`, `update_chat_meta`, `update_user`, `add_todo`, `toggle_todo`, `remove_todo`, `clear_todos`, `clear_messages`, `delete_chat`, `handle_operations`, `submit_question_answers`

Server → client (selection): `config`, `config_not_found`, `chat_created`, `messages`, `message_added`, `message_updated`, `messages_updated`, `chat_updated`, `chat_deleted`, `chat_subscribed`, `processing`, `status_update`, `models`, `error`, plus orchestrator operation events broadcast via `BroadcastManager`.

### Typical flow

1. Client connects → `get_config`. If no config, server replies `config_not_found`.
2. `subscribe_chat` registers the connection as a watcher; server replies `chat_subscribed` and pushes current operation state.
3. `send_message` appends a user message, then `runChat(...)` → `runChatOrchestrator(...)`; orchestrator events are persisted and broadcast (`pendingUpdate`/`update`/`complete`/`error`, `processing`, `status`).
4. When operations need approval, the client sends `handle_operations` with `{ approved: number[], rejected: number[] }`; the server marks/executes them through a fresh `OperationManager` and `aiInstance.buildContext(...)`, then resumes the orchestrator if anything executed.
5. The `ask` tool produces questions on `ChatMeta.questions`; the client renders them and replies with `submit_question_answers`, which formats Q&A into messages and resumes the loop.

> Operations keep running even after the originating client disconnects (`ws.on('close')` only unregisters the connection). Other subscribed clients still receive broadcasts.

## Browser front end (`src/browser/`)

The SPA (`app.tsx`, `pages/MainPage.tsx`, `pages/InitPage.tsx`) is built separately by `esbuild.browser.cjs` (+ Tailwind via `postcss.config.cjs` / `tailwind.config.cjs`) into `dist-browser/`. `WebSocketContext.tsx` provides the connection to components.

Notable UI pieces:

- **Rich viewers:** `ChartViewer.tsx` (ECharts), `DiagramViewer.tsx` (Mermaid), `ImageViewer.tsx`, plus `react-markdown` + `remark-gfm` + `remark-math`/`rehype-katex` for math and `react-syntax-highlighter` for code.
- **Browser-specific operation renderers:** `src/browser/operations/*.tsx` (`clerk`, `librarian`, `dba`, `artist`, `internet`, `planner`, `secretary`) render each operation type for the web (parallel to the CLI's `src/operations/*.tsx` renderers).
- **Controls:** `ModelSelector`, `ModeSelector`, `AgentModeSelector`, `ToolsetSelector`, `AssistantSelector`, `SettingsView`, `TodosModal`, `QuestionsModal`, `ProfileModal`, `ChatSidebar`.

## CLI vs browser differences

- Same config (`~/.cletus/config.json`), chats, knowledge, data, and toolsets.
- `CletusContext.client` is `'browser'` vs `'cli'`; tools may set `metadata.onlyClient` to appear in only one client.
- The browser adds chart/diagram/image rich rendering and a multi-client, multi-chat concurrent model; the CLI is single-session with Ink approval prompts.
- Browser mode requires a build (`dist-browser/`); the CLI dev scripts (`npm run dev`/`start`) run from source without a build.
