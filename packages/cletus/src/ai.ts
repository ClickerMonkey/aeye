import { AI, ContextInfer } from '@aeye/ai';
import { models, replicateTransformers } from '@aeye/models';
import { OpenAIProvider } from '@aeye/openai';
import { OpenRouterProvider } from '@aeye/openrouter';
import { ReplicateProvider } from '@aeye/replicate';
import { AWSBedrockProvider } from '@aeye/aws';
import Handlebars from 'handlebars';
import { ChatFile } from './chat';
import { ConfigFile } from './config';
import { logger } from './logger';
import { OperationManager } from './operations/manager';
import { ChatMeta, Message, TypeDefinition } from './schemas';
import { RetryContext, RetryEvents } from 'packages/openai/src/retry';
import z from 'zod';
import { loadPromptFiles } from './prompt-loader';
import { Usage, accumulateUsage, toJSONSchema } from '@aeye/core';

/**
 * Cletus AI Context
 */
export interface CletusContext {
  config: ConfigFile;
  ops: OperationManager;
  userPrompt: string;
  chatData?: ChatFile;
  chat?: ChatMeta;
  chatMessage?: Message;
  cwd: string;
  cache: Record<string, any>;
  log: (msg: any) => void;
  chatStatus: (status: string) => void;
  events?: {
    onRefreshPending?: () => void;
    onRefreshChat?: () => void;
  };
  usage: {
    accumulated: Usage;
    accumulatedCost: number;
  };
}

/**
 * Cletus AI Metadata
 */
export interface CletusMetadata {
  // Model selection metadata can go here
}

/**
 * Create the Cletus AI instance
 */
export function createCletusAI(configFile: ConfigFile) {
  const config = configFile.getData();

  const retryEvents: RetryEvents = {
    onRetry: (attempt: number, error: Error, delay: number, context: RetryContext) =>{
      logger.log(`Retry Attempt ${attempt} after ${delay}ms - ${error.message}: ${error.stack}`);
    },
    onTimeout: (attempt: number, context: RetryContext) => {
      logger.log(`Timeout on Attempt ${attempt}`);
    },
    onMaxRetriesExceeded: (attempt: number, error: Error, context: RetryContext) => {
      logger.log(`Max Retries Exceeded on Attempt ${attempt} - ${error.message}: ${error.stack}`);
    },
    onSuccess: (attempt: number, duration: number, context: RetryContext) => {
      logger.log(`Successful Request on Attempt ${attempt} after ${duration}ms`);
    },
  };

  // Initialize providers based on config
  const providers = {
    // OpenAI
    ...(config.providers.openai ? { openai: new OpenAIProvider({
      ...config.providers.openai,
      retryEvents,
      hooks: {
        chat: {
          beforeRequest: (request, params, ctx, metadata) => {
            logger.log(`OpenAI Chat beforeRequest:\n${JSON.stringify(params, null, 2)}`);
          },
          afterRequest: (request, response, responseComplete, ctx, metadata) => {
            logger.log(`OpenAI Chat afterRequest:\n${JSON.stringify(responseComplete, null, 2)}`);
          },
          onError: (request, params, error, ctx, metadata) => {
            logger.log(`OpenAI Chat onError:\n${JSON.stringify(error)}`);
          },
        }
      }
    })} : {}),

    // OpenRouter
    ...(config.providers.openrouter ? { openrouter: new OpenRouterProvider({
      ...config.providers.openrouter,
      retryEvents,
      defaultParams: {
        ...config.providers.openrouter.defaultParams,
        appName: 'cletus',
        siteUrl: 'https://github.com/ClickerMonkey/aeye',
      },
      hooks: {
        chat: {
          beforeRequest: (request, params, ctx, metadata) => {
            logger.log(`OpenRouter Chat beforeRequest:\n${JSON.stringify(params, null, 2)}`);
          },
          afterRequest: (request, response, responseComplete, ctx, metadata) => {
            logger.log(`OpenRouter Chat afterRequest:\n${JSON.stringify(responseComplete, null, 2)}`);
          },
          onError: (request, params, error, ctx, metadata) => {
            logger.log(`OpenRouter Chat onError:\n${JSON.stringify(error)}`);
          },
        }
      }
    })} : {}),

    // Replicate
    ...(config.providers.replicate ? { replicate: new ReplicateProvider({
      ...config.providers.replicate,
      transformers: replicateTransformers,
      hooks: {
        chat: {
          beforeRequest: (request, params, ctx) => {
            logger.log(`Replicate Chat beforeRequest:\n${JSON.stringify(params, null, 2)}`);
          },
          afterRequest: (request, response, responseComplete, ctx) => {
            logger.log(`Replicate Chat afterRequest:\n${JSON.stringify(responseComplete, null, 2)}`);
          },
          onError: (request, params, error, ctx) => {
            logger.log(`Replicate Chat onError:\n${JSON.stringify(error)}`);
          },
        }
      }
    })} : {}),

    // AWS Bedrock
    ...(config.providers.aws ? { aws: new AWSBedrockProvider({
      ...config.providers.aws,
      hooks: {
        chat: {
          beforeRequest: (request, params, ctx) => {
            logger.log(`AWS Chat beforeRequest:\n${JSON.stringify(params, null, 2)}`);
          },
          afterRequest: (request, response, responseComplete, ctx) => {
            logger.log(`AWS Chat afterRequest:\n${JSON.stringify(response, null, 2)}\n\n${JSON.stringify(responseComplete, null, 2)}`);
          },
        }
      }
    })} : {}),
  } as const;

  const jsonReplacer = (_key: string, value: any) => {
    if (value instanceof z.ZodType) {
      return toJSONSchema(value, true)
    }
    return value;
  };

  // Create AI instance with context and metadata types
  const ai = AI.with<CletusContext, CletusMetadata>()
    .providers(providers)
    .create({
      defaultContext: {
        config: configFile,
        cwd: process.cwd(),
        ops: new OperationManager('none'),
        log: logger.log.bind(logger),
        chatStatus: () => {},
        usage: {
          accumulated: {},
          accumulatedCost: 0,
        },
      },
      providedContext: async (ctx) => {
        if (ctx.userPrompt) {
          return ctx;
        }

        const config = ctx.config!.getData();
        const chat = ctx.chat;
        const now = new Date();
        const { locale, timeZone } = Intl.DateTimeFormat().resolvedOptions();

        // Load prompt files from cwd
        const promptFilesContent = await loadPromptFiles(
          ctx.cwd || process.cwd(),
          config.user.promptFiles || ['cletus.md', 'agents.md', 'claude.md']
        );

        const agentMode = chat?.agentMode || 'default';
        const userPromptData = {
          currentDateTime: now.toLocaleString(locale, { timeZone}),
          locale,
          timeZone,
          user: config.user,
          assistant: config.assistants.find((a) => a.name === chat?.assistant),
          mode: chat?.mode || 'none',
          agentMode,
          currentTodo: chat?.todos.find((t) => !t.done),
          todos: chat?.todos || [],
          types: config.types,
          chatPrompt: chat?.prompt,
          globalPrompt: config.user.globalPrompt,
          promptFilesContent,
        };
        const userPrompt = USER_PROMPT(userPromptData);
        
        return { ...ctx, userPrompt, cache: {} };
      },
      models,
    }).withHooks({
      beforeRequest: async (ctx, request, selected, usage, cost) => {
        logger.log(`Cletus beforeRequest model=${selected.model.id}, usage=~${JSON.stringify(usage)}, cost=~${cost}:\n${JSON.stringify(request, jsonReplacer, 2)}`);
      },
      afterRequest: async (ctx, request, response, responseComplete, selected, usage, cost) => {
        logger.log(`Cletus afterRequest model=${selected.model.id}, usage=${JSON.stringify(usage)}, cost=${cost}:\n${JSON.stringify(response, jsonReplacer, 2)}`);
        
        // Accumulate usage in context for tracking across requests
        accumulateUsage(ctx.usage.accumulated, usage);
        ctx.usage.accumulatedCost += cost;
      },
      onError: async (type, message, error, ctx, request) => {
        logger.log(`Cletus onError type=${type}, message=${message}, error=${error?.message}, stack=${error?.stack}:\n${JSON.stringify(request, jsonReplacer, 2)}`);
      }
    });

  return ai;
}

export function createCletusTypeAI(ai: CletusAI) {
  return ai.extend<{ type: TypeDefinition }>();
}

export type CletusAI = ReturnType<typeof createCletusAI>;
export type CletusAIContext = ContextInfer<CletusAI>;

export type CletusTypeAI = ReturnType<typeof createCletusTypeAI>;
export type CletusTypeAIContext = ContextInfer<CletusTypeAI>;

// Global tool properties - useful for debugging
export const globalToolProperties = {
  // explanation: z.string().describe('Provide an explanation on why this tool is being used'),
} as const;

/**
 * Summarize text using the AI
 */
export async function summarize(ai: CletusAI, text: string, signal?: AbortSignal): Promise<string> {
  const models = ai.config.defaultContext!.config!.getData().user.models;
  const model = models?.summary || models?.chat;

  const response = await ai.chat.get({
    model,
    messages: [
      { role: 'system', content: 'You are a helpful assistant that summarizes text files. Provide a concise summary of the following text.' },
      { role: 'user', content: text },
    ],
    maxTokens: 500,
  }, {
    signal,
    metadata: {
      contextWindow: { min: (text.length / 4) + 1000 },
      weights: {
        cost: 0.5,
        speed: 0.5,
      },
    }
  });
  return response.content;
}

/**
 * Describe an image using the AI
 */
export async function describe(ai: CletusAI, image: string, signal?: AbortSignal): Promise<string> {
  const models = ai.config.defaultContext!.config!.getData().user.models;
  const model = models?.describe || models?.imageAnalyze;

  const response = await ai.image.analyze.get({
    model,
    images: [image],
    prompt: DESCRIBE_PROMPT,
    maxTokens: 1000,
  }, { signal });

  return response.content;
}

/**
 * Transcribe an image to markdown using the AI
 */
export async function transcribe(ai: CletusAI, image: string, signal?: AbortSignal): Promise<string> {
  const models = ai.config.defaultContext!.config!.getData().user.models;
  const model = models?.describe || models?.imageAnalyze;

  const response = await ai.image.analyze.get({
    model,
    images: [image],
    prompt: TRANSCRIBE_PROMPT,
    maxTokens: 4000,
  }, { signal });

  return response.content;
}

const USER_PROMPT = Handlebars.compile(
`Current Date & Time: {{currentDateTime}}
Locale: {{locale}}
Time Zone: {{timeZone}}

<user>
{{#if user}}
User: {{user.name}}{{#if user.pronouns}} ({{user.pronouns}}){{/if}}
{{#if user.memory.length}}

User Memories:
{{#each user.memory}}
- {{this.text}}
{{/each}}
{{else}}
No user memories.
{{/if}}
{{/if}}
</user>

{{#if globalPrompt}}
<global-prompt>
{{globalPrompt}}
</global-prompt>

{{/if}}
{{#if promptFilesContent}}
{{{promptFilesContent}}}

{{/if}}
{{#if assistant}}
Assistant Persona: {{assistant.name}}
{{assistant.prompt}}
{{else}}
No assistant persona selected.
{{/if}}

<todos>
Todos are managed by Cletus internally to track user requests. 
The are exclusively referred to as "todos" - nothing else.
{{#if currentTodo}}
Current Todo: {{currentTodo.name}}
{{/if}}
{{#if todos.length}}
Active Todos:
{{#each todos}}
{{this.id}}: [{{#if this.done}}✓{{else}} {{/if}}] {{this.name}}
{{/each}}
{{else}}
No Todos.
{{/if}}
</todos>

<chat>
Chat Mode: {{mode}}
- none: All AI operations require user approval
- read: Read operations involving AI are automatic, others require approval
- create: Read & create operations are automatic, others require approval
- update: Read, create, & update operations are automatic, delete requires approval
- delete: All operations are automatic

Agent Mode: {{agentMode}}
- default: All toolsets are available
- plan: Only the planner toolset is available. Use this mode when you need to focus on planning and task management

{{#if chatPrompt}}
Prompt: {{chatPrompt}}
{{/if}}
</chat>

<types>
Data types are user defined schemas representing structured information.
The schemas are managed by the 'architect' toolset and the data is managed by the 'dba' toolset.
{{#if types.length}}
Available Data Types:
{{#each types}}
- {{this.name}}: {{this.friendlyName}}{{#if this.description}} - {{this.description}}{{/if}}
{{/each}}
{{else}}
No custom data types defined.
{{/if}}
</types>

<IMPORTANT>
- Do not offer any functionality or options you cannot perform based on the tools available.
- Base your responses in what you know based on the context or what tool results you have.
- If your response is not based on tool results or context, clearly state that you are not basing it on any known information.
- Do not assume anything about a data type based on it's name - always use the architect to understand the schema first.
- Todos are mainly managed by the planner toolsets; only reference them if specifically asked about them. Do not misinterpret anything else as todos - they are explicitly referred to as "todos". They simply have a name and a done status. Todos are meant for cletus, not the user.
</IMPORTANT>
`, { noEscape: true });

const DESCRIBE_PROMPT = `Analyze this image in detail and describe its key elements, context, and any notable aspects.`;

const TRANSCRIBE_PROMPT = `You are an expert document transcription specialist with exceptional attention to detail and accuracy. Your task is to convert images of documents, pages, forms, handwritten notes, or any text-containing images into full-featured, well-structured markdown format.

# Core Responsibilities

1. **Accurate Text Extraction**: Transcribe ALL visible text from the image with precision. Do not make up, guess, or invent content that isn't clearly visible.

2. **Preserve Layout and Structure**: Maintain the original document structure, including:
   - Hierarchical organization (headers, sections, subsections)
   - Paragraph breaks and spacing
   - Lists (ordered and unordered)
   - Tables with proper column alignment
   - Text formatting (bold, italic, code blocks, quotes)

3. **Handle Special Content**:
   - **Mathematical Equations**: Use LaTeX syntax enclosed in $ for inline math or $$ for display math
   - **Code Blocks**: Use triple backticks with language specification when applicable
   - **Tables**: Create properly formatted markdown tables with alignment
   - **Images/Figures**: Use the format \`@image("detailed description of the image")\` for any embedded images, diagrams, charts, or figures
   - **Links**: Preserve any visible URLs or references

# Markdown Formatting Guidelines

## Headers
- Use \`#\` for the main document title (H1)
- Use \`##\` for major sections (H2)
- Use \`###\` for subsections (H3)
- Continue with \`####\`, \`#####\`, \`######\` as needed for deeper hierarchy

## Text Flow
- **Line Breaks**: Only insert line breaks at:
  - The end of complete sentences that clearly end at the line boundary
  - Natural paragraph breaks
  - List items
  - Table rows
- **NO Mid-Sentence Breaks**: Do NOT insert line breaks in the middle of sentences unless the original document clearly shows a deliberate break
- Maintain the reading flow as it appears in the original document

## Lists
- Use \`-\` or \`*\` for unordered lists
- Use numbers (1., 2., 3.) for ordered lists
- Properly indent nested lists

## Tables
- Use standard markdown table syntax with pipes (\`|\`) and hyphens (\`-\`)
- Align columns appropriately using colons in the separator row
- Ensure all cells are properly aligned

## Emphasis
- Use \`**bold**\` for bold text
- Use \`*italic*\` or \`_italic_\` for italic text
- Use \`\`code\`\` for inline code
- Use triple backticks for code blocks

## Images and Visual Elements
When you encounter images, diagrams, charts, graphs, photographs, or any visual elements:
- Use: \`@image("comprehensive description")\`
- **Be highly descriptive**: Include:
  - What the image shows (subject, content)
  - Colors, composition, style
  - Any text or labels visible in the image
  - The purpose or context of the image
  - Approximate position relative to text
- Example: \`@image("Bar chart showing quarterly revenue growth from Q1 to Q4 2024, with blue bars representing actual revenue and red line showing projected growth. Y-axis shows millions of dollars from 0-100, X-axis shows quarters. Title reads 'Revenue Performance 2024'.")\`

# Special Situations

## Rotated Pages
If the page appears sideways or upside down:
- Rotate mentally and transcribe the content in the correct reading orientation
- Note the original orientation if it seems significant

## Poor Quality or Illegible Text
- Transcribe what you can read clearly
- For unclear sections, use \`[unclear]\` or \`[illegible]\` markers
- If an entire section is unreadable, note it explicitly

## Multiple Columns
- Transcribe left to right, top to bottom
- Clearly separate columns with spacing or horizontal rules (\`---\`) if needed
- Maintain the reading order as it would naturally flow

## Handwritten Content
- Transcribe carefully, noting any ambiguous letters/words
- Use \`[?]\` for uncertain interpretations
- Prioritize accuracy over speed

# Critical Rules

1. **NO GUESSING**: If you cannot read something, mark it as \`[unclear]\` rather than guessing
2. **NO FABRICATION**: Only transcribe what is actually visible in the image
3. **PRESERVE ORDER**: Present text in the order it appears in the document
4. **BE PRECISE**: Match the original text exactly, including any typos or errors (you're transcribing, not editing)
5. **BE COMPLETE**: Don't skip content or summarize - transcribe everything visible

# Error Handling

If you cannot read or transcribe the image for any reason:
- Respond ONLY with: \`We cannot read the page: "[specific reason]"\`
- Reasons might include:
  - "The image is too blurry or low resolution"
  - "The image appears corrupted or incomplete"
  - "The text is too small or faint to read reliably"
  - "The image contains only graphics/diagrams with no transcribable text"
  - "The language or script is not recognizable"

# Output Format

Your response should be clean markdown without any preamble, explanation, or meta-commentary. Start directly with the transcribed content using appropriate markdown formatting.

---

Now, please transcribe the provided image following all guidelines above.`;