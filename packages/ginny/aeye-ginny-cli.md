# @aeye/ginny — CLI, Configuration & Persistence

Part of the [@aeye/ginny LLM reference](./aeye-ginny.md).

## Invocation

The binary is `ginny` (`bin.ginny → dist/index.js`). There are exactly
two ways to invoke it — the entry point reads a single positional
argument (`process.argv[2]`); there are **no option flags**.

```bash
ginny                  # interactive REPL (no arg)
ginny "your request"   # one-shot: runs the request, then exits
```

- **REPL mode** (no arg): clears the screen (TTY only), prints a startup
  banner, then loops on a `> ` prompt. Each non-empty line is processed
  as a request; history is carried across turns.
- **One-shot mode** (one arg): runs that single request and exits. Wrap
  multi-word requests in quotes.

### Interrupts

- **ESC** — interrupts the in-flight request and returns to the `> `
  prompt without killing the REPL. (Listened for on both `keypress` and
  raw `data`/SIGINT channels for cross-platform reliability.)
- **Ctrl+C** — also aborts an in-flight request; at the idle prompt it
  exits the process.

The interrupt signal is forwarded into in-program I/O (`fns.fetch`,
`fns.llm`) and into web tools so a long network call unwinds cleanly.

### npm scripts (from `package.json`)

| Script | Command | Purpose |
|---|---|---|
| `build` | `npm run clean && node esbuild.config.cjs` | Bundle to `dist/index.js` (single ESM file + shebang). |
| `dev` | `tsx src/index.ts` | Run from source. |
| `start` | `tsx --conditions=source src/index.ts` | Run from source using workspace `source` exports. |
| `clean` | `rimraf dist tsconfig.tsbuildinfo` | Remove build output. |
| `typecheck` | `tsc --noEmit` | Type-check only. |

## First run in a directory

If `config.json` does not exist in the CWD, ginny:

1. Writes a `config.json` template.
2. Appends `config.json` and `ginny.log` to `.gitignore` (creating it if
   needed).
3. Prints setup instructions and **exits** (no request is processed).

Populate at least one provider credential, then re-run. Example
`config.json`:

```json
{
  "OPENAI_API_KEY": "sk-...",
  "GIN_PROVIDER": "openai",
  "GIN_MODEL": "gpt-4o-mini",
  "TAVILY_API_KEY": "tvly-..."
}
```

## Providers

At least one provider must resolve at startup or ginny throws. The three
candidates:

- **openai** — enabled when `OPENAI_API_KEY` is set.
- **openrouter** — enabled when `OPENROUTER_API_KEY` is set.
- **aws** (Bedrock) — there is **no single env var**. ginny probes the
  AWS SDK's standard credential chain at startup via a health check
  (`ListFoundationModels`). Any working credential source enables it:
  `aws sso login`, `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY`, an
  attached IAM role, `~/.aws/credentials`, or container credentials.
  `AWS_REGION` defaults to `us-east-1`.

The startup banner reports which providers came up, which were skipped
(with reasons), the configured model IDs, and whether web research
(Tavily) is enabled.

## Configuration

Config values come from `config.json` in the CWD **or** from environment
variables. **Environment variables always win** on conflict. `config.json`
values are hydrated into `process.env` at startup before anything reads
them.

### Keys recognized in `config.json` (and as env vars)

These are the typed fields in the `config.json` template:

| Key | Default | Purpose |
|---|---|---|
| `OPENAI_API_KEY` | — | Enable OpenAI provider. |
| `OPENROUTER_API_KEY` | — | Enable OpenRouter provider. |
| `AWS_ACCESS_KEY_ID` | — | Optional explicit AWS key (chain usually suffices). |
| `AWS_SECRET_ACCESS_KEY` | — | Optional explicit AWS secret. |
| `AWS_REGION` | `us-east-1` | Bedrock region. |
| `TAVILY_API_KEY` | — | Enable `web_search` / `web_get_page` and the `research` tool. |
| `GIN_PROVIDER` | — | Preferred provider (`openai` \| `openrouter` \| `aws`). |
| `GIN_MODEL` | — | Pin a model id; fallback for any sub-agent without an override. |
| `GIN_SEARCH_THRESHOLD` | `20` | Catalog size at/below which a search returns all entries (above it, keyword-scored top-N). |
| `GIN_TOOL_ITERATIONS` | `100` | Max tool-call iterations per prompt run. |

### Env-only variables (not in the template)

| Variable | Default | Purpose |
|---|---|---|
| `GIN_PROGRAMMER_MODEL` | — | Model id for the programmer sub-agent. |
| `GIN_DESIGNER_MODEL` | — | Model id for the designer (functions) sub-agent. |
| `GIN_ARCHITECT_MODEL` | — | Model id for the architect (types) sub-agent. |
| `GIN_DBA_MODEL` | — | Model id for the dba (vars) sub-agent. |
| `GIN_RESEARCHER_MODEL` | — | Model id for the researcher sub-agent. |
| `GIN_LLM_MODEL` | — | Model id for in-program `fns.llm` calls. |
| `GIN_MAX_WARNINGS` | `5` | Max validation warnings allowed on a saved fn (`finish` rejects above this). |
| `GIN_MAX_COMPLEXITY` | `400` | Max structural complexity for a saved fn body (`finish` rejects above this). |
| `GIN_WRITE_MAX_ARGS_LENGTH` | `16384` | Byte cap on the raw `write` tool args (guards against wire double-encoding). |
| `GIN_LOG_FULL_PAYLOAD` | unset | When set, logs full request/response payloads (large; for debugging 400s). |

Per-sub-agent model resolution: each agent reads `GIN_<KEY>_MODEL`
(`KEY` ∈ `PROGRAMMER`, `DESIGNER`, `ARCHITECT`, `DBA`, `RESEARCHER`,
`LLM`), falling back to `GIN_MODEL`, falling back to the AI model
registry's default selection. This lets the heavyweight programmer run on
a strong model while catalog curators run on something cheaper:

```bash
GIN_PROGRAMMER_MODEL=gpt-5
GIN_DBA_MODEL=gpt-4o-mini
GIN_RESEARCHER_MODEL=gpt-4o-mini ginny "build a small task tracker"
```

## Persistence — the on-disk catalog

Everything the agent saves is one JSON file per name, in three
directories relative to the **current working directory**. The filename
**is** the identity (no internal id field needed).

```
./types/Task.json           # a gin TypeDef
./fns/factorial.json        # a function (TypeDef whose body is at call.get)
./vars/apiBaseUrl.json      # a persistent var: { type, value, docs }
```

- You can hand-edit any of these between sessions; the next run picks up
  the changes. Drop a new file into a directory by hand and ginny
  discovers it on the next catalog search.
- A saved function becomes a **callable top-level global** for the rest of
  the session (and future sessions on load) — invoked by its bare name,
  not under `fns.*`.

Example `./vars/apiBaseUrl.json`:

```json
{
  "type":  { "name": "text", "options": { "pattern": "^https?://" } },
  "value": "https://api.example.com",
  "docs":  "production API root"
}
```

See [aeye-ginny-api.md](./aeye-ginny-api.md) for the function and type
file shapes in detail.

## Logging

Each session writes a verbose timeline to `./ginny.log` (truncated at
startup). Tool inputs/outputs, full validation problems, zod parse
errors, retry/backoff events, and stack traces land there. The terminal
view stays compact (one short line per error). Errors in the terminal are
stamped with a 6-character id; `grep <id> ginny.log` recovers the full
record. Memory-probe lines (`[mem] ...`) are emitted for leak hunting.

## Building from source

```bash
git clone https://github.com/ClickerMonkey/aeye.git
cd aeye
npm install
cd packages/ginny
npm run start              # dev run (tsx --conditions=source)
npm run build              # bundled dist/index.js with shebang
```

The production build is a single ESM file with a Node shebang; the global
install (`npm i -g @aeye/ginny`) links `ginny` straight to it.
