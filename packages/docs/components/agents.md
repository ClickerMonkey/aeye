# Agents

Agents orchestrate multiple tools and prompts to accomplish complex, multi-step goals. They're the highest-level component in @aeye.

::: tip Two ways to create components
Most examples use `ai.agent()`, which binds the agent to an AI instance:

```typescript
const myAgent = ai.agent({ /* ... */ });
```

You can also create standalone agents from `@aeye/core`:

```typescript
import { Agent } from '@aeye/core';
const myAgent = new Agent({ /* ... */ });
```

See [AI Instance](/concepts/ai-instance) for `ai` setup.
:::

## Creating an Agent

```typescript
import z from 'zod';

const searchFiles = ai.tool({
  name: 'searchFiles',
  description: 'Search for files',
  schema: z.object({ pattern: z.string() }),
  call: async ({ pattern }) => ({ files: ['src/index.ts', 'src/app.ts'] }),
});

const readFile = ai.tool({
  name: 'readFile',
  description: 'Read file contents',
  schema: z.object({ path: z.string() }),
  call: async ({ path }) => ({ content: `// ${path} contents` }),
});

const summarize = ai.prompt({
  name: 'summarize',
  description: 'Summarize code',
  content: 'Summarize this code:\n\n{{code}}',
  input: (input: { code: string }) => input,
  schema: z.object({
    summary: z.string(),
    exports: z.array(z.string()),
  }),
});

// Agent composes all three
const codeReviewer = ai.agent({
  name: 'codeReviewer',
  description: 'Reviews TypeScript files',
  refs: [searchFiles, readFile, summarize] as const,
  call: async ({ pattern }: { pattern: string }, [search, read, summarize], ctx) => {
    const { files } = await search.run({ pattern }, ctx);
    const results = [];

    for (const file of files) {
      const { content } = await read.run({ path: file }, ctx);
      const result = await summarize.get('result', { code: content }, ctx);
      results.push({ file, ...result });
    }

    return results;
  },
});

// Run the agent
const reviews = await codeReviewer.run({ pattern: 'src/**/*.ts' });
```

## Agent Configuration

| Property | Type | Description |
|----------|------|-------------|
| `name` | `string` | Unique identifier |
| `description` | `string` | What the agent does |
| `refs` | `Component[] as const` | Required child components (typed tuple) |
| `call` | `(input, refs, ctx) => output` | Orchestration function |
| `applicable` | `(ctx) => boolean` | Availability check |
| `metadata` / `metadataFn` | — | Static/dynamic metadata |

## Typed Refs

The `refs` tuple is fully typed. Using `as const` ensures each ref maintains its specific type:

```typescript
const myAgent = ai.agent({
  name: 'myAgent',
  refs: [toolA, toolB, promptC] as const,
  call: async (input, [a, b, c], ctx) => {
    // a is typed as typeof toolA
    // b is typed as typeof toolB
    // c is typed as typeof promptC
    const resultA = await a.run({ /* typed input */ }, ctx);
    const resultC = await c.get('result', { /* typed input */ }, ctx);
    return { resultA, resultC };
  },
});
```

## Agents vs Prompts

| | Prompt | Agent |
|---|--------|-------|
| **AI calls** | Makes AI API calls directly | Orchestrates other components that make calls |
| **Tools** | AI model decides which tools to call | Your code decides the workflow |
| **Output** | AI-generated text/structured data | Whatever your `call()` function returns |
| **Control** | AI-driven | Developer-driven |
| **Use case** | Single AI interaction with tools | Multi-step workflows |

## Nested Agents

Agents can reference other agents:

```typescript
const researcher = ai.agent({
  name: 'researcher',
  refs: [webSearch, readPage] as const,
  call: async (input, [search, read], ctx) => {
    const results = await search.run(input, ctx);
    // ... process results
    return { findings: [] };
  },
});

const writer = ai.agent({
  name: 'writer',
  refs: [researcher, summarize] as const,
  call: async (input, [research, summarize], ctx) => {
    const { findings } = await research.run(input, ctx);
    const summary = await summarize.get('result', { text: findings.join('\n') }, ctx);
    return summary;
  },
});
```

## Event Tracking

Track agent execution with the instance event system:

```typescript
import { withEvents } from '@aeye/core';

const runner = withEvents({
  onStatus: (instance) => {
    console.log(`[${instance.component.kind}] ${instance.component.name}: ${instance.status}`);
  },
  onChild: (parent, child) => {
    console.log(`${parent.component.name} → ${child.component.name}`);
  },
});

const result = await codeReviewer.run(
  { pattern: 'src/**/*.ts' },
  { runner }
);
```

Output:
```
[agent] codeReviewer: running
codeReviewer → searchFiles
[tool] searchFiles: running
[tool] searchFiles: completed
codeReviewer → readFile
[tool] readFile: running
[tool] readFile: completed
codeReviewer → summarize
[prompt] summarize: running
[prompt] summarize: completed
[agent] codeReviewer: completed
```
