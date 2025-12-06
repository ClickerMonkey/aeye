import Handlebars from "handlebars";
import { ZodString, ZodType } from 'zod';

import { accumulateUsage, Fn, getChunksFromResponse, getInputTokens, getModel, getOutputTokens, getTotalTokens, resolve, Resolved, resolveFn, yieldAll } from "./common";
import { AnyTool, Tool, ToolCompatible } from "./tool";
import { Component, Context, Events, Executor, FinishReason, Message, Names, OptionalParams, Request, RequiredKeys, ResponseFormat, Streamer, ToolCall, ToolDefinition, Tuple, Usage } from "./types";
import { strictify, toJSONSchema } from "./schema";

/**
 * Represents a tool that can be selected by the retool function.
 * Can be either a tool name (string) to select from predefined tools,
 * or a full tool object for dynamic tools.
 */
export type RetoolEntry<TContext, TMetadata> = string | ToolCompatible<TContext, TMetadata>;

/**
 * The return type for the retool function.
 * Can return an array of tool names and/or tool objects, or false to indicate incompatibility.
 */
export type RetoolResult<TContext, TMetadata, TTools extends Tuple<ToolCompatible<TContext, TMetadata>>> = 
  | (Names<TTools> | ToolCompatible<TContext, TMetadata>)[]
  | false;

/**
 * Input provided to the prompt reconfiguration function.
 * 
 * This allows the prompt to adjust its configuration based on runtime statistics.
 */
export interface PromptReconfigInput {
  // The current iteration in the prompt execution loop
  iteration: number;
  // The number of iterations that will be attempted before stopping taking into account all retry types
  maxIterations: number;
  // Total argument parsing & validation errors on tools so far
  toolParseErrors: number;
  // Total tool call errors so far
  toolCallErrors: number;
  // Names of tools called so far
  tools: string[];
  // Total successful tool calls so far
  toolSuccesses: number;
  // Remaining retries for tool calls
  toolRetries: number;
  // Remaining retries for valid structured output generation
  outputRetries: number;
  // Remaining retries for forgetting context
  forgetRetries: number;
}

/**
 * Reconfiguration options for a prompt during execution.
 */
export interface PromptReconfig {
  // The config to use for the next iteration
  config?: Partial<Request>;
  // Overrides the iterations left
  maxIterations?: number;
  // Overrides the number of tool call retries
  toolRetries?: number;
  // Overrides the number of output retries
  outputRetries?: number;
  // Overrides the number of forget retries
  forgetRetries?: number;
}

/**
 * Input structure for defining a prompt.
 * 
 * @template TContext - The context type needed for the prompt's operation.
 * @template TMetadata - The metadata type needed during execution/streaming.
 * @template TName - The name of the prompt, typed for inference in parent components.
 * @template TInput - The input type for the prompt.
 * @template TOutput - The output type for the prompt.
 * @template TTools - The tools available to the prompt.
 */
export interface PromptInput<
  TContext = {},
  TMetadata = {},
  TName extends string = string,
  TInput extends object = {},
  TOutput extends object | string = string,
  TTools extends Tuple<ToolCompatible<TContext, TMetadata>> = [],
> {
  // The name of the prompt.
  name: TName;
  // A brief description of the prompt (not used directly).
  description: string;
  // A string defining the prompt content in Handlebars format.
  content: string;
  // An object or function/promise that returns an object for the variables that are injected into the prompt content.
  input?: Fn<Record<string, any>, [TInput | undefined, Context<TContext, TMetadata>]>;
  // A schema or function/promise that returns a schema defining the expected output format of the prompt. If not provided, defaults to plain text.
  schema?: Fn<ZodType<TOutput> | false, [TInput | undefined, Context<TContext, TMetadata>]>;
  // If true, the output schema is strictly enforced. By default this is true.
  strict?: boolean;
  // A configuration object or function/promise that returns a configuration object for the AI request.
  config?: Fn<Partial<Request> | false, [TInput | undefined, Context<TContext, TMetadata>]>;
  // After an iteration, a function that can reconfigure the prompt based on runtime statistics.
  reconfig?: (stats: PromptReconfigInput, ctx: Context<TContext, TMetadata>) => PromptReconfig | Promise<PromptReconfig>;
  // An array of tools available to the prompt.
  tools?: TTools;
  // When the tools should execute (defaults to immediate).
  // - sequential: wait for each tool to finish before continuing
  // - parallel: start all tools at once and wait for all to finish
  // - immediate: start tools as soon as they are available
  toolExecution?: 'sequential' | 'parallel' | 'immediate';
  // Number of attempts to retry tool calls upon failure. Defaults to 2. */
  toolRetries?: number;
  // Number of attempts to get the output in the right format and to pass validation. Defaults to what's on the context, which defaults to 2.
  outputRetries?: number;
  // Number of attempts that will be made to forget context messages of the past in order to complete the request. Defaults to what's on the context, which defaults to 1.
  forgetRetries?: number;
  // Only use tools for this request, don't generate text responses
  toolsOnly?: boolean;
  // Maximum number of tool call iterations allowed. Defaults to 3.
  toolIterations?: number;
  // Maximum tool calls allowed. We can't enforce this exact number unless toolsOneAtATime=true, but we will stop sending tools if we have tool successes >= this number
  toolsMax?: number;
  // A function/promise that returns an array of tool names and/or tool objects to use, or false to indicate the prompt is not compatible with the context.
  // Tool names (strings) select from the predefined tools array, while tool objects allow for dynamic tools.
  retool?: Fn<RetoolResult<TContext, TMetadata, TTools>, [TInput | undefined, Context<TContext, TMetadata>]>;
  // If true, the prompt is re-resolved at the end of each iteration, allowing input, content, config, schema, and tools to change dynamically. If resolve returns undefined, iteration ends.
  dynamic?: boolean;
  // Metadata about the prompt to be passed during execution/streaming. Typically contains which model, or requirements, etc.
  metadata?: TMetadata;
  // A function/promise that returns metadata about the prompt to be passed during execution/streaming.
  metadataFn?: (input: TInput, ctx: Context<TContext, TMetadata>) => TMetadata | Promise<TMetadata>;
  // If messages on the context should be excluded when rendering the prompt.
  excludeMessages?: boolean;
  // Optional post-validation hook that runs after Zod parsing succeeds on the final output. Can throw to trigger re-prompting.
  validate?: (output: TOutput, ctx: Context<TContext, TMetadata>) => void | Promise<void>;
  // Optional function to determine if the component is applicable in the given context. If this is defined it is used over the default check.
  applicable?: (ctx: Context<TContext, TMetadata>) => boolean | Promise<boolean>;
  // Optional way to explicitly declare the types used in this component.
  types?: {
    input?: TInput;
    output?: TOutput;
    context?: TContext;
    metadata?: TMetadata;
  },
}

/**
 * Converts TTools into:
 * 
 * { tool: 'name1', result: Result1 } | { tool: 'name2', result: Result2 } | ...
 */
export type PromptToolOutput<TTools extends AnyTool[]> =
  TTools extends Array<infer TI>
    ? TI extends Tool<any, any, infer TName, any, infer TO, any>
      ? { tool: TName, result: Resolved<TO> }
      : never
    : never
;

/**
 * Converts TTools into a union of their names:
 * 
 * 'name1' | 'name2' | ...
 */
export type PromptToolNames<TTools extends AnyTool[]> =
  TTools extends Tool<any, any, infer TName, any, any, any>[]
    ? TName
    : never
;

/**
 * Convers TTools (tuple [T1, T2, ...]) into a single tool type (union T1 | T2 | ...)
 */
export type PromptTools<TTools extends AnyTool[]> =
  TTools extends (infer TTool)[]
    ? TTool
    : never
;

/**
 * Converts TTools into tool-related events:
 * 
 * { type: 'toolStart', tool: TTool, args: any } |
 * { type: 'toolOutput', tool: TTool, args: any, result: TOutput } |
 * { type: 'toolError', tool: TTool, args: any, error: string }
 */
export type PromptToolEvents<TTools extends Tuple<AnyTool>> =
  TTools extends Array<infer TTool>
    ? TTool extends Tool<infer t0, infer t1, infer t2, infer t3, infer TOutput, infer t4>
      ? { type: 'toolStart', tool: TTool, args: any, request: Request }
      | { type: 'toolOutput', tool: TTool, args: any, result: Resolved<TOutput>, request: Request }
      | { type: 'toolError', tool: TTool, args: any, error: string, request: Request }
      : never
    : never;

/**
 * The events emitted during prompt execution/streaming.
 */
export type PromptEvent<TOutput, TTools extends Tuple<AnyTool>> =
  { type: 'textPartial', content: string, request: Request } |
  { type: 'text', content: string, request: Request } |
  { type: 'refusal', content: string, request: Request } |
  { type: 'reason', content: string, request: Request } |
  { type: 'reasonPartial', content: string, request: Request } |
  { type: 'toolParseName', tool: PromptTools<TTools>, request: Request } |
  { type: 'toolParseArguments', tool: PromptTools<TTools>, args: string, request: Request } |
  PromptToolEvents<TTools> |
  { type: 'textComplete', content: string, request: Request } |
  { type: 'complete', output: TOutput, request: Request } |
  { type: 'textReset', reason?: string, request: Request } |
  { type: 'requestUsage', usage: Usage, request: Request } |
  { type: 'responseTokens', tokens: number, request: Request } |
  { type: 'usage', usage: Usage, request: Request };

/**
 * A type representing any prompt component.
 */
export type AnyPrompt = Prompt<any, any, any, any, any, any>;

/**
 * The different modes for retrieving prompt output from the convenience get() method.
 */
export type PromptGetType = 'result' | 'tools' | 'stream' | 'streamTools' | 'streamContent';

/**
 * The result type of the prompt get() method based on the selected mode.
 */
export type PromptGet<
  TGetType extends PromptGetType,
  TOutput,
  TTools extends Tuple<AnyTool>,
> = {
  result: Promise<TOutput | undefined>;
  tools: Promise<PromptToolOutput<TTools>[] | undefined>;
  stream: AsyncGenerator<PromptEvent<TOutput, TTools>, TOutput | undefined, unknown>;
  streamTools: AsyncGenerator<PromptToolOutput<TTools>, TOutput | undefined, unknown>;
  streamContent: AsyncGenerator<string, TOutput | undefined, unknown>;
}[TGetType];

/**
 * A Prompt component that generates AI responses based on input, context, and available tools.
 * Prompts orchestrate interactions with AI models, handle tool calls, and manage streaming responses.
 *
 * @template TContext - The context type needed for the prompt's operation.
 * @template TMetadata - The metadata type needed during execution/streaming.
 * @template TName - The name of the prompt, typed for inference in parent components.
 * @template TInput - The input type for the prompt.
 * @template TOutput - The output type for the prompt.
 * @template TTools - The tools available to the prompt.
 *
 * @example
 * const summarizer = new Prompt({
 *   name: 'summarize',
 *   description: 'Summarizes text',
 *   content: 'Summarize the following text:\n\n{{text}}',
 *   input: (input) => ({ text: input.text }),
 *   schema: z.object({ summary: z.string() }),
 * });
 *
 * const result = await summarizer.get({ text: 'Long text here...' });
 */
export class Prompt<
  TContext = {},
  TMetadata = {},
  TName extends string = string,
  TInput extends object = {},
  TOutput extends object | string = string,
  TTools extends Tuple<ToolCompatible<TContext, TMetadata>> = [],
> implements Component<
  TContext,
  TMetadata,
  TName,
  TInput,
  AsyncGenerator<PromptEvent<TOutput, TTools>, TOutput | undefined, unknown>,
  TTools
> {

  /**
   * Compiles the prompt content template.
   * Automatically appends tool instructions section if tools are available.
   *
   * @param content - The prompt content template string.
   * @param hasTools - Whether tools are available.
   * @returns A compiled Handlebars template function.
   */
  static compileContent(content: string, hasTools: boolean) {
    let template = content;
    if (hasTools && !template.includes('{{tools}}')) {
      template = template + "\n\n<tools>\n{{tools}}\n</tools>";
    }
    return Handlebars.compile(template, { noEscape: true });
  }

  constructor(
    public input: PromptInput<TContext, TMetadata, TName, TInput, TOutput, TTools>,
    private retool = resolveFn(input.retool),
    private schema = resolveFn(input.schema, s => s && input.strict !== false ? strictify(s) as ZodType<TOutput> : s),
    private config = resolveFn(input.config),
    private translate = resolveFn(input.input),
    private content = Prompt.compileContent(input.content, !!input.tools?.length),
    private metadataFn = resolveFn(input.metadataFn),
  ) {
  }

  get kind(): 'prompt' {
    return 'prompt';
  }

  get name(): TName {
    return this.input.name;
  }

  get description(): string {
    return this.input.description;
  }

  get refs(): TTools {
    return this.input.tools || [] as unknown as TTools;
  }

  /**
   * Retrieves the prompt output in various modes.
   *
   * - `result`: Returns the final output only
   * - `tools`: Returns all tool outputs only
   * - `stream`: Streams all prompt events
   * - `streamTools`: Streams only tool output events
   * - `streamContent`: Streams only text content events
   *
   * @param mode - The mode of output to retrieve. Defaults to 'result'.
   * @param input - The input parameters for the prompt.
   * @param ctx - The context for the prompt's operation.
   * @returns The prompt output based on the specified mode.
   * @example
   * // Get final result
   * const result = await prompt.get();
   *
   * // Stream content
   * for await (const chunk of prompt.get('streamContent', { text: 'hello' })) {
   *   console.log(chunk);
   * }
   */
  public get<
    TGetType extends PromptGetType,
    TRuntimeContext extends TContext,
    TRuntimeMetadata extends TMetadata,
    TCoreContext extends Context<TRuntimeContext, TRuntimeMetadata>,
  >(
    mode: TGetType = 'result' as TGetType,
    ...[inputMaybe, contextMaybe]: OptionalParams<[TInput, TCoreContext]>
  ): PromptGet<TGetType, TOutput, TTools> {
    const prompt = this as Component<TContext, TMetadata, TName, TInput, AsyncGenerator<PromptEvent<TOutput, TTools>, TOutput | undefined, unknown>, TTools>;
    const input = (inputMaybe || {}) as TInput;
    const ctx = (contextMaybe || {}) as Context<TContext, TMetadata>;
    const preferStream = (mode || 'result').startsWith('stream');
    const toolsOnly = mode === 'tools';
    const stream = ctx.runner
      // @ts-ignore
      ? ctx.runner(prompt, input, ctx, (innerCtx, events) => this.stream(input, preferStream, toolsOnly, events, innerCtx))
      : this.stream(input, preferStream, toolsOnly, undefined, ctx);

    switch (mode) {
    case 'result':
      return (async function() {
        for await (const event of stream) {
          if (event.type === 'complete') {
            return event.output;
          }
        }
      })() as PromptGet<TGetType, TOutput, TTools>;
    case 'tools':
      return (async function() {
        const tools: PromptToolOutput<TTools>[] = [];
        for await (const event of stream) {
          if (event.type === 'toolOutput') {
            tools.push({ tool: event.tool.name, result: event.result } as PromptToolOutput<TTools>);
          }
        }
        return tools;
      })() as PromptGet<TGetType, TOutput, TTools>;
    case 'stream':
      return (async function*() {
        let output: TOutput | undefined = undefined;
        for await (const event of stream) {
          yield event;
          if (event.type === 'complete') {
            output = event.output;
          }
        }
        return output;
      })() as PromptGet<TGetType, TOutput, TTools>;
    case 'streamTools':
      return (async function*() {
        let output: TOutput | undefined = undefined;
        for await (const event of stream) {
          if (event.type === 'toolOutput') {
            yield { tool: event.tool.name, result: event.result } as PromptToolOutput<TTools>;
          }
          if (event.type === 'complete') {
            output = event.output;
          }
        }
        return output;
      })() as PromptGet<TGetType, TOutput, TTools>;
    case 'streamContent':
      return (async function*() {
        let output: TOutput | undefined = undefined;
        for await (const event of stream) {
          if (event.type === 'textPartial') {
            yield event.content;
          }
          if (event.type === 'complete') {
            output = event.output;
          }
        }
        return output;
      })() as PromptGet<TGetType, TOutput, TTools>;
    }
  }

  /**
   * Runs the prompt with the given context and input.
   * 
   * @param ctx - The context for the prompt's operation.
   * @param input - The input parameters for the prompt.
   * @returns An async generator yielding prompt events and ultimately the final output.
   */
  run<
    TRuntimeContext extends TContext, 
    TRuntimeMetadata extends TMetadata,
    TCoreContext extends Context<TRuntimeContext, TRuntimeMetadata>,
  >(...[inputMaybe, contextMaybe]: OptionalParams<[TInput, TCoreContext]>): AsyncGenerator<PromptEvent<TOutput, TTools>, TOutput | undefined, unknown> {
    const input = (inputMaybe || {}) as TInput;
    const ctx = (contextMaybe || {}) as Context<TContext, TMetadata>;
    const prompt = this as Component<TContext, TMetadata, TName, TInput, AsyncGenerator<PromptEvent<TOutput, TTools>, TOutput | undefined, unknown>, TTools>;

    return ctx.runner
      // @ts-ignore
      ? ctx.runner(prompt, input, ctx, (innerCtx, events) => this.stream(input, true, false, events, innerCtx))
      : this.stream(input, true, false, undefined, ctx);
  }

  /**
   * Determines if the prompt is applicable in the given context.
   * By default, checks retool, schema, and config functions if provided.
   * 
   * @param ctx - The context to check applicability against.
   * @returns Whether the prompt is applicable.
   */
  async applicable<
    TRuntimeContext extends TContext, 
    TRuntimeMetadata extends TMetadata,
    TCoreContext extends Context<TRuntimeContext, TRuntimeMetadata>,
  >(...[contextMaybe]: OptionalParams<[TCoreContext]>): Promise<boolean> {
    const ctx = (contextMaybe || {}) as Context<TContext, TMetadata>;

    if (this.input.applicable) {
      return this.input.applicable(ctx);
    }
    if (this.input.retool && await this.retool(undefined, ctx) === false) {
      return false;
    }
    if (this.input.schema && await this.schema(undefined, ctx) === false) {
      return false;
    } 
    if (this.input.config && await this.config(undefined, ctx) === false) {
      return false;
    }
    return true;
  }

  /**
   * Returns metadata for the prompt based on the input and context.
   * Combines static metadata with dynamically generated metadata from metadataFn.
   *
   * @param input - The input for the prompt.
   * @param ctx - The context for the prompt's operation.
   * @returns The metadata for the prompt.
   */
  async metadata<
    TRuntimeContext extends TContext,
    TRuntimeMetadata extends TMetadata,
    TCoreContext extends Context<TRuntimeContext, TRuntimeMetadata>,
  >(...[inputMaybe, contextMaybe]: OptionalParams<[TInput, TCoreContext]>): Promise<TMetadata> {
    const input = (inputMaybe || {}) as TInput;
    const ctx = (contextMaybe || {}) as Context<TContext, TMetadata>;

    return {
      ...(this.input.metadata || {} as TMetadata),
      ...(await this.metadataFn(input, ctx) || {}),
    } as TMetadata;
  }

  /**
   * Streams the prompt execution, yielding events as they occur.
   * This is the core execution method that handles AI interaction, tool calling, and response parsing.
   *
   * @param input - The input parameters for the prompt.
   * @param preferStream - Whether to prefer streaming execution over batch execution.
   * @param events - Optional event handlers for prompt events.
   * @param ctx - The context for the prompt's operation.
   * @returns An async generator yielding prompt events and ultimately the final output.
   */
  async* stream<
    TRuntimeContext extends TContext, 
    TRuntimeMetadata extends TMetadata,
    TCoreContext extends Context<TRuntimeContext, TRuntimeMetadata>,
  >(
    ...[inputMaybe, preferStream = true, toolsOnly = false, eventsMaybe, contextMaybe]: OptionalParams<[
      TInput,
      boolean,
      boolean,
      // @ts-ignore
      Events<Component<TRuntimeContext, TRuntimeMetadata, TName, TInput, AsyncGenerator<PromptEvent<TOutput, TTools>, TOutput | undefined, unknown>, TTools>> | undefined,
      TCoreContext, 
    ]>
  ): AsyncGenerator<PromptEvent<TOutput, TTools>, TOutput | undefined, unknown> {
    const input = (inputMaybe || {}) as TInput;
    const events = (eventsMaybe || {}) as Events<Component<TContext, TMetadata, TName, TInput, AsyncGenerator<PromptEvent<TOutput, TTools>, TOutput | undefined, unknown>, TTools>>;
    const ctx = (contextMaybe || {}) as Context<TContext, TMetadata>;

    const streamer = ctx.stream && preferStream 
      ? ctx.stream
      : ctx.execute
        ? this.streamify(ctx.execute)
        : undefined;

    if (!streamer) {
      throw new Error(`No executor or streamer available in context for prompt ${this.input.name}`);
    }
    
    const resolved = await this.resolve(ctx, input);
    if (!resolved) {
      return undefined;
    }

    const { config, content, tools, toolObjects, responseFormat, schema } = resolved;
    const toolMode = this.input.toolExecution || 'immediate';
    const toolMap = new Map<string, { tool: PromptTools<TTools>, definition: ToolDefinition }>(
      toolObjects?.map(({ tool, definition }) => [tool.name, { tool, definition }] as any) || []
    );

    const onlyTools = toolsOnly || this.input.toolsOnly;
    const systemMessage: Message = {
      role: 'system',
      content,
    };

    const request: Request = {
      name: this.name,
      ...config,
      maxTokens: config?.maxTokens ?? ctx.maxOutputTokens,
      messages: [ systemMessage ],
      tools,
      responseFormat,
    };

    const fixedToolChoice = request.toolChoice && (request.toolChoice === 'required' || typeof request.toolChoice === 'object');

    if (fixedToolChoice && (!tools || tools.length === 0)) {
      throw new Error(`Prompt ${this.input.name} is configured to require tools, but no tools are available.`);
    }

    if (!this.input.excludeMessages && ctx.messages?.length) {
      request.messages = request.messages.concat(ctx.messages);

      // Pre-emptively trim context messages if we have a context window limit
      request.messages = this.forget(request, ctx);
    }

    let outputRetries = this.input.outputRetries ?? ctx.outputRetries ?? 2;
    let forgetRetries = this.input.forgetRetries ?? ctx.forgetRetries ?? 1;
    let toolIterations = this.input.toolIterations ?? 3;
    let toolRetries = this.input.toolRetries ?? ctx.toolRetries ?? 2;

    let result: TOutput | undefined = undefined;
    let lastError: string | undefined = undefined;
    let completeText: string = '';
    let maxIterations = outputRetries + forgetRetries + toolIterations + toolRetries + 1;
    let requestUsageSent = false;
    let usage: Usage | undefined = undefined;
    let iterations = 0;
    let accumulatedUsage: Usage = {};

    // Track stats for reconfig
    let toolParseErrors = 0;
    let toolCallErrors = 0;
    let toolSuccesses = 0;
    const toolsCalled = new Set<string>();

    // Emit is a helper to optionally emit events and return the value passed in so it can be yielded.
    const emit = events?.onPromptEvent && ctx.instance
      ? (ev: PromptEvent<TOutput, TTools>) => {
          // @ts-ignore
          events.onPromptEvent!(ctx.instance!, ev as any);
          return ev;
        }
      : (ev: PromptEvent<TOutput, TTools>) => ev;
    const emitTool = (ev: PromptToolEvents<[AnyTool]>) => emit(ev as PromptEvent<TOutput, TTools>);

    // Main execution loop!
    while (iterations < maxIterations) {
      const toolExecutors: ToolExecution<PromptTools<TTools>>[] = [];
      const toolExecutorMap = new Map<string, ToolExecution<PromptTools<TTools>>>();
      const toolErrorsPrevious = (toolCallErrors + toolParseErrors);
      const toolParseErrorsPrevious = toolParseErrors;

      let finishReason: FinishReason | undefined = undefined;
      let refusal = '';
      let reasoning = '';
      let content = '';
      let disableTools = false;

      const streamController = new AbortController();
      const streamAbort = () => streamController.abort();

      ctx.signal?.addEventListener('abort', streamAbort);

      const metadata: TMetadata = {
        ...(this.input.metadata || {} as TMetadata),
        ...(await this.metadataFn(input, ctx) || {}),
      };

      const stream = streamer(request, ctx, metadata, streamController.signal);

      for await (const chunk of stream) {
        if (streamController.signal.aborted) {
          break;
        }

        if (chunk.usage) {
          usage = chunk.usage;
          if (!requestUsageSent) {
            yield emit({ type: 'requestUsage', usage: chunk.usage, request });
            requestUsageSent = true;
          }
          accumulateUsage(accumulatedUsage, chunk.usage);
        }

        if (chunk.content) {
          content += chunk.content;
          yield emit({ type: 'textPartial', content: chunk.content, request });
        }

        if (chunk.refusal) {
          refusal += chunk.refusal;
          yield emit({ type: 'textPartial', content: chunk.refusal, request });
        }

        if (chunk.reasoning) {
          reasoning += chunk.reasoning;
          yield emit({ type: 'reasonPartial', content: chunk.reasoning, request });
        }

        // Handle tool calls
        if (chunk.toolCallNamed) {
          const toolExecutor = newToolExecution(ctx, chunk.toolCallNamed, toolMap.get(chunk.toolCallNamed.name));
          toolExecutors.push(toolExecutor);
          toolExecutorMap.set(chunk.toolCallNamed.id, toolExecutor);
          
          if (toolExecutor.tool) {
            yield emit({ type: 'toolParseName', tool: toolExecutor.tool, request });
          } else {
            streamController.abort(toolExecutor.error);
            break;
          }
        }

        if (chunk.toolCallArguments) {
          const toolExecutor = toolExecutorMap.get(chunk.toolCallArguments.id);
          if (toolExecutor) {
            toolExecutor.toolCall = chunk.toolCallArguments;
    
            yield emit({ type: 'toolParseArguments', tool: toolExecutor.tool!, args: chunk.toolCallArguments.arguments, request });
          } else {
            console.error(`Received tool call arguments for unknown tool call ID ${chunk.toolCallArguments.id}`);
          }
        }

        if (chunk.toolCall) {
          const toolExecutor = toolExecutorMap.get(chunk.toolCall.id);
          if (toolExecutor) {
            toolExecutor.toolCall = chunk.toolCall;

            if (toolMode === 'immediate') {
              // Start execution immediately
              setImmediate(toolExecutor.run);
            }
          } else {
            console.error(`Received tool call for unknown tool call ID ${chunk.toolCall.id}`);
          }
        }

        if (chunk.finishReason) {
          finishReason = chunk.finishReason;
        }

        // In immediate mode we might be getting more chunks while executing, emit events as soon as possible.
        if (toolMode === 'immediate') {
          for (const toolCall of toolExecutors) {
            if (toolCall.emitStart()) {
              yield emitTool({ type: 'toolStart', tool: toolCall.tool!, args: toolCall.args, request });
            }
            if (toolCall.emitOutput()) {
              yield emitTool({ type: 'toolOutput', tool: toolCall.tool!, args: toolCall.args, result: toolCall.result, request });
            }
            if (toolCall.emitError()) {
              yield emitTool({ type: 'toolError', tool: toolCall.tool!, args: toolCall.args, error: toolCall.error!, request })
            }
          }
        }
      }

      ctx.signal?.removeEventListener('abort', streamAbort);

      // If the model reasoned, yield it
      if (reasoning) {
        yield emit({ type: 'reason', content: reasoning, request });
      }

      // If the model refused to answer and stop
      if (finishReason === 'refusal' || refusal) {
        yield emit({ type: 'refusal', content: refusal || 'unspecified', request });
        lastError = refusal || 'Model refused to answer.';
        break;
      }

      // If the model was stopped due to content filtering
      if (finishReason === 'content_filter') {
        yield emit({ type: 'refusal', content: 'Content filtered by AI model', request });
        lastError = 'Model response was filtered due to content policy.';
        break;
      }

      // If we sent too much, forget the past homie 
      if (finishReason === 'length') {
        if (usage && forgetRetries > 0) {
          request.messages = this.forget(request, ctx, usage)
          forgetRetries--;

          yield emit({ type: 'textReset', reason: 'length', request });

          // Lets retry immediately
          continue;          
        } else {
          // Stop iteration - we can't trim without usage info
          lastError = 'Model indicated length finish reason but no token usage was provided so context cannot be trimmed.';
          break;
        }
      }

      // Yield text event if content exists before processing tool calls
      if (content.length > 0) {
        yield emit({ type: 'text', content, request });
      }

      // If we need to make some tool calls, lets do it! 
      // We might not have a finish_reason if we got a bad tool name.
      if (finishReason === 'tool_calls' || toolExecutors.length) {
        // Add the assistant's response with tool calls to the conversation
        request.messages.push({
          role: 'assistant',
          content,
          toolCalls: toolExecutors.map(te => te.toolCall),
        });

        // If there are any error/invalid - just stop and add their errors and retry
        let skip = false;
        for (const toolExecutor of toolExecutors) {
          if (toolExecutor.error) {
            skip = true;
          } else {
            // Non-blocking call, we don't want to hold up execution here. But if we can emit start or error early below this we will try.
            toolExecutor.parse();
          }
          if (toolExecutor.emitStart()) {
            yield emitTool({ type: 'toolStart', tool: toolExecutor.tool!, args: toolExecutor.args, request });
          }
          if (toolExecutor.emitError()) {
            yield emitTool({ type: 'toolError', tool: toolExecutor.tool!, args: toolExecutor.args, error: toolExecutor.error!, request })
          }
        }

        // The execution mode for this iteration.
        const iterationMode = skip ? 'skip' : toolMode;

        // All tool calls are valid, lets start this!
        switch (iterationMode) {
          case 'sequential':
            for (const toolExecutor of toolExecutors) {
              await toolExecutor.parse();
              if (toolExecutor.emitStart()) {
                yield emitTool({ type: 'toolStart', tool: toolExecutor.tool!, args: toolExecutor.args, request });
              }
              await toolExecutor.run();
              if (toolExecutor.emitOutput()) {
                yield emitTool({ type: 'toolOutput', tool: toolExecutor.tool!, args: toolExecutor.args, result: toolExecutor.result, request });
              }
              if (toolExecutor.emitError()) {
                yield emitTool({ type: 'toolError', tool: toolExecutor.tool!, args: toolExecutor.args, error: toolExecutor.error!, request })
              }
            }
            break;
          case 'parallel':
          case 'immediate':
            const parseRuns = toolExecutors.map(tc => [tc.parse(), tc.run()]).flat();
            for await (const { result: toolCallPromise } of yieldAll(parseRuns)) {
              const toolExecutor = await toolCallPromise;
              if (toolExecutor.emitStart()) {
                yield emitTool({ type: 'toolStart', tool: toolExecutor.tool!, args: toolExecutor.args, request });
              }
              if (toolExecutor.emitOutput()) {
                yield emitTool({ type: 'toolOutput', tool: toolExecutor.tool!, args: toolExecutor.args, result: toolExecutor.result, request });
              }
              if (toolExecutor.emitError()) {
                yield emitTool({ type: 'toolError', tool: toolExecutor.tool!, args: toolExecutor.args, error: toolExecutor.error!, request })
              }
            }
            break;
        }

        for (const toolExecutor of toolExecutors) {
          const content = toolExecutor.error
            ? toolExecutor.error
            : toolExecutor.result
              ? typeof toolExecutor.result === 'string'
                ? toolExecutor.result
                : JSON.stringify(toolExecutor.result)
              : '';

          request.messages.push({
            role: 'tool',
            content,
            toolCallId: toolExecutor.toolCall.id,
          });

          if (toolExecutor.status === 'invalid') {
            toolParseErrors++;
          } else if (toolExecutor.status === 'error') {
            toolCallErrors++;
          } else if (toolExecutor.status === 'success') {
            toolSuccesses++;
          }
        }

        if ((toolCallErrors + toolParseErrors) > toolErrorsPrevious) {
          if (toolRetries > 0) {
            toolRetries--;
          } else {
            disableTools = true;
          }
        }
      }

      const hadToolErrors = toolParseErrorsPrevious !== toolParseErrors;
      const hitMax = this.input.toolsMax && toolSuccesses >= this.input.toolsMax;

      // If if there are only tool calls wanted...
      if (onlyTools) {
        const noTools = toolExecutors.length === 0;

        // If we met our max tool calls, or had some successes with no new errors, or there are no more tools to call, end it.
        if (hitMax || noTools) {
          // got what we needed!
          lastError = undefined;
          break;
        }
      } else {
        // We don't only want tools, but if we had some successes and no new parse errors, remove tool requirement
        if (fixedToolChoice && toolSuccesses > 0 && !hadToolErrors) {
          delete request.toolChoice;
        }

        // If we met our max tool calls, remove the tools from the request
        if (hitMax) {
          // No more tools for you!
          disableTools = true;
        }
      }

      // Accumulate text content from this iteration
      if (content.length > 0) {
        completeText += content;
      }

      // If we are finished, parse the output
      if (finishReason === 'stop' && toolExecutors.length === 0) {
        if (!schema || (schema instanceof ZodString)) {
          result = content as unknown as TOutput;

          break; // All good!
        } else {
          // Grab the JSON part from the content just in case...
          const potentialJSON = content.substring(
            content.indexOf('{'),
            content.lastIndexOf('}') + 1
          );

          let errorMessage = '';
          let resetReason = '';
          try {
            const parsedJSON = JSON.parse(potentialJSON);

            const parsedSafe = await schema.safeParseAsync(parsedJSON);
            if (!parsedSafe.success) {
              const issueSummary = parsedSafe.error.issues
                .map(i => `- ${i.path.join('.')}: ${i.message}${['string', 'boolean', 'number'].includes(typeof i.input) ? ` (input: ${i.input})` : ''}`)
                .join('\n')
              errorMessage = `The output was an invalid format:\n${issueSummary}\n\nPlease adhere to the output schema:\n${toJSONSchema(schema, this.input.strict ?? true)}`;
              resetReason = 'schema-parsing';
            } else {
              result = parsedSafe.data as unknown as TOutput;

              try {
                await this.input.validate?.(result, ctx);
              } catch (validationError: any) {
                errorMessage = `The output failed validation:\n${validationError.message}`;
                resetReason = 'validation';
              }
            }
          } catch (parseError: any) {
            errorMessage = `The output was not valid JSON:\n${parseError.message}`;
            resetReason = 'json-parsing';
          }

          if (errorMessage) {
            if (outputRetries > 0) {
              outputRetries--;

              yield emit({ type: 'textReset', reason: resetReason, request });

              request.messages.push({
                role: 'user',
                content: errorMessage,
              });
            } else {
              lastError = errorMessage;
              break; // No more retries left
            }
          } else {
            // A result was successfully parsed and validated!
            lastError = undefined;
            break;
          }
        }
      }

      // Call reconfig if provided
      if (this.input.reconfig) {
        const stats: PromptReconfigInput = {
          iteration: iterations,
          maxIterations,
          toolParseErrors,
          toolCallErrors,
          toolSuccesses,
          toolRetries,
          outputRetries,
          forgetRetries,
          tools: Array.from(toolsCalled),
        };
        const reconfigResult = await this.input.reconfig(stats, ctx);
        if (reconfigResult) {
          // Apply custom config if provided
          if (reconfigResult.config) {
            delete reconfigResult.config.messages;

            Object.assign(request, reconfigResult.config);
          }

          // Update maxIterations if provided
          if (reconfigResult.maxIterations !== undefined) {
            if (reconfigResult.maxIterations === 0) {
              // Stop immediately
              break;
            } else if (reconfigResult.maxIterations > 0) {
              maxIterations = iterations + reconfigResult.maxIterations;
            }
          }
          if (reconfigResult.outputRetries !== undefined) {
            outputRetries = reconfigResult.outputRetries;
          }
          if (reconfigResult.forgetRetries !== undefined) {
            forgetRetries = reconfigResult.forgetRetries;
          }
          if (reconfigResult.toolRetries !== undefined) {
            toolRetries = reconfigResult.toolRetries;
            if (toolRetries === 0) {
              disableTools = true;
            }
          }
        }
      }

      // Dynamic resolve - re-resolve prompt at end of iteration if enabled
      if (this.input.dynamic) {
        const dynamicResolved = await this.resolve(ctx, input);
        if (dynamicResolved === undefined) {
          // Prompt is no longer compatible with context, end iteration
          break;
        }

        const { config: dynamicConfig, content: dynamicContent, tools: dynamicTools, toolObjects: dynamicToolObjects, responseFormat: dynamicResponseFormat, schema: dynamicSchema } = dynamicResolved;

        // Update request with new resolved state
        Object.assign(request, dynamicConfig);
        systemMessage.content = dynamicContent;
        request.tools = dynamicTools;
        request.responseFormat = dynamicResponseFormat;

        // Update toolMap with new tool objects
        toolMap.clear();
        if (dynamicToolObjects) {
          for (const { tool, definition } of dynamicToolObjects) {
            toolMap.set(tool.name, { tool, definition } as any);
          }
        }
      }

      // If we disabled tools because of hitting retry limits or max tool calls desired, remove them!
      if (disableTools) {
        delete request.tools;
        delete request.toolChoice;
        delete request.toolsOneAtATime;
      }

      // Lets go again!
      // We are hungry for valid tool calls and output!
      iterations++;
    }

    yield emit({ type: 'textComplete', content: completeText, request });

    // Yield token usage if available
    const outputTokens = getOutputTokens(usage);
    if (outputTokens > 0) {
      yield emit({ type: 'responseTokens', tokens: outputTokens, request });
    }

    yield emit({ type: 'usage', usage: accumulatedUsage, request });

    // We don't emit complete without a valid result unless toolsOnly is set
    if (result === undefined && !onlyTools) {
      if (!lastError && iterations === maxIterations) {
        lastError = `Maximum iterations (${maxIterations}) reached without a valid response.`;
      }
      if (!lastError) {
        lastError = `Prompt ${this.input.name} failed without a specified error.`;
      }
      throw new Error(`Prompt ${this.input.name} failed: ${lastError}`);
    }

    yield emit({ type: 'complete', output: result!, request });

    return result!;
  }

  /**
   * Prepares the prompt for execution by resolving all configuration, tools, and templates.
   * Returns undefined if the prompt is not compatible with the given context.
   *
   * @param ctx - The context to prepare against.
   * @param input - The input to the prompt.
   * @returns The resolved prompt components or undefined if not compatible.
   */
  private async resolve(ctx: Context<TContext, TMetadata>, input: TInput) {
    // Get config, if false is returned context is not compatible with prompt
    const config = await this.config(input, ctx);
    if (config === false) {
      return undefined;
    }

    // Get prompt response schema, if false is returned context is not compatible with prompt
    const schema = await this.schema(input, ctx);
    if (schema === false) {
      return undefined;
    }

    // Determine if prompt can run based on tool compatibility with the context
    const retooling = await this.retool(input, ctx);
    if (retooling === false) {
      return undefined;
    }

    // Extract tools, their instructions, and schemas.
    // Handle both tool names (strings) and tool objects from retool
    let selectedTools: ToolCompatible<TContext, TMetadata>[] | undefined;
    
    if (this.input.retool && retooling) {
      // Separate retool results into tool names (strings) and tool objects
      const toolNames = new Set<string>();
      const dynamicTools: ToolCompatible<TContext, TMetadata>[] = [];
      
      for (const entry of retooling) {
        if (typeof entry === 'string') {
          toolNames.add(entry);
        } else {
          // This is a tool object
          dynamicTools.push(entry);
        }
      }
      
      // Select predefined tools by name
      const predefinedTools = this.input.tools?.filter(t => toolNames.has(t.name)) || [];
      
      // Combine predefined tools with dynamic tools
      selectedTools = [...predefinedTools, ...dynamicTools];
    } else {
      // Default: use all predefined tools
      selectedTools = this.input.tools ? [...this.input.tools] : undefined;
    }

    // Check tool applicability
    if (selectedTools && selectedTools.length > 0) {
      const applicabilityResults = await Promise.all(
        selectedTools.map(async (tool) => ({
          tool,
          applicable: await tool.applicable(ctx)
        }))
      );
      selectedTools = applicabilityResults
        .filter(r => r.applicable)
        .map(r => r.tool);
    }

    const toolInstructions = selectedTools && selectedTools.length > 0
      ? (await Promise.all(selectedTools.map(t => t.compile(ctx)))).filter(t => !!t)
      : undefined;
    const instructions = toolInstructions
      ? toolInstructions.map(t => t![0]).join("\n\n")
      : undefined;
    const tools = toolInstructions
      ? toolInstructions.map(t => t![1])
      : undefined;

    // Create toolObjects as array of { tool, definition } pairs
    const toolObjects = selectedTools && toolInstructions
      ? selectedTools.map((tool, i) => ({ tool, definition: toolInstructions[i]![1] }))
      : [];

    // Compute the input that is fed to the prompt's prompt content
    let contentInput: Record<string, any> = input;
    const translated = await this.translate(input, ctx);
    if (translated) {
      contentInput = translated;
    }
    contentInput.tools = instructions;

    // Compute content using the compiled template
    const content = this.content(contentInput);

    // Determine response format
    const responseFormat: ResponseFormat = schema && !(schema instanceof ZodString)
      ? { type: schema as ZodType<object, object>, strict: this.input.strict ?? true }
      : 'text';

    return { config, content, tools, toolObjects, responseFormat, schema };
  }

  

  /**
   * Converts a non-streaming executor into a streamer by yielding response parts.
   * This allows uniform handling of streaming and non-streaming AI providers.
   *
   * @param execute - The executor function to convert.
   * @returns A streamer function that yields parts of the executor's response.
   */
  private streamify(execute: Executor<TContext, TMetadata>): Streamer<TContext, TMetadata> {
    return async function* (request, ctx, metadata, signal) {
      const response = await execute(request, ctx, metadata, signal);
      for (const chunk of getChunksFromResponse(response)) {
        yield chunk;
      }
      return response;
    };
  }

  /**
   * Trims messages from the request to fit within token limits.
   * 
   * This is called:
   * - Before a request is made to ensure the prompt fits within the model's context window if it's specified
   * - After a response with a 'length' finish reason to allow retrying with trimmed context
   * - After a provider catches an early context window error and emits amn artificial length event.
   * 
   * Scenarios that support trimming:
   * 1. Token usage is provided from a previous request (we can use this to infer token counts)
   * 2. A token estimation function is provided in the context (we can estimate token counts)
   * 3. Messages already have token counts assigned (we can use these directly)
   * 
   * @param request - The original request with messages.
   * @param ctx - The context containing message history and token estimation.
   * @param usage - The current token usage.
   * @returns The trimmed array of messages.
   */
  private forget(request: Request, ctx: Context<TContext, TMetadata>, usage?: Usage): Message[] {
    const model = getModel(request.model);
    // Calculate total tokens from usage structure
    const totalTokens = usage ? getTotalTokens(usage) : undefined;
    const contextWindow = model?.contextWindow ?? ctx.contextWindow ?? totalTokens;

    // We can't forget our past if we don't know the context window
    if (!contextWindow) {
      return request.messages;
    }

    // Calculate max input tokens allowed
    const maxOutput = request.maxTokens ?? ctx.maxOutputTokens ?? 4096; // Default completion buffer
    const maxInput = contextWindow - maxOutput;

    // ctx.messages structure: system -> (user -> assistant)[] -> user? -> assistant.tool_calls ->  tool[]
    
    // If we have any tokens defined, spread them out
    // If we have no tokens defined & estimateUsage, estimate them
    // If we have no tokens defined & no estimateUsage but we have usage.text.input, spread them out
    // If we have no tokens defined & no estimateUsage & no usage.text.input, we can't trim

    let messageTokens: number[] = [];
    const totalMessageTokens = request.messages.reduce((sum, t) => sum + (t.tokens || 0), 0);
    if (totalMessageTokens > 0) {
      const chunks: Message[][] = [];
      const chunkTokens: number[] = [];
      let currentChunk: Message[] = [];

      for (let i = request.messages.length - 1; i >= 0; i--) {
        const msg = request.messages[i];
        currentChunk.push(msg);
        if (msg.tokens) {
          chunks.unshift(currentChunk);
          chunkTokens.unshift(msg.tokens);
          currentChunk = [];
        }
      }
      if (currentChunk.length) {
        chunks[0].unshift(...currentChunk);
      }
      // Distribute tokens across messages in each chunk
      // If we have usage input tokens, we add them to the last chunk (usage.text.input - totalMessageTokens)
      if (usage) {
        const usageInputTokens = getInputTokens(usage);
        if (usageInputTokens > 0) {
          const overage = totalMessageTokens - usageInputTokens;
          if (overage > 0) {
            chunkTokens[chunkTokens.length - 1] += overage;
          }
        }
      }
      messageTokens = chunks.map((c, i) => c.map(() => chunkTokens[i] / c.length)).flat();
    } else if (ctx.estimateUsage) {
      for (const msg of request.messages) {
        const msgUsage = ctx.estimateUsage(msg);
        // Calculate total tokens from structured usage
        msg.tokens = getTotalTokens(msgUsage);
      }
      messageTokens = request.messages.map(m => m.tokens!);
    } else if (usage?.text?.input) {
      const spreadTokens = usage.text.input;
      const perMessage = Math.floor(spreadTokens / request.messages.length);
      messageTokens = request.messages.map(() => perMessage);
    } else {
      // we have no way to know token counts, so we can't trim
      return request.messages;
    }

    const totalMessageTokensFinal = messageTokens.reduce((sum, t) => sum + t, 0);
    if (totalMessageTokensFinal <= maxInput) {
      // No trimming needed
      return request.messages;
    }
    
    const removeTokens = totalMessageTokensFinal - maxInput;

    // Calculate where to start trimming and where to stop
    const messageMinIndex = request.messages.findIndex(m => m.role === 'system') + 1; // inclusive
    let messageMaxIndex = request.messages.findLastIndex(m => m.role === 'user'); // exclusive
    if (messageMaxIndex === -1) {
      messageMaxIndex = request.messages.length;
    }

    const trimmedMessages = request.messages.slice(0, messageMinIndex);
    let removesRemaining = removeTokens;
    let messageIndex = messageMinIndex;
    while (removesRemaining > 0 && messageIndex < messageMaxIndex) {
      const message = request.messages[messageIndex];
      if (message.role === 'system') {
        trimmedMessages.push(message);
        messageIndex++;
      } else {
        removesRemaining -= messageTokens[messageIndex] || 0;
        messageIndex++;
      }
    }

    trimmedMessages.push(...request.messages.slice(messageIndex));

    return trimmedMessages;
  }
}

type ToolStatus = 'ready' | 'parsed' | 'invalid' | 'executing' | 'success' | 'error';

type ToolExecution<T> = {
  toolCall: ToolCall;
  tool?: T;
  definition?: ToolDefinition;
  status: ToolStatus;
  emitStart(): boolean;
  emitOutput(): boolean;
  emitError(): boolean;
  parse: () => Promise<ToolExecution<T>>;
  run: () => Promise<ToolExecution<T>>;
  args?: any;
  result?: any;
  error?: string;
}

function once<R>(fn: () => Promise<R>): () => Promise<R> {
  let promise: Promise<R>;
  return () => {
    if (!promise) {
      promise = fn();
    }
    return promise;
  };
}

function emitter() {
  const emitter = {
    called: false,
    ready: false,
    emit: () => {
      const emit = emitter.ready && !emitter.called;
      if (emit) {
        emitter.called = true;
      }
      return emit;
    },
  };
  return emitter;
}

function newToolExecution<T extends AnyTool>(ctx: Context<any, any>, toolCall: ToolCall, toolInfo?: { tool: T, definition: ToolDefinition }) {
  const start = emitter();
  const output = emitter();
  const error = emitter();

  if (!toolInfo) {
    error.ready = true;
  }

  const execution: ToolExecution<T> = {
    toolCall: toolCall,
    tool: toolInfo?.tool,
    definition: toolInfo?.definition,
    status: toolInfo ? 'ready' : 'error',
    error: toolInfo ? undefined : `Tool not found: ${toolCall.name}`,
    emitStart: start.emit,
    emitOutput: output.emit,
    emitError: error.emit,
    parse: once(async () => {
      // Already ran or failed earlier?
      if (execution.status !== 'ready') {
        return execution;
      }
      try {
        execution.args = await toolInfo!.tool.parse(ctx, execution.toolCall.arguments, toolInfo!.definition.parameters);
        execution.status = 'parsed';
        start.ready = true;
      } catch (e: any) {
        execution.status = 'invalid';
        execution.error = `Error parsing tool arguments: ${e.message}, args: ${execution.toolCall.arguments}`;
        error.ready = true;
      }

      return execution;
    }),
    run: once(async (): Promise<ToolExecution<T>> => {
      await execution.parse();
      if (execution.status !== 'parsed') {
        return execution;
      }
      try {
        execution.status = 'executing';
        execution.result = await resolve(toolInfo!.tool.run(execution.args, ctx));
        execution.status = 'success';
        output.ready = true;
      } catch (e: any) {
        execution.status = 'error';
        execution.error = `Error executing tool: ${e.message}, args: ${JSON.stringify(execution.args)}`;
        error.ready = true;
      }

      return execution;
    }),
  };

  return execution;
};