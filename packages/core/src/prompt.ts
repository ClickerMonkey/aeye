import Handlebars from "handlebars";
import { ZodString, ZodType } from 'zod';

import { accumulateReasoning, accumulateUsage, Fn, getChunksFromResponse, getInputTokens, getModel, getOutputTokens, getTotalTokens, resolve, Resolved, resolveFn, yieldAll } from "./common";
import { AnyTool, Tool, ToolCompatible, ToolInterrupt, PromptSuspend } from "./tool";
import { Component, Context, Events, Executor, FinishReason, Message, Names, OptionalParams, Reasoning, Request, RequiredKeys, ResponseFormat, Streamer, ToolCall, ToolDefinition, Tuple, Usage } from "./types";
import { getDescriptorById, strictify } from "./schema";

/** Default cap (chars) for validation error messages surfaced back to the
 *  LLM. Read by `Prompt.truncateValidationError`; subclasses may override
 *  the method to ignore this. Anything past `max` is replaced with a
 *  `… (N more characters)` marker. */
const DEFAULT_VALIDATION_ERROR_MAX_LENGTH = 4096;

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
  TDecoded extends object | string = TOutput,
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
  /**
   * Strict-mode policy for the output schema. Tri-state, with `1`
   * (best-effort preference) as the default when omitted:
   *
   * - `true` — REQUIRE strict structured output. Selection filters out
   *   models without the matching strict-output family.
   * - `false` — FORCE lenient. Output emitted as standard JSON, no `strict`
   *   flag on the wire.
   * - `number > 0` (default `1`) — PREFER strict, tolerate fallback. The
   *   number is the priority — used by `SchemaBudget` to allocate strict
   *   slots in priority order when the chosen descriptor has per-request
   *   limits (e.g. Anthropic's 24 optional-param ceiling).
   *
   * The legacy default of `true` was changed to `1` in v2 to keep
   * "it just works" against unknown/unannotated models.
   */
  strict?: boolean | number;
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
  // Maximum number of characters of any validation error message
  // (Zod tool-arg parse, output schema parse, output validate, JSON parse)
  // surfaced back to the LLM as a corrective user message. Lengthy zod
  // errors against deep recursive schemas can otherwise blow past 100k
  // characters, blowing the model's context and the user's terminal both.
  // Truncation appends a `… (N more characters)` marker. Default 4096.
  validationErrorMaxLength?: number;
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
  /**
   * Guarantee every `toolCalls[i]` on an emitted assistant message has a
   * matching `role: 'tool'` reply in `request.messages` before the loop
   * returns — even when execution was aborted via the signal or
   * short-circuited by a `ToolInterrupt`. Without this guarantee, the
   * next round-trip fails (OpenAI / Anthropic both reject unpaired
   * `tool_calls`).
   *
   * The synthetic reply carries a short marker (`[interrupted]`,
   * `[aborted: …]`, `[error: …]`) so the model can see WHY the tool
   * didn't run and the caller can detect the synthesized state via the
   * message content if they need to re-issue.
   *
   * `PromptSuspend` is NEVER auto-paired — suspend/resume relies on
   * the missing result slot to know which tool to resume. Suspended
   * tools still skip result emission regardless of this flag.
   *
   * Note: abort-aware dispatch (the `if (signal.aborted) break;` at
   * the top of the sequential / parallel / immediate dispatch loops)
   * runs unconditionally so Ctrl+C unwinds quickly regardless of this
   * flag. Only the synthesis pass that fills in placeholder replies
   * is gated.
   *
   * Default: `true`.
   */
  toolsComplete?: boolean;
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
  /**
   * Optional custom parser that REPLACES Zod validation of the model's
   * STRUCTURED OUTPUT entirely.
   *
   * By default the structured-output path runs `JSON.parse` → Zod schema
   * (`safeParseAsync`, after the wire `strictify`) → `validate`. When
   * `parse` is supplied it takes Zod's place: the pipeline becomes
   * `JSON.parse` → `parse` → `validate`, and the Zod schema (plus the
   * descriptor `strictify` normalization) is SKIPPED for validation.
   *
   * The function receives the raw `JSON.parse`-d structured value and
   * fully owns turning it into the typed `TOutput`. It returns EITHER:
   * - the typed value `TOutput` on success, or
   * - an `Error` to signal validation failure (equivalently, it may
   *   `throw` that error) — the output is rejected and flows through the
   *   SAME output-retry channel a Zod failure would (`outputRetries`),
   *   surfacing the error's own `.message` back to the model.
   *
   * This mirrors `Tool.parse`'s `parse` hook, letting a caller (e.g.
   * `@aeye/query`'s expr/query parser, which produces a typed AST plus
   * `Problems`/`Code` diagnostics) return concise, compiler-style errors
   * with source underlines INSTEAD of Zod's aggregate messages. The
   * returned/thrown `Error` can be a rich subclass carrying structured
   * diagnostics (its `message` is what the model-facing channel surfaces;
   * no Zod vocabulary appears since Zod never runs).
   *
   * Only runs where Zod validation runs today: when a structured
   * (non-`ZodString`) `schema` is present. The `schema` field is still
   * required and continues to drive the model wire format. Absent ⇒
   * unchanged behavior (Zod path).
   */
  parse?: (raw: unknown, ctx: Context<TContext, TMetadata>) => TDecoded | Error | Promise<TDecoded | Error>;
  // Optional post-validation hook that runs after parsing succeeds (Zod or custom `parse`) on the final DECODED output (`TDecoded`). Can throw to trigger re-prompting.
  validate?: (output: TDecoded, ctx: Context<TContext, TMetadata>) => void | Promise<void>;
  // Optional function to determine if the component is applicable in the given context. If this is defined it is used over the default check.
  applicable?: (ctx: Context<TContext, TMetadata>) => boolean | Promise<boolean>;
  // Optional way to explicitly declare the types used in this component.
  types?: {
    input?: TInput;
    output?: TOutput;
    decoded?: TDecoded;
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
    ? TI extends Tool<any, any, infer TName, any, infer TO, any, any>
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
  TTools extends Tool<any, any, infer TName, any, any, any, any>[]
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
    ? TTool extends Tool<infer t0, infer t1, infer t2, infer t3, infer TOutput, infer t4, infer t5>
      ? { type: 'toolStart', tool: TTool, args: any, request: Request }
      | { type: 'toolOutput', tool: TTool, args: any, result: Resolved<TOutput>, request: Request }
      | { type: 'toolInterrupt', tool: TTool, args: any, request: Request }
      | { type: 'toolSuspend', tool: TTool, args: any, request: Request }
      | { type: 'toolError', tool: TTool, args: any, error: string, rawArgs?: string, request: Request }
      : never
    : never;

/**
 * The events emitted during prompt execution/streaming.
 */
export type PromptEvent<TOutput, TTools extends Tuple<AnyTool>> =
  { type: 'request', request: Request, iterations: number } |
  { type: 'textPartial', content: string, request: Request } |
  { type: 'text', content: string, request: Request } |
  { type: 'refusal', content: string, request: Request } |
  { type: 'reason', reasoning: Reasoning, request: Request } |
  { type: 'reasonPartial', reasoning: Reasoning, request: Request } |
  { type: 'toolParseName', tool: PromptTools<TTools>, request: Request } |
  { type: 'toolParseArguments', tool: PromptTools<TTools>, args: string, request: Request } |
  { type: 'toolArgRepairAttempt', tool: PromptTools<TTools>, fields: ReadonlyArray<string>, success: boolean, request: Request } |
  PromptToolEvents<TTools> |
  { type: 'message', message: Message, request: Request } |
  { type: 'textComplete', content: string, request: Request } |
  { type: 'complete', output: TOutput, request: Request } |
  { type: 'suspend', request: Request } |
  { type: 'textReset', reason?: string, request: Request } |
  { type: 'requestUsage', usage: Usage, request: Request } |
  { type: 'responseTokens', tokens: number, request: Request } |
  { type: 'usage', usage: Usage, request: Request };

/**
 * A type representing any prompt component.
 */
export type AnyPrompt = Prompt<any, any, any, any, any, any, any>;

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
  TDecoded extends object | string = TOutput,
> implements Component<
  TContext,
  TMetadata,
  TName,
  TInput,
  AsyncGenerator<PromptEvent<TDecoded, TTools>, TDecoded | undefined, unknown>,
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
    public input: PromptInput<TContext, TMetadata, TName, TInput, TOutput, TTools, TDecoded>,
    private retool = resolveFn(input.retool),
    // Schema stays raw. The matching strictify is applied lazily at validation
    // time using the descriptor pinned on `request.responseFormat.descriptor`
    // by whichever provider built the request — so the validator always
    // matches the wire shape the model actually saw.
    private schema = resolveFn(input.schema),
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
  ): PromptGet<TGetType, TDecoded, TTools> {
    const prompt = this as Component<TContext, TMetadata, TName, TInput, AsyncGenerator<PromptEvent<TDecoded, TTools>, TDecoded | undefined, unknown>, TTools>;
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
      })() as PromptGet<TGetType, TDecoded, TTools>;
    case 'tools':
      return (async function() {
        const tools: PromptToolOutput<TTools>[] = [];
        for await (const event of stream) {
          if (event.type === 'toolOutput') {
            tools.push({ tool: event.tool.name, result: event.result } as PromptToolOutput<TTools>);
          }
        }
        return tools;
      })() as PromptGet<TGetType, TDecoded, TTools>;
    case 'stream':
      return (async function*() {
        let output: TDecoded | undefined = undefined;
        for await (const event of stream) {
          yield event;
          if (event.type === 'complete') {
            output = event.output;
          }
        }
        return output;
      })() as PromptGet<TGetType, TDecoded, TTools>;
    case 'streamTools':
      return (async function*() {
        let output: TDecoded | undefined = undefined;
        for await (const event of stream) {
          if (event.type === 'toolOutput') {
            yield { tool: event.tool.name, result: event.result } as PromptToolOutput<TTools>;
          }
          if (event.type === 'complete') {
            output = event.output;
          }
        }
        return output;
      })() as PromptGet<TGetType, TDecoded, TTools>;
    case 'streamContent':
      return (async function*() {
        let output: TDecoded | undefined = undefined;
        for await (const event of stream) {
          if (event.type === 'textPartial') {
            yield event.content;
          }
          if (event.type === 'complete') {
            output = event.output;
          }
        }
        return output;
      })() as PromptGet<TGetType, TDecoded, TTools>;
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
  >(...[inputMaybe, contextMaybe]: OptionalParams<[TInput, TCoreContext]>): AsyncGenerator<PromptEvent<TDecoded, TTools>, TDecoded | undefined, unknown> {
    const input = (inputMaybe || {}) as TInput;
    const ctx = (contextMaybe || {}) as Context<TContext, TMetadata>;
    const prompt = this as Component<TContext, TMetadata, TName, TInput, AsyncGenerator<PromptEvent<TDecoded, TTools>, TDecoded | undefined, unknown>, TTools>;

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
  metadata(): TMetadata;
  metadata<
    TRuntimeContext extends TContext,
    TRuntimeMetadata extends TMetadata,
    TCoreContext extends Context<TRuntimeContext, TRuntimeMetadata>,
  >(input?: TInput, ctx?: TCoreContext): Promise<TMetadata>;
  metadata<
    TRuntimeContext extends TContext,
    TRuntimeMetadata extends TMetadata,
    TCoreContext extends Context<TRuntimeContext, TRuntimeMetadata>,
  >(input?: TInput, ctx?: TCoreContext): TMetadata | Promise<TMetadata> {
    // If both input and context are not specified, just return static metadata
    if (input === undefined && ctx === undefined) {
      return (this.input.metadata || {}) as TMetadata;
    }

    const actualInput = (input || {}) as TInput;
    const actualCtx = (ctx || {}) as Context<TContext, TMetadata>;

    return this.metadataFn(actualInput, actualCtx).then(dynamicMetadata => ({
      ...(this.input.metadata || {} as TMetadata),
      ...(dynamicMetadata || {}),
    } as TMetadata));
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
      Events<Component<TRuntimeContext, TRuntimeMetadata, TName, TInput, AsyncGenerator<PromptEvent<TDecoded, TTools>, TDecoded | undefined, unknown>, TTools>> | undefined,
      TCoreContext, 
    ]>
  ): AsyncGenerator<PromptEvent<TDecoded, TTools>, TDecoded | undefined, unknown> {
    const input = (inputMaybe || {}) as TInput;
    const events = (eventsMaybe || {}) as Events<Component<TContext, TMetadata, TName, TInput, AsyncGenerator<PromptEvent<TDecoded, TTools>, TDecoded | undefined, unknown>, TTools>>;
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
    const toolsComplete = this.input.toolsComplete ?? true;

    let result: TDecoded | undefined = undefined;
    let lastError: string | undefined = undefined;
    let completeText: string = '';
    let maxIterations = outputRetries + forgetRetries + toolIterations + toolRetries + 1;
    let requestUsageSent = false;
    let usage: Usage | undefined = undefined;
    let iterations = 0;
    let accumulatedUsage: Usage = {};
    let suspended = false;

    // Track stats for reconfig
    let toolParseErrors = 0;
    let toolCallErrors = 0;
    let toolSuccesses = 0;
    const toolsCalled = new Set<string>();

    // Emit is a helper to optionally emit events and return the value passed in so it can be yielded.
    const emit = events?.onPromptEvent && ctx.instance
      ? (ev: PromptEvent<TDecoded, TTools>) => {
          // @ts-ignore
          events.onPromptEvent!(ctx.instance!, ev as any);
          return ev;
        }
      : (ev: PromptEvent<TDecoded, TTools>) => ev;
    const emitTool = (ev: PromptToolEvents<[AnyTool]>) => emit(ev as PromptEvent<TDecoded, TTools>);
    const emitMessage = (message: Message) => {
      request.messages.push(message);
      return emit({ type: 'message', message, request });
    };

    // Main execution loop!
    while (iterations < maxIterations) {
      // Honor the caller's abort signal at iteration boundaries — if a
      // tool dispatch already paired its tool_calls via the synthesis
      // pass on the previous iteration, there's no reason to start
      // another round-trip. Without this guard the loop would spin
      // until `maxIterations` because each inner stream call would
      // immediately observe `signal.aborted`, yield nothing, and fall
      // through to "no tool calls" — wasting time and tokens for an
      // already-cancelled request.
      if (ctx.signal?.aborted) break;
      const toolExecutors: ToolExecution<PromptTools<TTools>>[] = [];
      const toolExecutorMap = new Map<string, ToolExecution<PromptTools<TTools>>>();
      const toolErrorsPrevious = (toolCallErrors + toolParseErrors);
      const toolParseErrorsPrevious = toolParseErrors;

      let finishReason: FinishReason | undefined = undefined;
      let refusal = '';
      let reasoning: Reasoning | undefined = undefined;
      let content = '';
      let disableTools = false;

      const streamController = new AbortController();
      const streamAbort = () => streamController.abort();

      ctx.signal?.addEventListener('abort', streamAbort);

      const metadata: TMetadata = {
        ...(this.input.metadata || {} as TMetadata),
        ...(await this.metadataFn(input, ctx) || {}),
      };

      yield emit({ type: 'request', request, iterations });

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
          reasoning = accumulateReasoning(reasoning, chunk.reasoning)!;
          yield emit({ type: 'reasonPartial', reasoning, request });
        }

        // Handle tool calls
        if (chunk.toolCallNamed) {
          const toolExecutor = newToolExecution(
            ctx,
            chunk.toolCallNamed,
            toolMap.get(chunk.toolCallNamed.name),
            this.input.validationErrorMaxLength,
            this.truncateValidationError.bind(this),
          );
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
            if (toolCall.emitInterrupt()) {
              yield emitTool({ type: 'toolInterrupt', tool: toolCall.tool!, args: toolCall.args, request });
            }
            if (toolCall.emitSuspend()) {
              yield emitTool({ type: 'toolSuspend', tool: toolCall.tool!, args: toolCall.args, request });
            }
            if (toolCall.emitError()) {
              yield emitTool({ type: 'toolError', tool: toolCall.tool!, args: toolCall.args, error: toolCall.error!, rawArgs: toolCall.rawArgs, request })
            }
          }
        }
      }

      ctx.signal?.removeEventListener('abort', streamAbort);

      // If the model reasoned, yield it
      if (reasoning) {
        yield emit({ type: 'reason', reasoning, request });
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
        yield emitMessage({
          role: 'assistant',
          content,
          toolCalls: toolExecutors.map(te => te.toolCall),
          reasoning,
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
          if (toolExecutor.emitRepairAttempt()) {
            yield emit({ type: 'toolArgRepairAttempt', tool: toolExecutor.tool!, fields: toolExecutor.repairAttempt!.fields, success: toolExecutor.repairAttempt!.success, request });
          }
          if (toolExecutor.emitStart()) {
            yield emitTool({ type: 'toolStart', tool: toolExecutor.tool!, args: toolExecutor.args, request });
          }
          if (toolExecutor.emitError()) {
            yield emitTool({ type: 'toolError', tool: toolExecutor.tool!, args: toolExecutor.args, error: toolExecutor.error!, rawArgs: toolExecutor.rawArgs, request })
          }
        }

        // The execution mode for this iteration.
        const iterationMode = skip ? 'skip' : toolMode;

        // All tool calls are valid, lets start this!
        switch (iterationMode) {
          case 'sequential':
            for (const toolExecutor of toolExecutors) {
              // Abort-aware dispatch — once the caller's signal trips,
              // stop starting subsequent tools so Ctrl+C unwinds within
              // ~1 tool's duration instead of grinding through the rest
              // of the batch. The synthesis pass below pairs every
              // unstarted tool_call with an `[aborted]` placeholder.
              // We check `ctx.signal` directly (not the streamController
              // relay) because the relay's listener was already
              // removed by the time tool dispatch runs.
              if (ctx.signal?.aborted) break;
              await toolExecutor.parse();
              if (toolExecutor.emitRepairAttempt()) {
                yield emit({ type: 'toolArgRepairAttempt', tool: toolExecutor.tool!, fields: toolExecutor.repairAttempt!.fields, success: toolExecutor.repairAttempt!.success, request });
              }
              if (toolExecutor.emitStart()) {
                yield emitTool({ type: 'toolStart', tool: toolExecutor.tool!, args: toolExecutor.args, request });
              }
              await toolExecutor.run();
              if (toolExecutor.emitOutput()) {
                yield emitTool({ type: 'toolOutput', tool: toolExecutor.tool!, args: toolExecutor.args, result: toolExecutor.result, request });
              }
              if (toolExecutor.emitInterrupt()) {
                yield emitTool({ type: 'toolInterrupt', tool: toolExecutor.tool!, args: toolExecutor.args, request });
              }
              if (toolExecutor.emitSuspend()) {
                yield emitTool({ type: 'toolSuspend', tool: toolExecutor.tool!, args: toolExecutor.args, request });
              }
              if (toolExecutor.emitError()) {
                yield emitTool({ type: 'toolError', tool: toolExecutor.tool!, args: toolExecutor.args, error: toolExecutor.error!, rawArgs: toolExecutor.rawArgs, request })
              }
            }
            break;
          case 'parallel':
          case 'immediate':
            const parseRuns = toolExecutors.map(tc => [tc.parse(), tc.run()]).flat();
            for await (const { result: toolCallPromise } of yieldAll(parseRuns)) {
              // The promises in `parseRuns` were started eagerly, so
              // tools already in flight will keep running in the
              // background (orphaned). What we control here is whether
              // we accumulate their results / emit their events. Bail
              // on abort so the caller doesn't have to wait for stragglers
              // to finish — synthesis below covers any unpaired tool_call.
              // (We check `ctx.signal` directly — streamController's
              // listener was already removed before tool dispatch.)
              if (ctx.signal?.aborted) break;
              const toolExecutor = await toolCallPromise;
              if (toolExecutor.emitRepairAttempt()) {
                yield emit({ type: 'toolArgRepairAttempt', tool: toolExecutor.tool!, fields: toolExecutor.repairAttempt!.fields, success: toolExecutor.repairAttempt!.success, request });
              }
              if (toolExecutor.emitStart()) {
                yield emitTool({ type: 'toolStart', tool: toolExecutor.tool!, args: toolExecutor.args, request });
              }
              if (toolExecutor.emitOutput()) {
                yield emitTool({ type: 'toolOutput', tool: toolExecutor.tool!, args: toolExecutor.args, result: toolExecutor.result, request });
              }
              if (toolExecutor.emitInterrupt()) {
                yield emitTool({ type: 'toolInterrupt', tool: toolExecutor.tool!, args: toolExecutor.args, request });
              }
              if (toolExecutor.emitSuspend()) {
                yield emitTool({ type: 'toolSuspend', tool: toolExecutor.tool!, args: toolExecutor.args, request });
              }
              if (toolExecutor.emitError()) {
                yield emitTool({ type: 'toolError', tool: toolExecutor.tool!, args: toolExecutor.args, error: toolExecutor.error!, rawArgs: toolExecutor.rawArgs, request })
              }
            }
            break;
        }

        // Emit tool results for every executor. The pairing guarantee:
        // every assistant `tool_calls[i]` pushed by this block must
        // have a matching `role: 'tool'` entry by the end of the loop,
        // otherwise the next round-trip 400s (OpenAI / Anthropic both
        // reject unpaired tool_calls).
        //
        // - `suspended`: skipped on purpose (suspend/resume relies on
        //   the missing slot to know which tool to resume).
        // - incomplete (`ready` / `parsed` / `executing` / `interrupted`
        //   without an error string): no real content. With
        //   `toolsComplete: true` (default) we synthesize a marker
        //   (`[aborted: …]`, `[interrupted]`) so the model knows WHY
        //   the slot is empty. With `toolsComplete: false` we omit
        //   the message entirely — the caller is on their own.
        // - complete (`success` / `error` / `invalid` / `interrupted`
        //   with an error string): emit the real result / error.
        let anySuspended = false;
        for (const toolExecutor of toolExecutors) {
          if (toolExecutor.status === 'suspended') {
            anySuspended = true;
            continue;
          }
          const hasError = !!toolExecutor.error;
          const hasResult = toolExecutor.result !== undefined && toolExecutor.result !== null;
          const isComplete = hasError || hasResult || toolExecutor.status === 'success';
          if (!isComplete && !toolsComplete) {
            // Opt-out — leave the unfinished tool_call without a
            // paired result. Caller has accepted responsibility for
            // handling the broken history shape (e.g. they're about
            // to discard the request entirely, or they have their
            // own retry logic).
            continue;
          }
          const content = hasError
            ? toolExecutor.error!
            : hasResult
              ? typeof toolExecutor.result === 'string'
                ? toolExecutor.result
                : JSON.stringify(toolExecutor.result)
              : this.synthesizeUnpairedResult(toolExecutor);

          yield emitMessage({
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

        if (anySuspended) {
          suspended = true;
          break;
        }

        if ((toolCallErrors + toolParseErrors) > toolErrorsPrevious) {
          if (toolRetries > 0) {
            toolRetries--;
          } else {
            disableTools = true;
          }
        }
      } else {
        // No tool calls, just add the assistant response
        yield emitMessage({
          role: 'assistant',
          content,
          reasoning,
        });
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

      // Determine if we should stop
      const stop = finishReason === 'stop' && toolExecutors.length === 0 ||
        toolExecutors.some(toolExecutor => toolExecutor.status === 'interrupted');

      // If we are finished, parse the output
      if (stop) {
        if (!schema || (schema instanceof ZodString)) {
          result = content as unknown as TDecoded;

          break; // All good!
        } else {
          // Grab the JSON part from the content just in case...
          const potentialJSON = content.substring(
            content.indexOf('{'),
            content.lastIndexOf('}') + 1
          );

          let errorMessage = '';
          let resetReason = '';
          const errMax = this.input.validationErrorMaxLength;
          try {
            const parsedJSON = JSON.parse(potentialJSON);

            if (this.input.parse) {
              // Custom parser REPLACES Zod validation of the structured
              // output entirely. Mirrors Tool.parse's `parse` hook: the raw
              // JSON.parse-d value goes straight to the caller's parser,
              // which returns the typed TOutput on success or an Error
              // (returned OR thrown) carrying rich, compiler-style
              // diagnostics. Zod (and the descriptor strictify) is skipped.
              // A returned/thrown Error flows through the SAME output-retry
              // channel a Zod failure would, surfacing its own `.message`
              // (no Zod vocabulary — Zod never ran). Absent ⇒ unchanged.
              let customResult: TDecoded | Error;
              try {
                customResult = await this.input.parse(parsedJSON, ctx);
              } catch (customError: any) {
                customResult = customError instanceof Error ? customError : new Error(String(customError));
              }
              if (customResult instanceof Error) {
                errorMessage = this.truncateValidationError(customResult.message, errMax);
                resetReason = 'schema-parsing';
              } else {
                result = customResult;

                try {
                  await this.input.validate?.(result, ctx);
                } catch (validationError: any) {
                  errorMessage = this.truncateValidationError(
                    `The output failed validation:\n${validationError.message}`,
                    errMax,
                  );
                  resetReason = 'validation';
                }
              }
            } else {
            // Apply the same strictify rewrite the provider used for the wire
            // shape, so array-of-pairs records / numeric-key tuples / etc.
            // normalize back into the natural Zod shape before validation.
            // The descriptor was pinned on the response format when the
            // provider built the request. Fast cache lookup on retries.
            const responseDescriptorId = typeof request.responseFormat === 'object'
              ? request.responseFormat.descriptor
              : undefined;
            const validationSchema = responseDescriptorId
              ? strictify(schema, getDescriptorById(responseDescriptorId)) as typeof schema
              : schema;

            const parsedSafe = await validationSchema.safeParseAsync(parsedJSON);
            if (!parsedSafe.success) {
              const issueSummary = parsedSafe.error.issues
                .map(i => `- ${i.path.join('.')}: ${i.message}${['string', 'boolean', 'number'].includes(typeof i.input) ? ` (input: ${i.input})` : ''}`)
                .join('\n')
              errorMessage = this.truncateValidationError(
                `The output was an invalid format:\n${issueSummary}`,
                errMax,
              );
              resetReason = 'schema-parsing';
            } else {
              result = parsedSafe.data as unknown as TDecoded;

              try {
                await this.input.validate?.(result, ctx);
              } catch (validationError: any) {
                errorMessage = this.truncateValidationError(
                  `The output failed validation:\n${validationError.message}`,
                  errMax,
                );
                resetReason = 'validation';
              }
            }
            }
          } catch (parseError: any) {
            errorMessage = this.truncateValidationError(
              `The output was not valid JSON:\n${parseError.message}`,
              errMax,
            );
            resetReason = 'json-parsing';
          }

          if (errorMessage) {
            if (outputRetries > 0) {
              outputRetries--;

              yield emit({ type: 'textReset', reason: resetReason, request });

              yield emitMessage({
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

    // If the prompt was suspended by a tool, emit a suspend event.
    // request.messages at this point ends with the assistant tool-call message and any
    // completed tool results; the suspended tool's result is absent and must be supplied on resume.
    // The caller can save request.messages, append the pending tool result, and re-run.
    // Returns undefined (not TOutput) — the prompt has not produced a final result yet.
    if (suspended) {
      yield emit({ type: 'suspend', request });
      return undefined;
    }

    // We don't emit complete without a valid result unless toolsOnly is set
    if (result === undefined && !onlyTools) {
      // Abort is not an error — the caller asked us to stop. Exit
      // silently with the partial `request.messages` they may want
      // for resume/inspection, without emitting `complete` (no real
      // output to surface) and without raising. Mirrors the suspend
      // path's `return undefined` semantics.
      if (ctx.signal?.aborted) {
        return undefined as any;
      }
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
      ? { type: schema as ZodType<object, object>, strict: this.input.strict ?? 1 }
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
   * Truncate a validation error so the corrective user message we send back
   * to the LLM stays bounded. Lengthy zod errors against deep recursive
   * schemas can run 100k+ characters — eating context and burning tokens
   * on noise the model can't usefully act on. Anything past `max` is
   * replaced with a `… (N more characters)` marker so the LLM both knows
   * the message was clipped and roughly how much was lost.
   *
   * `protected` so a subclass can override — e.g. to emit a shorter
   * marker, route errors through a custom formatter, or skip truncation
   * entirely when targeting a model with a large context window.
   */
  protected truncateValidationError(message: string, max?: number): string {
    const cap = max ?? DEFAULT_VALIDATION_ERROR_MAX_LENGTH;
    if (cap <= 0 || message.length <= cap) return message;
    const dropped = message.length - cap;
    return `${message.slice(0, cap)}… (${dropped} more characters)`;
  }

  /**
   * Build a short, model-readable placeholder for a `tool_call` that
   * never produced a real result. Used by the result-emit loop when
   * `toolsComplete` is true to keep `request.messages` well-paired
   * even when the dispatch loop short-circuited (signal abort or
   * `ToolInterrupt` cutting a parallel batch short) or a tool errored
   * before its content could be accumulated.
   *
   * The marker prefix (`[aborted: …]`, `[interrupted]`, `[error: …]`)
   * gives the model a clear cue and lets callers detect synthesized
   * replies by inspecting the message content if they need to
   * differentiate. Suspended tools are intentionally NOT routed
   * through here — the suspend/resume protocol depends on the
   * missing result slot.
   *
   * `protected` so a subclass can override — e.g. to emit
   * project-specific markers, log diagnostics for every synthesized
   * result, or fall back to a model-specific instruction string.
   */
  protected synthesizeUnpairedResult<T extends ToolCompatible<any, any>>(
    te: ToolExecution<T>,
  ): string {
    switch (te.status) {
      case 'interrupted':
        return te.error
          ? `[interrupted: ${te.error}]`
          : '[interrupted]';
      case 'error':
      case 'invalid':
        return te.error
          ? `[error: ${te.error}]`
          : '[error]';
      case 'ready':
      case 'parsed':
      case 'executing':
        // Never reached a terminal status — the dispatch loop cut out
        // mid-flight (abort or interrupt of a sibling).
        return '[aborted: tool call did not complete before the request was cancelled]';
      default:
        return '[no result]';
    }
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

type ToolStatus = 'ready' | 'parsed' | 'invalid' | 'executing' | 'success' | 'error' | 'interrupted' | 'suspended';

type ToolExecution<T> = {
  toolCall: ToolCall;
  tool?: T;
  definition?: ToolDefinition;
  status: ToolStatus;
  emitStart(): boolean;
  emitOutput(): boolean;
  emitError(): boolean;
  emitInterrupt(): boolean;
  emitSuspend(): boolean;
  /** Returns true exactly once after the arg-parse fallback ran a
   *  repair attempt. Lets the surrounding prompt loop emit a
   *  `toolArgRepairAttempt` telemetry event regardless of outcome
   *  (we WANT visibility into model misbehavior; the prior name
   *  `emitRepaired` suggested success-only, which was wrong). */
  emitRepairAttempt(): boolean;
  parse: () => Promise<ToolExecution<T>>;
  run: () => Promise<ToolExecution<T>>;
  args?: any;
  result?: any;
  error?: string;
  /** Diagnostic info from the parse-fallback when it ran a repair
   *  attempt. `fields` lists which top-level string fields were
   *  JSON.parse-d; `success` says whether the schema accepted the
   *  repaired value (false → original error was rethrown). */
  repairAttempt?: { fields: ReadonlyArray<string>; success: boolean };
  /** Raw, untruncated argument string the model sent. Populated when
   *  arg parsing fails so the surrounding loop can attach the full
   *  payload to the `toolError` event for log post-mortems — the
   *  model-facing `error` string is truncated, but our log isn't. */
  rawArgs?: string;
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

function newToolExecution<T extends AnyTool>(
  ctx: Context<any, any>,
  toolCall: ToolCall,
  toolInfo?: { tool: T, definition: ToolDefinition },
  validationErrorMaxLength?: number,
  // Pluggable truncator — the owning Prompt instance forwards its
  // (overridable) `truncateValidationError` method here so a subclass
  // can change how tool-arg parse errors are formatted without having
  // to fork the whole prompt loop.
  truncate?: (message: string, max?: number) => string,
) {
  const start = emitter();
  const output = emitter();
  const error = emitter();
  const interrupt = emitter();
  const suspend = emitter();
  const repairAttempt = emitter();

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
    emitInterrupt: interrupt.emit,
    emitSuspend: suspend.emit,
    emitRepairAttempt: repairAttempt.emit,
    parse: once(async () => {
      // Already ran or failed earlier?
      if (execution.status !== 'ready') {
        return execution;
      }
      const rawArgs = execution.toolCall.arguments;
      const isEmpty = !rawArgs || rawArgs.trim() === '';
      const args = isEmpty ? '{}' : rawArgs;
      try {
        execution.args = await toolInfo!.tool.parse(
          ctx,
          args,
          toolInfo!.definition.parameters,
          toolInfo!.definition.descriptor,
          (info) => {
            // String-encoded-field fallback ran a repair attempt
            // (success OR failure). Stash the outcome so the outer
            // loop can emit `toolArgRepairAttempt`. Keeping failures
            // visible matters as much as successes — they tell us the
            // model double-encoded AND the inner content was also
            // bad, which is a different bug than either alone.
            execution.repairAttempt = info;
            repairAttempt.ready = true;
          },
        );
        execution.status = 'parsed';
        start.ready = true;
      } catch (e: any) {
        execution.status = 'invalid';
        // Preserve the untruncated raw args alongside the truncated
        // model-facing error so the diagnostic log gets the full
        // payload (post-mortem reproduction is impossible without it).
        execution.rawArgs = args;
        // Distinguish "model sent no arguments at all" from "model sent
        // bad arguments". The former is usually a streaming-relay issue
        // (OpenRouter/Anthropic) or a genuine model gaffe — calling it
        // out by name in the error gives the model a clearer cue to
        // fix itself on the retry turn instead of repeating the empty
        // call. The latter (bad arguments) keeps its original Zod /
        // JSON.parse message, which already names the offending field.
        const reason = isEmpty
          ? `the tool was called with NO arguments. The schema requires arguments — re-call this tool with the required fields populated. Validation: ${e.message}`
          : `${e.message}, args: ${args}`;
        const formatted = `Error parsing tool arguments: ${reason}`;
        execution.error = truncate
          ? truncate(formatted, validationErrorMaxLength)
          : formatted;
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
        execution.result = await resolve(toolInfo!.tool.run(execution.args, { ...ctx, toolCallId: toolCall.id }));
        execution.status = 'success';
        output.ready = true;
      } catch (e: any) {
        if (e instanceof PromptSuspend) {
          execution.status = 'suspended';
          suspend.ready = true;
        } else if (e instanceof ToolInterrupt) {
          execution.status = 'interrupted';
          interrupt.ready = true;
        } else {
          execution.status = 'error';
          execution.error = `Error executing tool: ${e.message}, args: ${JSON.stringify(execution.args)}`;
          error.ready = true;
        }
      }

      return execution;
    }),
  };

  return execution;
};


