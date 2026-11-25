import Handlebars from 'handlebars';
import { SchemaParseError, type DecodedCall, type Encoder, type ErrorFormatInput, type RequestEntry } from '@aeye/schema';
import { NO_CLAIMS, ToolClaims } from './claims';
import { Fn, resolveFn } from './common';
import { planRequest, renderTemplate, schemaSource, trackedEncoder, type RequestPlan, type TemplateTrack, type ToolSchema } from './schema';
import { finishZod } from './zod-bridge';
import { Component, ComponentCompatible, Context, OptionalParams, Request, SchemaDelivery, ToolChoice, ToolDefinition, ToolTextFormat, Tuple } from './types';
    
/**
 * A tool's description for providers that send a free-text tool as an
 * ordinary one-field function: a grammar its input must match is appended,
 * since the function can't carry the grammar itself.
 */
export function describeTool(tool: ToolDefinition): string | undefined {
  return tool.format?.type === 'grammar'
    ? `${tool.description ?? ''}\n\nThe input must match this ${tool.format.syntax} grammar:\n${tool.format.definition}`
    : tool.description;
}

/**
 * Whether a tool choice makes the model call a tool.
 */
export function forcesTool(choice: ToolChoice | undefined): boolean {
  return choice === 'required' || (typeof choice === 'object' && ('tool' in choice || !!choice.required));
}

/**
 * The request with only its allowed tools, for providers that can't limit
 * the tools a model may call while sending them all. The tools keep their
 * identity, so plans pinned on them still reach the Prompt.
 */
export function withAllowedTools(request: Request): Request {
  const choice = request.toolChoice;
  if (typeof choice !== 'object' || !('allowed' in choice)) {
    return request;
  }
  return {
    ...request,
    tools: request.tools?.filter(tool => choice.allowed.includes(tool.name)),
    toolChoice: choice.required ? 'required' : 'auto',
  };
}

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
  /**
   * Optional function that returns the tool's instructions (a Handlebars
   * template) based on the context. `encode` writes a value of the tool's
   * arguments the way this model writes them (records as pairs on OpenAI
   * strict, absent optionals as `null`, …): `encode({ query: 'x' })`.
   */
  instructionsFn?: Fn<string, [Context<TContext, TMetadata>, Encoder<TParams>]>;
  /**
   * Optional function that returns variables for the instructions Handlebars
   * template; `encode` as in `instructionsFn`. The template can also write
   * `{{encode value}}` (the value in the model's shape of these arguments)
   * and `{{schema}}` (the arguments as TypeScript).
   */
  input?: Fn<Record<string, any>, [Context<TContext, TMetadata>, Encoder<TParams>]>;
  /**
   * The tool's arguments: one static `a` schema, or a bundle whose dynamic
   * step takes the ctx (`a.define(...).dynamic((ctx) => ...).result(...)`),
   * bound per call. `TParams` is inferred from it.
   *
   * (A zod schema, or a function returning one, is still accepted as a
   * temporary bridge for @aeye/gin and @aeye/query. TODO(step 2): remove.)
   */
  schema: ToolSchema<TParams, Context<TContext, TMetadata>>;
  /**
   * How a call with bad arguments is told to the model: a detail level
   * (`'summary'` · `'list'` · `'markers'` · `'full'`, the default) or the
   * full options (`{ detail, maxErrors, maxChars, suggestions, expected,
   * context, depth }`). The model's own JSON comes back with markers under
   * the mistakes and "did you mean" for misspelt names, within
   * `maxChars` (2000). Wins over `ctx.errorFormat`; a single parse can
   * override it.
   */
  errorFormat?: ErrorFormatInput;
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
   *   toward strict-capable models (optional capability). When the request
   *   is planned for the model (`prepareRequest`) the most wanted tools take
   *   the strict slots first; tools that don't fit go non-strict (still
   *   validated), and past the provider's tool cap the least wanted go
   *   behind one dispatcher tool. Nothing errors.
   *
   * Note: the legacy default of `true` was changed to `1` in v2 to keep
   * "it just works" against unknown/unannotated models. Set `strict: true`
   * explicitly when strict is non-negotiable.
   */
  strict?: boolean | number;
  /**
   * Schema-delivery policy for this tool's parameter schema. Tri-state,
   * default `'auto'`. Mirrors `PromptInput.schemaDelivery` / `SchemaDelivery`:
   * `'auto'` sends the schema as structured output when the selected model's
   * dialect can express it and otherwise falls back to prompt text;
   * `'structured'` always sends it structured; `'prompt'` always delivers it
   * as prompt text.
   */
  schemaDelivery?: SchemaDelivery;
  /** References to other components (tools, prompts, agents) that this tool utilizes */
  refs?: TRefs;
  /** The function that implements the tool's behavior. Receives the DECODED
   * input in the code shape (records are records, absent is absent, whatever
   * the model wrote): `TParams`, or the RETURN type of a custom `parse`. */
  call: (input: TDecoded, refs: TRefs, ctx: Context<TContext, TMetadata>) => TOutput;
  /**
   * @deprecated Code-shape mapping belongs on the schema (`a.codec`,
   * `.refine`). Kept for @aeye/query's `buildQueryTool` during the bridge.
   * TODO(step 2): remove.
   *
   * A custom parser that owns turning the decoded arguments into `TDecoded`.
   * The arguments are decoded from the model's wire shape first; when they
   * don't fit the schema the parser gets them as the model sent them and
   * its `Error` (returned or thrown) is what the model is told.
   */
  parse?: (raw: unknown, ctx: Context<TContext, TMetadata>) => TDecoded | Error | Promise<TDecoded | Error>;
  /** Optional post-validation hook that runs after decoding succeeds. Receives the DECODED value (`TDecoded`). Can throw to trigger re-prompting. */
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
  /** Takes free text as `input` instead of JSON; see `ToolDefinition.format` */
  format?: ToolTextFormat;
  /** Loaded only when the model searches for it; see `ToolDefinition.defer` */
  defer?: boolean;
  /** The model keeps working while the tool runs; see `ToolDefinition.async` */
  async?: boolean;
  /**
   * What a call of this tool operates on, so a parallel batch never runs two
   * calls that touch the same thing at the same time.
   *
   * When a prompt runs tool calls in parallel (`toolExecution: 'parallel'` or
   * `'immediate'`), a call whose claims conflict with an EARLIER call in the
   * same batch (in the order the model made them) waits until that call has
   * finished, however it finished, and then runs. Calls whose claims don't
   * conflict still run together, so parallel calling stays fast where it is
   * safe and turns sequential only where the calls overlap.
   *
   * Claims are plain strings compared by exact equality; two calls conflict
   * when they share one. The claim `'*'` (`ALL_CLAIMS`) conflicts with every
   * other call, claims or not: the call runs alone. A call with no claims
   * (the default) conflicts with nothing but a `'*'`. See `claimsConflict`.
   *
   * Either a static list, or a function of the parsed input and the context
   * the call itself gets (with `toolCallId`), run after the arguments parse
   * and before the call starts. Returning `undefined` claims nothing. A
   * function that throws fails this call with a `ToolExecutionError`, just
   * like a throw from `call`; the other calls are unaffected.
   *
   * `toolExecution: 'sequential'` already runs one call at a time, so claims
   * change nothing there.
   *
   * @example
   * // Edits to one file run one after another; edits to different files run together.
   * parallelClaims: (input) => [`file:${input.path}`],
   *
   * @example
   * // A migration that must never overlap any other tool call.
   * parallelClaims: ['*'],
   */
  parallelClaims?: Fn<ToolClaims | undefined, [TDecoded, Context<TContext, TMetadata>]>;
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
 *   schema: a.object({ location: a.string() }),
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
   * Compiles an instructions template. A template is applied with Handlebars
   * when it has input variables or uses the schema helpers (`{{encode}}`,
   * `{{schema}}`); otherwise it's the text as written.
   *
   * @param instructions - The instructions template string.
   * @param hasInput - Whether the tool has input variables.
   * @returns A template function.
   */
  static compileInstructions(instructions: string, hasInput: boolean): (vars: Record<string, unknown>, options?: { data?: Record<string, unknown> }) => string {
    return hasInput || /\{\{\{?\s*(encode|schema)\b/.test(instructions)
      ? Handlebars.compile(instructions, { noEscape: true })
      : () => instructions;
  }

  /**
   * Creates a new Tool instance.
   *
   * @param input - The tool input configuration.
   */
  constructor(
    public input: ToolInput<TContext, TMetadata, TName, TParams, TOutput, TRefs, TDecoded>,
    private instructions = input.instructions ? Tool.compileInstructions(input.instructions, !!input.input) : undefined,
    // The schema stays one static instance; its dynamic part is bound per
    // call, and the request plans its rendering once the model is known.
    private source = schemaSource<TParams, [Context<TContext, TMetadata>]>(input.schema),
    private translate = resolveFn(input.input),
    private descriptionFn = resolveFn(input.descriptionFn),
    private instructionsFn = resolveFn(input.instructionsFn),
    private metadataFn = resolveFn(input.metadataFn),
    private parallelClaims = resolveFn(input.parallelClaims),
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
   * The tool's argument schema bound for a call: the static schema, or the
   * bundle with its dynamic step run for `ctx` (cached by the bundle's key).
   * `undefined` only for a bridged zod function that returned nothing.
   */
  async bind(ctx: Context<TContext, TMetadata>) {
    return this.source.bind(ctx);
  }

  /**
   * The tool's definition for a request: its bound schema, description and
   * strict policy. `undefined` when the tool has no schema here (a bridged
   * zod function returned nothing); use `applicable` to hide a tool.
   */
  async definition(ctx: Context<TContext, TMetadata>): Promise<ToolDefinition | undefined> {
    const parameters = await this.source.bind(ctx);
    if (!parameters) {
      return undefined;
    }
    // Default to numeric priority 1 (best-effort preference) instead of
    // boolean true. See ToolInput.strict JSDoc for the tri-state semantics.
    return {
      name: this.input.name,
      description: await this.descriptionFn(ctx) || this.input.description,
      parameters,
      strict: this.input.strict ?? 1,
      ...(this.input.errorFormat !== undefined ? { errorFormat: this.input.errorFormat } : {}),
      format: this.input.format,
      defer: this.input.defer,
      async: this.input.async,
    };
  }

  /**
   * The tool's instructions for a request plan: the template (static, or
   * from `instructionsFn`) applied to its input variables, with
   * `{{encode value}}` writing values the way the plan's model writes this
   * tool's arguments. `''` without instructions.
   *
   * @param ctx - The context.
   * @param plan - The request's plan (`requestPlan`).
   * @param track - Notes whether the text used the schema (and so depends on the model).
   */
  async instructionsFor(ctx: Context<TContext, TMetadata>, plan: RequestPlan, track?: TemplateTrack): Promise<string> {
    const encode = trackedEncoder<TParams>(plan, this.input.name, undefined, track);
    const template = this.input.instructionsFn
      ? Tool.compileInstructions(await this.instructionsFn(ctx, encode) ?? '', !!this.input.input)
      : this.instructions;
    if (!template) {
      return '';
    }
    const vars = this.input.input ? (await this.translate(ctx, encode)) || {} : {};
    return renderTemplate(template, vars, plan, this.input.name, track);
  }

  /**
   * The value-only encoder of the tool's arguments: `encode(value)` is the
   * value as JSON text in the shape the plan's model writes it (the code
   * shape without a plan).
   */
  async encoder(ctx: Context<TContext, TMetadata>, plan?: RequestPlan): Promise<Encoder<TParams>> {
    const bound = await this.source.bind(ctx);
    return trackedEncoder<TParams>(plan ?? planRequest({}), this.input.name, bound);
  }

  /**
   * Decodes and validates a call's arguments through the request plan they
   * were sent with, then runs the tool's `validate` hook.
   *
   * The arguments are decoded from the shape the model was given (pairs
   * back to records, `null` back to absent, JSON text parsed, a container
   * sent as a JSON string repaired) into the code shape, in place. A call
   * through the dispatcher (`callName` is the dispatcher's) is decoded back
   * to this tool. When they don't fit, a `SchemaParseError` is thrown whose
   * `message` is what the model is told, in the tool's `errorFormat`.
   *
   * @param ctx - The context for parsing.
   * @param args - The input arguments as a JSON string.
   * @param plan - The request's plan; without one the tool's own schema is used, in the code shape.
   * @param onRepairAttempt - Fired when top-level fields arrived as JSON strings: `success` says whether the call then decoded.
   * @param call - The name the model called (the dispatcher's, for a dispatched call) and a per-call error format.
   * @returns The decoded arguments.
   * @throws SchemaParseError when the arguments don't fit; Error for invalid JSON or a size cap.
   */
  async parse(
    ctx: Context<TContext, TMetadata>,
    args: string,
    plan?: RequestPlan,
    onRepairAttempt?: (info: { fields: ReadonlyArray<string>; success: boolean }) => void,
    call: { name?: string; errorFormat?: ErrorFormatInput } = {},
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

    let target = plan;
    if (!target) {
      const definition = await this.definition(ctx);
      if (!definition) {
        throw new Error(`Not able to build a schema to parse arguments for ${this.input.name}`);
      }
      target = planRequest({ tools: [definition] });
    }

    const raw: unknown = JSON.parse(args);
    const name = call.name ?? this.input.name;
    const dispatched = !!target.dispatcher && name === target.dispatcher.name;
    const argsOf = (wire: unknown) => dispatched && wire && typeof wire === 'object' ? (wire as { args?: unknown }).args : wire;
    // Top-level fields sent as JSON strings: the decoder repairs them; the
    // caller hears about it either way (visibility, not silent absorption).
    const encoded = jsonStringFields(argsOf(raw));
    const opts = call.errorFormat !== undefined ? { errorFormat: call.errorFormat } : undefined;
    let decoded: DecodedCall;
    let repaired = 0;
    const own = !dispatched && target.has(name) ? target.get(name as never) as unknown as RequestEntry<unknown> : undefined;
    if (own && own.delivery !== 'dispatched' && this.source.bridged && own.profile.family === 'lenient' && own.rendered.wrapped === false) {
      // A bridged zod schema sent in the code shape: nothing to decode, and zod
      // (or the custom parser) validates below — as before the bridge, without
      // trying every option of a huge union twice (TODO(step 2)).
      decoded = { ok: true, tool: own.requestedName, value: raw };
    } else if (own && own.delivery !== 'dispatched') {
      const res = own.parse(raw, opts);
      repaired = res.stats.repaired;
      decoded = res.ok
        ? { ok: true, tool: own.requestedName, value: res.value }
        : { ok: false, tool: own.requestedName, issues: res.issues, message: res.message };
    } else {
      decoded = target.decodeCall(name, raw, opts);
      repaired = encoded.length;
    }
    if (encoded.length) {
      const now = argsOf(raw) as Record<string, unknown> | undefined;
      const fixed = encoded.filter(key => typeof now?.[key] !== 'string');
      if (!decoded.ok) {
        onRepairAttempt?.({ fields: encoded, success: false });
      } else if (repaired > 0 && fixed.length) {
        onRepairAttempt?.({ fields: fixed, success: true });
      }
    }
    const entry = target.has(decoded.tool ?? name) ? target.get((decoded.tool ?? name) as never) as unknown as RequestEntry<unknown> : undefined;

    // A custom parser (bridge) owns the arguments: decoded when they fit,
    // as sent when they don't, so its own diagnostics speak.
    if (this.input.parse) {
      const value = decoded.ok ? decoded.value : argsOf(raw);
      const result = await this.input.parse(value, ctx);
      if (result instanceof Error) {
        throw result;
      }
      if (this.input.validate) {
        await this.input.validate(result, ctx);
      }
      return result;
    }

    if (!decoded.ok) {
      throw new SchemaParseError(decoded.issues, decoded.message);
    }

    let value: unknown = decoded.value;
    if (this.source.bridged && entry) {
      // A bridged zod schema parses the decoded value too (TODO(step 2)).
      const finished = await finishZod(entry.boundSchema, value, argsOf(raw), call.errorFormat ?? entry.errorFormat, entry.label);
      if (!finished.ok) {
        throw new SchemaParseError([], finished.message);
      }
      value = finished.value;
    }

    // With no custom `parse`, `TDecoded` is `TParams`.
    const result = value as TDecoded;
    if (this.input.validate) {
      await this.input.validate(result, ctx);
    }
    return result;
  }

  /**
   * Compiles the tool on its own (outside a prompt): its instructions,
   * rendered in the code shape, and its definition. A tool with no
   * instructions still compiles: its instructions are `''`. Only a tool
   * whose (bridged zod) schema function returns nothing is left out; use
   * `applicable` to hide a tool.
   *
   * @param ctx - The context for compilation.
   * @returns A tuple of [instructions, toolDefinition], or undefined when the tool has no schema.
   */
  async compile(ctx: Context<TContext, TMetadata>): Promise<readonly [string, ToolDefinition] | undefined> {
    const definition = await this.definition(ctx);
    if (!definition) {
      return undefined;
    }
    const plan = planRequest({ tools: [{ ...definition }] });
    return [await this.instructionsFor(ctx, plan), definition] as const;
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
   * By default, checks if any referenced components are applicable.
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
    // A bridged zod function returning nothing means "not here" (TODO(step 2)).
    if (this.source.bridged && await this.source.bind(ctx) === undefined) {
      return false;
    }

    // If there are no refs, the tool is self-contained and applicable
    if (this.refs.length === 0) {
      return true;
    }

    return await Promise.all(this.refs.map(ref => ref.applicable(ctx))).then(results => results.some(r => r));
  }

  /**
   * Whether this tool declares `parallelClaims`. One that doesn't claims
   * nothing for every call, so a scheduler needn't ask for its claims.
   */
  get hasParallelClaims(): boolean {
    return this.input.parallelClaims !== undefined;
  }

  /**
   * The claims of one call of this tool (see `ToolInput.parallelClaims`): the
   * static list, or what the claims function returns for the parsed input and
   * the call's context. Claims nothing when the tool declares none.
   *
   * @param input - The call's parsed (decoded) input.
   * @param ctx - The context the call runs with.
   * @returns The call's claims.
   * @throws Whatever the claims function throws.
   */
  async claims<
    TRuntimeContext extends TContext,
    TRuntimeMetadata extends TMetadata,
    TCoreContext extends Context<TRuntimeContext, TRuntimeMetadata>,
  >(input: TDecoded, ctx: TCoreContext): Promise<ToolClaims> {
    return await this.parallelClaims(input, ctx) ?? NO_CLAIMS;
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
 * The top-level fields of a call's arguments that arrived as JSON text
 * (`{program: "{\"kind\":...}"}`): a slip Claude makes with large structured
 * args, which the decoder repairs.
 */
function jsonStringFields(raw: unknown): string[] {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value !== 'string') continue;
    const head = value.trimStart()[0];
    if (head === '{' || head === '[') out.push(key);
  }
  return out;
}
