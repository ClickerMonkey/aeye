/**
 * The @aeye/core API change, as proposed. IMPLEMENTED in @aeye/core (step 1 of the
 * integration): see packages/core/src/{schema,tool,prompt}.ts. Kept as the type-level
 * sketch the corpus files port against.
 *
 * Today:
 *   Tool.schema:   Fn<ZodType<TParams> | undefined, [ctx]>          // a schema OR a function returning one (rebuilt per call)
 *   Prompt.schema: Fn<ZodType<TOutput> | false, [input, ctx]>
 *   + strictify(schema, descriptor) / decodeWire / custom `parse` hooks at the edges.
 *
 * Proposed:
 *   Tool.schema:   Bindable<TParams, [ctx]>                // ALWAYS one static `a` instance (module scope)
 *   Prompt.schema: Bindable<TOutput, [ctx, input]>         // ... whose dynamic part is bound at call time
 *
 * A plain `a.object(...)` is a Bindable with no args. A chain with a
 * `.dynamic((ctx) => ...)` step is a Bindable whose args are the ctx; the
 * type system checks the tool's ctx supplies what the dynamic step needs.
 * The function form goes away; what it did moves to:
 *   - "schema depends on ctx"        → the chain's dynamic step (cached by `key`),
 *   - "tool unavailable (undefined)" → `applicable(ctx)`,
 *   - "custom parse hook"            → `a.codec` / `.refine` on the schema itself,
 *   - strictify / decodeWire         → `bound.render(profile)` (JSON schema + codec).
 *
 * Errors for the model: a tool / prompt says how a bad answer is told to the
 * model (`errorFormat`: detail level, size cap, suggestions, expected types).
 * It travels into the request as `ToolItem.errorFormat` / `OutputItem.errorFormat`,
 * and a single call can override it (`ParseOptions.errorFormat`), e.g. a retry
 * loop asking for `'summary'` after the first full message didn't help.
 * The precedence is request (`RequestOptions.errorFormat`, e.g. a model that
 * does better with less) < definition < call.
 */
import type { Bindable, Bound } from '../module';
import type { ParseOptions, ParseResult, Rendered } from '../render';
import type { Profile } from '../profile';
import type { ErrorFormatInput } from '../feedback';
import { mergeErrorFormats } from '../feedback';

/** Stand-in for core's Context<TContext, TMetadata>. */
export type Context<TContext = {}> = TContext & { readonly signal?: AbortSignal };

export interface ToolInputV2<TContext, TName extends string, TParams, TOutput> {
  name: TName;
  description: string;
  instructions?: string;
  /** The parameter schema: static, or static with dynamic parts bound from ctx. */
  schema: Bindable<TParams, [ctx: Context<TContext>]>;
  /** Was: the schema function returning `undefined`. */
  applicable?: (ctx: Context<TContext>) => boolean | Promise<boolean>;
  /** Strict policy and delivery stay as they are today. */
  strict?: boolean | number;
  schemaDelivery?: 'auto' | 'structured' | 'prompt';
  /**
   * How a call with bad arguments is told to the model. A detail level
   * (`'summary'` · `'list'` · `'markers'` · `'full'`, the default) or the full
   * options (`{ detail, maxErrors, maxChars, suggestions, expected, context, depth }`).
   */
  errorFormat?: ErrorFormatInput;
  /** Receives the DECODED code-shape value (records are records, absent is absent). */
  call: (input: TParams, ctx: Context<TContext>) => TOutput | Promise<TOutput>;
}

export interface PromptInputV2<TContext, TName extends string, TInput, TOutput> {
  name: TName;
  content: string;
  /** Output schema: static, or with dynamic parts bound from (ctx, input). Absent = text; `a.string()` = the text, checked. */
  schema?: Bindable<TOutput, [ctx: Context<TContext>, input: TInput]>;
  /** Was: the schema function returning `false`. */
  applicable?: (ctx: Context<TContext>) => boolean | Promise<boolean>;
  /** How an answer that doesn't fit `schema` is told to the model (as on a tool). */
  errorFormat?: ErrorFormatInput;
}

/** Type-only constructors (the real ones are core's `Tool`/`Prompt` classes). */
export function tool<TContext, TName extends string, TParams, TOutput>(
  input: ToolInputV2<TContext, TName, TParams, TOutput>,
): ToolInputV2<TContext, TName, TParams, TOutput> {
  return input;
}

export function prompt<TContext, TName extends string, TInput, TOutput>(
  input: PromptInputV2<TContext, TName, TInput, TOutput>,
): PromptInputV2<TContext, TName, TInput, TOutput> {
  return input;
}

/**
 * What one request does with a tool (replaces `Tool.compile` + `Tool.parse`'s
 * strictify/decodeWire): bind once per request, render for the chosen
 * model's profile (memoized), and keep the SAME rendering to parse the
 * answer, so wire shape, errors and decoding can't drift apart.
 */
export interface CompiledTool<TParams> {
  readonly bound: Bound<TParams>;
  readonly rendered: Rendered<TParams>;
  /** Goes on the wire as the tool's `parameters`. */
  readonly parameters: Record<string, unknown>;
  /**
   * Parses the model's raw arguments. On failure `message` is what the model
   * is re-prompted with, in the tool's `errorFormat` (a call's own options win).
   */
  parse(rawArgs: string, opts?: Pick<ParseOptions, 'errorFormat' | 'repair'>): ParseResult<TParams>;
}

export function compileTool<TContext, TParams>(
  t: ToolInputV2<TContext, string, TParams, unknown>,
  ctx: Context<TContext>,
  profile: Profile,
): CompiledTool<TParams> {
  const bound = t.schema.bind(ctx);
  const rendered = bound.render(profile);
  const label = `the arguments of ${t.name}`;
  return {
    bound,
    rendered,
    parameters: rendered.jsonSchema,
    parse: (rawArgs, opts) => rendered.parseText(rawArgs, { ...opts, errorFormat: mergeErrorFormats(t.errorFormat, opts?.errorFormat), label }),
  };
}

/** End to end: compile, (model answers), parse, call. */
export async function runToolCall<TContext, TParams, TOutput>(
  t: ToolInputV2<TContext, string, TParams, TOutput>,
  ctx: Context<TContext>,
  profile: Profile,
  modelAnswer: (parameters: Record<string, unknown>) => string,
): Promise<{ ok: true; output: TOutput } | { ok: false; reprompt: string }> {
  const compiled = compileTool(t, ctx, profile);
  const parsed = compiled.parse(modelAnswer(compiled.parameters));
  if (!parsed.ok) return { ok: false, reprompt: `Fix these arguments:\n${parsed.message}` };
  return { ok: true, output: await t.call(parsed.value, ctx) };
}
