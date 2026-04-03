# @aeye/core

Core primitives for building AI agents, tools, and prompts with TypeScript. Provides a type-safe, composable framework for creating sophisticated AI applications with structured inputs/outputs, tool calling, and context management.

## Features

- **🎯 Type-Safe Components** - Prompts, Tools, and Agents with full TypeScript support
- **🔧 Tool Calling** - Native support for function/tool calling with schema validation
- **📝 Template-Based Prompts** - Handlebars templates for dynamic prompt generation
- **✅ Schema Validation** - Zod integration for structured inputs and outputs
- **🌊 Streaming Support** - First-class streaming for real-time AI responses
- **🔄 Composable Architecture** - Tools can use other tools, prompts can use tools, agents orchestrate everything
- **📊 Context Management** - Type-safe context threading and automatic token window management
- **🎛️ Flexible Execution** - Sequential, parallel, or immediate tool execution modes

## Installation

```bash
npm install @aeye/core zod handlebars
```

> **Note:** `@aeye/core` defines the primitives — you need an executor/streamer to run prompts. These are provided by `@aeye/ai` via `ai.buildCoreContext()`, or you can supply your own `execute` / `stream` functions.

## Core Concepts

### Components

All AI primitives implement the `Component` interface:

- **Prompt** - Generates AI responses with optional tool usage and structured outputs
- **Tool** - Extends AI capabilities with custom functions and external integrations
- **Agent** - Orchestrates complex workflows combining prompts and tools

### Context & Metadata

- **Context (`TContext`)** - Application-specific data threaded through operations (user, db, etc.)
- **Metadata (`TMetadata`)** - Execution settings for AI requests (model, temperature, etc.)

## Quick Start

### Basic Prompt

```typescript
import { Prompt } from '@aeye/core';
import z from 'zod';

const summarizer = new Prompt({
  name: 'summarize',
  description: 'Summarizes text concisely',
  content: 'Summarize the following text:\n\n{{text}}',

  // Transform raw input into template variables
  input: (input: { text: string }) => ({ text: input.text }),

  // Define output schema (structured JSON)
  schema: z.object({
    summary: z.string().describe('A concise summary'),
    keyPoints: z.array(z.string()).describe('Main points'),
  }),
});

// Execute — ctx must provide execute or stream (from @aeye/ai or custom)
const result = await summarizer.get(
  'result',
  { text: 'Long article text...' },
  {
    execute: yourAIExecutor,  // (request, ctx, metadata?, signal?) => Promise<Response>
    messages: [],
  }
);

console.log(result?.summary);
console.log(result?.keyPoints);
```

### Creating Tools

```typescript
import { Tool } from '@aeye/core';
import z from 'zod';

const getWeather = new Tool({
  name: 'getWeather',
  description: 'Get current weather for a location',
  instructions: 'Use this tool to get weather data for {{location}}.',

  schema: z.object({
    location: z.string().describe('City name or coordinates'),
    units: z.enum(['celsius', 'fahrenheit']).default('celsius'),
  }),

  call: async (input, _refs, _ctx) => {
    const response = await fetch(
      `https://api.weather.com/v1/${encodeURIComponent(input.location)}`
    );
    const data = await response.json();
    return {
      temperature: data.temp,
      condition: data.condition,
      humidity: data.humidity,
    };
  },
});
```

### Prompts with Tools

```typescript
import { Prompt } from '@aeye/core';
import z from 'zod';

const travelAdvisor = new Prompt({
  name: 'travelAdvisor',
  description: 'Provides travel advice based on weather',
  content: `You are a travel advisor. Help plan a trip to {{destination}}.

Use the getWeather tool to check current conditions, then provide:
- What to pack
- Recommended activities
- Best times to visit`,

  input: (input: { destination: string }) => ({
    destination: input.destination,
  }),

  tools: [getWeather],

  schema: z.object({
    recommendations: z.array(z.string()),
    packingList: z.array(z.string()),
    weatherNotes: z.string(),
  }),
});

// The AI will automatically call getWeather if needed
const advice = await travelAdvisor.get(
  'result',
  { destination: 'Paris' },
  { execute: yourAIExecutor, messages: [] }
);

console.log(advice?.recommendations);
```

### Streaming Responses

```typescript
// Stream text content only
for await (const chunk of summarizer.get(
  'streamContent',
  { text: 'Long text...' },
  { stream: yourAIStreamer, messages: [] }
)) {
  process.stdout.write(chunk);
}

// Stream all events (including tool calls)
for await (const event of summarizer.get(
  'stream',
  { text: 'Long text...' },
  { stream: yourAIStreamer, messages: [] }
)) {
  if (event.type === 'textPartial') {
    process.stdout.write(event.content);
  } else if (event.type === 'toolStart') {
    console.log('Tool started:', event.tool.name);
  } else if (event.type === 'toolOutput') {
    console.log('Tool result:', event.result);
  } else if (event.type === 'complete') {
    console.log('Final output:', event.output);
  }
}
```

### Building Agents

```typescript
import { Agent } from '@aeye/core';
import z from 'zod';

// Assume searchTool, summarizePrompt, and analyzePrompt are defined elsewhere
const researchAgent = new Agent({
  name: 'researcher',
  description: 'Conducts research on a topic',

  refs: [searchTool, summarizePrompt, analyzePrompt] as const,

  call: async (
    input: { topic: string },
    [search, summarize, analyze],
    ctx
  ) => {
    // Step 1: Search for information
    const searchResults = await search.run({ query: input.topic, limit: 5 }, ctx);

    // Step 2: Summarize each result
    const summaries: string[] = [];
    for (const result of searchResults.items) {
      const summary = await summarize.get('result', { text: result.content }, ctx);
      summaries.push(summary?.summary ?? '');
    }

    // Step 3: Synthesize into a final analysis
    const analysis = await analyze.get(
      'result',
      { topic: input.topic, sources: summaries },
      ctx
    );

    return analysis;
  },
});

const research = await researchAgent.run(
  { topic: 'Quantum Computing' },
  { execute: yourAIExecutor, messages: [] }
);
```

## Prompt Modes

The `get(mode, input?, ctx?)` method supports different execution modes:

| Mode | Description | Returns |
|------|-------------|---------|
| `'result'` | Await the final structured output | `Promise<TOutput \| undefined>` |
| `'tools'` | Await all tool call results | `Promise<PromptToolOutput[] \| undefined>` |
| `'stream'` | Stream all events | `AsyncGenerator<PromptEvent<TOutput, TTools>, TOutput \| undefined>` |
| `'streamTools'` | Stream tool output events | `AsyncGenerator<PromptToolOutput<TTools>, TOutput \| undefined>` |
| `'streamContent'` | Stream text content only | `AsyncGenerator<string, TOutput \| undefined>` |

```typescript
// Get structured result
const result = await prompt.get('result', input, ctx);

// Get tool outputs only
const tools = await prompt.get('tools', input, ctx);

// Stream everything
for await (const event of prompt.get('stream', input, ctx)) {
  // event.type is one of: 'request', 'textPartial', 'text', 'toolStart',
  //   'toolOutput', 'toolError', 'message', 'complete', 'usage', ...
}

// Stream text only
for await (const text of prompt.get('streamContent', input, ctx)) {
  process.stdout.write(text);
}
```

## Tool Execution Modes

Control how tools are executed by the prompt:

```typescript
const prompt = new Prompt({
  name: 'multi-tool',
  description: 'Uses multiple tools',
  content: 'Analyze this data using the available tools.',
  tools: [tool1, tool2, tool3],

  // 'sequential' | 'parallel' | 'immediate' (default: 'immediate')
  toolExecution: 'parallel',

  // Number of times to retry a failed tool call (default: 2)
  toolRetries: 2,
  // Max tool-calling iterations per request (default: 3)
  toolIterations: 3,
  // Max total successful tool calls before stopping (no strict limit by default)
  toolsMax: 5,
});
```

- **`sequential`** - Wait for each tool to complete before starting the next
- **`parallel`** - Start all pending tools at once and wait for all to complete
- **`immediate`** - Start each tool as soon as its call is received (default)

## Advanced Features

### Context-Aware Tools

Tool schemas and applicability can depend on the current context:

```typescript
interface MyContext {
  userRole: 'admin' | 'viewer';
  isAuthenticated: boolean;
}

const contextTool = new Tool({
  name: 'manageData',
  description: 'Manage data records',
  instructions: 'Use this tool to read or write data.',

  // Schema varies based on the caller's role
  schema: (ctx: Context<MyContext, {}>) => {
    if (ctx.userRole === 'admin') {
      return z.object({ action: z.enum(['read', 'write', 'delete']) });
    }
    return z.object({ action: z.enum(['read']) });
  },

  // Tool is only available to authenticated users
  applicable: (ctx: Context<MyContext, {}>) => ctx.isAuthenticated,

  call: async (input, _refs, ctx) => {
    return { action: input.action, executedBy: ctx.userRole };
  },
});
```

### Custom Validation

Add business-logic validation beyond Zod schema checks:

```typescript
const placeOrder = new Tool({
  name: 'placeOrder',
  description: 'Place a product order',

  schema: z.object({
    itemId: z.string(),
    quantity: z.number().int().min(1),
  }),

  // Runs after schema parsing succeeds; throw to trigger re-prompting
  validate: async (input, ctx) => {
    const inventory = await checkInventory(input.itemId);
    if (inventory < input.quantity) {
      throw new Error(`Only ${inventory} units of ${input.itemId} are available.`);
    }
  },

  call: async (input, _refs, _ctx) => {
    return { orderId: crypto.randomUUID(), ...input };
  },
});
```

### Event Tracking with `withEvents`

```typescript
import { withEvents } from '@aeye/core';

const runner = withEvents({
  onStatus: (instance) => {
    console.log(`${instance.component.name}: ${instance.status}`);
    if (instance.status === 'completed' && instance.completed && instance.running) {
      console.log(`  Took ${instance.completed - instance.running}ms`);
    }
  },

  onPromptEvent: (_instance, event) => {
    if (event.type === 'usage') {
      console.log('Tokens used:', event.usage);
    }
  },
});

const result = await prompt.get(
  'result',
  { text: 'Hello' },
  { execute: yourAIExecutor, messages: [], runner }
);
```

### Token Management

The prompt automatically trims old messages when the context window is full:

```typescript
const result = await prompt.get(
  'result',
  { text: 'Query' },
  {
    execute: yourAIExecutor,
    messages: conversationHistory,  // Will be trimmed if needed

    // Reserve this many tokens for the model's response
    maxOutputTokens: 2048,

    // Custom per-message token estimator
    estimateUsage: (message) => ({
      text: { input: Math.ceil((message.content as string).length / 4) }
    }),
  }
);
```

### Dynamic Reconfiguration

Use `reconfig` to adapt the prompt based on runtime statistics:

```typescript
const adaptivePrompt = new Prompt({
  name: 'adaptive',
  description: 'Adapts based on runtime stats',
  content: 'Solve: {{problem}}',
  schema: z.object({ solution: z.string() }),

  reconfig: (stats, _ctx) => {
    // If many tool errors occurred, switch to one-at-a-time mode
    if (stats.toolCallErrors > 3) {
      return { config: { toolsOneAtATime: true } };
    }
    return {};
  },
});
```

## Model Capabilities

@aeye uses a capability system for automatic model selection. Models advertise their capabilities and the library selects the best match for each request:

| Capability | Description |
|------------|-------------|
| `chat` | Basic text completion |
| `streaming` | Real-time response streaming |
| `image` | Image generation |
| `vision` | Image understanding |
| `audio` | Text-to-speech |
| `hearing` | Speech-to-text |
| `embedding` | Text embeddings |
| `tools` | Function/tool calling |
| `json` | JSON output mode |
| `structured` | Structured outputs with schemas |
| `reasoning` | Extended chain-of-thought reasoning |
| `zdr` | Zero data retention |

## API Reference

### Prompt

```typescript
class Prompt<TContext, TMetadata, TName extends string, TInput extends object, TOutput extends object | string, TTools extends Tuple<ToolCompatible<TContext, TMetadata>>>
```

**Constructor Options (`PromptInput`):**
- `name: string` - Unique identifier
- `description: string` - Purpose description
- `content: string` - Handlebars template for the system/user message
- `input?: (input: TInput, ctx: Context<TContext, TMetadata>) => Record<string, any>` - Maps raw input to template variables
- `schema?: ZodType<TOutput> | ((input: TInput | undefined, ctx: Context<TContext, TMetadata>) => ZodType<TOutput> | false)` - Output schema; `false` disables structured output
- `strict?: boolean` - Enforce strict Zod schema (default: `true`)
- `config?: Partial<Request> | ((input: TInput | undefined, ctx: Context<TContext, TMetadata>) => Partial<Request> | false)` - AI request overrides
- `tools?: TTools` - Tools the prompt may call
- `toolExecution?: 'sequential' | 'parallel' | 'immediate'` - Tool execution mode
- `toolRetries?: number` - Retry count for failed tools (default: 2)
- `toolIterations?: number` - Max tool-calling iterations (default: 3)
- `toolsMax?: number` - Max successful tool calls
- `outputRetries?: number` - Retry count for invalid structured outputs
- `metadata?: TMetadata` - Static metadata for this prompt
- `validate?: (output: TOutput, ctx: Context<TContext, TMetadata>) => void | Promise<void>` - Post-parse validation
- `applicable?: (ctx: Context<TContext, TMetadata>) => boolean | Promise<boolean>` - Availability check

**Methods:**
- `get(mode: PromptGetType, input?: TInput, ctx?: Context<TContext, TMetadata>): PromptGet<...>` - Execute and return output in the specified mode
- `run(input?: TInput, ctx?: Context<TContext, TMetadata>): AsyncGenerator<PromptEvent<TOutput, TTools>, TOutput | undefined>` - Full streaming generator
- `applicable(ctx?: Context<TContext, TMetadata>): Promise<boolean>` - Check if prompt is usable

### Tool

```typescript
class Tool<TContext, TMetadata, TName extends string, TParams extends object, TOutput, TRefs extends Tuple<ComponentCompatible<TContext, TMetadata>>>
```

**Constructor Options (`ToolInput`):**
- `name: string` - Unique identifier (shown to the AI model)
- `description: string` - What the tool does (shown to the AI model)
- `instructions?: string` - Handlebars template for usage instructions
- `schema: ZodType<TParams> | ((ctx: Context<TContext, TMetadata>) => ZodType<TParams> | undefined)` - Input parameter schema
- `strict?: boolean` - Enforce strict Zod schema (default: `true`)
- `refs?: TRefs` - Referenced components
- `call: (input: TParams, refs: TRefs, ctx: Context<TContext, TMetadata>) => TOutput` - Implementation
- `validate?: (input: TParams, ctx: Context<TContext, TMetadata>) => void | Promise<void>` - Post-parse validation
- `applicable?: (ctx: Context<TContext, TMetadata>) => boolean | Promise<boolean>` - Availability check

**Methods:**
- `run(input?: TParams, ctx?: Context<TContext, TMetadata>): TOutput` - Execute the tool directly
- `compile(ctx: Context<TContext, TMetadata>): Promise<readonly [string, ToolDefinition] | undefined>` - Generate AI tool definition
- `applicable(ctx?: Context<TContext, TMetadata>): Promise<boolean>` - Check if tool is usable

### Agent

```typescript
class Agent<TContext, TMetadata, TName extends string, TInput extends object, TOutput, TRefs extends Tuple<ComponentCompatible<TContext, TMetadata>>>
```

**Constructor Options (`AgentInput`):**
- `name: string` - Unique identifier
- `description: string` - Purpose description
- `refs: TRefs` - Components this agent uses
- `call: (input: TInput, refs: TRefs, ctx: Context<TContext, TMetadata>) => TOutput` - Implementation
- `applicable?: (ctx: Context<TContext, TMetadata>) => boolean | Promise<boolean>` - Availability check

**Methods:**
- `run(input?: TInput, ctx?: Context<TContext, TMetadata>): TOutput` - Execute the agent
- `applicable(ctx?: Context<TContext, TMetadata>): Promise<boolean>` - Check if agent is usable

## Context Structure

The `Context<TContext, TMetadata>` type combines your custom context with the core execution context:

```typescript
// Core fields available in every context
interface CoreContextFields {
  // AI executor for non-streaming requests
  execute?: (request: Request, ctx: TContext, metadata?: TMetadata, signal?: AbortSignal) => Promise<Response>;
  // AI streamer for streaming requests
  stream?: (request: Request, ctx: TContext, metadata?: TMetadata, signal?: AbortSignal) => AsyncGenerator<Chunk, Response>;

  // Conversation history passed to the model
  messages?: Message[];

  // Reserve N tokens for the model's output (used for context trimming)
  maxOutputTokens?: number;
  // Override context window size (used for context trimming)
  contextWindow?: number;

  // Custom per-message usage estimator
  estimateUsage?: (message: Message) => Usage | undefined;

  // Number of output-format retries (default: 2)
  outputRetries?: number;
  // Number of context-trimming retries (default: 1)
  forgetRetries?: number;

  // Abort signal for cancellation
  signal?: AbortSignal;
  // Event runner for tracking component lifecycle
  runner?: Events;
}
```

## Request Configuration

```typescript
interface Request {
  messages: Message[];
  temperature?: number;       // 0.0–2.0
  topP?: number;              // 0.0–1.0
  maxTokens?: number;
  stop?: string | string[];
  tools?: ToolDefinition[];
  toolChoice?: 'auto' | 'required' | 'none' | { type: 'tool'; name: string };
  responseFormat?: 'text' | 'json' | { type: 'json_schema'; schema: object; name: string; strict?: boolean };
  reason?: { effort?: 'low' | 'medium' | 'high'; maxTokens?: number };
  frequencyPenalty?: number;
  presencePenalty?: number;
  seed?: number;
  // ... more options
}
```

## Best Practices

1. **Type Safety** - Use TypeScript generics for context and metadata
2. **Schema Validation** - Use Zod for robust input/output validation
3. **Token Management** - Supply `estimateUsage` for accurate context trimming
4. **Tool Organization** - Group related tools and use agents to orchestrate them
5. **Testing** - Unit test tools and prompts independently
6. **Context Minimization** - Pass only necessary data in context
7. **Streaming** - Use streaming for better UX with long responses
8. **Validation** - Use `validate` hooks for business-logic checks after schema parsing

## Examples

See the `src/__tests__` directory for comprehensive examples:

- **prompt-core-features.test.ts** - Basic prompt usage
- **prompt-streaming-tool-events.test.ts** - Streaming and events
- **tool.test.ts** - Tool creation and usage
- **agent.test.ts** - Agent orchestration
- **context-propagation.test.ts** - Context handling

## TypeScript Support

Full type inference across component hierarchies:

```typescript
import { Prompt, Tool } from '@aeye/core';
import z from 'zod';

// Output type is inferred from the schema
const prompt = new Prompt({
  name: 'example',
  description: 'Example prompt',
  content: 'Say hello to {{name}}.',
  input: (input: { name: string }) => ({ name: input.name }),
  schema: z.object({ greeting: z.string() }),
});

// result is typed as { greeting: string } | undefined
const result = await prompt.get('result', { name: 'World' }, ctx);
console.log(result?.greeting);

// Tool call parameters are type-safe
const mathTool = new Tool({
  name: 'add',
  description: 'Adds two numbers',
  schema: z.object({ a: z.number(), b: z.number() }),
  call: (input, _refs, _ctx) => {
    // input is typed as { a: number; b: number }
    return input.a + input.b;
  },
});
```

## Contributing

Contributions are welcome! See the main [@aeye repository](https://github.com/ClickerMonkey/aeye) for contribution guidelines.

## License

GPL-3.0 © [ClickerMonkey](https://github.com/ClickerMonkey)

## Links

- [Root README](../../README.md)
- [@aeye/ai README](../ai/README.md)
- [GitHub Repository](https://github.com/ClickerMonkey/aeye)
- [Issue Tracker](https://github.com/ClickerMonkey/aeye/issues)
