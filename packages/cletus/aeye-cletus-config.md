# Cletus — Configuration

All persistent state lives under `~/.cletus/` (or `~/.cletus/profiles/<NAME>/` when `--profile NAME` is used). Paths are resolved in `src/file-manager.ts`.

## Storage layout

```
~/.cletus/
├── config.json          # user settings, providers, API keys, assistants, types, chat metadata
├── knowledge.json       # vector embeddings for semantic search (KnowledgeSchema)
├── cache.json           # embedding cache
├── local_cache/         # downloaded fastembed model (getModelCachePath)
├── chats/{chatId}.json  # per-chat message history (ChatMessagesSchema)
├── data/{typeName}.json # custom data-type records (DataFileSchema)
├── images/              # generated/edited images
└── assets/
```

Profiles isolate everything: `cletus --profile work` reads/writes `~/.cletus/profiles/work/...`. JSON files use timestamp-based optimistic locking (`JsonFile` in `file-manager.ts`); concurrent writers get a "Concurrent update detected" error.

## `config.json` schema

Validated by `ConfigSchema` in `src/schemas.ts`. Top level: `{ updated, user, providers, tavily, assistants, chats, types }`. Defaults are seeded by `ConfigFile`'s constructor (`src/config.ts`).

### `user` (`UserSchema`)

| Field | Default | Meaning |
|-------|---------|---------|
| `name`, `pronouns` | `''` | Injected into the system prompt. |
| `memory[]` | `[]` | User memories (`{text, created}`), surfaced in the prompt; managed by the `secretary`/`librarian` tools. |
| `debug` | `false` | Debug logging. |
| `globalPrompt` | `''` | Persistent instructions added to every chat. |
| `promptFiles` | `['cletus.md','agents.md','claude.md']` | Working-dir files to auto-load (see below). |
| `models` | — | Per-use-case model overrides (see Model selection). |
| `autonomous` | `{maxIterations:10, timeout:300000}` | Orchestrator loop bounds (`AUTONOMOUS` constants). |
| `adaptiveTools` | `14` | Number of tools selected per turn in adaptive mode. |
| `maxQuerySchemaTypes` | `5` | Cap on data types included in `query` tool schema. |
| `showInput` / `showOutput` | `false` | Show operation input/output detail in UI. |
| `showSystemMessages` | `true` | Show system messages in UI. |
| `reasoning` | `'none'` | Default reasoning effort: `none | low | medium | high`. Per-chat `ChatMeta.reasoning` overrides. |

### Chat metadata (`ChatMetaSchema`, stored in `config.chats[]`)

`{ id, title, assistant?, prompt?, mode, agentMode, model?, toolset?, todos[], questions[], reasoning }`. `mode` is the chat mode (approval level); `agentMode` is `default`/`plan`; `toolset` pins a toolset (else adaptive); `model` pins the chat model; `prompt` is a per-chat system prompt.

## Providers

`config.providers` = `{ openai, openrouter, replicate, aws, custom }` (each nullable) plus top-level `tavily`. A provider is used only if non-null **and** `enabled !== false` (`isEnabled` in `src/ai.ts`). Each maps to a provider package:

| Provider | Package | Notes |
|----------|---------|-------|
| `openai` | `@aeye/openai` | All model types. `apiKey`, optional `baseUrl`, `organization`, `project`, `retry`, `defaultModels`. |
| `openrouter` | `@aeye/openrouter` | Chat. Adds `defaultParams` (routing/provider prefs); Cletus injects `appName: 'cletus'` + site URL. |
| `replicate` | `@aeye/replicate` | Image gen/edit primarily. Uses `replicateTransformers` from `@aeye/models`. |
| `aws` | `@aeye/aws` | Bedrock chat. `region`, `credentials`, `modelPrefix`, `modelFamilies`, `defaultModels`. |
| `custom` | `@aeye/openai` (OpenAI-compatible) | `apiKey` + `baseUrl` + `selectedModels[]`. Cletus clones the listed `@aeye/models` entries under a synthetic `custom` provider. |
| `tavily` | (`@tavily/core`) | `{apiKey}` — required for `web_search`. |

### Env vars / AWS auto-detection

Per the README, common provider environment variables and AWS profiles are auto-detected by the underlying provider packages. The Cletus config still stores explicit keys/credentials; env/profile detection is a fallback handled in `@aeye/openai` / `@aeye/aws`. (AWS `credentials` may be omitted to use the default credential chain / `AWS_PROFILE`.)

## Model selection

Cletus does **not** require you to pick a model. Two layers:

1. **Pinned models** — `config.user.models` maps a use-case to a model id:
   `chat`, `imageGenerate`, `imageEdit`, `imageAnalyze`, `imageEmbed`, `transcription`, `speech`, `summary`, `describe`, `transcribe`, `edit`. A chat can override `chat` via `ChatMeta.model`.
   Helpers fall back gracefully (e.g. `summarize` uses `models.summary || models.chat`; `describe`/`transcribe` use `models.describe || models.imageAnalyze` — see `src/ai.ts`).
2. **Dynamic selection** — when nothing is pinned, `@aeye/ai` picks from the `@aeye/models` registry using per-call **metadata** (`weights` for cost/speed/accuracy, `contextWindow.min`, required capability). The main agent uses `weights {speed:0.7, accuracy:0.3}` (`chat-agent.ts`); `summarize` uses `{cost:0.5, speed:0.5}`.

Strict-mode tool calling is enabled for capable families via `modelOverrides: [...strictSupport]` from `@aeye/models`.

> README guidance: pin e.g. `openai/gpt-4o` for chat, `google/nano-banana` for image gen/edit, `anthropic/claude-sonnet-4` for file editing. Use exact model ids present in the `@aeye/models` registry.

## Prompt files (working-directory context)

When a chat starts, `loadPromptFiles(cwd, files)` (`src/prompt-loader.ts`, used in `src/ai.ts`) looks in the **current working directory** for the first existing file from `config.user.promptFiles` (default `cletus.md`, then `agents.md`, then `claude.md`; constant `DEFAULT_PROMPT_FILES`). Only the first match is loaded; its content is wrapped in `<prompt-file name="...">` and added to the system prompt for every request in that chat.

Three layers stack: `globalPrompt` (all chats) + prompt file (project) + `ChatMeta.prompt` (this chat) + the selected assistant persona.

## Assistants (personas)

`config.assistants[]` (`AssistantSchema` `{name, prompt, created}`). Seeded defaults: **Gollum**, **Harry Potter**, **Sherlock Holmes**, **Comic** (`DEFAULT_ASSISTANTS` in `src/config.ts`). The active persona's prompt is injected via the `assistant` slot in the user prompt. Managed at runtime by the `secretary` toolset (`assistant_add`/`assistant_switch`/`assistant_update`).

## Custom data types

`config.types[]` (`TypeDefinitionSchema`): `{ name, friendlyName, description?, knowledgeTemplate, fields[] }`; fields are `{ name, friendlyName, type, default?, required?, enumOptions?, onDelete? }` where `type ∈ string|number|boolean|date|enum` or another type name (relations). A default **`task`** type is seeded. Schemas are managed by `architect`; records (in `~/.cletus/data/`) by `dba`. `knowledgeTemplate` (Handlebars) controls how a record is rendered for embedding/search.

## First-run setup

If `~/.cletus/config.json` is absent, the CLI launches the **init wizard** (`src/components/InkInitWizard.tsx`) to collect name/pronouns, enabled providers, and keys, then writes the config. In browser mode the server replies `config_not_found` and the SPA shows `InitPage.tsx`. You can also hand-edit `config.json` directly.

## Reasoning & autonomy at runtime

- Reasoning effort: `ChatMeta.reasoning || user.reasoning || 'none'`; when not `none` the agent sends `request.reason = { effort }` (`chat-agent.ts`).
- Autonomy bounds: `user.autonomous.maxIterations` (min 1, default 10) and `timeout` (min 1s, default 5 min) bound the orchestrator loop (`chat-orchestrator.ts`).
