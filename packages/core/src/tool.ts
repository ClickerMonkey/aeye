import Handlebars from 'handlebars';
import { ZodType } from 'zod';
import { Fn, resolveFn } from './common';
import { FormatDescriptor, getDescriptorById, strictify } from './schema';
import { Component, ComponentCompatible, Context, OptionalParams, ToolDefinition, Tuple } from './types';
    
/**
 * Configuration for creating a Tool component.
 * Tools extend AI capabilities by allowing interaction with external systems, APIs, or custom logic.
 *
 * @template TContext - The context type needed for the tool's operation.
 * @template TMetadata - The metadata type needed during execution/streaming.
 * @template TName - The name of the tool, typed for inference in parent components.
 * @template TParams - The input parameters type for the tool.
 * @template TOutput - The output type for the tool.
 * @template TRefs - References to other components that this tool depends on.
 */
export interface ToolInput<
  TContext,
  TMetadata,
  TName extends string,
  TParams extends object,
  TOutput,
  TRefs extends Tuple<ComponentCompatible<TContext, TMetadata>>,
> {
  /** The unique name of the tool */
  name: TName;
  /** Brief description of the tool's purpose (passed to the AI model) */
  description: string;
  /** Optional function that returns the tool's description based on the context. The description is required for AI components but this allows the description to be refined before execution based on the context. */
  descriptionFn?: Fn<string, [Context<TContext, TMetadata>]>;
  /** Instructions on how to use the tool, written in Handlebars format */
  instructions?: string;
  /** Optional function that returns the tool's instructions based on the context */
  instructionsFn?: Fn<string, [Context<TContext, TMetadata>]>;
  /** Optional function that returns variables for the instructions Handlebars template */
  input?: Fn<Record<string, any>, [Context<TContext, TMetadata>]>;
  /** Zod schema defining the tool's input parameters */
  schema: Fn<ZodType<TParams> | undefined, [Context<TContext, TMetadata>]>;
  /**
   * Strict-mode policy for this tool's schema. Tri-state, with `1` (best-effort
   * preference) as the default when omitted:
   *
   * - `true` — REQUIRE strict. Selection filters out models without the
   *   matching strict-tool family; if no model qualifies the request fails.
   * - `false` — FORCE lenient. Schema is emitted as standard JSON Schema
   *   regardless of model capability, no `strict: true` flag on the wire.
   * - `number > 0` (default `1`) — PREFER strict; tolerate fallback. The
   *   number is a priority — higher means more wanted. Selection biases
   *   toward strict-capable models (optional capability). At request build
   *   time the `SchemaBudget` allocates strict slots in priority order;
   *   tools that don't fit fall back to lenient silently.
   *
   * Note: the legacy default of `true` was changed to `1` in v2 to keep
   * "it just works" against unknown/unannotated models. Set `strict: true`
   * explicitly when strict is non-negotiable.
   */
  strict?: boolean | number;
  /** References to other components (tools, prompts, agents) that this tool utilizes */
  refs?: TRefs;
  /** The function that implements the tool's behavior */
  call: (input: TParams, refs: TRefs, ctx: Context<TContext, TMetadata>) => TOutput;
  /** Optional post-validation hook that runs after Zod parsing succeeds. Can throw to trigger re-prompting. */
  validate?: (input: TParams, ctx: Context<TContext, TMetadata>) => void | Promise<void>;
  /** Optional function to determine if the component is applicable in the given context */
  applicable?: <
    TRuntimeContext extends TContext, 
    TRuntimeMetadata extends TMetadata
  >(ctx: Context<TRuntimeContext, TRuntimeMetadata>) => boolean | Promise<boolean>;
  /** Metadata about the tool to be passed during execution/streaming. Typically contains requirements, configuration, etc. */
  metadata?: TMetadata;
  /** A function/promise that returns metadata about the tool to be passed during execution/streaming. */
  metadataFn?: (input: TParams, ctx: Context<TContext, TMetadata>) => TMetadata | Promise<TMetadata>;
  /** Optional way to explicitly declare the types used in this component */
  types?: {
    params?: TParams;
    output?: TOutput;
    context?: TContext;
    metadata?: TMetadata;
  },
}

/**
 * A type representing any tool.
 */
export type AnyTool = Tool<any, any, any, any, any, any>;

/**
 * A type representing a tool compatible with the given context and metadata.
 */
export type ToolCompatible<TContext, TMetadata> = Tool<TContext, TMetadata, any, any, any, any>;

/**
 * Error class used to indicate that a prompt should be interrupted and control returned to the caller.
 */
export class ToolInterrupt extends Error {
  constructor(message: string = 'Tool execution interrupted') {
    super(message);
    this.name = 'ToolInterrupt';
  }
}

/**
 * Error class used to indicate that a prompt should be suspended at the current tool call point.
 * 
 * When a tool throws `PromptSuspend`, the prompt loop stops without adding tool results to the
 * message history. The caller receives a `suspend` event containing the messages up to (and 
 * including) the assistant message with tool calls. This allows the caller to save the prompt
 * state, process the tool call externally (e.g. await user approval), and later resume by
 * providing the saved messages plus the tool results back into the prompt as `ctx.messages`.
 * 
 * @example
 * // In a tool that needs approval before continuing:
 * call: async (input, _, ctx) => {
 *   const needsApproval = await checkApproval(input);
 *   if (needsApproval) {
 *     throw new PromptSuspend('Waiting for user approval');
 *   }
 *   return performAction(input);
 * }
 * 
 * // Resuming after approval:
 * // 1. Catch the `suspend` event and save `event.messages`
 * // 2. When ready, append tool result messages to the saved messages
 * // 3. Re-run the prompt with the saved + result messages as `ctx.messages`
 */
export class PromptSuspend extends Error {
  constructor(message: string = 'Prompt execution suspended') {
    super(message);
    this.name = 'PromptSuspend';
  }
}

/**
 * A Tool component that performs specific functions, often interacting with external systems or APIs.
 * Tools can be called by AI models to extend their capabilities beyond text generation.
 *
 * @template TContext - The context type needed for the tool's operation.
 * @template TMetadata - The metadata type needed during execution/streaming.
 * @template TName - The name of the tool, typed for inference in parent components.
 * @template TParams - The input parameters type for the tool.
 * @template TOutput - The output type for the tool.
 * @template TRefs - References to other components that this tool depends on.
 *
 * @example
 * const weatherTool = new Tool({
 *   name: 'getWeather',
 *   description: 'Get current weather for a location',
 *   instructions: 'Use this tool to get weather information for {{location}}',
 *   schema: z.object({ location: z.string() }),
 *   call: async (input) => {
 *     const response = await fetch(`/api/weather?loc=${input.location}`);
 *     return response.json();
 *   }
 * });
 */
export class Tool<
  TContext = {},
  TMetadata = {},
  TName extends string = string,
  TParams extends object = {},
  TOutput = string,
  TRefs extends Tuple<ComponentCompatible<TContext, TMetadata>> = [],
> implements Component<TContext, TMetadata, TName, TParams, TOutput, TRefs> {

  /**
   * Compiles the instructions template with or without input variables.
   *
   * @param instructions - The instructions template string.
   * @param hasInput - Whether the tool has input variables.
   * @returns A compiled Handlebars template function or a simple string returner.
   */
  static compileInstructions(instructions: string, hasInput: boolean) {
    return hasInput ? Handlebars.compile(instructions, { noEscape: true }) : () => instructions;
  }

  /**
   * Creates a new Tool instance.
   *
   * @param input - The tool input configuration.
   */
  constructor(
    public input: ToolInput<TContext, TMetadata, TName, TParams, TOutput, TRefs>,
    private instructions = input.instructions ? Tool.compileInstructions(input.instructions, !!input.input) : undefined,
    // Schema stays raw. The provider applies the matching strictify lazily
    // once it knows the chosen model's strict-tools format (descriptor).
    private schema = resolveFn(input.schema),
    private translate = resolveFn(input.input),
    private descriptionFn = resolveFn(input.descriptionFn),
    private instructionsFn = resolveFn(input.instructionsFn, (r) => r ? Tool.compileInstructions(r, !!input.input) : undefined),
    private metadataFn = resolveFn(input.metadataFn),
  ) {
  }

  get kind(): 'tool' {
    return 'tool';
  }

  get name(): TName {
    return this.input.name;
  }

  get description(): string {
    return this.input.description;
  }

  get refs(): TRefs {
    return this.input.refs || [] as unknown as TRefs;
  }

  /**
   * Parses and validates the input arguments using the tool's Zod schema.
   * Also runs any custom validation defined in the tool configuration.
   *
   * @param ctx - The context for parsing.
   * @param args - The input arguments as a JSON string.
   * @param schema - Optional pre-compiled schema to use instead of resolving it again.
   * @returns The parsed and validated input parameters.
   * @throws Error if schema is not available or parsing/validation fails.
   */
  async parse(
    ctx: Context<TContext, TMetadata>,
    args: string,
    schema?: ZodType<TParams>,
    descriptor?: FormatDescriptor | string,
  ): Promise<TParams> {
    let resolvedSchema = schema || await this.schema(ctx);

    if (!resolvedSchema) {
      throw new Error(`Not able to build a schema to parse arguments for ${this.input.name}`);
    }

    // Apply the strictify rewrite that matches the provider's chosen wire
    // dialect. The cache makes repeated calls O(1).
    if (descriptor) {
      const fd = typeof descriptor === 'string' ? getDescriptorById(descriptor) : descriptor;
      resolvedSchema = strictify(resolvedSchema, fd);
    }

    const parsed = await resolvedSchema.parseAsync(JSON.parse(args));

    // Run post-validation hook if provided
    if (this.input.validate) {
      await this.input.validate(parsed, ctx);
    }

    return parsed;
  }

  /**
   * Compiles the tool's instructions and schema into a ToolDefinition.
   * This creates the format needed to pass tool information to AI models.
   *
   * @param ctx - The context for compilation.
   * @returns A tuple of [instructions, toolDefinition] or undefined if not applicable.
   */
  async compile(ctx: Context<TContext, TMetadata>): Promise<readonly [string, ToolDefinition] | undefined> {
    const parameters = await this.schema(ctx);
    if (!parameters) {
      return undefined;
    }

    // Get instructions template
    const instructionsTemplate = this.input.instructionsFn
      ? await this.instructionsFn(ctx) 
      : this.instructions;

    // If no instructions function/template, return undefined
    if (!instructionsTemplate) {
      return undefined;
    }

    // Get template variables if input function is provided
    const templateVars = await this.translate(ctx) || {};
    const instructions = instructionsTemplate(templateVars)
    
    // Get dynamic description if function is provided
    const description = await this.descriptionFn(ctx) || this.input.description;
    // Default to numeric priority 1 (best-effort preference) instead of
    // boolean true. See ToolInput.strict JSDoc for the tri-state semantics.
    const strict: boolean | number = this.input.strict ?? 1;

    return [
      instructions,
      {
        name: this.input.name,
        description,
        parameters,
        strict,
      },
    ] as const;
  }

  /**
   * Executes the tool with the given context and input.
   * If a custom runner is provided in the context, it will be used instead of direct execution.
   *
   * @param input - The input parameters for the tool.
   * @param ctx - The execution context.
   * @returns The output of the tool's execution.
   */
  run<
    TRuntimeContext extends TContext, 
    TRuntimeMetadata extends TMetadata,
    TCoreContext extends Context<TRuntimeContext, TRuntimeMetadata>,
  >(...[inputMaybe, contextMaybe]: OptionalParams<[TParams, TCoreContext]>): TOutput {
    const input = (inputMaybe || {}) as TParams;
    const ctx = (contextMaybe || {}) as Context<TContext, TMetadata>;
    const tool = this as Component<TContext, TMetadata, TName, TParams, TOutput, TRefs>;

    return ctx.runner
      ? ctx.runner(tool, input, ctx, (innerCtx) => this.input.call(input, this.refs, innerCtx))
      : this.input.call(input, this.refs, ctx);
  }

  /**
   * Determines whether the tool is applicable in the given context.
   * By default, checks if the schema is available and if any referenced components are applicable.
   *
   * @param ctx - The context to check applicability against.
   * @returns A promise that resolves to true if the tool is applicable, false otherwise.
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
    if (await this.schema(ctx) === undefined) {
      return false;
    }

    // If there are no refs, the tool is self-contained and applicable
    if (this.refs.length === 0) {
      return true;
    }

    return await Promise.all(this.refs.map(ref => ref.applicable(ctx))).then(results => results.some(r => r));
  }

  /**
   * Returns metadata for the tool based on the input and context.
   * Combines static metadata with dynamically generated metadata from metadataFn.
   *
   * @param input - The input for the tool.
   * @param ctx - The context for the tool's operation.
   * @returns The metadata for the tool.
   */
  metadata(): TMetadata;
  metadata<
    TRuntimeContext extends TContext,
    TRuntimeMetadata extends TMetadata,
    TCoreContext extends Context<TRuntimeContext, TRuntimeMetadata>,
  >(input?: TParams, ctx?: TCoreContext): Promise<TMetadata>;
  metadata<
    TRuntimeContext extends TContext,
    TRuntimeMetadata extends TMetadata,
    TCoreContext extends Context<TRuntimeContext, TRuntimeMetadata>,
  >(input?: TParams, ctx?: TCoreContext): TMetadata | Promise<TMetadata> {
    // If both input and context are not specified, just return static metadata
    if (input === undefined && ctx === undefined) {
      return (this.input.metadata || {}) as TMetadata;
    }

    const actualInput = (input || {}) as TParams;
    const actualCtx = (ctx || {}) as Context<TContext, TMetadata>;

    return this.metadataFn(actualInput, actualCtx).then(dynamicMetadata => ({
      ...(this.input.metadata || {} as TMetadata),
      ...(dynamicMetadata || {}),
    } as TMetadata));
  }

}