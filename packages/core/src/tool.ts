import Handlebars from 'handlebars';
import { ZodType } from 'zod';
import { Fn, resolveFn } from './common';
import { strictify } from './schema';
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
  /** Whether to require AI to strictly follow the schema. True bu default. */
  strict?: boolean;
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
    private schema = resolveFn(input.schema, (s) => s && input.strict !== false ? strictify(s) as ZodType<TParams> : s),
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
  async parse(ctx: Context<TContext, TMetadata>, args: string, schema?: ZodType<TParams>): Promise<TParams> {
    let resolvedSchema = schema || await this.schema(ctx);

    if (!resolvedSchema) {
      throw new Error(`Not able to build a schema to parse arguments for ${this.input.name}`);
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
    const strict = this.input.strict ?? true;

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
  async metadata<
    TRuntimeContext extends TContext,
    TRuntimeMetadata extends TMetadata,
    TCoreContext extends Context<TRuntimeContext, TRuntimeMetadata>,
  >(...[inputMaybe, contextMaybe]: OptionalParams<[TParams, TCoreContext]>): Promise<TMetadata> {
    const input = (inputMaybe || {}) as TParams;
    const ctx = (contextMaybe || {}) as Context<TContext, TMetadata>;

    return {
      ...(this.input.metadata || {} as TMetadata),
      ...(await this.metadataFn(input, ctx) || {}),
    } as TMetadata;
  }

}