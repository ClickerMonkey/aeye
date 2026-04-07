# Code Reviewer Agent

An agent that finds TypeScript files, reads them, and produces summaries.

```typescript
import { AI } from '@aeye/ai';
import { OpenAIProvider } from '@aeye/openai';
import z from 'zod';

const openai = new OpenAIProvider({ apiKey: process.env.OPENAI_API_KEY! });
const ai = AI.with().providers({ openai }).create();

const searchFiles = ai.tool({
  name: 'searchFiles',
  description: 'Search for files matching a glob pattern',
  schema: z.object({
    pattern: z.string().describe('Glob pattern, e.g. "**/*.ts"'),
  }),
  call: async ({ pattern }) => {
    // In production, use a glob library
    return { files: ['src/index.ts', 'src/utils.ts', 'src/types.ts'] };
  },
});

const readFile = ai.tool({
  name: 'readFile',
  description: 'Read the contents of a file',
  schema: z.object({
    path: z.string().describe('File path to read'),
  }),
  call: async ({ path }) => {
    // In production, read from filesystem
    return { content: `// Contents of ${path}\nexport function main() {}` };
  },
});

const summarizeCode = ai.prompt({
  name: 'summarizeCode',
  description: 'Summarizes TypeScript code',
  content: 'Summarize the following TypeScript code:\n\n{{code}}',
  input: (input: { code: string }) => ({ code: input.code }),
  schema: z.object({
    summary: z.string(),
    exports: z.array(z.string()),
    complexity: z.enum(['low', 'medium', 'high']),
  }),
});

// Agent orchestrates the workflow
const codeReviewer = ai.agent({
  name: 'codeReviewer',
  description: 'Reviews TypeScript files and produces summaries',
  refs: [searchFiles, readFile, summarizeCode] as const,
  call: async ({ pattern }: { pattern: string }, [search, read, summarize], ctx) => {
    const { files } = await search.run({ pattern }, ctx);
    const reviews = [];

    for (const file of files) {
      const { content } = await read.run({ path: file }, ctx);
      const result = await summarize.get('result', { code: content }, ctx);
      reviews.push({
        file,
        summary: result?.summary ?? '',
        exports: result?.exports ?? [],
        complexity: result?.complexity ?? 'low',
      });
    }

    return reviews;
  },
});

// Run
const results = await codeReviewer.run({ pattern: 'src/**/*.ts' });
results.forEach(({ file, summary, complexity }) => {
  console.log(`\n${file} [${complexity}]:`);
  console.log(`  ${summary}`);
});
```
