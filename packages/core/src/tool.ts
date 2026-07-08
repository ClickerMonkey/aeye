import Handlebars from 'handlebars';
import { ZodType } from 'zod';
import { Fn, resolveFn } from './common';
import { FormatDescriptor, getDescriptorById, strictify, decodeWire } from './schema';
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
  TDecoded extends unknown = TParams,
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
  /** The function that implements the tool's behavior. Receives the DECODED
   * input: when a custom `parse` is supplied its RETURN type drives `TDecoded`
   * (e.g. a built class instance); otherwise `TDecoded` defaults to the wire
   * `TParams` (the Zod-inferred shape). */
  call: (input: TDecoded, refs: TRefs, ctx: Context<TContext, TMetadata>) => TOutput;
  /**
   * Optional custom parser that REPLACES Zod validation entirely.
   *
   * By default `Tool.parse` runs `JSON.parse` → Zod schema → `validate`.
   * When `parse` is supplied it takes Zod's place: the pipeline becomes
   * `JSON.parse` → `parse` → `validate`, and the Zod schema (plus its
   * string-encoded-field repair fallback) is SKIPPED.
   *
   * The function receives the raw `JSON.parse`-d value and fully owns
   * turning it into the typed `TParams`. It returns EITHER:
   * - the typed value `TParams` on success, or
   * - an `Error` to signal validation failure (equivalently, it may
   *   `throw` that error) — parsing short-circuits and the error flows
   *   through the normal parse error channel.
   *
   * This lets a caller (e.g. `@aeye/query`'s expr/query parser, which
   * already produces a typed AST plus `Problems`/`Code` diagnostics)
   * return concise, compiler-style errors with source underlines
   * INSTEAD of Zod's harder-to-follow messages. The returned/thrown
   * `Error` can be a rich subclass carrying structured diagnostics
   * (its `message` is what the model-facing error channel surfaces).
   *
   * Absent ⇒ unchanged behavior (Zod path). The `schema` field is still
   * required and continues to be used for `compile()` / model wire format.
   */
  parse?: (raw: unknown, ctx: Context<TContext, TMetadata>) => TDecoded | Error | Promise<TDecoded | Error>;
  /** Optional post-validation hook that runs after parsing succeeds (Zod or custom `parse`). Receives the DECODED value (`TDecoded`). Can throw to trigger re-prompting. */
  validate?: (input: TDecoded, ctx: Context<TContext, TMetadata>) => void | Promise<void>;
  /**
   * Optional hard cap on the raw arguments STRING length. When set,
   * `Tool.parse` rejects the call BEFORE attempting `JSON.parse` if
   * `rawArgs.length > maxArgsLength`. Useful against provider wire
   * dialects that corrupt large structured tool args (Claude Sonnet
   * 4.5 over OpenRouter has been observed double-encoding the field
   * AND mangling its inner JSON when args exceed ~5KB) — a pre-parse
   * rejection with a clear "split this into smaller fns" message
   * makes the model decompose instead of looping on the same broken
   * payload. Unset = no cap.
   */
  maxArgsLength?: number;
  /** Optional function to determine if the component is applicable in the given context */
  applicable?: <
    TRuntimeContext extends TContext, 
    TRuntimeMetadata extends TMetadata
  >(ctx: Context<TRuntimeContext, TRuntimeMetadata>) => boolean | Promise<boolean>;
  /** Metadata about the tool to be passed during execution/streaming. Typically contains requirements, configuration, etc. */
  metadata?: TMetadata;
  /** A function/promise that returns metadata about the tool to be passed during execution/streaming. */
  metadataFn?: (input: TDecoded, ctx: Context<TContext, TMetadata>) => TMetadata | Promise<TMetadata>;
  /** Optional way to explicitly declare the types used in this component */
  types?: {
    params?: TParams;
    decoded?: TDecoded;
    output?: TOutput;
    context?: TContext;
    metadata?: TMetadata;
  },
}

/**
 * A type representing any tool.
 */
export type AnyTool = Tool<any, any, any, any, any, any, any>;

/**
 * A type representing a tool compatible with the given context and metadata.
 */
export type ToolCompatible<TContext, TMetadata> = Tool<TContext, TMetadata, any, any, any, any, any>;

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
  TDecoded extends unknown = TParams,
> implements Component<TContext, TMetadata, TName, TDecoded, TOutput, TRefs> {

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
    public input: ToolInput<TContext, TMetadata, TName, TParams, TOutput, TRefs, TDecoded>,
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
   * Tolerates one specific model misbehavior: a tool-call payload whose
   * top-level fields are JSON-stringified instead of nested as objects
   * (`{program: "{\"kind\":...}"}` instead of `{program: {kind:...}}`).
   * Claude Sonnet 4.x has been observed doing this when its structured
   * tool args grow large. When the strict schema rejects, we try one
   * fallback pass: JSON.parse any top-level string field whose value
   * starts with `{` or `[`, then revalidate. If that succeeds, fire
   * `onRepair` with the field names so the caller can emit telemetry
   * (we want visibility, not silent absorption).
   *
   * @param ctx - The context for parsing.
   * @param args - The input arguments as a JSON string.
   * @param schema - Optional pre-compiled schema to use instead of resolving it again.
   * @param descriptor - Provider wire-dialect descriptor for strictify.
   * @param onRepairAttempt - Optional callback fired whenever the
   *   fallback found at least one string-encoded top-level field worth
   *   trying. Fires on BOTH outcomes — `success: true` when the
   *   repaired value validated, `success: false` when even the
   *   repaired value failed the schema. The callback is the caller's
   *   telemetry hook; we want repair attempts visible regardless of
   *   outcome so silent absorption of model misbehavior never happens.
   * @returns The parsed and validated input parameters.
   * @throws Error if schema is not available or parsing/validation fails.
   */
  async parse(
    ctx: Context<TContext, TMetadata>,
    args: string,
    schema?: ZodType<TParams>,
    descriptor?: FormatDescriptor | string,
    onRepairAttempt?: (info: { fields: ReadonlyArray<string>; success: boolean }) => void,
  ): Promise<TDecoded> {
    // Hard cap on raw args length, applied BEFORE JSON.parse. Some
    // provider wire dialects (Claude Sonnet 4.5 via OpenRouter,
    // observed) double-encode large tool args AND corrupt the inner
    // content. Rather than burn iterations on unrecoverable parses,
    // reject early and tell the model how to fix it. Unset = no cap.
    const cap = this.input.maxArgsLength;
    if (cap !== undefined && args.length > cap) {
      throw new Error(
        `Tool arguments exceeded the configured size limit (${args.length} chars > ${cap}). ` +
        `Do NOT retry this same call — sending an even slightly trimmed version of the same program will hit the cap again. ` +
        `The program is too large to be a single function body. ` +
        `Pick the most self-contained piece of logic and factor it out via \`find_or_create_functions\` ` +
        `(name + description + signature), then re-author the calling body referring to that helper by bare name — ` +
        `e.g. \`helperFnName({args})\`. Each helper call costs ONE step in the body, regardless of the helper's internal size. ` +
        `Repeat until the body fits.`,
      );
    }

    let resolvedSchema = schema || await this.schema(ctx);

    if (!resolvedSchema) {
      throw new Error(`Not able to build a schema to parse arguments for ${this.input.name}`);
    }

    // The PRE-strictify conceptual schema — passed to `decodeWire` below,
    // which strictifies internally. Using the already-strictified
    // `resolvedSchema` would double-wrap the wire transforms.
    const baseSchema = resolvedSchema;

    // Apply the strictify rewrite that matches the provider's chosen wire
    // dialect. The cache makes repeated calls O(1).
    let fd: FormatDescriptor | undefined;
    if (descriptor) {
      fd = typeof descriptor === 'string' ? getDescriptorById(descriptor) : descriptor;
      resolvedSchema = strictify(resolvedSchema, fd);
    }

    const raw = JSON.parse(args);

    // Custom parser REPLACES Zod entirely. When supplied, the pipeline is
    // JSON.parse → decodeWire → parse → validate; Zod's own validation (and
    // its string-encoded-field repair fallback) is skipped. `decodeWire`
    // DECODEs the model's wire shape back to the CONCEPTUAL value (symmetric
    // with strictify's encode) so the custom parser stays provider-agnostic —
    // it never sees array-of-pairs records, numeric-key tuples, or
    // null-for-optional. The parser returns the DECODED value (`TDecoded`,
    // inferred from `parse`'s return type — e.g. a built class instance) on
    // success or an Error (or throws one) to short-circuit with a rich,
    // caller-supplied diagnostic (e.g. @aeye/query's Problems/Code output)
    // instead of Zod's harder-to-follow message. Absent ⇒ unchanged and the
    // Zod-inferred wire value flows through as the decoded value.
    if (this.input.parse) {
      // Decode only when a descriptor is present; otherwise the wire shape IS
      // the conceptual shape and `raw` passes through untouched.
      const decoded = fd ? decodeWire(baseSchema, raw, fd) : raw;
      const result = await this.input.parse(decoded, ctx);
      if (result instanceof Error) {
        throw result;
      }
      // Post-validation hook runs on the decoded value.
      if (this.input.validate) {
        await this.input.validate(result, ctx);
      }
      return result;
    }

    // No custom parser: Zod validates the wire shape. With no `parse`,
    // `TDecoded` defaults to (and equals) the wire `TParams`, so the
    // Zod-validated wire value IS the decoded value.
    let parsed: TParams;
    try {
      parsed = await resolvedSchema.parseAsync(raw);
    } catch (e) {
      const repair = repairStringEncodedFields(raw);
      if (repair) {
        if (repair.fields.length === 0) {
          // Fields LOOKED string-encoded but the inner JSON itself was
          // malformed (Claude Sonnet 4.5 has been observed double-
          // encoding large tool args AND corrupting the inner content
          // mid-stream — mismatched brackets, truncation). The zod
          // error doesn't say WHY the model's input is broken; replace
          // it with a targeted, actionable cue so the next iteration
          // sends the field as a real JSON object instead of a string.
          onRepairAttempt?.({ fields: repair.attempted, success: false });
          throw new Error(
            `Field${repair.attempted.length > 1 ? 's' : ''} ${repair.attempted.map((f) => `\`${f}\``).join(', ')} ` +
            `arrived as a JSON-encoded string with malformed inner JSON (likely truncated or unbalanced brackets). ` +
            `Send ${repair.attempted.length > 1 ? 'these fields' : 'this field'} as a JSON object directly — ` +
            `do NOT wrap the value in quotes or escape its contents. ` +
            `If the program is large, break it into smaller helper functions first.`,
          );
        }
        try {
          parsed = await resolvedSchema.parseAsync(repair.value);
          onRepairAttempt?.({ fields: repair.fields, success: true });
        } catch {
          // Repair candidate didn't actually fix things — surface the
          // ORIGINAL error so the model sees its real mistake.
          // Telemetry still fires so callers know repair was tried.
          onRepairAttempt?.({ fields: repair.fields, success: false });
          throw e;
        }
      } else {
        throw e;
      }
    }

    // With no custom `parse`, `TDecoded === TParams`, so the wire value is
    // the decoded value; `decoded` re-binds it to the `TDecoded` view.
    const decoded: TDecoded = parsed as TParams & TDecoded;

    // Run post-validation hook if provided (on the decoded value).
    if (this.input.validate) {
      await this.input.validate(decoded, ctx);
    }

    return decoded;
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
  >(...[inputMaybe, contextMaybe]: OptionalParams<[TDecoded, TCoreContext]>): TOutput {
    const input = (inputMaybe || {}) as TDecoded;
    const ctx = (contextMaybe || {}) as Context<TContext, TMetadata>;
    const tool = this as Component<TContext, TMetadata, TName, TDecoded, TOutput, TRefs>;

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
  >(input?: TDecoded, ctx?: TCoreContext): Promise<TMetadata>;
  metadata<
    TRuntimeContext extends TContext,
    TRuntimeMetadata extends TMetadata,
    TCoreContext extends Context<TRuntimeContext, TRuntimeMetadata>,
  >(input?: TDecoded, ctx?: TCoreContext): TMetadata | Promise<TMetadata> {
    // If both input and context are not specified, just return static metadata
    if (input === undefined && ctx === undefined) {
      return (this.input.metadata || {}) as TMetadata;
    }

    const actualInput = (input || {}) as TDecoded;
    const actualCtx = (ctx || {}) as Context<TContext, TMetadata>;

    return this.metadataFn(actualInput, actualCtx).then(dynamicMetadata => ({
      ...(this.input.metadata || {} as TMetadata),
      ...(dynamicMetadata || {}),
    } as TMetadata));
  }

}

/**
 * Best-effort recovery for one specific model misbehavior: a tool-call
 * args object whose TOP-LEVEL field values are JSON-encoded strings
 * instead of nested objects/arrays. Walks the immediate fields of `raw`
 * and, for each string-valued field that starts with `{` or `[` (after
 * trimming leading whitespace), tries `JSON.parse`. On success the
 * field is swapped for the parsed value. Returns the repaired clone +
 * the list of swapped field names when at least one swap happened;
 * `undefined` when nothing looked recoverable (caller should re-throw
 * the original error in that case).
 *
 * Intentionally top-level only — descending deeper risks "repairing"
 * legitimate JSON-shaped strings inside content fields. The fields we
 * see this on (Claude / Anthropic tool args) are always at the top
 * level of the args object.
 */
function repairStringEncodedFields(
  raw: unknown,
):
  | { value: Record<string, unknown>; fields: string[]; attempted: string[] }
  | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const src = raw as Record<string, unknown>;
  const repaired: Record<string, unknown> = { ...src };
  const fields: string[] = [];
  const attempted: string[] = [];
  for (const [key, value] of Object.entries(src)) {
    if (typeof value !== 'string') continue;
    const head = value.trimStart()[0];
    if (head !== '{' && head !== '[') continue;
    // Field LOOKS string-encoded — track it whether parse succeeds or
    // not. Failed inner-parse is its own diagnostic signal (model
    // double-encoded AND the inner content is malformed), distinct
    // from "no encoded fields seen at all".
    attempted.push(key);
    try {
      repaired[key] = JSON.parse(value);
      fields.push(key);
    } catch { /* malformed inner JSON — keep tracking the attempt */ }
  }
  if (attempted.length === 0) return undefined;
  return { value: repaired, fields, attempted };
}