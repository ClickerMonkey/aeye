# Cletus — Full CLI Agent

Cletus is a complete CLI agent built with @aeye, demonstrating how all the library's features come together in a real application. It's the best reference for building your own AI-powered tools.

```bash
npm i -g @aeye/cletus
```

[View source on GitHub](https://github.com/ClickerMonkey/aeye/tree/main/packages/cletus)

## What It Demonstrates

| Feature | How Cletus Uses It |
|---------|-------------------|
| **Multi-provider** | Supports OpenAI, OpenRouter, Replicate, AWS Bedrock simultaneously |
| **Adaptive tool selection** | 50+ tools with embedding-based relevance filtering per conversation |
| **Structured output** | Custom data types with Zod schemas |
| **Streaming** | Real-time streaming responses with React/Ink terminal UI |
| **Context management** | User memories, chat history, knowledge base with vector search |
| **Agents** | Specialized toolsets (planner, clerk, librarian, architect, artist, dba, internet) |
| **Hooks** | Request/response logging, cost tracking |
| **Prompt files** | Loads `cletus.md` / `agents.md` / `claude.md` from working directory |
| **Autonomous mode** | Configurable auto-approval for operations |
| **Model selection** | Per-capability model configuration (chat, image, speech, etc.) |

## Architecture

Cletus organizes its 50+ tools into specialized toolsets:

- **planner** — task management and todos
- **librarian** — knowledge base with semantic search
- **clerk** — file operations, shell commands
- **secretary** — user memories, assistant personas
- **architect** — custom data type schemas
- **artist** — image generation, editing, analysis, charts, diagrams
- **internet** — web search, page fetching, API calls
- **dba** — data records, queries, import

Instead of exposing all tools at once (which overwhelms the AI), Cletus uses **adaptive tool selection** — it embeds recent messages and selects the ~15 most relevant tools per turn.

## Key Patterns from the Source

### AI Setup (`ai.ts`)

Shows multi-provider initialization with hooks:

```typescript
const providers = {
  ...(isEnabled(config.providers.openai) ? {
    openai: new OpenAIProvider({ ...config.providers.openai, retryEvents, hooks: { /* ... */ } })
  } : {}),
  ...(isEnabled(config.providers.openrouter) ? {
    openrouter: new OpenRouterProvider({ ...config.providers.openrouter, /* ... */ })
  } : {}),
  // ... replicate, aws, custom
};

const ai = AI.with<CletusContext, CletusMetadata>()
  .providers(providers)
  .create({ defaultContext, providedContext, models });
```

### Chat Agent (`agents/chat-agent.ts`)

The main prompt with adaptive tooling and high iteration count:

```typescript
const chatPrompt = ai.prompt({
  name: 'cletus_chat',
  description: 'Main Cletus chat interface',
  toolIterations: 20,
  content: `You are Cletus, a powerful CLI assistant...
{{userPrompt}}
{{toolsetDescriptions}}`,
  // Dynamic tool selection via retool
  // Dynamic content via input
  // Metadata-driven model selection
});
```

### Operation System (`operations/`)

Each tool wraps an "operation" with analysis, approval, and execution phases — a pattern for building tools that need user confirmation:

```typescript
const myTool = ai.tool({
  name: 'file_delete',
  schema: z.object({ path: z.string() }),
  call: async (input, _, ctx) =>
    ctx.ops.handle({ type: 'file_delete', input }, ctx),
});
```

### Custom Data Types (`schemas.ts`)

User-defined schemas validated with Zod — demonstrates how to build a dynamic type system on top of @aeye tools.

## Screenshots

See the [Cletus README](https://github.com/ClickerMonkey/aeye/tree/main/packages/cletus) for screenshots of the browser UI, CLI interface, model selection, file editing approval, charts, and diagrams.

## Running from Source

```bash
git clone https://github.com/ClickerMonkey/aeye.git
cd aeye
npm install
npm run build
cd packages/cletus
npm link
cletus
```
