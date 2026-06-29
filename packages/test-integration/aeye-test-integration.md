# @aeye/test-integration

LLM-oriented guide to the `@aeye/test-integration` package: integration tests
that exercise `@aeye` multi-provider functionality against **real provider
APIs**. Use this when running, debugging, or adding integration tests.

## Purpose

`@aeye/test-integration` (`packages/test-integration/`) verifies that the
`@aeye` library works end-to-end with live AI providers. Unlike the unit tests
in other packages (which mock providers), these tests **make real network calls
and may incur small API costs**. The package is `private: true` and exists only
to host tests.

It depends on the in-repo workspaces: `@aeye/core`, `@aeye/ai`, `@aeye/openai`,
`@aeye/openrouter`, `@aeye/replicate`. The Jest config maps `@aeye/*` imports
directly to each package's `src/` (see `moduleNameMapper` below), so tests run
against the live TypeScript source, not built `dist/`.

## Test runner & config

- Runner: **Jest** `^29` with `ts-jest` (`preset: 'ts-jest'`, node
  environment).
- Config: `packages/test-integration/jest.config.cjs`.
- Test discovery: `**/__tests__/**/*.test.ts` under `src/`.
- Global timeout: `60000` ms (60s) per test; individual tests raise this
  inline (the multi-provider API tests use 120s, the ginny reproducer uses 15
  minutes).
- Setup file: `src/setup.ts` runs before each suite (`setupFilesAfterEnv`); it
  loads env vars and exposes conditional-skip helpers.
- Module mapping: `^@aeye/(.*)$` → `<rootDir>/../$1/src` (resolves sibling
  workspaces' source directly).

## Required environment / credentials

Tests read API keys from the environment. `src/setup.ts` loads
**`.env.test` at the monorepo root** (`packages/../../.env.test`) via `dotenv`.

Setup steps:

```bash
# From packages/test-integration/
cp ../../.env.example ../../.env.test
# then edit ../../.env.test and fill in the keys you have
```

Recognized variables (from `.env.example`; each provider key is
`<PROVIDER>_API_KEY`, derived in `setup.ts` from the provider name):

| Variable             | Provider / purpose                          |
|----------------------|---------------------------------------------|
| `OPENAI_API_KEY`     | OpenAI provider                             |
| `OPENROUTER_API_KEY` | OpenRouter provider                         |
| `REPLICATE_API_KEY`  | Replicate provider                          |
| `XAI_API_KEY`        | xAI (Grok) — present in `.env.example`      |
| `GOOGLE_API_KEY`     | Google AI (Gemini) — present in `.env.example` |
| `UNIT_TESTS_ONLY`    | Flag in `.env.example` (`true`/`false`)     |
| `RUN_INTEGRATION_TESTS` | Flag in `.env.example` (`true`/`false`)  |

`setup.ts` treats `openai`, `openrouter`, and `replicate` as the canonical
provider set for `getAvailableProviders()`.

### Conditional execution (how tests skip)

`src/setup.ts` exports helpers used to gate suites so missing keys don't fail
the run:

- `hasAPIKey(provider)` / `getAPIKey(provider)` — check / fetch
  `<PROVIDER>_API_KEY` (the getter throws if missing).
- `getAvailableProviders()` — returns the subset of
  `['openai','openrouter','replicate']` that have keys.
- `skipIfNoAPIKey(provider)` — returns `describe` or `describe.skip`.
- `requireMinimumProviders(n)` — returns `describe.skip` unless at least `n`
  providers have keys.

If no keys are present, the relevant suites are skipped rather than failing.

## Running the tests (real commands)

From `packages/test-integration/` (scripts in `package.json`):

```bash
# Run all integration tests
npm test                  # → jest

# Run only the __tests__ path pattern
npm run test:integration  # → jest --testPathPattern=__tests__

# Watch mode
npm run test:watch        # → jest --watch
```

Useful Jest passthrough invocations:

```bash
# Run a single suite by filename substring
npm test -- multi-provider

# Verbose output (shows the console.log diagnostics the tests emit)
npm test -- --verbose

# Run the ginny 24-game reproducer specifically
npm test -- --testPathPattern=ginny-24game
```

From the monorepo root:

```bash
# Root convenience script
npm run test:integration   # → cd packages/test-integration && npm test

# Root unit-test run explicitly EXCLUDES this package
npm run test:unit          # ignores @aeye/test-integration
```

## What the tests cover

Test files live in `packages/test-integration/src/__tests__/`.

### `multi-provider.test.ts`

Gated by `requireMinimumProviders(2)` — runs only when **two or more**
providers have keys. Constructs an `AI` instance from whichever of
OpenAI / OpenRouter are available, calls `ai.models.refresh()`, then covers:

- **Model Discovery** — `ai.models.listModels()` returns models for every
  configured provider; `ai.models.searchModels({ required: ['chat'] })` finds
  chat-capable models spanning more than one provider.
- **Model Selection** — `ai.models.selectModel(...)` picks the cheapest model
  (cost-weighted), the most accurate (`tier === 'flagship'`, accuracy-weighted),
  and honors provider `allow` / `deny` lists.
- **Cross-Provider Chat Execution** — `ai.chat.get(...)` runs a prompt on each
  available provider (120s timeout); `ai.chat.stream(...)` verifies streaming
  chunks from each provider (120s timeout).
- **Cost Comparison** — derives the cheapest chat model per provider from
  `searchModels` pricing.
- **Provider Health** — calls each provider's `checkHealth()` and asserts at
  least one is healthy (60s timeout).

### `ginny-24game.test.ts`

A reproducer/diagnostic for the `@aeye/ginny` CLI rather than a pure API test.
Gated by presence of `OPENROUTER_API_KEY` or `OPENAI_API_KEY`, **or** an
existing `packages/ginny/config.json`; otherwise the suite is skipped.

What it does:

- Spawns the ginny CLI non-interactively (`tsx` running
  `packages/ginny/src/index.ts`) in a temp working dir, passing a request to
  build a `solve24(a,b,c,d)` function (the 24 game solver).
- Copies `packages/ginny/config.json` into the temp cwd if present (ginny
  requires a `config.json` in its working directory); otherwise synthesizes one
  from env (`OPENAI_API_KEY`, `OPENROUTER_API_KEY`, `GIN_MODEL`,
  `GIN_PROVIDER`).
- Runs with diagnostic env: `GIN_LOG_FULL_PAYLOAD=1`, `GIN_TOOL_ITERATIONS=20`,
  larger heap; 15-minute hard timeout.
- Parses the run's `ginny.log` and prints a structured report (tool-arg parse
  errors, arg-repair events, validation runs, sub-agent/onError failures,
  message-history growth, saved `fns/`/`types/` artifacts). The temp working
  dir is intentionally **kept** for inspection.
- Soft assertion only: it asserts the log is non-empty (it is a reproducer, not
  a pass/fail correctness test).

## Adding a new integration test

1. Create `packages/test-integration/src/__tests__/<name>.test.ts` (the
   `*.test.ts` under `__tests__/` glob is what Jest discovers).
2. Import the runtime under test from `@aeye/*` (resolves to sibling `src/` via
   the `moduleNameMapper`):

   ```ts
   import { AI } from '@aeye/ai';
   import { OpenAIProvider } from '@aeye/openai';
   ```

3. Gate the suite on credentials using the `src/setup.ts` helpers so it skips
   cleanly when keys are absent:

   ```ts
   import { skipIfNoAPIKey, getAPIKey } from '../setup';

   const describeOpenAI = skipIfNoAPIKey('openai');

   describeOpenAI('My new integration', () => {
     let ai: AI;
     beforeAll(() => {
       ai = new AI({
         providers: { openai: new OpenAIProvider({ apiKey: getAPIKey('openai') }) },
       });
     });
     // ... tests ...
   });
   ```

   For multi-provider scenarios use `requireMinimumProviders(2)` instead.
4. Set realistic per-test timeouts on network calls (pass a 3rd arg to `it`,
   e.g. `}, 120000)`); the global default is only 60s.
5. Prefer **free/cheap models** to keep costs low (per the package README the
   full suite is estimated `< $0.10` per run). Add `console.log` diagnostics —
   they surface with `npm test -- --verbose`.
6. If a new provider env var is needed, add it to the root `.env.example` and,
   if it belongs in the canonical set, to the providers array in `setup.ts`.

## Quick reference

| Task                        | Command / Location                                   |
|-----------------------------|------------------------------------------------------|
| Run all                     | `npm test` (in `packages/test-integration/`)         |
| Run by name                 | `npm test -- multi-provider`                          |
| Run ginny reproducer        | `npm test -- --testPathPattern=ginny-24game`         |
| Watch                       | `npm run test:watch`                                  |
| From root                   | `npm run test:integration`                            |
| Credentials                 | root `.env.test` (copy from `.env.example`)           |
| Skip helpers                | `src/setup.ts`                                        |
| Jest config                 | `jest.config.cjs`                                     |
| Test files                  | `src/__tests__/*.test.ts`                             |
