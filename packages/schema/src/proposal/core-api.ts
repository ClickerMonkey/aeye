/**
 * PROPOSED @aeye/core API change (sketch; core integration is the next step).
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
 */
import type { Bindable, Bound } from '../module';
import type { ParseResult, Rendered } from '../render';
import type { Profile } from '../profile';

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
  /** Receives the DECODED code-shape value (records are records, absent is absent). */
  call: (input: TParams, ctx: Context<TContext>) => TOutput | Promise<TOutput>;
}

export interface PromptInputV2<TContext, TName extends string, TInput, TOutput> {
  name: TName;
  content: string;
  /** Output schema: static, or with dynamic parts bound from (ctx, input). Absent = text. */
  schema?: Bindable<TOutput, [ctx: Context<TContext>, input: TInput]>;
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
  /** Parses the model's raw arguments; `message` (wire paths) is what the model is re-prompted with. */
  parse(rawArgs: string): ParseResult<TParams>;
}

export function compileTool<TContext, TParams>(
  t: ToolInputV2<TContext, string, TParams, unknown>,
  ctx: Context<TContext>,
  profile: Profile,
): CompiledTool<TParams> {
  const bound = t.schema.bind(ctx);
  const rendered = bound.render(profile);
  return {
    bound,
    rendered,
    parameters: rendered.jsonSchema,
    parse: (rawArgs) => rendered.parseText(rawArgs),
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
